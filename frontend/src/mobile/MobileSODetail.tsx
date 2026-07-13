import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { authedFetch } from "../vendor/scm/lib/authed-fetch";
import { useConfirm } from "../vendor/scm/components/ConfirmDialog";
import { useNotify } from "../vendor/scm/components/NotifyDialog";
import { fetchPaymentSlipUrl, fetchScanSlipImageBlobUrl, uploadSlipFull } from "../vendor/scm/lib/slip";
import { useStaff } from "../vendor/scm/lib/admin-queries";
import { useAuth as useHouzsAuth } from "../auth/AuthContext";
import {
  useSalesOrderAuditLog,
  type SoAuditEntry,
  type SoAuditFieldChange,
} from "../vendor/scm/lib/sales-order-queries";
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
  /* Task #121 — country snapshot auto-derived from customer_state (mig 0082).
     Desktop SO Detail surfaces it as the address block's Country line. */
  customer_country: string | null;
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
  /* venue = free-text venue name (customer-facing, on PDFs); venue_id = the
     master FK (mig 0086). Desktop reads the name for display, id as fallback. */
  venue: string | null;
  venue_id: string | null;
  note: string | null;
  /* Delivery address columns — the desktop SO form maps these to labelled
     lines (address1/2 = free-text; address3 = city fallback; address4 =
     postcode fallback; customer_state = State; customer_country = Country).
     The header also carries `city`/`postcode` proper columns, so read those
     first and fall back to address3/address4 exactly like desktop. */
  address1: string | null;
  address2: string | null;
  address3: string | null;
  address4: string | null;
  city: string | null;
  postcode: string | null;
  processing_date: string | null;
  customer_delivery_date: string | null;
  internal_expected_dd: string | null;
  /* proceeded_at — when the salesperson proceeded the order (server-stamped).
     Used with internal_expected_dd to reflect the processing-date LOCK. */
  proceeded_at: string | null;
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
  /* Scan-flow proof photos (migrations 0033 + 0034) — R2 keys for the
     handwritten order slip and the card-terminal payment receipt this SO was
     scanned from. Dual-read camelCase ?? snake_case at the use site (the pg
     driver camelCases result columns on some paths). */
  slip_image_key: string | null;
  receipt_image_key: string | null;
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
  collected_by: string | null;
  collected_by_name: string | null;
  amount_centi: number | null;
  slip_key: string | null;
  /* Row creation instant (UTC) — drives the same-day EDIT affordance (a payment
     may be corrected only on the MY calendar day it was recorded). */
  created_at: string | null;
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
/* Today in Malaysia (UTC+8) as YYYY-MM-DD — shift +8h then read the UTC date. */
const todayMyt = (): string =>
  new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
/* True when the given instant (UTC ISO) falls on the current MY calendar day —
   drives the same-day payment EDIT affordance. */
const isCreatedTodayMyt = (createdAt: string | null | undefined): boolean => {
  if (!createdAt) return false;
  const t = new Date(createdAt).getTime();
  if (Number.isNaN(t)) return false;
  return new Date(t + 8 * 3600 * 1000).toISOString().slice(0, 10) === todayMyt();
};

/** Sales Order DETAIL — markup ported VERBATIM from the owner's mobile design
 *  (`#so-detail` + `renderSoDetail`/`openSO`), wired to the real
 *  /mfg-sales-orders/:docNo (header + line items) and /:docNo/payments.
 *  Draft/Submitted actions PATCH /:docNo/status. Design classes only. */
export function MobileSODetail({ docNo, onBack, onEdit }: { docNo: string; onBack: () => void; onEdit?: (docNo: string) => void }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

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
  const houzsAuth = useHouzsAuth();
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

  /* Processing-date LOCK — mirrors the desktop SO Detail form's
     `processingLocked` (SalesOrderDetail.tsx): the Processing Date is the day
     production started, so once MYT today is AFTER internal_expected_dd AND the
     order has been proceeded, that date (and the production spec built off it)
     is a historical record. Desktop keeps the field read-only; here we surface
     a banner and treat the SO as edit-locked so the detail never offers
     line-item edits on a proceeded, past-processing order. `today` is the local
     (MYT on the operator's device) YYYY-MM-DD, string-compared like desktop. */
  const today = new Date().toLocaleDateString("en-CA");
  const originalProcessing = (h?.internal_expected_dd ?? "").slice(0, 10);
  const processingLocked = originalProcessing !== "" && originalProcessing < today && Boolean(h?.proceeded_at);

  const editLocked = LOCKED.includes(rawStatus) || hasChildren || processingLocked;

  /* Owner rule 2026-07-05 (desktop parity, SalesOrderDetail.tsx): a PROCEEDED
     order that's past its processing date freezes its LINE ITEMS + State /
     Postcode (that's `editLocked` above, which feeds the Edit button), but
     PAYMENT must STAY addable. Desktop keeps this exact split — its
     PaymentsTable `locked` prop is `isLocked` (SHIPPED+ / downstream children)
     ONLY, deliberately NOT the processing lock. Mirror that here: payment is
     lock-gated only by the terminal / downstream statuses, never by the
     processing lock. Drafts + cancelled orders still take NO payment (owner:
     "no payments on drafts"), matching desktop hiding Add Payment off-status. */
  const paymentLocked = LOCKED.includes(rawStatus) || hasChildren;
  const canAddPayment = ph === "submitted" && !paymentLocked;
  const [payOpen, setPayOpen] = useState(false);
  /* Same-day EDIT (owner 2026-07-13) — the payment row being edited (null = the
     Add-Payment sheet is in create mode / closed). */
  const [editPay, setEditPay] = useState<SoPayment | null>(null);

  /* Collected By default = the logged-in user (owner option B). The detail
     header has no staff id for the viewer, so resolve it by matching the Houzs
     session email against the shared /staff list; '' when unmatched (dropdown
     falls back to "—"). Seeds NEW payment rows only. */
  const authEmail = houzsAuth.user?.email ?? null;
  const defaultCollectedBy =
    (authEmail
      ? (staffQ.data ?? []).find(
          (s) => s.email && s.email.toLowerCase() === authEmail.toLowerCase(),
        )?.id
      : "") ?? "";

  /* Refresh the payments ledger + header KPIs after a payment posts. Reused by
     both the delete action and the standalone Add-Payment sheet's onSaved. */
  const refreshAfterPayment = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ["mobile-so-payments", docNo] }),
      qc.invalidateQueries({ queryKey: ["mobile-so-detail", docNo] }),
      qc.invalidateQueries({ queryKey: ["mobile-so-list"] }),
    ]);

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
      await refreshAfterPayment();
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
        <div className="eyebrow" style={{ marginTop: 7, display: "flex", alignItems: "center", gap: 6, minWidth: 0, flexWrap: "wrap" }}>
          <span className="money" style={{ flex: "none" }}>{h?.doc_no ?? docNo}</span>
          {(h?.customer_so_no || h?.ref || h?.po_doc_no) && (<><span style={{ opacity: .5, flex: "none" }}>·</span><span className="money" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{h?.customer_so_no || h?.ref || h?.po_doc_no}</span></>)}
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
            {/* DRAFT banner — owner 2026-07-04: "根本不知道自己是在 Confirm 还是
                Draft". An unmissable amber card sits FIRST, directly under the
                header, whenever the SO is still a draft. Pairs with the amber
                Draft pill in the header (StatusPill below). */}
            {ph === "draft" && (
              <div role="status" style={{ display: "flex", alignItems: "flex-start", gap: 9, background: "var(--amber-bg, #f6efd9)", border: "1px solid #e0cf9e", borderRadius: 12, padding: "11px 13px", marginBottom: 12 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--amber, #8a6a2e)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}><path d="M12 9v4" /><path d="M12 17h.01" /><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" /></svg>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--amber, #8a6a2e)" }}>Draft — not confirmed</div>
                  <div style={{ fontSize: 11.5, color: "#6d5626", marginTop: 2, lineHeight: 1.45 }}>This order is not confirmed yet. Review it and tap Create Sales Order to confirm.</div>
                </div>
              </div>
            )}

            {/* Locked-view hint (design VERBATIM) — Edit unlocks the same New SO
                form; there's no in-place edit here, so wording drops the mode.
                When the SO is genuinely edit-locked (SHIPPED+ / downstream DO-SI /
                past-processing proceeded order) the banner turns orange and names
                the reason, mirroring the desktop SO Detail lock banner — and the
                footer Edit button is disabled below. */}
            {editLocked ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8, background: "rgba(232,107,58,0.08)", border: "1px solid var(--c-orange, #e86b3a)", borderRadius: 10, padding: "9px 11px", marginBottom: 12, fontSize: 11, color: "#8a4a24" }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#c66a34" strokeWidth="2" strokeLinecap="round"><rect x="4" y="10" width="16" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>
                {processingLocked
                  ? "Locked — the processing date has passed and this order was proceeded. Line items can't be edited."
                  : hasChildren
                  ? "Locked — a delivery order or invoice references this SO. Line items can't be edited."
                  : "Locked — this order has moved past editing. Line items can't be edited."}
              </div>
            ) : (
              <div style={{ display: "flex", alignItems: "center", gap: 8, background: "#eef1ec", border: "1px solid #e3e6e0", borderRadius: 10, padding: "9px 11px", marginBottom: 12, fontSize: 11, color: "#5c6156" }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#767b6e" strokeWidth="2" strokeLinecap="round"><rect x="4" y="10" width="16" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>
                Locked view — tap Edit to change. Same form as New SO.
              </div>
            )}

            {/* KPI — Total / Paid / Balance. Colours VERBATIM from the design:
                Total + Paid both brand-dark (#0c3f39), Balance always red
                (#b23a3a). Overflow-hardened for 375px (owner 2026-07-04 "上面
                那一块都爆掉了"): flex 1 1 0 + minWidth 0 per card, tighter
                gap/padding, ellipsis-safe nowrap values, and the RM figure
                steps down a size once it passes 6 digits — see <Kpi/>. */}
            <div style={{ display: "flex", gap: 7, marginBottom: 12 }}>
              <Kpi label="Total" centi={total(h)} color="#0c3f39" />
              <Kpi label="Paid" centi={h.paid_centi_total} color="#0c3f39" />
              <Kpi label="Balance" centi={bal} color="#b23a3a" />
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
              <div style={{ display: "flex", gap: 9 }}><div style={{ flex: 1, minWidth: 0 }}><RoField label="Building type" value={val(h.building_type)} /></div><div style={{ flex: 1, minWidth: 0 }}><RoField label="Venue" value={val(h.venue ?? h.venue_id)} /></div></div>
              <div style={{ display: "flex", gap: 9 }}><div style={{ flex: 1, minWidth: 0 }}><RoField label="Processing date" value={dl(h.internal_expected_dd ?? h.processing_date)} mono /></div><div style={{ flex: 1, minWidth: 0 }}><RoField label="Delivery date" value={dl(h.customer_delivery_date)} mono /></div></div>
              <RoField label="Sales location" value={val(h.sales_location ?? h.customer_state)} />
              <RoField label="Note" value={val(h.note)} />
            </div></div>

            {/* Delivery address — the STRUCTURED parts the desktop SO form shows,
                each labelled (not one concatenated blob). Desktop mapping:
                address1/2 = free-text lines; City = city ?? address3; Postcode =
                postcode ?? address4; State = customer_state; Country =
                customer_country. Individually em-dashed when blank. */}
            <div className="card"><div className="card-h"><span className="card-t">Delivery address</span></div><div className="card-b">
              <RoField label="Address line 1" value={val(h.address1)} />
              <RoField label="Address line 2" value={val(h.address2)} />
              <div style={{ display: "flex", gap: 9 }}>
                <div style={{ flex: 1, minWidth: 0 }}><RoField label="City" value={val(h.city ?? h.address3)} /></div>
                <div style={{ flex: 1, minWidth: 0 }}><RoField label="Postcode" value={val(h.postcode ?? h.address4)} mono /></div>
              </div>
              <div style={{ display: "flex", gap: 9 }}>
                <div style={{ flex: 1, minWidth: 0 }}><RoField label="State" value={val(h.customer_state)} /></div>
                <div style={{ flex: 1, minWidth: 0 }}><RoField label="Country" value={val(h.customer_country)} /></div>
              </div>
            </div></div>

            {/* Line items — description / variants / SKU / ×qty / line total */}
            <div className="card"><div className="card-h"><span className="card-t">Line items</span><span className="card-sub">{items.length} {items.length === 1 ? "line" : "lines"}</span></div>
              {items.length ? items.map((it, i) => {
                /* Owner 2026-07-04 — the long product name 爆掉/被挤掉 at phone
                   width ("呈现 Code 即可"): the row's primary label is the item
                   CODE (dual-read camelCase ?? snake_case), the name dropped.
                   Description only shows when the line carries no code at all. */
                const code = (((it as unknown as { itemCode?: string | null }).itemCode ?? it.item_code) ?? "").trim();
                return (
                <div key={it.id} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "11px 13px", borderTop: i ? "1px solid var(--line2)" : "none" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="money" style={{ fontSize: 13, fontWeight: 700, color: "var(--ink)" }}>{code || it.description || "—"}</div>
                    {/* Category-aware variant spec (sofa Fabric·config / bedframe
                        size·Headboard·Storage / mattress size·firmness·height) —
                        built from the variants JSON; falls back to the server's
                        stamped description2 summary when variants is empty. */}
                    {(() => { const vs = buildVariantSummary(it.item_group, it.variants) || (it.description2 ?? "").trim(); return vs ? <div style={{ fontSize: 11.5, color: "var(--mut)", marginTop: 2 }}>{vs}</div> : null; })()}
                    {/* UOM only — the code moved up to the primary line. */}
                    {(it.uom ?? "").trim() ? <div className="money" style={{ fontSize: 10, color: "var(--mut2)", marginTop: 3 }}>{it.uom!.trim()}</div> : null}
                  </div>
                  <div style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <div className="money" style={{ fontSize: 13, fontWeight: 700, color: "#0c3f39" }}>RM {rm(lineTotalCenti(it))}</div>
                    <div className="money" style={{ fontSize: 11, color: "var(--mut)", marginTop: 2 }}>×{it.qty ?? 0}</div>
                  </div>
                </div>
                );
              }) : <div style={{ padding: "11px 13px", borderTop: "1px solid var(--line2)", fontSize: 11.5, color: "var(--mut2)" }}>No items.</div>}
            </div>

            {/* Photos — the scan-flow proof images (order slip + payment receipt),
                parity with desktop's ScannedImageCard pair. Owner 2026-07-04
                asked "which button shows the customer's photographed order slip":
                the card sits HIGH (right under Line items, above Payments) so the
                Order slip thumbnail is easy to find, and each thumb is
                tap-to-fullscreen. Keys dual-read camelCase ?? snake_case; the
                whole card is hidden only when the SO carries NEITHER key
                (hand-keyed orders). Served as authed blob fetches — the bearer
                can't ride on an <img src>. */}
            {(() => {
              const slipImageKey =
                (h as unknown as { slipImageKey?: string | null }).slipImageKey ?? h.slip_image_key ?? null;
              // Owner: the payment RECEIPT does NOT belong in this card -- it
              // lives on its payment row's slip (the camera icon there). This
              // card shows ONLY the customer's order slip.
              if (!slipImageKey) return null;
              return <ScannedPhotosCard slipKey={slipImageKey} receiptKey={null} />;
            })()}

            {/* Payments — read-only rows (method / date · account · collected_by /
                approval / amount), design layout. Recording a payment normally
                lives INSIDE Edit (MobileNewSO edit mode's PAYMENTS card), but a
                payment must STAY addable even when the SO is edit-locked (owner
                rule 2026-07-05 + desktop parity — see paymentLocked above). So a
                standalone "Add Payment" control sits on THIS card's header,
                gated by `canAddPayment` (submitted status, not SHIPPED+/child-
                locked) and NOT by the processing lock. The per-row delete stays
                parity with desktop PaymentsTable (hidden on cancelled / SHIPPED+
                / child-locked via editLocked). */}
            <div className="card"><div className="card-h"><span className="card-t">Payments</span>
              <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                {!!payments.length && <span className="card-sub">{payments.length}</span>}
                {canAddPayment && (
                  <button
                    type="button"
                    onClick={() => setPayOpen(true)}
                    className="money"
                    style={{ border: "1px solid #bcdcd7", background: "#e1efed", color: "#16695f", fontFamily: "inherit", fontSize: 11.5, fontWeight: 700, borderRadius: 8, padding: "4px 10px", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4 }}
                  >
                    <span style={{ fontSize: 13, lineHeight: 1 }}>+</span> Add Payment
                  </button>
                )}
              </span>
            </div>
              {paymentsQ.isLoading && <div style={{ padding: "11px 13px", borderTop: "1px solid var(--line2)", fontSize: 11.5, color: "var(--mut2)" }}>Loading{"…"}</div>}
              {!paymentsQ.isLoading && (payments.length ? payments.map((p, i) => (
                <div key={p.id} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "11px 13px", borderTop: i ? "1px solid var(--line2)" : "none", alignItems: "center" }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--ink)" }}>{methodLabel(p.method)}</div>
                    <div className="money" style={{ fontSize: 10.5, color: "var(--mut)", marginTop: 2 }}>{[dm(p.paid_at), p.account_sheet, p.collected_by_name].filter((x) => x && String(x).trim()).join(" · ")}</div>
                    {/* Bank + tenure (Merchant) / online type (Transfer) — parity
                        with desktop PaymentsTable. Dual-read camelCase ?? snake_case. */}
                    {(() => {
                      const pc = p as unknown as { merchantProvider?: string | null; installmentMonths?: number | null; onlineType?: string | null };
                      const bank = pc.merchantProvider ?? p.merchant_provider;
                      const months = pc.installmentMonths ?? p.installment_months;
                      const online = pc.onlineType ?? p.online_type;
                      if (p.method === "merchant") {
                        const tenure = typeof months === "number" ? `${months} month${months === 1 ? "" : "s"}` : "One shot";
                        return <div className="money" style={{ fontSize: 10, color: "var(--mut2)" }}>{[bank, tenure].filter((x) => x && String(x).trim()).join(" · ")}</div>;
                      }
                      if (p.method === "transfer" && online) {
                        return <div className="money" style={{ fontSize: 10, color: "var(--mut2)" }}>{online}</div>;
                      }
                      return null;
                    })()}
                    {p.approval_code ? <div className="money" style={{ fontSize: 10, color: "var(--mut2)" }}>Approval {p.approval_code}</div> : null}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    {/* Slip present — dual-read camelCase ?? snake_case. */}
                    {((p as unknown as { slipKey?: string | null }).slipKey ?? p.slip_key) ? <SlipLink docNo={docNo} paymentId={p.id} /> : null}
                    <span className="money-row">RM {rm(p.amount_centi)}</span>
                    {/* Same-day EDIT (owner 2026-07-13) — pencil shown only for a
                        payment recorded today; after MYT midnight it locks. Same
                        cancelled / edit-locked hide as the delete button. */}
                    {ph !== "cancelled" && !editLocked && isCreatedTodayMyt((p as unknown as { createdAt?: string | null }).createdAt ?? p.created_at) && (
                      <button
                        type="button"
                        onClick={() => setEditPay(p)}
                        disabled={busy}
                        title="Edit payment (same-day only)"
                        aria-label="Edit payment"
                        style={{ border: "none", background: "transparent", cursor: "pointer", padding: "0 4px", display: "flex", alignItems: "center", opacity: busy ? 0.4 : 1 }}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2f5d4f" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
                      </button>
                    )}
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

            {/* History — owner requirement (Inistate-style audit timeline): WHO
                created / edited / changed status, WHEN, via WHICH app, with an
                expandable field-level old → new diff. Accordion follows the
                card pattern above; the audit-log fetch is LAZY — it only fires
                the first time the section is opened (mirrors desktop's
                historyOpen-mounted HistoryPanel). */}
            <HistoryCard docNo={docNo} />

            {actionError && <div style={{ marginTop: 13, fontSize: 11.5, color: "var(--red)", textAlign: "center" }}>{actionError}</div>}
          </div>
        )}
      </div>

      {/* Standalone Add-Payment sheet — reuses uploadSlipFull + the SAME
          POST /:docNo/payments body the Edit flow uses (recordSlipBackedPayments).
          Reachable even when the SO is edit-locked, because payment is never
          lock-gated (only status/downstream via canAddPayment). */}
      {(payOpen || editPay) && h && (
        <AddPaymentSheet
          docNo={docNo}
          staff={staffQ.data ?? []}
          defaultCollectedBy={defaultCollectedBy}
          editPayment={editPay}
          onClose={() => { setPayOpen(false); setEditPay(null); }}
          onSaved={async () => {
            setPayOpen(false);
            setEditPay(null);
            await refreshAfterPayment();
          }}
        />
      )}

      {!detail.isLoading && !detail.error && h && (
        <footer className="actbar">
          {/* No Add Payment in the FOOTER — the standalone Add-Payment entry
              lives on the Payments card header (see AddPaymentSheet above), so
              it stays reachable even when this footer's Edit button is locked.
              Adding a payment through Edit (MobileNewSO's PAYMENTS card) also
              still works when the SO is unlocked. */}
          {ph === "draft" && (
            <div style={{ display: "flex", gap: 9 }}>
              <button className="btn-ghost" style={{ flex: 1, opacity: busy ? 0.55 : 1 }} disabled={busy} onClick={() => onEdit?.(docNo)}>Edit Draft</button>
              <button className="btn" style={{ flex: 1.3, opacity: busy ? 0.55 : 1 }} disabled={busy} onClick={() => setStatus("CONFIRMED")}>{busy ? "Working…" : "Create Sales Order"}</button>
            </div>
          )}
          {ph === "submitted" && (
            <>
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

    </div>
  );
}

/* Method code → human label for the read-only payments list. Backend stores the
   locked enum (cash|transfer|merchant|installment); render the SO-form value the
   operator recognises (transfer surfaces as "Online" per the shared map). */
const METHOD_LABELS: Record<string, string> = { cash: "Cash", transfer: "Online", merchant: "Merchant", installment: "Installment" };
const methodLabel = (m: string | null): string => (m ? METHOD_LABELS[m] ?? m : "—");

/* KPI stat card — one third of the Total / Paid / Balance strip. Sized to fit
   three-up at 375px: flex 1 1 0 (equal thirds regardless of content width) +
   minWidth 0 so a long RM figure can't blow the row open; the value line is
   nowrap + ellipsis as the final safety net. `.money` supplies tabular-nums.
   The figure renders at 13.5px and steps down to 12px once the amount passes
   6 digits (>= RM 10,000.00); the "RM" prefix rides smaller so the digits keep
   the room. Visual style (card / .fld-l label / weights / colours) unchanged
   from the design. */
function Kpi({ label, centi, color }: { label: string; centi: number | null | undefined; color: string }) {
  const v = rm(centi);
  const big = v.replace(/\D/g, "").length > 6;
  return (
    <div className="card" style={{ flex: "1 1 0", minWidth: 0, marginBottom: 0 }}>
      <div className="card-b" style={{ padding: "9px 9px" }}>
        <div className="fld-l" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</div>
        <div className="money" style={{ fontSize: big ? 12 : 13.5, fontWeight: 800, color, marginTop: 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          <span style={{ fontSize: big ? 9 : 10, fontWeight: 700, opacity: 0.75, marginRight: 3 }}>RM</span>{v}
        </div>
      </div>
    </div>
  );
}

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

/* Slip link on a persisted payment row — blob-fetches the slip on demand
   (GET /:docNo/payments/:id/slip-url, Worker-proxied) and opens the object
   URL in a new tab. */
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

/* ── Add Payment sheet ───────────────────────────────────────────────────────
   Standalone payment-recording flow for a LOCKED (or unlocked) submitted SO.
   Records ONE slip-backed payment through POST /:docNo/payments — the SAME
   endpoint + body shape MobileNewSO.recordSlipBackedPayments uses — and reuses
   uploadSlipFull for the slip. The SO payments route REQUIRES a slip, so Save
   stays disabled until an amount > 0 AND a confirmed slip upload session exist
   (mirrors desktop PaymentsTable.commitDraft's gate). No pricing logic lives
   here; the backend recomputes the balance. Design = the shared .hz-m bottom
   sheet + fld / fld-i / fld-l classes. */

const PAY_METHODS = ["Cash", "Merchant", "Online", "Installment"] as const;
type PayMethodLabel = (typeof PAY_METHODS)[number];
/* Payment-row method label → backend enum (transfer surfaces as "Online") —
   the SAME map MobileNewSO uses (PAY_METHOD_CODE). */
const PAY_METHOD_CODE: Record<string, "cash" | "transfer" | "merchant" | "installment"> = {
  Cash: "cash", Online: "transfer", Merchant: "merchant", Installment: "installment",
};
const BANK_OPTS = ["Maybank", "CIMB", "Public Bank", "HSBC", "RHB"];
const PLAN_OPTS = ["One Shot", "6 months", "12 months", "24 months", "36 months"];
const ONLINE_OPTS = ["Bank Transfer", "TNG eWallet", "DuitNow", "Cheque"];
/* 'One Shot' → null (no installment term); 'N months' → N. Same as MobileNewSO. */
const planToMonths = (label: string): number | null => {
  const m = /^(\d+)\s*month/i.exec(String(label).trim());
  return m ? Number(m[1]) : null;
};
/* Reverse of PAY_METHOD_CODE (backend enum → sheet label) — rehydrates the
   Method select when editing a persisted payment. */
const CODE_TO_PAY_METHOD: Record<string, PayMethodLabel> = {
  cash: "Cash", transfer: "Online", merchant: "Merchant", installment: "Installment",
};
/* installment_months (int|null) → the Plan option label to rehydrate the select
   when editing. null / unmatched → "One Shot". */
const monthsToPlan = (months: number | null | undefined): string => {
  if (!months) return PLAN_OPTS[0];
  return PLAN_OPTS.find((p) => planToMonths(p) === months) ?? `${months} months`;
};
const toCenti = (s: string) => Math.round((parseFloat(String(s).replace(/,/g, "")) || 0) * 100);

function AddPaymentSheet({
  docNo,
  staff,
  defaultCollectedBy = "",
  editPayment = null,
  onClose,
  onSaved,
}: {
  docNo: string;
  staff: Array<{ id: string; name: string }>;
  /* Collected By default for a NEW payment = logged-in user's staff id. */
  defaultCollectedBy?: string;
  /* When set, the sheet EDITS this persisted payment (PATCH) instead of adding
     a new one (POST). Same fields, seeded from the row. */
  editPayment?: SoPayment | null;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const notify = useNotify();
  const isEdit = Boolean(editPayment);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [method, setMethod] = useState<PayMethodLabel>(
    () => (editPayment ? CODE_TO_PAY_METHOD[editPayment.method ?? "cash"] ?? "Cash" : "Cash"),
  );
  const [date, setDate] = useState<string>(
    () => (editPayment?.paid_at ?? "").slice(0, 10) || new Date().toISOString().slice(0, 10),
  );
  const [amount, setAmount] = useState(
    () => (editPayment ? ((editPayment.amount_centi ?? 0) / 100).toFixed(2) : "0.00"),
  );
  const [account, setAccount] = useState(editPayment?.account_sheet ?? "");
  const [approval, setApproval] = useState(editPayment?.approval_code ?? "");
  const [collectedBy, setCollectedBy] = useState(editPayment?.collected_by ?? defaultCollectedBy);
  const [bank, setBank] = useState(editPayment?.merchant_provider || BANK_OPTS[0]);
  const [plan, setPlan] = useState(() => (editPayment ? monthsToPlan(editPayment.installment_months) : PLAN_OPTS[0]));
  const [online, setOnline] = useState(editPayment?.online_type || ONLINE_OPTS[0]);
  const [slipName, setSlipName] = useState("");
  const [slipSession, setSlipSession] = useState("");
  const [slipPhase, setSlipPhase] = useState<"" | "uploading" | "done" | "error">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onPickSlip = async (f: File | null) => {
    if (!f) return;
    setSlipName(f.name); setSlipSession(""); setSlipPhase("uploading");
    try {
      const { uploadSessionId } = await uploadSlipFull({ file: f });
      setSlipSession(uploadSessionId); setSlipPhase("done");
    } catch {
      setSlipPhase("error");
    }
  };

  const amtOk = toCenti(amount) > 0;
  /* Owner 2026-07-13 — the slip is OPTIONAL now; recording needs only an
     amount > 0 (+ method/date). The slip upload stays available for when one IS
     on hand. */
  const canSave = amtOk && !busy && slipPhase !== "uploading";

  const save = async () => {
    if (!canSave) return;
    setError(null);
    setBusy(true);
    /* Same body MobileNewSO.recordSlipBackedPayments POSTs — do NOT reimplement
       pricing; the backend recomputes the balance from the amount. In EDIT mode
       the same fields PATCH the existing row (slip untouched). */
    const code = PAY_METHOD_CODE[method] ?? "cash";
    const body: Record<string, unknown> = {
      paidAt: date,
      method: code,
      amountCenti: toCenti(amount),
      accountSheet: account.trim() || null,
      approvalCode: approval.trim() || null,
      collectedBy: collectedBy || null,
    };
    // Slip is optional — only send the session when one was actually uploaded.
    if (!isEdit && slipSession) body.uploadSessionId = slipSession;
    if (code === "merchant") { body.merchantProvider = bank || null; body.installmentMonths = planToMonths(plan); }
    else if (code === "installment") { body.installmentMonths = planToMonths(plan); }
    else if (code === "transfer") { body.onlineType = online || null; }
    try {
      if (isEdit && editPayment) {
        await authedFetch(`/mfg-sales-orders/${encodeURIComponent(docNo)}/payments/${encodeURIComponent(editPayment.id)}`, {
          method: "PATCH", body: JSON.stringify(body),
        });
      } else {
        await authedFetch(`/mfg-sales-orders/${encodeURIComponent(docNo)}/payments`, {
          method: "POST", body: JSON.stringify(body),
        });
      }
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't record the payment. Please try again.");
      void notify({ title: isEdit ? "Changes not saved" : "Payment not recorded", body: e instanceof Error ? e.message : String(e), tone: "error" });
      setBusy(false);
    }
  };

  return (
    <div className="hz-m sheet-bd" onClick={() => { if (!busy) onClose(); }}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="grab" />
        <div className="sheet-head">
          <div>
            <div className="card-t" style={{ fontSize: 15 }}>{isEdit ? "Edit payment" : "Add payment"}</div>
            <div style={{ fontSize: 11, color: "var(--mut)", marginTop: 2 }}>{docNo}</div>
          </div>
          <button type="button" className="sheet-x" onClick={() => { if (!busy) onClose(); }} aria-label="Close">{"✕"}</button>
        </div>
        <div className="sheet-scroll">
          <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            <div className="fld">
              <span className="fld-l">Method</span>
              <select className="fld-i" value={method} onChange={(e) => setMethod(e.target.value as PayMethodLabel)}>
                {PAY_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div style={{ display: "flex", gap: 9 }}>
              <label className="fld" style={{ flex: 1.1 }}>
                <span className="fld-l">Date</span>
                <input className="fld-i" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </label>
              <label className="fld" style={{ flex: 1.1 }}>
                <span className="fld-l">Amount</span>
                <input className="fld-i money" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
              </label>
            </div>
            {method === "Merchant" && (
              <div style={{ display: "flex", gap: 9 }}>
                <div className="fld" style={{ flex: 1 }}>
                  <span className="fld-l">Bank</span>
                  <select className="fld-i" value={bank} onChange={(e) => setBank(e.target.value)}>{BANK_OPTS.map((o) => <option key={o} value={o}>{o}</option>)}</select>
                </div>
                <div className="fld" style={{ flex: 1 }}>
                  <span className="fld-l">Plan</span>
                  <select className="fld-i" value={plan} onChange={(e) => setPlan(e.target.value)}>{PLAN_OPTS.map((o) => <option key={o} value={o}>{o}</option>)}</select>
                </div>
              </div>
            )}
            {method === "Installment" && (
              <div className="fld">
                <span className="fld-l">Installment plan</span>
                <select className="fld-i" value={plan} onChange={(e) => setPlan(e.target.value)}>{PLAN_OPTS.map((o) => <option key={o} value={o}>{o}</option>)}</select>
              </div>
            )}
            {method === "Online" && (
              <div className="fld">
                <span className="fld-l">Sub-type</span>
                <select className="fld-i" value={online} onChange={(e) => setOnline(e.target.value)}>{ONLINE_OPTS.map((o) => <option key={o} value={o}>{o}</option>)}</select>
              </div>
            )}
            <div style={{ display: "flex", gap: 9 }}>
              <label className="fld" style={{ flex: 1 }}>
                <span className="fld-l">Account Sheet</span>
                <input className="fld-i" value={account} onChange={(e) => setAccount(e.target.value)} placeholder="Sheet ref" />
              </label>
              <label className="fld" style={{ flex: 1 }}>
                <span className="fld-l">Approval Code</span>
                <input className="fld-i" value={approval} onChange={(e) => setApproval(e.target.value)} placeholder="Terminal no" />
              </label>
            </div>
            <div className="fld">
              <span className="fld-l">Collected By</span>
              <select className="fld-i" value={collectedBy} onChange={(e) => setCollectedBy(e.target.value)}>
                <option value="">—</option>
                {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            {/* Owner 2026-07-13 — slip is OPTIONAL. Uploader stays available for
                when a receipt IS on hand; no "required" gate. Hidden in edit
                mode (the slip isn't changed by an edit). */}
            {!isEdit && (
              <div className="fld">
                <span className="fld-l" style={{ color: "#9aa093" }}>Slip (optional)</span>
                <input ref={fileRef} type="file" accept="image/*,application/pdf" style={{ display: "none" }} onChange={(e) => { void onPickSlip(e.target.files?.[0] ?? null); e.target.value = ""; }} />
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  disabled={slipPhase === "uploading" || busy}
                  title={slipName || "Attach a payment slip"}
                  style={{
                    width: "100%", boxSizing: "border-box", height: 40, borderRadius: 9, cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 700,
                    border: slipPhase === "done" ? "1px solid #bcdcd7" : "1px solid #d6d9d2",
                    background: slipPhase === "done" ? "#e1efed" : "#f4f6f3",
                    color: slipPhase === "done" ? "#16695f" : "#414539",
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 6, overflow: "hidden",
                  }}
                >
                  {slipPhase === "uploading" ? "Uploading…"
                    : slipPhase === "done" ? "Slip attached ✓"
                    : slipPhase === "error" ? "Retry upload"
                    : "Upload slip"}
                </button>
              </div>
            )}
            {error && <div style={{ fontSize: 11.5, color: "var(--red)", textAlign: "center" }}>{error}</div>}
          </div>
        </div>
        <div className="sheet-foot">
          <button type="button" className="btn-ghost" style={{ flex: 1, opacity: busy ? 0.55 : 1 }} disabled={busy} onClick={() => onClose()}>Cancel</button>
          <button type="button" className="btn" style={{ flex: 1.3, opacity: canSave ? 1 : 0.5 }} disabled={!canSave} onClick={() => void save()}>{busy ? (isEdit ? "Saving…" : "Recording…") : (isEdit ? "Save changes" : "Record Payment")}</button>
        </div>
      </div>
    </div>
  );
}

/* ── Scanned photos card (mobile port of desktop's ScannedImageCard pair) ────
   Order slip (slip_image_key, mig 0033) + payment receipt (receipt_image_key,
   mig 0034) as tappable thumbnails; tap opens a full-size overlay (tap again to
   dismiss). The images are served by GET /scan-so/slip-image?key=… which needs
   the bearer, so each thumb authed-fetches the blob (fetchScanSlipImageBlobUrl)
   and renders the object URL — revoked when the thumb unmounts, so the overlay
   (which shows while the thumb stays mounted) always has a live URL. */
function ScannedPhotosCard({ slipKey, receiptKey }: { slipKey: string | null; receiptKey: string | null }) {
  const [viewer, setViewer] = useState<{ src: string; label: string } | null>(null);
  return (
    <>
      {/* Owner 2026-07-04 — "which button shows the customer's photographed order
          slip?": the card is titled "Order slip photo" (the thing he's looking
          for), sits high in the page, and each thumb is tap-to-open-fullscreen.
          A one-line hint spells out the interaction so it's unmistakable. */}
      <div className="card"><div className="card-h"><span className="card-t">Order slip photo</span><span className="card-sub">Tap to enlarge</span></div>
        <div className="card-b" style={{ paddingTop: 4 }}>
          <div style={{ fontSize: 11, color: "var(--mut)", marginBottom: 9, lineHeight: 1.4 }}>
            The customer's photographed slip{receiptKey ? " and payment receipt" : ""} this order was scanned from. Tap a photo to view it full-screen.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: slipKey && receiptKey ? "1fr 1fr" : "1fr", gap: 9 }}>
            {slipKey ? <ScannedThumb imageKey={slipKey} label="Order slip" onView={(src, label) => setViewer({ src, label })} /> : null}
            {receiptKey ? <ScannedThumb imageKey={receiptKey} label="Payment receipt" onView={(src, label) => setViewer({ src, label })} /> : null}
          </div>
        </div>
      </div>
      {viewer && (
        <div
          onClick={() => setViewer(null)}
          role="dialog"
          aria-label={viewer.label}
          style={{ position: "fixed", inset: 0, zIndex: 2600, background: "rgba(0,0,0,0.84)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 16 }}
        >
          <img src={viewer.src} alt={viewer.label} style={{ maxWidth: "100%", maxHeight: "84vh", borderRadius: 10, objectFit: "contain", background: "#fff" }} />
          <div style={{ marginTop: 12, fontSize: 12, fontWeight: 700, color: "#fff", opacity: 0.85 }}>{viewer.label} · tap anywhere to close</div>
        </div>
      )}
    </>
  );
}

/* One authed thumbnail — fetches the scan image as a blob, shows a skeleton
   while loading and a plain-language line when the fetch fails. */
function ScannedThumb({ imageKey, label, onView }: { imageKey: string; label: string; onView: (src: string, label: string) => void }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    setSrc(null);
    setFailed(false);
    fetchScanSlipImageBlobUrl(imageKey)
      .then((u) => {
        if (cancelled) { URL.revokeObjectURL(u); return; }
        url = u;
        setSrc(u);
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [imageKey]);

  return (
    <button
      type="button"
      onClick={() => { if (src) onView(src, label); }}
      aria-label={`View ${label} photo`}
      style={{ border: "1px solid var(--line2, #e3e6e0)", background: "#f4f6f3", borderRadius: 12, padding: 0, overflow: "hidden", cursor: src ? "pointer" : "default", fontFamily: "inherit", textAlign: "center" }}
    >
      {failed ? (
        <div style={{ height: 96, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 8px", fontSize: 10.5, color: "var(--mut2)", lineHeight: 1.4 }}>Couldn't load this photo.</div>
      ) : src ? (
        <img src={src} alt={label} style={{ width: "100%", height: 96, objectFit: "cover", display: "block" }} />
      ) : (
        <div className="ph" style={{ height: 96 }} />
      )}
      <div style={{ padding: "6px 4px", fontSize: 10, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", color: "#9aa093" }}>{label}</div>
    </button>
  );
}

/* ── History timeline (owner requirement — Inistate-style audit trail) ──────
   Reads GET /mfg-sales-orders/:docNo/audit-log (mfg_so_audit_log) via the SAME
   vendored hook desktop's HistoryPanel uses. Lazy: the hook receives null until
   the accordion opens, so `enabled: Boolean(docNo)` keeps the request unfired.
   Entries arrive newest-first from the backend. */

/* Human labels for the audit `field` keys — subset of desktop's FIELD_LABEL
   plus the payment / amendment / automation keys the mobile timeline surfaces. */
const HIST_FIELD_LABEL: Record<string, string> = {
  debtorName: "Customer", debtorCode: "Customer code", agent: "Agent",
  phone: "Phone", email: "Email", soDate: "SO date", status: "Status",
  paymentMethod: "Payment method", depositCenti: "Deposit",
  internalExpectedDd: "Processing date", customerSoNo: "Customer SO ref",
  customerPo: "Customer PO", customerDeliveryDate: "Delivery date",
  amendedDeliveryDate: "Amended delivery date",
  amendDateFromCustomer: "Amend date (customer)", amendReason: "Amend reason",
  deliveryState: "Delivery region", possessionDate: "Possession date",
  houseType: "House type", replacementDisposal: "Replacement / disposal",
  referral: "Referral", city: "City", postcode: "Postcode",
  buildingType: "Building type", address1: "Address 1", address2: "Address 2",
  address3: "Address 3", address4: "Address 4", note: "Note", remark: "Remark",
  itemCode: "Item", itemGroup: "Group", description: "Description",
  description2: "Description 2", uom: "UOM", qty: "Qty",
  unitPriceCenti: "Unit price", discountCenti: "Discount",
  unitCostCenti: "Unit cost", totalCenti: "Line total", lineCount: "Lines",
  localTotalCenti: "Total", amountCenti: "Amount", paidAt: "Paid on",
  method: "Method", merchantProvider: "Bank", installmentMonths: "Installment months",
  onlineType: "Online type", approvalCode: "Approval code",
  stockStatus: "Stock status", salespersonId: "Salesperson",
  customerType: "Customer type", venue: "Venue", venueId: "Venue (master)",
  salesLocation: "Sales location", customerState: "State", cancelled: "Cancelled",
  photoAdded: "Photo added", photoRemoved: "Photo removed",
  tbcVariants: "Variants updated", sofaBuild: "Sofa build",
  pwpCode: "PWP code", pwpRewardsReverted: "PWP rewards reverted",
  pwpCodesDeleted: "PWP codes deleted", photosCleaned: "Photos removed",
};
const HIST_MONEY_FIELDS = new Set([
  "unitPriceCenti", "discountCenti", "totalCenti", "depositCenti",
  "localTotalCenti", "unitCostCenti", "amountCenti",
]);
const histVal = (field: string, v: unknown): string => {
  if (v === null || v === undefined || v === "") return "—";
  if ((HIST_MONEY_FIELDS.has(field) || /Centi$/.test(field)) && typeof v === "number") return `RM ${rm(v)}`;
  if (typeof v === "object") return JSON.stringify(v);
  return String(v).replace(/_/g, " ");
};
/* Timestamp — desktop-standard numeric DD/MM/YYYY + HH:mm. */
const histWhen = (iso: string): string => {
  const d = new Date(iso);
  if (isNaN(+d)) return "—";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const histHue = (s: string): number => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
};
const histInitials = (name: string): string => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0] ?? "";
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  const last = parts[parts.length - 1] ?? "";
  return ((first[0] ?? "") + (last[0] ?? "")).toUpperCase();
};
/* Action → plain sentence ("<actor> <sentence>"), pulling the headline value
   (status pair / amount / item code) out of the entry's field_changes. */
const histSentence = (e: SoAuditEntry): string => {
  const fc: SoAuditFieldChange[] = Array.isArray(e.field_changes) ? e.field_changes : [];
  const find = (f: string) => fc.find((c) => c.field === f);
  switch (e.action) {
    case "CREATE":
      return e.status_snapshot === "DRAFT" ? "created this order (draft)" : "created this order";
    case "UPDATE_DETAILS":
      return "updated details";
    case "UPDATE_STATUS": {
      const s = find("status");
      const to = (s?.to ?? e.status_snapshot ?? "?") as string;
      return s?.from ? `changed status ${String(s.from)} → ${to}` : `changed status to ${to}`;
    }
    case "ADD_PAYMENT": {
      const a = find("amountCenti");
      return typeof a?.to === "number" ? `added payment RM ${rm(a.to)}` : "added a payment";
    }
    case "UPDATE_PAYMENT": {
      const a = find("amountCenti");
      return typeof a?.to === "number" ? `edited payment (RM ${rm(a.to)})` : "edited a payment";
    }
    case "DELETE_PAYMENT": {
      const a = find("amountCenti");
      return typeof a?.from === "number" ? `removed payment RM ${rm(a.from)}` : "removed a payment";
    }
    case "ADD_LINE": {
      const cd = find("itemCode");
      return cd?.to ? `added line ${String(cd.to)}` : "added a line";
    }
    case "UPDATE_LINE": {
      const cd = find("itemCode");
      const code = cd?.to ?? cd?.from;
      return code ? `edited line ${String(code)}` : "edited a line";
    }
    case "DELETE_LINE": {
      const cd = find("itemCode");
      return cd?.from ? `removed line ${String(cd.from)}` : "removed a line";
    }
    default:
      return e.action.replace(/_/g, " ").toLowerCase();
  }
};

function HistoryCard({ docNo }: { docNo: string }) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  /* Lazy load — hook gets null until first open, so nothing is fetched for the
     common "just glancing at the order" visit (mirrors desktop historyOpen). */
  const q = useSalesOrderAuditLog(open ? docNo : null);
  const entries = q.data ?? [];

  return (
    <div className="card">
      <div
        className="card-h"
        role="button"
        tabIndex={0}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen((o) => !o); } }}
        style={{ cursor: "pointer", userSelect: "none" }}
        aria-expanded={open}
      >
        <span className="card-t">History</span>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {open && !q.isLoading && !q.error && <span className="card-sub">{entries.length}</span>}
          <span style={{ fontSize: 12, color: "var(--mut)", transform: open ? "rotate(90deg)" : "none", transition: "transform .15s", display: "inline-block" }}>{"›"}</span>
        </span>
      </div>
      {open && (
        <>
          {q.isLoading && <div style={{ padding: "11px 13px", borderTop: "1px solid var(--line2)", fontSize: 11.5, color: "var(--mut2)" }}>Loading{"…"}</div>}
          {!!q.error && (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "11px 13px", borderTop: "1px solid var(--line2)" }}>
              <span style={{ fontSize: 11.5, color: "var(--red)", fontWeight: 600 }}>Couldn't load the history</span>
              <button onClick={() => q.refetch()} style={{ border: "none", background: "transparent", color: "var(--red)", fontFamily: "inherit", fontSize: 11.5, fontWeight: 700, cursor: "pointer" }}>Retry</button>
            </div>
          )}
          {!q.isLoading && !q.error && (entries.length ? entries.map((e) => {
            const name = e.actor_name_snapshot ?? "(unknown)";
            const fc: SoAuditFieldChange[] = Array.isArray(e.field_changes) ? e.field_changes : [];
            const isX = !!expanded[e.id];
            return (
              <div key={e.id} style={{ display: "flex", gap: 9, padding: "10px 13px", borderTop: "1px solid var(--line2)", alignItems: "flex-start" }}>
                <span aria-hidden style={{ width: 24, height: 24, minWidth: 24, borderRadius: "50%", background: `hsl(${histHue(name)}, 45%, 55%)`, color: "#fff", fontSize: 9.5, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", marginTop: 1 }}>
                  {histInitials(name)}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, color: "var(--ink)", lineHeight: 1.35 }}>
                    <span style={{ fontWeight: 700 }}>{name}</span>{" "}{histSentence(e)}
                  </div>
                  <div className="money" style={{ fontSize: 10.5, color: "var(--mut)", marginTop: 2 }}>
                    {histWhen(e.created_at)}{e.source ? ` · via ${e.source}` : ""}
                  </div>
                  {e.note ? <div style={{ fontSize: 10.5, color: "var(--mut2)", marginTop: 2, fontStyle: "italic" }}>{e.note}</div> : null}
                  {fc.length > 0 && (
                    <>
                      <button
                        type="button"
                        onClick={() => setExpanded((s) => ({ ...s, [e.id]: !s[e.id] }))}
                        style={{ border: "none", background: "transparent", padding: 0, marginTop: 4, fontFamily: "inherit", fontSize: 11, fontWeight: 700, color: "var(--teal)", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4 }}
                      >
                        <span style={{ transform: isX ? "rotate(90deg)" : "none", transition: "transform .15s", display: "inline-block", fontSize: 10 }}>{"›"}</span>
                        Changes ({fc.length})
                      </button>
                      {isX && (
                        <div style={{ marginTop: 5, background: "#f4f6f3", border: "1px solid #e3e6e0", borderRadius: 8, padding: "7px 9px", display: "flex", flexDirection: "column", gap: 4 }}>
                          {fc.map((ch, idx) => (
                            <div key={idx} style={{ fontSize: 11, lineHeight: 1.4, color: "var(--ink)", wordBreak: "break-word" }}>
                              <span style={{ fontWeight: 700, color: "var(--mut)" }}>{HIST_FIELD_LABEL[ch.field] ?? ch.field}:</span>{" "}
                              {ch.from !== undefined && ch.from !== null && ch.from !== "" ? (
                                <>
                                  <span style={{ color: "#b23a3a", textDecoration: "line-through" }}>{histVal(ch.field, ch.from)}</span>
                                  <span style={{ color: "var(--mut2)" }}>{" → "}</span>
                                </>
                              ) : null}
                              <span style={{ color: "#0c3f39", fontWeight: 600 }}>{histVal(ch.field, ch.to)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          }) : <div style={{ padding: "11px 13px", borderTop: "1px solid var(--line2)", fontSize: 11.5, color: "var(--mut2)" }}>No history yet.</div>)}
        </>
      )}
    </div>
  );
}

/* soPill — from the design's status→color map (Submitted [#e1efed,#0c3f39] ·
   Cancelled [#f8eaea,#b23a3a]), EXCEPT Draft: owner 2026-07-04 couldn't tell
   Draft from Confirmed, so Draft upgraded from the design's grey to the shared
   amber "pending" badge (+ border) so it reads unmistakably as unconfirmed. */
function StatusPill({ status }: { status: string | null }) {
  const p = phase(status);
  const cls = p === "draft" ? "b-amber" : p === "cancelled" ? "b-red" : "b-brand";
  const label = p === "draft" ? "Draft" : p === "cancelled" ? "Cancelled" : "Submitted";
  return <span className={`badge ${cls}`} style={p === "draft" ? { border: "1px solid #e0cf9e" } : undefined}>{label}</span>;
}

