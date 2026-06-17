// ----------------------------------------------------------------------------
// PurchaseOrderDetail — full-page route at /purchase-orders/:id.
//
// 1:1 clone of 2990s apps/backend/src/pages/PurchaseOrderDetail.tsx:
//   1. Header: back + PO# · supplier + Total rail + status pill + actions
//   2. Supplier · Dates · Notes card (view text / edit inputs, page-owned draft)
//   3. Line items table (View read-only; Edit = inline qty/unit/disc/delivery)
//   4. Totals card (subtotal + tax + total, computed live incl. draft edits)
//   5. View → Edit gate; single top Save commits header + changed lines; Back
//      discards the field-edit draft (no auto-save). Cancel / Reopen / Delete.
//
// SEAM changes (the only deviations from 2990s — same playbook as Suppliers):
//   - Data layer: 2990s lib/suppliers-queries -> the PO query hooks co-located
//     in ./PurchaseOrders (Houzs api client + @tanstack/react-query). Identical
//     request/response shapes (rule #7).
//   - Components: @2990s/design-system Button -> Houzs components/Button; 2990s
//     MoneyInput -> minimal inline RM<->centi editors (same commit ergonomics as
//     the Suppliers slice); react-router -> react-router-dom (rule #9).
//
// Strategy-2 product-layer notes (dropped from the 2990s page):
//   - Furniture PDF print (jspdf purchase-order-pdf, sofa labels) — DROPPED.
//     TODO: wire a generic PO print when the print slice lands.
//   - "Receive Goods" / "Raise Return" / "From Sales Order" smart buttons +
//     the per-line "Received (GRN)" column + the SO-drift banner all depend on
//     the GRN / SO slices (not cloned). DROPPED here (receipts/so_drift come back
//     empty from the API). TODO: wire when GRN/SO slices land.
//   - buildVariantSummary (furniture formatter) -> use description / material
//     name. Purchase Location shows the raw saved id (warehouses not cloned);
//     editable as plain text. TODO: warehouse picker when the Warehouse slice lands.
//   - RelationshipMapButton / SkeletonDetailPage / useConfirm -> plain loading
//     text + window.confirm (no such shared components in this slice).
// ----------------------------------------------------------------------------

import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, FileText, Pencil, Trash2, Save, Ban, ChevronDown, RotateCcw } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "../../components/Button";
import { api } from "../../api/client";
import {
  usePurchaseOrderDetail,
  useUpdatePurchaseOrderHeader,
  useUpdatePurchaseOrderItem,
  useDeletePurchaseOrderItem,
  useCancelPurchaseOrder,
  useReopenPurchaseOrder,
  useDeletePurchaseOrder,
  type PoItemRow,
  type PoHeaderRow,
  type PoStatus,
} from "./PurchaseOrders";
import styles from "./PurchaseOrderDetail.module.css";

const ICON = { size: 16, strokeWidth: 1.75 } as const;
const SM_ICON = { size: 14, strokeWidth: 1.75 } as const;

const STATUS_CLASS: Record<PoStatus, string> = {
  SUBMITTED: styles.statusConfirmed ?? "",
  PARTIALLY_RECEIVED: styles.statusInProd ?? "",
  RECEIVED: styles.statusDelivered ?? "",
  CANCELLED: styles.statusCancelled ?? "",
};

const fmtRm = (centi: number | null | undefined, currency = "MYR"): string => {
  const v = centi ?? 0;
  return `${currency} ${(v / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

/* Draft state shapes (#194). HeaderDraft mirrors the editable header fields;
   LineDraft holds the four inline-editable per-line fields. */
type HeaderDraft = {
  supplierId: string;
  poDate: string;
  expectedAt: string;
  currency: string;
  notes: string;
  purchaseLocationId: string;
};
type LineDraft = {
  qty: number;
  unitPriceCenti: number;
  discountCenti: number;
  deliveryDate: string | null;
};

const headerSnapshot = (p: PoHeaderRow): HeaderDraft => ({
  supplierId: p.supplier_id ?? "",
  poDate: p.po_date ?? "",
  expectedAt: p.expected_at ?? "",
  currency: p.currency ?? "MYR",
  notes: p.notes ?? "",
  purchaseLocationId: p.purchase_location_id ?? "",
});

const lineSnapshot = (it: PoItemRow): LineDraft => ({
  qty: it.qty,
  unitPriceCenti: it.unit_price_centi,
  discountCenti: it.discount_centi ?? 0,
  deliveryDate: it.delivery_date ?? null,
});

export const PurchaseOrderDetail = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const detail = usePurchaseOrderDetail(id ?? null);
  const updateHeader = useUpdatePurchaseOrderHeader();
  const cancel = useCancelPurchaseOrder();
  const reopen = useReopenPurchaseOrder();
  const deletePo = useDeletePurchaseOrder();
  const updateItem = useUpdatePurchaseOrderItem();
  const deleteItem = useDeletePurchaseOrderItem();

  const po = detail.data?.purchaseOrder ?? null;
  const items = detail.data?.items ?? [];

  // View → Edit gate. The list's "Edit" lands here with ?edit=1.
  const [searchParams] = useSearchParams();
  const [isEditing, setIsEditing] = useState(() => searchParams.get("edit") === "1");

  const [headerDraft, setHeaderDraft] = useState<HeaderDraft | null>(null);
  const [lineDrafts, setLineDrafts] = useState<Record<string, LineDraft>>({});
  const [savingDraft, setSavingDraft] = useState(false);

  // POs are always SUBMITTED on create (no DRAFT). Header edits stay open while
  // the PO can still be received (SUBMITTED / PARTIALLY_RECEIVED). has_children
  // (GRN downstream-lock) is always false until the GRN slice lands.
  const hasChildren = Boolean(po?.has_children);
  const isLocked = po ? (!(po.status === "SUBMITTED" || po.status === "PARTIALLY_RECEIVED") || hasChildren) : true;
  const lockedDueToChildren = po ? ((po.status === "SUBMITTED" || po.status === "PARTIALLY_RECEIVED") && hasChildren) : false;

  // If a PO locks while editing (status change), drop back to View + discard.
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
        <p className={styles.eyebrow}>Loading purchase order…</p>
      </div>
    );
  }
  if (detail.isError || !po) {
    return (
      <div className={styles.page}>
        <Link to="/purchase-orders" className={styles.backBtn}>
          <ArrowLeft {...ICON} />
          <span>Back</span>
        </Link>
        <div className={styles.bannerWarn}>
          <strong>Purchase order not found.</strong>
          {detail.error instanceof Error ? ` ${detail.error.message}` : null}
        </div>
      </div>
    );
  }

  const visibleItems = items;
  const lineOf = (it: PoItemRow): LineDraft => lineDrafts[it.id] ?? lineSnapshot(it);
  const lineTotalOf = (it: PoItemRow): number => {
    if (!isEditing) return it.line_total_centi ?? 0;
    const d = lineOf(it);
    return d.qty * d.unitPriceCenti - d.discountCenti;
  };
  const itemsSubtotal = visibleItems.reduce((s, it) => s + lineTotalOf(it), 0);
  const grandTotal = itemsSubtotal + (po.tax_centi ?? 0);

  const headerView = headerDraft ?? headerSnapshot(po);

  const setHeaderField = (k: keyof HeaderDraft, v: string) => {
    setHeaderDraft((h) => ({ ...(h ?? headerSnapshot(po)), [k]: v }));
    // Header Expected Delivery cascades to every line's delivery date.
    if (k === "expectedAt") {
      setLineDrafts((prev) => {
        const next = { ...prev };
        for (const it of items) {
          next[it.id] = { ...(prev[it.id] ?? lineSnapshot(it)), deliveryDate: v || null };
        }
        return next;
      });
    }
  };

  const setLine = (it: PoItemRow, patch: Partial<LineDraft>) =>
    setLineDrafts((prev) => ({ ...prev, [it.id]: { ...(prev[it.id] ?? lineSnapshot(it)), ...patch } }));

  const enterEdit = () => {
    setHeaderDraft(null);
    setLineDrafts({});
    setIsEditing(true);
  };

  // Single Save — commit header (if touched) + every changed line, then back to View.
  const handleSave = async () => {
    if (savingDraft) return;
    setSavingDraft(true);
    try {
      if (headerDraft) {
        await updateHeader.mutateAsync({ id: po.id, ...(headerDraft as Record<string, unknown>) });
      }
      for (const it of items) {
        const d = lineDrafts[it.id];
        if (!d) continue;
        const changed =
          d.qty !== it.qty ||
          d.unitPriceCenti !== it.unit_price_centi ||
          d.discountCenti !== (it.discount_centi ?? 0) ||
          (d.deliveryDate ?? null) !== (it.delivery_date ?? null);
        if (changed) {
          await updateItem.mutateAsync({
            poId: po.id,
            itemId: it.id,
            qty: d.qty,
            unitPriceCenti: d.unitPriceCenti,
            discountCenti: d.discountCenti,
            deliveryDate: d.deliveryDate,
          });
        }
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

  return (
    <div className={styles.page}>
      {/* ── Header ──────────────────────────────────────────────── */}
      <div className={styles.headerRow}>
        <div className={styles.titleBlock}>
          <Link to="/purchase-orders" className={styles.backBtn}>
            <ArrowLeft {...ICON} />
            <span>Back</span>
          </Link>
          <div>
            <h1 className={styles.title}>
              <FileText size={14} strokeWidth={1.75} style={{ color: "var(--c-burnt)" }} />
              {po.po_number} — {po.supplier?.name ?? po.supplier?.code ?? "—"}
            </h1>
          </div>
        </div>
        <div className={styles.actions}>
          <div className={styles.totalRail}>
            <span className={styles.totalRailLabel}>Total</span>
            <span className={styles.totalRailValue}>{fmtRm(grandTotal, po.currency)}</span>
          </div>
          <span className={`${styles.statusPill} ${STATUS_CLASS[po.status]}`}>{po.status.replace(/_/g, " ")}</span>
          {(po.status === "SUBMITTED" || po.status === "PARTIALLY_RECEIVED") && (
            <Button
              variant="ghost"
              onClick={() => {
                if (!confirm(`Cancel PO ${po.po_number}? This sets status to CANCELLED — line items + linked docs stay for audit.`)) return;
                cancel.mutate(po.id, {
                  onError: (err) => window.alert(`Cancel failed: ${err instanceof Error ? err.message : String(err)}`),
                });
              }}
              disabled={cancel.isPending}
            >
              <Ban {...ICON} />
              <span>{cancel.isPending ? "Cancelling…" : "Cancel"}</span>
            </Button>
          )}
          {po.status === "CANCELLED" && (
            <Button
              variant="ghost"
              onClick={() => {
                if (!confirm(`Reopen PO ${po.po_number}? Status returns to SUBMITTED and this PO re-claims its Sales-Order quota.`)) return;
                reopen.mutate(po.id, {
                  onError: (err) => window.alert(`Reopen failed: ${err instanceof Error ? err.message : String(err)}`),
                });
              }}
              disabled={reopen.isPending}
            >
              <RotateCcw {...ICON} />
              <span>{reopen.isPending ? "Reopening…" : "Reopen"}</span>
            </Button>
          )}
          {po.status === "CANCELLED" && (
            <Button
              variant="ghost"
              onClick={() => {
                if (!confirm(`Permanently delete PO ${po.po_number}? This removes the header + all line items and cannot be undone.`)) return;
                deletePo.mutate(po.id, {
                  onSuccess: () => navigate("/purchase-orders"),
                  onError: (err) => window.alert(`Delete failed: ${err instanceof Error ? err.message : String(err)}`),
                });
              }}
              disabled={deletePo.isPending}
            >
              <Trash2 {...ICON} />
              <span>{deletePo.isPending ? "Deleting…" : "Delete"}</span>
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

      {lockedDueToChildren && (
        <div className={styles.bannerWarn}>
          <strong>Locked — has a Goods Receipt.</strong> Cancel or delete the downstream GRN to edit this PO again.
        </div>
      )}

      {/* ── Supplier / dates / currency / notes ─────────────────── */}
      <SupplierCard po={po} draft={headerView} onField={setHeaderField} locked={isLocked} isEditing={isEditing} />

      {/* ── Line items ──────────────────────────────────────────── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Line Items ({visibleItems.length})</h2>
        </header>

        {visibleItems.length === 0 ? (
          <div className={styles.cardBody}>
            <p className={styles.emptyRow}>No items on this PO.</p>
          </div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Item</th>
                <th>Supplier Code</th>
                <th>Group</th>
                <th className={styles.tableRight}>Qty</th>
                <th className={styles.tableRight}>Unit</th>
                <th className={styles.tableRight}>Disc</th>
                <th className={styles.tableRight}>Total</th>
                <th className={styles.tableRight}>Delivery</th>
                {isEditing && <th className={styles.tableRight}>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {visibleItems.map((it) => {
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
                    <td style={{ fontFamily: "var(--font-mono)" }}>{it.supplier_sku?.trim() || "—"}</td>
                    <td className={styles.muted}>{it.item_group ?? it.material_kind}</td>

                    {isEditing ? (
                      <>
                        <td className={styles.tableRight}>
                          <input
                            type="number"
                            min={0}
                            className={styles.fieldInput}
                            style={{ width: 70, textAlign: "right" }}
                            value={d.qty}
                            disabled={isLocked}
                            onChange={(e) => setLine(it, { qty: Number(e.target.value) || 0 })}
                          />
                        </td>
                        <td className={styles.tableRight}>
                          <InlineRmInput
                            valueCenti={d.unitPriceCenti}
                            disabled={isLocked}
                            onCommit={(centi) => setLine(it, { unitPriceCenti: centi })}
                            style={{ width: 110 }}
                          />
                        </td>
                        <td className={styles.tableRight}>
                          <InlineRmInput
                            valueCenti={d.discountCenti}
                            disabled={isLocked}
                            onCommit={(centi) => setLine(it, { discountCenti: centi })}
                            style={{ width: 100 }}
                          />
                        </td>
                        <td className={styles.priceCell}>{fmtRm(d.qty * d.unitPriceCenti - d.discountCenti, po.currency)}</td>
                        <td className={styles.tableRight}>
                          <input
                            type="date"
                            className={styles.fieldInput}
                            style={{ width: 150 }}
                            value={d.deliveryDate ?? ""}
                            disabled={isLocked}
                            onChange={(e) => setLine(it, { deliveryDate: e.target.value || null })}
                          />
                        </td>
                        <td>
                          <span className={styles.actionsCell}>
                            <button
                              type="button"
                              className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                              title="Remove line"
                              disabled={isLocked || deleteItem.isPending}
                              onClick={() => {
                                if (isLocked) return;
                                if (confirm("Remove this line? The line is deleted and its converted SO quantity is released back to the From-SO picker.")) {
                                  deleteItem.mutate({ poId: po.id, itemId: it.id });
                                }
                              }}
                            >
                              <Trash2 {...SM_ICON} />
                            </button>
                          </span>
                        </td>
                      </>
                    ) : (
                      <>
                        <td className={styles.tableRight}>{it.qty}</td>
                        <td className={styles.tableRight}>{fmtRm(it.unit_price_centi, po.currency)}</td>
                        <td className={styles.tableRight}>{(it.discount_centi ?? 0) > 0 ? fmtRm(it.discount_centi, po.currency) : "—"}</td>
                        <td className={styles.priceCell}>{fmtRm(it.line_total_centi, po.currency)}</td>
                        <td className={styles.tableRight}>{it.delivery_date ?? "—"}</td>
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
              <span className={styles.totalValue}>{fmtRm(itemsSubtotal, po.currency)}</span>
            </div>
            <div className={styles.totalRow}>
              <span className={styles.totalLabel}>Tax</span>
              <span className={styles.totalValue}>{fmtRm(po.tax_centi, po.currency)}</span>
            </div>
            <div className={`${styles.totalRow} ${styles.grandTotalRow}`}>
              <span className={styles.totalLabel}>Total</span>
              <span className={`${styles.totalValue} ${styles.grandTotal}`}>{fmtRm(grandTotal, po.currency)}</span>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};

/* ════════════════════════════════════════════════════════════════════════
   Supplier / header card — controlled by the page's draft (#194)
   ════════════════════════════════════════════════════════════════════════ */

const SupplierCard = ({
  po,
  draft,
  onField,
  locked,
  isEditing,
}: {
  po: PoHeaderRow;
  draft: HeaderDraft;
  onField: (k: keyof HeaderDraft, v: string) => void;
  locked: boolean;
  isEditing: boolean;
}) => {
  return (
    <section className={styles.card}>
      <header className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>Supplier · Dates · Notes</h2>
      </header>
      <div className={styles.cardBody}>
        {!isEditing ? (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(4, 1fr)",
              gap: "var(--space-3) var(--space-4)",
              fontFamily: "var(--font-sans)",
              fontSize: "var(--fs-13)",
            }}
          >
            <div style={{ gridColumn: "span 2" }}>
              <InfoCell label="Supplier" value={po.supplier?.name ?? po.supplier?.code ?? null} />
            </div>
            <InfoCell label="Currency" value={po.currency || null} />
            <div />
            <InfoCell label="PO Date" value={po.po_date || null} />
            <InfoCell label="Expected Delivery" value={po.expected_at || null} />
            {/* Purchase Location: warehouses not cloned yet — show the saved id
                (or dash). TODO: resolve to warehouse name when the slice lands. */}
            <InfoCell label="Purchase Location" value={po.purchase_location_id || null} />
            <div style={{ gridColumn: "span 2" }}>
              <InfoCell label="Notes" value={po.notes || null} />
            </div>
          </div>
        ) : (
          <SupplierEditGrid draft={draft} onField={onField} locked={locked} />
        )}
      </div>
    </section>
  );
};

/* Edit-mode header grid. Supplier picker is sourced from the suppliers list
   endpoint (same as 2990s's useSuppliers). */
const SupplierEditGrid = ({
  draft,
  onField,
  locked,
}: {
  draft: HeaderDraft;
  onField: (k: keyof HeaderDraft, v: string) => void;
  locked: boolean;
}) => {
  const suppliers = useSuppliersForPicker();
  return (
    <div className={styles.formGrid4}>
      <label className={styles.field} style={{ gridColumn: "span 2" }}>
        <span className={styles.fieldLabel}>Supplier *</span>
        <span className={styles.selectWrap}>
          <select
            className={styles.fieldSelect}
            value={draft.supplierId}
            disabled={locked}
            onChange={(e) => onField("supplierId", e.target.value)}
          >
            <option value="">— Pick supplier —</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.code} · {s.name}
              </option>
            ))}
          </select>
          <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
        </span>
      </label>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Currency</span>
        <span className={styles.selectWrap}>
          <select
            className={styles.fieldSelect}
            value={draft.currency}
            disabled={locked}
            onChange={(e) => onField("currency", e.target.value)}
          >
            <option value="MYR">MYR</option>
            <option value="RMB">RMB</option>
            <option value="USD">USD</option>
            <option value="SGD">SGD</option>
          </select>
          <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
        </span>
      </label>
      <div />
      <label className={styles.field}>
        <span className={styles.fieldLabel}>PO Date</span>
        <input type="date" className={styles.fieldInput} value={draft.poDate} disabled={locked} onChange={(e) => onField("poDate", e.target.value)} />
      </label>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Expected Delivery</span>
        <input type="date" className={styles.fieldInput} value={draft.expectedAt} disabled={locked} onChange={(e) => onField("expectedAt", e.target.value)} />
      </label>
      {/* Purchase Location — plain text id input (warehouses not cloned).
          TODO: warehouse picker when the Warehouse slice lands. */}
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Purchase Location</span>
        <input
          className={styles.fieldInput}
          value={draft.purchaseLocationId}
          disabled={locked}
          placeholder="(warehouse id — picker after Warehouse slice)"
          onChange={(e) => onField("purchaseLocationId", e.target.value)}
        />
      </label>
      <label className={styles.field} style={{ gridColumn: "span 2" }}>
        <span className={styles.fieldLabel}>Notes</span>
        <input className={styles.fieldInput} value={draft.notes} disabled={locked} onChange={(e) => onField("notes", e.target.value)} />
      </label>
    </div>
  );
};

/* Minimal supplier picker source — reads the suppliers list endpoint directly
   (same shape 2990s's useSuppliers returns). Co-located so the PO slice doesn't
   import the Suppliers page module. */
type SupplierLite = { id: string; code: string; name: string };
function useSuppliersForPicker(): SupplierLite[] {
  const q = useQuery({
    queryKey: ["suppliers", "ACTIVE", ""],
    queryFn: async () => {
      const res = await api.get<{ suppliers: SupplierLite[] }>(`/api/suppliers?status=ACTIVE`);
      return res.suppliers;
    },
    staleTime: 30_000,
  });
  return q.data ?? [];
}

/* Minimal inline RM<->centi editor (no MoneyInput in this slice — same commit
   ergonomics as the Suppliers slice's InlineUnitPrice). */
const InlineRmInput = ({
  valueCenti,
  onCommit,
  disabled,
  style,
}: {
  valueCenti: number;
  onCommit: (centi: number) => void;
  disabled?: boolean;
  style?: React.CSSProperties;
}) => {
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
      <div
        style={{
          fontSize: "var(--fs-11)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: "var(--fg-muted)",
          marginBottom: 2,
        }}
      >
        {label}
      </div>
      <div style={{ color: value ? "var(--fg)" : "var(--fg-muted)" }}>{value || "—"}</div>
    </div>
  );
}
