import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { authedFetch } from "../vendor/scm/lib/authed-fetch";
import { useConfirm } from "../vendor/scm/components/ConfirmDialog";
import { useNotify } from "../vendor/scm/components/NotifyDialog";
import { uploadSlipFull, fetchPaymentSlipUrl } from "../vendor/scm/lib/slip";
import { useStaff } from "../vendor/scm/lib/admin-queries";
import "./mobile.css";

/* Shapes are the subset of the /mfg-sales-orders/:docNo + /:docNo/payments
   responses the mobile detail screen reads. The backend camelCases nothing —
   these are the raw snake_case columns. */
type SoHeader = {
  doc_no: string;
  debtor_name: string | null;
  status: string | null;
  phone: string | null;
  sales_location: string | null;
  customer_state: string | null;
  ref: string | null;
  customer_so_no: string | null;
  po_doc_no: string | null;
  processing_date: string | null;
  customer_delivery_date: string | null;
  internal_expected_dd: string | null;
  so_date: string | null;
  created_at: string | null;
  local_total_centi: number | null;
  total_revenue_centi: number | null;
  paid_centi_total: number | null;
  balance_centi: number | null;
};
type SoItem = {
  id: string;
  description: string | null;
  item_code: string | null;
  qty: number | null;
  line_delivery_date: string | null;
};
type SoPayment = {
  id: string;
  paid_at: string | null;
  method: string | null;
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
export function MobileSODetail({ docNo, onBack, onEdit }: { docNo: string; onBack: () => void; onEdit?: (docNo: string) => void }) {
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

  const h = detail.data?.salesOrder;
  const items = detail.data?.items ?? [];
  const payments = paymentsQ.data?.payments ?? [];

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

  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <header className="hdr">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span onClick={onBack} style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 12.5, fontWeight: 600, color: "#16695f", cursor: "pointer" }}>
            <span style={{ fontSize: 17, lineHeight: 1 }}>{"‹"}</span> Sales Orders
          </span>
          {h && <StatusPill status={h.status} />}
        </div>
        <div className="money" style={{ fontSize: 11.5, fontWeight: 700, color: "#a16a2e", marginTop: 7 }}>{h?.doc_no ?? docNo}</div>
        <div style={{ fontSize: 19, fontWeight: 800, color: "#11140f", marginTop: 2 }}>{h?.debtor_name || "—"}</div>
      </header>

      <div className="scroll hz-scroll" style={{ padding: 14 }}>
        {detail.isLoading && <div style={{ textAlign: "center", color: "#9aa093", fontSize: 12, padding: "26px 0" }}>Loading{"…"}</div>}
        {detail.error && <div style={{ textAlign: "center", color: "#b23a3a", fontSize: 12, padding: "26px 0" }}>Couldn't load this order. Please try again.</div>}

        {!detail.isLoading && !detail.error && h && (
          <div>
            <div className="pgrid2" style={{ marginBottom: 11 }}>
              <div><div className="pkv-l">Processing</div><div className="pkv-v">{dm(h.processing_date)}</div></div>
              <div><div className="pkv-l">Delivery</div><div className="pkv-v">{dm(h.customer_delivery_date || h.internal_expected_dd)}</div></div>
              <div><div className="pkv-l">Phone</div><div className="pkv-v money">{h.phone || "—"}</div></div>
              <div><div className="pkv-l">Location</div><div className="pkv-v">{h.sales_location || h.customer_state || "—"}</div></div>
              <div><div className="pkv-l">Reference</div><div className="pkv-v money">{h.customer_so_no || h.ref || h.po_doc_no || "—"}</div></div>
              <div><div className="pkv-l">Created</div><div className="pkv-v">{dm(h.so_date || h.created_at)}</div></div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 11 }}>
              <div style={{ background: "#fff", border: "1px solid #e3e6e0", borderRadius: 11, padding: 10, textAlign: "center" }}>
                <div className="money" style={{ fontSize: 13, fontWeight: 800, color: "#11140f" }}>{rm(total(h))}</div>
                <div className="ey" style={{ color: "#9aa093", marginTop: 3 }}>Total</div>
              </div>
              <div style={{ background: "#fff", border: "1px solid #e3e6e0", borderRadius: 11, padding: 10, textAlign: "center" }}>
                <div className="money" style={{ fontSize: 13, fontWeight: 800, color: "#2f8a5b" }}>{rm(h.paid_centi_total)}</div>
                <div className="ey" style={{ color: "#9aa093", marginTop: 3 }}>Paid</div>
              </div>
              <div style={{ background: "#fff", border: "1px solid #e3e6e0", borderRadius: 11, padding: 10, textAlign: "center" }}>
                <div className="money" style={{ fontSize: 13, fontWeight: 800, color: bal > 0 ? "#a16a2e" : "#11140f" }}>{rm(bal)}</div>
                <div className="ey" style={{ color: "#9aa093", marginTop: 3 }}>Balance</div>
              </div>
            </div>

            <div className="ey" style={{ color: "#767b6e", margin: "4px 2px 6px" }}>Line items</div>
            <div style={{ background: "#fff", border: "1px solid #e3e6e0", borderRadius: 12, padding: "2px 12px", marginBottom: 11 }}>
              {items.length ? items.map((it) => (
                <div className="docrow" key={it.id}>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600, color: "#11140f" }}>
                    {it.description || it.item_code || "—"} <span style={{ color: "#9aa093", fontWeight: 600 }}>{"×"}{it.qty ?? 0}</span>
                  </span>
                  <span className="ey" style={{ color: "#9aa093" }}>Deliv</span>
                  <span style={{ fontSize: 11.5, fontWeight: 600, color: "#414539" }}>{dm(it.line_delivery_date)}</span>
                </div>
              )) : <div style={{ fontSize: 11.5, color: "#9aa093", padding: "9px 0" }}>No items.</div>}
            </div>

            <div className="ey" style={{ color: "#767b6e", margin: "4px 2px 6px" }}>Payments</div>
            <div style={{ background: "#fff", border: "1px solid #e3e6e0", borderRadius: 12, padding: "2px 12px" }}>
              {paymentsQ.isLoading && <div style={{ fontSize: 11.5, color: "#9aa093", padding: "9px 0" }}>Loading{"…"}</div>}
              {!paymentsQ.isLoading && (payments.length ? payments.map((p) => (
                <div className="docrow" key={p.id}>
                  <span style={{ flex: 1, fontSize: 12, color: "#414539" }}>{dm(p.paid_at)} {"·"} {methodLabel(p.method)}</span>
                  {p.slip_key ? <SlipLink docNo={docNo} paymentId={p.id} /> : null}
                  <span className="money" style={{ fontSize: 12.5, fontWeight: 700, color: "#0c3f39" }}>RM {rm(p.amount_centi)}</span>
                </div>
              )) : <div style={{ fontSize: 11.5, color: "#9aa093", padding: "9px 0" }}>No payments recorded.</div>)}
            </div>

            {actionError && <div style={{ marginTop: 13, fontSize: 11.5, color: "#b23a3a", textAlign: "center" }}>{actionError}</div>}
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
              <button className="btn" style={{ flex: 1, background: "#fff", color: "#16695f", border: "1.5px solid #16695f", opacity: busy ? 0.55 : 1 }} disabled={busy} onClick={() => onEdit?.(docNo)}>Edit Draft</button>
              <button className="btn" style={{ flex: 1.3, opacity: busy ? 0.55 : 1 }} disabled={busy} onClick={() => setStatus("CONFIRMED")}>{busy ? "Working…" : "Create Sales Order"}</button>
            </div>
          )}
          {ph === "submitted" && (
            <div style={{ display: "flex", gap: 9 }}>
              <button className="btn" style={{ flex: 1, background: "#fff", color: "#16695f", border: "1.5px solid #16695f", opacity: busy ? 0.55 : 1 }} disabled={busy} onClick={() => onEdit?.(docNo)}>Edit</button>
              <button className="btn" style={{ flex: 1, background: "#fff", color: "#b23a3a", border: "1.5px solid #f0d4d4", opacity: busy ? 0.55 : 1 }} disabled={busy} onClick={() => setStatus("CANCELLED", `Cancel ${docNo}? This voids the order.`)}>{busy ? "Working…" : "Cancel Order"}</button>
            </div>
          )}
          {ph === "cancelled" && (
            <div style={{ textAlign: "center", fontSize: 11.5, color: "#9aa093", padding: 4 }}>This order was cancelled.</div>
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
  const map: Record<string, [string, string, string]> = {
    submitted: ["#e1efed", "#0c3f39", "none"],
    draft: ["#f4f6f3", "#767b6e", "1px solid #e3e6e0"],
    cancelled: ["#f8eaea", "#b23a3a", "none"],
  };
  const [bg, fg, border] = map[p];
  const label = p === "draft" ? "Draft" : p === "cancelled" ? "Cancelled" : "Submitted";
  return <span className="spill" style={{ background: bg, color: fg, border }}>{label}</span>;
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
