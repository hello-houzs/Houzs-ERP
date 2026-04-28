import { Hono } from "hono";
import type { Env } from "../types";
import { runCreditorsPull } from "../services/creditors";
import { AutoCountClient } from "../services/autocount";
import { getDb } from "../db/client";
import { creditors, purchase_order_docs } from "../db/schema";
import { and, asc, desc, eq, like, or, sql } from "drizzle-orm";

/**
 * Creditors (procurement suppliers from AutoCount).
 *
 * Distinct from /api/suppliers which manages local service/3PL
 * suppliers used by ASSR cases. Creditors are read-only mirrors of
 * AutoCount's /Creditor/* endpoints.
 *
 *   GET  /api/creditors                — list (from D1 mirror) + filter
 *   GET  /api/creditors/:code          — single (from D1 cache) +
 *                                        live extras from /getSingle
 *   GET  /api/creditors/:code/details  — read-through to /getDetails
 *   POST /api/creditors/pull           — manual /getAll resync
 */

const app = new Hono<{ Bindings: Env }>();

// Allow-list of sortable columns → underlying SQL expression. Keeping
// this explicit prevents arbitrary column injection through `sort_by`.
const CREDITOR_SORT_MAP: Record<string, string> = {
  creditor_code: "c.creditor_code",
  company_name: "c.company_name",
  contact: "COALESCE(c.email, c.phone1)",
  currency: "c.currency_code",
  po_count: "po_count",
  total_spend: "total_local_ex_tax",
  type: "COALESCE(c.type_description, c.type)",
  purchase_agent: "COALESCE(c.purchase_agent_description, c.purchase_agent)",
};

app.get("/", async (c) => {
  const search = c.req.query("search");
  const page = parseInt(c.req.query("page") || "1", 10);
  const perPage = Math.min(parseInt(c.req.query("per_page") || "50", 10), 200);
  const offset = (page - 1) * perPage;

  const db = getDb(c.env);
  const likeStr = search ? `%${search}%` : null;
  // Filter cluster — same OR'd LIKE across the searchable columns. Built
  // once and reused across the COUNT and SELECT queries below.
  const searchCond = likeStr
    ? or(
        like(creditors.creditor_code, likeStr),
        like(creditors.company_name, likeStr),
        like(creditors.desc2, likeStr),
        like(creditors.email, likeStr),
        like(creditors.phone1, likeStr),
        like(creditors.mobile, likeStr),
        like(creditors.tax_register_no, likeStr)
      )
    : undefined;

  // Total uses the bare creditors table — the LEFT JOIN'd PO aggregate
  // doesn't change the count of rows.
  const totalRow = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(creditors)
    .where(searchCond);

  const sortBy = c.req.query("sort_by") || "";
  const sortDir =
    (c.req.query("sort_dir") || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";
  const sortExpr = CREDITOR_SORT_MAP[sortBy] || "c.company_name";
  const orderByClause = sql`ORDER BY ${sql.raw(`${sortExpr} ${sortDir}`)}, c.creditor_code ASC`;

  // Wide SELECT — c.* + the joined PO aggregate. Keeps the broad shape
  // via `sql<any>` since downstream consumers expect every AutoCount
  // column.
  const rows = await db.all<any>(sql`
    SELECT c.*,
           COALESCE(po.po_count, 0)            AS po_count,
           COALESCE(po.open_count, 0)          AS open_po_count,
           COALESCE(po.total_local_ex_tax, 0)  AS total_local_ex_tax
      FROM ${creditors} c
      LEFT JOIN (
        SELECT creditor_code,
               COUNT(*) AS po_count,
               COUNT(CASE WHEN COALESCE(cancelled, 0) = 0
                           AND COALESCE(doc_status, '') != 'C' THEN 1 END) AS open_count,
               SUM(CASE WHEN COALESCE(cancelled, 0) = 0
                         THEN local_ex_tax ELSE 0 END) AS total_local_ex_tax
          FROM ${purchase_order_docs}
         GROUP BY creditor_code
      ) po ON po.creditor_code = c.creditor_code
      ${searchCond ? sql`WHERE ${searchCond}` : sql``}
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

app.get("/summary", async (c) => {
  const db = getDb(c.env);

  const totals = await db
    .select({
      total: sql<number>`COUNT(*)`,
      currency_count: sql<number>`COUNT(DISTINCT ${creditors.currency_code})`,
      type_count: sql<number>`COUNT(DISTINCT ${creditors.type})`,
    })
    .from(creditors);

  // Top 5 by spend — joins the PO aggregate again, but per-creditor
  // (no GROUP BY on creditors needed because of the JOIN shape).
  const top = await db.all<any>(sql`
    SELECT c.creditor_code, c.company_name AS creditor_name,
           COUNT(d.doc_no) AS po_count,
           COALESCE(SUM(CASE WHEN COALESCE(d.cancelled, 0) = 0
                              THEN d.local_ex_tax ELSE 0 END), 0) AS total_spend
      FROM ${creditors} c
      JOIN ${purchase_order_docs} d ON d.creditor_code = c.creditor_code
     GROUP BY c.creditor_code, c.company_name
     ORDER BY total_spend DESC
     LIMIT 5
  `);

  return c.json({
    totals: totals[0],
    top_by_spend: top,
  });
});

app.get("/:code", async (c) => {
  const code = c.req.param("code");
  const db = getDb(c.env);

  const cached = await db.get<any>(
    sql`SELECT * FROM ${creditors} WHERE creditor_code = ${code}`
  );
  if (!cached) return c.json({ error: "Creditor not found in mirror — try Refresh" }, 404);

  const poStats = await db.get<any>(sql`
    SELECT COUNT(*) AS total,
           COUNT(CASE WHEN COALESCE(cancelled, 0) = 0
                       AND COALESCE(doc_status, '') != 'C' THEN 1 END) AS open_count,
           COUNT(CASE WHEN COALESCE(cancelled, 0) = 0
                       AND doc_status = 'C' THEN 1 END) AS closed_count,
           COUNT(CASE WHEN cancelled = 1 THEN 1 END) AS cancelled_count,
           COALESCE(SUM(CASE WHEN COALESCE(cancelled, 0) = 0
                             THEN local_ex_tax ELSE 0 END), 0) AS total_spend
      FROM ${purchase_order_docs}
     WHERE creditor_code = ${code}
  `);

  const recentPos = await db
    .select({
      doc_no: purchase_order_docs.doc_no,
      doc_date: purchase_order_docs.doc_date,
      ref: purchase_order_docs.ref,
      doc_status: purchase_order_docs.doc_status,
      cancelled: purchase_order_docs.cancelled,
      local_ex_tax: purchase_order_docs.local_ex_tax,
      final_total: purchase_order_docs.final_total,
    })
    .from(purchase_order_docs)
    .where(eq(purchase_order_docs.creditor_code, code))
    .orderBy(desc(purchase_order_docs.doc_date))
    .limit(25);

  return c.json({
    creditor: cached,
    po_stats: poStats,
    recent_pos: recentPos,
  });
});

app.get("/:code/live", async (c) => {
  const code = c.req.param("code");
  try {
    const client = new AutoCountClient(c.env);
    const live = await client.getSingleCreditor(code);
    return c.json({ data: live });
  } catch (e: any) {
    return c.json({ error: e?.message || String(e) }, 502);
  }
});

app.post("/pull", async (c) => {
  const result = await runCreditorsPull(c.env, "MANUAL");
  return c.json(result);
});

export default app;
