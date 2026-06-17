// ----------------------------------------------------------------------------
// ConsignmentReturnNew — full-page manual Create Consignment Return at
// /consignment-returns/new. Houzs-style clone of 2990s ConsignmentReturnNew.tsx
// (free-entry return — "no DO, no return" is RELAXED for consignment). Captures
// the customer header + destination warehouse + manual line items, POSTs to
// /api/consignment-returns; books the stock IN (CS_DR) on create.
//
// Strategy-2: plain text lines. useToast (rule #10). The convert-from-note picker
// (ConsignmentReturnFromNote) is the primary path; this is the blank manual fallback.
// ----------------------------------------------------------------------------

import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, Plus, Save, Trash2, ChevronDown } from "lucide-react";
import { Button } from "../../components/Button";
import { useCreateConsignmentReturn, useWarehouseOptions, type NewCrItem } from "./consignment-sales-queries";
import { useToast } from "../../hooks/useToast";
import styles from "./PurchaseOrderDetail.module.css";

const ICON = { size: 16, strokeWidth: 1.75 } as const;
const SM_ICON = { size: 14, strokeWidth: 1.75 } as const;
const CONDITIONS = ["NEW", "DAMAGED", "DEFECT"] as const;
const fmtRm = (centi: number): string => `MYR ${(centi / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const ITEM_GROUPS = ["sofa", "mattress", "bedframe", "accessory", "others"];

type DraftLine = { rid: string; itemGroup: string; itemCode: string; description: string; qtyReturned: number; condition: string; unitPriceCenti: number; unitCostCenti: number };
const blankLine = (): DraftLine => ({ rid: `m${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, itemGroup: "others", itemCode: "", description: "", qtyReturned: 1, condition: "NEW", unitPriceCenti: 0, unitCostCenti: 0 });

export const ConsignmentReturnNew = () => {
  const navigate = useNavigate();
  const toast = useToast();
  const create = useCreateConsignmentReturn();
  const warehousesQ = useWarehouseOptions();
  const saving = create.isPending;

  const [debtorName, setDebtorName] = useState("");
  const [debtorCode, setDebtorCode] = useState("");
  const [phone, setPhone] = useState("");
  const [warehouseId, setWarehouseId] = useState("");
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([blankLine()]);

  const setLine = (rid: string, patch: Partial<DraftLine>) => setLines((prev) => prev.map((l) => (l.rid === rid ? { ...l, ...patch } : l)));
  const dropLine = (rid: string) => setLines((prev) => prev.filter((l) => l.rid !== rid));
  const addLine = () => setLines((prev) => [...prev, blankLine()]);

  const subtotalCenti = useMemo(() => lines.reduce((s, l) => s + l.qtyReturned * l.unitPriceCenti, 0), [lines]);
  const canSave = debtorName.trim().length > 0 && lines.some((l) => l.itemCode.trim());

  const onSave = async () => {
    if (!canSave) { toast.error("Customer name and at least one line item are required."); return; }
    const realLines = lines.filter((l) => l.itemCode.trim());
    if (realLines.some((l) => l.qtyReturned < 1)) { toast.error("Each line needs a returned quantity of at least 1."); return; }
    try {
      const items: NewCrItem[] = realLines.map((l) => ({ itemGroup: l.itemGroup, itemCode: l.itemCode.trim(), description: l.description || null, qtyReturned: l.qtyReturned, condition: l.condition, unitPriceCenti: l.unitPriceCenti, unitCostCenti: l.unitCostCenti || undefined }));
      const res = await create.mutateAsync({ debtorName: debtorName.trim(), debtorCode: debtorCode || null, phone: phone || null, warehouseId: warehouseId || null, reason: reason || null, notes: notes || null, items });
      navigate(`/consignment-returns/${res.id}`);
    } catch (err) {
      toast.error(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div className={styles.titleBlock}>
          <Link to="/consignment-returns" className={styles.backBtn}><ArrowLeft {...ICON} /><span>Back</span></Link>
          <div><h1 className={styles.title}>New Consignment Return</h1></div>
        </div>
        <div className={styles.actions}>
          <div className={styles.totalRail}><span className={styles.totalRailLabel}>Refund</span><span className={styles.totalRailValue}>{fmtRm(subtotalCenti)}</span></div>
          <Button variant="primary" onClick={onSave} disabled={saving || !canSave}><Save {...ICON} /><span>{saving ? "Saving…" : "Create Consignment Return"}</span></Button>
        </div>
      </div>

      <section className={styles.card}>
        <header className={styles.cardHeader}><h2 className={styles.cardTitle}>Consignee · Return To</h2></header>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <label className={styles.field} style={{ gridColumn: "span 2" }}><span className={styles.fieldLabel}>Customer / Consignee *</span><input className={styles.fieldInput} value={debtorName} onChange={(e) => setDebtorName(e.target.value)} /></label>
            <label className={styles.field}><span className={styles.fieldLabel}>Customer Code</span><input className={styles.fieldInput} value={debtorCode} onChange={(e) => setDebtorCode(e.target.value)} /></label>
            <label className={styles.field}><span className={styles.fieldLabel}>Phone</span><input className={styles.fieldInput} value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Return To Warehouse</span>
              <span className={styles.selectWrap}>
                <select className={styles.fieldSelect} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
                  <option value="">Default warehouse</option>
                  {(warehousesQ.data ?? []).map((w) => (<option key={w.id} value={w.id}>{w.code ?? w.name}</option>))}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <label className={styles.field} style={{ gridColumn: "span 2" }}><span className={styles.fieldLabel}>Reason</span><input className={styles.fieldInput} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
            <label className={styles.field} style={{ gridColumn: "span 2" }}><span className={styles.fieldLabel}>Notes</span><input className={styles.fieldInput} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
          </div>
        </div>
      </section>

      <section className={styles.card}>
        <header className={styles.cardHeader}><h2 className={styles.cardTitle}>Line Items ({lines.length})</h2></header>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Group</th><th>Item Code</th><th>Description</th><th>Condition</th>
              <th className={styles.tableRight}>Qty Returned</th><th className={styles.tableRight}>Unit Price</th><th className={styles.tableRight}>Unit Cost</th><th className={styles.tableRight}>Line Total</th><th className={styles.tableRight}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.rid}>
                <td>
                  <span className={styles.selectWrap}>
                    <select className={styles.fieldSelect} style={{ width: 110 }} value={l.itemGroup} onChange={(e) => setLine(l.rid, { itemGroup: e.target.value })}>
                      {ITEM_GROUPS.map((g) => (<option key={g} value={g}>{g}</option>))}
                    </select>
                    <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
                  </span>
                </td>
                <td><input className={styles.fieldInput} style={{ width: 120 }} value={l.itemCode} placeholder="Code" onChange={(e) => setLine(l.rid, { itemCode: e.target.value })} /></td>
                <td><input className={styles.fieldInput} style={{ width: 180 }} value={l.description} placeholder="Description" onChange={(e) => setLine(l.rid, { description: e.target.value })} /></td>
                <td>
                  <span className={styles.selectWrap}>
                    <select className={styles.fieldSelect} style={{ width: 110 }} value={l.condition} onChange={(e) => setLine(l.rid, { condition: e.target.value })}>
                      {CONDITIONS.map((c) => (<option key={c} value={c}>{c}</option>))}
                    </select>
                    <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
                  </span>
                </td>
                <td className={styles.tableRight}><input type="number" min={1} className={styles.fieldInput} style={{ width: 70, textAlign: "right" }} value={l.qtyReturned} onChange={(e) => setLine(l.rid, { qtyReturned: Math.max(1, Number(e.target.value) || 1) })} /></td>
                <td className={styles.tableRight}><InlineRmInput valueCenti={l.unitPriceCenti} onCommit={(centi) => setLine(l.rid, { unitPriceCenti: centi })} style={{ width: 100 }} /></td>
                <td className={styles.tableRight}><InlineRmInput valueCenti={l.unitCostCenti} onCommit={(centi) => setLine(l.rid, { unitCostCenti: centi })} style={{ width: 100 }} /></td>
                <td className={styles.priceCell}>{fmtRm(l.qtyReturned * l.unitPriceCenti)}</td>
                <td className={styles.tableRight}><button type="button" className={`${styles.iconBtn} ${styles.iconBtnDanger}`} title="Remove line" onClick={() => dropLine(l.rid)}><Trash2 {...SM_ICON} /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className={styles.cardBody}><Button variant="ghost" onClick={addLine}><Plus {...ICON} /><span>Add another item</span></Button></div>
      </section>
    </div>
  );
};

const InlineRmInput = ({ valueCenti, onCommit, style }: { valueCenti: number; onCommit: (centi: number) => void; style?: React.CSSProperties }) => {
  const toRm = (c: number) => (c ? (c / 100).toFixed(2) : "");
  const [draft, setDraft] = useState(toRm(valueCenti));
  const [committed, setCommitted] = useState(valueCenti);
  if (committed !== valueCenti) { setCommitted(valueCenti); setDraft(toRm(valueCenti)); }
  const commit = () => { const t = draft.trim(); const n = t === "" ? 0 : Number(t); const next = Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : valueCenti; onCommit(next); };
  return (
    <input className={styles.fieldInput} style={{ textAlign: "right", ...style }} value={draft} inputMode="decimal"
      onChange={(e) => setDraft(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); } if (e.key === "Escape") { setDraft(toRm(valueCenti)); (e.target as HTMLInputElement).blur(); } }} />
  );
};
