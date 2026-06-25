import { Hono } from "hono";
import type { Env } from "../types";
import { generateToken, hashPassword, isoIn } from "../services/auth";
import { validatePasswordStrength } from "../services/passwordStrength";
import { requirePermission } from "../middleware/auth";
import {
  sendEmail,
  publicUrl,
  inviteEmailHtml,
  resetEmailHtml,
} from "../services/email";
import { syncSalesRepFromUser } from "../services/salesTeam";
import { audit } from "../services/audit";
import { getBranding } from "../services/branding";
import { getDb } from "../db/client";
import {
  departments,
  invitations,
  lorries,
  password_resets,
  positions,
  project_brands,
  roles,
  sessions,
  user_brands,
  user_departments,
  users,
} from "../db/schema";
import { alias } from "drizzle-orm/pg-core";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

// Auto-provision a member's PERSONAL Mail Center mailbox when their email_alias
// is set/changed to a company-domain address (owner: "成员设 alias 就自动建箱").
// Idempotent: ensures one email_addresses row (assigned to the user, active) +
// one email_address_access grant. Fires ONLY for an alias on the company's own
// verified domain — a personal gmail/etc. can't send/receive through our IMAP +
// Resend, so we never mint a dead mailbox. Raw SQL: the mail tables live outside
// the Drizzle schema (managed the same way in routes/mail-center.ts).
async function ensurePersonalMailbox(
  env: Env,
  userId: number,
  aliasAddr: string,
): Promise<void> {
  const addr = (aliasAddr ?? "").trim().toLowerCase();
  if (!addr || !addr.includes("@")) return;
  let domain = "houzscentury.com";
  try {
    const b = await getBranding(env);
    domain = (b.email.split("@")[1] || domain).trim().toLowerCase();
  } catch {
    /* fall back to the default company domain */
  }
  if (!addr.endsWith(`@${domain}`)) return;

  const db = env.DB;
  const nameRow = await db
    .prepare(`SELECT name FROM users WHERE id = ? LIMIT 1`)
    .bind(userId)
    .first<{ name: string | null }>()
    .catch(() => null);
  const label = nameRow?.name?.trim() || null;

  const existing = await db
    .prepare(`SELECT id FROM email_addresses WHERE lower(address) = ? LIMIT 1`)
    .bind(addr)
    .first<{ id: string }>()
    .catch(() => null);

  let addressId: string;
  if (existing?.id) {
    addressId = existing.id;
    await db
      .prepare(
        `UPDATE email_addresses SET assigned_user_id = ?, active = 1 WHERE id = ?`,
      )
      .bind(userId, addressId)
      .run()
      .catch(() => {});
  } else {
    addressId = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO email_addresses
           (id, address, label, assigned_user_id, assigned_user_name,
            assigned_dept, assigned_position, active, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, 1, ?, ?)`,
      )
      .bind(addressId, addr, label, userId, label, new Date().toISOString(), userId)
      .run()
      .catch(() => {});
  }

  // Idempotent grant — a unique (address_id,user_id) collision just throws,
  // which we swallow (the grant already exists).
  await db
    .prepare(
      `INSERT INTO email_address_access (id, address_id, user_id, created_at, created_by)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(crypto.randomUUID(), addressId, userId, new Date().toISOString(), userId)
    .run()
    .catch(() => {});
}

const app = new Hono<{ Bindings: Env }>();

const INVITE_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 days
const RESET_TTL_SECONDS = 60 * 60; // 1 hour — password reset should expire fast

/**
 * GET /api/users
 * List all team members. Requires users.read.
 *
 * Optional ?brand=<x> narrows the list to users with that brand in
 * their user_brands row set (mig 049). Used by the project PIC picker.
 *
 * Optional ?department=<name> narrows to users whose PRIMARY department
 * name matches case-insensitively (contains). Used by the project PIC +
 * Sales-attending pickers, which list all Sales-department members
 * regardless of brand (owner: Option A). Prod's dept is "Sales Department",
 * so the match is a substring (ILIKE %name%), not equality.
 */
app.get("/", requirePermission("users.read"), async (c) => {
  const brand = (c.req.query("brand") || "").trim();
  const department = (c.req.query("department") || "").trim();
  const db = getDb(c.env);
  const manager = alias(users, "m");
  const inviter = alias(users, "ib");

  const conds: any[] = [];
  if (brand) {
    // EXISTS-on-user_brands narrows the list without exploding rows
    // through a JOIN.
    conds.push(
      sql`EXISTS (SELECT 1 FROM ${user_brands} ub
                   WHERE ub.user_id = ${users.id}
                     AND ub.brand = ${brand})`
    );
  }
  if (department) {
    // Match the user's primary department by name, case-insensitively and
    // by substring so "Sales" matches the prod "Sales Department" row.
    conds.push(
      sql`EXISTS (SELECT 1 FROM ${departments} d2
                   WHERE d2.id = ${users.department_id}
                     AND d2.name ILIKE ${"%" + department + "%"})`
    );
  }

  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      status: users.status,
      status_reason: users.status_reason,
      role_id: users.role_id,
      role_name: roles.name,
      manager_id: users.manager_id,
      manager_name: manager.name,
      manager_email: manager.email,
      department_id: users.department_id,
      department_name: departments.name,
      department_color: departments.color,
      division: users.division,
      position_id: users.position_id,
      position_name: positions.name,
      invited_at: users.invited_at,
      invited_by: users.invited_by,
      invited_by_name: inviter.name,
      invited_by_email: inviter.email,
      joined_at: users.joined_at,
      last_login_at: users.last_login_at,
      created_at: users.created_at,
      profile_pic_r2_key: users.profile_pic_r2_key,
      phone: users.phone,
      email_alias: users.email_alias,
      // GROUP_CONCAT joins the user's brand allow-list in one round-trip.
      // Unit-separator (US, 0x1f) keeps multi-word brands ("MY SOFA
      // FACTORY") splittable client-side without ambiguity.
      brands_concat: sql<string | null>`(
        SELECT string_agg(ub.brand, chr(31))
          FROM ${user_brands} ub
         WHERE ub.user_id = ${users.id}
      )`,
      // Full department membership set (mig 0020). The primary department_id is
      // one of these; we re-add it below so legacy rows not yet backfilled are
      // still reported as members of their primary.
      department_ids_arr: sql<number[] | null>`(
        SELECT array_agg(ud.department_id)
          FROM ${user_departments} ud
         WHERE ud.user_id = ${users.id}
      )`,
    })
    .from(users)
    .innerJoin(roles, eq(roles.id, users.role_id))
    .leftJoin(manager, eq(manager.id, users.manager_id))
    .leftJoin(departments, eq(departments.id, users.department_id))
    .leftJoin(positions, eq(positions.id, users.position_id))
    .leftJoin(inviter, eq(inviter.id, users.invited_by))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(users.created_at));

  const out = rows.map((r) => {
    // Primary first, then any extra departments sorted — drives the "+N" UI.
    const arr = Array.isArray(r.department_ids_arr) ? r.department_ids_arr : [];
    const extra = arr
      .map((d) => Number(d))
      .filter((d) => Number.isFinite(d) && d !== r.department_id)
      .sort((a, b) => a - b);
    const department_ids =
      r.department_id != null ? [r.department_id, ...extra] : extra;
    return {
      ...r,
      brands: r.brands_concat
        ? String(r.brands_concat).split("\x1f").filter(Boolean)
        : [],
      brands_concat: undefined,
      department_ids,
      department_ids_arr: undefined,
    };
  });
  return c.json({ users: out });
});

/**
 * GET /api/users/:id/brands
 * Per-user brand allow-list (mig 049).
 */
app.get("/:id/brands", requirePermission("users.read"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Bad id" }, 400);
  const db = getDb(c.env);
  const rows = await db
    .select({ brand: user_brands.brand })
    .from(user_brands)
    .where(eq(user_brands.user_id, id));
  return c.json({ brands: rows.map((r) => r.brand) });
});

/**
 * PUT /api/users/:id/brands
 * Body: { brands: string[] }  replace-set semantics, validated against
 * project_brands.name (silent-drop unknowns).
 */
app.put("/:id/brands", requirePermission("users.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Bad id" }, 400);

  const body = await c.req.json<{ brands?: unknown }>();
  const incoming = Array.isArray(body.brands) ? body.brands : [];
  const requested = incoming
    .filter((x): x is string => typeof x === "string" && x.trim() !== "")
    .map((s) => s.trim());

  const db = getDb(c.env);
  const target = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  if (target.length === 0) return c.json({ error: "User not found" }, 404);

  // Validate against the canonical brand list. Active OR inactive — an
  // archived brand still scopes existing projects until manually
  // removed; we just don't show it in the new picker.
  let valid: string[] = [];
  if (requested.length > 0) {
    const r = await db
      .select({ name: project_brands.name })
      .from(project_brands)
      .where(inArray(project_brands.name, requested));
    const allowed = new Set(r.map((x) => x.name));
    valid = requested.filter((b) => allowed.has(b));
  }

  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM user_brands WHERE user_id = ?`).bind(id),
    ...valid.map((b) =>
      c.env.DB
        .prepare(`INSERT INTO user_brands (user_id, brand) VALUES (?, ?)`)
        .bind(id, b)
    ),
  ]);

  return c.json({ ok: true, brands: valid });
});

/**
 * GET /api/users/:id/activity
 * Recent audit_events touching this member, newest first — powers the
 * change-history panel on the member detail page. Two angles in one query:
 * what the user DID (actor_id = id) and what was done TO them
 * (entity_type='user' AND entity_id = id). Read via raw SQL like routes/audit.ts
 * — audit_events has no Drizzle table in schema.ts. Never errors on a missing
 * table: if the ledger isn't there yet the panel just shows no history.
 */
app.get("/:id/activity", requirePermission("users.read"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Bad id" }, 400);
  const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 200);

  try {
    const rows = await c.env.DB.prepare(
      `SELECT id, created_at, actor_id, actor_email, action, entity_type, entity_id, summary, meta, ip, request_id
         FROM audit_events
        WHERE actor_id = ? OR (entity_type = 'user' AND entity_id = ?)
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
      .bind(id, String(id), limit)
      .all();
    return c.json({ activity: rows.results });
  } catch {
    // Ledger absent or unreadable — degrade to empty rather than 500.
    return c.json({ activity: [] });
  }
});

// ── Profile pictures (mig 058) ─────────────────────────────────
// Image bytes live in R2 (POD_BUCKET); the DB row carries the key.
// Upload writes the user's own pic; GET streams the bytes back through
// the worker so <img> can display it via blob URL despite needing the
// bearer token — same pattern as award images and POD photos.

/**
 * PUT /api/users/me/profile-pic
 * Raw binary upload of the caller's own profile picture. The optional
 * `?name=` query carries the original filename so the R2 key keeps a
 * recognisable extension.
 */
app.put("/me/profile-pic", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const filename = c.req.query("name") || `profile-${Date.now()}.bin`;
  const contentType =
    c.req.header("content-type") || "application/octet-stream";
  const buf = await c.req.arrayBuffer();
  if (!buf.byteLength) return c.json({ error: "Empty body" }, 400);
  if (buf.byteLength > 5 * 1024 * 1024) {
    return c.json({ error: "Image must be under 5 MB" }, 413);
  }

  const key = `user/${user.id}/${Date.now()}-${filename.replace(/[^\w.\-]+/g, "_")}`;
  await c.env.POD_BUCKET.put(key, buf, {
    httpMetadata: { contentType },
  });

  await c.env.DB.prepare(
    `UPDATE users SET profile_pic_r2_key = ? WHERE id = ?`,
  )
    .bind(key, user.id)
    .run();

  return c.json({ ok: true, profile_pic_r2_key: key });
});

/**
 * DELETE /api/users/me/profile-pic
 * Clears the caller's profile picture pointer. The R2 object is left
 * in place — orphans are cheap and keeping them allows undo via the
 * raw key if a user ever asks.
 */
app.delete("/me/profile-pic", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  await c.env.DB.prepare(
    `UPDATE users SET profile_pic_r2_key = NULL WHERE id = ?`,
  )
    .bind(user.id)
    .run();
  return c.json({ ok: true });
});

/**
 * GET /api/users/:id/profile-pic
 * Streams the user's profile pic bytes from R2. Any authed user can
 * view any other authed user's pic — the data is "this is what so-and-so
 * looks like", not sensitive. 404 when no pic is set.
 */
app.get("/:id/profile-pic", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(id)) return c.json({ error: "Bad id" }, 400);
  const row = await c.env.DB.prepare(
    `SELECT profile_pic_r2_key FROM users WHERE id = ?`,
  )
    .bind(id)
    .first<{ profile_pic_r2_key: string | null }>();
  if (!row?.profile_pic_r2_key) {
    return c.json({ error: "No profile picture" }, 404);
  }
  const obj = await c.env.POD_BUCKET.get(row.profile_pic_r2_key);
  if (!obj) return c.json({ error: "Image missing" }, 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("cache-control", "private, max-age=300");
  return new Response(obj.body, { headers });
});

/**
 * PUT /api/users/:id/profile-pic  (admin)
 * Upload/replace another member's avatar. Mirrors /me/profile-pic but is
 * keyed on the path id and gated on users.manage.
 */
app.put("/:id/profile-pic", requirePermission("users.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(id)) return c.json({ error: "Bad id" }, 400);
  const filename = c.req.query("name") || `profile-${Date.now()}.bin`;
  const contentType = c.req.header("content-type") || "application/octet-stream";
  const buf = await c.req.arrayBuffer();
  if (!buf.byteLength) return c.json({ error: "Empty body" }, 400);
  if (buf.byteLength > 5 * 1024 * 1024) {
    return c.json({ error: "Image must be under 5 MB" }, 413);
  }
  const key = `user/${id}/${Date.now()}-${filename.replace(/[^\w.\-]+/g, "_")}`;
  await c.env.POD_BUCKET.put(key, buf, { httpMetadata: { contentType } });
  const res = await c.env.DB.prepare(
    `UPDATE users SET profile_pic_r2_key = ? WHERE id = ?`,
  )
    .bind(key, id)
    .run();
  if (!res.meta.changes) return c.json({ error: "User not found" }, 404);
  return c.json({ ok: true, profile_pic_r2_key: key });
});

/**
 * POST /api/users/invite
 * Body: { email, role_id }
 * Creates a placeholder user (status='invited') and a fresh invitation
 * token. Returns the token so the caller can copy it into a chat / email.
 */
app.post("/invite", requirePermission("users.manage"), async (c) => {
  const me = c.get("user");
  const body = await c.req.json<{
    email: string;
    role_id: number;
    name?: string;
    department_id?: number | null;
    position_id?: number | null;
    manager_id?: number | null;
    phone?: string | null;
    // When provided, the admin is setting an initial password and the account
    // is created ACTIVE — no invite link / accept step. The member signs in
    // with email + this password and can change it later.
    password?: string;
  }>();
  if (!body.email || !body.role_id) {
    return c.json({ error: "email and role_id are required" }, 400);
  }
  const email = body.email.toLowerCase().trim();
  const name = body.name?.trim() || null;

  // Direct-provision path: admin sets the password now → active account.
  const directPassword = body.password?.trim() || null;
  let passwordHash: string | null = null;
  if (directPassword) {
    const strength = validatePasswordStrength(directPassword, email);
    if (!strength.ok) return c.json({ error: strength.error }, 400);
    passwordHash = await hashPassword(directPassword);
  }
  const activate = !!passwordHash;

  const db = getDb(c.env);

  const role = await db
    .select({ id: roles.id, name: roles.name })
    .from(roles)
    .where(eq(roles.id, body.role_id))
    .limit(1);
  if (role.length === 0) return c.json({ error: "Role not found" }, 404);

  // Org dimensions (mig 094). If a position is given, validate it and default
  // the department from it when the department wasn't passed explicitly.
  let departmentId = body.department_id ?? null;
  const positionId = body.position_id ?? null;
  const managerId = body.manager_id ?? null;
  if (positionId) {
    const pos = await db
      .select({ id: positions.id, department_id: positions.department_id })
      .from(positions)
      .where(eq(positions.id, positionId))
      .limit(1);
    if (pos.length === 0) return c.json({ error: "Position not found" }, 404);
    if (departmentId && pos[0].department_id && pos[0].department_id !== departmentId) {
      return c.json(
        { error: "Position does not belong to the selected department" },
        400,
      );
    }
    if (!departmentId && pos[0].department_id) departmentId = pos[0].department_id;
  }

  const existing = await db
    .select({ id: users.id, status: users.status })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (existing.length > 0 && existing[0].status === "active") {
    return c.json({ error: "A user with that email already exists" }, 409);
  }

  // Create or refresh the placeholder user. Name is preset here ("the
  // Position concept") so the invitee lands with their identity already
  // set; they can still adjust it when accepting.
  if (existing.length === 0) {
    await db.insert(users).values({
      email,
      name,
      role_id: body.role_id,
      department_id: departmentId,
      position_id: positionId,
      manager_id: managerId,
      phone: body.phone?.trim() || null,
      status: activate ? "active" : "invited",
      invited_by: me.id || null,
      ...(activate
        ? {
            password_hash: passwordHash,
            joined_at: sql`to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS')` as unknown as string,
          }
        : {
            invited_at: sql`to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS')` as unknown as string,
          }),
    });
  } else {
    // Re-invite — bump role and reset invited_at, drop any old token.
    // Only overwrite the name when a new one was supplied.
    await db
      .update(users)
      .set({
        ...(name ? { name } : {}),
        role_id: body.role_id,
        department_id: departmentId,
        position_id: positionId,
        manager_id: managerId,
        ...(body.phone !== undefined ? { phone: body.phone?.trim() || null } : {}),
        status: activate ? "active" : "invited",
        invited_by: me.id || null,
        ...(activate
          ? {
              password_hash: passwordHash,
              joined_at: sql`to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS')` as unknown as string,
            }
          : {
              invited_at: sql`to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS')` as unknown as string,
            }),
      })
      .where(eq(users.email, email));
    await db
      .delete(invitations)
      .where(and(eq(invitations.email, email), isNull(invitations.accepted_at)));
  }

  // Admin set a password → the account is live now; no invite token/email.
  if (activate) {
    await audit(c, {
      action: "user.create",
      entityType: "user",
      entityId: email,
      summary: `Created ${email} as ${role[0].name} (active — password set by admin)`,
      meta: {
        email,
        role_id: body.role_id,
        department_id: departmentId,
        position_id: positionId,
        manager_id: managerId,
        activated: true,
      },
    });
    return c.json({ active: true, email });
  }

  // Issue a fresh invitation token.
  const token = generateToken();
  const expires = isoIn(INVITE_TTL_SECONDS);
  const inserted = await db
    .insert(invitations)
    .values({
      email,
      role_id: body.role_id,
      token,
      invited_by: me.id || 0,
      expires_at: expires,
      department_id: departmentId,
      position_id: positionId,
      manager_id: managerId,
    })
    .returning({ id: invitations.id });
  const invitationId = inserted[0]?.id ?? null;

  // Email the invitation. The link is built server-side from
  // PUBLIC_APP_URL so it always carries the canonical domain no matter
  // which origin the admin's browser is on. sendEmail() never throws —
  // when the channel/key is off we still hand back the link for
  // copy-paste, and the UI shows the delivery status.
  const invite_url = publicUrl(c.env, `/invite/${token}`);
  const sendResult = await sendEmail(c.env, {
    to: email,
    subject: "You're invited to Houzs ERP",
    html: inviteEmailHtml({
      link: invite_url,
      roleName: role[0].name,
      inviterName: me?.name || me?.email || "Your admin",
      expiresIn: "14 days",
    }),
    purpose: "member_invite",
    refType: "invitation",
    refId: invitationId,
  });

  await audit(c, {
    action: "user.invite",
    entityType: "user",
    entityId: email,
    summary: `Invited ${email} as ${role[0].name}`,
    meta: {
      email,
      role_id: body.role_id,
      department_id: departmentId,
      position_id: positionId,
      manager_id: managerId,
      email_status: sendResult.status,
    },
  });

  return c.json({
    token,
    expires_at: expires,
    email,
    invite_url,
    email_sent: sendResult.status === "sent",
    email_status: sendResult.status,
  });
});

/**
 * POST /api/users/invitations/:id/resend
 * Re-send the invitation email for a still-pending invite. Keeps the
 * same token (the link already shared stays valid); only the email is
 * fired again.
 */
app.post(
  "/invitations/:id/resend",
  requirePermission("users.manage"),
  async (c) => {
    const id = parseInt(c.req.param("id"), 10);
    if (!id) return c.json({ error: "Bad id" }, 400);
    const me = c.get("user");

    const db = getDb(c.env);
    const rows = await db
      .select({
        id: invitations.id,
        email: invitations.email,
        token: invitations.token,
        expires_at: invitations.expires_at,
        accepted_at: invitations.accepted_at,
        role_name: roles.name,
      })
      .from(invitations)
      .innerJoin(roles, eq(roles.id, invitations.role_id))
      .where(eq(invitations.id, id))
      .limit(1);
    if (rows.length === 0) return c.json({ error: "Invitation not found" }, 404);
    const inv = rows[0];
    if (inv.accepted_at) {
      return c.json({ error: "Invitation was already accepted" }, 409);
    }
    if (inv.expires_at < new Date().toISOString()) {
      return c.json(
        { error: "Invitation has expired — issue a new one instead" },
        410
      );
    }

    const invite_url = publicUrl(c.env, `/invite/${inv.token}`);
    const sendResult = await sendEmail(c.env, {
      to: inv.email,
      subject: "You're invited to Houzs ERP",
      html: inviteEmailHtml({
        link: invite_url,
        roleName: inv.role_name,
        inviterName: me?.name || me?.email || "Your admin",
        expiresIn: "14 days",
      }),
      purpose: "member_invite",
      refType: "invitation",
      refId: inv.id,
    });

    return c.json({
      ok: true,
      invite_url,
      email_sent: sendResult.status === "sent",
      email_status: sendResult.status,
    });
  }
);

/**
 * PATCH /api/users/:id
 * Body: { role_id?, status?, manager_id?, department_id? }
 * Update a team member's role, enable/disable, reassign manager or
 * department.
 */
app.patch("/:id", requirePermission("users.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const me = c.get("user");
  if (!id) return c.json({ error: "Bad id" }, 400);

  // Block self-modification of own role/status to avoid lockout.
  if (id === me.id) {
    return c.json({ error: "You cannot modify your own role or status" }, 400);
  }

  const body = await c.req.json<{
    role_id?: number;
    status?: string;
    manager_id?: number | null;
    department_id?: number | null;
    department_ids?: number[];
    position_id?: number | null;
    division?: string | null;
    name?: string | null;
    phone?: string | null;
    email?: string;
    email_alias?: string | null;
    status_reason?: string | null;
    // Admin-set/reset password (users.manage). Hashed; never stored plaintext.
    password?: string;
  }>();

  const db = getDb(c.env);

  // Current primary department doubles as an existence check (the membership
  // reconciliation below can run with an otherwise-empty column update).
  const current = await db
    .select({ id: users.id, email: users.email, department_id: users.department_id })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  if (current.length === 0) return c.json({ error: "User not found" }, 404);

  const set: Record<string, any> = {};

  if (body.role_id != null) {
    const role = await db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.id, body.role_id))
      .limit(1);
    if (role.length === 0) return c.json({ error: "Role not found" }, 404);
    set.role_id = body.role_id;
  }

  if (body.status != null) {
    if (!["active", "disabled"].includes(body.status)) {
      return c.json({ error: "status must be active or disabled" }, 400);
    }
    set.status = body.status;
  }

  // Reason note tracks WHY an account was disabled. Re-enabling clears it;
  // otherwise an explicit reason is stored when provided.
  if (body.status === "active") {
    set.status_reason = null;
  } else if (body.status_reason !== undefined) {
    set.status_reason = body.status_reason?.trim() || null;
  }

  // Org-chart division — free-text sub-grouping within a department (mig 0021).
  if (body.division !== undefined) {
    set.division = body.division?.trim() || null;
  }

  // Admin sets / resets the member's password. Validated + hashed; an empty
  // value is ignored (so saving the panel without touching it keeps the old one).
  if (body.password) {
    const strength = validatePasswordStrength(body.password, current[0].email);
    if (!strength.ok) return c.json({ error: strength.error }, 400);
    set.password_hash = await hashPassword(body.password);
  }

  if (body.manager_id !== undefined) {
    if (body.manager_id === null) {
      set.manager_id = null;
    } else {
      const mgr = parseInt(String(body.manager_id), 10);
      if (!mgr) return c.json({ error: "Invalid manager_id" }, 400);
      if (mgr === id) return c.json({ error: "Cannot report to yourself" }, 400);
      // Cycle check: walk the prospective manager's chain — if this user
      // is anywhere in it, the assignment would create a loop.
      let cursor: number | null = mgr;
      const seen = new Set<number>();
      while (cursor != null) {
        if (cursor === id) {
          return c.json(
            { error: "Cycle detected — that user reports to you (directly or indirectly)" },
            400
          );
        }
        if (seen.has(cursor)) break; // defensive — existing bad data
        seen.add(cursor);
        const mgrRow = await db
          .select({ manager_id: users.manager_id })
          .from(users)
          .where(eq(users.id, cursor))
          .limit(1);
        if (mgrRow.length === 0) return c.json({ error: "Manager not found" }, 404);
        cursor = mgrRow[0].manager_id;
      }
      set.manager_id = mgr;
    }
  }

  if (body.department_id !== undefined) {
    if (body.department_id === null) {
      set.department_id = null;
    } else {
      const dept = parseInt(String(body.department_id), 10);
      if (!dept) return c.json({ error: "Invalid department_id" }, 400);
      const exists = await db
        .select({ id: departments.id })
        .from(departments)
        .where(eq(departments.id, dept))
        .limit(1);
      if (exists.length === 0) return c.json({ error: "Department not found" }, 404);
      set.department_id = dept;
    }
  }

  if (body.position_id !== undefined) {
    if (body.position_id === null) {
      set.position_id = null;
    } else {
      const posId = parseInt(String(body.position_id), 10);
      if (!posId) return c.json({ error: "Invalid position_id" }, 400);
      const pos = await db
        .select({ id: positions.id, department_id: positions.department_id })
        .from(positions)
        .where(eq(positions.id, posId))
        .limit(1);
      if (pos.length === 0) return c.json({ error: "Position not found" }, 404);
      set.position_id = posId;
      // Keep department in lockstep with the position when the patch didn't
      // set one explicitly.
      if (body.department_id === undefined && pos[0].department_id) {
        set.department_id = pos[0].department_id;
      }
    }
  }

  // Personal info — editable from the Edit Member panel.
  if (body.name !== undefined) {
    set.name = body.name?.trim() || null;
  }
  if (body.phone !== undefined) {
    set.phone = body.phone?.trim() || null;
  }
  // The member's outward Mail Center alias. Normalised lowercase; empty → null.
  if (body.email_alias !== undefined) {
    set.email_alias = body.email_alias?.trim().toLowerCase() || null;
  }
  if (body.email !== undefined) {
    const em = String(body.email).toLowerCase().trim();
    if (!em || !em.includes("@")) {
      return c.json({ error: "Invalid email" }, 400);
    }
    const clash = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, em))
      .limit(1);
    if (clash.length && clash[0].id !== id) {
      return c.json({ error: "A user with that email already exists" }, 409);
    }
    set.email = em;
  }

  // Multi-department membership (mig 0020). When department_ids is provided we
  // replace-set the join table; otherwise we just keep the primary in sync.
  // Validate each id against departments (silent-drop unknowns, like brands).
  let finalDeptIds: number[] | null = null;
  if (Array.isArray(body.department_ids)) {
    const requested = [
      ...new Set(
        body.department_ids
          .map((x) => parseInt(String(x), 10))
          .filter((n) => Number.isFinite(n) && n > 0),
      ),
    ];
    if (requested.length > 0) {
      const found = await db
        .select({ id: departments.id })
        .from(departments)
        .where(inArray(departments.id, requested));
      const allowed = new Set(found.map((d) => d.id));
      finalDeptIds = requested.filter((d) => allowed.has(d));
    } else {
      finalDeptIds = [];
    }

    // Reconcile against the primary. If a primary is set (this patch or the
    // existing one), force it into the set; if the primary was cleared, promote
    // the first of the set to primary so the two never drift apart.
    const primaryDept =
      "department_id" in set
        ? (set.department_id as number | null)
        : current[0].department_id;
    if (primaryDept != null) {
      if (!finalDeptIds.includes(primaryDept)) finalDeptIds.unshift(primaryDept);
    } else if (finalDeptIds.length > 0) {
      set.department_id = finalDeptIds[0];
    }
  }

  if (Object.keys(set).length === 0 && finalDeptIds === null) {
    return c.json({ error: "No fields to update" }, 400);
  }

  if (Object.keys(set).length > 0) {
    const result = await db.update(users).set(set).where(eq(users.id, id));
    if (!result.count) return c.json({ error: "User not found" }, 404);
  }

  // When the alias was set to a company-domain address, auto-provision the
  // member's personal Mail Center mailbox + access grant (owner ask). Non-fatal.
  if (
    body.email_alias !== undefined &&
    typeof set.email_alias === "string" &&
    set.email_alias
  ) {
    await ensurePersonalMailbox(c.env, id, set.email_alias).catch((e) =>
      console.error("[users] ensurePersonalMailbox failed:", e),
    );
  }

  // Apply the membership change.
  if (finalDeptIds !== null) {
    await db.delete(user_departments).where(eq(user_departments.user_id, id));
    if (finalDeptIds.length > 0) {
      await db
        .insert(user_departments)
        .values(finalDeptIds.map((d) => ({ user_id: id, department_id: d })));
    }
  } else if ("department_id" in set) {
    if (set.department_id != null) {
      // Primary changed (directly or via position lockstep) — keep it present
      // in the membership table, preserving any extras already there.
      await db
        .insert(user_departments)
        .values({ user_id: id, department_id: set.department_id })
        .onConflictDoNothing();
    } else if (current[0].department_id != null) {
      // Primary cleared — drop just that membership, leave extras intact.
      await db
        .delete(user_departments)
        .where(
          and(
            eq(user_departments.user_id, id),
            eq(user_departments.department_id, current[0].department_id),
          ),
        );
    }
  }

  // If we disabled a user, revoke their sessions.
  if (body.status === "disabled") {
    await db.delete(sessions).where(eq(sessions.user_id, id));
  }

  // Keep the Sales Team roster in lockstep with the user's PRIMARY department.
  // Department change → create / unarchive / archive the linked sales_reps row.
  // No-op for non-Sales departments and already-consistent users. Multi-dept
  // membership is orthogonal — sync stays keyed on the single primary.
  if (body.department_id !== undefined || set.department_id !== undefined) {
    await syncSalesRepFromUser(c.env, id, me.id);
  }

  const changedKeys = [
    ...Object.keys(set),
    ...(finalDeptIds !== null ? ["department_ids"] : []),
  ];
  await audit(c, {
    action: "user.update",
    entityType: "user",
    entityId: id,
    summary: `Updated user #${id} (${changedKeys.join(", ")})`,
    meta: { changed: set, ...(finalDeptIds !== null ? { department_ids: finalDeptIds } : {}) },
  });

  return c.json({ ok: true });
});

/**
 * DELETE /api/users/:id[?hard=1]
 *
 * Default (no `?hard=1`): soft-delete — status='disabled', sessions
 * revoked, default-driver clears. Preserves FK references in trips,
 * sales, etc. This is the right call for established users.
 *
 * `?hard=1`: true hard delete. Cleans up CASCADE-safe rows manually
 * for tables that lack ON DELETE CASCADE (sessions, invitations,
 * driver_clock_entries, lorry_incidents, etc.), then `DELETE FROM
 * users`. If a non-cascading FK reference remains (e.g. sales_entries
 * created_by, trips driver_user_id), the FK constraint trips and we
 * return a helpful message naming what blocks the delete. Use this
 * for never-used test accounts. For users with real activity, use
 * the soft-delete (Disable) path instead.
 */
app.delete("/:id", requirePermission("users.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const me = c.get("user");
  const hard = c.req.query("hard") === "1";
  if (!id) return c.json({ error: "Bad id" }, 400);
  if (id === me.id) return c.json({ error: "You cannot delete yourself" }, 400);

  const db = getDb(c.env);
  const row = await db
    .select({
      id: users.id,
      email: users.email,
      status: users.status,
      role_name: roles.name,
    })
    .from(users)
    .innerJoin(roles, eq(roles.id, users.role_id))
    .where(eq(users.id, id))
    .limit(1);
  if (row.length === 0) return c.json({ error: "User not found" }, 404);
  const target = row[0];

  if (target.role_name === "Owner") {
    const owners = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(users)
      .innerJoin(roles, eq(roles.id, users.role_id))
      .where(and(eq(roles.name, "Owner"), eq(users.status, "active")));
    if ((owners[0]?.count ?? 0) <= 1) {
      return c.json({ error: "Cannot remove the last Owner" }, 400);
    }
  }

  // Revoke sessions (any path)
  await db.delete(sessions).where(eq(sessions.user_id, id));

  // Hard-delete path — either explicit ?hard=1 or never-joined user.
  if (hard || target.status === "invited") {
    // Best-effort cleanup of tables whose FK to users(id) is missing
    // ON DELETE CASCADE/SET NULL, so the final DELETE doesn't trip.
    // Tables that already cascade (project_reads, password_resets,
    // user_brands) are not touched here — SQLite handles them.
    await db.delete(invitations).where(eq(invitations.email, target.email));
    await c.env.DB.prepare(`UPDATE lorries SET default_driver_user_id = NULL WHERE default_driver_user_id = ?`).bind(id).run();
    // Be defensive — only run these if the tables exist on the deployed schema.
    // SQLite's "no such table" errors get swallowed for tables that haven't
    // shipped yet (cron-only / future migrations).
    const safeExec = async (sql: string) => {
      try { await c.env.DB.prepare(sql).bind(id).run(); } catch {}
    };
    // Audit / chat / activity — historically tied to a user_id but the user
    // record is the source of truth. If you hard-delete, the audit is lost.
    await safeExec(`DELETE FROM project_activity WHERE user_id = ?`);
    await safeExec(`DELETE FROM project_reads WHERE user_id = ?`);
    // Engagement (Houzs Points + Awards + Idea boxes). Hard-deleting a user
    // wipes their ledger; this is what the caller is asking for.
    await safeExec(`DELETE FROM point_transactions WHERE user_id = ? OR counterparty_user_id = ?`);
    await safeExec(`DELETE FROM user_streak_weeks WHERE user_id = ?`);
    await safeExec(`DELETE FROM award_redemptions WHERE user_id = ?`);

    try {
      await db.delete(users).where(eq(users.id, id));
    } catch (e: any) {
      const msg = String(e?.message ?? e ?? "");
      if (/FOREIGN KEY|SQLITE_CONSTRAINT/i.test(msg)) {
        return c.json(
          {
            error:
              "Cannot hard-delete: this user is referenced by trips, sales entries, or other records. Disable the user instead (soft-delete) to preserve those rows.",
            detail: msg,
          },
          400,
        );
      }
      throw e;
    }
    await audit(c, {
      action: "user.delete",
      entityType: "user",
      entityId: id,
      summary: `Hard-deleted user ${target.email} (#${id})`,
      meta: { email: target.email, role: target.role_name, hard: true },
    });
    return c.json({ ok: true, action: "deleted" });
  }

  // Soft-delete (default for joined users).
  await db.update(users).set({ status: "disabled" }).where(eq(users.id, id));

  // Clear default_driver on lorries
  await db
    .update(lorries)
    .set({ default_driver_user_id: null })
    .where(eq(lorries.default_driver_user_id, id));

  await audit(c, {
    action: "user.disable",
    entityType: "user",
    entityId: id,
    summary: `Disabled user ${target.email} (#${id})`,
    meta: { email: target.email, role: target.role_name },
  });

  return c.json({ ok: true, action: "disabled" });
});

/**
 * GET /api/users/invitations
 * Pending invitations.
 */
app.get("/invitations", requirePermission("users.read"), async (c) => {
  const db = getDb(c.env);
  const inviter = alias(users, "ib");
  const rows = await db
    .select({
      id: invitations.id,
      email: invitations.email,
      role_id: invitations.role_id,
      role_name: roles.name,
      token: invitations.token,
      expires_at: invitations.expires_at,
      created_at: invitations.created_at,
      accepted_at: invitations.accepted_at,
      invited_by_email: inviter.email,
      // Latest delivery outcome from email_log so the UI can show
      // "emailed" vs an amber "not sent" without a schema change.
      email_status: sql<string | null>`(
        SELECT el.status FROM email_log el
         WHERE el.ref_type = 'invitation' AND el.ref_id = ${invitations.id}
         ORDER BY el.id DESC LIMIT 1
      )`,
      emailed_at: sql<string | null>`(
        SELECT el.created_at FROM email_log el
         WHERE el.ref_type = 'invitation' AND el.ref_id = ${invitations.id}
           AND el.status = 'sent'
         ORDER BY el.id DESC LIMIT 1
      )`,
    })
    .from(invitations)
    .innerJoin(roles, eq(roles.id, invitations.role_id))
    .leftJoin(inviter, eq(inviter.id, invitations.invited_by))
    .where(isNull(invitations.accepted_at))
    .orderBy(desc(invitations.created_at));
  return c.json({
    invitations: rows.map((r) => ({
      ...r,
      invite_url: publicUrl(c.env, `/invite/${r.token}`),
    })),
  });
});

/**
 * DELETE /api/users/invitations/:id
 * Revoke a pending invitation.
 */
app.delete("/invitations/:id", requirePermission("users.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Bad id" }, 400);

  const db = getDb(c.env);
  const inv = await db
    .select({ email: invitations.email })
    .from(invitations)
    .where(eq(invitations.id, id))
    .limit(1);
  if (inv.length === 0) return c.json({ error: "Invitation not found" }, 404);

  // Also clean up the placeholder user if they never accepted.
  await db
    .delete(users)
    .where(and(eq(users.email, inv[0].email), eq(users.status, "invited")));
  await db.delete(invitations).where(eq(invitations.id, id));

  return c.json({ ok: true });
});

/**
 * POST /api/users/:id/reset-password
 * Admin-triggered. Generates a one-hour reset token, optionally emails
 * the user a link. Returns the token so the admin can also copy-paste
 * it (useful when email is down or the user's address is stale).
 */
app.post("/:id/reset-password", requirePermission("users.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Bad id" }, 400);
  const me = c.get("user");

  const db = getDb(c.env);
  const targetRow = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      status: users.status,
    })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  if (targetRow.length === 0) return c.json({ error: "User not found" }, 404);
  const target = targetRow[0];

  if (target.status === "invited") {
    // Invited users haven't set a password yet — the existing invitation
    // flow handles first-time setup. Steering admins at the right tool.
    return c.json(
      { error: "User is still invited — resend the invitation instead." },
      400
    );
  }

  // Invalidate any prior unconsumed reset tokens for this user.
  await db
    .update(password_resets)
    .set({ consumed_at: sql`to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS')` as unknown as string })
    .where(
      and(eq(password_resets.user_id, id), isNull(password_resets.consumed_at))
    );

  const token = generateToken();
  const expiresAt = isoIn(RESET_TTL_SECONDS);
  await db.insert(password_resets).values({
    user_id: id,
    token,
    requested_by: me?.id || null,
    expires_at: expiresAt,
  });

  // Also revoke active sessions so the user has to log in again with
  // the new password.
  await db.delete(sessions).where(eq(sessions.user_id, id));

  // Fire the email. sendEmail() already handles "channel disabled" and
  // "recipient missing" — we still return the token so copy-paste works,
  // and surface the delivery status so the UI can stop claiming "sent"
  // when the channel/key is off.
  const link = publicUrl(c.env, `/reset/${token}`);
  const name = (target.name || target.email.split("@")[0]).split(" ")[0];
  const sendResult = await sendEmail(c.env, {
    to: target.email,
    subject: "Reset your Houzs ERP password",
    html: resetEmailHtml({
      name,
      link,
      expiresIn: "1 hour",
      requestedBy: me?.name || me?.email || "Your admin",
    }),
    purpose: "password_reset",
    refType: "user",
    refId: id,
  });

  await audit(c, {
    action: "user.reset_password",
    entityType: "user",
    entityId: id,
    summary: `Issued password reset for ${target.email} (#${id})`,
    meta: { email: target.email, email_status: sendResult.status },
  });

  return c.json({
    ok: true,
    token,
    reset_path: `/reset/${token}`,
    expires_at: expiresAt,
    email: target.email,
    email_sent: sendResult.status === "sent",
    email_status: sendResult.status,
  });
});

/**
 * POST /api/users/:id/totp/disable
 * Admin recovery path for a user who lost their authenticator (and their
 * backup codes). Clears their 2FA so they can sign in with password alone and
 * re-enroll. The self-service disable (with a code) lives in routes/totp.ts.
 */
app.post("/:id/totp/disable", requirePermission("users.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Bad id" }, 400);

  const db = getDb(c.env);
  const row = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  if (row.length === 0) return c.json({ error: "User not found" }, 404);

  await c.env.DB.prepare(
    `UPDATE users
        SET totp_enabled = 0, totp_secret = NULL,
            totp_enrolled_at = NULL, totp_backup_codes = NULL
      WHERE id = ?`,
  )
    .bind(id)
    .run();

  await audit(c, {
    action: "user.totp.admin_disable",
    entityType: "user",
    entityId: id,
    summary: `Admin cleared 2FA for ${row[0].email} (#${id})`,
    meta: { email: row[0].email },
  });

  return c.json({ ok: true });
});

export default app;
