// ─────────────────────────────────────────────────────────────────────────
// roles.ts — staff-role tiers used by the API for cross-salesperson access.
//
// "View all sales" tier — the roles allowed to see EVERY salesperson's
// orders / sales KPIs (and all saved quotes), not just their own:
//   super_admin   — full POS+Backend owner
//   sales_director — POS power + limited Backend (Sales Order group + HR);
//                    inherits the old master_account view-all tier (2026-06-15)
//   outlet_manager — sees all salespersons' orders (Loo 2026-06-15)
// Plain `admin` is intentionally EXCLUDED here (Loo 2026-06-09) — admins see
// only their own. Keep this list in lockstep with the POS predicate
// `canViewAllSales` in apps/pos/src/lib/staff.ts.
// ─────────────────────────────────────────────────────────────────────────

export const ALL_SALES_VIEWER_ROLES = ['super_admin', 'sales_director', 'outlet_manager'] as const;

/** True when this role may view every salesperson's orders/sales (not just own). */
export function canViewAllSales(role: string | null | undefined): boolean {
  return role === 'super_admin' || role === 'sales_director' || role === 'outlet_manager';
}

/* Self-scoped selling roles — on the Backend SO list/detail and the POS
   My-orders board they are scoped to their OWN orders (salesperson_id =
   caller). `outlet_manager` was removed from this set (2026-06-15) and
   promoted to the view-all tier above; `sales_director` is also view-all.
   Backend-native roles (coordinator / finance / admin / …) are untouched. */
export function isSelfScopedSales(role: string | null | undefined): boolean {
  return role === 'sales' || role === 'sales_executive';
}

/* Roles that log in by PASSCODE (the 6-digit PIN) on the POS LockScreen.
   2026-06-15: widened from {sales} so Salesperson (sales_executive) and Outlet
   manager log in by passcode too. Keep in lock-step with admin.ts POS_PIN_ROLES
   (staff creation / PIN reset) — both must list the same roles. */
export const PIN_LOGIN_ROLES = ['sales', 'sales_executive', 'outlet_manager'] as const;
export function isPinLoginRole(role: string | null | undefined): boolean {
  return role === 'sales' || role === 'sales_executive' || role === 'outlet_manager';
}
