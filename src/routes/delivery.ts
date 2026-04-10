import { Hono } from "hono";
import type { Env } from "../types";
import { requirePermission } from "../middleware/auth";
import {
  listDeliveries,
  getDelivery,
  advanceStatus,
  patchDelivery,
  createDeliveryRecord,
  getOverdueDeliveries,
} from "../services/delivery";

const app = new Hono<{ Bindings: Env }>();

/**
 * GET /api/delivery
 * List delivery records with filters: region, status (CSV), search, overdue_only, page, per_page.
 */
app.get("/", requirePermission("delivery_orders.read"), async (c) => {
  const result = await listDeliveries(c.env, {
    region: c.req.query("region") || undefined,
    status: c.req.query("status") || undefined,
    search: c.req.query("search") || undefined,
    overdue_only: c.req.query("overdue") === "1",
    page: parseInt(c.req.query("page") || "1", 10),
    per_page: parseInt(c.req.query("per_page") || "50", 10),
  });
  return c.json(result);
});

/**
 * GET /api/delivery/overdue
 * Returns all delivery records where a milestone date has passed
 * but the status hasn't advanced. Used by dispatchers + cron.
 */
app.get("/overdue", requirePermission("delivery_orders.read"), async (c) => {
  const data = await getOverdueDeliveries(c.env);
  return c.json(data);
});

/**
 * GET /api/delivery/:docNo
 * Single delivery record with full status log and allowed transitions.
 */
app.get("/:docNo", requirePermission("delivery_orders.read"), async (c) => {
  const docNo = c.req.param("docNo");
  const record = await getDelivery(c.env, docNo);
  if (!record) return c.json({ error: "Not found" }, 404);
  return c.json(record);
});

/**
 * POST /api/delivery/:docNo/advance
 * Body: { status, ...optional milestone updates }
 * Advances the delivery to the next status in the pipeline.
 */
app.post("/:docNo/advance", requirePermission("delivery_orders.write"), async (c) => {
  const docNo = c.req.param("docNo");
  const user = c.get("user");
  const body = await c.req.json<any>();
  if (!body.status) return c.json({ error: "status required" }, 400);

  try {
    const result = await advanceStatus(c.env, docNo, body.status, user.id, body);
    return c.json(result);
  } catch (e: any) {
    return c.json({ error: e?.message || "Advance failed" }, 400);
  }
});

/**
 * PATCH /api/delivery/:docNo
 * Edit fields without changing status (dates, costs, notes).
 */
app.patch("/:docNo", requirePermission("delivery_orders.write"), async (c) => {
  const docNo = c.req.param("docNo");
  const body = await c.req.json<any>();
  const ok = await patchDelivery(c.env, docNo, body);
  return c.json({ ok });
});

/**
 * POST /api/delivery
 * Manually create a delivery record.
 * Body: { doc_no, region }
 */
app.post("/", requirePermission("delivery_orders.write"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json<any>();
  if (!body.doc_no || !body.region) {
    return c.json({ error: "doc_no and region required" }, 400);
  }
  const result = await createDeliveryRecord(c.env, body.doc_no, {
    region: body.region,
    tripId: body.trip_id,
    createdBy: user.id,
  });
  return c.json(result);
});

export default app;
