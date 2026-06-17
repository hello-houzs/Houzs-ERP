// ----------------------------------------------------------------------------
// PurchaseInvoiceDetail — full-page route at /purchase-invoices/:id.
//
// 1:1 clone of 2990s apps/backend/src/pages/PurchaseInvoiceDetail.tsx, which is a
// clone of the GRN/PO detail (the gold standard) with PI semantics. A draft-style
// View -> Edit -> Save/Back machine + a Record-payment action + Cancel:
//   1. Header: back + PI# · supplier + Total rail + status pill + actions
//   2. Header card: supplier + invoice/due dates + supplier-invoice ref + notes
//   3. Line items table (View read-only / Edit = inline qty/unit/disc)
//   4. Totals card (subtotal + tax + total + paid + balance, live incl. edits)
//   5. Record-payment dialog (amount in RM) — auto-status POSTED->PARTIALLY_PAID->PAID
//
// purchase_invoice_status: POSTED reads "Confirmed". A PI is EDITABLE only while it
// has NO payment (paid_centi = 0) and is not CANCELLED. PAID/PARTIALLY_PAID/
// CANCELLED lock the line/header editing.
//
// SEAM changes (same playbook as GoodsReceivedDetail):
//   - Data layer: 2990s lib/flow-queries -> the PI hooks in ./flow-queries (Houzs
//     api client + TanStack). Shapes identical (rule #7).
//   - Components: @2990s/design-system Button -> Houzs components/Button; 2990s
//     MoneyInput -> a minimal inline RM<->centi editor; react-router ->
//     react-router-dom (rule #9). useConfirm / RelationshipMapButton -> plain
//     loading text + Houzs useDialog/useToast (in-app, never window.confirm/alert).
//
// Strategy-2 product-layer notes (dropped from the 2990s page):
//   - Print PDF (jspdf), buildVariantSummary / ItemGroupPill, the per-line variant
//     editor — DROPPED. Line description / description2 show as-is. AP->GL posting
//     is out of SCM clone scope (Houzs GL differs). TODO: generic PI print.
// ----------------------------------------------------------------------------

import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, FileText, Pencil, Trash2, Save, Ban, Wallet } from "lucide-react";
import { Button } from "../../components/Button";
import {
  usePurchaseInvoiceDetail,
  useUpdatePurchaseInvoiceHeader,
  useUpdatePurchaseInvoiceItem,
  useDeletePurchaseInvoiceItem,
  useCancelPurchaseInvoice,
  useRecordPiPayment,
  type PiItemRow,
  type PiRow,
  type PiStatus,
} from "./flow-queries";
import { useDialog } from "../../hooks/useDialog";
import { useToast } from "../../hooks/useToast";
import styles from "./PurchaseOrderDetail.module.css";

const ICON = { size: 16, strokeWidth: 1.75 } as const;
const SM_ICON = { size: 14, strokeWidth: 1.75 } as const;

const STATUS_LABEL: Record<PiStatus, string> = {
  POSTED: "Confirmed",
  PARTIALLY_PAID: "Partially Paid",
  PAID: "Paid",
  CANCELLED: "Cancelled",
};
const STATUS_CLASS: Record<PiStatus, string> = {
  POSTED: styles.statusDelivered ?? "",
  PARTIALLY_PAID: styles.statusDelivered ?? "",
  PAID: styles.statusDelivered ?? "",
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

type HeaderDraft = { supplierInvoiceRef: string; invoiceDate: string; dueDate: string; notes: string };
type LineDraft = { qty: number; unitPriceCenti: number; discountCenti: number };

const headerSnapshot = (p: PiRow): HeaderDraft => ({
  supplierInvoiceRef: p.supplier_invoice_ref ?? "",
  invoiceDate: p.invoice_date ?? "",
  dueDate: p.due_date ?? "",
  notes: p.notes ?? "",
});

const lineSnapshot = (it: PiItemRow): LineDraft => ({ qty: it.qty, unitPriceCenti: it.unit_price_centi, discountCenti: it.discount_centi ?? 0 });

export const PurchaseInvoiceDetail = () => {
  const { id } = useParams<{ id: string }>();
  const dialog = useDialog();
  const toast = useToast();
  const detail = usePurchaseInvoiceDetail(id ?? null);
  const updateHeader = useUpdatePurchaseInvoiceHeader();
  const cancel = useCancelPurchaseInvoice();
  const updateItem = useUpdatePurchaseInvoiceItem();
  const deleteItem = useDeletePurchaseInvoiceItem();
  const recordPayment = useRecordPiPayment();

  const pi = detail.data?.purchaseInvoice ?? null;
  const items = detail.data?.items ?? [];

  const [searchParams] = useSearchParams();
  const [isEditing, setIsEditing] = useState(() => searchParams.get("edit") === "1");
  const [headerDraft, setHeaderDraft] = useState<HeaderDraft | null>(null);
  const [lineDrafts, setLineDrafts] = useState<Record<string, LineDraft>>({});
  const [savingDraft, setSavingDraft] = useState(false);

  // A PI is editable while it has NO payment (paid_centi = 0) and is not CANCELLED.
  const hasPayment = (pi?.paid_centi ?? 0) > 0;
  const isLocked = pi ? pi.status === "CANCELLED" || hasPayment : true;

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
        <p className={styles.eyebrow}>Loading purchase invoice…</p>
      </div>
    );
  }
  if (detail.isError || !pi) {
    return (
      <div className={styles.page}>
        <Link to="/purchase-invoices" className={styles.backBtn}>
          <ArrowLeft {...ICON} />
          <span>Back</span>
        </Link>
        <div className={styles.bannerWarn}>
          <strong>Purchase invoice not found.</strong>
          {detail.error instanceof Error ? ` ${detail.error.message}` : null}
        </div>
      </div>
    );
  }

  const lineOf = (it: PiItemRow): LineDraft => lineDrafts[it.id] ?? lineSnapshot(it);
  const lineTotalOf = (it: PiItemRow): number => {
    if (!isEditing) return it.line_total_centi ?? 0;
    const d = lineOf(it);
    return d.qty * d.unitPriceCenti - d.discountCenti;
  };
  const itemsSubtotal = items.reduce((s, it) => s + lineTotalOf(it), 0);
  const grandTotal = itemsSubtotal + (pi.tax_centi ?? 0);
  const balance = grandTotal - (pi.paid_centi ?? 0);

  const headerView = headerDraft ?? headerSnapshot(pi);
  const setHeaderField = (k: keyof HeaderDraft, v: string) => setHeaderDraft((h) => ({ ...(h ?? headerSnapshot(pi)), [k]: v }));
  const setLine = (it: PiItemRow, patch: Partial<LineDraft>) => setLineDrafts((prev) => ({ ...prev, [it.id]: { ...(prev[it.id] ?? lineSnapshot(it)), ...patch } }));

  const enterEdit = () => {
    setHeaderDraft(null);
    setLineDrafts({});
    setIsEditing(true);
  };

  const handleSave = async () => {
    if (savingDraft) return;
    setSavingDraft(true);
    try {
      if (headerDraft) await updateHeader.mutateAsync({ id: pi.id, ...(headerDraft as Record<string, unknown>) });
      for (const it of items) {
        const d = lineDrafts[it.id];
        if (!d) continue;
        const changed = d.qty !== it.qty || d.unitPriceCenti !== it.unit_price_centi || d.discountCenti !== (it.discount_centi ?? 0);
        if (changed) {
          await updateItem.mutateAsync({ piId: pi.id, itemId: it.id, qty: d.qty, unitPriceCenti: d.unitPriceCenti, discountCenti: d.discountCenti });
        }
      }
      setIsEditing(false);
      setHeaderDraft(null);
      setLineDrafts({});
    } catch (e) {
      toast.error(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSavingDraft(false);
    }
  };

  const doRecordPayment = async () => {
    if (isLocked && pi.status === "CANCELLED") return;
    const raw = await dialog.prompt({
      message: `Record a payment for ${pi.invoice_number}. Amount in ${pi.currency} (balance ${fmtRm(balance, pi.currency)}):`,
      defaultValue: (balance / 100).toFixed(2),
      inputType: "number",
    });
    if (raw == null) return;
    const amount = Number(raw.trim());
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error("Enter a positive amount.");
      return;
    }
    recordPayment.mutate(
      { id: pi.id, amountCenti: Math.round(amount * 100) },
      { onError: (e) => toast.error(`Payment failed: ${e instanceof Error ? e.message : String(e)}`) },
    );
  };

  const doCancel = async () => {
    if (!(await dialog.confirm(`Cancel invoice ${pi.invoice_number}? This sets status to CANCELLED — line items stay for audit.`))) return;
    cancel.mutate(pi.id, { onError: (err) => toast.error(`Cancel failed: ${err instanceof Error ? err.message : String(err)}`) });
  };

  return (
    <div className={styles.page}>
      {/* ── Header ──────────────────────────────────────────────── */}
      <div className={styles.headerRow}>
        <div className={styles.titleBlock}>
          <Link to="/purchase-invoices" className={styles.backBtn}>
            <ArrowLeft {...ICON} />
            <span>Back</span>
          </Link>
          <div>
            <h1 className={styles.title}>
              <FileText size={14} strokeWidth={1.75} style={{ color: "var(--c-burnt)" }} />
              {pi.invoice_number} — {pi.supplier?.name ?? pi.supplier?.code ?? "—"}
            </h1>
          </div>
        </div>
        <div className={styles.actions}>
          <div className={styles.totalRail}>
            <span className={styles.totalRailLabel}>Total</span>
            <span className={styles.totalRailValue}>{fmtRm(grandTotal, pi.currency)}</span>
          </div>
          <span className={`${styles.statusPill} ${STATUS_CLASS[pi.status]}`}>{STATUS_LABEL[pi.status] ?? pi.status}</span>
          {pi.status !== "CANCELLED" && pi.status !== "PAID" && (
            <Button variant="ghost" onClick={doRecordPayment} disabled={recordPayment.isPending}>
              <Wallet {...ICON} />
              <span>{recordPayment.isPending ? "Recording…" : "Record payment"}</span>
            </Button>
          )}
          {pi.status !== "CANCELLED" && !hasPayment && (
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

      {isLocked && hasPayment && pi.status !== "CANCELLED" && (
        <div className={styles.bannerWarn}>
          <strong>Locked — a payment is recorded.</strong> The invoice can no longer be edited.
        </div>
      )}

      {/* ── Header card ──────────────────────────────────────────── */}
      <HeaderCard pi={pi} draft={headerView} onField={setHeaderField} locked={isLocked} isEditing={isEditing} />

      {/* ── Line items ──────────────────────────────────────────── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Line Items ({items.length})</h2>
        </header>
        {items.length === 0 ? (
          <div className={styles.cardBody}>
            <p className={styles.emptyRow}>No items on this invoice.</p>
          </div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Item</th>
                <th className={styles.tableRight}>Qty</th>
                <th className={styles.tableRight}>Unit</th>
                <th className={styles.tableRight}>Disc</th>
                <th className={styles.tableRight}>Total</th>
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
                    {isEditing ? (
                      <>
                        <td className={styles.tableRight}>
                          <input type="number" min={0} className={styles.fieldInput} style={{ width: 80, textAlign: "right" }} value={d.qty} disabled={isLocked} onChange={(e) => setLine(it, { qty: Number(e.target.value) || 0 })} />
                        </td>
                        <td className={styles.tableRight}>
                          <InlineRmInput valueCenti={d.unitPriceCenti} disabled={isLocked} onCommit={(centi) => setLine(it, { unitPriceCenti: centi })} style={{ width: 110 }} />
                        </td>
                        <td className={styles.tableRight}>
                          <InlineRmInput valueCenti={d.discountCenti} disabled={isLocked} onCommit={(centi) => setLine(it, { discountCenti: centi })} style={{ width: 100 }} />
                        </td>
                        <td className={styles.priceCell}>{fmtRm(d.qty * d.unitPriceCenti - d.discountCenti, pi.currency)}</td>
                        <td className={styles.tableRight}>
                          <button
                            type="button"
                            className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                            title="Remove line"
                            disabled={isLocked || deleteItem.isPending}
                            onClick={async () => {
                              if (isLocked) return;
                              if (await dialog.confirm("Remove this line? The source GRN line is released for re-invoicing.")) {
                                deleteItem.mutate({ piId: pi.id, itemId: it.id });
                              }
                            }}
                          >
                            <Trash2 {...SM_ICON} />
                          </button>
                        </td>
                      </>
                    ) : (
                      <>
                        <td className={styles.tableRight}>{it.qty}</td>
                        <td className={styles.tableRight}>{fmtRm(it.unit_price_centi, pi.currency)}</td>
                        <td className={styles.tableRight}>{(it.discount_centi ?? 0) > 0 ? fmtRm(it.discount_centi, pi.currency) : "—"}</td>
                        <td className={styles.priceCell}>{fmtRm(it.line_total_centi, pi.currency)}</td>
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
            <div className={styles.totalRow}>
              <span className={styles.totalLabel}>Subtotal</span>
              <span className={styles.totalValue}>{fmtRm(itemsSubtotal, pi.currency)}</span>
            </div>
            <div className={styles.totalRow}>
              <span className={styles.totalLabel}>Tax</span>
              <span className={styles.totalValue}>{fmtRm(pi.tax_centi, pi.currency)}</span>
            </div>
            <div className={`${styles.totalRow} ${styles.grandTotalRow}`}>
              <span className={styles.totalLabel}>Total</span>
              <span className={`${styles.totalValue} ${styles.grandTotal}`}>{fmtRm(grandTotal, pi.currency)}</span>
            </div>
            <div className={styles.totalRow}>
              <span className={styles.totalLabel}>Paid</span>
              <span className={styles.totalValue}>{fmtRm(pi.paid_centi, pi.currency)}</span>
            </div>
            <div className={styles.totalRow}>
              <span className={styles.totalLabel}>Balance</span>
              <span className={styles.totalValue}>{fmtRm(balance, pi.currency)}</span>
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

const HeaderCard = ({ pi, draft, onField, locked, isEditing }: { pi: PiRow; draft: HeaderDraft; onField: (k: keyof HeaderDraft, v: string) => void; locked: boolean; isEditing: boolean }) => {
  return (
    <section className={styles.card}>
      <header className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>Supplier · Dates · Notes</h2>
      </header>
      <div className={styles.cardBody}>
        {!isEditing ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "var(--space-3) var(--space-4)", fontFamily: "var(--font-sans)", fontSize: "var(--fs-13)" }}>
            <div style={{ gridColumn: "span 2" }}>
              <InfoCell label="Supplier" value={pi.supplier?.name ?? pi.supplier?.code ?? null} />
            </div>
            <InfoCell label="Source (GRN/PO)" value={pi.grn?.grn_number ?? pi.purchase_order?.po_number ?? null} />
            <InfoCell label="Supplier Invoice #" value={pi.supplier_invoice_ref || null} />
            <InfoCell label="Invoice Date" value={fmtDateOrDash(pi.invoice_date)} />
            <InfoCell label="Due Date" value={fmtDateOrDash(pi.due_date)} />
            <div style={{ gridColumn: "span 2" }}>
              <InfoCell label="Notes" value={pi.notes || null} />
            </div>
          </div>
        ) : (
          <div className={styles.formGrid4}>
            <label className={styles.field} style={{ gridColumn: "span 2" }}>
              <span className={styles.fieldLabel}>Supplier Invoice #</span>
              <input className={styles.fieldInput} value={draft.supplierInvoiceRef} disabled={locked} onChange={(e) => onField("supplierInvoiceRef", e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Invoice Date</span>
              <input type="date" className={styles.fieldInput} value={draft.invoiceDate} disabled={locked} onChange={(e) => onField("invoiceDate", e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Due Date</span>
              <input type="date" className={styles.fieldInput} value={draft.dueDate} disabled={locked} onChange={(e) => onField("dueDate", e.target.value)} />
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
