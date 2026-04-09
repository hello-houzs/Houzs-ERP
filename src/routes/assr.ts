import { Hono } from "hono";
import type { Env } from "../types";
import { createAssrCase } from "../services/assr";

const app = new Hono<{ Bindings: Env }>();

const ASSR_FIELDS = [
  "status", "complained_date", "customer_name", "phone", "location", "sales_agent",
  "item_code", "complaint_issue", "action_remark", "service_category", "supplier",
  "completion_date", "po_no", "addr1", "addr2", "addr3", "addr4",
] as const;

app.get("/summary", async (c) => {
  const totals = await c.env.DB.prepare(
    `SELECT COUNT(*) as total FROM assr_cases`
  ).first<{ total: number }>();

  const byStatus = await c.env.DB.prepare(
    `SELECT status, COUNT(*) as count FROM assr_cases GROUP BY status`
  ).all();

  const byLocation = await c.env.DB.prepare(
    `SELECT location, COUNT(*) as count FROM assr_cases
     WHERE location IS NOT NULL
     GROUP BY location ORDER BY count DESC LIMIT 5`
  ).all();

  const byCategory = await c.env.DB.prepare(
    `SELECT service_category as name, COUNT(*) as count FROM assr_cases
     WHERE service_category IS NOT NULL
     GROUP BY service_category ORDER BY count DESC LIMIT 5`
  ).all();

  const recent = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM assr_cases
     WHERE complained_date IS NOT NULL
       AND complained_date >= date('now', '-30 days')`
  ).first<{ count: number }>();

  return c.json({
    total: totals?.total || 0,
    by_status: byStatus.results,
    by_location: byLocation.results,
    by_category: byCategory.results,
    recent_30d: recent?.count || 0,
  });
});

app.get("/", async (c) => {
  const status = c.req.query("status");
  const search = c.req.query("search");
  const page = parseInt(c.req.query("page") || "1", 10);
  const perPage = Math.min(parseInt(c.req.query("per_page") || "50", 10), 200);
  const offset = (page - 1) * perPage;

  const where: string[] = [];
  const binds: any[] = [];
  if (status) {
    where.push("status = ?");
    binds.push(status);
  }
  if (search) {
    where.push("(assr_no LIKE ? OR doc_no LIKE ? OR customer_name LIKE ?)");
    const like = `%${search}%`;
    binds.push(like, like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const total = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM assr_cases ${whereSql}`
  )
    .bind(...binds)
    .first<{ count: number }>();

  const rows = await c.env.DB.prepare(
    `SELECT * FROM assr_cases ${whereSql}
     ORDER BY id DESC
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

app.post("/", async (c) => {
  const body = await c.req.json<{ doc_no: string; item_code: string; complaint_issue: string }>();
  if (!body.doc_no || !body.item_code || !body.complaint_issue) {
    return c.json({ error: "doc_no, item_code, and complaint_issue are required" }, 400);
  }
  const result = await createAssrCase(c.env, body);
  return c.json(result, 201);
});

app.patch("/:assrNo", async (c) => {
  const assrNo = c.req.param("assrNo");
  const body = await c.req.json<Record<string, any>>();

  const sets: string[] = [];
  const binds: any[] = [];
  for (const k of ASSR_FIELDS) {
    if (k in body) {
      sets.push(`${k} = ?`);
      binds.push(body[k] ?? null);
    }
  }
  if (!sets.length) return c.json({ error: "No valid fields" }, 400);

  sets.push("updated_at = datetime('now')");
  binds.push(assrNo);

  const res = await c.env.DB.prepare(
    `UPDATE assr_cases SET ${sets.join(", ")} WHERE assr_no = ?`
  )
    .bind(...binds)
    .run();

  if (!res.meta.changes) return c.json({ error: "ASSR case not found" }, 404);
  return c.json({ ok: true });
});

export default app;
