import { Link } from "react-router-dom";
import { Truck, MapPin, ChevronRight, Package } from "lucide-react";
import { useQuery } from "../hooks/useQuery";
import { api } from "../api/client";
import { formatDate, cn } from "../lib/utils";
import { EmptyState } from "../components/EmptyState";
import type { Trip } from "../types";

/**
 * Driver landing page — mobile first. Lists all trips assigned to the
 * current driver from today onwards that are not yet completed/cancelled.
 *
 * Tap a trip → /driver/trips/:id (the active-trip view).
 */
export function DriverHome() {
  const trips = useQuery<{ data: Trip[] }>(() => api.get("/api/trips/mine/today"));

  return (
    <div className="px-4 py-5">
      <div className="mb-5">
        <div className="text-[10px] font-semibold uppercase tracking-brand text-accent">
          Today
        </div>
        <h1 className="font-display text-[19px] font-extrabold leading-tight tracking-tight text-ink sm:text-[26px] lg:text-[28px]">
          Your Trips
        </h1>
        <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary sm:text-sm">
          Tap a trip to start delivering.
        </p>
      </div>

      {trips.loading && <div className="text-sm text-ink-secondary">Loading…</div>}
      {trips.error && (
        <div className="rounded-md border border-err/40 bg-err/5 p-3 text-sm text-err">
          {trips.error}
        </div>
      )}

      {trips.data && trips.data.data.length === 0 && (
        <EmptyState
          icon={<Truck size={28} />}
          message="No trips assigned"
          description="You're all caught up. New trips will appear here once dispatch assigns them."
        />
      )}

      <div className="space-y-3">
        {trips.data?.data.map((t) => (
          <TripCard key={t.id} trip={t} />
        ))}
      </div>
    </div>
  );
}

function TripCard({ trip }: { trip: Trip }) {
  const total = trip.stop_count_actual ?? trip.stop_count ?? 0;
  const done = trip.stops_done ?? 0;
  const isToday = trip.trip_date === new Date().toISOString().slice(0, 10);
  const statusLabel: Record<string, string> = {
    assigned: "Assigned",
    started: "Started",
    in_progress: "In progress",
    completed: "Completed",
    cancelled: "Cancelled",
  };

  return (
    <Link
      to={`/driver/trips/${trip.id}`}
      className="block rounded-xl border border-border bg-surface p-4 shadow-sm transition-colors active:bg-paper"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                trip.status === "assigned" && "bg-accent/10 text-accent",
                trip.status === "started" && "bg-warning-bg text-warning-text",
                trip.status === "in_progress" && "bg-warning-bg text-warning-text"
              )}
            >
              {statusLabel[trip.status] || trip.status}
            </span>
            {isToday && (
              <span className="rounded-full bg-ink/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink">
                Today
              </span>
            )}
          </div>
          <div className="mt-1.5 font-mono text-[13px] font-bold text-ink">
            {trip.trip_no}
          </div>
          <div className="mt-1 flex items-center gap-2 text-[12px] text-ink-secondary">
            <MapPin size={13} />
            <span>{trip.warehouse_name || trip.warehouse}</span>
            <span className="text-border">·</span>
            <span>{formatDate(trip.trip_date)}</span>
          </div>
          {trip.lorry_plate && (
            <div className="mt-1 flex items-center gap-2 text-[12px] text-ink-secondary">
              <Truck size={13} />
              <span className="font-mono">{trip.lorry_plate}</span>
              {trip.lorry_size && <span className="text-border">· {trip.lorry_size}</span>}
            </div>
          )}
        </div>
        <ChevronRight size={20} className="mt-1 shrink-0 text-ink-secondary" />
      </div>

      <div className="mt-3 flex items-center justify-between border-t border-border pt-3">
        <div className="flex items-center gap-2 text-[12px]">
          <Package size={13} className="text-ink-secondary" />
          <span className="font-semibold text-ink">
            {done}/{total}
          </span>
          <span className="text-ink-secondary">stops</span>
        </div>
        <div className="h-1.5 w-24 overflow-hidden rounded-full bg-border">
          <div
            className="h-full bg-accent"
            style={{ width: total ? `${(done / total) * 100}%` : "0%" }}
          />
        </div>
      </div>
    </Link>
  );
}
