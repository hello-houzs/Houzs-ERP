import { Hono } from "hono";
import type { Env } from "../types";
import { generateToken, isoIn } from "../services/auth";
import { requirePermission } from "../middleware/auth";
import { sendEmail, publicUrl } from "../services/email";
import { syncSalesRepFromUser } from "../services/salesTeam";
import { getDb } from "../db/client";
import {
  departments,
  invitations,
  lorries,
  password_resets,
  project_brands,
  roles,
  sessions,
  user_brands,
  users,
} from "../db/schema";
import { alias } from "drizzle-orm/pg-core";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

const app = new Hono<{ Bindings: Env }>();

const INVITE_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 days
const RESET_TTL_SECONDS = 60 * 60; // 1 hour — password reset should expire fast

/**
 * GET /api/users
 * List all team members. Requires users.read.
 *
 * Optional ?brand=<x> narrows the list to users with that brand in
 * their user_brands row set (mig 049). Used by the project PIC picker.
 */
app.get("/", requirePermission("users.read"), async (c) => {
  const brand = (c.req.query("brand") || "").trim();
  const db = getDb(c.env);
  const manager = alias(users, "m");

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

  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      status: users.status,
      role_id: users.role_id,
      role_name: roles.name,
      manager_id: users.manager_id,
      manager_name: manager.name,
      manager_email: manager.email,
      department_id: users.department_id,
      department_name: departments.name,
      department_color: departments.color,
      invited_at: users.invited_at,
      joined_at: users.joined_at,
      last_login_at: users.last_login_at,
      created_at: users.created_at,
      profile_pic_r2_key: users.profile_pic_r2_key,
      // GROUP_CONCAT joins the user's brand allow-list in one round-trip.
      // Unit-separator (US, 0x1f) keeps multi-word brands ("MY SOFA
      // FACTORY") splittable client-side without ambiguity.
      brands_concat: sql<string | null>`(
        SELECT string_agg(ub.brand, chr(31))
          FROM ${user_brands} ub
         WHERE ub.user_id = ${users.id}
      )`,
    })
    .from(users)
    .innerJoin(roles, eq(roles.id, users.role_id))
    .leftJoin(manager, eq(manager.id, users.manager_id))
    .leftJoin(departments, eq(departments.id, users.department_id))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(users.created_at));

  const out = rows.map((r) => ({
    ...r,
    brands: r.brands_concat
      ? String(r.brands_concat).split("\x1f").filter(Boolean)
      : [],
    brands_concat: undefined,
  }));
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
 * POST /api/users/invite
 * Body: { email, role_id }
 * Creates a placeholder user (status='invited') and a fresh invitation
 * token. Returns the token so the caller can copy it into a chat / email.
 */
app.post("/invite", requirePermission("users.manage"), async (c) => {
  const me = c.get("user");
  const body = await c.req.json<{ email: string; role_id: number }>();
  if (!body.email || !body.role_id) {
    return c.json({ error: "email and role_id are required" }, 400);
  }
  const email = body.email.toLowerCase().trim();

  const db = getDb(c.env);

  const role = await db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.id, body.role_id))
    .limit(1);
  if (role.length === 0) return c.json({ error: "Role not found" }, 404);

  const existing = await db
    .select({ id: users.id, status: users.status })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (existing.length > 0 && existing[0].status === "active") {
    return c.json({ error: "A user with that email already exists" }, 409);
  }

  // Create or refresh the placeholder user.
  if (existing.length === 0) {
    await db.insert(users).values({
      email,
      role_id: body.role_id,
      status: "invited",
      invited_by: me.id || null,
      invited_at: sql`to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS')` as unknown as string,
    });
  } else {
    // Re-invite — bump role and reset invited_at, drop any old token.
    await db
      .update(users)
      .set({
        role_id: body.role_id,
        status: "invited",
        invited_by: me.id || null,
        invited_at: sql`to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS')` as unknown as string,
      })
      .where(eq(users.email, email));
    await db
      .delete(invitations)
      .where(and(eq(invitations.email, email), isNull(invitations.accepted_at)));
  }

  // Issue a fresh invitation token.
  const token = generateToken();
  const expires = isoIn(INVITE_TTL_SECONDS);
  await db.insert(invitations).values({
    email,
    role_id: body.role_id,
    token,
    invited_by: me.id || 0,
    expires_at: expires,
  });

  return c.json({ token, expires_at: expires, email });
});

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
  }>();

  const db = getDb(c.env);
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

  if (Object.keys(set).length === 0) {
    return c.json({ error: "No fields to update" }, 400);
  }

  const result = await db.update(users).set(set).where(eq(users.id, id));
  if (!(result.count)) return c.json({ error: "User not found" }, 404);

  // If we disabled a user, revoke their sessions.
  if (body.status === "disabled") {
    await db.delete(sessions).where(eq(sessions.user_id, id));
  }

  // Keep the Sales Team roster in lockstep with the user's department.
  // Department change → create / unarchive / archive the linked
  // sales_reps row. No-op for non-Sales departments and users that
  // already have the expected sales_reps state.
  if (body.department_id !== undefined) {
    await syncSalesRepFromUser(c.env, id, me.id);
  }

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
    return c.json({ ok: true, action: "deleted" });
  }

  // Soft-delete (default for joined users).
  await db.update(users).set({ status: "disabled" }).where(eq(users.id, id));

  // Clear default_driver on lorries
  await db
    .update(lorries)
    .set({ default_driver_user_id: null })
    .where(eq(lorries.default_driver_user_id, id));

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
    })
    .from(invitations)
    .innerJoin(roles, eq(roles.id, invitations.role_id))
    .leftJoin(inviter, eq(inviter.id, invitations.invited_by))
    .where(isNull(invitations.accepted_at))
    .orderBy(desc(invitations.created_at));
  return c.json({ invitations: rows });
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
  // "recipient missing" — we still return the token so copy-paste works.
  const link = publicUrl(c.env, `/reset/${token}`);
  const name = (target.name || target.email.split("@")[0]).split(" ")[0];
  await sendEmail(c.env, {
    to: target.email,
    subject: "Reset your Houzs ERP password",
    html: resetEmailHtml({
      name,
      link,
      expiresIn: "1 hour",
      adminName: me?.name || me?.email || "Admin",
    }),
    purpose: "password_reset",
    refType: "user",
    refId: id,
  });

  return c.json({
    ok: true,
    token,
    reset_path: `/reset/${token}`,
    expires_at: expiresAt,
    email: target.email,
  });
});

function resetEmailHtml(p: {
  name: string;
  link: string;
  expiresIn: string;
  adminName: string;
}): string {
  return `
    <div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#222">
      <h2 style="margin:0 0 10px">Hi ${p.name},</h2>
      <p>${p.adminName} has initiated a password reset for your Houzs ERP account.</p>
      <p style="margin:24px 0">
        <a href="${p.link}"
           style="display:inline-block;padding:12px 22px;background:#a16a2e;color:#fff;border-radius:6px;text-decoration:none;font-weight:600">
          Set new password
        </a>
      </p>
      <p style="color:#777;font-size:12px">
        This link expires in ${p.expiresIn}. If you didn't expect this email,
        you can ignore it — but if you notice repeated resets on your
        account, flag it with your admin.
      </p>
    </div>`;
}

export default app;
