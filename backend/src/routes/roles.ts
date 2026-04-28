import { Hono } from "hono";
import type { Env } from "../types";
import { PERMISSIONS, isValidPermission, parsePermissions } from "../services/permissions";
import { requirePermission } from "../middleware/auth";
import { getDb } from "../db/client";
import { roles, users } from "../db/schema";
import { and, eq, sql } from "drizzle-orm";

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
  const db = getDb(c.env);
  const rows = await db
    .select({
      id: roles.id,
      name: roles.name,
      description: roles.description,
      permissions: roles.permissions,
      is_system: roles.is_system,
      scope_to_pic: roles.scope_to_pic,
      created_at: roles.created_at,
      // Subquery for the member count keeps this single-round-trip.
      member_count: sql<number>`(SELECT COUNT(*) FROM ${users} WHERE ${users.role_id} = ${roles.id})`,
    })
    .from(roles)
    .orderBy(sql`${roles.is_system} DESC`, roles.name);

  return c.json({
    roles: rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      permissions: parsePermissions(r.permissions),
      is_system: !!r.is_system,
      scope_to_pic: !!r.scope_to_pic,
      member_count: r.member_count ?? 0,
      created_at: r.created_at,
    })),
  });
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
  const name = body.name.trim();

  const db = getDb(c.env);
  const exists = await db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.name, name))
    .limit(1);
  if (exists.length > 0) {
    return c.json({ error: "A role with that name already exists" }, 409);
  }

  const inserted = await db
    .insert(roles)
    .values({
      name,
      description: body.description?.trim() || null,
      permissions: JSON.stringify(perms),
      is_system: 0,
      scope_to_pic: body.scope_to_pic ? 1 : 0,
    })
    .returning({ id: roles.id });

  return c.json({
    id: inserted[0]?.id,
    name,
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

  const db = getDb(c.env);
  const row = await db
    .select({ id: roles.id, is_system: roles.is_system })
    .from(roles)
    .where(eq(roles.id, id))
    .limit(1);
  if (row.length === 0) return c.json({ error: "Role not found" }, 404);

  const body = await c.req.json<{
    name?: string;
    description?: string;
    permissions?: string[];
    scope_to_pic?: boolean;
  }>();

  // System roles: only description editable, never name or permissions.
  if (row[0].is_system) {
    if (body.name !== undefined || body.permissions !== undefined) {
      return c.json(
        { error: "System roles cannot be renamed or have permissions changed" },
        400
      );
    }
  }

  const set: Record<string, any> = {};
  if (body.name !== undefined) set.name = body.name.trim();
  if (body.description !== undefined) {
    set.description = body.description?.trim() || null;
  }
  if (body.permissions !== undefined) {
    set.permissions = JSON.stringify(body.permissions.filter(isValidPermission));
  }
  if (body.scope_to_pic !== undefined) {
    set.scope_to_pic = body.scope_to_pic ? 1 : 0;
  }
  if (Object.keys(set).length === 0) {
    return c.json({ error: "No fields to update" }, 400);
  }

  await db.update(roles).set(set).where(eq(roles.id, id));
  return c.json({ ok: true });
});

/**
 * DELETE /api/roles/:id
 * Delete a custom role. Refuses if any user still holds it.
 */
app.delete("/:id", requirePermission("roles.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Bad id" }, 400);

  const db = getDb(c.env);
  const row = await db
    .select({ id: roles.id, is_system: roles.is_system })
    .from(roles)
    .where(eq(roles.id, id))
    .limit(1);
  if (row.length === 0) return c.json({ error: "Role not found" }, 404);
  if (row[0].is_system) {
    return c.json({ error: "System roles cannot be deleted" }, 400);
  }

  const inUse = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(users)
    .where(eq(users.role_id, id));
  const count = inUse[0]?.count ?? 0;
  if (count > 0) {
    return c.json(
      { error: `Role is in use by ${count} user(s) — reassign them first` },
      409
    );
  }

  await db.delete(roles).where(eq(roles.id, id));
  return c.json({ ok: true });
});

export default app;
