import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { lineIdentity } from "@2990s/shared";
import { fmtAmt } from "../lib/scm";
import { idempotentInit, useIdempotencyKey } from "../lib/idempotency";
import { invalidateDoShared, invalidateInventoryShared, invalidateSoShared } from "./sharedInvalidate";
import { authedFetch } from "../vendor/scm/lib/authed-fetch";
import { uploadSlipFull, ALLOWED_SLIP_MIMES, MAX_SLIP_SIZE_BYTES } from "../vendor/scm/lib/slip";
import { todayMyt } from "../vendor/scm/lib/dates";
import { useConfirm } from "../vendor/scm/components/ConfirmDialog";
import "./mobile.css";

/* Proof-of-Delivery (POD) — mobile driver screen for confirming a Delivery
   Order as DELIVERED. Wired to the REAL DO backend
   (backend/src/scm/routes/delivery-orders-mfg.ts):

     • The list route  GET  /delivery-orders-mfg  resolves the docNo (a DO
       NUMBER like "DO-2406-0188") to the DO's UUID — every detail/status route
       keys on the UUID (:id), never the number.
     • The detail      GET  /delivery-orders-mfg/:id   → { deliveryOrder, items }
       gives the header (debtor, city/state, status, local_total_centi) and the
       line items to tick off.
     • Payments        GET  /delivery-orders-mfg/:id/payments → { payments }
       give the paid total; balance = order total − Σ payments (the DO header
       carries no balance column, unlike the SO).
     • Deliver         PATCH /delivery-orders-mfg/:id/status  body { status:
       "DELIVERED" }  flips the DO delivered (deducts stock + syncs the SO).

   The delivery PHOTO is uploaded to R2 (the shared slip Worker-proxy
   pipeline: uploadSlipFull → { r2Key }) and its key is persisted as
   PATCH /:id/status { podKey } → delivery_orders.pod_r2_key. The customer
   SIGNATURE (base64 PNG) is persisted as { signatureData } →
   delivery_orders.signature_data. GPS stays client-side (no server column). */

type DoHeader = {
  id: string;
  do_number: string | null;
  debtor_name: string | null;
  status: string | null;
  phone: string | null;
  city: string | null;
  state: string | null;
  customer_state: string | null;
  local_total_centi: number | null;
};
type DoItem = {
  id: string;
  description: string | null;
  item_code: string | null;
  qty: number | null;
};
type DoPayment = { id: string; amount_centi: number | null };

type ListResp = { deliveryOrders: DoHeader[] };
type DetailResp = { deliveryOrder: DoHeader; items: DoItem[] };
type PaymentsResp = { payments: DoPayment[] };

// Bare 2dp amount; callers print their own "RM " prefix. The shared fmtAmt
// keeps a non-finite from reaching the user as "RM NaN".
const rm = fmtAmt;

/* A DO whose status is already a terminal delivered/invoiced state is done —
   the primary action is hidden and the header pill reads accordingly. */
const isDelivered = (status: string | null): boolean => {
  const s = (status ?? "").toUpperCase();
  return s === "DELIVERED" || s === "INVOICED" || s === "SIGNED";
};
const isCancelled = (status: string | null): boolean => (status ?? "").toUpperCase() === "CANCELLED";

/** Proof of Delivery — full-height overlay. `docNo` is a Delivery Order NUMBER;
 *  we resolve it to the DO UUID via the list route, then read the detail. */
export function MobilePOD({ docNo, onBack, onDone }: { docNo: string; onBack: () => void; onDone?: () => void }) {
  const qc = useQueryClient();
  const confirm = useConfirm();

  // Resolve docNo (a DO number) → the DO row (carries the UUID every other
  // route keys on). The list route returns full header rows.
  const listQ = useQuery({
    queryKey: ["mobile-do-list-for-pod"],
    queryFn: () => authedFetch<ListResp>(`/delivery-orders-mfg`),
    staleTime: 15_000,
  });
  const doId = useMemo(
    () => (listQ.data?.deliveryOrders ?? []).find((d) => (d.do_number ?? "") === docNo)?.id ?? null,
    [listQ.data, docNo],
  );

  const detailQ = useQuery({
    queryKey: ["mobile-pod-detail", doId],
    queryFn: () => authedFetch<DetailResp>(`/delivery-orders-mfg/${encodeURIComponent(doId ?? "")}`),
    enabled: !!doId,
    staleTime: 15_000,
  });
  const paymentsQ = useQuery({
    queryKey: ["mobile-pod-payments", doId],
    queryFn: () => authedFetch<PaymentsResp>(`/delivery-orders-mfg/${encodeURIComponent(doId ?? "")}/payments`),
    enabled: !!doId,
    staleTime: 15_000,
  });

  const h = detailQ.data?.deliveryOrder;
  const items = detailQ.data?.items ?? [];
  const payments = paymentsQ.data?.payments ?? [];

  const paid = payments.reduce((sum, p) => sum + (p.amount_centi ?? 0), 0);
  const balance = Math.max(0, (h?.local_total_centi ?? 0) - paid);

  // Checklist — which line items the driver has ticked as delivered.
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const deliveredCount = items.reduce((n, it) => n + (ticked[it.id] ? 1 : 0), 0);

  // Signature pad + GPS + photo (captured locally — see file header).
  const sigRef = useRef<HTMLCanvasElement | null>(null);
  const [hasSignature, setHasSignature] = useState(false);
  const [sigClearNonce, setSigClearNonce] = useState(0);
  const [gps, setGps] = useState<{ lat: number; lng: number } | null>(null);
  const [gpsState, setGpsState] = useState<"idle" | "asking" | "ok" | "denied">("idle");
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [payMethod, setPayMethod] = useState<"Cash" | "Online" | "Card">("Cash");
  const [collectBalance, setCollectBalance] = useState(false);
  const photoName = photoFile?.name ?? null;

  // Design toggle labels → the DO payment endpoint's method enum
  // (POST /delivery-orders-mfg/:id/payments accepts cash | transfer |
  // merchant | installment).
  const PAY_METHOD_API: Record<"Cash" | "Online" | "Card", "cash" | "transfer" | "merchant"> = {
    Cash: "cash",
    Online: "transfer",
    Card: "merchant",
  };

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  /* One key for the balance this delivery collects (lib/idempotency.ts).
     This screen is the sharpest case in the app: confirmDelivered records the
     payment FIRST and only then uploads the photo + PATCHes the status, so a
     failure in that tail (bad signal in a customer's driveway is the norm, not
     the exception) leaves the money booked and the DO still undelivered — and
     the driver's only move is to press Confirm again, which posted a SECOND
     payment for the same balance. With the key the re-press replays the first
     payment's stored response and carries on to the status PATCH.
     The key is retired by leaving the screen. Re-using this screen for a
     DIFFERENT DO cannot collide even without a remount: the middleware's key is
     scoped by "METHOD /path", and the doId is in the path. */
  const idemKey = useIdempotencyKey();

  const delivered = h ? isDelivered(h.status) : false;
  const cancelled = h ? isCancelled(h.status) : false;

  // Only record a collection when the driver explicitly says they took the
  // balance, there IS a balance, and a positive amount would post.
  const willCollect = collectBalance && balance > 0;

  const confirmDelivered = async () => {
    if (busy || !doId || !h) return;
    const notes: string[] = [];
    if (deliveredCount < items.length) {
      notes.push(`Only ${deliveredCount} of ${items.length} items are ticked.`);
    }
    if (willCollect) {
      notes.push(`This will record a ${payMethod.toLowerCase()} payment of RM ${rm(balance)} against this delivery.`);
    }
    if (!(await confirm({
      title: `Mark ${h.do_number ?? docNo} delivered?`,
      body: notes.length ? notes.join(" ") : undefined,
      confirmLabel: willCollect ? "Confirm & record payment" : "Confirm delivered",
    }))) return;
    setActionError(null);
    setBusy(true);
    try {
      // Record the collected balance FIRST (real endpoint) so a payment
      // failure aborts before we flip the DO delivered. Amount = full
      // outstanding balance; method mapped from the design toggle.
      if (willCollect) {
        await authedFetch(`/delivery-orders-mfg/${encodeURIComponent(doId)}/payments`,
          idempotentInit(idemKey, {
            method: "POST",
            body: JSON.stringify({
              paidAt: todayMyt(),
              method: PAY_METHOD_API[payMethod],
              amountCenti: balance,
            }),
          }));
      }
      // Deliver action — the DO status endpoint persists the POD signature
      // (base64 PNG) onto delivery_orders.signature_data and the delivery
      // photo's R2 key onto delivery_orders.pod_r2_key. GPS stays client-side
      // (no server column).
      // Upload the photo to R2 FIRST (shared slip Worker-proxy pipeline) so
      // its key rides the same PATCH. A failed upload aborts the whole action —
      // we never mark delivered while claiming a photo we didn't store.
      let podKey: string | null = null;
      if (photoFile) {
        const { r2Key } = await uploadSlipFull({ file: photoFile });
        podKey = r2Key;
      }
      const sig = (() => { try { return sigRef.current?.toDataURL("image/png") ?? ""; } catch { return ""; } })();
      await authedFetch(`/delivery-orders-mfg/${encodeURIComponent(doId)}/status`, {
        method: "PATCH",
        body: JSON.stringify({
          status: "DELIVERED",
          ...(sig ? { signatureData: sig } : {}),
          ...(podKey ? { podKey } : {}),
        }),
      });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["mobile-pod-detail", doId] }),
        qc.invalidateQueries({ queryKey: ["mobile-pod-payments", doId] }),
        qc.invalidateQueries({ queryKey: ["mobile-do-list-for-pod"] }),
        qc.invalidateQueries({ queryKey: ["mobile-so-list-paged"] }),
      ]);
      // Delivering moves stock + flips the DO + touches SO readiness — refresh
      // the shared/desktop DO, inventory and SO caches too.
      invalidateDoShared(qc);
      invalidateInventoryShared(qc);
      invalidateSoShared(qc);
      onDone?.();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const captureGps = () => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setGpsState("denied");
      return;
    }
    setGpsState("asking");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGps({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setGpsState("ok");
      },
      () => setGpsState("denied"),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 },
    );
  };

  // isPending, not isLoading: isLoading is (isPending && isFetching), so it is
  // FALSE while a query is pending-but-not-fetching — which is exactly what a
  // driver's phone does when it drops off the carrier for a moment (the query
  // PAUSES). On isLoading the notFound branch then painted "could not be found"
  // in red before any fetch had run. detailQ is enabled:!!doId, and a disabled
  // query stays isPending forever, so its check must stay behind the doId guard.
  const loading = listQ.isPending || (!!doId && detailQ.isPending);
  const notFound = !listQ.isPending && !doId;
  const loadError = listQ.error || detailQ.error;
  const pillLabel = cancelled ? "Cancelled" : delivered ? "Delivered" : "Arrived";
  // Header status badge → canonical .badge variant (spec: DISPATCHED/arrived =
  // brand, DELIVERED = green, cancelled = red).
  const pillClass = cancelled ? "b-red" : delivered ? "b-green" : "b-brand";

  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      {/* .hdr — back-to-DO + "Proof of Delivery" + status pill (design POD header) */}
      <header className="hdr">
        <div className="hdr-row">
          <button className="back" onClick={onBack}>
            <span className="chev">‹</span> Delivery Orders
          </button>
          <span className={`badge ${pillClass}`}>{pillLabel}</span>
        </div>
        <div className="scr-title">Proof of Delivery</div>
        <div style={{ fontSize: 11.5, color: "var(--mut)", marginTop: 2 }} className="tnum">
          {(h?.do_number ?? docNo)}
          {h?.debtor_name ? ` · ${h.debtor_name}` : ""}
          {h?.city || h?.state || h?.customer_state ? ` · ${h.city || h.state || h.customer_state}` : ""}
        </div>
      </header>

      <div className="scroll hz-scroll" style={{ padding: "14px 16px", paddingBottom: 120 }}>
        {loading && <div style={{ textAlign: "center", color: "var(--mut2)", fontSize: 12, padding: "26px 0" }}>Loading{"…"}</div>}
        {notFound && <div style={{ textAlign: "center", color: "var(--red)", fontSize: 12, padding: "26px 0" }}>This delivery could not be found. Please refresh.</div>}
        {!loading && !notFound && loadError && (
          <div style={{ textAlign: "center", color: "var(--red)", fontSize: 12, padding: "26px 0" }}>Couldn{"'"}t load this delivery. Please try again.</div>
        )}

        {!loading && !notFound && !loadError && h && (
          <>
            {/* Items to deliver · N — .fld-l label + list-note + tickable cards */}
            <div className="fld-l" style={{ marginBottom: 8 }}>
              Items to deliver · {items.length}
              {items.length > 0 ? ` · ${deliveredCount} of ${items.length} delivered` : ""}
            </div>
            {items.length > 0 && <span className="list-note">Tick each item as it comes off the lorry</span>}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {items.length ? items.map((it) => {
                const on = !!ticked[it.id];
                return (
                  <div
                    key={it.id}
                    onClick={() => setTicked((t) => ({ ...t, [it.id]: !t[it.id] }))}
                    className="card"
                    style={{ display: "flex", alignItems: "center", gap: 10, border: on ? "1.5px solid var(--brand)" : "1px solid var(--line-card)", padding: "11px 13px", cursor: "pointer" }}
                  >
                    <span style={{ width: 22, height: 22, flex: "none", borderRadius: 6, background: on ? "var(--brand)" : "transparent", border: on ? "none" : "1.5px solid var(--brand)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      {on && (
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M20 6 9 17l-5-5" />
                        </svg>
                      )}
                    </span>
                    {/* Description ONCE, code NOT displayed — the shared rule
                        (vendor/shared/line-identity.ts). Desktop and mobile are
                        ONE logic layer, so this POD row follows the same rule as
                        the desktop DO detail. The QTY is NOT a duplicate and
                        stays on the second line; only the code (and the "·" that
                        joined it) is dropped. This row has no variant
                        vocabulary — no item_group / variants / description2 —
                        so no variant is passed. */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: "var(--ink)" }}>
                        {lineIdentity({ code: it.item_code, description: it.description }).primary || "—"}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--mut)" }} className="tnum">{"×"}{it.qty ?? 0}</div>
                    </div>
                  </div>
                );
              }) : <div style={{ fontSize: 11.5, color: "var(--mut2)", padding: "9px 2px" }}>No items on this delivery.</div>}
            </div>

            {/* Delivery photos — designer two-column row: Take-photo button + a
                preview tile that lights up once captured. Photos are captured
                locally and uploaded to R2 on Confirm. */}
            <div className="fld-l" style={{ margin: "18px 0 8px" }}>Delivery photos</div>
            <div style={{ display: "flex", gap: 9 }}>
              <label style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 6, background: "var(--brand)", border: "none", borderRadius: 13, padding: 14, color: "#fff", fontFamily: "inherit", fontSize: 11.5, fontWeight: 700, cursor: "pointer" }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z" />
                  <circle cx="12" cy="13" r="3" />
                </svg>
                {photoName ? "Retake photo" : "Take photo"}
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  capture="environment"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const f = e.target.files?.[0] ?? null;
                    if (!f) return;
                    // Guard against the R2 pipeline's contract (jpeg/png/webp,
                    // 5 MiB) up front so the operator learns before Confirm, not
                    // mid-upload.
                    if (!ALLOWED_SLIP_MIMES.includes(f.type as (typeof ALLOWED_SLIP_MIMES)[number])) {
                      setPhotoFile(null);
                      setPhotoError("Please use a JPEG, PNG or WebP photo.");
                      return;
                    }
                    if (f.size > MAX_SLIP_SIZE_BYTES) {
                      setPhotoFile(null);
                      setPhotoError("That photo is too large (max 5 MB).");
                      return;
                    }
                    setPhotoError(null);
                    setPhotoFile(f);
                  }}
                />
              </label>
              <div style={{ flex: 1, borderRadius: 13, minHeight: 70, background: photoName ? "linear-gradient(135deg,#d7ded6,#c7d0c4)" : "linear-gradient(135deg,#eceee9,#e3e6e0)" }} />
            </div>
            {photoName && <div style={{ fontSize: 10.5, color: "var(--mut)", marginTop: 6 }} className="tnum">{photoName}</div>}
            {photoError && <div style={{ fontSize: 10.5, color: "var(--red)", marginTop: 6 }}>{photoError}</div>}

            {/* Customer signature — design signature pad (canvas keeps the real capture). */}
            <div className="fld-l" style={{ margin: "18px 0 8px" }}>Customer signature</div>
            <SignaturePad canvasRef={sigRef} onChange={setHasSignature} clearNonce={sigClearNonce} />
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 4 }}>
              <span style={{ fontSize: 11, color: "var(--mut)" }}>{hasSignature ? "Signed" : "Ask the customer to sign above"}</span>
              <span
                onClick={() => { setHasSignature(false); setSigClearNonce((n) => n + 1); }}
                style={{ fontSize: 11.5, fontWeight: 700, color: "var(--brand)", cursor: "pointer" }}
              >
                Clear &amp; re-sign
              </span>
            </div>

            {/* Delivery location — GPS captured locally (no server field yet). */}
            <div className="fld-l" style={{ margin: "18px 0 8px" }}>Delivery location</div>
            <div style={{ background: "var(--card)", border: "1px solid var(--line-card)", borderRadius: 13, padding: "13px 14px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
              <span className="tnum" style={{ fontSize: 12, color: gpsState === "ok" ? "var(--ink)" : "var(--mut)", minWidth: 0 }}>
                {gpsState === "ok" && gps
                  ? `${gps.lat.toFixed(5)}, ${gps.lng.toFixed(5)}`
                  : gpsState === "asking"
                  ? "Getting location…"
                  : gpsState === "denied"
                  ? "Location unavailable"
                  : "Not captured"}
              </span>
              <button
                type="button"
                onClick={captureGps}
                disabled={gpsState === "asking"}
                style={{ flex: "none", border: "1px solid var(--brand)", background: "var(--card)", color: "var(--brand)", borderRadius: 9, padding: "7px 13px", fontFamily: "inherit", fontSize: 11.5, fontWeight: 700, cursor: gpsState === "asking" ? "default" : "pointer", opacity: gpsState === "asking" ? 0.55 : 1 }}
              >
                {gpsState === "ok" ? "Recapture" : "Capture GPS"}
              </button>
            </div>

            {/* Collect balance — order total minus payments recorded so far (design balance row). */}
            <div className="fld-l" style={{ margin: "18px 0 8px" }}>Collect balance</div>
            <div style={{ background: "var(--card)", border: "1px solid var(--line-card)", borderRadius: 13, padding: "13px 14px" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: balance > 0 ? 11 : 0 }}>
                <span style={{ fontSize: 12.5, color: "var(--ink2)" }}>Balance due</span>
                <span className="money" style={{ fontSize: 17, fontWeight: 800, color: balance > 0 ? "var(--gold)" : "var(--green)" }}>{balance > 0 ? `RM ${rm(balance)}` : "No balance — fully paid"}</span>
              </div>
              {balance > 0 && (
                <>
                  <div style={{ display: "flex", gap: 7 }}>
                    {(["Cash", "Online", "Card"] as const).map((m) => {
                      const on = payMethod === m;
                      return (
                        <span
                          key={m}
                          onClick={() => setPayMethod(m)}
                          style={{ fontSize: 11.5, fontWeight: on ? 700 : 600, color: on ? "#fff" : "var(--ink2)", background: on ? "var(--brand)" : "var(--bg)", border: on ? "none" : "1px solid var(--line-card)", padding: "6px 13px", borderRadius: 9, cursor: "pointer" }}
                        >
                          {m}
                        </span>
                      );
                    })}
                  </div>
                  {/* Explicit opt-in — a payment is recorded ONLY when the driver
                      ticks this. Without it the toggle just picks the method and
                      nothing is posted. */}
                  <label style={{ display: "flex", alignItems: "center", gap: 9, marginTop: 12, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={collectBalance}
                      onChange={(e) => setCollectBalance(e.target.checked)}
                      style={{ width: 18, height: 18, accentColor: "#16695f" }}
                    />
                    <span style={{ fontSize: 12, color: "var(--ink2)" }}>
                      Record RM {rm(balance)} collected by {payMethod.toLowerCase()} now
                    </span>
                  </label>
                </>
              )}
            </div>

            {actionError && <div style={{ marginTop: 14, fontSize: 11.5, color: "var(--red)", textAlign: "center" }}>{actionError}</div>}
          </>
        )}
      </div>

      {/* .actbar — primary confirm action (design POD footer) */}
      <footer className="actbar">
        {!loading && !notFound && !loadError && h && !delivered && !cancelled && (
          <button type="button" className="btn" disabled={busy} onClick={confirmDelivered} style={{ opacity: busy ? 0.6 : 1, cursor: busy ? "default" : "pointer" }}>
            {busy ? "Working…" : "Confirm delivered →"}
          </button>
        )}
        {!loading && !notFound && !loadError && h && delivered && (
          <div style={{ textAlign: "center", fontSize: 11.5, color: "var(--green)", padding: 6, fontWeight: 700 }}>This delivery is confirmed delivered.</div>
        )}
        {!loading && !notFound && !loadError && h && cancelled && (
          <div style={{ textAlign: "center", fontSize: 11.5, color: "var(--mut2)", padding: 6 }}>This delivery order was cancelled.</div>
        )}
        {(loading || notFound || (loadError && !h)) && (
          <button type="button" className="btn-ghost" onClick={onBack}>
            Back
          </button>
        )}
      </footer>
    </div>
  );
}

/** Canvas signature pad — pointer/touch strokes; exposes hasSignature to the
 *  parent. The captured strokes can be read via canvasRef.current.toDataURL()
 *  when a backend field to persist them exists (none today). Bumping
 *  `clearNonce` wipes the pad and re-arms the "signed" latch. */
function SignaturePad({ canvasRef, onChange, clearNonce }: {
  canvasRef: React.MutableRefObject<HTMLCanvasElement | null>;
  onChange: (hasSignature: boolean) => void;
  clearNonce: number;
}) {
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const drew = useRef(false);

  // Wipe the pad + re-arm the latch when the parent's Clear bumps the nonce.
  useEffect(() => {
    if (clearNonce === 0) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    drew.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearNonce]);

  // Size the backing store to the element's CSS box (device-pixel aware) so
  // strokes aren't stretched. Runs once on mount.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width * ratio));
    canvas.height = Math.max(1, Math.round(rect.height * ratio));
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.scale(ratio, ratio);
      ctx.lineWidth = 2.4;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = "#16695f";
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const start = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    drawing.current = true;
    last.current = point(e);
    // First mark of a fresh (or freshly-cleared) pad flags a signature. The
    // parent resets its own flag on Clear; we re-flag on the next real stroke.
    if (!drew.current) { drew.current = true; onChange(true); }
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* older browsers */ }
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    e.preventDefault();
    const ctx = canvasRef.current?.getContext("2d");
    const p = point(e);
    if (ctx && last.current) {
      ctx.beginPath();
      ctx.moveTo(last.current.x, last.current.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
    last.current = p;
  };
  const end = () => { drawing.current = false; last.current = null; };

  return (
    <div style={{ background: "#fff", border: "1px solid var(--line)", borderRadius: 13, padding: 14, position: "relative", height: 120 }}>
      <canvas
        ref={canvasRef}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerLeave={end}
        onPointerCancel={end}
        style={{ width: "100%", height: 64, touchAction: "none", display: "block" }}
      />
      <div style={{ position: "absolute", left: 14, right: 14, bottom: 34, borderBottom: "1px dashed var(--mut2)" }} />
    </div>
  );
}
