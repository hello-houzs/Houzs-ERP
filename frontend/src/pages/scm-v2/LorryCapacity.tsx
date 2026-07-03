// ----------------------------------------------------------------------------
// Lorry Capacity — STAGE 5B (final) of the Delivery / TMS module.
//
// The fleet performance dashboard. For a date range (Last / This / Next month,
// or a Custom from–to) and a fleet filter (All / In-house / Outsourced) it shows
// a summary metric-card row + a per-lorry metric table replicating the owner's
// Houzs "Lorry Capacity" page: Work Days · Repair Days (editable) · Available
// Days · Utilisation · Total Trips · Delivery Days · Deliveries · Orders/Trip ·
// Setup/Dismantle · Pickups · Services · Delivery Revenue · Revenue/Order ·
// Revenue/Trip. The header reports the working-day count (Mon–Sat) in range.
//
// All metrics + the working-day count are computed server-side (GET
// /lorry-capacity); this page renders them and drives the two inline edits:
// the In-house checkbox (PATCH …/in-house) and the Repair Days number (PUT
// …/repair-days, which writes a single dashboard-managed maintenance window for
// the queried range). Range + fleet live in the URL (useSearchParams) so a
// link / refresh keeps the view.
//
// Style: 2990 cream brand (CSS module + design-system tokens). Utilisation is
// tinted (low → red-ish, healthy → green-ish), like Houzs. Money is integer
// cents from the API → fmtCenti for the RM display. Every number is rounded.
// ----------------------------------------------------------------------------

import { useMemo, useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { fmtCenti, fmtDate } from '@2990s/shared';
import {
  useLorryCapacity,
  useToggleLorryInHouse,
  useSetRepairDays,
  type FleetFilter,
  type LorryCapacityRow,
} from '../../vendor/scm/lib/lorry-capacity-queries';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import styles from './LorryCapacity.module.css';

/* ── Range presets ──────────────────────────────────────────────────────────
   Compute a {from,to} ISO range (YYYY-MM-DD, UTC-anchored so it matches the
   server's calendar-day math) for a named preset. 'custom' is driven by the URL
   from/to params directly. */
type RangePreset = 'last' | 'this' | 'next' | 'custom';

function isoUTC(y: number, mZeroBased: number, d: number): string {
  return new Date(Date.UTC(y, mZeroBased, d)).toISOString().slice(0, 10);
}
function monthRange(offset: number): { from: string; to: string } {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + offset;
  return { from: isoUTC(y, m, 1), to: isoUTC(y, m + 1, 0) };  // day 0 of next month = last day of this
}
function rangeForPreset(preset: RangePreset, custom: { from: string; to: string }): { from: string; to: string } {
  if (preset === 'last') return monthRange(-1);
  if (preset === 'this') return monthRange(0);
  if (preset === 'next') return monthRange(1);
  return custom;
}

const RANGE_TABS: Array<{ key: RangePreset; label: string }> = [
  { key: 'last', label: 'Last Month' },
  { key: 'this', label: 'This Month' },
  { key: 'next', label: 'Next Month' },
  { key: 'custom', label: 'Custom' },
];

const FLEET_TABS: Array<{ key: FleetFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'internal', label: 'In-house' },
  { key: 'outsourced', label: 'Outsourced' },
];

/* Display helpers — all null-safe ("—"). */
const dash = '—';
function numOrDash(n: number | null | undefined, dp = 0): string {
  if (n == null || !Number.isFinite(n)) return dash;
  return n.toLocaleString('en-MY', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
function pctOrDash(frac: number | null | undefined): string {
  if (frac == null || !Number.isFinite(frac)) return dash;
  return `${Math.round(frac * 100)}%`;
}
function centiOrDash(centi: number | null | undefined): string {
  if (centi == null) return dash;
  return fmtCenti(centi);
}

/* Utilisation tint class — low (<60%) red, mid (<90%) burnt, else green. */
function utilClass(frac: number | null): string {
  if (frac == null) return styles.utilMid!;
  if (frac < 0.6) return styles.utilLow!;
  if (frac < 0.9) return styles.utilMid!;
  return styles.utilHigh!;
}

export const LorryCapacity = () => {
  const [params, setParams] = useSearchParams();
  const notify = useNotify();

  const preset = (params.get('range') as RangePreset) ?? 'this';
  const activePreset: RangePreset = RANGE_TABS.some((r) => r.key === preset) ? preset : 'this';
  const fleetParam = (params.get('fleet') as FleetFilter) ?? 'all';
  const fleet: FleetFilter = FLEET_TABS.some((f) => f.key === fleetParam) ? fleetParam : 'all';

  /* Custom range from the URL, defaulting to this-month when first switching. */
  const thisMonth = monthRange(0);
  const customFrom = params.get('from') || thisMonth.from;
  const customTo = params.get('to') || thisMonth.to;
  const { from, to } = rangeForPreset(activePreset, { from: customFrom, to: customTo });

  const setPreset = (p: RangePreset) => {
    const next = new URLSearchParams(params);
    next.set('range', p);
    if (p === 'custom') { next.set('from', customFrom); next.set('to', customTo); }
    else { next.delete('from'); next.delete('to'); }
    setParams(next, { replace: true });
  };
  const setFleet = (f: FleetFilter) => {
    const next = new URLSearchParams(params);
    if (f === 'all') next.delete('fleet'); else next.set('fleet', f);
    setParams(next, { replace: true });
  };
  const setCustom = (key: 'from' | 'to', val: string) => {
    const next = new URLSearchParams(params);
    next.set('range', 'custom');
    next.set(key, val);
    next.set(key === 'from' ? 'to' : 'from', key === 'from' ? customTo : customFrom);
    setParams(next, { replace: true });
  };

  const { data, isLoading, error } = useLorryCapacity({ from, to, fleet });
  const toggleInHouse = useToggleLorryInHouse();
  const setRepair = useSetRepairDays();

  const rows = useMemo<LorryCapacityRow[]>(() => data?.lorries ?? [], [data]);
  const totals = data?.totals;
  const workingDays = data?.workingDays ?? 0;

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div>
          <h1 className={styles.title}>Lorry Capacity</h1>
          <p className={styles.subtitle}>
            Working days Mon–Sat · {workingDays} in range
            {' · '}{fmtDate(from)} – {fmtDate(to)}
          </p>
        </div>
        <div className={styles.controls}>
          {/* Date-range segment */}
          <div className={styles.segment}>
            {RANGE_TABS.map((r) => (
              <button
                key={r.key}
                type="button"
                className={`${styles.segBtn} ${activePreset === r.key ? styles.segBtnActive : ''}`}
                onClick={() => setPreset(r.key)}
              >
                {r.label}
              </button>
            ))}
          </div>
          {activePreset === 'custom' && (
            <div className={styles.customRange}>
              <input
                type="date" className={styles.dateInput} value={customFrom}
                max={customTo} onChange={(e) => setCustom('from', e.target.value)}
              />
              <span className={styles.rangeDash}>–</span>
              <input
                type="date" className={styles.dateInput} value={customTo}
                min={customFrom} onChange={(e) => setCustom('to', e.target.value)}
              />
            </div>
          )}
          {/* Fleet segment */}
          <div className={styles.segment}>
            {FLEET_TABS.map((f) => (
              <button
                key={f.key}
                type="button"
                className={`${styles.segBtn} ${fleet === f.key ? styles.segBtnActive : ''}`}
                onClick={() => setFleet(f.key)}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && !isLoading && (
        <div className={styles.bannerWarn}>
          <strong>Failed to load lorry capacity.</strong>{' '}
          {error instanceof Error ? error.message : String(error)}
        </div>
      )}

      {/* Summary metric cards */}
      <div className={styles.cards}>
        <MetricCard label="Lorries" value={numOrDash(totals?.lorries)} />
        <MetricCard label="Total Trips" value={numOrDash(totals?.total_trips)} />
        <MetricCard label="Available Days" value={numOrDash(totals?.available_days)} />
        <MetricCard label="Utilisation" value={pctOrDash(totals?.utilisation)} />
        <MetricCard label="Orders/Delivery Trip" value={numOrDash(totals?.orders_per_delivery_trip, 2)} />
        <MetricCard label="Delivery Revenue" value={centiOrDash(totals?.delivery_revenue_centi)} />
        <MetricCard label="Revenue/Order" value={centiOrDash(totals?.revenue_per_order_centi)} />
        <MetricCard label="Revenue/Trip" value={centiOrDash(totals?.revenue_per_trip_centi)} />
      </div>

      {/* Per-lorry metric table */}
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.left}>Lorry</th>
              <th className={styles.center}>In-house</th>
              <th>Work Days</th>
              <th>Repair Days</th>
              <th>Available Days</th>
              <th>Utilisation</th>
              <th>Total Trips</th>
              <th>Delivery Days</th>
              <th>Deliveries</th>
              <th>Orders/Trip</th>
              <th>Setup/Dismantle</th>
              <th>Pickups</th>
              <th>Services</th>
              <th>Delivery Revenue</th>
              <th>Revenue/Order</th>
              <th>Revenue/Trip</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr><td className={styles.emptyState} colSpan={16}>Loading…</td></tr>
            )}
            {!isLoading && rows.length === 0 && (
              <tr><td className={styles.emptyState} colSpan={16}>No lorries in this fleet view.</td></tr>
            )}
            {!isLoading && rows.map((l) => (
              <LorryRow
                key={l.lorry_id}
                lorry={l}
                onToggleInHouse={(isInternal) =>
                  toggleInHouse.mutate({ id: l.lorry_id, isInternal })}
                onSetRepair={(days) =>
                  setRepair.mutate(
                    { id: l.lorry_id, from, to, days },
                    { onError: (e) => notify({ title: "Couldn't save repair days.", body: e instanceof Error ? e.message : String(e), tone: 'error' }) },
                  )}
              />
            ))}
          </tbody>
          {!isLoading && rows.length > 0 && totals && (
            <tfoot>
              <tr>
                <td className={styles.left}>Fleet total</td>
                <td className={styles.center}>{dash}</td>
                <td>{dash}</td>
                <td>{dash}</td>
                <td>{numOrDash(totals.available_days)}</td>
                <td>{pctOrDash(totals.utilisation)}</td>
                <td>{numOrDash(totals.total_trips)}</td>
                <td>{dash}</td>
                <td>{dash}</td>
                <td>{numOrDash(totals.orders_per_delivery_trip, 2)}</td>
                <td>{dash}</td>
                <td>{dash}</td>
                <td>{dash}</td>
                <td>{centiOrDash(totals.delivery_revenue_centi)}</td>
                <td>{centiOrDash(totals.revenue_per_order_centi)}</td>
                <td>{centiOrDash(totals.revenue_per_trip_centi)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
};

const MetricCard = ({ label, value }: { label: string; value: string }) => (
  <div className={styles.card}>
    <span className={styles.cardLabel}>{label}</span>
    <span className={styles.cardValue}>{value}</span>
  </div>
);

/* One lorry row. The Repair Days input is locally controlled so typing doesn't
   thrash the query; it commits on blur / Enter only when the value changed. */
const LorryRow = ({
  lorry, onToggleInHouse, onSetRepair,
}: {
  lorry: LorryCapacityRow;
  onToggleInHouse: (isInternal: boolean) => void;
  onSetRepair: (days: number) => void;
}) => {
  const [repair, setRepair] = useState(String(lorry.repair_days));
  // Keep the local field in sync if the server value changes (range / fleet flip).
  useEffect(() => { setRepair(String(lorry.repair_days)); }, [lorry.repair_days]);

  const commitRepair = () => {
    const n = Math.max(0, Math.round(Number(repair)) || 0);
    if (n !== lorry.repair_days) onSetRepair(n);
    setRepair(String(n));
  };

  return (
    <tr>
      <td className={styles.left}>
        <span className={styles.plate}>{lorry.plate}</span>
        {lorry.type && lorry.type !== 'OTHER' && (
          <span className={styles.lorryType}>{lorry.type.replace(/^LORRY_/, '').replace(/FT$/, 'ft')}</span>
        )}
      </td>
      <td className={styles.center}>
        <label className={styles.checkCell} onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={lorry.is_internal}
            onChange={(e) => onToggleInHouse(e.target.checked)}
          />
        </label>
      </td>
      <td>{numOrDash(lorry.work_days)}</td>
      <td>
        <input
          className={styles.repairInput}
          type="number" min={0} step={1}
          value={repair}
          onChange={(e) => setRepair(e.target.value)}
          onBlur={commitRepair}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        />
      </td>
      <td>{numOrDash(lorry.available_days)}</td>
      <td>
        <span className={`${styles.utilPill} ${utilClass(lorry.utilisation)}`}>
          {pctOrDash(lorry.utilisation)}
        </span>
      </td>
      <td>{numOrDash(lorry.total_trips)}</td>
      <td>{numOrDash(lorry.delivery_days)}</td>
      <td>{numOrDash(lorry.deliveries)}</td>
      <td>{numOrDash(lorry.orders_per_trip, 2)}</td>
      <td>{numOrDash(lorry.setup_dismantle)}</td>
      <td>{numOrDash(lorry.pickups)}</td>
      <td>{numOrDash(lorry.services)}</td>
      <td className={styles.money}>{centiOrDash(lorry.delivery_revenue_centi)}</td>
      <td className={styles.money}>{centiOrDash(lorry.revenue_per_order_centi)}</td>
      <td className={styles.money}>{centiOrDash(lorry.revenue_per_trip_centi)}</td>
    </tr>
  );
};
