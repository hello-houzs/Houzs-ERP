// ----------------------------------------------------------------------------
// VariantDescription — consistent rendering of the "Description" column on
// every Convert From picker (GRN ← PO, DO ← SO, SI ← DO, DR ← DO, PI ← GRN,
// PO ← SO). Wei Siang 2026-05-30.
//
// Background: legacy line data stores the variant string into different
// fields depending on which upstream doc it came from — sometimes in
// `description`, sometimes in `variants`, sometimes blank. So rendering the
// raw `description` field directly produces 1-line / 2-line / variant-in-the-
// wrong-place inconsistency across rows.
//
// This component normalises: always show the LIVE variant summary
// (computed from `variants` via buildVariantSummary), and only show the
// stored description text when it actually adds information (non-empty,
// not the item_code repeat, not a stray variant string).
// ----------------------------------------------------------------------------

import { buildVariantSummary } from '@2990s/shared';

export const VariantDescription = ({
  itemCode, itemGroup, variants, description,
  mutedClassName,
}: {
  itemCode: string;
  itemGroup: string | null;
  variants: unknown;
  description: string | null | undefined;
  mutedClassName?: string;
}) => {
  const summary = buildVariantSummary(
    itemGroup ?? '',
    (variants as Record<string, unknown> | null | undefined) ?? null,
  );
  const desc = (description ?? '').trim();
  /* Show the stored description ONLY when it adds info:
       - non-empty
       - not equal to the item code (already shown in the Item Code column)
       - doesn't look like a variant string (no " / " separator — catches the
         legacy rows that stored "BF-01 / DIVAN…" into description) */
  const showDesc = Boolean(desc) && desc !== itemCode && !desc.includes(' / ');
  return (
    <div>
      {showDesc && <div>{desc}</div>}
      <div className={mutedClassName} style={{ fontSize: 'var(--fs-11)' }}>
        {summary || 'Standard'}
      </div>
    </div>
  );
};
