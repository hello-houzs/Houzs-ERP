// ----------------------------------------------------------------------------
// PurchaseReturnDetail — full-page route at /purchase-returns/:id.
//
// 1:1 clone of 2990s apps/backend/src/pages/PurchaseReturnDetail.tsx, a clone of
// the GRN/PO detail with PR semantics. A draft-style View -> Edit -> Save/Back
// machine + a Complete action (records the supplier credit note) + Cancel:
//   1. Header: back + PR# · supplier + Refund rail + status pill + actions
//   2. Header card: supplier + return date + reason + credit-note ref + notes
//   3. Line items table (View read-only incl. per-line Warehouse + Edit = inline
//      qty(returned)/unit)
//   4. Totals card (refund, live incl. draft edits)
//
// purchase_return_status: POSTED reads "Confirmed". A PR is editable while POSTED;
// COMPLETED / CANCELLED are terminal (line CRUD locked — it moves real inventory).
//
// SEAM changes (same playbook as GoodsReceivedDetail):
//   - Data layer: 2990s lib/flow-queries -> the PR hooks in ./flow-queries (Houzs
//     api client + TanStack). Shapes identical (rule #7).
//   - Components: @2990s/design-system Button -> Houzs components/Button; 2990s
//     MoneyInput -> a minimal inline RM<->centi editor; react-router ->
//     react-router-dom (rule #9). useConfirm -> plain loading text + window.confirm.
//
// Strategy-2 product-layer notes (dropped from the 2990s page):
//   - Print PDF (jspdf), buildVariantSummary / ItemGroupPill, the per-line variant
//     editor — DROPPED. Line description / description2 show as-is. TODO: generic PR print.
// ----------------------------------------------------------------------------

import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, FileText, Pencil, Trash2, Save, Ban, CheckCircle2 } from "lucide-react";
import { Button } from "../../components/Button";
import {
  usePurchaseReturnDetail,
  useUpdatePurchaseReturnHeader,
  useUpdatePurchaseReturnItem,
  useDeletePurchaseReturnItem,
  useCancelPurchaseReturn,
  useCompletePurchaseReturn,
  type PrItemRow,
  type PrRow,
  type PrStatus,
} from "./flow-queries";
import styles from "./PurchaseOrderDetail.module.css";

const ICON = { size: 16, strokeWidth: 1.75 } as const;
const SM_ICON = { size: 14, strokeWidth: 1.75 } as const;

const STATUS_LABEL: Record<PrStatus, string> = {
  POSTED: "Confirmed",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};
const STATUS_CLASS: Record<PrStatus, string> = {
  POSTED: styles.statusDelivered ?? "",
  COMPLETED: styles.statusDelivered ?? "",
  CANCELLED: styles.statusCancelled ?? "",
};

const fmtRm = (centi: number | null | undefined, currency = "MYR"): string => {
  const v = centi ?? 0;
  return `${currency} ${(v / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const fmtDateOrDash = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
};

type HeaderDraft = { returnDate: string; reason: string; creditNoteRef: string; notes: string };
type LineDraft = { qtyReturned: number; unitPriceCenti: number };

const headerSnapshot = (p: PrRow): HeaderDraft => ({
  returnDate: p.return_date ?? "",
  reason: p.reason ?? "",
  creditNoteRef: p.credit_note_ref ?? "",
  notes: p.notes ?? "",
});

const lineSnapshot = (it: PrItemRow): LineDraft => ({ qtyReturned: it.qty_returned, unitPriceCenti: it.unit_price_centi });

export const PurchaseReturnDetail = () => {
  const { id } = useParams<{ id: string }>();
  const detail = usePurchaseReturnDetail(id ?? null);
  const updateHeader = useUpdatePurchaseReturnHeader();
  const cancel = useCancelPurchaseReturn();
  const complete = useCompletePurchaseReturn();
  const updateItem = useUpdatePurchaseReturnItem();
  const deleteItem = useDeletePurchaseReturnItem();

  const pr = detail.data?.purchaseReturn ?? null;
  const items = detail.data?.items ?? [];

  const [searchParams] = useSearchParams();
  const [isEditing, setIsEditing] = useState(() => searchParams.get("edit") === "1");
  const [headerDraft, setHeaderDraft] = useState<HeaderDraft | null>(null);
  const [lineDrafts, setLineDrafts] = useState<Record<string, LineDraft>>({});
  const [savingDraft, setSavingDraft] = useState(false);

  // A PR is editable while POSTED. COMPLETED / CANCELLED are terminal.
  const isLocked = pr ? pr.status !== "POSTED" : true;

  useEffect(() => {
    if (isLocked && isEditing) {
      setIsEditing(false);
      setHeaderDraft(null);
      setLineDrafts({});
    }
  }, [isLocked, isEditing]);

  if (detail.isLoading) {
    return (
      <div className={styles.page}>
        <p className={styles.eyebrow}>Loading purchase return…</p>
      </div>
    );
  }
  if (detail.isError || !pr) {
    return (
      <div className={styles.page}>
        <Link to="/purchase-returns" className={styles.backBtn}>
          <ArrowLeft {...ICON} />
          <span>Back</span>
        </Link>
        <div className={styles.bannerWarn}>
          <strong>Purchase return not found.</strong>
          {detail.error instanceof Error ? ` ${detail.error.message}` : null}
        </div>
      </div>
    );
  }

  const lineOf = (it: PrItemRow): LineDraft => lineDrafts[it.id] ?? lineSnapshot(it);
  const lineRefundOf = (it: PrItemRow): number => {
    if (!isEditing) return it.line_refund_centi ?? 0;
    const d = lineOf(it);
    return d.qtyReturned * d.unitPriceCenti;
  };
  const totalRefund = items.reduce((s, it) => s + lineRefundOf(it), 0);

  const headerView = headerDraft ?? headerSnapshot(pr);
  const setHeaderField = (k: keyof HeaderDraft, v: string) => setHeaderDraft((h) => ({ ...(h ?? headerSnapshot(pr)), [k]: v }));
  const setLine = (it: PrItemRow, patch: Partial<LineDraft>) => setLineDrafts((prev) => ({ ...prev, [it.id]: { ...(prev[it.id] ?? lineSnapshot(it)), ...patch } }));

  const enterEdit = () => {
    setHeaderDraft(null);
    setLineDrafts({});
    setIsEditing(true);
  };

  const handleSave = async () => {
    if (savingDraft) return;
    setSavingDraft(true);
    try {
      if (headerDraft) await updateHeader.mutateAsync({ id: pr.id, ...(headerDraft as Record<string, unknown>) });
      for (const it of items) {
        const d = lineDrafts[it.id];
        if (!d) continue;
        const changed = d.qtyReturned !== it.qty_returned || d.unitPriceCenti !== it.unit_price_centi;
        if (changed) await updateItem.mutateAsync({ prId: pr.id, itemId: it.id, qty: d.qtyReturned, unitPriceCenti: d.unitPriceCenti });
      }
      setIsEditing(false);
      setHeaderDraft(null);
      setLineDrafts({});
    } catch (e) {
      window.alert(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSavingDraft(false);
    }
  };

  const doComplete = () => {
    const cn = window.prompt(`Mark ${pr.return_number} completed. Enter the supplier's credit-note ref (optional):`, pr.credit_note_ref ?? "");
    if (cn == null) return; // cancelled the prompt
    complete.mutate(
      { id: pr.id, creditNoteRef: cn.trim() || undefined },
      { onError: (e) => window.alert(`Complete failed: ${e instanceof Error ? e.message : String(e)}`) },
    );
  };

  const doCancel = () => {
    if (!confirm(`Cancel return ${pr.return_number}? This reverses the return — the goods are put back into stock. Line items stay for audit.`)) return;
    cancel.mutate(pr.id, { onError: (err) => window.alert(`Cancel failed: ${err instanceof Error ? err.message : String(err)}`) });
  };

  return (
    <div className={styles.page}>
      {/* ── Header ──────────────────────────────────────────────── */}
      <div className={styles.headerRow}>
        <div className={styles.titleBlock}>
          <Link to="/purchase-returns" className={styles.backBtn}>
            <ArrowLeft {...ICON} />
            <span>Back</span>
          </Link>
          <div>
            <h1 className={styles.title}>
              <FileText size={14} strokeWidth={1.75} style={{ color: "var(--c-burnt)" }} />
              {pr.return_number} — {pr.supplier?.name ?? pr.supplier?.code ?? "—"}
            </h1>
          </div>
        </div>
        <div className={styles.actions}>
          <div className={styles.totalRail}>
            <span className={styles.totalRailLabel}>Refund</span>
            <span className={styles.totalRailValue}>{fmtRm(totalRefund)}</span>
          </div>
          <span className={`${styles.statusPill} ${STATUS_CLASS[pr.status]}`}>{STATUS_LABEL[pr.status] ?? pr.status}</span>
          {pr.status === "POSTED" && (
            <Button variant="ghost" onClick={doComplete} disabled={complete.isPending}>
              <CheckCircle2 {...ICON} />
              <span>{complete.isPending ? "Completing…" : "Mark completed"}</span>
            </Button>
          )}
          {pr.status === "POSTED" && (
            <Button variant="ghost" onClick={doCancel} disabled={cancel.isPending}>
              <Ban {...ICON} />
              <span>{cancel.isPending ? "Cancelling…" : "Cancel"}</span>
            </Button>
          )}
          {!isEditing ? (
            <Button variant="primary" onClick={enterEdit} disabled={isLocked}>
              <Pencil {...ICON} />
              <span>Edit</span>
            </Button>
          ) : (
            <Button variant="primary" onClick={handleSave} disabled={savingDraft}>
              <Save {...ICON} />
              <span>{savingDraft ? "Saving…" : "Save"}</span>
            </Button>
          )}
        </div>
      </div>

      {/* ── Header card ──────────────────────────────────────────── */}
      <HeaderCard pr={pr} draft={headerView} onField={setHeaderField} locked={isLocked} isEditing={isEditing} />

      {/* ── Line items ──────────────────────────────────────────── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Line Items ({items.length})</h2>
        </header>
        {items.length === 0 ? (
          <div className={styles.cardBody}>
            <p className={styles.emptyRow}>No items on this return.</p>
          </div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Item</th>
                <th>Warehouse</th>
                <th className={styles.tableRight}>Qty Returned</th>
                <th className={styles.tableRight}>Unit</th>
                <th className={styles.tableRight}>Refund</th>
                {isEditing && <th className={styles.tableRight}>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {items.map((it) => {
                const d = lineOf(it);
                const summary = it.description2 || it.description || it.material_name;
                return (
                  <tr key={it.id}>
                    <td>
                      <div className={styles.codeCell}>{it.material_code}</div>
                      {summary ? (
                        <div className={styles.muted} style={{ fontSize: "var(--fs-11)" }}>
                          {summary}
                        </div>
                      ) : null}
                    </td>
                    <td className={styles.muted}>{it.warehouse_code ?? "—"}</td>
                    {isEditing ? (
                      <>
                        <td className={styles.tableRight}>
                          <input type="number" min={0} className={styles.fieldInput} style={{ width: 80, textAlign: "right" }} value={d.qtyReturned} disabled={isLocked} onChange={(e) => setLine(it, { qtyReturned: Number(e.target.value) || 0 })} />
                        </td>
                        <td className={styles.tableRight}>
                          <InlineRmInput valueCenti={d.unitPriceCenti} disabled={isLocked} onCommit={(centi) => setLine(it, { unitPriceCenti: centi })} style={{ width: 110 }} />
                        </td>
                        <td className={styles.priceCell}>{fmtRm(d.qtyReturned * d.unitPriceCenti)}</td>
                        <td className={styles.tableRight}>
                          <button
                            type="button"
                            className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                            title="Remove line"
                            disabled={isLocked || deleteItem.isPending}
                            onClick={() => {
                              if (isLocked) return;
                              if (confirm("Remove this line? Its return is reversed (stock back in) and the source GRN line is released.")) {
                                deleteItem.mutate({ prId: pr.id, itemId: it.id });
                              }
                            }}
                          >
                            <Trash2 {...SM_ICON} />
                          </button>
                        </td>
                      </>
                    ) : (
                      <>
                        <td className={styles.tableRight}>{it.qty_returned}</td>
                        <td className={styles.tableRight}>{fmtRm(it.unit_price_centi)}</td>
                        <td className={styles.priceCell}>{fmtRm(it.line_refund_centi)}</td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {/* ── Totals ────────────────────────────────────────────────── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Totals</h2>
        </header>
        <div className={styles.cardBody}>
          <div className={styles.totalsGrid}>
            <div className={`${styles.totalRow} ${styles.grandTotalRow}`}>
              <span className={styles.totalLabel}>Total Refund</span>
              <span className={`${styles.totalValue} ${styles.grandTotal}`}>{fmtRm(totalRefund)}</span>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};

/* ════════════════════════════════════════════════════════════════════════
   Header card — controlled by the page's draft
   ════════════════════════════════════════════════════════════════════════ */

const HeaderCard = ({ pr, draft, onField, locked, isEditing }: { pr: PrRow; draft: HeaderDraft; onField: (k: keyof HeaderDraft, v: string) => void; locked: boolean; isEditing: boolean }) => {
  return (
    <section className={styles.card}>
      <header className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>Supplier · Dates · Notes</h2>
      </header>
      <div className={styles.cardBody}>
        {!isEditing ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "var(--space-3) var(--space-4)", fontFamily: "var(--font-sans)", fontSize: "var(--fs-13)" }}>
            <div style={{ gridColumn: "span 2" }}>
              <InfoCell label="Supplier" value={pr.supplier?.name ?? pr.supplier?.code ?? null} />
            </div>
            <InfoCell label="Source (GRN/PO)" value={pr.grn?.grn_number ?? pr.purchase_order?.po_number ?? null} />
            <InfoCell label="Return Date" value={fmtDateOrDash(pr.return_date)} />
            <div style={{ gridColumn: "span 2" }}>
              <InfoCell label="Reason" value={pr.reason || null} />
            </div>
            <InfoCell label="Credit Note Ref" value={pr.credit_note_ref || null} />
            <div style={{ gridColumn: "span 1" }}>
              <InfoCell label="Completed" value={fmtDateOrDash(pr.completed_at)} />
            </div>
            <div style={{ gridColumn: "span 4" }}>
              <InfoCell label="Notes" value={pr.notes || null} />
            </div>
          </div>
        ) : (
          <div className={styles.formGrid4}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Return Date</span>
              <input type="date" className={styles.fieldInput} value={draft.returnDate} disabled={locked} onChange={(e) => onField("returnDate", e.target.value)} />
            </label>
            <label className={styles.field} style={{ gridColumn: "span 2" }}>
              <span className={styles.fieldLabel}>Reason</span>
              <input className={styles.fieldInput} value={draft.reason} disabled={locked} onChange={(e) => onField("reason", e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Credit Note Ref</span>
              <input className={styles.fieldInput} value={draft.creditNoteRef} disabled={locked} onChange={(e) => onField("creditNoteRef", e.target.value)} />
            </label>
            <label className={styles.field} style={{ gridColumn: "span 4" }}>
              <span className={styles.fieldLabel}>Notes</span>
              <input className={styles.fieldInput} value={draft.notes} disabled={locked} onChange={(e) => onField("notes", e.target.value)} />
            </label>
          </div>
        )}
      </div>
    </section>
  );
};

const InlineRmInput = ({ valueCenti, onCommit, disabled, style }: { valueCenti: number; onCommit: (centi: number) => void; disabled?: boolean; style?: React.CSSProperties }) => {
  const toRm = (c: number) => (c ? (c / 100).toFixed(2) : "");
  const [draft, setDraft] = useState(toRm(valueCenti));
  const [committed, setCommitted] = useState(valueCenti);
  if (committed !== valueCenti) {
    setCommitted(valueCenti);
    setDraft(toRm(valueCenti));
  }
  const commit = () => {
    const t = draft.trim();
    const n = t === "" ? 0 : Number(t);
    const next = Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : valueCenti;
    onCommit(next);
  };
  return (
    <input
      className={styles.fieldInput}
      style={{ textAlign: "right", ...style }}
      value={draft}
      inputMode="decimal"
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        }
        if (e.key === "Escape") {
          setDraft(toRm(valueCenti));
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
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
