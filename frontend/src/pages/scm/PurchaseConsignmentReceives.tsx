// ----------------------------------------------------------------------------
// PurchaseConsignmentReceives — PC Receive list. 1:1 clone of 2990s
// apps/backend/src/pages/PurchaseConsignmentReceives.tsx. A PC Receive books the
// supplier's consigned stock IN; row-click -> detail, Cancel reverses inventory.
// SEAM playbook: ./consignment-purchase-queries hooks; plain <table> +
// Suppliers.module.css; in-app useDialog/useToast (rule #10).
// ----------------------------------------------------------------------------

import { useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Plus, ArrowRightLeft } from "lucide-react";
import { Button } from "../../components/Button";
import { usePcReceives, useCancelPcReceive, type PcrRow, type PcrStatus } from "./consignment-purchase-queries";
import { useDialog } from "../../hooks/useDialog";
import { useToast } from "../../hooks/useToast";
import styles from "../Suppliers.module.css";

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const STATUS_LABEL: Record<string, string> = { POSTED: "Posted", CLOSED: "Closed", CANCELLED: "Cancelled" };
const STATUS_CHIPS: Array<"all" | PcrStatus> = ["all", "POSTED", "CLOSED", "CANCELLED"];
const STATUS_CLASS: Record<PcrStatus, string> = {
  POSTED: styles.statusActive ?? "",
  CLOSED: styles.statusActive ?? "",
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

export const PurchaseConsignmentReceives = () => {
  const navigate = useNavigate();
  const dialog = useDialog();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const statusChip = (searchParams.get("status") ?? "all") as "all" | PcrStatus;
  const setStatusChip = (s: "all" | PcrStatus) => {
    const next = new URLSearchParams(searchParams);
    if (s === "all") next.delete("status");
    else next.set("status", s);
    setSearchParams(next, { replace: true });
  };

  const { data, isLoading, error } = usePcReceives();
  const cancelPcr = useCancelPcReceive();

  const rows = useMemo<PcrRow[]>(() => {
    const all = data ?? [];
    return statusChip === "all" ? all : all.filter((p) => p.status === statusChip);
  }, [data, statusChip]);

  const doCancel = async (p: PcrRow) => {
    if (!(await dialog.confirm(`Cancel receive ${p.receive_number}? This reverses the stock-in — the consigned goods leave inventory again.`))) return;
    cancelPcr.mutate(p.id, { onError: (e) => toast.error(`Cancel failed: ${e instanceof Error ? e.message : String(e)}`) });
  };

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div>
          <h1 className={styles.title}>Purchase Consignment Receives</h1>
        </div>
        <div style={{ display: "flex", gap: "var(--space-2)" }}>
          <Button variant="ghost" onClick={() => navigate("/purchase-consignment-receives/from-order")}>
            <ArrowRightLeft {...ICON} />
            <span>From PC Order</span>
          </Button>
          <Button variant="primary" onClick={() => navigate("/purchase-consignment-receives/new")}>
            <Plus {...ICON} />
            <span>New PC Receive</span>
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

      <p className={styles.eyebrow}>{isLoading ? "Loading receives…" : `${rows.length} PC receives`}</p>

      {error && !isLoading && (
        <div className={styles.bannerWarn}>
          <strong>Failed to load receives.</strong> {error instanceof Error ? error.message : String(error)}
        </div>
      )}

      <div className={styles.tableCard}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Receive No.</th>
              <th>Supplier</th>
              <th>Source PC Order</th>
              <th>Received</th>
              <th style={{ textAlign: "right" }}>Total</th>
              <th>Status</th>
              <th style={{ textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !isLoading ? (
              <tr>
                <td colSpan={7}>
                  <p className={styles.emptyRow}>No receives yet — convert a PC Order via "From PC Order".</p>
                </td>
              </tr>
            ) : (
              rows.map((p) => (
                <tr key={p.id} onClick={() => navigate(`/purchase-consignment-receives/${p.id}`)} style={p.status === "CANCELLED" ? { opacity: 0.55 } : undefined}>
                  <td>
                    <span className={styles.codeChip}>{p.receive_number}</span>
                  </td>
                  <td>{p.supplier?.name ?? p.supplier?.code ?? "—"}</td>
                  <td>
                    <span style={{ fontFamily: "var(--font-mono)", fontWeight: 700, color: "var(--c-burnt)" }}>{p.purchase_consignment_order?.pc_number ?? p.pc_order_no ?? "—"}</span>
                  </td>
                  <td>{fmtDateOrDash(p.received_at)}</td>
                  <td style={{ textAlign: "right" }}>
                    <span style={{ fontWeight: 700, color: "var(--c-burnt)" }}>{fmtMoney(Number(p.total_centi ?? 0), p.currency)}</span>
                  </td>
                  <td>
                    <span className={`${styles.statusPill} ${STATUS_CLASS[p.status]}`}>{STATUS_LABEL[p.status] ?? p.status}</span>
                  </td>
                  <td style={{ textAlign: "right" }} onClick={(e) => e.stopPropagation()}>
                    {p.status === "POSTED" && !p.has_children && (
                      <Button variant="ghost" onClick={() => doCancel(p)} disabled={cancelPcr.isPending}>
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
