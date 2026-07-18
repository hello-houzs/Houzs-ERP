import { describe, expect, test } from "vitest";
import { applyOperationJdOverride } from "../src/services/operationJdAccess";
import {
  isDormantPageKey,
  levelRank,
  meetsLevel,
  resolvePositionAccessFromRows,
  type AccessLevel,
} from "../src/services/pageAccess";
import { POSITION_ACCESS_SNAPSHOT } from "../src/services/positionAccessSnapshot";

/* The Operation JD is a RULE, not a setting (owner 2026-07-18: ops staff —
   purchasing, ops managers/executives, logistic admin, storekeepers — must be
   able to do STOCK TRANSFER, STOCK COUNT and STOCK ADJUSTMENT; today only `*`
   can). These lock the rule itself: the grant is on the four keys the backend
   area-guard actually enforces, it lands on the SIX named positions and NOT on
   Driver/Helper, and it can only RAISE a level, never lower one.

   Stock ADJUSTMENT was split off Inventory (owner 2026-07-18): the write moved to
   its own scm.warehouse.adjustments guard, so the cohort now carries `edit` on
   adjustments AS WELL AS inventory — dropping it would take away the adjust
   capability the cohort had via the fused inventory grant. */

const WAREHOUSE_KEYS = [
  "scm.warehouse.inventory", // Inventory page (stock listing / stock card)
  "scm.warehouse.adjustments", // stock ADJUSTMENT (POST /inventory/adjustments)
  "scm.warehouse.transfers", // stock TRANSFER
  "scm.warehouse.stock_take", // stock COUNT / take
] as const;

const SIX_POSITIONS = [
  "Procurement/Purchasing",
  "Operation Manager",
  "Operation Executive",
  "Logistic Admin",
  "Storekeeper",
  "Storekeeper Supervisor",
] as const;

/** Resolve a snapshot position's live page-access map through the REAL cascade
 *  (explicit[key] ?? parent), exactly as auth.ts hydrates it, then read one
 *  position by name. This is how we measure "before" state — no hand-parsing. */
function resolveByName(name: string): {
  before: Record<string, AccessLevel>;
  entry: (typeof POSITION_ACCESS_SNAPSHOT)[number];
} {
  const entry = POSITION_ACCESS_SNAPSHOT.find((p) => p.name === name);
  if (!entry) throw new Error(`snapshot has no position named ${name}`);
  const rows = Object.entries(entry.entries).map(([page_key, level]) => ({
    page_key,
    level: level as string,
  }));
  return { before: resolvePositionAccessFromRows(rows), entry };
}

function caller(entry: (typeof POSITION_ACCESS_SNAPSHOT)[number]) {
  return {
    permissions: new Set<string>(),
    position_name: entry.name,
    department_name: entry.department_name,
  };
}

describe("Operation JD override — grants warehouse writes to the six-position cohort", () => {
  test("each of the six cohort positions gets `edit` on all four warehouse keys", () => {
    for (const name of SIX_POSITIONS) {
      const { before, entry } = resolveByName(name);
      const after = applyOperationJdOverride(before, caller(entry));
      for (const key of WAREHOUSE_KEYS) {
        // After the override every key is at LEAST edit (Operation Manager comes
        // in at `full` via its `scm = full` row — additivity keeps it there).
        expect(["edit", "full"]).toContain(after[key]);
      }
    }
  });

  test("BEFORE the override, the cohort does NOT already have edit on all four keys", () => {
    // The gap the owner reported: measured with the real resolver, not eyeballed.
    // Operation Manager is the ONE exception (scm = full already), so it is
    // excluded from this negative assertion — the other five prove the gap.
    const gapped = SIX_POSITIONS.filter((n) => n !== "Operation Manager");
    for (const name of gapped) {
      const { before } = resolveByName(name);
      const allEdit = WAREHOUSE_KEYS.every(
        (k) => before[k] === "edit" || before[k] === "full",
      );
      expect(allEdit).toBe(false);
    }
  });

  test("Operation Manager already has full (scm = full) and is NOT downgraded", () => {
    const { before, entry } = resolveByName("Operation Manager");
    for (const key of WAREHOUSE_KEYS) expect(before[key]).toBe("full");
    const after = applyOperationJdOverride(before, caller(entry));
    for (const key of WAREHOUSE_KEYS) expect(after[key]).toBe("full");
  });

  test("Storekeeper + Storekeeper Supervisor move from view to edit", () => {
    for (const name of ["Storekeeper", "Storekeeper Supervisor"]) {
      const { before, entry } = resolveByName(name);
      // Their `scm.warehouse = view` row makes these keys resolve to view.
      for (const key of WAREHOUSE_KEYS) expect(before[key]).toBe("view");
      const after = applyOperationJdOverride(before, caller(entry));
      for (const key of WAREHOUSE_KEYS) expect(after[key]).toBe("edit");
    }
  });
});

describe("Operation JD override — Driver/Helper/Sales/Finance get NOTHING added", () => {
  test("Driver and Helper are unchanged — delivery labour, no stock-write", () => {
    for (const name of ["Driver", "Helper"]) {
      const { before, entry } = resolveByName(name);
      const after = applyOperationJdOverride(before, caller(entry));
      for (const key of WAREHOUSE_KEYS) expect(after[key]).toBe(before[key]);
      // Concretely: they never reach edit on any warehouse write key.
      for (const key of WAREHOUSE_KEYS)
        expect(["none", "view", "partial"]).toContain(after[key]);
    }
  });

  test("Sales Director and Sales Person are unchanged", () => {
    for (const name of ["Sales Director", "Sales Person"]) {
      const { before, entry } = resolveByName(name);
      const after = applyOperationJdOverride(before, caller(entry));
      for (const key of WAREHOUSE_KEYS) expect(after[key]).toBe(before[key]);
    }
  });

  test("Finance Manager is unchanged (keeps its matrix `view`, not raised)", () => {
    const { before, entry } = resolveByName("Finance Manager");
    const after = applyOperationJdOverride(before, caller(entry));
    for (const key of WAREHOUSE_KEYS) {
      expect(before[key]).toBe("view");
      expect(after[key]).toBe("view");
    }
  });
});

describe("Operation JD override — invariants", () => {
  const MATRIX: Record<string, AccessLevel> = {
    "scm.warehouse.inventory": "none",
    "scm.warehouse.transfers": "view",
    "scm.warehouse.stock_take": "none",
    "scm.warehouse.adjustments": "view",
    "scm.procurement.po": "view",
    projects: "view",
  };

  const purchasing = {
    permissions: new Set<string>(["scm.access"]),
    position_name: "Procurement/Purchasing",
    department_name: "Operation Department",
  };

  test("the `*` wildcard is UNTOUCHED — narrowing it would lock the owner out", () => {
    const full: Record<string, AccessLevel> = {
      "scm.warehouse.inventory": "full",
      "scm.warehouse.transfers": "full",
      "scm.warehouse.stock_take": "full",
    };
    const out = applyOperationJdOverride(full, {
      permissions: new Set<string>(["*"]),
      position_name: "Super Admin",
      department_name: "Management",
    });
    expect(out).toBe(full);
  });

  test("additive — a key already at `full` is kept, never downgraded to edit", () => {
    const out = applyOperationJdOverride(
      { ...MATRIX, "scm.warehouse.transfers": "full" },
      purchasing,
    );
    expect(out["scm.warehouse.transfers"]).toBe("full");
    expect(out["scm.warehouse.inventory"]).toBe("edit");
    expect(out["scm.warehouse.stock_take"]).toBe("edit");
  });

  test("keys OUTSIDE the four are untouched; adjustments IS in the grant and is raised", () => {
    const out = applyOperationJdOverride(MATRIX, purchasing);
    // scm.warehouse.adjustments is now a granted key (the split): it rides up to
    // edit alongside inventory. Truly-outside keys stay put.
    expect(out["scm.warehouse.adjustments"]).toBe("edit");
    expect(out["scm.procurement.po"]).toBe("view");
    expect(out["projects"]).toBe("view");
  });

  test("scm.warehouse.adjustments is LIVE (not dormant) and the cohort is granted edit on it", () => {
    // The split, pinned from the backend side. POST /inventory/adjustments is now
    // gated by scmAreaGuard('scm.warehouse.adjustments') via its own sub-mount
    // (scm/index.ts), so the key is a live, guarded area — no longer dormant — and
    // one of the four the cohort is granted.
    expect(isDormantPageKey("scm.warehouse.adjustments")).toBe(false);
    expect(isDormantPageKey("scm.warehouse.inventory")).toBe(false);
    const out = applyOperationJdOverride(MATRIX, purchasing);
    // Concretely: the grant lands on BOTH the adjustment key and the inventory key.
    expect(out["scm.warehouse.inventory"]).toBe("edit");
    expect(out["scm.warehouse.adjustments"]).toBe("edit");
  });

  test("a caller with no position is not in the cohort — nothing added", () => {
    const out = applyOperationJdOverride(MATRIX, {
      permissions: new Set<string>(),
      position_name: null,
      department_name: "Operation Department",
    });
    expect(out).toBe(MATRIX);
  });

  test("cohort match tolerates casing / whitespace drift but not word-substring", () => {
    // Drift-tolerant: normalised match still lands.
    const drift = applyOperationJdOverride(MATRIX, {
      permissions: new Set<string>(),
      position_name: "  operation   manager ",
      department_name: "Operation Department",
    });
    expect(drift["scm.warehouse.inventory"]).toBe("edit");
    // Injection-proof: a made-up position that merely CONTAINS a cohort word is
    // NOT granted (the hazard DIRECTOR_POSITIONS' `\b` regex carries).
    const injected = applyOperationJdOverride(MATRIX, {
      permissions: new Set<string>(),
      position_name: "Operation Intern",
      department_name: "Operation Department",
    });
    expect(injected["scm.warehouse.inventory"]).toBe("none");
  });
});

describe("blast radius — the split changes neither WHO can adjust nor inventory-view", () => {
  /* "Can adjust" was gated on scm.warehouse.inventory>=edit BEFORE the split and is
     gated on scm.warehouse.adjustments>=edit AFTER. The split added `adjustments`
     to the SAME cohort + GRANT as inventory and left inventory's grant/matrix
     untouched, so for EVERY position in the prod snapshot the two must agree — the
     adjust-capable set is identical. Proven with the real resolver + override over
     the whole snapshot, not eyeballed. `*` (Super Admin) is not in the snapshot's
     entries as a wildcard here — it bypasses the guard entirely at runtime and is
     unaffected either way. */
  const COHORT = new Set<string>([
    "Procurement/Purchasing",
    "Operation Manager",
    "Operation Executive",
    "Logistic Admin",
    "Storekeeper",
    "Storekeeper Supervisor",
  ]);

  function afterFor(entry: (typeof POSITION_ACCESS_SNAPSHOT)[number]) {
    const rows = Object.entries(entry.entries).map(([page_key, level]) => ({
      page_key,
      level: level as string,
    }));
    const before = resolvePositionAccessFromRows(rows);
    return { before, after: applyOperationJdOverride(before, caller(entry)) };
  }

  test("adjust-after (adjustments>=edit) == adjust-before (inventory>=edit) for every snapshot position", () => {
    for (const entry of POSITION_ACCESS_SNAPSHOT) {
      const { after } = afterFor(entry);
      const adjustAfter = meetsLevel((after["scm.warehouse.adjustments"] ?? "none") as AccessLevel, "edit");
      const adjustBefore = meetsLevel((after["scm.warehouse.inventory"] ?? "none") as AccessLevel, "edit");
      expect(adjustAfter, `${entry.name}: the split changed adjust capability`).toBe(adjustBefore);
    }
  });

  test("inventory-VIEW is never lowered, and every NON-cohort position keeps its exact inventory level", () => {
    for (const entry of POSITION_ACCESS_SNAPSHOT) {
      const { before, after } = afterFor(entry);
      const b = (before["scm.warehouse.inventory"] ?? "none") as AccessLevel;
      const a = (after["scm.warehouse.inventory"] ?? "none") as AccessLevel;
      expect(levelRank(a), `${entry.name}: inventory lowered`).toBeGreaterThanOrEqual(levelRank(b));
      if (!COHORT.has(entry.name)) {
        expect(a, `${entry.name}: non-cohort inventory changed`).toBe(b);
      }
    }
  });

  test("Finance Manager — the only explicit adjustments holder — may VIEW but not WRITE (matches inventory-era)", () => {
    const { after } = afterFor(POSITION_ACCESS_SNAPSHOT.find((p) => p.name === "Finance Manager")!);
    // Under the fused gate, FM's inventory=view could open the page but not POST an
    // adjustment (write needs edit). Under the split, adjustments=view is identical:
    // page opens, write 403s.
    expect(after["scm.warehouse.adjustments"]).toBe("view");
    expect(after["scm.warehouse.inventory"]).toBe("view");
    expect(meetsLevel(after["scm.warehouse.adjustments"] as AccessLevel, "edit")).toBe(false);
  });
});
