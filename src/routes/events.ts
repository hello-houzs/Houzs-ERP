import { Hono } from "hono";
import type { Env } from "../types";
import { requirePermission } from "../middleware/auth";
import { hasPermission } from "../services/permissions";

const app = new Hono<{ Bindings: Env }>();

/**
 * Events — manual setup / dismantle calendar entries.
 *
 * Not tied to sales orders. The dispatcher creates them for one-off
 * jobs (e.g. "Setup at Customer X tomorrow"). Status is intentionally
 * a free-text field until the lifecycle is finalized — no validation
 * here so the dispatcher can experiment.
 *
 * Permissions:
 *   read  → trips.read.all
 *   write → trips.manage
 */

const PATCHABLE = ["type", "title", "event_date", "address", "status", "notes"] as const;

app.get("/", async (c) => {
  const user = c.get("user");
  if (!hasPermission(user.permissions, "trips.read.all")) {
    return c.json({ error: "Forbidden" }, 403);
  }
  const dateFrom = c.req.query("date_from");
  const dateTo = c.req.query("date_to");
  const type = c.req.query("type");

  const where: string[] = [];
  const binds: any[] = [];
  if (dateFrom) {
    where.push("event_date >= ?");
    binds.push(dateFrom);
  }
  if (dateTo) {
    where.push("event_date <= ?");
    binds.push(dateTo);
  }
  if (type) {
    where.push("type = ?");
    binds.push(type);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const rows = await c.env.DB.prepare(
    `SELECT e.*, u.name as created_by_name
       FROM events e
       LEFT JOIN users u ON u.id = e.created_by
     ${whereSql}
     ORDER BY e.event_date DESC, e.id DESC`
  )
    .bind(...binds)
    .all();

  return c.json({ data: rows.results ?? [] });
});

app.post("/", requirePermission("trips.manage"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json<any>();
  if (!body?.type || !body?.title || !body?.event_date) {
    return c.json({ error: "type, title, event_date required" }, 400);
  }
  if (body.type !== "setup" && body.type !== "dismantle") {
    return c.json({ error: "type must be setup or dismantle" }, 400);
  }
  const ins = await c.env.DB.prepare(
    `INSERT INTO events (type, title, event_date, address, status, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      body.type,
      body.title,
      body.event_date,
      body.address ?? null,
      body.status ?? null,
      body.notes ?? null,
      user.id
    )
    .run();
  return c.json({ id: ins.meta.last_row_id });
});

app.patch("/:id", requirePermission("trips.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (Number.isNaN(id)) return c.json({ error: "Bad id" }, 400);
  const body = await c.req.json<any>();

  const sets: string[] = [];
  const binds: any[] = [];
  for (const k of PATCHABLE) {
    if (k in body) {
      sets.push(`${k} = ?`);
      binds.push(body[k] ?? null);
    }
  }
  if (!sets.length) return c.json({ error: "No fields" }, 400);
  if ("type" in body && body.type !== "setup" && body.type !== "dismantle") {
    return c.json({ error: "type must be setup or dismantle" }, 400);
  }
  sets.push("updated_at = datetime('now')");
  binds.push(id);

  const r = await c.env.DB.prepare(
    `UPDATE events SET ${sets.join(", ")} WHERE id = ?`
  )
    .bind(...binds)
    .run();
  return c.json({ ok: r.meta.changes > 0 });
});

app.delete("/:id", requirePermission("trips.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (Number.isNaN(id)) return c.json({ error: "Bad id" }, 400);
  await c.env.DB.prepare(`DELETE FROM events WHERE id = ?`).bind(id).run();
  return c.json({ ok: true });
});

export default app;
