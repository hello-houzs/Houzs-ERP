import { Hono } from "hono";
import { eq, and, sql } from "drizzle-orm";
import type { Env } from "../types";
import { hasPermission } from "../services/permissions";
import { getDb } from "../db/client";
import {
  users,
  departments,
  user_streak_weeks,
  gamify_settings,
} from "../db/schema";
import {
  transfer,
  recentTransactions,
  getLeaderboardCached,
  computeLeaderboard,
  refreshAllLeaderboards,
  recomputeWeeklyStreaks,
  resetMonthlyGifting,
  getSettings,
  adminAdjust,
  type Period,
} from "../services/points";

/**
 * Gamification surface — Houzs Points (mig 055).
 *
 * Open to every authenticated user (no permission gate on the
 * surfaces). Admin endpoints (settings PATCH, manual adjust, force
 * recompute) require the wildcard `*` permission, same convention
 * the codebase uses for service-tier access.
 */

const app = new Hono<{ Bindings: Env }>();

// ── GET /api/gamify/me ──────────────────────────────────────────
// Aggregated personal snapshot for the gamification page header
// and the topbar chip. One round-trip; cheap.
app.get("/me", async (c) => {
  const user = c.get("user");
  const db = getDb(c.env);

  const me = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      department_id: users.department_id,
      points_balance: users.points_balance,
      gifting_balance: users.gifting_balance,
      current_streak: users.current_streak,
      gifting_reset_at: users.gifting_reset_at,
    })
    .from(users)
    .where(eq(users.id, user.id))
    .get();

  if (!me) return c.json({ error: "User not found" }, 404);

  // Today's earnings — sum of positive deltas since 00:00 UTC.
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const { results: todayRows } = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(CASE WHEN delta > 0 THEN delta ELSE 0 END), 0) AS earned_today
       FROM point_transactions
      WHERE user_id = ? AND pool = 'earned' AND created_at >= ?`,
  )
    .bind(user.id, startOfDay.toISOString())
    .all<{ earned_today: number }>();

  // Personal rank in the company-wide all-time leaderboard.
  const top = await getLeaderboardCached(c.env, "company", "all");
  const rank = top.findIndex((r) => r.user_id === user.id);

  return c.json({
    ...me,
    earned_today: todayRows?.[0]?.earned_today ?? 0,
    company_rank: rank >= 0 ? rank + 1 : null,
    leaderboard_size: top.length,
  });
});

// ── GET /api/gamify/leaderboard ─────────────────────────────────
// Query params:
//   scope=company (default) | department:{id} | mine
//   period=week | month | all (default = week)
app.get("/leaderboard", async (c) => {
  const user = c.get("user");
  const periodRaw = (c.req.query("period") || "week") as Period;
  const period: Period =
    periodRaw === "month" || periodRaw === "all" || periodRaw === "week"
      ? periodRaw
      : "week";

  const scopeRaw = c.req.query("scope") || "company";
  let scope: "company" | { department_id: number } = "company";
  if (scopeRaw === "mine") {
    if (!user.department_id) return c.json({ rows: [], scope: "company", period });
    scope = { department_id: user.department_id };
  } else if (scopeRaw.startsWith("department:")) {
    const id = parseInt(scopeRaw.slice("department:".length), 10);
    if (Number.isFinite(id)) scope = { department_id: id };
  }

  const rows = await getLeaderboardCached(c.env, scope, period);
  return c.json({
    rows,
    scope: scope === "company" ? "company" : `department:${scope.department_id}`,
    period,
  });
});

// ── GET /api/gamify/transactions ────────────────────────────────
// Recent ledger entries for the caller. Used by the Activity tab.
app.get("/transactions", async (c) => {
  const user = c.get("user");
  const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 200);
  const rows = await recentTransactions(c.env, user.id, limit);

  // Hydrate counterparty names so the UI doesn't N+1.
  const ids = Array.from(
    new Set(rows.map((r) => r.counterparty_user_id).filter(Boolean) as number[]),
  );
  let nameById: Record<number, string> = {};
  if (ids.length > 0) {
    const list = await c.env.DB.prepare(
      `SELECT id, COALESCE(name, email) AS name FROM users WHERE id IN (${ids.map(() => "?").join(",")})`,
    )
      .bind(...ids)
      .all<{ id: number; name: string }>();
    for (const r of list.results ?? []) nameById[r.id] = r.name;
  }

  return c.json({
    rows: rows.map((r) => ({
      ...r,
      counterparty_name: r.counterparty_user_id
        ? nameById[r.counterparty_user_id] ?? null
        : null,
    })),
  });
});

// ── GET /api/gamify/streak ──────────────────────────────────────
// Returns last 26 weeks for the caller for the heatmap.
app.get("/streak", async (c) => {
  const user = c.get("user");
  const db = getDb(c.env);
  const rows = await db
    .select()
    .from(user_streak_weeks)
    .where(eq(user_streak_weeks.user_id, user.id))
    .orderBy(sql`${user_streak_weeks.iso_week} DESC`)
    .limit(26);
  return c.json({ weeks: rows.reverse(), current_streak: 0 });
});

// ── POST /api/gamify/gift ───────────────────────────────────────
// Body: { to_user_id: number, amount: number, note?: string }
app.post("/gift", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  const to = parseInt(String(body.to_user_id ?? ""), 10);
  const amount = parseInt(String(body.amount ?? ""), 10);
  const note = typeof body.note === "string" ? body.note.slice(0, 280) : undefined;

  if (!Number.isFinite(to) || !Number.isFinite(amount)) {
    return c.json({ error: "to_user_id and amount are required integers" }, 400);
  }

  const result = await transfer(c.env, user.id, to, amount, note);
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json({ ok: true });
});

// ── GET /api/gamify/recipients ──────────────────────────────────
// Active users the caller can gift to (everyone except self). The
// frontend SendPointsButton uses this to populate its picker.
app.get("/recipients", async (c) => {
  const user = c.get("user");
  const q = (c.req.query("q") || "").trim().toLowerCase();
  const list = await c.env.DB.prepare(
    `SELECT u.id, COALESCE(u.name, u.email) AS name, u.email, u.department_id,
            d.name AS department_name
       FROM users u
       LEFT JOIN departments d ON d.id = u.department_id
      WHERE u.status = 'active' AND u.id <> ?
      ORDER BY u.name COLLATE NOCASE ASC`,
  )
    .bind(user.id)
    .all<{
      id: number;
      name: string;
      email: string;
      department_id: number | null;
      department_name: string | null;
    }>();
  let rows = list.results ?? [];
  if (q) {
    rows = rows.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.email.toLowerCase().includes(q) ||
        (r.department_name?.toLowerCase().includes(q) ?? false),
    );
  }
  return c.json({ rows: rows.slice(0, 50) });
});

// ── GET /api/gamify/settings ────────────────────────────────────
// Open read so the frontend can show defaults (gift min/max, monthly
// allowance hint). Mutations require admin.
app.get("/settings", async (c) => {
  const settings = await getSettings(c.env);
  return c.json({ settings });
});

// ── Admin endpoints (gated to wildcard `*` permission) ──────────

function requireAdmin(c: any) {
  const user = c.get("user");
  if (!user || !hasPermission(user.permissions, "*")) {
    return c.json({ error: "Forbidden: admin only" }, 403);
  }
  return null;
}

app.patch("/settings", async (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;
  const body = await c.req.json().catch(() => ({}));
  if (!body || typeof body !== "object") {
    return c.json({ error: "Body must be an object of {key: value}" }, 400);
  }
  const allowed = new Set([
    "monthly_gifting_amount",
    "streak_weekly_threshold",
    "points.innovation_shipped",
    "points.suggestion_approved",
    "points.upvote_received",
    "points.gift_min",
    "points.gift_max",
  ]);
  const stmts: D1PreparedStatement[] = [];
  for (const [k, v] of Object.entries(body)) {
    if (!allowed.has(k)) continue;
    const val = String(v);
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO gamify_settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).bind(k, val),
    );
  }
  if (stmts.length === 0) return c.json({ error: "No allowed keys provided" }, 400);
  await c.env.DB.batch(stmts);
  return c.json({ ok: true, updated: stmts.length });
});

app.post("/admin/adjust", async (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;
  const body = await c.req.json().catch(() => ({}));
  const target = parseInt(String(body.user_id ?? ""), 10);
  const delta = parseInt(String(body.delta ?? ""), 10);
  const reason = typeof body.reason === "string" ? body.reason : "Manual adjust";
  const note = typeof body.note === "string" ? body.note : undefined;
  if (!Number.isFinite(target) || !Number.isFinite(delta) || delta === 0) {
    return c.json({ error: "user_id and non-zero delta are required" }, 400);
  }
  await adminAdjust(c.env, target, delta, reason, note);
  return c.json({ ok: true });
});

app.post("/admin/recompute-streaks", async (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;
  const r = await recomputeWeeklyStreaks(c.env);
  return c.json(r);
});

app.post("/admin/reset-gifting", async (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;
  const r = await resetMonthlyGifting(c.env);
  return c.json(r);
});

app.post("/admin/refresh-leaderboards", async (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;
  const refreshed = await refreshAllLeaderboards(c.env);
  return c.json({ ok: true, refreshed });
});

// ── GET /api/gamify/departments ────────────────────────────────
// Helper for the leaderboard scope picker — returns the list of
// departments with active users so the dropdown only shows real
// options.
app.get("/departments", async (c) => {
  const list = await c.env.DB.prepare(
    `SELECT d.id, d.name, COUNT(u.id) AS member_count
       FROM departments d
       LEFT JOIN users u ON u.department_id = d.id AND u.status = 'active'
      GROUP BY d.id
      ORDER BY d.sort_order ASC, d.name ASC`,
  ).all<{ id: number; name: string; member_count: number }>();
  return c.json({ rows: list.results ?? [] });
});

export default app;
