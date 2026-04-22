// Default permission matrix — port of scripts/seed-permissions.py.
// Used by the Admin Permissions page's "Reset to defaults" button.
//
// Missing (department, position, moduleKey) entries default to NONE.
// Keep this in sync with scripts/seed-permissions.py whenever defaults change.

import type { AccessLevel } from "./modules";
import { MODULES, ROLES } from "./modules";

type RoleKey = `${string}::${string}`; // "HQ::Super Admin"

function k(department: string, position: string): RoleKey {
  return `${department}::${position}` as RoleKey;
}

const ALL_MODULE_KEYS = MODULES.map((m) => m.key);

// Super Admin defaults to FULL on every module.
const SUPER_ADMIN_FULL: Record<string, AccessLevel> =
  Object.fromEntries(ALL_MODULE_KEYS.map((m) => [m, "FULL"] as const));

export const PERMISSION_DEFAULTS: Record<RoleKey, Record<string, AccessLevel>> = {
  // ── HQ ──
  [k("HQ", "Super Admin")]: SUPER_ADMIN_FULL,
  [k("HQ", "HR Manager")]: {
    dashboard: "VIEW", calendar: "VIEW", pms: "VIEW",
    sales_team: "VIEW",
    admin_users: "EDIT", admin_audit: "VIEW",
  },
  [k("HQ", "Finance Manager")]: {
    dashboard: "VIEW", calendar: "VIEW", finance: "FULL", pms: "VIEW",
    so_details: "VIEW", so: "VIEW", sku_costing: "VIEW",
    admin_audit: "VIEW",
  },
  [k("HQ", "Admin Assistant")]: {
    dashboard: "VIEW", calendar: "EDIT", pms: "VIEW",
    admin_users: "VIEW",
  },

  // ── SALES ──
  [k("SALES", "Sales Director")]: {
    dashboard: "FULL", calendar: "FULL", finance: "VIEW", pms: "FULL",
    settings: "VIEW", sales_team: "FULL",
    so_details: "FULL", so: "FULL", sku_costing: "FULL",
    qms: "FULL",
    admin_users: "VIEW", admin_audit: "VIEW",
  },
  [k("SALES", "Sales Manager")]: {
    dashboard: "VIEW", calendar: "FULL", pms: "FULL",
    sales_team: "EDIT",
    so_details: "EDIT", so: "EDIT", sku_costing: "VIEW",
    qms: "EDIT",
  },
  [k("SALES", "Sales Executive")]: {
    dashboard: "VIEW", calendar: "EDIT", pms: "VIEW",
    sales_team: "VIEW",
    so_details: "EDIT", so: "EDIT", sku_costing: "VIEW",
    qms: "EDIT",
  },
  [k("SALES", "Sales Trainee")]: {
    calendar: "VIEW", pms: "VIEW",
    so_details: "VIEW", so: "VIEW", sku_costing: "VIEW",
  },

  // ── OPERATION ──
  [k("OPERATION", "Ops Director")]: {
    dashboard: "VIEW", calendar: "FULL", pms: "VIEW",
    so_details: "VIEW", so: "VIEW", sku_costing: "VIEW",
    qms: "FULL",
    bd: "FULL", operation: "FULL", driver: "FULL",
  },
  [k("OPERATION", "Ops Manager")]: {
    calendar: "EDIT", pms: "VIEW",
    so_details: "VIEW", so: "VIEW",
    qms: "EDIT",
    bd: "EDIT", operation: "FULL", driver: "EDIT",
  },
  [k("OPERATION", "Ops Executive")]: {
    calendar: "VIEW", pms: "VIEW",
    so_details: "VIEW", so: "VIEW",
    operation: "EDIT", driver: "VIEW",
  },
  [k("OPERATION", "Warehouse")]: {
    calendar: "VIEW",
    so_details: "VIEW", sku_costing: "VIEW",
    operation: "EDIT",
  },
  [k("OPERATION", "Driver")]: {
    calendar: "VIEW",
    driver: "EDIT",
  },
};

/** Return the default level for a given (department, position, moduleKey).
 *  Roles/modules not in the defaults table resolve to NONE. */
export function defaultLevel(department: string, position: string, moduleKey: string): AccessLevel {
  const table = PERMISSION_DEFAULTS[k(department, position)];
  if (!table) return "NONE";
  return table[moduleKey] ?? "NONE";
}

/** Build a fully-populated defaults map covering all 13 roles x 16 modules. */
export function buildDefaultPermissionsMap(): Record<string, AccessLevel> {
  const out: Record<string, AccessLevel> = {};
  for (const role of ROLES) {
    for (const mod of MODULES) {
      out[`${role.department}:${role.position}:${mod.key}`] =
        defaultLevel(role.department, role.position, mod.key);
    }
  }
  return out;
}
