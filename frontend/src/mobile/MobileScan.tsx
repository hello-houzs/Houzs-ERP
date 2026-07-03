import { useEffect, useRef, useState, type CSSProperties } from "react";
import { authedFetch } from "../vendor/scm/lib/authed-fetch";
import { useAuth } from "../auth/AuthContext";
import { normalizePhone, splitE164 } from "../vendor/shared/phone";
import type { ExtractedSlip } from "../vendor/scm/components/ScanOrderModal";
import { createDraftFromPrefill } from "./MobileNewSO";
import { serviceNotify } from "../vendor/scm/lib/dialog-service";
import "./mobile.css";

// Mobile OCR "Scan" screen — capture phone photos of a handwritten sales
// slip, POST them to POST /api/scm/scan-so/extract, map the EXTRACTED slip into
// a prefill, then IMMEDIATELY create a DRAFT sales order from it in the
// background (owner: "OCR 了直接進 SO draft 做"). The operator does NOT review the
// form first — the scan reads the slip and lands a DRAFT in Orders, which the
// operator opens and reviews there later.
//
// The draft-create reuses the New SO form's exact create call via the exported
// createDraftFromPrefill(prefill) helper (same POST /mfg-sales-orders, dates
// null → DRAFT, same body/line shaping, same server-side honest pricing). The
// backend /scan-so/extract still only RETURNS extracted data; the draft is
// minted by the reused create endpoint, not by /extract.
//
// SURVIVES NAVIGATION — the create fetch is FIRED (not awaited before we leave):
// once it's in flight it completes even if the operator has navigated away or
// pressed Cancel in-app, so a draft still lands in Orders. (One limitation: a
// full app/tab CLOSE mid-flight can still drop an in-flight create — only a
// server-side job would fully survive that. See the report note.)
//
// MULTIPLE ORDERS PER SESSION — the operator often has a stack of slips. This
// screen models the session as an ARRAY of orders, each its own front slip +
// payment-slip array: OrderDraft = { front, payShots[] }. "+ Add order" queues
// another order; each order is captured and grouped under its own "Order N"
// header. The "each payment slip = one payment" rule stays PER ORDER.
//
// MULTIPLE PAYMENT SLIPS (per order) — an order can take 2-3 payments (deposit +
// balances), and each physical slip / card-terminal receipt is ONE payment. The
// front slip stays single per order; the payment slip is an ARRAY (add-more +
// per-slip remove). Because the current /scan-so/extract contract reads exactly
// ONE order slip + ONE payment receipt into a SINGLE payment, we OCR each
// payment slip in its OWN /extract call (that order's front slip attached to
// every call so the order fields are read once and each call's single payment is
// the k-th slip's payment). We then merge: the FIRST call supplies the order +
// payment #1, calls 2..N each supply one more payment. This yields N payments
// per N slips end-to-end WITHOUT any backend change — each call uses the existing
// 1-slip + 1-receipt contract verbatim. (See the report note for the alternative
// single-call array contract if the backend later grows a paymentFiles[]/
// payments[] mode.)
//
// DELETE — every uploaded thumbnail (front + payment, in every order) carries a
// small "×" remove control so a wrong capture can be dropped before submitting.
//
// MULTI-ORDER — because we now create the draft ourselves (no single-prefill
// handoff limit), EVERY queued order becomes its own DRAFT: we OCR each order
// and fire one createDraftFromPrefill per order. N orders → N drafts in Orders.
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

type Shot = { file: File; url: string };
type Slot = Shot | null;

/* One queued order in the session: a single front slip + its payment slips.
   `id` is a stable client key for React lists + remove (independent of array
   index so removing an order doesn't reshuffle keys). */
type OrderDraft = { id: string; front: Slot; payShots: Shot[] };

let ORDER_SEQ = 0;
const newOrder = (): OrderDraft => ({ id: `ord-${++ORDER_SEQ}-${Date.now()}`, front: null, payShots: [] });

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

/* A small red "×" delete control reused for every uploaded thumbnail (front +
   payment). Position is supplied by the caller. */
function RemoveButton({ label, onClick, style }: { label: string; onClick: () => void; style: CSSProperties }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      style={{ width: 20, height: 20, borderRadius: "50%", border: "none", background: "rgba(178,58,58,.92)", color: "#fff", fontFamily: "inherit", fontSize: 13, lineHeight: 1, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", ...style }}
    >
      {"×"}
    </button>
  );
}

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
  onDrafted,
}: {
  onBack: () => void;
  /* Called after the scan has FIRED the background draft-create(s) and we're
     returning to the Orders list. `count` = how many drafts are being created.
     The parent shows the "Draft saved to Orders" toast + nudges the SO-list
     refetch so the new draft surfaces without a manual reload. */
  onDrafted: (count: number) => void;
}) {
  const { user } = useAuth();
  // The session is an ARRAY of orders. Each order = one front slip + N payment
  // slips. Start with a single empty order. `activeOrderId` is which order the
  // hidden camera inputs currently target (set right before .click()).
  const [orders, setOrders] = useState<OrderDraft[]>(() => [newOrder()]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  // ONE hidden front input + ONE hidden payment input, both re-targeted to the
  // active order right before each capture. capture="environment" opens the rear
  // camera each time.
  const frontInputRef = useRef<HTMLInputElement>(null);
  const payInputRef = useRef<HTMLInputElement>(null);
  const activeOrderIdRef = useRef<string | null>(null);

  // Revoke every object URL still held when the component unmounts so captured
  // previews don't leak. Latest orders are read via the setter so we never close
  // over a stale list.
  useEffect(() => {
    return () => {
      setOrders((cur) => {
        for (const o of cur) {
          if (o.front) URL.revokeObjectURL(o.front.url);
          for (const s of o.payShots) URL.revokeObjectURL(s.url);
        }
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
  // The session is submittable once EVERY queued order has its front slip AND at
  // least one payment slip. (An order that's still blank blocks submit — the
  // operator should finish it or remove it.)
  const ready = orders.length > 0 && orders.every((o) => o.front !== null && o.payShots.length > 0);
  const multiOrder = orders.length > 1;

  const pickFront = (orderId: string) => {
    if (submitting) return;
    activeOrderIdRef.current = orderId;
    frontInputRef.current?.click();
  };
  const pickPayment = (orderId: string) => {
    if (submitting) return;
    activeOrderIdRef.current = orderId;
    payInputRef.current?.click();
  };

  const onFrontFile = (file: File | undefined) => {
    if (!file) return;
    const orderId = activeOrderIdRef.current;
    if (!orderId) return;
    const url = URL.createObjectURL(file);
    setOrders((cur) =>
      cur.map((o) => {
        if (o.id !== orderId) return o;
        if (o.front) URL.revokeObjectURL(o.front.url);
        return { ...o, front: { file, url } };
      }),
    );
    setError(null);
  };
  const clearFront = (orderId: string) => {
    if (submitting) return;
    setOrders((cur) =>
      cur.map((o) => {
        if (o.id !== orderId) return o;
        if (o.front) URL.revokeObjectURL(o.front.url);
        return { ...o, front: null };
      }),
    );
  };

  // Append a captured payment slip to the active order (each = one payment). No
  // cap — an order can take as many payments as slips.
  const addPayFile = (file: File | undefined) => {
    if (!file) return;
    const orderId = activeOrderIdRef.current;
    if (!orderId) return;
    const url = URL.createObjectURL(file);
    setOrders((cur) => cur.map((o) => (o.id === orderId ? { ...o, payShots: [...o.payShots, { file, url }] } : o)));
    setError(null);
  };
  const removePayShot = (orderId: string, i: number) => {
    if (submitting) return;
    setOrders((cur) =>
      cur.map((o) => {
        if (o.id !== orderId) return o;
        const gone = o.payShots[i];
        if (gone) URL.revokeObjectURL(gone.url);
        return { ...o, payShots: o.payShots.filter((_, k) => k !== i) };
      }),
    );
  };

  const addOrder = () => {
    if (submitting) return;
    setOrders((cur) => [...cur, newOrder()]);
    setError(null);
  };
  // Remove a whole order (and revoke its previews). Never let the list go empty —
  // removing the last order resets it to a fresh blank one.
  const removeOrder = (orderId: string) => {
    if (submitting) return;
    setOrders((cur) => {
      const gone = cur.find((o) => o.id === orderId);
      if (gone) {
        if (gone.front) URL.revokeObjectURL(gone.front.url);
        for (const s of gone.payShots) URL.revokeObjectURL(s.url);
      }
      const next = cur.filter((o) => o.id !== orderId);
      return next.length ? next : [newOrder()];
    });
  };

  // POST one order's front slip + ONE payment slip to /scan-so/extract. The
  // existing contract reads exactly one order slip + one payment receipt into a
  // single payment, so one call per payment slip yields one payment per slip. The
  // order's front slip rides EVERY call (order fields are read identically each
  // time; we keep the FIRST response's order + this call's single payment).
  const extractOne = (front: Shot, payFile: File): Promise<ExtractResp> => {
    const form = new FormData();
    form.append("file", front.file);
    form.append("file", payFile);
    if (salesperson) form.append("salesperson", salesperson);
    // authedFetch handles the FormData content-type + bearer + long scan
    // timeout. A non-ok reason throws a plain-language message we catch below.
    return authedFetch<ExtractResp>("/scan-so/extract", { method: "POST", body: form });
  };

  // OCR one order into a prefill (front slip + all its payment slips → one
  // header + one payment per slip). Returns null when the first call fails.
  const extractOrder = async (order: OrderDraft): Promise<MobileScanPrefill | null> => {
    if (!order.front || order.payShots.length === 0) return null;
    const responses: ExtractResp[] = [];
    for (const shot of order.payShots) {
      responses.push(await extractOne(order.front, shot.file));
    }
    const first = responses[0];
    if (!first || !first.success || !first.data) return null;
    const repName = salesperson || (first.data.extracted.salesRep ?? "").trim();
    // One MobileScanPaymentSlip per captured slip: the per-call OCR'd payment
    // (falling back to a blank-method / zeroed row when a call couldn't read a
    // payment, so the slip is never silently dropped — the operator picks the
    // method and fixes the amount) + the captured File for the New SO row's slip
    // upload.
    const paymentSlips: MobileScanPaymentSlip[] = order.payShots.map((shot, i) => {
      const res = responses[i];
      const pm = res && res.success && res.data ? extractPayment(res.data.extracted) : null;
      return {
        method: pm?.method ?? "",
        amount: pm?.amount ?? "0.00",
        approval: pm?.approval ?? "",
        file: shot.file,
      };
    });
    return buildPrefill(first.data, repName, paymentSlips);
  };

  const submit = async () => {
    if (!ready || submitting) return;
    setSubmitting(true);
    setError(null);
    setUnavailable(false);
    try {
      // OCR every queued order into a prefill (each order = one draft). We await
      // only the OCR — the slow, network-bound part we must keep the operator on
      // this screen for — so a failed read surfaces here, not silently.
      const prefills: MobileScanPrefill[] = [];
      for (const order of orders) {
        const prefill = await extractOrder(order);
        if (prefill) prefills.push(prefill);
      }
      if (prefills.length === 0) {
        setError("Couldn't read the slip — try again.");
        return;
      }

      // FIRE the draft-create for each prefill WITHOUT awaiting: the in-flight
      // POST /mfg-sales-orders survives us leaving this screen (owner: a draft
      // must appear even if he presses Cancel). A create that fails after we've
      // left raises the shared in-app notify via authedFetch's error path — it
      // never leaves a phantom (a failed POST creates nothing).
      for (const prefill of prefills) {
        void createDraftFromPrefill(prefill).catch(() => {
          // The create is now detached from this screen. authedFetch already
          // turned any failure into a plain-language Error; surface it through
          // the globally-registered in-app notify (serviceNotify) so even a
          // post-navigation failure tells the operator — and never leaves a
          // phantom (a failed POST creates nothing).
          void serviceNotify({
            title: "Couldn't save one scanned draft",
            body: "One of your scanned orders couldn't be saved. Scan it again.",
            tone: "error",
          });
        });
      }

      // Return to Orders straight away with the toast + list-refetch nudge.
      onDrafted(prefills.length);
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
        setError("Couldn't read the slip — try again.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  // Total captured payment slips across the whole session (for the footer count).
  const totalPayShots = orders.reduce((n, o) => n + o.payShots.length, 0);

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
        <div style={{ fontSize: 11, color: "#767b6e", marginTop: 2 }}>Snap each slip — one front slip and its payment slips per order. Queue as many orders as you like.</div>
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
            {/* Hidden inputs: one for the front slip, one for payment slips. Both
                re-targeted to activeOrderIdRef before each capture.
                capture="environment" opens the rear camera. */}
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

            {/* One grouped card per queued order — the front slip and its payment
                slips live under one "Order N" header so it's clear they belong to
                the same order. */}
            {orders.map((order, oi) => (
              <div
                key={order.id}
                style={{ border: "1px solid #e3e6e0", borderRadius: 14, padding: 12, marginBottom: 12, background: "#fff" }}
              >
                {/* Order header — "Order N" + a remove-order control (only when
                    more than one order is queued; the sole order can't be removed,
                    only its slips). */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 800, color: "#11140f" }}>Order {oi + 1}</span>
                  {multiOrder && !submitting && (
                    <button
                      onClick={() => removeOrder(order.id)}
                      style={{ display: "flex", alignItems: "center", gap: 4, height: 26, padding: "0 10px", borderRadius: 999, border: "1px solid #f0d4d4", background: "#fff", color: "#b23a3a", fontFamily: "inherit", fontSize: 11, fontWeight: 700, cursor: "pointer" }}
                    >
                      {"×"} Remove order
                    </button>
                  )}
                </div>

                {/* FRONT SLIP — single per order. */}
                <div className="ey" style={{ letterSpacing: ".14em", color: "#9aa093", fontSize: 10.5, marginBottom: 6 }}>{SLOT_LABELS[0]}</div>
                {order.front ? (
                  <div className="ph" style={{ position: "relative", height: 130, borderRadius: 12, overflow: "hidden", marginBottom: 4 }}>
                    <img src={order.front.url} alt={SLOT_LABELS[0]} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                    <span style={{ position: "absolute", top: 6, left: 6, width: 20, height: 20, borderRadius: "50%", background: "#2f8a5b", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      {CHECK}
                    </span>
                    {!submitting && (
                      <>
                        {/* Delete the front slip. */}
                        <RemoveButton
                          label={`Remove ${SLOT_LABELS[0]} for order ${oi + 1}`}
                          onClick={() => clearFront(order.id)}
                          style={{ position: "absolute", top: 6, right: 6 }}
                        />
                        {/* Retake = delete then re-open camera in one tap. */}
                        <button
                          onClick={() => { clearFront(order.id); pickFront(order.id); }}
                          aria-label={`Retake ${SLOT_LABELS[0]} for order ${oi + 1}`}
                          style={{ position: "absolute", bottom: 6, right: 6, height: 24, padding: "0 9px", borderRadius: 999, border: "none", background: "rgba(17,20,15,.62)", color: "#fff", fontFamily: "inherit", fontSize: 10.5, fontWeight: 700, cursor: "pointer" }}
                        >
                          Retake
                        </button>
                      </>
                    )}
                  </div>
                ) : (
                  <button
                    onClick={() => pickFront(order.id)}
                    disabled={submitting}
                    style={{ height: 130, width: "100%", border: "1px dashed #c2c6bd", borderRadius: 12, background: "#f4f6f3", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, cursor: submitting ? "default" : "pointer", fontFamily: "inherit", opacity: submitting ? 0.5 : 1, marginBottom: 4 }}
                  >
                    {CAMERA}
                    <span style={{ fontSize: 11, fontWeight: 700, color: "#16695f" }}>{SLOT_LABELS[0]}</span>
                  </button>
                )}

                {/* PAYMENT SLIPS — one photo per payment, within this order. Add-
                    more tile + thumbnail list with a per-slip delete. Each slip
                    becomes its own payment on the draft SO. */}
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginTop: 14, marginBottom: 6 }}>
                  <span className="ey" style={{ letterSpacing: ".14em", color: "#9aa093", fontSize: 10.5 }}>Payment slips</span>
                  <span style={{ fontSize: 10.5, color: "#9aa093" }}>
                    {order.payShots.length === 0 ? "One photo per payment" : `${order.payShots.length} payment${order.payShots.length === 1 ? "" : "s"}`}
                  </span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                  {order.payShots.map((shot, i) => (
                    <div key={shot.url} className="ph" style={{ position: "relative", height: 96, borderRadius: 12, overflow: "hidden" }}>
                      <img src={shot.url} alt={`Order ${oi + 1} payment ${i + 1}`} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                      <span style={{ position: "absolute", top: 5, left: 5, height: 18, minWidth: 18, padding: "0 5px", borderRadius: 999, background: "rgba(17,20,15,.62)", color: "#fff", fontSize: 10, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center" }}>
                        {i + 1}
                      </span>
                      {!submitting && (
                        <RemoveButton
                          label={`Remove order ${oi + 1} payment ${i + 1}`}
                          onClick={() => removePayShot(order.id, i)}
                          style={{ position: "absolute", top: 5, right: 5 }}
                        />
                      )}
                    </div>
                  ))}
                  <button
                    onClick={() => pickPayment(order.id)}
                    disabled={submitting}
                    aria-label={order.payShots.length === 0 ? `${SLOT_LABELS[1]} for order ${oi + 1}` : `Add another payment slip to order ${oi + 1}`}
                    style={{ height: 96, width: "100%", border: "1px dashed #c2c6bd", borderRadius: 12, background: "#f4f6f3", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 5, cursor: submitting ? "default" : "pointer", fontFamily: "inherit", opacity: submitting ? 0.5 : 1 }}
                  >
                    {CAMERA}
                    <span style={{ fontSize: 10.5, fontWeight: 700, color: "#16695f", textAlign: "center", lineHeight: 1.25 }}>
                      {order.payShots.length === 0 ? SLOT_LABELS[1] : "Add payment"}
                    </span>
                  </button>
                </div>
                <div style={{ fontSize: 10.5, color: "#9aa093", textAlign: "center", marginTop: 10 }}>
                  1 front slip + {order.payShots.length || 1} payment slip{(order.payShots.length || 1) === 1 ? "" : "s"} · each payment slip = one payment
                </div>
              </div>
            ))}

            {/* + Add order — queue another order (its own front + payment slips). */}
            <button
              onClick={addOrder}
              disabled={submitting}
              style={{ height: 46, width: "100%", border: "1px dashed #16695f", borderRadius: 12, background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, cursor: submitting ? "default" : "pointer", fontFamily: "inherit", opacity: submitting ? 0.5 : 1, color: "#16695f", fontSize: 13, fontWeight: 700 }}
            >
              <span style={{ fontSize: 18, lineHeight: 1 }}>{"+"}</span> Add order
            </button>

            {/* Design #scan: amber helper note box (design's #f3ece0 / #e8dcc5 /
                #6a4a1e amber trio). Copy reflects the real flow — the scan reads
                the slip and creates a DRAFT order in the background; the operator
                opens it from Orders to review and finalise. */}
            <div style={{ display: "flex", alignItems: "flex-start", gap: 9, background: "#f3ece0", border: "1px solid #e8dcc5", borderRadius: 11, padding: 11, marginTop: 12, fontSize: 11, color: "#6a4a1e", lineHeight: 1.5 }}>
              {/* Spec #scan amber info glyph on the left of the note. */}
              <svg width="15" height="15" style={{ flex: "none", marginTop: 1 }} viewBox="0 0 24 24" fill="none" stroke="#a16a2e" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" /></svg>
              <span>
                We read {multiOrder ? "each slip" : "the slip"} and save {multiOrder ? "a draft order per slip" : "a draft order"} to Orders in the background. Open {multiOrder ? "each draft" : "the draft"} from Orders to review every field, correct anything the reader missed, then finalise.
              </span>
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
                {orders[0] && orders[0].payShots.length > 1
                  ? `Reading the slip and ${orders[0].payShots.length} payments — this can take a moment.`
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
              ? totalPayShots > 1 ? "Scanning slips…" : "Scanning slip…"
              : multiOrder ? `Scan & save ${orders.length} drafts` : "Scan & save draft"}
          </button>
        </footer>
      )}

      <style>{`@keyframes hzSpin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
