import { describe, expect, test } from "vitest";
import { getPmsAccess } from "../src/services/pmsAccess";
import type { AuthUser } from "../src/services/auth";

// Pure-function tests for the project-detail (PMS) section gating — the
// security boundary that hides financial/rental from non-finance positions.
// PIC is per-project (project.pic_id === user.id), not a job title.

function user(over: { id?: number; position_name?: string | null; perms?: string[] }): AuthUser {
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
    brand_scope: null,
    page_access: {},
  } as AuthUser;
}

describe("pmsAccess — project-detail section gating", () => {
  test("Sales Director sees financials + rental + delete", () => {
    const a = getPmsAccess(user({ position_name: "Sales Director" }), { pic_id: 99 });
    expect(a.role).toBe("DIRECTOR");
    expect(a.canFinancial).toBe(true);
    expect(a.canRental).toBe(true);
    expect(a.sections).toContain("ACTIONS");
  });

  test("Finance Manager is also a director (sees money)", () => {
    const a = getPmsAccess(user({ position_name: "Finance Manager" }), { pic_id: 99 });
    expect(a.role).toBe("DIRECTOR");
    expect(a.canFinancial).toBe(true);
  });

  test("wildcard (*) role = director", () => {
    const a = getPmsAccess(user({ perms: ["*"], position_name: null }), { pic_id: 1 });
    expect(a.role).toBe("DIRECTOR");
    expect(a.canFinancial).toBe(true);
  });

  test("Sales PIC of THIS project: most sections but NO financial/rental", () => {
    const a = getPmsAccess(user({ id: 7, position_name: "Sales Executive" }), { pic_id: 7 });
    expect(a.role).toBe("PIC");
    expect(a.canFinancial).toBe(false);
    expect(a.canRental).toBe(false);
    expect(a.sections).toContain("EVENT_CHAT");
    expect(a.sections).not.toContain("FINANCIAL");
    expect(a.sections).not.toContain("RENTAL");
  });

  test("Sales NOT the PIC: only setup/expo/chat, no booth, no money", () => {
    const a = getPmsAccess(user({ id: 7, position_name: "Sales Executive" }), { pic_id: 99 });
    expect(a.role).toBe("SALES");
    expect(a.sections).toEqual(
      expect.arrayContaining(["SETUP_DISMANTLE", "EXPO_MAP", "EVENT_CHAT"]),
    );
    expect(a.sections).not.toContain("FINANCIAL");
    expect(a.sections).not.toContain("BOOTH_LAYOUT");
  });

  test("Logistic = PIC sections minus event chat, no money", () => {
    const a = getPmsAccess(user({ position_name: "Logistic" }), { pic_id: 99 });
    expect(a.role).toBe("LOGISTIC");
    expect(a.canFinancial).toBe(false);
    expect(a.sections).toContain("BOOTH_LAYOUT");
    expect(a.sections).not.toContain("EVENT_CHAT");
  });

  test("Purchasing: booth layout + setup only, no money", () => {
    const a = getPmsAccess(user({ position_name: "Purchasing" }), { pic_id: 99 });
    expect(a.role).toBe("PURCHASING");
    expect(a.canFinancial).toBe(false);
    expect(a.sections).toEqual(expect.arrayContaining(["BOOTH_LAYOUT", "SETUP_DISMANTLE"]));
    expect(a.sections).not.toContain("EXPO_MAP");
  });

  test("Driver/Helper → DRIVER role (use the driver portal, not money)", () => {
    expect(getPmsAccess(user({ position_name: "Driver" }), { pic_id: 99 }).role).toBe("DRIVER");
    expect(getPmsAccess(user({ position_name: "Helper" }), { pic_id: 99 }).role).toBe("DRIVER");
  });

  test("Ops / HQ non-admin: view-only OTHER, never financial", () => {
    const a = getPmsAccess(user({ position_name: "Ops Manager" }), { pic_id: 99 });
    expect(a.role).toBe("OTHER");
    expect(a.canFinancial).toBe(false);
    expect(a.sections).not.toContain("FINANCIAL");
  });
});
