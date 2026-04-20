import { useParams } from "react-router-dom";
import {
  DetailLayout,
  DetailGrid,
  DetailMain,
  DetailAside,
  Section,
  StatStrip,
  DefinitionList,
} from "../components/DetailLayout";
import { useQuery } from "../hooks/useQuery";
import { api } from "../api/client";
import { formatCurrency, formatDate, cn } from "../lib/utils";
import { RoutePanel } from "./Trips";
import type { TripDetail as TripDetailData } from "../types";

const STOP_STATUS_TONE: Record<string, string> = {
  delivered: "bg-synced/15 text-synced",
  failed: "bg-err/10 text-err",
  arrived: "bg-warning-bg text-warning-text",
  pending: "bg-bg text-ink-muted",
};

const DELIVERY_STATUS_TONE: Record<string, string> = {
  delivered: "bg-synced/15 text-synced",
  failed: "bg-err/10 text-err",
  out_for_delivery: "bg-accent/15 text-accent",
  in_transit: "bg-warning-bg text-warning-text",
  at_warehouse: "bg-warning-bg text-warning-text",
  shipped: "bg-accent/15 text-accent",
  pending_shipout: "bg-accent/15 text-accent",
  do_ready: "bg-bg text-ink-secondary",
};

/**
 * Dedicated page for a single trip. Reuses RoutePanel from Trips.tsx
 * for the map + optimise controls.
 */
export function TripDetail() {
  const { id: idStr } = useParams<{ id: string }>();
  const id = idStr ? parseInt(idStr, 10) : NaN;

  const detail = useQuery<TripDetailData>(
    () => api.get(`/api/trips/${id}`),
    [id]
  );

  const trip = detail.data?.trip ?? null;
  const stops = detail.data?.stops ?? [];

  return (
    <DetailLayout
      breadcrumbs={[
        { label: "Logistics", to: "/logistics" },
        { label: "Trips", to: "/logistics?tab=trips" },
        { label: trip?.trip_no || "Loading…" },
      ]}
      eyebrow={trip ? `Trip · ${trip.trip_no}` : "Trip"}
      title={trip ? `${trip.warehouse} · ${formatDate(trip.trip_date)}` : "Loading…"}
      description={
        trip
          ? `${trip.status.replace("_", " ")} · ${trip.trip_type}${trip.driver_name ? ` · ${trip.driver_name}` : ""}${trip.lorry_plate ? ` · ${trip.lorry_plate}` : ""}`
          : undefined
      }
      backTo="/logistics?tab=trips"
      loading={detail.loading && !trip}
      error={detail.error}
    >
      {trip && detail.data && (
        <>
          <StatStrip
            items={[
              {
                label: "Revenue",
                value: formatCurrency(trip.total_revenue),
                tone: "ok",
              },
              {
                label: "Distance",
                value: trip.total_distance_km
                  ? `${trip.total_distance_km.toFixed(1)} km`
                  : "—",
              },
              { label: "Stops", value: stops.length.toLocaleString() },
              {
                label: "GPS pings",
                value: detail.data.locations.length.toLocaleString(),
              },
            ]}
          />

          <div className="mt-5">
            <DetailGrid>
              <DetailMain>
                <Section title="Route" dense>
                  <div className="p-4">
                    <RoutePanel
                      detail={detail.data}
                      onUpdated={() => detail.reload()}
                    />
                  </div>
                </Section>

                <Section title={`Stops · ${stops.length}`}>
                  <div className="space-y-2">
                    {stops.map((s: any, i: number) => (
                      <div
                        key={s.id}
                        className="rounded-md border border-border bg-bg/40 p-3"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="text-[12.5px] font-bold text-ink">
                              <span className="font-mono text-[10px] text-ink-muted">
                                {String(i + 1).padStart(2, "0")}
                              </span>
                              <span className="ml-2">
                                {s.debtor_name || s.doc_no}
                              </span>
                            </div>
                            <div className="font-mono text-[10.5px] text-ink-secondary">
                              {s.doc_no}
                            </div>
                          </div>
                          <span
                            className={cn(
                              "rounded-full px-2 py-0.5 font-mono text-[9.5px] font-bold uppercase tracking-wider",
                              STOP_STATUS_TONE[s.status] ||
                                "bg-bg text-ink-muted"
                            )}
                          >
                            {s.status}
                          </span>
                        </div>
                        {s.delivery_status &&
                          s.delivery_status !== s.status && (
                            <div className="mt-1.5 flex items-center gap-1.5">
                              <span className="font-mono text-[9px] font-semibold uppercase tracking-brand text-ink-muted">
                                Delivery
                              </span>
                              <span
                                className={cn(
                                  "rounded-full px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider",
                                  DELIVERY_STATUS_TONE[s.delivery_status] ||
                                    "bg-bg text-ink-muted"
                                )}
                              >
                                {s.delivery_status.replace(/_/g, " ")}
                              </span>
                              {s.est_delivery_date && (
                                <span className="text-[10.5px] text-ink-muted">
                                  Est. {formatDate(s.est_delivery_date)}
                                </span>
                              )}
                            </div>
                          )}
                        {s.recipient_name && (
                          <div className="mt-1 text-[11px] text-ink-secondary">
                            Received by{" "}
                            <span className="font-semibold text-ink">
                              {s.recipient_name}
                            </span>
                          </div>
                        )}
                        {s.failure_reason && (
                          <div className="mt-1 text-[11px] text-err">
                            {s.failure_reason}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </Section>
              </DetailMain>

              <DetailAside>
                <Section title="Trip">
                  <DefinitionList
                    items={[
                      { label: "Trip No", value: trip.trip_no, mono: true },
                      { label: "Date", value: formatDate(trip.trip_date) },
                      { label: "Status", value: trip.status.replace("_", " ") },
                      { label: "Type", value: trip.trip_type },
                      {
                        label: "Outsourced",
                        value: trip.is_outsourced ? "Yes" : "No",
                      },
                      { label: "Driver", value: trip.driver_name },
                      { label: "Lorry", value: trip.lorry_plate, mono: true },
                      {
                        label: "Started",
                        value: formatDate(trip.started_at),
                      },
                      {
                        label: "Completed",
                        value: formatDate(trip.completed_at),
                      },
                    ]}
                  />
                </Section>

                <Section title="Logistics">
                  <DefinitionList
                    items={[
                      {
                        label: "Revenue",
                        value: formatCurrency(trip.total_revenue),
                        mono: true,
                      },
                      {
                        label: "Distance",
                        value: trip.total_distance_km
                          ? `${trip.total_distance_km.toFixed(1)} km`
                          : "—",
                        mono: true,
                      },
                      {
                        label: "Warehouse",
                        value: trip.warehouse_name || trip.warehouse,
                      },
                    ]}
                  />
                </Section>
              </DetailAside>
            </DetailGrid>
          </div>
        </>
      )}
    </DetailLayout>
  );
}
