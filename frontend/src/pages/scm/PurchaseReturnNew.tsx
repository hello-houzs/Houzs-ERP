// ----------------------------------------------------------------------------
// PurchaseReturnNew — full-page Create Purchase Return at /purchase-returns/new.
//
// 1:1 clone of 2990s apps/backend/src/pages/PurchaseReturnNew.tsx (AutoCount-style
// full-page form). A Purchase Return sends goods back to the supplier: pick a
// supplier, add lines (item + qty returned + unit price + reason), Create. On
// create the server writes inventory OUT, bumps grn_items.returned_qty, and nets
// down the parent PO's received_qty. (A return is more commonly born from the GRN
// list "Convert to PR" — that path lands on the PR detail directly.)
//
// SEAM changes (same playbook as GrnNew / PurchaseInvoiceNew):
//   - Data layer: 2990s lib/flow-queries + suppliers-queries -> the PR hook in
//     ./flow-queries (Houzs api client + TanStack). Shapes identical (rule #7).
//   - Components: @2990s/design-system Button -> Houzs components/Button; 2990s
//     MoneyInput -> a minimal inline RM<->centi input; react-router ->
//     react-router-dom (rule #9). ActionResultDialog -> window.alert + navigate.
//
// Strategy-2 product-layer simplifications (Houzs is not the furniture business):
//   - DROPPED the furniture line machinery (mfg_products / variant editors /
//     supplier-binding lookup). A line is plain text: Item Code + Description +
//     Qty Returned + Unit Price + Reason. (A manual PR line has no grn_item_id, so
//     it moves stock OUT of the default warehouse without a GRN-line cap.)
//     TODO: wire a product source + variant editors in the Products slice.
// ----------------------------------------------------------------------------

import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, Plus, Save, Trash2, ChevronDown } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "../../components/Button";
import { api } from "../../api/client";
import { useCreatePurchaseReturn, type NewPrItem } from "./flow-queries";
import styles from "./PurchaseOrderDetail.module.css";

const ICON = { size: 16, strokeWidth: 1.75 } as const;
const SM_ICON = { size: 14, strokeWidth: 1.75 } as const;

const todayMyt = (): string => new Date().toISOString().slice(0, 10);

const fmtRm = (centi: number | null | undefined, currency = "MYR"): string => {
  const v = centi ?? 0;
  return `${currency} ${(v / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

type SupplierLite = { id: string; code: string; name: string };

type DraftLine = {
  rid: string;
  materialKind: "mfg_product" | "fabric" | "raw";
  materialCode: string;
  materialName: string;
  qtyReturned: number;
  unitPriceCenti: number;
  reason: string;
};

const blankLine = (): DraftLine => ({
  rid: `m${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  materialKind: "mfg_product",
  materialCode: "",
  materialName: "",
  qtyReturned: 1,
  unitPriceCenti: 0,
  reason: "",
});

export const PurchaseReturnNew = () => {
  const navigate = useNavigate();
  const create = useCreatePurchaseReturn();
  const saving = create.isPending;

  const suppliers = useSuppliersForPicker();
  const [supplierId, setSupplierId] = useState<string>("");
  const [returnDate, setReturnDate] = useState<string>(() => todayMyt());
  const [reason, setReason] = useState<string>("");
  const [notes, setNotes] = useState<string>("");
  const [lines, setLines] = useState<DraftLine[]>(() => [blankLine()]);

  const setLine = (rid: string, patch: Partial<DraftLine>) => setLines((prev) => prev.map((l) => (l.rid === rid ? { ...l, ...patch } : l)));
  const dropLine = (rid: string) => setLines((prev) => prev.filter((l) => l.rid !== rid));
  const addLine = () => setLines((prev) => [...prev, blankLine()]);

  const totalRefund = useMemo(() => lines.reduce((s, l) => s + l.qtyReturned * l.unitPriceCenti, 0), [lines]);
  const supplierName = suppliers.find((s) => s.id === supplierId)?.name ?? null;
  const canSave = !!supplierId && lines.some((l) => l.materialCode.trim() && l.qtyReturned > 0);

  const onSave = async () => {
    if (!supplierId) {
      window.alert("Choose a supplier for this return.");
      return;
    }
    const realLines = lines.filter((l) => l.materialCode.trim() && l.qtyReturned > 0);
    if (realLines.length === 0) {
      window.alert("Add at least one item with a return qty > 0.");
      return;
    }
    try {
      const items: NewPrItem[] = realLines.map((l) => ({
        materialKind: l.materialKind,
        materialCode: l.materialCode,
        materialName: l.materialName || l.materialCode,
        qtyReturned: l.qtyReturned,
        unitPriceCenti: l.unitPriceCenti,
        reason: l.reason || undefined,
      }));
      const res = await create.mutateAsync({
        supplierId,
        returnDate,
        reason: reason || undefined,
        notes: notes || undefined,
        items,
      });
      navigate(`/purchase-returns/${res.id}`);
    } catch (err) {
      window.alert(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
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
            <h1 className={styles.title}>New Purchase Return</h1>
          </div>
        </div>
        <div className={styles.actions}>
          <div className={styles.totalRail}>
            <span className={styles.totalRailLabel}>Refund</span>
            <span className={styles.totalRailValue}>{fmtRm(totalRefund)}</span>
          </div>
          <Button variant="primary" onClick={onSave} disabled={saving || !canSave}>
            <Save {...ICON} />
            <span>{saving ? "Saving…" : "Create Purchase Return"}</span>
          </Button>
        </div>
      </div>

      {/* ── Header card ────────────────────────────────────────── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Return Details</h2>
        </header>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <label className={styles.field} style={{ gridColumn: "span 2" }}>
              <span className={styles.fieldLabel}>Supplier *</span>
              <span className={styles.selectWrap}>
                <select className={styles.fieldSelect} value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
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
              <span className={styles.fieldLabel}>Return Date</span>
              <input type="date" className={styles.fieldInput} value={returnDate} onChange={(e) => setReturnDate(e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Reason</span>
              <input className={styles.fieldInput} value={reason} placeholder="DEFECT / WRONG_ITEM / OVERSUPPLY / free text" onChange={(e) => setReason(e.target.value)} />
            </label>
            <label className={styles.field} style={{ gridColumn: "span 4" }}>
              <span className={styles.fieldLabel}>Notes</span>
              <input className={styles.fieldInput} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </label>
          </div>
          {supplierName && (
            <div style={{ marginTop: "var(--space-2)", fontSize: "var(--fs-12)", color: "var(--fg-muted)" }}>
              Returning to <strong>{supplierName}</strong>. Stock leaves the default warehouse on Create.
            </div>
          )}
        </div>
      </section>

      {/* ── Line items ──────────────────────────────────────────── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Line Items ({lines.length})</h2>
        </header>
        {lines.length === 0 ? (
          <div className={styles.cardBody}>
            <p className={styles.emptyRow}>Add an item to return.</p>
          </div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Item Code</th>
                <th>Description</th>
                <th className={styles.tableRight}>Qty Returned</th>
                <th className={styles.tableRight}>Unit Price</th>
                <th className={styles.tableRight}>Line Refund</th>
                <th>Reason</th>
                <th className={styles.tableRight}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.rid}>
                  <td>
                    <input className={styles.fieldInput} style={{ width: 130 }} value={l.materialCode} placeholder="Code" onChange={(e) => setLine(l.rid, { materialCode: e.target.value })} />
                  </td>
                  <td>
                    <input className={styles.fieldInput} style={{ width: 200 }} value={l.materialName} placeholder="Description" onChange={(e) => setLine(l.rid, { materialName: e.target.value })} />
                  </td>
                  <td className={styles.tableRight}>
                    <input type="number" min={0} className={styles.fieldInput} style={{ width: 80, textAlign: "right" }} value={l.qtyReturned} onChange={(e) => setLine(l.rid, { qtyReturned: Math.max(0, Number(e.target.value) || 0) })} />
                  </td>
                  <td className={styles.tableRight}>
                    <InlineRmInput valueCenti={l.unitPriceCenti} onCommit={(centi) => setLine(l.rid, { unitPriceCenti: centi })} style={{ width: 110 }} />
                  </td>
                  <td className={styles.priceCell}>{fmtRm(l.qtyReturned * l.unitPriceCenti)}</td>
                  <td>
                    <input className={styles.fieldInput} style={{ width: 140 }} value={l.reason} placeholder="Per-line reason" onChange={(e) => setLine(l.rid, { reason: e.target.value })} />
                  </td>
                  <td className={styles.tableRight}>
                    <button type="button" className={`${styles.iconBtn} ${styles.iconBtnDanger}`} title="Remove line" onClick={() => dropLine(l.rid)}>
                      <Trash2 {...SM_ICON} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className={styles.cardBody}>
          <Button variant="ghost" onClick={addLine}>
            <Plus {...ICON} />
            <span>Add another item</span>
          </Button>
        </div>
      </section>
    </div>
  );
};

/* Minimal supplier picker source — reads the suppliers list endpoint directly. */
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

/* Minimal inline RM<->centi editor (no MoneyInput in this slice). */
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
