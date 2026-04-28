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
import { getDb } from "../db/client";
import {
  lorries,
  lorry_incidents,
  salary_trip_lines,
  trips,
  trip_locations,
  trip_stops,
  warehouses,
} from "../db/schema";
import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";

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
// Delegates to services/trips.ts which is still raw SQL — that file is
// queued for a future Drizzle pass once the conversion proves itself
// on the lighter route handlers.
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
    sort_by: c.req.query("sort_by") || undefined,
    sort_dir: (c.req.query("sort_dir") || "").toLowerCase() === "asc" ? "asc" : "desc",
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
  const db = getDb(c.env);
  const rows = await db
    .select({
      // Spread trip columns. SQL builder can't `t.*` so list explicitly.
      id: trips.id,
      driver_user_id: trips.driver_user_id,
      lorry_id: trips.lorry_id,
      warehouse: trips.warehouse,
      trip_date: trips.trip_date,
      status: trips.status,
      started_at: trips.started_at,
      completed_at: trips.completed_at,
      lorry_plate: lorries.plate,
      lorry_size: lorries.size,
      warehouse_name: warehouses.name,
      stop_count_actual: sql<number>`(
        SELECT COUNT(*) FROM ${trip_stops} s WHERE s.trip_id = ${trips.id}
      )`,
      stops_done: sql<number>`(
        SELECT COUNT(*) FROM ${trip_stops} s
         WHERE s.trip_id = ${trips.id}
           AND s.status IN ('delivered','failed')
      )`,
    })
    .from(trips)
    .leftJoin(lorries, eq(lorries.id, trips.lorry_id))
    .leftJoin(warehouses, eq(warehouses.code, trips.warehouse))
    .where(
      and(
        eq(trips.driver_user_id, user.id),
        gte(trips.trip_date, today),
        inArray(trips.status, ["assigned", "started", "in_progress"])
      )
    )
    .orderBy(asc(trips.trip_date), asc(trips.id));
  return c.json({ data: rows });
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

  const db = getDb(c.env);
  // One UPDATE per stop — Drizzle queries auto-prepare. Could be a
  // batch but the count is small (≤10 typically) and serial is fine.
  for (let i = 0; i < order.length; i++) {
    await db
      .update(trip_stops)
      .set({
        sequence: i + 1,
        updated_at: sql`datetime('now')` as unknown as string,
      })
      .where(and(eq(trip_stops.id, order[i]), eq(trip_stops.trip_id, tripId)));
  }
  return c.json({ ok: true, count: order.length });
});

// ── Hard delete (permanent) ───────────────────────────────────────
// Only allowed for trips already in a terminal status (completed or
// cancelled). Used to clear the History tab — typically when test
// data piled up before go-live. Once gone, the underlying sales
// orders return to the Queue tab automatically because Queue derives
// from "orders not currently on a trip".
//
// Cascades: trip_stops + trip_locations have ON DELETE CASCADE in
// schema. lorry_incidents.trip_id is nullable so we null it.
// salary_trip_lines is hard-deleted (test data has no payroll
// implication; if this changes we'd add a guard).
//
// Note: the path is registered BEFORE the soft-cancel `/:id` route
// so Hono's pattern matcher routes `/:id/permanent` here instead of
// treating "permanent" as the id.
app.delete("/:id/permanent", requirePermission("trips.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (Number.isNaN(id)) return c.json({ error: "Bad id" }, 400);

  const db = getDb(c.env);
  const row = await db
    .select({ status: trips.status })
    .from(trips)
    .where(eq(trips.id, id))
    .limit(1);
  if (row.length === 0) return c.json({ error: "Not found" }, 404);
  if (row[0].status !== "completed" && row[0].status !== "cancelled") {
    return c.json(
      {
        error:
          "Only completed or cancelled trips can be permanently deleted. Cancel the trip first.",
      },
      409
    );
  }

  // Sequential to keep this readable; the row counts are small.
  await db
    .update(lorry_incidents)
    .set({ trip_id: null })
    .where(eq(lorry_incidents.trip_id, id));
  await db.delete(salary_trip_lines).where(eq(salary_trip_lines.trip_id, id));
  await db.delete(trip_locations).where(eq(trip_locations.trip_id, id));
  await db.delete(trip_stops).where(eq(trip_stops.trip_id, id));
  await db.delete(trips).where(eq(trips.id, id));
  return c.json({ ok: true });
});

// ── Clear all history (bulk hard delete) ──────────────────────────
// One-shot for wiping every completed + cancelled trip. Same cascade
// semantics as /:id/permanent. Optional ?warehouse= filter so a
// single-warehouse cleanup doesn't nuke another region's history.
app.delete("/history/clear", requirePermission("trips.manage"), async (c) => {
  const warehouse = c.req.query("warehouse") || null;

  const db = getDb(c.env);
  const idRows = await db
    .select({ id: trips.id })
    .from(trips)
    .where(
      warehouse
        ? and(
            inArray(trips.status, ["completed", "cancelled"]),
            eq(trips.warehouse, warehouse)
          )
        : inArray(trips.status, ["completed", "cancelled"])
    );
  const ids = idRows.map((r) => r.id);
  if (ids.length === 0) return c.json({ ok: true, deleted: 0 });

  await db
    .update(lorry_incidents)
    .set({ trip_id: null })
    .where(inArray(lorry_incidents.trip_id, ids));
  await db.delete(salary_trip_lines).where(inArray(salary_trip_lines.trip_id, ids));
  await db.delete(trip_locations).where(inArray(trip_locations.trip_id, ids));
  await db.delete(trip_stops).where(inArray(trip_stops.trip_id, ids));
  await db.delete(trips).where(inArray(trips.id, ids));
  return c.json({ ok: true, deleted: ids.length });
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

  const db = getDb(c.env);
  const rows = await db
    .select({
      lat: trip_locations.lat,
      lng: trip_locations.lng,
      accuracy: trip_locations.accuracy,
      recorded_at: trip_locations.recorded_at,
    })
    .from(trip_locations)
    .where(eq(trip_locations.trip_id, tripId))
    .orderBy(asc(trip_locations.recorded_at));
  return c.json({ data: rows });
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
  const db = getDb(c.env);
  const set: Record<string, any> = {
    updated_at: sql`datetime('now')`,
  };
  if (kind === "photo") set.pod_photo_r2_key = key;
  else set.signature_r2_key = key;
  await db
    .update(trip_stops)
    .set(set)
    .where(and(eq(trip_stops.id, stopId), eq(trip_stops.trip_id, tripId)));

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
