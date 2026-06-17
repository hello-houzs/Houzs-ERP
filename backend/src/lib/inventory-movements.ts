// ----------------------------------------------------------------------------
// Inventory movement helpers — single source of truth for writing
// IN / OUT / ADJUSTMENT rows whenever a document posts. Imported by GRN, DO,
// Consignment, Purchase Return, Stock Transfer + Stock Take post handlers (those
// slices land later — this lib is built complete now so they just import it).
//
// 1:1 clone of 2990s apps/api/src/lib/inventory-movements.ts. Behaviour, the
// MovementInput shape, the best-effort (never-throw) contract, the FIFO-trigger
// reliance, the dye-lot/cost fallback resolvers and the idempotent reversal are
// all kept identical to 2990s. Only the SEAMS change:
//   - DB layer: 2990s per-request Supabase PostgREST client (`sb`) -> Houzs
//     Drizzle (`db = getDb(c.env)`) passed as the first arg (rule #3). Every
//     `sb.from(...).insert/select/eq/...` becomes a Drizzle query against the
//     cloned schema (same rows in/out).
//   - performed_by / created_by: 2990s staff.id (uuid) -> Houzs users.id
//     (integer) (rule #4). The MovementInput.performed_by type widens to number.
//   - The FIFO engine itself stays in the DB (trg_inventory_movement_fifo +
//     fn_consume_fifo[_batch], migration 0026) — this lib only writes movement
//     rows; the trigger maintains lots + consumptions + COGS, exactly as 2990s.
//
// The exposed function SIGNATURES (so GRN / transfer / stocktake callers know
// what to import):
//   writeMovements(db, rows: MovementInput[]): Promise<{ ok; reason? }>
//   defaultWarehouseId(db): Promise<string | null>
//   resolveWarehouseLotBatches(db, warehouseId): Promise<Map<string, string|null>>
//   resolveWarehouseLotCosts(db, warehouseId): Promise<Map<string, number>>
//   reverseMovements(db, sourceDocType, sourceDocId, performedBy: number|null):
//     Promise<{ ok; reversed; skipped; failed; reason? }>
// ----------------------------------------------------------------------------

import { and, eq, gt, isNotNull } from "drizzle-orm";
import type { getDb } from "../db/client";
import {
  inventoryMovements,
  inventoryLots,
  mfgWarehouses as warehousesTable,
} from "../db/schema";

type Db = ReturnType<typeof getDb>;

export type MovementInput = {
  movement_type: "IN" | "OUT" | "ADJUSTMENT";
  warehouse_id: string;
  product_code: string;
  /** Migration 0095 — canonical attribute-composition bucket key
   *  (shared computeVariantKey). Stock is bucketed by
   *  (warehouse_id, product_code, variant_key). Omit / '' = unclassified. */
  variant_key?: string;
  product_name?: string | null;
  /** For IN / OUT: positive count. For ADJUSTMENT: signed delta
   *  (positive = found stock / IN-style, negative = write-off / OUT-style).
   *  The DB column is INTEGER and accepts both. */
  qty: number;
  /** PR #37 — for IN rows: per-unit cost in sen. Trigger uses this to
   *  create the FIFO lot. OUT rows leave this unset; the trigger computes
   *  the consumed cost from the lots it pulls from. */
  unit_cost_sen?: number;
  /** PR — Inv PR5 — added STOCK_TAKE. ADJUSTMENT remains for the manual
   *  one-off adjustment route. (Sales/purchase-consignment doc types kept
   *  for fidelity; those slices land later.) */
  source_doc_type:
    | "GRN" | "DO" | "DR" | "CONSIGNMENT_NOTE" | "PURCHASE_CONSIGNMENT_NOTE"
    | "PURCHASE_RETURN" | "STOCK_TRANSFER" | "STOCK_TAKE" | "ADJUSTMENT"
    | "CS_DO" | "CS_DR"
    | "PC_RECEIVE" | "PC_RETURN";
  source_doc_id?: string;
  source_doc_no?: string;
  /** Migration 0120 — production batch (source PO number). On IN rows the FIFO
   *  trigger copies this onto the lot it creates. Omit for un-batched stock. */
  batch_no?: string | null;
  /** Migration 0150 — structured ADJUSTMENT reason (DAMAGE/LOSS/.../OTHER). */
  reason_code?: string | null;
  /** SEAM (rule #4): 2990s staff.id (uuid) -> Houzs users.id (integer). */
  performed_by?: number | null;
  notes?: string | null;
};

/**
 * Insert N movement rows in one go. Used after a document is posted to
 * record the stock impact. Never throws — returns true/false so callers
 * can log without rolling back the post.
 *
 * Maps the snake_case MovementInput onto the Drizzle (camelCase-keyed) columns.
 * The DB FIFO trigger fires per inserted row and maintains lots/consumptions.
 */
export async function writeMovements(
  db: Db,
  rows: MovementInput[],
): Promise<{ ok: boolean; reason?: string }> {
  if (rows.length === 0) return { ok: true };
  try {
    const values = rows.map((r) => ({
      movementType: r.movement_type,
      warehouseId: r.warehouse_id,
      productCode: r.product_code,
      variantKey: r.variant_key ?? "",
      productName: r.product_name ?? null,
      qty: r.qty,
      unitCostSen: typeof r.unit_cost_sen === "number" ? r.unit_cost_sen : 0,
      sourceDocType: r.source_doc_type,
      sourceDocId: r.source_doc_id ?? null,
      sourceDocNo: r.source_doc_no ?? null,
      batchNo: r.batch_no ?? null,
      reasonCode: r.reason_code ?? null,
      performedBy: r.performed_by ?? null,
      notes: r.notes ?? null,
    }));
    await db.insert(inventoryMovements).values(values as never);
    return { ok: true };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[inventory] movement insert failed:", e instanceof Error ? e.message : String(e));
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Resolve the default warehouse id (the one flagged is_default = true).
 * Used as a fallback when a document doesn't carry its own warehouse_id.
 */
export async function defaultWarehouseId(db: Db): Promise<string | null> {
  try {
    const rows = await db
      .select({ id: warehousesTable.id })
      .from(warehousesTable)
      .where(eq(warehousesTable.isDefault, true))
      .limit(1);
    return rows[0]?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve the dye-lot batch each (product_code, variant_key) bucket should carry
 * when shipping OUT of a warehouse, derived from the OPEN lots physically in that
 * warehouse. For each bucket: carry the batch ONLY when the warehouse holds the
 * stock under a SINGLE non-null batch (unambiguous). Multi-batch or plain stock →
 * un-batched (plain FIFO). Best-effort (never throws).
 */
export async function resolveWarehouseLotBatches(
  db: Db,
  warehouseId: string,
): Promise<Map<string, string | null>> {
  const byBucket = new Map<string, string | null>();
  if (!warehouseId) return byBucket;
  try {
    const lots = await db
      .select({
        productCode: inventoryLots.productCode,
        variantKey: inventoryLots.variantKey,
        batchNo: inventoryLots.batchNo,
      })
      .from(inventoryLots)
      .where(
        and(
          eq(inventoryLots.warehouseId, warehouseId),
          isNotNull(inventoryLots.batchNo),
          gt(inventoryLots.qtyRemaining, 0),
        ),
      );
    const batches = new Map<string, Set<string>>();
    for (const r of lots) {
      if (!r.batchNo) continue;
      const k = `${r.productCode}::${r.variantKey ?? ""}`;
      const set = batches.get(k) ?? new Set<string>();
      set.add(r.batchNo);
      batches.set(k, set);
    }
    for (const [k, set] of batches.entries()) {
      byBucket.set(k, set.size === 1 ? [...set][0]! : null);
    }
  } catch {
    /* lots table absent / query failed — every line un-batched (plain FIFO) */
  }
  return byBucket;
}

/**
 * Resolve the CURRENT weighted-average unit cost (sen) per (product_code,
 * variant_key) bucket from the OPEN lots in a warehouse. Used as a cost fallback
 * for a stock-IN whose document carries no cost (re-entering at the SKU's real
 * on-hand cost). Returns 0 for a bucket with no open lots. Best-effort.
 */
export async function resolveWarehouseLotCosts(
  db: Db,
  warehouseId: string,
): Promise<Map<string, number>> {
  const byBucket = new Map<string, number>();
  if (!warehouseId) return byBucket;
  try {
    const lots = await db
      .select({
        productCode: inventoryLots.productCode,
        variantKey: inventoryLots.variantKey,
        qtyRemaining: inventoryLots.qtyRemaining,
        unitCostSen: inventoryLots.unitCostSen,
      })
      .from(inventoryLots)
      .where(and(eq(inventoryLots.warehouseId, warehouseId), gt(inventoryLots.qtyRemaining, 0)));
    const acc = new Map<string, { qty: number; cost: number }>();
    for (const r of lots) {
      const k = `${r.productCode}::${r.variantKey ?? ""}`;
      const q = Number(r.qtyRemaining ?? 0);
      if (q <= 0) continue;
      const a = acc.get(k) ?? { qty: 0, cost: 0 };
      a.qty += q;
      a.cost += q * Number(r.unitCostSen ?? 0);
      acc.set(k, a);
    }
    for (const [k, a] of acc.entries()) {
      byBucket.set(k, a.qty > 0 ? Math.round(a.cost / a.qty) : 0);
    }
  } catch {
    /* lots absent — no cost fallback available */
  }
  return byBucket;
}

/**
 * Reverse EVERY inventory movement a document wrote, by posting an
 * opposite-direction movement (IN->OUT / OUT->IN) per original row. This is the
 * SAFE way to undo a posting: the FIFO trigger (migration 0026) treats the
 * reversing row like any other movement — a reversing IN re-opens a cost lot, a
 * reversing OUT consumes lots + recomputes COGS — so on-hand qty + cost basis
 * both come back consistent. We never DELETE the original rows.
 *
 * Idempotency guard (no dedicated "reversed" column): sum the SIGNED qty (IN =
 * +qty, OUT = -qty) per (product_code, variant_key, warehouse_id, batch_no)
 * across ALL rows for this (source_doc_type, source_doc_id), INCLUDING reversal
 * rows we wrote on a prior call. A bucket whose signed net is already 0 is fully
 * reversed -> skip it. Calling twice is a no-op the second time.
 *
 * Best-effort, mirroring writeMovements: never throws. Each reversal row is
 * inserted INDIVIDUALLY so a single failure doesn't sink the rest. ADJUSTMENT /
 * non-IN/OUT rows are left alone.
 */
export async function reverseMovements(
  db: Db,
  sourceDocType: string,
  sourceDocId: string,
  performedBy: number | null,
): Promise<{ ok: boolean; reversed: number; skipped: number; failed: number; reason?: string }> {
  try {
    let rows: Array<{
      movement_type: string;
      warehouse_id: string;
      product_code: string;
      variant_key: string | null;
      batch_no: string | null;
      product_name: string | null;
      qty: number;
      unit_cost_sen: number | null;
      source_doc_no: string | null;
    }>;
    try {
      rows = await db
        .select({
          movement_type: inventoryMovements.movementType,
          warehouse_id: inventoryMovements.warehouseId,
          product_code: inventoryMovements.productCode,
          variant_key: inventoryMovements.variantKey,
          batch_no: inventoryMovements.batchNo,
          product_name: inventoryMovements.productName,
          qty: inventoryMovements.qty,
          unit_cost_sen: inventoryMovements.unitCostSen,
          source_doc_no: inventoryMovements.sourceDocNo,
        })
        .from(inventoryMovements)
        .where(
          and(
            eq(inventoryMovements.sourceDocType, sourceDocType),
            eq(inventoryMovements.sourceDocId, sourceDocId),
          ),
        );
    } catch (e) {
      return { ok: false, reversed: 0, skipped: 0, failed: 0, reason: e instanceof Error ? e.message : String(e) };
    }
    if (rows.length === 0) return { ok: true, reversed: 0, skipped: 0, failed: 0 };

    // Idempotency: signed net per (warehouse, product, variant, batch) bucket.
    const netByBucket = new Map<string, number>();
    const bucketKey = (r: (typeof rows)[number]) =>
      `${r.warehouse_id}::${r.product_code}::${r.variant_key ?? ""}::${r.batch_no ?? ""}`;
    for (const r of rows) {
      if (r.movement_type !== "IN" && r.movement_type !== "OUT") continue;
      const signed = r.movement_type === "IN" ? r.qty : -r.qty;
      const k = bucketKey(r);
      netByBucket.set(k, (netByBucket.get(k) ?? 0) + signed);
    }

    let reversed = 0,
      skipped = 0,
      failed = 0;
    const remaining = new Map(netByBucket);
    for (const r of rows) {
      if (r.movement_type !== "IN" && r.movement_type !== "OUT") {
        skipped += 1;
        continue;
      }
      const k = bucketKey(r);
      const net = remaining.get(k) ?? 0;
      if (net === 0) {
        skipped += 1;
        continue;
      }

      const opposite: "IN" | "OUT" = r.movement_type === "IN" ? "OUT" : "IN";
      const row: MovementInput = {
        movement_type: opposite,
        warehouse_id: r.warehouse_id,
        product_code: r.product_code,
        variant_key: r.variant_key ?? "",
        product_name: r.product_name,
        qty: r.qty,
        ...(opposite === "IN" ? { unit_cost_sen: Number(r.unit_cost_sen ?? 0) } : {}),
        ...(r.batch_no ? { batch_no: r.batch_no } : {}),
        source_doc_type: sourceDocType as MovementInput["source_doc_type"],
        source_doc_id: sourceDocId,
        source_doc_no: r.source_doc_no ?? undefined,
        performed_by: performedBy,
        notes: `Reversal of ${sourceDocType} ${r.source_doc_no ?? sourceDocId} (cancel/line-delete)`,
      };
      const res = await writeMovements(db, [row]);
      if (res.ok) {
        reversed += 1;
        remaining.set(k, net + (opposite === "IN" ? r.qty : -r.qty));
      } else {
        failed += 1;
      }
    }
    return { ok: failed === 0, reversed, skipped, failed };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[inventory] reverseMovements exception:", e);
    return { ok: false, reversed: 0, skipped: 0, failed: 0, reason: e instanceof Error ? e.message : String(e) };
  }
}
