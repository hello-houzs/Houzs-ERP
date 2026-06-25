// ----------------------------------------------------------------------------
// PurchaseReturnsList — Purchase Return (PR) list, cloned from the polished
// Goods Received list (GoodsReceivedList.tsx). Same DataGrid UX:
//   • double-click a row → open the PR detail page
//   • right-click → context menu ("Open")
//
// A Purchase Return is born from a Goods Receipt: the user converts a GRN
// (right-click "Convert to PR" on the GRN list, or the "From GRN" button here
// routes to /grns). A manual New Return page exists at /purchase-returns/new.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, Undo2, ArrowRightLeft, Printer } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { usePurchaseReturns, useCancelPurchaseReturn, usePurchaseReturnDetail } from '../../vendor/scm/lib/purchase-return-queries';
import { DataGrid, type DataGridColumn } from '../../vendor/scm/components/DataGrid';
import { StatusPill } from '../../vendor/scm/components/StatusPill';
import { statusLabel } from '../../vendor/scm/lib/status-pill';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { useChoice } from '../../vendor/scm/components/ChoiceDialog';
import { authedFetch } from '../../vendor/scm/lib/authed-fetch';
import { fmtDateOrDash, buildVariantSummary } from '@2990s/shared';
import styles from './Suppliers.module.css';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

// purchase_return_status enum: POSTED / COMPLETED / CANCELLED. Colours +
// labels come from the canonical lib/status-pill map via <StatusPill>.
const STATUS_CHIPS = ['all', 'POSTED', 'COMPLETED', 'CANCELLED'] as const;

const fmtMoney = (centi: number, currency = 'MYR'): string =>
  `${currency} ${(centi / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/* New unique storage key — NEVER reuse the GRN/PO list key. */
const PR_LIST_STORAGE_KEY = 'pr-list.layout.v1';

/* The list endpoint embeds supplier + purchase_order + grn + the header's
   refund_centi. Rows stay loosely typed — accessors read by name. */
type PrRow = Record<string, unknown> & {
  id: string;
  return_number: string;
  status: string;
  return_date: string | null;
  refund_centi?: number;
  supplier?: { id: string; code: string; name: string } | null;
  purchase_order?: { id: string; po_number: string } | null;
  grn?: { id: string; grn_number: string } | null;
};

const buildPrColumns = (): DataGridColumn<PrRow>[] => [
  {
    key: 'return_number', label: 'Return No.', width: 150, sortable: true,
    accessor: (r) => <span style={{ fontWeight: 700, color: 'var(--c-burnt)', fontVariantNumeric: 'tabular-nums' }}>{r.return_number}</span>,
    searchValue: (r) => r.return_number,
    // accessor is JSX → export the raw return-no string so Return No. isn't blank.
    exportValue: (r) => r.return_number,
    sortFn: (a, b) => a.return_number.localeCompare(b.return_number),
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
    key: 'grn_number', label: 'Transfer From (GRN)', width: 150, sortable: true, groupable: true,
    accessor: (r) => <span style={{ fontWeight: 700, color: 'var(--c-burnt)', fontVariantNumeric: 'tabular-nums' }}>{r.grn?.grn_number ?? '—'}</span>,
    searchValue: (r) => r.grn?.grn_number ?? '',
    groupValue: (r) => r.grn?.grn_number ?? '(none)',
    // accessor is JSX → export the source GRN doc-no string.
    exportValue: (r) => r.grn?.grn_number ?? '—',
  },
  {
    key: 'return_date', label: 'Return Date', width: 120, sortable: true,
    accessor: (r) => fmtDateOrDash(r.return_date),
    searchValue: (r) => r.return_date ?? '',
    sortFn: (a, b) => String(a.return_date ?? '').localeCompare(String(b.return_date ?? '')),
    filterType: 'date', dateValue: (r) => r.return_date,
  },
  {
    key: 'refund_centi', label: 'Refund', width: 130, sortable: true, align: 'right', groupable: false,
    accessor: (r) => (
      <span style={{ fontFamily: 'var(--font-mark)', color: 'var(--c-burnt)', fontWeight: 800 }}>
        {fmtMoney(Number(r.refund_centi ?? 0))}
      </span>
    ),
    searchValue: (r) => fmtMoney(Number(r.refund_centi ?? 0)),
    // accessor is JSX money → export the NUMBER (ringgit) so Excel SUMs it.
    exportValue: (r) => Number(r.refund_centi ?? 0) / 100,
    sortFn: (a, b) => Number(a.refund_centi ?? 0) - Number(b.refund_centi ?? 0),
  },
  {
    key: 'status', label: 'Status', width: 130, sortable: true, groupable: true,
    accessor: (r) => <StatusPill docType="pr" status={r.status} />,
    searchValue: (r) => statusLabel('pr', r.status),
    groupValue: (r) => statusLabel('pr', r.status),
    // accessor is a <StatusPill> JSX → export the plain status label text.
    exportValue: (r) => statusLabel('pr', r.status),
    sortFn: (a, b) => a.status.localeCompare(b.status),
  },
];

/* ── Drill-down — per-line breakdown for one PR, mirrors ExpandedPoLines ─── */
type PrItem = Record<string, unknown> & {
  id: string;
  material_code?: string | null;
  material_name?: string | null;
  description?: string | null;
  item_group?: string | null;
  variants?: Record<string, unknown> | null;
  qty_returned?: number | null;
  unit_price_centi?: number | null;
  line_refund_centi?: number | null;
};

const buildPrDrilldownColumns = (): DataGridColumn<PrItem>[] => [
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
    key: 'qty_returned', label: 'Qty Returned', width: 100, align: 'right',
    accessor: (it) => it.qty_returned ?? 0,
    searchValue: (it) => String(it.qty_returned ?? 0),
    sortFn: (a, b) => Number(a.qty_returned ?? 0) - Number(b.qty_returned ?? 0),
  },
  {
    key: 'unit_price', label: 'Unit Price', width: 110, align: 'right',
    accessor: (it) => fmtMoney(Number(it.unit_price_centi ?? 0)),
    searchValue: (it) => String(it.unit_price_centi ?? 0),
    sortFn: (a, b) => Number(a.unit_price_centi ?? 0) - Number(b.unit_price_centi ?? 0),
  },
  {
    key: 'line_total', label: 'Line Total', width: 120, align: 'right',
    accessor: (it) => <span style={{ fontWeight: 700, color: 'var(--c-burnt)' }}>{fmtMoney(Number(it.line_refund_centi ?? 0))}</span>,
    searchValue: (it) => String(it.line_refund_centi ?? 0),
    sortFn: (a, b) => Number(a.line_refund_centi ?? 0) - Number(b.line_refund_centi ?? 0),
  },
];

const ExpandedPrLines = ({ pr }: { pr: PrRow }) => {
  const detail = usePurchaseReturnDetail(pr.id);

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
  const items = (detail.data?.items ?? []) as PrItem[];
  if (items.length === 0) {
    return <div style={{ padding: '8px 12px', fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>No line items.</div>;
  }
  let subtotal = 0;
  for (const it of items) subtotal += Number(it.line_refund_centi ?? 0);

  const columns = buildPrDrilldownColumns();

  return (
    <div style={{ padding: 'var(--space-2) var(--space-3) var(--space-3) 40px', background: 'var(--c-cream)' }}>
      <DataGrid<PrItem>
        rows={items}
        columns={columns}
        storageKey="pr-drilldown-grid.v1"
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
        <span>Total <strong style={{ color: 'var(--c-burnt)' }}>{fmtMoney(subtotal)}</strong></span>
      </div>
    </div>
  );
};

export const PurchaseReturns = () => {
  const navigate = useNavigate();
  const askConfirm = useConfirm();
  const notify = useNotify();
  const askChoice = useChoice();
  // Multi-select state — batch "Export PDF" for N selected returns.
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const statusChip = searchParams.get('status') ?? 'all';
  const setStatusChip = (s: string) => {
    const next = new URLSearchParams(searchParams);
    if (s === 'all') next.delete('status'); else next.set('status', s);
    setSearchParams(next, { replace: true });
  };

  const { data, isLoading, error } = usePurchaseReturns();
  const cancelPr = useCancelPurchaseReturn();

  const allRows = useMemo<PrRow[]>(() => (data?.purchaseReturns ?? []) as PrRow[], [data]);
  const rows = useMemo<PrRow[]>(
    () => (statusChip === 'all' ? allRows : allRows.filter((r) => r.status === statusChip)),
    [allRows, statusChip],
  );
  const columns = useMemo(() => buildPrColumns(), []);

  // Cancel a PR (right-click) — reverses the return server-side (stock goes back
  // in). Confirm first. Mirrors the GRN list's doCancelGrn.
  const doCancelPr = async (r: PrRow) => {
    if (!(await askConfirm({ title: `Cancel return ${r.return_number}?`, body: 'This reverses the return — the goods are put back into stock. Line items stay for audit.', confirmLabel: 'Cancel', danger: true }))) return;
    cancelPr.mutate(r.id, {
      onError: (e) => notify({ title: 'Cancel failed', body: `${e instanceof Error ? e.message : String(e)}`, tone: 'error' }),
    });
  };

  /* Fetch ONE return's full header + items — mirrors usePurchaseReturnDetail's
     queryFn (GET /purchase-returns/:id → { purchaseReturn, items }). The PDF
     generator needs the nested `supplier` + `supplier_id` off the full header,
     which the list rows don't fully carry. */
  const fetchPrBundle = async (id: string): Promise<{ header: unknown; items: unknown[] }> => {
    const res = await authedFetch<{ purchaseReturn: unknown; items: unknown[] }>(`/purchase-returns/${id}`);
    return { header: res.purchaseReturn, items: res.items ?? [] };
  };

  /* Batch "Export PDF" — one selected → its own file; many → ask combined vs
     separate, fetch each detail sequentially, then render. */
  const exportSelected = async () => {
    const selectedRows = rows.filter((r) => sel.has(r.id));
    if (selectedRows.length === 0 || exporting) return;

    if (selectedRows.length === 1) {
      setExporting(true);
      try {
        const bundle = await fetchPrBundle(selectedRows[0]!.id);
        const { generatePurchaseReturnPdf } = await import('../../vendor/scm/lib/purchase-return-pdf');
        await generatePurchaseReturnPdf(bundle.header as never, bundle.items as never);
      } catch (e) {
        notify({ title: 'Export failed', body: `${e instanceof Error ? e.message : String(e)}`, tone: 'error' });
      } finally {
        setExporting(false);
      }
      return;
    }

    const how = await askChoice({
      title: `Download ${selectedRows.length} documents`,
      options: [
        { value: 'one', label: 'One combined PDF', detail: 'All returns in a single file' },
        { value: 'many', label: 'Separate files', detail: 'One PDF per return' },
      ],
    });
    if (how == null) return;

    setExporting(true);
    try {
      const bundles: Array<{ header: unknown; items: unknown[] }> = [];
      for (const r of selectedRows) bundles.push(await fetchPrBundle(r.id));
      if (how === 'one') {
        const { generateCombinedPurchaseReturnPdf } = await import('../../vendor/scm/lib/purchase-return-pdf');
        await generateCombinedPurchaseReturnPdf(bundles as never, {
          fileName: `purchase-returns-${new Date().toISOString().slice(0, 10)}.pdf`,
        });
      } else {
        const { generatePurchaseReturnPdf } = await import('../../vendor/scm/lib/purchase-return-pdf');
        for (const b of bundles) await generatePurchaseReturnPdf(b.header as never, b.items as never);
      }
    } catch (e) {
      notify({ title: 'Export failed', body: `${e instanceof Error ? e.message : String(e)}`, tone: 'error' });
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div>
          <h1 className={styles.title}>Purchase Returns</h1>
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          {/* A Purchase Return starts from a Goods Receipt — this routes to the
              GRN list where the user right-clicks "Convert to PR". */}
          <Button variant="ghost" size="sm" onClick={() => navigate('/scm/grns')}>
            <ArrowRightLeft {...ICON} />
            <span>From Goods Receipt</span>
          </Button>
          <Button variant="primary" size="sm" onClick={() => navigate('/scm/purchase-returns/new')}>
            <Plus {...ICON} />
            <span>New Purchase Return</span>
          </Button>
        </div>
      </div>

      <p className={styles.eyebrow}>
        {isLoading ? 'Loading returns…' : `${rows.length} purchase returns`}
      </p>

      {error && !isLoading && (
        <div className={styles.bannerWarn}>
          <strong>Failed to load purchase returns.</strong>{' '}
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
            {s === 'all' ? 'All' : statusLabel('pr', s)}
          </button>
        ))}
      </div>

      {/* Batch toolbar — mirrors the PO list selected-row banner. */}
      {sel.size > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: 'var(--space-3) var(--space-4)',
          background: 'rgba(232, 107, 58, 0.08)',
          border: '1px solid var(--c-orange)',
          borderRadius: 'var(--radius-md)',
          gap: 'var(--space-3)',
        }}>
          <span style={{ fontWeight: 600, color: 'var(--c-burnt)' }}>
            {sel.size} selected
          </span>
          <span style={{ display: 'inline-flex', gap: 'var(--space-2)' }}>
            <Button variant="ghost" size="sm" onClick={() => setSel(new Set())}>Clear</Button>
            <Button variant="ghost" size="sm" onClick={() => void exportSelected()} disabled={exporting}>
              <Printer size={14} strokeWidth={1.75} />
              <span>{exporting ? 'Preparing…' : `Export PDF (${sel.size})`}</span>
            </Button>
          </span>
        </div>
      )}

      <DataGrid<PrRow>
        rows={rows}
        columns={columns}
        storageKey={PR_LIST_STORAGE_KEY}
        exportName="Purchase Returns"
        rowKey={(r) => r.id}
        searchPlaceholder="Search returns…"
        groupBanner={false}
        selectable={{
          selectedKeys: sel,
          onToggle: (k) => setSel((p) => { const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); return n; }),
          onToggleAll: (keys, allSel) => setSel((p) => {
            const n = new Set(p);
            if (allSel) { for (const k of keys) n.delete(k); } else { for (const k of keys) n.add(k); }
            return n;
          }),
        }}
        /* Open on DOUBLE-click; right-click → context menu (mirrors the GRN list). */
        onRowDoubleClick={(r) => navigate(`/scm/purchase-returns/${r.id}`)}
        /* Completed / cancelled returns grey out so they read as locked / done. */
        rowStyle={(r) => r.status === 'COMPLETED' || r.status === 'CANCELLED'
          ? { opacity: 0.6, filter: 'grayscale(0.4)' }
          : undefined}
        /* Click a row → reveal full line-item detail (mirrors the PO list). */
        expandable={{
          renderExpansion: (r) => <ExpandedPrLines pr={r} />,
          rowExpansionKey: (r) => r.id,
        }}
        contextMenu={(r) => {
          // Mirror the PO/GRN list's right-click menu: View / Edit · divider ·
          // Cancel (danger). View opens read-only; Edit lands on the detail page
          // with ?edit=1 (the draft-edit gate flips straight into Edit mode).
          const menu: Array<{ label?: string; onClick?: () => void; danger?: boolean; divider?: true }> = [
            { label: 'View', onClick: () => navigate(`/scm/purchase-returns/${r.id}`) },
            { label: 'Edit', onClick: () => navigate(`/scm/purchase-returns/${r.id}?edit=1`) },
          ];
          // Cancel — soft-stop. Hidden once cancelled / completed.
          if (r.status !== 'CANCELLED' && r.status !== 'COMPLETED') {
            menu.push({ divider: true as const });
            menu.push({ label: 'Cancel', danger: true, onClick: () => doCancelPr(r) });
          }
          return menu;
        }}
        isLoading={isLoading}
        emptyMessage='No returns yet — convert a Goods Receipt via "From GRN".'
      />
    </div>
  );
};
