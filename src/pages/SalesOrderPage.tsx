// Sales Orders — consolidated SO listing (one row per Doc. No.)
// Visual style: matches Sales Order Details (spacious, summary cards, pill badges).

import { useState, useMemo, type ReactNode } from "react";
import {
  ArrowUp, ArrowDown, ArrowUpDown, GripVertical, Columns3, RotateCcw,
  X, Search, Filter, ChevronDown, ChevronRight, Plus,
} from "lucide-react";
import { BRANDS } from "@/lib/mock-data";
import {
  useSOLines, useSOHeaders, getConsolidatedSOs,
  type SODetailLine, type ConsolidatedSO, type ItemGroup,
} from "@/lib/so-store";
import NewSalesOrderForm from "@/components/NewSalesOrderForm";
import { useColumnPrefs } from "@/lib/column-prefs";
import {
  FIELD_LABEL, FIELD_INPUT, FIELD_SELECT, FILTER_SELECT,
  PAGE_TITLE, CARD, BTN_PRIMARY, BTN_SECONDARY,
  COUNT_BADGE, STAT_LABEL, STAT_VALUE,
} from "@/lib/ui-tokens";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtRM(n: number) {
  return "RM " + n.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(d: string) {
  if (!d) return "—";
  return new Date(d + "T00:00:00").toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

const BRAND_CHIP: Record<string, string> = {
  AKEMI: "bg-[#4F6BED] text-white",
  ZANOTTI: "bg-[#7B5BD6] text-white",
  ERGOTEX: "bg-[#1A73E8] text-white",
  DUNLOPILLO: "bg-[#0B8043] text-white",
};

const ITEM_GROUP_COLOR: Record<ItemGroup, string> = {
  MATTRESS: "bg-amber-100 text-amber-700",
  BEDFRAME: "bg-blue-100 text-blue-700",
  SOFA: "bg-violet-100 text-violet-700",
  ACC: "bg-purple-100 text-purple-700",
  BEDLINES: "bg-sky-100 text-sky-700",
  DINING: "bg-orange-100 text-orange-700",
  OTHERS: "bg-gray-100 text-gray-600",
};

const PAYMENT_COLOR: Record<string, string> = {
  Checked: "bg-teal-100 text-teal-700",
  Unchecked: "bg-amber-100 text-amber-700",
  Pending: "bg-gray-100 text-gray-500",
};

// ─── Column system ────────────────────────────────────────────────────────────

interface Col {
  key: string;
  label: string;
  sortable?: boolean;
  defaultHidden?: boolean;
  align?: "right" | "center";
  sortValue?: (so: ConsolidatedSO) => string | number;
  render: (so: ConsolidatedSO, ctx: ColCtx) => ReactNode;
}

interface ColCtx {
  expanded: Set<string>;
  onToggle: (docNo: string) => void;
}

const ALL_COLUMNS: Col[] = [
  {
    key: "expand", label: "",
    render: (so, ctx) => (
      <button
        onClick={(e) => { e.stopPropagation(); ctx.onToggle(so.docNo); }}
        className="h-5 w-5 flex items-center justify-center text-gray-400 hover:text-[#0F766E]"
      >
        {ctx.expanded.has(so.docNo)
          ? <ChevronDown className="h-3.5 w-3.5" />
          : <ChevronRight className="h-3.5 w-3.5" />}
      </button>
    ),
  },
  {
    key: "docNo", label: "Doc. No.", sortable: true,
    sortValue: (so) => so.docNo,
    render: (so, ctx) => (
      <button
        onClick={(e) => { e.stopPropagation(); ctx.onToggle(so.docNo); }}
        className="font-semibold text-[#0F766E] hover:underline font-mono text-[12px] tracking-tight whitespace-nowrap"
      >
        {so.docNo}
      </button>
    ),
  },
  {
    key: "date", label: "Date", sortable: true,
    sortValue: (so) => so.date,
    render: (so) => <span className="whitespace-nowrap text-gray-500">{fmtDate(so.date)}</span>,
  },
  {
    key: "debtorName", label: "Debtor Name", sortable: true,
    sortValue: (so) => so.debtorName,
    render: (so) => <span className="whitespace-nowrap">{so.debtorName}</span>,
  },
  {
    key: "debtorCode", label: "Debtor Code", defaultHidden: true,
    render: (so) => <span className="font-mono text-[10px] text-gray-500">{so.debtorCode}</span>,
  },
  {
    key: "agent", label: "Agent", sortable: true,
    sortValue: (so) => so.agent,
    render: (so) => <span className="whitespace-nowrap">{so.agent}</span>,
  },
  {
    key: "salesLocation", label: "Location",
    render: (so) => <span className="whitespace-nowrap">{so.salesLocation}</span>,
  },
  {
    key: "reference", label: "Reference",
    render: (so) => <span className="text-gray-500 max-w-[120px] truncate inline-block">{so.reference || "—"}</span>,
  },
  {
    key: "branding", label: "Branding", sortable: true,
    sortValue: (so) => so.branding,
    render: (so) => (
      <span className={`px-1.5 py-[1px] rounded text-[9px] font-semibold ${BRAND_CHIP[so.branding] ?? "bg-gray-100 text-gray-600"}`}>
        {so.branding}
      </span>
    ),
  },
  {
    key: "venue", label: "Venue", sortable: true,
    sortValue: (so) => so.venue,
    render: (so) => <span className="whitespace-nowrap max-w-[140px] truncate inline-block">{so.venue}</span>,
  },
  {
    key: "localTotal", label: "Local Total", align: "right", sortable: true,
    sortValue: (so) => so.localTotal,
    render: (so) => <span className="tabular-nums font-semibold">{fmtRM(so.localTotal)}</span>,
  },
  {
    key: "mattressSofaCost", label: "Mattress/Sofa Cost", align: "right", sortable: true,
    sortValue: (so) => so.mattressSofaCost ?? 0,
    render: (so) => (
      <span className={`tabular-nums ${(so.mattressSofaCost ?? 0) > 0 ? "text-amber-700" : "text-gray-300"}`}>
        {(so.mattressSofaCost ?? 0) > 0 ? fmtRM(so.mattressSofaCost!) : "—"}
      </span>
    ),
  },
  {
    key: "bedframeCost", label: "Bedframe Cost", align: "right", sortable: true,
    sortValue: (so) => so.bedframeCost ?? 0,
    render: (so) => (
      <span className={`tabular-nums ${(so.bedframeCost ?? 0) > 0 ? "text-blue-700" : "text-gray-300"}`}>
        {(so.bedframeCost ?? 0) > 0 ? fmtRM(so.bedframeCost!) : "—"}
      </span>
    ),
  },
  {
    key: "accessoriesCost", label: "Accessories Cost", align: "right", sortable: true,
    sortValue: (so) => so.accessoriesCost ?? 0,
    render: (so) => (
      <span className={`tabular-nums ${(so.accessoriesCost ?? 0) > 0 ? "text-purple-700" : "text-gray-300"}`}>
        {(so.accessoriesCost ?? 0) > 0 ? fmtRM(so.accessoriesCost!) : "—"}
      </span>
    ),
  },
  {
    key: "cost", label: "Cost (Total)", align: "right", sortable: true,
    sortValue: (so) => so.totalCost,
    render: (so) => <span className="tabular-nums text-gray-700 font-semibold">{so.totalCost > 0 ? fmtRM(so.totalCost) : "—"}</span>,
  },
  {
    key: "margin", label: "Margin RM", align: "right", sortable: true,
    sortValue: (so) => so.totalMargin,
    render: (so) => (
      <span className={`tabular-nums font-semibold ${so.totalMargin >= 0 ? "text-[#0F766E]" : "text-red-600"}`}>
        {so.totalCost > 0 ? fmtRM(so.totalMargin) : "—"}
      </span>
    ),
  },
  {
    key: "marginPct", label: "Margin %", align: "right", sortable: true,
    sortValue: (so) => so.marginPct,
    render: (so) => {
      if (so.totalRevenue <= 0 || so.totalCost <= 0) return <span className="text-gray-300">—</span>;
      const pct = so.marginPct;
      return (
        <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
          pct >= 50 ? "bg-emerald-100 text-emerald-700" :
          pct >= 30 ? "bg-amber-100 text-amber-700" :
          pct > 0 ? "bg-orange-100 text-orange-700" :
          "bg-red-100 text-red-700"
        }`}>
          {pct.toFixed(1)}%
        </span>
      );
    },
  },
  {
    key: "balance", label: "Balance", align: "right", sortable: true,
    sortValue: (so) => so.balance,
    render: (so) => (
      <span className={`tabular-nums font-semibold ${so.balance > 0 ? "text-red-600" : "text-gray-400"}`}>
        {so.balance > 0 ? fmtRM(so.balance) : "—"}
      </span>
    ),
  },
  {
    key: "lineCount", label: "Lines", align: "center",
    render: (so) => (
      <span className="inline-flex items-center justify-center h-4 min-w-[16px] px-1 rounded-full bg-[#0F766E]/10 text-[9px] font-semibold text-[#0F766E]">
        {so.lineCount}
      </span>
    ),
  },
  {
    key: "phone", label: "Phone", defaultHidden: true,
    render: (so) => <span className="text-gray-500">{so.phone ?? "—"}</span>,
  },
  {
    key: "address1", label: "Address 1", defaultHidden: true,
    render: (so) => <span className="max-w-[180px] truncate inline-block text-gray-500">{so.address1 || "—"}</span>,
  },
  {
    key: "poDocNo", label: "PO Doc No.", defaultHidden: true,
    render: (so) => <span className="font-mono text-[10px] text-gray-500">{so.poDocNo || "—"}</span>,
  },
];

const DEFAULT_ORDER = ALL_COLUMNS.map((c) => c.key);
const DEFAULT_HIDDEN = ALL_COLUMNS.filter((c) => c.defaultHidden).map((c) => c.key);
const STORAGE_KEY = "houzs-sales-order-columns-v3";

// ─── Inline sub-table (expanded row) ──────────────────────────────────────────

function LineItemsSubTable({ lines }: { lines: SODetailLine[] }) {
  return (
    <div className="px-4 pb-3 pt-1 bg-[#FAFBFB]">
      <div className="rounded-md border border-[#DDE5E5] overflow-hidden overflow-x-auto">
        <table className="w-full text-[10px]">
          <thead>
            <tr className="bg-[#F4F7F7] text-[9px] font-semibold uppercase tracking-wider text-gray-500">
              <th className="text-left px-2.5 py-1.5">Group</th>
              <th className="text-left px-2.5 py-1.5">Item Code</th>
              <th className="text-left px-2.5 py-1.5">Description</th>
              <th className="text-left px-2.5 py-1.5">UOM</th>
              <th className="text-right px-2.5 py-1.5">Qty</th>
              <th className="text-right px-2.5 py-1.5">Unit Price</th>
              <th className="text-right px-2.5 py-1.5">Total</th>
              <th className="text-right px-2.5 py-1.5">Unit Cost</th>
              <th className="text-right px-2.5 py-1.5">Line Cost</th>
              <th className="text-right px-2.5 py-1.5">Margin</th>
              <th className="text-left px-2.5 py-1.5">Payment</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#F0F3F3] bg-white">
            {lines.map((l) => (
              <tr key={l.id} className="hover:bg-[#FAFBFB]">
                <td className="px-2.5 py-1.5">
                  <span className={`px-1.5 py-[1px] rounded text-[8px] font-semibold ${ITEM_GROUP_COLOR[l.itemGroup]}`}>
                    {l.itemGroup}
                  </span>
                </td>
                <td className="px-2.5 py-1.5 font-mono text-[9px] text-[#0F766E]">{l.itemCode}</td>
                <td className="px-2.5 py-1.5 text-gray-700 max-w-[200px]">
                  <span className="line-clamp-1">{l.description}</span>
                </td>
                <td className="px-2.5 py-1.5 text-gray-500">{l.uom}</td>
                <td className="px-2.5 py-1.5 tabular-nums text-right">{l.qty}</td>
                <td className="px-2.5 py-1.5 tabular-nums text-right">{fmtRM(l.unitPrice)}</td>
                <td className="px-2.5 py-1.5 tabular-nums text-right font-semibold text-[#0F766E]">{fmtRM(l.total)}</td>
                <td className="px-2.5 py-1.5 tabular-nums text-right text-gray-500">{l.unitCost > 0 ? fmtRM(l.unitCost) : "—"}</td>
                <td className="px-2.5 py-1.5 tabular-nums text-right text-gray-600">{l.lineCost > 0 ? fmtRM(l.lineCost) : "—"}</td>
                <td className={`px-2.5 py-1.5 tabular-nums text-right font-semibold ${l.lineMargin > 0 ? "text-[#0F766E]" : l.lineMargin < 0 ? "text-red-600" : "text-gray-400"}`}>
                  {l.total > 0 ? fmtRM(l.lineMargin) : "—"}
                </td>
                <td className="px-2.5 py-1.5">
                  <span className={`px-1.5 py-[1px] rounded text-[8px] font-semibold ${PAYMENT_COLOR[l.paymentStatus] ?? ""}`}>
                    {l.paymentStatus}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-[#F4F7F7] border-t border-[#DDE5E5]">
              <td colSpan={6} className="px-2.5 py-1.5 text-[9px] font-semibold text-gray-500 text-right">
                Subtotal
              </td>
              <td className="px-2.5 py-1.5 tabular-nums text-right text-[11px] font-semibold text-[#0F766E]">
                {fmtRM(lines.reduce((s, l) => s + l.total, 0))}
              </td>
              <td />
              <td className="px-2.5 py-1.5 tabular-nums text-right text-[11px] font-semibold text-gray-600">
                {fmtRM(lines.reduce((s, l) => s + l.lineCost, 0))}
              </td>
              <td className="px-2.5 py-1.5 tabular-nums text-right text-[11px] font-semibold text-[#0F766E]">
                {fmtRM(lines.reduce((s, l) => s + l.lineMargin, 0))}
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function SalesOrderPage() {
  const lines = useSOLines();
  const headers = useSOHeaders();
  const consolidated = useMemo(() => getConsolidatedSOs(lines, undefined, headers), [lines, headers]);

  // column prefs — migrate forward from older versions if present
  const { order, hidden, setOrder, setHidden, resetColumns } = useColumnPrefs(
    STORAGE_KEY, DEFAULT_ORDER, DEFAULT_HIDDEN,
    ["houzs-sales-order-columns-v2", "houzs-sales-order-columns-v1", "houzs-sales-order-columns"],
  );
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);

  // sort
  const [sortKey, setSortKey] = useState<string>("date");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  // filters
  const [search, setSearch] = useState("");
  const [filterBranding, setFilterBranding] = useState("");
  const [filterAgent, setFilterAgent] = useState("");
  const [filterVenue, setFilterVenue] = useState("");
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");
  const [filterBalance, setFilterBalance] = useState("");

  // expanded rows
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // New SO modal
  const [showNewForm, setShowNewForm] = useState(false);

  // pagination
  const [showAll, setShowAll] = useState(false);
  const PAGE_SIZE = 100;

  function toggleExpand(docNo: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(docNo)) next.delete(docNo); else next.add(docNo);
      return next;
    });
  }

  const uniqueAgents = useMemo(() => [...new Set(consolidated.map((so) => so.agent))].sort(), [consolidated]);
  const uniqueVenues = useMemo(() => [...new Set(consolidated.map((so) => so.venue))].sort(), [consolidated]);

  const linesByDoc = useMemo(() => {
    const m = new Map<string, SODetailLine[]>();
    for (const l of lines) {
      const arr = m.get(l.docNo) ?? [];
      arr.push(l);
      m.set(l.docNo, arr);
    }
    return m;
  }, [lines]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return consolidated.filter((so) => {
      if (q && ![so.docNo, so.debtorName, so.agent, so.venue, so.branding].some((v) => (v ?? "").toLowerCase().includes(q))) return false;
      if (filterBranding && so.branding !== filterBranding) return false;
      if (filterAgent && so.agent !== filterAgent) return false;
      if (filterVenue && so.venue !== filterVenue) return false;
      if (filterFrom && so.date < filterFrom) return false;
      if (filterTo && so.date > filterTo) return false;
      if (filterBalance === "outstanding" && so.balance <= 0) return false;
      if (filterBalance === "paid" && so.balance > 0) return false;
      return true;
    });
  }, [consolidated, search, filterBranding, filterAgent, filterVenue, filterFrom, filterTo, filterBalance]);

  const sorted = useMemo(() => {
    const col = ALL_COLUMNS.find((c) => c.key === sortKey);
    if (!col?.sortable || !col.sortValue) return filtered;
    const get = col.sortValue;
    const copy = [...filtered];
    copy.sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      const cmp = typeof va === "number" ? (va as number) - (vb as number) : String(va).localeCompare(String(vb));
      return sortDir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [filtered, sortKey, sortDir]);

  function toggleSort(col: Col) {
    if (!col.sortable) return;
    if (sortKey === col.key) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else { setSortKey(col.key); setSortDir("asc"); }
  }

  const visibleColumns: Col[] = useMemo(() => {
    return order
      .map((k) => ALL_COLUMNS.find((c) => c.key === k))
      .filter((c): c is Col => !!c && !hidden.has(c.key));
  }, [order, hidden]);

  function handleDragStart(key: string) { setDragKey(key); }
  function handleDragOver(e: React.DragEvent, key: string) { e.preventDefault(); if (dragOverKey !== key) setDragOverKey(key); }
  function handleDragLeave(key: string) { if (dragOverKey === key) setDragOverKey(null); }
  function handleDrop(targetKey: string) {
    if (!dragKey || dragKey === targetKey) { setDragKey(null); setDragOverKey(null); return; }
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

  // Summary stats
  const totalRevenue = useMemo(() => sorted.reduce((s, so) => s + so.totalRevenue, 0), [sorted]);
  const totalCost = useMemo(() => sorted.reduce((s, so) => s + so.totalCost, 0), [sorted]);
  const totalMargin = totalRevenue - totalCost;
  const totalBalance = useMemo(() => sorted.reduce((s, so) => s + so.balance, 0), [sorted]);

  const hasFilters = !!(search || filterBranding || filterAgent || filterVenue || filterFrom || filterTo || filterBalance);

  function clearFilters() {
    setSearch(""); setFilterBranding(""); setFilterAgent(""); setFilterVenue("");
    setFilterFrom(""); setFilterTo(""); setFilterBalance("");
  }

  const pillBase = "h-8 px-2.5 rounded-md text-[11px] font-semibold border transition whitespace-nowrap";
  const pillOff = "bg-white text-gray-600 border-[#DDE5E5] hover:border-[#0F766E]";
  const pillOn = "bg-[#0F766E] text-white border-[#0F766E]";

  const ctx: ColCtx = { expanded, onToggle: toggleExpand };

  const displayRows = showAll ? sorted : sorted.slice(0, PAGE_SIZE);

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className={PAGE_TITLE}>Sales Orders</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Consolidated from line items · {consolidated.length} orders · click Doc. No. to expand
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className={COUNT_BADGE}>{consolidated.length} orders</span>
          <button onClick={() => setShowNewForm(true)} className={BTN_PRIMARY}>
            <Plus className="h-4 w-4" /> New Sales Order
          </button>
        </div>
      </div>

      {showNewForm && <NewSalesOrderForm onClose={() => setShowNewForm(false)} />}

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {[
          { label: "Total Orders", value: sorted.length.toString() },
          { label: "Revenue", value: fmtRM(totalRevenue) },
          { label: "Cost", value: fmtRM(totalCost) },
          { label: "Margin", value: fmtRM(totalMargin) + (totalRevenue > 0 ? ` (${(totalMargin / totalRevenue * 100).toFixed(1)}%)` : "") },
          { label: "Outstanding", value: fmtRM(totalBalance) },
        ].map(({ label, value }) => (
          <div key={label} className={`${CARD} px-3 py-2`}>
            <p className={STAT_LABEL}>{label}</p>
            <p className={`${STAT_VALUE} text-[#0A1F2E] text-[13px]`}>{value}</p>
          </div>
        ))}
      </div>

      {/* Filter Bar */}
      <div className="rounded-lg border border-[#DDE5E5] bg-white p-2.5 flex flex-wrap gap-2 items-center">
        <Filter className="h-3.5 w-3.5 text-gray-400 shrink-0" />

        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3 w-3 text-gray-400 pointer-events-none" />
          <input
            className="h-8 pl-7 pr-7 rounded-md border border-[#DDE5E5] bg-white text-[11px] placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-[#0F766E]/30 focus:border-[#0F766E] w-52"
            placeholder="Doc No, debtor, agent, venue…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600" onClick={() => setSearch("")}>
              <X className="h-3 w-3" />
            </button>
          )}
        </div>

        <select className={FILTER_SELECT} value={filterBranding} onChange={(e) => setFilterBranding(e.target.value)}>
          <option value="">All Brands</option>
          {BRANDS.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>

        <select className={FILTER_SELECT} value={filterAgent} onChange={(e) => setFilterAgent(e.target.value)}>
          <option value="">All Agents</option>
          {uniqueAgents.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>

        <select className={FILTER_SELECT} value={filterVenue} onChange={(e) => setFilterVenue(e.target.value)}>
          <option value="">All Venues</option>
          {uniqueVenues.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>

        <input type="date" className={FILTER_SELECT} value={filterFrom} onChange={(e) => setFilterFrom(e.target.value)} title="From date" />
        <input type="date" className={FILTER_SELECT} value={filterTo} onChange={(e) => setFilterTo(e.target.value)} title="To date" />

        <select className={FILTER_SELECT} value={filterBalance} onChange={(e) => setFilterBalance(e.target.value)}>
          <option value="">All Balance</option>
          <option value="outstanding">Has Outstanding</option>
          <option value="paid">Fully Paid</option>
        </select>

        {hasFilters && (
          <button onClick={clearFilters}
            className="h-8 px-2 rounded-md text-[10px] font-semibold text-gray-500 hover:text-red-600 inline-flex items-center gap-1">
            <X className="h-3 w-3" /> Clear
          </button>
        )}

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
              <div className="absolute right-0 top-full mt-1 z-30 w-64 rounded-lg border border-[#DDE5E5] bg-white shadow-lg overflow-hidden">
                <div className="flex items-center justify-between px-4 py-2.5 border-b border-[#DDE5E5] bg-[#F4F7F7]">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-[#0A1F2E]">
                    Columns ({visibleColumns.length})
                  </span>
                  <button onClick={resetColumns}
                    className="text-[10px] font-semibold text-[#0F766E] hover:underline inline-flex items-center gap-1">
                    <RotateCcw className="h-3 w-3" /> Reset
                  </button>
                </div>
                <div className="max-h-[360px] overflow-y-auto">
                  {ALL_COLUMNS.filter((c) => c.key !== "expand").map((c) => (
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
                </div>
              </div>
            </>
          )}
        </div>
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
                  const isExpandCol = c.key === "expand";
                  return (
                    <th
                      key={c.key}
                      draggable={!isExpandCol}
                      onDragStart={() => !isExpandCol && handleDragStart(c.key)}
                      onDragOver={(e) => !isExpandCol && handleDragOver(e, c.key)}
                      onDragLeave={() => !isExpandCol && handleDragLeave(c.key)}
                      onDrop={() => !isExpandCol && handleDrop(c.key)}
                      onDragEnd={handleDragEnd}
                      onClick={() => !isExpandCol && toggleSort(c)}
                      className={`group px-1.5 py-1.5 font-semibold whitespace-nowrap select-none text-[10px] transition
                        ${c.align === "right" ? "text-right" : c.align === "center" ? "text-center" : ""}
                        ${isSorted ? "text-[#0F766E]" : ""}
                        ${isDragging ? "opacity-30" : ""}
                        ${isDragOver ? "bg-[#0F766E]/20 border-l-2 border-[#0F766E]" : ""}
                        ${!isExpandCol && c.sortable ? "cursor-pointer hover:bg-[#ECF1F1]" : isExpandCol ? "" : "cursor-grab"}
                      `}
                    >
                      {isExpandCol ? null : (
                        <span className="inline-flex items-center gap-1">
                          <GripVertical className="h-3 w-3 text-gray-300 opacity-0 group-hover:opacity-100 transition cursor-grab" />
                          {c.label}
                          {c.sortable && (
                            isSorted
                              ? (sortDir === "asc" ? <ArrowUp className="h-3 w-3 text-[#0F766E]" /> : <ArrowDown className="h-3 w-3 text-[#0F766E]" />)
                              : <ArrowUpDown className="h-3 w-3 text-gray-300" />
                          )}
                        </span>
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {displayRows.length === 0 && (
                <tr>
                  <td colSpan={visibleColumns.length} className="px-3 py-8 text-center text-gray-400 text-[11px]">
                    No sales orders match the current filters
                  </td>
                </tr>
              )}
              {displayRows.map((so) => {
                const isOpen = expanded.has(so.docNo);
                const soLines = linesByDoc.get(so.docNo) ?? [];
                return [
                  <tr
                    key={so.docNo}
                    className="border-b border-[#F0F3F3] hover:bg-[#F4F7F7] transition-colors cursor-pointer"
                    onClick={() => toggleExpand(so.docNo)}
                  >
                    {visibleColumns.map((c) => (
                      <td
                        key={c.key}
                        className={`px-1.5 py-1.5 whitespace-nowrap
                          ${c.align === "right" ? "text-right" : c.align === "center" ? "text-center" : ""}
                        `}
                      >
                        {c.render(so, ctx)}
                      </td>
                    ))}
                  </tr>,
                  isOpen && (
                    <tr key={`${so.docNo}-detail`}>
                      <td colSpan={visibleColumns.length} className="border-b border-[#DDE5E5] p-0">
                        <LineItemsSubTable lines={soLines} />
                      </td>
                    </tr>
                  ),
                ];
              })}
            </tbody>
          </table>
        </div>
        <div className="px-3 py-2 text-[11px] text-gray-500 border-t border-[#DDE5E5] bg-[#FAFBFB] flex items-center justify-between">
          <span>
            Showing {Math.min(displayRows.length, sorted.length)} of {sorted.length} · {visibleColumns.length} col(s)
            {!showAll && sorted.length > PAGE_SIZE && (
              <button onClick={() => setShowAll(true)} className="ml-3 text-[#0F766E] font-semibold hover:underline">
                Show all {sorted.length}
              </button>
            )}
            {showAll && sorted.length > PAGE_SIZE && (
              <button onClick={() => setShowAll(false)} className="ml-3 text-[#0F766E] font-semibold hover:underline">
                Show first {PAGE_SIZE}
              </button>
            )}
          </span>
          <span className="font-semibold text-[#0A1F2E]">Grand Total: {fmtRM(totalRevenue)}</span>
        </div>
      </div>
    </div>
  );
}
