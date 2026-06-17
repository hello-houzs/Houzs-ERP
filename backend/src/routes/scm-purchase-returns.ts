import { Hono } from "hono";
import type { Env } from "../types";
import { getDb } from "../db/client";
import {
  scm_purchase_returns,
  scm_purchase_return_items,
  scm_purchase_orders,
  scm_stock_moves,
  scm_suppliers,
} from "../db/schema";
import { requirePermission } from "../middleware/auth";
import { and, asc, desc, eq, ilike, sql } from "drizzle-orm";
import { purchaseReturnCreateSchema, purchaseReturnUpdateSchema } from "@shared/billing";

/**
 * Supply Chain — Purchase Returns (return-to-supplier). MIRRORS the GRN doc but
 * OUTBOUND: posting a return is the purchasing path that writes NEGATIVE-qty
 * PURCHASE_RETURN_OUT rows into the scm_stock_moves ledger (on-hand + FIFO are
 * derived from those moves).
 *
 *   GET    /api/scm-purchase-returns            list + search/status/paginate
 *   GET    /api/scm-purchase-returns/:id        header + supplier + PO + items
 *   POST   /api/scm-purchase-returns            create DRAFT (header + items[])
 *   PATCH  /api/scm-purchase-returns/:id        edit DRAFT (header + optional items)
 *   POST   /api/scm-purchase-returns/:id/post   DRAFT -> POSTED (stock out, NEGATIVE qty)
 *   POST   /api/scm-purchase-returns/:id/cancel DRAFT -> CANCELLED (no stock impact)
 *   DELETE /api/scm-purchase-returns/:id        delete DRAFT (cascades items)
 *
 * Owner-only for now (requirePermission "*"), matching the Sidebar/Route guard.
 * Swap to a dedicated scm.* permission when the module is rolled out.
 */
const app = new Hono<{ Bindings: Env }>();
app.use("*", requirePermission("*"));

type Db = ReturnType<typeof getDb>;

// RTN-YYYY-NNNN, per-year sequence. Unique constraint + 409 retry guards races.
async function genReturnNumber(db: Db): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `RTN-${year}-`;
  const rows = await db
    .select({ n: scm_purchase_returns.return_number })
    .from(scm_purchase_returns)
    .where(ilike(scm_purchase_returns.return_number, `${prefix}%`));
  let max = 0;
  for (const r of rows) {
    const m = /-(\d+)$/.exec(r.n);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${prefix}${String(max + 1).padStart(4, "0")}`;
}

// ── list ────────────────────────────────────────────────────────────────
app.get("/", async (c) => {
  const db = getDb(c.env);
  const search = c.req.query("search")?.trim();
  const status = c.req.query("status")?.trim();
  const page = Math.max(parseInt(c.req.query("page") || "1", 10), 1);
  const perPage = Math.min(Math.max(parseInt(c.req.query("per_page") || "50", 10), 1), 200);

  const conds = [];
  if (status) conds.push(eq(scm_purchase_returns.status, status));
  if (search) conds.push(ilike(scm_purchase_returns.return_number, `%${search}%`));
  const where = conds.length ? and(...conds) : undefined;

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(scm_purchase_returns)
    .where(where);

  const rows = await db
    .select({
      id: scm_purchase_returns.id,
      return_number: scm_purchase_returns.return_number,
      supplier_id: scm_purchase_returns.supplier_id,
      supplier_name: scm_suppliers.name,
      purchase_order_id: scm_purchase_returns.purchase_order_id,
      po_number: scm_purchase_orders.po_number,
      warehouse_code: scm_purchase_returns.warehouse_code,
      status: scm_purchase_returns.status,
      created_at: scm_purchase_returns.created_at,
    })
    .from(scm_purchase_returns)
    .leftJoin(scm_suppliers, eq(scm_purchase_returns.supplier_id, scm_suppliers.id))
    .leftJoin(
      scm_purchase_orders,
      eq(scm_purchase_returns.purchase_order_id, scm_purchase_orders.id),
    )
    .where(where)
    .orderBy(desc(scm_purchase_returns.created_at))
    .limit(perPage)
    .offset((page - 1) * perPage);

  return c.json({ data: rows, page, per_page: perPage, total: count });
});

// ── single ──────────────────────────────────────────────────────────────
app.get("/:id", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const [ret] = await db
    .select()
    .from(scm_purchase_returns)
    .where(eq(scm_purchase_returns.id, id));
  if (!ret) return c.json({ error: "Return not found" }, 404);
  const [supplier] = await db
    .select()
    .from(scm_suppliers)
    .where(eq(scm_suppliers.id, ret.supplier_id));
  let purchase_order = null;
  if (ret.purchase_order_id) {
    const [po] = await db
      .select()
      .from(scm_purchase_orders)
      .where(eq(scm_purchase_orders.id, ret.purchase_order_id));
    purchase_order = po ?? null;
  }
  const items = await db
    .select()
    .from(scm_purchase_return_items)
    .where(eq(scm_purchase_return_items.return_id, id))
    .orderBy(asc(scm_purchase_return_items.created_at));
  return c.json({ ret, supplier: supplier ?? null, purchase_order, items });
});

// ── create (DRAFT) ────────────────────────────────────────────────────────
app.post("/", async (c) => {
  const db = getDb(c.env);
  const userId = c.get("userId");
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const parsed = purchaseReturnCreateSchema.safeParse(body);
  if (!parsed.success)
    return c.json({ error: parsed.error.issues[0]?.message || "Invalid return" }, 400);
  const d = parsed.data;

  const [supplier] = await db
    .select()
    .from(scm_suppliers)
    .where(eq(scm_suppliers.id, d.supplier_id));
  if (!supplier) return c.json({ error: "Supplier not found" }, 404);

  const itemRows = d.items.map((it) => ({
    material_kind: it.material_kind ?? "mfg_product",
    material_code: it.material_code,
    material_name: it.material_name ?? it.material_code,
    qty_returned: it.qty_returned,
    unit_cost_centi: it.unit_cost_centi ?? 0,
    notes: it.notes ?? null,
  }));

  const returnNumber = await genReturnNumber(db);

  try {
    const [ret] = await db
      .insert(scm_purchase_returns)
      .values({
        return_number: returnNumber,
        supplier_id: d.supplier_id,
        warehouse_code: d.warehouse_code,
        purchase_order_id: d.purchase_order_id ?? null,
        status: "DRAFT",
        reason: d.reason ?? null,
        notes: d.notes ?? null,
        created_by: userId ?? null,
      } as any)
      .returning();
    await db
      .insert(scm_purchase_return_items)
      .values(itemRows.map((r) => ({ ...r, return_id: ret.id })) as any);
    return c.json({ ret }, 201);
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    if (/unique|duplicate/i.test(msg))
      return c.json({ error: "Return number clash — please retry" }, 409);
    return c.json({ error: msg }, 500);
  }
});

// ── update header (+ optional item replace), DRAFT only ─────────────────────
const HDR_FIELDS = ["warehouse_code", "reason", "notes"] as const;
app.patch("/:id", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const [ret] = await db
    .select()
    .from(scm_purchase_returns)
    .where(eq(scm_purchase_returns.id, id));
  if (!ret) return c.json({ error: "Return not found" }, 404);
  if (ret.status !== "DRAFT") return c.json({ error: "Only draft returns can be edited" }, 400);

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const parsed = purchaseReturnUpdateSchema.safeParse(body);
  if (!parsed.success)
    return c.json({ error: parsed.error.issues[0]?.message || "Invalid return" }, 400);
  const d = parsed.data as Record<string, unknown>;

  const data: Record<string, unknown> = {};
  for (const f of HDR_FIELDS) if (d[f] !== undefined) data[f] = d[f];
  data.updated_at = new Date();
  await db
    .update(scm_purchase_returns)
    .set(data as any)
    .where(eq(scm_purchase_returns.id, id));

  // Optional full item replace while DRAFT (omit `items` to leave lines as-is).
  if (Array.isArray(body.items)) {
    const replace = (body.items as Record<string, unknown>[]).map((raw) => {
      const code = String(raw.material_code ?? "").trim();
      return {
        return_id: id,
        material_kind: raw.material_kind ? String(raw.material_kind) : "mfg_product",
        material_code: code,
        material_name: raw.material_name ? String(raw.material_name) : code,
        qty_returned: Math.max(0, Math.trunc(Number(raw.qty_returned) || 0)),
        unit_cost_centi: Math.max(0, Math.trunc(Number(raw.unit_cost_centi) || 0)),
        notes: raw.notes ? String(raw.notes) : null,
      };
    });
    await db
      .delete(scm_purchase_return_items)
      .where(eq(scm_purchase_return_items.return_id, id));
    if (replace.length) {
      await db.insert(scm_purchase_return_items).values(replace as any);
    }
  }

  const [fresh] = await db
    .select()
    .from(scm_purchase_returns)
    .where(eq(scm_purchase_returns.id, id));
  return c.json({ ret: fresh });
});

// ── post (DRAFT -> POSTED): stock OUT (NEGATIVE qty PURCHASE_RETURN_OUT) ──────
// Atomicity: mirrors scm-goods-receipts.ts — NOT wrapped in db.transaction
// (awaits run sequentially), best-effort 500 on any failure. The ONLY difference
// from a GRN post is the sign of qty (negative) and the move_type.
app.post("/:id/post", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");

  const [ret] = await db
    .select()
    .from(scm_purchase_returns)
    .where(eq(scm_purchase_returns.id, id));
  if (!ret) return c.json({ error: "Return not found" }, 404);
  if (ret.status !== "DRAFT") return c.json({ error: "Only draft returns can be posted" }, 400);

  const items = await db
    .select()
    .from(scm_purchase_return_items)
    .where(eq(scm_purchase_return_items.return_id, id))
    .orderBy(asc(scm_purchase_return_items.created_at));

  try {
    // a. one NEGATIVE-qty PURCHASE_RETURN_OUT ledger move per returned line
    for (const it of items) {
      if ((it.qty_returned || 0) <= 0) continue;
      await db.insert(scm_stock_moves).values({
        warehouse_code: ret.warehouse_code,
        material_kind: it.material_kind,
        material_code: it.material_code,
        material_name: it.material_name,
        qty: -(it.qty_returned || 0), // NEGATIVE: outbound
        unit_cost_centi: it.unit_cost_centi,
        move_type: "PURCHASE_RETURN_OUT",
        ref_type: "return",
        ref_id: ret.id,
        created_by: null,
      } as any);
    }

    // b. flip the return to POSTED
    const [posted] = await db
      .update(scm_purchase_returns)
      .set({ status: "POSTED", posted_at: new Date(), updated_at: new Date() })
      .where(eq(scm_purchase_returns.id, id))
      .returning();

    return c.json({ ret: posted, items });
  } catch (e) {
    return c.json({ error: (e as Error)?.message || String(e) }, 500);
  }
});

// ── cancel (DRAFT -> CANCELLED, no stock impact) ────────────────────────────
app.post("/:id/cancel", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const [ret] = await db
    .select()
    .from(scm_purchase_returns)
    .where(eq(scm_purchase_returns.id, id));
  if (!ret) return c.json({ error: "Return not found" }, 404);
  if (ret.status === "POSTED") return c.json({ error: "Posted returns cannot be cancelled" }, 400);
  if (ret.status === "CANCELLED") return c.json({ ret });
  const [cancelled] = await db
    .update(scm_purchase_returns)
    .set({ status: "CANCELLED", cancelled_at: new Date(), updated_at: new Date() })
    .where(eq(scm_purchase_returns.id, id))
    .returning();
  return c.json({ ret: cancelled });
});

// ── delete (DRAFT only, cascades items) ─────────────────────────────────────
app.delete("/:id", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const [ret] = await db
    .select()
    .from(scm_purchase_returns)
    .where(eq(scm_purchase_returns.id, id));
  if (!ret) return c.json({ error: "Return not found" }, 404);
  if (ret.status === "POSTED") return c.json({ error: "Posted returns cannot be deleted" }, 400);
  await db.delete(scm_purchase_returns).where(eq(scm_purchase_returns.id, id));
  return c.json({ ok: true });
});

export default app;
