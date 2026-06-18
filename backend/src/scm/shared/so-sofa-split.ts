// ----------------------------------------------------------------------------
// so-sofa-split — split ONE POS sofa build into per-compartment SO lines.
//
// P3 of the SO all-charges-as-SKU-lines spec
// (docs/specs/2026-06-04-so-sku-lines-and-sync-spec.md §4.3 + §8 D3).
// A POS handover sends a sofa as ONE item: itemCode = first module's SKU,
// variants.cells[] = the build layout. The reference shape (SO-2606-018,
// Backend hand-opened) is one SO line per compartment module SKU
// ({MODEL}-{moduleId}). The server splits AFTER the build-level recompute +
// drift gate — the build total (combo / PWP / fabric-tier / leg already
// folded in by recomputeFromSnapshot) is the authoritative money; this module
// only decides how it decomposes.
//
// D3 (Loo 2026-06-05): distribute the build total proportionally to each
// module's catalog SELL price; rounding residue lands on the LAST line, so
// Σ line prices === build total EXACTLY. Drift is judged on the build, never
// per line. When no module price is loadable (catalog gap), fall back to an
// equal split — still proportional, degenerate weights.
//
// Pure + shared so tests pin the distribution math.
// ----------------------------------------------------------------------------

import { normalizeCompartmentCode, orderSofaCellsLeftToRight, type Rot } from './sofa-build';

export interface SofaSplitCell {
  moduleId: string;
  x?: number | null;
  y?: number | null;
  rot?: number | null;
}

export interface SofaModuleLineSpec {
  /** 0-based position in the build's cells[] — regroup order. */
  cellIndex: number;
  /** Normalized compartment code, e.g. '1A(LHF)'. */
  moduleCode: string;
  /** Module SKU: '{MODEL}-{moduleCode}', e.g. 'ANNSA-1A(LHF)'. */
  itemCode: string;
  /** 'SOFA ANNSA 1A(LHF)' — matches the Backend hand-opened reference. */
  description: string;
  /** This line's share of the build's per-unit SELLING price (sen). */
  unitPriceSen: number;
  /** This line's share of the build's per-unit COST (sen). */
  unitCostSen: number;
  /** Cell geometry carried into variants for regrouping/preview. */
  x: number | null;
  y: number | null;
  rot: number | null;
}

/** Distribute `totalSen` across `weights` proportionally; floor each share and
 *  put the rounding residue on the LAST entry (D3), so the sum is exact.
 *  All-zero weights → equal split. Negative totals distribute symmetrically. */
export function distributeProportionally(totalSen: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  if (weights.length === 1) return [totalSen];
  const positive = weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 0));
  const sum = positive.reduce((s, w) => s + w, 0);
  const effective = sum > 0 ? positive : weights.map(() => 1);
  const effSum = sum > 0 ? sum : weights.length;
  const out: number[] = [];
  let allocated = 0;
  for (let i = 0; i < effective.length - 1; i++) {
    const share = Math.floor((totalSen * effective[i]!) / effSum);
    out.push(share);
    allocated += share;
  }
  out.push(totalSen - allocated); // residue lands on the last line (D3)
  return out;
}

/**
 * Split a sofa build into per-module line specs, or return null when the item
 * is not a splittable build (no cells / no base model) — the caller keeps the
 * legacy single line then.
 */
export function splitSofaBuildIntoModuleLines(args: {
  baseModel: string | null | undefined;
  cells: unknown;
  /** Authoritative per-build SELLING price (sen) from the server recompute. */
  buildUnitPriceSen: number;
  /** Per-build COST (sen); distributed with the same weights so margins stay
   *  sensible per line (recomputeTotals' master-combo spread may later
   *  re-derive costs — that path already works on per-module lines). */
  buildUnitCostSen: number;
  /** Module sell prices by normalized code (loadModelSofaModulePrices) —
   *  null/missing entries degrade to the equal-split fallback. */
  modulePrices: Record<string, number> | null;
  /** D4 one-shot path: split the SELLING price EVENLY across modules (cost stays
   *  on the catalog-weight split). Default false = legacy proportional split. */
  evenSplitPrice?: boolean;
  /** Seat depth (variants.depth, inches as string) — sizes the module
   *  footprints for the left-to-right walk. Omitted → 24″ baseline; a wrong
   *  depth only degrades the ORDER (walk falls back to a stable (x, y) sort),
   *  never the money. */
  depth?: string | null;
}): SofaModuleLineSpec[] | null {
  const baseModel = (args.baseModel ?? '').trim().toUpperCase();
  if (!baseModel) return null;
  if (!Array.isArray(args.cells) || args.cells.length === 0) return null;

  const parsed: SofaSplitCell[] = [];
  for (const raw of args.cells) {
    if (!raw || typeof raw !== 'object') return null; // malformed build → don't split
    const c = raw as Record<string, unknown>;
    const moduleId = typeof c.moduleId === 'string' ? c.moduleId.trim() : '';
    if (!moduleId) return null;
    parsed.push({
      moduleId,
      x: typeof c.x === 'number' ? c.x : null,
      y: typeof c.y === 'number' ? c.y : null,
      rot: typeof c.rot === 'number' ? c.rot : null,
    });
  }

  /* Left-to-right line order (Loo 2026-06-12): the SO's per-module lines —
     and the cellIndex every display fold sorts by — follow the build's visual
     walk, not the order the salesperson dragged modules onto the canvas.
     Wrap each parsed cell so the orderer's output maps back 1:1; missing
     geometry keeps the stored order (the orderer never guesses). */
  const wrapped = parsed.map((src) => ({
    src,
    moduleId: src.moduleId,
    x: src.x ?? Number.NaN,
    y: src.y ?? Number.NaN,
    // Same normalization as the display fold so both walk entry points agree
    // on degenerate stored rot (-90, 450, …).
    rot: ((((src.rot ?? 0) % 360) + 360) % 360) as Rot,
  }));
  const cells = orderSofaCellsLeftToRight(wrapped, args.depth ?? '24')
    .map((w) => (w as (typeof wrapped)[number]).src);

  const codes = cells.map((c) => normalizeCompartmentCode(c.moduleId));
  const weights = codes.map((code) => {
    const w = args.modulePrices?.[code];
    return typeof w === 'number' && w > 0 ? w : 0;
  });
  const priceWeights = args.evenSplitPrice ? codes.map(() => 1) : weights;
  const priceShares = distributeProportionally(args.buildUnitPriceSen, priceWeights);
  const costShares = distributeProportionally(args.buildUnitCostSen, weights);

  return cells.map((cell, i) => ({
    cellIndex: i,
    moduleCode: codes[i]!,
    itemCode: `${baseModel}-${codes[i]!}`,
    description: `SOFA ${baseModel} ${codes[i]!}`,
    unitPriceSen: priceShares[i]!,
    unitCostSen: costShares[i]!,
    x: cell.x ?? null,
    y: cell.y ?? null,
    rot: cell.rot ?? null,
  }));
}
