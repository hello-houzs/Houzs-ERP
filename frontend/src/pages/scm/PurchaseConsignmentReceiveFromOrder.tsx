// ----------------------------------------------------------------------------
// PurchaseConsignmentReceiveFromOrder — convert outstanding PC Order lines into
// ONE PC Receive. 1:1 clone of 2990s
// apps/backend/src/pages/PurchaseConsignmentReceiveFromOrder.tsx. Multi-select
// outstanding lines (single supplier), set received qty per line, Create → books
// inventory IN. SEAM playbook: ./consignment-purchase-queries; in-app useToast
// (rule #10); react-router-dom.
// ----------------------------------------------------------------------------

import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, Save } from "lucide-react";
import { Button } from "../../components/Button";
import { useOutstandingPcoLines, useCreatePcReceive, type OutstandingPcoItem, type NewPcrItem } from "./consignment-purchase-queries";
import { useToast } from "../../hooks/useToast";
import styles from "./PurchaseOrderDetail.module.css";

const ICON = { size: 16, strokeWidth: 1.75 } as const;
const todayMyt = (): string => new Date().toISOString().slice(0, 10);
const fmtRm = (centi: number | null | undefined): string => `MYR ${((centi ?? 0) / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const PurchaseConsignmentReceiveFromOrder = () => {
  const navigate = useNavigate();
  const toast = useToast();
  const { data: lines = [], isLoading } = useOutstandingPcoLines();
  const create = useCreatePcReceive();

  const [picked, setPicked] = useState<Record<string, number>>({}); // pcoItemId -> qtyToReceive
  const [deliveryNoteRef, setDeliveryNoteRef] = useState("");
  const [receivedAt, setReceivedAt] = useState(() => todayMyt());

  const byId = useMemo(() => new Map(lines.map((l) => [l.pcoItemId, l])), [lines]);
  const pickedIds = Object.keys(picked).filter((id) => (picked[id] ?? 0) > 0);
  const pickedSuppliers = new Set(pickedIds.map((id) => byId.get(id)?.supplierId).filter(Boolean));
  const supplierConflict = pickedSuppliers.size > 1;
  const supplierId = pickedSuppliers.size === 1 ? ([...pickedSuppliers][0] as string) : null;
  const warehouseId = pickedIds.length > 0 ? (byId.get(pickedIds[0]!)?.warehouseId ?? null) : null;

  const toggle = (l: OutstandingPcoItem, on: boolean) => setPicked((p) => ({ ...p, [l.pcoItemId]: on ? l.remainingQty : 0 }));
  const setQty = (id: string, qty: number) => setPicked((p) => ({ ...p, [id]: Math.max(0, qty) }));

  const canSave = !!supplierId && !supplierConflict && pickedIds.length > 0;

  const onSave = async () => {
    if (supplierConflict) return toast.error("Pick lines from a single supplier only.");
    if (!supplierId) return toast.error("Select at least one outstanding line.");
    const items: NewPcrItem[] = pickedIds
      .map((id): NewPcrItem | null => {
        const l = byId.get(id)!;
        const qty = Math.min(picked[id] ?? 0, l.remainingQty);
        if (qty <= 0) return null;
        return {
          pcOrderItemId: l.pcoItemId,
          materialKind: "mfg_product",
          materialCode: l.itemCode,
          materialName: l.description ?? l.itemCode,
          qtyReceived: qty,
          qtyAccepted: qty,
          unitPriceCenti: l.unitPriceCenti,
          itemGroup: l.itemGroup || null,
          variants: l.variants ?? null,
        };
      })
      .filter((x): x is NewPcrItem => x !== null);
    if (items.length === 0) return toast.error("Set a received qty > 0 on at least one line.");
    try {
      const res = await create.mutateAsync({
        supplierId,
        purchaseConsignmentOrderId: byId.get(pickedIds[0]!)?.pcoId ?? null,
        receivedAt,
        deliveryNoteRef: deliveryNoteRef || undefined,
        warehouseId,
        items,
      });
      navigate(`/purchase-consignment-receives/${res.id}`);
    } catch (err) {
      toast.error(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div className={styles.titleBlock}>
          <Link to="/purchase-consignment-receives" className={styles.backBtn}>
            <ArrowLeft {...ICON} />
            <span>Back</span>
          </Link>
          <div>
            <h1 className={styles.title}>Receive from PC Orders</h1>
          </div>
        </div>
        <div className={styles.actions}>
          <Button variant="primary" onClick={onSave} disabled={create.isPending || !canSave}>
            <Save {...ICON} />
            <span>{create.isPending ? "Saving…" : "Create PC Receive"}</span>
          </Button>
        </div>
      </div>

      {supplierConflict && (
        <div className={styles.bannerWarn}>
          <strong>Mixed suppliers.</strong> A receive can only cover one supplier — deselect lines from other suppliers.
        </div>
      )}

      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Receive Details</h2>
        </header>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Received Date</span>
              <input type="date" className={styles.fieldInput} value={receivedAt} onChange={(e) => setReceivedAt(e.target.value)} />
            </label>
            <label className={styles.field} style={{ gridColumn: "span 2" }}>
              <span className={styles.fieldLabel}>Supplier DO ref</span>
              <input className={styles.fieldInput} value={deliveryNoteRef} onChange={(e) => setDeliveryNoteRef(e.target.value)} />
            </label>
          </div>
        </div>
      </section>

      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Outstanding PC Order lines</h2>
        </header>
        <table className={styles.table}>
          <thead>
            <tr>
              <th />
              <th>PC Order</th>
              <th>Supplier</th>
              <th>Item</th>
              <th className={styles.tableRight}>Remaining</th>
              <th className={styles.tableRight}>Receive Qty</th>
              <th className={styles.tableRight}>Unit Price</th>
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 && !isLoading ? (
              <tr>
                <td colSpan={7}>
                  <p className={styles.emptyRow}>No outstanding PC Order lines.</p>
                </td>
              </tr>
            ) : (
              lines.map((l) => {
                const on = (picked[l.pcoItemId] ?? 0) > 0;
                const disabled = !!supplierId && l.supplierId !== supplierId && !on;
                return (
                  <tr key={l.pcoItemId} style={disabled ? { opacity: 0.4 } : undefined}>
                    <td>
                      <input type="checkbox" checked={on} disabled={disabled} onChange={(e) => toggle(l, e.target.checked)} />
                    </td>
                    <td>
                      <span style={{ fontFamily: "var(--font-mono)", fontWeight: 700, color: "var(--c-burnt)" }}>{l.pcoDocNo}</span>
                    </td>
                    <td>{l.supplierName || l.supplierCode}</td>
                    <td>
                      {l.itemCode}
                      {l.description ? ` · ${l.description}` : ""}
                    </td>
                    <td className={styles.tableRight}>{l.remainingQty}</td>
                    <td className={styles.tableRight}>
                      <input
                        type="number"
                        min={0}
                        max={l.remainingQty}
                        className={styles.fieldInput}
                        style={{ width: 80, textAlign: "right" }}
                        value={picked[l.pcoItemId] ?? 0}
                        disabled={disabled}
                        onChange={(e) => setQty(l.pcoItemId, Math.min(l.remainingQty, Number(e.target.value) || 0))}
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
