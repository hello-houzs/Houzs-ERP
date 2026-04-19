import { Hono } from "hono";
import type { Env } from "../types";
import {
  hashPassword,
  verifyPassword,
  createSession,
  deleteSession,
  pruneExpiredSessions,
  getUserBySession,
} from "../services/auth";

/**
 * Auth routes — UNAUTHENTICATED entry points.
 *
 * Mounted at /api/auth/* OUTSIDE the auth middleware so unauthenticated
 * users can hit /login, /bootstrap, /accept-invite. /me and /logout
 * require a valid bearer token.
 */
const app = new Hono<{ Bindings: Env }>();

/**
 * GET /api/auth/status
 * Public — used by the frontend to decide whether to show the login or
 * the bootstrap (first-owner) screen.
 */
app.get("/status", async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM users WHERE status = 'active'`
  ).first<{ count: number }>();
  return c.json({ has_users: (row?.count || 0) > 0 });
});

/**
 * POST /api/auth/bootstrap
 * Public — only works when there are zero active users. Creates the
 * first Owner. Anyone calling this endpoint after the first user
 * exists gets a 409.
 */
app.post("/bootstrap", async (c) => {
  const existing = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM users WHERE status = 'active'`
  ).first<{ count: number }>();
  if ((existing?.count || 0) > 0) {
    return c.json({ error: "Bootstrap is closed — an owner already exists" }, 409);
  }

  const body = await c.req.json<{ email: string; name?: string; password: string }>();
  if (!body.email || !body.password) {
    return c.json({ error: "email and password are required" }, 400);
  }
  if (body.password.length < 8) {
    return c.json({ error: "password must be at least 8 characters" }, 400);
  }

  const ownerRole = await c.env.DB.prepare(
    `SELECT id FROM roles WHERE name = 'Owner'`
  ).first<{ id: number }>();
  if (!ownerRole) return c.json({ error: "Owner role missing — run schema migrations" }, 500);

  const hash = await hashPassword(body.password);
  const result = await c.env.DB.prepare(
    `INSERT INTO users (email, name, password_hash, role_id, status, joined_at)
     VALUES (?, ?, ?, ?, 'active', datetime('now'))`
  )
    .bind(body.email.toLowerCase().trim(), body.name?.trim() || null, hash, ownerRole.id)
    .run();

  const userId = result.meta.last_row_id as number;
  const token = await createSession(c.env, userId);
  return c.json({ token, user_id: userId });
});

/**
 * POST /api/auth/login
 * Public — exchanges email + password for a session token.
 */
app.post("/login", async (c) => {
  const body = await c.req.json<{ email: string; password: string }>();
  if (!body.email || !body.password) {
    return c.json({ error: "email and password are required" }, 400);
  }

  const user = await c.env.DB.prepare(
    `SELECT id, password_hash, status FROM users WHERE email = ?`
  )
    .bind(body.email.toLowerCase().trim())
    .first<{ id: number; password_hash: string; status: string }>();

  if (!user || !user.password_hash) {
    return c.json({ error: "Invalid credentials" }, 401);
  }
  if (user.status !== "active") {
    return c.json({ error: "Account is disabled" }, 403);
  }

  const ok = await verifyPassword(body.password, user.password_hash);
  if (!ok) return c.json({ error: "Invalid credentials" }, 401);

  await c.env.DB.prepare(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`)
    .bind(user.id)
    .run();

  const token = await createSession(c.env, user.id);
  return c.json({ token, user_id: user.id });
});

/**
 * POST /api/auth/accept-invite
 * Public — exchanges an invitation token + name + password for a new
 * active user + session.
 */
app.post("/accept-invite", async (c) => {
  const body = await c.req.json<{
    token: string;
    name?: string;
    password: string;
  }>();
  if (!body.token || !body.password) {
    return c.json({ error: "token and password are required" }, 400);
  }
  if (body.password.length < 8) {
    return c.json({ error: "password must be at least 8 characters" }, 400);
  }

  const inv = await c.env.DB.prepare(
    `SELECT id, email, role_id, expires_at, accepted_at
     FROM invitations WHERE token = ?`
  )
    .bind(body.token)
    .first<{
      id: number;
      email: string;
      role_id: number;
      expires_at: string;
      accepted_at: string | null;
    }>();
  if (!inv) return c.json({ error: "Invalid or expired invitation" }, 404);
  if (inv.accepted_at) {
    return c.json({ error: "This invitation has already been used" }, 409);
  }
  if (inv.expires_at < new Date().toISOString()) {
    return c.json({ error: "Invitation has expired" }, 410);
  }

  const hash = await hashPassword(body.password);

  // Promote the placeholder user (created at invite time) to active.
  const userResult = await c.env.DB.prepare(
    `UPDATE users
     SET name = COALESCE(?, name),
         password_hash = ?,
         status = 'active',
         joined_at = datetime('now'),
         role_id = ?
     WHERE email = ? AND status = 'invited'`
  )
    .bind(body.name?.trim() || null, hash, inv.role_id, inv.email)
    .run();

  if (!userResult.meta.changes) {
    return c.json({ error: "No matching invited user — invitation is stale" }, 410);
  }

  const user = await c.env.DB.prepare(
    `SELECT id FROM users WHERE email = ?`
  )
    .bind(inv.email)
    .first<{ id: number }>();
  if (!user) return c.json({ error: "User lookup failed" }, 500);

  await c.env.DB.prepare(
    `UPDATE invitations SET accepted_at = datetime('now') WHERE id = ?`
  )
    .bind(inv.id)
    .run();

  const token = await createSession(c.env, user.id);
  return c.json({ token, user_id: user.id });
});

/**
 * POST /api/auth/logout
 * Authenticated — invalidates the caller's session.
 */
app.post("/logout", async (c) => {
  const header = c.req.header("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (token) await deleteSession(c.env, token);
  return c.json({ ok: true });
});

/**
 * GET /api/auth/me
 * Authenticated — returns the current user + permissions.
 */
app.get("/me", async (c) => {
  const header = c.req.header("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return c.json({ error: "Unauthorized" }, 401);

  // Legacy shared key — service identity, no DB lookup.
  if (c.env.DASHBOARD_API_KEY && token === c.env.DASHBOARD_API_KEY) {
    return c.json({
      user: {
        id: 0,
        email: "service@local",
        name: "Service",
        role_id: 0,
        role_name: "Service",
        status: "active",
        permissions: ["*"],
      },
    });
  }

  const user = await getUserBySession(c.env, token);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  // Cheap opportunistic prune — keeps the sessions table small.
  await pruneExpiredSessions(c.env);

  return c.json({ user });
});

/**
 * GET /api/auth/reset/:token
 * Public — verifies a reset token and returns the email it's for so
 * the reset page can show "Reset password for alice@…".
 */
app.get("/reset/:token", async (c) => {
  const token = c.req.param("token");
  if (!token) return c.json({ error: "Bad token" }, 400);
  const row = await c.env.DB.prepare(
    `SELECT pr.id, pr.user_id, pr.expires_at, pr.consumed_at,
            u.email, u.name
       FROM password_resets pr
       JOIN users u ON u.id = pr.user_id
      WHERE pr.token = ?`
  )
    .bind(token)
    .first<{
      id: number;
      user_id: number;
      expires_at: string;
      consumed_at: string | null;
      email: string;
      name: string | null;
    }>();
  if (!row) return c.json({ error: "Invalid or expired link" }, 404);
  if (row.consumed_at) return c.json({ error: "This link has already been used" }, 410);
  if (row.expires_at < new Date().toISOString()) {
    return c.json({ error: "This link has expired" }, 410);
  }
  return c.json({ email: row.email, name: row.name });
});

/**
 * POST /api/auth/reset/:token
 * Public — consumes the token, sets a new password hash, invalidates
 * prior sessions. Does NOT auto-log-in; the user goes back to the
 * login page so they verify the new password works.
 */
app.post("/reset/:token", async (c) => {
  const token = c.req.param("token");
  const body = await c.req.json<{ password: string }>();
  if (!token) return c.json({ error: "Bad token" }, 400);
  if (!body.password || body.password.length < 8) {
    return c.json({ error: "password must be at least 8 characters" }, 400);
  }
  const row = await c.env.DB.prepare(
    `SELECT id, user_id, expires_at, consumed_at
       FROM password_resets WHERE token = ?`
  )
    .bind(token)
    .first<{ id: number; user_id: number; expires_at: string; consumed_at: string | null }>();
  if (!row) return c.json({ error: "Invalid or expired link" }, 404);
  if (row.consumed_at) return c.json({ error: "This link has already been used" }, 410);
  if (row.expires_at < new Date().toISOString()) {
    return c.json({ error: "This link has expired" }, 410);
  }
  const hash = await hashPassword(body.password);
  await c.env.DB.prepare(
    `UPDATE users SET password_hash = ? WHERE id = ?`
  )
    .bind(hash, row.user_id)
    .run();
  await c.env.DB.prepare(
    `UPDATE password_resets SET consumed_at = datetime('now') WHERE id = ?`
  )
    .bind(row.id)
    .run();
  // Belt + braces: kill any remaining sessions.
  await c.env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(row.user_id).run();
  return c.json({ ok: true });
});

// /api/auth/* lives outside the global auth middleware so login etc
// are reachable pre-auth. /me endpoints need to pull the token manually
// — same pattern as the existing GET /me below.
async function requireAuthed(c: any) {
  const header = c.req.header("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return { error: "Unauthorized" as const, token: "" };
  const user = await getUserBySession(c.env, token);
  if (!user) return { error: "Unauthorized" as const, token: "" };
  return { user, token };
}

/**
 * PATCH /api/auth/me
 * Authenticated — lets the signed-in user edit their own display name.
 * Email + role are NOT editable here (privileged operations).
 */
app.patch("/me", async (c) => {
  const auth = await requireAuthed(c);
  if ("error" in auth) return c.json({ error: auth.error }, 401);
  const body = await c.req.json<{ name?: string }>();
  const sets: string[] = [];
  const binds: any[] = [];
  if (body.name != null) {
    sets.push("name = ?");
    binds.push(body.name.trim() || null);
  }
  if (!sets.length) return c.json({ error: "No fields to update" }, 400);
  binds.push(auth.user.id);
  await c.env.DB.prepare(
    `UPDATE users SET ${sets.join(", ")} WHERE id = ?`
  )
    .bind(...binds)
    .run();
  return c.json({ ok: true });
});

/**
 * POST /api/auth/me/password
 * Authenticated — user changes their own password. Requires current
 * password to prove possession of the account (defends against a
 * stolen session token being used to lock the owner out).
 */
app.post("/me/password", async (c) => {
  const auth = await requireAuthed(c);
  if ("error" in auth) return c.json({ error: auth.error }, 401);
  const body = await c.req.json<{ current: string; next: string }>();
  if (!body.current || !body.next) {
    return c.json({ error: "current and next are required" }, 400);
  }
  if (body.next.length < 8) {
    return c.json({ error: "new password must be at least 8 characters" }, 400);
  }
  const row = await c.env.DB.prepare(
    `SELECT password_hash FROM users WHERE id = ?`
  )
    .bind(auth.user.id)
    .first<{ password_hash: string }>();
  if (!row?.password_hash) return c.json({ error: "No password on file" }, 400);
  const ok = await verifyPassword(body.current, row.password_hash);
  if (!ok) return c.json({ error: "Current password is incorrect" }, 403);
  const next = await hashPassword(body.next);
  await c.env.DB.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`)
    .bind(next, auth.user.id)
    .run();
  // Keep the current session alive — caller just proved they know the
  // old password. Revoke OTHER sessions on the account as a defensive
  // measure (if the old password was compromised elsewhere).
  await c.env.DB.prepare(
    `DELETE FROM sessions WHERE user_id = ? AND token != ?`
  )
    .bind(auth.user.id, auth.token)
    .run();
  return c.json({ ok: true });
});

export default app;
