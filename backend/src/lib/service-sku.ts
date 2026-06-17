// ----------------------------------------------------------------------------
// service-sku — SERVICE SKU vocabulary + line predicates (single source of
// truth). Ported (the generic predicates) from 2990s packages/shared/src/
// service-sku.ts so so-readiness / so-stock-allocation / the SO recomputeTotals
// classify SERVICE lines identically.
//
// SERVICE lines (delivery fee / dispose / lift) ride the whole SO chain but are
// NOT goods: never allocated stock, never gate SO readiness. The catalog row
// carries category='SERVICE'; SO/DO/SI lines carry item_group='service'; codes
// start with 'SVC-'. (Strategy-2: Houzs has no mfg_products catalog yet, so the
// item_group + code-prefix signals do the work; `category` stays optional.)
// ----------------------------------------------------------------------------

export const SVC_DELIVERY = "SVC-DELIVERY";
export const SVC_DELIVERY_CROSS = "SVC-DELIVERY-CROSS";
export const SVC_DELIVERY_ADD = "SVC-DELIVERY-ADD";

export const SERVICE_SKU_PREFIX = "SVC-";

const norm = (v: string | null | undefined): string => (v ?? "").trim().toUpperCase();

/** item_group signal — SO/DO/SI lines store 'service' (plain text column). */
export function isServiceItemGroup(itemGroup: string | null | undefined): boolean {
  return norm(itemGroup).includes("SERVICE");
}

/** catalog category signal (when joined). */
export function isServiceCategory(category: string | null | undefined): boolean {
  return norm(category) === "SERVICE";
}

/** item_code signal — every seeded SERVICE SKU code starts with SVC-. */
export function isServiceSkuCode(itemCode: string | null | undefined): boolean {
  const c = norm(itemCode);
  return c.length > SERVICE_SKU_PREFIX.length && c.startsWith(SERVICE_SKU_PREFIX);
}

export interface ServiceLineSignals {
  itemGroup?: string | null;
  itemCode?: string | null;
  category?: string | null;
}

/** A document line is a SERVICE line when ANY signal says so. */
export function isServiceLine(line: ServiceLineSignals): boolean {
  return (
    isServiceItemGroup(line.itemGroup) ||
    isServiceCategory(line.category) ||
    isServiceSkuCode(line.itemCode)
  );
}

/** Fee-type SERVICE code (SVC-DELIVERY*) — prefix-matched. */
export function isDeliveryFeeServiceCode(itemCode: string | null | undefined): boolean {
  return norm(itemCode).startsWith(SVC_DELIVERY);
}
