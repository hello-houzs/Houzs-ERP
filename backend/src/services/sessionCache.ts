import type { Env } from "../types";
import type { AuthUser } from "./auth";

// KV-backed cache for the hydrated session user. Every authenticated request
// currently runs a 3-table JOIN (sessions+users+roles) + a page-access load +
// (for scoped users) a brands query. Caching the assembled AuthUser per session
// token removes those round-trips on the hot path — the single biggest latency
// win available (pattern from Hookka's rbac KV cache).
//
// Safety: this is a pure optimization layer. Every op is wrapped so any KV
// miss/error/absence falls straight through to the DB path — worst case is
// today's behaviour. The binding is OPTIONAL, so the vitest suite (no KV bound)
// exercises the fallback and must stay green.
//
// Freshness: 60s TTL. A role/permission edit or a disable takes effect within
// 60s without explicit busting; logout busts immediately (deleteSession). The
// cached points/streak fields can be up to 60s stale — acceptable (display-only;
// the notifications poll carries the live balance).

const TTL_SECONDS = 60;
const keyFor = (token: string) => `sess:${token}`;

export async function getCachedUser(env: Env, token: string): Promise<AuthUser | null> {
  if (!env.SESSION_CACHE) return null;
  try {
    const raw = await env.SESSION_CACHE.get(keyFor(token));
    if (!raw) return null;
    const u = JSON.parse(raw) as AuthUser;
    // Set does not survive JSON — rebuild the O(1) permission lookup mirror.
    u.permissions_set = new Set(u.permissions ?? []);
    return u;
  } catch {
    return null; // any cache trouble → caller falls back to the DB
  }
}

export async function setCachedUser(env: Env, token: string, user: AuthUser): Promise<void> {
  if (!env.SESSION_CACHE) return;
  try {
    await env.SESSION_CACHE.put(keyFor(token), JSON.stringify(user), {
      expirationTtl: TTL_SECONDS,
    });
  } catch {
    /* non-fatal: next request just re-reads from the DB */
  }
}

export async function bustCachedUser(env: Env, token: string): Promise<void> {
  if (!env.SESSION_CACHE) return;
  try {
    await env.SESSION_CACHE.delete(keyFor(token));
  } catch {
    /* non-fatal */
  }
}

// Bust the cached user for EVERY live session of a user. Disable / password
// reset / role change delete session ROWS in bulk (DELETE ... WHERE user_id=?)
// but bypass deleteSession(), so the per-token `sess:<token>` cache entries
// survived up to the 60s TTL — a disabled user kept working for a minute. Call
// this BEFORE the bulk delete (it reads the live tokens), then bust each key.
// `exceptToken` keeps the caller's own session cached (self password-change
// revokes only the others). Best-effort: any DB/KV trouble just falls back to
// the 60s TTL expiry.
export async function bustUserSessions(env: Env, userId: number, exceptToken?: string): Promise<void> {
  if (!env.SESSION_CACHE) return;
  try {
    const rows = await env.DB.prepare(`SELECT token FROM sessions WHERE user_id = ?`)
      .bind(userId)
      .all<{ token: string }>();
    for (const r of rows.results ?? []) {
      if (exceptToken && r.token === exceptToken) continue;
      await env.SESSION_CACHE.delete(keyFor(r.token));
    }
  } catch {
    /* non-fatal */
  }
}
