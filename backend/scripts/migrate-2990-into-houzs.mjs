#!/usr/bin/env node
// Phase 2 — migrate 2990's live data INTO the merged Houzs system, tagged
// company_id = 2990. SAFE BY DEFAULT: dry-run (counts only) unless APPLY=1.
//
// SOURCE is read via the Supabase REST API + service_role key — NO database
// password / reset needed (the db password is separate; resetting it would break
// anything connecting to 2990 directly, so we avoid it entirely).
//   SOURCE_SUPABASE_URL     = https://dolvxrchzbnqvahocwsu.supabase.co
//   SOURCE_SERVICE_ROLE_KEY = 2990 service_role key (Supabase -> Settings -> API)
//   DATABASE_URL            = Houzs prod (import target, scm schema)
//   APPLY=1                 = actually write (else dry-run + reconcile only)
//
// Locked decisions (owner can flip): 2990 doc numbers get a '2990-' PREFIX on
// import (never collide with Houzs's own on the global unique doc_no index);
// master data (customers/suppliers/products) kept SEPARATE per company.
//
// Idempotent: rows keep their ORIGINAL 2990 id, upsert ON CONFLICT (id) DO
// NOTHING — re-run changes nothing. Self-checking: per table it drops any
// source-only columns Houzs's scm doesn't have and logs them, and skips a table
// entirely if scm has no matching table / no company_id, rather than writing
// wrong data. So a first DRY-RUN prints exactly what maps + what needs a tweak.

import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";

const SUPA_URL = process.env.SOURCE_SUPABASE_URL;
const SUPA_KEY = process.env.SOURCE_SERVICE_ROLE_KEY;
const DST = process.env.DATABASE_URL;
const APPLY = process.env.APPLY === "1";
if (!SUPA_URL || !SUPA_KEY || !DST) {
  console.error("need SOURCE_SUPABASE_URL + SOURCE_SERVICE_ROLE_KEY + DATABASE_URL");
  process.exit(2);
}

const src = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false } });
const dst = postgres(DST, { ssl: "require", prepare: false, max: 2 });

// FK-topological order: masters -> headers -> lines -> payments.
const ORDER = [
  "customers", "suppliers", "products", "product_models", "product_fabrics",
  "product_size_variants", "warehouses", "accounts",
  "mfg_sales_orders", "mfg_sales_order_items", "mfg_sales_order_payments",
  "delivery_orders", "delivery_order_items",
  "sales_invoices", "sales_invoice_items", "sales_invoice_payments",
  "delivery_returns", "delivery_return_items",
  "purchase_orders", "purchase_order_items",
  "grns", "grn_items",
  "purchase_invoices", "purchase_invoice_items",
  "purchase_returns", "purchase_return_items",
  "inventory_movements", "inventory_lots", "inventory_lot_consumptions",
  "journal_entries", "journal_entry_lines",
];

const DOCNO_COL = {
  mfg_sales_orders: "doc_no", delivery_orders: "do_number",
  sales_invoices: "invoice_number", purchase_orders: "po_number",
  grns: "grn_number", purchase_invoices: "invoice_number",
  delivery_returns: "dr_number", purchase_returns: "pr_number",
};
const prefixDoc = (v) => (v == null || String(v).startsWith("2990-") ? v : `2990-${v}`);

async function companyId2990() {
  const r = await dst`SELECT id FROM companies WHERE code='2990'`;
  if (!r.length) throw new Error("companies has no 2990 row - run Phase 0f first");
  return Number(r[0].id);
}

// full-table read via PostgREST, 1000/page (PostgREST caps at 1000).
async function fetchAll(table) {
  const out = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await src.schema("public").from(table).select("*").range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

async function destCols(table) {
  const r = await dst`SELECT column_name FROM information_schema.columns WHERE table_schema='scm' AND table_name=${table}`;
  return r.map((x) => x.column_name);
}

async function main() {
  const cid = await companyId2990();
  console.log(`2990 company_id=${cid} · mode=${APPLY ? "APPLY" : "DRY-RUN"}`);
  let totalSrc = 0, totalImported = 0;
  for (const table of ORDER) {
    let rows;
    try { rows = await fetchAll(table); }
    catch (e) { console.log(`SKIP ${table}: source read failed (${e.message})`); continue; }
    if (rows.length === 0) { console.log(`${table}: 0 src rows`); continue; }
    let dcols;
    try { dcols = await destCols(table); }
    catch (e) { console.log(`SKIP ${table}: dest error (${e.message})`); continue; }
    if (!dcols.includes("company_id")) { console.log(`SKIP ${table}: scm.${table} missing / no company_id`); continue; }
    const dset = new Set(dcols);
    const srcCols = Object.keys(rows[0]);
    const shared = srcCols.filter((c) => dset.has(c) && c !== "company_id");
    const dropped = srcCols.filter((c) => !dset.has(c));
    totalSrc += rows.length;
    const docCol = DOCNO_COL[table];
    const shaped = rows.map((r) => {
      const o = { company_id: cid };
      for (const c of shared) o[c] = r[c];
      if (docCol && o[docCol] != null) o[docCol] = prefixDoc(o[docCol]);
      return o;
    });
    console.log(`${table}: ${rows.length} rows` + (docCol ? ` (doc '${docCol}' -> 2990-)` : "") + (dropped.length ? ` [dropped src-only: ${dropped.join(",")}]` : ""));
    if (APPLY) {
      const cols = Object.keys(shaped[0]);
      for (let i = 0; i < shaped.length; i += 500) {
        await dst`INSERT INTO scm.${dst(table)} ${dst(shaped.slice(i, i + 500), cols)} ON CONFLICT (id) DO NOTHING`;
      }
      const got = await dst`SELECT count(*)::int AS n FROM scm.${dst(table)} WHERE company_id=${cid}`;
      totalImported += Number(got[0].n);
      console.log(`  -> scm.${table} now ${got[0].n} rows for 2990`);
    }
  }
  console.log(`\nRECONCILE: source rows=${totalSrc}` + (APPLY ? ` · imported-for-2990=${totalImported}` : " (DRY-RUN, nothing written)"));
}

main().then(() => dst.end()).catch(async (e) => { console.error("MIGRATE_FAIL", e.message); await dst.end(); process.exit(1); });
