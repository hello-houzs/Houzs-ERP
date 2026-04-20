import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { Breadcrumbs } from "../components/Breadcrumbs";
import { PageHeader } from "../components/Layout";
import { PanelSection, FieldRow } from "../components/Panel";
import { useQuery } from "../hooks/useQuery";
import { api } from "../api/client";
import { formatCurrency, formatDate, cn } from "../lib/utils";
import { RoutePanel } from "./Trips";
import type { TripDetail as TripDetailData } from "../types";

/**
 * Dedicated page for a single trip — replaces the slide-over panel
 * inside Trips. Reuses the RoutePanel exported from Trips.tsx for the
 * map + optimise controls.
 */
export function TripDetail() {
  const { id: idStr } = useParams<{ id: string }>();
  const id = idStr ? parseInt(idStr, 10) : NaN;
  const navigate = useNavigate();

  const detail = useQuery<TripDetailData>(
    () => api.get(`/api/trips/${id}`),
    [id]
  );

  const trip = detail.data?.trip ?? null;
  const stops = detail.data?.stops ?? [];

  return (
    <div>
      <Breadcrumbs
        items={[
          { label: "Logistics", to: "/logistics" },
          { label: "Trips", to: "/logistics?tab=trips" },
          { label: trip?.trip_no || "Loading…" },
        ]}
      />
      <PageHeader
        eyebrow={trip ? `Trip · ${trip.trip_no}` : "Trip"}
        title={trip ? `${trip.warehouse} · ${formatDate(trip.trip_date)}` : "Loading…"}
        description={trip ? `Status ${trip.status.replace("_", " ")} · ${trip.trip_type}` : undefined}
        actions={
          <button
            onClick={() => navigate(-1)}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-[12px] font-semibold text-ink-secondary hover:border-accent/40 hover:text-accent"
          >
            <ArrowLeft size={13} /> Back
          </button>
        }
      />

      {detail.loading && <div className="text-[12px] text-ink-muted">Loading…</div>}
      {detail.error && (
        <div className="rounded-md border border-err/40 bg-err/5 p-4 text-sm text-err">
          {detail.error}
        </div>
      )}

      {detail.data && trip && (
        <div className="space-y-6">
          <PanelSection title="Trip">
            <FieldRow label="Status">{trip.status.replace("_", " ")}</FieldRow>
            <FieldRow label="Driver">{trip.driver_name || "—"}</FieldRow>
            <FieldRow label="Lorry" mono>
              {trip.lorry_plate || "—"}
            </FieldRow>
            <FieldRow label="Type">{trip.trip_type}</FieldRow>
            <FieldRow label="Outsourced">{trip.is_outsourced ? "Yes" : "No"}</FieldRow>
            <FieldRow label="Started">{formatDate(trip.started_at)}</FieldRow>
            <FieldRow label="Completed">{formatDate(trip.completed_at)}</FieldRow>
          </PanelSection>

          <PanelSection title="Logistics">
            <FieldRow label="Revenue" mono>
              {formatCurrency(trip.total_revenue)}
            </FieldRow>
            <FieldRow label="Distance" mono>
              {trip.total_distance_km
                ? `${trip.total_distance_km.toFixed(1)} km`
                : "—"}
            </FieldRow>
            <FieldRow label="GPS pings">{detail.data.locations.length}</FieldRow>
          </PanelSection>

          <PanelSection title="Route">
            <RoutePanel detail={detail.data} onUpdated={() => detail.reload()} />
          </PanelSection>

          <PanelSection title={`Stops (${stops.length})`}>
            <div className="space-y-2">
              {stops.map((s: any, i: number) => (
                <div key={s.id} className="rounded-md border border-border bg-paper p-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-[12px] font-bold text-ink">
                        {i + 1}. {s.debtor_name || s.doc_no}
                      </div>
                      <div className="font-mono text-[10px] text-ink-secondary">
                        {s.doc_no}
                      </div>
                    </div>
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-[9px] font-bold uppercase",
                        s.status === "delivered" && "bg-ok/10 text-ok",
                        s.status === "failed" && "bg-err/10 text-err",
                        s.status === "arrived" && "bg-warning-bg text-warning-text"
                      )}
                    >
                      {s.status}
                    </span>
                  </div>
                  {s.failure_reason && (
                    <div className="mt-1 text-[11px] text-err">{s.failure_reason}</div>
                  )}
                </div>
              ))}
            </div>
          </PanelSection>
        </div>
      )}
    </div>
  );
}
