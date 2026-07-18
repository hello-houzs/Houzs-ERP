import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { resolvePositionPolicy } from "../src/services/positionPolicy";
import { scmAreaGuard } from "../src/scm/middleware/area-guard";
import { PAGES, fullAccessMap, meetsLevel, type AccessLevel } from "../src/services/pageAccess";
import { POSITION_ACCESS_SNAPSHOT } from "../src/services/positionAccessSnapshot";

/* THE ONE RULE — positionPolicy is now the position page-access SOURCE (owner
   2026-07-18). These pin the two things the owner reviews before merge:
     1. the RESOLVED-ACCESS TABLE — every one of the 17 real positions resolves to
        FULL (unrestricted), its manual whitelist (restricted), or "unchanged this
        PR" (sales) — computed with the REAL resolver, not by hand; and
     2. the NO-LOCKOUT invariant — nothing resolves to an empty map by accident, an
        unclassified position fails OPEN to full, and a restricted position's `none`
        denials are genuinely ENFORCED at the door (a Storekeeper VIEWS inventory
        but every stock write 403s), while a full position (Purchasing) can. */

// The ground-truth classification the owner directed, keyed by the snapshot name.
const EXPECTED_COHORT: Record<string, "full" | "restricted" | "sales"> = {
  "Super Admin": "full",
  "HR Manager": "full",
  "Finance Manager": "full",
  "Sales Director": "sales",
  "Sales Manager": "sales",
  "Sales Executive": "sales",
  "Sales Person": "sales",
  "Operation Manager": "full",
  "Operation Executive": "full",
  "Procurement/Purchasing": "full",
  "Logistic Admin": "full",
  "Storekeeper": "restricted",
  "Driver": "restricted",
  "Helper": "restricted",
  "Service Admin": "full",
  "Storekeeper Supervisor": "restricted",
  "Calendar Viewer": "full",
};

// The manual whitelists — the FULL set of non-none resolved keys (including the
// keys inherited from an L1 parent). EVERYTHING ELSE must resolve none. The L1
// area keys (scm.transportation / scm.warehouse) are granted so the SCM nav
// umbrella + group resolve visible; the denied warehouse children carry an
// explicit none that overrides the inherited view.
const EXPECTED_WHITELIST: Record<string, Record<string, AccessLevel>> = {
  Driver: {
    "scm.transportation": "view",
    "scm.transportation.drivers": "view", // inherits the L1 parent
  },
  Helper: {
    "scm.transportation": "view",
    "scm.transportation.drivers": "view",
  },
  Storekeeper: {
    "scm.transportation": "view",
    "scm.transportation.drivers": "view",
    "scm.warehouse": "view",
    "scm.warehouse.inventory": "view",
    // transfers / stock_take / adjustments explicitly none — asserted by the
    // "all else none" sweep below.
  },
  "Storekeeper Supervisor": {
    "scm.transportation": "view",
    "scm.transportation.drivers": "view",
    "scm.warehouse": "view",
    "scm.warehouse.inventory": "view",
    "scm.procurement.grn": "edit",
  },
};

/** The money-moving WRITE areas carved out of default-full (owner 2026-07-18:
 *  "see everything" is not "do everything"). */
const MONEY_KEYS = ["scm.finance.accounting", "scm.finance.outstanding"] as const;
/** The only positions that may still move money (besides `*`). */
const MONEY_POSITIONS = ["Finance Manager", "Super Admin"] as const;

function inputFor(entry: (typeof POSITION_ACCESS_SNAPSHOT)[number]) {
  return { position_name: entry.name, department_name: entry.department_name };
}

describe("positionPolicy — the resolved-access table over all 17 real positions", () => {
  test("the snapshot still carries exactly the 17 positions this table classifies", () => {
    expect(POSITION_ACCESS_SNAPSHOT).toHaveLength(17);
    const names = POSITION_ACCESS_SNAPSHOT.map((p) => p.name).sort();
    expect(names).toEqual(Object.keys(EXPECTED_COHORT).sort());
  });

  test.each(POSITION_ACCESS_SNAPSHOT.map((e) => [e.name, e] as const))(
    "%s resolves to its directed cohort",
    (name, entry) => {
      const policy = resolvePositionPolicy(inputFor(entry));
      expect(policy.cohort).toBe(EXPECTED_COHORT[name]);
    },
  );

  test("every FULL position resolves to fullAccessMap() on every NON-money key", () => {
    const full = fullAccessMap();
    for (const entry of POSITION_ACCESS_SNAPSHOT) {
      if (EXPECTED_COHORT[entry.name] !== "full") continue;
      const policy = resolvePositionPolicy(inputFor(entry));
      const map = policy.pageAccess as Record<string, AccessLevel>;
      for (const p of PAGES) {
        if (MONEY_KEYS.includes(p.key)) continue; // asserted by the carve-out block
        expect(map[p.key], `${entry.name}:${p.key}`).toBe(full[p.key]);
      }
      // Same signal `*` gets — a full map needs no per-area enforcement.
      expect(policy.scmConfigured, `${entry.name}`).toBe(false);
    }
  });

  test("a money-authorised FULL position (Finance Manager, Super Admin) is EXACTLY fullAccessMap()", () => {
    const full = fullAccessMap();
    for (const name of MONEY_POSITIONS) {
      const entry = POSITION_ACCESS_SNAPSHOT.find((e) => e.name === name)!;
      const policy = resolvePositionPolicy(inputFor(entry));
      expect(policy.pageAccess, name).toEqual(full);
      expect(policy.flags.canMoveMoney, name).toBe(true);
    }
  });

  test("every RESTRICTED position resolves to EXACTLY its manual whitelist (all else none)", () => {
    for (const entry of POSITION_ACCESS_SNAPSHOT) {
      if (EXPECTED_COHORT[entry.name] !== "restricted") continue;
      const policy = resolvePositionPolicy(inputFor(entry));
      const map = policy.pageAccess as Record<string, AccessLevel>;
      const grants = EXPECTED_WHITELIST[entry.name];
      // Every granted key at exactly its level…
      for (const [key, level] of Object.entries(grants)) {
        expect(map[key], `${entry.name}:${key}`).toBe(level);
      }
      // …and EVERY OTHER catalogue key resolves none. This is what "EVERYTHING
      // ELSE: none" means, proven over the whole PAGES registry.
      for (const p of PAGES) {
        if (p.key in grants) continue;
        expect(map[p.key], `${entry.name}:${p.key} should be none`).toBe("none");
      }
      // A restricted whitelist configures scm* areas, so it is honestly
      // L2-configured — the area-guard will ENFORCE its `none` denials.
      expect(policy.scmConfigured, `${entry.name}`).toBe(true);
    }
  });

  test("every SALES position is deferred — a KNOWN cohort, NOT flipped to full", () => {
    for (const entry of POSITION_ACCESS_SNAPSHOT) {
      if (EXPECTED_COHORT[entry.name] !== "sales") continue;
      const policy = resolvePositionPolicy(inputFor(entry));
      expect(policy.cohort).toBe("sales");
      expect(policy.resolutionDeferred).toBe(true);
      // The safety line: sales must NOT accidentally become full-access — its
      // resolution is left to the existing path this PR, not this map.
      expect(policy.pageAccess).toBeNull();
    }
  });

  test("the convergence FLAGS are present on every cohort (sales folds in next PR without a new shape)", () => {
    const sales = resolvePositionPolicy({ position_name: "Sales Executive", department_name: "Sales Department" });
    expect(sales.flags).toEqual({
      orderScope: "own_downline",
      canSeeMargin: false,
      canSeeCommission: false,
      announcementScope: "dept",
      canMoveMoney: false,
    });
    const full = resolvePositionPolicy({ position_name: "HR Manager", department_name: "Management" });
    expect(full.flags).toEqual({
      orderScope: "all",
      canSeeMargin: true,
      canSeeCommission: true,
      announcementScope: "all",
      canMoveMoney: false, // SEE everything, but do not move money
    });
    const restricted = resolvePositionPolicy({ position_name: "Storekeeper", department_name: "Operation Department" });
    expect(restricted.flags.canSeeMargin).toBe(false);
    expect(restricted.flags.orderScope).toBe("all");
  });
});

describe("positionPolicy — the NO-LOCKOUT invariant (fail-open)", () => {
  test("an UNCLASSIFIED position defaults to FULL, never to none", () => {
    const policy = resolvePositionPolicy({
      position_name: "Some Brand New Position Nobody Coded Yet",
      department_name: "Some New Department",
    });
    expect(policy.cohort).toBe("full");
    // Fail-open on EVERYTHING except the money-moving writes, which are view.
    expect(policy.pageAccess).toEqual({
      ...fullAccessMap(),
      "scm.finance.accounting": "view",
      "scm.finance.outstanding": "view",
    });
  });

  test("a null/empty position name falls open to FULL (not an empty map)", () => {
    const expected = {
      ...fullAccessMap(),
      "scm.finance.accounting": "view",
      "scm.finance.outstanding": "view",
    };
    const a = resolvePositionPolicy({ position_name: null, department_name: null });
    expect(a.cohort).toBe("full");
    expect(a.pageAccess).toEqual(expected);
    const b = resolvePositionPolicy({ position_name: "", department_name: "" });
    expect(b.cohort).toBe("full");
    expect(b.pageAccess).toEqual(expected);
  });

  test("NO position — real or hypothetical — resolves to an empty/near-empty map", () => {
    for (const entry of POSITION_ACCESS_SNAPSHOT) {
      const policy = resolvePositionPolicy(inputFor(entry));
      if (policy.resolutionDeferred) continue; // sales keeps its existing path
      const map = policy.pageAccess as Record<string, AccessLevel>;
      const granted = Object.values(map).filter((l) => l !== "none").length;
      expect(granted, `${entry.name} resolved to an all-none map`).toBeGreaterThan(0);
    }
  });

  test("name matching is tolerant to casing / spacing drift", () => {
    const a = resolvePositionPolicy({ position_name: "  storekeeper  SUPERVISOR ", department_name: "Operation Department" });
    expect(a.cohort).toBe("restricted");
    expect((a.pageAccess as Record<string, AccessLevel>)["scm.procurement.grn"]).toBe("edit");
  });
});

/* ── THE DOOR, not just the rule ──────────────────────────────────────────────
   Mirrors the live warehouse mounts from scm/index.ts. Proving the whitelist SAYS
   none and proving the API RETURNS 403 are different claims (this repo was burned
   once shipping the first as the second — see scmReturnsGuard.test.ts). These
   drive the REAL area-guard on the REAL paths and assert the HTTP status. */

function callerFor(positionName: string, departmentName: string) {
  const policy = resolvePositionPolicy({ position_name: positionName, department_name: departmentName });
  return {
    id: 99,
    permissions: ["scm.access"],
    permissions_set: new Set(["scm.access"]),
    position_name: positionName,
    department_name: departmentName,
    page_access: policy.pageAccess ?? {},
    scm_l2_configured: policy.scmConfigured,
  };
}

/** Warehouse mounts, in the SAME registration order as scm/index.ts — the
 *  adjustments sub-mount BEFORE the broad /inventory/* guard, so an adjustment
 *  write requires ONLY scm.warehouse.adjustments. */
function warehouseAppFor(user: unknown) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user", user as never);
    await next();
  });
  app.use("/inventory/adjustments", scmAreaGuard("scm.warehouse.adjustments"));
  const adj = new Hono();
  adj.all("/", (c) => c.json({ reached: true }));
  app.route("/inventory/adjustments", adj);
  app.use("/inventory/*", scmAreaGuard("scm.warehouse.inventory"));
  const inv = new Hono();
  inv.all("/*", (c) => c.json({ reached: true }));
  inv.all("/", (c) => c.json({ reached: true }));
  app.route("/inventory", inv);
  app.use("/stock-transfers/*", scmAreaGuard("scm.warehouse.transfers"));
  app.all("/stock-transfers/*", (c) => c.json({ reached: true }));
  app.use("/stock-takes/*", scmAreaGuard("scm.warehouse.stock_take"));
  app.all("/stock-takes/*", (c) => c.json({ reached: true }));
  return app;
}

describe("positionPolicy — Storekeeper VIEWs inventory but every stock WRITE 403s", () => {
  const app = () => warehouseAppFor(callerFor("Storekeeper", "Operation Department"));

  test("GET /inventory (racking/bin view) is allowed", async () => {
    const res = await app().request("/inventory/");
    expect(res.status).toBe(200);
  });

  test("POST /inventory/adjustments (stock adjustment) is 403", async () => {
    const res = await app().request("/inventory/adjustments", { method: "POST" });
    expect(res.status).toBe(403);
  });

  test("POST /stock-transfers (stock transfer) is 403", async () => {
    const res = await app().request("/stock-transfers/", { method: "POST" });
    expect(res.status).toBe(403);
  });

  test("POST /stock-takes (stock take) is 403", async () => {
    const res = await app().request("/stock-takes/", { method: "POST" });
    expect(res.status).toBe(403);
  });

  test("even the READ of transfers / stock-take is 403 — none means hidden, not just read-only", async () => {
    expect((await app().request("/stock-transfers/")).status).toBe(403);
    expect((await app().request("/stock-takes/")).status).toBe(403);
  });
});

describe("positionPolicy — Purchasing (full) CAN do the stock operations", () => {
  const app = () => warehouseAppFor(callerFor("Procurement/Purchasing", "Operation Department"));

  test("the policy grants Purchasing full on the warehouse write keys", () => {
    const policy = resolvePositionPolicy({ position_name: "Procurement/Purchasing", department_name: "Operation Department" });
    const map = policy.pageAccess as Record<string, AccessLevel>;
    expect(map["scm.warehouse.adjustments"]).toBe("full");
    expect(map["scm.warehouse.transfers"]).toBe("full");
    expect(map["scm.warehouse.stock_take"]).toBe("full");
  });

  test("POST adjustments / transfers / stock-takes all reach the handler (200)", async () => {
    expect((await app().request("/inventory/adjustments", { method: "POST" })).status).toBe(200);
    expect((await app().request("/stock-transfers/", { method: "POST" })).status).toBe(200);
    expect((await app().request("/stock-takes/", { method: "POST" })).status).toBe(200);
  });
});

/* ── THE MONEY-MOVING WRITE CARVE-OUT ─────────────────────────────────────────
   Owner 2026-07-18: "暂时都可以看到系统里的所有内容" is about SEEING; seeing is
   not doing. A FULL position keeps every read — including all finance data — but
   posting a journal entry or a payment voucher stays with Finance. These pin BOTH
   halves: the map (so the FE agrees) and the door (so it is not theatre — a full
   position is NOT scm_l2_configured, so the area-guard would otherwise fall open,
   and routes/accounting.ts has no permission gate of its own). */

/** Warehouse-style mount mirror for the two finance areas (scm/index.ts). */
function financeAppFor(user: unknown) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user", user as never);
    await next();
  });
  app.use("/accounting/*", scmAreaGuard("scm.finance.accounting"));
  app.all("/accounting/*", (c) => c.json({ reached: true }));
  app.use("/payment-vouchers/*", scmAreaGuard("scm.finance.accounting"));
  app.all("/payment-vouchers/*", (c) => c.json({ reached: true }));
  app.use("/outstanding/*", scmAreaGuard("scm.finance.outstanding"));
  app.all("/outstanding/*", (c) => c.json({ reached: true }));
  // A control area the money rule says nothing about.
  app.use("/grns/*", scmAreaGuard("scm.procurement.grn"));
  app.all("/grns/*", (c) => c.json({ reached: true }));
  return app;
}

describe("money-write carve-out — the MAP (reads preserved, writes lowered)", () => {
  test("every FULL position EXCEPT Finance Manager / Super Admin has the money keys at view", () => {
    for (const entry of POSITION_ACCESS_SNAPSHOT) {
      if (EXPECTED_COHORT[entry.name] !== "full") continue;
      if ((MONEY_POSITIONS as readonly string[]).includes(entry.name)) continue;
      const map = resolvePositionPolicy(inputFor(entry)).pageAccess as Record<string, AccessLevel>;
      for (const key of MONEY_KEYS) {
        expect(map[key], `${entry.name}:${key}`).toBe("view");
      }
      expect(resolvePositionPolicy(inputFor(entry)).flags.canMoveMoney, entry.name).toBe(false);
    }
  });

  test("Finance Manager and Super Admin keep FULL on the money keys", () => {
    for (const name of MONEY_POSITIONS) {
      const entry = POSITION_ACCESS_SNAPSHOT.find((e) => e.name === name)!;
      const map = resolvePositionPolicy(inputFor(entry)).pageAccess as Record<string, AccessLevel>;
      for (const key of MONEY_KEYS) expect(map[key], `${name}:${key}`).toBe("full");
    }
  });

  test("the carve-out ONLY lowers the money keys — every other key is untouched", () => {
    // The safety bar: this may reduce a money WRITE and nothing else. Compared
    // key-by-key against fullAccessMap over every full position.
    const full = fullAccessMap();
    for (const entry of POSITION_ACCESS_SNAPSHOT) {
      if (EXPECTED_COHORT[entry.name] !== "full") continue;
      const map = resolvePositionPolicy(inputFor(entry)).pageAccess as Record<string, AccessLevel>;
      for (const p of PAGES) {
        if ((MONEY_KEYS as readonly string[]).includes(p.key)) continue;
        expect(map[p.key], `${entry.name}:${p.key} must be unchanged`).toBe(full[p.key]);
      }
    }
  });

  test("no READ is lowered — the money keys stay at least `view` for every full position", () => {
    for (const entry of POSITION_ACCESS_SNAPSHOT) {
      if (EXPECTED_COHORT[entry.name] !== "full") continue;
      const map = resolvePositionPolicy(inputFor(entry)).pageAccess as Record<string, AccessLevel>;
      for (const key of MONEY_KEYS) {
        expect(meetsLevel(map[key], "view"), `${entry.name}:${key} lost its read`).toBe(true);
      }
    }
  });

  test("the RESTRICTED cohort is untouched by the carve-out (they never had finance)", () => {
    for (const entry of POSITION_ACCESS_SNAPSHOT) {
      if (EXPECTED_COHORT[entry.name] !== "restricted") continue;
      const map = resolvePositionPolicy(inputFor(entry)).pageAccess as Record<string, AccessLevel>;
      for (const key of MONEY_KEYS) expect(map[key], `${entry.name}:${key}`).toBe("none");
    }
  });

  test("SALES is untouched — still deferred, the carve-out does not migrate it", () => {
    for (const entry of POSITION_ACCESS_SNAPSHOT) {
      if (EXPECTED_COHORT[entry.name] !== "sales") continue;
      const policy = resolvePositionPolicy(inputFor(entry));
      expect(policy.resolutionDeferred).toBe(true);
      expect(policy.pageAccess).toBeNull();
    }
  });
});

describe("money-write carve-out — the DOOR (not theatre)", () => {
  /** A full-cohort, non-finance caller — exactly what auth.ts builds: full map
   *  minus the money writes, and NOT scm_l2_configured (so the area-guard's
   *  no-lockout fallthrough is live, which is why the denial must run before it). */
  const fullNonFinance = (positionName = "HR Manager", departmentName = "Management") => {
    const policy = resolvePositionPolicy({ position_name: positionName, department_name: departmentName });
    return {
      id: 5,
      permissions: ["scm.access"],
      permissions_set: new Set(["scm.access"]),
      position_name: positionName,
      department_name: departmentName,
      page_access: policy.pageAccess ?? {},
      scm_l2_configured: policy.scmConfigured, // false — the fallthrough is live
    };
  };

  test("a full-but-not-Finance position can READ accounting / payment vouchers / outstanding (200)", async () => {
    const app = financeAppFor(fullNonFinance());
    expect((await app.request("/accounting/journal-entries")).status).toBe(200);
    expect((await app.request("/payment-vouchers/")).status).toBe(200);
    expect((await app.request("/outstanding/")).status).toBe(200);
  });

  test("…but every money-moving WRITE 403s", async () => {
    const app = financeAppFor(fullNonFinance());
    expect((await app.request("/accounting/journal-entries", { method: "POST" })).status).toBe(403);
    expect((await app.request("/accounting/post/si/INV-1", { method: "POST" })).status).toBe(403);
    expect((await app.request("/payment-vouchers/", { method: "POST" })).status).toBe(403);
    expect((await app.request("/payment-vouchers/1", { method: "PATCH" })).status).toBe(403);
    expect((await app.request("/payment-vouchers/1", { method: "DELETE" })).status).toBe(403);
  });

  test("the 403 body is a sentence a person can act on, not a key", async () => {
    const res = await financeAppFor(fullNonFinance()).request("/accounting/journal-entries", { method: "POST" });
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Finance");
    expect(body.error).not.toContain("scm.finance");
  });

  test("every OTHER full position is denied the same way (ops, logistics, calendar viewer)", async () => {
    for (const [pos, dept] of [
      ["Operation Manager", "Operation Department"],
      ["Operation Executive", "Operation Department"],
      ["Procurement/Purchasing", "Operation Department"],
      ["Logistic Admin", "Operation Department"],
      ["Service Admin", "Operation Department"],
      ["Calendar Viewer", "Management"],
    ] as const) {
      const app = financeAppFor(fullNonFinance(pos, dept));
      expect((await app.request("/accounting/journal-entries", { method: "POST" })).status, pos).toBe(403);
      expect((await app.request("/accounting/journal-entries")).status, `${pos} read`).toBe(200);
    }
  });

  test("FINANCE MANAGER can write — it is his job", async () => {
    const app = financeAppFor(fullNonFinance("Finance Manager", "Management"));
    expect((await app.request("/accounting/journal-entries", { method: "POST" })).status).toBe(200);
    expect((await app.request("/payment-vouchers/", { method: "POST" })).status).toBe(200);
  });

  test("SUPER ADMIN can write", async () => {
    const app = financeAppFor(fullNonFinance("Super Admin", "Management"));
    expect((await app.request("/accounting/journal-entries", { method: "POST" })).status).toBe(200);
  });

  test("the `*` wildcard can write — never narrowed", async () => {
    const owner = { ...fullNonFinance(), permissions: ["*"], permissions_set: new Set(["*"]) };
    const app = financeAppFor(owner);
    expect((await app.request("/accounting/journal-entries", { method: "POST" })).status).toBe(200);
    expect((await app.request("/payment-vouchers/", { method: "POST" })).status).toBe(200);
  });

  test("a positionless caller is NOT denied — fail-open, no new lockout", async () => {
    // Positionless users resolve from the legacy ROLE matrix and never reach the
    // position policy, so the money rule must not invent a denial for them.
    const nobody = { ...fullNonFinance(), position_name: null, department_name: null };
    const app = financeAppFor(nobody);
    expect((await app.request("/accounting/journal-entries", { method: "POST" })).status).toBe(200);
  });

  test("NON-money areas are untouched — a full position still writes GRN", async () => {
    const app = financeAppFor(fullNonFinance());
    expect((await app.request("/grns/", { method: "POST" })).status).toBe(200);
    expect((await app.request("/grns/")).status).toBe(200);
  });
});

describe("positionPolicy — the adjustment split is genuinely decoupled from inventory-view", () => {
  // A caller with adjustments=edit but inventory=NONE can still POST an adjustment:
  // the write requires ONLY scm.warehouse.adjustments (the sub-mount returns before
  // the broad /inventory/* guard is reached). This is the whole point of the split.
  const adjuster = {
    id: 1,
    permissions: ["scm.access"],
    permissions_set: new Set(["scm.access"]),
    position_name: "X",
    department_name: "Operation Department",
    scm_l2_configured: true,
    page_access: { "scm.warehouse.adjustments": "edit", "scm.warehouse.inventory": "none" } as Record<string, AccessLevel>,
  };
  // The mirror: inventory-view but adjustments=none (the Storekeeper shape) — reads
  // inventory, cannot adjust.
  const viewer = {
    ...adjuster,
    page_access: { "scm.warehouse.inventory": "view", "scm.warehouse.adjustments": "none" } as Record<string, AccessLevel>,
  };

  test("adjustments=edit + inventory=none → POST /inventory/adjustments 200 (needs ONLY adjustments)", async () => {
    const res = await warehouseAppFor(adjuster).request("/inventory/adjustments", { method: "POST" });
    expect(res.status).toBe(200);
  });

  test("inventory=view + adjustments=none → GET /inventory 200 but POST adjustment 403", async () => {
    const app = warehouseAppFor(viewer);
    expect((await app.request("/inventory/")).status).toBe(200);
    expect((await app.request("/inventory/adjustments", { method: "POST" })).status).toBe(403);
  });
});
