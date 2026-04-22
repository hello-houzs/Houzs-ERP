import { Env, json, error } from "../../_shared";

export const onRequestDelete: PagesFunction<Env> = async ({ env, params }) => {
  const id = params.id as string;
  if (!id) return error("id required");
  const r = await env.DB.prepare(`DELETE FROM fabrics WHERE id = ?`).bind(id).run();
  return json({ ok: true, changes: r.meta.changes });
};
