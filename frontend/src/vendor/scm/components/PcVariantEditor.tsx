// PcVariantEditor — the single, shared line-item variant editor for the whole
// Purchase Consignment family (Order / Receive / Return). Built to match the
// Purchase Order editor exactly: Fabrics + Gaps/Divan/Leg dropdowns for
// bedframes, Fabrics + Seat Size/Leg for sofas, plus the Special Orders
// checkbox row. Keeping all three forms on this one component is the whole
// point — they must never drift apart again.
//
// HOUZS VENDOR: only the SalesOrderDetail.module.css import path changed (the
// CSS is colocated in pages/scm/); the lib + @2990s/shared imports are
// verbatim (those modules are vendored under vendor/scm/lib + vendor/shared).
import { useMemo } from 'react';
import { activeOptions, maintPickerValues } from '@2990s/shared';
import { useSpecialAddons, type MaintenanceConfig } from '../lib/mfg-products-queries';
import { fabricOptionLabel, type FabricTrackingRow } from '../lib/fabric-queries';
import { sortByNumeric, byText } from '../lib/sort-options';
import styles from '../../../pages/scm-v2/SalesOrderDetail.module.css';

const SpecialsCheckboxes = ({
  pool, picked, onChange,
}: {
  pool: Array<{ value: string }> | undefined;
  picked: string[];
  onChange: (arr: string[]) => void;
}) => {
  if (!pool || pool.length === 0) return null;
  return (
    <div style={{ marginTop: 'var(--space-2)' }}>
      <div style={{
        fontSize: 'var(--fs-11)', fontWeight: 700, letterSpacing: '0.08em',
        textTransform: 'uppercase', color: 'var(--fg-muted)', marginBottom: 4,
      }}>
        Special Orders
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 16px' }}>
        {pool.map((o) => {
          const on = picked.includes(o.value);
          return (
            <label key={o.value} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--fs-12)', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={on}
                onChange={() => onChange(on ? picked.filter((x) => x !== o.value) : [...picked, o.value])}
              />
              {o.value}
            </label>
          );
        })}
      </div>
    </div>
  );
};

/* ACTIVE fabrics only (owner spec 2026-06-12, fabric_trackings.is_active) —
 * a line whose saved fabric was later deactivated still shows it. */
const pickableFabrics = (fabrics: FabricTrackingRow[], current: string): FabricTrackingRow[] =>
  fabrics.filter((f) => f.is_active !== false || f.fabric_code === current);

export const PcVariantEditor = ({
  category, variants, onChange, fabrics, maint,
}: {
  category: string;
  variants: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  fabrics: FabricTrackingRow[];
  maint: MaintenanceConfig;
}) => {
  const specials = Array.isArray(variants.specials) ? (variants.specials as string[]) : [];

  // Specials pool now comes from special_addons (Backend↔POS parity, Loo
  // 2026-06-08), filtered by this line's category — replacing the legacy
  // maint.specials / maint.sofaSpecials string pools. `code` shares the old
  // value namespace so saved picks keep matching.
  const specialAddonsQ = useSpecialAddons();
  const specialsPool = useMemo(() => {
    const cat = category === 'bedframe' ? 'BEDFRAME' : category === 'sofa' ? 'SOFA' : null;
    if (!cat) return [];
    return (specialAddonsQ.data ?? [])
      .filter((r) => r.active && r.categories.includes(cat))
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder || (a.code ?? '').localeCompare(b.code ?? ''))
      .map((r) => ({ value: r.code }));
  }, [specialAddonsQ.data, category]);

  if (category === 'bedframe') {
    return (
      <>
        <div className={styles.formGrid4}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Fabrics</span>
            <select
              className={styles.fieldSelect}
              value={String(variants.fabricCode ?? '')}
              onChange={(e) => onChange('fabricCode', e.target.value)}
            >
              <option value="" disabled>Select…</option>
              {[...pickableFabrics(fabrics, String(variants.fabricCode ?? ''))].sort((a, b) => byText(fabricOptionLabel(a), fabricOptionLabel(b))).map((f) => (
                <option key={f.id} value={f.fabric_code}>
                  {fabricOptionLabel(f)}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Gaps</span>
            <select
              className={styles.fieldSelect}
              value={String(variants.gap ?? '')}
              onChange={(e) => onChange('gap', e.target.value)}
            >
              <option value="" disabled>Select…</option>
              {sortByNumeric(maintPickerValues(maint.gaps, String(variants.gap ?? ''))).map((g) => (<option key={g} value={g}>{g}</option>))}
            </select>
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Divan Heights</span>
            <select
              className={styles.fieldSelect}
              value={String(variants.divanHeight ?? '')}
              onChange={(e) => onChange('divanHeight', e.target.value)}
            >
              <option value="" disabled>Select…</option>
              {sortByNumeric(activeOptions(maint.divanHeights, String(variants.divanHeight ?? ''))).map((o) => (<option key={o.value} value={o.value}>{o.value}</option>))}
            </select>
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Leg Heights</span>
            <select
              className={styles.fieldSelect}
              value={String(variants.legHeight ?? '')}
              onChange={(e) => onChange('legHeight', e.target.value)}
            >
              <option value="" disabled>Select…</option>
              {sortByNumeric(activeOptions(maint.legHeights, String(variants.legHeight ?? ''))).map((o) => (<option key={o.value} value={o.value}>{o.value}</option>))}
            </select>
          </label>
        </div>
        <SpecialsCheckboxes
          pool={specialsPool}
          picked={specials}
          onChange={(arr) => onChange('specials', arr)}
        />
      </>
    );
  }

  if (category === 'sofa') {
    return (
      <>
        <div className={styles.formGrid4}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Fabrics</span>
            <select
              className={styles.fieldSelect}
              value={String(variants.fabricCode ?? '')}
              onChange={(e) => onChange('fabricCode', e.target.value)}
            >
              <option value="" disabled>Select…</option>
              {[...pickableFabrics(fabrics, String(variants.fabricCode ?? ''))].sort((a, b) => byText(fabricOptionLabel(a), fabricOptionLabel(b))).map((f) => (
                <option key={f.id} value={f.fabric_code}>
                  {fabricOptionLabel(f)}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Seat Size</span>
            <select
              className={styles.fieldSelect}
              value={String(variants.seatHeight ?? '')}
              onChange={(e) => onChange('seatHeight', e.target.value)}
            >
              <option value="" disabled>Select…</option>
              {sortByNumeric(maintPickerValues(maint.sofaSizes, String(variants.seatHeight ?? ''))).map((s) => (<option key={s} value={s}>{s}</option>))}
            </select>
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Leg Heights</span>
            <select
              className={styles.fieldSelect}
              value={String(variants.legHeight ?? '')}
              onChange={(e) => onChange('legHeight', e.target.value)}
            >
              <option value="" disabled>Select…</option>
              {sortByNumeric(activeOptions(maint.sofaLegHeights, String(variants.legHeight ?? ''))).map((o) => (<option key={o.value} value={o.value}>{o.value}</option>))}
            </select>
          </label>
          <span />
        </div>
        <SpecialsCheckboxes
          pool={specialsPool}
          picked={specials}
          onChange={(arr) => onChange('specials', arr)}
        />
      </>
    );
  }

  return null;
};
