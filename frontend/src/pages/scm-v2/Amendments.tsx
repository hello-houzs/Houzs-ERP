// ----------------------------------------------------------------------------
// Amendments — the SO-amendment / revision inbox (Phase 1-C). A DataGrid queue
// of every amendment across all Sales Orders, newest first. HOUZS VENDOR port
// of 2990's apps/backend/src/pages/Amendments.tsx.
//
// Row-click routing (Houzs adaptation): an amendment lives on its SO until the
// SO gate clears, then the bound-PO revision is the live surface. So at/before
// SO_APPROVED we open the SO editor (/scm/sales-orders/:docNo?edit=1 — the amber
// amendment-pending banner lives on the legacy inline editor that Detail-V2
// forwards to on ?edit=1); once the PO gate is reached (PO_APPROVED / SENT) we
// open the bound PO editor (/scm/purchase-orders/:id?edit=1). The list row
// carries only the SO doc_no, so the PO-detail hop resolves the bound PO from
// the amendment detail first, then navigates (falling back to the SO editor if
// the SO has no bound PO).
// ----------------------------------------------------------------------------

import { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { fmtDateTime } from '@2990s/shared';
import { authedFetch } from '../../vendor/scm/lib/authed-fetch';
import { useAmendments, type AmendmentRow, type AmendmentDetail } from '../../vendor/scm/lib/so-amendment-queries';
import { DataGrid, type DataGridColumn } from '../../vendor/scm/components/DataGrid';
import { StatusPill } from '../../vendor/scm/components/StatusPill';
import { statusLabel } from '../../vendor/scm/lib/status-pill';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import styles from './Suppliers.module.css';

// so_amendment_status values: REQUESTED / SUPPLIER_PENDING / SO_APPROVED /
// PO_APPROVED / SENT / REJECTED. Colours + labels come from the canonical
// lib/status-pill 'soAmendment' map via <StatusPill>.
const STATUS_CHIPS = ['all', 'REQUESTED', 'SUPPLIER_PENDING', 'SO_APPROVED', 'PO_APPROVED', 'SENT', 'REJECTED'] as const;

/* Statuses that are still "in the SO's court" — the row opens the SO editor.
   Once the amendment passes the SO gate (PO_APPROVED / SENT) the bound-PO
   revision is the live surface, so those rows open the PO editor instead. */
const AT_OR_BEFORE_SO_APPROVED = new Set(['REQUESTED', 'SUPPLIER_PENDING', 'SO_APPROVED', 'REJECTED']);

/* New unique storage key — NEVER reuse another list's key. */
const AMENDMENT_LIST_STORAGE_KEY = 'so-amendment-list.layout.v1';

const buildAmendmentColumns = (): DataGridColumn<AmendmentRow>[] => [
  {
    key: 'so_doc_no', label: 'SO No.', width: 140, sortable: true, groupable: true,
    accessor: (a) => <span style={{ fontWeight: 700, color: 'var(--c-burnt)', fontVariantNumeric: 'tabular-nums' }}>{a.so_doc_no}</span>,
    searchValue: (a) => a.so_doc_no,
    // accessor is JSX → export the raw SO-no string so the column isn't blank.
    exportValue: (a) => a.so_doc_no,
    groupValue: (a) => a.so_doc_no,
    sortFn: (a, b) => a.so_doc_no.localeCompare(b.so_doc_no),
  },
  {
    key: 'amendment_no', label: 'Amendment No.', width: 140, sortable: true,
    accessor: (a) => <span style={{ fontWeight: 700, color: 'var(--c-burnt)', fontVariantNumeric: 'tabular-nums' }}>{a.amendment_no ?? '—'}</span>,
    searchValue: (a) => String(a.amendment_no ?? ''),
    exportValue: (a) => String(a.amendment_no ?? '—'),
    sortFn: (a, b) => Number(a.amendment_no ?? 0) - Number(b.amendment_no ?? 0),
  },
  {
    key: 'requested_by', label: 'Requested by', width: 200, sortable: true, groupable: true,
    accessor: (a) => a.requested_by ?? '—',
    searchValue: (a) => a.requested_by ?? '',
    groupValue: (a) => a.requested_by ?? '(none)',
    sortFn: (a, b) => (a.requested_by ?? '').localeCompare(b.requested_by ?? ''),
  },
  {
    key: 'reason', label: 'Reason', width: 240, minWidth: 160, sortable: true, defaultHidden: true,
    accessor: (a) => (a.reason ?? '').trim() || <span style={{ color: 'var(--fg-muted)' }}>—</span>,
    searchValue: (a) => a.reason ?? '',
  },
  {
    key: 'status', label: 'Status', width: 150, sortable: true, groupable: true,
    accessor: (a) => <StatusPill docType="soAmendment" status={a.status} />,
    searchValue: (a) => statusLabel('soAmendment', a.status),
    groupValue: (a) => statusLabel('soAmendment', a.status),
    // accessor is a <StatusPill> JSX → export the plain status label text.
    exportValue: (a) => statusLabel('soAmendment', a.status),
    sortFn: (a, b) => a.status.localeCompare(b.status),
  },
  {
    key: 'created_at', label: 'Created', width: 160, sortable: true,
    accessor: (a) => (a.created_at ? fmtDateTime(a.created_at) : '—'),
    searchValue: (a) => a.created_at ?? '',
    sortFn: (a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')),
    filterType: 'date', dateValue: (a) => a.created_at,
  },
];

export const Amendments = () => {
  const navigate = useNavigate();
  const notify = useNotify();
  const [searchParams, setSearchParams] = useSearchParams();
  const statusChip = searchParams.get('status') ?? 'all';
  const setStatusChip = (s: string) => {
    const next = new URLSearchParams(searchParams);
    if (s === 'all') next.delete('status'); else next.set('status', s);
    setSearchParams(next, { replace: true });
  };

  const { data, isLoading, error } = useAmendments();

  const allRows = useMemo<AmendmentRow[]>(() => (data?.amendments ?? []) as AmendmentRow[], [data]);
  const rows = useMemo<AmendmentRow[]>(
    () => (statusChip === 'all' ? allRows : allRows.filter((a) => a.status === statusChip)),
    [allRows, statusChip],
  );
  const columns = useMemo(() => buildAmendmentColumns(), []);

  /* Row-click routing. At/before SO_APPROVED (incl. REJECTED, which never left
     the SO) → the SO editor. Once past the SO gate, resolve the bound PO from
     the amendment detail and open it (fall back to the SO editor if there's no
     bound PO or the lookup fails). Both surfaces open with ?edit=1 so the
     legacy inline editor (which hosts the amendment banners) renders. */
  const openRow = async (a: AmendmentRow) => {
    if (AT_OR_BEFORE_SO_APPROVED.has(a.status)) {
      navigate(`/scm/sales-orders/${a.so_doc_no}?edit=1`);
      return;
    }
    try {
      const detail = await authedFetch<AmendmentDetail>(`/so-amendments/${a.id}`);
      const po = detail.purchaseOrders?.[0];
      if (po?.id) { navigate(`/scm/purchase-orders/${po.id}?edit=1`); return; }
      // No bound PO — fall back to the SO editor (still the correct surface).
      navigate(`/scm/sales-orders/${a.so_doc_no}?edit=1`);
    } catch (e) {
      notify({ title: 'Could not open the revised PO', body: e instanceof Error ? e.message : String(e), tone: 'error' });
      navigate(`/scm/sales-orders/${a.so_doc_no}?edit=1`);
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div>
          <h1 className={styles.title}>Amendments</h1>
        </div>
      </div>

      <p className={styles.eyebrow}>
        {isLoading ? 'Loading amendments…' : `${rows.length} sales order amendment${rows.length === 1 ? '' : 's'}`}
      </p>

      {error && !isLoading && (
        <div className={styles.bannerWarn}>
          <strong>Failed to load amendments.</strong>{' '}
          {error instanceof Error ? error.message : String(error)}
        </div>
      )}

      {/* Status chips — matches the GRN / DR / SI list filter style. */}
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
            {s === 'all' ? 'All' : statusLabel('soAmendment', s)}
          </button>
        ))}
      </div>

      <DataGrid<AmendmentRow>
        rows={rows}
        columns={columns}
        storageKey={AMENDMENT_LIST_STORAGE_KEY}
        exportName="Amendments"
        rowKey={(a) => a.id}
        searchPlaceholder="Search amendments…"
        groupBanner={false}
        /* Open on DOUBLE-click (mirrors the GRN / PO list). */
        onRowDoubleClick={(a) => void openRow(a)}
        /* Closed amendments (SENT / REJECTED) grey out so they read as dead
           (mirrors the GRN list's cancelled/closed treatment). */
        rowStyle={(a) => (a.status === 'REJECTED' || a.status === 'SENT')
          ? { opacity: 0.6, filter: 'grayscale(0.4)' }
          : undefined}
        isLoading={isLoading}
        emptyMessage="No amendments yet — raise one from a processing-locked Sales Order."
      />
    </div>
  );
};

export default Amendments;
