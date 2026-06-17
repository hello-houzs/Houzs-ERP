// ----------------------------------------------------------------------------
// ConsignmentOrders — Consignment Order (CO) list. Houzs-style clone of 2990s
// apps/backend/src/pages/ConsignmentOrders.tsx (Strategy-2: plain <table> +
// Suppliers.module.css, no furniture columns). Status chips, per-row customer +
// total, row-click -> detail, Cancel (gated by has_children). Data via
// ./consignment-sales-queries; in-app useDialog/useToast (rule #10).
// ----------------------------------------------------------------------------

import { useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Plus } from "lucide-react";
import { Button } from "../../components/Button";
import { useConsignmentOrders, useUpdateConsignmentOrderStatus, type CoRow, type CoStatus } from "./consignment-sales-queries";
import { useDialog } from "../../hooks/useDialog";
import { useToast } from "../../hooks/useToast";
import styles from "../Suppliers.module.css";

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const STATUS_LABEL: Record<string, string> = {
  CONFIRMED: "Confirmed", IN_PRODUCTION: "In Production", READY_TO_SHIP: "Ready to Ship", SHIPPED: "Shipped",
  DELIVERED: "Delivered", INVOICED: "Invoiced", CLOSED: "Closed", ON_HOLD: "On Hold", CANCELLED: "Cancelled",
};
const STATUS_CHIPS: Array<"all" | CoStatus> = ["all", "CONFIRMED", "READY_TO_SHIP", "SHIPPED", "DELIVERED", "INVOICED", "CLOSED", "ON_HOLD", "CANCELLED"];

const fmtMoney = (centi: number, currency = "MYR"): string =>
  `${currency} ${(centi / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDateOrDash = (iso: string | null): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
};

export const ConsignmentOrders = () => {
  const navigate = useNavigate();
  const dialog = useDialog();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const statusChip = (searchParams.get("status") ?? "all") as "all" | CoStatus;
  const setStatusChip = (s: "all" | CoStatus) => {
    const next = new URLSearchParams(searchParams);
    if (s === "all") next.delete("status");
    else next.set("status", s);
    setSearchParams(next, { replace: true });
  };

  const { data, isLoading, error } = useConsignmentOrders();
  const setStatus = useUpdateConsignmentOrderStatus();

  const rows = useMemo<CoRow[]>(() => {
    const all = data ?? [];
    return statusChip === "all" ? all : all.filter((p) => p.status === statusChip);
  }, [data, statusChip]);

  const doCancel = async (p: CoRow) => {
    if (!(await dialog.confirm(`Cancel Consignment Order ${p.doc_no}?`))) return;
    setStatus.mutate({ docNo: p.doc_no, status: "CANCELLED" }, { onError: (e) => toast.error(`Cancel failed: ${e instanceof Error ? e.message : String(e)}`) });
  };

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div>
          <h1 className={styles.title}>Consignment Orders</h1>
        </div>
        <Button variant="primary" onClick={() => navigate("/consignment-orders/new")}>
          <Plus {...ICON} />
          <span>New Consignment Order</span>
        </Button>
      </div>

      <div className={styles.statusChips}>
        {STATUS_CHIPS.map((s) => (
          <StatusChip key={s} active={statusChip === s} onClick={() => setStatusChip(s)}>
            {s === "all" ? "All" : STATUS_LABEL[s] ?? s}
          </StatusChip>
        ))}
      </div>

      <p className={styles.eyebrow}>{isLoading ? "Loading consignment orders…" : `${rows.length} consignment orders`}</p>

      {error && !isLoading && (
        <div className={styles.bannerWarn}>
          <strong>Failed to load consignment orders.</strong> {error instanceof Error ? error.message : String(error)}
        </div>
      )}

      <div className={styles.tableCard}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>CO No.</th>
              <th>Customer</th>
              <th>Items</th>
              <th>Order Date</th>
              <th style={{ textAlign: "right" }}>Total</th>
              <th>Status</th>
              <th style={{ textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !isLoading ? (
              <tr>
                <td colSpan={7}>
                  <p className={styles.emptyRow}>No consignment orders yet.</p>
                </td>
              </tr>
            ) : (
              rows.map((p) => (
                <tr key={p.doc_no} onClick={() => navigate(`/consignment-orders/${p.doc_no}`)} style={p.status === "CANCELLED" ? { opacity: 0.55 } : undefined}>
                  <td><span className={styles.codeChip}>{p.doc_no}</span></td>
                  <td>{p.debtor_name}</td>
                  <td>{p.line_count} line(s)</td>
                  <td>{fmtDateOrDash(p.so_date)}</td>
                  <td style={{ textAlign: "right" }}><span style={{ fontWeight: 700, color: "var(--c-burnt)" }}>{fmtMoney(Number(p.local_total_centi ?? 0), p.currency)}</span></td>
                  <td><span className={`${styles.statusPill} ${p.status === "CANCELLED" ? styles.statusBlocked ?? "" : styles.statusActive ?? ""}`}>{STATUS_LABEL[p.status] ?? p.status}</span></td>
                  <td style={{ textAlign: "right" }} onClick={(e) => e.stopPropagation()}>
                    {p.status !== "CANCELLED" && !p.has_children && (
                      <Button variant="ghost" onClick={() => doCancel(p)} disabled={setStatus.isPending}>Cancel</Button>
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
      fontFamily: "var(--font-button)", fontSize: "var(--fs-13)", fontWeight: 600,
      padding: "var(--space-2) var(--space-4)", borderRadius: "var(--radius-pill)",
      border: active ? "1px solid var(--c-ink)" : "1px solid var(--line)",
      background: active ? "var(--c-ink)" : "var(--c-paper)", color: active ? "var(--c-cream)" : "var(--c-ink)", cursor: "pointer",
    }}
  >
    {children}
  </button>
);
