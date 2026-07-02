import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { authedFetch } from "../vendor/scm/lib/authed-fetch";
import "./mobile.css";

type SoRow = {
  doc_no: string; debtor_name: string | null; status: string | null;
  phone: string | null;
  sales_location: string | null; customer_state: string | null; ref: string | null; po_doc_no: string | null;
  processing_date: string | null; customer_delivery_date: string | null; internal_expected_dd: string | null;
  so_date: string | null; created_at: string | null;
  local_total_centi: number | null; total_revenue_centi: number | null; paid_total_centi: number | null;
  balance_centi: number | null; balance_centi_live: number | null;
  /* Stock/ready status — DERIVED per SO by the /mfg-sales-orders list handler
     (aggregated from mfg_sales_order_items.stock_status). Present today. */
  is_fully_ready?: boolean | null;
  is_main_ready?: boolean | null;
  stock_remark?: string | null;
  /* Warehouse name + the delivery-planning 4-state are NOT returned by
     /mfg-sales-orders (they're derived only in /delivery-planning). Typed
     optional + dual-read so the card lights up automatically once the list
     endpoint is extended to carry them; until then they render as "—". */
  warehouse_name?: string | null;
  warehouseName?: string | null;
  planning_state?: string | null;
  planningState?: string | null;
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

  const { data, isLoading, error, refetch } = useQuery({
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
        <div className="hdr-row">
          <div>
            <div className="eyebrow">Supply chain</div>
            <div className="scr-title">Sales Orders</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button onClick={onScan} aria-label="Scan slip" className="iconbtn">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#16695f" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z" /><circle cx="12" cy="13" r="3" /></svg>
            </button>
            <button onClick={onNew} aria-label="New sales order" className="iconbtn">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#16695f" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
            </button>
          </div>
        </div>
        <div className="hdr-row" style={{ marginTop: 11 }}>
          <div className="searchbar">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#9aa093" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></svg>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search customer · SO · reference" />
          </div>
          <button onClick={() => setStatus((s) => (s === "all" ? "Submitted" : s === "Submitted" ? "Draft" : s === "Draft" ? "Cancelled" : "all"))} className="iconbtn" style={{ position: "relative" }} aria-label="Filter by status">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#414539" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 5h18M6 12h12M10 19h4" /></svg>
            {filterActive && <span style={{ position: "absolute", top: -3, right: -3, width: 9, height: 9, borderRadius: "50%", background: "var(--red)", border: "1.5px solid #fff" }} />}
          </button>
        </div>
        <div className="chips" style={{ marginTop: 11 }}>
          {RANGES.map(([k, label]) => (
            <button key={k} onClick={() => setRange(k)} className={range === k ? "chip on" : "chip"}>{label}</button>
          ))}
        </div>
      </header>

      <div className="scroll hz-scroll" style={{ padding: 14, paddingBottom: 120 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap", fontSize: 11.5, color: "var(--mut)", margin: "0 2px 11px" }}>
          <span><b style={{ color: "var(--ink)" }}>{summary.count}</b> orders</span>
          <span style={{ opacity: .4 }}>·</span><span className="money">RM {rm(summary.rev)} rev</span>
          {summary.out > 0 && (<><span style={{ opacity: .4 }}>·</span><span className="money" style={{ color: "var(--red)" }}>RM {rm(summary.out)} outstanding</span></>)}
        </div>

        {isLoading && (
          <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
            {[0, 1, 2].map((i) => (
              <div key={i} className="card"><div className="card-b ph" style={{ height: 92, borderRadius: 14 }} /></div>
            ))}
          </div>
        )}
        {error && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, background: "var(--red-bg)", border: "1px solid #e6cccc", borderRadius: 12, padding: "11px 13px" }}>
            <span style={{ fontSize: 12, color: "var(--red)", fontWeight: 600 }}>Couldn't load orders</span>
            <button onClick={() => refetch()} style={{ border: "none", background: "transparent", color: "var(--red)", fontFamily: "inherit", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Retry</button>
          </div>
        )}
        {!isLoading && !error && (
          <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
            {rows.map((r) => {
              const cancelled = (r.status ?? "").toLowerCase() === "cancelled";
              const ref = r.ref ?? r.po_doc_no ?? "";
              const balance = total(r) - (r.paid_total_centi ?? 0);
              const warehouse = (r.warehouse_name ?? r.warehouseName ?? "").trim() || "—";
              return (
                /* Owner-locked 4-line SO card:
                   L1  {debtor name} + {phone}          ·  {status badge}
                   L2  {SO-no} · {ref}                  ·  {warehouse name}
                   L3  Processing {date} -> Delivery {date}  ·  [Stock][Planning]
                   L4  Balance {balance}                ·  {total}
                   Chips reuse MobileDeliveryPlanning's badge tones. Warehouse +
                   the delivery-planning state are not in the /mfg-sales-orders
                   payload yet → graceful "—" (see report). */
                <div key={r.doc_no} onClick={() => onOpen(r.doc_no)} className={cancelled ? "card cancelled" : "card"} style={{ cursor: "pointer", padding: "12px 13px", ...(cancelled ? { opacity: .55, filter: "grayscale(.5)" } : null) }}>
                  {/* Line 1 — name + phone / status */}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                    <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      <span style={{ fontSize: 15, fontWeight: 800, color: "var(--ink)" }}>{r.debtor_name || "—"}</span>
                      {r.phone ? <span style={{ fontSize: 12, fontWeight: 600, color: "var(--brand)", marginLeft: 7 }}>{r.phone}</span> : null}
                    </span>
                    <StatusPill status={r.status} />
                  </div>
                  {/* Line 2 — SO-no · ref / warehouse (values only) */}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, marginTop: 5 }}>
                    <span className="money" style={{ fontSize: 11.5, color: "var(--mut)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.doc_no}{ref ? ` · ${ref}` : ""}</span>
                    <span style={{ fontSize: 11.5, color: "var(--mut2)", fontWeight: 600, whiteSpace: "nowrap", flex: "none" }}>{warehouse}</span>
                  </div>
                  {/* Line 3 — Processing -> Delivery / stock + planning chips */}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginTop: 8 }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0, fontSize: 11, color: "var(--ink2)", overflow: "hidden", whiteSpace: "nowrap" }}>
                      <span style={{ color: "var(--mut2)", fontWeight: 600 }}>Processing</span>
                      <span className="money" style={{ fontWeight: 600 }}>{dm(r.processing_date)}</span>
                      <span style={{ color: "#c2c6bd" }}>&rarr;</span>
                      <span style={{ color: "var(--mut2)", fontWeight: 600 }}>Delivery</span>
                      <span className="money" style={{ fontWeight: 600 }}>{dm(r.customer_delivery_date || r.internal_expected_dd)}</span>
                    </span>
                    <span style={{ display: "flex", alignItems: "center", gap: 5, flex: "none" }}>
                      <StockChip r={r} />
                      <PlanningChip r={r} />
                    </span>
                  </div>
                  {/* Line 4 — Balance / total */}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 9, paddingTop: 9, borderTop: "1px solid var(--line2)" }}>
                    <span style={{ fontSize: 10.5, color: "var(--mut2)" }}>Balance <span className="money" style={{ color: balance > 0 ? "var(--ink2)" : "var(--mut2)", fontWeight: 700 }}>RM {rm(balance)}</span></span>
                    <span className="money" style={{ fontSize: 17, fontWeight: 800, color: "var(--brand-d)" }}>RM {rm(total(r))}</span>
                  </div>
                </div>
              );
            })}
            {!rows.length && (
              <div className="empty">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#c2c6bd" strokeWidth="1.6"><path d="M4 4h16v4H4zM4 10h16v10H4z" /></svg>
                <div className="empty-t">No sales orders</div>
                <div className="empty-s">No orders in this range. Tap + to create one.</div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* status → spec badge tone: DRAFT=b-grey · SUBMITTED=b-brand ·
   CONFIRMED=b-green · CANCELLED=b-red. Any other live status reads as b-brand. */
function StatusPill({ status }: { status: string | null }) {
  const s = (status ?? "").toUpperCase();
  const cls =
    s === "DRAFT" ? "b-grey" :
    s === "CANCELLED" ? "b-red" :
    s === "CONFIRMED" ? "b-green" :
    "b-brand";
  const label = status ? status.charAt(0).toUpperCase() + status.slice(1).toLowerCase() : "—";
  return <span className={`badge ${cls}`} style={{ flex: "none" }}>{label}</span>;
}

/* Chip vocabulary reused from MobileDeliveryPlanning: canonical .badge tinted by
   the same b-green/b-amber/b-red/b-grey tones. Each chip carries a tiny
   uppercase label prefix (Stock / Delivery) so the two read distinctly. */
function MiniChip({ tone, label }: { tone: "green" | "amber" | "red" | "grey"; label: string }) {
  const cls = tone === "green" ? "b-green" : tone === "amber" ? "b-amber" : tone === "red" ? "b-red" : "b-grey";
  return <span className={`badge ${cls}`}>{label}</span>;
}

/* Stock chip — READY (green) once every non-cancelled line is stocked, else
   Pending (grey). Reads the list handler's is_fully_ready aggregate. */
function StockChip({ r }: { r: SoRow }) {
  const ready = r.is_fully_ready === true;
  return <MiniChip tone={ready ? "green" : "grey"} label={ready ? "Ready" : "Pending"} />;
}

/* Delivery-planning chip — maps the 4 planning states to the DeliveryPlanning
   colour scheme: Pending schedule = amber, Pending delivery = grey,
   Overdue = red, Delivered = green. The state itself is NOT in the
   /mfg-sales-orders payload yet (only /delivery-planning derives it), so this
   renders a neutral "—" placeholder until the list endpoint carries it. */
function PlanningChip({ r }: { r: SoRow }) {
  const raw = (r.planning_state ?? r.planningState ?? "").toUpperCase();
  if (!raw) return <MiniChip tone="grey" label="—" />;
  if (raw === "DELIVERED") return <MiniChip tone="green" label="Delivered" />;
  if (raw === "OVERDUE") return <MiniChip tone="red" label="Overdue" />;
  if (raw === "PENDING_SCHEDULE") return <MiniChip tone="amber" label="Pending schedule" />;
  if (raw === "PENDING_DELIVERY") return <MiniChip tone="grey" label="Pending delivery" />;
  return <MiniChip tone="grey" label={raw.charAt(0) + raw.slice(1).toLowerCase().replace(/_/g, " ")} />;
}
