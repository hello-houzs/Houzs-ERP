// ----------------------------------------------------------------------------
// ConsignmentOrderDetail — full-page route at /consignment-orders/:docNo. Houzs-
// style clone of 2990s ConsignmentOrderDetail.tsx (an SO-detail clone, Strategy-2
// trimmed): header card, line items (View read-only incl. per-line Delivered
// breakdown; Edit = inline qty/unit/delete), status transitions, and Cancel
// (gated by has_children = a non-cancelled Consignment Note). The header IDENTITY
// fields lock once a Note exists (server-enforced). SEAM (rule #9 + #10): <table>
// + inline RM editor; useDialog/useToast. DROPPED the furniture configurator +
// the customer-credit / slip-upload surfaces (Strategy-2 / out of SCM scope).
// ----------------------------------------------------------------------------

import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, FileText, Pencil, Trash2, Save, Ban } from "lucide-react";
import { Button } from "../../components/Button";
import {
  useConsignmentOrderDetail,
  useUpdateConsignmentOrderStatus,
  useUpdateConsignmentOrderItem,
  useDeleteConsignmentOrderItem,
  type CoItemRow,
  type CoStatus,
} from "./consignment-sales-queries";
import { useDialog } from "../../hooks/useDialog";
import { useToast } from "../../hooks/useToast";
import styles from "./PurchaseOrderDetail.module.css";

const ICON = { size: 16, strokeWidth: 1.75 } as const;
const SM_ICON = { size: 14, strokeWidth: 1.75 } as const;

const STATUS_LABEL: Record<CoStatus, string> = {
  CONFIRMED: "Confirmed", IN_PRODUCTION: "In Production", READY_TO_SHIP: "Ready to Ship", SHIPPED: "Shipped",
  DELIVERED: "Delivered", INVOICED: "Invoiced", CLOSED: "Closed", ON_HOLD: "On Hold", CANCELLED: "Cancelled",
};
// Forward steps the operator can drive (the consignment lifecycle).
const NEXT_STATUSES: Partial<Record<CoStatus, CoStatus[]>> = {
  CONFIRMED: ["IN_PRODUCTION", "READY_TO_SHIP", "ON_HOLD"],
  IN_PRODUCTION: ["READY_TO_SHIP", "ON_HOLD"],
  READY_TO_SHIP: ["SHIPPED", "ON_HOLD"],
  SHIPPED: ["DELIVERED"],
  DELIVERED: ["INVOICED", "CLOSED"],
  INVOICED: ["CLOSED"],
  ON_HOLD: ["CONFIRMED"],
};

const fmtRm = (centi: number | null | undefined, currency = "MYR"): string => `${currency} ${((centi ?? 0) / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDateOrDash = (iso: string | null | undefined): string => { if (!iso) return "—"; const d = new Date(iso); if (!Number.isFinite(d.getTime())) return iso; return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }); };

type LineDraft = { qty: number; unitPriceCenti: number };
const lineSnapshot = (it: CoItemRow): LineDraft => ({ qty: it.qty, unitPriceCenti: it.unit_price_centi });

export const ConsignmentOrderDetail = () => {
  const { docNo } = useParams<{ docNo: string }>();
  const dialog = useDialog();
  const toast = useToast();
  const detail = useConsignmentOrderDetail(docNo ?? null);
  const setStatus = useUpdateConsignmentOrderStatus();
  const updateItem = useUpdateConsignmentOrderItem();
  const deleteItem = useDeleteConsignmentOrderItem();

  const co = detail.data?.salesOrder ?? null;
  const items = (detail.data?.items ?? []).filter((it) => !it.cancelled);

  const [searchParams] = useSearchParams();
  const [isEditing, setIsEditing] = useState(() => searchParams.get("edit") === "1");
  const [lineDrafts, setLineDrafts] = useState<Record<string, LineDraft>>({});
  const [savingDraft, setSavingDraft] = useState(false);

  const isLocked = co ? co.status === "CANCELLED" || Boolean(co.has_children) : true;

  useEffect(() => { if (isLocked && isEditing) { setIsEditing(false); setLineDrafts({}); } }, [isLocked, isEditing]);

  if (detail.isLoading) return <div className={styles.page}><p className={styles.eyebrow}>Loading consignment order…</p></div>;
  if (detail.isError || !co) {
    return (
      <div className={styles.page}>
        <Link to="/consignment-orders" className={styles.backBtn}><ArrowLeft {...ICON} /><span>Back</span></Link>
        <div className={styles.bannerWarn}><strong>Consignment order not found.</strong>{detail.error instanceof Error ? ` ${detail.error.message}` : null}</div>
      </div>
    );
  }

  const lineOf = (it: CoItemRow): LineDraft => lineDrafts[it.id] ?? lineSnapshot(it);
  const lineTotalOf = (it: CoItemRow): number => { if (!isEditing) return it.total_centi ?? 0; const d = lineOf(it); return d.qty * d.unitPriceCenti - it.discount_centi; };
  const total = items.reduce((s, it) => s + lineTotalOf(it), 0);
  const setLine = (it: CoItemRow, patch: Partial<LineDraft>) => setLineDrafts((prev) => ({ ...prev, [it.id]: { ...(prev[it.id] ?? lineSnapshot(it)), ...patch } }));

  const handleSave = async () => {
    if (savingDraft) return;
    setSavingDraft(true);
    try {
      for (const it of items) {
        const d = lineDrafts[it.id];
        if (!d) continue;
        if (d.qty !== it.qty || d.unitPriceCenti !== it.unit_price_centi) {
          await updateItem.mutateAsync({ docNo: co.doc_no, itemId: it.id, qty: d.qty, unitPriceCenti: d.unitPriceCenti });
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

  const doStatus = (next: CoStatus) => setStatus.mutate({ docNo: co.doc_no, status: next }, { onError: (e) => toast.error(`Update failed: ${e instanceof Error ? e.message : String(e)}`) });
  const doCancel = async () => {
    if (!(await dialog.confirm(`Cancel consignment order ${co.doc_no}?`))) return;
    setStatus.mutate({ docNo: co.doc_no, status: "CANCELLED" }, { onError: (e) => toast.error(`Cancel failed: ${e instanceof Error ? e.message : String(e)}`) });
  };

  const nextSteps = NEXT_STATUSES[co.status as CoStatus] ?? [];

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div className={styles.titleBlock}>
          <Link to="/consignment-orders" className={styles.backBtn}><ArrowLeft {...ICON} /><span>Back</span></Link>
          <div><h1 className={styles.title}><FileText size={14} strokeWidth={1.75} style={{ color: "var(--c-burnt)" }} />{co.doc_no} — {co.debtor_name}</h1></div>
        </div>
        <div className={styles.actions}>
          <div className={styles.totalRail}><span className={styles.totalRailLabel}>Total</span><span className={styles.totalRailValue}>{fmtRm(total, co.currency)}</span></div>
          <span className={`${styles.statusPill} ${co.status === "CANCELLED" ? styles.statusCancelled ?? "" : styles.statusDelivered ?? ""}`}>{STATUS_LABEL[co.status as CoStatus] ?? co.status}</span>
          {co.status !== "CANCELLED" && nextSteps.map((s) => (<Button key={s} variant="ghost" onClick={() => doStatus(s)} disabled={setStatus.isPending}><span>Mark {STATUS_LABEL[s]}</span></Button>))}
          {co.status !== "CANCELLED" && !co.has_children && (<Button variant="ghost" onClick={doCancel} disabled={setStatus.isPending}><Ban {...ICON} /><span>{setStatus.isPending ? "Cancelling…" : "Cancel"}</span></Button>)}
          {!isEditing ? (
            <Button variant="primary" onClick={() => { setLineDrafts({}); setIsEditing(true); }} disabled={isLocked}><Pencil {...ICON} /><span>Edit</span></Button>
          ) : (
            <Button variant="primary" onClick={handleSave} disabled={savingDraft}><Save {...ICON} /><span>{savingDraft ? "Saving…" : "Save"}</span></Button>
          )}
        </div>
      </div>

      {co.has_children && co.status !== "CANCELLED" && (
        <div className={styles.bannerWarn}>This consignment order has a Consignment Note — customer/value fields and lines are locked. Cancel the note first to edit.</div>
      )}

      <section className={styles.card}>
        <header className={styles.cardHeader}><h2 className={styles.cardTitle}>Customer · Schedule · Notes</h2></header>
        <div className={styles.cardBody}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "var(--space-3) var(--space-4)", fontFamily: "var(--font-sans)", fontSize: "var(--fs-13)" }}>
            <div style={{ gridColumn: "span 2" }}><InfoCell label="Customer" value={co.debtor_name} /></div>
            <InfoCell label="Phone" value={co.phone as string | null} />
            <InfoCell label="Order Date" value={fmtDateOrDash(co.so_date)} />
            <InfoCell label="Transfer To" value={co.transfer_to as string | null} />
            <InfoCell label="Agent" value={co.agent as string | null} />
            <InfoCell label="Delivery Date" value={fmtDateOrDash(co.customer_delivery_date as string | null)} />
            <InfoCell label="Processing Date" value={fmtDateOrDash(co.internal_expected_dd as string | null)} />
            <div style={{ gridColumn: "span 4" }}><InfoCell label="Note" value={co.note as string | null} /></div>
          </div>
        </div>
      </section>

      <section className={styles.card}>
        <header className={styles.cardHeader}><h2 className={styles.cardTitle}>Line Items ({items.length})</h2></header>
        {items.length === 0 ? (
          <div className={styles.cardBody}><p className={styles.emptyRow}>No items on this order.</p></div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Item</th>
                <th>Delivered</th>
                <th className={styles.tableRight}>Qty</th>
                <th className={styles.tableRight}>Unit</th>
                <th className={styles.tableRight}>Line Total</th>
                {isEditing && <th className={styles.tableRight}>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {items.map((it) => {
                const d = lineOf(it);
                const summary = it.description2 || it.description;
                const deliveredQty = (it.deliveries ?? []).reduce((s, x) => s + x.qty, 0);
                return (
                  <tr key={it.id}>
                    <td><div className={styles.codeCell}>{it.item_code}</div>{summary ? <div className={styles.muted} style={{ fontSize: "var(--fs-11)" }}>{summary}</div> : null}</td>
                    <td className={styles.muted}>
                      {deliveredQty > 0 ? (
                        <span title={(it.deliveries ?? []).map((x) => `${x.noNumber}: ${x.qty}`).join(", ")}>{deliveredQty} ({(it.deliveries ?? []).length} note{(it.deliveries ?? []).length === 1 ? "" : "s"})</span>
                      ) : "—"}
                    </td>
                    {isEditing ? (
                      <>
                        <td className={styles.tableRight}><input type="number" min={0} className={styles.fieldInput} style={{ width: 80, textAlign: "right" }} value={d.qty} disabled={isLocked} onChange={(e) => setLine(it, { qty: Number(e.target.value) || 0 })} /></td>
                        <td className={styles.tableRight}><InlineRmInput valueCenti={d.unitPriceCenti} disabled={isLocked} onCommit={(centi) => setLine(it, { unitPriceCenti: centi })} style={{ width: 100 }} /></td>
                        <td className={styles.priceCell}>{fmtRm(d.qty * d.unitPriceCenti - it.discount_centi)}</td>
                        <td className={styles.tableRight}>
                          <button type="button" className={`${styles.iconBtn} ${styles.iconBtnDanger}`} title="Remove line" disabled={isLocked || deleteItem.isPending}
                            onClick={async () => { if (isLocked) return; if (await dialog.confirm("Remove this line?")) deleteItem.mutate({ docNo: co.doc_no, itemId: it.id }, { onError: (e) => toast.error(`Remove failed: ${e instanceof Error ? e.message : String(e)}`) }); }}>
                            <Trash2 {...SM_ICON} />
                          </button>
                        </td>
                      </>
                    ) : (
                      <>
                        <td className={styles.tableRight}>{it.qty}</td>
                        <td className={styles.tableRight}>{fmtRm(it.unit_price_centi)}</td>
                        <td className={styles.priceCell}>{fmtRm(it.total_centi)}</td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className={styles.card}>
        <header className={styles.cardHeader}><h2 className={styles.cardTitle}>Totals</h2></header>
        <div className={styles.cardBody}>
          <div className={styles.totalsGrid}>
            <div className={`${styles.totalRow} ${styles.grandTotalRow}`}><span className={styles.totalLabel}>Total</span><span className={`${styles.totalValue} ${styles.grandTotal}`}>{fmtRm(total, co.currency)}</span></div>
          </div>
        </div>
      </section>
    </div>
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
