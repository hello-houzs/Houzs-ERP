// ----------------------------------------------------------------------------
// StockAdjustmentNew — manual stock correction form at /stock-adjustments/new.
// 1:1 clone of 2990s apps/backend/src/pages/StockAdjustmentNew.tsx (the full-page
// pattern: back link + title + Cancel/Save in the headerRow, header card with
// fields, current/resulting balance hint, negative-balance warning, POST via
// useStockAdjustment). The +/- UX (absolute qty + Increase/Decrease segmented
// control + structured reason) is kept verbatim.
//
// SEAM changes (same playbook as the PO slice):
//   - Data layer: 2990s lib/inventory-queries -> Houzs api client + react-query
//     (co-located ./inventory-queries). ADJUSTMENT_REASONS: 2990s @2990s/shared
//     -> Houzs @shared/index (ported).
//   - Chrome: 2990s SalesOrderDetail.module.css -> the chrome addendum merged
//     into the verbatim Inventory.module.css.
//   - react-router -> react-router-dom.
//
// STRATEGY-2 product-layer trim (Houzs is not the 2990s furniture business; no
// mfg_products catalogue / maintenance config / sofa-bedframe variant editor):
//   - SKU is a PLAIN TEXT input (2990s pulled a datalist from useMfgProducts +
//     auto-filled name/category). Product name stays an editable free-text field.
//   - The INCREASE sofa/bedframe VariantSelect editor (useMaintenanceConfig /
//     useSpecialAddons) is DROPPED — Houzs materials have no item-group, so the
//     variant_key resolves to '' server-side and the furniture-axis save gate
//     (2990s adjustmentIncreaseErrors) does not apply.
//   - The DECREASE "Take from" bucket picker is KEPT (generic — reads
//     /inventory/buckets, groups open lots by variant_key+batch_no).
//   TODO: re-introduce the item-group + attribute editor when a Houzs product
//   layer lands (the backend already honours variant_key + batch_no).
// ----------------------------------------------------------------------------

import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, Save, X, Minus, Plus, AlertTriangle } from "lucide-react";
import { Button } from "../../components/Button";
import { ADJUSTMENT_REASONS } from "@shared/index";
import {
  useWarehouses,
  useStockAdjustment,
  useInventoryProductBreakdown,
  useInventoryBuckets,
} from "./inventory-queries";
import { useDialog } from "../../hooks/useDialog";
import { useToast } from "../../hooks/useToast";
import styles from "./Inventory.module.css";

const ICON = { size: 16, strokeWidth: 1.75 } as const;

type AdjustmentType = "increase" | "decrease";

export const StockAdjustmentNew = () => {
  const navigate = useNavigate();
  const dialog = useDialog();
  const toast = useToast();
  const adjust = useStockAdjustment();

  // ── Form state ─────────────────────────────────────────────────────
  const [warehouseId, setWarehouseId] = useState<string>("");
  const [productCode, setProductCode] = useState<string>("");
  const [productName, setProductName] = useState<string>("");
  const [type, setType] = useState<AdjustmentType>("decrease");
  const [qty, setQty] = useState<number>(1);
  const [reasonCode, setReasonCode] = useState<string>("");
  const [notes, setNotes] = useState<string>("");

  // Decrease picker — the chosen existing bucket (variant_key + batch_no).
  const [batchNo, setBatchNo] = useState<string>("");
  const [variantKey, setVariantKey] = useState<string>("");

  // ── Data ───────────────────────────────────────────────────────────
  const warehouses = useWarehouses();
  const bucketsQ = useInventoryBuckets(productCode || null, warehouseId || null);
  const buckets = bucketsQ.data ?? [];
  const breakdown = useInventoryProductBreakdown(productCode || null);

  // Current balance @ chosen warehouse.
  const currentBalance: number | null = useMemo(() => {
    if (!warehouseId || !productCode) return null;
    const balances = breakdown.data?.balances ?? [];
    // sum across variant buckets for this (warehouse, product).
    const matching = balances.filter((b) => b.warehouse_id === warehouseId && b.product_code === productCode);
    if (matching.length === 0) return breakdown.isLoading ? null : 0;
    return matching.reduce((s, b) => s + (b.qty ?? 0), 0);
  }, [warehouseId, productCode, breakdown.data, breakdown.isLoading]);

  const qtyDelta = type === "increase" ? qty : -qty;
  const resultingBalance: number | null = currentBalance == null ? null : currentBalance + qtyDelta;
  const willGoNegative = resultingBalance != null && resultingBalance < 0;

  const canSave = Boolean(warehouseId && productCode.trim() && qty > 0 && reasonCode);

  const onPickSku = (code: string) => {
    setProductCode(code);
    // Strategy-2: no catalogue auto-fill; fresh SKU clears any picked bucket.
    setBatchNo("");
    setVariantKey("");
  };

  // DECREASE — operator picks which existing lot to take from.
  const onPickBucket = (value: string) => {
    if (!value) {
      setVariantKey("");
      setBatchNo("");
      return;
    }
    const b = buckets.find((x) => `${x.variant_key} ${x.batch_no ?? ""}` === value);
    if (!b) return;
    setVariantKey(b.variant_key);
    setBatchNo(b.batch_no ?? "");
    setQty((q) => Math.min(q, b.qty));
  };

  const bucketQtyCap = useMemo(() => {
    if (type !== "decrease" || (!variantKey && !batchNo)) return null;
    const b = buckets.find((x) => x.variant_key === variantKey && (x.batch_no ?? "") === batchNo);
    return b ? b.qty : null;
  }, [type, variantKey, batchNo, buckets]);

  const onSave = async () => {
    if (!canSave) {
      toast.error("Fill Warehouse, SKU, Qty, and pick a Reason before saving.");
      return;
    }
    // DECREASE gate — when there are open lots, the operator must say which one.
    if (type === "decrease" && buckets.length > 0 && !variantKey && !batchNo) {
      toast.error("Pick which batch/variant to take the stock from.");
      return;
    }
    if (willGoNegative) {
      const proceed = await dialog.confirm(`This adjustment will push the balance to ${resultingBalance} (below zero). Continue?`);
      if (!proceed) return;
    }
    const trimmedBatch = batchNo.trim();
    adjust.mutate(
      {
        warehouseId,
        productCode: productCode.trim(),
        productName: productName.trim() || undefined,
        qtyDelta,
        reasonCode,
        notes: notes.trim() || undefined,
        // Strategy-2: no item-group / variants on the INCREASE side (plain-text
        // materials). The DECREASE picker supplies the exact existing bucket.
        batchNo: trimmedBatch || undefined,
        variantKey: type === "decrease" ? variantKey || undefined : undefined,
      },
      {
        onSuccess: () => navigate("/stock-adjustments"),
        onError: (err) => toast.error(`Save failed: ${err instanceof Error ? err.message : String(err)}`),
      },
    );
  };

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div className={styles.titleBlock}>
          <Link to="/stock-adjustments" className={styles.backBtn}>
            <ArrowLeft {...ICON} /> <span>Stock Adjustments</span>
          </Link>
          <h1 className={styles.title}>New Stock Adjustment</h1>
        </div>
        <div className={styles.actions}>
          <Button variant="ghost" onClick={() => navigate("/stock-adjustments")}>
            <X {...ICON} /> Cancel
          </Button>
          <Button variant="primary" onClick={onSave} disabled={adjust.isPending}>
            <Save {...ICON} />
            {adjust.isPending ? "Saving…" : "Save Adjustment"}
          </Button>
        </div>
      </div>

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Adjustment</h2>
        </div>
        <div className={styles.cardBody}>
          <div className={styles.formGrid2}>
            {/* Warehouse */}
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Warehouse *</span>
              <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} className={styles.fieldInput}>
                <option value="">— Pick a warehouse —</option>
                {(warehouses.data ?? []).map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.code} · {w.name}
                  </option>
                ))}
              </select>
            </label>

            {/* SKU — plain text (Strategy-2: no catalogue datalist) */}
            <label className={styles.field}>
              <span className={styles.fieldLabel}>SKU *</span>
              <input
                type="text"
                value={productCode}
                onChange={(e) => onPickSku(e.target.value)}
                placeholder="Type a SKU / material code…"
                className={styles.fieldInput}
                style={{ fontFamily: "var(--font-mono)" }}
              />
            </label>

            {/* Product name — editable free text */}
            <label className={`${styles.field} ${styles.fieldFull}`}>
              <span className={styles.fieldLabel}>Product Name</span>
              <input
                type="text"
                value={productName}
                onChange={(e) => setProductName(e.target.value)}
                placeholder="(optional — description for this adjustment)"
                className={styles.fieldInput}
                style={{ background: "var(--c-cream)", color: "var(--c-ink)" }}
              />
            </label>
          </div>

          {/* Current balance hint */}
          {warehouseId && productCode && (
            <div
              style={{
                marginTop: "var(--space-3)",
                background: "var(--c-cream)",
                border: "1px solid var(--line)",
                borderRadius: "var(--radius-md)",
                padding: "var(--space-2) var(--space-3)",
                fontSize: "var(--fs-13)",
                color: "var(--fg-muted)",
                display: "flex",
                gap: "var(--space-4)",
                flexWrap: "wrap",
              }}
            >
              <span>
                Current balance:{" "}
                <strong style={{ color: "var(--c-ink)", fontFamily: "var(--font-mono)" }}>
                  {breakdown.isLoading ? "…" : (currentBalance ?? 0).toLocaleString("en-MY")} PCS
                </strong>
              </span>
              {resultingBalance != null && (
                <span>
                  Resulting balance:{" "}
                  <strong
                    style={{
                      color: willGoNegative ? "var(--c-festive-b, #B8331F)" : "var(--c-ink)",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    {(currentBalance ?? 0).toLocaleString("en-MY")} {type === "increase" ? "+" : "−"}{" "}
                    {qty.toLocaleString("en-MY")}
                    {" = "}
                    {resultingBalance.toLocaleString("en-MY")} PCS
                  </strong>
                </span>
              )}
            </div>
          )}

          {/* Adjustment type — segmented (+/−) */}
          <div style={{ marginTop: "var(--space-4)" }}>
            <div className={styles.fieldLabel} style={{ marginBottom: 6 }}>
              Adjustment Type *
            </div>
            <div style={{ display: "inline-flex", gap: 0, borderRadius: "var(--radius-md)", overflow: "hidden", border: "1px solid var(--line)" }}>
              <button
                type="button"
                onClick={() => setType("increase")}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "var(--space-2) var(--space-4)",
                  fontFamily: "var(--font-button)",
                  fontSize: "var(--fs-13)",
                  fontWeight: 600,
                  background: type === "increase" ? "var(--c-secondary-a, #2F5D4F)" : "var(--c-paper)",
                  color: type === "increase" ? "var(--c-cream)" : "var(--c-ink)",
                  border: "none",
                  cursor: "pointer",
                }}
              >
                <Plus size={14} strokeWidth={2} /> Increase (found / recount up)
              </button>
              <button
                type="button"
                onClick={() => setType("decrease")}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "var(--space-2) var(--space-4)",
                  fontFamily: "var(--font-button)",
                  fontSize: "var(--fs-13)",
                  fontWeight: 600,
                  background: type === "decrease" ? "var(--c-festive-b, #B8331F)" : "var(--c-paper)",
                  color: type === "decrease" ? "var(--c-cream)" : "var(--c-ink)",
                  border: "none",
                  borderLeft: "1px solid var(--line)",
                  cursor: "pointer",
                }}
              >
                <Minus size={14} strokeWidth={2} /> Decrease (write-off / damage / loss)
              </button>
            </div>
          </div>

          {/* INCREASE — optional batch number (generic; no furniture variant editor) */}
          {type === "increase" && (
            <label className={`${styles.field} ${styles.fieldFull}`} style={{ marginTop: "var(--space-4)" }}>
              <span className={styles.fieldLabel}>Batch Number (optional)</span>
              <input
                type="text"
                value={batchNo}
                onChange={(e) => setBatchNo(e.target.value)}
                placeholder="Lot / batch label for this found stock"
                className={styles.fieldInput}
              />
            </label>
          )}

          {/* DECREASE — "Take from" picker */}
          {type === "decrease" && warehouseId && productCode && (
            <div style={{ marginTop: "var(--space-4)" }}>
              {bucketsQ.isLoading ? (
                <span style={{ fontSize: "var(--fs-13)", color: "var(--fg-muted)" }}>Loading open stock…</span>
              ) : buckets.length === 0 ? (
                <span style={{ fontSize: "var(--fs-13)", color: "var(--fg-muted)" }}>No open stock to take from.</span>
              ) : (
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Take from *</span>
                  <select
                    value={variantKey || batchNo ? `${variantKey} ${batchNo}` : ""}
                    onChange={(e) => onPickBucket(e.target.value)}
                    className={styles.fieldInput}
                  >
                    <option value="">— Pick which batch / variant —</option>
                    {buckets.map((b) => (
                      <option key={`${b.variant_key} ${b.batch_no ?? ""}`} value={`${b.variant_key} ${b.batch_no ?? ""}`}>
                        {(b.batch_no || "No batch")} · {(b.variant_key || "plain")} · {b.qty} PCS
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          )}

          <div className={styles.formGrid2} style={{ marginTop: "var(--space-4)" }}>
            {/* Qty — absolute value. On DECREASE, capped to the chosen lot. */}
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Qty * (positive integer)</span>
              <input
                type="number"
                min={1}
                max={bucketQtyCap ?? undefined}
                step={1}
                value={qty}
                onChange={(e) => {
                  let n = Math.max(0, Math.floor(Number(e.target.value) || 0));
                  if (bucketQtyCap != null) n = Math.min(bucketQtyCap, n);
                  setQty(n);
                }}
                className={styles.fieldInput}
                style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}
              />
            </label>

            {/* Reason — structured, required */}
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Reason *</span>
              <select value={reasonCode} onChange={(e) => setReasonCode(e.target.value)} className={styles.fieldInput}>
                <option value="">— Pick a reason —</option>
                {ADJUSTMENT_REASONS.map((r) => (
                  <option key={r.code} value={r.code}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>

            {/* Notes — optional */}
            <label className={`${styles.field} ${styles.fieldFull}`}>
              <span className={styles.fieldLabel}>Notes (optional)</span>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Extra detail — e.g. 'Lot #4, water damage', 'Found 2 PCS during recount'"
                className={styles.fieldInput}
                rows={3}
                style={{ minHeight: 52, resize: "vertical" }}
              />
            </label>
          </div>

          {/* Negative balance warning — non-blocking */}
          {willGoNegative && (
            <div
              style={{
                marginTop: "var(--space-3)",
                padding: "var(--space-3) var(--space-4)",
                background: "rgba(184, 51, 31, 0.08)",
                border: "1px solid var(--c-festive-b, #B8331F)",
                borderRadius: "var(--radius-md)",
                fontSize: "var(--fs-13)",
                color: "var(--c-festive-b, #B8331F)",
                display: "flex",
                alignItems: "center",
                gap: "var(--space-2)",
              }}
            >
              <AlertTriangle size={16} strokeWidth={1.75} />
              <span>
                This will push the warehouse balance to <strong>{resultingBalance}</strong> (below zero). You'll be asked
                to confirm on Save — proceed at your discretion.
              </span>
            </div>
          )}
        </div>
      </section>
    </div>
  );
};
