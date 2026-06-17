// ----------------------------------------------------------------------------
// PurchaseConsignmentReturnDetail — PC Return detail at
// /purchase-consignment-returns/:id. 1:1 clone of 2990s
// apps/backend/src/pages/PurchaseConsignmentReturnDetail.tsx (header + line table +
// Complete-with-CN / Cancel). Cancel reverses the inventory OUT (stock back in).
// SEAM playbook: ./consignment-purchase-queries; in-app useDialog/useToast (rule
// #10). window.prompt left as-is (no Houzs prompt equivalent — same as PI/PR).
// ----------------------------------------------------------------------------

import { useParams, Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { Button } from "../../components/Button";
import { usePcReturnDetail, useCancelPcReturn, useCompletePcReturn } from "./consignment-purchase-queries";
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

export const PurchaseConsignmentReturnDetail = () => {
  const { id = "" } = useParams();
  const dialog = useDialog();
  const toast = useToast();
  const { data, isLoading, error } = usePcReturnDetail(id);
  const cancelPct = useCancelPcReturn();
  const completePct = useCompletePcReturn();

  if (isLoading) return <div className={styles.page}><p className={styles.emptyRow}>Loading return…</p></div>;
  if (error || !data) return <div className={styles.page}><div className={styles.bannerWarn}><strong>Failed to load return.</strong> {error instanceof Error ? error.message : "Not found"}</div></div>;

  const { purchaseReturn: h, items } = data;

  const doCancel = async () => {
    if (!(await dialog.confirm(`Cancel return ${h.return_number}? This reverses the return — the goods are put back into stock.`))) return;
    cancelPct.mutate(h.id, { onError: (e) => toast.error(`Cancel failed: ${e instanceof Error ? e.message : String(e)}`) });
  };
  const doComplete = async () => {
    const ref = (await dialog.prompt("Supplier credit-note ref (optional):")) ?? undefined;
    completePct.mutate(
      { id: h.id, creditNoteRef: ref || undefined },
      {
        onSuccess: () => toast.success(`Completed ${h.return_number}`),
        onError: (e) => toast.error(`Complete failed: ${e instanceof Error ? e.message : String(e)}`),
      },
    );
  };

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div className={styles.titleBlock}>
          <Link to="/purchase-consignment-returns" className={styles.backBtn}>
            <ArrowLeft {...ICON} />
            <span>Back</span>
          </Link>
          <div>
            <h1 className={styles.title}>{h.return_number}</h1>
            <p className={styles.subtitle}>{h.supplier?.name ?? h.supplier?.code ?? "—"} · {h.status}</p>
          </div>
        </div>
        <div className={styles.actions}>
          {h.status === "POSTED" && (
            <>
              <Button variant="ghost" onClick={doComplete} disabled={completePct.isPending}>Complete</Button>
              <Button variant="ghost" onClick={doCancel} disabled={cancelPct.isPending}>Cancel</Button>
            </>
          )}
        </div>
      </div>

      <section className={styles.card}>
        <header className={styles.cardHeader}><h2 className={styles.cardTitle}>Return</h2></header>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <Field label="Source Receive" value={h.pc_receive?.receive_number ?? "—"} />
            <Field label="Source PC Order" value={h.purchase_consignment_order?.pc_number ?? "—"} />
            <Field label="Return Date" value={fmtDate(h.return_date)} />
            <Field label="Refund" value={fmtRm(h.refund_centi)} />
            <Field label="Reason" value={h.reason ?? "—"} span={2} />
            <Field label="Credit Note ref" value={h.credit_note_ref ?? "—"} span={2} />
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
              <th className={styles.tableRight}>Qty Returned</th>
              <th className={styles.tableRight}>Unit Price</th>
              <th className={styles.tableRight}>Line Refund</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr><td colSpan={6}><p className={styles.emptyRow}>No line items.</p></td></tr>
            ) : (
              items.map((it) => (
                <tr key={it.id}>
                  <td><span style={{ fontFamily: "var(--font-mono)" }}>{it.material_code}</span></td>
                  <td>{it.description ?? it.material_name}</td>
                  <td className={styles.tableRight}>{it.qty_returned}</td>
                  <td className={styles.tableRight}>{fmtRm(it.unit_price_centi)}</td>
                  <td className={styles.priceCell}>{fmtRm(it.line_refund_centi)}</td>
                  <td>{it.reason ?? "—"}</td>
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
