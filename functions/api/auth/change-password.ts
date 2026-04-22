// POST /api/auth/change-password
//   Body: { currentPassword, newPassword }
// Requires auth. Used both for first-time (must_change_password = 1) and
// later changes.

import { Env, json, error } from "../../_shared";
import {
  getAuthUser, verifyPassword, hashPassword, validatePassword, logAudit,
} from "../../_auth";

export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  const user = await getAuthUser(request, env);
  if (!user) return error("Not authenticated", 401);

  const body = await request.json<{ currentPassword?: string; newPassword?: string }>()
    .catch(() => ({ currentPassword: "", newPassword: "" }));
  const cur = body.currentPassword ?? "";
  const next = body.newPassword ?? "";

  const policyError = validatePassword(next);
  if (policyError) return error(policyError);

  if (cur === next) return error("New password must differ from current");

  // Verify current password
  const row = await env.DB.prepare(
    `SELECT password_hash, password_salt FROM users WHERE id = ?`
  ).bind(user.id).first<{ password_hash: string | null; password_salt: string | null }>();
  if (!row || !row.password_hash || !row.password_salt) return error("No password on file", 400);
  const ok = await verifyPassword(cur, row.password_hash, row.password_salt);
  if (!ok) return error("Current password is incorrect", 401);

  // Hash + save new
  const { hash, salt } = await hashPassword(next);
  await env.DB.prepare(
    `UPDATE users SET password_hash = ?, password_salt = ?, must_change_password = 0,
                      updated_at = datetime('now') WHERE id = ?`
  ).bind(hash, salt, user.id).run();

  await logAudit(env, request, user, {
    action: "update",
    entityType: "user",
    entityId: user.id,
    field: "password",
    newValue: "(changed)",
  });

  return json({ ok: true });
};
