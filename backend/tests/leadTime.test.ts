import { describe, expect, test } from "vitest";
import {
  loadLeadTimeBase,
  resolveLeadDays,
  subtractCalendarDays,
  NO_BUFFERS,
  type LeadBuffers,
  type LeadTimeBase,
} from "../src/scm/lib/lead-time";

/* The PO's supplier delivery date is derived here, so these tests lock two
   things the codebase has already been bitten by:

   1. A failed lead-time read must THROW, never resolve to zero. The two copies
      this module replaces disagreed on exactly this — mrp.ts (a display hint)
      checked the error; mfg-purchase-orders.ts (which WRITES the supplier's
      date onto a real PO) discarded it. A blip there sends the PO out asking
      the supplier to deliver ON the customer's own date, silently.

   2. With no learned buffers the resolver must return exactly the owner's base
      number. That equivalence is what makes the convergence a provable no-op,
      so the learned layers can land as a separate, reversible change. */

const WH_KL = "11111111-1111-4111-8111-111111111111";
const WH_PG = "22222222-2222-4222-8222-222222222222";

function baseFrom(rows: Array<{ warehouse_id: string | null; category: string; lead_days: number }>) {
  return loadLeadTimeBase(Promise.resolve({ data: rows, error: null }));
}

describe("loadLeadTimeBase — a failed read must never read as zero", () => {
  test("a query error THROWS instead of yielding an empty (all-zero) table", async () => {
    await expect(
      loadLeadTimeBase(Promise.resolve({ data: null, error: { message: "503 upstream" } })),
    ).rejects.toThrow(/mrp_lead_times_load_failed/);
  });

  test("the throw carries the underlying reason, so the log names the real cause", async () => {
    await expect(
      loadLeadTimeBase(Promise.resolve({ data: null, error: { message: "pooler down" } })),
    ).rejects.toThrow(/pooler down/);
  });

  test("a genuinely empty table is NOT an error — it loads, and every lookup is 0", async () => {
    const base = await baseFrom([]);
    expect(resolveLeadDays(base, NO_BUFFERS, { warehouseId: WH_KL, category: "sofa" }).total).toBe(0);
  });

  test("a non-numeric lead_days row is skipped rather than poisoning the map with NaN", async () => {
    const base = await loadLeadTimeBase(
      Promise.resolve({
        data: [{ warehouse_id: null, category: "sofa", lead_days: "not-a-number" }],
        error: null,
      }),
    );
    expect(resolveLeadDays(base, NO_BUFFERS, { warehouseId: null, category: "sofa" }).total).toBe(0);
  });
});

describe("base cascade — (warehouse, category) -> (NULL, category) -> 0", () => {
  let base: LeadTimeBase;
  beforeAll(async () => {
    base = await baseFrom([
      { warehouse_id: null, category: "sofa", lead_days: 7 },
      { warehouse_id: null, category: "mattress", lead_days: 3 },
      { warehouse_id: WH_PG, category: "sofa", lead_days: 14 },
    ]);
  });

  test("a warehouse override wins over the global default", () => {
    expect(resolveLeadDays(base, NO_BUFFERS, { warehouseId: WH_PG, category: "sofa" }).total).toBe(14);
  });

  test("a warehouse with no row for that category falls back to the global default", () => {
    expect(resolveLeadDays(base, NO_BUFFERS, { warehouseId: WH_KL, category: "sofa" }).total).toBe(7);
  });

  test("a null warehouse reads the global default", () => {
    expect(resolveLeadDays(base, NO_BUFFERS, { warehouseId: null, category: "mattress" }).total).toBe(3);
  });

  test("an unknown category contributes 0 — item_group is free text, not a CHECK", () => {
    expect(resolveLeadDays(base, NO_BUFFERS, { warehouseId: WH_PG, category: "curtains" }).total).toBe(0);
  });

  test("category matching is case-insensitive — the column is lowercase, item_group is not", () => {
    expect(resolveLeadDays(base, NO_BUFFERS, { warehouseId: WH_PG, category: "SOFA" }).total).toBe(14);
  });

  test("a null category contributes 0 rather than throwing", () => {
    expect(resolveLeadDays(base, NO_BUFFERS, { warehouseId: WH_PG, category: null }).total).toBe(0);
  });
});

describe("the learned layers are additive and never touch the owner's base", () => {
  let base: LeadTimeBase;
  const buffers: LeadBuffers = {
    supplierBufferDays: { "SUP-LATE": 3 },
    seasonBufferDays: { "12": 2 },
  };
  beforeAll(async () => {
    base = await baseFrom([{ warehouse_id: null, category: "sofa", lead_days: 7 }]);
  });

  test("NO_BUFFERS returns exactly the base — the convergence is a provable no-op", () => {
    const r = resolveLeadDays(base, NO_BUFFERS, {
      warehouseId: null,
      category: "sofa",
      supplierCode: "SUP-LATE",
      deliveryDate: "2026-12-04",
    });
    expect(r).toEqual({ base: 7, supplier: 0, season: 0, total: 7 });
  });

  test("supplier + season stack on top of the base, each attributable", () => {
    const r = resolveLeadDays(base, buffers, {
      warehouseId: null,
      category: "sofa",
      supplierCode: "SUP-LATE",
      deliveryDate: "2026-12-04",
    });
    expect(r).toEqual({ base: 7, supplier: 3, season: 2, total: 12 });
  });

  test("a supplier with no learned buffer contributes 0, not undefined", () => {
    const r = resolveLeadDays(base, buffers, {
      warehouseId: null,
      category: "sofa",
      supplierCode: "SUP-PUNCTUAL",
      deliveryDate: "2026-06-04",
    });
    expect(r).toEqual({ base: 7, supplier: 0, season: 0, total: 7 });
  });

  test("no supplierCode skips the supplier layer entirely", () => {
    expect(resolveLeadDays(base, buffers, { warehouseId: null, category: "sofa" }).supplier).toBe(0);
  });

  test("the season keys off the month of the delivery date", () => {
    expect(
      resolveLeadDays(base, buffers, { warehouseId: null, category: "sofa", deliveryDate: "2026-12-31" })
        .season,
    ).toBe(2);
    expect(
      resolveLeadDays(base, buffers, { warehouseId: null, category: "sofa", deliveryDate: "2026-11-30" })
        .season,
    ).toBe(0);
  });

  test("an unparseable delivery date contributes no season rather than guessing a month", () => {
    expect(
      resolveLeadDays(base, buffers, { warehouseId: null, category: "sofa", deliveryDate: "not-a-date" })
        .season,
    ).toBe(0);
  });

  test("a NEGATIVE buffer is refused — it would pull the PO date PAST the customer's", () => {
    const bad: LeadBuffers = { supplierBufferDays: { "SUP-X": -5 }, seasonBufferDays: {} };
    const r = resolveLeadDays(base, bad, { warehouseId: null, category: "sofa", supplierCode: "SUP-X" });
    expect(r.supplier).toBe(0);
    expect(r.total).toBe(7);
  });

  test("a non-numeric buffer is refused rather than producing NaN days", () => {
    const bad = { supplierBufferDays: { "SUP-X": "three" }, seasonBufferDays: {} } as unknown as LeadBuffers;
    const r = resolveLeadDays(base, bad, { warehouseId: null, category: "sofa", supplierCode: "SUP-X" });
    expect(r.total).toBe(7);
  });
});

describe("subtractCalendarDays", () => {
  test("pulls the date back by whole CALENDAR days — weekends are not modelled", () => {
    // 2026-12-07 is a Monday; minus 2 lands on the Saturday, not the Friday.
    expect(subtractCalendarDays("2026-12-07", 2)).toBe("2026-12-05");
  });

  test("crosses a month boundary", () => {
    expect(subtractCalendarDays("2026-01-02", 5)).toBe("2025-12-28");
  });

  test("zero or negative days leaves the date untouched", () => {
    expect(subtractCalendarDays("2026-12-07", 0)).toBe("2026-12-07");
    expect(subtractCalendarDays("2026-12-07", -3)).toBe("2026-12-07");
  });

  test("no date -> null; a line may legitimately carry no delivery date", () => {
    expect(subtractCalendarDays(null, 5)).toBeNull();
    expect(subtractCalendarDays(undefined, 5)).toBeNull();
  });

  test("an unparseable date is returned unchanged rather than throwing", () => {
    expect(subtractCalendarDays("not-a-date", 5)).toBe("not-a-date");
  });

  test("an ISO timestamp is accepted and truncated to its date", () => {
    expect(subtractCalendarDays("2026-12-07T15:30:00Z", 1)).toBe("2026-12-06");
  });
});
