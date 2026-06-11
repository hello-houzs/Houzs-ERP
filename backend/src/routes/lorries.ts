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
    .catch(() => ({} as Record<string, never>));

  const plate = (body.plate ?? "").trim();
  const warehouse = (body.warehouse ?? "").trim();
  if (!plate) return c.json({ error: "Plate is required" }, 400);
  if (!warehouse) return c.json({ error: "Warehouse is required" }, 400);

  // FK guard — reject an unknown warehouse code with a clear message
  // rather than a raw constraint failure.
  const wh = await c.env.DB.prepare(
    `SELECT code FROM warehouses WHERE code = ?`
  )
    .bind(warehouse)
    .first();
  if (!wh) return c.json({ error: "Unknown warehouse" }, 400);

  // Friendly duplicate-plate check (UNIQUE constraint also enforces it).
  const dup = await c.env.DB.prepare(
    `SELECT id FROM lorries WHERE plate = ?`
  )
    .bind(plate)
    .first();
  if (dup) return c.json({ error: "A lorry with this plate already exists" }, 409);

  const isInternal = body.is_internal === false || body.is_internal === 0 ? 0 : 1;
  const status = (body.status ?? "active").trim() || "active";
  const size = (body.size ?? "").trim() || null;
  const model = (body.model ?? "").trim() || null;

  const res = await c.env.DB.prepare(
    `INSERT INTO lorries (plate, size, model, warehouse, is_internal, status, is_active)
     VALUES (?, ?, ?, ?, ?, ?, 1)`
  )
    .bind(plate, size, model, warehouse, isInternal, status)
    .run();

  return c.json({ ok: true, id: res.meta.last_row_id });
});

export default app;
