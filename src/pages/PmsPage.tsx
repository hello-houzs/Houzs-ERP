import { Link } from "react-router-dom";
import { useMemo, useState } from "react";
import { Search, X, Plus } from "lucide-react";
import {
  BRANDS, STATES, fmtRM, computeCosts,
  type Brand, type EventType, type EventStatus, type MalaysianState, type HouzsEvent, type WorkflowFlag,
} from "@/lib/mock-data";
import { useAllEvents } from "@/lib/events-store";
import { FILTER_SELECT } from "@/lib/ui-tokens";

const WORKFLOW_KEYS: (keyof HouzsEvent)[] = [
  "agreementApproval", "floorplan", "sendFloorplanToDesigner", "threeDCheckedByMgt",
  "threeDApprovedByPeter", "threeDUploadedInNotion", "weekendActivityTheme", "licenseMajlis",
  "workLoadingBayPermit", "decoCoffeeTable", "secDepoRefund",
];

function isDone(v: WorkflowFlag) { return v === "TRUE" || v === "DONE"; }
function isSkipped(v: WorkflowFlag) { return v === "NO NEED"; }

function countWorkflow(e: HouzsEvent) {
  let done = 0, skipped = 0;
  for (const k of WORKFLOW_KEYS) {
    const v = e[k] as WorkflowFlag;
    if (isDone(v)) done++;
    else if (isSkipped(v)) skipped++;
  }
  return { done, skipped, required: WORKFLOW_KEYS.length - skipped };
}

function fmtDateShort(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export default function PmsPage() {
  const [brand, setBrand] = useState<Brand | "ALL">("ALL");
  const [eventType, setEventType] = useState<EventType | "ALL">("ALL");
  const [status, setStatus] = useState<EventStatus | "ALL">("ALL");
  const [state, setState] = useState<MalaysianState | "ALL">("ALL");
  const [query, setQuery] = useState("");

  const allEvents = useAllEvents();

  const filtered = useMemo(() => {
    return allEvents.filter((e) => {
      if (brand !== "ALL" && e.brand !== brand) return false;
      if (eventType !== "ALL" && e.eventType !== eventType) return false;
      if (status !== "ALL" && e.status !== status) return false;
      if (state !== "ALL" && e.state !== state) return false;
      if (query && !`${e.organizer} ${e.venue} ${e.a42} ${e.pic ?? ""}`.toLowerCase().includes(query.toLowerCase()))
        return false;
      return true;
    });
  }, [allEvents, brand, eventType, status, state, query]);

  const groups = useMemo(() => ({
    inProgress: filtered.filter((e) => e.progress === "IN PROGRESS"),
    notStarted: filtered.filter((e) => e.progress === "NOT STARTED"),
    completed:  filtered.filter((e) => e.progress === "COMPLETED"),
  }), [filtered]);

  const activeFilterCount =
    (brand !== "ALL" ? 1 : 0) + (eventType !== "ALL" ? 1 : 0) + (status !== "ALL" ? 1 : 0) +
    (state !== "ALL" ? 1 : 0) + (query ? 1 : 0);

  function clearAll() {
    setBrand("ALL"); setEventType("ALL"); setStatus("ALL"); setState("ALL"); setQuery("");
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-[#0A1F2E]">Project Details</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {filtered.length} of {allEvents.length} projects
          </p>
        </div>
        <Link
          to="/events/new"
          className="h-9 px-3.5 rounded-md bg-[#0F766E] text-white text-[12px] font-semibold hover:bg-[#0c5f59] inline-flex items-center gap-1.5"
        >
          <Plus className="h-4 w-4" /> New Event
        </Link>
      </div>

      {/* Filter bar — search + dropdowns */}
      <div className="rounded-lg border border-[#DDE5E5] bg-white px-3 py-2 flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-[220px] max-w-[320px]">
          <Search className="h-3.5 w-3.5 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input
            placeholder="Search organizer, venue, PIC…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-8 w-full rounded-md border border-[#DDE5E5] pl-7 pr-2 text-[11px] focus:outline-none focus:ring-2 focus:ring-[#0F766E]/30 focus:border-[#0F766E]"
          />
        </div>

        <select value={status} onChange={(e) => setStatus(e.target.value as EventStatus | "ALL")} className={FILTER_SELECT}>
          <option value="ALL">All status</option>
          <option value="CONFIRMED">Confirmed</option>
          <option value="PENDING">Pending</option>
          <option value="CANCELLED">Cancelled</option>
        </select>

        <select value={eventType} onChange={(e) => setEventType(e.target.value as EventType | "ALL")} className={FILTER_SELECT}>
          <option value="ALL">All types</option>
          <option value="SOLO">Solo</option>
          <option value="EXHIBITION">Exhibition</option>
        </select>

        <select value={brand} onChange={(e) => setBrand(e.target.value as Brand | "ALL")} className={FILTER_SELECT}>
          <option value="ALL">All brands</option>
          {BRANDS.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>

        <select value={state} onChange={(e) => setState(e.target.value as MalaysianState | "ALL")} className={FILTER_SELECT}>
          <option value="ALL">All states</option>
          {STATES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>

        {activeFilterCount > 0 && (
          <button onClick={clearAll}
            className="h-8 px-2 rounded-md text-[10px] font-semibold text-gray-500 hover:text-red-600 inline-flex items-center gap-1">
            <X className="h-3 w-3" /> Clear
          </button>
        )}
      </div>

      {/* Groups */}
      {[
        { title: "In Progress", rows: groups.inProgress, accent: "bg-amber-500" },
        { title: "Not Started", rows: groups.notStarted, accent: "bg-gray-400" },
        { title: "Completed",   rows: groups.completed,  accent: "bg-blue-500" },
      ].map((grp) => (
        <div key={grp.title}>
          <div className="flex items-center gap-2 mb-2">
            <span className={`h-2 w-2 rounded-full ${grp.accent}`} />
            <span className="text-[11px] font-semibold text-gray-700">{grp.title}</span>
            <span className="text-[10px] text-gray-400">{grp.rows.length}</span>
          </div>

          {grp.rows.length === 0 ? (
            <div className="rounded-lg border border-dashed border-[#DDE5E5] p-5 text-center text-[11px] text-gray-400">
              None
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3">
              {grp.rows.map((e) => {
                const wf = countWorkflow(e);
                const donePct = wf.required > 0 ? (wf.done / wf.required) * 100 : 0;
                const c = computeCosts(e);
                const np = c.netProfit;
                const npPct = c.netProfitPct;
                const dateRange = `${fmtDateShort(e.startDate)} – ${fmtDateShort(e.endDate)}`;
                const title = `${dateRange} · [${e.brand}] ${e.venue}`;
                const subtitle = e.eventType === "SOLO"
                  ? `SOLO · ${e.state}`
                  : `${e.organizer} · ${e.state}`;

                return (
                  <Link
                    key={e.a42}
                    to={`/events/${encodeURIComponent(e.a42)}`}
                    title={e.a42}
                    className="block rounded-lg border border-[#DDE5E5] bg-white hover:border-[#0F766E] hover:shadow-sm transition overflow-hidden"
                  >
                    {/* Header — date · [brand] venue */}
                    <div className="px-4 pt-3 pb-2.5">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="text-[13px] font-bold text-[#0A1F2E] leading-snug break-words">
                            {title}
                          </div>
                          <div className="text-[11px] text-gray-500 truncate mt-0.5">
                            {subtitle}
                          </div>
                        </div>
                        <span className={`shrink-0 px-1.5 py-[1px] rounded text-[9px] font-semibold ${
                          e.status === "CONFIRMED" ? "bg-[#0F766E]/10 text-[#0F766E]" :
                          e.status === "PENDING"   ? "bg-amber-100 text-amber-700" :
                                                      "bg-red-100 text-red-700"}`}>{e.status}</span>
                      </div>
                    </div>

                    {/* Metadata — single line */}
                    <div className="px-4 py-1.5 bg-[#FAFBFB] border-y border-[#F0F3F3] text-[10px] text-gray-500 flex flex-wrap gap-x-2.5 gap-y-0.5 tabular-nums">
                      <span>{e.durationDays}d</span>
                      <span>·</span>
                      <span>{e.boothNo}</span>
                      <span>·</span>
                      <span>{e.sizeSqm} sqm</span>
                      {e.pic && <><span>·</span><span>{e.pic}</span></>}
                    </div>

                    {/* Workflow — progress bar only, no badges */}
                    <div className="px-4 py-2.5">
                      <div className="flex items-center justify-between mb-1 text-[10px]">
                        <span className="text-gray-500">
                          Workflow <span className="text-gray-400">· {wf.done}/{wf.required}</span>
                        </span>
                        <span className={`font-semibold tabular-nums ${donePct === 100 ? "text-[#0F766E]" : "text-amber-600"}`}>
                          {donePct.toFixed(0)}%
                        </span>
                      </div>
                      <div className="h-1 rounded-full bg-gray-100 overflow-hidden">
                        <div className={`h-full transition-all ${donePct === 100 ? "bg-[#0F766E]" : "bg-amber-400"}`}
                          style={{ width: `${donePct}%` }} />
                      </div>
                    </div>

                    {/* Financial — compact single row */}
                    <div className="px-4 pb-3 pt-1 flex items-end justify-between gap-2 border-t border-[#F0F3F3]">
                      <div className="text-[10px] text-gray-500">
                        Sales <span className="text-[#0A1F2E] font-semibold tabular-nums">{fmtRM(e.totalSalesRm)}</span>
                        <span className="text-gray-300 mx-1">·</span>
                        Cost <span className="text-[#0A1F2E] font-semibold tabular-nums">{fmtRM(c.totalCost)}</span>
                      </div>
                      <div className="text-[10px] text-gray-500 text-right">
                        Net
                        <span className={`ml-1 font-bold tabular-nums ${np >= 0 ? "text-[#0F766E]" : "text-red-600"}`}>
                          {fmtRM(np)}
                        </span>
                        <span className={`ml-1 text-[9px] ${np >= 0 ? "text-[#0F766E]/70" : "text-red-400"}`}>
                          ({npPct.toFixed(0)}%)
                        </span>
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
