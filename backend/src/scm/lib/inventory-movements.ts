// ----------------------------------------------------------------------------
// Inventory movement helpers — single source of truth for writing
// IN / OUT rows whenever a document posts. Imported by GRN, DO, Consignment,
// and Purchase Return post handlers.
//
// Trading-company model (commander 2026-05-25):
//   IN  ← GRN posted (qty_accepted per item), Consignment RETURN note post
//   OUT ← DO dispatched, Purchase Return posted, Consignment OUT note post
//
// Best-effort: a failed movement insert does NOT roll back the document
// post (audit-DLQ style). We log + return false so the caller can decide.
// ----------------------------------------------------------------------------

type MovementInput = {
  movement_type: 'IN' | 'OUT' | 'ADJUSTMENT';
  warehouse_id: string;
  product_code: string;
  /** Migration 0095 — canonical attribute-composition bucket key
   *  (packages/shared computeVariantKey). Stock is bucketed by
   *  (warehouse_id, product_code, variant_key). Omit / '' = unclassified. */
  variant_key?: string;
  product_name?: string | null;
  /** For IN / OUT: positive count. For ADJUSTMENT: signed delta
   *  (positive = found stock / IN-style, negative = write-off / OUT-style).
   *  The DB column is INTEGER and accepts both. */
  qty: number;
  /** PR #37 — for IN rows: per-unit cost in sen. Trigger uses this to
   *  create the FIFO lot. OUT rows leave this unset; the trigger computes
   *  the consumed cost from the lots it pulls from. */
  unit_cost_sen?: number;
  /** PR — Inv PR5 (2026-05-27) — added STOCK_TAKE. ADJUSTMENT remains
   *  for the manual one-off adjustment route. */
  source_doc_type:
    | 'GRN' | 'DO' | 'DR' | 'CONSIGNMENT_NOTE' | 'PURCHASE_CONSIGNMENT_NOTE'
    | 'PURCHASE_RETURN' | 'STOCK_TRANSFER' | 'STOCK_TAKE' | 'ADJUSTMENT'
    /* Sales-consignment loaner movements (value-neutral warehouse transfer, NOT
       COGS). CS_DO = a Consignment Note ships a loaner OUT to the consignment
       warehouse; CS_DR = a Consignment Return brings it back. Their partial
       UNIQUE indexes (uq_inv_mov_cs_do_source / uq_inv_mov_cs_dr_source,
       migration 0153) are the per-doc idempotency backstop. */
    | 'CS_DO' | 'CS_DR'
    /* Purchase-consignment ON-ledger movements (request 2026-06-05 — consigned
       stock at a showroom must show in Inventory). PC_RECEIVE = a Purchase
       Consignment Receive books goods IN to its warehouse; PC_RETURN = a
       Purchase Consignment Return takes them back OUT. Reversed on cancel via
       reverseMovements. Excluded from MRP by warehouse separation. */
    | 'PC_RECEIVE' | 'PC_RETURN';
  source_doc_id?: string;
  source_doc_no?: string;
  /** Migration 0120 — production batch (source PO number). On IN rows the FIFO
   *  trigger copies this onto the lot it creates, so sofa set components share a
   *  batch and can be shipped as a whole set from one dye lot. Omit for
   *  un-batched stock. */
  batch_no?: string | null;
  performed_by?: string | null;
  notes?: string | null;
};

/**
 * Insert N movement rows in one go. Used after a document is posted to
 * record the stock impact. Never throws — returns true/false so callers
 * can log without rolling back the post.
 *
 * `sb` is the Supabase client from the Hono context; we accept it as `any`
 * because the route-side handlers use the loosely-typed client (no DB
 * generics) and the helper is a thin pass-through.
 */
export async function writeMovements(
  sb: any,
  rows: MovementInput[],
): Promise<{ ok: boolean; reason?: string }> {
  if (rows.length === 0) return { ok: true };
  try {
    const { error } = await sb.from('inventory_movements').insert(rows);
    if (error) {
      // Migration 0120 forward-compat: if batch_no isn't in the schema cache yet
      // (column not created on this DB), strip it and retry so inbound stock
      // still enters inventory. Once 0120 is applied the first attempt succeeds.
      const msg = error.message ?? '';
      const batchMissing = msg.includes('batch_no');
      if (batchMissing && rows.some((r) => 'batch_no' in r)) {
        const stripped = rows.map(({ batch_no: _b, ...rest }) => rest);
        const retry = await sb.from('inventory_movements').insert(stripped);
        if (!retry.error) return { ok: true };
        // eslint-disable-next-line no-console
        console.error('[inventory] movement insert failed (post batch_no strip):', retry.error.message);
        return { ok: false, reason: retry.error.message };
      }
      // eslint-disable-next-line no-console
      console.error('[inventory] movement insert failed:', error.message);
      return { ok: false, reason: error.message };
    }
    return { ok: true };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[inventory] movement insert exception:', e);
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Resolve the default warehouse id (the one flagged is_default = true).
 * Used as a fallback when a document doesn't carry its own warehouse_id
 * — e.g. legacy GRN rows back-filled to KL.
 */
export async function defaultWarehouseId(sb: any): Promise<string | null> {
  const { data } = await sb.from('warehouses')
    .select('id')
    .eq('is_default', true)
    .order('code', { ascending: true })
    .limit(1)
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

/**
 * Resolve the dye-lot batch each (product_code, variant_key) bucket should carry
 * when shipping OUT of a warehouse, derived from the OPEN lots physically in that
 * warehouse. For each bucket: carry the batch ONLY when the warehouse holds the
 * stock under a SINGLE non-null batch (unambiguous — e.g. a showroom warehouse
 * loaded by one Purchase Consignment Receive). Multi-batch or plain stock →
 * un-batched (plain FIFO), never a guessed dye-lot. Mirrors how the sales-
 * consignment ship used to pick its dye-lot; the OUT carries this so a sofa
 * consumes the right lot + the movement shows its batch. Forward-compat: view
 * absent → empty map → every line un-batched. Best-effort (never throws).
 */
export async function resolveWarehouseLotBatches(
  sb: any,
  warehouseId: string,
): Promise<Map<string, string | null>> {
  const byBucket = new Map<string, string | null>();
  if (!warehouseId) return byBucket;
  try {
    const { data: lots, error } = await sb
      .from('v_inventory_lots_open')
      .select('product_code, variant_key, batch_no, qty_remaining')
      .eq('warehouse_id', warehouseId)
      .not('batch_no', 'is', null)
      .gt('qty_remaining', 0);
    if (!error) {
      const batches = new Map<string, Set<string>>();
      for (const r of (lots ?? []) as Array<{ product_code: string; variant_key: string | null; batch_no: string | null }>) {
        if (!r.batch_no) continue;
        const k = `${r.product_code}::${r.variant_key ?? ''}`;
        const set = batches.get(k) ?? new Set<string>();
        set.add(r.batch_no);
        batches.set(k, set);
      }
      for (const [k, set] of batches.entries()) {
        byBucket.set(k, set.size === 1 ? [...set][0]! : null);
      }
    }
  } catch { /* view/column absent — every line un-batched (plain FIFO) */ }
  return byBucket;
}

/**
 * Resolve the CURRENT weighted-average unit cost (sen) per (product_code,
 * variant_key) bucket from the OPEN lots in a warehouse. Used as a cost fallback
 * for a stock-IN whose document carries no cost (e.g. a free-entry consignment
 * return at 0): re-entering at the SKU's real on-hand cost — instead of opening a
 * 0-cost lot that a later FIFO sale would consume and under-state COGS. Returns 0
 * for a bucket with no open lots (genuinely unknown cost). Best-effort.
 */
export async function resolveWarehouseLotCosts(
  sb: any,
  warehouseId: string,
): Promise<Map<string, number>> {
  const byBucket = new Map<string, number>();
  if (!warehouseId) return byBucket;
  try {
    const { data: lots, error } = await sb
      .from('v_inventory_lots_open')
      .select('product_code, variant_key, qty_remaining, unit_cost_sen')
      .eq('warehouse_id', warehouseId)
      .gt('qty_remaining', 0);
    if (!error) {
      const acc = new Map<string, { qty: number; cost: number }>();
      for (const r of (lots ?? []) as Array<{ product_code: string; variant_key: string | null; qty_remaining: number; unit_cost_sen: number | null }>) {
        const k = `${r.product_code}::${r.variant_key ?? ''}`;
        const q = Number(r.qty_remaining ?? 0);
        if (q <= 0) continue;
        const a = acc.get(k) ?? { qty: 0, cost: 0 };
        a.qty += q;
        a.cost += q * Number(r.unit_cost_sen ?? 0);
        acc.set(k, a);
      }
      for (const [k, a] of acc.entries()) {
        byBucket.set(k, a.qty > 0 ? Math.round(a.cost / a.qty) : 0);
      }
    }
  } catch { /* view absent — no cost fallback available */ }
  return byBucket;
}

/**
 * Reverse EVERY inventory movement a document wrote, by posting an
 * opposite-direction movement (IN→OUT / OUT→IN) per original row. This is the
 * SAFE way to undo a posting: the FIFO trigger (migration 0095) treats the
 * reversing row like any other movement — a reversing IN re-opens a cost lot,
 * a reversing OUT consumes lots + recomputes COGS — so on-hand qty and the cost
 * basis both come back consistent. We never DELETE the original rows (that would
 * desync the lots/consumptions the trigger already wrote).
 *
 * Used by the NEW reversal points (DO cancel, DR cancel, …). GRN-whole-cancel
 * and PR-cancel keep their own bespoke reversals (they predate this helper and
 * already work) — this is the shared path for everything else.
 *
 * ── Idempotency guard (no dedicated "reversed" column exists) ──────────────
 * We sum the SIGNED qty (IN = +qty, OUT = −qty) per (product_code, variant_key,
 * warehouse_id) across ALL rows for this (source_doc_type, source_doc_id),
 * INCLUDING any reversal rows we wrote on a prior call (they carry the same
 * source_doc_id). A bucket whose signed net is already 0 is fully reversed →
 * skip it. So calling reverseMovements twice is a no-op the second time, and a
 * partially-reversed doc (rare — a mid-batch failure) only reverses what's left.
 *
 * Best-effort, mirroring writeMovements: we never throw. Each reversal row is
 * inserted INDIVIDUALLY (not one batch) so a single failure — e.g. a partial
 * UNIQUE index that keys on (source_doc_type, source_doc_id, product_code,
 * variant_key) and therefore rejects a same-key opposite row, as DO/DR have
 * (uq_inv_mov_do_source / uq_inv_mov_dr_source, migrations 0100/0102) — does not
 * sink the rest. We report counts so the caller can log without rolling back.
 *
 * ADJUSTMENT / non-IN/OUT rows are left alone (there's no well-defined opposite
 * for a signed adjustment, and they don't represent a document posting we own).
 */
export async function reverseMovements(
  sb: any,
  sourceDocType: string,
  sourceDocId: string,
  performedBy: string | null,
): Promise<{ ok: boolean; reversed: number; skipped: number; failed: number; reason?: string }> {
  try {
    /* Select batch_no so a reversing row restores the EXACT dye-lot batch the
       original movement consumed/created (FIFO trigger reverses per-batch, not
       plain-FIFO). Forward-compat: pre-0120 the column doesn't exist → retry
       without it and every reversing row stays un-batched (old behaviour). */
    let movsRes = await sb
      .from('inventory_movements')
      .select('movement_type, warehouse_id, product_code, variant_key, batch_no, product_name, qty, unit_cost_sen, source_doc_no')
      .eq('source_doc_type', sourceDocType)
      .eq('source_doc_id', sourceDocId);
    if (movsRes.error && (movsRes.error.message ?? '').includes('batch_no')) {
      movsRes = await sb
        .from('inventory_movements')
        .select('movement_type, warehouse_id, product_code, variant_key, product_name, qty, unit_cost_sen, source_doc_no')
        .eq('source_doc_type', sourceDocType)
        .eq('source_doc_id', sourceDocId);
    }
    const { data, error } = movsRes;
    if (error) return { ok: false, reversed: 0, skipped: 0, failed: 0, reason: error.message };

    type Row = {
      movement_type: 'IN' | 'OUT' | 'ADJUSTMENT' | string;
      warehouse_id: string;
      product_code: string;
      variant_key: string | null;
      batch_no?: string | null;
      product_name: string | null;
      qty: number;
      unit_cost_sen: number | null;
      source_doc_no: string | null;
    };
    const rows = (data ?? []) as Row[];
    if (rows.length === 0) return { ok: true, reversed: 0, skipped: 0, failed: 0 };

    // ── Idempotency: signed net per (product, variant, warehouse) bucket.
    // Buckets already at net 0 are fully reversed → we won't touch them.
    const netByBucket = new Map<string, number>();
    // batch_no joins the bucket key so a batched (sofa) lot reverses against its
    // own dye-lot, not a co-mingled plain-FIFO net. Non-batched rows segment '' .
    const bucketKey = (r: Row) => `${r.warehouse_id}::${r.product_code}::${r.variant_key ?? ''}::${r.batch_no ?? ''}`;
    for (const r of rows) {
      if (r.movement_type !== 'IN' && r.movement_type !== 'OUT') continue;
      const signed = r.movement_type === 'IN' ? r.qty : -r.qty;
      const k = bucketKey(r);
      netByBucket.set(k, (netByBucket.get(k) ?? 0) + signed);
    }

    let reversed = 0, skipped = 0, failed = 0;
    // Track how much of each bucket's net we still need to neutralise as we walk
    // the original rows, so we don't over-reverse a bucket that's already square.
    const remaining = new Map(netByBucket);
    for (const r of rows) {
      if (r.movement_type !== 'IN' && r.movement_type !== 'OUT') { skipped += 1; continue; }
      const k = bucketKey(r);
      const net = remaining.get(k) ?? 0;
      if (net === 0) { skipped += 1; continue; } // bucket already fully reversed

      const opposite: 'IN' | 'OUT' = r.movement_type === 'IN' ? 'OUT' : 'IN';
      const row: MovementInput = {
        movement_type: opposite,
        warehouse_id: r.warehouse_id,
        product_code: r.product_code,
        variant_key: r.variant_key ?? '',
        product_name: r.product_name,
        qty: r.qty,
        // A reversing IN must carry the lot cost so stock re-enters at its
        // original basis; a reversing OUT lets the FIFO trigger compute COGS.
        ...(opposite === 'IN' ? { unit_cost_sen: Number(r.unit_cost_sen ?? 0) } : {}),
        // Carry the original row's batch (only when set) so the FIFO trigger
        // reverses the EXACT dye-lot, not any plain-FIFO lot. Non-batched stays NULL.
        ...(r.batch_no ? { batch_no: r.batch_no } : {}),
        source_doc_type: sourceDocType as MovementInput['source_doc_type'],
        source_doc_id: sourceDocId,
        source_doc_no: r.source_doc_no ?? undefined,
        performed_by: performedBy,
        notes: `Reversal of ${sourceDocType} ${r.source_doc_no ?? sourceDocId} (cancel/line-delete)`,
      };
      // Insert individually so a single collision (DO/DR same-key unique index)
      // doesn't abort the whole reversal.
      const res = await writeMovements(sb, [row]);
      if (res.ok) {
        reversed += 1;
        // Walk the remaining net toward 0 by the reversed direction's signed qty.
        remaining.set(k, net + (opposite === 'IN' ? r.qty : -r.qty));
      } else {
        failed += 1;
      }
    }
    return { ok: failed === 0, reversed, skipped, failed };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[inventory] reverseMovements exception:', e);
    return { ok: false, reversed: 0, skipped: 0, failed: 0, reason: e instanceof Error ? e.message : String(e) };
  }
}
