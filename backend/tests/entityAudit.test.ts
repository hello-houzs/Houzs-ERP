import { describe, expect, test } from "vitest";
import {
  ENTITY_TYPES,
  isEntityType,
  fieldChange,
  compactChanges,
  statusChange,
  diffFields,
} from "../src/scm/lib/entity-audit";
import { stripAuditFinance, AUDIT_FINANCE_FIELDS } from "../src/scm/lib/finance-keys";

/* WHAT IS AND IS NOT TESTED HERE.
   recordEntityAudit itself is NOT unit-tested: it is a thin insert against
   Postgres via the scm supabase client, and the scm tree does not ride the D1
   harness the rest of this suite uses (vitest.config.ts pins DATABASE_URL="" and
   applies src/db/migrations to an isolated D1; scm lives in Postgres under the
   `scm` schema, reached through Hyperdrive). There is no route-level harness for
   /api/scm/* and faking one would test the fake. What IS testable is every pure
   decision the writer delegates — which changes get recorded, in what shape, and
   whether a value counts as changed at all — so that is what this covers. */

describe("entity type vocabulary", () => {
  test("accepts every declared type", () => {
    for (const t of ENTITY_TYPES) expect(isEntityType(t)).toBe(true);
  });

  test("covers the document modules, not only money and stock", () => {
    // The read endpoint rejects any type not in this list, so a module wired up
    // in a route file but missing here writes rows nobody can ever read back.
    for (const t of ["SALES_INVOICE", "PURCHASE_ORDER", "PURCHASE_INVOICE", "DELIVERY_ORDER"]) {
      expect(isEntityType(t)).toBe(true);
    }
  });

  test("rejects anything else, including near-misses", () => {
    // The read endpoint 400s on an unknown type rather than answering with an
    // empty list, so this predicate is the difference between "no history" and
    // "wrong module name".
    for (const t of ["", "GRNS", "grn", "SALES_ORDER", "PAYMENT_VOUCHERS", null, undefined, 7]) {
      expect(isEntityType(t)).toBe(false);
    }
  });
});

describe("fieldChange", () => {
  test("records a real move as an explicit from -> to pair", () => {
    expect(fieldChange("payeeName", "Acme", "Acme Sdn Bhd")).toEqual({
      field: "payeeName", from: "Acme", to: "Acme Sdn Bhd",
    });
  });

  test("returns null when nothing moved", () => {
    expect(fieldChange("status", "POSTED", "POSTED")).toBeNull();
  });

  test("treats null and empty string as the same absence", () => {
    // Mirrors diffFields' loose equality so a hand-built change and a diffed one
    // do not disagree about whether a blanked field changed.
    expect(fieldChange("notes", null, "")).toBeNull();
    expect(fieldChange("notes", "", null)).toBeNull();
    expect(fieldChange("notes", undefined, null)).toBeNull();
  });

  test("does not confuse a numeric zero with an absent value", () => {
    // A stock count going 5 -> 0 is a real, important movement. If zero were
    // folded in with null this would silently record nothing.
    expect(fieldChange("countedQty", 5, 0)).toEqual({ field: "countedQty", from: 5, to: 0 });
    expect(fieldChange("countedQty", null, 0)).toEqual({ field: "countedQty", from: null, to: 0 });
  });

  test("normalises absent sides to null rather than leaving undefined", () => {
    // field_changes is jsonb; an `undefined` value is dropped entirely by
    // JSON.stringify, which would store { field } and lose the half of the pair
    // that says the value was previously unset.
    const c = fieldChange("supplierId", undefined, "abc");
    expect(c).toEqual({ field: "supplierId", from: null, to: "abc" });
    expect(JSON.parse(JSON.stringify(c))).toHaveProperty("from", null);
  });

  test("keeps money as the integer sen it was given", () => {
    // Money in this codebase is INTEGER SEN. Recording a formatted string would
    // make the history unsummable and locale-dependent.
    const c = fieldChange("totalCenti", 123450, 99900);
    expect(c).toEqual({ field: "totalCenti", from: 123450, to: 99900 });
    expect(typeof c?.from).toBe("number");
    expect(typeof c?.to).toBe("number");
  });

  test("a numeric string and its number are not a change", () => {
    // Postgres numerics can arrive as strings through PostgREST; a round-trip
    // must not manufacture a phantom edit in the history.
    expect(fieldChange("exchangeRate", "1", 1)).toBeNull();
    expect(fieldChange("totalCenti", "500", 500)).toBeNull();
  });
});

describe("compactChanges", () => {
  test("drops the no-ops and keeps order", () => {
    expect(compactChanges([
      fieldChange("a", 1, 2),
      fieldChange("b", "x", "x"),
      fieldChange("c", null, "y"),
    ])).toEqual([
      { field: "a", from: 1, to: 2 },
      { field: "c", from: null, to: "y" },
    ]);
  });

  test("an all-no-op list compacts to empty", () => {
    // Callers branch on length to decide whether to write a row at all — the
    // stock-take line PATCH fires on every blur and must not log a non-edit.
    expect(compactChanges([fieldChange("a", 1, 1), null])).toEqual([]);
  });
});

describe("statusChange", () => {
  test("records the transition", () => {
    expect(statusChange("OPEN", "POSTED")).toEqual([{ field: "status", from: "OPEN", to: "POSTED" }]);
  });

  test("uses one spelling of the field name everywhere", () => {
    // A renderer keying on 'status' must not also have to know 'Status'.
    expect(statusChange("DRAFT", "CANCELLED")[0].field).toBe("status");
  });

  test("an unknown prior status still records the arrival", () => {
    expect(statusChange(null, "CANCELLED")).toEqual([{ field: "status", from: null, to: "CANCELLED" }]);
  });

  test("a non-transition records nothing", () => {
    expect(statusChange("CANCELLED", "CANCELLED")).toEqual([]);
  });
});

describe("diffFields is the SHARED differ, re-exported not reimplemented", () => {
  // The whole point of importing so-audit's differ is that both audit tables
  // answer "did this change" identically. If this file ever grows its own copy,
  // these expectations are what should fail.
  const ALIASES: Array<[string, string]> = [
    ["payeeName", "payee_name"],
    ["totalCenti", "total_centi"],
    ["notes", "notes"],
  ];

  test("diffs camel patch against snake row", () => {
    expect(diffFields(
      { payee_name: "Acme", total_centi: 1000, notes: null },
      { payeeName: "Beta", totalCenti: 2000 },
      ALIASES,
    )).toEqual([
      { field: "payeeName", from: "Acme", to: "Beta" },
      { field: "totalCenti", from: 1000, to: 2000 },
    ]);
  });

  test("a field absent from the patch is not a change to null", () => {
    // PATCH is partial: an omitted key means "leave it alone", and recording it
    // as a clear would make every partial edit look destructive.
    expect(diffFields({ payee_name: "Acme", total_centi: 1000 }, { payeeName: "Acme" }, ALIASES))
      .toEqual([]);
  });

  test("agrees with fieldChange on the null/empty-string question", () => {
    expect(diffFields({ notes: null }, { notes: "" }, ALIASES)).toEqual([]);
    expect(fieldChange("notes", null, "")).toBeNull();
  });
});

describe("a document line's cost is gated on read by the field NAME it was written with", () => {
  /* The delivery-order line handlers record their diff with the API's camelCase
     names, and AUDIT_FINANCE_FIELDS is keyed on exactly those. That coupling is
     invisible at the call site — a line recorded as `unit_cost_centi` or
     `unitCost` would sail straight past the strip and hand every non-finance
     reader the cost basis, which is the #600/#625/#632 shape one endpoint over.
     These tests are the guard on the spelling. */

  const DO_LINE_FIELD_NAMES = [
    "qty", "unitPriceCenti", "discountCenti", "unitCostCenti",
    "lineTotalCenti", "itemCode", "itemGroup", "description",
    "uom", "notes", "rackId", "lineDeliveryDate",
  ];

  test("the cost field a line diff emits is one the strip knows", () => {
    expect(AUDIT_FINANCE_FIELDS.has("unitCostCenti")).toBe(true);
    expect(DO_LINE_FIELD_NAMES).toContain("unitCostCenti");
  });

  test("stripping a line-edit entry removes the cost and keeps the rest", () => {
    const line = diffFields(
      { qty: 2, unit_price_centi: 50000, unit_cost_centi: 30000, item_code: "BF-001" },
      { qty: 3, unitPriceCenti: 55000, unitCostCenti: 31000 },
      [
        ["qty", "qty"],
        ["unitPriceCenti", "unit_price_centi"],
        ["unitCostCenti", "unit_cost_centi"],
        ["itemCode", "item_code"],
      ],
    );
    const entries = [{ field_changes: line }];
    stripAuditFinance(entries);
    const fields = (entries[0].field_changes as Array<{ field: string }>).map((f) => f.field);
    expect(fields).toEqual(["qty", "unitPriceCenti"]);
  });

  test("the price a customer is charged is NOT stripped", () => {
    // The line #625 drew: what the order is worth is visible to everyone who
    // passes the access gate; what it COST is not.
    for (const f of ["qty", "unitPriceCenti", "discountCenti", "lineTotalCenti"]) {
      expect(AUDIT_FINANCE_FIELDS.has(f)).toBe(false);
    }
  });
});
