import { useEffect, useRef, useState } from "react";
import { authedFetch } from "../vendor/scm/lib/authed-fetch";
import { useAuth } from "../auth/AuthContext";
import { normalizePhone, splitE164 } from "../vendor/shared/phone";
import type { ExtractedSlip } from "../vendor/scm/components/ScanOrderModal";
import "./mobile.css";

// Mobile OCR "Scan" screen — capture two phone photos of a handwritten sales
// slip (front slip + payment slip), POST them to POST /api/scm/scan-so/extract,
// then map the EXTRACTED slip into a prefill and hand it to the mobile New SO
// form for the operator to review and save. This mirrors the DESKTOP flow
// (ScanOrderModal -> SalesOrderNew): the backend /scan-so/extract only RETURNS
// extracted data — it never creates a draft — so the operator always reviews
// and saves in the real form, where the learning feedback fires on save.
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
  payment: MobileScanPayment | null;
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

/* Build the mobile New-SO handoff straight from the AI extraction — the SAME
   field mapping desktop's buildPrefill uses, reduced to the mobile form's
   simpler state (free-text venue, plain State/method strings, free-text line
   name). No dropdown reconcile (the mobile form has no dropdown masters). */
function buildPrefill(d: ExtractResp["data"], repName: string): MobileScanPrefill {
  const ex = d.extracted;
  const skuByCode = new Map(d.catalog.skus.map((s) => [s.code.toUpperCase(), s]));

  // Canonical +60 E.164 phones, then split off the national part (the form's
  // +60 prefix box owns the country code). First = main, second = emergency.
  const phonesE164 = (ex.phones ?? [])
    .map((p) => normalizePhone(p) ?? "")
    .filter((p) => p.trim() !== "");
  const mainNational = phonesE164[0] ? splitE164(phonesE164[0]).national : "";
  const emergencyNational = phonesE164[1] ? splitE164(phonesE164[1]).national : "";

  // 3-method model — top-level method is only Merchant / Online / Cash. Fold any
  // legacy "Installment" match to Merchant (a bank EPP is Merchant + a plan).
  const rawPmValue = ex.paymentMethodMatch?.value ?? "";
  const pmValue = rawPmValue === "Installment" ? "Merchant" : rawPmValue;

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
    payment: pmValue
      ? {
          method: pmValue,
          amount:
            ex.depositRm && ex.depositRm > 0
              ? ex.depositRm.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
              : "0.00",
          approval: ex.approvalCode ?? "",
        }
      : null,
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
  const [slots, setSlots] = useState<[Slot, Slot]>([null, null]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const inputRefs = [useRef<HTMLInputElement>(null), useRef<HTMLInputElement>(null)];

  // Revoke every object URL still held when the component unmounts so captured
  // previews don't leak.
  useEffect(() => {
    return () => {
      setSlots((cur) => {
        for (const s of cur) if (s) URL.revokeObjectURL(s.url);
        return cur;
      });
    };
  }, []);

  // Pre-warm the catalog prompt-cache the moment the screen opens so the first
  // /extract pays less. Fire-and-forget — never blocks or errors the screen.
  useEffect(() => {
    authedFetch("/scan-so/warm", { method: "POST" }).catch(() => {});
  }, []);

  const captured = slots.filter(Boolean).length;
  const salesperson = (user?.name || user?.email || "").trim();

  const pick = (idx: 0 | 1) => {
    if (submitting) return;
    inputRefs[idx].current?.click();
  };

  const onFile = (idx: 0 | 1, file: File | undefined) => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setSlots((cur) => {
      const prev = cur[idx];
      if (prev) URL.revokeObjectURL(prev.url);
      const next: [Slot, Slot] = [cur[0], cur[1]];
      next[idx] = { file, url };
      return next;
    });
    setError(null);
  };

  const clearSlot = (idx: 0 | 1) => {
    if (submitting) return;
    setSlots((cur) => {
      const prev = cur[idx];
      if (prev) URL.revokeObjectURL(prev.url);
      const next: [Slot, Slot] = [cur[0], cur[1]];
      next[idx] = null;
      return next;
    });
  };

  const submit = async () => {
    const files = slots.filter((s): s is NonNullable<Slot> => s !== null).map((s) => s.file);
    if (files.length < 2 || submitting) return;
    setSubmitting(true);
    setError(null);
    setUnavailable(false);
    try {
      const form = new FormData();
      for (const f of files) form.append("file", f);
      if (salesperson) form.append("salesperson", salesperson);
      // authedFetch handles the FormData content-type + bearer + long scan
      // timeout. A non-ok reason throws a plain-language message we catch below.
      const res = await authedFetch<ExtractResp>("/scan-so/extract", {
        method: "POST",
        body: form,
      });
      if (res && res.success && res.data) {
        const repName = salesperson || (res.data.extracted.salesRep ?? "").trim();
        onExtracted(buildPrefill(res.data, repName));
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
      <header className="hdr">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div className="ey" style={{ color: "#a16a2e" }}>Capture</div>
            <div style={{ fontSize: 19, fontWeight: 800, color: "#11140f", marginTop: 2 }}>Scan order slip</div>
          </div>
          <span onClick={onBack} role="button" aria-label="Close" style={{ fontSize: 24, color: "#767b6e", cursor: "pointer", lineHeight: 1 }}>
            &times;
          </span>
        </div>
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
            <div style={{ fontSize: 12.5, color: "#767b6e", lineHeight: 1.5, marginBottom: 14 }}>
              Snap the handwritten / printed slip and the payment slip. After scanning, the New Sales Order form opens prefilled — review every field, then save to create the order.
            </div>

            <div id="scan-shots" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 8 }}>
              {[0, 1].map((i) => {
                const idx = i as 0 | 1;
                const slot = slots[idx];
                return (
                  <div key={i}>
                    <input
                      ref={inputRefs[idx]}
                      type="file"
                      accept="image/*"
                      capture="environment"
                      style={{ display: "none" }}
                      onChange={(e) => {
                        onFile(idx, e.target.files?.[0]);
                        e.target.value = "";
                      }}
                    />
                    {slot ? (
                      <div className="ph" style={{ position: "relative", height: 120, borderRadius: 12, overflow: "hidden" }}>
                        <img src={slot.url} alt={SLOT_LABELS[idx]} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                        <span style={{ position: "absolute", top: 6, right: 6, width: 20, height: 20, borderRadius: "50%", background: "#2f8a5b", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center" }}>
                          {CHECK}
                        </span>
                        {!submitting && (
                          <button
                            onClick={() => clearSlot(idx)}
                            aria-label={`Retake ${SLOT_LABELS[idx]}`}
                            style={{ position: "absolute", bottom: 6, right: 6, height: 24, padding: "0 9px", borderRadius: 999, border: "none", background: "rgba(17,20,15,.62)", color: "#fff", fontFamily: "inherit", fontSize: 10.5, fontWeight: 700, cursor: "pointer" }}
                          >
                            Retake
                          </button>
                        )}
                      </div>
                    ) : (
                      <button
                        onClick={() => pick(idx)}
                        disabled={submitting}
                        style={{ height: 120, width: "100%", border: "1px dashed #c2c6bd", borderRadius: 12, background: "#f4f6f3", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, cursor: submitting ? "default" : "pointer", fontFamily: "inherit", opacity: submitting ? 0.5 : 1 }}
                      >
                        {CAMERA}
                        <span style={{ fontSize: 11, fontWeight: 700, color: "#16695f" }}>{SLOT_LABELS[idx]}</span>
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            <div style={{ fontSize: 10.5, color: "#9aa093", textAlign: "center" }}>Front slip + payment slip · 2 photos</div>

            {salesperson && (
              <div style={{ marginTop: 16, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 11, color: "#767b6e" }}>
                <span className="ey" style={{ letterSpacing: ".14em", color: "#9aa093" }}>Salesperson</span>
                <span style={{ fontWeight: 700, color: "#414539" }}>{salesperson}</span>
              </div>
            )}

            {submitting && (
              <div style={{ marginTop: 16, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, fontSize: 12, color: "#767b6e" }}>
                <span style={{ width: 14, height: 14, borderRadius: "50%", border: "2px solid rgba(22,105,95,.3)", borderTopColor: "#16695f", animation: "hzSpin .8s linear infinite" }} />
                Reading the slip — this can take a moment.
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
            disabled={captured < 2 || submitting}
            style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 9, cursor: captured < 2 || submitting ? "default" : "pointer", opacity: captured < 2 || submitting ? 0.5 : 1 }}
          >
            {submitting && (
              <span style={{ width: 16, height: 16, borderRadius: "50%", border: "2px solid rgba(255,255,255,.45)", borderTopColor: "#fff", animation: "hzSpin .8s linear infinite" }} />
            )}
            {submitting ? "Scanning slip…" : "Scan & open New SO"}
          </button>
        </footer>
      )}

      <style>{`@keyframes hzSpin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
