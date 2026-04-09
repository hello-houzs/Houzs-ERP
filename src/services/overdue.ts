import type { Env } from "../types";
import { AutoCountClient, dateOnly } from "./autocount";
import { writeLog } from "./logger";

export interface OverdueResult {
  fetched: number;
  extended: number;
  failed: number;
  extensionDate: string;
  message: string;
}

export async function runOverdue(env: Env, triggerType: "MANUAL" | "SCHEDULED"): Promise<OverdueResult> {
  const rid = crypto.randomUUID();
  const startedAt = new Date();
  const client = new AutoCountClient(env, rid);

  try {
    const orders = await client.getOverdue();

    // today + 3 days, formatted yyyy-mm-dd
    const ext = new Date();
    ext.setUTCDate(ext.getUTCDate() + 3);
    const extensionDate = ext.toISOString().slice(0, 10);
    const pullDate = new Date().toISOString();

    if (!orders.length) {
      const r: OverdueResult = {
        fetched: 0,
        extended: 0,
        failed: 0,
        extensionDate,
        message: "No overdue items found.",
      };
      await writeLog(env, { requestId: rid, type: `OVERDUE_${triggerType}`, startedAt, status: "SKIPPED", message: r.message });
      return r;
    }

    let extended = 0;
    let failed = 0;

    for (const o of orders) {
      // Append history first (audit log)
      try {
        await env.DB.prepare(
          `INSERT INTO overdue_history (pull_date, doc_no, debtor_name, phone, location, balance, original_expiry_date, extended_to)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(
            pullDate,
            o.DocNo,
            o.DebtorName ?? null,
            o.Phone1 ?? null,
            o.SalesLocation ?? null,
            o.SOUDF_BALANCE ?? 0,
            dateOnly(o.SalesExemptionExpiryDate),
            extensionDate
          )
          .run();
      } catch (e) {
        console.error(`[overdue][${rid}] history insert failed for ${o.DocNo}`, e);
      }

      // Push extension to AutoCount
      try {
        const res = await client.pushSalesOrder({
          DocNo: o.DocNo,
          Remark4: o.Remark4 ?? null,
          ExpiryDate: extensionDate,
        });
        if (res.ok) {
          extended++;
          // Mirror the new expiry date locally if the order exists in DB
          await env.DB.prepare(
            `UPDATE sales_orders SET expiry_date = ?, sync_status = 'SYNCED', sync_error = NULL, updated_at = datetime('now') WHERE doc_no = ?`
          )
            .bind(extensionDate, o.DocNo)
            .run();
        } else {
          failed++;
        }
      } catch (e) {
        failed++;
      }
    }

    const message = `Logged ${orders.length} overdue. Extended ${extended}, failed ${failed}.`;
    await writeLog(env, {
      requestId: rid,
      type: `OVERDUE_${triggerType}`,
      startedAt,
      status: failed > 0 && extended === 0 ? "FAILED" : "SYNCED",
      message,
    });
    return { fetched: orders.length, extended, failed, extensionDate, message };
  } catch (err: any) {
    const message = err?.message || String(err);
    await writeLog(env, { requestId: rid, type: `OVERDUE_${triggerType}`, startedAt, status: "FAILED", message });
    throw err;
  }
}
