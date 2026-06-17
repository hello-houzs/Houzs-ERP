// ----------------------------------------------------------------------------
// /mfg-delivery-orders — Delivery Orders sent to customers (B2B sales side).
//
// 1:1 clone of 2990s apps/api/src/routes/delivery-orders-mfg.ts (itself a Sales
// Order clone): editable SO-style header, line CRUD, a payments ledger, a
// recomputeTotals rollup, and ROBUST + IDEMPOTENT inventory deduction on the
// first transition into any shipped state. Endpoints, request bodies, response
// JSON shapes, status codes and business rules are kept identical. SEAMS only:
//   - DB: 2990s per-request Supabase PostgREST -> Houzs Drizzle (getDb(c.env),
//     rule #3); every .from().select/insert/update becomes a Drizzle query.
//   - Auth: Supabase-JWT/RLS -> requirePermission("*") (rule #4).
//   - Actors: staff.id (uuid) -> users.id (integer) from c.get("user") (rule #4).
//   - Mount: /api/mfg-delivery-orders (the bare /api/delivery is Houzs's existing
//     AutoCount logistics route — NOT touched).
//   - Inventory: writeMovements / reverseMovements from lib/inventory-movements
//     (source_doc_type:'DO'), warehouse per SO line (mfg_warehouses).
//
// Strategy-2 product-layer simplifications (Houzs is not the 2990s furniture
// business — see docs/scm-clone/PLAN.md):
//   - DROPPED the catalog itemCode guard (validateItemCodes), the soft
//     stock-availability check (checkStockAvailability) + its confirmShortStock
//     gate, and the sofa-batch / whole-set guards (findSofaLinesWithoutCompleteBatch
//     / findIncompleteSofaSets / loadSofaBatchStock) — all furniture-coupled.
//   - DROPPED the sofa dye-lot batch tracking (allocated_batch_no on the OUT
//     movement). A line's variant_key is the generic shared computeVariantKey;
//     description2 passes through. restampDoActualCost is ported (generic —
//     stamps each line's REAL FIFO cost from the booked OUT rows so Margin is
//     real), minus the sofa-batch bucket dimension.
//   - buildVariantSummary (furniture description-2 formatter) dropped:
//     description2 is whatever the client sends.
// ----------------------------------------------------------------------------

import { Hono } from "hono";
import { z } from "zod";
import { and, asc, desc, eq, inArray, like, sql } from "drizzle-orm";
import type { Env } from "../types";
import { getDb } from "../db/client";
import {
  deliveryOrders as doTable,
  deliveryOrderItems as doItemsTable,
  deliveryOrderPayments as doPaymentsTable,
  salesInvoices as siTable,
  salesInvoiceItems as siItemsTable,
  deliveryReturns as drTable,
  deliveryReturnItems as drItemsTable,
  mfgSalesOrders as soTable,
  mfgSalesOrderItems as soItemsTable,
  mfgWarehouses as warehousesTable,
  users as usersTable,
} from "../db/schema";
import { requirePermission } from "../middleware/auth";
import { writeMovements, defaultWarehouseId } from "../lib/inventory-movements";
import { syncSoDeliveredFromDo } from "../lib/so-delivery-sync";
import { recomputeSoStockAllocation } from "../lib/so-stock-allocation";
import { isServiceLine } from "../lib/service-sku";
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

/* DO statuses that count as "shipped" — goods have left, so stock has been
   deducted. The FIRST transition into ANY of these fires the inventory OUT. */
const SHIPPED_STATES = ["DISPATCHED", "IN_TRANSIT", "SIGNED", "DELIVERED", "INVOICED"];

/* ── Response shaping (Drizzle camelCase -> snake_case wire, rule #7). ──────── */
type DoHeaderDb = typeof doTable.$inferSelect;
type DoItemDb = typeof doItemsTable.$inferSelect;

function toDoHeaderResponse(p: DoHeaderDb): Record<string, unknown> {
  return {
    id: p.id,
    do_number: p.doNumber,
    so_doc_no: p.soDocNo,
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
    service_centi: p.serviceCenti,
    mattress_sofa_cost_centi: p.mattressSofaCostCenti,
    bedframe_cost_centi: p.bedframeCostCenti,
    accessories_cost_centi: p.accessoriesCostCenti,
    others_cost_centi: p.othersCostCenti,
    service_cost_centi: p.serviceCostCenti,
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
function toDoItemResponse(it: DoItemDb): Record<string, unknown> {
  return {
    id: it.id,
    delivery_order_id: it.deliveryOrderId,
    so_item_id: it.soItemId,
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
    line_no: it.lineNo,
    created_at: isoOrNull(it.createdAt),
  };
}

/* ── DO child-lock guard (Tier 2 — downstream lock) ─────────────────────────
   A DO locks (no line edit / no CANCELLED transition) once it has ANY
   non-cancelled Delivery Return OR Sales Invoice referencing it. Convert-to-DR
   / convert-to-SI is NOT gated by this. Returns the blocking JSON, or null. */
async function doHasDownstream(db: Db, doId: string): Promise<{ error: string; message: string } | null> {
  const [drRows, siRows] = await Promise.all([
    db.select({ id: drTable.id }).from(drTable).where(and(eq(drTable.deliveryOrderId, doId), sql`${drTable.status} <> 'CANCELLED'`)).limit(1),
    db.select({ id: siTable.id }).from(siTable).where(and(eq(siTable.deliveryOrderId, doId), sql`${siTable.status} <> 'CANCELLED'`)).limit(1),
  ]);
  if (drRows.length > 0 || siRows.length > 0) {
    return { error: "do_has_downstream", message: "DO has a Delivery Return / Sales Invoice — delete or cancel it first to edit" };
  }
  return null;
}

const nextNum = async (db: Db): Promise<string> => {
  const d = new Date();
  const yymm = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, "0")}`;
  const rows = await db.select({ doNumber: doTable.doNumber }).from(doTable).where(like(doTable.doNumber, `DO-${yymm}-%`));
  let maxN = 0;
  for (const r of rows) {
    const m = /-(\d+)$/.exec(r.doNumber);
    if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
  }
  return `DO-${yymm}-${String(maxN + 1).padStart(3, "0")}`;
};

/* Re-derive the DO header's per-category revenue/cost totals + grand total from
   its line items. Mirrors the SO recomputeTotals plain per-category rollup. */
async function recomputeTotals(db: Db, deliveryOrderId: string): Promise<void> {
  const items = await db
    .select({ itemCode: doItemsTable.itemCode, itemGroup: doItemsTable.itemGroup, lineTotalCenti: doItemsTable.lineTotalCenti, lineCostCenti: doItemsTable.lineCostCenti })
    .from(doItemsTable)
    .where(eq(doItemsTable.deliveryOrderId, deliveryOrderId));
  let mattressSofa = 0, bedframe = 0, accessories = 0, others = 0, service = 0, total = 0, totalCost = 0;
  let mattressSofaCost = 0, bedframeCost = 0, accessoriesCost = 0, othersCost = 0, serviceCost = 0;
  for (const it of items) {
    const lineTotal = Number(it.lineTotalCenti ?? 0);
    const lineCost = Number(it.lineCostCenti ?? 0);
    total += lineTotal;
    totalCost += lineCost;
    const g = (it.itemGroup ?? "").toLowerCase();
    if (isServiceLine({ itemGroup: g, itemCode: it.itemCode })) { service += lineTotal; serviceCost += lineCost; }
    else if (g.includes("mattress") || g.includes("sofa")) { mattressSofa += lineTotal; mattressSofaCost += lineCost; }
    else if (g.includes("bedframe")) { bedframe += lineTotal; bedframeCost += lineCost; }
    else if (g.includes("accessor")) { accessories += lineTotal; accessoriesCost += lineCost; }
    else { others += lineTotal; othersCost += lineCost; }
  }
  const margin = total - totalCost;
  await db.update(doTable).set({
    mattressSofaCenti: mattressSofa, bedframeCenti: bedframe, accessoriesCenti: accessories, othersCenti: others, serviceCenti: service,
    mattressSofaCostCenti: mattressSofaCost, bedframeCostCenti: bedframeCost, accessoriesCostCenti: accessoriesCost, othersCostCenti: othersCost, serviceCostCenti: serviceCost,
    localTotalCenti: total, totalCostCenti: totalCost, totalMarginCenti: margin,
    marginPctBasis: total > 0 ? Math.round((margin / total) * 10000) : 0, lineCount: items.length, updatedAt: new Date(),
  }).where(eq(doTable.id, deliveryOrderId));
}

/* resolveDoLineWarehouses — PER-WAREHOUSE correctness for the OUTBOUND side. A
   DO line ships from its linked SO line's warehouse (mfg_sales_order_items.
   warehouse_id), else the DO header's warehouse, else the global default. */
async function resolveDoLineWarehouses(db: Db, items: Array<{ id: string; soItemId?: string | null }>, headerWarehouseId: string | null): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const soItemIds = [...new Set(items.map((it) => it.soItemId ?? null).filter((x): x is string => !!x))];
  const soWh = new Map<string, string | null>();
  if (soItemIds.length > 0) {
    const soRows = await db.select({ id: soItemsTable.id, warehouseId: soItemsTable.warehouseId }).from(soItemsTable).where(inArray(soItemsTable.id, soItemIds));
    for (const r of soRows) soWh.set(r.id, r.warehouseId ?? null);
  }
  const fallback = headerWarehouseId ?? (await defaultWarehouseId(db));
  for (const it of items) {
    const fromSo = it.soItemId ? soWh.get(it.soItemId) ?? null : null;
    out.set(it.id, fromSo ?? fallback);
  }
  return out;
}

/* warehouseCodeMap — warehouse_id -> display code for the detail GET. */
async function warehouseCodeMap(db: Db, ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const uniq = [...new Set(ids.filter((x): x is string => !!x))];
  if (uniq.length === 0) return out;
  const rows = await db.select({ id: warehousesTable.id, code: warehousesTable.code, name: warehousesTable.name }).from(warehousesTable).where(inArray(warehousesTable.id, uniq));
  for (const w of rows) out.set(w.id, w.code ?? w.name ?? "");
  return out;
}

/* restampDoActualCost — replace a shipped DO's line costs (copied from the SO)
   with the REAL FIFO cost the inventory trigger booked when the goods left, so
   Margin reflects reality. actual unit cost per (warehouse, product, variant)
   bucket = net OUT cost ÷ net OUT qty across THIS DO's own movements. Only
   SHIPPED DOs have OUT movements. Best-effort. (Generic — the sofa dye-lot batch
   dimension is dropped per Strategy-2.) */
async function restampDoActualCost(db: Db, deliveryOrderId: string): Promise<void> {
  try {
    const hdr = await db.select({ status: doTable.status, warehouseId: doTable.warehouseId }).from(doTable).where(eq(doTable.id, deliveryOrderId)).limit(1);
    if (!hdr[0]) return;
    if (!SHIPPED_STATES.includes((hdr[0].status ?? "").toUpperCase())) return;
    const headerWarehouseId = hdr[0].warehouseId ?? null;
    const items = await db
      .select({ id: doItemsTable.id, soItemId: doItemsTable.soItemId, itemCode: doItemsTable.itemCode, qty: doItemsTable.qty, itemGroup: doItemsTable.itemGroup, variants: doItemsTable.variants, lineTotalCenti: doItemsTable.lineTotalCenti })
      .from(doItemsTable)
      .where(eq(doItemsTable.deliveryOrderId, deliveryOrderId));
    if (items.length === 0) return;
    const lineWh = await resolveDoLineWarehouses(db, items, headerWarehouseId);

    const movs = await db.execute<{ movement_type: string; warehouse_id: string; product_code: string; variant_key: string | null; qty: number; total_cost_sen: number | null }>(
      sql`SELECT movement_type, warehouse_id, product_code, variant_key, qty, total_cost_sen
          FROM inventory_movements WHERE source_doc_type = 'DO' AND source_doc_id = ${deliveryOrderId}`,
    );
    type Agg = { net_qty: number; net_cost: number };
    const aggByBucket = new Map<string, Agg>();
    for (const m of movs) {
      const k = `${m.warehouse_id}::${m.product_code}::${m.variant_key ?? ""}`;
      let agg = aggByBucket.get(k);
      if (!agg) { agg = { net_qty: 0, net_cost: 0 }; aggByBucket.set(k, agg); }
      const q = Number(m.qty ?? 0);
      const cost = Number(m.total_cost_sen ?? 0);
      if (m.movement_type === "OUT") { agg.net_qty += q; agg.net_cost += cost; }
      else if (m.movement_type === "IN") { agg.net_qty -= q; agg.net_cost -= cost; }
    }
    for (const it of items) {
      const warehouseId = lineWh.get(it.id) ?? null;
      if (!warehouseId) continue;
      const variantKey = computeVariantKey(it.itemGroup, (it.variants as VariantAttrs | null) ?? null);
      const k = `${warehouseId}::${it.itemCode}::${variantKey}`;
      const agg = aggByBucket.get(k);
      if (!agg || agg.net_qty <= 0) continue;
      const unitCost = Math.round(agg.net_cost / agg.net_qty);
      const qty = Number(it.qty ?? 0);
      const lineTotal = Number(it.lineTotalCenti ?? 0);
      const lineCost = unitCost * qty;
      await db.update(doItemsTable).set({ unitCostCenti: unitCost, lineCostCenti: lineCost, lineMarginCenti: lineTotal - lineCost }).where(eq(doItemsTable.id, it.id));
    }
    await recomputeTotals(db, deliveryOrderId);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[restampDoActualCost] failed:", e);
  }
}

/* Deduct inventory for a DO exactly once. ROBUST: fires on the first transition
   into ANY shipped state. IDEMPOTENT: an existence check on the DO id skips
   re-deduction. Best-effort. Each line ships from its SO line's warehouse. */
async function deductInventoryForDo(db: Db, deliveryOrderId: string, performedBy: number | null): Promise<void> {
  const existing = await db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM inventory_movements WHERE source_doc_type = 'DO' AND source_doc_id = ${deliveryOrderId} AND movement_type = 'OUT'`,
  );
  if (Number(existing[0]?.n ?? 0) > 0) return;

  const hdr = await db.select({ doNumber: doTable.doNumber, warehouseId: doTable.warehouseId }).from(doTable).where(eq(doTable.id, deliveryOrderId)).limit(1);
  const items = await db
    .select({ id: doItemsTable.id, soItemId: doItemsTable.soItemId, itemCode: doItemsTable.itemCode, description: doItemsTable.description, qty: doItemsTable.qty, itemGroup: doItemsTable.itemGroup, variants: doItemsTable.variants })
    .from(doItemsTable)
    .where(eq(doItemsTable.deliveryOrderId, deliveryOrderId));
  const headerWarehouseId = hdr[0]?.warehouseId ?? null;
  const doNo = hdr[0]?.doNumber ?? deliveryOrderId;
  if (items.length === 0) return;

  const lineWh = await resolveDoLineWarehouses(db, items, headerWarehouseId);

  const byKey = new Map<string, { warehouse_id: string; product_code: string; variant_key: string; product_name: string | null; qty: number }>();
  for (const it of items) {
    if (isServiceLine({ itemGroup: it.itemGroup, itemCode: it.itemCode })) continue; // SERVICE lines never deduct stock
    const qty = Number(it.qty ?? 0);
    if (qty <= 0) continue;
    const warehouseId = lineWh.get(it.id) ?? null;
    if (!warehouseId) continue;
    const variantKey = computeVariantKey(it.itemGroup, (it.variants as VariantAttrs | null) ?? null);
    const k = `${warehouseId}::${it.itemCode}::${variantKey}`;
    const cur = byKey.get(k);
    if (cur) cur.qty += qty;
    else byKey.set(k, { warehouse_id: warehouseId, product_code: it.itemCode, variant_key: variantKey, product_name: it.description, qty });
  }
  const movements = [...byKey.values()].map((m) => ({
    movement_type: "OUT" as const,
    warehouse_id: m.warehouse_id,
    product_code: m.product_code,
    variant_key: m.variant_key,
    product_name: m.product_name,
    qty: m.qty,
    source_doc_type: "DO" as const,
    source_doc_id: deliveryOrderId,
    source_doc_no: doNo,
    performed_by: performedBy,
  }));
  if (movements.length > 0) {
    await writeMovements(db, movements);
    await restampDoActualCost(db, deliveryOrderId);
    try { await recomputeSoStockAllocation(db); } catch (e) { /* eslint-disable-next-line no-console */ console.error("[so-allocation] post-do-ship failed:", e); }
  }
}

/* resyncInventoryForDo — bring inventory in line with the CURRENT shape of a
   SHIPPED DO's lines after a line qty/add/delete. Writes DELTA movements (IN to
   give stock back, OUT to take more) so net OUT per bucket matches the live sum
   of active lines. IDEMPOTENT (delta 0 -> no writes). Non-shipped DOs skip. */
async function resyncInventoryForDo(db: Db, deliveryOrderId: string, performedBy: number | null): Promise<void> {
  const hdr = await db.select({ doNumber: doTable.doNumber, status: doTable.status, warehouseId: doTable.warehouseId }).from(doTable).where(eq(doTable.id, deliveryOrderId)).limit(1);
  if (!hdr[0]) return;
  if (!SHIPPED_STATES.includes((hdr[0].status ?? "").toUpperCase())) return;
  const headerWarehouseId = hdr[0].warehouseId ?? null;
  const doNo = hdr[0].doNumber;

  const items = await db
    .select({ id: doItemsTable.id, soItemId: doItemsTable.soItemId, itemCode: doItemsTable.itemCode, description: doItemsTable.description, qty: doItemsTable.qty, itemGroup: doItemsTable.itemGroup, variants: doItemsTable.variants })
    .from(doItemsTable)
    .where(eq(doItemsTable.deliveryOrderId, deliveryOrderId));
  const lineWh = await resolveDoLineWarehouses(db, items, headerWarehouseId);

  type Bucket = { warehouse_id: string; product_code: string; variant_key: string; product_name: string | null; qty: number };
  const targetByBucket = new Map<string, Bucket>();
  for (const it of items) {
    if (isServiceLine({ itemGroup: it.itemGroup, itemCode: it.itemCode })) continue;
    const qty = Number(it.qty ?? 0);
    if (qty <= 0) continue;
    const warehouseId = lineWh.get(it.id) ?? null;
    if (!warehouseId) continue;
    const variant_key = computeVariantKey(it.itemGroup, (it.variants as VariantAttrs | null) ?? null);
    const k = `${warehouseId}::${it.itemCode}::${variant_key}`;
    const cur = targetByBucket.get(k);
    if (cur) cur.qty += qty;
    else targetByBucket.set(k, { warehouse_id: warehouseId, product_code: it.itemCode, variant_key, product_name: it.description, qty });
  }

  const movs = await db.execute<{ movement_type: string; warehouse_id: string; product_code: string; variant_key: string | null; qty: number; total_cost_sen: number | null; product_name: string | null }>(
    sql`SELECT movement_type, warehouse_id, product_code, variant_key, qty, total_cost_sen, product_name
        FROM inventory_movements WHERE source_doc_type = 'DO' AND source_doc_id = ${deliveryOrderId}`,
  );
  type Agg = { out_qty: number; in_qty: number; out_total_cost: number; product_name: string | null };
  const aggByBucket = new Map<string, Agg>();
  for (const m of movs) {
    const k = `${m.warehouse_id}::${m.product_code}::${m.variant_key ?? ""}`;
    let agg = aggByBucket.get(k);
    if (!agg) { agg = { out_qty: 0, in_qty: 0, out_total_cost: 0, product_name: m.product_name }; aggByBucket.set(k, agg); }
    if (m.movement_type === "OUT") { agg.out_qty += Number(m.qty ?? 0); agg.out_total_cost += Number(m.total_cost_sen ?? 0); }
    else if (m.movement_type === "IN") { agg.in_qty += Number(m.qty ?? 0); }
    if (!agg.product_name) agg.product_name = m.product_name;
  }

  const allKeys = new Set<string>([...targetByBucket.keys(), ...aggByBucket.keys()]);
  type MovOut = Parameters<typeof writeMovements>[1][number];
  const writes: MovOut[] = [];
  for (const k of allKeys) {
    const t = targetByBucket.get(k);
    const a = aggByBucket.get(k) ?? { out_qty: 0, in_qty: 0, out_total_cost: 0, product_name: null };
    const target_qty = t?.qty ?? 0;
    const current_net_out = a.out_qty - a.in_qty;
    const delta = target_qty - current_net_out;
    if (delta === 0) continue;
    const parts = k.split("::");
    const warehouse_id = parts[0] ?? "";
    const product_code = parts[1] ?? "";
    const variant_key = parts[2] ?? "";
    const product_name = t?.product_name ?? a.product_name ?? null;
    if (delta > 0) {
      writes.push({ movement_type: "OUT", warehouse_id, product_code, variant_key, product_name, qty: delta, source_doc_type: "DO", source_doc_id: deliveryOrderId, source_doc_no: doNo, performed_by: performedBy, notes: "Resync: line qty increased / line added (shipped DO)." });
    } else {
      const unit_cost_sen = a.out_qty > 0 ? Math.round(a.out_total_cost / a.out_qty) : 0;
      writes.push({ movement_type: "IN", warehouse_id, product_code, variant_key, product_name, qty: -delta, unit_cost_sen, source_doc_type: "DO", source_doc_id: deliveryOrderId, source_doc_no: doNo, performed_by: performedBy, notes: "Resync: line qty reduced / line deleted (shipped DO)." });
    }
  }
  if (writes.length > 0) {
    await writeMovements(db, writes);
    await restampDoActualCost(db, deliveryOrderId);
    try { await recomputeSoStockAllocation(db); } catch (e) { /* eslint-disable-next-line no-console */ console.error("[so-allocation] post-do-resync failed:", e); }
  }
}

/* reverseInventoryForDo — REVERSE a DO's inventory OUT when CANCELLED, by writing
   a positive ADJUSTMENT per bucket (qty = +net_out) so on-hand comes back.
   net_out = Σ OUT − Σ IN across THIS DO's movements. IDEMPOTENT (a prior
   ADJUSTMENT tagged with this DO id skips). Best-effort. */
async function reverseInventoryForDo(db: Db, deliveryOrderId: string, performedBy: number | null): Promise<void> {
  const existing = await db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM inventory_movements WHERE source_doc_type = 'ADJUSTMENT' AND source_doc_id = ${deliveryOrderId}`,
  );
  if (Number(existing[0]?.n ?? 0) > 0) return;

  const hdr = await db.select({ doNumber: doTable.doNumber }).from(doTable).where(eq(doTable.id, deliveryOrderId)).limit(1);
  const doNo = hdr[0]?.doNumber ?? deliveryOrderId;

  const movs = await db.execute<{ movement_type: string; warehouse_id: string; product_code: string; variant_key: string | null; qty: number; total_cost_sen: number | null; product_name: string | null }>(
    sql`SELECT movement_type, warehouse_id, product_code, variant_key, qty, total_cost_sen, product_name
        FROM inventory_movements WHERE source_doc_type = 'DO' AND source_doc_id = ${deliveryOrderId}`,
  );
  type Agg = { warehouse_id: string; product_code: string; variant_key: string; product_name: string | null; net_out: number; out_total_cost: number; out_qty: number };
  const byBucket = new Map<string, Agg>();
  for (const m of movs) {
    if (m.movement_type !== "IN" && m.movement_type !== "OUT") continue;
    const variant_key = m.variant_key ?? "";
    const k = `${m.warehouse_id}::${m.product_code}::${variant_key}`;
    let agg = byBucket.get(k);
    if (!agg) { agg = { warehouse_id: m.warehouse_id, product_code: m.product_code, variant_key, product_name: m.product_name, net_out: 0, out_total_cost: 0, out_qty: 0 }; byBucket.set(k, agg); }
    const q = Number(m.qty ?? 0);
    if (m.movement_type === "OUT") { agg.net_out += q; agg.out_total_cost += Number(m.total_cost_sen ?? 0); agg.out_qty += q; }
    else { agg.net_out -= q; }
    if (!agg.product_name) agg.product_name = m.product_name;
  }
  const movements = [...byBucket.values()].filter((b) => b.net_out > 0).map((b) => ({
    movement_type: "ADJUSTMENT" as const,
    warehouse_id: b.warehouse_id,
    product_code: b.product_code,
    variant_key: b.variant_key,
    product_name: b.product_name,
    qty: b.net_out,
    unit_cost_sen: b.out_qty > 0 ? Math.round(b.out_total_cost / b.out_qty) : 0,
    source_doc_type: "ADJUSTMENT" as const,
    source_doc_id: deliveryOrderId,
    source_doc_no: doNo,
    performed_by: performedBy,
    notes: `Delivery order ${doNo} cancelled — reversing shipment (stock returned to shelf)`,
  }));
  if (movements.length > 0) await writeMovements(db, movements);
}

/* doLineConsumedQty — Σ invoiced + Σ returned for a DO line (the downstream
   floor below which the line can't shrink / be deleted). Cancelled SI/DR excluded. */
async function doLineConsumedQty(db: Db, doItemId: string): Promise<number> {
  let invoiced = 0, returned = 0;
  const siLines = await db.select({ qty: siItemsTable.qty, salesInvoiceId: siItemsTable.salesInvoiceId }).from(siItemsTable).where(eq(siItemsTable.doItemId, doItemId));
  const siIds = [...new Set(siLines.map((l) => l.salesInvoiceId).filter(Boolean))];
  if (siIds.length > 0) {
    const sis = await db.select({ id: siTable.id, status: siTable.status }).from(siTable).where(inArray(siTable.id, siIds));
    const active = new Set(sis.filter((s) => (s.status ?? "").toUpperCase() !== "CANCELLED").map((s) => s.id));
    for (const l of siLines) if (active.has(l.salesInvoiceId)) invoiced += Number(l.qty ?? 0);
  }
  const drLines = await db.select({ qtyReturned: drItemsTable.qtyReturned, deliveryReturnId: drItemsTable.deliveryReturnId }).from(drItemsTable).where(eq(drItemsTable.doItemId, doItemId));
  const drIds = [...new Set(drLines.map((l) => l.deliveryReturnId).filter(Boolean))];
  if (drIds.length > 0) {
    const drs = await db.select({ id: drTable.id, status: drTable.status }).from(drTable).where(inArray(drTable.id, drIds));
    const active = new Set(drs.filter((d) => (d.status ?? "").toUpperCase() !== "CANCELLED").map((d) => d.id));
    for (const l of drLines) if (active.has(l.deliveryReturnId)) returned += Number(l.qtyReturned ?? 0);
  }
  return invoiced + returned;
}

/* ── soDeliverableRemaining (LINE-LEVEL partial delivery) ────────────────────
   remaining(soItem) = qty − Σ delivered (non-cancelled DOs) + Σ returned
   (non-cancelled DRs traced via the DO line). Derived live. Keyed by SO line id.
   (Strategy-2: the 2990s sofa-module listing-order re-walk is dropped — lines
   are ordered by line_no then created_at, the generic ordering.) */
export type DeliverableLine = {
  soItemId: string; docNo: string; debtorCode: string | null; debtorName: string | null;
  itemCode: string; itemGroup: string | null; description: string | null; description2: string | null;
  uom: string | null; qty: number; unitPriceCenti: number; unitCostCenti: number; discountCenti: number;
  variants: unknown; delivered: number; returned: number; remaining: number; lineSeq: number;
};

export async function soDeliverableRemaining(db: Db, soDocNos: string[]): Promise<Map<string, DeliverableLine>> {
  const out = new Map<string, DeliverableLine>();
  if (soDocNos.length === 0) return out;

  const lines = await db
    .select({
      id: soItemsTable.id, docNo: soItemsTable.docNo, debtorCode: soItemsTable.debtorCode, debtorName: soItemsTable.debtorName,
      itemCode: soItemsTable.itemCode, itemGroup: soItemsTable.itemGroup, description: soItemsTable.description, description2: soItemsTable.description2,
      uom: soItemsTable.uom, qty: soItemsTable.qty, unitPriceCenti: soItemsTable.unitPriceCenti, unitCostCenti: soItemsTable.unitCostCenti,
      discountCenti: soItemsTable.discountCenti, variants: soItemsTable.variants,
    })
    .from(soItemsTable)
    .where(and(inArray(soItemsTable.docNo, soDocNos), eq(soItemsTable.cancelled, false)))
    .orderBy(asc(soItemsTable.docNo), sql`${soItemsTable.lineNo} ASC NULLS LAST`, asc(soItemsTable.createdAt));
  if (lines.length === 0) return out;
  const soItemIds = lines.map((l) => l.id);

  // Σ delivered — DO lines linked by so_item_id whose parent DO is NOT cancelled.
  const doLineRows = await db.select({ id: doItemsTable.id, soItemId: doItemsTable.soItemId, qty: doItemsTable.qty, deliveryOrderId: doItemsTable.deliveryOrderId }).from(doItemsTable).where(inArray(doItemsTable.soItemId, soItemIds));
  const doIds = [...new Set(doLineRows.map((l) => l.deliveryOrderId).filter(Boolean))];
  const activeDoIds = new Set<string>();
  if (doIds.length > 0) {
    const dos = await db.select({ id: doTable.id, status: doTable.status }).from(doTable).where(inArray(doTable.id, doIds));
    for (const d of dos) if ((d.status ?? "").toUpperCase() !== "CANCELLED") activeDoIds.add(d.id);
  }
  const doLineToSoItem = new Map<string, string>();
  const deliveredBySoItem = new Map<string, number>();
  for (const l of doLineRows) {
    if (!l.soItemId || !activeDoIds.has(l.deliveryOrderId)) continue;
    doLineToSoItem.set(l.id, l.soItemId);
    deliveredBySoItem.set(l.soItemId, (deliveredBySoItem.get(l.soItemId) ?? 0) + Number(l.qty ?? 0));
  }

  // Σ returned — DR lines tracing (via active DO line) back to our SO items.
  const returnedBySoItem = new Map<string, number>();
  const activeDoLineIds = [...doLineToSoItem.keys()];
  if (activeDoLineIds.length > 0) {
    const drLineRows = await db.select({ doItemId: drItemsTable.doItemId, qtyReturned: drItemsTable.qtyReturned, deliveryReturnId: drItemsTable.deliveryReturnId }).from(drItemsTable).where(inArray(drItemsTable.doItemId, activeDoLineIds));
    const drIds = [...new Set(drLineRows.map((l) => l.deliveryReturnId).filter(Boolean))];
    const activeDrIds = new Set<string>();
    if (drIds.length > 0) {
      const drs = await db.select({ id: drTable.id, status: drTable.status }).from(drTable).where(inArray(drTable.id, drIds));
      for (const d of drs) if ((d.status ?? "").toUpperCase() !== "CANCELLED") activeDrIds.add(d.id);
    }
    for (const l of drLineRows) {
      if (!l.doItemId || !activeDrIds.has(l.deliveryReturnId)) continue;
      const soItemId = doLineToSoItem.get(l.doItemId);
      if (!soItemId) continue;
      returnedBySoItem.set(soItemId, (returnedBySoItem.get(soItemId) ?? 0) + Number(l.qtyReturned ?? 0));
    }
  }

  const seqByDoc = new Map<string, number>();
  for (const l of lines) {
    const qty = Number(l.qty ?? 0);
    const delivered = deliveredBySoItem.get(l.id) ?? 0;
    const returned = returnedBySoItem.get(l.id) ?? 0;
    const lineSeq = seqByDoc.get(l.docNo) ?? 0;
    seqByDoc.set(l.docNo, lineSeq + 1);
    out.set(l.id, {
      soItemId: l.id, docNo: l.docNo, debtorCode: l.debtorCode ?? null, debtorName: l.debtorName ?? null,
      itemCode: l.itemCode, itemGroup: l.itemGroup ?? null, description: l.description ?? null, description2: l.description2 ?? null,
      uom: l.uom ?? null, qty, unitPriceCenti: Number(l.unitPriceCenti ?? 0), unitCostCenti: Number(l.unitCostCenti ?? 0),
      discountCenti: Number(l.discountCenti ?? 0), variants: l.variants ?? null, delivered, returned, remaining: qty - delivered + returned, lineSeq,
    });
  }
  return out;
}

/* Per-DO-line downstream breakdown — for each DO item id, the list of SI/DR docs
   it was carried into. Cancelled SIs/DRs excluded. Read-only display aid. */
export type DoLineDownstream = { docNumber: string; docType: "SI" | "DR"; qty: number; status: string };
export async function doLineDownstream(db: Db, doItemIds: string[]): Promise<Map<string, DoLineDownstream[]>> {
  const out = new Map<string, DoLineDownstream[]>();
  const ids = [...new Set(doItemIds.filter((x): x is string => Boolean(x)))];
  if (ids.length === 0) return out;
  const [siLines, drLines] = await Promise.all([
    db.select({ doItemId: siItemsTable.doItemId, qty: siItemsTable.qty, salesInvoiceId: siItemsTable.salesInvoiceId }).from(siItemsTable).where(inArray(siItemsTable.doItemId, ids)),
    db.select({ doItemId: drItemsTable.doItemId, qty: drItemsTable.qtyReturned, deliveryReturnId: drItemsTable.deliveryReturnId }).from(drItemsTable).where(inArray(drItemsTable.doItemId, ids)),
  ]);
  const siIds = [...new Set(siLines.map((r) => r.salesInvoiceId).filter(Boolean))];
  const drIds = [...new Set(drLines.map((r) => r.deliveryReturnId).filter(Boolean))];
  const [siHead, drHead] = await Promise.all([
    siIds.length > 0 ? db.select({ id: siTable.id, invoiceNumber: siTable.invoiceNumber, status: siTable.status }).from(siTable).where(inArray(siTable.id, siIds)) : Promise.resolve([]),
    drIds.length > 0 ? db.select({ id: drTable.id, returnNumber: drTable.returnNumber, status: drTable.status }).from(drTable).where(inArray(drTable.id, drIds)) : Promise.resolve([]),
  ]);
  const siMeta = new Map<string, { docNumber: string; status: string }>();
  for (const s of siHead) { if ((s.status ?? "").toUpperCase() === "CANCELLED") continue; siMeta.set(s.id, { docNumber: s.invoiceNumber ?? "—", status: (s.status ?? "").toUpperCase() }); }
  const drMeta = new Map<string, { docNumber: string; status: string }>();
  for (const d of drHead) { if ((d.status ?? "").toUpperCase() === "CANCELLED") continue; drMeta.set(d.id, { docNumber: d.returnNumber ?? "—", status: (d.status ?? "").toUpperCase() }); }
  const push = (doItemId: string | null, entry: DoLineDownstream) => { if (!doItemId) return; const arr = out.get(doItemId) ?? []; arr.push(entry); out.set(doItemId, arr); };
  for (const r of siLines) { const meta = siMeta.get(r.salesInvoiceId); if (!meta) continue; push(r.doItemId, { docNumber: meta.docNumber, docType: "SI", qty: Number(r.qty ?? 0), status: meta.status }); }
  for (const r of drLines) { const meta = drMeta.get(r.deliveryReturnId); if (!meta) continue; push(r.doItemId, { docNumber: meta.docNumber, docType: "DR", qty: Number(r.qty ?? 0), status: meta.status }); }
  return out;
}

/* Per-DO lifecycle by "latest event wins" — baseline 'shipped'; a non-cancelled
   SI or DR (whichever has the latest business date) takes the badge. */
export type DoLifecycle = "shipped" | "invoiced" | "returned";
export async function computeDoLifecycle(db: Db, doIds: string[]): Promise<Map<string, DoLifecycle>> {
  const out = new Map<string, DoLifecycle>();
  const ids = [...new Set(doIds.filter(Boolean))];
  if (ids.length === 0) return out;
  type Ev = { date: string; createdAt: string; kind: DoLifecycle };
  const events = new Map<string, Ev[]>();
  const push = (doId: string | null | undefined, ev: Ev) => { if (!doId) return; const arr = events.get(doId) ?? []; arr.push(ev); events.set(doId, arr); };
  const [siRes, drRes] = await Promise.all([
    db.select({ deliveryOrderId: siTable.deliveryOrderId, invoiceDate: siTable.invoiceDate, createdAt: siTable.createdAt, status: siTable.status }).from(siTable).where(inArray(siTable.deliveryOrderId, ids)),
    db.select({ deliveryOrderId: drTable.deliveryOrderId, returnDate: drTable.returnDate, createdAt: drTable.createdAt, status: drTable.status }).from(drTable).where(inArray(drTable.deliveryOrderId, ids)),
  ]);
  for (const s of siRes) { if ((s.status ?? "").toUpperCase() === "CANCELLED" || !s.deliveryOrderId) continue; push(s.deliveryOrderId, { date: (s.invoiceDate as string) ?? isoOrNull(s.createdAt) ?? "", createdAt: isoOrNull(s.createdAt) ?? "", kind: "invoiced" }); }
  for (const r of drRes) { if ((r.status ?? "").toUpperCase() === "CANCELLED" || !r.deliveryOrderId) continue; push(r.deliveryOrderId, { date: (r.returnDate as string) ?? isoOrNull(r.createdAt) ?? "", createdAt: isoOrNull(r.createdAt) ?? "", kind: "returned" }); }
  const priority: Record<DoLifecycle, number> = { shipped: 0, invoiced: 1, returned: 2 };
  const day = (d: string) => (d ?? "").slice(0, 10);
  for (const id of ids) {
    const evs = events.get(id);
    if (!evs || evs.length === 0) { out.set(id, "shipped"); continue; }
    let best: Ev | null = null;
    for (const ev of evs) {
      if (!best) { best = ev; continue; }
      const dc = day(ev.date).localeCompare(day(best.date));
      if (dc > 0) { best = ev; continue; }
      if (dc < 0) continue;
      const cc = ev.createdAt.localeCompare(best.createdAt);
      if (cc > 0) { best = ev; continue; }
      if (cc < 0) continue;
      if (priority[ev.kind] > priority[best.kind]) best = ev;
    }
    out.set(id, best ? best.kind : "shipped");
  }
  return out;
}

/* Live remaining-deliverable qty per SO line id, resolved from SO item ids. */
async function soRemainingByItemId(db: Db, soItemIds: Array<string | null | undefined>): Promise<Map<string, number>> {
  const ids = [...new Set(soItemIds.filter((x): x is string => !!x))];
  const out = new Map<string, number>();
  if (ids.length === 0) return out;
  const rows = await db.select({ docNo: soItemsTable.docNo }).from(soItemsTable).where(inArray(soItemsTable.id, ids));
  const docNos = [...new Set(rows.map((r) => r.docNo).filter((d): d is string => !!d))];
  const remainingMap = await soDeliverableRemaining(db, docNos);
  for (const id of ids) out.set(id, remainingMap.get(id)?.remaining ?? 0);
  return out;
}

/* Build one delivery_order_items insert row from a client line payload. */
function buildItemRow(deliveryOrderId: string, it: Record<string, unknown>, lineNo?: number | null): Record<string, unknown> {
  const qty = Number(it.qty ?? 1);
  const unitPrice = Number(it.unitPriceCenti ?? 0);
  const discount = Number(it.discountCenti ?? 0);
  const unitCost = Number(it.unitCostCenti ?? 0);
  const lineTotal = qty * unitPrice - discount;
  const lineCost = qty * unitCost;
  return {
    deliveryOrderId,
    soItemId: (it.soItemId as string | undefined) ?? null,
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
    ...(typeof lineNo === "number" ? { lineNo } : {}),
  };
}

// ── List ──────────────────────────────────────────────────────────────
app.get("/", async (c) => {
  const db = getDb(c.env);
  try {
    const conds = [];
    const status = c.req.query("status");
    if (status) conds.push(eq(doTable.status, status as DoHeaderDb["status"]));
    const headerRows = await db.select().from(doTable).where(conds.length ? and(...conds) : undefined).orderBy(desc(doTable.doDate)).limit(500);
    const rows = headerRows.map((h) => toDoHeaderResponse(h));
    const ids = headerRows.map((h) => h.id);
    const childIds = new Set<string>();
    let lifecycleByDo = new Map<string, DoLifecycle>();
    if (ids.length > 0) {
      const [drRes, siRes, lc] = await Promise.all([
        db.select({ deliveryOrderId: drTable.deliveryOrderId }).from(drTable).where(and(inArray(drTable.deliveryOrderId, ids), sql`${drTable.status} <> 'CANCELLED'`)),
        db.select({ deliveryOrderId: siTable.deliveryOrderId }).from(siTable).where(and(inArray(siTable.deliveryOrderId, ids), sql`${siTable.status} <> 'CANCELLED'`)),
        computeDoLifecycle(db, ids),
      ]);
      lifecycleByDo = lc;
      for (const d of drRes) if (d.deliveryOrderId) childIds.add(d.deliveryOrderId);
      for (const s of siRes) if (s.deliveryOrderId) childIds.add(s.deliveryOrderId);
    }
    const deliveryOrders = rows.map((r) => ({ ...r, has_children: childIds.has(r.id as string), lifecycle_state: lifecycleByDo.get(r.id as string) ?? "shipped" }));
    return c.json({ deliveryOrders });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

// ── Deliverable SO lines (line-level partial-delivery picker) ─────────────
// STATIC path — MUST precede /:id.
app.get("/deliverable-so-lines", async (c) => {
  const db = getDb(c.env);
  try {
    const docNosParam = c.req.query("docNos");
    let docNos: string[];
    if (docNosParam && docNosParam.trim()) {
      docNos = [...new Set(docNosParam.split(",").map((d) => d.trim()).filter(Boolean))];
    } else {
      const sos = await db.select({ docNo: soTable.docNo }).from(soTable).where(sql`${soTable.status} <> 'CANCELLED'`).orderBy(desc(soTable.docNo)).limit(1000);
      docNos = sos.map((s) => s.docNo).filter(Boolean);
    }
    if (docNos.length === 0) return c.json({ lines: [] });
    const remainingMap = await soDeliverableRemaining(db, docNos);
    const lines = [...remainingMap.values()].filter((l) => l.remaining > 0);
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
      db.select().from(doTable).where(eq(doTable.id, id)).limit(1),
      db.select().from(doItemsTable).where(eq(doItemsTable.deliveryOrderId, id)).orderBy(sql`${doItemsTable.lineNo} ASC NULLS LAST`, asc(doItemsTable.createdAt)),
    ]);
    const header = headerRows[0];
    if (!header) return c.json({ error: "not_found" }, 404);
    const [{ length: drCount }, { length: siCount }] = await Promise.all([
      db.select({ id: drTable.id }).from(drTable).where(and(eq(drTable.deliveryOrderId, id), sql`${drTable.status} <> 'CANCELLED'`)).limit(1),
      db.select({ id: siTable.id }).from(siTable).where(and(eq(siTable.deliveryOrderId, id), sql`${siTable.status} <> 'CANCELLED'`)).limit(1),
    ]);
    const lifecycleByDo = await computeDoLifecycle(db, [id]);
    const deliveryOrder = { ...toDoHeaderResponse(header), has_children: drCount > 0 || siCount > 0, lifecycle_state: lifecycleByDo.get(id) ?? "shipped" };
    const rawItems = itemRows.map((it) => toDoItemResponse(it));
    const [lineWh, downstreamMap] = await Promise.all([
      resolveDoLineWarehouses(db, itemRows.map((it) => ({ id: it.id, soItemId: it.soItemId })), header.warehouseId ?? null),
      doLineDownstream(db, itemRows.map((it) => it.id)),
    ]);
    const codeMap = await warehouseCodeMap(db, [...lineWh.values()]);
    const items = rawItems.map((it) => {
      const wid = lineWh.get(it.id as string) ?? null;
      return { ...it, warehouse_id: wid, warehouse_code: wid ? codeMap.get(wid) ?? null : null, downstream: downstreamMap.get(it.id as string) ?? [] };
    });
    return c.json({ deliveryOrder, items });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

// ── Create (single-SO prefill / ad-hoc) ───────────────────────────────────
app.post("/", async (c) => {
  const db = getDb(c.env);
  const user = c.get("user");
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: "invalid_json" }, 400); }
  const debtorName = (body.debtorName ?? body.customerName) as string | undefined;
  if (!debtorName) return c.json({ error: "debtor_name_required" }, 400);
  const items = (body.items as Array<Record<string, unknown>> | undefined) ?? [];

  // Remaining-qty guard — any line tracing back to an SO line may not push it
  // past its ordered qty (mirrors the /from-sos picker; ad-hoc lines uncapped).
  {
    const additions = new Map<string, number>();
    for (const it of items) { const sid = it.soItemId as string | undefined; if (!sid) continue; additions.set(sid, (additions.get(sid) ?? 0) + Number(it.qty ?? 0)); }
    if (additions.size > 0) {
      const remaining = await soRemainingByItemId(db, [...additions.keys()]);
      for (const [sid, addQty] of additions) {
        const rem = remaining.get(sid) ?? 0;
        if (addQty > rem) return c.json({ error: "over_remaining", message: `Pick qty ${addQty} exceeds remaining ${rem} on the linked Sales Order line.`, soItemId: sid, remaining: rem, requested: addQty }, 409);
      }
    }
  }

  const doNumber = await nextNum(db);
  let header: DoHeaderDb;
  try {
    const inserted = await db.insert(doTable).values({
      doNumber,
      soDocNo: (body.soDocNo as string) ?? null,
      debtorCode: (body.debtorCode as string) ?? null,
      debtorName,
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
      currency: ((body.currency as string) ?? "MYR") as never,
      // A DO means goods are OUT the moment it's created — start at DISPATCHED.
      status: "DISPATCHED",
      notes: (body.notes as string) ?? null,
      createdBy: user.id,
    } as never).returning();
    header = inserted[0];
  } catch (e) {
    return c.json({ error: "insert_failed", reason: errMsg(e) }, 500);
  }

  if (items.length > 0) {
    try {
      const rows = items.map((it, lineNo) => buildItemRow(header.id, it, lineNo));
      await db.insert(doItemsTable).values(rows as never);
      await recomputeTotals(db, header.id);
    } catch (e) {
      await db.delete(doTable).where(eq(doTable.id, header.id));
      return c.json({ error: "items_insert_failed", reason: errMsg(e) }, 500);
    }
  }

  await deductInventoryForDo(db, header.id, user.id);
  await syncSoDeliveredFromDo(db, [(body.soDocNo as string) ?? null], user.id);
  return c.json({ id: header.id, doNumber: header.doNumber }, 201);
});

// ── Convert picked SO LINES (partial qty) → ONE DO ────────────────────────
app.post("/from-sos", async (c) => {
  const db = getDb(c.env);
  const user = c.get("user");
  let body: { picks?: Array<{ soItemId?: string; qty?: number }> };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: "invalid_json" }, 400); }

  const pickQtyById = new Map<string, number>();
  for (const p of body.picks ?? []) { if (!p || !p.soItemId) continue; const q = Number(p.qty ?? 0); if (!(q > 0)) continue; pickQtyById.set(p.soItemId, (pickQtyById.get(p.soItemId) ?? 0) + q); }
  if (pickQtyById.size === 0) return c.json({ error: "picks_required" }, 400);

  const pickedIds = [...pickQtyById.keys()];
  const pickedItemRows = await db.select({ id: soItemsTable.id, docNo: soItemsTable.docNo }).from(soItemsTable).where(inArray(soItemsTable.id, pickedIds));
  const idToDoc = new Map<string, string>();
  for (const r of pickedItemRows) idToDoc.set(r.id, r.docNo);
  const missing = pickedIds.filter((id) => !idToDoc.has(id));
  if (missing.length > 0) return c.json({ error: "so_item_not_found", missing }, 404);

  const docNos = [...new Set([...idToDoc.values()])];
  const remainingMap = await soDeliverableRemaining(db, docNos);

  const custKey = (l: DeliverableLine): string => (l.debtorCode && l.debtorCode.trim() ? `code:${l.debtorCode.trim().toUpperCase()}` : `name:${(l.debtorName ?? "").trim().toUpperCase()}`);
  const customers = new Set<string>();
  const customerNames = new Set<string>();
  for (const id of pickedIds) {
    const line = remainingMap.get(id);
    if (!line) return c.json({ error: "so_item_not_found", missing: [id] }, 404);
    customers.add(custKey(line));
    customerNames.add(line.debtorName ?? line.debtorCode ?? "(none)");
  }
  if (customers.size > 1) return c.json({ error: "mixed_customers", message: "All picked Sales Order lines must belong to the same customer to combine into one Delivery Order.", customers: [...customerNames] }, 400);

  for (const id of pickedIds) {
    const line = remainingMap.get(id)!;
    const qty = pickQtyById.get(id)!;
    if (qty < 1 || qty > line.remaining) return c.json({ error: "over_remaining", message: `${line.itemCode} on ${line.docNo}: pick qty ${qty} exceeds remaining ${line.remaining}.`, soItemId: id, docNo: line.docNo, itemCode: line.itemCode, remaining: line.remaining, requested: qty }, 409);
  }

  const sortedPicks = pickedIds.map((id) => remainingMap.get(id)!).sort((a, b) => a.docNo.localeCompare(b.docNo) || a.lineSeq - b.lineSeq || a.soItemId.localeCompare(b.soItemId));
  const firstSoDocNo = sortedPicks[0]!.docNo;

  const soHeaderRows = await db
    .select({ debtorCode: soTable.debtorCode, debtorName: soTable.debtorName, agent: soTable.agent, salespersonId: soTable.salespersonId, address1: soTable.address1, address2: soTable.address2, address3: soTable.address3, address4: soTable.address4, city: soTable.city, customerState: soTable.customerState, postcode: soTable.postcode, phone: soTable.phone, email: soTable.email, customerType: soTable.customerType, buildingType: soTable.buildingType, branding: soTable.branding, venue: soTable.venue, venueId: soTable.venueId, ref: soTable.ref, salesLocation: soTable.salesLocation, customerCountry: soTable.customerCountry, customerDeliveryDate: soTable.customerDeliveryDate, emergencyContactName: soTable.emergencyContactName, emergencyContactPhone: soTable.emergencyContactPhone, emergencyContactRelationship: soTable.emergencyContactRelationship, currency: soTable.currency })
    .from(soTable)
    .where(eq(soTable.docNo, firstSoDocNo))
    .limit(1);
  const head = soHeaderRows[0];
  if (!head) return c.json({ error: "not_found" }, 404);

  const doAddress2 = head.address2 ?? ([head.address3, head.address4].filter(Boolean).join(", ") || null);
  const today = new Date().toISOString().slice(0, 10);
  const doNumber = await nextNum(db);

  let dh: DoHeaderDb;
  try {
    const inserted = await db.insert(doTable).values({
      doNumber,
      soDocNo: firstSoDocNo,
      debtorCode: head.debtorCode ?? null,
      debtorName: head.debtorName ?? "Customer",
      doDate: today,
      expectedDeliveryAt: (head.customerDeliveryDate as string | null) ?? today,
      customerDeliveryDate: (head.customerDeliveryDate as string | null) ?? null,
      address1: head.address1 ?? null,
      address2: doAddress2,
      city: head.city ?? null,
      state: head.customerState ?? null,
      customerState: head.customerState ?? null,
      customerCountry: head.customerCountry ?? null,
      postcode: head.postcode ?? null,
      phone: head.phone ?? null,
      salespersonId: head.salespersonId ?? null,
      agent: head.agent ?? null,
      email: head.email ?? null,
      customerType: head.customerType ?? null,
      buildingType: head.buildingType ?? null,
      branding: head.branding ?? null,
      venue: head.venue ?? null,
      venueId: head.venueId ?? null,
      ref: docNos.length > 1 ? `Merged from ${[...docNos].sort().join(", ")}` : head.ref ?? null,
      salesLocation: head.salesLocation ?? null,
      emergencyContactName: head.emergencyContactName ?? null,
      emergencyContactPhone: head.emergencyContactPhone ?? null,
      emergencyContactRelationship: head.emergencyContactRelationship ?? null,
      currency: (head.currency ?? "MYR") as never,
      status: "DISPATCHED",
      createdBy: user.id,
    } as never).returning();
    dh = inserted[0];
  } catch (e) {
    return c.json({ error: "insert_failed", reason: errMsg(e) }, 500);
  }

  const doRows = sortedPicks.map((line, lineNo) => {
    const qty = pickQtyById.get(line.soItemId)!;
    const unit = line.unitPriceCenti;
    const discount = line.discountCenti;
    const unitCost = line.unitCostCenti;
    const lineTotal = qty * unit - discount;
    const lineCost = qty * unitCost;
    return {
      deliveryOrderId: dh.id, lineNo, soItemId: line.soItemId, itemCode: line.itemCode, itemGroup: line.itemGroup,
      description: line.description ?? null, description2: line.description2 ?? null, uom: line.uom ?? "UNIT", qty, m3Milli: 0,
      unitPriceCenti: unit, discountCenti: discount, lineTotalCenti: lineTotal, unitCostCenti: unitCost, lineCostCenti: lineCost, lineMarginCenti: lineTotal - lineCost, variants: line.variants ?? null,
    };
  });
  try {
    await db.insert(doItemsTable).values(doRows as never);
  } catch (e) {
    await db.delete(doTable).where(eq(doTable.id, dh.id));
    return c.json({ error: "items_insert_failed", reason: errMsg(e) }, 500);
  }

  // Race guard — re-derive remaining after insert; rollback if any line negative.
  {
    const recheck = await soDeliverableRemaining(db, docNos);
    const overcommitted = pickedIds.map((sid) => recheck.get(sid)).filter((l): l is DeliverableLine => l !== undefined && l.remaining < 0);
    if (overcommitted.length > 0) {
      await db.delete(doItemsTable).where(eq(doItemsTable.deliveryOrderId, dh.id));
      await db.delete(doTable).where(eq(doTable.id, dh.id));
      return c.json({ error: "race_conflict", message: "Another operator just converted overlapping qty from this Sales Order. Refresh the picker and try again.", conflicts: overcommitted.map((l) => ({ docNo: l.docNo, itemCode: l.itemCode, remaining: l.remaining })) }, 409);
    }
  }

  await recomputeTotals(db, dh.id);
  await deductInventoryForDo(db, dh.id, user.id);
  await syncSoDeliveredFromDo(db, [...docNos], user.id);
  return c.json({ id: dh.id, doNumber: dh.doNumber }, 201);
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

  const headerLock = await doHasDownstream(db, id);
  if (headerLock) return c.json(headerLock, 409);

  try {
    const updated = await db.update(doTable).set(updates).where(eq(doTable.id, id)).returning({ id: doTable.id });
    if (!updated[0]) return c.json({ error: "not_found" }, 404);
    return c.json({ ok: true, id });
  } catch (e) {
    return c.json({ error: "update_failed", reason: errMsg(e) }, 500);
  }
});

// ── Item CRUD ─────────────────────────────────────────────────────────────
const nextItemLineNo = async (db: Db, doId: string): Promise<number | null> => {
  const rows = await db.select({ lineNo: doItemsTable.lineNo }).from(doItemsTable).where(eq(doItemsTable.deliveryOrderId, doId)).orderBy(sql`${doItemsTable.lineNo} DESC NULLS LAST`).limit(1);
  const v = rows[0]?.lineNo;
  return typeof v === "number" ? v + 1 : null;
};

app.post("/:id/items", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const user = c.get("user");
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: "invalid_json" }, 400); }
  if (!it.itemCode) return c.json({ error: "item_code_required" }, 400);

  const childLock = await doHasDownstream(db, id);
  if (childLock) return c.json(childLock, 409);

  const headerRows = await db.select({ id: doTable.id }).from(doTable).where(eq(doTable.id, id)).limit(1);
  if (!headerRows[0]) return c.json({ error: "not_found" }, 404);

  // Remaining-qty guard for an SO-linked added line.
  {
    const sid = it.soItemId as string | undefined;
    if (sid) {
      const remaining = await soRemainingByItemId(db, [sid]);
      const rem = remaining.get(sid) ?? 0;
      const addQty = Number(it.qty ?? 0);
      if (addQty > rem) return c.json({ error: "over_remaining", message: `Add qty ${addQty} exceeds remaining ${rem} on the linked Sales Order line.`, soItemId: sid, remaining: rem, requested: addQty }, 409);
    }
  }

  const lineNo = await nextItemLineNo(db, id);
  try {
    const inserted = await db.insert(doItemsTable).values(buildItemRow(id, it, lineNo) as never).returning();
    await recomputeTotals(db, id);
    await resyncInventoryForDo(db, id, user.id);
    return c.json({ item: toDoItemResponse(inserted[0]) }, 201);
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

  const childLock = await doHasDownstream(db, id);
  if (childLock) return c.json(childLock, 409);

  const prevRows = await db.select({ qty: doItemsTable.qty, unitPriceCenti: doItemsTable.unitPriceCenti, discountCenti: doItemsTable.discountCenti, unitCostCenti: doItemsTable.unitCostCenti, itemCode: doItemsTable.itemCode, itemGroup: doItemsTable.itemGroup, soItemId: doItemsTable.soItemId }).from(doItemsTable).where(eq(doItemsTable.id, itemId)).limit(1);
  const prev = prevRows[0];
  if (!prev) return c.json({ error: "not_found" }, 404);

  const qty = it.qty !== undefined ? Number(it.qty) : Number(prev.qty);

  // Remaining-qty guard on a qty increase of an SO-linked line.
  if (it.qty !== undefined && qty > Number(prev.qty) && prev.soItemId) {
    const remaining = await soRemainingByItemId(db, [prev.soItemId]);
    const cap = (remaining.get(prev.soItemId) ?? 0) + Number(prev.qty);
    if (qty > cap) return c.json({ error: "over_remaining", message: `New qty ${qty} exceeds the most this line can deliver (${cap}) for the linked Sales Order line.`, soItemId: prev.soItemId, remaining: cap, requested: qty }, 409);
  }

  // Downstream-consumption floor on a qty decrease.
  if (it.qty !== undefined && qty < Number(prev.qty)) {
    const consumed = await doLineConsumedQty(db, itemId);
    if (qty < consumed) return c.json({ error: "qty_below_downstream_consumption", message: `Cannot reduce qty to ${qty} — ${consumed} unit${consumed === 1 ? " has" : "s have"} already been invoiced or returned for this line. Cancel the related Invoice / Delivery Return first.`, currentQty: Number(prev.qty), newQty: qty, consumed }, 409);
  }

  const unitPrice = it.unitPriceCenti !== undefined ? Number(it.unitPriceCenti) : Number(prev.unitPriceCenti);
  const discount = it.discountCenti !== undefined ? Number(it.discountCenti) : Number(prev.discountCenti);
  const unitCost = it.unitCostCenti !== undefined ? Number(it.unitCostCenti) : Number(prev.unitCostCenti);
  const lineTotal = qty * unitPrice - discount;
  const lineCost = qty * unitCost;

  const updates: Record<string, unknown> = { qty, unitPriceCenti: unitPrice, discountCenti: discount, unitCostCenti: unitCost, lineTotalCenti: lineTotal, lineCostCenti: lineCost, lineMarginCenti: lineTotal - lineCost };
  for (const [from, to] of [["itemCode", "itemCode"], ["itemGroup", "itemGroup"], ["description", "description"], ["description2", "description2"], ["uom", "uom"], ["variants", "variants"], ["notes", "notes"], ["lineDeliveryDate", "lineDeliveryDate"]] as const) {
    if (it[from] !== undefined) updates[to] = it[from];
  }
  if (it.lineDeliveryDate !== undefined) updates["lineDeliveryDateOverridden"] = true;
  if (it.lineDeliveryDateOverridden !== undefined) updates["lineDeliveryDateOverridden"] = Boolean(it.lineDeliveryDateOverridden);

  try {
    await db.update(doItemsTable).set(updates).where(eq(doItemsTable.id, itemId));
    await recomputeTotals(db, id);
    await resyncInventoryForDo(db, id, user.id);
    const doRow = await db.select({ soDocNo: doTable.soDocNo }).from(doTable).where(eq(doTable.id, id)).limit(1);
    await syncSoDeliveredFromDo(db, [doRow[0]?.soDocNo], user.id);
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

  const consumed = await doLineConsumedQty(db, itemId);
  if (consumed > 0) return c.json({ error: "line_has_downstream_consumption", message: `Cannot delete this line — ${consumed} unit${consumed === 1 ? " has" : "s have"} already been invoiced or returned. Cancel the related Invoice / Delivery Return first to release the quantity.`, consumed }, 409);

  try {
    await db.delete(doItemsTable).where(eq(doItemsTable.id, itemId));
    await recomputeTotals(db, id);
    await resyncInventoryForDo(db, id, user.id);
    const doRow = await db.select({ soDocNo: doTable.soDocNo }).from(doTable).where(eq(doTable.id, id)).limit(1);
    await syncSoDeliveredFromDo(db, [doRow[0]?.soDocNo], user.id);
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: "delete_failed", reason: errMsg(e) }, 500);
  }
});

// ── Payments (mirror SO payments ledger) ──────────────────────────────────
const PAYMENT_SELECT = {
  id: doPaymentsTable.id, delivery_order_id: doPaymentsTable.deliveryOrderId, paid_at: doPaymentsTable.paidAt, method: doPaymentsTable.method,
  merchant_provider: doPaymentsTable.merchantProvider, installment_months: doPaymentsTable.installmentMonths, online_type: doPaymentsTable.onlineType,
  approval_code: doPaymentsTable.approvalCode, amount_centi: doPaymentsTable.amountCenti, account_sheet: doPaymentsTable.accountSheet,
  collected_by: doPaymentsTable.collectedBy, note: doPaymentsTable.note, created_at: doPaymentsTable.createdAt, created_by: doPaymentsTable.createdBy,
} as const;

app.get("/:id/payments", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  try {
    const rows = await db.select(PAYMENT_SELECT).from(doPaymentsTable).where(eq(doPaymentsTable.deliveryOrderId, id)).orderBy(desc(doPaymentsTable.paidAt), desc(doPaymentsTable.createdAt));
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
  const doc = await db.select({ id: doTable.id }).from(doTable).where(eq(doTable.id, id)).limit(1);
  if (!doc[0]) return c.json({ error: "delivery_order_not_found" }, 404);

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
    const inserted = await db.insert(doPaymentsTable).values({ deliveryOrderId: id, paidAt: p.paidAt, method: p.method, merchantProvider, installmentMonths, onlineType, approvalCode: p.approvalCode ?? null, amountCenti: p.amountCenti, accountSheet: p.accountSheet ?? null, collectedBy: p.collectedBy ?? null, note: p.note ?? null, createdBy: user.id } as never).returning(PAYMENT_SELECT);
    return c.json({ payment: { ...inserted[0], created_at: isoOrNull(inserted[0].created_at) } }, 201);
  } catch (e) {
    return c.json({ error: "insert_failed", reason: errMsg(e) }, 500);
  }
});

app.delete("/:id/payments/:paymentId", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const paymentId = c.req.param("paymentId");
  const rows = await db.select({ deliveryOrderId: doPaymentsTable.deliveryOrderId }).from(doPaymentsTable).where(eq(doPaymentsTable.id, paymentId)).limit(1);
  if (!rows[0]) return c.json({ error: "not_found" }, 404);
  if (rows[0].deliveryOrderId !== id) return c.json({ error: "payment_doc_mismatch" }, 400);
  try {
    await db.delete(doPaymentsTable).where(eq(doPaymentsTable.id, paymentId));
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: "delete_failed", reason: errMsg(e) }, 500);
  }
});

// ── Status transition + inventory deduction / reversal ────────────────────
app.patch("/:id/status", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const user = c.get("user");
  let body: { status?: string };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: "invalid_json" }, 400); }
  if (!body.status) return c.json({ error: "status_required" }, 400);

  const cur = await db.select({ status: doTable.status }).from(doTable).where(eq(doTable.id, id)).limit(1);
  if (!cur[0]) return c.json({ error: "not_found" }, 404);
  const prevStatus = cur[0].status as string;
  if (body.status === "CANCELLED" && prevStatus === "CANCELLED") return c.json({ deliveryOrder: { id, status: "CANCELLED" } });
  // A CANCELLED DO is FINAL — re-deliver via a NEW DO (un-cancel would inflate stock).
  if (prevStatus === "CANCELLED") return c.json({ error: "do_cancelled_final", reason: "A cancelled Delivery Order cannot be reactivated — its stock was already returned. Create a new DO to deliver again." }, 409);

  if (body.status === "CANCELLED") {
    const childLock = await doHasDownstream(db, id);
    if (childLock) return c.json(childLock, 409);
  }

  const now = new Date();
  const ts: Record<string, unknown> = { status: body.status, updatedAt: now };
  if (body.status === "DISPATCHED") ts.dispatchedAt = now;
  if (body.status === "SIGNED") ts.signedAt = now;
  if (body.status === "DELIVERED") ts.deliveredAt = now;

  let data: { id: string; status: string } | null;
  if (body.status === "CANCELLED") {
    const updated = await db.update(doTable).set(ts).where(and(eq(doTable.id, id), sql`${doTable.status} <> 'CANCELLED'`)).returning({ id: doTable.id, status: doTable.status });
    if (!updated[0]) return c.json({ deliveryOrder: { id, status: "CANCELLED" } });
    data = updated[0] as { id: string; status: string };
  } else {
    const updated = await db.update(doTable).set(ts).where(eq(doTable.id, id)).returning({ id: doTable.id, status: doTable.status });
    if (!updated[0]) return c.json({ error: "not_found" }, 404);
    data = updated[0] as { id: string; status: string };
  }

  if (SHIPPED_STATES.includes(body.status)) await deductInventoryForDo(db, id, user.id);

  if (body.status === "DELIVERED") {
    const doRow = await db.select({ soDocNo: doTable.soDocNo }).from(doTable).where(eq(doTable.id, id)).limit(1);
    await syncSoDeliveredFromDo(db, [doRow[0]?.soDocNo], user.id);
  }

  if (body.status === "CANCELLED") {
    try { await reverseInventoryForDo(db, id, user.id); } catch { /* best-effort */ }
    try {
      const doRow = await db.select({ soDocNo: doTable.soDocNo }).from(doTable).where(eq(doTable.id, id)).limit(1);
      await syncSoDeliveredFromDo(db, [doRow[0]?.soDocNo], user.id);
    } catch (e) { /* eslint-disable-next-line no-console */ console.error("[so-sync] post-do-cancel failed:", e); }
    try { await recomputeSoStockAllocation(db); } catch (e) { /* eslint-disable-next-line no-console */ console.error("[so-allocation] post-do-cancel failed:", e); }
  }

  return c.json({ deliveryOrder: data });
});

export default app;
