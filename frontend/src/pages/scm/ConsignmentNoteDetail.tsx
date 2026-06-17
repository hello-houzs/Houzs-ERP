// ----------------------------------------------------------------------------
// ConsignmentNoteDetail — full-page route at /consignment-notes/:id. Houzs-style
// clone of 2990s ConsignmentNoteDetail.tsx (a DO-detail clone): header card, line
// items (View read-only incl. per-line Warehouse; Edit = inline qty/unit/delete),
// and status transitions (DISPATCHED -> IN_TRANSIT -> SIGNED -> DELIVERED, plus
// Cancel which returns the shipped stock). Locked once a Consignment Return exists
// (has_children) or once CANCELLED. SEAM (rule #9 + #10): <table> + inline RM
// editor; useDialog/useToast.
// ----------------------------------------------------------------------------

import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, FileText, Pencil, Trash2, Save, Ban } from "lucide-react";
import { Button } from "../../components/Button";
import {
  useConsignmentNoteDetail,
  useUpdateConsignmentNoteStatus,
  useUpdateConsignmentNoteItem,
  useDeleteConsignmentNoteItem,
  type CnItemRow,
  type CnStatus,
} from "./consignment-sales-queries";
import { useDialog } from "../../hooks/useDialog";
import { useToast } from "../../hooks/useToast";
import styles from "./PurchaseOrderDetail.module.css";

const ICON = { size: 16, strokeWidth: 1.75 } as const;
const SM_ICON = { size: 14, strokeWidth: 1.75 } as const;

const STATUS_LABEL: Record<CnStatus, string> = { LOADED: "Loaded", DISPATCHED: "Dispatched", IN_TRANSIT: "In Transit", SIGNED: "Signed", DELIVERED: "Delivered", INVOICED: "Invoiced", CANCELLED: "Cancelled" };
const NEXT_STATUSES: Partial<Record<CnStatus, CnStatus[]>> = {
  LOADED: ["DISPATCHED"],
  DISPATCHED: ["IN_TRANSIT", "SIGNED", "DELIVERED"],
  IN_TRANSIT: ["SIGNED", "DELIVERED"],
  SIGNED: ["DELIVERED"],
};

const fmtRm = (centi: number | null | undefined, currency = "MYR"): string => `${currency} ${((centi ?? 0) / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDateOrDash = (iso: string | null | undefined): string => { if (!iso) return "—"; const d = new Date(iso); if (!Number.isFinite(d.getTime())) return iso; return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }); };

type LineDraft = { qty: number; unitPriceCenti: number };
const lineSnapshot = (it: CnItemRow): LineDraft => ({ qty: it.qty, unitPriceCenti: it.unit_price_centi });

export const ConsignmentNoteDetail = () => {
  const { id } = useParams<{ id: string }>();
  const dialog = useDialog();
  const toast = useToast();
  const detail = useConsignmentNoteDetail(id ?? null);
  const setStatus = useUpdateConsignmentNoteStatus();
  const updateItem = useUpdateConsignmentNoteItem();
  const deleteItem = useDeleteConsignmentNoteItem();

  const cn = detail.data?.deliveryOrder ?? null;
  const items = detail.data?.items ?? [];

  const [searchParams] = useSearchParams();
  const [isEditing, setIsEditing] = useState(() => searchParams.get("edit") === "1");
  const [lineDrafts, setLineDrafts] = useState<Record<string, LineDraft>>({});
  const [savingDraft, setSavingDraft] = useState(false);

  const isLocked = cn ? cn.status === "CANCELLED" || Boolean(cn.has_children) : true;

  useEffect(() => { if (isLocked && isEditing) { setIsEditing(false); setLineDrafts({}); } }, [isLocked, isEditing]);

  if (detail.isLoading) return <div className={styles.page}><p className={styles.eyebrow}>Loading consignment note…</p></div>;
  if (detail.isError || !cn) {
    return (
      <div className={styles.page}>
        <Link to="/consignment-notes" className={styles.backBtn}><ArrowLeft {...ICON} /><span>Back</span></Link>
        <div className={styles.bannerWarn}><strong>Consignment note not found.</strong>{detail.error instanceof Error ? ` ${detail.error.message}` : null}</div>
      </div>
    );
  }

  const lineOf = (it: CnItemRow): LineDraft => lineDrafts[it.id] ?? lineSnapshot(it);
  const lineTotalOf = (it: CnItemRow): number => { if (!isEditing) return it.line_total_centi ?? 0; const d = lineOf(it); return d.qty * d.unitPriceCenti; };
  const total = items.reduce((s, it) => s + lineTotalOf(it), 0);
  const setLine = (it: CnItemRow, patch: Partial<LineDraft>) => setLineDrafts((prev) => ({ ...prev, [it.id]: { ...(prev[it.id] ?? lineSnapshot(it)), ...patch } }));

  const handleSave = async () => {
    if (savingDraft) return;
    setSavingDraft(true);
    try {
      for (const it of items) {
        const d = lineDrafts[it.id];
        if (!d) continue;
        if (d.qty !== it.qty || d.unitPriceCenti !== it.unit_price_centi) {
          await updateItem.mutateAsync({ id: cn.id, itemId: it.id, qty: d.qty, unitPriceCenti: d.unitPriceCenti });
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

  const doStatus = (next: CnStatus) => setStatus.mutate({ id: cn.id, status: next }, { onError: (e) => toast.error(`Update failed: ${e instanceof Error ? e.message : String(e)}`) });
  const doCancel = async () => {
    if (!(await dialog.confirm(`Cancel consignment note ${cn.do_number}? This reverses the shipment — the goods return to stock. Line items stay for audit.`))) return;
    setStatus.mutate({ id: cn.id, status: "CANCELLED" }, { onError: (e) => toast.error(`Cancel failed: ${e instanceof Error ? e.message : String(e)}`) });
  };

  const nextSteps = NEXT_STATUSES[cn.status as CnStatus] ?? [];

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div className={styles.titleBlock}>
          <Link to="/consignment-notes" className={styles.backBtn}><ArrowLeft {...ICON} /><span>Back</span></Link>
          <div><h1 className={styles.title}><FileText size={14} strokeWidth={1.75} style={{ color: "var(--c-burnt)" }} />{cn.do_number} — {cn.debtor_name}</h1></div>
        </div>
        <div className={styles.actions}>
          <div className={styles.totalRail}><span className={styles.totalRailLabel}>Total</span><span className={styles.totalRailValue}>{fmtRm(total, cn.currency)}</span></div>
          <span className={`${styles.statusPill} ${cn.status === "CANCELLED" ? styles.statusCancelled ?? "" : styles.statusDelivered ?? ""}`}>{STATUS_LABEL[cn.status as CnStatus] ?? cn.status}</span>
          {!isLocked && nextSteps.map((s) => (<Button key={s} variant="ghost" onClick={() => doStatus(s)} disabled={setStatus.isPending}><span>Mark {STATUS_LABEL[s]}</span></Button>))}
          {cn.status !== "CANCELLED" && !cn.has_children && (<Button variant="ghost" onClick={doCancel} disabled={setStatus.isPending}><Ban {...ICON} /><span>{setStatus.isPending ? "Cancelling…" : "Cancel"}</span></Button>)}
          {!isEditing ? (
            <Button variant="primary" onClick={() => { setLineDrafts({}); setIsEditing(true); }} disabled={isLocked}><Pencil {...ICON} /><span>Edit</span></Button>
          ) : (
            <Button variant="primary" onClick={handleSave} disabled={savingDraft}><Save {...ICON} /><span>{savingDraft ? "Saving…" : "Save"}</span></Button>
          )}
        </div>
      </div>

      {cn.has_children && cn.status !== "CANCELLED" && (
        <div className={styles.bannerWarn}>This consignment note has a Consignment Return — it is locked. Cancel the return first to edit.</div>
      )}

      <section className={styles.card}>
        <header className={styles.cardHeader}><h2 className={styles.cardTitle}>Consignee · Source · Notes</h2></header>
        <div className={styles.cardBody}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "var(--space-3) var(--space-4)", fontFamily: "var(--font-sans)", fontSize: "var(--fs-13)" }}>
            <div style={{ gridColumn: "span 2" }}><InfoCell label="Consignee" value={cn.debtor_name} /></div>
            <InfoCell label="Consignment Order" value={cn.consignment_so_doc_no as string | null} />
            <InfoCell label="Note Date" value={fmtDateOrDash(cn.do_date)} />
            <div style={{ gridColumn: "span 2" }}><InfoCell label="Note" value={(cn.note as string | null) ?? (cn.notes as string | null)} /></div>
          </div>
        </div>
      </section>

      <section className={styles.card}>
        <header className={styles.cardHeader}><h2 className={styles.cardTitle}>Line Items ({items.length})</h2></header>
        {items.length === 0 ? (
          <div className={styles.cardBody}><p className={styles.emptyRow}>No items on this note.</p></div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Item</th>
                <th>Warehouse</th>
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
                return (
                  <tr key={it.id}>
                    <td><div className={styles.codeCell}>{it.item_code}</div>{summary ? <div className={styles.muted} style={{ fontSize: "var(--fs-11)" }}>{summary}</div> : null}</td>
                    <td className={styles.muted}>{it.warehouse_code ?? "—"}</td>
                    {isEditing ? (
                      <>
                        <td className={styles.tableRight}><input type="number" min={0} className={styles.fieldInput} style={{ width: 80, textAlign: "right" }} value={d.qty} disabled={isLocked} onChange={(e) => setLine(it, { qty: Number(e.target.value) || 0 })} /></td>
                        <td className={styles.tableRight}><InlineRmInput valueCenti={d.unitPriceCenti} disabled={isLocked} onCommit={(centi) => setLine(it, { unitPriceCenti: centi })} style={{ width: 100 }} /></td>
                        <td className={styles.priceCell}>{fmtRm(d.qty * d.unitPriceCenti)}</td>
                        <td className={styles.tableRight}>
                          <button type="button" className={`${styles.iconBtn} ${styles.iconBtnDanger}`} title="Remove line" disabled={isLocked || deleteItem.isPending}
                            onClick={async () => { if (isLocked) return; if (await dialog.confirm("Remove this line? Its shipped stock returns to the shelf.")) deleteItem.mutate({ id: cn.id, itemId: it.id }, { onError: (e) => toast.error(`Remove failed: ${e instanceof Error ? e.message : String(e)}`) }); }}>
                            <Trash2 {...SM_ICON} />
                          </button>
                        </td>
                      </>
                    ) : (
                      <>
                        <td className={styles.tableRight}>{it.qty}</td>
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
            <div className={`${styles.totalRow} ${styles.grandTotalRow}`}><span className={styles.totalLabel}>Total</span><span className={`${styles.totalValue} ${styles.grandTotal}`}>{fmtRm(total, cn.currency)}</span></div>
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
