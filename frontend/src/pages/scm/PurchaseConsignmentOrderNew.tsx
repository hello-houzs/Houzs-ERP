// ----------------------------------------------------------------------------
// PurchaseConsignmentOrderNew — Create PC Order at /purchase-consignment-orders/new.
// 1:1 clone of 2990s apps/backend/src/pages/PurchaseConsignmentOrderNew.tsx
// (AutoCount-style full-page form). Pick supplier + receive-into warehouse +
// expected date, add lines (item + qty + unit price), Create.
// SEAM playbook (PurchaseReturnNew): data via ./consignment-purchase-queries;
// Strategy-2 plain-text lines (no furniture variant editor); react-router-dom;
// in-app useToast (rule #10).
// ----------------------------------------------------------------------------

import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, Plus, Save, Trash2, ChevronDown } from "lucide-react";
import { Button } from "../../components/Button";
import { useCreatePcOrder, useSupplierOptions, useWarehouseOptions, type NewPcoItem } from "./consignment-purchase-queries";
import { useToast } from "../../hooks/useToast";
import styles from "./PurchaseOrderDetail.module.css";

const ICON = { size: 16, strokeWidth: 1.75 } as const;
const SM_ICON = { size: 14, strokeWidth: 1.75 } as const;

const todayMyt = (): string => new Date().toISOString().slice(0, 10);
const fmtRm = (centi: number | null | undefined, currency = "MYR"): string => `${currency} ${((centi ?? 0) / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

type DraftLine = { rid: string; materialCode: string; materialName: string; qty: number; unitPriceCenti: number };
const blankLine = (): DraftLine => ({ rid: `m${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, materialCode: "", materialName: "", qty: 1, unitPriceCenti: 0 });

export const PurchaseConsignmentOrderNew = () => {
  const navigate = useNavigate();
  const toast = useToast();
  const create = useCreatePcOrder();
  const saving = create.isPending;

  const { data: suppliers = [] } = useSupplierOptions();
  const { data: warehouses = [] } = useWarehouseOptions();
  const [supplierId, setSupplierId] = useState("");
  const [purchaseLocationId, setPurchaseLocationId] = useState("");
  const [expectedAt, setExpectedAt] = useState(() => todayMyt());
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<DraftLine[]>(() => [blankLine()]);

  const setLine = (rid: string, patch: Partial<DraftLine>) => setLines((prev) => prev.map((l) => (l.rid === rid ? { ...l, ...patch } : l)));
  const dropLine = (rid: string) => setLines((prev) => prev.filter((l) => l.rid !== rid));
  const addLine = () => setLines((prev) => [...prev, blankLine()]);

  const total = useMemo(() => lines.reduce((s, l) => s + l.qty * l.unitPriceCenti, 0), [lines]);
  const canSave = !!supplierId && !!purchaseLocationId && !!expectedAt && lines.some((l) => l.materialCode.trim() && l.qty > 0);

  const onSave = async () => {
    if (!supplierId) return toast.error("Choose a supplier.");
    if (!purchaseLocationId) return toast.error("Choose a receive-into warehouse.");
    if (!expectedAt) return toast.error("Set an expected date.");
    const realLines = lines.filter((l) => l.materialCode.trim() && l.qty > 0);
    if (realLines.length === 0) return toast.error("Add at least one item with qty > 0.");
    try {
      const items: NewPcoItem[] = realLines.map((l) => ({ materialKind: "mfg_product", materialCode: l.materialCode, materialName: l.materialName || l.materialCode, qty: l.qty, unitPriceCenti: l.unitPriceCenti }));
      const res = await create.mutateAsync({ supplierId, purchaseLocationId, expectedAt, notes: notes || undefined, items });
      navigate(`/purchase-consignment-orders/${res.id}`);
    } catch (err) {
      toast.error(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div className={styles.titleBlock}>
          <Link to="/purchase-consignment-orders" className={styles.backBtn}>
            <ArrowLeft {...ICON} />
            <span>Back</span>
          </Link>
          <div>
            <h1 className={styles.title}>New PC Order</h1>
          </div>
        </div>
        <div className={styles.actions}>
          <div className={styles.totalRail}>
            <span className={styles.totalRailLabel}>Total</span>
            <span className={styles.totalRailValue}>{fmtRm(total)}</span>
          </div>
          <Button variant="primary" onClick={onSave} disabled={saving || !canSave}>
            <Save {...ICON} />
            <span>{saving ? "Saving…" : "Create PC Order"}</span>
          </Button>
        </div>
      </div>

      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Order Details</h2>
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
              <span className={styles.fieldLabel}>Receive Into *</span>
              <span className={styles.selectWrap}>
                <select className={styles.fieldSelect} value={purchaseLocationId} onChange={(e) => setPurchaseLocationId(e.target.value)}>
                  <option value="">— Pick warehouse —</option>
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.code} · {w.name}
                    </option>
                  ))}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Expected Date *</span>
              <input type="date" className={styles.fieldInput} value={expectedAt} onChange={(e) => setExpectedAt(e.target.value)} />
            </label>
            <label className={styles.field} style={{ gridColumn: "span 4" }}>
              <span className={styles.fieldLabel}>Notes</span>
              <input className={styles.fieldInput} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </label>
          </div>
        </div>
      </section>

      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Line Items ({lines.length})</h2>
        </header>
        {lines.length === 0 ? (
          <div className={styles.cardBody}>
            <p className={styles.emptyRow}>Add an item to order.</p>
          </div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Item Code</th>
                <th>Description</th>
                <th className={styles.tableRight}>Qty</th>
                <th className={styles.tableRight}>Unit Price</th>
                <th className={styles.tableRight}>Line Total</th>
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
                    <input className={styles.fieldInput} style={{ width: 220 }} value={l.materialName} placeholder="Description" onChange={(e) => setLine(l.rid, { materialName: e.target.value })} />
                  </td>
                  <td className={styles.tableRight}>
                    <input type="number" min={0} className={styles.fieldInput} style={{ width: 80, textAlign: "right" }} value={l.qty} onChange={(e) => setLine(l.rid, { qty: Math.max(0, Number(e.target.value) || 0) })} />
                  </td>
                  <td className={styles.tableRight}>
                    <InlineRmInput valueCenti={l.unitPriceCenti} onCommit={(centi) => setLine(l.rid, { unitPriceCenti: centi })} style={{ width: 110 }} />
                  </td>
                  <td className={styles.priceCell}>{fmtRm(l.qty * l.unitPriceCenti)}</td>
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
