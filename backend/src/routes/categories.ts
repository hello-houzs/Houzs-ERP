// ----------------------------------------------------------------------------
// /categories — product category library (sofa / bedframe / mattress / ...).
//
// 1:1 clone of 2990s apps/api/src/routes/categories.ts (PostgREST -> Drizzle).
// 2990s's route was hero-image-only (R2 PUBLIC_ASSETS upload). Houzs has no
// PUBLIC_ASSETS binding wired this slice, so the upload/delete endpoints return
// a clear not-configured response; a GET list + CRUD are added so the Products
// page can read/edit the category library.
//
// SEAMS (canonical rules): getDb(c.env) (rule #3); requirePermission("*") (rule
// #4, owner-only — 2990s gated hero-image to admin/coordinator via a staff-role
// lookup, collapsed to the module's owner-only mount); camelCase Drizzle rows ->
// snake_case wire shape (rule #7).
//
// Endpoints:
//   GET    /categories                 — list (sorted)
//   POST   /categories                 — create (id + label + icon)
//   PATCH  /categories/:id             — update label / icon / tbc / sort_order
//   DELETE /categories/:id             — delete
//   POST   /categories/:id/hero-image  — 501 until PUBLIC_ASSETS R2 is wired
//   DELETE /categories/:id/hero-image  — clears hero_image_key
// ----------------------------------------------------------------------------

import { Hono } from "hono";
import { asc, eq } from "drizzle-orm";
import type { Env } from "../types";
import { getDb } from "../db/client";
import { categories as categoriesTable } from "../db/schema";
import { requirePermission } from "../middleware/auth";

const app = new Hono<{ Bindings: Env }>();

app.use("*", requirePermission("*"));

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type CategoryRowDb = typeof categoriesTable.$inferSelect;
function toCategoryResponse(r: CategoryRowDb) {
  return {
    id: r.id,
    label: r.label,
    icon: r.icon,
    tbc: r.tbc,
    hero_image_key: r.heroImageKey,
    sort_order: r.sortOrder,
  };
}

// ── List ──────────────────────────────────────────────────────────────
app.get("/", async (c) => {
  const db = getDb(c.env);
  try {
    const rows = await db
      .select()
      .from(categoriesTable)
      .orderBy(asc(categoriesTable.sortOrder), asc(categoriesTable.label));
    return c.json({ categories: rows.map(toCategoryResponse) });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

// ── Create ────────────────────────────────────────────────────────────
app.post("/", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const id = (body.id as string | undefined)?.trim();
  const label = (body.label as string | undefined)?.trim();
  const icon = (body.icon as string | undefined)?.trim();
  if (!id) return c.json({ error: "id_required" }, 400);
  if (!label) return c.json({ error: "label_required" }, 400);
  if (!icon) return c.json({ error: "icon_required" }, 400);

  const db = getDb(c.env);
  try {
    const inserted = await db
      .insert(categoriesTable)
      .values({
        id,
        label,
        icon,
        tbc: Boolean(body.tbc),
        sortOrder: typeof body.sortOrder === "number" ? body.sortOrder : 0,
      })
      .returning();
    return c.json({ category: toCategoryResponse(inserted[0]) }, 201);
  } catch (e) {
    if (isUniqueViolation(e)) return c.json({ error: "duplicate_id" }, 409);
    return c.json({ error: "insert_failed", reason: errMsg(e) }, 500);
  }
});

// ── Update ────────────────────────────────────────────────────────────
app.patch("/:id", async (c) => {
  const id = c.req.param("id");
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const updates: Record<string, unknown> = {};
  if (typeof body.label === "string") updates.label = body.label;
  if (typeof body.icon === "string") updates.icon = body.icon;
  if (typeof body.tbc === "boolean") updates.tbc = body.tbc;
  if (typeof body.sortOrder === "number") updates.sortOrder = body.sortOrder;
  if (Object.keys(updates).length === 0) return c.json({ error: "empty_patch" }, 400);

  const db = getDb(c.env);
  try {
    const updated = await db
      .update(categoriesTable)
      .set(updates)
      .where(eq(categoriesTable.id, id))
      .returning();
    if (!updated[0]) return c.json({ error: "not_found" }, 404);
    return c.json({ category: toCategoryResponse(updated[0]) });
  } catch (e) {
    return c.json({ error: "update_failed", reason: errMsg(e) }, 500);
  }
});

// ── Delete ────────────────────────────────────────────────────────────
app.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const db = getDb(c.env);
  try {
    await db.delete(categoriesTable).where(eq(categoriesTable.id, id));
    return c.body(null, 204);
  } catch (e) {
    // FK from products.category_id -> a referenced category can't be dropped.
    if (isFkViolation(e)) {
      return c.json(
        { error: "category_in_use", reason: "Category is referenced by a product; reassign those first." },
        409,
      );
    }
    return c.json({ error: "delete_failed", reason: errMsg(e) }, 500);
  }
});

// ── Hero image (R2) ───────────────────────────────────────────────────
// 2990s uploaded to the PUBLIC_ASSETS bucket. Houzs has no such binding wired
// in this slice — return 501 so the UI shows a clear "not configured" state
// rather than a runtime crash. (TODO: wire when a public R2 bucket lands.)
app.post("/:id/hero-image", (c) =>
  c.json({ error: "not_configured", reason: "PUBLIC_ASSETS R2 bucket not wired in this slice." }, 501),
);

app.delete("/:id/hero-image", async (c) => {
  const id = c.req.param("id");
  const db = getDb(c.env);
  try {
    await db.update(categoriesTable).set({ heroImageKey: null }).where(eq(categoriesTable.id, id));
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: "update_failed", reason: errMsg(e) }, 500);
  }
});

function isUniqueViolation(e: unknown): boolean {
  return Boolean(e && typeof e === "object" && (e as { code?: string }).code === "23505");
}
function isFkViolation(e: unknown): boolean {
  return Boolean(e && typeof e === "object" && (e as { code?: string }).code === "23503");
}

export default app;
