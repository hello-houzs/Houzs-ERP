// ----------------------------------------------------------------------------
// Purchase Orders (manufacturer-side).
//
// 简洁版第一版:
//   - List 所有 PO,按 status 过滤
//   - "New PO" → 选 supplier → 列出 supplier 的 bindings → 给每条填 qty →
//     POST /mfg-purchase-orders
//   - 列表行点击 → 显示 PO detail(items + 状态 actions: Submit/Cancel)
//
// 没做(后续):GRN 收货、3-way match、PDF 打印、邮件发送。
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, X, FileText, Printer, ArrowRightLeft, ChevronsDownUp } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { buildVariantSummary, fmtDateOrDash } from '@2990s/shared';
import {
  usePurchaseOrders,
  usePurchaseOrderDetail,
  fetchPurchaseOrderDetail,
  useCancelPurchaseOrder,
  useReopenPurchaseOrder,
  type PoStatus,
  type PoHeaderRow,
  type PoItemRow,
  type Currency,
} from '../../vendor/scm/lib/suppliers-queries';
import { useWarehouses } from '../../vendor/scm/lib/inventory-queries';
import { poStatusLabel } from '../../vendor/scm/lib/po-status';
import { ItemGroupPill } from '../../vendor/scm/lib/category-badges';
import { DataGrid, type DataGridColumn } from '../../vendor/scm/components/DataGrid';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import styles from './Suppliers.module.css';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

// PR — Commander 2026-05-27: filter pills collapsed from 6 → 2. The buyer's
// 95% view is "what still has stuff coming in" (Outstanding), so default to
// that. "All" stays as the escape hatch when chasing closed/cancelled history.
// Outstanding = SUBMITTED ∪ PARTIALLY_RECEIVED. Filtered client-side since the
// API supports only one status at a time.
// Draft/Confirmed two-state — a third "Draft" tab surfaces uncommitted POs
// (status DRAFT). Outstanding stays the default 95% view (committed POs still
// inbound); Draft is the review queue; All is the escape hatch.
type StatusFilter = 'all' | 'outstanding' | 'draft';
const STATUS_CHIPS: { value: StatusFilter; label: string }[] = [
  { value: 'outstanding', label: 'Outstanding' },
  { value: 'draft', label: 'Draft' },
  { value: 'all', label: 'All' },
];

// Lifecycle palette shared with every other module (see SalesOrderDetail.module.css):
// active = burnt · in-progress = darker burnt · complete = green · cancelled = red.
// Keeps the PO list pill colours identical to the PO detail page.
const STATUS_COLOR: Record<PoStatus, string> = {
  // Draft/Confirmed — muted neutral so a draft reads as "not yet live".
  DRAFT: 'rgba(120, 113, 108, 0.14)',
  SUBMITTED: 'rgba(166, 71, 30, 0.12)',
  PARTIALLY_RECEIVED: 'rgba(166, 71, 30, 0.18)',
  RECEIVED: 'rgba(47, 93, 79, 0.28)',
  CANCELLED: 'rgba(184, 51, 31, 0.10)',
};

const fmtMoney = (centi: number, currency: Currency): string =>
  `${currency} ${(centi / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** PR — Commander 2026-05-27: per-row items preview, AutoCount style. Shows
    first 3 items as `CODE×qty · CODE×qty · +N more`. Returns null when the
    PO has no items so caller can render the muted "—". */
const summarizeItems = (items: PoHeaderRow['items']): string | null => {
  if (!items || items.length === 0) return null;
  const HEAD = 3;
  const shown = items.slice(0, HEAD)
    .map((it) => `${it.material_code}×${it.qty}`)
    .join(' · ');
  const extra = items.length - HEAD;
  return extra > 0 ? `${shown} · +${extra} more` : shown;
};

/* localStorage key for the PO list's DataGrid column layout (order / hidden /
   widths / sort / grouping). Stable id so commander's column prefs survive
   reloads — same persistence the SO list + GRN list already use. */
const PO_LIST_STORAGE_KEY = 'po-list.layout.v1';

/* buildPoColumns — declared as a function so the component can pass fresh
   selection state (selectedIds + toggleSelect) every render. Memoized inside
   the component so DataGrid's column memo only invalidates when the selection
   set actually changes. Columns mirror the plain table this replaced:
   leading checkbox · PO No. · Supplier · Items · Date · Expected · Currency ·
   Total · Status. */
const buildPoColumns = (
  selectedIds: Set<string>,
  toggleSelect: (id: string) => void,
): DataGridColumn<PoHeaderRow>[] => [
  {
    /* Leading multi-select checkbox for batch GRN conversion. stopPropagation
       so ticking a row doesn't also fire the grid's row-click navigation. */
    key: 'select', label: '', width: 40, minWidth: 36,
    sortable: false, groupable: false,
    accessor: (po) => (
      <input
        type="checkbox"
        aria-label={`Select PO ${po.po_number}`}
        checked={selectedIds.has(po.id)}
        onChange={() => toggleSelect(po.id)}
        onClick={(e) => e.stopPropagation()}
        style={{ cursor: 'pointer' }}
      />
    ),
    searchValue: () => '',
  },
  {
    key: 'po_number', label: 'PO No.', width: 150, sortable: true,
    accessor: (po) => <span style={{ fontWeight: 700, color: 'var(--c-burnt)', fontVariantNumeric: 'tabular-nums' }}>{po.po_number}</span>,
    searchValue: (po) => po.po_number,
    sortFn: (a, b) => a.po_number.localeCompare(b.po_number),
  },
  {
    key: 'supplier', label: 'Supplier', width: 200, sortable: true, groupable: true,
    accessor: (po) => po.supplier?.name ?? po.supplier?.code ?? '—',
    searchValue: (po) => `${po.supplier?.name ?? ''} ${po.supplier?.code ?? ''}`,
    groupValue: (po) => po.supplier?.name ?? po.supplier?.code ?? '(none)',
    sortFn: (a, b) =>
      (a.supplier?.name ?? a.supplier?.code ?? '').localeCompare(b.supplier?.name ?? b.supplier?.code ?? ''),
  },
  {
    /* Items preview between Supplier and Date so the buyer reads each PO
       without drilling in (Commander 2026-05-27). Hover title shows the full
       list. */
    key: 'items', label: 'Items', width: 320, sortable: false, groupable: false,
    accessor: (po) => {
      const summary = summarizeItems(po.items);
      return (
        <span
          title={(po.items ?? []).map((it) => `${it.material_code} × ${it.qty}`).join('\n')}
          style={{
            display: 'block',
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--fs-12)',
            color: summary ? 'var(--c-ink)' : 'var(--fg-muted)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {summary ?? '—'}
        </span>
      );
    },
    searchValue: (po) => (po.items ?? []).map((it) => `${it.material_code} ${it.qty}`).join(' '),
  },
  {
    /* Date columns formatted to match the SO list ("31 May 2026" not the raw
       ISO string) — Commander 2026-05-31 "跟 SO 一模一样". Sort still keys on the
       raw ISO so chronological order is preserved. */
    key: 'po_date', label: 'Date', width: 120, sortable: true,
    accessor: (po) => fmtDateOrDash(po.po_date),
    searchValue: (po) => po.po_date,
    sortFn: (a, b) => (a.po_date ?? '').localeCompare(b.po_date ?? ''),
    filterType: 'date', dateValue: (po) => po.po_date,
  },
  {
    key: 'expected_at', label: 'Expected', width: 120, sortable: true,
    accessor: (po) => fmtDateOrDash(po.expected_at),
    searchValue: (po) => po.expected_at ?? '',
    sortFn: (a, b) => (a.expected_at ?? '').localeCompare(b.expected_at ?? ''),
    filterType: 'date', dateValue: (po) => po.expected_at,
  },
  {
    key: 'currency', label: 'Currency', width: 90, sortable: true, groupable: true,
    accessor: (po) => po.currency,
    searchValue: (po) => po.currency,
    groupValue: (po) => po.currency,
  },
  {
    key: 'total_centi', label: 'Total', width: 130, sortable: true, align: 'right', groupable: false,
    accessor: (po) => (
      <span style={{ fontFamily: 'var(--font-mark)', color: 'var(--c-burnt)', fontWeight: 800 }}>
        {fmtMoney(po.total_centi, po.currency)}
      </span>
    ),
    searchValue: (po) => fmtMoney(po.total_centi, po.currency),
    sortFn: (a, b) => a.total_centi - b.total_centi,
  },
  {
    /* Status auto-detected (Wei Siang 2026-05-31) — relabelled into convert
       vocabulary to mirror the SO list's "Partially Delivered / Delivered"
       badge. PARTIALLY_RECEIVED → "Partially Converted", RECEIVED → "Converted".
       The enum itself is recomputed server-side from GRN receipts; nothing here
       is manually selectable. */
    key: 'status', label: 'Status', width: 160, sortable: true, groupable: true,
    accessor: (po) => (
      <span className={styles.statusPill} style={{ background: STATUS_COLOR[po.status] }}>
        {poStatusLabel(po.status)}
      </span>
    ),
    searchValue: (po) => poStatusLabel(po.status),
    groupValue: (po) => poStatusLabel(po.status),
    sortFn: (a, b) => poStatusLabel(a.status).localeCompare(poStatusLabel(b.status)),
  },
];

type Drawer =
  | { kind: 'closed' }
  | { kind: 'create' }
  | { kind: 'detail'; poId: string };

export const PurchaseOrders = () => {
  // PR — default to Outstanding (the 95% view).
  const [status, setStatus] = useState<StatusFilter>('outstanding');
  const [drawer, setDrawer] = useState<Drawer>({ kind: 'closed' });
  const navigate = useNavigate();
  const askConfirm = useConfirm();
  const notify = useNotify();
  // Multi-select state — batch-convert N POs into one GRN.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Bump to collapse every expanded drill-down in the list at once.
  const [collapseNonce, setCollapseNonce] = useState(0);
  /* Rows currently visible after the grid's search + column filters — fed by
     DataGrid.onFilteredRowsChange so "Print all docs" prints exactly what's
     filtered, no row-ticking (Commander 2026-06-16). */
  const [visibleRows, setVisibleRows] = useState<PoHeaderRow[]>([]);
  const cancelPo = useCancelPurchaseOrder();
  const reopenPo = useReopenPurchaseOrder();
  const qc = useQueryClient();
  const warehousesQ = useWarehouses();
  const [printingDocs, setPrintingDocs] = useState(false);

  // Always fetch all rows — filtering Outstanding (SUBMITTED ∪
  // PARTIALLY_RECEIVED) client-side is one trip vs. two and the dataset is
  // small (4-staff org).
  const { data, isLoading, error } = usePurchaseOrders();
  const rows = useMemo(() => {
    const all = data ?? [];
    if (status === 'all') return all;
    if (status === 'draft') return all.filter((r) => r.status === 'DRAFT');
    // Outstanding = committed + still inbound (excludes DRAFT, which is uncommitted).
    return all.filter((r) => r.status === 'SUBMITTED' || r.status === 'PARTIALLY_RECEIVED');
  }, [data, status]);

  const toggleSelect = (id: string) => {
    setSelectedIds((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectedRows = useMemo(
    () => rows.filter((r) => selectedIds.has(r.id)),
    [rows, selectedIds],
  );

  /* Batch "Print documentation" — fetch each selected PO's full detail (cache
     reused from any expanded row) and render them into ONE PDF, each PO on its
     own page. The operator filters by supplier/date, selects, then sends the
     supplier a single file. */
  /* separate=false → ONE combined PDF (each PO a page). separate=true → N
     individual PDF files, one per PO (Commander 2026-06-16 — "5 个 PDF 分开存"). */
  const printDocs = async (rowsToPrint: PoHeaderRow[], separate = false) => {
    if (rowsToPrint.length === 0 || printingDocs) return;
    setPrintingDocs(true);
    try {
      const warehouses = warehousesQ.data ?? [];
      const details: Array<{ purchaseOrder: PoHeaderRow; items: PoItemRow[] }> = [];
      for (const row of rowsToPrint) {
        details.push(await qc.fetchQuery({
          queryKey: ['mfg-purchase-order-detail', row.id],
          queryFn: () => fetchPurchaseOrderDetail(row.id),
          staleTime: 30_000,
        }));
      }
      const pos = details.map((d) => {
        const wh = warehouses.find((w) => w.id === d.purchaseOrder.purchase_location_id);
        return {
          header: {
            ...d.purchaseOrder,
            purchase_location_name: wh ? `${wh.code} · ${wh.name}` : null,
            your_ref_no:      (d.purchaseOrder as { your_ref_no?: string | null }).your_ref_no ?? null,
            source_so_doc_no: (d.purchaseOrder as { source_so_doc_no?: string | null }).source_so_doc_no ?? null,
          },
          items: d.items,
        };
      });
      const pdf = await import('../../vendor/scm/lib/purchase-order-pdf');
      if (separate) {
        // One file per PO — each generatePurchaseOrderPdf saves its own file.
        for (const po of pos) await pdf.generatePurchaseOrderPdf(po.header, po.items);
      } else {
        await pdf.generateCombinedPurchaseOrderPdf(pos, { fileName: `purchase-orders-${new Date().toISOString().slice(0, 10)}.pdf` });
      }
    } catch (e) {
      notify({ title: 'PDF generation failed', body: `${e instanceof Error ? e.message : String(e)}`, tone: 'error' });
    } finally {
      setPrintingDocs(false);
    }
  };
  const selectedSuppliers = useMemo(
    () => new Set(selectedRows.map((r) => r.supplier_id)),
    [selectedRows],
  );

  // Memoized columns — only invalidates when the selection set changes, so
  // DataGrid's prop-memo keeps the sort/filter/group pipeline warm on typing.
  const columns = useMemo(
    () => buildPoColumns(selectedIds, toggleSelect),
    [selectedIds],
  );

  /* Commander 2026-05-31 — "为什么点 Convert to GR 的时候它是直接 Create，而不是进入
     Draft 状态？" Convert no longer POSTs a posted GRN straight away. It routes to
     the reviewable From-PO picker (?poId=…) where the PO's lines arrive PRE-TICKED,
     so the operator reviews a ready draft and only presses Save to create the GRN.
     Mirrors the DO→SI convert flow. */
  const convertToGrn = () => {
    if (selectedRows.length === 0) return;
    if (selectedSuppliers.size > 1) {
      notify({ title: 'All selected POs must be from the same supplier', body: 'Convert per supplier in separate batches.', tone: 'error' });
      return;
    }
    setSelectedIds(new Set());
    navigate(`/grns/from-po?poId=${[...selectedIds].join(',')}`);
  };

  /* Commander 2026-05-29 — right-click context menu actions (mirrors the SO
     list). Single-PO convert routes to the same reviewable picker. */
  const convertOneToGrn = (po: PoHeaderRow) => {
    // Commander 2026-05-30 — "Convert to GRN" is ALWAYS shown in the menu; when
    // the PO has no goods left inbound (already fully received / cancelled),
    // tell the operator plainly instead of silently doing nothing.
    if (po.status !== 'SUBMITTED' && po.status !== 'PARTIALLY_RECEIVED') {
      notify({ title: 'Nothing to be converted', body: 'This Purchase Order has no goods left to receive (already fully received or cancelled).', tone: 'error' });
      return;
    }
    navigate(`/grns/from-po?poId=${po.id}`);
  };
  const doCancelPo = async (po: PoHeaderRow) => {
    if (!(await askConfirm({ title: `Cancel ${po.po_number}?`, body: 'It will stop proceeding and any converted SO lines are released back.', confirmLabel: 'Cancel', danger: true }))) return;
    cancelPo.mutate(po.id, {
      onError: (e) => notify({ title: 'Cancel failed', body: `${e instanceof Error ? e.message : String(e)}`, tone: 'error' }),
    });
  };
  // Reopen — inverse of Cancel (Commander 2026-06-16). CANCELLED → SUBMITTED;
  // the converted SO lines re-claim their quota (leave the From-SO picker again).
  const doReopenPo = async (po: PoHeaderRow) => {
    if (!(await askConfirm({ title: `Reopen ${po.po_number}?`, body: 'Status returns to SUBMITTED and its converted SO lines re-claim their quota.', confirmLabel: 'Reopen' }))) return;
    reopenPo.mutate(po.id, {
      onError: (e) => notify({ title: 'Reopen failed', body: `${e instanceof Error ? e.message : String(e)}`, tone: 'error' }),
    });
  };

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div>
          <h1 className={styles.title}>Purchase Orders</h1>
        </div>
        {/* PR #97 — Commander 2026-05-26: "Create PO 也要像这样子啊"
            Replaced the old side-drawer with a full-page AutoCount-style
            form at /scm/purchase-orders/new. */}
        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <Button variant="ghost" size="sm" onClick={() => setCollapseNonce((n) => n + 1)} title="Collapse all expanded rows">
            <ChevronsDownUp {...ICON} />
            <span>Collapse all</span>
          </Button>
          {/* Print all (filtered) — one combined PDF of EVERY PO currently shown.
              Respects the search + column filters below (no row-ticking needed):
              filter to a supplier/date → the count + the PDF follow. (2026-06-16) */}
          <Button variant="ghost" size="sm" onClick={() => printDocs(visibleRows)}
            disabled={printingDocs || visibleRows.length === 0}
            title="Print every PO currently shown (follows the filters below) into ONE combined PDF">
            <Printer {...ICON} />
            <span>{printingDocs ? 'Preparing…' : `Print all · 1 PDF (${visibleRows.length})`}</span>
          </Button>
          {/* Separate mode (Commander 2026-06-16) — each shown PO as its OWN PDF
              file, so you don't save them one by one. */}
          <Button variant="ghost" size="sm" onClick={() => printDocs(visibleRows, true)}
            disabled={printingDocs || visibleRows.length === 0}
            title="Save each shown PO as its own separate PDF file">
            <Printer {...ICON} />
            <span>{`Print all · ${visibleRows.length} files`}</span>
          </Button>
          {/* PR — Phase 1: multi-SO → PO picker. Lets commander select
              outstanding SO lines (across customers + suppliers), input
              partial qty per line, and emit one PO per supplier. */}
          <Button variant="ghost" size="sm" onClick={() => navigate('/scm/purchase-orders/from-so')}>
            <ArrowRightLeft {...ICON} />
            <span>From Sales Order</span>
          </Button>
          <Button variant="primary" size="sm" onClick={() => navigate('/scm/purchase-orders/new')}>
            <Plus {...ICON} />
            <span>New Purchase Order</span>
          </Button>
        </div>
      </div>

      <div className={styles.statusChips}>
        {STATUS_CHIPS.map((c) => (
          <button
            key={c.value}
            type="button"
            onClick={() => setStatus(c.value)}
            style={{
              fontFamily: 'var(--font-button)',
              fontSize: 'var(--fs-13)',
              fontWeight: 600,
              padding: 'var(--space-2) var(--space-4)',
              borderRadius: 'var(--radius-pill)',
              border: status === c.value ? '1px solid var(--c-ink)' : '1px solid var(--line)',
              background: status === c.value ? 'var(--c-ink)' : 'var(--c-paper)',
              color: status === c.value ? 'var(--c-cream)' : 'var(--c-ink)',
              cursor: 'pointer',
            }}
          >
            {c.label}
          </button>
        ))}
      </div>

      <p className={styles.eyebrow}>
        {isLoading ? 'Loading POs…' : `${rows.length} purchase orders`}
      </p>

      {error && !isLoading && (
        <div className={styles.bannerWarn}>
          <strong>Failed to load POs.</strong>{' '}
          {error instanceof Error ? error.message : String(error)}
        </div>
      )}

      {selectedIds.size > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: 'var(--space-3) var(--space-4)',
          background: 'rgba(232, 107, 58, 0.08)',
          border: '1px solid var(--c-orange)',
          borderRadius: 'var(--radius-md)',
          gap: 'var(--space-3)',
        }}>
          <span style={{ fontWeight: 600, color: 'var(--c-burnt)' }}>
            {selectedIds.size} selected
            {selectedSuppliers.size > 1 && ' · ⚠️ Mixed suppliers — narrow to one to convert'}
          </span>
          <span style={{ display: 'inline-flex', gap: 'var(--space-2)' }}>
            <Button variant="ghost" size="sm" onClick={() => setSelectedIds(new Set())}>Clear</Button>
            <Button variant="ghost" size="sm" onClick={() => printDocs(selectedRows)} disabled={printingDocs}>
              <Printer {...ICON} />
              <span>{printingDocs ? 'Preparing…' : `1 PDF (${selectedIds.size})`}</span>
            </Button>
            <Button variant="ghost" size="sm" onClick={() => printDocs(selectedRows, true)} disabled={printingDocs}
              title="Save each selected PO as its own separate PDF file">
              <Printer {...ICON} />
              <span>{`${selectedIds.size} files`}</span>
            </Button>
            <Button variant="primary" size="sm"
              onClick={convertToGrn}
              disabled={selectedSuppliers.size !== 1}>
              {`To Goods Receipt (${selectedIds.size})`}
            </Button>
          </span>
        </div>
      )}

      <DataGrid<PoHeaderRow>
        rows={rows}
        columns={columns}
        onFilteredRowsChange={setVisibleRows}
        storageKey={PO_LIST_STORAGE_KEY}
        rowKey={(po) => po.id}
        searchPlaceholder="Search POs…"
        groupBanner={false}
        collapseAllNonce={collapseNonce}
        /* Commander 2026-05-29 — open on DOUBLE-click (single-click was too
           trigger-happy: "本来应该要点两次的嘛"). Right-click → context menu. */
        onRowDoubleClick={(po) => navigate(`/scm/purchase-orders/${po.id}`)}
        /* Commander 2026-05-31 — click a PO row to reveal full line-item detail
           with a per-line "Received" column showing which GR(s) took how much
           (mirrors the SO list's expand drill-down + its Delivered column). */
        expandable={{
          renderExpansion: (po) => <ExpandedPoLines po={po} />,
          rowExpansionKey: (po) => po.id,
        }}
        /* Cancelled POs grey out so they read as dead (mirrors the SO list). */
        rowStyle={(po) => po.status === 'CANCELLED'
          ? { opacity: 0.55, filter: 'grayscale(0.6)' }
          : undefined}
        contextMenu={(po) => {
          /* Tier 2 downstream-lock — once a non-cancelled GRN exists for this
             PO, hide Edit + Cancel. Convert-to-GRN STAYS visible because
             partial receiving (more GRNs) is allowed. */
          const hasChildren = Boolean(po.has_children);
          const menu: Array<{ label?: string; onClick?: () => void; danger?: boolean; divider?: true }> = [
            { label: 'View', onClick: () => navigate(`/scm/purchase-orders/${po.id}`) },
          ];
          if (!hasChildren) {
            menu.push({ label: 'Edit', onClick: () => navigate(`/scm/purchase-orders/${po.id}?edit=1`) });
          }
          menu.push({ divider: true as const });
          // Convert to GRN — ALWAYS shown (Commander 2026-05-30) so the operator
          // never thinks the action disappeared. convertOneToGrn decides at click
          // time whether the PO still has goods inbound and otherwise shows a
          // plain "Nothing to be converted" message.
          menu.push({ label: 'To Goods Receipt', onClick: () => convertOneToGrn(po) });
          // Cancel — soft-stop. Hidden once already cancelled / received / locked.
          if (po.status !== 'CANCELLED' && po.status !== 'RECEIVED' && !hasChildren) {
            menu.push({ divider: true as const });
            menu.push({ label: 'Cancel PO', danger: true, onClick: () => doCancelPo(po) });
          }
          // Reopen — only a cancelled PO; inverse of Cancel (Commander 2026-06-16).
          if (po.status === 'CANCELLED') {
            menu.push({ divider: true as const });
            menu.push({ label: 'Reopen PO', onClick: () => doReopenPo(po) });
          }
          return menu;
        }}
        isLoading={isLoading}
        emptyMessage='No POs yet — click "New Purchase Order" to start.'
      />

      {/* PR #97 — Create-PO drawer removed; full-page form at /scm/purchase-orders/new */}
      {drawer.kind === 'detail' && (
        <DetailPoDrawer poId={drawer.poId} onClose={() => setDrawer({ kind: 'closed' })} />
      )}
    </div>
  );
};

/* ─────────────────── Expanded PO drill-down ────────────────────────────
   Commander 2026-05-31 — click a PO row → full line-item detail + Convert /
   Partially-Convert actions + which GR(s) this PO converted to. Mirrors the
   SO list's ExpandedSoLines. Lazy-fetches detail (items) + linked (GRNs);
   TanStack caches both so re-expanding the same row is instant. */
/* Drill-down columns — display-only DataGridColumn specs so the PO drill-down
   gets the SAME add/remove · drag-reorder · resize · right-click as the main
   list grids (it used to be a hand-built fixed <table>). `currency` +
   `headerExpectedAt` are header-level (identical on every row), threaded in
   from the component. Shared layout key so column prefs persist across every
   PO the operator expands. */
const buildPoDrilldownColumns = (
  currency: Currency,
  headerExpectedAt: string | null,
  /* Resolve a line's warehouse_id → warehouse code. The per-line warehouse
     flows SO line → PO line at proceed time; surfacing it here answers "did the
     SO's warehouse come over?" (Commander 2026-06-16). */
  whName: (id: string | null | undefined) => string,
): DataGridColumn<PoItemRow>[] => [
  {
    key: 'group', label: 'Group', width: 90, groupable: true,
    accessor: (it) => <ItemGroupPill group={it.item_group ?? null} />,
    searchValue: (it) => it.item_group ?? '',
    groupValue: (it) => it.item_group ?? '(none)',
    sortFn: (a, b) => (a.item_group ?? '').localeCompare(b.item_group ?? ''),
  },
  {
    key: 'item_code', label: 'Item Code', width: 130,
    accessor: (it) => <span style={{ fontWeight: 700, color: 'var(--c-burnt)' }}>{it.material_code}</span>,
    searchValue: (it) => it.material_code,
    sortFn: (a, b) => a.material_code.localeCompare(b.material_code),
  },
  {
    /* Warehouse — the per-line ship-to that flowed from the SO line. "—" means
       this PO line never got a warehouse (e.g. raised before the SO had one).
       Commander 2026-06-16. */
    key: 'warehouse', label: 'Warehouse', width: 110, groupable: true,
    accessor: (it) => {
      const name = whName(it.warehouse_id);
      return name
        ? <span style={{ whiteSpace: 'nowrap' }}>{name}</span>
        : <span style={{ color: 'var(--fg-muted)' }}>—</span>;
    },
    searchValue: (it) => whName(it.warehouse_id),
    groupValue: (it) => whName(it.warehouse_id) || '(no warehouse)',
  },
  {
    key: 'description', label: 'Description', width: 240, minWidth: 180,
    accessor: (it) => {
      const manual = (it.description ?? '').trim();
      if (manual) return <div>{manual}</div>;
      const summary = buildVariantSummary(it.item_group ?? null, it.variants ?? null);
      return summary || it.material_name || '—';
    },
    searchValue: (it) => `${it.description ?? ''} ${buildVariantSummary(it.item_group ?? null, it.variants ?? null)} ${it.material_name ?? ''}`.trim(),
  },
  {
    key: 'description2', label: 'Description 2', width: 220, minWidth: 160,
    accessor: (it) => {
      const summary = buildVariantSummary(it.item_group ?? null, it.variants ?? null);
      return summary ? <div>{summary}</div> : <span style={{ color: 'var(--fg-muted)' }}>—</span>;
    },
    searchValue: (it) => buildVariantSummary(it.item_group ?? null, it.variants ?? null),
  },
  {
    key: 'uom', label: 'UOM', width: 70,
    accessor: (it) => it.uom || 'UNIT',
    searchValue: (it) => it.uom || 'UNIT',
  },
  {
    key: 'ordered', label: 'Ordered', width: 70, align: 'right',
    accessor: (it) => it.qty ?? 0,
    searchValue: (it) => String(it.qty ?? 0),
    sortFn: (a, b) => Number(a.qty ?? 0) - Number(b.qty ?? 0),
  },
  {
    /* "Received" mirrors the SO drill-down's "Status" column: list each GR
       that took qty, then the live balance underneath. Balance derives from
       the shown (non-cancelled) receipts so breakdown + balance reconciles to
       Ordered. */
    key: 'received', label: 'Transfer To (GRN)', width: 130,
    accessor: (it) => {
      const receipts = it.receipts ?? [];
      if (receipts.length === 0) return <span style={{ color: 'var(--fg-muted)' }}>—</span>;
      const receivedSum = receipts.reduce((s, r) => s + Number(r.qty ?? 0), 0);
      const balance = Number(it.qty ?? 0) - receivedSum;
      return (
        <div>
          {receipts.map((r, ri) => (
            <div key={ri} style={{ fontWeight: 600, color: 'var(--c-burnt)', whiteSpace: 'nowrap' }}>
              {r.grnNumber} <span style={{ color: 'var(--fg-muted)', fontWeight: 400 }}>×{r.qty}</span>
            </div>
          ))}
          <div style={{
            fontSize: 'var(--fs-10)', marginTop: 1,
            color: balance > 0 ? 'var(--c-festive-b, #B8331F)' : 'var(--c-secondary-a, #2F5D4F)',
          }}>
            {balance > 0 ? `Balance ${balance}` : 'Fully Received'}
          </div>
        </div>
      );
    },
    searchValue: (it) => (it.receipts ?? []).map((r) => r.grnNumber).join(' '),
  },
  {
    key: 'delivery_date', label: 'Delivery Date', width: 120,
    accessor: (it) => {
      const due = it.delivery_date ?? headerExpectedAt ?? null;
      return due
        ? <span style={{ whiteSpace: 'nowrap' }}>{fmtDateOrDash(due)}</span>
        : <span style={{ color: 'var(--fg-muted)' }}>—</span>;
    },
    searchValue: (it) => it.delivery_date ?? headerExpectedAt ?? '',
    sortFn: (a, b) => (a.delivery_date ?? headerExpectedAt ?? '').localeCompare(b.delivery_date ?? headerExpectedAt ?? ''),
  },
  {
    key: 'unit_price', label: 'Unit Price', width: 100, align: 'right',
    accessor: (it) => fmtMoney(Number(it.unit_price_centi ?? 0), currency),
    searchValue: (it) => String(it.unit_price_centi ?? 0),
    sortFn: (a, b) => Number(a.unit_price_centi ?? 0) - Number(b.unit_price_centi ?? 0),
  },
  {
    key: 'line_total', label: 'Line Total', width: 110, align: 'right',
    accessor: (it) => <span style={{ fontWeight: 700, color: 'var(--c-burnt)' }}>{fmtMoney(Number(it.line_total_centi ?? 0), currency)}</span>,
    searchValue: (it) => String(it.line_total_centi ?? 0),
    sortFn: (a, b) => Number(a.line_total_centi ?? 0) - Number(b.line_total_centi ?? 0),
  },
];

const ExpandedPoLines = ({ po }: { po: PoHeaderRow }) => {
  const detail = usePurchaseOrderDetail(po.id);
  /* Warehouse-id → code map for the per-line Warehouse column (Commander
     2026-06-16). Hooks must run before the early returns below. */
  const warehousesQ = useWarehouses();
  const whById = useMemo(() => {
    const m = new Map<string, string>();
    for (const w of warehousesQ.data ?? []) m.set(w.id, w.code);
    return m;
  }, [warehousesQ.data]);

  if (detail.isLoading) {
    return (
      <div style={{ padding: 'var(--space-2) var(--space-3) var(--space-3) 40px', background: 'var(--c-cream)' }}>
        <p style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)', margin: 0 }}>Loading lines for {po.po_number}…</p>
      </div>
    );
  }
  if (detail.error) {
    return (
      <div style={{ padding: 'var(--space-2) var(--space-3) var(--space-3) 40px', background: 'var(--c-cream)' }}>
        <p style={{ fontSize: 'var(--fs-11)', color: 'var(--c-festive-b, #B8331F)', margin: 0 }}>
          Failed to load lines: {detail.error instanceof Error ? detail.error.message : String(detail.error)}
        </p>
      </div>
    );
  }

  const items = (detail.data?.items ?? []) as PoItemRow[];
  if (items.length === 0) {
    return (
      <div style={{ padding: 'var(--space-2) var(--space-3) var(--space-3) 40px', background: 'var(--c-cream)' }}>
        <p style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)', margin: 0 }}>No line items.</p>
      </div>
    );
  }

  let subtotal = 0;
  for (const it of items) subtotal += Number(it.line_total_centi ?? 0);

  const whName = (id: string | null | undefined) => (id ? whById.get(id) ?? '' : '');
  const columns = buildPoDrilldownColumns(po.currency, po.expected_at ?? null, whName);

  return (
    <div style={{ padding: 'var(--space-2) var(--space-3) var(--space-3) 40px', background: 'var(--c-cream)' }}>
      <DataGrid<PoItemRow>
        rows={items}
        columns={columns}
        storageKey="po-drilldown-grid.v1"
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
        <span>Total <strong style={{ color: 'var(--c-burnt)' }}>{fmtMoney(subtotal, po.currency)}</strong></span>
      </div>
    </div>
  );
};

/* ─────────────────── Detail PO Drawer ──────────────────────────────── */

const DetailPoDrawer = ({ poId, onClose }: { poId: string; onClose: () => void }) => {
  const detail = usePurchaseOrderDetail(poId);
  const notify = useNotify();
  // PR-DRAFT-removal — Submit/Cancel removed from the list drawer. Use
  // /scm/purchase-orders/:id detail for cancel + delete actions.

  const po = detail.data?.purchaseOrder;
  const items = detail.data?.items ?? [];

  return (
    <>
      <div className={styles.backdrop} onClick={onClose} />
      <aside className={styles.drawer}>
        <header className={styles.drawerHeader}>
          <h2 className={styles.drawerTitle}>
            {po?.po_number ?? 'Purchase Order'}
          </h2>
          <button type="button" className={styles.iconBtn} onClick={onClose}><X {...ICON} /></button>
        </header>

        <div className={styles.drawerBody}>
          {detail.isLoading && <p className={styles.eyebrow}>Loading…</p>}
          {po && (
            <>
              <div className={styles.section}>
                <p className={styles.eyebrow}>Supplier</p>
                <p style={{ fontFamily: 'var(--font-title)', fontSize: 'var(--fs-20)', fontWeight: 700 }}>
                  {po.supplier?.name ?? po.supplier?.code}
                </p>
              </div>

              <div className={styles.formGrid}>
                <SmallStat label="PO Date" value={fmtDateOrDash(po.po_date)} />
                <SmallStat label="Expected" value={fmtDateOrDash(po.expected_at)} />
                <SmallStat label="Currency" value={po.currency} />
                <SmallStat label="Status" value={poStatusLabel(po.status)} />
                <SmallStat label="Subtotal" value={fmtMoney(po.subtotal_centi, po.currency)} />
                <SmallStat label="Total" value={fmtMoney(po.total_centi, po.currency)} />
              </div>

              {po.notes && (
                <div className={styles.section}>
                  <p className={styles.eyebrow}>Notes</p>
                  <p>{po.notes}</p>
                </div>
              )}

              <div className={styles.section}>
                <p className={styles.eyebrow}>Items ({items.length})</p>
                {items.map((it) => (
                  <div key={it.id} className={styles.bindingRow}>
                    <span className={styles.bindingIcon}><FileText size={14} strokeWidth={1.75} /></span>
                    <div className={styles.bindingMaterial}>
                      <span className={styles.bindingCode}>{it.material_code}</span>
                      <span className={styles.bindingName}>{it.material_name}</span>
                    </div>
                    <span className={styles.bindingSku}>{it.supplier_sku ?? '—'}</span>
                    <span className={styles.bindingPrice}>
                      {fmtMoney(it.unit_price_centi, po.currency)}
                    </span>
                    <span className={styles.bindingMeta}>× {it.qty}</span>
                    <span className={styles.bindingMeta}>{fmtMoney(it.line_total_centi, po.currency)}</span>
                    <span />
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {po && (
          <footer className={styles.drawerFooter}>
            <Button
              variant="ghost"
              size="md"
              onClick={() => {
                // Dynamic import — PDF chunk is shared with SO/DO so it's cached
                // after first use on any flow.
                import('../../vendor/scm/lib/purchase-order-pdf').then(({ generatePurchaseOrderPdf }) =>
                  generatePurchaseOrderPdf(po, items),
                ).catch((e) => notify({ title: 'PDF generation failed', body: `${e instanceof Error ? e.message : String(e)}`, tone: 'error' }));
              }}
            >
              <Printer {...ICON} />
              <span>Print PDF</span>
            </Button>
            {/* PR-DRAFT-removal — Submit/Cancel-from-Draft removed. POs are
                SUBMITTED on create, and cancellation lives on the detail page. */}
            <Button variant="ghost" size="md" onClick={onClose}>Close</Button>
          </footer>
        )}
      </aside>
    </>
  );
};

const SmallStat = ({ label, value }: { label: string; value: string }) => (
  <div className={styles.field}>
    <span className={styles.fieldLabel}>{label}</span>
    <span style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-14)', fontWeight: 600 }}>
      {value}
    </span>
  </div>
);
