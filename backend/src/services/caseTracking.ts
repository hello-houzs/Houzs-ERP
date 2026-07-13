import type { Env } from "../types";
import { generateToken, isoIn } from "./auth";
import { cleanPhone } from "./autocount";

// Per-case tokenised tracking. Three flows produce a token:
//   1. Customer hits /track, enters ASSR number + phone → server
//      verifies the pair matches, issues a 30-min token.
//   2. Staff hits the "Copy portal link" button on a case → server
//      issues a PERMANENT token (shareable via WhatsApp without the
//      customer having to type anything; Nick 2026-07-07 — links must
//      keep working forever, mig 0076 extended the existing ones).
//   3. Staff hits "Sales Portal Link" — same permanent per-case token
//      but source='sales'; the portal renders the salesperson
//      variant (full stage progress, comments attributed to sales).
//
// In all flows the token grants access to ONE case only. The
// middleware resolves the token to an `assr_id` which scopes every
// subsequent portal API query.

export const CUSTOMER_TTL_SECONDS = 60 * 30;            // 30 minutes
// Staff/sales links never expire. Stored as a far-future ISO stamp so
// the existing `expires_at > now` reads keep working without a schema
// change (expires_at is NOT NULL).
export const PERMANENT_EXPIRES_AT = "9999-12-31T23:59:59.000Z";

export type TrackSource = "customer" | "staff" | "sales";

export interface TrackedCase {
  assr_id: number;
  source: TrackSource;
  verified_phone: string | null;
}

// ── Token issuance ──────────────────────────────────────────

async function issueToken(
  env: Env,
  assrId: number,
  source: TrackSource,
  verifiedPhone: string | null,
  expiresAt: string
): Promise<string> {
  const token = generateToken(24);
  await env.DB.prepare(
    `INSERT INTO case_track_tokens (token, assr_id, source, verified_phone, expires_at)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(token, assrId, source, verifiedPhone, expiresAt)
    .run();
  return token;
}

/**
 * Public /track entry. Returns { token, assr_id } on success or null
 * if the case number / phone pair doesn't match any case. Phones are
 * normalised with cleanPhone() before comparison so "+6012-345 6789"
 * matches "60123456789".
 */
export async function verifyAndIssueCustomerToken(
  env: Env,
  assrNo: string,
  phone: string
): Promise<{ token: string; assr_id: number; assr_no: string } | null> {
  const asNum = assrNo.trim();
  const cleaned = cleanPhone(phone);
  if (!asNum || !cleaned) return null;

  const row = await env.DB.prepare(
    `SELECT id, phone FROM assr_cases WHERE assr_no = ?`
  )
    .bind(asNum)
    .first<{ id: number; phone: string | null }>();
  if (!row) return null;
  if (!row.phone) return null;
  if (cleanPhone(row.phone) !== cleaned) return null;

  const token = await issueToken(env, row.id, "customer", cleaned, isoIn(CUSTOMER_TTL_SECONDS));
  return { token, assr_id: row.id, assr_no: asNum };
}

/**
 * Staff-generated token for sharing with a customer directly.
 * Idempotent: if an unexpired staff token already exists for this
 * case, returns it instead of minting a new one. Prevents the staff
 * UI from generating a fresh URL every time the dispatcher reopens
 * the case panel.
 */
export async function issueStaffToken(env: Env, assrId: number): Promise<string> {
  const existing = await env.DB.prepare(
    `SELECT token FROM case_track_tokens
      WHERE assr_id = ? AND source = 'staff'
        AND expires_at > datetime('now')
      ORDER BY created_at DESC
      LIMIT 1`
  )
    .bind(assrId)
    .first<{ token: string }>();
  if (existing) return existing.token;
  return issueToken(env, assrId, "staff", null, PERMANENT_EXPIRES_AT);
}

/**
 * Sales-portal token — same shape as the staff token but the portal
 * renders the salesperson variant for it. Idempotent per case for
 * the same reason issueStaffToken is.
 */
export async function issueSalesToken(env: Env, assrId: number): Promise<string> {
  const existing = await env.DB.prepare(
    `SELECT token FROM case_track_tokens
      WHERE assr_id = ? AND source = 'sales'
        AND expires_at > datetime('now')
      ORDER BY created_at DESC
      LIMIT 1`
  )
    .bind(assrId)
    .first<{ token: string }>();
  if (existing) return existing.token;
  return issueToken(env, assrId, "sales", null, PERMANENT_EXPIRES_AT);
}

/**
 * Read-only lookup — returns the current staff token for this case
 * (or null). Used by the staff UI on panel-open so the existing
 * portal link displays without requiring the user to click anything.
 */
export async function getActiveStaffToken(env: Env, assrId: number): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT token FROM case_track_tokens
      WHERE assr_id = ? AND source = 'staff'
        AND expires_at > datetime('now')
      ORDER BY created_at DESC
      LIMIT 1`
  )
    .bind(assrId)
    .first<{ token: string }>();
  return row?.token ?? null;
}

// ── Resolution ──────────────────────────────────────────────

export async function resolveTrackToken(
  env: Env,
  token: string
): Promise<TrackedCase | null> {
  const row = await env.DB.prepare(
    `SELECT assr_id, source, verified_phone, expires_at
       FROM case_track_tokens WHERE token = ?`
  )
    .bind(token)
    .first<{
      assr_id: number;
      source: TrackSource;
      verified_phone: string | null;
      expires_at: string;
    }>();
  if (!row) return null;
  if (row.expires_at < new Date().toISOString()) {
    // Expired — opportunistic cleanup.
    await env.DB.prepare(`DELETE FROM case_track_tokens WHERE token = ?`)
      .bind(token)
      .run();
    return null;
  }
  return {
    assr_id: row.assr_id,
    source: row.source,
    verified_phone: row.verified_phone,
  };
}

// ── Status mapping (customer-facing, server-authoritative) ──

export function customerStatusFor(stage: string | null | undefined): {
  label: string;
  color: "grey" | "blue" | "amber" | "violet" | "green";
} {
  switch (stage) {
    // v3.1 9-stage workflow (mig 074)
    case "pending_review":            return { label: "Pending Review", color: "grey" };
    case "under_verification":        return { label: "Under Verification", color: "blue" };
    case "pending_solution":          return { label: "Pending Solution", color: "amber" };
    // Retired stage (mig 0105) — legacy alias for anything mid-flight.
    case "pending_inspection":        return { label: "Under Verification", color: "blue" };
    case "pending_item_pickup":       return { label: "Pending Item Pickup", color: "violet" };
    case "pending_supplier_pickup":   return { label: "Pending Supplier Pickup", color: "violet" };
    case "pending_item_ready":        return { label: "Pending Item Ready", color: "violet" };
    case "pending_delivery_service":  return { label: "Pending Delivery / Service", color: "violet" };
    case "completed":                 return { label: "Completed", color: "green" };
    // Legacy aliases — covers any unmigrated row label.
    case "registration":              return { label: "Pending Review", color: "grey" };
    case "triage":                    return { label: "Under Verification", color: "blue" };
    case "action":                    return { label: "Pending Solution", color: "amber" };
    case "logistics":                 return { label: "Pending Item Pickup", color: "violet" };
    case "resolution":                return { label: "Pending Delivery / Service", color: "violet" };
    case "closed":                    return { label: "Completed", color: "green" };
    default:                          return { label: stage || "Unknown", color: "grey" };
  }
}
