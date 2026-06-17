// ----------------------------------------------------------------------------
// /consignment-returns — Consignment Return (CR): consignment goods come BACK.
// 1:1 clone of 2990s apps/api/src/routes/consignment-returns.ts (itself a Delivery
// Return clone) onto consignment_delivery_returns/_items.
//
// UNIFIED inventory model (2990s 2026-06-06): a Consignment Return books a plain
// IN to the destination warehouse exactly like a Delivery Return — goods re-enter
// inventory at the return line's snapshot cost, recorded as a plain IN tagged CS_DR.
// Cancelling writes a balancing OUT. One self-healing resyncReturnInventory covers
// the whole lifecycle (receive / add-line / edit-qty / delete-line / cancel),
// IN-primary, mirroring the DR's resyncInventoryForReturn. A return posts on create
// -> status starts at RECEIVED.
//
// SEAMS only (rule #3/#4/#7): Supabase PostgREST -> Drizzle (getDb); snake_case
// wire shape via mappers. Auth -> requirePermission("*"). user.id staff uuid ->
// users.id integer. Inventory via lib/inventory-movements (writeMovements),
// source_doc_type 'CS_DR' (first IN per bucket) + 'STOCK_TRANSFER' (later deltas /
// cancel give-back). Mount /api/consignment-returns. Numbering CR-YYMM-NNN.
//
// DROPPED vs the DR clone (per the 2990s consignment source + Strategy-2):
//   - the "no DO, no return" HARD requirement — RELAXED: a consignment return may
//     reference a Consignment Note line OR be free-entry.
//   - the over-return remaining guard (DO-pipeline-specific).
//   - reopenSoFromReturn (SO-specific) + COGS/margin recognition.
//   - catalog itemCode guard (validateItemCodes), buildVariantSummary (description2
//     passes through), the sofa dye-lot batch tracking. computeVariantKey is generic.
// ----------------------------------------------------------------------------

import { Hono } from "hono";
import type { Context } from "hono";
import { and, asc, desc, eq, inArray, like, sql } from "drizzle-orm";
import type { Env } from "../types";
import { getDb } from "../db/client";
import {
  consignmentDeliveryReturns as crTable,
  consignmentDeliveryReturnItems as crItemsTable,
  consignmentDeliveryOrders as cnTable,
  consignmentDeliveryOrderItems as cnItemsTable,
  consignmentSalesOrderItems as coItemsTable,
  mfgWarehouses as warehousesTable,
} from "../db/schema";
import { requirePermission } from "../middleware/auth";
import { writeMovements, defaultWarehouseId, resolveWarehouseLotBatches, resolveWarehouseLotCosts } from "../lib/inventory-movements";
import { recomputeSoStockAllocation } from "../lib/so-stock-allocation";
import { computeVariantKey, type VariantAttrs } from "@shared/index";

const app = new Hono<{ Bindings: Env }>();
app.use("*", requirePermission("*"));

type Db = ReturnType<typeof getDb>;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
function isoOrNull(v: Date | string | null): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

type CrHeaderDb = typeof crTable.$inferSelect;
type CrItemDb = typeof crItemsTable.$inferSelect;

function toCrHeaderResponse(p: CrHeaderDb): Record<string, unknown> {
  return {
    id: p.id,
    return_number: p.returnNumber,
    do_number: p.doNumber,
    consignment_do_id: p.consignmentDoId,
    debtor_code: p.debtorCode,
    debtor_name: p.debtorName,
    return_date: p.returnDate,
    reason: p.reason,
    status: p.status,
    received_at: isoOrNull(p.receivedAt),
    inspected_at: isoOrNull(p.inspectedAt),
    refunded_at: isoOrNull(p.refundedAt),
    refund_centi: p.refundCenti,
    inspection_notes: p.inspectionNotes,
    salesperson_id: p.salespersonId,
    agent: p.agent,
    email: p.email,
    customer_type: p.customerType,
    building_type: p.buildingType,
    branding: p.branding,
    venue: p.venue,
    venue_id: p.venueId,
    ref: p.ref,
    customer_so_no: p.customerSoNo,
    sales_location: p.salesLocation,
    customer_state: p.customerState,
    customer_country: p.customerCountry,
    note: p.note,
    address1: p.address1,
    address2: p.address2,
    city: p.city,
    state: p.state,
    postcode: p.postcode,
    phone: p.phone,
    emergency_contact_name: p.emergencyContactName,
    emergency_contact_phone: p.emergencyContactPhone,
    emergency_contact_relationship: p.emergencyContactRelationship,
    mattress_sofa_centi: p.mattressSofaCenti,
    bedframe_centi: p.bedframeCenti,
    accessories_centi: p.accessoriesCenti,
    others_centi: p.othersCenti,
    mattress_sofa_cost_centi: p.mattressSofaCostCenti,
    bedframe_cost_centi: p.bedframeCostCenti,
    accessories_cost_centi: p.accessoriesCostCenti,
    others_cost_centi: p.othersCostCenti,
    local_total_centi: p.localTotalCenti,
    total_cost_centi: p.totalCostCenti,
    total_margin_centi: p.totalMarginCenti,
    margin_pct_basis: p.marginPctBasis,
    line_count: p.lineCount,
    currency: p.currency,
    warehouse_id: p.warehouseId,
    notes: p.notes,
    created_at: isoOrNull(p.createdAt),
    created_by: p.createdBy,
    updated_at: isoOrNull(p.updatedAt),
  };
}
function toCrItemResponse(it: CrItemDb): Record<string, unknown> {
  return {
    id: it.id,
    consignment_delivery_return_id: it.consignmentDeliveryReturnId,
    consignment_do_item_id: it.consignmentDoItemId,
    item_code: it.itemCode,
    item_group: it.itemGroup,
    description: it.description,
    description2: it.description2,
    uom: it.uom,
    qty_returned: it.qtyReturned,
    condition: it.condition,
    unit_price_centi: it.unitPriceCenti,
    discount_centi: it.discountCenti,
    line_total_centi: it.lineTotalCenti,
    unit_cost_centi: it.unitCostCenti,
    line_cost_centi: it.lineCostCenti,
    line_margin_centi: it.lineMarginCenti,
    refund_centi: it.refundCenti,
    variants: it.variants ?? null,
    notes: it.notes,
    created_at: isoOrNull(it.createdAt),
  };
}

const nextNum = async (db: Db): Promise<string> => {
  const d = new Date();
  const yymm = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, "0")}`;
  const rows = await db.select({ returnNumber: crTable.returnNumber }).from(crTable).where(like(crTable.returnNumber, `CR-${yymm}-%`));
  let maxN = 0;
  for (const r of rows) { const m = /-(\d+)$/.exec(r.returnNumber); if (m) maxN = Math.max(maxN, parseInt(m[1], 10)); }
  return `CR-${yymm}-${String(maxN + 1).padStart(3, "0")}`;
};

/* Re-derive the return header's per-category totals from its lines. */
async function recomputeTotals(db: Db, returnId: string): Promise<void> {
  const items = await db.select({ itemGroup: crItemsTable.itemGroup, lineTotalCenti: crItemsTable.lineTotalCenti, lineCostCenti: crItemsTable.lineCostCenti }).from(crItemsTable).where(eq(crItemsTable.consignmentDeliveryReturnId, returnId));
  let mattressSofa = 0, bedframe = 0, accessories = 0, others = 0, total = 0, totalCost = 0;
  let mattressSofaCost = 0, bedframeCost = 0, accessoriesCost = 0, othersCost = 0;
  for (const it of items) {
    const lineTotal = Number(it.lineTotalCenti ?? 0);
    const lineCost = Number(it.lineCostCenti ?? 0);
    total += lineTotal;
    totalCost += lineCost;
    const g = (it.itemGroup ?? "").toLowerCase();
    if (g.includes("mattress") || g.includes("sofa")) { mattressSofa += lineTotal; mattressSofaCost += lineCost; }
    else if (g.includes("bedframe")) { bedframe += lineTotal; bedframeCost += lineCost; }
    else if (g.includes("accessor")) { accessories += lineTotal; accessoriesCost += lineCost; }
    else { others += lineTotal; othersCost += lineCost; }
  }
  const margin = total - totalCost;
  await db.update(crTable).set({
    mattressSofaCenti: mattressSofa, bedframeCenti: bedframe, accessoriesCenti: accessories, othersCenti: others,
    mattressSofaCostCenti: mattressSofaCost, bedframeCostCenti: bedframeCost, accessoriesCostCenti: accessoriesCost, othersCostCenti: othersCost,
    localTotalCenti: total, totalCostCenti: totalCost, totalMarginCenti: margin, marginPctBasis: total > 0 ? Math.round((margin / total) * 10000) : 0,
    lineCount: items.length, refundCenti: total, updatedAt: new Date(),
  }).where(eq(crTable.id, returnId));
}

/* resolveReturnLineWarehouses — DESTINATION warehouse for the returned line:
   1. linked CN line -> consignment_so_item_id -> CO line warehouse
   2. linked CN header's warehouse_id
   3. the return header's warehouse_id (free-entry lines — allowed for consignment)
   4. the global default warehouse */
async function resolveReturnLineWarehouses(db: Db, items: Array<{ id: string; consignmentDoItemId?: string | null }>, headerWarehouseId: string | null): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const cnItemIds = [...new Set(items.map((it) => it.consignmentDoItemId ?? null).filter((x): x is string => !!x))];
  const cnLineMeta = new Map<string, { soItemId: string | null; cnWarehouseId: string | null }>();
  const soItemIds = new Set<string>();
  if (cnItemIds.length > 0) {
    const cnLines = await db.select({ id: cnItemsTable.id, consignmentSoItemId: cnItemsTable.consignmentSoItemId, consignmentDeliveryOrderId: cnItemsTable.consignmentDeliveryOrderId }).from(cnItemsTable).where(inArray(cnItemsTable.id, cnItemIds));
    const cnIds = [...new Set(cnLines.map((r) => r.consignmentDeliveryOrderId).filter(Boolean))];
    const cnHeaderWh = new Map<string, string | null>();
    if (cnIds.length > 0) {
      const cnHeaders = await db.select({ id: cnTable.id, warehouseId: cnTable.warehouseId }).from(cnTable).where(inArray(cnTable.id, cnIds));
      for (const d of cnHeaders) cnHeaderWh.set(d.id, d.warehouseId ?? null);
    }
    for (const r of cnLines) {
      if (r.consignmentSoItemId) soItemIds.add(r.consignmentSoItemId);
      cnLineMeta.set(r.id, { soItemId: r.consignmentSoItemId ?? null, cnWarehouseId: cnHeaderWh.get(r.consignmentDeliveryOrderId) ?? null });
    }
  }
  const soWh = new Map<string, string | null>();
  if (soItemIds.size > 0) {
    const soRows = await db.select({ id: coItemsTable.id, warehouseId: coItemsTable.warehouseId }).from(coItemsTable).where(inArray(coItemsTable.id, [...soItemIds]));
    for (const r of soRows) soWh.set(r.id, r.warehouseId ?? null);
  }
  const fallback = headerWarehouseId ?? (await defaultWarehouseId(db));
  for (const it of items) {
    const meta = it.consignmentDoItemId ? cnLineMeta.get(it.consignmentDoItemId) : undefined;
    const fromSo = meta?.soItemId ? soWh.get(meta.soItemId) ?? null : null;
    out.set(it.id, fromSo ?? meta?.cnWarehouseId ?? fallback);
  }
  return out;
}

async function warehouseCodeMap(db: Db, ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const uniq = [...new Set(ids.filter((x): x is string => !!x))];
  if (uniq.length === 0) return out;
  const rows = await db.select({ id: warehousesTable.id, code: warehousesTable.code, name: warehousesTable.name }).from(warehousesTable).where(inArray(warehousesTable.id, uniq));
  for (const w of rows) out.set(w.id, w.code ?? w.name ?? "");
  return out;
}

/* ── resyncReturnInventory — self-healing IN ledger for a Consignment Return ───
   IN-primary mirror of resyncNoteInventory:
     • first-ever IN for a bucket   → CS_DR  ("stock back IN" label)
     • any later increase           → STOCK_TRANSFER IN
     • any decrease / give-back     → STOCK_TRANSFER OUT
     • cancel → status CANCELLED → TARGET empty → net driven back to 0 via OUT.
   A return is "active" (books IN) whenever status !== 'CANCELLED'. Idempotent. */
async function resyncReturnInventory(db: Db, returnId: string, performedBy: number | null): Promise<string[]> {
  const hdrRows = await db.select({ returnNumber: crTable.returnNumber, status: crTable.status, warehouseId: crTable.warehouseId }).from(crTable).where(eq(crTable.id, returnId)).limit(1);
  if (!hdrRows[0]) return [];
  const status = (hdrRows[0].status ?? "").toUpperCase();
  const returnNo = hdrRows[0].returnNumber ?? returnId;
  const cancelled = status === "CANCELLED";

  // 1. TARGET net IN per bucket = sum of current lines (empty if cancelled).
  type Bucket = { warehouse_id: string; product_code: string; variant_key: string; product_name: string | null; qty: number; unit_cost_sen: number; batch_no: string | null };
  const targetByBucket = new Map<string, Bucket>();
  if (!cancelled) {
    const items = await db.select({ id: crItemsTable.id, consignmentDoItemId: crItemsTable.consignmentDoItemId, itemCode: crItemsTable.itemCode, description: crItemsTable.description, qtyReturned: crItemsTable.qtyReturned, unitCostCenti: crItemsTable.unitCostCenti, itemGroup: crItemsTable.itemGroup, variants: crItemsTable.variants }).from(crItemsTable).where(eq(crItemsTable.consignmentDeliveryReturnId, returnId));
    const lineWh = await resolveReturnLineWarehouses(db, items, hdrRows[0].warehouseId ?? null);
    const distinctWh = [...new Set(items.map((it) => lineWh.get(it.id)).filter((x): x is string => !!x))];
    const batchByWh = new Map<string, Map<string, string | null>>();
    const costByWh = new Map<string, Map<string, number>>();
    for (const wh of distinctWh) { batchByWh.set(wh, await resolveWarehouseLotBatches(db, wh)); costByWh.set(wh, await resolveWarehouseLotCosts(db, wh)); }
    for (const it of items) {
      const qty = Number(it.qtyReturned ?? 0);
      if (qty <= 0) continue;
      const wh = lineWh.get(it.id) ?? null;
      if (!wh) continue;
      const vk = computeVariantKey(it.itemGroup, (it.variants as VariantAttrs | null) ?? null);
      const batch = batchByWh.get(wh)?.get(`${it.itemCode}::${vk}`) ?? null;
      // Cost = the return line's snapshot; if 0 (free-entry), fall back to the SKU's
      // current on-hand avg cost so we don't open a 0-cost lot.
      const lineCost = Number(it.unitCostCenti ?? 0);
      const unitCost = lineCost > 0 ? lineCost : (costByWh.get(wh)?.get(`${it.itemCode}::${vk}`) ?? 0);
      const k = `${wh}::${it.itemCode}::${vk}::${batch ?? ""}`;
      const cur = targetByBucket.get(k);
      if (cur) cur.qty += qty;
      else targetByBucket.set(k, { warehouse_id: wh, product_code: it.itemCode, variant_key: vk, product_name: it.description, qty, unit_cost_sen: unitCost, batch_no: batch });
    }
  }

  // 2. CURRENT net IN per bucket from ALL this return's movements (CS_DR + STOCK_TRANSFER deltas).
  const movs = await db.execute<{ movement_type: string; warehouse_id: string; product_code: string; variant_key: string | null; batch_no: string | null; qty: number; total_cost_sen: number | null; product_name: string | null }>(
    sql`SELECT movement_type, warehouse_id, product_code, variant_key, batch_no, qty, total_cost_sen, product_name
        FROM inventory_movements WHERE source_doc_id = ${returnId} AND source_doc_type IN ('CS_DR','STOCK_TRANSFER')`,
  );
  type Agg = { in_qty: number; out_qty: number; in_total_cost: number; product_name: string | null };
  const aggByBucket = new Map<string, Agg>();
  for (const m of movs) {
    const k = `${m.warehouse_id}::${m.product_code}::${m.variant_key ?? ""}::${m.batch_no ?? ""}`;
    let a = aggByBucket.get(k);
    if (!a) { a = { in_qty: 0, out_qty: 0, in_total_cost: 0, product_name: m.product_name }; aggByBucket.set(k, a); }
    if (m.movement_type === "IN") { a.in_qty += Number(m.qty ?? 0); a.in_total_cost += Number(m.total_cost_sen ?? 0); }
    else if (m.movement_type === "OUT") a.out_qty += Number(m.qty ?? 0);
    if (!a.product_name) a.product_name = m.product_name;
  }

  // 3. delta = target − current_net_in. >0 → book more IN; <0 → give stock back OUT.
  type MovOut = Parameters<typeof writeMovements>[1][number];
  const writes: MovOut[] = [];
  const csDrEmitted = new Set<string>();
  for (const k of new Set<string>([...targetByBucket.keys(), ...aggByBucket.keys()])) {
    const t = targetByBucket.get(k);
    const a = aggByBucket.get(k) ?? { in_qty: 0, out_qty: 0, in_total_cost: 0, product_name: null };
    const delta = (t?.qty ?? 0) - (a.in_qty - a.out_qty);
    if (delta === 0) continue;
    const [wh, pc, vk, batchSeg] = k.split("::");
    const batch_no = batchSeg || null;
    const pname = t?.product_name ?? a.product_name ?? null;
    if (delta > 0) {
      const neverMoved = a.in_qty === 0 && a.out_qty === 0;
      const useCsDr = neverMoved && !csDrEmitted.has(`${pc}::${vk}`);
      if (useCsDr) csDrEmitted.add(`${pc}::${vk}`);
      writes.push({
        movement_type: "IN", warehouse_id: wh ?? "", product_code: pc ?? "", variant_key: vk ?? "", product_name: pname,
        qty: delta, unit_cost_sen: t?.unit_cost_sen ?? 0,
        source_doc_type: useCsDr ? "CS_DR" : "STOCK_TRANSFER",
        source_doc_id: returnId, source_doc_no: returnNo,
        ...(batch_no ? { batch_no } : {}),
        performed_by: performedBy,
        notes: useCsDr ? "Consignment Return — stock back IN" : "Consignment Return resync: line qty increased / added.",
      });
    } else {
      writes.push({
        movement_type: "OUT", warehouse_id: wh ?? "", product_code: pc ?? "", variant_key: vk ?? "", product_name: pname,
        qty: -delta,
        source_doc_type: "STOCK_TRANSFER",
        source_doc_id: returnId, source_doc_no: cancelled ? `${returnNo}-CANCEL` : returnNo,
        ...(batch_no ? { batch_no } : {}),
        performed_by: performedBy,
        notes: cancelled ? "Consignment Return cancelled — stock out again" : "Consignment Return resync: line qty reduced / deleted.",
      });
    }
  }

  if (writes.length === 0) return [];
  const res = await writeMovements(db, writes);
  try { await recomputeSoStockAllocation(db); } catch { /* best-effort */ }
  return res.ok ? [] : [res.reason ?? "consignment return inventory resync failed"];
}

/* Build one consignment_delivery_return_items insert row from a client line payload. */
function buildItemRow(returnId: string, it: Record<string, unknown>): Record<string, unknown> {
  const qty = Number(it.qtyReturned ?? it.qty ?? 1);
  const unitPrice = Number(it.unitPriceCenti ?? 0);
  const discount = Number(it.discountCenti ?? 0);
  const unitCost = Number(it.unitCostCenti ?? 0);
  const lineTotal = qty * unitPrice - discount;
  const lineCost = qty * unitCost;
  const refund = it.refundCenti !== undefined ? Number(it.refundCenti) : lineTotal;
  return {
    consignmentDeliveryReturnId: returnId,
    consignmentDoItemId: (it.doItemId as string | undefined) ?? (it.consignmentDoItemId as string | undefined) ?? null,
    itemCode: it.itemCode,
    itemGroup: (it.itemGroup as string) ?? null,
    description: (it.description as string) ?? null,
    description2: (it.description2 as string) ?? null,
    uom: (it.uom as string) ?? "UNIT",
    qtyReturned: qty,
    condition: (it.condition as string) ?? null,
    unitPriceCenti: unitPrice,
    discountCenti: discount,
    lineTotalCenti: lineTotal,
    unitCostCenti: unitCost,
    lineCostCenti: lineCost,
    lineMarginCenti: lineTotal - lineCost,
    refundCenti: refund,
    variants: (it.variants as unknown) ?? null,
    notes: (it.notes as string | undefined) ?? null,
  };
}

// ── List ────────────────────────────────────────────────────────────────
app.get("/", async (c) => {
  const db = getDb(c.env);
  try {
    const conds = [];
    const status = c.req.query("status");
    if (status) conds.push(eq(crTable.status, status as CrHeaderDb["status"]));
    const rows = await db.select().from(crTable).where(conds.length ? and(...conds) : undefined).orderBy(desc(crTable.returnDate)).limit(500);
    return c.json({ deliveryReturns: rows.map((r) => toCrHeaderResponse(r)) });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

// ── Returnable Consignment Note lines (From-Note multi-picker) — STATIC, before /:id ──
app.get("/returnable-note-lines", async (c) => {
  const db = getDb(c.env);
  try {
    const notes = await db.select({ id: cnTable.id, doNumber: cnTable.doNumber, debtorCode: cnTable.debtorCode, debtorName: cnTable.debtorName }).from(cnTable).orderBy(desc(cnTable.doNumber)).limit(1000);
    if (notes.length === 0) return c.json({ lines: [] });
    const noteById = new Map(notes.map((n) => [n.id, n]));
    const noteIds = notes.map((n) => n.id);

    const items = await db.select({ id: cnItemsTable.id, consignmentDeliveryOrderId: cnItemsTable.consignmentDeliveryOrderId, itemCode: cnItemsTable.itemCode, itemGroup: cnItemsTable.itemGroup, description: cnItemsTable.description, description2: cnItemsTable.description2, uom: cnItemsTable.uom, qty: cnItemsTable.qty, unitPriceCenti: cnItemsTable.unitPriceCenti, discountCenti: cnItemsTable.discountCenti, unitCostCenti: cnItemsTable.unitCostCenti, variants: cnItemsTable.variants }).from(cnItemsTable).where(inArray(cnItemsTable.consignmentDeliveryOrderId, noteIds));
    if (items.length === 0) return c.json({ lines: [] });
    const itemIds = items.map((it) => it.id);

    // Already-returned per note line — only count non-cancelled returns.
    const relRows = await db.select({ id: crTable.id }).from(crTable).where(sql`${crTable.status} <> 'CANCELLED'`);
    const liveReturnIds = new Set(relRows.map((r) => r.id));
    const retItems = await db.select({ consignmentDeliveryReturnId: crItemsTable.consignmentDeliveryReturnId, consignmentDoItemId: crItemsTable.consignmentDoItemId, qtyReturned: crItemsTable.qtyReturned }).from(crItemsTable).where(inArray(crItemsTable.consignmentDoItemId, itemIds));
    const returnedByItem = new Map<string, number>();
    for (const r of retItems) {
      if (!r.consignmentDoItemId || !liveReturnIds.has(r.consignmentDeliveryReturnId)) continue;
      returnedByItem.set(r.consignmentDoItemId, (returnedByItem.get(r.consignmentDoItemId) ?? 0) + Number(r.qtyReturned ?? 0));
    }

    const lines = items.map((it) => {
      const note = noteById.get(it.consignmentDeliveryOrderId);
      const delivered = Number(it.qty ?? 0);
      const returned = returnedByItem.get(it.id) ?? 0;
      return {
        noteItemId: it.id, consignmentDoId: it.consignmentDeliveryOrderId, noteNumber: note?.doNumber ?? "", debtorCode: note?.debtorCode ?? null, debtorName: note?.debtorName ?? null,
        itemCode: it.itemCode, itemGroup: it.itemGroup ?? null, description: it.description ?? null, description2: it.description2 ?? null, uom: it.uom ?? null,
        delivered, returned, remaining: delivered - returned, unitPriceCenti: Number(it.unitPriceCenti ?? 0), discountCenti: Number(it.discountCenti ?? 0), unitCostCenti: Number(it.unitCostCenti ?? 0), variants: it.variants ?? null,
      };
    }).filter((l) => l.remaining > 0);

    return c.json({ lines });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

// ── Detail ──────────────────────────────────────────────────────────────
app.get("/:id", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  try {
    const [headerRows, itemRows] = await Promise.all([
      db.select().from(crTable).where(eq(crTable.id, id)).limit(1),
      db.select().from(crItemsTable).where(eq(crItemsTable.consignmentDeliveryReturnId, id)).orderBy(asc(crItemsTable.createdAt)),
    ]);
    if (!headerRows[0]) return c.json({ error: "not_found" }, 404);
    const lineWh = await resolveReturnLineWarehouses(db, itemRows.map((it) => ({ id: it.id, consignmentDoItemId: it.consignmentDoItemId })), headerRows[0].warehouseId ?? null);
    const codeMap = await warehouseCodeMap(db, [...lineWh.values()]);
    const items = itemRows.map((it) => {
      const wid = lineWh.get(it.id) ?? null;
      return { ...toCrItemResponse(it), warehouse_id: wid, warehouse_code: wid ? codeMap.get(wid) ?? null : null };
    });
    return c.json({ deliveryReturn: toCrHeaderResponse(headerRows[0]), items });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

/* Insert the return header from a client body. Shared by POST / and from-note. */
async function insertHeader(db: Db, userId: number, body: Record<string, unknown>): Promise<CrHeaderDb> {
  const returnNumber = await nextNum(db);
  const inserted = await db.insert(crTable).values({
    returnNumber,
    doNumber: (body.doNumber as string) ?? (body.doDocNo as string) ?? (body.cnDocNo as string) ?? null,
    consignmentDoId: (body.consignmentDoId as string) ?? (body.deliveryOrderId as string) ?? null,
    debtorCode: (body.debtorCode as string) ?? null,
    debtorName: (body.debtorName ?? body.customerName) as string,
    returnDate: (body.returnDate as string) ?? new Date().toISOString().slice(0, 10),
    reason: (body.reason as string) ?? null,
    address1: (body.address1 as string) ?? null,
    address2: (body.address2 as string) ?? null,
    city: (body.city as string) ?? null,
    state: (body.state as string) ?? (body.customerState as string) ?? null,
    customerState: (body.customerState as string) ?? (body.state as string) ?? null,
    customerCountry: (body.customerCountry as string) ?? null,
    postcode: (body.postcode as string) ?? null,
    phone: (body.phone as string) ?? null,
    salespersonId: typeof body.salespersonId === "number" ? (body.salespersonId as number) : null,
    agent: (body.agent as string) ?? null,
    email: (body.email as string) ?? null,
    customerType: (body.customerType as string) ?? null,
    buildingType: (body.buildingType as string) ?? null,
    branding: (body.branding as string) ?? null,
    venue: (body.venue as string) ?? null,
    venueId: (body.venueId as string) ?? null,
    ref: (body.ref as string) ?? null,
    customerSoNo: (body.customerSoNo as string) ?? null,
    salesLocation: (body.salesLocation as string) ?? null,
    note: (body.note as string) ?? null,
    emergencyContactName: (body.emergencyContactName as string) ?? null,
    emergencyContactPhone: (body.emergencyContactPhone as string) ?? null,
    emergencyContactRelationship: (body.emergencyContactRelationship as string) ?? null,
    warehouseId: (body.warehouseId as string) ?? null,
    currency: (((body.currency as string) ?? "MYR")) as never,
    // A return = goods are RECEIVED back the moment it's created.
    status: "RECEIVED",
    receivedAt: new Date(),
    notes: (body.notes as string) ?? null,
    createdBy: userId,
  } as never).returning();
  return inserted[0];
}

// ── Create ──────────────────────────────────────────────────────────────
// "no DO, no return" is RELAXED — lines may reference a Consignment Note line OR be free-entry.
app.post("/", async (c) => {
  const db = getDb(c.env);
  const user = c.get("user");
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: "invalid_json" }, 400); }
  const debtorName = (body.debtorName ?? body.customerName) as string | undefined;
  if (!debtorName) return c.json({ error: "debtor_name_required" }, 400);
  const items = (body.items as Array<Record<string, unknown>> | undefined) ?? [];
  if (!Array.isArray(items) || items.length === 0) return c.json({ error: "items_required" }, 400);

  let header: CrHeaderDb;
  try { header = await insertHeader(db, user.id, body); } catch (e) { return c.json({ error: "insert_failed", reason: errMsg(e) }, 500); }

  try {
    await db.insert(crItemsTable).values(items.map((it) => buildItemRow(header.id, it)) as never);
    await recomputeTotals(db, header.id);
  } catch (e) {
    await db.delete(crTable).where(eq(crTable.id, header.id));
    return c.json({ error: "items_insert_failed", reason: errMsg(e) }, 500);
  }

  // The loaner comes back → book a plain IN. Self-healing resync (idempotent + best-effort).
  const movementErrors = await resyncReturnInventory(db, header.id, user.id);

  return c.json({ id: header.id, returnNumber: header.returnNumber, movementErrors: movementErrors.length ? movementErrors : undefined }, 201);
});

// ── Convert picked CN LINES (partial qty) → ONE Consignment Return ──────────
const convertNoteLinesToReturn = async (c: Context<{ Bindings: Env }>) => {
  const db = getDb(c.env);
  const user = c.get("user");
  let body: { picks?: Array<{ noteItemId?: string; consignmentDoItemId?: string; qty?: number; qtyReturned?: number; condition?: string }> };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: "invalid_json" }, 400); }

  const pickQtyById = new Map<string, number>();
  const conditionById = new Map<string, string>();
  for (const p of body.picks ?? []) { const id = p?.noteItemId ?? p?.consignmentDoItemId; if (!id) continue; const q = Number(p.qty ?? p.qtyReturned ?? 0); if (!(q > 0)) continue; pickQtyById.set(id, (pickQtyById.get(id) ?? 0) + q); if (p.condition && !conditionById.has(id)) conditionById.set(id, p.condition); }
  if (pickQtyById.size === 0) return c.json({ error: "picks_required" }, 400);

  const pickedIds = [...pickQtyById.keys()];
  const cnLineRows = await db.select({ id: cnItemsTable.id, consignmentDeliveryOrderId: cnItemsTable.consignmentDeliveryOrderId, itemCode: cnItemsTable.itemCode, itemGroup: cnItemsTable.itemGroup, description: cnItemsTable.description, description2: cnItemsTable.description2, uom: cnItemsTable.uom, unitPriceCenti: cnItemsTable.unitPriceCenti, unitCostCenti: cnItemsTable.unitCostCenti, variants: cnItemsTable.variants }).from(cnItemsTable).where(inArray(cnItemsTable.id, pickedIds));
  const lineById = new Map(cnLineRows.map((l) => [l.id, l]));
  const missing = pickedIds.filter((id) => !lineById.has(id));
  if (missing.length > 0) return c.json({ error: "note_item_not_found", missing }, 404);

  const cnIds = [...new Set(cnLineRows.map((l) => l.consignmentDeliveryOrderId))];
  const cnHeaders = await db.select().from(cnTable).where(inArray(cnTable.id, cnIds));
  const cnById = new Map(cnHeaders.map((h) => [h.id, h]));

  // One customer per Return.
  const custKey = (h: typeof cnHeaders[number] | undefined): string => (h?.debtorCode && h.debtorCode.trim() ? `code:${h.debtorCode.trim().toUpperCase()}` : `name:${(h?.debtorName ?? "").trim().toUpperCase()}`);
  const custSet = new Set(cnIds.map((id) => custKey(cnById.get(id))));
  if (custSet.size > 1) return c.json({ error: "mixed_customers", message: "All picked Consignment Note lines must belong to the same customer to combine into one Consignment Return." }, 400);

  const firstCnId = [...cnIds].sort()[0]!;
  const cnh = cnById.get(firstCnId);
  if (!cnh) return c.json({ error: "consignment_note_not_found" }, 404);
  const distinctNoteNumbers = [...new Set(cnHeaders.map((h) => h.doNumber))].sort();

  let header: CrHeaderDb;
  try {
    header = await insertHeader(db, user.id, {
      doNumber: cnh.doNumber, consignmentDoId: cnh.id, debtorCode: cnh.debtorCode, debtorName: cnh.debtorName, phone: cnh.phone, email: cnh.email,
      salespersonId: cnh.salespersonId, agent: cnh.agent, customerType: cnh.customerType, buildingType: cnh.buildingType, branding: cnh.branding,
      venue: cnh.venue, venueId: cnh.venueId, ref: distinctNoteNumbers.length > 1 ? `Merged from ${distinctNoteNumbers.join(", ")}` : cnh.ref,
      customerSoNo: cnh.customerSoNo, salesLocation: cnh.salesLocation, customerState: cnh.customerState, customerCountry: cnh.customerCountry,
      address1: cnh.address1, address2: cnh.address2, city: cnh.city, state: cnh.state, postcode: cnh.postcode,
      emergencyContactName: cnh.emergencyContactName, emergencyContactPhone: cnh.emergencyContactPhone, emergencyContactRelationship: cnh.emergencyContactRelationship,
      warehouseId: cnh.warehouseId, currency: cnh.currency,
      reason: distinctNoteNumbers.length > 1 ? `Return from CN ${distinctNoteNumbers.join(", ")}` : `Return from CN ${String(cnh.doNumber ?? "")}`,
    });
  } catch (e) {
    return c.json({ error: "insert_failed", reason: errMsg(e) }, 500);
  }

  const rows = pickedIds.map((id) => {
    const line = lineById.get(id)!;
    const qty = pickQtyById.get(id)!;
    return buildItemRow(header.id, { consignmentDoItemId: line.id, itemCode: line.itemCode, itemGroup: line.itemGroup, description: line.description, description2: line.description2, uom: line.uom ?? "UNIT", qtyReturned: qty, condition: conditionById.get(id) ?? "NEW", unitPriceCenti: line.unitPriceCenti, discountCenti: 0, unitCostCenti: line.unitCostCenti, variants: line.variants });
  });
  try {
    await db.insert(crItemsTable).values(rows as never);
    await recomputeTotals(db, header.id);
  } catch (e) {
    await db.delete(crTable).where(eq(crTable.id, header.id));
    return c.json({ error: "items_insert_failed", reason: errMsg(e) }, 500);
  }

  const movementErrors = await resyncReturnInventory(db, header.id, user.id);
  return c.json({ id: header.id, returnNumber: header.returnNumber, lineCount: rows.length, movementErrors: movementErrors.length ? movementErrors : undefined }, 201);
};
app.post("/from-note", convertNoteLinesToReturn);
app.post("/from-notes", convertNoteLinesToReturn);

// ── Header PATCH ───────────────────────────────────────────────────────────
app.patch("/:id", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: "invalid_json" }, 400); }
  const MAP: Array<[string, string]> = [
    ["debtorCode", "debtorCode"], ["debtorName", "debtorName"], ["agent", "agent"], ["salesLocation", "salesLocation"], ["ref", "ref"],
    ["venue", "venue"], ["venueId", "venueId"], ["branding", "branding"], ["address1", "address1"], ["address2", "address2"],
    ["city", "city"], ["state", "state"], ["postcode", "postcode"], ["phone", "phone"], ["note", "note"], ["notes", "notes"], ["reason", "reason"],
    ["returnDate", "returnDate"], ["currency", "currency"], ["customerState", "customerState"], ["customerCountry", "customerCountry"], ["customerSoNo", "customerSoNo"],
    ["email", "email"], ["customerType", "customerType"], ["salespersonId", "salespersonId"], ["buildingType", "buildingType"],
    ["emergencyContactName", "emergencyContactName"], ["emergencyContactPhone", "emergencyContactPhone"], ["emergencyContactRelationship", "emergencyContactRelationship"],
  ];
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  for (const [from, to] of MAP) if (body[from] !== undefined) updates[to] = body[from];
  if (Object.keys(updates).length === 1) return c.json({ ok: true, changed: 0 });
  try {
    const updated = await db.update(crTable).set(updates).where(eq(crTable.id, id)).returning({ id: crTable.id });
    if (!updated[0]) return c.json({ error: "not_found" }, 404);
    return c.json({ ok: true, id });
  } catch (e) {
    return c.json({ error: "update_failed", reason: errMsg(e) }, 500);
  }
});

// ── Item CRUD ─────────────────────────────────────────────────────────────
/* A REFUNDED / CREDIT_NOTED / CANCELLED return is terminal — lock line edits to
   ACTIVE returns (mirrors the purchase side). */
async function returnLineLock(db: Db, id: string): Promise<{ error: string; message: string } | null> {
  const rows = await db.select({ status: crTable.status }).from(crTable).where(eq(crTable.id, id)).limit(1);
  const st = rows[0]?.status;
  if (st === "CANCELLED") return { error: "return_cancelled", message: "This consignment return is cancelled — its lines can no longer be changed." };
  if (st === "REFUNDED") return { error: "return_refunded", message: "This consignment return is refunded — its lines can no longer be changed." };
  if (st === "CREDIT_NOTED") return { error: "return_credit_noted", message: "This consignment return is credit-noted — its lines can no longer be changed." };
  return null;
}

app.post("/:id/items", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const user = c.get("user");
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: "invalid_json" }, 400); }
  if (!it.itemCode) return c.json({ error: "item_code_required" }, 400);
  { const lock = await returnLineLock(db, id); if (lock) return c.json(lock, 409); }

  const header = await db.select({ id: crTable.id }).from(crTable).where(eq(crTable.id, id)).limit(1);
  if (!header[0]) return c.json({ error: "not_found" }, 404);

  try {
    const inserted = await db.insert(crItemsTable).values(buildItemRow(id, it) as never).returning();
    await recomputeTotals(db, id);
    try { await resyncReturnInventory(db, id, user?.id ?? null); } catch { /* best-effort */ }
    return c.json({ item: toCrItemResponse(inserted[0]) }, 201);
  } catch (e) {
    return c.json({ error: "insert_failed", reason: errMsg(e) }, 500);
  }
});

app.patch("/:id/items/:itemId", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const itemId = c.req.param("itemId");
  const user = c.get("user");
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: "invalid_json" }, 400); }
  { const lock = await returnLineLock(db, id); if (lock) return c.json(lock, 409); }

  const prevRows = await db.select({ qtyReturned: crItemsTable.qtyReturned, unitPriceCenti: crItemsTable.unitPriceCenti, discountCenti: crItemsTable.discountCenti, unitCostCenti: crItemsTable.unitCostCenti }).from(crItemsTable).where(and(eq(crItemsTable.id, itemId), eq(crItemsTable.consignmentDeliveryReturnId, id))).limit(1);
  const prev = prevRows[0];
  if (!prev) return c.json({ error: "not_found" }, 404);

  const qty = (it.qtyReturned ?? it.qty) !== undefined ? Number(it.qtyReturned ?? it.qty) : Number(prev.qtyReturned);
  const unitPrice = it.unitPriceCenti !== undefined ? Number(it.unitPriceCenti) : Number(prev.unitPriceCenti);
  const discount = it.discountCenti !== undefined ? Number(it.discountCenti) : Number(prev.discountCenti);
  const unitCost = it.unitCostCenti !== undefined ? Number(it.unitCostCenti) : Number(prev.unitCostCenti);
  const lineTotal = qty * unitPrice - discount;
  const lineCost = qty * unitCost;
  const updates: Record<string, unknown> = { qtyReturned: qty, unitPriceCenti: unitPrice, discountCenti: discount, unitCostCenti: unitCost, lineTotalCenti: lineTotal, lineCostCenti: lineCost, lineMarginCenti: lineTotal - lineCost, refundCenti: lineTotal };
  for (const [from, to] of [["itemCode", "itemCode"], ["itemGroup", "itemGroup"], ["description", "description"], ["description2", "description2"], ["uom", "uom"], ["variants", "variants"], ["notes", "notes"], ["condition", "condition"]] as const) {
    if (it[from] !== undefined) updates[to] = it[from];
  }
  try {
    await db.update(crItemsTable).set(updates).where(eq(crItemsTable.id, itemId));
    await recomputeTotals(db, id);
    try { await resyncReturnInventory(db, id, user?.id ?? null); } catch { /* best-effort */ }
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: "update_failed", reason: errMsg(e) }, 500);
  }
});

app.delete("/:id/items/:itemId", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const itemId = c.req.param("itemId");
  const user = c.get("user");
  { const lock = await returnLineLock(db, id); if (lock) return c.json(lock, 409); }
  const line = await db.select({ id: crItemsTable.id }).from(crItemsTable).where(and(eq(crItemsTable.id, itemId), eq(crItemsTable.consignmentDeliveryReturnId, id))).limit(1);
  if (!line[0]) return c.json({ error: "not_found" }, 404);
  try {
    await db.delete(crItemsTable).where(eq(crItemsTable.id, itemId));
    await recomputeTotals(db, id);
    try { await resyncReturnInventory(db, id, user?.id ?? null); } catch { /* best-effort */ }
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: "delete_failed", reason: errMsg(e) }, 500);
  }
});

// ── Status transition ──────────────────────────────────────────────────────
app.patch("/:id/status", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const user = c.get("user");
  let body: { status?: string; inspectionNotes?: string };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: "invalid_json" }, 400); }
  if (!body.status) return c.json({ error: "status_required" }, 400);

  const cur = await db.select({ status: crTable.status }).from(crTable).where(eq(crTable.id, id)).limit(1);
  if (!cur[0]) return c.json({ error: "not_found" }, 404);
  const prevStatus = cur[0].status as string;
  if (body.status === "CANCELLED" && prevStatus === "CANCELLED") return c.json({ consignmentReturn: { id, status: "CANCELLED" } });

  const now = new Date();
  const ts: Record<string, unknown> = { updatedAt: now, status: body.status };
  if (body.status === "RECEIVED") ts.receivedAt = now;
  if (body.status === "INSPECTED") { ts.inspectedAt = now; if (body.inspectionNotes) ts.inspectionNotes = body.inspectionNotes; }
  if (body.status === "REFUNDED") ts.refundedAt = now;

  let data: { id: string; status: string } | null;
  if (body.status === "CANCELLED") {
    const updated = await db.update(crTable).set(ts).where(and(eq(crTable.id, id), sql`${crTable.status} <> 'CANCELLED'`)).returning({ id: crTable.id, status: crTable.status });
    if (!updated[0]) return c.json({ consignmentReturn: { id, status: "CANCELLED" } });
    data = updated[0] as { id: string; status: string };
  } else {
    const updated = await db.update(crTable).set(ts).where(eq(crTable.id, id)).returning({ id: crTable.id, status: crTable.status });
    if (!updated[0]) return c.json({ error: "not_found" }, 404);
    data = updated[0] as { id: string; status: string };
  }

  // Cancelling REVERSES the return IN: target net is now 0 -> resync writes a
  // balancing OUT per bucket. Idempotent + best-effort.
  if (body.status === "CANCELLED") {
    try { await resyncReturnInventory(db, id, user.id); } catch { /* best-effort */ }
  }

  return c.json({ consignmentReturn: data });
});

export default app;
