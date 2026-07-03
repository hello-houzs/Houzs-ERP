import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { authedFetch } from "../vendor/scm/lib/authed-fetch";
import { useConfirm } from "../vendor/scm/components/ConfirmDialog";
import { useNotify } from "../vendor/scm/components/NotifyDialog";
import { uploadSlipFull, fetchPaymentSlipUrl } from "../vendor/scm/lib/slip";
import { useStaff } from "../vendor/scm/lib/admin-queries";
import { buildVariantSummary } from "../vendor/shared/variant-summary";
import "./mobile.css";

/* Shapes are the subset of the /mfg-sales-orders/:docNo + /:docNo/payments
   responses the mobile detail screen reads. The backend camelCases nothing —
   these are the raw snake_case columns. */
type SoHeader = {
  doc_no: string;
  debtor_name: string | null;
  status: string | null;
  phone: string | null;
  email: string | null;
  customer_type: string | null;
  salesperson_id: string | number | null;
  sales_location: string | null;
  customer_state: string | null;
  ref: string | null;
  customer_so_no: string | null;
  po_doc_no: string | null;
  /* Emergency contact — the detail HEADER carries all three columns
     (emergency_contact_name / _phone / _relationship). The Build Spec's
     Customer card shows an "Emergency contact" row, HIDDEN entirely when no
     phone is on file. Mirrors the desktop SO form's emergency block. */
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  emergency_contact_relationship: string | null;
  building_type: string | null;
  venue: string | null;
  note: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  postcode: string | null;
  processing_date: string | null;
  customer_delivery_date: string | null;
  internal_expected_dd: string | null;
  so_date: string | null;
  created_at: string | null;
  local_total_centi: number | null;
  total_revenue_centi: number | null;
  paid_centi_total: number | null;
  balance_centi: number | null;
  /* Tier 2 downstream-lock + delivery progress — stamped by the detail GET
     (same fields the desktop SO Detail / list read). has_children = a
     non-cancelled DO/SI references this SO (locks Edit + Cancel). */
  has_children: boolean | null;
  delivery_state: string | null;
};
type SoItem = {
  id: string;
  description: string | null;
  /* Backend returns mfg_sales_order_items.variants as a JSONB OBJECT (not a
     pre-formatted string). Render it through the shared summary builder — the
     prototype's `variants: string` assumption crashed on .trim(). */
  item_group: string | null;
  variants: Record<string, unknown> | null;
  /* description2 = the server-computed variant summary string (HOOKKA-style),
     stamped on the line. Used as a fallback when the raw `variants` object is
     absent/empty so the spec line still shows its category-aware spec text. */
  description2: string | null;
  item_code: string | null;
  /* Unit of measure — the Build Spec line item reads "SKU {sku} · {uom}". */
  uom: string | null;
  qty: number | null;
  unit_price_centi: number | null;
  total_centi: number | null;
  line_delivery_date: string | null;
  /* Live delivery balance per line (qty − delivered + returned) — stamped by
     the detail GET. Drives the "anything left to deliver?" gate for Issue DO,
     mirroring the desktop list's has_undelivered. */
  remaining_qty: number | null;
};
type SoPayment = {
  id: string;
  paid_at: string | null;
  method: string | null;
  merchant_provider: string | null;
  installment_months: number | null;
  online_type: string | null;
  approval_code: string | null;
  account_sheet: string | null;
  collected_by_name: string | null;
  amount_centi: number | null;
  slip_key: string | null;
};
type DetailResp = { salesOrder: SoHeader; items: SoItem[] };
type PaymentsResp = { payments: SoPayment[] };

const rm = (centi: number | null | undefined) =>
  ((centi ?? 0) / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dm = (d: string | null | undefined) => {
  if (!d) return "—";
  const dt = new Date(d);
  if (isNaN(+dt)) return "—";
  return dt.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
};
/* Full date for the locked read-only fields (design renders e.g. "14 Jun 2026").
   Empty / unparseable → em-dash so the .fld-ro cell never shows a raw string. */
const dl = (d: string | null | undefined) => {
  if (!d) return "—";
  const dt = new Date(d);
  if (isNaN(+dt)) return "—";
  return dt.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
};
/* Locked-field value or em-dash — a field the detail endpoint doesn't return
   (or returns empty) renders as "—" inside the .fld-ro box, per the brief. */
const val = (v: string | null | undefined) => {
  const s = (v ?? "").toString().trim();
  return s.length ? s : "—";
};
/* DRAFT → Draft, CANCELLED → Cancelled, everything else (CONFIRMED,
   IN_PRODUCTION, READY_TO_SHIP, SHIPPED, DELIVERED …) reads as a live/Submitted
   order — matching the design's 3-state action model. */
const phase = (status: string | null): "draft" | "cancelled" | "submitted" => {
  const s = (status ?? "").toUpperCase();
  if (s === "DRAFT") return "draft";
  if (s === "CANCELLED") return "cancelled";
  return "submitted";
};
const total = (h: SoHeader) => h.local_total_centi ?? h.total_revenue_centi ?? 0;

/** Sales Order DETAIL — markup ported VERBATIM from the owner's mobile design
 *  (`#so-detail` + `renderSoDetail`/`openSO`), wired to the real
 *  /mfg-sales-orders/:docNo (header + line items) and /:docNo/payments.
 *  Draft/Submitted actions PATCH /:docNo/status. Design classes only. */
export function MobileSODetail({ docNo, onBack, onEdit, onIssueDo }: { docNo: string; onBack: () => void; onEdit?: (docNo: string) => void; onIssueDo?: (docNo: string) => void }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [payOpen, setPayOpen] = useState(false);

  const detail = useQuery({
    queryKey: ["mobile-so-detail", docNo],
    queryFn: () => authedFetch<DetailResp>(`/mfg-sales-orders/${encodeURIComponent(docNo)}`),
    staleTime: 15_000,
  });
  const paymentsQ = useQuery({
    queryKey: ["mobile-so-payments", docNo],
    queryFn: () => authedFetch<PaymentsResp>(`/mfg-sales-orders/${encodeURIComponent(docNo)}/payments`),
    staleTime: 15_000,
  });

  const staffQ = useStaff();
  const h = detail.data?.salesOrder;
  const items = detail.data?.items ?? [];
  const payments = paymentsQ.data?.payments ?? [];

  /* Salesperson NAME — the detail header carries only salesperson_id (a staff
     UUID), so resolve it against the shared /staff list. Falls back to em-dash
     while loading or when the id has no matching active staff row. */
  const salespersonName = h?.salesperson_id != null
    ? (staffQ.data ?? []).find((s) => String(s.id) === String(h.salesperson_id))?.name ?? null
    : null;

  const setStatus = async (status: string, confirmMsg?: string) => {
    if (busy) return;
    if (confirmMsg && !(await confirm({ title: confirmMsg, confirmLabel: "Confirm", danger: true }))) return;
    setActionError(null);
    setBusy(true);
    try {
      await authedFetch(`/mfg-sales-orders/${encodeURIComponent(docNo)}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["mobile-so-detail", docNo] }),
        qc.invalidateQueries({ queryKey: ["mobile-so-list"] }),
      ]);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const ph = h ? phase(h.status) : "submitted";
  const bal = h ? (h.balance_centi ?? Math.max(0, total(h) - (h.paid_centi_total ?? 0))) : 0;

  /* Parity with desktop SO Detail / list gating (all statuses UPPER-cased).
     - Cancel is offered only on in-flight statuses (CONFIRMED / IN_PRODUCTION /
       READY_TO_SHIP), never once SHIPPED+ / INVOICED / CLOSED — those carry
       downstream docs. Mirrors SalesOrderDetail.cancellableStatuses.
     - Edit is locked once the SO is SHIPPED+ or any non-cancelled DO/SI
       references it (has_children). Mirrors SalesOrderDetail.lockedStatuses. */
  const rawStatus = (h?.status ?? "").toUpperCase();
  const hasChildren = Boolean(h?.has_children);
  const CANCELLABLE = ["CONFIRMED", "IN_PRODUCTION", "READY_TO_SHIP"];
  const LOCKED = ["SHIPPED", "DELIVERED", "INVOICED", "CLOSED", "CANCELLED"];
  const canCancel = CANCELLABLE.includes(rawStatus);
  const editLocked = LOCKED.includes(rawStatus) || hasChildren;
  /* Issue Delivery Order — offered when the SO is live and at least one line
     still has an undelivered balance. Mirrors the desktop list's convertToDo
     gate (has_undelivered && status not CANCELLED/CLOSED/ON_HOLD). */
  const hasUndelivered = items.some((it) => Number(it.remaining_qty ?? it.qty ?? 0) > 0);
  const canIssueDo = !!onIssueDo && ph !== "draft" && ph !== "cancelled"
    && !["CANCELLED", "CLOSED", "ON_HOLD"].includes(rawStatus) && hasUndelivered;

  /* Delete a persisted payment — parity with the desktop PaymentsTable trash
     action. In-app confirm, then DELETE /:docNo/payments/:id; on success the
     payments + header (balance) queries invalidate so the KPIs update live. */
  const deletePayment = async (paymentId: string) => {
    if (busy) return;
    if (!(await confirm({ title: "Delete this payment?", body: "This removes the recorded payment and re-opens the balance.", confirmLabel: "Delete", danger: true }))) return;
    setActionError(null);
    setBusy(true);
    try {
      await authedFetch(`/mfg-sales-orders/${encodeURIComponent(docNo)}/payments/${encodeURIComponent(paymentId)}`, { method: "DELETE" });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["mobile-so-payments", docNo] }),
        qc.invalidateQueries({ queryKey: ["mobile-so-detail", docNo] }),
        qc.invalidateQueries({ queryKey: ["mobile-so-list"] }),
      ]);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Couldn't delete the payment. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <header className="hdr">
        <div className="hdr-row">
          <button className="back" onClick={onBack}><span className="chev">{"‹"}</span> Sales Orders</button>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {h && <StatusPill status={h.status} />}
          </div>
        </div>
        <div className="eyebrow" style={{ marginTop: 7, display: "flex", alignItems: "center", gap: 6 }}>
          <span className="money">{h?.doc_no ?? docNo}</span>
          {(h?.customer_so_no || h?.ref || h?.po_doc_no) && (<><span style={{ opacity: .5 }}>·</span><span className="money">{h?.customer_so_no || h?.ref || h?.po_doc_no}</span></>)}
        </div>
        <div className="scr-title">{h?.debtor_name || "—"}</div>
      </header>

      <div className="scroll hz-scroll" style={{ padding: 14 }}>
        {detail.isLoading && (
          <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
            {[0, 1, 2].map((i) => (<div key={i} className="card"><div className="card-b ph" style={{ height: 70, borderRadius: 14 }} /></div>))}
          </div>
        )}
        {detail.error && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, background: "var(--red-bg)", border: "1px solid #e6cccc", borderRadius: 12, padding: "11px 13px" }}>
            <span style={{ fontSize: 12, color: "var(--red)", fontWeight: 600 }}>Couldn't load this order</span>
            <button onClick={() => detail.refetch()} style={{ border: "none", background: "transparent", color: "var(--red)", fontFamily: "inherit", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Retry</button>
          </div>
        )}

        {!detail.isLoading && !detail.error && h && (
          <div>
            {/* Locked-view hint (design VERBATIM) — Edit unlocks the same New SO
                form; there's no in-place edit here, so wording drops the mode. */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, background: "#eef1ec", border: "1px solid #e3e6e0", borderRadius: 10, padding: "9px 11px", marginBottom: 12, fontSize: 11, color: "#5c6156" }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#767b6e" strokeWidth="2" strokeLinecap="round"><rect x="4" y="10" width="16" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>
              Locked view — tap Edit to change. Same form as New SO.
            </div>

            {/* KPI — Total / Paid / Balance (nowrap tabular money, cards min-width:0).
                Colours VERBATIM from the design: Total + Paid both brand-dark
                (#0c3f39), Balance always red (#b23a3a). */}
            <div style={{ display: "flex", gap: 9, marginBottom: 12 }}>
              <div className="card" style={{ flex: 1, minWidth: 0, marginBottom: 0 }}><div className="card-b" style={{ padding: "10px 11px" }}><div className="fld-l">Total</div><div className="money" style={{ fontSize: 14, fontWeight: 800, color: "#0c3f39", marginTop: 3, whiteSpace: "nowrap" }}>RM {rm(total(h))}</div></div></div>
              <div className="card" style={{ flex: 1, minWidth: 0, marginBottom: 0 }}><div className="card-b" style={{ padding: "10px 11px" }}><div className="fld-l">Paid</div><div className="money" style={{ fontSize: 14, fontWeight: 800, color: "#0c3f39", marginTop: 3, whiteSpace: "nowrap" }}>RM {rm(h.paid_centi_total)}</div></div></div>
              <div className="card" style={{ flex: 1, minWidth: 0, marginBottom: 0 }}><div className="card-b" style={{ padding: "10px 11px" }}><div className="fld-l">Balance</div><div className="money" style={{ fontSize: 14, fontWeight: 800, color: "#b23a3a", marginTop: 3, whiteSpace: "nowrap" }}>RM {rm(bal)}</div></div></div>
            </div>

            {/* Customer — locked .fld-ro fields (design layout VERBATIM) */}
            <div className="card"><div className="card-h"><span className="card-t">Customer</span></div><div className="card-b">
              <RoField label="Customer name" value={val(h.debtor_name)} />
              <div style={{ display: "flex", gap: 9 }}><div style={{ flex: 1, minWidth: 0 }}><RoField label="Phone" value={val(h.phone)} mono /></div><div style={{ flex: 1, minWidth: 0 }}><RoField label="Email" value={val(h.email)} /></div></div>
              <div style={{ display: "flex", gap: 9 }}><div style={{ flex: 1, minWidth: 0 }}><RoField label="Customer type" value={val(h.customer_type)} /></div><div style={{ flex: 1, minWidth: 0 }}><RoField label="Salesperson" value={val(salespersonName)} /></div></div>
              <RoField label="Customer SO ref" value={val(h.customer_so_no ?? h.ref)} mono />
              {/* Emergency contact — whole row HIDDEN when no phone on file
                  (Build Spec §6 + null-field rule: "hide the row"). Value =
                  "name · phone (relationship)" from the header's emergency_* cols. */}
              {(h.emergency_contact_phone ?? "").trim() ? (
                <RoField label="Emergency contact" value={composeEmergency(h)} />
              ) : null}
            </div></div>

            {/* Order info */}
            <div className="card"><div className="card-h"><span className="card-t">Order info</span></div><div className="card-b">
              <div style={{ display: "flex", gap: 9 }}><div style={{ flex: 1, minWidth: 0 }}><RoField label="Building type" value={val(h.building_type)} /></div><div style={{ flex: 1, minWidth: 0 }}><RoField label="Venue" value={val(h.venue)} /></div></div>
              <div style={{ display: "flex", gap: 9 }}><div style={{ flex: 1, minWidth: 0 }}><RoField label="Processing date" value={dl(h.processing_date ?? h.internal_expected_dd)} mono /></div><div style={{ flex: 1, minWidth: 0 }}><RoField label="Delivery date" value={dl(h.customer_delivery_date ?? h.internal_expected_dd)} mono /></div></div>
              <RoField label="Sales location" value={val(h.sales_location ?? h.customer_state)} />
              <RoField label="Note" value={val(h.note)} />
            </div></div>

            {/* Delivery address — composed from the address columns; em-dash when blank */}
            <div className="card"><div className="card-h"><span className="card-t">Delivery address</span></div><div className="card-b">
              <RoField label="Address" value={composeAddress(h)} />
            </div></div>

            {/* Line items — description / variants / SKU / ×qty / line total */}
            <div className="card"><div className="card-h"><span className="card-t">Line items</span><span className="card-sub">{items.length} {items.length === 1 ? "line" : "lines"}</span></div>
              {items.length ? items.map((it, i) => (
                <div key={it.id} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "11px 13px", borderTop: i ? "1px solid var(--line2)" : "none" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "var(--ink)" }}>{it.description || it.item_code || "—"}</div>
                    {/* Category-aware variant spec (sofa Fabric·config / bedframe
                        size·Headboard·Storage / mattress size·firmness·height) —
                        built from the variants JSON; falls back to the server's
                        stamped description2 summary when variants is empty. */}
                    {(() => { const vs = buildVariantSummary(it.item_group, it.variants) || (it.description2 ?? "").trim(); return vs ? <div style={{ fontSize: 11.5, color: "var(--mut)", marginTop: 2 }}>{vs}</div> : null; })()}
                    <div className="money" style={{ fontSize: 10, color: "var(--mut2)", marginTop: 3 }}>SKU {val(it.item_code)}{(it.uom ?? "").trim() ? ` · ${it.uom!.trim()}` : ""}</div>
                  </div>
                  <div style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <div className="money" style={{ fontSize: 13, fontWeight: 700, color: "#0c3f39" }}>RM {rm(lineTotalCenti(it))}</div>
                    <div className="money" style={{ fontSize: 11, color: "var(--mut)", marginTop: 2 }}>×{it.qty ?? 0}</div>
                  </div>
                </div>
              )) : <div style={{ padding: "11px 13px", borderTop: "1px solid var(--line2)", fontSize: 11.5, color: "var(--mut2)" }}>No items.</div>}
            </div>

            {/* Payments — read-only rows (method / date · account · collected_by /
                approval / amount), design layout. "+ Record payment" affordance in
                the card header opens our RecordPaymentSheet (real workflow, kept). */}
            <div className="card"><div className="card-h"><span className="card-t">Payments</span>
              <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                {!!payments.length && <span className="card-sub">{payments.length}</span>}
                {ph !== "cancelled" && bal > 0 && (
                  <button type="button" disabled={busy} onClick={() => { setActionError(null); setPayOpen(true); }} style={{ border: "none", background: "transparent", color: "var(--teal)", fontFamily: "inherit", fontSize: 11.5, fontWeight: 700, cursor: "pointer", padding: 0, opacity: busy ? 0.55 : 1 }}>+ Record payment</button>
                )}
              </span>
            </div>
              {paymentsQ.isLoading && <div style={{ padding: "11px 13px", borderTop: "1px solid var(--line2)", fontSize: 11.5, color: "var(--mut2)" }}>Loading{"…"}</div>}
              {!paymentsQ.isLoading && (payments.length ? payments.map((p, i) => (
                <div key={p.id} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "11px 13px", borderTop: i ? "1px solid var(--line2)" : "none", alignItems: "center" }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--ink)" }}>{methodLabel(p.method)}</div>
                    <div className="money" style={{ fontSize: 10.5, color: "var(--mut)", marginTop: 2 }}>{[dm(p.paid_at), p.account_sheet, p.collected_by_name].filter((x) => x && String(x).trim()).join(" · ")}</div>
                    {p.approval_code ? <div className="money" style={{ fontSize: 10, color: "var(--mut2)" }}>Approval {p.approval_code}</div> : null}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    {p.slip_key ? <SlipLink docNo={docNo} paymentId={p.id} /> : null}
                    <span className="money-row">RM {rm(p.amount_centi)}</span>
                    {/* Delete payment — parity with desktop PaymentsTable. Hidden
                        on cancelled / edit-locked (SHIPPED+ / has children) orders,
                        matching the desktop's locked-mode hide. */}
                    {ph !== "cancelled" && !editLocked && (
                      <button
                        type="button"
                        onClick={() => void deletePayment(p.id)}
                        disabled={busy}
                        title="Delete payment"
                        aria-label="Delete payment"
                        style={{ border: "none", background: "transparent", cursor: "pointer", padding: "0 4px", display: "flex", alignItems: "center", opacity: busy ? 0.4 : 1 }}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#b23a3a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /></svg>
                      </button>
                    )}
                  </div>
                </div>
              )) : <div style={{ padding: "11px 13px", borderTop: "1px solid var(--line2)", fontSize: 11.5, color: "var(--mut2)" }}>No payments recorded.</div>)}
            </div>

            {actionError && <div style={{ marginTop: 13, fontSize: 11.5, color: "var(--red)", textAlign: "center" }}>{actionError}</div>}
          </div>
        )}
      </div>

      {!detail.isLoading && !detail.error && h && (
        <footer className="actbar">
          {/* Record Payment — repeatable; accumulates 2, 3, N payments. Offered on
              any live (non-cancelled) order with a positive balance. Each payment
              needs a slip (backend enforces slip_required), captured in the sheet. */}
          {ph !== "cancelled" && bal > 0 && (
            <button className="btn" disabled={busy} onClick={() => { setActionError(null); setPayOpen(true); }} style={{ marginBottom: 9, opacity: busy ? 0.55 : 1 }}>Record Payment</button>
          )}
          {ph === "draft" && (
            <div style={{ display: "flex", gap: 9 }}>
              <button className="btn-ghost" style={{ flex: 1, opacity: busy ? 0.55 : 1 }} disabled={busy} onClick={() => onEdit?.(docNo)}>Edit Draft</button>
              <button className="btn" style={{ flex: 1.3, opacity: busy ? 0.55 : 1 }} disabled={busy} onClick={() => setStatus("CONFIRMED")}>{busy ? "Working…" : "Create Sales Order"}</button>
            </div>
          )}
          {ph === "submitted" && (
            <>
              {/* Issue Delivery Order — opens the convert wizard pre-seeded with
                  this SO (parity with the desktop list's convertToDo). Shown only
                  when the SO is live and has an undelivered balance. */}
              {canIssueDo && (
                <button className="btn" style={{ marginBottom: 9, opacity: busy ? 0.55 : 1 }} disabled={busy} onClick={() => onIssueDo?.(docNo)}>Issue Delivery Order</button>
              )}
              <div style={{ display: "flex", gap: 9 }}>
                {/* Edit — locked once SHIPPED+ or a non-cancelled DO/SI references
                    this SO (has_children), matching the desktop's lockedStatuses. */}
                <button className="btn-ghost" style={{ flex: 1, opacity: busy || editLocked ? 0.4 : 1 }} disabled={busy || editLocked} onClick={() => onEdit?.(docNo)}>Edit</button>
                {/* Cancel — only on in-flight statuses (not SHIPPED+ / INVOICED /
                    CLOSED), matching the desktop's cancellableStatuses. */}
                {canCancel ? (
                  <button className="btn-danger" style={{ flex: 1, opacity: busy ? 0.55 : 1 }} disabled={busy} onClick={() => setStatus("CANCELLED", `Cancel ${docNo}? This voids the order.`)}>{busy ? "Working…" : "Cancel Order"}</button>
                ) : (
                  <div style={{ flex: 1, textAlign: "center", fontSize: 11, color: "var(--mut2)", alignSelf: "center" }}>Locked — downstream documents exist.</div>
                )}
              </div>
            </>
          )}
          {ph === "cancelled" && (
            <div style={{ textAlign: "center", fontSize: 11.5, color: "var(--mut2)", padding: 4 }}>This order was cancelled.</div>
          )}
        </footer>
      )}

      {payOpen && h && (
        <RecordPaymentSheet
          docNo={docNo}
          totalCenti={total(h)}
          paidCenti={h.paid_centi_total ?? 0}
          balanceCenti={bal}
          onClose={() => setPayOpen(false)}
          onDone={() => {
            void qc.invalidateQueries({ queryKey: ["mobile-so-payments", docNo] });
            void qc.invalidateQueries({ queryKey: ["mobile-so-detail", docNo] });
            void qc.invalidateQueries({ queryKey: ["mobile-so-list"] });
          }}
        />
      )}
    </div>
  );
}

/* Method code → human label for the read-only payments list. Backend stores the
   locked enum (cash|transfer|merchant|installment); render the SO-form value the
   operator recognises (transfer surfaces as "Online" per the shared map). */
const METHOD_LABELS: Record<string, string> = { cash: "Cash", transfer: "Online", merchant: "Merchant", installment: "Installment" };
const methodLabel = (m: string | null): string => (m ? METHOD_LABELS[m] ?? m : "—");

/* Locked read-only field — the design's `.fld` + `.fld-l` + `.fld-ro` trio, the
   detail screen's whole "form rendered locked" idiom. `mono` opts the value into
   tabular-nums (phone / doc refs / dates) via the shared `.money` class. */
function RoField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="fld">
      <span className="fld-l">{label}</span>
      <div className={`fld-ro${mono ? " money" : ""}`}>{value}</div>
    </div>
  );
}

/* Delivery address — composed from the address columns the detail header
   carries (address1/2, city, customer_state, postcode). All blank → em-dash. */
function composeAddress(h: SoHeader): string {
  const parts = [h.address1, h.address2, h.city, [h.customer_state, h.postcode].filter((x) => x && String(x).trim()).join(" ")]
    .map((x) => (x ?? "").toString().trim())
    .filter((x) => x.length);
  return parts.length ? parts.join(", ") : "—";
}

/* Emergency contact — "name · phone (relationship)" from the header's
   emergency_* columns. Only rendered when a phone exists (caller-gated), so a
   blank name still shows the phone; relationship is appended in parens if set. */
function composeEmergency(h: SoHeader): string {
  const name = (h.emergency_contact_name ?? "").trim();
  const phone = (h.emergency_contact_phone ?? "").trim();
  const rel = (h.emergency_contact_relationship ?? "").trim();
  const head = [name, phone].filter((x) => x.length).join(" · ");
  return rel ? `${head} (${rel})` : head || "—";
}

/* Line total — prefer the persisted total_centi; fall back to unit_price × qty
   for older rows that never stamped it. */
const lineTotalCenti = (it: SoItem): number =>
  it.total_centi ?? Math.round((it.unit_price_centi ?? 0) * (it.qty ?? 0));

/* Slip link on a persisted payment row — fetches a short-lived presigned URL on
   demand (GET /:docNo/payments/:id/slip-url) and opens it in a new tab. */
function SlipLink({ docNo, paymentId }: { docNo: string; paymentId: string }) {
  const [busy, setBusy] = useState(false);
  const notify = useNotify();
  const open = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const { url } = await fetchPaymentSlipUrl(docNo, paymentId);
      window.open(url, "_blank", "noopener");
    } catch (e) {
      void notify({ title: "Couldn't open slip", body: e instanceof Error ? e.message : String(e), tone: "error" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      onClick={open}
      title="Open payment slip"
      style={{ border: "none", background: "transparent", cursor: "pointer", padding: "0 6px", display: "flex", alignItems: "center", opacity: busy ? 0.5 : 1 }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#16695f" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z" /><circle cx="12" cy="13" r="3" /></svg>
    </button>
  );
}

/* soPill — VERBATIM from the design's status→color map:
   Draft [#f4f6f3,#767b6e,border] · Submitted [#e1efed,#0c3f39,none] ·
   Cancelled [#f8eaea,#b23a3a,none]. */
function StatusPill({ status }: { status: string | null }) {
  const p = phase(status);
  const cls = p === "draft" ? "b-grey" : p === "cancelled" ? "b-red" : "b-brand";
  const label = p === "draft" ? "Draft" : p === "cancelled" ? "Cancelled" : "Submitted";
  return <span className={`badge ${cls}`}>{label}</span>;
}

/* ── Record Payment sheet — the multi-payment core ──────────────────────────
   A repeatable bottom sheet: the salesperson records ONE payment at a time, and
   each successful record accumulates on the SO (2, 3, N payments per order). It
   mirrors the desktop PaymentsTable's per-row contract:
     • method-aware sub-fields — Cash / Online (sub-type) / Merchant (bank +
       plan) / Installment (plan)
     • a slip photo (image/*, PDF) uploaded via uploadSlipFull → uploadSessionId
     • POST /mfg-sales-orders/:docNo/payments with the full field set

   The backend REQUIRES a slip (slip_required) and rejects over-payment
   (over_payment); both surface through useNotify. On success the caller
   invalidates the payments + header queries so the balance updates live. */

// Method label → backend enum (transfer surfaces as "Online" in the UI).
const PAY_METHODS: Array<{ label: string; code: "cash" | "transfer" | "merchant" | "installment" }> = [
  { label: "Cash", code: "cash" },
  { label: "Online", code: "transfer" },
  { label: "Merchant", code: "merchant" },
  { label: "Installment", code: "installment" },
];
const BANK_OPTS = ["Maybank", "CIMB", "Public Bank", "HSBC", "RHB"];
const PLAN_OPTS = ["One Shot", "6 months", "12 months", "24 months", "36 months"];
const ONLINE_OPTS = ["Bank Transfer", "TNG eWallet", "DuitNow", "Cheque"];
// 'One Shot' → null (no installment); 'N months' → N.
const planToMonths = (label: string): number | null => {
  const m = /^(\d+)\s*month/i.exec(label.trim());
  return m ? Number(m[1]) : null;
};

function RecordPaymentSheet({
  docNo, totalCenti, paidCenti, balanceCenti, onClose, onDone,
}: {
  docNo: string;
  totalCenti: number;
  paidCenti: number;
  balanceCenti: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const notify = useNotify();
  const staffQ = useStaff();
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [amount, setAmount] = useState(() => (balanceCenti > 0 ? (balanceCenti / 100).toFixed(2) : ""));
  const [methodCode, setMethodCode] = useState<"cash" | "transfer" | "merchant" | "installment">("cash");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [bank, setBank] = useState(BANK_OPTS[0]);
  const [plan, setPlan] = useState(PLAN_OPTS[0]);
  const [online, setOnline] = useState(ONLINE_OPTS[0]);
  const [account, setAccount] = useState("");
  const [approval, setApproval] = useState("");
  const [collectedBy, setCollectedBy] = useState("");
  const [slipName, setSlipName] = useState<string | null>(null);
  const [slipSession, setSlipSession] = useState<string | null>(null);
  const [slipPhase, setSlipPhase] = useState<"" | "uploading" | "done" | "error">("");
  const [error, setError] = useState<string | null>(null);

  const staff = staffQ.data ?? [];

  const onPickFile = async (f: File | null) => {
    if (!f) return;
    setError(null);
    setSlipName(f.name);
    setSlipSession(null);
    setSlipPhase("uploading");
    try {
      const { uploadSessionId } = await uploadSlipFull({ file: f });
      setSlipSession(uploadSessionId);
      setSlipPhase("done");
    } catch (e) {
      setSlipPhase("error");
      setError(e instanceof Error ? e.message : "Slip upload failed. Please try again.");
    }
  };

  const mutation = useMutation({
    mutationFn: async () => {
      const amountCenti = Math.round(Number(String(amount).replace(/,/g, "")) * 100);
      if (!Number.isFinite(amountCenti) || amountCenti <= 0) throw new Error("Enter a valid amount greater than zero.");
      if (!slipSession) throw new Error("slip_required");
      const body: Record<string, unknown> = {
        paidAt: date,
        method: methodCode,
        amountCenti,
        accountSheet: account.trim() || null,
        approvalCode: approval.trim() || null,
        collectedBy: collectedBy || null,
        uploadSessionId: slipSession,
      };
      if (methodCode === "merchant") {
        body.merchantProvider = bank || null;
        body.installmentMonths = planToMonths(plan);
      } else if (methodCode === "installment") {
        body.installmentMonths = planToMonths(plan);
      } else if (methodCode === "transfer") {
        body.onlineType = online || null;
      }
      await authedFetch(`/mfg-sales-orders/${encodeURIComponent(docNo)}/payments`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    onSuccess: () => { onDone(); onClose(); void notify({ title: "Payment recorded" }); },
    onError: (e) => {
      const msg = e instanceof Error ? e.message : String(e);
      if (/slip_required/i.test(msg)) setError("Please capture the payment slip before recording.");
      else if (/over_payment/i.test(msg)) setError("This amount exceeds the order balance. Reduce it and try again.");
      else setError(msg || "Couldn't record the payment. Please try again.");
    },
  });

  const inputStyle: React.CSSProperties = {
    width: "100%", boxSizing: "border-box", height: 42, padding: "0 12px", borderRadius: 10,
    border: "1px solid #e3e6e0", background: "#fff", fontFamily: "inherit", fontSize: 14, color: "var(--ink)",
  };
  const selStyle: React.CSSProperties = { ...inputStyle, appearance: "none", WebkitAppearance: "none" };
  const labelStyle: React.CSSProperties = { fontSize: 9.5, fontWeight: 700, letterSpacing: ".14em", textTransform: "uppercase", color: "#9aa093", marginBottom: 5, display: "block" };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 2500, background: "rgba(0,0,0,0.32)", display: "flex", alignItems: "flex-end" }}>
      <div onClick={(e) => e.stopPropagation()} className="hz-m" style={{ width: "100%", maxHeight: "88vh", overflowY: "auto", background: "#fff", borderRadius: "18px 18px 0 0", padding: "18px 16px calc(env(safe-area-inset-bottom) + 16px)", boxShadow: "0 -8px 28px rgba(0,0,0,0.16)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: "var(--ink)" }}>Record Payment</div>
          <button onClick={onClose} style={{ border: "none", background: "transparent", fontSize: 15, fontWeight: 700, color: "var(--teal)", cursor: "pointer", fontFamily: "inherit" }}>Close</button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 14 }}>
          <MiniStat label="Total" value={rm(totalCenti)} color="var(--ink)" />
          <MiniStat label="Paid" value={rm(paidCenti)} color="#2f8a5b" />
          <MiniStat label="Balance" value={rm(balanceCenti)} color={balanceCenti > 0 ? "#a16a2e" : "var(--ink)"} />
        </div>

        <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>Amount (RM)</label>
            <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" style={inputStyle} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>Date</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={inputStyle} />
          </div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>Method</label>
          <select value={methodCode} onChange={(e) => setMethodCode(e.target.value as typeof methodCode)} style={selStyle}>
            {PAY_METHODS.map((m) => <option key={m.code} value={m.code}>{m.label}</option>)}
          </select>
        </div>

        {methodCode === "merchant" && (
          <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>Bank</label>
              <select value={bank} onChange={(e) => setBank(e.target.value)} style={selStyle}>{BANK_OPTS.map((o) => <option key={o} value={o}>{o}</option>)}</select>
            </div>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>Plan</label>
              <select value={plan} onChange={(e) => setPlan(e.target.value)} style={selStyle}>{PLAN_OPTS.map((o) => <option key={o} value={o}>{o}</option>)}</select>
            </div>
          </div>
        )}
        {methodCode === "installment" && (
          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>Installment plan</label>
            <select value={plan} onChange={(e) => setPlan(e.target.value)} style={selStyle}>{PLAN_OPTS.map((o) => <option key={o} value={o}>{o}</option>)}</select>
          </div>
        )}
        {methodCode === "transfer" && (
          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>Sub-type</label>
            <select value={online} onChange={(e) => setOnline(e.target.value)} style={selStyle}>{ONLINE_OPTS.map((o) => <option key={o} value={o}>{o}</option>)}</select>
          </div>
        )}

        <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>Account Sheet</label>
            <input value={account} onChange={(e) => setAccount(e.target.value)} placeholder="Sheet ref" style={inputStyle} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>Approval Code</label>
            <input value={approval} onChange={(e) => setApproval(e.target.value)} placeholder="Terminal no" style={inputStyle} />
          </div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>Collected By</label>
          <select value={collectedBy} onChange={(e) => setCollectedBy(e.target.value)} style={selStyle}>
            <option value="">—</option>
            {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={labelStyle}>Payment Slip (required)</label>
          <input ref={fileRef} type="file" accept="image/*,application/pdf" style={{ display: "none" }} onChange={(e) => { void onPickFile(e.target.files?.[0] ?? null); e.target.value = ""; }} />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={slipPhase === "uploading"}
            style={{
              width: "100%", boxSizing: "border-box", height: 42, borderRadius: 10, cursor: "pointer", fontFamily: "inherit", fontSize: 12.5, fontWeight: 700,
              border: slipPhase === "done" ? "1px solid #bcdcd7" : "1px solid #d6d9d2",
              background: slipPhase === "done" ? "#e1efed" : "#f4f6f3",
              color: slipPhase === "done" ? "#16695f" : "#414539",
              display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
            }}
          >
            {slipPhase === "uploading" ? "Uploading…"
              : slipPhase === "done" ? `Slip attached · ${slipName ?? ""}`
              : slipPhase === "error" ? "Retry slip upload"
              : "Capture / attach slip"}
          </button>
        </div>

        {error && <div style={{ fontSize: 11.5, color: "#b23a3a", marginBottom: 12, textAlign: "center" }}>{error}</div>}

        <button
          className="btn"
          disabled={mutation.isPending || slipPhase === "uploading"}
          onClick={() => { setError(null); mutation.mutate(); }}
          style={{ opacity: mutation.isPending || slipPhase === "uploading" ? 0.6 : 1 }}
        >
          {mutation.isPending ? "Recording…" : "Record Payment"}
        </button>
      </div>
    </div>
  );
}

function MiniStat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ background: "#f4f6f3", border: "1px solid #e3e6e0", borderRadius: 11, padding: "9px 6px", textAlign: "center" }}>
      <div className="money" style={{ fontSize: 12.5, fontWeight: 800, color }}>{value}</div>
      <div style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", color: "#9aa093", marginTop: 3 }}>{label}</div>
    </div>
  );
}
