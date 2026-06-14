import type { Env } from "../types";
import { parsePermissions } from "./permissions";
import {
  loadPageAccessForRole,
  loadPageAccessForPosition,
  fullAccessMap,
  type AccessLevel,
} from "./pageAccess";
import { getCachedUser, setCachedUser, bustCachedUser } from "./sessionCache";

// ── Crypto helpers ────────────────────────────────────────
// PBKDF2 via Web Crypto — built into Workers, no WASM needed.

const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_HASH = "SHA-256";
const KEY_BITS = 256;

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function b64ToBytes(b64: string): Uint8Array {
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: PBKDF2_HASH },
    key,
    KEY_BITS
  );
  return `${bytesToB64(salt)}$${bytesToB64(new Uint8Array(bits))}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (!stored || !stored.includes("$")) return false;
  const [saltB64, hashB64] = stored.split("$");
  if (!saltB64 || !hashB64) return false;
  const salt = b64ToBytes(saltB64);
  const expected = b64ToBytes(hashB64);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: PBKDF2_HASH },
    key,
    KEY_BITS
  );
  const got = new Uint8Array(bits);
  if (got.length !== expected.length) return false;
  // constant-time compare
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ expected[i];
  return diff === 0;
}

// ── Token helpers ────────────────────────────────────────
// 32 random bytes → URL-safe base64. Used for both session and
// invitation tokens.
export function generateToken(bytes = 32): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return bytesToB64(buf).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function isoIn(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

// ── Session helpers ──────────────────────────────────────
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

export interface AuthUser {
  id: number;
  email: string;
  name: string | null;
  role_id: number;
  role_name: string;
  /** Position = department×position org unit (mig 094). When set, page_access
   *  is hydrated from the 4-level position_page_access matrix; when null, the
   *  user falls back to the legacy role matrix during the transition. */
  position_id: number | null;
  position_name: string | null;
  status: string;
  permissions: string[];
  /** O(1) lookup mirror of `permissions`. Hydrated once at session
   *  load so every `requirePermission` middleware call is a Set hit
   *  instead of a linear array scan. */
  permissions_set: Set<string>;
  /** Who this user reports to. Drives project-level ACL when scope_to_pic=1. */
  manager_id: number | null;
  /** Role flag — if true, project endpoints filter to pic_id IN (self, manager). */
  scope_to_pic: boolean;
  /** Department membership — drives the brand allow-list below. */
  department_id: number | null;
  /**
   * Brand allow-list for scoped users — null when the role isn't
   * scope_to_pic (admins, ops, finance). Empty array when the user is
   * scoped but their department has no brands assigned — that user
   * sees no projects until an admin configures the dept.
   */
  brand_scope: string[] | null;
  /**
   * Per-page access map. Hydrated from `role_page_access` (mig 073) +
   * fallback to `computeBackfillLevel` for any page without an explicit
   * row. Drives the `requirePageAccess` middleware on gated routes and
   * the frontend `usePageAccess` hook. Phase 1 wires Sales only; other
   * pages migrate in follow-up slices.
   */
  page_access: Record<string, AccessLevel>;
  joined_at?: string | null;
  last_login_at?: string | null;
  // Houzs Points (mig 055) — small per-user counters.
  points_balance?: number;
  gifting_balance?: number;
  current_streak?: number;
  // Profile picture (mig 058) — R2 key inside POD_BUCKET.
  profile_pic_r2_key?: string | null;
}

export async function createSession(env: Env, userId: number): Promise<string> {
  const token = generateToken();
  const expires = isoIn(SESSION_TTL_SECONDS);
  await env.DB.prepare(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`
  )
    .bind(token, userId, expires)
    .run();
  return token;
}

export async function deleteSession(env: Env, token: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM sessions WHERE token = ?`).bind(token).run();
  // Bust the cached user immediately so logout / forced-expiry takes effect now
  // rather than waiting out the 60s TTL.
  await bustCachedUser(env, token);
}

// Builds the AuthUser shape from the row returned by the SELECT below
// + a follow-up brand fetch when the user is scoped.
//
// Brand allow-list is per-person via user_brands (mig 049). Effective
// scope is the UNION of the user's own brands plus their direct
// manager's brands — the same one-hop rule used for pic_ids. This
// lets a Sales Director set brands once at their level and have their
// reps inherit visibility automatically; a rep can still hold extra
// brands directly if they specialise outside the manager's coverage.
async function hydrateAuthUser(env: Env, row: any): Promise<AuthUser> {
  const scoped = !!row.scope_to_pic;
  const managerId: number | null = row.manager_id ?? null;
  let brandScope: string[] | null = null;
  if (scoped) {
    const ids = managerId ? [row.id, managerId] : [row.id];
    // env.DB (not getDb): auth must keep working on the D1 fallback used by
    // the test suite and the rollback path, where no DATABASE_URL is bound.
    // DISTINCT dedups brands listed on both the rep and the manager.
    const placeholders = ids.map(() => "?").join(", ");
    const res = await env.DB.prepare(
      `SELECT DISTINCT brand FROM user_brands WHERE user_id IN (${placeholders})`
    )
      .bind(...ids)
      .all<{ brand: string }>();
    brandScope = (res.results ?? []).map((r) => r.brand);
  }
  const permissions = parsePermissions(row.role_permissions);
  const permissionsSet = new Set(permissions);
  // Wildcard role → full everything. Else the 4-level position matrix when the
  // user has a position; else the legacy role matrix (fallback for users not
  // yet assigned a position during the rollout).
  const pageAccess = permissionsSet.has("*")
    ? fullAccessMap()
    : row.position_id != null
      ? await loadPageAccessForPosition(env, row.position_id)
      : await loadPageAccessForRole(env, row.role_id, permissionsSet);
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role_id: row.role_id,
    role_name: row.role_name,
    position_id: row.position_id ?? null,
    position_name: row.position_name ?? null,
    status: row.status,
    permissions,
    permissions_set: permissionsSet,
    manager_id: managerId,
    scope_to_pic: scoped,
    department_id: row.department_id ?? null,
    brand_scope: brandScope,
    page_access: pageAccess,
    joined_at: row.joined_at ?? null,
    last_login_at: row.last_login_at ?? null,
    points_balance: row.points_balance ?? 0,
    gifting_balance: row.gifting_balance ?? 0,
    current_streak: row.current_streak ?? 0,
    profile_pic_r2_key: row.profile_pic_r2_key ?? null,
  };
}

export async function getUserBySession(env: Env, token: string): Promise<AuthUser | null> {
  // Fast path: KV-cached hydrated user (60s). Falls through to the DB on any
  // miss/error — see sessionCache.ts. No-op when SESSION_CACHE is unbound.
  const cached = await getCachedUser(env, token);
  if (cached) return cached;

  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.role_id, u.status,
            u.manager_id, u.department_id, u.position_id, u.joined_at, u.last_login_at,
            u.points_balance, u.gifting_balance, u.current_streak,
            u.profile_pic_r2_key,
            r.name as role_name, r.permissions as role_permissions,
            r.scope_to_pic,
            p.name as position_name,
            s.expires_at
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     JOIN roles r ON r.id = u.role_id
     LEFT JOIN positions p ON p.id = u.position_id
     WHERE s.token = ?`
  )
    .bind(token)
    .first<any>();

  if (!row) return null;
  if (row.status !== "active") return null;
  if (row.expires_at && row.expires_at < new Date().toISOString()) {
    // expired — clean up
    await deleteSession(env, token);
    return null;
  }

  const user = await hydrateAuthUser(env, row);
  await setCachedUser(env, token, user);
  return user;
}

export async function getUserById(env: Env, id: number): Promise<AuthUser | null> {
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.role_id, u.status, u.manager_id,
            u.department_id, u.position_id,
            u.points_balance, u.gifting_balance, u.current_streak,
            u.profile_pic_r2_key,
            r.name as role_name, r.permissions as role_permissions,
            r.scope_to_pic,
            p.name as position_name
     FROM users u
     JOIN roles r ON r.id = u.role_id
     LEFT JOIN positions p ON p.id = u.position_id
     WHERE u.id = ?`
  )
    .bind(id)
    .first<any>();
  if (!row) return null;
  return hydrateAuthUser(env, row);
}

/**
 * Sweep expired sessions opportunistically. Cheap; called from /me.
 */
export async function pruneExpiredSessions(env: Env): Promise<void> {
  await env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ?`)
    .bind(new Date().toISOString())
    .run();
}
