// ----------------------------------------------------------------------------
// PurchaseReturnsList — Purchase Return (PR) list.
//
// 1:1 clone of 2990s apps/backend/src/pages/PurchaseReturnsList.tsx. Same status
// chips (All / Confirmed / Completed / Cancelled), per-row supplier + source GRN
// + refund, row-click -> detail, and Cancel action. The wire shape (PrRow)
// matches 2990s exactly.
//
// SEAM changes (the only deviations — same playbook as the GRN slice):
//   - Data layer: 2990s lib/flow-queries (authedFetch) -> the PR hooks in
//     ./flow-queries (Houzs api client + @tanstack/react-query). Shapes identical.
//   - Components: @2990s/design-system Button -> Houzs components/Button; 2990s
//     DataGrid -> a plain <table> with the verbatim Suppliers.module.css classes.
//   - Routing: react-router -> react-router-dom (same hooks).
// ----------------------------------------------------------------------------

import { useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Plus, ArrowRightLeft } from "lucide-react";
import { Button } from "../../components/Button";
import { usePurchaseReturns, useCancelPurchaseReturn, type PrRow, type PrStatus } from "./flow-queries";
import styles from "../Suppliers.module.css";

const ICON = { size: 16, strokeWidth: 1.75 } as const;

// purchase_return_status enum: POSTED / COMPLETED / CANCELLED.
const STATUS_LABEL: Record<string, string> = {
  POSTED: "Confirmed",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};
const STATUS_CHIPS: Array<"all" | PrStatus> = ["all", "POSTED", "COMPLETED", "CANCELLED"];

const STATUS_CLASS: Record<PrStatus, string> = {
  POSTED: styles.statusActive ?? "",
  COMPLETED: styles.statusActive ?? "",
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

export const PurchaseReturns = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const statusChip = (searchParams.get("status") ?? "all") as "all" | PrStatus;
  const setStatusChip = (s: "all" | PrStatus) => {
    const next = new URLSearchParams(searchParams);
    if (s === "all") next.delete("status");
    else next.set("status", s);
    setSearchParams(next, { replace: true });
  };

  const { data, isLoading, error } = usePurchaseReturns();
  const cancelPr = useCancelPurchaseReturn();

  const rows = useMemo<PrRow[]>(() => {
    const all = data ?? [];
    return statusChip === "all" ? all : all.filter((p) => p.status === statusChip);
  }, [data, statusChip]);

  const doCancelPr = (p: PrRow) => {
    if (!confirm(`Cancel return ${p.return_number}? This reverses the return — the goods are put back into stock. Line items stay for audit.`)) return;
    cancelPr.mutate(p.id, {
      onError: (e) => alert(`Cancel failed: ${e instanceof Error ? e.message : String(e)}`),
    });
  };

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div>
          <h1 className={styles.title}>Purchase Returns</h1>
        </div>
        <div style={{ display: "flex", gap: "var(--space-2)" }}>
          <Button variant="ghost" onClick={() => navigate("/grns")}>
            <ArrowRightLeft {...ICON} />
            <span>From Goods Receipt</span>
          </Button>
          <Button variant="primary" onClick={() => navigate("/purchase-returns/new")}>
            <Plus {...ICON} />
            <span>New Purchase Return</span>
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

      <p className={styles.eyebrow}>{isLoading ? "Loading returns…" : `${rows.length} purchase returns`}</p>

      {error && !isLoading && (
        <div className={styles.bannerWarn}>
          <strong>Failed to load purchase returns.</strong> {error instanceof Error ? error.message : String(error)}
        </div>
      )}

      <div className={styles.tableCard}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Return No.</th>
              <th>Supplier</th>
              <th>Transfer From (GRN)</th>
              <th>Return Date</th>
              <th style={{ textAlign: "right" }}>Refund</th>
              <th>Status</th>
              <th style={{ textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !isLoading ? (
              <tr>
                <td colSpan={7}>
                  <p className={styles.emptyRow}>No returns yet — convert a Goods Receipt via "From Goods Receipt".</p>
                </td>
              </tr>
            ) : (
              rows.map((p) => (
                <tr
                  key={p.id}
                  onClick={() => navigate(`/purchase-returns/${p.id}`)}
                  style={p.status === "CANCELLED" || p.status === "COMPLETED" ? { opacity: 0.55 } : undefined}
                >
                  <td>
                    <span className={styles.codeChip}>{p.return_number}</span>
                  </td>
                  <td>{p.supplier?.name ?? p.supplier?.code ?? "—"}</td>
                  <td>
                    <span style={{ fontFamily: "var(--font-mono)", fontWeight: 700, color: "var(--c-burnt)" }}>{p.grn?.grn_number ?? "—"}</span>
                  </td>
                  <td>{fmtDateOrDash(p.return_date)}</td>
                  <td style={{ textAlign: "right" }}>
                    <span style={{ fontWeight: 700, color: "var(--c-burnt)" }}>{fmtMoney(Number(p.refund_centi ?? 0))}</span>
                  </td>
                  <td>
                    <span className={`${styles.statusPill} ${STATUS_CLASS[p.status]}`}>{STATUS_LABEL[p.status] ?? p.status}</span>
                  </td>
                  <td style={{ textAlign: "right" }} onClick={(e) => e.stopPropagation()}>
                    {p.status === "POSTED" && (
                      <Button variant="ghost" onClick={() => doCancelPr(p)} disabled={cancelPr.isPending}>
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
