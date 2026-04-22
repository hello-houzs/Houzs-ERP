// Module registry — maps sidebar items to permission keys in role_permissions.
// Used by sidebar + route guards + permission-matrix UI.

export type AccessLevel = "NONE" | "VIEW" | "EDIT" | "FULL";

export const ACCESS_LEVEL_RANK: Record<AccessLevel, number> = {
  NONE: 0,
  VIEW: 1,
  EDIT: 2,
  FULL: 3,
};

export interface ModuleDef {
  key: string;        // persisted in role_permissions.module_key
  label: string;
  group: string;      // sidebar group — PROJECT_MANAGEMENT / SALES / QMS / DEPARTMENTS / ADMIN
  path: string;       // primary route path
}

export const MODULES: ModuleDef[] = [
  // PROJECT MANAGEMENT
  { key: "dashboard",         label: "Project Management Dashboard", group: "PROJECT_MANAGEMENT", path: "/" },
  { key: "calendar",          label: "Calendar",                     group: "PROJECT_MANAGEMENT", path: "/calendar" },
  { key: "finance",           label: "Project Financial Report",     group: "PROJECT_MANAGEMENT", path: "/finance" },
  { key: "pms",               label: "Project Details",              group: "PROJECT_MANAGEMENT", path: "/pms" },
  { key: "settings",          label: "Master Data",                  group: "PROJECT_MANAGEMENT", path: "/settings" },
  // SALES
  { key: "sales_team",        label: "Sales Team",                   group: "SALES",              path: "/sales" },
  { key: "so_details",        label: "Sales Order Details",          group: "SALES",              path: "/sales/details" },
  { key: "so",                label: "Sales Order",                  group: "SALES",              path: "/sales/orders" },
  { key: "sku_costing",       label: "SKU Costing",                  group: "SALES",              path: "/sales/sku-costing" },
  // QMS
  { key: "qms",               label: "After-Sales Cases",            group: "QMS",                path: "/qms" },
  // DEPARTMENTS (Operation)
  { key: "bd",                label: "PM Department",                group: "DEPARTMENTS",        path: "/bd" },
  { key: "operation",         label: "Operation",                    group: "DEPARTMENTS",        path: "/operation" },
  { key: "driver",            label: "Driver",                       group: "DEPARTMENTS",        path: "/driver" },
  // ADMIN (HQ)
  { key: "admin_users",       label: "Users",                        group: "ADMIN",              path: "/admin/users" },
  { key: "admin_audit",       label: "Audit Log",                    group: "ADMIN",              path: "/admin/audit-log" },
  { key: "admin_permissions", label: "Permissions",                  group: "ADMIN",              path: "/admin/permissions" },
];

export const MODULES_BY_KEY: Record<string, ModuleDef> =
  Object.fromEntries(MODULES.map((m) => [m.key, m]));

export const MODULES_BY_PATH: Record<string, ModuleDef> =
  Object.fromEntries(MODULES.map((m) => [m.path, m]));

/** Compare two access levels. Returns >= 0 if `have` meets `needed`. */
export function hasAccess(have: AccessLevel | undefined, needed: AccessLevel): boolean {
  return ACCESS_LEVEL_RANK[have ?? "NONE"] >= ACCESS_LEVEL_RANK[needed];
}

// All 13 roles in the system (department × position)
export interface Role { department: "SALES" | "OPERATION" | "HQ"; position: string; }

export const ROLES: Role[] = [
  { department: "HQ",        position: "Super Admin" },
  { department: "HQ",        position: "HR Manager" },
  { department: "HQ",        position: "Finance Manager" },
  { department: "HQ",        position: "Admin Assistant" },
  { department: "SALES",     position: "Sales Director" },
  { department: "SALES",     position: "Sales Manager" },
  { department: "SALES",     position: "Sales Executive" },
  { department: "SALES",     position: "Sales Trainee" },
  { department: "OPERATION", position: "Ops Director" },
  { department: "OPERATION", position: "Ops Manager" },
  { department: "OPERATION", position: "Ops Executive" },
  { department: "OPERATION", position: "Warehouse" },
  { department: "OPERATION", position: "Driver" },
];
