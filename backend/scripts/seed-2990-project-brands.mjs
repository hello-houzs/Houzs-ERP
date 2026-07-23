#!/usr/bin/env node
// Seed `public.project_brands` for company_id=2 (2990) using the DISTINCT
// branding values already present on 2990's own SKUs + models + SO lines.
// This bootstraps the branding pool `useBrandingPool()` reads — under HOUZS
// the pool comes from project_brands directly, under 2990 project_brands is
// empty so the FE has to fall back to DISTINCT-across-SKUs and Product
// Maintenance shows an unmaintained list (the discrepancy the owner flagged
// on 2026-07-23).
//
// APPLY=1 to write, DRY-RUN otherwise. Idempotent — ON CONFLICT DO NOTHING
// on (company_id, name). Never modifies existing rows.
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const dst = postgres(DST, { ssl: "require", prepare: false, max: 1 });

async function main() {
  const cidRow = await dst`SELECT id FROM companies WHERE code='2990'`;
  if (!cidRow.length) throw new Error("no 2990 company");
  const cid = Number(cidRow[0].id);
  console.log(`2990 company_id=${cid} mode=${APPLY ? "APPLY" : "DRY-RUN"}`);

  // Union DISTINCT branding across the three places branding lives, keyed
  // by UPPERCASE name (project_brands.name is uppercased-unique de facto).
  // First-seen original casing wins so "Hilton" doesn't become "HILTON".
  const rows = await dst.unsafe(`
    WITH src AS (
      SELECT btrim(branding) AS n FROM scm.mfg_products
       WHERE company_id=${cid} AND branding IS NOT NULL AND btrim(branding) <> ''
      UNION ALL
      SELECT btrim(branding) FROM scm.product_models
       WHERE company_id=${cid} AND branding IS NOT NULL AND btrim(branding) <> ''
      UNION ALL
      SELECT btrim(i.branding) FROM scm.mfg_sales_order_items i
        JOIN scm.mfg_sales_orders o ON o.doc_no = i.doc_no
       WHERE o.company_id=${cid} AND i.branding IS NOT NULL AND btrim(i.branding) <> ''
    )
    SELECT n, count(*)::int AS occurrences
      FROM src
     GROUP BY n
     ORDER BY count(*) DESC, n ASC
  `);
  const seen = new Map(); // UPPER -> first-seen original casing
  for (const r of rows) {
    const upper = r.n.toUpperCase();
    if (!seen.has(upper)) seen.set(upper, { name: r.n, occurrences: r.occurrences });
  }
  console.log(`discovered ${seen.size} distinct brand names across mfg_products + product_models + so_items`);

  const existing = await dst`SELECT name FROM project_brands WHERE company_id=${cid}`;
  const have = new Set(existing.map((r) => String(r.name).trim().toUpperCase()));
  console.log(`existing project_brands rows: ${existing.length}`);

  const toInsert = [];
  let sortOrder = 10;
  for (const [upper, meta] of seen) {
    if (have.has(upper)) continue;
    toInsert.push({ name: meta.name, sort_order: sortOrder, occurrences: meta.occurrences });
    sortOrder += 10;
  }
  console.log(`to insert: ${toInsert.length}`);
  for (const b of toInsert) console.log(`  ${APPLY ? "+" : "?"} ${b.name}  (used on ${b.occurrences} rows)`);

  if (APPLY && toInsert.length > 0) {
    let ins = 0;
    for (const b of toInsert) {
      try {
        const r = await dst`
          INSERT INTO project_brands (company_id, name, color, sort_order, active)
          VALUES (${cid}, ${b.name}, '64748b', ${b.sort_order}, 1)
          ON CONFLICT DO NOTHING
        `;
        ins += r.count ?? 0;
      } catch (e) {
        console.log(`  ERR ${b.name}: ${e.message}`);
      }
    }
    const after = await dst`SELECT count(*)::int AS n FROM project_brands WHERE company_id=${cid}`;
    console.log(`inserted: ${ins}, total after: ${after[0].n}`);
  }
}

main().then(() => dst.end()).catch(async (e) => {
  console.error("SEED_FAIL", e.message);
  try { await dst.end(); } catch {}
  process.exit(1);
});
