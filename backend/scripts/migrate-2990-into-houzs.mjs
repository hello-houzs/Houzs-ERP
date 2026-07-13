#!/usr/bin/env node
// Phase 2 — migrate 2990's live data INTO Houzs, tagged company_id=2990.
// SOURCE via Supabase REST (service_role). DEST via postgres.js. Dry-run unless APPLY=1.
//
// v3 (2026-07-13, after staging audit round 1): adds the ID-REMAP engine —
// catalog/config tables whose PKs collide with Houzs's seed rows get
// deterministic new ids (text: 2990- prefix; serial: +100000) and every FK
// reference follows automatically via the dest pg_constraint graph. Doc-number
// REFERENCE columns are auto-detected by name pattern instead of a hand list.
// v2 (2026-07-13, after the 52-table completeness gap): the table list is
// AUTO-DISCOVERED — every dest scm base table that also exists on the source
// with >0 rows is imported, so nothing can be silently left behind again.
// - Tables WITH company_id  -> rows stamped company_id=<2990>, doc numbers and
//   internal doc-no references prefixed "2990-".
// - Tables WITHOUT company_id (shared) -> only those in SHARED_OK import as-is
//   (ON CONFLICT DO NOTHING dedupes reference rows); others are REPORTED and
//   skipped so a human adds them to 0089-style scoping or to SHARED_OK.
// - SKIP: accounts (locked decision: chart of accounts stays shared/Houzs;
//   2990 has 0 journals).
// FK checks disabled for the load session; multi-pass fallback if not allowed.
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";
const SUPA_URL = process.env.SOURCE_SUPABASE_URL, SUPA_KEY = process.env.SOURCE_SERVICE_ROLE_KEY, DST = process.env.DATABASE_URL;
const APPLY = process.env.APPLY === "1";
if (!SUPA_URL || !SUPA_KEY || !DST) { console.error("need SOURCE_SUPABASE_URL + SOURCE_SERVICE_ROLE_KEY + DATABASE_URL"); process.exit(2); }
const src = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false } });
const dst = postgres(DST, { ssl: "require", prepare: false, max: 1 });

// accounts: locked decision (shared chart, 2990 has 0 journals).
// currencies: shared reference by design (reads unscoped, code PK global).
// app_config: key-PK looked up BY KEY in code — cannot hold per-company rows
//   without a schema redesign; 2 source rows reported, deferred.
const SKIP = new Set(["accounts", "currencies", "app_config"]);
// Shared (no company_id) tables allowed to import as-is. staff: legacy 2990
// identities (kept inactive). The rest are per-staff or global reference rows.
const SHARED_OK = new Set(["staff", "my_localities", "pos_carts", "sofa_personal_quick_picks"]);
const FORCE_INACTIVE = new Set(["staff"]);

// ---- ID remap (v3) ----------------------------------------------------------
// Catalog/config tables whose PK values collide with Houzs's existing rows
// (same vendored seed / low serials). Their 2990 rows get NEW deterministic ids
// and every FK reference (discovered from pg_constraint) follows automatically.
// text PK  -> "2990-<id>"           serial PK -> <id> + 100000
// Both transforms are idempotent, so re-runs stay ON CONFLICT-safe. Sequences
// are untouched: these tables hold <100 Houzs rows, serials never reach 100000.
const REMAP_TEXT = new Set(["series", "categories", "size_library", "compartment_library"]);
const REMAP_SERIAL = new Set(["addons", "bundle_library", "delivery_planning_regions", "delivery_fee_config", "fabric_tier_addon_config", "maintenance_config_history", "special_addons_history"]);
const SERIAL_OFFSET = 100000;
const remapId = (table, v) => {
  if (v == null) return v;
  if (REMAP_TEXT.has(table)) return String(v).startsWith("2990-") ? v : `2990-${v}`;
  if (REMAP_SERIAL.has(table)) { const n = Number(v); return n >= SERIAL_OFFSET ? n : n + SERIAL_OFFSET; }
  return v;
};
// Load these first (identity/master roots), then everything else alphabetically,
// then documents/movements last. With FK checks off order barely matters; this
// just keeps logs readable and helps the FK-on fallback converge fast.
const EARLY = ["staff", "companies", "customers", "suppliers", "series", "categories", "venues", "warehouses", "fabrics", "fabric_library", "fabric_colours", "bedframe_colours", "bedframe_options", "size_library", "compartment_library", "products", "mfg_products", "product_models", "product_fabrics", "product_size_variants", "supplier_material_bindings"];
const LATE = ["mfg_sales_orders", "mfg_sales_order_items", "mfg_sales_order_payments", "so_amendments", "so_amendment_lines", "so_revisions", "delivery_orders", "delivery_order_items", "sales_invoices", "sales_invoice_items", "sales_invoice_payments", "delivery_returns", "delivery_return_items", "purchase_orders", "purchase_order_items", "grns", "grn_items", "purchase_invoices", "purchase_invoice_items", "purchase_returns", "purchase_return_items", "inventory_movements", "inventory_lots", "inventory_lot_consumptions", "mfg_so_audit_log", "mfg_so_status_changes"];

const DOCNO_COL = { mfg_sales_orders: "doc_no", delivery_orders: "do_number", sales_invoices: "invoice_number", purchase_orders: "po_number", grns: "grn_number", purchase_invoices: "invoice_number", delivery_returns: "dr_number", purchase_returns: "pr_number", purchase_consignment_orders: "pc_number", purchase_consignment_receives: "receive_number", purchase_consignment_returns: "return_number" };
const prefixDoc = (v) => (v == null || String(v).startsWith("2990-") ? v : `2990-${v}`);
// Doc-number REFERENCE columns are auto-detected by name (any text column named
// like a doc ref, on any table) and prefixed only when the value looks like an
// internal doc number. Kills the "forgot a column" class (v2 missed so_doc_no
// on the audit log, pwp_codes source/redeemed, so_revisions).
const DOC_REF_NAME = /(^|_)(so_doc_no|doc_no|source_doc_no|redeemed_doc_no|cross_category_source_doc_no)$/;
const looksLikeDocNo = (v) => typeof v === "string" && /^[A-Z]{2,4}-[0-9]/.test(v);

async function companyId2990() { const r = await dst`SELECT id FROM companies WHERE code='2990'`; if (!r.length) throw new Error("no 2990 company"); return Number(r[0].id); }
async function fetchAll(table) { const out = []; const P = 1000; for (let f = 0; ; f += P) { const { data, error } = await src.schema("public").from(table).select("*").range(f, f + P - 1); if (error) throw new Error(error.message); out.push(...(data ?? [])); if (!data || data.length < P) break; } return out; }
async function destCols(table) { const r = await dst`SELECT column_name FROM information_schema.columns WHERE table_schema='scm' AND table_name=${table}`; return r.map(x => x.column_name); }

async function discoverTables() {
  const destTabs = await dst`SELECT t.table_name FROM information_schema.tables t WHERE t.table_schema='scm' AND t.table_type='BASE TABLE' ORDER BY t.table_name`;
  const names = destTabs.map(r => r.table_name).filter(t => !SKIP.has(t));
  const withRows = [];
  for (const t of names) {
    const { count, error } = await src.schema("public").from(t).select("*", { count: "exact", head: true });
    if (error || !count) continue;
    withRows.push(t);
  }
  const rank = (t) => { const e = EARLY.indexOf(t); if (e >= 0) return e; const l = LATE.indexOf(t); if (l >= 0) return 10000 + l; return 1000; };
  withRows.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return withRows;
}

// FK graph from the DEST schema: childTable -> [{col, parent}] for single-col
// FKs whose parent is a remapped table. Used to remap referencing values.
async function remapRefCols() {
  const fks = await dst`
    SELECT cl.relname AS child, a.attname AS col, fcl.relname AS parent
    FROM pg_constraint c
    JOIN pg_class cl ON cl.oid=c.conrelid
    JOIN pg_namespace n ON n.oid=cl.relnamespace
    JOIN pg_class fcl ON fcl.oid=c.confrelid
    JOIN pg_namespace fn ON fn.oid=fcl.relnamespace
    CROSS JOIN LATERAL unnest(c.conkey) k(attnum)
    JOIN pg_attribute a ON a.attrelid=cl.oid AND a.attnum=k.attnum
    WHERE c.contype='f' AND n.nspname='scm' AND fn.nspname='scm' AND array_length(c.conkey,1)=1`;
  const map = {};
  for (const f of fks) {
    if (!REMAP_TEXT.has(f.parent) && !REMAP_SERIAL.has(f.parent)) continue;
    (map[f.child] ??= []).push({ col: f.col, parent: f.parent });
  }
  return map;
}

async function main() {
  const cid = await companyId2990();
  console.log(`2990 company_id=${cid} mode=${APPLY ? "APPLY" : "DRY-RUN"}`);
  const tables = await discoverTables();
  const refMap = await remapRefCols();
  console.log(`discovered ${tables.length} source tables with rows; remap-following FK cols: ${Object.entries(refMap).map(([t, cs]) => `${t}(${cs.map(x => x.col).join("+")})`).join(", ") || "none"}`);
  let fkOff = false;
  if (APPLY) { try { await dst.unsafe("SET session_replication_role = replica"); fkOff = true; console.log("FK checks OFF for load"); } catch (e) { console.log("WARN no FK-disable: " + e.message); } }

  let totalSrc = 0, totalImp = 0;
  const skippedShared = [];
  const pending = []; // FK-on fallback queue

  for (const table of tables) {
    let rows; try { rows = await fetchAll(table); } catch (e) { console.log(`SKIP ${table}: src (${e.message})`); continue; }
    if (!rows.length) continue;
    let dcols; try { dcols = await destCols(table); } catch (e) { console.log(`SKIP ${table}: dest (${e.message})`); continue; }
    const dset = new Set(dcols);
    const scoped = dset.has("company_id");
    if (!scoped && !SHARED_OK.has(table)) { skippedShared.push(`${table}(${rows.length})`); continue; }
    const srcCols = Object.keys(rows[0]);
    const shared = srcCols.filter(c => dset.has(c) && c !== "company_id");
    const dropped = srcCols.filter(c => !dset.has(c));
    totalSrc += rows.length;
    const docCol = DOCNO_COL[table];
    const docRefCols = shared.filter(c => DOC_REF_NAME.test(c) && c !== docCol);
    const fkRemaps = refMap[table] ?? [];
    const selfRemap = REMAP_TEXT.has(table) || REMAP_SERIAL.has(table);
    const shaped = rows.map(r => {
      const o = scoped ? { company_id: cid } : {};
      for (const c of shared) o[c] = r[c];
      if (selfRemap && "id" in o) o.id = remapId(table, o.id);
      for (const { col, parent } of fkRemaps) if (o[col] != null) o[col] = remapId(parent, o[col]);
      if (docCol && o[docCol] != null) o[docCol] = prefixDoc(o[docCol]);
      for (const rc of docRefCols) if (o[rc] != null && looksLikeDocNo(o[rc])) o[rc] = prefixDoc(o[rc]);
      if (FORCE_INACTIVE.has(table) && dset.has("active")) o.active = false;
      return o;
    });
    console.log(`${table}: ${rows.length}${docCol ? ` (${docCol}->2990-)` : ""}${selfRemap ? " [id-remap]" : ""}${fkRemaps.length ? ` [fk-remap:${fkRemaps.map(f => f.col).join("+")}]` : ""}${docRefCols.length ? ` [docref:${docRefCols.join("+")}]` : ""}${dropped.length ? ` [drop:${dropped.join(",")}]` : ""}${scoped ? "" : " [shared]"}`);
    if (!APPLY) continue;
    try {
      const cols = Object.keys(shaped[0]);
      let ins = 0;
      for (let i = 0; i < shaped.length; i += 500) { const res = await dst`INSERT INTO scm.${dst(table)} ${dst(shaped.slice(i, i + 500), cols)} ON CONFLICT DO NOTHING`; ins += res.count ?? 0; }
      if (scoped) { const got = await dst`SELECT count(*)::int AS n FROM scm.${dst(table)} WHERE company_id=${cid}`; totalImp += Number(got[0].n); console.log(`  -> ${got[0].n}`); }
      else { totalImp += ins; console.log(`  -> ${ins} (shared, inserted this run)`); }
    } catch (e) {
      if (fkOff) throw e;
      pending.push({ table, shaped, scoped });
      console.log(`  deferred (FK): ${e.message.slice(0, 120)}`);
    }
  }

  // FK-on fallback: retry deferred tables until stable.
  for (let pass = 1; pass <= 8 && pending.length; pass++) {
    let progress = false;
    for (let i = pending.length - 1; i >= 0; i--) {
      const { table, shaped, scoped } = pending[i];
      try {
        const cols = Object.keys(shaped[0]);
        let ins = 0;
        for (let j = 0; j < shaped.length; j += 500) { const res = await dst`INSERT INTO scm.${dst(table)} ${dst(shaped.slice(j, j + 500), cols)} ON CONFLICT DO NOTHING`; ins += res.count ?? 0; }
        console.log(`retry ${table}: ok (${ins})`); totalImp += ins; pending.splice(i, 1); progress = true;
      } catch { /* next pass */ }
    }
    if (!progress) break;
  }
  if (pending.length) console.log(`UNRESOLVED_FK_TABLES: ${pending.map(p => p.table).join(",")}`);

  if (APPLY && fkOff) { try { await dst.unsafe("SET session_replication_role = DEFAULT"); } catch (e) { } }

  // Repair pass (idempotent, FK checks back ON): re-prefix any rows imported by
  // older runs with unprefixed doc-no refs.
  if (APPLY) {
    console.log("=== repair pass ===");
    const fixes = [["mfg_sales_order_items", "doc_no"], ["mfg_sales_order_payments", "so_doc_no"], ["delivery_orders", "so_doc_no"], ["inventory_lots", "source_doc_no"], ["inventory_movements", "source_doc_no"], ["inventory_lot_consumptions", "source_doc_no"], ["mfg_sales_orders", "cross_category_source_doc_no"]];
    for (const [t, c] of fixes) {
      try { const r = await dst.unsafe(`UPDATE scm."${t}" SET "${c}"='2990-'||"${c}" WHERE company_id=${cid} AND "${c}" IS NOT NULL AND "${c}" NOT LIKE '2990-%' AND "${c}" ~ '^[A-Z]{2,4}-[0-9]'`); console.log(`prefix ${t}.${c}: ${r.count} rows`); }
      catch (e) { console.log(`repair skip ${t}.${c}: ${e.message.slice(0, 100)}`); }
    }
  }

  if (skippedShared.length) console.log(`UNSCOPED_SHARED_SKIPPED (need 0089 scoping or SHARED_OK): ${skippedShared.join(", ")}`);
  console.log(`RECONCILE source=${totalSrc}` + (APPLY ? ` imported=${totalImp}` : " (DRY-RUN)"));
  if (APPLY && pending.length) process.exit(1);
}
main().then(() => dst.end()).catch(async e => { console.error("MIGRATE_FAIL", e.message); try { await dst.unsafe("SET session_replication_role = DEFAULT"); } catch { } await dst.end(); process.exit(1); });
