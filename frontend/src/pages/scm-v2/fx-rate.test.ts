import { describe, it, expect } from "vitest";
import { resolveFxRate } from "./fx-rate";

/**
 * The regression these guard is NOT "resolveFxRate returns a number" — it is
 * that the preview and the write now answer the same question the same way.
 * Under the old code the write paths inlined `(n > 0 && isFinite(n)) ? n : 1`
 * and the previews inlined `Number(x) || 0`; every case below where the
 * expectation is 1 is a case where the screen used to print RM 0.00 for money
 * the backend would post in full.
 */
describe("resolveFxRate", () => {
  it("passes a real keyed rate straight through", () => {
    expect(resolveFxRate("4.35")).toBe(4.35);
    expect(resolveFxRate(4.35)).toBe(4.35);
    expect(resolveFxRate("1")).toBe(1);
  });

  it("treats an UNSET rate as 1 — the value the write paths already post at", () => {
    // Each of these produced 0 in the old preview rule and 1 in the old write
    // rule. That divergence is the bug; they must now agree.
    expect(resolveFxRate("")).toBe(1);
    expect(resolveFxRate(null)).toBe(1);
    expect(resolveFxRate(undefined)).toBe(1);
    expect(resolveFxRate("abc")).toBe(1);
    expect(resolveFxRate(NaN)).toBe(1);
  });

  it("treats zero and negative as UNSET, not as a real rate", () => {
    // A currency is never worth nothing, so a stored 0 always means nobody
    // keyed it. Multiplying money by it is how a real total renders RM 0.00.
    expect(resolveFxRate(0)).toBe(1);
    expect(resolveFxRate("0")).toBe(1);
    expect(resolveFxRate("0.00")).toBe(1);
    expect(resolveFxRate(-3)).toBe(1);
  });

  it("rejects the infinities rather than propagating them into a total", () => {
    expect(resolveFxRate(Infinity)).toBe(1);
    expect(resolveFxRate(-Infinity)).toBe(1);
  });

  it("is byte-identical to the rule the write paths used to inline", () => {
    // The write paths must be provably unchanged by this refactor, so assert
    // the new helper against the exact expression that was deleted from
    // PaymentVoucherNew / PaymentVoucherDetail / PurchaseInvoiceNew / GrnNew.
    const oldWriteRule = (x: unknown) =>
      Number(x) > 0 && Number.isFinite(Number(x)) ? Number(x) : 1;
    const cases: unknown[] = [
      "4.35", 4.35, "1", "", null, undefined, "abc", NaN, 0, "0", "0.00",
      -3, Infinity, -Infinity, "  2.5  ", true, false, [], {},
    ];
    for (const c of cases) {
      expect(resolveFxRate(c)).toBe(oldWriteRule(c));
    }
  });
});
