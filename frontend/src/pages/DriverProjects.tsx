import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  FolderKanban,
  MapPin,
  ChevronRight,
  ChevronLeft,
  Wrench,
  Hammer,
  Search,
  List,
  CalendarDays,
} from "lucide-react";
import { useQuery } from "../hooks/useQuery";
import { api } from "../api/client";
import { formatDate, cn, APP_TZ } from "../lib/utils";
import { EmptyState } from "../components/EmptyState";

interface DriverProjectListItem {
  id: number;
  code: string | null;
  name: string;
  brand: string | null;
  venue: string | null;
  venue_address: string | null;
  state: string | null;
  start_date: string | null;
  end_date: string | null;
  setup_start_at: string | null;
  setup_end_at: string | null;
  dismantle_start_at: string | null;
  dismantle_end_at: string | null;
  my_phases: Array<"setup" | "dismantle">;
}

type Phase = "setup" | "dismantle";

// Calendar-cell event: one project the driver is crewed on for `phase`,
// landing on a given day.
interface PhaseEvent {
  project: DriverProjectListItem;
  phase: Phase;
}

/**
 * Driver-app "My Projects". Shows projects where the caller is on any
 * setup/dismantle crew slot, searchable, with a List or Calendar view.
 * Read-only listing; tap to open the brief + photo upload screen.
 */
export function DriverProjects() {
  const list = useQuery<{ data: DriverProjectListItem[] }>(
    () => api.get("/api/driver/projects")
  );
  const [params, setParams] = useSearchParams();
  const view = params.get("view") === "calendar" ? "calendar" : "list";
  const setView = (v: "list" | "calendar") => {
    const next = new URLSearchParams(params);
    next.set("view", v);
    setParams(next, { replace: true });
  };
  const [q, setQ] = useState("");

  const all = list.data?.data ?? [];
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return all;
    return all.filter((p) =>
      [p.name, p.venue, p.venue_address, p.brand, p.code, p.state]
        .filter(Boolean)
        .some((v) => (v as string).toLowerCase().includes(needle))
    );
  }, [all, q]);

  return (
    <div className="px-4 py-5">
      <div className="mb-4">
        <div className="text-[10px] font-semibold uppercase tracking-brand text-accent">
          Crew
        </div>
        <h1 className="font-display text-[19px] font-extrabold leading-tight tracking-tight text-ink sm:text-[26px] lg:text-[28px]">
          My Projects
        </h1>
        <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary sm:text-sm">
          Projects you're crewed on for setup or dismantle.
        </p>
      </div>

      {/* Search + view toggle */}
      <div className="mb-4 space-y-2">
        <div className="relative">
          <Search
            size={15}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted"
          />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, venue, brand, state…"
            className="w-full rounded-lg border border-border bg-surface py-2.5 pl-9 pr-3 text-[13px] outline-none focus:border-accent"
          />
        </div>
        <div className="flex rounded-lg border border-border bg-surface p-0.5">
          <ViewTab active={view === "list"} onClick={() => setView("list")} Icon={List} label="List" />
          <ViewTab
            active={view === "calendar"}
            onClick={() => setView("calendar")}
            Icon={CalendarDays}
            label="Calendar"
          />
        </div>
      </div>

      {list.loading && <div className="text-[12px] text-ink-secondary">Loading…</div>}
      {list.error && (
        <div className="rounded-md border border-err/40 bg-err/5 p-3 text-[13px] text-err">
          {list.error}
        </div>
      )}

      {list.data && all.length === 0 && (
        <EmptyState
          icon={<FolderKanban size={28} />}
          message="No projects assigned"
          description="New projects appear here once ops adds you to a setup or dismantle crew."
        />
      )}

      {list.data && all.length > 0 && (
        <>
          {view === "list" ? (
            filtered.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border bg-surface p-6 text-center text-[12.5px] text-ink-secondary">
                No projects match "{q}".
              </div>
            ) : (
              <div className="space-y-3">
                {filtered.map((p) => (
                  <ProjectCard key={p.id} project={p} />
                ))}
              </div>
            )
          ) : (
            <DriverCalendar projects={filtered} />
          )}
        </>
      )}
    </div>
  );
}

function ViewTab({
  active,
  onClick,
  Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  Icon: typeof List;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-[12px] font-semibold transition-colors",
        active ? "bg-accent text-white" : "text-ink-secondary"
      )}
    >
      <Icon size={14} />
      {label}
    </button>
  );
}

// ── Calendar view ─────────────────────────────────────────────

// Day key (YYYY-MM-DD) for a scheduling field. Setup/dismantle datetimes
// are wall-clock or date-only, so the date portion is the first 10 chars
// — no timezone conversion (matches formatDate's wall-clock handling).
function dayKey(v: string | null | undefined): string | null {
  return v ? v.slice(0, 10) : null;
}

// Local calendar-date key for a grid cell (built from new Date(y, m, d),
// which is a pure calendar date — no tz shift).
function cellKey(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

// Inclusive [start, end] day-keys for a project's phase, with sensible
// fallbacks when the phase datetimes aren't filled in.
function phaseRange(p: DriverProjectListItem, phase: Phase): [string, string] | null {
  if (phase === "setup") {
    const s = dayKey(p.setup_start_at) ?? dayKey(p.start_date);
    if (!s) return null;
    const e = dayKey(p.setup_end_at) ?? dayKey(p.setup_start_at) ?? s;
    return [s, e < s ? s : e];
  }
  const s = dayKey(p.dismantle_start_at) ?? dayKey(p.end_date) ?? dayKey(p.start_date);
  if (!s) return null;
  const e = dayKey(p.dismantle_end_at) ?? dayKey(p.dismantle_start_at) ?? s;
  return [s, e < s ? s : e];
}

function eachDayKey(startKey: string, endKey: string): string[] {
  const [sy, sm, sd] = startKey.split("-").map(Number);
  const [ey, em, ed] = endKey.split("-").map(Number);
  const end = new Date(ey, em - 1, ed);
  const out: string[] = [];
  // Cap at 60 days so a bad/open-ended range can't spin.
  for (let d = new Date(sy, sm - 1, sd), i = 0; d <= end && i < 60; d.setDate(d.getDate() + 1), i++) {
    out.push(cellKey(d));
  }
  return out.length ? out : [startKey];
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function DriverCalendar({ projects }: { projects: DriverProjectListItem[] }) {
  // Today in app time (GMT+8), as YYYY-MM-DD. en-CA renders ISO order.
  const todayKey = useMemo(
    () => new Intl.DateTimeFormat("en-CA", { timeZone: APP_TZ }).format(new Date()),
    []
  );
  const [ty, tm] = todayKey.split("-").map(Number);
  const [cursor, setCursor] = useState(() => new Date(ty, tm - 1, 1));

  // Bucket every crewed phase onto each day it covers.
  const eventsByDay = useMemo(() => {
    const map = new Map<string, PhaseEvent[]>();
    for (const p of projects) {
      for (const phase of p.my_phases) {
        const range = phaseRange(p, phase);
        if (!range) continue;
        for (const key of eachDayKey(range[0], range[1])) {
          const arr = map.get(key) ?? [];
          arr.push({ project: p, phase });
          map.set(key, arr);
        }
      }
    }
    return map;
  }, [projects]);

  // 6×7 grid starting on the Monday on/before the 1st of the month.
  const cells = useMemo(() => {
    const year = cursor.getFullYear();
    const month = cursor.getMonth();
    const first = new Date(year, month, 1);
    const offset = (first.getDay() + 6) % 7; // 0 = Monday
    return Array.from({ length: 42 }, (_, i) => new Date(year, month, 1 - offset + i));
  }, [cursor]);

  const monthLabel = new Intl.DateTimeFormat("en-GB", {
    month: "long",
    year: "numeric",
  }).format(cursor);
  const monthIndex = cursor.getMonth();

  const [selected, setSelected] = useState<string>(todayKey);
  const selectedEvents = eventsByDay.get(selected) ?? [];

  return (
    <div>
      {/* Month nav */}
      <div className="mb-2 flex items-center justify-between">
        <button
          onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}
          className="rounded-md border border-border bg-surface p-1.5 text-ink-secondary active:bg-paper"
          aria-label="Previous month"
        >
          <ChevronLeft size={16} />
        </button>
        <div className="text-[13px] font-bold text-ink">{monthLabel}</div>
        <button
          onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}
          className="rounded-md border border-border bg-surface p-1.5 text-ink-secondary active:bg-paper"
          aria-label="Next month"
        >
          <ChevronRight size={16} />
        </button>
      </div>

      <div className="rounded-xl border border-border bg-surface p-2">
        <div className="grid grid-cols-7 gap-1">
          {WEEKDAYS.map((d) => (
            <div
              key={d}
              className="py-1 text-center text-[10px] font-semibold uppercase tracking-brand text-ink-muted"
            >
              {d}
            </div>
          ))}
          {cells.map((d) => {
            const key = cellKey(d);
            const events = eventsByDay.get(key) ?? [];
            const inMonth = d.getMonth() === monthIndex;
            const isToday = key === todayKey;
            const isSelected = key === selected;
            return (
              <button
                key={key}
                onClick={() => setSelected(key)}
                className={cn(
                  "flex min-h-[42px] flex-col items-center gap-1 rounded-md py-1 transition-colors",
                  isSelected ? "bg-accent/10 ring-1 ring-accent" : "active:bg-paper",
                  !inMonth && "opacity-35"
                )}
              >
                <span
                  className={cn(
                    "flex h-5 w-5 items-center justify-center rounded-full text-[11px]",
                    isToday ? "bg-accent font-bold text-white" : "text-ink"
                  )}
                >
                  {d.getDate()}
                </span>
                {events.length > 0 && (
                  <span className="flex items-center gap-0.5">
                    {events.slice(0, 3).map((e, i) => (
                      <span
                        key={i}
                        className={cn(
                          "h-1.5 w-1.5 rounded-full",
                          e.phase === "setup" ? "bg-accent" : "bg-amber-500"
                        )}
                      />
                    ))}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Legend */}
      <div className="mt-2 flex items-center gap-4 text-[11px] text-ink-secondary">
        <span className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-accent" /> Setup
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-500" /> Dismantle
        </span>
      </div>

      {/* Selected-day agenda */}
      <div className="mt-4">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-brand text-ink-muted">
          {formatDate(selected)}
        </div>
        {selectedEvents.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-surface p-5 text-center text-[12.5px] text-ink-secondary">
            Nothing scheduled this day.
          </div>
        ) : (
          <div className="space-y-2">
            {selectedEvents.map((e, i) => (
              <Link
                key={`${e.project.id}-${e.phase}-${i}`}
                to={`/driver/projects/${e.project.id}`}
                className="flex items-center gap-3 rounded-lg border border-border bg-surface p-3 active:bg-paper"
              >
                <PhaseChip phase={e.phase} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-bold text-ink">
                    {e.project.name}
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-ink-secondary">
                    <MapPin size={12} />
                    <span className="truncate">{e.project.venue || "Venue TBD"}</span>
                  </div>
                </div>
                <ChevronRight size={16} className="shrink-0 text-ink-muted" />
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ProjectCard({ project }: { project: DriverProjectListItem }) {
  const hasSetup = project.my_phases.includes("setup");
  const hasDismantle = project.my_phases.includes("dismantle");
  return (
    <Link
      to={`/driver/projects/${project.id}`}
      className="block rounded-xl border border-border bg-surface p-4 shadow-sm transition-colors active:bg-paper"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            {project.brand && (
              <span className="rounded-full bg-ink/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink">
                {project.brand}
              </span>
            )}
            {hasSetup && <PhaseChip phase="setup" />}
            {hasDismantle && <PhaseChip phase="dismantle" />}
          </div>
          <div className="mt-1.5 truncate font-display text-[15px] font-bold text-ink">
            {project.name}
          </div>
          <div className="mt-1 flex items-center gap-2 text-[12px] text-ink-secondary">
            <MapPin size={13} />
            <span className="truncate">{project.venue || "Venue TBD"}</span>
          </div>
          <div className="mt-0.5 text-[11px] text-ink-muted">
            {formatDate(project.start_date)} – {formatDate(project.end_date)}
          </div>
        </div>
        <ChevronRight size={18} className="mt-1 shrink-0 text-ink-muted" />
      </div>
    </Link>
  );
}

function PhaseChip({ phase }: { phase: "setup" | "dismantle" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
        phase === "setup"
          ? "bg-accent/10 text-accent"
          : "bg-warning-bg text-warning-text"
      )}
    >
      {phase === "setup" ? <Wrench size={10} /> : <Hammer size={10} />}
      {phase}
    </span>
  );
}
