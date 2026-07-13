import type { AuthUser } from "../types";

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
const DIRECTOR_POSITIONS = /^(Super Admin|Sales Director|Finance Manager)$/i;

/** A "Sales <role>" position (Sales Executive, Sales Coordinator, Sales
 *  Director, …). NOTE: `department_name` is not yet on the /auth/me payload
 *  (only the numeric `department_id`), so the Sales-department test currently
 *  keys off the position name. Add `department_name` to /auth/me for a fully
 *  robust department check — see the PR body. */
const SALES_POSITION = /^Sales\s/i;

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
 * included, e.g. "Sales Director" also matches). Currently derived from
 * `position_name` because `department_name` isn't on the wire yet.
 */
export function isSalesStaff(user: AuthUser | null | undefined): boolean {
  if (!user) return false;
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
