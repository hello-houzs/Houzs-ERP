import { describe, expect, test } from "vitest";
import {
  splitRuleFor,
  groupKeyFor,
  windowStartOf,
  DEFAULT_MATTRESS_WINDOW_DAYS,
  type GroupKeyInput,
} from "../src/scm/lib/po-grouping";

/* The owner's per-category PO rule (2026-07-17):
     bedframe -> one SO, one PO
     sofa     -> one SO, one PO  (also the pre-existing dye-lot rule)
     mattress -> merge, but bounded by a delivery-date window, "为了优化我们整体的
                 Inventory Turnover Rate"

   The window is the whole point of these tests. Unbounded merging would fold a
   mattress due in three months into this week's PO — stock landing a quarter
   early, i.e. turnover made WORSE by the rule meant to improve it. */

const WH = "11111111-1111-4111-8111-111111111111";
const SUP = "22222222-2222-4222-8222-222222222222";

function line(over: Partial<GroupKeyInput> = {}): GroupKeyInput {
  return {
    warehouseId: WH,
    supplierId: SUP,
    soDocNo: "SO-2607-001",
    itemGroup: "mattress",
    deliveryDate: "2026-12-09", // a Wednesday
    ...over,
  };
}

describe("splitRuleFor — the owner ruled on three categories, and only three", () => {
  test("bedframe splits per SO regardless of the toggle", () => {
    expect(splitRuleFor("bedframe", "combined")).toEqual({ kind: "per-so" });
    expect(splitRuleFor("bedframe", "per-so")).toEqual({ kind: "per-so" });
  });

  test("sofa splits per SO regardless of the toggle (dye lot, and the owner's rule)", () => {
    expect(splitRuleFor("sofa", "combined")).toEqual({ kind: "per-so" });
    expect(splitRuleFor("sofa", "per-so")).toEqual({ kind: "per-so" });
  });

  test("mattress merges per window regardless of the toggle", () => {
    expect(splitRuleFor("mattress", "combined")).toEqual({ kind: "per-window", windowDays: 7 });
    expect(splitRuleFor("mattress", "per-so")).toEqual({ kind: "per-window", windowDays: 7 });
  });

  test("a category he did NOT rule on still follows the operator's toggle", () => {
    expect(splitRuleFor("accessory", "combined")).toEqual({ kind: "combined" });
    expect(splitRuleFor("accessory", "per-so")).toEqual({ kind: "per-so" });
    expect(splitRuleFor("service", "combined")).toEqual({ kind: "combined" });
  });

  test("item_group is free text with no CHECK — unknown and null follow the toggle, never throw", () => {
    expect(splitRuleFor("curtains", "combined")).toEqual({ kind: "combined" });
    expect(splitRuleFor(null, "per-so")).toEqual({ kind: "per-so" });
    expect(splitRuleFor(undefined, "combined")).toEqual({ kind: "combined" });
    expect(splitRuleFor("  ", "combined")).toEqual({ kind: "combined" });
  });

  test("matching is case- and whitespace-tolerant — item_group is not normalised upstream", () => {
    expect(splitRuleFor("SOFA", "combined")).toEqual({ kind: "per-so" });
    expect(splitRuleFor(" Bedframe ", "combined")).toEqual({ kind: "per-so" });
  });

  test("a nonsense window falls back to the default rather than collapsing every mattress into one PO", () => {
    expect(splitRuleFor("mattress", "combined", 0)).toEqual({ kind: "per-window", windowDays: 7 });
    expect(splitRuleFor("mattress", "combined", -3)).toEqual({ kind: "per-window", windowDays: 7 });
    expect(splitRuleFor("mattress", "combined", NaN)).toEqual({ kind: "per-window", windowDays: 7 });
    expect(splitRuleFor("mattress", "combined", 14)).toEqual({ kind: "per-window", windowDays: 14 });
  });
});

describe("windowStartOf — a 7-day window IS the ISO week, so a human can name it", () => {
  test("every day of one Mon-Sun week buckets to that Monday", () => {
    for (const d of ["2026-12-07", "2026-12-09", "2026-12-13"]) {
      expect(windowStartOf(d, 7)).toBe("2026-12-07"); // Monday
    }
  });

  test("the next day after Sunday starts a new bucket", () => {
    expect(windowStartOf("2026-12-13", 7)).toBe("2026-12-07"); // Sun
    expect(windowStartOf("2026-12-14", 7)).toBe("2026-12-14"); // Mon
  });

  test("a 14-day window still lands on a Monday, two weeks apart", () => {
    const a = windowStartOf("2026-12-07", 14)!;
    const b = windowStartOf("2026-12-20", 14)!;
    expect(a).toBe(b);
    expect(windowStartOf("2026-12-21", 14)).not.toBe(a);
  });

  test("an unparseable or missing date yields null — it does not guess a bucket", () => {
    expect(windowStartOf(null, 7)).toBeNull();
    expect(windowStartOf(undefined, 7)).toBeNull();
    expect(windowStartOf("not-a-date", 7)).toBeNull();
    expect(windowStartOf("", 7)).toBeNull();
  });

  test("an ISO timestamp is truncated to its date", () => {
    expect(windowStartOf("2026-12-09T18:00:00Z", 7)).toBe("2026-12-07");
  });
});

describe("groupKeyFor — same key means same PO", () => {
  test("MATTRESS: two SOs due the same week share ONE PO", () => {
    const a = groupKeyFor(line({ soDocNo: "SO-A", deliveryDate: "2026-12-07" }), "combined");
    const b = groupKeyFor(line({ soDocNo: "SO-B", deliveryDate: "2026-12-11" }), "combined");
    expect(a).toBe(b);
  });

  test("MATTRESS: the turnover rule — a mattress three months out does NOT join this week's PO", () => {
    const now = groupKeyFor(line({ soDocNo: "SO-A", deliveryDate: "2026-12-09" }), "combined");
    const later = groupKeyFor(line({ soDocNo: "SO-B", deliveryDate: "2027-03-10" }), "combined");
    expect(now).not.toBe(later);
  });

  test("MATTRESS: adjacent weeks are separate POs", () => {
    const wk1 = groupKeyFor(line({ deliveryDate: "2026-12-13" }), "combined"); // Sun
    const wk2 = groupKeyFor(line({ deliveryDate: "2026-12-14" }), "combined"); // Mon
    expect(wk1).not.toBe(wk2);
  });

  test("MATTRESS: an UNDATED line falls back to its own SO rather than merging blind", () => {
    const a = groupKeyFor(line({ soDocNo: "SO-A", deliveryDate: null }), "combined");
    const b = groupKeyFor(line({ soDocNo: "SO-B", deliveryDate: null }), "combined");
    expect(a).not.toBe(b);
    expect(a).toContain("SO-A");
  });

  test("BEDFRAME: two SOs due the same week are still TWO POs", () => {
    const a = groupKeyFor(line({ itemGroup: "bedframe", soDocNo: "SO-A", deliveryDate: "2026-12-07" }), "combined");
    const b = groupKeyFor(line({ itemGroup: "bedframe", soDocNo: "SO-B", deliveryDate: "2026-12-09" }), "combined");
    expect(a).not.toBe(b);
  });

  test("SOFA: same SO, same PO — the whole set stays in one dye lot", () => {
    const a = groupKeyFor(line({ itemGroup: "sofa", soDocNo: "SO-A", deliveryDate: "2026-12-07" }), "combined");
    const b = groupKeyFor(line({ itemGroup: "sofa", soDocNo: "SO-A", deliveryDate: "2026-12-09" }), "combined");
    expect(a).toBe(b);
  });

  test("SOFA: two SOs never share a PO, even in the same week", () => {
    const a = groupKeyFor(line({ itemGroup: "sofa", soDocNo: "SO-A" }), "combined");
    const b = groupKeyFor(line({ itemGroup: "sofa", soDocNo: "SO-B" }), "combined");
    expect(a).not.toBe(b);
  });

  test("a mixed pick gets all three rules in ONE convert — the thing the global toggle could not do", () => {
    const bfA = groupKeyFor(line({ itemGroup: "bedframe", soDocNo: "SO-A" }), "combined");
    const bfB = groupKeyFor(line({ itemGroup: "bedframe", soDocNo: "SO-B" }), "combined");
    const mtA = groupKeyFor(line({ itemGroup: "mattress", soDocNo: "SO-A" }), "combined");
    const mtB = groupKeyFor(line({ itemGroup: "mattress", soDocNo: "SO-B" }), "combined");
    expect(bfA).not.toBe(bfB); // bedframe split
    expect(mtA).toBe(mtB); // mattress merged
  });

  test("WAREHOUSE stays in every key — each PO must be single-warehouse for the GRN", () => {
    const kl = groupKeyFor(line({ warehouseId: WH }), "combined");
    const pg = groupKeyFor(line({ warehouseId: "33333333-3333-4333-8333-333333333333" }), "combined");
    expect(kl).not.toBe(pg);
  });

  test("SUPPLIER stays in every key — one PO is one supplier's order", () => {
    const a = groupKeyFor(line(), "combined");
    const b = groupKeyFor(line({ supplierId: "44444444-4444-4444-8444-444444444444" }), "combined");
    expect(a).not.toBe(b);
  });

  test("a null warehouse buckets under a literal, not undefined", () => {
    expect(groupKeyFor(line({ warehouseId: null }), "combined")).toContain("null::");
  });

  test("the bucket does not depend on WHEN the convert runs — same line, same key, always", () => {
    const k1 = groupKeyFor(line({ deliveryDate: "2026-12-09" }), "combined");
    const k2 = groupKeyFor(line({ deliveryDate: "2026-12-09" }), "combined");
    expect(k1).toBe(k2);
    expect(k1).toContain("w2026-12-07");
  });

  test("the default window is a week", () => {
    expect(DEFAULT_MATTRESS_WINDOW_DAYS).toBe(7);
  });
});
