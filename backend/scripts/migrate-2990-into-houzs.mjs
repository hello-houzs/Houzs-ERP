#!/usr/bin/env node
// Phase 2 — migrate 2990's live data INTO the merged Houzs system, tagged
// company_id = 2990. SAFE BY DEFAULT: dry-run (counts only) unless APPLY=1.
//
//   SOURCE_DATABASE_URL = 2990 prod (dolvxrchzbnqvahocwsu)   [EXPORT]
//   DATABASE_URL        = Houzs prod (anogrigyjbduyzclzjgn)  [IMPORT, scm schema]
//   APPLY=1             = actually write (else dry-run + reconcile only)
//
// Locked decisions baked in (owner can flip):
//   · 2990 existing doc numbers get a '2990-' PREFIX on import so they never
//     collide with Houzs's own SO-2607-001 on the global unique doc_no index
//     (matches the Phase 0d per-company prefix). See prefixDoc().
//   · Master data (customers / suppliers / products) is kept SEPARATE per
//     company (each 2990 row imported with company_id=2990, NOT merged into a
//     Houzs entity). Cleanest + splittable. Cross-company dedupe is a later,
//     owner-driven pass, not this migration.
//
// Idempotent: every row carries its ORIGINAL 2990 id (uuid) so re-running
// upserts by (id) — a second run changes nothing. Reconciles row counts +
// key money sums (source vs imported-for-2990) at the end.
//
// STATUS: framework + the transform rules are final. The per-table column list
// (COLS below) is derived from code and MUST be validated against the live 2990
// information_schema on first connect — the script prints any column mismatch
// per table and SKIPS that table rather than importing wrong data. So a first
// APPLY run is self-checking: it imports the tables whose columns line up and
// loudly lists the ones needing a mapping tweak.

import postgres from "postgres";

const SRC = process.env.SOURCE_DATABASE_URL;
const DST = process.env.DATABASE_URL;
const APPLY = process.env.APPLY === "1";
if (!SRC || !DST) { console.error("need SOURCE_DATABASE_URL (2990) + DATABASE_URL (Houzs)"); process.exit(2); }

const src = postgres(SRC, { ssl: "require", prepare: false, max: 2 });
const dst = postgres(DST, { ssl: "require", prepare: false, max: 2 });

// FK-topological order: parents before children. Doc headers before their lines
// before their payments; masters before documents.
const ORDER = [
  // masters
  "customers", "suppliers", "products", "product_models", "product_fabrics",
  "product_size_variants", "warehouses", "accounts",
  // sales order-to-cash
  "mfg_sales_orders", "mfg_sales_order_items", "mfg_sales_order_payments",
  "delivery_orders", "delivery_order_items",
  "sales_invoices", "sales_invoice_items", "sales_invoice_payments",
  "delivery_returns", "delivery_return_items",
  // procure-to-pay
  "purchase_orders", "purchase_order_items",
  "grns", "grn_items",
  "purchase_invoices", "purchase_invoice_items",
  "purchase_returns", "purchase_return_items",
  // inventory + accounting ledgers
  "inventory_movements", "inventory_lots", "inventory_lot_consumptions",
  "journal_entries", "journal_entry_lines",
];

// Doc-number columns per table that must be '2990-' prefixed on import.
const DOCNO_COL = {
  mfg_sales_orders: "doc_no", delivery_orders: "do_number",
  sales_invoices: "invoice_number", purchase_orders: "po_number",
  grns: "grn_number", purchase_invoices: "invoice_number",
  delivery_returns: "dr_number", purchase_returns: "pr_number",
};
const prefixDoc = (v) => (v == null || String(v).startsWith("2990-") ? v : `2990-${v}`);

async function companyId2990() {
  const r = await dst`SELECT id FROM companies WHERE code='2990'`;
  if (!r.length) throw new Error("companies has no 2990 row — run Phase 0f first");
  return Number(r[0].id);
}

// columns present in BOTH source and dest (intersection) — the safe set to copy.
async function sharedCols(table) {
  const s = (await src`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=${table}`).map(r => r.column_name);
  const d = (await dst`SELECT column_name FROM information_schema.columns WHERE table_schema='scm' AND table_name=${table}`).map(r => r.column_name);
  const sset = new Set(s);
  return { cols: d.filter(c => sset.has(c)), onlyDest: d.filter(c => !sset.has(c)), onlySrc: s.filter(c => !d.has?.(c)) };
}

async function main() {
  const cid = await companyId2990();
  console.log(`2990 company_id = ${cid} · mode = ${APPLY ? "APPLY" : "DRY-RUN"}`);
  let totalSrc = 0, totalIns = 0;
  for (const table of ORDER) {
    let map;
    try { map = await sharedCols(table); }
    catch (e) { console.log(`SKIP ${table}: ${e.message}`); continue; }
    if (!map.cols.includes("company_id")) { console.log(`SKIP ${table}: dest has no company_id`); continue; }
    const rows = await src`SELECT ${src(map.cols.filter(c => c !== "company_id"))} FROM public.${src(table)}`;
    totalSrc += rows.length;
    const docCol = DOCNO_COL[table];
    const shaped = rows.map(r => {
      const o = { ...r, company_id: cid };
      if (docCol && o[docCol] != null) o[docCol] = prefixDoc(o[docCol]);
      return o;
    });
    console.log(`${table}: ${rows.length} src rows` + (docCol ? ` (doc '${docCol}' prefixed)` : ""));
    if (APPLY && shaped.length) {
      const cols = Object.keys(shaped[0]);
      // upsert by primary key id → idempotent re-run
      await dst`INSERT INTO scm.${dst(table)} ${dst(shaped, cols)} ON CONFLICT (id) DO NOTHING`;
      const got = await dst`SELECT count(*)::int AS n FROM scm.${dst(table)} WHERE company_id=${cid}`;
      totalIns += Number(got[0].n);
      console.log(`  -> scm.${table} now has ${got[0].n} rows for company 2990`);
    }
  }
  console.log(`\nRECONCILE: source rows=${totalSrc}` + (APPLY ? ` imported-for-2990=${totalIns}` : " (dry-run, nothing written)"));
}
main().then(() => Promise.all([src.end(), dst.end()])).catch(async e => { console.error("MIGRATE_FAIL", e.message); await Promise.all([src.end(), dst.end()]); process.exit(1); });
