import { useState, useMemo, type ReactNode } from "react";
import {
  ArrowUp, ArrowDown, ArrowUpDown, GripVertical, Columns3, RotateCcw,
  X, Search, Filter, Plus, Edit2, Trash2, Check,
} from "lucide-react";
import { BRANDS } from "@/lib/mock-data";
import {
  useSOLines, addSOLine, updateSOLine, removeSOLine, resetSOLines,
  ITEM_GROUPS, SO_UOMS, PAYMENT_STATUSES,
  type SODetailLine, type ItemGroup, type SOUom, type PaymentStatus,
} from "@/lib/so-store";
import { useSKUCostings, type SKUCosting } from "@/lib/sku-costing-store";
import { useColumnPrefs } from "@/lib/column-prefs";
import {
  FIELD_LABEL, FIELD_INPUT, FIELD_SELECT, FILTER_SELECT,
  BTN_PRIMARY, BTN_SECONDARY, CARD,
  DIALOG_OVERLAY, DIALOG_HEADER, DIALOG_FOOTER,
  STAT_LABEL, STAT_VALUE,
} from "@/lib/ui-tokens";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtRM(n: number) {
  return "RM " + n.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(d: string) {
  if (!d) return "—";
  return new Date(d + "T00:00:00").toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

// Spacious pill badges (original style)
const ITEM_GROUP_COLOR: Record<ItemGroup, string> = {
  MATTRESS: "bg-amber-100 text-amber-700",
  BEDFRAME: "bg-blue-100 text-blue-700",
  SOFA: "bg-violet-100 text-violet-700",
  ACC: "bg-purple-100 text-purple-700",
  BEDLINES: "bg-sky-100 text-sky-700",
  DINING: "bg-orange-100 text-orange-700",
  OTHERS: "bg-gray-100 text-gray-600",
};

const PAYMENT_COLOR: Record<PaymentStatus, string> = {
  Checked: "bg-teal-100 text-teal-700",
  Unchecked: "bg-amber-100 text-amber-700",
  Pending: "bg-gray-100 text-gray-500",
};

const BRAND_CHIP: Record<string, string> = {
  AKEMI: "bg-[#4F6BED] text-white",
  ZANOTTI: "bg-[#7B5BD6] text-white",
  ERGOTEX: "bg-[#1A73E8] text-white",
  DUNLOPILLO: "bg-[#0B8043] text-white",
};

// ─── Column system ────────────────────────────────────────────────────────────

interface Col {
  key: string;
  label: string;
  sortable?: boolean;
  defaultHidden?: boolean;
  align?: "right" | "center";
  sortValue?: (l: SODetailLine, ctx: ColCtx) => string | number;
  render: (l: SODetailLine, ctx: ColCtx) => ReactNode;
}

interface ColCtx {
  onEdit: (l: SODetailLine) => void;
  onDelete: (id: string) => void;
  costByCode: Map<string, number>;  // live SKU cost lookup by item code
}

const ALL_COLUMNS: Col[] = [
  {
    key: "docNo", label: "Doc. No.", sortable: true,
    sortValue: (l) => l.docNo,
    render: (l) => <span className="font-semibold text-[#0F766E] whitespace-nowrap font-mono text-[12px] tracking-tight">{l.docNo}</span>,
  },
  {
    key: "date", label: "Date", sortable: true,
    sortValue: (l) => l.date,
    render: (l) => <span className="whitespace-nowrap text-gray-500">{fmtDate(l.date)}</span>,
  },
  {
    key: "debtorName", label: "Debtor Name", sortable: true,
    sortValue: (l) => l.debtorName,
    render: (l) => <span className="whitespace-nowrap">{l.debtorName}</span>,
  },
  {
    key: "debtorCode", label: "Debtor Code", defaultHidden: true,
    render: (l) => <span className="font-mono text-[10px] text-gray-500">{l.debtorCode}</span>,
  },
  {
    key: "agent", label: "Agent", sortable: true,
    sortValue: (l) => l.agent,
    render: (l) => <span className="whitespace-nowrap">{l.agent}</span>,
  },
  {
    key: "itemGroup", label: "Item Group", sortable: true,
    sortValue: (l) => l.itemGroup,
    render: (l) => (
      <span className={`px-1.5 py-[1px] rounded text-[9px] font-semibold ${ITEM_GROUP_COLOR[l.itemGroup]}`}>
        {l.itemGroup}
      </span>
    ),
  },
  {
    key: "itemCode", label: "Item Code",
    render: (l) => <span className="text-[12px] font-semibold text-[#0A1F2E] whitespace-nowrap">{l.itemCode}</span>,
  },
  {
    key: "description", label: "Description",
    render: (l) => <span className="block max-w-full truncate whitespace-nowrap" title={l.description}>{l.description}</span>,
  },
  {
    key: "description2", label: "Description 2", defaultHidden: true,
    render: (l) => <span className="max-w-[200px] truncate inline-block text-gray-500" title={l.description2}>{l.description2 || "—"}</span>,
  },
  {
    key: "uom", label: "UOM", defaultHidden: true,
    render: (l) => <span className="text-gray-500">{l.uom}</span>,
  },
  {
    key: "location", label: "Location",
    render: (l) => <span className="whitespace-nowrap">{l.location}</span>,
  },
  {
    key: "qty", label: "Qty", align: "right",
    sortValue: (l) => l.qty,
    render: (l) => <span className="tabular-nums">{l.qty}</span>,
  },
  {
    key: "unitPrice", label: "Unit Price", align: "right",
    sortValue: (l) => l.unitPrice,
    render: (l) => <span className="tabular-nums">{fmtRM(l.unitPrice)}</span>,
  },
  {
    key: "discount", label: "Discount", align: "right", defaultHidden: true,
    render: (l) => <span className="tabular-nums text-gray-500">{l.discount > 0 ? `-${fmtRM(l.discount)}` : "—"}</span>,
  },
  {
    key: "total", label: "Total", align: "right",
    sortValue: (l) => l.total,
    render: (l) => <span className="tabular-nums font-semibold">{fmtRM(l.total)}</span>,
  },
  {
    key: "unitCost", label: "Unit Cost", align: "right", defaultHidden: true,
    sortValue: (l, ctx) => ctx?.costByCode.get(l.itemCode) ?? 0,
    render: (l, ctx) => {
      const cost = ctx.costByCode.get(l.itemCode) ?? 0;
      return <span className="tabular-nums text-gray-500">{cost > 0 ? fmtRM(cost) : "—"}</span>;
    },
  },
  {
    key: "lineCost", label: "Line Cost", align: "right",
    sortValue: (l, ctx) => (ctx?.costByCode.get(l.itemCode) ?? 0) * l.qty,
    render: (l, ctx) => {
      const cost = (ctx.costByCode.get(l.itemCode) ?? 0) * l.qty;
      return <span className="tabular-nums text-gray-600">{cost > 0 ? fmtRM(cost) : "—"}</span>;
    },
  },
  {
    key: "lineMargin", label: "Margin RM", align: "right",
    sortValue: (l, ctx) => l.total - (ctx?.costByCode.get(l.itemCode) ?? 0) * l.qty,
    render: (l, ctx) => {
      const cost = (ctx.costByCode.get(l.itemCode) ?? 0) * l.qty;
      const margin = l.total - cost;
      return (
        <span className={`tabular-nums font-semibold ${margin > 0 ? "text-[#0F766E]" : margin < 0 ? "text-red-600" : "text-gray-400"}`}>
          {l.total > 0 ? fmtRM(margin) : "—"}
        </span>
      );
    },
  },
  {
    key: "marginPct", label: "Margin %", align: "right",
    sortValue: (l, ctx) => {
      if (l.total <= 0) return 0;
      const cost = (ctx?.costByCode.get(l.itemCode) ?? 0) * l.qty;
      return ((l.total - cost) / l.total) * 100;
    },
    render: (l, ctx) => {
      if (l.total <= 0) return <span className="text-gray-400">—</span>;
      const cost = (ctx.costByCode.get(l.itemCode) ?? 0) * l.qty;
      const pct = ((l.total - cost) / l.total) * 100;
      return (
        <span className={`tabular-nums font-semibold ${
          pct >= 50 ? "text-[#0F766E]" : pct >= 30 ? "text-amber-700" : "text-red-600"
        }`}>
          {pct.toFixed(1)}%
        </span>
      );
    },
  },
  {
    key: "tax", label: "Tax", align: "right", defaultHidden: true,
    render: (l) => <span className="tabular-nums text-gray-500">{l.tax > 0 ? fmtRM(l.tax) : "—"}</span>,
  },
  {
    key: "totalInc", label: "Total Inc", align: "right", defaultHidden: true,
    render: (l) => <span className="tabular-nums">{fmtRM(l.totalInc)}</span>,
  },
  {
    key: "balance", label: "Balance", align: "right",
    sortValue: (l) => l.balance,
    render: (l) => (
      <span className={`tabular-nums ${l.balance > 0 ? "text-red-600 font-semibold" : "text-gray-400"}`}>
        {l.balance > 0 ? fmtRM(l.balance) : "—"}
      </span>
    ),
  },
  {
    key: "paymentStatus", label: "Payment",
    render: (l) => (
      <span className={`px-1.5 py-[1px] rounded text-[9px] font-semibold ${PAYMENT_COLOR[l.paymentStatus]}`}>
        {l.paymentStatus}
      </span>
    ),
  },
  {
    key: "venue", label: "Venue", sortable: true,
    sortValue: (l) => l.venue,
    render: (l) => <span className="whitespace-nowrap max-w-[140px] truncate inline-block">{l.venue}</span>,
  },
  {
    key: "branding", label: "Branding", sortable: true,
    sortValue: (l) => l.branding,
    render: (l) => (
      <span className={`px-1.5 py-[1px] rounded text-[9px] font-semibold ${BRAND_CHIP[l.branding] ?? "bg-gray-100 text-gray-600"}`}>
        {l.branding}
      </span>
    ),
  },
  {
    key: "remark", label: "Remark", defaultHidden: true,
    render: (l) => <span className="text-gray-500 max-w-[160px] truncate inline-block">{l.remark || "—"}</span>,
  },
  {
    key: "actions", label: "Actions",
    render: (l, ctx) => (
      <div className="flex items-center gap-1">
        <button
          onClick={(e) => { e.stopPropagation(); ctx.onEdit(l); }}
          className="h-5 w-5 rounded flex items-center justify-center text-gray-400 hover:text-[#0F766E] hover:bg-[#F4F7F7] transition-colors"
          title="Edit"
        >
          <Edit2 className="h-3 w-3" />
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); ctx.onDelete(l.id); }}
          className="h-5 w-5 rounded flex items-center justify-center text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
          title="Delete"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
    ),
  },
];

const DEFAULT_ORDER = ALL_COLUMNS.map((c) => c.key);
const DEFAULT_HIDDEN = ALL_COLUMNS.filter((c) => c.defaultHidden).map((c) => c.key);
const STORAGE_KEY = "houzs-so-details-columns-v2";

// ─── Line Form (Add / Edit) ────────────────────────────────────────────────────

interface LineFormProps {
  initial?: SODetailLine;
  onClose: () => void;
}

function LineForm({ initial, onClose }: LineFormProps) {
  const skus = useSKUCostings();

  const [docNo, setDocNo] = useState(initial?.docNo ?? "");
  const [date, setDate] = useState(initial?.date ?? new Date().toISOString().slice(0, 10));
  const [debtorCode, setDebtorCode] = useState(initial?.debtorCode ?? "");
  const [debtorName, setDebtorName] = useState(initial?.debtorName ?? "");
  const [agent, setAgent] = useState(initial?.agent ?? "");
  const [itemGroup, setItemGroup] = useState<ItemGroup>(initial?.itemGroup ?? "MATTRESS");
  const [itemCode, setItemCode] = useState(initial?.itemCode ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [description2, setDescription2] = useState(initial?.description2 ?? "");
  const [uom, setUom] = useState<SOUom>(initial?.uom ?? "UNIT");
  const [location, setLocation] = useState(initial?.location ?? "");
  const [qty, setQty] = useState(String(initial?.qty ?? 1));
  const [unitPrice, setUnitPrice] = useState(String(initial?.unitPrice ?? ""));
  const [discount, setDiscount] = useState(String(initial?.discount ?? 0));
  const [balance, setBalance] = useState(String(initial?.balance ?? 0));
  const [paymentStatus, setPaymentStatus] = useState<PaymentStatus>(initial?.paymentStatus ?? "Unchecked");
  const [venue, setVenue] = useState(initial?.venue ?? "");
  const [branding, setBranding] = useState(initial?.branding ?? "AKEMI");
  const [remark, setRemark] = useState(initial?.remark ?? "");
  const [cancelled, setCancelled] = useState(initial?.cancelled ?? false);

  function handleSkuChange(selectedCode: string) {
    setItemCode(selectedCode);
    const found = skus.find((s: SKUCosting) => s.itemCode === selectedCode);
    if (found) {
      setDescription(found.description);
      // Only override brand if it looks like a valid SO branding
      if (["AKEMI", "ZANOTTI", "ERGOTEX", "DUNLOPILLO"].includes(found.brand)) {
        setBranding(found.brand);
      }
      if (found.sellingPrice > 0) setUnitPrice(String(found.sellingPrice));
    }
  }

  function computedTotal() {
    const q = Math.max(1, parseInt(qty) || 1);
    const p = parseFloat(unitPrice) || 0;
    const d = parseFloat(discount) || 0;
    return q * p - d;
  }

  function submit() {
    const trimmedDoc = docNo.trim().toUpperCase();
    if (!trimmedDoc || !debtorName.trim() || !itemCode.trim()) return;
    const tot = computedTotal();
    const payload = {
      docNo: trimmedDoc,
      date,
      debtorCode: debtorCode.trim(),
      debtorName: debtorName.trim(),
      agent: agent.trim(),
      itemGroup,
      itemCode: itemCode.trim().toUpperCase(),
      description: description.trim(),
      description2: description2.trim(),
      uom,
      location: location.trim().toUpperCase(),
      qty: Math.max(1, parseInt(qty) || 1),
      unitPrice: parseFloat(unitPrice) || 0,
      discount: parseFloat(discount) || 0,
      total: tot,
      tax: 0,
      totalInc: tot,
      balance: parseFloat(balance) || 0,
      paymentStatus,
      venue: venue.trim(),
      branding: branding.trim(),
      remark: remark.trim(),
      cancelled,
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
          <span className="text-[13px] font-semibold text-[#0A1F2E]">
            {initial ? "Edit Line Item" : "New Line Item"}
          </span>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-4 overflow-y-auto space-y-3 flex-1">
          {/* Doc No + Date */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className={FIELD_LABEL}>Doc. No. *</p>
              <input className={FIELD_INPUT} value={docNo} onChange={(e) => setDocNo(e.target.value)} placeholder="e.g. SO-011135" />
            </div>
            <div>
              <p className={FIELD_LABEL}>Date *</p>
              <input type="date" className={FIELD_INPUT} value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
          </div>

          {/* Debtor Code + Debtor Name */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className={FIELD_LABEL}>Debtor Code</p>
              <input className={FIELD_INPUT} value={debtorCode} onChange={(e) => setDebtorCode(e.target.value)} placeholder="e.g. 300-C001" />
            </div>
            <div>
              <p className={FIELD_LABEL}>Debtor Name *</p>
              <input className={FIELD_INPUT} value={debtorName} onChange={(e) => setDebtorName(e.target.value)} placeholder="Customer name" />
            </div>
          </div>

          {/* Agent + Location */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className={FIELD_LABEL}>Agent</p>
              <input className={FIELD_INPUT} value={agent} onChange={(e) => setAgent(e.target.value)} placeholder="Sales agent name" />
            </div>
            <div>
              <p className={FIELD_LABEL}>Location</p>
              <input className={FIELD_INPUT} value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. KL, JHR, PEN" />
            </div>
          </div>

          {/* Item Group + UOM */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className={FIELD_LABEL}>Item Group</p>
              <select className={FIELD_SELECT} value={itemGroup} onChange={(e) => setItemGroup(e.target.value as ItemGroup)}>
                {ITEM_GROUPS.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
            </div>
            <div>
              <p className={FIELD_LABEL}>UOM</p>
              <select className={FIELD_SELECT} value={uom} onChange={(e) => setUom(e.target.value as SOUom)}>
                {SO_UOMS.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
            </div>
          </div>

          {/* SKU + Description */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className={FIELD_LABEL}>Item Code / SKU *</p>
              <input
                className={FIELD_INPUT}
                list="sku-options"
                value={itemCode}
                onChange={(e) => handleSkuChange(e.target.value)}
                placeholder="Type to search SKU…"
              />
              <datalist id="sku-options">
                {skus.slice(0, 500).map((s: SKUCosting) => (
                  <option key={s.id} value={s.itemCode}>{s.description}</option>
                ))}
              </datalist>
            </div>
            <div>
              <p className={FIELD_LABEL}>Description</p>
              <input className={FIELD_INPUT} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Auto-filled from SKU" />
            </div>
          </div>

          {/* Description 2 */}
          <div>
            <p className={FIELD_LABEL}>Description 2 (Spec)</p>
            <input className={FIELD_INPUT} value={description2} onChange={(e) => setDescription2(e.target.value)} placeholder="Detailed specs" />
          </div>

          {/* Qty + Unit Price + Discount */}
          <div className="grid grid-cols-3 gap-3">
            <div>
              <p className={FIELD_LABEL}>Qty *</p>
              <input type="number" min={1} className={FIELD_INPUT} value={qty} onChange={(e) => setQty(e.target.value)} />
            </div>
            <div>
              <p className={FIELD_LABEL}>Unit Price (RM)</p>
              <input type="number" min={0} step="0.01" className={FIELD_INPUT} value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} placeholder="0.00" />
            </div>
            <div>
              <p className={FIELD_LABEL}>Discount (RM)</p>
              <input type="number" min={0} step="0.01" className={FIELD_INPUT} value={discount} onChange={(e) => setDiscount(e.target.value)} placeholder="0.00" />
            </div>
          </div>

          {/* Line Total preview */}
          {unitPrice && (
            <div className="rounded-md bg-[#F4F7F7] border border-[#DDE5E5] px-4 py-2 flex items-center justify-between">
              <span className="text-[11px] text-gray-500">Line Total Preview</span>
              <span className="text-[14px] font-semibold text-[#0F766E]">{fmtRM(computedTotal())}</span>
            </div>
          )}

          {/* Balance + Payment Status */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className={FIELD_LABEL}>Balance (RM)</p>
              <input type="number" min={0} step="0.01" className={FIELD_INPUT} value={balance} onChange={(e) => setBalance(e.target.value)} placeholder="0.00" />
            </div>
            <div>
              <p className={FIELD_LABEL}>Payment Status</p>
              <select className={FIELD_SELECT} value={paymentStatus} onChange={(e) => setPaymentStatus(e.target.value as PaymentStatus)}>
                {PAYMENT_STATUSES.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
          </div>

          {/* Branding + Venue */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className={FIELD_LABEL}>Branding</p>
              <select className={FIELD_SELECT} value={branding} onChange={(e) => setBranding(e.target.value)}>
                {BRANDS.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </div>
            <div>
              <p className={FIELD_LABEL}>Venue</p>
              <input className={FIELD_INPUT} value={venue} onChange={(e) => setVenue(e.target.value)} placeholder="Fair / Mall name" />
            </div>
          </div>

          {/* Remark + Cancelled */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className={FIELD_LABEL}>Remark</p>
              <input className={FIELD_INPUT} value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="Optional remark" />
            </div>
            <div className="flex items-end pb-1">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={cancelled} onChange={(e) => setCancelled(e.target.checked)} className="h-3.5 w-3.5 accent-red-500" />
                <span className="text-[11px] text-gray-600 font-semibold">Cancelled</span>
              </label>
            </div>
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
  const skusMaster = useSKUCostings();

  // column prefs — migrate forward from older versions if present
  const { order, hidden, setOrder, setHidden, resetColumns } = useColumnPrefs(
    STORAGE_KEY, DEFAULT_ORDER, DEFAULT_HIDDEN,
    ["houzs-so-details-columns-v1", "houzs-so-details-columns"],
  );
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);

  // per-column widths (px) — persisted
  const COL_WIDTH_KEY = "houzs-so-details-widths-v1";
  const [colWidths, setColWidths] = useState<Record<string, number>>(() => {
    if (typeof window === "undefined") return {};
    try { return JSON.parse(localStorage.getItem(COL_WIDTH_KEY) || "{}"); } catch { return {}; }
  });
  function setColWidth(key: string, w: number) {
    setColWidths((prev) => {
      const next = { ...prev, [key]: Math.max(32, Math.min(600, w)) };
      try { localStorage.setItem(COL_WIDTH_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  }

  // sort
  const [sortKey, setSortKey] = useState<string>("date");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  // filters
  const [search, setSearch] = useState("");
  const [filterBranding, setFilterBranding] = useState("");
  const [filterGroup, setFilterGroup] = useState("");
  const [filterAgent, setFilterAgent] = useState("");
  const [filterVenue, setFilterVenue] = useState("");
  const [filterPayment, setFilterPayment] = useState("");
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");

  // modal state
  const [showForm, setShowForm] = useState(false);
  const [editLine, setEditLine] = useState<SODetailLine | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const PAGE_SIZE = 150;

  // unique option lists
  const uniqueAgents = useMemo(() => [...new Set(lines.map((l) => l.agent))].sort(), [lines]);
  const uniqueVenues = useMemo(() => [...new Set(lines.map((l) => l.venue))].sort(), [lines]);

  // filter + sort
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return lines.filter((l) => {
      if (q && ![l.docNo, l.debtorName, l.itemCode, l.agent, l.venue].some((v) => v.toLowerCase().includes(q))) return false;
      if (filterBranding && l.branding !== filterBranding) return false;
      if (filterGroup && l.itemGroup !== filterGroup) return false;
      if (filterAgent && l.agent !== filterAgent) return false;
      if (filterVenue && l.venue !== filterVenue) return false;
      if (filterPayment && l.paymentStatus !== filterPayment) return false;
      if (filterFrom && l.date < filterFrom) return false;
      if (filterTo && l.date > filterTo) return false;
      return true;
    });
  }, [lines, search, filterBranding, filterGroup, filterAgent, filterVenue, filterPayment, filterFrom, filterTo]);

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

  // visible columns in display order
  const visibleColumns: Col[] = useMemo(() => {
    return order
      .map((k) => ALL_COLUMNS.find((c) => c.key === k))
      .filter((c): c is Col => !!c && !hidden.has(c.key));
  }, [order, hidden]);

  // drag handlers
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

  // summary
  const totalRevenue = useMemo(() => sorted.reduce((s, l) => s + l.total, 0), [sorted]);
  const totalCost = useMemo(() => sorted.reduce((s, l) => s + l.lineCost, 0), [sorted]);
  const totalMargin = totalRevenue - totalCost;
  // Balance is duplicated per line in Excel — dedupe by docNo
  const totalBalance = useMemo(() => {
    const seen = new Map<string, number>();
    for (const l of sorted) if (!seen.has(l.docNo)) seen.set(l.docNo, l.balance);
    return [...seen.values()].reduce((s, b) => s + b, 0);
  }, [sorted]);
  const uniqueOrders = useMemo(() => new Set(sorted.map((l) => l.docNo)).size, [sorted]);

  const hasFilters = !!(search || filterBranding || filterGroup || filterAgent || filterVenue || filterPayment || filterFrom || filterTo);

  function clearFilters() {
    setSearch(""); setFilterBranding(""); setFilterGroup(""); setFilterAgent("");
    setFilterVenue(""); setFilterPayment(""); setFilterFrom(""); setFilterTo("");
  }

  const pillBase = "h-8 px-2.5 rounded-md text-[11px] font-semibold border transition whitespace-nowrap";
  const pillOff = "bg-white text-gray-600 border-[#DDE5E5] hover:border-[#0F766E]";
  const pillOn = "bg-[#0F766E] text-white border-[#0F766E]";

  // Live cost lookup by item code — reflects SKU Costing master in real time
  const costByCode = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of skusMaster) m.set(s.itemCode, s.costPrice);
    return m;
  }, [skusMaster]);

  const ctx: ColCtx = {
    onEdit: (l) => setEditLine(l),
    onDelete: (id) => setConfirmDelete(id),
    costByCode,
  };

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-[#0A1F2E]">Sales Order Details</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Line-item view · {lines.length} items · drag <GripVertical className="inline h-3 w-3" /> to reorder columns
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { if (window.confirm("Reset all SO lines to seed data?")) resetSOLines(); }}
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
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        {[
          { label: "Total Lines", value: sorted.length.toString() },
          { label: "Unique Orders", value: uniqueOrders.toString() },
          { label: "Revenue", value: fmtRM(totalRevenue) },
          { label: "Cost", value: fmtRM(totalCost) },
          { label: "Margin", value: fmtRM(totalMargin) + (totalRevenue > 0 ? ` (${(totalMargin / totalRevenue * 100).toFixed(1)}%)` : "") },
          { label: "Outstanding", value: fmtRM(totalBalance) },
        ].map(({ label, value }) => (
          <div key={label} className={`${CARD} px-3 py-2`}>
            <p className={STAT_LABEL}>{label}</p>
            <p className={`${STAT_VALUE} text-[#0A1F2E] text-[12px]`}>{value}</p>
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
            placeholder="Doc No, debtor, SKU, agent, venue…"
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
        <select className={FILTER_SELECT} value={filterGroup} onChange={(e) => setFilterGroup(e.target.value)}>
          <option value="">All Groups</option>
          {ITEM_GROUPS.map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
        <select className={FILTER_SELECT} value={filterAgent} onChange={(e) => setFilterAgent(e.target.value)}>
          <option value="">All Agents</option>
          {uniqueAgents.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <select className={FILTER_SELECT} value={filterVenue} onChange={(e) => setFilterVenue(e.target.value)}>
          <option value="">All Venues</option>
          {uniqueVenues.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
        <select className={FILTER_SELECT} value={filterPayment} onChange={(e) => setFilterPayment(e.target.value)}>
          <option value="">All Payment</option>
          {PAYMENT_STATUSES.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <input type="date" className={FILTER_SELECT} value={filterFrom} onChange={(e) => setFilterFrom(e.target.value)} title="From date" />
        <input type="date" className={FILTER_SELECT} value={filterTo} onChange={(e) => setFilterTo(e.target.value)} title="To date" />
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
                  {ALL_COLUMNS.map((c) => (
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
                      style={colWidths[c.key] ? { width: colWidths[c.key], minWidth: colWidths[c.key], maxWidth: colWidths[c.key] } : undefined}
                      className={`group relative px-1.5 py-1.5 font-semibold whitespace-nowrap select-none text-[10px] transition
                        ${c.align === "right" ? "text-right" : c.align === "center" ? "text-center" : ""}
                        ${isSorted ? "text-[#0F766E]" : ""}
                        ${isDragging ? "opacity-30" : ""}
                        ${isDragOver ? "bg-[#0F766E]/20 border-l-2 border-[#0F766E]" : ""}
                        ${c.sortable ? "cursor-pointer hover:bg-[#ECF1F1]" : "cursor-grab"}
                      `}
                    >
                      <span className="inline-flex items-center gap-1">
                        <GripVertical className="h-3 w-3 text-gray-300 opacity-0 group-hover:opacity-100 transition cursor-grab" />
                        {c.label}
                        {c.sortable && (
                          isSorted
                            ? (sortDir === "asc" ? <ArrowUp className="h-3 w-3 text-[#0F766E]" /> : <ArrowDown className="h-3 w-3 text-[#0F766E]" />)
                            : <ArrowUpDown className="h-3 w-3 text-gray-300" />
                        )}
                      </span>
                      {/* Resize handle (drag right edge) */}
                      <span
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          e.preventDefault();
                          const th = (e.currentTarget.parentElement as HTMLElement);
                          const startX = e.clientX;
                          const startW = th.getBoundingClientRect().width;
                          function onMove(ev: MouseEvent) {
                            setColWidth(c.key, startW + (ev.clientX - startX));
                          }
                          function onUp() {
                            document.removeEventListener("mousemove", onMove);
                            document.removeEventListener("mouseup", onUp);
                          }
                          document.addEventListener("mousemove", onMove);
                          document.addEventListener("mouseup", onUp);
                        }}
                        onDragStart={(e) => e.preventDefault()}
                        onClick={(e) => e.stopPropagation()}
                        className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-[#0F766E]/60"
                        title="Drag to resize column"
                      />
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={visibleColumns.length} className="px-3 py-8 text-center text-gray-400 text-[11px]">
                    No line items match the current filters
                  </td>
                </tr>
              )}
              {(showAll ? sorted : sorted.slice(0, PAGE_SIZE)).map((l) => (
                <tr
                  key={l.id}
                  className={`border-b border-[#F0F3F3] hover:bg-[#F4F7F7] transition-colors ${l.cancelled ? "opacity-40" : ""}`}
                >
                  {visibleColumns.map((c) => (
                    <td
                      key={c.key}
                      className={`px-1.5 py-1.5 whitespace-nowrap
                        ${c.align === "right" ? "text-right" : c.align === "center" ? "text-center" : ""}
                      `}
                    >
                      {c.render(l, ctx)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="px-3 py-2 text-[11px] text-gray-500 border-t border-[#DDE5E5] bg-[#FAFBFB] flex items-center justify-between">
          <span>
            Showing {Math.min(showAll ? sorted.length : PAGE_SIZE, sorted.length)} of {sorted.length} · {visibleColumns.length} col(s)
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
          <span className="font-semibold text-[#0A1F2E]">Total: {fmtRM(totalRevenue)}</span>
        </div>
      </div>

      {/* Modals */}
      {showForm && <LineForm onClose={() => setShowForm(false)} />}
      {editLine && <LineForm initial={editLine} onClose={() => setEditLine(null)} />}

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
