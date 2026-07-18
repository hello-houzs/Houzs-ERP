/* One warehouse display label, one order — CODE first, then name.

   Nine call sites resolved a warehouse to a human label and two of them
   disagreed on the order, so the SAME warehouse rendered "KL WAREHOUSE" on a
   DO and "BALAKONG WAREHOUSE" on the mobile SO card. Code-first wins because
   the stored `sales_location` snapshot and every document label map already
   emit the code; making the outlier follow keeps a correctly-derived SO's
   warehouse label byte-identical to its stored text. */

export type WarehouseLabelSource = {
  code?: string | null;
  name?: string | null;
};

const trimmed = (v: string | null | undefined): string | null => {
  const s = (v ?? '').trim();
  return s === '' ? null : s;
};

export const warehouseLabel = (
  w: WarehouseLabelSource | null | undefined,
): string | null => {
  if (!w) return null;
  return trimmed(w.code) ?? trimmed(w.name);
};
