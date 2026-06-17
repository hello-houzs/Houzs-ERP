// ----------------------------------------------------------------------------
// DeliveryOrderDetail — full-page route at /delivery-orders/:id.
//
// 1:1 clone of 2990s apps/backend/src/pages/DeliveryOrderDetail.tsx (a SO-detail
// clone): header card, line items (View read-only incl. per-line Warehouse +
// downstream; Edit = inline qty/unit/price/delete), payments ledger, status
// transitions (DISPATCHED -> ... -> DELIVERED), and Cancel (reverses the stock
// OUT). A DO locks once it has a non-cancelled SI/DR (has_children) — line CRUD
// + Cancel are blocked then. SEAM (rule #9 + #10): DataGrid/MoneyInput ->
// <table> + inline RM editor; useDialog/useToast (never window.confirm/alert).
// ----------------------------------------------------------------------------

import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, FileText, Pencil, Trash2, Save, Ban, Truck } from "lucide-react";
import { Button } from "../../components/Button";
import {
  useDeliveryOrderDetail,
  useDeliveryOrderPayments,
  useUpdateDeliveryOrderStatus,
  useUpdateDeliveryOrderItem,
  useDeleteDeliveryOrderItem,
  type DoItemRow,
  type DoRow,
  type DoStatus,
} from "./delivery-billing-queries";
import { useDialog } from "../../hooks/useDialog";
import { useToast } from "../../hooks/useToast";
import styles from "./PurchaseOrderDetail.module.css";

const ICON = { size: 16, strokeWidth: 1.75 } as const;
const SM_ICON = { size: 14, strokeWidth: 1.75 } as const;

const STATUS_LABEL: Record<DoStatus, string> = {
  LOADED: "Loaded", DISPATCHED: "Dispatched", IN_TRANSIT: "In Transit", SIGNED: "Signed", DELIVERED: "Delivered", INVOICED: "Invoiced", CANCELLED: "Cancelled",
};
// The forward state machine the operator can step through.
const NEXT_STATUS: Partial<Record<DoStatus, DoStatus>> = { DISPATCHED: "IN_TRANSIT", IN_TRANSIT: "SIGNED", SIGNED: "DELIVERED" };

const fmtRm = (centi: number | null | undefined, currency = "MYR"): string => `${currency} ${((centi ?? 0) / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDateOrDash = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
};

type LineDraft = { qty: number; unitPriceCenti: number; discountCenti: number };
const lineSnapshot = (it: DoItemRow): LineDraft => ({ qty: it.qty, unitPriceCenti: it.unit_price_centi, discountCenti: it.discount_centi });

export const DeliveryOrderDetail = () => {
  const { id } = useParams<{ id: string }>();
  const dialog = useDialog();
  const toast = useToast();
  const detail = useDeliveryOrderDetail(id ?? null);
  const setStatus = useUpdateDeliveryOrderStatus();
  const updateItem = useUpdateDeliveryOrderItem();
  const deleteItem = useDeleteDeliveryOrderItem();

  const dord = detail.data?.deliveryOrder ?? null;
  const items = detail.data?.items ?? [];

  const [searchParams] = useSearchParams();
  const [isEditing, setIsEditing] = useState(() => searchParams.get("edit") === "1");
  const [lineDrafts, setLineDrafts] = useState<Record<string, LineDraft>>({});
  const [savingDraft, setSavingDraft] = useState(false);

  // A DO locks once it has a non-cancelled SI/DR, or once cancelled.
  const isLocked = dord ? dord.status === "CANCELLED" || Boolean(dord.has_children) : true;

  useEffect(() => {
    if (isLocked && isEditing) { setIsEditing(false); setLineDrafts({}); }
  }, [isLocked, isEditing]);

  if (detail.isLoading) return <div className={styles.page}><p className={styles.eyebrow}>Loading delivery order…</p></div>;
  if (detail.isError || !dord) {
    return (
      <div className={styles.page}>
        <Link to="/delivery-orders" className={styles.backBtn}><ArrowLeft {...ICON} /><span>Back</span></Link>
        <div className={styles.bannerWarn}><strong>Delivery order not found.</strong>{detail.error instanceof Error ? ` ${detail.error.message}` : null}</div>
      </div>
    );
  }

  const lineOf = (it: DoItemRow): LineDraft => lineDrafts[it.id] ?? lineSnapshot(it);
  const lineTotalOf = (it: DoItemRow): number => { if (!isEditing) return it.line_total_centi ?? 0; const d = lineOf(it); return d.qty * d.unitPriceCenti - d.discountCenti; };
  const totalValue = items.reduce((s, it) => s + lineTotalOf(it), 0);
  const setLine = (it: DoItemRow, patch: Partial<LineDraft>) => setLineDrafts((prev) => ({ ...prev, [it.id]: { ...(prev[it.id] ?? lineSnapshot(it)), ...patch } }));

  const handleSave = async () => {
    if (savingDraft) return;
    setSavingDraft(true);
    try {
      for (const it of items) {
        const d = lineDrafts[it.id];
        if (!d) continue;
        if (d.qty !== it.qty || d.unitPriceCenti !== it.unit_price_centi || d.discountCenti !== it.discount_centi) {
          await updateItem.mutateAsync({ id: dord.id, itemId: it.id, qty: d.qty, unitPriceCenti: d.unitPriceCenti, discountCenti: d.discountCenti });
        }
      }
      setIsEditing(false);
      setLineDrafts({});
    } catch (e) {
      toast.error(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSavingDraft(false);
    }
  };

  const doAdvance = async () => {
    const next = NEXT_STATUS[dord.status];
    if (!next) return;
    setStatus.mutate({ id: dord.id, status: next }, { onError: (e) => toast.error(`Update failed: ${e instanceof Error ? e.message : String(e)}`) });
  };

  const doCancel = async () => {
    if (!(await dialog.confirm(`Cancel delivery order ${dord.do_number}? This returns the shipped stock to the shelf and releases the Sales Order. Line items stay for audit.`))) return;
    setStatus.mutate({ id: dord.id, status: "CANCELLED" }, { onError: (e) => toast.error(`Cancel failed: ${e instanceof Error ? e.message : String(e)}`) });
  };

  const next = NEXT_STATUS[dord.status];

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div className={styles.titleBlock}>
          <Link to="/delivery-orders" className={styles.backBtn}><ArrowLeft {...ICON} /><span>Back</span></Link>
          <div><h1 className={styles.title}><FileText size={14} strokeWidth={1.75} style={{ color: "var(--c-burnt)" }} />{dord.do_number} — {dord.debtor_name}</h1></div>
        </div>
        <div className={styles.actions}>
          <div className={styles.totalRail}><span className={styles.totalRailLabel}>Total</span><span className={styles.totalRailValue}>{fmtRm(totalValue, dord.currency)}</span></div>
          <span className={`${styles.statusPill} ${dord.status === "CANCELLED" ? styles.statusCancelled ?? "" : styles.statusDelivered ?? ""}`}>{STATUS_LABEL[dord.status] ?? dord.status}</span>
          {next && dord.status !== "CANCELLED" && (
            <Button variant="ghost" onClick={doAdvance} disabled={setStatus.isPending}><Truck {...ICON} /><span>Mark {STATUS_LABEL[next]}</span></Button>
          )}
          {dord.status !== "CANCELLED" && !dord.has_children && (
            <Button variant="ghost" onClick={doCancel} disabled={setStatus.isPending}><Ban {...ICON} /><span>{setStatus.isPending ? "Cancelling…" : "Cancel"}</span></Button>
          )}
          {!isEditing ? (
            <Button variant="primary" onClick={() => { setLineDrafts({}); setIsEditing(true); }} disabled={isLocked}><Pencil {...ICON} /><span>Edit</span></Button>
          ) : (
            <Button variant="primary" onClick={handleSave} disabled={savingDraft}><Save {...ICON} /><span>{savingDraft ? "Saving…" : "Save"}</span></Button>
          )}
        </div>
      </div>

      {dord.has_children && (
        <div className={styles.bannerInfo ?? styles.bannerWarn}>This delivery order has a Sales Invoice / Delivery Return — line edits and cancellation are locked. Cancel the downstream document first.</div>
      )}

      {/* Header card */}
      <section className={styles.card}>
        <header className={styles.cardHeader}><h2 className={styles.cardTitle}>Customer · Dates · Delivery</h2></header>
        <div className={styles.cardBody}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "var(--space-3) var(--space-4)", fontFamily: "var(--font-sans)", fontSize: "var(--fs-13)" }}>
            <div style={{ gridColumn: "span 2" }}><InfoCell label="Customer" value={dord.debtor_name} /></div>
            <InfoCell label="Sales Order" value={dord.so_doc_no} />
            <InfoCell label="DO Date" value={fmtDateOrDash(dord.do_date)} />
            <InfoCell label="Expected Delivery" value={fmtDateOrDash(dord.expected_delivery_at)} />
            <InfoCell label="Driver" value={dord.driver_name} />
            <InfoCell label="Vehicle" value={dord.vehicle} />
            <InfoCell label="Phone" value={dord.phone} />
            <div style={{ gridColumn: "span 2" }}><InfoCell label="Ref" value={dord.ref} /></div>
            <div style={{ gridColumn: "span 2" }}><InfoCell label="Notes" value={dord.notes} /></div>
          </div>
        </div>
      </section>

      {/* Line items */}
      <section className={styles.card}>
        <header className={styles.cardHeader}><h2 className={styles.cardTitle}>Line Items ({items.length})</h2></header>
        {items.length === 0 ? (
          <div className={styles.cardBody}><p className={styles.emptyRow}>No items on this delivery order.</p></div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Item</th>
                <th>Warehouse</th>
                <th>Transfer To</th>
                <th className={styles.tableRight}>Qty</th>
                <th className={styles.tableRight}>Unit</th>
                <th className={styles.tableRight}>Disc</th>
                <th className={styles.tableRight}>Line Total</th>
                {isEditing && <th className={styles.tableRight}>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {items.map((it) => {
                const d = lineOf(it);
                const summary = it.description2 || it.description;
                const downstream = (it.downstream ?? []).map((x) => `${x.docNumber} (${x.qty})`).join(", ");
                return (
                  <tr key={it.id}>
                    <td>
                      <div className={styles.codeCell}>{it.item_code}</div>
                      {summary ? <div className={styles.muted} style={{ fontSize: "var(--fs-11)" }}>{summary}</div> : null}
                    </td>
                    <td className={styles.muted}>{it.warehouse_code ?? "—"}</td>
                    <td className={styles.muted}>{downstream || "—"}</td>
                    {isEditing ? (
                      <>
                        <td className={styles.tableRight}><input type="number" min={1} className={styles.fieldInput} style={{ width: 70, textAlign: "right" }} value={d.qty} disabled={isLocked} onChange={(e) => setLine(it, { qty: Number(e.target.value) || 0 })} /></td>
                        <td className={styles.tableRight}><InlineRmInput valueCenti={d.unitPriceCenti} disabled={isLocked} onCommit={(centi) => setLine(it, { unitPriceCenti: centi })} style={{ width: 100 }} /></td>
                        <td className={styles.tableRight}><InlineRmInput valueCenti={d.discountCenti} disabled={isLocked} onCommit={(centi) => setLine(it, { discountCenti: centi })} style={{ width: 90 }} /></td>
                        <td className={styles.priceCell}>{fmtRm(d.qty * d.unitPriceCenti - d.discountCenti)}</td>
                        <td className={styles.tableRight}>
                          <button type="button" className={`${styles.iconBtn} ${styles.iconBtnDanger}`} title="Remove line" disabled={isLocked || deleteItem.isPending}
                            onClick={async () => { if (isLocked) return; if (await dialog.confirm("Remove this line? The shipped stock for it is returned to the shelf.")) deleteItem.mutate({ id: dord.id, itemId: it.id }, { onError: (e) => toast.error(`Remove failed: ${e instanceof Error ? e.message : String(e)}`) }); }}>
                            <Trash2 {...SM_ICON} />
                          </button>
                        </td>
                      </>
                    ) : (
                      <>
                        <td className={styles.tableRight}>{it.qty}</td>
                        <td className={styles.tableRight}>{fmtRm(it.unit_price_centi)}</td>
                        <td className={styles.tableRight}>{fmtRm(it.discount_centi)}</td>
                        <td className={styles.priceCell}>{fmtRm(it.line_total_centi)}</td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <PaymentsPanel deliveryOrderId={dord.id} currency={dord.currency} />

      {/* Totals */}
      <section className={styles.card}>
        <header className={styles.cardHeader}><h2 className={styles.cardTitle}>Totals</h2></header>
        <div className={styles.cardBody}>
          <div className={styles.totalsGrid}>
            <div className={`${styles.totalRow} ${styles.grandTotalRow}`}><span className={styles.totalLabel}>Total</span><span className={`${styles.totalValue} ${styles.grandTotal}`}>{fmtRm(totalValue, dord.currency)}</span></div>
          </div>
        </div>
      </section>
    </div>
  );
};

/* Payments panel — read-only ledger (the DO carries a payments ledger; recording
   is on the SO/SI side in this flow). */
const PaymentsPanel = ({ deliveryOrderId, currency }: { deliveryOrderId: string; currency: string }) => {
  const payQ = useDeliveryOrderPayments(deliveryOrderId);
  const payments = payQ.data ?? [];
  if (payments.length === 0) return null;
  return (
    <section className={styles.card}>
      <header className={styles.cardHeader}><h2 className={styles.cardTitle}>Payments ({payments.length})</h2></header>
      <table className={styles.table}>
        <thead><tr><th>Date</th><th>Method</th><th>Account</th><th className={styles.tableRight}>Amount</th><th>By</th></tr></thead>
        <tbody>
          {payments.map((p) => (
            <tr key={p.id}>
              <td>{fmtDateOrDash(p.paid_at)}</td>
              <td>{p.method ?? "—"}</td>
              <td className={styles.muted}>{p.account_sheet ?? "—"}</td>
              <td className={styles.priceCell}>{fmtRm(p.amount_centi, currency)}</td>
              <td className={styles.muted}>{p.collected_by_name ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
};

const InlineRmInput = ({ valueCenti, onCommit, disabled, style }: { valueCenti: number; onCommit: (centi: number) => void; disabled?: boolean; style?: React.CSSProperties }) => {
  const toRm = (c: number) => (c ? (c / 100).toFixed(2) : "");
  const [draft, setDraft] = useState(toRm(valueCenti));
  const [committed, setCommitted] = useState(valueCenti);
  if (committed !== valueCenti) { setCommitted(valueCenti); setDraft(toRm(valueCenti)); }
  const commit = () => { const t = draft.trim(); const n = t === "" ? 0 : Number(t); const next = Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : valueCenti; onCommit(next); };
  return (
    <input className={styles.fieldInput} style={{ textAlign: "right", ...style }} value={draft} inputMode="decimal" disabled={disabled}
      onChange={(e) => setDraft(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); } if (e.key === "Escape") { setDraft(toRm(valueCenti)); (e.target as HTMLInputElement).blur(); } }} />
  );
};

function InfoCell({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <div style={{ fontSize: "var(--fs-11)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--fg-muted)", marginBottom: 2 }}>{label}</div>
      <div style={{ color: value ? "var(--fg)" : "var(--fg-muted)" }}>{value || "—"}</div>
    </div>
  );
}
