import { Hono } from "hono";
import type { Env } from "../types";
import { runCreditorsPull } from "../services/creditors";
import { AutoCountClient } from "../services/autocount";

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

  const filterCols = [
    "creditor_code",
    "company_name",
    "desc2",
    "email",
    "phone1",
    "mobile",
    "tax_register_no",
  ];
  const like = search ? `%${search}%` : null;
  const wherePlain = like
    ? `WHERE (${filterCols.map((c) => `${c} LIKE ?`).join(" OR ")})`
    : "";
  const whereAliased = like
    ? `WHERE (${filterCols.map((c) => `c.${c} LIKE ?`).join(" OR ")})`
    : "";
  const binds = like ? filterCols.map(() => like) : [];

  const sortBy = c.req.query("sort_by") || "";
  const sortDir = (c.req.query("sort_dir") || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";
  const sortExpr = CREDITOR_SORT_MAP[sortBy] || "c.company_name";
  const orderBy = `ORDER BY ${sortExpr} ${sortDir}, c.creditor_code ASC`;

  const total = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count FROM creditors ${wherePlain}`
  )
    .bind(...binds)
    .first<{ count: number }>();

  const rows = await c.env.DB.prepare(
    `SELECT c.*,
            COALESCE(po.po_count, 0)            AS po_count,
            COALESCE(po.open_count, 0)          AS open_po_count,
            COALESCE(po.total_local_ex_tax, 0)  AS total_local_ex_tax
       FROM creditors c
       LEFT JOIN (
         SELECT creditor_code,
                COUNT(*) AS po_count,
                COUNT(CASE WHEN COALESCE(cancelled, 0) = 0
                            AND COALESCE(doc_status, '') != 'C' THEN 1 END) AS open_count,
                SUM(CASE WHEN COALESCE(cancelled, 0) = 0
                          THEN local_ex_tax ELSE 0 END) AS total_local_ex_tax
           FROM purchase_order_docs
          GROUP BY creditor_code
       ) po ON po.creditor_code = c.creditor_code
       ${whereAliased}
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

app.get("/summary", async (c) => {
  const totals = await c.env.DB.prepare(
    `SELECT COUNT(*) AS total,
            COUNT(DISTINCT currency_code) AS currency_count,
            COUNT(DISTINCT type) AS type_count
       FROM creditors`
  ).first<{ total: number; currency_count: number; type_count: number }>();

  const top = await c.env.DB.prepare(
    `SELECT c.creditor_code, c.company_name AS creditor_name,
            COUNT(d.doc_no) AS po_count,
            COALESCE(SUM(CASE WHEN COALESCE(d.cancelled, 0) = 0
                              THEN d.local_ex_tax ELSE 0 END), 0) AS total_spend
       FROM creditors c
       JOIN purchase_order_docs d ON d.creditor_code = c.creditor_code
      GROUP BY c.creditor_code, c.company_name
      ORDER BY total_spend DESC
      LIMIT 5`
  ).all();

  return c.json({
    totals,
    top_by_spend: top.results ?? [],
  });
});

app.get("/:code", async (c) => {
  const code = c.req.param("code");
  const cached = await c.env.DB.prepare(
    `SELECT * FROM creditors WHERE creditor_code = ?`
  )
    .bind(code)
    .first();
  if (!cached) return c.json({ error: "Creditor not found in mirror — try Refresh" }, 404);

  // Aggregate PO history for this creditor from the local PO mirror.
  const poStats = await c.env.DB.prepare(
    `SELECT COUNT(*) AS total,
            COUNT(CASE WHEN COALESCE(cancelled, 0) = 0
                        AND COALESCE(doc_status, '') != 'C' THEN 1 END) AS open_count,
            COUNT(CASE WHEN COALESCE(cancelled, 0) = 0
                        AND doc_status = 'C' THEN 1 END) AS closed_count,
            COUNT(CASE WHEN cancelled = 1 THEN 1 END) AS cancelled_count,
            COALESCE(SUM(CASE WHEN COALESCE(cancelled, 0) = 0
                              THEN local_ex_tax ELSE 0 END), 0) AS total_spend
       FROM purchase_order_docs
      WHERE creditor_code = ?`
  )
    .bind(code)
    .first();

  const recentPos = await c.env.DB.prepare(
    `SELECT doc_no, doc_date, ref, doc_status, cancelled, local_ex_tax, final_total
       FROM purchase_order_docs
      WHERE creditor_code = ?
      ORDER BY doc_date DESC
      LIMIT 25`
  )
    .bind(code)
    .all();

  return c.json({
    creditor: cached,
    po_stats: poStats,
    recent_pos: recentPos.results ?? [],
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
