// ----------------------------------------------------------------------------
// po-over-convert — the remaining-qty cap for SO-sourced lines on the generic
// PO-create path (POST /mfg-purchase-orders).
//
// The desktop "create new PO from SO" flow feeds picked SO lines through the
// generic create (New-PO-form), which — unlike /from-sos (convertSosToPosCore,
// which keeps 2990's cap) — had no server-side check that a line orders no more
// than the source SO still needs. This is the shared, testable core of that cap;
// see BUG-HISTORY 2026-07-24 and docs/2990-parity-allocation-costing.md.
//
// Manual lines (no soItemId) contribute nothing, so a purely-manual PO never
// trips the cap. MRP never routes through the generic create, so there is no
// fromMrp case here.
// ----------------------------------------------------------------------------

export type OverConvertOffender = { soItemId: string; requested: number; remaining: number };

/** Sum the requested qty per source SO line across `items`, and return the FIRST
 *  SO line whose summed request exceeds its remaining (`qty - po_qty_picked`),
 *  or null when every SO-sourced line fits. One SO line split across several PO
 *  lines counts once, in full (mirrors recomputeSoPicked / loadDraftedQtyBySoItem). */
export function findOverConvertOffender(
  items: ReadonlyArray<Record<string, unknown>>,
  soRows: ReadonlyArray<{ id: string; qty: number; po_qty_picked: number }>,
): OverConvertOffender | null {
  const requestedBySoItem = new Map<string, number>();
  for (const it of items) {
    const sid = (it.soItemId as string | undefined) ?? null;
    if (!sid) continue;
    const q = Math.max(0, Number(it.qty ?? 0));
    if (q > 0) requestedBySoItem.set(sid, (requestedBySoItem.get(sid) ?? 0) + q);
  }
  for (const r of soRows) {
    const requested = requestedBySoItem.get(r.id) ?? 0;
    if (requested <= 0) continue;
    const remaining = Number(r.qty ?? 0) - Number(r.po_qty_picked ?? 0);
    if (requested > remaining) return { soItemId: r.id, requested, remaining };
  }
  return null;
}
