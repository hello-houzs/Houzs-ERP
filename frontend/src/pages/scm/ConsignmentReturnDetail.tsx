// ----------------------------------------------------------------------------
// ConsignmentReturnDetail — full-page route at /consignment-returns/:id. Houzs-
// style clone of 2990s ConsignmentReturnDetail.tsx (a DR-detail clone): header
// card, line items (View read-only incl. per-line Warehouse; Edit = inline
// qty(returned)/unit/condition/delete), and status transitions (RECEIVED ->
// INSPECTED -> REFUNDED / REJECTED / CREDIT_NOTED, plus Cancel which removes the
// returned stock again). Editable while not terminal. SEAM (rule #9 + #10):
// <table> + inline RM editor; useDialog/useToast.
// ----------------------------------------------------------------------------

import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, FileText, Pencil, Trash2, Save, Ban } from "lucide-react";
import { Button } from "../../components/Button";
import {
  useConsignmentReturnDetail,
  useUpdateConsignmentReturnStatus,
  useUpdateConsignmentReturnItem,
  useDeleteConsignmentReturnItem,
  type CrItemRow,
  type CrStatus,
} from "./consignment-sales-queries";
import { useDialog } from "../../hooks/useDialog";
import { useToast } from "../../hooks/useToast";
import styles from "./PurchaseOrderDetail.module.css";

const ICON = { size: 16, strokeWidth: 1.75 } as const;
const SM_ICON = { size: 14, strokeWidth: 1.75 } as const;
const CONDITIONS = ["NEW", "DAMAGED", "DEFECT"] as const;

const STATUS_LABEL: Record<CrStatus, string> = { PENDING: "Pending", RECEIVED: "Received", INSPECTED: "Inspected", REFUNDED: "Refunded", CREDIT_NOTED: "Credit Noted", REJECTED: "Rejected", CANCELLED: "Cancelled" };
const NEXT_STATUSES: Partial<Record<CrStatus, CrStatus[]>> = {
  RECEIVED: ["INSPECTED"],
  INSPECTED: ["REFUNDED", "CREDIT_NOTED", "REJECTED"],
};
// Terminal states lock line edits (mirrors the route's returnLineLock).
const TERMINAL = new Set<CrStatus>(["CANCELLED", "REFUNDED", "CREDIT_NOTED"]);

const fmtRm = (centi: number | null | undefined, currency = "MYR"): string => `${currency} ${((centi ?? 0) / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDateOrDash = (iso: string | null | undefined): string => { if (!iso) return "—"; const d = new Date(iso); if (!Number.isFinite(d.getTime())) return iso; return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }); };

type LineDraft = { qtyReturned: number; unitPriceCenti: number; condition: string };
const lineSnapshot = (it: CrItemRow): LineDraft => ({ qtyReturned: it.qty_returned, unitPriceCenti: it.unit_price_centi, condition: it.condition ?? "NEW" });

export const ConsignmentReturnDetail = () => {
  const { id } = useParams<{ id: string }>();
  const dialog = useDialog();
  const toast = useToast();
  const detail = useConsignmentReturnDetail(id ?? null);
  const setStatus = useUpdateConsignmentReturnStatus();
  const updateItem = useUpdateConsignmentReturnItem();
  const deleteItem = useDeleteConsignmentReturnItem();

  const cr = detail.data?.deliveryReturn ?? null;
  const items = detail.data?.items ?? [];

  const [searchParams] = useSearchParams();
  const [isEditing, setIsEditing] = useState(() => searchParams.get("edit") === "1");
  const [lineDrafts, setLineDrafts] = useState<Record<string, LineDraft>>({});
  const [savingDraft, setSavingDraft] = useState(false);

  const isLocked = cr ? TERMINAL.has(cr.status as CrStatus) : true;

  useEffect(() => { if (isLocked && isEditing) { setIsEditing(false); setLineDrafts({}); } }, [isLocked, isEditing]);

  if (detail.isLoading) return <div className={styles.page}><p className={styles.eyebrow}>Loading consignment return…</p></div>;
  if (detail.isError || !cr) {
    return (
      <div className={styles.page}>
        <Link to="/consignment-returns" className={styles.backBtn}><ArrowLeft {...ICON} /><span>Back</span></Link>
        <div className={styles.bannerWarn}><strong>Consignment return not found.</strong>{detail.error instanceof Error ? ` ${detail.error.message}` : null}</div>
      </div>
    );
  }

  const lineOf = (it: CrItemRow): LineDraft => lineDrafts[it.id] ?? lineSnapshot(it);
  const lineTotalOf = (it: CrItemRow): number => { if (!isEditing) return it.line_total_centi ?? 0; const d = lineOf(it); return d.qtyReturned * d.unitPriceCenti; };
  const totalRefund = items.reduce((s, it) => s + lineTotalOf(it), 0);
  const setLine = (it: CrItemRow, patch: Partial<LineDraft>) => setLineDrafts((prev) => ({ ...prev, [it.id]: { ...(prev[it.id] ?? lineSnapshot(it)), ...patch } }));

  const handleSave = async () => {
    if (savingDraft) return;
    setSavingDraft(true);
    try {
      for (const it of items) {
        const d = lineDrafts[it.id];
        if (!d) continue;
        if (d.qtyReturned !== it.qty_returned || d.unitPriceCenti !== it.unit_price_centi || d.condition !== (it.condition ?? "NEW")) {
          await updateItem.mutateAsync({ id: cr.id, itemId: it.id, qtyReturned: d.qtyReturned, unitPriceCenti: d.unitPriceCenti, condition: d.condition });
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

  const doStatus = (next: CrStatus) => setStatus.mutate({ id: cr.id, status: next }, { onError: (e) => toast.error(`Update failed: ${e instanceof Error ? e.message : String(e)}`) });
  const doCancel = async () => {
    if (!(await dialog.confirm(`Cancel return ${cr.return_number}? This reverses the return — the goods are removed from stock again. Line items stay for audit.`))) return;
    setStatus.mutate({ id: cr.id, status: "CANCELLED" }, { onError: (e) => toast.error(`Cancel failed: ${e instanceof Error ? e.message : String(e)}`) });
  };

  const nextSteps = NEXT_STATUSES[cr.status as CrStatus] ?? [];

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div className={styles.titleBlock}>
          <Link to="/consignment-returns" className={styles.backBtn}><ArrowLeft {...ICON} /><span>Back</span></Link>
          <div><h1 className={styles.title}><FileText size={14} strokeWidth={1.75} style={{ color: "var(--c-burnt)" }} />{cr.return_number} — {cr.debtor_name}</h1></div>
        </div>
        <div className={styles.actions}>
          <div className={styles.totalRail}><span className={styles.totalRailLabel}>Refund</span><span className={styles.totalRailValue}>{fmtRm(totalRefund, cr.currency)}</span></div>
          <span className={`${styles.statusPill} ${cr.status === "CANCELLED" || cr.status === "REJECTED" ? styles.statusCancelled ?? "" : styles.statusDelivered ?? ""}`}>{STATUS_LABEL[cr.status as CrStatus] ?? cr.status}</span>
          {nextSteps.map((s) => (<Button key={s} variant="ghost" onClick={() => doStatus(s)} disabled={setStatus.isPending}><span>Mark {STATUS_LABEL[s]}</span></Button>))}
          {cr.status !== "CANCELLED" && (<Button variant="ghost" onClick={doCancel} disabled={setStatus.isPending}><Ban {...ICON} /><span>{setStatus.isPending ? "Cancelling…" : "Cancel"}</span></Button>)}
          {!isEditing ? (
            <Button variant="primary" onClick={() => { setLineDrafts({}); setIsEditing(true); }} disabled={isLocked}><Pencil {...ICON} /><span>Edit</span></Button>
          ) : (
            <Button variant="primary" onClick={handleSave} disabled={savingDraft}><Save {...ICON} /><span>{savingDraft ? "Saving…" : "Save"}</span></Button>
          )}
        </div>
      </div>

      <section className={styles.card}>
        <header className={styles.cardHeader}><h2 className={styles.cardTitle}>Consignee · Source · Notes</h2></header>
        <div className={styles.cardBody}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "var(--space-3) var(--space-4)", fontFamily: "var(--font-sans)", fontSize: "var(--fs-13)" }}>
            <div style={{ gridColumn: "span 2" }}><InfoCell label="Consignee" value={cr.debtor_name} /></div>
            <InfoCell label="Source CN" value={cr.do_number as string | null} />
            <InfoCell label="Return Date" value={fmtDateOrDash(cr.return_date)} />
            <div style={{ gridColumn: "span 2" }}><InfoCell label="Reason" value={cr.reason as string | null} /></div>
            <div style={{ gridColumn: "span 2" }}><InfoCell label="Notes" value={cr.notes as string | null} /></div>
          </div>
        </div>
      </section>

      <section className={styles.card}>
        <header className={styles.cardHeader}><h2 className={styles.cardTitle}>Line Items ({items.length})</h2></header>
        {items.length === 0 ? (
          <div className={styles.cardBody}><p className={styles.emptyRow}>No items on this return.</p></div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Item</th>
                <th>Warehouse</th>
                <th>Condition</th>
                <th className={styles.tableRight}>Qty Returned</th>
                <th className={styles.tableRight}>Unit</th>
                <th className={styles.tableRight}>Refund</th>
                {isEditing && <th className={styles.tableRight}>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {items.map((it) => {
                const d = lineOf(it);
                const summary = it.description2 || it.description;
                return (
                  <tr key={it.id}>
                    <td><div className={styles.codeCell}>{it.item_code}</div>{summary ? <div className={styles.muted} style={{ fontSize: "var(--fs-11)" }}>{summary}</div> : null}</td>
                    <td className={styles.muted}>{it.warehouse_code ?? "—"}</td>
                    {isEditing ? (
                      <>
                        <td><select className={styles.fieldInput} style={{ width: 110 }} value={d.condition} disabled={isLocked} onChange={(e) => setLine(it, { condition: e.target.value })}>{CONDITIONS.map((c) => (<option key={c} value={c}>{c}</option>))}</select></td>
                        <td className={styles.tableRight}><input type="number" min={0} className={styles.fieldInput} style={{ width: 80, textAlign: "right" }} value={d.qtyReturned} disabled={isLocked} onChange={(e) => setLine(it, { qtyReturned: Number(e.target.value) || 0 })} /></td>
                        <td className={styles.tableRight}><InlineRmInput valueCenti={d.unitPriceCenti} disabled={isLocked} onCommit={(centi) => setLine(it, { unitPriceCenti: centi })} style={{ width: 100 }} /></td>
                        <td className={styles.priceCell}>{fmtRm(d.qtyReturned * d.unitPriceCenti)}</td>
                        <td className={styles.tableRight}>
                          <button type="button" className={`${styles.iconBtn} ${styles.iconBtnDanger}`} title="Remove line" disabled={isLocked || deleteItem.isPending}
                            onClick={async () => { if (isLocked) return; if (await dialog.confirm("Remove this line? Its returned stock is taken back out.")) deleteItem.mutate({ id: cr.id, itemId: it.id }, { onError: (e) => toast.error(`Remove failed: ${e instanceof Error ? e.message : String(e)}`) }); }}>
                            <Trash2 {...SM_ICON} />
                          </button>
                        </td>
                      </>
                    ) : (
                      <>
                        <td>{it.condition ?? "—"}</td>
                        <td className={styles.tableRight}>{it.qty_returned}</td>
                        <td className={styles.tableRight}>{fmtRm(it.unit_price_centi)}</td>
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

      <section className={styles.card}>
        <header className={styles.cardHeader}><h2 className={styles.cardTitle}>Totals</h2></header>
        <div className={styles.cardBody}>
          <div className={styles.totalsGrid}>
            <div className={`${styles.totalRow} ${styles.grandTotalRow}`}><span className={styles.totalLabel}>Total Refund</span><span className={`${styles.totalValue} ${styles.grandTotal}`}>{fmtRm(totalRefund, cr.currency)}</span></div>
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
