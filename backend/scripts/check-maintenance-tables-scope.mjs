#!/usr/bin/env node
// Read-only: for every "master master" table that the deep-parity diag flagged
// as MISSING under company_id=2, print (a) whether it has company_id at all,
// (b) row counts per company_id, and (c) if the deep-parity diag was
// legitimately reporting missing rows OR just failing to match on a shared
// table it should not have filtered.
//
// Owner 2026-07-23: challenged the deep-parity result — insists these
// maintenance tables ARE populated on 2990's side of Houzs ERP. This script
// tells us who was right.
import postgres from "postgres";
const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const dst = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

const TABLES = [
  "addons",
  "bundle_library",
  "compartment_library",
  "size_library",
  "categories",
  "series",
  "delivery_planning_regions",
  "state_delivery_regions",
  "delivery_fee_config",
  "fabric_tier_addon_config",
  "maintenance_config_history",
  "special_addons_history",
  "my_localities",
];

async function main() {
  const [c2990] = await dst`SELECT id FROM companies WHERE code='2990'`;
  const [cHouzs] = await dst`SELECT id FROM companies WHERE code='HOUZS'`;
  notice(`2990 co=${c2990.id}  HOUZS co=${cHouzs.id}`);
  notice("");

  for (const t of TABLES) {
    // Does the table exist?
    const [exists] = await dst`SELECT to_regclass(${'scm.' + t})::text AS n`;
    if (!exists.n) { notice(`${t}: NOT FOUND in scm.*`); continue; }

    // Does it have company_id?
    const cols = await dst`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema='scm' AND table_name=${t}`;
    const colSet = new Set(cols.map((r) => r.column_name));
    const hasCid = colSet.has("company_id");

    if (!hasCid) {
      const [g] = await dst.unsafe(`SELECT count(*)::int AS n FROM scm."${t}"`);
      notice(`${t}: SHARED (no company_id column) — ${g.n} total rows`);
      continue;
    }

    // Counts per company_id.
    const rows = await dst.unsafe(`
      SELECT company_id, count(*)::int AS n
        FROM scm."${t}"
       GROUP BY company_id
       ORDER BY company_id NULLS FIRST`);
    const parts = rows.map((r) => `co=${r.company_id ?? 'NULL'} n=${r.n}`).join("  ");
    notice(`${t}: scoped (${parts})`);
  }

  notice("");
  notice("=== interpretation ===");
  notice(" * SHARED (no company_id) — both companies see the SAME rows.");
  notice("   Deep-parity's MISSING count against these tables is a diag bug —");
  notice("   src rows can't match dest UUIDs because they were never imported");
  notice("   (HOUZS shipped its own set), yet the table is de-facto shared and");
  notice("   the 2990 user sees HOUZS's rows just fine in the UI.");
  notice(" * scoped with co=2 n=0 — 2990 side is genuinely empty. If the");
  notice("   maintenance page displays these, the FE is falling back to HOUZS's");
  notice("   rows via a query bug (or the page is empty and staff didn't notice).");
  notice(" * scoped with co=2 n>0 — 2990 imported its own; deep-parity was");
  notice("   comparing correctly and any MISSING is real gap.");
}
main().then(() => dst.end()).catch(async (e) => {
  console.error("CHECK_FAIL", e.message);
  try { await dst.end(); } catch {}
  process.exit(1);
});
