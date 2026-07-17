// ----------------------------------------------------------------------------
// The equivalence proof: for every position the snapshot names and every page in
// the registry, resolving from the TABLE and resolving from the SNAPSHOT must
// produce the identical level. 17 x 50 = 850 cells, asserted one by one.
//
// WHAT THIS PROVES AND WHAT IT DOES NOT — the distinction decides how much the
// green tick is worth, so it is stated rather than left to be assumed.
//
//   PROVES: the snapshot RESOLVER reproduces `loadPageAccessForPosition`'s
//   semantics exactly, given the same rows — inheritance, the absent-vs-"none"
//   distinction, orphan-key inertness, and `scm_l2_configured`.
//
//   DOES NOT PROVE: that the snapshot's rows still match the owner's live prod
//   table. It cannot: this suite runs on an isolated D1 seeded FROM the snapshot,
//   and prod is a Supabase project no test reaches. That question is answerable
//   only against prod itself, which is exactly what the shadow in
//   `positionAccessShadow.ts` exists to answer, over real logins, at zero risk.
//   Seeding the table from the snapshot and then comparing the two is circular
//   as a DATA check and sound as a RESOLVER check — and the resolver is the only
//   thing under test here, because the snapshot is the owner's data: a mismatch
//   means the resolver is wrong, never that the snapshot needs "fixing".
// ----------------------------------------------------------------------------

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  PAGES,
  loadPageAccessForPosition,
  fullAccessMap,
  type AccessLevel,
  type PageAccessMeta,
} from "../src/services/pageAccess";
import {
  POSITION_ACCESS_SNAPSHOT,
  POSITION_ACCESS_SNAPSHOT_SOURCE,
} from "../src/services/positionAccessSnapshot";
import {
  diffPageAccess,
  isSnapshotProvenance,
  resolveFromSnapshot,
  shadowComparePositionAccess,
  snapshotEntryFor,
} from "../src/services/positionAccessShadow";
import { applySalesJdOverride } from "../src/services/salesJdAccess";

const REGISTRY_KEYS = PAGES.map((p) => p.key);

/**
 * Rewrite the isolated D1's matrix to be EXACTLY the snapshot's rows.
 *
 * No numbered migration seeds `positions`, `departments` or
 * `position_page_access` — the User-Management seed is a hand-run script
 * (`scripts/seed-user-management.mjs`), per the repo's "demo data is not a
 * migration" rule — so these tables start empty here and the DELETE is a
 * defensive no-op rather than a cleanup.
 */
beforeAll(async () => {
  await env.DB.prepare(`DELETE FROM position_page_access`).run();

  for (const p of POSITION_ACCESS_SNAPSHOT) {
    // position_page_access.position_id is a FK to positions(id), so the parent
    // row has to exist before its cells land. department_id is deliberately
    // NULL and not the snapshot's: it is a FK to a `departments` table this
    // suite never populates, and NOTHING in page-access resolution reads it —
    // loadPageAccessForPosition selects from position_page_access alone. Seeding
    // a department here would fabricate a dependency the code does not have.
    // (The JD tests below take department_name from the snapshot object, which
    // is where the live code gets it too — the users row, not the position row.)
    await env.DB.prepare(
      `INSERT OR IGNORE INTO positions (id, department_id, slug, name)
       VALUES (?, NULL, ?, ?)`,
    )
      .bind(p.id, p.slug, p.name)
      .run();

    for (const [page_key, level] of Object.entries(p.entries)) {
      await env.DB.prepare(
        `INSERT INTO position_page_access (position_id, page_key, level)
         VALUES (?, ?, ?)
         ON CONFLICT(position_id, page_key) DO UPDATE SET level = excluded.level`,
      )
        .bind(p.id, page_key, level as string)
        .run();
    }
  }
});

describe("the snapshot's shape matches what its header claims", () => {
  it("names 17 positions", () => {
    expect(POSITION_ACCESS_SNAPSHOT.length).toBe(17);
  });

  it("the registry is 50 pages, 43 of which have a parent", () => {
    // If this fires because you changed PAGES[], do NOT just update the number.
    // These counts are bookkeeping for the photograph; the catalogue's own guard
    // is pageCatalogueDrift.test.ts, and it explains what a removed key does to
    // the rows saved against it. Read that failure first — it is the one with
    // the consequence in it.
    expect(
      PAGES.length,
      "PAGES[] changed size — see pageCatalogueDrift.test.ts before touching this number",
    ).toBe(50);
    expect(PAGES.filter((p) => p.parent).length).toBe(43);
  });

  it("carries 144 rows: 138 registry cells + 6 orphans, leaving 712 gaps", () => {
    const all = POSITION_ACCESS_SNAPSHOT.flatMap((p) => Object.keys(p.entries));
    const registry = new Set(REGISTRY_KEYS);
    const orphans = all.filter((k) => !registry.has(k));

    expect(all.length).toBe(144);
    // A 7th orphan means a key left PAGES[] and took one of his saved cells with
    // it. That is the 2026-06-18 bug happening again, not a stale constant —
    // pageCatalogueDrift.test.ts says what to do about it.
    expect(
      orphans.length,
      `orphan count moved (${orphans.sort().join(", ")}) — a page key left PAGES[]. ` +
        `See pageCatalogueDrift.test.ts; do not just update this number.`,
    ).toBe(6);
    expect(all.length - orphans.length).toBe(138);

    // The gap count is the load-bearing number: 850 addressable cells minus the
    // 138 he actually set. Orphans are rows but not cells — they address no
    // registry page — which is why 144 - 6 is what balances against 850 - 712.
    const cells = POSITION_ACCESS_SNAPSHOT.length * PAGES.length;
    expect(cells).toBe(850);
    expect(cells - 138).toBe(712);
  });

  it("every level is one the position table would accept", () => {
    // The table CHECKs level IN ('none','view','edit','full') — 'partial' is a
    // role-matrix concept. A snapshot value outside that set could never have
    // come from these rows.
    const allowed = new Set(["none", "view", "edit", "full"]);
    for (const p of POSITION_ACCESS_SNAPSHOT) {
      for (const [k, v] of Object.entries(p.entries)) {
        expect(allowed.has(v as string), `${p.slug}.${k} = ${v}`).toBe(true);
      }
    }
  });

  it("was photographed from prod, and says so", () => {
    expect(POSITION_ACCESS_SNAPSHOT_SOURCE).toContain("erp.houzscentury.com");
  });
});

describe("850-cell equivalence: table-resolved === snapshot-resolved", () => {
  it("agrees on every one of the 850 cells", async () => {
    const divergences: string[] = [];
    let compared = 0;

    for (const p of POSITION_ACCESS_SNAPSHOT) {
      const fromTable = await loadPageAccessForPosition(env as any, p.id);
      const fromSnapshot = resolveFromSnapshot(p.id);
      expect(fromSnapshot, `snapshot must name position ${p.id}`).not.toBeNull();

      for (const key of REGISTRY_KEYS) {
        compared++;
        if (fromTable[key] !== fromSnapshot![key]) {
          divergences.push(
            `${p.slug} (id=${p.id}) ${key}: table=${fromTable[key]} snapshot=${fromSnapshot![key]}`,
          );
        }
      }
    }

    expect(compared).toBe(850);
    // Printed in full rather than counted: a single divergent cell is a stop,
    // and the next reader needs to see WHICH cell without re-running anything.
    expect(divergences, `divergent cells:\n${divergences.join("\n")}`).toEqual([]);
  });

  it("agrees on scm_l2_configured for every position", async () => {
    // Same rows, same derivation — but this flag gates the SCM area-guard, so
    // the two maps could match on all 50 cells and still enforce differently.
    for (const p of POSITION_ACCESS_SNAPSHOT) {
      const tableMeta: PageAccessMeta = { explicitScm: false };
      await loadPageAccessForPosition(env as any, p.id, tableMeta);

      const snapMeta: PageAccessMeta = { explicitScm: false };
      resolveFromSnapshot(p.id, snapMeta);

      expect(snapMeta.explicitScm, `${p.slug} scm_l2_configured`).toBe(
        tableMeta.explicitScm,
      );
    }
  });

  it("diffPageAccess reports nothing for any position", async () => {
    for (const p of POSITION_ACCESS_SNAPSHOT) {
      const fromTable = await loadPageAccessForPosition(env as any, p.id);
      expect(diffPageAccess(fromTable, resolveFromSnapshot(p.id)!)).toEqual([]);
    }
  });
});

describe("the inherit semantics survive the sparse map (trap 1)", () => {
  it("an absent child inherits its parent instead of resolving to none", () => {
    // Sales Director (id=5) has scm.sales=full and NO row for scm.sales.orders.
    // Absent must mean INHERIT — resolving it as "none" would deny under a full
    // parent and silently rewrite his configuration.
    const entry = snapshotEntryFor(5)!;
    expect(entry.name).toBe("Sales Director");
    expect(entry.entries["scm.sales"]).toBe("full");
    expect("scm.sales.orders" in entry.entries).toBe(false);

    const resolved = resolveFromSnapshot(5)!;
    expect(resolved["scm.sales"]).toBe("full");
    expect(resolved["scm.sales.orders"]).toBe("full");
    expect(resolved["scm.sales.delivery"]).toBe("full");
  });

  it("an explicit none still denies under a full parent", () => {
    // Finance Manager (id=3): service_cases=view with service_cases.settings=none.
    // The row must beat the parent, or "none" would mean nothing.
    const resolved = resolveFromSnapshot(3)!;
    expect(resolved["service_cases"]).toBe("view");
    expect(resolved["service_cases.settings"]).toBe("none");
  });

  it("an explicit grandchild survives a parent that inherited none", () => {
    // Storekeeper Supervisor (id=19) has scm.procurement.grn=view but no row for
    // scm or scm.procurement — both resolve "none" by gap, and the explicit
    // grandchild must still stand. This is the exact shape a backfill-to-"none"
    // would destroy.
    const entry = snapshotEntryFor(19)!;
    expect("scm" in entry.entries).toBe(false);
    expect("scm.procurement" in entry.entries).toBe(false);

    const resolved = resolveFromSnapshot(19)!;
    expect(resolved["scm"]).toBe("none");
    expect(resolved["scm.procurement"]).toBe("none");
    expect(resolved["scm.procurement.grn"]).toBe("view");
  });

  it("the 6 orphan rows grant nothing and do not mark anyone L2-configured", () => {
    // Finance Manager carries all 6 (orders*, overview, petty_cash). They are
    // rows, not cells: no registry page answers to them.
    const entry = snapshotEntryFor(3)!;
    const registry = new Set(REGISTRY_KEYS);
    const orphans = Object.keys(entry.entries).filter((k) => !registry.has(k));
    expect(orphans.sort()).toEqual([
      "orders",
      "orders.balance",
      "orders.overdue",
      "orders.pnl",
      "overview",
      "petty_cash",
    ]);

    const resolved = resolveFromSnapshot(3)!;
    for (const k of orphans) expect(resolved[k]).toBeUndefined();
    expect(Object.keys(resolved).sort()).toEqual([...REGISTRY_KEYS].sort());
  });
});

describe("a position the snapshot does not name (trap 2)", () => {
  it("resolves to null, not to an all-none map", () => {
    // POST /api/positions (positions.ts:339-383) inserts into `positions` only —
    // no matrix rows — so a position created after the photograph is absent here.
    // null forces the caller to the live table. An all-"none" map would mean a
    // new hire cannot work on day one and nobody can fix it, because the editor
    // would no longer be the source.
    expect(resolveFromSnapshot(9999)).toBeNull();
    expect(snapshotEntryFor(9999)).toBeUndefined();
  });

  it("the live table still answers for it, and the shadow stays quiet", async () => {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO positions (id, department_id, slug, name)
       VALUES (9999, NULL, 'post-cutover-hire', 'Post Cutover Hire')`,
    ).run();

    await env.DB.prepare(
      `INSERT INTO position_page_access (position_id, page_key, level)
       VALUES (9999, 'projects', 'view')
       ON CONFLICT(position_id, page_key) DO UPDATE SET level = excluded.level`,
    ).run();

    // The table answers — and an admin editing the matrix is what produced this.
    const fromTable = await loadPageAccessForPosition(env as any, 9999);
    expect(fromTable["projects"]).toBe("view");
    expect(fromTable["projects.calendar"]).toBe("view");

    const res = shadowComparePositionAccess(
      { PUBLIC_APP_URL: "https://erp.houzscentury.com" },
      9999,
      fromTable,
      { explicitScm: false },
    );
    expect(res.compared).toBe(false);
    expect(res.reason).toBe("not-in-snapshot");
  });
});

describe("the shadow serves the table and never narrows the wildcard", () => {
  it("is inert off its own provenance (staging is a different database)", () => {
    expect(isSnapshotProvenance({ PUBLIC_APP_URL: "https://erp.houzscentury.com" })).toBe(true);
    expect(isSnapshotProvenance({ PUBLIC_APP_URL: "https://houzs-erp-staging.pages.dev" })).toBe(false);
    expect(isSnapshotProvenance({})).toBe(false);

    const res = shadowComparePositionAccess(
      { PUBLIC_APP_URL: "https://houzs-erp-staging.pages.dev" },
      5,
      {} as Record<string, AccessLevel>,
      { explicitScm: false },
    );
    expect(res.compared).toBe(false);
    expect(res.reason).toBe("provenance-mismatch");
  });

  it("reports a divergence rather than repairing it", async () => {
    const fromTable = await loadPageAccessForPosition(env as any, 5);
    const tampered = { ...fromTable, "projects.calendar": "none" as AccessLevel };

    const res = shadowComparePositionAccess(
      { PUBLIC_APP_URL: "https://erp.houzscentury.com" },
      5,
      tampered,
      { explicitScm: false },
    );
    expect(res.compared).toBe(true);
    expect(res.divergences?.some((d) => d.page_key === "projects.calendar")).toBe(true);
    // The served map is untouched — the shadow returns findings, never a map.
    expect(tampered["projects.calendar"]).toBe("none");
  });

  it("the `*` wildcard's fullAccessMap passes through applySalesJdOverride untouched", () => {
    // Narrowing this locks the owner out of his own system. It arrives from
    // auth.ts as fullAccessMap() and must come back identical — including
    // scm.sales.returns, which the JD denies for everyone else.
    const full = fullAccessMap();
    const after = applySalesJdOverride(full, {
      permissions: new Set(["*"]),
      position_name: "Sales Director",
      department_name: "Sales Department",
    });
    expect(after).toEqual(full);
    expect(after["scm.sales.returns"]).toBe("full");
  });
});

describe("applySalesJdOverride lands identically on both maps", () => {
  it("produces the same post-override map from table and snapshot, for every position", async () => {
    // The JD runs AFTER hydration and is a pure function of (map, user), so
    // equal maps must give equal results. Asserted rather than argued: it is the
    // last thing to touch page_access before it is served, and "sales director
    // 算sales" (owner, 2026-07-17) makes it load-bearing for the cohort.
    for (const p of POSITION_ACCESS_SNAPSHOT) {
      const user = {
        permissions: new Set<string>(),
        position_name: p.name,
        department_name: p.department_name,
      };
      const fromTable = applySalesJdOverride(
        await loadPageAccessForPosition(env as any, p.id),
        user,
      );
      const fromSnapshot = applySalesJdOverride(resolveFromSnapshot(p.id)!, user);
      expect(fromSnapshot, `${p.slug} post-JD`).toEqual(fromTable);
    }
  });

  it("still denies returns to the Sales Director on both", async () => {
    const user = {
      permissions: new Set<string>(),
      position_name: "Sales Director",
      department_name: "Sales Department",
    };
    // His matrix row says scm.sales=full, so returns inherits `full` — and the
    // JD's "就是要关" is what takes it back. If the snapshot ever stopped feeding
    // the JD the same map, this deny would silently stop landing.
    expect(resolveFromSnapshot(5)!["scm.sales.returns"]).toBe("full");
    expect(applySalesJdOverride(resolveFromSnapshot(5)!, user)["scm.sales.returns"]).toBe("none");
    expect(
      applySalesJdOverride(await loadPageAccessForPosition(env as any, 5), user)[
        "scm.sales.returns"
      ],
    ).toBe("none");
  });
});
