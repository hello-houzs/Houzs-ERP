// ----------------------------------------------------------------------------
// PurchaseInvoiceFromGrn — GRN LINE -> Purchase Invoice picker at
// /purchase-invoices/from-grn.
//
// 1:1 clone of 2990s apps/backend/src/pages/PurchaseInvoiceFromGrn.tsx. A PI
// belongs to ONE goods-received note (purchase_invoices has a single grn_id FK),
// so this picker locks to one note at a time: tick the lines to bill from a
// single note, then Continue to the New PI review screen (?grnId=&fromPicks=1)
// where prices/dates are confirmed and Create is clicked. Nothing is invoiced
// until that final Create. Lines from other notes dim while one note is active.
// Each line is capped at its REMAINING (accepted - invoiced - returned).
//
// SEAM changes (same playbook as GrnFromPo):
//   - Data layer: 2990s lib/suppliers-queries useOutstandingGrnItems -> the PI
//     hook in ./flow-queries (Houzs api client + TanStack). Shape identical
//     (rule #7) — backed by /api/purchase-invoices/outstanding-grn-items.
//   - Components: @2990s/design-system Button -> Houzs components/Button; the 2990s
//     CSS-grid card layout -> a plain <table> with the verbatim
//     PurchaseOrderDetail.module.css classes (rule #9).
//   - Routing: react-router -> react-router-dom (same hooks).
// ----------------------------------------------------------------------------

import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, ArrowRight, X, CheckSquare, Square } from "lucide-react";
import { Button } from "../../components/Button";
import { useOutstandingGrnItems, type OutstandingGrnItem } from "./flow-queries";
import { useToast } from "../../hooks/useToast";
import styles from "./PurchaseOrderDetail.module.css";

const ICON = { size: 16, strokeWidth: 1.75 } as const;
const SM_ICON = { size: 16, strokeWidth: 1.75 } as const;

const fmtRm = (centi: number, currency = "MYR"): string =>
  `${currency} ${(centi / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const fmtDateOrDash = (iso: string | null): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
};

export const PurchaseInvoiceFromGrn = () => {
  const navigate = useNavigate();
  const toast = useToast();
  const itemsQ = useOutstandingGrnItems();

  const [picks, setPicks] = useState<Record<string, { picked: boolean; qty: number }>>({});
  const items = useMemo(() => itemsQ.data ?? [], [itemsQ.data]);

  // Group by GRN doc no so the UI renders one block per GRN.
  const grouped = useMemo(() => {
    const byDoc = new Map<string, { meta: OutstandingGrnItem; lines: OutstandingGrnItem[] }>();
    for (const it of items) {
      const cur = byDoc.get(it.grnDocNo);
      if (cur) cur.lines.push(it);
      else byDoc.set(it.grnDocNo, { meta: it, lines: [it] });
    }
    return [...byDoc.entries()].map(([docNo, { meta, lines }]) => ({ docNo, meta, lines }));
  }, [items]);

  // The note currently being billed = the GRN of the first ticked line. While
  // set, lines from every OTHER note are locked (one PI <-> one note).
  const activeGrnId = useMemo(() => {
    for (const it of items) {
      const p = picks[it.grnItemId];
      if (p?.picked && p.qty > 0) return it.grnId;
    }
    return null;
  }, [picks, items]);

  const togglePick = (it: OutstandingGrnItem) => {
    if (activeGrnId && activeGrnId !== it.grnId) return; // locked to another note
    setPicks((s) => ({
      ...s,
      [it.grnItemId]: s[it.grnItemId]?.picked ? { picked: false, qty: 0 } : { picked: true, qty: s[it.grnItemId]?.qty || it.remaining },
    }));
  };

  const setQty = (it: OutstandingGrnItem, qty: number) => setPicks((s) => ({ ...s, [it.grnItemId]: { picked: true, qty } }));

  const toggleAllInGrn = (lines: OutstandingGrnItem[], on: boolean) =>
    setPicks((s) => {
      const next = { ...s };
      for (const l of lines) next[l.grnItemId] = on ? { picked: true, qty: l.remaining } : { picked: false, qty: 0 };
      return next;
    });

  const clearAll = () => setPicks({});

  const picked = Object.entries(picks).filter(([, v]) => v.picked && v.qty > 0);
  const pickedCount = picked.length;

  const onContinue = () => {
    if (pickedCount === 0 || !activeGrnId) {
      toast.error("Tick at least one line from one note first.");
      return;
    }
    const stash = picked.map(([grnItemId, v]) => ({ grnItemId, qty: v.qty }));
    try {
      sessionStorage.setItem("piFromGrnPicks", JSON.stringify(stash));
    } catch {
      /* quota — the New PI form simply prefills every remaining line */
    }
    navigate(`/purchase-invoices/new?grnId=${encodeURIComponent(activeGrnId)}&fromPicks=1`);
  };

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div className={styles.titleBlock}>
          <Link to="/purchase-invoices" className={styles.backBtn}>
            <ArrowLeft {...ICON} />
            <span>Purchase Invoices</span>
          </Link>
          <div>
            <h1 className={styles.title}>Bill a Goods-Received Note</h1>
          </div>
        </div>
        <div className={styles.actions}>
          <Button variant="ghost" onClick={() => navigate("/purchase-invoices")}>
            <X {...ICON} />
            <span>Cancel</span>
          </Button>
          <Button variant="primary" onClick={onContinue} disabled={pickedCount === 0}>
            <ArrowRight {...ICON} />
            <span>{pickedCount === 0 ? "Pick at least 1 line" : `Continue with ${pickedCount} line${pickedCount === 1 ? "" : "s"}`}</span>
          </Button>
        </div>
      </div>

      <p className={styles.eyebrow}>
        {itemsQ.isLoading
          ? "Loading outstanding GRN lines…"
          : items.length === 0
            ? "No outstanding lines — every posted GRN has already been invoiced."
            : `${items.length} line${items.length === 1 ? "" : "s"} across ${grouped.length} GRN${grouped.length === 1 ? "" : "s"}${activeGrnId ? " · locked to one note" : ""}`}
      </p>

      {itemsQ.error && !itemsQ.isLoading && (
        <div className={styles.bannerWarn}>
          <strong>Failed to load outstanding GRN lines.</strong> {itemsQ.error instanceof Error ? itemsQ.error.message : String(itemsQ.error)}
        </div>
      )}

      {Object.keys(picks).length > 0 && (
        <div style={{ margin: "var(--space-2) 0" }}>
          <Button variant="ghost" onClick={clearAll}>
            <X {...SM_ICON} />
            <span>Clear picks</span>
          </Button>
        </div>
      )}

      {grouped.length === 0 && !itemsQ.isLoading ? (
        <section className={styles.card}>
          <div className={styles.cardBody}>
            <p className={styles.emptyRow}>Once a GRN is posted (and not yet fully invoiced), its lines will show up here.</p>
          </div>
        </section>
      ) : (
        grouped.map(({ docNo, meta, lines }) => {
          const locked = Boolean(activeGrnId) && activeGrnId !== meta.grnId;
          const allPicked = lines.every((l) => picks[l.grnItemId]?.picked);
          return (
            <section key={docNo} className={styles.card} style={{ opacity: locked ? 0.5 : 1 }}>
              <header className={styles.cardHeader}>
                <h2 className={styles.cardTitle}>
                  <label style={{ display: "inline-flex", alignItems: "center", gap: 8, cursor: locked ? "not-allowed" : "pointer" }}>
                    <button type="button" className={styles.iconBtn} disabled={locked} onClick={() => toggleAllInGrn(lines, !allPicked)} title={allPicked ? "Unpick all" : "Pick all"}>
                      {allPicked ? <CheckSquare {...SM_ICON} /> : <Square {...SM_ICON} />}
                    </button>
                    <span style={{ fontFamily: "var(--font-mono)", color: "var(--c-burnt)" }}>{docNo}</span>
                  </label>
                  <span style={{ fontSize: "var(--fs-12)", color: "var(--fg-muted)", fontWeight: 400, marginLeft: 12 }}>
                    {[meta.supplierName || meta.supplierCode, meta.poDocNo ? `PO ${meta.poDocNo}` : null, `Received ${fmtDateOrDash(meta.receivedAt)}`].filter(Boolean).join(" · ")}
                  </span>
                </h2>
                {locked && <span style={{ fontSize: "var(--fs-12)", color: "var(--fg-soft)", fontStyle: "italic" }}>Clear your picks to bill this note instead</span>}
              </header>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th style={{ width: 40 }} />
                    <th>Item Code</th>
                    <th>Description</th>
                    <th className={styles.tableRight}>Remaining</th>
                    <th className={styles.tableRight}>Bill Qty</th>
                    <th className={styles.tableRight}>Line Value</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => {
                    const p = picks[l.grnItemId];
                    const on = Boolean(p?.picked);
                    const pickQty = on ? p!.qty : l.remaining;
                    return (
                      <tr key={l.grnItemId} style={{ background: on ? "rgba(232, 107, 58, 0.08)" : undefined }}>
                        <td onClick={(e) => e.stopPropagation()}>
                          <button type="button" className={styles.iconBtn} disabled={locked} onClick={() => togglePick(l)} title={on ? "Unpick" : "Pick"}>
                            {on ? <CheckSquare {...SM_ICON} /> : <Square {...SM_ICON} />}
                          </button>
                        </td>
                        <td style={{ fontFamily: "var(--font-mono)" }}>{l.itemCode}</td>
                        <td>{l.description ?? "—"}</td>
                        <td className={styles.tableRight}>{l.remaining}</td>
                        <td className={styles.tableRight} onClick={(e) => e.stopPropagation()}>
                          <input
                            type="number"
                            min={0}
                            max={l.remaining}
                            className={styles.fieldInput}
                            style={{ width: 80, textAlign: "right" }}
                            value={on ? pickQty : ""}
                            placeholder={String(l.remaining)}
                            disabled={!on || locked}
                            onChange={(e) => setQty(l, Math.min(l.remaining, Math.max(0, Number(e.target.value) || 0)))}
                          />
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
