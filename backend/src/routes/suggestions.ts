import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import type { Env } from "../types";
import { hasPermission } from "../services/permissions";
import { getDb } from "../db/client";
import { suggestions } from "../db/schema";
import { award as awardPoints, getSettingNumber } from "../services/points";

/**
 * Suggestion box (Phase 3, mig 057).
 *
 * Operational fixes — shorter shape than innovations (title + optional
 * one-line body). Status flow: review -> approved -> declined.
 * Approval awards points.suggestion_approved (default 50).
 *
 * Open to all auth'd users for read/submit/vote. Decision endpoint
 * gated by `*`.
 */

const app = new Hono<{ Bindings: Env }>();

function isAdmin(user: any): boolean {
  return !!user && hasPermission(user.permissions, "*");
}

interface ListRow {
  id: number;
  user_id: number;
  user_name: string | null;
  user_email: string | null;
  user_profile_pic_r2_key: string | null;
  title: string;
  body: string | null;
  status: string;
  decided_by: number | null;
  decided_at: string | null;
  decline_reason: string | null;
  created_at: string | null;
  vote_count: number;
  has_voted: number;
  comment_count: number;
  cover_attachment_id: number | null;
}

// ── GET /api/suggestions ────────────────────────────────────────
app.get("/", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const status = c.req.query("status");

  const rows = await c.env.DB.prepare(
    `SELECT s.id, s.user_id, u.name AS user_name,
            u.email AS user_email,
            u.profile_pic_r2_key AS user_profile_pic_r2_key,
            s.title, s.body, s.status,
            s.decided_by, s.decided_at, s.decline_reason, s.created_at,
            (SELECT COUNT(*) FROM votes v
              WHERE v.target_type = 'suggestion' AND v.target_id = s.id) AS vote_count,
            (SELECT COUNT(*) FROM votes v
              WHERE v.target_type = 'suggestion' AND v.target_id = s.id
                AND v.user_id = ?) AS has_voted,
            (SELECT COUNT(*) FROM idea_comments ic
              WHERE ic.target_type = 'suggestion' AND ic.target_id = s.id
                AND ic.archived_at IS NULL) AS comment_count,
            (SELECT ia.id FROM idea_attachments ia
              WHERE ia.target_type = 'suggestion' AND ia.target_id = s.id
                AND ia.archived_at IS NULL
              ORDER BY ia.id ASC
              LIMIT 1) AS cover_attachment_id
       FROM suggestions s
       LEFT JOIN users u ON u.id = s.user_id
      WHERE s.archived_at IS NULL${status ? " AND s.status = ?" : ""}
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT 200`,
  )
    .bind(...(status ? [user.id, status] : [user.id]))
    .all<ListRow>();

  return c.json({ rows: rows.results ?? [] });
});

// ── POST /api/suggestions ───────────────────────────────────────
app.post("/", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const body = await c.req.json<{ title?: string; body?: string }>();
  const title = (body.title || "").trim();
  if (!title) return c.json({ error: "Title is required" }, 400);

  const db = getDb(c.env);
  const inserted = await db
    .insert(suggestions)
    .values({
      user_id: user.id,
      title,
      body: body.body?.trim() || null,
    })
    .returning()
    .then((r) => r[0]);
  return c.json({ row: inserted });
});

// ── GET /api/suggestions/:id ────────────────────────────────────
app.get("/:id", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const id = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(id)) return c.json({ error: "Bad id" }, 400);

  const row = await c.env.DB.prepare(
    `SELECT s.id, s.user_id, u.name AS user_name,
            u.email AS user_email,
            u.profile_pic_r2_key AS user_profile_pic_r2_key,
            s.title, s.body, s.status,
            s.decided_by, du.name AS decided_by_name,
            s.decided_at, s.decline_reason, s.created_at, s.awarded_at,
            (SELECT COUNT(*) FROM votes v
              WHERE v.target_type = 'suggestion' AND v.target_id = s.id) AS vote_count,
            (SELECT COUNT(*) FROM votes v
              WHERE v.target_type = 'suggestion' AND v.target_id = s.id
                AND v.user_id = ?) AS has_voted,
            (SELECT COUNT(*) FROM idea_comments ic
              WHERE ic.target_type = 'suggestion' AND ic.target_id = s.id
                AND ic.archived_at IS NULL) AS comment_count,
            (SELECT ia.id FROM idea_attachments ia
              WHERE ia.target_type = 'suggestion' AND ia.target_id = s.id
                AND ia.archived_at IS NULL
              ORDER BY ia.id ASC
              LIMIT 1) AS cover_attachment_id
       FROM suggestions s
       LEFT JOIN users u  ON u.id = s.user_id
       LEFT JOIN users du ON du.id = s.decided_by
      WHERE s.id = ? AND s.archived_at IS NULL`,
  )
    .bind(user.id, id)
    .first();
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json({ row });
});

// ── PATCH /api/suggestions/:id ──────────────────────────────────
app.patch("/:id", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const id = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(id)) return c.json({ error: "Bad id" }, 400);

  const db = getDb(c.env);
  const row = await db
    .select()
    .from(suggestions)
    .where(eq(suggestions.id, id))
    .then((r) => r[0]);
  if (!row) return c.json({ error: "Not found" }, 404);

  if (row.archived_at) return c.json({ error: "Not found" }, 404);
  if (row.user_id !== user.id) {
    return c.json({ error: "Only the author can edit this post" }, 403);
  }
  if (row.status !== "review") {
    return c.json({ error: "Can only edit while under review" }, 409);
  }

  const body = await c.req.json<{ title?: string; body?: string | null }>();
  const patch: Record<string, unknown> = {};
  if (typeof body.title === "string") {
    const t = body.title.trim();
    if (!t) return c.json({ error: "Title is required" }, 400);
    patch.title = t;
  }
  if (body.body !== undefined) {
    patch.body = body.body === null ? null : String(body.body).trim() || null;
  }
  if (Object.keys(patch).length === 0) return c.json({ row });

  const updated = await db
    .update(suggestions)
    .set(patch)
    .where(eq(suggestions.id, id))
    .returning()
    .then((r) => r[0]);
  return c.json({ row: updated });
});

// ── POST /api/suggestions/:id/vote ──────────────────────────────
app.post("/:id/vote", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const id = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(id)) return c.json({ error: "Bad id" }, 400);

  const db = getDb(c.env);
  const target = await db
    .select({ user_id: suggestions.user_id })
    .from(suggestions)
    .where(eq(suggestions.id, id))
    .then((r) => r[0]);
  if (!target) return c.json({ error: "Not found" }, 404);
  if (target.user_id === user.id) {
    return c.json({ error: "You cannot vote on your own post" }, 400);
  }

  try {
    await c.env.DB.prepare(
      `INSERT INTO votes (target_type, target_id, user_id)
         VALUES ('suggestion', ?, ?)`,
    )
      .bind(id, user.id)
      .run();
  } catch {
    return c.json({ error: "Already voted" }, 409);
  }

  // Idempotent on (voter, target) — see innovations route for rationale.
  const prior = await c.env.DB.prepare(
    `SELECT 1 FROM point_transactions
       WHERE reason = 'upvote_received'
         AND ref_type = 'suggestion'
         AND ref_id = ?
         AND counterparty_user_id = ?
       LIMIT 1`,
  )
    .bind(id, user.id)
    .first();

  // Per-author daily upvote cap — see innovations route for rationale.
  const dailyCap = await getSettingNumber(
    c.env,
    "points.upvote_daily_cap_per_author",
    20,
  );
  const todayRow = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM point_transactions
       WHERE user_id = ?
         AND reason = 'upvote_received'
         AND created_at >= datetime('now', '-1 day')`,
  )
    .bind(target.user_id)
    .first<{ n: number }>();
  const cappedOut = (todayRow?.n ?? 0) >= dailyCap;

  if (!prior && !cappedOut) {
    const upvotePoints = await getSettingNumber(c.env, "points.upvote_received", 5);
    await awardPoints(c.env, target.user_id, "upvote_received", upvotePoints, {
      ref_type: "suggestion",
      ref_id: id,
      counterparty_user_id: user.id,
    });
  }
  return c.json({ ok: true });
});

// ── GET /api/suggestions/:id/voters ─────────────────────────────
app.get("/:id/voters", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const id = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(id)) return c.json({ error: "Bad id" }, 400);

  const rows = await c.env.DB.prepare(
    `SELECT u.id   AS user_id,
            u.name AS user_name,
            u.email AS user_email,
            u.profile_pic_r2_key AS user_profile_pic_r2_key,
            v.created_at AS voted_at
       FROM votes v
       JOIN users u ON u.id = v.user_id
      WHERE v.target_type = 'suggestion' AND v.target_id = ?
      ORDER BY v.created_at DESC`,
  )
    .bind(id)
    .all();
  return c.json({ rows: rows.results ?? [] });
});

// ── DELETE /api/suggestions/:id/vote ────────────────────────────
app.delete("/:id/vote", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const id = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(id)) return c.json({ error: "Bad id" }, 400);
  await c.env.DB.prepare(
    `DELETE FROM votes
      WHERE target_type = 'suggestion' AND target_id = ? AND user_id = ?`,
  )
    .bind(id, user.id)
    .run();
  return c.json({ ok: true });
});

// ── POST /api/suggestions/:id/decision ──────────────────────────
app.post("/:id/decision", async (c) => {
  const user = c.get("user");
  if (!isAdmin(user)) return c.json({ error: "Forbidden" }, 403);
  const id = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(id)) return c.json({ error: "Bad id" }, 400);
  const body = await c.req.json<{
    status: "review" | "approved" | "declined";
    decline_reason?: string;
  }>();
  const allowed = ["review", "approved", "declined"];
  if (!allowed.includes(body.status)) {
    return c.json({ error: "Bad status" }, 400);
  }

  const db = getDb(c.env);
  const target = await db
    .select()
    .from(suggestions)
    .where(eq(suggestions.id, id))
    .then((r) => r[0]);
  if (!target) return c.json({ error: "Not found" }, 404);

  const updated = await db
    .update(suggestions)
    .set({
      status: body.status,
      decided_by: user!.id,
      decided_at: sql`to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS')`,
      decline_reason:
        body.status === "declined" ? body.decline_reason ?? null : null,
    })
    .where(eq(suggestions.id, id))
    .returning()
    .then((r) => r[0]);

  if (body.status === "approved" && !target.awarded_at) {
    const amount = await getSettingNumber(
      c.env,
      "points.suggestion_approved",
      50,
    );
    await awardPoints(c.env, target.user_id, "suggestion_approved", amount, {
      ref_type: "suggestion",
      ref_id: id,
      note: target.title,
    });
    await db
      .update(suggestions)
      .set({ awarded_at: sql`to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS')` })
      .where(eq(suggestions.id, id));
  }

  return c.json({ row: updated });
});

// ── DELETE /api/suggestions/:id ─────────────────────────────────
// Soft-archive. Owner OR `*` admin.
app.delete("/:id", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const id = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(id)) return c.json({ error: "Bad id" }, 400);

  const db = getDb(c.env);
  const row = await db
    .select()
    .from(suggestions)
    .where(eq(suggestions.id, id))
    .then((r) => r[0]);
  if (!row || row.archived_at) return c.json({ error: "Not found" }, 404);

  if (row.user_id !== user.id && !isAdmin(user)) {
    return c.json({ error: "Forbidden" }, 403);
  }

  await db
    .update(suggestions)
    .set({ archived_at: sql`to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS')` })
    .where(eq(suggestions.id, id));
  return c.json({ ok: true });
});

export default app;
