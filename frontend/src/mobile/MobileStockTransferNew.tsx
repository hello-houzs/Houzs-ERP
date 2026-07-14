import { useMemo, useState } from "react";
import { todayMyt } from "../vendor/scm/lib/dates";
import { useWarehouses } from "../vendor/scm/lib/inventory-queries";
import {
  useInventoryBalances,
  useCreateStockTransfer,
} from "../vendor/scm/lib/stock-queries";
import { useNotify } from "../vendor/scm/components/NotifyDialog";
import { MobileSkuPicker, type PickedSku } from "./MobileSkuPicker";

/* ------------------------------------------------------------------ *
 * Mobile New Stock Transfer — From -> To (must differ) + date + notes,
 * item lines with a SKU picker and a LIVE available-at-source lookup.
 * A line whose qty exceeds source stock blocks Create — same guard as
 * desktop StockTransferNew. Reuses the vendored useCreateStockTransfer
 * mutation + useInventoryBalances; no backend change.
 * ------------------------------------------------------------------ */

type LineDraft = { _key: string; productCode: string; productName: string; qty: number };

let seq = 0;
const newKey = () => `l${seq++}`;

export function MobileStockTransferNew({
  onBack,
  onCreated,
}: {
  onBack: () => void;
  onCreated?: () => void;
}) {
  const notify = useNotify();
  const create = useCreateStockTransfer();
  const warehouses = useWarehouses();

  const [fromWarehouseId, setFromWarehouseId] = useState("");
  const [toWarehouseId, setToWarehouseId] = useState("");
  const [transferDate, setTransferDate] = useState(() => todayMyt());
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);

  // Live balances at the source warehouse → available-per-SKU.
  const balancesQ = useInventoryBalances({ warehouseId: fromWarehouseId || undefined });
  const balanceMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of balancesQ.data?.balances ?? []) m.set(b.product_code, b.qty ?? 0);
    return m;
  }, [balancesQ.data]);

  const whList = warehouses.data ?? [];
  const sameWarehouse = Boolean(fromWarehouseId && toWarehouseId && fromWarehouseId === toWarehouseId);
  const validLines = lines.filter((l) => l.productCode.trim() && l.qty > 0);
  const overdrawn = validLines.filter((l) => {
    const avail = balanceMap.get(l.productCode);
    return avail != null && l.qty > avail;
  });
  const canCreate =
    !!fromWarehouseId && !!toWarehouseId && !sameWarehouse && !!transferDate &&
    validLines.length > 0 && overdrawn.length === 0 && !create.isPending;

  const addSku = (sku: PickedSku) => {
    setPickerOpen(false);
    setLines((prev) =>
      prev.some((l) => l.productCode === sku.itemCode)
        ? prev
        : [...prev, { _key: newKey(), productCode: sku.itemCode, productName: sku.name, qty: 1 }],
    );
  };
  const setQty = (key: string, qty: number) =>
    setLines((prev) => prev.map((l) => (l._key === key ? { ...l, qty: Math.max(1, qty) } : l)));
  const removeLine = (key: string) => setLines((prev) => prev.filter((l) => l._key !== key));

  const submit = () => {
    if (!canCreate) return;
    create.mutate(
      {
        fromWarehouseId,
        toWarehouseId,
        transferDate,
        notes: notes.trim() || undefined,
        items: validLines.map((l) => ({ productCode: l.productCode, productName: l.productName, qty: l.qty })),
      },
      {
        onSuccess: (r) => {
          void notify({ title: `Stock transfer ${r.transferNo} created` });
          onCreated ? onCreated() : onBack();
        },
        onError: (e) =>
          void notify({ title: e instanceof Error ? e.message : "Couldn't create the transfer.", tone: "error" }),
      },
    );
  };

  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <header className="hdr">
        <div className="hdr-row">
          <button className="back" onClick={onBack}><span className="chev">‹</span> Back</button>
          <span className="eyebrow">Warehouse · Move stock</span>
        </div>
        <div className="hdr-row" style={{ marginTop: 2 }}>
          <div className="scr-title">New Stock Transfer</div>
        </div>
      </header>

      <div className="hz-scroll" style={{ flex: 1, overflowY: "auto", padding: 14, paddingBottom: 40, display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="st-whrow">
          <div className="st-fld">
            <span className="st-fl">From</span>
            <select className="cal-sel" value={fromWarehouseId} onChange={(e) => setFromWarehouseId(e.target.value)}>
              <option value="">Select…</option>
              {whList.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </div>
          <div className="st-arrow">→</div>
          <div className="st-fld">
            <span className="st-fl">To</span>
            <select className="cal-sel" value={toWarehouseId} onChange={(e) => setToWarehouseId(e.target.value)}>
              <option value="">Select…</option>
              {whList.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </div>
        </div>
        {sameWarehouse && <div className="st-warn">From and To must be different warehouses.</div>}

        <div className="st-whrow">
          <div className="st-fld">
            <span className="st-fl">Date</span>
            <input type="date" className="cal-sel" value={transferDate} onChange={(e) => setTransferDate(e.target.value)} />
          </div>
          <div className="st-fld">
            <span className="st-fl">Notes</span>
            <input className="cal-sel" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
          </div>
        </div>

        <div className="sc-sl"><span className="t">Items</span><span className="ln" /></div>
        {lines.map((l) => {
          const avail = l.productCode ? balanceMap.get(l.productCode) : undefined;
          const over = avail != null && l.qty > avail;
          return (
            <div key={l._key} className="st-line">
              <div className="lh">
                <div>
                  <div className="sku">{l.productName || l.productCode}</div>
                  <div className="code tnum">{l.productCode}</div>
                </div>
                <button className="x" onClick={() => removeLine(l._key)} aria-label="Remove line">×</button>
              </div>
              <div className="qtyrow">
                <div className="stepper">
                  <button onClick={() => setQty(l._key, l.qty - 1)} aria-label="Decrease">−</button>
                  <span className="q tnum">{l.qty}</span>
                  <button onClick={() => setQty(l._key, l.qty + 1)} aria-label="Increase">+</button>
                </div>
                <span className={`avail${over ? " over" : ""} tnum`}>
                  {fromWarehouseId ? (avail == null ? "avail —" : `avail ${avail}`) : "pick source"}
                </span>
              </div>
            </div>
          );
        })}

        {overdrawn.length > 0 && (
          <div className="st-warn">
            {overdrawn.map((l) => `${l.productName || l.productCode} exceeds stock (want ${l.qty}, have ${balanceMap.get(l.productCode) ?? 0})`).join(". ")}. Reduce or pick another source.
          </div>
        )}

        <button className="st-addln" onClick={() => setPickerOpen(true)}>+ Add item</button>
      </div>

      <div className="actbar">
        <button className="btn" disabled={!canCreate} style={{ opacity: canCreate ? 1 : 0.5 }} onClick={submit}>
          {create.isPending ? "Creating…" : "Create transfer"}
        </button>
      </div>

      {pickerOpen && (
        <MobileSkuPicker onPick={addSku} onClose={() => setPickerOpen(false)} />
      )}
    </div>
  );
}

export default MobileStockTransferNew;
