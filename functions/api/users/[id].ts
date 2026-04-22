// PATCH  /api/users/:id — update user (admin-only)
// DELETE /api/users/:id — delete user (admin-only, prevents self-delete)

import { Env, json, error } from "../../_shared";
import { requireAuth, requireRole, logAudit } from "../../_auth";

const FIELD_MAP: Record<string, { col: string; json?: boolean }> = {
  name:                { col: "name" },
  code:                { col: "code" },
  email:               { col: "email" },
  phone:               { col: "phone" },
  department:          { col: "department" },
  position:            { col: "position" },
  parentId:            { col: "parent_id" },
  additionalParentIds: { col: "additional_parent_ids", json: true },
  status:              { col: "status" },
  assignedBrands:      { col: "assigned_brands", json: true },
  commissionTiers:     { col: "commission_tiers", json: true },
  minRate:             { col: "min_rate" },
  notes:               { col: "notes" },
};

export const onRequestPatch: PagesFunction<Env> = async ({ env, request, params }) => {
  const admin = await requireAuth(request, env);
  if (admin instanceof Response) return admin;
  const roleErr = requireRole(admin, "Sales Director");
  if (roleErr) return roleErr;

  const id = params.id as string;
  const body = await request.json<Record<string, unknown>>().catch(() => ({}));

  const before = await env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(id).first<Record<string, unknown>>();
  if (!before) return error("User not found", 404);

  const sets: string[] = [];
  const vals: unknown[] = [];
  const changes: Record<string, unknown> = {};
  for (const [k, meta] of Object.entries(FIELD_MAP)) {
    if (!(k in body)) continue;
    const v = body[k];
    const encoded = meta.json ? JSON.stringify(v ?? []) : (v ?? null);
    sets.push(`${meta.col} = ?`);
    vals.push(encoded);
    changes[k] = v;
  }
  if (!sets.length) return error("No fields to update");
  sets.push(`updated_at = datetime('now')`);
  vals.push(id);

  await env.DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).bind(...vals).run();

  await logAudit(env, request, admin, {
    action: "update",
    entityType: "user",
    entityId: id,
    changes,
  });

  return json({ ok: true });
};

export const onRequestDelete: PagesFunction<Env> = async ({ env, request, params }) => {
  const admin = await requireAuth(request, env);
  if (admin instanceof Response) return admin;
  const roleErr = requireRole(admin, "Sales Director");
  if (roleErr) return roleErr;

  const id = params.id as string;
  if (id === admin.id) return error("You cannot delete yourself", 400);

  const before = await env.DB.prepare(`SELECT id, name, email FROM users WHERE id = ?`).bind(id).first<{ id: string; name: string; email: string }>();
  if (!before) return error("User not found", 404);

  const r = await env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(id).run();

  await logAudit(env, request, admin, {
    action: "delete",
    entityType: "user",
    entityId: id,
    changes: { name: before.name, email: before.email },
  });

  return json({ ok: true, changes: r.meta.changes });
};
