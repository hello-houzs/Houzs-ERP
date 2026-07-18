import { describe, it, expect } from "vitest";
import { isDirectorUser, isSalesDirectorUser } from "./salesAccess";
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
