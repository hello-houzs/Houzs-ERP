// ----------------------------------------------------------------------------
// SalesInvoicesList — Sales Invoice (SI) list. 1:1 clone of 2990s
// SalesInvoicesList.tsx. Status chips, per-row SO/DO link + customer + total +
// paid, row-click -> detail, Cancel action (unpaid only). SEAM (rule #9 + #10):
// DataGrid -> <table> + Suppliers.module.css; useDialog / useToast.
// ----------------------------------------------------------------------------

import { useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Plus, ArrowRightLeft } from "lucide-react";
import { Button } from "../../components/Button";
import { useSalesInvoices, useUpdateSalesInvoiceStatus, type SiRow, type SiStatus } from "./delivery-billing-queries";
import { useDialog } from "../../hooks/useDialog";
import { useToast } from "../../hooks/useToast";
import styles from "../Suppliers.module.css";

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const STATUS_LABEL: Record<string, string> = { SENT: "Sent", PARTIALLY_PAID: "Partially Paid", PAID: "Paid", OVERDUE: "Overdue", CANCELLED: "Cancelled" };
const STATUS_CHIPS: Array<"all" | SiStatus> = ["all", "SENT", "PARTIALLY_PAID", "PAID", "OVERDUE", "CANCELLED"];

const fmtMoney = (centi: number, currency = "MYR"): string => `${currency} ${(centi / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDateOrDash = (iso: string | null): string => { if (!iso) return "—"; const d = new Date(iso); if (!Number.isFinite(d.getTime())) return iso; return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }); };

export const SalesInvoices = () => {
  const navigate = useNavigate();
  const dialog = useDialog();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const statusChip = (searchParams.get("status") ?? "all") as "all" | SiStatus;
  const setStatusChip = (s: "all" | SiStatus) => { const next = new URLSearchParams(searchParams); if (s === "all") next.delete("status"); else next.set("status", s); setSearchParams(next, { replace: true }); };

  const { data, isLoading, error } = useSalesInvoices();
  const setStatus = useUpdateSalesInvoiceStatus();

  const rows = useMemo<SiRow[]>(() => { const all = data ?? []; return statusChip === "all" ? all : all.filter((p) => p.status === statusChip); }, [data, statusChip]);

  const doCancel = async (p: SiRow) => {
    if (!(await dialog.confirm(`Cancel invoice ${p.invoice_number}? This sets status to CANCELLED — line items stay for audit.`))) return;
    setStatus.mutate({ id: p.id, status: "CANCELLED" }, { onError: (e) => toast.error(`Cancel failed: ${e instanceof Error ? e.message : String(e)}`) });
  };

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div><h1 className={styles.title}>Sales Invoices</h1></div>
        <div style={{ display: "flex", gap: "var(--space-2)" }}>
          <Button variant="primary" onClick={() => navigate("/sales-invoices/from-do")}><ArrowRightLeft {...ICON} /><span>From Delivery Order</span></Button>
        </div>
      </div>

      <div className={styles.statusChips}>
        {STATUS_CHIPS.map((s) => (<StatusChip key={s} active={statusChip === s} onClick={() => setStatusChip(s)}>{s === "all" ? "All" : STATUS_LABEL[s] ?? s}</StatusChip>))}
      </div>

      <p className={styles.eyebrow}>{isLoading ? "Loading invoices…" : `${rows.length} sales invoices`}</p>

      {error && !isLoading && (<div className={styles.bannerWarn}><strong>Failed to load sales invoices.</strong> {error instanceof Error ? error.message : String(error)}</div>)}

      <div className={styles.tableCard}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Invoice No.</th>
              <th>Transfer From (SO/DO)</th>
              <th>Customer</th>
              <th>Invoice Date</th>
              <th style={{ textAlign: "right" }}>Total</th>
              <th style={{ textAlign: "right" }}>Paid</th>
              <th>Status</th>
              <th style={{ textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !isLoading ? (
              <tr><td colSpan={8}><p className={styles.emptyRow}>No invoices yet — convert a Delivery Order via "From Delivery Order".</p></td></tr>
            ) : (
              rows.map((p) => (
                <tr key={p.id} onClick={() => navigate(`/sales-invoices/${p.id}`)} style={p.status === "CANCELLED" ? { opacity: 0.55 } : undefined}>
                  <td><span className={styles.codeChip}>{p.invoice_number}</span></td>
                  <td><span style={{ fontFamily: "var(--font-mono)", fontWeight: 700, color: "var(--c-burnt)" }}>{p.so_doc_no ?? (p.delivery_order_id ? "DO" : "—")}</span></td>
                  <td>{p.debtor_name}</td>
                  <td>{fmtDateOrDash(p.invoice_date)}</td>
                  <td style={{ textAlign: "right" }}><span style={{ fontWeight: 700, color: "var(--c-burnt)" }}>{fmtMoney(Number(p.total_centi ?? 0), p.currency)}</span></td>
                  <td style={{ textAlign: "right" }}>{fmtMoney(Number(p.paid_centi ?? 0), p.currency)}</td>
                  <td><span className={`${styles.statusPill} ${p.status === "CANCELLED" ? styles.statusBlocked ?? "" : styles.statusActive ?? ""}`}>{STATUS_LABEL[p.status] ?? p.status}</span></td>
                  <td style={{ textAlign: "right" }} onClick={(e) => e.stopPropagation()}>
                    {p.status !== "CANCELLED" && (p.paid_centi ?? 0) === 0 && (<Button variant="ghost" onClick={() => doCancel(p)} disabled={setStatus.isPending}>Cancel</Button>)}
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
