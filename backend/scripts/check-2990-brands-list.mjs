#!/usr/bin/env node
// Read-only: show every project_brands row belonging to 2990, so the owner
// can verify the seed only added values from 2990's own data.
import postgres from "postgres";
const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const dst = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

async function main() {
  const [c2990] = await dst`SELECT id FROM companies WHERE code='2990'`;
  const [cHouzs] = await dst`SELECT id FROM companies WHERE code='HOUZS'`;
  notice(`2990 company_id=${c2990.id}  HOUZS company_id=${cHouzs.id}`);
  const rows = await dst`
    SELECT id, name, sort_order, active, created_at
      FROM project_brands
     WHERE company_id=${c2990.id}
     ORDER BY sort_order, name`;
  notice(`\n=== project_brands for company_id=2 (2990) — ${rows.length} rows ===`);
  for (const r of rows) {
    notice(`  id=${r.id}  name="${r.name}"  sort_order=${r.sort_order}  active=${r.active}  created=${r.created_at}`);
  }
  // Same for HOUZS to prove nothing bled.
  const hz = await dst`
    SELECT count(*)::int AS n FROM project_brands WHERE company_id=${cHouzs.id}`;
  notice(`\n=== project_brands for HOUZS (company_id=${cHouzs.id}) — ${hz[0].n} rows (untouched) ===`);
  const usage = await dst.unsafe(`
    WITH src AS (
      SELECT btrim(branding) AS n FROM scm.mfg_products WHERE company_id=${c2990.id} AND branding IS NOT NULL AND btrim(branding) <> ''
      UNION ALL SELECT btrim(branding) FROM scm.product_models WHERE company_id=${c2990.id} AND branding IS NOT NULL AND btrim(branding) <> ''
      UNION ALL SELECT btrim(i.branding) FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders o ON o.doc_no = i.doc_no
                WHERE o.company_id=${c2990.id} AND i.branding IS NOT NULL AND btrim(i.branding) <> ''
    )
    SELECT n, count(*)::int AS occurrences FROM src GROUP BY n ORDER BY count(*) DESC, n ASC
  `);
  notice(`\n=== DISTINCT branding values IN USE across 2990's own SKUs/models/SO lines ===`);
  for (const r of usage) notice(`  "${r.n}"  used on ${r.occurrences} rows`);
}
main().then(() => dst.end()).catch(async e => {
  console.error("CHECK_FAIL", e.message);
  try { await dst.end(); } catch {}
  process.exit(1);
});
