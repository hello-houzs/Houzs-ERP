import { useEffect, useMemo, useState } from "react";
import { Plus, X, Wand2, RefreshCw, ExternalLink } from "lucide-react";
import { MapView, type MapPin } from "../components/MapView";
import { PageHeader } from "../components/Layout";
import { DataTable } from "../components/DataTable";
import { Pagination } from "../components/Pagination";
import { Panel, PanelSection, FieldRow } from "../components/Panel";
import { StatCard } from "../components/StatCard";
import { DashboardGrid } from "../components/Dashboard";
import { DraftsTab } from "../components/DraftsTab";
import { QueueTab } from "../components/QueueTab";
import { EventsTab } from "../components/EventsTab";
import { TrackingTab } from "../components/TrackingTab";
import { useQuery } from "../hooks/useQuery";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useAuth } from "../auth/AuthContext";
import { api, buildQuery } from "../api/client";
import { formatCurrency, formatDate, cn } from "../lib/utils";
import type {
  Paginated,
  Trip,
  TripDetail,
  Warehouse,
  Lorry,
  TeamMember,
  SalesOrder,
} from "../types";

type TripsTab = "queue" | "drafts" | "live" | "tracking" | "events" | "history";

const TAB_STATUS: Record<TripsTab, string> = {
  queue: "",
  drafts: "",
  live: "assigned,started,in_progress",
  tracking: "",
  events: "",
  history: "completed,cancelled",
};

/**
 * Dispatcher Trips page.
 *
 * Top: stat cards (today / in progress / completed / failed stops).
 * Filters: warehouse, status, date range.
 * DataTable of trips → click opens detail Panel with stops + locations summary.
 * "New Trip" → modal that picks warehouse / date / driver / lorry / orders.
 */
export function Trips() {
  const { can } = useAuth();
  const canPlan = can("planner.run");
  const [tab, setTab] = useLocalStorage<TripsTab>("trips:tab", "queue");
  const [newTripSeed, setNewTripSeed] = useState<SalesOrder[] | null>(null);
  const [warehouse, setWarehouse] = useState<string>("");
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useLocalStorage<number>("pp:trips", 50);
  const [selected, setSelected] = useState<Trip | null>(null);
  const [showNew, setShowNew] = useState(false);

  // The status filter is driven by the active tab (no manual status select).
  const status = TAB_STATUS[tab];

  const list = useQuery<Paginated<Trip>>(
    () =>
      tab === "drafts" || tab === "queue" || tab === "events" || tab === "tracking"
        ? Promise.resolve({ data: [], page: 1, per_page: perPage, total: 0 } as Paginated<Trip>)
        : api.get(
            `/api/trips${buildQuery({
              warehouse,
              status,
              date_from: dateFrom,
              date_to: dateTo,
              search,
              page,
              per_page: perPage,
            })}`
          ),
    [tab, warehouse, status, dateFrom, dateTo, search, page, perPage]
  );

  const detail = useQuery<TripDetail>(
    () =>
      selected
        ? api.get(`/api/trips/${selected.id}`)
        : Promise.resolve(null as any),
    [selected?.id]
  );

  const warehouses = useQuery<{ data: Warehouse[] }>(() => api.get("/api/warehouses"));

  // Lightweight stats from the current page
  const rows = list.data?.data ?? [];
  const today = new Date().toISOString().slice(0, 10);
  const todayCount = rows.filter((t) => t.trip_date === today).length;
  const inProgressCount = rows.filter((t) => t.status === "in_progress" || t.status === "started").length;
  const completedCount = rows.filter((t) => t.status === "completed").length;
  const totalRevenue = rows.reduce((s, t) => s + (t.total_revenue || 0), 0);

  const tabs: { id: TripsTab; label: string; show: boolean }[] = [
    { id: "queue", label: "Queue", show: true },
    { id: "drafts", label: "Drafts", show: canPlan },
    { id: "live", label: "Live & Upcoming", show: true },
    { id: "tracking", label: "Tracking", show: true },
    { id: "events", label: "Events", show: true },
    { id: "history", label: "History", show: true },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Operations · HC Delivery"
        title="Trips"
        description="Plan, assign, and monitor lorry trips."
        actions={
          <>
            {tab !== "events" && tab !== "tracking" && <BackfillButton />}
            {tab !== "drafts" && tab !== "queue" && tab !== "events" && tab !== "tracking" && (
              <button
                onClick={() => {
                  setNewTripSeed(null);
                  setShowNew(true);
                }}
                className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-2 text-[12px] font-bold uppercase tracking-wide text-accent-ink shadow-sm"
              >
                <Plus size={14} /> New Trip
              </button>
            )}
          </>
        }
      />

      {/* Tab strip */}
      <div className="mb-4 flex items-center gap-1 border-b border-border">
        {tabs
          .filter((t) => t.show)
          .map((t) => (
            <button
              key={t.id}
              onClick={() => {
                setTab(t.id);
                setPage(1);
              }}
              className={cn(
                "relative -mb-px border-b-2 px-4 py-2.5 text-[12px] font-semibold transition-colors",
                tab === t.id
                  ? "border-accent text-accent"
                  : "border-transparent text-ink-secondary hover:text-ink"
              )}
            >
              {t.label}
            </button>
          ))}
      </div>

      {tab === "queue" && (
        <QueueTab
          onScheduleSelected={(orders) => {
            setNewTripSeed(orders);
            setShowNew(true);
          }}
        />
      )}

      {tab === "drafts" && <DraftsTab onConfirmed={() => setTab("live")} />}

      {tab === "tracking" && <TrackingTab />}

      {tab === "events" && <EventsTab />}

      {tab !== "drafts" && tab !== "queue" && tab !== "events" && tab !== "tracking" && (
        <>
          <DashboardGrid cols={4}>
            <StatCard label="Today's Trips" value={todayCount.toString()} subtitle="From the current view" />
            <StatCard label="In Progress" value={inProgressCount.toString()} subtitle="Started but not finished" />
            <StatCard label="Completed" value={completedCount.toString()} subtitle="On this page" />
            <StatCard label="Revenue (Page)" value={formatCurrency(totalRevenue, { compact: true })} subtitle="Sum of trip revenue" />
          </DashboardGrid>

      {/* Filter row */}
      <div className="mb-4 mt-4 flex flex-wrap items-end gap-2">
        <Filter label="Warehouse">
          <select
            value={warehouse}
            onChange={(e) => {
              setPage(1);
              setWarehouse(e.target.value);
            }}
            className="rounded-md border border-border bg-surface px-2 py-1.5 text-[12px]"
          >
            <option value="">All</option>
            {warehouses.data?.data.map((w) => (
              <option key={w.code} value={w.code}>
                {w.code} · {w.name}
              </option>
            ))}
          </select>
        </Filter>
        <Filter label="From">
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => {
              setPage(1);
              setDateFrom(e.target.value);
            }}
            className="rounded-md border border-border bg-surface px-2 py-1.5 text-[12px]"
          />
        </Filter>
        <Filter label="To">
          <input
            type="date"
            value={dateTo}
            onChange={(e) => {
              setPage(1);
              setDateTo(e.target.value);
            }}
            className="rounded-md border border-border bg-surface px-2 py-1.5 text-[12px]"
          />
        </Filter>
      </div>

      <DataTable
        tableId="trips"
        exportName="trips"
        search={{
          value: search,
          onChange: (v) => {
            setPage(1);
            setSearch(v);
          },
          placeholder: "Search trip no, plate, driver…",
        }}
        columns={[
          { key: "trip_no", label: "Trip No", render: (r: Trip) => <span className="font-mono">{r.trip_no}</span> },
          { key: "trip_date", label: "Date", render: (r: Trip) => formatDate(r.trip_date) },
          { key: "warehouse", label: "Warehouse", render: (r: Trip) => r.warehouse },
          { key: "driver_name", label: "Driver", render: (r: Trip) => r.driver_name || "—" },
          { key: "lorry_plate", label: "Lorry", render: (r: Trip) => <span className="font-mono">{r.lorry_plate || "—"}</span> },
          { key: "stop_count", label: "Stops", render: (r: Trip) => r.stop_count.toString() },
          { key: "total_revenue", label: "Revenue", render: (r: Trip) => formatCurrency(r.total_revenue) },
          {
            key: "status",
            label: "Status",
            render: (r: Trip) => (
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                  r.status === "completed" && "bg-ok/10 text-ok",
                  r.status === "in_progress" && "bg-warning-bg text-warning-text",
                  r.status === "started" && "bg-warning-bg text-warning-text",
                  r.status === "assigned" && "bg-accent/10 text-accent",
                  r.status === "cancelled" && "bg-ink/10 text-ink-secondary"
                )}
              >
                {r.status.replace("_", " ")}
              </span>
            ),
          },
        ] as any}
        rows={list.data?.data ?? null}
        loading={list.loading}
        error={list.error}
        emptyLabel="No trips"
        getRowKey={(r: Trip) => r.id}
        onRowClick={(r: Trip) => setSelected(r)}
      />

      {list.data && (
        <Pagination
          page={page}
          perPage={perPage}
          total={list.data.total}
          onPageChange={setPage}
          onPerPageChange={(n) => {
            setPerPage(n);
            setPage(1);
          }}
        />
      )}
        </>
      )}

      {/* Detail panel */}
      <Panel
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected?.trip_no || ""}
        subtitle={selected ? `${selected.warehouse} · ${formatDate(selected.trip_date)}` : ""}
        width={520}
      >
        {detail.data && (
          <>
            <PanelSection title="Trip" muted>
              <FieldRow label="Status">{detail.data.trip.status.replace("_", " ")}</FieldRow>
              <FieldRow label="Driver">{detail.data.trip.driver_name || "—"}</FieldRow>
              <FieldRow label="Lorry" mono>
                {detail.data.trip.lorry_plate || "—"}
              </FieldRow>
              <FieldRow label="Type">{detail.data.trip.trip_type}</FieldRow>
              <FieldRow label="Outsourced">{detail.data.trip.is_outsourced ? "Yes" : "No"}</FieldRow>
              <FieldRow label="Started">{formatDate(detail.data.trip.started_at)}</FieldRow>
              <FieldRow label="Completed">{formatDate(detail.data.trip.completed_at)}</FieldRow>
            </PanelSection>

            <PanelSection title="Logistics">
              <FieldRow label="Revenue" mono>
                {formatCurrency(detail.data.trip.total_revenue)}
              </FieldRow>
              <FieldRow label="Distance" mono>
                {detail.data.trip.total_distance_km
                  ? `${detail.data.trip.total_distance_km.toFixed(1)} km`
                  : "—"}
              </FieldRow>
              <FieldRow label="GPS pings">{detail.data.locations.length}</FieldRow>
            </PanelSection>

            <PanelSection title="Route">
              <RoutePanel detail={detail.data} onUpdated={() => detail.reload()} />
            </PanelSection>

            <PanelSection title={`Stops (${detail.data.stops.length})`}>
              <div className="space-y-2">
                {detail.data.stops.map((s: any, i: number) => (
                  <div key={s.id} className="rounded-md border border-border bg-paper p-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-[12px] font-bold text-ink">
                          {i + 1}. {s.debtor_name || s.doc_no}
                        </div>
                        <div className="font-mono text-[10px] text-ink-secondary">{s.doc_no}</div>
                      </div>
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5 text-[9px] font-bold uppercase",
                          s.status === "delivered" && "bg-ok/10 text-ok",
                          s.status === "failed" && "bg-err/10 text-err",
                          s.status === "arrived" && "bg-warning-bg text-warning-text",
                          s.status === "pending" && "bg-ink/10 text-ink-secondary"
                        )}
                      >
                        {s.status}
                      </span>
                    </div>
                    {/* Delivery tracking status */}
                    {s.delivery_status && s.delivery_status !== s.status && (
                      <div className="mt-1 flex items-center gap-1.5">
                        <span className="text-[9px] font-semibold uppercase tracking-brand text-ink-muted">
                          Delivery
                        </span>
                        <span
                          className={cn(
                            "rounded-full px-1.5 py-0.5 text-[8px] font-bold uppercase",
                            s.delivery_status === "delivered" && "bg-ok/10 text-ok",
                            s.delivery_status === "failed" && "bg-err/10 text-err",
                            s.delivery_status === "out_for_delivery" && "bg-accent/10 text-accent",
                            s.delivery_status === "in_transit" && "bg-warning-bg text-warning-text",
                            s.delivery_status === "at_warehouse" && "bg-warning-bg text-warning-text",
                            s.delivery_status === "shipped" && "bg-accent/10 text-accent",
                            s.delivery_status === "pending_shipout" && "bg-accent/10 text-accent",
                            s.delivery_status === "do_ready" && "bg-ink/10 text-ink-secondary"
                          )}
                        >
                          {s.delivery_status.replace(/_/g, " ")}
                        </span>
                        {s.est_delivery_date && (
                          <span className="text-[9px] text-ink-secondary">
                            Est. {formatDate(s.est_delivery_date)}
                          </span>
                        )}
                      </div>
                    )}
                    {s.recipient_name && (
                      <div className="mt-1 text-[11px] text-ink-secondary">
                        Received by{" "}
                        <span className="font-semibold text-ink">{s.recipient_name}</span>
                      </div>
                    )}
                    {s.failure_reason && (
                      <div className="mt-1 text-[11px] text-err">{s.failure_reason}</div>
                    )}
                  </div>
                ))}
              </div>
            </PanelSection>
          </>
        )}
      </Panel>

      {showNew && (
        <NewTripDialog
          initialPicked={newTripSeed}
          onClose={() => {
            setShowNew(false);
            setNewTripSeed(null);
          }}
          onCreated={() => {
            setShowNew(false);
            setNewTripSeed(null);
            setTab("live");
            list.reload();
          }}
        />
      )}
    </div>
  );
}

function Filter({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[9px] font-semibold uppercase tracking-brand text-ink-secondary">
        {label}
      </span>
      {children}
    </label>
  );
}

// ── New Trip dialog ────────────────────────────────────────────────

function NewTripDialog({
  onClose,
  onCreated,
  initialPicked,
}: {
  onClose: () => void;
  onCreated: () => void;
  initialPicked?: SalesOrder[] | null;
}) {
  // If the dispatcher came from the Queue tab with selected orders,
  // pre-pick those AND default the warehouse to the most common one in
  // the selection so the Lorries dropdown is meaningful immediately.
  const seedWarehouse = useMemo(() => {
    if (!initialPicked || !initialPicked.length) return "KL";
    const counts: Record<string, number> = {};
    for (const o of initialPicked) {
      const w = (o as any).warehouse;
      if (w) counts[w] = (counts[w] || 0) + 1;
    }
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    return top?.[0] || "KL";
  }, [initialPicked]);

  const [warehouse, setWarehouse] = useState(seedWarehouse);
  const [tripDate, setTripDate] = useState(new Date().toISOString().slice(0, 10));
  const [tripType, setTripType] = useState<string>("delivery");
  const [lorryId, setLorryId] = useState<number | "">("");
  const [driverId, setDriverId] = useState<number | "">("");
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<Record<string, SalesOrder>>(() => {
    if (!initialPicked) return {};
    const map: Record<string, SalesOrder> = {};
    for (const o of initialPicked) map[o.doc_no] = o;
    return map;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const warehouses = useQuery<{ data: Warehouse[] }>(() => api.get("/api/warehouses"));
  const lorries = useQuery<{ data: Lorry[] }>(
    () => api.get(`/api/lorries${buildQuery({ warehouse })}`),
    [warehouse]
  );
  const drivers = useQuery<{ users: TeamMember[] }>(() => api.get<{ users: TeamMember[] }>("/api/users").catch(() => ({ users: [] as TeamMember[] })));

  // Use the existing delivery-orders feed; dispatcher picks from these.
  const orders = useQuery<Paginated<SalesOrder>>(
    () => api.get(`/api/orders${buildQuery({ view: "do", search, per_page: 30 })}`),
    [search]
  );

  const pickedList = Object.values(picked);
  const totalRevenue = pickedList.reduce((s, o) => s + (o.local_total || 0), 0);

  function toggle(o: SalesOrder) {
    setPicked((prev) => {
      const copy = { ...prev };
      if (copy[o.doc_no]) delete copy[o.doc_no];
      else copy[o.doc_no] = o;
      return copy;
    });
  }

  async function submit() {
    setError(null);
    if (!pickedList.length) {
      setError("Pick at least one order.");
      return;
    }
    setBusy(true);
    try {
      await api.post("/api/trips", {
        warehouse,
        trip_date: tripDate,
        trip_type: tripType,
        lorry_id: lorryId || null,
        driver_user_id: driverId || null,
        stops: pickedList.map((o, i) => ({
          doc_no: o.doc_no,
          sequence: i + 1,
          stop_type: tripType === "setup" ? "setup" : "delivery",
        })),
      });
      onCreated();
    } catch (e: any) {
      setError(e?.message || "Failed to create trip");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-end bg-ink/40 backdrop-blur-sm">
      <div className="thin-scroll flex w-full max-w-[640px] flex-col overflow-y-auto bg-surface shadow-slab">
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-brand text-accent">
              Schedule
            </div>
            <h2 className="font-display text-[18px] font-extrabold tracking-tight text-ink">
              New Trip
            </h2>
          </div>
          <button onClick={onClose} className="text-ink-secondary hover:text-ink">
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4 px-6 py-5">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Warehouse">
              <select
                value={warehouse}
                onChange={(e) => setWarehouse(e.target.value)}
                className="w-full rounded-md border border-border bg-paper px-3 py-2 text-[13px]"
              >
                {warehouses.data?.data.map((w) => (
                  <option key={w.code} value={w.code}>
                    {w.code} · {w.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Date">
              <input
                type="date"
                value={tripDate}
                onChange={(e) => setTripDate(e.target.value)}
                className="w-full rounded-md border border-border bg-paper px-3 py-2 text-[13px]"
              />
            </Field>
            <Field label="Trip type">
              <select
                value={tripType}
                onChange={(e) => setTripType(e.target.value)}
                className="w-full rounded-md border border-border bg-paper px-3 py-2 text-[13px]"
              >
                <option value="delivery">Delivery</option>
                <option value="setup">Setup</option>
                <option value="dismantle">Dismantle</option>
                <option value="sg">SG (JB hub)</option>
                <option value="mixed">Mixed</option>
              </select>
            </Field>
            <Field label="Lorry">
              <select
                value={lorryId}
                onChange={(e) => setLorryId(e.target.value ? parseInt(e.target.value, 10) : "")}
                className="w-full rounded-md border border-border bg-paper px-3 py-2 text-[13px]"
              >
                <option value="">Unassigned</option>
                {lorries.data?.data.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.plate} · {l.size || ""} {l.is_internal ? "" : "(outsource)"}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Driver">
              <select
                value={driverId}
                onChange={(e) => setDriverId(e.target.value ? parseInt(e.target.value, 10) : "")}
                className="col-span-2 w-full rounded-md border border-border bg-paper px-3 py-2 text-[13px]"
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
            </Field>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-brand text-ink-secondary">
                Orders
              </span>
              <span className="text-[11px] text-ink-secondary">
                {pickedList.length} picked · {formatCurrency(totalRevenue)}
              </span>
            </div>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search delivery orders…"
              className="mb-2 w-full rounded-md border border-border bg-paper px-3 py-2 text-[13px]"
            />
            <div className="thin-scroll max-h-[360px] overflow-y-auto rounded-md border border-border">
              {orders.loading && (
                <div className="px-3 py-2 text-[12px] text-ink-secondary">Loading…</div>
              )}
              {orders.data?.data.map((o) => {
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
                      <div className="truncate text-[12px] text-ink">{o.debtor_name || "—"}</div>
                      <div className="truncate text-[10px] text-ink-secondary">
                        {o.region} · {formatCurrency(o.local_total)}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>

          {error && (
            <div className="rounded-md border border-err/40 bg-err/5 p-2 text-[12px] text-err">
              {error}
            </div>
          )}
        </div>

        <div className="sticky bottom-0 mt-auto flex items-center gap-2 border-t border-border bg-surface px-6 py-4">
          <button
            onClick={onClose}
            className="rounded-md border border-border bg-surface px-4 py-2 text-[12px] font-semibold text-ink"
          >
            Cancel
          </button>
          <button
            disabled={busy}
            onClick={submit}
            className="ml-auto rounded-md bg-accent px-5 py-2.5 text-[12px] font-bold uppercase tracking-wide text-accent-ink disabled:opacity-50"
          >
            {busy ? "Creating…" : "Create Trip"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-brand text-ink-secondary">
        {label}
      </span>
      {children}
    </label>
  );
}

// ── Backfill button ───────────────────────────────────────────────

function BackfillButton() {
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<{ geocoded: number; remaining: number } | null>(null);

  async function run() {
    setBusy(true);
    try {
      const r = await api.post<{ geocoded: number; remaining: number }>(
        "/api/maps/backfill-orders",
        { limit: 100 }
      );
      setLast({ geocoded: r.geocoded, remaining: r.remaining });
    } catch (e: any) {
      alert(e?.message || "Backfill failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={run}
      disabled={busy}
      title={
        last
          ? `Last run: +${last.geocoded} geocoded · ${last.remaining} remaining`
          : "Geocode delivery addresses for the route map"
      }
      className="flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-2 text-[12px] font-semibold text-ink hover:border-accent/50 disabled:opacity-50"
    >
      <RefreshCw size={13} className={busy ? "animate-spin" : ""} />
      {busy ? "Geocoding…" : last ? `Geocode (${last.remaining} left)` : "Geocode addresses"}
    </button>
  );
}

// ── Route panel inside trip detail ────────────────────────────────

function RoutePanel({
  detail,
  onUpdated,
}: {
  detail: TripDetail;
  onUpdated: () => void;
}) {
  const trip = detail.trip;
  const stops = detail.stops;

  // Stops with coordinates only — orphans get listed below the map.
  const geoStops = useMemo(
    () =>
      stops
        .map((s, i) => ({ ...s, original_index: i }))
        .filter((s) => s.stop_lat != null && s.stop_lng != null),
    [stops]
  );
  const missingCount = stops.length - geoStops.length;

  const warehouseLatLng =
    trip.warehouse_lat != null && trip.warehouse_lng != null
      ? { lat: trip.warehouse_lat, lng: trip.warehouse_lng }
      : null;

  // Pins: warehouse + every geocoded stop in current sequence order.
  const pins: MapPin[] = useMemo(() => {
    const out: MapPin[] = [];
    if (warehouseLatLng) {
      out.push({
        id: "wh",
        lat: warehouseLatLng.lat,
        lng: warehouseLatLng.lng,
        label: "W",
        tone: "warehouse",
        popup: trip.warehouse_name || trip.warehouse,
      });
    }
    geoStops.forEach((s, i) => {
      out.push({
        id: s.id,
        lat: s.stop_lat as number,
        lng: s.stop_lng as number,
        label: i + 1,
        tone:
          s.status === "delivered"
            ? "done"
            : s.status === "failed"
            ? "failed"
            : "default",
        popup: `${i + 1}. ${s.debtor_name || s.doc_no}`,
      });
    });
    return out;
  }, [warehouseLatLng, geoStops, trip.warehouse, trip.warehouse_name]);

  const trail = useMemo(
    () => detail.locations.map((l) => ({ lat: l.lat, lng: l.lng })),
    [detail.locations]
  );

  // Live state for the planned route polyline + metrics
  const [polyline, setPolyline] = useState<string | null>(null);
  const [routeMeta, setRouteMeta] = useState<{ km: number; min: number } | null>(null);
  const [routeBusy, setRouteBusy] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);

  async function fetchRoute(optimize: boolean) {
    if (!warehouseLatLng) {
      setRouteError("Warehouse has no coordinates.");
      return;
    }
    if (geoStops.length < 1) {
      setRouteError("No geocoded stops on this trip.");
      return;
    }
    setRouteBusy(true);
    setRouteError(null);
    try {
      const waypoints = geoStops.map((s) => ({
        lat: s.stop_lat as number,
        lng: s.stop_lng as number,
      }));
      // For Directions, the destination is the warehouse (round trip).
      // The waypoints array is the stops; with optimize=true Google
      // returns the best order via waypoint_order.
      const res = await api.post<any>("/api/maps/directions", {
        origin: warehouseLatLng,
        destination: warehouseLatLng,
        waypoints,
        optimize,
      });
      setPolyline(res.polyline);
      setRouteMeta({
        km: Math.round((res.total_distance_m / 1000) * 10) / 10,
        min: Math.round(res.total_duration_s / 60),
      });

      if (optimize && Array.isArray(res.waypoint_order) && res.waypoint_order.length) {
        // Reorder stops on the server to match Google's optimized order.
        const orderedIds = res.waypoint_order.map((idx: number) => geoStops[idx].id);
        await api.post(`/api/trips/${trip.id}/reorder`, { stop_ids: orderedIds });
        onUpdated();
      }
    } catch (e: any) {
      setRouteError(e?.message || "Route lookup failed");
    } finally {
      setRouteBusy(false);
    }
  }

  // Auto-load route once when the panel opens (read-only, no optimize).
  useEffect(() => {
    if (!polyline && warehouseLatLng && geoStops.length > 0) {
      fetchRoute(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trip.id]);

  if (!warehouseLatLng) {
    return (
      <div className="rounded-md border border-warning-text/30 bg-warning-bg/40 p-3 text-[12px] text-warning-text">
        This trip's warehouse has no coordinates yet.
      </div>
    );
  }

  return (
    <div>
      <MapView pins={pins} routePolyline={polyline} trail={trail} height={280} />

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
        {missingCount > 0 && (
          <span className="text-warning-text">
            {missingCount} stop{missingCount === 1 ? "" : "s"} missing coordinates
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <a
            href={buildGoogleMapsUrl(warehouseLatLng, geoStops.map((s) => ({ lat: s.stop_lat as number, lng: s.stop_lng as number })))}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded border border-border bg-surface px-2 py-1 text-[11px] font-semibold text-ink hover:border-accent/40"
          >
            <ExternalLink size={11} className="mr-1 inline" />
            Google Maps
          </a>
          <button
            disabled={routeBusy}
            onClick={() => fetchRoute(false)}
            className="rounded border border-border bg-surface px-2 py-1 text-[11px] font-semibold text-ink disabled:opacity-50"
          >
            <RefreshCw size={11} className={cn("mr-1 inline", routeBusy && "animate-spin")} />
            Refresh
          </button>
          <button
            disabled={routeBusy || geoStops.length < 2}
            onClick={() => fetchRoute(true)}
            className="rounded bg-accent px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-accent-ink disabled:opacity-50"
          >
            <Wand2 size={11} className="mr-1 inline" />
            Optimize
          </button>
        </div>
      </div>

      {routeError && (
        <div className="mt-2 rounded-md border border-err/40 bg-err/5 p-2 text-[11px] text-err">
          {routeError}
        </div>
      )}
    </div>
  );
}

/** Build a Google Maps directions URL: warehouse → stops → warehouse. */
function buildGoogleMapsUrl(
  warehouse: { lat: number; lng: number } | null,
  stops: { lat: number; lng: number }[]
): string {
  const points: string[] = [];
  if (warehouse) points.push(`${warehouse.lat},${warehouse.lng}`);
  for (const s of stops) points.push(`${s.lat},${s.lng}`);
  if (warehouse) points.push(`${warehouse.lat},${warehouse.lng}`);
  return `https://www.google.com/maps/dir/${points.join("/")}`;
}
