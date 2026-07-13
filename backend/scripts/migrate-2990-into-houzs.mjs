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
const ORDER = ["customers","suppliers","series","categories","products","product_models","product_fabrics","product_size_variants","warehouses","venues","mfg_sales_orders","mfg_sales_order_items","mfg_sales_order_payments","delivery_orders","delivery_order_items","sales_invoices","sales_invoice_items","sales_invoice_payments","delivery_returns","delivery_return_items","purchase_orders","purchase_order_items","grns","grn_items","purchase_invoices","purchase_invoice_items","purchase_returns","purchase_return_items","inventory_movements","inventory_lots","inventory_lot_consumptions"];
const DOCNO_COL = { mfg_sales_orders:"doc_no", delivery_orders:"do_number", sales_invoices:"invoice_number", purchase_orders:"po_number", grns:"grn_number", purchase_invoices:"invoice_number", delivery_returns:"dr_number", purchase_returns:"pr_number" };
const prefixDoc = (v) => (v == null || String(v).startsWith("2990-") ? v : `2990-${v}`);
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
    if (!dcols.includes("company_id")){ console.log(`SKIP ${table}: no company_id`); continue; }
    const dset=new Set(dcols), srcCols=Object.keys(rows[0]);
    const shared=srcCols.filter(c=>dset.has(c)&&c!=="company_id"), dropped=srcCols.filter(c=>!dset.has(c));
    totalSrc+=rows.length; const docCol=DOCNO_COL[table];
    const shaped=rows.map(r=>{ const o={company_id:cid}; for(const c of shared)o[c]=r[c]; if(docCol&&o[docCol]!=null)o[docCol]=prefixDoc(o[docCol]); return o; });
    console.log(`${table}: ${rows.length}`+(docCol?` (${docCol}->2990-)`:"")+(dropped.length?` [drop:${dropped.join(",")}]`:""));
    if (APPLY){ const cols=Object.keys(shaped[0]); for(let i=0;i<shaped.length;i+=500){ await dst`INSERT INTO scm.${dst(table)} ${dst(shaped.slice(i,i+500),cols)} ON CONFLICT DO NOTHING`; } const got=await dst`SELECT count(*)::int AS n FROM scm.${dst(table)} WHERE company_id=${cid}`; totalImp+=Number(got[0].n); console.log(`  -> ${got[0].n}`); }
  }
  if (APPLY) { try { await dst.unsafe("SET session_replication_role = DEFAULT"); } catch(e){} }
  console.log(`RECONCILE source=${totalSrc}`+(APPLY?` imported=${totalImp}`:" (DRY-RUN)"));
}
main().then(()=>dst.end()).catch(async e=>{ console.error("MIGRATE_FAIL",e.message); try{await dst.unsafe("SET session_replication_role = DEFAULT");}catch{} await dst.end(); process.exit(1); });
