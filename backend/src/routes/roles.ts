import { Hono } from "hono";
import type { Env } from "../types";
import { PERMISSIONS, isValidPermission, parsePermissions } from "../services/permissions";
import { requirePermission } from "../middleware/auth";

const app = new Hono<{ Bindings: Env }>();

/**
 * GET /api/roles/permissions
 * Returns the permission catalog so the frontend can render the
 * permission picker. Anyone with roles.read can see this.
 */
app.get("/permissions", requirePermission("roles.read"), async (c) => {
  return c.json({ permissions: PERMISSIONS });
});

/**
 * GET /api/roles
 * Returns all roles + their permission arrays + member counts.
 */
app.get("/", requirePermission("roles.read"), async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT r.id, r.name, r.description, r.permissions, r.is_system,
            r.scope_to_pic, r.created_at,
            (SELECT COUNT(*) FROM users WHERE role_id = r.id) as member_count
     FROM roles r
     ORDER BY r.is_system DESC, r.name ASC`
  ).all();

  const roles = (rows.results || []).map((r: any) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    permissions: parsePermissions(r.permissions),
    is_system: !!r.is_system,
    scope_to_pic: !!r.scope_to_pic,
    member_count: r.member_count || 0,
    created_at: r.created_at,
  }));

  return c.json({ roles });
});

/**
 * POST /api/roles
 * Body: { name, description?, permissions: string[] }
 * Create a custom role.
 */
app.post("/", requirePermission("roles.manage"), async (c) => {
  const body = await c.req.json<{
    name: string;
    description?: string;
    permissions?: string[];
    scope_to_pic?: boolean;
  }>();
  if (!body.name?.trim()) return c.json({ error: "name is required" }, 400);

  const perms = (body.permissions || []).filter(isValidPermission);

  const exists = await c.env.DB.prepare(`SELECT id FROM roles WHERE name = ?`)
    .bind(body.name.trim())
    .first();
  if (exists) return c.json({ error: "A role with that name already exists" }, 409);

  const result = await c.env.DB.prepare(
    `INSERT INTO roles (name, description, permissions, is_system, scope_to_pic)
     VALUES (?, ?, ?, 0, ?)`
  )
    .bind(
      body.name.trim(),
      body.description?.trim() || null,
      JSON.stringify(perms),
      body.scope_to_pic ? 1 : 0
    )
    .run();

  return c.json({
    id: result.meta.last_row_id,
    name: body.name.trim(),
    description: body.description?.trim() || null,
    permissions: perms,
    is_system: false,
    scope_to_pic: !!body.scope_to_pic,
    member_count: 0,
  });
});

/**
 * PATCH /api/roles/:id
 * Body: { name?, description?, permissions? }
 * Update a custom role. System roles' permissions are locked.
 */
app.patch("/:id", requirePermission("roles.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Bad id" }, 400);

  const role = await c.env.DB.prepare(
    `SELECT id, is_system FROM roles WHERE id = ?`
  )
    .bind(id)
    .first<{ id: number; is_system: number }>();
  if (!role) return c.json({ error: "Role not found" }, 404);

  const body = await c.req.json<{
    name?: string;
    description?: string;
    permissions?: string[];
    scope_to_pic?: boolean;
  }>();

  // System roles: only description editable, never name or permissions.
  if (role.is_system) {
    if (body.name !== undefined || body.permissions !== undefined) {
      return c.json(
        { error: "System roles cannot be renamed or have permissions changed" },
        400
      );
    }
  }

  const sets: string[] = [];
  const binds: any[] = [];
  if (body.name !== undefined) {
    sets.push("name = ?");
    binds.push(body.name.trim());
  }
  if (body.description !== undefined) {
    sets.push("description = ?");
    binds.push(body.description?.trim() || null);
  }
  if (body.permissions !== undefined) {
    const perms = body.permissions.filter(isValidPermission);
    sets.push("permissions = ?");
    binds.push(JSON.stringify(perms));
  }
  if (body.scope_to_pic !== undefined) {
    sets.push("scope_to_pic = ?");
    binds.push(body.scope_to_pic ? 1 : 0);
  }
  if (!sets.length) return c.json({ error: "No fields to update" }, 400);

  binds.push(id);
  await c.env.DB.prepare(`UPDATE roles SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();

  return c.json({ ok: true });
});

/**
 * DELETE /api/roles/:id
 * Delete a custom role. Refuses if any user still holds it.
 */
app.delete("/:id", requirePermission("roles.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Bad id" }, 400);

  const role = await c.env.DB.prepare(
    `SELECT id, is_system FROM roles WHERE id = ?`
  )
    .bind(id)
    .first<{ id: number; is_system: number }>();
  if (!role) return c.json({ error: "Role not found" }, 404);
  if (role.is_system) {
    return c.json({ error: "System roles cannot be deleted" }, 400);
  }

  const inUse = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM users WHERE role_id = ?`
  )
    .bind(id)
    .first<{ count: number }>();
  if ((inUse?.count || 0) > 0) {
    return c.json(
      { error: `Role is in use by ${inUse?.count} user(s) — reassign them first` },
      409
    );
  }

  await c.env.DB.prepare(`DELETE FROM roles WHERE id = ?`).bind(id).run();
  return c.json({ ok: true });
});

export default app;
