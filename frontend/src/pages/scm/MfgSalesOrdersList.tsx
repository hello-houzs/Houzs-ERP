// ----------------------------------------------------------------------------
// MfgSalesOrdersList — Sales Order (SO) list.
//
// Faithful Houzs-style port of 2990s apps/backend/src/pages/MfgSalesOrdersList.tsx.
// Same status chips + per-row Doc No (bold burnt) · Date · Debtor · Agent ·
// Location · Branding · Local Total · Mattress/Sofa subtotal · Bedframe subtotal
// · Stock Remark · Status pill, row-click -> detail, and a Cancel action gated
// by status. The wire shape (SoRow) matches the cloned /api/mfg-sales-orders.
//
// SEAM changes (the established slice playbook — same as PurchaseInvoicesList):
//   - Data layer: 2990s lib/flow-queries (authedFetch) -> the SO hooks in
//     ./sales-orders-queries (Houzs api client + @tanstack/react-query).
//   - Components: @2990s/design-system Button -> Houzs components/Button; 2990s
//     DataGrid (incl. the column-reorder + group banner + expandable per-line
//     drill-down) -> a plain <table> with the verbatim Suppliers.module.css
//     classes (rule #9). The per-line breakdown lives on the detail page.
//   - Routing: react-router -> react-router-dom (same hooks).
//
// Strategy-2 notes: the KPI tiles + delivery-state / lifecycle badges that 2990s
// derives from DO/SI aren't surfaced here (those slices not cloned). The Stock
// Remark column reads the server-computed readiness (so-readiness). buildVariant
// Summary (furniture) is not used.
// ----------------------------------------------------------------------------

import { useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Plus } from "lucide-react";
import { Button } from "../../components/Button";
import { useSalesOrders, useUpdateSalesOrderStatus, type SoRow, type SoStatus } from "./sales-orders-queries";
import { useDialog } from "../../hooks/useDialog";
import { useToast } from "../../hooks/useToast";
import styles from "../Suppliers.module.css";

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const STATUS_LABEL: Record<string, string> = {
  CONFIRMED: "Confirmed",
  IN_PRODUCTION: "In Production",
  READY_TO_SHIP: "Ready to Ship",
  SHIPPED: "Shipped",
  DELIVERED: "Delivered",
  INVOICED: "Invoiced",
  CLOSED: "Closed",
  ON_HOLD: "On Hold",
  CANCELLED: "Cancelled",
};
const STATUS_CHIPS: Array<"all" | SoStatus> = ["all", "CONFIRMED", "IN_PRODUCTION", "READY_TO_SHIP", "SHIPPED", "DELIVERED", "INVOICED", "CLOSED", "ON_HOLD", "CANCELLED"];

const statusClass = (s: SoStatus): string => (s === "CANCELLED" ? styles.statusBlocked ?? "" : styles.statusActive ?? "");

const fmtMoney = (centi: number, currency = "MYR"): string =>
  `${currency} ${(centi / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const fmtDateOrDash = (iso: string | null): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
};

export const MfgSalesOrders = () => {
  const navigate = useNavigate();
  const dialog = useDialog();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const statusChip = (searchParams.get("status") ?? "all") as "all" | SoStatus;
  const search = searchParams.get("q") ?? "";

  const setStatusChip = (s: "all" | SoStatus) => {
    const next = new URLSearchParams(searchParams);
    if (s === "all") next.delete("status");
    else next.set("status", s);
    setSearchParams(next, { replace: true });
  };
  const setSearch = (v: string) => {
    const next = new URLSearchParams(searchParams);
    if (v) next.set("q", v);
    else next.delete("q");
    setSearchParams(next, { replace: true });
  };

  const { data, isLoading, error } = useSalesOrders();
  const updateStatus = useUpdateSalesOrderStatus();

  const rows = useMemo<SoRow[]>(() => {
    let all = data ?? [];
    if (statusChip !== "all") all = all.filter((s) => s.status === statusChip);
    const q = search.trim().toLowerCase();
    if (q) {
      all = all.filter(
        (s) =>
          s.doc_no.toLowerCase().includes(q) ||
          (s.debtor_name ?? "").toLowerCase().includes(q) ||
          (s.debtor_code ?? "").toLowerCase().includes(q) ||
          (s.phone ?? "").toLowerCase().includes(q),
      );
    }
    return all;
  }, [data, statusChip, search]);

  const doCancel = async (s: SoRow) => {
    if (s.status === "CANCELLED") return;
    if (!(await dialog.confirm(`Cancel Sales Order ${s.doc_no}? This sets status to CANCELLED — a cancelled SO is final (re-order via a new SO).`))) return;
    updateStatus.mutate(
      { docNo: s.doc_no, status: "CANCELLED" },
      { onError: (e) => toast.error(`Cancel failed: ${e instanceof Error ? e.message : String(e)}`) },
    );
  };

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div>
          <h1 className={styles.title}>Sales Orders</h1>
        </div>
        <div style={{ display: "flex", gap: "var(--space-2)" }}>
          <Button variant="primary" onClick={() => navigate("/sales-orders/new")}>
            <Plus {...ICON} />
            <span>New Sales Order</span>
          </Button>
        </div>
      </div>

      <div className={styles.statusChips}>
        {STATUS_CHIPS.map((s) => (
          <StatusChip key={s} active={statusChip === s} onClick={() => setStatusChip(s)}>
            {s === "all" ? "All" : STATUS_LABEL[s] ?? s}
          </StatusChip>
        ))}
      </div>

      <div style={{ margin: "var(--space-3) 0" }}>
        <input
          className={styles.fieldInput}
          style={{ maxWidth: 320 }}
          placeholder="Search doc no / customer / phone…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <p className={styles.eyebrow}>{isLoading ? "Loading sales orders…" : `${rows.length} sales orders`}</p>

      {error && !isLoading && (
        <div className={styles.bannerWarn}>
          <strong>Failed to load sales orders.</strong> {error instanceof Error ? error.message : String(error)}
        </div>
      )}

      <div className={styles.tableCard}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Doc No.</th>
              <th>Date</th>
              <th>Customer</th>
              <th>Location</th>
              <th>Branding</th>
              <th style={{ textAlign: "right" }}>Local Total</th>
              <th>Stock</th>
              <th>Status</th>
              <th style={{ textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !isLoading ? (
              <tr>
                <td colSpan={9}>
                  <p className={styles.emptyRow}>No sales orders yet — create one with "New Sales Order".</p>
                </td>
              </tr>
            ) : (
              rows.map((s) => (
                <tr key={s.doc_no} onClick={() => navigate(`/sales-orders/${s.doc_no}`)} style={s.status === "CANCELLED" ? { opacity: 0.55 } : undefined}>
                  <td>
                    <span className={styles.codeChip}>{s.doc_no}</span>
                  </td>
                  <td>{fmtDateOrDash(s.so_date)}</td>
                  <td>
                    <div style={{ fontWeight: 600 }}>{s.debtor_name || "—"}</div>
                    {s.phone && <div style={{ fontSize: "var(--fs-12)", color: "var(--c-muted, #888)" }}>{s.phone}</div>}
                  </td>
                  <td>{s.sales_location ?? s.customer_state ?? "—"}</td>
                  <td>{s.first_item_branding ?? s.branding ?? "—"}</td>
                  <td style={{ textAlign: "right" }}>
                    <span style={{ fontWeight: 700, color: "var(--c-burnt)" }}>{fmtMoney(Number(s.local_total_centi ?? 0), s.currency)}</span>
                  </td>
                  <td>
                    {s.stock_remark ? <span className={styles.statusPill}>{s.stock_remark}</span> : "—"}
                  </td>
                  <td>
                    <span className={`${styles.statusPill} ${statusClass(s.status)}`}>{STATUS_LABEL[s.status] ?? s.status}</span>
                  </td>
                  <td style={{ textAlign: "right" }} onClick={(e) => e.stopPropagation()}>
                    {s.status !== "CANCELLED" && s.status !== "INVOICED" && s.status !== "CLOSED" && (
                      <Button variant="ghost" onClick={() => doCancel(s)} disabled={updateStatus.isPending}>
                        Cancel
                      </Button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

const StatusChip = ({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) => (
  <button
    type="button"
    onClick={onClick}
    style={{
      fontFamily: "var(--font-button)",
      fontSize: "var(--fs-13)",
      fontWeight: 600,
      padding: "var(--space-2) var(--space-4)",
      borderRadius: "var(--radius-pill)",
      border: active ? "1px solid var(--c-ink)" : "1px solid var(--line)",
      background: active ? "var(--c-ink)" : "var(--c-paper)",
      color: active ? "var(--c-cream)" : "var(--c-ink)",
      cursor: "pointer",
    }}
  >
    {children}
  </button>
);
