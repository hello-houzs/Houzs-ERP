// ----------------------------------------------------------------------------
// PurchaseInvoiceDetail — full-page route at /purchase-invoices/:id.
//
// EXACT clone of PurchaseOrderDetail / GoodsReceivedDetail (the gold standard):
// a draft-style View → Edit → Save/Back machine, Print PDF, Cancel. A Purchase
// Invoice is CONFIRMED the moment it exists (no Draft lifecycle), so POSTED
// reads as "Confirmed".
//
//   1. Header: back button + Invoice# · supplier + status pill + actions
//   2. Supplier card: editable supplier + supplier invoice ref + invoice date +
//      due date + currency + notes (inputs in Edit, read-only InfoCells in View)
//   3. Line items table: code + group + variants summary + qty + unit + disc +
//      total  (a PI has NO per-line delivery date — Delivery column dropped)
//   4. Totals card: subtotal (live) + tax (stored) + total + read-only Paid +
//      Balance (= total - paid). No payment-entry UI here.
//
// Draft model (mirrors PO #194 / GRN):
//   • Edit  → snapshots header + lets you edit Qty / Unit / Disc INLINE per row.
//             Nothing persists until the single top Save.
//   • Save  → commits header changes + every changed line's field edits.
//   • Back  → leaves the page, discarding the field-edit draft (no auto-save).
//   • Delete (trash) removes the line immediately (no confirm popup). PI is
//     AP-only (inventory landed at GRN time), so removal is a plain line delete.
//
// purchase_invoice_status enum: POSTED / PARTIALLY_PAID / PAID / CANCELLED.
// POSTED → "Confirmed" (editable). PARTIALLY_PAID / PAID render their label but
// stay editable (commander wants it editable). CANCELLED → "Cancelled" (locked).
// isLocked = CANCELLED only (mirror GRN's lock-on-cancelled logic).
//
// HOUZS VENDOR — verbatim from apps/backend/src/pages/PurchaseInvoiceDetail.tsx.
// Import boundary only: react-router → react-router-dom; flow-queries PI hooks →
// vendored purchase-invoice-queries; suppliers + components + the PDF helper →
// ../../vendor/scm/*; back link repointed to /scm/purchase-invoices.
// ----------------------------------------------------------------------------

import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, FileText, Pencil, Trash2, Printer, Save, Ban, ChevronDown,
} from 'lucide-react';
import { Button } from '@2990s/design-system';
import { buildVariantSummary, fmtDateOrDash } from '@2990s/shared';
import {
  usePurchaseInvoiceDetail,
  useUpdatePurchaseInvoiceHeader,
  useUpdatePurchaseInvoiceItem,
  useDeletePurchaseInvoiceItem,
  useCancelPurchaseInvoice,
} from '../../vendor/scm/lib/purchase-invoice-queries';
import { useSuppliers, useSupplierDetail, type SupplierRow } from '../../vendor/scm/lib/suppliers-queries';
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

/* Draft state shapes (mirror PO #194 / GRN). HeaderDraft mirrors the editable PI
   header fields; LineDraft holds the three inline-editable per-line fields (PI
   has NO per-line delivery date). */
type HeaderDraft = {
  supplierId: string;
  supplierInvoiceRef: string;
  invoiceDate: string;
  dueDate: string;
  currency: string;
  notes: string;
};
type LineDraft = {
  qty: number;
  unitPriceCenti: number;
  discountCenti: number;
};

type PiItemRow = Record<string, unknown> & {
  id: string;
  material_code: string;
  material_name: string;
  qty: number;
  unit_price_centi: number;
  discount_centi?: number;
  line_total_centi?: number;
  item_group?: string | null;
  material_kind?: string | null;
  description?: string | null;
  variants?: Record<string, unknown> | null;
};

const headerSnapshot = (p: any): HeaderDraft => ({
  supplierId:         p.supplier_id ?? '',
  supplierInvoiceRef: p.supplier_invoice_ref ?? '',
  invoiceDate:        (p.invoice_date ?? '').slice(0, 10),
  dueDate:            (p.due_date ?? '').slice(0, 10),
  currency:           p.currency ?? 'MYR',
  notes:              p.notes ?? '',
});

const lineSnapshot = (it: PiItemRow): LineDraft => ({
  qty:            it.qty,
  unitPriceCenti: it.unit_price_centi,
  discountCenti:  it.discount_centi ?? 0,
});

export const PurchaseInvoiceDetail = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const detail = usePurchaseInvoiceDetail(id ?? null);
  const updateHeader = useUpdatePurchaseInvoiceHeader();
  const updateItem = useUpdatePurchaseInvoiceItem();
  const deleteItem = useDeletePurchaseInvoiceItem();
  const askConfirm = useConfirm();
  const notify = useNotify();
  const cancel = useCancelPurchaseInvoice();

  const pi = detail.data?.purchaseInvoice ?? null;
  const items = (detail.data?.items ?? []) as PiItemRow[];

  /* View → Edit gate (mirror PO/GRN) — default read-only View; click Edit to
     flip into draft mode. The PI list's right-click "Edit" lands here with
     ?edit=1. */
  const [searchParams] = useSearchParams();
  const [isEditing, setIsEditing] = useState(() => searchParams.get('edit') === '1');

  /* Draft buffers. headerDraft is null until the first header field is touched
     (then seeded from the PI). lineDrafts overlays per-line edits keyed by item
     id; any line without an entry shows its stored values. None of this persists
     until Save. */
  const [headerDraft, setHeaderDraft] = useState<HeaderDraft | null>(null);
  const [lineDrafts, setLineDrafts] = useState<Record<string, LineDraft>>({});
  const [savingDraft, setSavingDraft] = useState(false);

  // Unified edit-lock (migration 0106): a PI is read-only once it has ANY
  // payment recorded (paid_centi > 0) OR is CANCELLED. POSTED with zero payment
  // stays editable.
  const isLocked = pi ? (pi.status === 'CANCELLED' || (pi.paid_centi ?? 0) > 0) : true;

  /* If the PI locks while we're in Edit mode (e.g. cancelled in another tab),
     drop back to View + discard the draft. */
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
  if (detail.isError || !pi) {
    return (
      <div className={styles.page}>
        <Link to="/scm/purchase-invoices" className={styles.backBtn}>
          <ArrowLeft {...ICON} />
          <span>Back</span>
        </Link>
        <div className={styles.bannerWarn}>
          <strong>Purchase invoice not found.</strong>
          {detail.error instanceof Error ? ` ${detail.error.message}` : null}
        </div>
      </div>
    );
  }

  /* ── Draft helpers (pi is guaranteed non-null past the guards above) ── */
  const visibleItems = items;
  const lineOf = (it: PiItemRow): LineDraft => lineDrafts[it.id] ?? lineSnapshot(it);
  const lineTotalOf = (it: PiItemRow): number => {
    if (!isEditing) return it.line_total_centi ?? (it.qty * it.unit_price_centi - (it.discount_centi ?? 0));
    const d = lineOf(it);
    return d.qty * d.unitPriceCenti - d.discountCenti;
  };
  const itemsSubtotal = visibleItems.reduce((s, it) => s + lineTotalOf(it), 0);
  const taxCenti = pi.tax_centi ?? 0;
  const grandTotal = itemsSubtotal + taxCenti;
  const paidCenti = pi.paid_centi ?? 0;
  const balanceCenti = grandTotal - paidCenti;

  const headerView = headerDraft ?? headerSnapshot(pi);

  const setHeaderField = (k: keyof HeaderDraft, v: string) => {
    setHeaderDraft((h) => ({ ...(h ?? headerSnapshot(pi)), [k]: v }));
  };

  const setLine = (it: PiItemRow, patch: Partial<LineDraft>) =>
    setLineDrafts((prev) => ({ ...prev, [it.id]: { ...(prev[it.id] ?? lineSnapshot(it)), ...patch } }));

  const enterEdit = () => {
    setHeaderDraft(null);
    setLineDrafts({});
    setIsEditing(true);
  };

  /* Single Save — commit header (only if touched) + every changed line's field
     edits, then drop back to View. Back discards the field-edit draft.
     (Line delete already committed server-side — see the trash handler.) */
  const handleSave = async () => {
    if (savingDraft) return;
    setSavingDraft(true);
    try {
      if (headerDraft) {
        await updateHeader.mutateAsync({ id: pi.id, ...(headerDraft as Record<string, unknown>) });
      }
      for (const it of items) {
        const d = lineDrafts[it.id];
        if (!d) continue;
        const changed =
          d.qty !== it.qty ||
          d.unitPriceCenti !== it.unit_price_centi ||
          d.discountCenti !== (it.discount_centi ?? 0);
        if (changed) {
          await updateItem.mutateAsync({
            id: pi.id, itemId: it.id,
            qty: d.qty, unitPriceCenti: d.unitPriceCenti,
            discountCenti: d.discountCenti,
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
    // PI PDF (AutoCount layout) — mirrors PO/GRN's handlePrint wiring its own
    // purchase-invoice-pdf helper.
    import('../../vendor/scm/lib/purchase-invoice-pdf').then(({ generatePurchaseInvoicePdf }) =>
      generatePurchaseInvoicePdf(pi, items as any),
    ).catch((e) => notify({ title: 'PDF generation failed', body: `${e instanceof Error ? e.message : String(e)}`, tone: 'error' }));
  };

  return (
    <div className={styles.page}>
      {/* ── Header ──────────────────────────────────────────────── */}
      <div className={styles.headerRow}>
        <div className={styles.titleBlock}>
          <Link to="/scm/purchase-invoices" className={styles.backBtn}>
            <ArrowLeft {...ICON} />
            <span>Back</span>
          </Link>
          <div>
            <h1 className={styles.title}>
              <FileText size={14} strokeWidth={1.75} style={{ color: 'var(--c-burnt)' }} />
              {pi.invoice_number} — {pi.supplier?.name ?? pi.supplier?.code ?? '—'}
            </h1>
          </div>
        </div>
        <div className={styles.actions}>
          {/* Total KPI tile — tracks the live line items (incl. unsaved draft
              edits) + stored tax. */}
          <div className={styles.totalRail}>
            <span className={styles.totalRailLabel}>Total</span>
            <span className={styles.totalRailValue}>{fmtRm(grandTotal, pi.currency)}</span>
          </div>
          {/* A PI is Confirmed the moment it exists (no Draft/lifecycle). */}
          <StatusPill docType="pi" status={pi.status} />
          <RelationshipMapButton type="pi" id={id} />
          <Button variant="ghost" size="md" onClick={handlePrint}>
            <Printer {...ICON} />
            <span>Print PDF</span>
          </Button>
          {/* Cancel — only when the PI is not locked (no payment recorded, not
              already cancelled). Confirm dialog → cancel mutation (PI is AP-only,
              so this just flips status + releases GRN consumption). */}
          {!isLocked && (
            <Button variant="ghost" size="md"
              onClick={async () => {
                if (!(await askConfirm({
                  title: `Cancel invoice ${pi.invoice_number}?`,
                  body: `This sets status to CANCELLED — line items stay for audit.`,
                  confirmLabel: 'Cancel invoice',
                  danger: true,
                }))) return;
                cancel.mutate(pi.id, {
                  onError: (err) => notify({ title: 'Cancel failed', body: `${err instanceof Error ? err.message : String(err)}`, tone: 'error' }),
                });
              }}
              disabled={cancel.isPending}>
              <Ban {...ICON} />
              <span>{cancel.isPending ? 'Cancelling…' : 'Cancel'}</span>
            </Button>
          )}
          {/* View → Edit gate. Default View shows Edit (disabled while locked);
              editing flips into draft mode and the button becomes the single
              "Save" that commits the whole draft. Back (top-left) discards. */}
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

      {/* ── Supplier / ref / dates / currency / notes ───────────── */}
      {/* In View the card renders read-only text; in Edit it shows inputs bound
          to the draft (committed by the single top Save). */}
      <SupplierCard
        pi={pi}
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
          <p className={styles.emptyRow}>No items on this invoice.</p>
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
                {/* Actions column only in Edit mode — View is read-only. A PI
                    has NO per-line delivery date, so no Delivery column. */}
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
                        const summary = buildVariantSummary(it.item_group ?? null, it.variants as Record<string, unknown> | null)
                          || it.description
                          || it.material_name;
                        return summary ? <div className={styles.muted} style={{ fontSize: 'var(--fs-11)' }}>{summary}</div> : null;
                      })()}
                    </td>
                    <td className={styles.muted}>{it.item_group ?? it.material_kind ?? '—'}</td>

                    {/* Qty / Unit / Disc are inline-editable in Edit mode (no
                        per-line modal). */}
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
                        <td className={styles.priceCell}>{fmtRm(d.qty * d.unitPriceCenti - d.discountCenti, pi.currency)}</td>
                        <td>
                          <span className={styles.actionsCell}>
                            <button type="button"
                              className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                              title="Remove line" disabled={isLocked || deleteItem.isPending}
                              /* Commander 2026-06-15 — confirm before delete (no
                                 more 裸奔). PI is AP-only, so removal is a plain line
                                 delete (inventory landed at GRN time). */
                              onClick={async () => {
                                if (isLocked) return;
                                if (await askConfirm({
                                  title: 'Remove this line?',
                                  body: "The line is removed from this invoice.",
                                  confirmLabel: 'Remove',
                                  danger: true,
                                })) {
                                  deleteItem.mutate({ id: pi.id, itemId: it.id });
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
                        <td className={styles.tableRight}>{fmtRm(it.unit_price_centi, pi.currency)}</td>
                        <td className={styles.tableRight}>{(it.discount_centi ?? 0) > 0 ? fmtRm(it.discount_centi, pi.currency) : '—'}</td>
                        <td className={styles.priceCell}>{fmtRm(lineTotalOf(it), pi.currency)}</td>
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
          {/* Subtotal computed LIVE from the visible line items (incl. unsaved
              draft edits); tax is the stored header value; total = subtotal +
              tax. Paid + Balance are read-only (no payment-entry UI here). */}
          <div className={styles.totalsGrid}>
            <div className={styles.totalRow}>
              <span className={styles.totalLabel}>Subtotal</span>
              <span className={styles.totalValue}>{fmtRm(itemsSubtotal, pi.currency)}</span>
            </div>
            <div className={styles.totalRow}>
              <span className={styles.totalLabel}>Tax</span>
              <span className={styles.totalValue}>{fmtRm(taxCenti, pi.currency)}</span>
            </div>
            <div className={`${styles.totalRow} ${styles.grandTotalRow}`}>
              <span className={styles.totalLabel}>Total</span>
              <span className={`${styles.totalValue} ${styles.grandTotal}`}>{fmtRm(grandTotal, pi.currency)}</span>
            </div>
            <div className={styles.totalRow}>
              <span className={styles.totalLabel}>Paid</span>
              <span className={styles.totalValue}>{fmtRm(paidCenti, pi.currency)}</span>
            </div>
            <div className={styles.totalRow}>
              <span className={styles.totalLabel}>Balance</span>
              <span className={styles.totalValue}>{fmtRm(balanceCenti, pi.currency)}</span>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};

/* ════════════════════════════════════════════════════════════════════════
   Supplier / header card — controlled by the page's draft (mirror PO/GRN).
   In View it renders read-only InfoCells; in Edit it shows inputs bound to the
   page draft (committed by the single top Save).
   ════════════════════════════════════════════════════════════════════════ */

const SupplierCard = ({
  pi, draft, onField, locked, isEditing = true,
}: {
  pi: any;
  /** Draft header values (page-owned). In View these mirror the saved PI. */
  draft: HeaderDraft;
  /** Update a single header field on the page draft. */
  onField: (k: keyof HeaderDraft, v: string) => void;
  locked: boolean;
  /** View → Edit gate. When false the card renders read-only display text. */
  isEditing?: boolean;
}) => {
  const suppliersQ = useSuppliers();
  const suppliers = suppliersQ.data ?? [];
  // In Edit follow the draft's picked supplier; in View follow the saved PI.
  const supplierIdForDetail = isEditing ? (draft.supplierId || null) : (pi.supplier_id ?? null);
  const supplierDetail = useSupplierDetail(supplierIdForDetail);
  const supplier: SupplierRow | null = supplierDetail.data?.supplier ?? null;

  return (
    <section className={styles.card}>
      <header className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>Supplier · Dates · Notes</h2>
      </header>
      <div className={styles.cardBody}>
        {!isEditing ? (
          /* View mode — read-only display text sourced from the saved PI. */
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
                value={pi.supplier?.name ?? pi.supplier?.code ?? supplier?.name ?? supplier?.code ?? null} />
            </div>
            <InfoCell label="Currency" value={pi.currency || null} />
            <div />
            <InfoCell label="Supplier Invoice Ref" value={pi.supplier_invoice_ref || null} />
            <InfoCell label="Invoice Date" value={pi.invoice_date ? fmtDateOrDash(pi.invoice_date) : null} />
            <InfoCell label="Due Date" value={pi.due_date ? fmtDateOrDash(pi.due_date) : null} />
            <div style={{ gridColumn: 'span 2' }}>
              <InfoCell label="Notes" value={pi.notes || null} />
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
            <span className={styles.fieldLabel}>Supplier Invoice Ref</span>
            <input className={styles.fieldInput} value={draft.supplierInvoiceRef} disabled={locked}
              onChange={(e) => onField('supplierInvoiceRef', e.target.value)} />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Invoice Date</span>
            <input type="date" className={styles.fieldInput} value={draft.invoiceDate} disabled={locked}
              onChange={(e) => onField('invoiceDate', e.target.value)} />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Due Date</span>
            <input type="date" className={styles.fieldInput} value={draft.dueDate} disabled={locked}
              onChange={(e) => onField('dueDate', e.target.value)} />
          </label>
          <label className={styles.field} style={{ gridColumn: 'span 2' }}>
            <span className={styles.fieldLabel}>Notes</span>
            <input className={styles.fieldInput} value={draft.notes} disabled={locked}
              onChange={(e) => onField('notes', e.target.value)} />
          </label>
        </div>
        )}

        {/* Supplier-info auto-fill card. Read-only display from /suppliers/:id. */}
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

/* Read-only label/value cell for the supplier auto-fill card. */
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
