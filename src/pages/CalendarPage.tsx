import { Link } from "react-router-dom";
import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Plus, Search, X, Flag, GraduationCap, Filter } from "lucide-react";
import {
  BRANDS, STATES, calendarTitle,
  type Brand, type HouzsEvent, type EventType, type EventStatus,
  type EventProgress, type MalaysianState,
} from "@/lib/mock-data";
import { useAllEvents } from "@/lib/events-store";
import { buildHolidayIndex } from "@/lib/holidays";
import { FILTER_SELECT } from "@/lib/ui-tokens";
import { useCurrentUser, canViewEvent, isAdmin } from "@/lib/auth-store";

// Google-Calendar style brand palette (all blue-purple family on the real sheet,
// but we tint per-brand for quick visual scan while staying close to the look).
const BRAND_COLOR: Record<Brand, string> = {
  AKEMI:      "bg-[#4F6BED] hover:bg-[#3D59DB]",   // indigo
  ZANOTTI:    "bg-[#7B5BD6] hover:bg-[#6849C4]",   // purple
  ERGOTEX:    "bg-[#1A73E8] hover:bg-[#0F5CC7]",   // google blue
  DUNLOPILLO: "bg-[#0B8043] hover:bg-[#096B38]",   // google green
};
const BRAND_DOT: Record<Brand, string> = {
  AKEMI: "bg-[#4F6BED]",
  ZANOTTI: "bg-[#7B5BD6]",
  ERGOTEX: "bg-[#1A73E8]",
  DUNLOPILLO: "bg-[#0B8043]",
};

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// Monday-first (ISO-8601, standard for Malaysian business calendars)
const WEEKDAYS_EN = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
const WEEKDAYS_ZH = ["一", "二", "三", "四", "五", "六", "日"];

function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseISO(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

function diffDays(a: Date, b: Date): number {
  const ms = a.getTime() - b.getTime();
  return Math.round(ms / 86400000);
}

/** Build 6 week rows, each an array of 7 Date cells, Monday-first. */
function buildMonthWeeks(year: number, month: number): Date[][] {
  const first = new Date(year, month, 1);
  // Mon=0, Tue=1, ... Sun=6
  const mondayOffset = (first.getDay() + 6) % 7;
  const gridStart = addDays(first, -mondayOffset);
  const weeks: Date[][] = [];
  for (let w = 0; w < 6; w++) {
    const row: Date[] = [];
    for (let d = 0; d < 7; d++) {
      row.push(addDays(gridStart, w * 7 + d));
    }
    weeks.push(row);
  }
  return weeks;
}

/** A single bar segment inside one week row. */
interface Segment {
  event: HouzsEvent;
  startCol: number; // 0..6
  span: number;     // 1..7
  continuesLeft: boolean;
  continuesRight: boolean;
  track: number;    // vertical lane within the week
}

/** Slice events into per-week segments and assign tracks to avoid overlap. */
function layoutWeek(week: Date[], events: HouzsEvent[]): Segment[] {
  const weekStart = week[0];
  const weekEnd = week[6];

  // Pick events that intersect this week
  const intersecting = events.filter((e) => {
    const s = parseISO(e.startDate);
    const en = parseISO(e.endDate);
    return en >= weekStart && s <= weekEnd;
  });

  // Sort: longer spans first, then earlier start — so bars with more columns
  // claim low tracks and shorter bars slot in below.
  intersecting.sort((a, b) => {
    const aLen = diffDays(parseISO(a.endDate), parseISO(a.startDate));
    const bLen = diffDays(parseISO(b.endDate), parseISO(b.startDate));
    if (bLen !== aLen) return bLen - aLen;
    return a.startDate.localeCompare(b.startDate);
  });

  // Track occupancy: tracks[track][col] = taken?
  const tracks: boolean[][] = [];
  const segs: Segment[] = [];

  for (const e of intersecting) {
    const s = parseISO(e.startDate);
    const en = parseISO(e.endDate);
    const clampedStart = s < weekStart ? weekStart : s;
    const clampedEnd = en > weekEnd ? weekEnd : en;
    const startCol = diffDays(clampedStart, weekStart);
    const endCol = diffDays(clampedEnd, weekStart);
    const span = endCol - startCol + 1;

    // Find first free track
    let track = 0;
    while (true) {
      if (!tracks[track]) tracks[track] = new Array(7).fill(false);
      let free = true;
      for (let c = startCol; c <= endCol; c++) {
        if (tracks[track][c]) { free = false; break; }
      }
      if (free) {
        for (let c = startCol; c <= endCol; c++) tracks[track][c] = true;
        break;
      }
      track++;
    }

    segs.push({
      event: e,
      startCol,
      span,
      continuesLeft: s < weekStart,
      continuesRight: en > weekEnd,
      track,
    });
  }

  return segs;
}

const MAX_VISIBLE_TRACKS = 4;

export default function CalendarPage() {
  const currentUser = useCurrentUser();
  const userIsAdmin = isAdmin(currentUser);

  const allEvents = useAllEvents();
  const visibleEvents = useMemo(
    () => allEvents.filter((e) => canViewEvent(currentUser, e)),
    [allEvents, currentUser]
  );
  const today = new Date();
  const [cursor, setCursor] = useState<{ y: number; m: number }>({
    y: today.getFullYear(),
    m: today.getMonth(),
  });
  const [brandFilter, setBrandFilter] = useState<Brand | "ALL">("ALL");
  const [typeFilter, setTypeFilter] = useState<EventType | "ALL">("ALL");
  const [stateFilter, setStateFilter] = useState<MalaysianState | "ALL">("ALL");
  const [statusFilter, setStatusFilter] = useState<EventStatus | "ALL">("ALL");
  const [progressFilter, setProgressFilter] = useState<EventProgress | "ALL">("ALL");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [organizerFilter, setOrganizerFilter] = useState<string>("ALL");
  const [search, setSearch] = useState("");
  const [showPublicHolidays, setShowPublicHolidays] = useState(true);
  const [showSchoolHolidays, setShowSchoolHolidays] = useState(true);

  const organizerOptions = useMemo(() => {
    const set = new Set<string>();
    for (const e of visibleEvents) if (e.organizer) set.add(e.organizer);
    return Array.from(set).sort();
  }, [visibleEvents]);

  const filtered = useMemo(() => {
    const q = search.trim().toUpperCase();
    return visibleEvents.filter((e) => {
      if (brandFilter !== "ALL" && e.brand !== brandFilter) return false;
      if (typeFilter !== "ALL" && e.eventType !== typeFilter) return false;
      if (stateFilter !== "ALL" && e.state !== stateFilter) return false;
      if (statusFilter !== "ALL" && e.status !== statusFilter) return false;
      if (progressFilter !== "ALL" && e.progress !== progressFilter) return false;
      if (organizerFilter !== "ALL" && e.organizer !== organizerFilter) return false;
      if (q) {
        const hay = [
          e.a42, e.venue, e.organizer, e.pic ?? "", e.boothNo,
          e.contractor, e.state, e.brand, e.eventType,
        ].join(" ").toUpperCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [
    visibleEvents, brandFilter, typeFilter, stateFilter, statusFilter,
    progressFilter, organizerFilter, search,
  ]);

  const activeFilterCount =
    (brandFilter !== "ALL" ? 1 : 0) +
    (typeFilter !== "ALL" ? 1 : 0) +
    (stateFilter !== "ALL" ? 1 : 0) +
    (statusFilter !== "ALL" ? 1 : 0) +
    (progressFilter !== "ALL" ? 1 : 0) +
    (organizerFilter !== "ALL" ? 1 : 0) +
    (search.trim() ? 1 : 0);

  function resetFilters() {
    setBrandFilter("ALL");
    setTypeFilter("ALL");
    setStateFilter("ALL");
    setStatusFilter("ALL");
    setProgressFilter("ALL");
    setOrganizerFilter("ALL");
    setSearch("");
  }

  const weeks = useMemo(() => buildMonthWeeks(cursor.y, cursor.m), [cursor]);

  // Holiday index — covers the full 6-week grid so leading/trailing days get marked too
  const holidayIndex = useMemo(() => {
    if (weeks.length === 0) return { public: {}, school: {} };
    const fromISO = toISODate(weeks[0][0]);
    const toISOStr = toISODate(weeks[weeks.length - 1][6]);
    return buildHolidayIndex(fromISO, toISOStr);
  }, [weeks]);

  const weekLayouts = useMemo(
    () => weeks.map((w) => layoutWeek(w, filtered)),
    [weeks, filtered]
  );

  const monthLabel = `${MONTH_NAMES[cursor.m]} ${cursor.y}`;
  const todayISO = toISODate(today);

  function prev() {
    setCursor((c) => {
      const m = c.m - 1;
      return m < 0 ? { y: c.y - 1, m: 11 } : { y: c.y, m };
    });
  }
  function next() {
    setCursor((c) => {
      const m = c.m + 1;
      return m > 11 ? { y: c.y + 1, m: 0 } : { y: c.y, m };
    });
  }
  function goToday() {
    setCursor({ y: today.getFullYear(), m: today.getMonth() });
  }

  const monthlyCount = useMemo(() => {
    return filtered.filter((e) => {
      const d = parseISO(e.startDate);
      return d.getFullYear() === cursor.y && d.getMonth() === cursor.m;
    }).length;
  }, [filtered, cursor]);

  const pillBase = "h-8 px-2.5 rounded-md text-[11px] font-semibold border transition whitespace-nowrap";
  const pillOff = "bg-white text-gray-600 border-[#DDE5E5] hover:border-[#0F766E]";
  const pillOn = "bg-[#0F766E] text-white border-[#0F766E]";
  return (
    <div className="space-y-4">
      {/* RBAC banner for limited users */}
      {!userIsAdmin && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 flex items-center gap-2 text-[12px] text-amber-800">
          <span className="font-semibold">ℹ</span>
          Showing {visibleEvents.length} event{visibleEvents.length === 1 ? "" : "s"} assigned to you.
        </div>
      )}
      {/* Header */}
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-[#0A1F2E]">Calendar</h1>
          <p className="text-sm text-gray-500 mt-1">
            Monthly view · {monthlyCount} event{monthlyCount === 1 ? "" : "s"} starting in {MONTH_NAMES[cursor.m]}
          </p>
        </div>
        <Link
          to="/events/new"
          className="h-9 px-3.5 rounded-md bg-[#0F766E] text-white text-[12px] font-semibold hover:bg-[#0c5f59] inline-flex items-center gap-1.5"
        >
          <Plus className="h-4 w-4" /> New Event
        </Link>
      </div>

      {/* Toolbar */}
      <div className="rounded-lg border border-[#DDE5E5] bg-white p-2.5 space-y-2">
        <div className="flex flex-wrap gap-2 items-center">
        <div className="flex items-center gap-1">
          <button
            onClick={prev}
            className="h-8 w-8 rounded-md border border-[#DDE5E5] bg-white hover:border-[#0F766E] inline-flex items-center justify-center text-gray-600"
            title="Previous month"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            onClick={next}
            className="h-8 w-8 rounded-md border border-[#DDE5E5] bg-white hover:border-[#0F766E] inline-flex items-center justify-center text-gray-600"
            title="Next month"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
          <button
            onClick={goToday}
            className="h-8 px-2.5 rounded-md border border-[#DDE5E5] bg-white hover:border-[#0F766E] text-[11px] font-semibold text-gray-600"
          >
            Today
          </button>
        </div>

        <div className="text-[14px] font-bold text-[#0A1F2E] px-2">{monthLabel}</div>

        <div className="flex gap-1 ml-auto items-center">
          {/* Holiday toggles */}
          <button
            type="button"
            onClick={() => setShowPublicHolidays((v) => !v)}
            title={showPublicHolidays ? "Hide public holidays" : "Show public holidays"}
            className={`${pillBase} inline-flex items-center gap-1 ${
              showPublicHolidays
                ? "bg-red-50 text-red-700 border-red-200 hover:border-red-300"
                : pillOff
            }`}
          >
            <Flag className="h-3 w-3" /> PH
          </button>
          <button
            type="button"
            onClick={() => setShowSchoolHolidays((v) => !v)}
            title={showSchoolHolidays ? "Hide school holidays" : "Show school holidays"}
            className={`${pillBase} inline-flex items-center gap-1 ${
              showSchoolHolidays
                ? "bg-amber-50 text-amber-700 border-amber-200 hover:border-amber-300"
                : pillOff
            }`}
          >
            <GraduationCap className="h-3 w-3" /> SH
          </button>
          <span className="w-px h-5 bg-[#DDE5E5] mx-1" />
          <button
            onClick={() => setBrandFilter("ALL")}
            className={`${pillBase} ${brandFilter === "ALL" ? pillOn : pillOff}`}
          >
            ALL
          </button>
          {BRANDS.map((b) => (
            <button
              key={b}
              onClick={() => setBrandFilter(b)}
              className={`${pillBase} ${
                brandFilter === b ? `${BRAND_COLOR[b]} text-white border-transparent` : pillOff
              }`}
            >
              {b}
            </button>
          ))}
        </div>
        </div>

        {/* Row 2: search bar + mobile filter toggle (always visible) */}
        <div className="flex gap-2 items-center md:hidden">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400 pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search…"
              className="w-full h-8 pl-8 pr-3 rounded-md border border-[#DDE5E5] bg-white text-[11px]"
            />
          </div>
          <button
            type="button"
            onClick={() => setFiltersOpen((v) => !v)}
            className="h-8 px-3 rounded-md border border-[#DDE5E5] bg-white text-[11px] font-semibold text-gray-600 inline-flex items-center gap-1"
          >
            <Filter className="h-3 w-3" /> Filters
            {activeFilterCount > 0 && <span className="h-4 min-w-[16px] px-1 rounded-full bg-amber-100 text-amber-700 text-[9px]">{activeFilterCount}</span>}
          </button>
        </div>

        {/* Row 2: desktop filter dropdowns + mobile (when filtersOpen) */}
        <div className={`${filtersOpen ? "flex" : "hidden"} md:flex flex-wrap gap-2 items-center`}>
          <div className="relative flex-1 min-w-[220px] max-w-md">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400 pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search venue, organizer, PIC, booth, A42…"
              className="w-full h-8 pl-8 pr-8 rounded-md border border-[#DDE5E5] bg-white text-[11px] text-[#0A1F2E] placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-[#0F766E]/30 focus:border-[#0F766E]"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 h-5 w-5 rounded inline-flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100"
                title="Clear search"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>

          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as EventType | "ALL")}
            className={FILTER_SELECT}
            title="Event type"
          >
            <option value="ALL">All types</option>
            <option value="SOLO">SOLO</option>
            <option value="EXHIBITION">EXHIBITION</option>
          </select>

          <select
            value={stateFilter}
            onChange={(e) => setStateFilter(e.target.value as MalaysianState | "ALL")}
            className={FILTER_SELECT}
            title="State"
          >
            <option value="ALL">All states</option>
            {STATES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>

          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as EventStatus | "ALL")}
            className={FILTER_SELECT}
            title="Status"
          >
            <option value="ALL">All status</option>
            <option value="CONFIRMED">CONFIRMED</option>
            <option value="PENDING">PENDING</option>
            <option value="CANCELLED">CANCELLED</option>
          </select>

          <select
            value={organizerFilter}
            onChange={(e) => setOrganizerFilter(e.target.value)}
            className={FILTER_SELECT}
            title="Organizer"
          >
            <option value="ALL">All organizers</option>
            {organizerOptions.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>

          {activeFilterCount > 0 && (
            <button
              type="button"
              onClick={resetFilters}
              className="h-8 px-2.5 rounded-md border border-[#DDE5E5] bg-white text-[11px] font-semibold text-gray-600 hover:border-red-300 hover:text-red-600 inline-flex items-center gap-1.5"
              title="Clear all filters"
            >
              <X className="h-3 w-3" /> Clear ({activeFilterCount})
            </button>
          )}

          <div className="ml-auto text-[10px] text-gray-500 tabular-nums">
            {filtered.length} / {visibleEvents.length} events
          </div>
        </div>
      </div>

      {/* Grid */}
      <div className="rounded-lg border border-[#DDE5E5] bg-white overflow-hidden">
        {/* Weekday header — EN + ZH, Sunday-first */}
        <div className="grid grid-cols-7 bg-[#F4F7F7] border-b border-[#DDE5E5]">
          {WEEKDAYS_EN.map((w, i) => (
            <div
              key={w}
              className="px-2 py-2 border-r border-[#DDE5E5] last:border-r-0"
            >
              <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                {w}
              </div>
              <div className="text-[10px] text-gray-400">{WEEKDAYS_ZH[i]}</div>
            </div>
          ))}
        </div>

        {/* Week rows with absolute-positioned event bars */}
        {weeks.map((week, wi) => {
          const segs = weekLayouts[wi];
          const visible = segs.filter((s) => s.track < MAX_VISIBLE_TRACKS);
          const hiddenPerCol: number[] = new Array(7).fill(0);
          for (const s of segs) {
            if (s.track >= MAX_VISIBLE_TRACKS) {
              for (let c = s.startCol; c < s.startCol + s.span; c++) hiddenPerCol[c]++;
            }
          }

          return (
            <div
              key={wi}
              className="relative grid grid-cols-7 border-b border-[#F0F3F3] last:border-b-0 min-h-[132px]"
            >
              {/* Day cells background */}
              {week.map((d, di) => {
                const iso = toISODate(d);
                const inMonth = d.getMonth() === cursor.m;
                const isToday = iso === todayISO;
                const phs = showPublicHolidays ? holidayIndex.public[iso] ?? [] : [];
                const shs = showSchoolHolidays ? holidayIndex.school[iso] ?? [] : [];
                const hasPH = phs.length > 0;
                const hasSH = shs.length > 0;
                const phName = hasPH ? phs.map((h) => h.name).join(" / ") : "";
                const shName = hasSH ? shs.map((h) => h.name).join(" / ") : "";
                // Background priority: PH > SH > default (in-month / out-of-month)
                const bg = hasPH
                  ? "bg-red-50/70"
                  : hasSH
                  ? "bg-amber-50/70"
                  : inMonth
                  ? "bg-white"
                  : "bg-[#FAFBFB]";
                return (
                  <div
                    key={di}
                    className={`relative border-r border-[#F0F3F3] last:border-r-0 p-1.5 ${bg}`}
                    title={
                      [phName && `🇲🇾 ${phName}`, shName && `🎒 ${shName}`]
                        .filter(Boolean)
                        .join("\n") || undefined
                    }
                  >
                    <div className="flex items-center gap-1">
                      <span
                        className={`text-[11px] font-semibold inline-flex items-center justify-center ${
                          isToday
                            ? "h-5 w-5 rounded-full bg-[#1A73E8] text-white"
                            : hasPH
                            ? "text-red-700"
                            : inMonth
                            ? "text-[#0A1F2E]"
                            : "text-gray-300"
                        }`}
                      >
                        {d.getDate()}
                      </span>
                      {hasPH && (
                        <span
                          className="inline-block h-1.5 w-1.5 rounded-full bg-red-500 shrink-0"
                          aria-label="Public holiday"
                        />
                      )}
                      {hasSH && !hasPH && (
                        <span
                          className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500 shrink-0"
                          aria-label="School holiday"
                        />
                      )}
                    </div>
                    {/* Holiday label under the day number (truncates) */}
                    {hasPH && (
                      <div className="text-[9px] font-semibold text-red-700 truncate leading-tight mt-0.5">
                        {phs[0].name}
                      </div>
                    )}
                    {!hasPH && hasSH && (
                      <div className="text-[9px] font-medium text-amber-700 truncate leading-tight mt-0.5">
                        {shs[0].name}
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Event bars layer — absolutely positioned over cells,
                  starts below the day number (~22px) */}
              <div className="absolute inset-0 pt-[24px] px-0 pointer-events-none">
                {visible.map((s, si) => {
                  const leftPct = (s.startCol / 7) * 100;
                  const widthPct = (s.span / 7) * 100;
                  const top = s.track * 20; // 20px per track
                  const roundedL = s.continuesLeft ? "rounded-l-none" : "rounded-l";
                  const roundedR = s.continuesRight ? "rounded-r-none" : "rounded-r";
                  const title = calendarTitle(s.event);
                  return (
                    <Link
                      key={`${s.event.a42}-${si}`}
                      to={`/events/${encodeURIComponent(s.event.a42)}`}
                      title={title}
                      className={`absolute ${BRAND_COLOR[s.event.brand]} ${roundedL} ${roundedR} text-white text-[10px] font-semibold leading-tight truncate px-1.5 py-[2px] pointer-events-auto transition`}
                      style={{
                        left: `calc(${leftPct}% + 2px)`,
                        width: `calc(${widthPct}% - 4px)`,
                        top: `${top}px`,
                        height: "18px",
                      }}
                    >
                      {title}
                    </Link>
                  );
                })}

                {/* "+N more" overflow indicators per-day */}
                {hiddenPerCol.map((n, col) =>
                  n > 0 ? (
                    <div
                      key={`more-${col}`}
                      className="absolute text-[9px] text-gray-500 font-medium px-1.5"
                      style={{
                        left: `calc(${(col / 7) * 100}% + 2px)`,
                        top: `${MAX_VISIBLE_TRACKS * 20}px`,
                        width: `calc(${100 / 7}% - 4px)`,
                      }}
                    >
                      {n} more
                    </div>
                  ) : null
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-x-4 gap-y-1.5 items-center text-[10px] text-gray-500">
        <span className="font-semibold uppercase tracking-wider">Brands:</span>
        {BRANDS.map((b) => (
          <span key={b} className="inline-flex items-center gap-1.5">
            <span className={`h-2.5 w-2.5 rounded-sm ${BRAND_DOT[b]}`} />
            {b}
          </span>
        ))}
        <span className="w-px h-3 bg-[#DDE5E5]" />
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm bg-red-500" />
          Public holiday
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm bg-amber-500" />
          School holiday
        </span>
      </div>
    </div>
  );
}
