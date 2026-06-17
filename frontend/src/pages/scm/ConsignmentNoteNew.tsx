// ----------------------------------------------------------------------------
// ConsignmentNoteNew — full-page manual Create Consignment Note at
// /consignment-notes/new. Houzs-style clone of 2990s ConsignmentNoteNew.tsx
// (ad-hoc note not tied to an order — ships whatever is on the shelf). Captures
// the customer header + ship-from warehouse + manual line items, POSTs to
// /api/consignment-notes; the note ships OUT (CS_DO) the moment it's created.
//
// Strategy-2: plain text lines (Item Code + Description + Group + Qty + Unit Price
// + Unit Cost). useToast (rule #10). The convert-from-order picker is the primary
// path (ConsignmentNoteFromOrder); this is the blank manual fallback.
// ----------------------------------------------------------------------------

import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, Plus, Save, Trash2, ChevronDown } from "lucide-react";
import { Button } from "../../components/Button";
import { useCreateConsignmentNote, useWarehouseOptions, type NewCnItem } from "./consignment-sales-queries";
import { useToast } from "../../hooks/useToast";
import styles from "./PurchaseOrderDetail.module.css";

const ICON = { size: 16, strokeWidth: 1.75 } as const;
const SM_ICON = { size: 14, strokeWidth: 1.75 } as const;
const fmtRm = (centi: number): string => `MYR ${(centi / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const ITEM_GROUPS = ["sofa", "mattress", "bedframe", "accessory", "service", "others"];

type DraftLine = { rid: string; itemGroup: string; itemCode: string; description: string; qty: number; unitPriceCenti: number; unitCostCenti: number };
const blankLine = (): DraftLine => ({ rid: `m${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, itemGroup: "others", itemCode: "", description: "", qty: 1, unitPriceCenti: 0, unitCostCenti: 0 });

export const ConsignmentNoteNew = () => {
  const navigate = useNavigate();
  const toast = useToast();
  const create = useCreateConsignmentNote();
  const warehousesQ = useWarehouseOptions();
  const saving = create.isPending;

  const [debtorName, setDebtorName] = useState("");
  const [debtorCode, setDebtorCode] = useState("");
  const [phone, setPhone] = useState("");
  const [consignmentSoDocNo, setConsignmentSoDocNo] = useState("");
  const [warehouseId, setWarehouseId] = useState("");
  const [address1, setAddress1] = useState("");
  const [city, setCity] = useState("");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([blankLine()]);

  const setLine = (rid: string, patch: Partial<DraftLine>) => setLines((prev) => prev.map((l) => (l.rid === rid ? { ...l, ...patch } : l)));
  const dropLine = (rid: string) => setLines((prev) => prev.filter((l) => l.rid !== rid));
  const addLine = () => setLines((prev) => [...prev, blankLine()]);

  const subtotalCenti = useMemo(() => lines.reduce((s, l) => s + l.qty * l.unitPriceCenti, 0), [lines]);
  const canSave = debtorName.trim().length > 0 && lines.some((l) => l.itemCode.trim());

  const onSave = async () => {
    if (!canSave) { toast.error("Customer name and at least one line item are required."); return; }
    const realLines = lines.filter((l) => l.itemCode.trim());
    if (realLines.some((l) => l.qty < 1)) { toast.error("Each line needs a quantity of at least 1."); return; }
    try {
      const items: NewCnItem[] = realLines.map((l) => ({ itemGroup: l.itemGroup, itemCode: l.itemCode.trim(), description: l.description || null, qty: l.qty, unitPriceCenti: l.unitPriceCenti, unitCostCenti: l.unitCostCenti || undefined }));
      const res = await create.mutateAsync({
        debtorName: debtorName.trim(), debtorCode: debtorCode || null, phone: phone || null, consignmentSoDocNo: consignmentSoDocNo || null,
        warehouseId: warehouseId || null, address1: address1 || null, city: city || null, note: note || null, items,
      });
      navigate(`/consignment-notes/${res.id}`);
    } catch (err) {
      toast.error(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div className={styles.titleBlock}>
          <Link to="/consignment-notes" className={styles.backBtn}><ArrowLeft {...ICON} /><span>Back</span></Link>
          <div><h1 className={styles.title}>New Consignment Note</h1></div>
        </div>
        <div className={styles.actions}>
          <div className={styles.totalRail}><span className={styles.totalRailLabel}>Total</span><span className={styles.totalRailValue}>{fmtRm(subtotalCenti)}</span></div>
          <Button variant="primary" onClick={onSave} disabled={saving || !canSave}><Save {...ICON} /><span>{saving ? "Saving…" : "Create Consignment Note"}</span></Button>
        </div>
      </div>

      <section className={styles.card}>
        <header className={styles.cardHeader}><h2 className={styles.cardTitle}>Consignee · Ship From</h2></header>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <label className={styles.field} style={{ gridColumn: "span 2" }}><span className={styles.fieldLabel}>Customer / Consignee *</span><input className={styles.fieldInput} value={debtorName} onChange={(e) => setDebtorName(e.target.value)} /></label>
            <label className={styles.field}><span className={styles.fieldLabel}>Customer Code</span><input className={styles.fieldInput} value={debtorCode} onChange={(e) => setDebtorCode(e.target.value)} /></label>
            <label className={styles.field}><span className={styles.fieldLabel}>Phone</span><input className={styles.fieldInput} value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
            <label className={styles.field}><span className={styles.fieldLabel}>Consignment Order #</span><input className={styles.fieldInput} value={consignmentSoDocNo} placeholder="CS-…" onChange={(e) => setConsignmentSoDocNo(e.target.value)} /></label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Ship From Warehouse</span>
              <span className={styles.selectWrap}>
                <select className={styles.fieldSelect} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
                  <option value="">Default warehouse</option>
                  {(warehousesQ.data ?? []).map((w) => (<option key={w.id} value={w.id}>{w.code ?? w.name}</option>))}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <label className={styles.field} style={{ gridColumn: "span 2" }}><span className={styles.fieldLabel}>Address Line 1</span><input className={styles.fieldInput} value={address1} onChange={(e) => setAddress1(e.target.value)} /></label>
            <label className={styles.field}><span className={styles.fieldLabel}>City</span><input className={styles.fieldInput} value={city} onChange={(e) => setCity(e.target.value)} /></label>
            <label className={styles.field} style={{ gridColumn: "span 2" }}><span className={styles.fieldLabel}>Note</span><input className={styles.fieldInput} value={note} onChange={(e) => setNote(e.target.value)} /></label>
          </div>
        </div>
      </section>

      <section className={styles.card}>
        <header className={styles.cardHeader}><h2 className={styles.cardTitle}>Line Items ({lines.length})</h2></header>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Group</th><th>Item Code</th><th>Description</th>
              <th className={styles.tableRight}>Qty</th><th className={styles.tableRight}>Unit Price</th><th className={styles.tableRight}>Unit Cost</th><th className={styles.tableRight}>Line Total</th><th className={styles.tableRight}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.rid}>
                <td>
                  <span className={styles.selectWrap}>
                    <select className={styles.fieldSelect} style={{ width: 120 }} value={l.itemGroup} onChange={(e) => setLine(l.rid, { itemGroup: e.target.value })}>
                      {ITEM_GROUPS.map((g) => (<option key={g} value={g}>{g}</option>))}
                    </select>
                    <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
                  </span>
                </td>
                <td><input className={styles.fieldInput} style={{ width: 130 }} value={l.itemCode} placeholder="Code" onChange={(e) => setLine(l.rid, { itemCode: e.target.value })} /></td>
                <td><input className={styles.fieldInput} style={{ width: 200 }} value={l.description} placeholder="Description" onChange={(e) => setLine(l.rid, { description: e.target.value })} /></td>
                <td className={styles.tableRight}><input type="number" min={1} className={styles.fieldInput} style={{ width: 70, textAlign: "right" }} value={l.qty} onChange={(e) => setLine(l.rid, { qty: Math.max(1, Number(e.target.value) || 1) })} /></td>
                <td className={styles.tableRight}><InlineRmInput valueCenti={l.unitPriceCenti} onCommit={(centi) => setLine(l.rid, { unitPriceCenti: centi })} style={{ width: 100 }} /></td>
                <td className={styles.tableRight}><InlineRmInput valueCenti={l.unitCostCenti} onCommit={(centi) => setLine(l.rid, { unitCostCenti: centi })} style={{ width: 100 }} /></td>
                <td className={styles.priceCell}>{fmtRm(l.qty * l.unitPriceCenti)}</td>
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
