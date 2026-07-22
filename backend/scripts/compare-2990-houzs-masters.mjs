#!/usr/bin/env node
// Read-only comparison between 2990 (company_id=2) and HOUZS (company_id=1)
// master data on the SO Maintenance surfaces: countries, warehouses, State
// → warehouse binding, State → delivery-region binding. Owner audit
// 2026-07-22 — the two companies should mostly share (fleet-style), and
// where they don't, we want a diff list to reconcile.
//
// Output: per-domain table (Only-in-A, Only-in-B, Match).
import postgres from "postgres";
const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const db = postgres(DST, { ssl: "require", prepare: false, max: 1 });

async function main() {
  const cos = await db`SELECT id, code FROM companies WHERE code IN ('HOUZS','2990') ORDER BY code`;
  const HOUZS = cos.find(r => r.code === "HOUZS")?.id;
  const CO2990 = cos.find(r => r.code === "2990")?.id;
  if (!HOUZS || !CO2990) throw new Error(`companies missing: ${JSON.stringify(cos)}`);
  console.log(`companies: HOUZS=${HOUZS}  2990=${CO2990}\n`);

  // ── COUNTRIES (from scm.my_localities distinct country values, plus any
  //   explicit country master if it exists) ──────────────────────────────
  console.log("=== COUNTRIES (SO Maintenance) ===");
  const countryProbe = await db`SELECT to_regclass('scm.my_localities')::text AS t`;
  if (!countryProbe[0].t) {
    console.log("  (scm.my_localities absent, skip)");
  } else {
    // my_localities has no company_id; countries are inherently global. Show
    // count only.
    const rows = await db`SELECT country, count(*)::int AS n
                             FROM scm.my_localities
                            GROUP BY country ORDER BY country`;
    for (const r of rows) console.log(`  ${r.country.padEnd(20)} rows=${r.n}`);
  }

  // ── WAREHOUSES per company ───────────────────────────────────────────
  console.log("\n=== WAREHOUSES per company (code + name + type) ===");
  const wh = await db`
    SELECT id, code, name, company_id,
           COALESCE(is_showroom, false) AS is_showroom,
           COALESCE(is_active,   true)  AS is_active,
           venue_name
      FROM scm.warehouses
     WHERE company_id IN (${HOUZS}, ${CO2990})
     ORDER BY company_id, code`;
  const byCo = new Map();
  for (const r of wh) {
    if (!byCo.has(r.company_id)) byCo.set(r.company_id, []);
    byCo.get(r.company_id).push(r);
  }
  for (const [cid, rows] of byCo) {
    const label = cid === HOUZS ? "HOUZS" : "2990 ";
    console.log(`\n  ${label} (company_id=${cid}) — ${rows.length} warehouse(s):`);
    for (const r of rows) {
      const t = r.is_showroom ? "SHOWROOM" : "WAREHOUSE";
      const act = r.is_active ? "" : "  [INACTIVE]";
      console.log(`    ${(r.code ?? "").padEnd(18)} ${t.padEnd(10)} ${r.name ?? ""}${act}`);
    }
  }

  // Code-level diff between companies (should overlap except showrooms).
  const codeSet = (rows) => new Set(rows.filter(r => !r.is_showroom).map(r => r.code));
  const houzsCodes = codeSet(byCo.get(HOUZS) ?? []);
  const twoNCodes  = codeSet(byCo.get(CO2990) ?? []);
  const onlyHouzs  = [...houzsCodes].filter(c => !twoNCodes.has(c)).sort();
  const only2990   = [...twoNCodes].filter(c => !houzsCodes.has(c)).sort();
  const both       = [...houzsCodes].filter(c => twoNCodes.has(c)).sort();
  console.log(`\n  WAREHOUSE code diff (excluding showrooms):`);
  console.log(`    in BOTH  (${both.length}) : ${both.join(", ") || "—"}`);
  console.log(`    HOUZS-only (${onlyHouzs.length}): ${onlyHouzs.join(", ") || "—"}`);
  console.log(`    2990-only  (${only2990.length}) : ${only2990.join(", ") || "—"}`);

  // ── STATE → WAREHOUSE binding per company ─────────────────────────────
  console.log("\n=== STATE → WAREHOUSE binding (my_localities.warehouse_id) ===");
  // my_localities carries an optional warehouse_id per row; distinct
  // (state, warehouse_id) pairs are the effective mapping.
  const swProbe = await db`SELECT column_name FROM information_schema.columns
                             WHERE table_schema='scm' AND table_name='my_localities' AND column_name='warehouse_id'`;
  if (!swProbe.length) {
    console.log("  (my_localities.warehouse_id absent — mapping lives elsewhere, skip)");
  } else {
    // my_localities has NO company_id, so this is a SINGLE global mapping;
    // both companies read the same rows. Report it once.
    const rows = await db`
      SELECT DISTINCT ml.state, ml.warehouse_id, w.code AS warehouse_code, w.company_id
        FROM scm.my_localities ml
        LEFT JOIN scm.warehouses w ON w.id = ml.warehouse_id
       WHERE ml.warehouse_id IS NOT NULL
       ORDER BY ml.state, ml.warehouse_id`;
    if (rows.length === 0) console.log("  (no state->warehouse mappings configured)");
    else for (const r of rows) {
      const coLabel = r.company_id === HOUZS ? "HOUZS" : r.company_id === CO2990 ? "2990" : `co${r.company_id ?? "?"}`;
      console.log(`  ${(r.state ?? "").padEnd(20)} → ${(r.warehouse_code ?? "?").padEnd(20)} [${coLabel}]`);
    }
  }

  // ── STATE → REGION binding per company (delivery-planning) ────────────
  console.log("\n=== STATE → REGION binding (state_delivery_regions per company) ===");
  const srdProbe = await db`SELECT to_regclass('scm.state_delivery_regions')::text AS t`;
  if (!srdProbe[0].t) {
    console.log("  (scm.state_delivery_regions absent, skip)");
  } else {
    for (const cid of [HOUZS, CO2990]) {
      const label = cid === HOUZS ? "HOUZS" : "2990";
      const rows = await db`
        SELECT sdr.state_key, sdr.country, dpr.code AS region_code
          FROM scm.state_delivery_regions sdr
          JOIN scm.delivery_planning_regions dpr ON dpr.id = sdr.region_id
         WHERE sdr.company_id = ${cid}
         ORDER BY sdr.state_key, dpr.code`;
      console.log(`\n  ${label} (${rows.length} mapping(s)):`);
      if (rows.length === 0) console.log(`    (none)`);
      else {
        const byState = new Map();
        for (const r of rows) {
          const k = `${r.state_key}|${r.country}`;
          if (!byState.has(k)) byState.set(k, []);
          byState.get(k).push(r.region_code);
        }
        for (const [k, codes] of byState) {
          const [state, country] = k.split("|");
          console.log(`    ${state.padEnd(20)} (${country}) → ${codes.sort().join(", ")}`);
        }
      }
    }
    // Diff summary — states mapped in one but not the other.
    const set = async (cid) => new Set((await db`
      SELECT DISTINCT sdr.state_key || '|' || sdr.country AS k
        FROM scm.state_delivery_regions sdr
       WHERE sdr.company_id = ${cid}`).map(r => r.k));
    const A = await set(HOUZS), B = await set(CO2990);
    const onlyA = [...A].filter(x => !B.has(x)).sort();
    const onlyB = [...B].filter(x => !A.has(x)).sort();
    console.log(`\n  STATE|COUNTRY key diff:`);
    console.log(`    HOUZS-only (${onlyA.length}): ${onlyA.join(", ") || "—"}`);
    console.log(`    2990-only  (${onlyB.length}) : ${onlyB.join(", ") || "—"}`);
  }
}

main().then(() => db.end()).catch(async e => {
  console.error("COMPARE_FAIL:", e.message);
  await db.end();
  process.exit(1);
});
