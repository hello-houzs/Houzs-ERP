// ----------------------------------------------------------------------------
// ConsignmentNotes — Consignment Note (CN) list. Houzs-style clone of 2990s
// ConsignmentNotes.tsx (Strategy-2: plain <table> + Suppliers.module.css). Status
// chips, per-row CO link + customer + total, row-click -> detail, Cancel (gated by
// has_children = a non-cancelled Consignment Return). Data via
// ./consignment-sales-queries; in-app useDialog/useToast (rule #10).
// ----------------------------------------------------------------------------

import { useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Plus } from "lucide-react";
import { Button } from "../../components/Button";
import { useConsignmentNotes, useUpdateConsignmentNoteStatus, type CnRow, type CnStatus } from "./consignment-sales-queries";
import { useDialog } from "../../hooks/useDialog";
import { useToast } from "../../hooks/useToast";
import styles from "../Suppliers.module.css";

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const STATUS_LABEL: Record<string, string> = {
  LOADED: "Loaded", DISPATCHED: "Dispatched", IN_TRANSIT: "In Transit", SIGNED: "Signed", DELIVERED: "Delivered", INVOICED: "Invoiced", CANCELLED: "Cancelled",
};
const STATUS_CHIPS: Array<"all" | CnStatus> = ["all", "DISPATCHED", "IN_TRANSIT", "SIGNED", "DELIVERED", "INVOICED", "CANCELLED"];

const fmtMoney = (centi: number, currency = "MYR"): string =>
  `${currency} ${(centi / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDateOrDash = (iso: string | null): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
};

export const ConsignmentNotes = () => {
  const navigate = useNavigate();
  const dialog = useDialog();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const statusChip = (searchParams.get("status") ?? "all") as "all" | CnStatus;
  const setStatusChip = (s: "all" | CnStatus) => {
    const next = new URLSearchParams(searchParams);
    if (s === "all") next.delete("status");
    else next.set("status", s);
    setSearchParams(next, { replace: true });
  };

  const { data, isLoading, error } = useConsignmentNotes();
  const setStatus = useUpdateConsignmentNoteStatus();

  const rows = useMemo<CnRow[]>(() => {
    const all = data ?? [];
    return statusChip === "all" ? all : all.filter((d) => d.status === statusChip);
  }, [data, statusChip]);

  const doCancel = async (d: CnRow) => {
    if (!(await dialog.confirm(`Cancel consignment note ${d.do_number}? This returns the shipped stock to the shelf.`))) return;
    setStatus.mutate({ id: d.id, status: "CANCELLED" }, { onError: (e) => toast.error(`Cancel failed: ${e instanceof Error ? e.message : String(e)}`) });
  };

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div>
          <h1 className={styles.title}>Consignment Notes</h1>
        </div>
        <Button variant="primary" onClick={() => navigate("/consignment-notes/from-order")}>
          <Plus {...ICON} />
          <span>New Consignment Note</span>
        </Button>
      </div>

      <div className={styles.statusChips}>
        {STATUS_CHIPS.map((s) => (
          <StatusChip key={s} active={statusChip === s} onClick={() => setStatusChip(s)}>
            {s === "all" ? "All" : STATUS_LABEL[s] ?? s}
          </StatusChip>
        ))}
      </div>

      <p className={styles.eyebrow}>{isLoading ? "Loading consignment notes…" : `${rows.length} consignment notes`}</p>

      {error && !isLoading && (
        <div className={styles.bannerWarn}>
          <strong>Failed to load consignment notes.</strong> {error instanceof Error ? error.message : String(error)}
        </div>
      )}

      <div className={styles.tableCard}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>CN No.</th>
              <th>Consignment Order</th>
              <th>Customer</th>
              <th>Note Date</th>
              <th style={{ textAlign: "right" }}>Total</th>
              <th>Status</th>
              <th style={{ textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !isLoading ? (
              <tr>
                <td colSpan={7}>
                  <p className={styles.emptyRow}>No consignment notes yet — convert Consignment Order lines via "New Consignment Note".</p>
                </td>
              </tr>
            ) : (
              rows.map((d) => (
                <tr key={d.id} onClick={() => navigate(`/consignment-notes/${d.id}`)} style={d.status === "CANCELLED" ? { opacity: 0.55 } : undefined}>
                  <td><span className={styles.codeChip}>{d.do_number}</span></td>
                  <td><span style={{ fontFamily: "var(--font-mono)", fontWeight: 700, color: "var(--c-burnt)" }}>{d.consignment_so_doc_no ?? "—"}</span></td>
                  <td>{d.debtor_name}</td>
                  <td>{fmtDateOrDash(d.do_date)}</td>
                  <td style={{ textAlign: "right" }}><span style={{ fontWeight: 700, color: "var(--c-burnt)" }}>{fmtMoney(Number(d.local_total_centi ?? 0), d.currency)}</span></td>
                  <td><span className={`${styles.statusPill} ${d.status === "CANCELLED" ? styles.statusBlocked ?? "" : styles.statusActive ?? ""}`}>{STATUS_LABEL[d.status] ?? d.status}</span></td>
                  <td style={{ textAlign: "right" }} onClick={(e) => e.stopPropagation()}>
                    {d.status !== "CANCELLED" && !d.has_children && (
                      <Button variant="ghost" onClick={() => doCancel(d)} disabled={setStatus.isPending}>Cancel</Button>
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
