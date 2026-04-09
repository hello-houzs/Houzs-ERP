import { Hono } from "hono";
import type { Env } from "../types";
import { runPOPull, pushPODates } from "../services/po";

const app = new Hono<{ Bindings: Env }>();

app.get("/summary", async (c) => {
  const totals = await c.env.DB.prepare(
    `SELECT COUNT(*) as line_count,
            COUNT(DISTINCT doc_no) as po_count,
            COUNT(DISTINCT creditor_code) as supplier_count,
            COALESCE(SUM(remaining_qty), 0) as remaining_qty
     FROM purchase_orders`
  ).first();

  const today = new Date().toISOString().slice(0, 10);
  const overdue = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM purchase_orders
     WHERE delivery_date IS NOT NULL AND delivery_date < ?`
  )
    .bind(today)
    .first<{ count: number }>();

  const noSupplierDate = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM purchase_orders
     WHERE (supplier_date1 IS NULL OR supplier_date1 = '')
       AND (supplier_date2 IS NULL OR supplier_date2 = '')
       AND (supplier_date3 IS NULL OR supplier_date3 = '')`
  ).first<{ count: number }>();

  const topSuppliers = await c.env.DB.prepare(
    `SELECT creditor_name as name, COUNT(*) as count
     FROM purchase_orders
     WHERE creditor_name IS NOT NULL
     GROUP BY creditor_name
     ORDER BY count DESC
     LIMIT 5`
  ).all();

  return c.json({
    totals,
    overdue: overdue?.count || 0,
    missing_supplier_date: noSupplierDate?.count || 0,
    top_suppliers: topSuppliers.results,
  });
});

app.get("/", async (c) => {
  const search = c.req.query("search");
  const page = parseInt(c.req.query("page") || "1", 10);
  const perPage = Math.min(parseInt(c.req.query("per_page") || "50", 10), 200);
  const offset = (page - 1) * perPage;

  const where: string[] = [];
  const binds: any[] = [];
  if (search) {
    where.push("(doc_no LIKE ? OR creditor_name LIKE ? OR item_code LIKE ?)");
    const like = `%${search}%`;
    binds.push(like, like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const total = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM purchase_orders ${whereSql}`
  )
    .bind(...binds)
    .first<{ count: number }>();

  const rows = await c.env.DB.prepare(
    `SELECT * FROM purchase_orders ${whereSql}
     ORDER BY doc_no ASC
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

app.post("/pull", async (c) => {
  const result = await runPOPull(c.env, "MANUAL");
  return c.json(result);
});

app.patch("/:docNo/:itemCode", async (c) => {
  const docNo = c.req.param("docNo");
  const itemCode = c.req.param("itemCode");
  const body = await c.req.json<{
    overdue_days?: string | null;
    supplier_date1?: string | null;
    supplier_date2?: string | null;
    supplier_date3?: string | null;
  }>();

  const allowed = ["overdue_days", "supplier_date1", "supplier_date2", "supplier_date3"] as const;
  const sets: string[] = [];
  const binds: any[] = [];
  for (const k of allowed) {
    if (k in body) {
      sets.push(`${k} = ?`);
      binds.push((body as any)[k] ?? null);
    }
  }
  if (!sets.length) return c.json({ error: "No fields to update" }, 400);

  binds.push(docNo, itemCode);
  const res = await c.env.DB.prepare(
    `UPDATE purchase_orders SET ${sets.join(", ")} WHERE doc_no = ? AND item_code = ?`
  )
    .bind(...binds)
    .run();

  if (!res.meta.changes) return c.json({ error: "PO line not found" }, 404);
  return c.json({ ok: true });
});

app.post("/:docNo/sync-dates", async (c) => {
  const docNo = c.req.param("docNo");
  const result = await pushPODates(c.env, docNo);
  if (!result.ok) return c.json({ ok: false, error: result.error }, 502);
  return c.json({ ok: true });
});

export default app;
