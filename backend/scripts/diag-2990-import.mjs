#!/usr/bin/env node
// TEMPORARY PROBE (branch diag/selling-price-probe -- NEVER MERGE).
// Replaces the Phase 2 import diagnostics only so the existing read-only
// diag-2990.yml workflow can carry questions to prod. SELECTs only.
//
// FIVE MONEY/CORRECTNESS LANDMINES, measured before anyone "fixes" them.
// Each was found by reading code today; none has been measured. Fixing a
// predicted bug blind is how you ship a real one.
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const dst = postgres(DST, {
  ssl: "require", prepare: false, max: 1,
  types: { bigint: { to: 20, from: [20], serialize: String, parse: Number } },
});

const q = async (label, sql, fn) => {
  try { console.log(`${label}: ${await fn()}`); }
  catch (e) { console.log(`${label}: QUERY FAILED -- ${e.message}`); }
};

async function main() {
  // --- 1. idempotency_keys: the sweep has never run (timestamptz < text). How big? ---
  console.log("=== 1. idempotency_keys (sweep is broken -- unbounded since day one?) ===");
  await q("  rows", null, async () =>
    (await dst`SELECT count(*)::int AS n FROM idempotency_keys`)[0].n);
  await q("  oldest", null, async () =>
    (await dst`SELECT min(created_at) AS m FROM idempotency_keys`)[0].m ?? "(empty)");
  await q("  total size", null, async () =>
    (await dst`SELECT pg_size_pretty(pg_total_relation_size('idempotency_keys')) AS s`)[0].s);
  // Confirm the DELETE actually raises, rather than trusting the read of the shim.
  await q("  does the sweep predicate raise?", null, async () => {
    try {
      await dst.unsafe(
        `SELECT count(*) FROM idempotency_keys WHERE created_at < to_char(timezone('UTC',now()) - interval '24 hours','YYYY-MM-DD HH24:MI:SS')`);
      return "NO -- it runs. The audit's claim is WRONG.";
    } catch (e) { return `YES -- ${e.message.split("\n")[0]}`; }
  });

  // --- 2. The DO/DR idempotency indexes six comments call the "hard backstop" ---
  console.log("");
  console.log("=== 2. inventory_movements unique indexes (do the DO/DR ones exist?) ===");
  const idx = await dst`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='scm' AND tablename='inventory_movements' ORDER BY indexname`;
  for (const i of idx) console.log(`  ${i.indexname}`);
  const names = idx.map((i) => i.indexname);
  for (const want of ["uq_inv_mov_do_source", "uq_inv_mov_dr_source", "uq_inv_mov_cs_do_source", "uq_inv_mov_cs_dr_source"]) {
    console.log(`  ${want}: ${names.includes(want) ? "EXISTS" : "*** MISSING ***"}`);
  }
  // If we CREATE the missing ones, would they fail on existing data?
  console.log("  -- would creating the DO/DR uniques FAIL on existing data? (dupes block the migration => blocks ALL deploys)");
  await q("  duplicate (source_doc_type, source_doc_id, product_code, variant_key) groups", null, async () => {
    const r = await dst`
      SELECT count(*)::int AS n FROM (
        SELECT source_doc_type, source_doc_id, product_code, variant_key, count(*) AS c
          FROM scm.inventory_movements
         WHERE source_doc_type IN ('DO','DR')
         GROUP BY 1,2,3,4 HAVING count(*) > 1) t`;
    return `${r[0].n} (a non-zero number means the "obvious" fix BLOCKS EVERY DEPLOY)`;
  });

  // --- 3. 'TRANSFER': live enum value, +qty balance rule, no FIFO trigger branch ---
  console.log("");
  console.log("=== 3. TRANSFER movements (balance counts them +qty; the FIFO trigger has no branch) ===");
  await q("  TRANSFER rows", null, async () =>
    (await dst`SELECT count(*)::int AS n FROM scm.inventory_movements WHERE movement_type='TRANSFER'`)[0].n);
  await q("  movement_type breakdown", null, async () => {
    const r = await dst`SELECT movement_type, count(*)::int AS n FROM scm.inventory_movements GROUP BY 1 ORDER BY 1`;
    return r.map((x) => `${x.movement_type}=${x.n}`).join(" ");
  });

  // --- 4. DO-cancel orphans: lot consumptions left behind => COGS overstated forever ---
  console.log("");
  console.log("=== 4. Orphaned lot consumptions from cancelled DOs (COGS overstated) ===");
  await q("  cancelled DOs", null, async () =>
    (await dst`SELECT count(*)::int AS n FROM scm.delivery_orders WHERE status='CANCELLED'`)[0].n);
  await q("  consumptions still pointing at a CANCELLED DO's OUT movement", null, async () => {
    const r = await dst`
      SELECT count(*)::int AS n
        FROM scm.inventory_lot_consumptions c
        JOIN scm.inventory_movements m ON m.id = c.movement_id
        JOIN scm.delivery_orders d ON d.id::text = m.source_doc_id::text
       WHERE m.source_doc_type = 'DO' AND d.status = 'CANCELLED'`;
    return `${r[0].n} (each is COGS that never came back)`;
  });

  // --- 5. batch(): 11 call sites believe they are atomic. Cannot be measured in SQL ---
  console.log("");
  console.log("=== 5. batch() -- NOT measurable here ===");
  console.log("  d1-compat.ts:497 does sql.begin((tx) => ...) and never uses tx; the statements");
  console.log("  run on the ROOT client. With max:1 the transaction holds the only connection");
  console.log("  while its own statements queue for one. Predicted: ~12s stall per batch() then");
  console.log("  a retry outside the transaction. This needs a RUNTIME test on staging, not SQL.");
  console.log("  11 call sites: assr.ts:388, assrPortal.ts:182/386, projects.ts:322/498/1135/2866/3181,");
  console.log("  users.ts:420/491, assrLeadTime.ts:53");

  console.log("");
  console.log("=== rows the app has, for scale ===");
  for (const t of ["scm.inventory_movements", "scm.inventory_lots", "scm.inventory_lot_consumptions", "scm.delivery_orders"]) {
    await q(`  ${t}`, null, async () => (await dst.unsafe(`SELECT count(*)::int AS n FROM ${t}`))[0].n);
  }
}

main()
  .then(() => dst.end({ timeout: 5 }))
  .then(() => process.exit(0))
  .catch(async (e) => { console.error("FAIL", e.message); await dst.end({ timeout: 5 }).catch(() => {}); process.exit(1); });
