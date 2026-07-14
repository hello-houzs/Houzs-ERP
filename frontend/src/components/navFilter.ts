import type { NavTab } from "./Sidebar";
import type { AccessLevel, AuthUser } from "../types";
import {
  isSalesStaff,
  isSalesDirectorUser,
  isSalesNonDirector,
} from "../auth/salesAccess";

/**
 * Single source of truth for "which nav entries can this user see".
 *
 * The desktop `Sidebar` and the mobile `MenuModal` (MobileTabBar) both build
 * their menus from the same `NAV_TABS` registry, so they MUST filter it with
 * identical logic — otherwise a gated entry leaks into one surface but not the
 * other. The mobile copy silently drifted: it checked only `perm` / `anyPerm`
 * / `hidePerm` and ignored `pageAccess`, `pageAccessFull`, `requireFinanceViewer`
 * and every sales gate. So `pageAccess`-only items (Projects, System Health)
 * and `hideForSales` items (Delivery Returns) rendered for denied users at
 * `<lg` widths and bounced them to <Forbidden> — the exact "render-then-deny"
 * the "off, not hide" rule forbids at the nav layer. Extracting the filter here
 * makes that drift impossible: both surfaces call the same function.
 *
 * Returns a `filterTab` that recursively drops entries the user can't reach; a
 * group with no surviving child is itself dropped. Denied entries are absent,
 * never rendered-then-blocked.
 */
export interface NavFilterCtx {
  user: AuthUser | null;
  can: (perm: string) => boolean;
  pageAccess: (page: string) => AccessLevel;
}

export function makeNavFilter({ user, can, pageAccess }: NavFilterCtx) {
  return function filterTab(t: NavTab): NavTab | null {
    // Sales-access model HIDE gate — cut entirely for ALL Sales users
    // (director included; checked first so it wins over any show-gate below).
    // Non-sales staff pass through unchanged.
    if (t.hideForSales && isSalesStaff(user)) return null;
    // Rep HIDE gate — cut from a NON-director Sales rep only (SCM trim +
    // Service-Cases board/metrics). Director/office pass through.
    if (t.hideForSalesRep && isSalesNonDirector(user)) return null;
    // Rep-only entry — visible ONLY to a non-director Sales rep; everyone else
    // (office/director) never sees it.
    if (t.salesRepOnly && !isSalesNonDirector(user)) return null;
    // Sales-access model SHOW bypass — Sales staff see `showForSales` entries
    // even without the usual permission / page-access gate (keyed off the org
    // department, NOT the config matrix). HIDE gates (above + hidePerm /
    // requireFinanceViewer below) still apply.
    const salesBypass =
      (!!t.showForSales && isSalesStaff(user)) ||
      (!!t.showForSalesDirector && isSalesDirectorUser(user)) ||
      (!!t.showForSalesRep && isSalesNonDirector(user)) ||
      (!!t.salesRepOnly && isSalesNonDirector(user));
    if (!salesBypass) {
      if (t.perm && !can(t.perm)) return null;
      // `anyPerm` + `anyAccess` are ORed: when both are present the tab shows
      // if EITHER a listed permission OR a listed page-access key passes. This
      // keeps the SCM nav ADDITIVE — `scm.access`/`*` still grant everything,
      // and a per-position SCM page-access grant ALSO unlocks its area.
      if (t.anyPerm || t.anyAccess) {
        // For users with an explicit SCM L2 config, `scm.access` no longer
        // auto-shows every SCM nav item — visibility falls to the granular
        // page_access (anyAccess), mirroring the backend area-guard. `*` still
        // shows everything; scm.access-only users (no L2) are unaffected.
        const navPerms =
          user?.scm_l2_configured && t.anyPerm
            ? t.anyPerm.filter((p) => p !== "scm.access")
            : t.anyPerm;
        const permOk = navPerms ? navPerms.some((p) => can(p)) : false;
        const accessOk = t.anyAccess
          ? t.anyAccess.some((k) => pageAccess(k) !== "none")
          : false;
        if (!permOk && !accessOk) return null;
      }
      // Page-access (mig 073) — `pageAccess` requires >= partial; the
      // -Full variant requires "full". Wildcard short-circuits to full
      // inside `pageAccess(...)`.
      if (t.pageAccess && pageAccess(t.pageAccess) === "none") return null;
      if (t.pageAccessFull && pageAccess(t.pageAccessFull) !== "full")
        return null;
    }
    if (t.hidePerm && can(t.hidePerm)) return null;
    if (t.requireFinanceViewer && !user?.project_finance_viewer) return null;
    // Rep click-target override — a non-director Sales rep's group headers point
    // at a reachable leaf (Supply Chain -> /scm/sales-orders, Service Cases ->
    // /my-cases) instead of the /scm or board hub that would 403 them.
    const to = t.salesRepTo && isSalesNonDirector(user) ? t.salesRepTo : t.to;
    if (t.children) {
      const kids = t.children
        .map(filterTab)
        .filter((x): x is NavTab => x !== null);
      if (kids.length === 0) return null;
      return { ...t, to, children: kids };
    }
    return to === t.to ? t : { ...t, to };
  };
}
