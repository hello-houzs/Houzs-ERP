import { Hono } from "hono";
import type { Env } from "../types";

const app = new Hono<{ Bindings: Env }>();

/**
 * "Active in the last N seconds" threshold. Two full frontend heartbeat
 * intervals (60s each, see frontend usePresence HEARTBEAT_MS) so a user
 * who just missed one beat (e.g. tab switched, request retried) still
 * appears online.
 */
const ACTIVE_WINDOW_SECONDS = 120;

/**
 * POST /api/presence/heartbeat
 *
 * Bumps the current user's last_seen_at to now. Called by every open
 * browser tab on a 60-second interval (and once on mount). Service
 * accounts (id=0) are skipped — presence is for real humans only.
 */
app.post("/heartbeat", async (c) => {
  const me = c.get("user");
  if (!me || me.id === 0) return c.json({ ok: true });
  await c.env.DB.prepare(
    `UPDATE users SET last_seen_at = datetime('now') WHERE id = ?`
  )
    .bind(me.id)
    .run();
  return c.json({ ok: true });
});

/**
 * GET /api/presence
 *
 * Returns everyone whose last_seen_at is within the active window.
 * The current user is included with a flag so the UI can mark
 * "(you)" without doing a separate /me lookup.
 */
app.get("/", async (c) => {
  const me = c.get("user");
  const cutoff = new Date(Date.now() - ACTIVE_WINDOW_SECONDS * 1000)
    .toISOString()
    // SQLite stores as "YYYY-MM-DD HH:MM:SS" with no timezone marker;
    // strip the trailing 'Z' so the string comparison works.
    .replace("T", " ")
    .slice(0, 19);

  const rows = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.role_id, r.name as role_name, u.last_seen_at
     FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE u.last_seen_at IS NOT NULL
       AND u.last_seen_at >= ?
       AND u.status = 'active'
     ORDER BY u.last_seen_at DESC`
  )
    .bind(cutoff)
    .all<any>();

  const active = (rows.results || []).map((r) => ({
    id: r.id,
    email: r.email,
    name: r.name,
    role_id: r.role_id,
    role_name: r.role_name,
    last_seen_at: r.last_seen_at,
    is_self: me ? r.id === me.id : false,
  }));

  return c.json({
    active,
    count: active.length,
    window_seconds: ACTIVE_WINDOW_SECONDS,
  });
});

export default app;
