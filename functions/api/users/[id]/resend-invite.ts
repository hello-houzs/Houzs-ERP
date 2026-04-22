// POST /api/users/:id/resend-invite — admin resends the invite email
// Generates a fresh temp password (invalidates the old one), pushes expiry +7d.

import { Env, json, error } from "../../../_shared";
import {
  requireAuth, requireRole, hashPassword, generateTempPassword,
  sendEmail, inviteEmailTemplate, logAudit,
} from "../../../_auth";

const EXPIRY_DAYS = 7;

export const onRequestPost: PagesFunction<Env> = async ({ env, request, params }) => {
  const admin = await requireAuth(request, env);
  if (admin instanceof Response) return admin;
  const roleErr = requireRole(admin, "Sales Director");
  if (roleErr) return roleErr;

  const id = params.id as string;
  const user = await env.DB.prepare(
    `SELECT id, name, email FROM users WHERE id = ?`
  ).bind(id).first<{ id: string; name: string; email: string }>();
  if (!user || !user.email) return error("User not found or has no email", 404);

  const tempPw = generateTempPassword(10);
  const { hash, salt } = await hashPassword(tempPw);
  await env.DB.prepare(
    `UPDATE users SET password_hash = ?, password_salt = ?, must_change_password = 1,
                      locked_until = NULL, updated_at = datetime('now') WHERE id = ?`
  ).bind(hash, salt, id).run();

  // Bump the most recent invitation's expiry + resent_count, or create new
  const expiresAt = new Date(Date.now() + EXPIRY_DAYS * 86_400 * 1000).toISOString();
  const existing = await env.DB.prepare(
    `SELECT id FROM invitations WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`
  ).bind(id).first<{ id: string }>();
  if (existing) {
    await env.DB.prepare(
      `UPDATE invitations SET expires_at = ?, used_at = NULL,
                              resent_count = resent_count + 1 WHERE id = ?`
    ).bind(expiresAt, existing.id).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO invitations (id, user_id, invited_by, expires_at)
       VALUES (?, ?, ?, ?)`
    ).bind(crypto.randomUUID(), id, admin.id, expiresAt).run();
  }

  const appUrl = env.APP_URL ?? `https://${new URL(request.url).host}`;
  const tpl = inviteEmailTemplate({
    toName: user.name,
    invitedByName: admin.name,
    tempPassword: tempPw,
    appUrl,
    expiresInDays: EXPIRY_DAYS,
  });
  const emailed = await sendEmail(env, { to: user.email, subject: tpl.subject, html: tpl.html, text: tpl.text });

  await logAudit(env, request, admin, {
    action: "invite_resent",
    entityType: "user",
    entityId: id,
    changes: { emailSent: emailed },
  });

  return json({ ok: true, emailSent: emailed });
};
