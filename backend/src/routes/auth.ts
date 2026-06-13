import { Hono } from "hono";
import type { Env } from "../types";
import {
  hashPassword,
  verifyPassword,
  createSession,
  deleteSession,
  pruneExpiredSessions,
  getUserBySession,
  generateToken,
  isoIn,
} from "../services/auth";
import { sendEmail, publicUrl, resetEmailHtml } from "../services/email";
import { validatePasswordStrength } from "../services/passwordStrength";
import { checkRateLimit, clearRateLimit, clientIp } from "../middleware/rateLimit";

/**
 * Auth routes — UNAUTHENTICATED entry points.
 *
 * Mounted at /api/auth/* OUTSIDE the auth middleware so unauthenticated
 * users can hit /login, /bootstrap, /accept-invite. /me and /logout
 * require a valid bearer token.
 */
const app = new Hono<{ Bindings: Env }>();

const RESET_TTL_SECONDS = 60 * 60; // matches the admin-initiated reset

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
  const strength = validatePasswordStrength(body.password, body.email);
  if (!strength.ok) return c.json({ error: strength.error }, 400);

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
  const email = body.email.toLowerCase().trim();

  // Brute-force speed bump: 10 attempts / 15 min per email+IP. Fail-open.
  const rlKey = `${email}:${clientIp(c)}`;
  const limited = await checkRateLimit(c, "login", rlKey);
  if (limited) return limited;

  const user = await c.env.DB.prepare(
    `SELECT id, password_hash, status FROM users WHERE email = ?`
  )
    .bind(email)
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

  // Clear the counter on success so a user doesn't carry failed attempts.
  await clearRateLimit(c, "login", rlKey);
  const token = await createSession(c.env, user.id);
  return c.json({ token, user_id: user.id });
});

/**
 * POST /api/auth/forgot-password
 * Public — the self-service half of the reset flow (mig 027 reserved
 * `requested_by = NULL` for exactly this). Anti-enumeration: always
 * answers 200 {ok} whether or not the email maps to an account, and a
 * per-user cooldown (1 request / 5 min) bounds outbound email volume.
 * Sessions are NOT revoked here — only the consume endpoint below does
 * that, once the requester has proven control of the mailbox.
 */
app.post("/forgot-password", async (c) => {
  const body = await c.req
    .json<{ email?: string }>()
    .catch(() => ({} as { email?: string }));
  const email = String(body.email || "").toLowerCase().trim();
  const done = () => c.json({ ok: true });
  if (!email || !email.includes("@")) return done();

  // Per-email rate limit (5 / 15 min). Anti-enumeration: when over the cap we
  // return the same {ok} instead of a 429, so it never reveals which emails
  // exist. Stacks with the 5-min per-user cooldown below.
  if (await checkRateLimit(c, "forgot", email, 5, 900)) return done();

  const user = await c.env.DB.prepare(
    `SELECT id, email, name FROM users WHERE email = ? AND status = 'active'`
  )
    .bind(email)
    .first<{ id: number; email: string; name: string | null }>();
  if (!user) return done();

  // Cooldown — skip silently if a reset was issued in the last 5 min.
  const last = await c.env.DB.prepare(
    `SELECT created_at FROM password_resets
      WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`
  )
    .bind(user.id)
    .first<{ created_at: string | null }>();
  if (last?.created_at) {
    const cutoff = new Date(Date.now() - 5 * 60 * 1000)
      .toISOString()
      .slice(0, 19)
      .replace("T", " ");
    if (String(last.created_at).replace("T", " ") > cutoff) return done();
  }

  await c.env.DB.prepare(
    `UPDATE password_resets SET consumed_at = datetime('now')
      WHERE user_id = ? AND consumed_at IS NULL`
  )
    .bind(user.id)
    .run();

  const token = generateToken();
  const expiresAt = isoIn(RESET_TTL_SECONDS);
  await c.env.DB.prepare(
    `INSERT INTO password_resets (user_id, token, requested_by, expires_at)
     VALUES (?, ?, NULL, ?)`
  )
    .bind(user.id, token, expiresAt)
    .run();

  const name = (user.name || user.email.split("@")[0]).split(" ")[0];
  await sendEmail(c.env, {
    to: user.email,
    subject: "Reset your Houzs ERP password",
    html: resetEmailHtml({
      name,
      link: publicUrl(c.env, `/reset/${token}`),
      expiresIn: "1 hour",
      requestedBy: null,
    }),
    purpose: "password_reset",
    refType: "user",
    refId: user.id,
  });
  return done();
});

/**
 * GET /api/auth/invite/:token
 * Public preflight — lets the accept screen show "You're invited as
 * <role>" and pre-fill the email + any name preset at invite time.
 */
app.get("/invite/:token", async (c) => {
  const token = c.req.param("token");
  if (!token) return c.json({ error: "Bad token" }, 400);
  const row = await c.env.DB.prepare(
    `SELECT i.email, i.expires_at, i.accepted_at,
            r.name AS role_name,
            u.name AS name
       FROM invitations i
       JOIN roles r ON r.id = i.role_id
       LEFT JOIN users u ON u.email = i.email
      WHERE i.token = ?`
  )
    .bind(token)
    .first<{
      email: string;
      expires_at: string;
      accepted_at: string | null;
      role_name: string;
      name: string | null;
    }>();
  if (!row) return c.json({ error: "Invalid or expired invitation" }, 404);
  if (row.accepted_at) {
    return c.json({ error: "This invitation has already been used" }, 409);
  }
  if (row.expires_at < new Date().toISOString()) {
    return c.json({ error: "Invitation has expired" }, 410);
  }
  return c.json({ email: row.email, name: row.name, role_name: row.role_name });
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

  // Strength gate runs after the invite lookup so the email local-part
  // rule can apply ("password can't contain your email name").
  const strength = validatePasswordStrength(body.password, inv.email);
  if (!strength.ok) return c.json({ error: strength.error }, 400);

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
  if (!body.password) {
    return c.json({ error: "password is required" }, 400);
  }
  const row = await c.env.DB.prepare(
    `SELECT pr.id, pr.user_id, pr.expires_at, pr.consumed_at, u.email
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
    }>();
  if (!row) return c.json({ error: "Invalid or expired link" }, 404);
  if (row.consumed_at) return c.json({ error: "This link has already been used" }, 410);
  if (row.expires_at < new Date().toISOString()) {
    return c.json({ error: "This link has expired" }, 410);
  }
  const strength = validatePasswordStrength(body.password, row.email);
  if (!strength.ok) return c.json({ error: strength.error }, 400);
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
  const strength = validatePasswordStrength(body.next, auth.user.email);
  if (!strength.ok) return c.json({ error: strength.error }, 400);
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
