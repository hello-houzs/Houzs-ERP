// ─────────────────────────────────────────────────────────────────────────
// salesScope.ts — row-level "own / subordinates" visibility for the SCM
// sales-side documents (sales orders, delivery orders, sales invoices,
// consignment orders). Resolves WHICH salesperson_ids a caller may see by
// layering two systems:
//
//   1. The staff-role tiers (lib/roles.ts):
//        • canViewAllSales  (super_admin / sales_director / outlet_manager) → all
//        • isSelfScopedSales (sales / sales_executive POS sellers)          → own
//   2. The position-subtree tier (services/salesTeam.ts): any other caller
//      who is a sales rep is held to their own id + their downline subtree —
//      this is the "Manager sees their team, leaf rep sees only self" middle
//      tier the role system alone could not express. Non-reps (backend
//      coordinator / finance / ops / owner) stay unrestricted.
//
// Keep this as the single source of truth so every sales-doc list/detail
// scopes identically.
// ─────────────────────────────────────────────────────────────────────────

import type { Env } from "../../types";
import { canViewAllSales, isSelfScopedSales } from "./roles";
import { salesVisibilityUserIds } from "../../services/salesTeam";

/**
 * The salesperson_ids a caller may see, or null for "no restriction".
 * One staff-role lookup, plus the rep subtree walk only when needed.
 */
export async function resolveSalesScopeIds(
  sb: any,
  env: Env,
  userId: number | string,
): Promise<number[] | null> {
  const { data: caller } = await sb
    .from("staff")
    .select("role")
    .eq("id", userId)
    .maybeSingle();
  const role = (caller as { role?: string } | null)?.role;
  if (canViewAllSales(role)) return null; // view-all tier
  if (isSelfScopedSales(role)) return [Number(userId)]; // POS seller: own only
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
  salespersonId: number | string | null | undefined,
): Promise<boolean> {
  const ids = await resolveSalesScopeIds(sb, env, userId);
  if (ids === null) return false; // unrestricted
  return salespersonId == null || !ids.includes(Number(salespersonId));
}
