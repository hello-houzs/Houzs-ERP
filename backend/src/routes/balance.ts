import { Hono } from "hono";
import type { Env } from "../types";
import { getDb } from "../db/client";
import { sales_orders } from "../db/schema";
import { and, asc, desc, eq, gt, gte, isNotNull, like, lt, lte, or, sql } from "drizzle-orm";

const app = new Hono<{ Bindings: Env }>();

app.get("/summary", async (c) => {
  const today = new Date().toISOString().slice(0, 10);
  const in7 = (() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 7);
    return d.toISOString().slice(0, 10);
  })();

  const db = getDb(c.env);

  const totals = await db
    .select({
      count: sql<number>`COUNT(*)`,
      total: sql<number>`COALESCE(SUM(${sales_orders.balance}), 0)`,
    })
    .from(sales_orders)
    .where(gt(sales_orders.balance, 0));

  const expired = await db
    .select({
      count: sql<number>`COUNT(*)`,
      total: sql<number>`COALESCE(SUM(${sales_orders.balance}), 0)`,
    })
    .from(sales_orders)
    .where(
      and(
        gt(sales_orders.balance, 0),
        isNotNull(sales_orders.expiry_date),
        lt(sales_orders.expiry_date, today)
      )
    );

  const warning = await db
    .select({
      count: sql<number>`COUNT(*)`,
      total: sql<number>`COALESCE(SUM(${sales_orders.balance}), 0)`,
    })
    .from(sales_orders)
    .where(
      and(
        gt(sales_orders.balance, 0),
        isNotNull(sales_orders.expiry_date),
        gte(sales_orders.expiry_date, today),
        lte(sales_orders.expiry_date, in7)
      )
    );

  const byRegion = await db
    .select({
      region: sales_orders.region,
      count: sql<number>`COUNT(*)`,
      total: sql<number>`COALESCE(SUM(${sales_orders.balance}), 0)`,
    })
    .from(sales_orders)
    .where(gt(sales_orders.balance, 0))
    .groupBy(sales_orders.region);

  const top = await db
    .select({
      name: sales_orders.debtor_name,
      total: sql<number>`COALESCE(SUM(${sales_orders.balance}), 0)`,
    })
    .from(sales_orders)
    .where(gt(sales_orders.balance, 0))
    .groupBy(sales_orders.debtor_name)
    .orderBy(desc(sql`COALESCE(SUM(${sales_orders.balance}), 0)`))
    .limit(5);

  return c.json({
    totals: totals[0],
    expired: expired[0],
    warning: warning[0],
    by_region: byRegion,
    top_debtors: top,
  });
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

  const db = getDb(c.env);

  const today = new Date().toISOString().slice(0, 10);
  const warningCutoff = (() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 7);
    return d.toISOString().slice(0, 10);
  })();

  const conds: any[] = [gt(sales_orders.balance, 0)];
  if (filter === "expired") {
    conds.push(isNotNull(sales_orders.expiry_date));
    conds.push(lt(sales_orders.expiry_date, today));
  } else if (filter === "warning") {
    conds.push(isNotNull(sales_orders.expiry_date));
    conds.push(gte(sales_orders.expiry_date, today));
    conds.push(lte(sales_orders.expiry_date, warningCutoff));
  }
  if (search) {
    const likeStr = `%${search}%`;
    conds.push(
      or(
        like(sales_orders.doc_no, likeStr),
        like(sales_orders.debtor_name, likeStr),
        like(sales_orders.phone, likeStr)
      )!
    );
  }
  const where = and(...conds);

  const sortBy = c.req.query("sort_by") || "";
  const sortDir =
    (c.req.query("sort_dir") || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";
  const sortExpr = SORT_MAP[sortBy];
  const orderByClause = sortExpr
    ? sql`ORDER BY ${sql.raw(`${sortExpr} ${sortDir}`)}, doc_no ASC`
    : sql`ORDER BY expiry_date ASC NULLS LAST, doc_no ASC`;

  const totalRow = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(sales_orders)
    .where(where);

  // Wide SELECT — pass every AutoCount column through; the frontend
  // expects the full row shape from /api/balance.
  const rows = await db.all<any>(sql`
    SELECT * FROM ${sales_orders}
    WHERE ${where}
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

export default app;
