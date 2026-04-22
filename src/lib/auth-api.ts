// Fetch helpers for the auth / users / audit-log APIs.
// All calls use credentials: "include" so the session cookie travels.

export type Department = "SALES" | "OPERATION" | "HQ";

export interface CurrentUser {
  id: string;
  name: string;
  code: string;
  email: string;
  phone: string;
  department: Department;
  position: string;
  parentId: string;
  additionalParentIds: string[];
  joinDate: string;
  status: "ACTIVE" | "INACTIVE" | "PENDING";
  assignedBrands: string[];
  commissionTiers: { threshold: number; pct: number }[];
  minRate: number;
  mustChangePassword: boolean;
  lastLogin: string | null;
  isAdmin: boolean;
  /** module_key → level (NONE | VIEW | EDIT | FULL). Missing keys = NONE. */
  permissions?: Record<string, "NONE" | "VIEW" | "EDIT" | "FULL">;
  impersonatedBy?: { id: string; name: string } | null;
}

async function req<T = unknown>(path: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
  try {
    const r = await fetch(path, { ...init, credentials: "include", headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
    if (r.status === 204) return { ok: true, data: null as T };
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, status: r.status, error: (data as { error?: string }).error ?? r.statusText };
    return { ok: true, data: data as T };
  } catch (e) {
    return { ok: false, status: 0, error: (e as Error).message };
  }
}

export const authApi = {
  me:    () => req<CurrentUser>("/api/auth/me"),
  login: (email: string, password: string) =>
    req<{ user: { id: string; email: string; name: string; position: string; mustChangePassword: boolean } }>(
      "/api/auth/login",
      { method: "POST", body: JSON.stringify({ email, password }) },
    ),
  logout: () => req<{ ok: true }>("/api/auth/logout", { method: "POST" }),
  changePassword: (currentPassword: string, newPassword: string) =>
    req<{ ok: true }>("/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
  forgotPassword: (email: string) =>
    req<{ ok: true }>("/api/auth/forgot-password", {
      method: "POST", body: JSON.stringify({ email }),
    }),
  resetPassword: (token: string, newPassword: string) =>
    req<{ ok: true }>("/api/auth/reset-password", {
      method: "POST", body: JSON.stringify({ token, newPassword }),
    }),
  impersonate: (userId: string) =>
    req<{ ok: true; impersonating: { id: string; name: string; email: string; position: string } }>(
      "/api/auth/impersonate",
      { method: "POST", body: JSON.stringify({ userId }) },
    ),
  stopImpersonate: () => req<{ ok: true }>("/api/auth/stop-impersonate", { method: "POST" }),
};

// ─── Users (admin only) ───────────────────────────────────────────────────────

export interface UserRow {
  id: string;
  name: string;
  code: string;
  email: string;
  phone: string;
  department: Department;
  position: string;
  parentId: string;
  additionalParentIds: string[];
  joinDate: string;
  status: "ACTIVE" | "INACTIVE" | "PENDING";
  assignedBrands: string[];
  commissionTiers: { threshold: number; pct: number }[];
  minRate: number;
  mustChangePassword: boolean;
  hasPassword: boolean;
  lastLogin: string | null;
  createdAt: string;
  inviteExpiresAt: string | null;
  inviteUsedAt: string | null;
}

export interface InvitePayload {
  name: string;
  email: string;
  phone?: string;
  code?: string;
  ic?: string;
  joinDate?: string;
  department?: Department;
  position: string;
  parentId?: string;
  assignedBrands?: string[];
  /** Send invite email immediately on create. Default true.
   *  Set false when creating from Sales Team register — user will show up
   *  as NOT_INVITED and admin triggers the email separately. */
  sendInvite?: boolean;
}

export const usersApi = {
  list:  () => req<UserRow[]>("/api/users"),
  invite: (p: InvitePayload) =>
    req<{ ok: true; id: string; emailSent: boolean }>("/api/users", {
      method: "POST", body: JSON.stringify(p),
    }),
  update: (id: string, patch: Partial<UserRow>) =>
    req<{ ok: true }>(`/api/users/${encodeURIComponent(id)}`, {
      method: "PATCH", body: JSON.stringify(patch),
    }),
  remove: (id: string) =>
    req<{ ok: true }>(`/api/users/${encodeURIComponent(id)}`, { method: "DELETE" }),
  resendInvite: (id: string) =>
    req<{ ok: true; emailSent: boolean }>(`/api/users/${encodeURIComponent(id)}/resend-invite`, {
      method: "POST",
    }),
};

// ─── Audit log ────────────────────────────────────────────────────────────────

export interface AuditEntry {
  id: number;
  userId: string | null;
  userName: string | null;
  userPosition: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  changes: Record<string, unknown> | null;
  ipAddress: string | null;
  userAgent: string | null;
  timestamp: string;
}

export const auditApi = {
  list: (params: Partial<{ user: string; action: string; entity: string; from: string; to: string; limit: number }> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v != null && v !== "") qs.set(k, String(v));
    return req<AuditEntry[]>(`/api/audit-log${qs.toString() ? `?${qs}` : ""}`);
  },
};

// ─── Role permissions matrix (Super Admin only) ──────────────────────────────

export interface PermissionRow {
  department: "SALES" | "OPERATION" | "HQ";
  position: string;
  moduleKey: string;
  level: "NONE" | "VIEW" | "EDIT" | "FULL";
}

export const permissionsApi = {
  list: () => req<PermissionRow[]>("/api/permissions"),
  save: (rows: PermissionRow[]) =>
    req<{ ok: true; rowCount: number }>("/api/permissions", {
      method: "PUT",
      body: JSON.stringify(rows),
    }),
};
