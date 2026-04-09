import type { Env } from "../types";
import { AutoCountClient } from "./autocount";

/**
 * Push a single sales order's editable fields back to AutoCount and update
 * its sync_status accordingly. Returns the new sync_status.
 */
export async function pushSalesOrder(
  env: Env,
  docNo: string
): Promise<{ status: "SYNCED" | "ERROR"; error?: string }> {
  const row = await env.DB.prepare(
    `SELECT remark4, expiry_date FROM sales_orders WHERE doc_no = ?`
  )
    .bind(docNo)
    .first<{ remark4: string | null; expiry_date: string | null }>();

  if (!row) {
    return { status: "ERROR", error: "Order not found" };
  }

  const client = new AutoCountClient(env);
  try {
    const res = await client.pushSalesOrder({
      DocNo: docNo,
      Remark4: row.remark4,
      ExpiryDate: row.expiry_date,
    });

    if (res.ok) {
      await env.DB.prepare(
        `UPDATE sales_orders SET sync_status = 'SYNCED', sync_error = NULL, updated_at = datetime('now') WHERE doc_no = ?`
      )
        .bind(docNo)
        .run();
      return { status: "SYNCED" };
    } else {
      const err = `HTTP ${res.status}: ${res.body.slice(0, 500)}`;
      await env.DB.prepare(
        `UPDATE sales_orders SET sync_status = 'ERROR', sync_error = ?, updated_at = datetime('now') WHERE doc_no = ?`
      )
        .bind(err, docNo)
        .run();
      return { status: "ERROR", error: err };
    }
  } catch (e: any) {
    const err = `CONN: ${e?.message || String(e)}`;
    await env.DB.prepare(
      `UPDATE sales_orders SET sync_status = 'ERROR', sync_error = ?, updated_at = datetime('now') WHERE doc_no = ?`
    )
      .bind(err, docNo)
      .run();
    return { status: "ERROR", error: err };
  }
}

/**
 * Re-push all rows currently in ERROR state.
 */
export async function retryErrors(env: Env): Promise<{ attempted: number; synced: number; failed: number }> {
  const errored = await env.DB.prepare(
    `SELECT doc_no FROM sales_orders WHERE sync_status = 'ERROR'`
  ).all<{ doc_no: string }>();

  let synced = 0;
  let failed = 0;
  for (const r of errored.results || []) {
    const result = await pushSalesOrder(env, r.doc_no);
    if (result.status === "SYNCED") synced++;
    else failed++;
  }
  return { attempted: (errored.results || []).length, synced, failed };
}
