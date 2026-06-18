// ----------------------------------------------------------------------------
// /stock-takes — AutoCount-style cycle count (PR — Inv PR5).
//
// OPEN → POSTED. PR-DRAFT-removal (2026-05-27): renamed DRAFT → OPEN
// because cycle counts legitimately need an editable working state
// (commander types counted_qty per line BEFORE posting). "OPEN" makes
// the intent explicit rather than borrowing the deprecated "DRAFT" label.
//
// On create, the API snapshots system_qty for every SKU in the chosen
// scope (ALL / CATEGORY / CODE_PREFIX) at the chosen warehouse. The
// commander types counted_qty per line. On Post, for every line with a
// non-zero variance, an ADJUSTMENT movement is inserted into
// inventory_movements with a SIGNED qty.
//
// Numbering: STK-YYMM-NNN (month-scoped count + 1), same pattern as ST.
//
// Endpoints:
//   GET    /stock-takes                — list (status, warehouseId, dateFrom, dateTo)
//   GET    /stock-takes/:id            — header + lines + warehouse name
//   POST   /stock-takes                — create OPEN + snapshot scope
//   PATCH  /stock-takes/:id/lines      — bulk update counted_qty (OPEN only)
//   PATCH  /stock-takes/:id/post       — OPEN → POSTED (writes ADJUSTMENT movements)
//   PATCH  /stock-takes/:id/cancel     — OPEN → CANCELLED
//   PATCH  /stock-takes/:id/reverse    — POSTED → CANCELLED (undo: reverses the ADJUSTMENT movements)
//   DELETE /stock-takes/:id            — OPEN only
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';

export const stockTakes = new Hono<{ Bindings: Env; Variables: Variables }>();
stockTakes.use('*', supabaseAuth);

const HEADER =
  'id, take_no, status, warehouse_id, scope_type, scope_value, take_date, ' +
  'notes, posted_at, cancelled_at, created_at, created_by';
const LINE =
  'id, stock_take_id, product_code, product_name, system_qty, counted_qty, ' +
  'variance, notes, created_at';

const VALID_STATUS = new Set(['OPEN', 'POSTED', 'CANCELLED']);
const VALID_SCOPE  = new Set(['ALL', 'CATEGORY', 'CODE_PREFIX']);

const nextTakeNo = async (sb: any): Promise<string> => {
  const d = new Date();
  const yymm = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`;
  const { count } = await sb.from('stock_takes')
    .select('id', { head: true, count: 'exact' })
    .like('take_no', `STK-${yymm}-%`);
  return `STK-${yymm}-${String((count ?? 0) + 1).padStart(3, '0')}`;
};

// ── Resolve in-scope SKUs + their current system_qty at the warehouse ──
// Hits v_inventory_all_skus (warehouse × SKU cross-join with COALESCE qty=0)
// so even SKUs with no movements yet end up in the count sheet.
type ScopedSku = { product_code: string; product_name: string | null; qty: number };
const fetchScopedSkus = async (
  sb: any,
  warehouseId: string,
  scopeType: 'ALL' | 'CATEGORY' | 'CODE_PREFIX',
  scopeValue: string | null,
): Promise<{ rows: ScopedSku[]; error?: string }> => {
  let q = sb.from('v_inventory_all_skus')
    .select('product_code, product_name, category, qty')
    .eq('warehouse_id', warehouseId);

  if (scopeType === 'CATEGORY' && scopeValue) {
    q = q.eq('category', scopeValue);
  } else if (scopeType === 'CODE_PREFIX' && scopeValue) {
    q = q.ilike('product_code', `${scopeValue}%`);
  }

  const { data, error } = await q.order('product_code');
  if (error) return { rows: [], error: error.message };
  const rows = (data as unknown as Array<{
    product_code: string; product_name: string | null; qty: number | null;
  }> | null) ?? [];
  return {
    rows: rows.map((r) => ({
      product_code: r.product_code,
      product_name: r.product_name,
      qty:          Number(r.qty ?? 0),
    })),
  };
};

// ── List ──────────────────────────────────────────────────────────────
stockTakes.get('/', async (c) => {
  const sb = c.get('supabase');
  const status      = c.req.query('status');
  const warehouseId = c.req.query('warehouseId');
  const dateFrom    = c.req.query('dateFrom');
  const dateTo      = c.req.query('dateTo');

  let q = sb.from('stock_takes')
    .select(`${HEADER}, warehouse:warehouses(id, code, name)`)
    .order('take_date', { ascending: false })
    .order('created_at', { ascending: false });

  if (status && VALID_STATUS.has(status)) q = q.eq('status', status);
  if (warehouseId) q = q.eq('warehouse_id', warehouseId);
  if (dateFrom)    q = q.gte('take_date', dateFrom);
  if (dateTo)      q = q.lte('take_date', dateTo);

  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  // line_count + variance_total — cheap follow-up sum at pilot scale.
  const rows = (data as unknown as Array<Record<string, unknown>>) ?? [];
  const ids  = rows.map((r) => r.id as string);
  const countByTake    = new Map<string, number>();
  const varianceByTake = new Map<string, number>();
  if (ids.length > 0) {
    const { data: lineRows } = await sb.from('stock_take_lines')
      .select('stock_take_id, variance, counted_qty')
      .in('stock_take_id', ids);
    const list = (lineRows as unknown as Array<{
      stock_take_id: string; variance: number | null; counted_qty: number | null;
    }>) ?? [];
    for (const l of list) {
      countByTake.set(l.stock_take_id, (countByTake.get(l.stock_take_id) ?? 0) + 1);
      // Only count variance from lines that were actually counted.
      if (l.counted_qty != null && l.variance != null) {
        varianceByTake.set(
          l.stock_take_id,
          (varianceByTake.get(l.stock_take_id) ?? 0) + Number(l.variance),
        );
      }
    }
  }

  const takes = rows.map((r) => ({
    ...r,
    line_count:     countByTake.get(r.id as string)    ?? 0,
    variance_total: varianceByTake.get(r.id as string) ?? 0,
  }));

  return c.json({ takes });
});

// ── Detail ────────────────────────────────────────────────────────────
stockTakes.get('/:id', async (c) => {
  const sb = c.get('supabase');
  const id = c.req.param('id');

  const [headerRes, linesRes] = await Promise.all([
    sb.from('stock_takes')
      .select(`${HEADER}, warehouse:warehouses(id, code, name)`)
      .eq('id', id).maybeSingle(),
    sb.from('stock_take_lines').select(LINE).eq('stock_take_id', id).order('product_code'),
  ]);

  if (headerRes.error) return c.json({ error: 'load_failed', reason: headerRes.error.message }, 500);
  if (!headerRes.data) return c.json({ error: 'not_found' }, 404);

  return c.json({ take: headerRes.data, lines: linesRes.data ?? [] });
});

// ── Create OPEN + snapshot scope ──────────────────────────────────────
// body: { warehouseId, takeDate?, scopeType, scopeValue?, notes? }
stockTakes.post('/', async (c) => {
  const sb = c.get('supabase');
  const user = c.get('user');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; }
  catch { return c.json({ error: 'invalid_json' }, 400); }

  const warehouseId = body.warehouseId as string | undefined;
  if (!warehouseId) return c.json({ error: 'warehouse_required' }, 400);

  const scopeType = (body.scopeType as string | undefined) ?? 'ALL';
  if (!VALID_SCOPE.has(scopeType)) return c.json({ error: 'invalid_scope_type' }, 400);

  const scopeValueRaw = (body.scopeValue as string | undefined) ?? null;
  const scopeValue = scopeValueRaw && scopeValueRaw.trim() ? scopeValueRaw.trim() : null;
  if ((scopeType === 'CATEGORY' || scopeType === 'CODE_PREFIX') && !scopeValue) {
    return c.json({ error: 'scope_value_required_for_this_scope_type' }, 400);
  }

  // 1) Snapshot SKUs in scope.
  const scoped = await fetchScopedSkus(
    sb, warehouseId,
    scopeType as 'ALL' | 'CATEGORY' | 'CODE_PREFIX',
    scopeValue,
  );
  if (scoped.error) return c.json({ error: 'scope_load_failed', reason: scoped.error }, 500);
  if (scoped.rows.length === 0) {
    return c.json({ error: 'scope_empty', reason: 'No SKUs match the chosen scope.' }, 400);
  }

  const takeNo = await nextTakeNo(sb);

  const headerInsert: Record<string, unknown> = {
    take_no:      takeNo,
    status:       'OPEN',
    warehouse_id: warehouseId,
    scope_type:   scopeType,
    scope_value:  scopeValue,
    notes:        (body.notes as string | undefined) ?? null,
    created_by:   user.id,
  };
  if (body.takeDate) headerInsert.take_date = body.takeDate;

  const { data: headerData, error: hErr } = await sb
    .from('stock_takes').insert(headerInsert).select(HEADER).single();
  if (hErr) {
    if (hErr.code === '42501') return c.json({ error: 'forbidden', reason: hErr.message }, 403);
    return c.json({ error: 'insert_failed', reason: hErr.message }, 500);
  }
  const header = headerData as unknown as { id: string; take_no: string };

  // 2) Bulk-insert lines with system_qty filled + counted_qty NULL.
  const lineRows = scoped.rows.map((r) => ({
    stock_take_id: header.id,
    product_code:  r.product_code,
    product_name:  r.product_name,
    system_qty:    r.qty,
    counted_qty:   null,
  }));
  const { error: lErr } = await sb.from('stock_take_lines').insert(lineRows);
  if (lErr) {
    // Best-effort rollback so we don't leak a no-lines header.
    await sb.from('stock_takes').delete().eq('id', header.id);
    return c.json({ error: 'lines_insert_failed', reason: lErr.message }, 500);
  }

  return c.json({
    id:        header.id,
    takeNo:    header.take_no,
    lineCount: lineRows.length,
  }, 201);
});

// ── Update counted_qty per line (bulk) ────────────────────────────────
// body: { lines: [{ id, countedQty (number | null), notes? }] }
stockTakes.patch('/:id/lines', async (c) => {
  const sb = c.get('supabase');
  const id = c.req.param('id');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; }
  catch { return c.json({ error: 'invalid_json' }, 400); }

  const { data: prev } = await sb.from('stock_takes').select('status').eq('id', id).maybeSingle();
  if (!prev) return c.json({ error: 'not_found' }, 404);
  if ((prev as { status: string }).status !== 'OPEN') return c.json({ error: 'not_open' }, 409);

  const lines = body.lines as Array<{
    id: string; countedQty?: number | null; notes?: string | null;
  }> | undefined;
  if (!Array.isArray(lines) || lines.length === 0) {
    return c.json({ error: 'lines_required' }, 400);
  }

  // Issue updates one-at-a-time (Supabase JS lacks a true bulk upsert by
  // PK). Pilot scale (<500 lines per take) — fine. If volumes grow we can
  // switch to a single RPC.
  const errors: string[] = [];
  for (const l of lines) {
    if (!l.id) continue;
    const patch: Record<string, unknown> = {};
    if ('countedQty' in l) {
      patch.counted_qty =
        l.countedQty == null || (l.countedQty as unknown) === ''
          ? null
          : Math.max(0, Math.floor(Number(l.countedQty)));
    }
    if ('notes' in l) patch.notes = l.notes ?? null;
    if (Object.keys(patch).length === 0) continue;

    const { error } = await sb.from('stock_take_lines')
      .update(patch).eq('id', l.id).eq('stock_take_id', id);
    if (error) errors.push(`${l.id}: ${error.message}`);
  }

  if (errors.length > 0) {
    return c.json({ error: 'partial_update_failed', errors }, 500);
  }
  return c.json({ ok: true, updated: lines.length });
});

// ── Cancel OPEN ───────────────────────────────────────────────────────
stockTakes.patch('/:id/cancel', async (c) => {
  const sb = c.get('supabase');
  const id = c.req.param('id');

  const { data, error } = await sb.from('stock_takes')
    .update({ status: 'CANCELLED', cancelled_at: new Date().toISOString() })
    .eq('id', id).eq('status', 'OPEN')
    .select('id, status, cancelled_at').single();
  if (error) return c.json({ error: 'cancel_failed', reason: error.message }, 500);
  if (!data)  return c.json({ error: 'not_open' }, 409);
  return c.json({ take: data });
});

// ── Reverse POSTED → CANCELLED (undo a posted count) ──────────────────
// Every other inventory module's cancel reverses its stock; a POSTED stock
// take previously had no such path (cancel only accepted OPEN). This writes
// the OPPOSITE signed ADJUSTMENT for every movement the post wrote, so stock
// returns to exactly its pre-post level, then marks the take CANCELLED and
// locked. To re-count, the commander starts a fresh take (same posture as a
// cancelled DO/GRN/PR — the document is terminal, you make a new one).
//
// Cost note: the reversing ADJUSTMENT is qty-exact. A reversing increase is
// re-valued at the variant's current weighted-average open-lot cost (the same
// basis the forward post used for found stock); a reversing decrease is FIFO-
// consumed at the real layers. For cycle-count-sized variances this is fully
// consistent with how the forward adjustment itself was costed.
//
// Idempotency: status is flipped POSTED → CANCELLED FIRST (single-flight); a
// second call sees a non-POSTED row and returns 409, so reversal rows are
// written at most once.
stockTakes.patch('/:id/reverse', async (c) => {
  const sb = c.get('supabase');
  const user = c.get('user');
  const id = c.req.param('id');

  // Flip status first so a concurrent reverse can't double-write movements.
  const { data: cancelled, error: cErr } = await sb.from('stock_takes')
    .update({ status: 'CANCELLED', cancelled_at: new Date().toISOString() })
    .eq('id', id).eq('status', 'POSTED')
    .select(HEADER).single();
  if (cErr)       return c.json({ error: 'reverse_failed', reason: cErr.message }, 500);
  if (!cancelled) return c.json({ error: 'not_posted' }, 409);

  const header = cancelled as unknown as {
    id: string; take_no: string; warehouse_id: string;
  };

  // Load the forward ADJUSTMENT movements this take wrote. (Reversal can only
  // run once — the status gate above — so there are no prior reversal rows to
  // filter out.)
  const { data: movs, error: mLoadErr } = await sb.from('inventory_movements')
    .select('warehouse_id, product_code, product_name, variant_key, batch_no, qty')
    .eq('source_doc_type', 'STOCK_TAKE')
    .eq('source_doc_id', id);
  if (mLoadErr) {
    return c.json({ error: 'reverse_movements_load_failed', reason: mLoadErr.message }, 500);
  }

  const reverseRows: Array<Record<string, unknown>> = [];
  for (const m of (movs as Array<{
    warehouse_id: string; product_code: string; product_name: string | null;
    variant_key: string | null; batch_no: string | null; qty: number;
  }>) ?? []) {
    if (!m.qty) continue; // zero-variance lines wrote nothing; nothing to undo
    reverseRows.push({
      movement_type:   'ADJUSTMENT',
      warehouse_id:    m.warehouse_id,
      product_code:    m.product_code,
      product_name:    m.product_name,
      variant_key:     m.variant_key ?? '',
      batch_no:        m.batch_no ?? null,
      qty:             -m.qty,                          // flip the sign — undo
      unit_cost_sen:   0,                               // trigger recomputes cost
      source_doc_type: 'STOCK_TAKE',
      source_doc_id:   header.id,
      source_doc_no:   header.take_no,
      reason_code:     'COUNT',
      notes:           `Reversal of stock take ${header.take_no}`,
      performed_by:    user.id,
    });
  }

  const movementErrors: string[] = [];
  if (reverseRows.length > 0) {
    const { error: insErr } = await sb.from('inventory_movements').insert(reverseRows);
    if (insErr) movementErrors.push(insErr.message);
  }

  /* Stock changed back — re-walk SO stock allocation (mirrors the post path). */
  try {
    const { recomputeSoStockAllocation } = await import('../lib/so-stock-allocation');
    await recomputeSoStockAllocation(sb);
  } catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-allocation] reverse-stock-take failed:', e); }

  return c.json({
    take: cancelled,
    movementsReversed: movementErrors.length ? 0 : reverseRows.length,
    movementErrors: movementErrors.length ? movementErrors : undefined,
  });
});

// ── Delete OPEN ───────────────────────────────────────────────────────
stockTakes.delete('/:id', async (c) => {
  const sb = c.get('supabase');
  const id = c.req.param('id');
  const { data: prev } = await sb.from('stock_takes')
    .select('status').eq('id', id).maybeSingle();
  if (!prev) return c.json({ error: 'not_found' }, 404);
  if ((prev as { status: string }).status !== 'OPEN') return c.json({ error: 'not_open' }, 409);

  const { error } = await sb.from('stock_takes').delete().eq('id', id);
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);
  return c.json({ ok: true });
});

// ── Post OPEN → POSTED ────────────────────────────────────────────────
// For every line where counted_qty IS NOT NULL and variance != 0, insert
// a single ADJUSTMENT movement with SIGNED qty (mirrors what POST
// /inventory/adjustments does — see apps/api/src/routes/inventory.ts).
//
// Lines with counted_qty == NULL are treated as "untouched" (commander
// never got to that SKU) and skipped — no movement, no audit trail beyond
// the line itself.
stockTakes.patch('/:id/post', async (c) => {
  const sb = c.get('supabase');
  const user = c.get('user');
  const id = c.req.param('id');

  // Flip status first so concurrent posts don't double-write movements.
  const { data: posted, error: pErr } = await sb.from('stock_takes')
    .update({ status: 'POSTED', posted_at: new Date().toISOString() })
    .eq('id', id).eq('status', 'OPEN')
    .select(HEADER).single();
  if (pErr)    return c.json({ error: 'post_failed', reason: pErr.message }, 500);
  if (!posted) return c.json({ error: 'not_open' }, 409);

  const header = posted as unknown as {
    id: string; take_no: string; warehouse_id: string;
  };

  const { data: lines } = await sb.from('stock_take_lines')
    .select('product_code, product_name, system_qty, counted_qty, variance, notes')
    .eq('stock_take_id', id);

  const movementErrors: string[] = [];
  const adjustmentRows: Array<Record<string, unknown>> = [];

  for (const ln of (lines as Array<{
    product_code: string; product_name: string | null;
    system_qty: number; counted_qty: number | null;
    variance: number | null; notes: string | null;
  }>) ?? []) {
    if (ln.counted_qty == null) continue;
    // Recompute defensively — variance is generated in DB but be safe.
    const variance = ln.variance ?? (ln.counted_qty - ln.system_qty);
    if (variance === 0) continue;

    adjustmentRows.push({
      movement_type:   'ADJUSTMENT',
      warehouse_id:    header.warehouse_id,
      product_code:    ln.product_code,
      product_name:    ln.product_name,
      qty:             variance,                       // SIGNED — see /inventory/adjustments
      unit_cost_sen:   0,
      source_doc_type: 'STOCK_TAKE',
      source_doc_id:   header.id,
      source_doc_no:   header.take_no,
      reason_code:     'COUNT',                          // count correction
      notes:           `Stock take variance${ln.notes ? ` · ${ln.notes}` : ''}`,
      performed_by:    user.id,
    });
  }

  if (adjustmentRows.length > 0) {
    // One bulk insert — the FIFO trigger runs row-by-row anyway, but the
    // round-trip is single. Best-effort: failures listed, post not rolled
    // back (matches the audit-DLQ posture in writeMovements()).
    const { error: mErr } = await sb.from('inventory_movements').insert(adjustmentRows);
    if (mErr) movementErrors.push(mErr.message);
  }

  /* B2C SO auto-allocation — variance changed stock, re-walk SO lines. */
  try {
    const { recomputeSoStockAllocation } = await import('../lib/so-stock-allocation');
    await recomputeSoStockAllocation(sb);
  } catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-allocation] post-stock-take failed:', e); }

  return c.json({
    take: posted,
    movementsWritten: movementErrors.length ? 0 : adjustmentRows.length,
    movementErrors: movementErrors.length ? movementErrors : undefined,
  });
});
