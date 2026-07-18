// ----------------------------------------------------------------------------
// FulfillmentCosting — Finance > Fulfillment Costing.
//
// Read-only THREE-WAY cost comparison per Sales Order line:
//   ① Order-time cost   (SO estimate at order)
//   ② DO ship-time FIFO (frozen at ship — mig 0143)
//   ③ SI landed cost    (store-card cost after the supplier PI lands)
// with stage-to-stage variance flags, a 5-tile summary strip, and By Item /
// Category / Menu / State grouping.
//
// WHY THIS PAGE EXISTS: #786 removed cost/margin from the SO/DO/SI/DR document
// views; this is now the ONLY place cost lives. It is finance-only — gated in
// App.tsx (canViewScmCosting) and again server-side (canViewScmFinance), so a
// sales user never reaches it. The server does all the math (backend/src/scm/
// lib/fulfillment-costing.ts); this page only renders + filters.
//
// English + MYR + DD/MM/YYYY, per repo house style. Desktop back-office
// analytics — no mobile parity (a Finance mobile surface would be a follow-up).
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { PageHeader } from '../../components/Layout';
import { StatCard } from '../../components/StatCard';
import {
  useFulfillmentCosting,
  type FulfilmentCostingDimension,
  type FulfilmentCostingRow,
} from '../../vendor/scm/lib/reports-queries';

const fmtRm = (centi: number | null | undefined): string => {
  if (centi == null) return '—';
  return `MYR ${(Number(centi) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const fmtPct = (pct: number | null | undefined): string =>
  pct == null ? '—' : `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`;

/* Variance flag thresholds (mockup): >5% strong, 2-5% mild, else neutral. The
   Tailwind tone classes match StatCard / the app's design tokens. */
function varianceTone(pct: number | null): { cls: string; band: 'none' | 'mild' | 'strong' } {
  if (pct == null) return { cls: 'text-ink-muted', band: 'none' };
  const a = Math.abs(pct);
  if (a > 5) return { cls: 'text-err font-semibold', band: 'strong' };
  if (a >= 2) return { cls: 'text-warning-text font-medium', band: 'mild' };
  return { cls: 'text-ink-secondary', band: 'none' };
}

const DIMENSIONS: { key: FulfilmentCostingDimension; label: string }[] = [
  { key: 'item', label: 'By Item' },
  { key: 'category', label: 'By Category' },
  { key: 'menu', label: 'By Menu' },
  { key: 'state', label: 'By State' },
];

const th = 'px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-brand text-ink-muted';
const thR = 'px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-brand text-ink-muted';
const td = 'px-3 py-2 text-[13px] text-ink';
const tdR = 'px-3 py-2 text-right text-[13px] text-ink tabular-nums';

export const FulfillmentCosting = () => {
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [itemCode, setItemCode] = useState('');
  const [category, setCategory] = useState('');
  const [state, setState] = useState('');
  const [groupBy, setGroupBy] = useState<FulfilmentCostingDimension>('category');
  const [minVar, setMinVar] = useState('');
  const [pendingOnly, setPendingOnly] = useState(false);

  const minVariancePct = minVar.trim() !== '' && !Number.isNaN(Number(minVar)) ? Number(minVar) : null;

  const q = useFulfillmentCosting({
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    itemCode: itemCode.trim() || undefined,
    category: category.trim() || undefined,
    state: state.trim() || undefined,
    groupBy,
    minVariancePct,
    pending: pendingOnly || undefined,
  });

  const data = q.data;
  const summary = data?.summary;
  const groups = data?.groups ?? [];
  const rows = data?.rows ?? [];
  const legacyCount = summary?.legacy_count ?? 0;
  const pendingCount = summary?.pending_count ?? 0;

  const inputCls =
    'rounded-md border border-border bg-surface px-2.5 py-1.5 text-[13px] text-ink focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30';

  const dimLabel = useMemo(
    () => DIMENSIONS.find((d) => d.key === groupBy)?.label ?? 'Group',
    [groupBy],
  );

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Finance"
        title="Fulfillment Costing"
        description="Three-way cost comparison per Sales Order line — Order-time (①) vs DO ship-time FIFO (②) vs SI landed store-card (③), with stage-to-stage variance."
      />

      {/* ── Filters ─────────────────────────────────────────────────────── */}
      <div className="rounded-lg border border-border bg-surface p-3 shadow-stone">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-brand text-ink-muted">SO date from</span>
            <input type="date" className={inputCls} value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-brand text-ink-muted">SO date to</span>
            <input type="date" className={inputCls} value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-brand text-ink-muted">Item code</span>
            <input className={inputCls} placeholder="e.g. MAT-001" value={itemCode} onChange={(e) => setItemCode(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-brand text-ink-muted">Category</span>
            <input className={inputCls} placeholder="e.g. MATTRESS" value={category} onChange={(e) => setCategory(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-brand text-ink-muted">State</span>
            <input className={inputCls} placeholder="e.g. Selangor" value={state} onChange={(e) => setState(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-brand text-ink-muted">Variance &gt; %</span>
            <input className={`${inputCls} w-24`} type="number" placeholder="e.g. 5" value={minVar} onChange={(e) => setMinVar(e.target.value)} />
          </label>
          <label className="flex items-center gap-2 pb-1.5">
            <input type="checkbox" checked={pendingOnly} onChange={(e) => setPendingOnly(e.target.checked)} />
            <span className="text-[13px] text-ink">Pending only (no PI cost)</span>
          </label>
        </div>

        {/* Dimension tabs — By Item / Category / Menu / State */}
        <div className="mt-3 flex flex-wrap gap-1.5">
          {DIMENSIONS.map((d) => (
            <button
              key={d.key}
              type="button"
              onClick={() => setGroupBy(d.key)}
              aria-pressed={groupBy === d.key}
              className={
                'rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors ' +
                (groupBy === d.key
                  ? 'bg-primary text-white'
                  : 'border border-border bg-surface text-ink-secondary hover:border-primary/40')
              }
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── 5-tile summary strip ────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatCard label="Lines" value={summary ? summary.lines.toLocaleString('en-MY') : '—'} />
        <StatCard label="Order-time ①" value={fmtRm(summary?.order_cost_centi)} />
        <StatCard label="DO FIFO ②" value={fmtRm(summary?.do_cost_centi)} />
        <StatCard label="SI Landed ③" value={fmtRm(summary?.si_cost_centi)} />
        <StatCard
          label="Variance ③ − ①"
          value={fmtRm(summary?.variance_centi)}
          subtitle={summary ? fmtPct(summary.variance_pct) : undefined}
          tone={summary && summary.variance_centi > 0 ? 'error' : summary && summary.variance_centi < 0 ? 'success' : 'default'}
        />
      </div>

      {/* Honesty banner — legacy ② + pending ③ are real limitations, surfaced. */}
      {(legacyCount > 0 || pendingCount > 0) && (
        <div className="rounded-lg border border-warning-border bg-warning-soft px-3 py-2 text-[12px] text-warning-text">
          {legacyCount > 0 && (
            <span>
              {legacyCount} line{legacyCount === 1 ? '' : 's'} shipped before ship-time cost was captured — their DO FIFO (②)
              falls back to the landed cost and is marked <strong>Legacy</strong> (②≈③ is a data limitation, not real convergence).
            </span>
          )}
          {legacyCount > 0 && pendingCount > 0 && ' '}
          {pendingCount > 0 && (
            <span>
              {pendingCount} line{pendingCount === 1 ? '' : 's'} not yet invoiced — landed cost (③) is <strong>Pending</strong>.
            </span>
          )}
        </div>
      )}

      {q.isError && (
        <div className="rounded-lg border border-err/40 bg-err/5 px-3 py-2 text-[13px] text-err">
          Could not load the report. Please retry.
        </div>
      )}

      {/* ── Grouped summary ─────────────────────────────────────────────── */}
      <div className="overflow-hidden rounded-lg border border-border bg-surface shadow-stone">
        <div className="border-b border-border px-3 py-2 text-[13px] font-semibold text-ink">
          {dimLabel} — {q.isLoading ? 'loading…' : `${groups.length} group${groups.length === 1 ? '' : 's'}`}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead className="bg-primary-soft/30">
              <tr>
                <th className={th}>{dimLabel.replace('By ', '')}</th>
                <th className={thR}>Lines</th>
                <th className={thR}>Order ①</th>
                <th className={thR}>DO FIFO ②</th>
                <th className={thR}>SI Landed ③</th>
                <th className={thR}>Variance ③−①</th>
                <th className={thR}>%</th>
                <th className={thR}>Pending</th>
                <th className={thR}>Legacy</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => {
                const tone = varianceTone(g.variance_pct);
                return (
                  <tr key={g.key || '∅'} className="border-t border-border/60">
                    <td className={`${td} font-medium`}>{g.label}</td>
                    <td className={tdR}>{g.lines}</td>
                    <td className={tdR}>{fmtRm(g.order_cost_centi)}</td>
                    <td className={tdR}>{fmtRm(g.do_cost_centi)}</td>
                    <td className={tdR}>{fmtRm(g.si_cost_centi)}</td>
                    <td className={`${tdR} ${tone.cls}`}>{fmtRm(g.variance_centi)}</td>
                    <td className={`${tdR} ${tone.cls}`}>{fmtPct(g.variance_pct)}</td>
                    <td className={tdR}>{g.pending_count || '—'}</td>
                    <td className={tdR}>{g.legacy_count || '—'}</td>
                  </tr>
                );
              })}
              {!q.isLoading && groups.length === 0 && (
                <tr><td className={`${td} text-ink-muted`} colSpan={9}>No lines match the current filters.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Per-line three-way detail ───────────────────────────────────── */}
      <div className="overflow-hidden rounded-lg border border-border bg-surface shadow-stone">
        <div className="border-b border-border px-3 py-2 text-[13px] font-semibold text-ink">
          Line detail — {q.isLoading ? 'loading…' : `${rows.length} line${rows.length === 1 ? '' : 's'}`}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead className="bg-primary-soft/30">
              <tr>
                <th className={th}>SO No.</th>
                <th className={th}>Item</th>
                <th className={th}>Category</th>
                <th className={th}>Menu</th>
                <th className={th}>State</th>
                <th className={thR}>Qty</th>
                <th className={thR}>Order ① /u</th>
                <th className={thR}>DO FIFO ② /u</th>
                <th className={thR}>SI Landed ③ /u</th>
                <th className={thR}>② vs ①</th>
                <th className={thR}>③ vs ②</th>
                <th className={th}>Flags</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r: FulfilmentCostingRow) => {
                const t1 = varianceTone(r.var_do_order_pct);
                const t2 = varianceTone(r.var_si_do_pct);
                return (
                  <tr key={r.so_item_id} className="border-t border-border/60">
                    <td className={`${td} font-medium text-primary`}>{r.doc_no}</td>
                    <td className={td}>
                      <span className="font-medium">{r.item_code}</span>
                      {r.item_name ? <span className="text-ink-muted"> — {r.item_name}</span> : null}
                    </td>
                    <td className={td}>{r.category ?? '—'}</td>
                    <td className={td}>{r.menu ?? '—'}</td>
                    <td className={td}>{r.customer_state ?? '—'}</td>
                    <td className={tdR}>{r.qty}</td>
                    <td className={tdR}>{fmtRm(r.order_unit_centi)}</td>
                    <td className={tdR}>{fmtRm(r.do_unit_centi)}</td>
                    <td className={tdR}>{fmtRm(r.si_unit_centi)}</td>
                    <td className={`${tdR} ${t1.cls}`}>{fmtPct(r.var_do_order_pct)}</td>
                    <td className={`${tdR} ${t2.cls}`}>{fmtPct(r.var_si_do_pct)}</td>
                    <td className={td}>
                      <span className="flex flex-wrap gap-1">
                        {r.pending && (
                          <span className="rounded bg-warning-soft px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-brand text-warning-text">Pending</span>
                        )}
                        {r.do_cost_is_legacy && (
                          <span className="rounded bg-ink-muted/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">Legacy</span>
                        )}
                      </span>
                    </td>
                  </tr>
                );
              })}
              {!q.isLoading && rows.length === 0 && (
                <tr><td className={`${td} text-ink-muted`} colSpan={12}>No lines match the current filters.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-[11px] text-ink-muted">
        Menu grouping defaults to the product model (sofa lines fold onto their combo family) — pending owner confirmation of the intended definition.
      </p>
    </div>
  );
};
