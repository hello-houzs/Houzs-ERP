// POST /api/auth/impersonate
//   Body: { userId }
// Admin-only. Starts a session AS the target user while remembering the
// original admin in the JWT's `imp` field. Use this to verify another user's
// setup / permissions without knowing their password.
//
// Security: logged as `impersonate_start` audit event. Target user's
// last_login is NOT updated (so admin activity doesn't masquerade as theirs).
// 2-hour TTL (shorter than regular 24h session).

import { Env, json, error } from "../../_shared";
import {
  getAuthUser, signJWT, setAuthCookie, isAdmin, logAudit,
} from "../../_auth";

const IMPERSONATE_TTL_SECONDS = 2 * 3600; // 2 hours

export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  const admin = await getAuthUser(request, env);
  if (!admin) return error("Not authenticated", 401);
  if (!isAdmin(admin)) return error("Only Sales Directors can impersonate", 403);
  if (admin.impersonatedBy) return error("Already impersonating — stop first", 400);

  const body = await request.json<{ userId?: string }>().catch(() => ({} as { userId?: string }));
  const userId = (body.userId ?? "").trim();
  if (!userId) return error("userId required");
  if (userId === admin.id) return error("Cannot impersonate yourself");

  const target = await env.DB.prepare(
    `SELECT id, email, name, position, status FROM users WHERE id = ?`
  ).bind(userId).first<{ id: string; email: string; name: string; position: string; status: string }>();
  if (!target) return error("User not found", 404);
  if (target.status === "INACTIVE") return error("Cannot impersonate a disabled user", 400);

  const token = await signJWT(
    {
      sub: target.id,
      email: target.email,
      name: target.name,
      position: target.position,
      imp: { id: admin.id, name: admin.name },
    },
    env.JWT_SECRET,
    IMPERSONATE_TTL_SECONDS,
  );

  await logAudit(env, request, admin, {
    action: "impersonate_start",
    entityType: "user",
    entityId: target.id,
    changes: { targetEmail: target.email, targetPosition: target.position },
  });

  return new Response(JSON.stringify({
    ok: true,
    impersonating: {
      id: target.id, email: target.email, name: target.name,
      position: target.position,
    },
    originalAdmin: { id: admin.id, name: admin.name },
    expiresIn: IMPERSONATE_TTL_SECONDS,
  }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": setAuthCookie(token),
      "Cache-Control": "no-store",
    },
  });
};
