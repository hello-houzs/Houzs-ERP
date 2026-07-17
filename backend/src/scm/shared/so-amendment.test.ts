// Port of 2990 packages/shared/src/so-amendment.test.ts, alongside the port of
// so-amendment.ts itself. The two implementations are byte-identical apart from
// so-amendment.ts's header comment, so this suite ports 1:1 — no adaptation.
//
// Why it is worth porting rather than assuming: this state machine is the ONLY
// thing standing between a locked SO and an out-of-order transition, and it was
// the one axis where 2990 was genuinely ahead of us (it had this test; we had
// none). Houzs has since diverged UPWARDS from 2990 on amendments — mig 0119's
// header_changes / old_header_snapshot, company scoping, the mirror write guard
// — but every one of those sits in the ROUTE layer. The transitions below are
// the shared floor, and a silent edit to FLOW would otherwise be caught by
// nothing.

import { describe, it, expect } from "vitest";
import { nextStatus, canTransition, receivedFloorViolation, type AmendStatus } from "./so-amendment";

describe("so-amendment state machine", () => {
  it("allows the happy path in order", () => {
    expect(canTransition("REQUESTED", "supplier-confirm")).toBe(true);
    expect(canTransition("SUPPLIER_PENDING", "approve-so")).toBe(true);
    expect(canTransition("SO_APPROVED", "approve-po")).toBe(true);
    expect(canTransition("PO_APPROVED", "send")).toBe(true);
  });
  it("blocks out-of-order transitions", () => {
    expect(canTransition("REQUESTED", "approve-po")).toBe(false);
    expect(canTransition("SENT", "reject")).toBe(false);
  });
  it("allows reject from any pre-approved gate", () => {
    for (const s of ["REQUESTED", "SUPPLIER_PENDING", "SO_APPROVED", "PO_APPROVED"] as AmendStatus[])
      expect(canTransition(s, "reject")).toBe(true);
  });
  it("nextStatus maps each action", () => {
    expect(nextStatus("REQUESTED", "supplier-confirm")).toBe("SUPPLIER_PENDING");
    expect(nextStatus("SUPPLIER_PENDING", "approve-so")).toBe("SO_APPROVED");
  });
  it("flags a line dropping below received qty", () => {
    expect(receivedFloorViolation({ newQty: 1 }, { receivedQty: 3 })).toBe(true);
    expect(receivedFloorViolation({ newQty: 5 }, { receivedQty: 3 })).toBe(false);
    expect(receivedFloorViolation({ newQty: null }, { receivedQty: 3 })).toBe(false);
  });
});
