import { describe, it, expect } from "vitest";
import { NAV_TABS, type NavTab } from "./Sidebar";
import { makeNavFilter, makeNavVisible, type NavFilterCtx } from "./navFilter";
import type { AuthUser } from "../types";

/**
 * Desktop/phone nav agreement — owner's standing rule: "電腦電話的權限應該一樣的"
 * (the laptop and the phone must grant the same thing).
 *
 * The two surfaces consume NAV_TABS through DIFFERENT walks: the desktop filters
 * the TREE (a hidden group is dropped whole, children unmapped), the phone gates
 * each destination against the matching LEAF. So a leaf can disagree with itself
 * across surfaces without either walk looking wrong on its own — that is exactly
 * how the Amendments rule below sat dead on desktop for a day while shipping on
 * the phone. These tests pin the agreement itself, not either walk.
 */

const rep = (over: Partial<AuthUser> = {}): AuthUser =>
  ({
    id: 1,
    email: "rep@example.test",
    name: "Rep",
    role_id: 1,
    role_name: "user",
    status: "active",
    permissions: [],
    position_name: "Sales Executive",
    department_name: "Sales Department",
    ...over,
  }) as AuthUser;

const ctxFor = (
  user: AuthUser,
  access: Record<string, string> = {},
): NavFilterCtx => ({
  user,
  can: (p) => (user.permissions ?? []).includes(p),
  pageAccess: (page) => (access[page] ?? "none") as never,
});

/** The desktop Sidebar's view: filter the tree, then flatten what survived. */
function desktopPaths(ctx: NavFilterCtx): string[] {
  const filterTab = makeNavFilter(ctx);
  const out: string[] = [];
  const walk = (t: NavTab) => {
    if (t.to) out.push(t.to.split("?")[0]);
    (t.children ?? []).forEach(walk);
  };
  NAV_TABS.map(filterTab)
    .filter((t): t is NavTab => t !== null)
    .forEach(walk);
  return out;
}

/** The mobile shell's view — a faithful copy of MobileApp's `allowed(to)`:
 *  walk the RAW tree and ask whether ANY node at that path is visible. */
function phoneAllows(ctx: NavFilterCtx, to: string): boolean {
  const navVisible = makeNavVisible(ctx);
  const flat: NavTab[] = [];
  const walk = (t: NavTab) => {
    flat.push(t);
    (t.children ?? []).forEach(walk);
  };
  NAV_TABS.forEach(walk);
  const path = to.split("?")[0];
  const matches = flat.filter((t) => t.to?.split("?")[0] === path);
  return matches.length === 0 ? true : matches.some(navVisible);
}

describe("nav — Amendments for a sales rep (owner rule 2026-07-16)", () => {
  const access = { "scm.sales.orders": "edit" };

  it("shows Amendments on BOTH desktop and phone", () => {
    const ctx = ctxFor(rep(), access);
    expect(desktopPaths(ctx)).toContain("/scm/amendments");
    expect(phoneAllows(ctx, "/scm/amendments")).toBe(true);
  });

  it("shows it exactly once on desktop — no duplicate row", () => {
    const ctx = ctxFor(rep(), access);
    const hits = desktopPaths(ctx).filter((p) => p === "/scm/amendments");
    expect(hits).toHaveLength(1);
  });

  /* The rep leaf must not depend on the SCM matrix: /scm/amendments is an
     `allowSales` route (App.tsx ScmGuard), which admits ANY sales staff whatever
     their page access. A nav gate stricter than the route would hide a page the
     rep can still reach by typing the URL. */
  it("shows Amendments even with no SCM page access at all", () => {
    const ctx = ctxFor(rep(), {});
    expect(desktopPaths(ctx)).toContain("/scm/amendments");
    expect(phoneAllows(ctx, "/scm/amendments")).toBe(true);
  });
});

describe("nav — the rep SCM trim stays trimmed", () => {
  /* The guard on the fix. The Amendments leaf sits inside a hideForSalesRep
     group whose OTHER children are not individually flagged, so the tempting
     "make the filter recurse into hidden groups" fix would have surfaced all of
     these too. Each one is a real permission boundary, not a nicety. */
  const leaked = [
    "/scm/consignment-orders",
    "/scm/consignment-notes",
    "/scm/consignment-returns",
    "/scm/purchase-consignment-orders",
    "/scm/purchase-consignment-receives",
    "/scm/purchase-consignment-returns",
    "/scm/accounting",
    "/scm/payment-vouchers",
    "/scm/outstanding",
    "/scm/unbilled-deliveries",
    "/scm/currencies",
    "/scm/products",
    "/scm/suppliers",
    "/scm/mrp",
    "/scm/purchase-orders",
    "/scm/grns",
    "/scm/inventory",
    "/scm/stock-takes",
    "/scm/delivery-returns",
  ];

  it.each(leaked)("hides %s from a sales rep on desktop AND phone", (path) => {
    const ctx = ctxFor(rep(), { "scm.sales.orders": "edit" });
    expect(desktopPaths(ctx)).not.toContain(path);
    expect(phoneAllows(ctx, path)).toBe(false);
  });
});

describe("nav — office and director are untouched by the rep leaf", () => {
  /* The Supply Chain umbrella lists only L1 area keys in its anyAccess, so a
     user reaching Amendments by the subgroup path needs the L1 scm.sales grant,
     not just the L2 scm.sales.orders one. */
  const officeAccess = { "scm.sales": "edit", "scm.sales.orders": "edit" };

  it("keeps Amendments for a Sales Director (subgroup path)", () => {
    const dir = rep({
      position_name: "Sales Director",
      project_finance_viewer: true,
    });
    const ctx = ctxFor(dir, officeAccess);
    const hits = desktopPaths(ctx).filter((p) => p === "/scm/amendments");
    expect(hits).toHaveLength(1);
    expect(phoneAllows(ctx, "/scm/amendments")).toBe(true);
  });

  it("keeps Amendments for non-sales office staff", () => {
    const office = rep({
      position_name: "Admin Executive",
      department_name: "Office",
    });
    const ctx = ctxFor(office, officeAccess);
    const hits = desktopPaths(ctx).filter((p) => p === "/scm/amendments");
    expect(hits).toHaveLength(1);
  });

  it("does not give the rep-only leaf to office staff", () => {
    const office = rep({
      position_name: "Admin Executive",
      department_name: "Office",
    });
    const ctx = ctxFor(office, {});
    expect(desktopPaths(ctx)).not.toContain("/scm/amendments");
  });
});
