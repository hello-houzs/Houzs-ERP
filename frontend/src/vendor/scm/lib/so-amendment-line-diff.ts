// ----------------------------------------------------------------------------
// so-amendment-line-diff — PURE display logic for the LINE half of an SO
// amendment. NO React, no I/O. The approver's job card (AmendmentDetailV2), the
// desktop SO-detail diff modal and the mobile "View changes" sheet all render
// the same rows, so "is this line actually a change, and WHICH field moved"
// lives ONCE — the header half's mirror of so-amendment-header.ts.
//
// WHY THIS EXISTS (Owner 2026-07-16): "完全看不出有什麼變動申請？" — an amendment
// whose real request was a HEADER change rendered four SPEC CHANGE cards whose
// Was and Requesting columns were character-for-character identical, above a
// header that claimed "4 changes". The approver could not tell what was being
// asked, and the count was a lie.
//
// A recorded line can be delta-free for two reasons, both real in prod data:
//   * the create-time builder's dirtiness test (lineCommitSig) was WIDER than
//     the payload an amendment line can carry, so a line dirty only in
//     lineDeliveryDate — which the header Delivery Date cascade rewrites on
//     EVERY non-overridden line — was recorded with new_* == old_*.
//   * draftFromItem canonicalises variants (POS sofa aliases) while the
//     oldSnapshot records the RAW item.variants, so a POS-created line could
//     record a "changed" variant blob that renders identically.
// The builders no longer record either (see buildAmendmentLines on both
// platforms), but rows created before that fix are already in the DB — this
// module is what stops them lying to the approver.
//
// The comparison is deliberately made on the RENDERED values, not the raw
// blobs: the surfaces show item code / qty / unit price / variant SUMMARY, and
// the summary is alias-aware (buildVariantSummary) while the raw variants are
// not. Comparing raw JSON would call a canonicalised-but-identical POS line a
// change — exactly the lie this closes. The rule is simply: if what the
// approver reads on the left equals what they read on the right, it is not a
// change. No real request can be hidden by it — these four fields are the ONLY
// things an amendment line carries.
// ----------------------------------------------------------------------------

import { buildVariantSummary } from '@2990s/shared';

/** The old_snapshot blob both builders record. */
export type AmendmentOldSnapshot = {
  itemCode?: string;
  qty?: number;
  unitPriceSen?: number;
  description2?: string | null;
  variants?: unknown;
};

/** The subset of an amendment line this module reads. Structural, so the
    vendored AmendmentLine satisfies it without a cast at any call site. */
export type DiffableAmendmentLine = {
  change_type: string;
  new_item_code?: string | null;
  new_variants?: unknown;
  new_qty?: number | null;
  new_unit_price_sen?: number | null;
  old_snapshot?: unknown;
};

export const amendmentOldSnapshot = (l: DiffableAmendmentLine): AmendmentOldSnapshot =>
  (l.old_snapshot as AmendmentOldSnapshot | null) ?? {};

/** Which of the line's four carryable fields this request actually moves. */
export type AmendmentLineChangedFields = {
  itemCode: boolean;
  qty: boolean;
  unitPrice: boolean;
  variants: boolean;
};

const EVERYTHING: AmendmentLineChangedFields = {
  itemCode: true, qty: true, unitPrice: true, variants: true,
};

/** Render one variant blob the way the surfaces do. The '' itemGroup matches
    what all three already pass — what matters here is that BOTH sides go through
    it identically (see variantsChanged). */
const summaryOf = (v: unknown): string =>
  buildVariantSummary('', (v as Record<string, unknown> | null) ?? null).trim();

/** The variant summary each side RENDERS — old_snapshot.description2 is the
    server-stamped summary (built with the line's REAL item group), the new side
    is built from the requested blob. Display only; the change test below does
    NOT use this pair, deliberately. */
export const amendmentVariantSummaries = (
  l: DiffableAmendmentLine,
): { from: string; to: string } => ({
  from: (amendmentOldSnapshot(l).description2 ?? '').trim(),
  to: summaryOf(l.new_variants),
});

/**
 * Did the request actually move the variants?
 *
 * Both blobs go through the SAME formatter, rather than comparing the new
 * summary against the stored description2. That symmetry is the whole point —
 * it cancels the two ways an unchanged line can look changed:
 *   * description2 was stamped with the line's real item group, while the new
 *     side is rendered with ''. buildVariantSummary BRANCHES on the group
 *     (bedframe reads DIVAN/GAP/T.Heights, everything else SEAT/LEG), so an
 *     untouched BEDFRAME line would otherwise diff purely on formatting.
 *   * new_variants is draftFromItem's CANONICALISED blob while
 *     old_snapshot.variants is the RAW item blob, so a POS-vocabulary line
 *     (depth / sofaLegHeight) would otherwise diff purely on key names — and
 *     the formatter reads both vocabularies (seatHeight || depth,
 *     legHeight || sofaLegHeight), so it collapses that too.
 * A raw JSON compare fixes neither. What survives both is a real spec change.
 */
const variantsChanged = (l: DiffableAmendmentLine): boolean => {
  const old = amendmentOldSnapshot(l);
  const to = summaryOf(l.new_variants);
  // No raw blob recorded (legacy row) — the stamped summary is the only signal
  // left, so fall back to it rather than guess.
  if (old.variants == null) return (old.description2 ?? '').trim() !== to;
  return summaryOf(old.variants) !== to;
};

export function amendmentLineChangedFields(
  l: DiffableAmendmentLine,
): AmendmentLineChangedFields {
  // An ADD has no before and a REMOVE has no after — the row itself IS the
  // change, there is nothing to compare.
  if (l.change_type === 'ADD' || l.change_type === 'REMOVE') return EVERYTHING;
  const old = amendmentOldSnapshot(l);
  return {
    /* `?? old` mirrors what every surface renders on the Requesting side: an
       omitted new value falls back to the old one, so it READS as unchanged and
       must not be flagged as a change. */
    itemCode: (l.new_item_code ?? old.itemCode ?? null) !== (old.itemCode ?? null),
    qty:      (l.new_qty ?? old.qty ?? null) !== (old.qty ?? null),
    /* A null price is not a requested price — the surfaces render no price at
       all on the Requesting side rather than falling back to the old one. */
    unitPrice: l.new_unit_price_sen != null
      && l.new_unit_price_sen !== (old.unitPriceSen ?? null),
    variants: variantsChanged(l),
  };
}

/** True when the line requests at least one field change. */
export const amendmentLineIsChange = (l: DiffableAmendmentLine): boolean => {
  const f = amendmentLineChangedFields(l);
  return f.itemCode || f.qty || f.unitPrice || f.variants;
};

/** The lines worth SHOWING — and worth COUNTING. A delta-free row is dropped:
    it is not a change, so it must not render as one or inflate the "N changes"
    total the approver reads. */
export const visibleAmendmentLines = <T extends DiffableAmendmentLine>(
  lines: T[],
): T[] => lines.filter(amendmentLineIsChange);
