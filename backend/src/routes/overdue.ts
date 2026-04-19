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

// Allow-listed sortable columns for /history.
const HISTORY_SORT_MAP: Record<string, string> = {
  pull_date: "pull_date",
  doc_no: "doc_no",
  debtor_name: "debtor_name",
  location: "location",
  balance: "balance",
  original_expiry_date: "original_expiry_date",
  extended_to: "extended_to",
  id: "id",
};

app.get("/history", async (c) => {
  const page = parseInt(c.req.query("page") || "1", 10);
  const perPage = Math.min(parseInt(c.req.query("per_page") || "50", 10), 200);
  const offset = (page - 1) * perPage;

  const sortBy = c.req.query("sort_by") || "";
  const sortDir =
    (c.req.query("sort_dir") || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  const sortExpr = HISTORY_SORT_MAP[sortBy] || "id";
  const orderBy = `ORDER BY ${sortExpr} ${sortDir}, id DESC`;

  const total = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM overdue_history`
  ).first<{ count: number }>();

  const rows = await c.env.DB.prepare(
    `SELECT * FROM overdue_history ${orderBy} LIMIT ? OFFSET ?`
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

// Allow-listed sort columns for /orders. Aggregate aliases are
// referenced directly (SQLite ORDER BY can name SELECT-list aliases).
const ORDERS_SORT_MAP: Record<string, string> = {
  doc_no: "so.doc_no",
  doc_date: "so.doc_date",
  debtor_name: "so.debtor_name",
  phone: "so.phone",
  sales_location: "so.sales_location",
  region: "so.region",
  local_total: "so.local_total",
  balance: "so.balance",
  expiry_date: "so.expiry_date",
  remark4: "so.remark4",
  // Aggregates from the GROUP BY:
  extension_count: "extension_count",
  last_extended_at: "last_extended_at",
  first_original_expiry: "first_original_expiry",
};

/**
 * Grouped overdue view: one row per doc_no with extension count,
 * joined with sales_orders for full order data. Orders stay in this
 * list even after extension — they don't disappear.
 */
app.get("/orders", async (c) => {
  const search = c.req.query("search");
  const page = parseInt(c.req.query("page") || "1", 10);
  const perPage = Math.min(parseInt(c.req.query("per_page") || "50", 10), 200);
  const offset = (page - 1) * perPage;

  const where: string[] = [];
  const binds: any[] = [];

  if (search) {
    where.push("(so.doc_no LIKE ? OR so.debtor_name LIKE ? OR so.phone LIKE ?)");
    const like = `%${search}%`;
    binds.push(like, like, like);
  }

  const whereSql = where.length ? `AND ${where.join(" AND ")}` : "";

  const sortBy = c.req.query("sort_by") || "";
  const sortDir =
    (c.req.query("sort_dir") || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  const sortExpr = ORDERS_SORT_MAP[sortBy] || "last_extended_at";
  const orderBy = `ORDER BY ${sortExpr} ${sortDir}, so.doc_no DESC`;

  const total = await c.env.DB.prepare(
    `SELECT COUNT(DISTINCT oh.doc_no) as count
       FROM overdue_history oh
       JOIN sales_orders so ON so.doc_no = oh.doc_no
      WHERE 1=1 ${whereSql}`
  )
    .bind(...binds)
    .first<{ count: number }>();

  const rows = await c.env.DB.prepare(
    `SELECT so.*,
            COUNT(oh.id) as extension_count,
            MAX(oh.pull_date) as last_extended_at,
            MIN(oh.original_expiry_date) as first_original_expiry
       FROM overdue_history oh
       JOIN sales_orders so ON so.doc_no = oh.doc_no
      WHERE 1=1 ${whereSql}
      GROUP BY oh.doc_no
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
