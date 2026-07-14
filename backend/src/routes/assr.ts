import { Hono } from "hono";
import type { Env } from "../types";
import {
  createAssrCase,
  getAssrDetail,
  transitionStage,
  markCaseOpened,
  patchAssrCase,
  listAssrCases,
  exportAssrCases,
  issueSurveyToken,
  lookupSOItems,
  addItems,
  removeItem,
  assrAttachmentKey,
  saveAttachment,
  createLogistics,
  patchLogistics,
  logActivity,
  nextServicePONumber,
} from "../services/assr";
import { runSlaEscalation } from "../services/assrEscalation";
import { issueStaffToken, issueSalesToken } from "../services/caseTracking";
import { sendEmail, publicUrl } from "../services/email";
import { resolveCompanyCode } from "../services/branding";
import { AutoCountClient } from "../services/autocount";
import { requirePermission } from "../middleware/auth";
import {
  activeCompanyId,
  allowedCompanyIds,
  allowedCompaniesSql,
} from "../scm/lib/companyScope";
import { hasPermission } from "../services/permissions";
import { subtreeUserIds } from "../services/orgScope";
import { isSalesUser, isDirectorUser } from "../services/pmsAccess";
import type { AuthUser } from "../services/auth";
import type { MiddlewareHandler } from "hono";

const app = new Hono<{ Bindings: Env }>();

// ── Sales access to Service Cases (owner rule 8, 2026-07) ─────
// Service Cases + My Case are granted to Sales WITHOUT relying on the
// configurable permission matrix: a Sales-department / Sales-position user may
// VIEW their own cases, CREATE cases, and see the status of cases they handled.
// Their DATA stays scoped to self + downline (assrVisibleUserIds → rule 9);
// this gate only decides who gets THROUGH the route, not which rows they see.
//
// `canAccessServiceCases` passes when the caller holds ANY of the given
// permissions (the legacy path — unchanged for existing ASSR staff), OR is
// Sales staff, OR is a director (Owner/IT `*`, Super Admin, Sales Director,
// Finance Manager). It is applied ONLY to the read + create endpoints Sales
// needs — NOT to write / manage / approve / delete, which keep their original
// `requirePermission` gate so this never widens mutation access.
function canAccessServiceCases(
  user: AuthUser | null | undefined,
  perms: string[],
): boolean {
  if (!user) return false;
  const granted = user.permissions_set ?? user.permissions ?? [];
  if (perms.some((p) => hasPermission(granted, p))) return true;
  return isSalesUser(user) || isDirectorUser(user);
}

/** Route gate that admits the service_cases permission holder OR Sales / director
 *  (see canAccessServiceCases). `perms` defaults to the read key. */
function requireServiceCaseAccess(
  perms: string[] = ["service_cases.read"],
): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    if (!canAccessServiceCases(user, perms)) {
      return c.json({ error: "Forbidden: service cases" }, 403);
    }
    await next();
  };
}

// ── Multi-company (CROSS-COMPANY module) ──────────────────────
// Service Cases are ONE shared queue across companies: list/stat reads widen
// to the caller's ALLOWED companies (`company_id IN (...)` — not just the
// active pick) and each row is tagged with its company (listAssrCases already
// selects c.company_id + companies.code). All fragments returned by
// allowedCompaniesSql are "" when the company context is unresolved
// (pre-migration / D1 test mirror / cold-start) so legacy SQL runs unchanged.

// ── Row-level visibility (owner spec 2026-07) ─────────────────
// Full view = `*` wildcard (Owner / IT Admin) or `service_cases.manage`
// (the existing admin-tier ASSR key — no new permission invented).
// Everyone else sees only cases they CREATED or are ASSIGNED TO, plus
// the same for every user under them in the users.manager_id reporting
// chain (full depth — services/orgScope.ts). Returns undefined for the
// unrestricted tier, or the allow-listed user ids otherwise.
async function assrVisibleUserIds(c: {
  get(key: "user"): unknown;
  env: Env;
}): Promise<number[] | undefined> {
  const user = c.get("user") as AuthUser | undefined;
  const granted = user?.permissions_set ?? user?.permissions ?? [];
  // Full-view tier: `*` / service_cases.manage (existing admin key), OR a
  // director by STABLE ORG FIELD (Owner/IT `*`, Super Admin, Sales Director,
  // Finance Manager) — owner rule "Director sees ALL". Additive: this only ever
  // GRANTS the unrestricted tier, never removes an existing pass condition.
  if (
    hasPermission(granted, "*") ||
    hasPermission(granted, "service_cases.manage") ||
    isDirectorUser(user)
  ) {
    return undefined; // unrestricted
  }
  if (user?.id == null) return []; // fail closed, never open
  return subtreeUserIds(c.env, Number(user.id));
}

/**
 * True when the case identified by `caseId` is within the caller's
 * assrVisibleUserIds scope (self + downline; directors/admins unrestricted).
 * Mirrors the row-level check the detail GET performs (createdBy / assignedTo
 * ∈ visible ids) so Sales-reachable SUB-routes — attachment / timeline
 * download, sales comment / nudge — can't reach a case outside the caller's
 * reporting chain. A missing/unknown case returns false so the caller gets the
 * same 404 as a nonexistent id (never distinguishes existence across the scope
 * boundary). Raw env.DB reads return snake_case columns (D1-compat shim — same
 * as the customer-history query below).
 */
async function caseInCallerScope(
  c: { get(key: "user"): unknown; env: Env },
  caseId: number,
): Promise<boolean> {
  const visibleIds = await assrVisibleUserIds(c);
  if (visibleIds === undefined) return true; // unrestricted tier
  const row = await c.env.DB.prepare(
    `SELECT created_by, assigned_to, assigned_to_2 FROM assr_cases WHERE id = ?`,
  )
    .bind(caseId)
    .first<{ created_by: number | null; assigned_to: number | null; assigned_to_2: number | null }>();
  if (!row) return false;
  const createdBy = Number(row.created_by ?? NaN);
  const assignedTo = Number(row.assigned_to ?? NaN);
  // Co-assignee (assigned_to_2) — the LIST includes it (services/assr.ts), so a
  // co-assignee who sees the case in their list must be able to OPEN it too.
  const assignedTo2 = Number(row.assigned_to_2 ?? NaN);
  return (
    (Number.isFinite(createdBy) && visibleIds.includes(createdBy)) ||
    (Number.isFinite(assignedTo) && visibleIds.includes(assignedTo)) ||
    (Number.isFinite(assignedTo2) && visibleIds.includes(assignedTo2))
  );
}

// ── Module-level settings (default assignees) ─────────────────
//
// Stored in `system_settings` under keys `assr_default_assignee_id`
// (primary) and `assr_default_assignee2_id` (co-assignee — the desk
// is run by two people). Read on each create_case call so changes
// take effect immediately without a deploy.

const DEFAULT_ASSIGNEE_KEYS = {
  default_assignee_id: "assr_default_assignee_id",
  default_assignee2_id: "assr_default_assignee2_id",
} as const;

app.get("/settings", requirePermission("service_cases.read"), async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT s.key AS key, u.id AS user_id, u.name AS user_name, u.email AS user_email
       FROM system_settings s
       LEFT JOIN users u ON CAST(s.value AS INTEGER) = u.id
      WHERE s.key IN ('assr_default_assignee_id', 'assr_default_assignee2_id')`
  ).all<{
    key: string;
    user_id: number | null;
    user_name: string | null;
    user_email: string | null;
  }>();
  const byKey = new Map((rows.results ?? []).map((r) => [r.key, r]));
  const primary = byKey.get("assr_default_assignee_id");
  const second = byKey.get("assr_default_assignee2_id");
  return c.json({
    default_assignee_id: primary?.user_id ?? null,
    default_assignee_name: primary?.user_name ?? null,
    default_assignee_email: primary?.user_email ?? null,
    default_assignee2_id: second?.user_id ?? null,
    default_assignee2_name: second?.user_name ?? null,
    default_assignee2_email: second?.user_email ?? null,
  });
});

app.put("/settings", requirePermission("service_cases.manage"), async (c) => {
  const body = await c.req.json<{
    default_assignee_id?: number | null;
    default_assignee2_id?: number | null;
  }>();
  for (const [field, key] of Object.entries(DEFAULT_ASSIGNEE_KEYS)) {
    if (!(field in body)) continue; // untouched fields stay as-is
    const id = body[field as keyof typeof DEFAULT_ASSIGNEE_KEYS];
    if (id === null || id === undefined) {
      await c.env.DB.prepare(`DELETE FROM system_settings WHERE key = ?`).bind(key).run();
    } else {
      if (typeof id !== "number" || isNaN(id)) {
        return c.json({ error: `${field} must be a number or null` }, 400);
      }
      // INSERT OR REPLACE so we don't care whether the row exists yet.
      await c.env.DB.prepare(
        `INSERT INTO system_settings (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
        .bind(key, String(id))
        .run();
    }
  }
  return c.json({ ok: true });
});

// ── Lookups (mig 065) ─────────────────────────────────────────
//
// Per-module pickers maintained from Service Maintenance. Same
// shape across the four kinds — slug + name + sort_order + active —
// so one set of routes handles them all via a `kind` path param.
// Slugs are stable values; names are display labels admins can
// rename without breaking historical case data.

const LOOKUP_TABLES = {
  "issue-categories": "assr_issue_categories",
  "resolution-methods": "assr_resolution_methods",
  "priorities": "assr_priorities",
  "ncr-categories": "assr_ncr_categories",
  // Mig 0112 — mirrors AutoCount's item groups; seeded with the common
  // furniture groups, admin-maintained until the AutoCount reconnect
  // back-fills the authoritative list.
  "product-categories": "assr_product_categories",
} as const;
type LookupKind = keyof typeof LOOKUP_TABLES;

function lookupTable(kind: string): string | null {
  return (LOOKUP_TABLES as Record<string, string>)[kind] ?? null;
}

app.get("/lookups/:kind", requireServiceCaseAccess(), async (c) => {
  const kind = c.req.param("kind");
  const table = lookupTable(kind);
  if (!table) return c.json({ error: "Unknown lookup kind" }, 400);
  const includeInactive = c.req.query("include_inactive") === "1";
  // priorities surface sla_hours so the manager UI can edit it; the
  // other three only have the common columns. Casting to ANY at the
  // bind layer because column shape varies.
  const slaCol = kind === "priorities" ? ", sla_hours" : "";
  const rows = await c.env.DB.prepare(
    `SELECT id, slug, name, sort_order, active${slaCol}
       FROM ${table}
      ${includeInactive ? "" : "WHERE active = 1"}
      ORDER BY sort_order ASC, name ASC`,
  ).all();
  return c.json({ data: rows.results ?? [] });
});

app.post("/lookups/:kind", requirePermission("service_cases.manage"), async (c) => {
  const kind = c.req.param("kind");
  const table = lookupTable(kind);
  if (!table) return c.json({ error: "Unknown lookup kind" }, 400);
  const body = await c.req.json<{
    name: string;
    slug?: string;
    sort_order?: number;
    sla_hours?: number;
  }>();
  const name = (body.name ?? "").trim();
  if (!name) return c.json({ error: "name required" }, 400);
  // Auto-slug when not provided. Lowercased, spaces → underscores,
  // strip anything that isn't alnum/underscore. Manual override is
  // accepted to keep historical slugs stable.
  const slug = (
    body.slug?.trim() ||
    name.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "")
  );
  const sortOrder = Number.isFinite(body.sort_order) ? Number(body.sort_order) : 0;
  if (kind === "priorities") {
    const sla = Number.isFinite(body.sla_hours) ? Number(body.sla_hours) : null;
    await c.env.DB.prepare(
      `INSERT INTO assr_priorities (slug, name, sort_order, sla_hours)
       VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    )
      .bind(slug, name, sortOrder, sla)
      .run();
  } else {
    await c.env.DB.prepare(
      `INSERT INTO ${table} (slug, name, sort_order) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
    )
      .bind(slug, name, sortOrder)
      .run();
  }
  return c.json({ ok: true, slug });
});

app.patch("/lookups/:kind/:id", requirePermission("service_cases.manage"), async (c) => {
  const kind = c.req.param("kind");
  const table = lookupTable(kind);
  if (!table) return c.json({ error: "Unknown lookup kind" }, 400);
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const body = await c.req.json<Record<string, any>>();

  const allowed = ["name", "sort_order", "active"];
  if (kind === "priorities") allowed.push("sla_hours");
  const sets: string[] = [];
  const binds: any[] = [];
  for (const k of allowed) {
    if (k in body) {
      sets.push(`${k} = ?`);
      binds.push(body[k] ?? null);
    }
  }
  if (!sets.length) return c.json({ error: "no fields to update" }, 400);
  binds.push(id);
  await c.env.DB.prepare(`UPDATE ${table} SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();
  return c.json({ ok: true });
});

// Bulk reorder. Same shape as the project bulk-reorder endpoints:
// `{ ids: [...] }` in the new display order; sort_order is rewritten
// in steps of 10 so future inserts can slot between rows.
app.put("/lookups/:kind/reorder", requirePermission("service_cases.manage"), async (c) => {
  const kind = c.req.param("kind");
  const table = lookupTable(kind);
  if (!table) return c.json({ error: "Unknown lookup kind" }, 400);
  const body = await c.req.json<{ ids?: unknown }>();
  if (!Array.isArray(body.ids) || !body.ids.every((n) => Number.isInteger(n))) {
    return c.json({ error: "ids must be an array of integers" }, 400);
  }
  const ids = body.ids as number[];
  if (ids.length === 0) return c.json({ ok: true });
  await c.env.DB.batch(
    ids.map((id, idx) =>
      c.env.DB.prepare(`UPDATE ${table} SET sort_order = ? WHERE id = ?`)
        .bind((idx + 1) * 10, id),
    ),
  );
  return c.json({ ok: true });
});

app.delete("/lookups/:kind/:id", requirePermission("service_cases.manage"), async (c) => {
  const kind = c.req.param("kind");
  const table = lookupTable(kind);
  if (!table) return c.json({ error: "Unknown lookup kind" }, 400);
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  // Soft-delete only — historical case rows still hold the slug as
  // their `priority` / `resolution_method` / etc., and we don't want
  // to break filters retroactively. `active = 0` just hides from the
  // picker.
  await c.env.DB.prepare(`UPDATE ${table} SET active = 0 WHERE id = ?`)
    .bind(id)
    .run();
  return c.json({ ok: true });
});

// ── Cost auto-fill suggestion ─────────────────────────────────
//
// Looks up the case's item_code in (a) the linked sales order's lines,
// and (b) the linked purchase order's lines. Returns the unit-price ×
// qty for each side so the frontend can offer to populate
// customer_amount and po_amount in one click. The user can still edit
// after — this is a suggestion, not a write.

app.get("/:id/cost-suggestion", requireServiceCaseAccess(), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);

  const caseRow = await c.env.DB.prepare(
    `SELECT doc_no, po_no, item_code FROM assr_cases WHERE id = ?`
  )
    .bind(id)
    .first<{ doc_no: string | null; po_no: string | null; item_code: string | null }>();
  if (!caseRow) return c.json({ error: "Not found" }, 404);
  /* Go-live review #11 — this sub-panel used requirePermission("service_cases.
     read"), 403-ing a Sales viewer who legitimately opened this case. Gate on
     requireServiceCaseAccess (admits Sales / director) + the SAME case-in-scope
     check the detail GET performs, so a scoped viewer of THIS case can load the
     panel while an out-of-scope case still answers 404. */
  if (!(await caseInCallerScope(c, id))) return c.json({ error: "Not found" }, 404);

  const itemCode = (caseRow.item_code || "").trim();
  if (!itemCode) {
    return c.json({
      customer_amount: null,
      po_amount: null,
      sources: { so: null, po: null },
      reason: "Case has no item_code — set one before auto-filling.",
    });
  }

  // ── Sales order lookup (revenue side) ──────────────────────────
  // SO line detail isn't cached in D1; fetch live from AutoCount.
  let customerAmount: number | null = null;
  let soSource: { doc_no: string; unit_price: number; qty: number } | null = null;
  if (caseRow.doc_no) {
    try {
      const client = new AutoCountClient(c.env);
      const lines = await client.getDetail(caseRow.doc_no);
      const match = matchLine(lines as any[], itemCode);
      if (match) {
        const qty = num((match as any).Qty) ?? 1;
        const price = num((match as any).UnitPrice) ?? 0;
        const amount = num((match as any).Amount) ?? qty * price;
        customerAmount = amount;
        soSource = { doc_no: caseRow.doc_no, unit_price: price, qty };
      }
    } catch (e: any) {
      console.warn(`[assr.cost-suggestion] SO lookup failed for ${caseRow.doc_no}:`, e?.message || e);
    }
  }

  // ── Purchase order lookup (supplier cost side) ─────────────────
  let poAmount: number | null = null;
  let poSource: { doc_no: string; unit_price: number; qty: number } | null = null;
  if (caseRow.po_no) {
    // PO line table is purchase_orders (one row per outstanding line),
    // keyed by (doc_no, item_code). Pull the matching line.
    // The PO line table stores `original_qty` (the full line quantity at
    // doc creation, added in migration 030) and `remaining_qty` (still
    // outstanding). Earlier code referenced `ordered_qty`, which never
    // existed and crashed auto-fill with a SQLite "no such column" error.
    const poRow = await c.env.DB.prepare(
      `SELECT remaining_qty AS qty,
              original_qty  AS ord_qty,
              unit_price    AS price
         FROM purchase_orders
        WHERE doc_no = ? AND item_code = ?
        LIMIT 1`
    )
      .bind(caseRow.po_no, itemCode)
      .first<{ qty: number | null; ord_qty: number | null; price: number | null }>();
    if (poRow && poRow.price != null) {
      const qty = poRow.ord_qty ?? poRow.qty ?? 1;
      poAmount = qty * poRow.price;
      poSource = { doc_no: caseRow.po_no, unit_price: poRow.price, qty };
    }
  }

  return c.json({
    customer_amount: customerAmount,
    po_amount: poAmount,
    sources: { so: soSource, po: poSource },
  });
});

// ── Summary ───────────────────────────────────────────────────

app.get("/summary", requirePermission("service_cases.read"), async (c) => {
  // Accept the same period filter the /metrics endpoint takes so the
  // ServiceMetrics dashboard can share one dropdown. The pulse row
  // (Pending Review / Aging / Breach) and Stage Funnel below now narrow
  // to cases whose complaint / creation date falls inside the window —
  // previously they were always "real-time across all data" and so
  // looked frozen as the user switched periods.
  const sinceDays = Math.min(730, Math.max(1, parseInt(c.req.query("since_days") || "90", 10) || 90));
  const periodAnd =
    `AND COALESCE(c.complained_date, c.created_at) >= date('now', '-${sinceDays} days')`;
  // Allowed-companies predicates ("" when unresolved) — one per table alias
  // used below.
  const coC = allowedCompaniesSql(c, "c.company_id");
  const coBare = allowedCompaniesSql(c);

  const totals = await c.env.DB.prepare(
    `SELECT COUNT(*) as total FROM assr_cases WHERE 1=1${coBare}`
  ).first<{ total: number }>();

  // Active backlog: cases still in progress (not completed) and not
  // archived — "how many cases are open right now". Deliberately NOT
  // period-filtered: the Overview KPI reflects the live workload, not a
  // rolling window. 'completed' is the only terminal stage (same
  // definition the breach / aging queries use).
  const active = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM assr_cases
      WHERE stage != 'completed' AND archived_at IS NULL${coBare}`
  ).first<{ count: number }>();

  const byStage = await c.env.DB.prepare(
    `SELECT stage, COUNT(*) as count FROM assr_cases WHERE 1=1${coBare} GROUP BY stage`
  ).all();

  const byStatus = await c.env.DB.prepare(
    `SELECT status, COUNT(*) as count FROM assr_cases WHERE 1=1${coBare} GROUP BY status`
  ).all();

  const byLocation = await c.env.DB.prepare(
    `SELECT location, COUNT(*) as count FROM assr_cases
     WHERE location IS NOT NULL${coBare}
     GROUP BY location ORDER BY count DESC LIMIT 5`
  ).all();

  // Group by issue_category. The intake form now captures this on
  // every new case (replacing the older service_category-driven flow),
  // so this gives dispatchers a live view of what's coming in.
  const byCategory = await c.env.DB.prepare(
    `SELECT issue_category as name, COUNT(*) as count FROM assr_cases
     WHERE issue_category IS NOT NULL${coBare}
     GROUP BY issue_category ORDER BY count DESC LIMIT 5`
  ).all();

  const recent = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM assr_cases
     WHERE complained_date IS NOT NULL
       AND complained_date >= date('now', '-30 days')${coBare}`
  ).first<{ count: number }>();

  // Aging: cases still open that have been in their current stage >3 days
  const aging = await c.env.DB.prepare(
    `SELECT COUNT(*) as count
       FROM assr_cases c
      WHERE c.stage != 'completed'
        ${periodAnd}${coC}
        AND julianday('now') - julianday(
              COALESCE(
                (SELECT MAX(a.created_at)
                   FROM assr_activity a
                  WHERE a.assr_id = c.id
                    AND a.action = 'stage_change'
                    AND a.to_value = c.stage),
                c.created_at
              )
            ) > 3`
  ).first<{ count: number }>();

  // SLA breach: open cases whose CURRENT stage has crossed 100% of its
  // snapshotted per-stage target. Uses the SAME stage-level definition as
  // the Stage Funnel below (assr_stage_history.target_days + entered_at)
  // so the KPI tile and the funnel's breach totals reconcile. Previously
  // this used case-level deadline_at, which diverged from the funnel and
  // showed a different number on the same page.
  const breach = await c.env.DB.prepare(
    `SELECT COUNT(*) as count
       FROM assr_cases c
       JOIN assr_stage_history h
              ON h.assr_id = c.id AND h.exited_at IS NULL
      WHERE c.stage != 'completed'
        AND c.archived_at IS NULL
        ${periodAnd}${coC}
        AND h.target_days IS NOT NULL AND h.target_days > 0
        AND (julianday('now') - julianday(h.entered_at)) / h.target_days >= 1`
  ).first<{ count: number }>();

  // v3.1 — Pending Review tile
  const pendingReview = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM assr_cases c
      WHERE c.stage = 'pending_review' AND c.archived_at IS NULL
        ${periodAnd}${coC}`
  ).first<{ count: number }>();

  // v3.1 — Avg end-to-end lead time (days), completed cases only.
  // Filter out rows where closed_at < created_at — legacy data has
  // some rows with a closed_at predating the case created_at (likely
  // imported from AutoCount with a different timestamp source), and
  // including them produces a wildly negative average. Window now
  // honours the dashboard's since_days instead of the old hardcoded 90d.
  const avgE2E = await c.env.DB.prepare(
    `SELECT AVG(julianday(closed_at) - julianday(created_at)) AS avg_days
       FROM assr_cases
      WHERE stage = 'completed'
        AND closed_at IS NOT NULL
        AND julianday(closed_at) > julianday(created_at)
        AND (julianday(closed_at) - julianday(created_at)) < 365
        AND closed_at >= date('now', '-${sinceDays} days')${coBare}`
  ).first<{ avg_days: number | null }>();

  // v3.1 — Stage funnel: count by 9-stage enum, in canonical order,
  // with breach-aware fill colour (% of cases in this stage that have
  // crossed 100% of their snapshotted target).
  const funnel = await c.env.DB.prepare(
    `SELECT c.stage AS stage,
            COUNT(*) AS total,
            SUM(CASE
                  WHEN h.target_days IS NOT NULL AND h.target_days > 0
                   AND (julianday('now') - julianday(h.entered_at)) / h.target_days >= 1
                  THEN 1 ELSE 0 END) AS breached
       FROM assr_cases c
       LEFT JOIN assr_stage_history h
              ON h.assr_id = c.id AND h.exited_at IS NULL
      WHERE c.archived_at IS NULL
        ${periodAnd}${coC}
      GROUP BY c.stage`
  ).all<{ stage: string; total: number; breached: number }>();

  // v3.1 — CSAT 13-week rolling trend (weekly average ratings)
  const csatTrend = await c.env.DB.prepare(
    `SELECT strftime('%Y-W%W', closed_at) AS week,
            AVG(satisfaction_rating) AS avg_rating,
            COUNT(satisfaction_rating) AS n
       FROM assr_cases
      WHERE stage = 'completed'
        AND satisfaction_rating IS NOT NULL
        AND closed_at >= date('now', '-91 days')${coBare}
      GROUP BY week
      ORDER BY week`
  ).all<{ week: string; avg_rating: number; n: number }>();

  return c.json({
    total: totals?.total || 0,
    active_count: active?.count || 0,
    by_stage: byStage.results,
    by_status: byStatus.results,
    by_location: byLocation.results,
    by_category: byCategory.results,
    recent_30d: recent?.count || 0,
    aging_count: aging?.count || 0,
    breach_count: breach?.count || 0,
    // v3.1 enrichments
    pending_review_count: pendingReview?.count || 0,
    avg_e2e_days: avgE2E?.avg_days != null ? Number(Number(avgE2E.avg_days).toFixed(1)) : null,
    stage_funnel: funnel.results ?? [],
    csat_trend: csatTrend.results ?? [],
  });
});

// ── List ──────────────────────────────────────────────────────

app.get("/", requireServiceCaseAccess(), async (c) => {
  const assignedToParam = c.req.query("assigned_to");
  const result = await listAssrCases(c.env, {
    visible_to_user_ids: await assrVisibleUserIds(c),
    allowed_company_ids: allowedCompanyIds(c),
    stage: c.req.query("stage"),
    status: c.req.query("status"),
    search: c.req.query("search"),
    assigned_to: assignedToParam ? parseInt(assignedToParam, 10) : undefined,
    creditor_code: c.req.query("creditor_code") || undefined,
    page: parseInt(c.req.query("page") || "1", 10),
    per_page: parseInt(c.req.query("per_page") || "50", 10),
    include_archived: c.req.query("include_archived") === "1",
    exclude_stage: c.req.query("exclude_stage") || undefined,
    sort_by: c.req.query("sort_by") || undefined,
    sort_dir: (c.req.query("sort_dir") || "").toLowerCase() === "asc" ? "asc" : "desc",
  });
  return c.json(result);
});

// Manually re-run the item → creditor lookup for a single case.
// Useful for backfilling existing cases whose creditor_code is null
// (e.g. cases created before the auto-resolve hook shipped).
app.post("/:id/resolve-creditor", requirePermission("service_cases.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);

  const row = await c.env.DB.prepare(
    `SELECT item_code FROM assr_cases WHERE id = ? AND archived_at IS NULL`
  )
    .bind(id)
    .first<{ item_code: string | null }>();
  if (!row) return c.json({ error: "Case not found" }, 404);
  if (!row.item_code)
    return c.json({ error: "Case has no item_code — set one first" }, 400);

  try {
    const { resolveCreditorForCase } = await import("../services/stockItems");
    const creditorCode = await resolveCreditorForCase(c.env, id, row.item_code);
    return c.json({
      ok: true,
      item_code: row.item_code,
      creditor_code: creditorCode,
      message: creditorCode
        ? `Resolved ${row.item_code} → ${creditorCode}`
        : `${row.item_code} has no MainSupplier in AutoCount`,
    });
  } catch {
    // Plain-language rule: never surface raw exception text to the user.
    return c.json({ error: "Couldn't reach AutoCount to resolve the supplier. Try again shortly." }, 502);
  }
});

// ── Cases grouped by creditor ────────────────────────────────
// Feeds the "By Creditor" tab. One row per creditor_code with open /
// closed / breached counts, joined to the creditors mirror for the
// display name. Null creditor_code (unresolved) rolls up into a
// separate `unassigned` bucket so the caller can surface it.
app.get("/by-creditor", requirePermission("service_cases.read"), async (c) => {
  const search = (c.req.query("search") || "").trim();
  const like = search ? `%${search}%` : null;
  const coC = allowedCompaniesSql(c, "c.company_id");

  const rowsQ = c.env.DB.prepare(
    `SELECT c.creditor_code,
            cr.company_name AS creditor_name,
            cr.email        AS email,
            cr.phone1       AS phone,
            COUNT(*) AS total,
            SUM(CASE WHEN c.stage != 'completed' THEN 1 ELSE 0 END) AS open,
            SUM(CASE WHEN c.stage  = 'completed' THEN 1 ELSE 0 END) AS closed,
            SUM(CASE WHEN c.stage != 'completed'
                      AND c.deadline_at IS NOT NULL
                      AND datetime('now') > c.deadline_at THEN 1 ELSE 0 END) AS breached,
            MAX(c.updated_at) AS last_activity_at
       FROM assr_cases c
       LEFT JOIN creditors cr ON cr.creditor_code = c.creditor_code
      WHERE c.archived_at IS NULL
        AND c.creditor_code IS NOT NULL${coC}
        ${like ? "AND (cr.company_name LIKE ? OR c.creditor_code LIKE ?)" : ""}
      GROUP BY c.creditor_code
      ORDER BY total DESC, creditor_name ASC`
  );
  const rows = like
    ? await rowsQ.bind(like, like).all()
    : await rowsQ.all();

  const unassigned = await c.env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN stage != 'completed' THEN 1 ELSE 0 END) AS open
       FROM assr_cases
      WHERE archived_at IS NULL AND (creditor_code IS NULL OR creditor_code = '')${allowedCompaniesSql(c)}`
  ).first<{ total: number; open: number }>();

  return c.json({
    rows: rows.results ?? [],
    unassigned: {
      total: unassigned?.total ?? 0,
      open: unassigned?.open ?? 0,
    },
  });
});

// ── Bulk actions ──────────────────────────────────────────────
// Operate on a list of case IDs in one request. Each item is best-effort:
// failures are collected per-id rather than aborting the batch, so a stale
// row in the selection (e.g. someone else just archived it) doesn't kill
// the rest. Returns counts + per-id errors so the UI can show a useful
// summary toast.

async function bulkRun(
  ids: number[],
  fn: (id: number) => Promise<void>
): Promise<{ ok: number; failed: { id: number; error: string }[] }> {
  let ok = 0;
  const failed: { id: number; error: string }[] = [];
  for (const id of ids) {
    try {
      await fn(id);
      ok++;
    } catch (e: any) {
      failed.push({ id, error: e?.message || String(e) });
    }
  }
  return { ok, failed };
}

app.post("/bulk/archive", requirePermission("service_cases.manage"), async (c) => {
  const userId = (c as any).get?.("userId") ?? null;
  const body = await c.req.json<{ ids?: number[] }>();
  const ids = (body.ids || []).filter((n) => Number.isInteger(n));
  if (!ids.length) return c.json({ error: "ids[] required" }, 400);
  const result = await bulkRun(ids, async (id) => {
    await c.env.DB.prepare(
      `UPDATE assr_cases
          SET archived_at = datetime('now'), archived_by = ?, updated_at = datetime('now')
        WHERE id = ? AND archived_at IS NULL`
    )
      .bind(userId, id)
      .run();
  });
  return c.json(result);
});

app.post("/bulk/unarchive", requirePermission("service_cases.manage"), async (c) => {
  const body = await c.req.json<{ ids?: number[] }>();
  const ids = (body.ids || []).filter((n) => Number.isInteger(n));
  if (!ids.length) return c.json({ error: "ids[] required" }, 400);
  const result = await bulkRun(ids, async (id) => {
    await c.env.DB.prepare(
      `UPDATE assr_cases
          SET archived_at = NULL, archived_by = NULL, updated_at = datetime('now')
        WHERE id = ? AND archived_at IS NOT NULL`
    )
      .bind(id)
      .run();
  });
  return c.json(result);
});

app.post("/bulk/assign", requirePermission("service_cases.manage"), async (c) => {
  const userId = (c as any).get?.("userId") ?? null;
  const body = await c.req.json<{ ids?: number[]; assigned_to?: number | null }>();
  const ids = (body.ids || []).filter((n) => Number.isInteger(n));
  if (!ids.length) return c.json({ error: "ids[] required" }, 400);
  const assigneeId = body.assigned_to ?? null;
  const result = await bulkRun(ids, async (id) => {
    await c.env.DB.prepare(
      `UPDATE assr_cases SET assigned_to = ?, updated_at = datetime('now') WHERE id = ?`
    )
      .bind(assigneeId, id)
      .run();
    await c.env.DB.prepare(
      `INSERT INTO assr_activity (assr_id, action, from_value, to_value, note, user_id)
       VALUES (?, 'assignment', NULL, ?, 'bulk', ?)`
    )
      .bind(id, String(assigneeId ?? ""), userId)
      .run();
  });
  return c.json(result);
});

// ── CSV export ────────────────────────────────────────────────
// Returns the full filtered case list (capped at 10k rows) as CSV.
// Honors the same filters as the list endpoint so "what you see is
// what you export" matches the table.

app.get("/export.csv", requireServiceCaseAccess(), async (c) => {
  const rows = await exportAssrCases(c.env, {
    visible_to_user_ids: await assrVisibleUserIds(c),
    allowed_company_ids: allowedCompanyIds(c),
    stage: c.req.query("stage"),
    status: c.req.query("status"),
    search: c.req.query("search"),
    include_archived: c.req.query("include_archived") === "1",
    exclude_stage: c.req.query("exclude_stage") || undefined,
  });
  const headers = [
    "ASSR No", "SO No", "Stage", "Status", "Priority",
    "Customer", "Phone", "Location",
    "Category", "NCR Category", "Resolution",
    "Item", "Issue",
    "Complained Date", "Created", "Deadline",
    "PO Amount", "PO No",
    "Assigned To", "Created By", "Creditor",
    "SLA Breached",
  ];
  const fields = [
    "assr_no", "doc_no", "stage", "status", "priority",
    "customer_name", "customer_phone", "location",
    "service_category", "ncr_category", "resolution_method",
    "item_code", "complaint_issue",
    "complained_date", "created_at", "deadline_at",
    "po_amount", "po_no",
    "assigned_to_name", "created_by_name", "creditor_name",
    "is_breached",
  ];
  const esc = (v: any) => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(",")];
  for (const r of rows as any[]) {
    lines.push(fields.map((f) => esc(r[f])).join(","));
  }
  const csv = "\uFEFF" + lines.join("\r\n");
  const date = new Date().toISOString().slice(0, 10);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="service-cases-${date}.csv"`,
    },
  });
});

// ── SO item lookup ────────────────────────────────────────────

app.get("/lookup-items/:docNo", requireServiceCaseAccess(), async (c) => {
  const docNo = c.req.param("docNo");
  const items = await lookupSOItems(c.env, docNo);
  return c.json({ items });
});

// ── SO search (typeahead for create-case intake) ──────────────
// Returns up to 20 SO candidates matched by partial DocNo,
// reference number, or customer name (case-insensitive). Reads
// the local mirror so the create form can suggest matches
// without hitting AutoCount on every keystroke.
app.get("/search-so", requireServiceCaseAccess(), async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  if (q.length < 2) return c.json({ results: [] });
  const pattern = `%${q.toLowerCase()}%`;
  const rows = await c.env.DB.prepare(
    `SELECT doc_no, ref, debtor_name, phone, doc_date, sales_agent
       FROM sales_orders
      WHERE LOWER(doc_no) LIKE ?
         OR LOWER(COALESCE(ref, '')) LIKE ?
         OR LOWER(COALESCE(debtor_name, '')) LIKE ?
      ORDER BY doc_date DESC
      LIMIT 20`
  )
    .bind(pattern, pattern, pattern)
    .all();
  return c.json({ results: rows.results ?? [] });
});

// ── My Cases (sales-side portal) ──────────────────────────────
// Lists cases where the logged-in user's name substring-matches
// assr_cases.sales_agent. sales_agent is a free text field
// mirrored from AutoCount (mig 010), typically the rep's name;
// this endpoint bridges it to our user account.
app.get("/my-cases", requireServiceCaseAccess(), async (c) => {
  const userId = (c as any).get?.("userId") ?? 0;
  if (!userId) return c.json({ cases: [] });
  const userRow = await c.env.DB.prepare(
    `SELECT name FROM users WHERE id = ?`
  )
    .bind(userId)
    .first<{ name: string | null }>();
  const name = (userRow?.name || "").trim();
  if (!name) return c.json({ cases: [] });
  const rows = await c.env.DB.prepare(
    `SELECT id, assr_no, stage, status, priority, doc_no,
            customer_name, phone, complained_date, deadline_at,
            complaint_issue, item_code, sales_agent
       FROM assr_cases
      WHERE LOWER(COALESCE(sales_agent, '')) LIKE ?
        AND archived_at IS NULL${allowedCompaniesSql(c)}
      ORDER BY complained_date DESC, id DESC
      LIMIT 200`
  )
    .bind(`%${name.toLowerCase()}%`)
    .all();
  return c.json({ cases: rows.results ?? [], user_name: name });
});

// ── Sales comment ─────────────────────────────────────────────
// Sales rep posts a comment on a case they own (matched by
// sales_agent). Lands in assr_activity with source_channel=
// 'sales_portal' so the timeline distinguishes it from staff /
// customer / supplier notes.
app.post("/:id{[0-9]+}/sales-comment", requireServiceCaseAccess(), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  // Scope guard — this append-only write must be limited to cases the caller
  // may see (self + downline; directors/admins unrestricted). Out-of-scope →
  // 404, indistinguishable from a nonexistent id (mirrors the detail GET).
  if (!(await caseInCallerScope(c, id))) return c.json({ error: "Not found" }, 404);
  const userId = (c as any).get?.("userId") ?? 0;
  const body = await c.req.json<{ text?: string }>().catch(() => ({} as { text?: string }));
  const text = (body.text || "").trim();
  if (!text) return c.json({ error: "Comment cannot be empty" }, 400);
  if (text.length > 2000) return c.json({ error: "Comment is too long" }, 400);
  await c.env.DB.prepare(
    `INSERT INTO assr_activity (assr_id, action, note, category, source_channel, user_id)
     VALUES (?, 'sales_comment', ?, 'system', 'sales_portal', ?)`
  )
    .bind(id, text, userId || null)
    .run();
  return c.json({ ok: true }, 201);
});

// ── Sales nudge ───────────────────────────────────────────────
// One-tap "poke the office" from the sales portal — the rep can't
// dispatch or reassign but they can flag that the customer is on
// their case, so ops treats the row as fresh. Rate-limited to one
// nudge per hour per case so it stays useful (spam ≠ signal).
app.post("/:id{[0-9]+}/sales-nudge", requireServiceCaseAccess(), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  // Scope guard — same as sales-comment: only nudge cases the caller may see.
  if (!(await caseInCallerScope(c, id))) return c.json({ error: "Not found" }, 404);
  const userId = (c as any).get?.("userId") ?? 0;
  const body = await c.req.json<{ text?: string }>().catch(() => ({} as { text?: string }));
  const note = (body.text || "").trim().slice(0, 500) || "Sales rep is asking for an update.";
  const cutoffIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const recent = await c.env.DB.prepare(
    `SELECT id FROM assr_activity
      WHERE assr_id = ?
        AND action = 'sales_nudge'
        AND source_channel = 'sales_portal'
        AND created_at > ?
      LIMIT 1`
  )
    .bind(id, cutoffIso)
    .first<{ id: number }>();
  if (recent?.id) {
    return c.json({ error: "Ops was already nudged for this case within the last hour." }, 429);
  }
  await c.env.DB.prepare(
    `INSERT INTO assr_activity (assr_id, action, note, category, source_channel, user_id)
     VALUES (?, 'sales_nudge', ?, 'system', 'sales_portal', ?)`
  )
    .bind(id, note, userId || null)
    .run();
  return c.json({ ok: true }, 201);
});

// ── Detail ────────────────────────────────────────────────────

// Numeric-only guard on the catch-all detail route. Hono's
// RegExpRouter is order-sensitive — declaring `/:id` before
// `/metrics` lets `/:id` swallow `GET /api/assr/metrics` because
// "metrics" matches the param. The `{[0-9]+}` constraint scopes the
// param to digits so /metrics + any future literal route under
// /api/assr falls through to its dedicated handler.
app.get("/:id{[0-9]+}", requireServiceCaseAccess(), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const detail = await getAssrDetail(c.env, id);
  if (!detail) return c.json({ error: "Not found" }, 404);
  /* Multi-company: the case must belong to one of the caller's ALLOWED
     companies (same widen-not-isolate rule as the list). Skipped when either
     side is unresolved (pre-migration / D1 test mirror). Out-of-scope answers
     404, indistinguishable from a nonexistent id. */
  const allowedCo = allowedCompanyIds(c);
  if (allowedCo.length > 0) {
    const caseRow = (detail as { case?: Record<string, unknown> }).case ?? {};
    const caseCo = Number(
      (caseRow as any).companyId ?? (caseRow as any).company_id ?? NaN,
    );
    if (Number.isFinite(caseCo) && !allowedCo.includes(caseCo)) {
      return c.json({ error: "Not found" }, 404);
    }
  }
  /* Row-level visibility — same rule as the list: a scoped caller may open
     only cases created by / assigned to them or their downline. Out-of-scope
     answers 404, indistinguishable from a nonexistent id (mirrors the SCM SO
     detail behavior). Dual-read camelCase ?? snake_case — the PG driver
     camelCases result columns. */
  const visibleIds = await assrVisibleUserIds(c);
  if (visibleIds !== undefined) {
    const row = (detail as { case?: Record<string, unknown> }).case ?? (detail as Record<string, unknown>);
    const createdBy = Number((row as any).createdBy ?? (row as any).created_by ?? NaN);
    const assignedTo = Number((row as any).assignedTo ?? (row as any).assigned_to ?? NaN);
    // Co-assignee (assigned_to_2) — the LIST scopes on it too (services/assr.ts),
    // so a co-assignee who sees the case in their list must be able to open it.
    const assignedTo2 = Number((row as any).assignedTo2 ?? (row as any).assigned_to_2 ?? NaN);
    const inScope =
      (Number.isFinite(createdBy) && visibleIds.includes(createdBy)) ||
      (Number.isFinite(assignedTo) && visibleIds.includes(assignedTo)) ||
      (Number.isFinite(assignedTo2) && visibleIds.includes(assignedTo2));
    if (!inScope) return c.json({ error: "Not found" }, 404);
  }
  return c.json(detail);
});

// ── Supplier rating ──────────────────────────────────────────
// Posted from the Close-Case prompt when the case had a supplier
// assigned. Stored on the case row (one rating per case) and
// stamped with the rater + timestamp for audit. Re-posting the
// same case overwrites — staff can correct a misclick.

// ── Customer history ──────────────────────────────────────────
// Returns prior cases for the same customer (matched on phone if
// present, otherwise on exact name) so staff can spot repeat
// complaints. Excludes the current case and archived rows.

app.get("/:id/customer-history", requireServiceCaseAccess(), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  // Column is `phone`, not `customer_phone` — pre-v3.1 naming kept for
  // SQL compatibility. Same applies to the WHERE below.
  const cur = await c.env.DB.prepare(
    `SELECT customer_name, phone FROM assr_cases WHERE id = ?`
  )
    .bind(id)
    .first<{ customer_name: string | null; phone: string | null }>();
  if (!cur) return c.json({ error: "Not found" }, 404);
  /* Go-live review #11 — same fix as /cost-suggestion: admit a scoped Sales
     viewer of this case (requireServiceCaseAccess + case-in-scope) instead of
     403-ing on the raw service_cases.read permission. */
  if (!(await caseInCallerScope(c, id))) return c.json({ error: "Not found" }, 404);

  const phone = (cur.phone || "").trim();
  const name = (cur.customer_name || "").trim();
  if (!phone && !name) return c.json({ cases: [] });

  const where: string[] = ["c.id != ?", "c.archived_at IS NULL"];
  const binds: any[] = [id];
  if (phone) {
    where.push("c.phone = ?");
    binds.push(phone);
  } else {
    where.push("c.customer_name = ?");
    binds.push(name);
  }
  const rows = await c.env.DB.prepare(
    `SELECT c.id, c.assr_no, c.doc_no, c.stage, c.status, c.priority,
            c.complaint_issue, c.complained_date, c.created_at, c.item_code,
            c.resolution_method
       FROM assr_cases c
      WHERE ${where.join(" AND ")}${allowedCompaniesSql(c, "c.company_id")}
      ORDER BY c.id DESC
      LIMIT 25`
  )
    .bind(...binds)
    .all();
  return c.json({ cases: rows.results ?? [] });
});

// ── Create ────────────────────────────────────────────────────

app.post(
  "/",
  // Owner rule 8: Sales may CREATE cases too. Widen the existing create/write/
  // manage gate to also admit Sales / director (canAccessServiceCases). The new
  // case is stamped created_by = caller, so the creator owns it and the
  // self+downline data scope (rule 9) lets them see it afterwards.
  requireServiceCaseAccess([
    "service_cases.create",
    "service_cases.write",
    "service_cases.manage",
  ]),
  async (c) => {
  const userId = (c as any).get?.("userId") ?? 0;
  const body = await c.req.json<{
    doc_no: string;
    items?: { item_code: string; item_description?: string; qty?: number }[];
    item_code?: string;
    complaint_issue: string;
    issue_category?: string | null;
    priority?: string | null;
    complained_date?: string | null;
    ref_no?: string | null;
    customer_email?: string | null;
    service_category?: string | null;
    assigned_to?: number | null;
  }>();

  if (!body.doc_no || !body.complaint_issue) {
    return c.json({ error: "doc_no and complaint_issue are required" }, 400);
  }

  // Support both old format (item_code string) and new (items array)
  const items = body.items?.length
    ? body.items
    : body.item_code
    ? [{ item_code: body.item_code }]
    : [];

  if (!items.length) {
    return c.json({ error: "At least one item is required" }, 400);
  }

  // Normalise the intake extras: trim strings to null, coerce the
  // assignee to a valid positive integer or null. Null-safe so the
  // existing minimal create flow (no extras) is unaffected.
  const trimOrNull = (v: unknown): string | null => {
    if (typeof v !== "string") return null;
    const t = v.trim();
    return t.length ? t : null;
  };
  let assignedTo: number | null = null;
  if (body.assigned_to != null) {
    const n =
      typeof body.assigned_to === "number"
        ? body.assigned_to
        : parseInt(String(body.assigned_to), 10);
    if (Number.isFinite(n) && n > 0) assignedTo = n;
  }

  const result = await createAssrCase(c.env, {
    doc_no: body.doc_no,
    items,
    complaint_issue: body.complaint_issue,
    issue_category: body.issue_category ?? null,
    priority: body.priority ?? null,
    complained_date: trimOrNull(body.complained_date),
    ref_no: trimOrNull(body.ref_no),
    customer_email: trimOrNull(body.customer_email),
    service_category: trimOrNull(body.service_category),
    assigned_to: assignedTo,
    created_by: userId,
    // Multi-company (Phase 0b): stamp the request's active company on the new
    // case. Undefined pre-migration / cold-start -> createAssrCase falls back
    // to the Houzs default, else omits the column (single-company safe).
    company_id: activeCompanyId(c),
  });
  return c.json(result, 201);
});

// ── Patch ─────────────────────────────────────────────────────

// Same digit-only constraint as the GET — keeps any future literal
// route under /api/assr (e.g. /metrics, /summary) reachable when the
// methods overlap.
app.patch("/:id{[0-9]+}", requirePermission("service_cases.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const userId = (c as any).get?.("userId") ?? 0;
  const body = await c.req.json<Record<string, any>>();
  const ok = await patchAssrCase(c.env, id, body, userId);
  if (!ok) return c.json({ error: "Not found or no changes" }, 404);
  return c.json({ ok: true });
});

// ── Mark opened by Service Admin ──────────────────────────────
// Frontend fires this when the detail page mounts. Server checks
// the case is still at pending_review; if so it auto-advances to
// under_verification and stamps the activity log. Requires write
// permission so a read-only viewer opening the case doesn't kick
// the stage — Sales sees pending_review, SA opening it advances.
app.post("/:id{[0-9]+}/mark-opened", requirePermission("service_cases.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const userId = (c as any).get?.("userId") ?? 0;
  const advanced = await markCaseOpened(c.env, id, userId);
  return c.json({ advanced });
});

// ── Generate a staff-sourced portal tracking link ─────────────
// Dispatcher clicks "Copy portal link" — returns a token that the
// frontend turns into a full URL, then copied into WhatsApp. 30-day
// TTL so the customer can reopen it over the life of the case.
app.post("/:id/track-link", requirePermission("service_cases.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const exists = await c.env.DB.prepare(
    `SELECT id FROM assr_cases WHERE id = ?`
  )
    .bind(id)
    .first();
  if (!exists) return c.json({ error: "Not found" }, 404);
  const token = await issueStaffToken(c.env, id);
  return c.json({ token, path: `/portal/case/${token}` }, 201);
});

// ── Sales portal link ─────────────────────────────────────────
// Same per-case portal as the customer link but source='sales' —
// the portal shows the salesperson variant (full stage progress,
// comments attributed to sales). Idempotent per case.
app.post("/:id/sales-link", requirePermission("service_cases.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const exists = await c.env.DB.prepare(
    `SELECT id FROM assr_cases WHERE id = ?`
  )
    .bind(id)
    .first();
  if (!exists) return c.json({ error: "Not found" }, 404);
  const token = await issueSalesToken(c.env, id);
  return c.json({ token, path: `/portal/case/${token}` }, 201);
});

// ── Supplier portal link (v3.1) ───────────────────────────────
//
// Idempotent: re-clicking the button returns the existing active
// token. Scoped to the case's resolved creditor_code so the supplier
// only sees jobs assigned to them.

app.post("/:id/supplier-link", requirePermission("service_cases.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const row = await c.env.DB.prepare(
    `SELECT id, creditor_code FROM assr_cases WHERE id = ?`
  )
    .bind(id)
    .first<{ id: number; creditor_code: string | null }>();
  if (!row) return c.json({ error: "Not found" }, 404);
  const { issueSupplierToken } = await import("../services/supplierPortal");
  const token = await issueSupplierToken(c.env, id, row.creditor_code);
  return c.json({ token, path: `/portal/supplier/${token}` }, 201);
});

// ── Generate satisfaction survey token ────────────────────────

app.post("/:id/survey-token", requirePermission("service_cases.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const token = await issueSurveyToken(c.env, id);
  return c.json({ token });
});

// ── Soft-delete (archive) endpoints ───────────────────────────
// No rows are ever physically deleted. Archive stamps archived_at +
// archived_by; restore clears them. Default queries skip archived
// rows so the UI is clean without losing data or audit trail.

async function setArchived(
  env: Env,
  table: string,
  where: string,
  binds: any[],
  userId: number | null,
  archive: boolean
): Promise<boolean> {
  const r = await env.DB.prepare(
    archive
      ? `UPDATE ${table}
            SET archived_at = datetime('now'),
                archived_by = ?
          WHERE ${where} AND archived_at IS NULL`
      : `UPDATE ${table}
            SET archived_at = NULL,
                archived_by = NULL
          WHERE ${where} AND archived_at IS NOT NULL`
  )
    .bind(...(archive ? [userId, ...binds] : binds))
    .run();
  return (r.meta.changes ?? 0) > 0;
}

// Case — archive/unarchive. Manager-level (service_cases.manage).
app.post("/:id/archive", requirePermission("service_cases.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const userId = (c as any).get?.("userId") ?? 0;
  const ok = await setArchived(c.env, "assr_cases", "id = ?", [id], userId || null, true);
  if (!ok) return c.json({ error: "Not found or already archived" }, 404);
  await logActivity(c.env, id, "archived", null, null, null, userId || null);
  return c.json({ ok: true });
});

app.post("/:id/unarchive", requirePermission("service_cases.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const userId = (c as any).get?.("userId") ?? 0;
  const ok = await setArchived(c.env, "assr_cases", "id = ?", [id], userId || null, false);
  if (!ok) return c.json({ error: "Not found or not archived" }, 404);
  await logActivity(c.env, id, "unarchived", null, null, null, userId || null);
  return c.json({ ok: true });
});

// Logistics entry archive.
app.post("/:id/logistics/:logId/archive", requirePermission("service_cases.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const logId = parseInt(c.req.param("logId"), 10);
  if (isNaN(id) || isNaN(logId)) return c.json({ error: "Invalid ID" }, 400);
  const userId = (c as any).get?.("userId") ?? 0;
  const ok = await setArchived(
    c.env,
    "assr_logistics",
    "id = ? AND assr_id = ?",
    [logId, id],
    userId || null,
    true
  );
  if (!ok) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// Attachment archive — hard replacement for the old "delete" wish.
app.post("/attachments/:attId/archive", requirePermission("service_cases.write"), async (c) => {
  const attId = parseInt(c.req.param("attId"), 10);
  if (isNaN(attId)) return c.json({ error: "Invalid ID" }, 400);
  const userId = (c as any).get?.("userId") ?? 0;
  const ok = await setArchived(
    c.env,
    "assr_attachments",
    "id = ?",
    [attId],
    userId || null,
    true
  );
  if (!ok) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// Activity archive — only non-system actions (notes, customer and
// sales comments). Stage transitions, created, approval, po_generated,
// escalated, survey_submitted are all part of the audit trail and
// must not be archive-able.
const ARCHIVABLE_ACTIONS = new Set(["note", "customer_comment", "sales_comment"]);

app.post("/activity/:actId/archive", requirePermission("service_cases.write"), async (c) => {
  const actId = parseInt(c.req.param("actId"), 10);
  if (isNaN(actId)) return c.json({ error: "Invalid ID" }, 400);
  const userId = (c as any).get?.("userId") ?? 0;

  const row = await c.env.DB.prepare(
    `SELECT action FROM assr_activity WHERE id = ?`
  )
    .bind(actId)
    .first<{ action: string }>();
  if (!row) return c.json({ error: "Not found" }, 404);
  if (!ARCHIVABLE_ACTIONS.has(row.action)) {
    return c.json({ error: "This activity entry is part of the audit trail and cannot be archived" }, 403);
  }

  const ok = await setArchived(
    c.env,
    "assr_activity",
    "id = ?",
    [actId],
    userId || null,
    true
  );
  if (!ok) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// ── Toggle an attachment's visibility to the portal customer ──
// Lets staff hide an internal photo so it doesn't show up on the
// customer's portal view of the case.
app.patch("/attachments/:attId/visibility", requirePermission("service_cases.write"), async (c) => {
  const attId = parseInt(c.req.param("attId"), 10);
  if (isNaN(attId)) return c.json({ error: "Invalid ID" }, 400);
  const body = await c.req
    .json<{ visible_to_customer?: boolean }>()
    .catch(() => ({} as { visible_to_customer?: boolean }));
  if (typeof body.visible_to_customer !== "boolean") {
    return c.json({ error: "visible_to_customer is required" }, 400);
  }
  const r = await c.env.DB.prepare(
    `UPDATE assr_attachments SET visible_to_customer = ? WHERE id = ?`
  )
    .bind(body.visible_to_customer ? 1 : 0, attId)
    .run();
  if (!r.meta.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// ── Manual SLA escalation sweep ───────────────────────────────

app.post("/run-escalation", requirePermission("service_cases.manage"), async (c) => {
  const result = await runSlaEscalation(c.env);
  return c.json(result);
});

// ── Quality metrics (for manager dashboard) ───────────────────

app.get("/metrics", requirePermission("service_cases.read"), async (c) => {
  const sinceDays = Math.min(730, Math.max(1, parseInt(c.req.query("since_days") || "90", 10) || 90));
  // Period filter falls back to created_at when complained_date is
  // NULL — legacy rows + manual SQL inserts often skipped the intake
  // date, so a strict `complained_date >= …` was silently excluding
  // them from EVERY window (which makes 30d / 90d / 365d look identical
  // because the same too-small subset survives the filter).
  const sinceFor = (prefix = "") =>
    `AND COALESCE(${prefix}complained_date, ${prefix}created_at) >= date('now', '-${sinceDays} days')`;
  const sinceClause = sinceFor();
  // Allowed-companies predicates per table alias ("" when unresolved).
  const coBare = allowedCompaniesSql(c);
  const coC = allowedCompaniesSql(c, "c.company_id");
  const coA = allowedCompaniesSql(c, "a.company_id");

  // Headline numbers. avg_resolution_hours filters out legacy rows
  // where julianday(closed_at) <= julianday(created_at) (corrupt
  // timestamps from old imports) OR the diff exceeds 1 year — a
  // healthy ASSR case never takes that long, so it's almost certainly
  // a data anomaly skewing the mean.
  const headline = await c.env.DB.prepare(
    `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN stage = 'completed' THEN 1 ELSE 0 END) as closed,
        SUM(CASE WHEN stage != 'completed' THEN 1 ELSE 0 END) as open_count,
        SUM(CASE WHEN stage != 'completed' AND deadline_at IS NOT NULL
                  AND datetime('now') > deadline_at THEN 1 ELSE 0 END) as breached,
        SUM(CASE WHEN quality_review_passed = 1 THEN 1 ELSE 0 END) as qa_passed,
        AVG(CASE WHEN stage = 'completed' AND closed_at IS NOT NULL
                  AND julianday(closed_at) > julianday(created_at)
                  AND (julianday(closed_at) - julianday(created_at)) < 365
                  THEN (julianday(closed_at) - julianday(created_at)) * 24
                  END) as avg_resolution_hours,
        AVG(CASE WHEN satisfaction_rating IS NOT NULL THEN satisfaction_rating END) as avg_satisfaction
      FROM assr_cases
     WHERE 1=1 ${sinceClause}${coBare}`
  ).first();

  // NCR category breakdown — engineering taxonomy (material_defect /
  // workmanship / transit_damage / …). Used for quality root-cause
  // analysis. Distinct from `issue_category` below, which is the
  // customer-facing category captured at intake.
  const ncr = await c.env.DB.prepare(
    `SELECT COALESCE(ncr_category, 'unclassified') as category, COUNT(*) as count
       FROM assr_cases
      WHERE 1=1 ${sinceClause}${coBare}
      GROUP BY ncr_category
      ORDER BY count DESC`
  ).all();

  // Customer-facing issue category — what the dashboards in the legacy
  // Excel called "Service issues category". One row per ISSUE_CATEGORIES
  // value (Product defect / Incorrect item delivered / etc.) plus an
  // "Other" bucket for anything else.
  const issueCategories = await c.env.DB.prepare(
    `SELECT COALESCE(issue_category, 'Other') as category, COUNT(*) as count
       FROM assr_cases
      WHERE 1=1 ${sinceClause}${coBare}
      GROUP BY issue_category
      ORDER BY count DESC`
  ).all();

  // Case Duration buckets — mirrors the legacy Excel "Case Duration"
  // tile. All counts are *open* cases (stage != 'completed') bucketed by
  // age since complaint date. The buckets are non-overlapping so the
  // sum + still-younger-than-2wks == opening_count.
  //
  // avg_per_month is the rolling monthly intake over the last 4 months
  // (matching the Excel formula `monthly_case/month (last 4 month data)`).
  const caseDuration = await c.env.DB.prepare(
    `SELECT
        SUM(CASE WHEN stage != 'completed' THEN 1 ELSE 0 END) AS opening_count,
        SUM(CASE WHEN stage != 'completed'
                  AND complained_date IS NOT NULL
                  AND julianday('now') - julianday(complained_date) >= 30
                 THEN 1 ELSE 0 END) AS over_1_month,
        SUM(CASE WHEN stage != 'completed'
                  AND complained_date IS NOT NULL
                  AND julianday('now') - julianday(complained_date) >= 21
                  AND julianday('now') - julianday(complained_date) < 30
                 THEN 1 ELSE 0 END) AS over_3_weeks,
        SUM(CASE WHEN stage != 'completed'
                  AND complained_date IS NOT NULL
                  AND julianday('now') - julianday(complained_date) >= 14
                  AND julianday('now') - julianday(complained_date) < 21
                 THEN 1 ELSE 0 END) AS over_2_weeks
       FROM assr_cases
      WHERE 1=1${coBare}`
  ).first<{
    opening_count: number;
    over_1_month: number;
    over_3_weeks: number;
    over_2_weeks: number;
  }>();

  const avgPerMonth = await c.env.DB.prepare(
    `SELECT CAST(COUNT(*) AS REAL) / 4.0 AS avg_per_month
       FROM assr_cases
      WHERE COALESCE(complained_date, created_at) >= date('now', '-4 months')${coBare}`
  ).first<{ avg_per_month: number | null }>();

  // Resolution method mix
  const resolutions = await c.env.DB.prepare(
    `SELECT COALESCE(resolution_method, 'unset') as method, COUNT(*) as count
       FROM assr_cases
      WHERE 1=1 ${sinceClause}${coBare}
      GROUP BY resolution_method
      ORDER BY count DESC`
  ).all();

  // Repeat offenders — items with >= 2 cases in window
  const repeatItems = await c.env.DB.prepare(
    `SELECT i.item_code,
            COUNT(DISTINCT i.assr_id) as cases,
            MAX(c.complained_date) as latest
       FROM assr_items i
       JOIN assr_cases c ON c.id = i.assr_id
      WHERE 1=1 ${sinceFor("c.")}${coC}
      GROUP BY i.item_code
      HAVING COUNT(DISTINCT i.assr_id) >= 2
      ORDER BY cases DESC, latest DESC
      LIMIT 20`
  ).all();

  // Repeat customers — customers with >= 2 cases in window
  const repeatCustomers = await c.env.DB.prepare(
    `SELECT customer_name, phone,
            COUNT(*) as cases,
            MAX(complained_date) as latest
       FROM assr_cases
      WHERE customer_name IS NOT NULL
        ${sinceClause}${coBare}
      GROUP BY customer_name, phone
      HAVING COUNT(*) >= 2
      ORDER BY cases DESC, latest DESC
      LIMIT 20`
  ).all();

  // Creditor performance (within window). Joined against the
  // creditors mirror via a.creditor_code rather than the old
  // suppliers table — creditor is now the source of truth.
  const creditorPerf = await c.env.DB.prepare(
    `SELECT a.creditor_code as creditor_code,
            cr.company_name as name,
            COUNT(DISTINCT a.id) as total_cases,
            SUM(CASE WHEN a.stage = 'completed' THEN 1 ELSE 0 END) as closed_cases,
            SUM(CASE WHEN a.stage != 'completed' AND a.deadline_at IS NOT NULL
                      AND datetime('now') > a.deadline_at THEN 1 ELSE 0 END) as breached,
            AVG(CASE WHEN a.satisfaction_rating IS NOT NULL
                      THEN a.satisfaction_rating END) as avg_rating,
            AVG(CASE WHEN a.stage = 'completed' AND a.closed_at IS NOT NULL
                      AND julianday(a.closed_at) > julianday(a.created_at)
                      AND (julianday(a.closed_at) - julianday(a.created_at)) < 365
                      THEN (julianday(a.closed_at) - julianday(a.created_at)) * 24
                      END) as avg_resolution_hours
       FROM assr_cases a
       LEFT JOIN creditors cr ON cr.creditor_code = a.creditor_code
      WHERE a.creditor_code IS NOT NULL
        ${sinceFor("a.")}${coA}
      GROUP BY a.creditor_code, cr.company_name
      ORDER BY total_cases DESC
      LIMIT 15`
  ).all();

  // Monthly trend (last 12 months of case opens). Use complained_date
  // when populated, fall back to created_at — legacy rows imported
  // before the intake form required complained_date have it NULL, and
  // excluding them left the chart blank for tenants whose oldest data
  // predated the form change. strftime returns NULL on bad inputs;
  // HAVING strips those rows so the chart never receives a NULL month.
  const trend = await c.env.DB.prepare(
    `SELECT strftime('%Y-%m', COALESCE(complained_date, created_at)) as month,
            COUNT(*) as opened,
            SUM(CASE WHEN stage = 'completed' THEN 1 ELSE 0 END) as closed
       FROM assr_cases
      WHERE COALESCE(complained_date, created_at) >= date('now', '-12 months')${coBare}
      GROUP BY month
      HAVING strftime('%Y-%m', COALESCE(complained_date, created_at)) IS NOT NULL
      ORDER BY month`
  ).all();

  return c.json({
    since_days: sinceDays,
    headline,
    ncr: ncr.results ?? [],
    issue_categories: issueCategories.results ?? [],
    resolutions: resolutions.results ?? [],
    repeat_items: repeatItems.results ?? [],
    repeat_customers: repeatCustomers.results ?? [],
    creditor_performance: creditorPerf.results ?? [],
    monthly_trend: trend.results ?? [],
    case_duration: {
      opening_count: caseDuration?.opening_count ?? 0,
      over_1_month: caseDuration?.over_1_month ?? 0,
      over_3_weeks: caseDuration?.over_3_weeks ?? 0,
      over_2_weeks: caseDuration?.over_2_weeks ?? 0,
      avg_per_month: avgPerMonth?.avg_per_month ?? null,
    },
  });
});

// ── Metric drill-down ─────────────────────────────────────────
//
// Returns the case list behind a single ServiceMetrics card. The
// frontend just passes which card was clicked (`metric=`) plus the
// active period window (`since_days=`, matching the dashboard's
// FilterPills) and the route resolves both into a WHERE clause.
//
// Response shape is slim — only what the side-panel rows render. The
// case detail page is fetched separately when the user clicks through.

const DRILL_METRICS = new Set([
  "pending_review",
  "aging",
  "breach_now",
  "open_now",
  "total_period",
  "closed_period",
  "breach_period",
  "qa_passed",
  "over_1_month",
  "over_3_weeks",
  "over_2_weeks",
  "opening_count",
  "customer_cases",
  "item_cases",
] as const);

app.get("/metrics/drill", requirePermission("service_cases.read"), async (c) => {
  const metric = (c.req.query("metric") || "").trim();
  if (!DRILL_METRICS.has(metric as any)) {
    return c.json({ error: `Unknown metric: ${metric}` }, 400);
  }
  const sinceDays = Math.min(730, Math.max(1, parseInt(c.req.query("since_days") || "90", 10) || 90));
  const limit = Math.min(parseInt(c.req.query("limit") || "100", 10), 500);

  // Collect WHERE fragments + their bind values together so user input
  // (customer_name / phone / item_code) is always parameterised. The
  // hard-coded `sinceDays` is parsed to an int above so interpolating
  // it into the SQL string is safe.
  const conds: string[] = ["c.archived_at IS NULL"];
  const binds: any[] = [];
  let joinItems = false;

  switch (metric) {
    case "pending_review":
      conds.push("c.stage = 'pending_review'");
      break;
    case "aging":
      conds.push(`c.stage != 'completed'
        AND julianday('now') - julianday(
              COALESCE(
                (SELECT MAX(a.created_at)
                   FROM assr_activity a
                  WHERE a.assr_id = c.id
                    AND a.action = 'stage_change'
                    AND a.to_value = c.stage),
                c.created_at
              )
            ) > 3`);
      break;
    case "breach_now":
      conds.push(`c.stage != 'completed'
        AND c.deadline_at IS NOT NULL
        AND datetime('now') > c.deadline_at`);
      break;
    case "open_now":
    case "opening_count":
      conds.push("c.stage != 'completed'");
      break;
    case "total_period":
      conds.push(`COALESCE(c.complained_date, c.created_at) >= date('now', '-${sinceDays} days')`);
      break;
    case "closed_period":
      conds.push(`c.stage = 'completed' AND COALESCE(c.complained_date, c.created_at) >= date('now', '-${sinceDays} days')`);
      break;
    case "breach_period":
      conds.push(`c.stage != 'completed'
        AND c.deadline_at IS NOT NULL
        AND datetime('now') > c.deadline_at
        AND COALESCE(c.complained_date, c.created_at) >= date('now', '-${sinceDays} days')`);
      break;
    case "qa_passed":
      conds.push(`c.quality_review_passed = 1 AND COALESCE(c.complained_date, c.created_at) >= date('now', '-${sinceDays} days')`);
      break;
    case "over_1_month":
      conds.push(`c.stage != 'completed'
        AND c.complained_date IS NOT NULL
        AND julianday('now') - julianday(c.complained_date) >= 30`);
      break;
    case "over_3_weeks":
      conds.push(`c.stage != 'completed'
        AND c.complained_date IS NOT NULL
        AND julianday('now') - julianday(c.complained_date) >= 21
        AND julianday('now') - julianday(c.complained_date) < 30`);
      break;
    case "over_2_weeks":
      conds.push(`c.stage != 'completed'
        AND c.complained_date IS NOT NULL
        AND julianday('now') - julianday(c.complained_date) >= 14
        AND julianday('now') - julianday(c.complained_date) < 21`);
      break;
    case "customer_cases": {
      // Repeat-customer drill — feeds the "Repeat Customers" panel
      // when a row is clicked. Match by name (required) and phone
      // (optional, mirroring how the metrics group identifies a
      // customer). Window by sinceDays so the panel matches the
      // count on the originating card.
      const name = (c.req.query("customer_name") || "").trim();
      const phone = (c.req.query("phone") || "").trim();
      if (!name) {
        return c.json({ error: "customer_name is required for customer_cases" }, 400);
      }
      conds.push(`c.customer_name = ? AND COALESCE(c.complained_date, c.created_at) >= date('now', '-${sinceDays} days')`);
      binds.push(name);
      if (phone) {
        conds.push("c.phone = ?");
        binds.push(phone);
      } else {
        // The metrics aggregate groups by (customer_name, phone) so a
        // NULL-phone row is its own bucket. Match the same shape here.
        conds.push("c.phone IS NULL");
      }
      break;
    }
    case "item_cases": {
      // Repeat-item drill — joins assr_items so we can filter by
      // item_code. Window by sinceDays for parity with the card.
      const code = (c.req.query("item_code") || "").trim();
      if (!code) {
        return c.json({ error: "item_code is required for item_cases" }, 400);
      }
      joinItems = true;
      conds.push(`i.item_code = ? AND COALESCE(c.complained_date, c.created_at) >= date('now', '-${sinceDays} days')`);
      binds.push(code);
      break;
    }
  }

  const fromClause = joinItems
    ? "FROM assr_cases c LEFT JOIN creditors cr ON cr.creditor_code = c.creditor_code JOIN assr_items i ON i.assr_id = c.id"
    : "FROM assr_cases c LEFT JOIN creditors cr ON cr.creditor_code = c.creditor_code";
  const distinct = joinItems ? "DISTINCT" : "";
  const where = conds.join(" AND ") + allowedCompaniesSql(c, "c.company_id");

  const rows = await c.env.DB.prepare(
    `SELECT ${distinct} c.id, c.assr_no, c.customer_name, c.stage, c.priority,
            c.complained_date, c.deadline_at, c.issue_category,
            c.creditor_code,
            cr.company_name AS creditor_name,
            (julianday('now') - julianday(c.complained_date)) AS age_days,
            CASE WHEN c.deadline_at IS NOT NULL AND datetime('now') > c.deadline_at
                 THEN 1 ELSE 0 END AS is_breached
       ${fromClause}
      WHERE ${where}
      ORDER BY c.complained_date DESC, c.id DESC
      LIMIT ${limit}`
  )
    .bind(...binds)
    .all();

  return c.json({
    metric,
    cases: rows.results ?? [],
    total: rows.results?.length ?? 0,
    limited: (rows.results?.length ?? 0) >= limit,
  });
});

// ── Auto-generate service PO number ───────────────────────────

app.post("/:id/generate-po", requirePermission("service_cases.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const userId = (c as any).get?.("userId") ?? 0;

  const existing = await c.env.DB.prepare(
    `SELECT po_no, supplier FROM assr_cases WHERE id = ?`
  )
    .bind(id)
    .first<{ po_no: string | null; supplier: string | null }>();
  if (!existing) return c.json({ error: "Not found" }, 404);

  if (existing.po_no) {
    return c.json({ error: `PO already exists: ${existing.po_no}`, po_no: existing.po_no }, 409);
  }

  const poNo = await nextServicePONumber(c.env);
  await c.env.DB.prepare(
    `UPDATE assr_cases SET po_no = ?, updated_at = datetime('now') WHERE id = ?`
  )
    .bind(poNo, id)
    .run();

  await logActivity(
    c.env,
    id,
    "po_generated",
    null,
    poNo,
    existing.supplier ? `Supplier: ${existing.supplier}` : null,
    userId
  );

  return c.json({ po_no: poNo }, 201);
});

// ── Manager approval / quality sign-off ───────────────────────

app.post("/:id/approve", requirePermission("service_cases.approve"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const userId = (c as any).get?.("userId") ?? 0;
  const body = await c.req.json<{
    quality_review_passed?: boolean;
    ncr_category?: string | null;
    note?: string;
  }>();

  const now = new Date().toISOString();
  const r = await c.env.DB.prepare(
    `UPDATE assr_cases
        SET approved_by = ?, approved_at = ?,
            quality_review_passed = ?,
            ncr_category = COALESCE(?, ncr_category),
            updated_at = datetime('now')
      WHERE id = ?`
  )
    .bind(
      userId || null,
      now,
      body.quality_review_passed == null ? null : body.quality_review_passed ? 1 : 0,
      body.ncr_category ?? null,
      id
    )
    .run();
  if (!r.meta.changes) return c.json({ error: "Not found" }, 404);

  // Log to activity trail so the timeline captures the sign-off.
  await c.env.DB.prepare(
    `INSERT INTO assr_activity (assr_id, action, from_value, to_value, note, user_id)
     VALUES (?, 'approval', NULL, ?, ?, ?)`
  )
    .bind(
      id,
      body.quality_review_passed ? "passed" : "review",
      body.note ?? null,
      userId || null
    )
    .run();

  return c.json({ ok: true, approved_at: now });
});

// ── Stage transition ──────────────────────────────────────────

app.post("/:id/transition", requirePermission("service_cases.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const userId = (c as any).get?.("userId") ?? 0;
  const body = await c.req.json<{ stage: string; note?: string }>();
  if (!body.stage) return c.json({ error: "stage is required" }, 400);

  try {
    const ok = await transitionStage(c.env, id, body.stage as any, userId, body.note);
    if (!ok) return c.json({ error: "Not found" }, 404);

    // Auto-dispatch satisfaction survey when case is completed.
    // Fire-and-forget: if email is disabled or the customer has no
    // survey recipient, the email service silently skips (and still
    // logs the attempt). Prefer `email_for_survey` (proposal §14 —
    // separate from notify channel) and fall back to `customer_email`.
    if (body.stage === "completed") {
      const row = await c.env.DB.prepare(
        `SELECT assr_no, customer_name, customer_email, email_for_survey, company_id
           FROM assr_cases WHERE id = ?`
      )
        .bind(id)
        .first<{
          assr_no: string;
          customer_name: string | null;
          customer_email: string | null;
          email_for_survey: string | null;
          company_id: number | null;
        }>();
      const surveyTo = row?.email_for_survey || row?.customer_email;
      if (surveyTo) {
        // Customer-facing: carry the DOCUMENT's company identity (the case
        // row's company_id), not the operator's active company.
        const caseCompanyCode = await resolveCompanyCode(c.env, row!.company_id);
        const token = await issueSurveyToken(c.env, id);
        const link = publicUrl(c.env, `/survey/${token}`, caseCompanyCode);
        const name = (row!.customer_name || "").split(" ")[0] || "there";
        await sendEmail(c.env, {
          to: surveyTo,
          subject: `How was your experience with case ${row!.assr_no}?`,
          html: surveyEmailHtml(name, row!.assr_no, link),
          purpose: "assr_survey",
          refType: "assr",
          refId: id,
          companyCode: caseCompanyCode,
        });
      }
    }
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

function surveyEmailHtml(name: string, assrNo: string, link: string): string {
  return `
    <div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#222">
      <h2 style="margin:0 0 12px">Thanks for your patience, ${name}.</h2>
      <p>We've wrapped up your service case <strong>${assrNo}</strong>. Your feedback helps us improve.</p>
      <p style="margin:24px 0">
        <a href="${link}"
           style="display:inline-block;padding:12px 22px;background:#a16a2e;color:#fff;border-radius:6px;text-decoration:none;font-weight:600">
          Rate your experience
        </a>
      </p>
      <p style="color:#777;font-size:13px">Takes about 30 seconds — one rating + an optional note.</p>
      <p style="color:#aaa;font-size:12px;border-top:1px solid #eee;padding-top:14px;margin-top:28px">
        Houzs Century Sdn. Bhd.
      </p>
    </div>`;
}

// ── Notes ─────────────────────────────────────────────────────

// Manual-note audience buckets (mig 0108). Legacy 'purchasing' from
// not-yet-refreshed clients maps to 'service'; unknown values fall back
// to 'service' too so nothing lands unclassified.
const NOTE_CATEGORIES = new Set(["service", "customer", "supplier", "sales"]);
function noteCategory(v?: string): "service" | "customer" | "supplier" | "sales" {
  if (v === "purchasing") return "service";
  return NOTE_CATEGORIES.has(v ?? "") ? (v as any) : "service";
}

app.post("/:id/notes", requirePermission("service_cases.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const userId = (c as any).get?.("userId") ?? 0;
  const body = await c.req.json<{
    note: string;
    category?: string;
  }>();
  if (!body.note?.trim()) return c.json({ error: "note is required" }, 400);
  // Manual notes pick an audience bucket (mig 0108): service (internal,
  // the old 'purchasing'), customer (portal-visible), supplier or sales.
  // 'system' is reserved for auto-emitted events, and anything unknown
  // (incl. the legacy 'purchasing' from stale clients) falls back to
  // 'service', so a misconfigured client can't impersonate an event.
  const category = noteCategory(body.category);
  await logActivity(c.env, id, "note", null, null, body.note, userId, {
    category,
    source_channel: "app",
  });
  return c.json({ ok: true });
});

// ── Service Log corrections (v3.1 mig 077) ────────────────────
//
// assr_activity is append-only: instead of editing a row, post a new
// "correction" entry that references the prior one. Useful for fixing
// a misposted note or stage_change without erasing the audit trail.

app.post("/:id/notes/:noteId/correct", requirePermission("service_cases.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const noteId = parseInt(c.req.param("noteId"), 10);
  if (isNaN(id) || isNaN(noteId)) return c.json({ error: "Invalid ID" }, 400);
  const userId = (c as any).get?.("userId") ?? 0;
  const body = await c.req.json<{ note: string; category?: string }>();
  if (!body.note?.trim()) return c.json({ error: "correction note is required" }, 400);

  // Verify the referenced entry belongs to this case.
  const prior = await c.env.DB.prepare(
    `SELECT id FROM assr_activity WHERE id = ? AND assr_id = ?`
  )
    .bind(noteId, id)
    .first<{ id: number }>();
  if (!prior) return c.json({ error: "Referenced entry not found on this case" }, 404);

  await logActivity(c.env, id, "note", null, null, body.note, userId, {
    category: noteCategory(body.category),
    source_channel: "app",
    references_entry_id: noteId,
    is_correction: true,
  });
  return c.json({ ok: true });
});

// ── Service Log export (CSV) ────────────────────────────────────
//
// Full audit trail for one case in CSV form. Manager-only — internal
// notes + supplier comms aren't customer-safe.

app.get("/:id/timeline.csv", requireServiceCaseAccess(), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);

  // Scope guard — a Sales caller admitted by org field may DOWNLOAD the timeline
  // of a case within their reporting chain (self + downline), but not an
  // arbitrary case. Out-of-scope → 404 (mirrors the detail GET). Directors /
  // service_cases.manage stay unrestricted (caseInCallerScope short-circuits).
  if (!(await caseInCallerScope(c, id))) return c.json({ error: "Not found" }, 404);

  const row = await c.env.DB.prepare(
    `SELECT assr_no FROM assr_cases WHERE id = ?`
  )
    .bind(id)
    .first<{ assr_no: string }>();
  if (!row) return c.json({ error: "Not found" }, 404);

  const rows = await c.env.DB.prepare(
    `SELECT a.id, a.created_at, a.action, a.category, a.source_channel,
            a.from_value, a.to_value, a.note,
            a.stage_elapsed_days, a.stage_target_days,
            a.is_correction, a.references_entry_id,
            u.name AS user_name
       FROM assr_activity a
       LEFT JOIN users u ON u.id = a.user_id
      WHERE a.assr_id = ? AND a.archived_at IS NULL
      ORDER BY a.created_at ASC, a.id ASC`
  )
    .bind(id)
    .all<any>();

  const lines: string[] = [
    [
      "id",
      "timestamp",
      "action",
      "category",
      "source_channel",
      "from",
      "to",
      "elapsed_days",
      "target_days",
      "user",
      "note",
      "is_correction",
      "references_entry_id",
    ].join(","),
  ];
  for (const r of rows.results ?? []) {
    const fields = [
      r.id,
      r.created_at,
      r.action,
      r.category,
      r.source_channel || "",
      r.from_value || "",
      r.to_value || "",
      r.stage_elapsed_days != null ? Number(r.stage_elapsed_days).toFixed(2) : "",
      r.stage_target_days != null ? Number(r.stage_target_days).toFixed(2) : "",
      r.user_name || "",
      r.note || "",
      r.is_correction ? "1" : "0",
      r.references_entry_id ?? "",
    ];
    lines.push(fields.map(csvField).join(","));
  }

  return new Response(lines.join("\n"), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${row.assr_no}-timeline.csv"`,
    },
  });
});

function csvField(v: any): string {
  const s = v == null ? "" : String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// ── Items ─────────────────────────────────────────────────────

app.post("/:id/items", requirePermission("service_cases.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const body = await c.req.json<{
    items: { item_code: string; item_description?: string; qty?: number }[];
  }>();
  if (!body.items?.length) return c.json({ error: "items required" }, 400);
  await addItems(c.env, id, body.items);
  return c.json({ ok: true });
});

app.delete("/:id/items/:itemId", requirePermission("service_cases.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const itemId = parseInt(c.req.param("itemId"), 10);
  await removeItem(c.env, id, itemId);
  return c.json({ ok: true });
});

// ── Attachments ───────────────────────────────────────────────

const ALLOWED_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "mp4", "pdf"]);
const MAX_SIZE = 25 * 1024 * 1024; // 25 MB

app.put("/:id/attachments", requirePermission("service_cases.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const userId = (c as any).get?.("userId") ?? 0;

  const category = c.req.query("category") || "complaint";
  const ext = (c.req.query("ext") || "jpg").toLowerCase();
  const fileName = c.req.query("name") || null;

  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return c.json({ error: `Extension '${ext}' not allowed` }, 400);
  }

  const body = await c.req.arrayBuffer();
  if (body.byteLength > MAX_SIZE) {
    return c.json({ error: "File too large (max 25MB)" }, 400);
  }

  const contentType =
    ext === "mp4" ? "video/mp4" :
    ext === "pdf" ? "application/pdf" :
    `image/${ext === "jpg" ? "jpeg" : ext}`;

  const key = assrAttachmentKey(id, category, ext);
  await c.env.POD_BUCKET.put(key, body, { httpMetadata: { contentType } });
  const attachId = await saveAttachment(c.env, id, key, fileName, contentType, category, userId);

  return c.json({ id: attachId, key }, 201);
});

app.get("/attachments/:key{.+}", requireServiceCaseAccess(), async (c) => {
  const key = c.req.param("key");
  // Resolve the attachment's OWNING case from its r2_key (canonical — never
  // trust the caller-supplied key's shape), then enforce the same self+downline
  // scope as the case detail: a Sales caller may download attachments only for
  // cases within their reporting chain. Unknown key or out-of-scope case → 404,
  // indistinguishable from a nonexistent object. Directors / service_cases.manage
  // stay unrestricted (caseInCallerScope short-circuits).
  const att = await c.env.DB.prepare(
    `SELECT assr_id FROM assr_attachments WHERE r2_key = ?`,
  )
    .bind(key)
    .first<{ assr_id: number | null }>();
  const caseId = Number(att?.assr_id ?? NaN);
  if (!Number.isFinite(caseId)) return c.json({ error: "Not found" }, 404);
  if (!(await caseInCallerScope(c, caseId))) return c.json({ error: "Not found" }, 404);

  const obj = await c.env.POD_BUCKET.get(key);
  if (!obj) return c.json({ error: "Not found" }, 404);

  return new Response(obj.body as ReadableStream, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
      "Cache-Control": "public, max-age=86400",
    },
  });
});

// ── Logistics ─────────────────────────────────────────────────

/**
 * Service-wide logistics feed for the Logistics tab's Service sub-tab.
 * Returns ASSR logistics rows joined with case context so ops can see
 * pickups/deliveries across all open cases in one list.
 */
app.get("/logistics/all", requirePermission("service_cases.read"), async (c) => {
  const page = Math.max(1, parseInt(c.req.query("page") || "1", 10));
  const perPage = Math.min(200, Math.max(10, parseInt(c.req.query("per_page") || "50", 10)));
  const status = c.req.query("status");
  const type = c.req.query("type");
  const search = (c.req.query("search") || "").trim();

  const where: string[] = ["l.archived_at IS NULL", "ca.archived_at IS NULL"];
  const binds: any[] = [];
  if (status) { where.push("l.status = ?"); binds.push(status); }
  if (type) { where.push("l.type = ?"); binds.push(type); }
  if (search) {
    where.push("(ca.assr_no LIKE ? OR ca.customer_name LIKE ? OR l.notes LIKE ?)");
    binds.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  const whereSql = `WHERE ${where.join(" AND ")}`;

  const totalRow = await c.env.DB.prepare(
    `SELECT COUNT(*) as n
       FROM assr_logistics l
       JOIN assr_cases ca ON ca.id = l.assr_id
      ${whereSql}`
  ).bind(...binds).first<{ n: number }>();

  const offset = (page - 1) * perPage;
  const rows = await c.env.DB.prepare(
    `SELECT l.*,
            ca.assr_no,
            ca.customer_name,
            ca.stage,
            ca.priority,
            u.name as assigned_to_name
       FROM assr_logistics l
       JOIN assr_cases ca ON ca.id = l.assr_id
       LEFT JOIN users u ON u.id = l.assigned_to
      ${whereSql}
      ORDER BY COALESCE(l.scheduled_date, l.created_at) DESC, l.id DESC
      LIMIT ? OFFSET ?`
  ).bind(...binds, perPage, offset).all<any>();

  return c.json({
    rows: rows.results ?? [],
    total: totalRow?.n ?? 0,
    page,
    per_page: perPage,
  });
});

app.post("/:id/logistics", requirePermission("service_cases.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const body = await c.req.json<{
    type: string;
    scheduled_date?: string;
    scheduled_time_range?: string;
    assigned_to?: number;
    notes?: string;
  }>();
  if (!body.type) return c.json({ error: "type is required" }, 400);
  const logId = await createLogistics(c.env, id, body);
  return c.json({ id: logId }, 201);
});

app.patch("/:id/logistics/:logId", requirePermission("service_cases.write"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const logId = parseInt(c.req.param("logId"), 10);
  const body = await c.req.json<Record<string, any>>();
  const ok = await patchLogistics(c.env, id, logId, body);
  if (!ok) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// ── Cost-suggestion helpers ───────────────────────────────────

/** Parse the AutoCount line set: case-insensitive ItemCode match. */
function matchLine(
  lines: Array<Record<string, any>> | null | undefined,
  itemCode: string
): Record<string, any> | null {
  if (!lines || !Array.isArray(lines)) return null;
  const target = itemCode.toLowerCase();
  for (const ln of lines) {
    const code = String(ln.ItemCode ?? ln.itemCode ?? ln.item_code ?? "").toLowerCase();
    if (code === target) return ln;
  }
  return null;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return isNaN(n) ? null : n;
}

export default app;
