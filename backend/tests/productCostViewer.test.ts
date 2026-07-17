import { describe, expect, test } from "vitest";
import {
  isProductCostViewer,
  isDirectorUser,
  isFinanceViewer,
  financeHiddenForUser,
  getPmsAccess,
  getPmsRole,
} from "../src/services/pmsAccess";
import type { AuthUser } from "../src/services/auth";

/* Owner 2026-07-17, shown that his 2026-06-13 red line ("Only Purchasing +
   Finance see cost") was not in force because Purchasing is in no cost cohort:
   "那就是采购、Finance，还有 Sales Director 啊？"

   The cost question rode `project_finance_viewer`, which answers "are you a PMS
   DIRECTOR". Two questions, one flag — so restoring Purchasing to the cost
   cohort by widening that flag would ALSO have handed him every project's
   financials and made him a director. These lock BOTH halves: that Purchasing
   gains cost, and that he gains nothing else. The second is the acceptance
   test — widening a gate is the direction that leaks. */

function user(over: {
  id?: number;
  position_name?: string | null;
  department_name?: string | null;
  perms?: string[];
}): AuthUser {
  const perms = over.perms ?? [];
  return {
    id: over.id ?? 1,
    email: "t@test.local",
    name: "t",
    role_id: 1,
    role_name: "r",
    position_id: 1,
    position_name: over.position_name ?? null,
    status: "active",
    permissions: perms,
    permissions_set: new Set(perms),
    manager_id: null,
    scope_to_pic: false,
    department_id: null,
    department_name: over.department_name ?? null,
    brand_scope: null,
    page_access: {},
    scm_l2_configured: false,
  } as AuthUser;
}

const purchasing = user({ position_name: "Purchasing", department_name: "Operation Department" });

describe("product-cost cohort", () => {
  test("Purchasing sees cost — the restoration", () => {
    expect(isProductCostViewer(purchasing)).toBe(true);
  });

  test("Purchasing gains NOTHING ELSE — no PMS financials, not a director", () => {
    // The whole reason this is its own flag. If any of these flip, the change
    // has handed Purchasing the PMS project financials the owner never asked for.
    expect(isDirectorUser(purchasing)).toBe(false);
    expect(isFinanceViewer(purchasing)).toBe(false);
    expect(financeHiddenForUser(purchasing)).toBe(true);

    const access = getPmsAccess(purchasing, { pic_id: null });
    expect(getPmsRole(purchasing, { pic_id: null })).toBe("PURCHASING");
    expect(access.canFinancial).toBe(false);
    expect(access.canRental).toBe(false);
    expect(access.canPayment).toBe(false);
    expect(access.canSensitive).toBe(false);
    expect(access.canEdit).toBe(false);
    expect(access.sections).toEqual(["BOOTH_LAYOUT", "SETUP_DISMANTLE"]);

    // Even as the PIC of the project — PIC is per-project, not a title, and it
    // must not become a back door to the financial snapshot either.
    expect(getPmsAccess(purchasing, { pic_id: purchasing.id }).canFinancial).toBe(false);
  });

  test("a Sales Executive still gains nothing — the cohort did not widen sideways", () => {
    const sales = user({ position_name: "Sales Executive", department_name: "Sales Department" });
    expect(isProductCostViewer(sales)).toBe(false);
    expect(isDirectorUser(sales)).toBe(false);
  });

  test("the `*` wildcard is unaffected — it sees cost, as it always did", () => {
    const owner = user({ position_name: "Owner", department_name: "Management", perms: ["*"] });
    expect(isProductCostViewer(owner)).toBe(true);
    expect(isDirectorUser(owner)).toBe(true);
  });

  test("Sales Director + Finance Manager keep cost — the ruling's other two names", () => {
    expect(isProductCostViewer(user({ position_name: "Sales Director" }))).toBe(true);
    expect(isProductCostViewer(user({ position_name: "Finance Manager" }))).toBe(true);
    // Strict superset: every director is a cost viewer, by construction.
    expect(isProductCostViewer(user({ position_name: "Super Admin" }))).toBe(true);
  });

  test("a prefixed live position still matches — the failure this change ends", () => {
    // Prod positions carry prefixes ("Test Sales Director", projectAcl.ts:23).
    // An anchored /^Purchasing$/i would drop the live row and leave the ruling
    // dead exactly as before.
    expect(isProductCostViewer(user({ position_name: "Test Purchasing" }))).toBe(true);
    // ...and it is still not a director.
    expect(isDirectorUser(user({ position_name: "Test Purchasing" }))).toBe(false);
  });

  test("no position / no user → no cost (fails closed)", () => {
    expect(isProductCostViewer(user({ position_name: null }))).toBe(false);
    expect(isProductCostViewer(null)).toBe(false);
    expect(isProductCostViewer(undefined)).toBe(false);
  });
});
