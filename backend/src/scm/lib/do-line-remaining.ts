// ----------------------------------------------------------------------------
// do-line-remaining — the single source of truth for the DO-line "Pending"
// quantity used by BOTH downstream conversions (DO → Sales Invoice and
// DO → Delivery Return). Commander 2026-05-30 (Phase B), mirroring the SO→DO
// partial-delivery model in delivery-orders-mfg.ts (soDeliverableRemaining).
//
// Every delivered unit is in exactly ONE state — Pending / Invoiced / Returned
// — and the three are mutually exclusive. Per DO line:
//
//   delivered = the DO line's qty (delivery_order_items.qty)
//   invoiced  = Σ sales_invoice_items.qty   linked via do_item_id to a
//                                            NON-cancelled sales_invoice
//   returned  = Σ delivery_return_items.qty_returned  linked via do_item_id to
//                                            a NON-cancelled delivery_return
//
//   remaining = delivered − invoiced − returned          (= Pending)
//
// remaining_to_invoice and remaining_to_return are the SAME number: invoicing
// and returning COMPETE for the same Pending pool, so a unit that's been
// invoiced can't be returned and vice-versa (the invoice⊕return exclusion the
// user asked for — it falls straight out of this one formula, no extra flag).
//
// CANCEL releases: cancelling an invoice or a return drops its rows out of the
// non-cancelled filter, so the qty re-derives back into Pending automatically —
// the line becomes re-convertible. The number is always DERIVED LIVE from the
// rows; there is no stored counter to drift.
// ----------------------------------------------------------------------------

import { paginateAll } from './paginate-all';

export type DoRemainingLine = {
  doItemId: string;
  deliveryOrderId: string;
  doNumber: string;
  debtorCode: string | null;
  debtorName: string | null;
  itemCode: string;
  itemGroup: string | null;
  description: string | null;
  description2: string | null;
  uom: string | null;
  /** delivered = the DO line's qty */
  delivered: number;
  invoiced: number;
  returned: number;
  /** delivered − invoiced − returned (= Pending = remaining to invoice OR return) */
  remaining: number;
  unitPriceCenti: number;
  unitCostCenti: number;
  discountCenti: number;
  variants: unknown;
  /** Position of this line within ITS DO listing order (line_no per 0165,
   *  created_at for pre-0165 rows) — SI conversion copies the DO's order
   *  instead of shuffling by uuid (Loo 2026-06-12 line-order rules). */
  lineSeq: number;
};

/**
 * Derive the live Pending (remaining) quantity per DO line for the given DOs.
 * Keyed by delivery_order_items.id. Skips cancelled DOs entirely (a cancelled
 * DO delivered nothing). Returns a Map so callers can look up by do_item_id.
 *
 * `sb` is the loosely-typed Supabase client from the Hono context.
 */
export async function doLineRemaining(
  sb: any,
  doIds: string[],
): Promise<Map<string, DoRemainingLine>> {
  const out = new Map<string, DoRemainingLine>();
  const ids = [...new Set(doIds.filter(Boolean))];
  if (ids.length === 0) return out;

  // 1. Load the DO headers — we need debtor + do_number for the descriptors,
  //    and the status so we can drop cancelled DOs (they delivered nothing).
  const { data: doHeaders } = await sb
    .from('delivery_orders')
    .select('id, do_number, status, debtor_code, debtor_name')
    .in('id', ids);
  const headerById = new Map<
    string,
    { do_number: string; debtor_code: string | null; debtor_name: string | null }
  >();
  for (const d of (doHeaders ?? []) as Array<{
    id: string; do_number: string; status: string | null;
    debtor_code: string | null; debtor_name: string | null;
  }>) {
    if ((d.status ?? '').toUpperCase() === 'CANCELLED') continue; // delivered nothing
    headerById.set(d.id, { do_number: d.do_number, debtor_code: d.debtor_code, debtor_name: d.debtor_name });
  }
  const activeDoIds = [...headerById.keys()];
  if (activeDoIds.length === 0) return out;

  // 2. Load the DO lines of the active DOs — `delivered` = each line's qty —
  //    in each DO's own listing order (line_no per 0165, NULLS LAST so
  //    pre-0165 DOs fall back to created_at).
  const { data: doLines } = await sb
    .from('delivery_order_items')
    .select(
      'id, delivery_order_id, item_code, item_group, description, description2, uom, qty, ' +
      'unit_price_centi, unit_cost_centi, discount_centi, variants',
    )
    .in('delivery_order_id', activeDoIds)
    .order('line_no', { ascending: true, nullsFirst: false })
    .order('created_at');
  const lines = (doLines ?? []) as Array<Record<string, unknown> & {
    id: string; delivery_order_id: string; qty: number;
  }>;
  if (lines.length === 0) return out;
  const doItemIds = lines.map((l) => l.id);

  // 3. Σ invoiced — sales_invoice_items linked by do_item_id whose parent
  //    invoice is NOT cancelled. Two-step: pull candidate SI lines, then drop
  //    those whose parent invoice is cancelled.
  const invoicedByDoItem = new Map<string, number>();
  {
    const { data: siLines } = await sb
      .from('sales_invoice_items')
      .select('do_item_id, qty, sales_invoice_id')
      .in('do_item_id', doItemIds);
    const siRows = (siLines ?? []) as Array<{ do_item_id: string | null; qty: number; sales_invoice_id: string }>;
    const siIds = [...new Set(siRows.map((l) => l.sales_invoice_id).filter(Boolean))];
    const activeSiIds = new Set<string>();
    if (siIds.length > 0) {
      const { data: sis } = await sb.from('sales_invoices').select('id, status').in('id', siIds);
      for (const s of (sis ?? []) as Array<{ id: string; status: string | null }>) {
        if ((s.status ?? '').toUpperCase() !== 'CANCELLED') activeSiIds.add(s.id);
      }
    }
    for (const l of siRows) {
      if (!l.do_item_id || !activeSiIds.has(l.sales_invoice_id)) continue;
      invoicedByDoItem.set(l.do_item_id, (invoicedByDoItem.get(l.do_item_id) ?? 0) + Number(l.qty ?? 0));
    }
  }

  // 4. Σ returned — delivery_return_items linked by do_item_id whose parent
  //    return is NOT cancelled. Same two-step.
  const returnedByDoItem = new Map<string, number>();
  {
    const { data: drLines } = await sb
      .from('delivery_return_items')
      .select('do_item_id, qty_returned, delivery_return_id')
      .in('do_item_id', doItemIds);
    const drRows = (drLines ?? []) as Array<{ do_item_id: string | null; qty_returned: number; delivery_return_id: string }>;
    const drIds = [...new Set(drRows.map((l) => l.delivery_return_id).filter(Boolean))];
    const activeDrIds = new Set<string>();
    if (drIds.length > 0) {
      const { data: drs } = await sb.from('delivery_returns').select('id, status').in('id', drIds);
      for (const d of (drs ?? []) as Array<{ id: string; status: string | null }>) {
        if ((d.status ?? '').toUpperCase() !== 'CANCELLED') activeDrIds.add(d.id);
      }
    }
    for (const l of drRows) {
      if (!l.do_item_id || !activeDrIds.has(l.delivery_return_id)) continue;
      returnedByDoItem.set(l.do_item_id, (returnedByDoItem.get(l.do_item_id) ?? 0) + Number(l.qty_returned ?? 0));
    }
  }

  // 5. Assemble per-line descriptors with the live Pending (remaining).
  //    lineSeq counts per DO so SI conversion can keep each DO's listing order.
  const seqByDo = new Map<string, number>();
  for (const l of lines) {
    const head = headerById.get(l.delivery_order_id);
    if (!head) continue;
    const delivered = Number(l.qty ?? 0);
    const invoiced = invoicedByDoItem.get(l.id) ?? 0;
    const returned = returnedByDoItem.get(l.id) ?? 0;
    const lineSeq = seqByDo.get(l.delivery_order_id) ?? 0;
    seqByDo.set(l.delivery_order_id, lineSeq + 1);
    out.set(l.id, {
      doItemId: l.id,
      deliveryOrderId: l.delivery_order_id,
      doNumber: head.do_number,
      debtorCode: head.debtor_code,
      debtorName: head.debtor_name,
      itemCode: l.item_code as string,
      itemGroup: (l.item_group as string | null) ?? null,
      description: (l.description as string | null) ?? null,
      description2: (l.description2 as string | null) ?? null,
      uom: (l.uom as string | null) ?? null,
      delivered,
      invoiced,
      returned,
      remaining: delivered - invoiced - returned,
      unitPriceCenti: Number(l.unit_price_centi ?? 0),
      unitCostCenti: Number(l.unit_cost_centi ?? 0),
      discountCenti: Number(l.discount_centi ?? 0),
      variants: l.variants ?? null,
      lineSeq,
    });
  }
  return out;
}

/**
 * Live remaining-to-invoice qty per DO line id (delivered − invoiced −
 * returned), resolved straight from the DO item ids. Used by the SI write-path
 * guards so every sales_invoice_items create / add / qty-increase respects the
 * SAME cap the convert-from-DO picker enforces — no back door. DO lines that no
 * longer exist map to 0.
 */
export async function doRemainingByItemId(
  sb: any,
  doItemIds: Array<string | null | undefined>,
): Promise<Map<string, number>> {
  const ids = [...new Set(doItemIds.filter((x): x is string => !!x))];
  const out = new Map<string, number>();
  if (ids.length === 0) return out;
  const { data } = await sb.from('delivery_order_items').select('delivery_order_id').in('id', ids);
  const doIds = [...new Set(((data ?? []) as Array<{ delivery_order_id: string | null }>).map((r) => r.delivery_order_id).filter((d): d is string => !!d))];
  const remainingMap = await doLineRemaining(sb, doIds);
  for (const id of ids) out.set(id, remainingMap.get(id)?.remaining ?? 0);
  return out;
}

/**
 * Resolve the set of candidate DO ids the picker should consider.
 * Explicit ?doIds=A,B wins; otherwise every NON-cancelled DO (capped) so the
 * picker can show all of them. Returns [] when there are none.
 */
export async function resolveCandidateDoIds(sb: any, doIdsParam: string | undefined): Promise<string[]> {
  if (doIdsParam && doIdsParam.trim()) {
    return [...new Set(doIdsParam.split(',').map((d) => d.trim()).filter(Boolean))];
  }
  // Page through so PostgREST's 1000-row cap can't drop DOs from the picker
  // (a non-cancelled DO past row 1000 would be invisible to From-DO flows).
  const { data: dos } = await paginateAll<{ id: string; status: string }>((from, to) => sb
    .from('delivery_orders')
    .select('id, status')
    .neq('status', 'CANCELLED')
    .order('do_date', { ascending: false })
    .range(from, to));
  return ((dos ?? []) as Array<{ id: string }>).map((d) => d.id).filter(Boolean);
}

/** Same-customer key — debtor_code when present, else debtor_name. Matches the
 *  SO→DO picker's rule so behaviour is identical across all three flows. */
export const custKeyOf = (l: { debtorCode: string | null; debtorName: string | null }): string =>
  (l.debtorCode && l.debtorCode.trim())
    ? `code:${l.debtorCode.trim().toUpperCase()}`
    : `name:${(l.debtorName ?? '').trim().toUpperCase()}`;
