import { describe, it, expect } from "vitest";
import {
  isDirectorUser,
  isSalesDirectorUser,
  canOperateDeliveryOrders,
  canOperateSalesInvoices,
} from "./salesAccess";
import type { AuthUser } from "../types";

/**
 * FE mirror of the backend director / sales-director classification
 * (services/pmsAccess.ts). Position names are owner-editable FREE TEXT, so the
 * matchers key on EXACT normalised name, not a word-boundary regex: a rename
 * whose name merely CONTAINS a privileged title ("Assistant to Sales Director")
 * must NOT inherit that title's access. The backend is the authority; these
 * guards are UX + defence-in-depth, so they must agree with it.
 */

const u = (over: Partial<AuthUser> = {}): AuthUser =>
  ({
    id: 1,
    email: "t@example.test",
    name: "T",
    role_id: 1,
    role_name: "user",
    status: "active",
    permissions: [],
    position_name: null,
    department_name: null,
    ...over,
  }) as AuthUser;

// ── LOCKSTEP FIXTURE — MUST stay identical to backend/tests/pmsAccess.test.ts ──
// The two files carry no shared import (vendored-clone architecture), so these
// tables ARE the FE<->BE contract. Change one, change the other in the SAME commit.
const LOCKSTEP_DIRECTOR: ReadonlyArray<[string, boolean]> = [
  ["Super Admin", true],
  ["Sales Director", true],
  ["Finance Manager", true],
  ["sales director", true],
  ["  Sales   Director ", true],
  ["Assistant to Sales Director", false],
  ["Deputy Finance Manager", false],
  ["Senior Super Admin", false],
  ["Super Administrator", false],
  ["Sales Manager", false],
  ["HR Manager", false],
  ["Operation Manager", false],
];
const LOCKSTEP_SALES_DIRECTOR: ReadonlyArray<[string, boolean]> = [
  ["Sales Director", true],
  ["  sales director ", true],
  ["Assistant to Sales Director", false],
  ["Sales Executive", false],
  ["Sales Manager", false],
];

describe("salesAccess — position-name matcher hardening (FE mirror)", () => {
  it("isDirectorUser matches ONLY the exact director names", () => {
    for (const [name, expected] of LOCKSTEP_DIRECTOR) {
      expect(isDirectorUser(u({ position_name: name }))).toBe(expected);
    }
    // `*` wildcard and the precomputed backend flag are directors regardless.
    expect(isDirectorUser(u({ permissions: ["*"], position_name: "Assistant to Sales Director" }))).toBe(true);
    expect(isDirectorUser(u({ project_finance_viewer: true, position_name: "Sales Executive" }))).toBe(true);
  });

  it("isSalesDirectorUser matches ONLY the exact 'Sales Director'", () => {
    for (const [name, expected] of LOCKSTEP_SALES_DIRECTOR) {
      expect(isSalesDirectorUser(u({ position_name: name }))).toBe(expected);
    }
  });
});

/* ── DO / SI OPERATE GATE ────────────────────────────────────────────────────
   The ONE decision behind every Deliver / Convert / status control on BOTH
   platforms. It must agree with the backend caller-for-caller, because a button
   this shows and the server refuses is exactly the render-then-deny the owner
   hit: the SO quick-view "Deliver" button rendered on status alone and dropped a
   salesperson on <Forbidden>.

   Backend counterparts: scm/middleware/area-guard (writes need `edit` on the
   area) + services/salesJdAccess.salesJdWriteDenial (the Sales cohort is denied
   the write outright, L2-configured or not). */

/** A caller shape + the pageAccess/can pair the helper reads. */
const gate = (
  user: AuthUser,
  access: Record<string, string> = {},
  wildcard = false,
) => ({
  user,
  can: (p: string) => (wildcard ? true : p === "__never__"),
  pageAccess: ((page: string) =>
    (wildcard ? "full" : (access[page] ?? "none"))) as (p: string) => never,
});

describe("canOperateDeliveryOrders / canOperateSalesInvoices", () => {
  it("the Sales cohort may NOT operate a DO or an SI — owner: they only look", () => {
    for (const who of [
      u({ position_name: "Sales Executive", department_name: "Sales Department" }),
      u({ position_name: "Sales Manager", department_name: "Sales Department" }),
      // "sales director 算sales" + "DO SI 只能看 salesdirector".
      u({ position_name: "Sales Director", department_name: "Sales Department" }),
      // Positionless Sales-department user — the backend hole this pairs with.
      u({ position_name: null, department_name: "Sales Department" }),
    ]) {
      const g = gate(who, {
        "scm.sales.delivery": "view",
        "scm.sales.invoices": "view",
      });
      expect(canOperateDeliveryOrders(g.user, g.can, g.pageAccess)).toBe(false);
      expect(canOperateSalesInvoices(g.user, g.can, g.pageAccess)).toBe(false);
    }
  });

  it("a Sales user is denied even if the matrix says edit — the JD is the rule", () => {
    // A stale /auth/me payload must not re-offer a button the server refuses.
    const g = gate(
      u({ position_name: "Sales Executive", department_name: "Sales Department" }),
      { "scm.sales.delivery": "full", "scm.sales.invoices": "full" },
    );
    expect(canOperateDeliveryOrders(g.user, g.can, g.pageAccess)).toBe(false);
    expect(canOperateSalesInvoices(g.user, g.can, g.pageAccess)).toBe(false);
  });

  it("OFFICE operates both — nothing is taken from the people whose job it is", () => {
    const g = gate(
      u({ position_name: "Operation Executive", department_name: "Operation Department" }),
      { "scm.sales.delivery": "edit", "scm.sales.invoices": "full" },
    );
    expect(canOperateDeliveryOrders(g.user, g.can, g.pageAccess)).toBe(true);
    expect(canOperateSalesInvoices(g.user, g.can, g.pageAccess)).toBe(true);
  });

  it("`view` is not enough for a non-Sales user either — writes need edit", () => {
    const g = gate(
      u({ position_name: "Operation Executive", department_name: "Operation Department" }),
      { "scm.sales.delivery": "view", "scm.sales.invoices": "view" },
    );
    expect(canOperateDeliveryOrders(g.user, g.can, g.pageAccess)).toBe(false);
    expect(canOperateSalesInvoices(g.user, g.can, g.pageAccess)).toBe(false);
  });

  it("the `*` wildcard always passes — the owner is never narrowed", () => {
    const g = gate(
      u({ permissions: ["*"], position_name: "Sales Director", department_name: "Sales Department" }),
      {},
      true,
    );
    expect(canOperateDeliveryOrders(g.user, g.can, g.pageAccess)).toBe(true);
    expect(canOperateSalesInvoices(g.user, g.can, g.pageAccess)).toBe(true);
  });
});
