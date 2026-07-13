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
import type { HouzsEnv } from '../../types';

type Env = HouzsEnv;
export const soMirror = new Hono<{ Bindings: HouzsEnv }>();

const C2990 = 2;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// --- transform primitives — byte-for-byte the import script's rules ----------
function remapId(v: unknown): unknown {
  if (v == null) return v;
  const s = String(v);
  if (/^-?\d+$/.test(s)) return Number(s) + 100000;                 // serial id
  if (UUID_RE.test(s)) return s.slice(0, 4).toLowerCase() === '2990' ? s : '2990' + s.slice(4);
  return s.startsWith('2990-') ? s : `2990-${s}`;                   // text key
}
function prefixDoc(v: unknown): unknown {
  return v == null || String(v).startsWith('2990-') ? v : `2990-${v}`;
}

// --- remap map, discovered from the live FK graph, cached per isolate --------
type TableMap = { remapCols: Set<string>; prefixCols: Set<string>; selfRemap: boolean };
const mapCache = new Map<string, TableMap>();

async function tableMap(DB: Env['DB'], table: string): Promise<TableMap> {
  const cached = mapCache.get(table);
  if (cached) return cached;

  // FK columns of `table` whose PARENT table is company-scoped (has company_id)
  // → those references were id-remapped by the import, so we remap them too.
  // Parents WITHOUT company_id (staff, my_localities, …) are shared → skip.
  const fk = await DB.prepare(
    `SELECT a.attname AS col
       FROM pg_constraint c
       JOIN pg_class cl   ON cl.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = cl.relnamespace
       JOIN pg_class fcl  ON fcl.oid = c.confrelid
       JOIN pg_namespace fn ON fn.oid = fcl.relnamespace
       CROSS JOIN LATERAL unnest(c.conkey) k(attnum)
       JOIN pg_attribute a ON a.attrelid = cl.oid AND a.attnum = k.attnum
      WHERE c.contype = 'f' AND n.nspname = 'scm' AND cl.relname = ?
        AND array_length(c.conkey,1) = 1
        AND EXISTS (SELECT 1 FROM information_schema.columns ic
                     WHERE ic.table_schema = fn.nspname AND ic.table_name = fcl.relname
                       AND ic.column_name = 'company_id')`,
  ).bind(table).all<{ col: string }>();

  // text doc-ref columns → prefix (same name heuristic the import uses)
  const dr = await DB.prepare(
    `SELECT column_name AS col FROM information_schema.columns
      WHERE table_schema='scm' AND table_name=? AND data_type IN ('text','character varying')
        AND (column_name LIKE '%doc_no%' OR column_name LIKE '%\\_number%' OR column_name LIKE '%reference%' OR column_name IN ('ref','po_doc_no'))`,
  ).bind(table).all<{ col: string }>();

  const selfRemap = (await DB.prepare(
    `SELECT 1 FROM information_schema.columns WHERE table_schema='scm' AND table_name=? AND column_name='id'`,
  ).bind(table).first()) != null;

  const m: TableMap = {
    remapCols: new Set((fk.results ?? []).map((r) => r.col)),
    prefixCols: new Set((dr.results ?? []).map((r) => r.col)),
    selfRemap,
  };
  mapCache.set(table, m);
  return m;
}

function applyMap(row: Record<string, unknown>, m: TableMap): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row, company_id: C2990 };
  if (m.selfRemap && 'id' in out) out.id = remapId(out.id);
  for (const col of m.remapCols) if (out[col] != null) out[col] = remapId(out[col]);
  for (const col of m.prefixCols) if (out[col] != null) out[col] = prefixDoc(out[col]);
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
