// ----------------------------------------------------------------------------
// DeliveryReturnsList — Delivery Return (DR) list. 1:1 clone of 2990s
// DeliveryReturnsList.tsx. Status chips, per-row source DO + customer + refund,
// row-click -> detail, Cancel action. SEAM (rule #9 + #10): DataGrid -> <table>
// + Suppliers.module.css; useDialog / useToast.
// ----------------------------------------------------------------------------

import { useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowRightLeft } from "lucide-react";
import { Button } from "../../components/Button";
import { useDeliveryReturns, useUpdateDeliveryReturnStatus, type DrRow, type DrStatus } from "./delivery-billing-queries";
import { useDialog } from "../../hooks/useDialog";
import { useToast } from "../../hooks/useToast";
import styles from "../Suppliers.module.css";

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const STATUS_LABEL: Record<string, string> = { PENDING: "Pending", RECEIVED: "Received", INSPECTED: "Inspected", REFUNDED: "Refunded", CREDIT_NOTED: "Credit Noted", REJECTED: "Rejected", CANCELLED: "Cancelled" };
const STATUS_CHIPS: Array<"all" | DrStatus> = ["all", "RECEIVED", "INSPECTED", "REFUNDED", "CREDIT_NOTED", "REJECTED", "CANCELLED"];

const fmtMoney = (centi: number, currency = "MYR"): string => `${currency} ${(centi / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDateOrDash = (iso: string | null): string => { if (!iso) return "—"; const d = new Date(iso); if (!Number.isFinite(d.getTime())) return iso; return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }); };

export const DeliveryReturns = () => {
  const navigate = useNavigate();
  const dialog = useDialog();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const statusChip = (searchParams.get("status") ?? "all") as "all" | DrStatus;
  const setStatusChip = (s: "all" | DrStatus) => { const next = new URLSearchParams(searchParams); if (s === "all") next.delete("status"); else next.set("status", s); setSearchParams(next, { replace: true }); };

  const { data, isLoading, error } = useDeliveryReturns();
  const setStatus = useUpdateDeliveryReturnStatus();

  const rows = useMemo<DrRow[]>(() => { const all = data ?? []; return statusChip === "all" ? all : all.filter((d) => d.status === statusChip); }, [data, statusChip]);

  const doCancel = async (d: DrRow) => {
    if (!(await dialog.confirm(`Cancel return ${d.return_number}? This reverses the return — the goods are removed from stock again. Line items stay for audit.`))) return;
    setStatus.mutate({ id: d.id, status: "CANCELLED" }, { onError: (e) => toast.error(`Cancel failed: ${e instanceof Error ? e.message : String(e)}`) });
  };

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div><h1 className={styles.title}>Delivery Returns</h1></div>
        <div style={{ display: "flex", gap: "var(--space-2)" }}>
          <Button variant="primary" onClick={() => navigate("/delivery-returns/from-do")}><ArrowRightLeft {...ICON} /><span>From Delivery Order</span></Button>
        </div>
      </div>

      <div className={styles.statusChips}>
        {STATUS_CHIPS.map((s) => (<StatusChip key={s} active={statusChip === s} onClick={() => setStatusChip(s)}>{s === "all" ? "All" : STATUS_LABEL[s] ?? s}</StatusChip>))}
      </div>

      <p className={styles.eyebrow}>{isLoading ? "Loading delivery returns…" : `${rows.length} delivery returns`}</p>

      {error && !isLoading && (<div className={styles.bannerWarn}><strong>Failed to load delivery returns.</strong> {error instanceof Error ? error.message : String(error)}</div>)}

      <div className={styles.tableCard}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Return No.</th>
              <th>Source DO</th>
              <th>Customer</th>
              <th>Return Date</th>
              <th style={{ textAlign: "right" }}>Refund</th>
              <th>Status</th>
              <th style={{ textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !isLoading ? (
              <tr><td colSpan={7}><p className={styles.emptyRow}>No returns yet — convert a Delivery Order via "From Delivery Order".</p></td></tr>
            ) : (
              rows.map((d) => (
                <tr key={d.id} onClick={() => navigate(`/delivery-returns/${d.id}`)} style={d.status === "CANCELLED" ? { opacity: 0.55 } : undefined}>
                  <td><span className={styles.codeChip}>{d.return_number}</span></td>
                  <td><span style={{ fontFamily: "var(--font-mono)", fontWeight: 700, color: "var(--c-burnt)" }}>{d.do_doc_no ?? "—"}</span></td>
                  <td>{d.debtor_name}</td>
                  <td>{fmtDateOrDash(d.return_date)}</td>
                  <td style={{ textAlign: "right" }}><span style={{ fontWeight: 700, color: "var(--c-burnt)" }}>{fmtMoney(Number(d.refund_centi ?? 0), d.currency)}</span></td>
                  <td><span className={`${styles.statusPill} ${d.status === "CANCELLED" || d.status === "REJECTED" ? styles.statusBlocked ?? "" : styles.statusActive ?? ""}`}>{STATUS_LABEL[d.status] ?? d.status}</span></td>
                  <td style={{ textAlign: "right" }} onClick={(e) => e.stopPropagation()}>
                    {d.status !== "CANCELLED" && (<Button variant="ghost" onClick={() => doCancel(d)} disabled={setStatus.isPending}>Cancel</Button>)}
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
  <button type="button" onClick={onClick} style={{ fontFamily: "var(--font-button)", fontSize: "var(--fs-13)", fontWeight: 600, padding: "var(--space-2) var(--space-4)", borderRadius: "var(--radius-pill)", border: active ? "1px solid var(--c-ink)" : "1px solid var(--line)", background: active ? "var(--c-ink)" : "var(--c-paper)", color: active ? "var(--c-cream)" : "var(--c-ink)", cursor: "pointer" }}>{children}</button>
);
