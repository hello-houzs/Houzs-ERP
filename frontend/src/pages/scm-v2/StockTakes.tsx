// ----------------------------------------------------------------------------
// StockTakes — list at /inventory/stock-takes (PR — Inv PR5).
//
// AutoCount-style cycle count list. Pick warehouse + scope, snapshot system_qty,
// type counted_qty per line, Post → ADJUSTMENT movements.
//
// HOUZS VENDOR — verbatim from apps/backend/src/pages/StockTakes.tsx.
// Import boundary only: react-router → react-router-dom; useWarehouses ←
// vendored inventory-queries slice; take hooks ← vendored stock-queries;
// DataGrid ← vendored components; css colocated. Back-link → native /scm/
// inventory hub; New/row-click → the parallel /scm/stock-takes routes.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Plus, SlidersHorizontal } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { useWarehouses } from '../../vendor/scm/lib/inventory-queries';
import { sortByText } from '../../vendor/scm/lib/sort-options';
import {
  useStockTakes,
  type StockTakeRow,
  type StockTakeStatus,
} from '../../vendor/scm/lib/stock-queries';
import { DataGrid, type DataGridColumn } from '../../vendor/scm/components/DataGrid';
import styles from './Inventory.module.css';

const ICON    = { size: 14, strokeWidth: 1.75 } as const;
const ICON_MD = { size: 16, strokeWidth: 1.75 } as const;

// PR-DRAFT-removal — DRAFT renamed to OPEN (migration 0078). Stock takes
// keep an editable working state (commander enters counted_qty per line).
const STATUS_OPTIONS: Array<StockTakeStatus | 'ALL'> = ['ALL', 'OPEN', 'POSTED', 'CANCELLED'];

const STATUS_TONE: Record<StockTakeStatus, { bg: string; fg: string; label: string }> = {
  OPEN:      { bg: 'rgba(34, 31, 32, 0.08)',  fg: 'var(--fg-muted)',                label: 'Open' },
  POSTED:    { bg: 'rgba(47, 93, 79, 0.16)',  fg: 'var(--c-secondary-a, #2F5D4F)',  label: 'Posted' },
  CANCELLED: { bg: 'rgba(184, 51, 31, 0.10)', fg: 'var(--c-festive-b, #B8331F)',    label: 'Cancelled' },
};

const fmtDate = (iso: string): string => {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { year: 'numeric', month: '2-digit', day: '2-digit' });
};

const scopeLabel = (scopeType: string, scopeValue: string | null): string => {
  if (scopeType === 'ALL') return 'All SKUs';
  if (scopeType === 'CATEGORY') return `Category · ${scopeValue ?? '—'}`;
  if (scopeType === 'CODE_PREFIX') return `Prefix · ${scopeValue ?? '—'}`;
  return scopeType;
};

export const StockTakes = () => {
  const navigate = useNavigate();
  const [status, setStatus]           = useState<StockTakeStatus | 'ALL'>('ALL');
  const [warehouseId, setWarehouseId] = useState<string>('');
  const [dateFrom, setDateFrom]       = useState<string>('');
  const [dateTo, setDateTo]           = useState<string>('');

  const warehouses = useWarehouses();
  const wmap = useMemo(
    () => new Map((warehouses.data ?? []).map((w) => [w.id, w])),
    [warehouses.data],
  );

  const { data: takes, isLoading, error } = useStockTakes({
    status:      status === 'ALL' ? undefined : status,
    warehouseId: warehouseId || undefined,
    dateFrom:    dateFrom || undefined,
    dateTo:      dateTo   || undefined,
  });

  const rows = useMemo<StockTakeRow[]>(() => takes ?? [], [takes]);

  /* DataGrid conversion (dg-inventory rollout) — columns mirror the legacy
     <table> 1:1. Single click still opens the detail page (onRowClick). */
  const columns = useMemo<DataGridColumn<StockTakeRow>[]>(() => [
    {
      key: 'takeNo',
      label: 'STK #',
      width: 130,
      accessor: (t) => (
        <span style={{ fontWeight: 700, color: 'var(--c-burnt)', fontVariantNumeric: 'tabular-nums' }}>{t.take_no}</span>
      ),
      searchValue: (t) => t.take_no,
      filterValue: (t) => t.take_no,
      sortFn: (a, b) => (a.take_no ?? '').localeCompare(b.take_no ?? ''),
    },
    {
      key: 'date',
      label: 'Date',
      width: 110,
      accessor: (t) => <span className={styles.numCellZero}>{fmtDate(t.take_date)}</span>,
      searchValue: (t) => fmtDate(t.take_date),
      filterValue: (t) => fmtDate(t.take_date),
      sortFn: (a, b) => (a.take_date ?? '').localeCompare(b.take_date ?? ''),
      filterType: 'date', dateValue: (t) => t.take_date,
    },
    {
      key: 'warehouse',
      label: 'Warehouse',
      width: 170,
      accessor: (t) => {
        const wh = t.warehouse ?? wmap.get(t.warehouse_id);
        return (
          <>
            <strong>{wh ? wh.code : '—'}</strong>
            {wh && (
              <span style={{ color: 'var(--fg-muted)', marginLeft: 6, fontSize: 'var(--fs-12)' }}>
                {wh.name}
              </span>
            )}
          </>
        );
      },
      searchValue: (t) => {
        const wh = t.warehouse ?? wmap.get(t.warehouse_id);
        return wh ? `${wh.code} ${wh.name}` : '';
      },
      filterValue: (t) => {
        const wh = t.warehouse ?? wmap.get(t.warehouse_id);
        return wh ? `${wh.code} · ${wh.name}` : '—';
      },
    },
    {
      key: 'scope',
      label: 'Scope',
      width: 160,
      accessor: (t) => <span style={{ fontSize: 'var(--fs-13)' }}>{scopeLabel(t.scope_type, t.scope_value)}</span>,
      searchValue: (t) => scopeLabel(t.scope_type, t.scope_value),
      filterValue: (t) => scopeLabel(t.scope_type, t.scope_value),
    },
    {
      key: 'status',
      label: 'Status',
      width: 100,
      accessor: (t) => {
        const tone = STATUS_TONE[t.status];
        return (
          <span style={{
            display: 'inline-flex', alignItems: 'center',
            padding: '2px 8px', borderRadius: 'var(--radius-pill)',
            fontFamily: 'var(--font-button)', fontSize: 'var(--fs-11)', fontWeight: 600,
            background: tone.bg, color: tone.fg, letterSpacing: '0.02em',
          }}>
            {tone.label}
          </span>
        );
      },
      searchValue: (t) => STATUS_TONE[t.status].label,
      filterValue: (t) => STATUS_TONE[t.status].label,
      sortFn: (a, b) => (a.status ?? '').localeCompare(b.status ?? ''),
    },
    {
      key: 'lines',
      label: 'Lines',
      width: 80,
      align: 'right',
      accessor: (t) => (
        <span className={`${styles.numCell} ${styles.numCellZero}`}>
          {(t.line_count ?? 0).toLocaleString('en-MY')}
        </span>
      ),
      searchValue: (t) => String(t.line_count ?? 0),
      filterValue: (t) => String(t.line_count ?? 0),
      sortFn: (a, b) => (a.line_count ?? 0) - (b.line_count ?? 0),
    },
    {
      key: 'variance',
      label: 'Variance Total',
      width: 120,
      align: 'right',
      accessor: (t) => {
        const variance = t.variance_total ?? 0;
        const varianceColor = variance > 0
          ? 'var(--c-secondary-a, #2F5D4F)'
          : variance < 0
            ? 'var(--c-festive-b, #B8331F)'
            : 'var(--fg-muted)';
        return (
          <span className={`${styles.numCell} ${styles.numCellZero}`}
                style={{ color: varianceColor, fontFamily: 'var(--font-mono)' }}>
            {variance > 0 ? '+' : ''}{variance.toLocaleString('en-MY')}
          </span>
        );
      },
      searchValue: (t) => String(t.variance_total ?? 0),
      filterValue: (t) => String(t.variance_total ?? 0),
      sortFn: (a, b) => (a.variance_total ?? 0) - (b.variance_total ?? 0),
    },
  ], [wmap]);

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div>
          <Link to="/scm/inventory" className={styles.chip} style={{
            textDecoration: 'none', display: 'inline-flex', alignItems: 'center',
            gap: 4, marginBottom: 'var(--space-2)',
          }}>
            <ArrowLeft {...ICON} /> <span>Inventory</span>
          </Link>
          <h1 className={styles.title}>Stock Takes</h1>
        </div>
        <Button variant="primary" size="md" onClick={() => navigate('/scm/stock-takes/new')}>
          <Plus {...ICON_MD} />
          <span>New Stock Take</span>
        </Button>
      </div>

      {/* Status pills */}
      <div className={styles.filterRow}>
        <div className={styles.warehouseChips}>
          {STATUS_OPTIONS.map((s) => (
            <button
              key={s}
              type="button"
              className={styles.chip}
              data-active={status === s}
              onClick={() => setStatus(s)}
            >
              {s === 'ALL' ? 'All status' : STATUS_TONE[s].label}
            </button>
          ))}
        </div>
      </div>

      {/* Warehouse + date range filters */}
      <div className={styles.filterRow}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
          <SlidersHorizontal size={12} strokeWidth={1.75} />
          Warehouse
          <select
            value={warehouseId}
            onChange={(e) => setWarehouseId(e.target.value)}
            style={{
              fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-13)',
              background: 'var(--c-paper)', border: '1px solid var(--line)',
              borderRadius: 'var(--radius-md)', padding: '6px 8px', color: 'var(--c-ink)',
            }}
          >
            <option value="">Any warehouse</option>
            {sortByText(warehouses.data ?? []).map((w) => (
              <option key={w.id} value={w.id}>{w.code} · {w.name}</option>
            ))}
          </select>
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
          Date from
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
            style={{
              fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-13)',
              background: 'var(--c-paper)', border: '1px solid var(--line)',
              borderRadius: 'var(--radius-md)', padding: '6px 8px', color: 'var(--c-ink)',
            }} />
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
          to
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
            style={{
              fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-13)',
              background: 'var(--c-paper)', border: '1px solid var(--line)',
              borderRadius: 'var(--radius-md)', padding: '6px 8px', color: 'var(--c-ink)',
            }} />
        </label>
        {(warehouseId || dateFrom || dateTo || status !== 'ALL') && (
          <button
            type="button"
            className={styles.chip}
            onClick={() => {
              setStatus('ALL'); setWarehouseId('');
              setDateFrom(''); setDateTo('');
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      <p className={styles.eyebrow}>
        {isLoading ? 'Loading…' : `${rows.length} stock take${rows.length === 1 ? '' : 's'} (latest first)`}
      </p>

      {error && !isLoading && (
        <div className={styles.bannerWarn}>
          <strong>Failed to load.</strong>{' '}
          {error instanceof Error ? error.message : String(error)}
        </div>
      )}

      <DataGrid<StockTakeRow>
        rows={rows}
        columns={columns}
        storageKey="dg-stock-takes"
        rowKey={(t) => t.id}
        searchPlaceholder="Search stock takes…"
        groupBanner={false}
        isLoading={isLoading}
        emptyMessage='No stock takes yet — click "+ New Stock Take" to start a cycle count.'
        rowStyle={() => ({ cursor: 'pointer' })}
        onRowClick={(t) => navigate(`/scm/stock-takes/${t.id}`)}
      />
    </div>
  );
};
