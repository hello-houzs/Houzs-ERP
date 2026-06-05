import { useState } from "react";
import {
  Plus,
  Trash2,
  X,
  Calendar,
  MapPin,
  Wrench,
  ExternalLink,
  FolderKanban,
} from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "../hooks/useQuery";
import { useDialog } from "../hooks/useDialog";
import { useToast } from "../hooks/useToast";
import { api } from "../api/client";
import { formatDate, cn } from "../lib/utils";
import type { CalendarEvent, EventType } from "../types";

/**
 * Events tab — manual setup / dismantle calendar entries.
 *
 * Lightweight by design: title / date / address / status / notes. The
 * status field is free text for now (the dispatcher hasn't finalized
 * the lifecycle), so anything goes.
 */
export function EventsTab() {
  const list = useQuery<{ data: CalendarEvent[] }>(() => api.get("/api/events"));
  const [editing, setEditing] = useState<CalendarEvent | "new" | null>(null);

  // Group by date
  const grouped: Record<string, CalendarEvent[]> = {};
  for (const e of list.data?.data ?? []) {
    (grouped[e.event_date] ||= []).push(e);
  }
  const dates = Object.keys(grouped).sort().reverse();

  return (
    <div>
      <div className="mb-4 flex items-center gap-2">
        <div className="text-[11px] text-ink-secondary">
          Setup and dismantle events. Manual entries plus anything
          configured on a project (Logistics Schedule).
        </div>
        <button
          onClick={() => setEditing("new")}
          className="ml-auto flex items-center gap-1.5 rounded-md bg-accent px-3 py-2 text-[12px] font-bold uppercase tracking-wide text-white shadow-sm"
        >
          <Plus size={13} /> Add Event
        </button>
      </div>

      {list.loading && (
        <div className="text-sm text-ink-secondary">Loading…</div>
      )}

      {!list.loading && dates.length === 0 && (
        <div className="rounded-lg border border-dashed border-border bg-surface p-10 text-center">
          <Calendar size={28} className="mx-auto mb-3 text-ink-secondary" />
          <div className="text-[14px] font-bold text-ink">No events yet</div>
          <div className="mt-1 text-[12px] text-ink-secondary">
            Click <span className="font-semibold">Add Event</span> to create a setup or dismantle entry.
          </div>
        </div>
      )}

      {dates.map((d) => (
        <div key={d} className="mb-5">
          <div className="mb-2 flex items-center gap-2">
            <div className="text-[10px] font-semibold uppercase tracking-brand text-accent">
              {formatDate(d)}
            </div>
            <span className="text-[10px] text-ink-secondary">
              · {grouped[d].length} event{grouped[d].length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="space-y-2">
            {grouped[d].map((e) => (
              <EventCard
                key={String(e.id)}
                event={e}
                onEdit={() => {
                  // Project-sourced rows are read-only at this surface;
                  // the EventCard's click handler navigates instead.
                  if (e.source === "project") return;
                  setEditing(e);
                }}
                onDeleted={() => list.reload()}
              />
            ))}
          </div>
        </div>
      ))}

      {editing && editing !== "new" && editing.source === "project" ? null : editing && (
        <EventDialog
          event={editing === "new" ? null : (editing as CalendarEvent)}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            list.reload();
          }}
        />
      )}
    </div>
  );
}

function EventCard({
  event,
  onEdit,
  onDeleted,
}: {
  event: CalendarEvent;
  onEdit: () => void;
  onDeleted: () => void;
}) {
  const dialog = useDialog();
  const toast = useToast();
  const navigate = useNavigate();
  const isProject = event.source === "project";

  async function remove() {
    if (!await dialog.confirm(`Delete "${event.title}"?`)) return;
    try {
      await api.del(`/api/events/${event.id}`);
      onDeleted();
    } catch (e: any) {
      toast.error(e?.message || "Delete failed");
    }
  }

  function onCardClick() {
    if (isProject && event.project_id) {
      navigate(`/projects/${event.project_id}`);
      return;
    }
    onEdit();
  }

  const Icon = event.type === "setup" ? Wrench : Calendar;
  return (
    <div
      onClick={onCardClick}
      className={cn(
        "cursor-pointer rounded-xl border bg-surface p-4 shadow-sm transition-colors",
        isProject
          ? "border-accent/30 hover:border-accent/60"
          : "border-border hover:border-accent/40"
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md",
            event.type === "setup"
              ? "bg-accent/10 text-accent"
              : "bg-warning-bg text-warning-text"
          )}
        >
          <Icon size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] font-bold uppercase tracking-wide text-ink-secondary">
              {event.type}
            </span>
            {event.status && (
              <span className="rounded-full bg-ink/10 px-2 py-0.5 text-[10px] font-semibold text-ink">
                {event.status}
              </span>
            )}
            {isProject && (
              <span className="inline-flex items-center gap-1 rounded-full border border-accent/40 bg-accent-soft/60 px-2 py-0.5 font-mono text-[9.5px] font-bold uppercase tracking-wider text-accent">
                <FolderKanban size={9} /> From Project
              </span>
            )}
            {isProject && event.end_at && (
              <span className="font-mono text-[10px] text-ink-muted">
                ends {formatDate(event.end_at)}
              </span>
            )}
          </div>
          <div className="mt-0.5 text-[14px] font-bold text-ink">{event.title}</div>
          {event.address && (
            <div className="mt-1 flex items-start gap-1.5 text-[11px] text-ink-secondary">
              <MapPin size={11} className="mt-0.5 shrink-0" />
              <span>{event.address}</span>
            </div>
          )}
          {event.notes && (
            <div className="mt-1.5 text-[11px] text-ink-secondary">{event.notes}</div>
          )}
        </div>
        {isProject ? (
          // Project-sourced: read-only here, with a clear hop-out chip.
          // No delete button — managing setup/dismantle dates lives on
          // the project page.
          event.project_id != null && (
            <Link
              to={`/projects/${event.project_id}`}
              onClick={(ev) => ev.stopPropagation()}
              aria-label="Open project"
              className="inline-flex shrink-0 items-center gap-1 rounded-md border border-accent/40 bg-accent-soft/40 px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-wider text-accent hover:bg-accent-soft/70"
              title="Open project"
            >
              Open
              <ExternalLink size={10} />
            </Link>
          )
        ) : (
          <button
            onClick={(ev) => {
              ev.stopPropagation();
              remove();
            }}
            aria-label="Delete"
            className="rounded-md border border-border bg-surface p-1.5 text-ink-secondary hover:border-err/40 hover:text-err"
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>
    </div>
  );
}

function EventDialog({
  event,
  onClose,
  onSaved,
}: {
  event: CalendarEvent | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [type, setType] = useState<EventType>(event?.type ?? "setup");
  const [title, setTitle] = useState(event?.title ?? "");
  const [date, setDate] = useState(event?.event_date ?? new Date().toISOString().slice(0, 10));
  const [address, setAddress] = useState(event?.address ?? "");
  const [status, setStatus] = useState(event?.status ?? "");
  const [notes, setNotes] = useState(event?.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!title.trim()) {
      setError("Title is required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body = {
        type,
        title: title.trim(),
        event_date: date,
        address: address.trim() || null,
        status: status.trim() || null,
        notes: notes.trim() || null,
      };
      if (event) {
        await api.patch(`/api/events/${event.id}`, body);
      } else {
        await api.post("/api/events", body);
      }
      onSaved();
    } catch (e: any) {
      setError(e?.message || "Save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 backdrop-blur-sm">
      <div className="thin-scroll max-h-[85vh] w-full max-w-md overflow-y-auto rounded-xl bg-surface p-5 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-brand text-accent">
              {event ? "Edit event" : "New event"}
            </div>
            <h2 className="font-display text-[16px] font-extrabold tracking-tight text-ink">
              Setup / Dismantle
            </h2>
          </div>
          <button onClick={onClose} aria-label="Close">
            <X size={18} className="text-ink-secondary" />
          </button>
        </div>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <Field label="Type">
              <select
                value={type}
                onChange={(e) => setType(e.target.value as EventType)}
                className="w-full rounded-md border border-border bg-paper px-3 py-2 text-[13px]"
              >
                <option value="setup">Setup</option>
                <option value="dismantle">Dismantle</option>
              </select>
            </Field>
            <Field label="Date">
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="w-full rounded-md border border-border bg-paper px-3 py-2 text-[13px]"
              />
            </Field>
          </div>

          <Field label="Title">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Setup at Customer X"
              className="w-full rounded-md border border-border bg-paper px-3 py-2 text-[13px]"
              autoFocus
            />
          </Field>

          <Field label="Address">
            <textarea
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              rows={2}
              placeholder="Optional"
              className="w-full rounded-md border border-border bg-paper px-3 py-2 text-[13px]"
            />
          </Field>

          <Field label="Status">
            <input
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              placeholder="Free text — e.g. Pending, Confirmed, Done"
              className="w-full rounded-md border border-border bg-paper px-3 py-2 text-[13px]"
            />
          </Field>

          <Field label="Notes">
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="w-full rounded-md border border-border bg-paper px-3 py-2 text-[13px]"
            />
          </Field>
        </div>

        {error && (
          <div className="mt-3 rounded-md border border-err/40 bg-err/5 p-2 text-[12px] text-err">
            {error}
          </div>
        )}

        <div className="mt-4 flex items-center gap-2">
          <button
            onClick={onClose}
            className="rounded-md border border-border bg-surface px-4 py-2 text-[12px] font-semibold text-ink"
          >
            Cancel
          </button>
          <button
            disabled={busy}
            onClick={save}
            className="ml-auto rounded-md bg-accent px-5 py-2.5 text-[12px] font-bold uppercase tracking-wide text-white disabled:opacity-50"
          >
            {busy ? "Saving…" : event ? "Save" : "Create"}
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
