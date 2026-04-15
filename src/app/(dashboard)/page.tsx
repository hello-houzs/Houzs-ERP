"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowUp, ArrowDown, ArrowUpDown, X, Filter, Check, Minus, AlertCircle,
  Columns3, GripVertical, RotateCcw, Plus,
} from "lucide-react";
import {
  BRANDS, STATES,
  type Brand, type EventType, type EventStatus, type EventProgress,
  type MalaysianState, type WorkflowFlag, type HouzsEvent,
} from "@/lib/mock-data";
import { useAllEvents, updateEvent } from "@/lib/events-store";

// ---------- helpers ----------
function isDone(v: WorkflowFlag) { return v === "TRUE" || v === "DONE"; }
function isSkipped(v: WorkflowFlag) { return v === "NO NEED"; }
function isPending(v: WorkflowFlag) { return v === "" || v === "FALSE"; }

function WorkflowCell({ v }: { v: WorkflowFlag }) {
  if (isDone(v)) return <Check className="h-3.5 w-3.5 text-[#0F766E] mx-auto" strokeWidth={3} />;
  if (isSkipped(v)) return <Minus className="h-3.5 w-3.5 text-gray-300 mx-auto" />;
  return <span className="inline-block h-2 w-2 rounded-full bg-amber-400" title="pending" />;
}

// Click a date to open a native date picker; blur/enter commits, escape cancels.
function DateCell({
  value, min, onChange,
}: {
  value: string;
  min?: string;
  onChange: (next: string) => void;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <input
        type="date"
        defaultValue={value}
        min={min}
        autoFocus
        onBlur={(e) => {
          const v = e.currentTarget.value;
          if (v && v !== value) onChange(v);
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
          else if (e.key === "Escape") setEditing(false);
        }}
        onClick={(e) => e.stopPropagation()}
        className="h-6 rounded border border-[#0F766E] px-1 text-[11px] bg-white focus:outline-none focus:ring-2 focus:ring-[#0F766E]/30 whitespace-nowrap"
      />
    );
  }
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); e.preventDefault(); setEditing(true); }}
      className="whitespace-nowrap rounded px-1 py-0.5 hover:bg-[#0F766E]/10 hover:text-[#0F766E] transition text-left"
      title="Click to change date"
    >
      {value}
    </button>
  );
}

// ---------- unified column model ----------
interface Col {
  key: string;               // unique id
  label: string;             // header text
  kind: "base" | "workflow";
  sortable?: boolean;
  numeric?: boolean;
  align?: "right" | "center";
  sortValue?: (e: HouzsEvent) => string | number;
  render: (e: HouzsEvent) => ReactNode;
  tooltip?: string;
  defaultHidden?: boolean;
}

const ALL_COLUMNS: Col[] = [
  {
    key: "a42", label: "A42", kind: "base", sortable: true,
    sortValue: (e) => e.a42,
    render: (e) => (
      <Link href={`/events/${encodeURIComponent(e.a42)}`}
        className="text-[#0F766E] hover:underline font-mono text-[10px] max-w-[220px] truncate inline-block">
        {e.a42}
      </Link>
    ),
  },
  {
    key: "status", label: "Status", kind: "base", sortable: true,
    sortValue: (e) => e.status,
    render: (e) => (
      <span className={`px-1.5 py-[1px] rounded text-[10px] font-semibold ${
        e.status === "CONFIRMED" ? "bg-[#0F766E] text-white" :
        e.status === "PENDING" ? "bg-amber-100 text-amber-700" :
        "bg-red-100 text-red-700"
      }`}>{e.status}</span>
    ),
  },
  {
    key: "progress", label: "Progress", kind: "base", sortable: true,
    sortValue: (e) => e.progress,
    render: (e) => (
      <span className={`px-1.5 py-[1px] rounded text-[10px] font-semibold ${
        e.progress === "COMPLETED" ? "bg-blue-100 text-blue-700" :
        e.progress === "IN PROGRESS" ? "bg-amber-100 text-amber-700" :
        "bg-gray-100 text-gray-600"}`}>{e.progress}</span>
    ),
  },
  { key: "startDate", label: "Start", kind: "base", sortable: true, sortValue: (e) => e.startDate,
    render: (e) => (
      <DateCell
        value={e.startDate}
        onChange={(next) => {
          // Clamp end to >= new start so durationDays stays valid
          const end = new Date(e.endDate) < new Date(next) ? next : e.endDate;
          updateEvent(e.a42, { startDate: next, endDate: end });
        }}
      />
    ) },
  { key: "endDate", label: "End", kind: "base", sortable: true, sortValue: (e) => e.endDate,
    render: (e) => (
      <DateCell
        value={e.endDate}
        min={e.startDate}
        onChange={(next) => updateEvent(e.a42, { endDate: next })}
      />
    ) },
  { key: "durationDays", label: "Days", kind: "base", sortable: true, numeric: true, align: "center",
    sortValue: (e) => e.durationDays, render: (e) => e.durationDays },
  { key: "organizer", label: "Organizer", kind: "base", sortable: true,
    sortValue: (e) => e.organizer, render: (e) => <span className="whitespace-nowrap">{e.organizer}</span> },
  { key: "state", label: "State", kind: "base", sortable: true, sortValue: (e) => e.state, render: (e) => e.state },
  { key: "venue", label: "Venue", kind: "base", sortable: true, sortValue: (e) => e.venue,
    render: (e) => <span className="max-w-[160px] truncate inline-block">{e.venue}</span> },
  { key: "brand", label: "Brand", kind: "base", sortable: true, sortValue: (e) => e.brand,
    render: (e) => <span className="px-1.5 py-[1px] rounded text-[10px] font-semibold bg-[#0F766E]/10 text-[#0F766E]">{e.brand}</span> },
  { key: "eventType", label: "Type", kind: "base", sortable: true, sortValue: (e) => e.eventType,
    render: (e) => <span className={`px-1.5 py-[1px] rounded text-[10px] font-semibold ${e.eventType === "EXHIBITION" ? "bg-[#0A1F2E] text-white" : "bg-gray-100 text-gray-700"}`}>{e.eventType}</span> },
  { key: "contractor", label: "Contractor", kind: "base", sortable: true, sortValue: (e) => e.contractor, render: (e) => e.contractor },
  { key: "boothNo", label: "Booth", kind: "base", sortable: true, sortValue: (e) => e.boothNo,
    render: (e) => <span className="font-mono text-[10px] whitespace-nowrap">{e.boothNo}</span> },
  { key: "sizeSqm", label: "Size", kind: "base", sortable: true, numeric: true, align: "right",
    sortValue: (e) => e.sizeSqm, render: (e) => e.sizeSqm },
  { key: "pic", label: "PIC", kind: "base", sortable: true, defaultHidden: true,
    sortValue: (e) => e.pic ?? "", render: (e) => e.pic ?? "—" },
  { key: "year", label: "Year", kind: "base", sortable: true, numeric: true, defaultHidden: true,
    sortValue: (e) => e.year, render: (e) => e.year },
  { key: "month", label: "Month", kind: "base", sortable: true, defaultHidden: true,
    sortValue: (e) => e.month, render: (e) => e.month },
  // Workflow columns
  { key: "agreementApproval", label: "AGR", tooltip: "Agreement / Quotation Approval", kind: "workflow", align: "center",
    render: (e) => <WorkflowCell v={e.agreementApproval} /> },
  { key: "floorplan", label: "FP", tooltip: "Floorplan", kind: "workflow", align: "center",
    render: (e) => <WorkflowCell v={e.floorplan} /> },
  { key: "sendFloorplanToDesigner", label: "FP→D", tooltip: "Send Floorplan to Designer", kind: "workflow", align: "center",
    render: (e) => <WorkflowCell v={e.sendFloorplanToDesigner} /> },
  { key: "threeDCheckedByMgt", label: "3D-M", tooltip: "3D Checked by MGT", kind: "workflow", align: "center",
    render: (e) => <WorkflowCell v={e.threeDCheckedByMgt} /> },
  { key: "threeDApprovedByPeter", label: "3D-P", tooltip: "3D Approved by Peter", kind: "workflow", align: "center",
    render: (e) => <WorkflowCell v={e.threeDApprovedByPeter} /> },
  { key: "threeDUploadedInNotion", label: "3D-N", tooltip: "3D Uploaded in Notion", kind: "workflow", align: "center",
    render: (e) => <WorkflowCell v={e.threeDUploadedInNotion} /> },
  { key: "weekendActivityTheme", label: "WKND", tooltip: "Weekend Activity (Theme)", kind: "workflow", align: "center",
    render: (e) => <WorkflowCell v={e.weekendActivityTheme} /> },
  { key: "licenseMajlis", label: "LIC", tooltip: "License (from Majlis)", kind: "workflow", align: "center",
    render: (e) => <WorkflowCell v={e.licenseMajlis} /> },
  { key: "workLoadingBayPermit", label: "PERM", tooltip: "Work / Loading Bay Permit", kind: "workflow", align: "center",
    render: (e) => <WorkflowCell v={e.workLoadingBayPermit} /> },
  { key: "decoCoffeeTable", label: "DECO", tooltip: "Deco / Coffee Table", kind: "workflow", align: "center",
    render: (e) => <WorkflowCell v={e.decoCoffeeTable} /> },
  { key: "secDepoRefund", label: "DEPO", tooltip: "Sec Depo Refund", kind: "workflow", align: "center",
    render: (e) => <WorkflowCell v={e.secDepoRefund} /> },
];

const DEFAULT_ORDER = ALL_COLUMNS.map((c) => c.key);
const DEFAULT_HIDDEN = ALL_COLUMNS.filter((c) => c.defaultHidden).map((c) => c.key);
const STORAGE_KEY = "houzs-pm-columns-v1";

// ---------- Needs filter ----------
type NeedsFilter = "ALL" | "NEEDS_3D" | "NEEDS_FLOORPLAN" | "NEEDS_PERMIT" | "NEEDS_AGREEMENT" | "ANY_PENDING";
const WORKFLOW_KEYS: (keyof HouzsEvent)[] = [
  "agreementApproval", "floorplan", "sendFloorplanToDesigner", "threeDCheckedByMgt",
  "threeDApprovedByPeter", "threeDUploadedInNotion", "weekendActivityTheme", "licenseMajlis",
  "workLoadingBayPermit", "decoCoffeeTable", "secDepoRefund",
];
function matchesNeeds(e: HouzsEvent, f: NeedsFilter): boolean {
  switch (f) {
    case "ALL": return true;
    case "NEEDS_3D":
      return isPending(e.threeDCheckedByMgt) || isPending(e.threeDApprovedByPeter) || isPending(e.threeDUploadedInNotion);
    case "NEEDS_FLOORPLAN": return isPending(e.floorplan) || isPending(e.sendFloorplanToDesigner);
    case "NEEDS_PERMIT": return isPending(e.workLoadingBayPermit) || isPending(e.licenseMajlis);
    case "NEEDS_AGREEMENT": return isPending(e.agreementApproval);
    case "ANY_PENDING": return WORKFLOW_KEYS.some((k) => isPending(e[k] as WorkflowFlag));
  }
}

// ---------- Page ----------
export default function ProjectManagementPage() {
  // filters
  const [brand, setBrand] = useState<Brand | "ALL">("ALL");
  const [eventType, setEventType] = useState<EventType | "ALL">("ALL");
  const [status, setStatus] = useState<EventStatus | "ALL">("ALL");
  const [progress, setProgress] = useState<EventProgress | "ALL">("ALL");
  const [state, setState] = useState<MalaysianState | "ALL">("ALL");
  const [query, setQuery] = useState("");
  const [needs, setNeeds] = useState<NeedsFilter>("ALL");

  // sort
  const [sortKey, setSortKey] = useState<string>("startDate");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  // column order & visibility (persisted)
  const [order, setOrder] = useState<string[]>(DEFAULT_ORDER);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(DEFAULT_HIDDEN));
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);

  // Restore from localStorage on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { order?: string[]; hidden?: string[] };
        if (Array.isArray(parsed.order)) {
          // merge in any new cols that were added since last save (append at end)
          const known = new Set(parsed.order);
          const merged = [...parsed.order.filter((k) => ALL_COLUMNS.find((c) => c.key === k))];
          for (const k of DEFAULT_ORDER) if (!known.has(k)) merged.push(k);
          setOrder(merged);
        }
        if (Array.isArray(parsed.hidden)) setHidden(new Set(parsed.hidden));
      }
    } catch { /* ignore */ }
  }, []);

  // Persist on change
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ order, hidden: [...hidden] }));
    } catch { /* ignore */ }
  }, [order, hidden]);

  // Data pipeline — reactive events (mock + user-added + overrides)
  const allEvents = useAllEvents();
  const filtered = useMemo(() => {
    return allEvents.filter((e) => {
      if (brand !== "ALL" && e.brand !== brand) return false;
      if (eventType !== "ALL" && e.eventType !== eventType) return false;
      if (status !== "ALL" && e.status !== status) return false;
      if (progress !== "ALL" && e.progress !== progress) return false;
      if (state !== "ALL" && e.state !== state) return false;
      if (!matchesNeeds(e, needs)) return false;
      if (query && !`${e.organizer} ${e.venue} ${e.a42} ${e.contractor} ${e.pic ?? ""}`.toLowerCase().includes(query.toLowerCase()))
        return false;
      return true;
    });
  }, [allEvents, brand, eventType, status, progress, state, query, needs]);

  const sorted = useMemo(() => {
    const col = ALL_COLUMNS.find((c) => c.key === sortKey);
    if (!col || !col.sortable) return filtered;
    const numeric = col.numeric ?? false;
    const get = col.sortValue ?? (() => "");
    const copy = [...filtered];
    copy.sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      let cmp: number;
      if (numeric) cmp = (Number(va) || 0) - (Number(vb) || 0);
      else cmp = String(va ?? "").localeCompare(String(vb ?? ""));
      return sortDir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [filtered, sortKey, sortDir]);

  function toggleSort(col: Col) {
    if (!col.sortable) return;
    if (sortKey === col.key) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else { setSortKey(col.key); setSortDir("asc"); }
  }

  // Visible columns in display order
  const visibleColumns: Col[] = useMemo(() => {
    return order
      .map((k) => ALL_COLUMNS.find((c) => c.key === k))
      .filter((c): c is Col => !!c && !hidden.has(c.key));
  }, [order, hidden]);

  // Drag handlers
  function handleDragStart(key: string) { setDragKey(key); }
  function handleDragOver(e: React.DragEvent, key: string) {
    e.preventDefault();
    if (dragOverKey !== key) setDragOverKey(key);
  }
  function handleDragLeave(key: string) {
    if (dragOverKey === key) setDragOverKey(null);
  }
  function handleDrop(targetKey: string) {
    if (!dragKey || dragKey === targetKey) {
      setDragKey(null); setDragOverKey(null); return;
    }
    setOrder((prev) => {
      const next = prev.filter((k) => k !== dragKey);
      const idx = next.indexOf(targetKey);
      if (idx < 0) return prev;
      next.splice(idx, 0, dragKey);
      return next;
    });
    setDragKey(null); setDragOverKey(null);
  }
  function handleDragEnd() { setDragKey(null); setDragOverKey(null); }

  function resetColumns() {
    setOrder(DEFAULT_ORDER);
    setHidden(new Set(DEFAULT_HIDDEN));
  }

  // UI helpers
  const activeFilterCount =
    (brand !== "ALL" ? 1 : 0) + (eventType !== "ALL" ? 1 : 0) + (status !== "ALL" ? 1 : 0) +
    (progress !== "ALL" ? 1 : 0) + (state !== "ALL" ? 1 : 0) + (needs !== "ALL" ? 1 : 0) + (query ? 1 : 0);

  function clearAll() {
    setBrand("ALL"); setEventType("ALL"); setStatus("ALL");
    setProgress("ALL"); setState("ALL"); setQuery(""); setNeeds("ALL");
  }

  const needsCounters = useMemo(() => ({
    any: allEvents.filter((e) => matchesNeeds(e, "ANY_PENDING")).length,
    agreement: allEvents.filter((e) => matchesNeeds(e, "NEEDS_AGREEMENT")).length,
    floorplan: allEvents.filter((e) => matchesNeeds(e, "NEEDS_FLOORPLAN")).length,
    threeD: allEvents.filter((e) => matchesNeeds(e, "NEEDS_3D")).length,
    permit: allEvents.filter((e) => matchesNeeds(e, "NEEDS_PERMIT")).length,
  }), [allEvents]);

  const pillBase = "h-8 px-2.5 rounded-md text-[11px] font-semibold border transition whitespace-nowrap";
  const pillOff = "bg-white text-gray-600 border-[#DDE5E5] hover:border-[#0F766E]";
  const pillOn = "bg-[#0F766E] text-white border-[#0F766E]";

  const selectClass =
    "h-8 rounded-md border border-[#DDE5E5] bg-white px-2 pr-6 text-[11px] font-medium text-gray-700 focus:outline-none focus:ring-2 focus:ring-[#0F766E]/30 focus:border-[#0F766E] cursor-pointer appearance-none bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2212%22 height=%2212%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%236b7280%22 stroke-width=%222%22><path d=%22M6 9l6 6 6-6%22/></svg>')] bg-no-repeat bg-[right_0.35rem_center]";

  const baseCount = ALL_COLUMNS.filter((c) => c.kind === "base").length;
  const workflowCount = ALL_COLUMNS.filter((c) => c.kind === "workflow").length;
  const visibleBaseCount = visibleColumns.filter((c) => c.kind === "base").length;
  const visibleWorkflowCount = visibleColumns.filter((c) => c.kind === "workflow").length;

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-[#0A1F2E]">Project Management</h1>
          <p className="text-sm text-gray-500 mt-1">
            Operational truth · 11 PM workflow checkpoints · drag column headers to reorder · click
            <Columns3 className="inline h-3.5 w-3.5 mx-1" />
            to show/hide columns · click any date to edit
          </p>
        </div>
        <Link
          href="/events/new"
          className="h-9 px-3.5 rounded-md bg-[#0F766E] text-white text-[12px] font-semibold hover:bg-[#0c5f59] inline-flex items-center gap-1.5 shrink-0"
        >
          <Plus className="h-4 w-4" /> New Event
        </Link>
      </div>

      {/* Needs attention */}
      <div className="rounded-lg border border-[#DDE5E5] bg-white p-2.5 flex flex-wrap gap-2 items-center">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-gray-500 px-1">
          <AlertCircle className="h-3.5 w-3.5" /> NEEDS ATTENTION
        </div>
        {([
          ["ALL", "Show all", null],
          ["ANY_PENDING", "Any pending", needsCounters.any],
          ["NEEDS_AGREEMENT", "No agreement", needsCounters.agreement],
          ["NEEDS_FLOORPLAN", "No floorplan", needsCounters.floorplan],
          ["NEEDS_3D", "No 3D done", needsCounters.threeD],
          ["NEEDS_PERMIT", "No permit", needsCounters.permit],
        ] as const).map(([k, label, count]) => (
          <button key={k} onClick={() => setNeeds(k as NeedsFilter)}
            className={`${pillBase} inline-flex items-center gap-1.5 ${needs === k ? "bg-amber-500 text-white border-amber-500" : pillOff}`}>
            {label}
            {count !== null && (
              <span className={`h-4 min-w-[18px] px-1 rounded-full text-[9px] flex items-center justify-center ${
                needs === k ? "bg-white/25 text-white" : "bg-gray-100 text-gray-500"
              }`}>{count}</span>
            )}
          </button>
        ))}
      </div>

      {/* Main filter bar — compact dropdowns */}
      <div className="rounded-lg border border-[#DDE5E5] bg-white px-3 py-2 flex flex-wrap gap-2 items-center">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-gray-500">
          <Filter className="h-3.5 w-3.5" />
          {activeFilterCount > 0 && (
            <span className="h-4 min-w-[16px] px-1 rounded-full bg-[#0F766E] text-white text-[9px] flex items-center justify-center">
              {activeFilterCount}
            </span>
          )}
        </div>

        <input
          placeholder="Search A42 / organizer / venue / contractor / PIC…"
          value={query} onChange={(e) => setQuery(e.target.value)}
          className="h-8 rounded-md border border-[#DDE5E5] px-2.5 text-[11px] focus:outline-none focus:ring-2 focus:ring-[#0F766E]/30 focus:border-[#0F766E] w-56"
        />

        <select value={status} onChange={(e) => setStatus(e.target.value as EventStatus | "ALL")} className={selectClass}>
          <option value="ALL">All status</option>
          <option value="CONFIRMED">Confirmed</option>
          <option value="PENDING">Pending</option>
          <option value="CANCELLED">Cancelled</option>
        </select>

        <select value={progress} onChange={(e) => setProgress(e.target.value as EventProgress | "ALL")} className={selectClass}>
          <option value="ALL">All progress</option>
          <option value="NOT STARTED">Not started</option>
          <option value="IN PROGRESS">In progress</option>
          <option value="COMPLETED">Completed</option>
        </select>

        <select value={eventType} onChange={(e) => setEventType(e.target.value as EventType | "ALL")} className={selectClass}>
          <option value="ALL">All types</option>
          <option value="SOLO">Solo</option>
          <option value="EXHIBITION">Exhibition</option>
        </select>

        <select value={brand} onChange={(e) => setBrand(e.target.value as Brand | "ALL")} className={selectClass}>
          <option value="ALL">All brands</option>
          {BRANDS.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>

        <select value={state} onChange={(e) => setState(e.target.value as MalaysianState | "ALL")} className={selectClass}>
          <option value="ALL">All states</option>
          {STATES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>

        {activeFilterCount > 0 && (
          <button onClick={clearAll}
            className="h-8 px-2 rounded-md text-[10px] font-semibold text-gray-500 hover:text-red-600 inline-flex items-center gap-1">
            <X className="h-3 w-3" /> Clear
          </button>
        )}

        {/* Columns button */}
        <div className="relative ml-auto">
          <button
            onClick={() => setColumnsOpen(!columnsOpen)}
            className={`${pillBase} inline-flex items-center gap-1.5 ${columnsOpen ? pillOn : pillOff}`}
          >
            <Columns3 className="h-3.5 w-3.5" />
            Columns
            <span className={`h-4 min-w-[18px] px-1 rounded-full text-[9px] flex items-center justify-center ${
              columnsOpen ? "bg-white/25 text-white" : "bg-gray-100 text-gray-500"
            }`}>
              {visibleColumns.length}/{ALL_COLUMNS.length}
            </span>
          </button>

          {columnsOpen && (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setColumnsOpen(false)} />
              <div className="absolute right-0 top-full mt-1 z-30 w-72 rounded-lg border border-[#DDE5E5] bg-white shadow-lg overflow-hidden">
                <div className="flex items-center justify-between px-3 py-2 border-b border-[#DDE5E5] bg-[#F4F7F7]">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-[#0A1F2E]">
                    Columns ({visibleColumns.length})
                  </span>
                  <button onClick={resetColumns}
                    className="text-[10px] font-semibold text-[#0F766E] hover:underline inline-flex items-center gap-1">
                    <RotateCcw className="h-3 w-3" /> Reset
                  </button>
                </div>

                <div className="max-h-[420px] overflow-y-auto">
                  <div className="px-3 py-1.5 text-[9px] font-semibold uppercase tracking-wider text-gray-400 bg-[#FAFBFB]">
                    Base fields ({visibleBaseCount}/{baseCount})
                  </div>
                  {ALL_COLUMNS.filter((c) => c.kind === "base").map((c) => (
                    <label key={c.key}
                      className="flex items-center gap-2 px-3 py-1.5 text-[12px] hover:bg-[#F4F7F7] cursor-pointer">
                      <input type="checkbox" checked={!hidden.has(c.key)}
                        onChange={(e) => {
                          setHidden((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.delete(c.key); else next.add(c.key);
                            return next;
                          });
                        }}
                        className="h-3.5 w-3.5 accent-[#0F766E]" />
                      <span className="text-[#0A1F2E]">{c.label}</span>
                    </label>
                  ))}
                  <div className="px-3 py-1.5 text-[9px] font-semibold uppercase tracking-wider text-gray-400 bg-[#FAFBFB] border-t border-[#F0F3F3]">
                    PM workflow ({visibleWorkflowCount}/{workflowCount})
                  </div>
                  {ALL_COLUMNS.filter((c) => c.kind === "workflow").map((c) => (
                    <label key={c.key}
                      className="flex items-center gap-2 px-3 py-1.5 text-[12px] hover:bg-[#F4F7F7] cursor-pointer">
                      <input type="checkbox" checked={!hidden.has(c.key)}
                        onChange={(e) => {
                          setHidden((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.delete(c.key); else next.add(c.key);
                            return next;
                          });
                        }}
                        className="h-3.5 w-3.5 accent-[#0F766E]" />
                      <span className="text-[#0F766E] font-mono text-[11px]">{c.label}</span>
                      {c.tooltip && <span className="text-gray-400 text-[10px] truncate">{c.tooltip}</span>}
                    </label>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-3 text-[10px] text-gray-500 px-1">
        <span className="inline-flex items-center gap-1"><Check className="h-3 w-3 text-[#0F766E]" strokeWidth={3} /> done</span>
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-amber-400" /> pending</span>
        <span className="inline-flex items-center gap-1"><Minus className="h-3 w-3 text-gray-300" /> N/A</span>
        <span className="text-gray-400 ml-auto">{sorted.length} matched · drag <GripVertical className="inline h-3 w-3" /> to reorder</span>
      </div>

      {/* Table */}
      <div className="rounded-lg border border-[#DDE5E5] bg-white overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead className="bg-[#F4F7F7] text-[#0A1F2E] border-b border-[#DDE5E5]">
              <tr className="text-left">
                {visibleColumns.map((c) => {
                  const isSorted = sortKey === c.key;
                  const isDragOver = dragOverKey === c.key && dragKey !== c.key;
                  const isDragging = dragKey === c.key;
                  return (
                    <th
                      key={c.key}
                      draggable
                      onDragStart={() => handleDragStart(c.key)}
                      onDragOver={(e) => handleDragOver(e, c.key)}
                      onDragLeave={() => handleDragLeave(c.key)}
                      onDrop={() => handleDrop(c.key)}
                      onDragEnd={handleDragEnd}
                      onClick={() => toggleSort(c)}
                      title={c.tooltip ?? c.label}
                      className={`group px-1.5 py-2 font-semibold whitespace-nowrap select-none transition
                        ${c.kind === "workflow" ? "bg-[#EEF4F3] text-[#0F766E] text-[10px] border-l border-[#DDE5E5]" : ""}
                        ${c.align === "right" ? "text-right" : c.align === "center" ? "text-center" : ""}
                        ${isSorted ? "text-[#0F766E]" : ""}
                        ${isDragging ? "opacity-30" : ""}
                        ${isDragOver ? "bg-[#0F766E]/20 border-l-2 border-[#0F766E]" : ""}
                        ${c.sortable !== false ? "cursor-pointer hover:bg-[#ECF1F1]" : "cursor-grab"}
                      `}
                    >
                      <span className="inline-flex items-center gap-1">
                        <GripVertical className="h-3 w-3 text-gray-300 opacity-0 group-hover:opacity-100 transition cursor-grab" />
                        {c.label}
                        {c.sortable && (
                          isSorted
                            ? (sortDir === "asc"
                                ? <ArrowUp className="h-3 w-3 text-[#0F766E]" />
                                : <ArrowDown className="h-3 w-3 text-[#0F766E]" />)
                            : <ArrowUpDown className="h-3 w-3 text-gray-300" />
                        )}
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {sorted.map((e) => (
                <tr key={e.a42} className="border-b border-[#F0F3F3] hover:bg-[#F4F7F7]">
                  {visibleColumns.map((c) => (
                    <td
                      key={c.key}
                      className={`px-1.5 py-1.5
                        ${c.kind === "workflow" ? "text-center border-l border-[#F0F3F3]" : ""}
                        ${c.align === "right" ? "text-right" : c.align === "center" ? "text-center" : ""}
                      `}
                    >
                      {c.render(e)}
                    </td>
                  ))}
                </tr>
              ))}
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={visibleColumns.length} className="px-3 py-8 text-center text-gray-400 text-[11px]">
                    No events match the current filters
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="px-3 py-2 text-[11px] text-gray-500 border-t border-[#DDE5E5] bg-[#FAFBFB] flex items-center justify-between">
          <span>{sorted.length} record(s) · {visibleColumns.length} column(s) · preferences saved to this browser</span>
          <Link href="/finance" className="text-[#0F766E] hover:underline font-semibold">
            → Go to Project Financial
          </Link>
        </div>
      </div>
    </div>
  );
}
