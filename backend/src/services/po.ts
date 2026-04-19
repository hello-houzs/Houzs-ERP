import type { Env } from "../types";
import { AutoCountClient, dateOnly } from "./autocount";
import { writeLog } from "./logger";

export interface POPullResult {
  fetched: number;
  inserted: number;
  preserved: number;
  message: string;
}

/**
 * Pull *outstanding* PO lines from /PurchaseOrder/getOutstanding into
 * the line-level `purchase_orders` table. The middleware uses a
 * custom SQL query that flattens header + detail and filters to
 * `Qty - TransferedQty > 0`, so every row is by definition still
 * outstanding (cancelled docs and fully-delivered docs are excluded).
 *
 * Doc-level data — including completed/cancelled POs — is pulled
 * separately by `runPODocsPull` into `purchase_order_docs`.
 */
export async function runPOPull(env: Env, triggerType: "MANUAL" | "SCHEDULED"): Promise<POPullResult> {
  const rid = crypto.randomUUID();
  const startedAt = new Date();
  const client = new AutoCountClient(env, rid);

  try {
    const data = await client.getOutstandingPOs();

    // 1. Back up per-line fields that users might have edited locally
    // (overdue_days, manual amount override) so the wipe-and-reload
    // doesn't erase their work. Keyed by doc_no + item_code.
    const existing = await env.DB.prepare(
      `SELECT doc_no, item_code, overdue_days,
              amount, amount_source, amount_updated_at, amount_updated_by,
              unit_price
         FROM purchase_orders`
    ).all<{
      doc_no: string;
      item_code: string;
      overdue_days: string | null;
      amount: number | null;
      amount_source: string | null;
      amount_updated_at: string | null;
      amount_updated_by: number | null;
      unit_price: number | null;
    }>();

    const overdueMap = new Map<string, string>();
    const manualAmountMap = new Map<
      string,
      {
        amount: number | null;
        amount_source: string | null;
        amount_updated_at: string | null;
        amount_updated_by: number | null;
        unit_price: number | null;
      }
    >();
    for (const r of existing.results || []) {
      if (r.overdue_days) overdueMap.set(`${r.doc_no}|${r.item_code}`, r.overdue_days);
      if (r.amount_source === "manual") {
        manualAmountMap.set(`${r.doc_no}|${r.item_code}`, {
          amount: r.amount,
          amount_source: r.amount_source,
          amount_updated_at: r.amount_updated_at,
          amount_updated_by: r.amount_updated_by,
          unit_price: r.unit_price,
        });
      }
    }

    await env.DB.prepare(`DELETE FROM purchase_orders`).run();

    let inserted = 0;
    let preserved = 0;

    const stmts: D1PreparedStatement[] = [];
    const insertSql = `INSERT INTO purchase_orders (
      doc_no, so_doc_no, creditor_code, creditor_name, item_code, item_description,
      location, doc_date, remaining_qty, delivery_date, supplier_date1, supplier_date2,
      supplier_date3, overdue_days,
      unit_price, amount, amount_source, amount_updated_at, amount_updated_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(doc_no, item_code) DO NOTHING`;

    for (const o of data) {
      if (!o.DocNo || !o.ItemCode) continue;
      const key = `${o.DocNo}|${o.ItemCode}`;
      const restored = overdueMap.get(key) || null;
      if (restored) preserved++;

      // Manual override wins; sync-sourced amounts get refreshed.
      const manual = manualAmountMap.get(key);
      let unit_price: number | null = null;
      let amount: number | null = null;
      let amount_source: string | null = null;
      let amount_updated_at: string | null = null;
      let amount_updated_by: number | null = null;

      if (manual) {
        unit_price = manual.unit_price;
        amount = manual.amount;
        amount_source = manual.amount_source;
        amount_updated_at = manual.amount_updated_at;
        amount_updated_by = manual.amount_updated_by;
      }
      // Note: getOutstanding doesn't return UnitPrice/SubTotal in our
      // middleware, so sync-sourced amounts will stay null. Users edit
      // amount on the row and it's preserved across syncs.

      stmts.push(
        env.DB.prepare(insertSql).bind(
          o.DocNo,
          o.SODocNo ?? null,
          o.CreditorCode ?? null,
          o.CreditorName ?? null,
          o.ItemCode,
          o.ItemDescription ?? null,
          o.Location ?? null,
          dateOnly(o.DocDate) ?? null,
          o.RemainingQty ?? 0,
          dateOnly(o.DeliveryDate) ?? null,
          dateOnly(o.SupplierDeliveryDate1) ?? null,
          dateOnly(o.SupplierDeliveryDate2) ?? null,
          dateOnly(o.SupplierDeliveryDate3) ?? null,
          restored,
          unit_price ?? null,
          amount ?? null,
          amount_source ?? null,
          amount_updated_at ?? null,
          amount_updated_by ?? null
        )
      );
      inserted++;
    }

    if (stmts.length > 0) {
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

export interface PODocsPullResult {
  fetched: number;
  inserted: number;
  outstanding: number;
  delivered: number;
  cancelled: number;
  preserved: number;
  message: string;
}

/**
 * Pull doc-level POs from /PurchaseOrder/getAll into
 * `purchase_order_docs`. One row per PO header — feeds the P&L module
 * (LocalExTax) and the "Documents" view on the PO page.
 *
 * Manual overrides on local_ex_tax (amount_source='manual') are
 * preserved across the wipe-and-reload, mirroring the line table.
 */
export async function runPODocsPull(
  env: Env,
  triggerType: "MANUAL" | "SCHEDULED"
): Promise<PODocsPullResult> {
  const rid = crypto.randomUUID();
  const startedAt = new Date();
  const client = new AutoCountClient(env, rid);

  try {
    const data = await client.getAllPODocs();

    if (data.length > 0) {
      console.log(
        `[poDocsPull][${rid}] sample keys:`,
        Object.keys(data[0]).slice(0, 30).join(",")
      );
    }

    const existing = await env.DB.prepare(
      `SELECT doc_no, local_ex_tax, amount_source, amount_updated_at, amount_updated_by
         FROM purchase_order_docs`
    ).all<{
      doc_no: string;
      local_ex_tax: number | null;
      amount_source: string | null;
      amount_updated_at: string | null;
      amount_updated_by: number | null;
    }>();

    const manualMap = new Map<
      string,
      {
        local_ex_tax: number | null;
        amount_source: string | null;
        amount_updated_at: string | null;
        amount_updated_by: number | null;
      }
    >();
    for (const r of existing.results || []) {
      if (r.amount_source === "manual") {
        manualMap.set(r.doc_no, {
          local_ex_tax: r.local_ex_tax,
          amount_source: r.amount_source,
          amount_updated_at: r.amount_updated_at,
          amount_updated_by: r.amount_updated_by,
        });
      }
    }

    await env.DB.prepare(`DELETE FROM purchase_order_docs`).run();

    let inserted = 0;
    let preserved = 0;
    let outstandingCount = 0;
    let deliveredCount = 0;
    let cancelledCount = 0;

    const stmts: D1PreparedStatement[] = [];
    const insertSql = `INSERT INTO purchase_order_docs (
      doc_no, doc_date, ref, so_doc_no, creditor_code, creditor_name,
      purchase_location, doc_status, cancelled,
      local_ex_tax, local_tax, local_net_total, final_total,
      currency_code, currency_rate,
      remark1, remark2, remark3, remark4, note, last_modified,
      amount_source, amount_updated_at, amount_updated_by, raw
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(doc_no) DO NOTHING`;

    for (const o of data) {
      if (!o.DocNo) continue;

      // AutoCount stores Cancelled as "T"/"F" string. Treat it loose.
      const cancelled =
        o.Cancelled === true ||
        o.Cancelled === 1 ||
        String(o.Cancelled || "").toUpperCase() === "T" ||
        String(o.Cancelled || "").toLowerCase() === "true"
          ? 1
          : 0;
      // DocStatus 'C' = Closed/Completed; otherwise active. Combined
      // with cancelled gives us the status filter.
      const status = String(o.DocStatus || "").toUpperCase();
      const delivered = !cancelled && status === "C";
      if (cancelled) cancelledCount++;
      else if (delivered) deliveredCount++;
      else outstandingCount++;

      // Prefer manual override; otherwise pull LocalExTax (ex-tax line
      // subtotal in local currency — what we want for cost analysis).
      // Fall back through LocalNetTotal → FinalTotal → Total.
      const manual = manualMap.get(o.DocNo);
      let local_ex_tax: number | null = null;
      let amount_source: string | null = null;
      let amount_updated_at: string | null = null;
      let amount_updated_by: number | null = null;

      if (manual) {
        local_ex_tax = manual.local_ex_tax;
        amount_source = manual.amount_source;
        amount_updated_at = manual.amount_updated_at;
        amount_updated_by = manual.amount_updated_by;
        preserved++;
      } else {
        const candidates: Array<number | null | undefined> = [
          o.LocalExTax,
          o.LocalNetTotal,
          o.FinalTotal,
          o.Total,
        ];
        for (const c of candidates) {
          if (typeof c === "number" && c !== 0) {
            local_ex_tax = c;
            break;
          }
        }
        if (local_ex_tax != null) {
          amount_source = "sync";
          amount_updated_at = new Date().toISOString();
        }
      }

      stmts.push(
        env.DB.prepare(insertSql).bind(
          o.DocNo,
          dateOnly(o.DocDate) ?? null,
          o.Ref ?? null,
          o.POUDF_SONo ?? null,
          o.CreditorCode ?? null,
          o.CreditorName ?? null,
          o.PurchaseLocation ?? null,
          o.DocStatus ?? null,
          cancelled,
          local_ex_tax,
          typeof o.LocalTax === "number" ? o.LocalTax : null,
          typeof o.LocalNetTotal === "number" ? o.LocalNetTotal : null,
          typeof o.FinalTotal === "number" ? o.FinalTotal : null,
          o.CurrencyCode ?? null,
          typeof o.CurrencyRate === "number" ? o.CurrencyRate : null,
          o.Remark1 ?? null,
          o.Remark2 ?? null,
          o.Remark3 ?? null,
          o.Remark4 ?? null,
          o.Note ?? null,
          o.LastModified ?? null,
          amount_source,
          amount_updated_at,
          amount_updated_by,
          JSON.stringify(o)
        )
      );
      inserted++;
    }

    if (stmts.length > 0) {
      for (let i = 0; i < stmts.length; i += 50) {
        await env.DB.batch(stmts.slice(i, i + 50));
      }
    }

    const message =
      `Pulled ${data.length} PO docs (${outstandingCount} open, ` +
      `${deliveredCount} closed, ${cancelledCount} cancelled). ` +
      `Preserved ${preserved} manual overrides.`;
    await writeLog(env, {
      requestId: rid,
      type: `PO_DOCS_PULL_${triggerType}`,
      startedAt,
      status: "SYNCED",
      message,
    });
    return {
      fetched: data.length,
      inserted,
      outstanding: outstandingCount,
      delivered: deliveredCount,
      cancelled: cancelledCount,
      preserved,
      message,
    };
  } catch (err: any) {
    const message = err?.message || String(err);
    await writeLog(env, {
      requestId: rid,
      type: `PO_DOCS_PULL_${triggerType}`,
      startedAt,
      status: "FAILED",
      message,
    });
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
