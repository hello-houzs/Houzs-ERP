// ----------------------------------------------------------------------------
// ScanOrderModal — "Scan Order" on the Sales Orders list.
//
// v1 of the handwritten-slip OCR flow (ported from HOOKKA's scan-po modal,
// deliberately simpler):
//   1. Operator drops / snaps photo(s) of a showroom sale-order slip
//      (jpeg/png/webp, PDF also accepted).
//   2. POST /scan-so/extract → Claude vision reads the handwriting against
//      the live SKU/fabric catalog and returns structured JSON + a sampleId.
//   3. Operator reviews + corrects in an editable form (customer block,
//      dates, line cards with a searchable SKU picker + confidence chip).
//   4. "Open in New SO" → corrections are saved back as a few-shot example
//      (POST /scan-so/samples/:id/confirm) and the New SO page opens with
//      the reviewed data prefilled via sessionStorage handoff
//      (?fromScan=1 + SCAN_PREFILL_KEY — see SalesOrderNew.tsx seed effect).
//
// The modal NEVER creates the SO itself — everything lands in the normal
// New SO form where pricing, variants and validation run as usual.
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Camera, Loader2, Trash2, Upload, X } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { authedFetch } from '../lib/authed-fetch';
import { sortByText } from '../lib/sort-options';
import styles from './ScanOrderModal.module.css';

const ICON = { size: 14, strokeWidth: 1.75 } as const;

/* ── Handoff contract with SalesOrderNew.tsx ───────────────────────────── */
export const SCAN_PREFILL_KEY = 'soScanPrefill';

export type ScanPrefillLine = {
  itemCode:       string;        // '' when no SKU picked — operator fills in the form
  itemGroup:      string;        // 'sofa' | 'bedframe' | 'mattress' | 'accessory' | 'service' | 'others'
  description:    string;
  qty:            number;
  unitPriceCenti: number;        // RM handwriting × 100, rounded
  remark:         string;        // rawText + notes so nothing on the slip is lost
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
  depositCenti:     number;        // deposit on slip ×100 (0 = operator fills)
};

export type ScanPrefill = {
  customerName:   string;
  phone:          string;        // first phone, raw string
  address1:       string;
  note:           string;        // remarks + location + extra phones + non-date delivery text
  deliveryDate:   string | null; // only when a clean YYYY-MM-DD
  processingDate: string | null;
  customerType:   string;        // customer_type value matched to SO Maintenance ('' = none)
  buildingType:   string;        // building_type value matched to SO Maintenance ('' = none)
  payment:        ScanPrefillPayment | null;
  lines:          ScanPrefillLine[];
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
type ExtractedSlip = {
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
const EMPTY_OPTIONS: CatalogOptions = {
  payment_method: [], payment_merchant: [], online_type: [],
  installment_plan: [], customer_type: [], building_type: [], venue: [],
};
type RepRulesMeta = { salesperson: string; sampleCount: number };
type ExtractResp = {
  success: boolean;
  data: {
    sampleId: string | null;
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

type LineEdit = {
  rid: string;
  rawText: string;
  code: string;            // operator-editable SKU code ('' = none)
  suggestedCode: string;   // what Claude suggested (for the chip)
  confidence: number;
  reason: string;
  qty: number;
  priceRm: string;         // kept as text while editing; parsed on submit
  notes: string;
  fabricCode: string;
};

interface Props {
  onClose: () => void;
}

export const ScanOrderModal = ({ onClose }: Props) => {
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [files, setFiles] = useState<File[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Salesperson — each rep has their own handwriting/notation habits, so the
  // extractor learns PER REP (rules + few-shot filtered to this rep). Set it
  // before Extract when known; left blank it's backfilled from the slip's
  // SALES REPRESENTATIVE box after extraction.
  const [salesperson, setSalesperson] = useState('');
  const [knownReps, setKnownReps] = useState<string[]>([]);
  const [repRules, setRepRules] = useState<RepRulesMeta | null>(null);
  const [sharedAliases, setSharedAliases] = useState(false);

  useEffect(() => {
    let alive = true;
    authedFetch<SalespeopleResp>('/scan-so/salespeople')
      .then((r) => { if (alive) setKnownReps(r.data.salespeople); })
      .catch(() => { /* datalist is a convenience — field stays free-text */ });
    return () => { alive = false; };
  }, []);

  // Review state (set after a successful extract).
  const [sampleId, setSampleId] = useState<string | null>(null);
  const [skus, setSkus] = useState<CatalogSku[]>([]);
  const [customerName, setCustomerName] = useState('');
  const [phonesText, setPhonesText] = useState('');   // " / "-joined, editable
  const [address, setAddress] = useState('');
  const [location, setLocation] = useState('');
  const [deliveryDate, setDeliveryDate] = useState('');
  const [processingDate, setProcessingDate] = useState('');
  const [salesRep, setSalesRep] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('');
  const [depositRm, setDepositRm] = useState('');
  const [totalRm, setTotalRm] = useState('');
  const [remarks, setRemarks] = useState('');
  const [lines, setLines] = useState<LineEdit[] | null>(null);

  // SO-Maintenance matched picks — value '' = no match. Selects are fed by
  // the allowed lists the extract response returns (active options only),
  // so the operator can only confirm/override within the maintenance vocab.
  const [optionLists, setOptionLists] = useState<CatalogOptions>(EMPTY_OPTIONS);
  const [pmValue,       setPmValue]       = useState('');
  const [bankValue,     setBankValue]     = useState('');
  const [onlineValue,   setOnlineValue]   = useState('');
  const [planValue,     setPlanValue]     = useState('');
  const [custTypeValue, setCustTypeValue] = useState('');
  const [bldgTypeValue, setBldgTypeValue] = useState('');
  const [venueValue,    setVenueValue]    = useState('');

  const skuByCode = useMemo(
    () => new Map(skus.map((s) => [s.code.toUpperCase(), s])),
    [skus],
  );

  const addFiles = (picked: FileList | File[] | null) => {
    if (!picked) return;
    const ok = Array.from(picked).filter((f) =>
      /^image\/(jpeg|png|webp)$/.test(f.type) ||
      f.type === 'application/pdf' ||
      /\.(jpe?g|png|webp|pdf)$/i.test(f.name),
    );
    if (ok.length > 0) setFiles((prev) => [...prev, ...ok]);
  };

  const runExtract = async () => {
    if (files.length === 0 || extracting) return;
    setExtracting(true);
    setError(null);
    try {
      const fd = new FormData();
      for (const f of files) fd.append('file', f);
      if (salesperson.trim()) fd.append('salesperson', salesperson.trim());
      const resp = await authedFetch<ExtractResp>('/scan-so/extract', {
        method: 'POST',
        body: fd,
      });
      const d = resp.data;
      setSampleId(d.sampleId);
      setSkus(d.catalog.skus);
      setRepRules(d.meta?.repRules ?? null);
      setSharedAliases(Boolean(d.meta?.sharedAliases));
      const ex = d.extracted;
      // Blank salesperson → backfill from the slip's SALES REPRESENTATIVE box.
      if (!salesperson.trim() && ex.salesRep) setSalesperson(ex.salesRep);
      setCustomerName(ex.customerName ?? '');
      setPhonesText(ex.phones.join(' / '));
      setAddress(ex.address ?? '');
      setLocation(ex.location ?? '');
      setDeliveryDate(ex.deliveryDate ?? '');
      setProcessingDate(ex.processingDate ?? '');
      setSalesRep(ex.salesRep ?? '');
      setPaymentMethod(ex.paymentMethod ?? '');
      setDepositRm(ex.depositRm != null ? String(ex.depositRm) : '');
      setTotalRm(ex.totalRm != null ? String(ex.totalRm) : '');
      setRemarks(ex.remarks ?? '');
      setOptionLists(d.catalog.options ?? EMPTY_OPTIONS);
      setPmValue(ex.paymentMethodMatch?.value ?? '');
      setBankValue(ex.bankMatch?.value ?? '');
      setOnlineValue(ex.onlineTypeMatch?.value ?? '');
      setPlanValue(ex.installmentPlanMatch?.value ?? '');
      setCustTypeValue(ex.customerTypeMatch?.value ?? '');
      setBldgTypeValue(ex.buildingTypeMatch?.value ?? '');
      setVenueValue(ex.locationMatch?.value ?? '');
      setLines(ex.lines.map((l, i) => ({
        rid: `sl${i}-${Math.random().toString(36).slice(2, 7)}`,
        rawText: l.rawText,
        code: l.skuMatch?.code ?? '',
        suggestedCode: l.skuMatch?.code ?? '',
        confidence: l.skuMatch?.confidence ?? 0,
        reason: l.skuMatch?.reason ?? '',
        qty: l.qtyGuess,
        priceRm: l.priceRmGuess != null ? String(l.priceRmGuess) : '',
        notes: l.notes ?? '',
        fabricCode: l.fabricMatch?.code ?? '',
      })));
    } catch (e) {
      /* authedFetch already throws operator-friendly messages (humanApiError
         runs inside it) — surface the message as-is. */
      setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.');
    } finally {
      setExtracting(false);
    }
  };

  const updateLine = (rid: string, patch: Partial<LineEdit>) =>
    setLines((prev) => (prev ?? []).map((l) => (l.rid === rid ? { ...l, ...patch } : l)));
  const dropLine = (rid: string) =>
    setLines((prev) => (prev ?? []).filter((l) => l.rid !== rid));

  /* "Open in New SO" — confirm the corrections (few-shot pool) then hand the
     reviewed payload to the New SO page via sessionStorage. */
  const openInNewSo = async () => {
    const edited = lines ?? [];
    const phones = phonesText.split('/').map((p) => p.trim()).filter(Boolean);

    // Corrected blob mirrors the extracted slip shape so future few-shot
    // examples teach the extractor the conventions the operator wants.
    const optMatch = (v: string): OptionMatch | null =>
      v ? { value: v, confidence: 1, reason: 'operator-confirmed' } : null;
    const corrected: ExtractedSlip = {
      customerName: customerName || null,
      address: address || null,
      phones,
      location: location || null,
      deliveryDate: deliveryDate || null,
      processingDate: processingDate || null,
      salesRep: salesRep || null,
      paymentMethod: paymentMethod || null,
      depositRm: depositRm.trim() === '' ? null : Number(depositRm) || null,
      totalRm: totalRm.trim() === '' ? null : Number(totalRm) || null,
      remarks: remarks || null,
      paymentMethodMatch:   optMatch(pmValue),
      bankMatch:            optMatch(bankValue),
      onlineTypeMatch:      optMatch(onlineValue),
      installmentPlanMatch: optMatch(planValue),
      customerTypeMatch:    optMatch(custTypeValue),
      buildingTypeMatch:    optMatch(bldgTypeValue),
      locationMatch:        optMatch(venueValue),
      lines: edited.map((l) => ({
        rawText: l.rawText,
        qtyGuess: l.qty,
        priceRmGuess: l.priceRm.trim() === '' ? null : Number(l.priceRm) || null,
        skuMatch: l.code
          ? { code: l.code, confidence: l.code === l.suggestedCode ? l.confidence : 1, reason: l.code === l.suggestedCode ? l.reason : 'operator-picked' }
          : null,
        fabricMatch: l.fabricCode ? { code: l.fabricCode, confidence: 1, reason: 'operator-confirmed' } : null,
        notes: l.notes || null,
      })),
    };
    if (sampleId) {
      // Best-effort — the SO prefill must not be blocked by sample bookkeeping.
      // salesperson rides along so the per-rep pool grows + rules re-distill.
      const rep = (salesperson.trim() || salesRep.trim()) || null;
      authedFetch(`/scan-so/samples/${sampleId}/confirm`, {
        method: 'POST',
        body: JSON.stringify({ corrected, salesperson: rep }),
      }).catch(() => { /* few-shot is best-effort */ });
    }

    const noteParts: string[] = [];
    if (remarks) noteParts.push(remarks);
    if (location) noteParts.push(`Venue/location on slip: ${location}`);
    /* New SO's Venue cell is LOCKED to the salesperson's home venue, so a
       matched venue has no input cell — it rides in the Note instead. */
    if (venueValue && venueValue !== location) noteParts.push(`Venue matched (SO Maintenance): ${venueValue}`);
    if (phones.length > 1) noteParts.push(`Other phone(s): ${phones.slice(1).join(', ')}`);
    if (deliveryDate && !ISO_DATE_RE.test(deliveryDate)) noteParts.push(`Delivery: ${deliveryDate}`);
    if (paymentMethod) noteParts.push(`Payment method on slip: ${paymentMethod}`);
    if (depositRm.trim() !== '') noteParts.push(`Deposit on slip: RM ${depositRm}`);
    if (totalRm.trim() !== '') noteParts.push(`Total on slip: RM ${totalRm}`);
    if (salesRep) noteParts.push(`Sales rep on slip: ${salesRep}`);
    noteParts.push('(Prefilled from scanned slip — verify before saving.)');

    const prefill: ScanPrefill = {
      customerName,
      phone: phones[0] ?? '',
      address1: address,
      note: noteParts.join('\n'),
      deliveryDate: ISO_DATE_RE.test(deliveryDate) ? deliveryDate : null,
      processingDate: ISO_DATE_RE.test(processingDate) ? processingDate : null,
      customerType: custTypeValue,
      buildingType: bldgTypeValue,
      /* Matched method → ONE editable payment-draft row in New SO's
         Payments table. Deposit lands as the row amount (the slip's deposit
         was actually collected — Spec D4 still requires its slip upload
         before save; the operator can zero/delete the row instead). */
      payment: pmValue
        ? {
            methodValue:      pmValue,
            bankValue:        bankValue,
            installmentLabel: planValue,
            onlineTypeValue:  onlineValue,
            depositCenti:     Math.round((Number(depositRm) || 0) * 100),
          }
        : null,
      lines: edited.map((l) => {
        const sku = skuByCode.get(l.code.toUpperCase());
        const remarkParts = [l.rawText && `Slip: ${l.rawText}`, l.notes].filter(Boolean) as string[];
        return {
          itemCode: sku?.code ?? '',
          itemGroup: sku ? (CATEGORY_TO_GROUP[sku.category] ?? 'others') : 'others',
          description: sku?.name ?? l.rawText,
          qty: l.qty > 0 ? l.qty : 1,
          // RM floats from handwriting → centi (×100, rounded).
          unitPriceCenti: Math.round((Number(l.priceRm) || 0) * 100),
          remark: remarkParts.join(' · '),
        };
      }),
    };
    sessionStorage.setItem(SCAN_PREFILL_KEY, JSON.stringify(prefill));
    onClose();
    // HOUZS VENDOR — the New SO page lives at /scm/sales-orders/new here
    // (App.tsx route + the SO list's onNew/copyToNewSo), not 2990's
    // /mfg-sales-orders/new. ?fromScan=1 + the sessionStorage handoff are
    // unchanged — SalesOrderNew's fromScan effect consumes them.
    navigate('/scm/sales-orders/new?fromScan=1');
  };

  /* SO-Maintenance matched-value select — operator confirms/overrides within
     the allowed list only ('' = no match → field stays out of the prefill). */
  const optSelect = (
    label: string,
    value: string,
    onChange: (v: string) => void,
    opts: CatalogOption[],
  ) => (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      <select className={styles.input} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">— no match —</option>
        {sortByText(opts).map((o) => (
          <option key={o.value} value={o.value}>
            {o.label === o.value ? o.label : `${o.label} (${o.value})`}
          </option>
        ))}
      </select>
    </label>
  );

  const confidenceChip = (l: LineEdit) => {
    if (!l.code) return <span className={`${styles.chip} ${styles.chipGrey}`}>no match</span>;
    if (l.code !== l.suggestedCode) return <span className={`${styles.chip} ${styles.chipGrey}`}>manual</span>;
    const pct = Math.round(l.confidence * 100);
    const cls = l.confidence >= 0.8 ? styles.chipGreen : styles.chipYellow;
    return <span className={`${styles.chip} ${cls}`} title={l.reason}>{pct}%</span>;
  };

  const inReview = lines !== null;

  return (
    <div className={styles.modal} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={styles.panel}>
        <div className={styles.head}>
          <div>
            <div className={styles.eyebrow}>Sales Orders</div>
            <h2 className={styles.title}>Scan Order</h2>
            <p className={styles.sub}>
              Photo of a handwritten sale-order slip → reviewed draft in the New SO form.
              Nothing is saved until you save the SO itself.
            </p>
          </div>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="Close">
            <X size={18} strokeWidth={1.75} />
          </button>
        </div>

        <div className={styles.body}>
          {error && <div className={styles.error}>{error}</div>}

          {!inReview && (
            <>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Salesperson (who wrote the slip)</span>
                <input
                  className={styles.input}
                  list="scan-so-salespeople"
                  value={salesperson}
                  placeholder="Leave blank to auto-detect from the slip"
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
            </>
          )}

          {inReview && (
            <>
              {repRules && (
                <div>
                  <span
                    className={`${styles.chip} ${styles.chipGreen}`}
                    title="This rep's distilled handwriting rules were applied to the extraction."
                  >
                    Rules: {sharedAliases ? 'Shared aliases + ' : ''}{repRules.salesperson} ({repRules.sampleCount} sample{repRules.sampleCount === 1 ? '' : 's'})
                  </span>
                </div>
              )}
              <div className={styles.sectionLabel}>Customer</div>
              <div className={styles.grid2}>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Customer name</span>
                  <input className={styles.input} value={customerName} onChange={(e) => setCustomerName(e.target.value)} />
                </label>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Phone(s) — separate with /</span>
                  <input className={styles.input} value={phonesText} onChange={(e) => setPhonesText(e.target.value)} />
                </label>
                <label className={styles.field} style={{ gridColumn: '1 / -1' }}>
                  <span className={styles.fieldLabel}>Address</span>
                  <input className={styles.input} value={address} onChange={(e) => setAddress(e.target.value)} />
                </label>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Venue / location</span>
                  <input className={styles.input} value={location} onChange={(e) => setLocation(e.target.value)} />
                </label>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Sales rep on slip</span>
                  <input className={styles.input} value={salesRep} onChange={(e) => setSalesRep(e.target.value)} />
                </label>
                {optSelect('Venue (matched — goes to Note)', venueValue, setVenueValue, optionLists.venue)}
                {optSelect('Customer type (matched)', custTypeValue, setCustTypeValue, optionLists.customer_type)}
                {optSelect('Building type (matched)', bldgTypeValue, setBldgTypeValue, optionLists.building_type)}
              </div>

              <div className={styles.sectionLabel}>Dates &amp; money</div>
              <div className={styles.grid2}>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Delivery date (YYYY-MM-DD, or text like TBC)</span>
                  <input className={styles.input} value={deliveryDate} onChange={(e) => setDeliveryDate(e.target.value)} />
                </label>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Processing date</span>
                  <input className={styles.input} value={processingDate} onChange={(e) => setProcessingDate(e.target.value)} />
                </label>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Payment notes (as written)</span>
                  <input className={styles.input} value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)} />
                </label>
                {optSelect('Payment method (matched)', pmValue, setPmValue, optionLists.payment_method)}
                {optSelect('Merchant bank (matched)', bankValue, setBankValue, optionLists.payment_merchant)}
                {optSelect('Online type (matched)', onlineValue, setOnlineValue, optionLists.online_type)}
                {optSelect('Installment plan (matched)', planValue, setPlanValue, optionLists.installment_plan)}
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Deposit (RM)</span>
                  <input className={styles.input} value={depositRm} onChange={(e) => setDepositRm(e.target.value)} inputMode="decimal" />
                </label>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Total (RM)</span>
                  <input className={styles.input} value={totalRm} onChange={(e) => setTotalRm(e.target.value)} inputMode="decimal" />
                </label>
              </div>

              <div className={styles.sectionLabel}>Line items</div>
              {(lines ?? []).map((l) => (
                <div key={l.rid} className={styles.lineCard}>
                  {l.rawText && <div className={styles.rawText}>{l.rawText}</div>}
                  <div className={styles.lineRow}>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>
                        SKU {confidenceChip(l)}
                      </span>
                      <input
                        className={styles.input}
                        list="scan-so-sku-options"
                        value={l.code}
                        placeholder="Type to search the SKU master…"
                        onChange={(e) => updateLine(l.rid, { code: e.target.value })}
                      />
                    </label>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>Qty</span>
                      <input
                        className={styles.input}
                        type="number"
                        min={1}
                        value={l.qty}
                        onChange={(e) => updateLine(l.rid, { qty: Math.max(1, Number(e.target.value) || 1) })}
                      />
                    </label>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>Price (RM)</span>
                      <input
                        className={styles.input}
                        value={l.priceRm}
                        inputMode="decimal"
                        onChange={(e) => updateLine(l.rid, { priceRm: e.target.value })}
                      />
                    </label>
                    <button
                      type="button"
                      className={styles.removeBtn}
                      onClick={() => dropLine(l.rid)}
                      aria-label="Remove line"
                    >
                      <Trash2 size={15} strokeWidth={1.75} />
                    </button>
                  </div>
                  {l.code && !skuByCode.has(l.code.toUpperCase()) && (
                    <div className={styles.notes} style={{ color: 'var(--c-festive-b, #B8331F)' }}>
                      Not in the SKU master — the line will land without an item code.
                    </div>
                  )}
                  {(l.notes || l.fabricCode) && (
                    <div className={styles.notes}>
                      {l.fabricCode ? `Fabric: ${l.fabricCode}` : ''}
                      {l.fabricCode && l.notes ? ' · ' : ''}
                      {l.notes}
                    </div>
                  )}
                </div>
              ))}
              <datalist id="scan-so-sku-options">
                {sortByText(skus).map((s) => (
                  <option key={s.code} value={s.code}>{s.name}</option>
                ))}
              </datalist>

              <label className={styles.field}>
                <span className={styles.fieldLabel}>Remarks</span>
                <textarea
                  className={styles.input}
                  rows={2}
                  value={remarks}
                  onChange={(e) => setRemarks(e.target.value)}
                />
              </label>
            </>
          )}
        </div>

        <div className={styles.foot}>
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          {!inReview ? (
            <Button variant="primary" size="sm" onClick={() => void runExtract()} disabled={files.length === 0 || extracting}>
              {extracting
                ? <Loader2 size={ICON.size} strokeWidth={ICON.strokeWidth} className={styles.spin} />
                : <Upload size={ICON.size} strokeWidth={ICON.strokeWidth} />}
              <span>{extracting ? 'Reading slip…' : 'Extract'}</span>
            </Button>
          ) : (
            <Button variant="primary" size="sm" onClick={() => void openInNewSo()}>
              <span>Open in New SO</span>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};
