// ----------------------------------------------------------------------------
// SalesInvoiceDetail — full-page route at /sales-invoices/:id.
//
// Editable clone of DeliveryOrderDetail (itself an SO-clone). View→Edit gate;
// editable Customer / Invoice Info / Emergency Contact / Address / Line Items /
// Totals / Payments. Plus a "Convert from DO" button (Edit mode, like the PO
// detail) and Cancel / Reopen. Reuses the shared SoLineCard + PaymentsTable +
// SalesOrderDetail.module.css so the SI Detail reads identically to the DO /SO
// Detail.
//
// PaymentsTable is rendered in DRAFT mode — this page loads the persisted SI
// payments into PaymentDraft[] and flushes adds/deletes through the SI payment
// hooks on Save, so the shared component is reused untouched.
// ----------------------------------------------------------------------------

import {
  forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState,
  type CSSProperties,
} from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, FileText, Pencil, Plus, Printer, Save, ChevronDown, Ban, RotateCcw,
} from 'lucide-react';
import { Button } from '@2990s/design-system';
import { PhoneInput } from '../../vendor/scm/components/PhoneInput';
import { DateField } from '../../vendor/scm/components/DateField';
import { SkeletonDetailPage } from '../../vendor/scm/components/Skeleton';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import {
  useSalesInvoiceDetail,
  useUpdateSalesInvoiceHeader,
  useUpdateSalesInvoiceStatus,
  useAddSalesInvoiceItem,
  useUpdateSalesInvoiceItem,
  useDeleteSalesInvoiceItem,
  useSalesInvoicePayments,
  useAddSalesInvoicePayment,
  useDeleteSalesInvoicePayment,
} from '../../vendor/scm/lib/sales-invoice-queries';
import { SoLineCard, emptySoLine, type SoLineDraft } from '../../vendor/scm/components/SoLineCard';
import { RelationshipMapButton } from '../../vendor/scm/components/RelationshipMapButton';
import { StatusPill } from '../../vendor/scm/components/StatusPill';
import {
  PaymentsTable, labelToApi, draftMethodFields, type PaymentDraft,
} from '../../vendor/scm/components/PaymentsTable';
import { buildVariantSummary, fmtDateOrDash, lineIdentity } from '@2990s/shared';
import {
  useLocalities, distinctStates, citiesInState, postcodesInCity,
} from '../../vendor/scm/lib/localities-queries';
import {
  useSoDropdownOptions, optionsOrFallback,
} from '../../vendor/scm/lib/so-dropdown-options-queries';
import { useStaff } from '../../vendor/scm/lib/admin-queries';
import { sortByText, sortByNumeric } from '../../vendor/scm/lib/sort-options';
import styles from './SalesOrderDetail.module.css';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

type SiStatus = 'DRAFT' | 'SENT' | 'PARTIALLY_PAID' | 'PAID' | 'OVERDUE' | 'CANCELLED';

const fmtRm = (centi: number, currency = 'MYR'): string =>
  `${currency} ${(centi / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const TITLE_ICON_STYLE: CSSProperties = { color: 'var(--c-burnt)' };
const TOTALS_KPI_GRID_STYLE: CSSProperties = {
  display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 'var(--space-3)',
  marginBottom: 'var(--space-3)', paddingBottom: 'var(--space-3)', borderBottom: '1px solid var(--line)',
};
const TOTALS_KPI_VALUE_STYLE: CSSProperties = { fontSize: 'var(--fs-15, 15px)' };

type SiHeader = {
  id: string;
  invoice_number: string;
  so_doc_no: string | null;
  delivery_order_id: string | null;
  status: SiStatus;
  invoice_date: string;
  due_date: string | null;
  customer_delivery_date: string | null;
  debtor_code: string | null;
  debtor_name: string;
  salesperson_id: string | null;
  agent: string | null;
  email: string | null;
  customer_type: string | null;
  building_type: string | null;
  branding: string | null;
  venue: string | null;
  venue_id: string | null;
  ref: string | null;
  customer_so_no: string | null;
  po_doc_no: string | null;
  sales_location: string | null;
  customer_state: string | null;
  customer_country: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  postcode: string | null;
  phone: string | null;
  note: string | null;
  notes: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  emergency_contact_relationship: string | null;
  mattress_sofa_centi: number;
  bedframe_centi: number;
  accessories_centi: number;
  others_centi: number;
  mattress_sofa_cost_centi?: number;
  bedframe_cost_centi?: number;
  accessories_cost_centi?: number;
  others_cost_centi?: number;
  local_total_centi: number;
  total_centi: number;
  paid_centi: number;
  total_cost_centi: number;
  total_margin_centi: number;
  margin_pct_basis: number;
  line_count: number;
  currency: string;
};

type SiItem = {
  id: string;
  sales_invoice_id: string;
  item_group: string | null;
  item_code: string;
  description: string | null;
  description2: string | null;
  uom: string;
  qty: number;
  unit_price_centi: number;
  discount_centi: number;
  line_total_centi: number;
  unit_cost_centi: number;
  line_cost_centi: number;
  line_margin_centi: number;
  variants: Record<string, unknown> | null;
  notes: string | null;
};

/* Costing A (Commander 2026-06-01) — an SI line copies the DO's actual cost. A
   live (non-cancelled) line with qty but cost 0 means the goods were received
   with NO price and no Purchase Invoice yet → cost PENDING, not free. The recost
   engine fills the real number (and re-stamps this SI) the instant a price lands. */
const lineCostPending = (
  it: { qty: number; unit_cost_centi: number },
  isCancelled: boolean,
): boolean => !isCancelled && Number(it.qty) > 0 && Number(it.unit_cost_centi ?? 0) === 0;

const draftFromItem = (it: SiItem): SoLineDraft => ({
  itemCode: it.item_code ?? '',
  itemGroup: it.item_group ?? 'others',
  description: it.description ?? '',
  uom: it.uom ?? 'UNIT',
  qty: it.qty ?? 1,
  unitPriceCenti: it.unit_price_centi ?? 0,
  discountCenti: it.discount_centi ?? 0,
  unitCostCenti: it.unit_cost_centi ?? 0,
  variants: (it.variants as Record<string, unknown>) ?? {},
  remark: it.notes ?? '',
});

export const SalesInvoiceDetail = () => {
  const { id } = useParams<{ id: string }>();
  const askConfirm = useConfirm();
  const notify = useNotify();
  const [searchParams] = useSearchParams();
  const detail = useSalesInvoiceDetail(id ?? null);
  const updateHeader = useUpdateSalesInvoiceHeader();
  const updateStatus = useUpdateSalesInvoiceStatus();
  const addItem = useAddSalesInvoiceItem();
  const updateItem = useUpdateSalesInvoiceItem();
  const deleteItem = useDeleteSalesInvoiceItem();

  const header = (detail.data?.salesInvoice as SiHeader | undefined) ?? null;
  const items = useMemo(() => (detail.data?.items as SiItem[] | undefined) ?? [], [detail.data]);

  // ── Payments (DRAFT-mode PaymentsTable + manual persistence) ──────────
  const paymentsQ = useSalesInvoicePayments(id ?? null);
  const addPayment = useAddSalesInvoicePayment();
  const deletePayment = useDeleteSalesInvoicePayment();
  const [paymentDrafts, setPaymentDrafts] = useState<PaymentDraft[]>([]);

  const [editingDrafts, setEditingDrafts] = useState<Record<string, SoLineDraft>>({});
  const [addingDraft, setAddingDraft] = useState<SoLineDraft | null>(null);

  const [isEditing, setIsEditing] = useState(searchParams.get('edit') === '1');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savingOrder, setSavingOrder] = useState(false);
  const customerCardRef = useRef<CustomerCardHandle | null>(null);

  // Lock: CANCELLED locks the header.
  const lockedStatuses: SiStatus[] = ['CANCELLED'];

  const apiToDraft = useCallback((p: NonNullable<typeof paymentsQ.data>[number]): PaymentDraft => {
    const methodLabel = p.method === 'cash' ? 'Cash' : p.method === 'transfer' ? 'Online' : 'Merchant';
    const installmentLabel = p.installment_months && p.installment_months > 0 ? `${p.installment_months} months` : '';
    return {
      uid: p.id,
      paidAt: p.paid_at,
      methodLabel,
      merchantProvider: p.merchant_provider ?? '',
      installmentMonthsLabel: installmentLabel,
      onlineType: p.online_type ?? '',
      amountCenti: p.amount_centi,
      accountSheet: p.account_sheet ?? '',
      approvalCode: p.approval_code ?? '',
      collectedBy: p.collected_by ?? '',
      // SI payments carry no per-payment slip (Spec D4 applies to the SO route).
      slipUploadSessionId: null,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stable per-payment row mapper; reads only its argument, not re-created on refetch by design
  }, []);

  const enterEdit = () => { setSaveError(null); setIsEditing(true); };
  const cancelEdit = () => {
    customerCardRef.current?.reset();
    setSaveError(null);
    setIsEditing(false);
  };

  useEffect(() => {
    if (!isEditing) {
      setEditingDrafts({});
      setAddingDraft(null);
      setPaymentDrafts([]);
      return;
    }
    setEditingDrafts(() => {
      const next: Record<string, SoLineDraft> = {};
      for (const it of items) next[it.id] = draftFromItem(it);
      return next;
    });
    setPaymentDrafts((paymentsQ.data ?? []).map(apiToDraft));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing, items, paymentsQ.data]);

  const stableId = id ?? '';
  const handleHeaderSave = useCallback(
    (patch: Record<string, unknown>, cb?: { onSuccess?: () => void; onError?: (msg: string) => void }) => {
      updateHeader.mutate(
        { id: stableId, ...patch },
        {
          onSuccess: () => cb?.onSuccess?.(),
          onError: (e) => cb?.onError?.(e instanceof Error ? e.message : String(e)),
        },
      );
    },
    [stableId, updateHeader],
  );

  const patchEditingDraft = useCallback((lineId: string, patch: Partial<SoLineDraft>) => {
    setEditingDrafts((prev) => {
      const cur = prev[lineId];
      if (!cur) return prev;
      return { ...prev, [lineId]: { ...cur, ...patch } };
    });
  }, []);

  const removeEditingLine = useCallback((lineId: string) => {
    setEditingDrafts((prev) => {
      if (!(lineId in prev)) return prev;
      const { [lineId]: _drop, ...rest } = prev;
      return rest;
    });
  }, []);

  const rowCallbacks = useMemo(() => {
    const map = new Map<string, { onChange: (patch: Partial<SoLineDraft>) => void; onRemove: () => void }>();
    for (const it of items) {
      map.set(it.id, {
        onChange: (patch) => patchEditingDraft(it.id, patch),
        onRemove: async () => {
          if (await askConfirm({
            title: `Remove ${it.item_code} from this invoice?`,
            confirmLabel: 'Remove',
            danger: true,
          })) {
            deleteItem.mutate(
              { id: it.sales_invoice_id, itemId: it.id },
              { onSuccess: () => removeEditingLine(it.id) },
            );
          }
        },
      });
    }
    return map;
  }, [items, patchEditingDraft, removeEditingLine, deleteItem, askConfirm]);

  const startAddLine = () => setAddingDraft({ ...emptySoLine() });
  const cancelAddLine = useCallback(() => setAddingDraft(null), []);
  const patchAddingDraft = useCallback(
    (patch: Partial<SoLineDraft>) => setAddingDraft((prev) => prev ? { ...prev, ...patch } : prev),
    [],
  );

  const commitEditingDraft = (lineId: string, d: SoLineDraft) =>
    updateItem.mutateAsync({
      id: header!.id, itemId: lineId,
      itemCode: d.itemCode, itemGroup: d.itemGroup, description: d.description,
      uom: d.uom, qty: d.qty, unitPriceCenti: d.unitPriceCenti, discountCenti: d.discountCenti,
      unitCostCenti: d.unitCostCenti, variants: d.variants, notes: d.remark,
    });

  const commitAddLine = (d: SoLineDraft) =>
    addItem.mutateAsync({
      id: header!.id,
      itemCode: d.itemCode, itemGroup: d.itemGroup, description: d.description,
      uom: d.uom, qty: d.qty, unitPriceCenti: d.unitPriceCenti, discountCenti: d.discountCenti,
      unitCostCenti: d.unitCostCenti, variants: d.variants, notes: d.remark,
    });

  const flushPaymentDrafts = async () => {
    const persisted = paymentsQ.data ?? [];
    const draftIds = new Set(paymentDrafts.map((d) => d.uid));
    for (const p of persisted) {
      if (!draftIds.has(p.id)) {
        await deletePayment.mutateAsync({ id: header!.id, paymentId: p.id });
      }
    }
    const persistedIds = new Set(persisted.map((p) => p.id));
    for (const d of paymentDrafts) {
      if (persistedIds.has(d.uid)) continue;
      if (d.amountCenti <= 0) continue;
      const { method } = labelToApi(d.methodLabel);
      const body: { id: string } & Record<string, unknown> = {
        id: header!.id,
        paidAt: d.paidAt,
        method,
        amountCenti: d.amountCenti,
        accountSheet: d.accountSheet || null,
        approvalCode: d.approvalCode || null,
        collectedBy: d.collectedBy || null,
      };
      Object.assign(body, draftMethodFields(method, d));
      await addPayment.mutateAsync(body);
    }
  };

  const saveEdit = () => {
    const handle = customerCardRef.current;
    if (!handle || !header || savingOrder) return;
    setSaveError(null);

    if (addingDraft && !addingDraft.itemCode.trim()) {
      setSaveError('Pick a product for the new line, or remove it before saving.');
      return;
    }
    const blankLine = Object.values(editingDrafts).find((d) => !d.itemCode.trim());
    if (blankLine) {
      setSaveError('Every line must have a product selected before saving.');
      return;
    }

    setSavingOrder(true);
    const lineEntries = Object.entries(editingDrafts);
    const pendingAdd = addingDraft;

    handle.save({
      onSuccess: () => {
        Promise.all(lineEntries.map(([lineId, d]) => commitEditingDraft(lineId, d)))
          .then(async () => { if (pendingAdd) await commitAddLine(pendingAdd); })
          .then(() => flushPaymentDrafts())
          .then(() => { setSavingOrder(false); setIsEditing(false); })
          .catch((e) => {
            setSavingOrder(false);
            setSaveError(`Lines / payments failed to save: ${e instanceof Error ? e.message : String(e)}`);
          });
      },
      onError: (msg) => { setSavingOrder(false); setSaveError(msg); },
    });
  };

  if (detail.isPending) {
    return <SkeletonDetailPage />;
  }
  if (detail.isError || !header) {
    return (
      <div className={styles.page}>
        <Link to="/scm/sales-invoices" className={styles.backBtn}>
          <ArrowLeft {...ICON} /><span>Back</span>
        </Link>
        <div className={styles.bannerWarn}>
          <strong>Sales invoice not found.</strong>
          {detail.error instanceof Error ? ` ${detail.error.message}` : null}
        </div>
      </div>
    );
  }

  const isLocked = lockedStatuses.includes(header.status);
  const isCancelled = header.status === 'CANCELLED';
  const isDraft = header.status === 'DRAFT';
  const grandTotal = header.local_total_centi || header.total_centi || 0;

  const handlePrint = () => {
    import('../../vendor/scm/lib/sales-invoice-pdf')
      .then(({ generateSalesInvoicePdf }) => generateSalesInvoicePdf(header as never, items as never))
      .catch((e) => notify({ title: 'PDF generation failed', body: e instanceof Error ? e.message : String(e), tone: 'error' }));
  };

  const handleCancel = async () => {
    if (!(await askConfirm({ title: `Cancel ${header.invoice_number}?`, body: 'This sets status = CANCELLED.', confirmLabel: 'Cancel', danger: true }))) return;
    updateStatus.mutate({ id: header.id, status: 'CANCELLED' });
  };
  const handleReopen = async () => {
    if (!(await askConfirm({ title: `Reopen ${header.invoice_number} back to Issued?`, confirmLabel: 'Reopen' }))) return;
    updateStatus.mutate({ id: header.id, status: 'SENT' });
  };
  /* Confirm a DRAFT invoice → SENT. This is where the server posts AR/GL revenue
     and auto-applies customer credit (both skipped on draft create). Mirrors the
     SO confirm (SalesOrderDetail DRAFT banner). */
  const handleConfirm = async () => {
    if (!(await askConfirm({
      title: `Confirm ${header.invoice_number}?`,
      body: 'This issues the invoice — it posts revenue (AR / Sales) and applies any customer credit. It will then appear in Outstanding / AR aging.',
      confirmLabel: 'Confirm Invoice',
    }))) return;
    updateStatus.mutate({ id: header.id, status: 'SENT' });
  };

  return (
    <div className={styles.page} style={isCancelled ? { filter: 'grayscale(0.7)' } : undefined}>
      {/* ── Header ── */}
      <div className={styles.headerRow}>
        <div className={styles.titleBlock}>
          <Link to="/scm/sales-invoices" className={styles.backBtn}>
            <ArrowLeft {...ICON} /><span>Back</span>
          </Link>
          <div>
            <h1 className={styles.title}>
              <FileText size={16} strokeWidth={1.75} style={TITLE_ICON_STYLE} />
              {header.invoice_number} — {header.debtor_name}
            </h1>
            <p className={styles.subtitle}>
              Invoice date {fmtDateOrDash(header.invoice_date)} · {header.line_count} {header.line_count === 1 ? 'line' : 'lines'}
              {header.so_doc_no && ` · Transfer From ${header.so_doc_no}`}
              {header.delivery_order_id && ' · Linked DO'}
            </p>
          </div>
        </div>
        <div className={styles.actions}>
          <div className={styles.totalRail}>
            <span className={styles.totalRailLabel}>Total</span>
            <span className={styles.totalRailValue}>{fmtRm(grandTotal, header.currency)}</span>
          </div>
          <StatusPill docType="si" status={header.status} />
          <RelationshipMapButton type="si" id={id} />
          <Button variant="ghost" size="md" onClick={handlePrint}>
            <Printer {...ICON} /><span>Print PDF</span>
          </Button>
          {/* Commander 2026-05-30 (Phase B) — the in-place "append a DO into this
              invoice" path was removed when DO→Invoice became line-level + partial.
              New invoices are created from the line-level picker at
              /sales-invoices/from-do (one invoice per convert). */}
          {isCancelled ? (
            <Button variant="primary" size="md" onClick={handleReopen} disabled={updateStatus.isPending}>
              <RotateCcw {...ICON} /><span>Reopen Invoice</span>
            </Button>
          ) : !isEditing ? (
            <Button variant="ghost" size="md" onClick={handleCancel} disabled={updateStatus.isPending}
              style={{ color: 'var(--c-festive-b, #B8331F)' }}>
              <Ban {...ICON} /><span>Cancel Invoice</span>
            </Button>
          ) : null}
          {!isEditing ? (
            <Button variant="primary" size="md" onClick={enterEdit} disabled={isLocked}>
              <Pencil {...ICON} /><span>Edit</span>
            </Button>
          ) : (
            <>
              <Button variant="ghost" size="md" onClick={cancelEdit} disabled={updateHeader.isPending || savingOrder}>
                <span>Cancel</span>
              </Button>
              <Button variant="primary" size="md" onClick={saveEdit} disabled={updateHeader.isPending || savingOrder}>
                <Save {...ICON} />
                <span>{updateHeader.isPending || savingOrder ? 'Saving…' : 'Save'}</span>
              </Button>
            </>
          )}
        </div>
      </div>

      {saveError && (
        <div className={styles.bannerWarn}>
          <strong>Save failed.</strong>
          <span>{saveError}</span>
        </div>
      )}

      {/* ── DRAFT banner + Confirm (DRAFT flow) ─────────────────────
          A DRAFT invoice committed nothing on create (no AR/GL revenue, no
          customer credit). The operator reviews + edits, then Confirms to
          issue it (DRAFT → SENT), which posts revenue + applies credit. Mirrors
          the SO DRAFT banner (SalesOrderDetail.tsx:971-1007). */}
      {isDraft && !isEditing && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: 'var(--space-3) var(--space-4)',
          background: 'rgba(232, 107, 58, 0.08)',
          border: '1px solid var(--c-orange)',
          borderRadius: 'var(--radius-md)',
          fontSize: 'var(--fs-13)',
        }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <FileText {...ICON} />
            <span>
              <strong>Draft — not yet confirmed.</strong>{' '}
              Review and Confirm to issue the invoice (it posts revenue / AR and applies customer credit, and only then appears in Outstanding).
            </span>
          </span>
          <Button variant="primary" size="sm" onClick={handleConfirm} disabled={updateStatus.isPending}>
            <span>{updateStatus.isPending ? 'Confirming…' : 'Confirm Invoice'}</span>
          </Button>
        </div>
      )}

      {/* ── Customer / Invoice Info / Emergency / Address cards ── */}
      <CustomerCard
        ref={customerCardRef}
        header={header}
        onSave={handleHeaderSave}
        locked={isLocked}
        isEditing={isEditing}
      />

      {/* ── Line items ── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Line Items ({items.length})</h2>
          {isEditing && !addingDraft && (
            <Button variant="primary" size="sm" onClick={startAddLine} disabled={isLocked}>
              <Plus {...ICON} /><span>Add Line Item</span>
            </Button>
          )}
        </header>

        {items.length === 0 && !isEditing ? (
          <p className={styles.emptyRow}>No items yet — click "Edit" then "Add Line Item" or "From Delivery Order" to begin.</p>
        ) : isEditing ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', padding: 'var(--space-3)' }}>
            {items.map((it, idx) => {
              const editDraft = editingDrafts[it.id];
              if (!editDraft) return null;
              const cb = rowCallbacks.get(it.id);
              return (
                <SoLineCard
                  key={it.id}
                  index={idx}
                  draft={editDraft}
                  onChange={cb?.onChange ?? ((patch) => patchEditingDraft(it.id, patch))}
                  onRemove={cb?.onRemove ?? (() => removeEditingLine(it.id))}
                  canRemove={!isLocked}
                />
              );
            })}
            {addingDraft && (
              <SoLineCard
                index={items.length}
                draft={addingDraft}
                onChange={patchAddingDraft}
                onRemove={cancelAddLine}
                canRemove={true}
              />
            )}
            {items.length === 0 && !addingDraft && (
              <p className={styles.emptyRow} style={{ padding: 'var(--space-3)' }}>
                No items yet — click "Add Line Item" above or "From Delivery Order" to begin.
              </p>
            )}
          </div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Item</th>
                <th className={styles.tableRight}>Qty</th>
                <th className={styles.tableRight}>Unit</th>
                <th className={styles.tableRight}>Disc</th>
                <th className={styles.tableRight}>Total</th>
                <th className={styles.tableRight}>Unit Cost</th>
                <th className={styles.tableRight}>Line Cost</th>
                <th className={styles.tableRight}>Margin</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id}>
                  <td>
                    {/* Description ONCE, code NOT displayed, variant KEPT — the
                        shared rule (vendor/shared/line-identity.ts). The code
                        still BINDS. This table has no "Description 2" column, so
                        the variant IS this cell's second line: live summary
                        first, falling back to the stored description2 so a line
                        with no live variants still shows its saved spec instead
                        of a blank cell (mirrors DO detail). */}
                    {(() => {
                      const { primary, secondary } = lineIdentity({
                        code: it.item_code,
                        description: it.description,
                        variant:
                          buildVariantSummary(it.item_group, it.variants)
                          || (it.description2 ?? ''),
                      });
                      return (
                        <>
                          <div className={styles.codeCell}>{primary || '—'}</div>
                          {secondary && <div className={styles.muted}>{secondary}</div>}
                        </>
                      );
                    })()}
                  </td>
                  <td className={styles.tableRight}>{it.qty}</td>
                  <td className={styles.tableRight}>{fmtRm(it.unit_price_centi, header.currency)}</td>
                  <td className={styles.tableRight}>{it.discount_centi > 0 ? fmtRm(it.discount_centi, header.currency) : '—'}</td>
                  <td className={styles.priceCell}>{fmtRm(it.line_total_centi, header.currency)}</td>
                  <td className={styles.tableRight}>
                    {lineCostPending(it, isCancelled)
                      ? <span className={styles.pendingPill}>Pending</span>
                      : <span className={styles.muted}>{it.unit_cost_centi > 0 ? fmtRm(it.unit_cost_centi, header.currency) : '—'}</span>}
                  </td>
                  <td className={styles.tableRight}>
                    {lineCostPending(it, isCancelled)
                      ? <span className={styles.pendingPill}>Pending</span>
                      : <span className={styles.muted}>{it.line_cost_centi > 0 ? fmtRm(it.line_cost_centi, header.currency) : '—'}</span>}
                  </td>
                  <td className={styles.tableRight}>
                    {lineCostPending(it, isCancelled) ? (
                      <span className={styles.muted}>—</span>
                    ) : it.line_total_centi > 0 ? (
                      <span className={it.line_margin_centi > 0 ? styles.marginGood : it.line_margin_centi < 0 ? styles.marginBad : styles.muted}
                        style={{ fontWeight: 600 }}>
                        {fmtRm(it.line_margin_centi, header.currency)}
                      </span>
                    ) : <span className={styles.muted}>—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <TotalsCard header={header} costPending={items.some((it) => lineCostPending(it, isCancelled))} />

      {/* DRAFT/Confirmed two-state (Owner 2026-06-25) — a DRAFT SI is not payable
          (the server 409s any payment), so keep the payments ledger locked even in
          edit mode. Confirm the invoice first, then record payments. */}
      <PaymentsTable
        docNo={null}
        payments={paymentDrafts}
        onChange={setPaymentDrafts}
        grandTotalCenti={grandTotal}
        currency={header.currency}
        locked={isLocked || isDraft || !isEditing}
      />
    </div>
  );
};

/* ════════════════════════════════════════════════════════════════════════
   Customer / Invoice Info / Emergency / Address — editable cards.
   Mirrors DeliveryOrderDetail's CustomerCard (adapted to SI fields:
   invoice_date / due_date instead of driver / vehicle).
   ════════════════════════════════════════════════════════════════════════ */

type CustomerCardHandle = {
  save: (cb: { onSuccess: () => void; onError: (msg: string) => void }) => void;
  reset: () => void;
};

type CustomerCardProps = {
  header: SiHeader;
  onSave: (patch: Record<string, unknown>, cb?: { onSuccess?: () => void; onError?: (msg: string) => void }) => void;
  locked?: boolean;
  isEditing?: boolean;
};

const CustomerCardInner = forwardRef<CustomerCardHandle, CustomerCardProps>(({
  header, onSave, locked = false, isEditing = false,
}, ref) => {
  const localities = useLocalities();
  const localityRows = useMemo(() => localities.data ?? [], [localities.data]);
  const staffQ = useStaff();
  const staffList = (staffQ.data ?? []).filter((s) => s.active);

  const customerTypeOptsQ = useSoDropdownOptions('customer_type');
  const buildingTypeOptsQ = useSoDropdownOptions('building_type');
  const relationshipOptsQ = useSoDropdownOptions('relationship');
  const customerTypeOpts = optionsOrFallback('customer_type', customerTypeOptsQ.data);
  const buildingTypeOpts = optionsOrFallback('building_type', buildingTypeOptsQ.data);
  const relationshipOpts = optionsOrFallback('relationship', relationshipOptsQ.data);

  const initialFormFor = (h: SiHeader) => ({
    customerCode: h.debtor_code ?? '',
    customerName: h.debtor_name ?? '',
    customerSoNo: h.customer_so_no ?? '',
    email: h.email ?? '',
    customerType: h.customer_type ?? '',
    salespersonId: h.salesperson_id ?? '',
    buildingType: h.building_type ?? '',
    venue: h.venue ?? '',
    phone: h.phone ?? '',
    address1: h.address1 ?? '',
    address2: h.address2 ?? '',
    city: h.city ?? '',
    postcode: h.postcode ?? '',
    state: h.customer_state ?? '',
    emergencyContactName: h.emergency_contact_name ?? '',
    emergencyContactPhone: h.emergency_contact_phone ?? '',
    emergencyContactRelationship: h.emergency_contact_relationship ?? '',
    invoiceDate: h.invoice_date ?? '',
    dueDate: h.due_date ?? '',
    note: h.note ?? h.notes ?? '',
    salesLocation: h.sales_location ?? '',
  });

  const [form, setForm] = useState(() => initialFormFor(header));

  useEffect(() => {
    setForm(initialFormFor(header));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [header]);

  const set = <K extends keyof typeof form>(k: K, v: string) =>
    setForm((s) => ({ ...s, [k]: v }));

  const states = useMemo(() => distinctStates(localityRows), [localityRows]);
  const cities = useMemo(() => (form.state ? citiesInState(localityRows, form.state) : []), [localityRows, form.state]);
  const postcodes = useMemo(
    () => (form.state && form.city ? postcodesInCity(localityRows, form.state, form.city) : []),
    [localityRows, form.state, form.city],
  );

  const buildPayload = () => ({
    debtorCode: form.customerCode,
    debtorName: form.customerName,
    customerSoNo: form.customerSoNo || null,
    email: form.email,
    customerType: form.customerType,
    salespersonId: form.salespersonId || null,
    buildingType: form.buildingType,
    venue: form.venue,
    phone: form.phone,
    address1: form.address1,
    address2: form.address2,
    city: form.city,
    postcode: form.postcode,
    customerState: form.state,
    state: form.state,
    emergencyContactName: form.emergencyContactName,
    emergencyContactPhone: form.emergencyContactPhone,
    emergencyContactRelationship: form.emergencyContactRelationship,
    invoiceDate: form.invoiceDate || null,
    dueDate: form.dueDate || null,
    note: form.note,
    salesLocation: form.salesLocation || null,
  });

  useImperativeHandle(ref, () => ({
    save: (cb) => onSave(buildPayload(), cb),
    reset: () => setForm(initialFormFor(header)),
  }));

  const inputsDisabled = !isEditing || locked;

  return (
    <>
      {/* ── CUSTOMER ── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}><h2 className={styles.cardTitle}>Customer</h2></header>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <label className={styles.field} style={{ gridColumn: 'span 3' }}>
              <span className={styles.fieldLabel}>Customer Name *</span>
              <input className={styles.fieldInput} value={form.customerName}
                disabled={inputsDisabled} onChange={(e) => set('customerName', e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Customer SO Ref</span>
              <input className={styles.fieldInput} value={form.customerSoNo}
                placeholder="Their PO / SO number" disabled={inputsDisabled}
                onChange={(e) => set('customerSoNo', e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Phone *</span>
              <PhoneInput className={styles.fieldInput} value={form.phone} disabled={inputsDisabled} onChange={(v) => set('phone', v)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Email</span>
              <input type="email" className={styles.fieldInput} value={form.email}
                disabled={inputsDisabled} onChange={(e) => set('email', e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Customer Type</span>
              <span className={styles.selectWrap}>
                <select className={styles.fieldSelect} value={form.customerType}
                  disabled={inputsDisabled} onChange={(e) => set('customerType', e.target.value)}>
                  <option value="">—</option>
                  {sortByText(customerTypeOpts).map((t) => <option key={t.id} value={t.value}>{t.label}</option>)}
                  {form.customerType && !customerTypeOpts.some((t) => t.value === form.customerType) && (
                    <option value={form.customerType}>{form.customerType}</option>
                  )}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Salesperson</span>
              <span className={styles.selectWrap}>
                <select className={styles.fieldSelect} value={form.salespersonId}
                  disabled={inputsDisabled} onChange={(e) => set('salespersonId', e.target.value)}>
                  <option value="">— Pick staff —</option>
                  {sortByText(staffList).map((s) => <option key={s.id} value={s.id}>{s.name} ({s.staffCode})</option>)}
                  {form.salespersonId && !staffList.some((s) => s.id === form.salespersonId) && (
                    <option value={form.salespersonId}>(former staff)</option>
                  )}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
          </div>
        </div>
      </section>

      {/* ── INVOICE INFO (dates / venue / note) ── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}><h2 className={styles.cardTitle}>Invoice Info</h2></header>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Invoice Date</span>
              <DateField className={styles.fieldInput} fullWidth value={form.invoiceDate ?? ''}
                disabled={inputsDisabled} onChange={(iso) => set('invoiceDate', iso)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Due Date</span>
              <DateField className={styles.fieldInput} fullWidth value={form.dueDate ?? ''}
                disabled={inputsDisabled} onChange={(iso) => set('dueDate', iso)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Building Type</span>
              <span className={styles.selectWrap}>
                <select className={styles.fieldSelect} value={form.buildingType}
                  disabled={inputsDisabled} onChange={(e) => set('buildingType', e.target.value)}>
                  <option value="">—</option>
                  {sortByText(buildingTypeOpts).map((b) => <option key={b.id} value={b.value}>{b.label}</option>)}
                  {form.buildingType && !buildingTypeOpts.some((b) => b.value === form.buildingType) && (
                    <option value={form.buildingType}>{form.buildingType}</option>
                  )}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Venue</span>
              <input className={styles.fieldInput} value={form.venue}
                disabled={inputsDisabled} onChange={(e) => set('venue', e.target.value)} />
            </label>
            <label className={styles.field} style={{ gridColumn: 'span 4' }}>
              <span className={styles.fieldLabel}>Note</span>
              <input className={styles.fieldInput} value={form.note}
                disabled={inputsDisabled} onChange={(e) => set('note', e.target.value)} />
            </label>
          </div>
        </div>
      </section>

      {/* ── EMERGENCY CONTACT ── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Emergency Contact</h2>
          <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
            Used only if we cannot reach the customer
          </span>
        </header>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Contact Name</span>
              <input className={styles.fieldInput} value={form.emergencyContactName}
                placeholder="e.g. Lim Mei Hua" disabled={inputsDisabled}
                onChange={(e) => set('emergencyContactName', e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Relationship</span>
              <span className={styles.selectWrap}>
                <select className={styles.fieldSelect} value={form.emergencyContactRelationship}
                  disabled={inputsDisabled} onChange={(e) => set('emergencyContactRelationship', e.target.value)}>
                  <option value="">—</option>
                  {sortByText(relationshipOpts).map((r) => <option key={r.id} value={r.value}>{r.label}</option>)}
                  {form.emergencyContactRelationship && !relationshipOpts.some((r) => r.value === form.emergencyContactRelationship) && (
                    <option value={form.emergencyContactRelationship}>{form.emergencyContactRelationship}</option>
                  )}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <label className={styles.field} style={{ gridColumn: 'span 2' }}>
              <span className={styles.fieldLabel}>Phone</span>
              <PhoneInput className={styles.fieldInput} value={form.emergencyContactPhone}
                disabled={inputsDisabled} onChange={(v) => set('emergencyContactPhone', v)} />
            </label>
          </div>
        </div>
      </section>

      {/* ── ADDRESS ── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}><h2 className={styles.cardTitle}>Billing / Delivery Address</h2></header>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <label className={styles.field} style={{ gridColumn: 'span 4' }}>
              <span className={styles.fieldLabel}>Address Line 1</span>
              <input className={styles.fieldInput} value={form.address1}
                placeholder="Unit, street, area" disabled={inputsDisabled}
                onChange={(e) => set('address1', e.target.value)} />
            </label>
            <label className={styles.field} style={{ gridColumn: 'span 4' }}>
              <span className={styles.fieldLabel}>Address Line 2</span>
              <input className={styles.fieldInput} value={form.address2}
                placeholder="Apt, floor, building (optional)" disabled={inputsDisabled}
                onChange={(e) => set('address2', e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>State</span>
              <span className={styles.selectWrap}>
                <select className={styles.fieldSelect} value={form.state}
                  onChange={(e) => setForm((s) => ({ ...s, state: e.target.value, city: '', postcode: '' }))}
                  disabled={inputsDisabled || localities.isLoading}>
                  <option value="">{localities.isLoading ? 'Loading…' : 'Pick state'}</option>
                  {sortByText(states).map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>City</span>
              <span className={styles.selectWrap}>
                <select className={styles.fieldSelect} value={form.city}
                  onChange={(e) => setForm((s) => ({ ...s, city: e.target.value, postcode: '' }))}
                  disabled={inputsDisabled || !form.state}>
                  <option value="">{form.state ? 'Pick city' : '— pick state first'}</option>
                  {sortByText(cities).map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Postcode</span>
              <span className={styles.selectWrap}>
                <select className={styles.fieldSelect} value={form.postcode}
                  onChange={(e) => set('postcode', e.target.value)}
                  disabled={inputsDisabled || !form.city}>
                  <option value="">{form.city ? 'Pick postcode' : '— pick city first'}</option>
                  {sortByNumeric(postcodes).map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Sales Location</span>
              <span className={styles.fieldInput} style={{ display: 'inline-flex', alignItems: 'center', height: 26, color: 'var(--fg-muted)' }}>
                {form.salesLocation || header.sales_location || '—'}
              </span>
            </div>
          </div>
        </div>
      </section>
    </>
  );
});
CustomerCardInner.displayName = 'CustomerCardInner';
const CustomerCard = memo(CustomerCardInner) as typeof CustomerCardInner;

/* ════════════════════════════════════════════════════════════════════════
   Totals card (mirror of DeliveryOrderDetail's TotalsCard)
   ════════════════════════════════════════════════════════════════════════ */
const TotalsCard = ({ header, costPending = false }: { header: SiHeader; costPending?: boolean }) => {
  const revenue = header.local_total_centi || header.total_centi || 0;
  const marginPct = header.margin_pct_basis / 100;
  const marginCls =
    header.total_margin_centi <= 0 ? styles.marginBad
    : marginPct >= 30 ? styles.marginGood
    : marginPct >= 15 ? styles.marginWarn
    : styles.marginBad;

  const categories: Array<{ label: string; rev: number; cost: number }> = [
    { label: 'Mattress / Sofa', rev: header.mattress_sofa_centi, cost: header.mattress_sofa_cost_centi ?? 0 },
    { label: 'Bedframe',        rev: header.bedframe_centi,      cost: header.bedframe_cost_centi      ?? 0 },
    { label: 'Accessories',     rev: header.accessories_centi,   cost: header.accessories_cost_centi   ?? 0 },
    { label: 'Others',          rev: header.others_centi,        cost: header.others_cost_centi        ?? 0 },
    /* SO-SKU spec P2 (D1, migration 0155) — SERVICE bucket (delivery fee /
       dispose / lift lines); hidden when zero so legacy docs keep 4 rows. */
    ...((((header as unknown as { service_centi?: number | null }).service_centi ?? 0) > 0)
      ? [{
          label: 'Services',
          rev:  (header as unknown as { service_centi?: number | null }).service_centi ?? 0,
          cost: (header as unknown as { service_cost_centi?: number | null }).service_cost_centi ?? 0,
        }]
      : []),
  ];

  const fmtMarginClass = (rev: number, marginCenti: number) => {
    if (rev <= 0) return styles.muted;
    if (marginCenti > 0) return styles.marginGood;
    if (marginCenti < 0) return styles.marginBad;
    return styles.muted;
  };

  return (
    <section className={styles.card}>
      <header className={styles.cardHeader}><h2 className={styles.cardTitle}>Totals · Margin</h2></header>
      <div className={styles.cardBody}>
        <div style={TOTALS_KPI_GRID_STYLE}>
          <div>
            <div className={styles.totalLabel}>Revenue</div>
            <div className={styles.grandTotal} style={TOTALS_KPI_VALUE_STYLE}>{fmtRm(revenue, header.currency)}</div>
          </div>
          <div>
            <div className={styles.totalLabel}>Cost</div>
            <div className={styles.totalValue} style={TOTALS_KPI_VALUE_STYLE}>
              {fmtRm(header.total_cost_centi, header.currency)}
              {costPending && <span className={styles.pendingPill} style={{ marginLeft: 'var(--space-2)' }}>Pending</span>}
            </div>
          </div>
          <div>
            <div className={styles.totalLabel}>Margin</div>
            <div className={`${styles.totalValue} ${costPending ? styles.muted : marginCls}`} style={TOTALS_KPI_VALUE_STYLE}>
              {costPending ? <span className={styles.pendingPill}>Pending</span> : fmtRm(header.total_margin_centi, header.currency)}
            </div>
          </div>
          <div>
            <div className={styles.totalLabel}>Margin %</div>
            <div className={`${styles.totalValue} ${costPending ? styles.muted : marginCls}`} style={TOTALS_KPI_VALUE_STYLE}>
              {costPending ? '—' : revenue > 0 ? `${marginPct.toFixed(1)}%` : '—'}
            </div>
          </div>
        </div>
        <div className={styles.totalLabel} style={{ marginBottom: 'var(--space-2)' }}>By Category</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          {categories.filter((c) => c.rev > 0 || c.cost > 0).map(({ label, rev, cost }) => {
            const margin = rev - cost;
            return (
              <div key={label} style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr 1fr', gap: 'var(--space-3)', alignItems: 'baseline' }}>
                <div className={styles.totalLabel} style={{ textTransform: 'none', letterSpacing: 0, fontSize: 'var(--fs-13)' }}>{label}</div>
                <div className={styles.totalValue}>Revenue {fmtRm(rev, header.currency)}</div>
                <div className={styles.totalValue} style={{ color: 'var(--fg-muted)' }}>Cost {fmtRm(cost, header.currency)}</div>
                <div className={`${styles.totalValue} ${fmtMarginClass(rev, margin)}`}>Margin {fmtRm(margin, header.currency)}</div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
};
