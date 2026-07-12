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
import { toMyrSen } from './fx';

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
    //    Migration 0082 — also read allocated_charge_centi + qty_accepted so the
    //    landed FREIGHT folded in at receive time survives a PI recost.
    const { data: grnItems } = await sb.from('grn_items')
      .select('id, material_code, item_group, variants, unit_price_centi, qty_accepted, allocated_charge_centi')
      .eq('grn_id', grnId);
    if (!grnItems || grnItems.length === 0) return;
    const giList = grnItems as Array<{
      id: string; material_code: string; item_group: string | null;
      variants: Record<string, unknown> | null; unit_price_centi: number | null;
      qty_accepted: number | null; allocated_charge_centi: number | null;
    }>;

    /* Landed-cost core (migration 0082) — the GRN's exchange_rate (MYR per 1 unit
       of the GRN currency, 1 for MYR). Converts the GR-price FALLBACK
       (g.unit_price_centi, in the GRN's currency) to MYR. The PI path below uses
       the PI's OWN rate. rate 1 ⇒ toMyrSen is a no-op, so an MYR GRN recosts
       byte-for-byte as before. */
    const { data: grnHead } = await sb.from('grns').select('exchange_rate').eq('id', grnId).maybeSingle();
    const grnRate = (grnHead as { exchange_rate?: string | number | null } | null)?.exchange_rate ?? 1;

    // 2. PI lines billing those GRN lines — the AUTHORITATIVE price (overrides
    //    GR). Weighted-average across all live (non-cancelled) PI lines per
    //    grn_item, so a partial / corrected invoice resolves cleanly.
    const giIds = giList.map((g) => g.id);
    const { data: piRows } = await sb.from('purchase_invoice_items')
      .select('grn_item_id, qty, unit_price_centi, purchase_invoice_id, allocated_charge_centi')
      .in('grn_item_id', giIds);
    const piList = (piRows ?? []) as Array<{ grn_item_id: string | null; qty: number; unit_price_centi: number | null; purchase_invoice_id: string; allocated_charge_centi: number | null }>;
    const piIds = [...new Set(piList.map((r) => r.purchase_invoice_id).filter(Boolean))];
    /* LEAK GUARD (DRAFT, PI two-state — 2026-06-25 anchoring diff vs 2990) — exclude
       both CANCELLED AND DRAFT PIs from the authoritative-cost aggregate. A DRAFT PI
       commits no money and is not yet a real bill, so its line price must NEVER
       become the GRN lot's cost (which would silently flow into DO/SI margins). Only
       a confirmed POSTED/PARTIALLY_PAID/PAID PI is authoritative. */
    const piExcluded = new Set<string>();
    /* Landed-cost core (migration 0082) — each PI's OWN exchange_rate. A PI line
       price is in the PI's currency; the AUTHORITATIVE MYR lot cost is that price
       × the PI's rate. Different PIs billing the same GRN can carry different
       rates, so key the rate per purchase_invoice_id. */
    const piRateById = new Map<string, string | number | null>();
    if (piIds.length > 0) {
      const { data: pis } = await sb.from('purchase_invoices').select('id, status, exchange_rate').in('id', piIds);
      for (const p of (pis ?? []) as Array<{ id: string; status: string; exchange_rate?: string | number | null }>) {
        const st = (p.status ?? '').toUpperCase();
        if (st === 'CANCELLED' || st === 'DRAFT') piExcluded.add(p.id);
        piRateById.set(p.id, p.exchange_rate ?? 1);
      }
    }
    // Aggregate the PI lines per grn_item as a weighted-average MYR cost: convert
    // EACH line's foreign price to MYR at its own PI's rate BEFORE averaging.
    const piAgg = new Map<string, { qty: number; amt: number }>();
    for (const r of piList) {
      if (!r.grn_item_id || piExcluded.has(r.purchase_invoice_id)) continue;
      const a = piAgg.get(r.grn_item_id) ?? { qty: 0, amt: 0 };
      const q = Number(r.qty ?? 0);
      const unitMyr = toMyrSen(Number(r.unit_price_centi ?? 0), piRateById.get(r.purchase_invoice_id) ?? 1);
      a.qty += q;
      a.amt += q * unitMyr;
      piAgg.set(r.grn_item_id, a);
    }

    /* Landed-cost allocation (migration 0082) — per-bucket FREIGHT per unit. The
       GRN allocated_charge_centi was folded into the lot at receive time as
       round(allocated / qty) per unit. A PI recost re-derives the GOODS cost, so
       we must re-add the SAME per-unit freight or it would silently drop out.
       Aggregate per bucket as a qty-weighted average. 0 everywhere when no charge. */
    const freightByBucket = new Map<string, number>();
    {
      const acc = new Map<string, { freight: number; qty: number }>();
      for (const g of giList) {
        const vkey = computeVariantKey(g.item_group, g.variants);
        const key = `${g.material_code}::${vkey}`;
        const qty = Math.max(0, Number(g.qty_accepted ?? 0));
        const perUnit = qty > 0 ? Math.round(Number(g.allocated_charge_centi ?? 0) / qty) : 0;
        const a = acc.get(key) ?? { freight: 0, qty: 0 };
        a.freight += perUnit * qty; // total freight sen across this line
        a.qty += qty;
        acc.set(key, a);
      }
      for (const [key, a] of acc) freightByBucket.set(key, a.qty > 0 ? Math.round(a.freight / a.qty) : 0);
    }

    /* PI-level landed freight (migration 0082) — freight entered on the PI as a
       SERVICE line, pooled + allocated across the PI's GOODS lines and stored per
       line as purchase_invoice_items.allocated_charge_centi (already MYR sen via
       the PI's own rate, computed at PI write time). SEPARATE from the GRN freight:
       the user enters freight on the GRN OR the PI (or both, deliberately), and
       each capitalises EXACTLY ONCE. Re-added here as a per-unit MYR figure ON TOP
       of the GRN freight + goods cost. DRAFT/CANCELLED PIs excluded. 0 everywhere
       when no PI freight, so a PI with no service line is unchanged. */
    const piFreightByBucket = new Map<string, number>();
    {
      const giById = new Map(giList.map((g) => [g.id, g]));
      const acc = new Map<string, { freight: number; qty: number }>();
      for (const r of piList) {
        if (!r.grn_item_id || piExcluded.has(r.purchase_invoice_id)) continue;
        const alloc = Number(r.allocated_charge_centi ?? 0);
        if (alloc === 0) continue;
        const g = giById.get(r.grn_item_id);
        if (!g) continue;
        const vkey = computeVariantKey(g.item_group, g.variants);
        const key = `${g.material_code}::${vkey}`;
        const lotQty = Math.max(0, Number(g.qty_accepted ?? 0));
        const perUnit = lotQty > 0 ? Math.round(alloc / lotQty) : 0;
        const a = acc.get(key) ?? { freight: 0, qty: 0 };
        a.freight += perUnit * lotQty;
        a.qty += lotQty;
        acc.set(key, a);
      }
      for (const [key, a] of acc) piFreightByBucket.set(key, a.qty > 0 ? Math.round(a.freight / a.qty) : 0);
    }

    // 3. Authoritative unit cost per (product_code, variant_key) bucket.
    //    PI price > GR price > Pending (null → leave the lot untouched).
    const costByBucket = new Map<string, number | null>();
    for (const g of giList) {
      const vkey = computeVariantKey(g.item_group, g.variants);
      const key = `${g.material_code}::${vkey}`;
      const pi = piAgg.get(g.id);
      // GRN-allocated freight + PI-allocated freight. Both per-unit MYR; each
      // folds onto the goods cost once (distinct user entries, never double-counted).
      const freight = (freightByBucket.get(key) ?? 0) + (piFreightByBucket.get(key) ?? 0);
      let cost: number | null;
      // PI price (already MYR via piAgg) > GR price × GRN rate (→ MYR) > Pending.
      if (pi && pi.qty > 0) cost = Math.round(pi.amt / pi.qty) + freight;
      else if (Number(g.unit_price_centi ?? 0) > 0) cost = toMyrSen(Number(g.unit_price_centi), grnRate) + freight;
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
