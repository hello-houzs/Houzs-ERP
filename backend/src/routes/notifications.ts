import { Hono } from "hono";
import type { Env } from "../types";
import { requirePermission } from "../middleware/auth";
import { getProjectScope } from "../services/projectAcl";
import { getDb } from "../db/client";
import {
  project_activity,
  project_reads,
  projects,
  users,
} from "../db/schema";
import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";

const app = new Hono<{ Bindings: Env }>();

/**
 * GET /api/notifications
 * Aggregated activity feed for the current user's scoped projects +
 * an `unread_by_project` map the frontend uses to paint dots on the
 * Projects list.
 *
 * Scoping: re-uses the project ACL. Scoped users (sales reps) see
 * only activity on projects where they or their manager is the PIC,
 * AND whose brand is in the user's brand allow-list (mig 049).
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

  const scope = getProjectScope(user);
  if (scope && (scope.pic_ids.length === 0 || scope.brands.length === 0)) {
    return c.json({
      feed: [],
      unread_by_project: {},
      total_unread: 0,
      has_more: false,
    });
  }

  const db = getDb(c.env);

  // Reusable scope predicate — same for the feed query and the
  // per-project unread counts. COALESCE(pic_id, created_by) keeps
  // legacy projects (pre-039) attached to their creator's team.
  const scopeConds = [];
  if (scope) {
    scopeConds.push(
      inArray(
        sql<number>`COALESCE(${projects.pic_id}, ${projects.created_by})`,
        scope.pic_ids
      )
    );
    scopeConds.push(inArray(projects.brand, scope.brands));
  }

  // Feed conditions — exclude the user's own rows so your own posts
  // don't spam the bell.
  const feedConds = [
    isNull(projects.archived_at),
    isNull(project_activity.archived_at),
    or(
      isNull(project_activity.user_id),
      ne(project_activity.user_id, user.id)
    )!,
    ...scopeConds,
  ];
  if (since) feedConds.push(gt(project_activity.created_at, since));
  if (unreadOnly) {
    // Activity strictly newer than the user's last_read_at for that
    // project. Users who've never opened a project see every item as
    // unread (COALESCE on the join).
    feedConds.push(
      sql`${project_activity.created_at} > COALESCE(${project_reads.last_read_at}, '1970-01-01')`
    );
  }

  // Build the feed query. The unread join is conditional — using
  // .$dynamic() so the leftJoin can be appended later without TS
  // narrowing complaints.
  let feedQ = db
    .select({
      id: project_activity.id,
      project_id: project_activity.project_id,
      action: project_activity.action,
      from_value: project_activity.from_value,
      to_value: project_activity.to_value,
      note: project_activity.note,
      created_at: project_activity.created_at,
      user_id: project_activity.user_id,
      user_name: users.name,
      user_email: users.email,
      user_profile_pic_r2_key: users.profile_pic_r2_key,
      project_code: projects.code,
      project_name: projects.name,
      brand: projects.brand,
      project_start_date: projects.start_date,
      project_end_date: projects.end_date,
    })
    .from(project_activity)
    .innerJoin(projects, eq(projects.id, project_activity.project_id))
    .leftJoin(users, eq(users.id, project_activity.user_id))
    .$dynamic();

  if (unreadOnly) {
    feedQ = feedQ.leftJoin(
      project_reads,
      and(
        eq(project_reads.project_id, projects.id),
        eq(project_reads.user_id, user.id)
      )!
    );
  }

  // Pull limit+1 rows so we can tell the frontend whether there's a
  // next page without an extra COUNT(*) query.
  const rawRows = await feedQ
    .where(and(...feedConds))
    .orderBy(desc(project_activity.created_at), desc(project_activity.id))
    .limit(limit + 1)
    .offset(offset);

  const hasMore = rawRows.length > limit;
  const trimmedRows = hasMore ? rawRows.slice(0, limit) : rawRows;

  // Per-project unread counts: activity rows strictly newer than the
  // user's last_read_at for that project. Null (never opened) counts
  // everything. Still scoped to visible projects.
  const unreadRows = await db
    .select({
      project_id: projects.id,
      unread_count: sql<number>`COUNT(*)`,
    })
    .from(projects)
    .innerJoin(project_activity, eq(project_activity.project_id, projects.id))
    .leftJoin(
      project_reads,
      and(
        eq(project_reads.project_id, projects.id),
        eq(project_reads.user_id, user.id)
      )!
    )
    .where(
      and(
        isNull(projects.archived_at),
        isNull(project_activity.archived_at),
        or(
          isNull(project_activity.user_id),
          ne(project_activity.user_id, user.id)
        )!,
        sql`${project_activity.created_at} > COALESCE(${project_reads.last_read_at}, '1970-01-01')`,
        ...scopeConds
      )
    )
    .groupBy(projects.id)
    .having(sql`COUNT(*) > 0`);

  const unread_by_project: Record<number, number> = {};
  let total_unread = 0;
  for (const r of unreadRows) {
    unread_by_project[r.project_id] = r.unread_count;
    total_unread += r.unread_count;
  }

  // Houzs Points snapshot — same poll cadence, near-zero cost
  // (single SELECT). Powers the topbar chip and lets the
  // gamification page header render without a second round-trip.
  const me = await db
    .select({
      points_balance: users.points_balance,
      gifting_balance: users.gifting_balance,
      current_streak: users.current_streak,
    })
    .from(users)
    .where(eq(users.id, user.id))
    .then((r) => r[0]);

  return c.json({
    feed: trimmedRows,
    unread_by_project,
    total_unread,
    has_more: hasMore,
    points_balance: me?.points_balance ?? 0,
    gifting_balance: me?.gifting_balance ?? 0,
    current_streak: me?.current_streak ?? 0,
  });
});

export default app;
