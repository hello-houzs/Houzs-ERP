import { Hono } from "hono";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Env } from "../types";
import { hasPermission } from "../services/permissions";
import { getDb } from "../db/client";
import { innovations, users, votes } from "../db/schema";
import { award as awardPoints, getSettingNumber } from "../services/points";

/**
 * Innovation box (Phase 3, mig 057).
 *
 * Strategic ideas with a 5-step status pipeline. The submitter earns
 * points.innovation_shipped (default 500) when status reaches
 * 'shipped' — recorded once via `awarded_at` so re-entering the
 * status doesn't duplicate.
 *
 * Open to all auth'd users for read/submit/vote. Decision endpoints
 * gated by `*` to keep triage to admins until a manage permission
 * is added later.
 */

const app = new Hono<{ Bindings: Env }>();

function isAdmin(user: any): boolean {
  return !!user && hasPermission(user.permissions, "*");
}

interface ListRow {
  id: number;
  user_id: number;
  user_name: string | null;
  title: string;
  body: string;
  tags: string | null;
  status: string;
  decided_by: number | null;
  decided_at: string | null;
  decline_reason: string | null;
  created_at: string | null;
  vote_count: number;
  has_voted: number;
}

// ── GET /api/innovations ────────────────────────────────────────
// List with vote counts + own-vote flag, filterable by status.
app.get("/", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const status = c.req.query("status");

  const rows = await c.env.DB.prepare(
    `SELECT i.id, i.user_id, u.name AS user_name,
            i.title, i.body, i.tags, i.status,
            i.decided_by, i.decided_at, i.decline_reason, i.created_at,
            (SELECT COUNT(*) FROM votes v
              WHERE v.target_type = 'innovation' AND v.target_id = i.id) AS vote_count,
            (SELECT COUNT(*) FROM votes v
              WHERE v.target_type = 'innovation' AND v.target_id = i.id
                AND v.user_id = ?) AS has_voted
       FROM innovations i
       LEFT JOIN users u ON u.id = i.user_id
      ${status ? "WHERE i.status = ?" : ""}
      ORDER BY i.created_at DESC, i.id DESC
      LIMIT 200`,
  )
    .bind(...(status ? [user.id, status] : [user.id]))
    .all<ListRow>();

  return c.json({ rows: rows.results ?? [] });
});

// ── POST /api/innovations ───────────────────────────────────────
// Submit a new innovation.
app.post("/", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const body = await c.req.json<{
    title?: string;
    body?: string;
    tags?: string;
  }>();
  const title = (body.title || "").trim();
  const text = (body.body || "").trim();
  if (!title) return c.json({ error: "Title is required" }, 400);
  if (!text) return c.json({ error: "Body is required" }, 400);

  const db = getDb(c.env);
  const inserted = await db
    .insert(innovations)
    .values({
      user_id: user.id,
      title,
      body: text,
      tags: body.tags ?? null,
    })
    .returning()
    .get();
  return c.json({ row: inserted });
});

// ── GET /api/innovations/:id ────────────────────────────────────
app.get("/:id", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const id = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(id)) return c.json({ error: "Bad id" }, 400);

  const row = await c.env.DB.prepare(
    `SELECT i.id, i.user_id, u.name AS user_name,
            i.title, i.body, i.tags, i.status,
            i.decided_by, du.name AS decided_by_name,
            i.decided_at, i.decline_reason, i.created_at, i.awarded_at,
            (SELECT COUNT(*) FROM votes v
              WHERE v.target_type = 'innovation' AND v.target_id = i.id) AS vote_count,
            (SELECT COUNT(*) FROM votes v
              WHERE v.target_type = 'innovation' AND v.target_id = i.id
                AND v.user_id = ?) AS has_voted
       FROM innovations i
       LEFT JOIN users u  ON u.id = i.user_id
       LEFT JOIN users du ON du.id = i.decided_by
      WHERE i.id = ?`,
  )
    .bind(user.id, id)
    .first();
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json({ row });
});

// ── POST /api/innovations/:id/vote ──────────────────────────────
app.post("/:id/vote", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const id = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(id)) return c.json({ error: "Bad id" }, 400);

  const db = getDb(c.env);
  const target = await db
    .select({ user_id: innovations.user_id })
    .from(innovations)
    .where(eq(innovations.id, id))
    .get();
  if (!target) return c.json({ error: "Not found" }, 404);
  if (target.user_id === user.id) {
    return c.json({ error: "You cannot vote on your own post" }, 400);
  }

  // Insert vote — UNIQUE constraint dedupes
  try {
    await c.env.DB.prepare(
      `INSERT INTO votes (target_type, target_id, user_id)
         VALUES ('innovation', ?, ?)`,
    )
      .bind(id, user.id)
      .run();
  } catch (e: any) {
    return c.json({ error: "Already voted" }, 409);
  }

  // Award upvote points to the post author
  const upvotePoints = await getSettingNumber(c.env, "points.upvote_received", 5);
  await awardPoints(c.env, target.user_id, "upvote_received", upvotePoints, {
    ref_type: "innovation",
    ref_id: id,
  });

  return c.json({ ok: true });
});

// ── DELETE /api/innovations/:id/vote ────────────────────────────
app.delete("/:id/vote", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const id = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(id)) return c.json({ error: "Bad id" }, 400);

  // Untoggle. We deliberately do not refund the upvote points —
  // the streak logic sees the qualifying-week ledger event already,
  // and toggling shouldn't be a way to repeatedly vote-revote-vote.
  await c.env.DB.prepare(
    `DELETE FROM votes
      WHERE target_type = 'innovation' AND target_id = ? AND user_id = ?`,
  )
    .bind(id, user.id)
    .run();
  return c.json({ ok: true });
});

// ── POST /api/innovations/:id/decision ──────────────────────────
// Admin: set status. When new status is 'shipped' and submitter
// hasn't been awarded yet, credit innovation_shipped points.
app.post("/:id/decision", async (c) => {
  const user = c.get("user");
  if (!isAdmin(user)) return c.json({ error: "Forbidden" }, 403);
  const id = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(id)) return c.json({ error: "Bad id" }, 400);
  const body = await c.req.json<{
    status: "review" | "accepted" | "in_progress" | "shipped" | "declined";
    decline_reason?: string;
  }>();
  const allowed = ["review", "accepted", "in_progress", "shipped", "declined"];
  if (!allowed.includes(body.status)) {
    return c.json({ error: "Bad status" }, 400);
  }

  const db = getDb(c.env);
  const target = await db
    .select()
    .from(innovations)
    .where(eq(innovations.id, id))
    .get();
  if (!target) return c.json({ error: "Not found" }, 404);

  const updated = await db
    .update(innovations)
    .set({
      status: body.status,
      decided_by: user!.id,
      decided_at: sql`datetime('now')`,
      decline_reason:
        body.status === "declined" ? body.decline_reason ?? null : null,
    })
    .where(eq(innovations.id, id))
    .returning()
    .get();

  // Award points once when reaching 'shipped' (idempotent on awarded_at).
  if (body.status === "shipped" && !target.awarded_at) {
    const amount = await getSettingNumber(
      c.env,
      "points.innovation_shipped",
      500,
    );
    await awardPoints(c.env, target.user_id, "innovation_shipped", amount, {
      ref_type: "innovation",
      ref_id: id,
      note: target.title,
    });
    await db
      .update(innovations)
      .set({ awarded_at: sql`datetime('now')` })
      .where(eq(innovations.id, id));
  }

  return c.json({ row: updated });
});

export default app;
