// ----------------------------------------------------------------------------
// DO → SO "Delivered" sync. 1:1 clone of 2990s apps/api/src/lib/
// so-delivery-sync.ts.
//
// Requirement #3 (Loo, 2026-05-30): when a Delivery Order fully covers a Sales
// Order, the SO auto-advances to DELIVERED; cancelling/reducing the DO (or a
// Delivery Return) releases it back to READY_TO_SHIP.
//
// The PURE coverage decision `isSoFullyCovered` is ported VERBATIM (unit-tested
// in 2990s, no DB, no furniture). The async glue `syncSoDeliveredFromDo` reads
// delivery_orders / delivery_order_items / delivery_returns — those tables are
// NOT cloned yet (DO/SI/DR slice). So the async wrapper is a faithful no-op
// stub: it keeps the EXACT signature 2990s exports so the DO slice can wire it
// with a one-function change, and every SO mutation site that would call it
// later compiles today.
//   TODO: DO/SI slice — port the Supabase->Drizzle body (delivered/returned
//   netting + the bidirectional DELIVERED <-> READY_TO_SHIP reconcile + the
//   line-level READY flip + the dual audit-trail write).
// ----------------------------------------------------------------------------

import type { getDb } from "../db/client";

type Db = ReturnType<typeof getDb>;

export type SoLineQty = { id: string; qty: number };
export type DoLineQty = { soItemId: string | null; qty: number };

/** Pure coverage decision. `soLines` must already EXCLUDE cancelled SO lines;
 *  `doLines` should EXCLUDE lines belonging to cancelled DOs; `returnLines`
 *  (optional) should EXCLUDE lines belonging to cancelled Delivery Returns.
 *  Returns true iff every SO line's NET delivered quantity
 *  (Σ delivered across DOs − Σ returned across DRs) meets or exceeds its
 *  ordered qty. An SO with no lines is never "fully covered". Verbatim. */
export function isSoFullyCovered(
  soLines: SoLineQty[],
  doLines: DoLineQty[],
  returnLines: DoLineQty[] = [],
): boolean {
  if (soLines.length === 0) return false;
  const netByLine = new Map<string, number>();
  for (const d of doLines) {
    if (!d.soItemId) continue;
    netByLine.set(d.soItemId, (netByLine.get(d.soItemId) ?? 0) + (d.qty ?? 0));
  }
  for (const r of returnLines) {
    if (!r.soItemId) continue;
    netByLine.set(r.soItemId, (netByLine.get(r.soItemId) ?? 0) - (r.qty ?? 0));
  }
  return soLines.every((l) => (netByLine.get(l.id) ?? 0) >= l.qty);
}

// SO statuses we may auto-advance to DELIVERED. (Kept for fidelity / the DO
// slice; referenced by the future wiring.)
export const DELIVERABLE_FROM = ["CONFIRMED", "IN_PRODUCTION", "READY_TO_SHIP", "SHIPPED"];
export const RELEASE_TO = "READY_TO_SHIP";

/** For each SO doc no, recompute its delivery status from CURRENT live delivered
 *  quantities and reconcile the stored status. STUB until the DO/SI/DR slice
 *  lands (no delivery tables yet) — best-effort no-op, exact 2990s signature.
 *  TODO: DO/SI slice — wire the full Supabase->Drizzle reconcile. */
export async function syncSoDeliveredFromDo(
  _db: Db,
  _soDocNos: Array<string | null | undefined>,
  _actorId?: number | null,
): Promise<void> {
  return;
}
