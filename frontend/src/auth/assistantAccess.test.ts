import { describe, expect, test } from "vitest";
import { ASSISTANT_DENIED_POSITIONS, canUseAssistant } from "./assistantAccess";

/* LOCKSTEP with backend/src/services/assistant-scope.ts. The two files share no
   import under the vendored-clone architecture, so these fixtures ARE the contract.
   If the backend list changes and this does not, a Driver sees a menu item that
   403s — or worse, the FE hides a tab the backend would have served. */

describe("assistant deny list (FE mirror)", () => {
  test("exactly the three the owner named, lowercased", () => {
    expect([...ASSISTANT_DENIED_POSITIONS].sort()).toEqual(["driver", "helper", "storekeeper", "storekeeper supervisor"]);
  });

  test("denies the field crew, allows everyone else", () => {
    for (const p of ["Driver", "Helper", "Storekeeper", " storekeeper ", "Storekeeper Supervisor"]) {
      expect(canUseAssistant({ permissions: [], position_name: p }), p).toBe(false);
    }
    for (const p of ["Sales Executive", "Operation Manager", null]) {
      expect(canUseAssistant({ permissions: [], position_name: p }), String(p)).toBe(true);
    }
  });

  test("wildcard bypasses the deny list", () => {
    expect(canUseAssistant({ permissions: ["*"], position_name: "Driver" })).toBe(true);
  });
});
