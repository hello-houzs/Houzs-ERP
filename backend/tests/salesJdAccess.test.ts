import { describe, expect, test } from "vitest";
import { applySalesJdOverride } from "../src/services/salesJdAccess";
import type { AccessLevel } from "../src/services/pageAccess";

/* The Sales JD is a RULE, not a setting (owner 2026-07-17: "用coding 去改backend
   … 把整個sales department的這個移除掉 根據我們的指令來做"). These lock the rule
   itself — the matrix cannot be trusted to express it and a mis-click must not
   be able to kill the document chain at step one. */

const MATRIX_SAYS_VIEW: Record<string, AccessLevel> = {
  "scm.sales.orders": "view",
  "scm.sales.delivery": "view",
  "scm.sales.invoices": "view",
  "scm.sales.returns": "view",
  "projects": "view",
};

const salesRep = {
  permissions: new Set<string>(["scm.access"]),
  position_name: "Sales Executive",
  department_name: "Sales Department",
};

describe("Sales JD override", () => {
  test("Sales OWNS the SO — edit, whatever the matrix says", () => {
    const out = applySalesJdOverride(MATRIX_SAYS_VIEW, salesRep);
    expect(out["scm.sales.orders"]).toBe("edit");
  });

  test("Office operates DO + SI — Sales only looks", () => {
    const out = applySalesJdOverride(
      { ...MATRIX_SAYS_VIEW, "scm.sales.delivery": "full", "scm.sales.invoices": "edit" },
      salesRep,
    );
    expect(out["scm.sales.delivery"]).toBe("view");
    expect(out["scm.sales.invoices"]).toBe("view");
  });

  test("Delivery Returns is off for the cohort — including the director", () => {
    expect(applySalesJdOverride(MATRIX_SAYS_VIEW, salesRep)["scm.sales.returns"]).toBe("none");
    expect(
      applySalesJdOverride(MATRIX_SAYS_VIEW, {
        permissions: new Set<string>(),
        position_name: "Sales Director",
        department_name: "Sales Department",
      })["scm.sales.returns"],
    ).toBe("none");
  });

  test("the `*` wildcard is UNTOUCHED — narrowing it would lock the owner out", () => {
    const full: Record<string, AccessLevel> = { "scm.sales.returns": "full" };
    const out = applySalesJdOverride(full, {
      permissions: new Set<string>(["*"]),
      position_name: "Owner",
      department_name: "Management",
    });
    expect(out).toBe(full);
    expect(out["scm.sales.returns"]).toBe("full");
  });

  test("non-Sales is untouched — Office keeps what its position grants", () => {
    const office: Record<string, AccessLevel> = {
      "scm.sales.delivery": "edit",
      "scm.sales.invoices": "edit",
      "scm.sales.returns": "edit",
    };
    const out = applySalesJdOverride(office, {
      permissions: new Set<string>(),
      position_name: "Operation Executive",
      department_name: "Operation Department",
    });
    expect(out).toBe(office);
    expect(out["scm.sales.delivery"]).toBe("edit");
  });

  test("cohort matches on DEPARTMENT even when the position name does not start with Sales", () => {
    const out = applySalesJdOverride(MATRIX_SAYS_VIEW, {
      permissions: new Set<string>(),
      position_name: "Senior Account Executive",
      department_name: "Sales Department",
    });
    expect(out["scm.sales.orders"]).toBe("edit");
  });

  test("pages outside the SCM sales chain are left to the matrix", () => {
    const out = applySalesJdOverride(MATRIX_SAYS_VIEW, salesRep);
    expect(out["projects"]).toBe("view");
  });

  /* PINS TODAY'S BEHAVIOUR — NOT AN ENDORSEMENT OF IT.
     The Sales Director matches isSalesCohort, so the JD is SET on him and CAPS
     him at `view` on DO/SI whatever his matrix row grants. The owner's JD quote
     names "销售人员"; he has never ruled whether that includes the Director
     (`feat/z1-jd-consolidate`, 2026-07-17 — the recorded blocker). This test
     exists so that when he DOES rule, the change is deliberate and visible here
     rather than a silent side effect of touching isSalesCohort. */
  test("UNRULED: the Sales Director is in the cohort and is capped at view on DO/SI", () => {
    const director = {
      permissions: new Set<string>(["scm.access"]),
      position_name: "Sales Director",
      department_name: "Sales Department",
    };
    const out = applySalesJdOverride(
      { ...MATRIX_SAYS_VIEW, "scm.sales.delivery": "full", "scm.sales.invoices": "edit" },
      director,
    );
    expect(out["scm.sales.delivery"]).toBe("view");
    expect(out["scm.sales.invoices"]).toBe("view");
  });

  /* `role_page_access` is still live (auth.ts:297) — a user with NO position
     hydrates from the ROLE matrix and lands here anyway, because the cohort is
     keyed on department_name, which is independent of position_id. Any rule
     added to this file must keep working for them. */
  test("a Sales user with NO position still gets the JD (cohort is the department)", () => {
    const out = applySalesJdOverride(MATRIX_SAYS_VIEW, {
      permissions: new Set<string>(["scm.access"]),
      position_name: null,
      department_name: "Sales Department",
    });
    expect(out["scm.sales.orders"]).toBe("edit");
  });
});
