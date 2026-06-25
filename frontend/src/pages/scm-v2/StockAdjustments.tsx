// ----------------------------------------------------------------------------
// StockAdjustments — list of past manual stock adjustments (write-offs,
// found stock, damage, recount fixes). Read-only ledger view at
// /inventory/adjustments. + New Adjustment button routes to /inventory/adjustments/new.
//
// Filter row: Warehouse · SKU search · Date range.
// Data source: useInventoryMovements({ docType: 'ADJUSTMENT' }).
// The API filters by source_doc_type; the adjustments POST always sets that
// to 'ADJUSTMENT' (apps/api/src/routes/inventory.ts §POST /adjustments),
// so this narrows correctly without any API changes.
//
// HOUZS VENDOR — verbatim from apps/backend/src/pages/StockAdjustments.tsx.
// Import boundary only: react-router → react-router-dom; useWarehouses ←
// vendored inventory-queries slice; movements ← vendored stock-queries;
// DataGrid ← vendored components; css colocated. Back-link → native /scm/
// inventory hub; New → the parallel /scm/stock-adjustments/new route.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Plus, Search, SlidersHorizontal } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { useWarehouses } from '../../vendor/scm/lib/inventory-queries';
import {
  useInventoryMovements,
  type InventoryMovement,
} from '../../vendor/scm/lib/stock-queries';
import { adjustmentReasonLabel } from '@2990s/shared';
import { DataGrid, type DataGridColumn } from '../../vendor/scm/components/DataGrid';
import styles from './Inventory.module.css';

const ICON    = { size: 14, strokeWidth: 1.75 } as const;
const ICON_MD = { size: 16, strokeWidth: 1.75 } as const;

const fmtDateTime = (iso: string): string => {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  const date = d.toLocaleDateString('en-GB', { year: 'numeric', month: '2-digit', day: '2-digit' });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${date} ${time}`;
};

export const StockAdjustments = () => {
  const navigate = useNavigate();
  const [warehouseId, setWarehouseId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [dateFrom, setDateFrom] = useState<string>('');
  const [dateTo, setDateTo] = useState<string>('');

  const warehouses = useWarehouses();
  // Server filters by warehouse + date; SKU search is client-side because the
  // API's productCode filter is exact-match (eq), not ilike — and commander
  // is likely to type a partial code/name.
  const { data, isLoading, error } = useInventoryMovements({
    docType: 'ADJUSTMENT',
    warehouseId: warehouseId ?? undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
  });

  const wmap = useMemo(
    () => new Map((warehouses.data ?? []).map((w) => [w.id, w])),
    [warehouses.data],
  );

  const rows: InventoryMovement[] = useMemo(() => {
    const all = data ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter((m) =>
      m.product_code.toLowerCase().includes(q) ||
      (m.product_name ?? '').toLowerCase().includes(q),
    );
  }, [data, search]);

  /* DataGrid conversion (dg-inventory rollout) — columns mirror the legacy
     <table> 1:1. Memoized on wmap so the grid's memo actually hits. */
  const columns = useMemo<DataGridColumn<InventoryMovement>[]>(() => [
    {
      key: 'date',
      label: 'Date',
      width: 130,
      accessor: (m) => <span className={styles.numCellZero}>{fmtDateTime(m.created_at)}</span>,
      searchValue: (m) => fmtDateTime(m.created_at),
      filterValue: (m) => fmtDateTime(m.created_at),
      sortFn: (a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''),
      filterType: 'date', dateValue: (m) => m.created_at,
    },
    {
      key: 'warehouse',
      label: 'Warehouse',
      width: 150,
      accessor: (m) => {
        const w = wmap.get(m.warehouse_id);
        return w ? `${w.code} · ${w.name}` : '—';
      },
    },
    {
      key: 'sku',
      label: 'SKU',
      width: 130,
      accessor: (m) => <span className={styles.codeChip}>{m.product_code}</span>,
      searchValue: (m) => m.product_code,
      filterValue: (m) => m.product_code,
      sortFn: (a, b) => (a.product_code ?? '').localeCompare(b.product_code ?? ''),
    },
    {
      key: 'name',
      label: 'Product Name',
      width: 220,
      accessor: (m) => m.product_name ?? '—',
    },
    {
      key: 'qty',
      label: 'Qty Delta',
      width: 100,
      align: 'right',
      accessor: (m) => {
        const qtyClass = m.qty > 0 ? styles.numCellPos : m.qty < 0 ? styles.numCellNeg : styles.numCellZero;
        return (
          <span className={`${styles.numCell} ${qtyClass}`}>
            {m.qty > 0 ? '+' : ''}{m.qty.toLocaleString('en-MY')}
          </span>
        );
      },
      searchValue: (m) => String(m.qty),
      filterValue: (m) => String(m.qty),
      sortFn: (a, b) => a.qty - b.qty,
    },
    {
      key: 'reason',
      label: 'Reason',
      width: 140,
      accessor: (m) => m.reason_code ? adjustmentReasonLabel(m.reason_code) : '—',
    },
    {
      key: 'notes',
      label: 'Notes',
      width: 200,
      accessor: (m) => <span className={styles.numCellZero}>{m.notes ?? '—'}</span>,
      searchValue: (m) => m.notes ?? '',
      filterValue: (m) => m.notes ?? '—',
    },
    {
      key: 'performedBy',
      label: 'Performed By',
      width: 110,
      accessor: (m) => (
        <span className={styles.numCellZero} style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-11)' }}>
          {m.performed_by ? m.performed_by.slice(0, 8) : '—'}
        </span>
      ),
      searchValue: (m) => m.performed_by ?? '',
      filterValue: (m) => m.performed_by ? m.performed_by.slice(0, 8) : '—',
    },
  ], [wmap]);

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div>
          <Link to="/scm/inventory" className={styles.chip} style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4, marginBottom: 'var(--space-2)' }}>
            <ArrowLeft {...ICON} /> <span>Inventory</span>
          </Link>
          <h1 className={styles.title}>Stock Adjustments</h1>
        </div>
        <Button variant="primary" size="md" onClick={() => navigate('/scm/stock-adjustments/new')}>
          <Plus {...ICON_MD} />
          <span>New Adjustment</span>
        </Button>
      </div>

      {/* Filter row — Warehouse chips + Search + Date range */}
      <div className={styles.filterRow}>
        <div className={styles.warehouseChips}>
          <button type="button" className={styles.chip}
            data-active={warehouseId === null} onClick={() => setWarehouseId(null)}>
            All warehouses
          </button>
          {warehouses.data?.map((w) => (
            <button key={w.id} type="button" className={styles.chip}
              data-active={warehouseId === w.id} onClick={() => setWarehouseId(w.id)}>
              {w.code} · {w.name}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.filterRow}>
        <div className={styles.searchBox}>
          <Search {...ICON} className={styles.searchIcon} />
          <input
            type="search"
            className={styles.searchInput}
            placeholder="Search SKU code / description…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
          <SlidersHorizontal size={12} strokeWidth={1.75} />
          From
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
            style={{
              fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-13)',
              background: 'var(--c-paper)', border: '1px solid var(--line)',
              borderRadius: 'var(--radius-md)', padding: '6px 8px', color: 'var(--c-ink)',
            }} />
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
          To
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
            style={{
              fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-13)',
              background: 'var(--c-paper)', border: '1px solid var(--line)',
              borderRadius: 'var(--radius-md)', padding: '6px 8px', color: 'var(--c-ink)',
            }} />
        </label>
        {(dateFrom || dateTo || search || warehouseId) && (
          <button
            type="button"
            className={styles.chip}
            onClick={() => { setDateFrom(''); setDateTo(''); setSearch(''); setWarehouseId(null); }}
          >
            Clear filters
          </button>
        )}
      </div>

      <p className={styles.eyebrow}>
        {isLoading ? 'Loading…' : `${rows.length} adjustment${rows.length === 1 ? '' : 's'} (latest first)`}
      </p>

      {error && !isLoading && (
        <div className={styles.bannerWarn}>
          <strong>Failed to load.</strong>{' '}
          {error instanceof Error ? error.message : String(error)}
        </div>
      )}

      <DataGrid<InventoryMovement>
        rows={rows}
        columns={columns}
        storageKey="dg-stock-adjustments"
        rowKey={(m) => m.id}
        searchPlaceholder="Search adjustments…"
        groupBanner={false}
        isLoading={isLoading}
        emptyMessage='No stock adjustments yet — click "+ New Adjustment" to create one.'
      />
    </div>
  );
};
