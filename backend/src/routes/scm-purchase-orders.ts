import { Hono } from "hono";
import type { Env } from "../types";
import { getDb } from "../db/client";
import {
  scm_purchase_orders,
  scm_purchase_order_items,
  scm_suppliers,
} from "../db/schema";
import { requirePermission } from "../middleware/auth";
import { and, asc, desc, eq, ilike, sql } from "drizzle-orm";

/**
 * Supply Chain — Purchase Orders (header + line items). Ported from the 2990s
 * ERP into the scm_ namespace (distinct from the AutoCount-synced /api/po).
 *
 *   GET    /api/scm-purchase-orders                list + search/status/paginate
 *   GET    /api/scm-purchase-orders/:id            header + supplier + items
 *   POST   /api/scm-purchase-orders                create (header + items[])
 *   PATCH  /api/scm-purchase-orders/:id            update header / status
 *   DELETE /api/scm-purchase-orders/:id            delete (cascades items)
 *   POST   /api/scm-purchase-orders/:id/items      add a line
 *   PATCH  /api/scm-purchase-orders/items/:itemId  edit a line
 *   DELETE /api/scm-purchase-orders/items/:itemId  remove a line
 *
 * Owner-only for now (requirePermission "*"), matching the Sidebar/Route
 * guard. Swap to a dedicated scm.* permission when the module is rolled out.
 */
const app = new Hono<{ Bindings: Env }>();
app.use("*", requirePermission("*"));

type Db = ReturnType<typeof getDb>;

function lineTotal(qty: number, unit: number, disc: number): number {
  return Math.max(0, (qty || 0) * (unit || 0) - (disc || 0));
}

// Recompute header subtotal/total from the live line items (tax left as-is).
async function recomputeTotals(db: Db, poId: string): Promise<void> {
  const items = await db
    .select({ lt: scm_purchase_order_items.line_total_centi })
    .from(scm_purchase_order_items)
    .where(eq(scm_purchase_order_items.purchase_order_id, poId));
  const subtotal = items.reduce((s, it) => s + (it.lt || 0), 0);
  const [hdr] = await db
    .select({ tax: scm_purchase_orders.tax_centi })
    .from(scm_purchase_orders)
    .where(eq(scm_purchase_orders.id, poId));
  const tax = hdr?.tax || 0;
  await db
    .update(scm_purchase_orders)
    .set({ subtotal_centi: subtotal, total_centi: subtotal + tax, updated_at: new Date() })
    .where(eq(scm_purchase_orders.id, poId));
}

// PO-YYYY-NNNN, per-year sequence. Unique constraint + 409 retry guards races.
async function genPoNumber(db: Db): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `PO-${year}-`;
  const rows = await db
    .select({ n: scm_purchase_orders.po_number })
    .from(scm_purchase_orders)
    .where(ilike(scm_purchase_orders.po_number, `${prefix}%`));
  let max = 0;
  for (const r of rows) {
    const m = /-(\d+)$/.exec(r.n);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${prefix}${String(max + 1).padStart(4, "0")}`;
}

const ITEM_FIELDS = [
  "binding_id", "material_kind", "material_code", "material_name", "supplier_sku",
  "qty", "unit_price_centi", "discount_centi", "uom", "variants", "notes", "delivery_date",
] as const;

function pickItem(b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of ITEM_FIELDS) if (b[f] !== undefined) out[f] = b[f];
  return out;
}

// ── list ────────────────────────────────────────────────────────────────
app.get("/", async (c) => {
  const db = getDb(c.env);
  const search = c.req.query("search")?.trim();
  const status = c.req.query("status")?.trim();
  const page = Math.max(parseInt(c.req.query("page") || "1", 10), 1);
  const perPage = Math.min(Math.max(parseInt(c.req.query("per_page") || "50", 10), 1), 200);

  const conds = [];
  if (status) conds.push(eq(scm_purchase_orders.status, status));
  if (search) conds.push(ilike(scm_purchase_orders.po_number, `%${search}%`));
  const where = conds.length ? and(...conds) : undefined;

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(scm_purchase_orders)
    .where(where);

  const rows = await db
    .select({
      id: scm_purchase_orders.id,
      po_number: scm_purchase_orders.po_number,
      supplier_id: scm_purchase_orders.supplier_id,
      supplier_name: scm_suppliers.name,
      status: scm_purchase_orders.status,
      po_date: scm_purchase_orders.po_date,
      expected_at: scm_purchase_orders.expected_at,
      currency: scm_purchase_orders.currency,
      total_centi: scm_purchase_orders.total_centi,
    })
    .from(scm_purchase_orders)
    .leftJoin(scm_suppliers, eq(scm_purchase_orders.supplier_id, scm_suppliers.id))
    .where(where)
    .orderBy(desc(scm_purchase_orders.po_date), desc(scm_purchase_orders.created_at))
    .limit(perPage)
    .offset((page - 1) * perPage);

  return c.json({ data: rows, page, per_page: perPage, total: count });
});

// ── single ──────────────────────────────────────────────────────────────
app.get("/:id", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const [po] = await db.select().from(scm_purchase_orders).where(eq(scm_purchase_orders.id, id));
  if (!po) return c.json({ error: "PO not found" }, 404);
  const [supplier] = await db.select().from(scm_suppliers).where(eq(scm_suppliers.id, po.supplier_id));
  const items = await db
    .select()
    .from(scm_purchase_order_items)
    .where(eq(scm_purchase_order_items.purchase_order_id, id))
    .orderBy(asc(scm_purchase_order_items.created_at));
  return c.json({ po, supplier, items });
});

// ── create ──────────────────────────────────────────────────────────────
app.post("/", async (c) => {
  const db = getDb(c.env);
  const userId = c.get("userId");
  const body = (await c.req.json().catch(() => ({}))) as Record<string, any>;
  if (!body.supplier_id) return c.json({ error: "supplier_id is required" }, 400);
  const [supplier] = await db.select().from(scm_suppliers).where(eq(scm_suppliers.id, body.supplier_id));
  if (!supplier) return c.json({ error: "Supplier not found" }, 404);

  const items = Array.isArray(body.items) ? body.items : [];
  let subtotal = 0;
  const itemRows = items.map((it: Record<string, unknown>) => {
    const picked = pickItem(it);
    if (!picked.material_kind) picked.material_kind = "mfg_product";
    if (!picked.material_name) picked.material_name = picked.material_code;
    const lt = lineTotal(Number(picked.qty), Number(picked.unit_price_centi), Number(picked.discount_centi));
    subtotal += lt;
    return { ...picked, line_total_centi: lt };
  });
  const tax = Number(body.tax_centi) || 0;
  const poNumber = await genPoNumber(db);

  try {
    const [po] = await db
      .insert(scm_purchase_orders)
      .values({
        po_number: poNumber,
        supplier_id: body.supplier_id,
        status: body.status || "SUBMITTED",
        po_date: body.po_date || undefined,
        expected_at: body.expected_at || null,
        currency: body.currency || supplier.currency || "MYR",
        subtotal_centi: subtotal,
        tax_centi: tax,
        total_centi: subtotal + tax,
        notes: body.notes || null,
        submitted_at: new Date(),
        created_by: userId ?? null,
      } as any)
      .returning();
    if (itemRows.length) {
      await db
        .insert(scm_purchase_order_items)
        .values(itemRows.map((r) => ({ ...r, purchase_order_id: po.id })) as any);
    }
    return c.json({ po }, 201);
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    if (/unique|duplicate/i.test(msg)) return c.json({ error: "PO number clash — please retry" }, 409);
    return c.json({ error: msg }, 500);
  }
});

// ── update header / status ────────────────────────────────────────────────
const HDR_FIELDS = ["status", "expected_at", "currency", "notes", "po_date", "tax_centi"] as const;
app.patch("/:id", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as Record<string, any>;
  const data: Record<string, unknown> = {};
  for (const f of HDR_FIELDS) if (body[f] !== undefined) data[f] = body[f];
  data.updated_at = new Date();
  if (body.status === "CANCELLED") data.cancelled_at = new Date();
  if (body.status === "RECEIVED") data.received_at = new Date();
  const [po] = await db
    .update(scm_purchase_orders)
    .set(data as any)
    .where(eq(scm_purchase_orders.id, id))
    .returning();
  if (!po) return c.json({ error: "PO not found" }, 404);
  if (body.tax_centi !== undefined) await recomputeTotals(db, id);
  const [fresh] = await db.select().from(scm_purchase_orders).where(eq(scm_purchase_orders.id, id));
  return c.json({ po: fresh });
});

// ── delete ──────────────────────────────────────────────────────────────
app.delete("/:id", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const [po] = await db.delete(scm_purchase_orders).where(eq(scm_purchase_orders.id, id)).returning();
  if (!po) return c.json({ error: "PO not found" }, 404);
  return c.json({ ok: true });
});

// ── line items ────────────────────────────────────────────────────────────
app.post("/:id/items", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const picked = pickItem(body);
  if (!picked.material_code || !String(picked.material_code).trim())
    return c.json({ error: "material_code is required" }, 400);
  if (!picked.material_kind) picked.material_kind = "mfg_product";
  if (!picked.material_name) picked.material_name = picked.material_code;
  picked.line_total_centi = lineTotal(
    Number(picked.qty),
    Number(picked.unit_price_centi),
    Number(picked.discount_centi),
  );
  picked.purchase_order_id = id;
  const [item] = await db.insert(scm_purchase_order_items).values(picked as any).returning();
  await recomputeTotals(db, id);
  return c.json({ item }, 201);
});

app.patch("/items/:itemId", async (c) => {
  const db = getDb(c.env);
  const itemId = c.req.param("itemId");
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const picked = pickItem(body);
  const [existing] = await db
    .select()
    .from(scm_purchase_order_items)
    .where(eq(scm_purchase_order_items.id, itemId));
  if (!existing) return c.json({ error: "Item not found" }, 404);
  const qty = picked.qty !== undefined ? Number(picked.qty) : existing.qty;
  const unit = picked.unit_price_centi !== undefined ? Number(picked.unit_price_centi) : existing.unit_price_centi;
  const disc = picked.discount_centi !== undefined ? Number(picked.discount_centi) : existing.discount_centi;
  picked.line_total_centi = lineTotal(qty, unit, disc);
  const [item] = await db
    .update(scm_purchase_order_items)
    .set(picked as any)
    .where(eq(scm_purchase_order_items.id, itemId))
    .returning();
  await recomputeTotals(db, existing.purchase_order_id);
  return c.json({ item });
});

app.delete("/items/:itemId", async (c) => {
  const db = getDb(c.env);
  const itemId = c.req.param("itemId");
  const [existing] = await db
    .delete(scm_purchase_order_items)
    .where(eq(scm_purchase_order_items.id, itemId))
    .returning();
  if (!existing) return c.json({ error: "Item not found" }, 404);
  await recomputeTotals(db, existing.purchase_order_id);
  return c.json({ ok: true });
});

export default app;
