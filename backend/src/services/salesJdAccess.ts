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
// LOOKS at what Office operates. Delivery Returns stays off for the whole Sales
// cohort, director included (owner rule, 2026-07).
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
 *  Service Cases, or anything else a rep's position legitimately configures. */
const SALES_JD: Readonly<Record<string, AccessLevel>> = {
  "scm.sales.orders": "edit", // they sell; the SO is theirs to raise + confirm
  "scm.sales.delivery": "view", // Office operates it; Sales only looks
  "scm.sales.invoices": "view", // Office operates it; Sales only looks
  "scm.sales.returns": "none", // off for the whole cohort, director included
};

/**
 * Apply the Sales JD over a hydrated page-access map.
 *
 * The `*` wildcard (Owner / IT) is exempt and returns UNTOUCHED: it arrives
 * here as fullAccessMap(), and narrowing it would lock the owner out of his own
 * system. Everyone outside the Sales cohort is untouched too -- Office keeps
 * whatever its position grants, which is the whole point of the split.
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
