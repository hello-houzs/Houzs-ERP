import { SELF, env as testEnv } from "cloudflare:test";
import { describe, expect, test, beforeEach } from "vitest";
import {
  DORMANT_PAGE_KEYS,
  PAGES,
  fullAccessMap,
  isDormantPageKey,
  isValidPageKey,
  loadPageAccessForPosition,
  loadPageAccessForRole,
} from "../src/services/pageAccess";
import type { Env } from "../src/types";

/* Owner 2026-07-17: "不能留着了，然后「頁面灰色」点不到吗？最重要是我要它的 UI"
   — a switch that does nothing must stop pretending, must be unclickable, and
   the ROW MUST STAY. DORMANT_PAGE_KEYS is how the editor knows which rows to
   grey.

   THE ACCEPTANCE TEST IS THAT NOTHING MOVES. Greying is a UI fact; hydration
   must not learn about it. These pin that the resolvers are blind to the list —
   a dormant key with a `= none` row still resolves to exactly "none", and a
   dormant key riding its parent still inherits. If greying ever starts changing
   what a cell resolves to, this file fails before anyone is locked out on the
   Monday after. */

/** Minimal D1 stand-in — the resolvers only ever prepare/bind/all one SELECT. */
function envWithRows(rows: Array<{ page_key: string; level: string }>): Env {
  return {
    DB: {
      prepare: () => ({
        bind: () => ({ all: async () => ({ results: rows }) }),
      }),
    },
  } as unknown as Env;
}

describe("dormant page keys — the greyed rows", () => {
  test("every dormant key is a REAL catalogue key (greying a typo greys nothing)", () => {
    for (const key of DORMANT_PAGE_KEYS) {
      expect(isValidPageKey(key), `${key} is not in PAGES[]`).toBe(true);
    }
  });

  test("the list is exactly the eight measured dead cells", () => {
    // feat/jd-rules-from-record counted six; `team.members` was the seventh — the
    // Team nav gates on the PARENT key `team` plus a flat users.read, so all four
    // team.* children are read by nothing. Re-swept 2026-07-17.
    // `scm.warehouse.adjustments` is the eighth (2026-07-18): the frontend moved
    // its nav + route off this key onto `scm.warehouse.inventory` — the key the
    // backend area-guard actually enforces for POST /inventory/adjustments — which
    // left this one with no consumer at all. Greyed, not retired: it stays in
    // PAGES[] and the Finance Manager snapshot row keeps its stored value inert.
    expect([...DORMANT_PAGE_KEYS].sort()).toEqual([
      "scm.warehouse.adjustments",
      "service_cases.by_creditor",
      "service_cases.pnl",
      "service_cases.settings",
      "team.departments",
      "team.members",
      "team.org_chart",
      "team.roles",
    ]);
  });

  test("no PARENT is dormant — greying a parent would grey a live sub-tree", () => {
    const parents = new Set(PAGES.filter((p) => p.parent).map((p) => p.parent!));
    for (const key of DORMANT_PAGE_KEYS) {
      expect(parents.has(key), `${key} is a parent and must not be greyed`).toBe(false);
    }
  });

  test("the wildcard map is untouched — `*` still resolves full on every key", () => {
    const full = fullAccessMap();
    for (const key of DORMANT_PAGE_KEYS) expect(full[key]).toBe("full");
  });

  /* THE ONE THAT MATTERS. A dormant key carrying an explicit `= none` must keep
     meaning "none" — the seed writes exactly this for hr_manager (team.roles +
     team.departments, seed-user-management.mjs:71). If greying ever severed it,
     the value would move the moment someone wires the key. */
  test("POSITION: an explicit `none` on a dormant key still resolves none, under a full parent", async () => {
    const env = envWithRows([
      { page_key: "team", level: "full" },
      { page_key: "team.roles", level: "none" },
      { page_key: "team.departments", level: "none" },
    ]);
    const out = await loadPageAccessForPosition(env, 1);
    expect(out["team"]).toBe("full");
    expect(out["team.roles"]).toBe("none");
    expect(out["team.departments"]).toBe("none");
    // …and a dormant key with NO row still INHERITS. Absent is not "none".
    expect(out["team.members"]).toBe("full");
    expect(out["team.org_chart"]).toBe("full");
  });

  test("ROLE: the legacy matrix resolves dormant keys by its own cascade, unchanged", async () => {
    const env = envWithRows([{ page_key: "service_cases", level: "partial" }]);
    const out = await loadPageAccessForRole(env, 1, new Set(["service_cases.read"]));
    // parent "partial" → children keep their own backfill, dormant or not.
    expect(out["service_cases.by_creditor"]).toBe("partial");
    // supportsPartial:false pages backfill on service_cases.manage, which this
    // role lacks — so "none", exactly as before the list existed.
    expect(out["service_cases.pnl"]).toBe("none");
    expect(out["service_cases.settings"]).toBe("none");
  });

  test("dormancy is INERT in hydration — resolution ignores the list entirely", async () => {
    // Same rows, resolved twice; the only thing that differs between a dormant
    // and a live key here is that one is on the list. Their resolution must not.
    const env = envWithRows([{ page_key: "service_cases", level: "full" }]);
    const out = await loadPageAccessForPosition(env, 1);
    expect(isDormantPageKey("service_cases.by_creditor")).toBe(true);
    expect(isDormantPageKey("service_cases.cases")).toBe(false);
    // The live child and the dormant child inherit identically.
    expect(out["service_cases.cases"]).toBe("full");
    expect(out["service_cases.by_creditor"]).toBe("full");
  });
});

/* ── THE TWO EDITORS, THROUGH THEIR REAL DOORS ────────────────────────────
   #709 greyed Team > Positions and flagged that /team?tab=roles rendered the
   same seven cells as settable — GET /api/roles/pages did not send `dormant`.
   Both editors read ONE catalogue (PAGES), so a cell that lies in one lies in
   the other; these hit the actual endpoints rather than re-asserting the rule,
   because "the rule says deny" and "the door denies" are different claims
   (7764df38). If the two catalogues ever diverge, the last test here fails and
   the divergence IS the finding. */

async function seedRoleReader(perms: string[]): Promise<string> {
  const roleRes = await testEnv.DB.prepare(
    `INSERT INTO roles (name, description, permissions) VALUES (?, ?, ?)`,
  )
    .bind(`dormant_role_${Math.random().toString(36).slice(2)}`, "test", JSON.stringify(perms))
    .run();
  const roleId = roleRes.meta.last_row_id as number;
  const userRes = await testEnv.DB.prepare(
    `INSERT INTO users (email, name, role_id, status, joined_at)
     VALUES (?, ?, ?, 'active', datetime('now'))`,
  )
    .bind(`dk-${roleId}@test.local`, "dk", roleId)
    .run();
  const token = `dk-${userRes.meta.last_row_id}-${Math.random().toString(36).slice(2)}`;
  await testEnv.DB.prepare(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`,
  )
    .bind(token, userRes.meta.last_row_id as number, new Date(Date.now() + 3600_000).toISOString())
    .run();
  return `Bearer ${token}`;
}

async function getPages(path: string, bearer: string) {
  const res = await SELF.fetch(`https://test.local${path}`, {
    headers: { Authorization: bearer },
  });
  return { status: res.status, json: (await res.json()) as { pages?: Array<{ key: string; dormant?: boolean }> } };
}

describe("dormant flag on the wire — both matrix editors", () => {
  beforeEach(async () => {
    await testEnv.DB.exec(`DELETE FROM sessions`);
    await testEnv.DB.exec(`DELETE FROM users`);
    await testEnv.DB.exec(`DELETE FROM roles WHERE is_system = 0`);
  });

  test("GET /api/roles/pages marks exactly the seven dormant — the cells #709 left settable here", async () => {
    const bearer = await seedRoleReader(["roles.read"]);
    const { status, json } = await getPages("/api/roles/pages", bearer);
    expect(status).toBe(200);
    const dormantKeys = (json.pages ?? []).filter((p) => p.dormant).map((p) => p.key).sort();
    expect(dormantKeys).toEqual([...DORMANT_PAGE_KEYS].sort());
  });

  test("every OTHER key on /api/roles/pages is explicitly dormant:false — silence would read as wired", async () => {
    const bearer = await seedRoleReader(["roles.read"]);
    const { json } = await getPages("/api/roles/pages", bearer);
    const live = (json.pages ?? []).filter((p) => !DORMANT_PAGE_KEYS.has(p.key));
    expect(live.length).toBeGreaterThan(0);
    for (const p of live) expect(p.dormant, `${p.key} should be dormant:false`).toBe(false);
  });

  test("the two editors see the SAME catalogue and the SAME dead cells", async () => {
    // The brief's open question, pinned: if the Roles editor's key set ever
    // differs from the Positions editor's, one of them is greying a cell the
    // other lets an admin set — which is the whole bug, one editor over.
    const bearer = await seedRoleReader(["*"]);
    const roles = await getPages("/api/roles/pages", bearer);
    const positions = await getPages("/api/positions/pages", bearer);
    expect(roles.status).toBe(200);
    expect(positions.status).toBe(200);

    const shape = (r: typeof roles) =>
      Object.fromEntries((r.json.pages ?? []).map((p) => [p.key, p.dormant === true]));
    // Sorted by key: /api/positions/pages honours the admin's saved matrix
    // ORDER, /api/roles/pages does not — order is display, membership is truth.
    expect(shape(roles)).toEqual(shape(positions));
  });
});
