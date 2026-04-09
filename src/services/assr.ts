import type { Env } from "../types";
import { AutoCountClient, cleanPhone } from "./autocount";

export interface CreateAssrInput {
  doc_no: string;
  item_code: string;
  complaint_issue: string;
}

/**
 * Generate the next ASSR number for the current month.
 * Format: ASSR/YYMM-NNN
 */
export async function nextAssrNumber(env: Env): Promise<string> {
  const now = new Date();
  const yy = String(now.getUTCFullYear()).slice(-2);
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const prefix = `ASSR/${yy}${mm}`;

  const row = await env.DB.prepare(
    `SELECT assr_no FROM assr_cases WHERE assr_no LIKE ? ORDER BY assr_no DESC LIMIT 1`
  )
    .bind(`${prefix}-%`)
    .first<{ assr_no: string }>();

  let next = 1;
  if (row?.assr_no) {
    const parts = row.assr_no.split("-");
    const seq = parseInt(parts[1] || "", 10);
    if (!isNaN(seq)) next = seq + 1;
  }
  return `${prefix}-${String(next).padStart(3, "0")}`;
}

export async function createAssrCase(env: Env, input: CreateAssrInput): Promise<{ assr_no: string }> {
  const client = new AutoCountClient(env);
  let context = null;
  try {
    context = await client.getSingle(input.doc_no);
  } catch (e) {
    console.warn(`[assr] getSingle failed for ${input.doc_no}`, e);
  }

  const assrNo = await nextAssrNumber(env);
  const today = new Date().toISOString().slice(0, 10);

  await env.DB.prepare(
    `INSERT INTO assr_cases (
       assr_no, status, doc_no, complained_date, customer_name, phone, location,
       sales_agent, item_code, complaint_issue, po_no, addr1, addr2, addr3, addr4
     ) VALUES (?, 'Open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      assrNo,
      input.doc_no,
      today,
      context?.DebtorName ?? null,
      cleanPhone(context?.Phone1),
      context?.SalesLocation ?? null,
      context?.SalesAgent ?? null,
      input.item_code,
      input.complaint_issue,
      context?.SOUDF_ToPONo ?? null,
      context?.InvAddr1 ?? null,
      context?.InvAddr2 ?? null,
      context?.InvAddr3 ?? null,
      context?.InvAddr4 ?? null
    )
    .run();

  return { assr_no: assrNo };
}
