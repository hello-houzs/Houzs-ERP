import { Hono } from "hono";
import type { Env } from "../types";

const app = new Hono<{ Bindings: Env }>();

app.get("/", async (c) => {
  const warehouse = c.req.query("warehouse");
  const where = warehouse ? "WHERE l.warehouse = ? AND l.is_active = 1" : "WHERE l.is_active = 1";
  const binds = warehouse ? [warehouse] : [];
  const rows = await c.env.DB.prepare(
    `SELECT l.*, u.name as default_driver_name
       FROM lorries l
       LEFT JOIN users u ON u.id = l.default_driver_user_id
       ${where}
       ORDER BY l.is_internal DESC, l.warehouse, l.plate`
  )
    .bind(...binds)
    .all();
  return c.json({ data: rows.results ?? [] });
});

export default app;
