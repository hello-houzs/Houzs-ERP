import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { getUserBySession } from "../src/services/auth";
import {
  rememberSessionLiveness,
  sessionLivenessFallback,
  __resetSessionLivenessForTest,
  SESSION_FALLBACK_TTL_MS,
} from "../src/services/sessionCache";
import type { Env } from "../src/types";

// Bounded short-TTL fallback for session revocation (owner 2026-07-21). The
// Houzs DB layer has recurring brief blips (cold-start 503, Supavisor pooler
// hiccups); pure fail-closed logged the whole company out on every blip. On a
// DB-read FAILURE, getUserBySession may re-serve the LAST authoritatively
// confirmed "active" result for a token while it is younger than the TTL, and
// otherwise still fails closed. These tests pin all four required behaviours:
// DB-up is authoritative, DB-down + fresh cache is allowed, DB-down + stale or
// absent cache is rejected, and a revocation propagates within the TTL.

let roleId = 0;
let userId = 0;
let token = "";

const sessionKey = () => `sess:${token}`;

async function seedSession(): Promise<void> {
  token = `session-fallback-${crypto.randomUUID()}`;
  const role = await env.DB.prepare(
    `INSERT INTO roles (name, description, permissions, scope_to_pic)
     VALUES (?, 'session fallback test', ?, 0)`,
  )
    .bind(`fallback-role-${crypto.randomUUID()}`, JSON.stringify(["*"]))
    .run();
  roleId = Number(role.meta.last_row_id);

  const user = await env.DB.prepare(
    `INSERT INTO users (email, name, password_hash, role_id, status, joined_at)
     VALUES (?, 'Fallback Test', 'unused', ?, 'active', datetime('now'))`,
  )
    .bind(`fallback-${crypto.randomUUID()}@test.local`, roleId)
    .run();
  userId = Number(user.meta.last_row_id);

  await env.DB.prepare(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`,
  )
    .bind(token, userId, new Date(Date.now() + 3_600_000).toISOString())
    .run();
}

/** Warm the caches with a working DB so the in-memory liveness entry is fresh
 *  and active — exactly the state a live user's prior request would leave. */
async function warmLiveness() {
  const user = await getUserBySession(env as unknown as Env, token);
  expect(user?.id).toBe(userId);
  // The authoritative read just confirmed the session — the fallback now holds
  // a fresh entry we can rely on for the outage cases below.
  expect(sessionLivenessFallback(token)?.id).toBe(userId);
  return user!;
}

/** An Env whose every DB read/write rejects, standing in for a DB-layer outage
 *  (cold-start 503 / pooler hiccup). KV is left working so getCachedUser still
 *  resolves — only the authoritative DB reads fail, which is the real scenario. */
function makeDownDbEnv(): Env {
  const outage = () => Promise.reject(new Error("injected DB outage"));
  const stmt: any = {
    bind: () => stmt,
    first: outage,
    all: outage,
    run: outage,
  };
  const downDb: any = { prepare: () => stmt };
  return { DB: downDb, SESSION_CACHE: env.SESSION_CACHE } as unknown as Env;
}

beforeEach(async () => {
  __resetSessionLivenessForTest();
  await seedSession();
});

afterEach(async () => {
  __resetSessionLivenessForTest();
  await env.SESSION_CACHE.delete(sessionKey());
  if (token) {
    await env.DB.prepare(`DELETE FROM sessions WHERE token = ?`).bind(token).run();
  }
  if (userId) {
    await env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(userId).run();
  }
  if (roleId) {
    await env.DB.prepare(`DELETE FROM roles WHERE id = ?`).bind(roleId).run();
  }
  roleId = 0;
  userId = 0;
  token = "";
});

describe("bounded short-TTL session-revocation fallback", () => {
  test("DB up is authoritative — a live DB read overrides any fallback entry", async () => {
    await warmLiveness();
    // Disable the user in the DB. The in-memory fallback still says "active",
    // but a reachable DB must win and the entry must be forgotten.
    await env.DB.prepare(`UPDATE users SET status = 'disabled' WHERE id = ?`)
      .bind(userId)
      .run();

    expect(await getUserBySession(env as unknown as Env, token)).toBeNull();
    expect(sessionLivenessFallback(token)).toBeNull();
  });

  test("DB down + fresh cache → the request is allowed from the fallback", async () => {
    const warmed = await warmLiveness();

    const served = await getUserBySession(makeDownDbEnv(), token);
    expect(served?.id).toBe(userId);
    expect(served?.email).toBe(warmed.email);
  });

  test("DB down + absent cache → fail closed (rejected)", async () => {
    // No warm read for this token, and the map was reset in beforeEach.
    expect(sessionLivenessFallback(token)).toBeNull();

    await expect(getUserBySession(makeDownDbEnv(), token)).rejects.toThrow(
      /injected DB outage/,
    );
  });

  test("DB down + stale cache (past TTL) → fail closed (rejected) and evicted", async () => {
    const warmed = await warmLiveness();
    // Age the recorded entry beyond the TTL to model an outage that outlasts the
    // accepted window.
    rememberSessionLiveness(
      token,
      warmed,
      Date.now() - SESSION_FALLBACK_TTL_MS - 1_000,
    );

    await expect(getUserBySession(makeDownDbEnv(), token)).rejects.toThrow(
      /injected DB outage/,
    );
    // The stale entry is evicted on the failed lookup, so it cannot linger.
    expect(sessionLivenessFallback(token)).toBeNull();
  });

  test("a fresh cache exactly at the TTL boundary is already stale (>= TTL)", async () => {
    const warmed = await warmLiveness();
    const now = Date.now();
    rememberSessionLiveness(token, warmed, now - SESSION_FALLBACK_TTL_MS);
    // The boundary is exclusive: an entry exactly TTL old no longer counts.
    expect(sessionLivenessFallback(token, now)).toBeNull();
    // One millisecond inside the window is still honoured.
    rememberSessionLiveness(token, warmed, now - SESSION_FALLBACK_TTL_MS + 1);
    expect(sessionLivenessFallback(token, now)?.id).toBe(userId);
  });

  test("revocation is bounded: honoured within TTL during an outage, then rejected once stale and immediately once the DB returns", async () => {
    const warmed = await warmLiveness();
    // Admin revokes by deleting the session row directly — the same raw DELETE a
    // password reset / disable performs, and (like a revoke handled on another
    // isolate) it does NOT touch this isolate's in-memory fallback.
    await env.DB.prepare(`DELETE FROM sessions WHERE token = ?`).bind(token).run();

    // 1) During an outage, a FRESH fallback still serves it — the accepted
    //    <= TTL availability window the owner signed off on.
    expect((await getUserBySession(makeDownDbEnv(), token))?.id).toBe(userId);

    // 2) Once the entry ages past the TTL, the outage stops keeping it alive.
    rememberSessionLiveness(
      token,
      warmed,
      Date.now() - SESSION_FALLBACK_TTL_MS - 1,
    );
    await expect(getUserBySession(makeDownDbEnv(), token)).rejects.toThrow(
      /injected DB outage/,
    );

    // 3) The moment the DB is reachable again, the authoritative read rejects
    //    the deleted session regardless of any fallback entry, and forgets it.
    rememberSessionLiveness(token, warmed); // fresh again
    expect(await getUserBySession(env as unknown as Env, token)).toBeNull();
    expect(sessionLivenessFallback(token)).toBeNull();
  });
});
