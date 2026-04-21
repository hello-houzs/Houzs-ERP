import { useState, useMemo } from "react";
import { FileText, Plus, RotateCcw, Search, X, Pencil, Trash2, Check } from "lucide-react";
import { BRANDS, type Brand } from "@/lib/mock-data";
import {
  useSOLines, addSOLine, updateSOLine, removeSOLine, resetSOLines, lineTotal,
  SO_CATEGORIES, type SODetailLine, type SOCategory,
} from "@/lib/so-store";
import { useSKUCostings } from "@/lib/sku-costing-store";
import { useSalesMembers } from "@/lib/sales-store";
import {
  FIELD_LABEL, FIELD_INPUT, FIELD_SELECT, FILTER_SELECT,
  PAGE_TITLE, CARD, TABLE, TABLE_HEAD_ROW, TABLE_HEAD_CELL,
  TABLE_BODY, TABLE_CELL, BTN_PRIMARY, BTN_SECONDARY, BTN_DANGER,
  FILTER_BAR, DIALOG_OVERLAY, DIALOG_HEADER, DIALOG_FOOTER,
  COUNT_BADGE, STAT_LABEL, STAT_VALUE,
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

// ─── Add / Edit Line Dialog ────────────────────────────────────────────────────

interface LineFormProps {
  initial?: SODetailLine;
  onClose: () => void;
}

function LineForm({ initial, onClose }: LineFormProps) {
  const skus = useSKUCostings();
  const members = useSalesMembers();

  const [soNo, setSoNo] = useState(initial?.soNo ?? "");
  const [date, setDate] = useState(initial?.date ?? new Date().toISOString().slice(0, 10));
  const [customer, setCustomer] = useState(initial?.customer ?? "");
  const [salesPersonId, setSalesPersonId] = useState(initial?.salesPersonId ?? "");
  const [sku, setSku] = useState(initial?.sku ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [brand, setBrand] = useState<Brand>(initial?.brand ?? "AKEMI");
  const [category, setCategory] = useState<SOCategory>(initial?.category ?? "Mattress");
  const [qty, setQty] = useState(String(initial?.qty ?? 1));
  const [unitPrice, setUnitPrice] = useState(String(initial?.unitPrice ?? ""));
  const [discount, setDiscount] = useState(String(initial?.discount ?? 0));
  const [notes, setNotes] = useState(initial?.notes ?? "");

  function handleSkuChange(selectedSku: string) {
    setSku(selectedSku);
    const found = skus.find((s) => s.sku === selectedSku);
    if (found) {
      setDescription(found.description);
      setBrand(found.brand);
      setCategory(found.category);
      setUnitPrice(String(found.sellingPrice));
    }
  }

  function submit() {
    const trimmedSo = soNo.trim().toUpperCase();
    if (!trimmedSo || !customer.trim() || !sku.trim()) return;
    const payload = {
      soNo: trimmedSo,
      date,
      customer: customer.trim(),
      salesPersonId,
      sku: sku.trim().toUpperCase(),
      description: description.trim(),
      brand,
      category,
      qty: Math.max(1, parseInt(qty) || 1),
      unitPrice: parseFloat(unitPrice) || 0,
      discount: parseFloat(discount) || 0,
      notes: notes.trim(),
    };
    if (initial) {
      updateSOLine(initial.id, payload);
    } else {
      addSOLine(payload);
    }
    onClose();
  }

  return (
    <div className={DIALOG_OVERLAY}>
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div className={DIALOG_HEADER}>
          <span className="text-[13px] font-bold text-[#0A1F2E]">
            {initial ? "Edit Line Item" : "New Line Item"}
          </span>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-4 overflow-y-auto space-y-3 flex-1">
          {/* Row 1: SO No + Date */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className={FIELD_LABEL}>SO No *</p>
              <input className={FIELD_INPUT} value={soNo} onChange={(e) => setSoNo(e.target.value)}
                placeholder="e.g. ZNT5157" />
            </div>
            <div>
              <p className={FIELD_LABEL}>Date *</p>
              <input type="date" className={FIELD_INPUT} value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
          </div>

          {/* Row 2: Customer + Salesperson */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className={FIELD_LABEL}>Customer *</p>
              <input className={FIELD_INPUT} value={customer} onChange={(e) => setCustomer(e.target.value)}
                placeholder="Customer name" />
            </div>
            <div>
              <p className={FIELD_LABEL}>Salesperson</p>
              <select className={FIELD_SELECT} value={salesPersonId} onChange={(e) => setSalesPersonId(e.target.value)}>
                <option value="">— Select —</option>
                {members.filter((m) => m.status === "ACTIVE").map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Row 3: SKU (dropdown from master) */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className={FIELD_LABEL}>SKU *</p>
              <select className={FIELD_SELECT} value={sku} onChange={(e) => handleSkuChange(e.target.value)}>
                <option value="">— Select SKU —</option>
                {skus.map((s) => (
                  <option key={s.id} value={s.sku}>{s.sku}</option>
                ))}
              </select>
            </div>
            <div>
              <p className={FIELD_LABEL}>Description</p>
              <input className={FIELD_INPUT} value={description} onChange={(e) => setDescription(e.target.value)}
                placeholder="Auto-filled from SKU" />
            </div>
          </div>

          {/* Row 4: Brand + Category */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className={FIELD_LABEL}>Brand</p>
              <select className={FIELD_SELECT} value={brand} onChange={(e) => setBrand(e.target.value as Brand)}>
                {BRANDS.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </div>
            <div>
              <p className={FIELD_LABEL}>Category</p>
              <select className={FIELD_SELECT} value={category} onChange={(e) => setCategory(e.target.value as SOCategory)}>
                {SO_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>

          {/* Row 5: Qty + Unit Price + Discount */}
          <div className="grid grid-cols-3 gap-3">
            <div>
              <p className={FIELD_LABEL}>Qty *</p>
              <input type="number" min={1} className={FIELD_INPUT} value={qty}
                onChange={(e) => setQty(e.target.value)} />
            </div>
            <div>
              <p className={FIELD_LABEL}>Unit Price (RM)</p>
              <input type="number" min={0} step="0.01" className={FIELD_INPUT} value={unitPrice}
                onChange={(e) => setUnitPrice(e.target.value)} placeholder="0.00" />
            </div>
            <div>
              <p className={FIELD_LABEL}>Discount (RM)</p>
              <input type="number" min={0} step="0.01" className={FIELD_INPUT} value={discount}
                onChange={(e) => setDiscount(e.target.value)} placeholder="0.00" />
            </div>
          </div>

          {/* Line Total preview */}
          {unitPrice && (
            <div className="rounded-md bg-[#F4F7F7] border border-[#DDE5E5] px-4 py-2 flex items-center justify-between">
              <span className="text-[11px] text-gray-500">Line Total Preview</span>
              <span className="text-[14px] font-bold text-[#0F766E]">
                {fmtRM((parseInt(qty) || 1) * (parseFloat(unitPrice) || 0) - (parseFloat(discount) || 0))}
              </span>
            </div>
          )}

          {/* Notes */}
          <div>
            <p className={FIELD_LABEL}>Notes</p>
            <input className={FIELD_INPUT} value={notes} onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional notes" />
          </div>
        </div>

        <div className={DIALOG_FOOTER}>
          <button onClick={onClose} className={BTN_SECONDARY}>Cancel</button>
          <button onClick={submit} className={BTN_PRIMARY}>
            <Check className="h-3.5 w-3.5" />
            {initial ? "Save Changes" : "Add Line Item"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function SODetailsPage() {
  const lines = useSOLines();
  const members = useSalesMembers();
  const memberMap = useMemo(() => new Map(members.map((m) => [m.id, m.name])), [members]);

  const [search, setSearch] = useState("");
  const [filterBrand, setFilterBrand] = useState("");
  const [filterSP, setFilterSP] = useState("");
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editLine, setEditLine] = useState<SODetailLine | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return lines.filter((l) => {
      if (q && !l.soNo.toLowerCase().includes(q) && !l.customer.toLowerCase().includes(q) && !l.sku.toLowerCase().includes(q)) return false;
      if (filterBrand && l.brand !== filterBrand) return false;
      if (filterSP && l.salesPersonId !== filterSP) return false;
      if (filterFrom && l.date < filterFrom) return false;
      if (filterTo && l.date > filterTo) return false;
      return true;
    });
  }, [lines, search, filterBrand, filterSP, filterFrom, filterTo]);

  const totalRevenue = useMemo(() => filtered.reduce((s, l) => s + lineTotal(l), 0), [filtered]);
  const avgLineValue = filtered.length > 0 ? totalRevenue / filtered.length : 0;
  const uniqueSOs = useMemo(() => new Set(filtered.map((l) => l.soNo)).size, [filtered]);

  const activeSPs = useMemo(() => {
    const ids = new Set(lines.map((l) => l.salesPersonId));
    return members.filter((m) => ids.has(m.id));
  }, [lines, members]);

  return (
    <div className="min-h-screen bg-[#FAFBFB] p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <FileText className="h-5 w-5 text-[#0F766E]" />
          <h1 className={PAGE_TITLE}>Sales Order Details</h1>
          <span className={COUNT_BADGE}>{lines.length} items</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { if (window.confirm("Reset all SO lines to seed data?")) { resetSOLines(); } }}
            className={BTN_SECONDARY}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reset Data
          </button>
          <button onClick={() => setShowForm(true)} className={BTN_PRIMARY}>
            <Plus className="h-4 w-4" />
            New Line Item
          </button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "Total Lines", value: filtered.length.toString() },
          { label: "Total Revenue", value: fmtRM(totalRevenue) },
          { label: "Avg Line Value", value: fmtRM(avgLineValue) },
          { label: "Unique SOs", value: uniqueSOs.toString() },
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
            placeholder="Search SO No, customer, SKU…"
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
                {["SO No", "Date", "Customer", "Salesperson", "SKU", "Description", "Brand", "Category", "Qty", "Unit Price", "Discount", "Line Total", "Actions"].map((h) => (
                  <th key={h} className={TABLE_HEAD_CELL}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className={TABLE_BODY}>
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={13} className="text-center py-12 text-[11px] text-gray-400">
                    No line items found.
                  </td>
                </tr>
              )}
              {filtered.map((line) => (
                <tr key={line.id} className="hover:bg-[#F4F7F7] transition-colors">
                  <td className={TABLE_CELL}>
                    <span className="font-semibold text-[#0A1F2E]">{line.soNo}</span>
                  </td>
                  <td className={`${TABLE_CELL} whitespace-nowrap text-gray-500`}>{fmtDate(line.date)}</td>
                  <td className={TABLE_CELL}>{line.customer}</td>
                  <td className={TABLE_CELL}>{memberMap.get(line.salesPersonId) ?? line.salesPersonId}</td>
                  <td className={TABLE_CELL}>
                    <span className="font-mono text-[11px] text-[#0F766E]">{line.sku}</span>
                  </td>
                  <td className={`${TABLE_CELL} max-w-[180px]`}>
                    <span className="line-clamp-1 text-gray-700">{line.description}</span>
                  </td>
                  <td className={TABLE_CELL}>
                    <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${BRAND_COLOR[line.brand]}`}>
                      {line.brand}
                    </span>
                  </td>
                  <td className={TABLE_CELL}>
                    <span className={`px-1.5 py-0.5 rounded border text-[9px] font-medium ${CAT_COLOR[line.category]}`}>
                      {line.category}
                    </span>
                  </td>
                  <td className={`${TABLE_CELL} tabular-nums text-right`}>{line.qty}</td>
                  <td className={`${TABLE_CELL} tabular-nums text-right`}>{fmtRM(line.unitPrice)}</td>
                  <td className={`${TABLE_CELL} tabular-nums text-right text-gray-500`}>
                    {line.discount > 0 ? `-${fmtRM(line.discount)}` : "—"}
                  </td>
                  <td className={`${TABLE_CELL} tabular-nums text-right font-semibold text-[#0F766E]`}>
                    {fmtRM(lineTotal(line))}
                  </td>
                  <td className={TABLE_CELL}>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => setEditLine(line)}
                        className="h-6 w-6 rounded flex items-center justify-center text-gray-400 hover:text-[#0F766E] hover:bg-[#F4F7F7] transition-colors"
                        title="Edit"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => setConfirmDelete(line.id)}
                        className="h-6 w-6 rounded flex items-center justify-center text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                        title="Delete"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {filtered.length > 0 && (
          <div className="px-4 py-2 border-t border-[#DDE5E5] bg-[#F4F7F7] flex justify-end">
            <span className="text-[11px] font-semibold text-[#0A1F2E]">
              Total: {fmtRM(totalRevenue)}
            </span>
          </div>
        )}
      </div>

      {/* Add / Edit form modal */}
      {showForm && <LineForm onClose={() => setShowForm(false)} />}
      {editLine && <LineForm initial={editLine} onClose={() => setEditLine(null)} />}

      {/* Delete confirmation */}
      {confirmDelete && (
        <div className={DIALOG_OVERLAY}>
          <div className="bg-white rounded-lg shadow-xl w-80 p-5 space-y-4">
            <p className="text-[13px] font-semibold text-[#0A1F2E]">Delete line item?</p>
            <p className="text-[11px] text-gray-500">This action cannot be undone.</p>
            <div className="flex gap-2 justify-end">
              <button className={BTN_SECONDARY} onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button
                className="h-8 px-3 rounded-md bg-red-500 text-white text-[11px] font-semibold hover:bg-red-600"
                onClick={() => { removeSOLine(confirmDelete); setConfirmDelete(null); }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
