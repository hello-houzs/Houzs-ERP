#!/usr/bin/env node
// One-shot backfill for the "SO branding column is empty" bug (owner
// 2026-07-23). For every scm.mfg_sales_order_items row where branding is
// NULL/blank, copies it from scm.mfg_products.branding matched by
// (company_id, item_code). Non-destructive — an already-set line-branding
// is never overwritten.
//
// This complements the write-path fix in
// backend/src/scm/lib/derive-line-branding.ts which prevents new lines from
// landing blank going forward — this script closes the historical gap.
//
// APPLY=1 to write, DRY-RUN otherwise. Idempotent — safe to re-run.
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const dst = postgres(DST, { ssl: "require", prepare: false, max: 1 });

async function main() {
  console.log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}`);

  const before = await dst.unsafe(`
    SELECT company_id,
           count(*) FILTER (WHERE branding IS NULL OR btrim(branding)='')::int AS blank_n,
           count(*)::int AS total_n
      FROM scm.mfg_sales_order_items
     GROUP BY company_id
     ORDER BY company_id
  `);
  console.log("BEFORE (mfg_sales_order_items blank branding per company):");
  for (const r of before) console.log(`  co=${r.company_id}: ${r.blank_n}/${r.total_n} blank`);

  const eligible = await dst.unsafe(`
    SELECT i.company_id, count(*)::int AS n
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_products p ON p.code = i.item_code AND p.company_id = i.company_id
     WHERE (i.branding IS NULL OR btrim(i.branding)='')
       AND p.branding IS NOT NULL AND btrim(p.branding) <> ''
     GROUP BY i.company_id
     ORDER BY i.company_id
  `);
  console.log("ELIGIBLE (product has branding, line is blank):");
  for (const r of eligible) console.log(`  co=${r.company_id}: ${r.n} lines can be filled from product catalog`);

  if (APPLY) {
    const res = await dst.unsafe(`
      UPDATE scm.mfg_sales_order_items i
         SET branding = p.branding
        FROM scm.mfg_products p
       WHERE p.code = i.item_code
         AND p.company_id = i.company_id
         AND (i.branding IS NULL OR btrim(i.branding)='')
         AND p.branding IS NOT NULL AND btrim(p.branding) <> ''
    `);
    console.log(`APPLIED: ${res.count} rows updated`);

    const after = await dst.unsafe(`
      SELECT company_id,
             count(*) FILTER (WHERE branding IS NULL OR btrim(branding)='')::int AS blank_n,
             count(*)::int AS total_n
        FROM scm.mfg_sales_order_items
       GROUP BY company_id
       ORDER BY company_id
    `);
    console.log("AFTER:");
    for (const r of after) console.log(`  co=${r.company_id}: ${r.blank_n}/${r.total_n} blank`);
  }
}

main().then(() => dst.end()).catch(async (e) => {
  console.error("BACKFILL_FAIL", e.message);
  try { await dst.end(); } catch {}
  process.exit(1);
});
