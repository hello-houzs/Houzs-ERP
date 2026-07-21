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
// Freshness: 60s TTL for the hydrated permission/page/brand envelope and
// display-only fields. Session validity plus every DB value that shapes authz
// (user/mail identity, role permissions/scope, page rows, position/department
// identity, the user+manager brand sets, and the code policy revision) is
// fingerprinted authoritatively on every request.
// A mismatch rehydrates immediately, so KV invalidation is only an efficiency
// aid and can never extend revoked access.

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
// would otherwise survive until TTL. Call this BEFORE the bulk delete (it reads
// the live tokens), then bust each key to avoid retaining useless KV entries.
// `exceptToken` keeps the caller's own session cached (self password-change
// revokes only the others). Best-effort: an invalidation failure affects cache
// efficiency only; getUserBySession still rejects deleted/disabled sessions via
// its authoritative D1 gate.
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

// ── Bounded liveness fallback (owner-directed 2026-07-21) ──────────────────
// This Houzs DB layer has recurring brief blips (cold-start 503, Supavisor
// pooler hiccups). getUserBySession validates EVERY request against the DB, so
// a blip made the authoritative read throw and logged the whole company out
// until it cleared — pure fail-closed. Owner's decision, for this invite-only
// ERP of a few dozen users: trade a BOUNDED (<= TTL) revocation delay for
// availability. On a DB-read FAILURE during session validation we may re-serve
// the LAST result the DB authoritatively confirmed "active" for this token, but
// ONLY while that result is younger than SESSION_FALLBACK_TTL_MS; otherwise we
// still fail closed.
//
// Why a per-isolate in-memory Map — not KV, and not the SESSION_CACHE envelope:
//   - It must help precisely WHEN THE DB IS UNREACHABLE, so it must add no new
//     awaited round-trip on the failure path — a Map read is synchronous.
//   - The rule is "younger than TTL since the last SUCCESSFUL read". Only a
//     per-read timestamp expresses that. KV's expirationTtl is stamped at WRITE
//     time, and the SESSION_CACHE envelope is NOT rewritten on the fast path
//     (cache-hit + fingerprint match), so neither one's age tracks liveness.
//   - It is written ONLY after an authoritative read confirmed the session is
//     live, so its size is bounded by the count of active sessions (dozens) and
//     an unknown/invalid token can never populate it.
// It is a pure availability aid: it can only ever re-serve a session the DB most
// recently CONFIRMED active, and only inside the TTL window. Every authoritative
// revocation forgets the entry (see getUserBySession + deleteSession), so once
// the DB is reachable again a revoked session is rejected immediately — the
// delay is capped at the TTL and only occurs while the DB stays down.

export const SESSION_FALLBACK_TTL_MS = 60_000;

interface SessionLivenessEntry {
  user: AuthUser;
  ts: number;
}

const sessionLiveness = new Map<string, SessionLivenessEntry>();

/** Record a session an authoritative DB read just confirmed active. `now` is
 *  injectable for deterministic tests; production always uses the real clock. */
export function rememberSessionLiveness(
  token: string,
  user: AuthUser,
  now: number = Date.now(),
): void {
  sessionLiveness.set(token, { user, ts: now });
}

/** Drop a session the DB authoritatively reported gone / disabled / expired, so
 *  a later DB blip can never re-serve it from the fallback. */
export function forgetSessionLiveness(token: string): void {
  sessionLiveness.delete(token);
}

/** Consulted ONLY when the authoritative session read FAILED (DB unreachable).
 *  Returns the last DB-confirmed AuthUser iff it is younger than the TTL; a
 *  stale entry is evicted and null returned so the caller fails closed. */
export function sessionLivenessFallback(
  token: string,
  now: number = Date.now(),
): AuthUser | null {
  const entry = sessionLiveness.get(token);
  if (!entry) return null;
  if (now - entry.ts >= SESSION_FALLBACK_TTL_MS) {
    sessionLiveness.delete(token);
    return null;
  }
  return entry.user;
}

/** Test-only: clear the per-isolate fallback map for isolation between cases. */
export function __resetSessionLivenessForTest(): void {
  sessionLiveness.clear();
}
