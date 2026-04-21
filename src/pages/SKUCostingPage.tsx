// SKU Costing — one sidebar entry, internal view toggle + category tabs.
// Layout mirrors hookka-erp-vite /products: SKU Master / Maintenance tabs beside title (left),
// category tabs + Import/Export on right (only when SKU Master).
// Bedframe + Sofa use dedicated column templates (no Fabric / Total Min per user request).

import { useState, useMemo } from "react";
import {
  Package, Plus, RotateCcw, Search, X, Pencil, Trash2, Check,
  Settings2, Upload, Download, ChevronRight,
} from "lucide-react";
import {
  useSKUCostings, addSKU, updateSKU, removeSKU, resetSKUCostings,
  SKU_ITEM_GROUPS,
  type SKUCosting, type SKUItemGroup, type SKUBrand,
} from "@/lib/sku-costing-store";
import VariantMaintenance from "@/components/VariantMaintenance";
import {
  FIELD_LABEL, FIELD_INPUT, FIELD_SELECT, FILTER_SELECT,
  PAGE_TITLE, CARD, BTN_PRIMARY, BTN_SECONDARY,
  DIALOG_OVERLAY, DIALOG_HEADER, DIALOG_FOOTER,
  COUNT_BADGE, STAT_LABEL, STAT_VALUE,
} from "@/lib/ui-tokens";

// ─── Format helpers ───────────────────────────────────────────────────────────

function fmtRM(n: number): string {
  if (!n || n <= 0) return "—";
  return "RM " + n.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtRMPlain(n: number): string {
  if (!n || n <= 0) return "—";
  return n.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Size inferred from Item Code suffix
function inferSize(code: string): string {
  const up = code.toUpperCase();
  if (/\(SK\)/.test(up) || /200X200/.test(up)) return "6FT+";
  if (/\(K\)/.test(up) || /183X/.test(up)) return "6FT";
  if (/\(Q\)/.test(up) || /152X/.test(up)) return "5FT";
  if (/\(SS\)/.test(up) || /107X/.test(up)) return "3.5FT";
  if (/\(S\)/.test(up) || /90X/.test(up)) return "3FT";
  if (/\(TWIN\)/.test(up)) return "TWIN";
  return "—";
}

// Model inferred from Sofa item code (prefix before `-`)
function inferModel(code: string): string {
  const m = code.match(/^([A-Z0-9]+)/);
  return m ? m[1] : "—";
}

// Secondary description line — lowercase product code + size hint, like hookka /products
function descSubtitle(sku: SKUCosting): string {
  return `${sku.description} ${sku.itemCode}`.toLowerCase().trim();
}

// ─── Category definitions (public — App.tsx imports) ────────────────────────

export type CategoryKey = "BEDFRAME" | "SOFA" | "MATT_ACC" | "OTHERS";

export interface CategoryDef {
  key: CategoryKey;
  label: string;
  shortLabel: string;
  route: string;
  /** item groups belonging to this category */
  groups: SKUItemGroup[];
}

export const CATEGORIES: CategoryDef[] = [
  { key: "BEDFRAME",  label: "Bedframe SKU Costing",                shortLabel: "Bedframe",   route: "/sales/sku/bedframe",  groups: ["BEDFRAME"] },
  { key: "SOFA",      label: "Sofa SKU Costing",                    shortLabel: "Sofa",       route: "/sales/sku/sofa",      groups: ["SOFA"] },
  { key: "MATT_ACC",  label: "Mattress & Accessories SKU Costing",  shortLabel: "Mattress & Acc", route: "/sales/sku/matt-acc", groups: ["MATTRESS", "ACC", "BEDLINES"] },
  { key: "OTHERS",    label: "Others SKU Costing",                  shortLabel: "Others",     route: "/sales/sku/others",    groups: ["DINING", "CARPET", "DIFFUSER", "TRANS", "OTHER"] },
];

// ─── Visual tokens ────────────────────────────────────────────────────────────

const ALL_BRANDS: SKUBrand[] = [
  "AKEMI", "ZANOTTI", "ERGOTEX", "DUNLOPILLO", "HOUZS", "MYLATEX", "GETHA",
  "AERO", "THL3", "JM", "TNS", "NAKI", "CARRESS", "NICOLLO", "ARMANI",
  "DORSETTLOFT", "ANNEX", "MAJESTIC", "TODERN", "LAVEO", "BEST", "RED_SOFA",
  "C_AND_C", "OTHER",
];

const BRAND_COLOR: Record<string, string> = {
  AKEMI: "bg-blue-100 text-blue-700",
  ZANOTTI: "bg-purple-100 text-purple-700",
  ERGOTEX: "bg-cyan-100 text-cyan-700",
  DUNLOPILLO: "bg-emerald-100 text-emerald-700",
  HOUZS: "bg-indigo-100 text-indigo-700",
  MYLATEX: "bg-teal-100 text-teal-700",
  GETHA: "bg-pink-100 text-pink-700",
  AERO: "bg-sky-100 text-sky-700",
  OTHER: "bg-gray-100 text-gray-600",
};

const GROUP_COLOR: Record<SKUItemGroup, string> = {
  MATTRESS: "bg-amber-100 text-amber-700",
  BEDFRAME: "bg-amber-100 text-amber-700",
  SOFA: "bg-violet-100 text-violet-700",
  ACC: "bg-gray-100 text-gray-600",
  BEDLINES: "bg-sky-100 text-sky-700",
  DINING: "bg-orange-100 text-orange-700",
  CARPET: "bg-lime-100 text-lime-700",
  DIFFUSER: "bg-fuchsia-100 text-fuchsia-700",
  TRANS: "bg-slate-100 text-slate-600",
  OTHER: "bg-gray-100 text-gray-500",
};

// ─── SKU form (compact) ──────────────────────────────────────────────────────

interface SKUFormProps {
  initial?: SKUCosting;
  defaultGroup?: SKUItemGroup;
  onClose: () => void;
}

function SKUForm({ initial, defaultGroup, onClose }: SKUFormProps) {
  const [itemCode, setItemCode] = useState(initial?.itemCode ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [brand, setBrand] = useState<SKUBrand>(initial?.brand ?? "OTHER");
  const [itemGroup, setItemGroup] = useState<SKUItemGroup>(initial?.itemGroup ?? defaultGroup ?? "MATTRESS");
  const [uom, setUom] = useState(initial?.uom ?? "UNIT");
  const [supplier, setSupplier] = useState(initial?.supplier ?? "");
  const [costPrice, setCostPrice] = useState(String(initial?.costPrice ?? ""));
  const [notes, setNotes] = useState(initial?.notes ?? "");

  function submit() {
    if (!itemCode.trim() || !description.trim()) return;
    const payload: Omit<SKUCosting, "id"> = {
      itemCode: itemCode.trim().toUpperCase(),
      description: description.trim(),
      brand, itemGroup,
      uom: uom.trim() || "UNIT",
      supplier: supplier.trim(),
      barCode: initial?.barCode ?? "",
      costPrice: parseFloat(costPrice) || 0,
      sellingPrice: 0,
      lastUpdated: new Date().toISOString(),
      notes: notes.trim() || undefined,
    };
    if (initial) updateSKU(initial.id, payload);
    else addSKU(payload);
    onClose();
  }

  return (
    <div className={DIALOG_OVERLAY}>
      <div className="bg-white rounded-lg shadow-xl w-full max-w-xl max-h-[90vh] flex flex-col">
        <div className={DIALOG_HEADER}>
          <span className="text-[13px] font-semibold text-[#0A1F2E]">{initial ? "Edit SKU" : "New SKU"}</span>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="h-4 w-4" /></button>
        </div>
        <div className="px-5 py-4 overflow-y-auto space-y-3 flex-1">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className={FIELD_LABEL}>Item Code *</p>
              <input className={FIELD_INPUT} value={itemCode} onChange={(e) => setItemCode(e.target.value)} placeholder="e.g. 1003-(K)" />
            </div>
            <div>
              <p className={FIELD_LABEL}>Description *</p>
              <input className={FIELD_INPUT} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Product description" />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <p className={FIELD_LABEL}>Brand</p>
              <select className={FIELD_SELECT} value={brand} onChange={(e) => setBrand(e.target.value as SKUBrand)}>
                {ALL_BRANDS.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </div>
            <div>
              <p className={FIELD_LABEL}>Item Group</p>
              <select className={FIELD_SELECT} value={itemGroup} onChange={(e) => setItemGroup(e.target.value as SKUItemGroup)}>
                {SKU_ITEM_GROUPS.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
            </div>
            <div>
              <p className={FIELD_LABEL}>UOM</p>
              <input className={FIELD_INPUT} value={uom} onChange={(e) => setUom(e.target.value)} placeholder="UNIT" />
            </div>
          </div>
          <div>
            <p className={FIELD_LABEL}>Supplier (Creditor Code)</p>
            <input className={FIELD_INPUT} value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="e.g. 400-Z001" />
          </div>
          <div>
            <p className={FIELD_LABEL}>Cost Price (RM)</p>
            <input type="number" min={0} step="0.01" className={FIELD_INPUT} value={costPrice}
                   onChange={(e) => setCostPrice(e.target.value)} placeholder="0.00" />
          </div>
          <div>
            <p className={FIELD_LABEL}>Notes</p>
            <input className={FIELD_INPUT} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional notes" />
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

// ─── Inline cell editor ──────────────────────────────────────────────────────

function CellEditor({ value, onSave }: { value: number; onSave: (v: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(String(value || ""));
  function commit() {
    const v = parseFloat(val);
    if (!isNaN(v) && v !== value) onSave(v);
    setEditing(false);
  }
  if (editing) {
    return (
      <input autoFocus type="number" step="0.01" value={val}
             onChange={(e) => setVal(e.target.value)} onBlur={commit}
             onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
             className="w-full h-[22px] px-1 text-right tabular-nums text-[11px] border border-[#0F766E] rounded-sm focus:outline-none" />
    );
  }
  return (
    <button onClick={() => { setVal(String(value || "")); setEditing(true); }}
            className="block w-full text-right tabular-nums hover:bg-[#F0F9F7] hover:text-[#0F766E] py-0.5 px-1 rounded-sm cursor-text"
            title="Click to edit">
      {value > 0 ? fmtRM(value) : <span className="text-gray-300">—</span>}
    </button>
  );
}

// ─── Grid row templates (per category) ───────────────────────────────────────

interface RowProps {
  sku: SKUCosting;
  onEdit: () => void;
  onDelete: () => void;
}

// Bedframe: Product Code | Description | Category | Size | Price 2 | Price 1 | Unit M3 | Variants | Actions
function BedframeRow({ sku, onEdit, onDelete }: RowProps) {
  const size = inferSize(sku.itemCode);
  return (
    <div className="grid grid-cols-[150px_1fr_100px_70px_110px_100px_80px_90px_60px] items-center
                    border-b border-gray-100 hover:bg-[#FAF9F7] text-[12px]">
      <div className="px-3 py-2 border-r border-gray-100 flex items-center gap-1">
        <ChevronRight className="h-3.5 w-3.5 text-gray-400 shrink-0" />
        <span className="font-mono text-[11px] text-[#0A1F2E]">{sku.itemCode}</span>
      </div>
      <div className="px-3 py-2 border-r border-gray-100">
        <div className="text-[12px] text-[#0A1F2E] font-semibold truncate" title={sku.description}>{sku.description || "—"}</div>
        <div className="text-[10px] text-gray-400 truncate">{descSubtitle(sku)}</div>
      </div>
      <div className="px-3 py-2 border-r border-gray-100">
        <span className={`inline-block px-1.5 py-0.5 rounded text-[9px] font-semibold ${GROUP_COLOR[sku.itemGroup]}`}>
          {sku.itemGroup}
        </span>
      </div>
      <div className="px-3 py-2 border-r border-gray-100 text-gray-600 text-[11px]">{size}</div>
      <div className="px-3 py-2 border-r border-gray-100 tabular-nums text-[#0A1F2E]">
        <CellEditor value={sku.costPrice} onSave={(v) => updateSKU(sku.id, { costPrice: v, lastUpdated: new Date().toISOString() })} />
      </div>
      <div className="px-3 py-2 border-r border-gray-100 text-gray-300 text-right">—</div>
      <div className="px-3 py-2 border-r border-gray-100 text-gray-600 text-right tabular-nums">—</div>
      <div className="px-3 py-2 border-r border-gray-100 text-center">
        <button className="inline-flex items-center h-6 px-2 rounded-full bg-[#F4F7F7] text-[10px] font-semibold text-gray-500 hover:bg-[#E4E9E9]">
          Configure
        </button>
      </div>
      <div className="px-2 py-2 flex items-center justify-center gap-1">
        <button onClick={onEdit} className="h-5 w-5 rounded flex items-center justify-center text-gray-400 hover:text-[#0F766E] hover:bg-[#F4F7F7]" title="Edit">
          <Pencil className="h-3 w-3" />
        </button>
        <button onClick={onDelete} className="h-5 w-5 rounded flex items-center justify-center text-gray-400 hover:text-red-500 hover:bg-red-50" title="Delete">
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

// Sofa: Product Code | Description | Model | 24 | 28 | 30 | 32 | 35 | Unit M3 | Variants | Actions
function SofaRow({ sku, onEdit, onDelete }: RowProps) {
  const model = inferModel(sku.itemCode);
  // For each seat-height column, if we had tier prices we'd show here. Currently we show cost in the first column + "—" elsewhere.
  return (
    <div className="grid grid-cols-[150px_1fr_80px_90px_90px_90px_90px_90px_80px_90px_60px] items-center
                    border-b border-gray-100 hover:bg-[#FAF9F7] text-[12px]">
      <div className="px-3 py-2 border-r border-gray-100 flex items-center gap-1">
        <ChevronRight className="h-3.5 w-3.5 text-gray-400 shrink-0" />
        <span className="font-mono text-[11px] text-[#0A1F2E]">{sku.itemCode}</span>
      </div>
      <div className="px-3 py-2 border-r border-gray-100">
        <div className="text-[12px] text-[#0A1F2E] font-semibold truncate" title={sku.description}>{sku.description || "—"}</div>
        <div className="text-[10px] text-gray-400 truncate">{descSubtitle(sku)}</div>
      </div>
      <div className="px-3 py-2 border-r border-gray-100 text-gray-600 text-[11px]">{model}</div>
      <div className="px-3 py-2 border-r border-gray-100 tabular-nums">
        <CellEditor value={sku.costPrice} onSave={(v) => updateSKU(sku.id, { costPrice: v, lastUpdated: new Date().toISOString() })} />
      </div>
      <div className="px-3 py-2 border-r border-gray-100 text-gray-300 text-right">—</div>
      <div className="px-3 py-2 border-r border-gray-100 text-gray-300 text-right">—</div>
      <div className="px-3 py-2 border-r border-gray-100 text-gray-300 text-right">—</div>
      <div className="px-3 py-2 border-r border-gray-100 text-gray-300 text-right">—</div>
      <div className="px-3 py-2 border-r border-gray-100 text-gray-600 text-right tabular-nums">—</div>
      <div className="px-3 py-2 border-r border-gray-100 text-center">
        <button className="inline-flex items-center h-6 px-2 rounded-full bg-[#F4F7F7] text-[10px] font-semibold text-gray-500 hover:bg-[#E4E9E9]">
          Configure
        </button>
      </div>
      <div className="px-2 py-2 flex items-center justify-center gap-1">
        <button onClick={onEdit} className="h-5 w-5 rounded flex items-center justify-center text-gray-400 hover:text-[#0F766E] hover:bg-[#F4F7F7]" title="Edit">
          <Pencil className="h-3 w-3" />
        </button>
        <button onClick={onDelete} className="h-5 w-5 rounded flex items-center justify-center text-gray-400 hover:text-red-500 hover:bg-red-50" title="Delete">
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

// Mattress & Accessories / Others: Product Code | Description | Category | UOM | Supplier | Cost RM | Actions
function PlainRow({ sku, onEdit, onDelete }: RowProps) {
  return (
    <div className="grid grid-cols-[170px_1fr_90px_60px_110px_130px_60px] items-center
                    border-b border-gray-100 hover:bg-[#FAF9F7] text-[12px]">
      <div className="px-3 py-2 border-r border-gray-100 font-mono text-[11px] text-[#0A1F2E]">{sku.itemCode}</div>
      <div className="px-3 py-2 border-r border-gray-100">
        <div className="text-[12px] text-[#0A1F2E] font-semibold truncate" title={sku.description}>{sku.description || "—"}</div>
        <div className="text-[10px] text-gray-400 truncate">{descSubtitle(sku)}</div>
      </div>
      <div className="px-3 py-2 border-r border-gray-100">
        <span className={`inline-block px-1.5 py-0.5 rounded text-[9px] font-semibold ${GROUP_COLOR[sku.itemGroup]}`}>
          {sku.itemGroup}
        </span>
      </div>
      <div className="px-3 py-2 border-r border-gray-100 text-center text-gray-500 text-[11px]">{sku.uom}</div>
      <div className="px-3 py-2 border-r border-gray-100 font-mono text-[10px] text-gray-500 truncate" title={sku.supplier}>
        {sku.supplier || "—"}
      </div>
      <div className="px-3 py-2 border-r border-gray-100 tabular-nums">
        <CellEditor value={sku.costPrice} onSave={(v) => updateSKU(sku.id, { costPrice: v, lastUpdated: new Date().toISOString() })} />
      </div>
      <div className="px-2 py-2 flex items-center justify-center gap-1">
        <button onClick={onEdit} className="h-5 w-5 rounded flex items-center justify-center text-gray-400 hover:text-[#0F766E] hover:bg-[#F4F7F7]" title="Edit">
          <Pencil className="h-3 w-3" />
        </button>
        <button onClick={onDelete} className="h-5 w-5 rounded flex items-center justify-center text-gray-400 hover:text-red-500 hover:bg-red-50" title="Delete">
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

// ─── Export / Import CSV ─────────────────────────────────────────────────────

function exportSKUsCSV(skus: SKUCosting[]) {
  const header = ["Item Code", "Description", "Group", "Brand", "UOM", "Supplier", "Cost Price (RM)"];
  const rows = skus.map((s) => [s.itemCode, s.description, s.itemGroup, s.brand, s.uom, s.supplier, s.costPrice.toFixed(2)]);
  const csv = [header, ...rows].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `sku-costing-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Main page ────────────────────────────────────────────────────────────────

interface SKUCostingPageProps {
  category?: CategoryKey;
}

export default function SKUCostingPage({ category: initialCategory }: SKUCostingPageProps) {
  const skus = useSKUCostings();

  const [view, setView] = useState<"MASTER" | "MAINT">("MASTER");
  const [category, setCategory] = useState<CategoryKey>(initialCategory ?? "BEDFRAME");
  const isMaintenance = view === "MAINT";
  const activeCat = CATEGORIES.find((c) => c.key === category) ?? CATEGORIES[0];

  const [search, setSearch] = useState("");
  const [filterBrand, setFilterBrand] = useState("");
  const [filterGroup, setFilterGroup] = useState("");
  const [filterSupplier, setFilterSupplier] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editSKU, setEditSKU] = useState<SKUCosting | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [limit, setLimit] = useState(300);

  // SKUs in current category
  const inCat = useMemo(() => skus.filter((s) => activeCat.groups.includes(s.itemGroup)), [skus, activeCat]);

  const suppliers = useMemo(() =>
    [...new Set(inCat.map((s) => s.supplier).filter(Boolean))].sort(), [inCat]);
  const brandsInData = useMemo(() =>
    [...new Set(inCat.map((s) => s.brand))].sort(), [inCat]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return inCat.filter((s) => {
      if (q && !s.itemCode.toLowerCase().includes(q) && !s.description.toLowerCase().includes(q) && !s.supplier.toLowerCase().includes(q)) return false;
      if (filterBrand && s.brand !== filterBrand) return false;
      if (filterGroup && s.itemGroup !== filterGroup) return false;
      if (filterSupplier && s.supplier !== filterSupplier) return false;
      return true;
    });
  }, [inCat, search, filterBrand, filterGroup, filterSupplier]);

  const visible = filtered.slice(0, limit);

  const avgCost = filtered.length ? filtered.reduce((s, x) => s + x.costPrice, 0) / filtered.length : 0;
  const pricedCount = filtered.filter((s) => s.costPrice > 0).length;

  // Tab style (pill with brown accent like hookka — teal here)
  const pillClass = (active: boolean) =>
    `px-3 py-1.5 rounded-md text-[12px] font-semibold transition-colors whitespace-nowrap ${
      active
        ? "bg-[#0A1F2E] text-white shadow-sm"
        : "bg-white text-gray-600 border border-[#E5E7EB] hover:border-[#0F766E] hover:text-[#0F766E]"
    }`;

  // CSV import handler
  function handleImportCsv(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result as string;
      const lines = text.split(/\r?\n/).filter(Boolean);
      lines.slice(1).forEach((line) => {
        const cells = line.split(",").map((c) => c.replace(/^"|"$/g, "").replace(/""/g, '"'));
        if (cells.length < 7) return;
        const [itemCode, description, itemGroup, brand, uom, supplier, costStr] = cells;
        if (!itemCode) return;
        const existing = skus.find((s) => s.itemCode === itemCode);
        const payload: Omit<SKUCosting, "id"> = {
          itemCode, description, itemGroup: itemGroup as SKUItemGroup,
          brand: brand as SKUBrand, uom, supplier, barCode: "",
          costPrice: parseFloat(costStr) || 0,
          sellingPrice: 0,
          lastUpdated: new Date().toISOString(),
        };
        if (existing) updateSKU(existing.id, payload);
        else addSKU(payload);
      });
      alert(`Imported ${lines.length - 1} rows.`);
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  return (
    <div className="min-h-screen bg-[#FAFBFB] p-4 space-y-3">

      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0 flex-wrap">
          <div className="flex items-center gap-2.5">
            <Package className="h-5 w-5 text-[#0F766E] shrink-0" />
            <h1 className={`${PAGE_TITLE} truncate`}>SKU Costing</h1>
          </div>
          {/* Primary: SKU Master | Maintenance */}
          <div className="flex items-center gap-1.5">
            <button onClick={() => setView("MASTER")} className={pillClass(view === "MASTER")}>
              SKU Master
            </button>
            <button onClick={() => setView("MAINT")} className={pillClass(view === "MAINT")}>
              Maintenance
            </button>
          </div>
          {view === "MASTER" && (
            <span className={COUNT_BADGE}>{inCat.length} SKUs</span>
          )}
        </div>

        {/* Right: category tabs + Export/Import (only in SKU Master view) */}
        {view === "MASTER" && (
          <div className="flex items-center gap-2 shrink-0 flex-wrap">
            <div className="flex items-center gap-1.5">
              {CATEGORIES.map((c) => (
                <button key={c.key}
                        onClick={() => { setCategory(c.key); setLimit(300); }}
                        className={pillClass(category === c.key)}>
                  {c.shortLabel}
                </button>
              ))}
            </div>
            <span className="mx-1 h-6 w-px bg-gray-300" />
            <button onClick={() => exportSKUsCSV(inCat)} className={BTN_SECONDARY}>
              <Download className="h-3.5 w-3.5" /> Export SKUs
            </button>
            <label className={`${BTN_SECONDARY} cursor-pointer`}>
              <Upload className="h-3.5 w-3.5" /> Import SKUs
              <input type="file" accept=".csv" onChange={handleImportCsv} className="hidden" />
            </label>
            <button onClick={() => { if (window.confirm("Reset ALL SKU costings to seed data?")) resetSKUCostings(); }}
                    className={BTN_SECONDARY}>
              <RotateCcw className="h-3.5 w-3.5" /> Reset
            </button>
            <button onClick={() => setShowForm(true)} className={BTN_PRIMARY}>
              <Plus className="h-4 w-4" /> New SKU
            </button>
          </div>
        )}
      </div>

      {/* Maintenance view */}
      {isMaintenance && <VariantMaintenance />}

      {/* SKU Master view */}
      {view === "MASTER" && (
      <div className="space-y-3">

        {/* Summary */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { label: `${activeCat.shortLabel} SKUs`, value: filtered.length.toString() },
            { label: "Avg Cost (RM)", value: fmtRMPlain(avgCost) },
            { label: "Priced Items", value: `${pricedCount} of ${filtered.length}` },
            { label: "Suppliers", value: new Set(filtered.map((s) => s.supplier).filter(Boolean)).size.toString() },
          ].map(({ label, value }) => (
            <div key={label} className={`${CARD} px-3 py-2`}>
              <p className={STAT_LABEL}>{label}</p>
              <p className={`${STAT_VALUE} text-[#0A1F2E] text-[13px]`}>{value}</p>
            </div>
          ))}
        </div>

        {/* Filter bar */}
        <div className="rounded-lg border border-[#DDE5E5] bg-white p-2 flex flex-wrap gap-2 items-center">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400 pointer-events-none" />
            <input
              className="w-full h-7 pl-7 pr-7 rounded-md border border-[#DDE5E5] bg-white text-[11px] focus:outline-none focus:border-[#0F766E]"
              placeholder="Search item code, description, supplier…"
              value={search} onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600" onClick={() => setSearch("")}>
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
          <select className={FILTER_SELECT + " !h-7"} value={filterBrand} onChange={(e) => setFilterBrand(e.target.value)}>
            <option value="">All Brands</option>
            {brandsInData.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
          <select className={FILTER_SELECT + " !h-7"} value={filterGroup} onChange={(e) => setFilterGroup(e.target.value)}>
            <option value="">All Groups</option>
            {activeCat.groups.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select className={FILTER_SELECT + " !h-7"} value={filterSupplier} onChange={(e) => setFilterSupplier(e.target.value)}>
            <option value="">All Suppliers</option>
            {suppliers.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          {(filterBrand || filterGroup || filterSupplier) && (
            <button className="h-7 px-2 rounded-md border border-[#DDE5E5] bg-white text-[11px] text-gray-500 hover:text-red-600 hover:border-red-300 inline-flex items-center gap-1"
                    onClick={() => { setFilterBrand(""); setFilterGroup(""); setFilterSupplier(""); }}>
              <X className="h-3 w-3" /> Clear
            </button>
          )}
        </div>

        {/* Grid per category */}
        <div className={`${CARD} overflow-hidden`}>
          {/* Header row */}
          {category === "BEDFRAME" && (
            <div className="grid grid-cols-[150px_1fr_100px_70px_110px_100px_80px_90px_60px]
                            bg-[#F0ECE9] border-b border-[#E2DDD8] text-[10px] font-semibold uppercase tracking-wider text-[#374151]">
              <div className="px-3 py-2 border-r border-[#E2DDD8]">Product Code</div>
              <div className="px-3 py-2 border-r border-[#E2DDD8]">Description</div>
              <div className="px-3 py-2 border-r border-[#E2DDD8]">Category</div>
              <div className="px-3 py-2 border-r border-[#E2DDD8]">Size</div>
              <div className="px-3 py-2 border-r border-[#E2DDD8]">Price 2</div>
              <div className="px-3 py-2 border-r border-[#E2DDD8]">Price 1</div>
              <div className="px-3 py-2 border-r border-[#E2DDD8]">Unit M3</div>
              <div className="px-3 py-2 border-r border-[#E2DDD8] text-center">Variants</div>
              <div className="px-2 py-2 text-center">Actions</div>
            </div>
          )}
          {category === "SOFA" && (
            <div className="grid grid-cols-[150px_1fr_80px_90px_90px_90px_90px_90px_80px_90px_60px]
                            bg-[#F0ECE9] border-b border-[#E2DDD8] text-[10px] font-semibold uppercase tracking-wider text-[#374151]">
              <div className="px-3 py-2 border-r border-[#E2DDD8]">Product Code</div>
              <div className="px-3 py-2 border-r border-[#E2DDD8]">Description</div>
              <div className="px-3 py-2 border-r border-[#E2DDD8]">Model</div>
              <div className="px-3 py-2 border-r border-[#E2DDD8] text-right">24"</div>
              <div className="px-3 py-2 border-r border-[#E2DDD8] text-right">28"</div>
              <div className="px-3 py-2 border-r border-[#E2DDD8] text-right">30"</div>
              <div className="px-3 py-2 border-r border-[#E2DDD8] text-right">32"</div>
              <div className="px-3 py-2 border-r border-[#E2DDD8] text-right">35"</div>
              <div className="px-3 py-2 border-r border-[#E2DDD8]">Unit M3</div>
              <div className="px-3 py-2 border-r border-[#E2DDD8] text-center">Variants</div>
              <div className="px-2 py-2 text-center">Actions</div>
            </div>
          )}
          {(category === "MATT_ACC" || category === "OTHERS") && (
            <div className="grid grid-cols-[170px_1fr_90px_60px_110px_130px_60px]
                            bg-[#F0ECE9] border-b border-[#E2DDD8] text-[10px] font-semibold uppercase tracking-wider text-[#374151]">
              <div className="px-3 py-2 border-r border-[#E2DDD8]">Product Code</div>
              <div className="px-3 py-2 border-r border-[#E2DDD8]">Description</div>
              <div className="px-3 py-2 border-r border-[#E2DDD8]">Category</div>
              <div className="px-3 py-2 border-r border-[#E2DDD8]">UOM</div>
              <div className="px-3 py-2 border-r border-[#E2DDD8]">Supplier</div>
              <div className="px-3 py-2 border-r border-[#E2DDD8]">Cost RM</div>
              <div className="px-2 py-2 text-center">Actions</div>
            </div>
          )}

          {visible.length === 0 && (
            <div className="py-16 text-center text-[11px] text-gray-400">
              No SKUs in {activeCat.shortLabel} match the filters.
            </div>
          )}

          {visible.map((sku) => {
            if (category === "BEDFRAME") return <BedframeRow key={sku.id} sku={sku} onEdit={() => setEditSKU(sku)} onDelete={() => setConfirmDelete(sku.id)} />;
            if (category === "SOFA") return <SofaRow key={sku.id} sku={sku} onEdit={() => setEditSKU(sku)} onDelete={() => setConfirmDelete(sku.id)} />;
            return <PlainRow key={sku.id} sku={sku} onEdit={() => setEditSKU(sku)} onDelete={() => setConfirmDelete(sku.id)} />;
          })}

          {/* Footer */}
          <div className="px-3 py-2 text-[10px] text-gray-500 border-t border-gray-200 bg-[#FAFBFB] flex items-center justify-between">
            <span>
              Record {visible.length > 0 ? 1 : 0} of {filtered.length}
              {filtered.length > limit && (
                <>
                  <button onClick={() => setLimit(limit + 300)} className="ml-3 text-[#0F766E] font-semibold hover:underline">Load 300 more</button>
                  <button onClick={() => setLimit(filtered.length)} className="ml-2 text-[#0F766E] font-semibold hover:underline">Show all</button>
                </>
              )}
            </span>
            <span className="text-gray-400">{filtered.length} total products</span>
          </div>
        </div>
      </div>
      )}

      {showForm && <SKUForm defaultGroup={activeCat.groups[0]} onClose={() => setShowForm(false)} />}
      {editSKU && <SKUForm initial={editSKU} onClose={() => setEditSKU(null)} />}

      {confirmDelete && (
        <div className={DIALOG_OVERLAY}>
          <div className="bg-white rounded-lg shadow-xl w-80 p-5 space-y-4">
            <p className="text-[13px] font-semibold text-[#0A1F2E]">Delete this SKU?</p>
            <p className="text-[11px] text-gray-500">This permanently removes the SKU from the master list.</p>
            <div className="flex gap-2 justify-end">
              <button className={BTN_SECONDARY} onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button className="h-8 px-3 rounded-md bg-red-500 text-white text-[11px] font-semibold hover:bg-red-600"
                      onClick={() => { removeSKU(confirmDelete); setConfirmDelete(null); }}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
