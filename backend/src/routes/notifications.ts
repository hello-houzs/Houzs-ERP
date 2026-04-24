import { Hono } from "hono";
import type { Env } from "../types";
import { requirePermission } from "../middleware/auth";
import { getProjectPicScope } from "../services/projectAcl";

const app = new Hono<{ Bindings: Env }>();

/**
 * GET /api/notifications
 * Aggregated activity feed for the current user's scoped projects +
 * an `unread_by_project` map the frontend uses to paint dots on the
 * Projects list.
 *
 * Scoping: re-uses the project ACL. Scoped users (sales reps) see
 * only activity on projects where they or their manager is the PIC.
 *
 * Query params:
 *   limit      — max feed items (default 20, max 100)
 *   offset     — pagination offset (default 0)
 *   since      — ISO timestamp; only items strictly newer than this.
 *                Independent of unread filter.
 *   unread     — "1" to filter to rows strictly newer than the
 *                caller's last_read_at for that project. Used by the
 *                bell; the /notifications page calls without it to
 *                see history.
 */
app.get("/", requirePermission("projects.read"), async (c) => {
  const user = c.get("user");
  const limit = Math.min(parseInt(c.req.query("limit") || "20", 10), 100);
  const offset = Math.max(parseInt(c.req.query("offset") || "0", 10), 0);
  const since = c.req.query("since") || null;
  const unreadOnly = c.req.query("unread") === "1";

  const picScope = getProjectPicScope(user);
  if (picScope && picScope.length === 0) {
    return c.json({
      feed: [],
      unread_by_project: {},
      total_unread: 0,
      has_more: false,
    });
  }
  const picClause = picScope
    ? ` AND COALESCE(p.pic_id, p.created_by) IN (${picScope.map(() => "?").join(",")})`
    : "";
  const picBinds = picScope ?? [];

  // Feed: recent activity across the user's visible projects. Exclude
  // the user's own rows so your own posts don't spam the bell.
  const sinceClause = since ? " AND act.created_at > ?" : "";
  const sinceBinds = since ? [since] : [];

  // Unread clause: LEFT JOIN on project_reads and keep rows where the
  // activity is strictly newer than the user's last_read_at for that
  // project. Users who've never opened a project see every item as
  // unread.
  const unreadClause = unreadOnly
    ? " AND act.created_at > COALESCE(pr.last_read_at, '1970-01-01')"
    : "";
  const unreadJoin = unreadOnly
    ? " LEFT JOIN project_reads pr ON pr.project_id = p.id AND pr.user_id = ?"
    : "";
  const unreadBinds = unreadOnly ? [user.id] : [];

  // Pull limit+1 rows so we can tell the frontend whether there's a
  // next page without an extra COUNT(*) query.
  const feedRows = await c.env.DB.prepare(
    `SELECT act.id, act.project_id, act.action, act.from_value, act.to_value,
            act.note, act.created_at,
            act.user_id, u.name AS user_name,
            p.code AS project_code, p.name AS project_name, p.brand
       FROM project_activity act
       JOIN projects p ON p.id = act.project_id${unreadJoin}
       LEFT JOIN users u ON u.id = act.user_id
      WHERE p.archived_at IS NULL
        AND act.archived_at IS NULL
        AND (act.user_id IS NULL OR act.user_id != ?)${picClause}${sinceClause}${unreadClause}
      ORDER BY act.created_at DESC, act.id DESC
      LIMIT ? OFFSET ?`
  )
    .bind(
      ...unreadBinds,
      user.id,
      ...picBinds,
      ...sinceBinds,
      limit + 1,
      offset
    )
    .all<any>();

  const rawRows = feedRows.results ?? [];
  const hasMore = rawRows.length > limit;
  const trimmedRows = hasMore ? rawRows.slice(0, limit) : rawRows;

  // Per-project unread counts: activity rows strictly newer than the
  // user's last_read_at for that project. Null (never opened) counts
  // everything. Still scoped to visible projects.
  const unreadRows = await c.env.DB.prepare(
    `SELECT p.id AS project_id,
            COUNT(*) AS unread_count
       FROM projects p
       JOIN project_activity a ON a.project_id = p.id
       LEFT JOIN project_reads pr
         ON pr.project_id = p.id AND pr.user_id = ?
      WHERE p.archived_at IS NULL
        AND a.archived_at IS NULL
        AND (a.user_id IS NULL OR a.user_id != ?)
        AND a.created_at > COALESCE(pr.last_read_at, '1970-01-01')
        ${picClause}
      GROUP BY p.id
      HAVING COUNT(*) > 0`
  )
    .bind(user.id, user.id, ...picBinds)
    .all<{ project_id: number; unread_count: number }>();

  const unread_by_project: Record<number, number> = {};
  let total_unread = 0;
  for (const r of unreadRows.results ?? []) {
    unread_by_project[r.project_id] = r.unread_count;
    total_unread += r.unread_count;
  }

  return c.json({
    feed: trimmedRows,
    unread_by_project,
    total_unread,
    has_more: hasMore,
  });
});

export default app;
