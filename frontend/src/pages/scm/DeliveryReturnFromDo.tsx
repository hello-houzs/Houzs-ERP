// ----------------------------------------------------------------------------
// DeliveryReturnFromDo — DO LINE -> Delivery Return picker at
// /delivery-returns/from-do. 1:1 clone of 2990s DeliveryReturnFromDo.tsx. Tick DO
// lines (each capped at REMAINING = delivered − invoiced − returned, per-line
// condition), of ONE customer, then Create combines them into ONE return — which
// brings the stock back IN. SEAM (rule #9 + #10): DataGrid -> <table> +
// PurchaseOrderDetail.module.css; useToast.
// ----------------------------------------------------------------------------

import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, Check, X, CheckSquare, Square } from "lucide-react";
import { Button } from "../../components/Button";
import { useReturnableDoLines, useCreateDeliveryReturnFromDos, type ReturnableDoLine } from "./delivery-billing-queries";
import { useToast } from "../../hooks/useToast";
import styles from "./PurchaseOrderDetail.module.css";

const ICON = { size: 16, strokeWidth: 1.75 } as const;
const CONDITIONS = ["NEW", "DAMAGED", "DEFECT"] as const;
const fmtRm = (centi: number): string => `MYR ${(centi / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const custKey = (l: ReturnableDoLine): string => (l.debtorCode && l.debtorCode.trim() ? `code:${l.debtorCode.trim().toUpperCase()}` : `name:${(l.debtorName ?? "").trim().toUpperCase()}`);

export const DeliveryReturnFromDo = () => {
  const navigate = useNavigate();
  const toast = useToast();
  const linesQ = useReturnableDoLines();
  const createDr = useCreateDeliveryReturnFromDos();

  const [picks, setPicks] = useState<Record<string, { picked: boolean; qty: number; condition: string }>>({});
  const lines = useMemo(() => linesQ.data ?? [], [linesQ.data]);

  const grouped = useMemo(() => {
    const byDoc = new Map<string, { meta: ReturnableDoLine; lines: ReturnableDoLine[] }>();
    for (const l of lines) { const cur = byDoc.get(l.doNumber); if (cur) cur.lines.push(l); else byDoc.set(l.doNumber, { meta: l, lines: [l] }); }
    return [...byDoc.entries()].map(([doNumber, { meta, lines }]) => ({ doNumber, meta, lines }));
  }, [lines]);

  const activeCustomer = useMemo(() => { for (const l of lines) { const p = picks[l.doItemId]; if (p?.picked && p.qty > 0) return custKey(l); } return null; }, [picks, lines]);

  const togglePick = (l: ReturnableDoLine) => { if (activeCustomer && activeCustomer !== custKey(l)) return; setPicks((s) => ({ ...s, [l.doItemId]: s[l.doItemId]?.picked ? { picked: false, qty: 0, condition: "NEW" } : { picked: true, qty: s[l.doItemId]?.qty || l.remaining, condition: s[l.doItemId]?.condition || "NEW" } })); };
  const setQty = (l: ReturnableDoLine, qty: number) => setPicks((s) => ({ ...s, [l.doItemId]: { picked: true, qty, condition: s[l.doItemId]?.condition || "NEW" } }));
  const setCondition = (l: ReturnableDoLine, condition: string) => setPicks((s) => ({ ...s, [l.doItemId]: { picked: s[l.doItemId]?.picked ?? true, qty: s[l.doItemId]?.qty ?? l.remaining, condition } }));
  const clearAll = () => setPicks({});

  const picked = Object.entries(picks).filter(([, v]) => v.picked && v.qty > 0);
  const pickedCount = picked.length;

  const onCreate = () => {
    if (pickedCount === 0) { toast.error("Tick at least one line first."); return; }
    createDr.mutate({ picks: picked.map(([doItemId, v]) => ({ doItemId, qty: v.qty, condition: v.condition })) }, {
      onSuccess: (r) => { toast.success(`Return ${r.returnNumber} created — stock returned to shelf.`); navigate(`/delivery-returns/${r.id}`); },
      onError: (e) => toast.error(`Create failed: ${e instanceof Error ? e.message : String(e)}`),
    });
  };

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div className={styles.titleBlock}>
          <Link to="/delivery-returns" className={styles.backBtn}><ArrowLeft {...ICON} /><span>Delivery Returns</span></Link>
          <div><h1 className={styles.title}>Return Delivery Order lines</h1></div>
        </div>
        <div className={styles.actions}>
          <Button variant="ghost" onClick={() => navigate("/delivery-returns")}><X {...ICON} /><span>Cancel</span></Button>
          <Button variant="primary" onClick={onCreate} disabled={pickedCount === 0 || createDr.isPending}><Check {...ICON} /><span>{pickedCount === 0 ? "Pick at least 1 line" : `Create return from ${pickedCount} line${pickedCount === 1 ? "" : "s"}`}</span></Button>
        </div>
      </div>

      <p className={styles.eyebrow}>{linesQ.isLoading ? "Loading returnable DO lines…" : lines.length === 0 ? "No returnable lines — every delivered line has been fully invoiced or returned." : `${lines.length} line${lines.length === 1 ? "" : "s"} across ${grouped.length} DO${grouped.length === 1 ? "" : "s"}${activeCustomer ? " · locked to one customer" : ""}`}</p>

      {linesQ.error && !linesQ.isLoading && (<div className={styles.bannerWarn}><strong>Failed to load returnable DO lines.</strong> {linesQ.error instanceof Error ? linesQ.error.message : String(linesQ.error)}</div>)}

      {Object.keys(picks).length > 0 && (<div style={{ margin: "var(--space-2) 0" }}><Button variant="ghost" onClick={clearAll}><X {...ICON} /><span>Clear picks</span></Button></div>)}

      {grouped.length === 0 && !linesQ.isLoading ? (
        <section className={styles.card}><div className={styles.cardBody}><p className={styles.emptyRow}>Ship a Delivery Order, then its lines show up here to return.</p></div></section>
      ) : (
        grouped.map(({ doNumber, meta, lines }) => {
          const locked = Boolean(activeCustomer) && activeCustomer !== custKey(meta);
          return (
            <section key={doNumber} className={styles.card} style={{ opacity: locked ? 0.5 : 1 }}>
              <header className={styles.cardHeader}>
                <h2 className={styles.cardTitle}><span style={{ fontFamily: "var(--font-mono)", color: "var(--c-burnt)" }}>{doNumber}</span><span style={{ fontSize: "var(--fs-12)", color: "var(--fg-muted)", fontWeight: 400, marginLeft: 12 }}>{meta.debtorName ?? meta.debtorCode ?? "—"}</span></h2>
                {locked && <span style={{ fontSize: "var(--fs-12)", color: "var(--fg-soft)", fontStyle: "italic" }}>Clear your picks to return this customer instead</span>}
              </header>
              <table className={styles.table}>
                <thead><tr><th style={{ width: 40 }} /><th>Item Code</th><th>Description</th><th className={styles.tableRight}>Remaining</th><th className={styles.tableRight}>Return Qty</th><th>Condition</th><th className={styles.tableRight}>Line Value</th></tr></thead>
                <tbody>
                  {lines.map((l) => {
                    const p = picks[l.doItemId];
                    const on = Boolean(p?.picked);
                    const pickQty = on ? p!.qty : l.remaining;
                    return (
                      <tr key={l.doItemId} style={{ background: on ? "rgba(232, 107, 58, 0.08)" : undefined }}>
                        <td onClick={(e) => e.stopPropagation()}><button type="button" className={styles.iconBtn} disabled={locked} onClick={() => togglePick(l)} title={on ? "Unpick" : "Pick"}>{on ? <CheckSquare {...ICON} /> : <Square {...ICON} />}</button></td>
                        <td style={{ fontFamily: "var(--font-mono)" }}>{l.itemCode}</td>
                        <td>{l.description ?? "—"}</td>
                        <td className={styles.tableRight}>{l.remaining}</td>
                        <td className={styles.tableRight} onClick={(e) => e.stopPropagation()}><input type="number" min={0} max={l.remaining} className={styles.fieldInput} style={{ width: 80, textAlign: "right" }} value={on ? pickQty : ""} placeholder={String(l.remaining)} disabled={!on || locked} onChange={(e) => setQty(l, Math.min(l.remaining, Math.max(0, Number(e.target.value) || 0)))} /></td>
                        <td onClick={(e) => e.stopPropagation()}>
                          <select className={styles.fieldInput} style={{ width: 110 }} value={on ? p!.condition : "NEW"} disabled={!on || locked} onChange={(e) => setCondition(l, e.target.value)}>
                            {CONDITIONS.map((c) => (<option key={c} value={c}>{c}</option>))}
                          </select>
                        </td>
                        <td className={styles.priceCell}>{fmtRm(pickQty * l.unitPriceCenti)}</td>
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
