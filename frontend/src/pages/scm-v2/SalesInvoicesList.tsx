// Sales Invoices list — DataGrid clone of the Delivery Orders list
// (MfgDeliveryOrdersList.tsx, itself an SO-list clone). Same chrome: 4 KPI
// tiles, shared ColumnFilterBar (quick search + add-a-column filters),
// status chips, visible/hidden column set, right-click context menu,
// click-to-expand line drill-down, and double-click-to-open. Wired to the
// SI list hook + the rebuilt SI API. Primary entry to create is "Convert
// From DO" (the picker), with a standalone "New" alongside it (matching
// the PO list's From-SO + New).
//
// UNIQUE localStorage keys ('pr-g.si-list.layout.v1' /
// 'pr-g.si-list.filters.v1') — never reuse the DO/SO keys.

import { useMemo, useState } from 'react';
import type { JSX } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, ArrowRightLeft, Printer } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { DataGrid, type DataGridColumn } from '../../vendor/scm/components/DataGrid';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useChoice } from '../../vendor/scm/components/ChoiceDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { formatPhone } from '@2990s/shared/phone';
import { buildVariantSummary, fmtQty } from '@2990s/shared';
import {
  useSalesInvoices, useUpdateSalesInvoiceStatus, useSalesInvoiceDetail,
} from '../../vendor/scm/lib/sales-invoice-queries';
import { useStaff } from '../../vendor/scm/lib/admin-queries';
import { authedFetch } from '../../vendor/scm/lib/authed-fetch';
import { BrandingPill, badgeFor } from '../../vendor/scm/lib/category-badges';
import styles from './MfgSalesOrdersList.module.css';
import soDetailStyles from './SalesOrderDetail.module.css';

/* ── Row shape (SI header) ─────────────────────────────────────────────── */
type SiRow = {
  id: string;
  invoice_number: string;
  so_doc_no: string | null;
  delivery_order_id: string | null;
  invoice_date: string;
  due_date: string | null;
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
  local_total_centi: number;
  total_centi: number;
  paid_centi: number;
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
};

const fmtRm = (centi: number): string =>
  (centi / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const compactDate = (iso: string | null | undefined): string => {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${m[1]}/${m[2]}/${m[3]}`;
};

/* SI status flow (kept simple, like the DO): SENT (issued) → PARTIALLY_PAID →
   PAID, plus CANCELLED. Pill styling reuses the SO detail status classes where
   they line up; the rest fall back to a neutral pill. */
const STATUS_CLASS: Record<string, string> = {
  DRAFT:          soDetailStyles.statusDraft ?? '',
  SENT:           soDetailStyles.statusShipped ?? '',
  PARTIALLY_PAID: soDetailStyles.statusInProd ?? '',
  PAID:           soDetailStyles.statusDelivered ?? '',
  OVERDUE:        soDetailStyles.statusCancelled ?? '',
  CANCELLED:      soDetailStyles.statusCancelled ?? '',
};
const STATUS_LABEL: Record<string, string> = {
  DRAFT:          'Draft',
  SENT:           'Issued',
  PARTIALLY_PAID: 'Partially Paid',
  PAID:           'Paid',
  OVERDUE:        'Overdue',
  CANCELLED:      'Cancelled',
};
const STATUS_CHIPS = ['all', 'DRAFT', 'SENT', 'PARTIALLY_PAID', 'PAID', 'CANCELLED'] as const;

const StatusPill = ({ status }: { status: string }) => (
  <span className={`${soDetailStyles.statusPill} ${STATUS_CLASS[status] ?? ''}`}>
    {STATUS_LABEL[status] ?? status.replace(/_/g, ' ')}
  </span>
);

/* Branding follows the SI header (carried from the DO). */
const deriveBranding = (r: SiRow): string => r.branding ?? '';

/* ── Drilldown — per-line breakdown for one SI, mirrors ExpandedDoLines ─── */
type SiItem = {
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
const siLineTotalOf = (it: SiItem): number => Number(it.line_total_centi ?? 0);
const siLineCostOf = (it: SiItem): number =>
  it.line_cost_centi != null
    ? Number(it.line_cost_centi)
    : Number(it.qty ?? 0) * Number(it.unit_cost_centi ?? 0);
const siLineMarginOf = (it: SiItem): number =>
  it.line_margin_centi != null
    ? Number(it.line_margin_centi)
    : siLineTotalOf(it) - siLineCostOf(it);

/* Drill-down columns — display-only DataGridColumn specs so the SI drill-down
   gets the SAME add/remove · drag-reorder · resize · right-click as the main
   list grids (it used to be a hand-built fixed <table>). Shared layout key
   so the operator's column prefs persist across every SI they expand. */
const buildSiDrilldownColumns = (): DataGridColumn<SiItem>[] => [
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
    key: 'unit_price', label: 'Unit Price', width: 100, align: 'right',
    accessor: (it) => fmtRm(Number(it.unit_price_centi ?? 0)),
    searchValue: (it) => String(it.unit_price_centi ?? 0),
    sortFn: (a, b) => Number(a.unit_price_centi ?? 0) - Number(b.unit_price_centi ?? 0),
  },
  {
    key: 'total', label: 'Total', width: 100, align: 'right',
    accessor: (it) => <span style={{ fontWeight: 700, color: 'var(--c-burnt)' }}>{fmtRm(siLineTotalOf(it))}</span>,
    searchValue: (it) => String(siLineTotalOf(it)),
    sortFn: (a, b) => siLineTotalOf(a) - siLineTotalOf(b),
  },
  {
    key: 'unit_cost', label: 'Unit Cost', width: 100, align: 'right',
    accessor: (it) => fmtRm(Number(it.unit_cost_centi ?? 0)),
    searchValue: (it) => String(it.unit_cost_centi ?? 0),
    sortFn: (a, b) => Number(a.unit_cost_centi ?? 0) - Number(b.unit_cost_centi ?? 0),
  },
  {
    key: 'line_cost', label: 'Line Cost', width: 100, align: 'right',
    accessor: (it) => fmtRm(siLineCostOf(it)),
    searchValue: (it) => String(siLineCostOf(it)),
    sortFn: (a, b) => siLineCostOf(a) - siLineCostOf(b),
  },
  {
    key: 'margin', label: 'Margin', width: 100, align: 'right',
    accessor: (it) => {
      const m = siLineMarginOf(it);
      const c = m > 0 ? 'var(--c-secondary-a, #2F5D4F)' : m < 0 ? 'var(--c-festive-b, #B8331F)' : 'var(--fg-muted)';
      return <span style={{ color: c, fontWeight: 600 }}>{fmtRm(m)}</span>;
    },
    searchValue: (it) => String(siLineMarginOf(it)),
    sortFn: (a, b) => siLineMarginOf(a) - siLineMarginOf(b),
  },
];

const ExpandedSiLines = ({ id }: { id: string }) => {
  const q = useSalesInvoiceDetail(id);
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
  const items = (q.data?.items ?? []) as SiItem[];
  if (items.length === 0) {
    return <div style={{ padding: '8px 12px', fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>No line items.</div>;
  }
  let totalCenti = 0, costCenti = 0;
  for (const it of items) {
    totalCenti += siLineTotalOf(it);
    costCenti  += Number(it.line_cost_centi ?? 0);
  }
  const marginCenti = totalCenti - costCenti;
  const marginColor = marginCenti > 0 ? 'var(--c-secondary-a, #2F5D4F)'
    : marginCenti < 0 ? 'var(--c-festive-b, #B8331F)' : 'var(--fg-muted)';

  const columns = buildSiDrilldownColumns();

  return (
    <div style={{ padding: 'var(--space-2) var(--space-3) var(--space-2) 40px', background: 'var(--c-cream)' }}>
      <DataGrid<SiItem>
        rows={items}
        columns={columns}
        storageKey="si-drilldown-grid.v1"
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

const STORAGE_KEY = 'pr-g.si-list.layout.v1';

export const SalesInvoicesList = () => {
  const navigate = useNavigate();
  const askConfirm = useConfirm();
  const askChoice = useChoice();
  const notify = useNotify();
  const [searchParams, setSearchParams] = useSearchParams();
  const statusChip = searchParams.get('status') ?? 'all';

  /* Multi-select + batch "Export PDF" — the operator filters/searches, ticks
     rows, then downloads them as one combined file or separate per-invoice files. */
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);

  const { data, isLoading, error } = useSalesInvoices(undefined);
  const allRows = useMemo<SiRow[]>(() => (data?.salesInvoices ?? []) as SiRow[], [data]);

  const setStatusChip = (s: string) => {
    const next = new URLSearchParams(searchParams);
    if (s === 'all') next.delete('status'); else next.set('status', s);
    setSearchParams(next, { replace: true });
  };

  /* The status-chip pre-filter (?status=…) narrows the rows; the DataGrid's
     own per-column funnel filters do the rest on top. */
  const baseRows = useMemo<SiRow[]>(
    () => (statusChip !== 'all' ? allRows.filter((r) => r.status === statusChip) : allRows),
    [allRows, statusChip],
  );
  // DataGrid filters internally now; capture its on-screen rows so the KPI
  // strip reflects the active funnel filters (was the ColumnFilterBar output).
  const [visibleRows, setVisibleRows] = useState<SiRow[]>(baseRows);

  const localTotal = (r: SiRow) => r.local_total_centi || r.total_centi || 0;

  const kpis = useMemo(() => {
    let revenue = 0, cost = 0, margin = 0, outstanding = 0;
    for (const r of visibleRows) {
      /* LEAK GUARD (DRAFT) — a DRAFT invoice has posted no revenue/AR, so it must
         not feed the Revenue / Cost / Margin / Outstanding tiles (it is still
         counted in Total Invoices so the operator can see drafts exist). */
      if (r.status === 'DRAFT') continue;
      revenue += localTotal(r);
      cost += r.total_cost_centi ?? 0;
      margin += r.total_margin_centi ?? 0;
      if (r.status !== 'CANCELLED') outstanding += Math.max(0, (r.total_centi ?? localTotal(r)) - (r.paid_centi ?? 0));
    }
    return { totalInvoices: visibleRows.length, revenue, cost, margin, outstanding };
  }, [visibleRows]);

  const staffQ = useStaff();
  const staffById = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of (staffQ.data ?? [])) if (s.id) m.set(s.id, s.name ?? s.staffCode ?? s.id);
    return m;
  }, [staffQ.data]);
  const COLUMNS = useMemo(() => buildColumns(staffById), [staffById]);

  const updateStatus = useUpdateSalesInvoiceStatus();

  const onConvertFromDo = () => navigate('/scm/sales-invoices/from-do');
  const onNew = () => navigate('/scm/sales-invoices/new');
  const openDetail = (row: SiRow, edit = false) =>
    navigate(`/scm/sales-invoices/${row.id}${edit ? '?edit=1' : ''}`);

  /* Fetch ONE invoice's full detail (header + lines) for the PDF generator.
     Shared by the single-row Preview/Print and the batch Export PDF.
     HOUZS VENDOR: the read is repointed off the supabase session → the
     vendored authedFetch (→ /api/scm). Same endpoint + shape. */
  const fetchSiBundle = async (row: SiRow): Promise<{ header: unknown; items: unknown[] }> => {
    const json = await authedFetch<{ salesInvoice: unknown; items: unknown[] }>(`/sales-invoices/${row.id}`);
    return { header: json.salesInvoice, items: json.items };
  };

  const renderPdf = (row: SiRow) => {
    void (async () => {
      const bundle = await fetchSiBundle(row);
      const { generateSalesInvoicePdf } = await import('../../vendor/scm/lib/sales-invoice-pdf');
      await generateSalesInvoicePdf(bundle.header as never, bundle.items as never);
    })().catch((e) => notify({ title: 'PDF failed', body: e instanceof Error ? e.message : String(e), tone: 'error' }));
  };

  /* Batch "Export PDF" — one combined file (each invoice a page) or N separate
     files. >1 row asks how; a single row goes straight to its own file. */
  const exportSelected = async () => {
    const rows = baseRows.filter((r) => sel.has(r.id));
    if (rows.length === 0 || exporting) return;
    try {
      if (rows.length === 1) {
        const bundle = await fetchSiBundle(rows[0]!);
        const { generateSalesInvoicePdf } = await import('../../vendor/scm/lib/sales-invoice-pdf');
        await generateSalesInvoicePdf(bundle.header as never, bundle.items as never);
        return;
      }
      const how = await askChoice({
        title: `Download ${rows.length} documents`,
        options: [
          { value: 'one', label: 'One combined PDF' },
          { value: 'many', label: 'Separate files', detail: 'One PDF per document' },
        ],
      });
      if (how == null) return;
      setExporting(true);
      const bundles: Array<{ header: unknown; items: unknown[] }> = [];
      for (const row of rows) bundles.push(await fetchSiBundle(row));
      if (how === 'one') {
        const { generateCombinedSalesInvoicePdf } = await import('../../vendor/scm/lib/sales-invoice-pdf');
        await generateCombinedSalesInvoicePdf(
          bundles as never,
          { fileName: `sales-invoices-${new Date().toISOString().slice(0, 10)}.pdf` },
        );
      } else {
        const { generateSalesInvoicePdf } = await import('../../vendor/scm/lib/sales-invoice-pdf');
        for (const b of bundles) await generateSalesInvoicePdf(b.header as never, b.items as never);
      }
    } catch (e) {
      notify({ title: 'PDF generation failed', body: e instanceof Error ? e.message : String(e), tone: 'error' });
    } finally {
      setExporting(false);
    }
  };

  const doCancel = async (row: SiRow) => {
    if (!(await askConfirm({ title: `Cancel invoice ${row.invoice_number}?`, body: 'This sets status = CANCELLED.', confirmLabel: 'Cancel', danger: true }))) return;
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
          <h1 className={styles.title}>Sales Invoices</h1>
        </div>
        <div style={{ display: 'inline-flex', gap: 'var(--space-2)' }}>
          <Button variant="ghost" size="sm" onClick={onConvertFromDo}>
            <ArrowRightLeft size={14} strokeWidth={1.75} />
            <span>From Delivery Order</span>
          </Button>
          <Button variant="primary" size="sm" onClick={onNew}>
            <Plus size={14} strokeWidth={1.75} />
            <span>New Sales Invoice</span>
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
        {kpiTile('Total Invoices', fmtQty(kpis.totalInvoices))}
        {kpiTile('Revenue (RM)', fmtRm(kpis.revenue))}
        {kpiTile('Outstanding (RM)', fmtRm(kpis.outstanding), kpis.outstanding > 0 ? 'bad' : 'good')}
        {kpiTile('Margin (RM)', fmtRm(kpis.margin), kpis.margin > 0 ? 'good' : kpis.margin < 0 ? 'bad' : undefined)}
      </div>

      {/* Status chips. */}
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

      {/* Batch action bar — shown only when rows are ticked. */}
      {sel.size > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          background: 'rgba(232,107,58,0.08)', border: '1px solid var(--c-orange)',
          borderRadius: 'var(--radius-md)', padding: 'var(--space-3) var(--space-4)', gap: 'var(--space-3)',
        }}>
          <span style={{ fontWeight: 600, color: 'var(--c-burnt)' }}>{sel.size} selected</span>
          <div style={{ display: 'inline-flex', gap: 'var(--space-2)' }}>
            <Button variant="ghost" size="sm" onClick={() => setSel(new Set())}>
              <span>Clear</span>
            </Button>
            <Button variant="ghost" size="sm" disabled={exporting} onClick={() => void exportSelected()}>
              <Printer size={14} strokeWidth={1.75} />
              <span>{exporting ? 'Preparing…' : `Export PDF (${sel.size})`}</span>
            </Button>
          </div>
        </div>
      )}

      <DataGrid<SiRow>
        rows={baseRows}
        onFilteredRowsChange={setVisibleRows}
        columns={COLUMNS}
        storageKey={STORAGE_KEY}
        exportName="Sales Invoices"
        rowKey={(r) => r.id}
        selectable={{
          selectedKeys: sel,
          onToggle: (k) => setSel((p) => {
            const n = new Set(p);
            if (n.has(k)) n.delete(k); else n.add(k);
            return n;
          }),
          onToggleAll: (keys, allSel) => setSel((p) => {
            const n = new Set(p);
            if (allSel) { for (const k of keys) n.delete(k); }
            else { for (const k of keys) n.add(k); }
            return n;
          }),
        }}
        searchPlaceholder="Search invoices…"
        groupBanner={false}
        onRowDoubleClick={(r) => openDetail(r)}
        rowStyle={(r) => r.status === 'CANCELLED' ? { opacity: 0.55, filter: 'grayscale(0.6)' } : undefined}
        isLoading={isLoading}
        emptyMessage='No sales invoices yet — click "From Delivery Order" to convert one.'
        expandable={{
          renderExpansion: (row) => <ExpandedSiLines id={row.id} />,
          rowExpansionKey: (row) => row.id,
        }}
        contextMenu={(row) => {
          const status = row.status;
          const items: Array<{ label?: string; onClick?: () => void; danger?: boolean; divider?: true }> = [
            { label: 'Edit',    onClick: () => openDetail(row, true) },
            { label: 'View',    onClick: () => openDetail(row) },
            { label: 'Preview', onClick: () => renderPdf(row) },
            { label: 'Print',   onClick: () => renderPdf(row) },
            { divider: true as const },
          ];
          if (status !== 'CANCELLED') {
            items.push({ label: 'Cancel Invoice', danger: true, onClick: () => doCancel(row) });
          }
          if (status === 'CANCELLED') {
            items.push({
              label: 'Reopen Invoice',
              onClick: async () => {
                if (!(await askConfirm({ title: `Reopen ${row.invoice_number} back to Issued?`, confirmLabel: 'Reopen' }))) return;
                updateStatus.mutate({ id: row.id, status: 'SENT' });
              },
            });
          }
          return items;
        }}
      />
    </div>
  );
};

/* ── Columns — mirrors the DO list set, adapted to SI fields. ───────────── */
const buildColumns = (staffById: Map<string, string>): DataGridColumn<SiRow>[] => [
  {
    /* Status pill is shown in the dedicated Status column further right —
       don't duplicate it here (Wei Siang 2026-05-30). */
    key: 'invoice_number', label: 'Invoice No.', width: 140, sortable: true,
    accessor: (r) => (
      <span style={{ fontWeight: 700, color: 'var(--c-burnt)', fontVariantNumeric: 'tabular-nums' }}>{r.invoice_number}</span>
    ),
    searchValue: (r) => `${r.invoice_number} ${r.status ?? ''}`,
    filterValue: (r) => r.invoice_number,
    filterType: 'numbering',
  },
  {
    key: 'so_doc_no', label: 'Transfer From (SO)', width: 130, sortable: true,
    accessor: (r) => r.so_doc_no ?? '—',
    searchValue: (r) => r.so_doc_no ?? '',
  },
  {
    key: 'invoice_date', label: 'Invoice Date', width: 120, sortable: true,
    accessor: (r) => compactDate(r.invoice_date),
    searchValue: (r) => `${r.invoice_date ?? ''} ${compactDate(r.invoice_date)}`,
    sortFn: (a, b) => (a.invoice_date ?? '').localeCompare(b.invoice_date ?? ''),
    filterType: 'date', dateValue: (r) => r.invoice_date,
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
    key: 'due_date', label: 'Due', width: 110, sortable: true,
    accessor: (r) => compactDate(r.due_date),
    searchValue: (r) => r.due_date ?? '',
    sortFn: (a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? ''),
    filterType: 'date', dateValue: (r) => r.due_date,
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
    exportValue: (r) => deriveBranding(r),
  },
  {
    key: 'venue', label: 'Venue', width: 180, sortable: true, groupable: true,
    accessor: (r) => r.venue ?? '—',
    searchValue: (r) => r.venue ?? '',
    groupValue: (r) => r.venue ?? '(none)',
  },
  {
    key: 'local_total_centi', label: 'Invoice Total', width: 120, sortable: true, align: 'right',
    accessor: (r) => (
      <span style={{ fontWeight: 700, color: 'var(--c-ink)', fontVariantNumeric: 'tabular-nums' }}>{fmtRm(r.local_total_centi || r.total_centi || 0)}</span>
    ),
    searchValue: (r) => fmtRm(r.local_total_centi || r.total_centi || 0),
    sortFn: (a, b) => (a.local_total_centi || a.total_centi || 0) - (b.local_total_centi || b.total_centi || 0),
    filterType: 'number', numberValue: (r) => r.local_total_centi || r.total_centi || 0,
    exportValue: (r) => (r.local_total_centi || r.total_centi || 0) / 100,
  },
  {
    key: 'paid_centi', label: 'Paid', width: 110, sortable: true, align: 'right',
    accessor: (r) => {
      const v = r.paid_centi ?? 0;
      if (v === 0) return <span style={{ color: 'var(--fg-muted)' }}>—</span>;
      return <span style={{ fontWeight: 600, color: 'var(--c-secondary-a, #2F5D4F)', fontVariantNumeric: 'tabular-nums' }}>{fmtRm(v)}</span>;
    },
    searchValue: (r) => fmtRm(r.paid_centi ?? 0),
    sortFn: (a, b) => (a.paid_centi ?? 0) - (b.paid_centi ?? 0),
    exportValue: (r) => (r.paid_centi ?? 0) / 100,
  },
  {
    key: 'outstanding', label: 'Outstanding', width: 120, sortable: true, align: 'right',
    accessor: (r) => {
      const out = Math.max(0, (r.total_centi ?? (r.local_total_centi || 0)) - (r.paid_centi ?? 0));
      if (out === 0) return <span style={{ color: 'var(--fg-muted)' }}>—</span>;
      return <span style={{ fontWeight: 600, color: 'var(--c-festive-b, #B8331F)', fontVariantNumeric: 'tabular-nums' }}>{fmtRm(out)}</span>;
    },
    searchValue: (r) => fmtRm(Math.max(0, (r.total_centi ?? 0) - (r.paid_centi ?? 0))),
    sortFn: (a, b) =>
      Math.max(0, (a.total_centi ?? 0) - (a.paid_centi ?? 0)) - Math.max(0, (b.total_centi ?? 0) - (b.paid_centi ?? 0)),
    exportValue: (r) => Math.max(0, (r.total_centi ?? (r.local_total_centi || 0)) - (r.paid_centi ?? 0)) / 100,
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
    exportValue: (r) => (r.mattress_sofa_centi ?? 0) / 100,
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
    exportValue: (r) => (r.bedframe_centi ?? 0) / 100,
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
    exportValue: (r) => (r.accessories_centi ?? 0) / 100,
  },
  {
    key: 'phone', label: 'Phone', width: 130, sortable: true,
    accessor: (r) => formatPhone(r.phone) || '',
    searchValue: (r) => `${r.phone ?? ''} ${formatPhone(r.phone) ?? ''}`,
  },
  {
    key: 'status', label: 'Status', width: 140, sortable: true, groupable: true,
    accessor: (r) => <StatusPill status={r.status} />,
    searchValue: (r) => r.status,
    groupValue: (r) => r.status,
    sortFn: (a, b) => a.status.localeCompare(b.status),
    exportValue: (r) => STATUS_LABEL[r.status] ?? r.status.replace(/_/g, ' '),
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
    key: 'address1', label: 'Address 1', width: 180, sortable: true, defaultHidden: true,
    accessor: (r) => r.address1 ?? '',
    searchValue: (r) => r.address1 ?? '',
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
    key: 'note', label: 'Note', width: 200, sortable: true, defaultHidden: true,
    accessor: (r) => r.note ?? '',
    searchValue: (r) => r.note ?? '',
  },
  {
    key: 'total_cost_centi', label: 'Cost Total', width: 120, sortable: true, align: 'right', defaultHidden: true,
    accessor: (r) => <span className={styles.money}>{fmtRm(r.total_cost_centi ?? 0)}</span>,
    searchValue: (r) => fmtRm(r.total_cost_centi ?? 0),
    sortFn: (a, b) => (a.total_cost_centi ?? 0) - (b.total_cost_centi ?? 0),
    exportValue: (r) => (r.total_cost_centi ?? 0) / 100,
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
    exportValue: (r) => ((r.local_total_centi ?? 0) <= 0 ? '' : (r.total_margin_centi ?? 0) / 100),
  },
];
