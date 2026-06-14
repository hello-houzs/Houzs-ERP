import { useEffect, useMemo, useState } from "react";
import {
  Sparkles,
  Trash2,
  Check,
  AlertTriangle,
  X,
  Plus,
  Truck,
  ChevronUp,
  ChevronDown,
  GripVertical,
  ExternalLink,
  RefreshCw,
} from "lucide-react";
import { MapView, type MapPin } from "./MapView";
import { Panel, PanelSection, FieldRow } from "./Panel";
import { StatCard } from "./StatCard";
import { DashboardGrid } from "./Dashboard";
import { useQuery } from "../hooks/useQuery";
import { useDialog } from "../hooks/useDialog";
import { api, buildQuery } from "../api/client";
import { formatCurrency, formatDate, cn } from "../lib/utils";
import type {
  PlannerProposal,
  PlannerTrip,
  PlannerStop,
  Lorry,
  TeamMember,
  Paginated,
  SalesOrder,
} from "../types";

/**
 * Drafts tab — the scheduling agent UI. Click a proposed trip card to
 * open a side panel where you can review the route on a map, reorder /
 * add / remove stops, and change date / lorry / driver.
 */
export function DraftsTab({ onConfirmed }: { onConfirmed?: () => void }) {
  const dialog = useDialog();
  const [horizon, setHorizon] = useState(7);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [openTrip, setOpenTrip] = useState<PlannerTrip | null>(null);

  const current = useQuery<{ proposal: PlannerProposal | null; trips?: PlannerTrip[] }>(
    () => api.get("/api/planner/current")
  );

  const proposal = current.data?.proposal;
  const trips = current.data?.trips ?? [];
  const blocked = trips.filter((t) => t.trip_type === "blocked");
  const planned = trips.filter((t) => t.trip_type !== "blocked");

  function toggleSelect(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (selected.size === planned.length) setSelected(new Set());
    else setSelected(new Set(planned.map((t) => t.id)));
  }

  async function generate() {
    if (
      !await dialog.confirm(
        `Generate proposals for the next ${horizon} days? Any current draft will be discarded.`
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/planner/generate", { horizon_days: horizon });
      setSelected(new Set());
      setOpenTrip(null);
      current.reload();
    } catch (e: any) {
      setError(e?.message || "Generation failed");
    } finally {
      setBusy(false);
    }
  }

  async function discard() {
    if (!proposal) return;
    if (!await dialog.confirm("Discard the current draft?")) return;
    setBusy(true);
    try {
      await api.post(`/api/planner/${proposal.id}/discard`);
      setSelected(new Set());
      setOpenTrip(null);
      current.reload();
    } finally {
      setBusy(false);
    }
  }

  async function confirmSelected() {
    if (!proposal) return;
    const ids = [...selected];
    const count = ids.length || planned.length;
    const isAll = ids.length === 0 || ids.length === planned.length;
    if (
      !await dialog.confirm(
        `Confirm ${count} trip${count === 1 ? "" : "s"}? They'll appear under Live & Upcoming and drivers will see them.`
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/planner/${proposal.id}/confirm`, {
        trip_ids: isAll ? undefined : ids,
      });
      setSelected(new Set());
      setOpenTrip(null);
      current.reload();
      onConfirmed?.();
    } catch (e: any) {
      setError(e?.message || "Confirm failed");
    } finally {
      setBusy(false);
    }
  }

  const grouped: Record<string, PlannerTrip[]> = {};
  for (const t of planned) {
    (grouped[t.trip_date] ||= []).push(t);
  }
  const dates = Object.keys(grouped).sort();

  const allSelected = planned.length > 0 && selected.size === planned.length;
  const someSelected = selected.size > 0;
  const confirmLabel = someSelected
    ? `Confirm ${selected.size} Trip${selected.size === 1 ? "" : "s"}`
    : "Confirm All";

  return (
    <div>
      {/* Action row */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select
          value={horizon}
          onChange={(e) => setHorizon(parseInt(e.target.value, 10))}
          className="rounded-md border border-border bg-surface px-2 py-2 text-[12px]"
        >
          <option value={3}>Next 3 days</option>
          <option value={7}>Next 7 days</option>
          <option value={14}>Next 14 days</option>
        </select>
        <button
          disabled={busy}
          onClick={generate}
          className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-2 text-[12px] font-bold uppercase tracking-wide text-white shadow-sm disabled:opacity-50"
        >
          <Sparkles size={14} />
          {busy ? "Generating…" : proposal ? "Re-generate" : "Generate"}
        </button>
        {proposal && (
          <>
            <span className="ml-2 text-[11px] text-ink-secondary">
              Draft from {formatDate(proposal.generated_at)} · {proposal.horizon_days}-day horizon
            </span>
            <div className="ml-auto flex gap-2">
              {planned.length > 1 && (
                <button
                  onClick={toggleAll}
                  className="flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-2 text-[12px] font-semibold text-ink hover:border-accent/40"
                >
                  {allSelected ? "Deselect All" : "Select All"}
                </button>
              )}
              <button
                onClick={discard}
                className="flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-2 text-[12px] font-semibold text-ink hover:border-err/40"
              >
                <Trash2 size={13} /> Discard
              </button>
              <button
                disabled={busy || planned.length === 0}
                onClick={confirmSelected}
                className="flex items-center gap-1.5 rounded-md bg-ok px-4 py-2 text-[12px] font-bold uppercase tracking-wide text-white disabled:opacity-50"
              >
                <Check size={14} /> {confirmLabel}
              </button>
            </div>
          </>
        )}
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-err/40 bg-err/5 p-3 text-[12px] text-err">
          {error}
        </div>
      )}

      {current.loading && <div className="text-sm text-ink-secondary">Loading…</div>}

      {!current.loading && !proposal && (
        <div className="rounded-lg border border-dashed border-border bg-surface p-10 text-center">
          <Sparkles size={28} className="mx-auto mb-3 text-accent" />
          <div className="font-display text-[15px] font-bold leading-tight tracking-tight text-ink">No draft proposal</div>
          <div className="mt-1 text-[12px] text-ink-secondary">
            Click <span className="font-semibold">Generate</span> to plan trips for the
            next {horizon} days.
          </div>
        </div>
      )}

      {proposal && proposal.summary && (
        <>
          <DashboardGrid cols={4}>
            <StatCard
              label="Proposed Trips"
              value={proposal.summary.total_trips.toString()}
              subtitle={`${proposal.summary.total_orders} orders bundled`}
            />
            <StatCard
              label="Total Revenue"
              value={formatCurrency(proposal.summary.total_revenue, { compact: true })}
              subtitle="Across all proposed trips"
            />
            <StatCard
              label="Outsourced"
              value={proposal.summary.outsourced_trips.toString()}
              subtitle="Trips needing outside lorries"
            />
            <StatCard
              label="Blocked"
              value={proposal.summary.blocked_orders.toString()}
              subtitle="Orders missing data"
              tone={proposal.summary.blocked_orders > 0 ? "error" : "default"}
            />
          </DashboardGrid>

          <div className="mb-2" />

          {dates.map((d) => (
            <div key={d} className="mb-6">
              <div className="mb-2 flex items-center gap-2">
                <div className="text-[10px] font-semibold uppercase tracking-brand text-accent">
                  {formatDate(d)}
                </div>
                <span className="text-[10px] text-ink-secondary">
                  · {grouped[d].length} trip{grouped[d].length === 1 ? "" : "s"}
                </span>
              </div>
              <div className="space-y-2">
                {grouped[d].map((t) => (
                  <ProposalCard
                    key={t.id}
                    trip={t}
                    checked={selected.has(t.id)}
                    onToggle={() => toggleSelect(t.id)}
                    onClick={() => setOpenTrip(t)}
                  />
                ))}
              </div>
            </div>
          ))}

          {blocked.length > 0 && (
            <div className="mt-8 rounded-lg border border-warning-text/30 bg-warning-bg/30 p-4">
              <div className="mb-2 flex items-center gap-2">
                <AlertTriangle size={16} className="text-warning-text" />
                <div className="font-display text-[12px] font-bold text-warning-text">
                  Blocked orders ({blocked[0].payload.stops.length})
                </div>
              </div>
              <div className="text-[11px] text-warning-text">
                {blocked[0].payload.blocked_reason || "Missing data"}
              </div>
              <ul className="mt-2 space-y-1">
                {blocked[0].payload.stops.map((s) => (
                  <li
                    key={s.doc_no}
                    className="flex items-center justify-between text-[11px] text-ink"
                  >
                    <span className="font-mono">{s.doc_no}</span>
                    <span className="text-ink-secondary">{s.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {/* Detail panel */}
      <ProposalPanel
        trip={openTrip}
        onClose={() => setOpenTrip(null)}
        onChanged={() => {
          current.reload();
          setOpenTrip(null);
        }}
        onDeleted={() => {
          current.reload();
          setOpenTrip(null);
        }}
      />
    </div>
  );
}

// ── Summary card (clickable row) ──────────────────────────────────

function ProposalCard({
  trip,
  checked,
  onToggle,
  onClick,
}: {
  trip: PlannerTrip;
  checked: boolean;
  onToggle: () => void;
  onClick: () => void;
}) {
  const revenue = trip.payload.stops.reduce((s, st) => s + (st.local_total || 0), 0);
  const lorryLabel = trip.lorry_plate
    ? `${trip.lorry_plate}${trip.lorry_size ? ` · ${trip.lorry_size}` : ""}${
        trip.lorry_is_internal ? "" : " (out)"
      }`
    : "No lorry";

  return (
    <div
      className={cn(
        "flex cursor-pointer items-center gap-3 rounded-xl border bg-surface p-3 shadow-sm transition-colors hover:border-accent/40",
        trip.is_outsourced ? "border-warning-text/40" : "border-border"
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        onClick={(e) => e.stopPropagation()}
        className="h-4 w-4 shrink-0 cursor-pointer rounded border-border accent-accent"
      />

      <div className="min-w-0 flex-1" onClick={onClick}>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide",
              trip.trip_type === "setup" && "bg-accent/10 text-accent",
              trip.trip_type === "sg" && "bg-warning-bg text-warning-text",
              trip.trip_type === "delivery" && "bg-ink/10 text-ink"
            )}
          >
            {trip.trip_type}
          </span>
          <span className="text-[11px] font-semibold text-ink-secondary">
            {trip.warehouse_name || trip.warehouse}
          </span>
          {trip.is_outsourced && (
            <span className="rounded bg-warning-bg px-1.5 py-0.5 text-[9px] font-bold uppercase text-warning-text">
              Outsource
            </span>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-3 text-[11px] text-ink-secondary">
          <span>
            <Truck size={11} className="mr-1 inline" />
            {lorryLabel}
          </span>
          <span>· {trip.driver_name || "No driver"}</span>
          <span>
            · <span className="font-semibold text-ink">{trip.stop_count}</span> stops
          </span>
          <span>
            · <span className="font-semibold text-ink">{formatCurrency(revenue)}</span>
          </span>
          <span>· ~{trip.total_distance_km.toFixed(0)}km stops{trip.payload.full_route_km ? ` · ~${trip.payload.full_route_km.toFixed(0)}km total` : ""}</span>
        </div>
      </div>
    </div>
  );
}

// ── Detail panel (map + editable stops) ──────────────────────────

function ProposalPanel({
  trip,
  onClose,
  onChanged,
  onDeleted,
}: {
  trip: PlannerTrip | null;
  onClose: () => void;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const dialog = useDialog();
  // Local editable state — reset when the trip changes.
  const [local, setLocal] = useState<{
    trip_date: string;
    suggested_lorry_id: number | null;
    suggested_driver_user_id: number | null;
    stops: PlannerStop[];
  } | null>(null);

  const [busy, setBusy] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Sync local state when the panel opens or the trip changes.
  const tripId = trip?.id;
  if (trip && (!local || (local as any).__tripId !== tripId)) {
    const next = {
      trip_date: trip.trip_date,
      suggested_lorry_id: trip.suggested_lorry_id,
      suggested_driver_user_id: trip.suggested_driver_user_id,
      stops: [...trip.payload.stops],
      __tripId: tripId,
    };
    setLocal(next as any);
  }

  // For PORT_KLANG/SG trips, lorries come from KL warehouse
  const lorryWarehouse = trip?.warehouse === "PORT_KLANG" || trip?.warehouse === "SG"
    ? "KL"
    : trip?.warehouse;
  const lorries = useQuery<{ data: Lorry[] }>(
    () =>
      trip
        ? api.get(`/api/lorries${buildQuery({ warehouse: lorryWarehouse })}`)
        : Promise.resolve({ data: [] }),
    [lorryWarehouse]
  );
  // Show all active users as potential drivers (not just Driver role)
  const drivers = useQuery<{ users: TeamMember[] }>(
    () => (trip ? api.get<{ users: TeamMember[] }>("/api/users").catch(() => ({ users: [] as TeamMember[] })) : Promise.resolve({ users: [] as TeamMember[] }))
  );

  const stops = local?.stops ?? [];

  // Map pins
  const geoStops = useMemo(
    () => stops.filter((s) => s.lat != null && s.lng != null && (s.lat !== 0 || s.lng !== 0)),
    [stops]
  );

  const routeChain = trip?.payload.route_chain;
  const hasChain = routeChain && routeChain.length > 0;

  const pins: MapPin[] = useMemo(() => {
    const out: MapPin[] = [];

    if (hasChain) {
      // EM/SG: show route chain waypoints (origin, transit points)
      routeChain!.forEach((wp, i) => {
        if (wp.lat === 0 && wp.lng === 0) return; // skip placeholder
        out.push({
          id: `chain-${i}`,
          lat: wp.lat,
          lng: wp.lng,
          label: wp.type === "origin" ? "W" : wp.type === "transit" ? "H" : "W",
          tone: wp.type === "origin" ? "warehouse" : wp.type === "transit" ? "hub" : "warehouse",
          popup: wp.label,
        });
      });
    } else if (trip?.warehouse_lat != null && trip?.warehouse_lng != null) {
      // WEST: show warehouse pin
      out.push({
        id: "wh",
        lat: trip.warehouse_lat,
        lng: trip.warehouse_lng,
        label: "W",
        tone: "warehouse",
        popup: trip.warehouse_name || trip.warehouse,
      });
    }

    // Customer stop pins
    geoStops.forEach((s, i) => {
      out.push({
        id: s.doc_no,
        lat: s.lat,
        lng: s.lng,
        label: i + 1,
        tone: "default" as const,
        popup: `${i + 1}. ${s.debtor_name || s.doc_no}`,
      });
    });
    return out;
  }, [trip, geoStops, hasChain, routeChain]);

  // Trail line connecting route chain waypoints (for EM/SG visualization)
  const chainTrail = useMemo(() => {
    if (!hasChain) return undefined;
    return routeChain!
      .filter((wp) => wp.lat !== 0 || wp.lng !== 0)
      .map((wp) => ({ lat: wp.lat, lng: wp.lng }));
  }, [hasChain, routeChain]);

  // Route polyline + metrics (same as live panel)
  const [polyline, setPolyline] = useState<string | null>(null);
  const [routeMeta, setRouteMeta] = useState<{ km: number; min: number } | null>(null);
  const [routeBusy, setRouteBusy] = useState(false);

  // Determine origin/destination for directions based on trip type
  const routeOrigin = useMemo(() => {
    if (!trip) return null;
    if (trip.warehouse === "PORT_KLANG" && routeChain?.length) {
      const emWh = [...routeChain].reverse().find((wp) => wp.type === "warehouse");
      return emWh ? { lat: emWh.lat, lng: emWh.lng } : null;
    }
    if (trip.warehouse === "SG") return null; // SG has no routable customer stops
    if (trip.warehouse_lat != null && trip.warehouse_lng != null) {
      return { lat: trip.warehouse_lat, lng: trip.warehouse_lng };
    }
    return null;
  }, [trip, routeChain]);

  async function fetchRoute() {
    if (!routeOrigin || geoStops.length < 1) return;
    setRouteBusy(true);
    try {
      const waypoints = geoStops.map((s) => ({ lat: s.lat, lng: s.lng }));
      const res = await api.post<any>("/api/maps/directions", {
        origin: routeOrigin,
        destination: routeOrigin,
        waypoints,
      });
      setPolyline(res.polyline);
      setRouteMeta({
        km: Math.round((res.total_distance_m / 1000) * 10) / 10,
        min: Math.round(res.total_duration_s / 60),
      });
    } catch {
      setPolyline(null);
      setRouteMeta(null);
    } finally {
      setRouteBusy(false);
    }
  }

  // Auto-load route when panel opens
  useEffect(() => {
    setPolyline(null);
    setRouteMeta(null);
    if (routeOrigin && geoStops.length > 0) {
      fetchRoute();
    }
  }, [trip?.id]);

  function moveStop(idx: number, dir: -1 | 1) {
    if (!local) return;
    const target = idx + dir;
    if (target < 0 || target >= local.stops.length) return;
    const next = [...local.stops];
    [next[idx], next[target]] = [next[target], next[idx]];
    setLocal({ ...local, stops: next });
  }

  function removeStop(docNo: string) {
    if (!local) return;
    setLocal({ ...local, stops: local.stops.filter((s) => s.doc_no !== docNo) });
  }

  function addStops(picked: SalesOrder[]) {
    if (!local) return;
    setLocal({
      ...local,
      stops: [
        ...local.stops,
        ...picked.map((o, i) => ({
          doc_no: o.doc_no,
          sequence: local.stops.length + i + 1,
          debtor_name: o.debtor_name,
          lat: 0,
          lng: 0,
          local_total: o.local_total,
          expiry_date: o.expiry_date || "",
        })),
      ],
    });
  }

  async function save() {
    if (!trip || !local) return;
    setBusy(true);
    setSaveError(null);
    try {
      await api.patch(`/api/planner/trips/${trip.id}`, {
        trip_date: local.trip_date,
        suggested_lorry_id: local.suggested_lorry_id,
        suggested_driver_user_id: local.suggested_driver_user_id,
        stops: local.stops.map((s, i) => ({ doc_no: s.doc_no, sequence: i + 1 })),
      });
      onChanged();
    } catch (e: any) {
      setSaveError(e?.message || "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function removeTrip() {
    if (!trip) return;
    if (!await dialog.confirm("Drop this proposed trip?")) return;
    setBusy(true);
    try {
      await api.del(`/api/planner/trips/${trip.id}`);
      onDeleted();
    } finally {
      setBusy(false);
    }
  }

  const hasChanges =
    trip &&
    local &&
    (local.trip_date !== trip.trip_date ||
      local.suggested_lorry_id !== trip.suggested_lorry_id ||
      local.suggested_driver_user_id !== trip.suggested_driver_user_id ||
      JSON.stringify(local.stops.map((s) => s.doc_no)) !==
        JSON.stringify(trip.payload.stops.map((s) => s.doc_no)));

  const totalRevenue = stops.reduce((s, st) => s + (st.local_total || 0), 0);

  return (
    <Panel
      open={!!trip}
      onClose={onClose}
      title={trip ? `${trip.trip_type.toUpperCase()} · ${trip.warehouse}` : ""}
      subtitle={trip ? formatDate(trip.trip_date) : ""}
      width={520}
      footer={
        trip ? (
          <div className="flex items-center gap-2">
            <button
              onClick={removeTrip}
              className="flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-2 text-[12px] font-semibold text-err hover:border-err/40"
            >
              <Trash2 size={13} /> Delete Trip
            </button>
            <button
              disabled={busy || !hasChanges}
              onClick={save}
              className="ml-auto rounded-md bg-accent px-5 py-2.5 text-[12px] font-bold uppercase tracking-wide text-white disabled:opacity-50"
            >
              {busy ? "Saving…" : "Save Changes"}
            </button>
          </div>
        ) : undefined
      }
    >
      {trip && local && (
        <>
          {/* Route map */}
          <PanelSection title="Route">
            {geoStops.length > 0 || hasChain ? (
              <div>
                <MapView pins={pins} routePolyline={polyline} trail={chainTrail} height={260} />

                {/* Route chain legend for EM/SG */}
                {hasChain && (
                  <div className="mt-2 flex flex-wrap items-center gap-1 text-[10px]">
                    {routeChain!.map((wp, i) => (
                      <span key={i} className="flex items-center gap-1">
                        {i > 0 && <span className="text-ink-muted">→</span>}
                        <span
                          className={cn(
                            "rounded-full px-2 py-0.5 font-semibold",
                            wp.type === "origin" && "bg-ink/10 text-ink",
                            wp.type === "transit" && "bg-accent/10 text-accent",
                            wp.type === "warehouse" && "bg-warning-bg text-warning-text",
                            wp.type === "destination" && "bg-ok/10 text-ok"
                          )}
                        >
                          {wp.label}
                        </span>
                      </span>
                    ))}
                  </div>
                )}

                <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-ink-secondary">
                  {routeMeta && (
                    <>
                      <span className="font-mono font-semibold text-ink">
                        {routeMeta.km} km
                      </span>
                      <span>·</span>
                      <span className="font-mono font-semibold text-ink">
                        {routeMeta.min} min
                      </span>
                    </>
                  )}
                  {geoStops.length < stops.length && (
                    <span className="text-[10px] text-warning-text">
                      {stops.length - geoStops.length} stop
                      {stops.length - geoStops.length === 1 ? "" : "s"} missing coordinates
                    </span>
                  )}
                  <div className="ml-auto flex items-center gap-2">
                    <a
                      href={buildTripGoogleMapsUrl(trip, geoStops)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="rounded border border-border bg-surface px-2 py-1 text-[11px] font-semibold text-ink hover:border-accent/40"
                    >
                      <ExternalLink size={11} className="mr-1 inline" />
                      Google Maps
                    </a>
                    {routeOrigin && geoStops.length > 0 && (
                      <button
                        disabled={routeBusy}
                        onClick={fetchRoute}
                        className="rounded border border-border bg-surface px-2 py-1 text-[11px] font-semibold text-ink disabled:opacity-50"
                      >
                        <RefreshCw size={11} className={cn("mr-1 inline", routeBusy && "animate-spin")} />
                        Refresh
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="rounded-md border border-border bg-paper p-3 text-center text-[11px] text-ink-secondary">
                No geocoded stops to display.
              </div>
            )}
          </PanelSection>

          {/* Trip details */}
          <PanelSection title="Trip Details">
            <FieldRow label="Reason">
              <span className="text-[11px]">{trip.payload.reason}</span>
            </FieldRow>
            <FieldRow label="Revenue" mono>
              {formatCurrency(totalRevenue)}
            </FieldRow>
            <FieldRow label="Stop-to-stop" mono>
              ~{trip.total_distance_km.toFixed(0)}km
            </FieldRow>
            {trip.payload.full_route_km ? (
              <FieldRow label="Full route" mono>
                ~{trip.payload.full_route_km.toFixed(0)}km
              </FieldRow>
            ) : null}

            <div className="mt-3 grid grid-cols-2 gap-2">
              <label className="block">
                <span className="mb-0.5 block text-[9px] font-semibold uppercase tracking-brand text-ink-secondary">
                  Date
                </span>
                <input
                  type="date"
                  value={local.trip_date}
                  onChange={(e) => setLocal({ ...local, trip_date: e.target.value })}
                  className="w-full rounded border border-border bg-paper px-2 py-1.5 text-[12px]"
                />
              </label>
              <label className="block">
                <span className="mb-0.5 block text-[9px] font-semibold uppercase tracking-brand text-ink-secondary">
                  Lorry
                </span>
                <select
                  value={local.suggested_lorry_id ?? ""}
                  onChange={(e) =>
                    setLocal({
                      ...local,
                      suggested_lorry_id: e.target.value
                        ? parseInt(e.target.value, 10)
                        : null,
                    })
                  }
                  className="w-full rounded border border-border bg-paper px-2 py-1.5 text-[12px]"
                >
                  <option value="">Unassigned</option>
                  {lorries.data?.data.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.plate} · {l.size || ""} {l.is_internal ? "" : "(outsource)"}
                    </option>
                  ))}
                </select>
              </label>
              <label className="col-span-2 block">
                <span className="mb-0.5 block text-[9px] font-semibold uppercase tracking-brand text-ink-secondary">
                  Driver
                </span>
                <select
                  value={local.suggested_driver_user_id ?? ""}
                  onChange={(e) =>
                    setLocal({
                      ...local,
                      suggested_driver_user_id: e.target.value
                        ? parseInt(e.target.value, 10)
                        : null,
                    })
                  }
                  className="w-full rounded border border-border bg-paper px-2 py-1.5 text-[12px]"
                >
                  <option value="">Unassigned</option>
                  {drivers.data?.users
                    ?.filter((u: any) => u.status === "active")
                    .map((u: any) => (
                      <option key={u.id} value={u.id}>
                        {u.name || u.email} · {u.role_name}
                      </option>
                    ))}
                </select>
              </label>
            </div>
          </PanelSection>

          {/* Stops (reorderable) */}
          <PanelSection title={`Stops (${stops.length})`}>
            <div className="space-y-1">
              {stops.map((s, i) => (
                <div
                  key={s.doc_no}
                  className="flex items-center gap-1.5 rounded-md border border-border bg-paper px-2 py-1.5"
                >
                  {/* Reorder arrows */}
                  <div className="flex shrink-0 flex-col">
                    <button
                      disabled={i === 0}
                      onClick={() => moveStop(i, -1)}
                      className="text-ink-secondary hover:text-ink disabled:opacity-20"
                      aria-label="Move up"
                    >
                      <ChevronUp size={12} />
                    </button>
                    <button
                      disabled={i === stops.length - 1}
                      onClick={() => moveStop(i, 1)}
                      className="text-ink-secondary hover:text-ink disabled:opacity-20"
                      aria-label="Move down"
                    >
                      <ChevronDown size={12} />
                    </button>
                  </div>

                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-ink text-[9px] font-bold text-paper">
                    {i + 1}
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12px] font-semibold text-ink">
                      {s.debtor_name || s.doc_no}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[10px] text-ink-secondary">
                        {s.doc_no}
                      </span>
                      <span className="font-mono text-[10px] text-ink-secondary">
                        {formatCurrency(s.local_total)}
                      </span>
                    </div>
                  </div>

                  <button
                    onClick={() => removeStop(s.doc_no)}
                    aria-label="Remove stop"
                    className="shrink-0 rounded p-1 text-ink-secondary hover:text-err"
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
            </div>

            <button
              onClick={() => setShowAdd(true)}
              className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border bg-paper py-2 text-[11px] font-semibold text-ink-secondary hover:border-accent/50 hover:text-accent"
            >
              <Plus size={12} /> Add stop
            </button>
          </PanelSection>

          {saveError && (
            <div className="rounded-md border border-err/40 bg-err/5 p-2 text-[12px] text-err">
              {saveError}
            </div>
          )}

          {showAdd && (
            <AddStopModal
              existing={new Set(stops.map((s) => s.doc_no))}
              onClose={() => setShowAdd(false)}
              onPick={(orders) => {
                addStops(orders);
                setShowAdd(false);
              }}
            />
          )}
        </>
      )}
    </Panel>
  );
}

/**
 * Build Google Maps directions URL based on trip type:
 * - WEST: warehouse → customer stops → warehouse
 * - EM (PORT_KLANG): EM warehouse → customer stops → EM warehouse
 * - SG: origin → JB hub transit only
 */
function buildTripGoogleMapsUrl(
  trip: PlannerTrip,
  geoStops: { lat: number; lng: number }[]
): string {
  const points: string[] = [];
  const chain = trip.payload.route_chain as { lat: number; lng: number; type: string }[] | undefined;

  if (trip.warehouse === "PORT_KLANG" && chain?.length) {
    // EM: use the EM warehouse (last chain point with type "warehouse") as origin/destination
    const emWh = [...chain].reverse().find((wp) => wp.type === "warehouse");
    if (emWh) points.push(`${emWh.lat},${emWh.lng}`);
    for (const s of geoStops) points.push(`${s.lat},${s.lng}`);
    if (emWh) points.push(`${emWh.lat},${emWh.lng}`);
  } else if (trip.warehouse === "SG" && chain?.length) {
    // SG: origin → JB hub transit only
    const origin = chain.find((wp) => wp.type === "origin");
    const transit = chain.find((wp) => wp.type === "transit");
    if (origin) points.push(`${origin.lat},${origin.lng}`);
    if (transit) points.push(`${transit.lat},${transit.lng}`);
  } else {
    // WEST: warehouse → stops → warehouse
    if (trip.warehouse_lat != null && trip.warehouse_lng != null) {
      points.push(`${trip.warehouse_lat},${trip.warehouse_lng}`);
    }
    for (const s of geoStops) points.push(`${s.lat},${s.lng}`);
    if (trip.warehouse_lat != null && trip.warehouse_lng != null) {
      points.push(`${trip.warehouse_lat},${trip.warehouse_lng}`);
    }
  }

  return `https://www.google.com/maps/dir/${points.join("/")}`;
}

// ── Add Stop modal ────────────────────────────────────────────────

function AddStopModal({
  existing,
  onClose,
  onPick,
}: {
  existing: Set<string>;
  onClose: () => void;
  onPick: (orders: SalesOrder[]) => void;
}) {
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<Record<string, SalesOrder>>({});
  const orders = useQuery<Paginated<SalesOrder>>(
    () => api.get(`/api/orders${buildQuery({ view: "do", search, per_page: 50 })}`),
    [search]
  );

  function toggle(o: SalesOrder) {
    setPicked((prev) => {
      const copy = { ...prev };
      if (copy[o.doc_no]) delete copy[o.doc_no];
      else copy[o.doc_no] = o;
      return copy;
    });
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-ink/40 backdrop-blur-sm">
      <div className="thin-scroll max-h-[80vh] w-full max-w-lg overflow-y-auto rounded-xl bg-surface p-5 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <div className="font-display text-[15px] font-bold leading-tight tracking-tight text-ink">Add stops</div>
          <button onClick={onClose}>
            <X size={18} className="text-ink-secondary" />
          </button>
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search delivery orders…"
          className="mb-3 w-full rounded-md border border-border bg-paper px-3 py-2 text-[13px]"
          autoFocus
        />
        <div className="thin-scroll max-h-[40vh] overflow-y-auto rounded-md border border-border">
          {orders.loading && (
            <div className="px-3 py-2 text-[12px] text-ink-secondary">Loading…</div>
          )}
          {orders.data?.data
            .filter((o) => !existing.has(o.doc_no))
            .map((o) => {
              const checked = !!picked[o.doc_no];
              return (
                <label
                  key={o.doc_no}
                  className={cn(
                    "flex cursor-pointer items-start gap-2 border-b border-border px-3 py-2 last:border-0",
                    checked && "bg-accent/5"
                  )}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(o)}
                    className="mt-0.5"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-[11px] font-bold text-ink">{o.doc_no}</div>
                    <div className="truncate text-[12px] text-ink">
                      {o.debtor_name || "—"}
                    </div>
                    <div className="text-[10px] text-ink-secondary">
                      {formatCurrency(o.local_total)}
                    </div>
                  </div>
                </label>
              );
            })}
        </div>
        <div className="mt-3 flex items-center gap-2">
          <span className="text-[11px] text-ink-secondary">
            {Object.keys(picked).length} picked
          </span>
          <button
            onClick={() => onPick(Object.values(picked))}
            disabled={!Object.keys(picked).length}
            className="ml-auto rounded-md bg-accent px-4 py-2 text-[12px] font-bold uppercase tracking-wide text-white disabled:opacity-50"
          >
            Add to trip
          </button>
        </div>
      </div>
    </div>
  );
}
