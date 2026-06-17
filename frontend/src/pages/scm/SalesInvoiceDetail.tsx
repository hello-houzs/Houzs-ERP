// ----------------------------------------------------------------------------
// SalesInvoiceDetail — full-page route at /sales-invoices/:id.
//
// 1:1 clone of 2990s apps/backend/src/pages/SalesInvoiceDetail.tsx (a DO-detail
// clone): header card, line items (View read-only; Edit = inline qty/unit/
// discount/delete), a payments ledger (record + list), and status transitions
// (Cancel from active; Reopen a cancelled SENT). A SI is editable while not
// cancelled. SEAM (rule #9 + #10): DataGrid/MoneyInput -> <table> + inline RM
// editor; useDialog/useToast (never window.confirm/alert).
//
// Strategy-2 + scope: GL/AR posting is out of SCM-clone scope — there is no
// "revenue posted" badge; the doc + payment status are functional.
// ----------------------------------------------------------------------------

import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, FileText, Pencil, Trash2, Save, Ban, Plus, RotateCcw } from "lucide-react";
import { Button } from "../../components/Button";
import {
  useSalesInvoiceDetail,
  useSalesInvoicePayments,
  useRecordSalesInvoicePayment,
  useUpdateSalesInvoiceStatus,
  useUpdateSalesInvoiceItem,
  useDeleteSalesInvoiceItem,
  type SiItemRow,
  type SiStatus,
} from "./delivery-billing-queries";
import { useDialog } from "../../hooks/useDialog";
import { useToast } from "../../hooks/useToast";
import styles from "./PurchaseOrderDetail.module.css";

const ICON = { size: 16, strokeWidth: 1.75 } as const;
const SM_ICON = { size: 14, strokeWidth: 1.75 } as const;

const STATUS_LABEL: Record<SiStatus, string> = { SENT: "Sent", PARTIALLY_PAID: "Partially Paid", PAID: "Paid", OVERDUE: "Overdue", CANCELLED: "Cancelled" };

const fmtRm = (centi: number | null | undefined, currency = "MYR"): string => `${currency} ${((centi ?? 0) / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDateOrDash = (iso: string | null | undefined): string => { if (!iso) return "—"; const d = new Date(iso); if (!Number.isFinite(d.getTime())) return iso; return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }); };

type LineDraft = { qty: number; unitPriceCenti: number; discountCenti: number };
const lineSnapshot = (it: SiItemRow): LineDraft => ({ qty: it.qty, unitPriceCenti: it.unit_price_centi, discountCenti: it.discount_centi });

export const SalesInvoiceDetail = () => {
  const { id } = useParams<{ id: string }>();
  const dialog = useDialog();
  const toast = useToast();
  const detail = useSalesInvoiceDetail(id ?? null);
  const setStatus = useUpdateSalesInvoiceStatus();
  const updateItem = useUpdateSalesInvoiceItem();
  const deleteItem = useDeleteSalesInvoiceItem();

  const si = detail.data?.salesInvoice ?? null;
  const items = detail.data?.items ?? [];

  const [searchParams] = useSearchParams();
  const [isEditing, setIsEditing] = useState(() => searchParams.get("edit") === "1");
  const [lineDrafts, setLineDrafts] = useState<Record<string, LineDraft>>({});
  const [savingDraft, setSavingDraft] = useState(false);

  const isLocked = si ? si.status === "CANCELLED" : true;

  useEffect(() => { if (isLocked && isEditing) { setIsEditing(false); setLineDrafts({}); } }, [isLocked, isEditing]);

  if (detail.isLoading) return <div className={styles.page}><p className={styles.eyebrow}>Loading sales invoice…</p></div>;
  if (detail.isError || !si) {
    return (
      <div className={styles.page}>
        <Link to="/sales-invoices" className={styles.backBtn}><ArrowLeft {...ICON} /><span>Back</span></Link>
        <div className={styles.bannerWarn}><strong>Sales invoice not found.</strong>{detail.error instanceof Error ? ` ${detail.error.message}` : null}</div>
      </div>
    );
  }

  const lineOf = (it: SiItemRow): LineDraft => lineDrafts[it.id] ?? lineSnapshot(it);
  const lineTotalOf = (it: SiItemRow): number => { if (!isEditing) return it.line_total_centi ?? 0; const d = lineOf(it); return d.qty * d.unitPriceCenti - d.discountCenti + (it.tax_centi ?? 0); };
  const totalValue = items.reduce((s, it) => s + lineTotalOf(it), 0);
  const setLine = (it: SiItemRow, patch: Partial<LineDraft>) => setLineDrafts((prev) => ({ ...prev, [it.id]: { ...(prev[it.id] ?? lineSnapshot(it)), ...patch } }));

  const handleSave = async () => {
    if (savingDraft) return;
    setSavingDraft(true);
    try {
      for (const it of items) {
        const d = lineDrafts[it.id];
        if (!d) continue;
        if (d.qty !== it.qty || d.unitPriceCenti !== it.unit_price_centi || d.discountCenti !== it.discount_centi) {
          await updateItem.mutateAsync({ id: si.id, itemId: it.id, qty: d.qty, unitPriceCenti: d.unitPriceCenti, discountCenti: d.discountCenti });
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

  const doCancel = async () => {
    if (!(await dialog.confirm(`Cancel invoice ${si.invoice_number}? This sets status to CANCELLED — its qty returns to the invoiceable pool. Line items stay for audit.`))) return;
    setStatus.mutate({ id: si.id, status: "CANCELLED" }, { onError: (e) => toast.error(`Cancel failed: ${e instanceof Error ? e.message : String(e)}`) });
  };
  const doReopen = async () => {
    if (!(await dialog.confirm(`Reopen invoice ${si.invoice_number} to Sent? Payment status is re-derived from the ledger.`))) return;
    setStatus.mutate({ id: si.id, status: "ISSUED" }, { onError: (e) => toast.error(`Reopen failed: ${e instanceof Error ? e.message : String(e)}`) });
  };

  const balance = Math.max(0, (si.total_centi ?? 0) - (si.paid_centi ?? 0));

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div className={styles.titleBlock}>
          <Link to="/sales-invoices" className={styles.backBtn}><ArrowLeft {...ICON} /><span>Back</span></Link>
          <div><h1 className={styles.title}><FileText size={14} strokeWidth={1.75} style={{ color: "var(--c-burnt)" }} />{si.invoice_number} — {si.debtor_name}</h1></div>
        </div>
        <div className={styles.actions}>
          <div className={styles.totalRail}><span className={styles.totalRailLabel}>Balance</span><span className={styles.totalRailValue}>{fmtRm(balance, si.currency)}</span></div>
          <span className={`${styles.statusPill} ${si.status === "CANCELLED" ? styles.statusCancelled ?? "" : styles.statusDelivered ?? ""}`}>{STATUS_LABEL[si.status] ?? si.status}</span>
          {si.status !== "CANCELLED" && (si.paid_centi ?? 0) === 0 && (<Button variant="ghost" onClick={doCancel} disabled={setStatus.isPending}><Ban {...ICON} /><span>{setStatus.isPending ? "Cancelling…" : "Cancel"}</span></Button>)}
          {si.status === "CANCELLED" && (<Button variant="ghost" onClick={doReopen} disabled={setStatus.isPending}><RotateCcw {...ICON} /><span>Reopen</span></Button>)}
          {!isEditing ? (
            <Button variant="primary" onClick={() => { setLineDrafts({}); setIsEditing(true); }} disabled={isLocked}><Pencil {...ICON} /><span>Edit</span></Button>
          ) : (
            <Button variant="primary" onClick={handleSave} disabled={savingDraft}><Save {...ICON} /><span>{savingDraft ? "Saving…" : "Save"}</span></Button>
          )}
        </div>
      </div>

      <section className={styles.card}>
        <header className={styles.cardHeader}><h2 className={styles.cardTitle}>Customer · Dates · Source</h2></header>
        <div className={styles.cardBody}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "var(--space-3) var(--space-4)", fontFamily: "var(--font-sans)", fontSize: "var(--fs-13)" }}>
            <div style={{ gridColumn: "span 2" }}><InfoCell label="Customer" value={si.debtor_name} /></div>
            <InfoCell label="Sales Order" value={si.so_doc_no} />
            <InfoCell label="Invoice Date" value={fmtDateOrDash(si.invoice_date)} />
            <InfoCell label="Due Date" value={fmtDateOrDash(si.due_date)} />
            <InfoCell label="Total" value={fmtRm(si.total_centi, si.currency)} />
            <InfoCell label="Paid" value={fmtRm(si.paid_centi, si.currency)} />
            <div style={{ gridColumn: "span 2" }}><InfoCell label="Ref" value={si.ref} /></div>
            <div style={{ gridColumn: "span 4" }}><InfoCell label="Notes" value={si.notes} /></div>
          </div>
        </div>
      </section>

      <section className={styles.card}>
        <header className={styles.cardHeader}><h2 className={styles.cardTitle}>Line Items ({items.length})</h2></header>
        {items.length === 0 ? (
          <div className={styles.cardBody}><p className={styles.emptyRow}>No items on this invoice.</p></div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Item</th>
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
                return (
                  <tr key={it.id}>
                    <td><div className={styles.codeCell}>{it.item_code}</div>{summary ? <div className={styles.muted} style={{ fontSize: "var(--fs-11)" }}>{summary}</div> : null}</td>
                    {isEditing ? (
                      <>
                        <td className={styles.tableRight}><input type="number" min={1} className={styles.fieldInput} style={{ width: 70, textAlign: "right" }} value={d.qty} disabled={isLocked} onChange={(e) => setLine(it, { qty: Number(e.target.value) || 0 })} /></td>
                        <td className={styles.tableRight}><InlineRmInput valueCenti={d.unitPriceCenti} disabled={isLocked} onCommit={(centi) => setLine(it, { unitPriceCenti: centi })} style={{ width: 100 }} /></td>
                        <td className={styles.tableRight}><InlineRmInput valueCenti={d.discountCenti} disabled={isLocked} onCommit={(centi) => setLine(it, { discountCenti: centi })} style={{ width: 90 }} /></td>
                        <td className={styles.priceCell}>{fmtRm(d.qty * d.unitPriceCenti - d.discountCenti + (it.tax_centi ?? 0))}</td>
                        <td className={styles.tableRight}>
                          <button type="button" className={`${styles.iconBtn} ${styles.iconBtnDanger}`} title="Remove line" disabled={isLocked || deleteItem.isPending}
                            onClick={async () => { if (isLocked) return; if (await dialog.confirm("Remove this line from the invoice?")) deleteItem.mutate({ id: si.id, itemId: it.id }, { onError: (e) => toast.error(`Remove failed: ${e instanceof Error ? e.message : String(e)}`) }); }}>
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

      <PaymentsPanel salesInvoiceId={si.id} currency={si.currency} balanceCenti={balance} locked={si.status === "CANCELLED"} />

      <section className={styles.card}>
        <header className={styles.cardHeader}><h2 className={styles.cardTitle}>Totals</h2></header>
        <div className={styles.cardBody}>
          <div className={styles.totalsGrid}>
            <div className={styles.totalRow}><span className={styles.totalLabel}>Total</span><span className={styles.totalValue}>{fmtRm(totalValue, si.currency)}</span></div>
            <div className={styles.totalRow}><span className={styles.totalLabel}>Paid</span><span className={styles.totalValue}>{fmtRm(si.paid_centi, si.currency)}</span></div>
            <div className={`${styles.totalRow} ${styles.grandTotalRow}`}><span className={styles.totalLabel}>Balance</span><span className={`${styles.totalValue} ${styles.grandTotal}`}>{fmtRm(balance, si.currency)}</span></div>
          </div>
        </div>
      </section>
    </div>
  );
};

/* Payments panel — record a payment + list the ledger. */
const PaymentsPanel = ({ salesInvoiceId, currency, balanceCenti, locked }: { salesInvoiceId: string; currency: string; balanceCenti: number; locked: boolean }) => {
  const toast = useToast();
  const payQ = useSalesInvoicePayments(salesInvoiceId);
  const record = useRecordSalesInvoicePayment();
  const payments = payQ.data ?? [];
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<"cash" | "transfer" | "merchant" | "installment">("cash");

  const submit = () => {
    const n = Number(amount.trim());
    if (!Number.isFinite(n) || n <= 0) { toast.error("Enter a positive amount."); return; }
    record.mutate(
      { id: salesInvoiceId, paidAt: new Date().toISOString().slice(0, 10), method, amountCenti: Math.round(n * 100) },
      { onSuccess: () => { setAmount(""); toast.success("Payment recorded."); }, onError: (e) => toast.error(`Payment failed: ${e instanceof Error ? e.message : String(e)}`) },
    );
  };

  return (
    <section className={styles.card}>
      <header className={styles.cardHeader}><h2 className={styles.cardTitle}>Payments ({payments.length})</h2></header>
      {!locked && (
        <div className={styles.cardBody}>
          <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "flex-end", flexWrap: "wrap" }}>
            <label className={styles.field}><span className={styles.fieldLabel}>Amount ({currency})</span><input className={styles.fieldInput} style={{ width: 140 }} inputMode="decimal" value={amount} placeholder={(balanceCenti / 100).toFixed(2)} onChange={(e) => setAmount(e.target.value)} /></label>
            <label className={styles.field}><span className={styles.fieldLabel}>Method</span>
              <select className={styles.fieldInput} style={{ width: 140 }} value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
                <option value="cash">Cash</option>
                <option value="transfer">Transfer</option>
                <option value="merchant">Merchant</option>
                <option value="installment">Installment</option>
              </select>
            </label>
            <Button variant="primary" onClick={submit} disabled={record.isPending}><Plus {...ICON} /><span>{record.isPending ? "Recording…" : "Record payment"}</span></Button>
          </div>
        </div>
      )}
      {payments.length > 0 && (
        <table className={styles.table}>
          <thead><tr><th>Date</th><th>Method</th><th className={styles.tableRight}>Amount</th><th>By</th></tr></thead>
          <tbody>
            {payments.map((p) => (
              <tr key={p.id}><td>{fmtDateOrDash(p.paid_at)}</td><td>{p.method ?? "—"}</td><td className={styles.priceCell}>{fmtRm(p.amount_centi, currency)}</td><td className={styles.muted}>{p.collected_by_name ?? "—"}</td></tr>
            ))}
          </tbody>
        </table>
      )}
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
