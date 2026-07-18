// ─────────────────────────────────────────────────────────────────────────
// apns.ts — the Apple Push Notification service send path.
//
// ── WHY THIS IS HAND-ROLLED AND NOT A LIBRARY ──
// Every mainstream node APNs client (node-apn, apn, @parse/node-apn) is built
// on node:http2, which the Workers runtime does not expose. There is no drop-in
// to install. What APNs actually requires of a caller is small enough to write:
// an HTTP/2 POST to api.push.apple.com carrying a bearer JWT signed ES256 with
// the team's .p8 auth key. Both halves are reachable from a Worker —
//   * the JWT: WebCrypto does ECDSA P-256 / SHA-256, and its signature output
//     is already the raw r||s pair JWS ES256 wants (no DER unwrapping, which is
//     the part that usually forces a library),
//   * the HTTP/2: a deployed Worker's outbound fetch negotiates HTTP/2 with the
//     origin. APNs closes HTTP/1.1 connections immediately, so this is the load-
//     bearing fact, and it is environment-dependent — see the warning below.
//
// ── THIS DOES NOT WORK UNDER `wrangler dev` ──
// workerd's local outbound fetch is HTTP/1.1 only (cloudflare/workerd#5266,
// and #4841 is this exact symptom: APNs fetch fails locally, same code succeeds
// deployed). So a local send fails with a protocol/connection error that says
// nothing about your credentials. Verify against a deployed Worker — staging —
// and treat a local failure as no evidence either way.
//
// ── FAIL-SOFT ──
// Nothing here throws at its caller. A push is a courtesy on top of the poll
// that already works; a dead APNs key must never fail the business operation
// that triggered the notification. Every entry point returns a result object.
// ─────────────────────────────────────────────────────────────────────────

import type { Env } from "../types";
import { getDb } from "../db/client";
import { push_device_tokens } from "../db/pushSchema";
import { and, eq, isNull, inArray } from "drizzle-orm";

/**
 * APNs credentials. Kept as its own optional-property interface rather than
 * added to Env: types.ts is edited by other work in flight, and every caller
 * passes a plain Env, which stays assignable because all of these are optional.
 *
 * Set with `wrangler secret put`. APNS_PRIVATE_KEY is the FULL contents of the
 * AuthKey_XXXXXXXXXX.p8 file including the BEGIN/END lines.
 */
export interface ApnsConfigEnv {
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_BUNDLE_ID?: string;
  APNS_PRIVATE_KEY?: string;
  /** "production" (default) or "sandbox" for development builds. */
  APNS_ENV?: string;
}

export type ApnsEnv = Env & Partial<ApnsConfigEnv>;

export interface PushMessage {
  title: string;
  body: string;
  /** Springboard badge. Omit to leave the badge untouched. */
  badge?: number;
  /**
   * Custom payload delivered alongside `aps`. This is what the app reads to
   * open the right record on tap — keep it in step with PushDeepLink in
   * frontend/src/lib/nativePush.ts.
   */
  data?: { kind?: string; id?: string | number } & Record<string, unknown>;
  /**
   * APNs coalesces same-id notifications into one banner. Used so a burst of
   * activity on one project does not produce a stack of banners.
   */
  collapseId?: string;
}

export interface PushSendResult {
  sent: number;
  failed: number;
  /** Tokens APNs reported as gone; already stamped disabled_at. */
  retired: number;
  /** Set when nothing was attempted, e.g. "apns_not_configured". */
  skipped?: string;
}

const PRODUCTION_HOST = "https://api.push.apple.com";
const SANDBOX_HOST = "https://api.sandbox.push.apple.com";

// Apple rejects a provider token minted more than an hour ago, and rejects
// refreshing more often than every 20 minutes (TooManyProviderTokenUpdates).
// 50 minutes sits inside both bounds with room for clock skew.
const JWT_TTL_MS = 50 * 60 * 1000;

// Per-isolate cache. A Worker isolate serves many requests, so this turns the
// ECDSA sign into a once-per-isolate-hour cost rather than a per-push one.
// Keyed by kid+iss so a credential rotation cannot serve a stale token.
let cachedJwt: { key: string; token: string; expiresAt: number } | null = null;

export function isApnsConfigured(env: ApnsEnv): boolean {
  return Boolean(
    env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_BUNDLE_ID && env.APNS_PRIVATE_KEY,
  );
}

function base64UrlFromBytes(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlFromString(s: string): string {
  return base64UrlFromBytes(new TextEncoder().encode(s));
}

/**
 * Import the .p8 auth key. The file is a PKCS#8 PEM; strip the armour and the
 * newlines (secrets pasted through a shell often arrive with literal "\n") and
 * hand the DER to WebCrypto.
 */
async function importAuthKey(pem: string): Promise<CryptoKey> {
  const der = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\\n/g, "")
    .replace(/\s+/g, "");
  const raw = Uint8Array.from(atob(der), (ch) => ch.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    raw.buffer as ArrayBuffer,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

async function getProviderToken(env: ApnsEnv): Promise<string> {
  const cacheKey = `${env.APNS_KEY_ID}:${env.APNS_TEAM_ID}`;
  const now = Date.now();
  if (cachedJwt && cachedJwt.key === cacheKey && cachedJwt.expiresAt > now) {
    return cachedJwt.token;
  }

  const header = base64UrlFromString(
    JSON.stringify({ alg: "ES256", kid: env.APNS_KEY_ID }),
  );
  const payload = base64UrlFromString(
    JSON.stringify({ iss: env.APNS_TEAM_ID, iat: Math.floor(now / 1000) }),
  );
  const signingInput = `${header}.${payload}`;

  const key = await importAuthKey(env.APNS_PRIVATE_KEY as string);
  // WebCrypto returns the raw 64-byte r||s concatenation, which is exactly the
  // JWS ES256 encoding. A node crypto.sign() here would emit DER and need
  // unwrapping first; this does not.
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput),
  );

  const token = `${signingInput}.${base64UrlFromBytes(new Uint8Array(sig))}`;
  cachedJwt = { key: cacheKey, token, expiresAt: now + JWT_TTL_MS };
  return token;
}

/** APNs statuses that mean the token is dead and must stop being used. */
function isRetirableFailure(status: number, reason: string): boolean {
  if (status === 410) return true; // Unregistered — app removed from the device
  return status === 400 && (reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic");
}

/**
 * Send to ONE device token. Exposed for the diagnostic route; ordinary callers
 * want sendPushToUsers, which resolves tokens itself.
 */
export async function sendToToken(
  env: ApnsEnv,
  token: string,
  msg: PushMessage,
  opts?: { bundleId?: string; apnsEnv?: string },
): Promise<{ ok: boolean; status: number; reason: string }> {
  const host = (opts?.apnsEnv ?? env.APNS_ENV) === "sandbox" ? SANDBOX_HOST : PRODUCTION_HOST;
  const jwt = await getProviderToken(env);

  const payload: Record<string, unknown> = {
    aps: {
      alert: { title: msg.title, body: msg.body },
      sound: "default",
      ...(typeof msg.badge === "number" ? { badge: msg.badge } : {}),
    },
    ...(msg.data ?? {}),
  };

  const headers: Record<string, string> = {
    authorization: `bearer ${jwt}`,
    "apns-topic": opts?.bundleId ?? (env.APNS_BUNDLE_ID as string),
    "apns-push-type": "alert",
    "apns-priority": "10",
    // A notification about activity is worthless a day later; let APNs drop it
    // rather than wake the device with stale news.
    "apns-expiration": String(Math.floor(Date.now() / 1000) + 6 * 60 * 60),
    "content-type": "application/json",
    ...(msg.collapseId ? { "apns-collapse-id": msg.collapseId.slice(0, 64) } : {}),
  };

  try {
    const res = await fetch(`${host}/3/device/${token}`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (res.status === 200) return { ok: true, status: 200, reason: "" };
    let reason = "";
    try {
      reason = ((await res.json()) as { reason?: string }).reason ?? "";
    } catch {
      // APNs answers JSON on every error it authors; a non-JSON body means the
      // failure came from somewhere else (proxy, TLS) and there is no reason
      // code to record.
    }
    return { ok: false, status: res.status, reason };
  } catch (err) {
    // Reaches here on a transport failure. Under `wrangler dev` that is the
    // HTTP/1.1 limitation above, not a credential problem.
    return { ok: false, status: 0, reason: String(err) };
  }
}

/**
 * Send to every live device belonging to `userIds`.
 *
 * The one call the rest of the backend should use. Never throws; a caller that
 * wants to know may read the result, and a caller that does not may ignore it.
 */
export async function sendPushToUsers(
  env: ApnsEnv,
  userIds: number[],
  msg: PushMessage,
): Promise<PushSendResult> {
  const empty: PushSendResult = { sent: 0, failed: 0, retired: 0 };
  const ids = Array.from(new Set(userIds.filter((n) => Number.isFinite(n) && n > 0)));
  if (ids.length === 0) return { ...empty, skipped: "no_recipients" };
  if (!isApnsConfigured(env)) return { ...empty, skipped: "apns_not_configured" };

  try {
    const db = getDb(env);
    const rows = await db
      .select({
        token: push_device_tokens.token,
        bundle_id: push_device_tokens.bundle_id,
        apns_env: push_device_tokens.apns_env,
      })
      .from(push_device_tokens)
      .where(
        and(
          inArray(push_device_tokens.user_id, ids),
          isNull(push_device_tokens.disabled_at),
        ),
      );
    if (rows.length === 0) return { ...empty, skipped: "no_devices" };

    const results = await Promise.all(
      rows.map(async (r) => ({
        row: r,
        res: await sendToToken(env, r.token, msg, {
          bundleId: r.bundle_id ?? undefined,
          apnsEnv: r.apns_env ?? undefined,
        }),
      })),
    );

    const dead = results
      .filter((x) => !x.res.ok && isRetirableFailure(x.res.status, x.res.reason))
      .map((x) => x.row.token);

    if (dead.length > 0) {
      const nowText = new Date().toISOString().replace("T", " ").slice(0, 19);
      await db
        .update(push_device_tokens)
        .set({ disabled_at: nowText, updated_at: nowText })
        .where(inArray(push_device_tokens.token, dead));
    }

    return {
      sent: results.filter((x) => x.res.ok).length,
      failed: results.filter((x) => !x.res.ok).length,
      retired: dead.length,
    };
  } catch (err) {
    console.error("[apns] send failed", err);
    return { ...empty, skipped: "error" };
  }
}

/** Convenience wrapper for the single-recipient case. */
export function sendPushToUser(
  env: ApnsEnv,
  userId: number,
  msg: PushMessage,
): Promise<PushSendResult> {
  return sendPushToUsers(env, [userId], msg);
}

/** Retire one token without an APNs round-trip (used by explicit sign-out). */
export async function retireToken(env: Env, token: string): Promise<void> {
  try {
    const db = getDb(env);
    await db.delete(push_device_tokens).where(eq(push_device_tokens.token, token));
  } catch (err) {
    console.error("[apns] retire failed", err);
  }
}
