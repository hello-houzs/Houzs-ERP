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

export default app;
