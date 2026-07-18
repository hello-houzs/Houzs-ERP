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
import {
  GRN_LINE_AUDIT_FIELDS, GRN_LINE_AUDIT_SELECT,
  SI_LINE_AUDIT_FIELDS, SI_LINE_AUDIT_SELECT,
  PO_LINE_AUDIT_FIELDS, PO_LINE_AUDIT_SELECT,
  PI_LINE_AUDIT_FIELDS, PI_LINE_AUDIT_SELECT,
  auditSelectGaps,
  type AuditFieldMap,
} from "../src/scm/lib/entity-audit-fields";

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

/* ────────────────────────────────────────────────────────────────────────────
   The four LINE vocabularies (lib/entity-audit-fields), now that GRN, SI, PO and
   PI all record line-level CRUD. These are the same coupling the DO tests above
   guard, generalised: the camelCase half of every tuple is what the strip is
   keyed on, and it is invisible at the call site.
   ──────────────────────────────────────────────────────────────────────────── */

const LINE_VOCABULARIES: Array<[label: string, fields: AuditFieldMap, select: string]> = [
  ["GRN", GRN_LINE_AUDIT_FIELDS, GRN_LINE_AUDIT_SELECT],
  ["SALES_INVOICE", SI_LINE_AUDIT_FIELDS, SI_LINE_AUDIT_SELECT],
  ["PURCHASE_ORDER", PO_LINE_AUDIT_FIELDS, PO_LINE_AUDIT_SELECT],
  ["PURCHASE_INVOICE", PI_LINE_AUDIT_FIELDS, PI_LINE_AUDIT_SELECT],
];

describe("every line vocabulary is readable and diffable", () => {
  test.each(LINE_VOCABULARIES)("%s: the select covers every audited column", (_l, fields, select) => {
    /* A column in the field list but missing from the select reads back as
       undefined, so diffFields treats it as "absent from the patch" and records
       NOTHING — a field that looks covered and silently is not. auditSelectGaps
       names the column rather than returning a bare false. */
    expect(auditSelectGaps(fields, select)).toEqual([]);
  });

  test.each(LINE_VOCABULARIES)("%s: no camel key is spelled snake_case", (_l, fields) => {
    // A snake_case key sails past stripAuditFinance, which matches literally.
    for (const [camel] of fields) expect(camel).not.toContain("_");
  });

  test.each(LINE_VOCABULARIES)("%s: no duplicate keys on either side", (_l, fields) => {
    // A repeated camel key makes the history ambiguous; a repeated column makes
    // the select invalid to PostgREST.
    expect(new Set(fields.map(([camel]) => camel)).size).toBe(fields.length);
    expect(new Set(fields.map(([, snake]) => snake)).size).toBe(fields.length);
  });

  test.each(LINE_VOCABULARIES)("%s: the cost column is recorded under the GATED name", (_l, fields) => {
    /* Every one of these four documents carries unit_cost_centi and every line
       handler diffs it. If it is emitted under any other spelling the strip
       misses it and the cost basis reaches every reader who can see the
       document — the #600/#625/#632 shape, one endpoint over. */
    const costEntry = fields.find(([, snake]) => snake === "unit_cost_centi");
    expect(costEntry).toBeDefined();
    expect(AUDIT_FINANCE_FIELDS.has(costEntry![0])).toBe(true);
  });

  test.each(LINE_VOCABULARIES)("%s: what the document is WORTH stays visible", (_l, fields) => {
    // line_total_centi is the counterpart to the rule above: it is what the
    // paper says, not what it cost, and #625 ruled it visible.
    const totalEntry = fields.find(([, snake]) => snake === "line_total_centi");
    expect(totalEntry).toBeDefined();
    expect(AUDIT_FINANCE_FIELDS.has(totalEntry![0])).toBe(false);
  });
});

describe("the SI line vocabulary carries BOTH derived money columns", () => {
  test("line cost and line margin are gated, line total is not", () => {
    /* The SI is the only one of the four that stores a per-line margin, and it
       stores the cost basis it was derived from. Both are cost data; recording
       either under an ungated name hands a reader the margin on every edit. */
    const byColumn = new Map(SI_LINE_AUDIT_FIELDS.map(([camel, snake]) => [snake, camel]));
    expect(AUDIT_FINANCE_FIELDS.has(byColumn.get("line_cost_centi")!)).toBe(true);
    expect(AUDIT_FINANCE_FIELDS.has(byColumn.get("line_margin_centi")!)).toBe(true);
    expect(AUDIT_FINANCE_FIELDS.has(byColumn.get("line_total_centi")!)).toBe(false);
  });

  test("stripping an SI line edit leaves the charged amounts and removes the basis", () => {
    const line = diffFields(
      {
        qty: 2, unit_price_centi: 50000, unit_cost_centi: 30000,
        line_total_centi: 100000, line_cost_centi: 60000, line_margin_centi: 40000,
      },
      {
        qty: 3, unitPriceCenti: 55000, unitCostCenti: 31000,
        lineTotalCenti: 165000, lineCostCenti: 93000, lineMarginCenti: 72000,
      },
      SI_LINE_AUDIT_FIELDS,
    );
    const entries = [{ field_changes: line }];
    stripAuditFinance(entries);
    const fields = (entries[0].field_changes as Array<{ field: string }>).map((f) => f.field);
    expect(fields).toEqual(["qty", "unitPriceCenti", "lineTotalCenti"]);
  });
});

describe("a line delete records the vanished values as from -> null", () => {
  /* The delete handlers build their change list by hand rather than diffing,
     because after the row is gone there is nothing to diff against. This is the
     shape they build, asserted here because the handlers themselves cannot be
     route-tested (Postgres via Hyperdrive vs a D1 harness). */
  test("every audited column becomes a from-value with a null to-value", () => {
    const doomed: Record<string, unknown> = {
      qty: 4, unit_price_centi: 25000, unit_cost_centi: 12000,
      line_total_centi: 100000, item_code: "BF-009", uom: "UNIT",
    };
    const changes = compactChanges(
      SI_LINE_AUDIT_FIELDS.map(([camel, snake]) => fieldChange(camel, doomed[snake] ?? null, null)),
    );
    // Only the columns that HAD a value produce a pair — a null-to-null column
    // is not a change and must not pad the history.
    expect(changes.map((ch) => ch.field)).toEqual([
      "qty", "unitPriceCenti", "unitCostCenti", "lineTotalCenti", "itemCode", "uom",
    ]);
    for (const ch of changes) expect(ch.to).toBeNull();
    expect(changes.find((ch) => ch.field === "qty")?.from).toBe(4);
  });

  test("a zero-money line still records its columns", () => {
    // A free-gift line is worth 0 and deleting it is still a real change; if
    // zero were folded in with null the deletion would record nothing at all.
    const changes = compactChanges(
      SI_LINE_AUDIT_FIELDS.map(([camel, snake]) =>
        fieldChange(camel, ({ qty: 1, line_total_centi: 0 } as Record<string, unknown>)[snake] ?? null, null)),
    );
    expect(changes.map((ch) => ch.field)).toEqual(["qty", "lineTotalCenti"]);
  });
});

describe("a CREATE records the document as null -> value", () => {
  /* Every recordXCreate helper builds its pairs this way off the PERSISTED row.
     Reading the row back (rather than echoing the request body) is what makes a
     compensated create leave no row: a header a rollback already deleted reads
     back as nothing and the helper returns before writing. What is asserted here
     is the shape it writes when the row DOES survive. */
  test("money is the integer sen off the column, not a formatted amount", () => {
    const row = { status: "POSTED", total_centi: 123450, currency: "MYR" };
    const changes = compactChanges([
      fieldChange("status", null, row.status),
      fieldChange("currency", null, row.currency),
      fieldChange("totalCenti", null, row.total_centi),
    ]);
    expect(changes).toEqual([
      { field: "status", from: null, to: "POSTED" },
      { field: "currency", from: null, to: "MYR" },
      { field: "totalCenti", from: null, to: 123450 },
    ]);
    expect(typeof changes[2].to).toBe("number");
  });

  test("a column the document did not carry is not recorded as an empty edit", () => {
    // A manual GRN has no source PO; recording purchaseOrderId: null -> null
    // would pad every history with fields nobody set.
    expect(fieldChange("purchaseOrderId", null, null)).toBeNull();
  });

  test("a DRAFT create is distinguishable from a posted one", () => {
    // Both are recorded — "a draft existed first" is part of the story — and the
    // status pair is what tells them apart.
    expect(fieldChange("status", null, "DRAFT")).toEqual({ field: "status", from: null, to: "DRAFT" });
    expect(fieldChange("status", null, "POSTED")).toEqual({ field: "status", from: null, to: "POSTED" });
  });
});

describe("auditSelectGaps", () => {
  test("names the missing column rather than answering false", () => {
    expect(auditSelectGaps([["qty", "qty"], ["unitCostCenti", "unit_cost_centi"]], "qty, item_code"))
      .toEqual(["unit_cost_centi"]);
  });

  test("tolerates the spacing PostgREST tolerates", () => {
    expect(auditSelectGaps([["qty", "qty"], ["itemCode", "item_code"]], "qty,item_code")).toEqual([]);
    expect(auditSelectGaps([["qty", "qty"]], "  qty  ,  notes ")).toEqual([]);
  });

  test("a prefix match is not a match", () => {
    // 'qty' must not be considered covered by 'qty_accepted'.
    expect(auditSelectGaps([["qty", "qty"]], "qty_accepted, qty_received")).toEqual(["qty"]);
  });
});
