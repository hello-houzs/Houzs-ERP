import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { getHolidaysOn } from "../lib/holidays";
import "./mobile.css";

/**
 * Mobile Calendar screen — 1:1 with the owner's mobile design prototype,
 * wired to the same feed the desktop Projects calendar uses.
 *
 * Data source: GET /api/projects/calendar/events?from=YYYY-MM-DD&to=YYYY-MM-DD
 * (backend/src/routes/projects.ts, gated by projects.calendar page access,
 * row-scoped by PIC + brand). Returns { projects, tasks }:
 *
 *   project: { id, code, name, stage, status ("confirmed"|"pending"|
 *     "cancelled"), brand, organizer, start_date, end_date, venue, state,
 *     active_section_name, sections_total, event_type_name }
 *   task:    { id, project_id, project_code, project_name, brand, organizer,
 *     title, due_date, status, project_status, owner_name, is_overdue }
 *
 * The prototype's brand / section / organizer selects and the confirmed /
 * pending / cancelled legend map directly onto these fields. Projects render
 * as event bars on their start_date; tasks render when the "Tasks" toggle is
 * on (keyed off due_date).
 *
 * The "My holidays" toggle overlays Malaysian federal public holidays, sourced
 * from the SAME local table the desktop Projects calendar uses
 * (src/lib/holidays.ts → getHolidaysOn); no backend feed is involved. Holidays
 * render as purple event bars (matching the design's #7a5c86) and bypass the
 * brand/section/organizer filters (they are not project-scoped).
 */

type CalProject = {
  id: number;
  code: string | null;
  name: string;
  stage: string | null;
  status: string | null;
  brand: string | null;
  organizer: string | null;
  start_date: string;
  end_date: string | null;
  venue: string | null;
  state: string | null;
  active_section_name: string | null;
  sections_total: number | null;
  event_type_name: string | null;
};

type CalTask = {
  id: number;
  project_id: number;
  project_code: string | null;
  project_name: string | null;
  brand: string | null;
  organizer: string | null;
  title: string;
  due_date: string;
  status: string | null;
  project_status: string | null;
  owner_name: string | null;
  is_overdue: number | null;
};

// A normalized event on the grid — either a project bar or a task chip.
type CalEvent = {
  key: string;
  kind: "project" | "task" | "holiday";
  projectId: number; // tapping a project/task drills into this project (0 for holidays)
  date: string; // YYYY-MM-DD
  label: string;
  color: string;
  brand: string | null;
  section: string | null;
  organizer: string | null;
  status: string | null;
  sub: string | null;
};

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

// Status → bar colour, mirroring the prototype legend.
const STATUS_COLOR: Record<string, string> = {
  confirmed: "#2f8a5b",
  pending: "#cf9a2e",
  cancelled: "#b23a3a",
};
const TASK_COLOR = "#a16a2e";
const HOLIDAY_COLOR = "#7a5c86";
const statusColor = (s: string | null) => STATUS_COLOR[(s ?? "").toLowerCase()] ?? "#5a6b7a";

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;
const dayOf = (d: string) => Number(d.slice(8, 10));

// Monday-first week matrix for a month, matching the prototype's calWeeks().
function monthWeeks(y: number, m: number): (number | null)[][] {
  const first = new Date(y, m, 1);
  const lead = (first.getDay() + 6) % 7; // Mon = 0
  const days = new Date(y, m + 1, 0).getDate();
  const cells: (number | null)[] = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(d);
  while (cells.length % 7) cells.push(null);
  const weeks: (number | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

export function MobileCalendar({ onOpenProject }: { onOpenProject?: (projectId: number) => void } = {}) {
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [mode, setMode] = useState<"month" | "week">("month");
  const [brandF, setBrandF] = useState("all");
  const [sectionF, setSectionF] = useState("all");
  const [orgF, setOrgF] = useState("all");
  const [showTasks, setShowTasks] = useState(false);
  // My-holidays toggle — overlays Malaysian federal public holidays from the
  // local src/lib/holidays.ts table (same source as the desktop calendar); no
  // backend feed needed. Injected as purple bars in the events memo below.
  const [showHolidays, setShowHolidays] = useState(false);
  const [expand, setExpand] = useState(false);

  // Fetch the full month in one call, keyed by month so navigation refetches.
  const from = iso(year, month, 1);
  const to = iso(year, month, new Date(year, month + 1, 0).getDate());
  const { data, isLoading, error } = useQuery({
    queryKey: ["mobile-calendar", from, to],
    queryFn: () =>
      api.get<{ projects: CalProject[]; tasks: CalTask[] }>(
        `/api/projects/calendar/events?from=${from}&to=${to}`
      ),
    staleTime: 30_000,
  });
  const projects = data?.projects ?? [];
  const tasks = data?.tasks ?? [];

  // Filter option lists come from the live rows so they always reflect reality.
  const brandOptions = useMemo(() => uniqueSorted(projects.map((p) => p.brand)), [projects]);
  const sectionOptions = useMemo(() => uniqueSorted(projects.map((p) => p.active_section_name)), [projects]);
  const orgOptions = useMemo(() => uniqueSorted(projects.map((p) => p.organizer)), [projects]);

  // Normalize projects (+ optionally tasks) into grid events, then filter.
  const events = useMemo<CalEvent[]>(() => {
    const out: CalEvent[] = [];
    for (const p of projects) {
      out.push({
        key: `p-${p.id}`,
        kind: "project",
        projectId: p.id,
        date: p.start_date.slice(0, 10),
        label: p.code ? `[${p.brand ?? "—"}] ${p.name}` : p.name,
        color: statusColor(p.status),
        brand: p.brand,
        section: p.active_section_name,
        organizer: p.organizer,
        status: p.status,
        sub: p.venue || p.state || null,
      });
    }
    if (showTasks) {
      for (const t of tasks) {
        out.push({
          key: `t-${t.id}`,
          kind: "task",
          projectId: t.project_id,
          date: t.due_date.slice(0, 10),
          label: `Task · ${t.title}`,
          color: TASK_COLOR,
          brand: t.brand,
          section: null,
          organizer: t.organizer,
          status: t.status,
          sub: t.project_code || t.project_name || null,
        });
      }
    }
    const filtered = out.filter((e) => {
      const d = new Date(e.date);
      if (d.getFullYear() !== year || d.getMonth() !== month) return false;
      if (brandF !== "all" && (e.brand ?? "") !== brandF) return false;
      if (sectionF !== "all" && (e.section ?? "") !== sectionF) return false;
      if (orgF !== "all" && (e.organizer ?? "") !== orgF) return false;
      return true;
    });
    // Holidays overlay the whole month regardless of the project filters — they
    // are federal, not project-scoped (mirrors the design's holiday layer).
    if (showHolidays) {
      const days = new Date(year, month + 1, 0).getDate();
      for (let d = 1; d <= days; d++) {
        for (const h of getHolidaysOn(iso(year, month, d))) {
          filtered.push({
            key: `h-${h.date}-${h.name}`,
            kind: "holiday",
            projectId: 0,
            date: h.date,
            label: h.name,
            color: HOLIDAY_COLOR,
            brand: null,
            section: null,
            organizer: null,
            status: null,
            sub: "Public holiday",
          });
        }
      }
    }
    return filtered;
  }, [projects, tasks, showTasks, showHolidays, year, month, brandF, sectionF, orgF]);

  const byDay = useMemo(() => {
    const map: Record<number, CalEvent[]> = {};
    for (const e of events) {
      const d = dayOf(e.date);
      (map[d] = map[d] || []).push(e);
    }
    return map;
  }, [events]);

  const nav = (delta: number) => {
    const d = new Date(year, month + delta, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth());
  };
  const goToday = () => {
    const n = new Date();
    setYear(n.getFullYear());
    setMonth(n.getMonth());
    setMode("month");
  };

  const isThisMonth = year === today.getFullYear() && month === today.getMonth();
  let weeks = monthWeeks(year, month);
  if (mode === "week") {
    const target = isThisMonth ? today.getDate() : 1;
    weeks = [weeks.find((w) => w.includes(target)) ?? weeks[0]];
  }

  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "#fff" }}>
      <header className="hdr">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, borderRadius: 7, background: "#414539", color: "#fff", fontSize: 11, fontWeight: 800, letterSpacing: ".02em" }}>HC</div>
            <div style={{ lineHeight: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 800, color: "#15161a" }}>HOUZS</div>
              <div style={{ fontSize: 7.5, fontWeight: 700, letterSpacing: ".34em", color: "#16695f", marginTop: 2 }}>CENTURY</div>
            </div>
          </div>
          <div className="iconbtn" style={{ width: 34, height: 34, borderRadius: 9 }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#414539" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
          </div>
        </div>
      </header>

      <div className="scroll" style={{ padding: 12, paddingBottom: 120, background: "#fff" }}>
        {/* Month nav */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 11 }}>
          <button onClick={() => nav(-1)} aria-label="Previous month" className="cal-navbtn">‹</button>
          <button onClick={goToday} className="cal-today">Today</button>
          <button onClick={() => nav(1)} aria-label="Next month" className="cal-navbtn">›</button>
          <div style={{ flex: 1, fontSize: 17, fontWeight: 800, color: "#11140f", textAlign: "right" }}>{MONTHS[month]} {year}</div>
        </div>

        {/* Month / Week segmented toggle */}
        <div style={{ display: "flex", background: "#f4f6f3", border: "1px solid #d6d9d2", borderRadius: 10, padding: 3, marginBottom: 10 }}>
          {(["month", "week"] as const).map((mo) => (
            <button key={mo} onClick={() => setMode(mo)} className={`cal-seg${mode === mo ? " on" : ""}`}>{mo === "month" ? "Month" : "Week"}</button>
          ))}
        </div>

        {/* Filters — populated from the live feed */}
        <div style={{ display: "flex", flexDirection: "column", gap: 7, marginBottom: 10 }}>
          <select value={brandF} onChange={(e) => setBrandF(e.target.value)} className="cal-sel">
            <option value="all">All brands</option>
            {brandOptions.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
          <div style={{ display: "flex", gap: 7 }}>
            <select value={sectionF} onChange={(e) => setSectionF(e.target.value)} className="cal-sel" style={{ flex: 1 }}>
              <option value="all">All sections</option>
              {sectionOptions.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <select value={orgF} onChange={(e) => setOrgF(e.target.value)} className="cal-sel" style={{ flex: 1 }}>
              <option value="all">All organizers</option>
              {orgOptions.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </div>
        </div>

        {/* Tasks / My holidays / Expand toggles */}
        <div style={{ display: "flex", gap: 7, marginBottom: 10, flexWrap: "wrap" }}>
          <button onClick={() => setShowTasks((v) => !v)} className={`cal-tog${showTasks ? " on" : ""}`}>{showTasks ? "●" : "○"} Tasks</button>
          <button onClick={() => setShowHolidays((v) => !v)} className={`cal-tog${showHolidays ? " on" : ""}`}>{showHolidays ? "●" : "○"} My holidays</button>
          <button onClick={() => setExpand((v) => !v)} className={`cal-tog${expand ? " on" : ""}`}>{expand ? "●" : "○"} Expand all</button>
        </div>
        {/* Legend */}
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 6, padding: "0 2px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 9, height: 9, borderRadius: "50%", background: STATUS_COLOR.confirmed }} />
            <span style={{ fontSize: 11, color: "#414539" }}>Confirmed</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 9, height: 9, borderRadius: "50%", background: STATUS_COLOR.pending }} />
            <span style={{ fontSize: 11, color: "#414539" }}>Pending</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 9, height: 9, borderRadius: "50%", background: STATUS_COLOR.cancelled }} />
            <span style={{ fontSize: 11, color: "#414539" }}>Cancelled</span>
          </div>
        </div>
        <div style={{ textAlign: "right", fontSize: 10.5, fontStyle: "italic", color: "#9aa093", marginBottom: 8, paddingRight: 2 }}>
          Tip: tap an event for details · use ‹ › to change month
        </div>

        {isLoading && <div style={emptyBox}>Loading…</div>}
        {error && <div style={{ ...emptyBox, color: "#b23a3a" }}>Couldn't load the calendar. Pull to retry.</div>}

        {!isLoading && !error && mode === "month" && (
          <MonthGrid weeks={weeks} byDay={byDay} expand={expand} onExpand={() => setExpand(true)} empty={events.length === 0} onOpen={onOpenProject} />
        )}

        {!isLoading && !error && mode === "week" && (
          <WeekAgenda weeks={weeks} year={year} month={month} byDay={byDay} onOpen={onOpenProject} />
        )}
      </div>
    </div>
  );
}

function MonthGrid({ weeks, byDay, expand, onExpand, empty, onOpen }: {
  weeks: (number | null)[][];
  byDay: Record<number, CalEvent[]>;
  expand: boolean;
  onExpand: () => void;
  empty: boolean;
  onOpen?: (projectId: number) => void;
}) {
  return (
    <>
      {/* Weekday header */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", border: "1px solid #d6d9d2", borderBottom: "none", borderRadius: "8px 8px 0 0", overflow: "hidden" }}>
        {WEEKDAYS.map((w, i) => (
          <div key={w} style={{ padding: "7px 0", textAlign: "center", fontSize: 9, fontWeight: 700, letterSpacing: ".08em", color: "#767b6e", borderRight: i < 6 ? "1px solid #eceee9" : "none" }}>{w}</div>
        ))}
      </div>

      {empty && (
        <div className="wk" style={{ borderBottom: "1px solid #d6d9d2", borderRadius: "0 0 8px 8px", padding: "18px 0" }}>
          <div style={{ textAlign: "center", fontSize: 11.5, color: "#9aa093" }}>No events this month.</div>
        </div>
      )}

      {!empty && weeks.map((w, wi) => {
        const last = wi === weeks.length - 1;
        // Flatten this week's events with their weekday index for left-offset.
        const cells: { e: CalEvent; idx: number }[] = [];
        w.forEach((d, idx) => {
          if (d && byDay[d]) byDay[d].forEach((e) => cells.push({ e, idx }));
        });
        const cap = expand ? cells.length : 4;
        const overflow = cells.length - cap;
        return (
          <div key={wi} className="wk" style={last ? { borderBottom: "1px solid #d6d9d2", borderRadius: "0 0 8px 8px" } : undefined}>
            <div className="nums">
              {w.map((d, i) => <div key={i}>{d || ""}</div>)}
            </div>
            {cells.slice(0, cap).map(({ e, idx }, i) => (
              <div
                key={`${e.key}-${i}`}
                className="cal-bar"
                title={e.sub || undefined}
                onClick={() => { if (e.kind !== "holiday") onOpen?.(e.projectId); }}
                style={{ ["--bar" as string]: e.color, marginLeft: `${(idx * 14.2857).toFixed(3)}%` }}
              >{e.label}</div>
            ))}
            {overflow > 0 && (
              <div className="cal-more" onClick={onExpand}>+{overflow} more</div>
            )}
          </div>
        );
      })}
    </>
  );
}

function WeekAgenda({ weeks, year, month, byDay, onOpen }: {
  weeks: (number | null)[][];
  year: number;
  month: number;
  byDay: Record<number, CalEvent[]>;
  onOpen?: (projectId: number) => void;
}) {
  const days = (weeks[0] ?? []).filter((d): d is number => d != null);
  const items = days.flatMap((d) => (byDay[d] ?? []).map((e) => ({ d, e })));
  if (!items.length) {
    return <div style={emptyBox}>No events this week.</div>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
      {items.map(({ d, e }, i) => {
        const label = new Date(year, month, d).toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short" });
        return (
          <div key={`${e.key}-${i}`} className="card" onClick={() => onOpen?.(e.projectId)} style={{ padding: "11px 13px", borderLeft: `4px solid ${e.color}`, cursor: "pointer" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <span style={{ fontSize: 13.5, fontWeight: 800, color: "#11140f", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.label}</span>
              {e.status && (
                <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", padding: "3px 9px", borderRadius: 20, background: `color-mix(in srgb, ${e.color} 16%, white)`, color: "#0c3f39", flex: "none" }}>{e.status}</span>
              )}
            </div>
            {/* Date is a fixed-width, no-wrap column so a long venue never overlaps or clips it (owner-reported). */}
            <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 5, fontSize: 11.5, color: "#767b6e", minWidth: 0 }}>
              <span style={{ fontWeight: 700, color: "#414539", whiteSpace: "nowrap", flex: "none" }}>{label}</span>
              {e.sub && (<><span style={{ opacity: .4, flex: "none" }}>·</span><span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>{e.sub}</span></>)}
              {e.organizer && (<><span style={{ opacity: .4, flex: "none" }}>·</span><span style={{ whiteSpace: "nowrap", flex: "none" }}>{e.organizer}</span></>)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function uniqueSorted(vals: (string | null)[]): string[] {
  const set = new Set<string>();
  for (const v of vals) if (v) set.add(v);
  return [...set].sort();
}

const emptyBox: React.CSSProperties = {
  textAlign: "center", color: "#9aa093", fontSize: 12, padding: "26px 0",
};
