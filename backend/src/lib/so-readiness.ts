// ----------------------------------------------------------------------------
// so-readiness — SO header status + "stock remark" derivation. 1:1 clone of
// 2990s apps/api/src/lib/so-readiness.ts (pure functions — no DB, no furniture).
// Only SEAM: the `isServiceLine` import moves from @2990s/shared to the local
// ./service-sku port (rule #9).
//
// B2C semantics: an SO ships once every MAIN product (SOFA / BEDFRAME /
// MATTRESS) is in stock — accessories pending DO NOT block ship.
//
// Used by:
//   - recomputeSoStockAllocation (auto-advance / regress header on stock change)
//   - PATCH /:docNo/items/:itemId/stock-status (manual READY toggle)
//   - GET /mfg-sales-orders (list aggregate — emits stock_remark per row)
//
// Remark output — shows WHAT IS READY:
//   ""               — nothing ready / no items
//   "READY"          — every line (MAIN + ACC) is READY
//   "READY (PARTIAL)" — every MAIN line READY, some ACC line still PENDING
//   "BEDFRAME"       — every BEDFRAME line READY, MAIN of other cats pending
//   "MATTRESS/ACC"   — "/"-joined list of categories that ARE ready
// ----------------------------------------------------------------------------

import { isServiceLine } from "./service-sku";

export const MAIN_CATEGORIES = new Set(["SOFA", "BEDFRAME", "MATTRESS"]);

/** Normalise a free-text item_group to one of the known buckets. */
export function normCategory(raw: string | null | undefined): string {
  const g = (raw ?? "").trim().toUpperCase();
  if (g.includes("BEDFRAME")) return "BEDFRAME";
  if (g.includes("SOFA")) return "SOFA";
  if (g.includes("MATTRESS")) return "MATTRESS";
  if (g.includes("ACCESSOR")) return "ACCESSORY";
  if (g.includes("SERVICE")) return "SERVICE";
  return "OTHERS";
}

export type ReadinessLine = {
  item_group: string | null;
  /** Used to detect SERVICE lines (SVC- code) when item_group is ambiguous. */
  item_code?: string | null;
  stock_status: "PENDING" | "READY" | string;
  cancelled?: boolean | null;
};

export type ReadinessSummary = {
  mainCount: number;
  mainReady: number;
  accCount: number;
  accReady: number;
  /** True when every MAIN line is READY (regardless of accessories). */
  isMainReady: boolean;
  /** True when EVERY non-cancelled line — incl. accessories — is READY. */
  isFullyReady: boolean;
  /** UI label per the contract above (empty string when SO has no lines). */
  stockRemark: string;
  /** Category labels still PENDING, dedup'd + sorted. */
  pendingCategories: string[];
};

/**
 * Roll up per-line stock_status into the SO-header readiness story.
 * Cancelled lines are filtered. Empty input → no-flag default.
 */
export function summariseReadiness(lines: ReadinessLine[]): ReadinessSummary {
  const live = lines.filter((l) => !l.cancelled);
  let mainCount = 0,
    mainReady = 0,
    accCount = 0,
    accReady = 0;
  const mainByCat = new Map<string, { total: number; ready: number }>();
  const pendingMainCats = new Set<string>();
  let anyAccPending = false;

  for (const l of live) {
    // SERVICE lines have no inventory — never gate stock readiness.
    if (isServiceLine({ itemGroup: l.item_group, itemCode: l.item_code })) continue;
    const cat = normCategory(l.item_group);
    const isMain = MAIN_CATEGORIES.has(cat);
    const isReady = l.stock_status === "READY";
    if (isMain) {
      mainCount += 1;
      const cell = mainByCat.get(cat) ?? { total: 0, ready: 0 };
      cell.total += 1;
      if (isReady) {
        mainReady += 1;
        cell.ready += 1;
      } else pendingMainCats.add(cat);
      mainByCat.set(cat, cell);
    } else {
      accCount += 1;
      if (isReady) accReady += 1;
      else anyAccPending = true;
    }
  }

  const isMainReady = mainCount > 0 ? mainReady === mainCount : true;
  const isFullyReady = mainCount + accCount > 0 && mainReady === mainCount && accReady === accCount;

  let stockRemark = "";
  if (mainCount + accCount === 0) {
    stockRemark = "";
  } else if (isFullyReady) {
    stockRemark = "READY";
  } else if (isMainReady) {
    stockRemark = "READY (PARTIAL)";
  } else {
    const readyCats: string[] = [];
    for (const cat of ["BEDFRAME", "SOFA", "MATTRESS"]) {
      const cell = mainByCat.get(cat);
      if (cell && cell.total > 0 && cell.ready === cell.total) readyCats.push(cat);
    }
    if (accCount > 0 && accReady === accCount) readyCats.push("ACC");
    stockRemark = readyCats.join("/");
  }

  const pc = [...pendingMainCats].sort();
  if (anyAccPending) pc.push("ACC");

  return { mainCount, mainReady, accCount, accReady, isMainReady, isFullyReady, stockRemark, pendingCategories: pc };
}
