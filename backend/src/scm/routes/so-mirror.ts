// ----------------------------------------------------------------------------
// /so-mirror — LIVE receiver for 2990 → Houzs one-way SO mirror.
//
// The 2990 database (via pg_cron + pg_net) POSTs each changed SO here as
// { docNo, header, items, payments } (raw 2990-shaped rows) or { docNo,
// deleted:true }. We apply the SAME transform as the batch importer
// (migrate-2990-into-houzs.mjs) — 2990- doc-no prefix, deterministic uuid /
// integer id remap, company_id=2, created_by→staff kept as-is (shared) — then
// idempotently UPSERT by doc_no. Retried deliveries never duplicate.
//
// AUTH: a static shared secret (x-sync-secret == env.SYNC_SECRET), because the
// caller is a database (pg_net), not a user with a Supabase JWT. Service-only.
//
// Mounted at '/so-mirror' in scm/index.ts.
// ----------------------------------------------------------------------------
import { Hono } from 'hono';
import type { Env } from '../../types';

export const soMirror = new Hono<{ Bindings: Env }>();

const C2990 = 2;

// --- transform primitives — byte-for-byte the batch import's rules -----------
// (scripts/migrate-2990-into-houzs.mjs). CRITICAL: the batch import copies every
// master/self id AS-IS (original 2990 uuid/serial) — it does NOT remap them; it
// only (a) stamps company_id=2, (b) prefixes doc-NUMBER columns with `2990-`,
// (c) nulls venue_id (points at a master not migrated), (d) drops source columns
// absent in the Houzs dest table. The old mirror remapped FK/self ids (uuid ->
// '2990'+slice, serial +100000), which matched NO imported row → FK violation →
// 500. This transform now mirrors the import EXACTLY so mirrored rows and batch-
// imported rows are interchangeable.
function prefixDoc(v: unknown): unknown {
  return v == null || String(v).startsWith('2990-') ? v : `2990-${v}`;
}

// Explicit per-table column rules, matching migrate-2990-into-houzs.mjs's
// DOCNO_COL + PREFIX_REF_COLS + NULL_COLS. so-mirror only handles the SO trio.
const PREFIX_COLS: Record<string, string[]> = {
  // header doc_no (PK) + the cross-category source doc ref
  mfg_sales_orders: ['doc_no', 'cross_category_source_doc_no'],
  mfg_sales_order_items: ['doc_no'],
  mfg_sales_order_payments: ['so_doc_no'],
};
const NULL_COLS: Record<string, string[]> = {
  // venue_id points at scm.venues, which the import nulls on load (source value
  // references a master row that isn't reconciled across companies).
  mfg_sales_orders: ['venue_id'],
};
// Status normalization guard (insurance). The canonical STORED SO status set is
// {DRAFT, CONFIRMED, CANCELLED}; every richer state (Ready/Delivered/Invoiced…)
// is DERIVED server-side from shared code. 2990 is the progenitor of this same
// schema so its statuses should already match — but if the legacy system ever
// emits a lowercase or alien value, a raw pass-through would make mirrored rows
// invisible to the status-count/filter buckets and render an empty progress bar.
// Coerce any non-canonical inbound status to the nearest canonical value so a
// company-2 row can never carry a vocabulary Houzs code doesn't understand.
const NORMALIZE_STATUS_COLS: Record<string, string[]> = {
  mfg_sales_orders: ['status'],
};
const CANON_SO_STATUS = new Set(['DRAFT', 'CONFIRMED', 'CANCELLED']);
function normalizeStatus(v: unknown): unknown {
  if (v == null) return v;
  const s = String(v).trim().toUpperCase();
  return CANON_SO_STATUS.has(s) ? s : 'CONFIRMED';
}

// --- dest-column map, cached per isolate -------------------------------------
type TableMap = { prefixCols: Set<string>; nullCols: Set<string>; destCols: Set<string>; arrayCols: Set<string>; statusCols: Set<string> };
const mapCache = new Map<string, TableMap>();

async function tableMap(DB: Env['DB'], table: string): Promise<TableMap> {
  const cached = mapCache.get(table);
  if (cached) return cached;

  // Destination columns — used to DROP any 2990-only source column so an INSERT
  // can't 500 on an unknown column (schema drift between the two ERPs). data_type
  // also flags Postgres array columns (see arrayCols below).
  const dc = await DB.prepare(
    `SELECT column_name AS col, data_type AS dtype FROM information_schema.columns
      WHERE table_schema='scm' AND table_name=?`,
  ).bind(table).all<{ col: string; dtype: string }>();

  const rows = dc.results ?? [];
  const m: TableMap = {
    prefixCols: new Set(PREFIX_COLS[table] ?? []),
    nullCols: new Set(NULL_COLS[table] ?? []),
    statusCols: new Set(NORMALIZE_STATUS_COLS[table] ?? []),
    destCols: new Set(rows.map((r: { col: string }) => r.col)),
    // Postgres array-typed dest columns (e.g. mfg_sales_order_items.photo_urls
    // text[]). The D1-shim coerces a bound JS array by stringification, turning an
    // empty array [] into "" — which Postgres rejects as a malformed array literal
    // ("malformed array literal: \"\""). These must be formatted as explicit
    // Postgres array literals before binding (see toPgArray). NOTE: this is keyed
    // on data_type='ARRAY' only, so jsonb columns that happen to hold a JSON array
    // are left untouched (bound as JSON, not corrupted into a pg array literal).
    arrayCols: new Set(rows.filter((r: { dtype: string }) => r.dtype === 'ARRAY').map((r: { col: string }) => r.col)),
  };
  mapCache.set(table, m);
  return m;
}

// Format a JS array as a Postgres array literal: '{}' for empty, '{"a","b"}'
// otherwise. Elements are double-quoted with " and \ escaped so any text value
// is safe. Used only for genuine array-typed columns (m.arrayCols).
function toPgArray(v: unknown[]): string {
  return `{${v.map((x) => (x == null ? 'NULL' : `"${String(x).replace(/(["\\])/g, '\\$1')}"`)).join(',')}}`;
}

function applyMap(row: Record<string, unknown>, m: TableMap): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // Keep only columns that exist in the Houzs dest table (drop 2990-only cols).
  // Array-typed dest columns get an explicit Postgres array literal (see toPgArray).
  for (const [k, v] of Object.entries(row)) {
    if (m.destCols.has(k)) out[k] = m.arrayCols.has(k) && Array.isArray(v) ? toPgArray(v) : v;
  }
  // Stamp the 2990 company (dest always carries company_id for these tables).
  out.company_id = C2990;
  // Prefix doc-number columns; ids/FKs pass through UNCHANGED (match the import).
  for (const col of m.prefixCols) if (out[col] != null) out[col] = prefixDoc(out[col]);
  // Null columns the import nulls (e.g. venue_id) when present in dest.
  for (const col of m.nullCols) if (col in out) out[col] = null;
  // Coerce status columns to the canonical {DRAFT,CONFIRMED,CANCELLED} set.
  for (const col of m.statusCols) if (col in out) out[col] = normalizeStatus(out[col]);
  return out;
}

async function upsert(DB: Env['DB'], table: string, row: Record<string, unknown>, conflict: string) {
  const cols = Object.keys(row);
  const set = cols.filter((c) => !conflict.split(',').map((s) => s.trim()).includes(c))
    .map((c) => `"${c}"=EXCLUDED."${c}"`).join(', ');
  const sql = `INSERT INTO scm."${table}" (${cols.map((c) => `"${c}"`).join(',')})
    VALUES (${cols.map(() => '?').join(',')})
    ON CONFLICT (${conflict}) DO UPDATE SET ${set}`;
  await DB.prepare(sql).bind(...cols.map((k) => row[k])).run();
}

soMirror.post('/', async (c) => {
  if (c.req.header('x-sync-secret') !== c.env.SYNC_SECRET || !c.env.SYNC_SECRET) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  let body: { docNo?: string; deleted?: boolean; header?: Record<string, unknown>; items?: Record<string, unknown>[]; payments?: Record<string, unknown>[] };
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const rawDoc = String(body.docNo ?? body.header?.doc_no ?? '').trim();
  if (!rawDoc) return c.json({ error: 'doc_no_required' }, 400);
  const doc = String(prefixDoc(rawDoc));
  const DB = c.env.DB;

  try {
    // DELETE: SO removed in 2990 → drop the mirror (children cascade on doc_no FK)
    if (body.deleted) {
      await DB.prepare(`DELETE FROM scm."mfg_sales_orders" WHERE company_id=? AND doc_no=?`).bind(C2990, doc).run();
      return c.json({ ok: true, docNo: doc, action: 'deleted' });
    }
    if (!body.header) return c.json({ error: 'header_required' }, 400);

    const hMap = await tableMap(DB, 'mfg_sales_orders');
    const iMap = await tableMap(DB, 'mfg_sales_order_items');
    const pMap = await tableMap(DB, 'mfg_sales_order_payments');

    // header — upsert by doc_no (PK; 2990- prefix keeps it globally unique)
    await upsert(DB, 'mfg_sales_orders', applyMap(body.header, hMap), 'doc_no');

    // items / payments — replace the whole set for this SO (delete-then-insert)
    // so a removed line in 2990 disappears here too. Idempotent by construction.
    await DB.prepare(`DELETE FROM scm."mfg_sales_order_items" WHERE company_id=? AND doc_no=?`).bind(C2990, doc).run();
    for (const it of body.items ?? []) await upsert(DB, 'mfg_sales_order_items', applyMap(it, iMap), 'id');

    await DB.prepare(`DELETE FROM scm."mfg_sales_order_payments" WHERE company_id=? AND so_doc_no=?`).bind(C2990, doc).run();
    for (const p of body.payments ?? []) await upsert(DB, 'mfg_sales_order_payments', applyMap(p, pMap), 'id');

    return c.json({ ok: true, docNo: doc, items: (body.items ?? []).length, payments: (body.payments ?? []).length });
  } catch (e) {
    // Non-2xx → 2990's drainer keeps the outbox row pending and retries. Zero-loss.
    return c.json({ error: 'mirror_failed', reason: (e as Error).message }, 500);
  }
});
