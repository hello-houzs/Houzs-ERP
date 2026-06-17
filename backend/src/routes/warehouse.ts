// ----------------------------------------------------------------------------
// /mfg-warehouses — rack/bin management (ported from Hookka ERP via 2990s).
//
// 1:1 clone of 2990s apps/api/src/routes/warehouse.ts. A physical-location layer
// on top of the trading-company warehouses table: each warehouse splits into
// racks, each rack holds zero-to-many items, every stock-in/out/transfer is an
// append-only rack movement (Movement History tab). Rack status
// (OCCUPIED/RESERVED/EMPTY) is derived + re-persisted on every write so the
// rack-grid list stays a single SELECT. Endpoints, request bodies, response
// shapes, status codes + the derive-status rule are identical to 2990s. Only the
// SEAMS change:
//   - DB layer: 2990s Supabase PostgREST (`sb.from(...)`) -> Houzs Drizzle
//     (`getDb(c.env)`), same JSON in/out (rule #3 + #7).
//   - Auth: 2990s supabaseAuth -> Houzs requirePermission("*") (rule #4).
//   - performed_by: 2990s staff.id (uuid) -> Houzs users.id (integer) (rule #4).
//   - MOUNT PATH: /api/mfg-warehouses (the bare /api/warehouses is the live
//     AutoCount route — NOT touched). The clone's warehouse table is
//     mfg_warehouses (NAMING CONVENTION); these racks reference it.
//
// Endpoints (same as 2990s):
//   GET    /mfg-warehouses                 — rack list (with items) + KPI summary
//   POST   /mfg-warehouses/racks           — create a rack (or seed N racks)
//   PATCH  /mfg-warehouses/racks/:id       — toggle reserved / edit label/notes
//   DELETE /mfg-warehouses/racks/:id       — delete an empty rack
//   POST   /mfg-warehouses/stock-in        — add an item to a rack + log STOCK_IN
//   POST   /mfg-warehouses/stock-out       — remove an item from a rack + log STOCK_OUT
//   POST   /mfg-warehouses/transfer        — move qty rack -> rack (same warehouse)
//   GET    /mfg-warehouses/movements       — movement ledger (filter type/from/to)
// ----------------------------------------------------------------------------

import { Hono } from "hono";
import { and, asc, desc, eq, gte, lte, inArray, count as drizzleCount } from "drizzle-orm";
import type { Env } from "../types";
import { getDb } from "../db/client";
import {
  mfgWarehouses as warehousesTable,
  warehouseRacks,
  warehouseRackItems,
  warehouseRackMovements,
} from "../db/schema";
import { requirePermission } from "../middleware/auth";

const app = new Hono<{ Bindings: Env }>();
app.use("*", requirePermission("*"));

type RackStatus = "OCCUPIED" | "EMPTY" | "RESERVED";

type Db = ReturnType<typeof getDb>;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
function isUniqueViolation(e: unknown): boolean {
  return Boolean(e && typeof e === "object" && (e as { code?: string }).code === "23505");
}

// Derive rack status from its items + reserved flag. Items always win.
function deriveStatus(itemCount: number, reserved: boolean): RackStatus {
  if (itemCount > 0) return "OCCUPIED";
  if (reserved) return "RESERVED";
  return "EMPTY";
}

// Recompute + persist a rack's status from its current item rows.
async function refreshRackStatus(db: Db, rackId: string): Promise<RackStatus> {
  const rackRows = await db
    .select({ reserved: warehouseRacks.reserved })
    .from(warehouseRacks)
    .where(eq(warehouseRacks.id, rackId))
    .limit(1);
  const cnt = await db
    .select({ n: drizzleCount() })
    .from(warehouseRackItems)
    .where(eq(warehouseRackItems.rackId, rackId));
  const status = deriveStatus(Number(cnt[0]?.n ?? 0), rackRows[0]?.reserved ?? false);
  await db.update(warehouseRacks).set({ status, updatedAt: new Date() }).where(eq(warehouseRacks.id, rackId));
  return status;
}

// Response mappers — emit the snake_case wire shape 2990s's frontend expects.
function isoOrNull(v: Date | string | null): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}
type RackDb = typeof warehouseRacks.$inferSelect;
type RackItemDb = typeof warehouseRackItems.$inferSelect;
function toRack(r: RackDb) {
  return {
    id: r.id,
    warehouse_id: r.warehouseId,
    rack: r.rack,
    position: r.position,
    status: r.status,
    reserved: r.reserved,
    notes: r.notes,
    created_at: isoOrNull(r.createdAt),
    updated_at: isoOrNull(r.updatedAt),
  };
}
function toItem(it: RackItemDb) {
  return {
    id: it.id,
    rack_id: it.rackId,
    product_code: it.productCode,
    variant_key: it.variantKey,
    product_name: it.productName,
    size_label: it.sizeLabel,
    customer_name: it.customerName,
    source_doc_no: it.sourceDocNo,
    qty: it.qty,
    stocked_in_date: it.stockedInDate,
    notes: it.notes,
  };
}

// ── GET / — rack grid + KPI summary ────────────────────────────────────────
app.get("/", async (c) => {
  const warehouseId = c.req.query("warehouseId");
  const db = getDb(c.env);

  try {
    const rackConds = warehouseId ? [eq(warehouseRacks.warehouseId, warehouseId)] : [];
    const racks = await db
      .select()
      .from(warehouseRacks)
      .where(rackConds.length ? and(...rackConds) : undefined)
      .orderBy(asc(warehouseRacks.rack));

    const rackIds = racks.map((r) => r.id);
    let items: RackItemDb[] = [];
    if (rackIds.length > 0) {
      items = await db
        .select()
        .from(warehouseRackItems)
        .where(inArray(warehouseRackItems.rackId, rackIds))
        .orderBy(asc(warehouseRackItems.stockedInDate));
    }

    const itemsByRack = new Map<string, RackItemDb[]>();
    for (const it of items) {
      const arr = itemsByRack.get(it.rackId) ?? [];
      arr.push(it);
      itemsByRack.set(it.rackId, arr);
    }

    const data = racks.map((r) => {
      const rackItems = itemsByRack.get(r.id) ?? [];
      return {
        ...toRack(r),
        // Re-derive on read so a stale persisted value never lies to the UI.
        status: deriveStatus(rackItems.length, r.reserved),
        items: rackItems.map(toItem),
      };
    });

    const total = data.length;
    const occupied = data.filter((r) => r.status === "OCCUPIED").length;
    const empty = data.filter((r) => r.status === "EMPTY").length;
    const reserved = data.filter((r) => r.status === "RESERVED").length;
    const occupancyRate = total > 0 ? Math.round((occupied / total) * 100) : 0;

    const warehouses = await db
      .select({ id: warehousesTable.id, code: warehousesTable.code, name: warehousesTable.name })
      .from(warehousesTable)
      .where(eq(warehousesTable.isActive, true))
      .orderBy(asc(warehousesTable.code));

    return c.json({ racks: data, warehouses, summary: { total, occupied, empty, reserved, occupancyRate } });
  } catch (e) {
    if (/relation .* does not exist/i.test(errMsg(e))) {
      return c.json({ error: "migration_pending", reason: "Run migration 0026 against the DB." }, 500);
    }
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

// ── POST /racks — create one rack, or seed `count` racks ───────────────────
app.post("/racks", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const warehouseId = String(body.warehouseId ?? "").trim();
  if (!warehouseId) return c.json({ error: "warehouse_required" }, 400);
  const db = getDb(c.env);

  const count = Number(body.count ?? 0);
  if (Number.isFinite(count) && count > 0) {
    const prefix = String(body.prefix ?? "Rack").trim() || "Rack";
    const existing = await db
      .select({ rack: warehouseRacks.rack })
      .from(warehouseRacks)
      .where(eq(warehouseRacks.warehouseId, warehouseId));
    const taken = new Set(existing.map((r) => r.rack));
    const rows: Array<{ warehouseId: string; rack: string; status: string }> = [];
    for (let i = 1; i <= Math.min(count, 200); i++) {
      const label = `${prefix} ${i}`;
      if (!taken.has(label)) rows.push({ warehouseId, rack: label, status: "EMPTY" });
    }
    if (rows.length === 0) return c.json({ racks: [], created: 0 });
    try {
      const data = await db.insert(warehouseRacks).values(rows as never).returning();
      return c.json({ racks: data.map(toRack), created: data.length }, 201);
    } catch (e) {
      return c.json({ error: "insert_failed", reason: errMsg(e) }, 500);
    }
  }

  const rack = String(body.rack ?? "").trim();
  if (!rack) return c.json({ error: "rack_required" }, 400);
  try {
    const inserted = await db
      .insert(warehouseRacks)
      .values({
        warehouseId,
        rack,
        position: (body.position as string) ?? null,
        reserved: body.reserved === true,
        status: body.reserved === true ? "RESERVED" : "EMPTY",
        notes: (body.notes as string) ?? null,
      })
      .returning();
    return c.json({ rack: toRack(inserted[0]) }, 201);
  } catch (e) {
    if (isUniqueViolation(e)) return c.json({ error: "duplicate_rack" }, 409);
    return c.json({ error: "insert_failed", reason: errMsg(e) }, 500);
  }
});

// ── PATCH /racks/:id — toggle reserved / edit label/notes ──────────────────
app.patch("/racks/:id", async (c) => {
  const id = c.req.param("id");
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (typeof body.rack === "string") updates.rack = body.rack.trim();
  if (typeof body.position === "string") updates.position = body.position;
  if (typeof body.notes === "string") updates.notes = body.notes;
  if (typeof body.reserved === "boolean") updates.reserved = body.reserved;

  const db = getDb(c.env);
  try {
    await db.update(warehouseRacks).set(updates).where(eq(warehouseRacks.id, id));
  } catch (e) {
    if (isUniqueViolation(e)) return c.json({ error: "duplicate_rack" }, 409);
    return c.json({ error: "update_failed", reason: errMsg(e) }, 500);
  }
  const status = await refreshRackStatus(db, id);
  const rows = await db.select().from(warehouseRacks).where(eq(warehouseRacks.id, id)).limit(1);
  return c.json({ rack: rows[0] ? toRack(rows[0]) : null, status });
});

// ── DELETE /racks/:id — only when empty ────────────────────────────────────
app.delete("/racks/:id", async (c) => {
  const id = c.req.param("id");
  const db = getDb(c.env);
  const cnt = await db
    .select({ n: drizzleCount() })
    .from(warehouseRackItems)
    .where(eq(warehouseRackItems.rackId, id));
  if (Number(cnt[0]?.n ?? 0) > 0) return c.json({ error: "rack_not_empty" }, 409);
  try {
    await db.delete(warehouseRacks).where(eq(warehouseRacks.id, id));
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: "delete_failed", reason: errMsg(e) }, 500);
  }
});

// ── POST /stock-in — add an item to a rack + log the movement ──────────────
app.post("/stock-in", async (c) => {
  const user = c.get("user");
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const rackId = String(body.rackId ?? "").trim();
  const productCode = String(body.productCode ?? "").trim();
  if (!rackId) return c.json({ error: "rack_required" }, 400);
  if (!productCode) return c.json({ error: "product_code_required" }, 400);
  const qty = Math.max(1, Number(body.qty ?? 1) || 1);
  const db = getDb(c.env);

  const rackRows = await db
    .select({ id: warehouseRacks.id, rack: warehouseRacks.rack, warehouseId: warehouseRacks.warehouseId })
    .from(warehouseRacks)
    .where(eq(warehouseRacks.id, rackId))
    .limit(1);
  const rack = rackRows[0];
  if (!rack) return c.json({ error: "rack_not_found" }, 404);

  const productName = (body.productName as string) ?? null;
  const sizeLabel = (body.sizeLabel as string) ?? null;
  const customerName = (body.customerName as string) ?? null;
  const sourceDocNo = (body.sourceDocNo as string) ?? null;
  const notes = (body.notes as string) ?? null;

  try {
    const inserted = await db
      .insert(warehouseRackItems)
      .values({
        rackId,
        productCode,
        productName,
        sizeLabel,
        customerName,
        sourceDocNo,
        qty,
        stockedInDate: new Date().toISOString().slice(0, 10),
        notes,
      })
      .returning();

    const status = await refreshRackStatus(db, rackId);

    await db.insert(warehouseRackMovements).values({
      movementType: "STOCK_IN",
      rackId,
      rackLabel: rack.rack,
      warehouseId: rack.warehouseId,
      productCode,
      productName,
      sourceDocNo,
      quantity: qty,
      reason: (body.reason as string) ?? "Stock in",
      performedBy: user.id,
    });

    return c.json({ item: toItem(inserted[0]), status }, 201);
  } catch (e) {
    return c.json({ error: "insert_failed", reason: errMsg(e) }, 500);
  }
});

// ── POST /stock-out — remove an item from a rack + log it ──────────────────
app.post("/stock-out", async (c) => {
  const user = c.get("user");
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const itemId = String(body.itemId ?? "").trim();
  if (!itemId) return c.json({ error: "item_required" }, 400);
  const db = getDb(c.env);

  const itemRows = await db.select().from(warehouseRackItems).where(eq(warehouseRackItems.id, itemId)).limit(1);
  const item = itemRows[0];
  if (!item) return c.json({ error: "item_not_found" }, 404);
  const rackRows = await db
    .select({ id: warehouseRacks.id, rack: warehouseRacks.rack, warehouseId: warehouseRacks.warehouseId })
    .from(warehouseRacks)
    .where(eq(warehouseRacks.id, item.rackId))
    .limit(1);
  const rack = rackRows[0] ?? null;

  try {
    await db.delete(warehouseRackItems).where(eq(warehouseRackItems.id, itemId));
  } catch (e) {
    return c.json({ error: "delete_failed", reason: errMsg(e) }, 500);
  }

  let status: RackStatus | null = null;
  if (rack) status = await refreshRackStatus(db, rack.id);

  await db.insert(warehouseRackMovements).values({
    movementType: "STOCK_OUT",
    rackId: rack?.id ?? null,
    rackLabel: rack?.rack ?? null,
    warehouseId: rack?.warehouseId ?? null,
    productCode: item.productCode,
    productName: item.productName,
    sourceDocNo: item.sourceDocNo,
    quantity: item.qty,
    reason: (body.reason as string) ?? "Stock out",
    performedBy: user.id,
  });

  return c.json({ ok: true, status });
});

// ── POST /transfer — move qty from one rack to another (same warehouse) ────
app.post("/transfer", async (c) => {
  const user = c.get("user");
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const fromItemId = String(body.fromItemId ?? "").trim();
  const toRackId = String(body.toRackId ?? "").trim();
  if (!fromItemId) return c.json({ error: "from_item_required" }, 400);
  if (!toRackId) return c.json({ error: "to_rack_required" }, 400);
  const db = getDb(c.env);

  const itemRows = await db.select().from(warehouseRackItems).where(eq(warehouseRackItems.id, fromItemId)).limit(1);
  const item = itemRows[0];
  if (!item) return c.json({ error: "item_not_found" }, 404);
  const fromRackRows = await db
    .select({ id: warehouseRacks.id, rack: warehouseRacks.rack, warehouseId: warehouseRacks.warehouseId })
    .from(warehouseRacks)
    .where(eq(warehouseRacks.id, item.rackId))
    .limit(1);
  const fromRack = fromRackRows[0] ?? null;
  if (!fromRack) return c.json({ error: "source_rack_not_found" }, 404);
  if (fromRack.id === toRackId) return c.json({ error: "same_rack" }, 400);

  const toRackRows = await db
    .select({ id: warehouseRacks.id, rack: warehouseRacks.rack, warehouseId: warehouseRacks.warehouseId })
    .from(warehouseRacks)
    .where(eq(warehouseRacks.id, toRackId))
    .limit(1);
  const toRack = toRackRows[0];
  if (!toRack) return c.json({ error: "to_rack_not_found" }, 404);
  if (toRack.warehouseId !== fromRack.warehouseId) return c.json({ error: "cross_warehouse_not_allowed" }, 400);

  const moveQty = Math.min(Math.max(1, Number(body.qty ?? item.qty) || item.qty), item.qty);
  const vk = item.variantKey ?? "";

  if (moveQty >= item.qty) {
    await db.delete(warehouseRackItems).where(eq(warehouseRackItems.id, fromItemId));
  } else {
    await db.update(warehouseRackItems).set({ qty: item.qty - moveQty }).where(eq(warehouseRackItems.id, fromItemId));
  }

  const dstRows = await db
    .select({ id: warehouseRackItems.id, qty: warehouseRackItems.qty })
    .from(warehouseRackItems)
    .where(
      and(
        eq(warehouseRackItems.rackId, toRackId),
        eq(warehouseRackItems.productCode, item.productCode),
        eq(warehouseRackItems.variantKey, vk),
      ),
    )
    .limit(1);
  const dstExisting = dstRows[0];
  if (dstExisting) {
    await db.update(warehouseRackItems).set({ qty: dstExisting.qty + moveQty }).where(eq(warehouseRackItems.id, dstExisting.id));
  } else {
    await db.insert(warehouseRackItems).values({
      rackId: toRackId,
      productCode: item.productCode,
      variantKey: vk,
      productName: item.productName,
      sizeLabel: item.sizeLabel ?? null,
      customerName: item.customerName ?? null,
      sourceDocNo: item.sourceDocNo ?? null,
      qty: moveQty,
      stockedInDate: item.stockedInDate,
    });
  }

  const fromStatus = await refreshRackStatus(db, fromRack.id);
  const toStatus = await refreshRackStatus(db, toRackId);

  await db.insert(warehouseRackMovements).values({
    movementType: "TRANSFER",
    rackId: fromRack.id,
    rackLabel: fromRack.rack,
    toRackId: toRack.id,
    toRackLabel: toRack.rack,
    warehouseId: fromRack.warehouseId,
    productCode: item.productCode,
    variantKey: vk,
    productName: item.productName,
    sourceDocNo: item.sourceDocNo ?? null,
    quantity: moveQty,
    reason: (body.reason as string) ?? "Rack transfer",
    performedBy: user.id,
  });

  return c.json({ ok: true, fromStatus, toStatus });
});

// ── GET /movements — append-only ledger ────────────────────────────────────
app.get("/movements", async (c) => {
  const type = c.req.query("type");
  const from = c.req.query("from");
  const to = c.req.query("to");
  const warehouseId = c.req.query("warehouseId");
  const limit = Math.min(1000, Number(c.req.query("limit") ?? 500));
  const db = getDb(c.env);

  const conds = [];
  if (type) conds.push(eq(warehouseRackMovements.movementType, type));
  if (warehouseId) conds.push(eq(warehouseRackMovements.warehouseId, warehouseId));
  if (from) conds.push(gte(warehouseRackMovements.createdAt, new Date(from)));
  if (to) conds.push(lte(warehouseRackMovements.createdAt, new Date(`${to}T23:59:59Z`)));

  try {
    const rows = await db
      .select()
      .from(warehouseRackMovements)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(warehouseRackMovements.createdAt))
      .limit(limit);
    return c.json({
      movements: rows.map((m) => ({
        id: m.id,
        movement_type: m.movementType,
        rack_id: m.rackId,
        rack_label: m.rackLabel,
        to_rack_id: m.toRackId,
        to_rack_label: m.toRackLabel,
        warehouse_id: m.warehouseId,
        product_code: m.productCode,
        variant_key: m.variantKey,
        product_name: m.productName,
        source_doc_no: m.sourceDocNo,
        quantity: m.quantity,
        reason: m.reason,
        performed_by: m.performedBy,
        created_at: isoOrNull(m.createdAt),
      })),
    });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

export default app;
