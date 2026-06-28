// ----------------------------------------------------------------------------
// SalesOrderDetail — full-page route at /mfg-sales-orders/:docNo.
//
// HOUZS-pattern B2B sales order:
//   1. Header: back button + doc no · debtor + status pill + actions (Print PDF)
//   2. Customer info card: editable debtor_code/name/phone/agent/branding/
//      venue/4 addresses with autocomplete from prior SOs
//   3. Line items table: Item code + group + description + variants summary +
//      qty + unit price + discount + total + Edit/Delete. "+ Add Line Item"
//      opens a modal with a product picker + variant editor (sofa: size +
//      fabric color + leg height; bedframe: divan + gap + leg + specials).
//   4. Totals card: per-category subtotal + grand total + margin
//   5. Status transition strip: Draft → Confirmed → Shipped → Delivered → Invoiced → Closed.
//
// Wires to: GET /mfg-sales-orders/:docNo, PATCH header, POST/PATCH/DELETE items,
// PATCH /:docNo/status, GET /debtors/search.
// ----------------------------------------------------------------------------

import {
  forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState,
  type CSSProperties,
} from 'react';
import { createPortal } from 'react-dom';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowLeft, FileText, Pencil, Plus, X, Printer, Save,
  DollarSign, Lock, History, ChevronDown, ChevronRight, Ban,
} from 'lucide-react';
import { Button } from '@2990s/design-system';
import { formatPhone } from '@2990s/shared/phone';
import { buildVariantSummary, canonicalizeVariants, fmtCenti, fmtDate, fmtDateOrDash, fmtDateTime, missingVariantAxes } from '@2990s/shared'; // Commander 2026-05-28
import { PhoneInput } from '../../vendor/scm/components/PhoneInput';
import { SkeletonDetailPage } from '../../vendor/scm/components/Skeleton';
import {
  useMfgSalesOrderDetail,
  useUpdateMfgSalesOrderHeader,
  useUpdateMfgSalesOrderStatus,
  useAddMfgSalesOrderItem,
  useUpdateMfgSalesOrderItem,
  useDeleteMfgSalesOrderItem,
  useDebtorSearch,
  useOverrideMfgSoLinePrice,
  useSalesOrderAuditLog,
  useSalesOrderPayments,
  useUploadSoItemPhoto,
  type DebtorSuggestion,
  type SoAuditEntry,
  type SoAuditFieldChange,
} from '../../vendor/scm/lib/sales-order-queries';
import { SoLineCard, emptySoLine, missingRequiredVariants, type SoLineDraft } from '../../vendor/scm/components/SoLineCard';
import { PaymentsTable } from '../../vendor/scm/components/PaymentsTable';
import { RelationshipMapButton } from '../../vendor/scm/components/RelationshipMapButton';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { usePrompt } from '../../vendor/scm/components/PromptDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { fetchSoSlipUrl, fetchScanSlipImageBlobUrl } from '../../vendor/scm/lib/slip';
import {
  useLocalities,
  distinctStates,
  citiesInState,
  postcodesInCity,
  countryForState,
} from '../../vendor/scm/lib/localities-queries';
import {
  useSoDropdownOptions, optionsOrFallback,
} from '../../vendor/scm/lib/so-dropdown-options-queries';
import { useStaff } from '../../vendor/scm/lib/admin-queries';
import { sortByText, sortByNumeric } from '../../vendor/scm/lib/sort-options';
import { soStatusDisplay, type DeliveryState, type SoLifecycle } from '../../vendor/scm/lib/so-status';
import { useAuth } from '../../vendor/scm/lib/auth';
import { useVenues } from '../../vendor/scm/lib/venues-queries';
import { useStateWarehouseMappings } from '../../vendor/scm/lib/state-warehouse-queries';
import { useDebouncedValue } from '../../vendor/scm/lib/hooks';
import { generateSalesOrderPdf } from '../../vendor/scm/lib/sales-order-pdf';
import styles from './SalesOrderDetail.module.css';

const ICON = { size: 16, strokeWidth: 1.75 } as const;
const SM_ICON = { size: 14, strokeWidth: 1.75 } as const;

/* ──────────────────────────────────────────────────────────────────────────
   Module-level style constants (micro-perf: hoisted out of render so React
   keeps stable referential identity on host elements between renders).
   ────────────────────────────────────────────────────────────────────────── */
const TITLE_ICON_STYLE: CSSProperties = { color: 'var(--c-burnt)' };
/* PR — commander 2026-05-27 followup #2. Total was previously inline in
   the <h1> title; relocated into a right-rail meta block (.totalRail) sit-
   ting beside the action group so the title stays compact. Style now lives
   in SalesOrderDetail.module.css → .totalRailLabel / .totalRailValue. */
const LOCK_BANNER_INNER_STYLE: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 8,
};
const VARIANT_WARN_BANNER_STYLE: CSSProperties = {
  background: 'rgba(184, 51, 31, 0.08)',
  border: '1px solid var(--c-festive-b, #B8331F)',
  color: 'var(--c-festive-b, #B8331F)',
  padding: 'var(--space-3) var(--space-4)',
  borderRadius: 'var(--radius-md)',
  fontSize: 'var(--fs-13)',
};
const VARIANT_WARN_LIST_STYLE: CSSProperties = { marginTop: 4, fontSize: 'var(--fs-12)' };
const DATES_XOR_WARN_STYLE: CSSProperties = {
  background: 'rgba(184, 51, 31, 0.08)',
  border: '1px solid var(--c-festive-b, #B8331F)',
  color: 'var(--c-festive-b, #B8331F)',
  padding: '4px var(--space-2)',
  borderRadius: 'var(--radius-sm)',
  fontSize: 'var(--fs-11)',
  fontWeight: 600,
  marginTop: 'var(--space-2)',
};
const EMERGENCY_HEADER_NOTE_STYLE: CSSProperties = {
  fontSize: 'var(--fs-12)', color: 'var(--fg-muted)',
};
/* Houzs 2026-06-24 — the totals KPI grid moved from this inline const to the
   .totalsKpiGrid CSS-module class so the phone breakpoint can collapse it to
   2×2 (inline styles can't carry a media query). See SalesOrderDetail.module.css. */
/* PR — Step KPI tile values from fs-18 → fs-15 so the totals card no longer
   reads as another hero. Margin / Margin % share this override. */
const TOTALS_KPI_VALUE_STYLE: CSSProperties = { fontSize: 'var(--fs-15, 15px)' };
const HISTORY_NOTE_STYLE: CSSProperties = { fontStyle: 'italic' };

/* 2026-06-04 — the required-variant rule lives in @2990s/shared
   `so-variant-rule` (one source for the server 409 gate + every Backend
   surface). Alias-aware: a POS-created sofa line satisfies the Seat / Leg
   axes via depth / sofaLegHeight — the old hand-copied key list here flagged
   those lines as incomplete. */
const formatGroupRequirements = (g: string): string =>
  g === 'bedframe' ? 'Divan · Leg · Gap · Fabric' :
  g === 'sofa'     ? 'Seat · Leg · Fabric' : '';

// PR-DRAFT-removal — DRAFT dropped from mfg_so_status (migration 0078).
// SOs are CONFIRMED on create (PR #154); no DRAFT staging step.
const STATUS_LIST = [
  'CONFIRMED', 'IN_PRODUCTION', 'READY_TO_SHIP',
  'SHIPPED', 'DELIVERED', 'INVOICED', 'CLOSED', 'CANCELLED',
] as const;
type SoStatus = typeof STATUS_LIST[number];

const STATUS_CLASS: Record<string, string> = {
  // DRAFT flow — re-added so a DRAFT SO (scanned / auto-generated, pending
  // operator Confirm) renders the muted grey pill instead of a bare string.
  DRAFT:          styles.statusDraft ?? '',
  CONFIRMED:      styles.statusConfirmed ?? '',
  IN_PRODUCTION:  styles.statusInProd ?? '',
  READY_TO_SHIP:  styles.statusReady ?? '',
  SHIPPED:        styles.statusShipped ?? '',
  DELIVERED:      styles.statusDelivered ?? '',
  INVOICED:       styles.statusInvoiced ?? '',
  CLOSED:         styles.statusClosed ?? '',
  CANCELLED:      styles.statusCancelled ?? '',
  RETURNED:       styles.statusReturned ?? '',
};

// Owner-preferred status wording — kept identical to the SO list pill
// (MfgSalesOrdersList SO_STATUS_LABEL) so the badge reads the same on the list
// and here (lifecycle states like Delivered/Invoiced/Delivery Return still come
// from soStatusDisplay; this is only the stored-status fallback).
const SO_STATUS_LABEL: Record<string, string> = {
  DRAFT:         'Draft',
  CONFIRMED:     'Confirmed',
  IN_PRODUCTION: 'Proceed',
  READY_TO_SHIP: 'Stock Ready',
  SHIPPED:       'Arranged',
  DELIVERED:     'Delivered',
  INVOICED:      'Invoiced',
  CLOSED:        'Closed',
  ON_HOLD:       'On Hold',
  CANCELLED:     'Cancelled',
};

const fmtRm = (centi: number, currency = 'MYR'): string =>
  `${currency} ${(centi / 100).toLocaleString('en-MY', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;

/* Task #99 (UI perf) — Local debounce hook lifted to ../lib/hooks.ts as
   useDebouncedValue so SoLineCard's product picker (Task #102) can reuse
   it without duplicating the implementation. */

type SoHeader = {
  doc_no: string;
  so_date: string;
  status: SoStatus;
  debtor_code: string | null;
  debtor_name: string;
  agent: string | null;
  sales_location: string | null;
  ref: string | null;
  po_doc_no: string | null;
  venue: string | null;
  /* Migration 0086 — venue master FK. Auto-stamped from staff.venue_id on
     POST/PATCH when the row's salesperson belongs to a venue. */
  venue_id: string | null;
  branding: string | null;
  transfer_to: string | null;
  address1: string | null;
  address2: string | null;
  address3: string | null;
  address4: string | null;
  phone: string | null;
  mattress_sofa_centi: number;
  bedframe_centi: number;
  accessories_centi: number;
  others_centi: number;
  /* Task #114 — per-category cost rollup (migration 0079). Used by the
     Totals card category breakdown so each row can show Revenue / Cost /
     Margin without summing items. May be undefined on rows older than
     0079 — fall back to 0 in the consumer. */
  mattress_sofa_cost_centi?: number;
  bedframe_cost_centi?:      number;
  accessories_cost_centi?:   number;
  others_cost_centi?:        number;
  local_total_centi: number;
  total_cost_centi: number;
  total_margin_centi: number;
  margin_pct_basis: number;
  line_count: number;
  currency: string;
  note: string | null;
  // ── PR #35 additions ────────────────────────────────────────────────
  customer_id: string | null;
  customer_state: string | null;
  /* Task #121 — country snapshot auto-derived from customer_state via
     my_localities on POST/PATCH (migration 0082). Nullable for SOs whose
     state isn't in the locality dataset yet. */
  customer_country: string | null;
  customer_po: string | null;
  customer_po_id: string | null;
  customer_po_date: string | null;
  customer_po_image_b64: string | null;
  /* PR #163 — customer's own SO number (their ERP reference). Already in
     schema since PR #121 but the Detail page never exposed it. Commander
     2026-05-27: "还需要顾客salesorder的reference在order details". */
  customer_so_no: string | null;
  hub_id: string | null;
  hub_name: string | null;
  customer_delivery_date: string | null;
  internal_expected_dd: string | null;
  /* POS "Proceed" timestamp (migration 0110). Auto-stamped server-side when the
     SO first enters IN_PRODUCTION (the POS "Proceed" action). Read-only here —
     surfaced as "Proceed Date" in the Order Info card so the coordinator can
     see WHEN the salesperson proceeded the order. */
  proceeded_at: string | null;
  linked_do_doc_no: string | null;
  ship_to_address: string | null;
  bill_to_address: string | null;
  install_to_address: string | null;
  subtotal_sen: number | null;
  overdue: string | null;
  /* PR #46 — POS handover */
  email: string | null;
  customer_type: string | null;
  salesperson_id: string | null;
  city: string | null;
  postcode: string | null;
  building_type: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  emergency_contact_relationship: string | null;
  target_date: string | null;
  /* P1 (migration 0142) — POS handover customer signature (data URL). Read-only
     here; rendered as an image so the coordinator can see the signed proof. */
  signature_b64: string | null;
  /* P1 (migration 0143) — POS handover payment slip. slip_key = R2 object key
     (display via the /slip-url presign route); slip_state = review state. */
  slip_key: string | null;
  slip_state: 'none' | 'pending' | 'verified' | 'flagged' | null;
  /* Migration 0033 — original handwritten slip image (R2 key under
     `scan-slips/...`) when this SO was created via the Scan Order flow. Served
     back (authed) via GET /scan-so/slip-image?key=... and shown as proof. */
  slip_image_key: string | null;
  /* Migration 0034 — scanned card-terminal payment receipt image (R2 key under
     `scan-slips/...-receipt`) when the Scan Order flow carried a receipt photo
     alongside the order slip. Served back via the same authed endpoint. */
  receipt_image_key: string | null;
  /* PR #143 + #150 — Payment. Installment is a sub-type of merchant
     (not its own top-level method). approval_code captured for the
     terminal auth slip. */
  payment_method: string | null;        // cash | transfer | merchant
  installment_months: number | null;    // 6 | 12 — NULL = normal swipe; valid only when method=merchant
  merchant_provider: string | null;     // GHL | HLB | MBB | PBB
  approval_code: string | null;
  payment_date: string | null;          // PR #157 — date funds received
  deposit_centi: number;
  paid_centi: number;
};

type SoItem = {
  id: string;
  doc_no: string;
  item_group: string;
  item_code: string;
  description: string | null;
  description2: string | null;
  uom: string;
  qty: number;
  unit_price_centi: number;
  discount_centi: number;
  total_centi: number;
  unit_cost_centi: number;
  line_cost_centi: number;
  line_margin_centi: number;
  variants: Record<string, unknown> | null;
  remark: string | null;
  cancelled: boolean;
  /* PR-E — Per-item delivery date with cascade override flag.
     line_delivery_date null + overridden=false → display falls back to
     header.customer_delivery_date. Once the user types in the SoLineCard
     date input, overridden=true and the line keeps its own value even
     when the header date changes. */
  line_delivery_date: string | null;
  line_delivery_date_overridden: boolean;
  /* Delivery breakdown stamped by the SO detail endpoint — which DO took how
     much off this line, plus the live balance still deliverable. */
  deliveries?: { doNumber: string; qty: number; status: string }[];
  delivered_qty?: number;
  remaining_qty?: number;
  /* Incoming-stock coverage — the PO this line's goods were raised into +
     earliest ETA, shown when the line hasn't shipped yet. null when no PO. */
  coverage_po?: string | null;
  coverage_eta?: string | null;
};

/* Whole-order inline edit — build a SoLineDraft from a persisted SoItem.
   Hoisted to module scope so the edit-mode seed effect can map every line
   without re-allocating the function each render. Mirrors the snake_case →
   camelCase field mapping the per-row editor used before. */
const draftFromItem = (it: SoItem): SoLineDraft => ({
  itemCode:       it.item_code ?? '',
  itemGroup:      it.item_group ?? 'others',
  description:    it.description ?? '',
  uom:            it.uom ?? 'UNIT',
  qty:            it.qty ?? 1,
  unitPriceCenti: it.unit_price_centi ?? 0,
  discountCenti:  it.discount_centi ?? 0,
  unitCostCenti:  it.unit_cost_centi ?? 0,
  // 2026-06-08 (Loo) — canonicalise POS-vocabulary sofa keys (depth →
  // seatHeight, sofaLegHeight → legHeight) so the Edit modal's Seat/Leg
  // dropdowns prefill a POS-created line instead of re-asking. fabricCode
  // already shares one key; the 409 gate + variant summary were alias-aware,
  // only this editor seam wasn't.
  variants:       canonicalizeVariants(it.item_group, it.variants as Record<string, unknown> | null),
  remark:         it.remark ?? '',
  lineDeliveryDate:           it.line_delivery_date ?? null,
  lineDeliveryDateOverridden: it.line_delivery_date_overridden ?? false,
});

export const SalesOrderDetail = () => {
  const { docNo } = useParams<{ docNo: string }>();
  const detail = useMfgSalesOrderDetail(docNo ?? null);
  const updateHeader = useUpdateMfgSalesOrderHeader();
  const updateStatus = useUpdateMfgSalesOrderStatus();
  const askConfirm = useConfirm();
  const askPrompt = usePrompt();
  const notify = useNotify();
  const addItem = useAddMfgSalesOrderItem();
  const updateItem = useUpdateMfgSalesOrderItem();
  const deleteItem = useDeleteMfgSalesOrderItem();
  const uploadPhoto = useUploadSoItemPhoto();

  const header = (detail.data?.salesOrder as SoHeader | undefined) ?? null;
  const items = useMemo(() => (detail.data?.items as SoItem[] | undefined) ?? [], [detail.data]);

  /* Fix 2 (micro-perf) — Variant-completeness check memoized; derives only
     when items or the processing-date toggle changes. 2026-06-04: delegates
     to the shared so-variant-rule (alias-aware, matches the server 409). */
  const requireVariants = !!header?.internal_expected_dd;
  const incompleteVariantLines = useMemo(() => {
    if (!requireVariants) return [];
    return items
      .filter((it) => missingVariantAxes(it.item_group, it.variants as Record<string, unknown> | null).length > 0)
      .map((it) => ({ code: it.item_code, group: (it.item_group ?? '').toLowerCase() }));
  }, [items, requireVariants]);

  /* Followup #81 — Print PDF reads payments from the ledger now. PaymentCard
     also calls this hook (with the same docNo), so TanStack Query dedupes
     and shares the cache entry — no double fetch. */
  const printPaymentsQ = useSalesOrderPayments(docNo ?? null);

  /* Whole-order inline edit (commander 2026-05-28) — There is no longer a
     per-row "pencil" that toggles a single line into edit mode. Instead,
     when the page enters edit mode EVERY line is seeded into editingDrafts
     and rendered as an inline SoLineCard simultaneously. The whole order
     (header + every line draft + an optional pending add-draft) is then
     committed by the ONE page-level Save in the header. editingDrafts is
     keyed by item id; the seed/clear effect below mirrors isEditing.
     The "+ Add Line Item" button still seeds addingDraft with emptySoLine()
     + the SO header's customer_delivery_date so a brand-new line renders an
     inline SoLineCard at the bottom of the table (same component, same
     behavior as the New SO page — there is no modal flow at all). */
  const [editingDrafts, setEditingDrafts] = useState<Record<string, SoLineDraft>>({});
  const [addingDraft, setAddingDraft] = useState<SoLineDraft | null>(null);
  const [overriding, setOverriding] = useState<SoItem | null>(null);
  const [unlockOverride, setUnlockOverride] = useState(false);
  // PR-D — History panel toggle. Commander asked for the HOOKKA-style
  // floating right-side history drawer.
  const [historyOpen, setHistoryOpen] = useState(false);

  /* PR-A — Page-level Edit/Save framework. Default is read-only: all inputs
     are disabled, the "+ Add Line Item" button + per-line trash icons are
     hidden, and CustomerCard's own Save button is suppressed. Click Edit in
     the page header → entire page enters edit mode (CustomerCard inputs
     unlock, line-item actions appear, Edit button is replaced with Save +
     Cancel). Save commits via updateHeader; Cancel resets the local form.
     Status transitions remain accessible outside edit mode. */
  const [isEditing, setIsEditing] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const customerCardRef = useRef<CustomerCardHandle | null>(null);

  const enterEdit  = () => { setSaveError(null); setIsEditing(true); };
  const cancelEdit = () => {
    customerCardRef.current?.reset();
    setSaveError(null);
    // The seed/clear effect wipes editingDrafts + addingDraft when isEditing
    // flips to false, discarding any uncommitted line edits.
    setIsEditing(false);
  };

  /* Whole-order Save — persists the order in one shot:
       1. validate the header (CustomerCard's own Save runs its date-XOR gate)
       2. commit every dirty line draft via updateItem (parallel)
       3. commit the pending add-draft via addItem (+ drain staged photos)
     The header save is sequenced first so its validation can short-circuit
     before any line writes go out. We only leave edit mode after ALL writes
     resolve; any failure surfaces inline and keeps the user in edit mode so
     nothing is silently lost. */
  const [savingOrder, setSavingOrder] = useState(false);
  const saveEdit = () => {
    const handle = customerCardRef.current;
    if (!handle || !header) return;
    if (savingOrder) return;
    setSaveError(null);

    /* Owner 2026-06-03 — phone is COMPULSORY on every SO. Mirror the New SO
       guard so Edit can't blank it out (the backend PATCH now rejects an
       empty phone too; this keeps the operator from a confusing 400). */
    if (!handle.getPhone().trim()) {
      notify({
        title: 'Phone number is required',
        body: 'every sales order must have a contact number.',
        tone: 'error',
      });
      return;
    }

    // Guard: an open add-draft must have a product picked before Save.
    if (addingDraft && !addingDraft.itemCode.trim()) {
      setSaveError('Pick a product for the new line, or remove it before saving.');
      return;
    }
    // Guard: every existing line must still reference a product.
    const blankLine = Object.values(editingDrafts).find((d) => !d.itemCode.trim());
    if (blankLine) {
      setSaveError('Every line must have a product selected before saving.');
      return;
    }
    // Variants are only mandatory once a processing date is set: with a date
    // the order is committed to production and purchasing needs the full spec.
    // No processing date = still a draft, so allow saving with gaps.
    if (header?.internal_expected_dd) {
      const variantGaps = [
        ...Object.values(editingDrafts),
        ...(addingDraft ? [addingDraft] : []),
      ]
        .filter((d) => d.itemCode.trim())
        .map((d) => ({ code: d.itemCode, miss: missingRequiredVariants(d.itemGroup, d.variants) }))
        .filter((x) => x.miss.length > 0);
      if (variantGaps.length > 0) {
        setSaveError(
          'Complete all variant selections before saving — '
          + variantGaps.map((x) => `${x.code}: ${x.miss.join(', ')}`).join('; ') + '.',
        );
        return;
      }
    }

    // Validate the header (date XOR + no-past-date) BEFORE writing anything,
    // so an invalid date can't leave lines half-committed.
    const headerErr = handle.validate();
    if (headerErr) {
      setSaveError(headerErr);
      return;
    }

    setSavingOrder(true);
    // Snapshot drafts up front so concurrent re-seeds don't shift the set.
    const lineEntries = Object.entries(editingDrafts);
    const pendingAdd = addingDraft;

    /* Order matters: commit the line variants FIRST, then the header. The
       backend's "Processing Date requires complete variants" guard reads the
       LIVE line variants from the DB — if the header (with the processing
       date) is saved before the line edits land, that guard sees the stale
       empty variants and rejects with 409, even though the operator just
       filled them in. Lines-then-header keeps the DB consistent at the moment
       the guard runs. */
    Promise.all(lineEntries.map(([id, d]) => commitEditingDraft(id, d)))
      .then(() => (pendingAdd ? commitAddLine(pendingAdd) : Promise.resolve()))
      .then(() => new Promise<void>((resolve, rejectSave) => {
        handle.save({
          onSuccess: () => resolve(),
          onError: (msg) => rejectSave(new Error(msg)),
        });
      }))
      .then(() => {
        setSavingOrder(false);
        setIsEditing(false);
      })
      .catch((e) => {
        setSavingOrder(false);
        setSaveError(e instanceof Error ? e.message : String(e));
      });
  };

  /* Task #99 (UI perf) — Stable callbacks for the memo'd child cards. Without
     these, every parent render produces a new `onSave`/`onClose`, defeating
     React.memo on PaymentCard / CustomerCard / HistoryPanel. The mutations
     they call are stable across renders (TanStack Query returns the same
     mutate fn) so the only moving piece is `docNo` from URL params, which
     never changes inside one mounted page. */
  const stableDocNo = docNo ?? '';
  const handleHeaderSave = useCallback(
    (patch: Record<string, unknown>, cb?: { onSuccess?: () => void; onError?: (msg: string) => void }) => {
      /* verified-save (Wei Siang 2026-06-08): confirm the customer-identity
         fields actually persisted, so a stale-cache overwrite can't silently
         discard the edit (BUG-2026-06-07-002 #5). Only verbatim-stored, readback-
         present fields are checked (phone is E.164-normalised on store, so it's
         excluded to avoid a false "didn't stick"). */
      const VERIFY: Record<string, string> = {
        debtorName: 'debtor_name', debtorCode: 'debtor_code', agent: 'agent', ref: 'ref',
      };
      const __verify: Record<string, unknown> = {};
      for (const [k, col] of Object.entries(VERIFY)) if (k in patch) __verify[col] = patch[k];
      updateHeader.mutate(
        { docNo: stableDocNo, ...patch, ...(Object.keys(__verify).length ? { __verify } : {}) },
        {
          onSuccess: () => cb?.onSuccess?.(),
          onError:   (e) => cb?.onError?.(e instanceof Error ? e.message : String(e)),
        },
      );
    },
    [stableDocNo, updateHeader],
  );
  const handlePaymentSave = useCallback(
    (patch: Record<string, unknown>) => {
      updateHeader.mutate({ docNo: stableDocNo, ...patch });
    },
    [stableDocNo, updateHeader],
  );
  const closeHistory = useCallback(() => setHistoryOpen(false), []);

  /* Whole-order inline edit — line-item helpers.

     There is no longer a per-row "start editing this line" action: every
     persisted line is seeded into editingDrafts the moment the page enters
     edit mode (see the seed/clear effect below) and stays editable until the
     user clicks the page-level Save or Cancel. Drafts are keyed by item id.

     patchEditingDraft mutates one row's draft in place. It's stable
     (useCallback, no deps) because it's closed over by the per-row callbacks
     the memoized SoLineCard receives — a fresh arrow each render would bust
     SoLineCard's React.memo and re-render the heaviest tree on the page. */
  const patchEditingDraft = useCallback((id: string, patch: Partial<SoLineDraft>) => {
    setEditingDrafts((prev) => {
      const cur = prev[id];
      if (!cur) return prev;
      return { ...prev, [id]: { ...cur, ...patch } };
    });
  }, []);

  /* Fix A — Live header→line Delivery Date cascade. The backend already
     re-cascades non-overridden lines on Save, but inside the edit view the
     line rows didn't "jump" until that Save round-trip. This pushes the new
     header date into every line draft that hasn't been manually overridden
     the moment the user changes the header Delivery Date input — matching the
     New SO behaviour. Overridden lines keep their own value untouched. The
     pending add-draft (if any) also follows when it hasn't been overridden. */
  const cascadeDeliveryDateToLines = useCallback((date: string) => {
    const next = date || null;
    setEditingDrafts((prev) => {
      let changed = false;
      const out: Record<string, SoLineDraft> = {};
      for (const [id, d] of Object.entries(prev)) {
        if (!d.lineDeliveryDateOverridden && d.lineDeliveryDate !== next) {
          out[id] = { ...d, lineDeliveryDate: next };
          changed = true;
        } else {
          out[id] = d;
        }
      }
      return changed ? out : prev;
    });
    setAddingDraft((prev) =>
      prev && !prev.lineDeliveryDateOverridden && prev.lineDeliveryDate !== next
        ? { ...prev, lineDeliveryDate: next }
        : prev,
    );
  }, []);

  /* Per-row delete. On a persisted line this fires the delete mutation
     immediately (and drops the row's draft on success) — deletes are not
     deferred to the page-level Save because there's no "undo a removed line"
     affordance and batching a destructive op behind Save is surprising. The
     remaining line edits are still committed together by Save. */
  const removeEditingLine = useCallback((id: string) => {
    setEditingDrafts((prev) => {
      if (!(id in prev)) return prev;
      const { [id]: _drop, ...rest } = prev;
      return rest;
    });
  }, []);

  /* Edit-mode seed/clear effect — whole-order inline edit. Entering edit
     mode populates a draft for EVERY current line so they all render as
     inline SoLineCard editors at once; leaving edit mode wipes the drafts
     (and any half-typed add-draft). Re-seeds whenever the underlying items
     change (e.g. after a delete or a successful Save re-fetch) so the
     inline editors stay in sync with the server snapshot. Lines the user
     is mid-deleting via removeEditingLine are intentionally dropped from
     the draft map and won't be re-seeded until the next items change. */
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

  /* Per-row callback map. SoLineCard is React.memo'd, so each row needs a
     stable onChange / onRemove pair. The Map is keyed on the line id and its
     identity changes only when the set of lines changes — exactly when a
     row's callbacks must rebind. patchEditingDraft + removeEditingLine are
     stable via useCallback above, so the bound arrows here are the only
     churn. */
  const rowCallbacks = useMemo(() => {
    const map = new Map<string, {
      onChange: (patch: Partial<SoLineDraft>) => void;
      onRemove: () => void;
    }>();
    for (const it of items) {
      map.set(it.id, {
        onChange: (patch) => patchEditingDraft(it.id, patch),
        onRemove: async () => {
          if (await askConfirm({
            title: `Remove ${it.item_code} from this SO?`,
            confirmLabel: 'Remove',
            danger: true,
          })) {
            deleteItem.mutate(
              { docNo: it.doc_no, itemId: it.id },
              { onSuccess: () => removeEditingLine(it.id) },
            );
          }
        },
      });
    }
    return map;
  }, [items, patchEditingDraft, removeEditingLine, deleteItem, askConfirm]);

  /* Add path — single inline SoLineCard appended below the table when
     "+ Add Line Item" is clicked. The draft is committed together with the
     header + line edits by the page-level Save (see saveEdit). */
  const startAddLine = () => {
    if (!header) return;
    setAddingDraft({
      ...emptySoLine(),
      // Seed the line delivery date from the SO header so the SoLineCard
      // displays a default — same pattern SalesOrderNew uses.
      lineDeliveryDate: header.customer_delivery_date ?? null,
      lineDeliveryDateOverridden: false,
    });
  };

  const cancelAddLine = useCallback(() => setAddingDraft(null), []);

  /* Stable onChange for the lone "+ Add Line Item" SoLineCard at the bottom
     of the table. Kept standalone (not in rowCallbacks) because there is at
     most one add-draft at a time. */
  const patchAddingDraft = useCallback(
    (patch: Partial<SoLineDraft>) =>
      setAddingDraft((prev) => prev ? { ...prev, ...patch } : prev),
    [],
  );

  /* Commit one persisted line via updateItem. Used by the page-level Save to
     fan every dirty line draft out in parallel. Returns the mutation promise
     so saveEdit can Promise.all them. */
  const commitEditingDraft = (id: string, d: SoLineDraft) =>
    updateItem.mutateAsync({
      docNo: header!.doc_no,
      itemId: id,
      itemCode:       d.itemCode,
      itemGroup:      d.itemGroup,
      description:    d.description,
      uom:            d.uom,
      qty:            d.qty,
      unitPriceCenti: d.unitPriceCenti,
      discountCenti:  d.discountCenti,
      unitCostCenti:  d.unitCostCenti,
      variants:       d.variants,
      remark:         d.remark,
      lineDeliveryDate:           d.lineDeliveryDate ?? null,
      lineDeliveryDateOverridden: d.lineDeliveryDateOverridden ?? false,
    });

  /* Commit the pending add-draft via addItem, then drain any staged photo
     Files against the freshly-minted itemId. Returns a promise so it can be
     awaited as part of the page-level Save. */
  const commitAddLine = async (d: SoLineDraft) => {
    const pendingFiles = d.pendingPhotoFiles ?? [];
    const res = await addItem.mutateAsync({
      docNo: header!.doc_no,
      itemCode:       d.itemCode,
      itemGroup:      d.itemGroup,
      description:    d.description,
      uom:            d.uom,
      qty:            d.qty,
      unitPriceCenti: d.unitPriceCenti,
      discountCenti:  d.discountCenti,
      unitCostCenti:  d.unitCostCenti,
      variants:       d.variants,
      remark:         d.remark,
      lineDeliveryDate:           d.lineDeliveryDate ?? null,
      lineDeliveryDateOverridden: d.lineDeliveryDateOverridden ?? false,
    });
    /* POST /:docNo/items returns the inserted row; pull its id and upload
       each staged File. Upload failures don't undo the line — surface a
       soft warning so the line can be re-attached. */
    const newItemId = (res.item as { id?: string } | null)?.id;
    if (newItemId && pendingFiles.length > 0) {
      let failed = 0;
      for (const f of pendingFiles) {
        try {
          await uploadPhoto.mutateAsync({ docNo: header!.doc_no, itemId: newItemId, file: f });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[so-line-photos] add-line upload failed', { file: f.name, err });
          failed++;
        }
      }
      if (failed > 0) {
        notify({
          title:
            `Line added, but ${failed} staged photo${failed === 1 ? '' : 's'} ` +
            `failed to upload.`,
          body: 'Please re-attach on the row.',
          tone: 'error',
        });
      }
    }
  };

  // Lock mechanism — CANCELLED + CLOSED + INVOICED are locked (terminal-ish
  // states). PR #145 + #146 — IN_PRODUCTION + READY_TO_SHIP removed from
  // forward flow (trading company). SHIPPED is now the earliest locked
  // state — once goods leave our hands, the SO header is no longer editable.
  // PR-DRAFT-removal — CONFIRMED is the initial editable state (no DRAFT).
  const lockedStatuses: SoStatus[] = ['SHIPPED', 'DELIVERED', 'INVOICED', 'CLOSED', 'CANCELLED'];

  if (detail.isLoading) {
    return <SkeletonDetailPage />;
  }
  if (detail.isError || !header) {
    return (
      <div className={styles.page}>
        <Link to="/scm/sales-orders" className={styles.backBtn}>
          <ArrowLeft {...ICON} />
          <span>Back</span>
        </Link>
        <div className={styles.bannerWarn}>
          <strong>Sales order not found.</strong>
          {detail.error instanceof Error ? ` ${detail.error.message}` : null}
        </div>
      </div>
    );
  }

  /* Tier 2 downstream-lock — once a non-cancelled DO/SI references this SO,
     the page becomes read-only. unlockOverride NOT honoured for this case —
     the child must be cancelled/deleted to edit. Convert-to-DO stays available
     (partial delivery) via the list's right-click. */
  const hasChildren = Boolean((header as { has_children?: boolean }).has_children);
  const isLocked = (lockedStatuses.includes(header.status) && !unlockOverride) || hasChildren;

  // Cancel SO flow (Commander 2026-05-29) — a cancelled SO stops proceeding
  // (no PO / DO / production; the whole page greys out) and can be reopened
  // back to CONFIRMED. Cancel is offered only on in-flight statuses (not once
  // it has SHIPPED / been INVOICED / CLOSED — those have downstream docs).
  const isCancelled = header.status === 'CANCELLED';
  const cancellableStatuses: SoStatus[] = ['CONFIRMED', 'IN_PRODUCTION', 'READY_TO_SHIP'];
  const canCancel = cancellableStatuses.includes(header.status);

  const handleCancelSo = async () => {
    if (!(await askConfirm({
      title: `Cancel ${header.doc_no}?`,
      body: "The SO will stop proceeding — it won't appear in MRP / PO / DO conversion, and line edits lock. You can Reopen it later.",
      confirmLabel: 'Cancel SO', danger: true,
    }))) return;
    updateStatus.mutate({ docNo: header.doc_no, status: 'CANCELLED' });
  };
  const handlePrint = () => {
    /* Followup #81 — Wait for the payments query before generating; legacy
       header columns (paid_centi, payment_method, …) are deprecated. If
       the query is still loading we surface a brief notice and bail out
       rather than printing a PDF with an empty Payments table. */
    if (printPaymentsQ.isLoading) {
      notify({ title: 'Loading payments… please try again in a moment.' });
      return;
    }
    const payments = printPaymentsQ.data ?? [];
    /* `pwpCodes` rides on the same GET /:docNo payload — vouchers this SO's
       trigger items issued, so the printed PDF can mark the trigger lines. */
    const pwpCodes = ((detail.data as { pwpCodes?: unknown[] } | undefined)?.pwpCodes ?? []) as never;
    generateSalesOrderPdf(header, items, payments, 'save', pwpCodes).catch((e) => {
      // eslint-disable-next-line no-console
      console.error('PDF generation failed:', e);
      notify({
        title: 'PDF generation failed',
        body: `${e instanceof Error ? e.message : String(e)}`,
        tone: 'error',
      });
    });
  };

  return (
    /* Commander 2026-05-29 — a CANCELLED SO greys the whole page so it reads
       as dead/inactive. The Cancel/Reopen buttons + banner stay clickable
       (a CSS filter doesn't block pointer events). */
    <div className={styles.page} style={isCancelled ? { filter: 'grayscale(0.7)' } : undefined}>
      {/* ── Header ──────────────────────────────────────────────── */}
      <div className={styles.headerRow}>
        <div className={styles.titleBlock}>
          <Link to="/scm/sales-orders" className={styles.backBtn}>
            <ArrowLeft {...ICON} />
            <span>Back</span>
          </Link>
          <div>
            <h1 className={styles.title}>
              <FileText size={16} strokeWidth={1.75} style={TITLE_ICON_STYLE} />
              {header.doc_no} — {header.debtor_name}
              {/* PR — commander 2026-05-27 followup: total badge moved out
                  of the title into a right-rail .totalRail meta block down
                  in the .actions group so this <h1> reads compact again. */}
            </h1>
            <p className={styles.subtitle}>
              SO date {fmtDateOrDash(header.so_date)} · {header.line_count} {header.line_count === 1 ? 'line' : 'lines'}
              {' · Current '}
              <span style={{ color: 'var(--c-burnt)', fontWeight: 600 }}>
                {(header as { current_doc_no?: string | null }).current_doc_no ?? header.doc_no}
              </span>
              {header.po_doc_no && ` · Customer PO ${header.po_doc_no}`}
              {header.customer_so_no && ` · Customer SO Ref ${header.customer_so_no}`}
              {(() => {
                const credit = Number((header as { customer_credit_centi?: number }).customer_credit_centi ?? 0);
                if (credit <= 0) return null;
                return (
                  <span style={{ color: 'var(--c-burnt)', fontWeight: 600 }}>
                    {' · Customer credit balance: '}
                    {fmtCenti(credit)}
                  </span>
                );
              })()}
            </p>
          </div>
        </div>
        <div className={styles.actions}>
          {/* PR — commander 2026-05-27 followup: Total relocated from the
              <h1> into this right-rail meta tile. Renders as a small eyebrow
              label + KPI-sized value alongside the status pill / actions.
              Brand burnt-orange retained; size = fs-15/600 (KPI-ish). */}
          <div className={styles.totalRail}>
            <span className={styles.totalRailLabel}>Total</span>
            <span className={styles.totalRailValue}>
              {fmtRm(header.local_total_centi, header.currency)}
            </span>
          </div>
          {(() => {
            const eff = soStatusDisplay(
              header.status,
              (header as { delivery_state?: DeliveryState }).delivery_state,
              (header as { lifecycle_state?: SoLifecycle }).lifecycle_state,
            );
            return (
              <span className={`${styles.statusPill} ${STATUS_CLASS[eff.classKey as SoStatus] ?? ''}`}>
                {eff.label ?? SO_STATUS_LABEL[header.status] ?? header.status.replace(/_/g, ' ')}
              </span>
            );
          })()}
          {/* PR-D — History drawer toggle. Commander 2026-05-27 wants a
              HOOKKA-style timeline showing who did what, when, and what
              changed. Reads from mfg_so_audit_log via useSalesOrderAuditLog. */}
          <Button variant="ghost" size="md" onClick={() => setHistoryOpen(true)}>
            <History {...ICON} />
            <span>History</span>
          </Button>
          <RelationshipMapButton type="so" id={docNo} />
          <Button variant="ghost" size="md" onClick={handlePrint}>
            <Printer {...ICON} />
            <span>Print PDF</span>
          </Button>
          {/* Cancel SO (Commander 2026-05-29). A cancelled SO stops proceeding
              (greys out, no MRP/PO/DO). Reopen was REMOVED (Commander 2026-06-22)
              — the backend treats a cancelled SO as final (so_cancelled_final);
              to revive, create a new SO. */}
          {!isCancelled && canCancel && !isEditing ? (
            <Button variant="ghost" size="md"
              onClick={handleCancelSo} disabled={updateStatus.isPending}
              style={{ color: 'var(--c-festive-b, #B8331F)' }}>
              <Ban {...ICON} />
              <span>Cancel SO</span>
            </Button>
          ) : null}
          {/* PR-A — Page-level Edit/Save/Cancel. Default view is read-only
              (Edit shown). In edit mode, Edit is replaced by Save + Cancel.
              Edit is disabled while the SO is locked (e.g. SHIPPED+) unless
              the override is in effect. */}
          {!isEditing ? (
            <Button variant="primary" size="md"
              onClick={enterEdit} disabled={isLocked}>
              <Pencil {...ICON} />
              <span>Edit</span>
            </Button>
          ) : (
            <>
              <Button variant="ghost" size="md"
                onClick={cancelEdit} disabled={updateHeader.isPending || savingOrder}>
                <span>Cancel</span>
              </Button>
              <Button variant="primary" size="md"
                onClick={saveEdit} disabled={updateHeader.isPending || savingOrder}>
                <Save {...ICON} />
                <span>{updateHeader.isPending || savingOrder ? 'Saving…' : 'Save'}</span>
              </Button>
            </>
          )}
        </div>
      </div>

      {/* PR-A — Inline error from the page-level Save. Cleared on Edit /
          Cancel / next successful Save. */}
      {saveError && (
        <div className={styles.bannerWarn}>
          <strong>Save failed.</strong>
          <span>{saveError}</span>
        </div>
      )}

      {/* ── Cancelled banner (Commander 2026-05-29) ─────────────── */}
      {isCancelled ? (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: 'var(--space-3) var(--space-4)',
          background: 'rgba(184, 51, 31, 0.10)',
          border: '1px solid var(--c-festive-b, #B8331F)',
          borderRadius: 'var(--radius-md)',
          fontSize: 'var(--fs-13)',
        }}>
          <span style={LOCK_BANNER_INNER_STYLE}>
            <Ban {...ICON} />
            <span>This SO is <strong>cancelled</strong> — it won't proceed (no MRP / PO / DO / production).</span>
          </span>
        </div>
      ) : null}

      {/* ── DRAFT banner + Confirm (DRAFT flow) ─────────────────────
          Scanned / auto-generated SOs land as DRAFT (excluded from
          KPI / MRP / PO / DO) so the operator can review + correct first.
          Confirming flips DRAFT → CONFIRMED via the status mutation, which
          invalidates the SO detail + list queries so the page updates.
          `header.status` is typed to the post-0078 enum (no DRAFT), so the
          stored value is read off a string view for the comparison. */}
      {(header.status as string) === 'DRAFT' && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: 'var(--space-3) var(--space-4)',
          background: 'rgba(232, 107, 58, 0.08)',
          border: '1px solid var(--c-orange)',
          borderRadius: 'var(--radius-md)',
          fontSize: 'var(--fs-13)',
        }}>
          <span style={LOCK_BANNER_INNER_STYLE}>
            <FileText {...ICON} />
            <span>
              <strong>Draft — not yet confirmed.</strong>{' '}
              Review and Confirm to make it a live order (it stays out of MRP / PO / DO until then).
            </span>
          </span>
          <Button variant="primary" size="sm"
            onClick={async () => {
              if (!(await askConfirm({
                title: `Confirm ${header.doc_no}?`,
                body: 'This turns the draft into a live, confirmed sales order — it will appear in MRP / PO / DO flows and KPIs.',
                confirmLabel: 'Confirm Order',
              }))) return;
              updateStatus.mutate({ docNo: header.doc_no, status: 'CONFIRMED' });
            }}
            disabled={updateStatus.isPending}>
            <span>{updateStatus.isPending ? 'Confirming…' : 'Confirm Order'}</span>
          </Button>
        </div>
      )}

      {/* ── Lock banner ─────────────────────────────────────────── */}
      {!isCancelled && lockedStatuses.includes(header.status) && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: 'var(--space-3) var(--space-4)',
          background: unlockOverride ? 'rgba(184, 51, 31, 0.06)' : 'rgba(232, 107, 58, 0.08)',
          border: `1px solid ${unlockOverride ? 'var(--c-festive-b, #B8331F)' : 'var(--c-orange)'}`,
          borderRadius: 'var(--radius-md)',
          fontSize: 'var(--fs-13)',
        }}>
          <span style={LOCK_BANNER_INNER_STYLE}>
            <Lock {...ICON} />
            {unlockOverride
              ? <strong>Edit-lock overridden — changes are tracked in the status timeline below.</strong>
              : <>This SO is <strong>{header.status.replace(/_/g, ' ')}</strong>. Line item edits + addresses are locked. Click <em>Override</em> if you must change something.</>}
          </span>
          <Button variant={unlockOverride ? 'ghost' : 'primary'} size="sm"
            onClick={async () => {
              if (!unlockOverride) {
                const reason = await askPrompt({
                  title: 'Reason for override?',
                  body: 'This unlocks editing on a locked SO. The override is tracked in the status timeline.',
                  placeholder: 'At least 10 characters',
                  multiline: true,
                  confirmLabel: 'Override',
                  validate: (v) => (v.trim().length < 10 ? 'Override needs a reason ≥ 10 chars.' : null),
                });
                if (reason == null) return;
                // Audit the override via a status change row (we re-affirm the
                // current status with an OVERRIDE notes prefix).
                updateStatus.mutate({ docNo: header.doc_no, status: header.status });
                setUnlockOverride(true);
              } else {
                setUnlockOverride(false);
              }
            }}>
            {unlockOverride ? 'Re-lock' : 'Override'}
          </Button>
        </div>
      )}

      {/* ── Customer info ───────────────────────────────────────── */}
      <CustomerCard
        ref={customerCardRef}
        header={header}
        onSave={handleHeaderSave}
        saving={updateHeader.isPending}
        locked={isLocked}
        isEditing={isEditing}
        onDeliveryDateChange={cascadeDeliveryDateToLines}
      />

      {/* PR #140 — Commander 2026-05-26: "这个 multi address、customer PO
          这些是什么？" The Multi-Address · Customer PO · Schedule card was
          a HOOKKA leftover (ship-to / bill-to / install-to / customer PO
          No / PO ID / PO Date). We don't model 3-way addresses or track
          the customer's own PO numbers. Dropped entirely; Processing
          Date + Delivery Date now live inside the Customer card below. */}

      {/* ── Line items ──────────────────────────────────────────── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Line Items ({items.length})</h2>
          {/* PR-A — Add Line Item is only shown in edit mode.
              Task #80 — clicking now seeds an inline SoLineCard at the
              bottom of the table (no more modal). Button hides itself
              while a draft is open to avoid stacking two add-cards. */}
          {isEditing && !addingDraft && (
            <Button variant="primary" size="sm" onClick={startAddLine} disabled={isLocked}>
              <Plus {...ICON} />
              <span>Add Line Item</span>
            </Button>
          )}
        </header>

        {items.length === 0 && !isEditing ? (
          <p className={styles.emptyRow}>No items yet — click "Edit" then "Add Line Item" to begin.</p>
        ) : isEditing ? (
          /* Whole-order inline edit — every line is an inline SoLineCard
             editor and all are editable at once. There is no per-row Save /
             Cancel anymore: the ONE page-level Save in the header commits the
             header + every line draft (+ any new add-draft) together. Each
             row keeps a small action bar with Override price ($) + Remove,
             since those operate on a single line. The add-draft (if open)
             renders as one more card at the bottom. */
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', padding: 'var(--space-3)' }}>
            {items.map((it, idx) => {
              const editDraft = editingDrafts[it.id];
              // A freshly-deleted row drops its draft (removeEditingLine) but
              // lingers in `items` until the re-fetch — skip rendering it.
              if (!editDraft) return null;
              const cb = rowCallbacks.get(it.id);
              return (
                <div key={it.id}>
                  {/* Per-line action — Override price ($). Removal is handled
                      by the SoLineCard's own trash button (onRemove → delete
                      mutation), so it isn't duplicated here. Override is a
                      single-line audited operation that the inline card
                      doesn't expose, so it stays in this small action bar. */}
                  <div className={styles.actionsCell} style={{ marginBottom: 'var(--space-2)' }}>
                    <button type="button" className={styles.iconBtn} title="Override price"
                      disabled={isLocked}
                      onClick={() => !isLocked && setOverriding(it)}>
                      <DollarSign {...SM_ICON} />
                    </button>
                  </div>
                  <SoLineCard
                    index={idx}
                    draft={editDraft}
                    onChange={cb?.onChange ?? ((patch) => patchEditingDraft(it.id, patch))}
                    onRemove={cb?.onRemove ?? (() => removeEditingLine(it.id))}
                    canRemove={!isLocked}
                    /* PR-F (#79) wiring — enable photo upload on already-saved
                       lines. New lines (addingDraft) have no itemId yet so
                       their photos defer to after the first save. */
                    docNo={header.doc_no}
                    itemId={it.id}
                    isEditing={!isLocked}
                  />
                </div>
              );
            })}

            {/* New line — staged as a card and committed by the page-level
                Save alongside the existing line edits. */}
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
              {/* PR #144 — Group column removed ("group是什么 删掉").
                  Category is already visible as a colored badge inside
                  the item's variant pills, so the raw "mfg_product"
                  internal kind isn't useful in the table view. */}
              <tr>
                <th>Item</th>
                <th>Description 2</th>
                <th className={styles.tableRight}>Qty</th>
                <th>Transfer To</th>
                <th className={styles.tableRight}>Unit</th>
                <th className={styles.tableRight}>Disc</th>
                {/* PR-E — Per-line delivery date. Falls back to the SO
                    header date when the line hasn't been overridden. */}
                <th className={styles.tableRight}>Delivery</th>
                <th className={styles.tableRight}>Total</th>
                {/* Task #114 — Per-line cost + margin columns. Cost is
                    snapshotted server-side from mfg_products on insert;
                    margin = line_total − line_cost. Mirrors the Houzs
                    Sales Order line-item layout commander pointed at. */}
                <th className={styles.tableRight}>Unit Cost</th>
                <th className={styles.tableRight}>Line Cost</th>
                <th className={styles.tableRight}>Margin</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => {
                /* PR-E — Display fallback: a line whose own date is null
                   AND that hasn't been overridden displays the SO header's
                   customer_delivery_date with a small "· auto" marker. The
                   API cascade keeps line_delivery_date populated for
                   non-overridden lines after each header save, so this
                   fallback mostly serves rows from before migration 0074
                   landed. */
                const displayDate = it.line_delivery_date
                  ?? (!it.line_delivery_date_overridden ? header.customer_delivery_date : null);
                const isAuto = !it.line_delivery_date_overridden;
                return (
                <tr key={it.id}>
                  <td>
                    <div className={styles.codeCell}>{it.item_code}</div>
                    {it.description && <div className={styles.muted}>{it.description}</div>}
                    {it.remark && (
                      <div className={styles.muted} style={{ fontStyle: 'italic' }}>
                        Remark: {it.remark}
                      </div>
                    )}
                  </td>
                  {/* Commander 2026-05-28 — "Description 2": the HOOKKA-style
                      one-line variant/spec summary in its own column.
                      Commander 2026-06-16 — recompute the summary LIVE from
                      `variants` (the source of truth) and fall back to the stored
                      description2 only when there's nothing to recompute. This
                      mirrors composeSoLineDescription (so-line-description.ts:34)
                      and the Convert-From pickers (VariantDescription.tsx:30) so
                      the VIEW table, the SO PDF, and the PO all show the SAME
                      line. Older rows carried a STALE stored description2 (written
                      before the remark/RM display fixes) that made this VIEW
                      disagree with what the PO printed. */}
                  <td data-label="Description 2">
                    {(() => {
                      const live = buildVariantSummary(it.item_group, it.variants);
                      const desc2 = live || (it.description2 ?? '').trim();
                      return desc2
                        ? <span>{desc2}</span>
                        : <span className={styles.muted}>—</span>;
                    })()}
                  </td>
                  <td className={styles.tableRight} data-label="Qty">{it.qty}</td>
                  <td data-label="Transfer To">
                    {(() => {
                      const hasDeliveries = it.deliveries && it.deliveries.length > 0;
                      const notFullyDelivered = (it.remaining_qty ?? 1) > 0;
                      /* Incoming-PO coverage (burnt, not green) — the goods are
                         ordered but not yet here, so it must read differently from
                         "Stock"/"Fully delivered". coverage_po is set only when the
                         MRP allocation covers the line with an outstanding PO. */
                      const coverage = (it.coverage_po && notFullyDelivered)
                        ? (
                          <div style={{
                            display: 'inline-block', marginTop: hasDeliveries ? 3 : 0,
                            fontSize: 'var(--fs-11)', fontWeight: 600,
                            whiteSpace: 'nowrap', color: 'var(--c-burnt)',
                          }}>
                            {it.coverage_po}{it.coverage_eta ? ` · ETA ${fmtDateOrDash(it.coverage_eta)}` : ''}
                          </div>
                        )
                        : null;
                      if (hasDeliveries) {
                        return (
                          <div>
                            {it.deliveries!.map((d, di) => (
                              <div key={di} style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
                                {d.doNumber} <span className={styles.muted} style={{ fontWeight: 400 }}>×{d.qty}</span>
                              </div>
                            ))}
                            {typeof it.remaining_qty === 'number' && (
                              <div style={{
                                fontSize: 'var(--fs-11)', marginTop: 1,
                                color: it.remaining_qty > 0 ? 'var(--c-festive-b, #B8331F)' : 'var(--c-secondary-a, #2F5D4F)',
                              }}>
                                {it.remaining_qty > 0 ? `Balance ${it.remaining_qty}` : 'Fully delivered'}
                              </div>
                            )}
                            {coverage}
                          </div>
                        );
                      }
                      return coverage ?? <span className={styles.muted}>—</span>;
                    })()}
                  </td>
                  <td className={styles.tableRight} data-label="Unit">{fmtRm(it.unit_price_centi, header.currency)}</td>
                  <td className={styles.tableRight} data-label="Disc">{it.discount_centi > 0 ? fmtRm(it.discount_centi, header.currency) : '—'}</td>
                  <td className={styles.tableRight} data-label="Delivery">
                    {displayDate ? (
                      <span style={isAuto ? { color: 'var(--fg-muted)' } : undefined}>
                        {fmtDateOrDash(displayDate)}
                        {isAuto && (
                          <span style={{ marginLeft: 4, color: 'var(--c-orange)', fontSize: 'var(--fs-11)' }}>· auto</span>
                        )}
                      </span>
                    ) : '—'}
                  </td>
                  <td className={styles.priceCell} data-label="Total">{fmtRm(it.total_centi, header.currency)}</td>
                  {/* Task #114 — cost + margin columns. unit_cost_centi is
                      snapshotted server-side from mfg_products on insert.
                      Margin coloring rule matches Houzs: green > 0, red < 0,
                      grey when zero (typically a not-yet-priced item). */}
                  <td className={styles.tableRight} data-label="Unit Cost">
                    <span className={styles.muted}>
                      {it.unit_cost_centi > 0 ? fmtRm(it.unit_cost_centi, header.currency) : '—'}
                    </span>
                  </td>
                  <td className={styles.tableRight} data-label="Line Cost">
                    <span className={styles.muted}>
                      {it.line_cost_centi > 0 ? fmtRm(it.line_cost_centi, header.currency) : '—'}
                    </span>
                  </td>
                  <td className={styles.tableRight} data-label="Margin">
                    {it.total_centi > 0 ? (
                      <span className={
                        it.line_margin_centi > 0 ? styles.marginGood
                        : it.line_margin_centi < 0 ? styles.marginBad
                        : styles.muted
                      } style={{ fontWeight: 600 }}>
                        {fmtRm(it.line_margin_centi, header.currency)}
                      </span>
                    ) : <span className={styles.muted}>—</span>}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {/* Task #114 — Totals card restored (commander 2026-05-27: "Houzs
          ERP 会计算全部 sku 的 costing 和自动总结一个 category 的 costing").
          The PR #154 hide was about pre-cost-wiring noise; with cost now
          snapshotted server-side and rolled up per category, the card is
          finally useful. Shows Revenue / Cost / Margin / Margin % at the
          top plus a per-category breakdown below. */}
      <TotalsCard header={header} />

      {/* ── Payment — Houzs-pattern transactions table ────────────── */}
      {/* Commander 2026-05-27: "Payment 也 follow Hookka 那个排版". Verbatim
          port of houzs-erp/src/components/NewSalesOrderForm.tsx Payments
          block (lines 1047-1126). Subtotal / Expected Deposit dropped —
          Houzs doesn't have them, and commander wants the ledger view
          (transactions + Deposit Paid + Balance) only.
          Task #105 — PaymentCard was extracted into <PaymentsTable> so
          New SO and Edit SO render the same ledger from one source. */}
      <PaymentsTable
        docNo={header.doc_no}
        grandTotalCenti={header.local_total_centi}
        currency={header.currency}
        locked={isLocked || !isEditing}
        slip={{ slipKey: header.slip_key, fetcher: fetchSoSlipUrl }}
      />

      {/* ── CUSTOMER SIGNATURE — moved directly below Payments (Wei Siang
          2026-06-06). Read-only proof captured on the POS handover pad; only
          shown when the SO carries one (POS orders). */}
      {header.signature_b64 && (
        <section className={styles.card}>
          <header className={styles.cardHeader}>
            <h2 className={styles.cardTitle}>Customer Signature</h2>
          </header>
          <div className={styles.cardBody}>
            <img
              src={header.signature_b64}
              alt="Customer signature captured at handover"
              style={{ maxWidth: 360, width: '100%', height: 'auto', border: '1px solid var(--c-line, #E5E1DC)', borderRadius: 8, background: '#fff' }}
            />
          </div>
        </section>
      )}

      {/* ── ORIGINAL SLIP + PAYMENT RECEIPT (migrations 0033 + 0034) — the
          handwritten order-slip photo (and, when the scan carried one, the
          printed card-terminal payment receipt) this SO was scanned from, kept
          as proof. Dual-read camelCase ?? snake_case (the pg driver camelCases
          result columns). Each card is shown only when its key is present, so
          the operator can View original on whichever images exist. */}
      {(() => {
        const slipImageKey =
          (header as unknown as { slipImageKey?: string | null }).slipImageKey ?? header.slip_image_key;
        const receiptImageKey =
          (header as unknown as { receiptImageKey?: string | null }).receiptImageKey ?? header.receipt_image_key;
        if (!slipImageKey && !receiptImageKey) return null;
        return (
          <>
            {slipImageKey && (
              <ScannedImageCard
                imageKey={slipImageKey}
                title="Order Slip"
                alt="Original handwritten sale-order slip"
              />
            )}
            {receiptImageKey && (
              <ScannedImageCard
                imageKey={receiptImageKey}
                title="Payment Receipt"
                alt="Scanned card-terminal payment receipt"
              />
            )}
          </>
        );
      })()}

      {/* ── Variant-completeness banner ─────────────────────────────
          PR #144 + #156 gating rule kept as a read-only warning. The
          "Move to next stage" pill strip below it (commander 2026-05-27:
          "这个不需要") was removed — status transitions now flow through
          the Edit/Save path or the API directly, while this banner stays
          so the Order Coordinator still sees which lines are incomplete
          when a Processing Date is set. updateStatus is still wired for
          the lock-override flow above. */}
      {incompleteVariantLines.length > 0 && (
        <div style={VARIANT_WARN_BANNER_STYLE}>
          <strong>Processing Date is set — line variants must be filled before next stage.</strong>
          <div style={VARIANT_WARN_LIST_STYLE}>
            {incompleteVariantLines.map((l, i) => (
              <div key={i}>
                • <code>{l.code}</code> ({l.group}): {formatGroupRequirements(l.group)}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Followup #85 — the standalone StatusTimeline + PriceOverridePanel
          audit cards were superseded by the PR-D History drawer, which
          shows ALL action types (CREATE / UPDATE_DETAILS / UPDATE_STATUS /
          ADD_LINE / UPDATE_LINE / DELETE_LINE / ADD_PAYMENT / …) in one
          unified feed. The underlying mfg_so_status_changes and
          mfg_so_price_overrides tables stay (writes continue), so old
          data remains queryable — only the rendering is removed. */}

      {/* ── Modals ─────────────────────────────────────────────── */}
      {/* Task #80 — LineItemModal removed (deleted with PR #125's inline
          SoLineCard work). Both Add + Edit now use inline SoLineCard rows
          inside the line-items table above. */}
      {overriding && (
        <OverridePriceModal
          item={overriding}
          docNo={header.doc_no}
          currency={header.currency}
          onClose={() => setOverriding(null)}
        />
      )}

      {/* PR-D — History drawer ─────────────────────────────────── */}
      {historyOpen && (
        <HistoryPanel docNo={header.doc_no} onClose={closeHistory} />
      )}
    </div>
  );
};

/* ════════════════════════════════════════════════════════════════════════
   Customer info card — editable, with debtor autocomplete
   ════════════════════════════════════════════════════════════════════════ */

/* PR-A — Imperative handle for the page-level Edit/Save framework.
   The parent calls save() with onSuccess/onError callbacks; reset() reverts
   the local form to the current header snapshot (used by Cancel). */
type CustomerCardHandle = {
  /** Returns the first blocking header error (date XOR / past date), or null
      when the header is OK. Called by the page Save BEFORE any line is written
      so a bad date never half-commits the order. */
  validate: () => string | null;
  save: (cb: { onSuccess: () => void; onError: (msg: string) => void }) => void;
  reset: () => void;
  /** Owner 2026-06-03 — current (possibly edited) phone value, so the page
      Save can enforce the compulsory-phone rule before any write, mirroring
      the New SO guard. */
  getPhone: () => string;
};

type CustomerCardProps = {
  header: SoHeader;
  /** PR-A — Optional callbacks let the parent's page-level Save flow know
      when the mutation succeeded or failed, so it can return to read-only /
      surface an inline error. The per-card Save button (legacy) still works
      without callbacks. */
  onSave: (
    patch: Record<string, unknown>,
    cb?: { onSuccess?: () => void; onError?: (msg: string) => void },
  ) => void;
  saving: boolean;
  /** When true, disable input editing — accepted but consumer must show
      the visual lock. We keep the prop optional so existing call sites
      compile. */
  locked?: boolean;
  /** PR-A — Page-level edit mode. When false (default), every input in this
      card is disabled and the per-card Save button is hidden — the parent
      page renders Edit/Save/Cancel in its own header. */
  isEditing?: boolean;
  /** Fix A — Live header→line cascade. Fires on every keystroke of the
      Delivery Date input (not just Save) so the parent can immediately push
      the new date into every line that hasn't been manually overridden. The
      parent owns the line drafts, so the card just reports the new value. */
  onDeliveryDateChange?: (date: string) => void;
};

/* Task #99 (UI perf) — Wrap the CustomerCard in memo so parent page state
   churn (Edit-mode toggle, History drawer, line-item edits) doesn't
   re-render the full address-cascade tree. Combined with the `onSave`
   useCallback in the page below + the debtor-search debounce, this is the
   biggest single saving on the Detail page. */
const CustomerCardInner = forwardRef<CustomerCardHandle, CustomerCardProps>(({
  header,
  onSave,
  /* PR-A — `saving` prop kept on the type for compatibility but the
     per-card Save button it drove was removed. The page-level Save in
     SalesOrderDetail's header now surfaces the in-flight spinner. */
  saving: _saving,
  locked = false,
  isEditing = false,
  onDeliveryDateChange,
}, ref) => {
  // PR #39 — POS-aligned customer + address form. Maps:
  //   • address1, address2 → free-text lines (POS "Address line 1/2")
  //   • address3           → city (cascade from localities)
  //   • address4           → postcode (cascade from city)
  //   • customer_state     → state (cascade source — PR #35 column)
  //   • venue              → reused for Building Type (POS dropdown)
  // Agent + Branding kept (B2B-specific, commander 2026-05-26).
  // POS field "Salesperson" → Agent column on the SO.
  const notify = useNotify();
  const localities = useLocalities();
  const localityRows = useMemo(() => localities.data ?? [], [localities.data]);
  const staffQ = useStaff();
  const staffList = (staffQ.data ?? []).filter((s) => s.active);
  /* Commander 2026-05-27: Venue is locked to the picked salesperson's
     staff.venue_id; only admin / sales_director may swap the salesperson.
     useVenues drives the read-only Venue input's display name. */
  const { staff: currentStaff } = useAuth();
  const venuesQ = useVenues();
  /* Commander 2026-05-27 ("delivery 一点没有跟着跳"): Sales Location no longer
     just mirrors header.sales_location. When the user picks a delivery state
     we look up state_warehouse_mappings and auto-populate the field with the
     mapped warehouse code. The user can still leave it blank (no mapping
     exists for that state) or manually override on Maintenance. */
  const stateWarehousesQ = useStateWarehouseMappings();
  const canChangeSalesperson =
    currentStaff?.role === 'admin' ||
    currentStaff?.role === 'sales_director' ||
    currentStaff?.role === 'super_admin';

  /* Task #118 — DB-backed dropdowns (was hardcoded). Falls back to the
     migration 0081 seed list when loading or when the DB has zero rows
     so commander never sees an empty select on this page. */
  const customerTypeOptsQ = useSoDropdownOptions('customer_type');
  const buildingTypeOptsQ = useSoDropdownOptions('building_type');
  const relationshipOptsQ = useSoDropdownOptions('relationship');
  const customerTypeOpts = optionsOrFallback('customer_type', customerTypeOptsQ.data);
  const buildingTypeOpts = optionsOrFallback('building_type', buildingTypeOptsQ.data);
  const relationshipOpts = optionsOrFallback('relationship',  relationshipOptsQ.data);

  /* PR #46 — Form shape now matches POS handover schema. Renamed
     debtor → customer; building_type promoted to proper column;
     branding + ref + venue dropped per commander 2026-05-26. */
  // PR #140 — Commander 2026-05-26 drop list:
  //   - poDocNo (Customer PO #)   → "customer PO 不需要"
  //   - targetDate                → replaced by Processing + Delivery Date
  // PR #140 — add list:
  //   - processingDate (= internal_expected_dd column, just renamed for UI)
  //   - customerDeliveryDate
  // The DB column `internal_expected_dd` stays — only the label changes.
  /* PR-A — initialFormFor() is the single source-of-truth for what the
     local form looks like when reset (Cancel) or when the header reloads
     after a successful Save. Keeps the snapshot + reset paths consistent. */
  const initialFormFor = (h: SoHeader) => ({
    /* customerCode kept in state but the UI no longer renders an input
       (commander 2026-05-27: "customer code 不需要"). Payload still sends
       debtorCode so the server-side mapping is unchanged. */
    customerCode: h.debtor_code ?? '',
    customerName: h.debtor_name ?? '',
    /* PR-A — customer's own SO reference number (their ERP doc no). The
       column has existed since PR #121; this exposes it as an editable
       field inside the Customer sub-section. */
    customerSoNo: h.customer_so_no ?? '',
    email: h.email ?? '',
    customerType: h.customer_type ?? '',
    salespersonId: h.salesperson_id ?? '',
    buildingType: h.building_type ?? '',
    /* PR #156 — Commander 2026-05-27: "开单的 venue 呢也没有". Reinstate
       venue as a free-text field separate from Building Type.

       Commander 2026-05-27 follow-up: "venue就不能换 自动跳出来". Venue is
       now read-only on Edit too — derived from the picked salesperson's
       staff.venue_id. We keep the free-text `venue` column on the row
       (back-compat with PDFs / reports) and also persist `venue_id` so the
       master link is durable. */
    venue: h.venue ?? '',
    venueId: h.venue_id ?? '',
    phone: h.phone ?? '',
    address1: h.address1 ?? '',
    address2: h.address2 ?? '',
    city: h.city ?? h.address3 ?? '',
    postcode: h.postcode ?? h.address4 ?? '',
    state: h.customer_state ?? '',
    emergencyContactName: h.emergency_contact_name ?? '',
    emergencyContactPhone: h.emergency_contact_phone ?? '',
    emergencyContactRelationship: h.emergency_contact_relationship ?? '',
    processingDate: h.internal_expected_dd ?? '',
    customerDeliveryDate: h.customer_delivery_date ?? '',
    note: h.note ?? '',
    /* Commander 2026-05-27 cascade — seeded from the persisted value so we
       don't clobber a manually-entered location on first paint. The cascade
       effect below replaces it whenever the state changes. */
    salesLocation: h.sales_location ?? '',
  });

  const [form, setForm] = useState(() => initialFormFor(header));
  const [showSuggest, setShowSuggest] = useState(false);
  /* Portal the debtor dropdown to document.body so the section card's
     overflow:hidden can't clip it (mirrors the SoLineCard fix). */
  const custInputRef = useRef<HTMLInputElement>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; width: number } | null>(null);
  /* Task #99 (UI perf) — 200 ms debounce on the debtor autocomplete. Until
     this commit each keystroke in the Customer Name field issued a
     /debtors/search request. The hook itself now guards length>=2 (see
     flow-queries.ts) but a fast typist still produced one request per
     character on top of that, which was the dominant freeze when entering
     a new customer. Debouncing here keeps `form.customerName` reactive for
     the rest of the card (state cascade, save payload) while the autocomplete
     hook sees a settled value. */
  const debouncedDebtorQ = useDebouncedValue(form.customerName, 200);
  const debtorQuery = useDebtorSearch(debouncedDebtorQ);
  const suggestions = (debtorQuery.data?.debtors ?? []).filter(
    (d) => (d.debtor_name ?? '').toLowerCase() !== form.customerName.trim().toLowerCase(),
  );

  /* Reset the local form to the header ONLY when not actively editing. A
     background refetch (payment add, slip upload, line-draft autosave) hands a
     fresh `header` reference; without this guard it would overwrite the
     operator's in-progress, unsaved Customer edits — the same silent-data-loss
     the line-item drafts buffer prevents. Cancel still resets via the ref. */
  useEffect(() => {
    if (isEditing) return;
    setForm(initialFormFor(header));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [header, isEditing]);

  const set = <K extends keyof typeof form>(k: K, v: string) =>
    setForm((s) => ({ ...s, [k]: v }));

  /* Commander 2026-05-27: keep form.venueId / form.venue in lock-step with
     the picked salesperson's home venue. Runs whenever the salesperson
     swaps OR when the staff/venue lookups arrive (since the staff row may
     not be in the list at first paint). We only patch when the resolved
     values differ from the current form to avoid an infinite loop. */
  useEffect(() => {
    if (!form.salespersonId) return;
    /* Houzs 2026-06-23 (owner): Venue is manually pickable — only auto-fill the
       DEFAULT when it is still empty; never override a manual or loaded pick. */
    if (form.venueId) return;
    const picked = staffList.find((s) => s.id === form.salespersonId);
    const resolvedId = picked?.venueId ?? '';
    if (!resolvedId) return;
    const resolvedName =
      (venuesQ.data ?? []).find((v) => v.id === resolvedId)?.name ?? '';
    setForm((s) => ({ ...s, venueId: resolvedId, venue: resolvedName }));
  }, [form.salespersonId, staffList, venuesQ.data, form.venueId]);

  /* Commander 2026-05-27 (Fix 5) — State → Sales Location cascade. When the
     user picks a delivery state, look up state_warehouse_mappings and set
     the Sales Location to the mapped warehouse code (e.g. "SLGR WAREHOUSE").
     Commander 2026-05-31: standardised on the warehouse CODE so this form, the
     New SO form, the server-side derive, and every list Location column all
     show ONE consistent label. PO warehouse resolution (resolveWarehouseId)
     matches on name OR code, so either resolves the same warehouse downstream
     — this is purely display. Only fires when we have a mapping AND the
     resolved code differs from what the form already shows — guards against
     re-render loops and avoids stomping a manual override before the mappings
     query resolves. */
  useEffect(() => {
    if (!form.state) return;
    const list = stateWarehousesQ.data?.mappings ?? [];
    if (list.length === 0) return;
    const hit = list.find((m) => m.state === form.state);
    const code = hit?.warehouse?.code ?? hit?.warehouse?.name ?? null;
    if (!code) return;
    if (form.salesLocation === code) return;
    setForm((s) => ({ ...s, salesLocation: code }));
  }, [form.state, stateWarehousesQ.data, form.salesLocation]);

  // Cascade derivations
  const states = useMemo(() => distinctStates(localityRows), [localityRows]);
  const cities = useMemo(
    () => (form.state ? citiesInState(localityRows, form.state) : []),
    [localityRows, form.state],
  );
  const postcodes = useMemo(
    () => (form.state && form.city ? postcodesInCity(localityRows, form.state, form.city) : []),
    [localityRows, form.state, form.city],
  );
  /* Task #121 — Country auto-derives from the picked state. Read-only on
     the form; the API re-derives + snapshots it on PATCH. Prefer the
     header's stored customer_country (so historic SOs whose locality
     country later changed still display the captured country); fall back
     to the live derive, then Malaysia. */
  const country = useMemo<string>(() => {
    const headerCountry = (header.customer_country as string | null | undefined) ?? null;
    if (headerCountry) return headerCountry;
    const derived = form.state ? countryForState(localityRows, form.state) : null;
    return derived ?? 'Malaysia';
  }, [header, form.state, localityRows]);

  const applySuggestion = (d: DebtorSuggestion) => {
    setForm((s) => ({
      ...s,
      customerCode: d.debtor_code ?? s.customerCode,
      customerName: d.debtor_name ?? s.customerName,
      phone: d.phone ?? s.phone,
      address1: d.address1 ?? s.address1,
      address2: d.address2 ?? s.address2,
      city: d.address3 ?? s.city,
      postcode: d.address4 ?? s.postcode,
    }));
    setShowSuggest(false);
  };

  /* PR #46 — Payload uses the proper column names now. Sales Location +
     Agent are NOT in this form — they auto-populate from the logged-in
     POS user (Sales Location = staff.showroom; Agent legacy column kept
     for B2B manual cases). */
  const buildPayload = () => ({
    debtorCode: form.customerCode,
    debtorName: form.customerName,
    /* PR-A — Persist customer's own SO ref. Empty string → null so we
       clear the column when the field is blanked. */
    customerSoNo: form.customerSoNo || null,
    email: form.email,
    customerType: form.customerType,
    salespersonId: form.salespersonId || null,
    buildingType: form.buildingType,
    /* Commander 2026-05-27: Venue is locked to the salesperson's
       staff.venue_id. We persist both the FK + the resolved name. */
    venue: form.venue,
    venueId: form.venueId || null,
    phone: form.phone,
    address1: form.address1,
    address2: form.address2,
    city: form.city,
    postcode: form.postcode,
    customerState: form.state,
    emergencyContactName: form.emergencyContactName,
    emergencyContactPhone: form.emergencyContactPhone,
    emergencyContactRelationship: form.emergencyContactRelationship,
    /* PR #140 — Processing Date persists to internal_expected_dd column
       (renamed in the UI per commander 2026-05-26: "internal expected date
       是 Hookka 用的"). targetDate field dropped. */
    internalExpectedDd: form.processingDate || null,
    customerDeliveryDate: form.customerDeliveryDate || null,
    note: form.note,
    /* Commander 2026-05-27 (Fix 5) — persist the auto-resolved sales location
       so subsequent edits don't lose it. Empty string → null so we clear the
       column when no mapping resolves AND the user blanks it. */
    salesLocation: form.salesLocation || null,
  });

  /* PR #156 — Commander 2026-05-27: "为什么能 save processing date 呢
     没有 delivery date 而且 variant 也没有补完". Mirror the New SO form's
     XOR rule on Detail Save: block when only one of Processing/Delivery
     Date is set. */
  const datesXor =
    (form.processingDate.trim() !== '') !== (form.customerDeliveryDate.trim() !== '');

  /* Commander 2026-05-28 — Processing/Delivery Date may only be today or a
     future date. en-CA renders the local YYYY-MM-DD. Used as the <input min>
     AND re-checked on Save (parity with the New SO form). */
  const today = new Date().toLocaleDateString('en-CA');

  /* Owner 2026-06-01 — Grandfather an already-past date that the edit does not
     change. The Processing Date is the day work started; once it has elapsed it
     is a historical record, so we LOCK its input (read-only) and never block a
     Save just because it sits in the past. The same grandfather (without the
     lock) applies to the Delivery Date so an SO can still be postponed even if
     its old delivery day has passed — only a freshly-typed past date is
     rejected. */
  const originalProcessing = header.internal_expected_dd ?? '';
  const originalDelivery = header.customer_delivery_date ?? '';
  const processingLocked = originalProcessing !== '' && originalProcessing < today;

  /* Returns the first blocking date error, or null when the dates are valid.
     Shared by the imperative validate() (page-level Save runs this BEFORE
     committing any line) and trySave (defence-in-depth on the header write). */
  const validateDates = (): string | null => {
    if (datesXor) {
      return 'Processing Date and Delivery Date must be set together.\n\n' +
        'Either fill in BOTH dates, or leave BOTH empty.';
    }
    if (form.processingDate && form.processingDate < today && form.processingDate !== originalProcessing) {
      return 'Processing Date cannot be in the past — pick today or a future date.';
    }
    if (form.customerDeliveryDate && form.customerDeliveryDate < today && form.customerDeliveryDate !== originalDelivery) {
      return 'Delivery Date cannot be in the past — pick today or a future date.';
    }
    /* Owner 2026-06-03 — Process Date is the factory start; it cannot fall after
       the Delivery Date (parity with the New SO form + the server gate). */
    if (form.processingDate && form.customerDeliveryDate && form.processingDate > form.customerDeliveryDate) {
      return 'Processing Date cannot be later than the Delivery Date.';
    }
    return null;
  };

  const trySave = (cb?: { onSuccess?: () => void; onError?: (msg: string) => void }) => {
    const err = validateDates();
    if (err) {
      if (cb?.onError) cb.onError(err);
      else notify({ title: 'Check the dates', body: err, tone: 'error' });
      return;
    }
    onSave(buildPayload(), cb);
  };

  /* PR-A — Expose imperative save()/reset() so the page-level Edit/Save/
     Cancel buttons can drive this card without lifting all of its form
     state to the parent. No deps array → handle re-binds every render so
     `save` always closes over the latest form snapshot. */
  useImperativeHandle(ref, () => ({
    validate: () => validateDates(),
    save: (cb) => trySave(cb),
    reset: () => setForm(initialFormFor(header)),
    getPhone: () => form.phone ?? '',
  }));

  /* PR-A — Inputs are read-only when the page isn't in edit mode OR the
     SO is locked (post-SHIPPED). Combining both keeps the existing lock
     semantics intact. */
  const inputsDisabled = !isEditing || locked;

  /* Pin the portaled debtor dropdown under the Customer Name input while open. */
  useEffect(() => {
    if (!showSuggest || inputsDisabled) { setMenuPos(null); return; }
    const update = () => {
      const el = custInputRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setMenuPos({ top: r.bottom + 4, left: r.left, width: r.width });
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => { window.removeEventListener('scroll', update, true); window.removeEventListener('resize', update); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSuggest, inputsDisabled]);

  /* PR #168 — Commander 2026-05-27 screenshot diff vs. Create SO: Detail
     was using one big "Customer · Addresses" card with 4 hairline-divided
     sub-blocks; Create SO uses 4 visually distinct top-level cards. Mirror
     the New SO layout here — same module classes (.card / .cardHeader /
     .cardTitle / .formGrid4 / .field / .fieldLabel) — so the two pages
     read identically. The component still exposes its imperative save() /
     reset() handle to the page-level Edit/Save flow; the 4 cards just
     replace the single wrapper. */
  return (
    <>
      {/* ── CUSTOMER ──────────────────────────────────────────────── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Customer</h2>
        </header>
        <div className={styles.cardBody}>
          {/* PR-A — Customer Code input removed (commander 2026-05-27:
              "customer code 不需要"). Field still flows through state +
              payload so the server-side mapping is untouched.
              Customer SO Ref added next to Customer Name. */}
          <div className={styles.formGrid4}>
            <label className={styles.field} style={{ gridColumn: 'span 3' }}>
              <span className={styles.fieldLabel}>Customer Name *</span>
              <input
                ref={custInputRef}
                className={styles.fieldInput}
                value={form.customerName}
                disabled={inputsDisabled}
                onChange={(e) => { set('customerName', e.target.value); setShowSuggest(true); }}
                onFocus={() => setShowSuggest(true)}
                onBlur={() => setTimeout(() => setShowSuggest(false), 150)}
              />
              {showSuggest && suggestions.length > 0 && !inputsDisabled && menuPos && createPortal(
                <ul
                  className={styles.suggestList}
                  style={{ position: 'fixed', top: menuPos.top, left: menuPos.left, width: menuPos.width, right: 'auto', marginTop: 0, zIndex: 1000 }}
                >
                  {suggestions.slice(0, 8).map((d, i) => (
                    <li
                      key={`${d.debtor_code ?? ''}-${i}`}
                      className={styles.suggestItem}
                      onMouseDown={() => applySuggestion(d)}
                    >
                      <div>{d.debtor_name}</div>
                      {(d.debtor_code || d.phone) && (
                        <div className={styles.suggestCode}>
                          {d.debtor_code ?? ''}{d.debtor_code && d.phone ? ' · ' : ''}{formatPhone(d.phone) || ''}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>,
                document.body,
              )}
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Customer SO Ref</span>
              <input className={styles.fieldInput} value={form.customerSoNo}
                placeholder="Their PO / SO number"
                disabled={inputsDisabled}
                onChange={(e) => set('customerSoNo', e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Phone *</span>
              {/* Task #91 — PhoneInput normalizes to E.164 on blur and shows
                  the pretty Malaysian format when unfocused. */}
              <PhoneInput
                className={styles.fieldInput}
                value={form.phone}
                disabled={inputsDisabled}
                onChange={(v) => set('phone', v)}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Email *</span>
              <input type="email" className={styles.fieldInput} value={form.email}
                disabled={inputsDisabled}
                onChange={(e) => set('email', e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Customer Type</span>
              <span className={styles.selectWrap}>
                <select className={styles.fieldSelect} value={form.customerType}
                  disabled={inputsDisabled}
                  onChange={(e) => set('customerType', e.target.value)}>
                  <option value="">—</option>
                  {customerTypeOpts.map((t) => (
                    <option key={t.id} value={t.value}>{t.label}</option>
                  ))}
                  {/* If the persisted value isn't in the active options list
                      (commander deactivated it but this SO already references
                      it), render it explicitly so the select still shows it. */}
                  {form.customerType && !customerTypeOpts.some((t) => t.value === form.customerType) && (
                    <option value={form.customerType}>{form.customerType}</option>
                  )}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Salesperson</span>
              {/* Commander 2026-05-27: only admin / sales_director can swap
                  the salesperson on an existing SO. Non-admin sales roles
                  see a disabled select pinned to whoever owns the SO. */}
              <span className={styles.selectWrap}>
                <select className={styles.fieldSelect} value={form.salespersonId}
                  disabled={inputsDisabled || !canChangeSalesperson}
                  onChange={(e) => set('salespersonId', e.target.value)}>
                  <option value="">— Pick staff —</option>
                  {sortByText(staffList).map((s) => (
                    <option key={s.id} value={s.id}>{s.name} ({s.staffCode})</option>
                  ))}
                  {/* Persisted salesperson may not be in the active list
                      (deactivated since the SO was created) — render
                      explicitly so the select still shows the original
                      name instead of blanking out. */}
                  {form.salespersonId
                    && !staffList.some((s) => s.id === form.salespersonId)
                    && (
                      <option value={form.salespersonId}>
                        (former staff)
                      </option>
                    )}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
          </div>
        </div>
      </section>

      {/* ── ORDER INFO (venue / dates / note) ─────────────────────── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Order Info</h2>
        </header>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Building Type</span>
              <span className={styles.selectWrap}>
                <select className={styles.fieldSelect} value={form.buildingType}
                  disabled={inputsDisabled}
                  onChange={(e) => set('buildingType', e.target.value)}>
                  <option value="">—</option>
                  {buildingTypeOpts.map((b) => (
                    <option key={b.id} value={b.value}>{b.label}</option>
                  ))}
                  {form.buildingType && !buildingTypeOpts.some((b) => b.value === form.buildingType) && (
                    <option value={form.buildingType}>{form.buildingType}</option>
                  )}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Venue</span>
              {/* Houzs 2026-06-23 (owner): Venue is manually pickable (was a
                  locked 2990 field). Defaults to the salesperson's venue. */}
              <span className={styles.selectWrap}>
                <select
                  className={styles.fieldSelect}
                  value={form.venueId || ''}
                  disabled={inputsDisabled}
                  onChange={(e) => {
                    const id = e.target.value;
                    const name = (venuesQ.data ?? []).find((v) => v.id === id)?.name ?? '';
                    setForm((s) => ({ ...s, venueId: id, venue: name }));
                  }}
                  aria-label="Venue"
                >
                  <option value="">—</option>
                  {(venuesQ.data ?? []).map((v) => (
                    <option key={v.id} value={v.id}>{v.name}</option>
                  ))}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Processing Date</span>
              <input type="date" className={styles.fieldInput} value={form.processingDate}
                disabled={inputsDisabled || processingLocked}
                title={processingLocked ? 'Processing date has passed — locked.' : undefined}
                min={processingLocked ? undefined : today}
                onChange={(e) => set('processingDate', e.target.value)}
                style={datesXor && !form.processingDate ? { borderColor: 'var(--c-festive-b, #B8331F)' } : undefined} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Delivery Date</span>
              <input type="date" className={styles.fieldInput} value={form.customerDeliveryDate}
                disabled={inputsDisabled}
                min={today}
                onChange={(e) => { set('customerDeliveryDate', e.target.value); onDeliveryDateChange?.(e.target.value); }}
                style={datesXor && !form.customerDeliveryDate ? { borderColor: 'var(--c-festive-b, #B8331F)' } : undefined} />
            </label>
            {/* Proceed Date field removed per request 2026-06-05 — the POS still
                stamps proceeded_at server-side; it's just no longer surfaced here. */}
            <label className={`${styles.field}`} style={{ gridColumn: 'span 4' }}>
              <span className={styles.fieldLabel}>Note</span>
              <input className={styles.fieldInput} value={form.note}
                disabled={inputsDisabled}
                onChange={(e) => set('note', e.target.value)} />
            </label>
          </div>
          {datesXor && (
            <div style={DATES_XOR_WARN_STYLE}>
              ⚠ Processing Date and Delivery Date must be set together — Save is blocked.
            </div>
          )}
        </div>
      </section>

      {/* ── EMERGENCY CONTACT ─────────────────────────────────────── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Emergency Contact</h2>
          <span style={EMERGENCY_HEADER_NOTE_STYLE}>
            Used only if we cannot reach the customer on delivery day
          </span>
        </header>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Contact Name</span>
              <input className={styles.fieldInput} value={form.emergencyContactName}
                placeholder="e.g. Lim Mei Hua"
                disabled={inputsDisabled}
                onChange={(e) => set('emergencyContactName', e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Relationship</span>
              {/* Task #118 — DB-backed dropdown (was a free-text input).
                  Detail and New SO now share the same option list from
                  so_dropdown_options('relationship'). Historical free-text
                  values that aren't in the options list still render via
                  the trailing fallback <option> so we don't silently drop
                  them on first paint. */}
              <span className={styles.selectWrap}>
                <select className={styles.fieldSelect} value={form.emergencyContactRelationship}
                  disabled={inputsDisabled}
                  onChange={(e) => set('emergencyContactRelationship', e.target.value)}>
                  <option value="">—</option>
                  {relationshipOpts.map((r) => (
                    <option key={r.id} value={r.value}>{r.label}</option>
                  ))}
                  {form.emergencyContactRelationship &&
                    !relationshipOpts.some((r) => r.value === form.emergencyContactRelationship) && (
                    <option value={form.emergencyContactRelationship}>
                      {form.emergencyContactRelationship}
                    </option>
                  )}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <label className={styles.field} style={{ gridColumn: 'span 2' }}>
              <span className={styles.fieldLabel}>Phone</span>
              <PhoneInput
                className={styles.fieldInput}
                value={form.emergencyContactPhone}
                disabled={inputsDisabled}
                onChange={(v) => set('emergencyContactPhone', v)}
              />
            </label>
          </div>
        </div>
      </section>

      {/* CUSTOMER SIGNATURE + PAYMENT SLIP relocated (Wei Siang 2026-06-06):
          signature now renders directly below Payments (above), and the payment
          slip is shown as a column inside the Payments table. */}

      {/* ── DELIVERY ADDRESS ──────────────────────────────────────── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Delivery Address</h2>
        </header>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <label className={`${styles.field}`} style={{ gridColumn: 'span 4' }}>
              <span className={styles.fieldLabel}>Address Line 1</span>
              <input className={styles.fieldInput} value={form.address1}
                placeholder="Unit, street, area"
                disabled={inputsDisabled}
                onChange={(e) => set('address1', e.target.value)} />
            </label>
            <label className={`${styles.field}`} style={{ gridColumn: 'span 4' }}>
              <span className={styles.fieldLabel}>Address Line 2</span>
              <input className={styles.fieldInput} value={form.address2}
                placeholder="Apt, floor, building (optional)"
                disabled={inputsDisabled}
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
            {/* Task #121 — Country is auto-derived from the picked state via
                my_localities. Read-only; the API re-derives + snapshots it
                onto the SO header on PATCH whenever customerState changes. */}
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Country</span>
              <span className={styles.fieldInput} style={{
                display: 'inline-flex', alignItems: 'center', height: 26,
                color: 'var(--fg-muted)',
              }}>
                {country}
              </span>
            </div>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Sales Location</span>
              {/* Commander 2026-05-27 (Fix 5) — Auto-derived from
                  state_warehouse_mappings on State change. Surfaced as
                  read-only display (mappings are managed from Maintenance)
                  but the live form value is what gets persisted. */}
              <span className={styles.fieldInput} style={{
                display: 'inline-flex', alignItems: 'center', height: 26,
                color: 'var(--fg-muted)',
              }}
                title={form.salesLocation
                  ? `Auto-set from State → Warehouse mapping for "${form.state}"`
                  : 'Pick a State above to auto-set'}
              >
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
   Variants summary pills (for line items table)
   ════════════════════════════════════════════════════════════════════════ */

/* PR #168 — Commander 2026-05-27: "字体统一". Pill keys were rendering as
   camelCase variable names (gap / legHeight / fabricCode) which read like
   debug output. Map known keys to human Title Case labels, fall back to
   camelCase → "Camel Case" splitter for anything unmapped. Array values
   (e.g. specials: ['Extra cushion', 'Pet-proof']) join with ", ". */
const VARIANT_KEY_LABELS: Record<string, string> = {
  gap:          'Gap',
  legHeight:    'Leg Height',
  /* Commander 2026-05-28 — unify fabric/colour term → "Fabrics".
     Keys (fabricCode/colorCode) unchanged; only the displayed label. */
  fabricCode:   'Fabrics',
  colorCode:    'Fabrics',
  divanHeight:  'Divan Height',
  totalHeight:  'Total Height',
  seatHeight:   'Seat Height',
  specials:     'Specials',
};

const camelCaseToTitle = (s: string): string => {
  if (!s) return s;
  const spaced = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

const formatVariantValue = (v: unknown): string => {
  if (Array.isArray(v)) return v.map((x) => String(x)).join(', ');
  return String(v);
};

/* Task #99 (UI perf) — VariantsPills renders once per line item in the
   table. With ~20 lines on a typical SO + 36-col DataGrid in the same
   page, the cumulative re-render cost was non-trivial. Pure prop-driven
   so React.memo is a free win. */
const VariantsPills = memo(({ variants }: { variants: Record<string, unknown> | null }) => {
  if (!variants || typeof variants !== 'object') return null;
  const entries = Object.entries(variants).filter(([, v]) => {
    if (v == null || v === '') return false;
    if (Array.isArray(v) && v.length === 0) return false;
    return true;
  });
  if (entries.length === 0) return null;
  return (
    <div className={styles.variantBlock}>
      {entries.map(([k, v]) => (
        <span key={k} className={styles.variantPill}>
          {VARIANT_KEY_LABELS[k] ?? camelCaseToTitle(k)}: {formatVariantValue(v)}
        </span>
      ))}
    </div>
  );
});
VariantsPills.displayName = 'VariantsPills';

/* ════════════════════════════════════════════════════════════════════════
   Totals card
   ════════════════════════════════════════════════════════════════════════ */

/* ── Scanned image viewer (migrations 0033 + 0034) ──────────────────────────
   When the SO was created via the Scan Order flow, the handwritten ORDER SLIP
   (0033) and/or the printed card-terminal PAYMENT RECEIPT (0034) were kept in
   R2. Show each as proof: authed-fetch the serve endpoint as a blob (the bearer
   token can't ride on an <img src>), render the object URL inline, and offer
   "open full size" in a new tab. Mirrors the item-photo blob display pattern;
   the object URL is revoked on unmount. `title` / `alt` distinguish the two. */
const ScannedImageCard = ({
  imageKey,
  title,
  alt,
}: {
  imageKey: string;
  title: string;
  alt: string;
}) => {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    fetchScanSlipImageBlobUrl(imageKey)
      .then((u) => {
        if (cancelled) { URL.revokeObjectURL(u); return; }
        url = u;
        setSrc(u);
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [imageKey]);

  return (
    <section className={styles.card}>
      <header className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>{title}</h2>
      </header>
      <div className={styles.cardBody}>
        {error ? (
          <div style={{ color: 'var(--c-festive-b, #B8331F)', fontSize: 13 }}>
            Couldn&apos;t load the scanned image. {error}
          </div>
        ) : src ? (
          <a href={src} target="_blank" rel="noreferrer" title="Open full size in a new tab">
            <img
              src={src}
              alt={alt}
              style={{ maxWidth: 360, width: '100%', height: 'auto', border: '1px solid var(--c-line, #E5E1DC)', borderRadius: 8, background: '#fff', cursor: 'zoom-in' }}
            />
          </a>
        ) : (
          <div style={{ fontSize: 13, color: 'var(--c-muted, #8A8377)' }}>Loading…</div>
        )}
      </div>
    </section>
  );
};

const TotalsCard = ({ header }: { header: SoHeader }) => {
  // margin_pct_basis is margin/revenue × 10000 (i.e. percent × 100). Divide
  // by 100 to get the displayed percentage. Coloring rule matches the Houzs
  // detail page: ≥30% emerald, ≥15% amber, < 15% red, 0/negative red.
  const marginPct = header.margin_pct_basis / 100;
  const marginCls =
    header.total_margin_centi <= 0 ? styles.marginBad
    : marginPct >= 30 ? styles.marginGood
    : marginPct >= 15 ? styles.marginWarn
    : styles.marginBad;

  /* Task #114 — Per-category rows. Each category surfaces revenue, cost,
     and margin (revenue − cost) so commander can see where the SO's
     margin is coming from at a glance. Cost columns fall back to 0 when
     the row pre-dates migration 0079 (it'll backfill on next item write). */
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
      <header className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>Totals · Margin</h2>
      </header>
      <div className={styles.cardBody}>
        {/* Top row — Revenue / Cost / Margin / Margin % as 4 KPI tiles.
            Houzs 2026-06-24 — class (not inline const) so the phone breakpoint
            can collapse 4 cols → 2×2 (Margin % was clipping at ~80px/col). */}
        <div className={styles.totalsKpiGrid}>
          <div>
            <div className={styles.totalLabel}>Revenue</div>
            <div className={styles.grandTotal} style={TOTALS_KPI_VALUE_STYLE}>
              {fmtRm(header.local_total_centi, header.currency)}
            </div>
          </div>
          <div>
            <div className={styles.totalLabel}>Cost</div>
            <div className={styles.totalValue} style={TOTALS_KPI_VALUE_STYLE}>
              {fmtRm(header.total_cost_centi, header.currency)}
            </div>
          </div>
          <div>
            <div className={styles.totalLabel}>Margin</div>
            <div className={`${styles.totalValue} ${marginCls}`} style={TOTALS_KPI_VALUE_STYLE}>
              {fmtRm(header.total_margin_centi, header.currency)}
            </div>
          </div>
          <div>
            <div className={styles.totalLabel}>Margin %</div>
            <div className={`${styles.totalValue} ${marginCls}`} style={TOTALS_KPI_VALUE_STYLE}>
              {header.local_total_centi > 0 ? `${marginPct.toFixed(1)}%` : '—'}
            </div>
          </div>
        </div>

        {/* By-category breakdown */}
        <div className={styles.totalLabel} style={{ marginBottom: 'var(--space-2)' }}>
          By Category
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          {/* Commander 2026-05-29 — only show categories that actually carry a
             value; hide the 0.00 rows so the breakdown stays clean ("变弹性"). */}
          {categories.filter((c) => c.rev > 0 || c.cost > 0).map(({ label, rev, cost }) => {
            const margin = rev - cost;
            return (
              <div key={label} style={{
                display: 'grid',
                gridTemplateColumns: '1.4fr 1fr 1fr 1fr',
                gap: 'var(--space-3)',
                alignItems: 'baseline',
              }}>
                <div className={styles.totalLabel} style={{ textTransform: 'none', letterSpacing: 0, fontSize: 'var(--fs-13)' }}>
                  {label}
                </div>
                <div className={styles.totalValue}>
                  Revenue {fmtRm(rev, header.currency)}
                </div>
                <div className={styles.totalValue} style={{ color: 'var(--fg-muted)' }}>
                  Cost {fmtRm(cost, header.currency)}
                </div>
                <div className={`${styles.totalValue} ${fmtMarginClass(rev, margin)}`}>
                  Margin {fmtRm(margin, header.currency)}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
};

/* ════════════════════════════════════════════════════════════════════════
   Task #101 — dead code removal (2026-05-27)
   ────────────────────────────────────────────────────────────────────────
   The following exports/components were removed because PR #171 (Houzs
   rollout) replaced their callers:
     • StatusBar + NEXT — status transition strip; the Edit/Save framework
       now drives status changes via updateStatus.mutate() directly from
       the page header (commander 2026-05-27: "这个不需要")
     • AddressCard — multi-address (ship-to / bill-to / install-to) card;
       PR #168 replaced it with the 4-section CustomerCard split below.
   The DB columns the deleted components read from (ship_to_address /
   bill_to_address / install_to_address / customer_po / customer_po_id /
   customer_po_date / hub_name / overdue) remain in the schema so existing
   rows stay queryable — only the UI rendering is gone.
   ════════════════════════════════════════════════════════════════════════ */

/* ════════════════════════════════════════════════════════════════════════
   PaymentCard moved → components/PaymentsTable (task #105).
   AddressCard + StatusBar + NEXT deleted as dead code (task #101).
   ════════════════════════════════════════════════════════════════════════ */



/* ════════════════════════════════════════════════════════════════════════
   StatusTimeline + PriceOverridePanel — removed in followup #85
   Both standalone audit cards were superseded by the PR-D History drawer
   (useSalesOrderAuditLog), which renders the same data plus every other
   action type in one unified feed. The underlying tables and writes are
   retained so the data remains queryable for admin tooling.
   ════════════════════════════════════════════════════════════════════════ */

/* ════════════════════════════════════════════════════════════════════════
   OverridePriceModal — PR #35 set line price override + reason audit
   ════════════════════════════════════════════════════════════════════════ */

const OverridePriceModal = ({
  item,
  docNo,
  currency,
  onClose,
}: {
  item: SoItem;
  docNo: string;
  currency: string;
  onClose: () => void;
}) => {
  const override = useOverrideMfgSoLinePrice();
  const notify = useNotify();
  const [overrideRm, setOverrideRm] = useState(
    (item.unit_price_centi / 100).toFixed(2),
  );
  const [reason, setReason] = useState('');

  const submit = () => {
    const newSen = Math.round(Number(overrideRm) * 100);
    if (!Number.isFinite(newSen) || newSen <= 0) {
      notify({ title: 'Override price must be a positive number.', tone: 'error' });
      return;
    }
    if (reason.trim().length < 10) {
      notify({ title: 'Reason must be at least 10 characters.', tone: 'error' });
      return;
    }
    override.mutate(
      { docNo, itemId: item.id, overridePriceSen: newSen, reason: reason.trim() },
      { onSuccess: () => onClose() },
    );
  };

  const delta = Math.round(Number(overrideRm) * 100) - item.unit_price_centi;
  const deltaPct = item.unit_price_centi > 0
    ? (delta / item.unit_price_centi) * 100
    : 0;

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <header className={styles.modalHeader}>
          <h3 className={styles.modalTitle}>
            <DollarSign {...ICON} style={{ verticalAlign: 'middle', marginRight: 6 }} />
            Override Line Price
          </h3>
          <button type="button" className={styles.iconBtn} onClick={onClose} title="Close">
            <X {...ICON} />
          </button>
        </header>

        <div className={styles.modalBody}>
          <p className={styles.muted}>
            Item <strong>{item.item_code}</strong>{item.description ? ` — ${item.description}` : ''}<br />
            Current unit price: <strong>{fmtRm(item.unit_price_centi, currency)}</strong>
          </p>

          <div className={styles.formGrid4}>
            <label className={styles.field} style={{ gridColumn: 'span 2' }}>
              <span className={styles.fieldLabel}>Override Price (RM) *</span>
              <input type="number" step="0.01" min="0"
                className={styles.fieldInput}
                value={overrideRm}
                onChange={(e) => setOverrideRm(e.target.value)} />
            </label>
            <div className={styles.field} style={{ gridColumn: 'span 2' }}>
              <span className={styles.fieldLabel}>Δ vs current</span>
              <span className={styles.fieldInput} style={{
                display: 'inline-flex', alignItems: 'center', height: 32,
                color: delta < 0 ? 'var(--c-festive-b, #B8331F)' : 'var(--c-burnt)',
              }}>
                {delta >= 0 ? '+' : ''}{fmtRm(delta, currency)} ({deltaPct.toFixed(1)}%)
              </span>
            </div>
          </div>

          <label className={styles.field}>
            <span className={styles.fieldLabel}>Reason * (≥ 10 chars, audited)</span>
            <textarea className={styles.fieldInput} rows={3}
              placeholder="e.g. Manager approved 15% discount due to display unit blemish."
              value={reason}
              onChange={(e) => setReason(e.target.value)} />
          </label>
        </div>

        <footer className={styles.modalFooter}>
          <Button variant="ghost" size="md" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="md" onClick={submit} disabled={override.isPending}>
            {override.isPending ? 'Saving…' : 'Override + Audit'}
          </Button>
        </footer>
      </div>
    </div>
  );
};

/* ════════════════════════════════════════════════════════════════════════
   PR-D — HistoryPanel
   Right-side drawer driven by mfg_so_audit_log. HOOKKA / Inistate-style:
     • avatar (initials in hash-colored circle)
     • "<actor> performed <action> [status pill] · <relative time>"
     • "via <source>" suffix
     • "Changes" toggle expands a field-level from→to diff block
   ════════════════════════════════════════════════════════════════════════ */

const ACTION_LABEL: Record<string, string> = {
  CREATE:         'Created order',
  UPDATE_DETAILS: 'Updated details',
  UPDATE_STATUS:  'Status changed',
  ADD_LINE:       'Added line',
  UPDATE_LINE:    'Updated line',
  DELETE_LINE:    'Removed line',
  ADD_PAYMENT:    'Added payment',
  DELETE_PAYMENT: 'Removed payment',
};

const FIELD_LABEL: Record<string, string> = {
  debtorCode: 'Customer code', debtorName: 'Customer', agent: 'Agent',
  phone: 'Phone', email: 'Email', soDate: 'SO date', status: 'Status',
  paymentMethod: 'Payment method', depositCenti: 'Deposit',
  internalExpectedDd: 'Processing date', customerSoNo: 'Customer SO ref',
  customerPo: 'Customer PO', customerState: 'State',
  customerDeliveryDate: 'Delivery date', city: 'City', postcode: 'Postcode',
  buildingType: 'Building type', address1: 'Address 1', address2: 'Address 2',
  address3: 'Address 3', address4: 'Address 4', note: 'Note',
  remark2: 'Remark 2', remark3: 'Remark 3', remark4: 'Remark 4',
  itemCode: 'Item', itemGroup: 'Group', description: 'Description',
  description2: 'Description 2', uom: 'UOM', qty: 'Qty',
  unitPriceCenti: 'Unit price', discountCenti: 'Discount',
  unitCostCenti: 'Unit cost', totalCenti: 'Line total',
  lineCount: 'Lines', localTotalCenti: 'Total', cancelled: 'Cancelled',
  remark: 'Remark', salespersonId: 'Salesperson', customerType: 'Customer type',
  emergencyContactName: 'Emergency name', emergencyContactPhone: 'Emergency phone',
  emergencyContactRelationship: 'Emergency relationship',
  targetDate: 'Target date', branding: 'Branding', venue: 'Venue', venueId: 'Venue (master)',
  salesLocation: 'Sales location', ref: 'Ref', poDocNo: 'PO doc no',
};

const MONEY_FIELDS = new Set(['unitPriceCenti', 'discountCenti', 'totalCenti', 'depositCenti', 'localTotalCenti', 'unitCostCenti']);

const fmtField = (field: string, val: unknown): string => {
  if (val === null || val === undefined || val === '') return '—';
  if (MONEY_FIELDS.has(field) && typeof val === 'number') {
    return fmtCenti(val);
  }
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val).replace(/_/g, ' ');
};

const hashHue = (s: string): number => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
};

const initialsFor = (name: string | null): string => {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0] ?? '';
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  const last = parts[parts.length - 1] ?? '';
  return ((first[0] ?? '') + (last[0] ?? '')).toUpperCase();
};

const relTime = (iso: string): string => {
  const then = new Date(iso).getTime();
  const diffMs = Date.now() - then;
  const m = Math.round(diffMs / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 14) return `${d}d ago`;
  return fmtDate(iso);
};

/* Task #99 (UI perf) — Memoize the History drawer. It only mounts when
   `historyOpen` is true (so the audit-log query is correctly lazy by
   construction) but once opened, scrolling / expanding individual entries
   triggers internal state changes that would otherwise re-render the entire
   parent page. With docNo + onClose stable from the parent (the parent's
   onClose is wrapped in useCallback below), shallow-compare prevents the
   parent-driven re-renders. */
const HistoryPanel = memo(({
  docNo,
  onClose,
}: {
  docNo: string;
  onClose: () => void;
}) => {
  const q = useSalesOrderAuditLog(docNo);
  const entries = q.data ?? [];
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  return (
    <>
      <div className={styles.historyBackdrop} onClick={onClose} />
      <aside className={styles.historyPanel} role="dialog" aria-label="Sales order history">
        <header className={styles.historyPanelHead}>
          <h3 className={styles.historyPanelTitle}>
            <History {...SM_ICON} />
            History · {docNo}
            <span style={{ marginLeft: 8, fontWeight: 400 }}>
              ({entries.length})
            </span>
          </h3>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X {...SM_ICON} />
          </Button>
        </header>
        <div className={styles.historyPanelBody}>
          {q.isLoading ? (
            <p className={styles.fieldLabel} style={{ padding: 'var(--space-3)' }}>Loading…</p>
          ) : entries.length === 0 ? (
            <p className={styles.muted} style={{ padding: 'var(--space-3)' }}>
              No history yet.
            </p>
          ) : (
            entries.map((e: SoAuditEntry) => {
              const name = e.actor_name_snapshot ?? '(unknown)';
              const hue = hashHue(name);
              const fc: SoAuditFieldChange[] = Array.isArray(e.field_changes) ? e.field_changes : [];
              const isExpanded = !!expanded[e.id];
              const label = ACTION_LABEL[e.action] ?? e.action.replace(/_/g, ' ').toLowerCase();
              const statusPillStatus = e.action === 'UPDATE_STATUS'
                ? (fc.find((f) => f.field === 'status')?.to as string | undefined)
                : null;
              return (
                <div key={e.id} className={styles.historyItem}>
                  <span
                    className={styles.historyAvatar}
                    style={{ background: `hsl(${hue}, 50%, 60%)` }}
                    aria-hidden
                  >
                    {initialsFor(name)}
                  </span>
                  <div>
                    <div className={styles.historyLine}>
                      <span className={styles.historyActor}>{name}</span>
                      {' performed '}
                      <strong>{label}</strong>
                      {statusPillStatus && (
                        <span
                          className={`${styles.statusPill} ${STATUS_CLASS[statusPillStatus as SoStatus] ?? ''}`}
                          style={{ marginLeft: 6, fontSize: 'var(--fs-10)' }}
                        >
                          {SO_STATUS_LABEL[statusPillStatus] ?? statusPillStatus.replace(/_/g, ' ')}
                        </span>
                      )}
                    </div>
                    <div className={styles.historyMeta}>
                      {fmtDateTime(e.created_at)}
                      {' · '}{relTime(e.created_at)}
                      {e.source ? ` · via ${e.source}` : ''}
                    </div>
                    {e.note && (
                      <div className={styles.historyMeta} style={HISTORY_NOTE_STYLE}>
                        “{e.note}”
                      </div>
                    )}
                    {fc.length > 0 && (
                      <>
                        <button
                          type="button"
                          className={styles.historyChangesBtn}
                          onClick={() => setExpanded((s) => ({ ...s, [e.id]: !s[e.id] }))}
                        >
                          {isExpanded ? <ChevronDown size={12} strokeWidth={1.75} /> : <ChevronRight size={12} strokeWidth={1.75} />}
                          {' '}Changes ({fc.length})
                        </button>
                        {isExpanded && (
                          <div className={styles.historyChanges}>
                            {fc.map((ch, idx) => (
                              <div key={idx} className={styles.historyChange}>
                                <span className={styles.historyChangeField}>
                                  {FIELD_LABEL[ch.field] ?? ch.field}
                                </span>
                                <span className={styles.historyChangeDiff}>
                                  {ch.from !== undefined && ch.from !== null && ch.from !== '' ? (
                                    <>
                                      <span className={styles.historyChangeFrom}>{fmtField(ch.field, ch.from)}</span>
                                      <span className={styles.historyChangeArrow}>→</span>
                                    </>
                                  ) : null}
                                  <span>{fmtField(ch.field, ch.to)}</span>
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </aside>
    </>
  );
});
HistoryPanel.displayName = 'HistoryPanel';
