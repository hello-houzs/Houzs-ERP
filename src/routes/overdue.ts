import { Hono } from "hono";
import type { Env } from "../types";
import { runOverdue } from "../services/overdue";

const app = new Hono<{ Bindings: Env }>();

app.get("/summary", async (c) => {
  const totals = await c.env.DB.prepare(
    `SELECT COUNT(*) as count, COALESCE(SUM(balance), 0) as total FROM overdue_history`
  ).first();

  const recent = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM overdue_history
     WHERE pull_date >= date('now', '-30 days')`
  ).first<{ count: number }>();

  const byLocation = await c.env.DB.prepare(
    `SELECT location, COUNT(*) as count, COALESCE(SUM(balance), 0) as total
     FROM overdue_history
     WHERE location IS NOT NULL
     GROUP BY location ORDER BY total DESC LIMIT 5`
  ).all();

  const lastPull = await c.env.DB.prepare(
    `SELECT pull_date FROM overdue_history ORDER BY id DESC LIMIT 1`
  ).first<{ pull_date: string }>();

  return c.json({
    totals,
    recent_30d: recent?.count || 0,
    by_location: byLocation.results,
    last_pull: lastPull?.pull_date || null,
  });
});

app.post("/run", async (c) => {
  const result = await runOverdue(c.env, "MANUAL");
  return c.json(result);
});

app.get("/history", async (c) => {
  const page = parseInt(c.req.query("page") || "1", 10);
  const perPage = Math.min(parseInt(c.req.query("per_page") || "50", 10), 200);
  const offset = (page - 1) * perPage;

  const total = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM overdue_history`
  ).first<{ count: number }>();

  const rows = await c.env.DB.prepare(
    `SELECT * FROM overdue_history ORDER BY id DESC LIMIT ? OFFSET ?`
  )
    .bind(perPage, offset)
    .all();

  return c.json({
    data: rows.results,
    page,
    per_page: perPage,
    total: total?.count || 0,
  });
});

export default app;
