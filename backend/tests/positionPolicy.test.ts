import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { resolvePositionPolicy } from "../src/services/positionPolicy";
import { scmAreaGuard } from "../src/scm/middleware/area-guard";
import { PAGES, fullAccessMap, type AccessLevel } from "../src/services/pageAccess";
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

  test("every FULL position resolves to fullAccessMap() — nothing narrowed", () => {
    const full = fullAccessMap();
    for (const entry of POSITION_ACCESS_SNAPSHOT) {
      if (EXPECTED_COHORT[entry.name] !== "full") continue;
      const policy = resolvePositionPolicy(inputFor(entry));
      expect(policy.pageAccess, `${entry.name}`).toEqual(full);
      // Same signal `*` gets — a full map needs no per-area enforcement.
      expect(policy.scmConfigured, `${entry.name}`).toBe(false);
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
    });
    const full = resolvePositionPolicy({ position_name: "HR Manager", department_name: "Management" });
    expect(full.flags).toEqual({
      orderScope: "all",
      canSeeMargin: true,
      canSeeCommission: true,
      announcementScope: "all",
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
    expect(policy.pageAccess).toEqual(fullAccessMap());
  });

  test("a null/empty position name falls open to FULL (not an empty map)", () => {
    const a = resolvePositionPolicy({ position_name: null, department_name: null });
    expect(a.cohort).toBe("full");
    expect(a.pageAccess).toEqual(fullAccessMap());
    const b = resolvePositionPolicy({ position_name: "", department_name: "" });
    expect(b.cohort).toBe("full");
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
