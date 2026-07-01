// /consignment-notes — Consignment Note (CN): ship consignment goods to a
// customer / showroom. A faithful clone of the Delivery Order API
// (apps/api/src/routes/delivery-orders-mfg.ts).
//
// UNIFIED inventory model (Wei Siang 2026-06-06): a Consignment Note now ships
// goods OUT of the warehouse exactly like a Delivery Order — FIFO is consumed and
// the cost LEAVES inventory (COGS), recorded as a plain OUT tagged CS_DO in the
// same stock ledger as DO/GRN. Cancelling writes a balancing IN. (Superseded the
// earlier value-neutral transfer-to-hidden-consignment-warehouse model; keep
// consignment stock in a showroom warehouse to stay out of MRP.)
//
// Tables: consignment_delivery_orders / _items / _payments (migration 0153).
// The DO's so_doc_no / so_item_id become consignment_so_doc_no /
// consignment_so_item_id (→ consignment_sales_orders / _items).
//
// DROPPED vs the DO clone (all SO-pipeline-specific, N/A for a loaner):
//   • /from-sos multi-SO picker, /deliverable-so-lines, soDeliverableRemaining
//   • the SO-remaining over-pick guard (a loaner has no ordered-qty cap)
//   • the sofa no-batch / incomplete-set ship guards (SO-linked)
//   • the soft short-stock confirmStockShort gate (a loaner ships what's there)
//   • COGS / restampDoActualCost / resync-cost machinery
//
// Mounted at '/consignment-notes' in apps/api/src/index.ts. Numbering CN-YYMM-NNN.

import { Hono } from 'hono';
import { z } from 'zod';
import { normalizePhone } from '../shared/phone';
import { buildVariantSummary } from '../shared';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { defaultWarehouseId, writeMovements, resolveWarehouseLotBatches } from '../lib/inventory-movements';
import { computeVariantKey, type VariantAttrs } from '../shared';
import { validateItemCodes, unknownItemCodeResponse } from '../lib/validate-item-codes';
import { nextMonthlyDocNo } from '../lib/doc-no';
import { todayMyt } from '../lib/my-time';
import { paginateAll, chunkIn } from '../lib/paginate-all';

export const consignmentNotes = new Hono<{ Bindings: Env; Variables: Variables }>();
consignmentNotes.use('*', supabaseAuth);

/* ── Child-lock guard (downstream lock) ──────────────────────────────────────
   A Consignment Note locks (no line edit / no CANCELLED transition) once it has
   ANY non-cancelled Consignment Return referencing it. Mirrors doHasDownstream
   on the DO side, but there is no Sales Invoice in the consignment flow. */
async function noteHasDownstream(sb: any, noteId: string): Promise<{ error: string; message: string } | null> {
  const { count: crCount } = await sb.from('consignment_delivery_returns')
    .select('id', { head: true, count: 'exact' })
    .eq('consignment_do_id', noteId)
    .neq('status', 'CANCELLED');
  if ((crCount ?? 0) > 0) {
    return { error: 'note_has_downstream', message: 'Consignment Note has a Consignment Return — cancel it first to edit' };
  }
  return null;
}

const HEADER =
  'id, do_number, consignment_so_doc_no, debtor_code, debtor_name, do_date, expected_delivery_at, ' +
  'customer_delivery_date, signed_at, delivered_at, dispatched_at, ' +
  'driver_id, driver_name, vehicle, m3_total_milli, ' +
  'address1, address2, city, state, postcode, phone, ' +
  'salesperson_id, agent, email, customer_type, building_type, branding, venue, venue_id, ref, ' +
  'customer_so_no, po_doc_no, sales_location, customer_state, customer_country, note, ' +
  'emergency_contact_name, emergency_contact_phone, emergency_contact_relationship, ' +
  'mattress_sofa_centi, bedframe_centi, accessories_centi, others_centi, ' +
  'mattress_sofa_cost_centi, bedframe_cost_centi, accessories_cost_centi, others_cost_centi, ' +
  'local_total_centi, total_cost_centi, total_margin_centi, margin_pct_basis, line_count, ' +
  'currency, warehouse_id, ' +
  'pod_r2_key, signature_data, status, notes, created_at, created_by, updated_at';

const ITEM =
  'id, consignment_delivery_order_id, consignment_so_item_id, item_code, item_group, description, description2, ' +
  'uom, qty, m3_milli, unit_price_centi, discount_centi, line_total_centi, ' +
  'unit_cost_centi, line_cost_centi, line_margin_centi, variants, notes, ' +
  'line_delivery_date, line_delivery_date_overridden, created_at';

const PAYMENT_COLS =
  'id, consignment_delivery_order_id, paid_at, method, merchant_provider, installment_months, ' +
  'online_type, approval_code, amount_centi, account_sheet, collected_by, note, ' +
  'created_at, created_by';

/* Statuses that count as "shipped" — the loaner has left our shipping warehouse,
   so it has been transferred to the consignment warehouse. The FIRST transition
   into ANY of these fires the loaner transfer. Same list as the DO. */
const SHIPPED_STATES = ['DISPATCHED', 'IN_TRANSIT', 'SIGNED', 'DELIVERED', 'INVOICED'];

const nextNum = async (sb: any): Promise<string> => {
  const d = new Date();
  const yymm = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`;
  const { data: existing } = await sb.from('consignment_delivery_orders').select('do_number').like('do_number', `CN-${yymm}-%`);
  return nextMonthlyDocNo(`CN-${yymm}`, ((existing ?? []) as Array<{ do_number: string }>).map((r) => r.do_number));
};

/* Re-derive the note header's per-category revenue/cost totals + grand total from
   its line items. Plain per-category rollup, copied from the DO. */
async function recomputeTotals(sb: any, noteId: string) {
  const { data: items } = await sb.from('consignment_delivery_order_items')
    .select('item_group, line_total_centi, line_cost_centi')
    .eq('consignment_delivery_order_id', noteId);
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
  await sb.from('consignment_delivery_orders').update({
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
    updated_at: new Date().toISOString(),
  }).eq('id', noteId);
}

/* ── resolveNoteLineWarehouses ────────────────────────────────────────────────
   Per-line ship-from warehouse for the loaner OUT. A note line ships from its
   linked consignment-SO line's warehouse when set (consignment_so_item_id →
   consignment_sales_order_items.warehouse_id), else the note header's warehouse,
   else the global default. Returns map of item id → warehouse_id (null when even
   the fallbacks are absent — the caller skips that line). */
async function resolveNoteLineWarehouses(
  sb: any,
  items: Array<{ id: string; consignment_so_item_id?: string | null }>,
  headerWarehouseId: string | null,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const soItemIds = [...new Set(items
    .map((it) => it.consignment_so_item_id ?? null)
    .filter((x): x is string => !!x))];
  const soWh = new Map<string, string | null>();
  if (soItemIds.length > 0) {
    const { data: soRows } = await sb.from('consignment_sales_order_items')
      .select('id, warehouse_id').in('id', soItemIds);
    for (const r of (soRows ?? []) as Array<{ id: string; warehouse_id: string | null }>) {
      soWh.set(r.id, r.warehouse_id ?? null);
    }
  }
  const fallback = headerWarehouseId ?? (await defaultWarehouseId(sb));
  for (const it of items) {
    const fromSo = it.consignment_so_item_id ? (soWh.get(it.consignment_so_item_id) ?? null) : null;
    out.set(it.id, fromSo ?? fallback);
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

/* ── resyncNoteInventory — self-healing OUT ledger for a Consignment Note ──────
   ONE function for the whole lifecycle (ship / add-line / edit-qty / delete-line
   / cancel), mirroring the Delivery Order's resyncInventoryForDo. It reconciles
   the note's CURRENT lines (the TARGET net OUT per warehouse/product/variant/
   batch bucket) against what inventory_movements already record for this note,
   and writes only the DELTA:
     • first-ever OUT for a bucket  → CS_DO  (carries the "out via Consignment
       Note" label + the CS_DO unique-index idempotency backstop)
     • any later increase/decrease  → STOCK_TRANSFER OUT/IN  (no unique index →
       no collision with the CS_DO row; still FIFO-aware so cost moves correctly)
     • cancel → status CANCELLED → TARGET is empty → every bucket's net is driven
       back to 0 via STOCK_TRANSFER IN.
   Idempotent: a re-run finds delta 0 everywhere and writes nothing. Best-effort.
   Only runs once the note has shipped (or is being cancelled). */
async function resyncNoteInventory(sb: any, noteId: string, performedBy: string | null): Promise<string[]> {
  const { data: header } = await sb.from('consignment_delivery_orders')
    .select('do_number, status, warehouse_id').eq('id', noteId).maybeSingle();
  if (!header) return [];
  const status = ((header as { status: string | null }).status ?? '').toUpperCase();
  const noteNo = (header as { do_number: string }).do_number ?? noteId;
  const cancelled = status === 'CANCELLED';
  // Nothing to reconcile until the note has shipped (no OUT yet) — unless we're
  // cancelling (drive any prior net back to 0).
  if (!cancelled && !SHIPPED_STATES.includes(status)) return [];

  // 1. TARGET net OUT per bucket = sum of current active lines (empty if cancelled).
  type Bucket = { warehouse_id: string; product_code: string; variant_key: string; product_name: string | null; qty: number; batch_no: string | null };
  const targetByBucket = new Map<string, Bucket>();
  if (!cancelled) {
    const { data: items } = await sb.from('consignment_delivery_order_items')
      .select('id, consignment_so_item_id, item_code, description, qty, item_group, variants')
      .eq('consignment_delivery_order_id', noteId);
    const lineWh = await resolveNoteLineWarehouses(sb, (items ?? []) as Array<{ id: string; consignment_so_item_id?: string | null }>, (header as { warehouse_id: string | null }).warehouse_id ?? null);
    const distinctWh = [...new Set(((items ?? []) as Array<{ id: string }>).map((it) => lineWh.get(it.id)).filter((x): x is string => !!x))];
    const batchByWh = new Map<string, Map<string, string | null>>();
    for (const wh of distinctWh) batchByWh.set(wh, await resolveWarehouseLotBatches(sb, wh));
    for (const it of ((items ?? []) as Array<{ id: string; item_code: string; description: string | null; qty: number; item_group?: string | null; variants?: VariantAttrs | null }>)) {
      const qty = Number(it.qty ?? 0);
      if (qty <= 0) continue;
      const wh = lineWh.get(it.id) ?? null;
      if (!wh) continue;
      const vk = computeVariantKey(it.item_group ?? null, it.variants ?? null);
      const batch = batchByWh.get(wh)?.get(`${it.item_code}::${vk}`) ?? null;
      const k = `${wh}::${it.item_code}::${vk}::${batch ?? ''}`;
      const cur = targetByBucket.get(k);
      if (cur) cur.qty += qty;
      else targetByBucket.set(k, { warehouse_id: wh, product_code: it.item_code, variant_key: vk, product_name: it.description, qty, batch_no: batch });
    }
  }

  // 2. CURRENT net OUT per bucket from ALL this note's movements (CS_DO ship +
  //    any prior STOCK_TRANSFER resync/cancel deltas).
  const { data: movs } = await sb.from('inventory_movements')
    .select('movement_type, warehouse_id, product_code, variant_key, batch_no, qty, total_cost_sen, product_name')
    .eq('source_doc_id', noteId)
    .in('source_doc_type', ['CS_DO', 'STOCK_TRANSFER']);
  type Agg = { out_qty: number; in_qty: number; out_total_cost: number; product_name: string | null };
  const aggByBucket = new Map<string, Agg>();
  for (const m of (movs ?? []) as Array<{ movement_type: string; warehouse_id: string; product_code: string; variant_key: string | null; batch_no?: string | null; qty: number; total_cost_sen: number | null; product_name: string | null }>) {
    const k = `${m.warehouse_id}::${m.product_code}::${m.variant_key ?? ''}::${m.batch_no ?? ''}`;
    let a = aggByBucket.get(k);
    if (!a) { a = { out_qty: 0, in_qty: 0, out_total_cost: 0, product_name: m.product_name }; aggByBucket.set(k, a); }
    if (m.movement_type === 'OUT') { a.out_qty += Number(m.qty ?? 0); a.out_total_cost += Number(m.total_cost_sen ?? 0); }
    else if (m.movement_type === 'IN') a.in_qty += Number(m.qty ?? 0);
    if (!a.product_name) a.product_name = m.product_name;
  }

  // 3. delta = target − current_net_out. >0 → ship more OUT; <0 → give stock back IN.
  type MovOut = Parameters<typeof writeMovements>[1][number];
  const writes: MovOut[] = [];
  const csDoEmitted = new Set<string>(); // product::variant given a CS_DO this run (avoid 2nd-warehouse collision)
  for (const k of new Set<string>([...targetByBucket.keys(), ...aggByBucket.keys()])) {
    const t = targetByBucket.get(k);
    const a = aggByBucket.get(k) ?? { out_qty: 0, in_qty: 0, out_total_cost: 0, product_name: null };
    const delta = (t?.qty ?? 0) - (a.out_qty - a.in_qty);
    if (delta === 0) continue;
    const [wh, pc, vk, batchSeg] = k.split('::');
    const batch_no = batchSeg || null;
    const pname = t?.product_name ?? a.product_name ?? null;
    if (delta > 0) {
      // First OUT for this product+variant → CS_DO (label + index guard); any
      // later increase (or a 2nd warehouse for the same SKU) → STOCK_TRANSFER.
      const neverMoved = a.out_qty === 0 && a.in_qty === 0;
      const useCsDo = neverMoved && !csDoEmitted.has(`${pc}::${vk}`);
      if (useCsDo) csDoEmitted.add(`${pc}::${vk}`);
      writes.push({
        movement_type: 'OUT', warehouse_id: wh ?? '', product_code: pc ?? '', variant_key: vk ?? '', product_name: pname,
        qty: delta,
        source_doc_type: useCsDo ? 'CS_DO' : 'STOCK_TRANSFER',
        source_doc_id: noteId, source_doc_no: noteNo,
        ...(batch_no ? { batch_no } : {}),
        performed_by: performedBy,
        notes: useCsDo ? 'Consignment Note ship-out (goods to showroom)' : 'Consignment Note resync: line qty increased / added.',
      });
    } else {
      const unitCost = a.out_qty > 0 ? Math.round(a.out_total_cost / a.out_qty) : 0;
      writes.push({
        movement_type: 'IN', warehouse_id: wh ?? '', product_code: pc ?? '', variant_key: vk ?? '', product_name: pname,
        qty: -delta, unit_cost_sen: unitCost,
        source_doc_type: 'STOCK_TRANSFER',
        source_doc_id: noteId, source_doc_no: cancelled ? `${noteNo}-CANCEL` : noteNo,
        ...(batch_no ? { batch_no } : {}),
        performed_by: performedBy,
        notes: cancelled ? 'Consignment Note cancelled — stock returned' : 'Consignment Note resync: line qty reduced / deleted.',
      });
    }
  }

  if (writes.length === 0) return [];
  const res = await writeMovements(sb, writes);
  try {
    const { recomputeSoStockAllocation } = await import('../lib/so-stock-allocation');
    await recomputeSoStockAllocation(sb);
  } catch { /* best-effort */ }
  return res.ok ? [] : [res.reason ?? 'consignment note inventory resync failed'];
}

/* Build one consignment_delivery_order_items insert row from a client line
   payload. Shared by POST / (bulk create) and POST /:id/items (single add). */
function buildItemRow(noteId: string, it: Record<string, unknown>) {
  const qty = Number(it.qty ?? 1);
  const unitPrice = Number(it.unitPriceCenti ?? 0);
  const discount = Number(it.discountCenti ?? 0);
  const unitCost = Number(it.unitCostCenti ?? 0);
  // Audit 2026-06-20 — clamp like the PO create path (negative-money guard).
  const lineTotal = Math.max(0, (qty * unitPrice) - discount);
  const lineCost = qty * unitCost;
  const itemGroup = (it.itemGroup as string) ?? null;
  const variants = (it.variants as unknown) ?? null;
  return {
    consignment_delivery_order_id: noteId,
    consignment_so_item_id: (it.soItemId as string | undefined) ?? (it.consignmentSoItemId as string | undefined) ?? null,
    item_code: it.itemCode,
    item_group: itemGroup,
    description: (it.description as string) ?? null,
    description2: buildVariantSummary(String(itemGroup ?? ''), (variants as Record<string, unknown> | null) ?? null) || (it.description2 as string) || null,
    uom: (it.uom as string) ?? 'UNIT',
    qty,
    m3_milli: Number(it.m3Milli ?? 0),
    unit_price_centi: unitPrice,
    discount_centi: discount,
    line_total_centi: lineTotal,
    unit_cost_centi: unitCost,
    line_cost_centi: lineCost,
    line_margin_centi: lineTotal - lineCost,
    variants,
    notes: (it.notes as string) ?? null,
    line_delivery_date: (it.lineDeliveryDate as string | null) ?? null,
    line_delivery_date_overridden: Boolean(it.lineDeliveryDateOverridden ?? false),
  };
}

// ── List ────────────────────────────────────────────────────────────────
consignmentNotes.get('/', async (c) => {
  const sb = c.get('supabase');
  let q = sb.from('consignment_delivery_orders').select(HEADER).order('do_date', { ascending: false }).limit(500);
  const status = c.req.query('status'); if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  /* Downstream-lock — stamp has_children when a non-cancelled Consignment Return
     references the note (the list grid hides Edit / Cancel on locked notes). */
  const rows = (data ?? []) as unknown as Array<{ id: string } & Record<string, unknown>>;
  const childIds = new Set<string>();
  if (rows.length > 0) {
    const ids = rows.map((r) => r.id);
    // chunkIn — child reads across the list docs can exceed PostgREST's 1000-row
    // cap; truncation would mis-stamp has_children (Edit/Cancel would wrongly
    // stay enabled on downstream-locked notes).
    const { data: crRes } = await chunkIn<{ consignment_do_id: string | null }>(ids, (batch, from, to) => sb.from('consignment_delivery_returns')
      .select('consignment_do_id').in('consignment_do_id', batch).neq('status', 'CANCELLED').range(from, to));
    for (const r of ((crRes ?? []) as Array<{ consignment_do_id: string | null }>)) {
      if (r.consignment_do_id) childIds.add(r.consignment_do_id);
    }
  }
  const consignmentNotesOut = rows.map((r) => ({ ...r, has_children: childIds.has(r.id) }));
  return c.json({ deliveryOrders: consignmentNotesOut });
});

// ── Deliverable Consignment Order lines (From-Order multi-picker) ─────────
// Every consignment_sales_order_item with outstanding = ordered (qty) −
// already-noted (sum of qty across non-cancelled Consignment Notes linked to
// that order line via consignment_so_item_id). Only outstanding > 0 lines are
// pickable. Mirrors the SO→DO from-so picker. MUST precede /:id.
consignmentNotes.get('/deliverable-order-lines', async (c) => {
  const sb = c.get('supabase');
  const { data: orders, error: oErr } = await paginateAll<{ doc_no: string; debtor_code: string | null; debtor_name: string | null }>((from, to) => sb
    .from('consignment_sales_orders')
    .select('doc_no, debtor_code, debtor_name')
    .order('so_date', { ascending: false })
    .range(from, to));
  if (oErr) return c.json({ error: 'load_failed', reason: oErr.message }, 500);
  const orderList = (orders ?? []) as Array<{ doc_no: string; debtor_code: string | null; debtor_name: string | null }>;
  if (orderList.length === 0) return c.json({ lines: [] });
  const orderByDoc = new Map(orderList.map((o) => [o.doc_no, o]));
  const docNos = orderList.map((o) => o.doc_no);

  const { data: items, error: iErr } = await chunkIn<Record<string, unknown>>(docNos, (batch, from, to) => sb
    .from('consignment_sales_order_items')
    .select('id, doc_no, item_code, item_group, description, description2, uom, qty, unit_price_centi, discount_centi, unit_cost_centi, variants, cancelled')
    .in('doc_no', batch)
    .range(from, to));
  if (iErr) return c.json({ error: 'load_failed', reason: iErr.message }, 500);
  const itemList = (items ?? []).filter((it: Record<string, unknown>) => !it.cancelled) as Array<Record<string, unknown>>;
  if (itemList.length === 0) return c.json({ lines: [] });
  const itemIds = itemList.map((it) => it.id as string);

  // Already-delivered per CO line — only count non-cancelled notes.
  const { data: noteRows } = await sb
    .from('consignment_delivery_orders')
    .select('id, status')
    .neq('status', 'CANCELLED');
  const liveNoteIds = new Set(((noteRows ?? []) as Array<{ id: string }>).map((r) => r.id));
  const { data: noteItems } = await chunkIn<{ consignment_delivery_order_id: string; consignment_so_item_id: string | null; qty: number }>(itemIds, (batch, from, to) => sb
    .from('consignment_delivery_order_items')
    .select('consignment_delivery_order_id, consignment_so_item_id, qty')
    .in('consignment_so_item_id', batch)
    .range(from, to));
  const deliveredByItem = new Map<string, number>();
  for (const r of ((noteItems ?? []) as Array<{ consignment_delivery_order_id: string; consignment_so_item_id: string | null; qty: number }>)) {
    if (!r.consignment_so_item_id || !liveNoteIds.has(r.consignment_delivery_order_id)) continue;
    deliveredByItem.set(r.consignment_so_item_id, (deliveredByItem.get(r.consignment_so_item_id) ?? 0) + Number(r.qty ?? 0));
  }

  const lines = itemList.map((it) => {
    const o = orderByDoc.get(it.doc_no as string);
    const ordered = Number(it.qty ?? 0);
    const delivered = deliveredByItem.get(it.id as string) ?? 0;
    return {
      orderItemId: it.id as string,
      orderDocNo: it.doc_no as string,
      debtorCode: o?.debtor_code ?? null,
      debtorName: o?.debtor_name ?? null,
      itemCode: it.item_code as string,
      itemGroup: (it.item_group as string | null) ?? null,
      description: (it.description as string | null) ?? null,
      description2: (it.description2 as string | null) ?? null,
      uom: (it.uom as string | null) ?? null,
      ordered,
      delivered,
      outstanding: ordered - delivered,
      unitPriceCenti: Number(it.unit_price_centi ?? 0),
      discountCenti: Number(it.discount_centi ?? 0),
      unitCostCenti: Number(it.unit_cost_centi ?? 0),
      variants: it.variants ?? null,
    };
  }).filter((l) => l.outstanding > 0);

  return c.json({ lines });
});

// ── Detail ──────────────────────────────────────────────────────────────
consignmentNotes.get('/:id', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  const [h, i] = await Promise.all([
    sb.from('consignment_delivery_orders').select(HEADER).eq('id', id).maybeSingle(),
    sb.from('consignment_delivery_order_items').select(ITEM).eq('consignment_delivery_order_id', id).order('created_at'),
  ]);
  if (h.error) return c.json({ error: 'load_failed', reason: h.error.message }, 500);
  if (!h.data) return c.json({ error: 'not_found' }, 404);
  const { count: crCount } = await sb.from('consignment_delivery_returns')
    .select('id', { head: true, count: 'exact' })
    .eq('consignment_do_id', id).neq('status', 'CANCELLED');
  const consignmentNote = {
    ...(h.data as unknown as Record<string, unknown>),
    has_children: (crCount ?? 0) > 0,
  };
  const rawItems = (i.data ?? []) as unknown as Array<{ id: string; consignment_so_item_id?: string | null } & Record<string, unknown>>;
  const headerWh = (h.data as { warehouse_id?: string | null }).warehouse_id ?? null;
  const lineWh = await resolveNoteLineWarehouses(sb, rawItems, headerWh);
  const codeMap = await warehouseCodeMap(sb, [...lineWh.values()]);
  const items = rawItems.map((it) => {
    const wid = lineWh.get(it.id) ?? null;
    return { ...it, warehouse_id: wid, warehouse_code: wid ? (codeMap.get(wid) ?? null) : null };
  });
  return c.json({ deliveryOrder: consignmentNote, items });
});

// ── Create ──────────────────────────────────────────────────────────────
// Accepts the full SO-cloned header + line items. A Consignment Note ships the
// loaner the moment it's created → status starts at DISPATCHED and the
// value-neutral loaner transfer fires right after the items insert.
// Optional ?fromConsignmentOrder= prefill is handled client-side; this endpoint
// just stores whatever header/items the client posts.
consignmentNotes.post('/', async (c) => {
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const debtorName = (body.debtorName ?? body.customerName) as string | undefined;
  if (!debtorName) return c.json({ error: 'debtor_name_required' }, 400);
  const items = (body.items as Array<Record<string, unknown>> | undefined) ?? [];

  const sb = c.get('supabase'); const user = c.get('user');

  /* itemCode catalog guard (kept — a loaner must still ship a real product). */
  if (items.length > 0) {
    const codeCheck = await validateItemCodes(sb, items.map((it) => it.itemCode as string | null | undefined));
    if (!codeCheck.ok) return c.json(unknownItemCodeResponse(codeCheck.unknown), 409);
  }

  /* DROPPED vs DO: the soft short-stock confirmStockShort gate, the SO-remaining
     over-pick guard, and the sofa no-batch / incomplete-set ship guards — a
     loaner has no ordered-qty cap and ships whatever is on the shelf. */

  const doNumber = await nextNum(sb);
  const phoneRaw = (body.phone as string | undefined) ?? null;
  const emPhoneRaw = (body.emergencyContactPhone as string | undefined) ?? null;

  const { data: header, error: hErr } = await sb.from('consignment_delivery_orders').insert({
    do_number: doNumber,
    consignment_so_doc_no: (body.consignmentSoDocNo as string) ?? (body.soDocNo as string) ?? null,
    debtor_code: (body.debtorCode as string) ?? null,
    debtor_name: debtorName,
    do_date: (body.doDate as string) ?? todayMyt(),
    expected_delivery_at: (body.expectedDeliveryAt as string) ?? (body.customerDeliveryDate as string) ?? null,
    customer_delivery_date: (body.customerDeliveryDate as string) ?? null,
    driver_id: (body.driverId as string) ?? null,
    driver_name: (body.driverName as string) ?? null,
    vehicle: (body.vehicle as string) ?? null,
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
    po_doc_no: (body.poDocNo as string) ?? null,
    sales_location: (body.salesLocation as string) ?? null,
    note: (body.note as string) ?? null,
    emergency_contact_name: (body.emergencyContactName as string) ?? null,
    emergency_contact_phone: emPhoneRaw ? (normalizePhone(emPhoneRaw) ?? emPhoneRaw) : null,
    emergency_contact_relationship: (body.emergencyContactRelationship as string) ?? null,
    warehouse_id: (body.warehouseId as string) ?? null,
    currency: (body.currency as string) ?? 'MYR',
    /* A Consignment Note means the loaner is OUT the moment it's created — start
       at DISPATCHED and transfer it to the consignment warehouse below. */
    status: 'DISPATCHED',
    notes: (body.notes as string) ?? null,
    created_by: user.id,
  }).select(HEADER).single();
  if (hErr) return c.json({ error: 'insert_failed', reason: hErr.message }, 500);
  const h = header as unknown as { id: string; do_number: string };

  if (items.length > 0) {
    const rows = items.map((it) => buildItemRow(h.id, it));
    const { error: iErr } = await sb.from('consignment_delivery_order_items').insert(rows);
    if (iErr) { await sb.from('consignment_delivery_orders').delete().eq('id', h.id); return c.json({ error: 'items_insert_failed', reason: iErr.message }, 500); }
    await recomputeTotals(sb, h.id);
  }

  /* Value-neutral loaner transfer: shipping warehouse → consignment warehouse.
     Replaces the DO's deductInventoryForDo (FIFO OUT + COGS). Idempotent +
     best-effort — a failed transfer never rolls back the note. */
  const movementErrors = await resyncNoteInventory(sb, h.id, user.id);

  return c.json({ id: h.id, doNumber: h.do_number, movementErrors: movementErrors.length ? movementErrors : undefined }, 201);
});

// ── Header PATCH (editable SO-style fields) ───────────────────────────────
consignmentNotes.patch('/:id', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }

  const map: Array<[string, string]> = [
    ['debtorCode', 'debtor_code'], ['debtorName', 'debtor_name'], ['agent', 'agent'],
    ['salesLocation', 'sales_location'], ['ref', 'ref'], ['poDocNo', 'po_doc_no'],
    ['venue', 'venue'], ['venueId', 'venue_id'], ['branding', 'branding'],
    ['address1', 'address1'], ['address2', 'address2'],
    ['city', 'city'], ['state', 'state'], ['postcode', 'postcode'], ['phone', 'phone'],
    ['note', 'note'], ['notes', 'notes'],
    ['soDate', 'do_date'], ['doDate', 'do_date'], ['currency', 'currency'],
    ['customerState', 'customer_state'], ['customerCountry', 'customer_country'],
    ['customerSoNo', 'customer_so_no'],
    ['customerDeliveryDate', 'customer_delivery_date'],
    ['expectedDeliveryAt', 'expected_delivery_at'],
    ['email', 'email'], ['customerType', 'customer_type'],
    ['salespersonId', 'salesperson_id'], ['buildingType', 'building_type'],
    ['driverId', 'driver_id'], ['driverName', 'driver_name'], ['vehicle', 'vehicle'],
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

  /* Header is locked once a Consignment Return exists. */
  const headerLock = await noteHasDownstream(sb, id);
  if (headerLock) return c.json(headerLock, 409);

  const { data, error } = await sb.from('consignment_delivery_orders').update(updates).eq('id', id).select('id').maybeSingle();
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  if (!data) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true, id });
});

// ── Item CRUD ─────────────────────────────────────────────────────────────
consignmentNotes.post('/:id/items', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const user = c.get('user');
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (!it.itemCode) return c.json({ error: 'item_code_required' }, 400);

  /* itemCode catalog guard. */
  {
    const codeCheck = await validateItemCodes(sb, [it.itemCode as string]);
    if (!codeCheck.ok) return c.json(unknownItemCodeResponse(codeCheck.unknown), 409);
  }

  /* Downstream-lock — line-add is blocked once a Consignment Return exists. */
  const childLock = await noteHasDownstream(sb, id);
  if (childLock) return c.json(childLock, 409);

  const { data: header } = await sb.from('consignment_delivery_orders').select('id, status, warehouse_id').eq('id', id).maybeSingle();
  if (!header) return c.json({ error: 'not_found' }, 404);

  const row = buildItemRow(id, it);
  const { data, error } = await sb.from('consignment_delivery_order_items').insert(row).select(ITEM).single();
  if (error) return c.json({ error: 'insert_failed', reason: error.message }, 500);
  await recomputeTotals(sb, id);
  /* Reconcile inventory for the added line — resync writes the new line's OUT
     when the note has already shipped, and is a no-op otherwise. Idempotent. */
  try { await resyncNoteInventory(sb, id, user?.id ?? null); } catch { /* best-effort */ }
  return c.json({ item: data }, 201);
});

consignmentNotes.patch('/:id/items/:itemId', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const itemId = c.req.param('itemId');
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }

  /* itemCode catalog guard (only when caller is changing it). */
  if (it.itemCode !== undefined) {
    const codeCheck = await validateItemCodes(sb, [it.itemCode as string]);
    if (!codeCheck.ok) return c.json(unknownItemCodeResponse(codeCheck.unknown), 409);
  }

  /* Downstream-lock — line-edit is blocked once a Consignment Return exists. */
  const childLock = await noteHasDownstream(sb, id);
  if (childLock) return c.json(childLock, 409);

  const { data: prev } = await sb.from('consignment_delivery_order_items')
    .select('qty, unit_price_centi, discount_centi, unit_cost_centi, item_code, item_group, description, uom, variants, notes, consignment_so_item_id')
    .eq('id', itemId).maybeSingle();
  if (!prev) return c.json({ error: 'not_found' }, 404);

  const qty = it.qty !== undefined ? Number(it.qty) : Number(prev.qty);
  const unitPrice = it.unitPriceCenti !== undefined ? Number(it.unitPriceCenti) : Number(prev.unit_price_centi);
  const discount = it.discountCenti !== undefined ? Number(it.discountCenti) : Number(prev.discount_centi);
  const unitCost = it.unitCostCenti !== undefined ? Number(it.unitCostCenti) : Number(prev.unit_cost_centi);
  // Audit 2026-06-20 — clamp like the PO create path (negative-money guard).
  const lineTotal = Math.max(0, (qty * unitPrice) - discount);
  const lineCost = qty * unitCost;

  const updates: Record<string, unknown> = {
    qty, unit_price_centi: unitPrice, discount_centi: discount, unit_cost_centi: unitCost,
    line_total_centi: lineTotal, line_cost_centi: lineCost, line_margin_centi: lineTotal - lineCost,
  };
  for (const [from, to] of [
    ['itemCode', 'item_code'], ['itemGroup', 'item_group'], ['description', 'description'],
    ['uom', 'uom'], ['variants', 'variants'], ['notes', 'notes'],
    ['lineDeliveryDate', 'line_delivery_date'],
  ] as const) {
    if (it[from] !== undefined) updates[to] = it[from];
  }
  if (it.lineDeliveryDate !== undefined) updates['line_delivery_date_overridden'] = true;
  if (it.lineDeliveryDateOverridden !== undefined) updates['line_delivery_date_overridden'] = Boolean(it.lineDeliveryDateOverridden);
  {
    const effGroup = (it.itemGroup ?? prev.item_group) as string | null | undefined;
    const effVariants = (it.variants ?? prev.variants) as Record<string, unknown> | null | undefined;
    updates['description2'] = buildVariantSummary(String(effGroup ?? ''), effVariants ?? null) || null;
  }

  const { error } = await sb.from('consignment_delivery_order_items').update(updates).eq('id', itemId);
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  await recomputeTotals(sb, id);
  /* Adjust inventory by the qty/variant delta (no-op until shipped). */
  try { await resyncNoteInventory(sb, id, c.get('user')?.id ?? null); } catch { /* best-effort */ }
  return c.json({ ok: true });
});

consignmentNotes.delete('/:id/items/:itemId', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const itemId = c.req.param('itemId');

  /* Downstream-lock — line-delete is blocked once a Consignment Return exists. */
  const childLock = await noteHasDownstream(sb, id);
  if (childLock) return c.json(childLock, 409);

  const { error } = await sb.from('consignment_delivery_order_items').delete().eq('id', itemId);
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);
  await recomputeTotals(sb, id);
  /* Give the deleted line's stock back (no-op until shipped). */
  try { await resyncNoteInventory(sb, id, c.get('user')?.id ?? null); } catch { /* best-effort */ }
  return c.json({ ok: true });
});

// ── Payments (mirror DO payments ledger) ──────────────────────────────────
consignmentNotes.get('/:id/payments', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  const { data, error } = await sb
    .from('consignment_delivery_order_payments')
    .select(`${PAYMENT_COLS}, staff:collected_by ( name )`)
    .eq('consignment_delivery_order_id', id)
    .order('paid_at', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const payments = (data ?? []).map((r: unknown) => {
    const row = r as Record<string, unknown> & { staff: { name: string } | null };
    const { staff, ...rest } = row;
    return { ...rest, collected_by_name: staff?.name ?? null };
  });
  return c.json({ payments });
});

const paymentCreateSchema = z.object({
  paidAt:             z.string().min(1),
  /* 2026-06-06 payment-method unify — 'installment' is first-class L1. */
  method:             z.enum(['merchant', 'transfer', 'cash', 'installment']),
  merchantProvider:   z.string().trim().min(1).optional().nullable(),
  installmentMonths:  z.number().int().min(0).max(60).optional().nullable(),
  onlineType:         z.string().trim().min(1).optional().nullable(),
  approvalCode:       z.string().optional().nullable(),
  amountCenti:        z.number().int().nonnegative(),
  accountSheet:       z.string().optional().nullable(),
  collectedBy:        z.string().uuid().optional().nullable(),
  note:               z.string().optional().nullable(),
});

consignmentNotes.post('/:id/payments', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const user = c.get('user');

  const { data: doc } = await sb.from('consignment_delivery_orders').select('id').eq('id', id).maybeSingle();
  if (!doc) return c.json({ error: 'consignment_note_not_found' }, 404);

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = paymentCreateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const p = parsed.data;

  const merchantLike      = p.method === 'merchant' || p.method === 'installment';
  const merchantProvider  = merchantLike ? (p.merchantProvider ?? null) : null;
  const installmentMonths = merchantLike
    ? (typeof p.installmentMonths === 'number' && p.installmentMonths > 0 ? p.installmentMonths : null)
    : null;
  const onlineType        = p.method === 'transfer' ? (p.onlineType ?? null) : null;

  const { data, error } = await sb.from('consignment_delivery_order_payments').insert({
    consignment_delivery_order_id: id,
    paid_at:            p.paidAt,
    method:             p.method,
    merchant_provider:  merchantProvider,
    installment_months: installmentMonths,
    online_type:        onlineType,
    approval_code:      p.approvalCode ?? null,
    amount_centi:       p.amountCenti,
    account_sheet:      p.accountSheet ?? null,
    collected_by:       p.collectedBy ?? null,
    note:               p.note ?? null,
    created_by:         user.id,
  }).select(PAYMENT_COLS).single();
  if (error) return c.json({ error: 'insert_failed', reason: error.message }, 500);
  return c.json({ payment: data }, 201);
});

consignmentNotes.delete('/:id/payments/:paymentId', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const paymentId = c.req.param('paymentId');
  const { data: row } = await sb.from('consignment_delivery_order_payments').select('consignment_delivery_order_id').eq('id', paymentId).maybeSingle();
  if (!row) return c.json({ error: 'not_found' }, 404);
  if ((row as { consignment_delivery_order_id: string }).consignment_delivery_order_id !== id) return c.json({ error: 'payment_doc_mismatch' }, 400);
  const { error } = await sb.from('consignment_delivery_order_payments').delete().eq('id', paymentId);
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);
  return c.json({ ok: true });
});

// ── Status transition + loaner transfer / reversal ────────────────────────
consignmentNotes.patch('/:id/status', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const user = c.get('user');
  let body: { status?: string }; try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (!body.status) return c.json({ error: 'status_required' }, 400);

  const { data: cur } = await sb.from('consignment_delivery_orders').select('status').eq('id', id).maybeSingle();
  if (!cur) return c.json({ error: 'not_found' }, 404);
  const prevStatus = (cur as { status: string }).status;
  if (body.status === 'CANCELLED' && prevStatus === 'CANCELLED') {
    return c.json({ consignmentNote: { id, status: 'CANCELLED' } });
  }

  /* Audit 2026-06-20 — a CANCELLED Consignment Note is FINAL (mirrors
     delivery-orders-mfg.ts do_cancelled_final + the consignment-returns/PC-receive
     guards). Reactivating to a shipped state would re-book the CS_DO inventory OUT
     (resyncNoteInventory re-ships the stock). Create a new note instead. */
  if (prevStatus === 'CANCELLED') {
    return c.json({ error: 'note_cancelled_final', message: 'A cancelled Consignment Note cannot be reactivated — its ship-out was already reversed. Create a new note.' }, 409);
  }

  /* Downstream-lock — only the CANCELLED transition is gated. */
  if (body.status === 'CANCELLED') {
    const childLock = await noteHasDownstream(sb, id);
    if (childLock) return c.json(childLock, 409);
  }

  const now = new Date().toISOString();
  const ts: Record<string, string> = { updated_at: now };
  if (body.status === 'DISPATCHED') ts.dispatched_at = now;
  if (body.status === 'SIGNED')     ts.signed_at = now;
  if (body.status === 'DELIVERED')  ts.delivered_at = now;

  /* ATOMIC cancel guard — make the CANCELLED write conditional on the row still
     being non-cancelled so two concurrent cancels can't double-reverse. */
  let data: { id: string; status: string } | null;
  if (body.status === 'CANCELLED') {
    const { data: updated, error } = await sb.from('consignment_delivery_orders')
      .update({ status: body.status, ...ts })
      .eq('id', id).neq('status', 'CANCELLED')
      .select('id, status').maybeSingle();
    if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
    if (!updated) return c.json({ consignmentNote: { id, status: 'CANCELLED' } });
    data = updated as { id: string; status: string };
  } else {
    const { data: updated, error } = await sb.from('consignment_delivery_orders')
      .update({ status: body.status, ...ts }).eq('id', id).select('id, status').single();
    if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
    data = updated as { id: string; status: string };
  }

  /* Inventory ledger — one self-healing resync covers BOTH the ship-out (first
     transition into a shipped state writes the CS_DO OUT) and the cancel (status
     CANCELLED drives every bucket's net back to 0). Idempotent + best-effort. */
  if (SHIPPED_STATES.includes(body.status) || body.status === 'CANCELLED') {
    try { await resyncNoteInventory(sb, id, user.id); } catch { /* best-effort */ }
  }

  return c.json({ consignmentNote: data });
});
