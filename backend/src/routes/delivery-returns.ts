// ----------------------------------------------------------------------------
// /delivery-returns — customer returning previously-delivered goods.
//
// 1:1 clone of 2990s apps/api/src/routes/delivery-returns.ts (itself a DO clone):
// editable DO-style header, line CRUD, a recomputeTotals rollup, a convert-from-DO
// endpoint, and ROBUST + IDEMPOTENT inventory INCREASE on create. A Delivery
// Return = goods coming BACK, so processing one ADDS stock — the mirror image of
// the DO's deductInventoryForDo. SEAMS only (rule #3 + #4): Supabase PostgREST ->
// Drizzle (getDb), staff.id (uuid) -> users.id (integer), requirePermission("*"),
// mount /api/delivery-returns.
//
// Inventory: writeMovements (source_doc_type:'DR', movement_type:'IN') on create;
// the line edit/delete/cancel rollback writes a signed ADJUSTMENT delta per bucket
// (source_doc_type:'ADJUSTMENT') so the three rollback paths can't drift. Each
// returned line re-enters the warehouse its DO line shipped from (its SO line's
// warehouse). Every DR mutation re-walks SO allocation + delivered-sync.
//
// Strategy-2 + scope:
//   - DROPPED the catalog itemCode guard (validateItemCodes), the service-line
//     return guard's catalog join (findServiceLineCodes -> the generic isServiceLine
//     predicate does the work), buildVariantSummary, and the sofa dye-lot batch
//     tracking (resolveDrLineBatches). A line's variant_key is the generic
//     computeVariantKey; description2 passes through.
// ----------------------------------------------------------------------------

import { Hono } from "hono";
import type { Context } from "hono";
import { and, asc, desc, eq, inArray, like, sql } from "drizzle-orm";
import type { Env } from "../types";
import { getDb } from "../db/client";
import {
  deliveryReturns as drTable,
  deliveryReturnItems as drItemsTable,
  deliveryOrders as doTable,
  deliveryOrderItems as doItemsTable,
  salesInvoices as siTable,
  salesInvoiceItems as siItemsTable,
  mfgSalesOrderItems as soItemsTable,
  mfgWarehouses as warehousesTable,
} from "../db/schema";
import { requirePermission } from "../middleware/auth";
import { writeMovements, defaultWarehouseId } from "../lib/inventory-movements";
import { recomputeSoStockAllocation } from "../lib/so-stock-allocation";
import { syncSoDeliveredFromDo } from "../lib/so-delivery-sync";
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

type DrHeaderDb = typeof drTable.$inferSelect;
type DrItemDb = typeof drItemsTable.$inferSelect;

function toDrHeaderResponse(p: DrHeaderDb): Record<string, unknown> {
  return {
    id: p.id,
    return_number: p.returnNumber,
    do_doc_no: p.doDocNo,
    delivery_order_id: p.deliveryOrderId,
    sales_invoice_id: p.salesInvoiceId,
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
function toDrItemResponse(it: DrItemDb): Record<string, unknown> {
  return {
    id: it.id,
    delivery_return_id: it.deliveryReturnId,
    do_item_id: it.doItemId,
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
  const rows = await db.select({ returnNumber: drTable.returnNumber }).from(drTable).where(like(drTable.returnNumber, `DR-${yymm}-%`));
  let maxN = 0;
  for (const r of rows) { const m = /-(\d+)$/.exec(r.returnNumber); if (m) maxN = Math.max(maxN, parseInt(m[1], 10)); }
  return `DR-${yymm}-${String(maxN + 1).padStart(3, "0")}`;
};

/* Re-derive the DR header's per-category revenue/cost totals from its lines. */
async function recomputeTotals(db: Db, deliveryReturnId: string): Promise<void> {
  const items = await db.select({ itemGroup: drItemsTable.itemGroup, lineTotalCenti: drItemsTable.lineTotalCenti, lineCostCenti: drItemsTable.lineCostCenti }).from(drItemsTable).where(eq(drItemsTable.deliveryReturnId, deliveryReturnId));
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
  await db.update(drTable).set({
    mattressSofaCenti: mattressSofa, bedframeCenti: bedframe, accessoriesCenti: accessories, othersCenti: others,
    mattressSofaCostCenti: mattressSofaCost, bedframeCostCenti: bedframeCost, accessoriesCostCenti: accessoriesCost, othersCostCenti: othersCost,
    localTotalCenti: total, totalCostCenti: totalCost, totalMarginCenti: margin, marginPctBasis: total > 0 ? Math.round((margin / total) * 10000) : 0, lineCount: items.length,
    refundCenti: total, updatedAt: new Date(),
  }).where(eq(drTable.id, deliveryReturnId));
}

/* resolveDrLineWarehouses — a DR line re-enters the SAME warehouse the DO took it
   OUT of: do_item_id -> delivery_order_items.so_item_id -> mfg_sales_order_items.
   warehouse_id, else the DO header's warehouse, else the DR header's, else default. */
async function resolveDrLineWarehouses(db: Db, items: Array<{ id: string; doItemId?: string | null }>, drHeaderWarehouseId: string | null): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const doItemIds = [...new Set(items.map((it) => it.doItemId ?? null).filter((x): x is string => !!x))];
  const doLineMeta = new Map<string, { soItemId: string | null; doWarehouseId: string | null }>();
  const soItemIds = new Set<string>();
  if (doItemIds.length > 0) {
    const doRows = await db.select({ id: doItemsTable.id, soItemId: doItemsTable.soItemId, deliveryOrderId: doItemsTable.deliveryOrderId }).from(doItemsTable).where(inArray(doItemsTable.id, doItemIds));
    const doIds = [...new Set(doRows.map((r) => r.deliveryOrderId).filter(Boolean))];
    const doHeaderWh = new Map<string, string | null>();
    if (doIds.length > 0) {
      const doHeaders = await db.select({ id: doTable.id, warehouseId: doTable.warehouseId }).from(doTable).where(inArray(doTable.id, doIds));
      for (const d of doHeaders) doHeaderWh.set(d.id, d.warehouseId ?? null);
    }
    for (const r of doRows) {
      if (r.soItemId) soItemIds.add(r.soItemId);
      doLineMeta.set(r.id, { soItemId: r.soItemId ?? null, doWarehouseId: doHeaderWh.get(r.deliveryOrderId) ?? null });
    }
  }
  const soWh = new Map<string, string | null>();
  if (soItemIds.size > 0) {
    const soRows = await db.select({ id: soItemsTable.id, warehouseId: soItemsTable.warehouseId }).from(soItemsTable).where(inArray(soItemsTable.id, [...soItemIds]));
    for (const r of soRows) soWh.set(r.id, r.warehouseId ?? null);
  }
  const fallback = drHeaderWarehouseId ?? (await defaultWarehouseId(db));
  for (const it of items) {
    const meta = it.doItemId ? doLineMeta.get(it.doItemId) : undefined;
    const fromSo = meta?.soItemId ? soWh.get(meta.soItemId) ?? null : null;
    out.set(it.id, fromSo ?? meta?.doWarehouseId ?? fallback);
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

/* INCREASE inventory for a DR exactly once. ROBUST: fires on create. IDEMPOTENT:
   an existence check on the DR id skips. Best-effort. Mirror of deductInventoryForDo
   — writes IN movements, one per (warehouse, product, variant) bucket; the lot's
   cost is seeded from the line's unit_cost_centi so returned stock re-enters at
   its original cost. */
async function increaseInventoryForReturn(db: Db, deliveryReturnId: string, performedBy: number | null): Promise<void> {
  const existing = await db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM inventory_movements WHERE source_doc_type = 'DR' AND source_doc_id = ${deliveryReturnId} AND movement_type = 'IN'`,
  );
  if (Number(existing[0]?.n ?? 0) > 0) return;

  const hdr = await db.select({ returnNumber: drTable.returnNumber, warehouseId: drTable.warehouseId }).from(drTable).where(eq(drTable.id, deliveryReturnId)).limit(1);
  const items = await db.select({ id: drItemsTable.id, doItemId: drItemsTable.doItemId, itemCode: drItemsTable.itemCode, description: drItemsTable.description, qtyReturned: drItemsTable.qtyReturned, itemGroup: drItemsTable.itemGroup, variants: drItemsTable.variants, unitCostCenti: drItemsTable.unitCostCenti }).from(drItemsTable).where(eq(drItemsTable.deliveryReturnId, deliveryReturnId));
  const drHeaderWarehouseId = hdr[0]?.warehouseId ?? null;
  const drNo = hdr[0]?.returnNumber ?? deliveryReturnId;
  if (items.length === 0) return;

  const lineWh = await resolveDrLineWarehouses(db, items, drHeaderWarehouseId);

  const byKey = new Map<string, { warehouse_id: string; product_code: string; variant_key: string; product_name: string | null; qty: number; unit_cost_sen: number }>();
  for (const it of items) {
    if (isServiceLine({ itemGroup: it.itemGroup, itemCode: it.itemCode })) continue; // SERVICE lines never write stock IN
    const qty = Number(it.qtyReturned ?? 0);
    if (qty <= 0) continue;
    const warehouseId = lineWh.get(it.id) ?? null;
    if (!warehouseId) continue;
    const variantKey = computeVariantKey(it.itemGroup, (it.variants as VariantAttrs | null) ?? null);
    const k = `${warehouseId}::${it.itemCode}::${variantKey}`;
    const cur = byKey.get(k);
    if (cur) cur.qty += qty;
    else byKey.set(k, { warehouse_id: warehouseId, product_code: it.itemCode, variant_key: variantKey, product_name: it.description, qty, unit_cost_sen: Number(it.unitCostCenti ?? 0) });
  }
  const movements = [...byKey.values()].map((m) => ({
    movement_type: "IN" as const,
    warehouse_id: m.warehouse_id,
    product_code: m.product_code,
    variant_key: m.variant_key,
    product_name: m.product_name,
    qty: m.qty,
    unit_cost_sen: m.unit_cost_sen,
    source_doc_type: "DR" as const,
    source_doc_id: deliveryReturnId,
    source_doc_no: drNo,
    performed_by: performedBy,
  }));
  if (movements.length > 0) await writeMovements(db, movements);
}

/* resyncInventoryForReturn — re-derive the DR's intended net stock impact from
   its CURRENT lines and write a signed ADJUSTMENT delta per bucket. SUBSUMES the
   cancel reversal: a CANCELLED DR targets net 0, so the delta drains the full
   booked net out — one code path for edit / delete / cancel. IDEMPOTENT (delta 0
   -> no write). Best-effort. Then re-walk SO allocation + delivered-sync. */
async function resyncInventoryForReturn(db: Db, deliveryReturnId: string, performedBy: number | null): Promise<void> {
  const hdr = await db.select({ returnNumber: drTable.returnNumber, status: drTable.status, warehouseId: drTable.warehouseId }).from(drTable).where(eq(drTable.id, deliveryReturnId)).limit(1);
  if (!hdr[0]) return;
  const drStatus = (hdr[0].status ?? "").toUpperCase();
  const drHeaderWarehouseId = hdr[0].warehouseId ?? null;
  const drNo = hdr[0].returnNumber ?? deliveryReturnId;

  type Bucket = { warehouse_id: string; product_code: string; variant_key: string; product_name: string | null; qty: number; unit_cost_sen: number };
  const targetByBucket = new Map<string, Bucket>();
  if (drStatus !== "CANCELLED") {
    const lineRows = await db.select({ id: drItemsTable.id, doItemId: drItemsTable.doItemId, itemCode: drItemsTable.itemCode, description: drItemsTable.description, qtyReturned: drItemsTable.qtyReturned, itemGroup: drItemsTable.itemGroup, variants: drItemsTable.variants, unitCostCenti: drItemsTable.unitCostCenti }).from(drItemsTable).where(eq(drItemsTable.deliveryReturnId, deliveryReturnId));
    const lineWh = await resolveDrLineWarehouses(db, lineRows, drHeaderWarehouseId);
    for (const it of lineRows) {
      if (isServiceLine({ itemGroup: it.itemGroup, itemCode: it.itemCode })) continue;
      const qty = Number(it.qtyReturned ?? 0);
      if (qty <= 0) continue;
      const warehouseId = lineWh.get(it.id) ?? null;
      if (!warehouseId) continue;
      const variant_key = computeVariantKey(it.itemGroup, (it.variants as VariantAttrs | null) ?? null);
      const k = `${warehouseId}::${it.itemCode}::${variant_key}`;
      const cur = targetByBucket.get(k);
      if (cur) cur.qty += qty;
      else targetByBucket.set(k, { warehouse_id: warehouseId, product_code: it.itemCode, variant_key, product_name: it.description, qty, unit_cost_sen: Number(it.unitCostCenti ?? 0) });
    }
  }

  type Agg = { net_in: number; product_name: string | null };
  const aggByBucket = new Map<string, Agg>();
  const addMov = (m: { movement_type: string; warehouse_id: string; product_code: string; variant_key: string | null; qty: number; product_name: string | null }) => {
    const k = `${m.warehouse_id}::${m.product_code}::${m.variant_key ?? ""}`;
    let agg = aggByBucket.get(k);
    if (!agg) { agg = { net_in: 0, product_name: m.product_name }; aggByBucket.set(k, agg); }
    const q = Number(m.qty ?? 0);
    if (m.movement_type === "IN") agg.net_in += q;
    else if (m.movement_type === "OUT") agg.net_in -= q;
    else if (m.movement_type === "ADJUSTMENT") agg.net_in += q;
    if (!agg.product_name) agg.product_name = m.product_name;
  };
  for (const src of ["DR", "ADJUSTMENT"]) {
    const movs = await db.execute<{ movement_type: string; warehouse_id: string; product_code: string; variant_key: string | null; qty: number; product_name: string | null }>(
      sql`SELECT movement_type, warehouse_id, product_code, variant_key, qty, product_name FROM inventory_movements WHERE source_doc_type = ${src} AND source_doc_id = ${deliveryReturnId}`,
    );
    for (const m of movs) addMov(m);
  }

  const allKeys = new Set<string>([...targetByBucket.keys(), ...aggByBucket.keys()]);
  type MovOut = Parameters<typeof writeMovements>[1][number];
  const writes: MovOut[] = [];
  for (const k of allKeys) {
    const t = targetByBucket.get(k);
    const a = aggByBucket.get(k) ?? { net_in: 0, product_name: null };
    const delta = (t?.qty ?? 0) - a.net_in;
    if (delta === 0) continue;
    const parts = k.split("::");
    const note = drStatus === "CANCELLED" ? `Delivery return ${drNo} cancelled — reversing return (stock removed)` : `Delivery return ${drNo} line edited — resyncing returned stock`;
    writes.push({
      movement_type: "ADJUSTMENT",
      warehouse_id: parts[0] ?? "",
      product_code: parts[1] ?? "",
      variant_key: parts[2] ?? "",
      product_name: t?.product_name ?? a.product_name ?? null,
      qty: delta, // signed: + adds stock, − removes it
      unit_cost_sen: delta > 0 ? t?.unit_cost_sen ?? 0 : 0,
      source_doc_type: "ADJUSTMENT",
      source_doc_id: deliveryReturnId,
      source_doc_no: drNo,
      performed_by: performedBy,
      notes: note,
    });
  }
  if (writes.length > 0) {
    await writeMovements(db, writes);
    try { await recomputeSoStockAllocation(db); } catch (e) { /* eslint-disable-next-line no-console */ console.error("[so-allocation] post-dr-resync failed:", e); }
  }
  await reopenSoFromReturn(db, deliveryReturnId, performedBy);
}

/* reopenSoFromReturn — reconcile the SO(s) behind a DR. A return un-covers a
   fully-delivered SO (DELIVERED -> READY_TO_SHIP); a cancelled/reduced return
   re-covers it. Resolves the SO doc no(s) via the DR header's DO link, else by
   tracing the DR lines' do_item_id -> DO line -> so_item -> doc_no. */
async function reopenSoFromReturn(db: Db, deliveryReturnId: string, actorId?: number | null): Promise<void> {
  try {
    const docs = new Set<string>();
    const drHdr = await db.select({ deliveryOrderId: drTable.deliveryOrderId }).from(drTable).where(eq(drTable.id, deliveryReturnId)).limit(1);
    const doId = drHdr[0]?.deliveryOrderId ?? null;
    if (doId) {
      const doHdr = await db.select({ soDocNo: doTable.soDocNo }).from(doTable).where(eq(doTable.id, doId)).limit(1);
      const so = doHdr[0]?.soDocNo ?? null;
      if (so) docs.add(so);
    }
    if (docs.size === 0) {
      const drItems = await db.select({ doItemId: drItemsTable.doItemId }).from(drItemsTable).where(eq(drItemsTable.deliveryReturnId, deliveryReturnId));
      const doItemIds = [...new Set(drItems.map((r) => r.doItemId).filter((x): x is string => !!x))];
      if (doItemIds.length > 0) {
        const doItems = await db.select({ soItemId: doItemsTable.soItemId }).from(doItemsTable).where(inArray(doItemsTable.id, doItemIds));
        const soItemIds = [...new Set(doItems.map((r) => r.soItemId).filter((x): x is string => !!x))];
        if (soItemIds.length > 0) {
          const soItems = await db.select({ docNo: soItemsTable.docNo }).from(soItemsTable).where(inArray(soItemsTable.id, soItemIds));
          for (const r of soItems) if (r.docNo) docs.add(r.docNo);
        }
      }
    }
    if (docs.size === 0) return;
    await syncSoDeliveredFromDo(db, [...docs], actorId ?? null);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[so-delivered-sync] post-dr failed:", e);
  }
}

/* DO → DR line-level remaining: remaining_to_return = delivered − invoiced −
   returned (the SAME pool as remaining_to_invoice), derived live. */
type DoRemainingLine = {
  doItemId: string; deliveryOrderId: string; doNumber: string; debtorCode: string | null; debtorName: string | null;
  itemCode: string; itemGroup: string | null; description: string | null; description2: string | null; uom: string | null;
  unitPriceCenti: number; unitCostCenti: number; variants: unknown; delivered: number; invoiced: number; returned: number; remaining: number;
};

async function doLineRemaining(db: Db, doIds: string[]): Promise<Map<string, DoRemainingLine>> {
  const out = new Map<string, DoRemainingLine>();
  if (doIds.length === 0) return out;
  const dos = await db.select({ id: doTable.id, doNumber: doTable.doNumber, debtorCode: doTable.debtorCode, debtorName: doTable.debtorName, status: doTable.status }).from(doTable).where(inArray(doTable.id, doIds));
  const activeDo = new Map<string, { doNumber: string; debtorCode: string | null; debtorName: string | null }>();
  for (const d of dos) if ((d.status ?? "").toUpperCase() !== "CANCELLED") activeDo.set(d.id, { doNumber: d.doNumber, debtorCode: d.debtorCode, debtorName: d.debtorName });
  const activeDoIds = [...activeDo.keys()];
  if (activeDoIds.length === 0) return out;

  const doLines = await db.select({ id: doItemsTable.id, deliveryOrderId: doItemsTable.deliveryOrderId, itemCode: doItemsTable.itemCode, itemGroup: doItemsTable.itemGroup, description: doItemsTable.description, description2: doItemsTable.description2, uom: doItemsTable.uom, qty: doItemsTable.qty, unitPriceCenti: doItemsTable.unitPriceCenti, unitCostCenti: doItemsTable.unitCostCenti, variants: doItemsTable.variants }).from(doItemsTable).where(inArray(doItemsTable.deliveryOrderId, activeDoIds));
  const doLineIds = doLines.map((l) => l.id);
  if (doLineIds.length === 0) return out;

  const invoicedByDoLine = new Map<string, number>();
  const siLines = await db.select({ doItemId: siItemsTable.doItemId, qty: siItemsTable.qty, salesInvoiceId: siItemsTable.salesInvoiceId }).from(siItemsTable).where(inArray(siItemsTable.doItemId, doLineIds));
  const siIds = [...new Set(siLines.map((l) => l.salesInvoiceId).filter(Boolean))];
  const activeSi = new Set<string>();
  if (siIds.length > 0) { const sis = await db.select({ id: siTable.id, status: siTable.status }).from(siTable).where(inArray(siTable.id, siIds)); for (const s of sis) if ((s.status ?? "").toUpperCase() !== "CANCELLED") activeSi.add(s.id); }
  for (const l of siLines) { if (!l.doItemId || !activeSi.has(l.salesInvoiceId)) continue; invoicedByDoLine.set(l.doItemId, (invoicedByDoLine.get(l.doItemId) ?? 0) + Number(l.qty ?? 0)); }

  const returnedByDoLine = new Map<string, number>();
  const drLines = await db.select({ doItemId: drItemsTable.doItemId, qtyReturned: drItemsTable.qtyReturned, deliveryReturnId: drItemsTable.deliveryReturnId }).from(drItemsTable).where(inArray(drItemsTable.doItemId, doLineIds));
  const drIds = [...new Set(drLines.map((l) => l.deliveryReturnId).filter(Boolean))];
  const activeDr = new Set<string>();
  if (drIds.length > 0) { const drs = await db.select({ id: drTable.id, status: drTable.status }).from(drTable).where(inArray(drTable.id, drIds)); for (const d of drs) if ((d.status ?? "").toUpperCase() !== "CANCELLED") activeDr.add(d.id); }
  for (const l of drLines) { if (!l.doItemId || !activeDr.has(l.deliveryReturnId)) continue; returnedByDoLine.set(l.doItemId, (returnedByDoLine.get(l.doItemId) ?? 0) + Number(l.qtyReturned ?? 0)); }

  for (const l of doLines) {
    const meta = activeDo.get(l.deliveryOrderId)!;
    const delivered = Number(l.qty ?? 0);
    const invoiced = invoicedByDoLine.get(l.id) ?? 0;
    const returned = returnedByDoLine.get(l.id) ?? 0;
    out.set(l.id, {
      doItemId: l.id, deliveryOrderId: l.deliveryOrderId, doNumber: meta.doNumber, debtorCode: meta.debtorCode, debtorName: meta.debtorName,
      itemCode: l.itemCode, itemGroup: l.itemGroup ?? null, description: l.description ?? null, description2: l.description2 ?? null, uom: l.uom ?? null,
      unitPriceCenti: Number(l.unitPriceCenti ?? 0), unitCostCenti: Number(l.unitCostCenti ?? 0), variants: l.variants ?? null,
      delivered, invoiced, returned, remaining: delivered - invoiced - returned,
    });
  }
  return out;
}

const custKeyOf = (l: DoRemainingLine): string => (l.debtorCode && l.debtorCode.trim() ? `code:${l.debtorCode.trim().toUpperCase()}` : `name:${(l.debtorName ?? "").trim().toUpperCase()}`);

async function resolveCandidateDoIds(db: Db, doIdsParam: string | undefined): Promise<string[]> {
  if (doIdsParam && doIdsParam.trim()) return [...new Set(doIdsParam.split(",").map((d) => d.trim()).filter(Boolean))];
  const dos = await db.select({ id: doTable.id }).from(doTable).where(sql`${doTable.status} <> 'CANCELLED'`).orderBy(desc(doTable.doDate)).limit(1000);
  return dos.map((d) => d.id);
}

/* Over-return guard — every DO-linked line must respect the live Pending pool. */
async function checkDrOverRemaining(db: Db, items: Array<Record<string, unknown>>): Promise<{ error: string; message: string; lines: Array<{ doItemId: string; requested: number; remaining: number }> } | null> {
  const wanted = new Map<string, number>();
  for (const it of items) { const doItemId = (it.doItemId as string | undefined) ?? null; if (!doItemId) continue; const q = Number(it.qtyReturned ?? it.qty ?? 0); wanted.set(doItemId, (wanted.get(doItemId) ?? 0) + q); }
  if (wanted.size === 0) return null;
  const ids = [...wanted.keys()];
  const rows = await db.select({ id: doItemsTable.id, deliveryOrderId: doItemsTable.deliveryOrderId }).from(doItemsTable).where(inArray(doItemsTable.id, ids));
  const doIds = [...new Set(rows.map((r) => r.deliveryOrderId))];
  const remainingMap = await doLineRemaining(db, doIds);
  const offenders: Array<{ doItemId: string; requested: number; remaining: number }> = [];
  for (const [doItemId, requested] of wanted) { const remaining = remainingMap.get(doItemId)?.remaining ?? 0; if (requested > remaining) offenders.push({ doItemId, requested, remaining }); }
  if (offenders.length === 0) return null;
  return { error: "over_remaining", message: "One or more lines return more than the remaining (delivered − invoiced − returned) quantity.", lines: offenders };
}

/* Build one delivery_return_items insert row. */
function buildItemRow(deliveryReturnId: string, it: Record<string, unknown>): Record<string, unknown> {
  const qty = Number(it.qtyReturned ?? it.qty ?? 1);
  const unitPrice = Number(it.unitPriceCenti ?? 0);
  const discount = Number(it.discountCenti ?? 0);
  const unitCost = Number(it.unitCostCenti ?? 0);
  const lineTotal = qty * unitPrice - discount;
  const lineCost = qty * unitCost;
  const refund = it.refundCenti !== undefined ? Number(it.refundCenti) : lineTotal;
  return {
    deliveryReturnId,
    doItemId: (it.doItemId as string | undefined) ?? null,
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
    if (status) conds.push(eq(drTable.status, status as DrHeaderDb["status"]));
    const rows = await db.select().from(drTable).where(conds.length ? and(...conds) : undefined).orderBy(desc(drTable.returnDate)).limit(500);
    return c.json({ deliveryReturns: rows.map((r) => toDrHeaderResponse(r)) });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

// ── Returnable DO lines (line-level partial-return picker) — STATIC, before /:id ──
app.get("/returnable-do-lines", async (c) => {
  const db = getDb(c.env);
  try {
    const doIds = await resolveCandidateDoIds(db, c.req.query("doIds"));
    if (doIds.length === 0) return c.json({ lines: [] });
    const remainingMap = await doLineRemaining(db, doIds);
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
      db.select().from(drTable).where(eq(drTable.id, id)).limit(1),
      db.select().from(drItemsTable).where(eq(drItemsTable.deliveryReturnId, id)).orderBy(asc(drItemsTable.createdAt)),
    ]);
    if (!headerRows[0]) return c.json({ error: "not_found" }, 404);
    const rawItems = itemRows.map((it) => toDrItemResponse(it));
    const lineWh = await resolveDrLineWarehouses(db, itemRows.map((it) => ({ id: it.id, doItemId: it.doItemId })), headerRows[0].warehouseId ?? null);
    const codeMap = await warehouseCodeMap(db, [...lineWh.values()]);
    const items = rawItems.map((it) => {
      const wid = lineWh.get(it.id as string) ?? null;
      return { ...it, warehouse_id: wid, warehouse_code: wid ? codeMap.get(wid) ?? null : null };
    });
    return c.json({ deliveryReturn: toDrHeaderResponse(headerRows[0]), items });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

/* Insert the DR header from a client body. Shared by POST / and convert-from-DO. */
async function insertHeader(db: Db, userId: number, body: Record<string, unknown>): Promise<DrHeaderDb> {
  const returnNumber = await nextNum(db);
  const inserted = await db.insert(drTable).values({
    returnNumber,
    doDocNo: (body.doDocNo as string) ?? null,
    deliveryOrderId: (body.deliveryOrderId as string) ?? null,
    salesInvoiceId: (body.salesInvoiceId as string) ?? null,
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
    currency: ((body.currency as string) ?? "MYR") as never,
    // A return = goods are RECEIVED back the moment it's created.
    status: "RECEIVED",
    receivedAt: new Date(),
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
  if (!Array.isArray(items) || items.length === 0) return c.json({ error: "items_required" }, 400);

  // SERVICE lines are not returnable goods (generic isServiceLine predicate).
  {
    const svc = items.filter((it) => isServiceLine({ itemGroup: it.itemGroup as string | null, itemCode: it.itemCode as string | null }));
    if (svc.length > 0) return c.json({ error: "service_lines_not_returnable", message: "Service lines (delivery fee / dispose / lift) are not returnable goods. Remove them from the return.", lines: svc.map((it) => ({ itemCode: (it.itemCode as string) ?? null })) }, 409);
  }

  // "No DO, no Return" — every return line must reference a Delivery Order line.
  {
    const freeEntry = items.filter((it) => !((it.doItemId as string | undefined) ?? null));
    if (freeEntry.length > 0) return c.json({ error: "do_link_required", message: "Every return line must reference a delivered Delivery Order line. Only shipped goods can be returned.", lines: freeEntry.map((it) => ({ itemCode: (it.itemCode as string) ?? null })) }, 409);
  }

  {
    const over = await checkDrOverRemaining(db, items);
    if (over) return c.json(over, 409);
  }

  let header: DrHeaderDb;
  try { header = await insertHeader(db, user.id, body); } catch (e) { return c.json({ error: "insert_failed", reason: errMsg(e) }, 500); }

  try {
    await db.insert(drItemsTable).values(items.map((it) => buildItemRow(header.id, it)) as never);
    await recomputeTotals(db, header.id);
  } catch (e) {
    await db.delete(drTable).where(eq(drTable.id, header.id));
    return c.json({ error: "items_insert_failed", reason: errMsg(e) }, 500);
  }

  // Over-return race guard — re-derive remaining after insert; rollback if any negative.
  {
    const drItemDoIds = [...new Set(items.map((it) => (it.doItemId as string | undefined) ?? null).filter((x): x is string => !!x))];
    if (drItemDoIds.length > 0) {
      const rowsForDo = await db.select({ deliveryOrderId: doItemsTable.deliveryOrderId }).from(doItemsTable).where(inArray(doItemsTable.id, drItemDoIds));
      const doIds = [...new Set(rowsForDo.map((r) => r.deliveryOrderId))];
      const recheck = await doLineRemaining(db, doIds);
      const overReturned = drItemDoIds.map((doItemId) => recheck.get(doItemId)).filter((l): l is DoRemainingLine => l !== undefined && l.remaining < 0);
      if (overReturned.length > 0) {
        await db.delete(drItemsTable).where(eq(drItemsTable.deliveryReturnId, header.id));
        await db.delete(drTable).where(eq(drTable.id, header.id));
        return c.json({ error: "race_conflict", message: "Another operator just returned overlapping qty from this Delivery Order. Refresh and try again.", conflicts: overReturned.map((l) => ({ doNumber: l.doNumber, itemCode: l.itemCode, remaining: l.remaining })) }, 409);
      }
    }
  }

  await increaseInventoryForReturn(db, header.id, user.id);
  try { await recomputeSoStockAllocation(db); } catch (e) { /* eslint-disable-next-line no-console */ console.error("[so-allocation] post-dr failed:", e); }
  await reopenSoFromReturn(db, header.id, user.id);
  return c.json({ id: header.id, returnNumber: header.returnNumber }, 201);
});

// ── Convert picked DO LINES (partial qty) → ONE Delivery Return ────────────
const convertDoLinesToReturn = async (c: Context<{ Bindings: Env }>) => {
  const db = getDb(c.env);
  const user = c.get("user");
  let body: { picks?: Array<{ doItemId?: string; qty?: number; qtyReturned?: number; condition?: string }> };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: "invalid_json" }, 400); }

  const pickQtyById = new Map<string, number>();
  const conditionById = new Map<string, string>();
  for (const p of body.picks ?? []) { if (!p || !p.doItemId) continue; const q = Number(p.qty ?? p.qtyReturned ?? 0); if (!(q > 0)) continue; pickQtyById.set(p.doItemId, (pickQtyById.get(p.doItemId) ?? 0) + q); if (p.condition && !conditionById.has(p.doItemId)) conditionById.set(p.doItemId, p.condition); }
  if (pickQtyById.size === 0) return c.json({ error: "picks_required" }, 400);

  const pickedIds = [...pickQtyById.keys()];
  const pickedItemRows = await db.select({ id: doItemsTable.id, deliveryOrderId: doItemsTable.deliveryOrderId }).from(doItemsTable).where(inArray(doItemsTable.id, pickedIds));
  const idToDo = new Map<string, string>();
  for (const r of pickedItemRows) idToDo.set(r.id, r.deliveryOrderId);
  const missing = pickedIds.filter((id) => !idToDo.has(id));
  if (missing.length > 0) return c.json({ error: "do_item_not_found", missing }, 404);

  const doIds = [...new Set([...idToDo.values()])];
  const remainingMap = await doLineRemaining(db, doIds);

  const customers = new Set<string>();
  const customerNames = new Set<string>();
  for (const id of pickedIds) {
    const line = remainingMap.get(id);
    if (!line) return c.json({ error: "do_item_not_found", missing: [id] }, 404);
    customers.add(custKeyOf(line));
    customerNames.add(line.debtorName ?? line.debtorCode ?? "(none)");
  }
  if (customers.size > 1) return c.json({ error: "mixed_customers", message: "All picked Delivery Order lines must belong to the same customer to combine into one Delivery Return.", customers: [...customerNames] }, 400);

  for (const id of pickedIds) {
    const line = remainingMap.get(id)!;
    const qty = pickQtyById.get(id)!;
    if (qty < 1 || qty > line.remaining) return c.json({ error: "over_remaining", message: `${line.itemCode} on ${line.doNumber}: return qty ${qty} exceeds remaining ${line.remaining}.`, doItemId: id, doNumber: line.doNumber, itemCode: line.itemCode, remaining: line.remaining, requested: qty }, 409);
  }

  // SERVICE lines are not returnable goods (generic predicate).
  {
    const svc = pickedIds.map((id) => remainingMap.get(id)!).filter((l) => isServiceLine({ itemGroup: l.itemGroup, itemCode: l.itemCode }));
    if (svc.length > 0) return c.json({ error: "service_lines_not_returnable", message: "Service lines (delivery fee / dispose / lift) are not returnable goods.", lines: svc.map((l) => ({ itemCode: l.itemCode })) }, 409);
  }

  const sortedPicks = pickedIds.map((id) => remainingMap.get(id)!).sort((a, b) => a.doNumber.localeCompare(b.doNumber) || a.doItemId.localeCompare(b.doItemId));
  const firstDoId = sortedPicks[0]!.deliveryOrderId;
  const distinctDoNumbers = [...new Set(sortedPicks.map((l) => l.doNumber))].sort();

  const doHeaderRows = await db
    .select({ id: doTable.id, doNumber: doTable.doNumber, debtorCode: doTable.debtorCode, debtorName: doTable.debtorName, phone: doTable.phone, email: doTable.email, salespersonId: doTable.salespersonId, agent: doTable.agent, customerType: doTable.customerType, buildingType: doTable.buildingType, branding: doTable.branding, venue: doTable.venue, venueId: doTable.venueId, ref: doTable.ref, customerSoNo: doTable.customerSoNo, salesLocation: doTable.salesLocation, customerState: doTable.customerState, customerCountry: doTable.customerCountry, address1: doTable.address1, address2: doTable.address2, city: doTable.city, state: doTable.state, postcode: doTable.postcode, emergencyContactName: doTable.emergencyContactName, emergencyContactPhone: doTable.emergencyContactPhone, emergencyContactRelationship: doTable.emergencyContactRelationship, warehouseId: doTable.warehouseId, currency: doTable.currency, note: doTable.note })
    .from(doTable)
    .where(eq(doTable.id, firstDoId))
    .limit(1);
  const doh = doHeaderRows[0];
  if (!doh) return c.json({ error: "delivery_order_not_found" }, 404);

  let header: DrHeaderDb;
  try {
    header = await insertHeader(db, user.id, {
      doDocNo: doh.doNumber, deliveryOrderId: doh.id, debtorCode: doh.debtorCode, debtorName: doh.debtorName, phone: doh.phone, email: doh.email,
      salespersonId: doh.salespersonId, agent: doh.agent, customerType: doh.customerType, buildingType: doh.buildingType, branding: doh.branding,
      venue: doh.venue, venueId: doh.venueId, ref: distinctDoNumbers.length > 1 ? `Merged from ${distinctDoNumbers.join(", ")}` : doh.ref ?? null,
      customerSoNo: doh.customerSoNo, salesLocation: doh.salesLocation, customerState: doh.customerState, customerCountry: doh.customerCountry,
      address1: doh.address1, address2: doh.address2, city: doh.city, state: doh.state, postcode: doh.postcode,
      emergencyContactName: doh.emergencyContactName, emergencyContactPhone: doh.emergencyContactPhone, emergencyContactRelationship: doh.emergencyContactRelationship,
      warehouseId: doh.warehouseId, currency: doh.currency, note: doh.note,
      reason: distinctDoNumbers.length > 1 ? `Return from DO ${distinctDoNumbers.join(", ")}` : `Return from DO ${String(doh.doNumber ?? "")}`,
    });
  } catch (e) {
    return c.json({ error: "insert_failed", reason: errMsg(e) }, 500);
  }

  const rows = sortedPicks.map((line) => buildItemRow(header.id, { doItemId: line.doItemId, itemCode: line.itemCode, itemGroup: line.itemGroup, description: line.description, uom: line.uom, qtyReturned: pickQtyById.get(line.doItemId)!, condition: conditionById.get(line.doItemId) ?? "NEW", unitPriceCenti: line.unitPriceCenti, discountCenti: 0, unitCostCenti: line.unitCostCenti, variants: line.variants }));
  try {
    await db.insert(drItemsTable).values(rows as never);
    await recomputeTotals(db, header.id);
  } catch (e) {
    await db.delete(drTable).where(eq(drTable.id, header.id));
    return c.json({ error: "items_insert_failed", reason: errMsg(e) }, 500);
  }

  // Over-return race guard.
  {
    const recheck = await doLineRemaining(db, doIds);
    const overReturned = pickedIds.map((doItemId) => recheck.get(doItemId)).filter((l): l is DoRemainingLine => l !== undefined && l.remaining < 0);
    if (overReturned.length > 0) {
      await db.delete(drItemsTable).where(eq(drItemsTable.deliveryReturnId, header.id));
      await db.delete(drTable).where(eq(drTable.id, header.id));
      return c.json({ error: "race_conflict", message: "Another operator just returned overlapping qty from this Delivery Order. Refresh and try again.", conflicts: overReturned.map((l) => ({ doNumber: l.doNumber, itemCode: l.itemCode, remaining: l.remaining })) }, 409);
    }
  }

  await increaseInventoryForReturn(db, header.id, user.id);
  await reopenSoFromReturn(db, header.id, user.id);
  return c.json({ id: header.id, returnNumber: header.returnNumber, lineCount: rows.length }, 201);
};
app.post("/from-do", convertDoLinesToReturn);
app.post("/from-dos", convertDoLinesToReturn);

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
    const updated = await db.update(drTable).set(updates).where(eq(drTable.id, id)).returning({ id: drTable.id });
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

  if (!((it.doItemId as string | undefined) ?? null)) return c.json({ error: "do_link_required", message: "Every return line must reference a delivered Delivery Order line. Only shipped goods can be returned." }, 409);
  if (isServiceLine({ itemGroup: it.itemGroup as string | null, itemCode: it.itemCode as string | null })) return c.json({ error: "service_lines_not_returnable", message: "Service lines are not returnable goods." }, 409);

  const header = await db.select({ id: drTable.id }).from(drTable).where(eq(drTable.id, id)).limit(1);
  if (!header[0]) return c.json({ error: "not_found" }, 404);

  {
    const over = await checkDrOverRemaining(db, [it]);
    if (over) return c.json(over, 409);
  }

  try {
    const inserted = await db.insert(drItemsTable).values(buildItemRow(id, it) as never).returning();
    await recomputeTotals(db, id);
    try { await resyncInventoryForReturn(db, id, user.id); } catch { /* best-effort */ }
    return c.json({ item: toDrItemResponse(inserted[0]) }, 201);
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

  const prevRows = await db.select({ qtyReturned: drItemsTable.qtyReturned, unitPriceCenti: drItemsTable.unitPriceCenti, discountCenti: drItemsTable.discountCenti, unitCostCenti: drItemsTable.unitCostCenti, itemCode: drItemsTable.itemCode, itemGroup: drItemsTable.itemGroup, doItemId: drItemsTable.doItemId }).from(drItemsTable).where(and(eq(drItemsTable.id, itemId), eq(drItemsTable.deliveryReturnId, id))).limit(1);
  const prev = prevRows[0];
  if (!prev) return c.json({ error: "not_found" }, 404);

  // Block edits that turn a line into a SERVICE line.
  if (it.itemCode !== undefined || it.itemGroup !== undefined) {
    if (isServiceLine({ itemCode: (it.itemCode ?? prev.itemCode) as string | null, itemGroup: (it.itemGroup ?? prev.itemGroup) as string | null })) return c.json({ error: "service_lines_not_returnable", message: "Service lines are not returnable goods." }, 409);
  }

  const qty = (it.qtyReturned ?? it.qty) !== undefined ? Number(it.qtyReturned ?? it.qty) : Number(prev.qtyReturned);

  // Over-return cap on a qty INCREASE.
  {
    const doItemId = prev.doItemId ?? null;
    const delta = qty - Number(prev.qtyReturned ?? 0);
    if (doItemId && delta > 0) {
      const over = await checkDrOverRemaining(db, [{ doItemId, qtyReturned: delta }]);
      if (over) return c.json(over, 409);
    }
  }

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
    await db.update(drItemsTable).set(updates).where(eq(drItemsTable.id, itemId));
    await recomputeTotals(db, id);
    try { await resyncInventoryForReturn(db, id, user.id); } catch { /* best-effort */ }
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
  const line = await db.select({ id: drItemsTable.id }).from(drItemsTable).where(and(eq(drItemsTable.id, itemId), eq(drItemsTable.deliveryReturnId, id))).limit(1);
  if (!line[0]) return c.json({ error: "not_found" }, 404);
  try {
    await db.delete(drItemsTable).where(eq(drItemsTable.id, itemId));
    await recomputeTotals(db, id);
    try { await resyncInventoryForReturn(db, id, user.id); } catch { /* best-effort */ }
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

  const cur = await db.select({ status: drTable.status }).from(drTable).where(eq(drTable.id, id)).limit(1);
  if (!cur[0]) return c.json({ error: "not_found" }, 404);
  const prevStatus = cur[0].status as string;
  if (body.status === "CANCELLED" && prevStatus === "CANCELLED") return c.json({ deliveryReturn: { id, status: "CANCELLED" } });
  // A CANCELLED DR is FINAL — raise a NEW return instead (un-cancel would leave stock drained).
  if (prevStatus === "CANCELLED") return c.json({ error: "dr_cancelled_final", reason: "A cancelled Delivery Return cannot be reactivated — its stock entry was already drained. Create a new return instead." }, 409);

  const now = new Date();
  const ts: Record<string, unknown> = { updatedAt: now, status: body.status };
  if (body.status === "RECEIVED") ts.receivedAt = now;
  if (body.status === "INSPECTED") { ts.inspectedAt = now; if (body.inspectionNotes) ts.inspectionNotes = body.inspectionNotes; }
  if (body.status === "REFUNDED") ts.refundedAt = now;

  let data: { id: string; status: string } | null;
  if (body.status === "CANCELLED") {
    const updated = await db.update(drTable).set(ts).where(and(eq(drTable.id, id), sql`${drTable.status} <> 'CANCELLED'`)).returning({ id: drTable.id, status: drTable.status });
    if (!updated[0]) return c.json({ deliveryReturn: { id, status: "CANCELLED" } });
    data = updated[0] as { id: string; status: string };
  } else {
    const updated = await db.update(drTable).set(ts).where(eq(drTable.id, id)).returning({ id: drTable.id, status: drTable.status });
    if (!updated[0]) return c.json({ error: "not_found" }, 404);
    data = updated[0] as { id: string; status: string };
  }

  if (body.status === "CANCELLED") {
    // Unified rollback: target net = 0 -> drains back out the booked return stock.
    try { await resyncInventoryForReturn(db, id, user.id); } catch { /* best-effort */ }
    try { await recomputeSoStockAllocation(db); } catch (e) { /* eslint-disable-next-line no-console */ console.error("[so-allocation] post-dr-cancel failed:", e); }
  }

  return c.json({ deliveryReturn: data });
});

export default app;
