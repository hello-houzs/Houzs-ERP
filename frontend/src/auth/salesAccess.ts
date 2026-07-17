import { ACCESS_RANK, type AuthUser, type AccessLevel } from "../types";
import { COSTING_DISPLAY_ENABLED } from "@2990s/shared";

/**
 * Sales-access model — CODE-KEYED off STABLE ORG FIELDS (position_name /
 * department), NOT the configurable per-page permission matrix. The owner
 * explicitly wants the Sales cohort's visibility driven from the org chart in
 * code (the RBAC-config matrix has unresolved issues), so these helpers are the
 * single client-side source of truth for the nav + route guards.
 *
 * Mirrors the backend classification in `services/pmsAccess.ts`
 * (`getPmsRole` / `isFinanceViewer`) so the FE and BE agree on who is a
 * "director" and who is "sales staff". Backend stays the authority — these
 * guards are UX + defence-in-depth only.
 */

/** Owner/IT `*` or a director-level position — sees everything. */
// Owner 2026-07-15: real positions carry prefixes/variants (e.g. "Test Sales
// Director"), so match the director title as a word anywhere in the name rather
// than requiring an exact string. Mirror of backend services/pmsAccess.ts.
const DIRECTOR_POSITIONS = /\b(Super Admin|Sales Director|Finance Manager)\b/i;

/** A sales position name — matches "Sales Executive", "Sales Coordinator",
 *  "Sales Director", but ALSO the no-space / punctuated variants that the old
 *  `/^Sales\s/` missed and thereby FAILED OPEN on: "Salesperson",
 *  "Sales-Executive", "Sales_Rep". A `Sales`-prefixed title is always a sales
 *  role here, so a prefix test is correct and safe (there is no non-sales
 *  position that starts with "Sales"). The primary, most-robust signal is now
 *  `department_name` (see isSalesStaff); this remains as a fallback for rows
 *  whose department isn't populated. */
const SALES_POSITION = /^sales/i;

/**
 * Director signal — the cohort that sees everything. Matches the backend
 * `isFinanceViewer`: the `*` wildcard (Owner/IT) OR a director position name.
 * The backend already surfaces this precomputed as `project_finance_viewer`;
 * we OR it in so the two agree even if a director position name is ever
 * renamed on the server side.
 */
export function isDirectorUser(user: AuthUser | null | undefined): boolean {
  if (!user) return false;
  if (user.permissions?.includes("*")) return true;
  if (user.project_finance_viewer) return true;
  return DIRECTOR_POSITIONS.test((user.position_name ?? "").trim());
}

/**
 * Sales staff — a member of the Sales department (director sales reps
 * included, e.g. "Sales Director" also matches). Keyed PRIMARILY off
 * `department_name` (now sent on /auth/me by backend #400) so any position
 * within the Sales department is caught, with the position-name prefix as a
 * fallback. Broadening these matches CLOSES the previous fail-open hole where
 * non-space titles ("Salesperson") slipped through as unrestricted.
 */
export function isSalesStaff(user: AuthUser | null | undefined): boolean {
  if (!user) return false;
  const dept = (user.department_name ?? "").toLowerCase();
  if (dept.includes("sales")) return true;
  return SALES_POSITION.test((user.position_name ?? "").trim());
}

/**
 * Non-director sales user — the restricted cohort of the Sales access model
 * (Delivery Returns hidden, Projects Finances hidden, etc.). Directors in the
 * Sales department are explicitly NOT restricted.
 */
export function isSalesNonDirector(user: AuthUser | null | undefined): boolean {
  return isSalesStaff(user) && !isDirectorUser(user);
}

/** Exact "Sales Director" position — the signal for the DEPARTMENT-SCOPED Team
 *  admin grant (owner 2026-07). Anchored so ONLY "Sales Director" matches, not
 *  "Sales Executive"/"Sales Coordinator". Mirrors the backend
 *  services/pmsAccess.isSalesDirectorUser; the backend stays the authority —
 *  this drives nav visibility + in-page scoping (defence-in-depth / UX only). */
const SALES_DIRECTOR_POSITION = /\bSales Director\b/i;

/**
 * True ONLY for the "Sales Director" position. A Sales Director gets a scoped
 * Team view (own-department Members / Org Chart / Departments + Invite forced
 * into his dept; NO Positions tab, NO permission editing). Distinct from
 * isDirectorUser (broader — also Super Admin / Finance Manager / `*`, all full
 * admins). A caller who already holds users.manage keeps full admin unchanged.
 */
export function isSalesDirectorUser(user: AuthUser | null | undefined): boolean {
  if (!user) return false;
  return SALES_DIRECTOR_POSITION.test((user.position_name ?? "").trim());
}

/**
 * Quick-action ("+" speed-dial) eligibility — the SINGLE source for whether a
 * user can start a New Sales Order and/or a New Service Case. Both the desktop
 * `QuickActionsFAB` and the mobile `MobileSalesOrders` FAB call this so the
 * "New Service Case includes Sales staff" rule (owner 2026-07: a Sales user
 * always gets the case option even without the service_cases matrix grant)
 * lives in ONE place and can't drift between the two surfaces.
 *
 *   canNewSo   → SO route gate: `scm.access` OR a per-position scm.sales.orders grant.
 *   canNewCase → service_cases.write / service_cases page access, OR any Sales staff.
 */
export function quickActionAccess(
  user: AuthUser | null | undefined,
  can: (perm: string) => boolean,
  pageAccess: (page: string) => AccessLevel,
): { canNewSo: boolean; canNewCase: boolean } {
  return {
    /* `edit`, not "not none" — the backend's area guard requires it and this
       gate must not promise what that will refuse. `scm/middleware/area-guard`
       is explicit: GET/HEAD need `view`, POST/PATCH/PUT/DELETE need `edit`,
       "else 403 (ENFORCED)". A view-level Sales Executive could therefore open
       the New SO form and reach "Create Sales Order", and the confirm PATCH
       /:docNo/status came back 403 with the button still sitting there — the
       owner hit exactly that on 2026-07-17.
       ACCESS_RANK already existed (types.ts, and PageGuard has compared through
       it since it was written) and mirrors the backend's levelRank rank-for-rank.
       Nobody called it here; `!== "none"` was the improvisation. */
    canNewSo:
      can("scm.access") ||
      ACCESS_RANK[pageAccess("scm.sales.orders")] >= ACCESS_RANK.edit,
    canNewCase:
      isSalesStaff(user) ||
      can("service_cases.write") ||
      pageAccess("service_cases") !== "none",
  };
}

/**
 * SCM COSTING gate — "may this user see cost/margin on a SUPPLY-CHAIN surface".
 *
 * Deliberately NOT the same question as {@link isDirectorUser} / the PMS
 * `project_finance_viewer` check, even though it is built from it. Two
 * different costing systems live in this app and only one of them has data:
 *
 *   - PMS / Projects P&L — fee + actual logistics cost, `cogs` / `transport`
 *     slugs, entered per project. REAL. Keeps rendering for a finance viewer.
 *   - SCM / document costing — derived from `mfg_products.cost_price_sen`,
 *     which is EMPTY across the whole ~1326-SKU catalog (prices were
 *     deliberately deferred, owner 2026-06-22 "不需要價格先"). Every margin it
 *     produces is an artifact: cost 0 -> margin = revenue -> "100.0%" in green,
 *     on every order, shown only to the finance viewer who acts on it.
 *
 * Owner 2026-07-16: "那個costing 應該是整個remove 掉啊 不是show naan", then
 * "全關" — off everywhere, not dressed up. Gating the SCM surfaces through THIS
 * helper rather than the raw `project_finance_viewer` flag is what keeps the
 * PMS P&L alive while the SCM costing is dark; a blanket switch would have
 * taken working project finances down with it.
 *
 * Turning it back on = seed the costs, flip COSTING_DISPLAY_ENABLED. One line.
 */
export function canViewScmCosting(user: AuthUser | null | undefined): boolean {
  if (!COSTING_DISPLAY_ENABLED) return false;
  return !!user?.project_finance_viewer;
}
