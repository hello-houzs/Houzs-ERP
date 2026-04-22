// GET  /api/users         — list all users (admin-only)
// POST /api/users         — invite a new user (admin-only)
//
// Invite flow:
//   1. Admin posts { name, email, phone, position, parentId, assignedBrands }
//   2. Server generates random temp password, hashes it, creates user row
//      with must_change_password = 1 + status = ACTIVE
//   3. Creates invitations row tracking expires_at (+7 days) & invited_by
//   4. Sends invite email via Resend with the plaintext temp password
//   5. Returns the new user record (without the password)

import { Env, json, error } from "../../_shared";
import {
  requireAuth, requireRole, hashPassword, generateTempPassword,
  sendEmail, inviteEmailTemplate, logAudit,
} from "../../_auth";

const INVITE_EXPIRY_DAYS = 7;

interface InviteBody {
  name?: string;
  email?: string;
  code?: string;
  phone?: string;
  ic?: string;
  department?: "SALES" | "OPERATION" | "HQ";
  position?: string;
  parentId?: string;
  additionalParentIds?: string[];
  assignedBrands?: string[];
  commissionTiers?: { threshold: number; pct: number }[];
  minRate?: number;
  joinDate?: string;
  /** If false, create user WITHOUT a password + DON'T send email. Used by
   *  the Sales Team "Register" modal — the new person will show up in the
   *  Users page as NOT_INVITED, where admin can then multi-select + send. */
  sendInvite?: boolean;
}

function rowToUser(r: Record<string, unknown>) {
  return {
    id: r.id,
    name: r.name,
    code: r.code ?? "",
    department: (r.department as string) ?? "SALES",
    email: r.email,
    phone: r.phone ?? "",
    position: r.position,
    parentId: r.parent_id ?? "",
    additionalParentIds: r.additional_parent_ids ? JSON.parse(r.additional_parent_ids as string) : [],
    joinDate: r.join_date ?? "",
    status: r.status,
    assignedBrands: r.assigned_brands ? JSON.parse(r.assigned_brands as string) : [],
    commissionTiers: r.commission_tiers ? JSON.parse(r.commission_tiers as string) : [],
    minRate: Number(r.min_rate ?? 0),
    mustChangePassword: !!r.must_change_password,
    hasPassword: !!r.password_hash,
    lastLogin: r.last_login ?? null,
    createdAt: r.created_at,
    // Invite status (added if row is pending)
    inviteExpiresAt: r.invite_expires_at ?? null,
    inviteUsedAt: r.invite_used_at ?? null,
  };
}

export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const user = await requireAuth(request, env);
  if (user instanceof Response) return user;
  const roleErr = requireRole(user, "Sales Director");
  if (roleErr) return roleErr;

  // LEFT JOIN to get the latest invitation (for PENDING rows) — latest by created_at
  const { results } = await env.DB.prepare(
    `SELECT u.*,
            (SELECT expires_at FROM invitations i WHERE i.user_id = u.id ORDER BY i.created_at DESC LIMIT 1) AS invite_expires_at,
            (SELECT used_at    FROM invitations i WHERE i.user_id = u.id ORDER BY i.created_at DESC LIMIT 1) AS invite_used_at
       FROM users u
       ORDER BY
         CASE u.position
           WHEN 'Sales Director' THEN 1
           WHEN 'Sales Manager'  THEN 2
           WHEN 'Sales Executive' THEN 3
           ELSE 4
         END,
         u.name`
  ).all<Record<string, unknown>>();
  return json(results.map(rowToUser));
};

export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  const admin = await requireAuth(request, env);
  if (admin instanceof Response) return admin;
  const roleErr = requireRole(admin, "Sales Director");
  if (roleErr) return roleErr;

  const body = await request.json<InviteBody>().catch(() => ({} as InviteBody));
  const email = (body.email ?? "").trim().toLowerCase();
  const name = (body.name ?? "").trim();
  const position = (body.position ?? "Sales Executive").trim();
  if (!email || !name) return error("Name and email are required");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return error("Invalid email format");

  // Duplicate email check
  const existing = await env.DB.prepare(
    `SELECT id FROM users WHERE LOWER(email) = ? LIMIT 1`
  ).bind(email).first<{ id: string }>();
  if (existing) return error("A user with that email already exists", 409);

  // Generate id — "exe-<first word lowercased>" with random suffix for collisions
  const nameSlug = name.toLowerCase().split(/\s+/)[0].replace(/[^a-z0-9]/g, "") || "user";
  const prefix = position.toLowerCase().includes("director") ? "dir" : "exe";
  let id = `${prefix}-${nameSlug}`;
  // Handle id collision
  while (await env.DB.prepare(`SELECT 1 FROM users WHERE id = ?`).bind(id).first()) {
    id = `${prefix}-${nameSlug}-${Math.random().toString(36).slice(2, 5)}`;
  }

  const sendInvite = body.sendInvite !== false; // default true for back-compat

  // Create user row. With sendInvite=false we leave password_hash NULL so the
  // user shows as NOT_INVITED in the admin UI until admin triggers the invite.
  let passwordHash: string | null = null;
  let passwordSalt: string | null = null;
  let tempPw: string | null = null;
  if (sendInvite) {
    tempPw = generateTempPassword(10);
    const pwHash = await hashPassword(tempPw);
    passwordHash = pwHash.hash;
    passwordSalt = pwHash.salt;
  }

  const department = (body.department ?? "SALES").toUpperCase();
  await env.DB.prepare(
    `INSERT INTO users (
       id, name, code, email, phone, ic, department, position, parent_id, additional_parent_ids,
       join_date, status, assigned_brands, commission_tiers, min_rate,
       password_hash, password_salt, must_change_password
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, name, body.code ?? name.toUpperCase(), email, body.phone ?? null, body.ic ?? null,
    department,
    position, body.parentId || null,
    JSON.stringify(body.additionalParentIds ?? []),
    body.joinDate ?? new Date().toISOString().slice(0, 10),
    JSON.stringify(body.assignedBrands ?? []),
    JSON.stringify(body.commissionTiers ?? []),
    Number(body.minRate ?? 0),
    passwordHash, passwordSalt,
    sendInvite ? 1 : 0,
  ).run();

  let emailed = false;
  if (sendInvite && tempPw) {
    // Invitation row
    const inviteId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + INVITE_EXPIRY_DAYS * 86_400 * 1000).toISOString();
    await env.DB.prepare(
      `INSERT INTO invitations (id, user_id, invited_by, expires_at)
       VALUES (?, ?, ?, ?)`
    ).bind(inviteId, id, admin.id, expiresAt).run();

    // Send email
    const appUrl = env.APP_URL ?? `https://${new URL(request.url).host}`;
    const tpl = inviteEmailTemplate({
      toName: name,
      invitedByName: admin.name,
      tempPassword: tempPw,
      appUrl,
      expiresInDays: INVITE_EXPIRY_DAYS,
    });
    emailed = await sendEmail(env, { to: email, subject: tpl.subject, html: tpl.html, text: tpl.text });
  }

  await logAudit(env, request, admin, {
    action: sendInvite ? "invite" : "register",
    entityType: "user",
    entityId: id,
    changes: { email, name, position, emailSent: emailed },
  });

  return json({ ok: true, id, emailSent: emailed, invited: sendInvite });
};
