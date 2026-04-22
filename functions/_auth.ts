// Shared auth utilities for Cloudflare Pages Functions.
// All crypto uses the Web Crypto API (built into Workers) — no npm deps.
//
//   • hashPassword / verifyPassword — PBKDF2-SHA256, 100k iters, 16-byte salt
//   • signJWT / verifyJWT           — HS256, 24h default expiry
//   • requireAuth                   — pull user from JWT cookie, 401 if missing
//   • requireRole                   — gate endpoints behind position === "Sales Director"
//   • generateTempPassword          — URL-safe random 10-char (no I/l/O/0/1)
//   • generateToken                 — URL-safe random 32-char (invitation / reset)
//   • sendEmail                     — Resend API wrapper
//   • logAudit                      — write a row to audit_log

import { Env, json, error } from "./_shared";

// ─── Password hashing (PBKDF2-SHA256) ─────────────────────────────────────────

const PBKDF2_ITERATIONS = 100_000;

function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pbkdf2(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const keyMat = await crypto.subtle.importKey(
    "raw", enc.encode(password), "PBKDF2", false, ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMat,
    256, // bits → 32 bytes
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<{ hash: string; salt: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await pbkdf2(password, salt);
  return { hash: b64encode(key), salt: b64encode(salt) };
}

export async function verifyPassword(password: string, hash: string, salt: string): Promise<boolean> {
  const saltBytes = b64decode(salt);
  const key = await pbkdf2(password, saltBytes);
  const candidate = b64encode(key);
  // Constant-time compare
  if (candidate.length !== hash.length) return false;
  let diff = 0;
  for (let i = 0; i < candidate.length; i++) diff |= candidate.charCodeAt(i) ^ hash.charCodeAt(i);
  return diff === 0;
}

// ─── JWT (HS256) ─────────────────────────────────────────────────────────────

function b64urlEncode(bytes: Uint8Array | string): string {
  const s = typeof bytes === "string" ? bytes : String.fromCharCode(...bytes);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return b64decode(s);
}

export interface JWTPayload {
  sub: string;          // effective user id (the one being acted as)
  email: string;
  name: string;
  position: string;     // "Sales Director" / "Sales Executive" / ...
  iat: number;          // issued at (seconds)
  exp: number;          // expiry (seconds)
  // Impersonation — when present, `sub` is the target user and `imp` is the
  // admin who initiated the session. Used to show a banner + audit accurately.
  imp?: { id: string; name: string };
}

export async function signJWT(payload: Omit<JWTPayload, "iat" | "exp"> & { imp?: { id: string; name: string } }, secret: string, ttlSeconds = 30 * 86_400): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const full: JWTPayload = { ...payload, iat: now, exp: now + ttlSeconds };
  const headerB64 = b64urlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payloadB64 = b64urlEncode(JSON.stringify(full));
  const unsigned = `${headerB64}.${payloadB64}`;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(unsigned));
  const sigB64 = b64urlEncode(new Uint8Array(sig));
  return `${unsigned}.${sigB64}`;
}

export async function verifyJWT(token: string, secret: string): Promise<JWTPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"],
  );
  const ok = await crypto.subtle.verify(
    "HMAC", key, b64urlDecode(sigB64), enc.encode(`${headerB64}.${payloadB64}`),
  );
  if (!ok) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64))) as JWTPayload;
    if (!payload.exp || Math.floor(Date.now() / 1000) > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// ─── Random tokens / passwords ───────────────────────────────────────────────

// Chars chosen to avoid look-alikes: I / l / O / 0 / 1
const TEMP_PW_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

export function generateTempPassword(length = 10): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (let i = 0; i < length; i++) out += TEMP_PW_ALPHABET[bytes[i] % TEMP_PW_ALPHABET.length];
  return out;
}

export function generateToken(bytes = 32): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return b64urlEncode(buf);
}

// ─── Password policy ─────────────────────────────────────────────────────────
// 8+ chars, at least 1 uppercase, at least 1 digit.
export function validatePassword(pw: string): string | null {
  if (!pw || pw.length < 8) return "Password must be at least 8 characters";
  if (!/[A-Z]/.test(pw)) return "Password must contain at least 1 uppercase letter";
  if (!/[0-9]/.test(pw)) return "Password must contain at least 1 digit";
  return null;
}

// ─── Cookie helpers ──────────────────────────────────────────────────────────

const COOKIE_NAME = "houzs_session";
// 30 days — enough that phones / daily users don't re-login constantly.
// JWT default ttl matches this. Impersonate sessions still use 2h (shorter).
const COOKIE_MAX_AGE = 30 * 86_400;

export function setAuthCookie(token: string, secure = true): string {
  const parts = [
    `${COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${COOKIE_MAX_AGE}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearAuthCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function readAuthCookie(request: Request): string | null {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === COOKIE_NAME) return rest.join("=");
  }
  return null;
}

// ─── Auth middleware ─────────────────────────────────────────────────────────

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  position: string;
  /** Set when this session was created by an admin impersonating — for audit + banner */
  impersonatedBy?: { id: string; name: string };
}

/** Extract + verify JWT from cookie. Returns null if not authed / expired. */
export async function getAuthUser(request: Request, env: Env): Promise<AuthUser | null> {
  const token = readAuthCookie(request);
  if (!token) return null;
  if (!env.JWT_SECRET) {
    console.warn("[auth] JWT_SECRET not configured");
    return null;
  }
  const payload = await verifyJWT(token, env.JWT_SECRET);
  if (!payload) return null;
  return {
    id: payload.sub,
    email: payload.email,
    name: payload.name,
    position: payload.position,
    impersonatedBy: payload.imp,
  };
}

/** Throws a 401 Response if the request isn't authed. Usage:
 *    const user = await requireAuth(request, env);
 *    if (user instanceof Response) return user;   // early return
 */
export async function requireAuth(request: Request, env: Env): Promise<AuthUser | Response> {
  const user = await getAuthUser(request, env);
  if (!user) return error("Not authenticated", 401);
  return user;
}

/** 403 unless the user is a Sales Director. */
export function requireRole(user: AuthUser, role: "Sales Director"): Response | null {
  if (user.position !== role) return error(`Requires role: ${role}`, 403);
  return null;
}

export function isAdmin(user: AuthUser): boolean {
  // HQ Super Admin = top-level admin. Sales Director still counts as admin
  // for legacy reasons (they can impersonate their downline, edit users).
  return user.position === "Super Admin" || user.position === "Sales Director";
}

// ─── Audit log ───────────────────────────────────────────────────────────────

export interface AuditEntry {
  action: string;              // create / update / delete / login / login_failed / logout / invite / ...
  entityType?: string;         // sku / so_header / so_line / payment / user / fabric / variants_config
  entityId?: string;
  field?: string;
  oldValue?: string | number | null;
  newValue?: string | number | null;
  changes?: Record<string, unknown>;
}

export async function logAudit(
  env: Env,
  request: Request,
  user: AuthUser | null,
  entry: AuditEntry,
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO audit_log (
         user_id, user_name, user_position, action, entity_type, entity_id,
         field, old_value, new_value, changes_json, ip_address, user_agent
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      user?.id ?? null,
      user?.name ?? null,
      user?.position ?? null,
      entry.action,
      entry.entityType ?? null,
      entry.entityId ?? null,
      entry.field ?? null,
      entry.oldValue == null ? null : String(entry.oldValue),
      entry.newValue == null ? null : String(entry.newValue),
      entry.changes ? JSON.stringify(entry.changes) : null,
      request.headers.get("CF-Connecting-IP") ?? null,
      request.headers.get("User-Agent") ?? null,
    ).run();
  } catch (e) {
    // Audit writes must never break the main request path
    console.warn("[audit] write failed:", e);
  }
}

// ─── Resend email ────────────────────────────────────────────────────────────

interface ResendMessage {
  from: string;
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
}

export async function sendEmail(env: Env, msg: Omit<ResendMessage, "from"> & { from?: string }): Promise<boolean> {
  if (!env.RESEND_API_KEY) {
    console.warn("[email] RESEND_API_KEY not configured — skipping send");
    return false;
  }
  const from = msg.from ?? env.FROM_EMAIL ?? "hello@houzscentury.com";
  const body: ResendMessage = { from, to: msg.to, subject: msg.subject, html: msg.html, text: msg.text };
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const text = await r.text();
      console.warn("[email] Resend rejected:", r.status, text);
      return false;
    }
    return true;
  } catch (e) {
    console.warn("[email] send failed:", e);
    return false;
  }
}

// ─── Email templates ─────────────────────────────────────────────────────────

export function inviteEmailTemplate(args: {
  toName: string;
  invitedByName: string;
  tempPassword: string;
  appUrl: string;
  expiresInDays: number;
}): { subject: string; html: string; text: string } {
  const { toName, invitedByName, tempPassword, appUrl, expiresInDays } = args;
  const subject = "You're invited to Houzs ERP";
  const text = `
Hi ${toName},

${invitedByName} invited you to join Houzs ERP.

Login URL: ${appUrl}/login
Your temporary password: ${tempPassword}

You will be asked to change this password on first login. This invitation expires in ${expiresInDays} days.

— Houzs Century Sdn Bhd
  `.trim();
  const html = `
<!doctype html>
<html><body style="font-family: -apple-system, Segoe UI, Tahoma, sans-serif; color:#0A1F2E; background:#F3F4F6; padding:24px;">
  <div style="max-width:520px; margin:0 auto; background:#fff; border-radius:8px; padding:32px; border:1px solid #E5E7EB;">
    <h2 style="margin:0 0 16px; color:#0F766E;">Welcome to Houzs ERP</h2>
    <p>Hi <b>${toName}</b>,</p>
    <p><b>${invitedByName}</b> has invited you to join <b>Houzs ERP</b>.</p>
    <div style="background:#F9FAFB; border:1px solid #E5E7EB; border-radius:6px; padding:16px; margin:20px 0;">
      <div style="font-size:12px; color:#6B7280; margin-bottom:8px;">Your temporary password</div>
      <div style="font-family:monospace; font-size:20px; font-weight:bold; letter-spacing:2px; color:#0A1F2E;">${tempPassword}</div>
    </div>
    <p>You will be asked to change this password on first login.</p>
    <p style="margin:24px 0;">
      <a href="${appUrl}/login" style="display:inline-block; background:#0F766E; color:#fff; padding:10px 24px; border-radius:6px; text-decoration:none; font-weight:600;">Login to Houzs ERP</a>
    </p>
    <p style="font-size:12px; color:#6B7280;">This invitation expires in <b>${expiresInDays} days</b>. If you didn't expect this email, ignore it.</p>
    <hr style="border:none; border-top:1px solid #E5E7EB; margin:24px 0;">
    <p style="font-size:11px; color:#9CA3AF;">Houzs Century Sdn Bhd</p>
  </div>
</body></html>
  `.trim();
  return { subject, html, text };
}

export function resetPasswordEmailTemplate(args: {
  toName: string;
  resetUrl: string;
  expiresInHours: number;
}): { subject: string; html: string; text: string } {
  const { toName, resetUrl, expiresInHours } = args;
  const subject = "Reset your Houzs ERP password";
  const text = `
Hi ${toName},

We received a request to reset your Houzs ERP password.
Reset link: ${resetUrl}

This link expires in ${expiresInHours} hour(s). If you didn't request this, ignore the email.
  `.trim();
  const html = `
<!doctype html>
<html><body style="font-family: -apple-system, Segoe UI, Tahoma, sans-serif; color:#0A1F2E; background:#F3F4F6; padding:24px;">
  <div style="max-width:520px; margin:0 auto; background:#fff; border-radius:8px; padding:32px; border:1px solid #E5E7EB;">
    <h2 style="margin:0 0 16px; color:#0F766E;">Reset your password</h2>
    <p>Hi <b>${toName}</b>,</p>
    <p>We received a request to reset your Houzs ERP password.</p>
    <p style="margin:24px 0;">
      <a href="${resetUrl}" style="display:inline-block; background:#0F766E; color:#fff; padding:10px 24px; border-radius:6px; text-decoration:none; font-weight:600;">Reset password</a>
    </p>
    <p style="font-size:12px; color:#6B7280;">Link expires in <b>${expiresInHours} hour(s)</b>. If you didn't request this, you can ignore this email.</p>
    <hr style="border:none; border-top:1px solid #E5E7EB; margin:24px 0;">
    <p style="font-size:11px; color:#9CA3AF;">Houzs Century Sdn Bhd</p>
  </div>
</body></html>
  `.trim();
  return { subject, html, text };
}
