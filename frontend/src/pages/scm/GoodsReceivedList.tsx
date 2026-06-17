// ----------------------------------------------------------------------------
// GoodsReceivedList — Goods Received Note (GRN) list.
//
// 1:1 clone of 2990s apps/backend/src/pages/GoodsReceivedList.tsx. Same status
// chips (All / Confirmed / Closed / Cancelled), per-row supplier + source PO +
// total, row-click → detail, and Cancel action. The wire shape (GrnRow) matches
// 2990s exactly.
//
// SEAM changes (the only deviations — same playbook as the PO slice):
//   - Data layer: 2990s lib/flow-queries (authedFetch) -> the GRN hooks in
//     ./grn-queries (Houzs api client + @tanstack/react-query). Shapes identical
//     (rule #7).
//   - Components: @2990s/design-system Button -> Houzs components/Button; 2990s
//     DataGrid (large 2990s-only tree, incl. the row drill-down) -> a plain
//     <table> with the verbatim Suppliers.module.css classes (rule #9), same as
//     the PurchaseOrders list. The expandable per-line drill-down lives on the
//     detail page instead.
//   - Routing: react-router -> react-router-dom (same hooks).
//
// Strategy-2 product-layer notes:
//   - "Convert to Purchase Invoice / Return" (2990s right-click) target the PI/PR
//     slices, which are NOT cloned yet — dropped here. TODO: wire when those land.
//   - buildVariantSummary (furniture formatter) is not used (the list shows code +
//     description from the API; description2 passes through unchanged).
// ----------------------------------------------------------------------------

import { useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Plus, ArrowRightLeft } from "lucide-react";
import { Button } from "../../components/Button";
import { useGrns, useCancelGrn, type GrnRow, type GrnStatus } from "./grn-queries";
import { useDialog } from "../../hooks/useDialog";
import { useToast } from "../../hooks/useToast";
import styles from "../Suppliers.module.css";

const ICON = { size: 16, strokeWidth: 1.75 } as const;

// GRN status set (grn_status enum): POSTED / CLOSED / CANCELLED. A GRN has no
// draft/lifecycle — POSTED reads as "Confirmed".
const STATUS_LABEL: Record<string, string> = {
  POSTED: "Confirmed",
  CLOSED: "Closed",
  CANCELLED: "Cancelled",
};
const STATUS_CHIPS: Array<"all" | GrnStatus> = ["all", "POSTED", "CLOSED", "CANCELLED"];

const STATUS_CLASS: Record<GrnStatus, string> = {
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

export const GoodsReceived = () => {
  const navigate = useNavigate();
  const dialog = useDialog();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const statusChip = (searchParams.get("status") ?? "all") as "all" | GrnStatus;
  const setStatusChip = (s: "all" | GrnStatus) => {
    const next = new URLSearchParams(searchParams);
    if (s === "all") next.delete("status");
    else next.set("status", s);
    setSearchParams(next, { replace: true });
  };

  const { data, isLoading, error } = useGrns();
  const cancelGrn = useCancelGrn();

  const rows = useMemo<GrnRow[]>(() => {
    const all = data ?? [];
    return statusChip === "all" ? all : all.filter((g) => g.status === statusChip);
  }, [data, statusChip]);

  const doCancelGrn = async (g: GrnRow) => {
    if (
      !(await dialog.confirm(
        `Cancel GRN ${g.grn_number}? This reverses the receipt — stock is taken back out and the source PO's received qty is rolled back. Line items stay for audit.`,
      ))
    )
      return;
    cancelGrn.mutate(g.id, {
      onError: (e) => toast.error(`Cancel failed: ${e instanceof Error ? e.message : String(e)}`),
    });
  };

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div>
          <h1 className={styles.title}>Goods Received</h1>
        </div>
        <div style={{ display: "flex", gap: "var(--space-2)" }}>
          <Button variant="ghost" onClick={() => navigate("/grns/from-po")}>
            <ArrowRightLeft {...ICON} />
            <span>From Purchase Order</span>
          </Button>
          <Button variant="primary" onClick={() => navigate("/grns/new")}>
            <Plus {...ICON} />
            <span>New Goods Receipt</span>
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

      <p className={styles.eyebrow}>{isLoading ? "Loading GRNs…" : `${rows.length} goods received notes`}</p>

      {error && !isLoading && (
        <div className={styles.bannerWarn}>
          <strong>Failed to load GRNs.</strong> {error instanceof Error ? error.message : String(error)}
        </div>
      )}

      <div className={styles.tableCard}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>GRN No.</th>
              <th>Supplier</th>
              <th>Transfer From (PO)</th>
              <th>Received</th>
              <th>DN Ref</th>
              <th style={{ textAlign: "right" }}>Total</th>
              <th>Status</th>
              <th style={{ textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !isLoading ? (
              <tr>
                <td colSpan={8}>
                  <p className={styles.emptyRow}>No GRNs yet — click "New Goods Receipt" to receive goods.</p>
                </td>
              </tr>
            ) : (
              rows.map((g) => (
                <tr
                  key={g.id}
                  onClick={() => navigate(`/grns/${g.id}`)}
                  style={g.status === "CANCELLED" || g.status === "CLOSED" ? { opacity: 0.55 } : undefined}
                >
                  <td>
                    <span className={styles.codeChip}>{g.grn_number}</span>
                  </td>
                  <td>{g.supplier?.name ?? g.supplier?.code ?? "—"}</td>
                  <td>
                    <span style={{ fontFamily: "var(--font-mono)", fontWeight: 700, color: "var(--c-burnt)" }}>
                      {g.purchase_order?.po_number ?? "—"}
                    </span>
                  </td>
                  <td>{fmtDateOrDash(g.received_at)}</td>
                  <td>{g.delivery_note_ref ?? "—"}</td>
                  <td style={{ textAlign: "right" }}>
                    <span style={{ fontWeight: 700, color: "var(--c-burnt)" }}>
                      {fmtMoney(Number(g.total_centi ?? 0), g.currency)}
                    </span>
                  </td>
                  <td>
                    <span className={`${styles.statusPill} ${STATUS_CLASS[g.status]}`}>
                      {STATUS_LABEL[g.status] ?? g.status}
                    </span>
                  </td>
                  <td style={{ textAlign: "right" }} onClick={(e) => e.stopPropagation()}>
                    {g.status === "POSTED" && !g.has_children && (
                      <Button variant="ghost" onClick={() => doCancelGrn(g)} disabled={cancelGrn.isPending}>
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
