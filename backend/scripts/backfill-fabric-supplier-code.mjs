#!/usr/bin/env node
// Backfill Houzs scm.fabric_trackings.supplier_code from the 2990 backend.
//
// Owner 2026-07-24: the Fabric Converter's "Supplier Code" (the supplier's OWN
// code for a fabric, e.g. PC151-01 for our BF-01) was removed on 2026-06-22
// under the assumption "supplier code IS our code", and the New-Fabric form
// defaulted supplier_code = fabric_code. So Houzs's live values are NULL or
// self-referential. Restoring the REAL supplier codes lets a PO tell the
// supplier which fabric we actually mean (they don't know our "BF-01").
//
// SOURCE : 2990 Supabase (SOURCE_SUPABASE_URL + SOURCE_SERVICE_ROLE_KEY),
//          public.fabric_trackings.{fabric_code, supplier_code}.
// DEST   : Houzs postgres (DATABASE_URL), scm.fabric_trackings, company = HOUZS.
//
// SAFE / non-clobbering: fills a Houzs row ONLY when its supplier_code is NULL,
// blank, or equals its own fabric_code (self-referential). A real, distinct
// operator-set supplier_code is never overwritten. Matched by fabric_code,
// scoped to the HOUZS company. Idempotent. DRY-RUN unless APPLY=1.
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
  const [h] = await dst`SELECT id FROM companies WHERE code='HOUZS'`;
  if (!h) throw new Error("no HOUZS company row");
  const cid = Number(h.id);
  log(`HOUZS company_id=${cid}  mode=${APPLY ? "APPLY" : "DRY-RUN"}`);

  // 1. Source map fabric_code -> supplier_code, keeping only REAL external codes
  //    (present and distinct from the fabric code — a self-referential source
  //    value carries no information to restore).
  const srcRows = await fetchSrcFabrics();
  const map = new Map();
  for (const r of srcRows) {
    const code = (r.fabric_code ?? "").trim();
    const sup = (r.supplier_code ?? "").trim();
    if (code && sup && sup.toLowerCase() !== code.toLowerCase()) map.set(code, sup);
  }
  log(`source fabric_trackings: ${srcRows.length} rows; ${map.size} carry a real supplier_code (distinct from fabric_code)`);

  // 2. Dest rows that need a fill: HOUZS-scoped, supplier_code blank/self-ref.
  const destRows = await dst`
    SELECT id, fabric_code, supplier_code
      FROM scm.fabric_trackings
     WHERE company_id = ${cid}
       AND ( supplier_code IS NULL
          OR btrim(supplier_code) = ''
          OR lower(btrim(supplier_code)) = lower(btrim(fabric_code)) )`;
  log(`dest HOUZS fabrics with blank/self-referential supplier_code: ${destRows.length}`);

  const plan = [];
  const unmatched = [];
  for (const d of destRows) {
    const sup = map.get((d.fabric_code ?? "").trim());
    if (sup) plan.push({ id: d.id, code: d.fabric_code, from: d.supplier_code, to: sup });
    else unmatched.push(d.fabric_code);
  }
  log(`matched to a source supplier_code: ${plan.length}`);
  for (const p of plan) log(`  ${p.code}: "${p.from ?? ""}" -> "${p.to}"`);
  if (unmatched.length) log(`no source supplier_code for ${unmatched.length}: ${unmatched.join(", ")}`);

  if (!APPLY) {
    log("");
    log(`DRY-RUN — would set supplier_code on ${plan.length} HOUZS fabric rows. Re-run APPLY=1 to write.`);
    return;
  }

  let n = 0;
  for (const p of plan) {
    await dst`UPDATE scm.fabric_trackings SET supplier_code = ${p.to} WHERE id = ${p.id} AND company_id = ${cid}`;
    n++;
  }
  log("");
  log(`APPLIED — set supplier_code on ${n} HOUZS fabric rows from the 2990 source.`);
}
main()
  .then(() => dst.end())
  .catch(async (e) => {
    console.error("FABRIC_SUPPLIER_CODE_BACKFILL_FAIL", e.message);
    try { await dst.end(); } catch {}
    process.exit(1);
  });
