import type { Env } from "../types";

/**
 * Server-side wrappers around Google Maps APIs.
 *
 * The browser never sees the API key — every call goes through the
 * worker. We only proxy two endpoints:
 *   - Geocoding API   → address → { lat, lng }
 *   - Directions API  → origin + waypoints → polyline + leg metrics
 *
 * Costs to keep in mind:
 *   - Geocoding: ~$5 per 1000 requests (each unique address ≈ 1 call,
 *     cached on order_details.lat/lng so addresses re-geocode at most once)
 *   - Directions: ~$5 per 1000 routes; with optimize_waypoints=true the
 *     pricing tier is "Advanced" at ~$10/1000.
 */

const GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";
const DIRECTIONS_URL = "https://maps.googleapis.com/maps/api/directions/json";

function requireKey(env: Env): string {
  const key = env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new Error("GOOGLE_MAPS_API_KEY is not configured");
  return key;
}

export interface GeocodeResult {
  lat: number;
  lng: number;
  formatted: string;
  partial: boolean;
  /** State / administrative_area_level_1 long name (e.g. "Selangor", "Pulau Pinang") */
  state: string | null;
  /** Country long name */
  country: string | null;
}

export async function geocode(env: Env, address: string): Promise<GeocodeResult | null> {
  if (!address || !address.trim()) return null;
  const key = requireKey(env);
  const url = `${GEOCODE_URL}?address=${encodeURIComponent(address)}&region=my&key=${key}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Geocode failed: ${res.status}`);
  const data = (await res.json()) as any;
  if (data.status !== "OK" || !data.results?.length) {
    if (data.status === "ZERO_RESULTS") return null;
    throw new Error(`Geocode error: ${data.status} ${data.error_message || ""}`);
  }
  const r = data.results[0];
  const components: any[] = r.address_components || [];
  const findType = (type: string) =>
    components.find((c) => Array.isArray(c.types) && c.types.includes(type));
  const stateComp = findType("administrative_area_level_1");
  const countryComp = findType("country");
  return {
    lat: r.geometry.location.lat,
    lng: r.geometry.location.lng,
    formatted: r.formatted_address,
    partial: !!r.partial_match,
    state: stateComp?.long_name ?? null,
    country: countryComp?.long_name ?? null,
  };
}

/**
 * Look up which warehouse a state belongs to. Special-cases Singapore
 * (the country, not a Malaysian state) since Google reports it as
 * country=Singapore with no admin_area_level_1.
 */
export async function warehouseForState(
  env: Env,
  state: string | null,
  country: string | null
): Promise<string | null> {
  if (country && country.toLowerCase() === "singapore") return "SG";
  if (!state) return null;
  const row = await env.DB.prepare(
    `SELECT warehouse FROM state_warehouse_map WHERE LOWER(state) = LOWER(?)`
  )
    .bind(state)
    .first<{ warehouse: string }>();
  return row?.warehouse ?? null;
}

// ── Directions ─────────────────────────────────────────────────────

export interface LatLng {
  lat: number;
  lng: number;
}

export interface DirectionsLeg {
  distance_m: number;
  duration_s: number;
  start: LatLng;
  end: LatLng;
}

export interface DirectionsResult {
  /** Encoded polyline of the entire route, ready for Leaflet to decode. */
  polyline: string;
  total_distance_m: number;
  total_duration_s: number;
  legs: DirectionsLeg[];
  /**
   * If the request set optimize_waypoints=true, this is the order Google
   * returned the waypoints in. Indices refer to the original waypoint
   * array. The dispatcher uses this to reorder trip_stops.
   */
  waypoint_order: number[];
}

export interface DirectionsInput {
  origin: LatLng;
  destination: LatLng;
  waypoints?: LatLng[];
  optimize?: boolean;
}

export async function directions(env: Env, input: DirectionsInput): Promise<DirectionsResult> {
  const key = requireKey(env);

  const wpParts: string[] = [];
  if (input.waypoints?.length) {
    if (input.optimize) wpParts.push("optimize:true");
    wpParts.push(...input.waypoints.map((w) => `${w.lat},${w.lng}`));
  }

  const params = new URLSearchParams({
    origin: `${input.origin.lat},${input.origin.lng}`,
    destination: `${input.destination.lat},${input.destination.lng}`,
    mode: "driving",
    key,
  });
  if (wpParts.length) params.set("waypoints", wpParts.join("|"));

  const res = await fetch(`${DIRECTIONS_URL}?${params.toString()}`);
  if (!res.ok) throw new Error(`Directions failed: ${res.status}`);
  const data = (await res.json()) as any;
  if (data.status !== "OK" || !data.routes?.length) {
    throw new Error(`Directions error: ${data.status} ${data.error_message || ""}`);
  }
  const route = data.routes[0];
  const legs: DirectionsLeg[] = (route.legs as any[]).map((l) => ({
    distance_m: l.distance.value,
    duration_s: l.duration.value,
    start: { lat: l.start_location.lat, lng: l.start_location.lng },
    end: { lat: l.end_location.lat, lng: l.end_location.lng },
  }));
  return {
    polyline: route.overview_polyline.points,
    total_distance_m: legs.reduce((s, l) => s + l.distance_m, 0),
    total_duration_s: legs.reduce((s, l) => s + l.duration_s, 0),
    legs,
    waypoint_order: route.waypoint_order ?? [],
  };
}

// ── Address composer ───────────────────────────────────────────────

/** Build a single-line geocodable address from the four invoice address lines. */
export function joinAddress(parts: (string | null | undefined)[]): string {
  return parts
    .map((p) => (p || "").trim())
    .filter((p) => p.length > 0)
    .join(", ");
}
