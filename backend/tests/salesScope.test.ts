import { env } from "cloudflare:test";
import { describe, expect, test, beforeEach } from "vitest";
import { salesVisibilityUserIds, salespersonInScope } from "../src/services/salesTeam";

// Exercises the row-level sales visibility subtree against the isolated test
// D1, which has the sales_reps table from migration 067. The uniform rule —
// "a rep sees themselves + their entire downline" — must collapse to the three
// position tiers without any position labels: root = all, mid = branch,
// leaf = self.

async function seedRep(
  id: number,
  userId: number | null,
  uplineId: number | null,
  opts: { archived?: string } = {},
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO sales_reps (id, code, name, user_id, upline_id, status, archived_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?)`,
  )
    .bind(id, `SR-${id}`, `Rep ${id}`, userId, uplineId, opts.archived ?? null)
    .run();
}

const sorted = (xs: number[] | null) => (xs == null ? null : [...xs].sort((a, b) => a - b));

// The test D1 enforces FKs, so satisfy sales_reps.user_id → users(id) and
// users.role_id → roles(id) with throwaway rows for the ids the tests use.
const USER_IDS = [101, 102, 103, 104];

beforeEach(async () => {
  await env.DB.exec(`DELETE FROM sales_reps`);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO roles (id, name) VALUES (1, 'scope-test-role')`,
  ).run();
  for (const uid of USER_IDS) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO users (id, email, role_id, status) VALUES (?, ?, 1, 'active')`,
    )
      .bind(uid, `scope-test-${uid}@example.com`)
      .run();
  }
});

describe("sales visibility subtree", () => {
  test("leaf rep sees only their own user id", async () => {
    await seedRep(1, 101, null);
    expect(sorted(await salesVisibilityUserIds(env, 101))).toEqual([101]);
  });

  test("root manager sees self + the whole downline (every tier)", async () => {
    await seedRep(1, 101, null); // root (director)
    await seedRep(2, 102, 1); // manager under root
    await seedRep(3, 103, 2); // exec under manager
    await seedRep(4, 104, 1); // another direct report
    expect(sorted(await salesVisibilityUserIds(env, 101))).toEqual([101, 102, 103, 104]);
  });

  test("mid manager sees only their own branch, not siblings/parent", async () => {
    await seedRep(1, 101, null);
    await seedRep(2, 102, 1);
    await seedRep(3, 103, 2);
    await seedRep(4, 104, 1); // sibling branch — must NOT be visible to 102
    expect(sorted(await salesVisibilityUserIds(env, 102))).toEqual([102, 103]);
  });

  test("a user who is not a sales rep is unrestricted (null)", async () => {
    await seedRep(1, 101, null);
    expect(await salesVisibilityUserIds(env, 999)).toBeNull();
  });

  test("archived downline reps are excluded from the subtree", async () => {
    await seedRep(1, 101, null);
    await seedRep(2, 102, 1, { archived: "2026-01-01T00:00:00Z" });
    expect(sorted(await salesVisibilityUserIds(env, 101))).toEqual([101]);
  });

  test("salespersonInScope: subtree members in, outsiders out, non-rep unrestricted", async () => {
    await seedRep(1, 101, null);
    await seedRep(2, 102, 1);
    expect(await salespersonInScope(env, 101, 102)).toBe(true); // downline → visible
    expect(await salespersonInScope(env, 101, 999)).toBe(false); // outsider → hidden
    expect(await salespersonInScope(env, 102, 101)).toBe(false); // upward → hidden
    expect(await salespersonInScope(env, 555, 12345)).toBe(true); // non-rep caller → all
  });
});
