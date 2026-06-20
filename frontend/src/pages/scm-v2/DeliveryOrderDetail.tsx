// ----------------------------------------------------------------------------
// DeliveryOrderDetail — full-page route at /scm/delivery-orders/:id.
//
// Editable clone of SalesOrderDetail. View→Edit gate; editable Customer /
// Order Info (incl. driver + dates) / Emergency Contact / Delivery Address /
// Line Items / Totals / Payments. Plus the DO status-advance buttons
// (LOADED → DISPATCHED → IN_TRANSIT → SIGNED → DELIVERED → INVOICED). Reuses
// the shared SoLineCard + PaymentsTable + SalesOrderDetail.module.css so the
// DO Detail reads identically to the SO Detail.
//
// PaymentsTable is rendered in DRAFT mode (it owns no DO endpoints) — this
// page loads the persisted DO payments into PaymentDraft[] and flushes
// adds/deletes through the DO payment hooks on Save, so the shared component
// is reused untouched.
// ----------------------------------------------------------------------------

import {
  forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState,
  type CSSProperties,
} from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, FileText, Pencil, Plus, Printer, Save, Truck, ChevronDown, Ban, RotateCcw,
} from 'lucide-react';
import { Button } from '@2990s/design-system';
import { PhoneInput } from '../../vendor/scm/components/PhoneInput';
import { SkeletonDetailPage } from '../../vendor/scm/components/Skeleton';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import {
  useMfgDeliveryOrderDetail,
  useUpdateMfgDeliveryOrderHeader,
  useUpdateMfgDeliveryOrderStatus,
  useAddMfgDeliveryOrderItem,
  useUpdateMfgDeliveryOrderItem,
  useDeleteMfgDeliveryOrderItem,
  useDeliveryOrderPayments,
  useAddDeliveryOrderPayment,
  useDeleteDeliveryOrderPayment,
  useDeliverableSoLinesForDoc,
  type DeliverableSoLine,
} from '../../vendor/scm/lib/delivery-order-queries';
import { SoLineCard, emptySoLine, type SoLineDraft } from '../../vendor/scm/components/SoLineCard';
import { RelationshipMapButton } from '../../vendor/scm/components/RelationshipMapButton';
import {
  PaymentsTable, labelToApi, draftMethodFields,
  newPaymentDraft, type PaymentDraft,
} from '../../vendor/scm/components/PaymentsTable';
import { buildVariantSummary, fmtDateOrDash } from '@2990s/shared';
import {
  useLocalities, distinctStates, citiesInState, postcodesInCity,
} from '../../vendor/scm/lib/localities-queries';
import {
  useSoDropdownOptions, optionsOrFallback,
} from '../../vendor/scm/lib/so-dropdown-options-queries';
import { useStaff } from '../../vendor/scm/lib/admin-queries';
import { useDrivers } from '../../vendor/scm/lib/drivers-queries';
import styles from './SalesOrderDetail.module.css';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const STATUS_FLOW = ['LOADED', 'DISPATCHED', 'IN_TRANSIT', 'SIGNED', 'DELIVERED', 'INVOICED', 'CANCELLED'] as const;
type DoStatus = typeof STATUS_FLOW[number];

/* Commander 2026-05-29 — the linear LOADED→DISPATCHED→… stage walk was retired.
   A DO is SHIPPED on creation (stock deducted then), so there's no manual
   next-stage map any more; only Cancel / Reopen remain (header buttons). */

const STATUS_CLASS: Record<string, string> = {
  LOADED:     styles.statusConfirmed ?? '',
  DISPATCHED: styles.statusShipped ?? '',
  IN_TRANSIT: styles.statusInProd ?? '',
  SIGNED:     styles.statusReady ?? '',
  DELIVERED:  styles.statusDelivered ?? '',
  INVOICED:   styles.statusInvoiced ?? '',
  RETURNED:   styles.statusReturned ?? '',
  CANCELLED:  styles.statusCancelled ?? '',
};

/* Document-driven status (latest event wins) — Cancelled / Shipped / Invoiced /
   Delivery Return. Mirrors the DO list. The detail endpoint sends lifecycle_state. */
type DoLifecycle = 'shipped' | 'invoiced' | 'returned';
const DO_STATUS_LABEL: Record<string, string> = {
  DISPATCHED: 'Shipped', INVOICED: 'Invoiced', RETURNED: 'Delivery Return', CANCELLED: 'Cancelled',
};
const doEffectiveKey = (status: string, lifecycle?: DoLifecycle): string => {
  if (status === 'CANCELLED') return 'CANCELLED';
  if (lifecycle === 'returned') return 'RETURNED';
  if (lifecycle === 'invoiced') return 'INVOICED';
  return 'DISPATCHED';
};

/* Costing A (Commander 2026-06-01) — a DO ships (stock deducted) the moment it's
   created, so the FIFO trigger has already booked the line's COGS. When that cost
   is still 0 on a live (non-cancelled) line with qty, the goods were received with
   NO price and no Purchase Invoice yet → cost is PENDING, not free. The recost
   engine fills the real number the instant a price lands. */
const lineCostPending = (
  it: { qty: number; unit_cost_centi: number },
  isCancelled: boolean,
): boolean => !isCancelled && Number(it.qty) > 0 && Number(it.unit_cost_centi ?? 0) === 0;

const fmtRm = (centi: number, currency = 'MYR'): string =>
  `${currency} ${(centi / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const TITLE_ICON_STYLE: CSSProperties = { color: 'var(--c-burnt)' };
const TOTALS_KPI_GRID_STYLE: CSSProperties = {
  display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--space-3)',
  marginBottom: 'var(--space-3)', paddingBottom: 'var(--space-3)', borderBottom: '1px solid var(--line)',
};
const TOTALS_KPI_VALUE_STYLE: CSSProperties = { fontSize: 'var(--fs-15, 15px)' };

type DoHeader = {
  id: string;
  do_number: string;
  so_doc_no: string | null;
  status: DoStatus;
  do_date: string;
  expected_delivery_at: string | null;
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
  driver_id: string | null;
  driver_name: string | null;
  vehicle: string | null;
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
  total_cost_centi: number;
  total_margin_centi: number;
  margin_pct_basis: number;
  line_count: number;
  currency: string;
  /* Tier 2 downstream-lock — detail endpoint stamps this when any non-cancelled
     DR / SI references the DO. Locks line edits + the Cancel transition;
     convert-to-DR / convert-to-SI remain available via the list. */
  has_children?: boolean;
};

type DoItem = {
  id: string;
  delivery_order_id: string;
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
  /* Per-line ship-from warehouse (Agent D, TASK #32): resolved server-side from
     the SO line → DO header → default; display-only so the operator can see
     which warehouse each line deducts from. */
  warehouse_id?: string | null;
  warehouse_code?: string | null;
  /* Downstream "Transfer To" breakdown (read-only): the Sales Invoice(s) and
     Delivery Return(s) this DO line was carried into, resolved server-side. */
  downstream?: { docNumber: string; docType: 'SI' | 'DR'; qty: number; status: string }[];
};

/* One not-yet-saved add-line. soItemId/maxQty are set when picked from the
   parent SO (links + caps the create); null for an ad-hoc blank line. */
type PendingAdd = { uid: string; soItemId: string | null; maxQty: number; draft: SoLineDraft };
const newUid = (): string => Math.random().toString(36).slice(2, 10);

const draftFromItem = (it: DoItem): SoLineDraft => ({
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

export const DeliveryOrderDetail = () => {
  const { id } = useParams<{ id: string }>();
  const askConfirm = useConfirm();
  const notify = useNotify();
  const [searchParams] = useSearchParams();
  const detail = useMfgDeliveryOrderDetail(id ?? null);
  const updateHeader = useUpdateMfgDeliveryOrderHeader();
  const updateStatus = useUpdateMfgDeliveryOrderStatus();
  const addItem = useAddMfgDeliveryOrderItem();
  const updateItem = useUpdateMfgDeliveryOrderItem();
  const deleteItem = useDeleteMfgDeliveryOrderItem();

  const header = (detail.data?.deliveryOrder as DoHeader | undefined) ?? null;
  const items = useMemo(() => (detail.data?.items as DoItem[] | undefined) ?? [], [detail.data]);

  /* SO-linked DOs: the only way to add a line is to pick one of the parent SO's
     still-undelivered lines (qty capped to remaining), so Add Line stays in
     lock-step with the convert picker. Ad-hoc DOs (no parent SO) keep the free
     blank-line add. */
  const soDocNo = header?.so_doc_no ?? null;
  const deliverableQ = useDeliverableSoLinesForDoc(soDocNo);

  // ── Payments (DRAFT-mode PaymentsTable + manual persistence) ──────────
  const paymentsQ = useDeliveryOrderPayments(id ?? null);
  const addPayment = useAddDeliveryOrderPayment();
  const deletePayment = useDeleteDeliveryOrderPayment();
  const [paymentDrafts, setPaymentDrafts] = useState<PaymentDraft[]>([]);

  const [editingDrafts, setEditingDrafts] = useState<Record<string, SoLineDraft>>({});
  /* Pending add-lines (Wei Siang 2026-05-31) — you can stack several before one
     Save, so picking a second SO line no longer hides the first. Each carries
     its own SO link + remaining cap (soItemId/maxQty) so the create links the
     right SO line and never over-delivers. soItemId null = ad-hoc blank line. */
  const [addingDrafts, setAddingDrafts] = useState<PendingAdd[]>([]);

  const [isEditing, setIsEditing] = useState(searchParams.get('edit') === '1');
  const [justCreated, setJustCreated] = useState(searchParams.get('created') === '1');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savingOrder, setSavingOrder] = useState(false);
  const customerCardRef = useRef<CustomerCardHandle | null>(null);

  // Lock: terminal-ish states (INVOICED / CANCELLED) lock the header.
  const lockedStatuses: DoStatus[] = ['INVOICED', 'CANCELLED'];

  /* Seed payment drafts from persisted DO payments whenever we enter edit
     mode or the ledger reloads. apiToDraft maps the persisted enum/sub-fields
     back to the L1/L2 labels PaymentsTable renders. */
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
      // DO payments carry no per-payment slip (Spec D4 applies to the SO route).
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

  /* Edit-mode seed/clear — populate a draft per line + payment drafts; clear
     on exit. Mirrors SalesOrderDetail. */
  useEffect(() => {
    if (!isEditing) {
      setEditingDrafts({});
      setAddingDrafts([]);
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
          if (await askConfirm({ title: `Remove ${it.item_code} from this DO?`, confirmLabel: 'Remove', danger: true })) {
            deleteItem.mutate(
              { id: it.delivery_order_id, itemId: it.id },
              { onSuccess: () => removeEditingLine(it.id) },
            );
          }
        },
      });
    }
    return map;
  }, [items, patchEditingDraft, removeEditingLine, deleteItem, askConfirm]);

  const startAddLine = () =>
    setAddingDrafts((prev) => [...prev, { uid: newUid(), soItemId: null, maxQty: 0, draft: { ...emptySoLine() } }]);
  /* Append one more add-line seeded from a chosen SO remaining line (SO-linked
     DOs). Stacking is allowed — pick SK then K and both sit as drafts until Save. */
  const addFromSoLine = (line: DeliverableSoLine) => {
    setAddingDrafts((prev) => [...prev, {
      uid: newUid(),
      soItemId: line.soItemId,
      maxQty: line.remaining,
      draft: {
        itemCode: line.itemCode,
        itemGroup: line.itemGroup ?? 'others',
        description: line.description ?? '',
        uom: line.uom ?? 'UNIT',
        qty: line.remaining,
        unitPriceCenti: line.unitPriceCenti,
        discountCenti: line.discountCenti,
        unitCostCenti: line.unitCostCenti,
        variants: (line.variants as Record<string, unknown>) ?? {},
        remark: '',
      },
    }]);
  };
  const removeAddingDraft = useCallback(
    (uid: string) => setAddingDrafts((prev) => prev.filter((p) => p.uid !== uid)),
    [],
  );
  const patchAddingDraft = useCallback(
    (uid: string, patch: Partial<SoLineDraft>) =>
      setAddingDrafts((prev) => prev.map((p) => (p.uid === uid ? { ...p, draft: { ...p.draft, ...patch } } : p))),
    [],
  );

  const commitEditingDraft = (lineId: string, d: SoLineDraft) =>
    updateItem.mutateAsync({
      id: header!.id, itemId: lineId,
      itemCode: d.itemCode, itemGroup: d.itemGroup, description: d.description,
      uom: d.uom, qty: d.qty, unitPriceCenti: d.unitPriceCenti, discountCenti: d.discountCenti,
      unitCostCenti: d.unitCostCenti, variants: d.variants, notes: d.remark,
    });

  const commitAddLine = (p: PendingAdd) =>
    addItem.mutateAsync({
      id: header!.id,
      // Link to the SO line + clamp to remaining when this add came from the SO
      // picker; the backend enforces the same cap as a final guard.
      soItemId: p.soItemId ?? undefined,
      itemCode: p.draft.itemCode, itemGroup: p.draft.itemGroup, description: p.draft.description,
      uom: p.draft.uom, qty: p.soItemId ? Math.min(p.draft.qty, p.maxQty) : p.draft.qty,
      unitPriceCenti: p.draft.unitPriceCenti, discountCenti: p.draft.discountCenti,
      unitCostCenti: p.draft.unitCostCenti, variants: p.draft.variants, notes: p.draft.remark,
    });

  /* Persist the payment drafts: delete removed rows, POST new ones. Existing
     rows whose uid is a persisted id are left as-is (PaymentsTable rows aren't
     edited in place here — add/remove only, matching the SO Detail ledger). */
  const flushPaymentDrafts = async () => {
    const persisted = paymentsQ.data ?? [];
    const draftIds = new Set(paymentDrafts.map((d) => d.uid));
    // Delete rows the user removed.
    for (const p of persisted) {
      if (!draftIds.has(p.id)) {
        await deletePayment.mutateAsync({ id: header!.id, paymentId: p.id });
      }
    }
    // POST genuinely-new draft rows (uid not among persisted ids).
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

    if (addingDrafts.some((p) => !p.draft.itemCode.trim())) {
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
    const pendingAdds = addingDrafts;

    handle.save({
      onSuccess: () => {
        Promise.all(lineEntries.map(([lineId, d]) => commitEditingDraft(lineId, d)))
          // Commit the stacked add-lines in order so each gets its own DO line.
          .then(async () => { for (const p of pendingAdds) await commitAddLine(p); })
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

  if (detail.isLoading) {
    return <SkeletonDetailPage />;
  }
  if (detail.isError || !header) {
    return (
      <div className={styles.page}>
        <Link to="/scm/delivery-orders" className={styles.backBtn}>
          <ArrowLeft {...ICON} /><span>Back</span>
        </Link>
        <div className={styles.bannerWarn}>
          <strong>Delivery order not found.</strong>
          {detail.error instanceof Error ? ` ${detail.error.message}` : null}
        </div>
      </div>
    );
  }

  /* Tier 2 downstream-lock — once a DR or SI references this DO the page is
     read-only. Cancel + line edits stop; convert-to-DR / convert-to-SI stay
     available via the list. */
  const hasChildren = Boolean(header.has_children);
  const isLocked = lockedStatuses.includes(header.status) || hasChildren;
  const isCancelled = header.status === 'CANCELLED';

  const handlePrint = () => {
    import('../../vendor/scm/lib/delivery-order-pdf')
      .then(({ generateDeliveryOrderPdf }) => generateDeliveryOrderPdf(header as never, items as never))
      .catch((e) => notify({ title: 'PDF generation failed', body: e instanceof Error ? e.message : String(e), tone: 'error' }));
  };

  const handleCancel = async () => {
    if (!(await askConfirm({ title: `Cancel ${header.do_number}?`, body: 'This sets status = CANCELLED.', confirmLabel: 'Cancel', danger: true }))) return;
    updateStatus.mutate({ id: header.id, status: 'CANCELLED' });
  };
  const handleReopen = async () => {
    if (!(await askConfirm({ title: `Reopen ${header.do_number} back to LOADED?`, confirmLabel: 'Reopen' }))) return;
    updateStatus.mutate({ id: header.id, status: 'LOADED' });
  };

  return (
    <div className={styles.page} style={isCancelled ? { filter: 'grayscale(0.7)' } : undefined}>
      {/* ── Header ── */}
      <div className={styles.headerRow}>
        <div className={styles.titleBlock}>
          <Link to="/scm/delivery-orders" className={styles.backBtn}>
            <ArrowLeft {...ICON} /><span>Back</span>
          </Link>
          <div>
            <h1 className={styles.title}>
              <Truck size={16} strokeWidth={1.75} style={TITLE_ICON_STYLE} />
              {header.do_number} — {header.debtor_name}
            </h1>
            <p className={styles.subtitle}>
              DO date {fmtDateOrDash(header.do_date)} · {header.line_count} {header.line_count === 1 ? 'line' : 'lines'}
              {header.so_doc_no && ` · Transfer From ${header.so_doc_no}`}
            </p>
          </div>
        </div>
        <div className={styles.actions}>
          <div className={styles.totalRail}>
            <span className={styles.totalRailLabel}>Total</span>
            <span className={styles.totalRailValue}>{fmtRm(header.local_total_centi, header.currency)}</span>
          </div>
          {(() => {
            const key = doEffectiveKey(header.status, (header as { lifecycle_state?: DoLifecycle }).lifecycle_state);
            return (
              <span className={`${styles.statusPill} ${STATUS_CLASS[key] ?? ''}`}>
                {DO_STATUS_LABEL[key] ?? key.replace(/_/g, ' ')}
              </span>
            );
          })()}
          <RelationshipMapButton type="do" id={id} />
          <Button variant="ghost" size="md" onClick={handlePrint}>
            <Printer {...ICON} /><span>Print PDF</span>
          </Button>
          {isCancelled ? (
            <Button variant="primary" size="md" onClick={handleReopen} disabled={updateStatus.isPending}>
              <RotateCcw {...ICON} /><span>Reopen DO</span>
            </Button>
          ) : !isEditing && header.status !== 'INVOICED' ? (
            <Button variant="ghost" size="md" onClick={handleCancel} disabled={updateStatus.isPending}
              style={{ color: 'var(--c-festive-b, #B8331F)' }}>
              <Ban {...ICON} /><span>Cancel DO</span>
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

      {justCreated && !isCancelled && (
        <div className={styles.bannerOk}>
          <strong>Delivery order {header.do_number} created.</strong>
          <span>Stock has already been deducted. Nothing more to save — close this page or click Edit if you need to adjust delivery details.</span>
          <button type="button" className={styles.bannerDismiss} onClick={() => setJustCreated(false)}>Dismiss</button>
        </div>
      )}

      {saveError && (
        <div className={styles.bannerWarn}>
          <strong>Save failed.</strong>
          <span>{saveError}</span>
        </div>
      )}

      {/* Commander 2026-05-29 — the LOADED→DISPATCHED→IN_TRANSIT→… hand-walk was
          removed. A DO is SHIPPED the moment it's created (stock is deducted on
          create), so there's no manual stage strip — the operator just opens the
          DO and the goods are already out. Cancel + downstream Invoice/Return
          remain available from the header. */}

      {/* ── Customer / Order Info / Emergency / Address cards ── */}
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
          {isEditing && !isLocked && (
            soDocNo ? (() => {
              if (deliverableQ.isLoading) {
                return <span className={styles.fieldLabel}>Loading Sales Order lines…</span>;
              }
              // Hide lines already stacked as a pending add — the dropdown stays
              // open so you can keep picking the rest (Wei Siang 2026-05-31).
              const picked = new Set(addingDrafts.map((p) => p.soItemId).filter(Boolean));
              const deliverable = (deliverableQ.data ?? []).filter((l) => l.remaining > 0);
              const remainingLines = deliverable.filter((l) => !picked.has(l.soItemId));
              if (deliverable.length === 0) {
                return <span className={styles.fieldLabel}>All Sales Order lines fully delivered — nothing left to add.</span>;
              }
              if (remainingLines.length === 0) {
                return <span className={styles.fieldLabel}>All remaining lines added below — Save to confirm.</span>;
              }
              return (
                <select
                  value=""
                  onChange={(e) => {
                    const line = remainingLines.find((l) => l.soItemId === e.target.value);
                    if (line) addFromSoLine(line);
                  }}
                  style={{ padding: '6px 10px', borderRadius: 'var(--radius-md)', border: '1px solid var(--c-border, #d8d2c8)', fontSize: 'var(--fs-13)', background: 'var(--c-surface, #fff)' }}
                >
                  <option value="" disabled>+ Add from Sales Order…</option>
                  {remainingLines.map((l) => (
                    <option key={l.soItemId} value={l.soItemId}>
                      {l.itemCode}{l.description ? ` — ${l.description}` : ''} (remaining {l.remaining})
                    </option>
                  ))}
                </select>
              );
            })() : (
              <Button variant="primary" size="sm" onClick={startAddLine} disabled={isLocked}>
                <Plus {...ICON} /><span>Add Line Item</span>
              </Button>
            )
          )}
        </header>

        {items.length === 0 && !isEditing ? (
          <p className={styles.emptyRow}>No items yet — click "Edit" then "Add Line Item" to begin.</p>
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
            {addingDrafts.map((p, i) => (
              <SoLineCard
                key={p.uid}
                index={items.length + i}
                draft={p.draft}
                onChange={(patch) => patchAddingDraft(p.uid, patch)}
                onRemove={() => removeAddingDraft(p.uid)}
                canRemove={true}
              />
            ))}
            {items.length === 0 && addingDrafts.length === 0 && (
              <p className={styles.emptyRow} style={{ padding: 'var(--space-3)' }}>
                No items yet — click "Add Line Item" above to begin.
              </p>
            )}
          </div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Item</th>
                <th>Description 2</th>
                <th>Sales Location</th>
                <th className={styles.tableRight}>Qty</th>
                <th>Transfer To</th>
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
                    <div className={styles.codeCell}>{it.item_code}</div>
                    {it.description && <div className={styles.muted}>{it.description}</div>}
                  </td>
                  {/* "Description 2": variant/spec summary in its own column.
                      Prefers the stored description2, falls back to the computed
                      variant summary, then a muted em-dash when both are empty. */}
                  <td>
                    {(() => {
                      // Description 2 — live recompute first so detail matches list/PDF
                      // (Commander 2026-06-18). Stored is only a fallback.
                      const desc2 = buildVariantSummary(it.item_group, it.variants)
                        || (it.description2 && it.description2.trim()) || '';
                      return desc2
                        ? <span>{desc2}</span>
                        : <span className={styles.muted}>—</span>;
                    })()}
                  </td>
                  <td><span className={styles.muted}>{it.warehouse_code ?? '—'}</span></td>
                  <td className={styles.tableRight}>{it.qty}</td>
                  <td>
                    {(it.downstream ?? []).length === 0
                      ? <span className={styles.muted}>—</span>
                      : (it.downstream ?? []).map((d, di) => (
                          <div key={di} style={{ fontWeight: 600, color: 'var(--c-burnt)', whiteSpace: 'nowrap' }}>
                            {d.docNumber} <span className={styles.muted} style={{ fontWeight: 400 }}>×{d.qty}</span>
                          </div>
                        ))}
                  </td>
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

      <PaymentsTable
        docNo={null}
        payments={paymentDrafts}
        onChange={setPaymentDrafts}
        grandTotalCenti={header.local_total_centi}
        currency={header.currency}
        locked={isLocked || !isEditing}
      />
    </div>
  );
};

/* ════════════════════════════════════════════════════════════════════════
   Customer / Order Info / Emergency / Delivery Address — editable cards.
   Mirrors SalesOrderDetail's CustomerCard (adapted to DO fields + driver).
   ════════════════════════════════════════════════════════════════════════ */

type CustomerCardHandle = {
  save: (cb: { onSuccess: () => void; onError: (msg: string) => void }) => void;
  reset: () => void;
};

type CustomerCardProps = {
  header: DoHeader;
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
  const driversQ = useDrivers();
  const drivers = driversQ.data ?? [];

  const customerTypeOptsQ = useSoDropdownOptions('customer_type');
  const buildingTypeOptsQ = useSoDropdownOptions('building_type');
  const relationshipOptsQ = useSoDropdownOptions('relationship');
  const customerTypeOpts = optionsOrFallback('customer_type', customerTypeOptsQ.data);
  const buildingTypeOpts = optionsOrFallback('building_type', buildingTypeOptsQ.data);
  const relationshipOpts = optionsOrFallback('relationship', relationshipOptsQ.data);

  const initialFormFor = (h: DoHeader) => ({
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
    doDate: h.do_date ?? '',
    customerDeliveryDate: h.customer_delivery_date ?? '',
    expectedDeliveryAt: h.expected_delivery_at ?? '',
    note: h.note ?? h.notes ?? '',
    salesLocation: h.sales_location ?? '',
    driverId: h.driver_id ?? '',
    driverName: h.driver_name ?? '',
    vehicle: h.vehicle ?? '',
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
    doDate: form.doDate || null,
    customerDeliveryDate: form.customerDeliveryDate || null,
    expectedDeliveryAt: form.expectedDeliveryAt || null,
    note: form.note,
    salesLocation: form.salesLocation || null,
    driverId: form.driverId || null,
    driverName: form.driverName || null,
    vehicle: form.vehicle || null,
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
                  {customerTypeOpts.map((t) => <option key={t.id} value={t.value}>{t.label}</option>)}
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
                  {staffList.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.staffCode})</option>)}
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

      {/* ── ORDER INFO (driver / dates / note) ── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}><h2 className={styles.cardTitle}>Delivery Info</h2></header>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>DO Date</span>
              <input type="date" className={styles.fieldInput} value={form.doDate}
                disabled={inputsDisabled} onChange={(e) => set('doDate', e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Driver</span>
              <span className={styles.selectWrap}>
                <select className={styles.fieldSelect} value={form.driverId}
                  disabled={inputsDisabled}
                  onChange={(e) => {
                    const d = drivers.find((x) => x.id === e.target.value);
                    setForm((s) => ({ ...s, driverId: e.target.value, driverName: d?.name ?? '', vehicle: d?.vehicle ?? s.vehicle }));
                  }}>
                  <option value="">— Pick driver —</option>
                  {drivers.map((d) => <option key={d.id} value={d.id}>{d.name}{d.vehicle ? ` · ${d.vehicle}` : ''}</option>)}
                  {form.driverId && !drivers.some((d) => d.id === form.driverId) && (
                    <option value={form.driverId}>{form.driverName || '(driver)'}</option>
                  )}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Vehicle</span>
              <input className={styles.fieldInput} value={form.vehicle}
                disabled={inputsDisabled} onChange={(e) => set('vehicle', e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Building Type</span>
              <span className={styles.selectWrap}>
                <select className={styles.fieldSelect} value={form.buildingType}
                  disabled={inputsDisabled} onChange={(e) => set('buildingType', e.target.value)}>
                  <option value="">—</option>
                  {buildingTypeOpts.map((b) => <option key={b.id} value={b.value}>{b.label}</option>)}
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
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Expected Delivery</span>
              <input type="date" className={styles.fieldInput} value={form.expectedDeliveryAt}
                disabled={inputsDisabled} onChange={(e) => set('expectedDeliveryAt', e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Customer Delivery Date</span>
              <input type="date" className={styles.fieldInput} value={form.customerDeliveryDate}
                disabled={inputsDisabled} onChange={(e) => set('customerDeliveryDate', e.target.value)} />
            </label>
            <label className={styles.field} style={{ gridColumn: 'span 2' }}>
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
            Used only if we cannot reach the customer on delivery day
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
                  {relationshipOpts.map((r) => <option key={r.id} value={r.value}>{r.label}</option>)}
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

      {/* ── DELIVERY ADDRESS ── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}><h2 className={styles.cardTitle}>Delivery Address</h2></header>
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
                  {states.map((s) => <option key={s} value={s}>{s}</option>)}
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
                  {cities.map((c) => <option key={c} value={c}>{c}</option>)}
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
                  {postcodes.map((p) => <option key={p} value={p}>{p}</option>)}
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
   Totals card (mirror of SalesOrderDetail's TotalsCard)
   ════════════════════════════════════════════════════════════════════════ */
const TotalsCard = ({ header, costPending = false }: { header: DoHeader; costPending?: boolean }) => {
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
            <div className={styles.grandTotal} style={TOTALS_KPI_VALUE_STYLE}>{fmtRm(header.local_total_centi, header.currency)}</div>
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
              {costPending ? '—' : header.local_total_centi > 0 ? `${marginPct.toFixed(1)}%` : '—'}
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
