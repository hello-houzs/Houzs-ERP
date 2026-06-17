import { Hono } from "hono";
import type { Env } from "../types";
import { getDb } from "../db/client";
import {
  scm_goods_receipt_notes,
  scm_goods_receipt_note_items,
  scm_purchase_orders,
  scm_purchase_order_items,
  scm_stock_moves,
  scm_suppliers,
} from "../db/schema";
import { requirePermission } from "../middleware/auth";
import { and, asc, desc, eq, ilike, sql } from "drizzle-orm";
import { grnCreateSchema, grnUpdateSchema } from "@shared/grn";

/**
 * Supply Chain — Goods Receipts (GRN). Records the physical arrival of PO lines
 * into a warehouse. Posting is the ONLY purchasing path that advances
 * scm_purchase_order_items.received_qty and writes GRN_IN rows into the
 * scm_stock_moves ledger (on-hand + FIFO are derived from those moves).
 *
 *   GET    /api/scm-goods-receipts            list + search/status/paginate
 *   GET    /api/scm-goods-receipts/:id        header + supplier + PO + items
 *   POST   /api/scm-goods-receipts            create DRAFT (header + items[])
 *   PATCH  /api/scm-goods-receipts/:id        edit DRAFT (header + optional items)
 *   POST   /api/scm-goods-receipts/:id/post   DRAFT -> POSTED (stock in + PO sync)
 *   POST   /api/scm-goods-receipts/:id/cancel DRAFT -> CANCELLED (no stock impact)
 *   DELETE /api/scm-goods-receipts/:id        delete DRAFT (cascades items)
 *
 * Owner-only for now (requirePermission "*"), matching the Sidebar/Route guard.
 * Swap to a dedicated scm.* permission when the module is rolled out.
 */
const app = new Hono<{ Bindings: Env }>();
app.use("*", requirePermission("*"));

type Db = ReturnType<typeof getDb>;

// GRN-YYYY-NNNN, per-year sequence. Unique constraint + 409 retry guards races.
async function genGrnNumber(db: Db): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `GRN-${year}-`;
  const rows = await db
    .select({ n: scm_goods_receipt_notes.grn_number })
    .from(scm_goods_receipt_notes)
    .where(ilike(scm_goods_receipt_notes.grn_number, `${prefix}%`));
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
  if (status) conds.push(eq(scm_goods_receipt_notes.status, status));
  if (search) conds.push(ilike(scm_goods_receipt_notes.grn_number, `%${search}%`));
  const where = conds.length ? and(...conds) : undefined;

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(scm_goods_receipt_notes)
    .where(where);

  const rows = await db
    .select({
      id: scm_goods_receipt_notes.id,
      grn_number: scm_goods_receipt_notes.grn_number,
      supplier_id: scm_goods_receipt_notes.supplier_id,
      supplier_name: scm_suppliers.name,
      purchase_order_id: scm_goods_receipt_notes.purchase_order_id,
      po_number: scm_purchase_orders.po_number,
      warehouse_code: scm_goods_receipt_notes.warehouse_code,
      status: scm_goods_receipt_notes.status,
      received_date: scm_goods_receipt_notes.received_date,
      created_at: scm_goods_receipt_notes.created_at,
    })
    .from(scm_goods_receipt_notes)
    .leftJoin(scm_suppliers, eq(scm_goods_receipt_notes.supplier_id, scm_suppliers.id))
    .leftJoin(
      scm_purchase_orders,
      eq(scm_goods_receipt_notes.purchase_order_id, scm_purchase_orders.id),
    )
    .where(where)
    .orderBy(desc(scm_goods_receipt_notes.received_date), desc(scm_goods_receipt_notes.created_at))
    .limit(perPage)
    .offset((page - 1) * perPage);

  return c.json({ data: rows, page, per_page: perPage, total: count });
});

// ── single ──────────────────────────────────────────────────────────────
app.get("/:id", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const [grn] = await db
    .select()
    .from(scm_goods_receipt_notes)
    .where(eq(scm_goods_receipt_notes.id, id));
  if (!grn) return c.json({ error: "GRN not found" }, 404);
  const [supplier] = await db
    .select()
    .from(scm_suppliers)
    .where(eq(scm_suppliers.id, grn.supplier_id));
  let purchase_order = null;
  if (grn.purchase_order_id) {
    const [po] = await db
      .select()
      .from(scm_purchase_orders)
      .where(eq(scm_purchase_orders.id, grn.purchase_order_id));
    purchase_order = po ?? null;
  }
  const items = await db
    .select()
    .from(scm_goods_receipt_note_items)
    .where(eq(scm_goods_receipt_note_items.grn_id, id))
    .orderBy(asc(scm_goods_receipt_note_items.created_at));
  return c.json({ grn, supplier: supplier ?? null, purchase_order, items });
});

// ── create (DRAFT) ────────────────────────────────────────────────────────
app.post("/", async (c) => {
  const db = getDb(c.env);
  const userId = c.get("userId");
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const parsed = grnCreateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message || "Invalid GRN" }, 400);
  const d = parsed.data;

  const [supplier] = await db.select().from(scm_suppliers).where(eq(scm_suppliers.id, d.supplier_id));
  if (!supplier) return c.json({ error: "Supplier not found" }, 404);

  // Resolve a unit cost basis for any line that omits one but references a PO
  // line: snapshot the PO line's unit_price_centi as the receipt cost.
  const itemRows = await Promise.all(
    d.items.map(async (it) => {
      let unitCost = it.unit_cost_centi;
      if ((unitCost === undefined || unitCost === null) && it.po_item_id) {
        const [poItem] = await db
          .select({ price: scm_purchase_order_items.unit_price_centi })
          .from(scm_purchase_order_items)
          .where(eq(scm_purchase_order_items.id, it.po_item_id));
        if (poItem) unitCost = poItem.price;
      }
      return {
        po_item_id: it.po_item_id ?? null,
        material_kind: it.material_kind ?? "mfg_product",
        material_code: it.material_code,
        material_name: it.material_name ?? it.material_code,
        qty_received: it.qty_received,
        unit_cost_centi: unitCost ?? 0,
        notes: it.notes ?? null,
      };
    }),
  );

  const grnNumber = await genGrnNumber(db);

  try {
    const [grn] = await db
      .insert(scm_goods_receipt_notes)
      .values({
        grn_number: grnNumber,
        supplier_id: d.supplier_id,
        purchase_order_id: d.purchase_order_id ?? null,
        warehouse_code: d.warehouse_code,
        status: "DRAFT",
        received_date: d.received_date || undefined,
        notes: d.notes ?? null,
        created_by: userId ?? null,
      } as any)
      .returning();
    await db
      .insert(scm_goods_receipt_note_items)
      .values(itemRows.map((r) => ({ ...r, grn_id: grn.id })) as any);
    return c.json({ grn }, 201);
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    if (/unique|duplicate/i.test(msg)) return c.json({ error: "GRN number clash — please retry" }, 409);
    return c.json({ error: msg }, 500);
  }
});

// ── update header (+ optional item replace), DRAFT only ─────────────────────
const HDR_FIELDS = ["warehouse_code", "received_date", "notes"] as const;
app.patch("/:id", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const [grn] = await db
    .select()
    .from(scm_goods_receipt_notes)
    .where(eq(scm_goods_receipt_notes.id, id));
  if (!grn) return c.json({ error: "GRN not found" }, 404);
  if (grn.status !== "DRAFT") return c.json({ error: "Only draft GRNs can be edited" }, 400);

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const parsed = grnUpdateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message || "Invalid GRN" }, 400);
  const d = parsed.data;

  const data: Record<string, unknown> = {};
  for (const f of HDR_FIELDS) if ((d as Record<string, unknown>)[f] !== undefined) data[f] = (d as Record<string, unknown>)[f];
  data.updated_at = new Date();
  await db
    .update(scm_goods_receipt_notes)
    .set(data as any)
    .where(eq(scm_goods_receipt_notes.id, id));

  // Optional full item replace while DRAFT (omit `items` to leave lines as-is).
  if (Array.isArray(body.items)) {
    const replace = await Promise.all(
      (body.items as Record<string, unknown>[]).map(async (raw) => {
        const code = String(raw.material_code ?? "").trim();
        const poItemId = raw.po_item_id ? String(raw.po_item_id) : null;
        let unitCost =
          raw.unit_cost_centi !== undefined && raw.unit_cost_centi !== null
            ? Math.trunc(Number(raw.unit_cost_centi))
            : undefined;
        if ((unitCost === undefined || Number.isNaN(unitCost)) && poItemId) {
          const [poItem] = await db
            .select({ price: scm_purchase_order_items.unit_price_centi })
            .from(scm_purchase_order_items)
            .where(eq(scm_purchase_order_items.id, poItemId));
          if (poItem) unitCost = poItem.price;
        }
        return {
          grn_id: id,
          po_item_id: poItemId,
          material_kind: raw.material_kind ? String(raw.material_kind) : "mfg_product",
          material_code: code,
          material_name: raw.material_name ? String(raw.material_name) : code,
          qty_received: Math.max(0, Math.trunc(Number(raw.qty_received) || 0)),
          unit_cost_centi: Math.max(0, unitCost ?? 0),
          notes: raw.notes ? String(raw.notes) : null,
        };
      }),
    );
    await db
      .delete(scm_goods_receipt_note_items)
      .where(eq(scm_goods_receipt_note_items.grn_id, id));
    if (replace.length) {
      await db.insert(scm_goods_receipt_note_items).values(replace as any);
    }
  }

  const [fresh] = await db
    .select()
    .from(scm_goods_receipt_notes)
    .where(eq(scm_goods_receipt_notes.id, id));
  return c.json({ grn: fresh });
});

// ── post (DRAFT -> POSTED): stock in + received_qty + PO status sync ─────────
// Atomicity: scm-purchase-orders.ts does NOT wrap multi-row writes in
// db.transaction (it awaits sequentially), so this mirrors that — careful,
// dependency-ordered awaits, best-effort 500 on any failure. See FINAL OUTPUT.
app.post("/:id/post", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");

  const [grn] = await db
    .select()
    .from(scm_goods_receipt_notes)
    .where(eq(scm_goods_receipt_notes.id, id));
  if (!grn) return c.json({ error: "GRN not found" }, 404);
  if (grn.status !== "DRAFT") return c.json({ error: "Only draft GRNs can be posted" }, 400);

  const items = await db
    .select()
    .from(scm_goods_receipt_note_items)
    .where(eq(scm_goods_receipt_note_items.grn_id, id))
    .orderBy(asc(scm_goods_receipt_note_items.created_at));

  try {
    // a/b. one GRN_IN ledger move per received line
    for (const it of items) {
      if ((it.qty_received || 0) <= 0) continue;
      await db.insert(scm_stock_moves).values({
        warehouse_code: grn.warehouse_code,
        material_kind: it.material_kind,
        material_code: it.material_code,
        material_name: it.material_name,
        qty: it.qty_received,
        unit_cost_centi: it.unit_cost_centi,
        move_type: "GRN_IN",
        ref_type: "grn",
        ref_id: grn.id,
        created_by: null,
      } as any);
    }

    // c. advance each fulfilled PO line's received_qty
    for (const it of items) {
      if (!it.po_item_id || (it.qty_received || 0) <= 0) continue;
      await db
        .update(scm_purchase_order_items)
        .set({ received_qty: sql`${scm_purchase_order_items.received_qty} + ${it.qty_received}` })
        .where(eq(scm_purchase_order_items.id, it.po_item_id));
    }

    // d. recompute parent PO status from its (now-updated) lines
    if (grn.purchase_order_id) {
      const poItems = await db
        .select({
          qty: scm_purchase_order_items.qty,
          received_qty: scm_purchase_order_items.received_qty,
        })
        .from(scm_purchase_order_items)
        .where(eq(scm_purchase_order_items.purchase_order_id, grn.purchase_order_id));
      const allReceived = poItems.length > 0 && poItems.every((p) => (p.received_qty || 0) >= (p.qty || 0));
      const anyReceived = poItems.some((p) => (p.received_qty || 0) > 0);
      let nextStatus: string | null = null;
      if (allReceived) nextStatus = "RECEIVED";
      else if (anyReceived) nextStatus = "PARTIALLY_RECEIVED";
      if (nextStatus) {
        const poUpdate: Record<string, unknown> = { status: nextStatus, updated_at: new Date() };
        if (nextStatus === "RECEIVED") poUpdate.received_at = new Date();
        await db
          .update(scm_purchase_orders)
          .set(poUpdate as any)
          .where(eq(scm_purchase_orders.id, grn.purchase_order_id));
      }
    }

    // e. flip the GRN to POSTED
    const [posted] = await db
      .update(scm_goods_receipt_notes)
      .set({ status: "POSTED", posted_at: new Date(), updated_at: new Date() })
      .where(eq(scm_goods_receipt_notes.id, id))
      .returning();

    return c.json({ grn: posted, items });
  } catch (e) {
    return c.json({ error: (e as Error)?.message || String(e) }, 500);
  }
});

// ── cancel (DRAFT -> CANCELLED, no stock impact) ────────────────────────────
app.post("/:id/cancel", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const [grn] = await db
    .select()
    .from(scm_goods_receipt_notes)
    .where(eq(scm_goods_receipt_notes.id, id));
  if (!grn) return c.json({ error: "GRN not found" }, 404);
  if (grn.status === "POSTED") return c.json({ error: "Posted GRNs cannot be cancelled" }, 400);
  if (grn.status === "CANCELLED") return c.json({ grn });
  const [cancelled] = await db
    .update(scm_goods_receipt_notes)
    .set({ status: "CANCELLED", cancelled_at: new Date(), updated_at: new Date() })
    .where(eq(scm_goods_receipt_notes.id, id))
    .returning();
  return c.json({ grn: cancelled });
});

// ── delete (DRAFT only, cascades items) ─────────────────────────────────────
app.delete("/:id", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const [grn] = await db
    .select()
    .from(scm_goods_receipt_notes)
    .where(eq(scm_goods_receipt_notes.id, id));
  if (!grn) return c.json({ error: "GRN not found" }, 404);
  if (grn.status === "POSTED") return c.json({ error: "Posted GRNs cannot be deleted" }, 400);
  await db.delete(scm_goods_receipt_notes).where(eq(scm_goods_receipt_notes.id, id));
  return c.json({ ok: true });
});

export default app;
