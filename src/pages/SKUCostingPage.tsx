import { useState, useMemo } from "react";
import { Package, Plus, RotateCcw, Search, X, Pencil, Trash2, Check } from "lucide-react";
import { BRANDS, type Brand } from "@/lib/mock-data";
import {
  useSKUCostings, addSKU, updateSKU, removeSKU, resetSKUCostings,
  marginAmount, marginPct, type SKUCosting,
} from "@/lib/sku-costing-store";
import { SO_CATEGORIES, type SOCategory } from "@/lib/so-store";
import {
  FIELD_LABEL, FIELD_INPUT, FIELD_SELECT, FILTER_SELECT,
  PAGE_TITLE, CARD, TABLE, TABLE_HEAD_ROW, TABLE_HEAD_CELL,
  TABLE_BODY, TABLE_CELL, BTN_PRIMARY, BTN_SECONDARY,
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

function fmtPct(n: number) {
  return n.toFixed(1) + "%";
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

function marginRowBg(pct: number) {
  if (pct < 10) return "bg-red-50";
  if (pct < 20) return "bg-amber-50";
  return "";
}

// ─── SKU Form Dialog ──────────────────────────────────────────────────────────

interface SKUFormProps {
  initial?: SKUCosting;
  onClose: () => void;
}

function SKUForm({ initial, onClose }: SKUFormProps) {
  const [sku, setSku] = useState(initial?.sku ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [brand, setBrand] = useState<Brand>(initial?.brand ?? "AKEMI");
  const [category, setCategory] = useState<SOCategory>(initial?.category ?? "Mattress");
  const [supplier, setSupplier] = useState(initial?.supplier ?? "");
  const [costPrice, setCostPrice] = useState(String(initial?.costPrice ?? ""));
  const [sellingPrice, setSellingPrice] = useState(String(initial?.sellingPrice ?? ""));
  const [notes, setNotes] = useState(initial?.notes ?? "");

  const previewMarginAmt = (parseFloat(sellingPrice) || 0) - (parseFloat(costPrice) || 0);
  const previewMarginPct = (parseFloat(sellingPrice) || 0) > 0
    ? (previewMarginAmt / (parseFloat(sellingPrice) || 1)) * 100
    : 0;

  function submit() {
    if (!sku.trim() || !description.trim()) return;
    const payload = {
      sku: sku.trim().toUpperCase(),
      description: description.trim(),
      brand,
      category,
      supplier: supplier.trim() || undefined,
      costPrice: parseFloat(costPrice) || 0,
      sellingPrice: parseFloat(sellingPrice) || 0,
      lastUpdated: new Date().toISOString(),
      notes: notes.trim() || undefined,
    };
    if (initial) {
      updateSKU(initial.id, payload);
    } else {
      addSKU(payload);
    }
    onClose();
  }

  return (
    <div className={DIALOG_OVERLAY}>
      <div className="bg-white rounded-lg shadow-xl w-full max-w-xl max-h-[90vh] flex flex-col">
        <div className={DIALOG_HEADER}>
          <span className="text-[13px] font-bold text-[#0A1F2E]">
            {initial ? "Edit SKU" : "New SKU"}
          </span>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-4 overflow-y-auto space-y-3 flex-1">
          {/* SKU + Description */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className={FIELD_LABEL}>SKU Code *</p>
              <input className={FIELD_INPUT} value={sku} onChange={(e) => setSku(e.target.value)}
                placeholder="e.g. AK-Q-PURELATEX" />
            </div>
            <div>
              <p className={FIELD_LABEL}>Description *</p>
              <input className={FIELD_INPUT} value={description} onChange={(e) => setDescription(e.target.value)}
                placeholder="Product description" />
            </div>
          </div>

          {/* Brand + Category */}
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

          {/* Supplier */}
          <div>
            <p className={FIELD_LABEL}>Supplier</p>
            <input className={FIELD_INPUT} value={supplier} onChange={(e) => setSupplier(e.target.value)}
              placeholder="Supplier name (optional)" />
          </div>

          {/* Cost + Selling */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className={FIELD_LABEL}>Cost Price (RM)</p>
              <input type="number" min={0} step="0.01" className={FIELD_INPUT} value={costPrice}
                onChange={(e) => setCostPrice(e.target.value)} placeholder="0.00" />
            </div>
            <div>
              <p className={FIELD_LABEL}>Selling Price (RM)</p>
              <input type="number" min={0} step="0.01" className={FIELD_INPUT} value={sellingPrice}
                onChange={(e) => setSellingPrice(e.target.value)} placeholder="0.00" />
            </div>
          </div>

          {/* Margin preview */}
          {costPrice && sellingPrice && (
            <div className={`rounded-md border px-4 py-2 flex items-center justify-between ${
              previewMarginPct < 10 ? "bg-red-50 border-red-200" :
              previewMarginPct < 20 ? "bg-amber-50 border-amber-200" :
              "bg-[#F4F7F7] border-[#DDE5E5]"
            }`}>
              <span className="text-[11px] text-gray-500">Margin Preview</span>
              <div className="flex items-center gap-3 text-[12px] font-semibold">
                <span className={previewMarginPct < 10 ? "text-red-600" : previewMarginPct < 20 ? "text-amber-600" : "text-[#0F766E]"}>
                  {fmtRM(previewMarginAmt)}
                </span>
                <span className={`text-[11px] px-2 py-0.5 rounded-full font-bold ${
                  previewMarginPct < 10 ? "bg-red-100 text-red-700" :
                  previewMarginPct < 20 ? "bg-amber-100 text-amber-700" :
                  "bg-[#0F766E]/10 text-[#0F766E]"
                }`}>
                  {fmtPct(previewMarginPct)}
                </span>
              </div>
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
            {initial ? "Save Changes" : "Add SKU"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Inline price editor ──────────────────────────────────────────────────────

function InlineEditor({ skuItem }: { skuItem: SKUCosting }) {
  const [editCost, setEditCost] = useState(false);
  const [editSell, setEditSell] = useState(false);
  const [costVal, setCostVal] = useState(String(skuItem.costPrice));
  const [sellVal, setSellVal] = useState(String(skuItem.sellingPrice));

  function saveCost() {
    const v = parseFloat(costVal);
    if (!isNaN(v)) updateSKU(skuItem.id, { costPrice: v, lastUpdated: new Date().toISOString() });
    setEditCost(false);
  }
  function saveSell() {
    const v = parseFloat(sellVal);
    if (!isNaN(v)) updateSKU(skuItem.id, { sellingPrice: v, lastUpdated: new Date().toISOString() });
    setEditSell(false);
  }

  return (
    <>
      <td className={`${TABLE_CELL} tabular-nums text-right`}>
        {editCost ? (
          <span className="flex items-center gap-1 justify-end">
            <input
              autoFocus
              type="number"
              className="w-24 h-6 rounded border border-[#0F766E] px-1.5 text-[11px] text-right focus:outline-none"
              value={costVal}
              onChange={(e) => setCostVal(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") saveCost(); if (e.key === "Escape") setEditCost(false); }}
            />
            <button onClick={saveCost} className="text-[#0F766E] hover:text-[#0D6B63]"><Check className="h-3 w-3" /></button>
          </span>
        ) : (
          <button
            className="hover:text-[#0F766E] hover:underline tabular-nums"
            onClick={() => { setCostVal(String(skuItem.costPrice)); setEditCost(true); }}
            title="Click to edit"
          >
            {fmtRM(skuItem.costPrice)}
          </button>
        )}
      </td>
      <td className={`${TABLE_CELL} tabular-nums text-right`}>
        {editSell ? (
          <span className="flex items-center gap-1 justify-end">
            <input
              autoFocus
              type="number"
              className="w-24 h-6 rounded border border-[#0F766E] px-1.5 text-[11px] text-right focus:outline-none"
              value={sellVal}
              onChange={(e) => setSellVal(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") saveSell(); if (e.key === "Escape") setEditSell(false); }}
            />
            <button onClick={saveSell} className="text-[#0F766E] hover:text-[#0D6B63]"><Check className="h-3 w-3" /></button>
          </span>
        ) : (
          <button
            className="hover:text-[#0F766E] hover:underline tabular-nums"
            onClick={() => { setSellVal(String(skuItem.sellingPrice)); setEditSell(true); }}
            title="Click to edit"
          >
            {fmtRM(skuItem.sellingPrice)}
          </button>
        )}
      </td>
    </>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function SKUCostingPage() {
  const skus = useSKUCostings();

  const [search, setSearch] = useState("");
  const [filterBrand, setFilterBrand] = useState("");
  const [filterCat, setFilterCat] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editSKU, setEditSKU] = useState<SKUCosting | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return skus.filter((s) => {
      if (q && !s.sku.toLowerCase().includes(q) && !s.description.toLowerCase().includes(q) && !(s.supplier ?? "").toLowerCase().includes(q)) return false;
      if (filterBrand && s.brand !== filterBrand) return false;
      if (filterCat && s.category !== filterCat) return false;
      return true;
    });
  }, [skus, search, filterBrand, filterCat]);

  const avgCost = useMemo(() => filtered.length ? filtered.reduce((s, x) => s + x.costPrice, 0) / filtered.length : 0, [filtered]);
  const avgMargin = useMemo(() => filtered.length ? filtered.reduce((s, x) => s + marginPct(x), 0) / filtered.length : 0, [filtered]);
  const brandsCovered = useMemo(() => new Set(filtered.map((s) => s.brand)).size, [filtered]);

  return (
    <div className="min-h-screen bg-[#FAFBFB] p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <Package className="h-5 w-5 text-[#0F766E]" />
          <h1 className={PAGE_TITLE}>All SKU Costing</h1>
          <span className={COUNT_BADGE}>{skus.length} SKUs</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { if (window.confirm("Reset all SKU costings to seed data?")) { resetSKUCostings(); } }}
            className={BTN_SECONDARY}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reset Data
          </button>
          <button onClick={() => setShowForm(true)} className={BTN_PRIMARY}>
            <Plus className="h-4 w-4" />
            New SKU
          </button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "Total SKUs", value: filtered.length.toString() },
          { label: "Avg Cost", value: fmtRM(avgCost) },
          { label: "Avg Margin %", value: fmtPct(avgMargin) },
          { label: "Brands Covered", value: brandsCovered.toString() },
        ].map(({ label, value }) => (
          <div key={label} className={`${CARD} px-4 py-3`}>
            <p className={STAT_LABEL}>{label}</p>
            <p className={`${STAT_VALUE} text-[#0A1F2E]`}>{value}</p>
          </div>
        ))}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-3 text-[10px] text-gray-500">
        <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded bg-red-100 border border-red-200" /> Margin &lt; 10%</span>
        <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded bg-amber-50 border border-amber-200" /> Margin 10–20%</span>
        <span className="text-gray-400">· Click Cost/Selling price cells to edit inline</span>
      </div>

      {/* Filters */}
      <div className={FILTER_BAR}>
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400 pointer-events-none" />
          <input
            className="w-full h-8 pl-8 pr-8 rounded-md border border-[#DDE5E5] bg-white text-[11px] text-[#0A1F2E] placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-[#0F766E]/30 focus:border-[#0F766E]"
            placeholder="Search SKU, description, supplier…"
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
        <select className={FILTER_SELECT} value={filterCat} onChange={(e) => setFilterCat(e.target.value)}>
          <option value="">All Categories</option>
          {SO_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        {(filterBrand || filterCat) && (
          <button className={BTN_SECONDARY} onClick={() => { setFilterBrand(""); setFilterCat(""); }}>
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
                {["SKU", "Description", "Brand", "Category", "Supplier", "Cost Price", "Selling Price", "Margin RM", "Margin %", "Last Updated", "Actions"].map((h) => (
                  <th key={h} className={TABLE_HEAD_CELL}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className={TABLE_BODY}>
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={11} className="text-center py-12 text-[11px] text-gray-400">
                    No SKUs found.
                  </td>
                </tr>
              )}
              {filtered.map((s) => {
                const mAmt = marginAmount(s);
                const mPct = marginPct(s);
                const rowBg = marginRowBg(mPct);
                return (
                  <tr key={s.id} className={`hover:bg-[#F4F7F7] transition-colors ${rowBg}`}>
                    <td className={TABLE_CELL}>
                      <span className="font-mono text-[11px] font-semibold text-[#0F766E]">{s.sku}</span>
                    </td>
                    <td className={`${TABLE_CELL} max-w-[200px]`}>
                      <span className="line-clamp-1 text-gray-700">{s.description}</span>
                    </td>
                    <td className={TABLE_CELL}>
                      <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${BRAND_COLOR[s.brand]}`}>
                        {s.brand}
                      </span>
                    </td>
                    <td className={TABLE_CELL}>
                      <span className={`px-1.5 py-0.5 rounded border text-[9px] font-medium ${CAT_COLOR[s.category]}`}>
                        {s.category}
                      </span>
                    </td>
                    <td className={`${TABLE_CELL} text-gray-500 max-w-[150px]`}>
                      <span className="line-clamp-1">{s.supplier ?? "—"}</span>
                    </td>
                    {/* Inline-editable price cells */}
                    <InlineEditor skuItem={s} />
                    <td className={`${TABLE_CELL} tabular-nums text-right font-semibold ${mAmt >= 0 ? "text-[#0F766E]" : "text-red-600"}`}>
                      {fmtRM(mAmt)}
                    </td>
                    <td className={TABLE_CELL}>
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                        mPct < 10 ? "bg-red-100 text-red-700" :
                        mPct < 20 ? "bg-amber-100 text-amber-700" :
                        "bg-emerald-100 text-emerald-700"
                      }`}>
                        {fmtPct(mPct)}
                      </span>
                    </td>
                    <td className={`${TABLE_CELL} text-gray-400 whitespace-nowrap`}>{fmtDate(s.lastUpdated)}</td>
                    <td className={TABLE_CELL}>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => setEditSKU(s)}
                          className="h-6 w-6 rounded flex items-center justify-center text-gray-400 hover:text-[#0F766E] hover:bg-[#F4F7F7] transition-colors"
                          title="Edit full form"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => setConfirmDelete(s.id)}
                          className="h-6 w-6 rounded flex items-center justify-center text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                          title="Delete"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add / Edit form modal */}
      {showForm && <SKUForm onClose={() => setShowForm(false)} />}
      {editSKU && <SKUForm initial={editSKU} onClose={() => setEditSKU(null)} />}

      {/* Delete confirmation */}
      {confirmDelete && (
        <div className={DIALOG_OVERLAY}>
          <div className="bg-white rounded-lg shadow-xl w-80 p-5 space-y-4">
            <p className="text-[13px] font-semibold text-[#0A1F2E]">Delete this SKU?</p>
            <p className="text-[11px] text-gray-500">
              This will permanently remove the SKU from the master list. Existing sales order lines referencing this SKU will not be affected.
            </p>
            <div className="flex gap-2 justify-end">
              <button className={BTN_SECONDARY} onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button
                className="h-8 px-3 rounded-md bg-red-500 text-white text-[11px] font-semibold hover:bg-red-600"
                onClick={() => { removeSKU(confirmDelete); setConfirmDelete(null); }}
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
