// ----------------------------------------------------------------------------
// PurchaseInvoicesList — Purchase Invoice (PI) list.
//
// 1:1 clone of 2990s apps/backend/src/pages/PurchaseInvoicesList.tsx. Same status
// chips (All / Confirmed / Partially Paid / Paid / Cancelled), per-row supplier +
// source GRN/PO + total, row-click -> detail, and Cancel action. The wire shape
// (PiRow) matches 2990s exactly.
//
// SEAM changes (the only deviations — same playbook as the GRN slice):
//   - Data layer: 2990s lib/flow-queries (authedFetch) -> the PI hooks in
//     ./flow-queries (Houzs api client + @tanstack/react-query). Shapes identical
//     (rule #7).
//   - Components: @2990s/design-system Button -> Houzs components/Button; 2990s
//     DataGrid (incl. the row drill-down) -> a plain <table> with the verbatim
//     Suppliers.module.css classes (rule #9), same as the GRN list. The
//     per-line drill-down lives on the detail page instead.
//   - Routing: react-router -> react-router-dom (same hooks).
//
// Strategy-2 product-layer notes:
//   - "Convert to Purchase Invoice" (2990s GRN right-click) lives on the GRN
//     detail page; this list's "From Goods Receipt" routes to that picker.
//   - buildVariantSummary (furniture formatter) is not used.
// ----------------------------------------------------------------------------

import { useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Plus, ArrowRightLeft } from "lucide-react";
import { Button } from "../../components/Button";
import { usePurchaseInvoices, useCancelPurchaseInvoice, type PiRow, type PiStatus } from "./flow-queries";
import { useDialog } from "../../hooks/useDialog";
import { useToast } from "../../hooks/useToast";
import styles from "../Suppliers.module.css";

const ICON = { size: 16, strokeWidth: 1.75 } as const;

// purchase_invoice_status enum: POSTED / PARTIALLY_PAID / PAID / CANCELLED.
const STATUS_LABEL: Record<string, string> = {
  POSTED: "Confirmed",
  PARTIALLY_PAID: "Partially Paid",
  PAID: "Paid",
  CANCELLED: "Cancelled",
};
const STATUS_CHIPS: Array<"all" | PiStatus> = ["all", "POSTED", "PARTIALLY_PAID", "PAID", "CANCELLED"];

const STATUS_CLASS: Record<PiStatus, string> = {
  POSTED: styles.statusActive ?? "",
  PARTIALLY_PAID: styles.statusActive ?? "",
  PAID: styles.statusActive ?? "",
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

export const PurchaseInvoices = () => {
  const navigate = useNavigate();
  const dialog = useDialog();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const statusChip = (searchParams.get("status") ?? "all") as "all" | PiStatus;
  const setStatusChip = (s: "all" | PiStatus) => {
    const next = new URLSearchParams(searchParams);
    if (s === "all") next.delete("status");
    else next.set("status", s);
    setSearchParams(next, { replace: true });
  };

  const { data, isLoading, error } = usePurchaseInvoices();
  const cancelPi = useCancelPurchaseInvoice();

  const rows = useMemo<PiRow[]>(() => {
    const all = data ?? [];
    return statusChip === "all" ? all : all.filter((p) => p.status === statusChip);
  }, [data, statusChip]);

  const doCancelPi = async (p: PiRow) => {
    if (!(await dialog.confirm(`Cancel invoice ${p.invoice_number}? This sets status to CANCELLED — line items stay for audit.`))) return;
    cancelPi.mutate(p.id, {
      onError: (e) => toast.error(`Cancel failed: ${e instanceof Error ? e.message : String(e)}`),
    });
  };

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div>
          <h1 className={styles.title}>Purchase Invoices</h1>
        </div>
        <div style={{ display: "flex", gap: "var(--space-2)" }}>
          <Button variant="ghost" onClick={() => navigate("/purchase-invoices/from-grn")}>
            <ArrowRightLeft {...ICON} />
            <span>From Goods Receipt</span>
          </Button>
          <Button variant="primary" onClick={() => navigate("/purchase-invoices/new")}>
            <Plus {...ICON} />
            <span>New Purchase Invoice</span>
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

      <p className={styles.eyebrow}>{isLoading ? "Loading invoices…" : `${rows.length} purchase invoices`}</p>

      {error && !isLoading && (
        <div className={styles.bannerWarn}>
          <strong>Failed to load purchase invoices.</strong> {error instanceof Error ? error.message : String(error)}
        </div>
      )}

      <div className={styles.tableCard}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Invoice No.</th>
              <th>Supplier</th>
              <th>Transfer From (GRN/PO)</th>
              <th>Invoice Date</th>
              <th>Due Date</th>
              <th style={{ textAlign: "right" }}>Total</th>
              <th>Status</th>
              <th style={{ textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !isLoading ? (
              <tr>
                <td colSpan={8}>
                  <p className={styles.emptyRow}>No invoices yet — convert a Goods Receipt via "From Goods Receipt".</p>
                </td>
              </tr>
            ) : (
              rows.map((p) => (
                <tr key={p.id} onClick={() => navigate(`/purchase-invoices/${p.id}`)} style={p.status === "CANCELLED" ? { opacity: 0.55 } : undefined}>
                  <td>
                    <span className={styles.codeChip}>{p.invoice_number}</span>
                  </td>
                  <td>{p.supplier?.name ?? p.supplier?.code ?? "—"}</td>
                  <td>
                    <span style={{ fontFamily: "var(--font-mono)", fontWeight: 700, color: "var(--c-burnt)" }}>
                      {p.grn?.grn_number ?? p.purchase_order?.po_number ?? "—"}
                    </span>
                  </td>
                  <td>{fmtDateOrDash(p.invoice_date)}</td>
                  <td>{fmtDateOrDash(p.due_date)}</td>
                  <td style={{ textAlign: "right" }}>
                    <span style={{ fontWeight: 700, color: "var(--c-burnt)" }}>{fmtMoney(Number(p.total_centi ?? 0), p.currency)}</span>
                  </td>
                  <td>
                    <span className={`${styles.statusPill} ${STATUS_CLASS[p.status]}`}>{STATUS_LABEL[p.status] ?? p.status}</span>
                  </td>
                  <td style={{ textAlign: "right" }} onClick={(e) => e.stopPropagation()}>
                    {p.status !== "CANCELLED" && (p.paid_centi ?? 0) === 0 && (
                      <Button variant="ghost" onClick={() => doCancelPi(p)} disabled={cancelPi.isPending}>
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
