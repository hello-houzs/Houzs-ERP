// ----------------------------------------------------------------------------
// /consignment-notes — Consignment Note (CN): ship consignment goods OUT to a
// consignee / showroom. 1:1 clone of 2990s apps/api/src/routes/consignment-notes.ts
// (itself a Delivery Order clone) onto consignment_delivery_orders/_items/_payments.
//
// UNIFIED inventory model (2990s 2026-06-06): a Consignment Note ships goods OUT
// of the warehouse exactly like a Delivery Order — FIFO is consumed and the cost
// LEAVES inventory (COGS), recorded as a plain OUT tagged CS_DO in the same stock
// ledger. Cancelling writes a balancing IN. One self-healing resyncNoteInventory
// covers the whole lifecycle (ship / add-line / edit-qty / delete-line / cancel),
// mirroring the DO's resyncInventoryForDo and the PC-Receive's resyncReceiveInventory.
// A Note ships the moment it's created -> status starts at DISPATCHED.
//
// SEAMS only (rule #3/#4/#7):
//   - DB: 2990s Supabase PostgREST -> Houzs Drizzle (getDb); snake_case wire shape
//     via mappers. Auth -> requirePermission("*"). user.id staff uuid -> users.id
//     integer. Inventory writes via lib/inventory-movements (writeMovements),
//     source_doc_type 'CS_DO' (first OUT per bucket) + 'STOCK_TRANSFER' (later
//     deltas / cancel give-back). Mount /api/consignment-notes.
//
// Strategy-2: DROPPED the catalog itemCode guard (validateItemCodes), the short-
// stock confirm gate, the sofa no-batch / incomplete-set ship guards, and the
// SO-remaining over-pick guard (a loaner has no ordered-qty cap, ships what's on
// the shelf). buildVariantSummary dropped — description2 passes through;
// computeVariantKey is the generic shared one. Numbering CN-YYMM-NNN.
// ----------------------------------------------------------------------------

import { Hono } from "hono";
import { z } from "zod";
import { and, asc, desc, eq, inArray, like, sql } from "drizzle-orm";
import type { Env } from "../types";
import { getDb } from "../db/client";
import {
  consignmentDeliveryOrders as cnTable,
  consignmentDeliveryOrderItems as cnItemsTable,
  consignmentDeliveryOrderPayments as cnPaymentsTable,
  consignmentDeliveryReturns as crTable,
  consignmentSalesOrders as coTable,
  consignmentSalesOrderItems as coItemsTable,
  mfgWarehouses as warehousesTable,
  users as usersTable,
} from "../db/schema";
import { requirePermission } from "../middleware/auth";
import { writeMovements, defaultWarehouseId, resolveWarehouseLotBatches } from "../lib/inventory-movements";
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

/* Statuses that count as "shipped" — the goods have left our warehouse. The
   FIRST transition into ANY of these fires the CS_DO OUT. Same list as the DO. */
const SHIPPED_STATES = ["DISPATCHED", "IN_TRANSIT", "SIGNED", "DELIVERED", "INVOICED"];

type CnHeaderDb = typeof cnTable.$inferSelect;
type CnItemDb = typeof cnItemsTable.$inferSelect;

function toCnHeaderResponse(p: CnHeaderDb): Record<string, unknown> {
  return {
    id: p.id,
    do_number: p.doNumber,
    consignment_so_doc_no: p.consignmentSoDocNo,
    debtor_code: p.debtorCode,
    debtor_name: p.debtorName,
    do_date: p.doDate,
    expected_delivery_at: p.expectedDeliveryAt,
    customer_delivery_date: p.customerDeliveryDate,
    signed_at: isoOrNull(p.signedAt),
    delivered_at: isoOrNull(p.deliveredAt),
    dispatched_at: isoOrNull(p.dispatchedAt),
    driver_id: p.driverId,
    driver_name: p.driverName,
    vehicle: p.vehicle,
    m3_total_milli: p.m3Total,
    address1: p.address1,
    address2: p.address2,
    city: p.city,
    state: p.state,
    postcode: p.postcode,
    phone: p.phone,
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
    po_doc_no: p.poDocNo,
    sales_location: p.salesLocation,
    customer_state: p.customerState,
    customer_country: p.customerCountry,
    note: p.note,
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
    pod_r2_key: p.podR2Key,
    signature_data: p.signatureData,
    status: p.status,
    notes: p.notes,
    created_at: isoOrNull(p.createdAt),
    created_by: p.createdBy,
    updated_at: isoOrNull(p.updatedAt),
  };
}
function toCnItemResponse(it: CnItemDb): Record<string, unknown> {
  return {
    id: it.id,
    consignment_delivery_order_id: it.consignmentDeliveryOrderId,
    consignment_so_item_id: it.consignmentSoItemId,
    item_code: it.itemCode,
    item_group: it.itemGroup,
    description: it.description,
    description2: it.description2,
    uom: it.uom,
    qty: it.qty,
    m3_milli: it.m3Milli,
    unit_price_centi: it.unitPriceCenti,
    discount_centi: it.discountCenti,
    line_total_centi: it.lineTotalCenti,
    unit_cost_centi: it.unitCostCenti,
    line_cost_centi: it.lineCostCenti,
    line_margin_centi: it.lineMarginCenti,
    variants: it.variants ?? null,
    notes: it.notes,
    line_delivery_date: it.lineDeliveryDate,
    line_delivery_date_overridden: it.lineDeliveryDateOverridden,
    created_at: isoOrNull(it.createdAt),
  };
}

/* ── Child-lock guard ─────────────────────────────────────────────────────────
   A Consignment Note locks once it has ANY non-cancelled Consignment Return
   referencing it (consignment_do_id). No Sales Invoice in the consignment flow. */
async function noteHasDownstream(db: Db, noteId: string): Promise<{ error: string; message: string } | null> {
  const rows = await db.select({ id: crTable.id }).from(crTable).where(and(eq(crTable.consignmentDoId, noteId), sql`${crTable.status} <> 'CANCELLED'`)).limit(1);
  if (rows.length > 0) return { error: "note_has_downstream", message: "Consignment Note has a Consignment Return — cancel it first to edit" };
  return null;
}

const nextNum = async (db: Db): Promise<string> => {
  const d = new Date();
  const yymm = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, "0")}`;
  const rows = await db.select({ doNumber: cnTable.doNumber }).from(cnTable).where(like(cnTable.doNumber, `CN-${yymm}-%`));
  let maxN = 0;
  for (const r of rows) { const m = /-(\d+)$/.exec(r.doNumber); if (m) maxN = Math.max(maxN, parseInt(m[1], 10)); }
  return `CN-${yymm}-${String(maxN + 1).padStart(3, "0")}`;
};

/* Re-derive the note header's per-category totals + grand total from its lines.
   Plain per-category rollup, copied from the DO. */
async function recomputeTotals(db: Db, noteId: string): Promise<void> {
  const items = await db.select({ itemGroup: cnItemsTable.itemGroup, lineTotalCenti: cnItemsTable.lineTotalCenti, lineCostCenti: cnItemsTable.lineCostCenti }).from(cnItemsTable).where(eq(cnItemsTable.consignmentDeliveryOrderId, noteId));
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
  await db.update(cnTable).set({
    mattressSofaCenti: mattressSofa, bedframeCenti: bedframe, accessoriesCenti: accessories, othersCenti: others,
    mattressSofaCostCenti: mattressSofaCost, bedframeCostCenti: bedframeCost, accessoriesCostCenti: accessoriesCost, othersCostCenti: othersCost,
    localTotalCenti: total, totalCostCenti: totalCost, totalMarginCenti: margin, marginPctBasis: total > 0 ? Math.round((margin / total) * 10000) : 0,
    lineCount: items.length, updatedAt: new Date(),
  }).where(eq(cnTable.id, noteId));
}

/* resolveNoteLineWarehouses — per-line ship-from warehouse. A note line ships
   from its linked CO line's warehouse when set, else the note header's, else the
   global default. */
async function resolveNoteLineWarehouses(db: Db, items: Array<{ id: string; consignmentSoItemId?: string | null }>, headerWarehouseId: string | null): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const soItemIds = [...new Set(items.map((it) => it.consignmentSoItemId ?? null).filter((x): x is string => !!x))];
  const soWh = new Map<string, string | null>();
  if (soItemIds.length > 0) {
    const soRows = await db.select({ id: coItemsTable.id, warehouseId: coItemsTable.warehouseId }).from(coItemsTable).where(inArray(coItemsTable.id, soItemIds));
    for (const r of soRows) soWh.set(r.id, r.warehouseId ?? null);
  }
  const fallback = headerWarehouseId ?? (await defaultWarehouseId(db));
  for (const it of items) {
    const fromSo = it.consignmentSoItemId ? soWh.get(it.consignmentSoItemId) ?? null : null;
    out.set(it.id, fromSo ?? fallback);
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

/* ── resyncNoteInventory — self-healing OUT ledger for a Consignment Note ──────
   ONE function for the whole lifecycle. Reconciles the note's CURRENT lines (the
   TARGET net OUT per warehouse/product/variant/batch bucket) against what
   inventory_movements already record for this note, and writes only the DELTA:
     • first-ever OUT for a bucket  → CS_DO  ("out via Consignment Note" label)
     • any later increase/decrease  → STOCK_TRANSFER OUT/IN (no collision w/ CS_DO)
     • cancel → status CANCELLED → TARGET empty → net driven back to 0 via IN.
   Idempotent (delta 0 -> no writes). Best-effort. Only runs once the note has
   shipped (or is being cancelled). Mirrors resyncInventoryForDo / the PC resync. */
async function resyncNoteInventory(db: Db, noteId: string, performedBy: number | null): Promise<string[]> {
  const hdrRows = await db.select({ doNumber: cnTable.doNumber, status: cnTable.status, warehouseId: cnTable.warehouseId }).from(cnTable).where(eq(cnTable.id, noteId)).limit(1);
  if (!hdrRows[0]) return [];
  const status = (hdrRows[0].status ?? "").toUpperCase();
  const noteNo = hdrRows[0].doNumber ?? noteId;
  const cancelled = status === "CANCELLED";
  // Nothing to reconcile until the note has shipped (no OUT yet) — unless cancelling.
  if (!cancelled && !SHIPPED_STATES.includes(status)) return [];

  // 1. TARGET net OUT per bucket = sum of current lines (empty if cancelled).
  type Bucket = { warehouse_id: string; product_code: string; variant_key: string; product_name: string | null; qty: number; batch_no: string | null };
  const targetByBucket = new Map<string, Bucket>();
  if (!cancelled) {
    const items = await db.select({ id: cnItemsTable.id, consignmentSoItemId: cnItemsTable.consignmentSoItemId, itemCode: cnItemsTable.itemCode, description: cnItemsTable.description, qty: cnItemsTable.qty, itemGroup: cnItemsTable.itemGroup, variants: cnItemsTable.variants }).from(cnItemsTable).where(eq(cnItemsTable.consignmentDeliveryOrderId, noteId));
    const lineWh = await resolveNoteLineWarehouses(db, items, hdrRows[0].warehouseId ?? null);
    const distinctWh = [...new Set(items.map((it) => lineWh.get(it.id)).filter((x): x is string => !!x))];
    const batchByWh = new Map<string, Map<string, string | null>>();
    for (const wh of distinctWh) batchByWh.set(wh, await resolveWarehouseLotBatches(db, wh));
    for (const it of items) {
      const qty = Number(it.qty ?? 0);
      if (qty <= 0) continue;
      const wh = lineWh.get(it.id) ?? null;
      if (!wh) continue;
      const vk = computeVariantKey(it.itemGroup, (it.variants as VariantAttrs | null) ?? null);
      const batch = batchByWh.get(wh)?.get(`${it.itemCode}::${vk}`) ?? null;
      const k = `${wh}::${it.itemCode}::${vk}::${batch ?? ""}`;
      const cur = targetByBucket.get(k);
      if (cur) cur.qty += qty;
      else targetByBucket.set(k, { warehouse_id: wh, product_code: it.itemCode, variant_key: vk, product_name: it.description, qty, batch_no: batch });
    }
  }

  // 2. CURRENT net OUT per bucket from ALL this note's movements (CS_DO + STOCK_TRANSFER deltas).
  const movs = await db.execute<{ movement_type: string; warehouse_id: string; product_code: string; variant_key: string | null; batch_no: string | null; qty: number; total_cost_sen: number | null; product_name: string | null }>(
    sql`SELECT movement_type, warehouse_id, product_code, variant_key, batch_no, qty, total_cost_sen, product_name
        FROM inventory_movements WHERE source_doc_id = ${noteId} AND source_doc_type IN ('CS_DO','STOCK_TRANSFER')`,
  );
  type Agg = { out_qty: number; in_qty: number; out_total_cost: number; product_name: string | null };
  const aggByBucket = new Map<string, Agg>();
  for (const m of movs) {
    const k = `${m.warehouse_id}::${m.product_code}::${m.variant_key ?? ""}::${m.batch_no ?? ""}`;
    let a = aggByBucket.get(k);
    if (!a) { a = { out_qty: 0, in_qty: 0, out_total_cost: 0, product_name: m.product_name }; aggByBucket.set(k, a); }
    if (m.movement_type === "OUT") { a.out_qty += Number(m.qty ?? 0); a.out_total_cost += Number(m.total_cost_sen ?? 0); }
    else if (m.movement_type === "IN") a.in_qty += Number(m.qty ?? 0);
    if (!a.product_name) a.product_name = m.product_name;
  }

  // 3. delta = target − current_net_out. >0 → ship more OUT; <0 → give stock back IN.
  type MovOut = Parameters<typeof writeMovements>[1][number];
  const writes: MovOut[] = [];
  const csDoEmitted = new Set<string>(); // product::variant given a CS_DO this run
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
      const useCsDo = neverMoved && !csDoEmitted.has(`${pc}::${vk}`);
      if (useCsDo) csDoEmitted.add(`${pc}::${vk}`);
      writes.push({
        movement_type: "OUT", warehouse_id: wh ?? "", product_code: pc ?? "", variant_key: vk ?? "", product_name: pname,
        qty: delta,
        source_doc_type: useCsDo ? "CS_DO" : "STOCK_TRANSFER",
        source_doc_id: noteId, source_doc_no: noteNo,
        ...(batch_no ? { batch_no } : {}),
        performed_by: performedBy,
        notes: useCsDo ? "Consignment Note ship-out (goods to showroom)" : "Consignment Note resync: line qty increased / added.",
      });
    } else {
      const unitCost = a.out_qty > 0 ? Math.round(a.out_total_cost / a.out_qty) : 0;
      writes.push({
        movement_type: "IN", warehouse_id: wh ?? "", product_code: pc ?? "", variant_key: vk ?? "", product_name: pname,
        qty: -delta, unit_cost_sen: unitCost,
        source_doc_type: "STOCK_TRANSFER",
        source_doc_id: noteId, source_doc_no: cancelled ? `${noteNo}-CANCEL` : noteNo,
        ...(batch_no ? { batch_no } : {}),
        performed_by: performedBy,
        notes: cancelled ? "Consignment Note cancelled — stock returned" : "Consignment Note resync: line qty reduced / deleted.",
      });
    }
  }

  if (writes.length === 0) return [];
  const res = await writeMovements(db, writes);
  try { await recomputeSoStockAllocation(db); } catch { /* best-effort */ }
  return res.ok ? [] : [res.reason ?? "consignment note inventory resync failed"];
}

/* Build one consignment_delivery_order_items insert row from a client line payload. */
function buildItemRow(noteId: string, it: Record<string, unknown>): Record<string, unknown> {
  const qty = Number(it.qty ?? 1);
  const unitPrice = Number(it.unitPriceCenti ?? 0);
  const discount = Number(it.discountCenti ?? 0);
  const unitCost = Number(it.unitCostCenti ?? 0);
  const lineTotal = qty * unitPrice - discount;
  const lineCost = qty * unitCost;
  return {
    consignmentDeliveryOrderId: noteId,
    consignmentSoItemId: (it.soItemId as string | undefined) ?? (it.consignmentSoItemId as string | undefined) ?? null,
    itemCode: it.itemCode,
    itemGroup: (it.itemGroup as string) ?? null,
    description: (it.description as string) ?? null,
    description2: (it.description2 as string) ?? null,
    uom: (it.uom as string) ?? "UNIT",
    qty,
    m3Milli: Number(it.m3Milli ?? 0),
    unitPriceCenti: unitPrice,
    discountCenti: discount,
    lineTotalCenti: lineTotal,
    unitCostCenti: unitCost,
    lineCostCenti: lineCost,
    lineMarginCenti: lineTotal - lineCost,
    variants: (it.variants as unknown) ?? null,
    notes: (it.notes as string) ?? null,
    lineDeliveryDate: (it.lineDeliveryDate as string | null) ?? null,
    lineDeliveryDateOverridden: Boolean(it.lineDeliveryDateOverridden ?? false),
  };
}

// ── List ──────────────────────────────────────────────────────────────
app.get("/", async (c) => {
  const db = getDb(c.env);
  try {
    const conds = [];
    const status = c.req.query("status");
    if (status) conds.push(eq(cnTable.status, status as CnHeaderDb["status"]));
    const headerRows = await db.select().from(cnTable).where(conds.length ? and(...conds) : undefined).orderBy(desc(cnTable.doDate)).limit(500);
    const childIds = new Set<string>();
    if (headerRows.length > 0) {
      const ids = headerRows.map((r) => r.id);
      const crRes = await db.select({ consignmentDoId: crTable.consignmentDoId }).from(crTable).where(and(inArray(crTable.consignmentDoId, ids), sql`${crTable.status} <> 'CANCELLED'`));
      for (const r of crRes) if (r.consignmentDoId) childIds.add(r.consignmentDoId);
    }
    const deliveryOrders = headerRows.map((r) => ({ ...toCnHeaderResponse(r), has_children: childIds.has(r.id) }));
    return c.json({ deliveryOrders });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

// ── Deliverable Consignment Order lines (From-Order multi-picker) ─────────
// STATIC path — MUST precede /:id.
app.get("/deliverable-order-lines", async (c) => {
  const db = getDb(c.env);
  try {
    const orders = await db.select({ docNo: coTable.docNo, debtorCode: coTable.debtorCode, debtorName: coTable.debtorName }).from(coTable).orderBy(desc(coTable.soDate)).limit(1000);
    if (orders.length === 0) return c.json({ lines: [] });
    const orderByDoc = new Map(orders.map((o) => [o.docNo, o]));
    const docNos = orders.map((o) => o.docNo);

    const items = await db.select({ id: coItemsTable.id, docNo: coItemsTable.docNo, itemCode: coItemsTable.itemCode, itemGroup: coItemsTable.itemGroup, description: coItemsTable.description, description2: coItemsTable.description2, uom: coItemsTable.uom, qty: coItemsTable.qty, unitPriceCenti: coItemsTable.unitPriceCenti, discountCenti: coItemsTable.discountCenti, unitCostCenti: coItemsTable.unitCostCenti, variants: coItemsTable.variants, cancelled: coItemsTable.cancelled }).from(coItemsTable).where(inArray(coItemsTable.docNo, docNos));
    const itemList = items.filter((it) => !it.cancelled);
    if (itemList.length === 0) return c.json({ lines: [] });
    const itemIds = itemList.map((it) => it.id);

    // Already-delivered per CO line — only count non-cancelled notes.
    const noteRows = await db.select({ id: cnTable.id }).from(cnTable).where(sql`${cnTable.status} <> 'CANCELLED'`);
    const liveNoteIds = new Set(noteRows.map((r) => r.id));
    const noteItems = await db.select({ consignmentDeliveryOrderId: cnItemsTable.consignmentDeliveryOrderId, consignmentSoItemId: cnItemsTable.consignmentSoItemId, qty: cnItemsTable.qty }).from(cnItemsTable).where(inArray(cnItemsTable.consignmentSoItemId, itemIds));
    const deliveredByItem = new Map<string, number>();
    for (const r of noteItems) {
      if (!r.consignmentSoItemId || !liveNoteIds.has(r.consignmentDeliveryOrderId)) continue;
      deliveredByItem.set(r.consignmentSoItemId, (deliveredByItem.get(r.consignmentSoItemId) ?? 0) + Number(r.qty ?? 0));
    }

    const lines = itemList.map((it) => {
      const o = orderByDoc.get(it.docNo);
      const ordered = Number(it.qty ?? 0);
      const delivered = deliveredByItem.get(it.id) ?? 0;
      return {
        orderItemId: it.id, orderDocNo: it.docNo, debtorCode: o?.debtorCode ?? null, debtorName: o?.debtorName ?? null,
        itemCode: it.itemCode, itemGroup: it.itemGroup ?? null, description: it.description ?? null, description2: it.description2 ?? null, uom: it.uom ?? null,
        ordered, delivered, outstanding: ordered - delivered, unitPriceCenti: Number(it.unitPriceCenti ?? 0), discountCenti: Number(it.discountCenti ?? 0), unitCostCenti: Number(it.unitCostCenti ?? 0), variants: it.variants ?? null,
      };
    }).filter((l) => l.outstanding > 0);

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
      db.select().from(cnTable).where(eq(cnTable.id, id)).limit(1),
      db.select().from(cnItemsTable).where(eq(cnItemsTable.consignmentDeliveryOrderId, id)).orderBy(asc(cnItemsTable.createdAt)),
    ]);
    const header = headerRows[0];
    if (!header) return c.json({ error: "not_found" }, 404);
    const { length: crCount } = await db.select({ id: crTable.id }).from(crTable).where(and(eq(crTable.consignmentDoId, id), sql`${crTable.status} <> 'CANCELLED'`)).limit(1);
    const consignmentNote = { ...toCnHeaderResponse(header), has_children: crCount > 0 };
    const lineWh = await resolveNoteLineWarehouses(db, itemRows.map((it) => ({ id: it.id, consignmentSoItemId: it.consignmentSoItemId })), header.warehouseId ?? null);
    const codeMap = await warehouseCodeMap(db, [...lineWh.values()]);
    const items = itemRows.map((it) => {
      const wid = lineWh.get(it.id) ?? null;
      return { ...toCnItemResponse(it), warehouse_id: wid, warehouse_code: wid ? codeMap.get(wid) ?? null : null };
    });
    return c.json({ deliveryOrder: consignmentNote, items });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

/* Insert the note header from a client body. Shared by POST / and from-order. */
async function insertHeader(db: Db, userId: number, body: Record<string, unknown>): Promise<CnHeaderDb> {
  const doNumber = await nextNum(db);
  const inserted = await db.insert(cnTable).values({
    doNumber,
    consignmentSoDocNo: (body.consignmentSoDocNo as string) ?? (body.soDocNo as string) ?? null,
    debtorCode: (body.debtorCode as string) ?? null,
    debtorName: (body.debtorName ?? body.customerName) as string,
    doDate: (body.doDate as string) ?? new Date().toISOString().slice(0, 10),
    expectedDeliveryAt: (body.expectedDeliveryAt as string) ?? (body.customerDeliveryDate as string) ?? null,
    customerDeliveryDate: (body.customerDeliveryDate as string) ?? null,
    driverId: (body.driverId as string) ?? null,
    driverName: (body.driverName as string) ?? null,
    vehicle: (body.vehicle as string) ?? null,
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
    poDocNo: (body.poDocNo as string) ?? null,
    salesLocation: (body.salesLocation as string) ?? null,
    note: (body.note as string) ?? null,
    emergencyContactName: (body.emergencyContactName as string) ?? null,
    emergencyContactPhone: (body.emergencyContactPhone as string) ?? null,
    emergencyContactRelationship: (body.emergencyContactRelationship as string) ?? null,
    warehouseId: (body.warehouseId as string) ?? null,
    currency: (((body.currency as string) ?? "MYR")) as never,
    // A Consignment Note means the loaner is OUT the moment it's created.
    status: "DISPATCHED",
    notes: (body.notes as string) ?? null,
    createdBy: userId,
  } as never).returning();
  return inserted[0];
}

// ── Create ──────────────────────────────────────────────────────────────
app.post("/", async (c) => {
  const db = getDb(c.env);
  const user = c.get("user");
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: "invalid_json" }, 400); }
  const debtorName = (body.debtorName ?? body.customerName) as string | undefined;
  if (!debtorName) return c.json({ error: "debtor_name_required" }, 400);
  const items = (body.items as Array<Record<string, unknown>> | undefined) ?? [];

  let header: CnHeaderDb;
  try { header = await insertHeader(db, user.id, body); } catch (e) { return c.json({ error: "insert_failed", reason: errMsg(e) }, 500); }

  if (items.length > 0) {
    try {
      await db.insert(cnItemsTable).values(items.map((it) => buildItemRow(header.id, it)) as never);
      await recomputeTotals(db, header.id);
    } catch (e) {
      await db.delete(cnTable).where(eq(cnTable.id, header.id));
      return c.json({ error: "items_insert_failed", reason: errMsg(e) }, 500);
    }
  }

  // Ship-out OUT (CS_DO) — idempotent + best-effort. A failed move never rolls back the note.
  const movementErrors = await resyncNoteInventory(db, header.id, user.id);

  return c.json({ id: header.id, doNumber: header.doNumber, movementErrors: movementErrors.length ? movementErrors : undefined }, 201);
});

// ── Convert picked CO LINES (partial qty) → ONE Consignment Note ───────────
app.post("/from-orders", async (c) => {
  const db = getDb(c.env);
  const user = c.get("user");
  let body: { picks?: Array<{ orderItemId?: string; soItemId?: string; qty?: number }> };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: "invalid_json" }, 400); }

  const pickQtyById = new Map<string, number>();
  for (const p of body.picks ?? []) { const sid = p?.orderItemId ?? p?.soItemId; if (!sid) continue; const q = Number(p.qty ?? 0); if (!(q > 0)) continue; pickQtyById.set(sid, (pickQtyById.get(sid) ?? 0) + q); }
  if (pickQtyById.size === 0) return c.json({ error: "picks_required" }, 400);

  const pickedIds = [...pickQtyById.keys()];
  const lineRows = await db.select({ id: coItemsTable.id, docNo: coItemsTable.docNo, itemCode: coItemsTable.itemCode, itemGroup: coItemsTable.itemGroup, description: coItemsTable.description, description2: coItemsTable.description2, uom: coItemsTable.uom, unitPriceCenti: coItemsTable.unitPriceCenti, discountCenti: coItemsTable.discountCenti, unitCostCenti: coItemsTable.unitCostCenti, variants: coItemsTable.variants }).from(coItemsTable).where(inArray(coItemsTable.id, pickedIds));
  const lineById = new Map(lineRows.map((l) => [l.id, l]));
  const missing = pickedIds.filter((id) => !lineById.has(id));
  if (missing.length > 0) return c.json({ error: "order_item_not_found", missing }, 404);

  const docNos = [...new Set(lineRows.map((l) => l.docNo))];
  const headers = await db.select().from(coTable).where(inArray(coTable.docNo, docNos));
  const headerByDoc = new Map(headers.map((h) => [h.docNo, h]));

  // One customer per Note.
  const custKey = (h: typeof headers[number] | undefined): string => (h?.debtorCode && h.debtorCode.trim() ? `code:${h.debtorCode.trim().toUpperCase()}` : `name:${(h?.debtorName ?? "").trim().toUpperCase()}`);
  const custSet = new Set(docNos.map((d) => custKey(headerByDoc.get(d))));
  if (custSet.size > 1) return c.json({ error: "mixed_customers", message: "All picked Consignment Order lines must belong to the same customer to combine into one Consignment Note." }, 400);

  const firstDoc = [...docNos].sort()[0]!;
  const head = headerByDoc.get(firstDoc);
  if (!head) return c.json({ error: "not_found" }, 404);

  let header: CnHeaderDb;
  try {
    header = await insertHeader(db, user.id, {
      consignmentSoDocNo: firstDoc, debtorCode: head.debtorCode, debtorName: head.debtorName ?? "Customer",
      address1: head.address1, address2: head.address2, city: head.city, customerState: head.customerState, customerCountry: head.customerCountry,
      postcode: head.postcode, phone: head.phone, salespersonId: head.salespersonId, agent: head.agent, email: head.email,
      customerType: head.customerType, buildingType: head.buildingType, branding: head.branding, venue: head.venue, venueId: head.venueId,
      ref: docNos.length > 1 ? `Merged from ${[...docNos].sort().join(", ")}` : head.ref, customerSoNo: head.customerSoNo, salesLocation: head.salesLocation,
      customerDeliveryDate: head.customerDeliveryDate, emergencyContactName: head.emergencyContactName, emergencyContactPhone: head.emergencyContactPhone, emergencyContactRelationship: head.emergencyContactRelationship,
      currency: head.currency,
    });
  } catch (e) {
    return c.json({ error: "insert_failed", reason: errMsg(e) }, 500);
  }

  const rows = pickedIds.map((id) => {
    const line = lineById.get(id)!;
    const qty = pickQtyById.get(id)!;
    return buildItemRow(header.id, { consignmentSoItemId: line.id, itemCode: line.itemCode, itemGroup: line.itemGroup, description: line.description, description2: line.description2, uom: line.uom ?? "UNIT", qty, unitPriceCenti: line.unitPriceCenti, discountCenti: 0, unitCostCenti: line.unitCostCenti, variants: line.variants });
  });
  try {
    await db.insert(cnItemsTable).values(rows as never);
    await recomputeTotals(db, header.id);
  } catch (e) {
    await db.delete(cnTable).where(eq(cnTable.id, header.id));
    return c.json({ error: "items_insert_failed", reason: errMsg(e) }, 500);
  }

  const movementErrors = await resyncNoteInventory(db, header.id, user.id);
  return c.json({ id: header.id, doNumber: header.doNumber, lineCount: rows.length, movementErrors: movementErrors.length ? movementErrors : undefined }, 201);
});

// ── Header PATCH ───────────────────────────────────────────────────────────
app.patch("/:id", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: "invalid_json" }, 400); }

  const MAP: Array<[string, string]> = [
    ["debtorCode", "debtorCode"], ["debtorName", "debtorName"], ["agent", "agent"], ["salesLocation", "salesLocation"], ["ref", "ref"], ["poDocNo", "poDocNo"],
    ["venue", "venue"], ["venueId", "venueId"], ["branding", "branding"], ["address1", "address1"], ["address2", "address2"],
    ["city", "city"], ["state", "state"], ["postcode", "postcode"], ["phone", "phone"], ["note", "note"], ["notes", "notes"],
    ["soDate", "doDate"], ["doDate", "doDate"], ["currency", "currency"], ["customerState", "customerState"], ["customerCountry", "customerCountry"], ["customerSoNo", "customerSoNo"],
    ["customerDeliveryDate", "customerDeliveryDate"], ["expectedDeliveryAt", "expectedDeliveryAt"], ["email", "email"], ["customerType", "customerType"],
    ["salespersonId", "salespersonId"], ["buildingType", "buildingType"], ["driverId", "driverId"], ["driverName", "driverName"], ["vehicle", "vehicle"],
    ["emergencyContactName", "emergencyContactName"], ["emergencyContactPhone", "emergencyContactPhone"], ["emergencyContactRelationship", "emergencyContactRelationship"],
  ];
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  for (const [from, to] of MAP) if (body[from] !== undefined) updates[to] = body[from];
  if (Object.keys(updates).length === 1) return c.json({ ok: true, changed: 0 });

  const headerLock = await noteHasDownstream(db, id);
  if (headerLock) return c.json(headerLock, 409);

  try {
    const updated = await db.update(cnTable).set(updates).where(eq(cnTable.id, id)).returning({ id: cnTable.id });
    if (!updated[0]) return c.json({ error: "not_found" }, 404);
    return c.json({ ok: true, id });
  } catch (e) {
    return c.json({ error: "update_failed", reason: errMsg(e) }, 500);
  }
});

// ── Item CRUD ─────────────────────────────────────────────────────────────
app.post("/:id/items", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const user = c.get("user");
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: "invalid_json" }, 400); }
  if (!it.itemCode) return c.json({ error: "item_code_required" }, 400);

  const childLock = await noteHasDownstream(db, id);
  if (childLock) return c.json(childLock, 409);

  const headerRows = await db.select({ id: cnTable.id }).from(cnTable).where(eq(cnTable.id, id)).limit(1);
  if (!headerRows[0]) return c.json({ error: "not_found" }, 404);

  try {
    const inserted = await db.insert(cnItemsTable).values(buildItemRow(id, it) as never).returning();
    await recomputeTotals(db, id);
    try { await resyncNoteInventory(db, id, user?.id ?? null); } catch { /* best-effort */ }
    return c.json({ item: toCnItemResponse(inserted[0]) }, 201);
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

  const childLock = await noteHasDownstream(db, id);
  if (childLock) return c.json(childLock, 409);

  const prevRows = await db.select({ qty: cnItemsTable.qty, unitPriceCenti: cnItemsTable.unitPriceCenti, discountCenti: cnItemsTable.discountCenti, unitCostCenti: cnItemsTable.unitCostCenti }).from(cnItemsTable).where(eq(cnItemsTable.id, itemId)).limit(1);
  const prev = prevRows[0];
  if (!prev) return c.json({ error: "not_found" }, 404);

  const qty = it.qty !== undefined ? Number(it.qty) : Number(prev.qty);
  const unitPrice = it.unitPriceCenti !== undefined ? Number(it.unitPriceCenti) : Number(prev.unitPriceCenti);
  const discount = it.discountCenti !== undefined ? Number(it.discountCenti) : Number(prev.discountCenti);
  const unitCost = it.unitCostCenti !== undefined ? Number(it.unitCostCenti) : Number(prev.unitCostCenti);
  const lineTotal = qty * unitPrice - discount;
  const lineCost = qty * unitCost;

  const updates: Record<string, unknown> = { qty, unitPriceCenti: unitPrice, discountCenti: discount, unitCostCenti: unitCost, lineTotalCenti: lineTotal, lineCostCenti: lineCost, lineMarginCenti: lineTotal - lineCost };
  for (const [from, to] of [["itemCode", "itemCode"], ["itemGroup", "itemGroup"], ["description", "description"], ["description2", "description2"], ["uom", "uom"], ["variants", "variants"], ["notes", "notes"], ["lineDeliveryDate", "lineDeliveryDate"]] as const) {
    if (it[from] !== undefined) updates[to] = it[from];
  }
  if (it.lineDeliveryDate !== undefined) updates.lineDeliveryDateOverridden = true;
  if (it.lineDeliveryDateOverridden !== undefined) updates.lineDeliveryDateOverridden = Boolean(it.lineDeliveryDateOverridden);

  try {
    await db.update(cnItemsTable).set(updates).where(eq(cnItemsTable.id, itemId));
    await recomputeTotals(db, id);
    try { await resyncNoteInventory(db, id, user?.id ?? null); } catch { /* best-effort */ }
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

  const childLock = await noteHasDownstream(db, id);
  if (childLock) return c.json(childLock, 409);

  try {
    await db.delete(cnItemsTable).where(eq(cnItemsTable.id, itemId));
    await recomputeTotals(db, id);
    try { await resyncNoteInventory(db, id, user?.id ?? null); } catch { /* best-effort */ }
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: "delete_failed", reason: errMsg(e) }, 500);
  }
});

// ── Payments (mirror DO payments ledger) ──────────────────────────────────
const PAYMENT_SELECT = {
  id: cnPaymentsTable.id, consignment_delivery_order_id: cnPaymentsTable.consignmentDeliveryOrderId, paid_at: cnPaymentsTable.paidAt, method: cnPaymentsTable.method,
  merchant_provider: cnPaymentsTable.merchantProvider, installment_months: cnPaymentsTable.installmentMonths, online_type: cnPaymentsTable.onlineType,
  approval_code: cnPaymentsTable.approvalCode, amount_centi: cnPaymentsTable.amountCenti, account_sheet: cnPaymentsTable.accountSheet,
  collected_by: cnPaymentsTable.collectedBy, note: cnPaymentsTable.note, created_at: cnPaymentsTable.createdAt, created_by: cnPaymentsTable.createdBy,
} as const;

app.get("/:id/payments", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  try {
    const rows = await db.select(PAYMENT_SELECT).from(cnPaymentsTable).where(eq(cnPaymentsTable.consignmentDeliveryOrderId, id)).orderBy(desc(cnPaymentsTable.paidAt), desc(cnPaymentsTable.createdAt));
    const ids = [...new Set(rows.map((r) => r.collected_by).filter((x): x is number => x != null))];
    const nameById = new Map<number, string | null>();
    if (ids.length > 0) { const us = await db.select({ id: usersTable.id, name: usersTable.name }).from(usersTable).where(inArray(usersTable.id, ids)); for (const u of us) nameById.set(u.id, u.name ?? null); }
    return c.json({ payments: rows.map((r) => ({ ...r, created_at: isoOrNull(r.created_at), collected_by_name: r.collected_by != null ? nameById.get(r.collected_by) ?? null : null })) });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

const paymentCreateSchema = z.object({
  paidAt: z.string().min(1),
  method: z.enum(["merchant", "transfer", "cash", "installment"]),
  merchantProvider: z.string().trim().min(1).optional().nullable(),
  installmentMonths: z.number().int().min(0).max(60).optional().nullable(),
  onlineType: z.string().trim().min(1).optional().nullable(),
  approvalCode: z.string().optional().nullable(),
  amountCenti: z.number().int().nonnegative(),
  accountSheet: z.string().optional().nullable(),
  collectedBy: z.number().int().optional().nullable(),
  note: z.string().optional().nullable(),
});

app.post("/:id/payments", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const user = c.get("user");
  const doc = await db.select({ id: cnTable.id }).from(cnTable).where(eq(cnTable.id, id)).limit(1);
  if (!doc[0]) return c.json({ error: "consignment_note_not_found" }, 404);

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }
  const parsed = paymentCreateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
  const p = parsed.data;
  const merchantLike = p.method === "merchant" || p.method === "installment";
  const merchantProvider = merchantLike ? p.merchantProvider ?? null : null;
  const installmentMonths = merchantLike ? (typeof p.installmentMonths === "number" && p.installmentMonths > 0 ? p.installmentMonths : null) : null;
  const onlineType = p.method === "transfer" ? p.onlineType ?? null : null;

  try {
    const inserted = await db.insert(cnPaymentsTable).values({ consignmentDeliveryOrderId: id, paidAt: p.paidAt, method: p.method, merchantProvider, installmentMonths, onlineType, approvalCode: p.approvalCode ?? null, amountCenti: p.amountCenti, accountSheet: p.accountSheet ?? null, collectedBy: p.collectedBy ?? null, note: p.note ?? null, createdBy: user.id } as never).returning(PAYMENT_SELECT);
    return c.json({ payment: { ...inserted[0], created_at: isoOrNull(inserted[0].created_at) } }, 201);
  } catch (e) {
    return c.json({ error: "insert_failed", reason: errMsg(e) }, 500);
  }
});

app.delete("/:id/payments/:paymentId", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const paymentId = c.req.param("paymentId");
  const rows = await db.select({ consignmentDeliveryOrderId: cnPaymentsTable.consignmentDeliveryOrderId }).from(cnPaymentsTable).where(eq(cnPaymentsTable.id, paymentId)).limit(1);
  if (!rows[0]) return c.json({ error: "not_found" }, 404);
  if (rows[0].consignmentDeliveryOrderId !== id) return c.json({ error: "payment_doc_mismatch" }, 400);
  try {
    await db.delete(cnPaymentsTable).where(eq(cnPaymentsTable.id, paymentId));
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: "delete_failed", reason: errMsg(e) }, 500);
  }
});

// ── Status transition + ship-out / reversal ────────────────────────────────
app.patch("/:id/status", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const user = c.get("user");
  let body: { status?: string };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: "invalid_json" }, 400); }
  if (!body.status) return c.json({ error: "status_required" }, 400);

  const cur = await db.select({ status: cnTable.status }).from(cnTable).where(eq(cnTable.id, id)).limit(1);
  if (!cur[0]) return c.json({ error: "not_found" }, 404);
  const prevStatus = cur[0].status as string;
  if (body.status === "CANCELLED" && prevStatus === "CANCELLED") return c.json({ consignmentNote: { id, status: "CANCELLED" } });

  if (body.status === "CANCELLED") {
    const childLock = await noteHasDownstream(db, id);
    if (childLock) return c.json(childLock, 409);
  }

  const now = new Date();
  const ts: Record<string, unknown> = { status: body.status, updatedAt: now };
  if (body.status === "DISPATCHED") ts.dispatchedAt = now;
  if (body.status === "SIGNED") ts.signedAt = now;
  if (body.status === "DELIVERED") ts.deliveredAt = now;

  let data: { id: string; status: string } | null;
  if (body.status === "CANCELLED") {
    const updated = await db.update(cnTable).set(ts).where(and(eq(cnTable.id, id), sql`${cnTable.status} <> 'CANCELLED'`)).returning({ id: cnTable.id, status: cnTable.status });
    if (!updated[0]) return c.json({ consignmentNote: { id, status: "CANCELLED" } });
    data = updated[0] as { id: string; status: string };
  } else {
    const updated = await db.update(cnTable).set(ts).where(eq(cnTable.id, id)).returning({ id: cnTable.id, status: cnTable.status });
    if (!updated[0]) return c.json({ error: "not_found" }, 404);
    data = updated[0] as { id: string; status: string };
  }

  // One self-healing resync covers BOTH ship-out (first shipped state writes CS_DO)
  // and cancel (status CANCELLED drives net back to 0). Idempotent + best-effort.
  if (SHIPPED_STATES.includes(body.status) || body.status === "CANCELLED") {
    try { await resyncNoteInventory(db, id, user.id); } catch { /* best-effort */ }
  }

  return c.json({ consignmentNote: data });
});

export default app;
