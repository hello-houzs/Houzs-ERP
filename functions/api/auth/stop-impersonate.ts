// POST /api/auth/stop-impersonate — return to admin session

import { Env, json, error } from "../../_shared";
import {
  getAuthUser, signJWT, setAuthCookie, logAudit,
} from "../../_auth";

export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  const current = await getAuthUser(request, env);
  if (!current) return error("Not authenticated", 401);
  if (!current.impersonatedBy) return error("Not currently impersonating", 400);

  // Re-issue a normal admin token — we need their real row from DB to get email
  const admin = await env.DB.prepare(
    `SELECT id, email, name, position FROM users WHERE id = ?`
  ).bind(current.impersonatedBy.id).first<{ id: string; email: string; name: string; position: string }>();
  if (!admin) return error("Original admin no longer exists", 404);

  const token = await signJWT(
    { sub: admin.id, email: admin.email, name: admin.name, position: admin.position },
    env.JWT_SECRET,
  );

  // Audit with the admin as actor (current effective user is the target)
  await logAudit(env, request, {
    id: admin.id, email: admin.email, name: admin.name, position: admin.position,
  }, {
    action: "impersonate_stop",
    entityType: "user",
    entityId: current.id,
    changes: { targetName: current.name },
  });

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": setAuthCookie(token),
      "Cache-Control": "no-store",
    },
  });
};
