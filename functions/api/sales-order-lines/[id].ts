// DELETE /api/sales-order-lines/:id
// PATCH  /api/sales-order-lines/:id

import { Env, json, error } from "../../_shared";

export const onRequestDelete: PagesFunction<Env> = async ({ env, params }) => {
  const id = params.id as string;
  if (!id) return error("id required");
  const r = await env.DB.prepare(`DELETE FROM so_lines WHERE id = ?`).bind(id).run();
  return json({ ok: true, changes: r.meta.changes });
};

export const onRequestPatch: PagesFunction<Env> = async ({ env, params, request }) => {
  const id = params.id as string;
  const body = await request.json<Record<string, unknown>>();
  const map: Record<string, string> = {
    qty: "qty", unitPrice: "unit_price", discount: "discount", total: "total",
    tax: "tax", totalInc: "total_inc", balance: "balance",
    paymentStatus: "payment_status", remark: "remark", cancelled: "cancelled",
    unitCost: "unit_cost", lineCost: "line_cost", lineMargin: "line_margin",
  };
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [k, col] of Object.entries(map)) {
    if (k in body) {
      fields.push(`${col} = ?`);
      values.push(k === "cancelled" ? (body[k] ? 1 : 0) : body[k]);
    }
  }
  if ("variants" in body) {
    fields.push("variants = ?");
    values.push(body.variants ? JSON.stringify(body.variants) : null);
  }
  if (fields.length === 0) return error("no fields to update");
  values.push(id);
  const r = await env.DB.prepare(`UPDATE so_lines SET ${fields.join(", ")} WHERE id = ?`).bind(...values).run();
  return json({ ok: true, changes: r.meta.changes });
};
