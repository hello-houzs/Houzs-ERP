// ----------------------------------------------------------------------------
// bridge-2990 — authenticated client for 2990's OWN production API.
//
// D2 (docs/2990-mirror-full-design.md): Houzs never writes 2990's database.
// When Houzs wants something to change over there, it calls 2990's existing
// endpoint and 2990's own logic runs — 2990's RBAC, 2990's validation, 2990's
// effective-dating. This file is the transport for that, and nothing more.
//
// WHY A PASSWORD GRANT AND NOT THE SERVICE-ROLE KEY:
//   2990's supabaseAuth (apps/api/src/middleware/auth.ts) validates the bearer
//   token against GoTrue's /auth/v1/user and sets `c.get('user')` from the
//   response. Every writer then gates on the `staff` table keyed by
//   `c.get('user').id`. The service-role key is not a user — GoTrue returns no
//   user row for it, so `user.id` is undefined and the staff lookup finds
//   nothing. The service-role key does not "bypass" that check; it FAILS it.
//   A real auth user with a real public.staff row is the only thing that works.
//
// The token is cached for the isolate lifetime and refreshed on a 401. The
// cache is keyed by (auth host + email) so rotating a secret cannot serve a
// token minted from the previous config. Note this caches a SERVICE identity,
// not a per-user one — there is no cross-user leak to worry about here, unlike
// a cache of caller tokens. The env object is never mutated (a shared isolate
// mutation is the documented cause of the app-wide 500 in
// project_houzs_foundation_hardening).
// ----------------------------------------------------------------------------

import type { Env } from '../env';

export interface Bridge2990Config {
  apiUrl: string;
  supabaseUrl: string;
  anonKey: string;
  email: string;
  password: string;
}

export type BridgeConfigResult =
  | { ok: true; config: Bridge2990Config }
  | { ok: false; missing: string[] };

/** Read the bridge secrets. Every one is required: a partially-configured
 *  bridge must not half-work. Absent secrets are how this feature ships dark —
 *  with nothing set, the push cannot even authenticate, let alone write. */
export function readBridgeConfig(env: Env): BridgeConfigResult {
  const raw = {
    BRIDGE_2990_API_URL: env.BRIDGE_2990_API_URL,
    BRIDGE_2990_SUPABASE_URL: env.BRIDGE_2990_SUPABASE_URL,
    BRIDGE_2990_SUPABASE_ANON_KEY: env.BRIDGE_2990_SUPABASE_ANON_KEY,
    BRIDGE_2990_EMAIL: env.BRIDGE_2990_EMAIL,
    BRIDGE_2990_PASSWORD: env.BRIDGE_2990_PASSWORD,
  };
  const missing = Object.entries(raw)
    .filter(([, v]) => typeof v !== 'string' || v.trim() === '')
    .map(([k]) => k);
  if (missing.length > 0) return { ok: false, missing };
  return {
    ok: true,
    config: {
      apiUrl: raw.BRIDGE_2990_API_URL!.replace(/\/+$/, ''),
      supabaseUrl: raw.BRIDGE_2990_SUPABASE_URL!.replace(/\/+$/, ''),
      anonKey: raw.BRIDGE_2990_SUPABASE_ANON_KEY!,
      email: raw.BRIDGE_2990_EMAIL!,
      password: raw.BRIDGE_2990_PASSWORD!,
    },
  };
}

interface CachedToken {
  token: string;
  /** Epoch ms. Refreshed early by SKEW_MS so a token cannot expire in flight. */
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();
const SKEW_MS = 60_000;

const cacheKey = (cfg: Bridge2990Config) => `${cfg.supabaseUrl}|${cfg.email}`;

export class Bridge2990Error extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail: unknown;
  constructor(code: string, message: string, status: number, detail?: unknown) {
    super(message);
    this.name = 'Bridge2990Error';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

/** Exchange the bridge credentials for a 2990 Supabase JWT. */
async function mintToken(cfg: Bridge2990Config): Promise<CachedToken> {
  const res = await fetch(`${cfg.supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: cfg.anonKey, 'content-type': 'application/json' },
    body: JSON.stringify({ email: cfg.email, password: cfg.password }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Bridge2990Error(
      'bridge_login_failed',
      "Could not sign in to 2990 with the bridge account. Check that the account exists in 2990 and that BRIDGE_2990_EMAIL / BRIDGE_2990_PASSWORD are correct.",
      502,
      { status: res.status, body: body.slice(0, 500) },
    );
  }
  const json = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
  if (typeof json.access_token !== 'string' || json.access_token === '') {
    throw new Bridge2990Error('bridge_login_no_token', 'The 2990 sign-in returned no access token.', 502);
  }
  // No `?? 3600` here: an unknown expiry is not a one-hour expiry. When 2990
  // does not tell us, treat the token as good for one use window only (expire
  // it immediately after this request) rather than inventing a lifetime.
  const lifetimeMs = typeof json.expires_in === 'number' && json.expires_in > 0 ? json.expires_in * 1000 : 0;
  return { token: json.access_token, expiresAt: lifetimeMs > 0 ? Date.now() + lifetimeMs - SKEW_MS : 0 };
}

async function getToken(cfg: Bridge2990Config, force: boolean): Promise<string> {
  const key = cacheKey(cfg);
  if (!force) {
    const hit = tokenCache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.token;
  }
  const minted = await mintToken(cfg);
  if (minted.expiresAt > Date.now()) tokenCache.set(key, minted);
  else tokenCache.delete(key);
  return minted.token;
}

/** For tests / secret rotation — drop every cached token. */
export function clearBridgeTokenCache(): void {
  tokenCache.clear();
}

export interface BridgeResponse<T> {
  status: number;
  body: T;
}

/**
 * Call 2990's API as the bridge user. Refreshes the token once on a 401 — the
 * cached token may simply have aged out mid-isolate.
 *
 * Returns the parsed body and status; it does NOT throw on a non-2xx from
 * 2990's application layer, because those are decisions (403 forbidden, 409 bad
 * transition) the caller must handle, not transport failures.
 */
export async function bridge2990Fetch<T = unknown>(
  cfg: Bridge2990Config,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<BridgeResponse<T>> {
  const url = `${cfg.apiUrl}${path.startsWith('/') ? path : `/${path}`}`;

  const attempt = async (token: string): Promise<Response> =>
    fetch(url, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        apikey: cfg.anonKey,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });

  let res: Response;
  try {
    res = await attempt(await getToken(cfg, false));
    if (res.status === 401) {
      tokenCache.delete(cacheKey(cfg));
      res = await attempt(await getToken(cfg, true));
    }
  } catch (e) {
    if (e instanceof Bridge2990Error) throw e;
    throw new Bridge2990Error('bridge_unreachable', 'Could not reach 2990. It may be down or the API URL may be wrong.', 502, String(e));
  }

  const text = await res.text();
  let body: unknown = null;
  if (text !== '') {
    try {
      body = JSON.parse(text);
    } catch {
      throw new Bridge2990Error('bridge_bad_response', '2990 returned a response that is not JSON.', 502, {
        status: res.status,
        body: text.slice(0, 500),
      });
    }
  }
  return { status: res.status, body: body as T };
}

// --- the two calls this feature makes ---------------------------------------

export interface Resolved2990Config {
  data: Record<string, unknown> | null;
  effectiveFrom: string | null;
  hasPendingPriceChange?: boolean;
  pendingEffectiveFrom?: string | null;
}

/** GET 2990's currently-effective config for a scope. This is the READ half of
 *  read-modify-write, and it is the ONLY acceptable source for the base blob:
 *  a cached or reconstructed copy would be a guess about live prices. */
export async function fetch2990Resolved(cfg: Bridge2990Config, scope: string): Promise<Resolved2990Config> {
  const res = await bridge2990Fetch<Resolved2990Config & { error?: string; reason?: string }>(
    cfg,
    `/maintenance-config/resolved?scope=${encodeURIComponent(scope)}`,
  );
  if (res.status === 403) {
    throw new Bridge2990Error(
      'bridge_forbidden',
      "2990 refused the bridge account. Its staff row is missing, inactive, or does not have an editor role.",
      403,
      res.body,
    );
  }
  if (res.status !== 200) {
    throw new Bridge2990Error('bridge_read_failed', "Could not read 2990's maintenance config.", 502, res.body);
  }
  return res.body;
}

/** POST a new effective-dated config row to 2990. This is 2990's OWN endpoint —
 *  2990 re-checks the role, stamps its own created_by, and appends its own
 *  history row. We are a caller, not a writer. */
export async function push2990Change(
  cfg: Bridge2990Config,
  input: { scope: string; config: unknown; effectiveFrom: string; notes?: string },
): Promise<{ id: string; effectiveFrom: string }> {
  const res = await bridge2990Fetch<{ id?: string; effectiveFrom?: string; error?: string; reason?: string }>(
    cfg,
    '/maintenance-config/changes',
    { method: 'POST', body: input },
  );
  if (res.status === 403) {
    throw new Bridge2990Error(
      'bridge_forbidden',
      "2990 refused the change. The bridge account's staff row is missing, inactive, or does not have an editor role (admin, super_admin, coordinator or sales_director).",
      403,
      res.body,
    );
  }
  if (res.status !== 201 || typeof res.body?.id !== 'string') {
    throw new Bridge2990Error('bridge_write_failed', 'The change was not accepted by 2990.', 502, res.body);
  }
  // Echo-or-ours: 2990 validated and stored effectiveFrom, so falling back to
  // what we sent is a statement of fact, not a guess.
  const stored = typeof res.body.effectiveFrom === 'string' ? res.body.effectiveFrom : input.effectiveFrom;
  return { id: res.body.id, effectiveFrom: stored };
}
