// ----------------------------------------------------------------------------
// ConsignmentNoteFromOrder — CO LINE -> Consignment Note picker at
// /consignment-notes/from-order. Houzs-style clone of 2990s
// ConsignmentNoteFromOrder.tsx (a DeliveryOrderFromSo clone). Tick CO lines (each
// capped at OUTSTANDING = ordered − delivered), of ONE customer, then Create
// combines them into ONE Consignment Note — which ships the stock OUT (CS_DO).
// SEAM (rule #9 + #10): <table> + PurchaseOrderDetail.module.css; useToast.
// ----------------------------------------------------------------------------

import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, Check, X, CheckSquare, Square } from "lucide-react";
import { Button } from "../../components/Button";
import { useDeliverableCoLines, useCreateConsignmentNoteFromOrders, type DeliverableCoLine } from "./consignment-sales-queries";
import { useToast } from "../../hooks/useToast";
import styles from "./PurchaseOrderDetail.module.css";

const ICON = { size: 16, strokeWidth: 1.75 } as const;
const fmtRm = (centi: number): string => `MYR ${(centi / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const custKey = (l: DeliverableCoLine): string => (l.debtorCode && l.debtorCode.trim() ? `code:${l.debtorCode.trim().toUpperCase()}` : `name:${(l.debtorName ?? "").trim().toUpperCase()}`);

export const ConsignmentNoteFromOrder = () => {
  const navigate = useNavigate();
  const toast = useToast();
  const linesQ = useDeliverableCoLines();
  const createNote = useCreateConsignmentNoteFromOrders();

  const [picks, setPicks] = useState<Record<string, { picked: boolean; qty: number }>>({});
  const lines = useMemo(() => linesQ.data ?? [], [linesQ.data]);

  const grouped = useMemo(() => {
    const byDoc = new Map<string, { meta: DeliverableCoLine; lines: DeliverableCoLine[] }>();
    for (const l of lines) { const cur = byDoc.get(l.orderDocNo); if (cur) cur.lines.push(l); else byDoc.set(l.orderDocNo, { meta: l, lines: [l] }); }
    return [...byDoc.entries()].map(([orderDocNo, { meta, lines }]) => ({ orderDocNo, meta, lines }));
  }, [lines]);

  const activeCustomer = useMemo(() => { for (const l of lines) { const p = picks[l.orderItemId]; if (p?.picked && p.qty > 0) return custKey(l); } return null; }, [picks, lines]);

  const togglePick = (l: DeliverableCoLine) => {
    if (activeCustomer && activeCustomer !== custKey(l)) return;
    setPicks((s) => ({ ...s, [l.orderItemId]: s[l.orderItemId]?.picked ? { picked: false, qty: 0 } : { picked: true, qty: s[l.orderItemId]?.qty || l.outstanding } }));
  };
  const setQty = (l: DeliverableCoLine, qty: number) => setPicks((s) => ({ ...s, [l.orderItemId]: { picked: true, qty } }));
  const clearAll = () => setPicks({});

  const picked = Object.entries(picks).filter(([, v]) => v.picked && v.qty > 0);
  const pickedCount = picked.length;

  const onCreate = () => {
    if (pickedCount === 0) { toast.error("Tick at least one line first."); return; }
    createNote.mutate({ picks: picked.map(([orderItemId, v]) => ({ orderItemId, qty: v.qty })) }, {
      onSuccess: (r) => { toast.success(`Consignment note ${r.doNumber} created — stock shipped.`); navigate(`/consignment-notes/${r.id}`); },
      onError: (e) => toast.error(`Create failed: ${e instanceof Error ? e.message : String(e)}`),
    });
  };

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div className={styles.titleBlock}>
          <Link to="/consignment-notes" className={styles.backBtn}><ArrowLeft {...ICON} /><span>Consignment Notes</span></Link>
          <div><h1 className={styles.title}>Ship Consignment Order lines</h1></div>
        </div>
        <div className={styles.actions}>
          <Button variant="ghost" onClick={() => navigate("/consignment-notes")}><X {...ICON} /><span>Cancel</span></Button>
          <Button variant="primary" onClick={onCreate} disabled={pickedCount === 0 || createNote.isPending}><Check {...ICON} /><span>{pickedCount === 0 ? "Pick at least 1 line" : `Create note from ${pickedCount} line${pickedCount === 1 ? "" : "s"}`}</span></Button>
        </div>
      </div>

      <p className={styles.eyebrow}>{linesQ.isLoading ? "Loading deliverable CO lines…" : lines.length === 0 ? "No deliverable lines — every Consignment Order line has been fully shipped." : `${lines.length} line${lines.length === 1 ? "" : "s"} across ${grouped.length} CO${grouped.length === 1 ? "" : "s"}${activeCustomer ? " · locked to one customer" : ""}`}</p>

      {linesQ.error && !linesQ.isLoading && (<div className={styles.bannerWarn}><strong>Failed to load deliverable CO lines.</strong> {linesQ.error instanceof Error ? linesQ.error.message : String(linesQ.error)}</div>)}

      {Object.keys(picks).length > 0 && (<div style={{ margin: "var(--space-2) 0" }}><Button variant="ghost" onClick={clearAll}><X {...ICON} /><span>Clear picks</span></Button></div>)}

      {grouped.length === 0 && !linesQ.isLoading ? (
        <section className={styles.card}><div className={styles.cardBody}><p className={styles.emptyRow}>Create a Consignment Order, then its lines show up here to ship.</p></div></section>
      ) : (
        grouped.map(({ orderDocNo, meta, lines }) => {
          const locked = Boolean(activeCustomer) && activeCustomer !== custKey(meta);
          return (
            <section key={orderDocNo} className={styles.card} style={{ opacity: locked ? 0.5 : 1 }}>
              <header className={styles.cardHeader}>
                <h2 className={styles.cardTitle}><span style={{ fontFamily: "var(--font-mono)", color: "var(--c-burnt)" }}>{orderDocNo}</span><span style={{ fontSize: "var(--fs-12)", color: "var(--fg-muted)", fontWeight: 400, marginLeft: 12 }}>{meta.debtorName ?? meta.debtorCode ?? "—"}</span></h2>
                {locked && <span style={{ fontSize: "var(--fs-12)", color: "var(--fg-soft)", fontStyle: "italic" }}>Clear your picks to ship this customer instead</span>}
              </header>
              <table className={styles.table}>
                <thead><tr><th style={{ width: 40 }} /><th>Item Code</th><th>Description</th><th className={styles.tableRight}>Outstanding</th><th className={styles.tableRight}>Ship Qty</th><th className={styles.tableRight}>Line Value</th></tr></thead>
                <tbody>
                  {lines.map((l) => {
                    const p = picks[l.orderItemId];
                    const on = Boolean(p?.picked);
                    const pickQty = on ? p!.qty : l.outstanding;
                    return (
                      <tr key={l.orderItemId} style={{ background: on ? "rgba(232, 107, 58, 0.08)" : undefined }}>
                        <td onClick={(e) => e.stopPropagation()}><button type="button" className={styles.iconBtn} disabled={locked} onClick={() => togglePick(l)} title={on ? "Unpick" : "Pick"}>{on ? <CheckSquare {...ICON} /> : <Square {...ICON} />}</button></td>
                        <td style={{ fontFamily: "var(--font-mono)" }}>{l.itemCode}</td>
                        <td>{l.description ?? "—"}</td>
                        <td className={styles.tableRight}>{l.outstanding}</td>
                        <td className={styles.tableRight} onClick={(e) => e.stopPropagation()}><input type="number" min={0} max={l.outstanding} className={styles.fieldInput} style={{ width: 80, textAlign: "right" }} value={on ? pickQty : ""} placeholder={String(l.outstanding)} disabled={!on || locked} onChange={(e) => setQty(l, Math.min(l.outstanding, Math.max(0, Number(e.target.value) || 0)))} /></td>
                        <td className={styles.priceCell}>{fmtRm(pickQty * l.unitPriceCenti - l.discountCenti)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>
          );
        })
      )}
    </div>
  );
};
