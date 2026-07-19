// Apply scripts/scm-schema/pi-settlement-atomic.sql — the atomic
// scm.settle_pi_paid_centi function that clamps a purchase invoice's paid_centi
// at total_centi inside the database, so two payment vouchers settling the same
// invoice concurrently can no longer over-pay it.
//
// STAGING FIRST (owner rule). Point .dev.vars DATABASE_URL at STAGING, run,
// verify, then repeat against prod:
//   node scripts/scm-schema/apply-pi-settlement-atomic.mjs
//
// ADDITIVE + IDEMPOTENT — CREATE OR REPLACE FUNCTION only, touches no table
// data. Safe to re-run. Reloads PostgREST's schema cache so the new RPC is
// callable immediately.
import { readFileSync } from "node:fs";
import postgres from "postgres";

const dv = readFileSync(".dev.vars", "utf8");
const url = dv.match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim().replace(/^"|"$/g, "");
if (!url) { console.error("DATABASE_URL missing in .dev.vars"); process.exit(1); }

const ddl = readFileSync("scripts/scm-schema/pi-settlement-atomic.sql", "utf8");
const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 25 });

try {
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL search_path TO scm, public");
    await tx.unsafe(ddl);
  });

  // Verify the function landed in scm with the expected 2-arg signature.
  const fns = await sql`
    select p.proname, pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'scm' and p.proname = 'settle_pi_paid_centi'`;
  if (fns.length === 0) {
    console.log("MISSING  scm.settle_pi_paid_centi");
    process.exitCode = 3;
  } else {
    for (const f of fns) console.log(`OK  scm.${f.proname}(${f.args})`);
  }

  /* Report any purchase invoice that is ALREADY over-paid. These are the rows
     the race produced before this function existed; the clamp stops new ones
     but does not and must not rewrite history — an over-payment is a real
     discrepancy with a supplier and someone has to decide what happened to the
     money. Listed here so whoever applies this knows what to reconcile. */
  const over = await sql`
    select id, invoice_number, total_centi, paid_centi
      from scm.purchase_invoices
     where coalesce(paid_centi, 0) > coalesce(total_centi, 0)
       and upper(coalesce(status, '')) not in ('DRAFT', 'CANCELLED')
     order by (paid_centi - total_centi) desc
     limit 50`;
  if (over.length === 0) {
    console.log("No already-over-paid purchase invoices found.");
  } else {
    console.log(`\nALREADY OVER-PAID — ${over.length} purchase invoice(s) need reconciling by hand:`);
    for (const r of over) {
      console.log(`  ${r.invoice_number}  total ${r.total_centi}  paid ${r.paid_centi}  excess ${r.paid_centi - r.total_centi} sen`);
    }
    console.log("");
  }

  // PostgREST caches the schema; nudge it so sb.rpc() resolves the new function
  // without waiting for the periodic reload.
  await sql`select pg_notify('pgrst', 'reload schema')`;
  console.log("Requested PostgREST schema reload.");
  console.log(fns.length > 0 ? "DONE." : "DONE — function missing, review above.");
} catch (err) {
  console.error("APPLY FAILED:", String(err?.message || err).slice(0, 800));
  process.exitCode = 2;
} finally {
  await sql.end();
}
