import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { Link } from "react-router-dom";
import { useNavigate } from "react-router-dom";
import {
  Plus, Search, AlertTriangle, Clock, CheckCircle2,
  Eye, Package, Phone, X, ArrowUp, ArrowDown, Columns3,
  GripVertical, ChevronDown,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  FIELD_LABEL, FIELD_INPUT, FIELD_SELECT, FILTER_SELECT,
} from "@/lib/ui-tokens";
import {
  useASSRCases, useASSRSuppliers, addCase, generateCaseNo, resetASSRData,
  CASE_STATUS_LABELS, CASE_STATUS_COLORS, PRIORITY_COLORS,
  CASE_WORKFLOW_ORDER, SLA_DAYS,
  SERVICE_CATEGORY_LABELS, STAFF_LIST,
  type ASSRCase, type CaseStatus, type CasePriority, type CaseCategory, type ServiceCategory,
  type LogEntry,
} from "@/lib/assr-store";
import { SearchableSelect } from "@/components/ui/searchable-select";

// ─── Helpers ────────────────────────────────────────────────────────────────

function timeAgo(date: string): string {
  const now = new Date(); const d = new Date(date);
  const diffMs = now.getTime() - d.getTime();
  const days = Math.floor(diffMs / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "1d ago";
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function formatDate(date?: string): string {
  if (!date) return "—";
  return new Date(date).toLocaleDateString("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
  });
}

function slaRemaining(deadline?: string): { text: string; overdue: boolean } {
  if (!deadline) return { text: "—", overdue: false };
  const now = new Date(); const d = new Date(deadline);
  const days = Math.ceil((d.getTime() - now.getTime()) / 86400000);
  if (days < 0) return { text: `${Math.abs(days)}d overdue`, overdue: true };
  if (days === 0) return { text: "Due today", overdue: true };
  return { text: `${days}d left`, overdue: false };
}

const BRANDS = ["AKEMI", "ZANOTTI", "ERGOTEX", "DUNLOPILLO"] as const;

const CATEGORIES: CaseCategory[] = [
  "WARRANTY_SERVICE_REQUEST", "INSTALLATION_ASSEMBLY_ISSUE", "PRODUCT_DEFECT",
  "DELIVERY_DAMAGE", "MISSING_PARTS", "CUSTOMER_COMPLAINT", "RETURN_EXCHANGE",
  "WRONG_ITEM", "COLOUR_MISMATCH", "FABRIC_ISSUE", "STRUCTURE_DAMAGE", "OTHERS",
];
const CATEGORY_LABELS: Record<CaseCategory, string> = {
  WARRANTY_SERVICE_REQUEST: "Warranty Service Request",
  INSTALLATION_ASSEMBLY_ISSUE: "Installation / Assembly Issue",
  PRODUCT_DEFECT: "Product Defect",
  DELIVERY_DAMAGE: "Delivery Damage",
  MISSING_PARTS: "Missing Parts",
  CUSTOMER_COMPLAINT: "Customer Complaint",
  RETURN_EXCHANGE: "Return / Exchange",
  WRONG_ITEM: "Wrong Item Delivered",
  COLOUR_MISMATCH: "Colour Mismatch",
  FABRIC_ISSUE: "Fabric Issue",
  STRUCTURE_DAMAGE: "Structure / Frame Damage",
  OTHERS: "Others",
};

const PRIORITIES: CasePriority[] = ["LOW", "MEDIUM", "HIGH", "URGENT"];
const ALL_STATUSES = Object.keys(CASE_STATUS_LABELS) as CaseStatus[];

// ─── Column definitions ─────────────────────────────────────────────────────

interface ColumnDef {
  key: string;
  label: string;
  defaultVisible: boolean;
  minWidth: number;
  sortable: boolean;
  getValue: (c: ASSRCase) => string | number;
}

const SERVICE_CATEGORIES: ServiceCategory[] = [
  "SERVICE_IN_EXTERNAL_SUPPLIER", "SERVICE_IN_EXTERNAL_INHOUSE", "2ND_TRIP_DELIVERY",
  "ONSITE_SERVICE", "PICKUP_AND_RETURN", "REPLACEMENT", "REFUND", "OTHERS",
];

const ALL_COLUMNS: ColumnDef[] = [
  // ── Core identifiers ──
  { key: "caseNo", label: "ASSR No", defaultVisible: true, minWidth: 130, sortable: true, getValue: (c) => c.caseNo },
  { key: "status", label: "ASSR Status", defaultVisible: true, minWidth: 150, sortable: true, getValue: (c) => CASE_STATUS_LABELS[c.status] },
  { key: "salesOrderNo", label: "S/O", defaultVisible: true, minWidth: 120, sortable: true, getValue: (c) => c.salesOrderNo || "" },
  { key: "refNo", label: "Ref No", defaultVisible: true, minWidth: 100, sortable: true, getValue: (c) => c.refNo || "" },
  { key: "complainedDate", label: "Complained Date", defaultVisible: true, minWidth: 120, sortable: true, getValue: (c) => c.complainedDate || "" },
  // ── Customer ──
  { key: "customerName", label: "Customer Name", defaultVisible: true, minWidth: 150, sortable: true, getValue: (c) => c.customerName },
  { key: "customerPhone", label: "HP", defaultVisible: true, minWidth: 120, sortable: true, getValue: (c) => c.customerPhone },
  { key: "location", label: "Location", defaultVisible: true, minWidth: 80, sortable: true, getValue: (c) => c.location || "" },
  { key: "customerEmail", label: "Email", defaultVisible: false, minWidth: 170, sortable: true, getValue: (c) => c.customerEmail },
  // ── Sales & Delivery ──
  { key: "salesPerson", label: "PIC", defaultVisible: true, minWidth: 110, sortable: true, getValue: (c) => c.salesPerson || "" },
  { key: "deliveryOrderNo", label: "D/O", defaultVisible: true, minWidth: 120, sortable: true, getValue: (c) => c.deliveryOrderNo || "" },
  { key: "doDeliveredDate", label: "DO Delivered Date", defaultVisible: false, minWidth: 130, sortable: true, getValue: (c) => c.doDeliveredDate || "" },
  // ── Service tracking ──
  { key: "actionRemark", label: "Action Remark", defaultVisible: true, minWidth: 180, sortable: false, getValue: (c) => c.actionRemark || "" },
  { key: "serviceCategory", label: "Service Category", defaultVisible: true, minWidth: 170, sortable: true, getValue: (c) => c.serviceCategory ? SERVICE_CATEGORY_LABELS[c.serviceCategory] : "" },
  { key: "category", label: "Category", defaultVisible: true, minWidth: 160, sortable: true, getValue: (c) => CATEGORY_LABELS[c.category] },
  { key: "supplierName", label: "Supplier", defaultVisible: true, minWidth: 160, sortable: true, getValue: (c) => c.supplierName || "" },
  { key: "itemDetails", label: "Item Details", defaultVisible: true, minWidth: 180, sortable: false, getValue: (c) => c.itemDetails || "" },
  { key: "issueDescription", label: "Complaint Issue", defaultVisible: true, minWidth: 220, sortable: false, getValue: (c) => c.issueDescription },
  { key: "actionTaken", label: "Action Taken (Summarize)", defaultVisible: true, minWidth: 220, sortable: false, getValue: (c) => c.actionTakenLogs?.map(l => `${l.date}: ${l.text}`).join("; ") || "" },
  { key: "callLog", label: "Call Log: Purchasing Action", defaultVisible: false, minWidth: 220, sortable: false, getValue: (c) => c.callLogs?.map(l => `${l.date}: ${l.text}`).join("; ") || "" },
  // ── Supplier & PO ──
  { key: "poNo", label: "PO No", defaultVisible: false, minWidth: 100, sortable: true, getValue: (c) => c.poNo || "" },
  { key: "supplierRef", label: "Supplier Ref", defaultVisible: false, minWidth: 110, sortable: true, getValue: (c) => c.supplierRef || "" },
  // ── Address ──
  { key: "address1", label: "Address 1", defaultVisible: false, minWidth: 180, sortable: true, getValue: (c) => c.address1 || "" },
  { key: "address2", label: "Address 2", defaultVisible: false, minWidth: 150, sortable: true, getValue: (c) => c.address2 || "" },
  { key: "address3", label: "Address 3", defaultVisible: false, minWidth: 150, sortable: true, getValue: (c) => c.address3 || "" },
  { key: "address4", label: "Address 4", defaultVisible: false, minWidth: 150, sortable: true, getValue: (c) => c.address4 || "" },
  // ── Logistics ──
  { key: "linkRef", label: "Link Ref.", defaultVisible: false, minWidth: 120, sortable: true, getValue: (c) => c.linkRef || "" },
  { key: "goodsReturnedNote", label: "Goods Returned Note & Date", defaultVisible: false, minWidth: 200, sortable: false, getValue: (c) => c.goodsReturnedNote || "" },
  { key: "supplierServiceNote", label: "Supplier Service Note", defaultVisible: false, minWidth: 220, sortable: false, getValue: (c) => c.supplierServiceNote || "" },
  // ── Product ──
  { key: "brand", label: "Brand", defaultVisible: false, minWidth: 100, sortable: true, getValue: (c) => c.brand },
  { key: "productName", label: "Product", defaultVisible: false, minWidth: 180, sortable: true, getValue: (c) => c.productName },
  { key: "productSku", label: "SKU", defaultVisible: false, minWidth: 120, sortable: true, getValue: (c) => c.productSku || "" },
  { key: "invoiceNo", label: "Invoice No", defaultVisible: false, minWidth: 120, sortable: true, getValue: (c) => c.invoiceNo || "" },
  { key: "purchaseDate", label: "Purchase Date", defaultVisible: false, minWidth: 110, sortable: true, getValue: (c) => c.purchaseDate || "" },
  // ── Internal ──
  { key: "priority", label: "Priority", defaultVisible: false, minWidth: 90, sortable: true, getValue: (c) => c.priority },
  { key: "assignedTo", label: "Assigned To", defaultVisible: false, minWidth: 110, sortable: true, getValue: (c) => c.assignedTo },
  { key: "resolution", label: "Resolution", defaultVisible: false, minWidth: 200, sortable: false, getValue: (c) => c.resolution || "" },
  { key: "internalNotes", label: "Internal Notes", defaultVisible: false, minWidth: 200, sortable: false, getValue: (c) => c.internalNotes || "" },
  { key: "sla", label: "SLA", defaultVisible: false, minWidth: 100, sortable: true, getValue: (c) => c.slaDeadline || "" },
  { key: "source", label: "Source", defaultVisible: false, minWidth: 80, sortable: true, getValue: (c) => c.source },
  { key: "createdAt", label: "Created", defaultVisible: false, minWidth: 100, sortable: true, getValue: (c) => c.createdAt },
  { key: "updatedAt", label: "Updated", defaultVisible: false, minWidth: 100, sortable: true, getValue: (c) => c.updatedAt },
  { key: "completedAt", label: "Completed", defaultVisible: false, minWidth: 100, sortable: true, getValue: (c) => c.completedAt || "" },
  { key: "customerAddress", label: "Customer Address", defaultVisible: false, minWidth: 200, sortable: true, getValue: (c) => c.customerAddress },
];

// ─── Column settings persistence ────────────────────────────────────────────

const K_COLS = "houzs_qms_columns";
const K_COL_ORDER = "houzs_qms_column_order";

function loadVisibleColumns(): Set<string> {
  if (typeof window === "undefined") return new Set(ALL_COLUMNS.filter(c => c.defaultVisible).map(c => c.key));
  const raw = localStorage.getItem(K_COLS);
  if (!raw) return new Set(ALL_COLUMNS.filter(c => c.defaultVisible).map(c => c.key));
  try { return new Set(JSON.parse(raw)); } catch { return new Set(ALL_COLUMNS.filter(c => c.defaultVisible).map(c => c.key)); }
}

function saveVisibleColumns(cols: Set<string>) {
  localStorage.setItem(K_COLS, JSON.stringify([...cols]));
}

function loadColumnOrder(): string[] {
  if (typeof window === "undefined") return ALL_COLUMNS.map(c => c.key);
  const raw = localStorage.getItem(K_COL_ORDER);
  if (!raw) return ALL_COLUMNS.map(c => c.key);
  try {
    const saved: string[] = JSON.parse(raw);
    // add any new columns not in saved
    const allKeys = ALL_COLUMNS.map(c => c.key);
    const missing = allKeys.filter(k => !saved.includes(k));
    return [...saved.filter(k => allKeys.includes(k)), ...missing];
  } catch { return ALL_COLUMNS.map(c => c.key); }
}

function saveColumnOrder(order: string[]) {
  localStorage.setItem(K_COL_ORDER, JSON.stringify(order));
}

// ─── Cell renderer ──────────────────────────────────────────────────────────

function CellContent({ col, c }: { col: ColumnDef; c: ASSRCase }) {
  switch (col.key) {
    case "caseNo":
      return (
        <Link to={`/qms/${c.id}`} className="text-[#0F766E] font-semibold hover:underline" onClick={(e) => e.stopPropagation()}>
          {c.caseNo}
        </Link>
      );
    case "status":
      return (
        <span className={cn("text-[10px] font-medium px-2 py-0.5 rounded-full whitespace-nowrap", CASE_STATUS_COLORS[c.status])}>
          {CASE_STATUS_LABELS[c.status]}
        </span>
      );
    case "priority":
      return (
        <span className={cn("text-[10px] font-medium px-2 py-0.5 rounded-full", PRIORITY_COLORS[c.priority])}>
          {c.priority}
        </span>
      );
    case "category":
      return <span className="text-[11px] text-gray-600">{CATEGORY_LABELS[c.category]}</span>;
    case "serviceCategory":
      return c.serviceCategory ? (
        <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-teal-100 text-teal-700 whitespace-nowrap">
          {SERVICE_CATEGORY_LABELS[c.serviceCategory]}
        </span>
      ) : <span className="text-gray-300">—</span>;
    case "salesOrderNo":
      return <span className="text-[11px] text-[#0F766E] font-mono font-semibold">{c.salesOrderNo || "—"}</span>;
    case "refNo":
      return <span className="text-[11px] text-gray-700 font-mono font-semibold">{c.refNo || "—"}</span>;
    case "complainedDate":
      return <span className="text-[11px] text-gray-600">{c.complainedDate ? formatDate(c.complainedDate) : "—"}</span>;
    case "location":
      return c.location ? <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-gray-100 text-gray-700">{c.location}</span> : <span className="text-gray-300">—</span>;
    case "deliveryOrderNo":
      return <span className="text-[11px] text-gray-600 font-mono">{c.deliveryOrderNo || "—"}</span>;
    case "doDeliveredDate":
      return <span className="text-[11px] text-gray-600">{c.doDeliveredDate ? formatDate(c.doDeliveredDate) : "—"}</span>;
    case "actionRemark":
      return <span className="text-[11px] text-gray-600 truncate block max-w-[200px]" title={c.actionRemark}>{c.actionRemark || "—"}</span>;
    case "itemDetails":
      return <span className="text-[11px] text-gray-600 truncate block max-w-[200px]" title={c.itemDetails}>{c.itemDetails || "—"}</span>;
    case "actionTaken": {
      const atSummary = c.actionTakenLogs?.map(l => `${l.date}: ${l.text}`).join("; ") || "";
      return <span className="text-[11px] text-gray-600 truncate block max-w-[220px]" title={atSummary}>{atSummary || "—"}</span>;
    }
    case "callLog": {
      const clSummary = c.callLogs?.map(l => `${l.date}: ${l.text}`).join("; ") || "";
      return <span className="text-[11px] text-gray-600 truncate block max-w-[220px]" title={clSummary}>{clSummary || "—"}</span>;
    }
    case "poNo":
      return <span className="text-[11px] text-gray-600 font-mono">{c.poNo || "—"}</span>;
    case "address1":
      return <span className="text-[11px] text-gray-600 truncate block max-w-[180px]">{c.address1 || "—"}</span>;
    case "address2":
      return <span className="text-[11px] text-gray-600 truncate block max-w-[150px]">{c.address2 || "—"}</span>;
    case "address3":
      return <span className="text-[11px] text-gray-600 truncate block max-w-[150px]">{c.address3 || "—"}</span>;
    case "address4":
      return <span className="text-[11px] text-gray-600 truncate block max-w-[150px]">{c.address4 || "—"}</span>;
    case "linkRef":
      return <span className="text-[11px] text-gray-600 font-mono">{c.linkRef || "—"}</span>;
    case "goodsReturnedNote":
      return <span className="text-[11px] text-gray-600 truncate block max-w-[200px]" title={c.goodsReturnedNote}>{c.goodsReturnedNote || "—"}</span>;
    case "supplierServiceNote":
      return <span className="text-[11px] text-gray-600 truncate block max-w-[220px]" title={c.supplierServiceNote}>{c.supplierServiceNote || "—"}</span>;
    case "customerName":
      return <div className="text-[12px] font-medium text-[#0A1F2E] truncate max-w-[160px]">{c.customerName}</div>;
    case "customerPhone":
      return c.customerPhone ? (
        <div className="text-[11px] text-gray-600 inline-flex items-center gap-0.5">
          <Phone className="h-2.5 w-2.5 text-gray-400" />{c.customerPhone}
        </div>
      ) : <span className="text-gray-300">—</span>;
    case "customerEmail":
      return <span className="text-[11px] text-gray-600 truncate block max-w-[180px]">{c.customerEmail || "—"}</span>;
    case "customerAddress":
      return <span className="text-[11px] text-gray-600 truncate block max-w-[200px]">{c.customerAddress || "—"}</span>;
    case "brand":
      return <span className="text-[11px] font-semibold text-gray-700">{c.brand}</span>;
    case "productName":
      return <span className="text-[11px] text-gray-600 truncate block max-w-[180px]">{c.productName}</span>;
    case "productSku":
      return <span className="text-[11px] text-gray-600 font-mono">{c.productSku || "—"}</span>;
    case "invoiceNo":
      return <span className="text-[11px] text-gray-600 font-mono">{c.invoiceNo || "—"}</span>;
    case "purchaseDate":
      return <span className="text-[11px] text-gray-600">{c.purchaseDate ? formatDate(c.purchaseDate) : "—"}</span>;
    case "issueDescription":
      return <span className="text-[11px] text-gray-600 truncate block max-w-[200px]" title={c.issueDescription}>{c.issueDescription}</span>;
    case "assignedTo":
      return <span className="text-[11px] text-gray-600">{c.assignedTo || "—"}</span>;
    case "salesPerson":
      return <span className="text-[11px] text-gray-600">{c.salesPerson || "—"}</span>;
    case "supplierName":
      return <span className="text-[11px] text-gray-600">{c.supplierName || "—"}</span>;
    case "supplierRef":
      return <span className="text-[11px] text-gray-600 font-mono">{c.supplierRef || "—"}</span>;
    case "resolution":
      return <span className="text-[11px] text-gray-600 truncate block max-w-[200px]" title={c.resolution}>{c.resolution || "—"}</span>;
    case "internalNotes":
      return <span className="text-[11px] text-gray-600 truncate block max-w-[200px]" title={c.internalNotes}>{c.internalNotes || "—"}</span>;
    case "sla": {
      if (c.status === "COMPLETED" || c.status === "CANCELLED") return <span className="text-[10px] text-gray-400">—</span>;
      const sla = slaRemaining(c.slaDeadline);
      return <span className={cn("text-[10px] font-semibold tabular-nums", sla.overdue ? "text-red-600" : "text-gray-600")}>{sla.text}</span>;
    }
    case "source":
      return (
        <span className={cn(
          "text-[10px] font-medium px-2 py-0.5 rounded-full",
          c.source === "PORTAL" ? "bg-violet-100 text-violet-700" : "bg-gray-100 text-gray-600",
        )}>
          {c.source}
        </span>
      );
    case "createdAt":
      return <span className="text-[10px] text-gray-500 tabular-nums">{timeAgo(c.createdAt)}</span>;
    case "updatedAt":
      return <span className="text-[10px] text-gray-500 tabular-nums">{timeAgo(c.updatedAt)}</span>;
    case "completedAt":
      return <span className="text-[10px] text-gray-500 tabular-nums">{c.completedAt ? formatDate(c.completedAt) : "—"}</span>;
    default:
      return <span className="text-[11px] text-gray-600">{String(col.getValue(c)) || "—"}</span>;
  }
}

// ─── Column Manager dropdown ────────────────────────────────────────────────

function ColumnManager({
  visibleCols,
  columnOrder,
  onToggle,
  onMoveUp,
  onMoveDown,
}: {
  visibleCols: Set<string>;
  columnOrder: string[];
  onToggle: (key: string) => void;
  onMoveUp: (key: string) => void;
  onMoveDown: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handle(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, []);

  const colMap = new Map(ALL_COLUMNS.map(c => [c.key, c]));

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="h-8 px-2.5 rounded-md border border-[#DDE5E5] bg-white text-[11px] font-semibold text-gray-600 hover:border-[#0F766E] hover:text-[#0F766E] inline-flex items-center gap-1.5 transition"
      >
        <Columns3 className="h-3.5 w-3.5" /> Columns
        <span className="text-[9px] bg-[#0F766E]/10 text-[#0F766E] rounded px-1 py-0.5">{visibleCols.size}</span>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-72 bg-white rounded-lg border border-[#DDE5E5] shadow-xl max-h-[420px] overflow-y-auto">
          <div className="px-3 py-2 border-b border-[#DDE5E5] bg-[#F4F7F7]">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">Show / Hide Columns</span>
          </div>
          <div className="py-1">
            {columnOrder.map((key, idx) => {
              const col = colMap.get(key);
              if (!col) return null;
              const checked = visibleCols.has(key);
              return (
                <div
                  key={key}
                  className={cn(
                    "flex items-center gap-2 px-3 py-1.5 hover:bg-[#F4F7F7] transition-colors group",
                    !checked && "opacity-50",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => onToggle(key)}
                    className="h-3.5 w-3.5 rounded border-gray-300 text-[#0F766E] focus:ring-[#0F766E]/30 cursor-pointer"
                  />
                  <span className="text-[11px] text-[#0A1F2E] flex-1">{col.label}</span>
                  <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); onMoveUp(key); }}
                      disabled={idx === 0}
                      className="h-5 w-5 rounded inline-flex items-center justify-center text-gray-400 hover:text-[#0F766E] hover:bg-[#0F766E]/10 disabled:opacity-20"
                    >
                      <ArrowUp className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); onMoveDown(key); }}
                      disabled={idx === columnOrder.length - 1}
                      className="h-5 w-5 rounded inline-flex items-center justify-center text-gray-400 hover:text-[#0F766E] hover:bg-[#0F766E]/10 disabled:opacity-20"
                    >
                      <ArrowDown className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── New Case Dialog ────────────────────────────────────────────────────────

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-2 pt-2 pb-1">
      <div className="h-[1px] flex-1 bg-[#DDE5E5]" />
      <span className="text-[9px] font-bold uppercase tracking-widest text-[#0F766E] shrink-0">{title}</span>
      <div className="h-[1px] flex-1 bg-[#DDE5E5]" />
    </div>
  );
}

function NewCaseDialog({ onClose }: { onClose: () => void }) {
  // Core
  const [brand, setBrand] = useState<string>(BRANDS[0]);
  const [category, setCategory] = useState<CaseCategory>("OTHERS");
  const [priority, setPriority] = useState<CasePriority>("MEDIUM");
  const [serviceCategory, setServiceCategory] = useState<ServiceCategory | "">("");
  // Reference
  const [salesOrderNo, setSalesOrderNo] = useState("");
  const [refNo, setRefNo] = useState("");
  const [complainedDate, setComplainedDate] = useState(() => new Date().toISOString().split("T")[0]);
  // Customer
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [location, setLocation] = useState("");
  // Address
  const [address1, setAddress1] = useState("");
  const [address2, setAddress2] = useState("");
  const [address3, setAddress3] = useState("");
  const [address4, setAddress4] = useState("");
  // Sales & Delivery
  const [salesPerson, setSalesPerson] = useState("");
  const [deliveryOrderNo, setDeliveryOrderNo] = useState("");
  const [doDeliveredDate, setDoDeliveredDate] = useState("");
  // Product / Item
  const [productName, setProductName] = useState("");
  const [productSku, setProductSku] = useState("");
  const [itemDetails, setItemDetails] = useState("");
  const [invoiceNo, setInvoiceNo] = useState("");
  const [purchaseDate, setPurchaseDate] = useState("");
  // Issue
  const [issueDescription, setIssueDescription] = useState("");
  const [actionRemark, setActionRemark] = useState("");
  const [actionTakenLogs, setActionTakenLogs] = useState<LogEntry[]>([]);
  const [callLogs, setCallLogs] = useState<LogEntry[]>([]);
  // Supplier
  const [supplierName, setSupplierName] = useState("");
  const [poNo, setPoNo] = useState("");
  const [linkRef, setLinkRef] = useState("");
  const [goodsReturnedNote, setGoodsReturnedNote] = useState("");
  const [supplierServiceNote, setSupplierServiceNote] = useState("");
  // Assignment
  const [assignedTo, setAssignedTo] = useState("");

  // Suppliers
  const suppliers = useASSRSuppliers();
  const activeSupplierNames = suppliers.filter((s) => s.status === "ACTIVE").map((s) => s.name);

  function submit() {
    if (!customerName.trim() || !issueDescription.trim()) return;

    const now = new Date().toISOString();
    const caseNo = generateCaseNo();
    const deadline = new Date();
    deadline.setDate(deadline.getDate() + SLA_DAYS[priority]);

    addCase({
      caseNo,
      status: "UNDER_VERIFICATION",
      priority,
      category,
      brand,
      customerName: customerName.trim(),
      customerPhone: customerPhone.trim(),
      customerEmail: customerEmail.trim(),
      customerAddress: [address1, address2, address3, address4].filter(Boolean).join(", "),
      productName: productName.trim(),
      productSku: productSku.trim() || undefined,
      invoiceNo: invoiceNo.trim() || undefined,
      purchaseDate: purchaseDate || undefined,
      issueDescription: issueDescription.trim(),
      photoUrls: [],
      assignedTo: salesPerson.trim(),
      salesPerson: salesPerson.trim() || undefined,
      supplierName: supplierName.trim() || undefined,
      slaDeadline: deadline.toISOString(),
      createdAt: now,
      updatedAt: now,
      source: "INTERNAL",
      timeline: [
        {
          id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
          caseId: "",
          timestamp: now,
          action: "Case created",
          user: salesPerson.trim() || "System",
        },
      ],
      // Google Sheet fields
      salesOrderNo: salesOrderNo.trim() || undefined,
      refNo: refNo.trim() || undefined,
      complainedDate: complainedDate || undefined,
      location: location.trim() || undefined,
      deliveryOrderNo: deliveryOrderNo.trim() || undefined,
      doDeliveredDate: doDeliveredDate || undefined,
      serviceCategory: serviceCategory || undefined,
      actionRemark: actionRemark.trim() || undefined,
      itemDetails: itemDetails.trim() || undefined,
      actionTakenLogs: actionTakenLogs.length > 0 ? actionTakenLogs : undefined,
      callLogs: callLogs.length > 0 ? callLogs : undefined,
      poNo: poNo.trim() || undefined,
      address1: address1.trim() || undefined,
      address2: address2.trim() || undefined,
      address3: address3.trim() || undefined,
      address4: address4.trim() || undefined,
      linkRef: linkRef.trim() || undefined,
      goodsReturnedNote: goodsReturnedNote.trim() || undefined,
      supplierServiceNote: supplierServiceNote.trim() || undefined,
    });
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-white rounded-lg border border-[#DDE5E5] shadow-xl w-full max-w-3xl mx-4 overflow-hidden max-h-[92vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-3 border-b border-[#DDE5E5] bg-[#F4F7F7] flex items-center justify-between shrink-0">
          <h3 className="text-[13px] font-semibold text-[#0A1F2E]">
            <Plus className="h-4 w-4 inline mr-1.5 -mt-0.5 text-[#0F766E]" />
            New ASSR Case
          </h3>
          <button
            type="button" onClick={onClose}
            className="h-6 w-6 rounded hover:bg-gray-200 inline-flex items-center justify-center text-gray-400 hover:text-gray-600"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Body — scrollable */}
        <div className="flex-1 overflow-y-auto p-5 space-y-2">

          {/* ── CASE INFO ── */}
          <SectionHeader title="Case Information" />
          <div className="grid grid-cols-4 gap-3">
            <div>
              <div className={FIELD_LABEL}>S/O (Sales Order)</div>
              <input value={salesOrderNo} onChange={(e) => setSalesOrderNo(e.target.value)} placeholder="SO-XXXXXX" className={FIELD_INPUT} />
            </div>
            <div>
              <div className={FIELD_LABEL}>Ref No</div>
              <input value={refNo} onChange={(e) => setRefNo(e.target.value)} placeholder="HCXXXX" className={FIELD_INPUT} />
            </div>
            <div>
              <div className={FIELD_LABEL}>Complained Date</div>
              <input type="date" value={complainedDate} onChange={(e) => setComplainedDate(e.target.value)} className={FIELD_INPUT} />
            </div>
            <div>
              <div className={FIELD_LABEL}>Priority</div>
              <select value={priority} onChange={(e) => setPriority(e.target.value as CasePriority)} className={FIELD_SELECT}>
                {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <div className={FIELD_LABEL}>Category</div>
              <select value={category} onChange={(e) => setCategory(e.target.value as CaseCategory)} className={FIELD_SELECT}>
                {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
              </select>
            </div>
            <div>
              <div className={FIELD_LABEL}>Service Category</div>
              <select value={serviceCategory} onChange={(e) => setServiceCategory(e.target.value as ServiceCategory)} className={FIELD_SELECT}>
                <option value="">— Select —</option>
                {SERVICE_CATEGORIES.map((sc) => <option key={sc} value={sc}>{SERVICE_CATEGORY_LABELS[sc]}</option>)}
              </select>
            </div>
            <div>
              <div className={FIELD_LABEL}>Brand</div>
              <select value={brand} onChange={(e) => setBrand(e.target.value)} className={FIELD_SELECT}>
                {BRANDS.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </div>
          </div>

          {/* ── CUSTOMER ── */}
          <SectionHeader title="Customer Information" />
          <div className="grid grid-cols-3 gap-3">
            <div>
              <div className={FIELD_LABEL}>Customer Name *</div>
              <input value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder="Full name" className={FIELD_INPUT} autoFocus />
            </div>
            <div>
              <div className={FIELD_LABEL}>HP (Phone) *</div>
              <input value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} placeholder="+6012..." className={FIELD_INPUT} />
            </div>
            <div>
              <div className={FIELD_LABEL}>Location</div>
              <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="KL / JB / PG ..." className={FIELD_INPUT} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className={FIELD_LABEL}>Email</div>
              <input value={customerEmail} onChange={(e) => setCustomerEmail(e.target.value)} placeholder="email@..." className={FIELD_INPUT} />
            </div>
            <div>
              <div className={FIELD_LABEL}>PIC (Sales Agent)</div>
              <SearchableSelect value={salesPerson} onChange={setSalesPerson} options={STAFF_LIST} placeholder="Select PIC..." />
            </div>
          </div>

          {/* ── ADDRESS ── */}
          <SectionHeader title="Address" />
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className={FIELD_LABEL}>Address 1</div>
              <input value={address1} onChange={(e) => setAddress1(e.target.value)} placeholder="Street / Unit" className={FIELD_INPUT} />
            </div>
            <div>
              <div className={FIELD_LABEL}>Address 2</div>
              <input value={address2} onChange={(e) => setAddress2(e.target.value)} placeholder="Area / Taman" className={FIELD_INPUT} />
            </div>
            <div>
              <div className={FIELD_LABEL}>Address 3</div>
              <input value={address3} onChange={(e) => setAddress3(e.target.value)} placeholder="City / Postcode" className={FIELD_INPUT} />
            </div>
            <div>
              <div className={FIELD_LABEL}>Address 4</div>
              <input value={address4} onChange={(e) => setAddress4(e.target.value)} placeholder="State" className={FIELD_INPUT} />
            </div>
          </div>

          {/* ── DELIVERY ── */}
          <SectionHeader title="Delivery" />
          <div className="grid grid-cols-3 gap-3">
            <div>
              <div className={FIELD_LABEL}>D/O (Delivery Order)</div>
              <input value={deliveryOrderNo} onChange={(e) => setDeliveryOrderNo(e.target.value)} placeholder="DO-XXXXXX" className={FIELD_INPUT} />
            </div>
            <div>
              <div className={FIELD_LABEL}>DO Delivered Date</div>
              <input type="date" value={doDeliveredDate} onChange={(e) => setDoDeliveredDate(e.target.value)} className={FIELD_INPUT} />
            </div>
            <div>
              <div className={FIELD_LABEL}>Invoice No.</div>
              <input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} placeholder="INV-XXXX-XXX" className={FIELD_INPUT} />
            </div>
          </div>

          {/* ── ITEM / PRODUCT ── */}
          <SectionHeader title="Item / Product Details" />
          <div className="grid grid-cols-3 gap-3">
            <div>
              <div className={FIELD_LABEL}>Product Name</div>
              <input value={productName} onChange={(e) => setProductName(e.target.value)} placeholder="Product name" className={FIELD_INPUT} />
            </div>
            <div>
              <div className={FIELD_LABEL}>Product SKU</div>
              <input value={productSku} onChange={(e) => setProductSku(e.target.value)} placeholder="SKU code" className={FIELD_INPUT} />
            </div>
            <div>
              <div className={FIELD_LABEL}>Purchase Date</div>
              <input type="date" value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} className={FIELD_INPUT} />
            </div>
          </div>
          <div>
            <div className={FIELD_LABEL}>Item Details</div>
            <input value={itemDetails} onChange={(e) => setItemDetails(e.target.value)} placeholder="e.g. Latex bolster x2 + cover x2" className={FIELD_INPUT} />
          </div>

          {/* ── COMPLAINT / ACTION ── */}
          <SectionHeader title="Complaint & Action" />
          <div>
            <div className={FIELD_LABEL}>Complaint Issue *</div>
            <textarea
              value={issueDescription} onChange={(e) => setIssueDescription(e.target.value)}
              placeholder="Describe the complaint issue in detail..."
              rows={3}
              className="w-full rounded-md border border-[#DDE5E5] px-2 py-1.5 text-[11px] bg-white focus:outline-none focus:ring-2 focus:ring-[#0F766E]/30 focus:border-[#0F766E] resize-y"
            />
          </div>
          <div>
            <div className={FIELD_LABEL}>Action Remark</div>
            <input value={actionRemark} onChange={(e) => setActionRemark(e.target.value)} placeholder="Action remark" className={FIELD_INPUT} />
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <div className={FIELD_LABEL + " mb-0"}>Action Taken (Service Agent Log)</div>
              <button type="button" onClick={() => setActionTakenLogs(prev => [...prev, { id: Date.now().toString(36) + Math.random().toString(36).slice(2,6), date: new Date().toISOString().split("T")[0], text: "" }])} className="text-[9px] font-semibold text-[#0F766E] hover:underline inline-flex items-center gap-0.5"><Plus className="h-2.5 w-2.5" />Add Entry</button>
            </div>
            {actionTakenLogs.length === 0 && <div className="text-[10px] text-gray-400 italic py-1">No entries yet — click Add Entry</div>}
            {actionTakenLogs.map((entry, idx) => (
              <div key={entry.id} className="flex gap-2 items-start mb-1.5">
                <input type="date" value={entry.date} onChange={(e) => setActionTakenLogs(prev => prev.map((l, i) => i === idx ? { ...l, date: e.target.value } : l))} className={FIELD_INPUT + " !w-[130px] shrink-0"} />
                <input value={entry.text} onChange={(e) => setActionTakenLogs(prev => prev.map((l, i) => i === idx ? { ...l, text: e.target.value } : l))} placeholder="What was done..." className={FIELD_INPUT + " flex-1"} />
                <button type="button" onClick={() => setActionTakenLogs(prev => prev.filter((_, i) => i !== idx))} className="h-8 w-8 shrink-0 rounded-md border border-[#DDE5E5] bg-white text-gray-400 hover:text-red-500 hover:border-red-300 inline-flex items-center justify-center"><X className="h-3 w-3" /></button>
              </div>
            ))}
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <div className={FIELD_LABEL + " mb-0"}>Call Log: Purchasing Action Taken</div>
              <button type="button" onClick={() => setCallLogs(prev => [...prev, { id: Date.now().toString(36) + Math.random().toString(36).slice(2,6), date: new Date().toISOString().split("T")[0], text: "" }])} className="text-[9px] font-semibold text-[#0F766E] hover:underline inline-flex items-center gap-0.5"><Plus className="h-2.5 w-2.5" />Add Entry</button>
            </div>
            {callLogs.length === 0 && <div className="text-[10px] text-gray-400 italic py-1">No entries yet — click Add Entry</div>}
            {callLogs.map((entry, idx) => (
              <div key={entry.id} className="flex gap-2 items-start mb-1.5">
                <input type="date" value={entry.date} onChange={(e) => setCallLogs(prev => prev.map((l, i) => i === idx ? { ...l, date: e.target.value } : l))} className={FIELD_INPUT + " !w-[130px] shrink-0"} />
                <input value={entry.text} onChange={(e) => setCallLogs(prev => prev.map((l, i) => i === idx ? { ...l, text: e.target.value } : l))} placeholder="Supplier communication..." className={FIELD_INPUT + " flex-1"} />
                <button type="button" onClick={() => setCallLogs(prev => prev.filter((_, i) => i !== idx))} className="h-8 w-8 shrink-0 rounded-md border border-[#DDE5E5] bg-white text-gray-400 hover:text-red-500 hover:border-red-300 inline-flex items-center justify-center"><X className="h-3 w-3" /></button>
              </div>
            ))}
          </div>

          {/* ── SUPPLIER ── */}
          <SectionHeader title="Supplier & Logistics" />
          <div className="grid grid-cols-3 gap-3">
            <div>
              <div className={FIELD_LABEL}>Supplier</div>
              <SearchableSelect value={supplierName} onChange={setSupplierName} options={activeSupplierNames} placeholder="Select supplier..." />
            </div>
            <div>
              <div className={FIELD_LABEL}>PO No</div>
              <input value={poNo} onChange={(e) => setPoNo(e.target.value)} placeholder="PO1234" className={FIELD_INPUT} />
            </div>
            <div>
              <div className={FIELD_LABEL}>Link Ref.</div>
              <input value={linkRef} onChange={(e) => setLinkRef(e.target.value)} placeholder="Reference link" className={FIELD_INPUT} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className={FIELD_LABEL}>Goods Returned Note & Date</div>
              <input value={goodsReturnedNote} onChange={(e) => setGoodsReturnedNote(e.target.value)} placeholder="Return note details" className={FIELD_INPUT} />
            </div>
            <div>
              <div className={FIELD_LABEL}>Supplier Service Note</div>
              <input value={supplierServiceNote} onChange={(e) => setSupplierServiceNote(e.target.value)} placeholder="Service note" className={FIELD_INPUT} />
            </div>
          </div>

          {/* ── SLA ── */}
          <SectionHeader title="SLA" />
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className={FIELD_LABEL}>SLA Deadline</div>
              <div className="h-8 rounded-md border border-[#DDE5E5] px-2 text-[11px] bg-[#FAFBFB] flex items-center text-gray-500">
                Auto: {SLA_DAYS[priority]} days from today
              </div>
            </div>
          </div>

        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-[#DDE5E5] flex justify-end gap-2 shrink-0 bg-white">
          <button
            type="button" onClick={onClose}
            className="h-8 px-3 rounded-md border border-[#DDE5E5] bg-white text-[11px] font-semibold text-gray-600"
          >
            Cancel
          </button>
          <button
            type="button" onClick={submit}
            disabled={!customerName.trim() || !issueDescription.trim()}
            className="h-8 px-4 rounded-md bg-[#0F766E] text-white text-[11px] font-semibold hover:bg-[#0D6B63] disabled:opacity-40 inline-flex items-center gap-1"
          >
            <Plus className="h-3 w-3" /> Create Case
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ──────────────────────────────────────────────────────────────

export default function QmsPage() {
  const navigate = useNavigate();
  const cases = useASSRCases();
  const [showNewCase, setShowNewCase] = useState(false);
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState<CaseStatus | "ALL">("ALL");
  const [filterPriority, setFilterPriority] = useState<CasePriority | "ALL">("ALL");
  const [filterBrand, setFilterBrand] = useState<string>("ALL");

  // Column state
  const [visibleCols, setVisibleCols] = useState<Set<string>>(() => loadVisibleColumns());
  const [columnOrder, setColumnOrder] = useState<string[]>(() => loadColumnOrder());

  // Sort state
  const [sortKey, setSortKey] = useState<string>("createdAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const colMap = useMemo(() => new Map(ALL_COLUMNS.map(c => [c.key, c])), []);

  // Ordered visible columns
  const activeColumns = useMemo(
    () => columnOrder.filter(k => visibleCols.has(k)).map(k => colMap.get(k)!).filter(Boolean),
    [columnOrder, visibleCols, colMap],
  );

  // Column actions
  const toggleColumn = useCallback((key: string) => {
    setVisibleCols(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      saveVisibleColumns(next);
      return next;
    });
  }, []);

  const moveColumnUp = useCallback((key: string) => {
    setColumnOrder(prev => {
      const idx = prev.indexOf(key);
      if (idx <= 0) return prev;
      const next = [...prev];
      [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
      saveColumnOrder(next);
      return next;
    });
  }, []);

  const moveColumnDown = useCallback((key: string) => {
    setColumnOrder(prev => {
      const idx = prev.indexOf(key);
      if (idx < 0 || idx >= prev.length - 1) return prev;
      const next = [...prev];
      [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
      saveColumnOrder(next);
      return next;
    });
  }, []);

  // Sort handler
  const handleSort = useCallback((key: string) => {
    const col = colMap.get(key);
    if (!col?.sortable) return;
    setSortKey(prev => {
      if (prev === key) {
        setSortDir(d => d === "asc" ? "desc" : "asc");
        return key;
      }
      setSortDir("asc");
      return key;
    });
  }, [colMap]);

  // ── Stats ─────────────────────────────────────────────────────────────────

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const stats = useMemo(() => {
    const open = cases.filter((c) => c.status !== "COMPLETED" && c.status !== "CANCELLED");
    const overdue = open.filter((c) => {
      if (!c.slaDeadline) return false;
      return new Date(c.slaDeadline) < now;
    });
    const pendingReview = cases.filter((c) => c.status === "UNDER_VERIFICATION");
    const completedThisMonth = cases.filter(
      (c) => c.status === "COMPLETED" && c.completedAt && new Date(c.completedAt) >= monthStart,
    );
    return {
      totalOpen: open.length,
      overdue: overdue.length,
      pendingReview: pendingReview.length,
      completedThisMonth: completedThisMonth.length,
    };
  }, [cases]);

  // ── Filtering & sorting ───────────────────────────────────────────────────

  const q = search.trim().toUpperCase();

  const filtered = useMemo(() => {
    let result = [...cases];

    if (filterStatus !== "ALL") result = result.filter((c) => c.status === filterStatus);
    if (filterPriority !== "ALL") result = result.filter((c) => c.priority === filterPriority);
    if (filterBrand !== "ALL") result = result.filter((c) => c.brand === filterBrand);
    if (q) {
      result = result.filter((c) => {
        const hay = [
          c.caseNo, c.customerName, c.productName, c.brand,
          c.assignedTo, c.salesPerson, c.invoiceNo, c.customerPhone,
          c.issueDescription, CATEGORY_LABELS[c.category],
        ].join(" ").toUpperCase();
        return hay.includes(q);
      });
    }

    // Sort
    const col = colMap.get(sortKey);
    if (col) {
      result.sort((a, b) => {
        const va = col.getValue(a);
        const vb = col.getValue(b);
        let cmp = 0;
        if (typeof va === "number" && typeof vb === "number") cmp = va - vb;
        else cmp = String(va).localeCompare(String(vb));
        return sortDir === "asc" ? cmp : -cmp;
      });
    }

    return result;
  }, [cases, filterStatus, filterPriority, filterBrand, q, sortKey, sortDir, colMap]);

  const isFiltering = q !== "" || filterStatus !== "ALL" || filterPriority !== "ALL" || filterBrand !== "ALL";

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-[#0A1F2E] inline-flex items-center gap-2">
            QMS — After-Sales Service
            <span className="text-[11px] font-semibold bg-[#0F766E]/10 text-[#0F766E] px-2 py-0.5 rounded-full tabular-nums">
              {cases.length} cases
            </span>
          </h1>
          <p className="text-sm text-gray-500 mt-1 inline-flex items-center gap-1.5">
            <Package className="h-3.5 w-3.5" />
            ASSR case management, tracking &amp; resolution
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => {
              if (confirm("Reset all ASSR data to seed data? This clears all changes.")) {
                resetASSRData();
                localStorage.removeItem("houzs_qms_columns");
                localStorage.removeItem("houzs_qms_column_order");
                window.location.reload();
              }
            }}
            className="h-9 px-3 rounded-md border border-[#DDE5E5] bg-white text-[12px] font-semibold text-gray-500 hover:text-red-600 hover:border-red-300 inline-flex items-center gap-1.5"
          >
            Reset Data
          </button>
          <button
            type="button" onClick={() => setShowNewCase(true)}
            className="h-9 px-3.5 rounded-md bg-[#0F766E] text-white text-[12px] font-semibold hover:bg-[#0D6B63] inline-flex items-center gap-1.5"
          >
            <Plus className="h-4 w-4" /> New Case
          </button>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          {
            label: "Total Open",
            value: stats.totalOpen,
            color: "text-[#0F766E]",
            icon: <Clock className="h-3.5 w-3.5 text-[#0F766E]" />,
          },
          {
            label: "Overdue",
            value: stats.overdue,
            color: stats.overdue > 0 ? "text-red-600" : "text-gray-700",
            icon: <AlertTriangle className={cn("h-3.5 w-3.5", stats.overdue > 0 ? "text-red-500" : "text-gray-400")} />,
          },
          {
            label: "Under Verification",
            value: stats.pendingReview,
            color: stats.pendingReview > 0 ? "text-blue-700" : "text-gray-700",
            icon: <Eye className={cn("h-3.5 w-3.5", stats.pendingReview > 0 ? "text-blue-500" : "text-gray-400")} />,
          },
          {
            label: "Completed This Month",
            value: stats.completedThisMonth,
            color: "text-emerald-700",
            icon: <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />,
          },
        ].map((s) => (
          <div key={s.label} className="rounded-lg border border-[#DDE5E5] bg-white px-4 py-3">
            <div className="flex items-center gap-1.5">
              {s.icon}
              <span className="text-[9px] font-semibold uppercase tracking-wider text-gray-400">{s.label}</span>
            </div>
            <div className={cn("text-[20px] font-bold mt-0.5 tabular-nums", s.color)}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Filter bar */}
      <div className="rounded-lg border border-[#DDE5E5] bg-white p-2.5 flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400 pointer-events-none" />
          <input
            type="text" value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Search case no, customer, product, phone, issue..."
            className="w-full h-8 pl-8 pr-8 rounded-md border border-[#DDE5E5] bg-white text-[11px] text-[#0A1F2E] placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-[#0F766E]/30 focus:border-[#0F766E]"
          />
          {search && (
            <button
              type="button" onClick={() => setSearch("")}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 h-5 w-5 rounded inline-flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>

        <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value as CaseStatus | "ALL")} className={FILTER_SELECT}>
          <option value="ALL">All statuses</option>
          {ALL_STATUSES.map((s) => <option key={s} value={s}>{CASE_STATUS_LABELS[s]}</option>)}
        </select>

        <select value={filterPriority} onChange={(e) => setFilterPriority(e.target.value as CasePriority | "ALL")} className={FILTER_SELECT}>
          <option value="ALL">All priorities</option>
          {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>

        <select value={filterBrand} onChange={(e) => setFilterBrand(e.target.value)} className={FILTER_SELECT}>
          <option value="ALL">All brands</option>
          {BRANDS.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>

        {isFiltering && (
          <button
            type="button"
            onClick={() => { setSearch(""); setFilterStatus("ALL"); setFilterPriority("ALL"); setFilterBrand("ALL"); }}
            className="h-8 px-2.5 rounded-md border border-[#DDE5E5] bg-white text-[11px] font-semibold text-gray-600 hover:border-red-300 hover:text-red-600 inline-flex items-center gap-1"
          >
            <X className="h-3 w-3" /> Clear
          </button>
        )}

        <div className="ml-auto flex items-center gap-2">
          <ColumnManager
            visibleCols={visibleCols}
            columnOrder={columnOrder}
            onToggle={toggleColumn}
            onMoveUp={moveColumnUp}
            onMoveDown={moveColumnDown}
          />
          <span className="text-[10px] text-gray-500 tabular-nums">
            {filtered.length} / {cases.length}
          </span>
        </div>
      </div>

      {/* Case table */}
      <div className="rounded-lg border border-[#DDE5E5] bg-white overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="bg-[#F4F7F7] text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                {activeColumns.map((col) => (
                  <th
                    key={col.key}
                    className={cn(
                      "text-left px-3 py-2 whitespace-nowrap select-none",
                      col.sortable && "cursor-pointer hover:text-[#0F766E] transition-colors",
                    )}
                    style={{ minWidth: col.minWidth }}
                    onClick={() => handleSort(col.key)}
                  >
                    <span className="inline-flex items-center gap-1">
                      {col.label}
                      {col.sortable && sortKey === col.key && (
                        sortDir === "asc"
                          ? <ArrowUp className="h-3 w-3 text-[#0F766E]" />
                          : <ArrowDown className="h-3 w-3 text-[#0F766E]" />
                      )}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#F0F3F3]">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={activeColumns.length} className="px-3 py-8 text-center text-[11px] text-gray-400">
                    {isFiltering ? "No cases match your filters" : "No cases yet — create your first one"}
                  </td>
                </tr>
              ) : (
                filtered.map((c) => (
                  <tr
                    key={c.id}
                    className="hover:bg-[#F4F7F7] cursor-pointer transition-colors"
                    onDoubleClick={() => navigate(`/qms/${c.id}`)}
                  >
                    {activeColumns.map((col) => (
                      <td key={col.key} className="px-3 py-2">
                        <CellContent col={col} c={c} />
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* New Case Dialog */}
      {showNewCase && <NewCaseDialog onClose={() => setShowNewCase(false)} />}
    </div>
  );
}
