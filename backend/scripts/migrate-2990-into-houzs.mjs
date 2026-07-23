#!/usr/bin/env node
// Phase 2 — migrate 2990's live data INTO Houzs, tagged company_id=2990.
// SOURCE via Supabase REST (service_role). DEST via postgres.js. Dry-run unless APPLY=1.
// FK checks disabled for the load session so ordering / skipped masters don't block.
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";
const SUPA_URL = process.env.SOURCE_SUPABASE_URL, SUPA_KEY = process.env.SOURCE_SERVICE_ROLE_KEY, DST = process.env.DATABASE_URL;
const APPLY = process.env.APPLY === "1";
if (!SUPA_URL || !SUPA_KEY || !DST) { console.error("need SOURCE_SUPABASE_URL + SOURCE_SERVICE_ROLE_KEY + DATABASE_URL"); process.exit(2); }
const src = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false } });
const dst = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const ORDER = ["staff","customers","suppliers","series","categories","products","product_models","product_fabrics","product_size_variants","warehouses","supplier_material_bindings","venues","mfg_sales_orders","mfg_sales_order_items","mfg_sales_order_payments","delivery_orders","delivery_order_items","sales_invoices","sales_invoice_items","sales_invoice_payments","delivery_returns","delivery_return_items","purchase_orders","purchase_order_items","grns","grn_items","purchase_invoices","purchase_invoice_items","purchase_returns","purchase_return_items","inventory_movements","inventory_lots","inventory_lot_consumptions","pwp_rules","pwp_codes","analysis_customer_targets","drivers","currencies","app_config","delivery_order_payments"];
// `lorries` deliberately NOT imported (owner ruling 2026-07-21): 2990's lorry
// master is not carried over — Houzs fleet is managed on the Houzs side.
// NOT in ORDER: `accounts` (GL) — scm.accounts.account_code is globally UNIQUE (+ FK'd by
// payment_vouchers), so 2990's chart would silently collide with company_1's. Needs a
// per-company constraint decision first. `sofa_personal_quick_picks` needs a shape
// transform (staff_id uuid -> owner_user_id bigint) — handled by the custom pass below.
// Earlier import generations REMAPPED some parent ids on PK collision (see mig 0092),
// so verbatim-id child rows can point at parents that don't exist under company_2.
// GUARD drops such rows instead of inserting dangling garbage (FK checks are off).
const DANGLING_GUARD = { product_size_variants: { parent: "size_library", col: "size_id" }, delivery_order_payments: { parent: "delivery_orders", col: "delivery_order_id" } };
// Post-migration NOT NULL columns the SOURCE doesn't carry — set a safe
// default at INSERT time. mig 0177 added `warehouses.type NOT NULL`; source
// 2990 predates that so its rows have no `type` value and Postgres rejects
// the insert with "null value in column type violates not-null constraint".
// Default to 'warehouse' (the most common bucket); operators can retag via
// the Warehouse Maintenance UI drawer if a row should be showroom/display.
const COLUMN_DEFAULTS = { warehouses: { type: "warehouse" } };
const DOCNO_COL = { mfg_sales_orders:"doc_no", delivery_orders:"do_number", sales_invoices:"invoice_number", purchase_orders:"po_number", grns:"grn_number", purchase_invoices:"invoice_number", delivery_returns:"dr_number", purchase_returns:"pr_number" };
const prefixDoc = (v) => (v == null || String(v).startsWith("2990-") ? v : `2990-${v}`);
// Houzs-only FK columns to null on import (source values point at masters we don't migrate)
const NULL_COLS = { mfg_sales_orders: ["venue_id"], delivery_orders: ["venue_id"] };
// Child tables reference parents by doc-number STRING -> must carry the same 2990- prefix
const PREFIX_REF_COLS = { mfg_sales_order_items: ["doc_no"], mfg_sales_order_payments: ["so_doc_no"], delivery_orders: ["so_doc_no"], inventory_lots: ["source_doc_no"], inventory_movements: ["source_doc_no"], inventory_lot_consumptions: ["source_doc_no"], mfg_sales_orders: ["cross_category_source_doc_no"], pwp_codes: ["source_doc_no","redeemed_doc_no"] };
// Shared masters WITHOUT company_id: import so historical FK refs (salesperson/created_by)
// resolve; forced inactive so they never appear in Houzs pickers.
const NO_CID = { staff: { forceInactive: true } };
async function companyId2990() { const r = await dst`SELECT id FROM companies WHERE code='2990'`; if (!r.length) throw new Error("no 2990 company"); return Number(r[0].id); }
async function fetchAll(table) { const out=[]; const P=1000; for (let f=0;;f+=P){ const {data,error}=await src.schema("public").from(table).select("*").range(f,f+P-1); if(error) throw new Error(error.message); out.push(...(data??[])); if(!data||data.length<P) break; } return out; }
async function destCols(table){ const r=await dst`SELECT column_name FROM information_schema.columns WHERE table_schema='scm' AND table_name=${table}`; return r.map(x=>x.column_name); }
async function main() {
  const cid = await companyId2990();
  console.log(`2990 company_id=${cid} mode=${APPLY?"APPLY":"DRY-RUN"}`);
  if (APPLY) { try { await dst.unsafe("SET session_replication_role = replica"); console.log("FK checks OFF for load"); } catch(e){ console.log("WARN no FK-disable: "+e.message); } }
  let totalSrc=0,totalImp=0;
  for (const table of ORDER) {
    let rows; try { rows=await fetchAll(table); } catch(e){ console.log(`SKIP ${table}: src (${e.message})`); continue; }
    if (rows.length===0){ console.log(`${table}: 0`); continue; }
    let dcols; try { dcols=await destCols(table); } catch(e){ console.log(`SKIP ${table}: dest (${e.message})`); continue; }
    const noCid=NO_CID[table];
    if (!dcols.includes("company_id")&&!noCid){ console.log(`SKIP ${table}: no company_id`); continue; }
    const dset=new Set(dcols), srcCols=Object.keys(rows[0]);
    const shared=srcCols.filter(c=>dset.has(c)&&c!=="company_id"), dropped=srcCols.filter(c=>!dset.has(c));
    totalSrc+=rows.length; const docCol=DOCNO_COL[table];
    const defs=COLUMN_DEFAULTS[table];
    const shaped=rows.map(r=>{ const o=noCid?{}:{company_id:cid}; for(const c of shared)o[c]=r[c]; if(docCol&&o[docCol]!=null)o[docCol]=prefixDoc(o[docCol]); const refs=PREFIX_REF_COLS[table]; if(refs)for(const rc of refs)if(o[rc]!=null)o[rc]=prefixDoc(o[rc]); const nulls=NULL_COLS[table]; if(nulls)for(const nc of nulls)if(nc in o)o[nc]=null; if(defs)for(const[k,v]of Object.entries(defs))if(dset.has(k)&&(o[k]==null))o[k]=v; if(noCid?.forceInactive&&dset.has("active"))o.active=false; return o; });
    console.log(`${table}: ${rows.length}`+(docCol?` (${docCol}->2990-)`:"")+(dropped.length?` [drop:${dropped.join(",")}]`:""));
    let toInsert=shaped;
    const guard=DANGLING_GUARD[table];
    if (guard){ const par=await dst`SELECT id FROM scm.${dst(guard.parent)} WHERE company_id=${cid}`; const ok=new Set(par.map(x=>String(x.id))); toInsert=shaped.filter(r=>r[guard.col]!=null&&ok.has(String(r[guard.col]))); if(toInsert.length!==shaped.length)console.log(`  GUARD dropped ${shaped.length-toInsert.length} rows with ${guard.col} not in company-scoped ${guard.parent} (id-remap era parents)`); if(!toInsert.length)continue; }
    if (APPLY){ const cols=Object.keys(toInsert[0]); let ins=0; for(let i=0;i<toInsert.length;i+=500){ const res=await dst`INSERT INTO scm.${dst(table)} ${dst(toInsert.slice(i,i+500),cols)} ON CONFLICT DO NOTHING`; ins+=res.count??0; }
      if (noCid){ totalImp+=ins; console.log(`  -> ${ins} (shared table, inserted this run)`); }
      else { const got=await dst`SELECT count(*)::int AS n FROM scm.${dst(table)} WHERE company_id=${cid}`; totalImp+=Number(got[0].n); console.log(`  -> ${got[0].n}`); } }
  }
  if (APPLY) { try { await dst.unsafe("SET session_replication_role = DEFAULT"); } catch(e){} }
  // Repair pass (idempotent, FK checks back ON so violations fail loudly):
  // earlier runs imported child rows with UNPREFIXED doc-no refs + venue_id set.
  if (APPLY) {
    console.log("=== repair pass ===");
    for (const [t,c] of [["mfg_sales_order_items","doc_no"],["mfg_sales_order_payments","so_doc_no"],["delivery_orders","so_doc_no"],["inventory_lots","source_doc_no"],["inventory_movements","source_doc_no"],["inventory_lot_consumptions","source_doc_no"],["mfg_sales_orders","cross_category_source_doc_no"],["pwp_codes","source_doc_no"],["pwp_codes","redeemed_doc_no"]]) {
      // regex guard: only prefix values that look like internal doc numbers (SO-/DO-/GRN-/...)
      const r=await dst.unsafe(`UPDATE scm."${t}" SET "${c}"='2990-'||"${c}" WHERE company_id=${cid} AND "${c}" IS NOT NULL AND "${c}" NOT LIKE '2990-%' AND "${c}" ~ '^[A-Z]{2,4}-[0-9]'`);
      console.log(`prefix ${t}.${c}: ${r.count} rows`);
    }
    for (const [t,c] of [["mfg_sales_orders","venue_id"],["delivery_orders","venue_id"]]) {
      const r=await dst.unsafe(`UPDATE scm."${t}" SET "${c}"=NULL WHERE company_id=${cid} AND "${c}" IS NOT NULL`);
      console.log(`null ${t}.${c}: ${r.count} rows`);
    }
  }
  // Custom pass: 2990 `sofa_personal_quick_picks` (staff_id uuid) -> Houzs
  // `scm.personal_quick_picks` (owner_user_id bigint). Resolve owner via
  // scm.staff.user_id (staff ids were imported verbatim; user_id backfilled by mig 0066).
  try {
    const picks = await fetchAll("sofa_personal_quick_picks");
    const live = picks.filter(p => p.deleted_at == null);
    console.log(`sofa_personal_quick_picks: ${picks.length} src (${live.length} live) -> personal_quick_picks`);
    if (live.length && APPLY) {
      let ins = 0, unresolved = 0;
      for (const p of live) {
        const s = await dst`SELECT user_id FROM scm.staff WHERE id=${p.staff_id} AND user_id IS NOT NULL`;
        if (!s.length) { unresolved++; console.log(`  WARN no user_id for staff ${p.staff_id} (pick ${p.id}) — skipped`); continue; }
        const r = await dst`INSERT INTO scm.personal_quick_picks ${dst({ id: p.id, company_id: cid, owner_user_id: Number(s[0].user_id), base_model: p.base_model, label: p.label, modules: p.modules, depth: p.depth, sort_order: p.sort_order, deleted_at: p.deleted_at, created_at: p.created_at, updated_at: p.updated_at })} ON CONFLICT DO NOTHING`;
        ins += r.count ?? 0;
      }
      console.log(`  -> inserted ${ins}${unresolved ? `, ${unresolved} unresolved` : ""}`);
    }
  } catch (e) { console.log(`SKIP personal_quick_picks pass: ${e.message}`); }
  console.log(`RECONCILE source=${totalSrc}`+(APPLY?` imported=${totalImp}`:" (DRY-RUN)"));
}
main().then(()=>dst.end()).catch(async e=>{ console.error("MIGRATE_FAIL",e.message); try{await dst.unsafe("SET session_replication_role = DEFAULT");}catch{} await dst.end(); process.exit(1); });
