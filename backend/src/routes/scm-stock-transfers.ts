import { Hono } from "hono";
import type { Env } from "../types";
import { getDb } from "../db/client";
import {
  scm_stock_transfers,
  scm_stock_transfer_items,
  scm_stock_moves,
} from "../db/schema";
import { requirePermission } from "../middleware/auth";
import { and, asc, desc, eq, ilike, sql } from "drizzle-orm";
import { stockTransferCreateSchema, stockTransferUpdateSchema } from "@shared/movements";

/**
 * Supply Chain — Stock Transfers (warehouse-to-warehouse). A DRAFT -> POSTED doc
 * that RELOCATES on-hand stock between two warehouses without changing total
 * value. Posting writes a matched pair per line into the scm_stock_moves ledger:
 * a NEGATIVE-qty TRANSFER_OUT at the source warehouse and a POSITIVE-qty
 * TRANSFER_IN at the destination, BOTH at the source warehouse's current FIFO
 * average cost (so value leaving == value arriving). The from/to warehouses must
 * differ (enforced in the shared Zod schema).
 *
 *   GET    /api/scm-stock-transfers            list + search/status/paginate
 *   GET    /api/scm-stock-transfers/:id        header + items
 *   POST   /api/scm-stock-transfers            create DRAFT (header + items[])
 *   PATCH  /api/scm-stock-transfers/:id        edit DRAFT (header + optional items)
 *   POST   /api/scm-stock-transfers/:id/post   DRAFT -> POSTED (TRANSFER_OUT + TRANSFER_IN)
 *   POST   /api/scm-stock-transfers/:id/cancel DRAFT -> CANCELLED (no stock impact)
 *   DELETE /api/scm-stock-transfers/:id        delete DRAFT (cascades items)
 *
 * Owner-only for now (requirePermission "*"), matching the Sidebar/Route guard.
 * Swap to a dedicated scm.* permission when the module is rolled out.
 */
const app = new Hono<{ Bindings: Env }>();
app.use("*", requirePermission("*"));

type Db = ReturnType<typeof getDb>;

// TRF-YYYY-NNNN, per-year sequence. Unique constraint + 409 retry guards races.
async function genTransferNumber(db: Db): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `TRF-${year}-`;
  const rows = await db
    .select({ n: scm_stock_transfers.transfer_number })
    .from(scm_stock_transfers)
    .where(ilike(scm_stock_transfers.transfer_number, `${prefix}%`));
  let max = 0;
  for (const r of rows) {
    const m = /-(\d+)$/.exec(r.n);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${prefix}${String(max + 1).padStart(4, "0")}`;
}

// FIFO replay for a single material's moves (assumed ASC by created_at). Mirrors
// scm-inventory.ts; here it is used only for avg_cost_centi — the source
// warehouse's current average cost, which both legs of the transfer carry.
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

// Current FIFO average cost of one material at one warehouse, derived from the
// ledger (moves replayed oldest-first). 0 when there is no on-hand stock.
async function sourceAvgCost(
  db: Db,
  warehouseCode: string,
  materialKind: string,
  materialCode: string,
): Promise<number> {
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
  return fifoValue(moves).avg_cost_centi;
}

// ── list ────────────────────────────────────────────────────────────────
app.get("/", async (c) => {
  const db = getDb(c.env);
  const search = c.req.query("search")?.trim();
  const status = c.req.query("status")?.trim();
  const page = Math.max(parseInt(c.req.query("page") || "1", 10), 1);
  const perPage = Math.min(Math.max(parseInt(c.req.query("per_page") || "50", 10), 1), 200);

  const conds = [];
  if (status) conds.push(eq(scm_stock_transfers.status, status));
  if (search) conds.push(ilike(scm_stock_transfers.transfer_number, `%${search}%`));
  const where = conds.length ? and(...conds) : undefined;

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(scm_stock_transfers)
    .where(where);

  const rows = await db
    .select({
      id: scm_stock_transfers.id,
      transfer_number: scm_stock_transfers.transfer_number,
      from_warehouse_code: scm_stock_transfers.from_warehouse_code,
      to_warehouse_code: scm_stock_transfers.to_warehouse_code,
      status: scm_stock_transfers.status,
      created_at: scm_stock_transfers.created_at,
    })
    .from(scm_stock_transfers)
    .where(where)
    .orderBy(desc(scm_stock_transfers.created_at))
    .limit(perPage)
    .offset((page - 1) * perPage);

  return c.json({ data: rows, page, per_page: perPage, total: count });
});

// ── single ──────────────────────────────────────────────────────────────
app.get("/:id", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const [transfer] = await db
    .select()
    .from(scm_stock_transfers)
    .where(eq(scm_stock_transfers.id, id));
  if (!transfer) return c.json({ error: "Transfer not found" }, 404);
  const items = await db
    .select()
    .from(scm_stock_transfer_items)
    .where(eq(scm_stock_transfer_items.transfer_id, id))
    .orderBy(asc(scm_stock_transfer_items.created_at));
  return c.json({ transfer, items });
});

// ── create (DRAFT) ────────────────────────────────────────────────────────
app.post("/", async (c) => {
  const db = getDb(c.env);
  const userId = c.get("userId");
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const parsed = stockTransferCreateSchema.safeParse(body);
  if (!parsed.success)
    return c.json({ error: parsed.error.issues[0]?.message || "Invalid transfer" }, 400);
  const d = parsed.data;

  const itemRows = d.items.map((it) => ({
    material_kind: it.material_kind ?? "mfg_product",
    material_code: it.material_code,
    material_name: it.material_name ?? it.material_code,
    qty: it.qty,
    notes: it.notes ?? null,
  }));

  const transferNumber = await genTransferNumber(db);

  try {
    const [transfer] = await db
      .insert(scm_stock_transfers)
      .values({
        transfer_number: transferNumber,
        from_warehouse_code: d.from_warehouse_code,
        to_warehouse_code: d.to_warehouse_code,
        status: "DRAFT",
        notes: d.notes ?? null,
        created_by: userId ?? null,
      } as any)
      .returning();
    await db
      .insert(scm_stock_transfer_items)
      .values(itemRows.map((r) => ({ ...r, transfer_id: transfer.id })) as any);
    return c.json({ transfer }, 201);
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    if (/unique|duplicate/i.test(msg))
      return c.json({ error: "Transfer number clash — please retry" }, 409);
    return c.json({ error: msg }, 500);
  }
});

// ── update header (+ optional item replace), DRAFT only ─────────────────────
const HDR_FIELDS = ["from_warehouse_code", "to_warehouse_code", "notes"] as const;
app.patch("/:id", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const [transfer] = await db
    .select()
    .from(scm_stock_transfers)
    .where(eq(scm_stock_transfers.id, id));
  if (!transfer) return c.json({ error: "Transfer not found" }, 404);
  if (transfer.status !== "DRAFT")
    return c.json({ error: "Only draft transfers can be edited" }, 400);

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const parsed = stockTransferUpdateSchema.safeParse(body);
  if (!parsed.success)
    return c.json({ error: parsed.error.issues[0]?.message || "Invalid transfer" }, 400);
  const d = parsed.data as Record<string, unknown>;

  const data: Record<string, unknown> = {};
  for (const f of HDR_FIELDS) if (d[f] !== undefined) data[f] = d[f];
  // Guard the from != to invariant against partial header edits.
  const nextFrom = (data.from_warehouse_code as string) ?? transfer.from_warehouse_code;
  const nextTo = (data.to_warehouse_code as string) ?? transfer.to_warehouse_code;
  if (nextFrom === nextTo)
    return c.json({ error: "from and to warehouse must differ" }, 400);
  data.updated_at = new Date();
  await db
    .update(scm_stock_transfers)
    .set(data as any)
    .where(eq(scm_stock_transfers.id, id));

  // Optional full item replace while DRAFT (omit `items` to leave lines as-is).
  if (Array.isArray(body.items)) {
    const replace = (body.items as Record<string, unknown>[]).map((raw) => {
      const code = String(raw.material_code ?? "").trim();
      return {
        transfer_id: id,
        material_kind: raw.material_kind ? String(raw.material_kind) : "mfg_product",
        material_code: code,
        material_name: raw.material_name ? String(raw.material_name) : code,
        qty: Math.max(0, Math.trunc(Number(raw.qty) || 0)),
        notes: raw.notes ? String(raw.notes) : null,
      };
    });
    await db
      .delete(scm_stock_transfer_items)
      .where(eq(scm_stock_transfer_items.transfer_id, id));
    if (replace.length) {
      await db.insert(scm_stock_transfer_items).values(replace as any);
    }
  }

  const [fresh] = await db
    .select()
    .from(scm_stock_transfers)
    .where(eq(scm_stock_transfers.id, id));
  return c.json({ transfer: fresh });
});

// ── post (DRAFT -> POSTED): TRANSFER_OUT (-qty) + TRANSFER_IN (+qty) ──────────
// Atomicity: mirrors scm-goods-receipts.ts — NOT wrapped in db.transaction
// (awaits run sequentially), best-effort 500 on any failure. Each line writes
// TWO moves at the source warehouse's current FIFO avg cost so total value is
// preserved, just relocated from `from` to `to`.
app.post("/:id/post", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");

  const [transfer] = await db
    .select()
    .from(scm_stock_transfers)
    .where(eq(scm_stock_transfers.id, id));
  if (!transfer) return c.json({ error: "Transfer not found" }, 404);
  if (transfer.status !== "DRAFT")
    return c.json({ error: "Only draft transfers can be posted" }, 400);

  const items = await db
    .select()
    .from(scm_stock_transfer_items)
    .where(eq(scm_stock_transfer_items.transfer_id, id))
    .orderBy(asc(scm_stock_transfer_items.created_at));

  try {
    // a/b. one matched OUT/IN pair per line, both at the source's current avg cost
    for (const it of items) {
      if ((it.qty || 0) <= 0) continue;
      const avgCost = await sourceAvgCost(
        db,
        transfer.from_warehouse_code,
        it.material_kind,
        it.material_code,
      );
      // (i) NEGATIVE outbound at the source warehouse
      await db.insert(scm_stock_moves).values({
        warehouse_code: transfer.from_warehouse_code,
        material_kind: it.material_kind,
        material_code: it.material_code,
        material_name: it.material_name,
        qty: -(it.qty || 0),
        unit_cost_centi: avgCost,
        move_type: "TRANSFER_OUT",
        ref_type: "transfer",
        ref_id: transfer.id,
        created_by: null,
      } as any);
      // (ii) POSITIVE inbound at the destination warehouse
      await db.insert(scm_stock_moves).values({
        warehouse_code: transfer.to_warehouse_code,
        material_kind: it.material_kind,
        material_code: it.material_code,
        material_name: it.material_name,
        qty: it.qty || 0,
        unit_cost_centi: avgCost,
        move_type: "TRANSFER_IN",
        ref_type: "transfer",
        ref_id: transfer.id,
        created_by: null,
      } as any);
    }

    // c. flip the transfer to POSTED
    const [posted] = await db
      .update(scm_stock_transfers)
      .set({ status: "POSTED", posted_at: new Date(), updated_at: new Date() })
      .where(eq(scm_stock_transfers.id, id))
      .returning();

    return c.json({ transfer: posted, items });
  } catch (e) {
    return c.json({ error: (e as Error)?.message || String(e) }, 500);
  }
});

// ── cancel (DRAFT -> CANCELLED, no stock impact) ────────────────────────────
app.post("/:id/cancel", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const [transfer] = await db
    .select()
    .from(scm_stock_transfers)
    .where(eq(scm_stock_transfers.id, id));
  if (!transfer) return c.json({ error: "Transfer not found" }, 404);
  if (transfer.status === "POSTED")
    return c.json({ error: "Posted transfers cannot be cancelled" }, 400);
  if (transfer.status === "CANCELLED") return c.json({ transfer });
  const [cancelled] = await db
    .update(scm_stock_transfers)
    .set({ status: "CANCELLED", cancelled_at: new Date(), updated_at: new Date() })
    .where(eq(scm_stock_transfers.id, id))
    .returning();
  return c.json({ transfer: cancelled });
});

// ── delete (DRAFT only, cascades items) ─────────────────────────────────────
app.delete("/:id", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const [transfer] = await db
    .select()
    .from(scm_stock_transfers)
    .where(eq(scm_stock_transfers.id, id));
  if (!transfer) return c.json({ error: "Transfer not found" }, 404);
  if (transfer.status === "POSTED")
    return c.json({ error: "Posted transfers cannot be deleted" }, 400);
  await db.delete(scm_stock_transfers).where(eq(scm_stock_transfers.id, id));
  return c.json({ ok: true });
});

export default app;
