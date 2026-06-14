import { Hono } from "hono";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Env } from "../types";
import { hasPermission } from "../services/permissions";
import { getDb } from "../db/client";
import { awards, award_redemptions, users } from "../db/schema";
import { spend, award as awardPoints } from "../services/points";

/**
 * Award shop (Phase 2 of the gamification system, mig 056).
 *
 * Open to every authenticated user for read + redeem; admin endpoints
 * gated by the `*` wildcard, matching the gamify route convention.
 *
 * Image uploads ride the existing POD_BUCKET R2 binding under the
 * `award/{id}/{filename}` key prefix. The frontend POSTs the binary
 * directly here; we store the R2 key on the row.
 */

const app = new Hono<{ Bindings: Env }>();

function isAdmin(user: any): boolean {
  return !!user && hasPermission(user.permissions, "*");
}

// ── GET /api/awards ─────────────────────────────────────────────
// Public catalog — active items only, sorted by admin-defined order.
app.get("/", async (c) => {
  const db = getDb(c.env);
  const rows = await db
    .select()
    .from(awards)
    .where(eq(awards.active, 1))
    .orderBy(awards.sort_order, awards.id);
  return c.json({ rows });
});

// ── GET /api/awards/admin ───────────────────────────────────────
// Admin catalog — includes inactive items.
app.get("/admin", async (c) => {
  const user = c.get("user");
  if (!isAdmin(user)) return c.json({ error: "Forbidden" }, 403);
  const db = getDb(c.env);
  const rows = await db
    .select()
    .from(awards)
    .orderBy(awards.sort_order, awards.id);
  return c.json({ rows });
});

// ── POST /api/awards ────────────────────────────────────────────
// Admin: create.
app.post("/", async (c) => {
  const user = c.get("user");
  if (!isAdmin(user)) return c.json({ error: "Forbidden" }, 403);
  const body = await c.req.json<{
    name?: string;
    description?: string;
    cost_points?: number;
    stock?: number | null;
    sort_order?: number;
  }>();
  const name = (body.name || "").trim();
  if (!name) return c.json({ error: "Name is required" }, 400);
  const cost = Number(body.cost_points);
  if (!Number.isFinite(cost) || cost <= 0) {
    return c.json({ error: "cost_points must be > 0" }, 400);
  }
  const db = getDb(c.env);
  const inserted = await db
    .insert(awards)
    .values({
      name,
      description: body.description ?? null,
      cost_points: cost,
      stock: body.stock ?? null,
      sort_order: body.sort_order ?? 0,
      active: 1,
    })
    .returning()
    .then((r) => r[0]);
  return c.json({ row: inserted });
});

// ── PATCH /api/awards/:id ───────────────────────────────────────
app.patch("/:id", async (c) => {
  const user = c.get("user");
  if (!isAdmin(user)) return c.json({ error: "Forbidden" }, 403);
  const id = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(id)) return c.json({ error: "Bad id" }, 400);
  const body = await c.req.json<Partial<{
    name: string;
    description: string | null;
    cost_points: number;
    stock: number | null;
    active: 0 | 1;
    sort_order: number;
  }>>();
  const patch: Record<string, any> = { updated_at: sql`to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS')` };
  if (typeof body.name === "string") patch.name = body.name.trim();
  if ("description" in body) patch.description = body.description;
  if (typeof body.cost_points === "number") patch.cost_points = body.cost_points;
  if ("stock" in body) patch.stock = body.stock;
  if (typeof body.active === "number") patch.active = body.active;
  if (typeof body.sort_order === "number") patch.sort_order = body.sort_order;

  const db = getDb(c.env);
  const updated = await db
    .update(awards)
    .set(patch)
    .where(eq(awards.id, id))
    .returning()
    .then((r) => r[0]);
  if (!updated) return c.json({ error: "Award not found" }, 404);
  return c.json({ row: updated });
});

// ── DELETE /api/awards/:id ──────────────────────────────────────
// Soft delete via active=0 to preserve redemption history.
app.delete("/:id", async (c) => {
  const user = c.get("user");
  if (!isAdmin(user)) return c.json({ error: "Forbidden" }, 403);
  const id = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(id)) return c.json({ error: "Bad id" }, 400);
  const db = getDb(c.env);
  await db
    .update(awards)
    .set({ active: 0, updated_at: sql`to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS')` })
    .where(eq(awards.id, id));
  return c.json({ ok: true });
});

// ── PUT /api/awards/:id/image ───────────────────────────────────
// Admin: upload an image binary. Body is the raw bytes; query
// parameter `name` is the filename (preserves extension on the R2 key).
app.put("/:id/image", async (c) => {
  const user = c.get("user");
  if (!isAdmin(user)) return c.json({ error: "Forbidden" }, 403);
  const id = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(id)) return c.json({ error: "Bad id" }, 400);
  const filename = c.req.query("name") || `image-${Date.now()}.bin`;
  const contentType =
    c.req.header("content-type") || "application/octet-stream";
  const buf = await c.req.arrayBuffer();
  if (!buf.byteLength) return c.json({ error: "Empty body" }, 400);

  const key = `award/${id}/${Date.now()}-${filename.replace(/[^\w.\-]+/g, "_")}`;
  await c.env.POD_BUCKET.put(key, buf, {
    httpMetadata: { contentType },
  });

  const db = getDb(c.env);
  const updated = await db
    .update(awards)
    .set({ image_r2_key: key, updated_at: sql`to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS')` })
    .where(eq(awards.id, id))
    .returning()
    .then((r) => r[0]);
  if (!updated) return c.json({ error: "Award not found" }, 404);
  return c.json({ row: updated });
});

// ── GET /api/awards/:id/image ───────────────────────────────────
// Public: stream the image bytes from R2.
app.get("/:id/image", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(id)) return c.json({ error: "Bad id" }, 400);
  const db = getDb(c.env);
  const a = await db
    .select({ key: awards.image_r2_key })
    .from(awards)
    .where(eq(awards.id, id))
    .then((r) => r[0]);
  if (!a?.key) return c.json({ error: "No image" }, 404);
  const obj = await c.env.POD_BUCKET.get(a.key);
  if (!obj) return c.json({ error: "Image missing" }, 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("cache-control", "public, max-age=300");
  return new Response(obj.body, { headers });
});

// ── POST /api/awards/:id/redeem ─────────────────────────────────
// User: redeem an active award. Atomic against balance + stock.
app.post("/:id/redeem", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const id = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(id)) return c.json({ error: "Bad id" }, 400);
  const body = await c.req
    .json<{ shipping_addr?: string }>()
    .catch(() => ({} as { shipping_addr?: string }));

  const db = getDb(c.env);
  const a = await db.select().from(awards).where(eq(awards.id, id)).then((r) => r[0]);
  if (!a) return c.json({ error: "Award not found" }, 404);
  if (!a.active) return c.json({ error: "This award is no longer available" }, 400);
  if (a.stock !== null && a.stock !== undefined && a.stock <= 0) {
    return c.json({ error: "Out of stock" }, 400);
  }

  const cost = a.cost_points;

  // Spend points first — if balance is insufficient this returns
  // before any stock decrement.
  const result = await spend(c.env, user.id, cost, "redeem", {
    ref_type: "award",
    ref_id: a.id,
    note: a.name,
  });
  if (!result.ok) return c.json({ error: result.error }, 400);

  // Decrement stock if tracked. If two redemptions race past the
  // pre-check, the WHERE clause prevents stock from going negative.
  if (a.stock !== null && a.stock !== undefined) {
    const dec = await c.env.DB.prepare(
      `UPDATE awards SET stock = stock - 1 WHERE id = ? AND stock > 0`,
    )
      .bind(a.id)
      .run();
    if ((dec.meta as any)?.changes === 0) {
      // Race lost — refund the points and tell the user.
      await awardPoints(c.env, user.id, "redeem_refund", cost, {
        ref_type: "award",
        ref_id: a.id,
        note: `Refund: out of stock at redeem time (${a.name})`,
      });
      return c.json({ error: "Out of stock" }, 409);
    }
  }

  // Look up the just-written ledger tx id so admins can link it.
  const lastTx = await c.env.DB.prepare(
    `SELECT id FROM point_transactions
       WHERE user_id = ? AND reason = 'redeem' AND ref_id = ?
       ORDER BY id DESC LIMIT 1`,
  )
    .bind(user.id, a.id)
    .first<{ id: number }>();

  const inserted = await db
    .insert(award_redemptions)
    .values({
      award_id: a.id,
      user_id: user.id,
      cost_points: cost,
      status: "pending",
      shipping_addr: body.shipping_addr ?? null,
      ledger_tx_id: lastTx?.id ?? null,
    })
    .returning()
    .then((r) => r[0]);

  return c.json({
    ok: true,
    redemption: inserted,
    new_balance: result.new_balance,
  });
});

// ── GET /api/awards/redemptions/mine ────────────────────────────
// Self list.
app.get("/redemptions/mine", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const db = getDb(c.env);
  const rows = await db
    .select({
      id: award_redemptions.id,
      award_id: award_redemptions.award_id,
      award_name: awards.name,
      award_image_r2_key: awards.image_r2_key,
      cost_points: award_redemptions.cost_points,
      status: award_redemptions.status,
      shipping_addr: award_redemptions.shipping_addr,
      admin_note: award_redemptions.admin_note,
      created_at: award_redemptions.created_at,
      shipped_at: award_redemptions.shipped_at,
      delivered_at: award_redemptions.delivered_at,
      cancelled_at: award_redemptions.cancelled_at,
    })
    .from(award_redemptions)
    .innerJoin(awards, eq(awards.id, award_redemptions.award_id))
    .where(eq(award_redemptions.user_id, user.id))
    .orderBy(desc(award_redemptions.created_at))
    .limit(100);
  return c.json({ rows });
});

// ── GET /api/awards/redemptions ─────────────────────────────────
// Admin list — filterable by status.
app.get("/redemptions", async (c) => {
  const user = c.get("user");
  if (!isAdmin(user)) return c.json({ error: "Forbidden" }, 403);
  const status = c.req.query("status");
  const db = getDb(c.env);
  const conds = [];
  if (status) conds.push(eq(award_redemptions.status, status));
  const rows = await db
    .select({
      id: award_redemptions.id,
      award_id: award_redemptions.award_id,
      award_name: awards.name,
      award_image_r2_key: awards.image_r2_key,
      user_id: award_redemptions.user_id,
      user_name: users.name,
      user_email: users.email,
      cost_points: award_redemptions.cost_points,
      status: award_redemptions.status,
      shipping_addr: award_redemptions.shipping_addr,
      admin_note: award_redemptions.admin_note,
      created_at: award_redemptions.created_at,
      shipped_at: award_redemptions.shipped_at,
      delivered_at: award_redemptions.delivered_at,
      cancelled_at: award_redemptions.cancelled_at,
    })
    .from(award_redemptions)
    .innerJoin(awards, eq(awards.id, award_redemptions.award_id))
    .innerJoin(users, eq(users.id, award_redemptions.user_id))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(award_redemptions.created_at))
    .limit(200);
  return c.json({ rows });
});

// ── POST /api/awards/redemptions/:id/ship ───────────────────────
app.post("/redemptions/:id/ship", async (c) => {
  const user = c.get("user");
  if (!isAdmin(user)) return c.json({ error: "Forbidden" }, 403);
  const id = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(id)) return c.json({ error: "Bad id" }, 400);
  const body = await c.req
    .json<{ admin_note?: string }>()
    .catch(() => ({} as { admin_note?: string }));
  const db = getDb(c.env);
  const updated = await db
    .update(award_redemptions)
    .set({
      status: "shipped",
      shipped_at: sql`to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS')`,
      admin_note: body.admin_note ?? null,
    })
    .where(eq(award_redemptions.id, id))
    .returning()
    .then((r) => r[0]);
  if (!updated) return c.json({ error: "Not found" }, 404);
  return c.json({ row: updated });
});

// ── POST /api/awards/redemptions/:id/deliver ────────────────────
app.post("/redemptions/:id/deliver", async (c) => {
  const user = c.get("user");
  if (!isAdmin(user)) return c.json({ error: "Forbidden" }, 403);
  const id = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(id)) return c.json({ error: "Bad id" }, 400);
  const db = getDb(c.env);
  const updated = await db
    .update(award_redemptions)
    .set({
      status: "delivered",
      delivered_at: sql`to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS')`,
    })
    .where(eq(award_redemptions.id, id))
    .returning()
    .then((r) => r[0]);
  if (!updated) return c.json({ error: "Not found" }, 404);
  return c.json({ row: updated });
});

// ── POST /api/awards/redemptions/:id/cancel ─────────────────────
// Refunds points + restores stock if applicable.
app.post("/redemptions/:id/cancel", async (c) => {
  const user = c.get("user");
  if (!isAdmin(user)) return c.json({ error: "Forbidden" }, 403);
  const id = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(id)) return c.json({ error: "Bad id" }, 400);
  const body = await c.req
    .json<{ admin_note?: string }>()
    .catch(() => ({} as { admin_note?: string }));

  const db = getDb(c.env);
  const r = await db
    .select()
    .from(award_redemptions)
    .where(eq(award_redemptions.id, id))
    .then((r) => r[0]);
  if (!r) return c.json({ error: "Not found" }, 404);
  if (r.status === "delivered") {
    return c.json({ error: "Cannot cancel a delivered redemption" }, 400);
  }
  if (r.status === "cancelled") {
    return c.json({ error: "Already cancelled" }, 400);
  }

  // Refund points
  await awardPoints(c.env, r.user_id, "redeem_refund", r.cost_points, {
    ref_type: "award",
    ref_id: r.award_id,
    note: body.admin_note || "Admin cancelled redemption",
  });

  // Restore stock if tracked
  await c.env.DB.prepare(
    `UPDATE awards SET stock = COALESCE(stock + 1, stock) WHERE id = ? AND stock IS NOT NULL`,
  )
    .bind(r.award_id)
    .run();

  const updated = await db
    .update(award_redemptions)
    .set({
      status: "cancelled",
      cancelled_at: sql`to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS')`,
      cancelled_by: user!.id,
      admin_note: body.admin_note ?? null,
    })
    .where(eq(award_redemptions.id, id))
    .returning()
    .then((r) => r[0]);

  return c.json({ row: updated });
});

export default app;
