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
  { key: "service_cases.read",   resource: "Service Cases", verb: "read",   label: "View service cases",   description: "See the ASSR / Service Cases tab" },
  { key: "service_cases.write",  resource: "Service Cases", verb: "write",  label: "Edit service cases",   description: "Create and update ASSR cases" },
  { key: "service_cases.manage", resource: "Service Cases", verb: "manage", label: "Manage service cases", description: "Triage, assign, schedule logistics for ASSR cases" },
  { key: "logs.read",     resource: "Activity Log", verb: "read", label: "View activity log", description: "See the system execution log" },

  // Projects (exhibitions, solo events)
  { key: "projects.read",    resource: "Projects", verb: "read",   label: "View projects",     description: "See the Projects tab and open project detail pages" },
  { key: "projects.chat",    resource: "Projects", verb: "write",  label: "Post project chat", description: "Post messages and mark notifications read on projects you can see, without editing project config" },
  { key: "projects.checklist.tick", resource: "Projects", verb: "write", label: "Tick checklist items", description: "Flip the status of (non-gated) checklist items, without editing project config" },
  { key: "projects.write",   resource: "Projects", verb: "write",  label: "Edit projects",     description: "Create and update projects, checklist items, finance" },
  { key: "projects.approve", resource: "Projects", verb: "manage", label: "Approve gated steps", description: "Tick permission-gated checklist items (e.g. 3D final approval)" },
  { key: "projects.manage",  resource: "Projects", verb: "manage", label: "Manage projects",   description: "Archive, change stage, edit templates, backfill CSV" },

  // Sales entries — rep-facing sales log that later pushes to AutoCount
  { key: "sales.read",   resource: "Sales Entries", verb: "read",   label: "View sales entries",   description: "See the Sales tab; scoped users see only their own entries" },
  { key: "sales.write",  resource: "Sales Entries", verb: "write",  label: "Edit sales entries",   description: "Create and edit own draft sales entries, submit for review" },
  { key: "sales.manage", resource: "Sales Entries", verb: "manage", label: "Manage sales entries", description: "Edit any entry, configure fields, void entries, push to AutoCount" },

  // Supply Chain — ported 2990's furniture SCM (/api/scm). Single coarse
  // gate: holding scm.access (or "*") unlocks every SCM module. Owner +
  // IT Admin already cover it via "*"; this lets non-admin roles in too.
  { key: "scm.access", resource: "Supply Chain", verb: "read", label: "Access Supply Chain", description: "See and use the Supply Chain (furniture SCM) modules" },

  // System
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
 * "*" wildcards grant everything. Accepts either a string array
 * (legacy / test fixtures) or a Set (the fast path used by every
 * authed request — populated by `services/auth.ts::hydrateAuthUser`).
 */
export function hasPermission(
  granted: ReadonlyArray<string> | ReadonlySet<string>,
  required: string,
): boolean {
  if (Array.isArray(granted)) {
    return granted.includes("*") || granted.includes(required);
  }
  // Narrowed to ReadonlySet<string> in the else branch — assert to
  // satisfy TS's union-narrowing limitation here.
  const set = granted as ReadonlySet<string>;
  return set.has("*") || set.has(required);
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
