// ----------------------------------------------------------------------------
// /inventory — trading-company stock model w/ FIFO COGS (PR #37/#38).
//
// 1:1 clone of 2990s apps/api/src/routes/inventory.ts. Endpoints, request
// bodies, response JSON shapes, status codes and business rules (warehouse CRUD,
// balances, movements ledger, FIFO lots, batch view, COGS, valuation, analytics,
// reconcile, manual adjustments, decrease-bucket picker) are kept identical to
// 2990s. Only the SEAMS change:
//   - DB layer: 2990s Supabase PostgREST (`sb.from(...)`) -> Houzs Drizzle
//     (`getDb(c.env)`), same JSON in/out (rule #3 + #7).
//   - Auth: 2990s supabaseAuth -> Houzs requirePermission("*") (rule #4).
//   - performed_by: 2990s staff.id (uuid) -> Houzs users.id (integer), from
//     c.get("user") (rule #4).
//   - The FIFO engine is the DB trigger trg_inventory_movement_fifo (migration
//     0026); this route writes movement rows + reads the inventory views it
//     maintains (inventory_balances / v_inventory_lots_open / v_inventory_value
//     / v_cogs_entries). Movement-writing goes through the shared
//     lib/inventory-movements helpers where 2990s used them.
//
// STRATEGY-2 product-layer seams (Houzs is not the 2990s furniture business; no
// mfg_products catalogue — see docs/scm-clone/PLAN.md):
//   - The two CATALOGUE-COUPLED views v_inventory_all_skus + v_inventory_product
//     _totals CROSS JOIN mfg_products, which Houzs lacks, so they are NOT created
//     (migration 0026). The endpoints that read them return a faithful EMPTY
//     shape so the pages render their empty state:
//       GET /inventory?showAll=true   -> { balances: [], warehouses: [...] }
//       GET /inventory/products       -> { products: [] }
//     The DEFAULT GET /inventory (showAll=false) reads inventory_balances (a
//     movement rollup, no product table) and works fully.
//     TODO: wire showAll + /products to a Houzs product source in the Products slice.
//   - GET /inventory/reconcile cross-checks grns/DOs/purchase_returns/delivery_
//     returns — none cloned yet -> returns zero issues. TODO: wire when those land.
//   - recomputeSoStockAllocation (SO slice) is a no-op here; call sites kept.
//   - variant_key is computed from the shared computeVariantKey; Houzs materials
//     have no item-group so it resolves to '' (one bucket per product_code). The
//     adjustment-increase furniture-axis gate (2990s adjustmentIncreaseErrors) is
//     dropped (no item-group); reason_code is still required.
//
// Endpoints (same as 2990s):
//   GET    /inventory/warehouses
//   POST   /inventory/warehouses
//   PATCH  /inventory/warehouses/:id
//   DELETE /inventory/warehouses/:id
//   GET    /inventory                          (showAll -> empty; default -> balances)
//   GET    /inventory/products                 (STUB -> { products: [] })
//   GET    /inventory/breakdown/:productCode
//   GET    /inventory/movements
//   GET    /inventory/lots/:productCode
//   GET    /inventory/batches
//   GET    /inventory/cogs
//   GET    /inventory/value
//   GET    /inventory/analytics
//   GET    /inventory/reconcile                (STUB -> zero issues)
//   POST   /inventory/adjustments
//   GET    /inventory/buckets/:productCode
// ----------------------------------------------------------------------------

import { Hono } from "hono";
import { and, asc, desc, eq, gte, ilike, inArray, lte, or, sql } from "drizzle-orm";
import { computeVariantKey, isAdjustmentReasonCode, type VariantAttrs } from "@shared/index";
import type { Env } from "../types";
import { getDb } from "../db/client";
import {
  mfgWarehouses as warehousesTable,
  inventoryMovements,
  inventoryLots,
  purchaseOrders as poTable,
  suppliers as suppliersTable,
} from "../db/schema";
import { requirePermission } from "../middleware/auth";
import { writeMovements } from "../lib/inventory-movements";
import { recomputeSoStockAllocation } from "../lib/so-stock-allocation";

const app = new Hono<{ Bindings: Env }>();

// Owner-only for now (rule #4). Gate every route in this module.
app.use("*", requirePermission("*"));

/* PostgREST .or() free-text escaper (2990s lib/postgrest-search.ts) — inlined
   (single-slice scope), same as the suppliers slice. */
function escapeForOr(search: string): string {
  return String(search ?? "").replace(/[,(){}]/g, "").trim();
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isUniqueViolation(e: unknown): boolean {
  return Boolean(e && typeof e === "object" && (e as { code?: string }).code === "23505");
}

function isFkViolation(e: unknown): boolean {
  return Boolean(e && typeof e === "object" && (e as { code?: string }).code === "23503");
}

/* SO stock-allocation recount — WIRED now that the SO slice has landed. A stock
   mutation (manual adjustment here) re-walks open SO lines so READY/PENDING
   flips correctly. Imported from ../lib/so-stock-allocation (best-effort;
   returns an AllocationResult the call sites ignore). */

/* ── Warehouses CRUD ─────────────────────────────────────────────────── */
app.get("/warehouses", async (c) => {
  const includeInactive = c.req.query("includeInactive") === "true";
  const db = getDb(c.env);
  try {
    const conds = includeInactive ? [] : [eq(warehousesTable.isActive, true)];
    const rows = await db
      .select({
        id: warehousesTable.id,
        code: warehousesTable.code,
        name: warehousesTable.name,
        location: warehousesTable.location,
        is_active: warehousesTable.isActive,
        is_default: warehousesTable.isDefault,
      })
      .from(warehousesTable)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(asc(warehousesTable.code));
    return c.json({ warehouses: rows });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

app.post("/warehouses", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const code = String(body.code ?? "").trim().toUpperCase();
  const name = String(body.name ?? "").trim();
  if (!code) return c.json({ error: "code_required" }, 400);
  if (!name) return c.json({ error: "name_required" }, 400);

  const db = getDb(c.env);
  try {
    const inserted = await db
      .insert(warehousesTable)
      .values({
        code,
        name,
        location: (body.location as string) ?? null,
        isActive: body.isActive === false ? false : true,
        isDefault: body.isDefault === true,
      })
      .returning({
        id: warehousesTable.id,
        code: warehousesTable.code,
        name: warehousesTable.name,
        location: warehousesTable.location,
        is_active: warehousesTable.isActive,
        is_default: warehousesTable.isDefault,
      });
    return c.json({ warehouse: inserted[0] }, 201);
  } catch (e) {
    if (isUniqueViolation(e)) return c.json({ error: "duplicate_code" }, 409);
    return c.json({ error: "insert_failed", reason: errMsg(e) }, 500);
  }
});

app.patch("/warehouses/:id", async (c) => {
  const id = c.req.param("id");
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const updates: Record<string, unknown> = {};
  if (typeof body.code === "string") updates.code = body.code.trim().toUpperCase();
  if (typeof body.name === "string") updates.name = body.name.trim();
  if (typeof body.location === "string") updates.location = body.location;
  if (typeof body.isActive === "boolean") updates.isActive = body.isActive;
  if (typeof body.isDefault === "boolean") updates.isDefault = body.isDefault;
  if (Object.keys(updates).length === 0) return c.json({ error: "no_changes" }, 400);
  updates.updatedAt = new Date();

  const db = getDb(c.env);
  try {
    const updated = await db
      .update(warehousesTable)
      .set(updates)
      .where(eq(warehousesTable.id, id))
      .returning({
        id: warehousesTable.id,
        code: warehousesTable.code,
        name: warehousesTable.name,
        location: warehousesTable.location,
        is_active: warehousesTable.isActive,
        is_default: warehousesTable.isDefault,
      });
    return c.json({ warehouse: updated[0] });
  } catch (e) {
    return c.json({ error: "update_failed", reason: errMsg(e) }, 500);
  }
});

/* Hard DELETE of a warehouse. Postgres FKs (inventory_movements/lots/etc) reject
   the delete when referenced history exists; the UI should toggle is_active=false
   in that case. We surface the FK error (23503) so the client can hint. */
app.delete("/warehouses/:id", async (c) => {
  const id = c.req.param("id");
  const db = getDb(c.env);
  try {
    await db.delete(warehousesTable).where(eq(warehousesTable.id, id));
    return c.json({ ok: true });
  } catch (e) {
    if (isFkViolation(e)) return c.json({ error: "in_use", reason: errMsg(e) }, 409);
    return c.json({ error: "delete_failed", reason: errMsg(e) }, 500);
  }
});

/* ── Balances ─────────────────────────────────────────────────────────── */
// showAll=true -> 2990s reads v_inventory_all_skus (CROSS JOIN mfg_products).
// Houzs has no product catalogue -> faithful empty balances (+ the warehouse
// list so the page chrome renders). TODO: wire to a Houzs product source.
// showAll=false (default) -> inventory_balances (movement rollup, no products).
app.get("/", async (c) => {
  const warehouseId = c.req.query("warehouseId");
  const search = c.req.query("search");
  const showAll = c.req.query("showAll") === "true";
  const db = getDb(c.env);

  // Active warehouses PLUS consignment ones (kept is_active=false so they stay
  // out of GRN/DO pickers) — so consigned stock at a showroom shows in Inventory.
  let whs: Array<Record<string, unknown>> = [];
  try {
    whs = await db
      .select({
        id: warehousesTable.id,
        code: warehousesTable.code,
        name: warehousesTable.name,
        is_consignment: warehousesTable.isConsignment,
      })
      .from(warehousesTable)
      .where(or(eq(warehousesTable.isActive, true), eq(warehousesTable.isConsignment, true)));
  } catch {
    /* best-effort — page still renders with no warehouse chips */
  }

  if (showAll) {
    // Strategy-2: catalogue rollup view not created (no mfg_products). Empty
    // balances; the page falls back to its "no SKUs" state. TODO: product slice.
    return c.json({ balances: [] as unknown[], warehouses: whs });
  }

  try {
    // inventory_balances VIEW: one row per (warehouse, product_code, variant_key)
    // = SUM(signed movements). Read it directly (no product table dependency).
    const conds: ReturnType<typeof eq>[] = [];
    if (warehouseId) conds.push(sql`warehouse_id = ${warehouseId}`);
    if (search) {
      const s = escapeForOr(search);
      if (s) conds.push(sql`(product_code ILIKE ${`%${s}%`} OR product_name ILIKE ${`%${s}%`})`);
    }
    const whereSql = conds.length ? sql` WHERE ${sql.join(conds, sql` AND `)}` : sql``;
    const rows = await db.execute<{
      warehouse_id: string;
      product_code: string;
      variant_key: string;
      product_name: string | null;
      qty: number;
      last_movement_at: string | null;
    }>(
      sql`SELECT warehouse_id, product_code, variant_key, product_name, qty, last_movement_at
          FROM inventory_balances${whereSql} ORDER BY product_code`,
    );
    return c.json({ balances: rows, warehouses: whs });
  } catch (e) {
    if (/relation .* does not exist/i.test(errMsg(e)) || /column .* does not exist/i.test(errMsg(e))) {
      return c.json({ error: "migration_pending", reason: "Run migration 0026 against the DB." }, 500);
    }
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

/* ── Product totals (AutoCount-style list) — STUB (Strategy-2) ───────────────
   2990s reads v_inventory_product_totals (CROSS JOIN mfg_products) + enriches
   each SKU with open-SO demand / incoming-PO supply. Houzs has no product
   catalogue -> faithful empty list so the Balances tab renders its empty state.
   TODO: wire to a Houzs product source + SO demand when those slices land. */
app.get("/products", async (c) => {
  return c.json({ products: [] as unknown[] });
});

/* ── Per (warehouse × variant) breakdown for one product (drilldown) ──────── */
app.get("/breakdown/:productCode", async (c) => {
  const productCode = c.req.param("productCode");
  const db = getDb(c.env);
  try {
    const bal = await db.execute<{
      warehouse_id: string;
      variant_key: string | null;
      qty: number;
      last_movement_at: string | null;
    }>(
      sql`SELECT warehouse_id, variant_key, qty, last_movement_at
          FROM inventory_balances WHERE product_code = ${productCode}`,
    );
    const val = await db
      .select({
        warehouse_id: sql<string>`warehouse_id`,
        variant_key: sql<string>`variant_key`,
        value_sen: sql<number>`value_sen`,
      })
      .from(sql`v_inventory_value`)
      .where(sql`product_code = ${productCode}`);
    const whs = await db
      .select({ id: warehousesTable.id, code: warehousesTable.code, name: warehousesTable.name })
      .from(warehousesTable);

    const whMap = new Map(whs.map((w) => [w.id, w]));
    const valMap = new Map(val.map((v) => [`${v.warehouse_id}|${v.variant_key}`, Number(v.value_sen ?? 0)]));
    const balances = bal.map((b) => {
      const vk = b.variant_key ?? "";
      const w = whMap.get(b.warehouse_id);
      return {
        warehouse_id: b.warehouse_id,
        warehouse_code: w?.code ?? null,
        warehouse_name: w?.name ?? null,
        variant_key: vk,
        product_code: productCode,
        qty: Number(b.qty ?? 0),
        value_sen: valMap.get(`${b.warehouse_id}|${vk}`) ?? 0,
        last_movement_at: b.last_movement_at ?? null,
      };
    });
    return c.json({ balances });
  } catch (e) {
    if (/relation .* does not exist/i.test(errMsg(e)) || /column .* does not exist/i.test(errMsg(e))) {
      return c.json({ error: "migration_pending", reason: "Run migration 0026 against the DB." }, 500);
    }
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

app.get("/movements", async (c) => {
  const warehouseId = c.req.query("warehouseId");
  const productCode = c.req.query("productCode");
  const docType = c.req.query("docType");
  const dateFrom = c.req.query("dateFrom");
  const dateTo = c.req.query("dateTo");
  const limit = Math.min(500, Number(c.req.query("limit") ?? 200));
  const db = getDb(c.env);

  const conds = [];
  if (warehouseId) conds.push(eq(inventoryMovements.warehouseId, warehouseId));
  if (productCode) conds.push(eq(inventoryMovements.productCode, productCode));
  if (docType) conds.push(eq(inventoryMovements.sourceDocType, docType));
  if (dateFrom) conds.push(gte(inventoryMovements.createdAt, new Date(dateFrom)));
  if (dateTo) conds.push(lte(inventoryMovements.createdAt, new Date(`${dateTo}T23:59:59Z`)));

  try {
    const rows = await db
      .select({
        id: inventoryMovements.id,
        movement_type: inventoryMovements.movementType,
        warehouse_id: inventoryMovements.warehouseId,
        product_code: inventoryMovements.productCode,
        product_name: inventoryMovements.productName,
        qty: inventoryMovements.qty,
        unit_cost_sen: inventoryMovements.unitCostSen,
        total_cost_sen: inventoryMovements.totalCostSen,
        source_doc_type: inventoryMovements.sourceDocType,
        source_doc_id: inventoryMovements.sourceDocId,
        source_doc_no: inventoryMovements.sourceDocNo,
        reason_code: inventoryMovements.reasonCode,
        notes: inventoryMovements.notes,
        performed_by: inventoryMovements.performedBy,
        created_at: inventoryMovements.createdAt,
      })
      .from(inventoryMovements)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(inventoryMovements.createdAt))
      .limit(limit);
    return c.json({ movements: rows.map(isoMovement) });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

/* ── FIFO lots drilldown for one product ─────────────────────────────── */
app.get("/lots/:productCode", async (c) => {
  const productCode = c.req.param("productCode");
  const warehouseId = c.req.query("warehouseId");
  const includeClosed = c.req.query("includeClosed") === "true";
  const db = getDb(c.env);

  try {
    if (includeClosed) {
      const conds = [eq(inventoryLots.productCode, productCode)];
      if (warehouseId) conds.push(eq(inventoryLots.warehouseId, warehouseId));
      const rows = await db
        .select()
        .from(inventoryLots)
        .where(and(...conds))
        .orderBy(asc(inventoryLots.receivedAt));
      // join warehouse code to mirror the view's warehouse_code column
      const whs = await db.select({ id: warehousesTable.id, code: warehousesTable.code }).from(warehousesTable);
      const whMap = new Map(whs.map((w) => [w.id, w.code]));
      return c.json({
        lots: rows.map((l) => ({
          id: l.id,
          warehouse_id: l.warehouseId,
          warehouse_code: whMap.get(l.warehouseId) ?? null,
          product_code: l.productCode,
          variant_key: l.variantKey,
          product_name: l.productName,
          qty_received: l.qtyReceived,
          qty_remaining: l.qtyRemaining,
          unit_cost_sen: l.unitCostSen,
          remaining_value_sen: l.qtyRemaining * l.unitCostSen,
          received_at: isoOrNull(l.receivedAt),
          source_doc_type: l.sourceDocType,
          source_doc_no: l.sourceDocNo,
          batch_no: l.batchNo,
        })),
      });
    }
    // Open lots only -> v_inventory_lots_open view.
    const conds = [sql`product_code = ${productCode}`];
    if (warehouseId) conds.push(sql`warehouse_id = ${warehouseId}`);
    const rows = await db.execute<Record<string, unknown>>(
      sql`SELECT * FROM v_inventory_lots_open WHERE ${sql.join(conds, sql` AND `)} ORDER BY received_at ASC`,
    );
    return c.json({ lots: rows });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

/* ── Batch availability (Stage 2 sofa batch view) ─────────────────────────
   Groups OPEN lots (qty_remaining>0) with a batch_no by (warehouse, batch) +
   resolves the batch's source PO (batch_no = PO number) -> supplier for display.
   The mfg_purchase_orders + suppliers tables ARE cloned, so the supplier lookup
   is wired. Verbatim shape. */
app.get("/batches", async (c) => {
  const warehouseId = c.req.query("warehouseId");
  const productCode = c.req.query("productCode");
  const db = getDb(c.env);

  try {
    const conds = [sql`batch_no IS NOT NULL`, sql`qty_remaining > 0`];
    if (warehouseId) conds.push(sql`warehouse_id = ${warehouseId}`);
    const lots = await db.execute<{
      warehouse_id: string;
      batch_no: string;
      product_code: string;
      variant_key: string | null;
      product_name: string | null;
      qty_remaining: number;
      unit_cost_sen: number | null;
      received_at: string | null;
    }>(
      sql`SELECT warehouse_id, batch_no, product_code, variant_key, product_name, qty_remaining, unit_cost_sen, received_at
          FROM v_inventory_lots_open WHERE ${sql.join(conds, sql` AND `)} ORDER BY received_at ASC`,
    );

    const whs = await db.select({ id: warehousesTable.id, name: warehousesTable.name }).from(warehousesTable);
    const whName = new Map(whs.map((w) => [w.id, w.name]));

    const batchNos = [...new Set(lots.map((r) => r.batch_no))];
    const supplierByPo = new Map<string, { id: string | null; name: string | null }>();
    if (batchNos.length > 0) {
      const pos = await db
        .select({
          po_number: poTable.poNumber,
          supplier_id: poTable.supplierId,
          supplier_name: suppliersTable.name,
        })
        .from(poTable)
        .leftJoin(suppliersTable, eq(poTable.supplierId, suppliersTable.id))
        .where(inArray(poTable.poNumber, batchNos));
      for (const p of pos) {
        supplierByPo.set(p.po_number, { id: p.supplier_id ?? null, name: p.supplier_name ?? null });
      }
    }

    type Component = {
      productCode: string; variantKey: string | null; productName: string | null;
      qtyRemaining: number; unitCostSen: number; receivedAt: string | null;
    };
    type Batch = {
      warehouseId: string; warehouseName: string | null; batchNo: string;
      supplierId: string | null; supplierName: string | null;
      receivedAt: string | null; totalRemaining: number; components: Component[];
    };
    const byBatch = new Map<string, Batch>();
    for (const r of lots) {
      const key = `${r.warehouse_id}|${r.batch_no}`;
      let b = byBatch.get(key);
      if (!b) {
        const sup = supplierByPo.get(r.batch_no) ?? { id: null, name: null };
        b = {
          warehouseId: r.warehouse_id,
          warehouseName: whName.get(r.warehouse_id) ?? null,
          batchNo: r.batch_no,
          supplierId: sup.id,
          supplierName: sup.name,
          receivedAt: r.received_at,
          totalRemaining: 0,
          components: [],
        };
        byBatch.set(key, b);
      }
      const existing = b.components.find(
        (c2) => c2.productCode === r.product_code && (c2.variantKey ?? "") === (r.variant_key ?? ""),
      );
      if (existing) {
        existing.qtyRemaining += r.qty_remaining;
      } else {
        b.components.push({
          productCode: r.product_code,
          variantKey: r.variant_key,
          productName: r.product_name,
          qtyRemaining: r.qty_remaining,
          unitCostSen: Number(r.unit_cost_sen ?? 0),
          receivedAt: r.received_at,
        });
      }
      b.totalRemaining += r.qty_remaining;
      if (r.received_at && (!b.receivedAt || r.received_at < b.receivedAt)) b.receivedAt = r.received_at;
    }

    let batches = [...byBatch.values()];
    if (productCode) batches = batches.filter((b) => b.components.some((c2) => c2.productCode === productCode));
    batches.sort((a, b) => (a.receivedAt ?? "").localeCompare(b.receivedAt ?? ""));

    return c.json({ batches });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

/* ── COGS stream ─────────────────────────────────────────────────────── */
app.get("/cogs", async (c) => {
  const warehouseId = c.req.query("warehouseId");
  const productCode = c.req.query("productCode");
  const from = c.req.query("from");
  const to = c.req.query("to");
  const db = getDb(c.env);

  try {
    const conds = [];
    if (warehouseId) conds.push(sql`warehouse_id = ${warehouseId}`);
    if (productCode) conds.push(sql`product_code = ${productCode}`);
    if (from) conds.push(sql`consumed_at >= ${from}`);
    if (to) conds.push(sql`consumed_at <= ${`${to}T23:59:59Z`}`);
    const whereSql = conds.length ? sql` WHERE ${sql.join(conds, sql` AND `)}` : sql``;
    const rows = await db.execute<Record<string, unknown>>(
      sql`SELECT * FROM v_cogs_entries${whereSql} LIMIT 1000`,
    );
    return c.json({ cogs: rows });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

/* ── Inventory valuation (qty × cost) ────────────────────────────────── */
app.get("/value", async (c) => {
  const warehouseId = c.req.query("warehouseId");
  const db = getDb(c.env);
  try {
    const whereSql = warehouseId ? sql` WHERE warehouse_id = ${warehouseId}` : sql``;
    const rows = await db.execute<Record<string, unknown>>(
      sql`SELECT * FROM v_inventory_value${whereSql} ORDER BY product_code`,
    );
    return c.json({ value: rows });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

/* ── Inventory analytics / KPI board ─────────────────────────────────────
   Pure read-only reporting from open lots + COGS stream (no product table). */
app.get("/analytics", async (c) => {
  const warehouseId = c.req.query("warehouseId");
  const days = Math.max(1, Math.min(365, Math.round(Number(c.req.query("days") ?? 90)) || 90));
  const nowMs = Date.now();
  const cutoffIso = new Date(nowMs - days * 86_400_000).toISOString();
  const db = getDb(c.env);

  try {
    const lotsWhere = warehouseId ? sql` WHERE warehouse_id = ${warehouseId}` : sql``;
    const lots = await db.execute<{
      product_code: string; product_name: string | null; qty_remaining: number;
      remaining_value_sen: number; received_at: string | null; warehouse_id: string;
    }>(
      sql`SELECT product_code, product_name, qty_remaining, remaining_value_sen, received_at, warehouse_id
          FROM v_inventory_lots_open${lotsWhere} LIMIT 50000`,
    );
    const cogsWhere = warehouseId ? sql` WHERE warehouse_id = ${warehouseId}` : sql``;
    const cogs = await db.execute<{
      product_code: string; total_cost_sen: number; consumed_at: string; warehouse_id: string;
    }>(
      sql`SELECT product_code, total_cost_sen, consumed_at, warehouse_id
          FROM v_cogs_entries${cogsWhere} LIMIT 100000`,
    );

    const BUCKETS = [
      { key: "0-30", label: "0–30 days", max: 30 },
      { key: "31-60", label: "31–60 days", max: 60 },
      { key: "61-90", label: "61–90 days", max: 90 },
      { key: "91-180", label: "91–180 days", max: 180 },
      { key: "180+", label: "180+ days", max: Infinity },
    ];
    const aging = BUCKETS.map((b) => ({ key: b.key, label: b.label, qty: 0, valueSen: 0 }));
    const prod = new Map<string, { name: string; qty: number; valueSen: number }>();
    let totalValueSen = 0;
    for (const l of lots) {
      const ageDays = (nowMs - new Date(l.received_at as string).getTime()) / 86_400_000;
      const idx = BUCKETS.findIndex((b) => ageDays <= b.max);
      const bucket = aging[idx < 0 ? aging.length - 1 : idx];
      const qty = Number(l.qty_remaining ?? 0);
      const val = Number(l.remaining_value_sen ?? 0);
      if (bucket) {
        bucket.qty += qty;
        bucket.valueSen += val;
      }
      totalValueSen += val;
      const code = String(l.product_code ?? "");
      const p = prod.get(code) ?? { name: String(l.product_name ?? code), qty: 0, valueSen: 0 };
      p.qty += qty;
      p.valueSen += val;
      prod.set(code, p);
    }

    const trailingCogs = new Map<string, number>();
    const lastSold = new Map<string, string>();
    let trailingCogsTotal = 0;
    for (const e of cogs) {
      const code = String(e.product_code ?? "");
      const at = String(e.consumed_at ?? "");
      const prev = lastSold.get(code);
      if (!prev || at > prev) lastSold.set(code, at);
      if (at >= cutoffIso) {
        const v = Number(e.total_cost_sen ?? 0);
        trailingCogs.set(code, (trailingCogs.get(code) ?? 0) + v);
        trailingCogsTotal += v;
      }
    }

    const annualizedCogs = trailingCogsTotal * (365 / days);
    const turns = totalValueSen > 0 ? annualizedCogs / totalValueSen : 0;
    const daysOnHand = trailingCogsTotal > 0 ? (totalValueSen * days) / trailingCogsTotal : null;

    const deadStock = [...prod.entries()]
      .filter(([code]) => !(trailingCogs.get(code) ?? 0))
      .map(([code, p]) => ({
        product_code: code, product_name: p.name, qty: p.qty, valueSen: p.valueSen,
        lastSoldAt: lastSold.get(code) ?? null,
      }))
      .sort((a, b) => b.valueSen - a.valueSen);

    const codes = new Set<string>([...prod.keys(), ...trailingCogs.keys()]);
    const ranked = [...codes]
      .map((code) => ({
        product_code: code,
        product_name: prod.get(code)?.name ?? code,
        cogsSen: trailingCogs.get(code) ?? 0,
        onHandValueSen: prod.get(code)?.valueSen ?? 0,
      }))
      .sort((a, b) => b.cogsSen - a.cogsSen);
    const summary = { A: { count: 0, valueSen: 0 }, B: { count: 0, valueSen: 0 }, C: { count: 0, valueSen: 0 } };
    let cum = 0;
    const abcItems = ranked.map((r) => {
      cum += r.cogsSen;
      const cumPct = trailingCogsTotal > 0 ? (cum / trailingCogsTotal) * 100 : 100;
      const cls: "A" | "B" | "C" = cumPct <= 80 ? "A" : cumPct <= 95 ? "B" : "C";
      summary[cls].count += 1;
      summary[cls].valueSen += r.onHandValueSen;
      return { ...r, cumPct, class: cls };
    });

    return c.json({
      asOf: new Date(nowMs).toISOString(),
      windowDays: days,
      totalValueSen,
      distinctSkus: prod.size,
      aging,
      turnover: { trailingCogsSen: trailingCogsTotal, annualizedTurns: turns, daysOnHand },
      deadStock,
      abc: { items: abcItems, summary },
    });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

/* ── Ledger reconciliation sweep — STUB (Strategy-2) ─────────────────────────
   2990s flags non-cancelled GRN/DO/Purchase-Return/Delivery-Return docs that
   should have moved stock but have ZERO movement rows. None of those doc tables
   are cloned yet -> nothing to reconcile -> zero issues. Verbatim response shape.
   TODO: wire to grns / delivery_orders / purchase_returns / delivery_returns. */
app.get("/reconcile", async (c) => {
  return c.json({ asOf: new Date().toISOString(), issueCount: 0, issues: [] as unknown[] });
});

/* ── Manual adjustment ───────────────────────────────────────────────── */
app.post("/adjustments", async (c) => {
  const user = c.get("user");
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  if (!body.warehouseId || !body.productCode) return c.json({ error: "warehouse_and_product_required" }, 400);
  const qtyDelta = Number(body.qtyDelta ?? 0);
  if (!Number.isFinite(qtyDelta) || qtyDelta === 0) return c.json({ error: "invalid_qty_delta" }, 400);

  // Structured reason is mandatory (audit trail), validated against the shared
  // catalogue (single source of truth shared with the frontend dropdown).
  const reasonCode = String(body.reasonCode ?? "");
  if (!isAdjustmentReasonCode(reasonCode)) return c.json({ error: "reason_required" }, 400);

  const warehouseId = String(body.warehouseId);
  const productCode = String(body.productCode);
  const itemGroup = (body.itemGroup as string | undefined) ?? null;
  const variants = (body.variants as Record<string, unknown> | null | undefined) ?? null;
  const batchNo = ((body.batchNo as string | undefined) ?? "").trim() || null;
  const db = getDb(c.env);

  // Resolve which stock bucket (variant_key + batch_no) this adjustment hits.
  //   INCREASE behaves like a mini-receipt: compute variant_key from the chosen
  //     attributes (mirrors GRN). STRATEGY-2: Houzs materials have no item-group,
  //     so computeVariantKey returns '' and 2990s's furniture-axis gate
  //     (adjustmentIncreaseErrors) does not apply — it's dropped here.
  //   DECREASE targets an EXISTING bucket the operator picked (explicit variantKey
  //     + batchNo); we verify enough is on hand (no orphan / negative bucket).
  let variantKey: string;
  if (qtyDelta > 0) {
    variantKey =
      body.variantKey != null
        ? String(body.variantKey)
        : computeVariantKey(itemGroup, (variants as VariantAttrs | null) ?? null);
  } else {
    variantKey = String(body.variantKey ?? "");
    const conds = [
      sql`warehouse_id = ${warehouseId}`,
      sql`product_code = ${productCode}`,
      sql`variant_key = ${variantKey}`,
      batchNo == null ? sql`batch_no IS NULL` : sql`batch_no = ${batchNo}`,
    ];
    const openLots = await db.execute<{ qty_remaining: number | null }>(
      sql`SELECT qty_remaining FROM v_inventory_lots_open WHERE ${sql.join(conds, sql` AND `)}`,
    );
    const available = openLots.reduce((s, l) => s + Number(l.qty_remaining ?? 0), 0);
    if (Math.abs(qtyDelta) > available) {
      return c.json(
        {
          error: "insufficient_bucket",
          message: `Only ${available} on hand in that batch/variant — you can't take out ${Math.abs(qtyDelta)}.`,
        },
        422,
      );
    }
  }

  // Write the ADJUSTMENT movement via the shared helper. The DB FIFO trigger
  // (migration 0026) honours batch_no on ADJUSTMENT: +qty creates a (batched)
  // lot, −qty consumes FIFO. We then read back the inserted row's id.
  const res = await writeMovements(db, [
    {
      movement_type: "ADJUSTMENT",
      warehouse_id: warehouseId,
      product_code: productCode,
      variant_key: variantKey,
      batch_no: batchNo,
      product_name: (body.productName as string) ?? null,
      qty: qtyDelta,
      unit_cost_sen: Number(body.unitCostSen ?? 0),
      source_doc_type: "ADJUSTMENT",
      reason_code: reasonCode,
      notes: (body.notes as string) ?? null,
      performed_by: user.id,
    },
  ]);
  if (!res.ok) return c.json({ error: "insert_failed", reason: res.reason }, 500);

  // SO allocation recount — a manual adjustment changes on-hand, so re-walk
  // open SO lines (READY/PENDING flips). Best-effort.
  try {
    await recomputeSoStockAllocation(db);
  } catch {
    /* best-effort */
  }
  // Mirror 2990s's { movement: { id } } shape — fetch the latest ADJUSTMENT row
  // we just wrote for this (warehouse, product). (2990s returned the insert's id.)
  try {
    const justInserted = await db
      .select({ id: inventoryMovements.id })
      .from(inventoryMovements)
      .where(
        and(
          eq(inventoryMovements.warehouseId, warehouseId),
          eq(inventoryMovements.productCode, productCode),
          eq(inventoryMovements.sourceDocType, "ADJUSTMENT"),
        ),
      )
      .orderBy(desc(inventoryMovements.createdAt))
      .limit(1);
    return c.json({ movement: { id: justInserted[0]?.id ?? null } }, 201);
  } catch {
    return c.json({ movement: { id: null } }, 201);
  }
});

/* ── Open stock buckets for one product (decrease-adjustment picker) ───────
   Groups OPEN lots of one SKU by (variant_key, batch_no) so a DECREASE can
   target the EXACT bucket. Verbatim shape. */
app.get("/buckets/:productCode", async (c) => {
  const productCode = c.req.param("productCode");
  const warehouseId = c.req.query("warehouseId");
  const db = getDb(c.env);

  try {
    const conds = [sql`product_code = ${productCode}`];
    if (warehouseId) conds.push(sql`warehouse_id = ${warehouseId}`);
    const rows = await db.execute<{
      warehouse_id: string; variant_key: string | null; batch_no: string | null;
      product_name: string | null; qty_remaining: number | null;
    }>(
      sql`SELECT warehouse_id, variant_key, batch_no, product_name, qty_remaining
          FROM v_inventory_lots_open WHERE ${sql.join(conds, sql` AND `)}`,
    );

    const byBucket = new Map<string, {
      warehouse_id: string; variant_key: string; batch_no: string | null;
      product_name: string | null; qty: number;
    }>();
    for (const l of rows) {
      const vk = l.variant_key ?? "";
      const bn = l.batch_no ?? null;
      const key = `${l.warehouse_id}|${vk}|${bn ?? ""}`;
      const cur = byBucket.get(key);
      if (cur) cur.qty += Number(l.qty_remaining ?? 0);
      else
        byBucket.set(key, {
          warehouse_id: l.warehouse_id,
          variant_key: vk,
          batch_no: bn,
          product_name: l.product_name,
          qty: Number(l.qty_remaining ?? 0),
        });
    }
    const buckets = [...byBucket.values()]
      .filter((b) => b.qty > 0)
      .sort((a, b) => (a.batch_no ?? "").localeCompare(b.batch_no ?? "") || a.variant_key.localeCompare(b.variant_key));
    return c.json({ buckets });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

// ── Response shaping ─────────────────────────────────────────────────
function isoOrNull(v: Date | string | null): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

function isoMovement(m: {
  id: string;
  movement_type: string;
  warehouse_id: string;
  product_code: string;
  product_name: string | null;
  qty: number;
  unit_cost_sen: number | null;
  total_cost_sen: number | null;
  source_doc_type: string | null;
  source_doc_id: string | null;
  source_doc_no: string | null;
  reason_code: string | null;
  notes: string | null;
  performed_by: number | null;
  created_at: Date | string | null;
}) {
  return { ...m, created_at: isoOrNull(m.created_at) };
}

export default app;
