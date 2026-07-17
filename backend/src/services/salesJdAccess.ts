// ----------------------------------------------------------------------------
// salesJdAccess — the Sales cohort's SCM access, keyed off the ORG CHART in
// code, not the RBAC config matrix.
//
// WHY THIS EXISTS. Owner, 2026-07-17: "我説的是用coding 去改backend 而不是整個 …
// 或者你把整個sales department的這個移除掉 根據我們的指令來做 … 那些none的
// 直接不給看 用backend來做." He has said it before, and salesAccess.ts's own
// header already records it: "the owner explicitly wants the Sales cohort's
// visibility driven from the org chart in code (the RBAC-config matrix has
// unresolved issues)". The matrix cannot express what he needs -- 41 nav
// entries already carry hardcoded cohort flags because of it -- so the Sales
// cohort's SCM levels are a RULE, not a setting somebody can mis-click.
//
// THE RULE IS THE JD (owner, same day):
//   "销售部门原本就是卖东西、开 SO 的。如果他们没有开 SO，后面的人怎么去操作呢？"
//   "后面的人是来操作 DO 和 SI 的。销售人员不可能去操作 DO 和 SI，所以他们通常
//    只是来看而已。"
// So: Sales OWNS the Sales Order (edit -- it is the SOURCE document the whole
// chain hangs off; a rep stuck at `view` kills the chain at step one), and only
// LOOKS at what Office operates.
//
// PROVENANCE -- which of these four lines are HIS WORDS, and which are not.
// He is meant to read this file and recognise his own decisions, so the two are
// marked apart rather than blended (`feat/jd-rules-from-record`, 2026-07-17,
// which mined BUG-HISTORY + every merged PR body + the full git log for them):
//   - orders / delivery / invoices  -- QUOTED AND DATED above (owner 2026-07-17).
//   - returns                       -- ASSERTED AS AN OWNER RULE, NEVER QUOTED.
//     The trail: `hideForSalesNonDirector` -> `hideForSales` in f2ca099
//     (2026-07-14, PR #417), whose body says "deny ALL Sales staff (director
//     too)" and cites no instruction; no verbatim Chinese for it survives in
//     BUG-HISTORY, any PR body, or any commit message. It may well be a real
//     ruling he gave in chat -- but the record cannot show it, and this line
//     is the ONLY one here that can take access AWAY from a Sales Director.
//     Flagged for him rather than changed: removing it on my own reading would
//     be the same inference-instead-of-instruction this file exists to end.
//
// WHAT IS ACTUALLY IN FORCE -- measured, because writing a level here is not the
// same as enforcing it (`feat/z1-jd-consolidate`, 2026-07-17, proved this the
// expensive way and its entry is the reason this block exists):
//   - The backend area-guard SKIPS this map entirely unless the caller already
//     holds an explicit `scm*` row (`area-guard.ts:93` -- the documented
//     NO-LOCKOUT fallthrough). So for a Sales user with NO such row, `"none"`
//     here blocks NOTHING and `"edit"` grants nothing the coarse `scm.access`
//     umbrella did not already allow.
//   - `"none"` also does not hide a nav entry: every SCM entry ORs
//     `anyPerm: ["*","scm.access"]` against `anyAccess`, and `navFilter.ts:81-84`
//     only drops the `scm.access` term when `scm_l2_configured` is true. What
//     actually hides Delivery Returns today is `hideForSales` on the nav entry
//     plus `DeliveryReturnsGuard` on the route -- NOT this line.
//   - Where this map IS load-bearing: the FRONTEND reads it from /auth/me
//     (`quickActionAccess` compares `scm.sales.orders` through ACCESS_RANK
//     against `edit`), and the backend area-guard enforces it for any cohort
//     member who IS L2-configured -- which per z1's measurement includes the
//     Sales Director.
// Making the deny half real needs `scm_l2_configured` forced true for the
// cohort, which backfills EVERY unlisted SCM key to "none" and starts enforcing
// it -- a mass-lockout risk that needs a staging pass, not a merge. Not done
// here, deliberately.
//
// WHY HERE AND NOT IN THE ROUTES. `page_access` is read by BOTH sides -- the
// backend's scm/middleware/area-guard (`user.page_access[area]`, GET/HEAD needs
// `view`, writes need `edit`, "else 403 ENFORCED") and the frontend, which gets
// this same map from /auth/me. Applying the rule once, where the map is built,
// is what stops the two drifting: a rep was being offered a "Create Sales Order"
// button the backend then 403'd, because the FE gate and the BE gate disagreed
// by exactly one level and nothing made them agree.
// ----------------------------------------------------------------------------

import type { AccessLevel } from "./pageAccess";

/** Position names that ARE the Sales cohort. Mirrors pmsAccess.isSalesUser and
 *  the frontend's salesAccess.isSalesStaff -- department first, position-name
 *  prefix as the fallback for anyone filed outside a Sales department. */
const SALES_POSITION = /^sales/i;

function isSalesCohort(u: {
  position_name: string | null;
  department_name: string | null;
}): boolean {
  const dept = (u.department_name ?? "").toLowerCase();
  if (dept.includes("sales")) return true;
  return SALES_POSITION.test((u.position_name ?? "").trim());
}

/** The JD, as data. Anything not listed is left to the matrix -- this override
 *  answers the SCM sales chain ONLY, and deliberately does not touch Projects,
 *  Service Cases, or anything else a rep's position legitimately configures.
 *
 *  THE DIRECTOR IS IN THIS COHORT, and that is an OPEN QUESTION, not a decision.
 *  `isSalesCohort` matches on department, so "Sales Director" matches -- these
 *  four levels are SET on him too, overriding whatever his matrix row says. His
 *  JD quote names "销售人员" (salespeople); whether that includes the Sales
 *  Director has never been ruled, and z1 (2026-07-17) recorded the gap as the
 *  blocker it is. Two of these lines can only ever REMOVE access, and only from
 *  him -- he is the one cohort member likely to hold a matrix grant above `view`:
 *    - delivery/invoices `view` CAPS him at read; if his row says edit/full, the
 *      area-guard now 403s his DO/SI writes.
 *    - returns `none` DENIES him outright once L2-configured.
 *  Left exactly as #671 shipped it. "Fixing" it needs his rows (the aa1 export,
 *  `positionAccessSnapshot.ts`, still ships EMPTY) -- exempting him blind could
 *  just as easily strip a `view` he has today. His ruling first, then the code.
 */
const SALES_JD: Readonly<Record<string, AccessLevel>> = {
  // Owner 2026-07-17: "销售部门原本就是卖东西、开 SO 的。如果他们没有开 SO，
  // 后面的人怎么去操作呢？" -- they sell; the SO is theirs to raise + confirm.
  "scm.sales.orders": "edit",
  // Owner 2026-07-17: "后面的人是来操作 DO 和 SI 的。销售人员不可能去操作 DO 和
  // SI，所以他们通常只是来看而已。" -- Office operates it; Sales only looks.
  "scm.sales.delivery": "view",
  "scm.sales.invoices": "view",
  // NOT QUOTED ANYWHERE -- see PROVENANCE in the header. Asserted as an owner
  // rule by f2ca099 / PR #417 (2026-07-14); inert for a non-L2 rep; live only
  // against an L2-configured cohort member, i.e. in practice the Director.
  "scm.sales.returns": "none",
};

/**
 * Apply the Sales JD over a hydrated page-access map.
 *
 * The `*` wildcard (Owner / IT) is exempt and returns UNTOUCHED: it arrives
 * here as fullAccessMap(), and narrowing it would lock the owner out of his own
 * system. Everyone outside the Sales cohort is untouched too -- Office keeps
 * whatever its position grants, which is the whole point of the split.
 *
 * A USER WITH NO POSITION STILL GETS THIS. The cohort test keys off
 * `department_name`, which is populated independently of `position_id`, while
 * `auth.ts:297` hydrates a positionless user from the LEGACY ROLE matrix
 * (`role_page_access`, still live). So a Sales-department user with no position
 * lands here with a role-derived map and has the JD applied on top of it. That
 * is the intended direction (the JD is about the department, not the position
 * row), and it is safe: the role matrix's SCM keys backfill owner-only, so such
 * a user is almost never L2-configured and the deny half stays inert for them --
 * but it means this override must never be written to assume a position exists.
 */
export function applySalesJdOverride(
  pageAccess: Record<string, AccessLevel>,
  user: {
    permissions: ReadonlySet<string> | string[];
    position_name: string | null;
    department_name: string | null;
  },
): Record<string, AccessLevel> {
  const perms = Array.isArray(user.permissions)
    ? new Set(user.permissions)
    : user.permissions;
  if (perms.has("*")) return pageAccess;
  if (!isSalesCohort(user)) return pageAccess;
  return { ...pageAccess, ...SALES_JD };
}
