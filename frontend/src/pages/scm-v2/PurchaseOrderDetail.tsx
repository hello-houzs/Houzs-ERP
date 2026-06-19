// ----------------------------------------------------------------------------
// PurchaseOrderDetail — full-page route at /scm/purchase-orders/:id (PR #41).
//
// Apply SO Detail template to PO so PO→GRN→PI conversions preserve all
// variant data (sofa color, bedframe D1/divan/leg/special).
//
//   1. Header: back button + PO# · supplier + status pill + actions
//   2. Supplier card: editable supplier picker + dates + currency + notes
//   3. Line items table: code + group + variants summary + qty + unit + total
//   4. Totals card: subtotal + total
//   5. Status flow: Draft → Submitted → Partially Received → Received | Cancelled
//
// Commander 2026-05-29 — PO Edit is a DRAFT (#194). Clicking Edit snapshots the
// header + lets you edit Qty / Unit Price / Disc / Delivery INLINE in each row
// (no per-line modal — "多此一举"). Nothing persists until the single top Save:
//   • Save  → commits header changes + every changed line's field edits
//   • Back  → leaves the page, discarding the field-edit draft (no auto-save —
//             "为什么只是点 Back 也会自动 Save 呢")
//   • Delete (trash) asks an in-app confirm first (Commander 2026-06-15 — no
//     more 裸奔), then removes the line on confirm. A line's
//     add (Convert from SO) and remove both move SO quota server-side, so they
//     are immediate — deleting a converted line releases its SO quota straight
//     away so it reappears in the From-SO picker ("delete 掉…想再加回去却没看到").
//     Only the field edits (Qty / Unit / Disc / Delivery) are draft.
//   • Changing the header Expected Delivery cascades to every line's delivery.
// ----------------------------------------------------------------------------

import { useEffect, useState } from 'react';
// HOUZS VENDOR — Link + useSearchParams live on 'react-router-dom' in
// react-router v6 (the version Houzs ships); 2990 used v7 where they're on the
// unified 'react-router'. Only the import specifier changed.
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, FileText, Pencil, Trash2, Printer, Save, Ban, ArrowRightLeft,
  ChevronDown, RotateCcw,
} from 'lucide-react';
import { Button } from '@2990s/design-system';
import { buildVariantSummary } from '@2990s/shared'; // Commander 2026-05-28 — Description 2
import {
  usePurchaseOrderDetail,
  useUpdatePurchaseOrderHeader,
  useUpdatePurchaseOrderItem,
  useDeletePurchaseOrderItem,
  useCancelPurchaseOrder,
  useReopenPurchaseOrder,
  useDeletePurchaseOrder,
  useSuppliers,
  useSupplierDetail,
  type PoItemRow,
  type SupplierRow,
} from '../../vendor/scm/lib/suppliers-queries';
import { useWarehouses } from '../../vendor/scm/lib/inventory-queries';
import { MoneyInput } from '../../vendor/scm/components/MoneyInput';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { SkeletonDetailPage } from '../../vendor/scm/components/Skeleton';
import { RelationshipMapButton } from '../../vendor/scm/components/RelationshipMapButton';
import { StatusPill } from '../../vendor/scm/components/StatusPill';
import styles from './SalesOrderDetail.module.css';

const ICON = { size: 16, strokeWidth: 1.75 } as const;
const SM_ICON = { size: 14, strokeWidth: 1.75 } as const;

const fmtRm = (centi: number | null | undefined, currency = 'MYR'): string => {
  const v = centi ?? 0;
  return `${currency} ${(v / 100).toLocaleString('en-MY', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;
};

/* Draft state shapes (#194). HeaderDraft mirrors the editable header fields;
   LineDraft holds the four inline-editable per-line fields. */
type HeaderDraft = {
  supplierId: string;
  poDate: string;
  expectedAt: string;
  currency: string;
  notes: string;
  purchaseLocationId: string;
};
type LineDraft = {
  qty: number;
  unitPriceCenti: number;
  discountCenti: number;
  deliveryDate: string | null;
};

const headerSnapshot = (p: any): HeaderDraft => ({
  supplierId:         p.supplier_id ?? '',
  poDate:             p.po_date ?? '',
  expectedAt:         p.expected_at ?? '',
  currency:           p.currency ?? 'MYR',
  notes:              p.notes ?? '',
  purchaseLocationId: p.purchase_location_id ?? '',
});

const lineSnapshot = (it: PoItemRow): LineDraft => ({
  qty:            it.qty,
  unitPriceCenti: it.unit_price_centi,
  discountCenti:  it.discount_centi ?? 0,
  deliveryDate:   it.delivery_date ?? null,
});

export const PurchaseOrderDetail = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const detail = usePurchaseOrderDetail(id ?? null);
  const updateHeader = useUpdatePurchaseOrderHeader();
  // PR-DRAFT-removal — Submit button removed (POs are SUBMITTED on create).
  const cancel = useCancelPurchaseOrder();
  const reopen = useReopenPurchaseOrder();
  const deletePo = useDeletePurchaseOrder();
  const updateItem = useUpdatePurchaseOrderItem();
  const deleteItem = useDeletePurchaseOrderItem();
  const askConfirm = useConfirm();
  const notify = useNotify();
  // PR #102 — PO PDF (AutoCount layout) needs the Purchase Location's
  // human-readable name; the header only carries the warehouse id. Load
  // warehouses once at the top so the print handler can resolve it.
  const warehousesQTop = useWarehouses();

  const po = detail.data?.purchaseOrder ?? null;
  const items = detail.data?.items ?? [];

  /* View → Edit gate (Commander 2026-05-29) — default is read-only View; click
     Edit to flip into draft mode. The PO list's right-click "Edit" lands here
     with ?edit=1, so open straight into Edit in that case. */
  const [searchParams] = useSearchParams();
  const [isEditing, setIsEditing] = useState(() => searchParams.get('edit') === '1');

  /* #194 draft buffers. headerDraft is null until the first header field is
     touched (then seeded from the PO). lineDrafts overlays per-line edits keyed
     by item id; any line without an entry just shows its stored values.
     deletedIds stages removals. None of this persists until Save. */
  const [headerDraft, setHeaderDraft] = useState<HeaderDraft | null>(null);
  const [lineDrafts, setLineDrafts] = useState<Record<string, LineDraft>>({});
  const [savingDraft, setSavingDraft] = useState(false);

  // PR-DRAFT-removal — POs are always SUBMITTED on create (no DRAFT). Header
  // edits stay open while the PO can still be received (SUBMITTED / PARTIALLY_RECEIVED).
  // Tier 2 downstream-lock — also lock once a non-cancelled GRN exists; the GRN
  // must be cancelled / deleted before editing again. Partial receiving (more
  // GRNs) is still allowed via the list's Convert-to-GRN action.
  const hasChildren = Boolean(po?.has_children);
  const isLocked = po ? (!(po.status === 'SUBMITTED' || po.status === 'PARTIALLY_RECEIVED') || hasChildren) : true;
  const lockedDueToChildren = po ? ((po.status === 'SUBMITTED' || po.status === 'PARTIALLY_RECEIVED') && hasChildren) : false;

  /* If a PO locks while we're in Edit mode (e.g. it's Received / Cancelled
     after a status change), drop back to View and discard the draft so the
     page can never present editable controls on a locked PO. */
  useEffect(() => {
    if (isLocked && isEditing) {
      setIsEditing(false);
      setHeaderDraft(null);
      setLineDrafts({});
    }
  }, [isLocked, isEditing]);

  if (detail.isLoading) {
    return <SkeletonDetailPage />;
  }
  if (detail.isError || !po) {
    return (
      <div className={styles.page}>
        <Link to="/scm/purchase-orders" className={styles.backBtn}>
          <ArrowLeft {...ICON} />
          <span>Back</span>
        </Link>
        <div className={styles.bannerWarn}>
          <strong>Purchase order not found.</strong>
          {detail.error instanceof Error ? ` ${detail.error.message}` : null}
        </div>
      </div>
    );
  }

  /* ── Draft helpers (po is guaranteed non-null past the guards above) ── */
  /* Commander 2026-05-29 — line add/remove are immediate server actions (they
     move SO quota), so the table shows the live items straight from the server;
     only the per-line field edits are buffered in lineDrafts. */
  const visibleItems = items;
  /* SO→PO drift (Commander 2026-06-16) — lines whose source SO was edited AFTER
     this PO was raised, so the PO no longer matches the live SO. Only actionable
     while the PO is still open (pre-receipt): a received / cancelled PO can't be
     re-sent anyway, so we hide the warning there. */
  const driftCount = visibleItems.filter((it) => it.so_drift).length;
  const showDrift = po.status === 'SUBMITTED' || po.status === 'PARTIALLY_RECEIVED';
  const lineOf = (it: PoItemRow): LineDraft => lineDrafts[it.id] ?? lineSnapshot(it);
  const lineTotalOf = (it: PoItemRow): number => {
    if (!isEditing) return it.line_total_centi ?? 0;
    const d = lineOf(it);
    return d.qty * d.unitPriceCenti - d.discountCenti;
  };
  const itemsSubtotal = visibleItems.reduce((s, it) => s + lineTotalOf(it), 0);
  const grandTotal = itemsSubtotal + (po.tax_centi ?? 0);

  /* Per-line "Received" cell — which Goods Receipt took how much off this line,
     plus the live balance still outstanding. Mirrors the SO "Delivered" column.
     Cancelled GRNs are already excluded server-side. */
  const renderReceived = (it: PoItemRow) => {
    const receipts = it.receipts ?? [];
    if (receipts.length === 0) return <span className={styles.muted}>—</span>;
    const remaining = Math.max(0, it.qty - (it.received_qty ?? 0));
    return (
      <div>
        {receipts.map((r, ri) => (
          <div key={ri} style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
            {r.grnNumber} <span className={styles.muted} style={{ fontWeight: 400 }}>×{r.qty}</span>
          </div>
        ))}
        <div style={{
          fontSize: 'var(--fs-11)', marginTop: 1,
          color: remaining > 0 ? 'var(--c-festive-b, #B8331F)' : 'var(--c-secondary-a, #2F5D4F)',
        }}>
          {remaining > 0 ? `Balance ${remaining}` : 'Fully received'}
        </div>
      </div>
    );
  };

  const headerView = headerDraft ?? headerSnapshot(po);

  const setHeaderField = (k: keyof HeaderDraft, v: string) => {
    setHeaderDraft((h) => ({ ...(h ?? headerSnapshot(po)), [k]: v }));
    // Commander 2026-05-29 — header Expected Delivery cascades to every line's
    // delivery date ("上面的 Expected Delivery Date 换了之后，下面 Item 的
    // Delivery Date 也要跟着跳").
    if (k === 'expectedAt') {
      setLineDrafts((prev) => {
        const next = { ...prev };
        for (const it of items) {
          next[it.id] = { ...(prev[it.id] ?? lineSnapshot(it)), deliveryDate: v || null };
        }
        return next;
      });
    }
  };

  const setLine = (it: PoItemRow, patch: Partial<LineDraft>) =>
    setLineDrafts((prev) => ({ ...prev, [it.id]: { ...(prev[it.id] ?? lineSnapshot(it)), ...patch } }));

  const enterEdit = () => {
    setHeaderDraft(null);
    setLineDrafts({});
    setIsEditing(true);
  };

  /* Single Save (#194) — commit header (only if touched) + every changed line's
     field edits, then drop back to View. Back discards the field-edit draft.
     (Line add/remove already committed server-side — see the trash handler.) */
  const handleSave = async () => {
    if (savingDraft) return;
    setSavingDraft(true);
    try {
      if (headerDraft) {
        await updateHeader.mutateAsync({ id: po.id, ...(headerDraft as Record<string, unknown>) });
      }
      for (const it of items) {
        const d = lineDrafts[it.id];
        if (!d) continue;
        const changed =
          d.qty !== it.qty ||
          d.unitPriceCenti !== it.unit_price_centi ||
          d.discountCenti !== (it.discount_centi ?? 0) ||
          (d.deliveryDate ?? null) !== (it.delivery_date ?? null);
        if (changed) {
          await updateItem.mutateAsync({
            poId: po.id, itemId: it.id,
            qty: d.qty, unitPriceCenti: d.unitPriceCenti,
            discountCenti: d.discountCenti, deliveryDate: d.deliveryDate,
          });
        }
      }
      setIsEditing(false);
      setHeaderDraft(null);
      setLineDrafts({});
    } catch (e) {
      notify({ title: 'Save failed', body: `${e instanceof Error ? e.message : String(e)}`, tone: 'error' });
    } finally {
      setSavingDraft(false);
    }
  };

  const handlePrint = () => {
    // PR #102 — pre-resolve purchase_location name (PDF can't hit the API).
    const wh = (warehousesQTop.data ?? []).find((w) => w.id === po.purchase_location_id);
    const headerForPdf = {
      ...po,
      purchase_location_name: wh ? `${wh.code} · ${wh.name}` : null,
      // #1 (Commander 2026-06-18) — deliver-to address = the bound warehouse's
      // location text, so the supplier knows where to ship.
      delivery_address: wh?.location ?? null,
      // your_ref_no / source_so_doc_no don't have columns yet; pass through
      // when present on po (forward-compat). Schema follow-up adds them.
      your_ref_no:      (po as unknown as { your_ref_no?: string | null }).your_ref_no      ?? null,
      source_so_doc_no: (po as unknown as { source_so_doc_no?: string | null }).source_so_doc_no ?? null,
    };
    import('../../vendor/scm/lib/purchase-order-pdf').then(({ generatePurchaseOrderPdf }) =>
      generatePurchaseOrderPdf(headerForPdf, items),
    ).catch((e) => notify({ title: 'PDF generation failed', body: `${e instanceof Error ? e.message : String(e)}`, tone: 'error' }));
  };

  return (
    <div className={styles.page}>
      {/* Commander 2026-05-29 — dropped the GRNs/Invoice/Returns smart-button
          row + the "PO date · N lines · Expected" subtitle (not needed). */}

      {/* ── Header ──────────────────────────────────────────────── */}
      <div className={styles.headerRow}>
        <div className={styles.titleBlock}>
          <Link to="/scm/purchase-orders" className={styles.backBtn}>
            <ArrowLeft {...ICON} />
            <span>Back</span>
          </Link>
          <div>
            <h1 className={styles.title}>
              {/* PR — Commander 2026-05-27: icon shrinks from 20 → 14 to
                  balance the fs-15 title. */}
              <FileText size={14} strokeWidth={1.75} style={{ color: 'var(--c-burnt)' }} />
              {po.po_number} — {po.supplier?.name ?? po.supplier?.code ?? '—'}
            </h1>
          </div>
        </div>
        <div className={styles.actions}>
          {/* PR — Commander 2026-05-27: align with SO Detail PR #231 — total
              moves into a right-rail KPI tile next to the action group so the
              page title stays compact. Commander 2026-05-29 — the total tracks
              the live line items (incl. unsaved draft edits). */}
          <div className={styles.totalRail}>
            <span className={styles.totalRailLabel}>Total</span>
            <span className={styles.totalRailValue}>{fmtRm(grandTotal, po.currency)}</span>
          </div>
          <StatusPill docType="po" status={po.status} />
          <RelationshipMapButton type="po" id={po.id} />
          <Button variant="ghost" size="md" onClick={handlePrint}>
            <Printer {...ICON} />
            <span>Print PDF</span>
          </Button>
          {/* PR #78 — Convert from Sales Order. Gated behind Edit mode (it
              mutates line items). Commander 2026-05-29 — opens the full "Pick
              Sales Orders for this PO" picker scoped to this PO's supplier. */}
          {isEditing && (po.status === 'SUBMITTED' || po.status === 'PARTIALLY_RECEIVED') && (
            <Button
              variant="ghost"
              size="md"
              onClick={() => navigate(`/scm/purchase-orders/from-so?poId=${po.id}`)}
            >
              <ArrowRightLeft {...ICON} />
              <span>From Sales Order</span>
            </Button>
          )}
          {/* PR — Commander 2026-05-27: "Cancel/Delete PO 没反应".
              Cancel: any pre-receipt status. API blocks RECEIVED.
              Delete: only CANCELLED (after migration 0078; DRAFT no longer exists). */}
          {(po.status === 'SUBMITTED' || po.status === 'PARTIALLY_RECEIVED') && (
            <Button variant="ghost" size="md"
              onClick={async () => {
                if (!(await askConfirm({ title: `Cancel PO ${po.po_number}?`, body: 'This sets status to CANCELLED — line items + linked docs stay for audit.', confirmLabel: 'Cancel PO', danger: true }))) return;
                cancel.mutate(po.id, {
                  onError: (err) => notify({ title: 'Cancel failed', body: `${err instanceof Error ? err.message : String(err)}`, tone: 'error' }),
                });
              }}
              disabled={cancel.isPending}>
              <Ban {...ICON} />
              <span>{cancel.isPending ? 'Cancelling…' : 'Cancel'}</span>
            </Button>
          )}
          {/* Reopen a cancelled PO (Commander 2026-06-16 — "PO cancel 了 不可以
              uncancel 回来吗?"). Inverse of Cancel: back to SUBMITTED and the
              converted SO lines re-claim their quota. In-app confirm (no 裸奔). */}
          {po.status === 'CANCELLED' && (
            <Button variant="ghost" size="md"
              onClick={async () => {
                if (await askConfirm({
                  title: `Reopen PO ${po.po_number}?`,
                  body: 'Status returns to SUBMITTED and this PO re-claims its Sales-Order quota (those lines leave the From-SO picker again).',
                  confirmLabel: 'Reopen',
                })) {
                  reopen.mutate(po.id, {
                    onError: (err) => notify({ title: 'Reopen failed', body: `${err instanceof Error ? err.message : String(err)}`, tone: 'error' }),
                  });
                }
              }}
              disabled={reopen.isPending}>
              <RotateCcw {...ICON} />
              <span>{reopen.isPending ? 'Reopening…' : 'Reopen'}</span>
            </Button>
          )}
          {po.status === 'CANCELLED' && (
            <Button variant="ghost" size="md"
              onClick={async () => {
                if (!(await askConfirm({ title: `Permanently delete PO ${po.po_number}?`, body: 'This removes the header + all line items and cannot be undone.', confirmLabel: 'Delete', danger: true }))) return;
                deletePo.mutate(po.id, {
                  onSuccess: () => navigate('/scm/purchase-orders'),
                  onError:   (err) => notify({ title: 'Delete failed', body: `${err instanceof Error ? err.message : String(err)}`, tone: 'error' }),
                });
              }}
              disabled={deletePo.isPending}>
              <Trash2 {...ICON} />
              <span>{deletePo.isPending ? 'Deleting…' : 'Delete'}</span>
            </Button>
          )}
          {/* PR — Phase 2: "Receive Goods" → /grns/new?poId=X. */}
          {(po.status === 'SUBMITTED' || po.status === 'PARTIALLY_RECEIVED') && (
            <Button variant="primary" size="md"
              onClick={() => navigate(`/grns/new?poId=${po.id}`)}>
              <span>Receive Goods</span>
            </Button>
          )}
          {/* PR — Phase 4: "Raise Return" available once any qty has been
              received. Pre-fills the return page with this PO's lines +
              supplier. */}
          {(po.status === 'PARTIALLY_RECEIVED' || po.status === 'RECEIVED') && (
            <Button variant="ghost" size="md"
              onClick={() => navigate(`/purchase-returns/new?poId=${po.id}`)}>
              <span>Raise Return</span>
            </Button>
          )}
          {/* View → Edit gate (Commander 2026-05-29). Default View shows a
              primary Edit button (disabled while the PO is locked). Editing
              flips into draft mode; the button becomes the single "Save" that
              commits the whole draft. Back (top-left) discards. */}
          {!isEditing ? (
            <Button variant="primary" size="md" onClick={enterEdit} disabled={isLocked}>
              <Pencil {...ICON} />
              <span>Edit</span>
            </Button>
          ) : (
            <Button variant="primary" size="md" onClick={handleSave} disabled={savingDraft}>
              <Save {...ICON} />
              <span>{savingDraft ? 'Saving…' : 'Save'}</span>
            </Button>
          )}
        </div>
      </div>

      {/* Tier 2 downstream-lock — once any GRN is created from this PO the page
          becomes read-only + un-cancellable. Partial receiving (more GRNs) is
          still allowed via the list's Convert-to-GRN. */}
      {lockedDueToChildren && (
        <div className={styles.bannerWarn} style={{ marginBottom: 'var(--space-3)' }}>
          <strong>Locked — has a Goods Receipt.</strong>{' '}
          Cancel or delete the downstream GRN to edit this PO again.
        </div>
      )}

      {/* ── Supplier / dates / currency / notes ─────────────────── */}
      {/* In View the card renders read-only text; in Edit it shows inputs bound
          to the draft (committed by the single top Save — the card no longer
          has its own Save button). */}
      <SupplierCard
        po={po}
        draft={headerView}
        onField={setHeaderField}
        locked={isLocked}
        isEditing={isEditing}
      />

      {/* ── Line items ──────────────────────────────────────────── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Line Items ({visibleItems.length})</h2>
        </header>

        {/* SO→PO drift banner — the source SO changed after this PO was raised.
            We never auto-edit a PO that may already be with the supplier; the
            purchaser syncs + re-sends. (Commander 2026-06-16.) */}
        {showDrift && driftCount > 0 && (
          <div className={styles.bannerWarn} style={{ margin: 'var(--space-2) var(--space-3)' }}>
            ⚠ 有 <strong>{driftCount}</strong> 行的来源 SO 在本 PO 开单后被改过。请核对下方红字、同步规格后<strong>重新发给供应商</strong>,以免工厂照旧规格生产。
          </div>
        )}

        {visibleItems.length === 0 ? (
          <p className={styles.emptyRow}>
            {isEditing
              ? 'No items yet — click "From Sales Order" above to add lines.'
              : 'No items yet — click "Edit" then "From Sales Order" to add lines.'}
          </p>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Item</th>
                {/* Supplier-facing dual-code rule (Commander) — the supplier's
                    own code prints on every purchasing doc; surface the
                    snapshotted line supplier_sku here too. */}
                <th>Supplier Code</th>
                <th>Group</th>
                <th className={styles.tableRight}>Qty</th>
                <th>Transfer To (GRN)</th>
                <th className={styles.tableRight}>Unit</th>
                <th className={styles.tableRight}>Disc</th>
                <th className={styles.tableRight}>Total</th>
                {/* Commander 2026-05-29 — a PO line has ONE price (Unit = what
                    we pay the supplier); the separate Unit Cost / Total Cost
                    columns were dropped ("它的价钱到底是哪一个"). Keep the
                    per-line delivery date. */}
                <th className={styles.tableRight}>Delivery</th>
                {/* Actions column only in Edit mode — View is read-only. */}
                {isEditing && <th className={styles.tableRight}>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {visibleItems.map((it) => {
                const d = lineOf(it);
                return (
                  <tr key={it.id}>
                    <td>
                      {/* Commander 2026-05-29 — show the item CODE only; the
                          variant summary stays (that's WHAT was ordered). */}
                      <div className={styles.codeCell}>{it.material_code}</div>
                      {(() => {
                        const summary = buildVariantSummary(it.item_group, it.variants as Record<string, unknown> | null)
                          || it.description
                          || it.material_name;
                        return summary ? <div className={styles.muted} style={{ fontSize: 'var(--fs-11)' }}>{summary}</div> : null;
                      })()}
                      {showDrift && it.so_drift && (
                        <div style={{ marginTop: 3, fontSize: 'var(--fs-11)', fontWeight: 700, color: 'var(--c-danger, #b8331f)' }}>
                          {it.so_drift.itemChanged
                            ? <>⚠ SO 已换产品 → {it.so_drift.itemSo}(本单仍是 {it.so_drift.itemPo}),建议取消重开</>
                            : <>⚠ SO 现规格:{it.so_drift.specSo || '—'}(本单仍是 {it.so_drift.specPo || '—'})</>}
                        </div>
                      )}
                    </td>
                    <td style={{ fontFamily: 'var(--font-mono)' }}>{it.supplier_sku?.trim() || '—'}</td>
                    <td className={styles.muted}>{it.item_group ?? it.material_kind}</td>

                    {/* Commander 2026-05-29 (#194) — Qty / Unit / Disc / Delivery
                        are inline-editable in Edit mode (no per-line modal). */}
                    {isEditing ? (
                      <>
                        <td className={styles.tableRight}>
                          <input
                            type="number"
                            min={0}
                            className={styles.fieldInput}
                            style={{ width: 70, textAlign: 'right' }}
                            value={d.qty}
                            disabled={isLocked}
                            onChange={(e) => setLine(it, { qty: Number(e.target.value) || 0 })}
                          />
                        </td>
                        <td>{renderReceived(it)}</td>
                        <td className={styles.tableRight}>
                          <MoneyInput bare selectOnFocus inputClassName={styles.fieldInput}
                            style={{ width: 110, textAlign: 'right' }}
                            valueSen={d.unitPriceCenti}
                            disabled={isLocked}
                            onCommit={(sen) => setLine(it, { unitPriceCenti: sen ?? 0 })} />
                        </td>
                        <td className={styles.tableRight}>
                          <MoneyInput bare selectOnFocus inputClassName={styles.fieldInput}
                            style={{ width: 100, textAlign: 'right' }}
                            valueSen={d.discountCenti}
                            disabled={isLocked}
                            onCommit={(sen) => setLine(it, { discountCenti: sen ?? 0 })} />
                        </td>
                        <td className={styles.priceCell}>{fmtRm(d.qty * d.unitPriceCenti - d.discountCenti, po.currency)}</td>
                        <td className={styles.tableRight}>
                          <input
                            type="date"
                            className={styles.fieldInput}
                            style={{ width: 150 }}
                            value={d.deliveryDate ?? ''}
                            disabled={isLocked}
                            onChange={(e) => setLine(it, { deliveryDate: e.target.value || null })}
                          />
                        </td>
                        <td>
                          <span className={styles.actionsCell}>
                            <button type="button"
                              className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                              title="Remove line" disabled={isLocked || deleteItem.isPending}
                              /* Commander 2026-06-15 — confirm before delete (no
                                 more 裸奔). On confirm the line is removed and its
                                 converted SO quota is released back to the From-SO
                                 picker. */
                              onClick={async () => {
                                if (isLocked) return;
                                if (await askConfirm({
                                  title: 'Remove this line?',
                                  body: "The line is deleted and its converted SO quantity is released back to the From-SO picker.",
                                  confirmLabel: 'Remove',
                                  danger: true,
                                })) {
                                  deleteItem.mutate({ poId: po.id, itemId: it.id });
                                }
                              }}>
                              <Trash2 {...SM_ICON} />
                            </button>
                          </span>
                        </td>
                      </>
                    ) : (
                      <>
                        <td className={styles.tableRight}>{it.qty}</td>
                        <td>{renderReceived(it)}</td>
                        <td className={styles.tableRight}>{fmtRm(it.unit_price_centi, po.currency)}</td>
                        <td className={styles.tableRight}>{(it.discount_centi ?? 0) > 0 ? fmtRm(it.discount_centi, po.currency) : '—'}</td>
                        <td className={styles.priceCell}>{fmtRm(it.line_total_centi, po.currency)}</td>
                        <td className={styles.tableRight}>{it.delivery_date ?? '—'}</td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {/* ── Totals ────────────────────────────────────────────────── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Totals</h2>
        </header>
        <div className={styles.cardBody}>
          {/* Commander 2026-05-29 — subtotal/total computed LIVE from the visible
              line items (incl. unsaved draft edits) so they can never drift.
              Tax stays the stored header value. */}
          <div className={styles.totalsGrid}>
            <div className={styles.totalRow}>
              <span className={styles.totalLabel}>Subtotal</span>
              <span className={styles.totalValue}>{fmtRm(itemsSubtotal, po.currency)}</span>
            </div>
            <div className={styles.totalRow}>
              <span className={styles.totalLabel}>Tax</span>
              <span className={styles.totalValue}>{fmtRm(po.tax_centi, po.currency)}</span>
            </div>
            <div className={`${styles.totalRow} ${styles.grandTotalRow}`}>
              <span className={styles.totalLabel}>Total</span>
              <span className={`${styles.totalValue} ${styles.grandTotal}`}>{fmtRm(grandTotal, po.currency)}</span>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};

/* ════════════════════════════════════════════════════════════════════════
   Supplier / header card — controlled by the page's draft (#194)
   ════════════════════════════════════════════════════════════════════════ */

const SupplierCard = ({
  po, draft, onField, locked, isEditing = true,
}: {
  po: any;
  /** Draft header values (page-owned). In View these mirror the saved PO. */
  draft: HeaderDraft;
  /** Update a single header field on the page draft. */
  onField: (k: keyof HeaderDraft, v: string) => void;
  locked: boolean;
  /** View → Edit gate. When false the card renders read-only display text. */
  isEditing?: boolean;
}) => {
  const suppliersQ = useSuppliers();
  const suppliers = suppliersQ.data ?? [];
  // PR #77 — header Purchase Location dropdown options.
  const warehousesQ = useWarehouses();
  const warehouses = warehousesQ.data ?? [];
  // PR #75 — auto-fill supplier info card from /suppliers/:id. In Edit follow
  // the draft's picked supplier; in View follow the saved PO.
  const supplierIdForDetail = isEditing ? (draft.supplierId || null) : (po.supplier_id ?? null);
  const supplierDetail = useSupplierDetail(supplierIdForDetail);
  const supplier: SupplierRow | null = supplierDetail.data?.supplier ?? null;

  return (
    <section className={styles.card}>
      <header className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>Supplier · Dates · Notes</h2>
        {/* Commander 2026-05-29 — the card's own Save is gone; the single top
            "Save" commits the whole PO draft (header + line edits). */}
      </header>
      <div className={styles.cardBody}>
        {!isEditing ? (
          /* View mode — read-only display text sourced from the saved PO. */
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(4, 1fr)',
              gap: 'var(--space-3) var(--space-4)',
              fontFamily: 'var(--font-sans)',
              fontSize: 'var(--fs-13)',
            }}
          >
            <div style={{ gridColumn: 'span 2' }}>
              <InfoCell label="Supplier"
                value={po.supplier?.name ?? po.supplier?.code ?? supplier?.name ?? supplier?.code ?? null} />
            </div>
            <InfoCell label="Currency" value={po.currency || null} />
            <div />
            <InfoCell label="PO Date" value={po.po_date || null} />
            <InfoCell label="Expected Delivery" value={po.expected_at || null} />
            <InfoCell label="Purchase Location"
              value={(() => {
                const wh = warehouses.find((w) => w.id === po.purchase_location_id);
                return wh ? `${wh.code} · ${wh.name}` : null;
              })()} />
            <div style={{ gridColumn: 'span 2' }}>
              <InfoCell label="Deliver To"
                value={(() => {
                  const wh = warehouses.find((w) => w.id === po.purchase_location_id);
                  return wh?.location || null;
                })()} />
            </div>
            <div style={{ gridColumn: 'span 2' }}>
              <InfoCell label="Notes" value={po.notes || null} />
            </div>
          </div>
        ) : (
        <div className={styles.formGrid4}>
          <label className={styles.field} style={{ gridColumn: 'span 2' }}>
            <span className={styles.fieldLabel}>Supplier *</span>
            <span className={styles.selectWrap}>
              <select className={styles.fieldSelect} value={draft.supplierId} disabled={locked}
                onChange={(e) => onField('supplierId', e.target.value)}>
                <option value="">— Pick supplier —</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>{s.code} · {s.name}</option>
                ))}
              </select>
              <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
            </span>
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Currency</span>
            <span className={styles.selectWrap}>
              <select className={styles.fieldSelect} value={draft.currency} disabled={locked}
                onChange={(e) => onField('currency', e.target.value)}>
                <option value="MYR">MYR</option>
                <option value="RMB">RMB</option>
                <option value="USD">USD</option>
                <option value="SGD">SGD</option>
              </select>
              <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
            </span>
          </label>
          <div />
          <label className={styles.field}>
            <span className={styles.fieldLabel}>PO Date</span>
            <input type="date" className={styles.fieldInput} value={draft.poDate} disabled={locked}
              onChange={(e) => onField('poDate', e.target.value)} />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Expected Delivery</span>
            {/* Commander 2026-05-29 — changing this cascades to every line's
                Delivery Date (handled in the page's setHeaderField). */}
            <input type="date" className={styles.fieldInput} value={draft.expectedAt} disabled={locked}
              onChange={(e) => onField('expectedAt', e.target.value)} />
          </label>
          {/* PR #77 — Purchase Location: default ship-to warehouse for
              every line on this PO. */}
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Purchase Location</span>
            <span className={styles.selectWrap}>
              <select className={styles.fieldSelect} value={draft.purchaseLocationId} disabled={locked}
                onChange={(e) => onField('purchaseLocationId', e.target.value)}>
                <option value="">— No default —</option>
                {warehouses.filter((w) => w.is_active).map((w) => (
                  <option key={w.id} value={w.id}>{w.code} · {w.name}</option>
                ))}
              </select>
              <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
            </span>
          </label>
          <label className={styles.field} style={{ gridColumn: 'span 2' }}>
            <span className={styles.fieldLabel}>Notes</span>
            <input className={styles.fieldInput} value={draft.notes} disabled={locked}
              onChange={(e) => onField('notes', e.target.value)} />
          </label>
        </div>
        )}

        {/* PR #75 — supplier-info auto-fill card. Read-only display sourced
            from /suppliers/:id. */}
        {supplier && (
          <div
            style={{
              marginTop: 'var(--space-3)',
              padding: 'var(--space-3) var(--space-4)',
              background: 'var(--c-cream)',
              border: '1px solid var(--line)',
              borderRadius: 'var(--radius-md)',
              display: 'grid',
              gridTemplateColumns: 'repeat(4, 1fr)',
              gap: 'var(--space-3) var(--space-4)',
              fontFamily: 'var(--font-sans)',
              fontSize: 'var(--fs-13)',
            }}
          >
            <InfoCell label="Supplier code" value={supplier.code} />
            <InfoCell label="Contact"       value={supplier.contact_person ?? supplier.attention} />
            <InfoCell label="Phone"         value={supplier.phone ?? supplier.mobile} />
            <InfoCell label="Payment terms" value={supplier.payment_terms} />
            <InfoCell label="Email"         value={supplier.email} />
            <InfoCell label="TIN"           value={supplier.tin_number} />
            <InfoCell label="Country / state" value={[supplier.country, supplier.state].filter(Boolean).join(' / ') || null} />
            <InfoCell label="Bindings count" value={String(supplierDetail.data?.bindings?.length ?? 0)} />
            <div style={{ gridColumn: '1 / -1', color: 'var(--fg-muted)' }}>
              <span style={{ fontSize: 'var(--fs-11)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Address ·
              </span>{' '}
              {[supplier.address, supplier.area, supplier.postcode].filter(Boolean).join(', ') || '—'}
            </div>
          </div>
        )}
      </div>
    </section>
  );
};

/* PR #75 — Read-only label/value cell for the supplier auto-fill card. */
function InfoCell({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <div style={{
        fontSize: "var(--fs-11)",
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        color: "var(--fg-muted)",
        marginBottom: 2,
      }}>{label}</div>
      <div style={{ color: value ? "var(--fg)" : "var(--fg-muted)" }}>{value || "—"}</div>
    </div>
  );
}
