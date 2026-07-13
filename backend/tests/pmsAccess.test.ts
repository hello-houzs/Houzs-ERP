import { describe, expect, test } from "vitest";
import {
  getPmsAccess,
  isFinanceViewer,
  financeHiddenForUser,
  isSensitiveChecklistItem,
} from "../src/services/pmsAccess";
import { stripSensitiveChecklist } from "../src/services/projects";
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
  test("Sales Director sees financials + rental + payment + sensitive + delete", () => {
    const a = getPmsAccess(user({ position_name: "Sales Director" }), { pic_id: 99 });
    expect(a.role).toBe("DIRECTOR");
    expect(a.canFinancial).toBe(true);
    expect(a.canRental).toBe(true);
    expect(a.canPayment).toBe(true);
    expect(a.canSensitive).toBe(true);
    expect(a.canEdit).toBe(true);
    expect(a.sections).toContain("ACTIONS");
  });

  test("Sales PIC is READ-ONLY on the project (no broad EDIT) and no payment/sensitive", () => {
    const a = getPmsAccess(user({ id: 7, position_name: "Sales Executive" }), { pic_id: 7 });
    expect(a.role).toBe("PIC");
    expect(a.canEdit).toBe(false);
    expect(a.canPayment).toBe(false);
    expect(a.canSensitive).toBe(false);
    expect(a.sections).not.toContain("EDIT");
    expect(a.sections).not.toContain("PAYMENT");
    expect(a.sections).not.toContain("WF_SENSITIVE");
    // Still opens + views the project.
    expect(a.canOpen).toBe(true);
    expect(a.sections).toContain("SETUP_DISMANTLE");
  });

  test("isFinanceViewer / financeHiddenForUser gate money for non-directors only", () => {
    const director = user({ position_name: "Sales Director" });
    const salesPic = user({ id: 7, position_name: "Sales Executive" });
    const unmigrated = { ...user({ position_name: "Sales Executive" }), position_id: null } as AuthUser;
    expect(isFinanceViewer(director)).toBe(true);
    expect(isFinanceViewer(salesPic)).toBe(false);
    // Director never hidden; sales hidden; un-migrated (no position) keeps legacy access.
    expect(financeHiddenForUser(director)).toBe(false);
    expect(financeHiddenForUser(salesPic)).toBe(true);
    expect(financeHiddenForUser(unmigrated)).toBe(false);
    expect(financeHiddenForUser(null)).toBe(false);
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

describe("WF_SENSITIVE checklist stripping — quotation / agreement", () => {
  test("isSensitiveChecklistItem matches the Agreement / Quotation row only", () => {
    expect(isSensitiveChecklistItem({ title: "Agreement / Quotation" })).toBe(true);
    // Tolerates stray surrounding whitespace from a hand-edited row.
    expect(isSensitiveChecklistItem({ title: "  Agreement / Quotation " })).toBe(true);
    expect(isSensitiveChecklistItem({ title: "Security Deposit" })).toBe(false);
    expect(isSensitiveChecklistItem({ title: "3D Design" })).toBe(false);
    expect(isSensitiveChecklistItem({ title: null })).toBe(false);
    expect(isSensitiveChecklistItem(null)).toBe(false);
  });

  test("strips the sensitive row + its comments/attachments and drops the emptied section", () => {
    const detail = {
      checklist: [
        { id: 1, title: "Agreement / Quotation", section_id: 10, status: "done" },
        { id: 2, title: "3D Design", section_id: 20, status: "pending" },
      ],
      checklist_comments: [
        { id: 100, item_id: 1, body: "signed" },
        { id: 101, item_id: 2, body: "wip" },
      ],
      checklist_attachments: [
        { id: 200, item_id: 1 },
        { id: 201, item_id: 2 },
      ],
      sections: [
        { id: 10, name: "CONTRACT", sort_order: 10 },
        { id: 20, name: "3D APPROVAL", sort_order: 20 },
      ],
      section_progress: [
        { id: 10, name: "CONTRACT", total: 1, done: 1, na: 0, complete: 1 },
        { id: 20, name: "3D APPROVAL", total: 1, done: 0, na: 0, complete: 0 },
      ],
    };
    const out = stripSensitiveChecklist(detail);
    expect(out.checklist.map((r: any) => r.id)).toEqual([2]);
    expect(out.checklist_comments.map((r: any) => r.id)).toEqual([101]);
    expect(out.checklist_attachments.map((r: any) => r.id)).toEqual([201]);
    // CONTRACT held only the sensitive row → section + its progress dropped.
    expect(out.sections.map((s: any) => s.id)).toEqual([20]);
    expect(out.section_progress.map((s: any) => s.id)).toEqual([20]);
  });

  test("keeps a section that still holds other items, recomputing its progress", () => {
    const detail = {
      checklist: [
        { id: 1, title: "Agreement / Quotation", section_id: 10, status: "done" },
        { id: 3, title: "Other contract doc", section_id: 10, status: "pending" },
      ],
      checklist_comments: [],
      checklist_attachments: [],
      sections: [{ id: 10, name: "CONTRACT", sort_order: 10 }],
      section_progress: [
        { id: 10, name: "CONTRACT", total: 2, done: 1, na: 0, complete: 0 },
      ],
    };
    const out = stripSensitiveChecklist(detail);
    expect(out.checklist.map((r: any) => r.id)).toEqual([3]);
    expect(out.sections.map((s: any) => s.id)).toEqual([10]);
    const cp = out.section_progress.find((s: any) => s.id === 10);
    expect(cp).toMatchObject({ total: 1, done: 0, na: 0, complete: 0 });
  });

  test("no sensitive rows → returns the payload untouched (same reference)", () => {
    const detail = {
      checklist: [{ id: 2, title: "3D Design", section_id: 20, status: "pending" }],
      checklist_comments: [],
      checklist_attachments: [],
      sections: [{ id: 20, name: "3D APPROVAL", sort_order: 20 }],
      section_progress: [{ id: 20, total: 1, done: 0, na: 0, complete: 0 }],
    };
    expect(stripSensitiveChecklist(detail)).toBe(detail);
  });
});
