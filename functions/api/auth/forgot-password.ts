// POST /api/auth/forgot-password
//   Body: { email }
// Always returns 200 so attackers can't enumerate emails.
// If email maps to a user, we create a password_resets token + email it.

import { Env, json } from "../../_shared";
import {
  generateToken, sendEmail, resetPasswordEmailTemplate, logAudit,
} from "../../_auth";

const TOKEN_TTL_HOURS = 1;

export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  const body = await request.json<{ email?: string }>().catch(() => ({} as { email?: string }));
  const email = (body.email ?? "").trim().toLowerCase();
  if (!email) return json({ ok: true }); // silent

  const user = await env.DB.prepare(
    `SELECT id, name, email, status FROM users WHERE LOWER(email) = ? LIMIT 1`
  ).bind(email).first<{ id: string; name: string; email: string; status: string }>();

  if (user && user.status === "ACTIVE") {
    const token = generateToken(32);
    const expires = new Date(Date.now() + TOKEN_TTL_HOURS * 3600 * 1000).toISOString();
    await env.DB.prepare(
      `INSERT INTO password_resets (token, user_id, expires_at, ip_address)
       VALUES (?, ?, ?, ?)`
    ).bind(token, user.id, expires, request.headers.get("CF-Connecting-IP") ?? null).run();

    const appUrl = env.APP_URL ?? `https://${new URL(request.url).host}`;
    const resetUrl = `${appUrl}/reset-password?token=${token}`;
    const tpl = resetPasswordEmailTemplate({
      toName: user.name,
      resetUrl,
      expiresInHours: TOKEN_TTL_HOURS,
    });
    await sendEmail(env, { to: user.email, subject: tpl.subject, html: tpl.html, text: tpl.text });

    await logAudit(env, request, null, {
      action: "reset_password_requested",
      entityType: "user",
      entityId: user.id,
    });
  }

  // Always 200 — don't leak whether email exists
  return json({ ok: true });
};
