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
// Lower-case + collapse internal whitespace + trim. Tolerant to casing/spacing
// drift ONLY, never substring. Mirror of backend services/pmsAccess.normalisePosition.
function normalisePosition(name: string | null | undefined): string {
  return (name ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

// Director-level positions, matched by EXACT normalised name. This WAS
// /\b(Super Admin|Sales Director|Finance Manager)\b/i — a word-boundary test
// that let any future free-text rename CONTAINING a director title ("Assistant
// to Sales Director", "Deputy Finance Manager") silently inherit full director
// access. Position names are owner-editable free text, so a substring match
// turns a rename into a privilege grant. MUST stay identical to the backend
// services/pmsAccess.ts DIRECTOR_POSITION_NAMES (pinned by both sides' tests).
const DIRECTOR_POSITION_NAMES: ReadonlySet<string> = new Set(
  ["Super Admin", "Sales Director", "Finance Manager"].map(normalisePosition),
);

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
  return DIRECTOR_POSITION_NAMES.has(normalisePosition(user.position_name));
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
 *  admin grant (owner 2026-07). EXACT normalised name so ONLY "Sales Director"
 *  matches, not "Sales Executive"/"Sales Coordinator" nor a name merely
 *  CONTAINING "Sales Director" ("Assistant to Sales Director"). This WAS
 *  /\bSales Director\b/i. Mirrors backend services/pmsAccess.isSalesDirectorUser;
 *  the backend stays the authority — this drives nav visibility + in-page
 *  scoping (defence-in-depth / UX only). MUST stay identical to the backend
 *  SALES_DIRECTOR_POSITION_NAMES. */
const SALES_DIRECTOR_POSITION_NAMES: ReadonlySet<string> = new Set(
  ["Sales Director"].map(normalisePosition),
);

/**
 * True ONLY for the "Sales Director" position. A Sales Director gets a scoped
 * Team view (own-department Members / Org Chart / Departments + Invite forced
 * into his dept; NO Positions tab, NO permission editing). Distinct from
 * isDirectorUser (broader — also Super Admin / Finance Manager / `*`, all full
 * admins). A caller who already holds users.manage keeps full admin unchanged.
 */
export function isSalesDirectorUser(user: AuthUser | null | undefined): boolean {
  if (!user) return false;
  return SALES_DIRECTOR_POSITION_NAMES.has(normalisePosition(user.position_name));
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
 * Owner 2026-07-17: "margin 給2990開啊 houzs的也是啊 是看什麽position 的" — the
 * POSITION is the control, and it is the `project_finance_viewer` flag below:
 * Super Admin / Sales Director / Finance Manager, plus Owner/IT via the `*`
 * wildcard (backend isFinanceViewer -> getPmsRole -> DIRECTOR,
 * services/pmsAccess.ts:79,154,256). A `Sales *` position routes to PIC/SALES
 * there and never reaches DIRECTOR, so every salesperson below Sales Director
 * gets false. That is the whole rule.
 *
 * Kept as its own helper rather than reading `project_finance_viewer` raw,
 * because the COSTING_DISPLAY_ENABLED term is SCM-only: it exists so the SCM
 * document surfaces can be switched off without taking the PMS / Projects P&L
 * (real data, same flag) down with them. It was false 2026-07-16..17 (#649) and
 * is true again now — see costing-enabled.ts for what a HOUZS 100% still means
 * until that catalog is costed.
 *
 * Callers must make the element ABSENT, not blank it ("off, not hide").
 */
export function canViewScmCosting(user: AuthUser | null | undefined): boolean {
  if (!COSTING_DISPLAY_ENABLED) return false;
  return !!user?.project_finance_viewer;
}

// ── Fair Report access (owner-ruled 2026-07-19) ─────────────────────────────
//
// Three tiers, PER STAGE, mirroring the backend lib/fair-report.fairReportAccess:
//   * ordinary salespeople → no access (nav absent + route guard)
//   * Sales Director       → SO stage only
//   * MANAGEMENT           → all three stages
// MANAGEMENT = isFinanceViewer AND NOT a Sales Director = {`*` owner/IT, Super
// Admin, Finance Manager}. isDirectorUser is the FE mirror of the backend
// isFinanceViewer (both OR in project_finance_viewer + the exact director
// position names — see its docblock), so subtracting the Sales Director yields
// management exactly. The Sales-Director check reuses the shared, EXACT-name
// isSalesDirectorUser so a free-text rename can never slide into a tier.
//
// NOTE: deliberately NOT gated on COSTING_DISPLAY_ENABLED (unlike
// canViewScmCosting). The backend endpoint returns cost/margin to these two
// tiers unconditionally, so the FE must not hide behind the SCM costing switch
// or the nav + page would disagree with what the API will serve.

export type FairStage = "so" | "do" | "invoice";

/** MANAGEMENT tier for the Fair Report — all three stages. */
export function isFairManagementUser(user: AuthUser | null | undefined): boolean {
  return isDirectorUser(user) && !isSalesDirectorUser(user);
}

/** The Fair Report stages this user may open, in canonical order. Empty = no
 *  access. Drives both nav visibility and per-tab visibility on the page. */
export function fairAllowedStages(user: AuthUser | null | undefined): FairStage[] {
  if (isFairManagementUser(user)) return ["so", "do", "invoice"];
  if (isSalesDirectorUser(user)) return ["so"];
  return [];
}

/** Nav + route guard — may this user open the Fair Report at all (any stage).
 *  True for management + the Sales Director; false for ordinary sales / office
 *  (defence-in-depth + UX only — the backend fairReportAccess stays the
 *  authority and 403s every refused stage). */
export function canViewFairReport(user: AuthUser | null | undefined): boolean {
  return fairAllowedStages(user).length > 0;
}

/**
 * PRODUCT COST gate — "may this user see a SKU's cost price".
 *
 * Owner 2026-07-17: "全部對sales person 除了sales director 關閉 就是直接看不到
 * 這個portion" + "電腦版本也是不要看到 電話電腦的權限應該一樣的".
 *
 * Deliberately NOT {@link canViewScmCosting}. The two no longer even resolve to
 * the same cohort (2026-07-17: Purchasing is in this one and not in that one),
 * but they were kept apart while they DID, and this is why. That helper carries
 * the extra COSTING_DISPLAY_ENABLED term —
 * an SCM-wide kill switch that has already been flipped twice (off #649, on
 * 2026-07-17). Cost ENTRY must not ride a switch whose whole purpose is to hide
 * cost DISPLAY: the last time it was off, wiring this to it would have meant
 * nobody — not even the Owner — could type a cost in, and the switch could
 * never have been flipped back. The circularity is the bug, and it stays fixed
 * by keeping the two questions apart rather than by the current value of the
 * flag.
 *
 * `cost_price_sen` is not derived and is not an artifact — whatever is in that
 * column is exactly what someone typed. It is simply CONFIDENTIAL. So this gate
 * is about IDENTITY only.
 *
 * That identity is `product_cost_viewer`, and it is NOT `project_finance_viewer`
 * — the correction of 2026-07-17. Owner, shown that his 2026-06-13 red line
 * ("Only Purchasing + Finance see cost") was not in force because Purchasing is
 * in no cost cohort:
 *
 *     "那就是采购、Finance，还有 Sales Director 啊？"
 *
 * so: Purchasing + Finance Manager + Sales Director, plus Owner/Super Admin via
 * `*`. This gate read `project_finance_viewer` until now — but that flag answers
 * "are you a PMS DIRECTOR" (isFinanceViewer -> getPmsRole -> DIRECTOR,
 * services/pmsAccess.ts:79,154,256), a question with no Purchasing in it. Two
 * questions had one flag, so an owner ruling sat dead for a month. The fix is
 * NOT to widen project_finance_viewer to admit Purchasing: that flag also opens
 * every project's financial snapshot / rental / payment in PMS and makes its
 * holder isDirectorUser, and the owner asked for cost, not for that. It is to
 * ask the cost question separately — backend pmsAccess.isProductCostViewer,
 * surfaced on /auth/me next to its sibling. Same reasoning as the paragraph
 * above, one level up: keep the two questions apart.
 *
 * project_finance_viewer is OR'd in only as a floor. The cost cohort is a strict
 * SUPERSET of the director cohort (isProductCostViewer = isDirectorUser OR
 * Purchasing), so a director is already true here by construction — this cannot
 * widen the cohort by one user. It exists so a director never loses cost against
 * a backend that predates the new flag (a stale PWA SPA shell is the real case);
 * an old backend then yields exactly the old director-only behaviour. Note the
 * inverse is deliberately absent: `isDirectorUser` above must NEVER read
 * product_cost_viewer, or Purchasing would become a director and inherit the
 * sales-scope gates and the 27 nav flags.
 *
 * Callers must make the element ABSENT, not blank it ("off, not hide") — a
 * "Cost: —" column still tells a salesperson the field exists and invites the
 * question.
 */
export function canViewProductCost(user: AuthUser | null | undefined): boolean {
  return !!user?.product_cost_viewer || !!user?.project_finance_viewer;
}

/** Drop the confidential fields a user may not see from a mobile card's field
 *  list. The mobile module cards are driven by one shared MODULE_CONFIGS table
 *  consumed in TWO places (MobileModuleList's ListCard and MobileModuleDetail's
 *  field grid), so the filter lives here rather than at either call site — a
 *  gate applied at one consumer and not the other is the same bug as gating
 *  desktop but not phone. Tuple slot 2 marks confidentiality; see FieldDef. */
export function visibleFields<T extends readonly [unknown, string, ("cost" | undefined)?]>(
  fields: readonly T[] | undefined,
  user: AuthUser | null | undefined,
): T[] {
  if (!fields?.length) return [];
  if (canViewProductCost(user)) return [...fields];
  return fields.filter((f) => f[2] !== "cost");
}
