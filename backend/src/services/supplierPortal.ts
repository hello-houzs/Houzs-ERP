/**
 * Supplier Portal token lifecycle — proposal §6.3.
 *
 * Mirrors customer portal (services/caseTracking.ts) but scopes the
 * token to (case, creditor_code) so a supplier rep only sees the job
 * assigned to them. The main UI's "Copy supplier link" button issues
 * one of these and pastes the URL into WhatsApp / email.
 */
import type { Env } from "../types";
import { generateToken } from "./auth";

export const SUPPLIER_PORTAL_TTL_DAYS = 30;

export interface SupplierPortalScope {
  assr_id: number;
  creditor_code: string | null;
  token_id: number;
}

/**
 * Resolve a portal token to the case + supplier it grants access to.
 * Returns null if the token is unknown, expired, or revoked. Updates
 * `last_seen_at` as a side effect so admins can see whether the
 * supplier has actually opened the link.
 */
export async function resolveSupplierToken(
  env: Env,
  token: string
): Promise<SupplierPortalScope | null> {
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT id, assr_id, creditor_code, expires_at, revoked_at
       FROM assr_supplier_tokens WHERE token = ?`
  )
    .bind(token)
    .first<{
      id: number;
      assr_id: number;
      creditor_code: string | null;
      expires_at: string | null;
      revoked_at: string | null;
    }>();
  if (!row) return null;
  if (row.revoked_at) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;

  // Best-effort touch; failure shouldn't block the request.
  env.DB.prepare(
    `UPDATE assr_supplier_tokens SET last_seen_at = datetime('now') WHERE id = ?`
  )
    .bind(row.id)
    .run()
    .catch(() => {});

  return { assr_id: row.assr_id, creditor_code: row.creditor_code, token_id: row.id };
}

/**
 * Mint (or reuse) a supplier portal token for a case. Idempotent on
 * (case, creditor_code) — re-runs return the same active token so the
 * "Copy supplier link" button always produces a stable URL.
 */
export async function issueSupplierToken(
  env: Env,
  assrId: number,
  creditorCode: string | null,
  ttlDays: number = SUPPLIER_PORTAL_TTL_DAYS
): Promise<string> {
  // Postgres rejects `column IS ?` — the RHS of IS must be a literal
  // (NULL / TRUE / FALSE / DISTINCT FROM ...), not a bound param. Match
  // both a real creditor_code AND the "no creditor resolved yet" NULL
  // case by folding both sides through COALESCE with an empty-string
  // sentinel (real codes never look like ''). Works on SQLite (dev
  // fallback) and Postgres (prod) identically.
  const existing = await env.DB.prepare(
    `SELECT token FROM assr_supplier_tokens
      WHERE assr_id = ?
        AND COALESCE(creditor_code, '') = COALESCE(?, '')
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > datetime('now'))
      ORDER BY created_at DESC LIMIT 1`
  )
    .bind(assrId, creditorCode)
    .first<{ token: string }>();
  if (existing) return existing.token;

  const token = generateToken(24);
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare(
    `INSERT INTO assr_supplier_tokens (token, assr_id, creditor_code, expires_at)
     VALUES (?, ?, ?, ?)`
  )
    .bind(token, assrId, creditorCode, expiresAt)
    .run();
  return token;
}

export async function revokeSupplierToken(env: Env, tokenId: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE assr_supplier_tokens SET revoked_at = datetime('now') WHERE id = ?`
  )
    .bind(tokenId)
    .run();
}
