/**
 * Per-page access model — page catalogue + helpers.
 *
 * Each page has a per-role access entry in `role_page_access`:
 * one of 'none' / 'partial' / 'full'. The `*` wildcard on a role
 * short-circuits the matrix lookup ('full' on every page).
 *
 * Pages with sub-tabs (Projects, Team, Logistics, ASSR, Orders) are
 * modelled as a parent page plus child sub-page entries. The parent's
 * level cascades to children:
 *   parent = "full"    → all children granted at full
 *   parent = "none"    → all children denied
 *   parent = "partial" → child rows take effect; admins pick per child
 *
 * The flattening happens in `loadPageAccessForRole`. Consumers read
 * the flat map `user.page_access` keyed by the leaf page_key
 * (e.g. `projects.calendar`).
 *
 * Phase 1 of the rollout (Sales pilot) shipped. Sub-page splitting
 * shipped 2026-05-12 — Projects' 4 top-level views are wired through
 * `requirePageAccess(...)`; other parents have catalogue entries but
 * their tab-level UI gating lands in follow-up slices.
 */

import type { Env } from "../types";

export type AccessLevel = "none" | "partial" | "full";

export const ACCESS_LEVELS: readonly AccessLevel[] = ["none", "partial", "full"] as const;

export interface PageDef {
  /** Stable identifier stored in `role_page_access.page_key`.
   *  Sub-pages use dotted form `<parent>.<leaf>` (e.g. `projects.calendar`). */
  key: string;
  /** Human label for the admin UI. */
  label: string;
  /** Short description of what "partial" means for this page —
   *  rendered as a tooltip on the Partial radio in the admin UI. */
  partialMeaning: string;
  /** Whether the partial level is a meaningful state for this page.
   *  Settings and Sales Team Maintenance, for example, are full-or-
   *  none. The admin UI hides the Partial radio when this is false. */
  supportsPartial: boolean;
  /** If set, this page is a sub-page of `parent`. The parent's level
   *  cascades to children (full → all children full; none → all
   *  children none; partial → per-child config). */
  parent?: string;
  /** One-shot backfill rule: given a role's permission set, decide
   *  the level. Used by `scripts/backfill-role-page-access.mjs`
   *  and as a fallback when no explicit matrix row exists yet. */
  backfill: (perms: ReadonlySet<string>) => AccessLevel;
}

const has = (perms: ReadonlySet<string>, ...keys: string[]): boolean =>
  keys.some((k) => perms.has(k));

const isOwner = (perms: ReadonlySet<string>): boolean => perms.has("*");

// ── Backfill helpers — replaces `projects.read/write/manage` etc. into
//    a level estimation per sub-page. Used by the admin UI's "computed"
//    defaults and by `computeBackfillLevel` on first session load.
const projectsBackfill = (p: ReadonlySet<string>): AccessLevel =>
  isOwner(p) || has(p, "projects.manage")
    ? "full"
    : has(p, "projects.write", "projects.read", "projects.chat", "projects.checklist.tick")
      ? "partial"
      : "none";

const teamBackfill = (p: ReadonlySet<string>): AccessLevel =>
  isOwner(p) || has(p, "users.manage", "roles.manage")
    ? "full"
    : has(p, "users.read", "roles.read")
      ? "partial"
      : "none";

const logisticsBackfill = (p: ReadonlySet<string>): AccessLevel =>
  isOwner(p) || has(p, "trips.manage", "planner.run")
    ? "full"
    : has(p, "trips.read.all", "fleet.read")
      ? "partial"
      : "none";

const serviceCasesBackfill = (p: ReadonlySet<string>): AccessLevel =>
  isOwner(p) || has(p, "service_cases.manage")
    ? "full"
    : has(p, "service_cases.read", "service_cases.write")
      ? "partial"
      : "none";

const ordersBackfill = (p: ReadonlySet<string>): AccessLevel =>
  isOwner(p) || has(p, "sales_orders.write")
    ? "full"
    : has(p, "sales_orders.read")
      ? "partial"
      : "none";

export const PAGES: PageDef[] = [
  // ── Standalone pages (no sub-tabs) ──────────────────────────
  {
    key: "overview",
    label: "Dashboard / Overview",
    partialMeaning: "Hide finance cards and admin-only summaries.",
    supportsPartial: true,
    backfill: (p) =>
      isOwner(p)
        ? "full"
        : has(p, "projects.read", "sales.read", "sales_orders.read")
          ? "full"
          : "partial",
  },
  {
    key: "delivery_orders",
    label: "Delivery Orders",
    partialMeaning: "Read-only; cannot edit scheduling fields.",
    supportsPartial: true,
    backfill: (p) =>
      isOwner(p) || has(p, "delivery_orders.write")
        ? "full"
        : has(p, "delivery_orders.read")
          ? "partial"
          : "none",
  },
  {
    key: "purchase_orders",
    label: "Purchase Orders",
    partialMeaning: "Read-only; cannot edit supplier dates or push.",
    supportsPartial: true,
    backfill: (p) =>
      isOwner(p) || has(p, "purchase_orders.write")
        ? "full"
        : has(p, "purchase_orders.read")
          ? "partial"
          : "none",
  },
  {
    key: "sales",
    label: "Sales Entries",
    partialMeaning: "See and edit only your own entries; cannot manage, void, or push.",
    supportsPartial: true,
    backfill: (p) =>
      isOwner(p) || has(p, "sales.manage")
        ? "full"
        : has(p, "sales.write", "sales.read")
          ? "partial"
          : "none",
  },
  {
    key: "settings",
    label: "System Settings",
    partialMeaning: "(not used for this page)",
    supportsPartial: false,
    backfill: (p) => (isOwner(p) || has(p, "settings.manage") ? "full" : "none"),
  },
  {
    key: "sales_team",
    label: "Sales Team org chart",
    partialMeaning: "View the org chart and rep details; no edits.",
    supportsPartial: true,
    backfill: (p) =>
      isOwner(p) || has(p, "sales_team.manage")
        ? "full"
        : has(p, "sales_team.read")
          ? "partial"
          : "none",
  },
  {
    key: "sales_team_maintenance",
    label: "Sales Team admin (positions / tiers)",
    partialMeaning: "(not used for this page)",
    supportsPartial: false,
    backfill: (p) => (isOwner(p) || has(p, "sales_team.manage") ? "full" : "none"),
  },
  {
    key: "petty_cash",
    label: "Petty Cash",
    partialMeaning: "View ledger and balance; cannot post or manage entries.",
    supportsPartial: true,
    backfill: (p) =>
      isOwner(p) || has(p, "petty_cash.manage", "petty_cash.post")
        ? "full"
        : has(p, "petty_cash.read")
          ? "partial"
          : "none",
  },

  // ── Orders (parent + sub-tabs) ──────────────────────────────
  {
    key: "orders",
    label: "Sales Orders",
    partialMeaning: "Pick which Orders sub-tabs this role can access.",
    supportsPartial: true,
    backfill: ordersBackfill,
  },
  {
    key: "orders.sales_orders",
    parent: "orders",
    label: "Sales Orders list",
    partialMeaning: "Read-only; cannot update status or push to AutoCount.",
    supportsPartial: true,
    backfill: ordersBackfill,
  },
  {
    key: "orders.balance",
    parent: "orders",
    label: "Balance Collection",
    partialMeaning: "View only.",
    supportsPartial: true,
    backfill: (p) =>
      isOwner(p) ? "full" : has(p, "balance.read") ? "partial" : "none",
  },
  {
    key: "orders.overdue",
    parent: "orders",
    label: "Overdue history",
    partialMeaning: "View only; cannot trigger auto-extend.",
    supportsPartial: true,
    backfill: (p) =>
      isOwner(p) || has(p, "overdue.write")
        ? "full"
        : has(p, "overdue.read")
          ? "partial"
          : "none",
  },
  {
    key: "orders.pnl",
    parent: "orders",
    label: "P&L",
    partialMeaning: "(not used; full or none)",
    supportsPartial: false,
    backfill: (p) =>
      isOwner(p) || has(p, "sales_orders.write") ? "full" : "none",
  },

  // ── Logistics (parent + sub-tabs) ───────────────────────────
  {
    key: "logistics",
    label: "Logistics & Fleet",
    partialMeaning: "Pick which Logistics sub-tabs this role can access.",
    supportsPartial: true,
    backfill: logisticsBackfill,
  },
  {
    key: "logistics.trips",
    parent: "logistics",
    label: "Trips dispatcher",
    partialMeaning: "View only; cannot create, assign, or cancel.",
    supportsPartial: true,
    backfill: (p) =>
      isOwner(p) || has(p, "trips.manage", "planner.run")
        ? "full"
        : has(p, "trips.read.all")
          ? "partial"
          : "none",
  },
  {
    key: "logistics.fleet",
    parent: "logistics",
    label: "Fleet (drivers, helpers, lorries)",
    partialMeaning: "View only; cannot edit profiles or maintenance.",
    supportsPartial: true,
    backfill: (p) =>
      isOwner(p) || has(p, "fleet.manage")
        ? "full"
        : has(p, "fleet.read")
          ? "partial"
          : "none",
  },

  // ── Service Cases / ASSR (parent + sub-tabs) ────────────────
  {
    key: "service_cases",
    label: "ASSR / Service Cases",
    partialMeaning: "Pick which ASSR sub-tabs this role can access.",
    supportsPartial: true,
    backfill: serviceCasesBackfill,
  },
  {
    key: "service_cases.cases",
    parent: "service_cases",
    label: "Cases list",
    partialMeaning: "View + edit assigned cases; cannot triage.",
    supportsPartial: true,
    backfill: serviceCasesBackfill,
  },
  {
    key: "service_cases.by_creditor",
    parent: "service_cases",
    label: "Cases by Creditor",
    partialMeaning: "View only.",
    supportsPartial: true,
    backfill: serviceCasesBackfill,
  },
  {
    key: "service_cases.metrics",
    parent: "service_cases",
    label: "Metrics",
    partialMeaning: "View only.",
    supportsPartial: true,
    backfill: serviceCasesBackfill,
  },
  {
    key: "service_cases.pnl",
    parent: "service_cases",
    label: "P&L",
    partialMeaning: "(not used; full or none)",
    supportsPartial: false,
    backfill: (p) =>
      isOwner(p) || has(p, "service_cases.manage") ? "full" : "none",
  },
  {
    key: "service_cases.settings",
    parent: "service_cases",
    label: "Settings",
    partialMeaning: "(not used; full or none)",
    supportsPartial: false,
    backfill: (p) =>
      isOwner(p) || has(p, "service_cases.manage") ? "full" : "none",
  },

  // ── Projects (parent + sub-tabs) — wired end-to-end ─────────
  {
    key: "projects",
    label: "Projects",
    partialMeaning: "Pick which Projects sub-tabs this role can access.",
    supportsPartial: true,
    backfill: projectsBackfill,
  },
  {
    key: "projects.list",
    parent: "projects",
    label: "List + project detail",
    partialMeaning: "PIC + brand row-filter applies; limited project detail view.",
    supportsPartial: true,
    backfill: projectsBackfill,
  },
  {
    key: "projects.calendar",
    parent: "projects",
    label: "Calendar",
    partialMeaning: "Read-only calendar view; same PIC + brand row-filter.",
    supportsPartial: true,
    backfill: projectsBackfill,
  },
  {
    key: "projects.finances",
    parent: "projects",
    label: "Finances (list / analytics / P&L)",
    partialMeaning: "Limited finance view; ledger locked, cost columns hidden.",
    supportsPartial: true,
    backfill: projectsBackfill,
  },
  {
    key: "projects.maintenance",
    parent: "projects",
    label: "Maintenance (brands / event types / templates / cost rates)",
    partialMeaning: "(not used; full or none)",
    supportsPartial: false,
    backfill: (p) =>
      isOwner(p) || has(p, "projects.manage") ? "full" : "none",
  },

  // ── Team (parent + sub-tabs) ────────────────────────────────
  {
    key: "team",
    label: "Team",
    partialMeaning: "Pick which Team sub-tabs this role can access.",
    supportsPartial: true,
    backfill: teamBackfill,
  },
  {
    key: "team.members",
    parent: "team",
    label: "Members",
    partialMeaning: "View list; cannot invite, edit, or disable.",
    supportsPartial: true,
    backfill: (p) =>
      isOwner(p) || has(p, "users.manage")
        ? "full"
        : has(p, "users.read")
          ? "partial"
          : "none",
  },
  {
    key: "team.roles",
    parent: "team",
    label: "Roles",
    partialMeaning: "View roles; cannot edit permissions or page access.",
    supportsPartial: true,
    backfill: (p) =>
      isOwner(p) || has(p, "roles.manage")
        ? "full"
        : has(p, "roles.read")
          ? "partial"
          : "none",
  },
  {
    key: "team.org_chart",
    parent: "team",
    label: "Org chart",
    partialMeaning: "View only.",
    supportsPartial: true,
    backfill: (p) =>
      isOwner(p) || has(p, "users.manage")
        ? "full"
        : has(p, "users.read")
          ? "partial"
          : "none",
  },
  {
    key: "team.departments",
    parent: "team",
    label: "Departments",
    partialMeaning: "(not used; full or none)",
    supportsPartial: false,
    backfill: (p) =>
      isOwner(p) || has(p, "users.manage") ? "full" : "none",
  },
];

const PAGE_KEYS = new Set(PAGES.map((p) => p.key));

export function isValidPageKey(key: string): boolean {
  return PAGE_KEYS.has(key);
}

export function getPageDef(key: string): PageDef | null {
  return PAGES.find((p) => p.key === key) ?? null;
}

export function getChildrenOf(parentKey: string): PageDef[] {
  return PAGES.filter((p) => p.parent === parentKey);
}

export function isValidAccessLevel(level: string): level is AccessLevel {
  return level === "none" || level === "partial" || level === "full";
}

/**
 * Numeric ordering for comparing access levels. Higher = more access.
 * `none` < `partial` < `full`. Used by `requirePageAccess` to decide
 * if a user's level satisfies a route's minimum.
 */
export function levelRank(level: AccessLevel): number {
  return level === "full" ? 2 : level === "partial" ? 1 : 0;
}

export function meetsLevel(actual: AccessLevel, required: AccessLevel): boolean {
  return levelRank(actual) >= levelRank(required);
}

/**
 * Synchronous "everything full" map — used for the service user and
 * any wildcard-permission caller that doesn't go through D1.
 */
export function fullAccessMap(): Record<string, AccessLevel> {
  const out: Record<string, AccessLevel> = {};
  for (const p of PAGES) out[p.key] = "full";
  return out;
}

/**
 * Compute the backfill level for a role on a specific page, given
 * the role's permission set. Used by:
 *   - the one-shot backfill script (writes a row per role × page)
 *   - the `loadPageAccessForRole` fallback when no explicit row exists
 */
export function computeBackfillLevel(
  pageKey: string,
  perms: ReadonlySet<string>,
): AccessLevel {
  const def = getPageDef(pageKey);
  if (!def) return "none";
  return def.backfill(perms);
}

/**
 * Hydrate a role's full page-access map. Reads `role_page_access`
 * for explicit rows; falls back to `computeBackfillLevel` for any
 * page the role doesn't yet have an explicit row for.
 *
 * Parent-child cascade rules applied after the raw read:
 *   - parent = "full"    → all sub-pages forced to "full" in the result
 *   - parent = "none"    → all sub-pages forced to "none"
 *   - parent = "partial" → each sub-page uses its own explicit row or
 *                          backfill (whatever the raw read produced)
 *
 * Called once per session bootstrap from `hydrateAuthUser`. The
 * returned record is attached to `AuthUser.page_access` and read
 * directly by `requirePageAccess` and the frontend `usePageAccess`
 * hook — no D1 round-trip on the hot path.
 */
export async function loadPageAccessForRole(
  env: Env,
  roleId: number,
  rolePerms: ReadonlySet<string>,
): Promise<Record<string, AccessLevel>> {
  // Wildcard short-circuits — Owner / IT Admin always see 'full'.
  if (rolePerms.has("*")) {
    return fullAccessMap();
  }

  const rows = await env.DB.prepare(
    `SELECT page_key, level FROM role_page_access WHERE role_id = ?`,
  )
    .bind(roleId)
    .all<{ page_key: string; level: string }>();

  const explicit: Record<string, AccessLevel> = {};
  for (const r of rows.results ?? []) {
    if (isValidPageKey(r.page_key) && isValidAccessLevel(r.level)) {
      explicit[r.page_key] = r.level;
    }
  }

  // Pass 1: resolve every page (parents + standalones) from explicit
  // row or backfill.
  const raw: Record<string, AccessLevel> = {};
  for (const p of PAGES) {
    raw[p.key] = explicit[p.key] ?? computeBackfillLevel(p.key, rolePerms);
  }

  // Pass 2: cascade parent level into children when parent is full/none.
  // When parent is "partial", the child's own row/backfill stands.
  const out: Record<string, AccessLevel> = { ...raw };
  for (const p of PAGES) {
    if (!p.parent) continue;
    const parentLevel = raw[p.parent];
    if (parentLevel === "full") out[p.key] = "full";
    else if (parentLevel === "none") out[p.key] = "none";
    // parentLevel === "partial" → keep the child's resolved level.
  }

  return out;
}
