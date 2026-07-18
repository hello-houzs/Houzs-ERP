// ----------------------------------------------------------------------------
// Commission — the payroll report for a date range, grouped by showroom.
//
// Reads GET /api/scm/hr/commission. The MATH is entirely server-side
// (backend/src/scm/shared/hr-commission.ts); this page renders and exports it
// and computes nothing, so the sheet the owner approves and the figure the
// backend froze can never disagree.
//
// Page shell is Inventory's (PageHeader + space-y-4), not the vendored 2990
// card slab — owner 2026-07-18.
// ----------------------------------------------------------------------------

import { Fragment, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Download, Lock } from 'lucide-react';
import { Button } from '../../components/Button';
import { Badge } from '../../components/Badge';
import { PageHeader } from '../../components/Layout';
import { EmptyState } from '../../components/EmptyState';
import { fmtCenti } from '@2990s/shared';
import { formatDate } from '../../lib/utils';
import { useHrCommission, type HrCommissionRow } from '../../vendor/scm/lib/hr-queries';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const INPUT_CLASS =
  'rounded-md border border-border bg-surface px-3 py-2 text-[13px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20';

/** bps -> a human percent. Display only; the integer bps is never mutated. */
const fmtPct = (bps: number) => `${(bps / 100).toFixed(1)}%`;

const isoDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** First and last day of the current month — the default period. */
const monthRange = () => {
  const now = new Date();
  return {
    from: isoDay(new Date(now.getFullYear(), now.getMonth(), 1)),
    to: isoDay(new Date(now.getFullYear(), now.getMonth() + 1, 0)),
  };
};

export const HrCommission = () => {
  const initial = useMemo(monthRange, []);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [applied, setApplied] = useState(initial);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const query = useHrCommission(applied.from, applied.to);
  const data = query.data;

  const rangeValid = Boolean(from) && Boolean(to) && from <= to;

  const toggle = (staffId: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(staffId)) next.delete(staffId);
      else next.add(staffId);
      return next;
    });

  const onExport = async () => {
    if (!data) return;
    const rows: (string | number)[][] = [[
      'Showroom', 'Salesperson', 'Tier', 'Goods (RM)', 'Rate', 'Personal (RM)',
      'Override rate', 'Override (RM)', 'Item KPI (RM)', 'Total (RM)',
    ]];
    for (const s of data.showrooms) {
      for (const r of s.rows) {
        rows.push([
          s.showroomName, r.staffName, r.tier,
          r.personalGoodsCenti / 100,
          fmtPct(r.personalRateBps),
          r.personalCommissionCenti / 100,
          r.overrideRateBps === null ? 'chain' : fmtPct(r.overrideRateBps),
          r.overrideCommissionCenti / 100,
          r.itemKpiCenti / 100,
          r.totalCenti / 100,
        ]);
      }
    }
    const XLSX = await import('xlsx');
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = rows[0].map((_, i) => {
      let w = 10;
      for (const row of rows) w = Math.max(w, String(row[i] ?? '').length);
      return { wch: Math.min(40, w + 2) };
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Commission');
    XLSX.writeFile(wb, `Commission ${applied.from} to ${applied.to}.xlsx`);
  };

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="HR"
        title="Commission"
        primaryAction={
          <Button
            variant="secondary"
            icon={<Download {...ICON} />}
            onClick={onExport}
            disabled={!data || data.showrooms.length === 0}
          >
            Export Excel
          </Button>
        }
      />

      {/* The period picker is its own row, not a PageHeader action: the header
          rail centres its children, which would float these labelled fields off
          the buttons' baseline. */}
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">From</span>
          <input type="date" className={INPUT_CLASS} value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">To</span>
          <input type="date" className={INPUT_CLASS} value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <Button
          variant="primary"
          disabled={!rangeValid}
          onClick={() => rangeValid && setApplied({ from, to })}
        >
          Calculate
        </Button>
      </div>

      {!rangeValid && (
        <div className="rounded-md border border-border bg-surface px-3 py-2 text-[12px] text-ink-secondary">
          The From date must not be after the To date.
        </div>
      )}

      {query.isLoading && (
        <div className="rounded-md border border-border bg-surface px-3 py-6 text-center text-[13px] text-ink-secondary">
          Calculating…
        </div>
      )}

      {query.isError && (
        <div className="rounded-md border border-err/40 bg-err/5 px-3 py-3 text-[13px] text-ink">
          {(query.error as Error)?.message || 'The commission report could not be loaded.'}
        </div>
      )}

      {data && (
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-secondary">
          <span>
            {formatDate(data.from)} to {formatDate(data.to)}
          </span>
          {data.closed ? (
            /* A closed period is served from frozen rows, so these figures are
               the ones that were approved — not a fresh recompute against
               today's rates. Saying so is the whole point of freezing them. */
            <Badge tone="success" variant="soft" caseless>
              <span className="inline-flex items-center gap-1">
                <Lock size={11} strokeWidth={2} />
                Closed rev {data.closed.revision}
                {data.closed.closedByName ? ` by ${data.closed.closedByName}` : ''}
                {data.closed.closedAt ? ` on ${formatDate(data.closed.closedAt)}` : ''}
              </span>
            </Badge>
          ) : (
            <Badge tone="neutral" variant="soft" caseless>
              Open period — recalculated live
            </Badge>
          )}
          {data.overrideMode === 'chain' && (
            <Badge tone="accent" variant="soft" caseless>
              Chain override
            </Badge>
          )}
        </div>
      )}

      {data && data.showrooms.length === 0 && (
        <EmptyState
          message="No salespeople configured"
          description="Nobody has a commission profile in this company yet. Add them in HR Settings."
        />
      )}

      {data && data.showrooms.map((s) => (
        <section key={s.showroomId} className="space-y-2">
          <header className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-[14px] font-semibold text-ink">{s.showroomName}</h2>
            <Badge tone={s.showroomKpiHit ? 'success' : 'warning'} variant="soft" caseless>
              Showroom goods {fmtCenti(s.showroomGoodsCenti)} ·{' '}
              {fmtCenti(data.config.showroomKpiThresholdCenti)} target{' '}
              {s.showroomKpiHit ? 'hit' : 'not hit'}
            </Badge>
          </header>

          <div className="overflow-x-auto rounded-md border border-border bg-surface">
            <table className="w-full text-[12px]">
              <thead className="bg-bg/40 text-[9px] font-semibold uppercase tracking-wider text-ink-muted">
                <tr>
                  <th className="px-3 py-2 text-left">Salesperson</th>
                  <th className="px-2 py-2 text-left">Tier</th>
                  <th className="px-2 py-2 text-right">Goods</th>
                  <th className="px-2 py-2 text-right">Rate</th>
                  <th className="px-2 py-2 text-right">Personal</th>
                  <th className="px-2 py-2 text-right">Override</th>
                  <th className="px-2 py-2 text-right">Item KPI</th>
                  <th className="px-3 py-2 text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {s.rows.map((r) => (
                  <CommissionRow
                    key={r.staffId}
                    row={r}
                    open={expanded.has(r.staffId)}
                    onToggle={() => toggle(r.staffId)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
};

const CommissionRow = ({
  row,
  open,
  onToggle,
}: {
  row: HrCommissionRow;
  open: boolean;
  onToggle: () => void;
}) => {
  const overrideLevels = row.overrideDetail ?? [];
  const expandable = row.kpiDetail.length > 0 || overrideLevels.length > 0;

  return (
    <Fragment>
      <tr className="border-t border-border-subtle">
        <td className="px-3 py-2">
          <span className="inline-flex items-center gap-1">
            {expandable && (
              <button
                type="button"
                onClick={onToggle}
                aria-label={open ? 'Hide breakdown' : 'Show breakdown'}
                className="rounded p-0.5 text-ink-muted hover:bg-primary-soft hover:text-primary"
              >
                {open ? <ChevronDown size={14} strokeWidth={2} /> : <ChevronRight size={14} strokeWidth={2} />}
              </button>
            )}
            <span className="font-semibold text-ink">{row.staffName}</span>
          </span>
        </td>
        <td className="px-2 py-2 text-ink-secondary">{row.tier}</td>
        <td className="px-2 py-2 text-right font-mono">{fmtCenti(row.personalGoodsCenti)}</td>
        <td className="px-2 py-2 text-right font-mono">{fmtPct(row.personalRateBps)}</td>
        <td className="px-2 py-2 text-right font-mono">{fmtCenti(row.personalCommissionCenti)}</td>
        <td className="px-2 py-2 text-right font-mono">
          {/* null rate = chain mode, where the override is a sum over levels of
              different rates on different bases. Printing a blended rate would
              be a figure nobody can reconcile against a payslip, so the amount
              stands alone and the per-level split lives in the expansion. */}
          {row.overrideRateBps === null
            ? overrideLevels.length === 0 && row.overrideCommissionCenti === 0
              ? '—'
              : fmtCenti(row.overrideCommissionCenti)
            : row.overrideRateBps === 0
              ? '—'
              : `${fmtPct(row.overrideRateBps)} · ${fmtCenti(row.overrideCommissionCenti)}`}
        </td>
        <td className="px-2 py-2 text-right font-mono">{fmtCenti(row.itemKpiCenti)}</td>
        <td className="px-3 py-2 text-right font-mono font-semibold text-ink">{fmtCenti(row.totalCenti)}</td>
      </tr>

      {open &&
        overrideLevels.map((d) => (
          <tr key={`${row.staffId}-lvl${d.level}`} className="border-t border-border-subtle bg-bg/30 text-[11px]">
            <td className="px-3 py-1.5 pl-9 text-ink-secondary" colSpan={5}>
              Level {d.level} downline goods {fmtCenti(d.goodsCenti)} @ {fmtPct(d.rateBps)}
            </td>
            <td className="px-2 py-1.5 text-right font-mono text-ink-secondary" colSpan={3}>
              {fmtCenti(d.commissionCenti)}
            </td>
          </tr>
        ))}

      {open &&
        row.kpiDetail.map((d, i) => (
          <tr key={`${row.staffId}-kpi${i}`} className="border-t border-border-subtle bg-bg/30 text-[11px]">
            <td className="px-3 py-1.5 pl-9 text-ink-secondary" colSpan={5}>
              {d.label} × {d.qty} @ {fmtCenti(d.bonusCenti)}
            </td>
            <td className="px-2 py-1.5 text-right font-mono text-ink-secondary" colSpan={3}>
              {fmtCenti(d.lineCenti)}
            </td>
          </tr>
        ))}
    </Fragment>
  );
};
