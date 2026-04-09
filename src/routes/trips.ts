import { Hono } from "hono";
import type { Env } from "../types";
import { requirePermission } from "../middleware/auth";
import { hasPermission } from "../services/permissions";
import {
  listTrips,
  getTrip,
  createTrip,
  patchTrip,
  transitionTrip,
  patchStop,
  appendLocations,
  podKey,
  putPodObject,
  getPodObject,
  tripBelongsToDriver,
} from "../services/trips";

const app = new Hono<{ Bindings: Env }>();

/**
 * Permission model:
 *   trips.read.all  → dispatcher; sees every trip
 *   trips.read.own  → driver;     auto-scoped to driver_user_id = me
 *   trips.write     → driver/dispatcher; can update progress on a trip
 *                     they own (drivers) or any trip (managers)
 *   trips.manage    → dispatcher; create / cancel / re-assign
 *
 * Drivers with only `trips.read.own` + `trips.write` get a fully working
 * mobile flow without ever seeing other drivers' trips.
 */

function canReadAll(c: any) {
  return hasPermission(c.get("user").permissions, "trips.read.all");
}
function canManage(c: any) {
  return hasPermission(c.get("user").permissions, "trips.manage");
}

// ── List trips ─────────────────────────────────────────────────────
app.get("/", async (c) => {
  const user = c.get("user");
  const all = canReadAll(c);
  const own = hasPermission(user.permissions, "trips.read.own");
  if (!all && !own) return c.json({ error: "Forbidden" }, 403);

  const result = await listTrips(c.env, {
    driver_user_id: all ? undefined : user.id,
    warehouse: c.req.query("warehouse") || undefined,
    status: c.req.query("status") || undefined,
    date_from: c.req.query("date_from") || undefined,
    date_to: c.req.query("date_to") || undefined,
    search: c.req.query("search") || undefined,
    page: parseInt(c.req.query("page") || "1", 10),
    per_page: parseInt(c.req.query("per_page") || "50", 10),
  });

  return c.json(result);
});

// ── Driver "today" shortcut ────────────────────────────────────────
// Returns trips assigned to the current user with trip_date >= today.
// Driver Home calls this.
app.get("/mine/today", async (c) => {
  const user = c.get("user");
  if (
    !hasPermission(user.permissions, "trips.read.own") &&
    !hasPermission(user.permissions, "trips.read.all")
  ) {
    return c.json({ error: "Forbidden" }, 403);
  }
  const today = new Date().toISOString().slice(0, 10);
  const rows = await c.env.DB.prepare(
    `SELECT t.*, l.plate as lorry_plate, l.size as lorry_size,
            w.name as warehouse_name,
            (SELECT COUNT(*) FROM trip_stops s WHERE s.trip_id = t.id) as stop_count_actual,
            (SELECT COUNT(*) FROM trip_stops s WHERE s.trip_id = t.id AND s.status IN ('delivered','failed')) as stops_done
       FROM trips t
       LEFT JOIN lorries l ON l.id = t.lorry_id
       LEFT JOIN warehouses w ON w.code = t.warehouse
      WHERE t.driver_user_id = ?
        AND t.trip_date >= ?
        AND t.status IN ('assigned','started','in_progress')
      ORDER BY t.trip_date ASC, t.id ASC`
  )
    .bind(user.id, today)
    .all();
  return c.json({ data: rows.results ?? [] });
});

// ── Trip detail ────────────────────────────────────────────────────
app.get("/:id", async (c) => {
  const user = c.get("user");
  const id = parseInt(c.req.param("id"), 10);
  if (Number.isNaN(id)) return c.json({ error: "Bad id" }, 400);

  const trip = await getTrip(c.env, id);
  if (!trip) return c.json({ error: "Not found" }, 404);

  // Driver scope check
  if (!canReadAll(c) && trip.trip.driver_user_id !== user.id) {
    return c.json({ error: "Forbidden" }, 403);
  }
  return c.json(trip);
});

// ── Create trip (manual, dispatcher) ───────────────────────────────
app.post("/", requirePermission("trips.manage"), async (c) => {
  const user = c.get("user");
  const body = await c.req.json<any>();
  if (!body.warehouse || !body.trip_date || !Array.isArray(body.stops)) {
    return c.json({ error: "warehouse, trip_date, stops required" }, 400);
  }
  const id = await createTrip(c.env, body, user.id);
  return c.json({ id });
});

// ── Patch trip ─────────────────────────────────────────────────────
app.patch("/:id", async (c) => {
  const user = c.get("user");
  const id = parseInt(c.req.param("id"), 10);
  if (Number.isNaN(id)) return c.json({ error: "Bad id" }, 400);

  const body = await c.req.json<any>();

  // Driver may patch only their own trip and only progress fields.
  if (!canManage(c)) {
    if (
      !hasPermission(user.permissions, "trips.write") ||
      !(await tripBelongsToDriver(c.env, id, user.id))
    ) {
      return c.json({ error: "Forbidden" }, 403);
    }
    const allowed = new Set([
      "status",
      "started_at",
      "completed_at",
      "start_odometer",
      "end_odometer",
      "fuel_litres",
      "fuel_cost",
      "notes",
    ]);
    for (const k of Object.keys(body)) {
      if (!allowed.has(k)) delete body[k];
    }
  }

  // Auto-stamp common transitions
  if (body.status && !body.started_at && !body.completed_at) {
    const ok = await transitionTrip(c.env, id, body.status);
    delete body.status;
    if (Object.keys(body).length) await patchTrip(c.env, id, body);
    return c.json({ ok });
  }

  const ok = await patchTrip(c.env, id, body);
  return c.json({ ok });
});

// ── Reorder stops (after Optimize Route) ───────────────────────────
app.post("/:id/reorder", requirePermission("trips.manage"), async (c) => {
  const tripId = parseInt(c.req.param("id"), 10);
  if (Number.isNaN(tripId)) return c.json({ error: "Bad id" }, 400);
  const body = await c.req.json<any>();
  const order: number[] = Array.isArray(body?.stop_ids) ? body.stop_ids : [];
  if (!order.length) return c.json({ error: "stop_ids required" }, 400);

  const stmts = order.map((stopId, i) =>
    c.env.DB.prepare(
      `UPDATE trip_stops SET sequence = ?, updated_at = datetime('now')
        WHERE id = ? AND trip_id = ?`
    ).bind(i + 1, stopId, tripId)
  );
  await c.env.DB.batch(stmts);
  return c.json({ ok: true, count: order.length });
});

// ── Cancel trip ────────────────────────────────────────────────────
app.delete("/:id", requirePermission("trips.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (Number.isNaN(id)) return c.json({ error: "Bad id" }, 400);
  const ok = await transitionTrip(c.env, id, "cancelled");
  return c.json({ ok });
});

// ── Patch stop (driver progress) ───────────────────────────────────
app.patch("/:id/stops/:stopId", async (c) => {
  const user = c.get("user");
  const tripId = parseInt(c.req.param("id"), 10);
  const stopId = parseInt(c.req.param("stopId"), 10);
  if (Number.isNaN(tripId) || Number.isNaN(stopId)) return c.json({ error: "Bad id" }, 400);

  if (!canManage(c)) {
    if (
      !hasPermission(user.permissions, "trips.write") ||
      !(await tripBelongsToDriver(c.env, tripId, user.id))
    ) {
      return c.json({ error: "Forbidden" }, 403);
    }
  }

  const body = await c.req.json<any>();
  const ok = await patchStop(c.env, tripId, stopId, body);
  return c.json({ ok });
});

// ── GPS pings ──────────────────────────────────────────────────────
app.post("/:id/locations", async (c) => {
  const user = c.get("user");
  const tripId = parseInt(c.req.param("id"), 10);
  if (Number.isNaN(tripId)) return c.json({ error: "Bad id" }, 400);

  if (!canManage(c)) {
    if (
      !hasPermission(user.permissions, "trips.write") ||
      !(await tripBelongsToDriver(c.env, tripId, user.id))
    ) {
      return c.json({ error: "Forbidden" }, 403);
    }
  }

  const body = await c.req.json<any>();
  const pings = Array.isArray(body) ? body : Array.isArray(body.pings) ? body.pings : [];
  const inserted = await appendLocations(c.env, tripId, pings);
  return c.json({ inserted });
});

app.get("/:id/locations", async (c) => {
  const user = c.get("user");
  const tripId = parseInt(c.req.param("id"), 10);
  if (Number.isNaN(tripId)) return c.json({ error: "Bad id" }, 400);

  if (!canReadAll(c) && !(await tripBelongsToDriver(c.env, tripId, user.id))) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const rows = await c.env.DB.prepare(
    `SELECT lat, lng, accuracy, recorded_at FROM trip_locations
      WHERE trip_id = ? ORDER BY recorded_at ASC`
  )
    .bind(tripId)
    .all();
  return c.json({ data: rows.results ?? [] });
});

// ── POD upload (binary, multipart not needed) ─────────────────────
// PUT /api/trips/:id/stops/:stopId/pod?kind=photo|signature&ext=jpg
// Body = raw bytes. Returns the R2 key, which the client then PATCHes
// onto the stop record.
app.put("/:id/stops/:stopId/pod", async (c) => {
  const user = c.get("user");
  const tripId = parseInt(c.req.param("id"), 10);
  const stopId = parseInt(c.req.param("stopId"), 10);
  if (Number.isNaN(tripId) || Number.isNaN(stopId)) return c.json({ error: "Bad id" }, 400);

  if (!canManage(c)) {
    if (
      !hasPermission(user.permissions, "trips.write") ||
      !(await tripBelongsToDriver(c.env, tripId, user.id))
    ) {
      return c.json({ error: "Forbidden" }, 403);
    }
  }

  const kind = (c.req.query("kind") || "photo") as "photo" | "signature";
  const ext = (c.req.query("ext") || (kind === "signature" ? "png" : "jpg")).toLowerCase();
  if (!["jpg", "jpeg", "png", "webp"].includes(ext)) {
    return c.json({ error: "Bad ext" }, 400);
  }
  const contentType =
    ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";

  const body = await c.req.arrayBuffer();
  if (!body || body.byteLength === 0) return c.json({ error: "Empty body" }, 400);
  if (body.byteLength > 8 * 1024 * 1024) return c.json({ error: "Too large (>8MB)" }, 413);

  const key = podKey(tripId, stopId, kind, ext);
  await putPodObject(c.env, key, body, contentType);

  // Auto-record on the stop
  const col = kind === "photo" ? "pod_photo_r2_key" : "signature_r2_key";
  await c.env.DB.prepare(
    `UPDATE trip_stops SET ${col} = ?, updated_at = datetime('now')
      WHERE id = ? AND trip_id = ?`
  )
    .bind(key, stopId, tripId)
    .run();

  return c.json({ key });
});

// ── Serve POD asset (signed by session) ───────────────────────────
app.get("/pod/*", async (c) => {
  const user = c.get("user");
  // Path after /pod/
  const url = new URL(c.req.url);
  const idx = url.pathname.indexOf("/pod/");
  const key = url.pathname.slice(idx + 5);
  if (!key) return c.json({ error: "Bad key" }, 400);

  // Pull the trip id out of the key (pod/<tripId>/...).
  const m = key.match(/^pod\/(\d+)\//);
  const tripId = m ? parseInt(m[1], 10) : null;
  if (!tripId) return c.json({ error: "Bad key" }, 400);

  if (!canReadAll(c) && !(await tripBelongsToDriver(c.env, tripId, user.id))) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const obj = await getPodObject(c.env, key);
  if (!obj) return c.json({ error: "Not found" }, 404);
  return new Response(obj.body, {
    headers: {
      "content-type": obj.httpMetadata?.contentType || "application/octet-stream",
      "cache-control": "private, max-age=3600",
    },
  });
});

export default app;
