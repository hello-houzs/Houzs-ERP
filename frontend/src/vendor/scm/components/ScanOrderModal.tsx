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
// ----------------------------------------------------------------------------

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Camera, Loader2, Upload, X } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { useAuth } from '../../../auth/AuthContext';
import { authedFetch } from '../lib/authed-fetch';
import { sortByText } from '../lib/sort-options';
import { useVenues } from '../lib/venues-queries';
import { useSoDropdownOptions, optionsOrFallback } from '../lib/so-dropdown-options-queries';
import { useLocalities, distinctStates } from '../lib/localities-queries';
import { reconcileScanPrefill } from '../lib/scan-prefill';
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
type ExtractResp = {
  success: boolean;
  data: {
    sampleId: string | null;
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

interface Props {
  onClose: () => void;
}

export const ScanOrderModal = ({ onClose }: Props) => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const [files, setFiles] = useState<File[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const addFiles = (picked: FileList | File[] | null) => {
    if (!picked) return;
    const ok = Array.from(picked).filter((f) =>
      /^image\/(jpeg|png|webp)$/.test(f.type) ||
      f.type === 'application/pdf' ||
      /\.(jpe?g|png|webp|pdf)$/i.test(f.name),
    );
    if (ok.length > 0) setFiles((prev) => [...prev, ...ok]);
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

  const runExtract = async () => {
    if (files.length === 0 || extracting) return;
    setExtracting(true);
    setError(null);
    try {
      const fd = new FormData();
      for (const f of files) fd.append('file', f);
      const repTyped = salesperson.trim();
      if (repTyped) fd.append('salesperson', repTyped);
      const resp = await authedFetch<ExtractResp>('/scan-so/extract', {
        method: 'POST',
        body: fd,
      });
      const d = resp.data;
      // Blank salesperson → backfill from the slip's SALES REPRESENTATIVE box
      // so the learning sample is still attributed to the rep.
      const repName = repTyped || (d.extracted.salesRep ?? '').trim();
      const prefill = buildPrefill(d, repName);
      sessionStorage.setItem(SCAN_PREFILL_KEY, JSON.stringify(prefill));
      onClose();
      // HOUZS VENDOR — the New SO page lives at /scm/sales-orders/new here.
      // ?fromScan=1 + the sessionStorage handoff are consumed by
      // SalesOrderNew's fromScan effect (which now also runs the edit-gate).
      navigate('/scm/sales-orders/new?fromScan=1');
    } catch (e) {
      /* authedFetch already throws operator-friendly messages (humanApiError
         runs inside it) — surface the message as-is. */
      setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.');
    } finally {
      setExtracting(false);
    }
  };

  return (
    <div className={styles.modal} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={styles.panel}>
        <div className={styles.head}>
          <div>
            <div className={styles.eyebrow}>Sales Orders</div>
            <h2 className={styles.title}>Scan Order</h2>
            <p className={styles.sub}>
              Photo of a handwritten sale-order slip → the New SO form opens prefilled,
              where you review every field against its dropdown. Nothing is saved until
              you save the SO itself.
            </p>
          </div>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="Close">
            <X size={18} strokeWidth={1.75} />
          </button>
        </div>

        <div className={styles.body}>
          {error && <div className={styles.error}>{error}</div>}

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

          <div
            className={`${styles.dropZone} ${dragOver ? styles.dropZoneActive : ''}`}
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); }}
          >
            <Camera size={28} strokeWidth={1.5} style={{ marginBottom: 8 }} />
            <div>Drop slip photo(s) here, or click to choose</div>
            <div style={{ fontSize: 12, marginTop: 4 }}>JPEG / PNG / WEBP / PDF · max 20MB each</div>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/jpeg,image/png,image/webp,application/pdf"
              style={{ display: 'none' }}
              onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }}
            />
          </div>
          {files.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {files.map((f, i) => (
                <span key={`${f.name}-${i}`} className={styles.fileChip}>
                  {f.name}
                  <button
                    type="button"
                    className={styles.removeBtn}
                    style={{ padding: 0 }}
                    onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                    aria-label={`Remove ${f.name}`}
                  >
                    <X size={12} strokeWidth={1.75} />
                  </button>
                </span>
              ))}
            </div>
          )}

          <p className={styles.sub} style={{ marginTop: 4 }}>
            You can upload two photos: the handwritten order slip and a card-terminal
            payment receipt. After scanning, the New SO form opens with the customer,
            line items and payment prefilled for you to confirm.
          </p>
        </div>

        <div className={styles.foot}>
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void runExtract()}
            disabled={files.length === 0 || extracting}
          >
            {extracting
              ? <Loader2 size={ICON.size} strokeWidth={ICON.strokeWidth} className={styles.spin} />
              : <Upload size={ICON.size} strokeWidth={ICON.strokeWidth} />}
            <span>{extracting ? 'Scanning slip…' : 'Scan & open New SO'}</span>
          </Button>
        </div>
      </div>
    </div>
  );
};
