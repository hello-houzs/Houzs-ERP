// ----------------------------------------------------------------------------
// PurchaseConsignmentOrderDetail — PC Order detail at
// /purchase-consignment-orders/:id. 1:1 clone of 2990s
// apps/backend/src/pages/PurchaseConsignmentOrderDetail.tsx (header summary + line
// table + per-line receipts + Cancel/Delete). Child-locked once a non-cancelled
// PC Receive exists. SEAM playbook: ./consignment-purchase-queries; in-app
// useDialog/useToast (rule #10); react-router-dom.
// ----------------------------------------------------------------------------

import { useParams, useNavigate, Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { Button } from "../../components/Button";
import { usePcOrderDetail, useCancelPcOrder, useDeletePcOrder } from "./consignment-purchase-queries";
import { useDialog } from "../../hooks/useDialog";
import { useToast } from "../../hooks/useToast";
import styles from "./PurchaseOrderDetail.module.css";

const ICON = { size: 16, strokeWidth: 1.75 } as const;
const fmtRm = (centi: number | null | undefined, currency = "MYR"): string => `${currency} ${((centi ?? 0) / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : iso;
};

export const PurchaseConsignmentOrderDetail = () => {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const dialog = useDialog();
  const toast = useToast();
  const { data, isLoading, error } = usePcOrderDetail(id);
  const cancelPco = useCancelPcOrder();
  const deletePco = useDeletePcOrder();

  if (isLoading) return <div className={styles.page}><p className={styles.emptyRow}>Loading PC order…</p></div>;
  if (error || !data) return <div className={styles.page}><div className={styles.bannerWarn}><strong>Failed to load PC order.</strong> {error instanceof Error ? error.message : "Not found"}</div></div>;

  const { purchaseOrder: h, items } = data;
  const locked = !!h.has_children;

  const doCancel = async () => {
    if (!(await dialog.confirm(`Cancel PC Order ${h.pc_number}?`))) return;
    cancelPco.mutate(h.id, { onError: (e) => toast.error(`Cancel failed: ${e instanceof Error ? e.message : String(e)}`) });
  };
  const doDelete = async () => {
    if (!(await dialog.confirm(`Delete PC Order ${h.pc_number}? This permanently removes it and its lines.`))) return;
    deletePco.mutate(h.id, {
      onSuccess: () => { toast.success(`Deleted ${h.pc_number}`); navigate("/purchase-consignment-orders"); },
      onError: (e) => toast.error(`Delete failed: ${e instanceof Error ? e.message : String(e)}`),
    });
  };

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div className={styles.titleBlock}>
          <Link to="/purchase-consignment-orders" className={styles.backBtn}>
            <ArrowLeft {...ICON} />
            <span>Back</span>
          </Link>
          <div>
            <h1 className={styles.title}>{h.pc_number}</h1>
            <p className={styles.subtitle}>{h.supplier?.name ?? h.supplier?.code ?? "—"} · {h.status}</p>
          </div>
        </div>
        <div className={styles.actions}>
          {h.status !== "CANCELLED" && h.status !== "RECEIVED" && !locked && (
            <Button variant="ghost" onClick={doCancel} disabled={cancelPco.isPending}>Cancel</Button>
          )}
          {h.status === "CANCELLED" && (
            <Button variant="ghost" onClick={doDelete} disabled={deletePco.isPending}>Delete</Button>
          )}
        </div>
      </div>

      {locked && (
        <div className={styles.bannerWarn}>This PC Order has a Consignment Receive — it is read-only. Cancel the receive first to edit.</div>
      )}

      <section className={styles.card}>
        <header className={styles.cardHeader}><h2 className={styles.cardTitle}>Order</h2></header>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <Field label="Order Date" value={fmtDate(h.po_date)} />
            <Field label="Expected" value={fmtDate(h.expected_at)} />
            <Field label="Currency" value={h.currency} />
            <Field label="Total" value={fmtRm(h.total_centi, h.currency)} />
            {h.notes && <Field label="Notes" value={h.notes} span={4} />}
          </div>
        </div>
      </section>

      <section className={styles.card}>
        <header className={styles.cardHeader}><h2 className={styles.cardTitle}>Line Items ({items.length})</h2></header>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Item Code</th>
              <th>Description</th>
              <th className={styles.tableRight}>Qty</th>
              <th className={styles.tableRight}>Received</th>
              <th className={styles.tableRight}>Unit Price</th>
              <th className={styles.tableRight}>Line Total</th>
              <th>Receipts</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr><td colSpan={7}><p className={styles.emptyRow}>No line items.</p></td></tr>
            ) : (
              items.map((it) => (
                <tr key={it.id}>
                  <td><span style={{ fontFamily: "var(--font-mono)" }}>{it.material_code}</span></td>
                  <td>{it.description ?? it.material_name}</td>
                  <td className={styles.tableRight}>{it.qty}</td>
                  <td className={styles.tableRight}>{it.received_qty}</td>
                  <td className={styles.tableRight}>{fmtRm(it.unit_price_centi, h.currency)}</td>
                  <td className={styles.priceCell}>{fmtRm(it.line_total_centi, h.currency)}</td>
                  <td>
                    {(it.receipts ?? []).length === 0 ? "—" : (it.receipts ?? []).map((r) => `${r.receiveNumber} (${r.qty})`).join(", ")}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
};

const Field = ({ label, value, span }: { label: string; value: string; span?: number }) => (
  <div className={styles.field} style={span ? { gridColumn: `span ${span}` } : undefined}>
    <span className={styles.fieldLabel}>{label}</span>
    <span style={{ fontSize: "var(--fs-14)" }}>{value}</span>
  </div>
);
