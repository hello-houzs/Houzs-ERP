// ----------------------------------------------------------------------------
// PurchaseInvoicesList — Purchase Invoice (PI) list, cloned from the polished
// Purchase Returns list (PurchaseReturnsList.tsx). Same DataGrid UX:
//   • double-click a row → open the PI detail page
//   • right-click → context menu ("Open")
//
// A Purchase Invoice is born from a Goods Receipt: the user converts a GRN
// (right-click "Convert to PI" on the GRN list, or the "From GRN" button here
// routes to /grns). A manual New Invoice page exists at /purchase-invoices/new.
//
// HOUZS VENDOR — verbatim from apps/backend/src/pages/PurchaseInvoicesList.tsx.
// Import boundary only: react-router → react-router-dom; flow-queries PI hooks →
// vendored purchase-invoice-queries; components/lib → ../../vendor/scm/*;
// internal nav repointed to the parallel /scm/* routes.
// ----------------------------------------------------------------------------

import { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, ArrowRightLeft } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { usePurchaseInvoices, useCancelPurchaseInvoice, usePurchaseInvoiceDetail } from '../../vendor/scm/lib/purchase-invoice-queries';
import { DataGrid, type DataGridColumn } from '../../vendor/scm/components/DataGrid';
import { StatusPill } from '../../vendor/scm/components/StatusPill';
import { statusLabel } from '../../vendor/scm/lib/status-pill';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { fmtDateOrDash, buildVariantSummary } from '@2990s/shared';
import styles from './Suppliers.module.css';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

// purchase_invoice_status enum: POSTED / PARTIALLY_PAID / PAID / CANCELLED.
// Colours + labels come from the canonical lib/status-pill map via <StatusPill>.
const STATUS_CHIPS = ['all', 'POSTED', 'PARTIALLY_PAID', 'PAID', 'CANCELLED'] as const;

const fmtMoney = (centi: number, currency = 'MYR'): string =>
  `${currency} ${(centi / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/* New unique storage key — NEVER reuse the GRN/PR/PO list key. */
const PI_LIST_STORAGE_KEY = 'pi-list.layout.v1';

/* The list endpoint embeds supplier + purchase_order + grn + the header's
   total_centi. Rows stay loosely typed — accessors read by name. */
type PiRow = Record<string, unknown> & {
  id: string;
  invoice_number: string;
  status: string;
  invoice_date: string | null;
  due_date: string | null;
  total_centi?: number;
  paid_centi?: number;
  currency?: string;
  supplier?: { id: string; code: string; name: string } | null;
  purchase_order?: { id: string; po_number: string } | null;
  grn?: { id: string; grn_number: string } | null;
};

const buildPiColumns = (): DataGridColumn<PiRow>[] => [
  {
    key: 'invoice_number', label: 'Invoice No.', width: 150, sortable: true,
    accessor: (r) => <span style={{ fontWeight: 700, color: 'var(--c-burnt)', fontVariantNumeric: 'tabular-nums' }}>{r.invoice_number}</span>,
    searchValue: (r) => r.invoice_number,
    sortFn: (a, b) => a.invoice_number.localeCompare(b.invoice_number),
  },
  {
    key: 'supplier', label: 'Supplier', width: 220, sortable: true, groupable: true,
    accessor: (r) => r.supplier?.name ?? r.supplier?.code ?? '—',
    searchValue: (r) => `${r.supplier?.name ?? ''} ${r.supplier?.code ?? ''}`.trim(),
    groupValue: (r) => r.supplier?.name ?? r.supplier?.code ?? '(none)',
    sortFn: (a, b) =>
      (a.supplier?.name ?? a.supplier?.code ?? '').localeCompare(b.supplier?.name ?? b.supplier?.code ?? ''),
  },
  {
    key: 'source_ref', label: 'Transfer From (GRN/PO)', width: 160, sortable: true, groupable: true,
    accessor: (r) => (
      <span style={{ fontWeight: 700, color: 'var(--c-burnt)', fontVariantNumeric: 'tabular-nums' }}>{r.grn?.grn_number ?? r.purchase_order?.po_number ?? '—'}</span>
    ),
    searchValue: (r) => `${r.grn?.grn_number ?? ''} ${r.purchase_order?.po_number ?? ''}`.trim(),
    groupValue: (r) => r.grn?.grn_number ?? r.purchase_order?.po_number ?? '(none)',
  },
  {
    key: 'invoice_date', label: 'Invoice Date', width: 120, sortable: true,
    accessor: (r) => fmtDateOrDash(r.invoice_date),
    searchValue: (r) => r.invoice_date ?? '',
    sortFn: (a, b) => String(a.invoice_date ?? '').localeCompare(String(b.invoice_date ?? '')),
    filterType: 'date', dateValue: (r) => r.invoice_date,
  },
  {
    key: 'due_date', label: 'Due Date', width: 120, sortable: true,
    accessor: (r) => fmtDateOrDash(r.due_date),
    searchValue: (r) => r.due_date ?? '',
    sortFn: (a, b) => String(a.due_date ?? '').localeCompare(String(b.due_date ?? '')),
    filterType: 'date', dateValue: (r) => r.due_date,
  },
  {
    key: 'total_centi', label: 'Total', width: 130, sortable: true, align: 'right', groupable: false,
    accessor: (r) => (
      <span style={{ fontFamily: 'var(--font-mark)', color: 'var(--c-burnt)', fontWeight: 800 }}>
        {fmtMoney(Number(r.total_centi ?? 0), r.currency)}
      </span>
    ),
    searchValue: (r) => fmtMoney(Number(r.total_centi ?? 0), r.currency),
    sortFn: (a, b) => Number(a.total_centi ?? 0) - Number(b.total_centi ?? 0),
  },
  {
    key: 'status', label: 'Status', width: 130, sortable: true, groupable: true,
    accessor: (r) => <StatusPill docType="pi" status={r.status} />,
    searchValue: (r) => statusLabel('pi', r.status),
    groupValue: (r) => statusLabel('pi', r.status),
    sortFn: (a, b) => a.status.localeCompare(b.status),
  },
];

/* ── Drill-down — per-line breakdown for one PI, mirrors ExpandedPoLines ─── */
type PiItem = Record<string, unknown> & {
  id: string;
  material_code?: string | null;
  material_name?: string | null;
  description?: string | null;
  item_group?: string | null;
  variants?: Record<string, unknown> | null;
  qty?: number | null;
  unit_price_centi?: number | null;
  line_total_centi?: number | null;
};

const buildPiDrilldownColumns = (currency: string): DataGridColumn<PiItem>[] => [
  {
    key: 'item_code', label: 'Item Code', width: 130,
    accessor: (it) => <span style={{ fontWeight: 700, color: 'var(--c-burnt)' }}>{it.material_code ?? '—'}</span>,
    searchValue: (it) => it.material_code ?? '',
    sortFn: (a, b) => (a.material_code ?? '').localeCompare(b.material_code ?? ''),
  },
  {
    key: 'description', label: 'Description', width: 260, minWidth: 180,
    accessor: (it) => (it.description ?? '').trim() || it.material_name || '—',
    searchValue: (it) => `${it.description ?? ''} ${it.material_name ?? ''}`.trim(),
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
    key: 'qty', label: 'Qty', width: 80, align: 'right',
    accessor: (it) => it.qty ?? 0,
    searchValue: (it) => String(it.qty ?? 0),
    sortFn: (a, b) => Number(a.qty ?? 0) - Number(b.qty ?? 0),
  },
  {
    key: 'unit_price', label: 'Unit Price', width: 110, align: 'right',
    accessor: (it) => fmtMoney(Number(it.unit_price_centi ?? 0), currency),
    searchValue: (it) => String(it.unit_price_centi ?? 0),
    sortFn: (a, b) => Number(a.unit_price_centi ?? 0) - Number(b.unit_price_centi ?? 0),
  },
  {
    key: 'line_total', label: 'Line Total', width: 120, align: 'right',
    accessor: (it) => <span style={{ fontWeight: 700, color: 'var(--c-burnt)' }}>{fmtMoney(Number(it.line_total_centi ?? 0), currency)}</span>,
    searchValue: (it) => String(it.line_total_centi ?? 0),
    sortFn: (a, b) => Number(a.line_total_centi ?? 0) - Number(b.line_total_centi ?? 0),
  },
];

const ExpandedPiLines = ({ pi }: { pi: PiRow }) => {
  const detail = usePurchaseInvoiceDetail(pi.id);
  const currency = pi.currency ?? 'MYR';

  if (detail.isLoading) {
    return <div style={{ padding: '8px 12px', fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>Loading lines…</div>;
  }
  if (detail.error) {
    return (
      <div style={{ padding: '8px 12px', fontSize: 'var(--fs-11)', color: 'var(--c-festive-b, #B8331F)' }}>
        Failed to load lines: {detail.error instanceof Error ? detail.error.message : String(detail.error)}
      </div>
    );
  }
  const items = (detail.data?.items ?? []) as PiItem[];
  if (items.length === 0) {
    return <div style={{ padding: '8px 12px', fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>No line items.</div>;
  }
  let subtotal = 0;
  for (const it of items) subtotal += Number(it.line_total_centi ?? 0);

  const columns = buildPiDrilldownColumns(currency);

  return (
    <div style={{ padding: 'var(--space-2) var(--space-3) var(--space-3) 40px', background: 'var(--c-cream)' }}>
      <DataGrid<PiItem>
        rows={items}
        columns={columns}
        storageKey="pi-drilldown-grid.v1"
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
        <span>Total <strong style={{ color: 'var(--c-burnt)' }}>{fmtMoney(subtotal, currency)}</strong></span>
      </div>
    </div>
  );
};

export const PurchaseInvoices = () => {
  const navigate = useNavigate();
  const askConfirm = useConfirm();
  const notify = useNotify();
  const [searchParams, setSearchParams] = useSearchParams();
  const statusChip = searchParams.get('status') ?? 'all';
  const setStatusChip = (s: string) => {
    const next = new URLSearchParams(searchParams);
    if (s === 'all') next.delete('status'); else next.set('status', s);
    setSearchParams(next, { replace: true });
  };

  const { data, isLoading, error } = usePurchaseInvoices();
  const cancelPi = useCancelPurchaseInvoice();

  const allRows = useMemo<PiRow[]>(() => (data?.purchaseInvoices ?? []) as PiRow[], [data]);
  const rows = useMemo<PiRow[]>(
    () => (statusChip === 'all' ? allRows : allRows.filter((r) => r.status === statusChip)),
    [allRows, statusChip],
  );
  const columns = useMemo(() => buildPiColumns(), []);

  // Cancel a PI (right-click) — flips status → CANCELLED (PI is AP-only, no
  // inventory). Confirm first; the endpoint blocks a PAID invoice.
  const doCancelPi = async (r: PiRow) => {
    if (!(await askConfirm({ title: `Cancel invoice ${r.invoice_number}?`, body: 'This sets status to CANCELLED — line items stay for audit.', confirmLabel: 'Cancel', danger: true }))) return;
    cancelPi.mutate(r.id, {
      onError: (e) => notify({ title: 'Cancel failed', body: `${e instanceof Error ? e.message : String(e)}`, tone: 'error' }),
    });
  };

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div>
          <h1 className={styles.title}>Purchase Invoices</h1>
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          {/* A Purchase Invoice starts from a Goods Receipt — this routes to the
              GRN list where the user right-clicks "Convert to PI". */}
          <Button variant="ghost" size="sm" onClick={() => navigate('/scm/grns')}>
            <ArrowRightLeft {...ICON} />
            <span>From Goods Receipt</span>
          </Button>
          <Button variant="primary" size="sm" onClick={() => navigate('/scm/purchase-invoices/new')}>
            <Plus {...ICON} />
            <span>New Purchase Invoice</span>
          </Button>
        </div>
      </div>

      <p className={styles.eyebrow}>
        {isLoading ? 'Loading invoices…' : `${rows.length} purchase invoices`}
      </p>

      {error && !isLoading && (
        <div className={styles.bannerWarn}>
          <strong>Failed to load purchase invoices.</strong>{' '}
          {error instanceof Error ? error.message : String(error)}
        </div>
      )}

      {/* Status chips — matches the DR / SI list filter style. */}
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
            {s === 'all' ? 'All' : statusLabel('pi', s)}
          </button>
        ))}
      </div>

      <DataGrid<PiRow>
        rows={rows}
        columns={columns}
        storageKey={PI_LIST_STORAGE_KEY}
        rowKey={(r) => r.id}
        searchPlaceholder="Search invoices…"
        groupBanner={false}
        /* Open on DOUBLE-click; right-click → context menu (mirrors the GRN/PR list). */
        onRowDoubleClick={(r) => navigate(`/scm/purchase-invoices/${r.id}`)}
        /* Cancelled invoices grey out so they read as locked / void. */
        rowStyle={(r) => r.status === 'CANCELLED'
          ? { opacity: 0.6, filter: 'grayscale(0.4)' }
          : undefined}
        /* Click a row → reveal full line-item detail (mirrors the PO list). */
        expandable={{
          renderExpansion: (r) => <ExpandedPiLines pi={r} />,
          rowExpansionKey: (r) => r.id,
        }}
        contextMenu={(r) => {
          // Unified edit-lock (migration 0106): a PI is read-only once it has any
          // payment (paid_centi > 0) or is CANCELLED. Edit + Cancel are HIDDEN
          // when not eligible. View always available.
          const locked = r.status === 'CANCELLED' || (r.paid_centi ?? 0) > 0;
          const menu: Array<{ label?: string; onClick?: () => void; danger?: boolean; divider?: true }> = [
            { label: 'View', onClick: () => navigate(`/scm/purchase-invoices/${r.id}`) },
          ];
          if (!locked) {
            menu.push({ label: 'Edit', onClick: () => navigate(`/scm/purchase-invoices/${r.id}?edit=1`) });
            menu.push({ divider: true as const });
            menu.push({ label: 'Cancel', danger: true, onClick: () => doCancelPi(r) });
          }
          return menu;
        }}
        isLoading={isLoading}
        emptyMessage='No invoices yet — convert a Goods Receipt via "From Goods Receipt".'
      />
    </div>
  );
};
