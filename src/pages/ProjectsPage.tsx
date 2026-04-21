// Venue / Project roll-up — aggregates cost, revenue, and margin per venue.
// Each "project" = one venue/fair from the FAIR REPORT structure.

import { useState, useMemo } from "react";
import { Building2, Search, X, TrendingUp, TrendingDown } from "lucide-react";
import {
  useSOLines, useSOHeaders, getVenueRollup,
  type VenueRollup,
} from "@/lib/so-store";
import {
  PAGE_TITLE, CARD, STAT_LABEL, STAT_VALUE,
  COUNT_BADGE, TABLE, TABLE_HEAD_ROW, TABLE_HEAD_CELL, TABLE_BODY, TABLE_CELL,
  FILTER_BAR, FILTER_SELECT, BTN_SECONDARY,
} from "@/lib/ui-tokens";

function fmtRM(n: number) {
  return "RM " + n.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPct(n: number) {
  return n.toFixed(1) + "%";
}

function marginBadge(pct: number) {
  if (pct >= 50) return "bg-emerald-100 text-emerald-700";
  if (pct >= 30) return "bg-amber-100 text-amber-700";
  if (pct > 0) return "bg-orange-100 text-orange-700";
  return "bg-red-100 text-red-700";
}

function barWidth(value: number, max: number): string {
  if (max <= 0) return "0%";
  return `${Math.max(2, Math.min(100, (value / max) * 100))}%`;
}

export default function ProjectsPage() {
  const lines = useSOLines();
  const headers = useSOHeaders();

  const rollup = useMemo(() => getVenueRollup(lines, headers), [lines, headers]);

  const [search, setSearch] = useState("");
  const [brandFilter, setBrandFilter] = useState("");
  const [sortKey, setSortKey] = useState<keyof VenueRollup>("revenue");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const allBrands = useMemo(() => {
    const s = new Set<string>();
    rollup.forEach((r) => r.brands.forEach((b) => s.add(b)));
    return [...s].sort();
  }, [rollup]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return rollup.filter((r) => {
      if (q && !r.venue.toLowerCase().includes(q)) return false;
      if (brandFilter && !r.brands.includes(brandFilter)) return false;
      return true;
    });
  }, [rollup, search, brandFilter]);

  const sorted = useMemo(() => {
    const copy = [...filtered];
    copy.sort((a, b) => {
      const va = a[sortKey];
      const vb = b[sortKey];
      const cmp = typeof va === "number" && typeof vb === "number"
        ? va - vb
        : String(va).localeCompare(String(vb));
      return sortDir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [filtered, sortKey, sortDir]);

  const totals = useMemo(() => ({
    revenue: sorted.reduce((s, r) => s + r.revenue, 0),
    cost: sorted.reduce((s, r) => s + r.cost, 0),
    margin: sorted.reduce((s, r) => s + r.margin, 0),
    orders: sorted.reduce((s, r) => s + r.orderCount, 0),
    venues: sorted.length,
  }), [sorted]);

  const maxRevenue = Math.max(...sorted.map((r) => r.revenue), 0);

  function toggleSort(k: keyof VenueRollup) {
    if (sortKey === k) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else { setSortKey(k); setSortDir("desc"); }
  }

  function sortArrow(k: keyof VenueRollup) {
    if (sortKey !== k) return "";
    return sortDir === "asc" ? " ▲" : " ▼";
  }

  return (
    <div className="min-h-screen bg-[#FAFBFB] p-4 space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <Building2 className="h-5 w-5 text-[#0F766E] shrink-0" />
          <h1 className={PAGE_TITLE}>Projects (By Venue)</h1>
          <span className={COUNT_BADGE}>{rollup.length} venues</span>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {[
          { label: "Venues", value: totals.venues.toString() },
          { label: "Total Orders", value: totals.orders.toString() },
          { label: "Total Revenue", value: fmtRM(totals.revenue) },
          { label: "Total Cost", value: fmtRM(totals.cost) },
          { label: "Gross Margin", value: fmtRM(totals.margin) + (totals.revenue > 0 ? ` (${(totals.margin / totals.revenue * 100).toFixed(1)}%)` : "") },
        ].map(({ label, value }) => (
          <div key={label} className={`${CARD} px-3 py-2`}>
            <p className={STAT_LABEL}>{label}</p>
            <p className={`${STAT_VALUE} text-[#0A1F2E] text-[13px]`}>{value}</p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className={FILTER_BAR}>
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400 pointer-events-none" />
          <input
            className="w-full h-8 pl-8 pr-8 rounded-md border border-[#DDE5E5] bg-white text-[11px] text-[#0A1F2E] placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-[#0F766E]/30 focus:border-[#0F766E]"
            placeholder="Search venue name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600" onClick={() => setSearch("")}>
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <select className={FILTER_SELECT} value={brandFilter} onChange={(e) => setBrandFilter(e.target.value)}>
          <option value="">All Brands</option>
          {allBrands.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
        {(search || brandFilter) && (
          <button className={BTN_SECONDARY} onClick={() => { setSearch(""); setBrandFilter(""); }}>
            <X className="h-3 w-3" /> Clear
          </button>
        )}
      </div>

      {/* Table */}
      <div className={`${CARD} overflow-hidden`}>
        <div className="overflow-x-auto">
          <table className={TABLE}>
            <thead>
              <tr className={TABLE_HEAD_ROW}>
                <th className={`${TABLE_HEAD_CELL} cursor-pointer`} onClick={() => toggleSort("venue")}>
                  Venue{sortArrow("venue")}
                </th>
                <th className={`${TABLE_HEAD_CELL} cursor-pointer text-right`} onClick={() => toggleSort("orderCount")}>
                  Orders{sortArrow("orderCount")}
                </th>
                <th className={`${TABLE_HEAD_CELL} cursor-pointer text-right`} onClick={() => toggleSort("lineCount")}>
                  Lines{sortArrow("lineCount")}
                </th>
                <th className={`${TABLE_HEAD_CELL} cursor-pointer text-right`} onClick={() => toggleSort("revenue")}>
                  Revenue{sortArrow("revenue")}
                </th>
                <th className={TABLE_HEAD_CELL}>Rev. share</th>
                <th className={`${TABLE_HEAD_CELL} cursor-pointer text-right`} onClick={() => toggleSort("cost")}>
                  Cost{sortArrow("cost")}
                </th>
                <th className={`${TABLE_HEAD_CELL} cursor-pointer text-right`} onClick={() => toggleSort("margin")}>
                  Margin{sortArrow("margin")}
                </th>
                <th className={`${TABLE_HEAD_CELL} cursor-pointer text-right`} onClick={() => toggleSort("marginPct")}>
                  Margin %{sortArrow("marginPct")}
                </th>
                <th className={`${TABLE_HEAD_CELL} cursor-pointer text-right`} onClick={() => toggleSort("balance")}>
                  Outstanding{sortArrow("balance")}
                </th>
                <th className={TABLE_HEAD_CELL}>Brands</th>
              </tr>
            </thead>
            <tbody className={TABLE_BODY}>
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={10} className="text-center py-12 text-[11px] text-gray-400">No venues match the filters.</td>
                </tr>
              )}
              {sorted.map((r) => (
                <tr key={r.venue} className="hover:bg-[#F4F7F7] transition-colors">
                  <td className={`${TABLE_CELL} max-w-[280px]`}>
                    <span className="font-semibold text-[#0A1F2E] line-clamp-1" title={r.venue}>{r.venue}</span>
                  </td>
                  <td className={`${TABLE_CELL} tabular-nums text-right`}>{r.orderCount}</td>
                  <td className={`${TABLE_CELL} tabular-nums text-right text-gray-500`}>{r.lineCount}</td>
                  <td className={`${TABLE_CELL} tabular-nums text-right font-semibold`}>{fmtRM(r.revenue)}</td>
                  <td className={`${TABLE_CELL} min-w-[100px]`}>
                    <div className="relative h-2 rounded-full bg-gray-100 overflow-hidden">
                      <div className="absolute inset-y-0 left-0 bg-[#0F766E]/70 rounded-full"
                           style={{ width: barWidth(r.revenue, maxRevenue) }} />
                    </div>
                  </td>
                  <td className={`${TABLE_CELL} tabular-nums text-right text-gray-600`}>{fmtRM(r.cost)}</td>
                  <td className={`${TABLE_CELL} tabular-nums text-right font-semibold ${r.margin >= 0 ? "text-[#0F766E]" : "text-red-600"}`}>
                    <span className="inline-flex items-center gap-1">
                      {r.margin >= 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                      {fmtRM(r.margin)}
                    </span>
                  </td>
                  <td className={TABLE_CELL + " text-right"}>
                    {r.revenue > 0 ? (
                      <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-bold ${marginBadge(r.marginPct)}`}>
                        {fmtPct(r.marginPct)}
                      </span>
                    ) : <span className="text-gray-400">—</span>}
                  </td>
                  <td className={`${TABLE_CELL} tabular-nums text-right ${r.balance > 0 ? "text-red-600 font-semibold" : "text-gray-400"}`}>
                    {r.balance > 0 ? fmtRM(r.balance) : "—"}
                  </td>
                  <td className={TABLE_CELL}>
                    <div className="flex flex-wrap gap-1">
                      {r.brands.length === 0 && <span className="text-gray-400 text-[10px]">—</span>}
                      {r.brands.map((b) => (
                        <span key={b} className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-700 text-[9px] font-semibold">{b}</span>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
            {sorted.length > 0 && (
              <tfoot>
                <tr className="bg-[#F4F7F7] border-t-2 border-[#0F766E]/20 font-bold">
                  <td className={TABLE_CELL}>TOTAL ({sorted.length} venues)</td>
                  <td className={`${TABLE_CELL} tabular-nums text-right`}>{totals.orders}</td>
                  <td className={`${TABLE_CELL} tabular-nums text-right text-gray-500`}>{sorted.reduce((s, r) => s + r.lineCount, 0)}</td>
                  <td className={`${TABLE_CELL} tabular-nums text-right`}>{fmtRM(totals.revenue)}</td>
                  <td className={TABLE_CELL}></td>
                  <td className={`${TABLE_CELL} tabular-nums text-right`}>{fmtRM(totals.cost)}</td>
                  <td className={`${TABLE_CELL} tabular-nums text-right text-[#0F766E]`}>{fmtRM(totals.margin)}</td>
                  <td className={`${TABLE_CELL} tabular-nums text-right text-[#0F766E]`}>
                    {totals.revenue > 0 ? fmtPct(totals.margin / totals.revenue * 100) : "—"}
                  </td>
                  <td className={TABLE_CELL}></td>
                  <td className={TABLE_CELL}></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}
