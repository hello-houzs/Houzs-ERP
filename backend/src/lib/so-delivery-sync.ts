// ----------------------------------------------------------------------------
// DO → SO "Delivered" sync. 1:1 clone of 2990s apps/api/src/lib/
// so-delivery-sync.ts.
//
// Requirement #3 (Loo, 2026-05-30): when a Delivery Order fully covers a Sales
// Order, the SO auto-advances to DELIVERED; cancelling/reducing the DO (or a
// Delivery Return) releases it back to READY_TO_SHIP.
//
// The pure coverage decision `isSoFullyCovered` is verbatim (unit-tested in
// 2990s, no DB, no furniture). The async reconcile `syncSoDeliveredFromDo` was a
// no-op stub while the DO/SI/DR tables didn't exist; now that the DO/SI/DR slice
// (#66) cloned delivery_orders / delivery_order_items / delivery_returns /
// _items, it is the FULL Supabase->Drizzle port:
//   - delivered/returned netting (Σ DO − Σ DR per SO line, cancelled docs excluded)
//   - bidirectional DELIVERED <-> READY_TO_SHIP reconcile
//   - line-level READY flip for fully-shipped lines
//   - dual audit-trail write (mfg_so_status_changes + mfg_so_audit_log)
// SEAMS (rule #3 + #4): per-request Supabase -> Drizzle `db`; staff.id (uuid)
// actorId -> Houzs users.id INTEGER; SERVICE lines never get a stock_status.
// ----------------------------------------------------------------------------

import { and, eq, inArray, ne } from "drizzle-orm";
import type { getDb } from "../db/client";
import {
  mfgSalesOrders as soTable,
  mfgSalesOrderItems as soItemsTable,
  mfgSoStatusChanges as soStatusChangesTable,
  deliveryOrders,
  deliveryOrderItems,
  deliveryReturns,
  deliveryReturnItems,
} from "../db/schema";
import { isServiceLine } from "./service-sku";
import { recordSoAudit } from "./so-audit";

type Db = ReturnType<typeof getDb>;

export type SoLineQty = { id: string; qty: number };
export type DoLineQty = { soItemId: string | null; qty: number };

/** Pure coverage decision. `soLines` must already EXCLUDE cancelled SO lines;
 *  `doLines` should EXCLUDE lines belonging to cancelled DOs; `returnLines`
 *  (optional) should EXCLUDE lines belonging to cancelled Delivery Returns.
 *  Returns true iff every SO line's NET delivered quantity
 *  (Σ delivered across DOs − Σ returned across DRs) meets or exceeds its
 *  ordered qty. An SO with no lines is never "fully covered". Verbatim. */
export function isSoFullyCovered(
  soLines: SoLineQty[],
  doLines: DoLineQty[],
  returnLines: DoLineQty[] = [],
): boolean {
  if (soLines.length === 0) return false;
  const netByLine = new Map<string, number>();
  for (const d of doLines) {
    if (!d.soItemId) continue;
    netByLine.set(d.soItemId, (netByLine.get(d.soItemId) ?? 0) + (d.qty ?? 0));
  }
  for (const r of returnLines) {
    if (!r.soItemId) continue;
    netByLine.set(r.soItemId, (netByLine.get(r.soItemId) ?? 0) - (r.qty ?? 0));
  }
  return soLines.every((l) => (netByLine.get(l.id) ?? 0) >= l.qty);
}

// SO statuses we may auto-advance to DELIVERED. Anything already at
// INVOICED/CLOSED is done; ON_HOLD/CANCELLED must NOT be auto-flipped.
export const DELIVERABLE_FROM = ["CONFIRMED", "IN_PRODUCTION", "READY_TO_SHIP", "SHIPPED"];
// The status we RELEASE a DELIVERED SO back to when its DO is cancelled / a line
// shrinks / goods are returned and it is no longer fully covered.
export const RELEASE_TO = "READY_TO_SHIP";

/** For each SO doc no, recompute its delivery status from CURRENT live delivered
 *  quantities and reconcile the stored status — BIDIRECTIONAL + IDEMPOTENT:
 *    • fully covered  & status ∈ DELIVERABLE_FROM → advance to DELIVERED
 *    • NOT fully covered & status == DELIVERED    → release to READY_TO_SHIP
 *    • otherwise (already correct / terminal / manual) → no-op
 *  Records the transition in BOTH audit tables (status-changes + unified audit
 *  log, source='automation'). Best-effort: every SO is wrapped so one failure
 *  can't block the DO or the other SOs. */
export async function syncSoDeliveredFromDo(
  db: Db,
  soDocNos: Array<string | null | undefined>,
  actorId?: number | null,
): Promise<void> {
  const docs = [...new Set(soDocNos.filter((d): d is string => !!d))];
  for (const docNo of docs) {
    try {
      const soRows = await db
        .select({ status: soTable.status })
        .from(soTable)
        .where(eq(soTable.docNo, docNo))
        .limit(1);
      const status = soRows[0]?.status as string | undefined;
      if (!status) continue;
      const canAdvance = DELIVERABLE_FROM.includes(status);
      const canRelease = status === "DELIVERED";
      if (!canAdvance && !canRelease) continue;

      const soItemsRaw = await db
        .select({ id: soItemsTable.id, qty: soItemsTable.qty, itemCode: soItemsTable.itemCode, itemGroup: soItemsTable.itemGroup })
        .from(soItemsTable)
        .where(and(eq(soItemsTable.docNo, docNo), eq(soItemsTable.cancelled, false)));
      const soLines = soItemsRaw.map((l) => ({ id: l.id, qty: Number(l.qty), item_code: l.itemCode, item_group: l.itemGroup }));
      if (soLines.length === 0) continue;

      const soItemIds = soLines.map((l) => l.id);

      // Cumulative delivered qty per SO line across ALL non-cancelled DOs that
      // reference these SO items (a line may be split over several DOs). Pull the
      // candidate DO lines, then drop those whose parent DO is cancelled.
      const doLineRows = await db
        .select({ id: deliveryOrderItems.id, soItemId: deliveryOrderItems.soItemId, qty: deliveryOrderItems.qty, deliveryOrderId: deliveryOrderItems.deliveryOrderId })
        .from(deliveryOrderItems)
        .where(inArray(deliveryOrderItems.soItemId, soItemIds));
      const doIds = [...new Set(doLineRows.map((d) => d.deliveryOrderId).filter(Boolean))];
      const activeDoIds = new Set<string>();
      if (doIds.length > 0) {
        const dos = await db.select({ id: deliveryOrders.id, status: deliveryOrders.status }).from(deliveryOrders).where(inArray(deliveryOrders.id, doIds));
        for (const d of dos) if ((d.status ?? "").toUpperCase() !== "CANCELLED") activeDoIds.add(d.id);
      }
      const activeDoLines = doLineRows.filter((d) => activeDoIds.has(d.deliveryOrderId));
      const doLines: DoLineQty[] = activeDoLines.map((d) => ({ soItemId: d.soItemId, qty: Number(d.qty) }));
      const doLineToSoItem = new Map<string, string | null>();
      for (const d of activeDoLines) doLineToSoItem.set(d.id, d.soItemId);

      // DR 3B — Σ returned qty per SO line across all non-cancelled Delivery
      // Returns. A DR line carries do_item_id (the DO line it returns).
      const returnLines: DoLineQty[] = [];
      const activeDoLineIds = [...doLineToSoItem.keys()];
      if (activeDoLineIds.length > 0) {
        const drLineRows = await db
          .select({ doItemId: deliveryReturnItems.doItemId, qtyReturned: deliveryReturnItems.qtyReturned, deliveryReturnId: deliveryReturnItems.deliveryReturnId })
          .from(deliveryReturnItems)
          .where(inArray(deliveryReturnItems.doItemId, activeDoLineIds));
        const drIds = [...new Set(drLineRows.map((r) => r.deliveryReturnId).filter(Boolean))];
        const activeDrIds = new Set<string>();
        if (drIds.length > 0) {
          const drs = await db.select({ id: deliveryReturns.id, status: deliveryReturns.status }).from(deliveryReturns).where(inArray(deliveryReturns.id, drIds));
          for (const d of drs) if ((d.status ?? "").toUpperCase() !== "CANCELLED") activeDrIds.add(d.id);
        }
        for (const r of drLineRows) {
          if (!r.doItemId || !activeDrIds.has(r.deliveryReturnId)) continue;
          const soItemId = doLineToSoItem.get(r.doItemId) ?? null;
          returnLines.push({ soItemId, qty: Number(r.qtyReturned ?? 0) });
        }
      }

      const fullyCovered = isSoFullyCovered(soLines, doLines, returnLines);

      // Line-level READY flip: a single SO line whose NET delivered (Σ DO − Σ DR)
      // ≥ ordered qty must read READY (the "grab" case — a DO force-shipped it
      // before it was ever marked READY). SERVICE lines are skipped (no stock).
      const netByLine = new Map<string, number>();
      for (const d of doLines) {
        if (!d.soItemId) continue;
        netByLine.set(d.soItemId, (netByLine.get(d.soItemId) ?? 0) + (d.qty ?? 0));
      }
      for (const r of returnLines) {
        if (!r.soItemId) continue;
        netByLine.set(r.soItemId, (netByLine.get(r.soItemId) ?? 0) - (r.qty ?? 0));
      }
      const shippedLines = soLines.filter(
        (l) => !isServiceLine({ itemGroup: l.item_group, itemCode: l.item_code }) && (netByLine.get(l.id) ?? 0) >= l.qty,
      );
      for (const l of shippedLines) {
        await db
          .update(soItemsTable)
          .set({ stockStatus: "READY", stockQtyReady: l.qty })
          .where(and(eq(soItemsTable.id, l.id), ne(soItemsTable.stockStatus, "READY")));
      }

      // Decide the reconciled status. No-op when it already matches.
      let target: string | null = null;
      if (fullyCovered && canAdvance) target = "DELIVERED";
      else if (!fullyCovered && canRelease) target = RELEASE_TO;
      if (!target || target === status) continue;

      const note =
        target === "DELIVERED"
          ? "Auto: Delivery Order fully covers this SO"
          : "Auto: SO no longer fully delivered (DO cancelled / reduced, or goods returned) — released to re-ship";
      await db.update(soTable).set({ status: target as never, updatedAt: new Date() }).where(eq(soTable.docNo, docNo));
      try {
        await db.insert(soStatusChangesTable).values({ docNo, fromStatus: status, toStatus: target, changedBy: actorId ?? null, notes: note } as never);
      } catch {
        /* best-effort */
      }
      await recordSoAudit(db, {
        docNo,
        action: "UPDATE_STATUS",
        actorId: actorId ?? null,
        fieldChanges: [{ field: "status", from: status, to: target }],
        statusSnapshot: target,
        source: "automation",
        note,
      });
    } catch {
      /* best-effort — a sync failure must NEVER roll back or block the DO */
    }
  }
}
