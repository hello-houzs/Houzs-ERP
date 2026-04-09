import type { Env } from "../types";
import { parsePermissions } from "./permissions";

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
  status: string;
  permissions: string[];
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
}

export async function getUserBySession(env: Env, token: string): Promise<AuthUser | null> {
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.role_id, u.status,
            r.name as role_name, r.permissions as role_permissions,
            s.expires_at
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     JOIN roles r ON r.id = u.role_id
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

  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role_id: row.role_id,
    role_name: row.role_name,
    status: row.status,
    permissions: parsePermissions(row.role_permissions),
  };
}

export async function getUserById(env: Env, id: number): Promise<AuthUser | null> {
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.role_id, u.status,
            r.name as role_name, r.permissions as role_permissions
     FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE u.id = ?`
  )
    .bind(id)
    .first<any>();
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role_id: row.role_id,
    role_name: row.role_name,
    status: row.status,
    permissions: parsePermissions(row.role_permissions),
  };
}

/**
 * Sweep expired sessions opportunistically. Cheap; called from /me.
 */
export async function pruneExpiredSessions(env: Env): Promise<void> {
  await env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ?`)
    .bind(new Date().toISOString())
    .run();
}
