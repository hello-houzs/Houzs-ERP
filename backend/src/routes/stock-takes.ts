// ----------------------------------------------------------------------------
// /stock-takes — AutoCount-style cycle count (PR — Inv PR5).
//
// 1:1 clone of 2990s apps/api/src/routes/stock-takes.ts. Endpoints, request
// bodies, response JSON shapes, status codes and business rules (OPEN working
// state, scope snapshot at create, bulk counted_qty update, Post writes ONE
// SIGNED ADJUSTMENT movement per non-zero-variance line, cancel OPEN, reverse
// POSTED, delete OPEN) are kept identical to 2990s. Only the SEAMS change:
//   - DB layer: 2990s Supabase PostgREST (`sb.from(...)`) -> Houzs Drizzle
//     (`getDb(c.env)`), same JSON in/out (rule #3 + #7). Drizzle camelCase rows ->
//     2990s snake_case wire shape via the to*Response() mappers.
//   - Auth: 2990s supabaseAuth -> Houzs requirePermission("*") (rule #4).
//   - user.id: 2990s staff.id (uuid) -> Houzs users.id (integer) (rule #4); the
//     created_by column is integer.
//   - Mount path: /api/stock-takes.
//   - Inventory writes go through the shared lib/inventory-movements helpers
//     (writeMovements), exactly where 2990s used them.
//
// STRATEGY-2 product-layer seam (the ONLY behavioural deviation):
//   2990s snapshots system_qty from v_inventory_all_skus (warehouse x SKU CROSS
//   JOIN mfg_products + category), so even SKUs with no movements yet land in the
//   count sheet. Houzs has NO mfg_products catalogue, so that view was NOT created
//   (migration 0026). We snapshot from inventory_balances instead (a movement
//   rollup, product-table-free, which DOES exist) — i.e. every SKU that has ever
//   moved in that warehouse, with its current on-hand qty. Consequences vs 2990s:
//     - SCOPE 'ALL'         -> every (product_code) with a balance row at the wh.
//     - SCOPE 'CODE_PREFIX' -> filtered by product_code ILIKE prefix% (works).
//     - SCOPE 'CATEGORY'    -> inventory_balances has NO category column (Houzs
//       materials have no item-group); there is nothing to filter on, so a
//       CATEGORY scope yields zero rows (scope_empty 400). Documented; revisit
//       when a Houzs product layer + categories land.
//   Post still writes a SIGNED ADJUSTMENT per non-zero-variance line so the
//   ledger reconciles to the counted figure (PLAN stocktake contract). The
//   variance column is GENERATED in the DB; we recompute defensively too.
//
//   SO auto-allocation re-walk (recomputeSoStockAllocation) -> no-op stub (SO
//   slice not cloned); call sites kept.
//
// OPEN -> POSTED. PR-DRAFT-removal (2990s 2026-05-27): DRAFT renamed OPEN because
// cycle counts need an editable working state (commander types counted_qty per
// line before posting). Numbering: STK-YYMM-NNN (month-scoped count + 1).
//
// Endpoints (same as 2990s):
//   GET    /stock-takes                — list (status, warehouseId, date filters)
//   GET    /stock-takes/:id            — header + lines + warehouse name
//   POST   /stock-takes                — create OPEN + snapshot scope
//   PATCH  /stock-takes/:id/lines      — bulk update counted_qty (OPEN only)
//   PATCH  /stock-takes/:id/post       — OPEN -> POSTED (writes ADJUSTMENT moves)
//   PATCH  /stock-takes/:id/cancel     — OPEN -> CANCELLED
//   PATCH  /stock-takes/:id/reverse    — POSTED -> CANCELLED (undo the ADJUSTMENTs)
//   DELETE /stock-takes/:id            — OPEN only
// ----------------------------------------------------------------------------

import { Hono } from "hono";
import { and, asc, desc, eq, gte, inArray, like, lte } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { Env } from "../types";
import { getDb } from "../db/client";
import {
  stockTakes as takesTable,
  stockTakeLines as takeLinesTable,
  inventoryMovements,
  mfgWarehouses as warehousesTable,
} from "../db/schema";
import { requirePermission } from "../middleware/auth";
import { writeMovements } from "../lib/inventory-movements";
import { recomputeSoStockAllocation } from "../lib/so-stock-allocation";

const app = new Hono<{ Bindings: Env }>();

// Owner-only for now (rule #4). Gate every route in this module.
app.use("*", requirePermission("*"));

type Db = ReturnType<typeof getDb>;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isoOrNull(v: Date | string | null): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

const VALID_STATUS = new Set(["OPEN", "POSTED", "CANCELLED"]);
const VALID_SCOPE = new Set(["ALL", "CATEGORY", "CODE_PREFIX"]);

/* SO stock-allocation recount — WIRED now that the SO slice has landed. A stock
   take reconciles on-hand to the counted figure, so re-walk open SO lines
   (READY/PENDING flips). Imported from ../lib/so-stock-allocation (best-effort). */

// ── Header / line response mappers (camelCase -> 2990s wire shape) ──────
type WarehouseLite = { id: string; code: string; name: string } | null;
function toTakeHeaderResponse(t: typeof takesTable.$inferSelect, wh: WarehouseLite) {
  return {
    id: t.id,
    take_no: t.takeNo,
    status: t.status,
    warehouse_id: t.warehouseId,
    scope_type: t.scopeType,
    scope_value: t.scopeValue,
    take_date: t.takeDate,
    notes: t.notes,
    posted_at: isoOrNull(t.postedAt),
    cancelled_at: isoOrNull(t.cancelledAt),
    created_at: isoOrNull(t.createdAt),
    created_by: t.createdBy,
    warehouse: wh,
  };
}

function toTakeLineResponse(l: typeof takeLinesTable.$inferSelect) {
  return {
    id: l.id,
    stock_take_id: l.stockTakeId,
    product_code: l.productCode,
    product_name: l.productName,
    system_qty: l.systemQty,
    counted_qty: l.countedQty,
    variance: l.variance,
    notes: l.notes,
    created_at: isoOrNull(l.createdAt),
  };
}

const nextTakeNo = async (db: Db): Promise<string> => {
  const d = new Date();
  const yymm = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, "0")}`;
  const rows = await db
    .select({ id: takesTable.id })
    .from(takesTable)
    .where(like(takesTable.takeNo, `STK-${yymm}-%`));
  return `STK-${yymm}-${String(rows.length + 1).padStart(3, "0")}`;
};

// ── Resolve in-scope SKUs + their current system_qty at the warehouse ──
// SEAM: 2990s hits v_inventory_all_skus (warehouse x SKU CROSS JOIN w/ category).
// Houzs has no product catalogue -> read inventory_balances (movement rollup,
// product-table-free). CATEGORY scope has nothing to filter (no category column)
// -> zero rows. CODE_PREFIX filters product_code; ALL returns all balances.
type ScopedSku = { product_code: string; product_name: string | null; qty: number };
const fetchScopedSkus = async (
  db: Db,
  warehouseId: string,
  scopeType: "ALL" | "CATEGORY" | "CODE_PREFIX",
  scopeValue: string | null,
): Promise<{ rows: ScopedSku[]; error?: string }> => {
  // CATEGORY scope can't be resolved without a product catalogue (no category in
  // inventory_balances) — yield nothing so the create returns scope_empty.
  if (scopeType === "CATEGORY") return { rows: [] };

  const conds = [sql`warehouse_id = ${warehouseId}`];
  if (scopeType === "CODE_PREFIX" && scopeValue) {
    conds.push(sql`product_code ILIKE ${`${scopeValue}%`}`);
  }
  try {
    const rows = await db.execute<{ product_code: string; product_name: string | null; qty: number | null }>(
      sql`SELECT product_code, MAX(product_name) AS product_name, SUM(qty) AS qty
          FROM inventory_balances WHERE ${sql.join(conds, sql` AND `)}
          GROUP BY product_code ORDER BY product_code`,
    );
    return {
      rows: rows.map((r) => ({
        product_code: r.product_code,
        product_name: r.product_name,
        qty: Number(r.qty ?? 0),
      })),
    };
  } catch (e) {
    return { rows: [], error: errMsg(e) };
  }
};

// ── List ──────────────────────────────────────────────────────────────
app.get("/", async (c) => {
  const db = getDb(c.env);
  const status = c.req.query("status");
  const warehouseId = c.req.query("warehouseId");
  const dateFrom = c.req.query("dateFrom");
  const dateTo = c.req.query("dateTo");

  const conds = [];
  if (status && VALID_STATUS.has(status)) conds.push(eq(takesTable.status, status));
  if (warehouseId) conds.push(eq(takesTable.warehouseId, warehouseId));
  if (dateFrom) conds.push(gte(takesTable.takeDate, dateFrom));
  if (dateTo) conds.push(lte(takesTable.takeDate, dateTo));

  try {
    const rows = await db
      .select()
      .from(takesTable)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(takesTable.takeDate), desc(takesTable.createdAt));

    const whs = await db
      .select({ id: warehousesTable.id, code: warehousesTable.code, name: warehousesTable.name })
      .from(warehousesTable);
    const whMap = new Map(whs.map((w) => [w.id, w]));

    // line_count + variance_total — cheap follow-up sum at pilot scale.
    const ids = rows.map((r) => r.id);
    const countByTake = new Map<string, number>();
    const varianceByTake = new Map<string, number>();
    if (ids.length > 0) {
      const lineRows = await db
        .select({
          stockTakeId: takeLinesTable.stockTakeId,
          variance: takeLinesTable.variance,
          countedQty: takeLinesTable.countedQty,
        })
        .from(takeLinesTable)
        .where(inArray(takeLinesTable.stockTakeId, ids));
      for (const l of lineRows) {
        countByTake.set(l.stockTakeId, (countByTake.get(l.stockTakeId) ?? 0) + 1);
        // Only count variance from lines that were actually counted.
        if (l.countedQty != null && l.variance != null) {
          varianceByTake.set(l.stockTakeId, (varianceByTake.get(l.stockTakeId) ?? 0) + Number(l.variance));
        }
      }
    }

    const takes = rows.map((r) => ({
      ...toTakeHeaderResponse(r, whMap.get(r.warehouseId) ?? null),
      line_count: countByTake.get(r.id) ?? 0,
      variance_total: varianceByTake.get(r.id) ?? 0,
    }));
    return c.json({ takes });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

// ── Detail ────────────────────────────────────────────────────────────
app.get("/:id", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  try {
    const [headerRows, lineRows] = await Promise.all([
      db.select().from(takesTable).where(eq(takesTable.id, id)).limit(1),
      db
        .select()
        .from(takeLinesTable)
        .where(eq(takeLinesTable.stockTakeId, id))
        .orderBy(asc(takeLinesTable.productCode)),
    ]);
    const header = headerRows[0];
    if (!header) return c.json({ error: "not_found" }, 404);

    const whs = await db
      .select({ id: warehousesTable.id, code: warehousesTable.code, name: warehousesTable.name })
      .from(warehousesTable)
      .where(eq(warehousesTable.id, header.warehouseId))
      .limit(1);

    return c.json({
      take: toTakeHeaderResponse(header, whs[0] ?? null),
      lines: lineRows.map(toTakeLineResponse),
    });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

// ── Create OPEN + snapshot scope ──────────────────────────────────────
// body: { warehouseId, takeDate?, scopeType, scopeValue?, notes? }
app.post("/", async (c) => {
  const db = getDb(c.env);
  const user = c.get("user");
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const warehouseId = body.warehouseId as string | undefined;
  if (!warehouseId) return c.json({ error: "warehouse_required" }, 400);

  const scopeType = (body.scopeType as string | undefined) ?? "ALL";
  if (!VALID_SCOPE.has(scopeType)) return c.json({ error: "invalid_scope_type" }, 400);

  const scopeValueRaw = (body.scopeValue as string | undefined) ?? null;
  const scopeValue = scopeValueRaw && scopeValueRaw.trim() ? scopeValueRaw.trim() : null;
  if ((scopeType === "CATEGORY" || scopeType === "CODE_PREFIX") && !scopeValue) {
    return c.json({ error: "scope_value_required_for_this_scope_type" }, 400);
  }

  // 1) Snapshot SKUs in scope.
  const scoped = await fetchScopedSkus(db, warehouseId, scopeType as "ALL" | "CATEGORY" | "CODE_PREFIX", scopeValue);
  if (scoped.error) return c.json({ error: "scope_load_failed", reason: scoped.error }, 500);
  if (scoped.rows.length === 0) {
    return c.json({ error: "scope_empty", reason: "No SKUs match the chosen scope." }, 400);
  }

  const takeNo = await nextTakeNo(db);

  let header: { id: string; takeNo: string };
  try {
    const inserted = await db
      .insert(takesTable)
      .values({
        takeNo,
        status: "OPEN",
        warehouseId,
        scopeType,
        scopeValue,
        ...(body.takeDate ? { takeDate: body.takeDate as string } : {}),
        notes: (body.notes as string | undefined) ?? null,
        createdBy: user.id,
      } as never)
      .returning({ id: takesTable.id, takeNo: takesTable.takeNo });
    header = inserted[0];
  } catch (e) {
    if (e && typeof e === "object" && (e as { code?: string }).code === "42501") {
      return c.json({ error: "forbidden", reason: errMsg(e) }, 403);
    }
    return c.json({ error: "insert_failed", reason: errMsg(e) }, 500);
  }

  // 2) Bulk-insert lines with system_qty filled + counted_qty NULL.
  const lineRows = scoped.rows.map((r) => ({
    stockTakeId: header.id,
    productCode: r.product_code,
    productName: r.product_name,
    systemQty: r.qty,
    countedQty: null,
  }));
  try {
    await db.insert(takeLinesTable).values(lineRows as never);
  } catch (e) {
    // Best-effort rollback so we don't leak a no-lines header.
    await db.delete(takesTable).where(eq(takesTable.id, header.id));
    return c.json({ error: "lines_insert_failed", reason: errMsg(e) }, 500);
  }

  return c.json({ id: header.id, takeNo: header.takeNo, lineCount: lineRows.length }, 201);
});

// ── Update counted_qty per line (bulk) ────────────────────────────────
// body: { lines: [{ id, countedQty (number | null), notes? }] }
app.patch("/:id/lines", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const prev = await db.select({ status: takesTable.status }).from(takesTable).where(eq(takesTable.id, id)).limit(1);
  if (!prev[0]) return c.json({ error: "not_found" }, 404);
  if (prev[0].status !== "OPEN") return c.json({ error: "not_open" }, 409);

  const lines = body.lines as Array<{ id: string; countedQty?: number | null; notes?: string | null }> | undefined;
  if (!Array.isArray(lines) || lines.length === 0) {
    return c.json({ error: "lines_required" }, 400);
  }

  // Issue updates one-at-a-time (pilot scale, <500 lines/take). Matches 2990s.
  const errors: string[] = [];
  for (const l of lines) {
    if (!l.id) continue;
    const patch: Record<string, unknown> = {};
    if ("countedQty" in l) {
      patch.countedQty =
        l.countedQty == null || (l.countedQty as unknown) === ""
          ? null
          : Math.max(0, Math.floor(Number(l.countedQty)));
    }
    if ("notes" in l) patch.notes = l.notes ?? null;
    if (Object.keys(patch).length === 0) continue;

    try {
      await db
        .update(takeLinesTable)
        .set(patch)
        .where(and(eq(takeLinesTable.id, l.id), eq(takeLinesTable.stockTakeId, id)));
    } catch (e) {
      errors.push(`${l.id}: ${errMsg(e)}`);
    }
  }

  if (errors.length > 0) {
    return c.json({ error: "partial_update_failed", errors }, 500);
  }
  return c.json({ ok: true, updated: lines.length });
});

// ── Cancel OPEN ───────────────────────────────────────────────────────
app.patch("/:id/cancel", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  let data: { id: string; status: string; cancelledAt: Date | null } | undefined;
  try {
    const updated = await db
      .update(takesTable)
      .set({ status: "CANCELLED", cancelledAt: new Date() })
      .where(and(eq(takesTable.id, id), eq(takesTable.status, "OPEN")))
      .returning({ id: takesTable.id, status: takesTable.status, cancelledAt: takesTable.cancelledAt });
    data = updated[0];
  } catch (e) {
    return c.json({ error: "cancel_failed", reason: errMsg(e) }, 500);
  }
  if (!data) return c.json({ error: "not_open" }, 409);
  return c.json({ take: { id: data.id, status: data.status, cancelled_at: isoOrNull(data.cancelledAt) } });
});

// ── Reverse POSTED -> CANCELLED (undo a posted count) ──────────────────
// Writes the OPPOSITE signed ADJUSTMENT for every movement the post wrote, so
// stock returns to exactly its pre-post level, then marks the take CANCELLED.
// Status flips POSTED -> CANCELLED FIRST (single-flight); a second call sees a
// non-POSTED row and returns 409, so reversal rows are written at most once.
app.patch("/:id/reverse", async (c) => {
  const db = getDb(c.env);
  const user = c.get("user");
  const id = c.req.param("id");

  // Flip status first so a concurrent reverse can't double-write movements.
  let cancelled: typeof takesTable.$inferSelect | undefined;
  try {
    const updated = await db
      .update(takesTable)
      .set({ status: "CANCELLED", cancelledAt: new Date() })
      .where(and(eq(takesTable.id, id), eq(takesTable.status, "POSTED")))
      .returning();
    cancelled = updated[0];
  } catch (e) {
    return c.json({ error: "reverse_failed", reason: errMsg(e) }, 500);
  }
  if (!cancelled) return c.json({ error: "not_posted" }, 409);

  const header = cancelled;

  // Load the forward ADJUSTMENT movements this take wrote. (Reversal can only run
  // once — the status gate above — so there are no prior reversal rows to filter.)
  let movs: Array<{
    warehouseId: string;
    productCode: string;
    productName: string | null;
    variantKey: string | null;
    batchNo: string | null;
    qty: number;
  }>;
  try {
    movs = await db
      .select({
        warehouseId: inventoryMovements.warehouseId,
        productCode: inventoryMovements.productCode,
        productName: inventoryMovements.productName,
        variantKey: inventoryMovements.variantKey,
        batchNo: inventoryMovements.batchNo,
        qty: inventoryMovements.qty,
      })
      .from(inventoryMovements)
      .where(and(eq(inventoryMovements.sourceDocType, "STOCK_TAKE"), eq(inventoryMovements.sourceDocId, id)));
  } catch (e) {
    return c.json({ error: "reverse_movements_load_failed", reason: errMsg(e) }, 500);
  }

  const reverseRows = movs
    .filter((m) => Boolean(m.qty)) // zero-variance lines wrote nothing; nothing to undo
    .map((m) => ({
      movement_type: "ADJUSTMENT" as const,
      warehouse_id: m.warehouseId,
      product_code: m.productCode,
      product_name: m.productName,
      variant_key: m.variantKey ?? "",
      batch_no: m.batchNo ?? null,
      qty: -m.qty, // flip the sign — undo
      unit_cost_sen: 0, // trigger recomputes cost
      source_doc_type: "STOCK_TAKE" as const,
      source_doc_id: header.id,
      source_doc_no: header.takeNo,
      reason_code: "COUNT",
      notes: `Reversal of stock take ${header.takeNo}`,
      performed_by: user.id,
    }));

  const movementErrors: string[] = [];
  if (reverseRows.length > 0) {
    const res = await writeMovements(db, reverseRows);
    if (!res.ok) movementErrors.push(res.reason ?? "movement write failed");
  }

  // Stock changed back — re-walk SO stock allocation (mirrors the post path).
  try {
    await recomputeSoStockAllocation(db);
  } catch (e) {
    console.error("[so-allocation] reverse-stock-take failed:", e);
  }

  return c.json({
    take: toTakeHeaderResponse(cancelled, null),
    movementsReversed: movementErrors.length ? 0 : reverseRows.length,
    movementErrors: movementErrors.length ? movementErrors : undefined,
  });
});

// ── Delete OPEN ───────────────────────────────────────────────────────
app.delete("/:id", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const prev = await db.select({ status: takesTable.status }).from(takesTable).where(eq(takesTable.id, id)).limit(1);
  if (!prev[0]) return c.json({ error: "not_found" }, 404);
  if (prev[0].status !== "OPEN") return c.json({ error: "not_open" }, 409);

  try {
    await db.delete(takesTable).where(eq(takesTable.id, id));
  } catch (e) {
    return c.json({ error: "delete_failed", reason: errMsg(e) }, 500);
  }
  return c.json({ ok: true });
});

// ── Post OPEN -> POSTED ────────────────────────────────────────────────
// For every line where counted_qty IS NOT NULL and variance != 0, write a single
// ADJUSTMENT movement with SIGNED qty (mirrors POST /inventory/adjustments).
// Lines with counted_qty == NULL are "untouched" (skipped).
app.patch("/:id/post", async (c) => {
  const db = getDb(c.env);
  const user = c.get("user");
  const id = c.req.param("id");

  // Flip status first so concurrent posts don't double-write movements.
  let posted: typeof takesTable.$inferSelect | undefined;
  try {
    const updated = await db
      .update(takesTable)
      .set({ status: "POSTED", postedAt: new Date() })
      .where(and(eq(takesTable.id, id), eq(takesTable.status, "OPEN")))
      .returning();
    posted = updated[0];
  } catch (e) {
    return c.json({ error: "post_failed", reason: errMsg(e) }, 500);
  }
  if (!posted) return c.json({ error: "not_open" }, 409);

  const header = posted;

  const lines = await db
    .select({
      productCode: takeLinesTable.productCode,
      productName: takeLinesTable.productName,
      systemQty: takeLinesTable.systemQty,
      countedQty: takeLinesTable.countedQty,
      variance: takeLinesTable.variance,
      notes: takeLinesTable.notes,
    })
    .from(takeLinesTable)
    .where(eq(takeLinesTable.stockTakeId, id));

  const adjustmentRows = [];
  for (const ln of lines) {
    if (ln.countedQty == null) continue;
    // Recompute defensively — variance is generated in DB but be safe.
    const variance = ln.variance ?? ln.countedQty - ln.systemQty;
    if (variance === 0) continue;
    adjustmentRows.push({
      movement_type: "ADJUSTMENT" as const,
      warehouse_id: header.warehouseId,
      product_code: ln.productCode,
      product_name: ln.productName,
      qty: variance, // SIGNED — see /inventory/adjustments
      unit_cost_sen: 0,
      source_doc_type: "STOCK_TAKE" as const,
      source_doc_id: header.id,
      source_doc_no: header.takeNo,
      reason_code: "COUNT", // count correction
      notes: `Stock take variance${ln.notes ? ` · ${ln.notes}` : ""}`,
      performed_by: user.id,
    });
  }

  const movementErrors: string[] = [];
  if (adjustmentRows.length > 0) {
    // One bulk insert — the FIFO trigger runs row-by-row anyway. Best-effort:
    // failures listed, post not rolled back (audit-DLQ posture).
    const res = await writeMovements(db, adjustmentRows);
    if (!res.ok) movementErrors.push(res.reason ?? "movement write failed");
  }

  // B2C SO auto-allocation — variance changed stock, re-walk (no-op until SO).
  try {
    await recomputeSoStockAllocation(db);
  } catch (e) {
    console.error("[so-allocation] post-stock-take failed:", e);
  }

  return c.json({
    take: toTakeHeaderResponse(posted, null),
    movementsWritten: movementErrors.length ? 0 : adjustmentRows.length,
    movementErrors: movementErrors.length ? movementErrors : undefined,
  });
});

export default app;
