#!/usr/bin/env node
// Deep field-level parity diagnostic between 2990 (SOURCE Supabase) and
// Houzs company_id=2 (DEST). Read-only.
//
// Owner's question 2026-07-23: "what's on the 2990 backend that isn't yet
// on Houzs, BEYOND just missing UUIDs?" diag-2990-gaps.mjs already covers
// UUID / natural-key PRESENCE. This one extends the check to CONTENT
// FRESHNESS — a row can be present under the same UUID but hold a value
// the importer captured months ago and never refreshed. That is a STALE
// COPY, and this script surfaces it.
//
// Approach:
//   1. Enumerate scm tables on dest (information_schema).
//   2. Probe each on src (Supabase select limit 0). Keep the intersection.
//   3. For every shared table:
//        - fetch ALL src rows (paginated in 1000-row chunks by Supabase)
//        - fetch dest rows scoped to company_id=2 (or globally when the
//          table has no company_id — shared masters like staff/currencies)
//        - for each src row, find its dest counterpart:
//            id match first (the importer copies UUIDs verbatim, see
//            migrate-2990-into-houzs.mjs line ~67);
//            natural-key fallback if the table has one (code / do_number /
//            grn_number / etc. — same list as diag-2990-gaps.mjs); doc-no
//            columns carry a "2990-" prefix on dest, so we prefix before
//            looking up.
//        - no match anywhere → MISSING
//        - matched → diff every shared column (ignoring id / company_id /
//          created_at / updated_at + a few importer-imposed rewrites) —
//          any diff → STALE, capture the first N column names as sample.
//   4. Print per-table one-liners and a SUMMARY block with the top-5
//      staleness offenders.
//
// Rules-of-the-road (per CLAUDE.md):
//   read-only  •  no writes  •  no DDL  •  no transaction  •
//   manual trigger only  •  exit 0 for every legitimate answer  •
//   never insert marker rows.
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";

const SUPA_URL = process.env.SOURCE_SUPABASE_URL;
const SUPA_KEY = process.env.SOURCE_SERVICE_ROLE_KEY;
const DST = process.env.DATABASE_URL;
if (!SUPA_URL || !SUPA_KEY || !DST) {
  console.error("need SOURCE_SUPABASE_URL + SOURCE_SERVICE_ROLE_KEY + DATABASE_URL");
  process.exit(2);
}

const src = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false } });
const dst = postgres(DST, { ssl: "require", prepare: false, max: 1 });

const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

// Natural-key column per table. Mirrors diag-2990-gaps.mjs GAP_TABLES natKey
// entries AND adds the doc-no keys the importer prefixes on the way in
// (DOCNO_COL in migrate-2990-into-houzs.mjs). isDocNo = dest carries the
// "2990-" prefix, so we prepend before natkey lookup.
const NATKEY = {
  mfg_products:      { col: "code",           isDocNo: false },
  product_models:    { col: "code",           isDocNo: false },
  suppliers:         { col: "code",           isDocNo: false },
  delivery_orders:   { col: "do_number",      isDocNo: true },
  grns:              { col: "grn_number",     isDocNo: true },
  currencies:        { col: "code",           isDocNo: false },
  sync_config:       { col: "key",            isDocNo: false },
  mfg_sales_orders:  { col: "doc_no",         isDocNo: true },
  sales_invoices:    { col: "invoice_number", isDocNo: true },
  purchase_orders:   { col: "po_number",      isDocNo: true },
  purchase_invoices: { col: "invoice_number", isDocNo: true },
  delivery_returns:  { col: "dr_number",      isDocNo: true },
  purchase_returns:  { col: "pr_number",      isDocNo: true },
};

// Columns whose DEST value carries the "2990-" prefix — either the primary
// doc-no on the table (DOCNO_COL from importer) or a reference to another
// doc-no table (PREFIX_REF_COLS). Strip the prefix on dest before compare
// so the importer's transform doesn't register as staleness.
const DOCNO_COL = {
  mfg_sales_orders:  "doc_no",
  delivery_orders:   "do_number",
  sales_invoices:    "invoice_number",
  purchase_orders:   "po_number",
  grns:              "grn_number",
  purchase_invoices: "invoice_number",
  delivery_returns:  "dr_number",
  purchase_returns:  "pr_number",
};
const PREFIX_REF_COLS = {
  mfg_sales_order_items:      ["doc_no"],
  mfg_sales_order_payments:   ["so_doc_no"],
  delivery_orders:            ["so_doc_no"],
  inventory_lots:             ["source_doc_no"],
  inventory_movements:        ["source_doc_no"],
  inventory_lot_consumptions: ["source_doc_no"],
  mfg_sales_orders:           ["cross_category_source_doc_no"],
  pwp_codes:                  ["source_doc_no", "redeemed_doc_no"],
};

// Per-table columns the importer intentionally rewrites, so a diff is
// EXPECTED and not staleness. See migrate-2990-into-houzs.mjs:
//   staff.active     — forceInactive (NO_CID rule)
//   *.venue_id       — NULL_COLS (Houzs-only master, nulled on import)
//   warehouses.type  — COLUMN_DEFAULTS ('warehouse' when src has null)
const PER_TABLE_IGNORE = {
  staff:            new Set(["active"]),
  mfg_sales_orders: new Set(["venue_id"]),
  delivery_orders:  new Set(["venue_id"]),
  warehouses:       new Set(["type"]),
};

// Always ignored: identity + timestamps that get bumped by dest triggers.
const BASE_IGNORE = new Set(["id", "company_id", "created_at", "updated_at"]);

// Tables the importer deliberately never touches (owner rulings): they
// will show up as fully-missing here; called out separately at the bottom
// so the number is expected rather than alarming.
const DEFERRED_TABLES = new Set(["accounts", "lorries"]);

const SAMPLE_ROW_CAP = 20;
const SAMPLE_COL_CAP = 3;
const PROBE_BATCH = 10;

function prefixCols(table) {
  const s = new Set(PREFIX_REF_COLS[table] || []);
  if (DOCNO_COL[table]) s.add(DOCNO_COL[table]);
  return s;
}

function stripPrefix(v) {
  return typeof v === "string" && v.startsWith("2990-") ? v.slice(5) : v;
}

// Stable JSON stringify so { a:1, b:2 } and { b:2, a:1 } compare equal
// (jsonb round-trips can reorder keys).
function stableStringify(v) {
  if (v == null) return "null";
  if (typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}

// postgres.js returns Date for timestamps, native objects for jsonb, JS
// numbers for numeric/int. Supabase REST returns ISO strings for
// timestamps and JS objects for jsonb. Normalize both to a canonical
// string so looseEq can string-compare.
function norm(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") return stableStringify(v);
  if (typeof v === "string") {
    if (/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(v)) {
      const d = new Date(v);
      if (!isNaN(d.getTime())) return d.toISOString();
    }
    return v;
  }
  return String(v);
}

// null ~ '' for text, numeric-string ~ number, dates by instant, everything
// else strict-after-normalize. Anything short of "the underlying value" is
// treated as equal — the goal is to catch REAL staleness, not printf drift.
function looseEq(a, b) {
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return true;
  if ((na === null && nb === "") || (nb === null && na === "")) return true;
  if (na != null && nb != null) {
    const fa = Number(na);
    const fb = Number(nb);
    if (!Number.isNaN(fa) && !Number.isNaN(fb) && fa === fb) return true;
  }
  return false;
}

async function fetchAllSrc(table) {
  const out = [];
  const P = 1000;
  for (let f = 0; ; f += P) {
    const { data, error } = await src.schema("public").from(table).select("*").range(f, f + P - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < P) break;
  }
  return out;
}

async function destColSet(table) {
  const r = await dst`SELECT column_name FROM information_schema.columns WHERE table_schema='scm' AND table_name=${table}`;
  return new Set(r.map((x) => x.column_name));
}

async function listDestTables() {
  const r = await dst`SELECT table_name FROM information_schema.tables WHERE table_schema='scm' AND table_type='BASE TABLE' ORDER BY table_name`;
  return r.map((x) => x.table_name);
}

async function srcHasTable(table) {
  try {
    const { error } = await src.schema("public").from(table).select("*").limit(0);
    return !error;
  } catch { return false; }
}

async function main() {
  const cidRow = await dst`SELECT id FROM companies WHERE code='2990'`;
  if (!cidRow.length) throw new Error("no 2990 company");
  const cid = Number(cidRow[0].id);
  notice(`2990 company_id=${cid}  mode=READ-ONLY  scope=field-level parity`);
  notice("");

  const destTables = await listDestTables();
  notice(`scm tables on dest: ${destTables.length}`);

  const shared = [];
  const destOnly = [];
  for (let i = 0; i < destTables.length; i += PROBE_BATCH) {
    const chunk = destTables.slice(i, i + PROBE_BATCH);
    const results = await Promise.all(chunk.map(async (t) => [t, await srcHasTable(t)]));
    for (const [t, ok] of results) (ok ? shared : destOnly).push(t);
  }
  notice(`tables present on BOTH sides: ${shared.length}  (${destOnly.length} dest-only, not compared)`);
  notice("");

  let grandMissing = 0;
  let grandStale = 0;
  const staleByTable = [];
  const deferredLines = [];

  for (const table of shared) {
    let dcols;
    try { dcols = await destColSet(table); }
    catch (e) { notice(`${table}: dest col fetch failed (${e.message}), skipped`); continue; }
    if (!dcols.has("id")) { notice(`${table}: no id column on dest, skipped`); continue; }

    const scoped = dcols.has("company_id");

    let srcRows;
    try { srcRows = await fetchAllSrc(table); }
    catch (e) { notice(`${table}: SRC fetch failed (${e.message}), skipped`); continue; }
    if (srcRows.length === 0) { notice(`${table}: source empty`); continue; }

    let destRows;
    try {
      destRows = scoped
        ? await dst`SELECT * FROM scm.${dst(table)} WHERE company_id=${cid}`
        : await dst`SELECT * FROM scm.${dst(table)}`;
    } catch (e) {
      notice(`${table}: DEST fetch failed (${e.message}), skipped`);
      continue;
    }

    const byId = new Map();
    for (const r of destRows) byId.set(String(r.id), r);
    const nk = NATKEY[table];
    const byNk = new Map();
    if (nk && dcols.has(nk.col)) {
      for (const r of destRows) {
        const v = r[nk.col];
        if (v == null) continue;
        byNk.set(String(v), r);
      }
    }

    const ignoreCols = new Set(BASE_IGNORE);
    for (const c of PER_TABLE_IGNORE[table] || []) ignoreCols.add(c);
    const stripCols = prefixCols(table);
    const srcCols = Object.keys(srcRows[0]);
    const compareCols = srcCols.filter((c) => dcols.has(c) && !ignoreCols.has(c));

    let missing = 0;
    let stale = 0;
    const samples = [];

    for (const sr of srcRows) {
      let dr = byId.get(String(sr.id));
      let via = "id";
      if (!dr && nk && sr[nk.col] != null) {
        const raw = String(sr[nk.col]);
        const key = nk.isDocNo && !raw.startsWith("2990-") ? `2990-${raw}` : raw;
        dr = byNk.get(key);
        if (dr) via = "natkey";
      }
      if (!dr) { missing++; continue; }

      const diffCols = [];
      for (const c of compareCols) {
        const sv = sr[c];
        let dv = dr[c];
        if (stripCols.has(c)) dv = stripPrefix(dv);
        if (!looseEq(sv, dv)) diffCols.push(c);
      }
      if (diffCols.length === 0) continue;
      stale++;
      if (samples.length < SAMPLE_ROW_CAP) {
        const ident = nk && sr[nk.col] != null ? `${nk.col}=${sr[nk.col]}` : `id=${sr.id}`;
        const shown = diffCols.slice(0, SAMPLE_COL_CAP).join(",");
        const more = diffCols.length > SAMPLE_COL_CAP ? `+${diffCols.length - SAMPLE_COL_CAP}` : "";
        samples.push(`{${via}:${ident} cols=${shown}${more}}`);
      }
    }

    const sampleStr = samples.length ? ` SAMPLES=[${samples.join(", ")}]` : "";
    const line = `${table}: SRC=${srcRows.length} MISSING=${missing} STALE=${stale}${sampleStr}`;
    if (DEFERRED_TABLES.has(table)) {
      deferredLines.push(line);
    } else {
      notice(line);
    }
    grandMissing += missing;
    grandStale += stale;
    if (stale > 0) staleByTable.push({ table, stale });
  }

  notice("");
  notice(`=== SUMMARY ===`);
  notice(`Total src rows MISSING on dest (no id or natkey match): ${grandMissing}`);
  notice(`Total src rows STALE on dest (matched but content differs): ${grandStale}`);
  staleByTable.sort((a, b) => b.stale - a.stale);
  const top5 = staleByTable.slice(0, 5);
  if (top5.length) {
    notice(`Top-5 tables by STALE count:`);
    for (const { table, stale } of top5) notice(`  ${table}: ${stale}`);
  } else {
    notice(`No stale rows detected in any shared table.`);
  }
  if (deferredLines.length) {
    notice(``);
    notice(`Deliberately-excluded tables (importer never touches these per owner ruling — expect MISSING = full src count):`);
    for (const l of deferredLines) notice(`  ${l}`);
  }
  notice(``);
  notice(`Notes:`);
  notice(` * MISSING = src row has no id match on dest AND no natural-key match either.`);
  notice(` * STALE   = a dest row exists (by id or natkey) but at least one shared column differs.`);
  notice(` * Ignored per row: id / company_id / created_at / updated_at, plus columns the`);
  notice(`   importer intentionally rewrites (staff.active, mfg_sales_orders.venue_id,`);
  notice(`   delivery_orders.venue_id, warehouses.type).`);
  notice(` * Doc-no columns are un-prefixed on dest before compare so the importer's`);
  notice(`   "2990-" prefix does not register as staleness.`);
  notice(` * Sample cap: ${SAMPLE_ROW_CAP} rows/table, ${SAMPLE_COL_CAP} columns/row.`);
  notice(` * "drivers" is included in the importer ORDER list — if it appears here as`);
  notice(`   MISSING it is a real gap, not an owner exclusion.`);
}

main()
  .then(() => dst.end())
  .catch(async (e) => {
    console.error("DEEP_PARITY_FAIL", e.message);
    try { await dst.end(); } catch {}
    process.exit(1);
  });
