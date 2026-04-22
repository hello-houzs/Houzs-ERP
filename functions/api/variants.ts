// GET /api/variants   — fetch variant maintenance config
// PUT /api/variants   — replace variant maintenance config

import { Env, json } from "../_shared";

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const row = await env.DB.prepare(`SELECT config FROM variants_config WHERE id = 1`).first<{ config: string }>();
  return json(row ? JSON.parse(row.config) : null);
};

export const onRequestPut: PagesFunction<Env> = async ({ env, request }) => {
  const body = await request.json<Record<string, unknown>>();
  await env.DB.prepare(
    `INSERT INTO variants_config (id, config, updated_at) VALUES (1, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`
  ).bind(JSON.stringify(body)).run();
  return json({ ok: true });
};
