import { Hono } from "hono";
import type { Env } from "../types";
import { hasPermission } from "../services/permissions";
import { allowedCompanyIds } from "../scm/lib/companyScope";
import { todayMyt } from "../scm/lib/my-time";

const app = new Hono<{ Bindings: Env }>();

// Multi-company: the inbox aggregates PROJECT- and ASSR-derived items, so
// those loaders filter by the caller's ALLOWED companies (projects.company_id
// / assr_cases.company_id, mig-pg 0093 / 0083). Trip lanes stay unfiltered —
// TMS is a cross-company queue by design. The fragment is "" when the company
// context is unresolved (pre-migration / D1 test mirror), keeping legacy SQL
// unchanged. NOTE the allow-list is per-USER (user_companies grants), not
// per-active-company, so the per-user KV snapshot key stays valid.
function companiesPred(allowedCo: number[], col: string): string {
  const ids = allowedCo.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) return "";
  return ` AND ${col} IN (${ids.join(",")})`;
}

/**
 * Inbox — "what do I need to do right now" across every module.
 *
 * The spec-v2 doc made the master events table the landing page; in
 * practice people open the ERP to see what's assigned to them, what
 * needs their approval, and what's blocking the chain. This endpoint
 * aggregates that view from ASSR, Projects, and Trips so the home page
 * can be a task inbox instead of a database browser.
 *
 * Each section is independently capped (most-relevant-first) so the
 * payload stays small. The frontend can paginate into full lists via
 * the existing module pages (/assr, /projects, /trips) when needed.
 */

interface InboxItem {
  type: string;
  id: number;
  title: string;
  subtitle: string;
  severity: "info" | "warning" | "error";
  due_date?: string | null;
  link: string;
  meta?: Record<string, any>;
}

// Per-user inbox snapshot key. Exported so the inbox-feeding routers can bust
// the acting user's snapshot on write (see bustInboxForUser).
export const inboxCacheKey = (userId: number | string) => `inbox:v1:${userId}`;

// Best-effort delete of a user's inbox snapshot. The snapshot is cached for
// ~60s to skip the slow multi-module aggregate on repeat loads/polls; without
// busting it, a user's own write (a new ASSR case, a ticked task, a scheduled
// trip) stayed invisible on their inbox for up to a minute. Cross-user
// freshness (an item assigned TO someone else, a review queued for an approver)
// still rides the 60s TTL — pinpointing every affected user per write is a much
// larger surface, left as-is intentionally.
export async function bustInboxForUser(env: Env, userId: number | string): Promise<void> {
  if (!env.SESSION_CACHE || !userId) return;
  try {
    await env.SESSION_CACHE.delete(inboxCacheKey(userId));
  } catch {
    /* non-fatal: the 60s TTL still expires it */
  }
}

app.get("/", async (c) => {
  const user = c.get("user");
  const userId = user?.id ?? 0;
  const perms = user?.permissions ?? [];
  const isStar = perms.includes("*");

  // Read-only "what needs me" dashboard. Serve a recent cached snapshot from KV
  // when present — the per-request DB work can be slow on a cold pool, and ~60s
  // staleness is fine for an inbox. Best-effort: any KV error falls through to a
  // live build.
  const cacheKey = inboxCacheKey(userId);
  try {
    const cached = await c.env.SESSION_CACHE?.get(cacheKey);
    if (cached) return c.json(JSON.parse(cached));
  } catch {}

  // Each loader is fenced individually — a query bug or missing
  // table in one section must not blank out the other three.
  async function safe<T>(label: string, fn: () => Promise<T[]>): Promise<T[]> {
    try {
      return await fn();
    } catch (e) {
      console.error(`[inbox] ${label} failed:`, e);
      return [];
    }
  }

  const allowedCo = allowedCompanyIds(c);
  const [myTasks, reviewQueue, blockers, thisWeek] = await Promise.all([
    safe("my_tasks", () => loadMyTasks(c.env, userId, perms, isStar, allowedCo)),
    safe("review_queue", () => loadReviewQueue(c.env, userId, perms, isStar, allowedCo)),
    safe("blockers", () => loadBlockers(c.env, userId, perms, isStar, allowedCo)),
    safe("this_week", () => loadThisWeek(c.env, userId, perms, isStar, allowedCo)),
  ]);

  const payload = {
    my_tasks: myTasks,
    review_queue: reviewQueue,
    blockers,
    this_week: thisWeek,
    counts: {
      my_tasks: myTasks.length,
      review_queue: reviewQueue.length,
      blockers: blockers.length,
      this_week: thisWeek.length,
    },
  };
  // Cache for ~60s so repeat loads/polls skip the slow path. Best-effort.
  try {
    await c.env.SESSION_CACHE?.put(cacheKey, JSON.stringify(payload), {
      expirationTtl: 60,
    });
  } catch {}
  return c.json(payload);
});

// ── My Tasks ──────────────────────────────────────────────────
// Things explicitly assigned to the user that need action soon.

async function loadMyTasks(env: Env, userId: number, perms: string[], isStar: boolean, allowedCo: number[]) {
  if (!userId) return [];
  const items: InboxItem[] = [];
  // Malaysia calendar "today" for the overdue check + the driver's today-trip
  // filter. Workers run in UTC, so before 08:00 MYT `toISOString()` is still
  // yesterday — an item due today would flag overdue and today's trips would be
  // missed all morning. (The SQL `date('now')`/`datetime('now')` bounds in these
  // same queries are still UTC — a deeper, separate sweep.)
  const today = todayMyt();

  // ASSR cases assigned to me, not closed, not archived
  if (isStar || hasPermission(perms, "service_cases.read")) {
    const rows = await env.DB.prepare(
      `SELECT c.id, c.assr_no, c.customer_name, c.stage, c.priority,
              c.deadline_at,
              CASE
                WHEN c.deadline_at IS NOT NULL AND datetime('now') > c.deadline_at THEN 1
                ELSE 0
              END as is_breached,
              CAST((julianday(c.deadline_at) - julianday('now')) * 24 AS INTEGER) as hours_to_deadline
         FROM assr_cases c
        WHERE c.archived_at IS NULL
          AND c.stage != 'completed'
          AND c.assigned_to = ?${companiesPred(allowedCo, "c.company_id")}
        ORDER BY
          CASE WHEN c.deadline_at IS NULL THEN 1 ELSE 0 END,
          c.deadline_at ASC
        LIMIT 15`
    )
      .bind(userId)
      .all<{
        id: number;
        assr_no: string;
        customer_name: string | null;
        stage: string;
        priority: string;
        deadline_at: string | null;
        is_breached: number;
        hours_to_deadline: number | null;
      }>();
    for (const r of rows.results ?? []) {
      const severity: InboxItem["severity"] =
        r.is_breached ? "error" :
        (r.hours_to_deadline ?? 999) < 24 ? "warning" : "info";
      items.push({
        type: "assr",
        id: r.id,
        title: r.assr_no,
        subtitle: r.customer_name || r.stage,
        severity,
        due_date: r.deadline_at,
        link: `/assr`,
        meta: { stage: r.stage, priority: r.priority, breached: !!r.is_breached },
      });
    }
  }

  // Project checklist items owned by me, status=pending, due in next 7 days or overdue
  if (isStar || hasPermission(perms, "projects.read")) {
    const rows = await env.DB.prepare(
      `SELECT cl.id, cl.title, cl.due_date, cl.status,
              p.id as project_id, p.code as project_code, p.name as project_name
         FROM project_checklist cl
         JOIN projects p ON p.id = cl.project_id
        WHERE p.archived_at IS NULL${companiesPred(allowedCo, "p.company_id")}
          AND cl.owner_user_id = ?
          AND cl.status = 'pending'
          AND (cl.due_date IS NULL OR substr(cl.due_date, 1, 10) <= date('now', '+7 days'))
        ORDER BY
          CASE WHEN cl.due_date IS NULL THEN 1 ELSE 0 END,
          cl.due_date ASC
        LIMIT 15`
    )
      .bind(userId)
      .all<{
        id: number;
        title: string;
        due_date: string | null;
        status: string;
        project_id: number;
        project_code: string;
        project_name: string;
      }>();
    for (const r of rows.results ?? []) {
      const overdue = r.due_date && r.due_date.slice(0, 10) < today;
      items.push({
        type: "project_task",
        id: r.id,
        title: r.title,
        subtitle: r.project_name,
        severity: overdue ? "error" : "info",
        due_date: r.due_date,
        link: `/projects`,
        meta: { project_id: r.project_id },
      });
    }
  }

  // Trip stops assigned to me for today (driver side)
  if (isStar || hasPermission(perms, "trips.read.own") || hasPermission(perms, "trips.read.all")) {
    const rows = await env.DB.prepare(
      `SELECT t.id, t.trip_no, t.trip_date, t.status, t.warehouse,
              (SELECT COUNT(*) FROM trip_stops s WHERE s.trip_id = t.id) as stop_count
         FROM trips t
        WHERE t.driver_user_id = ?
          AND t.trip_date = ?
          AND t.status IN ('assigned','started','in_progress')
        ORDER BY t.id DESC
        LIMIT 10`
    )
      .bind(userId, today)
      .all<{
        id: number;
        trip_no: string;
        trip_date: string;
        status: string;
        warehouse: string;
        stop_count: number;
      }>();
    for (const r of rows.results ?? []) {
      items.push({
        type: "trip",
        id: r.id,
        title: r.trip_no,
        subtitle: `${r.warehouse} · ${r.stop_count} stops`,
        severity: r.status === "started" || r.status === "in_progress" ? "warning" : "info",
        due_date: r.trip_date,
        link: `/trips`,
        meta: { status: r.status },
      });
    }
  }

  return items;
}

// ── Review Queue ──────────────────────────────────────────────
// Things waiting on *my* approval/decision.

async function loadReviewQueue(env: Env, userId: number, perms: string[], isStar: boolean, allowedCo: number[]) {
  if (!userId) return [];
  const items: InboxItem[] = [];

  // Project checklist items in pending_review/amended where I could approve.
  // "Could approve" = item.required_perm is null (anyone) or I hold it.
  if (isStar || hasPermission(perms, "projects.write")) {
    const rows = await env.DB.prepare(
      `SELECT cl.id, cl.title, cl.review_status, cl.required_perm,
              p.id as project_id, p.code as project_code, p.name as project_name
         FROM project_checklist cl
         JOIN projects p ON p.id = cl.project_id
        WHERE p.archived_at IS NULL${companiesPred(allowedCo, "p.company_id")}
          AND cl.review_status IN ('pending_review','amended')
        ORDER BY cl.updated_at DESC
        LIMIT 20`
    )
      .all<{
        id: number;
        title: string;
        review_status: string;
        required_perm: string | null;
        project_id: number;
        project_code: string;
        project_name: string;
      }>();
    for (const r of rows.results ?? []) {
      // Filter: can the current user actually approve this?
      const canApprove = !r.required_perm || isStar || hasPermission(perms, r.required_perm);
      if (!canApprove) continue;
      items.push({
        type: "project_review",
        id: r.id,
        title: r.title,
        subtitle: `${r.project_name} · ${r.review_status}`,
        severity: "warning",
        link: `/projects`,
        meta: {
          project_id: r.project_id,
          required_perm: r.required_perm,
          review_status: r.review_status,
        },
      });
    }
  }

  // ASSR cases in the final-leg stages (awaiting manager close +
  // QA pass) when the viewer can manage service cases. With the v3.1
  // 9-stage workflow, "approaching close" maps to the supplier-pickup
  // → item-ready → delivery span; the legacy 'resolution' value is
  // covered by 'pending_delivery_service'.
  if (isStar || hasPermission(perms, "service_cases.manage")) {
    const rows = await env.DB.prepare(
      `SELECT c.id, c.assr_no, c.customer_name, c.stage,
              c.quality_review_passed, c.approved_at
         FROM assr_cases c
        WHERE c.archived_at IS NULL
          AND c.stage = 'pending_delivery_service'
          AND c.approved_at IS NULL${companiesPred(allowedCo, "c.company_id")}
        ORDER BY c.updated_at DESC
        LIMIT 10`
    )
      .all<{
        id: number;
        assr_no: string;
        customer_name: string | null;
        stage: string;
        quality_review_passed: number | null;
        approved_at: string | null;
      }>();
    for (const r of rows.results ?? []) {
      items.push({
        type: "assr_review",
        id: r.id,
        title: r.assr_no,
        subtitle: `${r.customer_name || "—"} · awaiting manager approval`,
        severity: "warning",
        link: `/assr`,
        meta: { stage: r.stage },
      });
    }
  }

  return items;
}

// ── Blockers ──────────────────────────────────────────────────
// Things actively stuck that need unsticking — SLA breaches, stuck
// stages, unresolved defects.

async function loadBlockers(env: Env, userId: number, perms: string[], isStar: boolean, allowedCo: number[]) {
  if (!userId) return [];
  const items: InboxItem[] = [];

  // ASSR SLA breached on cases I own
  if (isStar || hasPermission(perms, "service_cases.read")) {
    const rows = await env.DB.prepare(
      `SELECT c.id, c.assr_no, c.customer_name, c.stage, c.deadline_at,
              CAST(julianday('now') - julianday(c.deadline_at) AS INTEGER) as days_overdue
         FROM assr_cases c
        WHERE c.archived_at IS NULL
          AND c.stage != 'completed'
          AND c.deadline_at IS NOT NULL
          AND datetime('now') > c.deadline_at
          AND (c.assigned_to = ? OR c.assigned_to IS NULL)${companiesPred(allowedCo, "c.company_id")}
        ORDER BY c.deadline_at ASC
        LIMIT 10`
    )
      .bind(userId)
      .all<{
        id: number;
        assr_no: string;
        customer_name: string | null;
        stage: string;
        deadline_at: string;
        days_overdue: number;
      }>();
    for (const r of rows.results ?? []) {
      items.push({
        type: "assr_breach",
        id: r.id,
        title: r.assr_no,
        subtitle: `${r.customer_name || "—"} · SLA overdue ${r.days_overdue}d`,
        severity: "error",
        due_date: r.deadline_at,
        link: `/assr`,
        meta: { stage: r.stage, days_overdue: r.days_overdue },
      });
    }
  }

  // Project defects unresolved
  if (isStar || hasPermission(perms, "projects.read")) {
    const rows = await env.DB.prepare(
      `SELECT d.id, d.phase, d.reported_by_role,
              d.item_code, d.item_description, d.reported_at,
              p.id as project_id, p.name as project_name
         FROM project_defects d
         JOIN projects p ON p.id = d.project_id
        WHERE p.archived_at IS NULL${companiesPred(allowedCo, "p.company_id")}
          AND d.archived_at IS NULL
          AND d.resolved = 0
        ORDER BY d.reported_at DESC
        LIMIT 10`
    )
      .all<{
        id: number;
        phase: string;
        reported_by_role: string;
        item_code: string | null;
        item_description: string | null;
        reported_at: string;
        project_id: number;
        project_name: string;
      }>();
    for (const r of rows.results ?? []) {
      items.push({
        type: "project_defect",
        id: r.id,
        title: r.item_code || r.item_description || "(unnamed defect)",
        subtitle: `${r.project_name} · ${r.phase} · reported by ${r.reported_by_role}`,
        severity: "warning",
        link: `/projects`,
        meta: { project_id: r.project_id, phase: r.phase },
      });
    }
  }

  // Stuck stages — ASSR cases in same stage > 3 days (assigned to me).
  // Wrapped in a subquery because HAVING without GROUP BY is invalid;
  // we need a computed `days_in_stage` alias to filter on.
  if (isStar || hasPermission(perms, "service_cases.read")) {
    const rows = await env.DB.prepare(
      `SELECT * FROM (
         SELECT c.id, c.assr_no, c.customer_name, c.stage,
                CAST(julianday('now') - julianday(
                  COALESCE(
                    (SELECT MAX(a.created_at) FROM assr_activity a
                      WHERE a.assr_id = c.id AND a.action = 'stage_change'
                        AND a.to_value = c.stage),
                    c.created_at
                  )
                ) AS INTEGER) as days_in_stage
           FROM assr_cases c
          WHERE c.archived_at IS NULL
            AND c.stage != 'completed'
            AND c.assigned_to = ?${companiesPred(allowedCo, "c.company_id")}
       )
       WHERE days_in_stage > 3
       ORDER BY days_in_stage DESC
       LIMIT 10`
    )
      .bind(userId)
      .all<{
        id: number;
        assr_no: string;
        customer_name: string | null;
        stage: string;
        days_in_stage: number;
      }>();
    for (const r of rows.results ?? []) {
      items.push({
        type: "assr_stuck",
        id: r.id,
        title: r.assr_no,
        subtitle: `${r.customer_name || "—"} · stuck at ${r.stage} for ${r.days_in_stage}d`,
        severity: "warning",
        link: `/assr`,
        meta: { stage: r.stage, days_in_stage: r.days_in_stage },
      });
    }
  }

  return items;
}

// ── This Week ─────────────────────────────────────────────────
// Things happening in the next 7 days — useful for context even if
// they aren't on your plate today.

async function loadThisWeek(env: Env, userId: number, perms: string[], isStar: boolean, allowedCo: number[]) {
  if (!userId) return [];
  const items: InboxItem[] = [];

  // Projects starting this week
  if (isStar || hasPermission(perms, "projects.read")) {
    const rows = await env.DB.prepare(
      `SELECT p.id, p.code, p.name, p.brand, p.stage, p.venue,
              p.start_date, p.end_date
         FROM projects p
        WHERE p.archived_at IS NULL${companiesPred(allowedCo, "p.company_id")}
          AND p.stage NOT IN ('closed','cancelled')
          AND p.start_date IS NOT NULL
          AND substr(p.start_date, 1, 10) BETWEEN date('now') AND date('now','+7 days')
        ORDER BY p.start_date ASC
        LIMIT 10`
    )
      .all<{
        id: number;
        code: string;
        name: string;
        brand: string | null;
        stage: string;
        venue: string | null;
        start_date: string;
        end_date: string | null;
      }>();
    for (const r of rows.results ?? []) {
      items.push({
        type: "project_upcoming",
        id: r.id,
        title: r.name,
        subtitle: `${r.code} · ${r.brand || "—"}${r.venue ? ` · ${r.venue}` : ""}`,
        severity: "info",
        due_date: r.start_date,
        link: `/projects`,
        meta: { stage: r.stage },
      });
    }
  }

  // Trips scheduled this week for me (driver) OR any if I'm a dispatcher
  if (isStar || hasPermission(perms, "trips.read.all") || hasPermission(perms, "trips.read.own")) {
    const showAll = isStar || hasPermission(perms, "trips.read.all");
    const sql = showAll
      ? `SELECT id, trip_no, trip_date, status, warehouse, driver_user_id,
                (SELECT name FROM users WHERE id = trips.driver_user_id) as driver_name
           FROM trips
          WHERE trip_date BETWEEN date('now') AND date('now','+7 days')
            AND status IN ('assigned','started','in_progress')
          ORDER BY trip_date ASC, id ASC
          LIMIT 10`
      : `SELECT id, trip_no, trip_date, status, warehouse, driver_user_id,
                (SELECT name FROM users WHERE id = trips.driver_user_id) as driver_name
           FROM trips
          WHERE driver_user_id = ?
            AND trip_date BETWEEN date('now') AND date('now','+7 days')
            AND status IN ('assigned','started','in_progress')
          ORDER BY trip_date ASC, id ASC
          LIMIT 10`;
    const stmt = showAll ? env.DB.prepare(sql) : env.DB.prepare(sql).bind(userId);
    const rows = await stmt.all<{
      id: number;
      trip_no: string;
      trip_date: string;
      status: string;
      warehouse: string;
      driver_user_id: number | null;
      driver_name: string | null;
    }>();
    for (const r of rows.results ?? []) {
      items.push({
        type: "trip_upcoming",
        id: r.id,
        title: r.trip_no,
        subtitle: `${r.warehouse}${r.driver_name ? ` · ${r.driver_name}` : ""}`,
        severity: "info",
        due_date: r.trip_date,
        link: `/trips`,
        meta: { status: r.status },
      });
    }
  }

  return items;
}

export default app;
