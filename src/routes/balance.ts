import { Hono } from "hono";
import type { Env } from "../types";

const app = new Hono<{ Bindings: Env }>();

app.get("/summary", async (c) => {
  const today = new Date().toISOString().slice(0, 10);
  const in7 = (() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 7);
    return d.toISOString().slice(0, 10);
  })();

  const totals = await c.env.DB.prepare(
    `SELECT COUNT(*) as count, COALESCE(SUM(balance), 0) as total
     FROM sales_orders WHERE balance > 0`
  ).first();

  const expired = await c.env.DB.prepare(
    `SELECT COUNT(*) as count, COALESCE(SUM(balance), 0) as total
     FROM sales_orders
     WHERE balance > 0 AND expiry_date IS NOT NULL AND expiry_date < ?`
  )
    .bind(today)
    .first();

  const warning = await c.env.DB.prepare(
    `SELECT COUNT(*) as count, COALESCE(SUM(balance), 0) as total
     FROM sales_orders
     WHERE balance > 0 AND expiry_date IS NOT NULL AND expiry_date >= ? AND expiry_date <= ?`
  )
    .bind(today, in7)
    .first();

  const byRegion = await c.env.DB.prepare(
    `SELECT region, COUNT(*) as count, COALESCE(SUM(balance), 0) as total
     FROM sales_orders WHERE balance > 0 GROUP BY region`
  ).all();

  const top = await c.env.DB.prepare(
    `SELECT debtor_name as name, COALESCE(SUM(balance), 0) as total
     FROM sales_orders WHERE balance > 0
     GROUP BY debtor_name
     ORDER BY total DESC
     LIMIT 5`
  ).all();

  return c.json({ totals, expired, warning, by_region: byRegion.results, top_debtors: top.results });
});

app.get("/", async (c) => {
  const filter = c.req.query("expiry_filter") || "all"; // expired | warning | all
  const search = c.req.query("search");
  const page = parseInt(c.req.query("page") || "1", 10);
  const perPage = Math.min(parseInt(c.req.query("per_page") || "50", 10), 200);
  const offset = (page - 1) * perPage;

  const where: string[] = ["balance > 0"];
  const binds: any[] = [];

  const today = new Date().toISOString().slice(0, 10);
  const warningCutoff = (() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 7);
    return d.toISOString().slice(0, 10);
  })();

  if (filter === "expired") {
    where.push("expiry_date IS NOT NULL AND expiry_date < ?");
    binds.push(today);
  } else if (filter === "warning") {
    where.push("expiry_date IS NOT NULL AND expiry_date >= ? AND expiry_date <= ?");
    binds.push(today, warningCutoff);
  }

  if (search) {
    where.push("(doc_no LIKE ? OR debtor_name LIKE ? OR phone LIKE ?)");
    const like = `%${search}%`;
    binds.push(like, like, like);
  }

  const whereSql = `WHERE ${where.join(" AND ")}`;

  const total = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM sales_orders ${whereSql}`
  )
    .bind(...binds)
    .first<{ count: number }>();

  const rows = await c.env.DB.prepare(
    `SELECT * FROM sales_orders ${whereSql}
     ORDER BY expiry_date ASC NULLS LAST
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

export default app;
