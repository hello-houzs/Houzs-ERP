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

// Allow-listed sortable columns. Default (when sort_by is empty) keeps
// the load-bearing "expiry_date ASC NULLS LAST" ordering.
const SORT_MAP: Record<string, string> = {
  doc_no: "doc_no",
  debtor_name: "debtor_name",
  sales_location: "sales_location",
  region: "region",
  local_total: "local_total",
  balance: "balance",
  expiry_date: "expiry_date",
  doc_date: "doc_date",
  remark4: "remark4",
  phone: "phone",
};

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

  const sortBy = c.req.query("sort_by") || "";
  const sortDir =
    (c.req.query("sort_dir") || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";
  const sortExpr = SORT_MAP[sortBy];
  const orderBy = sortExpr
    ? `ORDER BY ${sortExpr} ${sortDir}, doc_no ASC`
    : `ORDER BY expiry_date ASC NULLS LAST, doc_no ASC`;

  const total = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM sales_orders ${whereSql}`
  )
    .bind(...binds)
    .first<{ count: number }>();

  const rows = await c.env.DB.prepare(
    `SELECT * FROM sales_orders ${whereSql}
     ${orderBy}
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
