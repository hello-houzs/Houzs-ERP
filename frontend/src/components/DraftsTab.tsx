import { useState } from "react";
import {
  Sparkles,
  Trash2,
  Check,
  AlertTriangle,
  X,
  Plus,
  Truck,
} from "lucide-react";
import { StatCard } from "./StatCard";
import { DashboardGrid } from "./Dashboard";
import { useQuery } from "../hooks/useQuery";
import { api, buildQuery } from "../api/client";
import { formatCurrency, formatDate, cn } from "../lib/utils";
import type {
  PlannerProposal,
  PlannerTrip,
  Lorry,
  TeamMember,
  Paginated,
  SalesOrder,
} from "../types";

/**
 * Drafts tab — the scheduling agent UI. Lives inside the Trips page so
 * the dispatcher can plan, edit, and confirm without leaving the trip
 * workspace. The action row (horizon picker / Generate / Discard /
 * Confirm All) is rendered inline at the top so the parent page only
 * has to render <DraftsTab onConfirmed={refreshLive} />.
 */
export function DraftsTab({ onConfirmed }: { onConfirmed?: () => void }) {
  const [horizon, setHorizon] = useState(7);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = useQuery<{ proposal: PlannerProposal | null; trips?: PlannerTrip[] }>(
    () => api.get("/api/planner/current")
  );

  async function generate() {
    if (
      !window.confirm(
        `Generate proposals for the next ${horizon} days? Any current draft will be discarded.`
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/planner/generate", { horizon_days: horizon });
      current.reload();
    } catch (e: any) {
      setError(e?.message || "Generation failed");
    } finally {
      setBusy(false);
    }
  }

  async function discard() {
    if (!current.data?.proposal) return;
    if (!window.confirm("Discard the current draft?")) return;
    setBusy(true);
    try {
      await api.post(`/api/planner/${current.data.proposal.id}/discard`);
      current.reload();
    } finally {
      setBusy(false);
    }
  }

  async function confirmAll() {
    if (!current.data?.proposal) return;
    if (
      !window.confirm(
        `Materialize ${
          current.data.proposal.summary?.total_trips ?? 0
        } trips? They'll appear under Live & Upcoming and drivers will see them.`
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/planner/${current.data.proposal.id}/confirm`);
      current.reload();
      onConfirmed?.();
    } catch (e: any) {
      setError(e?.message || "Confirm failed");
    } finally {
      setBusy(false);
    }
  }

  const proposal = current.data?.proposal;
  const trips = current.data?.trips ?? [];
  const blocked = trips.filter((t) => t.trip_type === "blocked");
  const planned = trips.filter((t) => t.trip_type !== "blocked");

  const grouped: Record<string, PlannerTrip[]> = {};
  for (const t of planned) {
    (grouped[t.trip_date] ||= []).push(t);
  }
  const dates = Object.keys(grouped).sort();

  return (
    <div>
      {/* Inline action row */}
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
          className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-2 text-[12px] font-bold uppercase tracking-wide text-accent-ink shadow-sm disabled:opacity-50"
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
              <button
                onClick={discard}
                className="flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-2 text-[12px] font-semibold text-ink hover:border-err/40"
              >
                <Trash2 size={13} /> Discard
              </button>
              <button
                disabled={busy || planned.length === 0}
                onClick={confirmAll}
                className="flex items-center gap-1.5 rounded-md bg-ok px-4 py-2 text-[12px] font-bold uppercase tracking-wide text-white disabled:opacity-50"
              >
                <Check size={14} /> Confirm All
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

      {current.loading && (
        <div className="text-sm text-ink-secondary">Loading…</div>
      )}

      {!current.loading && !proposal && (
        <div className="rounded-lg border border-dashed border-border bg-surface p-10 text-center">
          <Sparkles size={28} className="mx-auto mb-3 text-accent" />
          <div className="text-[14px] font-bold text-ink">No draft proposal</div>
          <div className="mt-1 text-[12px] text-ink-secondary">
            Click <span className="font-semibold">Generate</span> to ask the agent to plan trips for the next {horizon} days.
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
              <div className="space-y-3">
                {grouped[d].map((t) => (
                  <ProposalCard key={t.id} trip={t} onChanged={() => current.reload()} />
                ))}
              </div>
            </div>
          ))}

          {blocked.length > 0 && (
            <div className="mt-8 rounded-lg border border-warning-text/30 bg-warning-bg/30 p-4">
              <div className="mb-2 flex items-center gap-2">
                <AlertTriangle size={16} className="text-warning-text" />
                <div className="text-[12px] font-bold text-warning-text">
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
    </div>
  );
}

// ── Single proposal card ───────────────────────────────────────────

function ProposalCard({
  trip,
  onChanged,
}: {
  trip: PlannerTrip;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showAdd, setShowAdd] = useState(false);

  const [local, setLocal] = useState({
    trip_date: trip.trip_date,
    suggested_lorry_id: trip.suggested_lorry_id,
    suggested_driver_user_id: trip.suggested_driver_user_id,
    stops: trip.payload.stops,
  });

  const lorries = useQuery<{ data: Lorry[] }>(
    () => api.get(`/api/lorries${buildQuery({ warehouse: trip.warehouse })}`),
    [trip.warehouse]
  );
  const drivers = useQuery<{ users: TeamMember[] }>(() => api.get("/api/users"));

  async function save() {
    setBusy(true);
    try {
      await api.patch(`/api/planner/trips/${trip.id}`, {
        trip_date: local.trip_date,
        suggested_lorry_id: local.suggested_lorry_id,
        suggested_driver_user_id: local.suggested_driver_user_id,
        stops: local.stops.map((s, i) => ({ doc_no: s.doc_no, sequence: i + 1 })),
      });
      setEditing(false);
      onChanged();
    } catch (e: any) {
      alert(e?.message || "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function removeTrip() {
    if (!window.confirm("Drop this proposed trip?")) return;
    setBusy(true);
    try {
      await api.del(`/api/planner/trips/${trip.id}`);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  function removeStop(docNo: string) {
    setLocal((prev) => ({
      ...prev,
      stops: prev.stops.filter((s) => s.doc_no !== docNo),
    }));
  }

  function addStops(picked: SalesOrder[]) {
    setLocal((prev) => ({
      ...prev,
      stops: [
        ...prev.stops,
        ...picked.map((o, i) => ({
          doc_no: o.doc_no,
          sequence: prev.stops.length + i + 1,
          debtor_name: o.debtor_name,
          lat: 0,
          lng: 0,
          local_total: o.local_total,
          expiry_date: o.expiry_date || "",
        })),
      ],
    }));
  }

  const lorryLabel = trip.lorry_plate
    ? `${trip.lorry_plate}${trip.lorry_size ? ` · ${trip.lorry_size}` : ""}${
        trip.lorry_is_internal ? "" : " (outsource)"
      }`
    : "Unassigned";

  return (
    <div
      className={cn(
        "rounded-xl border bg-surface p-4 shadow-sm",
        trip.is_outsourced ? "border-warning-text/40" : "border-border"
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
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

          {!editing ? (
            <div className="mt-1 flex flex-wrap items-center gap-3 text-[11px] text-ink-secondary">
              <span>
                <Truck size={11} className="mr-1 inline" />
                {lorryLabel}
              </span>
              <span>· Driver: {trip.driver_name || "—"}</span>
            </div>
          ) : (
            <div className="mt-2 grid grid-cols-2 gap-2">
              <label className="block">
                <span className="mb-0.5 block text-[9px] font-semibold uppercase tracking-brand text-ink-secondary">
                  Date
                </span>
                <input
                  type="date"
                  value={local.trip_date}
                  onChange={(e) =>
                    setLocal((p) => ({ ...p, trip_date: e.target.value }))
                  }
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
                    setLocal((p) => ({
                      ...p,
                      suggested_lorry_id: e.target.value ? parseInt(e.target.value, 10) : null,
                    }))
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
                    setLocal((p) => ({
                      ...p,
                      suggested_driver_user_id: e.target.value
                        ? parseInt(e.target.value, 10)
                        : null,
                    }))
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
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {!editing ? (
            <>
              <button
                onClick={() => setEditing(true)}
                className="rounded-md border border-border bg-surface px-2 py-1 text-[11px] font-semibold text-ink hover:border-accent/40"
              >
                Edit
              </button>
              <button
                onClick={removeTrip}
                aria-label="Remove"
                className="rounded-md border border-border bg-surface p-1.5 text-ink-secondary hover:border-err/40 hover:text-err"
              >
                <Trash2 size={13} />
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => {
                  setEditing(false);
                  setLocal({
                    trip_date: trip.trip_date,
                    suggested_lorry_id: trip.suggested_lorry_id,
                    suggested_driver_user_id: trip.suggested_driver_user_id,
                    stops: trip.payload.stops,
                  });
                }}
                className="rounded-md border border-border bg-surface px-2 py-1 text-[11px] font-semibold text-ink"
              >
                Cancel
              </button>
              <button
                disabled={busy}
                onClick={save}
                className="rounded-md bg-accent px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-accent-ink disabled:opacity-50"
              >
                Save
              </button>
            </>
          )}
        </div>
      </div>

      {/* Metrics row */}
      <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-border pt-2 text-[11px]">
        <span>
          <span className="font-semibold text-ink">{local.stops.length}</span>{" "}
          <span className="text-ink-secondary">stops</span>
        </span>
        <span>
          <span className="font-semibold text-ink">
            {formatCurrency(local.stops.reduce((s, st) => s + (st.local_total || 0), 0))}
          </span>
        </span>
        <span>
          <span className="font-semibold text-ink">~{trip.total_distance_km.toFixed(0)}km</span>
        </span>
        <span className="ml-auto text-ink-secondary">{trip.payload.reason}</span>
      </div>

      {/* Stops list */}
      <div className="mt-2 space-y-1">
        {local.stops.map((s, i) => (
          <div
            key={s.doc_no}
            className="flex items-center gap-2 rounded-md border border-border bg-paper px-2.5 py-1.5"
          >
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-ink text-[9px] font-bold text-paper">
              {i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12px] font-semibold text-ink">
                {s.debtor_name || s.doc_no}
              </div>
              <div className="font-mono text-[10px] text-ink-secondary">{s.doc_no}</div>
            </div>
            <div className="text-[11px] font-mono text-ink-secondary">
              {formatCurrency(s.local_total)}
            </div>
            {editing && (
              <button
                onClick={() => removeStop(s.doc_no)}
                aria-label="Remove stop"
                className="rounded p-1 text-ink-secondary hover:text-err"
              >
                <X size={12} />
              </button>
            )}
          </div>
        ))}
      </div>

      {editing && (
        <button
          onClick={() => setShowAdd(true)}
          className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border bg-paper py-2 text-[11px] font-semibold text-ink-secondary hover:border-accent/50 hover:text-accent"
        >
          <Plus size={12} /> Add stop
        </button>
      )}

      {showAdd && (
        <AddStopModal
          existing={new Set(local.stops.map((s) => s.doc_no))}
          onClose={() => setShowAdd(false)}
          onPick={(orders) => {
            addStops(orders);
            setShowAdd(false);
          }}
        />
      )}
    </div>
  );
}

// ── Add Stop modal ─────────────────────────────────────────────────

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 backdrop-blur-sm">
      <div className="thin-scroll max-h-[80vh] w-full max-w-lg overflow-y-auto rounded-xl bg-surface p-5 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <div className="text-[14px] font-bold text-ink">Add stops</div>
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
            className="ml-auto rounded-md bg-accent px-4 py-2 text-[12px] font-bold uppercase tracking-wide text-accent-ink disabled:opacity-50"
          >
            Add to trip
          </button>
        </div>
      </div>
    </div>
  );
}
