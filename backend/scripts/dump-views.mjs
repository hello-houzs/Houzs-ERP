// Read-only. Dumps the CURRENT definition of the SCM report views that
// migration 0084 missed, so we can rebuild them to expose company_id.
// Uses pg_get_viewdef(..., true) for the canonical, pretty-printed body.
// Run via .github/workflows/dump-views.yml against STAGING_DATABASE_URL.
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL missing"); process.exit(2); }

const VIEWS = [
  "v_gl_entries",
  "v_account_balances",
  "v_ar_aging",
  "v_ap_aging",
  "v_inventory_value",
  "v_cogs_entries",
  "v_inventory_lots_open",
  "v_inventory_product_totals",
];

const pg = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 25 });

try {
  for (const v of VIEWS) {
    console.log(`\n========== ${v} ==========`);
    try {
      const rows = await pg`SELECT pg_get_viewdef(${'scm.' + v}::regclass, true) AS def`;
      console.log(`----- BEGIN ${v} -----`);
      console.log(rows[0].def);
      console.log(`----- END ${v} -----`);
    } catch (e) {
      console.log(`!!! ${v} FAILED: ${e.message}`);
    }
  }
  // Also print the column list of each base table candidate so we can confirm
  // which one actually carries company_id.
  console.log(`\n========== company_id presence on candidate base tables ==========`);
  const bases = [
    "journal_entries", "journal_entry_lines", "accounts",
    "sales_invoices", "purchase_invoices",
    "inventory_lots", "inventory_movements", "cogs_entries", "mfg_products",
  ];
  for (const t of bases) {
    try {
      const r = await pg`
        SELECT 1 AS ok FROM information_schema.columns
        WHERE table_schema='scm' AND table_name=${t} AND column_name='company_id' LIMIT 1`;
      console.log(`  ${t}: company_id ${r.length ? "PRESENT" : "ABSENT"}`);
    } catch (e) {
      console.log(`  ${t}: check failed ${e.message}`);
    }
  }
} catch (e) {
  console.error("DUMP_FAIL", e.message);
  process.exitCode = 1;
} finally {
  await pg.end({ timeout: 5 });
}
