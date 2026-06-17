// ----------------------------------------------------------------------------
// PurchaseConsignmentReceiveDetail — PC Receive detail at
// /purchase-consignment-receives/:id. 1:1 clone of 2990s
// apps/backend/src/pages/PurchaseConsignmentReceiveDetail.tsx (header + line table
// with accepted/rejected/returned + downstream PR breakdown + Cancel). Cancel
// reverses the inventory IN; locked once any line has a downstream PC Return.
// SEAM playbook: ./consignment-purchase-queries; in-app useDialog/useToast (rule #10).
// ----------------------------------------------------------------------------

import { useParams, Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { Button } from "../../components/Button";
import { usePcReceiveDetail, useCancelPcReceive } from "./consignment-purchase-queries";
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

export const PurchaseConsignmentReceiveDetail = () => {
  const { id = "" } = useParams();
  const dialog = useDialog();
  const toast = useToast();
  const { data, isLoading, error } = usePcReceiveDetail(id);
  const cancelPcr = useCancelPcReceive();

  if (isLoading) return <div className={styles.page}><p className={styles.emptyRow}>Loading receive…</p></div>;
  if (error || !data) return <div className={styles.page}><div className={styles.bannerWarn}><strong>Failed to load receive.</strong> {error instanceof Error ? error.message : "Not found"}</div></div>;

  const { grn: h, items } = data;
  const locked = !!h.has_children;

  const doCancel = async () => {
    if (!(await dialog.confirm(`Cancel receive ${h.receive_number}? This reverses the stock-in — the consigned goods leave inventory again.`))) return;
    cancelPcr.mutate(h.id, { onError: (e) => toast.error(`Cancel failed: ${e instanceof Error ? e.message : String(e)}`) });
  };

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div className={styles.titleBlock}>
          <Link to="/purchase-consignment-receives" className={styles.backBtn}>
            <ArrowLeft {...ICON} />
            <span>Back</span>
          </Link>
          <div>
            <h1 className={styles.title}>{h.receive_number}</h1>
            <p className={styles.subtitle}>{h.supplier?.name ?? h.supplier?.code ?? "—"} · {h.status}</p>
          </div>
        </div>
        <div className={styles.actions}>
          {h.status === "POSTED" && !locked && (
            <Button variant="ghost" onClick={doCancel} disabled={cancelPcr.isPending}>Cancel</Button>
          )}
        </div>
      </div>

      {locked && (
        <div className={styles.bannerWarn}>This receive has a Consignment Return — it is read-only. Delete the return first to edit.</div>
      )}

      <section className={styles.card}>
        <header className={styles.cardHeader}><h2 className={styles.cardTitle}>Receive</h2></header>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <Field label="Source PC Order" value={h.purchase_consignment_order?.pc_number ?? h.pc_order_no ?? "—"} />
            <Field label="Received" value={fmtDate(h.received_at)} />
            <Field label="Supplier DO ref" value={h.delivery_note_ref ?? "—"} />
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
              <th className={styles.tableRight}>Received</th>
              <th className={styles.tableRight}>Accepted</th>
              <th className={styles.tableRight}>Rejected</th>
              <th className={styles.tableRight}>Returned</th>
              <th className={styles.tableRight}>Unit Price</th>
              <th>Returns</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr><td colSpan={8}><p className={styles.emptyRow}>No line items.</p></td></tr>
            ) : (
              items.map((it) => (
                <tr key={it.id}>
                  <td><span style={{ fontFamily: "var(--font-mono)" }}>{it.material_code}</span></td>
                  <td>{it.description ?? it.material_name}</td>
                  <td className={styles.tableRight}>{it.qty_received}</td>
                  <td className={styles.tableRight}>{it.qty_accepted}</td>
                  <td className={styles.tableRight}>{it.qty_rejected}</td>
                  <td className={styles.tableRight}>{it.returned_qty}</td>
                  <td className={styles.tableRight}>{fmtRm(it.unit_price_centi, h.currency)}</td>
                  <td>{(it.downstream ?? []).length === 0 ? "—" : (it.downstream ?? []).map((d) => `${d.docNumber} (${d.qty})`).join(", ")}</td>
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
