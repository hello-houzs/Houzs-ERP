// ─────────────────────────────────────────────────────────────────────────
// recost.ts — Costing B (Commander 2026-06-01): retroactive FIFO recost engine.
//
// THE PROBLEM IT SOLVES
//   When goods are received (GRN) the FIFO trigger books a lot at the GR price
//   (or 0 if the GR had no price — "Pending"). When that stock later ships on a
//   DO, the trigger consumes the lot and writes the REAL COGS onto the OUT
//   movement (inventory_movements.total_cost_sen) + the consumption row
//   (inventory_lot_consumptions). restampDoActualCost then copies that actual
//   cost onto the DO line (and the Sales Invoice copies the DO).
//
//   But the authoritative cost only arrives LATER, when the supplier's Purchase
//   Invoice is entered — or it gets CORRECTED (human error) by editing the PI or
//   the GR price. The lots, consumptions, movements, DO and SI were all booked
//   at the OLD (or zero) cost and are now wrong.
//
// WHAT THIS DOES (pure backend data updates via the service-role client — NO
// schema migration, the API already runs as SUPABASE_SERVICE_ROLE_KEY):
//   Given a GRN, re-derive the authoritative unit cost per received bucket
//   (PI price > GR price > Pending), then cascade it forward:
//     1. inventory_lots.unit_cost_sen           (the carrying cost)
//     2. the GRN IN movement's unit/total cost  (the lot's source movement)
//     3. inventory_lot_consumptions             (real COGS rows for every OUT)
//     4. the consuming OUT movements' total/unit cost
//     5. restampDoActualCost(DO)                (re-stamp every affected DO line)
//     6. restampSiFromDo(DO)                    (re-copy DO cost onto its SIs)
//
//   The result: a PI entered/edited (or a GR price corrected) AFTER the goods
//   shipped flows all the way down to the DO + Sales Invoice margin in real time.
//
// COST PRIORITY (per bucket): live (non-cancelled) Purchase Invoice line price,
// else the GR price, else Pending (lot left untouched — cost unknown until a
// price lands; Stage A surfaces this as "Pending").
//
// Best-effort throughout: never throws into the caller (audit-DLQ pattern,
// same as the rest of the inventory layer). The primary write already
// committed; a recost hiccup logs + skips and self-heals on the next touch.
// ─────────────────────────────────────────────────────────────────────────

import { computeVariantKey } from '../shared';
import { restampDoActualCost } from '../routes/delivery-orders-mfg';

/* Re-derive a Sales Invoice header's per-category revenue/cost totals from its
   line items. Mirror of the SI route's recomputeTotals (kept in lockstep). */
async function recomputeSiTotals(sb: any, salesInvoiceId: string) {
  const { data: items } = await sb.from('sales_invoice_items')
    .select('item_group, line_total_centi, line_cost_centi')
    .eq('sales_invoice_id', salesInvoiceId);
  let mattressSofa = 0, bedframe = 0, accessories = 0, others = 0, total = 0, totalCost = 0;
  let mattressSofaCost = 0, bedframeCost = 0, accessoriesCost = 0, othersCost = 0;
  for (const it of (items ?? []) as Array<{ item_group: string | null; line_total_centi: number | null; line_cost_centi: number | null }>) {
    const lineTotal = Number(it.line_total_centi ?? 0);
    const lineCost = Number(it.line_cost_centi ?? 0);
    total += lineTotal;
    totalCost += lineCost;
    const g = (it.item_group ?? '').toLowerCase();
    if (g.includes('mattress') || g.includes('sofa')) { mattressSofa += lineTotal; mattressSofaCost += lineCost; }
    else if (g.includes('bedframe')) { bedframe += lineTotal; bedframeCost += lineCost; }
    else if (g.includes('accessor')) { accessories += lineTotal; accessoriesCost += lineCost; }
    else { others += lineTotal; othersCost += lineCost; }
  }
  const margin = total - totalCost;
  await sb.from('sales_invoices').update({
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
    subtotal_centi: total,
    total_centi: total,
    updated_at: new Date().toISOString(),
  }).eq('id', salesInvoiceId);
}

/* Re-copy a DO's (now actual) line costs onto every non-cancelled Sales Invoice
   line that bills it. SI lines link to DO lines via sales_invoice_items.
   do_item_id (migration 0103). Mirrors the DO→SI cost copy in the SI route's
   convert-from-DO, but as an in-place re-stamp. */
export async function restampSiFromDo(sb: any, deliveryOrderId: string) {
  try {
    const { data: doItems } = await sb.from('delivery_order_items')
      .select('id, unit_cost_centi')
      .eq('delivery_order_id', deliveryOrderId);
    if (!doItems || doItems.length === 0) return;
    const costByDoItem = new Map<string, number>();
    const doItemIds: string[] = [];
    for (const d of doItems as Array<{ id: string; unit_cost_centi: number | null }>) {
      costByDoItem.set(d.id, Number(d.unit_cost_centi ?? 0));
      doItemIds.push(d.id);
    }
    if (doItemIds.length === 0) return;

    const { data: siLines } = await sb.from('sales_invoice_items')
      .select('id, sales_invoice_id, do_item_id, qty, line_total_centi')
      .in('do_item_id', doItemIds);
    if (!siLines || siLines.length === 0) return;

    // Skip lines on cancelled invoices.
    const siIds = [...new Set((siLines as Array<{ sales_invoice_id: string }>).map((s) => s.sales_invoice_id).filter(Boolean))];
    const cancelled = new Set<string>();
    if (siIds.length > 0) {
      const { data: heads } = await sb.from('sales_invoices').select('id, status').in('id', siIds);
      for (const h of (heads ?? []) as Array<{ id: string; status: string }>) {
        if ((h.status ?? '').toUpperCase() === 'CANCELLED') cancelled.add(h.id);
      }
    }

    const touched = new Set<string>();
    for (const s of siLines as Array<{ id: string; sales_invoice_id: string; do_item_id: string | null; qty: number; line_total_centi: number | null }>) {
      if (cancelled.has(s.sales_invoice_id)) continue;
      if (!s.do_item_id) continue;
      const unitCost = costByDoItem.get(s.do_item_id);
      if (unitCost === undefined) continue;
      const qty = Number(s.qty ?? 0);
      const lineCost = unitCost * qty;
      const lineTotal = Number(s.line_total_centi ?? 0);
      await sb.from('sales_invoice_items').update({
        unit_cost_centi: unitCost,
        line_cost_centi: lineCost,
        line_margin_centi: lineTotal - lineCost,
      }).eq('id', s.id);
      touched.add(s.sales_invoice_id);
    }
    for (const siId of touched) await recomputeSiTotals(sb, siId);
  } catch (e) { /* eslint-disable-next-line no-console */ console.error('[restampSiFromDo] failed:', deliveryOrderId, e); }
}

/* ── recostFromGrn — the engine ───────────────────────────────────────────
   Re-derive authoritative cost for one GRN's received buckets and cascade it
   to lots → consumptions → movements → DO → SI. Idempotent (a bucket whose lot
   already carries the authoritative cost is skipped). Best-effort. */
export async function recostFromGrn(sb: any, grnId: string) {
  try {
    // 1. GRN lines — the received buckets + their GR (fallback) price.
    const { data: grnItems } = await sb.from('grn_items')
      .select('id, material_code, item_group, variants, unit_price_centi')
      .eq('grn_id', grnId);
    if (!grnItems || grnItems.length === 0) return;
    const giList = grnItems as Array<{
      id: string; material_code: string; item_group: string | null;
      variants: Record<string, unknown> | null; unit_price_centi: number | null;
    }>;

    // 2. PI lines billing those GRN lines — the AUTHORITATIVE price (overrides
    //    GR). Weighted-average across all live (non-cancelled) PI lines per
    //    grn_item, so a partial / corrected invoice resolves cleanly.
    const giIds = giList.map((g) => g.id);
    const { data: piRows } = await sb.from('purchase_invoice_items')
      .select('grn_item_id, qty, unit_price_centi, purchase_invoice_id')
      .in('grn_item_id', giIds);
    const piList = (piRows ?? []) as Array<{ grn_item_id: string | null; qty: number; unit_price_centi: number | null; purchase_invoice_id: string }>;
    const piIds = [...new Set(piList.map((r) => r.purchase_invoice_id).filter(Boolean))];
    const piCancelled = new Set<string>();
    if (piIds.length > 0) {
      const { data: pis } = await sb.from('purchase_invoices').select('id, status').in('id', piIds);
      for (const p of (pis ?? []) as Array<{ id: string; status: string }>) {
        if ((p.status ?? '').toUpperCase() === 'CANCELLED') piCancelled.add(p.id);
      }
    }
    const piAgg = new Map<string, { qty: number; amt: number }>();
    for (const r of piList) {
      if (!r.grn_item_id || piCancelled.has(r.purchase_invoice_id)) continue;
      const a = piAgg.get(r.grn_item_id) ?? { qty: 0, amt: 0 };
      const q = Number(r.qty ?? 0);
      a.qty += q;
      a.amt += q * Number(r.unit_price_centi ?? 0);
      piAgg.set(r.grn_item_id, a);
    }

    // 3. Authoritative unit cost per (product_code, variant_key) bucket.
    //    PI price > GR price > Pending (null → leave the lot untouched).
    const costByBucket = new Map<string, number | null>();
    for (const g of giList) {
      const vkey = computeVariantKey(g.item_group, g.variants);
      const key = `${g.material_code}::${vkey}`;
      const pi = piAgg.get(g.id);
      let cost: number | null;
      if (pi && pi.qty > 0) cost = Math.round(pi.amt / pi.qty);
      else if (Number(g.unit_price_centi ?? 0) > 0) cost = Number(g.unit_price_centi);
      else cost = null; // Pending — no price anywhere yet.
      const existing = costByBucket.get(key);
      if (existing === undefined) costByBucket.set(key, cost);
      else if (existing === null && cost !== null) costByBucket.set(key, cost); // prefer a priced source
    }

    // 4. Lots created by this GRN. Re-cost each, then cascade to its consumptions.
    const { data: lots } = await sb.from('inventory_lots')
      .select('id, product_code, variant_key, qty_received, movement_id, unit_cost_sen')
      .eq('source_doc_type', 'GRN').eq('source_doc_id', grnId);
    if (!lots || lots.length === 0) return;

    // Gather candidate consumptions per lot first (with the new cost), so we can
    // resolve which OUT movements belong to CANCELLED DOs and skip them BEFORE
    // re-stamping. A cancelled DO already reversed its stock at the cost booked
    // at cancel time; recosting it here would double-correct the GL.
    type ConsCand = { id: string; qty_consumed: number | null; movement_id: string | null; newCost: number };
    const consCandidates: ConsCand[] = [];
    for (const lot of lots as Array<{ id: string; product_code: string; variant_key: string | null; qty_received: number | null; movement_id: string | null; unit_cost_sen: number | null }>) {
      const key = `${lot.product_code}::${lot.variant_key ?? ''}`;
      const newCost = costByBucket.get(key);
      if (newCost === undefined || newCost === null) continue; // Pending — leave as-is
      if (Number(lot.unit_cost_sen ?? 0) === newCost) continue; // already correct

      // 4a. The lot's carrying cost.
      await sb.from('inventory_lots').update({ unit_cost_sen: newCost }).eq('id', lot.id);
      // 4b. The GRN IN movement that created the lot.
      if (lot.movement_id) {
        await sb.from('inventory_movements').update({
          unit_cost_sen: newCost,
          total_cost_sen: Number(lot.qty_received ?? 0) * newCost,
        }).eq('id', lot.movement_id);
      }
      // 4c. Collect every consumption drawing from this lot (real COGS rows).
      const { data: cons } = await sb.from('inventory_lot_consumptions')
        .select('id, qty_consumed, movement_id').eq('lot_id', lot.id);
      for (const ct of (cons ?? []) as Array<{ id: string; qty_consumed: number | null; movement_id: string | null }>) {
        consCandidates.push({ id: ct.id, qty_consumed: ct.qty_consumed, movement_id: ct.movement_id, newCost });
      }
    }

    // Resolve, for every candidate OUT movement, whether its source DO is
    // CANCELLED. A cancelled DO's OUT movements + consumptions + DO lines were
    // already settled at cancel time — exclude them from the recost cascade.
    const candidateMovIds = [...new Set(consCandidates.map((c) => c.movement_id).filter((x): x is string => !!x))];
    const movToDo = new Map<string, string>(); // movement_id → DO id (only DO-sourced)
    const cancelledMovIds = new Set<string>();
    if (candidateMovIds.length > 0) {
      const { data: movs } = await sb.from('inventory_movements')
        .select('id, source_doc_type, source_doc_id').in('id', candidateMovIds);
      const doIdSet = new Set<string>();
      for (const m of (movs ?? []) as Array<{ id: string; source_doc_type: string | null; source_doc_id: string | null }>) {
        if ((m.source_doc_type ?? '').toUpperCase() === 'DO' && m.source_doc_id) {
          movToDo.set(m.id, m.source_doc_id);
          doIdSet.add(m.source_doc_id);
        }
      }
      if (doIdSet.size > 0) {
        const { data: dos } = await sb.from('delivery_orders').select('id, status').in('id', [...doIdSet]);
        const cancelledDoIds = new Set<string>();
        for (const d of (dos ?? []) as Array<{ id: string; status: string | null }>) {
          if ((d.status ?? '').toUpperCase() === 'CANCELLED') cancelledDoIds.add(d.id);
        }
        for (const [movId, doId] of movToDo) if (cancelledDoIds.has(doId)) cancelledMovIds.add(movId);
      }
    }

    // 4c (apply). Re-stamp each consumption EXCEPT those on a cancelled DO's OUT.
    const affectedOutMovements = new Set<string>();
    for (const ct of consCandidates) {
      if (ct.movement_id && cancelledMovIds.has(ct.movement_id)) continue; // cancelled DO — leave settled
      await sb.from('inventory_lot_consumptions').update({
        unit_cost_sen: ct.newCost,
        total_cost_sen: Number(ct.qty_consumed ?? 0) * ct.newCost,
      }).eq('id', ct.id);
      if (ct.movement_id) affectedOutMovements.add(ct.movement_id);
    }

    // 5. Recompute each affected OUT movement's total/unit cost from the (now
    //    re-costed) sum of its consumptions, and collect the DOs they belong to.
    //    Cancelled-DO movements were never added to affectedOutMovements above.
    const affectedDoIds = new Set<string>();
    for (const movId of affectedOutMovements) {
      const { data: mc } = await sb.from('inventory_lot_consumptions')
        .select('qty_consumed, total_cost_sen').eq('movement_id', movId);
      const rows = (mc ?? []) as Array<{ qty_consumed: number | null; total_cost_sen: number | null }>;
      const totalCost = rows.reduce((s, r) => s + Number(r.total_cost_sen ?? 0), 0);
      const totalQty = rows.reduce((s, r) => s + Number(r.qty_consumed ?? 0), 0);
      await sb.from('inventory_movements').update({
        total_cost_sen: totalCost,
        unit_cost_sen: totalQty > 0 ? Math.round(totalCost / totalQty) : 0,
      }).eq('id', movId);
      const { data: mv } = await sb.from('inventory_movements')
        .select('source_doc_type, source_doc_id').eq('id', movId).maybeSingle();
      const m = mv as { source_doc_type: string | null; source_doc_id: string | null } | null;
      if (m && (m.source_doc_type ?? '').toUpperCase() === 'DO' && m.source_doc_id) {
        affectedDoIds.add(m.source_doc_id);
      }
    }

    // 6. Re-stamp every affected DO line, then re-copy onto its Sales Invoices.
    for (const doId of affectedDoIds) {
      await restampDoActualCost(sb, doId);
      await restampSiFromDo(sb, doId);
    }
  } catch (e) { /* eslint-disable-next-line no-console */ console.error('[recostFromGrn] failed:', grnId, e); }
}

/* ── recostForPi — convenience wrapper ─────────────────────────────────────
   Resolve every GRN a Purchase Invoice touches (its header grn_id + each line's
   grn_item_id → grn_id) and recost each. Call after any PI create / line edit /
   line delete / cancel so a price change (or correction) propagates. */
export async function recostForPi(sb: any, piId: string) {
  try {
    const grnIds = new Set<string>();
    const { data: head } = await sb.from('purchase_invoices').select('grn_id').eq('id', piId).maybeSingle();
    const hGrn = (head as { grn_id: string | null } | null)?.grn_id ?? null;
    if (hGrn) grnIds.add(hGrn);

    const { data: lines } = await sb.from('purchase_invoice_items')
      .select('grn_item_id').eq('purchase_invoice_id', piId);
    const giIds = [...new Set(((lines ?? []) as Array<{ grn_item_id: string | null }>)
      .map((l) => l.grn_item_id).filter((x): x is string => !!x))];
    if (giIds.length > 0) {
      const { data: gi } = await sb.from('grn_items').select('grn_id').in('id', giIds);
      for (const g of (gi ?? []) as Array<{ grn_id: string | null }>) if (g.grn_id) grnIds.add(g.grn_id);
    }

    for (const gid of grnIds) await recostFromGrn(sb, gid);
  } catch (e) { /* eslint-disable-next-line no-console */ console.error('[recostForPi] failed:', piId, e); }
}
