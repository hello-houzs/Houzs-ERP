// ----------------------------------------------------------------------------
// GoodsReceivedDetail — full-page route at /grns/:id.
//
// 1:1 clone of 2990s apps/backend/src/pages/GoodsReceivedDetail.tsx, which is
// itself an EXACT clone of PurchaseOrderDetail (the gold standard) with GRN
// semantics. A draft-style View → Edit → Save/Back machine + Cancel:
//   1. Header: back + GRN# · supplier + Total rail + status pill + actions
//   2. Supplier card: supplier + received date + DN ref + receive-into warehouse
//      + notes (view text / edit inputs, page-owned draft)
//   3. Line items table (View read-only — incl. the server-resolved "Received
//      from PO" + "Transfer To" columns; Edit = inline qty(received)/unit/disc)
//   4. Totals card (subtotal + total, computed live incl. draft edits)
//   5. View → Edit gate; single top Save commits header + changed lines; Back
//      discards the field-edit draft (no auto-save). Cancel reverses the receipt.
//
// grn_status: POSTED → "Confirmed" (editable). CANCELLED / CLOSED → locked.
//
// SEAM changes (same playbook as PurchaseOrderDetail):
//   - Data layer: 2990s lib/flow-queries + suppliers-queries + inventory-queries
//     -> the GRN hooks in ./grn-queries + the warehouse hook in ./inventory-queries
//     (Houzs api client + TanStack). Shapes identical (rule #7).
//   - Components: @2990s/design-system Button -> Houzs components/Button; 2990s
//     MoneyInput -> a minimal inline RM<->centi editor; react-router ->
//     react-router-dom (rule #9). useConfirm / SkeletonDetailPage /
//     RelationshipMapButton -> plain loading text + Houzs useDialog/useToast
//     (in-app, never window.confirm/alert).
//
// Strategy-2 product-layer notes (dropped from the 2990s page):
//   - Print PDF (jspdf, furniture labels) — DROPPED. TODO: generic GRN print.
//   - buildVariantSummary / ItemGroupPill (furniture formatters) -> show
//     description / description2 / material name as-is.
//   - The per-line Rack picker (useRacks) is DROPPED. TODO: rack picker.
//   - The "Convert to PI / PR" smart buttons target the PI/PR slices (not cloned)
//     — DROPPED. TODO: wire when those slices land.
// ----------------------------------------------------------------------------

import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, FileText, Pencil, Trash2, Save, Ban, ChevronDown } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "../../components/Button";
import { api } from "../../api/client";
import {
  useGrnDetail,
  useUpdateGrnHeader,
  useUpdateGrnItem,
  useDeleteGrnItem,
  useCancelGrn,
  type GrnItemRow,
  type GrnRow,
  type GrnStatus,
} from "./grn-queries";
import { useWarehouses } from "./inventory-queries";
import { useDialog } from "../../hooks/useDialog";
import { useToast } from "../../hooks/useToast";
import styles from "./PurchaseOrderDetail.module.css";

const ICON = { size: 16, strokeWidth: 1.75 } as const;
const SM_ICON = { size: 14, strokeWidth: 1.75 } as const;

// grn_status enum — POSTED reads as "Confirmed"; CANCELLED / CLOSED lock the page.
const STATUS_LABEL: Record<GrnStatus, string> = {
  POSTED: "Confirmed",
  CLOSED: "Closed",
  CANCELLED: "Cancelled",
};
const STATUS_CLASS: Record<GrnStatus, string> = {
  POSTED: styles.statusDelivered ?? "",
  CLOSED: styles.statusCancelled ?? "",
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

type HeaderDraft = {
  supplierId: string;
  receivedAt: string;
  deliveryNoteRef: string;
  warehouseId: string;
  notes: string;
};
type LineDraft = {
  qtyReceived: number;
  unitPriceCenti: number;
  discountCenti: number;
};

const headerSnapshot = (g: GrnRow): HeaderDraft => ({
  supplierId: g.supplier_id ?? "",
  receivedAt: g.received_at ?? "",
  deliveryNoteRef: g.delivery_note_ref ?? "",
  warehouseId: g.warehouse_id ?? "",
  notes: g.notes ?? "",
});

const lineSnapshot = (it: GrnItemRow): LineDraft => ({
  qtyReceived: it.qty_received,
  unitPriceCenti: it.unit_price_centi,
  discountCenti: it.discount_centi ?? 0,
});

export const GoodsReceivedDetail = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const dialog = useDialog();
  const toast = useToast();
  const detail = useGrnDetail(id ?? null);
  const updateHeader = useUpdateGrnHeader();
  const cancel = useCancelGrn();
  const updateItem = useUpdateGrnItem();
  const deleteItem = useDeleteGrnItem();

  const grn = detail.data?.grn ?? null;
  const items = detail.data?.items ?? [];

  const [searchParams] = useSearchParams();
  const [isEditing, setIsEditing] = useState(() => searchParams.get("edit") === "1");

  const [headerDraft, setHeaderDraft] = useState<HeaderDraft | null>(null);
  const [lineDrafts, setLineDrafts] = useState<Record<string, LineDraft>>({});
  const [savingDraft, setSavingDraft] = useState(false);

  // A GRN is editable while POSTED + no downstream child (PI/PR). CANCELLED /
  // CLOSED lock the page.
  const hasChildren = Boolean(grn?.has_children);
  const isLocked = grn ? grn.status !== "POSTED" || hasChildren : true;
  const lockedDueToChildren = grn ? grn.status === "POSTED" && hasChildren : false;

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
        <p className={styles.eyebrow}>Loading goods receipt…</p>
      </div>
    );
  }
  if (detail.isError || !grn) {
    return (
      <div className={styles.page}>
        <Link to="/grns" className={styles.backBtn}>
          <ArrowLeft {...ICON} />
          <span>Back</span>
        </Link>
        <div className={styles.bannerWarn}>
          <strong>Goods receipt not found.</strong>
          {detail.error instanceof Error ? ` ${detail.error.message}` : null}
        </div>
      </div>
    );
  }

  const lineOf = (it: GrnItemRow): LineDraft => lineDrafts[it.id] ?? lineSnapshot(it);
  const lineTotalOf = (it: GrnItemRow): number => {
    if (!isEditing) return it.line_total_centi ?? 0;
    const d = lineOf(it);
    return d.qtyReceived * d.unitPriceCenti - d.discountCenti;
  };
  const itemsSubtotal = items.reduce((s, it) => s + lineTotalOf(it), 0);
  const grandTotal = itemsSubtotal + (grn.tax_centi ?? 0);

  const headerView = headerDraft ?? headerSnapshot(grn);

  const setHeaderField = (k: keyof HeaderDraft, v: string) => {
    setHeaderDraft((h) => ({ ...(h ?? headerSnapshot(grn)), [k]: v }));
  };
  const setLine = (it: GrnItemRow, patch: Partial<LineDraft>) =>
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
        await updateHeader.mutateAsync({ id: grn.id, ...(headerDraft as Record<string, unknown>) });
      }
      for (const it of items) {
        const d = lineDrafts[it.id];
        if (!d) continue;
        const changed =
          d.qtyReceived !== it.qty_received ||
          d.unitPriceCenti !== it.unit_price_centi ||
          d.discountCenti !== (it.discount_centi ?? 0);
        if (changed) {
          await updateItem.mutateAsync({
            grnId: grn.id,
            itemId: it.id,
            qty: d.qtyReceived,
            unitPriceCenti: d.unitPriceCenti,
            discountCenti: d.discountCenti,
          });
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

  return (
    <div className={styles.page}>
      {/* ── Header ──────────────────────────────────────────────── */}
      <div className={styles.headerRow}>
        <div className={styles.titleBlock}>
          <Link to="/grns" className={styles.backBtn}>
            <ArrowLeft {...ICON} />
            <span>Back</span>
          </Link>
          <div>
            <h1 className={styles.title}>
              <FileText size={14} strokeWidth={1.75} style={{ color: "var(--c-burnt)" }} />
              {grn.grn_number} — {grn.supplier?.name ?? grn.supplier?.code ?? "—"}
            </h1>
          </div>
        </div>
        <div className={styles.actions}>
          <div className={styles.totalRail}>
            <span className={styles.totalRailLabel}>Total</span>
            <span className={styles.totalRailValue}>{fmtRm(grandTotal, grn.currency)}</span>
          </div>
          <span className={`${styles.statusPill} ${STATUS_CLASS[grn.status]}`}>{STATUS_LABEL[grn.status] ?? grn.status}</span>
          {grn.status === "POSTED" && !hasChildren && (
            <Button
              variant="ghost"
              onClick={async () => {
                if (
                  !(await dialog.confirm(
                    `Cancel GRN ${grn.grn_number}? This reverses the receipt — stock is taken back out and the source PO's received qty is rolled back. Line items stay for audit.`,
                  ))
                )
                  return;
                cancel.mutate(grn.id, {
                  onError: (err) => toast.error(`Cancel failed: ${err instanceof Error ? err.message : String(err)}`),
                });
              }}
              disabled={cancel.isPending}
            >
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

      {lockedDueToChildren && (
        <div className={styles.bannerWarn}>
          <strong>Locked — has a Purchase Invoice / Return.</strong> Delete the downstream document to edit this GRN again.
        </div>
      )}

      {/* ── Supplier / dates / warehouse / notes ─────────────────── */}
      <SupplierCard grn={grn} draft={headerView} onField={setHeaderField} locked={isLocked} isEditing={isEditing} />

      {/* ── Line items ──────────────────────────────────────────── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Line Items ({items.length})</h2>
        </header>

        {items.length === 0 ? (
          <div className={styles.cardBody}>
            <p className={styles.emptyRow}>No items on this GRN.</p>
          </div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Item</th>
                <th>From PO</th>
                <th className={styles.tableRight}>Qty Received</th>
                <th className={styles.tableRight}>Unit</th>
                <th className={styles.tableRight}>Disc</th>
                <th className={styles.tableRight}>Total</th>
                <th>Transfer To</th>
                {isEditing && <th className={styles.tableRight}>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {items.map((it) => {
                const d = lineOf(it);
                const summary = it.description2 || it.description || it.material_name;
                const ds = it.downstream ?? [];
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
                    <td style={{ fontFamily: "var(--font-mono)", fontWeight: 700, color: "var(--c-burnt)" }}>
                      {it.source_po_number ?? "—"}
                    </td>

                    {isEditing ? (
                      <>
                        <td className={styles.tableRight}>
                          <input
                            type="number"
                            min={0}
                            className={styles.fieldInput}
                            style={{ width: 80, textAlign: "right" }}
                            value={d.qtyReceived}
                            disabled={isLocked}
                            onChange={(e) => setLine(it, { qtyReceived: Number(e.target.value) || 0 })}
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
                        <td className={styles.priceCell}>{fmtRm(d.qtyReceived * d.unitPriceCenti - d.discountCenti, grn.currency)}</td>
                        <td className={styles.muted}>
                          {ds.length === 0 ? "—" : ds.map((x) => `${x.docNumber} ×${x.qty}`).join(", ")}
                        </td>
                        <td>
                          <span className={styles.actionsCell}>
                            <button
                              type="button"
                              className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                              title="Remove line"
                              disabled={isLocked || deleteItem.isPending}
                              onClick={async () => {
                                if (isLocked) return;
                                if (await dialog.confirm("Remove this line? Its receipt is reversed (stock out) and the source PO's received qty is rolled back.")) {
                                  deleteItem.mutate({ grnId: grn.id, itemId: it.id });
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
                        <td className={styles.tableRight}>{it.qty_received}</td>
                        <td className={styles.tableRight}>{fmtRm(it.unit_price_centi, grn.currency)}</td>
                        <td className={styles.tableRight}>{(it.discount_centi ?? 0) > 0 ? fmtRm(it.discount_centi, grn.currency) : "—"}</td>
                        <td className={styles.priceCell}>{fmtRm(it.line_total_centi, grn.currency)}</td>
                        <td className={styles.muted}>
                          {ds.length === 0 ? "—" : ds.map((x) => `${x.docNumber} ×${x.qty}`).join(", ")}
                        </td>
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
              <span className={styles.totalValue}>{fmtRm(itemsSubtotal, grn.currency)}</span>
            </div>
            <div className={`${styles.totalRow} ${styles.grandTotalRow}`}>
              <span className={styles.totalLabel}>Total</span>
              <span className={`${styles.totalValue} ${styles.grandTotal}`}>{fmtRm(grandTotal, grn.currency)}</span>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};

/* ════════════════════════════════════════════════════════════════════════
   Supplier / header card — controlled by the page's draft
   ════════════════════════════════════════════════════════════════════════ */

const SupplierCard = ({
  grn,
  draft,
  onField,
  locked,
  isEditing,
}: {
  grn: GrnRow;
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
              <InfoCell label="Supplier" value={grn.supplier?.name ?? grn.supplier?.code ?? null} />
            </div>
            <InfoCell label="Received Date" value={fmtDateOrDash(grn.received_at)} />
            <InfoCell label="DN Ref" value={grn.delivery_note_ref || null} />
            <WarehouseCell warehouseId={grn.warehouse_id} />
            <div style={{ gridColumn: "span 3" }}>
              <InfoCell label="Notes" value={grn.notes || null} />
            </div>
          </div>
        ) : (
          <SupplierEditGrid draft={draft} onField={onField} locked={locked} />
        )}
      </div>
    </section>
  );
};

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
  const warehousesQ = useWarehouses();
  return (
    <div className={styles.formGrid4}>
      <label className={styles.field} style={{ gridColumn: "span 2" }}>
        <span className={styles.fieldLabel}>Supplier *</span>
        <span className={styles.selectWrap}>
          <select className={styles.fieldSelect} value={draft.supplierId} disabled={locked} onChange={(e) => onField("supplierId", e.target.value)}>
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
        <span className={styles.fieldLabel}>Received Date</span>
        <input type="date" className={styles.fieldInput} value={draft.receivedAt} disabled={locked} onChange={(e) => onField("receivedAt", e.target.value)} />
      </label>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>DN Ref</span>
        <input className={styles.fieldInput} value={draft.deliveryNoteRef} disabled={locked} onChange={(e) => onField("deliveryNoteRef", e.target.value)} />
      </label>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Receive into</span>
        <span className={styles.selectWrap}>
          <select className={styles.fieldSelect} value={draft.warehouseId} disabled={locked} onChange={(e) => onField("warehouseId", e.target.value)}>
            <option value="">— Default warehouse —</option>
            {(warehousesQ.data ?? []).map((w) => (
              <option key={w.id} value={w.id}>
                {w.code} · {w.name}
              </option>
            ))}
          </select>
          <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
        </span>
      </label>
      <label className={styles.field} style={{ gridColumn: "span 3" }}>
        <span className={styles.fieldLabel}>Notes</span>
        <input className={styles.fieldInput} value={draft.notes} disabled={locked} onChange={(e) => onField("notes", e.target.value)} />
      </label>
    </div>
  );
};

/* Resolve a warehouse id to its code/name for the View card (warehouses come from
   the inventory warehouse endpoint). */
const WarehouseCell = ({ warehouseId }: { warehouseId: string | null }) => {
  const warehousesQ = useWarehouses();
  const wh = (warehousesQ.data ?? []).find((w) => w.id === warehouseId);
  return <InfoCell label="Receive into" value={wh ? `${wh.code} · ${wh.name}` : warehouseId || null} />;
};

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
