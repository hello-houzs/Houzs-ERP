import { Hono } from "hono";
import type { Env } from "../types";
import { runOverdue } from "../services/overdue";
import { getDb } from "../db/client";
import { overdue_history, sales_orders } from "../db/schema";
import { and, desc, eq, gte, like, or, sql } from "drizzle-orm";

const app = new Hono<{ Bindings: Env }>();

app.get("/summary", async (c) => {
  const db = getDb(c.env);

  const totals = await db
    .select({
      count: sql<number>`COUNT(*)`,
      total: sql<number>`COALESCE(SUM(${overdue_history.balance}), 0)`,
    })
    .from(overdue_history);

  const recent = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(overdue_history)
    .where(gte(overdue_history.pull_date, sql`date('now', '-30 days')`));

  const byLocation = await db
    .select({
      location: overdue_history.location,
      count: sql<number>`COUNT(*)`,
      total: sql<number>`COALESCE(SUM(${overdue_history.balance}), 0)`,
    })
    .from(overdue_history)
    .where(sql`${overdue_history.location} IS NOT NULL`)
    .groupBy(overdue_history.location)
    .orderBy(desc(sql`COALESCE(SUM(${overdue_history.balance}), 0)`))
    .limit(5);

  const lastPull = await db
    .select({ pull_date: overdue_history.pull_date })
    .from(overdue_history)
    .orderBy(desc(overdue_history.id))
    .limit(1);

  return c.json({
    totals: totals[0],
    recent_30d: recent[0]?.count || 0,
    by_location: byLocation,
    last_pull: lastPull[0]?.pull_date || null,
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

  const db = getDb(c.env);

  const sortBy = c.req.query("sort_by") || "";
  const sortDir =
    (c.req.query("sort_dir") || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  const sortExpr = HISTORY_SORT_MAP[sortBy] || "id";
  const orderByClause = sql`ORDER BY ${sql.raw(`${sortExpr} ${sortDir}`)}, id DESC`;

  const totalRow = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(overdue_history);

  // SELECT * for the audit-log shape. Schema only knows the core
  // columns; downstream consumers may expect more if migration adds
  // fields later.
  const rows = await db.all<any>(sql`
    SELECT * FROM ${overdue_history}
    ${orderByClause}
    LIMIT ${perPage} OFFSET ${offset}
  `);

  return c.json({
    data: rows,
    page,
    per_page: perPage,
    total: totalRow[0]?.count || 0,
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

  const db = getDb(c.env);

  // The WHERE clause references `so.*` columns that are in scope on
  // both the COUNT and the data query (same FROM + JOIN).
  let searchCond = sql``;
  if (search) {
    const likeStr = `%${search}%`;
    searchCond = sql` AND (so.doc_no LIKE ${likeStr} OR so.debtor_name LIKE ${likeStr} OR so.phone LIKE ${likeStr})`;
  }

  const sortBy = c.req.query("sort_by") || "";
  const sortDir =
    (c.req.query("sort_dir") || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  const sortExpr = ORDERS_SORT_MAP[sortBy] || "last_extended_at";
  const orderByClause = sql`ORDER BY ${sql.raw(`${sortExpr} ${sortDir}`)}, so.doc_no DESC`;

  const totalRow = await db.get<{ count: number }>(sql`
    SELECT COUNT(DISTINCT oh.doc_no) AS count
      FROM ${overdue_history} oh
      JOIN ${sales_orders} so ON so.doc_no = oh.doc_no
     WHERE 1=1 ${searchCond}
  `);

  const rows = await db.all<any>(sql`
    SELECT so.*,
           COUNT(oh.id) AS extension_count,
           MAX(oh.pull_date) AS last_extended_at,
           MIN(oh.original_expiry_date) AS first_original_expiry
      FROM ${overdue_history} oh
      JOIN ${sales_orders} so ON so.doc_no = oh.doc_no
     WHERE 1=1 ${searchCond}
     GROUP BY oh.doc_no
     ${orderByClause}
     LIMIT ${perPage} OFFSET ${offset}
  `);

  return c.json({
    data: rows,
    page,
    per_page: perPage,
    total: totalRow?.count || 0,
  });
});

export default app;
