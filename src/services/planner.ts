import type { Env } from "../types";
import { DELIVERY_WHERE } from "./deliveryFilter";

/**
 * HC Delivery scheduling agent.
 *
 * Constructive heuristic + greedy nearest-neighbor bin-packing. Plan
 * priority order is ON-TIME > REVENUE > BALANCE > DISTANCE — i.e. the
 * algorithm will ship a low-revenue trip if a deadline demands it,
 * never a late one.
 *
 * Lifecycle:
 *   1. fetchEligibleOrders     — pull from sales_orders + order_details
 *   2. partition                — geocoded vs blocked, by warehouse
 *   3. plan per warehouse       — bin-pack day by day across the horizon
 *   4. assign lorries           — internal first, balance days, outsource overflow
 *   5. persist                  — write trip_proposals + trip_proposal_trips
 *
 * The function is pure-ish: it queries D1 for inputs but never mutates
 * anything except the proposal tables it owns. The caller (route handler)
 * is responsible for the proposal status lifecycle.
 */

// ── Tunables ───────────────────────────────────────────────────────

const REVENUE_IDEAL = 30_000;
const REVENUE_MAX = 45_000;
const REVENUE_MIN_NORMAL = 20_000;
const MAX_KM_NORMAL = 100;
const MAX_KM_LARGE = 120; // when stop count >= 8
const LARGE_STOP_THRESHOLD = 8;
const TOLERANCE_DAYS = 3;

// ── Inputs ─────────────────────────────────────────────────────────

interface EligibleOrder {
  doc_no: string;
  region: "WEST" | "EAST" | "SG"; // routing bucket from sales_orders.region
  warehouse: string | null;        // origin warehouse (always KL for now)
  state: string | null;
  lat: number | null;
  lng: number | null;
  local_total: number;
  expiry_date: string; // YYYY-MM-DD
  proposed_delivery_date: string | null;
  order_type: string | null; // delivery|service|pickup|setup|dismantle (nullable)
  debtor_name: string | null;
  // Computed window
  earliest: string; // YYYY-MM-DD
  latest: string; // expiry + tolerance, capped at horizon end
}

interface LorryRow {
  id: number;
  plate: string;
  size: string | null;
  warehouse: string;
  is_internal: number;
  default_driver_user_id: number | null;
}

// ── Output ─────────────────────────────────────────────────────────

interface ProposedStop {
  doc_no: string;
  sequence: number;
  debtor_name: string | null;
  lat: number;
  lng: number;
  local_total: number;
  expiry_date: string;
  reason?: string;
}

interface ProposedTrip {
  warehouse: string;
  trip_date: string;
  trip_type: "delivery" | "setup" | "dismantle" | "sg" | "blocked";
  suggested_lorry_id: number | null;
  suggested_driver_user_id: number | null;
  is_outsourced: boolean;
  total_revenue: number;
  total_distance_km: number;
  stop_count: number;
  stops: ProposedStop[];
  reason: string;
  blocked_reason?: string;
}

export interface PlannerSummary {
  horizon_days: number;
  generated_at: string;
  total_trips: number;
  total_revenue: number;
  total_orders: number;
  blocked_orders: number;
  by_warehouse: Record<string, { trips: number; revenue: number }>;
  outsourced_trips: number;
}

// ── Public entry ───────────────────────────────────────────────────

export async function generatePlan(
  env: Env,
  horizonDays: number,
  generatedBy: number
): Promise<{ proposalId: number; summary: PlannerSummary }> {
  const today = new Date();
  const horizonEnd = addDays(today, horizonDays - 1);

  const orders = await fetchEligibleOrders(env, today, horizonEnd);
  const lorriesByWarehouse = await fetchLorriesByWarehouse(env);
  const busy = await fetchLorryBusyMap(env, today, horizonEnd);

  // Single origin model: every internal lorry runs out of KL.
  const klLorries = lorriesByWarehouse["KL"] || [];

  // Partition by destination region. WEST orders need lat/lng for the
  // multi-drop algorithm; EAST and SG orders are bundled by revenue and
  // dropped at a single transit point, so they don't need geocoding.
  const blocked: EligibleOrder[] = [];
  const west: EligibleOrder[] = [];
  const east: EligibleOrder[] = [];
  const sg: EligibleOrder[] = [];
  for (const o of orders) {
    if (o.region === "WEST") {
      if (o.lat == null || o.lng == null) blocked.push(o);
      else west.push(o);
    } else if (o.region === "EAST") {
      east.push(o);
    } else if (o.region === "SG") {
      sg.push(o);
    }
  }

  const proposed: ProposedTrip[] = [];
  if (west.length) {
    proposed.push(...planWarehouse("KL", west, klLorries, busy, today, horizonEnd));
  }
  if (east.length) {
    proposed.push(...planEast(east, klLorries, busy));
  }
  if (sg.length) {
    proposed.push(...planSingapore(sg, klLorries, busy));
  }

  // Emit blocked-order proposals so the dispatcher can see what's stuck.
  if (blocked.length) {
    proposed.push({
      warehouse: "—",
      trip_date: dateOnly(today),
      trip_type: "blocked",
      suggested_lorry_id: null,
      suggested_driver_user_id: null,
      is_outsourced: false,
      total_revenue: blocked.reduce((s, o) => s + o.local_total, 0),
      total_distance_km: 0,
      stop_count: blocked.length,
      stops: blocked.map((o, i) => ({
        doc_no: o.doc_no,
        sequence: i + 1,
        debtor_name: o.debtor_name,
        lat: o.lat ?? 0,
        lng: o.lng ?? 0,
        local_total: o.local_total,
        expiry_date: o.expiry_date,
        reason: !o.warehouse
          ? "No warehouse mapped (geocode missing or unrecognized state)"
          : "No coordinates",
      })),
      reason: "Cannot be planned automatically",
      blocked_reason: "Missing warehouse or coordinates — geocode then re-run",
    });
  }

  // Persist
  const summary: PlannerSummary = {
    horizon_days: horizonDays,
    generated_at: new Date().toISOString(),
    total_trips: proposed.filter((t) => t.trip_type !== "blocked").length,
    total_revenue: proposed
      .filter((t) => t.trip_type !== "blocked")
      .reduce((s, t) => s + t.total_revenue, 0),
    total_orders: proposed.reduce((s, t) => s + t.stop_count, 0),
    blocked_orders: blocked.length,
    by_warehouse: aggregateByWarehouse(proposed),
    outsourced_trips: proposed.filter((t) => t.is_outsourced).length,
  };

  const proposalId = await persistProposal(env, generatedBy, horizonDays, summary, proposed);
  return { proposalId, summary };
}

// ── Per-warehouse planner ─────────────────────────────────────────

function planWarehouse(
  warehouse: string,
  orders: EligibleOrder[],
  lorries: LorryRow[],
  busy: BusyMap,
  startDate: Date,
  endDate: Date
): ProposedTrip[] {
  const trips: ProposedTrip[] = [];

  // Sort by tightest deadline (latest cap), then by earliest (earliest first)
  orders.sort((a, b) => a.latest.localeCompare(b.latest));

  // Setup orders → solo trips, scheduled on the earliest day available.
  const setups = orders.filter((o) => o.order_type === "setup");
  const others = orders.filter((o) => o.order_type !== "setup");

  for (const setup of setups) {
    const day = pickEarliestUnreservedDay(setup.earliest, setup.latest, lorries, busy, warehouse);
    const lorry = pickLorry(lorries, busy, day);
    trips.push(makeSoloTrip(warehouse, day, setup, lorry, "setup"));
    if (lorry) markBusy(busy, day, lorry.id);
  }

  // Day-by-day greedy bin-pack for normal deliveries
  const scheduled = new Set<string>();
  for (let d = new Date(startDate); d <= endDate; d = addDays(d, 1)) {
    const dayStr = dateOnly(d);

    // Stop early if no day-eligible orders remain
    let safety = 20; // hard cap on trips per warehouse per day
    while (safety-- > 0) {
      const eligible = others
        .filter((o) => !scheduled.has(o.doc_no) && o.earliest <= dayStr && dayStr <= o.latest)
        .sort((a, b) => a.latest.localeCompare(b.latest));
      if (!eligible.length) break;

      const seed = eligible[0];
      const stops: EligibleOrder[] = [seed];
      let revenue = seed.local_total;
      let routeKm = haversineSeed(warehouse, seed); // warehouse → seed → warehouse

      // Greedy nearest-neighbor expansion
      while (true) {
        const last = stops[stops.length - 1];
        const candidates = others.filter(
          (o) =>
            !scheduled.has(o.doc_no) &&
            !stops.includes(o) &&
            o.earliest <= dayStr &&
            dayStr <= o.latest
        );
        if (!candidates.length) break;

        let best: EligibleOrder | null = null;
        let bestDist = Infinity;
        for (const c of candidates) {
          const d2 = haversineKm(last.lat!, last.lng!, c.lat!, c.lng!);
          if (d2 < bestDist) {
            best = c;
            bestDist = d2;
          }
        }
        if (!best) break;

        const projectedStops = [...stops, best];
        const projectedKm = routeWithReturn(warehouse, projectedStops);
        const projectedRev = revenue + best.local_total;
        const cap = projectedStops.length >= LARGE_STOP_THRESHOLD ? MAX_KM_LARGE : MAX_KM_NORMAL;

        if (projectedRev > REVENUE_MAX) break;
        if (projectedKm > cap) break;

        stops.push(best);
        revenue = projectedRev;
        routeKm = projectedKm;

        if (revenue >= REVENUE_IDEAL) break; // good enough
      }

      // Validate revenue floor
      const hasUrgent = stops.some((s) => s.latest === dayStr);
      if (revenue < REVENUE_MIN_NORMAL && !hasUrgent) {
        // Skip this trip — defer to a future day so we can bundle more.
        // We don't mark stops scheduled, so the next day's iteration sees them.
        break;
      }

      // Lock it in
      for (const s of stops) scheduled.add(s.doc_no);
      const lorry = pickLorry(lorries, busy, dayStr);
      const isOut = lorry ? !lorry.is_internal : true;
      if (lorry) markBusy(busy, dayStr, lorry.id);

      trips.push({
        warehouse,
        trip_date: dayStr,
        trip_type: "delivery",
        suggested_lorry_id: lorry?.id ?? null,
        suggested_driver_user_id: lorry?.default_driver_user_id ?? null,
        is_outsourced: isOut,
        total_revenue: round2(revenue),
        total_distance_km: round2(routeKm),
        stop_count: stops.length,
        stops: stops.map((s, i) => ({
          doc_no: s.doc_no,
          sequence: i + 1,
          debtor_name: s.debtor_name,
          lat: s.lat as number,
          lng: s.lng as number,
          local_total: s.local_total,
          expiry_date: s.expiry_date,
          reason:
            i === 0
              ? `Seed (deadline ${s.latest})`
              : `Nearest of pending (deadline ${s.latest})`,
        })),
        reason: buildReason(revenue, routeKm, stops.length, hasUrgent),
      });
    }
  }

  // Anything still unscheduled at end of horizon → emit as a "deferred"
  // proposal so the dispatcher knows about it. Treat as low-rev solo
  // trip on the deadline day.
  const leftover = others.filter((o) => !scheduled.has(o.doc_no));
  for (const o of leftover) {
    const day = clampDate(o.latest, dateOnly(startDate), dateOnly(endDate));
    const lorry = pickLorry(lorries, busy, day);
    const isOut = lorry ? !lorry.is_internal : true;
    if (lorry) markBusy(busy, day, lorry.id);
    trips.push({
      warehouse,
      trip_date: day,
      trip_type: "delivery",
      suggested_lorry_id: lorry?.id ?? null,
      suggested_driver_user_id: lorry?.default_driver_user_id ?? null,
      is_outsourced: isOut,
      total_revenue: round2(o.local_total),
      total_distance_km: round2(haversineSeed(warehouse, o)),
      stop_count: 1,
      stops: [
        {
          doc_no: o.doc_no,
          sequence: 1,
          debtor_name: o.debtor_name,
          lat: o.lat as number,
          lng: o.lng as number,
          local_total: o.local_total,
          expiry_date: o.expiry_date,
          reason: "Could not bundle within horizon — solo trip",
        },
      ],
      reason: "Standalone delivery (no efficient bundle found)",
    });
  }

  return trips;
}

// ── East Malaysia planner (capacity-only, drops at Port Klang) ────
//
// East Malaysia orders ship from KL to Port Klang by lorry, then go
// onward by sea freight. The dispatcher only cares about (a) bundling
// orders into trips that are revenue-efficient, and (b) which day
// each bundle leaves. Customer addresses are irrelevant — coordinates
// aren't required.
function planEast(
  orders: EligibleOrder[],
  lorries: LorryRow[],
  busy: BusyMap
): ProposedTrip[] {
  const trips: ProposedTrip[] = [];
  orders.sort((a, b) => a.latest.localeCompare(b.latest));

  let bin: EligibleOrder[] = [];
  let binRev = 0;
  for (const o of orders) {
    if (binRev + o.local_total > REVENUE_MAX && bin.length) {
      trips.push(makeEastTrip(bin, lorries, busy));
      bin = [];
      binRev = 0;
    }
    bin.push(o);
    binRev += o.local_total;
    if (binRev >= REVENUE_IDEAL) {
      trips.push(makeEastTrip(bin, lorries, busy));
      bin = [];
      binRev = 0;
    }
  }
  if (bin.length) trips.push(makeEastTrip(bin, lorries, busy));
  return trips;
}

function makeEastTrip(stops: EligibleOrder[], lorries: LorryRow[], busy: BusyMap): ProposedTrip {
  const day = stops.reduce((min, o) => (o.latest < min ? o.latest : min), stops[0].latest);
  const lorry = pickLorry(lorries, busy, day);
  if (lorry) markBusy(busy, day, lorry.id);
  return {
    warehouse: "KL",
    trip_date: day,
    trip_type: "delivery", // an EAST trip is still a real delivery trip type-wise
    suggested_lorry_id: lorry?.id ?? null,
    suggested_driver_user_id: lorry?.default_driver_user_id ?? null,
    is_outsourced: lorry ? !lorry.is_internal : true,
    total_revenue: round2(stops.reduce((s, o) => s + o.local_total, 0)),
    total_distance_km: 0,
    stop_count: stops.length,
    stops: stops.map((s, i) => ({
      doc_no: s.doc_no,
      sequence: i + 1,
      debtor_name: s.debtor_name,
      lat: s.lat ?? 3.0042, // fallback to Port Klang for the map
      lng: s.lng ?? 101.3933,
      local_total: s.local_total,
      expiry_date: s.expiry_date,
    })),
    reason: "EAST drop at Port Klang — sea freight handles last mile",
  };
}

// ── Singapore planner (capacity-only) ─────────────────────────────

function planSingapore(
  orders: EligibleOrder[],
  lorries: LorryRow[],
  busy: BusyMap
): ProposedTrip[] {
  const trips: ProposedTrip[] = [];
  // Sort by deadline so urgent orders ship in the earliest bin
  orders.sort((a, b) => a.latest.localeCompare(b.latest));

  let bin: EligibleOrder[] = [];
  let binRev = 0;
  for (const o of orders) {
    if (binRev + o.local_total > REVENUE_MAX && bin.length) {
      trips.push(makeSgTrip(bin, lorries, busy));
      bin = [];
      binRev = 0;
    }
    bin.push(o);
    binRev += o.local_total;
    if (binRev >= REVENUE_IDEAL) {
      trips.push(makeSgTrip(bin, lorries, busy));
      bin = [];
      binRev = 0;
    }
  }
  if (bin.length) trips.push(makeSgTrip(bin, lorries, busy));
  return trips;
}

function makeSgTrip(stops: EligibleOrder[], lorries: LorryRow[], busy: BusyMap): ProposedTrip {
  // Ship on the tightest deadline in the bin
  const day = stops.reduce((min, o) => (o.latest < min ? o.latest : min), stops[0].latest);
  const lorry = pickLorry(lorries, busy, day);
  if (lorry) markBusy(busy, day, lorry.id);
  return {
    warehouse: "SG",
    trip_date: day,
    trip_type: "sg",
    suggested_lorry_id: lorry?.id ?? null,
    suggested_driver_user_id: lorry?.default_driver_user_id ?? null,
    is_outsourced: lorry ? !lorry.is_internal : true,
    total_revenue: round2(stops.reduce((s, o) => s + o.local_total, 0)),
    total_distance_km: 0,
    stop_count: stops.length,
    stops: stops.map((s, i) => ({
      doc_no: s.doc_no,
      sequence: i + 1,
      debtor_name: s.debtor_name,
      lat: s.lat as number,
      lng: s.lng as number,
      local_total: s.local_total,
      expiry_date: s.expiry_date,
    })),
    reason: "SG drop at JB hub — capacity bin",
  };
}

// ── Lorry assignment helpers ──────────────────────────────────────

type BusyMap = Record<string, Set<number>>; // date → set of lorry_ids

function pickLorry(lorries: LorryRow[], busy: BusyMap, day: string): LorryRow | null {
  // Internal first, then outsource
  const sorted = [...lorries].sort((a, b) => Number(b.is_internal) - Number(a.is_internal));
  for (const l of sorted) {
    if (!busy[day]?.has(l.id)) return l;
  }
  return null;
}

function pickEarliestUnreservedDay(
  earliest: string,
  latest: string,
  lorries: LorryRow[],
  busy: BusyMap,
  _warehouse: string
): string {
  let d = earliest;
  while (d <= latest) {
    const lorry = pickLorry(lorries, busy, d);
    if (lorry) return d;
    d = dateOnly(addDays(new Date(d), 1));
  }
  return earliest;
}

function markBusy(busy: BusyMap, day: string, lorryId: number) {
  (busy[day] ||= new Set()).add(lorryId);
}

function makeSoloTrip(
  warehouse: string,
  day: string,
  o: EligibleOrder,
  lorry: LorryRow | null,
  type: "setup" | "delivery"
): ProposedTrip {
  return {
    warehouse,
    trip_date: day,
    trip_type: type,
    suggested_lorry_id: lorry?.id ?? null,
    suggested_driver_user_id: lorry?.default_driver_user_id ?? null,
    is_outsourced: lorry ? !lorry.is_internal : true,
    total_revenue: round2(o.local_total),
    total_distance_km: round2(haversineSeed(warehouse, o)),
    stop_count: 1,
    stops: [
      {
        doc_no: o.doc_no,
        sequence: 1,
        debtor_name: o.debtor_name,
        lat: o.lat as number,
        lng: o.lng as number,
        local_total: o.local_total,
        expiry_date: o.expiry_date,
        reason: type === "setup" ? "Setup → solo trip (rule)" : undefined,
      },
    ],
    reason: type === "setup" ? "Setup order — full trip required" : "Standalone delivery",
  };
}

// ── DB I/O ─────────────────────────────────────────────────────────

async function fetchEligibleOrders(env: Env, today: Date, end: Date): Promise<EligibleOrder[]> {
  const todayStr = dateOnly(today);
  const endStr = dateOnly(end);

  // Exclude orders already on a confirmed trip in the horizon
  const rows = await env.DB.prepare(
    `SELECT
        so.doc_no, so.region, so.local_total, so.expiry_date, so.debtor_name,
        od.warehouse, od.state, od.lat, od.lng,
        od.proposed_delivery_date, od.order_type
      FROM sales_orders so
      LEFT JOIN order_details od ON od.doc_no = so.doc_no
      WHERE (${DELIVERY_WHERE})
        AND NOT EXISTS (
          SELECT 1 FROM trip_stops ts
            JOIN trips t ON t.id = ts.trip_id
           WHERE ts.doc_no = so.doc_no
             AND t.status IN ('assigned','started','in_progress','completed')
             AND t.trip_date BETWEEN ? AND ?
        )`
  )
    .bind(todayStr, endStr)
    .all<any>();

  const out: EligibleOrder[] = [];
  for (const r of rows.results ?? []) {
    if (!r.expiry_date) continue;
    if (r.region !== "WEST" && r.region !== "EAST" && r.region !== "SG") continue;
    const earliest = todayStr;
    const latestRaw = dateOnly(addDays(new Date(r.expiry_date), TOLERANCE_DAYS));
    const latest = latestRaw < endStr ? latestRaw : endStr;
    if (latest < earliest) continue; // already past tolerance — let dispatcher see via blocked? skip for now
    out.push({
      doc_no: r.doc_no,
      region: r.region as "WEST" | "EAST" | "SG",
      warehouse: r.warehouse,
      state: r.state,
      lat: r.lat,
      lng: r.lng,
      local_total: r.local_total ?? 0,
      expiry_date: r.expiry_date,
      proposed_delivery_date: r.proposed_delivery_date,
      order_type: r.order_type,
      debtor_name: r.debtor_name,
      earliest,
      latest,
    });
  }
  return out;
}

async function fetchLorriesByWarehouse(env: Env): Promise<Record<string, LorryRow[]>> {
  const rows = await env.DB.prepare(
    `SELECT id, plate, size, warehouse, is_internal, default_driver_user_id
       FROM lorries WHERE is_active = 1`
  ).all<LorryRow>();
  const map: Record<string, LorryRow[]> = {};
  for (const l of rows.results ?? []) {
    (map[l.warehouse] ||= []).push(l);
  }
  return map;
}

async function fetchLorryBusyMap(env: Env, today: Date, end: Date): Promise<BusyMap> {
  const rows = await env.DB.prepare(
    `SELECT trip_date, lorry_id FROM trips
      WHERE lorry_id IS NOT NULL
        AND status IN ('assigned','started','in_progress','completed')
        AND trip_date BETWEEN ? AND ?`
  )
    .bind(dateOnly(today), dateOnly(end))
    .all<{ trip_date: string; lorry_id: number }>();
  const map: BusyMap = {};
  for (const r of rows.results ?? []) {
    (map[r.trip_date] ||= new Set()).add(r.lorry_id);
  }
  return map;
}

async function persistProposal(
  env: Env,
  generatedBy: number,
  horizonDays: number,
  summary: PlannerSummary,
  trips: ProposedTrip[]
): Promise<number> {
  const ins = await env.DB.prepare(
    `INSERT INTO trip_proposals (generated_at, generated_by, horizon_days, status, summary_json)
     VALUES (?, ?, ?, 'draft', ?)`
  )
    .bind(new Date().toISOString(), generatedBy, horizonDays, JSON.stringify(summary))
    .run();
  const proposalId = ins.meta.last_row_id as number;

  for (const t of trips) {
    await env.DB.prepare(
      `INSERT INTO trip_proposal_trips
         (proposal_id, warehouse, trip_date, suggested_lorry_id, suggested_driver_user_id,
          trip_type, total_revenue, total_distance_km, stop_count, is_outsourced, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        proposalId,
        t.warehouse,
        t.trip_date,
        t.suggested_lorry_id,
        t.suggested_driver_user_id,
        t.trip_type,
        t.total_revenue,
        t.total_distance_km,
        t.stop_count,
        t.is_outsourced ? 1 : 0,
        JSON.stringify({
          stops: t.stops,
          reason: t.reason,
          blocked_reason: t.blocked_reason,
        })
      )
      .run();
  }

  return proposalId;
}

// ── Confirmation: materialize proposal into real trips ────────────

import { nextTripNo } from "./trips";

export async function confirmProposal(env: Env, proposalId: number, userId: number) {
  const proposal = await env.DB.prepare(
    `SELECT * FROM trip_proposals WHERE id = ?`
  )
    .bind(proposalId)
    .first<any>();
  if (!proposal) throw new Error("Proposal not found");
  if (proposal.status !== "draft") throw new Error("Proposal already " + proposal.status);

  const proposalTrips = await env.DB.prepare(
    `SELECT * FROM trip_proposal_trips WHERE proposal_id = ? ORDER BY trip_date, id`
  )
    .bind(proposalId)
    .all<any>();

  let createdCount = 0;
  for (const pt of proposalTrips.results ?? []) {
    if (pt.trip_type === "blocked") continue;

    const tripNo = await nextTripNo(env);
    const ins = await env.DB.prepare(
      `INSERT INTO trips
         (trip_no, warehouse, trip_date, lorry_id, driver_user_id, trip_type,
          is_outsourced, source, proposal_id, total_revenue, total_distance_km, stop_count, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'proposal', ?, ?, ?, ?, ?)`
    )
      .bind(
        tripNo,
        pt.warehouse,
        pt.trip_date,
        pt.suggested_lorry_id,
        pt.suggested_driver_user_id,
        pt.trip_type,
        pt.is_outsourced,
        proposalId,
        pt.total_revenue,
        pt.total_distance_km,
        pt.stop_count,
        userId
      )
      .run();
    const newTripId = ins.meta.last_row_id as number;

    const payload = JSON.parse(pt.payload_json);
    for (const s of payload.stops as ProposedStop[]) {
      await env.DB.prepare(
        `INSERT INTO trip_stops (trip_id, doc_no, sequence, stop_type)
         VALUES (?, ?, ?, ?)`
      )
        .bind(
          newTripId,
          s.doc_no,
          s.sequence,
          pt.trip_type === "setup" ? "setup" : "delivery"
        )
        .run();
    }
    createdCount++;
  }

  await env.DB.prepare(
    `UPDATE trip_proposals SET status = 'confirmed' WHERE id = ?`
  )
    .bind(proposalId)
    .run();

  return { created: createdCount };
}

// ── Helpers ────────────────────────────────────────────────────────

function dateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, n: number): Date {
  const c = new Date(d);
  c.setUTCDate(c.getUTCDate() + n);
  return c;
}

function clampDate(d: string, lo: string, hi: string): string {
  if (d < lo) return lo;
  if (d > hi) return hi;
  return d;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
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

// We don't have warehouse coords in the algorithm scope; estimate
// the seed leg as 2× the order's distance from a heuristic centroid.
// Underestimates slightly, but the planner just needs a relative
// signal — the dispatcher gets the real route from Directions on view.
function haversineSeed(_warehouse: string, o: EligibleOrder): number {
  if (o.lat == null || o.lng == null) return 0;
  return 30; // assume ~15km each way as a baseline
}

function routeWithReturn(_warehouse: string, stops: EligibleOrder[]): number {
  if (stops.length === 0) return 0;
  let total = 30; // warehouse round trip baseline
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1];
    const b = stops[i];
    if (a.lat == null || b.lat == null) continue;
    total += haversineKm(a.lat!, a.lng!, b.lat!, b.lng!);
  }
  return total;
}

function buildReason(rev: number, km: number, n: number, urgent: boolean): string {
  const parts: string[] = [];
  parts.push(`${n} stop${n === 1 ? "" : "s"}`);
  parts.push(`RM ${Math.round(rev).toLocaleString()}`);
  parts.push(`~${km.toFixed(0)}km`);
  if (urgent) parts.push("deadline today");
  if (rev >= REVENUE_IDEAL) parts.push("revenue ideal");
  else if (rev < REVENUE_MIN_NORMAL) parts.push("low rev (deadline override)");
  return parts.join(" · ");
}

function aggregateByWarehouse(trips: ProposedTrip[]) {
  const out: Record<string, { trips: number; revenue: number }> = {};
  for (const t of trips) {
    if (t.trip_type === "blocked") continue;
    const k = t.warehouse;
    out[k] ||= { trips: 0, revenue: 0 };
    out[k].trips++;
    out[k].revenue += t.total_revenue;
  }
  return out;
}
