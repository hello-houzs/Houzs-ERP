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
import { useVenues, type VenueRow } from '../lib/venues-queries';
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
  remark:         string;        // rawText + notes so nothing on the slip is lost
  /* Verification + learning carry-through. rawText is the slip's verbatim row
     (the source of truth the edit-gate pairs against the corrected code);
     confidence/suggestedCode drive the per-line "scanned · NN%" chip in the
     New SO form and let it tell a confirmed AI match from an operator pick. */
  rawText:        string;
  fabricCode:     string;        // matched fabric ('' = none)
  suggestedCode:  string;        // the SKU code Claude suggested ('' = none)
  confidence:     number;        // 0-1 confidence of the suggested SKU
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
  note:           string;        // remarks + location + extra phones + non-date delivery text
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
  notes: string | null;
};
/* SO-Maintenance option match — value is a so_dropdown_options row VALUE,
   already validated server-side against the ACTIVE list. */
type OptionMatch = { value: string; confidence: number; reason: string };
export type ExtractedSlip = {
  customerName: string | null;
  address: string | null;
  phones: string[];
  location: string | null;
  deliveryDate: string | null;
  processingDate: string | null;
  salesRep: string | null;
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
    };
    meta?: { repRules?: RepRulesMeta | null; sharedAliases?: boolean };
  };
};
type SalespeopleResp = { success: boolean; data: { salespeople: string[] } };

/* mfg_product_category → SO line item_group (SoLineCard lowercases the
   product category; SERVICE lines carry item_group='service'). */
const CATEGORY_TO_GROUP: Record<string, string> = {
  SOFA: 'sofa',
  BEDFRAME: 'bedframe',
  MATTRESS: 'mattress',
  ACCESSORY: 'accessory',
  SERVICE: 'service',
};

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/* Owner rule — a bank EPP / installment indicated with NO written month count
   defaults to the 12-month plan. The value MUST equal the installment_plan
   option VALUE seeded in migration 0022 ('12 months'). */
const DEFAULT_INSTALLMENT_PLAN = '12 months';
/* Free-text signals (in the payment-notes line) that EPP / installment was
   indicated even when no explicit term was parsed into a plan match. */
const EPP_HINT_RE = /\b(epp|installment|instalment|ansuran|分期)\b|个月|\d\s*(?:m|mth|months?|bln|个月)\b/i;

/* ── Venue unify helper ─────────────────────────────────────────────────
   Resolve the OCR's venue text to a REAL venue id from the SAME useVenues()
   master the New SO form's Venue dropdown renders. We try, in order, the
   server's so_dropdown_options match value (locationMatch) then the raw
   location text, against each venue's name (case-insensitive, trim). A
   confident hit returns the venue id; no hit returns '' so the form keeps its
   salesperson-default venue (never a wrong forced pick). Substring matching is
   intentionally conservative: only when one side fully contains the other AND
   the shorter side is at least 3 chars, so "PJ" never collides with a longer
   unrelated name. */
function resolveVenueId(
  venues: VenueRow[],
  locationMatch: string,
  rawLocation: string,
): string {
  const candidates = [locationMatch, rawLocation]
    .map((s) => (s ?? '').trim().toLowerCase())
    .filter((s) => s !== '');
  if (candidates.length === 0 || venues.length === 0) return '';

  for (const cand of candidates) {
    // Exact name match first (the dropdown's source of truth).
    const exact = venues.find((v) => v.name.trim().toLowerCase() === cand);
    if (exact) return exact.id;
  }
  for (const cand of candidates) {
    // Conservative containment — only with a meaningful overlap length.
    const contains = venues.find((v) => {
      const name = v.name.trim().toLowerCase();
      if (name === '' ) return false;
      const a = name.length <= cand.length ? name : cand;
      const b = name.length <= cand.length ? cand : name;
      return a.length >= 3 && b.includes(a);
    });
    if (contains) return contains.id;
  }
  return '';
}

interface Props {
  onClose: () => void;
}

export const ScanOrderModal = ({ onClose }: Props) => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);

  /* VENUE UNIFY — the SAME venue master the New SO form's Venue dropdown reads.
     We match the OCR's venue text against this list and carry the resolved id
     in the prefill so the form seeds a real dropdown selection. */
  const venuesQ = useVenues();

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
    const skuByCode = new Map(d.catalog.skus.map((s) => [s.code.toUpperCase(), s]));

    const phones = ex.phones.filter((p) => p.trim() !== '');

    /* EPP/installment indicated when the matched method is the in-house
       Installment plan, OR a Merchant (bank card) with an EPP hint in the raw
       payment notes ("EPP", "12m", "分期"…). Drives the 12-month default below
       when no plan value was matched. */
    const pmValue = ex.paymentMethodMatch?.value ?? '';
    const installmentIndicated =
      pmValue === 'Installment' ||
      (pmValue === 'Merchant' && EPP_HINT_RE.test(ex.paymentMethod ?? ''));
    const planValue = ex.installmentPlanMatch?.value ?? '';

    /* VENUE UNIFY — resolve the OCR venue text to a real venue id from the
       form's own dropdown master. '' when no confident match. */
    const venueId = resolveVenueId(
      venuesQ.data ?? [],
      ex.locationMatch?.value ?? '',
      ex.location ?? '',
    );

    const noteParts: string[] = [];
    if (ex.remarks) noteParts.push(ex.remarks);
    if (ex.location) noteParts.push(`Venue/location on slip: ${ex.location}`);
    /* Keep the raw venue text in the Note when we couldn't resolve it to a
       dropdown id, so nothing on the slip is lost (the operator can pick the
       venue manually in the form). */
    if (!venueId && ex.locationMatch?.value && ex.locationMatch.value !== ex.location) {
      noteParts.push(`Venue matched (SO Maintenance): ${ex.locationMatch.value}`);
    }
    if (phones.length > 1) noteParts.push(`Other phone(s): ${phones.slice(1).join(', ')}`);
    if (ex.deliveryDate && !ISO_DATE_RE.test(ex.deliveryDate)) noteParts.push(`Delivery: ${ex.deliveryDate}`);
    if (ex.paymentMethod) noteParts.push(`Payment method on slip: ${ex.paymentMethod}`);
    if (ex.depositRm != null) noteParts.push(`Deposit on slip: RM ${ex.depositRm}`);
    if (ex.totalRm != null) noteParts.push(`Total on slip: RM ${ex.totalRm}`);
    if (ex.salesRep) noteParts.push(`Sales rep on slip: ${ex.salesRep}`);
    noteParts.push('(Prefilled from scanned slip — verify before saving.)');

    return {
      customerName: ex.customerName ?? '',
      phone: phones[0] ?? '',
      phones,
      address1: ex.address ?? '',
      note: noteParts.join('\n'),
      deliveryDate: ex.deliveryDate && ISO_DATE_RE.test(ex.deliveryDate) ? ex.deliveryDate : null,
      processingDate: ex.processingDate && ISO_DATE_RE.test(ex.processingDate) ? ex.processingDate : null,
      customerType: ex.customerTypeMatch?.value ?? '',
      buildingType: ex.buildingTypeMatch?.value ?? '',
      venueId,
      /* Matched method → ONE editable payment-draft row in New SO's Payments
         table. Deposit lands as the row amount (Spec D4 still requires a slip
         upload before save; the operator can zero/delete the row instead). */
      payment: pmValue
        ? {
            methodValue:      pmValue,
            bankValue:        ex.bankMatch?.value ?? '',
            /* Installment default — when the slip indicates EPP/installment
               (Merchant card over months, or the in-house Installment method)
               but no plan was matched, fall back to the 12-month value so a
               bank EPP with no written term seeds as 12m (owner rule). The
               value MUST match the installment_plan option VALUE ('12 months'
               per migration 0022). A plain swipe (no EPP signal) keeps ''. */
            installmentLabel: planValue || (installmentIndicated ? DEFAULT_INSTALLMENT_PLAN : ''),
            onlineTypeValue:  ex.onlineTypeMatch?.value ?? '',
            approvalCode:     ex.approvalCode ?? '',
            depositCenti:     Math.round((ex.depositRm ?? 0) * 100),
          }
        : null,
      lines: ex.lines.map((l) => {
        const code = l.skuMatch?.code ?? '';
        const sku = code ? skuByCode.get(code.toUpperCase()) : undefined;
        const remarkParts = [l.rawText && `Slip: ${l.rawText}`, l.notes].filter(Boolean) as string[];
        return {
          itemCode: sku?.code ?? '',
          itemGroup: sku ? (CATEGORY_TO_GROUP[sku.category] ?? 'others') : 'others',
          description: sku?.name ?? l.rawText,
          qty: l.qtyGuess > 0 ? l.qtyGuess : 1,
          unitPriceCenti: Math.round((l.priceRmGuess ?? 0) * 100),
          remark: remarkParts.join(' · '),
          rawText: l.rawText,
          fabricCode: l.fabricMatch?.code ?? '',
          suggestedCode: code,
          confidence: l.skuMatch?.confidence ?? 0,
        };
      }),
      // Original-slip R2 key → carried to the New SO create body.
      slipImageKey: d.imageKey ?? '',
      // Payment-receipt R2 key → carried to the New SO create body alongside.
      receiptImageKey: d.receiptImageKey ?? '',
      sampleId: d.sampleId,
      salesperson: repName || (ex.salesRep ?? '') || null,
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
