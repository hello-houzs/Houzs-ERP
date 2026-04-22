// GET /api/auth/me — returns the current user + role-derived flags.
// Used by the frontend AuthContext to hydrate user state after page reload.

import { Env, json, error } from "../../_shared";
import { getAuthUser } from "../../_auth";

export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const authed = await getAuthUser(request, env);
  if (!authed) return error("Not authenticated", 401);

  // Re-read from DB so role/brands/etc are always fresh (JWT may be stale)
  const row = await env.DB.prepare(
    `SELECT id, name, code, email, phone, department, position, parent_id,
            additional_parent_ids, join_date, status, assigned_brands,
            commission_tiers, min_rate, must_change_password, last_login
       FROM users WHERE id = ?`
  ).bind(authed.id).first<Record<string, unknown>>();
  if (!row) return error("User not found", 404);

  const department = (row.department as string) ?? "SALES";
  const position = row.position as string;

  // Look up role_permissions for this (department, position). Returns a
  // module_key -> level map. Missing entries default to NONE client-side.
  const permissions: Record<string, string> = {};
  const permRows = await env.DB.prepare(
    `SELECT module_key, level FROM role_permissions
      WHERE department = ? AND position = ?`
  ).bind(department, position).all<{ module_key: string; level: string }>();
  for (const p of permRows.results) permissions[p.module_key] = p.level;

  return json({
    id: row.id,
    name: row.name,
    code: row.code ?? "",
    email: row.email,
    phone: row.phone ?? "",
    department,
    position,
    parentId: row.parent_id ?? "",
    additionalParentIds: row.additional_parent_ids ? JSON.parse(row.additional_parent_ids as string) : [],
    joinDate: row.join_date ?? "",
    status: row.status,
    assignedBrands: row.assigned_brands ? JSON.parse(row.assigned_brands as string) : [],
    commissionTiers: row.commission_tiers ? JSON.parse(row.commission_tiers as string) : [],
    minRate: Number(row.min_rate ?? 0),
    mustChangePassword: !!row.must_change_password,
    lastLogin: row.last_login ?? null,
    // Admin = HQ/Super Admin (only). Sales Director is no longer implicit admin —
    // their Admin-page access is controlled by the permission matrix (admin_users,
    // admin_audit, admin_permissions module keys).
    isAdmin: department === "HQ" && position === "Super Admin",
    permissions,
  });
};
