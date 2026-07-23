#!/usr/bin/env node
// Backfill scm.fabric_trackings.supplier_code from the 2990 backend.
//
// Owner 2026-07-24: the Fabric Converter's "Supplier Code" (the supplier's OWN
// code for a fabric, e.g. PC151-01 for our BF-01) was removed on 2026-06-22
// under the assumption "supplier code IS our code", and the New-Fabric form
// defaulted supplier_code = fabric_code. So live values are NULL or
// self-referential. Restoring the REAL supplier codes lets a PO tell the
// supplier which fabric we actually mean (they don't know our "BF-01").
//
// SOURCE : 2990 Supabase (SOURCE_SUPABASE_URL + SOURCE_SERVICE_ROLE_KEY),
//          public.fabric_trackings.{fabric_code, supplier_code}. This is 2990's
//          OWN fabric catalog, so it only carries codes for fabrics 2990 sells.
// DEST   : Houzs postgres (DATABASE_URL), scm.fabric_trackings (multi-company).
//
// WHY PER-COMPANY (fix 2026-07-24): the first cut matched the 2990 source only
// against the HOUZS company (id 1) and got 0 hits — because the 2990 catalog is
// the 2990 COMPANY's catalog (company_id 2 after import), a different set from
// HOUZS's own fabrics. This version reports EVERY company's blank rows and
// matches each against the source by fabric_code, so the dry-run shows exactly
// which company's fabrics the 2990 codes actually restore. It also prints source
// samples + a BF-01/PC151 probe so a 0-match result is explained, not mysterious.
//
// SAFE / non-clobbering: fills a dest row ONLY when its supplier_code is NULL,
// blank, or equals its own fabric_code (self-referential). A real, distinct
// operator-set value is never overwritten. Matched by fabric_code
// (case-insensitive, trimmed). Idempotent. DRY-RUN unless APPLY=1.
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";
const SUPA_URL = process.env.SOURCE_SUPABASE_URL,
  SUPA_KEY = process.env.SOURCE_SERVICE_ROLE_KEY,
  DST = process.env.DATABASE_URL;
const APPLY = process.env.APPLY === "1";
if (!SUPA_URL || !SUPA_KEY || !DST) {
  console.error("need SOURCE_SUPABASE_URL + SOURCE_SERVICE_ROLE_KEY + DATABASE_URL");
  process.exit(2);
}
const src = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false } });
const dst = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const norm = (s) => (s ?? "").trim().toLowerCase();

async function fetchSrcFabrics() {
  const out = [];
  const P = 1000;
  for (let f = 0; ; f += P) {
    const { data, error } = await src
      .schema("public")
      .from("fabric_trackings")
      .select("fabric_code, supplier_code")
      .range(f, f + P - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < P) break;
  }
  return out;
}

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}`);

  // 1. Source map fabric_code -> supplier_code, keeping only REAL external codes
  //    (present and distinct from the fabric code — a self-referential source
  //    value carries no information to restore). Keyed case-insensitively.
  const srcRows = await fetchSrcFabrics();
  const map = new Map(); // norm(fabric_code) -> { code, sup }
  for (const r of srcRows) {
    const code = (r.fabric_code ?? "").trim();
    const sup = (r.supplier_code ?? "").trim();
    if (code && sup && norm(sup) !== norm(code)) map.set(norm(code), { code, sup });
  }
  log(`source fabric_trackings: ${srcRows.length} rows; ${map.size} carry a real supplier_code (distinct from fabric_code)`);
  // Source samples + a probe for the owner's example, so a 0-match is explained.
  const samples = [...map.values()].slice(0, 15).map((v) => `${v.code} -> ${v.sup}`);
  if (samples.length) log(`source sample (fabric_code -> supplier_code): ${samples.join("  |  ")}`);
  const bfProbe = [...map.values()].filter((v) => /bf-?0?1|pc151/i.test(v.code) || /pc151/i.test(v.sup));
  log(`source rows matching owner example (BF-01 / PC151): ${bfProbe.length ? bfProbe.map((v) => `${v.code} -> ${v.sup}`).join(", ") : "none"}`);

  // 2. Dest company roster (so per-company output reads with a code, not an id).
  const companies = await dst`SELECT id, code FROM companies ORDER BY id`;
  const codeOf = new Map(companies.map((r) => [Number(r.id), r.code]));

  // 3. Every dest fabric row, with company + current supplier_code state.
  const destRows = await dst`
    SELECT id, company_id, fabric_code, supplier_code
      FROM scm.fabric_trackings`;

  // Per-company tallies + the fill plan (blank/self-ref rows that match a source
  // supplier_code). Matching the 2990 catalog against EACH company reveals which
  // company the codes actually belong to.
  const byCo = new Map(); // company_id -> { total, blank, plan:[], probeHits:[] }
  for (const d of destRows) {
    const cid = Number(d.company_id);
    if (!byCo.has(cid)) byCo.set(cid, { total: 0, blank: 0, plan: [], probeHits: [] });
    const bucket = byCo.get(cid);
    bucket.total++;
    const fc = (d.fabric_code ?? "").trim();
    const sc = (d.supplier_code ?? "").trim();
    const isBlank = sc === "" || norm(sc) === norm(fc);
    if (/bf-?0?1/i.test(fc)) bucket.probeHits.push(`${fc} [supplier_code=${sc || "blank"}]`);
    if (!isBlank) continue;
    bucket.blank++;
    const hit = map.get(norm(fc));
    if (hit) bucket.plan.push({ id: d.id, cid, code: fc, from: d.supplier_code, to: hit.sup });
  }

  log("── dest scm.fabric_trackings by company ──");
  const fullPlan = [];
  for (const [cid, b] of [...byCo.entries()].sort((a, z) => a[0] - z[0])) {
    log(`company ${codeOf.get(cid) ?? cid} (id ${cid}): ${b.total} fabrics, ${b.blank} blank/self-ref supplier_code, ${b.plan.length} match a 2990 source code`);
    if (b.probeHits.length) log(`  BF-01-like fabrics here: ${b.probeHits.slice(0, 8).join(" | ")}`);
    for (const p of b.plan.slice(0, 12)) log(`    ${p.code}: "${p.from ?? ""}" -> "${p.to}"`);
    fullPlan.push(...b.plan);
  }
  log(`TOTAL rows to fill across all companies: ${fullPlan.length}`);

  if (!APPLY) {
    log("");
    log(`DRY-RUN — would set supplier_code on ${fullPlan.length} rows. Re-run APPLY=1 to write.`);
    return;
  }

  let n = 0;
  for (const p of fullPlan) {
    await dst`UPDATE scm.fabric_trackings SET supplier_code = ${p.to} WHERE id = ${p.id} AND company_id = ${p.cid}`;
    n++;
  }
  log("");
  log(`APPLIED — set supplier_code on ${n} rows from the 2990 source.`);
}
main()
  .then(() => dst.end())
  .catch(async (e) => {
    console.error("FABRIC_SUPPLIER_CODE_BACKFILL_FAIL", e.message);
    try { await dst.end(); } catch {}
    process.exit(1);
  });
