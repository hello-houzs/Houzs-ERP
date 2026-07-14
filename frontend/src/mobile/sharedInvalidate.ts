import type { QueryClient } from "@tanstack/react-query";

/* Mobile DO / convert / delivery screens still mutate via raw authedFetch +
 * private ["mobile-*"] query keys, so a DESKTOP tab reads a stale DO / board /
 * inventory / SO list after a mobile deliver / convert / status change. These
 * helpers invalidate the canonical shared roots (React Query prefix-match covers
 * every ?page/status/id variant), single-sourced here. Additive + generous:
 * invalidating a query that isn't mounted is a no-op.
 *
 * NOTE: the SO-detail / New-SO screens were already converged onto the vendored
 * shared mutation hooks upstream (they invalidate shared keys internally), so
 * they intentionally do NOT use these — this is only for the DO/convert/delivery
 * screens that still mutate raw, pending their own hook adoption. */

const bump = (qc: QueryClient, keys: string[]) => {
  for (const k of keys) qc.invalidateQueries({ queryKey: [k] });
};

export function invalidateSoShared(qc: QueryClient) {
  bump(qc, ["mfg-sales-orders", "mfg-sales-orders-paged", "mfg-sales-order-detail"]);
}

export function invalidateDoShared(qc: QueryClient) {
  bump(qc, ["mfg-delivery-orders", "mfg-delivery-orders-paged", "mfg-delivery-order-detail", "delivery-planning"]);
}

export function invalidateInventoryShared(qc: QueryClient) {
  bump(qc, ["inventory", "stock-transfers"]);
}

/* A convert touches source + target doc lists (SO/DO/SI/PO/GRN) and, for a GRN,
 * inventory — invalidate the union so no desktop picker/list is left stale. */
export function invalidateConvertShared(qc: QueryClient) {
  invalidateSoShared(qc);
  invalidateDoShared(qc);
  invalidateInventoryShared(qc);
  bump(qc, ["sales-invoices", "sales-invoices-paged", "mfg-purchase-orders", "grns", "grns-paged"]);
}
