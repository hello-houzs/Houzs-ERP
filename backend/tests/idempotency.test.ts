import { SELF, env } from "cloudflare:test";
import { describe, expect, test, beforeEach } from "vitest";

// Exercises the opt-in idempotency middleware (middleware/idempotency.ts)
// against a real mutating endpoint (POST /api/projects), which returns a
// fresh id+code and inserts a countable row — so "ran once vs twice" is
// directly observable.

let adminBearer: string;

async function seedAdmin(): Promise<string> {
  const role = await env.DB.prepare(
    `INSERT INTO roles (name, description, permissions, scope_to_pic)
     VALUES (?, ?, ?, 0)`,
  )
    .bind(`role_admin_${Math.random().toString(36).slice(2)}`, "test", JSON.stringify(["*"]))
    .run();
  const roleId = role.meta.last_row_id as number;

  const user = await env.DB.prepare(
    `INSERT INTO users (email, name, role_id, status, joined_at)
     VALUES (?, 'Admin', ?, 'active', datetime('now'))`,
  )
    .bind(`admin_${Math.random().toString(36).slice(2)}@test.local`, roleId)
    .run();
  const userId = user.meta.last_row_id as number;

  const token = `tok-${userId}-${Math.random().toString(36).slice(2)}`;
  await env.DB.prepare(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`,
  )
    .bind(token, userId, new Date(Date.now() + 3_600_000).toISOString())
    .run();
  return `Bearer ${token}`;
}

async function createProject(bearer: string, idemKey?: string) {
  const headers: Record<string, string> = {
    Authorization: bearer,
    "Content-Type": "application/json",
  };
  if (idemKey) headers["Idempotency-Key"] = idemKey;
  const res = await SELF.fetch("https://test.local/api/projects", {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "Idem project",
      brand: "AKEMI",
      state: "SELANGOR",
      venue: "TEST VENUE",
      organizer: "TEST ORG",
    }),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json, replay: res.headers.get("Idempotent-Replay") };
}

async function projectCount(): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM projects`).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

beforeEach(async () => {
  await env.DB.exec(`DELETE FROM project_activity`);
  await env.DB.exec(`DELETE FROM project_finance`);
  await env.DB.exec(`DELETE FROM sales_entries`);
  await env.DB.exec(`DELETE FROM projects`);
  await env.DB.exec(`DELETE FROM idempotency_keys`);
  await env.DB.exec(`DELETE FROM sessions`);
  await env.DB.exec(`DELETE FROM user_brands`);
  await env.DB.exec(`DELETE FROM users`);
  await env.DB.exec(`DELETE FROM roles WHERE is_system = 0`);
  adminBearer = await seedAdmin();
});

describe("idempotency middleware", () => {
  test("same Idempotency-Key replays the first response and runs the handler once", async () => {
    const first = await createProject(adminBearer, "key-abc");
    expect(first.status).toBe(201);
    expect(first.json.id).toBeGreaterThan(0);
    expect(first.replay).toBeNull(); // first call is not a replay
    expect(await projectCount()).toBe(1);

    const second = await createProject(adminBearer, "key-abc");
    expect(second.status).toBe(201);
    expect(second.replay).toBe("true"); // served from the stored response
    // Identical body — same id + code, not a freshly created project.
    expect(second.json.id).toBe(first.json.id);
    expect(second.json.code).toBe(first.json.code);
    // The crucial guarantee: the handler did NOT run a second time.
    expect(await projectCount()).toBe(1);

    // The key was persisted as completed.
    const row = await env.DB.prepare(
      `SELECT status_code FROM idempotency_keys WHERE key = ? AND scope = ?`,
    )
      .bind("key-abc", "POST /api/projects")
      .first<{ status_code: number }>();
    expect(row?.status_code).toBe(201);
  });

  test("no Idempotency-Key header → pass-through, each call creates a row", async () => {
    const a = await createProject(adminBearer);
    const b = await createProject(adminBearer);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.json.id).not.toBe(a.json.id);
    expect(await projectCount()).toBe(2);

    // Nothing was recorded in the idempotency table.
    const keys = await env.DB.prepare(`SELECT COUNT(*) AS n FROM idempotency_keys`).first<{
      n: number;
    }>();
    expect(Number(keys?.n ?? 0)).toBe(0);
  });

  test("different keys do not collide", async () => {
    const a = await createProject(adminBearer, "key-1");
    const b = await createProject(adminBearer, "key-2");
    expect(a.json.id).not.toBe(b.json.id);
    expect(await projectCount()).toBe(2);
  });

  test("a key whose original request is still in flight → 409 carrying a mappable CODE", async () => {
    // A claim with status_code NULL is exactly what the middleware leaves while
    // the original request is running; seeding it makes the race deterministic.
    await env.DB.prepare(
      `INSERT INTO idempotency_keys (key, scope, user_id) VALUES (?, ?, NULL)`,
    )
      .bind("key-inflight", "POST /api/projects")
      .run();

    const res = await createProject(adminBearer, "key-inflight");
    expect(res.status).toBe(409);
    // The contract the frontend depends on: `error` must stay a CODE. The
    // plain-language mappers (humanApiError / humanHttpMessage) look it up in a
    // curated table, so a bare English sentence here silently falls through to
    // the generic 409 ("That clashes with something already in the system"),
    // which tells the operator their payment failed at the one moment it is
    // actually going through — and invites the double-submit the key prevents.
    expect(res.json.error).toBe("idempotency_in_flight");
    // The in-flight collision must not run the handler a second time.
    expect(await projectCount()).toBe(0);
  });
});
