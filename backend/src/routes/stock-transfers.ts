// ----------------------------------------------------------------------------
// /stock-transfers — move stock between warehouses with a document trail.
//
// 1:1 clone of 2990s apps/api/src/routes/stock-transfers.ts. Endpoints, request
// bodies, response JSON shapes, status codes and business rules (POSTED-on-
// create, paired OUT@from + IN@to inventory movements, the re-query-after-insert
// cost handoff, the dye-lot carry, variant-aware idempotent cancel/reversal,
// delete disabled) are kept identical to 2990s. Only the SEAMS change:
//   - DB layer: 2990s per-request Supabase PostgREST (`sb.from(...)`) -> Houzs
//     Drizzle (`getDb(c.env)`), same JSON in/out (rule #3 + #7). Drizzle returns
//     camelCase rows; the wire shapes keep 2990s's snake_case via the
//     to*Response() mappers (rule #7).
//   - Auth: 2990s supabaseAuth -> Houzs requirePermission("*") (rule #4).
//   - user.id: 2990s staff.id (uuid) -> Houzs users.id (integer) (rule #4); the
//     created_by column is integer.
//   - Mount path: /api/stock-transfers.
//   - Inventory writes go through the shared lib/inventory-movements helpers
//     (writeMovements / reverseMovements / resolveWarehouseLotBatches), exactly
//     where 2990s used them.
//
// PR-DRAFT-removal (2990s 2026-05-27): DRAFT step removed. POST creates the row
// as POSTED directly + writes paired OUT@from + IN@to inventory_movements
// inline. PATCH /:id/post kept as a no-op for backward compat. FIFO trigger
// (migration 0026) consumes from source lots and computes cost on the OUT row.
// We then read OUT.total_cost_sen / OUT.qty back and feed it into the IN as
// unit_cost_sen so the destination lot opens at the right basis.
//
// Strategy-2 product-layer simplifications (Houzs is not the 2990s furniture
// business; owner enters own data — see docs/scm-clone/PLAN.md):
//   - materials are TEXT (product_code); variant_key passes through ('' = one
//     bucket per product_code). No furniture pickers / formatters.
//   - 2990s re-walks open SO lines after a stock mutation (recomputeSoStock
//     Allocation). The SO slice isn't cloned -> that call is a no-op stub; the
//     call sites are kept so wiring it later is a one-function change.
//
// Endpoints (same as 2990s):
//   GET    /stock-transfers                — list (status/from/to/date filters)
//   GET    /stock-transfers/:id            — header + lines + warehouse names
//   POST   /stock-transfers                — create + post (writes movements)
//   PATCH  /stock-transfers/:id/post       — idempotent no-op (legacy)
//   PATCH  /stock-transfers/:id/cancel     — POSTED -> CANCELLED + reverses the
//                                            inter-warehouse movement (variant-
//                                            aware, idempotent)
//   DELETE /stock-transfers/:id            — disabled (only CANCELLED allowed)
// ----------------------------------------------------------------------------

import { Hono } from "hono";
import { and, asc, desc, eq, gte, inArray, like, lte, ne } from "drizzle-orm";
import type { Env } from "../types";
import { getDb } from "../db/client";
import {
  stockTransfers as transfersTable,
  stockTransferLines as transferLinesTable,
  inventoryMovements,
  mfgWarehouses as warehousesTable,
} from "../db/schema";
import { requirePermission } from "../middleware/auth";
import {
  writeMovements,
  reverseMovements,
  resolveWarehouseLotBatches,
} from "../lib/inventory-movements";
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

const VALID_STATUS = new Set(["POSTED", "CANCELLED"]);

/* SO stock-allocation recount — WIRED now that the SO slice has landed. A
   transfer changes per-warehouse on-hand, so re-walk open SO lines (READY/
   PENDING flips). Imported from ../lib/so-stock-allocation (best-effort). */

// ── Header / line response mappers (Drizzle camelCase -> 2990s wire shape) ──
type WarehouseLite = { id: string; code: string; name: string } | null;
function toTransferHeaderResponse(
  t: typeof transfersTable.$inferSelect,
  fromW: WarehouseLite,
  toW: WarehouseLite,
) {
  return {
    id: t.id,
    transfer_no: t.transferNo,
    status: t.status,
    from_warehouse_id: t.fromWarehouseId,
    to_warehouse_id: t.toWarehouseId,
    transfer_date: t.transferDate,
    notes: t.notes,
    posted_at: isoOrNull(t.postedAt),
    cancelled_at: isoOrNull(t.cancelledAt),
    created_at: isoOrNull(t.createdAt),
    created_by: t.createdBy,
    from_warehouse: fromW,
    to_warehouse: toW,
  };
}

function toTransferLineResponse(l: typeof transferLinesTable.$inferSelect) {
  return {
    id: l.id,
    stock_transfer_id: l.stockTransferId,
    product_code: l.productCode,
    product_name: l.productName,
    variant_key: l.variantKey,
    qty: l.qty,
    notes: l.notes,
    created_at: isoOrNull(l.createdAt),
  };
}

const nextTransferNo = async (db: Db): Promise<string> => {
  const d = new Date();
  const yymm = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, "0")}`;
  const rows = await db
    .select({ id: transfersTable.id })
    .from(transfersTable)
    .where(like(transfersTable.transferNo, `ST-${yymm}-%`));
  return `ST-${yymm}-${String(rows.length + 1).padStart(3, "0")}`;
};

// ── List ──────────────────────────────────────────────────────────────
app.get("/", async (c) => {
  const db = getDb(c.env);
  const status = c.req.query("status");
  const fromWarehouseId = c.req.query("fromWarehouseId");
  const toWarehouseId = c.req.query("toWarehouseId");
  const dateFrom = c.req.query("dateFrom");
  const dateTo = c.req.query("dateTo");

  const conds = [];
  if (status && VALID_STATUS.has(status)) conds.push(eq(transfersTable.status, status));
  if (fromWarehouseId) conds.push(eq(transfersTable.fromWarehouseId, fromWarehouseId));
  if (toWarehouseId) conds.push(eq(transfersTable.toWarehouseId, toWarehouseId));
  if (dateFrom) conds.push(gte(transfersTable.transferDate, dateFrom));
  if (dateTo) conds.push(lte(transfersTable.transferDate, dateTo));

  try {
    const rows = await db
      .select()
      .from(transfersTable)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(transfersTable.transferDate), desc(transfersTable.createdAt));

    // Resolve warehouse codes/names for the from/to embeds (one cheap fetch).
    const whs = await db
      .select({ id: warehousesTable.id, code: warehousesTable.code, name: warehousesTable.name })
      .from(warehousesTable);
    const whMap = new Map(whs.map((w) => [w.id, w]));

    // line_count per row (cheap follow-up at pilot scale — matches 2990s).
    const ids = rows.map((r) => r.id);
    const countByXfer = new Map<string, number>();
    if (ids.length > 0) {
      const lineRows = await db
        .select({ stockTransferId: transferLinesTable.stockTransferId })
        .from(transferLinesTable)
        .where(inArray(transferLinesTable.stockTransferId, ids));
      for (const l of lineRows) {
        countByXfer.set(l.stockTransferId, (countByXfer.get(l.stockTransferId) ?? 0) + 1);
      }
    }

    const transfers = rows.map((r) => ({
      ...toTransferHeaderResponse(r, whMap.get(r.fromWarehouseId) ?? null, whMap.get(r.toWarehouseId) ?? null),
      line_count: countByXfer.get(r.id) ?? 0,
    }));
    return c.json({ transfers });
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
      db.select().from(transfersTable).where(eq(transfersTable.id, id)).limit(1),
      db
        .select()
        .from(transferLinesTable)
        .where(eq(transferLinesTable.stockTransferId, id))
        .orderBy(asc(transferLinesTable.createdAt)),
    ]);
    const header = headerRows[0];
    if (!header) return c.json({ error: "not_found" }, 404);

    const whIds = [...new Set([header.fromWarehouseId, header.toWarehouseId])];
    const whs = await db
      .select({ id: warehousesTable.id, code: warehousesTable.code, name: warehousesTable.name })
      .from(warehousesTable)
      .where(inArray(warehousesTable.id, whIds));
    const whMap = new Map(whs.map((w) => [w.id, w]));

    return c.json({
      transfer: toTransferHeaderResponse(
        header,
        whMap.get(header.fromWarehouseId) ?? null,
        whMap.get(header.toWarehouseId) ?? null,
      ),
      lines: lineRows.map(toTransferLineResponse),
    });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

/* ── Movement writer (shared by POST + legacy /post) ─────────────────
   For each line:
     1) Insert OUT @from (FIFO trigger fills total_cost_sen).
     2) Derive IN unit_cost_sen = OUT.total_cost_sen / OUT.qty (weighted avg).
     3) Insert IN @to with that cost. */
async function writeTransferMovements(
  db: Db,
  header: { id: string; transferNo: string; fromWarehouseId: string; toWarehouseId: string },
  userId: number,
): Promise<string[]> {
  const movementErrors: string[] = [];
  const lineList = await db
    .select({
      productCode: transferLinesTable.productCode,
      productName: transferLinesTable.productName,
      variantKey: transferLinesTable.variantKey,
      qty: transferLinesTable.qty,
    })
    .from(transferLinesTable)
    .where(eq(transferLinesTable.stockTransferId, header.id));

  /* Resolve the dye-lot batch each line moves so a batched lot keeps its batch_no
     across the warehouse hop. We read OPEN lots at the SOURCE warehouse and, per
     (product_code, variant_key) bucket, carry the batch ONLY when the source
     stock sits in a single non-null batch; multi-batch / plain stock -> un-batched
     (plain FIFO). The shared lib resolver does exactly 2990s's inline logic. */
  const batchByBucket = await resolveWarehouseLotBatches(db, header.fromWarehouseId);

  for (const ln of lineList) {
    if (ln.qty <= 0) continue;
    // Variant bucket the line moves; '' = unclassified/legacy. FIFO consumes the
    // OUT@from from THIS variant's oldest batch and re-opens it at IN@to.
    const variantKey = ln.variantKey ?? "";
    // Carry the resolved batch only when the source bucket sits in ONE batch
    // (unambiguous). null -> leave un-batched (multi-batch ambiguity or plain).
    const batchNo = batchByBucket.get(`${ln.productCode}::${variantKey}`) ?? null;

    let outId: string | undefined;
    try {
      const inserted = await db
        .insert(inventoryMovements)
        .values({
          movementType: "OUT",
          warehouseId: header.fromWarehouseId,
          productCode: ln.productCode,
          variantKey,
          productName: ln.productName,
          qty: ln.qty,
          sourceDocType: "STOCK_TRANSFER",
          sourceDocId: header.id,
          sourceDocNo: header.transferNo,
          // Stamp the source dye-lot on the OUT so the FIFO trigger consumes THAT
          // batch (not any FIFO lot). Only when resolved to a single batch.
          batchNo: batchNo ?? null,
          performedBy: userId,
          notes: `Transfer to warehouse ${header.toWarehouseId}`,
        } as never)
        .returning({ id: inventoryMovements.id, qty: inventoryMovements.qty });
      outId = inserted[0]?.id;
    } catch (e) {
      movementErrors.push(`OUT ${ln.productCode}: ${errMsg(e)}`);
      continue;
    }
    if (!outId) {
      movementErrors.push(`OUT ${ln.productCode}: no data`);
      continue;
    }

    /* Audit 2026-06-10 C-1 (CRITICAL) — the FIFO trigger is AFTER INSERT and
       stamps total_cost_sen via a separate UPDATE, which INSERT…RETURNING can
       NEVER see (RETURNING shows the row as inserted). Reading the cost off the
       insert response therefore always read 0, so every transfer opened the
       destination lot at 0 cost — inventory value silently destroyed on each
       warehouse move. RE-QUERY the row post-insert so the IN carries the OUT's
       real consumed cost. */
    const outCosted = await db
      .select({ qty: inventoryMovements.qty, totalCostSen: inventoryMovements.totalCostSen })
      .from(inventoryMovements)
      .where(eq(inventoryMovements.id, outId))
      .limit(1);
    const outQty = Number(outCosted[0]?.qty ?? ln.qty);
    const outTotal = Number(outCosted[0]?.totalCostSen ?? 0);
    const inUnitCost = outQty > 0 ? Math.round(outTotal / outQty) : 0;

    const inOk = await writeMovements(db, [
      {
        movement_type: "IN",
        warehouse_id: header.toWarehouseId,
        product_code: ln.productCode,
        variant_key: variantKey,
        product_name: ln.productName,
        qty: ln.qty,
        unit_cost_sen: inUnitCost,
        source_doc_type: "STOCK_TRANSFER",
        source_doc_id: header.id,
        source_doc_no: header.transferNo,
        // Mirror the OUT's batch onto the IN so the dye-lot survives the move
        // (destination opens a lot tagged with the same batch).
        ...(batchNo ? { batch_no: batchNo } : {}),
        performed_by: userId,
        notes: `Transfer from warehouse ${header.fromWarehouseId}`,
      },
    ]);
    if (!inOk.ok) movementErrors.push(`IN ${ln.productCode}: ${inOk.reason ?? "unknown"}`);
  }

  /* Stock Transfer = net-zero across warehouses, but re-walk SO stock allocation
     in case any row failed (partial transfer) and a bucket actually shifted. */
  try {
    await recomputeSoStockAllocation(db);
  } catch (e) {
    console.error("[so-allocation] post-transfer failed:", e);
  }
  return movementErrors;
}

// ── Create + auto-post ────────────────────────────────────────────────
// body: { fromWarehouseId, toWarehouseId, transferDate?, notes?,
//         items: [{ productCode, productName?, variantKey?, qty, notes? }] }
// PR-DRAFT-removal: row is inserted as POSTED and inventory_movements are
// written inline. No separate /post call needed.
app.post("/", async (c) => {
  const db = getDb(c.env);
  const user = c.get("user");
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  if (body.status === "DRAFT")
    return c.json({ error: "draft_status_not_supported", message: "DRAFT was removed in migration 0078." }, 400);

  const fromWarehouseId = body.fromWarehouseId as string | undefined;
  const toWarehouseId = body.toWarehouseId as string | undefined;
  if (!fromWarehouseId) return c.json({ error: "from_warehouse_required" }, 400);
  if (!toWarehouseId) return c.json({ error: "to_warehouse_required" }, 400);
  if (fromWarehouseId === toWarehouseId) return c.json({ error: "same_warehouse" }, 400);

  const items = (body.items as Array<Record<string, unknown>> | undefined) ?? [];
  if (items.length === 0) return c.json({ error: "items_required" }, 400);

  const transferNo = await nextTransferNo(db);

  let header: { id: string; transferNo: string; fromWarehouseId: string; toWarehouseId: string };
  try {
    const inserted = await db
      .insert(transfersTable)
      .values({
        transferNo,
        status: "POSTED",
        postedAt: new Date(),
        fromWarehouseId,
        toWarehouseId,
        ...(body.transferDate ? { transferDate: body.transferDate as string } : {}),
        notes: (body.notes as string | undefined) ?? null,
        createdBy: user.id,
      } as never)
      .returning({
        id: transfersTable.id,
        transferNo: transfersTable.transferNo,
        fromWarehouseId: transfersTable.fromWarehouseId,
        toWarehouseId: transfersTable.toWarehouseId,
      });
    header = inserted[0];
  } catch (e) {
    if (e && typeof e === "object" && (e as { code?: string }).code === "42501") {
      return c.json({ error: "forbidden", reason: errMsg(e) }, 403);
    }
    return c.json({ error: "insert_failed", reason: errMsg(e) }, 500);
  }

  let lineRows: Array<Record<string, unknown>>;
  try {
    lineRows = items.map((it) => {
      const qty = Math.max(0, Math.floor(Number(it.qty ?? 0)));
      if (qty <= 0) throw new Error("qty must be > 0");
      if (!it.productCode) throw new Error("productCode required per line");
      return {
        stockTransferId: header.id,
        productCode: String(it.productCode),
        productName: (it.productName as string | undefined) ?? null,
        // Variant bucket so the OUT@from / IN@to movements consume + re-open the
        // matching FIFO batch. Omit / '' = unclassified (legacy behaviour).
        variantKey: (it.variantKey as string | undefined) ?? "",
        qty,
        notes: (it.notes as string | undefined) ?? null,
      };
    });
  } catch (e) {
    await db.delete(transfersTable).where(eq(transfersTable.id, header.id));
    return c.json({ error: "invalid_line", reason: errMsg(e) }, 400);
  }
  try {
    await db.insert(transferLinesTable).values(lineRows as never);
  } catch (e) {
    await db.delete(transfersTable).where(eq(transfersTable.id, header.id));
    return c.json({ error: "lines_insert_failed", reason: errMsg(e) }, 500);
  }

  // Write inventory movements (paired OUT/IN) inline.
  const movementErrors = await writeTransferMovements(db, header, user.id);

  return c.json(
    {
      id: header.id,
      transferNo: header.transferNo,
      movementErrors: movementErrors.length ? movementErrors : undefined,
    },
    201,
  );
});

// ── Cancel POSTED ─────────────────────────────────────────────────────
// Cancel actually REVERSES the inter-warehouse movement: it posts an opposite-
// direction movement per original row (IN@to -> OUT@to, OUT@from -> IN@from) via
// reverseMovements, so stock flows back to the source warehouse and the FIFO
// cost basis is restored. Variant-aware (reverseMovements buckets by
// product_code + variant_key + warehouse). Idempotent two ways: the status flip
// is gated POSTED->CANCELLED (the ne guard returns no row on a second call ->
// 409), and reverseMovements itself skips buckets whose signed net is already 0.
app.patch("/:id/cancel", async (c) => {
  const db = getDb(c.env);
  const user = c.get("user");
  const id = c.req.param("id");

  // Gate on the ACTIVE(=POSTED)->CANCELLED transition. Only the call that
  // actually flips the status proceeds to reverse — never on an already
  // CANCELLED row.
  let data: { id: string; status: string; cancelledAt: Date | null } | undefined;
  try {
    const updated = await db
      .update(transfersTable)
      .set({ status: "CANCELLED", cancelledAt: new Date() })
      .where(and(eq(transfersTable.id, id), ne(transfersTable.status, "CANCELLED")))
      .returning({ id: transfersTable.id, status: transfersTable.status, cancelledAt: transfersTable.cancelledAt });
    data = updated[0];
  } catch (e) {
    return c.json({ error: "cancel_failed", reason: errMsg(e) }, 500);
  }
  if (!data) return c.json({ error: "already_cancelled" }, 409);

  // Reverse the paired OUT/IN movements this transfer wrote. Best-effort,
  // mirroring the post path: a failed reversal row is logged + reported, it
  // does NOT roll back the CANCELLED status (audit-DLQ posture).
  const rev = await reverseMovements(db, "STOCK_TRANSFER", id, user?.id ?? null);
  // Net-zero across warehouses again — re-walk SO stock allocation in case a
  // partial reversal actually shifted a bucket.
  try {
    await recomputeSoStockAllocation(db);
  } catch (e) {
    console.error("[so-allocation] post-cancel failed:", e);
  }

  return c.json({
    transfer: { id: data.id, status: data.status, cancelled_at: isoOrNull(data.cancelledAt) },
    reversal: { reversed: rev.reversed, skipped: rev.skipped, failed: rev.failed },
    reversalErrors: rev.failed > 0 ? (rev.reason ?? "partial reversal") : undefined,
  });
});

// ── Post -> idempotent no-op (legacy compat) ───────────────────────────
app.patch("/:id/post", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const rows = await db.select().from(transfersTable).where(eq(transfersTable.id, id)).limit(1);
  const row = rows[0];
  if (!row) return c.json({ error: "not_found" }, 404);
  if (row.status === "POSTED") {
    return c.json({ transfer: toTransferHeaderResponse(row, null, null) });
  }
  return c.json({ error: "cannot_post", message: `Cannot post a ${row.status} transfer.` }, 409);
});

export default app;
