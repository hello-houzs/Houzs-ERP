// ----------------------------------------------------------------------------
// /purchase-consignment-returns — we send consigned goods back to the supplier.
// Closes the loop: PC Order -> PC Receive -> (defect/oversupply/wrong) -> PC
// Return -> supplier credit note.
//
// ON-LEDGER: a PC Return ships the SUPPLIER'S consigned goods back OUT of MY
// warehouse, so it books an OUT (resyncPcReturnInventory, self-healing on
// create / line CRUD / cancel; cancel nets the OUT back to zero via an IN).
//
// 1:1 clone of 2990s apps/api/src/routes/purchase-consignment-returns.ts (itself
// a clone of purchase-returns). Endpoints, bodies, response shapes, status codes,
// business rules (POSTED-on-create, over-return cap vs PC Receive line, returned_qty
// live-recount onto the receive + PC-order re-open, line-edit lock to ACTIVE,
// post/complete/cancel, single self-healing inventory resync) kept identical.
// Only the SEAMS change (same playbook): DB getDb + Drizzle (rule #3 + #7), auth
// requirePermission("*") (rule #4), user.id staff uuid -> users.id integer (rule
// #4), mount /api/purchase-consignment-returns, inventory via lib/inventory-
// movements (source_doc_type 'PC_RETURN' first OUT + 'STOCK_TRANSFER' deltas).
//
// Strategy-2: DROPPED buildVariantSummary (description2 passes through); variant
// columns persisted for fidelity. computeVariantKey is the generic shared one.
// ----------------------------------------------------------------------------

import { Hono } from "hono";
import { and, asc, desc, eq, gt, inArray, like, ne } from "drizzle-orm";
import type { Env } from "../types";
import { getDb } from "../db/client";
import {
  purchaseConsignmentReturns as pctTable,
  purchaseConsignmentReturnItems as pctItemsTable,
  purchaseConsignmentReceives as pcrTable,
  purchaseConsignmentReceiveItems as pcrItemsTable,
  inventoryMovements as movTable,
  suppliers as suppliersTable,
} from "../db/schema";
import { requirePermission } from "../middleware/auth";
import { writeMovements, defaultWarehouseId, resolveWarehouseLotBatches } from "../lib/inventory-movements";
import { recomputeSoStockAllocation } from "../lib/so-stock-allocation";
import { recomputePcoReceived } from "./purchase-consignment-receives";
import { computeVariantKey, type VariantAttrs } from "@shared/index";

const app = new Hono<{ Bindings: Env }>();
app.use("*", requirePermission("*"));

type Db = ReturnType<typeof getDb>;
type PctHeaderRow = typeof pctTable.$inferSelect;
type PctItemRow = typeof pctItemsTable.$inferSelect;

const yymm = (): string => {
  const d = new Date();
  return `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, "0")}`;
};
const nextNum = async (db: Db): Promise<string> => {
  const rows = await db.select({ id: pctTable.id }).from(pctTable).where(like(pctTable.returnNumber, `PCT-${yymm()}-%`));
  return `PCT-${yymm()}-${String(rows.length + 1).padStart(3, "0")}`;
};

/* ── resyncPcReturnInventory — self-healing OUT ledger for a PC Return ───────── */
async function resyncPcReturnInventory(db: Db, returnId: string, performedBy: number | null): Promise<string[]> {
  const [header] = await db.select({ returnNumber: pctTable.returnNumber, status: pctTable.status, pcReceiveId: pctTable.pcReceiveId }).from(pctTable).where(eq(pctTable.id, returnId)).limit(1);
  if (!header) return [];
  const status = (header.status ?? "").toUpperCase();
  const returnNo = header.returnNumber ?? returnId;
  const cancelled = status === "CANCELLED";

  let headerWh: string | null = null;
  if (header.pcReceiveId) {
    const [rcv] = await db.select({ warehouseId: pcrTable.warehouseId }).from(pcrTable).where(eq(pcrTable.id, header.pcReceiveId)).limit(1);
    headerWh = rcv?.warehouseId ?? null;
  }
  const fallbackWh = headerWh ?? (await defaultWarehouseId(db));

  // 1. TARGET net OUT per bucket (empty if cancelled).
  type Bucket = { warehouse_id: string; product_code: string; variant_key: string; product_name: string | null; qty: number; batch_no: string | null };
  const targetByBucket = new Map<string, Bucket>();
  if (!cancelled) {
    const lineList = await db
      .select({ pcReceiveItemId: pctItemsTable.pcReceiveItemId, materialCode: pctItemsTable.materialCode, materialName: pctItemsTable.materialName, qtyReturned: pctItemsTable.qtyReturned, itemGroup: pctItemsTable.itemGroup, variants: pctItemsTable.variants })
      .from(pctItemsTable)
      .where(eq(pctItemsTable.purchaseConsignmentReturnId, returnId));

    const recvItemIds = [...new Set(lineList.map((l) => l.pcReceiveItemId).filter((x): x is string => !!x))];
    const whByRecvItem = new Map<string, string | null>();
    if (recvItemIds.length) {
      const riRows = await db.select({ id: pcrItemsTable.id, pcReceiveId: pcrItemsTable.pcReceiveId }).from(pcrItemsTable).where(inArray(pcrItemsTable.id, recvItemIds));
      const recvIds = [...new Set(riRows.map((r) => r.pcReceiveId).filter(Boolean))];
      const recvs = recvIds.length ? await db.select({ id: pcrTable.id, warehouseId: pcrTable.warehouseId }).from(pcrTable).where(inArray(pcrTable.id, recvIds)) : [];
      const whByRecv = new Map(recvs.map((r) => [r.id, r.warehouseId]));
      for (const r of riRows) whByRecvItem.set(r.id, whByRecv.get(r.pcReceiveId) ?? null);
    }

    const allWh = [...new Set(lineList.map((l) => (l.pcReceiveItemId ? whByRecvItem.get(l.pcReceiveItemId) : null) ?? fallbackWh).filter((x): x is string => !!x))];
    const batchByWh = new Map<string, Map<string, string | null>>();
    for (const wh of allWh) batchByWh.set(wh, await resolveWarehouseLotBatches(db, wh));

    for (const it of lineList) {
      const qty = Number(it.qtyReturned ?? 0);
      if (qty <= 0) continue;
      const wh = (it.pcReceiveItemId ? whByRecvItem.get(it.pcReceiveItemId) : null) ?? fallbackWh;
      if (!wh) continue;
      const vk = computeVariantKey(it.itemGroup, (it.variants as VariantAttrs | null) ?? null);
      const batch = batchByWh.get(wh)?.get(`${it.materialCode}::${vk}`) ?? null;
      const k = `${wh}::${it.materialCode}::${vk}::${batch ?? ""}`;
      const cur = targetByBucket.get(k);
      if (cur) cur.qty += qty;
      else targetByBucket.set(k, { warehouse_id: wh, product_code: it.materialCode, variant_key: vk, product_name: it.materialName, qty, batch_no: batch });
    }
  }

  // 2. CURRENT net OUT per bucket from ALL this return's movements.
  const movs = await db
    .select({ movementType: movTable.movementType, warehouseId: movTable.warehouseId, productCode: movTable.productCode, variantKey: movTable.variantKey, batchNo: movTable.batchNo, qty: movTable.qty, totalCostSen: movTable.totalCostSen, productName: movTable.productName })
    .from(movTable)
    .where(and(eq(movTable.sourceDocId, returnId), inArray(movTable.sourceDocType, ["PC_RETURN", "STOCK_TRANSFER"])));
  type Agg = { out_qty: number; in_qty: number; out_total_cost: number; product_name: string | null };
  const aggByBucket = new Map<string, Agg>();
  for (const m of movs) {
    const k = `${m.warehouseId}::${m.productCode}::${m.variantKey ?? ""}::${m.batchNo ?? ""}`;
    let a = aggByBucket.get(k);
    if (!a) { a = { out_qty: 0, in_qty: 0, out_total_cost: 0, product_name: m.productName }; aggByBucket.set(k, a); }
    if (m.movementType === "OUT") { a.out_qty += Number(m.qty ?? 0); a.out_total_cost += Number(m.totalCostSen ?? 0); }
    else if (m.movementType === "IN") a.in_qty += Number(m.qty ?? 0);
    if (!a.product_name) a.product_name = m.productName;
  }

  // 3. delta.
  type MovOut = Parameters<typeof writeMovements>[1][number];
  const writes: MovOut[] = [];
  const pcReturnEmitted = new Set<string>();
  for (const k of new Set<string>([...targetByBucket.keys(), ...aggByBucket.keys()])) {
    const t = targetByBucket.get(k);
    const a = aggByBucket.get(k) ?? { out_qty: 0, in_qty: 0, out_total_cost: 0, product_name: null };
    const delta = (t?.qty ?? 0) - (a.out_qty - a.in_qty);
    if (delta === 0) continue;
    const [wh, pc, vk, batchSeg] = k.split("::");
    const batch_no = batchSeg || null;
    const pname = t?.product_name ?? a.product_name ?? null;
    if (delta > 0) {
      const neverMoved = a.out_qty === 0 && a.in_qty === 0;
      const usePcReturn = neverMoved && !pcReturnEmitted.has(`${pc}::${vk}`);
      if (usePcReturn) pcReturnEmitted.add(`${pc}::${vk}`);
      writes.push({
        movement_type: "OUT", warehouse_id: wh ?? "", product_code: pc ?? "", variant_key: vk ?? "", product_name: pname,
        qty: delta,
        source_doc_type: usePcReturn ? "PC_RETURN" : "STOCK_TRANSFER",
        source_doc_id: returnId, source_doc_no: returnNo,
        ...(batch_no ? { batch_no } : {}),
        performed_by: performedBy,
        notes: usePcReturn ? "Consignment goods returned to supplier — stock out" : "PC Return resync: line qty increased / added.",
      });
    } else {
      const unitCost = a.out_qty > 0 ? Math.round(a.out_total_cost / a.out_qty) : 0;
      writes.push({
        movement_type: "IN", warehouse_id: wh ?? "", product_code: pc ?? "", variant_key: vk ?? "", product_name: pname,
        qty: -delta, unit_cost_sen: unitCost,
        source_doc_type: "STOCK_TRANSFER",
        source_doc_id: returnId, source_doc_no: cancelled ? `${returnNo}-CANCEL` : returnNo,
        ...(batch_no ? { batch_no } : {}),
        performed_by: performedBy,
        notes: cancelled ? "PC Return cancelled — stock back IN" : "PC Return resync: line qty reduced / deleted.",
      });
    }
  }

  if (writes.length === 0) return [];
  const res = await writeMovements(db, writes);
  try { await recomputeSoStockAllocation(db); } catch { /* best-effort */ }
  return res.ok ? [] : [res.reason ?? "PC return inventory resync failed"];
}

/* ── Recompute PC Return header money rollup ── */
async function recomputePcReturnTotals(db: Db, prId: string) {
  const items = await db.select({ lineRefundCenti: pctItemsTable.lineRefundCenti }).from(pctItemsTable).where(eq(pctItemsTable.purchaseConsignmentReturnId, prId));
  const refund = items.reduce((s, r) => s + (r.lineRefundCenti ?? 0), 0);
  await db.update(pctTable).set({ refundCenti: refund, updatedAt: new Date() } as never).where(eq(pctTable.id, prId));
}

/* ── PC-Receive→PC-Return consumption helper (recount-from-live). ── */
async function adjustPcReceiveReturnedQty(db: Db, receiveItemId: string) {
  if (!receiveItemId) return;
  const rows = await db.select({ qtyReturned: pctItemsTable.qtyReturned, returnId: pctItemsTable.purchaseConsignmentReturnId }).from(pctItemsTable).where(eq(pctItemsTable.pcReceiveItemId, receiveItemId));
  const prIds = [...new Set(rows.map((r) => r.returnId).filter(Boolean))];
  const cancelled = new Set<string>();
  if (prIds.length > 0) {
    const prs = await db.select({ id: pctTable.id, status: pctTable.status }).from(pctTable).where(inArray(pctTable.id, prIds));
    for (const p of prs) if ((p.status ?? "").toUpperCase() === "CANCELLED") cancelled.add(p.id);
  }
  let returned = 0;
  for (const r of rows) if (!cancelled.has(r.returnId)) returned += Number(r.qtyReturned ?? 0);

  const [gi] = await db.select({ qtyAccepted: pcrItemsTable.qtyAccepted, pcOrderItemId: pcrItemsTable.pcOrderItemId }).from(pcrItemsTable).where(eq(pcrItemsTable.id, receiveItemId)).limit(1);
  if (!gi) return;
  const accepted = gi.qtyAccepted ?? 0;
  const next = Math.min(accepted, Math.max(0, returned));
  await db.update(pcrItemsTable).set({ returnedQty: next } as never).where(eq(pcrItemsTable.id, receiveItemId));
  if (gi.pcOrderItemId) await recomputePcoReceived(db, [gi.pcOrderItemId]);
}

async function suppliersByIds(db: Db, ids: string[]): Promise<Map<string, { id: string; code: string; name: string }>> {
  const out = new Map<string, { id: string; code: string; name: string }>();
  const uniq = [...new Set(ids.filter(Boolean))];
  if (uniq.length === 0) return out;
  const rows = await db.select({ id: suppliersTable.id, code: suppliersTable.code, name: suppliersTable.name }).from(suppliersTable).where(inArray(suppliersTable.id, uniq));
  for (const r of rows) out.set(r.id, { id: r.id, code: r.code, name: r.name });
  return out;
}

function toReturnResponse(r: PctHeaderRow, opts?: { supplier?: { id: string; code: string; name: string } | null; pco?: { id: string; pc_number: string } | null; receive?: { id: string; receive_number: string } | null }) {
  return {
    id: r.id,
    return_number: r.returnNumber,
    pc_order_id: r.pcOrderId,
    pc_receive_id: r.pcReceiveId,
    supplier_id: r.supplierId,
    return_date: r.returnDate,
    reason: r.reason,
    status: r.status,
    posted_at: r.postedAt,
    completed_at: r.completedAt,
    credit_note_ref: r.creditNoteRef,
    refund_centi: r.refundCenti,
    notes: r.notes,
    created_at: r.createdAt,
    created_by: r.createdBy,
    updated_at: r.updatedAt,
    ...(opts?.supplier !== undefined ? { supplier: opts.supplier } : {}),
    ...(opts?.pco !== undefined ? { purchase_consignment_order: opts.pco } : {}),
    ...(opts?.receive !== undefined ? { pc_receive: opts.receive } : {}),
  };
}

function toReturnItemResponse(r: PctItemRow) {
  return {
    id: r.id,
    purchase_consignment_return_id: r.purchaseConsignmentReturnId,
    pc_receive_item_id: r.pcReceiveItemId,
    material_kind: r.materialKind,
    material_code: r.materialCode,
    material_name: r.materialName,
    qty_returned: r.qtyReturned,
    unit_price_centi: r.unitPriceCenti,
    line_refund_centi: r.lineRefundCenti,
    reason: r.reason,
    notes: r.notes,
    item_group: r.itemGroup,
    description: r.description,
    description2: r.description2,
    uom: r.uom,
    variants: r.variants,
    created_at: r.createdAt,
  };
}

async function joinsForReturns(db: Db, rows: PctHeaderRow[]) {
  const supMap = await suppliersByIds(db, rows.map((r) => r.supplierId));
  const pcoIds = [...new Set(rows.map((r) => r.pcOrderId).filter((x): x is string => !!x))];
  const recvIds = [...new Set(rows.map((r) => r.pcReceiveId).filter((x): x is string => !!x))];
  const pcoMap = new Map<string, { id: string; pc_number: string }>();
  if (pcoIds.length) {
    const { purchaseConsignmentOrders } = await import("../db/schema");
    const pcos = await db.select({ id: purchaseConsignmentOrders.id, pcNumber: purchaseConsignmentOrders.pcNumber }).from(purchaseConsignmentOrders).where(inArray(purchaseConsignmentOrders.id, pcoIds));
    for (const p of pcos) pcoMap.set(p.id, { id: p.id, pc_number: p.pcNumber });
  }
  const recvMap = new Map<string, { id: string; receive_number: string }>();
  if (recvIds.length) {
    const recvs = await db.select({ id: pcrTable.id, receiveNumber: pcrTable.receiveNumber }).from(pcrTable).where(inArray(pcrTable.id, recvIds));
    for (const r of recvs) recvMap.set(r.id, { id: r.id, receive_number: r.receiveNumber });
  }
  return { supMap, pcoMap, recvMap };
}

app.get("/", async (c) => {
  const db = getDb(c.env);
  const status = c.req.query("status");
  const supplierId = c.req.query("supplierId");
  const conds = [] as ReturnType<typeof eq>[];
  if (status) conds.push(eq(pctTable.status, status as PctHeaderRow["status"]));
  if (supplierId) conds.push(eq(pctTable.supplierId, supplierId));
  const rows = await db.select().from(pctTable).where(conds.length ? and(...conds) : undefined).orderBy(desc(pctTable.returnDate)).limit(300);
  const { supMap, pcoMap, recvMap } = await joinsForReturns(db, rows);
  const purchaseReturns = rows.map((r) => toReturnResponse(r, {
    supplier: supMap.get(r.supplierId) ?? null,
    pco: r.pcOrderId ? (pcoMap.get(r.pcOrderId) ?? null) : null,
    receive: r.pcReceiveId ? (recvMap.get(r.pcReceiveId) ?? null) : null,
  }));
  return c.json({ purchaseReturns });
});

// ── Returnable PC Receive lines (From-Receive multi-picker). MUST precede /:id. ──
app.get("/returnable-receive-lines", async (c) => {
  const db = getDb(c.env);
  const recvList = await db.select({ id: pcrTable.id, receiveNumber: pcrTable.receiveNumber, supplierId: pcrTable.supplierId, status: pcrTable.status }).from(pcrTable).where(ne(pcrTable.status, "CANCELLED")).orderBy(desc(pcrTable.receiveNumber)).limit(1000);
  if (recvList.length === 0) return c.json({ lines: [] });
  const recvById = new Map(recvList.map((r) => [r.id, r]));
  const recvIds = recvList.map((r) => r.id);
  const supMap = await suppliersByIds(db, recvList.map((r) => r.supplierId).filter((x): x is string => !!x));

  const items = await db.select().from(pcrItemsTable).where(inArray(pcrItemsTable.pcReceiveId, recvIds));
  const lines = items
    .map((it) => {
      const r = recvById.get(it.pcReceiveId);
      const accepted = Number(it.qtyAccepted ?? 0);
      const returned = Number(it.returnedQty ?? 0);
      return {
        receiveItemId: it.id,
        pcReceiveId: it.pcReceiveId,
        receiveNumber: r?.receiveNumber ?? "",
        supplierId: r?.supplierId ?? null,
        supplierName: r?.supplierId ? (supMap.get(r.supplierId)?.name ?? null) : null,
        materialKind: it.materialKind ?? "OTHER",
        materialCode: it.materialCode,
        materialName: it.materialName ?? "",
        itemGroup: it.itemGroup ?? null,
        description: it.description ?? null,
        uom: it.uom ?? null,
        accepted,
        returned,
        remaining: accepted - returned,
        unitPriceCenti: Number(it.unitPriceCenti ?? 0),
        variants: it.variants ?? null,
      };
    })
    .filter((l) => l.remaining > 0);
  return c.json({ lines });
});

app.get("/:id", async (c) => {
  const db = getDb(c.env); const id = c.req.param("id");
  const [h] = await db.select().from(pctTable).where(eq(pctTable.id, id)).limit(1);
  if (!h) return c.json({ error: "not_found" }, 404);
  const { supMap, pcoMap, recvMap } = await joinsForReturns(db, [h]);
  const items = await db.select().from(pctItemsTable).where(eq(pctItemsTable.purchaseConsignmentReturnId, id)).orderBy(asc(pctItemsTable.createdAt));
  return c.json({
    purchaseReturn: toReturnResponse(h, {
      supplier: supMap.get(h.supplierId) ?? null,
      pco: h.pcOrderId ? (pcoMap.get(h.pcOrderId) ?? null) : null,
      receive: h.pcReceiveId ? (recvMap.get(h.pcReceiveId) ?? null) : null,
    }),
    items: items.map(toReturnItemResponse),
  });
});

app.get("/:id/linked", async (c) => {
  const db = getDb(c.env); const id = c.req.param("id");
  const [h] = await db.select({ id: pctTable.id, pcOrderId: pctTable.pcOrderId, pcReceiveId: pctTable.pcReceiveId }).from(pctTable).where(eq(pctTable.id, id)).limit(1);
  if (!h) return c.json({ error: "not_found" }, 404);
  const { pcoMap, recvMap } = await joinsForReturns(db, [{ ...h } as PctHeaderRow]);
  return c.json({
    pcReceive: h.pcReceiveId ? (recvMap.get(h.pcReceiveId) ?? null) : null,
    purchaseConsignmentOrder: h.pcOrderId ? (pcoMap.get(h.pcOrderId) ?? null) : null,
  });
});

app.post("/", async (c) => {
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: "invalid_json" }, 400); }
  if (body.status === "DRAFT") return c.json({ error: "draft_status_not_supported", message: "Consignment returns post immediately on create." }, 400);
  if (!body.supplierId) return c.json({ error: "supplier_required" }, 400);
  const items = body.items as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(items) || !items.length) return c.json({ error: "items_required" }, 400);

  const db = getDb(c.env); const user = c.get("user");
  const returnNumber = await nextNum(db);

  const preReceiveItemIds = [...new Set(items.map((it) => (it.pcReceiveItemId as string | undefined) ?? null).filter((x): x is string => !!x))];
  const remainingByReceiveItem = new Map<string, number>();
  if (preReceiveItemIds.length > 0) {
    const giRows = await db.select({ id: pcrItemsTable.id, qtyAccepted: pcrItemsTable.qtyAccepted, returnedQty: pcrItemsTable.returnedQty }).from(pcrItemsTable).where(inArray(pcrItemsTable.id, preReceiveItemIds));
    for (const r of giRows) remainingByReceiveItem.set(r.id, Math.max(0, (r.qtyAccepted ?? 0) - (r.returnedQty ?? 0)));
  }
  for (const it of items) {
    const receiveItemId = (it.pcReceiveItemId as string | undefined) ?? null;
    if (receiveItemId && remainingByReceiveItem.has(receiveItemId)) {
      const requested = Number(it.qtyReturned ?? 0);
      const remaining = remainingByReceiveItem.get(receiveItemId) as number;
      if (requested > remaining) return c.json({ error: "qty_exceeds_remaining", requested, remaining, materialCode: it.materialCode ?? null }, 409);
    }
  }

  let totalRefund = 0;
  const itemRows = items
    .map((it) => {
      const receiveItemId = (it.pcReceiveItemId as string | undefined) ?? null;
      const qty = Number(it.qtyReturned ?? 0);
      const unit = Number(it.unitPriceCenti ?? 0);
      const lineRefund = qty * unit;
      totalRefund += lineRefund;
      return {
        pcReceiveItemId: receiveItemId,
        materialKind: it.materialKind as PctItemRow["materialKind"],
        materialCode: it.materialCode as string,
        materialName: it.materialName as string,
        qtyReturned: qty,
        unitPriceCenti: unit,
        lineRefundCenti: lineRefund,
        reason: (it.reason as string | undefined) ?? null,
        notes: (it.notes as string | undefined) ?? null,
        itemGroup: (it.itemGroup as string | null | undefined) ?? null,
        variants: (it.variants as Record<string, unknown> | null | undefined) ?? null,
      };
    })
    .filter((r) => Number(r.qtyReturned) > 0);
  if (itemRows.length === 0) return c.json({ error: "no_returnable_qty", message: "Every line is already fully returned (nothing left to return)." }, 400);

  const [header] = await db
    .insert(pctTable)
    .values({
      returnNumber,
      pcOrderId: (body.pcOrderId as string | undefined) ?? null,
      pcReceiveId: (body.pcReceiveId as string | undefined) ?? null,
      supplierId: body.supplierId as string,
      returnDate: (body.returnDate as string) ?? new Date().toISOString().slice(0, 10),
      reason: (body.reason as string | undefined) ?? null,
      refundCenti: totalRefund,
      notes: (body.notes as string | undefined) ?? null,
      status: "POSTED",
      postedAt: new Date(),
      createdBy: user?.id ?? null,
    } as never)
    .returning();
  const h = header as PctHeaderRow;

  try {
    await db.insert(pctItemsTable).values(itemRows.map((r) => ({ ...r, purchaseConsignmentReturnId: h.id })) as never);
  } catch (e) {
    await db.delete(pctTable).where(eq(pctTable.id, h.id));
    return c.json({ error: "items_insert_failed", reason: e instanceof Error ? e.message : String(e) }, 500);
  }

  for (const r of itemRows) if (r.pcReceiveItemId) await adjustPcReceiveReturnedQty(db, r.pcReceiveItemId);
  try { await resyncPcReturnInventory(db, h.id, user?.id ?? null); } catch { /* best-effort */ }
  return c.json({ id: h.id, returnNumber: h.returnNumber }, 201);
});

// ── POST /from-pc-receives — batch from many POSTED receives (qty_rejected). ──
app.post("/from-pc-receives", async (c) => {
  const db = getDb(c.env); const user = c.get("user");
  let body: { pcReceiveIds?: string[]; reason?: string; notes?: string };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: "invalid_json" }, 400); }
  const receiveIds = body.pcReceiveIds ?? [];
  if (receiveIds.length === 0) return c.json({ error: "pc_receive_ids_required" }, 400);

  const recvList = await db.select({ id: pcrTable.id, receiveNumber: pcrTable.receiveNumber, supplierId: pcrTable.supplierId, purchaseConsignmentOrderId: pcrTable.purchaseConsignmentOrderId, status: pcrTable.status }).from(pcrTable).where(inArray(pcrTable.id, receiveIds));
  if (recvList.length === 0) return c.json({ error: "pc_receives_not_found" }, 404);
  const notPosted = recvList.filter((g) => g.status !== "POSTED");
  if (notPosted.length > 0) return c.json({ error: "not_all_posted", message: `These receives are not POSTED: ${notPosted.map((g) => g.receiveNumber).join(", ")}` }, 400);
  const supplierIds = new Set(recvList.map((g) => g.supplierId));
  if (supplierIds.size > 1) return c.json({ error: "mixed_suppliers", message: "All selected receives must be from the same supplier" }, 400);
  const supplierId = [...supplierIds][0]!;

  const items = await db.select().from(pcrItemsTable).where(and(inArray(pcrItemsTable.pcReceiveId, receiveIds), gt(pcrItemsTable.qtyRejected, 0)));
  const rejectedItems = items
    .map((it) => {
      const remaining = (it.qtyAccepted ?? 0) - (it.returnedQty ?? 0);
      return { ...it, _qty: Math.min(it.qtyRejected ?? 0, Math.max(0, remaining)) };
    })
    .filter((it) => it._qty > 0);
  if (rejectedItems.length === 0) return c.json({ error: "no_rejected_qty", message: "None of the selected receives have remaining rejected qty to return" }, 400);

  const returnNumber = await nextNum(db);
  const recvNumbersJoined = recvList.map((g) => g.receiveNumber).join(", ");
  const totalRefund = rejectedItems.reduce((s, it) => s + it._qty * it.unitPriceCenti, 0);

  const [header] = await db
    .insert(pctTable)
    .values({
      returnNumber,
      pcOrderId: recvList[0]!.purchaseConsignmentOrderId,
      pcReceiveId: recvList[0]!.id,
      supplierId,
      returnDate: new Date().toISOString().slice(0, 10),
      reason: body.reason ?? `Batch from ${recvList.length} receives: ${recvNumbersJoined}`,
      refundCenti: totalRefund,
      notes: body.notes ?? null,
      status: "POSTED",
      postedAt: new Date(),
      createdBy: user?.id ?? null,
    } as never)
    .returning();
  const h = header as PctHeaderRow;

  const rows = rejectedItems.map((it) => ({
    purchaseConsignmentReturnId: h.id,
    pcReceiveItemId: it.id,
    materialKind: it.materialKind,
    materialCode: it.materialCode,
    materialName: it.materialName,
    qtyReturned: it._qty,
    unitPriceCenti: it.unitPriceCenti,
    lineRefundCenti: it._qty * it.unitPriceCenti,
    reason: it.rejectionReason,
    itemGroup: it.itemGroup,
    variants: it.variants,
    description: it.description,
    description2: it.description2 ?? null,
    uom: it.uom ?? "UNIT",
  }));
  try {
    await db.insert(pctItemsTable).values(rows as never);
  } catch (e) {
    await db.delete(pctTable).where(eq(pctTable.id, h.id));
    return c.json({ error: "items_insert_failed", reason: e instanceof Error ? e.message : String(e) }, 500);
  }

  for (const it of rejectedItems) await adjustPcReceiveReturnedQty(db, it.id);
  try { await resyncPcReturnInventory(db, h.id, user?.id ?? null); } catch { /* best-effort */ }
  return c.json({ id: h.id, returnNumber: h.returnNumber, pcReceiveCount: recvList.length, lineCount: rejectedItems.length }, 201);
});

// ── POST /from-pc-receive — single-receive convert (remaining accepted). ──
app.post("/from-pc-receive", async (c) => {
  const db = getDb(c.env); const user = c.get("user");
  let body: { pcReceiveId?: string; reason?: string; notes?: string };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: "invalid_json" }, 400); }
  const receiveId = body.pcReceiveId;
  if (!receiveId) return c.json({ error: "pc_receive_id_required" }, 400);

  const [g] = await db.select({ id: pcrTable.id, receiveNumber: pcrTable.receiveNumber, supplierId: pcrTable.supplierId, purchaseConsignmentOrderId: pcrTable.purchaseConsignmentOrderId, status: pcrTable.status }).from(pcrTable).where(eq(pcrTable.id, receiveId)).limit(1);
  if (!g) return c.json({ error: "pc_receive_not_found" }, 404);
  if (g.status !== "POSTED") return c.json({ error: "pc_receive_not_posted", status: g.status }, 409);

  const allLines = await db.select().from(pcrItemsTable).where(and(eq(pcrItemsTable.pcReceiveId, receiveId), gt(pcrItemsTable.qtyAccepted, 0)));
  const lines = allLines.map((it) => ({ ...it, _remaining: (it.qtyAccepted ?? 0) - (it.returnedQty ?? 0) })).filter((it) => it._remaining > 0);
  if (lines.length === 0) return c.json({ error: "nothing_to_return", message: "Receive is fully returned" }, 400);

  const returnNumber = await nextNum(db);
  const totalRefund = lines.reduce((s, it) => s + it._remaining * it.unitPriceCenti, 0);

  const [header] = await db
    .insert(pctTable)
    .values({
      returnNumber,
      pcOrderId: g.purchaseConsignmentOrderId,
      pcReceiveId: g.id,
      supplierId: g.supplierId,
      returnDate: new Date().toISOString().slice(0, 10),
      reason: body.reason ?? `From ${g.receiveNumber}`,
      refundCenti: totalRefund,
      notes: body.notes ?? null,
      status: "POSTED",
      postedAt: new Date(),
      createdBy: user?.id ?? null,
    } as never)
    .returning();
  const h = header as PctHeaderRow;

  const rows = lines.map((it) => ({
    purchaseConsignmentReturnId: h.id,
    pcReceiveItemId: it.id,
    materialKind: it.materialKind,
    materialCode: it.materialCode,
    materialName: it.materialName,
    qtyReturned: it._remaining,
    unitPriceCenti: it.unitPriceCenti,
    lineRefundCenti: it._remaining * it.unitPriceCenti,
    reason: it.rejectionReason,
    itemGroup: it.itemGroup,
    variants: it.variants,
    description: it.description,
    description2: it.description2 ?? null,
    uom: it.uom ?? "UNIT",
  }));
  try {
    await db.insert(pctItemsTable).values(rows as never);
  } catch (e) {
    await db.delete(pctTable).where(eq(pctTable.id, h.id));
    return c.json({ error: "items_insert_failed", reason: e instanceof Error ? e.message : String(e) }, 500);
  }

  for (const it of lines) await adjustPcReceiveReturnedQty(db, it.id);
  await recomputePcReturnTotals(db, h.id);
  try { await resyncPcReturnInventory(db, h.id, user?.id ?? null); } catch { /* best-effort */ }
  return c.json({ id: h.id, returnNumber: h.returnNumber }, 201);
});

app.patch("/:id/post", async (c) => {
  const db = getDb(c.env); const id = c.req.param("id");
  const [row] = await db.select({ id: pctTable.id, status: pctTable.status, postedAt: pctTable.postedAt, returnNumber: pctTable.returnNumber, pcReceiveId: pctTable.pcReceiveId }).from(pctTable).where(eq(pctTable.id, id)).limit(1);
  if (!row) return c.json({ error: "not_found" }, 404);
  if (row.status === "POSTED" || row.status === "COMPLETED") return c.json({ purchaseConsignmentReturn: row });
  return c.json({ error: "cannot_post", message: `Cannot post a ${row.status} return.` }, 409);
});

app.patch("/:id/complete", async (c) => {
  const db = getDb(c.env); const id = c.req.param("id");
  let body: { creditNoteRef?: string };
  try { body = (await c.req.json()) as typeof body; } catch { body = {}; }
  const updates: Record<string, unknown> = { status: "COMPLETED", completedAt: new Date(), updatedAt: new Date() };
  if (body.creditNoteRef) updates.creditNoteRef = body.creditNoteRef;
  const [data] = await db.update(pctTable).set(updates as never).where(and(eq(pctTable.id, id), eq(pctTable.status, "POSTED"))).returning({ id: pctTable.id, status: pctTable.status, completedAt: pctTable.completedAt });
  if (!data) return c.json({ error: "not_posted" }, 409);
  return c.json({ purchaseConsignmentReturn: data });
});

app.patch("/:id/cancel", async (c) => {
  const db = getDb(c.env); const id = c.req.param("id");
  const [cur] = await db.select({ id: pctTable.id, status: pctTable.status, returnNumber: pctTable.returnNumber, pcReceiveId: pctTable.pcReceiveId }).from(pctTable).where(eq(pctTable.id, id)).limit(1);
  if (!cur) return c.json({ error: "not_found" }, 404);
  if (cur.status === "COMPLETED") return c.json({ error: "cannot_cancel", message: "Already completed" }, 409);
  if (cur.status === "CANCELLED") return c.json({ purchaseConsignmentReturn: { id, status: "CANCELLED" } });

  const updRow = await db.update(pctTable).set({ status: "CANCELLED", updatedAt: new Date() } as never).where(and(eq(pctTable.id, id), ne(pctTable.status, "CANCELLED"), ne(pctTable.status, "COMPLETED"))).returning({ id: pctTable.id });
  if (updRow.length === 0) {
    const [now] = await db.select({ status: pctTable.status }).from(pctTable).where(eq(pctTable.id, id)).limit(1);
    if (now?.status === "CANCELLED") return c.json({ purchaseConsignmentReturn: { id, status: "CANCELLED" } });
    if (now?.status === "COMPLETED") return c.json({ error: "cannot_cancel", message: "Already completed" }, 409);
    return c.json({ error: "cannot_cancel" }, 409);
  }

  try {
    const relLines = await db.select({ qtyReturned: pctItemsTable.qtyReturned, pcReceiveItemId: pctItemsTable.pcReceiveItemId }).from(pctItemsTable).where(eq(pctItemsTable.purchaseConsignmentReturnId, id));
    for (const l of relLines) if (l.pcReceiveItemId) await adjustPcReceiveReturnedQty(db, l.pcReceiveItemId);
  } catch { /* best-effort */ }
  try { await resyncPcReturnInventory(db, id, c.get("user")?.id ?? null); } catch (e) { console.error("[pc-return] cancel reversal failed:", e); }

  return c.json({ purchaseConsignmentReturn: { id, status: "CANCELLED" } });
});

/* ── PATCH /:id — header update ── */
app.patch("/:id", async (c) => {
  const id = c.req.param("id");
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: "invalid_json" }, 400); }
  const db = getDb(c.env);
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  for (const [from, to] of [
    ["supplierId", "supplierId"], ["returnDate", "returnDate"],
    ["reason", "reason"], ["creditNoteRef", "creditNoteRef"], ["notes", "notes"],
  ] as const) {
    if (body[from] !== undefined) updates[to] = body[from];
  }
  const [data] = await db.update(pctTable).set(updates as never).where(eq(pctTable.id, id)).returning();
  if (!data) return c.json({ error: "not_found" }, 404);
  return c.json({ purchaseConsignmentReturn: toReturnResponse(data) });
});

async function pcReturnLineLock(db: Db, prId: string): Promise<{ error: string; message: string } | null> {
  const [row] = await db.select({ status: pctTable.status }).from(pctTable).where(eq(pctTable.id, prId)).limit(1);
  const st = row?.status;
  if (st === "CANCELLED") return { error: "pc_return_cancelled", message: "This consignment return is cancelled — its lines can no longer be changed." };
  if (st === "COMPLETED") return { error: "pc_return_completed", message: "This consignment return is completed — its lines can no longer be changed." };
  return null;
}

app.post("/:id/items", async (c) => {
  const prId = c.req.param("id");
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: "invalid_json" }, 400); }
  if (!it.materialCode) return c.json({ error: "material_code_required" }, 400);
  if (!it.materialName) return c.json({ error: "material_name_required" }, 400);

  const db = getDb(c.env);
  { const lock = await pcReturnLineLock(db, prId); if (lock) return c.json(lock, 409); }
  const qtyReturned = Number(it.qty ?? 1);
  const unitPriceCenti = Number(it.unitPriceCenti ?? 0);
  const lineRefund = qtyReturned * unitPriceCenti;

  const receiveItemId = (it.pcReceiveItemId as string) ?? null;
  if (receiveItemId) {
    const [gi] = await db.select({ qtyAccepted: pcrItemsTable.qtyAccepted, returnedQty: pcrItemsTable.returnedQty }).from(pcrItemsTable).where(eq(pcrItemsTable.id, receiveItemId)).limit(1);
    if (gi) {
      const remaining = (gi.qtyAccepted ?? 0) - (gi.returnedQty ?? 0);
      if (qtyReturned > remaining) return c.json({ error: "qty_exceeds_remaining", requested: qtyReturned, remaining }, 409);
    }
  }

  const [data] = await db
    .insert(pctItemsTable)
    .values({
      purchaseConsignmentReturnId: prId,
      pcReceiveItemId: receiveItemId,
      materialKind: ((it.materialKind as string) ?? "mfg_product") as PctItemRow["materialKind"],
      materialCode: it.materialCode as string,
      materialName: it.materialName as string,
      qtyReturned,
      unitPriceCenti,
      lineRefundCenti: lineRefund,
      reason: (it.reason as string) ?? null,
      notes: (it.notes as string) ?? null,
      gapInches: (it.gapInches as number) ?? null,
      divanHeightInches: (it.divanHeightInches as number) ?? null,
      divanPriceSen: Number(it.divanPriceSen ?? 0),
      legHeightInches: (it.legHeightInches as number) ?? null,
      legPriceSen: Number(it.legPriceSen ?? 0),
      customSpecials: (it.customSpecials as unknown) ?? null,
      lineSuffix: (it.lineSuffix as string) ?? null,
      specialOrderPriceSen: Number(it.specialOrderPriceSen ?? 0),
      variants: (it.variants as unknown) ?? null,
      itemGroup: (it.itemGroup as string) ?? null,
      description: (it.description as string) ?? null,
      description2: (it.description2 as string) ?? null,
      uom: (it.uom as string) ?? "UNIT",
    } as never)
    .returning();

  if (receiveItemId) {
    const [gi] = await db.select({ qtyAccepted: pcrItemsTable.qtyAccepted }).from(pcrItemsTable).where(eq(pcrItemsTable.id, receiveItemId)).limit(1);
    if (gi) {
      const cap = gi.qtyAccepted ?? 0;
      const sibRows = await db.select({ qtyReturned: pctItemsTable.qtyReturned, returnId: pctItemsTable.purchaseConsignmentReturnId }).from(pctItemsTable).where(eq(pctItemsTable.pcReceiveItemId, receiveItemId));
      const prIds = [...new Set(sibRows.map((r) => r.returnId))];
      const cancelled = new Set<string>();
      if (prIds.length > 0) {
        const prs = await db.select({ id: pctTable.id, status: pctTable.status }).from(pctTable).where(inArray(pctTable.id, prIds));
        for (const p of prs) if (p.status === "CANCELLED") cancelled.add(p.id);
      }
      const liveReturned = sibRows.filter((r) => !cancelled.has(r.returnId)).reduce((s, r) => s + Number(r.qtyReturned ?? 0), 0);
      if (liveReturned > cap) {
        await db.delete(pctItemsTable).where(eq(pctItemsTable.id, data.id));
        return c.json({ error: "qty_exceeds_remaining", requested: qtyReturned, remaining: cap - (liveReturned - qtyReturned) }, 409);
      }
    }
  }

  if (receiveItemId) await adjustPcReceiveReturnedQty(db, receiveItemId);
  await recomputePcReturnTotals(db, prId);
  try { await resyncPcReturnInventory(db, prId, c.get("user")?.id ?? null); } catch { /* best-effort */ }
  return c.json({ item: toReturnItemResponse(data) }, 201);
});

app.patch("/:id/items/:itemId", async (c) => {
  const prId = c.req.param("id"); const itemId = c.req.param("itemId");
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: "invalid_json" }, 400); }
  const db = getDb(c.env);
  { const lock = await pcReturnLineLock(db, prId); if (lock) return c.json(lock, 409); }

  const [prev] = await db.select().from(pctItemsTable).where(eq(pctItemsTable.id, itemId)).limit(1);
  if (!prev) return c.json({ error: "not_found" }, 404);

  const prevQty = prev.qtyReturned;
  const receiveItemId = prev.pcReceiveItemId ?? null;
  const qtyReturned = it.qty !== undefined ? Number(it.qty) : prevQty;
  const unit = it.unitPriceCenti !== undefined ? Number(it.unitPriceCenti) : prev.unitPriceCenti;
  const lineRefund = qtyReturned * unit;

  const updates: Record<string, unknown> = { qtyReturned, unitPriceCenti: unit, lineRefundCenti: lineRefund };
  for (const [from, to] of [
    ["materialCode", "materialCode"], ["materialName", "materialName"],
    ["itemGroup", "itemGroup"], ["description", "description"], ["uom", "uom"],
    ["reason", "reason"], ["notes", "notes"],
    ["gapInches", "gapInches"], ["divanHeightInches", "divanHeightInches"],
    ["divanPriceSen", "divanPriceSen"], ["legHeightInches", "legHeightInches"],
    ["legPriceSen", "legPriceSen"], ["customSpecials", "customSpecials"],
    ["lineSuffix", "lineSuffix"], ["specialOrderPriceSen", "specialOrderPriceSen"],
    ["variants", "variants"], ["description2", "description2"],
  ] as const) {
    if (it[from] !== undefined) updates[to] = it[from];
  }

  const delta = qtyReturned - prevQty;
  if (receiveItemId && delta !== 0) {
    const [gi] = await db.select({ qtyAccepted: pcrItemsTable.qtyAccepted, returnedQty: pcrItemsTable.returnedQty }).from(pcrItemsTable).where(eq(pcrItemsTable.id, receiveItemId)).limit(1);
    if (gi) {
      const headroom = (gi.qtyAccepted ?? 0) - ((gi.returnedQty ?? 0) - prevQty);
      if (qtyReturned > headroom) return c.json({ error: "qty_exceeds_remaining", requested: qtyReturned, remaining: headroom }, 409);
    }
  }

  await db.update(pctItemsTable).set(updates as never).where(eq(pctItemsTable.id, itemId));
  if (receiveItemId && delta !== 0) await adjustPcReceiveReturnedQty(db, receiveItemId);
  await recomputePcReturnTotals(db, prId);
  try { await resyncPcReturnInventory(db, prId, c.get("user")?.id ?? null); } catch { /* best-effort */ }
  return c.json({ ok: true });
});

app.delete("/:id/items/:itemId", async (c) => {
  const prId = c.req.param("id"); const itemId = c.req.param("itemId");
  const db = getDb(c.env);
  { const lock = await pcReturnLineLock(db, prId); if (lock) return c.json(lock, 409); }
  const [line] = await db.select({ qtyReturned: pctItemsTable.qtyReturned, pcReceiveItemId: pctItemsTable.pcReceiveItemId }).from(pctItemsTable).where(eq(pctItemsTable.id, itemId)).limit(1);
  await db.delete(pctItemsTable).where(eq(pctItemsTable.id, itemId));
  if (line?.pcReceiveItemId) await adjustPcReceiveReturnedQty(db, line.pcReceiveItemId);
  await recomputePcReturnTotals(db, prId);
  try { await resyncPcReturnInventory(db, prId, c.get("user")?.id ?? null); } catch { /* best-effort */ }
  return c.body(null, 204);
});

export default app;
