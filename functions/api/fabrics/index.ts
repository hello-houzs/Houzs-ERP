// GET  /api/fabrics — list
// POST /api/fabrics — create/upsert
// DELETE /api/fabrics/:id — in [id].ts

import { Env, json, error } from "../../_shared";

function rowToFabric(r: Record<string, unknown>) {
  return {
    id: r.id,
    fabricCode: r.fabric_code,
    priceTier: r.price_tier,
    price: Number(r.price || 0),
    description: r.description ?? "",
  };
}

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const { results } = await env.DB.prepare(`SELECT * FROM fabrics ORDER BY fabric_code`).all<Record<string, unknown>>();
  return json(results.map(rowToFabric));
};

export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  const body = await request.json<Record<string, unknown>>();
  const id = (body.id as string) || crypto.randomUUID();
  const code = (body.fabricCode as string)?.trim().toUpperCase();
  if (!code) return error("fabricCode required");
  await env.DB.prepare(
    `INSERT INTO fabrics (id, fabric_code, price_tier, price, description)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(fabric_code) DO UPDATE SET
       price_tier = excluded.price_tier,
       price = excluded.price,
       description = excluded.description`
  ).bind(
    id, code,
    (body.priceTier as string) || "PRICE_2",
    Number(body.price || 0),
    (body.description as string) || null,
  ).run();
  return json({ ok: true, id, fabricCode: code });
};
