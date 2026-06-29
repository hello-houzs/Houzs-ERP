// ─────────────────────────────────────────────────────────────────────────
// salesScope.ts — row-level "own / subordinates" visibility for the SCM
// sales-side documents (sales orders, delivery orders, sales invoices,
// consignment orders). Houzs-flavoured: the original 2990 staff-role tier
// lookup is dead in Houzs (the SCM bridge pins every caller to one
// super_admin row) — so the view-all tier is now gated on the flat
// permission key `scm.so.view_all` against the REAL caller, computed by the
// caller via `hasHouzsPerm(c, 'scm.so.view_all')` and passed in as the
// `canViewAll` flag. The position-subtree tier (services/salesTeam.ts)
// continues to scope reps to their own id + downline.
//
// Keep this as the single source of truth so every sales-doc list/detail
// scopes identically.
// ─────────────────────────────────────────────────────────────────────────

import type { Env } from "../../types";
import { salesVisibilityUserIds } from "../../services/salesTeam";

/**
 * The salesperson_ids a caller may see, or null for "no restriction".
 * `canViewAll` is computed by the caller via the Houzs `scm.so.view_all`
 * permission (Owner + IT Admin pass via `*`).
 */
export async function resolveSalesScopeIds(
  _sb: any,
  env: Env,
  userId: number | string,
  canViewAll: boolean,
): Promise<number[] | null> {
  if (canViewAll) return null; // view-all tier
  return salesVisibilityUserIds(env, userId); // rep subtree, or null if not a rep
}

/**
 * True when a single document's salesperson_id falls OUTSIDE the caller's
 * scope — used by detail/print reads to answer 404 (indistinguishable from a
 * nonexistent doc_no), matching the POS self-scope hatch's behavior.
 */
export async function salesDocOutOfScope(
  sb: any,
  env: Env,
  userId: number | string,
  canViewAll: boolean,
  salespersonId: number | string | null | undefined,
): Promise<boolean> {
  const ids = await resolveSalesScopeIds(sb, env, userId, canViewAll);
  if (ids === null) return false; // unrestricted
  return salespersonId == null || !ids.includes(Number(salespersonId));
}
