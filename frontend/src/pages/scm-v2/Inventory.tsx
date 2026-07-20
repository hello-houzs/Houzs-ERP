// ----------------------------------------------------------------------------
// Inventory — AutoCount-style stock view (PR #38).
//
// 4 tabs:
//   1. Balances     — one row per SKU, Total Bal Qty + Main Supplier.
//                      Double-click row → per-warehouse breakdown drawer
//                      (Location | Qty | Unit Cost), like AutoCount's
//                      "Up To Date Cost" panel.
//   2. Movements    — append-only ledger (every GRN/DO/PR post)
//   3. COGS (FIFO)  — FIFO consumption stream
//   4. Warehouses   — CRUD for stock locations (merged from old /warehouses page)
//
// IN  events: GRN posted
// OUT events: DO dispatched, Purchase Return posted
// COGS auto-posted via DB trigger trg_inventory_movement_fifo (migration 0053).
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Search, ArrowUpRight, ArrowDownLeft, DollarSign, Star, X, Plus,
  Warehouse as WarehouseIcon, ChevronRight, ChevronDown,
} from 'lucide-react';
import { Button } from '../../components/Button';
import { PageHeader } from '../../components/Layout';
import { StatCard } from '../../components/StatCard';
import { formatVariantKey, fmtCenti, fmtDate, fmtQty } from '@2990s/shared';
import { DataGrid, type DataGridColumn } from '../../vendor/scm/components/DataGrid';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import {
  useWarehouses,
  useInventoryProductTotals,
  useInventoryProductBreakdown,
  useInventoryMovements,
  useInventoryLots,
  useInventoryBatches,
  useCogsEntries,
  useInventoryAnalytics,
  useCreateWarehouse,
  useUpdateWarehouse,
  type CogsEntry,
  type InventoryBatch,
  type InventoryMovement,
  type InventoryProductTotal,
  type Warehouse,
} from '../../vendor/scm/lib/inventory-queries';

/** Best-effort route for a movement's source doc. Mirrors StockCard's
 *  docHrefFor so every IN/OUT/ADJUSTMENT row on the Movements ledger can be
 *  clicked through to the document that drove it. ADJUSTMENT has no per-doc
 *  detail page — link to the list. */
const docHrefFor = (m: InventoryMovement): string | null => {
  switch (m.source_doc_type) {
    case 'GRN':              return m.source_doc_id ? `/scm/grns/${m.source_doc_id}` : null;
    case 'DO':               return m.source_doc_id ? `/mfg-delivery-orders/${m.source_doc_id}` : null;
    case 'DR':               return m.source_doc_id ? `/delivery-returns/${m.source_doc_id}` : null;
    case 'PURCHASE_RETURN':  return m.source_doc_id ? `/scm/purchase-returns/${m.source_doc_id}` : null;
    case 'STOCK_TRANSFER':   return m.source_doc_id ? `/scm/stock-transfers/${m.source_doc_id}` : null;
    case 'STOCK_TAKE':       return m.source_doc_id ? `/scm/stock-takes/${m.source_doc_id}` : null;
    case 'ADJUSTMENT':       return '/scm/stock-adjustments';
    default:                 return null;
  }
};
import styles from './Inventory.module.css';

const ICON = { size: 14, strokeWidth: 1.75 } as const;
const ICON_MD = { size: 16, strokeWidth: 1.75 } as const;

/* KPI tile grid — replaces the bespoke .statGrid (auto-fit minmax(220px)).
   Mirrors the SalesOrderDetailListing reskin: a plain Tailwind grid that
   holds the shared <StatCard>s, 2-up on a phone (the old 600px media rule). */
const STAT_GRID = 'grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4';

/* Same grid, capped at 3 columns for the 3-tile clusters. */
const STAT_GRID_3 = 'grid grid-cols-2 gap-3 md:grid-cols-3';

/* "Failed to load" banner — err tokens (was the bespoke .bannerWarn, whose
   colours only resolved via the removed .page cascade). */
const BANNER_ERR =
  'rounded-lg border border-err/40 bg-err/10 px-4 py-3 text-[13px] text-err';

type Tab = 'balances' | 'batches' | 'warehouses' | 'analytics';
type Category = 'all' | 'ACCESSORY' | 'BEDFRAME' | 'SOFA' | 'MATTRESS' | 'SERVICE';

const CATEGORIES: { value: Category; label: string }[] = [
  { value: 'all',       label: 'All' },
  { value: 'ACCESSORY', label: 'Accessory' },
  { value: 'BEDFRAME',  label: 'Bedframe' },
  { value: 'SOFA',      label: 'Sofa' },
  { value: 'MATTRESS',  label: 'Mattress' },
  { value: 'SERVICE',   label: 'Service' },
];

const fmtRm = (sen: number | null | undefined): string => fmtCenti(sen);

/* Age of the stock — days since the oldest open FIFO lot was received
   (Commander 2026-05-29: "寿命" replaces Last Movement). */
const fmtAgeDays = (iso: string | null): string => {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const d = Math.floor(ms / 86_400_000);
  return d === 0 ? 'today' : `${d}d`;
};

export const Inventory = () => {
  const [tab, setTab] = useState<Tab>('balances');
  const [warehouseId, setWarehouseId] = useState<string | null>(null);
  const [category, setCategory] = useState<Category>('all');
  const [search, setSearch] = useState('');

  const warehouses = useWarehouses();
  const [breakdownFor, setBreakdownFor] = useState<{ code: string; name: string } | null>(null);

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Stock"
        title="Inventory"
        actions={
          /* Tab rail — reskinned to the reference FilterPills slab. Rides in
             the header's actions slot, the same seat the bespoke .tabRow had
             inside the old sticky .headerRow (PageHeader is sticky too). */
          <div className="inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-md border border-border bg-surface p-1 shadow-stone [&>*]:shrink-0">
            {([
              { value: 'balances' as const, label: 'Balances' },
              { value: 'batches' as const, label: 'Batches' },
              { value: 'warehouses' as const, label: 'Warehouses' },
              { value: 'analytics' as const, label: 'Analytics' },
            ]).map((t) => (
              <button
                key={t.value}
                type="button"
                data-active={tab === t.value}
                onClick={() => setTab(t.value)}
                className={
                  tab === t.value
                    ? 'whitespace-nowrap rounded bg-primary px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-white shadow-sm transition-all duration-150'
                    : 'whitespace-nowrap rounded px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-secondary transition-all duration-150 hover:bg-primary-soft hover:text-primary'
                }
              >
                {t.label}
              </button>
            ))}
          </div>
        }
      />

      {/* Category chips — only for Balances tab */}
      {tab === 'balances' && (
        <div className={styles.warehouseChips}>
          {CATEGORIES.map((cat) => (
            <button key={cat.value} type="button" className={styles.chip}
              data-active={category === cat.value} onClick={() => setCategory(cat.value)}>
              {cat.label}
            </button>
          ))}
        </div>
      )}

      {tab === 'balances' && (
        <>
          <div className={styles.filterRow}>
            <div className={styles.searchBox} style={{ width: '100%' }}>
              <Search {...ICON} className={styles.searchIcon} />
              <input
                type="search"
                className={styles.searchInput}
                placeholder="Search code / description…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>
          <BalancesTab category={category} search={search}
            onDrilldown={(code, name) => setBreakdownFor({ code, name })} />
        </>
      )}
      {tab === 'batches' && (
        <BatchesTab
          warehouseId={warehouseId}
          setWarehouseId={setWarehouseId}
          warehouses={warehouses.data ?? []}
          search={search}
          setSearch={setSearch}
        />
      )}
      {tab === 'warehouses' && (
        <WarehousesTab />
      )}
      {tab === 'analytics' && (
        <AnalyticsTab warehouseId={warehouseId} />
      )}

      {breakdownFor && (
        <ProductBreakdownDrawer
          code={breakdownFor.code}
          name={breakdownFor.name}
          onClose={() => setBreakdownFor(null)}
        />
      )}
    </div>
  );
};

/* ════════════════════════════════════════════════════════════════════════
   Analytics tab — read-only inventory KPI board: aging, turnover, dead stock,
   ABC. Computed server-side from open lots + COGS stream (GET /inventory/
   analytics). Wei Siang 2026-06-04.
   ════════════════════════════════════════════════════════════════════════ */
const WINDOWS = [30, 90, 180, 365];
const fmtDay = (iso: string | null): string => {
  if (!iso) return 'never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
};

const AnalyticsTab = ({ warehouseId }: { warehouseId: string | null }) => {
  const [days, setDays] = useState(90);
  const { data, isLoading, error } = useInventoryAnalytics({ days, warehouseId });

  if (isLoading) return <div className={styles.emptyRow} style={{ padding: 'var(--space-6)' }}>Loading analytics…</div>;
  if (error || !data) return <div className={styles.emptyRow} style={{ padding: 'var(--space-6)' }}>Couldn't load analytics.</div>;

  const agingMax = Math.max(1, ...data.aging.map((b) => b.valueSen));
  const turns = data.turnover.annualizedTurns;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      {/* Window selector */}
      <div className={styles.warehouseChips}>
        {WINDOWS.map((w) => (
          <button key={w} type="button" className={styles.chip}
            data-active={days === w} onClick={() => setDays(w)}>
            Last {w} days
          </button>
        ))}
      </div>

      {/* KPI cards — shared <StatCard> */}
      <div className={STAT_GRID}>
        <StatCard label="Inventory Value" value={fmtRm(data.totalValueSen)} />
        <StatCard label="Distinct SKUs in stock" value={fmtQty(data.distinctSkus)} />
        <StatCard label="Stock Turn (annualised)" value={turns > 0 ? `${turns.toFixed(1)}×` : '—'} />
        <StatCard
          label="Days of Stock on Hand"
          value={data.turnover.daysOnHand != null ? `${Math.round(data.turnover.daysOnHand)}d` : '—'}
        />
      </div>

      {/* Stock aging */}
      <p className={styles.eyebrow}>Stock Aging — by date received</p>
      <div className={styles.tableCard}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Age Bucket</th>
              <th style={{ textAlign: 'right' }}>Qty</th>
              <th style={{ textAlign: 'right' }}>Value</th>
              <th style={{ width: '34%' }}>Share of value</th>
            </tr>
          </thead>
          <tbody>
            {data.aging.map((b) => (
              <tr key={b.key}>
                <td>{b.label}</td>
                <td className={`${styles.numCell} ${b.qty > 0 ? styles.numCellPos : styles.numCellZero}`}>{fmtQty(b.qty)}</td>
                <td className={styles.numCell} style={{ fontWeight: 700 }}>{b.valueSen > 0 ? fmtRm(b.valueSen) : '—'}</td>
                <td>
                  <div className="h-2.5 overflow-hidden rounded-full bg-surface-2">
                    <div className="h-full bg-primary" style={{ width: `${(b.valueSen / agingMax) * 100}%` }} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ABC classification */}
      <p className={styles.eyebrow}>ABC Classification — by sales value over the window</p>
      <div className={STAT_GRID}>
        {(['A', 'B', 'C'] as const).map((cls) => (
          <StatCard
            key={cls}
            label={`Class ${cls} ${cls === 'A' ? '· top sellers' : cls === 'B' ? '· steady' : '· slow / idle'}`}
            value={data.abc.summary[cls].count}
            subtitle={`${fmtRm(data.abc.summary[cls].valueSen)} on hand`}
          />
        ))}
      </div>

      {/* Dead stock */}
      <p className={styles.eyebrow}>Dead Stock — has stock, no sale in {days} days</p>
      <div className={styles.tableCard}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Product</th>
              <th style={{ textAlign: 'right' }}>Qty</th>
              <th style={{ textAlign: 'right' }}>Value</th>
              <th>Last Sold</th>
            </tr>
          </thead>
          <tbody>
            {data.deadStock.length === 0 && (
              <tr><td colSpan={4} className={styles.emptyRow}>No dead stock — every SKU in stock sold within {days} days.</td></tr>
            )}
            {data.deadStock.map((d) => (
              <tr key={d.product_code}>
                <td><span className={styles.codeChip}>{d.product_code}</span> {d.product_name}</td>
                <td className={`${styles.numCell} ${styles.numCellPos}`}>{fmtQty(d.qty)}</td>
                <td className={styles.numCell} style={{ fontWeight: 700 }}>{fmtRm(d.valueSen)}</td>
                <td className={styles.numCellZero}>{fmtDay(d.lastSoldAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

/* ════════════════════════════════════════════════════════════════════════
   Balances tab — AutoCount-style: one row per SKU + Total Qty + Main Supplier
   Double-click row → per-warehouse breakdown drawer
   ════════════════════════════════════════════════════════════════════════ */
const BalancesTab = ({
  category, search, onDrilldown,
}: {
  category: Category;
  search: string;
  onDrilldown: (code: string, name: string) => void;
}) => {
  const { data, isLoading, error } = useInventoryProductTotals({
    search: search.trim() || undefined,
    category: category === 'all' ? undefined : category,
  });
  const rows: InventoryProductTotal[] = useMemo(() => data ?? [], [data]);

  const stats = useMemo(() => ({
    totalQty: rows.reduce((s, r) => s + (r.total_qty ?? 0), 0),
    distinctSku: rows.length,
    totalValue: rows.reduce((s, r) => s + (r.total_value_sen ?? 0), 0),
  }), [rows]);

  return (
    <>
      <div className={STAT_GRID_3}>
        <StatCard label="Total Qty" value={fmtQty(stats.totalQty)} />
        <StatCard label="Distinct SKUs" value={stats.distinctSku} />
        <StatCard label="Inventory Value" value={fmtRm(stats.totalValue)} />
      </div>

      <p className={styles.eyebrow}>
        {isLoading ? 'Loading…' : `${rows.length} SKU rows · double-click a row to see per-warehouse breakdown`}
      </p>

      {error && !isLoading && (
        <div className={BANNER_ERR}>
          <strong className="font-semibold">Failed to load.</strong>{' '}
          {error instanceof Error ? error.message : 'Something went wrong.'}
        </div>
      )}

      <DataGrid<InventoryProductTotal>
        rows={rows}
        columns={BALANCE_COLUMNS}
        storageKey="dg-inventory-balances"
        exportName="Inventory Balances"
        rowKey={(r) => r.product_code}
        searchPlaceholder="Search SKUs…"
        hideSearch
        groupBanner={false}
        isLoading={isLoading}
        emptyMessage="No SKUs match the filters."
        onRowDoubleClick={(r) => onDrilldown(r.product_code, r.product_name)}
        rowStyle={() => ({ cursor: 'pointer' })}
        /* Variant drill (Commander 2026-05-29, ported to DataGrid.expandable):
           click a row / its chevron to expand the SKU into its attribute-
           composition buckets. Lazy: only fetches when expanded. Double-click
           still opens the per-warehouse breakdown drawer. */
        expandable={{
          renderExpansion: (r) => <SkuVariantPanel code={r.product_code} />,
          rowExpansionKey: (r) => r.product_code,
        }}
      />
    </>
  );
};

/* DataGrid columns for the Balances tab — module scope so the grid's memo
   gets a stable reference. Mirrors the legacy <table> 1:1; the chevron the
   old markup hand-rolled is now DataGrid's synthetic expand column. */
const BALANCE_COLUMNS: DataGridColumn<InventoryProductTotal>[] = [
  {
    key: 'code',
    label: 'Product Code',
    width: 160,
    accessor: (r) => (
      <Link
        to={`/scm/inventory/stock-card/${encodeURIComponent(r.product_code)}`}
        className={styles.codeChip}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        title="Open Stock Card"
        style={{ textDecoration: 'none' }}
      >
        {r.product_code}
      </Link>
    ),
    searchValue: (r) => r.product_code,
    filterValue: (r) => r.product_code,
    sortFn: (a, b) => (a.product_code ?? '').localeCompare(b.product_code ?? ''),
  },
  {
    key: 'desc',
    label: 'Description',
    width: 240,
    accessor: (r) => (
      <>
        {r.product_name}
        {r.branding && <span className={styles.numCellZero}> · {r.branding}</span>}
      </>
    ),
    searchValue: (r) => `${r.product_name} ${r.branding ?? ''}`,
    filterValue: (r) => r.product_name,
    sortFn: (a, b) => (a.product_name ?? '').localeCompare(b.product_name ?? ''),
  },
  {
    key: 'category',
    label: 'Category',
    width: 100,
    accessor: (r) => <span className={styles.numCellZero}>{r.category}</span>,
    searchValue: (r) => r.category,
    filterValue: (r) => r.category,
  },
  {
    key: 'stock',
    label: 'Stock',
    width: 80,
    align: 'right',
    accessor: (r) => {
      const qtyClass = r.total_qty > 0 ? styles.numCellPos
        : r.total_qty < 0 ? styles.numCellNeg
        : styles.numCellZero;
      return <span className={`${styles.numCell} ${qtyClass}`}>{fmtQty(r.total_qty)}</span>;
    },
    searchValue: (r) => String(r.total_qty),
    filterValue: (r) => String(r.total_qty),
    sortFn: (a, b) => a.total_qty - b.total_qty,
  },
  {
    key: 'incoming',
    label: 'Incoming',
    width: 90,
    align: 'right',
    accessor: (r) => (
      <span className={`${styles.numCell} ${r.incoming_qty > 0 ? styles.numCellPos : styles.numCellZero}`}>
        {r.incoming_qty > 0 ? `+${fmtQty(r.incoming_qty)}` : '—'}
      </span>
    ),
    searchValue: () => '',
    filterValue: (r) => String(r.incoming_qty),
    sortFn: (a, b) => a.incoming_qty - b.incoming_qty,
  },
  {
    key: 'reserve7',
    label: 'Reserve 7d',
    width: 90,
    align: 'right',
    accessor: (r) => (
      <span className={`${styles.numCell} ${r.reserve_7d > 0 ? '' : styles.numCellZero}`}>
        {r.reserve_7d > 0 ? fmtQty(r.reserve_7d) : '—'}
      </span>
    ),
    searchValue: () => '',
    filterValue: (r) => String(r.reserve_7d),
    sortFn: (a, b) => a.reserve_7d - b.reserve_7d,
  },
  {
    key: 'reserve14',
    label: 'Reserve 14d',
    width: 90,
    align: 'right',
    accessor: (r) => (
      <span className={`${styles.numCell} ${r.reserve_14d > 0 ? '' : styles.numCellZero}`}>
        {r.reserve_14d > 0 ? fmtQty(r.reserve_14d) : '—'}
      </span>
    ),
    searchValue: () => '',
    filterValue: (r) => String(r.reserve_14d),
    sortFn: (a, b) => a.reserve_14d - b.reserve_14d,
  },
  {
    key: 'available',
    label: 'Available',
    width: 90,
    align: 'right',
    accessor: (r) => (
      <span
        className={`${styles.numCell} ${r.available_qty < 0 ? styles.numCellNeg : r.available_qty > 0 ? styles.numCellPos : styles.numCellZero}`}
        title="Stock − reserved (open SO demand)"
      >
        {fmtQty(r.available_qty)}
      </span>
    ),
    searchValue: () => '',
    filterValue: (r) => String(r.available_qty),
    sortFn: (a, b) => a.available_qty - b.available_qty,
  },
  {
    key: 'value',
    label: 'Value',
    width: 110,
    align: 'right',
    accessor: (r) => (
      <span className={`${styles.numCell} ${styles.numCellZero}`}>
        {r.total_value_sen > 0 ? fmtRm(r.total_value_sen) : '—'}
      </span>
    ),
    searchValue: () => '',
    filterValue: (r) => r.total_value_sen > 0 ? fmtRm(r.total_value_sen) : '—',
    sortFn: (a, b) => a.total_value_sen - b.total_value_sen,
  },
  {
    key: 'unitCost',
    label: 'Unit Cost',
    width: 100,
    align: 'right',
    accessor: (r) => (
      <span className={`${styles.numCell} ${styles.numCellZero}`}>
        {r.total_qty > 0 && r.total_value_sen > 0 ? fmtRm(Math.round(r.total_value_sen / r.total_qty)) : '—'}
      </span>
    ),
    searchValue: () => '',
    filterValue: (r) => r.total_qty > 0 && r.total_value_sen > 0 ? fmtRm(Math.round(r.total_value_sen / r.total_qty)) : '—',
    sortFn: (a, b) => {
      const ua = a.total_qty > 0 && a.total_value_sen > 0 ? a.total_value_sen / a.total_qty : 0;
      const ub = b.total_qty > 0 && b.total_value_sen > 0 ? b.total_value_sen / b.total_qty : 0;
      return ua - ub;
    },
  },
  {
    key: 'age',
    label: 'Age',
    width: 70,
    accessor: (r) => (
      <span className={styles.numCellZero} title={r.oldest_lot_at ?? undefined}>{fmtAgeDays(r.oldest_lot_at)}</span>
    ),
    searchValue: () => '',
    filterValue: (r) => fmtAgeDays(r.oldest_lot_at),
    /* Oldest lot first when ascending — null (no lots) sorts last. */
    sortFn: (a, b) => (a.oldest_lot_at ?? '9999-12-31').localeCompare(b.oldest_lot_at ?? '9999-12-31'),
  },
];

/* Variant breakdown panel inside a row's DataGrid expansion (was inline
   <tr>s pre-DataGrid). Sums each attribute composition (variant_key) across
   warehouses → one row per variant type, so the list shows "what variants
   this SKU has" without opening the drawer (Commander 2026-05-29). Lazy:
   only mounts (and fetches) when expanded. */
const SkuVariantPanel = ({ code }: { code: string }) => {
  const bd = useInventoryProductBreakdown(code);
  const balances = (bd.data?.balances ?? []).filter((b) => b.product_code === code);
  const variants = useMemo(() => {
    const m = new Map<string, { vk: string; qty: number; value: number }>();
    for (const b of balances) {
      const vk = b.variant_key ?? '';
      const cur = m.get(vk) ?? { vk, qty: 0, value: 0 };
      cur.qty += b.qty ?? 0;
      cur.value += b.value_sen ?? 0;
      m.set(vk, cur);
    }
    return [...m.values()].sort((a, b) =>
      (formatVariantKey(a.vk) || 'Standard').localeCompare(formatVariantKey(b.vk) || 'Standard'));
  }, [balances]);

  if (bd.isLoading) {
    return <div className={styles.numCellZero} style={{ padding: '8px 16px' }}>Loading variants…</div>;
  }
  if (variants.length === 0) {
    return <div className={styles.numCellZero} style={{ padding: '8px 16px' }}>No stock buckets yet.</div>;
  }
  return (
    <table className={`${styles.table} bg-surface-2`}>
      <tbody>
        {variants.map((v) => {
          const qtyClass = v.qty > 0 ? styles.numCellPos : v.qty < 0 ? styles.numCellNeg : styles.numCellZero;
          return (
            <tr key={v.vk}>
              <td style={{ width: 280 }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, paddingLeft: 22 }}>
                  <span className={styles.numCellZero}>↳</span>
                  <span>{formatVariantKey(v.vk) || 'Standard'}</span>
                </span>
              </td>
              <td className={`${styles.numCell} ${qtyClass}`} style={{ width: 100, textAlign: 'right' }}>
                {fmtQty(v.qty)}
              </td>
              <td className={`${styles.numCell} ${styles.numCellZero}`} style={{ width: 130, textAlign: 'right' }}>
                {v.value > 0 ? fmtRm(v.value) : '—'}
              </td>
              <td />
            </tr>
          );
        })}
      </tbody>
    </table>
  );
};

/* ════════════════════════════════════════════════════════════════════════
   Batches tab (Stage 4 — Commander 2026-05-31)
   ───────────────────────────────────────────────────────────────────────
   Sofa is colour-matched, produced as a SET on ONE PO = ONE dye lot = ONE
   batch (batch_no = source PO number). To ship a set with no colour diff the
   whole set must leave from ONE batch. This view shows, per warehouse, every
   open batch and the surviving component SKUs inside it — the raw material the
   allocator binds and the DO consumes from. Only produced-to-PO stock carries a
   batch; free / un-batched GRN stock never appears here (by design).
   ════════════════════════════════════════════════════════════════════════ */
const BatchesTab = ({
  warehouseId, setWarehouseId, warehouses, search, setSearch,
}: {
  warehouseId: string | null;
  setWarehouseId: (id: string | null) => void;
  warehouses: Warehouse[];
  search: string;
  setSearch: (s: string) => void;
}) => {
  const { data, isLoading, error } = useInventoryBatches({
    warehouseId: warehouseId ?? undefined,
  });
  const allBatches: InventoryBatch[] = useMemo(() => data ?? [], [data]);

  /* Client-side search across batch no / supplier / component code+name. */
  const q = search.trim().toLowerCase();
  const batches = useMemo(() => {
    if (!q) return allBatches;
    return allBatches.filter((b) =>
      b.batchNo.toLowerCase().includes(q) ||
      (b.supplierName ?? '').toLowerCase().includes(q) ||
      b.components.some((c) =>
        c.productCode.toLowerCase().includes(q) ||
        (c.productName ?? '').toLowerCase().includes(q)),
    );
  }, [allBatches, q]);

  const stats = useMemo(() => ({
    batchCount: batches.length,
    totalQty: batches.reduce((s, b) => s + b.totalRemaining, 0),
    skuCount: new Set(batches.flatMap((b) => b.components.map((c) => c.productCode))).size,
  }), [batches]);

  return (
    <>
      {/* Warehouse filter chips */}
      <div className={styles.warehouseChips}>
        <button type="button" className={styles.chip}
          data-active={warehouseId === null} onClick={() => setWarehouseId(null)}>
          All warehouses
        </button>
        {warehouses.map((w) => (
          <button key={w.id} type="button" className={styles.chip}
            data-active={warehouseId === w.id} onClick={() => setWarehouseId(w.id)}>
            {w.name}
          </button>
        ))}
      </div>

      <div className={styles.filterRow}>
        <div className={styles.searchBox} style={{ width: '100%' }}>
          <Search {...ICON} className={styles.searchIcon} />
          <input
            type="search"
            className={styles.searchInput}
            placeholder="Search batch / PO / supplier / component…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      <div className={STAT_GRID_3}>
        <StatCard label="Open Batches" value={stats.batchCount} />
        <StatCard label="Modules On Hand" value={fmtQty(stats.totalQty)} />
        <StatCard label="Distinct SKUs" value={stats.skuCount} />
      </div>

      <p className={styles.eyebrow}>
        {isLoading ? 'Loading…' : `${batches.length} open batch${batches.length === 1 ? '' : 'es'} · click a row to see component SKUs`}
      </p>

      {error && !isLoading && (
        <div className={BANNER_ERR}>
          <strong className="font-semibold">Failed to load.</strong>{' '}
          {error instanceof Error ? error.message : 'Something went wrong.'}
        </div>
      )}

      <DataGrid<InventoryBatch>
        rows={batches}
        columns={BATCH_COLUMNS}
        storageKey="dg-inventory-batches"
        exportName="Inventory Batches"
        rowKey={(b) => `${b.warehouseId}|${b.batchNo}`}
        searchPlaceholder="Search batches…"
        hideSearch
        groupBanner={false}
        isLoading={isLoading}
        emptyMessage={`No open batches${q ? ' match the search' : ''}.`}
        rowStyle={() => ({ cursor: 'pointer' })}
        /* Click a row / its chevron to expand the batch into its surviving
           component SKUs — same behavior as the legacy click-to-expand rows. */
        expandable={{
          renderExpansion: (b) => <BatchComponentsPanel batch={b} />,
          rowExpansionKey: (b) => `${b.warehouseId}|${b.batchNo}`,
        }}
      />
    </>
  );
};

/* DataGrid columns for the Batches tab — module scope for a stable
   reference. Chevron comes from DataGrid's synthetic expand column. */
const BATCH_COLUMNS: DataGridColumn<InventoryBatch>[] = [
  {
    key: 'batch',
    label: 'Batch / PO',
    width: 160,
    accessor: (b) => <span className={styles.codeChip}>{b.batchNo}</span>,
    /* Search must keep matching component SKUs inside the batch (legacy
       page-level search semantics). */
    searchValue: (b) =>
      `${b.batchNo} ${b.supplierName ?? ''} ${b.components.map((c) => `${c.productCode} ${c.productName ?? ''}`).join(' ')}`,
    filterValue: (b) => b.batchNo,
    sortFn: (a, b) => (a.batchNo ?? '').localeCompare(b.batchNo ?? ''),
  },
  {
    key: 'warehouse',
    label: 'Warehouse',
    width: 150,
    accessor: (b) => b.warehouseName ?? '—',
  },
  {
    key: 'supplier',
    label: 'Supplier',
    width: 170,
    accessor: (b) => b.supplierName ?? <span className={styles.numCellZero}>—</span>,
    searchValue: (b) => b.supplierName ?? '',
    filterValue: (b) => b.supplierName ?? '—',
  },
  {
    key: 'components',
    label: 'Components',
    width: 100,
    align: 'right',
    accessor: (b) => <span className={`${styles.numCell} ${styles.numCellZero}`}>{b.components.length}</span>,
    searchValue: () => '',
    filterValue: (b) => String(b.components.length),
    sortFn: (a, b) => a.components.length - b.components.length,
  },
  {
    key: 'modules',
    label: 'Modules',
    width: 90,
    align: 'right',
    accessor: (b) => (
      <span className={`${styles.numCell} ${b.totalRemaining > 0 ? styles.numCellPos : styles.numCellZero}`}>
        {fmtQty(b.totalRemaining)}
      </span>
    ),
    searchValue: () => '',
    filterValue: (b) => String(b.totalRemaining),
    sortFn: (a, b) => a.totalRemaining - b.totalRemaining,
  },
  {
    key: 'received',
    label: 'Received',
    width: 90,
    accessor: (b) => (
      <span className={styles.numCellZero} title={b.receivedAt ?? undefined}>{fmtAgeDays(b.receivedAt)}</span>
    ),
    searchValue: () => '',
    filterValue: (b) => fmtAgeDays(b.receivedAt),
    sortFn: (a, b) => (a.receivedAt ?? '9999-12-31').localeCompare(b.receivedAt ?? '9999-12-31'),
  },
];

/* Component SKUs inside a batch — rendered in the row's DataGrid expansion
   (was inline cream <tr>s pre-DataGrid). */
const BatchComponentsPanel = ({ batch }: { batch: InventoryBatch }) => (
  <table className={`${styles.table} bg-surface-2`}>
    <tbody>
      {batch.components.map((c) => (
        <tr key={`${c.productCode}|${c.variantKey ?? ''}`}>
          <td style={{ paddingLeft: 28, width: 190 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span className={styles.numCellZero}>↳</span>
              <Link
                to={`/scm/inventory/stock-card/${encodeURIComponent(c.productCode)}`}
                className={styles.codeChip}
                onClick={(e) => e.stopPropagation()}
                title="Open Stock Card"
                style={{ textDecoration: 'none' }}
              >
                {c.productCode}
              </Link>
            </span>
          </td>
          <td>
            {c.productName ?? '—'}
            {c.variantKey && <span className={styles.numCellZero}> · {formatVariantKey(c.variantKey) || 'Standard'}</span>}
          </td>
          <td className={`${styles.numCell} ${styles.numCellZero}`} style={{ width: 110, textAlign: 'right' }}>
            {fmtRm(c.unitCostSen)}
          </td>
          <td className={`${styles.numCell} ${c.qtyRemaining > 0 ? styles.numCellPos : styles.numCellZero}`} style={{ width: 90, textAlign: 'right' }}>
            {fmtQty(c.qtyRemaining)}
          </td>
          <td className={styles.numCellZero} style={{ width: 90 }} title={c.receivedAt ?? undefined}>
            {fmtAgeDays(c.receivedAt)}
          </td>
        </tr>
      ))}
    </tbody>
  </table>
);

/* ════════════════════════════════════════════════════════════════════════
   Product breakdown drawer — AutoCount-style "Up To Date Cost" panel:
   per-warehouse Location | Qty | Unit Cost  +  FIFO lots underneath
   ════════════════════════════════════════════════════════════════════════ */
const ProductBreakdownDrawer = ({
  code, name, onClose,
}: { code: string; name: string; onClose: () => void }) => {
  const breakdown = useInventoryProductBreakdown(code);
  const lots = useInventoryLots(code);
  const movements = useInventoryMovements({ productCode: code });
  const cogs = useCogsEntries({ productCode: code });
  const warehouses = useWarehouses();

  /* Movements + COGS sections are collapsed by default (Commander 2026-05-30).
     Operator opens what they want to see — keeps the drawer scannable. */
  const [movementsOpen, setMovementsOpen] = useState(false);
  const [cogsOpen, setCogsOpen] = useState(false);

  /* Warehouse name lookup (UUID → code) so the Movements table can show
     "SLGR" instead of "41d544bc". */
  const whById = useMemo(
    () => new Map((warehouses.data ?? []).map((w) => [w.id, w])),
    [warehouses.data],
  );

  /* Running-balance computation for Movements (same pattern as Stock Card):
     API returns DESC, reverse to ASC, accumulate signed qty, then render DESC.
     OUT subtracts, IN/ADJUSTMENT/TRANSFER add as-is (ADJUSTMENT carries a
     signed qty per inventory_movements convention). */
  const movementsWithBalance = useMemo(() => {
    const desc = movements.data ?? [];
    const asc = [...desc].reverse();
    let running = 0;
    const out: Array<typeof desc[number] & { runningBalance: number }> = [];
    for (const m of asc) {
      running += m.movement_type === 'OUT' ? -m.qty : m.qty;
      out.push({ ...m, runningBalance: running });
    }
    return out.reverse();
  }, [movements.data]);

  const balances = (breakdown.data?.balances ?? []).filter((b) => b.product_code === code);
  const totalQty = balances.reduce((s, b) => s + (b.qty ?? 0), 0);
  const totalVal = balances.reduce((s, b) => s + (b.value_sen ?? 0), 0);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.32)', zIndex: 50,
        display: 'flex', justifyContent: 'flex-end',
      }}>
      <div onClick={(e) => e.stopPropagation()}
        className="w-[720px] max-w-[95vw] overflow-auto bg-bg p-5">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border pb-3">
          <div>
            <h2 className="font-display text-[20px] font-extrabold leading-tight tracking-tight text-ink">Stock Breakdown</h2>
            <p className="mt-1 text-[12px] text-ink-secondary">
              <span className={styles.codeChip}>{code}</span> {name}
            </p>
          </div>
          <button type="button" className={styles.chip} onClick={onClose}>
            <X {...ICON} />
            <span>Close</span>
          </button>
        </div>

        <div className={`${STAT_GRID_3} mt-4`}>
          <StatCard label="Total Qty" value={fmtQty(totalQty)} />
          <StatCard label="Total Value" value={fmtRm(totalVal)} />
        </div>

        {/* Per-warehouse × attribute-composition breakdown. One row per
            (warehouse, variant); identical attributes are already pooled, so
            this is the SKU split into its real stock buckets (migration 0095). */}
        <p className={styles.eyebrow} style={{ marginTop: 'var(--space-4)' }}>
          Stock by Warehouse &amp; Attributes
        </p>
        <div className={styles.tableCard}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Location</th>
                <th>Attributes</th>
                <th style={{ textAlign: 'right' }}>Qty</th>
                <th style={{ textAlign: 'right' }}>Avg Unit Cost</th>
                <th style={{ textAlign: 'right' }}>Value</th>
              </tr>
            </thead>
            <tbody>
              {breakdown.isLoading && <tr><td colSpan={5} className={styles.emptyRow}>Loading…</td></tr>}
              {!breakdown.isLoading && balances.length === 0 && (
                <tr><td colSpan={5} className={styles.emptyRow}>No stock rows yet.</td></tr>
              )}
              {!breakdown.isLoading && balances.map((b) => {
                const avgCost = b.qty > 0 && b.value_sen ? b.value_sen / b.qty : 0;
                const attrs = formatVariantKey(b.variant_key);
                return (
                  <tr key={`${b.warehouse_id}|${b.variant_key ?? ''}`}>
                    <td>{b.warehouse_code} · {b.warehouse_name}</td>
                    <td>{attrs || <span className={styles.numCellZero}>Standard</span>}</td>
                    <td className={`${styles.numCell} ${b.qty > 0 ? styles.numCellPos : styles.numCellZero}`}>
                      {fmtQty(b.qty)}
                    </td>
                    <td className={`${styles.numCell} ${styles.numCellZero}`}>
                      {avgCost > 0 ? fmtRm(avgCost) : '—'}
                    </td>
                    <td className={styles.numCell} style={{ fontWeight: 700 }}>
                      {b.value_sen && b.value_sen > 0 ? fmtRm(b.value_sen) : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* FIFO lots — oldest first */}
        <p className={styles.eyebrow} style={{ marginTop: 'var(--space-4)' }}>
          FIFO Lots (oldest first — these are consumed first on the next DO)
        </p>
        <div className={styles.tableCard}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Received</th>
                <th>Warehouse</th>
                <th style={{ textAlign: 'right' }}>Qty Left</th>
                <th style={{ textAlign: 'right' }}>Unit Cost</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {lots.isLoading && <tr><td colSpan={5} className={styles.emptyRow}>Loading lots…</td></tr>}
              {!lots.isLoading && (lots.data ?? []).length === 0 && (
                <tr><td colSpan={5} className={styles.emptyRow}>No open lots.</td></tr>
              )}
              {(lots.data ?? []).map((l) => (
                <tr key={l.id}>
                  <td className={styles.numCellZero}>{fmtDateTime(l.received_at)}</td>
                  <td>{l.warehouse_code ?? '—'}</td>
                  <td className={`${styles.numCell} ${styles.numCellPos}`}>{fmtQty(l.qty_remaining)}</td>
                  <td className={`${styles.numCell} ${styles.numCellZero}`}>{fmtRm(l.unit_cost_sen)}</td>
                  <td className={styles.numCellZero}>{l.source_doc_no ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Movements ledger — collapsed by default. Header is a button. */}
        <button type="button"
          onClick={() => setMovementsOpen((v) => !v)}
          style={{
            marginTop: 'var(--space-4)', cursor: 'pointer', background: 'transparent',
            border: 'none', padding: 0, display: 'inline-flex', alignItems: 'center', gap: 4,
          }}>
          <span className={styles.eyebrow} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            {movementsOpen ? <ChevronDown size={12} strokeWidth={1.75} /> : <ChevronRight size={12} strokeWidth={1.75} />}
            Movements ({(movements.data ?? []).length}) — every stock change for this SKU
          </span>
        </button>
        {movementsOpen && (
          <div className={styles.tableCard}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Type</th>
                  <th>Warehouse</th>
                  <th style={{ textAlign: 'right' }}>Qty</th>
                  <th style={{ textAlign: 'right' }}>Running</th>
                  <th>Source Doc</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {movements.isLoading && <tr><td colSpan={7} className={styles.emptyRow}>Loading…</td></tr>}
                {!movements.isLoading && movementsWithBalance.length === 0 && (
                  <tr><td colSpan={7} className={styles.emptyRow}>No movements yet for this SKU.</td></tr>
                )}
                {movementsWithBalance.map((m) => {
                  const href = docHrefFor(m);
                  const qtySign = m.movement_type === 'IN' ? '+' : m.movement_type === 'OUT' ? '−' : (m.qty > 0 ? '+' : m.qty < 0 ? '−' : '');
                  const qtyClass = m.qty > 0 ? styles.numCellPos : m.qty < 0 ? styles.numCellNeg : styles.numCellZero;
                  const wh = m.warehouse_id ? whById.get(m.warehouse_id) : null;
                  return (
                    <tr key={m.id}>
                      <td className={styles.numCellZero}>{fmtDateTime(m.created_at)}</td>
                      <td>
                        <span className={`${styles.movementPill} ${
                          m.movement_type === 'IN' ? styles.movementIn
                          : m.movement_type === 'OUT' ? styles.movementOut
                          : styles.movementAdj}`}>{m.movement_type}</span>
                      </td>
                      <td>{wh ? wh.code : (m.warehouse_id ? '—' : '—')}</td>
                      <td className={`${styles.numCell} ${qtyClass}`}>{qtySign}{fmtQty(Math.abs(m.qty))}</td>
                      <td className={`${styles.numCell}`} style={{ fontWeight: 700 }}>
                        {fmtQty(m.runningBalance)}
                      </td>
                      <td>
                        {m.source_doc_no ? (
                          href
                            ? <Link to={href} className={styles.docLink}>{m.source_doc_no}</Link>
                            : <span className={styles.docLink}>{m.source_doc_no}</span>
                        ) : <span className={styles.numCellZero}>—</span>}
                      </td>
                      <td className={styles.numCellZero}>{m.notes ?? '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* COGS — collapsed by default. */}
        <button type="button"
          onClick={() => setCogsOpen((v) => !v)}
          style={{
            marginTop: 'var(--space-4)', cursor: 'pointer', background: 'transparent',
            border: 'none', padding: 0, display: 'inline-flex', alignItems: 'center', gap: 4,
          }}>
          <span className={styles.eyebrow} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            {cogsOpen ? <ChevronDown size={12} strokeWidth={1.75} /> : <ChevronRight size={12} strokeWidth={1.75} />}
            COGS ({(cogs.data ?? []).length}) — FIFO consumptions for this SKU
          </span>
        </button>
        {cogsOpen && (
          <div className={styles.tableCard}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Consumed at</th>
                  <th>Source Doc</th>
                  <th style={{ textAlign: 'right' }}>Qty</th>
                  <th style={{ textAlign: 'right' }}>Unit Cost</th>
                  <th style={{ textAlign: 'right' }}>Total Cost</th>
                  <th>From Lot</th>
                </tr>
              </thead>
              <tbody>
                {cogs.isLoading && <tr><td colSpan={6} className={styles.emptyRow}>Loading…</td></tr>}
                {!cogs.isLoading && (cogs.data ?? []).length === 0 && (
                  <tr><td colSpan={6} className={styles.emptyRow}>No COGS entries yet for this SKU.</td></tr>
                )}
                {(cogs.data ?? []).map((c) => (
                  <tr key={c.id}>
                    <td className={styles.numCellZero}>{fmtDateTime(c.consumed_at)}</td>
                    <td><span className={styles.docLink}>{c.source_doc_no ?? '—'}</span></td>
                    <td className={`${styles.numCell} ${styles.numCellNeg}`}>−{fmtQty(c.qty_consumed)}</td>
                    <td className={`${styles.numCell} ${styles.numCellZero}`}>{fmtRm(c.unit_cost_sen)}</td>
                    <td className={styles.numCell} style={{ fontWeight: 700 }}>{fmtRm(c.total_cost_sen)}</td>
                    <td className={styles.numCellZero}>{c.lot_source_doc_no ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

/* ════════════════════════════════════════════════════════════════════════
   Movements tab
   ════════════════════════════════════════════════════════════════════════ */
const MovementsTab = ({
  warehouseId, search, warehouses,
}: {
  warehouseId: string | null;
  search: string;
  warehouses: Array<{ id: string; code: string; name: string }>;
}) => {
  const [docType, setDocType] = useState<string | null>(null);
  const { data, isLoading, error } = useInventoryMovements({
    warehouseId: warehouseId ?? undefined,
    productCode: search.trim() || undefined,
    docType: docType ?? undefined,
  });
  const movements = data ?? [];
  const wmap = useMemo(() => new Map(warehouses.map((w) => [w.id, w])), [warehouses]);

  const DOC_TYPES = [
    { value: null,                label: 'All' },
    { value: 'GRN',               label: 'GRN (IN)' },
    { value: 'DO',                label: 'DO (OUT)' },
    { value: 'DR',                label: 'DR (IN)' },
    { value: 'PURCHASE_RETURN',   label: 'PR (OUT)' },
    { value: 'STOCK_TRANSFER',    label: 'Transfer' },
    { value: 'STOCK_TAKE',        label: 'Stock Take' },
    { value: 'ADJUSTMENT',        label: 'Adjustment' },
  ];

  return (
    <>
      <div className={styles.warehouseChips}>
        {DOC_TYPES.map((t) => (
          <button key={t.value ?? 'all'} type="button" className={styles.chip}
            data-active={docType === t.value}
            onClick={() => setDocType(t.value)}>
            {t.label}
          </button>
        ))}
      </div>

      <p className={styles.eyebrow}>
        {isLoading ? 'Loading…' : `${movements.length} movements (latest first)`}
      </p>

      {error && !isLoading && (
        <div className={BANNER_ERR}>
          <strong className="font-semibold">Failed to load.</strong>{' '}
          {error instanceof Error ? error.message : 'Something went wrong.'}
        </div>
      )}

      <div className={styles.tableCard}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>When</th>
              <th>Type</th>
              <th>Warehouse</th>
              <th>Product</th>
              <th style={{ textAlign: 'right' }}>Qty</th>
              <th style={{ textAlign: 'right' }}>Unit Cost</th>
              <th style={{ textAlign: 'right' }}>Line Cost</th>
              <th>Source Doc</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr><td colSpan={9} className={styles.emptyRow}>Loading…</td></tr>
            )}
            {!isLoading && movements.length === 0 && (
              <tr><td colSpan={9} className={styles.emptyRow}>No movements match the filters.</td></tr>
            )}
            {!isLoading && movements.map((m) => {
              const w = wmap.get(m.warehouse_id);
              return (
                <tr key={m.id}>
                  <td className={styles.numCellZero}>{fmtDateTime(m.created_at)}</td>
                  <td>
                    <span className={`${styles.movementPill} ${
                      m.movement_type === 'IN' ? styles.movementIn
                      : m.movement_type === 'OUT' ? styles.movementOut
                      : styles.movementAdj}`}>
                      {m.movement_type === 'IN' && <ArrowDownLeft size={11} strokeWidth={2} style={{ marginRight: 4 }} />}
                      {m.movement_type === 'OUT' && <ArrowUpRight size={11} strokeWidth={2} style={{ marginRight: 4 }} />}
                      {m.movement_type}
                    </span>
                  </td>
                  <td>{w ? w.code : '—'}</td>
                  <td>
                    <div><span className={styles.codeChip}>{m.product_code}</span></div>
                    <div className={styles.numCellZero} style={{ fontSize: 'var(--fs-11)' }}>{m.product_name ?? '—'}</div>
                  </td>
                  <td className={`${styles.numCell} ${m.movement_type === 'IN' ? styles.numCellPos : styles.numCellNeg}`}>
                    {m.movement_type === 'IN' ? '+' : m.movement_type === 'OUT' ? '−' : ''}
                    {fmtQty(Math.abs(m.qty))}
                  </td>
                  <td className={`${styles.numCell} ${styles.numCellZero}`}>
                    {m.unit_cost_sen && m.unit_cost_sen > 0 ? fmtRm(m.unit_cost_sen) : '—'}
                  </td>
                  <td className={`${styles.numCell} ${styles.numCellZero}`}>
                    {m.total_cost_sen && m.total_cost_sen > 0 ? fmtRm(m.total_cost_sen) : '—'}
                  </td>
                  <td>
                    {m.source_doc_no ? (() => {
                      const href = docHrefFor(m);
                      return href
                        ? <Link to={href} className={styles.docLink}>{m.source_doc_no}</Link>
                        : <span className={styles.docLink}>{m.source_doc_no}</span>;
                    })() : <span className={styles.numCellZero}>—</span>}
                  </td>
                  <td className={styles.numCellZero}>{m.notes ?? '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
};

/* ════════════════════════════════════════════════════════════════════════
   COGS tab — FIFO consumption stream
   ════════════════════════════════════════════════════════════════════════ */
const CogsTab = ({
  warehouseId, search,
}: {
  warehouseId: string | null;
  search: string;
}) => {
  const { data, isLoading } = useCogsEntries({
    warehouseId: warehouseId ?? undefined,
    productCode: search.trim() || undefined,
  });
  const cogs: CogsEntry[] = useMemo(() => data ?? [], [data]);
  const totalCogs = useMemo(() => cogs.reduce((s, r) => s + r.total_cost_sen, 0), [cogs]);

  return (
    <>
      <div className={STAT_GRID_3}>
        <StatCard
          label="Total COGS"
          value={fmtRm(totalCogs)}
          subtitle={`${cogs.length} consumptions`}
        />
      </div>

      <p className={styles.eyebrow}>{isLoading ? 'Loading…' : `${cogs.length} consumption entries`}</p>

      <div className={styles.tableCard}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>When</th>
              <th>Warehouse</th>
              <th>Product</th>
              <th style={{ textAlign: 'right' }}>Qty</th>
              <th style={{ textAlign: 'right' }}>Unit Cost</th>
              <th style={{ textAlign: 'right' }}>COGS</th>
              <th>Doc</th>
              <th>Lot Received</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && <tr><td colSpan={8} className={styles.emptyRow}>Loading…</td></tr>}
            {!isLoading && cogs.length === 0 && (
              <tr><td colSpan={8} className={styles.emptyRow}>
                <DollarSign size={32} strokeWidth={1.5} />
                <div style={{ marginTop: 8 }}>No COGS entries yet.</div>
                <div style={{ marginTop: 4, fontSize: 'var(--fs-12)' }}>
                  COGS is auto-posted when a DO or Purchase Return consumes a lot.
                </div>
              </td></tr>
            )}
            {!isLoading && cogs.map((c) => (
              <tr key={c.id}>
                <td className={styles.numCellZero}>{fmtDateTime(c.consumed_at)}</td>
                <td>{c.warehouse_code}</td>
                <td><span className={styles.codeChip}>{c.product_code}</span></td>
                <td className={`${styles.numCell} ${styles.numCellNeg}`}>−{fmtQty(c.qty_consumed)}</td>
                <td className={`${styles.numCell} ${styles.numCellZero}`}>{fmtRm(c.unit_cost_sen)}</td>
                <td className={`${styles.numCell}`} style={{ fontWeight: 700 }}>{fmtRm(c.total_cost_sen)}</td>
                <td>{c.source_doc_no ? <span className={styles.docLink}>{c.source_doc_no}</span> : '—'}</td>
                <td className={styles.numCellZero}>
                  {fmtDateTime(c.lot_received_at)}{c.lot_source_doc_no ? ` · ${c.lot_source_doc_no}` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
};

/* ════════════════════════════════════════════════════════════════════════
   Warehouses tab — moved from standalone /warehouses page (PR #38)
   ════════════════════════════════════════════════════════════════════════ */
const WarehousesTab = () => {
  const [includeInactive, setIncludeInactive] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Warehouse | null>(null);
  const warehouses = useWarehouses({ includeInactive });

  return (
    <>
      <div className={styles.filterRow} style={{ justifyContent: 'space-between' }}>
        <label className="inline-flex items-center gap-1.5 text-[13px] text-ink">
          <input type="checkbox" checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)} />
          Show inactive
        </label>
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Plus {...ICON_MD} />
          <span>New Warehouse</span>
        </Button>
      </div>

      <div className={styles.tableCard}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
              <th>Location</th>
              <th>Default</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {warehouses.isLoading && (
              <tr><td colSpan={6} className={styles.emptyRow}>Loading…</td></tr>
            )}
            {!warehouses.isLoading && (warehouses.data?.length ?? 0) === 0 && (
              <tr><td colSpan={6} className={styles.emptyRow}>
                <WarehouseIcon size={32} strokeWidth={1.5} />
                <div style={{ marginTop: 8 }}>No warehouses yet.</div>
              </td></tr>
            )}
            {warehouses.data?.map((w) => (
              <tr key={w.id}>
                <td><span className={styles.codeChip}>{w.code}</span></td>
                <td>{w.name}</td>
                <td className={styles.numCellZero}>{w.location ?? '—'}</td>
                <td>{w.is_default ? <Star size={12} strokeWidth={2}
                  className="fill-primary text-primary" /> : '—'}</td>
                <td>
                  <span className={`${styles.movementPill} ${w.is_active ? styles.movementIn : styles.movementAdj}`}>
                    {w.is_active ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td>
                  <Button variant="ghost" onClick={() => setEditing(w)}>Edit</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(creating || editing) && (
        <WarehouseDrawer
          editing={editing}
          onClose={() => { setCreating(false); setEditing(null); }}
        />
      )}
    </>
  );
};

const WarehouseDrawer = ({
  editing, onClose,
}: {
  editing: Warehouse | null;
  onClose: () => void;
}) => {
  const create = useCreateWarehouse();
  const update = useUpdateWarehouse();
  const notify = useNotify();
  const [form, setForm] = useState({
    code: editing?.code ?? '',
    name: editing?.name ?? '',
    location: editing?.location ?? '',
    isActive: editing?.is_active ?? true,
    isDefault: editing?.is_default ?? false,
  });

  const submit = () => {
    if (!form.code.trim() || !form.name.trim()) {
      notify({ title: 'Code and Name are required.', tone: 'error' });
      return;
    }
    if (editing) {
      update.mutate({
        id: editing.id,
        code: form.code, name: form.name, location: form.location,
        isActive: form.isActive, isDefault: form.isDefault,
      }, { onSuccess: onClose });
    } else {
      create.mutate({
        code: form.code, name: form.name,
        location: form.location || undefined,
        isDefault: form.isDefault,
      }, { onSuccess: onClose });
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.32)', zIndex: 50,
        display: 'flex', justifyContent: 'flex-end',
      }}>
      <div onClick={(e) => e.stopPropagation()}
        className="w-[480px] max-w-[95vw] overflow-auto bg-bg p-5">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border pb-3">
          <h2 className="font-display text-[20px] font-extrabold leading-tight tracking-tight text-ink">
            {editing ? 'Edit Warehouse' : 'New Warehouse'}
          </h2>
          <button type="button" className={styles.chip} onClick={onClose}>
            <X {...ICON} />
          </button>
        </div>

        <label style={{ display: 'block', marginTop: 'var(--space-4)' }}>
          <div className={styles.eyebrow}>Code *</div>
          <input className={styles.searchInput} style={{ width: '100%' }}
            value={form.code} placeholder="KL / PJ / JB"
            onChange={(e) => setForm((s) => ({ ...s, code: e.target.value.toUpperCase() }))} />
        </label>
        <label style={{ display: 'block', marginTop: 'var(--space-3)' }}>
          <div className={styles.eyebrow}>Name *</div>
          <input className={styles.searchInput} style={{ width: '100%' }}
            value={form.name} placeholder="KL Warehouse / 2990 PJ"
            onChange={(e) => setForm((s) => ({ ...s, name: e.target.value }))} />
        </label>
        <label style={{ display: 'block', marginTop: 'var(--space-3)' }}>
          <div className={styles.eyebrow}>Location</div>
          <input className={styles.searchInput} style={{ width: '100%' }}
            value={form.location ?? ''} placeholder="Address / area"
            onChange={(e) => setForm((s) => ({ ...s, location: e.target.value }))} />
        </label>
        <div style={{ display: 'flex', gap: 'var(--space-4)', marginTop: 'var(--space-3)' }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={form.isDefault}
              onChange={(e) => setForm((s) => ({ ...s, isDefault: e.target.checked }))} />
            Default warehouse
          </label>
          {editing && (
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={form.isActive}
                onChange={(e) => setForm((s) => ({ ...s, isActive: e.target.checked }))} />
              Active
            </label>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-3)', marginTop: 'var(--space-5)' }}>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={create.isPending || update.isPending}>
            {(create.isPending || update.isPending) ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  );
};

const fmtDateTime = (iso: string): string => {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  const date = fmtDate(d);
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${date} ${time}`;
};
