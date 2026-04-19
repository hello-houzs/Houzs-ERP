import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import {
  ArrowLeft,
  Phone,
  Navigation,
  Camera,
  CheckCircle2,
  XCircle,
  MapPin,
  Play,
  Square,
  Truck,
  Maximize2,
  Minimize2,
  ClipboardCheck,
  X,
} from "lucide-react";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { useDialog } from "../hooks/useDialog";
import { api } from "../api/client";
import { formatCurrency, cn } from "../lib/utils";
import { SignaturePad, type SignaturePadHandle } from "../components/SignaturePad";
import { MapView, type MapPin as MapPinT } from "../components/MapView";
import type { TripDetail, TripStop } from "../types";

/**
 * Active trip page — the heart of the driver experience.
 *
 * Three lifecycle phases:
 *  1. assigned          → "Start Trip" button (records start odometer)
 *  2. started/in_progress → stop list with Arrived/Delivered/Failed actions
 *  3. completed         → read-only summary
 *
 * While the trip is started/in_progress, a GPS watcher runs in the
 * background and batches location pings to /api/trips/:id/locations
 * roughly every 30s.
 */
export function DriverTrip() {
  const toast = useToast();
  const dialog = useDialog();
  const { id } = useParams<{ id: string }>();
  const tripId = parseInt(id || "0", 10);
  const detail = useQuery<TripDetail>(() => api.get(`/api/trips/${tripId}`), [tripId]);

  // POD bottom sheet state
  const [podStop, setPodStop] = useState<TripStop | null>(null);
  const [busy, setBusy] = useState(false);
  // Live driver location for the in-trip map
  const [livePos, setLivePos] = useState<{ lat: number; lng: number } | null>(null);
  const [mapExpanded, setMapExpanded] = useState(false);

  // Start/end trip forms
  const [showStartForm, setShowStartForm] = useState(false);
  const [showEndForm, setShowEndForm] = useState(false);
  const [startOdo, setStartOdo] = useState("");
  const [endOdo, setEndOdo] = useState("");
  const [fuelLitres, setFuelLitres] = useState("");
  const [fuelCost, setFuelCost] = useState("");
  const [tripNotes, setTripNotes] = useState("");

  async function startTrip() {
    setBusy(true);
    try {
      // Clock in automatically
      await api.post("/api/fleet/clock/in").catch(() => {});
      await api.patch(`/api/trips/${tripId}`, {
        status: "started",
        started_at: new Date().toISOString(),
        start_odometer: parseFloat(startOdo) || null,
        clock_in_at: new Date().toISOString(),
      });
      setShowStartForm(false);
      detail.reload();
    } finally {
      setBusy(false);
    }
  }

  async function endTrip() {
    if (!endOdo) {
      toast.error("Please enter the end odometer reading.");
      return;
    }
    setBusy(true);
    try {
      // Clock out automatically
      await api.post("/api/fleet/clock/out").catch(() => {});
      await api.patch(`/api/trips/${tripId}`, {
        status: "completed",
        completed_at: new Date().toISOString(),
        end_odometer: parseFloat(endOdo) || null,
        fuel_litres: parseFloat(fuelLitres) || null,
        fuel_cost: parseFloat(fuelCost) || null,
        notes: tripNotes || null,
        clock_out_at: new Date().toISOString(),
      });
      setShowEndForm(false);
      detail.reload();
    } finally {
      setBusy(false);
    }
  }

  // GPS loop while the trip is in progress — also feeds the live map dot.
  useGpsLoop(
    tripId,
    !!detail.data && (detail.data.trip.status === "started" || detail.data.trip.status === "in_progress"),
    setLivePos
  );

  if (detail.loading)
    return <div className="px-4 py-6 text-sm text-ink-secondary">Loading…</div>;
  if (detail.error || !detail.data)
    return (
      <div className="px-4 py-6 text-sm text-err">
        {detail.error || "Trip not found"}
      </div>
    );

  const { trip, stops } = detail.data;
  const isLive = trip.status === "started" || trip.status === "in_progress";
  const isAssigned = trip.status === "assigned";
  const isDone = trip.status === "completed" || trip.status === "cancelled";

  return (
    <div className="px-4 py-4">
      {/* Back link + trip header */}
      <div className="mb-4">
        <Link
          to="/driver"
          className="mb-3 inline-flex items-center gap-1.5 text-[12px] font-semibold text-ink-secondary"
        >
          <ArrowLeft size={14} /> Back
        </Link>
        <div className="rounded-xl border border-border bg-surface p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="font-mono text-[14px] font-bold text-ink">
                {trip.trip_no}
              </div>
              <div className="mt-1 flex items-center gap-2 text-[12px] text-ink-secondary">
                <MapPin size={12} />
                {trip.warehouse_name || trip.warehouse}
              </div>
              {trip.lorry_plate && (
                <div className="mt-0.5 flex items-center gap-2 text-[12px] text-ink-secondary">
                  <Truck size={12} />
                  <span className="font-mono">{trip.lorry_plate}</span>
                </div>
              )}
            </div>
            <StatusBadge status={trip.status} />
          </div>

          {/* Helper info */}
          {(trip.helper_1_name || trip.helper_2_name) && (
            <div className="mt-2 flex items-center gap-2 text-[12px] text-ink-secondary">
              <span className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">Helpers</span>
              {trip.helper_1_name && <span>{trip.helper_1_name}</span>}
              {trip.helper_2_name && <span>· {trip.helper_2_name}</span>}
            </div>
          )}

          {/* Action section */}
          <div className="mt-4">
            {isAssigned && !showStartForm && (
              <button
                onClick={() => setShowStartForm(true)}
                className="flex w-full items-center justify-center gap-2 rounded-md bg-accent py-3 text-[13px] font-bold uppercase tracking-wide text-white shadow-sm active:bg-accent/90"
              >
                <Play size={16} /> Start Trip
              </button>
            )}

            {isAssigned && showStartForm && (
              <div className="rounded-lg border border-accent/30 bg-accent/5 p-4 space-y-3">
                <div className="text-[11px] font-semibold uppercase tracking-brand text-accent">
                  Before you go
                </div>
                <label className="block">
                  <span className="mb-1 block text-[10px] font-semibold uppercase tracking-brand text-ink-secondary">
                    Start Odometer (km)
                  </span>
                  <input
                    type="number"
                    value={startOdo}
                    onChange={(e) => setStartOdo(e.target.value)}
                    placeholder="e.g. 45230"
                    className="w-full rounded-md border border-border bg-paper px-3 py-2.5 text-[14px] font-mono"
                    inputMode="decimal"
                  />
                </label>
                <div className="flex gap-2">
                  <button
                    onClick={() => setShowStartForm(false)}
                    className="flex-1 rounded-md border border-border bg-surface py-2.5 text-[12px] font-semibold text-ink"
                  >
                    Cancel
                  </button>
                  <button
                    disabled={busy}
                    onClick={startTrip}
                    className="flex-1 rounded-md bg-accent py-2.5 text-[12px] font-bold uppercase tracking-wide text-white disabled:opacity-50"
                  >
                    {busy ? "Starting…" : "Confirm Start"}
                  </button>
                </div>
              </div>
            )}

            {isLive && !showEndForm && (
              <button
                onClick={() => setShowEndForm(true)}
                className="flex w-full items-center justify-center gap-2 rounded-md border border-err/60 bg-err/5 py-3 text-[13px] font-bold uppercase tracking-wide text-err active:bg-err/10"
              >
                <Square size={16} /> End Trip
              </button>
            )}

            {isLive && showEndForm && (
              <div className="rounded-lg border border-err/30 bg-err/5 p-4 space-y-3">
                <div className="text-[11px] font-semibold uppercase tracking-brand text-err">
                  End Trip
                </div>
                <label className="block">
                  <span className="mb-1 block text-[10px] font-semibold uppercase tracking-brand text-ink-secondary">
                    End Odometer (km) *
                  </span>
                  <input
                    type="number"
                    value={endOdo}
                    onChange={(e) => setEndOdo(e.target.value)}
                    placeholder="e.g. 45380"
                    className="w-full rounded-md border border-border bg-paper px-3 py-2.5 text-[14px] font-mono"
                    inputMode="decimal"
                  />
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className="mb-1 block text-[10px] font-semibold uppercase tracking-brand text-ink-secondary">
                      Fuel (litres)
                    </span>
                    <input
                      type="number"
                      value={fuelLitres}
                      onChange={(e) => setFuelLitres(e.target.value)}
                      placeholder="0"
                      className="w-full rounded-md border border-border bg-paper px-3 py-2.5 text-[13px] font-mono"
                      inputMode="decimal"
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-[10px] font-semibold uppercase tracking-brand text-ink-secondary">
                      Fuel Cost (RM)
                    </span>
                    <input
                      type="number"
                      value={fuelCost}
                      onChange={(e) => setFuelCost(e.target.value)}
                      placeholder="0.00"
                      className="w-full rounded-md border border-border bg-paper px-3 py-2.5 text-[13px] font-mono"
                      inputMode="decimal"
                    />
                  </label>
                </div>
                <label className="block">
                  <span className="mb-1 block text-[10px] font-semibold uppercase tracking-brand text-ink-secondary">
                    Notes
                  </span>
                  <textarea
                    value={tripNotes}
                    onChange={(e) => setTripNotes(e.target.value)}
                    rows={2}
                    placeholder="Any issues or remarks…"
                    className="w-full rounded-md border border-border bg-paper px-3 py-2 text-[13px]"
                  />
                </label>
                <div className="flex gap-2">
                  <button
                    onClick={() => setShowEndForm(false)}
                    className="flex-1 rounded-md border border-border bg-surface py-2.5 text-[12px] font-semibold text-ink"
                  >
                    Cancel
                  </button>
                  <button
                    disabled={busy}
                    onClick={endTrip}
                    className="flex-1 rounded-md bg-err py-2.5 text-[12px] font-bold uppercase tracking-wide text-white disabled:opacity-50"
                  >
                    {busy ? "Ending…" : "Confirm End"}
                  </button>
                </div>
              </div>
            )}

            {isDone && (
              <div className="rounded-lg border border-border bg-paper p-3">
                <div className="text-center text-[12px] font-semibold text-ink-secondary">
                  Trip {trip.status}
                </div>
                {(trip.start_odometer || trip.end_odometer) && (
                  <div className="mt-2 flex justify-center gap-4 text-[11px]">
                    {trip.start_odometer && (
                      <span className="text-ink-secondary">Start: <span className="font-mono font-semibold text-ink">{trip.start_odometer} km</span></span>
                    )}
                    {trip.end_odometer && (
                      <span className="text-ink-secondary">End: <span className="font-mono font-semibold text-ink">{trip.end_odometer} km</span></span>
                    )}
                  </div>
                )}
                {trip.fuel_litres && (
                  <div className="mt-1 text-center text-[11px] text-ink-secondary">
                    Fuel: <span className="font-mono font-semibold text-ink">{trip.fuel_litres}L</span>
                    {trip.fuel_cost ? <span> · RM {trip.fuel_cost}</span> : null}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Daily inspection — shown if trip is assigned and lorry hasn't been inspected today */}
      {isAssigned && trip.lorry_id && (
        <InspectionCard lorryId={trip.lorry_id} lorryPlate={trip.lorry_plate ?? undefined} />
      )}

      {/* Route map */}
      <DriverMap
        trip={trip}
        stops={stops}
        livePos={livePos}
        expanded={mapExpanded}
        onToggleExpand={() => setMapExpanded((v) => !v)}
        onPinTap={(stopId) => {
          const el = document.getElementById(`stop-${stopId}`);
          if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
        }}
      />

      {/* Stops */}
      <div className="mb-2 mt-4 flex items-center justify-between">
        <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-secondary">
          Stops · {stops.length}
        </div>
        <div className="text-[10px] text-ink-secondary">
          {stops.filter((s) => s.status === "delivered").length} delivered
        </div>
      </div>

      <div className="space-y-3">
        {stops.map((stop, i) => (
          <StopCard
            key={stop.id}
            stop={stop}
            sequence={i + 1}
            disabled={!isLive}
            onMarkArrived={async () => {
              await api.patch(`/api/trips/${tripId}/stops/${stop.id}`, {
                status: "arrived",
                arrived_at: new Date().toISOString(),
              });
              detail.reload();
            }}
            onOpenPod={() => setPodStop(stop)}
            onMarkFailed={async () => {
              const reason = await dialog.prompt("Reason for failed delivery?");
              if (reason == null) return;
              await api.patch(`/api/trips/${tripId}/stops/${stop.id}`, {
                status: "failed",
                failure_reason: reason,
                completed_at: new Date().toISOString(),
              });
              detail.reload();
            }}
          />
        ))}
      </div>

      {podStop && (
        <PodSheet
          tripId={tripId}
          stop={podStop}
          onClose={() => setPodStop(null)}
          onDone={() => {
            setPodStop(null);
            detail.reload();
          }}
        />
      )}

    </div>
  );
}

// ── Stop card ──────────────────────────────────────────────────────

// ── Daily inspection card ─────────────────────────────────────────

function InspectionCard({ lorryId, lorryPlate }: { lorryId: number; lorryPlate?: string }) {
  const toast = useToast();
  const inspection = useQuery<{ record: any }>(
    () => api.get(`/api/fleet/inspection/today/${lorryId}`),
    [lorryId]
  );
  const [open, setOpen] = useState(false);
  const [checklist, setChecklist] = useState<Record<string, boolean>>({});
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [defaultItems, setDefaultItems] = useState<string[]>([]);

  // Load default checklist items
  useState(() => {
    // We'll hardcode the defaults — they match system_settings.inspection_checklist
    setDefaultItems(["Tyres", "Brakes", "Lights", "Mirrors", "Horn", "Wipers", "Fuel level", "Body condition", "Load secured"]);
    const initial: Record<string, boolean> = {};
    for (const item of ["Tyres", "Brakes", "Lights", "Mirrors", "Horn", "Wipers", "Fuel level", "Body condition", "Load secured"]) {
      initial[item] = true;
    }
    setChecklist(initial);
  });

  async function submit() {
    setBusy(true);
    try {
      const allPassed = Object.values(checklist).every(Boolean);
      await api.post("/api/fleet/inspection", {
        lorry_id: lorryId,
        checklist,
        passed: allPassed,
        notes: notes || undefined,
      });
      inspection.reload();
      setOpen(false);
    } catch (e: any) {
      toast.error(e?.message || "Submit failed");
    } finally {
      setBusy(false);
    }
  }

  // Already inspected today
  if (inspection.data?.record) {
    const rec = inspection.data.record;
    return (
      <div className="mb-4 rounded-xl border border-ok/30 bg-ok/5 p-3">
        <div className="flex items-center gap-2">
          <CheckCircle2 size={16} className="text-ok" />
          <span className="text-[12px] font-semibold text-ok">
            Inspection completed
          </span>
          <span className="ml-auto text-[10px] text-ink-secondary">
            {lorryPlate}
          </span>
        </div>
      </div>
    );
  }

  if (!open) {
    return (
      <div className="mb-4">
        <button
          onClick={() => setOpen(true)}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-warning-text/30 bg-warning-bg/40 py-3 text-[12px] font-semibold text-warning-text"
        >
          <ClipboardCheck size={16} />
          Daily Inspection Required — {lorryPlate}
        </button>
      </div>
    );
  }

  return (
    <div className="mb-4 rounded-xl border border-border bg-surface p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-brand text-accent">
            Daily Inspection
          </div>
          <div className="text-[13px] font-bold text-ink">{lorryPlate}</div>
        </div>
        <button onClick={() => setOpen(false)} className="text-ink-secondary">
          <X size={16} />
        </button>
      </div>

      <div className="space-y-2">
        {defaultItems.map((item) => (
          <label
            key={item}
            className="flex items-center gap-3 rounded-md border border-border bg-paper px-3 py-2.5"
          >
            <input
              type="checkbox"
              checked={checklist[item] ?? true}
              onChange={(e) => setChecklist({ ...checklist, [item]: e.target.checked })}
              className="h-4 w-4 accent-accent"
            />
            <span className="text-[13px] text-ink">{item}</span>
            {!(checklist[item] ?? true) && (
              <span className="ml-auto text-[10px] font-semibold text-err">FAIL</span>
            )}
          </label>
        ))}
      </div>

      <label className="mt-3 block">
        <span className="mb-1 block text-[10px] font-semibold uppercase tracking-brand text-ink-secondary">
          Notes
        </span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          placeholder="Any issues found…"
          className="w-full rounded-md border border-border bg-paper px-3 py-2 text-[13px]"
        />
      </label>

      <button
        disabled={busy}
        onClick={submit}
        className="mt-3 w-full rounded-md bg-accent py-2.5 text-[12px] font-bold uppercase tracking-wide text-white disabled:opacity-50"
      >
        {busy ? "Submitting…" : "Submit Inspection"}
      </button>
    </div>
  );
}

function StopCard({
  stop,
  sequence,
  disabled,
  onMarkArrived,
  onOpenPod,
  onMarkFailed,
}: {
  stop: TripStop;
  sequence: number;
  disabled: boolean;
  onMarkArrived: () => Promise<void>;
  onOpenPod: () => void;
  onMarkFailed: () => Promise<void>;
}) {
  const addr = [stop.inv_addr1, stop.inv_addr2, stop.inv_addr3, stop.inv_addr4]
    .filter(Boolean)
    .join(", ");
  const navUrl = stop.stop_lat && stop.stop_lng
    ? `https://www.google.com/maps/dir/?api=1&destination=${stop.stop_lat},${stop.stop_lng}`
    : addr
    ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(addr)}`
    : null;

  const tone =
    stop.status === "delivered"
      ? "border-ok/40 bg-ok/5"
      : stop.status === "failed"
      ? "border-err/40 bg-err/5"
      : stop.status === "arrived"
      ? "border-warning-text/40 bg-warning-bg/30"
      : "border-border bg-surface";

  return (
    <div id={`stop-${stop.id}`} className={cn("rounded-xl border p-4 shadow-sm", tone)}>
      <div className="flex items-start gap-3">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ink text-[12px] font-bold text-paper">
          {sequence}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-[13px] font-bold text-ink">
                {stop.debtor_name || stop.doc_no}
              </div>
              <div className="mt-0.5 font-mono text-[11px] text-ink-secondary">
                {stop.doc_no}
              </div>
            </div>
            <StopStatusBadge status={stop.status} />
          </div>

          {addr && (
            <div className="mt-2 text-[12px] leading-snug text-ink-secondary">
              {addr}
            </div>
          )}

          <div className="mt-2 flex items-center gap-2 text-[11px] text-ink-secondary">
            {stop.local_total != null && (
              <span>{formatCurrency(stop.local_total)}</span>
            )}
            {stop.stop_type !== "delivery" && (
              <>
                <span className="text-border">·</span>
                <span className="capitalize">{stop.stop_type}</span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Quick actions */}
      <div className="mt-3 grid grid-cols-2 gap-2">
        {stop.phone && (
          <a
            href={`tel:${stop.phone}`}
            className="flex items-center justify-center gap-1.5 rounded-md border border-border bg-surface px-3 py-2 text-[12px] font-semibold text-ink active:bg-paper"
          >
            <Phone size={13} /> Call
          </a>
        )}
        {navUrl && (
          <a
            href={navUrl}
            target="_blank"
            rel="noreferrer"
            className="flex items-center justify-center gap-1.5 rounded-md border border-border bg-surface px-3 py-2 text-[12px] font-semibold text-ink active:bg-paper"
          >
            <Navigation size={13} /> Navigate
          </a>
        )}
      </div>

      {/* Status actions */}
      {stop.status === "pending" && (
        <button
          disabled={disabled}
          onClick={onMarkArrived}
          className="mt-2 w-full rounded-md bg-accent/90 py-2.5 text-[12px] font-bold uppercase tracking-wide text-accent-ink disabled:opacity-50"
        >
          I've Arrived
        </button>
      )}
      {stop.status === "arrived" && (
        <div className="mt-2 grid grid-cols-2 gap-2">
          <button
            disabled={disabled}
            onClick={onOpenPod}
            className="flex items-center justify-center gap-1.5 rounded-md bg-ok/90 py-2.5 text-[12px] font-bold uppercase tracking-wide text-white disabled:opacity-50"
          >
            <CheckCircle2 size={14} /> Delivered
          </button>
          <button
            disabled={disabled}
            onClick={onMarkFailed}
            className="flex items-center justify-center gap-1.5 rounded-md border border-err/60 bg-err/5 py-2.5 text-[12px] font-bold uppercase tracking-wide text-err disabled:opacity-50"
          >
            <XCircle size={14} /> Failed
          </button>
        </div>
      )}
      {stop.status === "delivered" && stop.recipient_name && (
        <div className="mt-2 rounded-md bg-paper px-2.5 py-1.5 text-[11px] text-ink-secondary">
          Received by <span className="font-semibold text-ink">{stop.recipient_name}</span>
        </div>
      )}
      {stop.status === "failed" && stop.failure_reason && (
        <div className="mt-2 rounded-md bg-err/5 px-2.5 py-1.5 text-[11px] text-err">
          {stop.failure_reason}
        </div>
      )}
    </div>
  );
}

// ── Status badges ──────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    assigned: "bg-accent/10 text-accent",
    started: "bg-warning-bg text-warning-text",
    in_progress: "bg-warning-bg text-warning-text",
    completed: "bg-ok/10 text-ok",
    cancelled: "bg-ink/10 text-ink-secondary",
  };
  return (
    <span
      className={cn(
        "rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide",
        map[status] || "bg-ink/10 text-ink"
      )}
    >
      {status.replace("_", " ")}
    </span>
  );
}

function StopStatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    pending: "bg-ink/10 text-ink-secondary",
    arrived: "bg-warning-bg text-warning-text",
    delivered: "bg-ok/10 text-ok",
    failed: "bg-err/10 text-err",
  };
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide",
        map[status]
      )}
    >
      {status}
    </span>
  );
}

// ── POD bottom sheet ───────────────────────────────────────────────

function PodSheet({
  tripId,
  stop,
  onClose,
  onDone,
}: {
  tripId: number;
  stop: TripStop;
  onClose: () => void;
  onDone: () => void;
}) {
  const [recipient, setRecipient] = useState(stop.recipient_name ?? "");
  const [notes, setNotes] = useState(stop.notes ?? "");
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sigRef = useRef<SignaturePadHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function pickPhoto(file: File | null) {
    if (photoPreview) URL.revokeObjectURL(photoPreview);
    setPhoto(file);
    setPhotoPreview(file ? URL.createObjectURL(file) : null);
  }

  useEffect(() => {
    return () => {
      if (photoPreview) URL.revokeObjectURL(photoPreview);
    };
  }, [photoPreview]);

  async function submit() {
    setError(null);
    if (!recipient.trim()) {
      setError("Please enter the recipient name.");
      return;
    }
    if (sigRef.current?.isEmpty()) {
      setError("Please capture the recipient's signature.");
      return;
    }
    if (!photo) {
      setError("Please take a proof-of-delivery photo.");
      return;
    }

    setBusy(true);
    try {
      // 1. Upload signature
      const sigBlob = await sigRef.current!.toBlob();
      if (!sigBlob) throw new Error("Could not capture signature");
      await api.putBinary(
        `/api/trips/${tripId}/stops/${stop.id}/pod?kind=signature&ext=png`,
        sigBlob,
        "image/png"
      );

      // 2. Upload photo
      const ext = photo.type.includes("png") ? "png" : "jpg";
      await api.putBinary(
        `/api/trips/${tripId}/stops/${stop.id}/pod?kind=photo&ext=${ext}`,
        photo,
        photo.type || "image/jpeg"
      );

      // 3. Mark stop delivered (server already stored the R2 keys)
      await api.patch(`/api/trips/${tripId}/stops/${stop.id}`, {
        status: "delivered",
        recipient_name: recipient.trim(),
        notes: notes.trim() || null,
        completed_at: new Date().toISOString(),
      });
      onDone();
    } catch (e: any) {
      setError(e?.message || "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-ink/50 backdrop-blur-sm">
      <div className="thin-scroll max-h-[92vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-surface p-5 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <div className="text-[14px] font-bold text-ink">Proof of Delivery</div>
          <button
            onClick={onClose}
            className="rounded-md px-2 py-1 text-[12px] font-semibold text-ink-secondary"
          >
            Cancel
          </button>
        </div>
        <div className="mb-3 text-[12px] text-ink-secondary">
          {stop.debtor_name} · <span className="font-mono">{stop.doc_no}</span>
        </div>

        <label className="mb-3 block">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-secondary">
            Received by
          </span>
          <input
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="Recipient name"
            className="mt-1 w-full rounded-md border border-border bg-paper px-3 py-2 text-[14px]"
          />
        </label>

        <div className="mb-3">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-secondary">
              Signature
            </span>
            <button
              onClick={() => sigRef.current?.clear()}
              className="text-[11px] font-semibold text-accent"
            >
              Clear
            </button>
          </div>
          <SignaturePad ref={sigRef} />
        </div>

        <div className="mb-3">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-secondary">
            Photo
          </span>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => pickPhoto(e.target.files?.[0] || null)}
          />
          {photoPreview ? (
            <div className="mt-1 overflow-hidden rounded-md border border-border">
              <img src={photoPreview} alt="POD" className="block w-full" />
              <button
                onClick={() => fileInputRef.current?.click()}
                className="block w-full bg-paper py-2 text-[11px] font-semibold text-ink"
              >
                Retake
              </button>
            </div>
          ) : (
            <button
              onClick={() => fileInputRef.current?.click()}
              className="mt-1 flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border bg-paper py-6 text-[12px] font-semibold text-ink-secondary"
            >
              <Camera size={16} /> Take photo
            </button>
          )}
        </div>

        <label className="mb-4 block">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-secondary">
            Notes (optional)
          </span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="mt-1 w-full rounded-md border border-border bg-paper px-3 py-2 text-[13px]"
          />
        </label>

        {error && (
          <div className="mb-3 rounded-md border border-err/40 bg-err/5 p-2 text-[12px] text-err">
            {error}
          </div>
        )}

        <button
          disabled={busy}
          onClick={submit}
          className="w-full rounded-md bg-accent py-3 text-[13px] font-bold uppercase tracking-wide text-white disabled:opacity-50"
        >
          {busy ? "Submitting…" : "Confirm Delivery"}
        </button>
      </div>
    </div>
  );
}

// ── Driver in-trip map ─────────────────────────────────────────────

function DriverMap({
  trip,
  stops,
  livePos,
  expanded,
  onToggleExpand,
  onPinTap,
}: {
  trip: TripDetail["trip"];
  stops: TripStop[];
  livePos: { lat: number; lng: number } | null;
  expanded: boolean;
  onToggleExpand: () => void;
  onPinTap: (stopId: number) => void;
}) {
  // Stops with coordinates only — pending or arrived (not yet completed).
  const remaining = useMemo(
    () => stops.filter((s) => s.stop_lat != null && s.stop_lng != null && s.status !== "delivered" && s.status !== "failed"),
    [stops]
  );
  const allGeo = useMemo(
    () => stops.filter((s) => s.stop_lat != null && s.stop_lng != null),
    [stops]
  );

  const warehouseLatLng =
    trip.warehouse_lat != null && trip.warehouse_lng != null
      ? { lat: trip.warehouse_lat, lng: trip.warehouse_lng }
      : null;

  const pins: MapPinT[] = useMemo(() => {
    const out: MapPinT[] = [];
    if (warehouseLatLng) {
      out.push({
        id: "wh",
        lat: warehouseLatLng.lat,
        lng: warehouseLatLng.lng,
        label: "W",
        tone: "warehouse",
      });
    }
    allGeo.forEach((s, i) => {
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
        onClick: () => onPinTap(s.id),
      });
    });
    return out;
  }, [warehouseLatLng, allGeo, onPinTap]);

  // Fetch the planned route once per trip — driver-side optimize is the
  // dispatcher's job, so we only ever ask for the current sequence.
  const [polyline, setPolyline] = useState<string | null>(null);
  useEffect(() => {
    if (!warehouseLatLng || remaining.length === 0) return;
    let cancelled = false;
    api
      .post<any>("/api/maps/directions", {
        origin: warehouseLatLng,
        destination: warehouseLatLng,
        waypoints: remaining.map((s) => ({
          lat: s.stop_lat as number,
          lng: s.stop_lng as number,
        })),
      })
      .then((res) => {
        if (!cancelled) setPolyline(res.polyline);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trip.id, remaining.length]);

  if (!warehouseLatLng || allGeo.length === 0) {
    return null; // No coords, hide the map entirely
  }

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-xl border border-border bg-surface",
        expanded ? "fixed inset-0 z-30 rounded-none border-0" : ""
      )}
    >
      <MapView
        pins={pins}
        routePolyline={polyline}
        currentLocation={livePos}
        height={expanded ? "100vh" : 240}
      />
      <button
        onClick={onToggleExpand}
        aria-label={expanded ? "Collapse map" : "Expand map"}
        className="absolute right-3 top-3 z-[400] flex h-9 w-9 items-center justify-center rounded-md border border-border bg-surface/95 text-ink shadow-md backdrop-blur-sm"
      >
        {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
      </button>
    </div>
  );
}

// ── GPS loop ───────────────────────────────────────────────────────

/**
 * While `active` is true, watch the device position and POST batched
 * pings to the trip every ~30 seconds. Cleans up on unmount or when
 * the trip becomes inactive.
 *
 * Buffer flushes on cadence OR when 10 pings accumulate, whichever
 * comes first. Failures are swallowed — the next flush retries.
 */
function useGpsLoop(
  tripId: number,
  active: boolean,
  onPosition?: (p: { lat: number; lng: number }) => void
) {
  const buffer = useRef<{ lat: number; lng: number; accuracy: number; recorded_at: string }[]>([]);

  useEffect(() => {
    if (!active || !tripId) return;
    if (typeof navigator === "undefined" || !navigator.geolocation) return;

    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const point = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          recorded_at: new Date(pos.timestamp).toISOString(),
        };
        buffer.current.push(point);
        onPosition?.({ lat: point.lat, lng: point.lng });
        if (buffer.current.length >= 10) flush();
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 15_000 }
    );

    const interval = window.setInterval(() => flush(), 30_000);

    function flush() {
      if (!buffer.current.length) return;
      const pings = buffer.current.splice(0, buffer.current.length);
      api.post(`/api/trips/${tripId}/locations`, { pings }).catch(() => {
        // Re-queue on failure so the next flush retries.
        buffer.current.unshift(...pings);
      });
    }

    return () => {
      navigator.geolocation.clearWatch(watchId);
      window.clearInterval(interval);
      flush();
    };
  }, [active, tripId]);
}
