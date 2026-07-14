// ----------------------------------------------------------------------------
// ScanOrderModal — "Scan Order" on the Sales Orders list.
//
// Handwritten-slip OCR flow (ported from HOOKKA's scan-po, then refactored so
// the operator reviews in the REAL New SO form, never a separate free-text
// modal):
//   1. Operator drops / snaps photo(s) of a showroom sale-order slip
//      (jpeg/png/webp, PDF also accepted). The salesperson defaults to the
//      logged-in user (staff scan their OWN slips); kept editable for the
//      occasional someone-else slip.
//   2. POST /scan-so/extract → Claude vision reads the handwriting against
//      the live SKU/fabric/option catalog and returns structured JSON + a
//      sampleId (+ slip / receipt R2 image keys).
//   3. On success the modal IMMEDIATELY builds a ScanPrefill (matched option
//      VALUES + a resolved venue id + the AI-original snapshot + sampleId +
//      salesperson ride along), writes it to sessionStorage, and navigates to
//      /scm/sales-orders/new?fromScan=1.
//
// There is NO in-modal review any more (Task #73 — owner: "整个流程不可以走
// 后门 / OCR 生成的 SO Draft 全部都不是按照 drop down 选项来做的"). Every field
// is reviewed + corrected in the real New SO form, where every input is
// dropdown-bound (venue, customer/building type, payment method/bank/online/
// installment, per-line SKU picker, fabric, divan/leg/gap). The edit-gate
// learning POST (/scan-so/samples/:id/confirm) now fires from the New SO save,
// not here — see SalesOrderNew.tsx's fromScan seed + save path.
//
// VENUE UNIFY (Task #73 — owner: "venue 两套词表 要統一") — the OCR validates
// its venue against scm.so_dropdown_options.venue, but the New SO form's Venue
// dropdown renders from the Project-Maintenance venue master (useVenues →
// /api/projects/venues). Those are two different vocabularies, so an OCR venue
// string could never seed the form's dropdown. We reconcile HERE: match the
// extracted location/venue text against the SAME useVenues() list the form
// dropdown uses, resolve it to a real venue id, and carry that id in the
// prefill so SalesOrderNew seeds the dropdown with a VALID selection (never
// free text). The form dropdown is the single source of truth.
//
// The modal NEVER creates the SO itself — everything lands in the normal New
// SO form where pricing, variants and validation run as usual.
//
// ── MOBILE PARITY (2026-07-14) ──────────────────────────────────────────────
// Three capabilities were brought over from MobileScan (mirroring the CAPABILITY,
// not the mobile layout — this modal keeps its own styling):
//
//   1. LABELED SLOTS — the single undifferentiated dropzone is split into a
//      labeled "Order slip" slot + an optional "Payment receipt" slot (mirrors
//      mobile's Front/Payment split). The positional /scan-so/extract contract
//      is unchanged: file[0] = slip, file[1] = receipt.
//
//   2. DUPLICATE WARNING — the /scan-so/extract response's `duplicate`
//      ({ docNo, rule }) field was previously dropped. It is now typed and, when
//      the slip looks like a re-upload, surfaced as an amber "possible duplicate
//      of <doc no>" banner with an "open anyway" action (a duplicate NEVER
//      blocks — the owner reviews, same policy as the backend + mobile).
//
//   3. MULTI-ORDER BATCH — an "Add another order" affordance queues MULTIPLE
//      orders in one session. A SINGLE order keeps the signature review-first
//      flow (extract → open the New SO form). TWO OR MORE orders switch to the
//      SAME background path mobile uses: POST /scan-so/enqueue per order creates
//      a DRAFT SO server-side, and the modal polls GET /scan-so/jobs (the shared
//      normalizeJobs helper) to show a live results list. There is NO new
//      backend flow — the exact endpoints + shared job helpers mobile uses are
//      reused. Per-order 409 duplicate_slip refusals surface inline on that
//      order's card, exactly as mobile does.
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Camera, CheckCircle2, Loader2, Plus, Receipt, Upload, X } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { useAuth } from '../../../auth/AuthContext';
import { authedFetch } from '../lib/authed-fetch';
import { sortByText } from '../lib/sort-options';
import { useVenues, type VenueRow } from '../lib/venues-queries';
import {
  normalizeJobs,
  isActiveJob,
  jobTs,
  hhmm,
  type ScanJob,
  type ScanJobsResp,
} from '../lib/scan-jobs';
import { useSoDropdownOptions, optionsOrFallback } from '../lib/so-dropdown-options-queries';
import { useLocalities, distinctStates } from '../lib/localities-queries';
import { reconcileScanPrefill } from '../lib/scan-prefill';
import { normalizePhone } from '@2990s/shared/phone';
import styles from './ScanOrderModal.module.css';

const ICON = { size: 14, strokeWidth: 1.75 } as const;

/* ── Handoff contract with SalesOrderNew.tsx ───────────────────────────── */
export const SCAN_PREFILL_KEY = 'soScanPrefill';

export type ScanPrefillLine = {
  itemCode:       string;        // '' when no SKU matched — operator picks in the form
  itemGroup:      string;        // 'sofa' | 'bedframe' | 'mattress' | 'accessory' | 'service' | 'others'
  description:    string;
  qty:            number;
  unitPriceCenti: number;        // RM handwriting × 100, rounded
  remark:         string;        // short "Slip: …" chip (rawText capped ~40c) + notes; full rawText below
  /* Verification + learning carry-through. rawText is the slip's verbatim row
     (the source of truth the edit-gate pairs against the corrected code);
     confidence/suggestedCode drive the per-line "scanned · NN%" chip in the
     New SO form and let it tell a confirmed AI match from an operator pick. */
  rawText:        string;
  fabricCode:     string;        // matched fabric ('' = none)
  suggestedCode:  string;        // the SKU code Claude suggested ('' = none)
  confidence:     number;        // 0-1 confidence of the suggested SKU
  /* Configured SOFA special-add-on CODES the slip remark resolved to (already
     validated server-side against the catalog + the line model's
     allowed_options.specials). The New SO line-seed auto-checks these specials.
     [] when none. */
  specialCodes:   string[];
};

/* SO-Maintenance-matched payment block → seeds ONE PaymentDraft row in the
   New SO Payments table (visible + editable + deletable there — no hidden
   writes). methodValue is the payment_method row VALUE (the immutable key
   PaymentsTable's methodLabel select stores: Merchant / Online /
   Installment / Cash); bank / plan / online sub-type are the L2 picks. */
export type ScanPrefillPayment = {
  methodValue:      string;
  bankValue:        string;        // payment_merchant value ('' = none)
  installmentLabel: string;        // installment_plan value, e.g. '12 months'
  onlineTypeValue:  string;        // online_type value ('' = none)
  approvalCode:     string;        // card-terminal approval / ref no. ('' = none)
  depositCenti:     number;        // deposit on slip ×100 (0 = operator fills)
};

export type ScanPrefill = {
  customerName:   string;
  phone:          string;        // first phone, raw string
  phones:         string[];      // all phones (carried so the edit-gate sees the full set)
  address1:       string;
  /* Structured address parts → the New SO form's State / City / Postcode
     dropdowns. addressState is a real my_localities state VALUE (validated
     server-side; '' = no confident match → leave the dropdown alone). city /
     postcode are reconciled against the form's locality cascade for the chosen
     state ('' = none). */
  addressState:    string;
  addressCity:     string;
  addressPostcode: string;
  /* The customer's own order reference (e.g. "HC14032") → Customer SO Ref. */
  customerSoRef:  string;
  note:           string;        // genuine order remark only (+ unresolved venue / non-date delivery)
  deliveryDate:   string | null; // only when a clean YYYY-MM-DD
  processingDate: string | null;
  customerType:   string;        // customer_type value matched to SO Maintenance ('' = none)
  buildingType:   string;        // building_type value matched to SO Maintenance ('' = none)
  /* VENUE UNIFY — a REAL venue id from the SAME useVenues() master the New SO
     form's Venue dropdown renders ('' = no confident match → the form keeps
     its salesperson-default venue). The raw OCR location text never lands in
     the dropdown; it survives in the Note. */
  venueId:        string;
  payment:        ScanPrefillPayment | null;
  lines:          ScanPrefillLine[];
  // R2 key of the scanned slip image ('' = none/PDF). Carried onto the New SO
  // create body so the SO detail page can show it as "Original Slip" proof.
  slipImageKey:   string;
  // R2 key of the scanned card-terminal payment receipt ('' = none). Carried
  // onto the New SO create body so the SO detail page can show it as "Payment
  // Receipt" proof alongside the order slip.
  receiptImageKey: string;
  /* Edit-gate carry-through — the learning POST now fires from the New SO
     save. sampleId addresses the so_scan_samples row; salesperson rides along
     so the per-rep pool grows + rules re-distill; aiOriginal is the FROZEN
     AI-extracted slip the save compares the operator's final values against
     (no diff = no learning POST). */
  sampleId:       string | null;
  salesperson:    string | null;
  aiOriginal:     ExtractedSlip | null;
};

/* ── /scan-so/extract response shape ───────────────────────────────────── */
type SkuMatch = { code: string; confidence: number; reason: string };
type ExtractedLine = {
  rawText: string;
  qtyGuess: number;
  priceRmGuess: number | null;
  skuMatch: SkuMatch | null;
  fabricMatch: SkuMatch | null;
  /* Configured SOFA special add-ons the row asks for (validated server-side
     against the catalog + the line's model allowed_options.specials). [] when
     none — seeds the New SO line's checked specials. */
  specialsMatch: SkuMatch[];
  notes: string | null;
};
/* SO-Maintenance option match — value is a so_dropdown_options row VALUE,
   already validated server-side against the ACTIVE list. */
type OptionMatch = { value: string; confidence: number; reason: string };
export type ExtractedSlip = {
  customerName: string | null;
  address: string | null;
  /* Structured address parts (the New SO form fills State / City / Postcode
     from these). addressStateMatch is snapped server-side to the live
     my_localities state list (never-invent rule), city/postcode are free text
     reconciled against the form's locality cascade. */
  addressLine1: string | null;
  city: string | null;
  postcode: string | null;
  addressStateMatch: OptionMatch | null;
  phones: string[];
  location: string | null;
  deliveryDate: string | null;
  processingDate: string | null;
  salesRep: string | null;
  /* The customer's own order reference (top-right of the slip, e.g. "HC14032")
     → seeds the form's Customer SO Ref field. */
  customerSoRef: string | null;
  paymentMethod: string | null;
  depositRm: number | null;
  totalRm: number | null;
  remarks: string | null;
  approvalCode: string | null;
  paymentMethodMatch: OptionMatch | null;
  bankMatch: OptionMatch | null;
  onlineTypeMatch: OptionMatch | null;
  installmentPlanMatch: OptionMatch | null;
  customerTypeMatch: OptionMatch | null;
  buildingTypeMatch: OptionMatch | null;
  locationMatch: OptionMatch | null;
  lines: ExtractedLine[];
};
type CatalogSku = { code: string; name: string; category: string; baseModel: string | null };
type CatalogOption = { value: string; label: string };
type CatalogOptions = {
  payment_method:   CatalogOption[];
  payment_merchant: CatalogOption[];
  online_type:      CatalogOption[];
  installment_plan: CatalogOption[];
  customer_type:    CatalogOption[];
  building_type:    CatalogOption[];
  venue:            CatalogOption[];
};
type RepRulesMeta = { salesperson: string; sampleCount: number };
/* Suspected re-upload the backend flags on /scan-so/extract: { docNo, rule } of
   the SO this same slip already became, else null. `rule` is 'image' (exact
   same photo sha256) or 'content' (same phone + slip ref / date+total). NEVER
   blocks — the operator reviews (owner policy) — so the modal surfaces it as an
   amber warning with an "open anyway" action. */
export type ScanDuplicate = { docNo: string; rule: 'image' | 'content' };
type ExtractResp = {
  success: boolean;
  data: {
    sampleId: string | null;
    // Backend flags a suspected duplicate here; previously dropped by this type.
    duplicate?: ScanDuplicate | null;
    imageKey?: string | null;
    receiptImageKey?: string | null;
    extracted: ExtractedSlip;
    warnings: Array<{ field: string; value: string; message: string; lineIdx?: number }>;
    catalog: {
      skus: CatalogSku[];
      fabrics: Array<{ code: string; description: string | null }>;
      options?: CatalogOptions;
      // Live my_localities state list the addressStateMatch was validated
      // against — carried so the modal can pass the matched state forward.
      states?: string[];
    };
    meta?: { repRules?: RepRulesMeta | null; sharedAliases?: boolean };
  };
};
type SalespeopleResp = { success: boolean; data: { salespeople: string[] } };

/* The OCR → New SO prefill MAPPING now lives in one shared, pure reconciler
   (../lib/scan-prefill) that BOTH this desktop modal and the mobile scan path
   call, so a future mapping fix lands in one file. This modal supplies the live
   catalogs (venues + SO dropdown options + localities) it already reads and then
   adapts the neutral ReconciledPrefill to the desktop ScanPrefill handoff shape.
   The venue-unify helper, the One-Shot payment default, the SOFA specialCodes
   pass-through and the category→group map all moved into that file. */

/* One queued order in the session: a single order slip + an OPTIONAL payment
   receipt. `id` is a stable client key (independent of array index so removing
   an order doesn't reshuffle React keys). Mirrors mobile's OrderDraft, reduced
   to desktop's file-drop model (one receipt file, not a payShots[] array —
   desktop's per-order review flow reads exactly one slip + one receipt per the
   /scan-so/extract positional contract). */
type SlotKind = 'slip' | 'receipt';
type OrderRow = { id: string; slip: File | null; receipt: File | null };
let ORDER_SEQ = 0;
const newOrder = (): OrderRow => ({ id: `ord-${++ORDER_SEQ}-${Date.now()}`, slip: null, receipt: null });

const ACCEPT = 'image/jpeg,image/png,image/webp,application/pdf';
const isAcceptedFile = (f: File): boolean =>
  /^image\/(jpeg|png|webp)$/.test(f.type) ||
  f.type === 'application/pdf' ||
  /\.(jpe?g|png|webp|pdf)$/i.test(f.name);

interface Props {
  onClose: () => void;
}

export const ScanOrderModal = ({ onClose }: Props) => {
  const navigate = useNavigate();
  const { user } = useAuth();
  // ONE hidden slip input + ONE hidden receipt input, both re-targeted to the
  // active order right before each pick (activeOrderIdRef).
  const slipInputRef = useRef<HTMLInputElement>(null);
  const receiptInputRef = useRef<HTMLInputElement>(null);
  const activeOrderIdRef = useRef<string | null>(null);

  /* Live catalogs the shared reconciler needs — the SAME masters the New SO form
     renders its dropdowns from, so a reconciled value always matches a live
     option. venues = VENUE UNIFY (OCR venue text → a real venue id); the SO
     dropdown options + localities canonicalise customer/building type, payment
     method/merchant/online/plan and state. optionsOrFallback keeps them
     populated before the API resolves (snapping is non-destructive, so a not-yet-
     loaded list never drops a server-matched value). */
  const venuesQ = useVenues();
  const customerTypeOptsQ  = useSoDropdownOptions('customer_type');
  const buildingTypeOptsQ  = useSoDropdownOptions('building_type');
  const paymentMethodOptsQ = useSoDropdownOptions('payment_method');
  const paymentMerchantQ   = useSoDropdownOptions('payment_merchant');
  const onlineTypeOptsQ    = useSoDropdownOptions('online_type');
  const installmentPlanQ   = useSoDropdownOptions('installment_plan');
  const localitiesQ        = useLocalities();

  // The session is an ARRAY of orders (one order in the common case). Each order
  // = one slip + an optional receipt. A single order keeps the review-first
  // flow; two or more switch to the background /enqueue batch path.
  const [orders, setOrders] = useState<OrderRow[]>(() => [newOrder()]);
  const [dragOver, setDragOver] = useState<string | null>(null); // "<orderId>:<kind>" while dragging
  const [extracting, setExtracting] = useState(false); // single-order review extract
  const [submitting, setSubmitting] = useState(false); // multi-order enqueue
  const [error, setError] = useState<string | null>(null);
  // Single-order duplicate gate — a built prefill held back while the operator
  // decides whether to open the New SO form despite the duplicate warning.
  const [pending, setPending] = useState<{ prefill: ScanPrefill; duplicate: ScanDuplicate } | null>(null);
  // Per-order 409 duplicate_slip refusal on /enqueue, keyed by OrderRow.id.
  const [orderErrors, setOrderErrors] = useState<Record<string, string>>({});
  // Job ids returned by /enqueue this session — the results list polls their
  // status via the shared /scan-so/jobs helper.
  const [enqueuedJobIds, setEnqueuedJobIds] = useState<string[]>([]);

  const multiOrder = orders.length > 1;

  // Salesperson — each rep has their own handwriting/notation habits, so the
  // extractor learns PER REP (rules + few-shot filtered to this rep). Owner
  // (2026-06-23): default this to whoever is logged in (the usual case — staff
  // scan their OWN slips), kept editable for the occasional someone-else slip.
  // It also rides into the prefill so the New SO save can attribute the
  // learning sample.
  const [salesperson, setSalesperson] = useState(() => user?.name ?? '');
  const [knownReps, setKnownReps] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    authedFetch<SalespeopleResp>('/scan-so/salespeople')
      .then((r) => { if (alive) setKnownReps(r.data.salespeople); })
      .catch(() => { /* datalist is a convenience — field stays free-text */ });
    return () => { alive = false; };
  }, []);

  // Pre-warm the Anthropic catalog prompt-cache the moment the modal opens, so
  // it's hot by the time the operator finishes readying their photo and hits
  // Extract. Fire-and-forget — never blocks or errors the modal (it's a pure
  // optimisation; a cold cache just means the first /extract pays full price).
  useEffect(() => {
    authedFetch('/scan-so/warm', { method: 'POST' }).catch(() => { /* best-effort warm */ });
  }, []);

  /* ── Batch results — the SHARED background-job status poll ───────────────
     After /scan-so/enqueue the OCR + DRAFT create run server-side. We poll the
     SAME GET /scan-so/jobs endpoint the mobile Scan screen uses (via the shared
     normalizeJobs helper) and show only the jobs THIS session enqueued. Poll
     every 4s while any tracked job is still queued/running or hasn't surfaced
     yet; a fully-settled list stops the interval. */
  const repParam = salesperson.trim();
  const { data: jobsData } = useQuery({
    queryKey: ['scan-modal-jobs', repParam],
    enabled: enqueuedJobIds.length > 0,
    queryFn: () =>
      authedFetch<ScanJobsResp>(
        repParam ? `/scan-so/jobs?salesperson=${encodeURIComponent(repParam)}` : '/scan-so/jobs',
      ),
    staleTime: 0,
    retry: false, // fail-soft — a jobs hiccup just leaves the rows pending
    refetchInterval: (query) => {
      if (enqueuedJobIds.length === 0) return false;
      const tracked = normalizeJobs(query.state.data).filter((j) => enqueuedJobIds.includes(j.id));
      const allSettled = tracked.length === enqueuedJobIds.length && !tracked.some(isActiveJob);
      return allSettled ? false : 4000;
    },
  });
  const trackedJobs = useMemo<ScanJob[]>(() => {
    const byId = new Map(normalizeJobs(jobsData).map((j) => [j.id, j]));
    return enqueuedJobIds
      .map((id) => byId.get(id))
      .filter((j): j is ScanJob => Boolean(j))
      .sort((a, b) => jobTs(a.createdAt) - jobTs(b.createdAt));
  }, [jobsData, enqueuedJobIds]);

  /* ── Slot capture ───────────────────────────────────────────────────────
     Re-target the hidden input to the active order, then open the file picker.
     One accepted file per slot (slip or receipt); a re-pick replaces it. */
  const pickSlot = (orderId: string, kind: SlotKind) => {
    if (extracting || submitting) return;
    activeOrderIdRef.current = orderId;
    (kind === 'slip' ? slipInputRef : receiptInputRef).current?.click();
  };
  const clearOrderError = (orderId: string) =>
    setOrderErrors((cur) => {
      if (!cur[orderId]) return cur;
      const next = { ...cur };
      delete next[orderId];
      return next;
    });
  const setSlot = (orderId: string, kind: SlotKind, file: File | null) => {
    setOrders((cur) =>
      cur.map((o) => {
        if (o.id !== orderId) return o;
        return kind === 'slip' ? { ...o, slip: file } : { ...o, receipt: file };
      }),
    );
    setError(null);
    setPending(null); // any photo change invalidates a held duplicate decision
    clearOrderError(orderId);
  };
  const onSlotFile = (kind: SlotKind, file: File | undefined) => {
    const orderId = activeOrderIdRef.current;
    if (!orderId || !file) return;
    if (!isAcceptedFile(file)) { setError('Unsupported file — use a JPEG, PNG, WEBP or PDF.'); return; }
    setSlot(orderId, kind, file);
  };
  const onDrop = (orderId: string, kind: SlotKind, list: FileList | null) => {
    setDragOver(null);
    const file = Array.from(list ?? []).find(isAcceptedFile);
    if (file) setSlot(orderId, kind, file);
  };

  const addOrder = () => {
    if (extracting || submitting) return;
    setOrders((cur) => [...cur, newOrder()]);
    setError(null);
    setPending(null);
  };
  // Never let the list go empty — removing the last order resets it to blank.
  const removeOrder = (orderId: string) => {
    if (extracting || submitting) return;
    setOrders((cur) => {
      const next = cur.filter((o) => o.id !== orderId);
      return next.length ? next : [newOrder()];
    });
    clearOrderError(orderId);
    setError(null);
  };

  /* Build the New-SO handoff straight from the AI extraction — NO operator
     review happens here any more. The extracted slip is mapped to the
     dropdown-bound prefill the New SO form consumes (matched option VALUES
     land in the form's normal selects, the resolved venue id lands in the
     form's Venue dropdown; the AI-original snapshot + sampleId + salesperson
     ride along so the New SO save can run the edit-gate). */
  const buildPrefill = (
    d: ExtractResp['data'],
    repName: string,
  ): ScanPrefill => {
    const ex = d.extracted;

    /* SHARED RECONCILER — the OCR → prefill mapping is done once, here and in the
       mobile scan path, so it can never drift again. We feed it the live catalogs
       the New SO form renders its dropdowns from; it returns a platform-neutral
       ReconciledPrefill (venue id resolved, dropdown values snapped to the live
       catalog, SOFA specialCodes + structured payment). We then adapt that neutral
       shape to the desktop ScanPrefill handoff (RM → centi, first phone, R2 keys +
       edit-gate carry-through). */
    const rec = reconcileScanPrefill(ex, {
      skus:            d.catalog.skus,
      venues:          venuesQ.data ?? [],
      customerType:    optionsOrFallback('customer_type',    customerTypeOptsQ.data),
      buildingType:    optionsOrFallback('building_type',    buildingTypeOptsQ.data),
      paymentMethod:   optionsOrFallback('payment_method',   paymentMethodOptsQ.data),
      paymentMerchant: optionsOrFallback('payment_merchant', paymentMerchantQ.data),
      onlineType:      optionsOrFallback('online_type',      onlineTypeOptsQ.data),
      installmentPlan: optionsOrFallback('installment_plan', installmentPlanQ.data),
      states:          distinctStates(localitiesQ.data ?? []),
    });

    return {
      customerName: rec.customerName,
      phone: rec.phones[0] ?? '',
      phones: rec.phones,
      address1: rec.address1,
      addressState:    rec.addressState,
      addressCity:     rec.addressCity,
      addressPostcode: rec.addressPostcode,
      customerSoRef:   rec.customerSoRef,
      note: rec.note,
      deliveryDate: rec.deliveryDate,
      processingDate: rec.processingDate,
      customerType: rec.customerType,
      buildingType: rec.buildingType,
      venueId: rec.venueId,
      /* Matched method → ONE editable payment-draft row in New SO's Payments
         table. Deposit lands as the row amount (Spec D4 still requires a slip
         upload before save; the operator can zero/delete the row instead). */
      payment: rec.payment
        ? {
            methodValue:      rec.payment.methodValue,
            bankValue:        rec.payment.bankValue,
            installmentLabel: rec.payment.installmentLabel,
            onlineTypeValue:  rec.payment.onlineTypeValue,
            approvalCode:     rec.payment.approvalCode,
            depositCenti:     Math.round(rec.payment.depositRm * 100),
          }
        : null,
      lines: rec.lines.map((l) => ({
        itemCode: l.itemCode,
        itemGroup: l.itemGroup,
        description: l.description,
        qty: l.qty,
        unitPriceCenti: Math.round(l.unitPriceRm * 100),
        /* Owner (repeated): no "Slip: …" chip — line remark seeds empty. */
        remark: '',
        rawText: l.rawText,
        fabricCode: l.fabricCode,
        suggestedCode: l.suggestedCode,
        confidence: l.confidence,
        specialCodes: l.specialCodes,
      })),
      // Original-slip R2 key → carried to the New SO create body.
      slipImageKey: d.imageKey ?? '',
      // Payment-receipt R2 key → carried to the New SO create body alongside.
      receiptImageKey: d.receiptImageKey ?? '',
      sampleId: d.sampleId,
      salesperson: repName || rec.salesRep || null,
      /* FROZEN AI snapshot — the New SO save diffs the operator's final values
         against this to decide whether to fire the edit-gate learning POST. */
      aiOriginal: ex,
    };
  };

  /* Commit a built prefill → the New SO review form (the signature single-order
     flow, unchanged). ?fromScan=1 + the sessionStorage handoff are consumed by
     SalesOrderNew's fromScan effect (which also runs the edit-gate). */
  const commitPrefill = (prefill: ScanPrefill) => {
    sessionStorage.setItem(SCAN_PREFILL_KEY, JSON.stringify(prefill));
    onClose();
    navigate('/scm/sales-orders/new?fromScan=1');
  };

  /* SINGLE order — review-first. Extract the one order's slip (+ optional
     receipt) and open the New SO form prefilled. If the backend flags a
     duplicate, HOLD the prefill and show the amber warning first (the operator
     decides whether to open anyway — a duplicate never blocks). */
  const runExtractSingle = async () => {
    const order = orders[0];
    if (!order?.slip || extracting) return;
    setExtracting(true);
    setError(null);
    setPending(null);
    try {
      const fd = new FormData();
      fd.append('file', order.slip);              // file[0] = order slip (positional contract)
      if (order.receipt) fd.append('file', order.receipt); // file[1] = payment receipt
      const repTyped = salesperson.trim();
      if (repTyped) fd.append('salesperson', repTyped);
      const resp = await authedFetch<ExtractResp>('/scan-so/extract', { method: 'POST', body: fd });
      const d = resp.data;
      // Blank salesperson → backfill from the slip's SALES REPRESENTATIVE box.
      const repName = repTyped || (d.extracted.salesRep ?? '').trim();
      const prefill = buildPrefill(d, repName);
      if (d.duplicate && d.duplicate.docNo) {
        setPending({ prefill, duplicate: d.duplicate });
      } else {
        commitPrefill(prefill);
      }
    } catch (e) {
      /* authedFetch already throws operator-friendly messages (humanApiError
         runs inside it) — surface the message as-is. */
      setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.');
    } finally {
      setExtracting(false);
    }
  };

  /* MULTIPLE orders — background batch. Reuse the SAME endpoint mobile uses:
     POST /scan-so/enqueue per order returns a job id and the OCR + DRAFT SO
     create finish server-side. A 409 duplicate_slip refusal for one order is
     surfaced inline on that order's card (the others still enqueue). The
     results list polls /scan-so/jobs for the drafts as they land in Orders. */
  const runEnqueueBatch = async () => {
    if (submitting) return;
    const queueable = orders.filter((o) => o.slip);
    if (queueable.length === 0) return;
    setSubmitting(true);
    setError(null);
    setOrderErrors({});
    const dupErrors: Record<string, string> = {};
    const newJobIds: string[] = [];
    try {
      for (const order of queueable) {
        const fd = new FormData();
        fd.append('file', order.slip!);            // file[0] = order slip
        if (order.receipt) fd.append('file', order.receipt); // file[1] = payment receipt
        const repTyped = salesperson.trim();
        if (repTyped) fd.append('salesperson', repTyped);
        try {
          const r = await authedFetch<{ job_id: string; status: string }>('/scan-so/enqueue', {
            method: 'POST',
            body: fd,
          });
          if (r?.job_id) newJobIds.push(r.job_id);
        } catch (e) {
          const err = e as Error & { status?: number; body?: string };
          // 409 duplicate_slip = this order's slip already created an SO (hard
          // reject, nothing queued). Keep it on screen with the reason inline;
          // the OTHER orders still enqueue.
          if (err.status === 409 && typeof err.body === 'string' && err.body.includes('duplicate_slip')) {
            let reason = 'This slip was already uploaded.';
            try {
              const b = JSON.parse(err.body) as { reason?: string };
              if (typeof b.reason === 'string' && b.reason.trim() !== '') reason = b.reason;
            } catch { /* body wasn't JSON — keep the fallback wording */ }
            dupErrors[order.id] = reason;
            continue;
          }
          throw e;
        }
      }

      if (newJobIds.length > 0) setEnqueuedJobIds((prev) => [...prev, ...newJobIds]);

      if (Object.keys(dupErrors).length > 0) {
        // Keep ONLY the refused orders on screen (with their inline reason); the
        // queued ones are already running server-side and appear in the results
        // list below.
        setOrders((cur) => {
          const keep = cur.filter((o) => dupErrors[o.id]);
          return keep.length ? keep : [newOrder()];
        });
        setOrderErrors(dupErrors);
        if (newJobIds.length === 0) return;
      } else {
        // All queued cleanly — reset the capture area to a fresh blank order.
        setOrders([newOrder()]);
      }

      if (newJobIds.length === 0 && Object.keys(dupErrors).length === 0) {
        setError("Couldn't read the slip — try again.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const busy = extracting || submitting;
  const ready = orders.length > 0 && orders.every((o) => o.slip !== null);

  /* One labeled slot (slip or receipt) — a dashed dropzone when empty, a solid
     filename card with a remove control when filled. */
  const renderSlot = (order: OrderRow, kind: SlotKind) => {
    const file = order[kind];
    const label = kind === 'slip' ? 'Order slip' : 'Payment receipt';
    const key = `${order.id}:${kind}`;
    return (
      <div className={styles.slot}>
        <span className={styles.slotLabel}>
          {label}
          {kind === 'receipt' && <span className={styles.slotLabelOptional}> · optional</span>}
        </span>
        {file ? (
          <div className={styles.slotFilled}>
            {kind === 'slip'
              ? <Camera size={20} strokeWidth={1.5} />
              : <Receipt size={20} strokeWidth={1.5} />}
            <span className={styles.slotFileName}>{file.name}</span>
            {!busy && (
              <button
                type="button"
                className={styles.removeBtn}
                onClick={() => setSlot(order.id, kind, null)}
                aria-label={`Remove ${label}`}
              >
                <X size={14} strokeWidth={1.75} /> Remove
              </button>
            )}
          </div>
        ) : (
          <div
            className={`${styles.slotZone} ${dragOver === key ? styles.slotZoneActive : ''}`}
            onClick={() => pickSlot(order.id, kind)}
            onDragOver={(e) => { e.preventDefault(); setDragOver(key); }}
            onDragLeave={() => setDragOver((cur) => (cur === key ? null : cur))}
            onDrop={(e) => { e.preventDefault(); onDrop(order.id, kind, e.dataTransfer.files); }}
          >
            {kind === 'slip'
              ? <Camera size={22} strokeWidth={1.5} />
              : <Receipt size={22} strokeWidth={1.5} />}
            <div>{kind === 'slip' ? 'Drop the slip, or click' : 'Card receipt (optional)'}</div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className={styles.modal} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={styles.panel}>
        <div className={styles.head}>
          <div>
            <div className={styles.eyebrow}>Sales Orders</div>
            <h2 className={styles.title}>Scan Order</h2>
            <p className={styles.sub}>
              {multiOrder
                ? 'Queue a stack of slips — each becomes a draft order in Orders, ready to review.'
                : 'Photo of a handwritten sale-order slip → the New SO form opens prefilled, where you review every field against its dropdown. Nothing is saved until you save the SO itself.'}
            </p>
          </div>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="Close">
            <X size={18} strokeWidth={1.75} />
          </button>
        </div>

        <div className={styles.body}>
          {error && <div className={styles.error}>{error}</div>}

          {/* Hidden inputs — one for slips, one for receipts, both re-targeted to
              the active order before each pick. */}
          <input
            ref={slipInputRef}
            type="file"
            accept={ACCEPT}
            style={{ display: 'none' }}
            onChange={(e) => { onSlotFile('slip', e.target.files?.[0]); e.target.value = ''; }}
          />
          <input
            ref={receiptInputRef}
            type="file"
            accept={ACCEPT}
            style={{ display: 'none' }}
            onChange={(e) => { onSlotFile('receipt', e.target.files?.[0]); e.target.value = ''; }}
          />

          <label className={styles.field}>
            <span className={styles.fieldLabel}>Salesperson</span>
            <input
              className={styles.input}
              list="scan-so-salespeople"
              value={salesperson}
              onChange={(e) => setSalesperson(e.target.value)}
            />
          </label>
          <datalist id="scan-so-salespeople">
            {sortByText(knownReps).map((r) => <option key={r} value={r} />)}
          </datalist>

          {/* One card per queued order, each grouping its labeled slip + receipt
              slots. The single order in the common case renders the same way,
              without a removable header. */}
          {orders.map((order, oi) => (
            <div key={order.id} className={styles.orderCard}>
              {multiOrder && (
                <div className={styles.orderHead}>
                  <span className={styles.orderTitle}>Order {oi + 1}</span>
                  {!busy && (
                    <button
                      type="button"
                      className={styles.removeOrderBtn}
                      onClick={() => removeOrder(order.id)}
                    >
                      <X size={12} strokeWidth={1.75} /> Remove
                    </button>
                  )}
                </div>
              )}
              <div className={styles.slotGrid}>
                {renderSlot(order, 'slip')}
                {renderSlot(order, 'receipt')}
              </div>
              {orderErrors[order.id] && (
                <div className={styles.orderError}>{orderErrors[order.id]}</div>
              )}
            </div>
          ))}

          {/* Add another order → switches this session to the background batch
              path (each order becomes a draft in Orders). */}
          <button
            type="button"
            className={styles.addOrderBtn}
            onClick={addOrder}
            disabled={busy}
          >
            <Plus size={ICON.size} strokeWidth={ICON.strokeWidth} /> Add another order
          </button>

          {/* Duplicate-slip warning (single-order flow) — non-blocking, mirrors
              mobile's dup pill. The operator opens the New SO form anyway or
              backs out to change the photo. */}
          {pending && (
            <div className={styles.warn}>
              <AlertTriangle size={18} strokeWidth={1.75} style={{ flex: 'none', marginTop: 1 }} />
              <div style={{ flex: 1 }}>
                <p className={styles.warnTitle}>Possible duplicate of {pending.duplicate.docNo}</p>
                <p className={styles.warnBody}>
                  {pending.duplicate.rule === 'image'
                    ? 'This exact slip photo was already scanned into that order.'
                    : 'A recent order has the same customer phone and slip details.'}{' '}
                  Open a new order anyway, or cancel if it is the same order.
                </p>
                <div className={styles.warnActions}>
                  <Button variant="secondary" size="sm" onClick={() => setPending(null)}>
                    Back
                  </Button>
                  <Button variant="primary" size="sm" onClick={() => commitPrefill(pending.prefill)}>
                    Open New SO anyway
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* Batch results — the shared /scan-so/jobs poll. Shown once anything
              has been enqueued this session. */}
          {enqueuedJobIds.length > 0 && (
            <div>
              <div className={styles.sectionLabel} style={{ marginBottom: 6 }}>
                Scanned this session
              </div>
              <div className={styles.results}>
                {trackedJobs.length === 0 && (
                  <div className={styles.resultRow}>
                    <span className={`${styles.chip} ${styles.chipGrey}`}>Queued</span>
                    <div className={styles.resultMain}>Uploading — the reading finishes in the background.</div>
                  </div>
                )}
                {trackedJobs.map((j) => {
                  const active = isActiveJob(j);
                  const done = j.status === 'done';
                  const failed = j.status === 'error';
                  const chipClass = done ? styles.chipTeal : failed ? styles.chipYellow : styles.chipGrey;
                  const chipLabel = active ? (j.status === 'running' ? 'Reading…' : 'Queued') : done ? 'Done' : failed ? 'Failed' : j.status;
                  return (
                    <div key={j.id} className={styles.resultRow}>
                      <span className={`${styles.chip} ${chipClass}`}>
                        {active && <Loader2 size={11} strokeWidth={2} className={styles.spin} style={{ marginRight: 4 }} />}
                        {done && <CheckCircle2 size={11} strokeWidth={2} style={{ marginRight: 4 }} />}
                        {chipLabel}
                      </span>
                      <div className={styles.resultMain}>
                        {done
                          ? (j.soDocNo ? `${j.soDocNo} — saved to Orders` : 'Saved to Orders')
                          : failed
                            ? (j.error || "Couldn't read the slip.")
                            : 'Reading the slip…'}
                        {j.duplicateOf && (
                          <div className={styles.resultSub}>Possible duplicate of {j.duplicateOf}</div>
                        )}
                      </div>
                      <span style={{ flex: 'none', fontSize: 11, color: 'var(--fg-muted)' }}>
                        {jobTs(j.createdAt) ? hhmm(jobTs(j.createdAt)) : ''}
                      </span>
                    </div>
                  );
                })}
              </div>
              <p className={styles.sub} style={{ marginTop: 8 }}>
                Drafts land in Orders — open each to review every field before finalising.
              </p>
            </div>
          )}

          <p className={styles.sub} style={{ marginTop: 4 }}>
            {multiOrder
              ? 'Each order takes an order slip and, optionally, a card-terminal payment receipt. We read every slip and save a draft order per slip in the background.'
              : 'Upload the handwritten order slip and, optionally, a card-terminal payment receipt. After scanning, the New SO form opens with the customer, line items and payment prefilled for you to confirm.'}
          </p>
        </div>

        <div className={styles.foot}>
          <Button variant="secondary" size="sm" onClick={onClose}>
            {enqueuedJobIds.length > 0 ? 'Close' : 'Cancel'}
          </Button>
          {enqueuedJobIds.length > 0 && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => { onClose(); navigate('/scm/sales-orders'); }}
            >
              View Orders
            </Button>
          )}
          <Button
            variant="primary"
            size="sm"
            onClick={() => void (multiOrder ? runEnqueueBatch() : runExtractSingle())}
            disabled={!ready || busy || pending !== null}
          >
            {busy
              ? <Loader2 size={ICON.size} strokeWidth={ICON.strokeWidth} className={styles.spin} />
              : <Upload size={ICON.size} strokeWidth={ICON.strokeWidth} />}
            <span>
              {multiOrder
                ? (submitting ? 'Uploading…' : `Scan & save ${orders.length} drafts`)
                : (extracting ? 'Scanning slip…' : 'Scan & open New SO')}
            </span>
          </Button>
        </div>
      </div>
    </div>
  );
};
