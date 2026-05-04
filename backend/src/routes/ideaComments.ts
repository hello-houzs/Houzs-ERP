import { Hono } from "hono";
import type { Env } from "../types";
import { hasPermission } from "../services/permissions";

/**
 * Idea comments — polymorphic on `target_type` (innovation | suggestion),
 * mirroring the shape of `votes` (mig 057) and `idea_attachments` (mig 059).
 *
 * Comments are a social signal only — they do NOT award points. The
 * upvote-received cap, streak metric, and ledger are unaffected.
 *
 * Auth: any authed user can read + post. Edit + delete on own comments
 * only (admin `*` can also delete any). Soft-archive via `archived_at`
 * so the audit trail is preserved.
 */

const app = new Hono<{ Bindings: Env }>();

type Target = "innovation" | "suggestion";

function isAdmin(user: any): boolean {
  return !!user && hasPermission(user.permissions, "*");
}

function parseTarget(s: string | undefined): Target | null {
  return s === "innovation" || s === "suggestion" ? s : null;
}

interface CommentRow {
  id: number;
  target_type: Target;
  target_id: number;
  user_id: number;
  user_name: string | null;
  user_email: string | null;
  user_profile_pic_r2_key: string | null;
  body: string;
  created_at: string;
  edited_at: string | null;
}

// ── GET /api/idea-comments?target=innovation&target_id=12 ──────
app.get("/", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const target = parseTarget(c.req.query("target"));
  const target_id = parseInt(c.req.query("target_id") ?? "", 10);
  if (!target || !Number.isFinite(target_id)) {
    return c.json({ error: "target and target_id are required" }, 400);
  }

  const rows = await c.env.DB.prepare(
    `SELECT ic.id, ic.target_type, ic.target_id, ic.user_id,
            u.name  AS user_name,
            u.email AS user_email,
            u.profile_pic_r2_key AS user_profile_pic_r2_key,
            ic.body, ic.created_at, ic.edited_at
       FROM idea_comments ic
       LEFT JOIN users u ON u.id = ic.user_id
      WHERE ic.target_type = ?
        AND ic.target_id = ?
        AND ic.archived_at IS NULL
      ORDER BY ic.created_at ASC, ic.id ASC`,
  )
    .bind(target, target_id)
    .all<CommentRow>();

  return c.json({ rows: rows.results ?? [] });
});

// ── POST /api/idea-comments ────────────────────────────────────
app.post("/", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const body = await c.req.json<{
    target?: string;
    target_id?: number;
    body?: string;
  }>();
  const target = parseTarget(body.target);
  const target_id = parseInt(String(body.target_id ?? ""), 10);
  const text = (body.body || "").trim();
  if (!target) return c.json({ error: "Bad target" }, 400);
  if (!Number.isFinite(target_id)) return c.json({ error: "Bad target_id" }, 400);
  if (!text) return c.json({ error: "Comment cannot be empty" }, 400);
  if (text.length > 2000) {
    return c.json({ error: "Comment is too long (2000 char max)" }, 400);
  }

  // Confirm parent exists — keeps the audit consistent if a target was
  // archived between the user opening the page and posting.
  const tableName = target === "innovation" ? "innovations" : "suggestions";
  const parent = await c.env.DB.prepare(
    `SELECT id FROM ${tableName} WHERE id = ?`,
  )
    .bind(target_id)
    .first();
  if (!parent) return c.json({ error: "Post not found" }, 404);

  const inserted = await c.env.DB.prepare(
    `INSERT INTO idea_comments (target_type, target_id, user_id, body)
       VALUES (?, ?, ?, ?)
     RETURNING id, target_type, target_id, user_id, body,
               created_at, edited_at`,
  )
    .bind(target, target_id, user.id, text)
    .first<{
      id: number;
      target_type: Target;
      target_id: number;
      user_id: number;
      body: string;
      created_at: string;
      edited_at: string | null;
    }>();

  // Hydrate author for the optimistic insert client-side.
  const row = {
    ...inserted,
    user_name: user.name,
    user_email: user.email,
    user_profile_pic_r2_key: user.profile_pic_r2_key ?? null,
  };
  return c.json({ row });
});

// ── PATCH /api/idea-comments/:id ───────────────────────────────
app.patch("/:id", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const id = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(id)) return c.json({ error: "Bad id" }, 400);

  const existing = await c.env.DB.prepare(
    `SELECT user_id, archived_at FROM idea_comments WHERE id = ?`,
  )
    .bind(id)
    .first<{ user_id: number; archived_at: string | null }>();
  if (!existing) return c.json({ error: "Not found" }, 404);
  if (existing.archived_at) return c.json({ error: "Comment is archived" }, 409);
  if (existing.user_id !== user.id) {
    return c.json({ error: "You can only edit your own comments" }, 403);
  }

  const body = await c.req.json<{ body?: string }>();
  const text = (body.body || "").trim();
  if (!text) return c.json({ error: "Comment cannot be empty" }, 400);
  if (text.length > 2000) {
    return c.json({ error: "Comment is too long (2000 char max)" }, 400);
  }

  const updated = await c.env.DB.prepare(
    `UPDATE idea_comments
        SET body = ?, edited_at = datetime('now')
      WHERE id = ?
      RETURNING id, target_type, target_id, user_id, body,
                created_at, edited_at`,
  )
    .bind(text, id)
    .first();
  return c.json({ row: updated });
});

// ── DELETE /api/idea-comments/:id ──────────────────────────────
// Soft-archive. Owner OR `*` admin.
app.delete("/:id", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const id = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(id)) return c.json({ error: "Bad id" }, 400);

  const existing = await c.env.DB.prepare(
    `SELECT user_id FROM idea_comments WHERE id = ? AND archived_at IS NULL`,
  )
    .bind(id)
    .first<{ user_id: number }>();
  if (!existing) return c.json({ error: "Not found" }, 404);
  if (existing.user_id !== user.id && !isAdmin(user)) {
    return c.json({ error: "Forbidden" }, 403);
  }

  await c.env.DB.prepare(
    `UPDATE idea_comments SET archived_at = datetime('now') WHERE id = ?`,
  )
    .bind(id)
    .run();
  return c.json({ ok: true });
});

export default app;
