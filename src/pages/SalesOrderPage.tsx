import { useState, useMemo } from "react";
import { Receipt, Search, X, ChevronDown, ChevronRight, Info } from "lucide-react";
import { BRANDS, type Brand } from "@/lib/mock-data";
import {
  useSOLines, getConsolidatedSOs, lineTotal,
  type SODetailLine, type SOCategory,
} from "@/lib/so-store";
import { useSalesMembers } from "@/lib/sales-store";
import {
  PAGE_TITLE, CARD, TABLE, TABLE_HEAD_ROW, TABLE_HEAD_CELL,
  TABLE_BODY, TABLE_CELL, FILTER_BAR, FILTER_SELECT,
  COUNT_BADGE, STAT_LABEL, STAT_VALUE, BTN_SECONDARY,
} from "@/lib/ui-tokens";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtRM(n: number) {
  return "RM " + n.toLocaleString("en-MY", { minimumFractionDigits: 2 });
}

function fmtDate(d: string) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

const BRAND_COLOR: Record<Brand, string> = {
  AKEMI: "bg-blue-100 text-blue-700",
  ZANOTTI: "bg-purple-100 text-purple-700",
  ERGOTEX: "bg-cyan-100 text-cyan-700",
  DUNLOPILLO: "bg-emerald-100 text-emerald-700",
};

const CAT_COLOR: Record<SOCategory, string> = {
  Mattress: "bg-amber-50 text-amber-700 border-amber-200",
  Bedframe: "bg-rose-50 text-rose-700 border-rose-200",
  Accessories: "bg-gray-100 text-gray-600 border-gray-200",
  Pillow: "bg-sky-50 text-sky-700 border-sky-200",
  Topper: "bg-violet-50 text-violet-700 border-violet-200",
};

// ─── Expanded line-items sub-table ────────────────────────────────────────────

function LineItemsSubTable({ lines }: { lines: SODetailLine[] }) {
  return (
    <div className="px-4 pb-3 pt-1">
      <div className="rounded-md border border-[#DDE5E5] overflow-hidden overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="bg-[#F4F7F7] text-[9px] font-semibold uppercase tracking-wider text-gray-500">
              <th className="text-left px-3 py-1.5">SKU</th>
              <th className="text-left px-3 py-1.5">Description</th>
              <th className="text-left px-3 py-1.5">Brand</th>
              <th className="text-left px-3 py-1.5">Category</th>
              <th className="text-right px-3 py-1.5">Qty</th>
              <th className="text-right px-3 py-1.5">Unit Price</th>
              <th className="text-right px-3 py-1.5">Discount</th>
              <th className="text-right px-3 py-1.5">Line Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#F0F3F3] bg-white">
            {lines.map((l) => (
              <tr key={l.id} className="hover:bg-[#FAFBFB]">
                <td className="px-3 py-1.5 font-mono text-[10px] text-[#0F766E]">{l.sku}</td>
                <td className="px-3 py-1.5 text-gray-700 max-w-[200px]">
                  <span className="line-clamp-1">{l.description}</span>
                </td>
                <td className="px-3 py-1.5">
                  <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${BRAND_COLOR[l.brand]}`}>
                    {l.brand}
                  </span>
                </td>
                <td className="px-3 py-1.5">
                  <span className={`px-1.5 py-0.5 rounded border text-[9px] font-medium ${CAT_COLOR[l.category]}`}>
                    {l.category}
                  </span>
                </td>
                <td className="px-3 py-1.5 tabular-nums text-right">{l.qty}</td>
                <td className="px-3 py-1.5 tabular-nums text-right">{fmtRM(l.unitPrice)}</td>
                <td className="px-3 py-1.5 tabular-nums text-right text-gray-500">
                  {l.discount > 0 ? `-${fmtRM(l.discount)}` : "—"}
                </td>
                <td className="px-3 py-1.5 tabular-nums text-right font-semibold text-[#0F766E]">
                  {fmtRM(lineTotal(l))}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-[#F4F7F7] border-t border-[#DDE5E5]">
              <td colSpan={7} className="px-3 py-1.5 text-[10px] font-semibold text-gray-500 text-right">
                Subtotal
              </td>
              <td className="px-3 py-1.5 tabular-nums text-right text-[12px] font-bold text-[#0F766E]">
                {fmtRM(lines.reduce((s, l) => s + lineTotal(l), 0))}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="mt-1.5 text-[10px] text-gray-400 flex items-center gap-1">
        <Info className="h-3 w-3" />
        To edit line items, go to Sales Order Details.
      </p>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function SalesOrderPage() {
  const lines = useSOLines();
  const members = useSalesMembers();
  const consolidated = useMemo(() => getConsolidatedSOs(lines, members), [lines, members]);

  const [search, setSearch] = useState("");
  const [filterBrand, setFilterBrand] = useState("");
  const [filterSP, setFilterSP] = useState("");
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggleExpand(soNo: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(soNo)) { next.delete(soNo); } else { next.add(soNo); }
      return next;
    });
  }

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return consolidated.filter((so) => {
      if (q && !so.soNo.toLowerCase().includes(q) && !so.customer.toLowerCase().includes(q) && !so.salesPersonName.toLowerCase().includes(q)) return false;
      if (filterBrand && !so.lines.some((l) => l.brand === filterBrand)) return false;
      if (filterSP) {
        const member = members.find((m) => m.id === filterSP);
        if (!member || !so.lines.some((l) => l.salesPersonId === filterSP)) return false;
      }
      if (filterFrom && so.date < filterFrom) return false;
      if (filterTo && so.date > filterTo) return false;
      return true;
    });
  }, [consolidated, search, filterBrand, filterSP, filterFrom, filterTo, members]);

  const totalRevenue = useMemo(() => filtered.reduce((s, so) => s + so.grandTotal, 0), [filtered]);
  const totalQty = useMemo(() => filtered.reduce((s, so) => s + so.totalQty, 0), [filtered]);
  const avgOrderValue = filtered.length > 0 ? totalRevenue / filtered.length : 0;

  const activeSPs = useMemo(() => {
    const ids = new Set(lines.map((l) => l.salesPersonId));
    return members.filter((m) => ids.has(m.id));
  }, [lines, members]);

  return (
    <div className="min-h-screen bg-[#FAFBFB] p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <Receipt className="h-5 w-5 text-[#0F766E]" />
          <h1 className={PAGE_TITLE}>Sales Orders</h1>
          <span className={COUNT_BADGE}>{consolidated.length} orders</span>
        </div>
        <p className="text-[11px] text-gray-400 italic">
          Consolidated from line items — edit in Sales Order Details
        </p>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "Total Orders", value: filtered.length.toString() },
          { label: "Total Revenue", value: fmtRM(totalRevenue) },
          { label: "Total Qty", value: totalQty.toString() },
          { label: "Avg Order Value", value: fmtRM(avgOrderValue) },
        ].map(({ label, value }) => (
          <div key={label} className={`${CARD} px-4 py-3`}>
            <p className={STAT_LABEL}>{label}</p>
            <p className={`${STAT_VALUE} text-[#0A1F2E]`}>{value}</p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className={FILTER_BAR}>
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400 pointer-events-none" />
          <input
            className="w-full h-8 pl-8 pr-8 rounded-md border border-[#DDE5E5] bg-white text-[11px] text-[#0A1F2E] placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-[#0F766E]/30 focus:border-[#0F766E]"
            placeholder="Search SO No, customer, salesperson…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600" onClick={() => setSearch("")}>
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <select className={FILTER_SELECT} value={filterBrand} onChange={(e) => setFilterBrand(e.target.value)}>
          <option value="">All Brands</option>
          {BRANDS.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
        <select className={FILTER_SELECT} value={filterSP} onChange={(e) => setFilterSP(e.target.value)}>
          <option value="">All Salespersons</option>
          {activeSPs.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        <input type="date" className={FILTER_SELECT} value={filterFrom} onChange={(e) => setFilterFrom(e.target.value)} title="From date" />
        <input type="date" className={FILTER_SELECT} value={filterTo} onChange={(e) => setFilterTo(e.target.value)} title="To date" />
        {(filterBrand || filterSP || filterFrom || filterTo) && (
          <button className={BTN_SECONDARY} onClick={() => { setFilterBrand(""); setFilterSP(""); setFilterFrom(""); setFilterTo(""); }}>
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
                <th className={TABLE_HEAD_CELL} style={{ width: 24 }} />
                {["SO No", "Date", "Customer", "Salesperson", "Items", "Total Qty", "Subtotal", "Grand Total"].map((h) => (
                  <th key={h} className={TABLE_HEAD_CELL}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className={TABLE_BODY}>
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={9} className="text-center py-12 text-[11px] text-gray-400">
                    No sales orders found.
                  </td>
                </tr>
              )}
              {filtered.map((so) => {
                const isOpen = expanded.has(so.soNo);
                return [
                  <tr
                    key={so.soNo}
                    className="hover:bg-[#F4F7F7] transition-colors cursor-pointer"
                    onClick={() => toggleExpand(so.soNo)}
                  >
                    <td className="px-2 py-2 text-gray-400">
                      {isOpen
                        ? <ChevronDown className="h-3.5 w-3.5" />
                        : <ChevronRight className="h-3.5 w-3.5" />}
                    </td>
                    <td className={TABLE_CELL}>
                      <span className="font-semibold text-[#0A1F2E]">{so.soNo}</span>
                    </td>
                    <td className={`${TABLE_CELL} whitespace-nowrap text-gray-500`}>{fmtDate(so.date)}</td>
                    <td className={TABLE_CELL}>{so.customer}</td>
                    <td className={TABLE_CELL}>{so.salesPersonName}</td>
                    <td className={`${TABLE_CELL} text-center`}>
                      <span className="inline-flex items-center justify-center h-5 w-5 rounded-full bg-[#0F766E]/10 text-[10px] font-semibold text-[#0F766E]">
                        {so.itemCount}
                      </span>
                    </td>
                    <td className={`${TABLE_CELL} tabular-nums text-right`}>{so.totalQty}</td>
                    <td className={`${TABLE_CELL} tabular-nums text-right`}>{fmtRM(so.subtotal)}</td>
                    <td className={`${TABLE_CELL} tabular-nums text-right font-semibold text-[#0F766E]`}>
                      {fmtRM(so.grandTotal)}
                    </td>
                  </tr>,
                  isOpen && (
                    <tr key={`${so.soNo}-detail`}>
                      <td colSpan={9} className="bg-[#FAFBFB] border-b border-[#DDE5E5]">
                        <LineItemsSubTable lines={so.lines} />
                      </td>
                    </tr>
                  ),
                ];
              })}
            </tbody>
          </table>
        </div>
        {filtered.length > 0 && (
          <div className="px-4 py-2 border-t border-[#DDE5E5] bg-[#F4F7F7] flex justify-end">
            <span className="text-[11px] font-semibold text-[#0A1F2E]">
              Grand Total: {fmtRM(totalRevenue)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
