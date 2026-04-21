import { Link, useNavigate } from "react-router-dom";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, ArrowDown, ArrowUpDown, X, Filter, TrendingUp, TrendingDown, Columns3 } from "lucide-react";
import {
  BRANDS, STATES, fmtRM, computeCosts,
  type Brand, type EventType, type EventStatus, type MalaysianState, type HouzsEvent,
} from "@/lib/mock-data";
import { useAllEvents } from "@/lib/events-store";
import { FILTER_SELECT } from "@/lib/ui-tokens";
import { useCurrentUser, canViewFinance } from "@/lib/auth-store";

interface FinancialRow extends HouzsEvent {
  cogsTotal: number;
  setup: number;
  transport: number;
  commission: number;
  merch: number;
  othersCosting: number;
  totalCost: number;
  grossProfit: number;
  grossProfitPct: number;
  netProfit: number;
  netProfitPct: number;
  rentalPerSqmPerDay: number;
  salesPerDay: number;
}

function buildRow(e: HouzsEvent): FinancialRow {
  const c = computeCosts(e);
  return {
    ...e,
    cogsTotal: c.cogsTotal,
    setup: c.setup,
    transport: c.transportFee + c.transportSetupDismantle,
    commission: c.commission,
    merch: c.merch,
    othersCosting: c.othersCosting,
    totalCost: c.totalCost,
    grossProfit: c.grossProfit,
    grossProfitPct: c.grossProfitPct,
    netProfit: c.netProfit,
    netProfitPct: c.netProfitPct,
    rentalPerSqmPerDay: c.rentalPerSqmPerDay,
    salesPerDay: c.salesPerDay,
  };
}

type SortKey =
  | "a42" | "status" | "month" | "startDate" | "endDate" | "durationDays"
  | "organizer" | "state" | "venue" | "brand" | "eventType" | "boothNo"
  | "sizeSqm" | "totalSalesRm" | "salesPerDay"
  | "cogsTotal" | "grossProfitPct"
  | "rentalRm" | "rentalPerSqmPerDay" | "setup" | "transport" | "commission" | "merch" | "othersCosting"
  | "totalCost" | "netProfit" | "netProfitPct";
type SortDir = "asc" | "desc";

const COLUMNS: { key: SortKey; label: string; align?: "right" | "center"; numeric?: boolean; tip?: string }[] = [
  { key: "a42", label: "A42" },
  { key: "status", label: "Status" },
  { key: "month", label: "Month" },
  { key: "startDate", label: "Start" },
  { key: "endDate", label: "End" },
  { key: "durationDays", label: "Days", align: "right", numeric: true },
  { key: "organizer", label: "Organizer" },
  { key: "state", label: "State" },
  { key: "venue", label: "Venue" },
  { key: "brand", label: "Brand" },
  { key: "eventType", label: "Type" },
  { key: "boothNo", label: "Booth" },
  { key: "sizeSqm", label: "Size (sqm)", align: "right", numeric: true },
  { key: "totalSalesRm", label: "Sales", align: "right", numeric: true },
  { key: "salesPerDay", label: "Sales/Day", align: "right", numeric: true },
  { key: "cogsTotal", label: "COGS", align: "right", numeric: true, tip: "Matt/Sofa + Bedframe + Acc" },
  { key: "grossProfitPct", label: "GP %", align: "right", numeric: true, tip: "Gross Profit % = (Sales − COGS) / Sales" },
  { key: "rentalRm", label: "Rental", align: "right", numeric: true },
  { key: "rentalPerSqmPerDay", label: "Rent/sqm/d", align: "right", numeric: true, tip: "Rental / (sqm × days)" },
  { key: "setup", label: "Setup", align: "right", numeric: true },
  { key: "transport", label: "Transport", align: "right", numeric: true, tip: "Transport Fee + Setup & Dismantle" },
  { key: "commission", label: "Comm.", align: "right", numeric: true, tip: "Commission" },
  { key: "merch", label: "Merch", align: "right", numeric: true, tip: "Merch / Marketing" },
  { key: "othersCosting", label: "Others", align: "right", numeric: true, tip: "Others costing" },
  { key: "totalCost", label: "Total Cost", align: "right", numeric: true },
  { key: "netProfit", label: "Net Profit", align: "right", numeric: true },
  { key: "netProfitPct", label: "NP %", align: "right", numeric: true, tip: "Net Profit % — bottom line margin" },
];

export default function FinancePage() {
  const navigate = useNavigate();
  const currentUser = useCurrentUser();

  // Guard: only admins (Sales Directors) can view this page
  if (!canViewFinance(currentUser)) {
    return (
      <div className="space-y-4">
        <div>
          <h1 className="text-2xl font-bold text-[#0A1F2E]">Project Financial Report</h1>
        </div>
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-10 text-center">
          <div className="text-4xl mb-3">🔒</div>
          <div className="text-[15px] font-semibold text-amber-800">Admin Only</div>
          <div className="text-[12px] text-amber-700 mt-1">
            The Project Financial Report is only accessible to Sales Directors.
          </div>
        </div>
      </div>
    );
  }
  const [brand, setBrand] = useState<Brand | "ALL">("ALL");
  const [eventType, setEventType] = useState<EventType | "ALL">("ALL");
  const [status, setStatus] = useState<EventStatus | "ALL">("ALL");
  const [state, setState] = useState<MalaysianState | "ALL">("ALL");
  const [query, setQuery] = useState("");

  const allEvents = useAllEvents();

  const [sortKey, setSortKey] = useState<SortKey>("netProfit");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  // Column visibility — all on by default
  const [visibleKeys, setVisibleKeys] = useState<Set<SortKey>>(
    () => new Set(COLUMNS.map((c) => c.key))
  );
  const [colMenuOpen, setColMenuOpen] = useState(false);
  const colMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!colMenuOpen) return;
    const onClick = (ev: MouseEvent) => {
      if (colMenuRef.current && !colMenuRef.current.contains(ev.target as Node)) {
        setColMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [colMenuOpen]);
  function toggleCol(k: SortKey) {
    setVisibleKeys((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      // Never allow zero visible columns
      if (next.size === 0) return prev;
      return next;
    });
  }
  const visibleCols = useMemo(() => COLUMNS.filter((c) => visibleKeys.has(c.key)), [visibleKeys]);

  const rows = useMemo(() => {
    return allEvents
      .filter((e) => {
        if (brand !== "ALL" && e.brand !== brand) return false;
        if (eventType !== "ALL" && e.eventType !== eventType) return false;
        if (status !== "ALL" && e.status !== status) return false;
        if (state !== "ALL" && e.state !== state) return false;
        if (query && !`${e.organizer} ${e.venue} ${e.a42}`.toLowerCase().includes(query.toLowerCase()))
          return false;
        return true;
      })
      .map(buildRow);
  }, [allEvents, brand, eventType, status, state, query]);

  const sorted = useMemo(() => {
    const col = COLUMNS.find((c) => c.key === sortKey);
    const numeric = col?.numeric ?? false;
    const copy = [...rows];
    copy.sort((a, b) => {
      const va = (a as unknown as Record<string, unknown>)[sortKey];
      const vb = (b as unknown as Record<string, unknown>)[sortKey];
      let cmp: number;
      if (numeric) cmp = (Number(va) || 0) - (Number(vb) || 0);
      else cmp = String(va ?? "").localeCompare(String(vb ?? ""));
      return sortDir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [rows, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("desc"); } // financial columns default desc
  }

  // KPI totals
  const kpi = useMemo(() => {
    const totalSales   = rows.reduce((a, r) => a + r.totalSalesRm, 0);
    const totalRental  = rows.reduce((a, r) => a + r.rentalRm, 0);
    const totalCogs    = rows.reduce((a, r) => a + r.cogsTotal, 0);
    const totalSetup   = rows.reduce((a, r) => a + r.setup, 0);
    const totalTransport  = rows.reduce((a, r) => a + r.transport, 0);
    const totalCommission = rows.reduce((a, r) => a + r.commission, 0);
    const totalMerch   = rows.reduce((a, r) => a + r.merch, 0);
    const totalOthers  = rows.reduce((a, r) => a + r.othersCosting, 0);
    const totalCost    = rows.reduce((a, r) => a + r.totalCost, 0);
    const totalGP      = totalSales - totalCogs;
    const gpPct        = totalSales ? (totalGP / totalSales) * 100 : 0;
    const totalNet     = rows.reduce((a, r) => a + r.netProfit, 0);
    const netPct       = totalSales ? (totalNet / totalSales) * 100 : 0;
    const totalSqmDays = rows.reduce((a, r) => a + r.sizeSqm * r.durationDays, 0);
    const avgRentalPerSqmPerDay = totalSqmDays ? totalRental / totalSqmDays : 0;
    const profitableCount = rows.filter((r) => r.netProfit > 0).length;
    const lossCount       = rows.filter((r) => r.netProfit < 0).length;
    return {
      totalSales, totalRental, totalCogs, totalSetup, totalTransport,
      totalCommission, totalMerch, totalOthers,
      totalCost, totalGP, gpPct, totalNet, netPct,
      avgRentalPerSqmPerDay, profitableCount, lossCount,
    };
  }, [rows]);

  const activeFilterCount =
    (brand !== "ALL" ? 1 : 0) +
    (eventType !== "ALL" ? 1 : 0) +
    (status !== "ALL" ? 1 : 0) +
    (state !== "ALL" ? 1 : 0) +
    (query ? 1 : 0);

  function clearAll() {
    setBrand("ALL"); setEventType("ALL"); setStatus("ALL"); setState("ALL"); setQuery("");
  }

  function SortIcon({ k }: { k: SortKey }) {
    if (sortKey !== k) return <ArrowUpDown className="h-3 w-3 text-gray-300 inline ml-0.5" />;
    return sortDir === "asc"
      ? <ArrowUp className="h-3 w-3 text-[#0F766E] inline ml-0.5" />
      : <ArrowDown className="h-3 w-3 text-[#0F766E] inline ml-0.5" />;
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-[#0A1F2E]">Project Financial</h1>
        <p className="text-sm text-gray-500 mt-1">
          Sales · rental · gross profit · GP % per event — management &amp; finance only
        </p>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <div className="rounded-lg border border-[#DDE5E5] bg-white p-3">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Total Sales</div>
          <div className="mt-0.5 text-xl font-bold text-[#0A1F2E]">{fmtRM(kpi.totalSales)}</div>
          <div className="text-[9px] text-gray-400 mt-0.5">{rows.length} event(s)</div>
        </div>
        <div className="rounded-lg border border-[#DDE5E5] bg-white p-3">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Gross Profit</div>
          <div className={`mt-0.5 text-xl font-bold ${kpi.totalGP >= 0 ? "text-[#0F766E]" : "text-red-600"}`}>
            {fmtRM(kpi.totalGP)}
          </div>
          <div className="text-[9px] text-gray-400 mt-0.5">{kpi.gpPct.toFixed(1)}% · sales − COGS</div>
        </div>
        <div className="rounded-lg border border-[#DDE5E5] bg-white p-3">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Total Cost</div>
          <div className="mt-0.5 text-xl font-bold text-[#0A1F2E]">{fmtRM(kpi.totalCost)}</div>
          <div className="text-[9px] text-gray-400 mt-0.5">avg {fmtRM(kpi.avgRentalPerSqmPerDay)}/sqm/day rent</div>
        </div>
        <div className="rounded-lg border border-[#DDE5E5] bg-white p-3">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Net Profit</div>
          <div className={`mt-0.5 text-xl font-bold inline-flex items-center gap-1 ${kpi.totalNet >= 0 ? "text-[#0F766E]" : "text-red-600"}`}>
            {kpi.totalNet >= 0 ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
            {fmtRM(kpi.totalNet)}
          </div>
          <div className="text-[9px] text-gray-400 mt-0.5">{kpi.netPct.toFixed(1)}% blended net margin</div>
        </div>
        <div className="rounded-lg border border-[#DDE5E5] bg-white p-3">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Profit / Loss</div>
          <div className="mt-0.5 text-xl font-bold text-[#0A1F2E]">
            <span className="text-[#0F766E]">{kpi.profitableCount}</span>
            <span className="text-gray-300 mx-1">/</span>
            <span className="text-red-600">{kpi.lossCount}</span>
          </div>
          <div className="text-[9px] text-gray-400 mt-0.5">events profitable / loss</div>
        </div>
      </div>

      {/* Filter bar — compact dropdowns */}
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
          placeholder="Search A42 / organizer / venue…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="h-8 rounded-md border border-[#DDE5E5] px-2.5 text-[11px] focus:outline-none focus:ring-2 focus:ring-[#0F766E]/30 focus:border-[#0F766E] w-56"
        />

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

        <div className="ml-auto flex items-center gap-2">
          <div className="text-[10px] text-gray-400 pr-1">
            sorted by <span className="font-semibold text-[#0A1F2E]">
              {COLUMNS.find((c) => c.key === sortKey)?.label} {sortDir === "asc" ? "↑" : "↓"}
            </span>
          </div>
          <div className="relative" ref={colMenuRef}>
            <button
              type="button"
              onClick={() => setColMenuOpen((v) => !v)}
              className="h-8 px-2.5 rounded-md border border-[#DDE5E5] bg-white text-[11px] font-semibold text-gray-600 hover:border-[#0F766E] inline-flex items-center gap-1.5"
            >
              <Columns3 className="h-3.5 w-3.5" />
              Columns
              <span className="text-[9px] text-gray-400">{visibleCols.length}/{COLUMNS.length}</span>
            </button>
            {colMenuOpen && (
              <div className="absolute right-0 mt-1 z-20 w-56 rounded-md border border-[#DDE5E5] bg-white shadow-lg py-1 max-h-[360px] overflow-y-auto">
                <div className="px-2.5 py-1.5 flex items-center justify-between border-b border-[#F0F3F3]">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">Show columns</span>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={() => setVisibleKeys(new Set(COLUMNS.map((c) => c.key)))}
                      className="text-[9px] font-semibold text-[#0F766E] hover:underline"
                    >All</button>
                    <span className="text-gray-300 text-[9px]">·</span>
                    <button
                      type="button"
                      onClick={() => setVisibleKeys(new Set(["a42","organizer","totalSalesRm","totalCost","netProfit","netProfitPct"] as SortKey[]))}
                      className="text-[9px] font-semibold text-gray-500 hover:underline"
                    >Min</button>
                  </div>
                </div>
                {COLUMNS.map((c) => {
                  const on = visibleKeys.has(c.key);
                  return (
                    <button
                      key={c.key}
                      type="button"
                      onClick={() => toggleCol(c.key)}
                      className="w-full px-2.5 py-1.5 text-left text-[11px] hover:bg-[#F4F7F7] flex items-center gap-2"
                    >
                      <span className={`h-3.5 w-3.5 rounded border flex items-center justify-center ${on ? "bg-[#0F766E] border-[#0F766E]" : "border-gray-300"}`}>
                        {on && <span className="text-white text-[9px] leading-none">✓</span>}
                      </span>
                      <span className={on ? "text-[#0A1F2E] font-medium" : "text-gray-500"}>{c.label}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Table — driven by visibleCols */}
      <div className="rounded-lg border border-[#DDE5E5] bg-white overflow-hidden">
        <div className="overflow-x-auto overscroll-x-contain">
          <table className="min-w-full w-max text-[12px]">
            <thead className="bg-[#F4F7F7] text-[#0A1F2E] border-b border-[#DDE5E5]">
              <tr className="text-left">
                {visibleCols.map((c) => (
                  <th
                    key={c.key}
                    onClick={() => toggleSort(c.key)}
                    title={c.tip}
                    className={`px-2 py-2 font-semibold whitespace-nowrap cursor-pointer select-none hover:bg-[#ECF1F1] ${
                      c.align === "right" ? "text-right" : c.align === "center" ? "text-center" : ""
                    } ${sortKey === c.key ? "text-[#0F766E]" : ""}`}
                  >
                    {c.label}
                    <SortIcon k={c.key} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((e) => {
                const cellFor = (k: SortKey): React.ReactNode => {
                  switch (k) {
                    case "a42":
                      return (
                        <Link to={`/events/${encodeURIComponent(e.a42)}`} className="text-[#0F766E] hover:underline font-mono text-[10px]">
                          {e.a42}
                        </Link>
                      );
                    case "status":
                      return (
                        <span className={`px-1.5 py-[1px] rounded text-[10px] font-semibold ${
                          e.status === "CONFIRMED" ? "bg-[#0F766E] text-white" :
                          e.status === "PENDING" ? "bg-amber-100 text-amber-700" :
                          "bg-red-100 text-red-700"
                        }`}>{e.status}</span>
                      );
                    case "month":       return <span className="text-gray-600">{e.month}</span>;
                    case "startDate":   return e.startDate;
                    case "endDate":     return e.endDate;
                    case "durationDays": return <span className="text-gray-600 tabular-nums">{e.durationDays}</span>;
                    case "organizer":   return e.organizer;
                    case "state":       return e.state;
                    case "venue":       return <span className="text-gray-700">{e.venue}</span>;
                    case "brand":
                      return <span className="px-1.5 py-[1px] rounded text-[10px] font-semibold bg-[#0F766E]/10 text-[#0F766E]">{e.brand}</span>;
                    case "eventType":
                      return <span className={`px-1.5 py-[1px] rounded text-[10px] font-semibold ${e.eventType === "EXHIBITION" ? "bg-[#0A1F2E] text-white" : "bg-gray-100 text-gray-700"}`}>{e.eventType}</span>;
                    case "boothNo":     return <span className="text-gray-600">{e.boothNo}</span>;
                    case "sizeSqm":            return <span className="tabular-nums">{e.sizeSqm}</span>;
                    case "totalSalesRm":       return <span className="font-semibold">{fmtRM(e.totalSalesRm)}</span>;
                    case "salesPerDay":        return <span className="text-gray-500">{fmtRM(e.salesPerDay)}</span>;
                    case "cogsTotal":          return <span className="text-gray-600">{fmtRM(e.cogsTotal)}</span>;
                    case "grossProfitPct":     return <span className={e.grossProfitPct >= 0 ? "text-[#0F766E]" : "text-red-600"}>{e.grossProfitPct.toFixed(1)}%</span>;
                    case "rentalRm":           return <span className="text-gray-600">{fmtRM(e.rentalRm)}</span>;
                    case "rentalPerSqmPerDay": return <span className="text-gray-500">{fmtRM(e.rentalPerSqmPerDay)}</span>;
                    case "setup":              return <span className="text-gray-500">{fmtRM(e.setup)}</span>;
                    case "transport":          return <span className="text-gray-500">{fmtRM(e.transport)}</span>;
                    case "commission":         return <span className="text-gray-500">{fmtRM(e.commission)}</span>;
                    case "merch":              return <span className="text-gray-500">{fmtRM(e.merch)}</span>;
                    case "othersCosting":      return <span className="text-gray-500">{fmtRM(e.othersCosting)}</span>;
                    case "totalCost":          return <span className="text-gray-700">{fmtRM(e.totalCost)}</span>;
                    case "netProfit":          return <span className={`font-semibold ${e.netProfit >= 0 ? "text-[#0F766E]" : "text-red-600"}`}>{fmtRM(e.netProfit)}</span>;
                    case "netProfitPct":       return <span className={`font-semibold ${e.netProfitPct >= 0 ? "text-[#0F766E]" : "text-red-600"}`}>{e.netProfitPct.toFixed(1)}%</span>;
                    default: return null;
                  }
                };
                return (
                  <tr
                    key={e.a42}
                    onDoubleClick={() => navigate(`/events/${encodeURIComponent(e.a42)}`)}
                    title="Double-click to open project"
                    className="border-b border-[#F0F3F3] hover:bg-[#F4F7F7] cursor-pointer select-none"
                  >
                    {visibleCols.map((c) => (
                      <td
                        key={c.key}
                        className={`px-2 py-1.5 whitespace-nowrap ${
                          c.align === "right" ? "text-right" : c.align === "center" ? "text-center" : ""
                        }`}
                      >
                        {cellFor(c.key)}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
            {sorted.length > 0 && (
              <tfoot className="bg-[#F4F7F7] border-t-2 border-[#DDE5E5] font-semibold text-[#0A1F2E]">
                <tr>
                  {(() => {
                    const totalFor = (k: SortKey): React.ReactNode => {
                      switch (k) {
                        case "durationDays":       return rows.reduce((a, r) => a + r.durationDays, 0);
                        case "sizeSqm":            return rows.reduce((a, r) => a + r.sizeSqm, 0);
                        case "totalSalesRm":       return fmtRM(kpi.totalSales);
                        case "salesPerDay":        return <span className="text-gray-400">—</span>;
                        case "cogsTotal":          return fmtRM(kpi.totalCogs);
                        case "grossProfitPct":     return <span className={kpi.gpPct >= 0 ? "text-[#0F766E]" : "text-red-600"}>{kpi.gpPct.toFixed(1)}%</span>;
                        case "rentalRm":           return fmtRM(kpi.totalRental);
                        case "rentalPerSqmPerDay": return fmtRM(kpi.avgRentalPerSqmPerDay);
                        case "setup":              return fmtRM(kpi.totalSetup);
                        case "transport":          return fmtRM(kpi.totalTransport);
                        case "commission":         return fmtRM(kpi.totalCommission);
                        case "merch":              return fmtRM(kpi.totalMerch);
                        case "othersCosting":      return fmtRM(kpi.totalOthers);
                        case "totalCost":          return fmtRM(kpi.totalCost);
                        case "netProfit":          return <span className={kpi.totalNet >= 0 ? "text-[#0F766E]" : "text-red-600"}>{fmtRM(kpi.totalNet)}</span>;
                        case "netProfitPct":       return <span className={kpi.netPct >= 0 ? "text-[#0F766E]" : "text-red-600"}>{kpi.netPct.toFixed(1)}%</span>;
                        default: return null;
                      }
                    };
                    // Find first numeric column index — label "Totals (N)" spans cols before it
                    const firstNumericIdx = visibleCols.findIndex((c) => c.numeric);
                    const labelSpan = firstNumericIdx === -1 ? visibleCols.length : firstNumericIdx;
                    const cells: React.ReactNode[] = [];
                    if (labelSpan > 0) {
                      cells.push(
                        <td key="__label" colSpan={labelSpan} className="px-2 py-2 text-right text-[10px] uppercase tracking-wider text-gray-500">
                          Totals ({rows.length} events)
                        </td>
                      );
                    }
                    visibleCols.slice(labelSpan).forEach((c) => {
                      cells.push(
                        <td key={c.key} className={`px-2 py-2 whitespace-nowrap ${
                          c.align === "right" ? "text-right" : c.align === "center" ? "text-center" : ""
                        }`}>
                          {totalFor(c.key)}
                        </td>
                      );
                    });
                    return cells;
                  })()}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        <div className="px-3 py-2 text-[11px] text-gray-500 border-t border-[#DDE5E5] bg-[#FAFBFB] flex items-center justify-between">
          <span>GP = Sales − COGS · Net Profit = GP − Rental − Setup − Transport − Commission − Merch − Others · matches Exhibition Report</span>
          <Link to="/" className="text-[#0F766E] hover:underline font-semibold">
            ← Back to Project Management
          </Link>
        </div>
      </div>
    </div>
  );
}
