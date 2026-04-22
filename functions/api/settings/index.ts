// GET /api/settings — fetch all app_settings rows as a flat JSON object.
// Values are stored as JSON strings and parsed here so consumers get the
// shape they expect (arrays, objects, numbers — whatever was PUT).
//
// Auth: any authenticated user can read (settings are shared config, not
// per-user secrets).

import { Env, json } from "../../_shared";
import { requireAuth } from "../../_auth";

export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const user = await requireAuth(request, env);
  if (user instanceof Response) return user;

  const { results } = await env.DB.prepare(
    `SELECT key, value FROM app_settings`
  ).all<{ key: string; value: string }>();

  const out: Record<string, unknown> = {};
  for (const r of results) {
    try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
  }
  return json(out);
};
