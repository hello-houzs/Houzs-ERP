// POST /api/auth/reset-password
//   Body: { token, newPassword }
// Consumes a password_resets token (one-use) and sets the new password.

import { Env, json, error } from "../../_shared";
import { hashPassword, validatePassword, logAudit } from "../../_auth";

export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  const body = await request.json<{ token?: string; newPassword?: string }>()
    .catch(() => ({} as { token?: string; newPassword?: string }));
  const token = body.token ?? "";
  const next = body.newPassword ?? "";
  if (!token) return error("Token required");

  const policyError = validatePassword(next);
  if (policyError) return error(policyError);

  const reset = await env.DB.prepare(
    `SELECT pr.token, pr.user_id, pr.expires_at, pr.used_at,
            u.name, u.email, u.position
       FROM password_resets pr
       JOIN users u ON u.id = pr.user_id
      WHERE pr.token = ? LIMIT 1`
  ).bind(token).first<{
    token: string; user_id: string; expires_at: string; used_at: string | null;
    name: string; email: string; position: string;
  }>();
  if (!reset) return error("Invalid or expired token", 400);
  if (reset.used_at) return error("Token already used", 400);
  if (reset.expires_at < new Date().toISOString()) return error("Token expired", 400);

  const { hash, salt } = await hashPassword(next);
  await env.DB.prepare(
    `UPDATE users SET password_hash = ?, password_salt = ?, must_change_password = 0,
                      locked_until = NULL, updated_at = datetime('now') WHERE id = ?`
  ).bind(hash, salt, reset.user_id).run();
  await env.DB.prepare(`UPDATE password_resets SET used_at = datetime('now') WHERE token = ?`).bind(token).run();

  await logAudit(env, request, {
    id: reset.user_id, email: reset.email, name: reset.name, position: reset.position,
  }, {
    action: "reset_password",
    entityType: "user",
    entityId: reset.user_id,
  });

  return json({ ok: true });
};
