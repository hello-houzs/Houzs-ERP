import { Hono } from "hono";
import type { Env } from "../types";

const app = new Hono<{ Bindings: Env }>();

app.get("/", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT code, name, address, lat, lng FROM warehouses
      WHERE is_active = 1 ORDER BY code`
  ).all();
  return c.json({ data: rows.results ?? [] });
});

export default app;
