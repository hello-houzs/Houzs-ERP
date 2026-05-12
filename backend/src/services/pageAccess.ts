/**
 * Per-page access model — page catalogue + helpers.
 *
 * Each page has a per-role access entry in `role_page_access`:
 * one of 'none' / 'partial' / 'full'. The `*` wildcard on a role
 * short-circuits the matrix lookup ('full' on every page).
 *
 * "Partial" is custom per page — e.g. Sales partial = own entries
 * only; Petty Cash partial = no post button; Projects partial =
 * limited finance view (PIC + brand row-filtering applies on top).
 *
 * Phase 1 of the rollout — see plan
 * C:/Users/User/.claude/plans/spicy-prancing-hickey.md. Only the
 * Sales page is wired through `requirePageAccess` in this slice;
 * the rest is configuration that admins can review before each
 * follow-up page migration.
 */

import type { Env } from "../types";

export type AccessLevel = "none" | "partial" | "full";

export const ACCESS_LEVELS: readonly AccessLevel[] = ["none", "partial", "full"] as const;

export interface PageDef {
  /** Stable identifier stored in `role_page_access.page_key`. */
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
  /** One-shot backfill rule: given a role's permission set, decide
   *  the level. Used by `scripts/backfill-role-page-access.mjs`
   *  and as a fallback when no explicit matrix row exists yet. */
  backfill: (perms: ReadonlySet<string>) => AccessLevel;
}

const has = (perms: ReadonlySet<string>, ...keys: string[]): boolean =>
  keys.some((k) => perms.has(k));

const isOwner = (perms: ReadonlySet<string>): boolean => perms.has("*");

export const PAGES: PageDef[] = [
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
    key: "orders",
    label: "Sales Orders",
    partialMeaning: "Read-only; cannot update status or push to AutoCount.",
    supportsPartial: true,
    backfill: (p) =>
      isOwner(p) || has(p, "sales_orders.write")
        ? "full"
        : has(p, "sales_orders.read")
          ? "partial"
          : "none",
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
    key: "logistics",
    label: "Logistics & Fleet",
    partialMeaning: "View trips + fleet; cannot create, assign, or cancel.",
    supportsPartial: true,
    backfill: (p) =>
      isOwner(p) || has(p, "trips.manage", "planner.run")
        ? "full"
        : has(p, "trips.read.all", "fleet.read")
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
    key: "service_cases",
    label: "ASSR / Service Cases",
    partialMeaning: "View cases; cannot triage, assign, or schedule logistics.",
    supportsPartial: true,
    backfill: (p) =>
      isOwner(p) || has(p, "service_cases.manage")
        ? "full"
        : has(p, "service_cases.read", "service_cases.write")
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
    key: "projects",
    label: "Projects",
    partialMeaning:
      "PIC + brand row-filtering applies. Limited finance view (cost columns hidden, ledger locked).",
    supportsPartial: true,
    backfill: (p) =>
      isOwner(p) || has(p, "projects.manage")
        ? "full"
        : has(p, "projects.write", "projects.read", "projects.chat", "projects.checklist.tick")
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
    key: "team",
    label: "Team / Roles / Org Chart",
    partialMeaning: "View members and roles; cannot invite, edit, or change permissions.",
    supportsPartial: true,
    backfill: (p) =>
      isOwner(p) || has(p, "users.manage", "roles.manage")
        ? "full"
        : has(p, "users.read", "roles.read")
          ? "partial"
          : "none",
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
];

const PAGE_KEYS = new Set(PAGES.map((p) => p.key));

export function isValidPageKey(key: string): boolean {
  return PAGE_KEYS.has(key);
}

export function getPageDef(key: string): PageDef | null {
  return PAGES.find((p) => p.key === key) ?? null;
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
 * page the role doesn't yet have an explicit row for (so newly-
 * added pages don't break authentication for existing roles).
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
    const out: Record<string, AccessLevel> = {};
    for (const p of PAGES) out[p.key] = "full";
    return out;
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

  const out: Record<string, AccessLevel> = {};
  for (const p of PAGES) {
    out[p.key] = explicit[p.key] ?? computeBackfillLevel(p.key, rolePerms);
  }
  return out;
}
