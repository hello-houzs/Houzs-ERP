#!/usr/bin/env node
// Read-only. Owner 2026-07-23 wants 2990's GL (scm.accounts, 31 rows)
// imported into Houzs. accounts.account_code is FK'd by payment_vouchers +
// payment_voucher_lines (mig 0081) so it must stay UNIQUE. The question that
// decides the whole approach: do 2990's account_codes COLLIDE with the codes
// already on dest (HOUZS company_1)?
//
//   * NO collision  -> a plain import works. accounts already has company_id
//     (mig 0083); stamp 2990's rows company_id=2, their codes stay globally
//     unique, the FK is unaffected. Simplest path.
//   * collision     -> the global UNIQUE(account_code) + the FK have to become
//     per-company (UNIQUE(company_id, account_code) + composite FK). Bigger
//     migration touching payment_vouchers. Only do this if forced.
//
// This prints the source codes, the dest codes, and the intersection so the
// decision is evidence-based, not guessed. No writes.
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";
const SUPA_URL = process.env.SOURCE_SUPABASE_URL;
const SUPA_KEY = process.env.SOURCE_SERVICE_ROLE_KEY;
const DST = process.env.DATABASE_URL;
if (!SUPA_URL || !SUPA_KEY || !DST) { console.error("need SOURCE_SUPABASE_URL + SOURCE_SERVICE_ROLE_KEY + DATABASE_URL"); process.exit(2); }
const src = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false } });
const dst = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

async function main() {
  const [c2990] = await dst`SELECT id FROM companies WHERE code='2990'`;
  const [cHouzs] = await dst`SELECT id FROM companies WHERE code='HOUZS'`;
  const cid = Number(c2990.id);
  notice(`2990 co=${cid}  HOUZS co=${cHouzs.id}`);

  // Confirm the current unique constraint(s) on account_code.
  const cons = await dst`
    SELECT conname, pg_get_constraintdef(c.oid) AS def
      FROM pg_constraint c JOIN pg_class cl ON cl.oid=c.conrelid
      JOIN pg_namespace n ON n.oid=cl.relnamespace
     WHERE n.nspname='scm' AND cl.relname='accounts' AND c.contype IN ('u','p')`;
  notice("");
  notice("=== current UNIQUE/PK constraints on scm.accounts ===");
  for (const r of cons) notice(`  ${r.conname}: ${r.def}`);

  // Source (2990) account codes.
  const { data: srcRows, error } = await src.schema("public").from("accounts").select("account_code, account_name, account_type");
  if (error) { notice(`SRC ERR: ${error.message}`); return; }
  const srcCodes = (srcRows ?? []).map((r) => String(r.account_code));
  notice("");
  notice(`=== 2990 SOURCE accounts: ${srcCodes.length} rows ===`);
  for (const r of (srcRows ?? [])) notice(`  ${r.account_code}  ${r.account_name ?? ""}  [${r.account_type ?? ""}]`);

  // Dest codes (all companies — the FK/unique is global today).
  const destRows = await dst`SELECT account_code, company_id FROM scm.accounts`;
  const destByCode = new Map(destRows.map((r) => [String(r.account_code), Number(r.company_id)]));
  notice("");
  notice(`=== dest scm.accounts: ${destRows.length} rows (by company) ===`);
  const perCo = {};
  for (const r of destRows) perCo[r.company_id] = (perCo[r.company_id] ?? 0) + 1;
  for (const [co, n] of Object.entries(perCo)) notice(`  company_id=${co}: ${n}`);

  // The decision: collisions.
  const collide = srcCodes.filter((c) => destByCode.has(c));
  const clean = srcCodes.filter((c) => !destByCode.has(c));
  notice("");
  notice("=== COLLISION CHECK (2990 source code already on dest) ===");
  if (collide.length === 0) {
    notice(`  NO COLLISION — all ${srcCodes.length} 2990 codes are free on dest.`);
    notice(`  => PLAIN IMPORT is safe: add 'accounts' to the importer ORDER,`);
    notice(`     stamp company_id=${cid}; the global UNIQUE(account_code) holds`);
    notice(`     and the payment_vouchers FK is unaffected. No constraint change.`);
  } else {
    notice(`  COLLISION on ${collide.length} codes — these already exist on dest:`);
    for (const c of collide) notice(`     ${c} (dest company_id=${destByCode.get(c)})`);
    notice(`  ${clean.length} codes are free.`);
    notice(`  => The global UNIQUE(account_code) + the FK must become`);
    notice(`     per-company before 2990's chart can land. Bigger migration.`);
  }
}
main().then(() => dst.end()).catch(async (e) => {
  console.error("CHECK_FAIL", e.message);
  try { await dst.end(); } catch {}
  process.exit(1);
});
