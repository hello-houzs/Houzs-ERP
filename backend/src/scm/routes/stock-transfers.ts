// ----------------------------------------------------------------------------
// /stock-transfers — move stock between warehouses with a document trail.
//
// PR-DRAFT-removal (2026-05-27): DRAFT step removed. POST creates the row
// as POSTED directly + writes paired OUT@from + IN@to inventory_movements
// inline. PATCH /:id/post kept as no-op for backward compat.
// FIFO trigger consumes from source lots and computes cost on the OUT row.
// We then read OUT.total_cost_sen / OUT.qty back and feed it into the IN as
// unit_cost_sen so the destination lot opens at the right basis.
//
// Endpoints:
//   GET   /stock-transfers                — list
//   GET   /stock-transfers/:id            — header + lines + warehouse names
//   POST  /stock-transfers                — create + post (writes movements)
//   PATCH /stock-transfers/:id/post       — idempotent no-op (legacy)
//   PATCH /stock-transfers/:id/cancel     — POSTED → CANCELLED + reverses the
//                                            inter-warehouse movement (variant-
//                                            aware, idempotent: only fires on
//                                            ACTIVE→CANCELLED)
//   DELETE /stock-transfers/:id           — disabled (only CANCELLED allowed)
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { writeMovements, reverseMovements } from '../lib/inventory-movements';

export const stockTransfers = new Hono<{ Bindings: Env; Variables: Variables }>();
stockTransfers.use('*', supabaseAuth);

const HEADER =
  'id, transfer_no, status, from_warehouse_id, to_warehouse_id, transfer_date, ' +
  'notes, posted_at, cancelled_at, created_at, created_by';
const LINE =
  'id, stock_transfer_id, product_code, product_name, variant_key, qty, notes, created_at';

const VALID_STATUS = new Set(['POSTED', 'CANCELLED']);

const nextTransferNo = async (sb: any): Promise<string> => {
  const d = new Date();
  const yymm = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`;
  const { count } = await sb.from('stock_transfers')
    .select('id', { head: true, count: 'exact' })
    .like('transfer_no', `ST-${yymm}-%`);
  return `ST-${yymm}-${String((count ?? 0) + 1).padStart(3, '0')}`;
};

// ── List ──────────────────────────────────────────────────────────────
stockTransfers.get('/', async (c) => {
  const sb = c.get('supabase');
  const status            = c.req.query('status');
  const fromWarehouseId   = c.req.query('fromWarehouseId');
  const toWarehouseId     = c.req.query('toWarehouseId');
  const dateFrom          = c.req.query('dateFrom');
  const dateTo            = c.req.query('dateTo');

  let q = sb.from('stock_transfers')
    .select(
      `${HEADER}, ` +
      `from_warehouse:warehouses!stock_transfers_from_warehouse_id_fkey(id, code, name), ` +
      `to_warehouse:warehouses!stock_transfers_to_warehouse_id_fkey(id, code, name)`,
    )
    .order('transfer_date', { ascending: false })
    .order('created_at', { ascending: false })
    // High bound so PostgREST's default 1000-row cap can't silently truncate
    // the transfer list (filters above only narrow the set).
    .limit(5000);

  if (status && VALID_STATUS.has(status)) q = q.eq('status', status);
  if (fromWarehouseId) q = q.eq('from_warehouse_id', fromWarehouseId);
  if (toWarehouseId)   q = q.eq('to_warehouse_id',   toWarehouseId);
  if (dateFrom)        q = q.gte('transfer_date', dateFrom);
  if (dateTo)          q = q.lte('transfer_date', dateTo);

  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  // Add a `lineCount` per row via a follow-up query (cheap, no separate table needed
  // until volumes grow). For pilot scale (<100 transfers/month) this is fine.
  // Cast through unknown — project-wide pattern when the Supabase client is
  // untyped (no generated DB types).
  const rows = (data as unknown as Array<Record<string, unknown>>) ?? [];
  const ids  = rows.map((r) => r.id as string);
  const countByXfer = new Map<string, number>();
  if (ids.length > 0) {
    const { data: lineRows } = await sb.from('stock_transfer_lines')
      .select('stock_transfer_id')
      .in('stock_transfer_id', ids)
      // .limit(5000): lines across the listed transfers can exceed PostgREST's
      // default 1000-row cap; truncation would understate line_count.
      .limit(5000);
    const lineList = (lineRows as unknown as Array<{ stock_transfer_id: string }>) ?? [];
    for (const l of lineList) {
      countByXfer.set(l.stock_transfer_id, (countByXfer.get(l.stock_transfer_id) ?? 0) + 1);
    }
  }

  const transfers = rows.map((r) => ({
    ...r,
    line_count: countByXfer.get(r.id as string) ?? 0,
  }));

  return c.json({ transfers });
});

// ── Detail ────────────────────────────────────────────────────────────
stockTransfers.get('/:id', async (c) => {
  const sb = c.get('supabase');
  const id = c.req.param('id');

  const [headerRes, linesRes] = await Promise.all([
    sb.from('stock_transfers')
      .select(
        `${HEADER}, ` +
        `from_warehouse:warehouses!stock_transfers_from_warehouse_id_fkey(id, code, name), ` +
        `to_warehouse:warehouses!stock_transfers_to_warehouse_id_fkey(id, code, name)`,
      )
      .eq('id', id).maybeSingle(),
    sb.from('stock_transfer_lines').select(LINE).eq('stock_transfer_id', id).order('created_at'),
  ]);

  if (headerRes.error) return c.json({ error: 'load_failed', reason: headerRes.error.message }, 500);
  if (!headerRes.data) return c.json({ error: 'not_found' }, 404);

  return c.json({ transfer: headerRes.data, lines: linesRes.data ?? [] });
});

/* ── Movement writer (shared by POST + legacy /post) ─────────────────
   For each line:
     1) Insert OUT @from (FIFO trigger fills total_cost_sen).
     2) Derive IN unit_cost_sen = OUT.total_cost_sen / OUT.qty (weighted avg).
     3) Insert IN @to with that cost. */
async function writeTransferMovements(
  sb: any,
  header: { id: string; transfer_no: string; from_warehouse_id: string; to_warehouse_id: string },
  userId: string,
): Promise<string[]> {
  const movementErrors: string[] = [];
  const { data: lines } = await sb.from('stock_transfer_lines')
    .select('product_code, product_name, variant_key, qty')
    .eq('stock_transfer_id', header.id);
  const lineList = (lines as Array<{ product_code: string; product_name: string | null; variant_key: string | null; qty: number }>) ?? [];

  /* Resolve the dye-lot batch each line moves so a batched (sofa) lot keeps its
     batch_no across the warehouse hop — otherwise the destination can't satisfy
     a batch-scoped sofa ship. We read OPEN lots at the SOURCE warehouse and, for
     each (product_code, variant_key) bucket, carry the batch ONLY when the source
     stock sits in a single non-null batch. If the bucket spans multiple batches
     (or is plain un-batched), we leave the line un-batched → plain FIFO, rather
     than guess a wrong dye-lot. Forward-compat: pre-0120 the column/view is absent
     → empty map → every line un-batched (old behaviour). */
  const batchByBucket = new Map<string, string | null>(); // key `code::variant` → batch_no | null (ambiguous/none)
  try {
    const { data: lots, error: lotsErr } = await sb
      .from('v_inventory_lots_open')
      .select('warehouse_id, product_code, variant_key, batch_no, qty_remaining')
      .eq('warehouse_id', header.from_warehouse_id)
      .not('batch_no', 'is', null)
      .gt('qty_remaining', 0);
    if (!lotsErr) {
      // Collect the distinct non-null batches per bucket; single → carry, else null.
      const batchesByBucket = new Map<string, Set<string>>();
      for (const r of (lots ?? []) as Array<{
        product_code: string; variant_key: string | null; batch_no: string | null;
      }>) {
        if (!r.batch_no) continue;
        const k = `${r.product_code}::${r.variant_key ?? ''}`;
        const set = batchesByBucket.get(k) ?? new Set<string>();
        set.add(r.batch_no);
        batchesByBucket.set(k, set);
      }
      for (const [k, set] of batchesByBucket.entries()) {
        batchByBucket.set(k, set.size === 1 ? [...set][0]! : null);
      }
    }
  } catch { /* view/column absent pre-0120 — every line stays un-batched (plain FIFO) */ }

  for (const ln of lineList) {
    if (ln.qty <= 0) continue;
    // Variant bucket the line moves; '' = unclassified/legacy. FIFO consumes
    // the OUT@from from THIS variant's oldest batch and re-opens it at IN@to.
    const variantKey = ln.variant_key ?? '';
    // Carry the resolved batch only when the source bucket sits in ONE batch
    // (unambiguous). null → leave un-batched (multi-batch ambiguity or plain stock).
    const batchNo = batchByBucket.get(`${ln.product_code}::${variantKey}`) ?? null;
    const { data: outRow, error: outErr } = await sb.from('inventory_movements').insert({
      movement_type:  'OUT',
      warehouse_id:   header.from_warehouse_id,
      product_code:   ln.product_code,
      variant_key:    variantKey,
      product_name:   ln.product_name,
      qty:            ln.qty,
      source_doc_type:'STOCK_TRANSFER',
      source_doc_id:  header.id,
      source_doc_no:  header.transfer_no,
      // Stamp the source dye-lot on the OUT so the FIFO trigger consumes THAT
      // batch (not any FIFO lot). Only when resolved to a single batch.
      ...(batchNo ? { batch_no: batchNo } : {}),
      performed_by:   userId,
      notes:          `Transfer to warehouse ${header.to_warehouse_id}`,
    }).select('id, qty').single();
    if (outErr || !outRow) {
      movementErrors.push(`OUT ${ln.product_code}: ${outErr?.message ?? 'no data'}`);
      continue;
    }
    /* Audit 2026-06-10 C-1 (CRITICAL) — the FIFO trigger is AFTER INSERT and
       stamps total_cost_sen via a separate UPDATE, which INSERT…RETURNING can
       NEVER see (RETURNING shows the row as inserted). Reading the cost off
       the insert response therefore always read 0, so every transfer opened
       the destination lot at 0 cost — inventory value silently destroyed on
       each warehouse move. RE-QUERY the row post-insert (same pattern as
       restampDoActualCost) so the IN carries the OUT's real consumed cost. */
    const { data: outCosted } = await sb.from('inventory_movements')
      .select('qty, total_cost_sen')
      .eq('id', (outRow as { id: string }).id)
      .single();
    const outQty   = Number((outCosted as { qty: number } | null)?.qty ?? ln.qty);
    const outTotal = Number((outCosted as { total_cost_sen: number | null } | null)?.total_cost_sen ?? 0);
    const inUnitCost = outQty > 0 ? Math.round(outTotal / outQty) : 0;
    const inOk = await writeMovements(sb, [{
      movement_type:  'IN',
      warehouse_id:   header.to_warehouse_id,
      product_code:   ln.product_code,
      variant_key:    variantKey,
      product_name:   ln.product_name,
      qty:            ln.qty,
      unit_cost_sen:  inUnitCost,
      source_doc_type:'STOCK_TRANSFER',
      source_doc_id:  header.id,
      source_doc_no:  header.transfer_no,
      // Mirror the OUT's batch onto the IN so the dye-lot survives the move
      // (destination opens a lot tagged with the same batch).
      ...(batchNo ? { batch_no: batchNo } : {}),
      performed_by:   userId,
      notes:          `Transfer from warehouse ${header.from_warehouse_id}`,
    }]);
    if (!inOk.ok) movementErrors.push(`IN ${ln.product_code}: ${inOk.reason ?? 'unknown'}`);
  }
  /* Stock Transfer = net-zero across warehouses, but B2C allocation sums all
     warehouses anyway so the totals don't change. Still re-walk in case any
     row failed (partial transfer) and the bucket has actually shifted. */
  try {
    const { recomputeSoStockAllocation } = await import('../lib/so-stock-allocation');
    await recomputeSoStockAllocation(sb);
  } catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-allocation] post-transfer failed:', e); }
  return movementErrors;
}

// ── Create + auto-post ────────────────────────────────────────────────
// body: { fromWarehouseId, toWarehouseId, transferDate?, notes?,
//         items: [{ productCode, productName?, variantKey?, qty, notes? }] }
// PR-DRAFT-removal: row is inserted as POSTED and inventory_movements
// are written inline. No separate /post call needed.
stockTransfers.post('/', async (c) => {
  const sb = c.get('supabase');
  const user = c.get('user');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; }
  catch { return c.json({ error: 'invalid_json' }, 400); }
  if (body.status === 'DRAFT') return c.json({ error: 'draft_status_not_supported', message: 'DRAFT was removed in migration 0078.' }, 400);

  const fromWarehouseId = body.fromWarehouseId as string | undefined;
  const toWarehouseId   = body.toWarehouseId   as string | undefined;
  if (!fromWarehouseId) return c.json({ error: 'from_warehouse_required' }, 400);
  if (!toWarehouseId)   return c.json({ error: 'to_warehouse_required' }, 400);
  if (fromWarehouseId === toWarehouseId) return c.json({ error: 'same_warehouse' }, 400);

  const items = (body.items as Array<Record<string, unknown>> | undefined) ?? [];
  if (items.length === 0) return c.json({ error: 'items_required' }, 400);

  const transferNo = await nextTransferNo(sb);

  const headerInsert: Record<string, unknown> = {
    transfer_no:        transferNo,
    status:             'POSTED',
    posted_at:          new Date().toISOString(),
    from_warehouse_id:  fromWarehouseId,
    to_warehouse_id:    toWarehouseId,
    notes:              (body.notes as string | undefined) ?? null,
    created_by:         user.id,
  };
  if (body.transferDate) headerInsert.transfer_date = body.transferDate;

  const { data: headerData, error: hErr } = await sb
    .from('stock_transfers').insert(headerInsert).select(HEADER).single();
  if (hErr) {
    if (hErr.code === '42501') return c.json({ error: 'forbidden', reason: hErr.message }, 403);
    return c.json({ error: 'insert_failed', reason: hErr.message }, 500);
  }
  const header = headerData as unknown as { id: string; transfer_no: string; from_warehouse_id: string; to_warehouse_id: string };

  const lineRows = items.map((it) => {
    const qty = Math.max(0, Math.floor(Number(it.qty ?? 0)));
    if (qty <= 0) throw new Error('qty must be > 0');
    if (!it.productCode) throw new Error('productCode required per line');
    return {
      stock_transfer_id: header.id,
      product_code: String(it.productCode),
      product_name: (it.productName as string | undefined) ?? null,
      // Variant bucket so the OUT@from / IN@to movements consume + re-open the
      // matching FIFO batch. Omit / '' = unclassified (legacy behaviour).
      variant_key: (it.variantKey as string | undefined) ?? '',
      qty,
      notes: (it.notes as string | undefined) ?? null,
    };
  });
  const { error: lErr } = await sb.from('stock_transfer_lines').insert(lineRows);
  if (lErr) {
    await sb.from('stock_transfers').delete().eq('id', header.id);
    return c.json({ error: 'lines_insert_failed', reason: lErr.message }, 500);
  }

  // Write inventory movements (paired OUT/IN) inline.
  const movementErrors = await writeTransferMovements(sb, header, user.id);

  return c.json({
    id: header.id,
    transferNo: header.transfer_no,
    movementErrors: movementErrors.length ? movementErrors : undefined,
  }, 201);
});

// ── Cancel POSTED ─────────────────────────────────────────────────────
// Cancel actually REVERSES the inter-warehouse movement: it posts an
// opposite-direction movement per original row (IN@to → OUT@to, OUT@from →
// IN@from) via reverseMovements, so stock flows back to the source warehouse
// and the FIFO cost basis is restored. Variant-aware (reverseMovements buckets
// by product_code + variant_key + warehouse). Idempotent two ways: the
// status flip is gated POSTED→CANCELLED (the .neq guard returns no row on a
// second call → 409), and reverseMovements itself skips buckets whose signed
// net is already 0, so even a retry that slipped past the gate is a no-op.
stockTransfers.patch('/:id/cancel', async (c) => {
  const sb = c.get('supabase');
  const user = c.get('user');
  const id = c.req.param('id');

  // Gate on the ACTIVE(=POSTED)→CANCELLED transition. Only the call that
  // actually flips the status proceeds to reverse — never on an already
  // CANCELLED row.
  const { data, error } = await sb.from('stock_transfers')
    .update({ status: 'CANCELLED', cancelled_at: new Date().toISOString() })
    .eq('id', id).neq('status', 'CANCELLED')
    .select('id, status, cancelled_at').single();
  if (error) return c.json({ error: 'cancel_failed', reason: error.message }, 500);
  if (!data)  return c.json({ error: 'already_cancelled' }, 409);

  // Reverse the paired OUT/IN movements this transfer wrote. Best-effort,
  // mirroring the post path: a failed reversal row is logged + reported, it
  // does NOT roll back the CANCELLED status (audit-DLQ posture).
  const rev = await reverseMovements(sb, 'STOCK_TRANSFER', id, user?.id ?? null);
  // Net-zero across warehouses again — re-walk B2C stock allocation in case a
  // partial reversal actually shifted a bucket.
  try {
    const { recomputeSoStockAllocation } = await import('../lib/so-stock-allocation');
    await recomputeSoStockAllocation(sb);
  } catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-allocation] post-cancel failed:', e); }

  return c.json({
    transfer: data,
    reversal: { reversed: rev.reversed, skipped: rev.skipped, failed: rev.failed },
    reversalErrors: rev.failed > 0 ? (rev.reason ?? 'partial reversal') : undefined,
  });
});

// ── Post → idempotent no-op (legacy compat) ───────────────────────────
stockTransfers.patch('/:id/post', async (c) => {
  const sb = c.get('supabase');
  const id = c.req.param('id');
  const { data } = await sb.from('stock_transfers').select(HEADER).eq('id', id).maybeSingle();
  if (!data) return c.json({ error: 'not_found' }, 404);
  const row = data as unknown as { status: string };
  if (row.status === 'POSTED') return c.json({ transfer: data });
  return c.json({ error: 'cannot_post', message: `Cannot post a ${row.status} transfer.` }, 409);
});
