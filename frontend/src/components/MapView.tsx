import { useEffect, useRef } from "react";
import L, { type LatLngExpression, type Map as LeafletMap } from "leaflet";
import "leaflet/dist/leaflet.css";

/**
 * Lightweight Leaflet wrapper. We use OpenStreetMap tiles (free, no key)
 * and let the worker proxy Google Directions for the actual route
 * polyline. The component is purely declarative — pass props, the
 * effects diff and update the map state.
 *
 * Marker icons: Leaflet's default icon paths break under bundlers
 * (they reference relative URLs at runtime). We create simple
 * div-icons inline so we don't have to ship the PNGs.
 */

export interface MapPin {
  id: string | number;
  lat: number;
  lng: number;
  /** Big number stamped on the pin (used for stop sequence). */
  label?: string | number;
  /** Tone changes the pin color. */
  tone?: "default" | "warehouse" | "hub" | "done" | "failed" | "current";
  popup?: string;
  onClick?: () => void;
}

interface Props {
  pins: MapPin[];
  /** Encoded Google polyline (planned route). */
  routePolyline?: string | null;
  /** Raw lat/lng path (actual GPS trail). */
  trail?: { lat: number; lng: number }[];
  /** The driver's live position (rendered as a pulsing dot). */
  currentLocation?: { lat: number; lng: number } | null;
  /** Force the map to recenter on the bounds whenever pins change. */
  fitToPins?: boolean;
  /** Show a color legend below the map for the pin tones in use. */
  showLegend?: boolean;
  className?: string;
  height?: number | string;
}

export function MapView({
  pins,
  routePolyline,
  trail,
  currentLocation,
  fitToPins = true,
  showLegend = true,
  className,
  height = 320,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const layersRef = useRef<{
    pins: L.LayerGroup | null;
    route: L.Polyline | null;
    trail: L.Polyline | null;
    current: L.CircleMarker | null;
  }>({ pins: null, route: null, trail: null, current: null });

  // Init the map once
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, {
      zoomControl: true,
      attributionControl: false,
    }).setView([3.139, 101.6869], 11); // Default to KL

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "© OpenStreetMap",
    }).addTo(map);

    layersRef.current.pins = L.layerGroup().addTo(map);

    mapRef.current = map;

    // Handle container resize (panel open/close, expand toggle)
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Pins
  useEffect(() => {
    const map = mapRef.current;
    const group = layersRef.current.pins;
    if (!map || !group) return;
    group.clearLayers();

    for (const pin of pins) {
      const marker = L.marker([pin.lat, pin.lng], {
        icon: makeIcon(pin),
      });
      if (pin.popup) marker.bindPopup(pin.popup);
      if (pin.onClick) marker.on("click", pin.onClick);
      group.addLayer(marker);
    }

    if (fitToPins && pins.length) {
      const bounds = L.latLngBounds(pins.map((p) => [p.lat, p.lng] as LatLngExpression));
      map.fitBounds(bounds, { padding: [30, 30], maxZoom: 14 });
    }
  }, [pins, fitToPins]);

  // Planned route polyline
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (layersRef.current.route) {
      layersRef.current.route.remove();
      layersRef.current.route = null;
    }
    if (routePolyline) {
      const points = decodePolyline(routePolyline);
      const line = L.polyline(points, {
        color: "#a16a2e",
        weight: 4,
        opacity: 0.85,
      }).addTo(map);
      layersRef.current.route = line;
    }
  }, [routePolyline]);

  // Actual GPS trail
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (layersRef.current.trail) {
      layersRef.current.trail.remove();
      layersRef.current.trail = null;
    }
    if (trail && trail.length > 1) {
      const line = L.polyline(
        trail.map((p) => [p.lat, p.lng] as LatLngExpression),
        { color: "#1f1d1a", weight: 3, opacity: 0.6, dashArray: "6,4" }
      ).addTo(map);
      layersRef.current.trail = line;
    }
  }, [trail]);

  // Current location dot
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (layersRef.current.current) {
      layersRef.current.current.remove();
      layersRef.current.current = null;
    }
    if (currentLocation) {
      const dot = L.circleMarker([currentLocation.lat, currentLocation.lng], {
        radius: 8,
        color: "#fff",
        weight: 3,
        fillColor: "#0a84ff",
        fillOpacity: 1,
      }).addTo(map);
      layersRef.current.current = dot;
    }
  }, [currentLocation]);

  // Determine which tones are actually used so we only show relevant legend items
  const usedTones: Set<string> = new Set(pins.map((p) => p.tone || "default"));

  return (
    <div>
      <div
        ref={containerRef}
        className={className ?? "w-full overflow-hidden rounded-md border border-border"}
        style={{ height }}
      />
      {showLegend && usedTones.size > 1 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-3 px-0.5">
          {PIN_LEGEND.filter((l) => usedTones.has(l.tone)).map((l) => (
            <div key={l.tone} className="flex items-center gap-1.5 text-[9px] text-ink-secondary">
              <span
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: l.color }}
              />
              {l.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────

const PIN_COLORS: Record<string, string> = {
  default: "#a16a2e",    // brass — customer stops
  warehouse: "#1f1d1a",  // black — warehouses (KL, PG, SBH, SRW)
  hub: "#0a84ff",        // blue — transit hubs (Port Klang, JB)
  done: "#15803d",       // green — delivered
  failed: "#b91c1c",     // red — failed
  current: "#0a84ff",    // blue — live driver position
};

export const PIN_LEGEND: { tone: string; label: string; color: string }[] = [
  { tone: "warehouse", label: "Warehouse", color: PIN_COLORS.warehouse },
  { tone: "hub", label: "Transit Hub", color: PIN_COLORS.hub },
  { tone: "default", label: "Customer Stop", color: PIN_COLORS.default },
  { tone: "done", label: "Delivered", color: PIN_COLORS.done },
  { tone: "failed", label: "Failed", color: PIN_COLORS.failed },
];

function makeIcon(pin: MapPin) {
  const color = PIN_COLORS[pin.tone || "default"];
  const label = pin.label != null ? String(pin.label) : "";
  const html = `
    <div style="
      position:relative;
      width:28px;height:28px;
      border-radius:50% 50% 50% 0;
      background:${color};
      transform:rotate(-45deg);
      box-shadow:0 2px 6px rgba(0,0,0,0.3);
      border:2px solid #fff;
    ">
      <div style="
        position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
        transform:rotate(45deg);color:#fff;font-weight:700;font-size:11px;
        font-family:ui-monospace,monospace;
      ">${label}</div>
    </div>
  `;
  return L.divIcon({
    html,
    className: "houzs-pin",
    iconSize: [28, 28],
    iconAnchor: [14, 26],
    popupAnchor: [0, -22],
  });
}

/**
 * Decode a Google "encoded polyline" string into an array of [lat, lng]
 * tuples. Adapted from the public algorithm at
 * https://developers.google.com/maps/documentation/utilities/polylinealgorithm
 */
export function decodePolyline(str: string): [number, number][] {
  let index = 0;
  const len = str.length;
  let lat = 0;
  let lng = 0;
  const out: [number, number][] = [];

  while (index < len) {
    let b: number;
    let shift = 0;
    let result = 0;
    do {
      b = str.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlat = result & 1 ? ~(result >> 1) : result >> 1;
    lat += dlat;

    shift = 0;
    result = 0;
    do {
      b = str.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlng = result & 1 ? ~(result >> 1) : result >> 1;
    lng += dlng;

    out.push([lat / 1e5, lng / 1e5]);
  }
  return out;
}
