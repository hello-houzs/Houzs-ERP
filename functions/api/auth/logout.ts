// POST /api/auth/logout — clear session cookie

import { Env } from "../../_shared";
import { clearAuthCookie, getAuthUser, logAudit } from "../../_auth";

export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  const user = await getAuthUser(request, env);
  if (user) {
    await logAudit(env, request, user, { action: "logout", entityType: "user", entityId: user.id });
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": clearAuthCookie(),
      "Cache-Control": "no-store",
    },
  });
};
