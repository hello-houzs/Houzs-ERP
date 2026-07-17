import type { Env } from "../types";
import { parsePermissions } from "./permissions";
import {
  loadPageAccessForRole,
  loadPageAccessForPosition,
  fullAccessMap,
  type AccessLevel,
  type PageAccessMeta,
} from "./pageAccess";
import { getCachedUser, setCachedUser, bustCachedUser } from "./sessionCache";
import { isScopedProjectUser } from "./projectAcl";
import { applySalesJdOverride } from "./salesJdAccess";
import { shadowComparePositionAccess } from "./positionAccessShadow";

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

/**
 * Constant-time string equality for shared-secret comparison (webhook
 * keys etc.). XOR-folds every byte so the comparison cost doesn't leak
 * how many leading characters matched. Length mismatch still returns
 * early — the secret lengths aren't sensitive here.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
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

/* Session ORIGIN (mig 0120) — the DOOR a session was minted at. It is NOT a
   property of the person: the same salesperson simultaneously holds a 'pos'
   session on the showroom tablet and an origin-less one on their own phone,
   both for the SAME public.users row. That is precisely why the POS pricing
   envelope (scm/routes/mfg-sales-orders.ts isPosTabletCaller) cannot be
   derived from the user, their position, or their scm.staff role — only from
   the session.

   WHY IT IS UNFORGEABLE: the value is chosen server-side by whichever route
   calls createSession, and stored on the session row. It never appears in a
   request, so a caller can no more assert its origin than it can assert its
   own user_id. Holding a 'pos' session requires passing the PIN gate at
   /api/pos/pin-login; a client cannot opt OUT of one either, because omitting
   something it never sent changes nothing. This is the property the
   self-asserted `X-Client` header it replaced never had.

   `undefined` (every non-POS door) stores NULL, which reads as not-POS — the
   pre-migration behaviour, and the safe direction. Keep this a closed union:
   a new origin must be a deliberate edit here, not a string a route invents. */
export type SessionOrigin = "pos";
export const SESSION_ORIGIN_POS: SessionOrigin = "pos";

export interface AuthUser {
  id: number;
  email: string;
  name: string | null;
  /** The member's outward Mail Center alias (users.email_alias, mig 0039). Lets
   *  the member compose/reply FROM their own address in the Mail Center. null
   *  when none assigned. */
  email_alias?: string | null;
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
  /** Department NAME (departments.name via u.department_id). STABLE ORG FIELD
   *  used by the code-keyed Sales access model (see services/pmsAccess.ts
   *  isSalesUser) — matched case-insensitively on "sales" because prod names
   *  the dept "Sales Department" while the seed is "Sales" (same rule as
   *  salesTeam.syncSalesRepFromUser). Hydrated once per session alongside
   *  position_name; null when the user has no department assigned. Optional so
   *  hand-built AuthUser literals (tests, SERVICE_USER) don't need to set it. */
  department_name?: string | null;
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
  /**
   * True iff this user has AT LEAST ONE explicit `scm*` page-access row in
   * the SAME matrix that hydrated `page_access` (position_page_access when
   * the user has a position, else role_page_access). Drives the SAFE L2 SCM
   * write-gate rollout: a user with NO explicit SCM config is NOT enforced
   * by `scmAreaGuard` and falls back to the coarse `scm.access` umbrella
   * (allow), so no current SCM user is locked out before the matrix is
   * configured. Only users WITH explicit SCM rows get per-area enforcement.
   * Owner (`*`) bypasses the guard entirely, so this stays false for them.
   */
  scm_l2_configured: boolean;
  /**
   * Origin of the SESSION this user was loaded from — 'pos' or null (mig
   * 0120, see SessionOrigin above). It rides AuthUser ONLY because AuthUser is
   * what the per-token KV cache serialises; the cache is keyed by token, so
   * this is cached at exactly the right granularity and never bleeds between a
   * person's devices. It is NOT a fact about the user.
   *
   * DO NOT read this field to gate anything: inside /api/scm/* the SCM auth
   * bridge overwrites `user` wholesale with a pinned system staff row, so it
   * is not even reachable there. Read the `sessionOrigin` context var that
   * middleware/auth republishes — that is the one channel the bridge leaves
   * alone.
   *
   * Null on any AuthUser not built from a session row (getUserById, the
   * SERVICE_USER literal) and on any session cached by a pre-0120 isolate —
   * all of which read as not-POS, the safe direction. Optional so hand-built
   * AuthUser literals don't need to set it.
   */
  session_origin?: string | null;
  joined_at?: string | null;
  last_login_at?: string | null;
  // Houzs Points (mig 055) — small per-user counters.
  points_balance?: number;
  gifting_balance?: number;
  current_streak?: number;
  // Profile picture (mig 058) — R2 key inside POD_BUCKET.
  profile_pic_r2_key?: string | null;
}

/** Mint a session. `origin` defaults to undefined -> NULL = an ordinary
 *  office/desktop session that may price freely. Pass SESSION_ORIGIN_POS ONLY
 *  from the POS PIN door; see the SessionOrigin note above. */
export async function createSession(
  env: Env,
  userId: number,
  origin?: SessionOrigin,
): Promise<string> {
  const token = generateToken();
  const expires = isoIn(SESSION_TTL_SECONDS);
  await env.DB.prepare(
    `INSERT INTO sessions (token, user_id, expires_at, origin) VALUES (?, ?, ?, ?)`
  )
    .bind(token, userId, expires, origin ?? null)
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
  const permissions = parsePermissions(row.role_permissions);
  const permissionsSet = new Set(permissions);
  // Owner 2026-07-15 — hydrate the brand allow-list not only for `scope_to_pic`
  // roles but for the whole code-keyed project-scoped cohort (isScopedProjectUser
  // = scope_to_pic OR a non-director Sales user). Some Sales positions lack the
  // scope_to_pic flag; without brands the project list's PIC arm can't match and
  // they'd fall back to attendee-only. Classify off the STABLE ORG FIELDS
  // already on `row` (position_name / department_name) + the parsed permissions.
  const brandScoped = isScopedProjectUser({
    scope_to_pic: scoped,
    permissions_set: permissionsSet,
    position_name: row.position_name ?? null,
    department_name: row.department_name ?? null,
  } as AuthUser);
  let brandScope: string[] | null = null;
  if (brandScoped) {
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
  // Wildcard role → full everything. Else the 4-level position matrix when the
  // user has a position; else the legacy role matrix (fallback for users not
  // yet assigned a position during the rollout).
  //
  // `scmMeta.explicitScm` is filled in-place by whichever loader runs, from the
  // SAME source that produces page_access — so the L2 SCM write-gate enforces
  // ONLY users who have an explicit scm* row in that exact matrix. Owner (`*`)
  // skips the loaders (fullAccessMap) and the guard bypasses them anyway, so it
  // stays false there.
  const scmMeta: PageAccessMeta = { explicitScm: false };
  const pageAccess = permissionsSet.has("*")
    ? fullAccessMap()
    : row.position_id != null
      ? await loadPageAccessForPosition(env, row.position_id, scmMeta)
      : await loadPageAccessForRole(env, row.role_id, permissionsSet, scmMeta);

  // SHADOW ONLY — reads a second opinion, serves neither. `pageAccess` above is
  // and stays the table's answer; this reports where positionAccessSnapshot
  // would have disagreed, so the cutover can be decided on prod evidence instead
  // of a promise (positionAccessShadow.ts explains why that evidence cannot come
  // from staging). Deliberately NOT applied to the `*` branch: the wildcard
  // never touches the position matrix, so there is nothing to compare, and
  // asking would only invite narrowing fullAccessMap().
  //
  // try/catch because this is the login path and a shadow that can break
  // authentication is worse than no shadow at all.
  if (!permissionsSet.has("*") && row.position_id != null) {
    try {
      shadowComparePositionAccess(env, row.position_id, pageAccess, scmMeta);
    } catch (e) {
      console.warn(
        JSON.stringify({
          evt: "position_access_shadow",
          result: "error",
          position_id: row.position_id,
          message: String((e as Error)?.message ?? e),
        }),
      );
    }
  }

  return {
    id: row.id,
    email: row.email,
    email_alias: row.email_alias ?? null,
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
    department_name: row.department_name ?? null,
    brand_scope: brandScope,
    page_access: applySalesJdOverride(pageAccess, {
      permissions: permissionsSet,
      position_name: row.position_name ?? null,
      department_name: row.department_name ?? null,
    }),
    scm_l2_configured: scmMeta.explicitScm,
    // sessions.origin — present only on the getUserBySession row (that SELECT
    // already joins `sessions`, so this costs no extra round-trip). getUserById
    // has no session, so `row.origin` is absent there and this lands null =
    // not-POS.
    session_origin: row.origin ?? null,
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
    `SELECT u.id, u.email, u.email_alias, u.name, u.role_id, u.status,
            u.manager_id, u.department_id, u.position_id, u.joined_at, u.last_login_at,
            u.points_balance, u.gifting_balance, u.current_streak,
            u.profile_pic_r2_key,
            r.name as role_name, r.permissions as role_permissions,
            r.scope_to_pic,
            p.name as position_name,
            d.name as department_name,
            s.expires_at, s.origin
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     JOIN roles r ON r.id = u.role_id
     LEFT JOIN positions p ON p.id = u.position_id
     LEFT JOIN departments d ON d.id = u.department_id
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
    `SELECT u.id, u.email, u.email_alias, u.name, u.role_id, u.status, u.manager_id,
            u.department_id, u.position_id,
            u.points_balance, u.gifting_balance, u.current_streak,
            u.profile_pic_r2_key,
            r.name as role_name, r.permissions as role_permissions,
            r.scope_to_pic,
            p.name as position_name,
            d.name as department_name
     FROM users u
     JOIN roles r ON r.id = u.role_id
     LEFT JOIN positions p ON p.id = u.position_id
     LEFT JOIN departments d ON d.id = u.department_id
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
