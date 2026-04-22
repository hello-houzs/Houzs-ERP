// New Sales Order modal — EXACT layout clone of Inistate /sales/order form.
// Labels right-aligned with icon suffix; values on the right.
// Two-column grid: left column = most fields, right column = Salesperson + Debtor Code.

import { useState, useMemo, type ReactNode } from "react";
import {
  X, Plus, Trash2, Check, ShoppingCart, Package, ChevronRight,
  Calendar as CalIcon, User as UserIcon, Phone, Mail, MapPin,
  Tag, Hash, Home, Briefcase, FileText, DollarSign,
} from "lucide-react";
import { BRANDS } from "@/lib/mock-data";
import {
  addSOHeader, addSOLine, nextSODocNo,
  ITEM_GROUPS, PAYMENT_STATUSES,
  type ItemGroup, type PaymentStatus, type SOHeader,
} from "@/lib/so-store";
import { useSKUCostings } from "@/lib/sku-costing-store";

type LineCategory = "BEDFRAME" | "SOFA" | "MATT_ACC" | "OTHERS";

interface LineRow {
  uid: string;
  category: LineCategory;   // drives which variant fields show
  itemCode: string;
  description: string;
  itemGroup: ItemGroup;
  uom: string;
  qty: number;
  unitPrice: number;        // base price (user fills)
  remarks: string;
  // Bedframe variant fields
  fabric: string;
  fabricTier: "PRICE_1" | "PRICE_2" | "";
  gap: string;
  divanHeight: string;
  divanSurcharge: number;
  legHeight: string;
  legSurcharge: number;
  // Sofa variant fields
  model: string;
  moduleStr: string;
  seatSize: string;
  sofaLeg: string;
  sofaLegSurcharge: number;
  // Both: special orders
  specialOrders: { value: string; priceSen: number }[];
}

// Read Variant Maintenance config from localStorage
interface PricedOption { value: string; priceSen: number }
interface FabricItem { id: string; fabricCode: string; priceTier: "PRICE_1" | "PRICE_2"; price: number }
interface MaintCfg {
  divanHeights: PricedOption[]; legHeights: PricedOption[]; totalHeights: PricedOption[];
  gaps: string[]; specials: PricedOption[];
  sofaLegHeights: PricedOption[]; sofaSpecials: PricedOption[]; sofaSizes: string[];
}
function loadMaintCfg(): MaintCfg | null {
  try {
    const raw = localStorage.getItem("houzs-variants-config");
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function loadFabrics(): FabricItem[] {
  try {
    const raw = localStorage.getItem("houzs-fabric-tracking");
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

interface PaymentRow {
  uid: string;
  date: string;
  method: string;        // MBB, CASH, VISA, EPP, ONLINE, etc.
  amount: number;
  accountSheet: string;  // e.g. AKHC 3809
  approvalCode: string;
  collectedBy: string;
}

const PAYMENT_METHODS = ["CASH", "MBB", "VISA", "MASTER", "CREDIT CARD", "EPP", "ONLINE", "TNG", "DUITNOW", "OTHER"] as const;

interface Props {
  onClose: () => void;
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

function blankLine(category: LineCategory = "MATT_ACC"): LineRow {
  const defaultGroup: ItemGroup =
    category === "BEDFRAME" ? "BEDFRAME" :
    category === "SOFA" ? "SOFA" :
    category === "OTHERS" ? "OTHERS" : "MATTRESS";
  return {
    uid: uid(), category, itemCode: "", description: "",
    itemGroup: defaultGroup, uom: "UNIT",
    qty: 1, unitPrice: 0, remarks: "",
    fabric: "", fabricTier: "", gap: "", divanHeight: "", divanSurcharge: 0, legHeight: "", legSurcharge: 0,
    model: "", moduleStr: "", seatSize: "", sofaLeg: "", sofaLegSurcharge: 0,
    specialOrders: [],
  };
}

// Map LineCategory → filterable ItemGroup list for SKU dropdown filter
const CATEGORY_GROUPS: Record<LineCategory, ItemGroup[]> = {
  BEDFRAME: ["BEDFRAME"],
  SOFA: ["SOFA"],
  MATT_ACC: ["MATTRESS", "ACC", "BEDLINES"],
  OTHERS: ["DINING", "OTHERS"],
};

// Compute total unit price = base (user input) + all surcharges
function computeUnitPrice(l: LineRow): number {
  let p = l.unitPrice || 0;
  if (l.category === "BEDFRAME") {
    p += l.divanSurcharge || 0;
    p += l.legSurcharge || 0;
  } else if (l.category === "SOFA") {
    p += l.sofaLegSurcharge || 0;
  }
  p += l.specialOrders.reduce((s, o) => s + (o.priceSen || 0) / 100, 0);
  return p;
}

function blankPayment(): PaymentRow {
  return { uid: uid(), date: new Date().toISOString().slice(0, 10), method: "CASH", amount: 0, accountSheet: "", approvalCode: "", collectedBy: "" };
}

// ─── Inistate-style row: label (right-aligned) + icon + value ────────────────
function Row({ label, icon, children }: { label: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[150px_1fr] items-center gap-x-3 py-1.5">
      <div className="text-[12px] text-[#9CA3AF] text-right inline-flex items-center justify-end gap-1 whitespace-nowrap">
        <span>{label}</span>
        {icon}
      </div>
      <div className="text-[13px] text-[#0A1F2E]">{children}</div>
    </div>
  );
}

// Inline text input — borderless like Inistate, only underline on focus
function Inp(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full h-7 px-0 bg-transparent text-[13px] text-[#0A1F2E] border-0 border-b border-transparent
                  focus:outline-none focus:border-[#0F766E] placeholder:text-[#D1D5DB] ${props.className ?? ""}`}
    />
  );
}

function Sel(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={`w-full h-7 px-0 bg-transparent text-[13px] text-[#0A1F2E] border-0 border-b border-transparent
                  focus:outline-none focus:border-[#0F766E] cursor-pointer ${props.className ?? ""}`}
    />
  );
}

// ─── LineCard — category-aware line item editor ─────────────────────────────

function groupChip(g: ItemGroup): string {
  return g === "MATTRESS" ? "bg-amber-100 text-amber-700"
       : g === "BEDFRAME" ? "bg-blue-100 text-blue-700"
       : g === "SOFA"     ? "bg-violet-100 text-violet-700"
       : g === "ACC"      ? "bg-purple-100 text-purple-700"
       : g === "BEDLINES" ? "bg-sky-100 text-sky-700"
       : g === "DINING"   ? "bg-orange-100 text-orange-700"
       : "bg-gray-100 text-gray-600";
}

interface LineCardProps {
  l: LineRow;
  idx: number;
  skus: ReturnType<typeof useSKUCostings>;
  maintCfg: MaintCfg | null;
  fabrics: FabricItem[];
  update: (patch: Partial<LineRow>) => void;
  onRemove: () => void;
  canRemove: boolean;
}

function LineCard({ l, idx, skus, maintCfg, fabrics, update, onRemove, canRemove }: LineCardProps) {
  // Only SKUs belonging to this line's category
  const filteredSkus = useMemo(() => {
    const groups = CATEGORY_GROUPS[l.category];
    return skus.filter((s) => (groups as readonly string[]).includes(s.itemGroup));
  }, [skus, l.category]);

  function pickProduct(code: string) {
    const sku = skus.find((s) => s.itemCode === code);
    if (!sku) { update({ itemCode: code }); return; }
    const ig = sku.itemGroup as ItemGroup;
    update({ itemCode: sku.itemCode, description: sku.description, itemGroup: ig, uom: sku.uom || "UNIT" });
  }

  function toggleSpecial(opt: PricedOption) {
    const exists = l.specialOrders.find((o) => o.value === opt.value);
    const next = exists
      ? l.specialOrders.filter((o) => o.value !== opt.value)
      : [...l.specialOrders, { value: opt.value, priceSen: opt.priceSen }];
    update({ specialOrders: next });
  }
  const isSpecialSelected = (v: string) => l.specialOrders.some((o) => o.value === v);

  const unitPriceComputed = computeUnitPrice(l);
  const lineTotal = l.qty * unitPriceComputed;

  return (
    <div className="border border-[#E5E7EB] rounded-lg bg-white p-3">
      {/* Card header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-semibold text-[#0A1F2E]">Line {idx + 1}</span>
          <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${groupChip(l.itemGroup)}`}>
            {l.itemGroup}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[13px] font-semibold tabular-nums text-[#0A1F2E]">
            RM {lineTotal.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
          <button onClick={onRemove} disabled={!canRemove}
                  className="h-5 w-5 rounded flex items-center justify-center text-gray-300 hover:text-red-500 hover:bg-red-50 disabled:opacity-30"
                  title="Remove">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Row 1 — Category | Product | Size/Model | Fabric */}
      <div className="grid grid-cols-[120px_1fr_120px_1fr] gap-3 mb-2">
        <div>
          <label className="block text-[10px] text-gray-500 mb-0.5">Category *</label>
          <select value={l.category}
                  onChange={(e) => update({ category: e.target.value as LineCategory, itemCode: "", description: "" })}
                  className="w-full h-8 px-2 text-[12px] bg-white border border-[#E5E7EB] rounded focus:outline-none focus:border-[#0F766E]">
            <option value="BEDFRAME">Bedframe</option>
            <option value="SOFA">Sofa</option>
            <option value="MATT_ACC">Mattress / Accessories</option>
            <option value="OTHERS">Others</option>
          </select>
        </div>
        <div>
          <label className="block text-[10px] text-gray-500 mb-0.5">
            {l.category === "SOFA" ? "Model *" : "Product *"}
          </label>
          <input list={`skus-${l.uid}`} value={l.itemCode}
                 onChange={(e) => pickProduct(e.target.value)}
                 placeholder={`Select ${l.category === "SOFA" ? "model" : "product"}…`}
                 className="w-full h-8 px-2 text-[12px] text-[#0F766E] font-medium bg-white border border-[#E5E7EB] rounded focus:outline-none focus:border-[#0F766E]" />
          <datalist id={`skus-${l.uid}`}>
            {filteredSkus.slice(0, 800).map((s) => (
              <option key={s.id} value={s.itemCode}>{s.description}</option>
            ))}
          </datalist>
          {l.description && <div className="text-[10px] text-gray-400 mt-0.5 truncate" title={l.description}>{l.description}</div>}
        </div>
        {l.category === "BEDFRAME" && (
          <div>
            <label className="block text-[10px] text-gray-500 mb-0.5">Size</label>
            <input value={l.description ? (l.description.match(/\(([^)]+)\)/) || [,""])[1] : "—"} readOnly
                   className="w-full h-8 px-2 text-[12px] bg-[#F9FAFB] border border-[#E5E7EB] rounded text-gray-500 text-center" />
          </div>
        )}
        {l.category !== "BEDFRAME" && <div />}
        {(l.category === "BEDFRAME" || l.category === "SOFA") && (
          <div>
            <label className="block text-[10px] text-gray-500 mb-0.5">Fabrics *</label>
            <select value={l.fabric}
                    onChange={(e) => {
                      const fab = fabrics.find((f) => f.fabricCode === e.target.value);
                      update({ fabric: e.target.value, fabricTier: fab?.priceTier ?? "" });
                    }}
                    className="w-full h-8 px-2 text-[12px] bg-white border border-[#E5E7EB] rounded focus:outline-none focus:border-[#0F766E]">
              <option value="">Select fabric…</option>
              {fabrics.map((f) => (
                <option key={f.id} value={f.fabricCode}>{f.fabricCode} ({f.priceTier})</option>
              ))}
            </select>
          </div>
        )}
        {l.category !== "BEDFRAME" && l.category !== "SOFA" && <div />}
      </div>

      {/* Row 2 — category-specific variant fields */}
      {l.category === "BEDFRAME" && (
        <div className="grid grid-cols-6 gap-3 mb-2">
          <div>
            <label className="block text-[10px] text-gray-500 mb-0.5">Qty</label>
            <input type="number" className="w-full h-8 px-2 text-[12px] text-right tabular-nums bg-white border border-[#E5E7EB] rounded focus:outline-none focus:border-[#0F766E]"
                   value={l.qty === 0 ? "" : l.qty}
                   onChange={(e) => { const v = e.target.value; update({ qty: v === "" ? 0 : (parseInt(v) || 0) }); }}
                   onBlur={(e) => { if (!e.target.value || parseInt(e.target.value) <= 0) update({ qty: 1 }); }} />
          </div>
          <div>
            <label className="block text-[10px] text-gray-500 mb-0.5">Base Price (RM)</label>
            <input type="number" step="0.01"
                   className={`w-full h-8 px-2 text-[12px] text-right tabular-nums border rounded focus:outline-none focus:border-[#0F766E] ${
                     !l.fabric ? "bg-amber-50 border-amber-200 text-amber-700" : "bg-white border-[#E5E7EB]"
                   }`}
                   value={l.unitPrice || ""} onChange={(e) => update({ unitPrice: parseFloat(e.target.value) || 0 })}
                   placeholder={l.fabric ? "0.00" : "Select fabric"}
                   disabled={!l.fabric} />
          </div>
          <div>
            <label className="block text-[10px] text-gray-500 mb-0.5">Gaps</label>
            <select value={l.gap} onChange={(e) => update({ gap: e.target.value })}
                    className="w-full h-8 px-2 text-[12px] bg-white border border-[#E5E7EB] rounded focus:outline-none focus:border-[#0F766E]">
              <option value="">—</option>
              {maintCfg?.gaps.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-[10px] text-gray-500 mb-0.5">Divan Heights</label>
            <select value={l.divanHeight}
                    onChange={(e) => {
                      const opt = maintCfg?.divanHeights.find((o) => o.value === e.target.value);
                      update({ divanHeight: e.target.value, divanSurcharge: (opt?.priceSen ?? 0) / 100 });
                    }}
                    className="w-full h-8 px-2 text-[12px] bg-white border border-[#E5E7EB] rounded focus:outline-none focus:border-[#0F766E]">
              <option value="">—</option>
              {maintCfg?.divanHeights.map((o) => (
                <option key={o.value} value={o.value}>{o.value}{o.priceSen ? ` (+RM ${(o.priceSen/100).toFixed(2)})` : ""}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[10px] text-gray-500 mb-0.5">Leg Heights</label>
            <select value={l.legHeight}
                    onChange={(e) => {
                      const opt = maintCfg?.legHeights.find((o) => o.value === e.target.value);
                      update({ legHeight: e.target.value, legSurcharge: (opt?.priceSen ?? 0) / 100 });
                    }}
                    className="w-full h-8 px-2 text-[12px] bg-white border border-[#E5E7EB] rounded focus:outline-none focus:border-[#0F766E]">
              <option value="">—</option>
              {maintCfg?.legHeights.map((o) => (
                <option key={o.value} value={o.value}>{o.value}{o.priceSen ? ` (+RM ${(o.priceSen/100).toFixed(2)})` : ""}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[10px] text-gray-500 mb-0.5">Total Height</label>
            <input readOnly value="—" className="w-full h-8 px-2 text-[12px] bg-[#F9FAFB] border border-[#E5E7EB] rounded text-gray-500 text-center" />
          </div>
        </div>
      )}

      {l.category === "SOFA" && (
        <div className="grid grid-cols-5 gap-3 mb-2">
          <div>
            <label className="block text-[10px] text-gray-500 mb-0.5">Qty</label>
            <input type="number" className="w-full h-8 px-2 text-[12px] text-right tabular-nums bg-white border border-[#E5E7EB] rounded focus:outline-none focus:border-[#0F766E]"
                   value={l.qty === 0 ? "" : l.qty}
                   onChange={(e) => { const v = e.target.value; update({ qty: v === "" ? 0 : (parseInt(v) || 0) }); }}
                   onBlur={(e) => { if (!e.target.value || parseInt(e.target.value) <= 0) update({ qty: 1 }); }} />
          </div>
          <div>
            <label className="block text-[10px] text-gray-500 mb-0.5">Sizes *</label>
            <select value={l.seatSize} onChange={(e) => update({ seatSize: e.target.value })}
                    className="w-full h-8 px-2 text-[12px] bg-white border border-[#E5E7EB] rounded focus:outline-none focus:border-[#0F766E]">
              <option value="">—</option>
              {maintCfg?.sofaSizes.map((s) => <option key={s} value={s}>{s}"</option>)}
            </select>
          </div>
          <div>
            <label className="block text-[10px] text-gray-500 mb-0.5">Leg Heights</label>
            <select value={l.sofaLeg}
                    onChange={(e) => {
                      const opt = maintCfg?.sofaLegHeights.find((o) => o.value === e.target.value);
                      update({ sofaLeg: e.target.value, sofaLegSurcharge: (opt?.priceSen ?? 0) / 100 });
                    }}
                    className="w-full h-8 px-2 text-[12px] bg-white border border-[#E5E7EB] rounded focus:outline-none focus:border-[#0F766E]">
              <option value="">—</option>
              {maintCfg?.sofaLegHeights.map((o) => (
                <option key={o.value} value={o.value}>{o.value}{o.priceSen ? ` (+RM ${(o.priceSen/100).toFixed(2)})` : ""}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[10px] text-gray-500 mb-0.5">Base Price (RM)</label>
            <input type="number" step="0.01"
                   className="w-full h-8 px-2 text-[12px] text-right tabular-nums bg-white border border-[#E5E7EB] rounded focus:outline-none focus:border-[#0F766E]"
                   value={l.unitPrice || ""} onChange={(e) => update({ unitPrice: parseFloat(e.target.value) || 0 })} placeholder="0.00" />
          </div>
          <div>
            <label className="block text-[10px] text-gray-500 mb-0.5">Module</label>
            <input value={l.moduleStr} onChange={(e) => update({ moduleStr: e.target.value })}
                   className="w-full h-8 px-2 text-[12px] bg-white border border-[#E5E7EB] rounded focus:outline-none focus:border-[#0F766E]" placeholder="—" />
          </div>
        </div>
      )}

      {(l.category === "MATT_ACC" || l.category === "OTHERS") && (
        <div className="grid grid-cols-[80px_140px_1fr] gap-3 mb-2">
          <div>
            <label className="block text-[10px] text-gray-500 mb-0.5">Qty</label>
            <input type="number" className="w-full h-8 px-2 text-[12px] text-right tabular-nums bg-white border border-[#E5E7EB] rounded focus:outline-none focus:border-[#0F766E]"
                   value={l.qty === 0 ? "" : l.qty}
                   onChange={(e) => { const v = e.target.value; update({ qty: v === "" ? 0 : (parseInt(v) || 0) }); }}
                   onBlur={(e) => { if (!e.target.value || parseInt(e.target.value) <= 0) update({ qty: 1 }); }} />
          </div>
          <div>
            <label className="block text-[10px] text-gray-500 mb-0.5">Unit Price (RM)</label>
            <input type="number" step="0.01"
                   className="w-full h-8 px-2 text-[12px] text-right tabular-nums bg-white border border-[#E5E7EB] rounded focus:outline-none focus:border-[#0F766E]"
                   value={l.unitPrice || ""} onChange={(e) => update({ unitPrice: parseFloat(e.target.value) || 0 })} placeholder="0.00" />
          </div>
          <div />
        </div>
      )}

      {/* Special Orders — Bedframe + Sofa only */}
      {(l.category === "BEDFRAME" || l.category === "SOFA") && maintCfg && (
        <details className="mb-2 border border-[#E5E7EB] rounded">
          <summary className="cursor-pointer px-3 py-2 text-[11px] font-semibold text-gray-600 hover:bg-[#F9FAFB]">
            Special Orders ({l.specialOrders.length} selected)
          </summary>
          <div className="p-3 grid grid-cols-3 gap-2 border-t border-[#E5E7EB] bg-[#FAFBFB]">
            {(l.category === "BEDFRAME" ? maintCfg.specials : maintCfg.sofaSpecials).map((opt) => (
              <label key={opt.value} className="flex items-start gap-2 cursor-pointer hover:bg-white p-1 rounded">
                <input type="checkbox" checked={isSpecialSelected(opt.value)}
                       onChange={() => toggleSpecial(opt)}
                       className="h-3.5 w-3.5 mt-0.5 accent-[#0F766E]" />
                <div>
                  <div className="text-[11px] text-[#0A1F2E]">{opt.value}</div>
                  <div className="text-[10px] text-amber-600">
                    {opt.priceSen > 0 ? `+RM ${(opt.priceSen / 100).toFixed(2)}` : "RM 0"}
                  </div>
                </div>
              </label>
            ))}
          </div>
        </details>
      )}

      {/* Line Notes */}
      <div>
        <label className="block text-[10px] text-gray-500 mb-0.5">Line Notes</label>
        <input value={l.remarks} onChange={(e) => update({ remarks: e.target.value })}
               placeholder="Optional notes for this line…"
               className="w-full h-8 px-2 text-[12px] bg-white border border-[#E5E7EB] rounded focus:outline-none focus:border-[#0F766E]" />
      </div>

      {/* Base + Unit Price summary */}
      <div className="mt-2 pt-2 border-t border-[#F3F4F6] flex items-center justify-between text-[11px]">
        <span className="text-gray-500">
          Base: <span className="tabular-nums font-semibold text-[#0A1F2E]">RM {(l.unitPrice || 0).toFixed(2)}</span>
          {(l.divanSurcharge || l.legSurcharge || l.sofaLegSurcharge || l.specialOrders.length > 0) && (
            <>
              {" "}+ surcharges RM {(unitPriceComputed - (l.unitPrice || 0)).toFixed(2)}
            </>
          )}
        </span>
        <span className="text-gray-500">
          Unit Price: <span className="tabular-nums font-semibold text-[#0F766E]">RM {unitPriceComputed.toFixed(2)}</span>
        </span>
      </div>
    </div>
  );
}

export default function NewSalesOrderForm({ onClose }: Props) {
  const skus = useSKUCostings();

  // Header state
  const [docNo] = useState(() => nextSODocNo());
  const today = new Date().toISOString().slice(0, 10);
  const [orderDate, setOrderDate] = useState(today);
  const [processingDate, setProcessingDate] = useState(today);
  const [deliveryDate, setDeliveryDate] = useState("");
  const [debtorName, setDebtorName] = useState("");
  const [debtorCode, setDebtorCode] = useState("");
  const [agent, setAgent] = useState("");
  const [branding, setBranding] = useState<string>(BRANDS[0]);
  const [status, setStatus] = useState("");
  const [status2, setStatus2] = useState("MATTRESS/ACC");
  const [address1, setAddress1] = useState("");
  const [address2, setAddress2] = useState("");
  const [postcode, setPostcode] = useState("");
  const [stateName, setStateName] = useState("Selangor");
  const [contact1, setContact1] = useState("");
  const [contact2, setContact2] = useState("");
  const [email, setEmail] = useState("");
  const [venue, setVenue] = useState("");
  const [warehouse, setWarehouse] = useState("KL");
  const [reference, setReference] = useState("");
  const [source, setSource] = useState("");
  const [poDocNo, setPoDocNo] = useState("");
  const [paymentStatus, setPaymentStatus] = useState<PaymentStatus>("Unchecked");
  const [orderRemarks, setOrderRemarks] = useState("");
  const [note, setNote] = useState("");

  const [lines, setLines] = useState<LineRow[]>([blankLine()]);
  const [payments, setPayments] = useState<PaymentRow[]>([]);

  // Variant Maintenance config (divan heights, fabrics, etc.)
  const [maintCfg] = useState<MaintCfg | null>(() => loadMaintCfg());
  const [fabrics] = useState<FabricItem[]>(() => loadFabrics());

  const subtotal = useMemo(() =>
    lines.reduce((s, l) => s + l.qty * computeUnitPrice(l), 0), [lines]);

  const depositPaid = useMemo(() =>
    payments.reduce((s, p) => s + (p.amount || 0), 0), [payments]);

  const balanceOutstanding = subtotal - depositPaid;

  function updateLine(uidKey: string, patch: Partial<LineRow>) {
    setLines((prev) => prev.map((l) => l.uid === uidKey ? { ...l, ...patch } : l));
  }
  function pickSKU(uidKey: string, itemCode: string) {
    const sku = skus.find((s) => s.itemCode === itemCode);
    if (!sku) { updateLine(uidKey, { itemCode }); return; }
    const ig: ItemGroup = (ITEM_GROUPS as readonly string[]).includes(sku.itemGroup)
      ? (sku.itemGroup as ItemGroup) : "OTHERS";
    // Switching SKU resets variant fields so old selections don't leak across items
    updateLine(uidKey, {
      itemCode: sku.itemCode, description: sku.description,
      itemGroup: ig, uom: sku.uom || "UNIT",
      fabric: "", fabricTier: "",
      gap: "", divanHeight: "", divanSurcharge: 0, legHeight: "", legSurcharge: 0,
      seatSize: "", sofaLeg: "", sofaLegSurcharge: 0,
      specialOrders: [],
    });
  }
  function addLine() { setLines((prev) => [...prev, blankLine()]); }
  function removeLine(uidKey: string) {
    setLines((prev) => prev.length > 1 ? prev.filter((l) => l.uid !== uidKey) : prev);
  }

  function updatePayment(uidKey: string, patch: Partial<PaymentRow>) {
    setPayments((prev) => prev.map((p) => p.uid === uidKey ? { ...p, ...patch } : p));
  }
  function addPayment() { setPayments((prev) => [...prev, blankPayment()]); }
  function removePayment(uidKey: string) {
    setPayments((prev) => prev.filter((p) => p.uid !== uidKey));
  }

  function submit() {
    const validLines = lines.filter((l) => l.itemCode.trim() && l.qty > 0);
    if (!debtorName.trim() || validLines.length === 0) {
      alert("Please fill in customer name and at least one line item.");
      return;
    }
    // Auto-derive payment status from actual payments
    const derivedStatus: PaymentStatus = balanceOutstanding <= 0 && depositPaid > 0 ? "Checked"
                                         : depositPaid > 0 ? "Pending" : paymentStatus;
    const header: SOHeader = {
      docNo, transferTo: "", date: orderDate, branding,
      debtorName: debtorName.trim(), agent: agent.trim(),
      salesLocation: warehouse, ref: reference,
      localTotal: subtotal,
      mattressSofa: 0, bedframe: 0, accessories: 0, others: 0,
      balance: Math.max(0, balanceOutstanding),
      remark2: status2, remark4: orderRemarks, remark3: status,
      processingDate, salesExemptionExpiry: "", note,
      poDocNo,
      address1, address2, address3: postcode, address4: stateName,
      phone: contact1, venue,
      totalCost: 0, totalRevenue: subtotal, totalMargin: 0, marginPct: 0,
      lineCount: validLines.length,
    };
    addSOHeader(header);
    for (const l of validLines) {
      const linePrice = computeUnitPrice(l);  // base + variant surcharges
      // Variants payload (only for BEDFRAME / SOFA)
      const variants = (l.category === "BEDFRAME" || l.category === "SOFA") ? {
        fabric: l.fabric || undefined,
        fabricTier: l.fabricTier || undefined,
        gap: l.gap || undefined,
        divanHeight: l.divanHeight || undefined,
        divanSurcharge: l.divanSurcharge || undefined,
        legHeight: l.legHeight || undefined,
        legSurcharge: l.legSurcharge || undefined,
        seatSize: l.seatSize || undefined,
        sofaLeg: l.sofaLeg || undefined,
        sofaLegSurcharge: l.sofaLegSurcharge || undefined,
        specialOrders: l.specialOrders.length > 0 ? l.specialOrders : undefined,
      } : undefined;
      addSOLine({
        docNo, date: orderDate, debtorCode: debtorCode.trim(),
        debtorName: debtorName.trim(), agent: agent.trim(),
        itemGroup: l.itemGroup, itemCode: l.itemCode.trim().toUpperCase(),
        description: l.description, description2: "",
        uom: (l.uom === "UNIT" || l.uom === "SET" || l.uom === "PAIR" || l.uom === "PCS") ? l.uom : "UNIT",
        location: warehouse, qty: l.qty, unitPrice: linePrice, discount: 0,
        total: l.qty * linePrice, tax: 0, totalInc: l.qty * linePrice,
        balance: Math.max(0, balanceOutstanding), paymentStatus: derivedStatus, venue, branding,
        remark: l.remarks, cancelled: false, variants,
      });
    }
    // Store payments (future enhancement: persist to a payments store)
    try {
      const key = `houzs-so-payments-${docNo}`;
      localStorage.setItem(key, JSON.stringify(payments.filter((p) => p.amount > 0)));
    } catch { /* ignore */ }
    onClose();
  }

  // Status chip colour
  const statusChip = paymentStatus === "Checked" ? "bg-emerald-100 text-emerald-700"
                   : paymentStatus === "Pending" ? "bg-amber-100 text-amber-700"
                   : "bg-gray-200 text-gray-600";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div className="bg-white rounded-lg shadow-2xl w-full max-w-[960px] max-h-[92vh] flex flex-col">

        {/* Header — customer name + Sales Order label + status chip + close */}
        <div className="flex items-start justify-between px-6 py-4 border-b border-[#E5E7EB]">
          <div>
            <div className="flex items-center gap-2 text-[15px] font-bold text-[#0A1F2E]">
              <span>{debtorName || "New Customer"}</span>
              <span className="inline-flex items-center gap-1 text-[12px] text-gray-500 font-normal">
                <ShoppingCart className="h-3.5 w-3.5" /> Sales Order
              </span>
              <span className={`ml-2 px-2 py-0.5 rounded text-[10px] font-bold uppercase ${statusChip}`}>
                {paymentStatus}
              </span>
            </div>
            <div className="flex items-center gap-3 text-[11px] text-gray-400 mt-1">
              <span className="font-mono">{docNo}</span>
              <span className="inline-flex items-center gap-1"><UserIcon className="h-3 w-3" /> External</span>
              <span>just now</span>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="h-4 w-4" /></button>
        </div>

        {/* Body — 2-column Inistate-style rows */}
        <div className="px-6 py-3 overflow-y-auto flex-1">
          <div className="grid grid-cols-2 gap-x-12">

            {/* Left column */}
            <div>
              <Row label="Order Date" icon={<CalIcon className="h-3 w-3" />}>
                <Inp type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} />
              </Row>
              <Row label="Processing Date" icon={<CalIcon className="h-3 w-3" />}>
                <Inp type="date" value={processingDate} onChange={(e) => setProcessingDate(e.target.value)} />
              </Row>
              <Row label="Delivery Date" icon={<CalIcon className="h-3 w-3" />}>
                <Inp type="date" value={deliveryDate} onChange={(e) => setDeliveryDate(e.target.value)} />
              </Row>
              <Row label="Status" icon={<Tag className="h-3 w-3" />}>
                <Inp value={status} onChange={(e) => setStatus(e.target.value)} placeholder="—" />
              </Row>
              <Row label="Status 2" icon={<Tag className="h-3 w-3" />}>
                <Inp value={status2} onChange={(e) => setStatus2(e.target.value)} placeholder="MATTRESS/ACC" />
              </Row>
              <Row label="Name" icon={<UserIcon className="h-3 w-3" />}>
                <Inp value={debtorName} onChange={(e) => setDebtorName(e.target.value)} placeholder="Customer name" />
              </Row>
              <Row label="Address" icon={<MapPin className="h-3 w-3" />}>
                <Inp value={address1} onChange={(e) => setAddress1(e.target.value)} placeholder="Street address" />
              </Row>
              <Row label="Address 2" icon={<MapPin className="h-3 w-3" />}>
                <Inp value={address2} onChange={(e) => setAddress2(e.target.value)} />
              </Row>
              <Row label="Postcode" icon={<Hash className="h-3 w-3" />}>
                <Inp value={postcode} onChange={(e) => setPostcode(e.target.value)} placeholder="47180" />
              </Row>
              <Row label="State" icon={<MapPin className="h-3 w-3" />}>
                <Inp value={stateName} onChange={(e) => setStateName(e.target.value)} />
              </Row>
              <Row label="Contact No" icon={<Phone className="h-3 w-3" />}>
                <Inp value={contact1} onChange={(e) => setContact1(e.target.value)} placeholder="+60..." />
              </Row>
              <Row label="Contact No 2" icon={<Phone className="h-3 w-3" />}>
                <Inp value={contact2} onChange={(e) => setContact2(e.target.value)} />
              </Row>
              <Row label="Email" icon={<Mail className="h-3 w-3" />}>
                <Inp type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              </Row>
              <Row label="Venue" icon={<Home className="h-3 w-3" />}>
                <Inp value={venue} onChange={(e) => setVenue(e.target.value)} placeholder="Fair / Mall name" />
              </Row>
              <Row label="Warehouse" icon={<Briefcase className="h-3 w-3" />}>
                <Sel value={warehouse} onChange={(e) => setWarehouse(e.target.value)}>
                  <option value="KL">KL</option><option value="PG">PG</option><option value="SRW">SRW</option>
                  <option value="JHR">JHR</option><option value="PEN">PEN</option><option value="PER">PER</option>
                </Sel>
              </Row>
              <Row label="Reference" icon={<FileText className="h-3 w-3" />}>
                <Inp value={reference} onChange={(e) => setReference(e.target.value)} placeholder="e.g. HC14087" />
              </Row>
              <Row label="Source" icon={<Tag className="h-3 w-3" />}>
                <Inp value={source} onChange={(e) => setSource(e.target.value)} />
              </Row>
            </div>

            {/* Right column — only Salesperson, Branding, Debtor Code, PO Doc No, Balance */}
            <div>
              <Row label="Salesperson" icon={<UserIcon className="h-3 w-3" />}>
                <Inp value={agent} onChange={(e) => setAgent(e.target.value)} placeholder="e.g. KINGSLEY" />
              </Row>
              <Row label="Branding" icon={<Tag className="h-3 w-3" />}>
                <Sel value={branding} onChange={(e) => setBranding(e.target.value)}>
                  {BRANDS.map((b) => <option key={b} value={b}>{b}</option>)}
                  <option value="NONE">NONE</option>
                </Sel>
              </Row>
              <Row label="Debtor Code" icon={<Hash className="h-3 w-3" />}>
                <Inp value={debtorCode} onChange={(e) => setDebtorCode(e.target.value)} placeholder="300-C001" />
              </Row>
              <Row label="PO Doc No." icon={<FileText className="h-3 w-3" />}>
                <Inp value={poDocNo} onChange={(e) => setPoDocNo(e.target.value)} />
              </Row>
              <Row label="Payment Status" icon={<DollarSign className="h-3 w-3" />}>
                <Sel value={paymentStatus} onChange={(e) => setPaymentStatus(e.target.value as PaymentStatus)}>
                  {PAYMENT_STATUSES.map((p) => <option key={p} value={p}>{p}</option>)}
                </Sel>
              </Row>
              <Row label="Note" icon={<FileText className="h-3 w-3" />}>
                <Inp value={note} onChange={(e) => setNote(e.target.value)} />
              </Row>
            </div>
          </div>

          {/* Items — flat grid, auto-expand variant fields for Bedframe/Sofa */}
          <div className="mt-4">
            <div className="flex items-center gap-2 mb-1">
              <Package className="h-3.5 w-3.5 text-gray-500" />
              <span className="text-[12px] text-gray-500">Items</span>
              <button onClick={addLine}
                      className="ml-auto h-6 px-2 rounded border border-[#E5E7EB] bg-white text-[11px] text-gray-600 hover:border-[#0F766E] hover:text-[#0F766E] inline-flex items-center gap-1">
                <Plus className="h-3 w-3" /> Add Line
              </button>
            </div>
            <div className="border-t border-[#E5E7EB]">
              <div className="grid grid-cols-[40px_2fr_2fr_70px_90px_100px_90px_30px] text-[11px] text-[#9CA3AF]">
                <div className="py-2 border-b border-[#E5E7EB] inline-flex items-center gap-1">No <Hash className="h-3 w-3" /></div>
                <div className="py-2 border-b border-[#E5E7EB] inline-flex items-center gap-1">Item <Package className="h-3 w-3" /></div>
                <div className="py-2 border-b border-[#E5E7EB] inline-flex items-center gap-1">Remarks <FileText className="h-3 w-3" /></div>
                <div className="py-2 border-b border-[#E5E7EB] text-right inline-flex items-center justify-end gap-1">Quantity <Hash className="h-3 w-3" /></div>
                <div className="py-2 border-b border-[#E5E7EB] text-right inline-flex items-center justify-end gap-1">Unit Price <DollarSign className="h-3 w-3" /></div>
                <div className="py-2 border-b border-[#E5E7EB] text-right inline-flex items-center justify-end gap-1">Amount <DollarSign className="h-3 w-3" /></div>
                <div className="py-2 border-b border-[#E5E7EB]">Group</div>
                <div className="py-2 border-b border-[#E5E7EB]" />
              </div>
              {lines.map((l, idx) => {
                const unit = computeUnitPrice(l);
                const needsBedframe = l.itemGroup === "BEDFRAME";
                const needsSofa = l.itemGroup === "SOFA";
                return (
                  <div key={l.uid}>
                    {/* Main row (always visible) */}
                    <div className="grid grid-cols-[40px_2fr_2fr_70px_90px_100px_90px_30px] text-[12px] border-b border-[#F3F4F6] items-center hover:bg-[#FAFBFB]">
                      <div className="py-2 text-center text-[12px] tabular-nums text-gray-500">{idx + 1}</div>
                      <div className="py-1 pr-2 min-w-0 overflow-hidden">
                        <input className="w-full h-6 px-0 text-[12px] text-[#0F766E] bg-transparent border-0 focus:outline-none focus:border-b focus:border-[#0F766E] cursor-pointer"
                               list="newso-skus" value={l.itemCode}
                               onChange={(e) => pickSKU(l.uid, e.target.value)}
                               onFocus={(e) => e.currentTarget.select()}
                               onClick={(e) => (e.currentTarget as HTMLInputElement).select()}
                               placeholder="Click to select / type to search…"
                               title="Click to replace — typing will overwrite" />
                        {l.description && <div className="text-[10px] text-gray-400 truncate whitespace-nowrap overflow-hidden" title={l.description}>{l.description}</div>}
                      </div>
                      <div className="py-1 pr-2 min-w-0">
                        <input className="w-full h-7 px-1.5 text-[12px] bg-[#F9FAFB] border border-[#E5E7EB] rounded focus:outline-none focus:border-[#0F766E] focus:bg-white"
                               value={l.remarks}
                               onChange={(e) => updateLine(l.uid, { remarks: e.target.value })}
                               placeholder="Type remarks…" />
                      </div>
                      <div className="py-1 pr-2 text-right">
                        <input type="number"
                               className="w-full h-7 px-1.5 text-[12px] text-right tabular-nums bg-[#F9FAFB] border border-[#E5E7EB] rounded focus:outline-none focus:border-[#0F766E] focus:bg-white"
                               value={l.qty === 0 ? "" : l.qty}
                               onChange={(e) => { const v = e.target.value; updateLine(l.uid, { qty: v === "" ? 0 : (parseInt(v) || 0) }); }}
                               onBlur={(e) => { if (!e.target.value || parseInt(e.target.value) <= 0) updateLine(l.uid, { qty: 1 }); }}
                               placeholder="1" />
                      </div>
                      <div className="py-1 pr-2 text-right">
                        <input type="number" min={0} step="0.01"
                               className="w-full h-7 px-1.5 text-[12px] text-right tabular-nums bg-[#F9FAFB] border border-[#E5E7EB] rounded focus:outline-none focus:border-[#0F766E] focus:bg-white"
                               value={l.unitPrice || ""}
                               onChange={(e) => updateLine(l.uid, { unitPrice: parseFloat(e.target.value) || 0 })}
                               placeholder="0.00" />
                      </div>
                      <div className="py-2 pr-2 text-right text-[12px] tabular-nums font-semibold text-[#0A1F2E]">
                        {(l.qty * unit).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </div>
                      <div className="py-1 pr-2 flex items-center" title="Group derived from SKU — locked">
                        <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold ${groupChip(l.itemGroup)}`}>
                          {l.itemGroup}
                        </span>
                      </div>
                      <div className="py-1 flex items-center justify-center">
                        <button onClick={() => removeLine(l.uid)} disabled={lines.length <= 1}
                                className="h-5 w-5 rounded flex items-center justify-center text-gray-300 hover:text-red-500 hover:bg-red-50"
                                title="Remove">
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    </div>

                    {/* Always-visible variant fields — BEDFRAME (Specials is the only collapsible) */}
                    {needsBedframe && (
                      <div className="border-b border-[#F3F4F6] bg-[#FAFBFB]">
                        <div className="px-4 py-2 text-[10px] text-gray-500 uppercase tracking-wider">Bedframe Variants</div>
                        <div className="px-4 pb-2 grid grid-cols-4 gap-3">
                          <div>
                            <label className="block text-[10px] text-gray-500 mb-0.5">Fabrics</label>
                            <select value={l.fabric}
                                    onChange={(e) => {
                                      const fab = fabrics.find((f) => f.fabricCode === e.target.value);
                                      updateLine(l.uid, { fabric: e.target.value, fabricTier: fab?.priceTier ?? "" });
                                    }}
                                    className="w-full h-7 px-1.5 text-[11px] bg-white border border-[#E5E7EB] rounded focus:outline-none focus:border-[#0F766E]">
                              <option value="">Select fabric…</option>
                              {fabrics.map((f) => (
                                <option key={f.id} value={f.fabricCode}>{f.fabricCode} ({f.priceTier})</option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label className="block text-[10px] text-gray-500 mb-0.5">Gaps</label>
                            <select value={l.gap} onChange={(e) => updateLine(l.uid, { gap: e.target.value })}
                                    className="w-full h-7 px-1.5 text-[11px] bg-white border border-[#E5E7EB] rounded focus:outline-none focus:border-[#0F766E]">
                              <option value="">—</option>
                              {maintCfg?.gaps.map((g) => <option key={g} value={g}>{g}</option>)}
                            </select>
                          </div>
                          <div>
                            <label className="block text-[10px] text-gray-500 mb-0.5">Divan Heights</label>
                            <select value={l.divanHeight}
                                    onChange={(e) => {
                                      const opt = maintCfg?.divanHeights.find((o) => o.value === e.target.value);
                                      updateLine(l.uid, { divanHeight: e.target.value, divanSurcharge: (opt?.priceSen ?? 0) / 100 });
                                    }}
                                    className="w-full h-7 px-1.5 text-[11px] bg-white border border-[#E5E7EB] rounded focus:outline-none focus:border-[#0F766E]">
                              <option value="">—</option>
                              {maintCfg?.divanHeights.map((o) => (
                                <option key={o.value} value={o.value}>{o.value}{o.priceSen ? ` (+${(o.priceSen/100).toFixed(0)})` : ""}</option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label className="block text-[10px] text-gray-500 mb-0.5">Leg Heights</label>
                            <select value={l.legHeight}
                                    onChange={(e) => {
                                      const opt = maintCfg?.legHeights.find((o) => o.value === e.target.value);
                                      updateLine(l.uid, { legHeight: e.target.value, legSurcharge: (opt?.priceSen ?? 0) / 100 });
                                    }}
                                    className="w-full h-7 px-1.5 text-[11px] bg-white border border-[#E5E7EB] rounded focus:outline-none focus:border-[#0F766E]">
                              <option value="">—</option>
                              {maintCfg?.legHeights.map((o) => (
                                <option key={o.value} value={o.value}>{o.value}{o.priceSen ? ` (+${(o.priceSen/100).toFixed(0)})` : ""}</option>
                              ))}
                            </select>
                          </div>
                        </div>

                        {/* Special Orders — full width, collapsed by default, expand to reveal 3-col checkbox grid */}
                        <details className="mx-4 mb-3 bg-white border border-[#E5E7EB] rounded">
                          <summary className="cursor-pointer px-3 py-2 text-[12px] font-semibold text-[#0A1F2E] hover:bg-[#FAFBFB] flex items-center gap-1.5">
                            <ChevronRight className="h-3.5 w-3.5 text-gray-400 transition-transform group-open:rotate-90" />
                            Special Orders ({l.specialOrders.length} selected)
                          </summary>
                          <div className="px-4 py-3 border-t border-[#E5E7EB] grid grid-cols-3 gap-x-6 gap-y-2">
                            {maintCfg?.specials.map((opt) => {
                              const selected = l.specialOrders.some((o) => o.value === opt.value);
                              return (
                                <label key={opt.value} className="flex items-start gap-2 cursor-pointer hover:bg-[#FAFBFB] px-1 py-1 rounded">
                                  <input type="checkbox" checked={selected}
                                         onChange={() => {
                                           const next = selected
                                             ? l.specialOrders.filter((o) => o.value !== opt.value)
                                             : [...l.specialOrders, { value: opt.value, priceSen: opt.priceSen }];
                                           updateLine(l.uid, { specialOrders: next });
                                         }}
                                         className="h-3.5 w-3.5 mt-0.5 accent-[#0F766E]" />
                                  <div className="min-w-0">
                                    <div className="text-[12px] text-[#0A1F2E]">{opt.value}</div>
                                    <div className={`text-[11px] ${opt.priceSen > 0 ? "text-amber-600" : "text-gray-400"}`}>
                                      {opt.priceSen > 0 ? `+RM ${(opt.priceSen / 100).toFixed(2)}` : "RM 0"}
                                    </div>
                                  </div>
                                </label>
                              );
                            })}
                          </div>
                        </details>
                      </div>
                    )}

                    {/* Always-visible variant fields — SOFA (Specials is the only collapsible) */}
                    {needsSofa && (
                      <div className="border-b border-[#F3F4F6] bg-[#FAFBFB]">
                        <div className="px-4 py-2 text-[10px] text-gray-500 uppercase tracking-wider">Sofa Variants</div>
                        <div className="px-4 pb-2 grid grid-cols-3 gap-3">
                          <div>
                            <label className="block text-[10px] text-gray-500 mb-0.5">Fabrics</label>
                            <select value={l.fabric}
                                    onChange={(e) => {
                                      const fab = fabrics.find((f) => f.fabricCode === e.target.value);
                                      updateLine(l.uid, { fabric: e.target.value, fabricTier: fab?.priceTier ?? "" });
                                    }}
                                    className="w-full h-7 px-1.5 text-[11px] bg-white border border-[#E5E7EB] rounded focus:outline-none focus:border-[#0F766E]">
                              <option value="">Select fabric…</option>
                              {fabrics.map((f) => (
                                <option key={f.id} value={f.fabricCode}>{f.fabricCode} ({f.priceTier})</option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label className="block text-[10px] text-gray-500 mb-0.5">Sizes</label>
                            <select value={l.seatSize} onChange={(e) => updateLine(l.uid, { seatSize: e.target.value })}
                                    className="w-full h-7 px-1.5 text-[11px] bg-white border border-[#E5E7EB] rounded focus:outline-none focus:border-[#0F766E]">
                              <option value="">—</option>
                              {maintCfg?.sofaSizes.map((s) => <option key={s} value={s}>{s}"</option>)}
                            </select>
                          </div>
                          <div>
                            <label className="block text-[10px] text-gray-500 mb-0.5">Leg Heights</label>
                            <select value={l.sofaLeg}
                                    onChange={(e) => {
                                      const opt = maintCfg?.sofaLegHeights.find((o) => o.value === e.target.value);
                                      updateLine(l.uid, { sofaLeg: e.target.value, sofaLegSurcharge: (opt?.priceSen ?? 0) / 100 });
                                    }}
                                    className="w-full h-7 px-1.5 text-[11px] bg-white border border-[#E5E7EB] rounded focus:outline-none focus:border-[#0F766E]">
                              <option value="">—</option>
                              {maintCfg?.sofaLegHeights.map((o) => (
                                <option key={o.value} value={o.value}>{o.value}{o.priceSen ? ` (+${(o.priceSen/100).toFixed(0)})` : ""}</option>
                              ))}
                            </select>
                          </div>
                        </div>

                        {/* Special Orders — full width, collapsed by default */}
                        <details className="mx-4 mb-3 bg-white border border-[#E5E7EB] rounded">
                          <summary className="cursor-pointer px-3 py-2 text-[12px] font-semibold text-[#0A1F2E] hover:bg-[#FAFBFB] flex items-center gap-1.5">
                            <ChevronRight className="h-3.5 w-3.5 text-gray-400" />
                            Special Orders ({l.specialOrders.length} selected)
                          </summary>
                          <div className="px-4 py-3 border-t border-[#E5E7EB] grid grid-cols-3 gap-x-6 gap-y-2">
                            {maintCfg?.sofaSpecials.map((opt) => {
                              const selected = l.specialOrders.some((o) => o.value === opt.value);
                              return (
                                <label key={opt.value} className="flex items-start gap-2 cursor-pointer hover:bg-[#FAFBFB] px-1 py-1 rounded">
                                  <input type="checkbox" checked={selected}
                                         onChange={() => {
                                           const next = selected
                                             ? l.specialOrders.filter((o) => o.value !== opt.value)
                                             : [...l.specialOrders, { value: opt.value, priceSen: opt.priceSen }];
                                           updateLine(l.uid, { specialOrders: next });
                                         }}
                                         className="h-3.5 w-3.5 mt-0.5 accent-[#0F766E]" />
                                  <div className="min-w-0">
                                    <div className="text-[12px] text-[#0A1F2E]">{opt.value}</div>
                                    <div className={`text-[11px] ${opt.priceSen > 0 ? "text-amber-600" : "text-gray-400"}`}>
                                      {opt.priceSen > 0 ? `+RM ${(opt.priceSen / 100).toFixed(2)}` : "RM 0"}
                                    </div>
                                  </div>
                                </label>
                              );
                            })}
                          </div>
                        </details>
                      </div>
                    )}
                  </div>
                );
              })}
              <div className="grid grid-cols-[40px_2fr_2fr_70px_90px_100px_90px_30px] text-[12px] font-semibold pt-2">
                <div className="col-span-5 text-right text-gray-500">Subtotal</div>
                <div className="text-right tabular-nums text-[#0A1F2E]">
                  {subtotal.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
                <div className="col-span-2" />
              </div>
            </div>
            <datalist id="newso-skus">
              {skus.slice(0, 1500).map((s) => (
                <option key={s.id} value={s.itemCode}>{s.description}</option>
              ))}
            </datalist>
          </div>

          {/* Remarks + Total (order-level) */}
          <div className="mt-4 max-w-[520px] space-y-1">
            <Row label="Remarks" icon={<FileText className="h-3 w-3" />}>
              <Inp value={orderRemarks} onChange={(e) => setOrderRemarks(e.target.value)} placeholder="—" />
            </Row>
            <Row label="Total" icon={<DollarSign className="h-3 w-3" />}>
              <span className="text-[13px] text-[#0A1F2E] tabular-nums font-semibold">
                {subtotal.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </Row>
          </div>

          {/* Payments section — mirrors Inistate */}
          <div className="mt-5">
            <div className="flex items-center gap-2 mb-1">
              <DollarSign className="h-3.5 w-3.5 text-gray-500" />
              <span className="text-[12px] text-gray-500">Payments</span>
              <button onClick={addPayment}
                      className="ml-auto h-6 px-2 rounded border border-[#E5E7EB] bg-white text-[11px] text-gray-600 hover:border-[#0F766E] hover:text-[#0F766E] inline-flex items-center gap-1">
                <Plus className="h-3 w-3" /> Add Payment
              </button>
            </div>
            <div className="border-t border-[#E5E7EB]">
              <div className="grid grid-cols-[140px_130px_110px_1fr_1fr_140px_30px] text-[11px] text-[#9CA3AF]">
                <div className="py-2 border-b border-[#E5E7EB] inline-flex items-center gap-1">Date <CalIcon className="h-3 w-3" /></div>
                <div className="py-2 border-b border-[#E5E7EB] inline-flex items-center gap-1">Payment Method <Tag className="h-3 w-3" /></div>
                <div className="py-2 border-b border-[#E5E7EB] text-right inline-flex items-center justify-end gap-1">Amount <DollarSign className="h-3 w-3" /></div>
                <div className="py-2 border-b border-[#E5E7EB] inline-flex items-center gap-1">Account Sheet <FileText className="h-3 w-3" /></div>
                <div className="py-2 border-b border-[#E5E7EB] inline-flex items-center gap-1">Approval Code <FileText className="h-3 w-3" /></div>
                <div className="py-2 border-b border-[#E5E7EB] inline-flex items-center gap-1">Collected By <UserIcon className="h-3 w-3" /></div>
                <div className="py-2 border-b border-[#E5E7EB]" />
              </div>
              {payments.length === 0 && (
                <div className="py-3 text-center text-[11px] text-gray-400">
                  No payments recorded yet · click "Add Payment" to log a deposit
                </div>
              )}
              {payments.map((p) => (
                <div key={p.uid} className="grid grid-cols-[140px_130px_110px_1fr_1fr_140px_30px] text-[12px] border-b border-[#F3F4F6] items-center hover:bg-[#FAFBFB]">
                  <div className="py-1 pr-2">
                    <input type="date" value={p.date} onChange={(e) => updatePayment(p.uid, { date: e.target.value })}
                           className="w-full h-6 px-0 text-[12px] bg-transparent border-0 focus:outline-none focus:border-b focus:border-[#0F766E]" />
                  </div>
                  <div className="py-1 pr-2">
                    <select value={p.method} onChange={(e) => updatePayment(p.uid, { method: e.target.value })}
                            className="w-full h-6 px-0 text-[12px] bg-transparent border-0 focus:outline-none focus:border-b focus:border-[#0F766E]">
                      {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </div>
                  <div className="py-1 pr-2 text-right">
                    <input type="number" min={0} step="0.01" value={p.amount}
                           onChange={(e) => updatePayment(p.uid, { amount: parseFloat(e.target.value) || 0 })}
                           className="w-full h-6 px-0 text-[12px] text-right tabular-nums bg-transparent border-0 focus:outline-none focus:border-b focus:border-[#0F766E]" />
                  </div>
                  <div className="py-1 pr-2">
                    <input value={p.accountSheet} onChange={(e) => updatePayment(p.uid, { accountSheet: e.target.value })}
                           placeholder="e.g. AKHC 3809"
                           className="w-full h-6 px-0 text-[12px] bg-transparent border-0 focus:outline-none focus:border-b focus:border-[#0F766E]" />
                  </div>
                  <div className="py-1 pr-2">
                    <input value={p.approvalCode} onChange={(e) => updatePayment(p.uid, { approvalCode: e.target.value })}
                           className="w-full h-6 px-0 text-[12px] bg-transparent border-0 focus:outline-none focus:border-b focus:border-[#0F766E]" />
                  </div>
                  <div className="py-1 pr-2">
                    <input value={p.collectedBy} onChange={(e) => updatePayment(p.uid, { collectedBy: e.target.value })}
                           placeholder="User"
                           className="w-full h-6 px-0 text-[12px] text-[#0F766E] bg-transparent border-0 focus:outline-none focus:border-b focus:border-[#0F766E]" />
                  </div>
                  <div className="py-1 flex items-center justify-center">
                    <button onClick={() => removePayment(p.uid)}
                            className="h-5 w-5 rounded flex items-center justify-center text-gray-300 hover:text-red-500 hover:bg-red-50" title="Remove">
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {/* Deposit Paid + Balance totals (mirror Inistate) */}
            <div className="max-w-[380px] mt-3 ml-auto space-y-1">
              <Row label="Deposit Paid" icon={<DollarSign className="h-3 w-3" />}>
                <span className="text-[13px] tabular-nums text-[#0A1F2E]">
                  {depositPaid.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </Row>
              <Row label="Balance" icon={<DollarSign className="h-3 w-3" />}>
                <span className={`text-[13px] tabular-nums font-semibold ${balanceOutstanding > 0 ? "text-red-600" : "text-[#0F766E]"}`}>
                  {balanceOutstanding.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </Row>
            </div>
          </div>
        </div>

        {/* Footer — Update Details | Cancel | Sales Order */}
        <div className="flex items-center gap-2 px-6 py-3 border-t border-[#E5E7EB] bg-white">
          <div className="mr-auto text-[12px] text-gray-500 inline-flex items-center gap-3">
            <span>{lines.filter((l) => l.itemCode).length} line(s)</span>
            <span>Total: <span className="font-semibold text-[#0A1F2E] tabular-nums">RM {subtotal.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></span>
            <span>Paid: <span className="font-semibold text-[#0F766E] tabular-nums">RM {depositPaid.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></span>
            <span>Balance: <span className={`font-semibold tabular-nums ${balanceOutstanding > 0 ? "text-red-600" : "text-[#0F766E]"}`}>RM {balanceOutstanding.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></span>
          </div>
          <button onClick={submit}
                  className="h-8 px-3 rounded bg-[#0F766E] text-white text-[12px] font-semibold hover:bg-[#0D6B63] inline-flex items-center gap-1.5">
            <Check className="h-3.5 w-3.5" /> Update Details
          </button>
          <button onClick={onClose}
                  className="h-8 px-3 rounded border border-[#E5E7EB] bg-white text-[12px] font-semibold text-gray-600 hover:border-gray-400">
            Cancel
          </button>
          <button onClick={submit}
                  className="h-8 px-3 rounded border border-[#0F766E] bg-white text-[12px] font-semibold text-[#0F766E] hover:bg-[#F0F9F7] inline-flex items-center gap-1.5">
            <ShoppingCart className="h-3.5 w-3.5" /> Sales Order
          </button>
        </div>
      </div>
    </div>
  );
}
