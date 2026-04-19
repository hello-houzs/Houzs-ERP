import type { Env } from "../types";
import { DELIVERY_WHERE } from "./deliveryFilter";
import { directions } from "./maps";

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

const REVENUE_IDEAL = 30_000;      // min target before trip is worth sending (MYR)
const REVENUE_MIN_NORMAL = 20_000; // floor — skip trip unless deadline urgent
const MAX_KM = 120;                // inter-stop distance cap
const MAX_STOPS = 8;               // lorry capacity (6-8 orders per trip)
const TOLERANCE_DAYS = 3;          // days past expiry still eligible

// ── Inputs ─────────────────────────────────────────────────────────

interface EligibleOrder {
  doc_no: string;
  region: "WEST" | "EAST" | "SG"; // routing bucket from sales_orders.region
  sales_location: string | null;   // KL, PG, SBH, SRW — direct from AutoCount
  warehouse: string | null;        // origin warehouse (from sales_location)
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
  total_distance_km: number;       // inter-stop only (what the cap checks)
  full_route_km: number;           // warehouse → stops → warehouse (informational)
  stop_count: number;
  stops: ProposedStop[];
  reason: string;
  blocked_reason?: string;
  route_chain?: { label: string; lat: number; lng: number; type: string }[];
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
  const warehouseCoords = await fetchWarehouseCoords(env);

  const klLorries = lorriesByWarehouse["KL"] || [];
  const pgLorries = lorriesByWarehouse["PG"] || [];
  const sbhLorries = lorriesByWarehouse["SBH"] || [];
  const srwLorries = lorriesByWarehouse["SRW"] || [];
  const klCoords = warehouseCoords["KL"] || { lat: 3.0264, lng: 101.7340 };
  const pgCoords = warehouseCoords["PG"] || { lat: 5.3007, lng: 100.4273 };
  const sbhCoords = warehouseCoords["SBH"] || { lat: 5.8784, lng: 116.0103 };
  const srwCoords = warehouseCoords["SRW"] || { lat: 1.5806, lng: 110.3762 };

  // Partition orders by region and warehouse.
  //
  // WEST: direct delivery from KL or PG warehouse → customer
  // EAST: two legs —
  //   1. Transfer: KL → Port Klang (sea freight) → SBH/SRW
  //   2. Local delivery: SBH/SRW → customer (same as WEST)
  //   Orders at_warehouse (delivery_tracking) go to local delivery.
  //   Orders not yet at warehouse go to transfer trip.
  // SG: KL → JB hub → outsource vendor
  const blocked: EligibleOrder[] = [];
  const westKL: EligibleOrder[] = [];
  const westPG: EligibleOrder[] = [];
  const eastTransfer: EligibleOrder[] = [];  // needs KL → Port Klang trip
  const eastSBH: EligibleOrder[] = [];       // at SBH warehouse, ready for local delivery
  const eastSRW: EligibleOrder[] = [];       // at SRW warehouse, ready for local delivery
  const sg: EligibleOrder[] = [];

  // Check which EM orders have arrived at warehouse
  const atWarehouseSet = await fetchEMAtWarehouse(env);

  for (const o of orders) {
    if (o.region === "WEST") {
      if (o.lat == null || o.lng == null) {
        blocked.push(o);
      } else if (o.warehouse === "PG") {
        westPG.push(o);
      } else {
        westKL.push(o);
      }
    } else if (o.region === "EAST") {
      if (atWarehouseSet.has(o.doc_no)) {
        // Goods arrived at EM warehouse — plan local delivery
        if (o.lat == null || o.lng == null) {
          blocked.push(o);
        } else if (o.sales_location === "SRW") {
          eastSRW.push(o);
        } else {
          eastSBH.push(o);
        }
      } else {
        // Not yet at warehouse — needs transfer trip
        eastTransfer.push(o);
      }
    } else if (o.region === "SG") {
      sg.push(o);
    }
  }

  const proposed: ProposedTrip[] = [];

  // WEST deliveries
  if (westKL.length) {
    proposed.push(...await planWarehouse(env, "KL", klCoords, westKL, klLorries, busy, today, horizonEnd));
  }
  if (westPG.length) {
    proposed.push(...await planWarehouse(env, "PG", pgCoords, westPG, pgLorries, busy, today, horizonEnd));
  }

  // EM transfer trips (KL → Port Klang)
  if (eastTransfer.length) {
    proposed.push(...await planEast(env, eastTransfer, klLorries, busy));
  }

  // EM local delivery trips (SBH/SRW → customer, same model as WEST)
  if (eastSBH.length) {
    proposed.push(...await planWarehouse(env, "SBH", sbhCoords, eastSBH, sbhLorries, busy, today, horizonEnd));
  }
  if (eastSRW.length) {
    proposed.push(...await planWarehouse(env, "SRW", srwCoords, eastSRW, srwLorries, busy, today, horizonEnd));
  }

  // SG trips
  if (sg.length) {
    proposed.push(...await planSingapore(env, sg, klLorries, busy));
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
      full_route_km: 0,
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

async function planWarehouse(
  env: Env,
  warehouse: string,
  whCoords: { lat: number; lng: number },
  orders: EligibleOrder[],
  lorries: LorryRow[],
  busy: BusyMap,
  startDate: Date,
  endDate: Date
): Promise<ProposedTrip[]> {
  const trips: ProposedTrip[] = [];
  const { lat: whLat, lng: whLng } = whCoords;

  // Sort by tightest deadline, then prefer orders nearer to warehouse
  // (so the seed is close to the warehouse for better round-trip).
  orders.sort((a, b) => {
    const dl = a.latest.localeCompare(b.latest);
    if (dl !== 0) return dl;
    return distToWarehouse(whLat, whLng, a) - distToWarehouse(whLat, whLng, b);
  });

  // Setup orders → solo trips, scheduled on the earliest day available.
  const setups = orders.filter((o) => o.order_type === "setup");
  const others = orders.filter((o) => o.order_type !== "setup");

  for (const setup of setups) {
    const day = pickEarliestUnreservedDay(setup.earliest, setup.latest, lorries, busy, warehouse);
    const lorry = pickLorry(lorries, busy, day);
    trips.push(await makeSoloTrip(env, warehouse, whCoords, day, setup, lorry, "setup"));
    if (lorry) markBusy(busy, day, lorry.id);
  }

  // Day-by-day greedy bin-pack for normal deliveries.
  // Distance cap counts only stop-to-stop legs (warehouse legs excluded).
  // Cap: <8 stops → 100km, ≥8 stops → 120km.
  const scheduled = new Set<string>();
  for (let d = new Date(startDate); d <= endDate; d = addDays(d, 1)) {
    const dayStr = dateOnly(d);

    let safety = 20; // hard cap on trips per warehouse per day
    while (safety-- > 0) {
      const eligible = others
        .filter((o) => !scheduled.has(o.doc_no) && o.earliest <= dayStr && dayStr <= o.latest)
        .sort((a, b) => {
          const dl = a.latest.localeCompare(b.latest);
          if (dl !== 0) return dl;
          return distToWarehouse(whLat, whLng, a) - distToWarehouse(whLat, whLng, b);
        });
      if (!eligible.length) break;

      // Seed with the most-urgent, nearest-to-warehouse order.
      const seed = eligible[0];
      const stops: EligibleOrder[] = [seed];
      let revenue = seed.local_total;
      let stopToStopKm = 0; // only inter-stop distance (for cap)

      // Greedy nearest-neighbor expansion — maximize lorry usage.
      // Keep adding orders until we hit the stop cap (8) or distance cap (120km).
      while (stops.length < MAX_STOPS) {
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

        const projectedKm = interStopDistance([...stops, best]);
        if (projectedKm > MAX_KM) break;

        stops.push(best);
        revenue += best.local_total;
        stopToStopKm = projectedKm;
      }

      // Optimize: if possible, swap the last stop so the one nearest
      // to the warehouse is last (better return leg). Only swap if it
      // doesn't violate the distance cap.
      if (stops.length >= 3) {
        let nearestIdx = 0;
        let nearestDist = Infinity;
        for (let i = 0; i < stops.length; i++) {
          const d2 = distToWarehouse(whLat, whLng, stops[i]);
          if (d2 < nearestDist) {
            nearestDist = d2;
            nearestIdx = i;
          }
        }
        if (nearestIdx !== stops.length - 1 && nearestIdx !== 0) {
          const candidate = [...stops];
          const [moved] = candidate.splice(nearestIdx, 1);
          candidate.push(moved);
          const newKm = interStopDistance(candidate);
          if (newKm <= MAX_KM) {
            stops.length = 0;
            stops.push(...candidate);
            stopToStopKm = newKm;
          }
        }
      }

      // Validate revenue floor
      const hasUrgent = stops.some((s) => s.latest === dayStr);
      if (revenue < REVENUE_MIN_NORMAL && !hasUrgent) {
        break;
      }

      // Lock it in
      for (const s of stops) scheduled.add(s.doc_no);
      const lorry = pickLorry(lorries, busy, dayStr);
      const isOut = lorry ? !lorry.is_internal : true;
      if (lorry) markBusy(busy, dayStr, lorry.id);

      // Get real road distance from Google Directions API with route optimization
      let fullKm = fullRouteDistance(whLat, whLng, stops); // haversine fallback
      let roadStopToStopKm = stopToStopKm;
      const geoStops = stops.filter((s) => s.lat != null && s.lng != null);
      if (geoStops.length > 0) {
        try {
          const waypoints = geoStops.map((s) => ({ lat: s.lat!, lng: s.lng! }));
          const res = await directions(env, {
            origin: { lat: whLat, lng: whLng },
            destination: { lat: whLat, lng: whLng },
            waypoints,
            optimize: true,
          });
          fullKm = res.total_distance_m / 1000;
          // Inter-stop = exclude first leg (warehouse→stop1) and last leg (stopN→warehouse)
          if (res.legs.length > 2) {
            roadStopToStopKm = res.legs.slice(1, -1).reduce((s, l) => s + l.distance_m, 0) / 1000;
          }
          // Reorder stops to match Google's optimized sequence
          if (res.waypoint_order?.length === geoStops.length) {
            const reordered = res.waypoint_order.map((idx) => stops[idx]);
            stops.length = 0;
            stops.push(...reordered);
          }
        } catch { /* keep haversine fallback */ }
      }

      trips.push({
        warehouse,
        trip_date: dayStr,
        trip_type: "delivery",
        suggested_lorry_id: lorry?.id ?? null,
        suggested_driver_user_id: lorry?.default_driver_user_id ?? null,
        is_outsourced: isOut,
        total_revenue: round2(revenue),
        total_distance_km: round2(roadStopToStopKm),
        full_route_km: round2(fullKm),
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
              ? `Seed (deadline ${s.latest}, nearest to warehouse)`
              : `Nearest of pending (deadline ${s.latest})`,
        })),
        reason: buildReason(revenue, roadStopToStopKm, stops.length, hasUrgent),
      });
    }
  }

  // Anything still unscheduled at end of horizon → deferred solo trip.
  const leftover = others.filter((o) => !scheduled.has(o.doc_no));
  for (const o of leftover) {
    const day = clampDate(o.latest, dateOnly(startDate), dateOnly(endDate));
    const lorry = pickLorry(lorries, busy, day);
    const isOut = lorry ? !lorry.is_internal : true;
    if (lorry) markBusy(busy, day, lorry.id);
    trips.push(await makeSoloTrip(env, warehouse, whCoords, day, o, lorry, "delivery"));
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
async function planEast(
  env: Env,
  orders: EligibleOrder[],
  lorries: LorryRow[],
  busy: BusyMap
): Promise<ProposedTrip[]> {
  const trips: ProposedTrip[] = [];
  orders.sort((a, b) => a.latest.localeCompare(b.latest));

  // No distance constraint (single drop at Port Klang). Split at MAX_STOPS.
  let bin: EligibleOrder[] = [];
  for (const o of orders) {
    bin.push(o);
    if (bin.length >= MAX_STOPS) {
      trips.push(await makeEastTrip(env, bin, lorries, busy));
      bin = [];
    }
  }
  if (bin.length) trips.push(await makeEastTrip(env, bin, lorries, busy));
  return trips;
}

// Port Klang coordinates — the physical drop point for EM orders
const PORT_KLANG = { lat: 3.0042, lng: 101.3933 };
const KL_WAREHOUSE = { lat: 3.0264, lng: 101.7340 };
const SBH_WAREHOUSE = { lat: 5.8784, lng: 116.0103 };
const SRW_WAREHOUSE = { lat: 1.5806, lng: 110.3762 };
// EM receiving ports — sea freight arrives here, then lorry to warehouse
const SBH_PORT = { lat: 6.0467, lng: 116.0544 }; // Sepanggar Bay, Kota Kinabalu
const SRW_PORT = { lat: 1.5590, lng: 110.3891 }; // Kuching Port

async function makeEastTrip(env: Env, stops: EligibleOrder[], lorries: LorryRow[], busy: BusyMap): Promise<ProposedTrip> {
  const day = stops.reduce((min, o) => (o.latest < min ? o.latest : min), stops[0].latest);
  const lorry = pickLorry(lorries, busy, day);
  if (lorry) markBusy(busy, day, lorry.id);

  // Determine destination warehouse from the orders' sales_location
  const srwCount = stops.filter((s) => s.sales_location === "SRW").length;
  const isSRW = srwCount > stops.length / 2;
  const destWh = isSRW
    ? { code: "SRW", label: "Sarawak Warehouse", ...SRW_WAREHOUSE }
    : { code: "SBH", label: "Sabah Warehouse", ...SBH_WAREHOUSE };

  const emPort = isSRW ? SRW_PORT : SBH_PORT;
  const emWh = isSRW ? SRW_WAREHOUSE : SBH_WAREHOUSE;

  // Leg 1: KL warehouse → Port Klang → KL warehouse (lorry round trip)
  let klToPortKlang = round2(2 * haversineKm(KL_WAREHOUSE.lat, KL_WAREHOUSE.lng, PORT_KLANG.lat, PORT_KLANG.lng));
  try {
    const res = await directions(env, {
      origin: KL_WAREHOUSE,
      destination: KL_WAREHOUSE,
      waypoints: [PORT_KLANG],
    });
    klToPortKlang = round2(res.total_distance_m / 1000);
  } catch { /* keep haversine fallback */ }

  // Leg 2: EM port → EM warehouse (pickup from port)
  let emPortToWh = round2(haversineKm(emPort.lat, emPort.lng, emWh.lat, emWh.lng));
  try {
    const res = await directions(env, {
      origin: emPort,
      destination: emWh,
    });
    emPortToWh = round2(res.total_distance_m / 1000);
  } catch { /* keep haversine fallback */ }

  // Leg 3: EM warehouse → customer stops → EM warehouse (local delivery)
  let emLocalKm = 0;       // full local route including warehouse legs
  let emStopToStopKm = 0;  // customer stops only
  const geoStops = stops.filter((s) => s.lat != null && s.lng != null);
  if (geoStops.length > 0) {
    // Haversine fallback
    emLocalKm = fullRouteDistance(emWh.lat, emWh.lng, geoStops as any);
    emStopToStopKm = interStopDistance(geoStops as any);
    try {
      const waypoints = geoStops.map((s) => ({ lat: s.lat!, lng: s.lng! }));
      const res = await directions(env, {
        origin: emWh,
        destination: emWh,
        waypoints,
        optimize: true,
      });
      emLocalKm = res.total_distance_m / 1000;
      // Customer-only: exclude first leg (wh→stop1) and last leg (stopN→wh)
      if (res.legs.length > 2) {
        emStopToStopKm = res.legs.slice(1, -1).reduce((s, l) => s + l.distance_m, 0) / 1000;
      }
    } catch { /* keep haversine fallback */ }
  }

  const totalFullKm = round2(klToPortKlang + emPortToWh + emLocalKm);

  return {
    warehouse: "PORT_KLANG",
    trip_date: day,
    trip_type: "delivery",
    suggested_lorry_id: lorry?.id ?? null,
    suggested_driver_user_id: lorry?.default_driver_user_id ?? null,
    is_outsourced: lorry ? !lorry.is_internal : true,
    total_revenue: round2(stops.reduce((s, o) => s + o.local_total, 0)),
    total_distance_km: round2(emStopToStopKm),
    full_route_km: totalFullKm,
    stop_count: stops.length,
    stops: stops.map((s, i) => ({
      doc_no: s.doc_no,
      sequence: i + 1,
      debtor_name: s.debtor_name,
      lat: s.lat ?? 0,
      lng: s.lng ?? 0,
      local_total: s.local_total,
      expiry_date: s.expiry_date,
    })),
    reason: `EAST → ${destWh.code} — ${stops.length} orders · KL→PK ~${klToPortKlang}km + port→wh ~${emPortToWh}km + local ~${round2(emLocalKm)}km`,
    route_chain: [
      { label: "KL Warehouse", lat: KL_WAREHOUSE.lat, lng: KL_WAREHOUSE.lng, type: "origin" },
      { label: "Port Klang", lat: PORT_KLANG.lat, lng: PORT_KLANG.lng, type: "transit" },
      { label: `${destWh.code} Port`, lat: emPort.lat, lng: emPort.lng, type: "transit" },
      { label: destWh.label, lat: destWh.lat, lng: destWh.lng, type: "warehouse" },
    ],
  };
}

// ── Singapore planner (capacity-only) ─────────────────────────────

async function planSingapore(
  env: Env,
  orders: EligibleOrder[],
  lorries: LorryRow[],
  busy: BusyMap
): Promise<ProposedTrip[]> {
  const trips: ProposedTrip[] = [];
  // Sort by deadline so urgent orders ship in the earliest bin
  orders.sort((a, b) => a.latest.localeCompare(b.latest));

  // Distance ignored for SG. Split at MAX_STOPS.
  let bin: EligibleOrder[] = [];
  for (const o of orders) {
    bin.push(o);
    if (bin.length >= MAX_STOPS) {
      trips.push(await makeSgTrip(env, bin, lorries, busy));
      bin = [];
    }
  }
  if (bin.length) trips.push(await makeSgTrip(env, bin, lorries, busy));
  return trips;
}

// JB hub coordinates
const JB_HUB = { lat: 1.4927, lng: 103.7414 };

async function makeSgTrip(env: Env, stops: EligibleOrder[], lorries: LorryRow[], busy: BusyMap): Promise<ProposedTrip> {
  const day = stops.reduce((min, o) => (o.latest < min ? o.latest : min), stops[0].latest);
  const lorry = pickLorry(lorries, busy, day);
  if (lorry) markBusy(busy, day, lorry.id);
  // KL → JB hub round trip
  let klToJb = round2(2 * haversineKm(KL_WAREHOUSE.lat, KL_WAREHOUSE.lng, JB_HUB.lat, JB_HUB.lng));
  try {
    const res = await directions(env, {
      origin: KL_WAREHOUSE,
      destination: KL_WAREHOUSE,
      waypoints: [JB_HUB],
    });
    klToJb = round2(res.total_distance_m / 1000);
  } catch { /* keep haversine fallback */ }

  // Customer stop-to-stop distance only
  let sgStopToStopKm = 0;
  const geoStops = stops.filter((s) => s.lat != null && s.lng != null);
  if (geoStops.length >= 2) {
    sgStopToStopKm = interStopDistance(geoStops as any);
    try {
      const waypoints = geoStops.map((s) => ({ lat: s.lat!, lng: s.lng! }));
      const res = await directions(env, {
        origin: waypoints[0],
        destination: waypoints[waypoints.length - 1],
        waypoints: waypoints.slice(1, -1),
        optimize: true,
      });
      sgStopToStopKm = res.total_distance_m / 1000;
    } catch { /* keep haversine fallback */ }
  }

  return {
    warehouse: "SG",
    trip_date: day,
    trip_type: "sg",
    suggested_lorry_id: lorry?.id ?? null,
    suggested_driver_user_id: lorry?.default_driver_user_id ?? null,
    is_outsourced: lorry ? !lorry.is_internal : true,
    total_revenue: round2(stops.reduce((s, o) => s + o.local_total, 0)),
    total_distance_km: round2(sgStopToStopKm),
    full_route_km: round2(klToJb + sgStopToStopKm),
    stop_count: stops.length,
    stops: stops.map((s, i) => ({
      doc_no: s.doc_no,
      sequence: i + 1,
      debtor_name: s.debtor_name,
      lat: s.lat ?? 0,
      lng: s.lng ?? 0,
      local_total: s.local_total,
      expiry_date: s.expiry_date,
    })),
    reason: `SG drop at JB hub — ${stops.length} orders, outsource vendor handles last mile`,
    route_chain: [
      { label: "KL Warehouse", lat: KL_WAREHOUSE.lat, lng: KL_WAREHOUSE.lng, type: "origin" },
      { label: "JB Hub", lat: JB_HUB.lat, lng: JB_HUB.lng, type: "transit" },
      { label: "Customer (SG)", lat: 0, lng: 0, type: "destination" },
    ],
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

async function makeSoloTrip(
  env: Env,
  warehouse: string,
  whCoords: { lat: number; lng: number },
  day: string,
  o: EligibleOrder,
  lorry: LorryRow | null,
  type: "setup" | "delivery"
): Promise<ProposedTrip> {
  // Solo trip: 0 inter-stop km (only 1 stop). Full round-trip for info.
  let roundTrip = o.lat != null
    ? round2(2 * haversineKm(whCoords.lat, whCoords.lng, o.lat!, o.lng!))
    : 0;
  if (o.lat != null) {
    try {
      const res = await directions(env, {
        origin: whCoords,
        destination: whCoords,
        waypoints: [{ lat: o.lat!, lng: o.lng! }],
      });
      roundTrip = round2(res.total_distance_m / 1000);
    } catch { /* keep haversine fallback */ }
  }
  return {
    warehouse,
    trip_date: day,
    trip_type: type,
    suggested_lorry_id: lorry?.id ?? null,
    suggested_driver_user_id: lorry?.default_driver_user_id ?? null,
    is_outsourced: lorry ? !lorry.is_internal : true,
    total_revenue: round2(o.local_total),
    total_distance_km: 0,         // solo trip: 0 inter-stop distance
    full_route_km: roundTrip,     // warehouse → stop → warehouse
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
        reason: type === "setup" ? "Setup → solo trip (rule)" : "Could not bundle within horizon — solo trip",
      },
    ],
    reason: type === "setup" ? "Setup order — full trip required" : "Standalone delivery (no efficient bundle found)",
  };
}

// ── DB I/O ─────────────────────────────────────────────────────────

/**
 * Returns doc_nos of EM orders that have arrived at their local
 * warehouse (delivery_tracking.status = 'at_warehouse' or later
 * local statuses). These are ready for local delivery planning.
 */
async function fetchEMAtWarehouse(env: Env): Promise<Set<string>> {
  const rows = await env.DB.prepare(
    `SELECT doc_no FROM delivery_tracking
      WHERE region = 'EAST'
        AND status IN ('at_warehouse', 'out_for_delivery')`
  ).all<{ doc_no: string }>();
  return new Set((rows.results ?? []).map((r) => r.doc_no));
}

async function fetchWarehouseCoords(env: Env): Promise<Record<string, { lat: number; lng: number }>> {
  const rows = await env.DB.prepare(
    `SELECT code, lat, lng FROM warehouses WHERE lat IS NOT NULL AND lng IS NOT NULL`
  ).all<{ code: string; lat: number; lng: number }>();
  const map: Record<string, { lat: number; lng: number }> = {};
  for (const r of rows.results ?? []) {
    map[r.code] = { lat: r.lat, lng: r.lng };
  }
  return map;
}

async function fetchEligibleOrders(env: Env, today: Date, end: Date): Promise<EligibleOrder[]> {
  const todayStr = dateOnly(today);
  const endStr = dateOnly(end);

  // Exclude orders already on a confirmed trip in the horizon
  const rows = await env.DB.prepare(
    `SELECT
        so.doc_no, so.region, so.local_total, so.expiry_date, so.debtor_name,
        so.sales_location,
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
    // Use sales_location directly as warehouse (KL, PG, SBH, SRW)
    const salesLoc = (r.sales_location || "").toUpperCase();
    const effectiveWarehouse = salesLoc === "PG" ? "PG" : salesLoc === "SBH" ? "SBH" : salesLoc === "SRW" ? "SRW" : "KL";

    out.push({
      doc_no: r.doc_no,
      region: r.region as "WEST" | "EAST" | "SG",
      sales_location: r.sales_location,
      warehouse: effectiveWarehouse,
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
  const todayStr = dateOnly(today);
  const endStr = dateOnly(end);

  // Lorries busy with existing trips
  const tripRows = await env.DB.prepare(
    `SELECT trip_date, lorry_id FROM trips
      WHERE lorry_id IS NOT NULL
        AND status IN ('assigned','started','in_progress','completed')
        AND trip_date BETWEEN ? AND ?`
  )
    .bind(todayStr, endStr)
    .all<{ trip_date: string; lorry_id: number }>();

  const map: BusyMap = {};
  for (const r of tripRows.results ?? []) {
    (map[r.trip_date] ||= new Set()).add(r.lorry_id);
  }

  // Lorries unavailable due to maintenance
  const maintRows = await env.DB.prepare(
    `SELECT lorry_id, unavailable_from, unavailable_to FROM lorry_maintenance
      WHERE unavailable_from IS NOT NULL AND unavailable_to IS NOT NULL
        AND unavailable_from <= ? AND unavailable_to >= ?`
  )
    .bind(endStr, todayStr)
    .all<{ lorry_id: number; unavailable_from: string; unavailable_to: string }>();

  for (const m of maintRows.results ?? []) {
    const from = m.unavailable_from < todayStr ? todayStr : m.unavailable_from;
    const to = m.unavailable_to > endStr ? endStr : m.unavailable_to;
    for (let d = new Date(from); dateOnly(d) <= to; d = addDays(d, 1)) {
      (map[dateOnly(d)] ||= new Set()).add(m.lorry_id);
    }
  }

  // Lorries with expired compliance (road tax, insurance, PUSPAKOM)
  const expiredRows = await env.DB.prepare(
    `SELECT id FROM lorries
      WHERE is_active = 1
        AND (road_tax_expiry < ? OR insurance_expiry < ? OR puspakom_expiry < ?)`
  )
    .bind(todayStr, todayStr, todayStr)
    .all<{ id: number }>();

  // Mark expired lorries as busy for the entire horizon
  for (const l of expiredRows.results ?? []) {
    for (let d = new Date(today); d <= end; d = addDays(d, 1)) {
      (map[dateOnly(d)] ||= new Set()).add(l.id);
    }
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
          full_route_km: t.full_route_km,
          route_chain: t.route_chain,
        })
      )
      .run();
  }

  return proposalId;
}

// ── Confirmation: materialize proposal into real trips ────────────

import { nextTripNo } from "./trips";

/**
 * Materialize proposed trips into real trips.
 * If `tripIds` is provided, only those proposal-trip rows are confirmed
 * and the proposal stays as 'draft' so the dispatcher can confirm more
 * later. If omitted (or empty), all non-blocked trips are confirmed and
 * the proposal is marked 'confirmed'.
 */
export async function confirmProposal(
  env: Env,
  proposalId: number,
  userId: number,
  tripIds?: number[]
) {
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

  const selectAll = !tripIds || tripIds.length === 0;
  const selectedSet = selectAll ? null : new Set(tripIds);

  let createdCount = 0;
  const confirmedPtIds: number[] = [];

  for (const pt of proposalTrips.results ?? []) {
    if (pt.trip_type === "blocked") continue;
    if (selectedSet && !selectedSet.has(pt.id)) continue;

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
    confirmedPtIds.push(pt.id);
    createdCount++;
  }

  // Remove confirmed proposal trips so they don't show in the draft anymore
  if (confirmedPtIds.length && !selectAll) {
    const ph = confirmedPtIds.map(() => "?").join(",");
    await env.DB.prepare(
      `DELETE FROM trip_proposal_trips WHERE id IN (${ph})`
    )
      .bind(...confirmedPtIds)
      .run();

    // If no non-blocked trips remain, mark proposal as confirmed
    const remaining = await env.DB.prepare(
      `SELECT COUNT(*) as c FROM trip_proposal_trips
        WHERE proposal_id = ? AND trip_type != 'blocked'`
    )
      .bind(proposalId)
      .first<{ c: number }>();
    if (!remaining || remaining.c === 0) {
      await env.DB.prepare(
        `UPDATE trip_proposals SET status = 'confirmed' WHERE id = ?`
      )
        .bind(proposalId)
        .run();
    }
  } else {
    await env.DB.prepare(
      `UPDATE trip_proposals SET status = 'confirmed' WHERE id = ?`
    )
      .bind(proposalId)
      .run();
  }

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

// Distance cap only counts stop-to-stop legs. Warehouse → first stop
// and last stop → warehouse are excluded from the cap but used as an
// optimization signal (prefer first/last stops near the warehouse).

function interStopDistance(stops: EligibleOrder[]): number {
  if (stops.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1];
    const b = stops[i];
    if (a.lat == null || b.lat == null) continue;
    total += haversineKm(a.lat!, a.lng!, b.lat!, b.lng!);
  }
  return total;
}

// Full round-trip estimate including warehouse legs — used for the
// total_distance_km stored on the proposal (informational, not for cap).
function fullRouteDistance(whLat: number, whLng: number, stops: EligibleOrder[]): number {
  if (stops.length === 0) return 0;
  let total = 0;
  // Warehouse → first stop
  const first = stops[0];
  if (first.lat != null) total += haversineKm(whLat, whLng, first.lat!, first.lng!);
  // Stop-to-stop
  total += interStopDistance(stops);
  // Last stop → warehouse
  const last = stops[stops.length - 1];
  if (last.lat != null) total += haversineKm(last.lat!, last.lng!, whLat, whLng);
  return total;
}

// Distance from an order to a warehouse — used to prefer first/last
// stops near the warehouse for route optimization.
function distToWarehouse(whLat: number, whLng: number, o: EligibleOrder): number {
  if (o.lat == null || o.lng == null) return Infinity;
  return haversineKm(whLat, whLng, o.lat, o.lng);
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
