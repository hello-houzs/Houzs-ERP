// ----------------------------------------------------------------------------
// PurchaseConsignmentReturnDetail — full-page route at
// /purchase-consignment-return/:id.
//
// Faithful clone of PurchaseReturnDetail.tsx: a draft-style View → Edit →
// Save/Back machine. It reuses the SAME shared components UNCHANGED —
// MoneyInput, the supplier picker + supplier data hooks. Only the queries are
// repointed at `/purchase-consignment-returns` (the pc-return hooks) and links
// go back to /purchase-consignment-return.
//
// Dropped from the PR clone (per scope): Print PDF + Relationship Map (the PDF +
// flow-graph engines don't model the consignment doc types).
// ----------------------------------------------------------------------------

import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { RelationshipMapButton } from '../../vendor/scm/components/RelationshipMapButton';
import { SkeletonDetailPage } from '../../vendor/scm/components/Skeleton';
import {
  ArrowLeft, Undo2, Pencil, Printer, Trash2, Save, Ban, ChevronDown,
} from 'lucide-react';
import { Button } from '@2990s/design-system';
import { buildVariantSummary, fmtDateOrDash } from '@2990s/shared';
import {
  usePurchaseConsignmentReturnDetail,
  useUpdatePurchaseConsignmentReturnHeader,
  useUpdatePurchaseConsignmentReturnItem,
  useDeletePurchaseConsignmentReturnItem,
  useCancelPurchaseConsignmentReturn,
} from '../../vendor/scm/lib/purchase-consignment-return-queries';
import { useSuppliers, useSupplierDetail, type SupplierRow } from '../../vendor/scm/lib/suppliers-queries';
import { MoneyInput } from '../../vendor/scm/components/MoneyInput';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { StatusPill } from '../../vendor/scm/components/StatusPill';
import styles from './SalesOrderDetail.module.css';

const ICON = { size: 16, strokeWidth: 1.75 } as const;
const SM_ICON = { size: 14, strokeWidth: 1.75 } as const;

const fmtRm = (centi: number | null | undefined): string => {
  const v = centi ?? 0;
  return `MYR ${(v / 100).toLocaleString('en-MY', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;
};

type HeaderDraft = {
  supplierId: string;
  returnDate: string;
  reason: string;
  creditNoteRef: string;
  notes: string;
};
type LineDraft = {
  qty: number;            // maps to qty_returned
  unitPriceCenti: number;
};

type PrItemRow = Record<string, unknown> & {
  id: string;
  material_code: string;
  material_name: string;
  qty_returned: number;
  unit_price_centi: number;
  line_refund_centi?: number;
  item_group?: string | null;
  material_kind?: string | null;
  description?: string | null;
  variants?: Record<string, unknown> | null;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const headerSnapshot = (p: any): HeaderDraft => ({
  supplierId:    p.supplier_id ?? '',
  returnDate:    (p.return_date ?? '').slice(0, 10),
  reason:        p.reason ?? '',
  creditNoteRef: p.credit_note_ref ?? '',
  notes:         p.notes ?? '',
});

const lineSnapshot = (it: PrItemRow): LineDraft => ({
  qty:            it.qty_returned,
  unitPriceCenti: it.unit_price_centi,
});

export const PurchaseConsignmentReturnDetail = () => {
  const { id } = useParams<{ id: string }>();
  const detail = usePurchaseConsignmentReturnDetail(id ?? null);
  const updateHeader = useUpdatePurchaseConsignmentReturnHeader();
  const updateItem = useUpdatePurchaseConsignmentReturnItem();
  const deleteItem = useDeletePurchaseConsignmentReturnItem();
  const askConfirm = useConfirm();
  const notify = useNotify();
  const cancel = useCancelPurchaseConsignmentReturn();

  const pr = detail.data?.purchaseReturn ?? null;
  const items = (detail.data?.items ?? []) as PrItemRow[];

  const [searchParams] = useSearchParams();
  const [isEditing, setIsEditing] = useState(() => searchParams.get('edit') === '1');

  const [headerDraft, setHeaderDraft] = useState<HeaderDraft | null>(null);
  const [lineDrafts, setLineDrafts] = useState<Record<string, LineDraft>>({});
  const [savingDraft, setSavingDraft] = useState(false);

  const isLocked = pr ? pr.status !== 'POSTED' : true;

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
  if (detail.isError || !pr) {
    return (
      <div className={styles.page}>
        <Link to="/scm/purchase-consignment-returns" className={styles.backBtn}>
          <ArrowLeft {...ICON} />
          <span>Back</span>
        </Link>
        <div className={styles.bannerWarn}>
          <strong>Purchase consignment return not found.</strong>
          {detail.error instanceof Error ? ` ${detail.error.message}` : null}
        </div>
      </div>
    );
  }

  const visibleItems = items;
  const lineOf = (it: PrItemRow): LineDraft => lineDrafts[it.id] ?? lineSnapshot(it);
  const lineTotalOf = (it: PrItemRow): number => {
    if (!isEditing) return it.line_refund_centi ?? (it.qty_returned * it.unit_price_centi);
    const d = lineOf(it);
    return d.qty * d.unitPriceCenti;
  };
  const refundTotal = visibleItems.reduce((s, it) => s + lineTotalOf(it), 0);

  const headerView = headerDraft ?? headerSnapshot(pr);

  const handlePrint = () => {
    const pdfHeader = {
      return_number: pr.return_number,
      status: String(pr.status),
      return_date: pr.return_date ?? '',
      reason: pr.reason ?? null,
      refund_centi: refundTotal,
      credit_note_ref: pr.credit_note_ref ?? null,
      notes: pr.notes ?? null,
      supplier: pr.supplier ?? undefined,
    };
    const pdfItems = items.map((it) => ({
      material_code: it.material_code,
      material_name: it.material_name,
      qty_returned: it.qty_returned,
      unit_price_centi: it.unit_price_centi,
      line_refund_centi: it.line_refund_centi ?? (it.qty_returned * it.unit_price_centi),
      reason: null,
    }));
    import('../../vendor/scm/lib/purchase-return-pdf')
      .then(({ generatePurchaseReturnPdf }) =>
        generatePurchaseReturnPdf(pdfHeader as never, pdfItems as never, {
          docTitle: 'PURCHASE CONSIGNMENT RETURN', docNoLabel: 'Return No',
          amountLabel: 'Value', totalLabel: 'TOTAL VALUE',
        }))
      .catch((e) => notify({ title: 'PDF generation failed', body: e instanceof Error ? e.message : String(e), tone: 'error' }));
  };

  const setHeaderField = (k: keyof HeaderDraft, v: string) => {
    setHeaderDraft((h) => ({ ...(h ?? headerSnapshot(pr)), [k]: v }));
  };

  const setLine = (it: PrItemRow, patch: Partial<LineDraft>) =>
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
        await updateHeader.mutateAsync({ id: pr.id, ...(headerDraft as Record<string, unknown>) });
      }
      for (const it of items) {
        const d = lineDrafts[it.id];
        if (!d) continue;
        const changed =
          d.qty !== it.qty_returned ||
          d.unitPriceCenti !== it.unit_price_centi;
        if (changed) {
          await updateItem.mutateAsync({
            id: pr.id, itemId: it.id,
            qty: d.qty, unitPriceCenti: d.unitPriceCenti,
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
          <Link to="/scm/purchase-consignment-returns" className={styles.backBtn}>
            <ArrowLeft {...ICON} />
            <span>Back</span>
          </Link>
          <div>
            <h1 className={styles.title}>
              <Undo2 size={14} strokeWidth={1.75} style={{ color: 'var(--c-burnt)' }} />
              {pr.return_number} — {pr.supplier?.name ?? pr.supplier?.code ?? '—'}
            </h1>
          </div>
        </div>
        <div className={styles.actions}>
          <div className={styles.totalRail}>
            <span className={styles.totalRailLabel}>Refund</span>
            <span className={styles.totalRailValue}>{fmtRm(refundTotal)}</span>
          </div>
          <StatusPill docType="pr" status={pr.status} />
          <RelationshipMapButton type="pcrn" id={pr.id} />
          <Button variant="ghost" size="md" onClick={handlePrint}>
            <Printer {...ICON} /><span>Print PDF</span>
          </Button>
          {pr.status !== 'CANCELLED' && pr.status !== 'COMPLETED' && (
            <Button variant="ghost" size="md"
              onClick={async () => {
                if (!(await askConfirm({
                  title: `Cancel return ${pr.return_number}?`,
                  body: 'This reverses the return — the goods are put back into stock. Line items stay for audit.',
                  confirmLabel: 'Cancel Return',
                  danger: true,
                }))) return;
                cancel.mutate(pr.id, {
                  onError: (err) => notify({ title: 'Cancel failed', body: err instanceof Error ? err.message : String(err), tone: 'error' }),
                });
              }}
              disabled={cancel.isPending}>
              <Ban {...ICON} />
              <span>{cancel.isPending ? 'Cancelling…' : 'Cancel'}</span>
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

      {/* ── Supplier / dates / reason / notes ───────────────────── */}
      <SupplierCard
        pr={pr}
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
          <p className={styles.emptyRow}>No items on this return.</p>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Item</th>
                <th>Group</th>
                <th>Warehouse</th>
                <th className={styles.tableRight}>Qty</th>
                <th className={styles.tableRight}>Unit</th>
                <th className={styles.tableRight}>Total</th>
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
                    <td className={styles.muted}>{(it.warehouse_code as string | null) ?? '—'}</td>

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
                        <td className={styles.priceCell}>{fmtRm(d.qty * d.unitPriceCenti)}</td>
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
                                  body: "The line is removed from this consignment return.",
                                  confirmLabel: 'Remove',
                                  danger: true,
                                })) {
                                  deleteItem.mutate({ id: pr.id, itemId: it.id });
                                }
                              }}>
                              <Trash2 {...SM_ICON} />
                            </button>
                          </span>
                        </td>
                      </>
                    ) : (
                      <>
                        <td className={styles.tableRight}>{it.qty_returned}</td>
                        <td className={styles.tableRight}>{fmtRm(it.unit_price_centi)}</td>
                        <td className={styles.priceCell}>{fmtRm(lineTotalOf(it))}</td>
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
            <div className={`${styles.totalRow} ${styles.grandTotalRow}`}>
              <span className={styles.totalLabel}>Total Refund</span>
              <span className={`${styles.totalValue} ${styles.grandTotal}`}>{fmtRm(refundTotal)}</span>
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
  pr, draft, onField, locked, isEditing = true,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pr: any;
  draft: HeaderDraft;
  onField: (k: keyof HeaderDraft, v: string) => void;
  locked: boolean;
  isEditing?: boolean;
}) => {
  const suppliersQ = useSuppliers();
  const suppliers = suppliersQ.data ?? [];
  const supplierIdForDetail = isEditing ? (draft.supplierId || null) : (pr.supplier_id ?? null);
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
                value={pr.supplier?.name ?? pr.supplier?.code ?? supplier?.name ?? supplier?.code ?? null} />
            </div>
            <InfoCell label="Return Date" value={pr.return_date ? fmtDateOrDash(pr.return_date) : null} />
            <InfoCell label="Credit Note Ref" value={pr.credit_note_ref || null} />
            <div style={{ gridColumn: 'span 2' }}>
              <InfoCell label="Reason" value={pr.reason || null} />
            </div>
            <div style={{ gridColumn: 'span 2' }}>
              <InfoCell label="Notes" value={pr.notes || null} />
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
            <span className={styles.fieldLabel}>Return Date</span>
            <input type="date" className={styles.fieldInput} value={draft.returnDate} disabled={locked}
              onChange={(e) => onField('returnDate', e.target.value)} />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Credit Note Ref</span>
            <input className={styles.fieldInput} value={draft.creditNoteRef} disabled={locked}
              onChange={(e) => onField('creditNoteRef', e.target.value)} />
          </label>
          <label className={styles.field} style={{ gridColumn: 'span 2' }}>
            <span className={styles.fieldLabel}>Reason</span>
            <input className={styles.fieldInput} value={draft.reason} disabled={locked}
              onChange={(e) => onField('reason', e.target.value)} />
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
