// PUT /api/settings/:key — upsert a single setting (admin-only).
// Body is the raw JSON value to store (array, object, string, whatever).
// We stringify and write. Audit-logged.

import { Env, json, error } from "../../_shared";
import { requireAuth, requireRole, logAudit } from "../../_auth";

export const onRequestPut: PagesFunction<Env> = async ({ env, request, params }) => {
  const admin = await requireAuth(request, env);
  if (admin instanceof Response) return admin;
  const roleErr = requireRole(admin, "Sales Director");
  if (roleErr) return roleErr;

  const key = params.key as string;
  if (!key || typeof key !== "string") return error("Invalid setting key");

  const value = await request.json().catch(() => undefined);
  if (value === undefined) return error("Missing body");

  const serialized = JSON.stringify(value);

  await env.DB.prepare(
    `INSERT INTO app_settings (key, value, updated_at, updated_by)
     VALUES (?, ?, datetime('now'), ?)
     ON CONFLICT(key) DO UPDATE SET
       value      = excluded.value,
       updated_at = datetime('now'),
       updated_by = excluded.updated_by`
  ).bind(key, serialized, admin.id).run();

  await logAudit(env, request, admin, {
    action: "update",
    entityType: "app_setting",
    entityId: key,
    changes: { value },
  });

  return json({ ok: true });
};
