// ----------------------------------------------------------------------------
// GoodsReceivedList — Goods Received Note (GRN) list, cloned from the polished
// Purchase Orders list (PurchaseOrders.tsx). Same DataGrid UX:
//   • double-click a row → open the GRN detail page
//   • right-click → context menu (View · Edit · Convert to PI · Convert to PR)
//
// GRN creation stays on the existing /grns/new + /grns/from-po pages — this
// list just adds the New GRN button.
//
// HOUZS VENDOR — verbatim from apps/backend/src/pages/GoodsReceivedList.tsx.
// Import boundary only: react-router → react-router-dom (Houzs ships v6);
// flow-queries GRN hooks → vendored grn-queries; components/lib → ../../vendor/
// scm/*; internal nav repointed to the parallel /scm/* routes. Cross-domain
// links (purchase-returns, not yet vendored) stay native.
// ----------------------------------------------------------------------------

import { useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, ArrowRightLeft, Printer } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { authedFetch } from '../../vendor/scm/lib/authed-fetch';
import { useChoice } from '../../vendor/scm/components/ChoiceDialog';
import {
  useGrns,
  usePurchaseReturnFromGrn,
  useCancelGrn,
  useGrnDetail,
} from '../../vendor/scm/lib/grn-queries';
import { DataGrid, type DataGridColumn } from '../../vendor/scm/components/DataGrid';
import { newIdempotencyKey } from '../../lib/idempotency';
import { StatusPill } from '../../vendor/scm/components/StatusPill';
import { statusLabel } from '../../vendor/scm/lib/status-pill';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { fmtDateOrDash, buildVariantSummary } from '@2990s/shared';
import styles from './Suppliers.module.css';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

// GRN status set (grn_status enum): DRAFT / POSTED / CLOSED / CANCELLED. Colours
// + labels come from the canonical lib/status-pill map via <StatusPill>. DRAFT =
// saved-but-not-yet-confirmed (no stock IN, no PO rollup until confirmed).
const STATUS_CHIPS = ['all', 'DRAFT', 'POSTED', 'CLOSED', 'CANCELLED'] as const;

const fmtMoney = (centi: number, currency = 'MYR'): string =>
  `${currency} ${(centi / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/* New unique storage key — NEVER reuse the PO list key. */
const GRN_LIST_STORAGE_KEY = 'grn-list.layout.v1';

/* The list endpoint embeds supplier + purchase_order + a computed total_centi.
   Rows stay loosely typed (the GRN list endpoint returns row shape per migration
   0101 + the existing joins) — accessors read by name. */
type GrnRow = Record<string, unknown> & {
  id: string;
  grn_number: string;
  status: string;
  received_at: string | null;
  delivery_note_ref: string | null;
  total_centi?: number;
  currency?: string;
  supplier?: { id: string; code: string; name: string } | null;
  purchase_order?: { id: string; po_number: string } | null;
  /* Migration 0106 — convert-eligibility / lock flags from the list endpoint. */
  has_children?: boolean;
  fully_invoiced?: boolean;
  fully_returned?: boolean;
};

const buildGrnColumns = (): DataGridColumn<GrnRow>[] => [
  {
    key: 'grn_number', label: 'GRN No.', width: 150, sortable: true,
    accessor: (g) => <span style={{ fontWeight: 700, color: 'var(--c-burnt)', fontVariantNumeric: 'tabular-nums' }}>{g.grn_number}</span>,
    searchValue: (g) => g.grn_number,
    // accessor is JSX → export the raw GRN-no string so GRN No. isn't blank.
    exportValue: (g) => g.grn_number,
    sortFn: (a, b) => a.grn_number.localeCompare(b.grn_number),
  },
  {
    key: 'supplier', label: 'Supplier', width: 220, sortable: true, groupable: true,
    accessor: (g) => g.supplier?.name ?? g.supplier?.code ?? '—',
    searchValue: (g) => `${g.supplier?.name ?? ''} ${g.supplier?.code ?? ''}`.trim(),
    groupValue: (g) => g.supplier?.name ?? g.supplier?.code ?? '(none)',
    sortFn: (a, b) =>
      (a.supplier?.name ?? a.supplier?.code ?? '').localeCompare(b.supplier?.name ?? b.supplier?.code ?? ''),
  },
  {
    key: 'po_number', label: 'Transfer From (PO)', width: 150, sortable: true, groupable: true,
    accessor: (g) => <span style={{ fontWeight: 700, color: 'var(--c-burnt)', fontVariantNumeric: 'tabular-nums' }}>{g.purchase_order?.po_number ?? '—'}</span>,
    searchValue: (g) => g.purchase_order?.po_number ?? '',
    groupValue: (g) => g.purchase_order?.po_number ?? '(none)',
    // accessor is JSX → export the source PO doc-no string.
    exportValue: (g) => g.purchase_order?.po_number ?? '—',
  },
  {
    key: 'received_at', label: 'Received Date', width: 120, sortable: true,
    accessor: (g) => fmtDateOrDash(g.received_at),
    searchValue: (g) => g.received_at ?? '',
    sortFn: (a, b) => String(a.received_at ?? '').localeCompare(String(b.received_at ?? '')),
    filterType: 'date', dateValue: (g) => g.received_at,
  },
  {
    key: 'delivery_note_ref', label: 'DN Ref', width: 130, sortable: true, defaultHidden: true,
    accessor: (g) => g.delivery_note_ref ?? '—',
    searchValue: (g) => g.delivery_note_ref ?? '',
  },
  {
    key: 'total_centi', label: 'Total', width: 130, sortable: true, align: 'right', groupable: false,
    accessor: (g) => (
      <span style={{ fontFamily: 'var(--font-mark)', color: 'var(--c-burnt)', fontWeight: 800 }}>
        {fmtMoney(Number(g.total_centi ?? 0), g.currency)}
      </span>
    ),
    searchValue: (g) => fmtMoney(Number(g.total_centi ?? 0), g.currency),
    // accessor is JSX money → export the NUMBER (currency units) so Excel SUMs it.
    exportValue: (g) => Number(g.total_centi ?? 0) / 100,
    sortFn: (a, b) => Number(a.total_centi ?? 0) - Number(b.total_centi ?? 0),
  },
  {
    key: 'status', label: 'Status', width: 130, sortable: true, groupable: true,
    accessor: (g) => <StatusPill docType="grn" status={g.status} />,
    searchValue: (g) => statusLabel('grn', g.status),
    groupValue: (g) => statusLabel('grn', g.status),
    // accessor is a <StatusPill> JSX → export the plain status label text.
    exportValue: (g) => statusLabel('grn', g.status),
    sortFn: (a, b) => a.status.localeCompare(b.status),
  },
];

/* ── Drill-down — per-line breakdown for one GRN, mirrors ExpandedPoLines ── */
type GrnItem = Record<string, unknown> & {
  id: string;
  material_code?: string | null;
  material_name?: string | null;
  description?: string | null;
  item_group?: string | null;
  variants?: Record<string, unknown> | null;
  qty?: number | null;
  qty_received?: number | null;
  unit_price_centi?: number | null;
  line_total_centi?: number | null;
  /* Bug #2 (2026-05-31) — server-resolved per-line source PO + the GRN receive date. */
  source_po_number?: string | null;
  received_at?: string | null;
  downstream?: { docNumber: string; docType: 'PI' | 'PR'; qty: number; status: string }[];
};

const buildGrnDrilldownColumns = (currency: string): DataGridColumn<GrnItem>[] => [
  {
    key: 'item_code', label: 'Item Code', width: 130,
    accessor: (it) => <span style={{ fontWeight: 700, color: 'var(--c-burnt)' }}>{it.material_code ?? '—'}</span>,
    searchValue: (it) => it.material_code ?? '',
    sortFn: (a, b) => (a.material_code ?? '').localeCompare(b.material_code ?? ''),
  },
  {
    /* Bug #2 — "received from which PO" per line (null for manual lines). */
    key: 'source_po', label: 'Transfer From (PO)', width: 130,
    accessor: (it) => <span style={{ fontWeight: 700, color: 'var(--c-burnt)', fontVariantNumeric: 'tabular-nums' }}>{it.source_po_number ?? '—'}</span>,
    searchValue: (it) => it.source_po_number ?? '',
    sortFn: (a, b) => (a.source_po_number ?? '').localeCompare(b.source_po_number ?? ''),
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
    key: 'qty_received', label: 'Qty Received', width: 100, align: 'right',
    accessor: (it) => it.qty_received ?? it.qty ?? 0,
    searchValue: (it) => String(it.qty_received ?? it.qty ?? 0),
    sortFn: (a, b) => Number(a.qty_received ?? a.qty ?? 0) - Number(b.qty_received ?? b.qty ?? 0),
  },
  {
    key: 'transfer_to', label: 'Transfer To', width: 140,
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
  {
    /* Bug #2 — receive date per line (mirrors the GRN header received_at). */
    key: 'received_at', label: 'Receive Date', width: 120,
    accessor: (it) => fmtDateOrDash((it.received_at ?? '').slice(0, 10) || null),
    searchValue: (it) => it.received_at ?? '',
    sortFn: (a, b) => String(a.received_at ?? '').localeCompare(String(b.received_at ?? '')),
    filterType: 'date', dateValue: (it) => it.received_at,
  },
];

const ExpandedGrnLines = ({ grn }: { grn: GrnRow }) => {
  const detail = useGrnDetail(grn.id);
  const currency = grn.currency ?? 'MYR';

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
  const items = (detail.data?.items ?? []) as GrnItem[];
  if (items.length === 0) {
    return <div style={{ padding: '8px 12px', fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>No line items.</div>;
  }
  let subtotal = 0;
  for (const it of items) subtotal += Number(it.line_total_centi ?? 0);

  const columns = buildGrnDrilldownColumns(currency);

  return (
    <div style={{ padding: 'var(--space-2) var(--space-3) var(--space-3) 40px', background: 'var(--c-cream)' }}>
      <DataGrid<GrnItem>
        rows={items}
        columns={columns}
        storageKey="grn-drilldown-grid.v1"
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

export const GoodsReceived = () => {
  const navigate = useNavigate();
  const askConfirm = useConfirm();
  const notify = useNotify();
  const askChoice = useChoice();
  // Multi-select state — batch "Export PDF" (one combined or N separate files).
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const statusChip = searchParams.get('status') ?? 'all';
  const setStatusChip = (s: string) => {
    const next = new URLSearchParams(searchParams);
    if (s === 'all') next.delete('status'); else next.set('status', s);
    setSearchParams(next, { replace: true });
  };

  const { data, isLoading, error } = useGrns();
  const prFromGrn = usePurchaseReturnFromGrn();
  const cancelGrn = useCancelGrn();

  const allRows = useMemo<GrnRow[]>(() => (data?.grns ?? []) as GrnRow[], [data]);
  const rows = useMemo<GrnRow[]>(
    () => (statusChip === 'all' ? allRows : allRows.filter((g) => g.status === statusChip)),
    [allRows, statusChip],
  );
  const columns = useMemo(() => buildGrnColumns(), []);

  // Single-GRN convert (right-click) → open the New PI review screen pre-loaded
  // with this note's remaining lines. Nothing is invoiced until the operator
  // confirms prices/dates and clicks Create (matches the other modules).
  const convertToPi = (g: GrnRow) => {
    navigate(`/scm/purchase-invoices/new?grnId=${encodeURIComponent(g.id)}`);
  };
  /* One key per (mount, GRN) — NOT per mount, and NOT bound to the grnId for
     good. Per mount alone would hand two DIFFERENT GRNs the same key and replay
     the first one's PR for the second; bound to the grnId permanently would
     swallow the legitimate second return of one GRN (purchase-returns.ts:806 —
     "a GRN can be returned across multiple PRs"). Keyed by grnId INSIDE a ref
     that dies with the mount, both hold: two clicks on the same GRN in one visit
     are one intent (reaching a real second return means trimming PR-1 to release
     the qty, which means opening it, which means leaving this list), while a
     different GRN always mints its own key without depending on the navigate
     below to unmount us. See the hook for why this action needs it more than the
     create forms do: it is a context-menu item with no pending guard and no
     spinner, so the operator's only feedback that the first click did anything
     is the page changing. */
  const prKeyRef = useRef<{ grnId: string; key: string } | null>(null);
  const convertToPr = (g: GrnRow) => {
    let intent = prKeyRef.current;
    if (!intent || intent.grnId !== g.id) {
      intent = { grnId: g.id, key: newIdempotencyKey() };
      prKeyRef.current = intent;
    }
    prFromGrn.mutate({ grnId: g.id, idempotencyKey: intent.key }, {
      onSuccess: (res) => navigate(`/scm/purchase-returns/${res.id}`),
      onError: (e) => notify({ title: 'To Purchase Return failed', body: e instanceof Error ? e.message : String(e), tone: 'error' }),
    });
  };
  // Cancel a GRN (right-click) — reverses the receipt server-side. Confirm first.
  const doCancelGrn = async (g: GrnRow) => {
    if (!(await askConfirm({ title: `Cancel GRN ${g.grn_number}?`, body: "This reverses the receipt — stock is taken back out and the source PO's received qty is rolled back. Line items stay for audit.", confirmLabel: 'Cancel', danger: true }))) return;
    cancelGrn.mutate(g.id, {
      onError: (e) => notify({ title: 'Cancel failed', body: e instanceof Error ? e.message : String(e), tone: 'error' }),
    });
  };

  /* Batch "Export PDF" — fetch each selected GRN's full detail (the same
     /grns/:id endpoint useGrnDetail reads: returns { grn, items }; the grn
     header carries supplier + purchase_order the generator needs) and render
     into one combined file or N separate files (operator picks via useChoice). */
  const fetchGrnBundle = async (id: string): Promise<{ header: unknown; items: unknown[] }> => {
    const res = await authedFetch<{ grn: unknown; items: unknown[] }>(`/grns/${id}`);
    return { header: res.grn, items: res.items ?? [] };
  };

  const exportSelected = async () => {
    const selectedRows = rows.filter((g) => sel.has(g.id));
    if (selectedRows.length === 0 || exporting) return;
    try {
      if (selectedRows.length === 1) {
        setExporting(true);
        const bundle = await fetchGrnBundle(selectedRows[0]!.id);
        const { generateGrnPdf } = await import('../../vendor/scm/lib/grn-pdf');
        await generateGrnPdf(bundle.header as never, bundle.items as never);
        return;
      }
      const how = await askChoice({
        title: `Download ${selectedRows.length} documents`,
        options: [
          { value: 'one', label: 'One combined PDF' },
          { value: 'many', label: 'Separate files', detail: 'One PDF per document' },
        ],
      });
      if (how == null) return;
      setExporting(true);
      const bundles: Array<{ header: unknown; items: unknown[] }> = [];
      for (const g of selectedRows) bundles.push(await fetchGrnBundle(g.id));
      if (how === 'one') {
        const { generateCombinedGrnPdf } = await import('../../vendor/scm/lib/grn-pdf');
        await generateCombinedGrnPdf(bundles as never, {
          fileName: `goods-received-${new Date().toISOString().slice(0, 10)}.pdf`,
        });
      } else {
        const { generateGrnPdf } = await import('../../vendor/scm/lib/grn-pdf');
        for (const b of bundles) await generateGrnPdf(b.header as never, b.items as never);
      }
    } catch (e) {
      notify({ title: 'PDF generation failed', body: e instanceof Error ? e.message : String(e), tone: 'error' });
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div>
          <h1 className={styles.title}>Goods Received</h1>
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <Button variant="ghost" size="sm" onClick={() => navigate('/scm/grns/from-po')}>
            <ArrowRightLeft {...ICON} />
            <span>From Purchase Order</span>
          </Button>
          <Button variant="primary" size="sm" onClick={() => navigate('/scm/grns/new')}>
            <Plus {...ICON} />
            <span>New Goods Receipt</span>
          </Button>
        </div>
      </div>

      <p className={styles.eyebrow}>
        {isLoading ? 'Loading GRNs…' : `${rows.length} goods received notes`}
      </p>

      {error && !isLoading && (
        <div className={styles.bannerWarn}>
          <strong>Failed to load GRNs.</strong>{' '}
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
            {s === 'all' ? 'All' : statusLabel('grn', s)}
          </button>
        ))}
      </div>

      {/* Batch action bar — shown only when rows are selected (mirrors the PO list). */}
      {sel.size > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: 'var(--space-3) var(--space-4)',
          background: 'rgba(232, 107, 58, 0.08)',
          border: '1px solid var(--c-orange)',
          borderRadius: 'var(--radius-md)',
          gap: 'var(--space-3)',
        }}>
          <span style={{ fontWeight: 600, color: 'var(--c-burnt)' }}>{sel.size} selected</span>
          <span style={{ display: 'inline-flex', gap: 'var(--space-2)' }}>
            <Button variant="ghost" size="sm" onClick={() => setSel(new Set())}>Clear</Button>
            <Button variant="ghost" size="sm" onClick={() => void exportSelected()} disabled={exporting}>
              <Printer size={14} strokeWidth={1.75} />
              <span>{exporting ? 'Preparing…' : `Export PDF (${sel.size})`}</span>
            </Button>
          </span>
        </div>
      )}

      <DataGrid<GrnRow>
        rows={rows}
        columns={columns}
        storageKey={GRN_LIST_STORAGE_KEY}
        exportName="Goods Received"
        rowKey={(g) => g.id}
        selectable={{
          selectedKeys: sel,
          onToggle: (k) => setSel((p) => { const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); return n; }),
          onToggleAll: (keys, allSel) => setSel((p) => {
            const n = new Set(p);
            if (allSel) { for (const k of keys) n.delete(k); } else { for (const k of keys) n.add(k); }
            return n;
          }),
        }}
        searchPlaceholder="Search GRNs…"
        groupBanner={false}
        /* Open on DOUBLE-click; right-click → context menu (mirrors the PO list). */
        onRowDoubleClick={(g) => navigate(`/scm/grns/${g.id}`)}
        /* Cancelled / Closed GRNs grey out so they read as dead (mirrors the PO list). */
        rowStyle={(g) => (g.status === 'CANCELLED' || g.status === 'CLOSED')
          ? { opacity: 0.55, filter: 'grayscale(0.6)' }
          : undefined}
        /* Click a row → reveal full line-item detail (mirrors the PO list). */
        expandable={{
          renderExpansion: (g) => <ExpandedGrnLines grn={g} />,
          rowExpansionKey: (g) => g.id,
        }}
        contextMenu={(g) => {
          // Unified convert / edit / cancel eligibility (migration 0106). Each
          // action is HIDDEN when not eligible:
          //   • Edit / Cancel  — only POSTED && no downstream child.
          //   • Convert to PI  — only POSTED && not fully invoiced.
          //   • Convert to PR  — only POSTED && not fully returned.
          const isPosted = g.status === 'POSTED';
          const isDraft = g.status === 'DRAFT';
          const hasChildren = Boolean(g.has_children);
          const menu: Array<{ label?: string; onClick?: () => void; danger?: boolean; divider?: true }> = [
            { label: 'View', onClick: () => navigate(`/scm/grns/${g.id}`) },
          ];
          // Edit — when editable: a Draft (always), or Confirmed with no child.
          if (isDraft || (isPosted && !hasChildren)) {
            menu.push({ label: 'Edit', onClick: () => navigate(`/scm/grns/${g.id}?edit=1`) });
          }
          // Convert actions — only for a Confirmed (POSTED) GRN that isn't fully
          // consumed. A DRAFT GRN has no stock IN, so it can't feed a PI/PR.
          const canPi = isPosted && !g.fully_invoiced;
          const canPr = isPosted && !g.fully_returned;
          if (canPi || canPr) {
            menu.push({ divider: true as const });
            if (canPi) menu.push({ label: 'To Purchase Invoice', onClick: () => convertToPi(g) });
            if (canPr) menu.push({ label: 'To Purchase Return', onClick: () => convertToPr(g) });
          }
          // Cancel — soft-stop. A Draft (voids it) or a Confirmed GRN with no child.
          if (isDraft || (isPosted && !hasChildren)) {
            menu.push({ divider: true as const });
            menu.push({ label: 'Cancel', danger: true, onClick: () => doCancelGrn(g) });
          }
          return menu;
        }}
        isLoading={isLoading}
        emptyMessage='No GRNs yet — click "New Goods Receipt" to receive goods.'
      />
    </div>
  );
};
