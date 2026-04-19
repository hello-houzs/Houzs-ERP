import type { Env } from "../types";

/**
 * Trip-tracking service. Pure data layer over D1 + R2 — route handlers
 * stay thin and just call into here.
 *
 * Trip status flow:
 *   assigned → started → in_progress → completed
 *                                    ↘ cancelled (any time before completed)
 *
 * Stop status flow:
 *   pending → arrived → delivered
 *                    ↘ failed
 *
 * Trip auto-advances to in_progress on the first arrival, and a stop's
 * completion does NOT auto-complete the trip — drivers tap End Trip
 * explicitly so they can record end odometer/fuel.
 */

// ── Trip number generator ──────────────────────────────────────────
// Format: TRIP/YYMM-NNN, counter persisted in system_settings.
// One row keyed 'trip_no_counter' holds a JSON map { "YYMM": <last> }.

export async function nextTripNo(env: Env): Promise<string> {
  const now = new Date();
  const yymm = `${String(now.getUTCFullYear()).slice(2)}${String(
    now.getUTCMonth() + 1
  ).padStart(2, "0")}`;

  const row = await env.DB.prepare(
    `SELECT value FROM system_settings WHERE key = 'trip_no_counter'`
  ).first<{ value: string }>();

  let counters: Record<string, number> = {};
  try {
    counters = row?.value ? JSON.parse(row.value) : {};
  } catch {
    counters = {};
  }
  const next = (counters[yymm] ?? 0) + 1;
  counters[yymm] = next;

  await env.DB.prepare(
    `INSERT INTO system_settings (key, value) VALUES ('trip_no_counter', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  )
    .bind(JSON.stringify(counters))
    .run();

  return `TRIP/${yymm}-${String(next).padStart(3, "0")}`;
}

// ── Trip listing ───────────────────────────────────────────────────

export interface ListTripsFilters {
  driver_user_id?: number; // forced when caller only has trips.read.own
  warehouse?: string;
  status?: string;
  date_from?: string;
  date_to?: string;
  search?: string;
  page?: number;
  per_page?: number;
  sort_by?: string;
  sort_dir?: "asc" | "desc";
}

// Allow-listed sort columns for the trips list. Joined names use the
// table aliases from the SELECT below.
const TRIP_SORT_MAP: Record<string, string> = {
  trip_no: "t.trip_no",
  trip_date: "t.trip_date",
  warehouse: "t.warehouse",
  status: "t.status",
  trip_type: "t.trip_type",
  is_outsourced: "t.is_outsourced",
  stop_count: "t.stop_count",
  total_revenue: "t.total_revenue",
  total_distance_km: "t.total_distance_km",
  fuel_litres: "t.fuel_litres",
  fuel_cost: "t.fuel_cost",
  started_at: "t.started_at",
  completed_at: "t.completed_at",
  clock_in_at: "t.clock_in_at",
  clock_out_at: "t.clock_out_at",
  driver_name: "u.name",
  lorry_plate: "l.plate",
  lorry_size: "l.size",
};

export async function listTrips(env: Env, f: ListTripsFilters) {
  const where: string[] = [];
  const binds: any[] = [];

  if (f.driver_user_id != null) {
    where.push("t.driver_user_id = ?");
    binds.push(f.driver_user_id);
  }
  if (f.warehouse) {
    where.push("t.warehouse = ?");
    binds.push(f.warehouse);
  }
  if (f.status) {
    // Comma-separated allows multi-status filters from the tabs
    const statuses = f.status.split(",").map((s) => s.trim()).filter(Boolean);
    if (statuses.length === 1) {
      where.push("t.status = ?");
      binds.push(statuses[0]);
    } else if (statuses.length > 1) {
      const placeholders = statuses.map(() => "?").join(",");
      where.push(`t.status IN (${placeholders})`);
      binds.push(...statuses);
    }
  }
  if (f.date_from) {
    where.push("t.trip_date >= ?");
    binds.push(f.date_from);
  }
  if (f.date_to) {
    where.push("t.trip_date <= ?");
    binds.push(f.date_to);
  }
  if (f.search) {
    where.push("(t.trip_no LIKE ? OR l.plate LIKE ? OR u.name LIKE ?)");
    const like = `%${f.search}%`;
    binds.push(like, like, like);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const page = f.page && f.page > 0 ? f.page : 1;
  const perPage = Math.min(f.per_page ?? 50, 200);
  const offset = (page - 1) * perPage;

  const total = await env.DB.prepare(
    `SELECT COUNT(*) as count FROM trips t
       LEFT JOIN lorries l ON l.id = t.lorry_id
       LEFT JOIN users u ON u.id = t.driver_user_id
     ${whereSql}`
  )
    .bind(...binds)
    .first<{ count: number }>();

  const sortExpr = f.sort_by ? TRIP_SORT_MAP[f.sort_by] : null;
  const sortDir = f.sort_dir === "asc" ? "ASC" : "DESC";
  const orderBy = sortExpr
    ? `ORDER BY ${sortExpr} ${sortDir}, t.id DESC`
    : `ORDER BY t.trip_date DESC, t.id DESC`;

  const rows = await env.DB.prepare(
    `SELECT t.*, l.plate as lorry_plate, l.size as lorry_size,
            u.name as driver_name, u.email as driver_email,
            h1.name as helper_1_name, h2.name as helper_2_name
       FROM trips t
       LEFT JOIN lorries l ON l.id = t.lorry_id
       LEFT JOIN users u ON u.id = t.driver_user_id
       LEFT JOIN users h1 ON h1.id = t.helper_1_id
       LEFT JOIN users h2 ON h2.id = t.helper_2_id
     ${whereSql}
     ${orderBy}
     LIMIT ? OFFSET ?`
  )
    .bind(...binds, perPage, offset)
    .all();

  return {
    data: rows.results ?? [],
    page,
    per_page: perPage,
    total: total?.count ?? 0,
  };
}

// ── Trip detail (with stops + recent locations) ────────────────────

export async function getTrip(env: Env, id: number) {
  const trip = await env.DB.prepare(
    `SELECT t.*, l.plate as lorry_plate, l.size as lorry_size,
            u.name as driver_name, u.email as driver_email,
            h1.name as helper_1_name, h2.name as helper_2_name,
            w.name as warehouse_name, w.lat as warehouse_lat, w.lng as warehouse_lng
       FROM trips t
       LEFT JOIN lorries l ON l.id = t.lorry_id
       LEFT JOIN users u ON u.id = t.driver_user_id
       LEFT JOIN users h1 ON h1.id = t.helper_1_id
       LEFT JOIN users h2 ON h2.id = t.helper_2_id
       LEFT JOIN warehouses w ON w.code = t.warehouse
      WHERE t.id = ?`
  )
    .bind(id)
    .first<any>();
  if (!trip) return null;

  const stops = await env.DB.prepare(
    `SELECT s.*,
            so.debtor_name, so.phone, so.local_total, so.balance,
            so.inv_addr1, so.inv_addr2, so.inv_addr3, so.inv_addr4,
            od.lat as stop_lat, od.lng as stop_lng,
            od.warehouse as order_warehouse, od.state as order_state,
            dt.status as delivery_status, dt.est_delivery_date,
            dt.delivered_at as delivery_delivered_at
       FROM trip_stops s
       LEFT JOIN sales_orders so ON so.doc_no = s.doc_no
       LEFT JOIN order_details od ON od.doc_no = s.doc_no
       LEFT JOIN delivery_tracking dt ON dt.doc_no = s.doc_no
      WHERE s.trip_id = ?
      ORDER BY s.sequence ASC, s.id ASC`
  )
    .bind(id)
    .all();

  const locations = await env.DB.prepare(
    `SELECT lat, lng, accuracy, recorded_at
       FROM trip_locations
      WHERE trip_id = ?
      ORDER BY recorded_at DESC
      LIMIT 200`
  )
    .bind(id)
    .all();

  return { trip, stops: stops.results ?? [], locations: locations.results ?? [] };
}

// ── Create trip ────────────────────────────────────────────────────

export interface CreateTripInput {
  warehouse: string;
  trip_date: string;
  lorry_id?: number | null;
  driver_user_id?: number | null;
  trip_type?: string;
  is_outsourced?: boolean;
  notes?: string | null;
  stops: { doc_no: string; sequence?: number; stop_type?: string; dismantle_session?: string | null }[];
}

export async function createTrip(env: Env, input: CreateTripInput, createdBy: number) {
  const tripNo = await nextTripNo(env);
  const tripType = input.trip_type ?? "delivery";

  // Compute revenue from sales_orders.local_total
  let totalRevenue = 0;
  if (input.stops.length) {
    const placeholders = input.stops.map(() => "?").join(",");
    const sumRow = await env.DB.prepare(
      `SELECT COALESCE(SUM(local_total), 0) as total
         FROM sales_orders WHERE doc_no IN (${placeholders})`
    )
      .bind(...input.stops.map((s) => s.doc_no))
      .first<{ total: number }>();
    totalRevenue = sumRow?.total ?? 0;
  }

  const tripResult = await env.DB.prepare(
    `INSERT INTO trips
       (trip_no, warehouse, trip_date, lorry_id, driver_user_id, trip_type,
        is_outsourced, source, notes, total_revenue, stop_count, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?)`
  )
    .bind(
      tripNo,
      input.warehouse,
      input.trip_date,
      input.lorry_id ?? null,
      input.driver_user_id ?? null,
      tripType,
      input.is_outsourced ? 1 : 0,
      input.notes ?? null,
      totalRevenue,
      input.stops.length,
      createdBy
    )
    .run();

  const tripId = tripResult.meta.last_row_id as number;

  // Insert stops
  for (let i = 0; i < input.stops.length; i++) {
    const s = input.stops[i];
    await env.DB.prepare(
      `INSERT INTO trip_stops (trip_id, doc_no, sequence, stop_type, dismantle_session)
       VALUES (?, ?, ?, ?, ?)`
    )
      .bind(
        tripId,
        s.doc_no,
        s.sequence ?? i + 1,
        s.stop_type ?? "delivery",
        s.dismantle_session ?? null
      )
      .run();
  }

  // Auto-create delivery tracking records for each stop
  const { createRecordsForTrip } = await import("./delivery");
  await createRecordsForTrip(env, tripId, createdBy).catch(() => {});

  return tripId;
}

// ── Update trip ────────────────────────────────────────────────────

const TRIP_PATCH_FIELDS = [
  "lorry_id",
  "driver_user_id",
  "helper_1_id",
  "helper_2_id",
  "helper_outsourced",
  "trip_date",
  "warehouse",
  "trip_type",
  "is_outsourced",
  "status",
  "started_at",
  "completed_at",
  "start_odometer",
  "end_odometer",
  "clock_in_at",
  "clock_out_at",
  "fuel_litres",
  "fuel_cost",
  "notes",
] as const;

export async function patchTrip(env: Env, id: number, body: Record<string, any>) {
  const sets: string[] = [];
  const binds: any[] = [];
  for (const k of TRIP_PATCH_FIELDS) {
    if (k in body) {
      sets.push(`${k} = ?`);
      binds.push(body[k] ?? null);
    }
  }
  if (!sets.length) return false;
  sets.push("updated_at = datetime('now')");
  binds.push(id);
  const r = await env.DB.prepare(
    `UPDATE trips SET ${sets.join(", ")} WHERE id = ?`
  )
    .bind(...binds)
    .run();
  return r.meta.changes > 0;
}

// Convenience: status transition with auto-stamps.
// On completion, also computes and stores total_distance_km from the
// trip_locations ping log (haversine over consecutive points).
export async function transitionTrip(env: Env, id: number, status: string) {
  const stamps: Record<string, any> = { status };
  if (status === "started") stamps.started_at = new Date().toISOString();
  if (status === "completed" || status === "cancelled")
    stamps.completed_at = new Date().toISOString();
  if (status === "completed") {
    stamps.total_distance_km = await computeTripDistanceKm(env, id);
  }
  const ok = await patchTrip(env, id, stamps);

  if (ok && status === "started") {
    // Auto-advance WEST delivery records to out_for_delivery
    await autoAdvanceDeliveriesOnTripStart(env, id).catch(() => {});
  }

  if (ok && status === "completed") {
    // Auto-create salary trip lines for driver + helpers
    const { createTripSalaryLines } = await import("./fleet");
    await createTripSalaryLines(env, id).catch(() => {});
  }

  return ok;
}

async function autoAdvanceDeliveriesOnTripStart(env: Env, tripId: number) {
  const { advanceStatus } = await import("./delivery");
  const rows = await env.DB.prepare(
    `SELECT dt.doc_no FROM delivery_tracking dt
       JOIN trip_stops ts ON ts.doc_no = dt.doc_no
      WHERE ts.trip_id = ? AND dt.region = 'WEST' AND dt.status = 'do_ready'`
  )
    .bind(tripId)
    .all<{ doc_no: string }>();
  for (const r of rows.results ?? []) {
    await advanceStatus(env, r.doc_no, "out_for_delivery", 0).catch(() => {});
  }
}

/**
 * Sum haversine distance between consecutive GPS pings for a trip.
 * Pings outside reasonable bounds (>2km jump in <30s) are skipped as
 * outliers, since brief GPS jitter would otherwise inflate the total.
 */
export async function computeTripDistanceKm(env: Env, tripId: number): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT lat, lng, recorded_at FROM trip_locations
      WHERE trip_id = ? ORDER BY recorded_at ASC`
  )
    .bind(tripId)
    .all<{ lat: number; lng: number; recorded_at: string }>();

  const points = rows.results ?? [];
  if (points.length < 2) return 0;

  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const d = haversineKm(a.lat, a.lng, b.lat, b.lng);
    const dtSec =
      (Date.parse(b.recorded_at) - Date.parse(a.recorded_at)) / 1000;
    // Skip jumps that imply > ~240 km/h (likely GPS jitter / cold fix)
    if (dtSec > 0 && d / (dtSec / 3600) > 240) continue;
    total += d;
  }
  return Math.round(total * 100) / 100;
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ── Trip stops ─────────────────────────────────────────────────────

const STOP_PATCH_FIELDS = [
  "sequence",
  "stop_type",
  "dismantle_session",
  "status",
  "arrived_at",
  "completed_at",
  "recipient_name",
  "signature_r2_key",
  "pod_photo_r2_key",
  "failure_reason",
  "notes",
] as const;

export async function patchStop(
  env: Env,
  tripId: number,
  stopId: number,
  body: Record<string, any>
) {
  const sets: string[] = [];
  const binds: any[] = [];
  for (const k of STOP_PATCH_FIELDS) {
    if (k in body) {
      sets.push(`${k} = ?`);
      binds.push(body[k] ?? null);
    }
  }
  if (!sets.length) return false;
  sets.push("updated_at = datetime('now')");
  binds.push(stopId, tripId);
  const r = await env.DB.prepare(
    `UPDATE trip_stops SET ${sets.join(", ")} WHERE id = ? AND trip_id = ?`
  )
    .bind(...binds)
    .run();

  // First arrival auto-flips trip to in_progress.
  if (body.status === "arrived") {
    await env.DB.prepare(
      `UPDATE trips SET status = 'in_progress', updated_at = datetime('now')
        WHERE id = ? AND status IN ('assigned','started')`
    )
      .bind(tripId)
      .run();
  }

  // Auto-advance delivery tracking when stop is delivered or failed
  if (body.status === "delivered" || body.status === "failed") {
    const stop = await env.DB.prepare(
      `SELECT doc_no FROM trip_stops WHERE id = ? AND trip_id = ?`
    )
      .bind(stopId, tripId)
      .first<{ doc_no: string }>();
    if (stop) {
      const { advanceStatus } = await import("./delivery");
      const target = body.status === "delivered" ? "delivered" : "failed";
      await advanceStatus(env, stop.doc_no, target, 0, {
        notes: body.status === "failed" ? body.failure_reason : undefined,
      }).catch(() => {});
    }
  }

  return r.meta.changes > 0;
}

// ── GPS pings ──────────────────────────────────────────────────────

export interface LocationPing {
  lat: number;
  lng: number;
  accuracy?: number;
  recorded_at?: string;
}

export async function appendLocations(env: Env, tripId: number, pings: LocationPing[]) {
  if (!pings.length) return 0;
  const stmts = pings.map((p) =>
    env.DB.prepare(
      `INSERT INTO trip_locations (trip_id, lat, lng, accuracy, recorded_at)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(
      tripId,
      p.lat,
      p.lng,
      p.accuracy ?? null,
      p.recorded_at ?? new Date().toISOString()
    )
  );
  await env.DB.batch(stmts);
  return pings.length;
}

// ── R2 helpers for POD assets ──────────────────────────────────────
// We use direct Worker uploads (no presigned URLs) — keeps it simple
// and avoids needing R2 S3 credentials. The driver POSTs the binary
// to /api/trips/:id/stops/:stopId/pod and the worker stores it.

export function podKey(tripId: number, stopId: number, kind: "photo" | "signature", ext: string) {
  return `pod/${tripId}/${stopId}-${kind}-${Date.now()}.${ext}`;
}

export async function putPodObject(
  env: Env,
  key: string,
  body: ArrayBuffer | ReadableStream,
  contentType: string
) {
  await env.POD_BUCKET.put(key, body, {
    httpMetadata: { contentType },
  });
}

export async function getPodObject(env: Env, key: string) {
  return env.POD_BUCKET.get(key);
}

// ── Verify the caller is allowed to touch this trip (driver scope) ─

export async function tripBelongsToDriver(env: Env, tripId: number, userId: number) {
  const r = await env.DB.prepare(
    `SELECT 1 as ok FROM trips WHERE id = ? AND driver_user_id = ?`
  )
    .bind(tripId, userId)
    .first();
  return !!r;
}
