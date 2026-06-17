// ----------------------------------------------------------------------------
// PurchaseConsignmentOrders — PC Order list. 1:1 clone of 2990s
// apps/backend/src/pages/PurchaseConsignmentOrders.tsx. Status chips, per-row
// supplier + item summary + total, row-click -> detail, Cancel/Delete actions.
// SEAM playbook (done slices): data via ./consignment-purchase-queries (Houzs api
// client + react-query); 2990s DataGrid -> plain <table> + Suppliers.module.css;
// react-router-dom; in-app useDialog/useToast (rule #10), never window.confirm.
// ----------------------------------------------------------------------------

import { useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Plus } from "lucide-react";
import { Button } from "../../components/Button";
import { usePcOrders, useCancelPcOrder, useDeletePcOrder, type PcoRow, type PcoStatus } from "./consignment-purchase-queries";
import { useDialog } from "../../hooks/useDialog";
import { useToast } from "../../hooks/useToast";
import styles from "../Suppliers.module.css";

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const STATUS_LABEL: Record<string, string> = {
  SUBMITTED: "Submitted",
  PARTIALLY_RECEIVED: "Partially received",
  RECEIVED: "Received",
  CANCELLED: "Cancelled",
};
const STATUS_CHIPS: Array<"all" | PcoStatus> = ["all", "SUBMITTED", "PARTIALLY_RECEIVED", "RECEIVED", "CANCELLED"];
const STATUS_CLASS: Record<PcoStatus, string> = {
  SUBMITTED: styles.statusActive ?? "",
  PARTIALLY_RECEIVED: styles.statusActive ?? "",
  RECEIVED: styles.statusActive ?? "",
  CANCELLED: styles.statusBlocked ?? "",
};

const fmtMoney = (centi: number, currency = "MYR"): string =>
  `${currency} ${(centi / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDateOrDash = (iso: string | null): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
};

export const PurchaseConsignmentOrders = () => {
  const navigate = useNavigate();
  const dialog = useDialog();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const statusChip = (searchParams.get("status") ?? "all") as "all" | PcoStatus;
  const setStatusChip = (s: "all" | PcoStatus) => {
    const next = new URLSearchParams(searchParams);
    if (s === "all") next.delete("status");
    else next.set("status", s);
    setSearchParams(next, { replace: true });
  };

  const { data, isLoading, error } = usePcOrders();
  const cancelPco = useCancelPcOrder();
  const deletePco = useDeletePcOrder();

  const rows = useMemo<PcoRow[]>(() => {
    const all = data ?? [];
    return statusChip === "all" ? all : all.filter((p) => p.status === statusChip);
  }, [data, statusChip]);

  const doCancel = async (p: PcoRow) => {
    if (!(await dialog.confirm(`Cancel PC Order ${p.pc_number}? It can be deleted afterwards.`))) return;
    cancelPco.mutate(p.id, { onError: (e) => toast.error(`Cancel failed: ${e instanceof Error ? e.message : String(e)}`) });
  };
  const doDelete = async (p: PcoRow) => {
    if (!(await dialog.confirm(`Delete PC Order ${p.pc_number}? This permanently removes it and its lines.`))) return;
    deletePco.mutate(p.id, {
      onSuccess: () => toast.success(`Deleted ${p.pc_number}`),
      onError: (e) => toast.error(`Delete failed: ${e instanceof Error ? e.message : String(e)}`),
    });
  };

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div>
          <h1 className={styles.title}>Purchase Consignment Orders</h1>
        </div>
        <Button variant="primary" onClick={() => navigate("/purchase-consignment-orders/new")}>
          <Plus {...ICON} />
          <span>New PC Order</span>
        </Button>
      </div>

      <div className={styles.statusChips}>
        {STATUS_CHIPS.map((s) => (
          <StatusChip key={s} active={statusChip === s} onClick={() => setStatusChip(s)}>
            {s === "all" ? "All" : STATUS_LABEL[s] ?? s}
          </StatusChip>
        ))}
      </div>

      <p className={styles.eyebrow}>{isLoading ? "Loading PC orders…" : `${rows.length} PC orders`}</p>

      {error && !isLoading && (
        <div className={styles.bannerWarn}>
          <strong>Failed to load PC orders.</strong> {error instanceof Error ? error.message : String(error)}
        </div>
      )}

      <div className={styles.tableCard}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>PC No.</th>
              <th>Supplier</th>
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
                  <p className={styles.emptyRow}>No PC orders yet.</p>
                </td>
              </tr>
            ) : (
              rows.map((p) => (
                <tr key={p.id} onClick={() => navigate(`/purchase-consignment-orders/${p.id}`)} style={p.status === "CANCELLED" ? { opacity: 0.55 } : undefined}>
                  <td>
                    <span className={styles.codeChip}>{p.pc_number}</span>
                  </td>
                  <td>{p.supplier?.name ?? p.supplier?.code ?? "—"}</td>
                  <td>{(p.items ?? []).length} line(s)</td>
                  <td>{fmtDateOrDash(p.po_date)}</td>
                  <td style={{ textAlign: "right" }}>
                    <span style={{ fontWeight: 700, color: "var(--c-burnt)" }}>{fmtMoney(Number(p.total_centi ?? 0), p.currency)}</span>
                  </td>
                  <td>
                    <span className={`${styles.statusPill} ${STATUS_CLASS[p.status]}`}>{STATUS_LABEL[p.status] ?? p.status}</span>
                  </td>
                  <td style={{ textAlign: "right" }} onClick={(e) => e.stopPropagation()}>
                    {p.status !== "CANCELLED" && p.status !== "RECEIVED" && !p.has_children && (
                      <Button variant="ghost" onClick={() => doCancel(p)} disabled={cancelPco.isPending}>
                        Cancel
                      </Button>
                    )}
                    {p.status === "CANCELLED" && (
                      <Button variant="ghost" onClick={() => doDelete(p)} disabled={deletePco.isPending}>
                        Delete
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
