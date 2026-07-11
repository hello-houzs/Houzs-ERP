// /consignment-returns — Consignment Return (CRN): consignment goods come back.
// A faithful clone of the Delivery Return API
// (apps/api/src/routes/delivery-returns.ts).
//
// UNIFIED inventory model (Wei Siang 2026-06-06): a Consignment Return now books
// a plain IN to the destination warehouse exactly like a Delivery Return — goods
// physically re-enter inventory at the return line's snapshot cost, recorded as a
// plain IN tagged CS_DR in the same stock ledger. Cancelling writes a balancing
// OUT. (Superseded the earlier value-neutral transfer-from-hidden-warehouse model.)
//
// Tables: consignment_delivery_returns / _items (migration 0153). The DR's
// delivery_order_id / do_item_id become consignment_do_id /
// consignment_do_item_id (→ consignment_delivery_orders / _items).
//
// DROPPED vs the DR clone:
//   • the "no DO, no return" hard requirement — RELAXED: a consignment return may
//     reference a Consignment Note OR be free-entry (the loaner can come back
//     without a linked note).
//   • /from-do, /from-dos pickers + the over-return remaining guard (DO-pipeline).
//   • reopenSoFromReturn (SO-specific) + COGS / margin recognition.
//
// Mounted at '/consignment-returns' in apps/api/src/index.ts. Numbering CRN-YYMM-NNN.

import { Hono } from 'hono';
import { normalizePhone } from '../shared/phone';
import { buildVariantSummary } from '../shared';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { defaultWarehouseId, writeMovements, resolveWarehouseLotBatches, resolveWarehouseLotCosts } from '../lib/inventory-movements';
import { computeVariantKey, type VariantAttrs } from '../shared';
import { validateItemCodes, unknownItemCodeResponse } from '../lib/validate-item-codes';
import { nextMonthlyDocNo, insertWithDocNoRetry } from '../lib/doc-no';
import { todayMyt } from '../lib/my-time';
import { paginateAll, chunkIn } from '../lib/paginate-all';
import { scopeToCompany, activeCompanyId, stampCompany } from '../lib/companyScope';

export const consignmentReturns = new Hono<{ Bindings: Env; Variables: Variables }>();
consignmentReturns.use('*', supabaseAuth);

const HEADER =
  'id, return_number, do_doc_no, consignment_do_id, ' +
  'debtor_code, debtor_name, return_date, reason, status, ' +
  'received_at, inspected_at, refunded_at, refund_centi, inspection_notes, ' +
  'salesperson_id, agent, email, customer_type, building_type, branding, venue, venue_id, ref, ' +
  'customer_so_no, sales_location, customer_state, customer_country, note, ' +
  'address1, address2, city, state, postcode, phone, ' +
  'emergency_contact_name, emergency_contact_phone, emergency_contact_relationship, ' +
  'mattress_sofa_centi, bedframe_centi, accessories_centi, others_centi, ' +
  'mattress_sofa_cost_centi, bedframe_cost_centi, accessories_cost_centi, others_cost_centi, ' +
  'local_total_centi, total_cost_centi, total_margin_centi, margin_pct_basis, line_count, ' +
  'currency, warehouse_id, notes, created_at, created_by, updated_at';

const ITEM =
  'id, consignment_delivery_return_id, consignment_do_item_id, item_code, item_group, description, description2, ' +
  'uom, qty_returned, condition, unit_price_centi, discount_centi, line_total_centi, ' +
  'unit_cost_centi, line_cost_centi, line_margin_centi, refund_centi, variants, notes, created_at';

const nextNum = async (sb: any): Promise<string> => {
  const d = new Date();
  const yymm = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`;
  const { data: existing } = await sb.from('consignment_delivery_returns').select('return_number').like('return_number', `CRN-${yymm}-%`);
  return nextMonthlyDocNo(`CRN-${yymm}`, ((existing ?? []) as Array<{ return_number: string }>).map((r) => r.return_number));
};

/* Re-derive the return header's per-category totals + grand total from its line
   items. Plain per-category rollup, copied from the DR. */
async function recomputeTotals(sb: any, returnId: string) {
  const { data: items } = await sb.from('consignment_delivery_return_items')
    .select('item_group, line_total_centi, line_cost_centi')
    .eq('consignment_delivery_return_id', returnId);
  let mattressSofa = 0, bedframe = 0, accessories = 0, others = 0, total = 0, totalCost = 0;
  let mattressSofaCost = 0, bedframeCost = 0, accessoriesCost = 0, othersCost = 0;
  for (const it of (items ?? []) as Array<{ item_group: string | null; line_total_centi: number | null; line_cost_centi: number | null }>) {
    const lineTotal = Number(it.line_total_centi ?? 0);
    const lineCost  = Number(it.line_cost_centi ?? 0);
    total += lineTotal;
    totalCost += lineCost;
    const g = (it.item_group ?? '').toLowerCase();
    if (g.includes('mattress') || g.includes('sofa')) { mattressSofa += lineTotal; mattressSofaCost += lineCost; }
    else if (g.includes('bedframe')) { bedframe += lineTotal; bedframeCost += lineCost; }
    else if (g.includes('accessor')) { accessories += lineTotal; accessoriesCost += lineCost; }
    else { others += lineTotal; othersCost += lineCost; }
  }
  const margin = total - totalCost;
  await sb.from('consignment_delivery_returns').update({
    mattress_sofa_centi: mattressSofa,
    bedframe_centi: bedframe,
    accessories_centi: accessories,
    others_centi: others,
    mattress_sofa_cost_centi: mattressSofaCost,
    bedframe_cost_centi: bedframeCost,
    accessories_cost_centi: accessoriesCost,
    others_cost_centi: othersCost,
    local_total_centi: total,
    total_cost_centi: totalCost,
    total_margin_centi: margin,
    margin_pct_basis: total > 0 ? Math.round((margin / total) * 10000) : 0,
    line_count: (items ?? []).length,
    refund_centi: total,
    updated_at: new Date().toISOString(),
  }).eq('id', returnId);
}

/* ── resolveReturnLineWarehouses ──────────────────────────────────────────────
   Per-line DESTINATION warehouse for the loaner coming back. A returned line
   re-enters the warehouse its Consignment Note line shipped FROM:
     1. linked CN line → consignment_so_item_id → consignment_sales_order_items.warehouse_id
     2. linked CN header's warehouse_id
     3. the return header's warehouse_id (free-entry lines — allowed here, since
        "no DO, no return" is RELAXED for consignment)
     4. the global default warehouse
   Returns map of item id → warehouse_id (null when even the fallbacks are
   absent — the caller skips that line). */
async function resolveReturnLineWarehouses(
  sb: any,
  items: Array<{ id: string; consignment_do_item_id?: string | null }>,
  headerWarehouseId: string | null,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const cnItemIds = [...new Set(items
    .map((it) => it.consignment_do_item_id ?? null)
    .filter((x): x is string => !!x))];

  // CN line id → { consignment_so_item_id, CN header warehouse }
  const cnLineMeta = new Map<string, { soItemId: string | null; cnWarehouseId: string | null }>();
  const soItemIds = new Set<string>();
  if (cnItemIds.length > 0) {
    const { data: cnLines } = await sb.from('consignment_delivery_order_items')
      .select('id, consignment_so_item_id, consignment_delivery_order_id').in('id', cnItemIds);
    const cnRows = (cnLines ?? []) as Array<{ id: string; consignment_so_item_id: string | null; consignment_delivery_order_id: string }>;
    const cnIds = [...new Set(cnRows.map((r) => r.consignment_delivery_order_id).filter(Boolean))];
    const cnHeaderWh = new Map<string, string | null>();
    if (cnIds.length > 0) {
      const { data: cnHeaders } = await sb.from('consignment_delivery_orders')
        .select('id, warehouse_id').in('id', cnIds);
      for (const d of (cnHeaders ?? []) as Array<{ id: string; warehouse_id: string | null }>) {
        cnHeaderWh.set(d.id, d.warehouse_id ?? null);
      }
    }
    for (const r of cnRows) {
      if (r.consignment_so_item_id) soItemIds.add(r.consignment_so_item_id);
      cnLineMeta.set(r.id, { soItemId: r.consignment_so_item_id ?? null, cnWarehouseId: cnHeaderWh.get(r.consignment_delivery_order_id) ?? null });
    }
  }

  const soWh = new Map<string, string | null>();
  if (soItemIds.size > 0) {
    const { data: soRows } = await sb.from('consignment_sales_order_items')
      .select('id, warehouse_id').in('id', [...soItemIds]);
    for (const r of (soRows ?? []) as Array<{ id: string; warehouse_id: string | null }>) {
      soWh.set(r.id, r.warehouse_id ?? null);
    }
  }

  const fallback = headerWarehouseId ?? (await defaultWarehouseId(sb));
  for (const it of items) {
    const meta = it.consignment_do_item_id ? cnLineMeta.get(it.consignment_do_item_id) : undefined;
    const fromSo = meta?.soItemId ? (soWh.get(meta.soItemId) ?? null) : null;
    out.set(it.id, fromSo ?? meta?.cnWarehouseId ?? fallback);
  }
  return out;
}

/* warehouse_id → display CODE for the per-line Warehouse column on detail GET. */
async function warehouseCodeMap(
  sb: any,
  ids: Array<string | null | undefined>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const uniq = [...new Set(ids.filter((x): x is string => !!x))];
  if (uniq.length === 0) return out;
  const { data } = await sb.from('warehouses').select('id, code, name').in('id', uniq);
  for (const w of (data ?? []) as Array<{ id: string; code: string | null; name: string | null }>) {
    out.set(w.id, w.code ?? w.name ?? '');
  }
  return out;
}

/* ── resyncReturnInventory — self-healing IN ledger for a Consignment Return ───
   ONE function for the whole lifecycle (receive / add-line / edit-qty /
   delete-line / cancel), mirroring resyncNoteInventory but IN-primary (a return
   books stock back IN). It reconciles the return's CURRENT lines (the TARGET net
   IN per warehouse/product/variant/batch bucket) against what inventory_movements
   already record for this return, and writes only the DELTA:
     • first-ever IN for a bucket   → CS_DR  (carries the "stock back IN" label +
       the CS_DR partial-unique-index idempotency backstop)
     • any later increase           → STOCK_TRANSFER IN (no unique index → no
       collision with the CS_DR row)
     • any decrease / give-back     → STOCK_TRANSFER OUT
     • cancel → status CANCELLED → TARGET is empty → every bucket's net is driven
       back to 0 via STOCK_TRANSFER OUT.
   A return posts immediately on create — there is no SHIPPED_STATES gate; it is
   "active" (books IN) whenever status !== 'CANCELLED'. Idempotent: a re-run finds
   delta 0 everywhere and writes nothing. Best-effort. */
async function resyncReturnInventory(sb: any, returnId: string, performedBy: string | null): Promise<string[]> {
  const { data: header } = await sb.from('consignment_delivery_returns')
    .select('return_number, status, warehouse_id').eq('id', returnId).maybeSingle();
  if (!header) return [];
  const status = ((header as { status: string | null }).status ?? '').toUpperCase();
  const returnNo = (header as { return_number: string }).return_number ?? returnId;
  const cancelled = status === 'CANCELLED';

  // 1. TARGET net IN per bucket = sum of current lines (empty if cancelled).
  type Bucket = { warehouse_id: string; product_code: string; variant_key: string; product_name: string | null; qty: number; unit_cost_sen: number; batch_no: string | null };
  const targetByBucket = new Map<string, Bucket>();
  if (!cancelled) {
    const { data: items } = await sb.from('consignment_delivery_return_items')
      .select('id, consignment_do_item_id, item_code, description, qty_returned, unit_cost_centi, item_group, variants')
      .eq('consignment_delivery_return_id', returnId);
    const headerWarehouseId = (header as { warehouse_id: string | null }).warehouse_id ?? null;
    const lineWh = await resolveReturnLineWarehouses(sb, (items ?? []) as Array<{ id: string; consignment_do_item_id?: string | null }>, headerWarehouseId);
    const distinctWh = [...new Set(((items ?? []) as Array<{ id: string }>).map((it) => lineWh.get(it.id)).filter((x): x is string => !!x))];
    const batchByWh = new Map<string, Map<string, string | null>>();
    const costByWh = new Map<string, Map<string, number>>();
    for (const wh of distinctWh) { batchByWh.set(wh, await resolveWarehouseLotBatches(sb, wh)); costByWh.set(wh, await resolveWarehouseLotCosts(sb, wh)); }
    for (const it of ((items ?? []) as Array<{ id: string; item_code: string; description: string | null; qty_returned: number; unit_cost_centi?: number | null; item_group?: string | null; variants?: VariantAttrs | null }>)) {
      const qty = Number(it.qty_returned ?? 0);
      if (qty <= 0) continue;
      const wh = lineWh.get(it.id) ?? null;
      if (!wh) continue;
      const vk = computeVariantKey(it.item_group ?? null, it.variants ?? null);
      const batch = batchByWh.get(wh)?.get(`${it.item_code}::${vk}`) ?? null;
      // Cost = the return line's snapshot; if it's 0 (free-entry return with no
      // cost), fall back to the SKU's current on-hand avg cost so we don't open a
      // 0-cost lot that a later FIFO sale would eat and under-state its COGS.
      const lineCost = Number(it.unit_cost_centi ?? 0);
      const unitCost = lineCost > 0 ? lineCost : (costByWh.get(wh)?.get(`${it.item_code}::${vk}`) ?? 0);
      const k = `${wh}::${it.item_code}::${vk}::${batch ?? ''}`;
      const cur = targetByBucket.get(k);
      if (cur) cur.qty += qty;
      else targetByBucket.set(k, { warehouse_id: wh, product_code: it.item_code, variant_key: vk, product_name: it.description, qty, unit_cost_sen: unitCost, batch_no: batch });
    }
  }

  // 2. CURRENT net IN per bucket from ALL this return's movements (CS_DR IN +
  //    any prior STOCK_TRANSFER resync/cancel deltas).
  const { data: movs } = await sb.from('inventory_movements')
    .select('movement_type, warehouse_id, product_code, variant_key, batch_no, qty, total_cost_sen, product_name')
    .eq('source_doc_id', returnId)
    .in('source_doc_type', ['CS_DR', 'STOCK_TRANSFER']);
  type Agg = { in_qty: number; out_qty: number; in_total_cost: number; product_name: string | null };
  const aggByBucket = new Map<string, Agg>();
  for (const m of (movs ?? []) as Array<{ movement_type: string; warehouse_id: string; product_code: string; variant_key: string | null; batch_no?: string | null; qty: number; total_cost_sen: number | null; product_name: string | null }>) {
    const k = `${m.warehouse_id}::${m.product_code}::${m.variant_key ?? ''}::${m.batch_no ?? ''}`;
    let a = aggByBucket.get(k);
    if (!a) { a = { in_qty: 0, out_qty: 0, in_total_cost: 0, product_name: m.product_name }; aggByBucket.set(k, a); }
    if (m.movement_type === 'IN') { a.in_qty += Number(m.qty ?? 0); a.in_total_cost += Number(m.total_cost_sen ?? 0); }
    else if (m.movement_type === 'OUT') a.out_qty += Number(m.qty ?? 0);
    if (!a.product_name) a.product_name = m.product_name;
  }

  // 3. delta = target − current_net_in. >0 → book more IN; <0 → give stock back OUT.
  type MovOut = Parameters<typeof writeMovements>[1][number];
  const writes: MovOut[] = [];
  const csDrEmitted = new Set<string>(); // product::variant given a CS_DR this run (avoid 2nd-warehouse collision)
  for (const k of new Set<string>([...targetByBucket.keys(), ...aggByBucket.keys()])) {
    const t = targetByBucket.get(k);
    const a = aggByBucket.get(k) ?? { in_qty: 0, out_qty: 0, in_total_cost: 0, product_name: null };
    const delta = (t?.qty ?? 0) - (a.in_qty - a.out_qty);
    if (delta === 0) continue;
    const [wh, pc, vk, batchSeg] = k.split('::');
    const batch_no = batchSeg || null;
    const pname = t?.product_name ?? a.product_name ?? null;
    if (delta > 0) {
      // First IN for this product+variant → CS_DR (label + strict index guard);
      // any later increase (or a 2nd warehouse for the same SKU) → STOCK_TRANSFER.
      const neverMoved = a.in_qty === 0 && a.out_qty === 0;
      const useCsDr = neverMoved && !csDrEmitted.has(`${pc}::${vk}`);
      if (useCsDr) csDrEmitted.add(`${pc}::${vk}`);
      writes.push({
        movement_type: 'IN', warehouse_id: wh ?? '', product_code: pc ?? '', variant_key: vk ?? '', product_name: pname,
        qty: delta, unit_cost_sen: t?.unit_cost_sen ?? 0,
        source_doc_type: useCsDr ? 'CS_DR' : 'STOCK_TRANSFER',
        source_doc_id: returnId, source_doc_no: returnNo,
        ...(batch_no ? { batch_no } : {}),
        performed_by: performedBy,
        notes: useCsDr ? 'Consignment Return — stock back IN' : 'Consignment Return resync: line qty increased / added.',
      });
    } else {
      writes.push({
        movement_type: 'OUT', warehouse_id: wh ?? '', product_code: pc ?? '', variant_key: vk ?? '', product_name: pname,
        qty: -delta,
        source_doc_type: 'STOCK_TRANSFER',
        source_doc_id: returnId, source_doc_no: cancelled ? `${returnNo}-CANCEL` : returnNo,
        ...(batch_no ? { batch_no } : {}),
        performed_by: performedBy,
        notes: cancelled ? 'Consignment Return cancelled — stock out again' : 'Consignment Return resync: line qty reduced / deleted.',
      });
    }
  }

  if (writes.length === 0) return [];
  const res = await writeMovements(sb, writes);
  try {
    const { recomputeSoStockAllocation } = await import('../lib/so-stock-allocation');
    await recomputeSoStockAllocation(sb);
  } catch { /* best-effort */ }
  return res.ok ? [] : [res.reason ?? 'consignment return inventory resync failed'];
}

/* Build one consignment_delivery_return_items insert row from a client line
   payload. Shared by POST / (bulk create) and POST /:id/items (single add). */
function buildItemRow(returnId: string, it: Record<string, unknown>) {
  const qty = Number(it.qtyReturned ?? it.qty ?? 1);
  const unitPrice = Number(it.unitPriceCenti ?? 0);
  const discount = Number(it.discountCenti ?? 0);
  const unitCost = Number(it.unitCostCenti ?? 0);
  const lineTotal = (qty * unitPrice) - discount;
  const lineCost = qty * unitCost;
  const itemGroup = (it.itemGroup as string) ?? null;
  const variants = (it.variants as unknown) ?? null;
  const refund = it.refundCenti !== undefined ? Number(it.refundCenti) : lineTotal;
  return {
    consignment_delivery_return_id: returnId,
    consignment_do_item_id: (it.doItemId as string | undefined) ?? (it.consignmentDoItemId as string | undefined) ?? null,
    item_code: it.itemCode,
    item_group: itemGroup,
    description: (it.description as string) ?? null,
    description2: buildVariantSummary(String(itemGroup ?? ''), (variants as Record<string, unknown> | null) ?? null) || (it.description2 as string) || null,
    uom: (it.uom as string) ?? 'UNIT',
    qty_returned: qty,
    condition: (it.condition as string) ?? null,
    unit_price_centi: unitPrice,
    discount_centi: discount,
    line_total_centi: lineTotal,
    unit_cost_centi: unitCost,
    line_cost_centi: lineCost,
    line_margin_centi: lineTotal - lineCost,
    refund_centi: refund,
    variants,
    notes: (it.notes as string | undefined) ?? null,
  };
}

// ── List ────────────────────────────────────────────────────────────────
consignmentReturns.get('/', async (c) => {
  const sb = c.get('supabase');
  let q = sb.from('consignment_delivery_returns').select(HEADER).order('return_date', { ascending: false }).limit(500);
  const status = c.req.query('status'); if (status) q = q.eq('status', status);
  q = scopeToCompany(q, c); // multi-company: isolate to the active company
  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ deliveryReturns: data ?? [] });
});

// ── Returnable Consignment Note lines (From-Note multi-picker) ────────────
// Every consignment_delivery_order_item, with remaining = delivered (qty) −
// already-returned (sum of qty_returned across non-cancelled Consignment Returns
// linked to that note line via consignment_do_item_id). Only remaining > 0 lines
// are pickable. Mirrors the DO→DR /returnable-do-lines endpoint. MUST be
// registered before /:id so 'returnable-note-lines' isn't read as an id.
consignmentReturns.get('/returnable-note-lines', async (c) => {
  const sb = c.get('supabase');
  const { data: notes, error: nErr } = await paginateAll<{ id: string; do_number: string; debtor_code: string | null; debtor_name: string | null }>((from, to) => sb
    .from('consignment_delivery_orders')
    .select('id, do_number, debtor_code, debtor_name')
    .order('do_number', { ascending: false })
    .range(from, to));
  if (nErr) return c.json({ error: 'load_failed', reason: nErr.message }, 500);
  const noteList = (notes ?? []) as Array<{ id: string; do_number: string; debtor_code: string | null; debtor_name: string | null }>;
  if (noteList.length === 0) return c.json({ lines: [] });
  const noteById = new Map(noteList.map((n) => [n.id, n]));
  const noteIds = noteList.map((n) => n.id);

  const { data: items, error: iErr } = await chunkIn<Record<string, unknown>>(noteIds, (batch, from, to) => sb
    .from('consignment_delivery_order_items')
    .select('id, consignment_delivery_order_id, item_code, item_group, description, description2, uom, qty, unit_price_centi, discount_centi, unit_cost_centi, variants')
    .in('consignment_delivery_order_id', batch)
    .range(from, to));
  if (iErr) return c.json({ error: 'load_failed', reason: iErr.message }, 500);
  const itemList = (items ?? []) as Array<Record<string, unknown>>;
  if (itemList.length === 0) return c.json({ lines: [] });
  const itemIds = itemList.map((it) => it.id as string);

  // Already-returned per note line — only count non-cancelled returns.
  const { data: relRows } = await sb
    .from('consignment_delivery_returns')
    .select('id, status')
    .neq('status', 'CANCELLED');
  const liveReturnIds = new Set(((relRows ?? []) as Array<{ id: string }>).map((r) => r.id));
  const { data: retItems } = await chunkIn<{ consignment_delivery_return_id: string; consignment_do_item_id: string | null; qty_returned: number }>(itemIds, (batch, from, to) => sb
    .from('consignment_delivery_return_items')
    .select('consignment_delivery_return_id, consignment_do_item_id, qty_returned')
    .in('consignment_do_item_id', batch)
    .range(from, to));
  const returnedByItem = new Map<string, number>();
  for (const r of ((retItems ?? []) as Array<{ consignment_delivery_return_id: string; consignment_do_item_id: string | null; qty_returned: number }>)) {
    if (!r.consignment_do_item_id || !liveReturnIds.has(r.consignment_delivery_return_id)) continue;
    returnedByItem.set(r.consignment_do_item_id, (returnedByItem.get(r.consignment_do_item_id) ?? 0) + Number(r.qty_returned ?? 0));
  }

  const lines = itemList.map((it) => {
    const note = noteById.get(it.consignment_delivery_order_id as string);
    const delivered = Number(it.qty ?? 0);
    const returned = returnedByItem.get(it.id as string) ?? 0;
    return {
      noteItemId: it.id as string,
      consignmentDoId: it.consignment_delivery_order_id as string,
      noteNumber: note?.do_number ?? '',
      debtorCode: note?.debtor_code ?? null,
      debtorName: note?.debtor_name ?? null,
      itemCode: it.item_code as string,
      itemGroup: (it.item_group as string | null) ?? null,
      description: (it.description as string | null) ?? null,
      description2: (it.description2 as string | null) ?? null,
      uom: (it.uom as string | null) ?? null,
      delivered,
      returned,
      remaining: delivered - returned,
      unitPriceCenti: Number(it.unit_price_centi ?? 0),
      discountCenti: Number(it.discount_centi ?? 0),
      unitCostCenti: Number(it.unit_cost_centi ?? 0),
      variants: it.variants ?? null,
    };
  }).filter((l) => l.remaining > 0);

  return c.json({ lines });
});

// ── Detail ──────────────────────────────────────────────────────────────
consignmentReturns.get('/:id', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  const [h, i] = await Promise.all([
    sb.from('consignment_delivery_returns').select(HEADER).eq('id', id).maybeSingle(),
    sb.from('consignment_delivery_return_items').select(ITEM).eq('consignment_delivery_return_id', id).order('created_at'),
  ]);
  if (h.error) return c.json({ error: 'load_failed', reason: h.error.message }, 500);
  if (!h.data) return c.json({ error: 'not_found' }, 404);
  const rawItems = (i.data ?? []) as unknown as Array<{ id: string; consignment_do_item_id?: string | null } & Record<string, unknown>>;
  const headerWh = (h.data as { warehouse_id?: string | null }).warehouse_id ?? null;
  const lineWh = await resolveReturnLineWarehouses(sb, rawItems, headerWh);
  const codeMap = await warehouseCodeMap(sb, [...lineWh.values()]);
  const items = rawItems.map((it) => {
    const wid = lineWh.get(it.id) ?? null;
    return { ...it, warehouse_id: wid, warehouse_code: wid ? (codeMap.get(wid) ?? null) : null };
  });
  return c.json({ deliveryReturn: h.data, items });
});

/* Insert the return header from a client body. Shared by POST /. */
async function insertHeader(sb: any, userId: string, body: Record<string, unknown>) {
  const phoneRaw = (body.phone as string | undefined) ?? null;
  const emPhoneRaw = (body.emergencyContactPhone as string | undefined) ?? null;
  return insertWithDocNoRetry<{ id: string; return_number: string }>(
    () => nextNum(sb),
    (returnNumber) => sb.from('consignment_delivery_returns').insert({
    return_number: returnNumber,
    do_doc_no: (body.doDocNo as string) ?? (body.cnDocNo as string) ?? null,
    consignment_do_id: (body.consignmentDoId as string) ?? (body.deliveryOrderId as string) ?? null,
    debtor_code: (body.debtorCode as string) ?? null,
    debtor_name: (body.debtorName ?? body.customerName) as string,
    return_date: (body.returnDate as string) ?? todayMyt(),
    reason: (body.reason as string) ?? null,
    address1: (body.address1 as string) ?? null,
    address2: (body.address2 as string) ?? null,
    city: (body.city as string) ?? null,
    state: (body.state as string) ?? (body.customerState as string) ?? null,
    customer_state: (body.customerState as string) ?? (body.state as string) ?? null,
    customer_country: (body.customerCountry as string) ?? null,
    postcode: (body.postcode as string) ?? null,
    phone: phoneRaw ? (normalizePhone(phoneRaw) ?? phoneRaw) : null,
    salesperson_id: (body.salespersonId as string) ?? null,
    agent: (body.agent as string) ?? null,
    email: (body.email as string) ?? null,
    customer_type: (body.customerType as string) ?? null,
    building_type: (body.buildingType as string) ?? null,
    branding: (body.branding as string) ?? null,
    venue: (body.venue as string) ?? null,
    venue_id: (body.venueId as string) ?? null,
    ref: (body.ref as string) ?? null,
    customer_so_no: (body.customerSoNo as string) ?? null,
    sales_location: (body.salesLocation as string) ?? null,
    note: (body.note as string) ?? null,
    emergency_contact_name: (body.emergencyContactName as string) ?? null,
    emergency_contact_phone: emPhoneRaw ? (normalizePhone(emPhoneRaw) ?? emPhoneRaw) : null,
    emergency_contact_relationship: (body.emergencyContactRelationship as string) ?? null,
    warehouse_id: (body.warehouseId as string) ?? null,
    currency: (body.currency as string) ?? 'MYR',
    /* A return = the loaner is RECEIVED back the moment it's created. Start at
       RECEIVED and transfer it back to the shipping warehouse right after the
       items insert. */
    status: 'RECEIVED',
    received_at: new Date().toISOString(),
    notes: (body.notes as string) ?? null,
    created_by: userId,
    }).select(HEADER).single(),
  );
}

// ── Create ──────────────────────────────────────────────────────────────
// Accepts the full header + line items. A return is RECEIVED on creation → the
// loaner is transferred back to the shipping warehouse immediately (idempotent).
// "no DO, no return" is RELAXED — lines may reference a Consignment Note line
// (consignmentDoItemId) OR be free-entry.
consignmentReturns.post('/', async (c) => {
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const debtorName = (body.debtorName ?? body.customerName) as string | undefined;
  if (!debtorName) return c.json({ error: 'debtor_name_required' }, 400);
  const items = (body.items as Array<Record<string, unknown>> | undefined) ?? [];
  if (!Array.isArray(items) || items.length === 0) return c.json({ error: 'items_required' }, 400);

  const sb = c.get('supabase'); const user = c.get('user');

  /* itemCode catalog guard. */
  {
    const codeCheck = await validateItemCodes(sb, items.map((it) => it.itemCode as string | null | undefined));
    if (!codeCheck.ok) return c.json(unknownItemCodeResponse(codeCheck.unknown), 409);
  }

  /* DROPPED vs DR: the "no DO, no Return" hard requirement and the over-return
     remaining guard. A consignment return may be free-entry or note-linked. */

  const { data: header, error: hErr } = await insertHeader(sb, user.id, body);
  if (hErr) return c.json({ error: 'insert_failed', reason: hErr.message }, 500);
  const h = header as unknown as { id: string; return_number: string };

  const rows = items.map((it) => buildItemRow(h.id, it));
  const { error: iErr } = await sb.from('consignment_delivery_return_items').insert(rows);
  if (iErr) { await sb.from('consignment_delivery_returns').delete().eq('id', h.id); return c.json({ error: 'items_insert_failed', reason: iErr.message }, 500); }
  await recomputeTotals(sb, h.id);

  /* The loaner comes back → book a plain IN to the destination warehouse.
     Self-healing resync (idempotent + best-effort). */
  const movementErrors = await resyncReturnInventory(sb, h.id, user.id);

  return c.json({ id: h.id, returnNumber: h.return_number, movementErrors: movementErrors.length ? movementErrors : undefined }, 201);
});

// ── Header PATCH (editable fields) ─────────────────────────────────────────
consignmentReturns.patch('/:id', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }

  const map: Array<[string, string]> = [
    ['debtorCode', 'debtor_code'], ['debtorName', 'debtor_name'], ['agent', 'agent'],
    ['salesLocation', 'sales_location'], ['ref', 'ref'],
    ['venue', 'venue'], ['venueId', 'venue_id'], ['branding', 'branding'],
    ['address1', 'address1'], ['address2', 'address2'],
    ['city', 'city'], ['state', 'state'], ['postcode', 'postcode'], ['phone', 'phone'],
    ['note', 'note'], ['notes', 'notes'], ['reason', 'reason'],
    ['returnDate', 'return_date'], ['currency', 'currency'],
    ['customerState', 'customer_state'], ['customerCountry', 'customer_country'],
    ['customerSoNo', 'customer_so_no'],
    ['email', 'email'], ['customerType', 'customer_type'],
    ['salespersonId', 'salesperson_id'], ['buildingType', 'building_type'],
    ['emergencyContactName', 'emergency_contact_name'],
    ['emergencyContactPhone', 'emergency_contact_phone'],
    ['emergencyContactRelationship', 'emergency_contact_relationship'],
  ];
  const PHONE_FIELDS = new Set(['phone', 'emergencyContactPhone']);
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const [from, to] of map) {
    if (body[from] === undefined) continue;
    if (PHONE_FIELDS.has(from) && typeof body[from] === 'string') {
      const raw = body[from] as string;
      updates[to] = normalizePhone(raw) ?? raw;
    } else {
      updates[to] = body[from];
    }
  }
  if (Object.keys(updates).length === 1) return c.json({ ok: true, changed: 0 });

  const { data, error } = await sb.from('consignment_delivery_returns').update(updates).eq('id', id).select('id').maybeSingle();
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  if (!data) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true, id });
});

// ── Item CRUD ─────────────────────────────────────────────────────────────
/* A REFUNDED / CREDIT_NOTED / CANCELLED return is terminal — lock line edits to
   ACTIVE returns (mirrors pcReturnLineLock on the purchase side). Editing a
   terminal return re-runs recomputeTotals + resyncReturnInventory, which would
   rewrite settled totals and (for non-cancelled terminal states) re-book stock. */
async function returnLineLock(sb: any, id: string): Promise<{ error: string; message: string } | null> {
  const { data } = await sb.from('consignment_delivery_returns').select('status').eq('id', id).maybeSingle();
  const st = (data as { status: string } | null)?.status;
  if (st === 'CANCELLED') return { error: 'return_cancelled', message: 'This consignment return is cancelled — its lines can no longer be changed.' };
  if (st === 'REFUNDED') return { error: 'return_refunded', message: 'This consignment return is refunded — its lines can no longer be changed.' };
  if (st === 'CREDIT_NOTED') return { error: 'return_credit_noted', message: 'This consignment return is credit-noted — its lines can no longer be changed.' };
  return null;
}

consignmentReturns.post('/:id/items', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const user = c.get('user');
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (!it.itemCode) return c.json({ error: 'item_code_required' }, 400);
  { const lock = await returnLineLock(sb, id); if (lock) return c.json(lock, 409); }

  /* DROPPED vs DR: the "no DO, no Return" single-line guard. */

  /* itemCode catalog guard. */
  {
    const codeCheck = await validateItemCodes(sb, [it.itemCode as string]);
    if (!codeCheck.ok) return c.json(unknownItemCodeResponse(codeCheck.unknown), 409);
  }

  const { data: header } = await sb.from('consignment_delivery_returns').select('id').eq('id', id).maybeSingle();
  if (!header) return c.json({ error: 'not_found' }, 404);

  const row = buildItemRow(id, it);
  const { data, error } = await sb.from('consignment_delivery_return_items').insert(row).select(ITEM).single();
  if (error) return c.json({ error: 'insert_failed', reason: error.message }, 500);
  await recomputeTotals(sb, id);
  /* Adding a return line books its IN too (self-healing resync). Best-effort. */
  try { await resyncReturnInventory(sb, id, user?.id ?? null); } catch { /* best-effort */ }
  return c.json({ item: data }, 201);
});

consignmentReturns.patch('/:id/items/:itemId', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const itemId = c.req.param('itemId');
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  { const lock = await returnLineLock(sb, id); if (lock) return c.json(lock, 409); }

  /* itemCode catalog guard (only when caller is changing it). */
  if (it.itemCode !== undefined) {
    const codeCheck = await validateItemCodes(sb, [it.itemCode as string]);
    if (!codeCheck.ok) return c.json(unknownItemCodeResponse(codeCheck.unknown), 409);
  }

  const { data: prev } = await sb.from('consignment_delivery_return_items')
    .select('qty_returned, unit_price_centi, discount_centi, unit_cost_centi, item_code, item_group, description, uom, variants, notes, condition')
    .eq('id', itemId).maybeSingle();
  if (!prev) return c.json({ error: 'not_found' }, 404);

  const qty = (it.qtyReturned ?? it.qty) !== undefined ? Number(it.qtyReturned ?? it.qty) : Number(prev.qty_returned);
  const unitPrice = it.unitPriceCenti !== undefined ? Number(it.unitPriceCenti) : Number(prev.unit_price_centi);
  const discount = it.discountCenti !== undefined ? Number(it.discountCenti) : Number(prev.discount_centi);
  const unitCost = it.unitCostCenti !== undefined ? Number(it.unitCostCenti) : Number(prev.unit_cost_centi);
  const lineTotal = (qty * unitPrice) - discount;
  const lineCost = qty * unitCost;

  const updates: Record<string, unknown> = {
    qty_returned: qty, unit_price_centi: unitPrice, discount_centi: discount, unit_cost_centi: unitCost,
    line_total_centi: lineTotal, line_cost_centi: lineCost, line_margin_centi: lineTotal - lineCost,
    refund_centi: lineTotal,
  };
  for (const [from, to] of [
    ['itemCode', 'item_code'], ['itemGroup', 'item_group'], ['description', 'description'],
    ['uom', 'uom'], ['variants', 'variants'], ['notes', 'notes'], ['condition', 'condition'],
  ] as const) {
    if (it[from] !== undefined) updates[to] = it[from];
  }
  {
    const effGroup = (it.itemGroup ?? prev.item_group) as string | null | undefined;
    const effVariants = (it.variants ?? prev.variants) as Record<string, unknown> | null | undefined;
    updates['description2'] = buildVariantSummary(String(effGroup ?? ''), effVariants ?? null) || null;
  }

  const { error } = await sb.from('consignment_delivery_return_items').update(updates).eq('id', itemId);
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  await recomputeTotals(sb, id);
  /* Adjust inventory by the qty/variant delta (self-healing resync). Best-effort. */
  try { await resyncReturnInventory(sb, id, c.get('user')?.id ?? null); } catch { /* best-effort */ }
  return c.json({ ok: true });
});

consignmentReturns.delete('/:id/items/:itemId', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const itemId = c.req.param('itemId');
  { const lock = await returnLineLock(sb, id); if (lock) return c.json(lock, 409); }
  const { error } = await sb.from('consignment_delivery_return_items').delete().eq('id', itemId);
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);
  await recomputeTotals(sb, id);
  /* Give the deleted line's stock back OUT (self-healing resync). Best-effort. */
  try { await resyncReturnInventory(sb, id, c.get('user')?.id ?? null); } catch { /* best-effort */ }
  return c.json({ ok: true });
});

// ── Status transition ──────────────────────────────────────────────────────
// A return is RECEIVED on create (the loaner was transferred back already);
// CANCELLED reverses that transfer (shipping warehouse → consignment warehouse).
// Other statuses (INSPECTED / REFUNDED / …) stamp their timestamp.
consignmentReturns.patch('/:id/status', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const user = c.get('user');
  let body: { status?: string; inspectionNotes?: string };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (!body.status) return c.json({ error: 'status_required' }, 400);

  const { data: cur } = await sb.from('consignment_delivery_returns').select('status').eq('id', id).maybeSingle();
  if (!cur) return c.json({ error: 'not_found' }, 404);
  const prevStatus = (cur as { status: string }).status;
  if (body.status === 'CANCELLED' && prevStatus === 'CANCELLED') {
    return c.json({ consignmentReturn: { id, status: 'CANCELLED' } });
  }
  /* Audit 2026-06-20 — a CANCELLED Consignment Return is FINAL (mirrors
     delivery-returns.ts dr_cancelled_final). The cancel already reversed the
     return IN; reactivating to RECEIVED/INSPECTED/REFUNDED would re-arm a
     double-IN on the next line edit (resyncReturnInventory then runs with a
     non-cancelled status). Create a new return instead. */
  if (prevStatus === 'CANCELLED') {
    return c.json({ error: 'return_cancelled_final', message: 'A cancelled Consignment Return cannot be reactivated — create a new return.' }, 409);
  }

  const now = new Date().toISOString();
  const ts: Record<string, string> = { updated_at: now, status: body.status };
  if (body.status === 'RECEIVED') ts.received_at = now;
  if (body.status === 'INSPECTED') { ts.inspected_at = now; if (body.inspectionNotes) ts.inspection_notes = body.inspectionNotes; }
  if (body.status === 'REFUNDED') ts.refunded_at = now;

  /* ATOMIC cancel guard — the CANCELLED write is conditional on the row still
     being non-cancelled so two concurrent cancels can't double-reverse. */
  let data: { id: string; status: string } | null;
  if (body.status === 'CANCELLED') {
    const { data: updated, error } = await sb.from('consignment_delivery_returns')
      .update(ts).eq('id', id).neq('status', 'CANCELLED')
      .select('id, status').maybeSingle();
    if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
    if (!updated) return c.json({ consignmentReturn: { id, status: 'CANCELLED' } });
    data = updated as { id: string; status: string };
  } else {
    const { data: updated, error } = await sb.from('consignment_delivery_returns')
      .update(ts).eq('id', id).select('id, status').single();
    if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
    data = updated as { id: string; status: string };
  }

  /* Cancelling a Consignment Return REVERSES the return IN: target net is now 0
     so the resync writes a balancing OUT per bucket. Idempotent + best-effort. */
  if (body.status === 'CANCELLED') {
    try { await resyncReturnInventory(sb, id, user.id); } catch { /* best-effort */ }
  }

  return c.json({ consignmentReturn: data });
});
