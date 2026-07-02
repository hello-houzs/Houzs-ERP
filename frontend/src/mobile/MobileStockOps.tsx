// ----------------------------------------------------------------------------
// MobileStockOps — the three inventory-critical stock operations on mobile:
//   • Stock Adjustment  → POST /inventory/adjustments      (useStockAdjustment)
//   • Stock Transfer    → POST /stock-transfers            (useCreateStockTransfer)
//   • Stock Take        → POST /stock-takes                (useCreateStockTake)
//
// Mobile ports of the desktop scm-v2 pages (StockAdjustmentNew / StockTransferNew
// / StockTakeNew). They send ONLY what the backend needs and let the server write
// the movement ledger (FIFO lots, balances VIEW) — nothing is computed
// client-side. Balances shown are read-only hints for the operator.
//
// Everyday flow, single-line per screen (the desktop multi-line grid collapses to
// one SKU on mobile). Transfer + Adjustment are full; Stock Take is the count-sheet
// CREATE step (snapshot) — entering the counts per line stays on desktop (phase 2).
//
// UI: shared .hz-m chrome (hdr / scroll / actbar / fld / fld-i / btn), the
// MobileSkuPicker bottom-sheet for choosing the SKU, useConfirm/useNotify dialogs
// (never window.*). Warehouse is a real <select> over the live warehouse list.
// ----------------------------------------------------------------------------

import { useMemo, useState } from "react";
import { useNotify } from "../vendor/scm/components/NotifyDialog";
import { useConfirm } from "../vendor/scm/components/ConfirmDialog";
import { useWarehouses } from "../vendor/scm/lib/inventory-queries";
import {
  useStockAdjustment,
  useInventoryBuckets,
  useInventoryProductBreakdown,
  useInventoryBalances,
  useCreateStockTransfer,
  useCreateStockTake,
  type StockTakeScopeType,
} from "../vendor/scm/lib/stock-queries";
import {
  useMaintenanceConfig,
  useSpecialAddons,
} from "../vendor/scm/lib/mfg-products-queries";
import { ADJUSTMENT_REASONS } from "../vendor/shared/adjustment-reasons";
import { adjustmentIncreaseErrors } from "../vendor/shared/inventory-adjustment";
import { activeOptions, maintPickerValues } from "../vendor/shared/maintenance-pools";
import { MobileSkuPicker, type PickedSku } from "./MobileSkuPicker";
import "./mobile.css";

export type StockOp = "adjustment" | "transfer" | "take";

const todayISO = (): string => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/* Shared screen chrome — back header + eyebrow/title, matching MobileModuleForm. */
function OpHeader({ eyebrow, title, onBack }: { eyebrow: string; title: string; onBack: () => void }) {
  return (
    <header className="hdr">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span onClick={onBack} style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 12.5, fontWeight: 600, color: "#16695f", cursor: "pointer" }}>
          <span style={{ fontSize: 17, lineHeight: 1 }}>{"‹"}</span> Inventory
        </span>
        <span onClick={onBack} style={{ fontSize: 13, fontWeight: 600, color: "#767b6e", cursor: "pointer" }}>Cancel</span>
      </div>
      <div className="ey" style={{ color: "#a16a2e", marginTop: 6 }}>{eyebrow}</div>
      <div style={{ fontSize: 19, fontWeight: 800, color: "#11140f", marginTop: 2 }}>{title}</div>
    </header>
  );
}

/* Live warehouse <select> — real picker over GET /inventory/warehouses, never
   free text. `disabledId` greys out a warehouse (e.g. the transfer source). */
function WarehouseSelect({
  value, onChange, placeholder, disabledId,
}: {
  value: string;
  onChange: (id: string) => void;
  placeholder: string;
  disabledId?: string;
}) {
  const warehouses = useWarehouses();
  const rows = useMemo(
    () => [...(warehouses.data ?? [])].sort((a, b) => a.code.localeCompare(b.code)),
    [warehouses.data],
  );
  return (
    <select className="fld-i" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder}</option>
      {rows.map((w) => (
        <option key={w.id} value={w.id} disabled={w.id === disabledId}>
          {w.code} · {w.name}{w.id === disabledId ? " (source)" : ""}
        </option>
      ))}
    </select>
  );
}

/* Compact SKU row — tap to open the MobileSkuPicker, shows the picked identity. */
function SkuField({ picked, onOpen }: { picked: PickedSku | null; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="fld-i"
      style={{ textAlign: "left", cursor: "pointer", display: "flex", alignItems: "center", gap: 8, minHeight: 34 }}
    >
      {picked ? (
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: "block", fontSize: 12.5, fontWeight: 700, color: "#11140f", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{picked.name}</span>
          <span style={{ display: "block", fontSize: 10, color: "#767b6e", marginTop: 1 }}>{picked.itemCode} · {picked.category}</span>
        </span>
      ) : (
        <span style={{ flex: 1, color: "#9aa093" }}>Tap to pick a product…</span>
      )}
      <span style={{ color: "#16695f", fontSize: 11, fontWeight: 700 }}>{picked ? "Change" : "Pick"}</span>
    </button>
  );
}

const intQty = (raw: string): number => Math.max(0, Math.floor(Number(raw) || 0));

/* ═══════════════════════════════════════════════════════════════════════════
   STOCK ADJUSTMENT — pick SKU + warehouse, Increase / Decrease qty + reason.
   INCREASE behaves like a mini-receipt (sofa/bedframe carry variant + batch so
   the found stock lands in the right bucket — same gate the backend enforces).
   DECREASE targets an EXISTING open lot the operator picks (variant_key + batch).
   ═══════════════════════════════════════════════════════════════════════════ */
function AdjustmentScreen({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const notify = useNotify();
  const confirm = useConfirm();
  const adjust = useStockAdjustment();

  const [warehouseId, setWarehouseId] = useState("");
  const [picked, setPicked] = useState<PickedSku | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [type, setType] = useState<"increase" | "decrease">("decrease");
  const [qty, setQty] = useState(1);
  const [reasonCode, setReasonCode] = useState("");
  const [notes, setNotes] = useState("");

  // INCREASE variant editor (sofa / bedframe). Same attribute keys the GRN/PO
  // store — the backend computes variant_key from these on save.
  const [variants, setVariants] = useState<Record<string, string>>({});
  const [batchNo, setBatchNo] = useState("");
  // DECREASE — the exact open lot the stock comes out of.
  const [bucketKey, setBucketKey] = useState("");

  const productCode = picked?.itemCode ?? "";
  const itemGroup = picked?.itemGroup ?? "";
  const hasVariantGroup = itemGroup === "sofa" || itemGroup === "bedframe";

  const maintQ = useMaintenanceConfig("master");
  const maint = maintQ.data?.data ?? null;
  const specialAddonsQ = useSpecialAddons();
  const specials = useMemo(() => {
    const rows = (specialAddonsQ.data ?? []).filter((r) => r.active);
    const pick = (cat: string) => rows.filter((r) => r.categories.includes(cat)).map((r) => r.code);
    return { bedframe: pick("BEDFRAME"), sofa: pick("SOFA") };
  }, [specialAddonsQ.data]);

  // Open lots for the DECREASE "Take from" picker (only once wh + SKU are set).
  const bucketsQ = useInventoryBuckets(productCode || null, warehouseId || null);
  const buckets = bucketsQ.data ?? [];

  // Current balance @ warehouse — read-only hint; server stays authoritative.
  const breakdown = useInventoryProductBreakdown(productCode || null);
  const currentBalance = useMemo<number | null>(() => {
    if (!warehouseId || !productCode) return null;
    const rows = breakdown.data?.balances ?? [];
    const at = rows.filter((b) => (b.warehouse_id ?? (b as { warehouseId?: string }).warehouseId) === warehouseId);
    if (at.length === 0) return breakdown.isLoading ? null : 0;
    return at.reduce((s, r) => s + (r.qty ?? 0), 0);
  }, [warehouseId, productCode, breakdown.data, breakdown.isLoading]);

  const qtyDelta = type === "increase" ? qty : -qty;
  const resultingBalance = currentBalance == null ? null : currentBalance + qtyDelta;
  const willGoNegative = resultingBalance != null && resultingBalance < 0;

  const setVariant = (key: string, value: string) =>
    setVariants((prev) => ({ ...prev, [key]: value }));

  const onPickSku = (sku: PickedSku) => {
    setPicked(sku);
    setVariants({});
    setBatchNo("");
    setBucketKey("");
    setQty(1);
  };

  const pickedBucket = useMemo(
    () => buckets.find((b) => `${b.variant_key}|${b.batch_no ?? ""}` === bucketKey) ?? null,
    [buckets, bucketKey],
  );
  const bucketCap = type === "decrease" && pickedBucket ? pickedBucket.qty : null;

  const canSave = Boolean(warehouseId && productCode && qty > 0 && reasonCode);

  const onSave = async () => {
    if (!canSave) {
      notify({ title: "Pick a warehouse, product, quantity and reason first.", tone: "error" });
      return;
    }
    if (type === "increase" && hasVariantGroup) {
      const errs = adjustmentIncreaseErrors(itemGroup, variants, batchNo);
      if (errs.length > 0) { notify({ title: "Fill the found-stock details", body: errs.join("\n"), tone: "error" }); return; }
    }
    if (type === "decrease" && buckets.length > 0 && !pickedBucket) {
      notify({ title: "Pick which batch / variant to take the stock from.", tone: "error" });
      return;
    }
    if (willGoNegative) {
      const proceed = await confirm({
        title: "Balance will go below zero",
        body: `This adjustment pushes the balance to ${resultingBalance}. Continue?`,
        confirmLabel: "Adjust anyway",
        danger: true,
      });
      if (!proceed) return;
    }

    adjust.mutate(
      {
        warehouseId,
        productCode,
        productName: picked?.name || undefined,
        qtyDelta,
        reasonCode,
        notes: notes.trim() || undefined,
        itemGroup: hasVariantGroup ? itemGroup : undefined,
        variants: type === "increase" && hasVariantGroup ? variants : undefined,
        batchNo: type === "increase" ? (batchNo.trim() || undefined) : (pickedBucket?.batch_no ?? undefined),
        variantKey: type === "decrease" ? (pickedBucket?.variant_key || undefined) : undefined,
      },
      {
        onSuccess: () => { notify({ title: "Adjustment posted" }); onDone(); },
        onError: (err) => notify({ title: "Save failed", body: err instanceof Error ? err.message : String(err), tone: "error" }),
      },
    );
  };

  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <OpHeader eyebrow="Warehouse" title="Stock Adjustment" onBack={onBack} />
      <div className="scroll" style={{ padding: 12, paddingBottom: 24, display: "flex", flexDirection: "column", gap: 10 }}>
        <label className="fld">
          <span className="fld-l">Warehouse *</span>
          <WarehouseSelect value={warehouseId} onChange={(id) => { setWarehouseId(id); setBucketKey(""); }} placeholder="Pick a warehouse…" />
        </label>

        <label className="fld">
          <span className="fld-l">Product *</span>
          <SkuField picked={picked} onOpen={() => setPickerOpen(true)} />
        </label>

        {warehouseId && productCode && (
          <div style={{ fontSize: 11.5, color: "#767b6e", background: "#f4f6f3", border: "1px solid #d6d9d2", borderRadius: 9, padding: "7px 10px" }}>
            Current balance:{" "}
            <strong className="tnum" style={{ color: "#11140f" }}>
              {breakdown.isLoading ? "…" : (currentBalance ?? 0).toLocaleString("en-MY")} PCS
            </strong>
            {resultingBalance != null && (
              <span> → resulting <strong className="tnum" style={{ color: willGoNegative ? "#b23a3a" : "#0c3f39" }}>{resultingBalance.toLocaleString("en-MY")} PCS</strong></span>
            )}
          </div>
        )}

        {/* Increase / Decrease segment */}
        <div className="fld">
          <span className="fld-l">Adjustment type *</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={() => { setType("decrease"); }}
              style={{ flex: 1, padding: "9px 10px", borderRadius: 10, fontFamily: "inherit", fontSize: 12.5, fontWeight: 700, cursor: "pointer", border: "1px solid " + (type === "decrease" ? "#b23a3a" : "#d6d9d2"), background: type === "decrease" ? "#b23a3a" : "#fff", color: type === "decrease" ? "#fff" : "#11140f" }}>
              − Decrease
            </button>
            <button type="button" onClick={() => { setType("increase"); setBucketKey(""); }}
              style={{ flex: 1, padding: "9px 10px", borderRadius: 10, fontFamily: "inherit", fontSize: 12.5, fontWeight: 700, cursor: "pointer", border: "1px solid " + (type === "increase" ? "#2f5d4f" : "#d6d9d2"), background: type === "increase" ? "#2f5d4f" : "#fff", color: type === "increase" ? "#fff" : "#11140f" }}>
              + Increase
            </button>
          </div>
          <span className="fld-l" style={{ textTransform: "none", letterSpacing: 0, color: "#9aa093", marginTop: 2 }}>
            {type === "decrease" ? "Write-off / damage / loss" : "Found stock / recount up"}
          </span>
        </div>

        {/* DECREASE — pick the open lot the stock comes out of. */}
        {type === "decrease" && warehouseId && productCode && (
          <label className="fld">
            <span className="fld-l">Take from *</span>
            {bucketsQ.isLoading ? (
              <span className="fld-ro">Loading open stock…</span>
            ) : buckets.length === 0 ? (
              <span className="fld-ro">No open stock to take from.</span>
            ) : (
              <select className="fld-i" value={bucketKey} onChange={(e) => {
                setBucketKey(e.target.value);
                const b = buckets.find((x) => `${x.variant_key}|${x.batch_no ?? ""}` === e.target.value);
                if (b) setQty((q) => Math.min(q, b.qty));
              }}>
                <option value="">Pick which batch / variant…</option>
                {buckets.map((b) => (
                  <option key={`${b.variant_key}|${b.batch_no ?? ""}`} value={`${b.variant_key}|${b.batch_no ?? ""}`}>
                    {(b.batch_no || "No batch")} · {(b.variant_key || "plain")} · {b.qty} PCS
                  </option>
                ))}
              </select>
            )}
          </label>
        )}

        {/* INCREASE — variant editor + batch for sofa / bedframe (found stock must
            carry the same attributes a real receipt would). */}
        {type === "increase" && hasVariantGroup && maint && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, background: "#f4f6f3", border: "1px solid #d6d9d2", borderRadius: 11, padding: 10 }}>
            <span className="fld-l" style={{ color: "#a16a2e" }}>{itemGroup} variants</span>
            {itemGroup === "bedframe" ? (
              <>
                <label className="fld"><span className="fld-l">Divan Height *</span>
                  <select className="fld-i" value={variants.divanHeight ?? ""} onChange={(e) => setVariant("divanHeight", e.target.value)}>
                    <option value=""></option>
                    {activeOptions(maint.divanHeights ?? [], variants.divanHeight ?? "").map((o) => <option key={o.value} value={o.value}>{o.value}</option>)}
                  </select>
                </label>
                <label className="fld"><span className="fld-l">Leg Height *</span>
                  <select className="fld-i" value={variants.legHeight ?? ""} onChange={(e) => setVariant("legHeight", e.target.value)}>
                    <option value=""></option>
                    {activeOptions(maint.legHeights ?? [], variants.legHeight ?? "").map((o) => <option key={o.value} value={o.value}>{o.value}</option>)}
                  </select>
                </label>
                <label className="fld"><span className="fld-l">Gap *</span>
                  <select className="fld-i" value={variants.gap ?? ""} onChange={(e) => setVariant("gap", e.target.value)}>
                    <option value=""></option>
                    {maintPickerValues(maint.gaps ?? [], variants.gap ?? "").map((g) => <option key={g} value={g}>{g}</option>)}
                  </select>
                </label>
                <label className="fld"><span className="fld-l">Fabric / Colour *</span>
                  <input className="fld-i" value={variants.fabricCode ?? ""} onChange={(e) => setVariant("fabricCode", e.target.value)} />
                </label>
                <label className="fld"><span className="fld-l">Special</span>
                  <select className="fld-i" value={variants.special ?? ""} onChange={(e) => setVariant("special", e.target.value)}>
                    <option value=""></option>
                    {specials.bedframe.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </label>
              </>
            ) : (
              <>
                <label className="fld"><span className="fld-l">Seat Size *</span>
                  <select className="fld-i" value={variants.seatHeight ?? ""} onChange={(e) => setVariant("seatHeight", e.target.value)}>
                    <option value=""></option>
                    {maintPickerValues(maint.sofaSizes ?? [], variants.seatHeight ?? "").map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </label>
                <label className="fld"><span className="fld-l">Leg Height *</span>
                  <select className="fld-i" value={variants.legHeight ?? ""} onChange={(e) => setVariant("legHeight", e.target.value)}>
                    <option value=""></option>
                    {activeOptions(maint.sofaLegHeights ?? [], variants.legHeight ?? "").map((o) => <option key={o.value} value={o.value}>{o.value}</option>)}
                  </select>
                </label>
                <label className="fld"><span className="fld-l">Fabric / Colour *</span>
                  <input className="fld-i" value={variants.fabricCode ?? ""} onChange={(e) => setVariant("fabricCode", e.target.value)} />
                </label>
                <label className="fld"><span className="fld-l">Special</span>
                  <select className="fld-i" value={variants.special ?? ""} onChange={(e) => setVariant("special", e.target.value)}>
                    <option value=""></option>
                    {specials.sofa.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </label>
              </>
            )}
            <label className="fld"><span className="fld-l">Batch Number{itemGroup === "sofa" ? " *" : ""}</span>
              <input className="fld-i" value={batchNo} onChange={(e) => setBatchNo(e.target.value)} placeholder="Lot / batch label" />
            </label>
          </div>
        )}

        <div className="fld-row">
          <label className="fld">
            <span className="fld-l">Qty *</span>
            <input
              className="fld-i tnum"
              type="number"
              inputMode="numeric"
              min={1}
              max={bucketCap ?? undefined}
              step={1}
              value={qty}
              onChange={(e) => {
                let n = intQty(e.target.value);
                if (bucketCap != null) n = Math.min(bucketCap, n);
                setQty(n);
              }}
              style={{ textAlign: "right" }}
            />
          </label>
          <label className="fld">
            <span className="fld-l">Reason *</span>
            <select className="fld-i" value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
              <option value="">Pick a reason…</option>
              {ADJUSTMENT_REASONS.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
            </select>
          </label>
        </div>

        <label className="fld">
          <span className="fld-l">Notes</span>
          <textarea className="fld-i" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional — e.g. water damage, found during recount" />
        </label>
      </div>

      <footer className="actbar">
        <button className="btn" disabled={adjust.isPending} onClick={onSave} style={{ opacity: adjust.isPending ? 0.6 : 1 }}>
          {adjust.isPending ? "Posting…" : "Post Adjustment"}
        </button>
      </footer>

      {pickerOpen && (
        <MobileSkuPicker
          initialCat={itemGroup === "sofa" ? "sofa" : itemGroup === "bedframe" ? "bedframe" : ""}
          onClose={() => setPickerOpen(false)}
          onPick={(sku) => { onPickSku(sku); setPickerOpen(false); }}
        />
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   STOCK TRANSFER — pick SKU + From/To warehouse + qty. Posts immediately;
   the server writes the paired OUT/IN movements. Single line on mobile.
   ═══════════════════════════════════════════════════════════════════════════ */
function TransferScreen({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const notify = useNotify();
  const confirm = useConfirm();
  const create = useCreateStockTransfer();

  const [fromWarehouseId, setFromWarehouseId] = useState("");
  const [toWarehouseId, setToWarehouseId] = useState("");
  const [transferDate, setTransferDate] = useState(todayISO());
  const [notes, setNotes] = useState("");
  const [picked, setPicked] = useState<PickedSku | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [qty, setQty] = useState(1);

  const productCode = picked?.itemCode ?? "";
  const sameWarehouse = Boolean(fromWarehouseId && toWarehouseId && fromWarehouseId === toWarehouseId);

  // Available @ source — read-only hint.
  const balances = useInventoryBalances({ warehouseId: fromWarehouseId || undefined, showAll: true });
  const available = useMemo<number | null>(() => {
    if (!fromWarehouseId || !productCode) return null;
    const row = (balances.data?.balances ?? []).find((b) => (b.product_code ?? (b as { productCode?: string }).productCode) === productCode);
    return row ? row.qty : (balances.isLoading ? null : 0);
  }, [fromWarehouseId, productCode, balances.data, balances.isLoading]);
  const overdrawn = available != null && qty > available;

  const canSave = Boolean(fromWarehouseId && toWarehouseId && !sameWarehouse && transferDate && productCode && qty > 0);

  const onSave = async () => {
    if (!canSave) {
      notify({ title: "Pick From + To warehouses (must differ), a product and quantity.", tone: "error" });
      return;
    }
    if (overdrawn) {
      const proceed = await confirm({
        title: "Quantity exceeds available stock",
        body: `Want ${qty}, have ${available ?? 0} at the source. Posting pushes the source balance negative. Continue?`,
        confirmLabel: "Post anyway",
        danger: true,
      });
      if (!proceed) return;
    }
    create.mutate(
      {
        fromWarehouseId,
        toWarehouseId,
        transferDate,
        notes: notes.trim() || undefined,
        items: [{ productCode, productName: picked?.name || undefined, qty }],
      },
      {
        onSuccess: () => { notify({ title: "Transfer posted" }); onDone(); },
        onError: (err) => notify({ title: "Save failed", body: err instanceof Error ? err.message : String(err), tone: "error" }),
      },
    );
  };

  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <OpHeader eyebrow="Warehouse" title="Stock Transfer" onBack={onBack} />
      <div className="scroll" style={{ padding: 12, paddingBottom: 24, display: "flex", flexDirection: "column", gap: 10 }}>
        <label className="fld">
          <span className="fld-l">From warehouse *</span>
          <WarehouseSelect value={fromWarehouseId} onChange={setFromWarehouseId} placeholder="Pick source…" />
        </label>
        <label className="fld">
          <span className="fld-l">To warehouse *</span>
          <WarehouseSelect value={toWarehouseId} onChange={setToWarehouseId} placeholder="Pick destination…" disabledId={fromWarehouseId || undefined} />
        </label>
        {sameWarehouse && (
          <div style={{ fontSize: 11.5, color: "#b23a3a" }}>Source and destination must be different.</div>
        )}

        <label className="fld">
          <span className="fld-l">Product *</span>
          <SkuField picked={picked} onOpen={() => setPickerOpen(true)} />
        </label>

        {fromWarehouseId && productCode && (
          <div style={{ fontSize: 11.5, color: "#767b6e", background: "#f4f6f3", border: "1px solid #d6d9d2", borderRadius: 9, padding: "7px 10px" }}>
            Available at source:{" "}
            <strong className="tnum" style={{ color: overdrawn ? "#b23a3a" : "#11140f" }}>
              {balances.isLoading ? "…" : (available ?? 0).toLocaleString("en-MY")} PCS
            </strong>
          </div>
        )}

        <div className="fld-row">
          <label className="fld">
            <span className="fld-l">Qty *</span>
            <input className="fld-i tnum" type="number" inputMode="numeric" min={1} step={1} value={qty}
              onChange={(e) => setQty(intQty(e.target.value))}
              style={{ textAlign: "right", color: overdrawn ? "#b23a3a" : undefined }} />
          </label>
          <label className="fld">
            <span className="fld-l">Transfer date *</span>
            <input className="fld-i" type="date" value={transferDate} onChange={(e) => setTransferDate(e.target.value)} />
          </label>
        </div>

        <label className="fld">
          <span className="fld-l">Notes</span>
          <input className="fld-i" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
        </label>
      </div>

      <footer className="actbar">
        <button className="btn" disabled={create.isPending} onClick={onSave} style={{ opacity: create.isPending ? 0.6 : 1 }}>
          {create.isPending ? "Posting…" : "Post Transfer"}
        </button>
      </footer>

      {pickerOpen && (
        <MobileSkuPicker onClose={() => setPickerOpen(false)} onPick={(sku) => { setPicked(sku); setPickerOpen(false); }} />
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   STOCK TAKE — CREATE the count sheet: pick warehouse + scope + date. The server
   snapshots system_qty per in-scope SKU and opens the take. Entering the counted
   qty per line is the multi-line count-sheet step and stays on desktop (phase 2).
   ═══════════════════════════════════════════════════════════════════════════ */
const TAKE_CATEGORIES = [
  { value: "BEDFRAME", label: "Bedframe" },
  { value: "MATTRESS", label: "Mattress" },
  { value: "SOFA", label: "Sofa" },
  { value: "ACCESSORY", label: "Accessory" },
  { value: "SERVICE", label: "Service" },
];

function TakeScreen({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const notify = useNotify();
  const confirm = useConfirm();
  const create = useCreateStockTake();

  const [warehouseId, setWarehouseId] = useState("");
  const [takeDate, setTakeDate] = useState(todayISO());
  const [scopeType, setScopeType] = useState<StockTakeScopeType>("ALL");
  const [scopeValue, setScopeValue] = useState("");
  const [notes, setNotes] = useState("");

  // Live preview of how many SKUs the snapshot will cover.
  const balances = useInventoryBalances({
    warehouseId: warehouseId || undefined,
    showAll: true,
    category: scopeType === "CATEGORY" && scopeValue ? scopeValue : undefined,
  });
  const previewCount = useMemo(() => {
    if (!warehouseId) return 0;
    const list = balances.data?.balances ?? [];
    if (scopeType === "CODE_PREFIX") {
      const p = scopeValue.trim().toUpperCase();
      if (!p) return list.length;
      return list.filter((b) => (b.product_code ?? (b as { productCode?: string }).productCode ?? "").toUpperCase().startsWith(p)).length;
    }
    return list.length;
  }, [balances.data, scopeType, scopeValue, warehouseId]);

  const needsScopeValue = scopeType === "CATEGORY" || scopeType === "CODE_PREFIX";
  const canCreate = Boolean(warehouseId && takeDate && (!needsScopeValue || scopeValue.trim()));

  const onCreate = async () => {
    if (!canCreate) {
      notify({ title: "Pick a warehouse, date, and (for Category/Prefix) a scope value.", tone: "error" });
      return;
    }
    if (previewCount === 0) {
      const proceed = await confirm({
        title: "No SKUs match this scope",
        body: "The count sheet will be empty. Continue?",
        confirmLabel: "Create",
      });
      if (!proceed) return;
    }
    create.mutate(
      {
        warehouseId,
        takeDate,
        scopeType,
        scopeValue: needsScopeValue ? scopeValue.trim() : null,
        notes: notes.trim() || undefined,
      },
      {
        onSuccess: (res) => {
          notify({ title: "Count sheet created", body: `${res.lineCount} SKU${res.lineCount === 1 ? "" : "s"} snapshotted (${res.takeNo}). Enter the counts on desktop.` });
          onDone();
        },
        onError: (err) => notify({ title: "Create failed", body: err instanceof Error ? err.message : String(err), tone: "error" }),
      },
    );
  };

  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <OpHeader eyebrow="Warehouse" title="Stock Take" onBack={onBack} />
      <div className="scroll" style={{ padding: 12, paddingBottom: 24, display: "flex", flexDirection: "column", gap: 10 }}>
        <label className="fld">
          <span className="fld-l">Warehouse *</span>
          <WarehouseSelect value={warehouseId} onChange={setWarehouseId} placeholder="Pick a warehouse…" />
        </label>

        <div className="fld-row">
          <label className="fld">
            <span className="fld-l">Take date *</span>
            <input className="fld-i" type="date" value={takeDate} onChange={(e) => setTakeDate(e.target.value)} />
          </label>
          <label className="fld">
            <span className="fld-l">Scope *</span>
            <select className="fld-i" value={scopeType} onChange={(e) => { setScopeType(e.target.value as StockTakeScopeType); setScopeValue(""); }}>
              <option value="ALL">All SKUs</option>
              <option value="CATEGORY">By category</option>
              <option value="CODE_PREFIX">By code prefix</option>
            </select>
          </label>
        </div>

        {scopeType === "CATEGORY" && (
          <label className="fld">
            <span className="fld-l">Category *</span>
            <select className="fld-i" value={scopeValue} onChange={(e) => setScopeValue(e.target.value)}>
              <option value="">Pick a category…</option>
              {TAKE_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </label>
        )}
        {scopeType === "CODE_PREFIX" && (
          <label className="fld">
            <span className="fld-l">Code prefix *</span>
            <input className="fld-i" value={scopeValue} onChange={(e) => setScopeValue(e.target.value.toUpperCase())} placeholder="e.g. BF, MAT, SOF…" />
          </label>
        )}

        <label className="fld">
          <span className="fld-l">Notes</span>
          <input className="fld-i" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Monthly cycle count" />
        </label>

        <div style={{ fontSize: 11.5, color: "#767b6e", background: "#f4f6f3", border: "1px solid #d6d9d2", borderRadius: 9, padding: "8px 10px" }}>
          {!warehouseId ? "Pick a warehouse to preview the count sheet size."
            : balances.isLoading ? "Counting in-scope SKUs…"
            : <>Count sheet will contain <strong className="tnum" style={{ color: "#11140f" }}>{previewCount.toLocaleString("en-MY")}</strong> SKU{previewCount === 1 ? "" : "s"}. Counts are entered on desktop.</>}
        </div>
      </div>

      <footer className="actbar">
        <button className="btn" disabled={create.isPending} onClick={onCreate} style={{ opacity: create.isPending ? 0.6 : 1 }}>
          {create.isPending ? "Snapshotting…" : "Create Count Sheet"}
        </button>
      </footer>
    </div>
  );
}

/* Dispatcher — MobileApp routes here with the chosen op. */
export function MobileStockOps({ op, onBack, onDone }: { op: StockOp; onBack: () => void; onDone: () => void }) {
  if (op === "adjustment") return <AdjustmentScreen onBack={onBack} onDone={onDone} />;
  if (op === "transfer") return <TransferScreen onBack={onBack} onDone={onDone} />;
  return <TakeScreen onBack={onBack} onDone={onDone} />;
}
