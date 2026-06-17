import { Hono } from "hono";
import type { Env } from "../types";
import { getDb } from "../db/client";
import { scm_stocktakes, scm_stocktake_items, scm_stock_moves } from "../db/schema";
import { requirePermission } from "../middleware/auth";
import { and, asc, desc, eq, ilike, sql } from "drizzle-orm";
import { stocktakeCreateSchema, stocktakeUpdateSchema } from "@shared/movements";

/**
 * Supply Chain — Stocktakes (physical count reconciliation). A DRAFT -> POSTED
 * doc that reconciles DERIVED on-hand stock to a counted figure. At create time
 * each line snapshots system_qty (current on-hand from the scm_stock_moves
 * ledger). At post time, for each line where counted_qty != system_qty, ONE
 * signed STOCKTAKE_ADJ move of (counted_qty - system_qty) is written so the
 * ledger reconciles to the counted figure (positive = found extra, negative =
 * shrinkage). The adjustment carries the material's current FIFO avg cost.
 *
 *   GET    /api/scm-stocktakes            list + search/status/paginate
 *   GET    /api/scm-stocktakes/:id        header + items
 *   POST   /api/scm-stocktakes            create DRAFT (header + items[], snapshots system_qty)
 *   PATCH  /api/scm-stocktakes/:id        edit DRAFT (counted_qty / notes)
 *   POST   /api/scm-stocktakes/:id/post   DRAFT -> POSTED (STOCKTAKE_ADJ per diff)
 *   POST   /api/scm-stocktakes/:id/cancel DRAFT -> CANCELLED (no stock impact)
 *   DELETE /api/scm-stocktakes/:id        delete DRAFT (cascades items)
 *
 * Owner-only for now (requirePermission "*"), matching the Sidebar/Route guard.
 * Swap to a dedicated scm.* permission when the module is rolled out.
 */
const app = new Hono<{ Bindings: Env }>();
app.use("*", requirePermission("*"));

type Db = ReturnType<typeof getDb>;

// STK-YYYY-NNNN, per-year sequence. Unique constraint + 409 retry guards races.
async function genStocktakeNumber(db: Db): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `STK-${year}-`;
  const rows = await db
    .select({ n: scm_stocktakes.stocktake_number })
    .from(scm_stocktakes)
    .where(ilike(scm_stocktakes.stocktake_number, `${prefix}%`));
  let max = 0;
  for (const r of rows) {
    const m = /-(\d+)$/.exec(r.n);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${prefix}${String(max + 1).padStart(4, "0")}`;
}

// FIFO replay for a single material's moves (assumed ASC by created_at). Mirrors
// scm-inventory.ts; here qty_on_hand snapshots system_qty and avg_cost_centi
// costs the STOCKTAKE_ADJ move.
function fifoValue(moves: { qty: number; unit_cost_centi: number }[]): {
  qty_on_hand: number;
  value_centi: number;
  avg_cost_centi: number;
} {
  const layers: { qty: number; unit_cost_centi: number }[] = [];
  let qtyOnHand = 0;
  for (const m of moves) {
    const qty = m.qty || 0;
    qtyOnHand += qty;
    if (qty > 0) {
      layers.push({ qty, unit_cost_centi: m.unit_cost_centi || 0 });
    } else if (qty < 0) {
      let remaining = -qty;
      while (remaining > 0 && layers.length > 0) {
        const layer = layers[0];
        if (layer.qty <= remaining) {
          remaining -= layer.qty;
          layers.shift();
        } else {
          layer.qty -= remaining;
          remaining = 0;
        }
      }
    }
  }
  const value_centi = layers.reduce((s, l) => s + l.qty * l.unit_cost_centi, 0);
  const avg_cost_centi = qtyOnHand > 0 ? Math.round(value_centi / qtyOnHand) : 0;
  return { qty_on_hand: qtyOnHand, value_centi, avg_cost_centi };
}

// Current on-hand snapshot ({ qty, avg cost }) of one material at one warehouse,
// derived from the ledger (moves replayed oldest-first).
async function onHand(
  db: Db,
  warehouseCode: string,
  materialKind: string,
  materialCode: string,
): Promise<{ qty: number; avg_cost_centi: number }> {
  const moves = await db
    .select({ qty: scm_stock_moves.qty, unit_cost_centi: scm_stock_moves.unit_cost_centi })
    .from(scm_stock_moves)
    .where(
      and(
        eq(scm_stock_moves.warehouse_code, warehouseCode),
        eq(scm_stock_moves.material_kind, materialKind),
        eq(scm_stock_moves.material_code, materialCode),
      ),
    )
    .orderBy(asc(scm_stock_moves.created_at));
  const { qty_on_hand, avg_cost_centi } = fifoValue(moves);
  return { qty: qty_on_hand, avg_cost_centi };
}

// ── list ────────────────────────────────────────────────────────────────
app.get("/", async (c) => {
  const db = getDb(c.env);
  const search = c.req.query("search")?.trim();
  const status = c.req.query("status")?.trim();
  const warehouse = c.req.query("warehouse_code")?.trim();
  const page = Math.max(parseInt(c.req.query("page") || "1", 10), 1);
  const perPage = Math.min(Math.max(parseInt(c.req.query("per_page") || "50", 10), 1), 200);

  const conds = [];
  if (status) conds.push(eq(scm_stocktakes.status, status));
  if (warehouse) conds.push(eq(scm_stocktakes.warehouse_code, warehouse));
  if (search) conds.push(ilike(scm_stocktakes.stocktake_number, `%${search}%`));
  const where = conds.length ? and(...conds) : undefined;

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(scm_stocktakes)
    .where(where);

  const rows = await db
    .select({
      id: scm_stocktakes.id,
      stocktake_number: scm_stocktakes.stocktake_number,
      warehouse_code: scm_stocktakes.warehouse_code,
      status: scm_stocktakes.status,
      created_at: scm_stocktakes.created_at,
    })
    .from(scm_stocktakes)
    .where(where)
    .orderBy(desc(scm_stocktakes.created_at))
    .limit(perPage)
    .offset((page - 1) * perPage);

  return c.json({ data: rows, page, per_page: perPage, total: count });
});

// ── single ──────────────────────────────────────────────────────────────
app.get("/:id", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const [stocktake] = await db.select().from(scm_stocktakes).where(eq(scm_stocktakes.id, id));
  if (!stocktake) return c.json({ error: "Stocktake not found" }, 404);
  const items = await db
    .select()
    .from(scm_stocktake_items)
    .where(eq(scm_stocktake_items.stocktake_id, id))
    .orderBy(asc(scm_stocktake_items.created_at));
  return c.json({ stocktake, items });
});

// ── create (DRAFT) ────────────────────────────────────────────────────────
// system_qty is recomputed authoritatively from the ledger per line (any
// client-supplied system_qty is ignored) so the snapshot reflects real on-hand.
app.post("/", async (c) => {
  const db = getDb(c.env);
  const userId = c.get("userId");
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const parsed = stocktakeCreateSchema.safeParse(body);
  if (!parsed.success)
    return c.json({ error: parsed.error.issues[0]?.message || "Invalid stocktake" }, 400);
  const d = parsed.data;

  const itemRows = await Promise.all(
    d.items.map(async (it) => {
      const kind = it.material_kind ?? "mfg_product";
      const { qty } = await onHand(db, d.warehouse_code, kind, it.material_code);
      return {
        material_kind: kind,
        material_code: it.material_code,
        material_name: it.material_name ?? it.material_code,
        system_qty: qty,
        counted_qty: it.counted_qty,
        notes: it.notes ?? null,
      };
    }),
  );

  const stocktakeNumber = await genStocktakeNumber(db);

  try {
    const [stocktake] = await db
      .insert(scm_stocktakes)
      .values({
        stocktake_number: stocktakeNumber,
        warehouse_code: d.warehouse_code,
        status: "DRAFT",
        notes: d.notes ?? null,
        created_by: userId ?? null,
      } as any)
      .returning();
    await db
      .insert(scm_stocktake_items)
      .values(itemRows.map((r) => ({ ...r, stocktake_id: stocktake.id })) as any);
    return c.json({ stocktake }, 201);
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    if (/unique|duplicate/i.test(msg))
      return c.json({ error: "Stocktake number clash — please retry" }, 409);
    return c.json({ error: msg }, 500);
  }
});

// ── update header (+ optional item replace), DRAFT only ─────────────────────
// Editing lines re-snapshots system_qty (warehouse may have changed; on-hand may
// have moved) so the stored figure stays authoritative until post.
const HDR_FIELDS = ["warehouse_code", "notes"] as const;
app.patch("/:id", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const [stocktake] = await db.select().from(scm_stocktakes).where(eq(scm_stocktakes.id, id));
  if (!stocktake) return c.json({ error: "Stocktake not found" }, 404);
  if (stocktake.status !== "DRAFT")
    return c.json({ error: "Only draft stocktakes can be edited" }, 400);

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const parsed = stocktakeUpdateSchema.safeParse(body);
  if (!parsed.success)
    return c.json({ error: parsed.error.issues[0]?.message || "Invalid stocktake" }, 400);
  const d = parsed.data as Record<string, unknown>;

  const data: Record<string, unknown> = {};
  for (const f of HDR_FIELDS) if (d[f] !== undefined) data[f] = d[f];
  data.updated_at = new Date();
  await db
    .update(scm_stocktakes)
    .set(data as any)
    .where(eq(scm_stocktakes.id, id));

  const warehouseCode = (data.warehouse_code as string) ?? stocktake.warehouse_code;

  // Optional full item replace while DRAFT (omit `items` to leave lines as-is).
  if (Array.isArray(body.items)) {
    const replace = await Promise.all(
      (body.items as Record<string, unknown>[]).map(async (raw) => {
        const code = String(raw.material_code ?? "").trim();
        const kind = raw.material_kind ? String(raw.material_kind) : "mfg_product";
        const { qty } = await onHand(db, warehouseCode, kind, code);
        return {
          stocktake_id: id,
          material_kind: kind,
          material_code: code,
          material_name: raw.material_name ? String(raw.material_name) : code,
          system_qty: qty,
          counted_qty: Math.max(0, Math.trunc(Number(raw.counted_qty) || 0)),
          notes: raw.notes ? String(raw.notes) : null,
        };
      }),
    );
    await db.delete(scm_stocktake_items).where(eq(scm_stocktake_items.stocktake_id, id));
    if (replace.length) {
      await db.insert(scm_stocktake_items).values(replace as any);
    }
  }

  const [fresh] = await db.select().from(scm_stocktakes).where(eq(scm_stocktakes.id, id));
  return c.json({ stocktake: fresh });
});

// ── post (DRAFT -> POSTED): one STOCKTAKE_ADJ per (counted - system) diff ─────
// Atomicity: mirrors scm-goods-receipts.ts — NOT wrapped in db.transaction
// (awaits run sequentially), best-effort 500 on any failure. Each line with a
// non-zero diff writes ONE signed STOCKTAKE_ADJ move that reconciles on-hand to
// the counted figure, carrying the material's current FIFO avg cost (0 fallback).
app.post("/:id/post", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");

  const [stocktake] = await db.select().from(scm_stocktakes).where(eq(scm_stocktakes.id, id));
  if (!stocktake) return c.json({ error: "Stocktake not found" }, 404);
  if (stocktake.status !== "DRAFT")
    return c.json({ error: "Only draft stocktakes can be posted" }, 400);

  const items = await db
    .select()
    .from(scm_stocktake_items)
    .where(eq(scm_stocktake_items.stocktake_id, id))
    .orderBy(asc(scm_stocktake_items.created_at));

  try {
    // a. one signed STOCKTAKE_ADJ per line whose count differs from the system qty
    for (const it of items) {
      const diff = (it.counted_qty || 0) - (it.system_qty || 0);
      if (diff === 0) continue;
      const { avg_cost_centi } = await onHand(
        db,
        stocktake.warehouse_code,
        it.material_kind,
        it.material_code,
      );
      await db.insert(scm_stock_moves).values({
        warehouse_code: stocktake.warehouse_code,
        material_kind: it.material_kind,
        material_code: it.material_code,
        material_name: it.material_name,
        qty: diff, // SIGNED: + found extra, - shrinkage
        unit_cost_centi: avg_cost_centi,
        move_type: "STOCKTAKE_ADJ",
        ref_type: "stocktake",
        ref_id: stocktake.id,
        created_by: null,
      } as any);
    }

    // b. flip the stocktake to POSTED
    const [posted] = await db
      .update(scm_stocktakes)
      .set({ status: "POSTED", posted_at: new Date(), updated_at: new Date() })
      .where(eq(scm_stocktakes.id, id))
      .returning();

    return c.json({ stocktake: posted, items });
  } catch (e) {
    return c.json({ error: (e as Error)?.message || String(e) }, 500);
  }
});

// ── cancel (DRAFT -> CANCELLED, no stock impact) ────────────────────────────
app.post("/:id/cancel", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const [stocktake] = await db.select().from(scm_stocktakes).where(eq(scm_stocktakes.id, id));
  if (!stocktake) return c.json({ error: "Stocktake not found" }, 404);
  if (stocktake.status === "POSTED")
    return c.json({ error: "Posted stocktakes cannot be cancelled" }, 400);
  if (stocktake.status === "CANCELLED") return c.json({ stocktake });
  const [cancelled] = await db
    .update(scm_stocktakes)
    .set({ status: "CANCELLED", cancelled_at: new Date(), updated_at: new Date() })
    .where(eq(scm_stocktakes.id, id))
    .returning();
  return c.json({ stocktake: cancelled });
});

// ── delete (DRAFT only, cascades items) ─────────────────────────────────────
app.delete("/:id", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const [stocktake] = await db.select().from(scm_stocktakes).where(eq(scm_stocktakes.id, id));
  if (!stocktake) return c.json({ error: "Stocktake not found" }, 404);
  if (stocktake.status === "POSTED")
    return c.json({ error: "Posted stocktakes cannot be deleted" }, 400);
  await db.delete(scm_stocktakes).where(eq(scm_stocktakes.id, id));
  return c.json({ ok: true });
});

export default app;
