import type { Env } from "../types";
import { AutoCountClient, dateOnly } from "./autocount";
import { writeLog } from "./logger";

export interface POPullResult {
  fetched: number;
  inserted: number;
  preserved: number;
  message: string;
}

export async function runPOPull(env: Env, triggerType: "MANUAL" | "SCHEDULED"): Promise<POPullResult> {
  const rid = crypto.randomUUID();
  const startedAt = new Date();
  const client = new AutoCountClient(env, rid);

  try {
    const data = await client.getOutstandingPOs();

    // 1. Backup overdue_days keyed by doc_no + item_code
    const existing = await env.DB.prepare(
      `SELECT doc_no, item_code, overdue_days FROM purchase_orders WHERE overdue_days IS NOT NULL AND overdue_days != ''`
    ).all<{ doc_no: string; item_code: string; overdue_days: string | null }>();

    const overdueMap = new Map<string, string>();
    for (const r of existing.results || []) {
      if (r.overdue_days) overdueMap.set(`${r.doc_no}|${r.item_code}`, r.overdue_days);
    }

    // 2. Wipe & 3. Insert fresh
    await env.DB.prepare(`DELETE FROM purchase_orders`).run();

    let inserted = 0;
    let preserved = 0;

    // Batch via D1 batch API for performance
    const stmts: D1PreparedStatement[] = [];
    const insertSql = `INSERT INTO purchase_orders (
      doc_no, so_doc_no, creditor_code, creditor_name, item_code, item_description,
      location, doc_date, remaining_qty, delivery_date, supplier_date1, supplier_date2,
      supplier_date3, overdue_days
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(doc_no, item_code) DO NOTHING`;

    for (const o of data) {
      const key = `${o.DocNo}|${o.ItemCode}`;
      const restored = overdueMap.get(key) || null;
      if (restored) preserved++;
      stmts.push(
        env.DB.prepare(insertSql).bind(
          o.DocNo,
          o.SODocNo ?? null,
          o.CreditorCode ?? null,
          o.CreditorName ?? null,
          o.ItemCode,
          o.ItemDescription ?? null,
          o.Location ?? null,
          dateOnly(o.DocDate),
          o.RemainingQty ?? 0,
          dateOnly(o.DeliveryDate),
          dateOnly(o.SupplierDeliveryDate1),
          dateOnly(o.SupplierDeliveryDate2),
          dateOnly(o.SupplierDeliveryDate3),
          restored
        )
      );
      inserted++;
    }

    if (stmts.length > 0) {
      // D1 batch in chunks of 50 to be safe
      for (let i = 0; i < stmts.length; i += 50) {
        await env.DB.batch(stmts.slice(i, i + 50));
      }
    }

    const message = `Pulled ${data.length} PO lines. Restored ${preserved} overdue_days.`;
    await writeLog(env, { requestId: rid, type: `PO_PULL_${triggerType}`, startedAt, status: "SYNCED", message });
    return { fetched: data.length, inserted, preserved, message };
  } catch (err: any) {
    const message = err?.message || String(err);
    await writeLog(env, { requestId: rid, type: `PO_PULL_${triggerType}`, startedAt, status: "FAILED", message });
    throw err;
  }
}

/**
 * Push the supplier dates for a PO doc to AutoCount. The middleware updates
 * by docNo only (not per line item), so we read the dates from the first
 * row matching the docNo.
 */
export async function pushPODates(env: Env, docNo: string): Promise<{ ok: boolean; error?: string }> {
  const row = await env.DB.prepare(
    `SELECT supplier_date1, supplier_date2, supplier_date3 FROM purchase_orders WHERE doc_no = ? LIMIT 1`
  )
    .bind(docNo)
    .first<{ supplier_date1: string | null; supplier_date2: string | null; supplier_date3: string | null }>();

  if (!row) return { ok: false, error: "PO not found" };

  const client = new AutoCountClient(env);
  try {
    const res = await client.pushPODates({
      docNo,
      date1: row.supplier_date1,
      date2: row.supplier_date2,
      date3: row.supplier_date3,
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${res.body.slice(0, 500)}` };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}
