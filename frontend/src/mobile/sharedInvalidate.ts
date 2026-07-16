import type { QueryClient } from "@tanstack/react-query";

/* Several mobile screens still mutate via raw authedFetch + private ["mobile-*"]
 * query keys, so a DESKTOP tab reads a stale DO / board / inventory / SO list
 * after a mobile save / deliver / convert / status change. These helpers
 * invalidate the canonical shared roots (React Query prefix-match covers every
 * ?page/status/id variant), single-sourced here. Additive + generous:
 * invalidating a query that isn't mounted is a no-op.
 *
 * NOTE: MobileSODetail IS converged onto the vendored shared mutation hooks
 * (useUpdateMfgSalesOrderStatus / the amendment gates), so it does not need
 * these. MobileNewSO is NOT: its header PATCH, line diff, photo and payment
 * writes are raw authedFetch, so it calls invalidateSoShared at each save exit.
 *
 * Raw authedFetch is doubly invisible: it neither invalidates a shared key nor
 * trips the global MutationCache onSuccess in lib/queryClient.ts, which is what
 * broadcasts a write to OTHER TABS (lib/cross-tab-sync). A useMutation hook gets
 * both for free — prefer routing a write through the vendored hook over calling
 * these helpers when the hook's invalidation is complete. */

const bump = (qc: QueryClient, keys: string[]) => {
  for (const k of keys) qc.invalidateQueries({ queryKey: [k] });
};

const SO_ROOTS = ["mfg-sales-orders", "mfg-sales-orders-paged", "mfg-sales-order-detail"];
const DO_ROOTS = ["mfg-delivery-orders", "mfg-delivery-orders-paged", "mfg-delivery-order-detail", "delivery-planning"];
const INVENTORY_ROOTS = ["inventory", "stock-transfers"];

export function invalidateSoShared(qc: QueryClient) {
  bump(qc, SO_ROOTS);
}

export function invalidateDoShared(qc: QueryClient) {
  bump(qc, DO_ROOTS);
}

export function invalidateInventoryShared(qc: QueryClient) {
  bump(qc, INVENTORY_ROOTS);
}

/* A convert touches source + target doc lists (SO/DO/SI/PO/GRN) and, for a GRN,
 * inventory — invalidate the union so no desktop picker/list is left stale. */
export function invalidateConvertShared(qc: QueryClient) {
  invalidateSoShared(qc);
  invalidateDoShared(qc);
  invalidateInventoryShared(qc);
  bump(qc, ["sales-invoices", "sales-invoices-paged", "mfg-purchase-orders", "grns", "grns-paged"]);
}

/* Roots for a module whose actions write inventory_movements. Every stock-moving
 * backend route also re-walks SO stock allocation (recomputeSoStockAllocation),
 * which flips SO line READY/PENDING — so posting a GRN changes SO list rows that
 * never mention the GRN, and the SO roots have to ride along. Not INVENTORY_ROOTS:
 * none of these documents touch a stock-transfer row. */
const STOCK_ROOTS = ["inventory", ...SO_ROOTS];

/* The shared roots each generic module screen's status/payment writes touch,
 * keyed by the MODULE_CONFIGS / statusActionsFor key. Only the SCM DOCUMENT
 * modules are listed: the master-data modules (suppliers/drivers/positions/…)
 * either have no desktop react-query twin or cache under the legacy
 * ["uq", <fetcher source>] key from hooks/useQuery, which has no invalidable
 * name. */
const MODULE_SHARED_ROOTS: Record<string, string[]> = {
  "delivery-orders-mfg": [...DO_ROOTS, ...STOCK_ROOTS],
  "sales-invoices":      ["sales-invoices", "sales-invoices-paged", "sales-invoice-detail"],
  "mfg-purchase-orders": ["mfg-purchase-orders", "mfg-purchase-order-detail"],
  "grns":                ["grns", "grns-paged", "grn-detail", ...STOCK_ROOTS],
  "delivery-returns":    ["delivery-returns", "delivery-return-detail", ...STOCK_ROOTS],
  "purchase-returns":    ["purchase-returns", "purchase-return-detail", ...STOCK_ROOTS],
  "purchase-invoices":   ["purchase-invoices", "purchase-invoices-paged", "purchase-invoice-detail"],
};

export function invalidateModuleShared(qc: QueryClient, moduleKey: string) {
  const roots = MODULE_SHARED_ROOTS[moduleKey];
  if (roots) bump(qc, roots);
}
