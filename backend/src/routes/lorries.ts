import { Hono } from "hono";
import type { Env } from "../types";
import { requirePermission } from "../middleware/auth";

const app = new Hono<{ Bindings: Env }>();

app.get("/", async (c) => {
  const warehouse = c.req.query("warehouse");
  const where = warehouse ? "WHERE l.warehouse = ? AND l.is_active = 1" : "WHERE l.is_active = 1";
  const binds = warehouse ? [warehouse] : [];
  const rows = await c.env.DB.prepare(
    `SELECT l.*, u.name as default_driver_name
       FROM lorries l
       LEFT JOIN users u ON u.id = l.default_driver_user_id
       ${where}
       ORDER BY l.is_internal DESC, l.warehouse, l.plate`
  )
    .bind(...binds)
    .all();
  return c.json({ data: rows.results ?? [] });
});

// Create a lorry. Fleet admins only. Plate + warehouse required; plate
// must be unique (DB UNIQUE) — we check up front for a friendly error.
// is_internal defaults to 1 (internal). status defaults to 'active'.
app.post("/", requirePermission("fleet.manage"), async (c) => {
  const body = await c.req
    .json<{
      plate?: string;
      size?: string;
      model?: string;
      warehouse?: string;
      is_internal?: boolean | number;
      status?: string;
    }>()
    .catch(() => ({}) as Record<string, never>);

  const plate = (body.plate ?? "").trim();
  const warehouse = (body.warehouse ?? "").trim();
  if (!plate) return c.json({ error: "Plate is required" }, 400);
  if (!warehouse) return c.json({ error: "Warehouse is required" }, 400);

  // FK guard — reject an unknown warehouse code with a clear message
  // rather than a raw constraint failure.
  const wh = await c.env.DB.prepare(`SELECT code FROM warehouses WHERE code = ?`)
    .bind(warehouse)
    .first();
  if (!wh) return c.json({ error: "Unknown warehouse" }, 400);

  const isInternal = body.is_internal === false || body.is_internal === 0 ? 0 : 1;
  const status = (body.status ?? "active").trim() || "active";
  const size = (body.size ?? "").trim() || null;
  const model = (body.model ?? "").trim() || null;

  // Duplicate-plate handling (plate is UNIQUE). An ACTIVE duplicate is a real
  // conflict. A soft-deleted (is_active=0) row with the same plate is
  // reactivated + overwritten, so delete-then-re-add of a plate works.
  const dup = await c.env.DB.prepare(`SELECT id, is_active FROM lorries WHERE plate = ?`)
    .bind(plate)
    .first<{ id: number; is_active: number }>();
  if (dup && dup.is_active) {
    return c.json({ error: "A lorry with this plate already exists" }, 409);
  }
  if (dup && !dup.is_active) {
    await c.env.DB.prepare(
      `UPDATE lorries SET size=?, model=?, warehouse=?, is_internal=?, status=?, is_active=1 WHERE id=?`
    )
      .bind(size, model, warehouse, isInternal, status, dup.id)
      .run();
    return c.json({ ok: true, id: dup.id, reactivated: true });
  }

  const res = await c.env.DB.prepare(
    `INSERT INTO lorries (plate, size, model, warehouse, is_internal, status, is_active)
     VALUES (?, ?, ?, ?, ?, ?, 1)`
  )
    .bind(plate, size, model, warehouse, isInternal, status)
    .run();

  return c.json({ ok: true, id: res.meta.last_row_id });
});

// Delete a lorry. Fleet admins only. Soft-delete (is_active=0) so any trip /
// history referencing it stays intact — it just leaves the roster + crew
// dropdown. The plate can be re-added later (POST reactivates it).
app.delete("/:id", requirePermission("fleet.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (Number.isNaN(id)) return c.json({ error: "Bad id" }, 400);
  const res = await c.env.DB.prepare(`UPDATE lorries SET is_active = 0 WHERE id = ?`)
    .bind(id)
    .run();
  if (!res.meta.changes) return c.json({ error: "Lorry not found" }, 404);
  return c.json({ ok: true });
});

export default app;
