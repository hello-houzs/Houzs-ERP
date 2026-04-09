import { Hono } from "hono";
import type { Env } from "../types";
import { requirePermission } from "../middleware/auth";
import { geocode, directions, joinAddress, warehouseForState } from "../services/maps";
import { DELIVERY_WHERE } from "../services/deliveryFilter";

const app = new Hono<{ Bindings: Env }>();

/**
 * GET /api/maps/geocode?q=...
 * Single ad-hoc geocode. Used by the dispatcher's address-fix UI.
 */
app.get("/geocode", async (c) => {
  const q = c.req.query("q") || "";
  if (!q) return c.json({ error: "q required" }, 400);
  try {
    const r = await geocode(c.env, q);
    return c.json({ result: r });
  } catch (e: any) {
    return c.json({ error: e?.message || "Geocode failed" }, 500);
  }
});

/**
 * POST /api/maps/directions
 * Body: { origin, destination, waypoints?, optimize? }
 * Both driver and dispatcher call this — drivers to draw the route on
 * their in-trip map, dispatchers to plan/optimize.
 */
app.post("/directions", async (c) => {
  const body = await c.req.json<any>();
  if (!body?.origin || !body?.destination) {
    return c.json({ error: "origin + destination required" }, 400);
  }
  try {
    const r = await directions(c.env, {
      origin: body.origin,
      destination: body.destination,
      waypoints: body.waypoints || [],
      optimize: !!body.optimize,
    });
    return c.json(r);
  } catch (e: any) {
    return c.json({ error: e?.message || "Directions failed" }, 500);
  }
});

/**
 * POST /api/maps/backfill-orders { limit?: number }
 * Iterates order_details rows missing lat/lng, geocodes the matching
 * sales_orders address, and caches the result. Owner-only because it
 * spends Google Geocoding quota. Returns counts so the UI can report
 * progress; the dispatcher should re-run until `remaining` hits 0.
 */
app.post("/backfill-orders", requirePermission("trips.manage"), async (c) => {
  const body = await c.req.json<any>().catch(() => ({}));
  const limit = Math.min(Math.max(parseInt(body?.limit ?? "50", 10), 1), 200);

  // Only orders that currently appear in the Delivery tab AND aren't
  // already geocoded. This skips cancelled, scheduled, and out-of-scope
  // sales orders so we don't burn quota on rows the dispatcher will
  // never plan a trip for.
  const rows = await c.env.DB.prepare(
    `SELECT so.doc_no, so.inv_addr1, so.inv_addr2, so.inv_addr3, so.inv_addr4
       FROM sales_orders so
       LEFT JOIN order_details od ON od.doc_no = so.doc_no
      WHERE (${DELIVERY_WHERE})
        AND (od.lat IS NULL OR od.lng IS NULL)
      LIMIT ?`
  )
    .bind(limit)
    .all<any>();

  let geocoded = 0;
  let skipped = 0;
  let failed = 0;

  for (const r of rows.results ?? []) {
    const addr = joinAddress([r.inv_addr1, r.inv_addr2, r.inv_addr3, r.inv_addr4]);
    if (!addr) {
      skipped++;
      continue;
    }
    try {
      const result = await geocode(c.env, addr);
      if (!result) {
        skipped++;
        continue;
      }
      // Look up warehouse from the state Google returned. Falls back to
      // null if Google didn't classify the result (rare for MY addresses).
      const warehouse = await warehouseForState(c.env, result.state, result.country);

      // Upsert into order_details (row may not exist yet for orders with
      // no manual delivery edits).
      await c.env.DB.prepare(
        `INSERT INTO order_details (doc_no, lat, lng, state, warehouse, geocoded_at, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(doc_no) DO UPDATE SET
           lat = excluded.lat,
           lng = excluded.lng,
           state = excluded.state,
           warehouse = excluded.warehouse,
           geocoded_at = datetime('now'),
           updated_at = datetime('now')`
      )
        .bind(r.doc_no, result.lat, result.lng, result.state, warehouse)
        .run();
      geocoded++;
    } catch {
      failed++;
    }
  }

  // How many still need geocoding within the Delivery scope?
  const remainingRow = await c.env.DB.prepare(
    `SELECT COUNT(*) as count
       FROM sales_orders so
       LEFT JOIN order_details od ON od.doc_no = so.doc_no
      WHERE (${DELIVERY_WHERE})
        AND (od.lat IS NULL OR od.lng IS NULL)`
  ).first<{ count: number }>();

  return c.json({
    processed: rows.results?.length ?? 0,
    geocoded,
    skipped,
    failed,
    remaining: remainingRow?.count ?? 0,
  });
});

/**
 * POST /api/maps/geocode-order/:docNo
 * Geocode a single order on demand. Cheaper than backfill for fixing
 * stragglers from the dispatcher panel.
 */
app.post("/geocode-order/:docNo", requirePermission("trips.manage"), async (c) => {
  const docNo = c.req.param("docNo");
  const order = await c.env.DB.prepare(
    `SELECT inv_addr1, inv_addr2, inv_addr3, inv_addr4 FROM sales_orders WHERE doc_no = ?`
  )
    .bind(docNo)
    .first<any>();
  if (!order) return c.json({ error: "Order not found" }, 404);

  const addr = joinAddress([order.inv_addr1, order.inv_addr2, order.inv_addr3, order.inv_addr4]);
  if (!addr) return c.json({ error: "No address" }, 400);

  const result = await geocode(c.env, addr);
  if (!result) return c.json({ error: "Could not geocode" }, 422);

  const warehouse = await warehouseForState(c.env, result.state, result.country);

  await c.env.DB.prepare(
    `INSERT INTO order_details (doc_no, lat, lng, state, warehouse, geocoded_at, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(doc_no) DO UPDATE SET
       lat = excluded.lat, lng = excluded.lng,
       state = excluded.state, warehouse = excluded.warehouse,
       geocoded_at = datetime('now'), updated_at = datetime('now')`
  )
    .bind(docNo, result.lat, result.lng, result.state, warehouse)
    .run();

  return c.json({ ...result, warehouse });
});

export default app;
