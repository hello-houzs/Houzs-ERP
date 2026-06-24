// Delivery Orders list — DataGrid clone of the Sales Orders list
// (MfgSalesOrdersList.tsx). Same chrome: 4 KPI tiles, shared column-aware
// filter bar (quick search + add-a-column filters), status chips,
// ~visible/hidden column set, right-click context menu, click-to-expand
// line drill-down, and double-click-to-open. Wired to the DO list hook +
// the rebuilt DO API.
//
// UNIQUE localStorage keys ('pr-g.do-list.layout.v1' /
// 'pr-g.do-list.filters.v1') — never reuse the SO keys.

import { useMemo, useState } from 'react';
import type { JSX } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, ArrowRightLeft } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { DataGrid, type DataGridColumn } from '../../vendor/scm/components/DataGrid';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { formatPhone } from '@2990s/shared/phone';
import { buildVariantSummary } from '@2990s/shared';
import {
  useMfgDeliveryOrders, useUpdateMfgDeliveryOrderStatus, useMfgDeliveryOrderDetail,
} from '../../vendor/scm/lib/delivery-order-queries';
import { useStaff } from '../../vendor/scm/lib/admin-queries';
import { authedFetch } from '../../vendor/scm/lib/authed-fetch';
import { BrandingPill, badgeFor } from '../../vendor/scm/lib/category-badges';
import styles from './MfgSalesOrdersList.module.css';
import soDetailStyles from './SalesOrderDetail.module.css';

/* ── Row shape (DO header) ─────────────────────────────────────────────── */
type DoRow = {
  id: string;
  do_number: string;
  so_doc_no: string | null;
  do_date: string;
  expected_delivery_at: string | null;
  customer_delivery_date: string | null;
  debtor_code: string | null;
  debtor_name: string;
  salesperson_id: string | null;
  sales_location: string | null;
  ref: string | null;
  customer_so_no: string | null;
  po_doc_no: string | null;
  branding: string | null;
  venue: string | null;
  phone: string | null;
  email: string | null;
  customer_type: string | null;
  building_type: string | null;
  address1: string | null;
  address2: string | null;
  customer_state: string | null;
  customer_country: string | null;
  city: string | null;
  postcode: string | null;
  driver_name: string | null;
  vehicle: string | null;
  local_total_centi: number;
  mattress_sofa_centi?: number;
  bedframe_centi?: number;
  accessories_centi?: number;
  others_centi?: number;
  mattress_sofa_cost_centi?: number;
  bedframe_cost_centi?: number;
  accessories_cost_centi?: number;
  total_cost_centi?: number;
  total_margin_centi?: number;
  margin_pct_basis?: number;
  status: string;
  currency: string;
  note: string | null;
  line_count?: number;
  /* Tier 2 downstream-lock — list endpoint stamps this flag when the DO has
     ANY non-cancelled DR / SI. Hides Edit + Cancel from the context menu;
     convert-to-DR / convert-to-SI stay (partial flow allowed). */
  has_children?: boolean;
  /* Document-driven status (latest event wins) — 'invoiced' | 'returned', else
     'shipped' baseline. Sent by the list endpoint. */
  lifecycle_state?: 'shipped' | 'invoiced' | 'returned';
};

const fmtRm = (centi: number): string =>
  (centi / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const compactDate = (iso: string | null | undefined): string => {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${m[1]}/${m[2]}/${m[3]}`;
};

/* DO status flow: LOADED→DISPATCHED→IN_TRANSIT→SIGNED→DELIVERED→INVOICED,
   plus CANCELLED. Pill styling reuses the SO detail status classes where the
   stages line up; the rest fall back to a neutral pill. */
const STATUS_CLASS: Record<string, string> = {
  LOADED:      soDetailStyles.statusConfirmed ?? '',
  DISPATCHED:  soDetailStyles.statusShipped ?? '',
  IN_TRANSIT:  soDetailStyles.statusInProd ?? '',
  SIGNED:      soDetailStyles.statusReady ?? '',
  DELIVERED:   soDetailStyles.statusDelivered ?? '',
  INVOICED:    soDetailStyles.statusInvoiced ?? '',
  RETURNED:    soDetailStyles.statusReturned ?? '',
  CANCELLED:   soDetailStyles.statusCancelled ?? '',
};
const STATUS_LABEL: Record<string, string> = {
  LOADED:     'Loaded',
  DISPATCHED: 'Shipped',
  IN_TRANSIT: 'In Transit',
  SIGNED:     'Signed',
  DELIVERED:  'Delivered',
  INVOICED:   'Invoiced',
  RETURNED:   'Delivery Return',
  CANCELLED:  'Cancelled',
};
/* Document-driven status (Wei Siang 2026-05-31) — "latest event wins". A DO
   ships on creation (Shipped); if a non-cancelled Sales Invoice or Delivery
   Return points back at it, the most recent one becomes the badge. Cancelled
   (operator action) always wins. The list endpoint sends lifecycle_state. */
type DoLifecycle = 'shipped' | 'invoiced' | 'returned';
const doEffectiveKey = (status: string, lifecycle?: DoLifecycle): string => {
  if (status === 'CANCELLED') return 'CANCELLED';
  if (lifecycle === 'returned') return 'RETURNED';
  if (lifecycle === 'invoiced') return 'INVOICED';
  return 'DISPATCHED'; // shipped baseline
};
const STATUS_CHIPS = ['all', 'DISPATCHED', 'INVOICED', 'RETURNED', 'CANCELLED'] as const;

const StatusPill = ({ status, lifecycle }: { status: string; lifecycle?: DoLifecycle }) => {
  const key = doEffectiveKey(status, lifecycle);
  return (
    <span className={`${soDetailStyles.statusPill} ${STATUS_CLASS[key] ?? ''}`}>
      {STATUS_LABEL[key] ?? key.replace(/_/g, ' ')}
    </span>
  );
};

/* Branding follows the DO's first line item — mirrors the SO list rule. */
const deriveBranding = (r: DoRow): string => r.branding ?? '';

/* ── Drilldown — per-line breakdown for one DO, mirrors ExpandedSoLines ─── */
type DoItem = {
  id: string;
  item_code: string | null;
  item_group: string | null;
  description: string | null;
  variants: Record<string, unknown> | null;
  uom: string | null;
  qty: number | null;
  unit_price_centi: number | null;
  unit_cost_centi: number | null;
  line_cost_centi: number | null;
  line_margin_centi: number | null;
  line_total_centi: number | null;
  downstream?: { docNumber: string; docType: 'SI' | 'DR'; qty: number; status: string }[];
};

const CategoryPill = ({ group }: { group: string | null | undefined }) => {
  const spec = badgeFor(group);
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', padding: '1px 8px', borderRadius: 999,
      background: spec.bg, color: spec.fg, fontFamily: 'var(--font-button)', fontSize: 'var(--fs-10)',
      fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', lineHeight: 1.4, whiteSpace: 'nowrap',
    }}>
      {spec.label}
    </span>
  );
};

/* Per-line cost/margin derivations — shared by the drill-down column
   accessors AND their sort comparators so a sorted cell always agrees with
   the value it sorted by (older rows lack the stored snapshots). */
const doLineTotalOf = (it: DoItem): number => Number(it.line_total_centi ?? 0);
const doLineCostOf = (it: DoItem): number =>
  it.line_cost_centi != null
    ? Number(it.line_cost_centi)
    : Number(it.qty ?? 0) * Number(it.unit_cost_centi ?? 0);
const doLineMarginOf = (it: DoItem): number =>
  it.line_margin_centi != null
    ? Number(it.line_margin_centi)
    : doLineTotalOf(it) - doLineCostOf(it);

/* Drill-down columns — display-only DataGridColumn specs so the DO drill-down
   gets the SAME add/remove · drag-reorder · resize · right-click as the main
   list grids (it used to be a hand-built fixed <table>). Shared layout key
   so the operator's column prefs persist across every DO they expand. */
const buildDoDrilldownColumns = (): DataGridColumn<DoItem>[] => [
  {
    key: 'group', label: 'Group', width: 90, groupable: true,
    accessor: (it) => <CategoryPill group={it.item_group} />,
    searchValue: (it) => it.item_group ?? '',
    groupValue: (it) => it.item_group ?? '(none)',
    sortFn: (a, b) => (a.item_group ?? '').localeCompare(b.item_group ?? ''),
  },
  {
    key: 'item_code', label: 'Item Code', width: 130,
    accessor: (it) => <span style={{ fontWeight: 700, color: 'var(--c-burnt)' }}>{it.item_code ?? '—'}</span>,
    searchValue: (it) => it.item_code ?? '',
    sortFn: (a, b) => (a.item_code ?? '').localeCompare(b.item_code ?? ''),
  },
  {
    key: 'description', label: 'Description', width: 240, minWidth: 180,
    accessor: (it) => {
      const manual = (it.description ?? '').trim();
      if (manual) return <div>{manual}</div>;
      const summary = buildVariantSummary(it.item_group, it.variants);
      return summary ? <div>{summary}</div> : '—';
    },
    searchValue: (it) => `${it.description ?? ''} ${buildVariantSummary(it.item_group, it.variants)}`.trim(),
  },
  {
    key: 'description2', label: 'Description 2', width: 220, minWidth: 160,
    accessor: (it) => {
      const summary = buildVariantSummary(it.item_group, it.variants);
      return summary ? <div>{summary}</div> : <span style={{ color: 'var(--fg-muted)' }}>—</span>;
    },
    searchValue: (it) => buildVariantSummary(it.item_group, it.variants),
  },
  {
    key: 'uom', label: 'UOM', width: 70,
    accessor: (it) => it.uom || 'UNIT',
    searchValue: (it) => it.uom || 'UNIT',
  },
  {
    key: 'qty', label: 'Qty', width: 60, align: 'right',
    accessor: (it) => it.qty ?? 0,
    searchValue: (it) => String(it.qty ?? 0),
    sortFn: (a, b) => Number(a.qty ?? 0) - Number(b.qty ?? 0),
  },
  {
    key: 'transfer_to', label: 'Transfer To', width: 130,
    accessor: (it) => {
      const ds = it.downstream ?? [];
      if (ds.length === 0) return <span style={{ color: 'var(--fg-muted)' }}>—</span>;
      return (
        <div>
          {ds.map((d, di) => (
            <div key={di} style={{ fontWeight: 600, color: 'var(--c-burnt)', whiteSpace: 'nowrap' }}>
              {d.docNumber} <span style={{ color: 'var(--fg-muted)', fontWeight: 400 }}>×{d.qty}</span>
            </div>
          ))}
        </div>
      );
    },
    searchValue: (it) => (it.downstream ?? []).map((d) => d.docNumber).join(' '),
  },
  {
    key: 'unit_price', label: 'Unit Price', width: 100, align: 'right',
    accessor: (it) => fmtRm(Number(it.unit_price_centi ?? 0)),
    searchValue: (it) => String(it.unit_price_centi ?? 0),
    sortFn: (a, b) => Number(a.unit_price_centi ?? 0) - Number(b.unit_price_centi ?? 0),
  },
  {
    key: 'total', label: 'Total', width: 100, align: 'right',
    accessor: (it) => <span style={{ fontWeight: 700, color: 'var(--c-burnt)' }}>{fmtRm(doLineTotalOf(it))}</span>,
    searchValue: (it) => String(doLineTotalOf(it)),
    sortFn: (a, b) => doLineTotalOf(a) - doLineTotalOf(b),
  },
  {
    key: 'unit_cost', label: 'Unit Cost', width: 100, align: 'right',
    accessor: (it) => fmtRm(Number(it.unit_cost_centi ?? 0)),
    searchValue: (it) => String(it.unit_cost_centi ?? 0),
    sortFn: (a, b) => Number(a.unit_cost_centi ?? 0) - Number(b.unit_cost_centi ?? 0),
  },
  {
    key: 'line_cost', label: 'Line Cost', width: 100, align: 'right',
    accessor: (it) => fmtRm(doLineCostOf(it)),
    searchValue: (it) => String(doLineCostOf(it)),
    sortFn: (a, b) => doLineCostOf(a) - doLineCostOf(b),
  },
  {
    key: 'margin', label: 'Margin', width: 100, align: 'right',
    accessor: (it) => {
      const m = doLineMarginOf(it);
      const c = m > 0 ? 'var(--c-secondary-a, #2F5D4F)' : m < 0 ? 'var(--c-festive-b, #B8331F)' : 'var(--fg-muted)';
      return <span style={{ color: c, fontWeight: 600 }}>{fmtRm(m)}</span>;
    },
    searchValue: (it) => String(doLineMarginOf(it)),
    sortFn: (a, b) => doLineMarginOf(a) - doLineMarginOf(b),
  },
];

const ExpandedDoLines = ({ id }: { id: string }) => {
  const q = useMfgDeliveryOrderDetail(id);
  if (q.isLoading) {
    return <div style={{ padding: '8px 12px', fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>Loading lines…</div>;
  }
  if (q.error) {
    return (
      <div style={{ padding: '8px 12px', fontSize: 'var(--fs-11)', color: 'var(--c-festive-b, #B8331F)' }}>
        Failed to load lines: {q.error instanceof Error ? q.error.message : String(q.error)}
      </div>
    );
  }
  const items = (q.data?.items ?? []) as DoItem[];
  if (items.length === 0) {
    return <div style={{ padding: '8px 12px', fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>No line items.</div>;
  }
  let totalCenti = 0, costCenti = 0;
  for (const it of items) {
    totalCenti += doLineTotalOf(it);
    costCenti  += Number(it.line_cost_centi ?? 0);
  }
  const marginCenti = totalCenti - costCenti;
  const marginColor = marginCenti > 0 ? 'var(--c-secondary-a, #2F5D4F)'
    : marginCenti < 0 ? 'var(--c-festive-b, #B8331F)' : 'var(--fg-muted)';

  const columns = buildDoDrilldownColumns();

  return (
    <div style={{ padding: 'var(--space-2) var(--space-3) var(--space-2) 40px', background: 'var(--c-cream)' }}>
      <DataGrid<DoItem>
        rows={items}
        columns={columns}
        storageKey="do-drilldown-grid.v1"
        rowKey={(it) => it.id}
        embedded
        groupBanner={false}
      />
      <div style={{
        display: 'flex', gap: 'var(--space-4)', justifyContent: 'flex-end',
        alignItems: 'baseline', padding: '8px 8px 2px',
        fontSize: 'var(--fs-11)', fontVariantNumeric: 'tabular-nums', color: 'var(--fg-muted)',
      }}>
        <span style={{
          fontFamily: 'var(--font-button)', fontSize: 'var(--fs-10)',
          letterSpacing: '0.06em', textTransform: 'uppercase',
        }}>Subtotal</span>
        <span>Total <strong style={{ color: 'var(--c-burnt)' }}>{fmtRm(totalCenti)}</strong></span>
        <span>Line Cost <strong style={{ color: 'var(--c-ink)' }}>{fmtRm(costCenti)}</strong></span>
        <span>Margin <strong style={{ color: marginColor }}>{fmtRm(marginCenti)}</strong></span>
      </div>
    </div>
  );
};


const STORAGE_KEY = 'pr-g.do-list.layout.v1';

export const MfgDeliveryOrdersList = () => {
  const navigate = useNavigate();
  const askConfirm = useConfirm();
  const notify = useNotify();
  const [searchParams, setSearchParams] = useSearchParams();
  const statusChip = searchParams.get('status') ?? 'all';

  const { data, isLoading, error } = useMfgDeliveryOrders(undefined);
  const allRows = useMemo<DoRow[]>(() => (data?.deliveryOrders ?? []) as DoRow[], [data]);

  const setStatusChip = (s: string) => {
    const next = new URLSearchParams(searchParams);
    if (s === 'all') next.delete('status'); else next.set('status', s);
    setSearchParams(next, { replace: true });
  };

  /* The status-chip pre-filter (?status=...) narrows the rows; the DataGrid's
     own per-column funnel filters do the rest on top. */
  const baseRows = useMemo<DoRow[]>(
    () => (statusChip !== 'all'
      ? allRows.filter((r) => doEffectiveKey(r.status, r.lifecycle_state) === statusChip)
      : allRows),
    [allRows, statusChip],
  );
  // DataGrid filters internally now; capture its on-screen rows so the KPI
  // strip reflects the active funnel filters (was the ColumnFilterBar output).
  const [visibleRows, setVisibleRows] = useState<DoRow[]>(baseRows);

  const kpis = useMemo(() => {
    let revenue = 0, cost = 0, margin = 0;
    for (const r of visibleRows) {
      revenue += r.local_total_centi ?? 0;
      cost += r.total_cost_centi ?? 0;
      margin += r.total_margin_centi ?? 0;
    }
    return { totalOrders: visibleRows.length, revenue, cost, margin };
  }, [visibleRows]);

  const staffQ = useStaff();
  const staffById = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of (staffQ.data ?? [])) if (s.id) m.set(s.id, s.name ?? s.staffCode ?? s.id);
    return m;
  }, [staffQ.data]);
  const COLUMNS = useMemo(() => buildColumns(staffById), [staffById]);

  const updateStatus = useUpdateMfgDeliveryOrderStatus();

  const onNew = () => navigate('/scm/delivery-orders/new');
  const openDetail = (row: DoRow, edit = false) =>
    navigate(`/scm/delivery-orders/${row.id}${edit ? '?edit=1' : ''}`);

  const renderPdf = (row: DoRow) => {
    void (async () => {
      // HOUZS VENDOR: repointed off the supabase session token → the vendored
      // authedFetch (→ /api/scm). Same endpoint + shape.
      const json = await authedFetch<{ deliveryOrder: unknown; items: unknown[] }>(`/delivery-orders-mfg/${row.id}`);
      const { generateDeliveryOrderPdf } = await import('../../vendor/scm/lib/delivery-order-pdf');
      await generateDeliveryOrderPdf(json.deliveryOrder as never, json.items as never);
    })().catch((e) => notify({ title: 'PDF failed', body: e instanceof Error ? e.message : String(e), tone: 'error' }));
  };

  const doCancel = async (row: DoRow) => {
    if (!(await askConfirm({ title: `Cancel DO ${row.do_number}?`, body: 'This sets status = CANCELLED.', confirmLabel: 'Cancel', danger: true }))) return;
    updateStatus.mutate({ id: row.id, status: 'CANCELLED' },
      { onError: (e) => notify({ title: 'Failed', body: e instanceof Error ? e.message : String(e), tone: 'error' }) });
  };

  const kpiTile = (label: string, value: string, accent?: 'good' | 'bad' | 'burnt'): JSX.Element => (
    <div key={label} style={{
      background: 'var(--c-paper)', border: '1px solid var(--line)', borderRadius: 'var(--radius-md)',
      padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 2,
    }}>
      <div style={{ fontFamily: 'var(--font-button)', fontSize: 'var(--fs-10)', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--fg-muted)' }}>{label}</div>
      <div style={{
        fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-14)', fontWeight: 700, fontVariantNumeric: 'tabular-nums',
        color: accent === 'good' ? 'var(--c-secondary-a, #2F5D4F)' : accent === 'bad' ? 'var(--c-festive-b, #B8331F)' : accent === 'burnt' ? 'var(--c-burnt)' : 'var(--c-ink)',
      }}>{value}</div>
    </div>
  );

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div>
          <h1 className={styles.title}>Delivery Orders</h1>
        </div>
        <div style={{ display: 'inline-flex', gap: 'var(--space-2)' }}>
          <Button variant="ghost" size="sm" onClick={() => navigate('/scm/delivery-orders/from-so')}>
            <ArrowRightLeft size={14} strokeWidth={1.75} />
            <span>From Sales Order</span>
          </Button>
          <Button variant="primary" size="sm" onClick={onNew}>
            <Plus size={14} strokeWidth={1.75} />
            <span>New Delivery Order</span>
          </Button>
        </div>
      </div>

      {error && !isLoading && (
        <div className={styles.bannerWarn}>
          <strong>Failed to load.</strong>{' '}
          {error instanceof Error ? error.message : String(error)}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 'var(--space-2)' }}>
        {kpiTile('Total DOs', kpis.totalOrders.toLocaleString('en-MY'))}
        {kpiTile('Revenue (RM)', fmtRm(kpis.revenue))}
        {kpiTile('Cost (RM)', fmtRm(kpis.cost))}
        {kpiTile('Margin (RM)', fmtRm(kpis.margin), kpis.margin > 0 ? 'good' : kpis.margin < 0 ? 'bad' : undefined)}
      </div>

      {/* Status chips (kept available per spec). */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {STATUS_CHIPS.map((s) => (
          <button key={s} type="button" onClick={() => setStatusChip(s)}
            style={{
              height: 28, padding: '0 12px', borderRadius: 999, cursor: 'pointer',
              fontSize: 11, fontWeight: 600,
              border: '1px solid ' + (statusChip === s ? 'var(--c-burnt)' : '#DDE5E5'),
              background: statusChip === s ? 'rgba(232, 107, 58, 0.10)' : '#FFFFFF',
              color: statusChip === s ? 'var(--c-burnt)' : 'var(--fg-muted)',
            }}>
            {s === 'all' ? 'All' : STATUS_LABEL[s] ?? s}
          </button>
        ))}
      </div>

      <DataGrid<DoRow>
        rows={baseRows}
        onFilteredRowsChange={setVisibleRows}
        columns={COLUMNS}
        storageKey={STORAGE_KEY}
        rowKey={(r) => r.id}
        searchPlaceholder="Search DOs…"
        groupBanner={false}
        onRowDoubleClick={(r) => openDetail(r)}
        rowStyle={(r) => r.status === 'CANCELLED' ? { opacity: 0.55, filter: 'grayscale(0.6)' } : undefined}
        isLoading={isLoading}
        emptyMessage='No delivery orders yet — click "+ New Delivery Order" to start.'
        expandable={{
          renderExpansion: (row) => <ExpandedDoLines id={row.id} />,
          rowExpansionKey: (row) => row.id,
        }}
        contextMenu={(row) => {
          /* Tier 2 downstream-lock — once any non-cancelled DR / SI references
             this DO, hide Edit + Cancel. Convert-to-SI / Convert-to-DR STAY
             visible (partial flow allowed — multiple DRs / SIs may be issued). */
          const status = row.status;
          const hasChildren = Boolean(row.has_children);
          const items: Array<{ label?: string; onClick?: () => void; danger?: boolean; divider?: true }> = [];
          if (!hasChildren) {
            items.push({ label: 'Edit', onClick: () => openDetail(row, true) });
          }
          items.push({ label: 'View',    onClick: () => openDetail(row) });
          items.push({ label: 'Preview', onClick: () => renderPdf(row) });
          items.push({ label: 'Print',   onClick: () => renderPdf(row) });
          items.push({ divider: true as const });
          /* Commander 2026-05-29 — a DO ships on creation, so the downstream
             converts are available for any non-cancelled DO (no waiting for a
             DELIVERED stage that no longer exists). "Convert to Sales Invoice"
             is wired when the Sales Invoice module lands; "Convert to Delivery
             Return" prefills a new return from this DO. */
          // Commander 2026-05-30 — both converts are ALWAYS shown so the operator
          // never thinks they vanished. A CANCELLED DO has nothing to convert, so
          // clicking then tells them plainly instead of opening an empty form.
          items.push({
            label: 'To Sales Invoice',
            onClick: () => {
              if (status === 'CANCELLED') { notify({ title: 'Nothing to be converted', body: 'this Delivery Order is cancelled.', tone: 'error' }); return; }
              navigate(`/sales-invoices/new?fromDo=${row.id}`);
            },
          });
          items.push({
            label: 'To Delivery Return',
            onClick: () => {
              if (status === 'CANCELLED') { notify({ title: 'Nothing to be converted', body: 'this Delivery Order is cancelled.', tone: 'error' }); return; }
              navigate(`/delivery-returns/new?fromDo=${row.id}`);
            },
          });
          items.push({ divider: true as const });
          if (!['CANCELLED', 'INVOICED'].includes(status) && !hasChildren) {
            items.push({ label: 'Cancel DO', danger: true, onClick: () => doCancel(row) });
          }
          if (status === 'CANCELLED') {
            items.push({
              label: 'Reopen DO',
              onClick: async () => {
                if (!(await askConfirm({ title: `Reopen ${row.do_number} back to LOADED?`, confirmLabel: 'Reopen' }))) return;
                updateStatus.mutate({ id: row.id, status: 'LOADED' });
              },
            });
          }
          return items;
        }}
      />
    </div>
  );
};

/* ── Columns — mirrors the SO list set, adapted to DO fields. ───────────── */
const buildColumns = (staffById: Map<string, string>): DataGridColumn<DoRow>[] => [
  {
    key: 'do_number', label: 'DO No.', width: 150, sortable: true,
    accessor: (r) => (
      <span style={{ fontWeight: 700, color: 'var(--c-burnt)', fontVariantNumeric: 'tabular-nums' }}>{r.do_number}</span>
    ),
    searchValue: (r) => `${r.do_number} ${r.status ?? ''}`,
    filterValue: (r) => r.do_number,
    filterType: 'numbering',
  },
  {
    key: 'so_doc_no', label: 'Transfer From (SO)', width: 130, sortable: true,
    accessor: (r) => r.so_doc_no ?? '—',
    searchValue: (r) => r.so_doc_no ?? '',
    filterType: 'numbering', filterValue: (r) => r.so_doc_no ?? '',
  },
  {
    key: 'do_date', label: 'Date', width: 110, sortable: true,
    accessor: (r) => compactDate(r.do_date),
    searchValue: (r) => `${r.do_date ?? ''} ${compactDate(r.do_date)}`,
    sortFn: (a, b) => (a.do_date ?? '').localeCompare(b.do_date ?? ''),
    filterType: 'date', dateValue: (r) => r.do_date,
  },
  {
    key: 'debtor_name', label: 'Customer', width: 220, sortable: true, groupable: true,
    accessor: (r) => r.debtor_name,
    searchValue: (r) => r.debtor_name,
  },
  {
    key: 'salesperson_id', label: 'Salesperson', width: 140, sortable: true, groupable: true,
    accessor: (r) => (r.salesperson_id ? staffById.get(r.salesperson_id) ?? '—' : '—'),
    searchValue: (r) => (r.salesperson_id ? staffById.get(r.salesperson_id) ?? '' : ''),
    groupValue: (r) => (r.salesperson_id ? staffById.get(r.salesperson_id) ?? '(none)' : '(none)'),
  },
  {
    key: 'sales_location', label: 'Location', width: 100, sortable: true, groupable: true,
    accessor: (r) => r.sales_location ?? '—',
    searchValue: (r) => r.sales_location ?? '',
    groupValue: (r) => r.sales_location ?? '(none)',
  },
  {
    key: 'expected_delivery_at', label: 'Expected', width: 110, sortable: true,
    accessor: (r) => compactDate(r.expected_delivery_at),
    searchValue: (r) => r.expected_delivery_at ?? '',
    sortFn: (a, b) => (a.expected_delivery_at ?? '').localeCompare(b.expected_delivery_at ?? ''),
    filterType: 'date', dateValue: (r) => r.expected_delivery_at,
  },
  {
    key: 'customer_so_no', label: 'Reference', width: 130, sortable: true,
    accessor: (r) => r.customer_so_no ?? r.po_doc_no ?? r.ref ?? '—',
    searchValue: (r) => `${r.customer_so_no ?? ''} ${r.po_doc_no ?? ''} ${r.ref ?? ''}`,
    sortFn: (a, b) =>
      (a.customer_so_no ?? a.po_doc_no ?? a.ref ?? '').localeCompare(b.customer_so_no ?? b.po_doc_no ?? b.ref ?? ''),
  },
  {
    key: 'branding', label: 'Branding', width: 130, sortable: true, groupable: true,
    accessor: (r) => {
      const b = deriveBranding(r);
      return b ? <BrandingPill branding={b} /> : <span style={{ color: 'var(--fg-muted)' }}>—</span>;
    },
    searchValue: (r) => deriveBranding(r),
    groupValue: (r) => deriveBranding(r) || '(none)',
    sortFn: (a, b) => deriveBranding(a).localeCompare(deriveBranding(b)),
  },
  {
    key: 'venue', label: 'Venue', width: 180, sortable: true, groupable: true,
    accessor: (r) => r.venue ?? '—',
    searchValue: (r) => r.venue ?? '',
    groupValue: (r) => r.venue ?? '(none)',
  },
  {
    key: 'driver_name', label: 'Driver', width: 130, sortable: true, groupable: true,
    accessor: (r) => r.driver_name ?? '—',
    searchValue: (r) => r.driver_name ?? '',
    groupValue: (r) => r.driver_name ?? '(none)',
  },
  {
    key: 'local_total_centi', label: 'Local Total', width: 120, sortable: true, align: 'right',
    accessor: (r) => (
      <span style={{ fontWeight: 700, color: 'var(--c-ink)', fontVariantNumeric: 'tabular-nums' }}>{fmtRm(r.local_total_centi)}</span>
    ),
    searchValue: (r) => fmtRm(r.local_total_centi),
    sortFn: (a, b) => a.local_total_centi - b.local_total_centi,
    filterType: 'number', numberValue: (r) => r.local_total_centi,
  },
  {
    key: 'mattress_sofa_centi', label: 'Mattress/Sofa', width: 130, sortable: true, align: 'right',
    accessor: (r) => {
      const v = r.mattress_sofa_centi ?? 0;
      if (v === 0) return <span style={{ color: 'var(--fg-muted)' }}>—</span>;
      return <span style={{ fontWeight: 600, color: badgeFor('sofa').fg, fontVariantNumeric: 'tabular-nums' }}>{fmtRm(v)}</span>;
    },
    searchValue: (r) => fmtRm(r.mattress_sofa_centi ?? 0),
    sortFn: (a, b) => (a.mattress_sofa_centi ?? 0) - (b.mattress_sofa_centi ?? 0),
  },
  {
    key: 'bedframe_centi', label: 'Bedframe', width: 120, sortable: true, align: 'right',
    accessor: (r) => {
      const v = r.bedframe_centi ?? 0;
      if (v === 0) return <span style={{ color: 'var(--fg-muted)' }}>—</span>;
      return <span style={{ fontWeight: 600, color: badgeFor('bedframe').fg, fontVariantNumeric: 'tabular-nums' }}>{fmtRm(v)}</span>;
    },
    searchValue: (r) => fmtRm(r.bedframe_centi ?? 0),
    sortFn: (a, b) => (a.bedframe_centi ?? 0) - (b.bedframe_centi ?? 0),
  },
  {
    key: 'accessories_centi', label: 'Accessories', width: 120, sortable: true, align: 'right',
    accessor: (r) => {
      const v = r.accessories_centi ?? 0;
      if (v === 0) return <span style={{ color: 'var(--fg-muted)' }}>—</span>;
      return <span style={{ fontWeight: 600, color: badgeFor('accessory').fg, fontVariantNumeric: 'tabular-nums' }}>{fmtRm(v)}</span>;
    },
    searchValue: (r) => fmtRm(r.accessories_centi ?? 0),
    sortFn: (a, b) => (a.accessories_centi ?? 0) - (b.accessories_centi ?? 0),
  },
  {
    key: 'phone', label: 'Phone', width: 130, sortable: true,
    accessor: (r) => formatPhone(r.phone) || '',
    searchValue: (r) => `${r.phone ?? ''} ${formatPhone(r.phone) ?? ''}`,
  },
  {
    key: 'address1', label: 'Address 1', width: 180, sortable: true,
    accessor: (r) => r.address1 ?? '',
    searchValue: (r) => r.address1 ?? '',
  },
  {
    key: 'status', label: 'Status', width: 130, sortable: true, groupable: true,
    accessor: (r) => <StatusPill status={r.status} lifecycle={r.lifecycle_state} />,
    searchValue: (r) => STATUS_LABEL[doEffectiveKey(r.status, r.lifecycle_state)] ?? r.status,
    filterValue: (r) => STATUS_LABEL[doEffectiveKey(r.status, r.lifecycle_state)] ?? r.status,
    groupValue: (r) => doEffectiveKey(r.status, r.lifecycle_state),
    sortFn: (a, b) => doEffectiveKey(a.status, a.lifecycle_state).localeCompare(doEffectiveKey(b.status, b.lifecycle_state)),
  },
  /* ── Default-hidden long-tail ── */
  {
    key: 'debtor_code', label: 'Customer Code', width: 120, sortable: true, defaultHidden: true,
    accessor: (r) => r.debtor_code ?? '',
    searchValue: (r) => r.debtor_code ?? '',
  },
  {
    key: 'email', label: 'Email', width: 180, sortable: true, defaultHidden: true,
    accessor: (r) => r.email ?? '',
    searchValue: (r) => r.email ?? '',
  },
  {
    key: 'customer_type', label: 'Customer Type', width: 120, sortable: true, groupable: true, defaultHidden: true,
    accessor: (r) => r.customer_type ?? '',
    searchValue: (r) => r.customer_type ?? '',
  },
  {
    key: 'building_type', label: 'Building Type', width: 120, sortable: true, groupable: true, defaultHidden: true,
    accessor: (r) => r.building_type ?? '',
    searchValue: (r) => r.building_type ?? '',
  },
  {
    key: 'address2', label: 'Address 2', width: 180, sortable: true, defaultHidden: true,
    accessor: (r) => r.address2 ?? '',
    searchValue: (r) => r.address2 ?? '',
  },
  {
    key: 'customer_state', label: 'State', width: 130, sortable: true, groupable: true, defaultHidden: true,
    accessor: (r) => r.customer_state ?? '',
    searchValue: (r) => r.customer_state ?? '',
  },
  {
    key: 'city', label: 'City', width: 130, sortable: true, groupable: true, defaultHidden: true,
    accessor: (r) => r.city ?? '',
    searchValue: (r) => r.city ?? '',
  },
  {
    key: 'postcode', label: 'Postcode', width: 100, sortable: true, defaultHidden: true,
    accessor: (r) => r.postcode ?? '',
    searchValue: (r) => r.postcode ?? '',
  },
  {
    key: 'customer_delivery_date', label: 'Delivery Date', width: 130, sortable: true, defaultHidden: true,
    accessor: (r) => compactDate(r.customer_delivery_date),
    searchValue: (r) => `${r.customer_delivery_date ?? ''} ${compactDate(r.customer_delivery_date)}`,
    filterType: 'date', dateValue: (r) => r.customer_delivery_date,
  },
  {
    key: 'vehicle', label: 'Vehicle', width: 120, sortable: true, defaultHidden: true,
    accessor: (r) => r.vehicle ?? '',
    searchValue: (r) => r.vehicle ?? '',
  },
  {
    key: 'note', label: 'Note', width: 200, sortable: true, defaultHidden: true,
    accessor: (r) => r.note ?? '',
    searchValue: (r) => r.note ?? '',
  },
  {
    key: 'mattress_sofa_cost_centi', label: 'Mattress/Sofa Cost', width: 140, sortable: true, align: 'right', defaultHidden: true,
    accessor: (r) => <span className={styles.money}>{fmtRm(r.mattress_sofa_cost_centi ?? 0)}</span>,
    searchValue: (r) => fmtRm(r.mattress_sofa_cost_centi ?? 0),
    sortFn: (a, b) => (a.mattress_sofa_cost_centi ?? 0) - (b.mattress_sofa_cost_centi ?? 0),
  },
  {
    key: 'bedframe_cost_centi', label: 'Bedframe Cost', width: 130, sortable: true, align: 'right', defaultHidden: true,
    accessor: (r) => <span className={styles.money}>{fmtRm(r.bedframe_cost_centi ?? 0)}</span>,
    searchValue: (r) => fmtRm(r.bedframe_cost_centi ?? 0),
    sortFn: (a, b) => (a.bedframe_cost_centi ?? 0) - (b.bedframe_cost_centi ?? 0),
  },
  {
    key: 'total_cost_centi', label: 'Cost Total', width: 120, sortable: true, align: 'right', defaultHidden: true,
    accessor: (r) => <span className={styles.money}>{fmtRm(r.total_cost_centi ?? 0)}</span>,
    searchValue: (r) => fmtRm(r.total_cost_centi ?? 0),
    sortFn: (a, b) => (a.total_cost_centi ?? 0) - (b.total_cost_centi ?? 0),
  },
  {
    key: 'total_margin_centi', label: 'Margin', width: 120, sortable: true, align: 'right', defaultHidden: true,
    accessor: (r) => {
      const m = r.total_margin_centi ?? 0;
      if ((r.local_total_centi ?? 0) <= 0) return <span style={{ color: 'var(--fg-muted)' }}>—</span>;
      const color = m > 0 ? 'var(--c-secondary-a, #2F5D4F)' : m < 0 ? 'var(--c-festive-b, #B8331F)' : 'var(--fg-muted)';
      return <span className={styles.money} style={{ color, fontWeight: 600 }}>{fmtRm(m)}</span>;
    },
    searchValue: (r) => fmtRm(r.total_margin_centi ?? 0),
    sortFn: (a, b) => (a.total_margin_centi ?? 0) - (b.total_margin_centi ?? 0),
  },
];
