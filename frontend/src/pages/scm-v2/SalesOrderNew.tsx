// ----------------------------------------------------------------------------
// SalesOrderNew — full-page Create SO at /scm/sales-orders/new.
//
// Task #105 — Commander 2026-05-27: "Edit SO 和 New SO 界面一定要一样的啊
// 为什么一直不一样 sales 怎么会习惯呢 payment 你只改了 edit SO 没有改 new SO".
// This page is now restructured to render the SAME 4 customer cards + the
// SAME Houzs PaymentsTable as SalesOrderDetail.tsx, so the Create flow and
// the Edit flow are visually identical (only the page title differs).
//
// Card order (matches Detail):
//   1. CUSTOMER         — Name * / Phone * / Email * / Customer Type /
//                         Salesperson / Customer SO Ref
//   2. ORDER INFO       — Building Type / Venue / Processing Date /
//                         Delivery Date (XOR validation) / Note
//   3. EMERGENCY        — Contact Name / Relationship / Phone
//   4. DELIVERY ADDRESS — "Fill in address later" affordance (New-SO only) /
//                         Address Line 1 / Address Line 2 / State / City /
//                         Postcode  (Sales Location is Detail-only)
//   5. LINE ITEMS       — SoLineCard list (already shared with Detail)
//   6. PAYMENTS         — <PaymentsTable docNo={null} /> draft mode. After
//                         POST /mfg-sales-orders succeeds, batch POST every
//                         draft to /:docNo/payments before navigating.
//
// ── HOUZS VENDOR ADAPTATIONS ───────────────────────────────────────────────
//   • react-router → react-router-dom.
//   • flow-queries hooks → the vendored sales-order-queries slice.
//   • The dead `supabase` import is dropped; flushPendingPhotos reads the
//     freshly-created SO back through the vendored authedFetch (→ /api/scm)
//     instead of a hand-rolled supabase token + VITE_API_URL fetch.
//   • Navigation repointed to /scm/sales-orders/*.
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Camera, ChevronDown, Plus, Save, X } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { PhoneInput } from '../../vendor/scm/components/PhoneInput';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import {
  useCreateMfgSalesOrder, useDebtorSearch, useAddSalesOrderPayment,
  useUploadSoItemPhoto, useMfgSalesOrderDetail,
  type DebtorSuggestion,
} from '../../vendor/scm/lib/sales-order-queries';
import { authedFetch, humanApiError } from '../../vendor/scm/lib/authed-fetch';
import { useStaff } from '../../vendor/scm/lib/admin-queries';
import { sortByText, sortByNumeric } from '../../vendor/scm/lib/sort-options';
import { useAuth } from '../../vendor/scm/lib/auth';
/* Houzs auth — the REAL logged-in user (name + id). The vendored 2990 auth
   bridge (useAuth above) has no staff row for the owner (id:null), which left
   Salesperson blank for anyone without a scm.staff row. We read the Houzs
   AuthUser to default + name the creator so the field is never blank. */
import { useAuth as useHouzsAuth } from '../../auth/AuthContext';
import { useVenues } from '../../vendor/scm/lib/venues-queries';
import {
  useLocalities, distinctStates, citiesInState, postcodesInCity,
  countryForState,
} from '../../vendor/scm/lib/localities-queries';
import {
  useSoDropdownOptions, optionsOrFallback,
} from '../../vendor/scm/lib/so-dropdown-options-queries';
import { useStateWarehouseMappings } from '../../vendor/scm/lib/state-warehouse-queries';
import { SoLineCard, emptySoLine, missingRequiredVariants, type SoLineDraft } from '../../vendor/scm/components/SoLineCard';
import {
  SCAN_PREFILL_KEY, type ScanPrefill, type ExtractedSlip,
} from '../../vendor/scm/components/ScanOrderModal';
import {
  PaymentsTable, labelToApi, draftMethodFields, newPaymentDraft, type PaymentDraft,
} from '../../vendor/scm/components/PaymentsTable';
import { formatPhone } from '@2990s/shared/phone';
import styles from './SalesOrderDetail.module.css';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

/* PR #114/#125 — Draft line shape mirrors SoLineDraft from SoLineCard but
   adds a stable React id so the local list can re-order / edit inline. */
type DraftLine = SoLineDraft & { rid: string };

/* PR-E — New lines inherit the SO header's delivery date by default.
   The header date isn't persisted until the SO is saved, so we seed the
   line client-side; once the SO exists, the server-side cascade in
   PATCH /:docNo takes over. */
const newLine = (deliveryDate: string | null = null): DraftLine => ({
  ...emptySoLine(),
  lineDeliveryDate: deliveryDate,
  lineDeliveryDateOverridden: false,
  rid: `l${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
});

const fmtRm = (centi: number, currency = 'MYR'): string =>
  `${currency} ${(centi / 100).toLocaleString('en-MY', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;

export const SalesOrderNew = () => {
  const navigate = useNavigate();
  const notify = useNotify();
  /* Copy-to-new-SO: ?copyFrom=<docNo> seeds this form from an existing SO
     (customer + line items only — dates, payments, customer SO ref, doc no
     and status are intentionally left blank so the operator starts fresh). */
  const [searchParams] = useSearchParams();
  const copyFromDocNo = searchParams.get('copyFrom');
  const copySource = useMfgSalesOrderDetail(copyFromDocNo);
  const create   = useCreateMfgSalesOrder();
  const addPayment = useAddSalesOrderPayment();
  const uploadPhoto = useUploadSoItemPhoto();
  const staffQ   = useStaff();
  const venuesQ  = useVenues();
  const loc      = useLocalities();
  /* Commander 2026-05-27: "他们都要有自己的account... 用自己的account开单
     都是自己的名字...salesperson 还是可以换 只是default跳出来 venue就不能换
     自动跳出来". The current logged-in staff drives:
       1. Default salesperson (admin/director can still pick another).
       2. The locked Venue (always derived from the picked salesperson's
          venue_id — non-admin roles also can't change the salesperson, so
          the venue is fully locked to their home venue). */
  const { staff: currentStaff } = useAuth();
  /* The REAL logged-in user (Houzs auth) — drives the never-blank Salesperson
     default. The 2990 bridge's currentStaff is null/role-only for a user with
     no scm.staff row (e.g. the owner), so we fall back to this for the name. */
  const { user: currentUser } = useHouzsAuth();
  /* Roles that may swap the salesperson on an SO they're entering on
     behalf of someone else. Everyone else gets a read-only salesperson
     pinned to themselves. */
  const canChangeSalesperson =
    currentStaff?.role === 'admin' ||
    currentStaff?.role === 'sales_director' ||
    currentStaff?.role === 'super_admin';

  /* Task #118 — these 3 dropdowns used to be `as const` arrays in this
     file. Now sourced from so_dropdown_options via TanStack. Each call
     falls back to the migration 0081 seed list during loading + when
     the DB row count is 0 so the user never sees an empty select. */
  const customerTypeOptsQ  = useSoDropdownOptions('customer_type');
  const buildingTypeOptsQ  = useSoDropdownOptions('building_type');
  const relationshipOptsQ  = useSoDropdownOptions('relationship');
  const customerTypeOpts = optionsOrFallback('customer_type', customerTypeOptsQ.data);
  const buildingTypeOpts = optionsOrFallback('building_type', buildingTypeOptsQ.data);
  const relationshipOpts = optionsOrFallback('relationship',  relationshipOptsQ.data);
  /* Commander 2026-05-27: Venue is no longer user-pickable on New SO —
     it's locked to the salesperson's staff.venue_id. The `venue`
     so_dropdown_options category remains for legacy back-compat but
     this page no longer reads it. */

  // ── Customer fields ────────────────────────────────────────────────
  const [debtorCode,    setDebtorCode]    = useState('');
  const [debtorName,    setDebtorName]    = useState('');
  const [phone,         setPhone]         = useState('');
  const [email,         setEmail]         = useState('');
  const [salespersonId, setSalespersonId] = useState('');
  const [customerType,  setCustomerType]  = useState<string>('');
  /* PR-A on Detail exposed Customer SO Ref inside the Customer card —
     mirror that here so the two pages line up. */
  const [customerSoNo,  setCustomerSoNo]  = useState('');

  /* Autofill rescue (Wei Siang 2026-06-03) — Chrome/Edge "paint" saved values
     into the Customer Name / Phone / Email inputs WITHOUT firing React's
     onChange, so state stays empty and the Create button is stuck disabled even
     though the fields look filled. Right after mount we read the inputs straight
     from the DOM and push any autofilled value into state (only when state is
     still empty, so we never clobber what the operator typed). Two delayed reads
     cover the browser's autofill timing. */
  const custGridRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const sync = () => {
      const root = custGridRef.current;
      if (!root) return;
      const nameEl  = root.querySelector('input[required]') as HTMLInputElement | null;
      const emailEl = root.querySelector('input[type="email"]') as HTMLInputElement | null;
      const phoneEl = root.querySelector('input[type="tel"]') as HTMLInputElement | null;
      if (nameEl?.value)  setDebtorName((prev) => prev || nameEl.value);
      if (emailEl?.value) setEmail((prev) => prev || emailEl.value);
      if (phoneEl?.value) setPhone((prev) => prev || phoneEl.value);
    };
    const t1 = setTimeout(sync, 250);
    const t2 = setTimeout(sync, 800);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []);

  // ── Order Info fields (Building Type / Venue / Dates / Note) ───────
  const [buildingType,   setBuildingType] = useState<string>('');
  /* PR #156 — Commander 2026-05-27: "开单的 venue 呢也没有". Detail page
     keeps Venue as a free-text field separate from Building Type — match
     that here so the two layouts line up.

     Commander 2026-05-27 follow-up: "venue就不能换 自动跳出来". The venue
     is now derived from the picked salesperson's staff.venue_id and is
     read-only. We keep the free-text `venue` column on the row for
     back-compat (we send the resolved venue name) and also send
     `venueId` (FK) so the API persists the master link. */
  const [processingDate, setProcessingDate] = useState('');
  const [deliveryDate,   setDeliveryDate]   = useState('');
  const [note,           setNote]           = useState('');

  // ── Delivery address ───────────────────────────────────────────────
  /* "Fill in address later" affordance: New-SO only (the address can be
     unknown at quote time). Detail doesn't need it because by the time
     someone is editing a saved SO, the address can be left blank without
     a special toggle. */
  const [fillAddressLater, setFillAddressLater] = useState(false);
  const [address1,    setAddress1]    = useState('');
  const [address2,    setAddress2]    = useState('');
  const [state,       setState]       = useState('');
  const [city,        setCity]        = useState('');
  const [postcode,    setPostcode]    = useState('');
  /* Commander 2026-05-27 (Fix 5) — Sales Location auto-derives from the
     state_warehouse_mappings entry for the picked state. Held in local
     state so the cascade effect can overwrite it whenever State changes
     while still allowing future manual override. */
  const [salesLocation, setSalesLocation] = useState('');

  // ── Emergency contact ──────────────────────────────────────────────
  const [emergencyName,  setEmergencyName]   = useState('');
  const [emergencyRel,   setEmergencyRel]    = useState<string>('');
  const [emergencyPhone, setEmergencyPhone]  = useState('');

  // ── Items state ────────────────────────────────────────────────────
  /* HOOKKA pattern — each line is an inline editable card. First card is
     seeded on mount so commander immediately sees the variant editor
     instead of needing to click "+ Add line item" first. */
  const [lines, setLines] = useState<DraftLine[]>(() => [newLine()]);

  /* ── Scan-Order review state (fromScan only) ───────────────────────────
     Task #73 — the OCR review now happens HERE, in the real form (no separate
     free-text modal). We carry the frozen AI-original slip + sampleId +
     salesperson so the SAVE can run the edit-gate learning POST, the
     AI-prefilled baseline (per field) so changed fields show the blue
     `.edited` diff, and per-line confidence so each line shows a
     "scanned · NN%" chip. Keyed by the line's rid (set during seed). */
  const [scanSampleId,    setScanSampleId]    = useState<string | null>(null);
  const [scanSalesperson, setScanSalesperson] = useState<string | null>(null);
  const [scanAiOriginal,  setScanAiOriginal]  = useState<ExtractedSlip | null>(null);
  /* AI-prefilled baseline for the blue diff — only the header fields the form
     exposes as editable inputs. A field whose current value differs from its
     baseline is marked `.edited`. Undefined entries = the scan didn't touch
     that field (so it never shows as edited). */
  type ScanBaseline = {
    debtorName?: string; address1?: string; note?: string;
    deliveryDate?: string; processingDate?: string;
    customerType?: string; buildingType?: string; venueId?: string;
    customerSoNo?: string; state?: string;
  };
  const [scanBaseline, setScanBaseline] = useState<ScanBaseline | null>(null);
  /* Per-line scan meta, keyed by the seeded line's rid: the verbatim slip row,
     the SKU Claude suggested, its confidence, and the itemCode the scan seeded
     (so the chip can tell a still-AI match from an operator override). */
  type ScanLineMeta = { rawText: string; suggestedCode: string; confidence: number; seededCode: string };
  const [scanLineMeta, setScanLineMeta] = useState<Record<string, ScanLineMeta>>({});
  /* Scanned city / postcode held until the localities cascade for the chosen
     state has options to match against — they only land in the dropdowns when
     they exist in the live my_localities list for that state (catalog-validated,
     never free-text into a dropdown). Cleared after a successful apply. */
  const [scanCity, setScanCity] = useState('');
  const [scanPostcode, setScanPostcode] = useState('');

  /* Copy-to-new-SO seed — runs once when the source SO finishes loading.
     Fills customer + address + emergency + line items. Deliberately omits
     processing/delivery dates, payments, customer SO ref, doc no and status
     so the new order is a clean draft. Guarded so it can't re-seed and stomp
     edits the operator has already made. */
  const [copySeeded, setCopySeeded] = useState(false);
  useEffect(() => {
    if (!copyFromDocNo || copySeeded) return;
    const h = copySource.data?.salesOrder;
    const srcItems = copySource.data?.items;
    if (!h) return;
    setDebtorCode(h.debtor_code ?? '');
    setDebtorName(h.debtor_name ?? '');
    setPhone(h.phone ?? '');
    setEmail(h.email ?? '');
    setSalespersonId(h.salesperson_id ?? '');
    setCustomerType(h.customer_type ?? '');
    setBuildingType(h.building_type ?? '');
    setNote(h.note ?? '');
    setAddress1(h.address1 ?? '');
    setAddress2(h.address2 ?? '');
    setState(h.customer_state ?? '');
    setCity(h.city ?? h.address3 ?? '');
    setPostcode(h.postcode ?? h.address4 ?? '');
    setEmergencyName(h.emergency_contact_name ?? '');
    setEmergencyRel(h.emergency_contact_relationship ?? '');
    setEmergencyPhone(h.emergency_contact_phone ?? '');
    if (Array.isArray(srcItems) && srcItems.length > 0) {
      setLines(srcItems.map((it: any) => ({
        ...newLine(),
        itemCode:       it.item_code ?? '',
        itemGroup:      it.item_group ?? 'others',
        description:    it.description ?? '',
        uom:            it.uom ?? 'UNIT',
        qty:            it.qty ?? 1,
        unitPriceCenti: it.unit_price_centi ?? 0,
        discountCenti:  it.discount_centi ?? 0,
        unitCostCenti:  it.unit_cost_centi ?? 0,
        variants:       (it.variants as Record<string, unknown>) ?? {},
        remark:         it.remark ?? '',
      })));
    }
    setCopySeeded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [copyFromDocNo, copySeeded, copySource.data]);

  /* Scan-Order prefill — ?fromScan=1 + sessionStorage handoff from
     ScanOrderModal ("Scan Order" on the SO list). Same one-shot seeding
     idea as copyFrom above, but via sessionStorage because the source is
     an OCR'd handwritten slip, not an existing SO. The key is consumed
     (removed) immediately so a refresh starts clean. Everything seeded
     here is a DRAFT the operator reviews — normal pricing/validation
     still runs on Save. */
  const fromScan = searchParams.get('fromScan') === '1';
  const [scanSeeded, setScanSeeded] = useState(false);
  /* Original-slip R2 key from the scan handoff — survives in state past the
     one-shot sessionStorage consume so it can ride onto the create body and
     become the SO's "Original Slip" proof. '' for a non-scan / PDF order. */
  const [scanSlipImageKey, setScanSlipImageKey] = useState('');
  /* Payment-receipt R2 key from the scan handoff — parallel to the slip key
     above; rides onto the create body to become the SO's "Payment Receipt"
     proof. '' when the scan carried no card-terminal receipt photo. */
  const [scanReceiptImageKey, setScanReceiptImageKey] = useState('');
  useEffect(() => {
    if (!fromScan || scanSeeded) return;
    setScanSeeded(true);
    let payload: ScanPrefill | null = null;
    try {
      payload = JSON.parse(sessionStorage.getItem(SCAN_PREFILL_KEY) ?? 'null') as ScanPrefill | null;
    } catch { payload = null; }
    sessionStorage.removeItem(SCAN_PREFILL_KEY);
    if (!payload) return;
    if (payload.slipImageKey) setScanSlipImageKey(payload.slipImageKey);
    if (payload.receiptImageKey) setScanReceiptImageKey(payload.receiptImageKey);
    if (payload.customerName) setDebtorName(payload.customerName);
    if (payload.phone) setPhone(payload.phone);
    if (payload.address1) setAddress1(payload.address1);
    /* Customer's own order reference (e.g. "HC14032") from the slip top-right. */
    if (payload.customerSoRef) setCustomerSoNo(payload.customerSoRef);
    /* Structured address → State / City / Postcode. State is a server-validated
       my_localities value; the city/postcode cascade depends on the chosen
       state, so they're applied by the locality-reconcile effect below once the
       localities list has loaded (setting them here directly would be cleared
       by the State onChange cascade). */
    if (payload.addressState) setState(payload.addressState);
    if (payload.addressCity) setScanCity(payload.addressCity);
    if (payload.addressPostcode) setScanPostcode(payload.addressPostcode);
    if (payload.note) setNote(payload.note);
    if (payload.deliveryDate) setDeliveryDate(payload.deliveryDate);
    /* Processing Date (Task #73, owner 2026-06-24) — a scanned slip is an order
       opened TODAY, so default Processing Date to today when the OCR didn't read
       a date off the slip. This frees the operator from the XOR trap ("Processing
       Date and Delivery Date must be set together — Save is blocked") that fired
       when Processing was left blank. Delivery Date stays optional — the operator
       sets it (and Processing ≤ Delivery is still enforced on Save). en-CA gives
       a local YYYY-MM-DD, matching the `today` used by the date inputs + guards. */
    setProcessingDate(payload.processingDate || new Date().toLocaleDateString('en-CA'));
    /* SO-Maintenance matches from the scan (2026-06-12) — both land in
       normal editable selects, same as a manual pick. */
    if (payload.customerType) setCustomerType(payload.customerType);
    if (payload.buildingType) setBuildingType(payload.buildingType);
    /* VENUE UNIFY (Task #73) — the modal resolved the OCR venue text to a REAL
       venue id from the same useVenues() master this form's Venue dropdown
       renders, so it seeds the dropdown with a valid selection (not free text).
       '' = no confident match → leave the salesperson-default venue alone. */
    if (payload.venueId) setPickedVenueId(payload.venueId);
    /* Matched payment → ONE draft row in the Payments table (visible,
       editable, deletable — flushed only on Create, and only when it
       carries an amount + slip like any manually-added draft). */
    if (payload.payment?.methodValue) {
      const p = payload.payment;
      /* Default the installment plan to 12 months when the matched method is a
         bank card / in-house Installment but no term rode in from the scan
         (owner rule: a bank EPP with no written month count = 12m). The
         modal already applies this default; we re-apply defensively so a
         stale prefill (e.g. older modal build) still seeds 12m. The value
         MUST match the installment_plan option VALUE ('12 months', mig 0022).
         A Merchant swipe with no EPP carries an empty installmentLabel and
         is left blank here. */
      const installmentLabel =
        p.installmentLabel ||
        (p.methodValue === 'Installment' ? '12 months' : '');
      setPaymentDrafts([{
        ...newPaymentDraft(),
        methodLabel:            p.methodValue,
        merchantProvider:       p.bankValue || '',
        installmentMonthsLabel: installmentLabel,
        onlineType:             p.onlineTypeValue || '',
        approvalCode:           p.approvalCode || '',
        amountCenti:            p.depositCenti > 0 ? p.depositCenti : 0,
      }]);
    }
    const lineMeta: Record<string, ScanLineMeta> = {};
    if (Array.isArray(payload.lines) && payload.lines.length > 0) {
      const dd = payload.deliveryDate ?? null;
      setLines(payload.lines.map((l) => {
        const seeded = newLine(dd);
        lineMeta[seeded.rid] = {
          rawText:       l.rawText ?? '',
          suggestedCode: l.suggestedCode ?? '',
          confidence:    l.confidence ?? 0,
          seededCode:    l.itemCode,
        };
        return {
          ...seeded,
          itemCode:       l.itemCode,
          itemGroup:      l.itemGroup || 'others',
          description:    l.description,
          qty:            l.qty > 0 ? l.qty : 1,
          unitPriceCenti: l.unitPriceCenti,
          remark:         l.remark,
        };
      }));
    }
    /* Stash the edit-gate carry-through + the blue-diff baseline + per-line
       confidence. The learning POST fires from onSave (below) only when the
       operator's final values differ from this AI-original snapshot. */
    setScanSampleId(payload.sampleId ?? null);
    setScanSalesperson(payload.salesperson ?? null);
    setScanAiOriginal(payload.aiOriginal ?? null);
    setScanLineMeta(lineMeta);
    setScanBaseline({
      debtorName:     payload.customerName || '',
      address1:       payload.address1 || '',
      note:           payload.note || '',
      deliveryDate:   payload.deliveryDate ?? '',
      /* Match the auto-seeded Processing Date (today when the OCR read none) so
         the blue `.edited` diff doesn't falsely flag a field the operator never
         touched. */
      processingDate: payload.processingDate || new Date().toLocaleDateString('en-CA'),
      customerType:   payload.customerType || '',
      buildingType:   payload.buildingType || '',
      venueId:        payload.venueId || '',
      customerSoNo:   payload.customerSoRef || '',
      state:          payload.addressState || '',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromScan, scanSeeded]);

  /* Blue-diff helper — a field whose current value differs from the
     AI-prefilled baseline gets the `.edited` class (only meaningful on a
     fromScan SO; null baseline → never edited). Compares the live value to
     the snapshot the scan seeded so the operator sees exactly what they
     changed from the AI's guess. */
  const editedClass = (key: keyof ScanBaseline, current: string): string => {
    if (!scanBaseline) return '';
    const base = scanBaseline[key];
    if (base === undefined) return '';
    return current !== base ? styles.edited : '';
  };

  // ── Payments draft state ───────────────────────────────────────────
  /* Task #105 — Same Houzs PaymentsTable used on Detail, but in DRAFT mode
     since the SO doesn't have a docNo yet. We hold the rows here, then
     batch POST them to /:docNo/payments after create succeeds. */
  const [paymentDrafts, setPaymentDrafts] = useState<PaymentDraft[]>([]);

  // ── Debtor autocomplete + warehouse lookup ─────────────────────────
  const debtors = useDebtorSearch(debtorName.trim().length >= 2 ? debtorName.trim() : '');
  const [showDebtorSuggest, setShowDebtorSuggest] = useState(false);
  const debtorSuggestions: DebtorSuggestion[] = (debtors.data?.debtors ?? []).filter(
    (d) => (d.debtor_name ?? '').toLowerCase() !== debtorName.trim().toLowerCase(),
  );
  const applyDebtorSuggestion = (d: DebtorSuggestion) => {
    setDebtorCode(d.debtor_code ?? '');
    setDebtorName(d.debtor_name ?? '');
    setPhone(d.phone ?? '');
    setAddress1(d.address1 ?? '');
    setAddress2(d.address2 ?? '');
    setCity(d.address3 ?? '');
    setPostcode(d.address4 ?? '');
    setShowDebtorSuggest(false);
  };

  const updateLine = (rid: string, patch: Partial<SoLineDraft>) =>
    setLines((prev) => {
      const target = prev.find((l) => l.rid === rid);
      /* Loo 2026-06-09 — sofa remark auto-fills every compartment. A POS sofa
         is split into one line per compartment, all sharing variants.buildKey.
         When the operator types a remark on any one compartment, mirror it onto
         the other compartments of the SAME sofa so every piece carries the note.
         Scoped by buildKey, so a second, different sofa keeps its own remark.
         Only sofas that came in as a split build have a buildKey — manually
         added stand-alone lines have none and never cascade. */
      const bk =
        target && 'remark' in patch
          ? (target.variants as { buildKey?: unknown } | null)?.buildKey
          : undefined;
      const cascadeRemark = typeof bk === 'string' && bk !== '';
      return prev.map((l) => {
        if (l.rid === rid) return { ...l, ...patch };
        if (
          cascadeRemark &&
          (l.variants as { buildKey?: unknown } | null)?.buildKey === bk
        ) {
          return { ...l, remark: patch.remark as string };
        }
        return l;
      });
    });

  /* PR-E — New lines seed their lineDeliveryDate from the current header
     deliveryDate (null until the user fills it in). The cascade effect
     below keeps non-overridden lines in sync with subsequent header
     changes. */
  const addLine  = () => setLines((prev) => [...prev, newLine(deliveryDate || null)]);
  const dropLine = (rid: string) => setLines((prev) => prev.filter((l) => l.rid !== rid));

  /* PR-E — Client-side master-follower cascade for delivery date. Mirrors
     the server-side cascade in PATCH /mfg-sales-orders/:docNo. */
  useEffect(() => {
    setLines((prev) => {
      let didUpdate = false;
      const target = deliveryDate || null;
      const next = prev.map((l) => {
        if (l.lineDeliveryDateOverridden) return l;
        if ((l.lineDeliveryDate ?? null) === target) return l;
        didUpdate = true;
        return { ...l, lineDeliveryDate: target };
      });
      return didUpdate ? next : prev;
    });
  }, [deliveryDate]);

  /* PR #142 / #145 / #147 — Master-follower cascade for line variants.
     LINE 1 of each category drives variant changes on subsequent lines,
     unless a follower has manually overridden a key. */
  useEffect(() => {
    const masterByCategory: Record<string, Record<string, unknown>> = {};
    const masterIdx: Record<string, number> = {};
    lines.forEach((l, idx) => {
      if (!l.itemGroup) return;
      if (masterIdx[l.itemGroup] !== undefined) return;
      masterIdx[l.itemGroup] = idx;
      if (l.variants) masterByCategory[l.itemGroup] = l.variants;
    });

    let didUpdate = false;
    const next = lines.map((l, idx) => {
      if (!l.itemGroup) return l;
      if (masterIdx[l.itemGroup] === idx) return l;
      const masterVariants = masterByCategory[l.itemGroup];
      if (!masterVariants) return l;
      const cur = (l.variants ?? {}) as Record<string, unknown>;
      const overridden = new Set(l.overriddenKeys ?? []);
      const patch: Record<string, unknown> = {};
      let hasChange = false;
      for (const k of Object.keys(masterVariants)) {
        if (overridden.has(k)) continue;
        const masterVal = masterVariants[k];
        if (masterVal === undefined || masterVal === null || masterVal === '') continue;
        if (cur[k] !== masterVal) {
          patch[k] = masterVal;
          hasChange = true;
        }
      }
      if (!hasChange) return l;
      didUpdate = true;
      return { ...l, variants: { ...cur, ...patch } };
    });
    if (didUpdate) setLines(next);
  }, [lines]);

  const subtotalCenti = useMemo(
    () => lines.reduce(
      (s, l) => s + Math.max(0, l.qty * l.unitPriceCenti - l.discountCenti),
      0,
    ),
    [lines],
  );

  /* PR #141 — Per-category variants captured from the FIRST line of that
     category that has any variants set. */
  const inheritVariantsByCategory = useMemo(() => {
    const out: Record<string, Record<string, unknown>> = {};
    for (const l of lines) {
      const cat = l.itemGroup;
      if (!cat || out[cat]) continue;
      if (l.variants && Object.keys(l.variants).length > 0) {
        out[cat] = l.variants;
      }
    }
    return out;
  }, [lines]);

  // ── Locality cascades ──────────────────────────────────────────────
  const locRows = useMemo(() => loc.data ?? [], [loc.data]);
  const states  = useMemo(() => distinctStates(locRows), [locRows]);
  const cities  = useMemo(() => state ? citiesInState(locRows, state) : [], [locRows, state]);
  const postcodes = useMemo(
    () => (state && city) ? postcodesInCity(locRows, state, city) : [],
    [locRows, state, city],
  );

  /* Scan address reconcile (fromScan only) — once the locality cascade for the
     scanned State has options, snap the scanned City to a REAL my_localities
     city for that state (case-insensitive), then snap the scanned Postcode to a
     real postcode for that city. Catalog-validated: a city/postcode the live
     localities list doesn't contain is dropped (never free-typed into a
     dropdown). Each holder is cleared once consumed so a later manual edit
     isn't clobbered. */
  useEffect(() => {
    if (!scanCity || !state || cities.length === 0) return;
    const hit = cities.find((cc) => cc.toLowerCase() === scanCity.trim().toLowerCase());
    if (hit) setCity((prev) => prev || hit);
    setScanCity('');
  }, [scanCity, state, cities]);
  useEffect(() => {
    if (!scanPostcode || !state || !city || postcodes.length === 0) return;
    const want = scanPostcode.trim();
    const hit = postcodes.find((p) => p === want);
    if (hit) setPostcode((prev) => prev || hit);
    setScanPostcode('');
  }, [scanPostcode, state, city, postcodes]);

  /* Commander 2026-05-27 (Fix 5) — State → Sales Location cascade. Same
     rule as Edit SO: pick a state, the Sales Location auto-fills with the
     warehouse code from state_warehouse_mappings. No-op when the state has
     no mapping (commander needs to wire it up in Maintenance first). */
  const stateWarehousesQ = useStateWarehouseMappings();
  useEffect(() => {
    if (!state) return;
    const list = stateWarehousesQ.data?.mappings ?? [];
    if (list.length === 0) return;
    const hit = list.find((m) => m.state === state);
    const code = hit?.warehouse?.code ?? null;
    if (!code) return;
    if (salesLocation === code) return;
    setSalesLocation(code);
  }, [state, stateWarehousesQ.data, salesLocation]);
  /* Task #121 — country derives from the picked state. Display-only on the
     SO form; the API re-derives + snapshots it on POST/PATCH. Falls back
     to 'Malaysia' when no state is picked yet so the field doesn't sit
     visibly blank before the cascade fires. */
  const country = useMemo(
    () => (state ? countryForState(locRows, state) : null) ?? 'Malaysia',
    [locRows, state],
  );

  // ── Salesperson + Venue resolution ─────────────────────────────────
  /* Commander 2026-05-27: default Salesperson to the current user; the
     Venue is then resolved from that staff row's venue_id and locked. */
  const staffList = useMemo(
    () => (staffQ.data ?? []).filter((s) => s.active),
    [staffQ.data],
  );

  /* Owner 2026-06-23 — the Salesperson must NEVER be blank for whoever creates
     the order: the creator IS the salesperson. The 2990 bridge only knew the
     creator when they had a scm.staff row, so a user without one (the owner)
     got "Pick staff". We now resolve the creator from the staff list FIRST
     (by id, then email, then name) so a real staff user keeps their canonical
     id; when no staff row matches we synthesize a UI-only "self" option from
     the Houzs auth user so their NAME is always selectable + shown. */
  const SELF_SALESPERSON = '__self__';
  const selfStaffMatch = useMemo(() => {
    const byId = currentStaff?.id
      ? staffList.find((s) => s.id === currentStaff.id)
      : undefined;
    if (byId) return byId;
    const email = (currentUser?.email ?? '').trim().toLowerCase();
    const byEmail = email
      ? staffList.find((s) => (s.email ?? '').trim().toLowerCase() === email)
      : undefined;
    if (byEmail) return byEmail;
    const name = (currentUser?.name ?? currentStaff?.name ?? '').trim().toLowerCase();
    return name
      ? staffList.find((s) => (s.name ?? '').trim().toLowerCase() === name)
      : undefined;
  }, [staffList, currentStaff?.id, currentStaff?.name, currentUser?.email, currentUser?.name]);

  /* The creator's display name for the synthesized self-option (only used when
     selfStaffMatch is undefined — i.e. they have no scm.staff row). */
  const selfDisplayName =
    (currentUser?.name ?? '').trim() ||
    (currentStaff?.name ?? '').trim() ||
    (currentUser?.email ?? '').trim() ||
    'Me';

  /* Seed salespersonId to the creator once auth/staff resolve. A real staff
     row seeds its canonical id; a creator with NO staff row seeds the
     SELF_SALESPERSON sentinel so the field shows their name (never blank).
     Only seeds when the user hasn't already picked someone (don't stomp an
     admin's manual choice on re-render). */
  useEffect(() => {
    if (selfStaffMatch) {
      setSalespersonId((prev) => prev || selfStaffMatch.id);
    } else if (selfDisplayName) {
      setSalespersonId((prev) => prev || SELF_SALESPERSON);
    }
  }, [selfStaffMatch, selfDisplayName]);

  /* Derive the resolved venue from whichever salesperson is currently
     picked. Falls back to the auth user's own venue_id if the staff list
     hasn't loaded yet — which is the common case on first paint. */
  const selectedStaff = useMemo(
    () => staffList.find((s) => s.id === salespersonId) ?? null,
    [staffList, salespersonId],
  );
  const resolvedVenueId: string | null =
    selectedStaff?.venueId ?? currentStaff?.venueId ?? null;
  const resolvedVenueName: string = useMemo(() => {
    if (!resolvedVenueId) return '';
    const v = (venuesQ.data ?? []).find((r) => r.id === resolvedVenueId);
    return v?.name ?? '';
  }, [resolvedVenueId, venuesQ.data]);

  /* Houzs 2026-06-22 (owner: "houzs 的 venue 是 manually 選的") — unlike 2990,
     where Commander locked Venue to the salesperson's home venue, Houzs picks
     Venue manually. Defaults to the salesperson's venue but stays changeable. */
  const [pickedVenueId, setPickedVenueId] = useState<string | null>(null);
  const effectiveVenueId = pickedVenueId ?? resolvedVenueId;
  const effectiveVenueName: string = useMemo(() => {
    if (!effectiveVenueId) return '';
    return (venuesQ.data ?? []).find((r) => r.id === effectiveVenueId)?.name ?? '';
  }, [effectiveVenueId, venuesQ.data]);

  /* Phone is compulsory on every SO; name too. We no longer pre-disable the Save
     button on these — onSave validates and tells the operator exactly what's
     missing (a silently-greyed button left them guessing). The server also
     enforces phone (400 phone_required). */

  /* Mirror Detail's XOR rule (PR #156): Processing Date and Delivery Date
     must both be filled in or both empty. */
  const datesXor = (processingDate.trim() !== '') !== (deliveryDate.trim() !== '');
  /* Commander 2026-05-28 — Processing/Delivery dates may only be today or a
     future date (input min + Save guard). en-CA = local YYYY-MM-DD. */
  const today = new Date().toLocaleDateString('en-CA');

  /* Task #105 — After POST /mfg-sales-orders succeeds, replay every payment
     draft through POST /:docNo/payments in parallel via the existing mutation
     hook (useAddSalesOrderPayment.mutateAsync). Failures don't roll the SO
     back (the SO is already created), but we surface them so commander can
     re-enter the affected rows on the Detail page. */
  /* Line-card-redesign (Commander 2026-05-27) — Photos can now be staged
     on a brand-new line BEFORE the SO is saved. The SoLineCard component
     stages them as File objects on `draft.pendingPhotoFiles`. After
     POST /mfg-sales-orders succeeds we GET /:docNo to read back the saved
     item IDs, match each saved item to a draft line by index, then upload
     every staged File via the existing per-item /photos endpoint.

     Item ordering: the API inserts items in the order we send them and
     returns them ordered by created_at, so positional matching is safe.
     If the counts ever drift (server-side filtering of bad rows, etc.)
     we surface a soft warning and skip the mismatched lines rather than
     guess. The SO is already created so we don't roll back. */
  const flushPendingPhotos = async (
    docNo: string,
    draftLines: DraftLine[],
  ): Promise<{ failed: number; skipped: number }> => {
    const linesWithPending = draftLines.filter(
      (l) => (l.pendingPhotoFiles?.length ?? 0) > 0,
    );
    if (linesWithPending.length === 0) return { failed: 0, skipped: 0 };

    // HOUZS VENDOR — read the saved item IDs back through the vendored
    // authedFetch (→ /api/scm/mfg-sales-orders/:docNo), bypassing the
    // TanStack cache (the freshly-created detail may not be cached yet).
    let savedItems: Array<{ id: string; item_code: string }> = [];
    try {
      const body = await authedFetch<{ items: Array<{ id: string; item_code: string }> }>(
        `/mfg-sales-orders/${docNo}`,
      );
      savedItems = body.items ?? [];
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[so-line-photos] could not load saved item IDs:', e);
      void humanApiError;
      return { failed: linesWithPending.length, skipped: 0 };
    }

    /* Positional match — `validLines` is the same slice we sent to
       POST /mfg-sales-orders so `savedItems[i]` corresponds to
       `validLines[i]`. We only iterate over validLines so cancelled
       drafts (no itemCode) are skipped without breaking the index. */
    const validLines = draftLines.filter((l) => l.itemCode.trim() && l.qty > 0);
    let failed = 0;
    let skipped = 0;
    for (let i = 0; i < validLines.length; i++) {
      const line = validLines[i]!;
      const files = line.pendingPhotoFiles ?? [];
      if (files.length === 0) continue;
      const saved = savedItems[i];
      if (!saved || saved.item_code !== line.itemCode) {
        // Mismatch — log + skip rather than upload to the wrong line.
        // eslint-disable-next-line no-console
        console.warn('[so-line-photos] index/item_code mismatch — skipping pending uploads', {
          index: i, expected: line.itemCode, got: saved?.item_code,
        });
        skipped += files.length;
        continue;
      }
      for (const f of files) {
        try {
          await uploadPhoto.mutateAsync({ docNo, itemId: saved.id, file: f });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[so-line-photos] upload failed', { file: f.name, err });
          failed++;
        }
      }
    }
    return { failed, skipped };
  };

  const flushPaymentDrafts = async (docNo: string): Promise<{ failed: number }> => {
    if (paymentDrafts.length === 0) return { failed: 0 };
    const tasks = paymentDrafts
      .filter((d) => d.amountCenti > 0)
      .map(async (d) => {
        const { method } = labelToApi(d.methodLabel);
        const body: { docNo: string } & Record<string, unknown> = {
          docNo,
          paidAt:          d.paidAt,
          method,
          amountCenti:     d.amountCenti,
          accountSheet:    d.accountSheet || null,
          approvalCode:    d.approvalCode || null,
          collectedBy:     d.collectedBy  || null,
          /* Spec D4 — the SO payments route requires a slip; the onSave gate
             below guarantees every amount-bearing draft carries one. */
          uploadSessionId: d.slipUploadSessionId,
        };
        /* Task #122 (cascade) — replay the L2 picks per method so the
           created payment row carries the bank + plan / sub-type that
           commander entered during the draft. */
        Object.assign(body, draftMethodFields(method, d));
        try {
          await addPayment.mutateAsync(body);
          return true;
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error('[payment] post failed for new SO:', e);
          return false;
        }
      });
    const results = await Promise.all(tasks);
    return { failed: results.filter((ok) => !ok).length };
  };

  /* ── Edit-gate learning (fromScan only) ────────────────────────────────
     Task #73 — the OCR review now happens in THIS form, so the learning POST
     that used to fire from the modal fires HERE, on save. We rebuild the
     operator's FINAL values into the ExtractedSlip shape and compare against
     the frozen AI-original; if anything changed, POST
     /scan-so/samples/:id/confirm so the correction becomes a few-shot example
     + re-distills the rep's rules. Fire-and-forget — it never blocks or fails
     the save.

     The corrected blob mirrors the extracted-slip shape the distiller pairs
     against the AI-original (customer block, option matches, per-line
     rawText→code). Only the fields the form actually exposes are reconciled;
     everything else is carried straight from the AI-original so the diff is
     limited to what the operator genuinely touched. */
  const maybeLearnFromScan = (validLines: DraftLine[]) => {
    if (!fromScan || !scanSampleId || !scanAiOriginal) return;
    const ai = scanAiOriginal;

    const optMatch = (v: string) =>
      v ? { value: v, confidence: 1, reason: 'operator-confirmed' } : null;
    const phones = phone.trim() ? [phone.trim()] : ai.phones;
    const norm = (s: string | null | undefined) => (s ?? '').trim();

    /* Edit-gate — only learn when the operator GENUINELY corrected something.
       Compare the operator's final values against the AI's on the dimensions
       that actually teach the OCR: customer block, the option matches, and
       per-line SKU/qty/price. (The form reshapes the slip, so a structural
       stringify diff would always "differ" — we compare field-by-field.) */
    let changed = false;
    const mark = (a: string, b: string) => { if (a !== b) changed = true; };
    mark(norm(debtorName), norm(ai.customerName));
    mark(norm(address1), norm(ai.addressLine1 ?? ai.address));
    mark(norm(state), norm(ai.addressStateMatch?.value));
    mark(norm(city), norm(ai.city));
    mark(norm(postcode), norm(ai.postcode));
    mark(norm(customerSoNo), norm(ai.customerSoRef));
    mark(norm(customerType), norm(ai.customerTypeMatch?.value));
    mark(norm(buildingType), norm(ai.buildingTypeMatch?.value));
    mark(norm(paymentDrafts[0]?.methodLabel), norm(ai.paymentMethodMatch?.value));
    mark(norm(paymentDrafts[0]?.merchantProvider), norm(ai.bankMatch?.value));
    mark(norm(paymentDrafts[0]?.onlineType), norm(ai.onlineTypeMatch?.value));
    mark(norm(paymentDrafts[0]?.installmentMonthsLabel), norm(ai.installmentPlanMatch?.value));
    // Line count differing (operator added/removed a row) is itself a correction.
    if (validLines.length !== ai.lines.length) changed = true;
    for (const l of validLines) {
      const meta = scanLineMeta[l.rid];
      // A line with no scan meta was added by the operator → a correction.
      if (!meta) { changed = true; continue; }
      if (l.itemCode !== meta.seededCode) changed = true;
    }

    if (!changed) return;

    const corrected: ExtractedSlip = {
      customerName: debtorName.trim() || null,
      address: address1.trim() || null,
      /* Operator-final structured address — the form's State is a real
         my_localities value, so it's a confirmed addressStateMatch; city /
         postcode are the dropdown-validated picks. */
      addressLine1: address1.trim() || null,
      city: city.trim() || null,
      postcode: postcode.trim() || null,
      addressStateMatch: optMatch(state),
      phones,
      location: ai.location,
      deliveryDate: deliveryDate || ai.deliveryDate,
      processingDate: processingDate || ai.processingDate,
      salesRep: scanSalesperson || ai.salesRep,
      customerSoRef: customerSoNo.trim() || ai.customerSoRef,
      paymentMethod: ai.paymentMethod,
      depositRm: ai.depositRm,
      totalRm: ai.totalRm,
      remarks: ai.remarks,
      approvalCode: ai.approvalCode,
      /* Operator-confirmed option picks win; the form's selects are the
         dropdown-validated source of truth now. */
      paymentMethodMatch:   optMatch(paymentDrafts[0]?.methodLabel ?? '') ?? ai.paymentMethodMatch,
      bankMatch:            optMatch(paymentDrafts[0]?.merchantProvider ?? '') ?? ai.bankMatch,
      onlineTypeMatch:      optMatch(paymentDrafts[0]?.onlineType ?? '') ?? ai.onlineTypeMatch,
      installmentPlanMatch: optMatch(paymentDrafts[0]?.installmentMonthsLabel ?? '') ?? ai.installmentPlanMatch,
      customerTypeMatch:    optMatch(customerType),
      buildingTypeMatch:    optMatch(buildingType),
      locationMatch:        ai.locationMatch,
      /* Per-line correction — pair the slip's verbatim rawText (carried from
         the scan) with the operator's FINAL itemCode/qty/price so the
         distiller learns this rep's handwriting → catalog mapping. */
      lines: validLines.map((l) => {
        const meta = scanLineMeta[l.rid];
        const rawText = meta?.rawText ?? l.remark;
        const codeChanged = !meta || l.itemCode !== meta.seededCode;
        return {
          rawText,
          qtyGuess: l.qty,
          priceRmGuess: l.unitPriceCenti > 0 ? l.unitPriceCenti / 100 : null,
          skuMatch: l.itemCode
            ? {
                code: l.itemCode,
                confidence: codeChanged ? 1 : (meta?.confidence ?? 1),
                reason: codeChanged ? 'operator-picked' : 'operator-confirmed',
              }
            : null,
          fabricMatch: null,
          notes: null,
        };
      }),
    };

    void authedFetch(`/scan-so/samples/${scanSampleId}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ corrected, salesperson: scanSalesperson || null }),
    }).catch(() => { /* few-shot learning is best-effort — never blocks save */ });
  };

  /* DRAFT flow — `asDraft` adds `asDraft: true` to the create body so the SO
     lands as DRAFT (excluded from KPI/MRP/PO/DO until Confirmed on Detail).
     The two header buttons both call onSave; only the flag differs. When the
     form was opened from a scan (fromScan), "Save as Draft" is the primary
     button so scanned orders default to draft for operator review. */
  const onSave = (asDraft = false) => {
    if (!debtorName.trim()) {
      notify({ title: 'Customer name is required.', tone: 'error' });
      return;
    }
    if (!phone.trim()) {
      notify({
        title: 'Phone number is required',
        body: 'every sales order must have a contact number.',
        tone: 'error',
      });
      return;
    }
    if (datesXor) {
      notify({
        title: 'Processing Date and Delivery Date must be set together.',
        body:
          'Either fill in BOTH dates, or leave BOTH empty — partial dates ' +
          'cause scheduling issues.',
        tone: 'error',
      });
      return;
    }
    // Commander 2026-05-28 — Processing/Delivery date must be today or future.
    if (processingDate && processingDate < today) {
      notify({ title: 'Processing Date cannot be in the past — pick today or a future date.', tone: 'error' });
      return;
    }
    if (deliveryDate && deliveryDate < today) {
      notify({ title: 'Delivery Date cannot be in the past — pick today or a future date.', tone: 'error' });
      return;
    }
    // Owner 2026-06-03 — Process Date is the factory start; it cannot fall after
    // the Delivery Date.
    if (processingDate && deliveryDate && processingDate > deliveryDate) {
      notify({ title: 'Processing Date cannot be later than the Delivery Date.', tone: 'error' });
      return;
    }
    const validLines = lines.filter((l) => l.itemCode.trim() && l.qty > 0);
    if (validLines.length === 0) {
      notify({ title: 'Add at least one item via "+ Add Line Item".', tone: 'error' });
      return;
    }
    /* Scan-Order core rule (Task #73) — a NO-MATCH scanned line seeds an empty
       SKU picker the operator MUST fill from the dropdown ("应该是 dropdown 而
       不是 manually 填写"). Block the save while any scanned line is still
       unpicked (it carries the slip rawText but no itemCode) rather than
       silently dropping it, so the operator is forced to pick a real SKU. */
    const unpickedScanned = lines.filter((l) => !l.itemCode.trim() && (scanLineMeta[l.rid]?.rawText ?? '').trim() !== '');
    if (unpickedScanned.length > 0) {
      notify({
        title: 'Pick a SKU for every scanned line.',
        body:
          `${unpickedScanned.length} scanned line${unpickedScanned.length === 1 ? '' : 's'} ` +
          `${unpickedScanned.length === 1 ? "doesn't" : "don't"} have a product picked yet. ` +
          'Pick a real SKU from the dropdown (the slip text is shown as a hint) or remove the line, then try again.',
        tone: 'error',
      });
      return;
    }
    // Variants are only mandatory once a processing date is set: with a date,
    // the order is committed to production and purchasing needs a full spec.
    // No processing date = still a draft, so allow saving with gaps.
    if (processingDate) {
      const variantGaps = validLines
        .map((l) => ({ code: l.itemCode, miss: missingRequiredVariants(l.itemGroup, l.variants) }))
        .filter((x) => x.miss.length > 0);
      if (variantGaps.length > 0) {
        notify({
          title: 'Complete all variant selections before saving:',
          body: variantGaps.map((x) => `• ${x.code}: ${x.miss.join(', ')}`).join('\n'),
          tone: 'error',
        });
        return;
      }
    }

    /* Spec D4 — every SO payment must carry its own slip. The SO payments
       route (POST /:docNo/payments) 400s a slip-less payment, so gate the
       create here: any amount-bearing draft without a confirmed slip blocks
       the save and tells commander which rows to fix. */
    const slipless = paymentDrafts.filter((d) => d.amountCenti > 0 && !d.slipUploadSessionId);
    if (slipless.length > 0) {
      notify({
        title: 'Each payment needs a slip uploaded before saving.',
        body:
          `${slipless.length} payment row${slipless.length === 1 ? '' : 's'} ` +
          `${slipless.length === 1 ? 'is' : 'are'} missing a slip — upload ` +
          `${slipless.length === 1 ? 'it' : 'them'} (the "Slip *" button) and try again.`,
        tone: 'error',
      });
      return;
    }

    /* Edit-gate — operator committed to saving, so fold their corrections back
       into the few-shot pool (fire-and-forget, fromScan only). */
    maybeLearnFromScan(validLines);

    create.mutate(
      {
        /* DRAFT flow — backend reads `asDraft: true` to create the SO with
           status 'DRAFT' instead of 'CONFIRMED'. Omitted (undefined) for a
           normal Create so the body stays unchanged in that path. */
        asDraft: asDraft || undefined,
        debtorName,
        debtorCode: debtorCode || undefined,
        phone: phone || undefined,
        email: email || undefined,
        /* The SELF_SALESPERSON sentinel is a UI-only placeholder for a creator
           with no scm.staff row — never send it as an id (it isn't one). A real
           staff id submits normally; the sentinel is omitted so the backend
           keeps its own caller-based resolution rather than choking on a fake
           id. */
        salespersonId:
          salespersonId && salespersonId !== SELF_SALESPERSON ? salespersonId : undefined,
        customerType: customerType || undefined,
        customerSoNo: customerSoNo || undefined,
        /* Commander 2026-05-27: Venue is locked to the picked salesperson's
           home venue. Send the FK so the API persists `venue_id`; we also
           send the resolved name as the legacy free-text `venue` column
           for back-compat with reports / PDFs that still read it. */
        venueId: effectiveVenueId ?? undefined,
        venue: effectiveVenueName || undefined,
        /* Address handling: address1/2 skipped when fill-later is on, but
           State/City/Postcode/BuildingType always submit. */
        address1: fillAddressLater ? undefined : (address1 || undefined),
        address2: fillAddressLater ? undefined : (address2 || undefined),
        customerState: state || undefined,
        city: city || undefined,
        postcode: postcode || undefined,
        /* Commander 2026-05-27 (Fix 5) — auto-resolved from State via
           state_warehouse_mappings; persisted so reports + dispatch flows
           see it without a separate edit. */
        salesLocation: salesLocation || undefined,
        buildingType: buildingType || undefined,
        emergencyContactName:         emergencyName  || undefined,
        emergencyContactRelationship: emergencyRel   || undefined,
        emergencyContactPhone:        emergencyPhone || undefined,
        /* PR #121 — Processing Date → internal_expected_dd, Delivery Date →
           customer_delivery_date. */
        internalExpectedDd:   processingDate || undefined,
        customerDeliveryDate: deliveryDate   || undefined,
        note: note || undefined,
        /* Original-slip provenance — the scanned slip's R2 key (from the Scan
           Order handoff) so the SO detail page can show it as proof. */
        slipImageKey: scanSlipImageKey || undefined,
        /* Payment-receipt provenance — the scanned card-terminal receipt's R2
           key (from the Scan Order handoff) so the SO detail page can show it
           as "Payment Receipt" proof alongside the order slip. */
        receiptImageKey: scanReceiptImageKey || undefined,
        /* PR #114 — full variant payload preserved end-to-end. */
        items: validLines.map((l) => ({
          itemGroup:      l.itemGroup,
          itemCode:       l.itemCode,
          description:    l.description,
          uom:            l.uom,
          qty:            l.qty,
          unitPriceCenti: l.unitPriceCenti,
          discountCenti:  l.discountCenti,
          unitCostCenti:  l.unitCostCenti,
          variants:       l.variants,
          remark:         l.remark,
          /* PR-E — per-item delivery date + cascade override flag. */
          lineDeliveryDate:           l.lineDeliveryDate ?? null,
          lineDeliveryDateOverridden: l.lineDeliveryDateOverridden ?? false,
        })),
      },
      {
        onSuccess: async (res: { docNo: string }) => {
          /* Task #105 — Fire the queued payment drafts as follow-up POSTs.
             We don't gate navigation on success — if a payment fails the
             SO still exists, so we navigate to the Detail page where
             commander can re-enter the affected row. */
          const { failed } = await flushPaymentDrafts(res.docNo);
          /* Line-card-redesign — Drain pendingPhotoFiles for every line
             after the SO + items exist. Same non-blocking pattern as
             payments: a photo failure leaves the SO intact and we
             surface a warning rather than rolling back. */
          const { failed: photoFailed, skipped: photoSkipped } =
            await flushPendingPhotos(res.docNo, validLines);
          if (failed > 0) {
            await notify({
              title: `Sales order ${res.docNo} was created, but ${failed} ` +
                `payment row${failed === 1 ? '' : 's'} failed to save.`,
              body: `Please re-enter ${failed === 1 ? 'it' : 'them'} on the Detail page.`,
              tone: 'error',
            });
          }
          if (photoFailed > 0 || photoSkipped > 0) {
            await notify({
              title: `Sales order ${res.docNo} was created, but ${photoFailed + photoSkipped} ` +
                `staged photo${(photoFailed + photoSkipped) === 1 ? '' : 's'} could not be uploaded.`,
              body: 'Please re-attach on the Detail page.',
              tone: 'error',
            });
          }
          navigate(`/scm/sales-orders/${res.docNo}`);
        },
        onError:   (err) => notify({ title: 'Save failed', body: err instanceof Error ? err.message : String(err), tone: 'error' }),
      },
    );
  };

  return (
    <div className={styles.page}>
      {/* Top bar */}
      <div className={styles.headerRow}>
        <div className={styles.titleBlock}>
          <Link to="/scm/sales-orders" className={styles.backBtn}>
            <ArrowLeft {...ICON} /> <span>Sales Orders</span>
          </Link>
          <h1 className={styles.title}>New Sales Order</h1>
        </div>
        <div className={styles.actions}>
          <Button variant="ghost" size="md" onClick={() => navigate('/scm/sales-orders')}>
            <X {...ICON} /> Cancel
          </Button>
          {/* DRAFT flow — two create actions. Both run the SAME create + the
              same post-create payment/photo flush + navigation; only the
              `asDraft` flag differs. From a scan handoff (fromScan) the
              scanned order should default to DRAFT for operator review, so
              "Save as Draft" is the PRIMARY button and "Create" the secondary
              one. For a normal New SO, "Create" stays primary. The buttons stay
              CLICKABLE even when fields are missing (only blocked while a save
              is in flight) — onSave validates and tells the operator EXACTLY
              what's missing. (Wei Siang 2026-06-03) */}
          <Button
            variant={fromScan ? 'secondary' : 'primary'} size="md"
            onClick={() => onSave(false)}
            disabled={create.isPending}
          >
            <Save {...ICON} />
            {create.isPending ? 'Saving…' : 'Create Sales Order'}
          </Button>
          <Button
            variant={fromScan ? 'primary' : 'secondary'} size="md"
            onClick={() => onSave(true)}
            disabled={create.isPending}
          >
            <Save {...ICON} />
            {create.isPending ? 'Saving…' : 'Save as Draft'}
          </Button>
        </div>
      </div>

      {/* ── SCAN BANNER (fromScan only) ───────────────────────────────
          Task #73 — the OCR review happens in THIS form now. Tell the operator
          to check every dropdown-bound field before saving. Changed fields show
          a blue highlight; each scanned line shows a "scanned · NN%" chip. */}
      {fromScan && (
        <div
          style={{
            display: 'flex', alignItems: 'flex-start', gap: 'var(--space-3)',
            background: 'rgba(43, 108, 176, 0.08)',
            border: '1px solid #2B6CB0',
            borderRadius: 'var(--radius-md)',
            padding: 'var(--space-3)',
            marginBottom: 'var(--space-3)',
            color: '#1A4E8A',
            fontSize: 'var(--fs-13)',
          }}
        >
          <Camera size={18} strokeWidth={1.75} style={{ flexShrink: 0, marginTop: 1 }} />
          <div>
            <div style={{ fontWeight: 600 }}>Prefilled from a scanned slip — check every dropdown before saving.</div>
            <div style={{ marginTop: 2, color: '#2B6CB0' }}>
              Confirm the venue, SKU, fabric, size and payment selections, then Create the Sales Order.
              Fields you change from the scan are highlighted in blue.
            </div>
          </div>
        </div>
      )}

      {/* ── CUSTOMER ──────────────────────────────────────────────────
          Matches SalesOrderDetail's Customer card: Name * / Phone * /
          Email * / Customer Type / Salesperson / Customer SO Ref.
          Same .formGrid4 column layout (1 wide + 1 + 1 + 1 + 1 + 1) so
          fields line up visually between the two pages. */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Customer</h2>
        </header>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4} ref={custGridRef}>
            <label className={styles.field} style={{ gridColumn: 'span 3' }}>
              <span className={styles.fieldLabel}>Customer Name *</span>
              <input
                className={`${styles.fieldInput} ${editedClass('debtorName', debtorName)}`}
                value={debtorName}
                onChange={(e) => { setDebtorName(e.target.value); setShowDebtorSuggest(true); }}
                onFocus={() => setShowDebtorSuggest(true)}
                onBlur={() => setTimeout(() => setShowDebtorSuggest(false), 150)}
                placeholder="e.g. Lim Mei Hua"
                required
              />
              {showDebtorSuggest && debtorSuggestions.length > 0 && (
                <ul className={styles.suggestList}>
                  {debtorSuggestions.slice(0, 8).map((d, i) => (
                    <li
                      key={`${d.debtor_code ?? ''}-${i}`}
                      className={styles.suggestItem}
                      onMouseDown={() => applyDebtorSuggestion(d)}
                    >
                      <div>{d.debtor_name}</div>
                      {(d.debtor_code || d.phone) && (
                        <div className={styles.suggestCode}>
                          {d.debtor_code ?? ''}{d.debtor_code && d.phone ? ' · ' : ''}{formatPhone(d.phone) || ''}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Customer SO Ref</span>
              <input
                className={`${styles.fieldInput} ${editedClass('customerSoNo', customerSoNo)}`}
                value={customerSoNo}
                placeholder="Their PO / SO number"
                onChange={(e) => setCustomerSoNo(e.target.value)}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Phone *</span>
              <PhoneInput
                className={styles.fieldInput}
                value={phone}
                onChange={setPhone}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Email *</span>
              <input
                type="email"
                className={styles.fieldInput}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="customer@example.com"
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Customer Type</span>
              <span className={styles.selectWrap}>
                <select
                  className={`${styles.fieldSelect} ${editedClass('customerType', customerType)}`}
                  value={customerType}
                  onChange={(e) => setCustomerType(e.target.value)}
                >
                  <option value="">—</option>
                  {customerTypeOpts.map((t) => (
                    <option key={t.id} value={t.value}>{t.label}</option>
                  ))}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Salesperson</span>
              {/* Commander 2026-05-27: "salesperson 还是可以换 只是default
                  跳出来". Defaults to the current user; only admin /
                  sales_director can re-pick. Non-admin roles see a
                  disabled select pinned to themselves so the field is
                  visible-but-not-editable (UI parity with the editable
                  case). */}
              <span className={styles.selectWrap}>
                <select
                  className={styles.fieldSelect}
                  value={salespersonId}
                  onChange={(e) => setSalespersonId(e.target.value)}
                  disabled={!canChangeSalesperson}
                >
                  {/* Owner 2026-06-23 — the creator is ALWAYS a selectable
                      option so Salesperson is never blank. When the creator has
                      a scm.staff row, selfStaffMatch carries its canonical id +
                      code; when they don't (e.g. the owner), a synthesized
                      "self" option (SELF_SALESPERSON) shows their name and sits
                      at the TOP of the list. */}
                  {!selfStaffMatch && (
                    <option value={SELF_SALESPERSON}>{selfDisplayName} (me)</option>
                  )}
                  {/* Non-admin roles are pinned to themselves: only the creator
                      option renders. Admin / director / super-admin get the full
                      pickable list (with the self option already on top). */}
                  {!canChangeSalesperson && selfStaffMatch && (
                    <option value={selfStaffMatch.id}>
                      {selfStaffMatch.name} ({selfStaffMatch.staffCode})
                    </option>
                  )}
                  {canChangeSalesperson && sortByText(staffList).map((s) => (
                    <option key={s.id} value={s.id}>{s.name} ({s.staffCode})</option>
                  ))}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
          </div>
        </div>
      </section>

      {/* ── ORDER INFO (Building Type / Venue / Dates / Note) ────────
          Same card + same field layout as Detail's Order Info. */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Order Info</h2>
        </header>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Building Type</span>
              <span className={styles.selectWrap}>
                <select
                  className={`${styles.fieldSelect} ${editedClass('buildingType', buildingType)}`}
                  value={buildingType}
                  onChange={(e) => setBuildingType(e.target.value)}
                >
                  <option value="">—</option>
                  {buildingTypeOpts.map((b) => (
                    <option key={b.id} value={b.value}>{b.label}</option>
                  ))}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Venue</span>
              {/* Houzs 2026-06-22 (owner): Venue is manually pickable (was a
                  locked 2990 field). Defaults to the salesperson's home venue,
                  the operator can change it. */}
              <span className={styles.selectWrap}>
                <select
                  className={`${styles.fieldSelect} ${editedClass('venueId', effectiveVenueId ?? '')}`}
                  value={effectiveVenueId ?? ''}
                  onChange={(e) => setPickedVenueId(e.target.value || null)}
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
              <input
                type="date"
                className={`${styles.fieldInput} ${editedClass('processingDate', processingDate)}`}
                value={processingDate}
                min={today}
                onChange={(e) => setProcessingDate(e.target.value)}
                style={datesXor && !processingDate ? { borderColor: 'var(--c-festive-b, #B8331F)' } : undefined}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Delivery Date</span>
              <input
                type="date"
                className={`${styles.fieldInput} ${editedClass('deliveryDate', deliveryDate)}`}
                value={deliveryDate}
                min={today}
                onChange={(e) => setDeliveryDate(e.target.value)}
                style={datesXor && !deliveryDate ? { borderColor: 'var(--c-festive-b, #B8331F)' } : undefined}
              />
            </label>
            <label className={styles.field} style={{ gridColumn: 'span 4' }}>
              <span className={styles.fieldLabel}>Note</span>
              <input
                className={`${styles.fieldInput} ${editedClass('note', note)}`}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Internal notes — visible on the SO detail page only"
              />
            </label>
          </div>
          {datesXor && (
            <div
              style={{
                background: 'rgba(184, 51, 31, 0.08)',
                border: '1px solid var(--c-festive-b, #B8331F)',
                color: 'var(--c-festive-b, #B8331F)',
                padding: '4px var(--space-2)',
                borderRadius: 'var(--radius-sm)',
                fontSize: 'var(--fs-11)',
                fontWeight: 600,
                marginTop: 'var(--space-2)',
              }}
            >
              ⚠ Processing Date and Delivery Date must be set together — Save is blocked.
            </div>
          )}
        </div>
      </section>

      {/* ── EMERGENCY CONTACT ─────────────────────────────────────────
          Mirrors Detail's Emergency Contact card field-for-field. */}
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
              <input
                className={styles.fieldInput}
                value={emergencyName}
                placeholder="e.g. Lim Mei Hua"
                onChange={(e) => setEmergencyName(e.target.value)}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Relationship</span>
              <span className={styles.selectWrap}>
                <select
                  className={styles.fieldSelect}
                  value={emergencyRel}
                  onChange={(e) => setEmergencyRel(e.target.value)}
                >
                  <option value="">—</option>
                  {relationshipOpts.map((r) => (
                    <option key={r.id} value={r.value}>{r.label}</option>
                  ))}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <label className={styles.field} style={{ gridColumn: 'span 2' }}>
              <span className={styles.fieldLabel}>Phone</span>
              <PhoneInput
                className={styles.fieldInput}
                value={emergencyPhone}
                onChange={setEmergencyPhone}
              />
            </label>
          </div>
        </div>
      </section>

      {/* ── DELIVERY ADDRESS ──────────────────────────────────────────
          Matches Detail's Delivery Address card. The one Detail-only
          field (Sales Location, read from auth) is omitted here. The
          one New-SO-only affordance ("Fill in address later") sits at
          the top of the card so commander can defer the address. */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Delivery Address</h2>
        </header>
        <div className={styles.cardBody}>
          <label
            style={{
              display: 'flex', alignItems: 'flex-start', gap: 'var(--space-3)',
              padding: 'var(--space-3)',
              background: fillAddressLater ? 'rgba(232, 107, 58, 0.08)' : 'var(--c-cream)',
              border: '1px solid ' + (fillAddressLater ? 'var(--c-orange)' : 'var(--line)'),
              borderRadius: 'var(--radius-md)',
              marginBottom: 'var(--space-3)',
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={fillAddressLater}
              onChange={(e) => setFillAddressLater(e.target.checked)}
              style={{ marginTop: 2 }}
            />
            <div>
              <div style={{ fontWeight: 600, fontSize: 'var(--fs-14)' }}>Fill in address later</div>
              <div style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)', marginTop: 2 }}>
                Customer hasn't confirmed delivery address yet — we'll capture it before dispatch.
              </div>
            </div>
          </label>

          {/* Address fields — only Address 1/2 dim when fill-later is on. */}
          <div className={styles.formGrid4}>
            <label
              className={styles.field}
              style={{
                gridColumn: 'span 4',
                opacity: fillAddressLater ? 0.4 : 1,
                pointerEvents: fillAddressLater ? 'none' : 'auto',
              }}
            >
              <span className={styles.fieldLabel}>Address Line 1</span>
              <input
                className={`${styles.fieldInput} ${editedClass('address1', address1)}`}
                value={address1}
                onChange={(e) => setAddress1(e.target.value)}
                placeholder="Unit, street, area"
              />
            </label>
            <label
              className={styles.field}
              style={{
                gridColumn: 'span 4',
                opacity: fillAddressLater ? 0.4 : 1,
                pointerEvents: fillAddressLater ? 'none' : 'auto',
              }}
            >
              <span className={styles.fieldLabel}>Address Line 2</span>
              <input
                className={styles.fieldInput}
                value={address2}
                onChange={(e) => setAddress2(e.target.value)}
                placeholder="Apt, floor, building (optional)"
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>State</span>
              <span className={styles.selectWrap}>
                <select
                  className={`${styles.fieldSelect} ${editedClass('state', state)}`}
                  value={state}
                  onChange={(e) => { setState(e.target.value); setCity(''); setPostcode(''); }}
                  disabled={loc.isLoading}
                >
                  <option value="">{loc.isLoading ? 'Loading…' : 'Pick state'}</option>
                  {sortByText(states).map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>City</span>
              <span className={styles.selectWrap}>
                <select
                  className={styles.fieldSelect}
                  value={city}
                  onChange={(e) => { setCity(e.target.value); setPostcode(''); }}
                  disabled={!state}
                >
                  <option value="">{state ? 'Pick city' : '— pick state first'}</option>
                  {sortByText(cities).map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Postcode</span>
              <span className={styles.selectWrap}>
                <select
                  className={styles.fieldSelect}
                  value={postcode}
                  onChange={(e) => setPostcode(e.target.value)}
                  disabled={!state || !city}
                >
                  <option value="">{(state && city) ? 'Pick postcode' : '— pick city first'}</option>
                  {sortByNumeric(postcodes).map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            {/* Task #121 — Country is auto-derived from the picked state via
                my_localities. Read-only display; the API re-derives + snaps
                it onto the SO header on POST. */}
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Country</span>
              <span className={styles.fieldInput} style={{
                display: 'inline-flex', alignItems: 'center', height: 26,
                color: 'var(--fg-muted)',
              }}>
                {country}
              </span>
            </div>
            {/* Commander 2026-05-27 (Fix 5) — Sales Location auto-derives
                from state_warehouse_mappings on state change. Read-only
                display (mappings live in Maintenance). Empty when the picked
                state has no warehouse wired up yet. */}
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Sales Location</span>
              <span className={styles.fieldInput} style={{
                display: 'inline-flex', alignItems: 'center', height: 26,
                color: 'var(--fg-muted)',
              }}
                title={salesLocation
                  ? `Auto-set from State → Warehouse mapping for "${state}"`
                  : 'Pick a State above to auto-set'}
              >
                {salesLocation || '—'}
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* ── LINE ITEMS ──────────────────────────────────────────────
          Same SoLineCard component Edit SO uses inline. Each line on
          New SO is already in inline-edit mode (no saved row exists
          yet), and "+ Add Line Item" appends a fresh card. Card header
          mirrors Detail — "Line Items ({n})" with no subtitle. */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Line Items ({lines.length})</h2>
        </header>
        <div className={styles.cardBody} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          {lines.map((line, idx) => {
            /* Per-line scan confidence chip (fromScan only). "scanned · NN%"
               for a SKU still on the AI's suggestion; "scanned · changed" once
               the operator picks a different code; "scanned · no match" when
               the AI couldn't match. The real SKU picker inside SoLineCard is
               still the only way to set the code — the chip is read-only. */
            const meta = scanLineMeta[line.rid];
            let chip: { text: string; tone: 'good' | 'warn' | 'muted' } | null = null;
            if (meta) {
              if (!line.itemCode) {
                chip = { text: 'scanned · no match', tone: 'muted' };
              } else if (line.itemCode !== meta.seededCode) {
                chip = { text: 'scanned · changed', tone: 'muted' };
              } else {
                const pct = Math.round(meta.confidence * 100);
                chip = { text: `scanned · ${pct}%`, tone: meta.confidence >= 0.8 ? 'good' : 'warn' };
              }
            }
            return (
              <div key={line.rid} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                {chip && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span
                      title={meta?.rawText ? `Slip: ${meta.rawText}` : undefined}
                      style={{
                        display: 'inline-flex', alignItems: 'center',
                        padding: '2px 8px', borderRadius: 999,
                        fontSize: 'var(--fs-11)', fontWeight: 600,
                        background:
                          chip.tone === 'good' ? 'rgba(47, 93, 79, 0.12)'
                          : chip.tone === 'warn' ? 'rgba(196, 148, 28, 0.16)'
                          : 'rgba(0, 0, 0, 0.06)',
                        color:
                          chip.tone === 'good' ? 'var(--c-secondary-a, #2f5d4f)'
                          : chip.tone === 'warn' ? '#8a6914'
                          : 'var(--fg-muted)',
                      }}
                    >
                      {chip.text}
                    </span>
                    {meta?.rawText && (
                      <span style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }} title={meta.rawText}>
                        “{meta.rawText.length > 48 ? `${meta.rawText.slice(0, 48)}…` : meta.rawText}”
                      </span>
                    )}
                  </div>
                )}
                <SoLineCard
                  index={idx}
                  draft={line}
                  onChange={(patch) => updateLine(line.rid, patch)}
                  onRemove={() => dropLine(line.rid)}
                  canRemove={lines.length > 1}
                  inheritVariantsByCategory={inheritVariantsByCategory}
                  /* Scan-Order (Task #73) — a NO-MATCH scanned line seeds an
                     empty SKU picker; pass the slip rawText as the picker's
                     placeholder hint so the operator can pick a real SKU
                     (never free-text). Only while the line is still unpicked. */
                  searchHint={!line.itemCode && meta?.rawText ? meta.rawText : undefined}
                />
              </div>
            );
          })}

          <button
            type="button"
            onClick={addLine}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              width: '100%',
              padding: '12px 14px',
              background: 'transparent',
              border: '1px dashed var(--c-orange)',
              borderRadius: 'var(--radius-md)',
              color: 'var(--c-orange)',
              fontFamily: 'var(--font-sans)',
              fontSize: 'var(--fs-13)',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            <Plus {...ICON} /> Add Line Item
          </button>

          <div style={{
            display: 'flex',
            justifyContent: 'flex-end',
            marginTop: 'var(--space-2)',
            paddingTop: 'var(--space-3)',
            borderTop: '1px solid var(--line)',
            fontFamily: 'var(--font-mark)',
            fontSize: 'var(--fs-20)',
            fontWeight: 800,
            color: 'var(--c-burnt)',
          }}>
            Subtotal: {fmtRm(subtotalCenti)}
          </div>
        </div>
      </section>

      {/* ── PAYMENTS (shared with Detail) ─────────────────────────────
          Task #105 — Same Houzs PaymentsTable rendered on Detail. In
          DRAFT mode it holds rows in local state; onSave (above) batches
          POST /:docNo/payments calls in parallel after the SO has been
          created and before navigating to the Detail page. */}
      <PaymentsTable
        docNo={null}
        payments={paymentDrafts}
        onChange={setPaymentDrafts}
        grandTotalCenti={subtotalCenti}
        currency="MYR"
        slipUpload
      />

    </div>
  );
};
