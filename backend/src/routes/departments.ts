import { Hono } from "hono";
import type { Env } from "../types";
import { requirePermission } from "../middleware/auth";

const app = new Hono<{ Bindings: Env }>();

/**
 * GET /api/departments
 * List departments + member counts. Anyone with users.read can see
 * them (same gate as the Members tab — department info is not
 * sensitive).
 */
app.get("/", requirePermission("users.read"), async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT d.id, d.name, d.description, d.color, d.sort_order, d.created_at,
            (SELECT COUNT(*) FROM users u WHERE u.department_id = d.id AND u.status = 'active') AS member_count
       FROM departments d
       ORDER BY d.sort_order, d.name`
  ).all();
  return c.json({ departments: rows.results ?? [] });
});

/**
 * POST /api/departments
 * Body: { name, description?, color? (6-char hex, no '#'), sort_order? }
 */
app.post("/", requirePermission("users.manage"), async (c) => {
  const body = await c.req.json<{
    name?: string;
    description?: string;
    color?: string;
    sort_order?: number;
  }>();
  const name = (body.name || "").trim();
  if (!name) return c.json({ error: "name is required" }, 400);

  const color = normaliseColor(body.color) ?? "64748b";

  // Name is UNIQUE — reactivate / return existing if a dupe slipped
  // through the UI (idempotent create plays nicely with quick retries).
  const existing = await c.env.DB.prepare(
    `SELECT id FROM departments WHERE name = ?`
  )
    .bind(name)
    .first<{ id: number }>();
  if (existing) return c.json({ error: "A department with that name already exists" }, 409);

  const r = await c.env.DB.prepare(
    `INSERT INTO departments (name, description, color, sort_order)
     VALUES (?, ?, ?, ?)`
  )
    .bind(name, body.description?.trim() || null, color, body.sort_order ?? 0)
    .run();
  return c.json({
    id: r.meta.last_row_id,
    name,
    description: body.description?.trim() || null,
    color,
    sort_order: body.sort_order ?? 0,
    member_count: 0,
  }, 201);
});

/**
 * PATCH /api/departments/:id
 * Body: { name?, description?, color?, sort_order? }
 */
app.patch("/:id", requirePermission("users.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Bad id" }, 400);

  const body = await c.req.json<{
    name?: string;
    description?: string;
    color?: string;
    sort_order?: number;
  }>();

  const sets: string[] = [];
  const binds: any[] = [];
  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) return c.json({ error: "name cannot be empty" }, 400);
    sets.push("name = ?");
    binds.push(name);
  }
  if (body.description !== undefined) {
    sets.push("description = ?");
    binds.push(body.description?.trim() || null);
  }
  if (body.color !== undefined) {
    const c2 = normaliseColor(body.color);
    if (!c2) return c.json({ error: "color must be a 6-char hex" }, 400);
    sets.push("color = ?");
    binds.push(c2);
  }
  if (body.sort_order !== undefined) {
    sets.push("sort_order = ?");
    binds.push(body.sort_order);
  }
  if (!sets.length) return c.json({ error: "No fields to update" }, 400);

  binds.push(id);
  const r = await c.env.DB.prepare(
    `UPDATE departments SET ${sets.join(", ")} WHERE id = ?`
  )
    .bind(...binds)
    .run();
  if (!r.meta.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

/**
 * DELETE /api/departments/:id
 * ON DELETE SET NULL on users.department_id means existing members
 * just get un-assigned — no cascade needed here.
 */
app.delete("/:id", requirePermission("users.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Bad id" }, 400);
  const r = await c.env.DB.prepare(`DELETE FROM departments WHERE id = ?`)
    .bind(id)
    .run();
  if (!r.meta.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

/** Accepts "#abc123", "abc123", or rejects anything else. Returns the
 *  normalised 6-char lower-case hex without the leading '#'. */
function normaliseColor(input: string | undefined | null): string | null {
  if (!input) return null;
  const v = String(input).trim().replace(/^#/, "").toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(v)) return null;
  return v;
}

export default app;
