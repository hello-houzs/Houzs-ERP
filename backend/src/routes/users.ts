import { Hono } from "hono";
import type { Env } from "../types";
import { generateToken, isoIn } from "../services/auth";
import { requirePermission } from "../middleware/auth";
import { sendEmail, publicUrl } from "../services/email";

const app = new Hono<{ Bindings: Env }>();

const INVITE_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 days
const RESET_TTL_SECONDS = 60 * 60; // 1 hour — password reset should expire fast

/**
 * GET /api/users
 * List all team members. Requires users.read.
 */
app.get("/", requirePermission("users.read"), async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.status, u.role_id,
            r.name as role_name,
            u.manager_id, m.name as manager_name, m.email as manager_email,
            u.invited_at, u.joined_at, u.last_login_at, u.created_at
     FROM users u
     JOIN roles r ON r.id = u.role_id
     LEFT JOIN users m ON m.id = u.manager_id
     ORDER BY u.created_at DESC`
  ).all();
  return c.json({ users: rows.results });
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

  const role = await c.env.DB.prepare(
    `SELECT id FROM roles WHERE id = ?`
  )
    .bind(body.role_id)
    .first<{ id: number }>();
  if (!role) return c.json({ error: "Role not found" }, 404);

  // If the user already exists and is active/disabled, refuse.
  const existing = await c.env.DB.prepare(
    `SELECT id, status FROM users WHERE email = ?`
  )
    .bind(email)
    .first<{ id: number; status: string }>();

  if (existing && existing.status === "active") {
    return c.json({ error: "A user with that email already exists" }, 409);
  }

  // Create or refresh the placeholder user.
  if (!existing) {
    await c.env.DB.prepare(
      `INSERT INTO users (email, role_id, status, invited_by, invited_at)
       VALUES (?, ?, 'invited', ?, datetime('now'))`
    )
      .bind(email, body.role_id, me.id || null)
      .run();
  } else {
    // Re-invite — bump role and reset invited_at, drop any old token.
    await c.env.DB.prepare(
      `UPDATE users SET role_id = ?, status = 'invited',
                        invited_by = ?, invited_at = datetime('now')
       WHERE email = ?`
    )
      .bind(body.role_id, me.id || null, email)
      .run();
    await c.env.DB.prepare(
      `DELETE FROM invitations WHERE email = ? AND accepted_at IS NULL`
    )
      .bind(email)
      .run();
  }

  // Issue a fresh invitation token.
  const token = generateToken();
  const expires = isoIn(INVITE_TTL_SECONDS);
  await c.env.DB.prepare(
    `INSERT INTO invitations (email, role_id, token, invited_by, expires_at)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(email, body.role_id, token, me.id || 0, expires)
    .run();

  return c.json({ token, expires_at: expires, email });
});

/**
 * PATCH /api/users/:id
 * Body: { role_id?, status? }
 * Update a team member's role or enable/disable them.
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
  }>();
  const sets: string[] = [];
  const binds: any[] = [];
  if (body.role_id != null) {
    const role = await c.env.DB.prepare(`SELECT id FROM roles WHERE id = ?`)
      .bind(body.role_id)
      .first();
    if (!role) return c.json({ error: "Role not found" }, 404);
    sets.push("role_id = ?");
    binds.push(body.role_id);
  }
  if (body.status != null) {
    if (!["active", "disabled"].includes(body.status)) {
      return c.json({ error: "status must be active or disabled" }, 400);
    }
    sets.push("status = ?");
    binds.push(body.status);
  }
  if (body.manager_id !== undefined) {
    if (body.manager_id === null) {
      sets.push("manager_id = NULL");
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
        const mgrRow: { manager_id: number | null } | null = await c.env.DB
          .prepare(`SELECT manager_id FROM users WHERE id = ?`)
          .bind(cursor)
          .first();
        if (!mgrRow) return c.json({ error: "Manager not found" }, 404);
        cursor = mgrRow.manager_id;
      }
      sets.push("manager_id = ?");
      binds.push(mgr);
    }
  }
  if (!sets.length) return c.json({ error: "No fields to update" }, 400);

  binds.push(id);
  const result = await c.env.DB.prepare(
    `UPDATE users SET ${sets.join(", ")} WHERE id = ?`
  )
    .bind(...binds)
    .run();
  if (!result.meta.changes) return c.json({ error: "User not found" }, 404);

  // If we disabled a user, revoke their sessions.
  if (body.status === "disabled") {
    await c.env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(id).run();
  }

  return c.json({ ok: true });
});

/**
 * DELETE /api/users/:id
 * Disables the user and revokes sessions instead of hard-deleting,
 * because trips, clock records, salary lines etc. reference the user.
 * If the user has no references (e.g. never accepted invite), hard-delete.
 */
app.delete("/:id", requirePermission("users.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const me = c.get("user");
  if (!id) return c.json({ error: "Bad id" }, 400);
  if (id === me.id) return c.json({ error: "You cannot delete yourself" }, 400);

  const row = await c.env.DB.prepare(
    `SELECT u.id, u.status, r.name as role_name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`
  )
    .bind(id)
    .first<{ id: number; status: string; role_name: string }>();
  if (!row) return c.json({ error: "User not found" }, 404);

  if (row.role_name === "Owner") {
    const owners = await c.env.DB.prepare(
      `SELECT COUNT(*) as count FROM users u JOIN roles r ON r.id = u.role_id
       WHERE r.name = 'Owner' AND u.status = 'active'`
    ).first<{ count: number }>();
    if ((owners?.count || 0) <= 1) {
      return c.json({ error: "Cannot remove the last Owner" }, 400);
    }
  }

  // Revoke sessions
  await c.env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(id).run();

  // If never joined (still invited), safe to hard-delete
  if (row.status === "invited") {
    await c.env.DB.prepare(
      `DELETE FROM invitations WHERE email = (SELECT email FROM users WHERE id = ?)`
    ).bind(id).run();
    await c.env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(id).run();
    return c.json({ ok: true, action: "deleted" });
  }

  // Otherwise disable — preserves FK references in trips, salary, etc.
  await c.env.DB.prepare(
    `UPDATE users SET status = 'disabled' WHERE id = ?`
  ).bind(id).run();

  // Clear default_driver on lorries
  await c.env.DB.prepare(
    `UPDATE lorries SET default_driver_user_id = NULL WHERE default_driver_user_id = ?`
  ).bind(id).run();

  return c.json({ ok: true, action: "disabled" });
});

/**
 * GET /api/users/invitations
 * Pending invitations.
 */
app.get("/invitations", requirePermission("users.read"), async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT i.id, i.email, i.role_id, r.name as role_name,
            i.token, i.expires_at, i.created_at, i.accepted_at,
            ib.email as invited_by_email
     FROM invitations i
     JOIN roles r ON r.id = i.role_id
     LEFT JOIN users ib ON ib.id = i.invited_by
     WHERE i.accepted_at IS NULL
     ORDER BY i.created_at DESC`
  ).all();
  return c.json({ invitations: rows.results });
});

/**
 * DELETE /api/users/invitations/:id
 * Revoke a pending invitation.
 */
app.delete("/invitations/:id", requirePermission("users.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Bad id" }, 400);

  const inv = await c.env.DB.prepare(
    `SELECT email FROM invitations WHERE id = ?`
  )
    .bind(id)
    .first<{ email: string }>();
  if (!inv) return c.json({ error: "Invitation not found" }, 404);

  // Also clean up the placeholder user if they never accepted.
  await c.env.DB.prepare(
    `DELETE FROM users WHERE email = ? AND status = 'invited'`
  )
    .bind(inv.email)
    .run();
  await c.env.DB.prepare(`DELETE FROM invitations WHERE id = ?`).bind(id).run();

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

  const target = await c.env.DB.prepare(
    `SELECT id, email, name, status FROM users WHERE id = ?`
  )
    .bind(id)
    .first<{ id: number; email: string; name: string | null; status: string }>();
  if (!target) return c.json({ error: "User not found" }, 404);
  if (target.status === "invited") {
    // Invited users haven't set a password yet — the existing invitation
    // flow handles first-time setup. Steering admins at the right tool.
    return c.json(
      { error: "User is still invited — resend the invitation instead." },
      400
    );
  }

  // Invalidate any prior unconsumed reset tokens for this user.
  await c.env.DB.prepare(
    `UPDATE password_resets
        SET consumed_at = datetime('now')
      WHERE user_id = ? AND consumed_at IS NULL`
  )
    .bind(id)
    .run();

  const token = generateToken();
  const expiresAt = isoIn(RESET_TTL_SECONDS);
  await c.env.DB.prepare(
    `INSERT INTO password_resets (user_id, token, requested_by, expires_at)
     VALUES (?, ?, ?, ?)`
  )
    .bind(id, token, me?.id || null, expiresAt)
    .run();

  // Also revoke active sessions so the user has to log in again with
  // the new password. Defensive — if an admin is resetting, the old
  // password should be considered compromised.
  await c.env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(id).run();

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
