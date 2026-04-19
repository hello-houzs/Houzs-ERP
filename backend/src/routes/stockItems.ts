import { Hono } from "hono";
import type { Env } from "../types";
import { getStockItemCached, runStockItemsRefresh } from "../services/stockItems";

/**
 * Stock item read-through cache + refresh.
 *
 * Primary purpose: resolve `item_code` → `main_supplier` (AutoCount
 * creditor code) so service cases can auto-link to their procurement
 * creditor. See `stockItems.resolveCreditorForCase`.
 *
 *   GET  /api/stockitems                  — diagnostic list (cached rows)
 *   GET  /api/stockitems/:code            — read-through, returns cached or fresh
 *   POST /api/stockitems/refresh          — bulk re-pull + rewrite creditor_code on cases
 *                                             body: { item_codes?: string[] }
 */

const app = new Hono<{ Bindings: Env }>();

app.get("/", async (c) => {
  const search = c.req.query("search");
  const page = parseInt(c.req.query("page") || "1", 10);
  const perPage = Math.min(parseInt(c.req.query("per_page") || "50", 10), 200);
  const offset = (page - 1) * perPage;

  const where: string[] = [];
  const binds: any[] = [];
  if (search) {
    where.push("(item_code LIKE ? OR description LIKE ? OR main_supplier LIKE ?)");
    const like = `%${search}%`;
    binds.push(like, like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const total = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count FROM stock_items ${whereSql}`
  )
    .bind(...binds)
    .first<{ count: number }>();

  const rows = await c.env.DB.prepare(
    `SELECT * FROM stock_items ${whereSql}
     ORDER BY item_code ASC
     LIMIT ? OFFSET ?`
  )
    .bind(...binds, perPage, offset)
    .all();

  return c.json({
    data: rows.results,
    page,
    per_page: perPage,
    total: total?.count || 0,
  });
});

app.get("/:code", async (c) => {
  const code = c.req.param("code");
  try {
    const item = await getStockItemCached(c.env, code);
    if (!item) return c.json({ error: "Unknown item", item_code: code }, 404);
    return c.json({ item });
  } catch (e: any) {
    return c.json({ error: e?.message || String(e) }, 502);
  }
});

app.post("/refresh", async (c) => {
  let body: { item_codes?: string[] } = {};
  try {
    body = await c.req.json();
  } catch {
    // empty body is fine — refresh everything
  }
  const result = await runStockItemsRefresh(c.env, { itemCodes: body.item_codes });
  return c.json(result);
});

export default app;
