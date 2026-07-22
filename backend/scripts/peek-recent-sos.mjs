#!/usr/bin/env node
// One-shot READ-ONLY probe: list the last 20 SOs on scm.mfg_sales_orders
// (any date) + last 20 rows on the legacy sales_orders D1 mirror if exposed
// via Hyperdrive → confirms whether "0 SOs since flip" is real (POS
// genuinely hasn't been used) or a table-choice mistake.
import postgres from "postgres";
const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const db = postgres(DST, { ssl: "require", prepare: false, max: 1 });

async function main() {
  console.log("=== scm.mfg_sales_orders — most recent 20 (any date) ===");
  const recent = await db`
    SELECT doc_no, company_id, created_at, created_by, status
    FROM scm.mfg_sales_orders
    ORDER BY created_at DESC
    LIMIT 20`;
  if (recent.length === 0) {
    console.log("  (empty — the entire table has ZERO rows)");
  } else {
    for (const r of recent) console.log(`  ${r.doc_no}  company=${r.company_id}  status=${r.status}  by=${r.created_by}  ${r.created_at?.toISOString().slice(0, 19)}`);
  }

  console.log("\n=== rows-per-company total (all time) on scm.mfg_sales_orders ===");
  const perCo = await db`SELECT company_id, count(*)::int AS n FROM scm.mfg_sales_orders GROUP BY company_id ORDER BY company_id`;
  for (const r of perCo) console.log(`  company_id=${r.company_id}  n=${r.n}`);

  console.log("\n=== rows-per-day for the last 5 days ===");
  const perDay = await db`
    SELECT (created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS day_myt, company_id, count(*)::int AS n
    FROM scm.mfg_sales_orders
    WHERE created_at >= (now() - interval '5 days')
    GROUP BY 1, company_id
    ORDER BY 1 DESC, company_id`;
  if (perDay.length === 0) console.log("  (none in the last 5 days)");
  else for (const r of perDay) console.log(`  day=${r.day_myt}  company=${r.company_id}  n=${r.n}`);
}

main().then(() => db.end()).catch(async e => {
  console.error("PROBE_FAIL", e.message);
  await db.end();
  process.exit(1);
});
