/**
 * Flat catalog of every permission the app understands.
 * Keep this in sync with the resource boundaries on the worker
 * (one entry per { resource × verb }) and with the frontend
 * permission registry.
 *
 * Special key "*" → grants every permission. Reserved for the
 * Owner role.
 */
export interface PermissionDef {
  key: string;
  resource: string;
  verb: "read" | "write" | "manage";
  label: string;
  description: string;
}

export const PERMISSIONS: PermissionDef[] = [
  // Operational tabs
  { key: "sales_orders.read",  resource: "Sales Orders",     verb: "read",   label: "View sales orders",     description: "See the Sales Orders tab and its dashboard" },
  { key: "sales_orders.write", resource: "Sales Orders",     verb: "write",  label: "Edit sales orders",     description: "Modify status / expiry / push to AutoCount" },
  { key: "delivery_orders.read",  resource: "Delivery Orders", verb: "read",  label: "View delivery orders", description: "See the Delivery Orders tab and its dashboard" },
  { key: "delivery_orders.write", resource: "Delivery Orders", verb: "write", label: "Edit delivery orders", description: "Modify scheduling fields" },
  { key: "purchase_orders.read",  resource: "Purchase Orders", verb: "read",  label: "View purchase orders", description: "See the Purchase Orders tab" },
  { key: "purchase_orders.write", resource: "Purchase Orders", verb: "write", label: "Edit purchase orders", description: "Edit supplier dates / push to AutoCount" },
  { key: "service_cases.read",   resource: "Service Cases", verb: "read",   label: "View service cases",   description: "See the ASSR / Service Cases tab" },
  { key: "service_cases.write",  resource: "Service Cases", verb: "write",  label: "Edit service cases",   description: "Create and update ASSR cases" },
  { key: "service_cases.manage", resource: "Service Cases", verb: "manage", label: "Manage service cases", description: "Triage, assign, schedule logistics for ASSR cases" },
  { key: "balance.read",  resource: "Balance",  verb: "read",  label: "View balance",  description: "See the Balance Collection tab" },
  { key: "overdue.read",  resource: "Overdue",  verb: "read",  label: "View overdue",  description: "See the Overdue history tab" },
  { key: "overdue.write", resource: "Overdue",  verb: "write", label: "Run overdue check", description: "Trigger the overdue auto-extend job" },
  { key: "logs.read",     resource: "Activity Log", verb: "read", label: "View activity log", description: "See the system execution log" },

  // Trips & planner
  { key: "trips.read.own", resource: "Trips", verb: "read",   label: "View own trips",      description: "Driver-facing: see trips assigned to me" },
  { key: "trips.read.all", resource: "Trips", verb: "read",   label: "View all trips",      description: "Dispatcher: see every trip across drivers" },
  { key: "trips.write",    resource: "Trips", verb: "write",  label: "Update trip progress", description: "Start/stop trips, mark stops, upload POD, send GPS pings" },
  { key: "trips.manage",   resource: "Trips", verb: "manage", label: "Manage trips",        description: "Create, assign, cancel trips and edit any trip" },
  { key: "planner.run",    resource: "Trips", verb: "manage", label: "Run scheduling agent", description: "Generate and confirm trip proposals" },

  // Fleet management
  { key: "fleet.read",    resource: "Fleet", verb: "read",   label: "View fleet",          description: "See drivers, helpers, lorries, and compliance" },
  { key: "fleet.manage",  resource: "Fleet", verb: "manage", label: "Manage fleet",        description: "Edit driver/lorry profiles, maintenance, incidents, salary" },
  { key: "fleet.salary",  resource: "Fleet", verb: "read",   label: "View own salary",     description: "Driver/helper self-service salary view" },

  // Projects (exhibitions, solo events)
  { key: "projects.read",    resource: "Projects", verb: "read",   label: "View projects",     description: "See the Projects tab and open project detail pages" },
  { key: "projects.write",   resource: "Projects", verb: "write",  label: "Edit projects",     description: "Create and update projects, checklist items, finance" },
  { key: "projects.approve", resource: "Projects", verb: "manage", label: "Approve gated steps", description: "Tick permission-gated checklist items (e.g. 3D final approval)" },
  { key: "projects.manage",  resource: "Projects", verb: "manage", label: "Manage projects",   description: "Archive, change stage, edit templates, backfill CSV" },

  // System
  { key: "sync.run",   resource: "Sync",     verb: "write",  label: "Run sync", description: "Trigger Sync / Sync All / Retry Errors" },
  { key: "udf.manage", resource: "Custom Fields", verb: "manage", label: "Manage custom fields", description: "Add or remove user-defined fields on tables" },
  { key: "settings.manage", resource: "Settings", verb: "manage", label: "Manage settings", description: "Edit connection and sync configuration" },

  // Team & roles
  { key: "users.read",   resource: "Team",  verb: "read",   label: "View team",   description: "See team members and pending invitations" },
  { key: "users.manage", resource: "Team",  verb: "manage", label: "Manage team", description: "Invite, change role, disable, or remove users" },
  { key: "roles.read",   resource: "Roles", verb: "read",   label: "View roles",  description: "See the list of roles and their permissions" },
  { key: "roles.manage", resource: "Roles", verb: "manage", label: "Manage roles", description: "Create, edit, and delete custom roles" },
];

const PERMISSION_KEYS = new Set(PERMISSIONS.map((p) => p.key));

export function isValidPermission(key: string): boolean {
  return key === "*" || PERMISSION_KEYS.has(key);
}

/**
 * Decide if a granted permission set covers a required permission.
 * "*" wildcards grant everything.
 */
export function hasPermission(granted: string[], required: string): boolean {
  if (granted.includes("*")) return true;
  return granted.includes(required);
}

export function parsePermissions(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is string => typeof x === "string" && isValidPermission(x));
  } catch {
    return [];
  }
}
