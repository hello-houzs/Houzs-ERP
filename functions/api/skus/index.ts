// GET /api/skus — list all SKUs
// POST /api/skus — create new SKU
// PATCH /api/skus (body has id) — update existing SKU

import { Env, json, error, norm } from "../../_shared";

function rowToSKU(r: Record<string, unknown>) {
  return {
    id: r.id,
    itemCode: r.item_code,
    description: r.description,
    itemGroup: r.item_group,
    uom: r.uom,
    supplier: r.supplier ?? "",
    barCode: r.bar_code ?? "",
    costPrice: Number(r.cost_price || 0),
    sellingPrice: Number(r.selling_price || 0),
    brand: r.brand,
    lastUpdated: r.last_updated,
    notes: r.notes ?? undefined,
  };
}

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const { results } = await env.DB.prepare(
    `SELECT * FROM skus ORDER BY item_code`
  ).all<Record<string, unknown>>();
  return json(results.map(rowToSKU));
};

export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  const body = await request.json<Record<string, unknown>>();
  const id = (body.id as string) || crypto.randomUUID();
  const itemCode = norm(body.itemCode as string);
  if (!itemCode) return error("itemCode required");
  await env.DB.prepare(
    `INSERT INTO skus (id, item_code, description, item_group, uom, supplier, bar_code, cost_price, selling_price, brand, last_updated, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(item_code) DO UPDATE SET
       description = excluded.description,
       item_group = excluded.item_group,
       uom = excluded.uom,
       supplier = excluded.supplier,
       cost_price = excluded.cost_price,
       selling_price = excluded.selling_price,
       brand = excluded.brand,
       last_updated = excluded.last_updated,
       notes = excluded.notes`
  ).bind(
    id,
    itemCode.toUpperCase(),
    (body.description as string) || "",
    (body.itemGroup as string) || "OTHER",
    (body.uom as string) || "UNIT",
    (body.supplier as string) || null,
    (body.barCode as string) || null,
    Number(body.costPrice || 0),
    Number(body.sellingPrice || 0),
    (body.brand as string) || "OTHER",
    new Date().toISOString(),
    (body.notes as string) || null,
  ).run();
  const row = await env.DB.prepare(`SELECT * FROM skus WHERE id = ?`).bind(id).first<Record<string, unknown>>();
  return json(row ? rowToSKU(row) : { id });
};

/** PATCH /api/skus body: { id, ...partial } */
export const onRequestPatch: PagesFunction<Env> = async ({ env, request }) => {
  const body = await request.json<Record<string, unknown>>();
  const id = body.id as string;
  if (!id) return error("id required");
  const fields: string[] = [];
  const values: unknown[] = [];
  const map: Record<string, string> = {
    itemCode: "item_code", description: "description", itemGroup: "item_group",
    uom: "uom", supplier: "supplier", barCode: "bar_code",
    costPrice: "cost_price", sellingPrice: "selling_price",
    brand: "brand", notes: "notes",
  };
  for (const [k, col] of Object.entries(map)) {
    if (k in body) {
      fields.push(`${col} = ?`);
      values.push(body[k]);
    }
  }
  fields.push("last_updated = ?");
  values.push(new Date().toISOString());
  values.push(id);
  await env.DB.prepare(`UPDATE skus SET ${fields.join(", ")} WHERE id = ?`).bind(...values).run();
  const row = await env.DB.prepare(`SELECT * FROM skus WHERE id = ?`).bind(id).first<Record<string, unknown>>();
  return json(row ? rowToSKU(row) : { id });
};
