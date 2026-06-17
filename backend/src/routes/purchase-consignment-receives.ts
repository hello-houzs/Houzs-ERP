// ----------------------------------------------------------------------------
// /purchase-consignment-receives — consignment receiving step.
// PC Order -> PC Receive -> PC Return.
//
// ON-LEDGER: a PC Receive records the arrival of the SUPPLIER'S goods at MY
// warehouse on consignment. We hold the physical stock (settlement later), so it
// books an IN into the receive's warehouse — reconciled by resyncReceiveInventory
// (self-healing on create / line CRUD / cancel).
//
// 1:1 clone of 2990s apps/api/src/routes/purchase-consignment-receives.ts (itself
// a clone of grns). Endpoints, request bodies, response JSON shapes, status
// codes, business rules (POSTED-on-create, over-receipt guard + post-insert
// verification, received_qty live-recount onto the PC ORDER, PC-order status
// re-evaluation, child-lock vs PC Returns, single self-healing inventory resync,
// cancel reversal, line CRUD) kept identical to 2990s. Only the SEAMS change:
//   - DB client 2990s createClient/c.get('supabase') -> Houzs getDb (rule #3);
//     every PostgREST chain -> a Drizzle query, snake_case wire shape via mappers
//     (rule #7). Auth -> requirePermission("*") (rule #4). user.id staff uuid ->
//     users.id integer (rule #4). Mount /api/purchase-consignment-receives.
//   - Inventory writes go through lib/inventory-movements (writeMovements /
//     defaultWarehouseId), source_doc_type 'PC_RECEIVE' (first IN per bucket) +
//     'STOCK_TRANSFER' (later deltas / cancel give-back), exactly as 2990s.
//
// Strategy-2: DROPPED buildVariantSummary (description2 passes through); variant
// columns persisted for fidelity. computeVariantKey is the generic shared one.
// ----------------------------------------------------------------------------

import { Hono } from "hono";
import { and, asc, desc, eq, gt, inArray, like, ne } from "drizzle-orm";
import type { Env } from "../types";
import { getDb } from "../db/client";
import {
  purchaseConsignmentReceives as pcrTable,
  purchaseConsignmentReceiveItems as pcrItemsTable,
  purchaseConsignmentOrders as pcoTable,
  purchaseConsignmentOrderItems as pcoItemsTable,
  purchaseConsignmentReturns as pctTable,
  purchaseConsignmentReturnItems as pctItemsTable,
  inventoryMovements as movTable,
  suppliers as suppliersTable,
} from "../db/schema";
import { requirePermission } from "../middleware/auth";
import { writeMovements, defaultWarehouseId } from "../lib/inventory-movements";
import { recomputeSoStockAllocation } from "../lib/so-stock-allocation";
import { computeVariantKey, type VariantAttrs } from "@shared/index";

const app = new Hono<{ Bindings: Env }>();
app.use("*", requirePermission("*"));

type Db = ReturnType<typeof getDb>;
type PcrHeaderRow = typeof pcrTable.$inferSelect;
type PcrItemRow = typeof pcrItemsTable.$inferSelect;

const yymm = (): string => {
  const d = new Date();
  return `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, "0")}`;
};

const nextNumber = async (db: Db, prefix: string): Promise<string> => {
  const rows = await db.select({ id: pcrTable.id }).from(pcrTable).where(like(pcrTable.receiveNumber, `${prefix}-${yymm()}-%`));
  return `${prefix}-${yymm()}-${String(rows.length + 1).padStart(3, "0")}`;
};

/* ── Shared helper: post a PC Receive + roll up to PC Order items ──────────
   Recounts received_qty onto the PC ORDER lines + flips the receive to POSTED;
   the inventory IN is then booked by resyncReceiveInventory. */
async function postPcReceiveAndRollup(db: Db, receiveId: string): Promise<{ ok: true } | { ok: false; reason: string; status?: number }> {
  const items = await db.select({ pcOrderItemId: pcrItemsTable.pcOrderItemId }).from(pcrItemsTable).where(eq(pcrItemsTable.pcReceiveId, receiveId));
  await recomputePcoReceived(db, items.map((it) => it.pcOrderItemId));

  const updated = await db
    .update(pcrTable)
    .set({ status: "POSTED", postedAt: new Date(), updatedAt: new Date() } as never)
    .where(and(eq(pcrTable.id, receiveId), ne(pcrTable.status, "CLOSED")))
    .returning({ id: pcrTable.id });
  if (updated.length === 0) return { ok: false, reason: "cannot_post", status: 409 };

  try { await resyncReceiveInventory(db, receiveId, null); } catch { /* best-effort */ }
  return { ok: true };
}

/* ── resyncReceiveInventory — self-healing IN ledger for a PC Receive ──────────
   ONE function for the whole lifecycle (post / add-line / edit-qty / delete-line
   / cancel), IN-primary. Reconciles the receive's CURRENT lines (TARGET net IN
   per product/variant bucket, all into the HEADER warehouse, batch=pc_order_no
   when linked) against what inventory_movements already record, writing only the
   DELTA: first-ever IN -> PC_RECEIVE; later increase -> STOCK_TRANSFER IN; any
   decrease/give-back -> STOCK_TRANSFER OUT; cancel -> drive every net to 0.
   Idempotent. Best-effort. */
async function resyncReceiveInventory(db: Db, receiveId: string, performedBy: number | null): Promise<string[]> {
  const [header] = await db
    .select({ receiveNumber: pcrTable.receiveNumber, status: pcrTable.status, warehouseId: pcrTable.warehouseId, pcOrderNo: pcrTable.pcOrderNo })
    .from(pcrTable)
    .where(eq(pcrTable.id, receiveId))
    .limit(1);
  if (!header) return [];
  const status = (header.status ?? "").toUpperCase();
  const receiveNo = header.receiveNumber ?? receiveId;
  const cancelled = status === "CANCELLED";

  const batchNo = header.pcOrderNo ?? null;
  const warehouseId = header.warehouseId ?? (await defaultWarehouseId(db));

  // 1. TARGET net IN per bucket = sum of current lines (empty if cancelled).
  type Bucket = { product_code: string; variant_key: string; product_name: string | null; qty: number; unit_cost_sen: number };
  const targetByBucket = new Map<string, Bucket>();
  if (!cancelled && warehouseId) {
    const lines = await db
      .select({ materialCode: pcrItemsTable.materialCode, materialName: pcrItemsTable.materialName, qtyAccepted: pcrItemsTable.qtyAccepted, unitPriceCenti: pcrItemsTable.unitPriceCenti, itemGroup: pcrItemsTable.itemGroup, variants: pcrItemsTable.variants })
      .from(pcrItemsTable)
      .where(eq(pcrItemsTable.pcReceiveId, receiveId));
    for (const it of lines) {
      const qty = Number(it.qtyAccepted ?? 0);
      if (qty <= 0) continue;
      const vk = computeVariantKey(it.itemGroup, (it.variants as VariantAttrs | null) ?? null);
      const k = `${it.materialCode}::${vk}`;
      const cur = targetByBucket.get(k);
      if (cur) cur.qty += qty;
      else targetByBucket.set(k, { product_code: it.materialCode, variant_key: vk, product_name: it.materialName, qty, unit_cost_sen: Number(it.unitPriceCenti ?? 0) });
    }
  }

  // 2. CURRENT net IN per bucket from ALL this receive's movements.
  const movs = await db
    .select({ movementType: movTable.movementType, productCode: movTable.productCode, variantKey: movTable.variantKey, qty: movTable.qty, productName: movTable.productName })
    .from(movTable)
    .where(and(eq(movTable.sourceDocId, receiveId), inArray(movTable.sourceDocType, ["PC_RECEIVE", "STOCK_TRANSFER"])));
  type Agg = { in_qty: number; out_qty: number; product_name: string | null };
  const aggByBucket = new Map<string, Agg>();
  for (const m of movs) {
    const k = `${m.productCode}::${m.variantKey ?? ""}`;
    let a = aggByBucket.get(k);
    if (!a) { a = { in_qty: 0, out_qty: 0, product_name: m.productName }; aggByBucket.set(k, a); }
    if (m.movementType === "IN") a.in_qty += Number(m.qty ?? 0);
    else if (m.movementType === "OUT") a.out_qty += Number(m.qty ?? 0);
    if (!a.product_name) a.product_name = m.productName;
  }

  // 3. delta = target − current_net_in.
  type MovOut = Parameters<typeof writeMovements>[1][number];
  const writes: MovOut[] = [];
  const pcReceiveEmitted = new Set<string>();
  for (const k of new Set<string>([...targetByBucket.keys(), ...aggByBucket.keys()])) {
    const t = targetByBucket.get(k);
    const a = aggByBucket.get(k) ?? { in_qty: 0, out_qty: 0, product_name: null };
    const delta = (t?.qty ?? 0) - (a.in_qty - a.out_qty);
    if (delta === 0) continue;
    if (!warehouseId) continue;
    const [pc, vk] = k.split("::");
    const pname = t?.product_name ?? a.product_name ?? null;
    if (delta > 0) {
      const neverMoved = a.in_qty === 0 && a.out_qty === 0;
      const usePcReceive = neverMoved && !pcReceiveEmitted.has(`${pc}::${vk}`);
      if (usePcReceive) pcReceiveEmitted.add(`${pc}::${vk}`);
      writes.push({
        movement_type: "IN", warehouse_id: warehouseId, product_code: pc ?? "", variant_key: vk ?? "", product_name: pname,
        qty: delta, unit_cost_sen: t?.unit_cost_sen ?? 0,
        source_doc_type: usePcReceive ? "PC_RECEIVE" : "STOCK_TRANSFER",
        source_doc_id: receiveId, source_doc_no: receiveNo,
        ...(batchNo ? { batch_no: batchNo } : {}),
        performed_by: performedBy,
        notes: usePcReceive ? "Consignment stock received IN" : "PC Receive resync: line qty increased / added.",
      });
    } else {
      writes.push({
        movement_type: "OUT", warehouse_id: warehouseId, product_code: pc ?? "", variant_key: vk ?? "", product_name: pname,
        qty: -delta,
        source_doc_type: "STOCK_TRANSFER",
        source_doc_id: receiveId, source_doc_no: cancelled ? `${receiveNo}-CANCEL` : receiveNo,
        ...(batchNo ? { batch_no: batchNo } : {}),
        performed_by: performedBy,
        notes: cancelled ? "PC Receive cancelled — stock out again" : "PC Receive resync: line qty reduced / deleted.",
      });
    }
  }

  if (writes.length === 0) return [];
  const res = await writeMovements(db, writes);
  try { await recomputeSoStockAllocation(db); } catch { /* best-effort */ }
  return res.ok ? [] : [res.reason ?? "PC receive inventory resync failed"];
}

/* ── Recompute PC Receive header money rollups ── */
async function recomputePcReceiveTotals(db: Db, receiveId: string) {
  const items = await db.select({ lineTotalCenti: pcrItemsTable.lineTotalCenti }).from(pcrItemsTable).where(eq(pcrItemsTable.pcReceiveId, receiveId));
  const subtotal = items.reduce((s, r) => s + (r.lineTotalCenti ?? 0), 0);
  await db.update(pcrTable).set({ subtotalCenti: subtotal, totalCenti: subtotal, updatedAt: new Date() } as never).where(eq(pcrTable.id, receiveId));
}

/* ── Post-insert over-receipt verification for BULK creates ── */
async function verifyPcReceiveOverReceipt(db: Db, receiveId: string, pcoItemIds: Array<string | null | undefined>): Promise<{ pcoItemId: string; requested: number; remaining: number } | null> {
  const ids = [...new Set(pcoItemIds.filter((x): x is string => Boolean(x)))];
  if (ids.length === 0) return null;
  try {
    const pcoItems = await db.select({ id: pcoItemsTable.id, qty: pcoItemsTable.qty }).from(pcoItemsTable).where(inArray(pcoItemsTable.id, ids));
    const capById = new Map<string, number>(pcoItems.map((r) => [r.id, r.qty ?? 0]));
    const sibRows = await db
      .select({ pcOrderItemId: pcrItemsTable.pcOrderItemId, qtyAccepted: pcrItemsTable.qtyAccepted, pcReceiveId: pcrItemsTable.pcReceiveId })
      .from(pcrItemsTable)
      .where(inArray(pcrItemsTable.pcOrderItemId, ids));
    const receiveIds = [...new Set(sibRows.map((r) => r.pcReceiveId).filter(Boolean))];
    const cancelled = new Set<string>();
    if (receiveIds.length > 0) {
      const gs = await db.select({ id: pcrTable.id, status: pcrTable.status }).from(pcrTable).where(inArray(pcrTable.id, receiveIds));
      for (const g of gs) if (g.status === "CANCELLED") cancelled.add(g.id);
    }
    const liveByPcoi = new Map<string, number>();
    const thisReceiveByPcoi = new Map<string, number>();
    for (const r of sibRows) {
      if (!r.pcOrderItemId || cancelled.has(r.pcReceiveId)) continue;
      const q = Number(r.qtyAccepted ?? 0);
      liveByPcoi.set(r.pcOrderItemId, (liveByPcoi.get(r.pcOrderItemId) ?? 0) + q);
      if (r.pcReceiveId === receiveId) thisReceiveByPcoi.set(r.pcOrderItemId, (thisReceiveByPcoi.get(r.pcOrderItemId) ?? 0) + q);
    }
    for (const pcoiId of ids) {
      const cap = capById.get(pcoiId) ?? 0;
      const live = liveByPcoi.get(pcoiId) ?? 0;
      if (live > cap) {
        const mine = thisReceiveByPcoi.get(pcoiId) ?? 0;
        return { pcoItemId: pcoiId, requested: mine, remaining: cap - (live - mine) };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/* ── Self-heal PC Order receipt counter (live-count model) ── */
export async function recomputePcoReceived(db: Db, pcoItemIds: Array<string | null | undefined>) {
  const ids = [...new Set(pcoItemIds.filter((x): x is string => Boolean(x)))];
  if (ids.length === 0) return;
  try {
    const rows = await db
      .select({ pcOrderItemId: pcrItemsTable.pcOrderItemId, qtyAccepted: pcrItemsTable.qtyAccepted, returnedQty: pcrItemsTable.returnedQty, pcReceiveId: pcrItemsTable.pcReceiveId })
      .from(pcrItemsTable)
      .where(inArray(pcrItemsTable.pcOrderItemId, ids));
    const receiveIds = [...new Set(rows.map((r) => r.pcReceiveId).filter(Boolean))];
    const cancelled = new Set<string>();
    if (receiveIds.length > 0) {
      const gs = await db.select({ id: pcrTable.id, status: pcrTable.status }).from(pcrTable).where(inArray(pcrTable.id, receiveIds));
      for (const g of gs) if (g.status === "CANCELLED") cancelled.add(g.id);
    }
    const recvByPcoi = new Map<string, number>(ids.map((id) => [id, 0]));
    for (const r of rows) {
      if (!r.pcOrderItemId || cancelled.has(r.pcReceiveId)) continue;
      const net = Number(r.qtyAccepted ?? 0) - Number(r.returnedQty ?? 0);
      recvByPcoi.set(r.pcOrderItemId, (recvByPcoi.get(r.pcOrderItemId) ?? 0) + Math.max(0, net));
    }
    await Promise.all([...recvByPcoi.entries()].map(([pcoiId, recv]) =>
      db.update(pcoItemsTable).set({ receivedQty: recv } as never).where(eq(pcoItemsTable.id, pcoiId)),
    ));

    const pcoiRows = await db.select({ pcoId: pcoItemsTable.purchaseConsignmentOrderId }).from(pcoItemsTable).where(inArray(pcoItemsTable.id, ids));
    const pcoIds = [...new Set(pcoiRows.map((r) => r.pcoId).filter(Boolean))];
    for (const pcoId of pcoIds) {
      const ll = await db.select({ qty: pcoItemsTable.qty, receivedQty: pcoItemsTable.receivedQty }).from(pcoItemsTable).where(eq(pcoItemsTable.purchaseConsignmentOrderId, pcoId));
      if (ll.length === 0) continue;
      const anyReceived = ll.some((l) => (l.receivedQty ?? 0) > 0);
      const fully = ll.every((l) => (l.receivedQty ?? 0) >= l.qty);
      const newStatus: "RECEIVED" | "PARTIALLY_RECEIVED" | "SUBMITTED" = fully ? "RECEIVED" : anyReceived ? "PARTIALLY_RECEIVED" : "SUBMITTED";
      const [head] = await db.select({ receivedAt: pcoTable.receivedAt }).from(pcoTable).where(eq(pcoTable.id, pcoId)).limit(1);
      const prevReceivedAt = head?.receivedAt ?? null;
      await db
        .update(pcoTable)
        .set({ status: newStatus, updatedAt: new Date(), receivedAt: fully ? (prevReceivedAt ?? new Date()) : null } as never)
        .where(and(eq(pcoTable.id, pcoId), ne(pcoTable.status, "CANCELLED")));
    }
  } catch (e) {
    console.error("[recomputePcoReceived] best-effort recount failed", { pcoItemIds: ids, error: e });
  }
}

/* ── PC Receive child-lock guard (any line with returned_qty > 0). ── */
async function pcReceiveHasDownstream(db: Db, receiveId: string): Promise<{ error: string; message: string } | null> {
  const rows = await db.select({ returnedQty: pcrItemsTable.returnedQty }).from(pcrItemsTable).where(eq(pcrItemsTable.pcReceiveId, receiveId));
  if (rows.some((r) => (r.returnedQty ?? 0) > 0)) return { error: "pc_receive_has_downstream", message: "Receive has a Consignment Return — delete it first to edit" };
  return null;
}

/* ── Per-PC-receive consumption flags. ── */
function computePcReceiveFlags(items: Array<{ qty_accepted?: number | null; returned_qty?: number | null }>) {
  const accepted = items.filter((r) => (r.qty_accepted ?? 0) > 0);
  const hasChildren = items.some((r) => (r.returned_qty ?? 0) > 0);
  const fullyReturned = accepted.length > 0 && accepted.every((r) => (r.returned_qty ?? 0) >= (r.qty_accepted ?? 0));
  return { has_children: hasChildren, fully_returned: fullyReturned };
}

async function suppliersByIds(db: Db, ids: string[]): Promise<Map<string, { id: string; code: string; name: string }>> {
  const out = new Map<string, { id: string; code: string; name: string }>();
  const uniq = [...new Set(ids.filter(Boolean))];
  if (uniq.length === 0) return out;
  const rows = await db.select({ id: suppliersTable.id, code: suppliersTable.code, name: suppliersTable.name }).from(suppliersTable).where(inArray(suppliersTable.id, uniq));
  for (const r of rows) out.set(r.id, { id: r.id, code: r.code, name: r.name });
  return out;
}

function toReceiveResponse(r: PcrHeaderRow, supplier?: { id: string; code: string; name: string } | null, pco?: { id: string; pc_number: string } | null) {
  return {
    id: r.id,
    receive_number: r.receiveNumber,
    purchase_consignment_order_id: r.purchaseConsignmentOrderId,
    pc_order_no: r.pcOrderNo,
    supplier_id: r.supplierId,
    received_at: r.receivedAt,
    delivery_note_ref: r.deliveryNoteRef,
    status: r.status,
    notes: r.notes,
    warehouse_id: r.warehouseId,
    currency: r.currency,
    subtotal_centi: r.subtotalCenti,
    tax_centi: r.taxCenti,
    total_centi: r.totalCenti,
    posted_at: r.postedAt,
    created_at: r.createdAt,
    created_by: r.createdBy,
    updated_at: r.updatedAt,
    ...(supplier !== undefined ? { supplier } : {}),
    ...(pco !== undefined ? { purchase_consignment_order: pco } : {}),
  };
}

function toReceiveItemResponse(r: PcrItemRow) {
  return {
    id: r.id,
    pc_receive_id: r.pcReceiveId,
    pc_order_item_id: r.pcOrderItemId,
    material_kind: r.materialKind,
    material_code: r.materialCode,
    material_name: r.materialName,
    supplier_sku: r.supplierSku,
    qty_received: r.qtyReceived,
    qty_accepted: r.qtyAccepted,
    qty_rejected: r.qtyRejected,
    rejection_reason: r.rejectionReason,
    unit_price_centi: r.unitPriceCenti,
    notes: r.notes,
    item_group: r.itemGroup,
    description: r.description,
    description2: r.description2,
    uom: r.uom,
    discount_centi: r.discountCenti,
    variants: r.variants,
    gap_inches: r.gapInches,
    divan_height_inches: r.divanHeightInches,
    divan_price_sen: r.divanPriceSen,
    leg_height_inches: r.legHeightInches,
    leg_price_sen: r.legPriceSen,
    custom_specials: r.customSpecials,
    line_suffix: r.lineSuffix,
    special_order_price_sen: r.specialOrderPriceSen,
    line_total_centi: r.lineTotalCenti,
    delivery_date: r.deliveryDate,
    unit_cost_centi: r.unitCostCenti,
    invoiced_qty: r.invoicedQty,
    returned_qty: r.returnedQty,
    rack_id: r.rackId,
    created_at: r.createdAt,
  };
}

// ── List ──────────────────────────────────────────────────────────────
app.get("/", async (c) => {
  const db = getDb(c.env);
  const status = c.req.query("status");
  const supplierId = c.req.query("supplierId");
  const conds = [] as ReturnType<typeof eq>[];
  if (status) conds.push(eq(pcrTable.status, status as PcrHeaderRow["status"]));
  if (supplierId) conds.push(eq(pcrTable.supplierId, supplierId));

  const rows = await db.select().from(pcrTable).where(conds.length ? and(...conds) : undefined).orderBy(desc(pcrTable.receivedAt));
  const supMap = await suppliersByIds(db, rows.map((r) => r.supplierId));
  const pcoIds = [...new Set(rows.map((r) => r.purchaseConsignmentOrderId).filter((x): x is string => !!x))];
  const pcoMap = new Map<string, { id: string; pc_number: string }>();
  if (pcoIds.length > 0) {
    const pcos = await db.select({ id: pcoTable.id, pcNumber: pcoTable.pcNumber }).from(pcoTable).where(inArray(pcoTable.id, pcoIds));
    for (const p of pcos) pcoMap.set(p.id, { id: p.id, pc_number: p.pcNumber });
  }

  const ids = rows.map((g) => g.id);
  const linesByReceive = new Map<string, Array<{ qty_accepted: number | null; returned_qty: number | null }>>();
  if (ids.length > 0) {
    const lineRows = await db.select({ pcReceiveId: pcrItemsTable.pcReceiveId, qtyAccepted: pcrItemsTable.qtyAccepted, returnedQty: pcrItemsTable.returnedQty }).from(pcrItemsTable).where(inArray(pcrItemsTable.pcReceiveId, ids));
    for (const li of lineRows) {
      const arr = linesByReceive.get(li.pcReceiveId) ?? [];
      arr.push({ qty_accepted: li.qtyAccepted, returned_qty: li.returnedQty });
      linesByReceive.set(li.pcReceiveId, arr);
    }
  }
  const receives = rows.map((g) => ({
    ...toReceiveResponse(g, supMap.get(g.supplierId) ?? null, g.purchaseConsignmentOrderId ? (pcoMap.get(g.purchaseConsignmentOrderId) ?? null) : null),
    total_centi: g.totalCenti ?? 0,
    ...computePcReceiveFlags(linesByReceive.get(g.id) ?? []),
  }));
  return c.json({ grns: receives });
});

/* ── GET /outstanding-pco-items + /outstanding-order-lines — From-Order pickers.
   MUST precede /:id so the static paths aren't read as ids. ── */
app.get("/outstanding-pco-items", async (c) => {
  const db = getDb(c.env);
  const items = await db
    .select()
    .from(pcoItemsTable)
    .orderBy(desc(pcoItemsTable.purchaseConsignmentOrderId))
    .limit(500);
  const pcoIds = [...new Set(items.map((it) => it.purchaseConsignmentOrderId))];
  const pcoRows = pcoIds.length ? await db.select().from(pcoTable).where(inArray(pcoTable.id, pcoIds)) : [];
  const pcoById = new Map(pcoRows.map((p) => [p.id, p]));
  const supMap = await suppliersByIds(db, pcoRows.map((p) => p.supplierId));

  const outstanding = items
    .map((r) => {
      const pco = pcoById.get(r.purchaseConsignmentOrderId);
      if (!pco) return null;
      if (pco.status !== "SUBMITTED" && pco.status !== "PARTIALLY_RECEIVED") return null;
      if (r.qty - (r.receivedQty ?? 0) <= 0) return null;
      const sup = supMap.get(pco.supplierId) ?? null;
      return {
        pcoItemId: r.id,
        pcoId: pco.id,
        pcoDocNo: pco.pcNumber,
        itemCode: r.materialCode,
        description: r.description ?? r.materialName,
        itemGroup: r.itemGroup ?? "",
        qty: r.qty,
        receivedQty: r.receivedQty ?? 0,
        remainingQty: r.qty - (r.receivedQty ?? 0),
        unitPriceCenti: r.unitPriceCenti,
        warehouseId: r.warehouseId,
        variants: r.variants,
        deliveryDate: r.deliveryDate ?? null,
        supplierId: pco.supplierId,
        supplierCode: sup?.code ?? "",
        supplierName: sup?.name ?? "",
        poDate: pco.poDate,
        expectedAt: pco.expectedAt,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  return c.json({ items: outstanding });
});

app.get("/outstanding-order-lines", async (c) => {
  const db = getDb(c.env);
  const orders = await db
    .select({ id: pcoTable.id, pcNumber: pcoTable.pcNumber, supplierId: pcoTable.supplierId, status: pcoTable.status })
    .from(pcoTable)
    .where(ne(pcoTable.status, "CANCELLED"))
    .orderBy(desc(pcoTable.pcNumber))
    .limit(1000);
  if (orders.length === 0) return c.json({ lines: [] });
  const orderById = new Map(orders.map((o) => [o.id, o]));
  const orderIds = orders.map((o) => o.id);
  const supMap = await suppliersByIds(db, orders.map((o) => o.supplierId).filter((x): x is string => !!x));

  const items = await db.select().from(pcoItemsTable).where(inArray(pcoItemsTable.purchaseConsignmentOrderId, orderIds));
  const lines = items
    .map((it) => {
      const o = orderById.get(it.purchaseConsignmentOrderId);
      const ordered = Number(it.qty ?? 0);
      const received = Number(it.receivedQty ?? 0);
      return {
        orderItemId: it.id,
        purchaseConsignmentOrderId: it.purchaseConsignmentOrderId,
        pcNumber: o?.pcNumber ?? "",
        supplierId: o?.supplierId ?? null,
        supplierName: o?.supplierId ? (supMap.get(o.supplierId)?.name ?? null) : null,
        materialKind: it.materialKind ?? "OTHER",
        materialCode: it.materialCode,
        materialName: it.materialName ?? "",
        supplierSku: it.supplierSku ?? null,
        itemGroup: it.itemGroup ?? null,
        description: it.description ?? null,
        uom: it.uom ?? null,
        ordered,
        received,
        outstanding: ordered - received,
        unitPriceCenti: Number(it.unitPriceCenti ?? 0),
        variants: it.variants ?? null,
      };
    })
    .filter((l) => l.outstanding > 0);
  return c.json({ lines });
});

/* Per-receive-line downstream breakdown — the PC Returns each receive item was
   carried into (cancelled PRs excluded). Read-only display aid. */
export async function pcReceiveLineDownstream(db: Db, receiveItemIds: string[]): Promise<Map<string, Array<{ docNumber: string; docType: "PR"; qty: number; status: string }>>> {
  const out = new Map<string, Array<{ docNumber: string; docType: "PR"; qty: number; status: string }>>();
  const ids = [...new Set(receiveItemIds.filter((x): x is string => Boolean(x)))];
  if (ids.length === 0) return out;
  const prLines = await db
    .select({ pcReceiveItemId: pctItemsTable.pcReceiveItemId, qtyReturned: pctItemsTable.qtyReturned, returnId: pctItemsTable.purchaseConsignmentReturnId })
    .from(pctItemsTable)
    .where(inArray(pctItemsTable.pcReceiveItemId, ids));
  const prIds = [...new Set(prLines.map((r) => r.returnId).filter(Boolean))];
  if (prIds.length === 0) return out;
  const prHeads = await db.select({ id: pctTable.id, returnNumber: pctTable.returnNumber, status: pctTable.status }).from(pctTable).where(inArray(pctTable.id, prIds));
  const prMeta = new Map<string, { docNumber: string; status: string }>();
  for (const p of prHeads) {
    if ((p.status ?? "").toUpperCase() === "CANCELLED") continue;
    prMeta.set(p.id, { docNumber: p.returnNumber ?? "—", status: (p.status ?? "").toUpperCase() });
  }
  for (const r of prLines) {
    if (!r.pcReceiveItemId) continue;
    const meta = prMeta.get(r.returnId);
    if (!meta) continue;
    const arr = out.get(r.pcReceiveItemId) ?? [];
    arr.push({ docNumber: meta.docNumber, docType: "PR", qty: Number(r.qtyReturned ?? 0), status: meta.status });
    out.set(r.pcReceiveItemId, arr);
  }
  return out;
}

// ── Detail ────────────────────────────────────────────────────────────
app.get("/:id", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const [h] = await db.select().from(pcrTable).where(eq(pcrTable.id, id)).limit(1);
  if (!h) return c.json({ error: "not_found" }, 404);
  const supMap = await suppliersByIds(db, [h.supplierId]);
  const pco = h.purchaseConsignmentOrderId
    ? (await db.select({ id: pcoTable.id, pcNumber: pcoTable.pcNumber }).from(pcoTable).where(eq(pcoTable.id, h.purchaseConsignmentOrderId)).limit(1))[0]
    : undefined;

  const lineItems = await db.select().from(pcrItemsTable).where(eq(pcrItemsTable.pcReceiveId, id)).orderBy(asc(pcrItemsTable.createdAt));
  const receive = {
    ...toReceiveResponse(h, supMap.get(h.supplierId) ?? null, pco ? { id: pco.id, pc_number: pco.pcNumber } : null),
    ...computePcReceiveFlags(lineItems.map((it) => ({ qty_accepted: it.qtyAccepted, returned_qty: it.returnedQty }))),
  };

  const pcoItemIds = [...new Set(lineItems.map((it) => it.pcOrderItemId).filter((x): x is string => Boolean(x)))];
  const pcoNoByItemId = new Map<string, string>();
  const downstreamMap = await pcReceiveLineDownstream(db, lineItems.map((it) => it.id));
  if (pcoItemIds.length > 0) {
    const pcoiRows = await db.select({ id: pcoItemsTable.id, pcoId: pcoItemsTable.purchaseConsignmentOrderId }).from(pcoItemsTable).where(inArray(pcoItemsTable.id, pcoItemIds));
    const innerPcoIds = [...new Set(pcoiRows.map((r) => r.pcoId))];
    const pcoHeads = innerPcoIds.length ? await db.select({ id: pcoTable.id, pcNumber: pcoTable.pcNumber }).from(pcoTable).where(inArray(pcoTable.id, innerPcoIds)) : [];
    const pcNoById = new Map(pcoHeads.map((p) => [p.id, p.pcNumber]));
    for (const r of pcoiRows) { const n = pcNoById.get(r.pcoId); if (n) pcoNoByItemId.set(r.id, n); }
  }
  const items = lineItems.map((it) => ({
    ...toReceiveItemResponse(it),
    source_pco_number: it.pcOrderItemId ? (pcoNoByItemId.get(it.pcOrderItemId) ?? null) : null,
    received_at: h.receivedAt,
    downstream: downstreamMap.get(it.id) ?? [],
  }));
  return c.json({ grn: receive, items });
});

// ── Linked docs ──────────────────────────────────────────────────────
app.get("/:id/linked", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const [recv] = await db.select({ id: pcrTable.id, pcoId: pcrTable.purchaseConsignmentOrderId }).from(pcrTable).where(eq(pcrTable.id, id)).limit(1);
  if (!recv) return c.json({ error: "not_found" }, 404);
  const pco = recv.pcoId ? (await db.select({ id: pcoTable.id, pcNumber: pcoTable.pcNumber }).from(pcoTable).where(eq(pcoTable.id, recv.pcoId)).limit(1))[0] : null;
  const returns = await db
    .select({ id: pctTable.id, return_number: pctTable.returnNumber, status: pctTable.status, return_date: pctTable.returnDate })
    .from(pctTable)
    .where(eq(pctTable.pcReceiveId, id))
    .orderBy(desc(pctTable.returnDate));
  return c.json({ purchaseConsignmentOrder: pco ? { id: pco.id, pc_number: pco.pcNumber } : null, returns });
});

// ── Create ────────────────────────────────────────────────────────────
app.post("/", async (c) => {
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: "invalid_json" }, 400); }
  if (body.status === "DRAFT") return c.json({ error: "draft_status_not_supported", message: "Consignment receives post immediately on create." }, 400);
  if (!body.supplierId) return c.json({ error: "supplier_required" }, 400);
  const items = body.items as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(items) || !items.length) return c.json({ error: "items_required" }, 400);

  const db = getDb(c.env); const user = c.get("user");

  // Over-receipt guard (PC-order-linked lines).
  {
    const acceptedByPcoItem = new Map<string, number>();
    for (const it of items) {
      const pcoItemId = (it.pcOrderItemId as string | undefined) ?? null;
      if (!pcoItemId) continue;
      const accepted = Number(it.qtyAccepted ?? it.qtyReceived ?? 0);
      acceptedByPcoItem.set(pcoItemId, (acceptedByPcoItem.get(pcoItemId) ?? 0) + accepted);
    }
    if (acceptedByPcoItem.size > 0) {
      const pcoItems = await db.select({ id: pcoItemsTable.id, qty: pcoItemsTable.qty, receivedQty: pcoItemsTable.receivedQty }).from(pcoItemsTable).where(inArray(pcoItemsTable.id, [...acceptedByPcoItem.keys()]));
      const remByPcoItem = new Map<string, number>(pcoItems.map((r) => [r.id, (r.qty ?? 0) - (r.receivedQty ?? 0)]));
      for (const [pcoItemId, accepted] of acceptedByPcoItem) {
        const remaining = remByPcoItem.get(pcoItemId) ?? 0;
        if (accepted > remaining) return c.json({ error: "qty_exceeds_remaining", pcoItemId, requested: accepted, remaining }, 409);
      }
    }
  }

  const receiveNumber = await nextNumber(db, "PCR");
  const pcOrderId = (body.purchaseConsignmentOrderId as string | undefined) ?? null;
  let pcOrderNo: string | null = null;
  if (pcOrderId) {
    const [pcoHead] = await db.select({ pcNumber: pcoTable.pcNumber }).from(pcoTable).where(eq(pcoTable.id, pcOrderId)).limit(1);
    pcOrderNo = pcoHead?.pcNumber ?? null;
  }

  const [header] = await db
    .insert(pcrTable)
    .values({
      receiveNumber,
      purchaseConsignmentOrderId: pcOrderId,
      pcOrderNo,
      supplierId: body.supplierId as string,
      receivedAt: (body.receivedAt as string) ?? new Date().toISOString().slice(0, 10),
      deliveryNoteRef: (body.deliveryNoteRef as string) ?? null,
      notes: (body.notes as string) ?? null,
      warehouseId: (body.warehouseId as string | undefined) ?? null,
      status: "POSTED",
      postedAt: new Date(),
      createdBy: user?.id ?? null,
    } as never)
    .returning();
  const h = header as PcrHeaderRow;

  const rows = items.map((it) => {
    const qtyReceived = Number(it.qtyReceived ?? 0);
    const unitPriceCenti = Number(it.unitPriceCenti ?? 0);
    const discountCenti = Number(it.discountCenti ?? 0);
    return {
      pcReceiveId: h.id,
      pcOrderItemId: (it.pcOrderItemId as string | undefined) ?? null,
      materialKind: it.materialKind as PcrItemRow["materialKind"],
      materialCode: it.materialCode as string,
      materialName: it.materialName as string,
      supplierSku: (it.supplierSku as string | undefined) ?? null,
      qtyReceived,
      qtyAccepted: Number(it.qtyAccepted ?? it.qtyReceived ?? 0),
      qtyRejected: Number(it.qtyRejected ?? 0),
      rejectionReason: (it.rejectionReason as string | undefined) ?? null,
      unitPriceCenti,
      discountCenti,
      lineTotalCenti: qtyReceived * unitPriceCenti - discountCenti,
      deliveryDate: (it.deliveryDate as string | undefined) ?? null,
      unitCostCenti: Number(it.unitCostCenti ?? 0),
      notes: (it.notes as string | undefined) ?? null,
      itemGroup: (it.itemGroup as string | undefined) ?? null,
      variants: (it.variants as unknown) ?? null,
      description: (it.description as string | undefined) ?? null,
      description2: (it.description2 as string | undefined) ?? null,
      rackId: (it.rackId as string | undefined) || null,
    };
  });
  try {
    await db.insert(pcrItemsTable).values(rows as never);
  } catch (e) {
    await db.delete(pcrTable).where(eq(pcrTable.id, h.id));
    return c.json({ error: "items_insert_failed", reason: e instanceof Error ? e.message : String(e) }, 500);
  }

  {
    const over = await verifyPcReceiveOverReceipt(db, h.id, items.map((it) => (it.pcOrderItemId as string | undefined) ?? null));
    if (over) {
      await db.delete(pcrItemsTable).where(eq(pcrItemsTable.pcReceiveId, h.id));
      await db.delete(pcrTable).where(eq(pcrTable.id, h.id));
      return c.json({ error: "qty_exceeds_remaining", pcoItemId: over.pcoItemId, requested: over.requested, remaining: over.remaining }, 409);
    }
  }

  await postPcReceiveAndRollup(db, h.id);
  await recomputePcReceiveTotals(db, h.id);
  return c.json({ id: h.id, grnNumber: h.receiveNumber }, 201);
});

// ── POST /from-pcos ─────────────────────────────────────────────────────
app.post("/from-pcos", async (c) => {
  const db = getDb(c.env); const user = c.get("user");
  let body: { purchaseConsignmentOrderIds?: string[]; deliveryNoteRef?: string; notes?: string; warehouseId?: string };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: "invalid_json" }, 400); }
  const pcoIds = body.purchaseConsignmentOrderIds ?? [];
  if (pcoIds.length === 0) return c.json({ error: "pco_ids_required" }, 400);

  const pcoList = await db.select({ id: pcoTable.id, pcNumber: pcoTable.pcNumber, supplierId: pcoTable.supplierId, status: pcoTable.status }).from(pcoTable).where(inArray(pcoTable.id, pcoIds));
  if (pcoList.length === 0) return c.json({ error: "pcos_not_found" }, 404);
  const supplierIds = new Set(pcoList.map((p) => p.supplierId));
  if (supplierIds.size > 1) return c.json({ error: "mixed_suppliers", message: "All selected PC Orders must be from the same supplier" }, 400);
  const supplierId = [...supplierIds][0]!;

  const allItems = await db.select().from(pcoItemsTable).where(inArray(pcoItemsTable.purchaseConsignmentOrderId, pcoIds));
  const itemList = allItems.filter((it) => it.qty - (it.receivedQty ?? 0) > 0);
  if (itemList.length === 0) return c.json({ error: "nothing_outstanding", message: "All PC Order items are already fully received" }, 400);

  const receiveNumber = await nextNumber(db, "PCR");
  const pcoNumbersJoined = pcoList.map((p) => p.pcNumber).join(", ");
  const [header] = await db
    .insert(pcrTable)
    .values({
      receiveNumber,
      purchaseConsignmentOrderId: pcoList[0]!.id,
      pcOrderNo: pcoList[0]!.pcNumber,
      supplierId,
      receivedAt: new Date().toISOString().slice(0, 10),
      deliveryNoteRef: body.deliveryNoteRef ?? null,
      notes: `Batch-converted from ${pcoList.length} PC Orders: ${pcoNumbersJoined}${body.notes ? ` · ${body.notes}` : ""}`,
      warehouseId: body.warehouseId ?? null,
      status: "POSTED",
      postedAt: new Date(),
      createdBy: user?.id ?? null,
    } as never)
    .returning();
  const h = header as PcrHeaderRow;

  const rows = itemList.map((it) => {
    const qtyReceived = it.qty - (it.receivedQty ?? 0);
    const discountCenti = it.discountCenti ?? 0;
    return {
      pcReceiveId: h.id,
      pcOrderItemId: it.id,
      materialKind: it.materialKind,
      materialCode: it.materialCode,
      materialName: it.materialName,
      qtyReceived,
      qtyAccepted: qtyReceived,
      qtyRejected: 0,
      unitPriceCenti: it.unitPriceCenti,
      lineTotalCenti: qtyReceived * it.unitPriceCenti - discountCenti,
      unitCostCenti: it.unitCostCenti ?? 0,
      itemGroup: it.itemGroup ?? null,
      description: it.description ?? null,
      description2: it.description2 ?? null,
      uom: it.uom ?? "UNIT",
      variants: it.variants ?? null,
      gapInches: it.gapInches ?? null,
      divanHeightInches: it.divanHeightInches ?? null,
      divanPriceSen: it.divanPriceSen ?? 0,
      legHeightInches: it.legHeightInches ?? null,
      legPriceSen: it.legPriceSen ?? 0,
      customSpecials: it.customSpecials ?? null,
      lineSuffix: it.lineSuffix ?? null,
      specialOrderPriceSen: it.specialOrderPriceSen ?? 0,
      discountCenti,
      deliveryDate: it.deliveryDate ?? null,
    };
  });
  try {
    await db.insert(pcrItemsTable).values(rows as never);
  } catch (e) {
    await db.delete(pcrTable).where(eq(pcrTable.id, h.id));
    return c.json({ error: "items_insert_failed", reason: e instanceof Error ? e.message : String(e) }, 500);
  }

  {
    const over = await verifyPcReceiveOverReceipt(db, h.id, itemList.map((it) => it.id));
    if (over) {
      await db.delete(pcrItemsTable).where(eq(pcrItemsTable.pcReceiveId, h.id));
      await db.delete(pcrTable).where(eq(pcrTable.id, h.id));
      return c.json({ error: "qty_exceeds_remaining", pcoItemId: over.pcoItemId, requested: over.requested, remaining: over.remaining }, 409);
    }
  }

  await postPcReceiveAndRollup(db, h.id);
  await recomputePcReceiveTotals(db, h.id);
  return c.json({ id: h.id, grnNumber: h.receiveNumber, pcoCount: pcoList.length, lineCount: itemList.length }, 201);
});

app.patch("/:id/post", async (c) => {
  const db = getDb(c.env); const id = c.req.param("id");
  const [cur] = await db.select({ id: pcrTable.id, status: pcrTable.status, postedAt: pcrTable.postedAt }).from(pcrTable).where(eq(pcrTable.id, id)).limit(1);
  if (!cur) return c.json({ error: "not_found" }, 404);
  if (cur.status === "POSTED") return c.json({ receive: cur });
  const res = await postPcReceiveAndRollup(db, id);
  if (!res.ok) return c.json({ error: "post_failed", reason: res.reason }, 500);
  const [data] = await db.select({ id: pcrTable.id, status: pcrTable.status, postedAt: pcrTable.postedAt }).from(pcrTable).where(eq(pcrTable.id, id)).limit(1);
  return c.json({ receive: data });
});

/* ── PATCH /:id/cancel — cancel a PC Receive + reverse inventory. ── */
app.patch("/:id/cancel", async (c) => {
  const id = c.req.param("id");
  const db = getDb(c.env);
  const [cur] = await db.select({ id: pcrTable.id, status: pcrTable.status, receiveNumber: pcrTable.receiveNumber }).from(pcrTable).where(eq(pcrTable.id, id)).limit(1);
  if (!cur) return c.json({ error: "not_found" }, 404);
  if (cur.status === "CANCELLED") {
    const [data] = await db.select().from(pcrTable).where(eq(pcrTable.id, id)).limit(1);
    return c.json({ receive: data ? toReceiveResponse(data) : { id, status: "CANCELLED" } });
  }

  const childLock = await pcReceiveHasDownstream(db, id);
  if (childLock) return c.json(childLock, 409);

  const lineList = await db.select({ pcOrderItemId: pcrItemsTable.pcOrderItemId }).from(pcrItemsTable).where(eq(pcrItemsTable.pcReceiveId, id));

  const updRow = await db.update(pcrTable).set({ status: "CANCELLED", updatedAt: new Date() } as never).where(and(eq(pcrTable.id, id), ne(pcrTable.status, "CANCELLED"))).returning({ id: pcrTable.id });
  if (updRow.length === 0) {
    const [data] = await db.select().from(pcrTable).where(eq(pcrTable.id, id)).limit(1);
    return c.json({ receive: data ? toReceiveResponse(data) : { id, status: "CANCELLED" } });
  }

  try { await recomputePcoReceived(db, lineList.map((it) => it.pcOrderItemId)); } catch { /* best-effort */ }
  try { await resyncReceiveInventory(db, id, c.get("user")?.id ?? null); } catch (e) { console.error("[pc-receive] cancel reversal failed:", e); }

  const [data] = await db.select().from(pcrTable).where(eq(pcrTable.id, id)).limit(1);
  return c.json({ receive: data ? toReceiveResponse(data) : { id, status: "CANCELLED" } });
});

/* ── PATCH /:id — header update ── */
app.patch("/:id", async (c) => {
  const id = c.req.param("id");
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: "invalid_json" }, 400); }
  const db = getDb(c.env);
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  for (const [from, to] of [
    ["supplierId", "supplierId"], ["receivedAt", "receivedAt"],
    ["deliveryNoteRef", "deliveryNoteRef"], ["notes", "notes"], ["currency", "currency"],
  ] as const) {
    if (body[from] !== undefined) updates[to] = body[from];
  }
  const [data] = await db.update(pcrTable).set(updates as never).where(eq(pcrTable.id, id)).returning();
  if (!data) return c.json({ error: "not_found" }, 404);
  return c.json({ receive: toReceiveResponse(data) });
});

/* ── POST /:id/items — add one receive_item. qty maps to qty_received. ── */
app.post("/:id/items", async (c) => {
  const receiveId = c.req.param("id");
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: "invalid_json" }, 400); }
  if (!it.materialCode) return c.json({ error: "material_code_required" }, 400);
  if (!it.materialName) return c.json({ error: "material_name_required" }, 400);

  const db = getDb(c.env);
  const childLock = await pcReceiveHasDownstream(db, receiveId);
  if (childLock) return c.json(childLock, 409);

  const qtyReceived = Number(it.qty ?? 1);
  const unitPriceCenti = Number(it.unitPriceCenti ?? 0);
  const discountCenti = Number(it.discountCenti ?? 0);
  const lineTotal = qtyReceived * unitPriceCenti - discountCenti;

  const addLinePcoItemId = (it.pcOrderItemId as string) ?? null;
  if (addLinePcoItemId) {
    const [pcoItem] = await db.select({ qty: pcoItemsTable.qty, receivedQty: pcoItemsTable.receivedQty }).from(pcoItemsTable).where(eq(pcoItemsTable.id, addLinePcoItemId)).limit(1);
    if (pcoItem) {
      const remaining = (pcoItem.qty ?? 0) - (pcoItem.receivedQty ?? 0);
      if (qtyReceived > remaining) return c.json({ error: "qty_exceeds_remaining", pcoItemId: addLinePcoItemId, requested: qtyReceived, remaining }, 409);
    }
  }

  const [data] = await db
    .insert(pcrItemsTable)
    .values({
      pcReceiveId: receiveId,
      pcOrderItemId: addLinePcoItemId,
      materialKind: ((it.materialKind as string) ?? "mfg_product") as PcrItemRow["materialKind"],
      materialCode: it.materialCode as string,
      materialName: it.materialName as string,
      supplierSku: (it.supplierSku as string) ?? null,
      qtyReceived,
      qtyAccepted: qtyReceived,
      qtyRejected: 0,
      unitPriceCenti,
      discountCenti,
      lineTotalCenti: lineTotal,
      unitCostCenti: Number(it.unitCostCenti ?? 0),
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
      deliveryDate: (it.deliveryDate as string) ?? null,
    } as never)
    .returning();

  if (addLinePcoItemId) {
    const [pcoItem] = await db.select({ qty: pcoItemsTable.qty }).from(pcoItemsTable).where(eq(pcoItemsTable.id, addLinePcoItemId)).limit(1);
    if (pcoItem) {
      const cap = pcoItem.qty ?? 0;
      const sibRows = await db.select({ qtyAccepted: pcrItemsTable.qtyAccepted, pcReceiveId: pcrItemsTable.pcReceiveId }).from(pcrItemsTable).where(eq(pcrItemsTable.pcOrderItemId, addLinePcoItemId));
      const receiveIds = [...new Set(sibRows.map((r) => r.pcReceiveId))];
      const cancelled = new Set<string>();
      if (receiveIds.length > 0) {
        const gs = await db.select({ id: pcrTable.id, status: pcrTable.status }).from(pcrTable).where(inArray(pcrTable.id, receiveIds));
        for (const g of gs) if (g.status === "CANCELLED") cancelled.add(g.id);
      }
      const liveAccepted = sibRows.filter((r) => !cancelled.has(r.pcReceiveId)).reduce((s, r) => s + Number(r.qtyAccepted ?? 0), 0);
      if (liveAccepted > cap) {
        await db.delete(pcrItemsTable).where(eq(pcrItemsTable.id, data.id));
        return c.json({ error: "qty_exceeds_remaining", pcoItemId: addLinePcoItemId, requested: qtyReceived, remaining: cap - (liveAccepted - qtyReceived) }, 409);
      }
    }
  }

  await recomputePcReceiveTotals(db, receiveId);
  try { await recomputePcoReceived(db, [addLinePcoItemId]); } catch { /* best-effort */ }
  try { await resyncReceiveInventory(db, receiveId, c.get("user")?.id ?? null); } catch { /* best-effort */ }
  return c.json({ item: toReceiveItemResponse(data) }, 201);
});

/* ── PATCH /:id/items/:itemId — partial line update. qty → qty_received. ── */
app.patch("/:id/items/:itemId", async (c) => {
  const receiveId = c.req.param("id"); const itemId = c.req.param("itemId");
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: "invalid_json" }, 400); }
  const db = getDb(c.env);

  const childLock = await pcReceiveHasDownstream(db, receiveId);
  if (childLock) return c.json(childLock, 409);

  const [prev] = await db.select().from(pcrItemsTable).where(eq(pcrItemsTable.id, itemId)).limit(1);
  if (!prev) return c.json({ error: "not_found" }, 404);

  const qtyReceived = it.qty !== undefined ? Number(it.qty) : prev.qtyReceived;
  {
    const pcoItemId = prev.pcOrderItemId;
    const prevQty = prev.qtyReceived ?? 0;
    if (pcoItemId && qtyReceived > prevQty) {
      const [pcoItem] = await db.select({ qty: pcoItemsTable.qty, receivedQty: pcoItemsTable.receivedQty }).from(pcoItemsTable).where(eq(pcoItemsTable.id, pcoItemId)).limit(1);
      if (pcoItem) {
        const headroom = (pcoItem.qty ?? 0) - ((pcoItem.receivedQty ?? 0) - prevQty);
        if (qtyReceived > headroom) return c.json({ error: "qty_exceeds_remaining", pcoItemId, requested: qtyReceived, remaining: headroom }, 409);
      }
    }
  }

  const unit = it.unitPriceCenti !== undefined ? Number(it.unitPriceCenti) : prev.unitPriceCenti;
  const discount = it.discountCenti !== undefined ? Number(it.discountCenti) : (prev.discountCenti ?? 0);
  const lineTotal = qtyReceived * unit - discount;

  const updates: Record<string, unknown> = { qtyReceived, qtyAccepted: qtyReceived, unitPriceCenti: unit, discountCenti: discount, lineTotalCenti: lineTotal };
  for (const [from, to] of [
    ["materialCode", "materialCode"], ["materialName", "materialName"],
    ["supplierSku", "supplierSku"], ["itemGroup", "itemGroup"],
    ["description", "description"], ["uom", "uom"],
    ["unitCostCenti", "unitCostCenti"], ["notes", "notes"],
    ["gapInches", "gapInches"], ["divanHeightInches", "divanHeightInches"],
    ["divanPriceSen", "divanPriceSen"], ["legHeightInches", "legHeightInches"],
    ["legPriceSen", "legPriceSen"], ["customSpecials", "customSpecials"],
    ["lineSuffix", "lineSuffix"], ["specialOrderPriceSen", "specialOrderPriceSen"],
    ["variants", "variants"], ["deliveryDate", "deliveryDate"], ["description2", "description2"],
  ] as const) {
    if (it[from] !== undefined) updates[to] = it[from];
  }

  await db.update(pcrItemsTable).set(updates as never).where(eq(pcrItemsTable.id, itemId));
  await recomputePcReceiveTotals(db, receiveId);
  try { await recomputePcoReceived(db, [prev.pcOrderItemId]); } catch { /* best-effort */ }
  try { await resyncReceiveInventory(db, receiveId, c.get("user")?.id ?? null); } catch { /* best-effort */ }
  return c.json({ ok: true });
});

/* ── DELETE /:id/items/:itemId — remove a line + roll back. ── */
app.delete("/:id/items/:itemId", async (c) => {
  const receiveId = c.req.param("id"); const itemId = c.req.param("itemId");
  const db = getDb(c.env);
  const childLock = await pcReceiveHasDownstream(db, receiveId);
  if (childLock) return c.json(childLock, 409);

  const [line] = await db.select({ pcOrderItemId: pcrItemsTable.pcOrderItemId }).from(pcrItemsTable).where(eq(pcrItemsTable.id, itemId)).limit(1);
  await db.delete(pcrItemsTable).where(eq(pcrItemsTable.id, itemId));
  if (line) { try { await recomputePcoReceived(db, [line.pcOrderItemId]); } catch { /* best-effort */ } }
  await recomputePcReceiveTotals(db, receiveId);
  try { await resyncReceiveInventory(db, receiveId, c.get("user")?.id ?? null); } catch { /* best-effort */ }
  return c.body(null, 204);
});

export default app;
