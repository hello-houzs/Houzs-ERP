// ----------------------------------------------------------------------------
// SalesOrderDetail — full-page route at /sales-orders/:docNo.
//
// Faithful Houzs-style port of 2990s apps/backend/src/pages/SalesOrderDetail.tsx,
// trimmed to the generic document surface (the furniture configurator + PWP +
// sofa-exchange + delivery/invoice smart-buttons are dropped per Strategy-2 / the
// not-yet-cloned DO/SI slices). Sections:
//   1. Header: back + doc no + status pill + Total rail + status dropdown
//   2. Customer + Order info card
//   3. Line items table (view read-only; Edit = inline qty/unit/disc + group/
//      code/description) with per-line Stock Status pill + READY/PENDING toggle
//   4. Totals card (category subtotals + total/margin, computed by the server)
//   5. Payments panel (record / delete; balance live)
//   6. History (the unified audit log)
//
// SEAM changes (the established slice playbook):
//   - Data layer: 2990s flow-queries -> the SO hooks in ./sales-orders-queries
//     (Houzs api client + TanStack). Identical request/response shapes (rule #7).
//   - Components: @2990s/design-system Button -> Houzs components/Button; 2990s
//     MoneyInput -> minimal inline RM<->centi editors; react-router ->
//     react-router-dom; useConfirm/ConfirmDialog -> window.confirm (1:1 with the
//     other done slices).
//
// Strategy-2 / cross-slice notes:
//   - Furniture variant editor / OverridePriceModal / VariantsPills configurator
//     -> a plain inline line editor (group/code/description/qty/price/discount).
//   - Delivered breakdown / Issue DO / Issue SI / Delivery Returns / MRP coverage
//     come from the DO/SI/MRP slices (not cloned) -> not surfaced. The server
//     returns faithful empties.
//   - Customer-facing PDF print (jspdf) -> dropped. TODO: print slice.
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, Pencil, Trash2, Save, ChevronDown, Plus } from "lucide-react";
import { Button } from "../../components/Button";
import {
  useSalesOrderDetail,
  useUpdateSalesOrder,
  useUpdateSalesOrderStatus,
  useUpdateSalesOrderItem,
  useDeleteSalesOrderItem,
  useAddSalesOrderItem,
  useSalesOrderPayments,
  useRecordSalesOrderPayment,
  useDeleteSalesOrderPayment,
  useSalesOrderAuditLog,
  useSetSalesOrderItemStockStatus,
  type SoItemRow,
  type SoStatus,
} from "./sales-orders-queries";
import styles from "./PurchaseOrderDetail.module.css";

const ICON = { size: 16, strokeWidth: 1.75 } as const;
const SM_ICON = { size: 14, strokeWidth: 1.75 } as const;

const STATUSES: SoStatus[] = ["CONFIRMED", "IN_PRODUCTION", "READY_TO_SHIP", "SHIPPED", "DELIVERED", "INVOICED", "CLOSED", "ON_HOLD", "CANCELLED"];
const STATUS_LABEL: Record<string, string> = {
  CONFIRMED: "Confirmed",
  IN_PRODUCTION: "In Production",
  READY_TO_SHIP: "Ready to Ship",
  SHIPPED: "Shipped",
  DELIVERED: "Delivered",
  INVOICED: "Invoiced",
  CLOSED: "Closed",
  ON_HOLD: "On Hold",
  CANCELLED: "Cancelled",
};
const statusClass = (s: string): string => {
  if (s === "CANCELLED") return styles.statusCancelled ?? "";
  if (s === "DELIVERED" || s === "INVOICED" || s === "CLOSED") return styles.statusDelivered ?? "";
  if (s === "IN_PRODUCTION" || s === "READY_TO_SHIP" || s === "SHIPPED") return styles.statusInProd ?? "";
  return styles.statusConfirmed ?? "";
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

type LineDraft = { qty: number; unitPriceCenti: number; discountCenti: number; itemCode: string; description: string; itemGroup: string };

export const SalesOrderDetail = () => {
  const { docNo } = useParams<{ docNo: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const editing = searchParams.get("edit") === "1";

  const { data, isLoading, error } = useSalesOrderDetail(docNo);
  const payQ = useSalesOrderPayments(docNo);
  const auditQ = useSalesOrderAuditLog(docNo);

  const updateHeader = useUpdateSalesOrder();
  const updateStatus = useUpdateSalesOrderStatus();
  const updateItem = useUpdateSalesOrderItem();
  const deleteItem = useDeleteSalesOrderItem();
  const addItem = useAddSalesOrderItem();
  const recordPayment = useRecordSalesOrderPayment();
  const deletePayment = useDeleteSalesOrderPayment();
  const setStockStatus = useSetSalesOrderItemStockStatus();

  const so = data?.salesOrder;
  const items = useMemo(() => data?.items ?? [], [data]);
  const currency = so?.currency ?? "MYR";

  // Inline per-line draft (only in edit mode).
  const [lineDraft, setLineDraft] = useState<Record<string, LineDraft>>({});
  useEffect(() => {
    if (!editing) {
      setLineDraft({});
      return;
    }
    const next: Record<string, LineDraft> = {};
    for (const it of items) {
      next[it.id] = {
        qty: it.qty,
        unitPriceCenti: it.unit_price_centi,
        discountCenti: it.discount_centi,
        itemCode: it.item_code,
        description: it.description ?? "",
        itemGroup: it.item_group,
      };
    }
    setLineDraft(next);
  }, [editing, items]);

  const setEdit = (on: boolean) => {
    const next = new URLSearchParams(searchParams);
    if (on) next.set("edit", "1");
    else next.delete("edit");
    setSearchParams(next, { replace: true });
  };

  const onSaveLines = async () => {
    try {
      for (const it of items) {
        const d = lineDraft[it.id];
        if (!d) continue;
        const changed =
          d.qty !== it.qty ||
          d.unitPriceCenti !== it.unit_price_centi ||
          d.discountCenti !== it.discount_centi ||
          d.itemCode !== it.item_code ||
          d.description !== (it.description ?? "") ||
          d.itemGroup !== it.item_group;
        if (!changed) continue;
        await updateItem.mutateAsync({
          docNo: docNo!,
          itemId: it.id,
          patch: { qty: d.qty, unitPriceCenti: d.unitPriceCenti, discountCenti: d.discountCenti, itemCode: d.itemCode, description: d.description, itemGroup: d.itemGroup },
        });
      }
      setEdit(false);
    } catch (e) {
      window.alert(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const onDeleteLine = (it: SoItemRow) => {
    if (!confirm(`Delete line ${it.item_code}?`)) return;
    deleteItem.mutate({ docNo: docNo!, itemId: it.id }, { onError: (e) => window.alert(`Delete failed: ${e instanceof Error ? e.message : String(e)}`) });
  };

  const onAddLine = () => {
    addItem.mutate(
      { docNo: docNo!, item: { itemGroup: "others", itemCode: "NEW-ITEM", description: "New line", qty: 1, unitPriceCenti: 0 } },
      { onError: (e) => window.alert(`Add failed: ${e instanceof Error ? e.message : String(e)}`) },
    );
  };

  const onChangeStatus = (status: SoStatus) => {
    if (!so || status === so.status) return;
    if (status === "CANCELLED" && !confirm(`Cancel Sales Order ${docNo}? A cancelled SO is final.`)) return;
    updateStatus.mutate({ docNo: docNo!, status }, { onError: (e) => window.alert(`Status change failed: ${e instanceof Error ? e.message : String(e)}`) });
  };

  const toggleStock = (it: SoItemRow) => {
    const next = it.stock_status === "READY" ? "PENDING" : "READY";
    setStockStatus.mutate({ docNo: docNo!, itemId: it.id, status: next }, { onError: (e) => window.alert(`Stock status failed: ${e instanceof Error ? e.message : String(e)}`) });
  };

  if (isLoading) return <div className={styles.page}><p className={styles.emptyRow}>Loading sales order…</p></div>;
  if (error || !so) {
    return (
      <div className={styles.page}>
        <Link to="/sales-orders" className={styles.backBtn}>
          <ArrowLeft {...ICON} />
          <span>Back</span>
        </Link>
        <div className={styles.bannerWarn}>
          <strong>Failed to load sales order.</strong> {error instanceof Error ? error.message : "Not found."}
        </div>
      </div>
    );
  }

  const locked = so.status === "CANCELLED" || so.status === "INVOICED" || so.status === "CLOSED";

  return (
    <div className={styles.page}>
      {/* Header. */}
      <div className={styles.headerRow}>
        <div className={styles.titleBlock}>
          <Link to="/sales-orders" className={styles.backBtn}>
            <ArrowLeft {...ICON} />
            <span>Back</span>
          </Link>
          <div>
            <h1 className={styles.title}>
              {so.doc_no} <span className={`${styles.statusPill} ${statusClass(so.status)}`}>{STATUS_LABEL[so.status] ?? so.status}</span>
            </h1>
            <div style={{ fontSize: "var(--fs-13)", color: "var(--c-muted, #888)" }}>{so.debtor_name}</div>
          </div>
        </div>
        <div className={styles.actions}>
          <div className={styles.totalRail}>
            <span className={styles.totalRailLabel}>Total</span>
            <span className={styles.totalRailValue}>{fmtRm(so.total_revenue_centi ?? so.local_total_centi, currency)}</span>
          </div>
          {/* Status dropdown. */}
          <span className={styles.selectWrap}>
            <select className={styles.fieldSelect} value={so.status} disabled={updateStatus.isPending} onChange={(e) => onChangeStatus(e.target.value as SoStatus)}>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
            <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
          </span>
          {!editing ? (
            <Button variant="ghost" onClick={() => setEdit(true)} disabled={locked}>
              <Pencil {...ICON} />
              <span>Edit Lines</span>
            </Button>
          ) : (
            <Button variant="primary" onClick={onSaveLines} disabled={updateItem.isPending}>
              <Save {...ICON} />
              <span>Save</span>
            </Button>
          )}
        </div>
      </div>

      {/* Customer + Order info. */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Customer &amp; Order</h2>
        </header>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <Info label="Customer">{so.debtor_name}</Info>
            <Info label="Phone">{so.phone ?? "—"}</Info>
            <Info label="Customer Code">{so.debtor_code ?? "—"}</Info>
            <Info label="SO Date">{fmtDateOrDash(so.so_date)}</Info>
            <Info label="Address">{[so.address1, so.address2, so.city, so.postcode, so.customer_state].filter(Boolean).join(", ") || "—"}</Info>
            <Info label="Customer PO">{so.po_doc_no ?? "—"}</Info>
            <Info label="Reference">{so.ref ?? "—"}</Info>
            <Info label="Delivery Date">{fmtDateOrDash(so.customer_delivery_date)}</Info>
            <Info label="Processing Date">{fmtDateOrDash(so.internal_expected_dd)}</Info>
            <Info label="Agent">{so.agent ?? "—"}</Info>
            <Info label="Branding">{so.branding ?? "—"}</Info>
            <Info label="Stock Remark">{so.stock_remark || "—"}</Info>
          </div>
        </div>
      </section>

      {/* Line items. */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Line Items ({items.length})</h2>
          {editing && !locked && (
            <Button variant="ghost" onClick={onAddLine} disabled={addItem.isPending}>
              <Plus {...SM_ICON} />
              <span>Add line</span>
            </Button>
          )}
        </header>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Group</th>
              <th>Item Code</th>
              <th>Description</th>
              <th className={styles.tableRight}>Qty</th>
              <th className={styles.tableRight}>Unit Price</th>
              <th className={styles.tableRight}>Disc</th>
              <th className={styles.tableRight}>Line Total</th>
              <th>Stock</th>
              {editing && <th className={styles.tableRight}>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={editing ? 9 : 8}>
                  <p className={styles.emptyRow}>No line items.</p>
                </td>
              </tr>
            ) : (
              items.map((it) => {
                const d = lineDraft[it.id];
                const live = editing && d ? d.qty * d.unitPriceCenti - d.discountCenti : it.total_centi;
                return (
                  <tr key={it.id} style={it.cancelled ? { opacity: 0.5 } : undefined}>
                    <td>
                      {editing && d ? (
                        <input className={styles.fieldInput} style={{ width: 90 }} value={d.itemGroup} onChange={(e) => setLineDraft((p) => ({ ...p, [it.id]: { ...d, itemGroup: e.target.value } }))} />
                      ) : (
                        it.item_group
                      )}
                    </td>
                    <td>
                      {editing && d ? (
                        <input className={styles.fieldInput} style={{ width: 120 }} value={d.itemCode} onChange={(e) => setLineDraft((p) => ({ ...p, [it.id]: { ...d, itemCode: e.target.value } }))} />
                      ) : (
                        <span className={styles.codeCell}>{it.item_code}</span>
                      )}
                    </td>
                    <td>
                      {editing && d ? (
                        <input className={styles.fieldInput} style={{ width: 200 }} value={d.description} onChange={(e) => setLineDraft((p) => ({ ...p, [it.id]: { ...d, description: e.target.value } }))} />
                      ) : (
                        it.description2 || it.description || "—"
                      )}
                    </td>
                    <td className={styles.tableRight}>
                      {editing && d ? (
                        <input type="number" min={1} className={styles.fieldInput} style={{ width: 64, textAlign: "right" }} value={d.qty} onChange={(e) => setLineDraft((p) => ({ ...p, [it.id]: { ...d, qty: Math.max(1, Number(e.target.value) || 1) } }))} />
                      ) : (
                        it.qty
                      )}
                    </td>
                    <td className={styles.tableRight}>
                      {editing && d ? (
                        <InlineRmInput valueCenti={d.unitPriceCenti} onCommit={(c) => setLineDraft((p) => ({ ...p, [it.id]: { ...d, unitPriceCenti: c } }))} style={{ width: 100 }} />
                      ) : (
                        fmtRm(it.unit_price_centi, currency)
                      )}
                    </td>
                    <td className={styles.tableRight}>
                      {editing && d ? (
                        <InlineRmInput valueCenti={d.discountCenti} onCommit={(c) => setLineDraft((p) => ({ ...p, [it.id]: { ...d, discountCenti: c } }))} style={{ width: 90 }} />
                      ) : (
                        fmtRm(it.discount_centi, currency)
                      )}
                    </td>
                    <td className={styles.priceCell}>{fmtRm(live, currency)}</td>
                    <td>
                      <button type="button" className={`${styles.statusPill} ${it.stock_status === "READY" ? styles.statusDelivered : styles.statusConfirmed}`} style={{ cursor: "pointer", border: "none" }} title="Toggle READY / PENDING" onClick={() => toggleStock(it)} disabled={setStockStatus.isPending || it.cancelled}>
                        {it.stock_status}
                      </button>
                    </td>
                    {editing && (
                      <td className={styles.tableRight}>
                        <button type="button" className={`${styles.iconBtn} ${styles.iconBtnDanger}`} title="Delete line" onClick={() => onDeleteLine(it)}>
                          <Trash2 {...SM_ICON} />
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </section>

      {/* Totals. */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Totals</h2>
        </header>
        <div className={styles.cardBody}>
          <TotalRow label="Mattress / Sofa" value={fmtRm(so.mattress_sofa_centi, currency)} />
          <TotalRow label="Bedframe" value={fmtRm(so.bedframe_centi, currency)} />
          <TotalRow label="Accessories" value={fmtRm(so.accessories_centi, currency)} />
          <TotalRow label="Service" value={fmtRm(so.service_centi, currency)} />
          <TotalRow label="Others" value={fmtRm(so.others_centi, currency)} />
          <div className={styles.grandTotalRow}>
            <span className={styles.totalLabel}>Local Total</span>
            <span className={styles.grandTotal}>{fmtRm(so.local_total_centi, currency)}</span>
          </div>
          <TotalRow label="Paid" value={fmtRm(so.paid_centi_total ?? so.paid_centi, currency)} />
          <TotalRow label="Balance" value={fmtRm(so.balance_centi, currency)} />
        </div>
      </section>

      {/* Payments. */}
      <PaymentsPanel
        docNo={docNo!}
        currency={currency}
        payments={payQ.data ?? []}
        loading={payQ.isLoading}
        onRecord={recordPayment}
        onDelete={deletePayment}
        balanceCenti={so.balance_centi ?? 0}
      />

      {/* History. */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>History</h2>
        </header>
        <div className={styles.cardBody}>
          {auditQ.isLoading ? (
            <p className={styles.emptyRow}>Loading history…</p>
          ) : (auditQ.data ?? []).length === 0 ? (
            <p className={styles.emptyRow}>No history yet.</p>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "var(--space-2)" }}>
              {(auditQ.data ?? []).map((e) => (
                <li key={e.id} style={{ fontSize: "var(--fs-13)", borderBottom: "1px solid var(--line)", paddingBottom: 6 }}>
                  <strong>{e.action}</strong> · {e.actor_name_snapshot ?? "system"} · <span style={{ color: "var(--c-muted, #888)" }}>{fmtDateOrDash(e.created_at)}</span>
                  {e.note && <div style={{ color: "var(--c-muted, #888)" }}>{e.note}</div>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
};

const Info = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className={styles.field}>
    <span className={styles.fieldLabel}>{label}</span>
    <div style={{ fontSize: "var(--fs-13)", paddingTop: 4 }}>{children}</div>
  </div>
);

const TotalRow = ({ label, value }: { label: string; value: string }) => (
  <div className={styles.totalRow}>
    <span className={styles.totalLabel}>{label}</span>
    <span className={styles.totalValue}>{value}</span>
  </div>
);

/* Payments panel — record / delete + a live balance. */
const PaymentsPanel = ({
  docNo,
  currency,
  payments,
  loading,
  onRecord,
  onDelete,
  balanceCenti,
}: {
  docNo: string;
  currency: string;
  payments: import("./sales-orders-queries").SoPaymentRow[];
  loading: boolean;
  onRecord: ReturnType<typeof useRecordSalesOrderPayment>;
  onDelete: ReturnType<typeof useDeleteSalesOrderPayment>;
  balanceCenti: number;
}) => {
  const [method, setMethod] = useState<"cash" | "transfer" | "merchant" | "installment">("cash");
  const [amountCenti, setAmountCenti] = useState(0);
  const [paidAt, setPaidAt] = useState(() => new Date().toISOString().slice(0, 10));
  const [approvalCode, setApprovalCode] = useState("");

  const submit = () => {
    if (amountCenti <= 0) {
      window.alert("Enter a payment amount.");
      return;
    }
    onRecord.mutate(
      { docNo, paidAt, method, amountCenti, approvalCode: approvalCode || null },
      {
        onSuccess: () => {
          setAmountCenti(0);
          setApprovalCode("");
        },
        onError: (e) => window.alert(`Payment failed: ${e instanceof Error ? e.message : String(e)}`),
      },
    );
  };

  return (
    <section className={styles.card}>
      <header className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>Payments</h2>
      </header>
      <div className={styles.cardBody}>
        <div className={styles.formGrid4}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Method</span>
            <span className={styles.selectWrap}>
              <select className={styles.fieldSelect} value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
                <option value="cash">Cash</option>
                <option value="transfer">Transfer</option>
                <option value="merchant">Card / Merchant</option>
                <option value="installment">Installment</option>
              </select>
              <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
            </span>
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Amount</span>
            <InlineRmInput valueCenti={amountCenti} onCommit={setAmountCenti} />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Date</span>
            <input type="date" className={styles.fieldInput} value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Approval / Ref</span>
            <input className={styles.fieldInput} value={approvalCode} onChange={(e) => setApprovalCode(e.target.value)} />
          </label>
        </div>
        <div style={{ marginTop: "var(--space-2)", display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
          <Button variant="primary" onClick={submit} disabled={onRecord.isPending}>
            <Plus {...SM_ICON} />
            <span>Record Payment</span>
          </Button>
          <span style={{ fontSize: "var(--fs-13)", color: "var(--c-muted, #888)" }}>Balance: {fmtRm(balanceCenti, currency)}</span>
        </div>
      </div>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Date</th>
            <th>Method</th>
            <th>Ref</th>
            <th>Collected By</th>
            <th className={styles.tableRight}>Amount</th>
            <th className={styles.tableRight}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr>
              <td colSpan={6}>
                <p className={styles.emptyRow}>Loading payments…</p>
              </td>
            </tr>
          ) : payments.length === 0 ? (
            <tr>
              <td colSpan={6}>
                <p className={styles.emptyRow}>No payments recorded.</p>
              </td>
            </tr>
          ) : (
            payments.map((p) => (
              <tr key={p.id}>
                <td>{fmtDateOrDash(p.paid_at)}</td>
                <td>{p.method ?? "—"}{p.is_deposit ? " (deposit)" : ""}</td>
                <td>{p.approval_code ?? "—"}</td>
                <td>{p.collected_by_name ?? "—"}</td>
                <td className={styles.priceCell}>{fmtRm(p.amount_centi, currency)}</td>
                <td className={styles.tableRight}>
                  <button
                    type="button"
                    className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                    title="Delete payment"
                    onClick={() => {
                      if (confirm("Delete this payment?")) onDelete.mutate({ docNo, id: p.id }, { onError: (e) => window.alert(`Delete failed: ${e instanceof Error ? e.message : String(e)}`) });
                    }}
                  >
                    <Trash2 {...SM_ICON} />
                  </button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </section>
  );
};

/* Minimal inline RM<->centi editor. */
const InlineRmInput = ({ valueCenti, onCommit, style }: { valueCenti: number; onCommit: (centi: number) => void; style?: React.CSSProperties }) => {
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
