// ----------------------------------------------------------------------------
// /inventory/adjustments — the manual stock ADJUSTMENT write, split OFF the
// Inventory page's permission.
//
// WHY its own router: a stock adjustment changes inventory VALUATION, so the
// owner wants adjusting gated on a separate, more-sensitive permission than
// merely VIEWING the stock listing (owner 2026-07-18: viewing inventory and
// adjusting stock must be TWO separable permissions). Viewing the Inventory page
// (stock card / listing / warehouses / racks) stays on `scm.warehouse.inventory`;
// this write is gated on `scm.warehouse.adjustments`.
//
// WHY a dedicated sub-mount rather than a second guard on /inventory/*: the
// adjustment endpoint lives under the /inventory/* prefix, which is guarded by
// `scmAreaGuard('scm.warehouse.inventory')`. Hono runs ALL middleware whose
// pattern matches, so layering a second `scm.use('/inventory/adjustments', ...)`
// on top of the broad `/inventory/*` guard fires BOTH — the write would then
// require inventory AND adjustments, re-coupling what the split exists to
// separate. Mounting this as its own sub-router at `/inventory/adjustments`,
// registered in scm/index.ts BEFORE the broad `/inventory/*` guard, makes this
// router's handler return before the broad inventory guard is ever reached, so
// the write requires ONLY `scm.warehouse.adjustments`. The reads the adjustment
// FORM needs (warehouses, buckets, movements) remain on /inventory and stay
// gated on `scm.warehouse.inventory`.
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import {
  isAdjustmentReasonCode,
  computeVariantKey,
  adjustmentIncreaseErrors,
  type VariantAttrs,
} from '../shared';
import { supabaseAuth } from '../middleware/auth';
import { recomputeSoStockAllocation } from '../lib/so-stock-allocation';
import { activeCompanyId, scopeToCompany } from '../lib/companyScope';
import { recordEntityAudit, compactChanges, fieldChange } from '../lib/entity-audit';
import type { Env, Variables } from '../env';

export const inventoryAdjustments = new Hono<{ Bindings: Env; Variables: Variables }>();
inventoryAdjustments.use('*', supabaseAuth);

/* ── Manual stock correction ─────────────────────────────────────────────
   Mounted at '/', i.e. POST /inventory/adjustments. */
inventoryAdjustments.post('/', async (c) => {
  const sb = c.get('supabase'); const user = c.get('user');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }

  if (!body.warehouseId || !body.productCode) return c.json({ error: 'warehouse_and_product_required' }, 400);
  const qtyDelta = Number(body.qtyDelta ?? 0);
  if (!Number.isFinite(qtyDelta) || qtyDelta === 0) return c.json({ error: 'invalid_qty_delta' }, 400);

  // Structured reason is mandatory on a manual adjustment (audit trail).
  // Validated against the shared catalogue — single source of truth shared
  // with the frontend dropdown.
  const reasonCode = String(body.reasonCode ?? '');
  if (!isAdjustmentReasonCode(reasonCode)) return c.json({ error: 'reason_required' }, 400);

  const warehouseId = String(body.warehouseId);
  const productCode = String(body.productCode);
  const itemGroup = (body.itemGroup as string | undefined) ?? null;
  const variants = (body.variants as Record<string, unknown> | null | undefined) ?? null;
  const batchNo = ((body.batchNo as string | undefined) ?? '').trim() || null;

  // Resolve which stock bucket (variant_key + batch_no) this adjustment hits.
  //   • INCREASE behaves like a mini-receipt: compute variant_key from the chosen
  //     attributes (mirrors GRN) and gate on the shared variant+batch rule so the
  //     found stock isn't stranded in the unclassified / no-batch bucket.
  //   • DECREASE targets an EXISTING bucket the operator picked, so it arrives
  //     with an explicit variantKey + batchNo; we only verify enough is on hand
  //     (no orphan / negative bucket).
  let variantKey: string;
  if (qtyDelta > 0) {
    const errs = adjustmentIncreaseErrors(itemGroup, variants, batchNo);
    if (errs.length > 0) return c.json({ error: 'adjustment_incomplete', message: errs.join(' ') }, 422);
    variantKey = body.variantKey != null
      ? String(body.variantKey)
      : computeVariantKey(itemGroup, (variants as VariantAttrs | null) ?? null);
  } else {
    variantKey = String(body.variantKey ?? '');
    let avQ = sb.from('v_inventory_lots_open')
      .select('qty_remaining')
      .eq('warehouse_id', warehouseId)
      .eq('product_code', productCode)
      .eq('variant_key', variantKey);
    avQ = scopeToCompany(avQ, c); // multi-company: isolate available-stock check to the active company (view exposes company_id, mig 0106)
    avQ = batchNo == null ? avQ.is('batch_no', null) : avQ.eq('batch_no', batchNo);
    const { data: openLots } = await avQ;
    const available = ((openLots ?? []) as Array<{ qty_remaining: number | null }>)
      .reduce((s, l) => s + Number(l.qty_remaining ?? 0), 0);
    if (Math.abs(qtyDelta) > available) {
      return c.json({
        error: 'insufficient_bucket',
        message: `Only ${available} on hand in that batch/variant — you can't take out ${Math.abs(qtyDelta)}.`,
      }, 422);
    }
  }

  const { data, error } = await sb.from('inventory_movements').insert({
    company_id: activeCompanyId(c), // multi-company: stamp the active company
    movement_type: 'ADJUSTMENT',
    warehouse_id: warehouseId,
    product_code: productCode,
    // Attribute-composition bucket (migration 0095) + dye-lot batch (0120). An
    // increase computes these from the chosen attributes; a decrease carries the
    // picked existing bucket. The FIFO trigger (0126) honours batch_no on
    // ADJUSTMENT: +qty creates a batched lot, −qty consumes the batch FIFO.
    variant_key: variantKey,
    batch_no: batchNo,
    product_name: (body.productName as string) ?? null,
    qty: qtyDelta,
    unit_cost_sen: Number(body.unitCostSen ?? 0),
    source_doc_type: 'ADJUSTMENT',
    reason_code: reasonCode,
    notes: (body.notes as string) ?? null,
    performed_by: user.id,
  }).select('id').single();
  if (error) return c.json({ error: 'insert_failed', reason: error.message }, 500);

  /* A manual adjustment has no header document — the movement row IS the
     document, so the movement id is the entity id. This is the only path in the
     module that lets a person change on-hand by typing a number, which makes it
     the one that most needs a name attached to it. */
  await recordEntityAudit(sb, {
    entityType: 'INVENTORY_ADJUSTMENT',
    entityId: (data as { id: string }).id,
    action: 'CREATE',
    actor: c.get('houzsUser'),
    companyId: activeCompanyId(c),
    note: reasonCode,
    fieldChanges: compactChanges([
      fieldChange('warehouseId', null, warehouseId),
      fieldChange('productCode', null, productCode),
      fieldChange('variantKey', null, variantKey),
      fieldChange('batchNo', null, batchNo),
      fieldChange('qtyDelta', null, qtyDelta),
      fieldChange('reasonCode', null, reasonCode),
      fieldChange('unitCostSen', null, Number(body.unitCostSen ?? 0)),
      fieldChange('notes', null, (body.notes as string | undefined) ?? null),
    ]),
  });

  /* Audit 2026-06-10 #12 — every other stock-mutating path re-walks the SO
     allocation; a manual adjustment was the one forgotten path. A write-off
     left SO lines READY against vanished stock; a found-stock increase didn't
     flip PENDING→READY until some unrelated document touched stock. */
  try { await recomputeSoStockAllocation(sb); } catch { /* best-effort */ }
  return c.json({ movement: data }, 201);
});
