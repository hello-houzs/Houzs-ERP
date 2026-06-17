// ----------------------------------------------------------------------------
// PurchaseConsignmentReturnFromReceive — convert returnable PC Receive lines into
// ONE PC Return. 1:1 clone of 2990s
// apps/backend/src/pages/PurchaseConsignmentReturnFromReceive.tsx. Multi-select
// returnable lines (single supplier), set return qty per line, Create → inventory
// OUT. SEAM playbook: ./consignment-purchase-queries; in-app useToast (rule #10).
// ----------------------------------------------------------------------------

import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, Save } from "lucide-react";
import { Button } from "../../components/Button";
import { useReturnablePcrLines, useCreatePcReturn, type ReturnablePcrLine, type NewPctItem } from "./consignment-purchase-queries";
import { useToast } from "../../hooks/useToast";
import styles from "./PurchaseOrderDetail.module.css";

const ICON = { size: 16, strokeWidth: 1.75 } as const;
const todayMyt = (): string => new Date().toISOString().slice(0, 10);
const fmtRm = (centi: number | null | undefined): string => `MYR ${((centi ?? 0) / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const PurchaseConsignmentReturnFromReceive = () => {
  const navigate = useNavigate();
  const toast = useToast();
  const { data: lines = [], isLoading } = useReturnablePcrLines();
  const create = useCreatePcReturn();

  const [picked, setPicked] = useState<Record<string, number>>({}); // receiveItemId -> qty
  const [reason, setReason] = useState("");
  const [returnDate, setReturnDate] = useState(() => todayMyt());

  const byId = useMemo(() => new Map(lines.map((l) => [l.receiveItemId, l])), [lines]);
  const pickedIds = Object.keys(picked).filter((id) => (picked[id] ?? 0) > 0);
  const pickedSuppliers = new Set(pickedIds.map((id) => byId.get(id)?.supplierId).filter(Boolean));
  const supplierConflict = pickedSuppliers.size > 1;
  const supplierId = pickedSuppliers.size === 1 ? ([...pickedSuppliers][0] as string) : null;
  const pcReceiveId = pickedIds.length > 0 ? (byId.get(pickedIds[0]!)?.pcReceiveId ?? null) : null;

  const toggle = (l: ReturnablePcrLine, on: boolean) => setPicked((p) => ({ ...p, [l.receiveItemId]: on ? l.remaining : 0 }));
  const setQty = (id: string, qty: number) => setPicked((p) => ({ ...p, [id]: Math.max(0, qty) }));
  const canSave = !!supplierId && !supplierConflict && pickedIds.length > 0;

  const onSave = async () => {
    if (supplierConflict) return toast.error("Pick lines from a single supplier only.");
    if (!supplierId) return toast.error("Select at least one returnable line.");
    const items: NewPctItem[] = pickedIds
      .map((id): NewPctItem | null => {
        const l = byId.get(id)!;
        const qty = Math.min(picked[id] ?? 0, l.remaining);
        if (qty <= 0) return null;
        return {
          pcReceiveItemId: l.receiveItemId,
          materialKind: l.materialKind,
          materialCode: l.materialCode,
          materialName: l.materialName,
          qtyReturned: qty,
          unitPriceCenti: l.unitPriceCenti,
          itemGroup: l.itemGroup || null,
          variants: l.variants ?? null,
        };
      })
      .filter((x): x is NewPctItem => x !== null);
    if (items.length === 0) return toast.error("Set a return qty > 0 on at least one line.");
    try {
      const res = await create.mutateAsync({ supplierId, pcReceiveId, returnDate, reason: reason || undefined, items });
      navigate(`/purchase-consignment-returns/${res.id}`);
    } catch (err) {
      toast.error(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div className={styles.titleBlock}>
          <Link to="/purchase-consignment-returns" className={styles.backBtn}>
            <ArrowLeft {...ICON} />
            <span>Back</span>
          </Link>
          <div>
            <h1 className={styles.title}>Return from PC Receives</h1>
          </div>
        </div>
        <div className={styles.actions}>
          <Button variant="primary" onClick={onSave} disabled={create.isPending || !canSave}>
            <Save {...ICON} />
            <span>{create.isPending ? "Saving…" : "Create PC Return"}</span>
          </Button>
        </div>
      </div>

      {supplierConflict && (
        <div className={styles.bannerWarn}>
          <strong>Mixed suppliers.</strong> A return can only cover one supplier — deselect lines from other suppliers.
        </div>
      )}

      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Return Details</h2>
        </header>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Return Date</span>
              <input type="date" className={styles.fieldInput} value={returnDate} onChange={(e) => setReturnDate(e.target.value)} />
            </label>
            <label className={styles.field} style={{ gridColumn: "span 2" }}>
              <span className={styles.fieldLabel}>Reason</span>
              <input className={styles.fieldInput} value={reason} placeholder="DEFECT / WRONG_ITEM / OVERSUPPLY / free text" onChange={(e) => setReason(e.target.value)} />
            </label>
          </div>
        </div>
      </section>

      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Returnable PC Receive lines</h2>
        </header>
        <table className={styles.table}>
          <thead>
            <tr>
              <th />
              <th>Receive</th>
              <th>Supplier</th>
              <th>Item</th>
              <th className={styles.tableRight}>Remaining</th>
              <th className={styles.tableRight}>Return Qty</th>
              <th className={styles.tableRight}>Unit Price</th>
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 && !isLoading ? (
              <tr>
                <td colSpan={7}>
                  <p className={styles.emptyRow}>No returnable PC Receive lines.</p>
                </td>
              </tr>
            ) : (
              lines.map((l) => {
                const on = (picked[l.receiveItemId] ?? 0) > 0;
                const disabled = !!supplierId && l.supplierId !== supplierId && !on;
                return (
                  <tr key={l.receiveItemId} style={disabled ? { opacity: 0.4 } : undefined}>
                    <td>
                      <input type="checkbox" checked={on} disabled={disabled} onChange={(e) => toggle(l, e.target.checked)} />
                    </td>
                    <td>
                      <span style={{ fontFamily: "var(--font-mono)", fontWeight: 700, color: "var(--c-burnt)" }}>{l.receiveNumber}</span>
                    </td>
                    <td>{l.supplierName || "—"}</td>
                    <td>
                      {l.materialCode}
                      {l.description ? ` · ${l.description}` : ""}
                    </td>
                    <td className={styles.tableRight}>{l.remaining}</td>
                    <td className={styles.tableRight}>
                      <input
                        type="number"
                        min={0}
                        max={l.remaining}
                        className={styles.fieldInput}
                        style={{ width: 80, textAlign: "right" }}
                        value={picked[l.receiveItemId] ?? 0}
                        disabled={disabled}
                        onChange={(e) => setQty(l.receiveItemId, Math.min(l.remaining, Number(e.target.value) || 0))}
                      />
                    </td>
                    <td className={styles.priceCell}>{fmtRm(l.unitPriceCenti)}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
};
