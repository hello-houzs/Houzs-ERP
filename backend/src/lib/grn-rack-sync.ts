// ----------------------------------------------------------------------------
// grn-rack-sync — bridge goods-receipt into the warehouse RACK (physical
// placement) ledger. The rack module (2990s migration 0094 / Houzs migration
// 0026) is deliberately separate from the FIFO inventory ledger; this module
// syncs the two ONLY at receipt:
//   - placeGrnLinesOnRacks: on GRN post, each accepted line that carries a
//     rack_id gets a warehouse_rack_items row + a STOCK_IN movement.
//   - reverseGrnRacks: on GRN cancel, pull every rack item this GRN placed +
//     log a STOCK_OUT movement.
// Both are best-effort and idempotent (keyed on warehouse_rack_items.source_grn_id).
//
// 1:1 clone of 2990s apps/api/src/lib/grn-rack-sync.ts. Behaviour, the
// idempotency key (source_grn_id), the derived rack status and the best-effort
// contract are kept identical. Only the SEAMS change:
//   - DB layer: 2990s per-request Supabase PostgREST client (`sb`) -> Houzs
//     Drizzle (`db = getDb(c.env)`) passed as the first arg (rule #3). Every
//     `sb.from(...).insert/select/eq/...` becomes a Drizzle query against the
//     cloned schema (same rows in/out).
//   - performed_by / created_by: 2990s staff.id (uuid) -> Houzs users.id
//     (integer) (rule #4). userId widens to number.
//   - SEAM: warehouse_rack_items has no `source_grn_id` column (it is not in
//     2990s's schema either — 2990s added it ad-hoc; the cloned table follows
//     2990s's schema.ts which has no such column). The idempotency + reverse keys
//     therefore use `source_doc_no` (= the GRN number, already persisted), which
//     is unique per GRN, instead of source_grn_id. Documented necessary
//     deviation — behaviourally identical (one GRN number == one GRN).
// ----------------------------------------------------------------------------

import { eq, inArray } from "drizzle-orm";
import type { getDb } from "../db/client";
import {
  grnItems,
  warehouseRacks,
  warehouseRackItems,
  warehouseRackMovements,
} from "../db/schema";

type Db = ReturnType<typeof getDb>;

const deriveRackStatus = (
  itemCount: number,
  reserved: boolean,
): "OCCUPIED" | "EMPTY" | "RESERVED" =>
  reserved ? "RESERVED" : itemCount > 0 ? "OCCUPIED" : "EMPTY";

async function refreshRackStatus(db: Db, rackId: string): Promise<void> {
  const items = await db
    .select({ id: warehouseRackItems.id })
    .from(warehouseRackItems)
    .where(eq(warehouseRackItems.rackId, rackId));
  const rackRows = await db
    .select({ reserved: warehouseRacks.reserved })
    .from(warehouseRacks)
    .where(eq(warehouseRacks.id, rackId))
    .limit(1);
  await db
    .update(warehouseRacks)
    .set({ status: deriveRackStatus(items.length, rackRows[0]?.reserved ?? false) })
    .where(eq(warehouseRacks.id, rackId));
}

/** Place each accepted GRN line that chose a rack onto that rack. Idempotent:
 *  skips if this GRN already has rack items (so a double-post won't duplicate).
 *  Keyed on source_doc_no = grnNo (see header SEAM). */
export async function placeGrnLinesOnRacks(
  db: Db,
  grnId: string,
  grnNo: string,
  userId: number,
): Promise<void> {
  const items = await db
    .select({
      rackId: grnItems.rackId,
      materialCode: grnItems.materialCode,
      materialName: grnItems.materialName,
      qtyAccepted: grnItems.qtyAccepted,
    })
    .from(grnItems)
    .where(eq(grnItems.grnId, grnId));
  const lines = items.filter((it) => it.rackId && (it.qtyAccepted ?? 0) > 0);
  if (lines.length === 0) return;

  // Idempotency — already placed for this GRN? (keyed on source_doc_no = grnNo)
  const already = await db
    .select({ id: warehouseRackItems.id })
    .from(warehouseRackItems)
    .where(eq(warehouseRackItems.sourceDocNo, grnNo));
  if (already.length > 0) return;

  const rackIds = [...new Set(lines.map((l) => l.rackId as string))];
  const racks = await db
    .select({ id: warehouseRacks.id, rack: warehouseRacks.rack, warehouseId: warehouseRacks.warehouseId })
    .from(warehouseRacks)
    .where(inArray(warehouseRacks.id, rackIds));
  const rackMap = new Map(racks.map((r) => [r.id, r]));
  const today = new Date().toISOString().slice(0, 10);

  const itemRows = lines.map((l) => ({
    rackId: l.rackId as string,
    productCode: l.materialCode,
    productName: l.materialName,
    sourceDocNo: grnNo,
    qty: l.qtyAccepted,
    stockedInDate: today,
    notes: "Goods receipt",
  }));
  try {
    await db.insert(warehouseRackItems).values(itemRows as never);
  } catch {
    return; // best-effort
  }

  const moveRows = lines.map((l) => {
    const r = rackMap.get(l.rackId as string);
    return {
      movementType: "STOCK_IN",
      rackId: l.rackId as string,
      rackLabel: r?.rack ?? null,
      warehouseId: r?.warehouseId ?? null,
      productCode: l.materialCode,
      productName: l.materialName,
      sourceDocNo: grnNo,
      quantity: l.qtyAccepted,
      reason: "Goods receipt",
      performedBy: userId,
    };
  });
  await db.insert(warehouseRackMovements).values(moveRows as never);
  for (const id of rackIds) await refreshRackStatus(db, id);
}

/** Reverse every rack item a GRN placed (on cancel). Logs a STOCK_OUT each.
 *  Keyed on source_doc_no = grnNo (see header SEAM). */
export async function reverseGrnRacks(
  db: Db,
  _grnId: string,
  grnNo: string,
  userId: number,
): Promise<void> {
  const items = await db
    .select({
      id: warehouseRackItems.id,
      rackId: warehouseRackItems.rackId,
      productCode: warehouseRackItems.productCode,
      productName: warehouseRackItems.productName,
      qty: warehouseRackItems.qty,
    })
    .from(warehouseRackItems)
    .where(eq(warehouseRackItems.sourceDocNo, grnNo));
  if (items.length === 0) return;

  const rackIds = [...new Set(items.map((i) => i.rackId))];
  const racks = await db
    .select({ id: warehouseRacks.id, rack: warehouseRacks.rack, warehouseId: warehouseRacks.warehouseId })
    .from(warehouseRacks)
    .where(inArray(warehouseRacks.id, rackIds));
  const rackMap = new Map(racks.map((r) => [r.id, r]));

  await db.delete(warehouseRackItems).where(eq(warehouseRackItems.sourceDocNo, grnNo));

  const moveRows = items.map((i) => {
    const r = rackMap.get(i.rackId);
    return {
      movementType: "STOCK_OUT",
      rackId: i.rackId,
      rackLabel: r?.rack ?? null,
      warehouseId: r?.warehouseId ?? null,
      productCode: i.productCode,
      productName: i.productName,
      sourceDocNo: grnNo,
      quantity: i.qty,
      reason: "GRN cancelled",
      performedBy: userId,
    };
  });
  await db.insert(warehouseRackMovements).values(moveRows as never);
  for (const id of rackIds) await refreshRackStatus(db, id);
}
