// ----------------------------------------------------------------------------
// PurchaseConsignmentOrderDetail — full-page route at /scm/purchase-consignment-orders/:id.
//
// Faithful clone of PurchaseOrderDetail.tsx: a draft-style View → Edit →
// Save/Back machine. It reuses the SAME shared components UNCHANGED —
// MoneyInput, the supplier picker + supplier / warehouse data hooks — and the
// SAME header card + inline line editor. Only the queries are repointed at
// `/purchase-consignment-orders` (the pc-order hooks) and links go back to
// /purchase-consignment.
//
// Dropped from the PO clone (per scope): the "From Sales Order" picker, the
// per-line "Received (GRN)" breakdown column (consignment receiving lives on
// the parallel Purchase Consignment Receive flow), Print PDF + Relationship Map
// (the flow-graph + PDF engines don't model the consignment doc types). The
// Receive Goods / Raise Return actions point at the parallel consignment
// receive / return New pages.
// ----------------------------------------------------------------------------

import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, FileText, Pencil, Printer, Trash2, Save, Ban, ChevronDown,
} from 'lucide-react';
import { Button } from '@2990s/design-system';
import { buildVariantSummary } from '@2990s/shared';
import {
  usePurchaseConsignmentOrderDetail,
  useUpdatePurchaseConsignmentOrderHeader,
  useUpdatePurchaseConsignmentOrderItem,
  useDeletePurchaseConsignmentOrderItem,
  useCancelPurchaseConsignmentOrder,
  useDeletePurchaseConsignmentOrder,
} from '../../vendor/scm/lib/purchase-consignment-order-queries';
import {
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

export const PurchaseConsignmentOrderDetail = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const detail = usePurchaseConsignmentOrderDetail(id ?? null);
  const updateHeader = useUpdatePurchaseConsignmentOrderHeader();
  const cancel = useCancelPurchaseConsignmentOrder();
  const deletePo = useDeletePurchaseConsignmentOrder();
  const updateItem = useUpdatePurchaseConsignmentOrderItem();
  const deleteItem = useDeletePurchaseConsignmentOrderItem();
  const askConfirm = useConfirm();
  const notify = useNotify();

  const po = detail.data?.purchaseOrder ?? null;
  const items = detail.data?.items ?? [];

  const [searchParams] = useSearchParams();
  const [isEditing, setIsEditing] = useState(() => searchParams.get('edit') === '1');

  const [headerDraft, setHeaderDraft] = useState<HeaderDraft | null>(null);
  const [lineDrafts, setLineDrafts] = useState<Record<string, LineDraft>>({});
  const [savingDraft, setSavingDraft] = useState(false);

  const hasChildren = Boolean(po?.has_children);
  const isLocked = po ? (!(po.status === 'SUBMITTED' || po.status === 'PARTIALLY_RECEIVED') || hasChildren) : true;
  const lockedDueToChildren = po ? ((po.status === 'SUBMITTED' || po.status === 'PARTIALLY_RECEIVED') && hasChildren) : false;

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
        <Link to="/scm/purchase-consignment-orders" className={styles.backBtn}>
          <ArrowLeft {...ICON} />
          <span>Back</span>
        </Link>
        <div className={styles.bannerWarn}>
          <strong>Purchase consignment order not found.</strong>
          {detail.error instanceof Error ? ` ${detail.error.message}` : null}
        </div>
      </div>
    );
  }

  const visibleItems = items;

  /* Per-line "Received" drill-down — which PC Receive took how much (backend
     attaches `receipts` per item via pcoLineReceipts). Mirrors the PO detail. */
  const renderReceived = (it: PoItemRow) => {
    // The PC Order detail backend returns `receipts` keyed by receiveNumber
    // (PcoLineReceipt), distinct from the shared PoItemRow.receipts (grnNumber) —
    // cast through unknown to override that field shape.
    const row = it as unknown as {
      qty?: number;
      received_qty?: number;
      receipts?: Array<{ receiveNumber: string; qty: number; status: string }>;
    };
    const receipts = row.receipts ?? [];
    if (receipts.length === 0) return <span className={styles.muted}>—</span>;
    const remaining = Math.max(0, (it.qty ?? 0) - (row.received_qty ?? 0));
    return (
      <div>
        {receipts.map((r, ri) => (
          <div key={ri} style={{ fontWeight: 600, whiteSpace: 'nowrap', fontSize: 'var(--fs-12)' }}>
            {r.receiveNumber} <span className={styles.muted} style={{ fontWeight: 400 }}>×{r.qty}</span>
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

  const lineOf = (it: PoItemRow): LineDraft => lineDrafts[it.id] ?? lineSnapshot(it);
  const lineTotalOf = (it: PoItemRow): number => {
    if (!isEditing) return it.line_total_centi ?? 0;
    const d = lineOf(it);
    return d.qty * d.unitPriceCenti - d.discountCenti;
  };
  const itemsSubtotal = visibleItems.reduce((s, it) => s + lineTotalOf(it), 0);
  const grandTotal = itemsSubtotal + (po.tax_centi ?? 0);

  const headerView = headerDraft ?? headerSnapshot(po);

  const handlePrint = () => {
    import('../../vendor/scm/lib/purchase-order-pdf')
      .then(({ generatePurchaseOrderPdf }) =>
        generatePurchaseOrderPdf(po as never, items as never, { docTitle: 'PURCHASE CONSIGNMENT ORDER' }))
      .catch((e) => notify({ title: 'PDF generation failed', body: e instanceof Error ? e.message : String(e), tone: 'error' }));
  };

  const setHeaderField = (k: keyof HeaderDraft, v: string) => {
    setHeaderDraft((h) => ({ ...(h ?? headerSnapshot(po)), [k]: v }));
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
      notify({ title: 'Save failed', body: e instanceof Error ? e.message : String(e), tone: 'error' });
    } finally {
      setSavingDraft(false);
    }
  };

  return (
    <div className={styles.page}>
      {/* ── Header ──────────────────────────────────────────────── */}
      <div className={styles.headerRow}>
        <div className={styles.titleBlock}>
          <Link to="/scm/purchase-consignment-orders" className={styles.backBtn}>
            <ArrowLeft {...ICON} />
            <span>Back</span>
          </Link>
          <div>
            <h1 className={styles.title}>
              <FileText size={14} strokeWidth={1.75} style={{ color: 'var(--c-burnt)' }} />
              {po.po_number} — {po.supplier?.name ?? po.supplier?.code ?? '—'}
            </h1>
          </div>
        </div>
        <div className={styles.actions}>
          <div className={styles.totalRail}>
            <span className={styles.totalRailLabel}>Total</span>
            <span className={styles.totalRailValue}>{fmtRm(grandTotal, po.currency)}</span>
          </div>
          <StatusPill docType="po" status={po.status} />
          <RelationshipMapButton type="pco" id={po.id} />
          <Button variant="ghost" size="md" onClick={handlePrint}>
            <Printer {...ICON} /><span>Print PDF</span>
          </Button>
          {(po.status === 'SUBMITTED' || po.status === 'PARTIALLY_RECEIVED') && (
            <Button variant="ghost" size="md"
              onClick={async () => {
                if (!(await askConfirm({
                  title: `Cancel ${po.po_number}?`,
                  body: 'This sets status to CANCELLED — line items + linked docs stay for audit.',
                  confirmLabel: 'Cancel PO',
                  danger: true,
                }))) return;
                cancel.mutate(po.id, {
                  onError: (err) => notify({ title: 'Cancel failed', body: err instanceof Error ? err.message : String(err), tone: 'error' }),
                });
              }}
              disabled={cancel.isPending}>
              <Ban {...ICON} />
              <span>{cancel.isPending ? 'Cancelling…' : 'Cancel'}</span>
            </Button>
          )}
          {po.status === 'CANCELLED' && (
            <Button variant="ghost" size="md"
              onClick={async () => {
                if (!(await askConfirm({
                  title: `Permanently delete ${po.po_number}?`,
                  body: 'This removes the header + all line items and cannot be undone.',
                  confirmLabel: 'Delete',
                  danger: true,
                }))) return;
                deletePo.mutate(po.id, {
                  onSuccess: () => navigate('/scm/purchase-consignment-orders'),
                  onError:   (err) => notify({ title: 'Delete failed', body: err instanceof Error ? err.message : String(err), tone: 'error' }),
                });
              }}
              disabled={deletePo.isPending}>
              <Trash2 {...ICON} />
              <span>{deletePo.isPending ? 'Deleting…' : 'Delete'}</span>
            </Button>
          )}
          {/* Receive Goods → /scm/purchase-consignment-receives/new?fromPcOrder=X */}
          {(po.status === 'SUBMITTED' || po.status === 'PARTIALLY_RECEIVED') && (
            <Button variant="primary" size="md"
              onClick={() => navigate(`/scm/purchase-consignment-receives/new?fromPcOrder=${po.id}`)}>
              <span>Receive Goods</span>
            </Button>
          )}
          {/* Raise Return → /scm/purchase-consignment-returns/new?fromPcOrder=X */}
          {(po.status === 'PARTIALLY_RECEIVED' || po.status === 'RECEIVED') && (
            <Button variant="ghost" size="md"
              onClick={() => navigate(`/scm/purchase-consignment-returns/new?fromPcOrder=${po.id}`)}>
              <span>Raise Return</span>
            </Button>
          )}
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

      {lockedDueToChildren && (
        <div className={styles.bannerWarn} style={{ marginBottom: 'var(--space-3)' }}>
          <strong>Locked — has a Purchase Consignment Receive.</strong>{' '}
          Cancel or delete the downstream receive to edit this order again.
        </div>
      )}

      {/* ── Supplier / dates / currency / notes ─────────────────── */}
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

        {visibleItems.length === 0 ? (
          <p className={styles.emptyRow}>
            {isEditing
              ? 'No items yet — click "Edit" then add items.'
              : 'No items yet.'}
          </p>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Item</th>
                <th>Group</th>
                <th className={styles.tableRight}>Qty</th>
                <th className={styles.tableRight}>Unit</th>
                <th className={styles.tableRight}>Disc</th>
                <th className={styles.tableRight}>Total</th>
                <th className={styles.tableRight}>Delivery</th>
                {!isEditing && <th>Received</th>}
                {isEditing && <th className={styles.tableRight}>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {visibleItems.map((it) => {
                const d = lineOf(it);
                return (
                  <tr key={it.id}>
                    <td>
                      <div className={styles.codeCell}>{it.material_code}</div>
                      {(() => {
                        const summary = buildVariantSummary(it.item_group, it.variants as Record<string, unknown> | null)
                          || it.description
                          || it.material_name;
                        return summary ? <div className={styles.muted} style={{ fontSize: 'var(--fs-11)' }}>{summary}</div> : null;
                      })()}
                    </td>
                    <td className={styles.muted}>{it.item_group ?? it.material_kind}</td>

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
                                 more 裸奔). */
                              onClick={async () => {
                                if (isLocked) return;
                                if (await askConfirm({
                                  title: 'Remove this line?',
                                  body: "The line is removed from this consignment order.",
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
                        <td className={styles.tableRight}>{fmtRm(it.unit_price_centi, po.currency)}</td>
                        <td className={styles.tableRight}>{(it.discount_centi ?? 0) > 0 ? fmtRm(it.discount_centi, po.currency) : '—'}</td>
                        <td className={styles.priceCell}>{fmtRm(it.line_total_centi, po.currency)}</td>
                        <td className={styles.tableRight}>{it.delivery_date ?? '—'}</td>
                        <td>{renderReceived(it)}</td>
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
   Supplier / header card — controlled by the page's draft.
   ════════════════════════════════════════════════════════════════════════ */

const SupplierCard = ({
  po, draft, onField, locked, isEditing = true,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  po: any;
  draft: HeaderDraft;
  onField: (k: keyof HeaderDraft, v: string) => void;
  locked: boolean;
  isEditing?: boolean;
}) => {
  const suppliersQ = useSuppliers();
  const suppliers = suppliersQ.data ?? [];
  const warehousesQ = useWarehouses();
  const warehouses = warehousesQ.data ?? [];
  const supplierIdForDetail = isEditing ? (draft.supplierId || null) : (po.supplier_id ?? null);
  const supplierDetail = useSupplierDetail(supplierIdForDetail);
  const supplier: SupplierRow | null = supplierDetail.data?.supplier ?? null;

  return (
    <section className={styles.card}>
      <header className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>Supplier · Dates · Notes</h2>
      </header>
      <div className={styles.cardBody}>
        {!isEditing ? (
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
            <InfoCell label="Date" value={po.po_date || null} />
            <InfoCell label="Expected Delivery" value={po.expected_at || null} />
            <InfoCell label="Purchase Location"
              value={(() => {
                const wh = warehouses.find((w) => w.id === po.purchase_location_id);
                return wh ? `${wh.code} · ${wh.name}` : null;
              })()} />
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
            <span className={styles.fieldLabel}>Date</span>
            <input type="date" className={styles.fieldInput} value={draft.poDate} disabled={locked}
              onChange={(e) => onField('poDate', e.target.value)} />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Expected Delivery</span>
            <input type="date" className={styles.fieldInput} value={draft.expectedAt} disabled={locked}
              onChange={(e) => onField('expectedAt', e.target.value)} />
          </label>
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
