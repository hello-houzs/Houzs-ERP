import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { authedFetch } from "../vendor/scm/lib/authed-fetch";
import "./mobile.css";

type SoRow = {
  doc_no: string; debtor_name: string | null; status: string | null;
  sales_location: string | null; customer_state: string | null; ref: string | null; po_doc_no: string | null;
  processing_date: string | null; customer_delivery_date: string | null; internal_expected_dd: string | null;
  so_date: string | null; created_at: string | null;
  local_total_centi: number | null; total_revenue_centi: number | null; paid_total_centi: number | null;
};

const RANGES: [string, string][] = [
  ["all", "All"], ["this", "This month"], ["last", "Last month"], ["next", "Next month"], ["year", "This year"],
];

const rm = (centi: number | null | undefined) =>
  ((centi ?? 0) / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dm = (d: string | null | undefined) => {
  if (!d) return "—";
  const dt = new Date(d); if (isNaN(+dt)) return "—";
  return dt.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
};
const total = (r: SoRow) => r.local_total_centi ?? r.total_revenue_centi ?? 0;
const inRange = (r: SoRow, range: string) => {
  if (range === "all") return true;
  const d = r.so_date ? new Date(r.so_date) : null; if (!d || isNaN(+d)) return true;
  const now = new Date(); const y = now.getFullYear(), m = now.getMonth();
  if (range === "year") return d.getFullYear() === y;
  const key = d.getFullYear() * 12 + d.getMonth();
  const cur = y * 12 + m;
  if (range === "this") return key === cur;
  if (range === "last") return key === cur - 1;
  if (range === "next") return key === cur + 1;
  return true;
};

/** Sales Orders list — 1:1 with the mobile design, wired to the same
 *  /api/scm/mfg-sales-orders the desktop uses (row-scoped + permission-gated by
 *  the backend). */
export function MobileSalesOrders({ onScan, onOpen, onNew }: { onScan: () => void; onOpen: (docNo: string) => void; onNew: () => void }) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [range, setRange] = useState("all");

  const { data, isLoading, error } = useQuery({
    queryKey: ["mobile-so-list"],
    queryFn: () => authedFetch<{ salesOrders?: SoRow[]; orders?: SoRow[]; rows?: SoRow[] }>("/mfg-sales-orders?limit=500&fields=minimal"),
    staleTime: 30_000,
  });
  const all = data?.salesOrders ?? data?.orders ?? data?.rows ?? [];

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return all.filter((r) => {
      if (status !== "all" && (r.status ?? "").toLowerCase() !== status.toLowerCase()) return false;
      if (!inRange(r, range)) return false;
      if (needle && !`${r.debtor_name ?? ""} ${r.doc_no} ${r.ref ?? ""} ${r.po_doc_no ?? ""}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [all, q, status, range]);

  const summary = useMemo(() => {
    let rev = 0, out = 0;
    for (const r of rows) {
      if ((r.status ?? "").toLowerCase() === "cancelled") continue;
      rev += total(r); const bal = total(r) - (r.paid_total_centi ?? 0); if (bal > 0) out += bal;
    }
    return { count: rows.length, rev, out };
  }, [rows]);

  const filterActive = status !== "all" || range !== "all";

  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <header className="hdr">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 11 }}>
          <div>
            <div className="ey" style={{ color: "#a16a2e" }}>Supply chain</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: "#11140f", marginTop: 2 }}>Sales Orders</div>
          </div>
          <button onClick={onScan} style={{ display: "flex", alignItems: "center", gap: 5, height: 34, padding: "0 12px", border: "1px solid #16695f", borderRadius: 9, background: "#fff", color: "#16695f", fontFamily: "inherit", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#16695f" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z" /><circle cx="12" cy="13" r="3" /></svg>Scan
          </button>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, background: "#f4f6f3", border: "1px solid #d6d9d2", borderRadius: 10, padding: "8px 11px" }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#9aa093" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search customer · SO · reference" style={{ flex: 1, minWidth: 0, border: "none", background: "transparent", outline: "none", fontFamily: "inherit", fontSize: 13, color: "#11140f" }} />
          </div>
          <button onClick={() => setStatus((s) => (s === "all" ? "Submitted" : s === "Submitted" ? "Draft" : s === "Draft" ? "Cancelled" : "all"))} className="iconbtn" style={{ position: "relative", width: 38, height: 38, flex: "none", borderRadius: 10 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#414539" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 5h18M6 12h12M10 19h4" /></svg>
            {filterActive && <span style={{ position: "absolute", top: -3, right: -3, width: 9, height: 9, borderRadius: "50%", background: "#a16a2e", border: "1.5px solid #fff" }} />}
          </button>
        </div>
      </header>

      <div className="hz-scroll" style={{ flex: 1, overflowY: "auto", padding: 14, paddingBottom: 120 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap", fontSize: 11.5, color: "#767b6e", margin: "0 2px 11px" }}>
          <span><b style={{ color: "#11140f" }}>{summary.count}</b> orders</span>
          <span style={{ opacity: .4 }}>·</span><span className="money">RM {rm(summary.rev)} rev</span>
          {summary.out > 0 && (<><span style={{ opacity: .4 }}>·</span><span className="money" style={{ color: "#b23a3a" }}>RM {rm(summary.out)} outstanding</span></>)}
        </div>
        <div style={{ display: "flex", gap: 7, overflowX: "auto", marginBottom: 11, paddingBottom: 2 }}>
          {RANGES.map(([k, label]) => (
            <button key={k} onClick={() => setRange(k)} className={range === k ? "sochip on" : "sochip"}>{label}</button>
          ))}
        </div>

        {isLoading && <div style={{ textAlign: "center", color: "#9aa093", fontSize: 12, padding: "26px 0" }}>Loading…</div>}
        {error && <div style={{ textAlign: "center", color: "#b23a3a", fontSize: 12, padding: "26px 0" }}>Couldn't load orders. Pull to retry.</div>}
        {!isLoading && !error && (
          <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            {rows.map((r) => {
              const cancelled = (r.status ?? "").toLowerCase() === "cancelled";
              const loc = r.sales_location || r.customer_state || "—";
              const ref = r.ref || r.po_doc_no || "";
              return (
                <div key={r.doc_no} onClick={() => onOpen(r.doc_no)} className={cancelled ? "so-row cancelled" : "so-row"}>
                  <div className="so-row-head">
                    <span className="so-row-name" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.debtor_name || "—"}</span>
                    <StatusPill status={r.status} />
                  </div>
                  <div className="so-grid">
                    <span className="so-k">Order</span>
                    <span className="so-v money" style={{ fontWeight: 700, color: "#0c3f39" }}>{r.doc_no}</span>
                    <span className="so-k">Location</span>
                    <span className="so-v">{loc}</span>
                    {ref && (<><span className="so-k">Reference</span><span className="so-v money">{ref}</span></>)}
                    <span className="so-k">Processing</span>
                    <span className="so-v">{dm(r.processing_date)}</span>
                    <span className="so-k">Delivery</span>
                    <span className="so-v">{dm(r.customer_delivery_date || r.internal_expected_dd)}</span>
                    <span className="so-k">Created</span>
                    <span className="so-v">{dm(r.so_date)}</span>
                    <span className="so-k">Total</span>
                    <span className="so-v money" style={{ fontSize: 14, fontWeight: 800, color: "#11140f" }}>RM {rm(total(r))}</span>
                  </div>
                </div>
              );
            })}
            {!rows.length && <div style={{ textAlign: "center", color: "#9aa093", fontSize: 12, padding: "26px 0" }}>No sales orders match.</div>}
          </div>
        )}
      </div>

      <button onClick={onNew} aria-label="New sales order" className="fab" style={{ right: 18, bottom: 92, width: 52, height: 52, zIndex: 5 }}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
      </button>
    </div>
  );
}

function StatusPill({ status }: { status: string | null }) {
  const s = (status ?? "").toLowerCase();
  const map: Record<string, [string, string, string]> = {
    submitted: ["#e1efed", "#0c3f39", "none"], draft: ["#f4f6f3", "#767b6e", "1px solid #e3e6e0"], cancelled: ["#f8eaea", "#b23a3a", "none"],
  };
  const [bg, fg, border] = map[s] ?? map.draft;
  const label = status ? status.charAt(0).toUpperCase() + status.slice(1).toLowerCase() : "—";
  return <span className="spill" style={{ background: bg, color: fg, border, flex: "none" }}>{label}</span>;
}
