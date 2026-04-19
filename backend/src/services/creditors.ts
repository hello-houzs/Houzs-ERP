import type { Env } from "../types";
import { AutoCountClient } from "./autocount";
import { writeLog } from "./logger";

export interface CreditorPullResult {
  fetched: number;
  inserted: number;
  message: string;
}

/**
 * Pull every creditor from AutoCount (/Creditor/getAll) into the
 * local `creditors` mirror table. Wipe-and-reload — AutoCount is the
 * system of record so we don't try to merge changes; we replace.
 *
 * Field names mirror the upstream payload exactly (all `Creditor*`).
 * The full row is also stored as JSON in `raw` so the UI can opt-in
 * to any field without a schema migration.
 */
export async function runCreditorsPull(
  env: Env,
  triggerType: "MANUAL" | "SCHEDULED"
): Promise<CreditorPullResult> {
  const rid = crypto.randomUUID();
  const startedAt = new Date();
  const client = new AutoCountClient(env, rid);

  try {
    const data = await client.getAllCreditors();

    if (data.length > 0) {
      console.log(
        `[creditorsPull][${rid}] sample keys:`,
        Object.keys(data[0]).slice(0, 30).join(",")
      );
    }

    await env.DB.prepare(`DELETE FROM creditors`).run();

    let inserted = 0;
    const stmts: D1PreparedStatement[] = [];
    const insertSql = `INSERT INTO creditors (
      creditor_code, company_name, desc2,
      address1, address2, address3, address4, post_code,
      deliver_address1, deliver_address2, deliver_address3, deliver_address4, deliver_post_code,
      attention, phone1, phone2, mobile, fax1, fax2,
      email, web_url, contact_info, nature_of_business,
      currency_code, display_term, rounding_method, inclusive_tax,
      price_category, statement_type, aging_on,
      credit_limit, overdue_limit,
      tax_code, tax_register_no, gst_register_no, sst_register_no,
      self_billed_approval_no, exempt_no, exempt_expiry_date, register_no, gst_status_verified_date,
      area_code, area_description, area_desc2,
      type, type_description, type_desc2,
      purchase_agent, purchase_agent_description, parent_acc_no,
      note,
      last_modified, last_modified_user_id, created_timestamp, created_user_id,
      raw
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(creditor_code) DO NOTHING`;

    for (const o of data) {
      const code: string | null = o.CreditorCode ?? null;
      if (!code) continue;

      stmts.push(
        env.DB.prepare(insertSql).bind(
          code,
          o.CreditorCompanyName ?? null,
          o.CreditorDesc2 ?? null,
          o.CreditorAddress1 ?? null,
          o.CreditorAddress2 ?? null,
          o.CreditorAddress3 ?? null,
          o.CreditorAddress4 ?? null,
          o.CreditorPostCode ?? null,
          o.CreditorDeliverAddress1 ?? null,
          o.CreditorDeliverAddress2 ?? null,
          o.CreditorDeliverAddress3 ?? null,
          o.CreditorDeliverAddress4 ?? null,
          o.CreditorDeliverPostCode ?? null,
          o.CreditorAttention ?? null,
          o.CreditorPhone1 ?? null,
          o.CreditorPhone2 ?? null,
          o.CreditorMobile ?? null,
          o.CreditorFax1 ?? null,
          o.CreditorFax2 ?? null,
          o.CreditorEmailAddress ?? null,
          o.CreditorWebURL ?? null,
          o.CreditorContactInfo ?? null,
          o.CreditorNatureOfBusiness ?? null,
          o.CreditorCurrencyCode ?? null,
          o.CreditorDisplayTerm ?? null,
          o.CreditorRoundingMethod ?? null,
          // CreditorInclusiveTax may come back as boolean, "T"/"F", or 0/1
          o.CreditorInclusiveTax === true ||
            o.CreditorInclusiveTax === 1 ||
            String(o.CreditorInclusiveTax || "").toUpperCase() === "T"
            ? 1
            : 0,
          o.CreditorPriceCategory ?? null,
          o.CreditorStatementType ?? null,
          o.CreditorAgingOn ?? null,
          typeof o.CreditorCreditLimit === "number" ? o.CreditorCreditLimit : null,
          typeof o.CreditorOverdueLimit === "number" ? o.CreditorOverdueLimit : null,
          o.CreditorTaxCode ?? null,
          o.CreditorTaxRegisterNo ?? null,
          o.CreditorGSTRegisterNo ?? null,
          o.CreditorSSTRegisterNo ?? null,
          o.CreditorSelfBilledApprovalNo ?? null,
          o.CreditorExemptNo ?? null,
          o.CreditorExemptExpiryDate ?? null,
          o.CreditorRegisterNo ?? null,
          o.CreditorGSTStatusVerifiedDate ?? null,
          o.CreditorAreaCode ?? null,
          o.CreditorAreaDescription ?? null,
          o.CreditorAreaDesc2 ?? null,
          o.CreditorType ?? null,
          o.CreditorTypeDescription ?? null,
          o.CreditorTypeDesc2 ?? null,
          o.CreditorPurchaseAgent ?? null,
          o.CreditorPurchaseAgentDescription ?? null,
          o.CreditorParentAccNo ?? null,
          o.CreditorNote ?? null,
          o.CreditorLastModified ?? null,
          o.CreditorLastModifiedUserID ?? null,
          o.CreditorCreatedTimestamp ?? null,
          o.CreditorCreatedUserID ?? null,
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

    const message = `Pulled ${data.length} creditors.`;
    await writeLog(env, {
      requestId: rid,
      type: `CREDITORS_PULL_${triggerType}`,
      startedAt,
      status: "SYNCED",
      message,
    });
    return { fetched: data.length, inserted, message };
  } catch (err: any) {
    const message = err?.message || String(err);
    await writeLog(env, {
      requestId: rid,
      type: `CREDITORS_PULL_${triggerType}`,
      startedAt,
      status: "FAILED",
      message,
    });
    throw err;
  }
}
