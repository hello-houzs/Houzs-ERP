import { useEffect, useRef, useState } from "react";
import { authedFetch } from "../vendor/scm/lib/authed-fetch";
import { useAuth } from "../auth/AuthContext";
import { normalizePhone, splitE164 } from "../vendor/shared/phone";
import type { ExtractedSlip } from "../vendor/scm/components/ScanOrderModal";
import "./mobile.css";

// Mobile OCR "Scan" screen — capture phone photos of a handwritten sales
// slip (ONE front slip + ONE OR MORE payment slips), POST them to
// POST /api/scm/scan-so/extract, then map the EXTRACTED slip into a prefill and
// hand it to the mobile New SO form for the operator to review and save. This
// mirrors the DESKTOP flow (ScanOrderModal -> SalesOrderNew): the backend
// /scan-so/extract only RETURNS extracted data — it never creates a draft — so
// the operator always reviews and saves in the real form, where the learning
// feedback fires on save.
//
// MULTIPLE PAYMENT SLIPS — an order can take 2-3 payments (deposit + balances),
// and each physical slip / card-terminal receipt is ONE payment. The front slip
// stays single; the payment slip becomes an ARRAY (add-more + per-slip remove).
// Because the current /scan-so/extract contract reads exactly ONE order slip +
// ONE payment receipt into a SINGLE payment, we OCR each payment slip in its
// OWN /extract call (front slip attached to every call so the order fields are
// read once and each call's single payment is the k-th slip's payment). We then
// merge: the FIRST call supplies the order + payment #1, calls 2..N each supply
// one more payment. This yields N payments per N slips end-to-end WITHOUT any
// backend change — each call uses the existing 1-slip + 1-receipt contract
// verbatim. (See the report note for the alternative single-call array contract
// if the backend later grows a paymentFiles[]/payments[] mode.)
//
// Camera capture uses a hidden <input type="file" accept="image/*"
// capture="environment"> per slot — the standard PWA pattern that opens the
// phone's rear camera on tap. No getUserMedia / live video.
//
// The multipart POST reuses authedFetch: it stamps the bearer from
// localStorage['auth:token'], leaves the multipart content-type to the browser
// (so the boundary is set correctly), and applies the long scan timeout for the
// /scan- path. A missing ANTHROPIC_API_KEY (staging) returns 503
// anthropic_key_missing, which we surface as a clear "not available here" note.

type Slot = { file: File; url: string } | null;

/* ── /scan-so/extract response shape (subset the mobile flow consumes) ─────
   The SO scan endpoint returns sampleId + imageKey + receiptImageKey (NOT
   uploadSessionId — that belongs to scan-payment). extracted is the slip;
   catalog.skus lets us resolve a matched SKU code to a display name. */
type SkuMatch = { code: string; confidence: number; reason: string };
type CatalogSku = { code: string; name: string; category: string; baseModel: string | null };
type ExtractResp = {
  success: boolean;
  data: {
    sampleId: string | null;
    imageKey?: string | null;
    receiptImageKey?: string | null;
    extracted: ExtractedSlip;
    warnings: Array<{ field: string; value: string; message: string; lineIdx?: number }>;
    catalog: { skus: CatalogSku[]; fabrics: Array<{ code: string; description: string | null }> };
  };
};

/* ── Handoff contract with MobileNewSO ───────────────────────────────────
   A dropdown-agnostic prefill mapped to the mobile New SO form's simpler
   state shape (free-text venue, plain State/method strings). Carries the
   sampleId + salesperson + frozen AI-original so the New SO save can run the
   same edit-gate learning POST desktop does (/scan-so/samples/:id/confirm). */
export type MobileScanLine = {
  name: string; // matched SKU name, else the raw slip text (operator edits)
  qty: string;
  price: string; // RM
  remark: string;
  /* Learning carry-through — the verbatim slip row + the AI's SKU guess, so the
     New SO save can pair the operator's final line against the AI original. */
  rawText: string;
  suggestedCode: string;
  confidence: number;
  itemCode: string; // the SKU code the scan matched ('' = no match)
};
export type MobileScanPayment = {
  method: string; // Cash / Merchant / Online (3-method model)
  amount: string; // RM
  approval: string;
};
/* One captured payment slip = ONE payment. Carries the OCR'd values PLUS the
   captured File so the New SO form can pre-attach it to the payment row and
   upload it (a payment row is only RECORDED once it has an uploaded slip). The
   front slip has no such carrier — it seeds the order header, not a payment. */
export type MobileScanPaymentSlip = MobileScanPayment & {
  file: File; // the captured payment-slip image, for the New SO row's slip upload
};
export type MobileScanPrefill = {
  name: string;
  phone: string; // national digits (no +60 — the form's prefix box owns it)
  emergencyPhone: string; // second slip number → emergency contact
  address1: string;
  state: string;
  city: string;
  postcode: string;
  custRef: string;
  note: string;
  deliveryDate: string; // '' when none / not a clean date
  processingDate: string;
  customerType: string;
  buildingType: string;
  venue: string; // raw slip location text (mobile venue is free-text)
  /* First payment (back-compat) — kept so the mobile New SO form's existing
     single-payment seed keeps working unchanged. Equals payments[0] ?? null. */
  payment: MobileScanPayment | null;
  /* ALL payments — one entry per captured payment slip, each OCR'd in its own
     /extract call and carrying its captured File for the New SO row's slip
     upload. Empty when no payment slip was captured. The New SO form should seed
     ONE payment row per entry (see report note). */
  payments: MobileScanPaymentSlip[];
  lines: MobileScanLine[];
  /* Edit-gate carry-through — mirrors desktop's ScanPrefill. */
  sampleId: string | null;
  salesperson: string | null;
  aiOriginal: ExtractedSlip;
};

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/* mfg_product_category → the mobile line has no itemGroup; we only surface a
   display name, so category isn't needed here (kept minimal). */

const CHECK = (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

const CAMERA = (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#16695f" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z" />
    <circle cx="12" cy="13" r="3" />
  </svg>
);

const SLOT_LABELS = ["Front slip", "Payment slip"];

/* Map ONE extracted slip's payment fields into the mobile payment shape, or
   null when the slip carries no payment. Shared by the front-slip extraction
   (payment #1) and every additional payment-slip extraction (payments #2..N) so
   they resolve method/amount/approval identically. */
function extractPayment(ex: ExtractedSlip): MobileScanPayment | null {
  // 3-method model — top-level method is only Merchant / Online / Cash. Fold any
  // legacy "Installment" match to Merchant (a bank EPP is Merchant + a plan).
  const rawPmValue = ex.paymentMethodMatch?.value ?? "";
  const pmValue = rawPmValue === "Installment" ? "Merchant" : rawPmValue;
  if (!pmValue) return null;
  return {
    method: pmValue,
    amount:
      ex.depositRm && ex.depositRm > 0
        ? ex.depositRm.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : "0.00",
    approval: ex.approvalCode ?? "",
  };
}

/* Build the mobile New-SO handoff straight from the AI extraction — the SAME
   field mapping desktop's buildPrefill uses, reduced to the mobile form's
   simpler state (free-text venue, plain State/method strings, free-text line
   name). No dropdown reconcile (the mobile form has no dropdown masters).

   `paymentSlips` is the per-slip payment + captured File for EVERY payment slip
   (one per /extract call, in capture order). The prefill's back-compat `payment`
   field is set to the first entry so the existing single-payment New SO seed
   keeps working; `payments` carries the full array. */
function buildPrefill(
  d: ExtractResp["data"],
  repName: string,
  paymentSlips: MobileScanPaymentSlip[],
): MobileScanPrefill {
  const ex = d.extracted;
  const skuByCode = new Map(d.catalog.skus.map((s) => [s.code.toUpperCase(), s]));

  // Canonical +60 E.164 phones, then split off the national part (the form's
  // +60 prefix box owns the country code). First = main, second = emergency.
  const phonesE164 = (ex.phones ?? [])
    .map((p) => normalizePhone(p) ?? "")
    .filter((p) => p.trim() !== "");
  const mainNational = phonesE164[0] ? splitE164(phonesE164[0]).national : "";
  const emergencyNational = phonesE164[1] ? splitE164(phonesE164[1]).national : "";

  return {
    name: ex.customerName ?? "",
    phone: mainNational,
    emergencyPhone: emergencyNational,
    // Prefer the parsed street-only line so State/City/Postcode don't double up.
    address1: ex.addressLine1 ?? ex.address ?? "",
    state: ex.addressStateMatch?.value ?? "",
    city: ex.city ?? "",
    postcode: ex.postcode ?? "",
    custRef: ex.customerSoRef ?? "",
    note: ex.remarks ?? "",
    deliveryDate: ex.deliveryDate && ISO_DATE_RE.test(ex.deliveryDate) ? ex.deliveryDate : "",
    processingDate: ex.processingDate && ISO_DATE_RE.test(ex.processingDate) ? ex.processingDate : "",
    customerType: ex.customerTypeMatch?.value ?? "",
    buildingType: ex.buildingTypeMatch?.value ?? "",
    // Mobile venue is free text — seed the raw slip location (nothing lost).
    venue: ex.location ?? "",
    // Back-compat first payment = payments[0] (the existing single-payment New
    // SO seed reads this). Falls back to the front slip's own payment when no
    // payment-slip-specific extraction produced one.
    payment: paymentSlips[0] ? { method: paymentSlips[0].method, amount: paymentSlips[0].amount, approval: paymentSlips[0].approval } : extractPayment(ex),
    // One payment per captured payment slip, each with its captured File.
    payments: paymentSlips,
    lines: (ex.lines ?? []).map((l) => {
      const code = l.skuMatch?.code ?? "";
      const sku = code ? skuByCode.get(code.toUpperCase()) : undefined;
      const qty = l.qtyGuess > 0 ? l.qtyGuess : 1;
      const price = ((l.priceRmGuess ?? 0)).toLocaleString("en-MY", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      return {
        // Matched SKU name, else the raw slip text so the operator has the
        // handwriting to type the real item against (never lost).
        name: sku?.name ?? l.rawText ?? "",
        qty: String(qty),
        price,
        remark: "",
        rawText: l.rawText ?? "",
        suggestedCode: code,
        confidence: l.skuMatch?.confidence ?? 0,
        itemCode: sku?.code ?? "",
      };
    }),
    sampleId: d.sampleId,
    salesperson: repName || (ex.salesRep ?? "") || null,
    aiOriginal: ex,
  };
}

export function MobileScan({
  onBack,
  onExtracted,
}: {
  onBack: () => void;
  onExtracted: (prefill: MobileScanPrefill) => void;
}) {
  const { user } = useAuth();
  // Front slip = single; payment slips = an ARRAY (one per payment). A NonNull
  // Slot is { file, url }; front is null until captured.
  const [front, setFront] = useState<Slot>(null);
  const [payShots, setPayShots] = useState<{ file: File; url: string }[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const frontInputRef = useRef<HTMLInputElement>(null);
  // ONE hidden payment input, re-targeted per capture (add-more taps the same
  // input; each pick appends a new slip). capture="environment" opens the rear
  // camera each time.
  const payInputRef = useRef<HTMLInputElement>(null);

  // Revoke every object URL still held when the component unmounts so captured
  // previews don't leak. Latest front + payShots are read via the setters so we
  // never close over a stale list.
  useEffect(() => {
    return () => {
      setFront((cur) => {
        if (cur) URL.revokeObjectURL(cur.url);
        return cur;
      });
      setPayShots((cur) => {
        for (const s of cur) URL.revokeObjectURL(s.url);
        return cur;
      });
    };
  }, []);

  // Pre-warm the catalog prompt-cache the moment the screen opens so the first
  // /extract pays less. Fire-and-forget — never blocks or errors the screen.
  useEffect(() => {
    authedFetch("/scan-so/warm", { method: "POST" }).catch(() => {});
  }, []);

  const salesperson = (user?.name || user?.email || "").trim();
  // Ready to scan once the front slip AND at least one payment slip are captured.
  const ready = front !== null && payShots.length > 0;

  const pickFront = () => {
    if (submitting) return;
    frontInputRef.current?.click();
  };
  const pickPayment = () => {
    if (submitting) return;
    payInputRef.current?.click();
  };

  const onFrontFile = (file: File | undefined) => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setFront((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return { file, url };
    });
    setError(null);
  };
  const clearFront = () => {
    if (submitting) return;
    setFront((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return null;
    });
  };

  // Append a captured payment slip (each = one payment). No cap — an order can
  // take as many payments as slips.
  const addPayFile = (file: File | undefined) => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setPayShots((cur) => [...cur, { file, url }]);
    setError(null);
  };
  const removePayShot = (i: number) => {
    if (submitting) return;
    setPayShots((cur) => {
      const gone = cur[i];
      if (gone) URL.revokeObjectURL(gone.url);
      return cur.filter((_, k) => k !== i);
    });
  };

  // POST the front slip + ONE payment slip to /scan-so/extract. The existing
  // contract reads exactly one order slip + one payment receipt into a single
  // payment, so one call per payment slip yields one payment per slip. The front
  // slip rides EVERY call (order fields are read identically each time; we keep
  // the FIRST response's order + this call's single payment).
  const extractOne = (payFile: File): Promise<ExtractResp> => {
    const form = new FormData();
    if (front) form.append("file", front.file);
    form.append("file", payFile);
    if (salesperson) form.append("salesperson", salesperson);
    // authedFetch handles the FormData content-type + bearer + long scan
    // timeout. A non-ok reason throws a plain-language message we catch below.
    return authedFetch<ExtractResp>("/scan-so/extract", { method: "POST", body: form });
  };

  const submit = async () => {
    if (!ready || submitting) return;
    setSubmitting(true);
    setError(null);
    setUnavailable(false);
    try {
      // OCR each payment slip in its own call (front slip attached to every
      // call). Sequential — the shared catalog prompt-cache stays warm across
      // calls and we avoid hammering Anthropic with parallel spikes. Call k's
      // single payment becomes payment #k; the FIRST call also supplies the
      // whole order header + line items.
      const responses: ExtractResp[] = [];
      for (const shot of payShots) {
        responses.push(await extractOne(shot.file));
      }
      const first = responses[0];
      if (first && first.success && first.data) {
        const repName = salesperson || (first.data.extracted.salesRep ?? "").trim();
        // One MobileScanPaymentSlip per captured slip: the per-call OCR'd payment
        // (falling back to a blank-method / zeroed row when a call couldn't read a
        // payment, so the slip is never silently dropped — the operator picks the
        // method and fixes the amount) + the captured File for the New SO row's
        // slip upload.
        const paymentSlips: MobileScanPaymentSlip[] = payShots.map((shot, i) => {
          const res = responses[i];
          const pm = res && res.success && res.data ? extractPayment(res.data.extracted) : null;
          return {
            method: pm?.method ?? "",
            amount: pm?.amount ?? "0.00",
            approval: pm?.approval ?? "",
            file: shot.file,
          };
        });
        onExtracted(buildPrefill(first.data, repName, paymentSlips));
      } else {
        setError("The scan couldn't be processed. Please try again.");
      }
    } catch (e) {
      // Staging has no ANTHROPIC_API_KEY → /extract returns 503
      // anthropic_key_missing. Surface a clear "not available here" note instead
      // of the raw wrangler instruction humanApiError would otherwise pass
      // through. The error object carries the raw status/body for this check.
      const err = e as Error & { status?: number; body?: string };
      const keyMissing =
        err.status === 503 || (typeof err.body === "string" && err.body.includes("anthropic_key_missing"));
      if (keyMissing) {
        setUnavailable(true);
      } else {
        setError(err instanceof Error ? err.message : "The scan couldn't be processed. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      {/* Spec #scan: back "Cancel" chevron, screen-title, helper sub-line. */}
      <header className="hdr">
        <div className="hdr-row">
          <button onClick={onBack} className="back" aria-label="Cancel">
            <span className="chev">{"‹"}</span> Cancel
          </button>
        </div>
        <div className="scr-title" style={{ marginTop: 2 }}>Scan order slip</div>
        <div style={{ fontSize: 11, color: "#767b6e", marginTop: 2 }}>Snap the slip — we OCR it in the background into a draft SO.</div>
      </header>

      <div className="scroll" style={{ padding: 14, paddingBottom: 120 }}>
        {unavailable ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", padding: "34px 12px 8px" }}>
            <div style={{ width: 64, height: 64, borderRadius: "50%", background: "#f4ecdf", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 16 }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#a16a2e" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" /></svg>
            </div>
            <div style={{ fontSize: 17, fontWeight: 800, color: "#11140f", marginBottom: 8 }}>Scan isn't available yet</div>
            <div style={{ fontSize: 12.5, color: "#767b6e", lineHeight: 1.55, maxWidth: 280 }}>
              Slip scanning isn't switched on in this environment yet. You can still create the order by hand from the New Sales Order form.
            </div>
            <button onClick={() => setUnavailable(false)} style={{ marginTop: 26, height: 48, padding: "0 22px", borderRadius: 12, border: "1px solid #16695f", background: "#fff", color: "#16695f", fontFamily: "inherit", fontSize: 14, fontWeight: 700, cursor: "pointer" }}>
              Back to capture
            </button>
          </div>
        ) : (
          <>
            {/* Hidden inputs: one for the front slip, one re-targeted for every
                payment-slip capture. capture="environment" opens the rear camera. */}
            <input
              ref={frontInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              style={{ display: "none" }}
              onChange={(e) => {
                onFrontFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <input
              ref={payInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              style={{ display: "none" }}
              onChange={(e) => {
                addPayFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />

            {/* FRONT SLIP — single. */}
            <div className="ey" style={{ letterSpacing: ".14em", color: "#9aa093", fontSize: 10.5, marginBottom: 6 }}>{SLOT_LABELS[0]}</div>
            {front ? (
              <div className="ph" style={{ position: "relative", height: 130, borderRadius: 12, overflow: "hidden", marginBottom: 4 }}>
                <img src={front.url} alt={SLOT_LABELS[0]} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                <span style={{ position: "absolute", top: 6, right: 6, width: 20, height: 20, borderRadius: "50%", background: "#2f8a5b", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  {CHECK}
                </span>
                {!submitting && (
                  <button
                    onClick={clearFront}
                    aria-label={`Retake ${SLOT_LABELS[0]}`}
                    style={{ position: "absolute", bottom: 6, right: 6, height: 24, padding: "0 9px", borderRadius: 999, border: "none", background: "rgba(17,20,15,.62)", color: "#fff", fontFamily: "inherit", fontSize: 10.5, fontWeight: 700, cursor: "pointer" }}
                  >
                    Retake
                  </button>
                )}
              </div>
            ) : (
              <button
                onClick={pickFront}
                disabled={submitting}
                style={{ height: 130, width: "100%", border: "1px dashed #c2c6bd", borderRadius: 12, background: "#f4f6f3", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, cursor: submitting ? "default" : "pointer", fontFamily: "inherit", opacity: submitting ? 0.5 : 1, marginBottom: 4 }}
              >
                {CAMERA}
                <span style={{ fontSize: 11, fontWeight: 700, color: "#16695f" }}>{SLOT_LABELS[0]}</span>
              </button>
            )}

            {/* PAYMENT SLIPS — one photo per payment. Add-more tile + thumbnail
                list with a per-slip remove. Each slip becomes its own payment on
                the draft SO. */}
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginTop: 16, marginBottom: 6 }}>
              <span className="ey" style={{ letterSpacing: ".14em", color: "#9aa093", fontSize: 10.5 }}>Payment slips</span>
              <span style={{ fontSize: 10.5, color: "#9aa093" }}>
                {payShots.length === 0 ? "One photo per payment" : `${payShots.length} payment${payShots.length === 1 ? "" : "s"}`}
              </span>
            </div>
            <div id="scan-pay-shots" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
              {payShots.map((shot, i) => (
                <div key={shot.url} className="ph" style={{ position: "relative", height: 96, borderRadius: 12, overflow: "hidden" }}>
                  <img src={shot.url} alt={`Payment ${i + 1}`} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                  <span style={{ position: "absolute", top: 5, left: 5, height: 18, minWidth: 18, padding: "0 5px", borderRadius: 999, background: "rgba(17,20,15,.62)", color: "#fff", fontSize: 10, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    {i + 1}
                  </span>
                  {!submitting && (
                    <button
                      onClick={() => removePayShot(i)}
                      aria-label={`Remove payment ${i + 1}`}
                      style={{ position: "absolute", top: 5, right: 5, width: 20, height: 20, borderRadius: "50%", border: "none", background: "rgba(178,58,58,.9)", color: "#fff", fontFamily: "inherit", fontSize: 13, lineHeight: 1, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
                    >
                      {"×"}
                    </button>
                  )}
                </div>
              ))}
              <button
                onClick={pickPayment}
                disabled={submitting}
                aria-label={payShots.length === 0 ? SLOT_LABELS[1] : "Add another payment slip"}
                style={{ height: 96, width: "100%", border: "1px dashed #c2c6bd", borderRadius: 12, background: "#f4f6f3", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 5, cursor: submitting ? "default" : "pointer", fontFamily: "inherit", opacity: submitting ? 0.5 : 1 }}
              >
                {CAMERA}
                <span style={{ fontSize: 10.5, fontWeight: 700, color: "#16695f", textAlign: "center", lineHeight: 1.25 }}>
                  {payShots.length === 0 ? SLOT_LABELS[1] : "Add payment"}
                </span>
              </button>
            </div>
            <div style={{ fontSize: 10.5, color: "#9aa093", textAlign: "center", marginTop: 10 }}>
              1 front slip + {payShots.length || 1} payment slip{(payShots.length || 1) === 1 ? "" : "s"} · each payment slip = one payment
            </div>

            {/* Design #scan: amber helper note box (design's #f3ece0 / #e8dcc5 /
                #6a4a1e amber trio). Copy reflects our real flow — the scan opens
                the New SO form prefilled for review, it does not silently create a
                background draft. */}
            <div style={{ display: "flex", alignItems: "flex-start", gap: 9, background: "#f3ece0", border: "1px solid #e8dcc5", borderRadius: 11, padding: 11, marginTop: 12, fontSize: 11, color: "#6a4a1e", lineHeight: 1.5 }}>
              We read the slip and open the New Sales Order form prefilled. Review every field, correct anything the reader missed, then save to create the order.
            </div>

            {salesperson && (
              <div style={{ marginTop: 16, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 11, color: "#767b6e" }}>
                <span className="ey" style={{ letterSpacing: ".14em", color: "#9aa093" }}>Salesperson</span>
                <span style={{ fontWeight: 700, color: "#414539" }}>{salesperson}</span>
              </div>
            )}

            {submitting && (
              <div style={{ marginTop: 16, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, fontSize: 12, color: "#767b6e" }}>
                <span style={{ width: 14, height: 14, borderRadius: "50%", border: "2px solid rgba(22,105,95,.3)", borderTopColor: "#16695f", animation: "hzSpin .8s linear infinite" }} />
                {payShots.length > 1
                  ? `Reading the slip and ${payShots.length} payments — this can take a moment.`
                  : "Reading the slip — this can take a moment."}
              </div>
            )}

            {error && (
              <div style={{ marginTop: 16, background: "#f8eaea", border: "1px solid #f0d4d4", borderRadius: 11, padding: "11px 13px", fontSize: 12, color: "#b23a3a", lineHeight: 1.5 }}>
                {error}
              </div>
            )}
          </>
        )}
      </div>

      {!unavailable && (
        <footer className="actbar">
          <button
            id="scan-submit"
            className="btn"
            onClick={submit}
            disabled={!ready || submitting}
            style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 9, cursor: !ready || submitting ? "default" : "pointer", opacity: !ready || submitting ? 0.5 : 1 }}
          >
            {submitting && (
              <span style={{ width: 16, height: 16, borderRadius: "50%", border: "2px solid rgba(255,255,255,.45)", borderTopColor: "#fff", animation: "hzSpin .8s linear infinite" }} />
            )}
            {submitting
              ? payShots.length > 1 ? "Scanning slips…" : "Scanning slip…"
              : "Scan & open New SO"}
          </button>
        </footer>
      )}

      <style>{`@keyframes hzSpin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
