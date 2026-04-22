// POST /api/auth/login
//   Body: { email, password }
//   Returns: { user } + Set-Cookie: houzs_session=<jwt>
//
// Rate limiting: 5 failed attempts in 15 min → account locked for 15 min.

import { Env, json, error } from "../../_shared";
import {
  verifyPassword, signJWT, setAuthCookie, logAudit,
} from "../../_auth";

interface LoginBody { email?: string; password?: string; }

export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  const body = await request.json<LoginBody>().catch(() => ({} as LoginBody));
  const email = (body.email ?? "").trim().toLowerCase();
  const password = body.password ?? "";
  if (!email || !password) return error("Email and password required");

  const ip = request.headers.get("CF-Connecting-IP") ?? null;
  const ua = request.headers.get("User-Agent") ?? null;

  // 1. Lookup user by email
  const user = await env.DB.prepare(
    `SELECT id, name, email, position, status, password_hash, password_salt,
            must_change_password, locked_until
       FROM users WHERE LOWER(email) = ? LIMIT 1`
  ).bind(email).first<{
    id: string; name: string; email: string; position: string; status: string;
    password_hash: string | null; password_salt: string | null;
    must_change_password: number; locked_until: string | null;
  }>();

  if (!user) {
    await recordAttempt(env, email, null, ip, ua, 0, "no_user");
    return error("Invalid email or password", 401);
  }

  // 2. Account state checks
  if (user.status === "INACTIVE") {
    await recordAttempt(env, email, user.id, ip, ua, 0, "disabled");
    return error("Account is disabled. Contact your administrator.", 403);
  }
  if (user.locked_until && user.locked_until > new Date().toISOString()) {
    await recordAttempt(env, email, user.id, ip, ua, 0, "locked");
    return error("Account temporarily locked due to repeated failed logins. Try again later.", 429);
  }
  if (!user.password_hash || !user.password_salt) {
    await recordAttempt(env, email, user.id, ip, ua, 0, "no_password");
    return error("No password set. Ask admin to send an invite, or use Forgot Password.", 403);
  }

  // 3. Rate limit — how many recent failed attempts?
  const recent = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM login_attempts
       WHERE email = ? AND success = 0
         AND timestamp >= datetime('now', '-15 minutes')`
  ).bind(email).first<{ n: number }>();
  if (recent && recent.n >= 5) {
    const lockUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    await env.DB.prepare(`UPDATE users SET locked_until = ? WHERE id = ?`).bind(lockUntil, user.id).run();
    await recordAttempt(env, email, user.id, ip, ua, 0, "rate_limited");
    return error("Too many failed attempts. Account locked for 15 minutes.", 429);
  }

  // 4. Verify password
  const ok = await verifyPassword(password, user.password_hash, user.password_salt);
  if (!ok) {
    await recordAttempt(env, email, user.id, ip, ua, 0, "wrong_password");
    await logAudit(env, request, null, {
      action: "login_failed",
      entityType: "user",
      entityId: user.id,
      field: "reason",
      newValue: "wrong_password",
    });
    return error("Invalid email or password", 401);
  }

  // 5. Success — issue JWT, set cookie, update last_login, clear lock
  const token = await signJWT(
    { sub: user.id, email: user.email, name: user.name, position: user.position },
    env.JWT_SECRET,
  );
  await env.DB.prepare(
    `UPDATE users SET last_login = datetime('now'), locked_until = NULL WHERE id = ?`
  ).bind(user.id).run();
  await recordAttempt(env, email, user.id, ip, ua, 1, null);
  await logAudit(env, request, { id: user.id, email: user.email, name: user.name, position: user.position }, {
    action: "login",
    entityType: "user",
    entityId: user.id,
  });

  return new Response(JSON.stringify({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      position: user.position,
      mustChangePassword: !!user.must_change_password,
    },
  }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": setAuthCookie(token),
      "Cache-Control": "no-store",
    },
  });
};

async function recordAttempt(
  env: Env, email: string, userId: string | null,
  ip: string | null, ua: string | null,
  success: 0 | 1, reason: string | null,
) {
  try {
    await env.DB.prepare(
      `INSERT INTO login_attempts (email, user_id, ip_address, user_agent, success, reason)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(email, userId, ip, ua, success, reason).run();
  } catch (e) {
    console.warn("[login] recordAttempt failed:", e);
  }
}
