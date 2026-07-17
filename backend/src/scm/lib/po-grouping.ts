// ----------------------------------------------------------------------------
// po-grouping.ts — the owner's per-CATEGORY rule for how SO lines become POs.
//
// Owner, 2026-07-17, verbatim:
//   1. Bedframe（床架）：一个 SO 开成一张 PO。
//   2. Sofa（沙发）：也是一个 SO 开成一张 PO。
//   3. Mattress（床垫）：好几个 Mattress 合并开成一张 PO，然后根据我的 Delivery
//      Date 去排整。这样做的目的是为了优化我们整体的 Inventory Turnover Rate。
//
// WHAT CHANGED. The split was a SINGLE GLOBAL TOGGLE (`mode: 'combined' |
// 'per-so'`) applied to the whole convert, with exactly one hardcoded exception:
// SOFA always split per-SO. So a mixed pick could only ever get ONE behaviour —
// there was no way for bedframe to split while mattress merged in the same run.
// The rule is per-category, so the code is now per-category.
//
// SOFA's per-SO rule is NOT new and is not the owner's turnover rule — it is the
// dye-lot rule already documented at the call site (Commander 2026-05-31): a
// colour-matched set split across POs comes back in different dye lots. It
// happens to agree with rule 2. Kept, and kept for its own reason.
//
// THE MATTRESS WINDOW — the part worth reading.
// "Merge mattresses" and "optimise inventory turnover" pull in OPPOSITE
// directions if merging is unbounded: fold a mattress due in three months into
// this week's PO and it lands in the warehouse three months early. That is
// turnover made WORSE, by the rule meant to improve it. So merging is bounded by
// a DELIVERY-DATE WINDOW (owner-confirmed 2026-07-17): same (warehouse,
// supplier) AND same window -> one PO. Next week's and next quarter's mattresses
// never share a PO.
//
// The window is anchored to a real Monday (1970-01-05) rather than to "today",
// so the same line always falls in the same bucket no matter when the convert
// runs — a convert on Friday and the same convert on Monday must not produce
// different POs. At the default 7 days a bucket IS the ISO week, which is what
// makes it explainable to a human ("this week's mattresses").
//
// CATEGORIES THE OWNER DID NOT RULE ON — accessory, service, and anything else
// item_group happens to carry (it is free text, with no CHECK) — keep following
// the caller's existing toggle. He ruled on three categories; this file encodes
// three. Inventing a rule for the rest would be putting words in his mouth.
// ----------------------------------------------------------------------------

/** The caller's existing global toggle. Unchanged in meaning. */
export type PoMode = 'combined' | 'per-so';

/** How one line's PO bucket is formed. */
export type PoSplitRule =
  /** One PO per (warehouse, supplier, SO). */
  | { kind: 'per-so' }
  /** One PO per (warehouse, supplier, delivery-date window). */
  | { kind: 'per-window'; windowDays: number }
  /** One PO per (warehouse, supplier) — the toggle's 'combined'. */
  | { kind: 'combined' };

/** Default merge window for mattress. 7 = the ISO week. */
export const DEFAULT_MATTRESS_WINDOW_DAYS = 7;

/** 1970-01-05 was a Monday. Anchoring to it makes a 7-day bucket == the ISO
    week, and makes every bucket independent of when the convert runs. */
const MONDAY_EPOCH_MS = Date.parse('1970-01-05T00:00:00Z');
const DAY_MS = 86_400_000;

/**
 * The owner's rule for one line's category.
 *
 * `toggle` is the caller's existing mode, used ONLY for the categories he did
 * not rule on — so a mixed pick gets bedframe per-SO, mattress per-window, and
 * accessories still following whatever the operator picked.
 */
export function splitRuleFor(
  itemGroup: string | null | undefined,
  toggle: PoMode,
  mattressWindowDays: number = DEFAULT_MATTRESS_WINDOW_DAYS,
): PoSplitRule {
  switch ((itemGroup ?? '').trim().toLowerCase()) {
    // Dye lot (Commander 2026-05-31) — one SO's whole sofa set is one PO, never
    // merged with another SO's set, never split per component SKU. Agrees with
    // the owner's rule 2, but stands on its own reason.
    case 'sofa':
      return { kind: 'per-so' };
    // Owner rule 1 (2026-07-17).
    case 'bedframe':
      return { kind: 'per-so' };
    // Owner rule 3 (2026-07-17) — merge, but only within a delivery window, or
    // the merge defeats the turnover it exists to improve.
    case 'mattress':
      return { kind: 'per-window', windowDays: normaliseWindow(mattressWindowDays) };
    // Not ruled on — the operator's toggle still decides.
    default:
      return toggle === 'per-so' ? { kind: 'per-so' } : { kind: 'combined' };
  }
}

/** A window of at least 1 whole day. A zero/negative/NaN window would collapse
    every mattress into one bucket (or throw), silently undoing the rule —
    reject the input rather than normalise it into a wrong answer. */
function normaliseWindow(days: number): number {
  if (!Number.isFinite(days) || days < 1) return DEFAULT_MATTRESS_WINDOW_DAYS;
  return Math.floor(days);
}

/**
 * The Monday (or window start) an ISO date falls into.
 * Returns null for a missing/unparseable date — the caller must decide what to
 * do with an undated line rather than have it silently share a bucket with
 * every other undated line.
 */
export function windowStartOf(dateStr: string | null | undefined, windowDays: number): string | null {
  const s = (dateStr ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const ms = Date.parse(`${s}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  const w = normaliseWindow(windowDays);
  const daysSinceAnchor = Math.floor((ms - MONDAY_EPOCH_MS) / DAY_MS);
  // floorDiv, so dates before the anchor (there are none in practice, but the
  // maths must not flip sign) still bucket downward.
  const bucket = Math.floor(daysSinceAnchor / w);
  return new Date(MONDAY_EPOCH_MS + bucket * w * DAY_MS).toISOString().slice(0, 10);
}

export interface GroupKeyInput {
  warehouseId: string | null;
  supplierId: string;
  soDocNo: string;
  itemGroup: string | null;
  /** The PO line's delivery date — i.e. AFTER the lead time has been subtracted.
      The window buckets what the SUPPLIER is asked to deliver, not what the
      customer asked for, because that is what actually lands in the warehouse. */
  deliveryDate: string | null;
}

/**
 * The bucket key for one line. Same key = same PO.
 *
 * Every key starts (warehouse, supplier) — unchanged, and load-bearing: folding
 * the warehouse in is what guarantees each emitted PO is single-warehouse, which
 * the downstream GRN relies on to land stock where the SO line asked for it.
 *
 * An UNDATED mattress line cannot be windowed, so it falls back to its own SO
 * (`per-so`) rather than merging into an arbitrary bucket. Conservative on
 * purpose: a wrongly-merged PO is a real supplier order for goods that arrive at
 * the wrong time, and it is not obviously wrong on the screen.
 */
export function groupKeyFor(input: GroupKeyInput, toggle: PoMode, mattressWindowDays?: number): string {
  const base = `${input.warehouseId ?? 'null'}::${input.supplierId}`;
  const rule = splitRuleFor(input.itemGroup, toggle, mattressWindowDays);

  switch (rule.kind) {
    case 'per-so':
      return `${base}::${input.soDocNo}`;
    case 'per-window': {
      const start = windowStartOf(input.deliveryDate, rule.windowDays);
      return start ? `${base}::w${start}` : `${base}::${input.soDocNo}`;
    }
    case 'combined':
      return base;
  }
}
