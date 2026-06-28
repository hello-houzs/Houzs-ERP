// ----------------------------------------------------------------------------
// dropship-batch — resolve the EXPECTED production batch for a sofa SO line
// that is being shipped as a supplier-direct drop-ship (port of 2990 07c45728).
//
// A sofa "batch" = batch_no = the source production PO number. For a normal
// ship the allocator only locks mfg_sales_order_items.allocated_batch_no once
// a batch is PHYSICALLY received. A drop-ship ships BEFORE receipt -- the
// operator is forcing the KNOWN expected batch ahead of the GRN. We derive
// that batch from the PO raised against this SO line:
//
//     scm.purchase_order_items.so_item_id = <SO line id>
//        -> scm.purchase_orders.po_number          (= batch_no the GRN stamps)
//        -> scm.purchase_orders.expected_at / revised dates  (ETA)
//
// GUARDRAIL: a sofa line may only drop-ship if it HAS a bound PO (so the
// incoming dye-lot batch is known). No PO -> the caller blocks; the OUT would
// otherwise have no batch to net against on receipt.
// ----------------------------------------------------------------------------

export type ExpectedBatch = {
  /** = scm.purchase_orders.po_number — the batch_no the GRN will stamp on its IN. */
  poNumber: string;
  /** Effective ETA = GREATEST(expected_at, supplier_delivery_date_2..4); null if none. */
  eta: string | null;
};

/** Resolve each SO line's EXPECTED batch (bound PO number + ETA). A line with
 *  no bound PO is simply absent from the returned map (caller treats absence
 *  as "cannot drop-ship"). When a line is (unusually) linked to >1 PO we pick
 *  the most recent PO so the batch is deterministic. Best-effort: any read
 *  error yields an empty map (every line treated as no-PO -> drop-ship
 *  blocked, safe). */
export async function resolveExpectedBatchBySoItem(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  soItemIds: Array<string | null | undefined>,
): Promise<Map<string, ExpectedBatch>> {
  const out = new Map<string, ExpectedBatch>();
  const ids = [...new Set(soItemIds.filter((x): x is string => !!x))];
  if (ids.length === 0) return out;

  try {
    // PO items that came from these SO lines -> their PO ids (mig 0098 port).
    const { data: poiRows, error: poiErr } = await sb
      .from('purchase_order_items')
      .select('so_item_id, purchase_order_id, created_at')
      .in('so_item_id', ids)
      .not('purchase_order_id', 'is', null);
    if (poiErr) return out;
    const links = (poiRows ?? []) as Array<{
      so_item_id: string | null; purchase_order_id: string | null; created_at: string | null;
    }>;
    if (links.length === 0) return out;

    const poIds = [...new Set(links.map((r) => r.purchase_order_id).filter((x): x is string => !!x))];
    const { data: poRows, error: poErr } = await sb
      .from('purchase_orders')
      .select('id, po_number, expected_at, supplier_delivery_date_2, supplier_delivery_date_3, supplier_delivery_date_4')
      .in('id', poIds);
    if (poErr) return out;
    type PoRow = {
      id: string; po_number: string | null; expected_at: string | null;
      supplier_delivery_date_2: string | null; supplier_delivery_date_3: string | null; supplier_delivery_date_4: string | null;
    };
    const poById = new Map<string, PoRow>();
    for (const p of (poRows ?? []) as PoRow[]) poById.set(p.id, p);

    const effectiveEta = (p: PoRow): string | null => {
      const cands = [p.expected_at, p.supplier_delivery_date_2, p.supplier_delivery_date_3, p.supplier_delivery_date_4]
        .filter((d): d is string => !!d)
        .sort();
      return cands.length > 0 ? cands[cands.length - 1]! : null;
    };

    // Pick the most-recently-created PO per SO line so the batch is deterministic.
    const bestLinkByLine = new Map<string, { poId: string; createdAt: string }>();
    for (const l of links) {
      if (!l.so_item_id || !l.purchase_order_id) continue;
      const cur = bestLinkByLine.get(l.so_item_id);
      const createdAt = l.created_at ?? '';
      if (!cur || createdAt > cur.createdAt) {
        bestLinkByLine.set(l.so_item_id, { poId: l.purchase_order_id, createdAt });
      }
    }
    for (const [soItemId, link] of bestLinkByLine) {
      const po = poById.get(link.poId);
      if (po?.po_number) out.set(soItemId, { poNumber: po.po_number, eta: effectiveEta(po) });
    }
  } catch {
    return out;
  }
  return out;
}

/** Build the drop-ship payload for a set of blocked sofa offenders: each
 *  offender enriched with its bound PO + ETA (null when no PO). Feeds
 *  sofaNoCompleteBatchResponse so the 409 carries enough to render the
 *  "Ship as drop-ship?" dialog (and to decide whether drop-ship is offerable). */
export async function buildDropshipOffenders(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  offenders: Array<{ itemCode: string; soItemId: string | null }>,
): Promise<Array<{ itemCode: string; soItemId: string | null; poNumber: string | null; eta: string | null }>> {
  const expected = await resolveExpectedBatchBySoItem(sb, offenders.map((o) => o.soItemId));
  return offenders.map((o) => {
    const eb = o.soItemId ? expected.get(o.soItemId) : undefined;
    return { itemCode: o.itemCode, soItemId: o.soItemId, poNumber: eb?.poNumber ?? null, eta: eb?.eta ?? null };
  });
}
