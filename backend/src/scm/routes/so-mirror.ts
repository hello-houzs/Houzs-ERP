// ----------------------------------------------------------------------------
// /so-mirror — LIVE receiver for 2990 → Houzs one-way SO mirror.
//
// The 2990 database (via pg_cron + pg_net) POSTs each changed SO here as
// { docNo, header, items, payments } (raw 2990-shaped rows) or { docNo,
// deleted:true }. We apply the SAME transform as the batch importer
// (migrate-2990-into-houzs.mjs) — 2990- doc-no prefix, company_id=2, and every
// id copied VERBATIM (never remapped — see lib/mirror-map.ts) — then
// idempotently UPSERT by doc_no. Retried deliveries never duplicate.
//
// AUTH: a static shared secret (x-sync-secret == env.SYNC_SECRET), because the
// caller is a database (pg_net), not a user with a Supabase JWT. Service-only.
//
// Mounted at '/api/sync/so-mirror' in src/index.ts — PRE-AUTH, above the /api/*
// staff-session gate, because the caller is a database with no session.
// ----------------------------------------------------------------------------
import { Hono } from 'hono';
import type { Env } from '../../types';
import { C2990, createMirrorMapper, mirrorAuthed, prefixDoc, upsert } from '../lib/mirror-map';

export const soMirror = new Hono<{ Bindings: Env }>();

// Status normalization guard (insurance). The canonical STORED SO status set is
// {DRAFT, CONFIRMED, CANCELLED}; every richer state (Ready/Delivered/Invoiced…)
// is DERIVED server-side from shared code. 2990 is the progenitor of this same
// schema so its statuses should already match — but if the legacy system ever
// emits a lowercase or alien value, a raw pass-through would make mirrored rows
// invisible to the status-count/filter buckets and render an empty progress bar.
// Coerce any non-canonical inbound status to the nearest canonical value so a
// company-2 row can never carry a vocabulary Houzs code doesn't understand.
const CANON_SO_STATUS = new Set(['DRAFT', 'CONFIRMED', 'CANCELLED']);
function normalizeStatus(v: unknown): unknown {
  if (v == null) return v;
  const s = String(v).trim().toUpperCase();
  return CANON_SO_STATUS.has(s) ? s : 'CONFIRMED';
}

// Explicit per-table column rules, matching migrate-2990-into-houzs.mjs's
// DOCNO_COL + PREFIX_REF_COLS + NULL_COLS. so-mirror only handles the SO trio.
// The transform primitives themselves live in lib/mirror-map.ts (shared with the
// amendment receiver); see that file for the verbatim-id and text[] rationale.
const { tableMap, applyMap } = createMirrorMapper({
  mfg_sales_orders: {
    // header doc_no (PK) + the cross-category source doc ref
    prefixCols: ['doc_no', 'cross_category_source_doc_no'],
    // venue_id points at scm.venues, which the import nulls on load (source value
    // references a master row that isn't reconciled across companies).
    forceCols: { venue_id: null },
    normalize: { status: normalizeStatus },
  },
  mfg_sales_order_items: { prefixCols: ['doc_no'] },
  mfg_sales_order_payments: { prefixCols: ['so_doc_no'] },
});

soMirror.post('/', async (c) => {
  if (!mirrorAuthed(c)) return c.json({ error: 'unauthorized' }, 401);
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
