// ----------------------------------------------------------------------------
// DeliveryReturnDetail — full-page route at /delivery-returns/:id.
//
// Editable clone of DeliveryOrderDetail (itself an SO clone). View→Edit gate;
// editable Customer / Return Info / Emergency Contact / Delivery Address /
// Line Items / Totals. Reuses the shared SoLineCard + SalesOrderDetail.module.css
// so the DR Detail reads identically to the DO Detail.
//
// A Delivery Return = goods coming BACK. Stock was already INCREASED when the
// return was created (server-side, idempotent). There is no payments ledger on
// a return (unlike the DO), so the PaymentsTable is intentionally omitted.
//
// In Edit mode the header carries a "Convert from DO" action that opens the
// DO picker to start a NEW return (mirrors the PO detail's "Convert from SO").
// ----------------------------------------------------------------------------

import {
  forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState,
  type CSSProperties,
} from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, Pencil, Plus, Save, Undo2, ChevronDown, Ban, RotateCcw, ArrowRightLeft, Printer,
} from 'lucide-react';
import { Button } from '@2990s/design-system';
import { PhoneInput } from '../../vendor/scm/components/PhoneInput';
import { SkeletonDetailPage } from '../../vendor/scm/components/Skeleton';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import {
  useDeliveryReturnDetail,
  useUpdateDeliveryReturnHeader,
  useUpdateDeliveryReturnStatus,
  useAddDeliveryReturnItem,
  useUpdateDeliveryReturnItem,
  useDeleteDeliveryReturnItem,
} from '../../vendor/scm/lib/delivery-return-queries';
import { SoLineCard, emptySoLine, type SoLineDraft } from '../../vendor/scm/components/SoLineCard';
import { RelationshipMapButton } from '../../vendor/scm/components/RelationshipMapButton';
import { StatusPill } from '../../vendor/scm/components/StatusPill';
import { buildVariantSummary, fmtDateOrDash } from '@2990s/shared';
import {
  useLocalities, distinctStates, citiesInState, postcodesInCity,
} from '../../vendor/scm/lib/localities-queries';
import {
  useSoDropdownOptions, optionsOrFallback,
} from '../../vendor/scm/lib/so-dropdown-options-queries';
import { useStaff } from '../../vendor/scm/lib/admin-queries';
import styles from './SalesOrderDetail.module.css';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const STATUS_FLOW = ['PENDING', 'RECEIVED', 'INSPECTED', 'REFUNDED', 'CREDIT_NOTED', 'REJECTED', 'CANCELLED'] as const;
type DrStatus = typeof STATUS_FLOW[number];

const fmtRm = (centi: number, currency = 'MYR'): string =>
  `${currency} ${(centi / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const TITLE_ICON_STYLE: CSSProperties = { color: 'var(--c-burnt)' };
const TOTALS_KPI_GRID_STYLE: CSSProperties = {
  display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--space-3)',
  marginBottom: 'var(--space-3)', paddingBottom: 'var(--space-3)', borderBottom: '1px solid var(--line)',
};
const TOTALS_KPI_VALUE_STYLE: CSSProperties = { fontSize: 'var(--fs-15, 15px)' };

type DrHeader = {
  id: string;
  return_number: string;
  do_doc_no: string | null;
  delivery_order_id: string | null;
  status: DrStatus;
  return_date: string;
  reason: string | null;
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
  total_cost_centi: number;
  total_margin_centi: number;
  margin_pct_basis: number;
  line_count: number;
  currency: string;
};

type DrItem = {
  id: string;
  delivery_return_id: string;
  item_group: string | null;
  item_code: string;
  description: string | null;
  description2: string | null;
  uom: string;
  qty_returned: number;
  condition: string | null;
  unit_price_centi: number;
  discount_centi: number;
  line_total_centi: number;
  unit_cost_centi: number;
  line_cost_centi: number;
  line_margin_centi: number;
  variants: Record<string, unknown> | null;
  notes: string | null;
  /* Per-line restock warehouse (Agent D, TASK #32): resolved server-side as the
     same warehouse the DO took the stock OUT of, so the return IN lands back in
     that warehouse. Display-only. */
  warehouse_id?: string | null;
  warehouse_code?: string | null;
};

const draftFromItem = (it: DrItem): SoLineDraft => ({
  itemCode: it.item_code ?? '',
  itemGroup: it.item_group ?? 'others',
  description: it.description ?? '',
  uom: it.uom ?? 'UNIT',
  qty: it.qty_returned ?? 1,
  unitPriceCenti: it.unit_price_centi ?? 0,
  discountCenti: it.discount_centi ?? 0,
  unitCostCenti: it.unit_cost_centi ?? 0,
  variants: (it.variants as Record<string, unknown>) ?? {},
  remark: it.notes ?? '',
});

export const DeliveryReturnDetail = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const askConfirm = useConfirm();
  const notify = useNotify();
  const [searchParams] = useSearchParams();
  const detail = useDeliveryReturnDetail(id ?? null);
  const updateHeader = useUpdateDeliveryReturnHeader();
  const updateStatus = useUpdateDeliveryReturnStatus();
  const addItem = useAddDeliveryReturnItem();
  const updateItem = useUpdateDeliveryReturnItem();
  const deleteItem = useDeleteDeliveryReturnItem();

  const header = (detail.data?.deliveryReturn as DrHeader | undefined) ?? null;
  const items = useMemo(() => (detail.data?.items as DrItem[] | undefined) ?? [], [detail.data]);

  const [editingDrafts, setEditingDrafts] = useState<Record<string, SoLineDraft>>({});
  const [addingDraft, setAddingDraft] = useState<SoLineDraft | null>(null);

  const [isEditing, setIsEditing] = useState(searchParams.get('edit') === '1');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savingOrder, setSavingOrder] = useState(false);
  const customerCardRef = useRef<CustomerCardHandle | null>(null);

  // Lock: terminal-ish states lock the header.
  const lockedStatuses: DrStatus[] = ['REFUNDED', 'CREDIT_NOTED', 'CANCELLED'];

  const enterEdit = () => { setSaveError(null); setIsEditing(true); };
  const cancelEdit = () => {
    customerCardRef.current?.reset();
    setSaveError(null);
    setIsEditing(false);
  };

  /* Edit-mode seed/clear — populate a draft per line; clear on exit. Mirrors
     DeliveryOrderDetail. */
  useEffect(() => {
    if (!isEditing) {
      setEditingDrafts({});
      setAddingDraft(null);
      return;
    }
    setEditingDrafts(() => {
      const next: Record<string, SoLineDraft> = {};
      for (const it of items) next[it.id] = draftFromItem(it);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing, items]);

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
          if (await askConfirm({ title: `Remove ${it.item_code} from this return?`, confirmLabel: 'Remove', danger: true })) {
            deleteItem.mutate(
              { id: it.delivery_return_id, itemId: it.id },
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
      uom: d.uom, qtyReturned: d.qty, unitPriceCenti: d.unitPriceCenti, discountCenti: d.discountCenti,
      unitCostCenti: d.unitCostCenti, variants: d.variants, notes: d.remark,
    });

  const commitAddLine = (d: SoLineDraft) =>
    addItem.mutateAsync({
      id: header!.id,
      itemCode: d.itemCode, itemGroup: d.itemGroup, description: d.description,
      uom: d.uom, qtyReturned: d.qty, unitPriceCenti: d.unitPriceCenti, discountCenti: d.discountCenti,
      unitCostCenti: d.unitCostCenti, variants: d.variants, notes: d.remark,
    });

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
          .then(() => { setSavingOrder(false); setIsEditing(false); })
          .catch((e) => {
            setSavingOrder(false);
            setSaveError(`Lines failed to save: ${e instanceof Error ? e.message : String(e)}`);
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
        <Link to="/scm/delivery-returns" className={styles.backBtn}>
          <ArrowLeft {...ICON} /><span>Back</span>
        </Link>
        <div className={styles.bannerWarn}>
          <strong>Delivery return not found.</strong>
          {detail.error instanceof Error ? ` ${detail.error.message}` : null}
        </div>
      </div>
    );
  }

  const isLocked = lockedStatuses.includes(header.status);
  const isCancelled = header.status === 'CANCELLED';

  const handleCancel = async () => {
    if (!(await askConfirm({ title: `Cancel ${header.return_number}?`, body: 'This sets status = CANCELLED.', confirmLabel: 'Cancel', danger: true }))) return;
    updateStatus.mutate({ id: header.id, status: 'CANCELLED' });
  };
  const handleReopen = async () => {
    if (!(await askConfirm({ title: `Reopen ${header.return_number} back to RECEIVED?`, confirmLabel: 'Reopen' }))) return;
    updateStatus.mutate({ id: header.id, status: 'RECEIVED' });
  };
  const handlePrint = () => {
    import('../../vendor/scm/lib/delivery-return-pdf').then(({ generateDeliveryReturnPdf }) =>
      generateDeliveryReturnPdf(
        {
          return_number: header.return_number,
          status: header.status,
          return_date: header.return_date,
          debtor_code: header.debtor_code,
          debtor_name: header.debtor_name,
          reason: header.reason,
          refund_centi: header.local_total_centi,
          notes: header.notes,
          delivery_order_id: header.delivery_order_id,
          sales_invoice_id: null,
        },
        items.map((it) => ({
          item_code: it.item_code,
          description: it.description,
          qty_returned: it.qty_returned,
          condition: it.condition,
          unit_price_centi: it.unit_price_centi,
          refund_centi: it.line_total_centi,
        })),
      ),
    ).catch((e) => notify({ title: 'PDF generation failed', body: e instanceof Error ? e.message : String(e), tone: 'error' }));
  };

  return (
    <div className={styles.page} style={isCancelled ? { filter: 'grayscale(0.7)' } : undefined}>
      {/* ── Header ── */}
      <div className={styles.headerRow}>
        <div className={styles.titleBlock}>
          <Link to="/scm/delivery-returns" className={styles.backBtn}>
            <ArrowLeft {...ICON} /><span>Back</span>
          </Link>
          <div>
            <h1 className={styles.title}>
              <Undo2 size={16} strokeWidth={1.75} style={TITLE_ICON_STYLE} />
              {header.return_number} — {header.debtor_name}
            </h1>
            <p className={styles.subtitle}>
              Return date {fmtDateOrDash(header.return_date)} · {header.line_count} {header.line_count === 1 ? 'line' : 'lines'}
              {header.do_doc_no && ` · Transfer From ${header.do_doc_no}`}
            </p>
          </div>
        </div>
        <div className={styles.actions}>
          <div className={styles.totalRail}>
            <span className={styles.totalRailLabel}>Returned</span>
            <span className={styles.totalRailValue}>{fmtRm(header.local_total_centi, header.currency)}</span>
          </div>
          <StatusPill docType="dr" status={header.status} />
          <RelationshipMapButton type="dr" id={id} />
          <Button variant="ghost" size="md" onClick={handlePrint}>
            <Printer {...ICON} /><span>Print PDF</span>
          </Button>
          {isEditing && (
            <Button variant="ghost" size="md" onClick={() => navigate('/scm/delivery-returns/from-do')}>
              <ArrowRightLeft {...ICON} /><span>From Delivery Order</span>
            </Button>
          )}
          {isCancelled ? (
            <Button variant="primary" size="md" onClick={handleReopen} disabled={updateStatus.isPending}>
              <RotateCcw {...ICON} /><span>Reopen Return</span>
            </Button>
          ) : !isEditing ? (
            <Button variant="ghost" size="md" onClick={handleCancel} disabled={updateStatus.isPending}
              style={{ color: 'var(--c-festive-b, #B8331F)' }}>
              <Ban {...ICON} /><span>Cancel Return</span>
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

      {/* A return is RECEIVED the moment it's created (stock is increased on
          create), so there's no manual stage strip. Cancel + Reopen remain
          available from the header. */}

      {/* ── Customer / Return Info / Emergency / Address cards ── */}
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
          <h2 className={styles.cardTitle}>Returned Items ({items.length})</h2>
          {isEditing && !addingDraft && (
            <Button variant="primary" size="sm" onClick={startAddLine} disabled={isLocked}>
              <Plus {...ICON} /><span>Add Line Item</span>
            </Button>
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
                No items yet — click "Add Line Item" above to begin.
              </p>
            )}
          </div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Item</th>
                <th>Sales Location</th>
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
                    <div className={styles.codeCell}>{it.item_code}</div>
                    {it.description && <div className={styles.muted}>{it.description}</div>}
                    {(() => {
                      const summary = buildVariantSummary(it.item_group, it.variants);
                      return summary ? <div className={styles.muted}>{summary}</div> : null;
                    })()}
                    {it.condition && <div className={styles.muted}>Condition: {it.condition}</div>}
                  </td>
                  <td><span className={styles.muted}>{it.warehouse_code ?? '—'}</span></td>
                  <td className={styles.tableRight}>{it.qty_returned}</td>
                  <td className={styles.tableRight}>{fmtRm(it.unit_price_centi, header.currency)}</td>
                  <td className={styles.tableRight}>{it.discount_centi > 0 ? fmtRm(it.discount_centi, header.currency) : '—'}</td>
                  <td className={styles.priceCell}>{fmtRm(it.line_total_centi, header.currency)}</td>
                  <td className={styles.tableRight}>
                    <span className={styles.muted}>{it.unit_cost_centi > 0 ? fmtRm(it.unit_cost_centi, header.currency) : '—'}</span>
                  </td>
                  <td className={styles.tableRight}>
                    <span className={styles.muted}>{it.line_cost_centi > 0 ? fmtRm(it.line_cost_centi, header.currency) : '—'}</span>
                  </td>
                  <td className={styles.tableRight}>
                    {it.line_total_centi > 0 ? (
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

      <TotalsCard header={header} />
    </div>
  );
};

/* ════════════════════════════════════════════════════════════════════════
   Customer / Return Info / Emergency / Delivery Address — editable cards.
   Mirrors DeliveryOrderDetail's CustomerCard (adapted to DR fields).
   ════════════════════════════════════════════════════════════════════════ */

type CustomerCardHandle = {
  save: (cb: { onSuccess: () => void; onError: (msg: string) => void }) => void;
  reset: () => void;
};

type CustomerCardProps = {
  header: DrHeader;
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

  const initialFormFor = (h: DrHeader) => ({
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
    returnDate: h.return_date ?? '',
    reason: h.reason ?? '',
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
    returnDate: form.returnDate || null,
    reason: form.reason,
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

      {/* ── RETURN INFO (date / reason / note) ── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}><h2 className={styles.cardTitle}>Return Info</h2></header>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Return Date</span>
              <input type="date" className={styles.fieldInput} value={form.returnDate}
                disabled={inputsDisabled} onChange={(e) => set('returnDate', e.target.value)} />
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
              <span className={styles.fieldLabel}>Reason</span>
              <input className={styles.fieldInput} value={form.reason}
                placeholder="Why is this being returned?" disabled={inputsDisabled}
                onChange={(e) => set('reason', e.target.value)} />
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
            Used only if we cannot reach the customer on collection day
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
   Totals card (mirror of DeliveryOrderDetail's TotalsCard)
   ════════════════════════════════════════════════════════════════════════ */
const TotalsCard = ({ header }: { header: DrHeader }) => {
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
            <div className={styles.totalLabel}>Returned Value</div>
            <div className={styles.grandTotal} style={TOTALS_KPI_VALUE_STYLE}>{fmtRm(header.local_total_centi, header.currency)}</div>
          </div>
          <div>
            <div className={styles.totalLabel}>Cost</div>
            <div className={styles.totalValue} style={TOTALS_KPI_VALUE_STYLE}>{fmtRm(header.total_cost_centi, header.currency)}</div>
          </div>
          <div>
            <div className={styles.totalLabel}>Margin</div>
            <div className={`${styles.totalValue} ${marginCls}`} style={TOTALS_KPI_VALUE_STYLE}>{fmtRm(header.total_margin_centi, header.currency)}</div>
          </div>
          <div>
            <div className={styles.totalLabel}>Margin %</div>
            <div className={`${styles.totalValue} ${marginCls}`} style={TOTALS_KPI_VALUE_STYLE}>
              {header.local_total_centi > 0 ? `${marginPct.toFixed(1)}%` : '—'}
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
                <div className={styles.totalValue}>Value {fmtRm(rev, header.currency)}</div>
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
