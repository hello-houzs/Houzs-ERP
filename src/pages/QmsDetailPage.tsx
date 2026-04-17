import { useState, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Link } from "react-router-dom";
import {
  ArrowLeft, Edit2, Save, X, Clock, User, Phone, Mail, MapPin,
  Package, FileText, AlertTriangle, CheckCircle2, ChevronRight,
  MessageSquare, Plus, Truck, Building2, Printer, ImagePlus, Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  CARD, CARD_HEADER, FIELD_INPUT, FIELD_SELECT, FIELD_LABEL,
} from "@/lib/ui-tokens";
import {
  useASSRCases, updateCase, changeCaseStatus, addTimelineEntry,
  useASSRSuppliers, STAFF_LIST,
  CASE_STATUS_LABELS, CASE_STATUS_COLORS, PRIORITY_COLORS,
  CASE_WORKFLOW_ORDER, SERVICE_CATEGORY_LABELS,
  type ASSRCase, type CaseStatus, type CasePriority, type CaseCategory, type ServiceCategory, type LogEntry,
} from "@/lib/assr-store";
import { SearchableSelect } from "@/components/ui/searchable-select";

const BRANDS = ["AKEMI", "ZANOTTI", "ERGOTEX", "DUNLOPILLO"] as const;

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

const CATEGORY_COLORS: Record<CaseCategory, string> = {
  WARRANTY_SERVICE_REQUEST: "bg-purple-100 text-purple-700",
  INSTALLATION_ASSEMBLY_ISSUE: "bg-orange-100 text-orange-700",
  PRODUCT_DEFECT: "bg-red-100 text-red-700",
  DELIVERY_DAMAGE: "bg-amber-100 text-amber-700",
  MISSING_PARTS: "bg-yellow-100 text-yellow-700",
  CUSTOMER_COMPLAINT: "bg-pink-100 text-pink-700",
  RETURN_EXCHANGE: "bg-blue-100 text-blue-700",
  WRONG_ITEM: "bg-rose-100 text-rose-700",
  COLOUR_MISMATCH: "bg-fuchsia-100 text-fuchsia-700",
  FABRIC_ISSUE: "bg-violet-100 text-violet-700",
  STRUCTURE_DAMAGE: "bg-slate-100 text-slate-700",
  OTHERS: "bg-gray-100 text-gray-600",
};

// ─── Stepper icon per status ───────────────────────────────────────────────
function stepIcon(status: CaseStatus, isCurrent: boolean, isDone: boolean) {
  if (isDone) {
    return (
      <div className="h-6 w-6 rounded-full bg-emerald-500 flex items-center justify-center shrink-0">
        <CheckCircle2 className="h-3.5 w-3.5 text-white" strokeWidth={2.5} />
      </div>
    );
  }
  if (isCurrent) {
    return (
      <div className="h-6 w-6 rounded-full bg-[#0F766E] flex items-center justify-center shrink-0 ring-4 ring-[#0F766E]/20">
        <div className="h-2 w-2 rounded-full bg-white" />
      </div>
    );
  }
  return <div className="h-6 w-6 rounded-full border-2 border-gray-300 bg-white shrink-0" />;
}

// ─── LogEntry Card (reusable for Action Taken / Call Logs) ──────────────────

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

function LogEntryCard({
  title,
  entries,
  isEditing,
  onChange,
  draftEntries,
  caseData,
}: {
  title: string;
  entries: LogEntry[];
  isEditing: boolean;
  onChange: (logs: LogEntry[]) => void;
  draftEntries?: LogEntry[];
  caseData: ASSRCase;
}) {
  const displayEntries = isEditing ? (draftEntries ?? entries) : entries;
  return (
    <div className={CARD}>
      <div className="px-4 py-2.5 border-b border-[#DDE5E5] bg-[#F4F7F7] flex items-center justify-between">
        <span className="text-[12px] font-semibold uppercase tracking-wider text-[#0A1F2E] inline-flex items-center gap-1.5">
          <FileText className="h-3.5 w-3.5" /> {title}
        </span>
        {isEditing && (
          <button
            type="button"
            onClick={() => onChange([...(draftEntries ?? entries), { id: uid(), date: new Date().toISOString().split("T")[0], text: "" }])}
            className="h-6 px-2 rounded-md bg-[#0F766E] text-white text-[10px] font-semibold hover:bg-[#0c5f59] inline-flex items-center gap-1 transition"
          >
            <Plus className="h-3 w-3" /> Add Entry
          </button>
        )}
      </div>
      <div className="px-4 py-3">
        {displayEntries.length === 0 ? (
          <div className="text-[11px] text-gray-400 italic">No entries yet</div>
        ) : isEditing ? (
          <div className="space-y-2">
            {displayEntries.map((entry, idx) => (
              <div key={entry.id} className="flex gap-2 items-start">
                <input
                  type="date"
                  value={entry.date}
                  onChange={(e) => {
                    const updated = [...displayEntries];
                    updated[idx] = { ...updated[idx], date: e.target.value };
                    onChange(updated);
                  }}
                  className={cn(FIELD_INPUT, "!w-[140px] shrink-0")}
                />
                <input
                  type="text"
                  value={entry.text}
                  onChange={(e) => {
                    const updated = [...displayEntries];
                    updated[idx] = { ...updated[idx], text: e.target.value };
                    onChange(updated);
                  }}
                  placeholder="What was done..."
                  className={cn(FIELD_INPUT, "flex-1")}
                />
                <button
                  type="button"
                  onClick={() => onChange(displayEntries.filter((_, i) => i !== idx))}
                  className="h-9 w-9 shrink-0 rounded-md border border-[#DDE5E5] bg-white text-gray-400 hover:text-red-500 hover:border-red-300 inline-flex items-center justify-center"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-2">
            {displayEntries.map((entry) => (
              <div key={entry.id} className="flex gap-3 items-baseline">
                <span className="text-[10px] font-mono font-semibold text-[#0F766E] whitespace-nowrap shrink-0">{entry.date}</span>
                <span className="text-[12px] text-[#0A1F2E] leading-relaxed">{entry.text}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Page Component ─────────────────────────────────────────────────────────
export default function QmsDetailPage() {
  const params = useParams<{ id: string }>();
  const caseId = decodeURIComponent(params.id!);
  const navigate = useNavigate();

  const allCases = useASSRCases();
  const suppliers = useASSRSuppliers();
  const activeSuppliers = useMemo(
    () => suppliers.filter((s) => s.status === "ACTIVE"),
    [suppliers],
  );

  const caseData = useMemo(
    () => allCases.find((c) => c.id === caseId),
    [allCases, caseId],
  );

  // ── Edit mode state ────────────────────────────────────────────────────
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState<Partial<ASSRCase>>({});

  // ── Timeline note form ─────────────────────────────────────────────────
  const [showAddNote, setShowAddNote] = useState(false);
  const [noteAction, setNoteAction] = useState("Note added");
  const [noteUser, setNoteUser] = useState("");
  const [noteText, setNoteText] = useState("");

  // ── Start editing ─────────────────────────────────────────────────────
  function startEdit() {
    if (!caseData) return;
    setDraft({
      category: caseData.category,
      brand: caseData.brand,
      priority: caseData.priority,
      issueDescription: caseData.issueDescription,
      productName: caseData.productName,
      productSku: caseData.productSku ?? "",
      invoiceNo: caseData.invoiceNo ?? "",
      purchaseDate: caseData.purchaseDate ?? "",
      customerName: caseData.customerName,
      customerPhone: caseData.customerPhone,
      customerEmail: caseData.customerEmail,
      customerAddress: caseData.customerAddress,
      assignedTo: caseData.assignedTo,
      salesPerson: caseData.salesPerson ?? "",
      resolution: caseData.resolution ?? "",
      supplierName: caseData.supplierName ?? "",
      supplierRef: caseData.supplierRef ?? "",
      internalNotes: caseData.internalNotes ?? "",
      address1: caseData.address1 ?? "",
      address2: caseData.address2 ?? "",
      address3: caseData.address3 ?? "",
      address4: caseData.address4 ?? "",
      actionTakenLogs: caseData.actionTakenLogs ? [...caseData.actionTakenLogs] : [],
      callLogs: caseData.callLogs ? [...caseData.callLogs] : [],
    });
    setIsEditing(true);
  }

  function cancelEdit() {
    setIsEditing(false);
    setDraft({});
  }

  function saveEdit() {
    if (!caseData) return;
    updateCase(caseData.id, draft);
    addTimelineEntry(caseData.id, {
      timestamp: new Date().toISOString(),
      action: "Case updated",
      user: draft.assignedTo || caseData.assignedTo || "System",
      notes: "Case details updated",
    });
    setIsEditing(false);
    setDraft({});
  }

  function patchDraft<K extends keyof ASSRCase>(key: K, value: ASSRCase[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  // ── Change status (flexible — any status) ──────────────────────────
  function handleStatusChange(targetStatus: CaseStatus) {
    if (!caseData || caseData.status === targetStatus) return;
    changeCaseStatus(
      caseData.id,
      targetStatus,
      caseData.assignedTo || "System",
    );
  }

  // ── Add timeline note ─────────────────────────────────────────────────
  function submitNote() {
    if (!caseData || !noteText.trim()) return;
    addTimelineEntry(caseData.id, {
      timestamp: new Date().toISOString(),
      action: noteAction || "Note added",
      user: noteUser || caseData.assignedTo || "System",
      notes: noteText.trim(),
    });
    setNoteAction("Note added");
    setNoteUser("");
    setNoteText("");
    setShowAddNote(false);
  }

  // ── SLA computation ───────────────────────────────────────────────────
  const slaInfo = useMemo(() => {
    if (!caseData?.slaDeadline) return null;
    const deadline = new Date(caseData.slaDeadline);
    const now = new Date();
    const diffMs = deadline.getTime() - now.getTime();
    const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
    return { deadline, diffDays, overdue: diffDays < 0 };
  }, [caseData?.slaDeadline]);

  // ── Status helpers ────────────────────────────────────────────────────
  const currentStepIdx = caseData
    ? CASE_WORKFLOW_ORDER.indexOf(caseData.status)
    : -1;
  const isFinalOrCancelled =
    caseData?.status === "COMPLETED" || caseData?.status === "CANCELLED";
  const showResolution =
    caseData &&
    CASE_WORKFLOW_ORDER.indexOf(caseData.status) >=
      CASE_WORKFLOW_ORDER.indexOf("PENDING_SOLUTION");

  // ── Not found ─────────────────────────────────────────────────────────
  if (!caseData) {
    return (
      <div className="space-y-4 max-w-5xl">
        <Link
          to="/qms"
          className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-gray-500 hover:text-[#0F766E]"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to QMS
        </Link>
        <div className="rounded-lg border border-red-200 bg-red-50 p-8 text-center">
          <AlertTriangle className="h-8 w-8 text-red-400 mx-auto mb-2" />
          <div className="text-[14px] font-semibold text-red-700">
            Case not found
          </div>
          <div className="text-[12px] text-red-600 mt-1 font-mono">
            {caseId}
          </div>
          <Link
            to="/qms"
            className="mt-4 inline-flex items-center gap-1.5 text-[12px] font-semibold text-[#0F766E] hover:underline"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Return to case list
          </Link>
        </div>
      </div>
    );
  }

  // ── Sorted timeline (newest first) ────────────────────────────────────
  const sortedTimeline = [...caseData.timeline].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );

  return (
    <div className="space-y-5 max-w-6xl pb-12">
      {/* ──── Top bar ───────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          <Link
            to="/qms"
            className="inline-flex items-center justify-center h-8 w-8 rounded-md border border-[#DDE5E5] bg-white hover:border-[#0F766E] hover:text-[#0F766E] text-gray-500 transition shrink-0"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div className="min-w-0">
            <h1 className="text-[18px] font-bold text-[#0A1F2E] truncate">
              {caseData.caseNo}
            </h1>
          </div>
          <span
            className={cn(
              "px-2.5 py-0.5 rounded-full text-[10px] font-semibold shrink-0",
              CASE_STATUS_COLORS[caseData.status],
            )}
          >
            {CASE_STATUS_LABELS[caseData.status]}
          </span>
          <span
            className={cn(
              "px-2.5 py-0.5 rounded-full text-[10px] font-semibold shrink-0",
              PRIORITY_COLORS[caseData.priority],
            )}
          >
            {caseData.priority}
          </span>
        </div>

        <div className="flex gap-2 shrink-0">
          {/* Print templates */}
          <Link
            to={`/qms/${caseData.id}/print-customer`}
            target="_blank"
            className="h-8 px-3 rounded-md border border-[#DDE5E5] bg-white text-[11px] font-semibold text-gray-600 hover:border-[#0F766E] hover:text-[#0F766E] inline-flex items-center gap-1.5 transition"
          >
            <Printer className="h-3.5 w-3.5" /> Customer
          </Link>
          <Link
            to={`/qms/${caseData.id}/print-supplier`}
            target="_blank"
            className="h-8 px-3 rounded-md border border-[#DDE5E5] bg-white text-[11px] font-semibold text-gray-600 hover:border-[#0F766E] hover:text-[#0F766E] inline-flex items-center gap-1.5 transition"
          >
            <Printer className="h-3.5 w-3.5" /> Supplier
          </Link>
          {!isEditing ? (
            <button
              type="button"
              onClick={startEdit}
              className="h-8 px-3 rounded-md border border-[#DDE5E5] bg-white text-[11px] font-semibold text-gray-600 hover:border-[#0F766E] hover:text-[#0F766E] inline-flex items-center gap-1.5 transition"
            >
              <Edit2 className="h-3.5 w-3.5" /> Edit
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={cancelEdit}
                className="h-8 px-3 rounded-md border border-[#DDE5E5] bg-white text-[11px] font-semibold text-gray-600 hover:bg-gray-50 inline-flex items-center gap-1.5 transition"
              >
                <X className="h-3.5 w-3.5" /> Cancel
              </button>
              <button
                type="button"
                onClick={saveEdit}
                className="h-8 px-3.5 rounded-md bg-[#0F766E] text-white text-[11px] font-semibold hover:bg-[#0c5f59] inline-flex items-center gap-1.5 transition"
              >
                <Save className="h-3.5 w-3.5" /> Save
              </button>
            </>
          )}
        </div>
      </div>

      {/* ──── Status workflow stepper ──────────────────────────────────── */}
      <div className={CARD}>
        <div className={CARD_HEADER}>Workflow Progress</div>
        <div className="px-4 py-4">
          {/* Stepper */}
          <div className="flex items-center gap-0 overflow-x-auto pb-2">
            {CASE_WORKFLOW_ORDER.map((s, i) => {
              const isCurrent = s === caseData.status;
              const isDone = currentStepIdx > i;
              const isLast = i === CASE_WORKFLOW_ORDER.length - 1;
              return (
                <div key={s} className="flex items-center shrink-0">
                  <div className="flex flex-col items-center gap-1">
                    {stepIcon(s, isCurrent, isDone)}
                    <span
                      className={cn(
                        "text-[9px] font-semibold text-center leading-tight max-w-[80px]",
                        isCurrent
                          ? "text-[#0F766E]"
                          : isDone
                            ? "text-emerald-600"
                            : "text-gray-400",
                      )}
                    >
                      {CASE_STATUS_LABELS[s]}
                    </span>
                  </div>
                  {!isLast && (
                    <div
                      className={cn(
                        "h-[2px] w-8 mx-1 mt-[-16px]",
                        isDone ? "bg-emerald-400" : "bg-gray-200",
                      )}
                    />
                  )}
                </div>
              );
            })}
          </div>

          {/* Change status — flexible dropdown */}
          {!isFinalOrCancelled && (
            <div className="mt-3 flex items-center justify-end gap-2">
              <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Change to:</span>
              <select
                value=""
                onChange={(e) => {
                  if (e.target.value) handleStatusChange(e.target.value as CaseStatus);
                }}
                className="h-8 rounded-md border border-[#0F766E] bg-[#0F766E] text-white pl-3 pr-7 text-[11px] font-semibold cursor-pointer appearance-none bg-no-repeat bg-[right_0.5rem_center] bg-[length:10px] bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22white%22%20stroke-width%3D%222%22%3E%3Cpath%20d%3D%22M6%209l6%206%206-6%22%2F%3E%3C%2Fsvg%3E')] hover:bg-[#0c5f59] focus:outline-none transition"
              >
                <option value="" disabled>Select status...</option>
                {([...CASE_WORKFLOW_ORDER, "CANCELLED" as CaseStatus]).filter(s => s !== caseData.status).map((s) => (
                  <option key={s} value={s}>{CASE_STATUS_LABELS[s]}</option>
                ))}
              </select>
            </div>
          )}
        </div>
      </div>

      {/* ──── Main content — 2-col layout ─────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Left column (2/3) */}
        <div className="lg:col-span-2 space-y-5">
          {/* Issue Details */}
          <div className={CARD}>
            <div className={CARD_HEADER}>Issue Details</div>
            <div className="px-4 py-4 space-y-4">
              <div className="flex flex-wrap gap-2">
                {!isEditing ? (
                  <>
                    <span
                      className={cn(
                        "px-2.5 py-0.5 rounded-full text-[10px] font-semibold",
                        CATEGORY_COLORS[caseData.category],
                      )}
                    >
                      {CATEGORY_LABELS[caseData.category]}
                    </span>
                    <span className="px-2.5 py-0.5 rounded-full text-[10px] font-semibold bg-[#0F766E]/10 text-[#0F766E]">
                      {caseData.brand}
                    </span>
                  </>
                ) : (
                  <div className="grid grid-cols-2 gap-3 w-full">
                    <div>
                      <div className={FIELD_LABEL}>Category</div>
                      <select
                        value={draft.category ?? ""}
                        onChange={(e) =>
                          patchDraft("category", e.target.value as CaseCategory)
                        }
                        className={FIELD_SELECT}
                      >
                        {Object.entries(CATEGORY_LABELS).map(([k, v]) => (
                          <option key={k} value={k}>
                            {v}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <div className={FIELD_LABEL}>Brand</div>
                      <select
                        value={draft.brand ?? ""}
                        onChange={(e) =>
                          patchDraft("brand", e.target.value)
                        }
                        className={FIELD_SELECT}
                      >
                        {BRANDS.map((b) => (
                          <option key={b} value={b}>{b}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}
              </div>

              <div>
                <div className={FIELD_LABEL}>Issue Description</div>
                {!isEditing ? (
                  <p className="text-[12px] text-[#0A1F2E] leading-relaxed whitespace-pre-wrap">
                    {caseData.issueDescription}
                  </p>
                ) : (
                  <textarea
                    rows={4}
                    value={draft.issueDescription ?? ""}
                    onChange={(e) =>
                      patchDraft("issueDescription", e.target.value)
                    }
                    className={cn(FIELD_INPUT, "h-auto py-2 resize-y")}
                  />
                )}
              </div>

              {/* Photos / Videos — upload + display */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <div className={FIELD_LABEL + " mb-0"}>Service Issue Photos / Videos</div>
                  <label className="text-[10px] font-semibold text-[#0F766E] hover:underline cursor-pointer inline-flex items-center gap-0.5">
                    <ImagePlus className="h-3 w-3" /> Upload
                    <input
                      type="file"
                      accept="image/*,video/*"
                      multiple
                      className="hidden"
                      onChange={(e) => {
                        const files = e.target.files;
                        if (!files || !caseData) return;
                        Array.from(files).forEach((file) => {
                          const reader = new FileReader();
                          reader.onload = () => {
                            const dataUrl = reader.result as string;
                            const current = [...(caseData.photoUrls || []), dataUrl];
                            updateCase(caseData.id, { photoUrls: current });
                          };
                          reader.readAsDataURL(file);
                        });
                        e.target.value = "";
                      }}
                    />
                  </label>
                </div>
                {caseData.photoUrls.length > 0 ? (
                  <div className="flex flex-wrap gap-2 mt-1">
                    {caseData.photoUrls.map((url, i) => (
                      <div key={i} className="relative group">
                        {url.startsWith("data:video") ? (
                          <video
                            src={url}
                            className="h-24 w-24 rounded-md border border-[#DDE5E5] bg-gray-50 object-cover"
                            controls
                          />
                        ) : (
                          <img
                            src={url}
                            alt={`Photo ${i + 1}`}
                            className="h-24 w-24 rounded-md border border-[#DDE5E5] bg-gray-50 object-cover cursor-pointer"
                            onClick={() => window.open(url, "_blank")}
                          />
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            const updated = caseData.photoUrls.filter((_, idx) => idx !== i);
                            updateCase(caseData.id, { photoUrls: updated });
                          }}
                          className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-red-500 text-white opacity-0 group-hover:opacity-100 transition-opacity inline-flex items-center justify-center shadow"
                        >
                          <Trash2 className="h-2.5 w-2.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="border-2 border-dashed border-[#DDE5E5] rounded-lg p-4 text-center">
                    <ImagePlus className="h-6 w-6 text-gray-300 mx-auto mb-1" />
                    <div className="text-[11px] text-gray-400">No photos/videos attached — click Upload above</div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Product Info */}
          <div className={CARD}>
            <div className={CARD_HEADER}>
              <span className="inline-flex items-center gap-1.5">
                <Package className="h-3.5 w-3.5" /> Product Info
              </span>
            </div>
            <div className="px-4 py-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className={FIELD_LABEL}>Product Name</div>
                  {!isEditing ? (
                    <div className="text-[12px] font-semibold text-[#0A1F2E]">
                      {caseData.productName}
                    </div>
                  ) : (
                    <input
                      type="text"
                      value={draft.productName ?? ""}
                      onChange={(e) =>
                        patchDraft("productName", e.target.value)
                      }
                      className={FIELD_INPUT}
                    />
                  )}
                </div>
                <div>
                  <div className={FIELD_LABEL}>Product SKU</div>
                  {!isEditing ? (
                    <div className="text-[12px] text-[#0A1F2E] font-mono">
                      {caseData.productSku || (
                        <span className="text-gray-300">--</span>
                      )}
                    </div>
                  ) : (
                    <input
                      type="text"
                      value={draft.productSku ?? ""}
                      onChange={(e) =>
                        patchDraft("productSku", e.target.value)
                      }
                      className={FIELD_INPUT}
                    />
                  )}
                </div>
                <div>
                  <div className={FIELD_LABEL}>Invoice No</div>
                  {!isEditing ? (
                    <div className="text-[12px] text-[#0A1F2E]">
                      {caseData.invoiceNo || (
                        <span className="text-gray-300">--</span>
                      )}
                    </div>
                  ) : (
                    <input
                      type="text"
                      value={draft.invoiceNo ?? ""}
                      onChange={(e) =>
                        patchDraft("invoiceNo", e.target.value)
                      }
                      className={FIELD_INPUT}
                    />
                  )}
                </div>
                <div>
                  <div className={FIELD_LABEL}>Purchase Date</div>
                  {!isEditing ? (
                    <div className="text-[12px] text-[#0A1F2E]">
                      {caseData.purchaseDate || (
                        <span className="text-gray-300">--</span>
                      )}
                    </div>
                  ) : (
                    <input
                      type="date"
                      value={draft.purchaseDate ?? ""}
                      onChange={(e) =>
                        patchDraft("purchaseDate", e.target.value)
                      }
                      className={FIELD_INPUT}
                    />
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Resolution (only if status >= PENDING_SOLUTION) */}
          {showResolution && (
            <div className={CARD}>
              <div className={CARD_HEADER}>
                <span className="inline-flex items-center gap-1.5">
                  <FileText className="h-3.5 w-3.5" /> Resolution
                </span>
              </div>
              <div className="px-4 py-4 space-y-4">
                <div>
                  <div className={FIELD_LABEL}>Resolution</div>
                  {!isEditing ? (
                    <p className="text-[12px] text-[#0A1F2E] leading-relaxed whitespace-pre-wrap">
                      {caseData.resolution || (
                        <span className="text-gray-400 italic">
                          No resolution recorded yet
                        </span>
                      )}
                    </p>
                  ) : (
                    <textarea
                      rows={3}
                      value={draft.resolution ?? ""}
                      onChange={(e) =>
                        patchDraft("resolution", e.target.value)
                      }
                      className={cn(FIELD_INPUT, "h-auto py-2 resize-y")}
                    />
                  )}
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <div className={FIELD_LABEL}>Supplier</div>
                    {!isEditing ? (
                      <div className="text-[12px] text-[#0A1F2E] inline-flex items-center gap-1.5">
                        <Building2 className="h-3 w-3 text-gray-400" />
                        {caseData.supplierName || (
                          <span className="text-gray-300">--</span>
                        )}
                      </div>
                    ) : (
                      <select
                        value={draft.supplierName ?? ""}
                        onChange={(e) =>
                          patchDraft("supplierName", e.target.value)
                        }
                        className={FIELD_SELECT}
                      >
                        <option value="">-- Select supplier --</option>
                        {activeSuppliers.map((s) => (
                          <option key={s.id} value={s.name}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                  <div>
                    <div className={FIELD_LABEL}>Supplier Ref</div>
                    {!isEditing ? (
                      <div className="text-[12px] text-[#0A1F2E] font-mono">
                        {caseData.supplierRef || (
                          <span className="text-gray-300">--</span>
                        )}
                      </div>
                    ) : (
                      <input
                        type="text"
                        value={draft.supplierRef ?? ""}
                        onChange={(e) =>
                          patchDraft("supplierRef", e.target.value)
                        }
                        className={FIELD_INPUT}
                      />
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Internal Notes */}
          <div className={CARD}>
            <div className={CARD_HEADER}>
              <span className="inline-flex items-center gap-1.5">
                <MessageSquare className="h-3.5 w-3.5" /> Internal Notes
              </span>
            </div>
            <div className="px-4 py-4">
              {!isEditing ? (
                <p className="text-[12px] text-[#0A1F2E] leading-relaxed whitespace-pre-wrap">
                  {caseData.internalNotes || (
                    <span className="text-gray-400 italic">
                      No internal notes
                    </span>
                  )}
                </p>
              ) : (
                <textarea
                  rows={3}
                  value={draft.internalNotes ?? ""}
                  onChange={(e) =>
                    patchDraft("internalNotes", e.target.value)
                  }
                  className={cn(FIELD_INPUT, "h-auto py-2 resize-y")}
                />
              )}
            </div>
          </div>

          {/* Action Taken Logs */}
          <LogEntryCard
            title="Action Taken (Service Agent Log)"
            entries={caseData.actionTakenLogs || []}
            isEditing={isEditing}
            onChange={(logs) => patchDraft("actionTakenLogs", logs)}
            draftEntries={draft.actionTakenLogs}
            caseData={caseData}
          />

          {/* Call Logs */}
          <LogEntryCard
            title="Call Log: Purchasing Action Taken"
            entries={caseData.callLogs || []}
            isEditing={isEditing}
            onChange={(logs) => patchDraft("callLogs", logs)}
            draftEntries={draft.callLogs}
            caseData={caseData}
          />

          {/* Google Sheet Reference Fields */}
          <div className={CARD}>
            <div className={CARD_HEADER}>
              <span className="inline-flex items-center gap-1.5">
                <FileText className="h-3.5 w-3.5" /> Reference & Logistics
              </span>
            </div>
            <div className="px-4 py-4">
              <div className="grid grid-cols-3 gap-4">
                <div><div className={FIELD_LABEL}>S/O</div><div className="text-[12px] font-mono text-[#0F766E] font-semibold">{caseData.salesOrderNo || <span className="text-gray-300">--</span>}</div></div>
                <div><div className={FIELD_LABEL}>Ref No</div><div className="text-[12px] font-mono font-semibold text-[#0A1F2E]">{caseData.refNo || <span className="text-gray-300">--</span>}</div></div>
                <div><div className={FIELD_LABEL}>Complained Date</div><div className="text-[12px] text-[#0A1F2E]">{caseData.complainedDate || <span className="text-gray-300">--</span>}</div></div>
                <div><div className={FIELD_LABEL}>D/O</div><div className="text-[12px] font-mono text-[#0A1F2E]">{caseData.deliveryOrderNo || <span className="text-gray-300">--</span>}</div></div>
                <div><div className={FIELD_LABEL}>DO Delivered Date</div><div className="text-[12px] text-[#0A1F2E]">{caseData.doDeliveredDate || <span className="text-gray-300">--</span>}</div></div>
                <div><div className={FIELD_LABEL}>Location</div><div className="text-[12px] text-[#0A1F2E]">{caseData.location || <span className="text-gray-300">--</span>}</div></div>
                <div><div className={FIELD_LABEL}>Service Category</div><div className="text-[12px] text-[#0A1F2E]">{caseData.serviceCategory ? SERVICE_CATEGORY_LABELS[caseData.serviceCategory] : <span className="text-gray-300">--</span>}</div></div>
                <div><div className={FIELD_LABEL}>PO No</div><div className="text-[12px] font-mono text-[#0A1F2E]">{caseData.poNo || <span className="text-gray-300">--</span>}</div></div>
                <div><div className={FIELD_LABEL}>Link Ref.</div><div className="text-[12px] font-mono text-[#0A1F2E]">{caseData.linkRef || <span className="text-gray-300">--</span>}</div></div>
              </div>
              {(caseData.actionRemark || caseData.itemDetails || caseData.goodsReturnedNote || caseData.supplierServiceNote) && (
                <div className="mt-4 space-y-3 border-t border-[#DDE5E5] pt-3">
                  {caseData.actionRemark && <div><div className={FIELD_LABEL}>Action Remark</div><div className="text-[12px] text-[#0A1F2E]">{caseData.actionRemark}</div></div>}
                  {caseData.itemDetails && <div><div className={FIELD_LABEL}>Item Details</div><div className="text-[12px] text-[#0A1F2E]">{caseData.itemDetails}</div></div>}
                  {caseData.goodsReturnedNote && <div><div className={FIELD_LABEL}>Goods Returned Note & Date</div><div className="text-[12px] text-[#0A1F2E]">{caseData.goodsReturnedNote}</div></div>}
                  {caseData.supplierServiceNote && <div><div className={FIELD_LABEL}>Supplier Service Note</div><div className="text-[12px] text-[#0A1F2E]">{caseData.supplierServiceNote}</div></div>}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right column (1/3) */}
        <div className="space-y-5">
          {/* Customer Info */}
          <div className={CARD}>
            <div className={CARD_HEADER}>
              <span className="inline-flex items-center gap-1.5">
                <User className="h-3.5 w-3.5" /> Customer Info
              </span>
            </div>
            <div className="px-4 py-4 space-y-3">
              <div>
                <div className={FIELD_LABEL}>Name</div>
                {!isEditing ? (
                  <div className="text-[13px] font-semibold text-[#0A1F2E]">
                    {caseData.customerName}
                  </div>
                ) : (
                  <input
                    type="text"
                    value={draft.customerName ?? ""}
                    onChange={(e) =>
                      patchDraft("customerName", e.target.value)
                    }
                    className={FIELD_INPUT}
                  />
                )}
              </div>
              <div>
                <div className={FIELD_LABEL}>Phone</div>
                {!isEditing ? (
                  <div className="text-[12px] text-[#0A1F2E] inline-flex items-center gap-1.5">
                    <Phone className="h-3 w-3 text-gray-400" />
                    {caseData.customerPhone}
                  </div>
                ) : (
                  <input
                    type="text"
                    value={draft.customerPhone ?? ""}
                    onChange={(e) =>
                      patchDraft("customerPhone", e.target.value)
                    }
                    className={FIELD_INPUT}
                  />
                )}
              </div>
              <div>
                <div className={FIELD_LABEL}>Email</div>
                {!isEditing ? (
                  <div className="text-[12px] text-[#0A1F2E] inline-flex items-center gap-1.5">
                    <Mail className="h-3 w-3 text-gray-400" />
                    {caseData.customerEmail || (
                      <span className="text-gray-300">--</span>
                    )}
                  </div>
                ) : (
                  <input
                    type="email"
                    value={draft.customerEmail ?? ""}
                    onChange={(e) =>
                      patchDraft("customerEmail", e.target.value)
                    }
                    className={FIELD_INPUT}
                  />
                )}
              </div>
              <div>
                <div className={FIELD_LABEL}>Address 1</div>
                {!isEditing ? (
                  <div className="text-[12px] text-[#0A1F2E] inline-flex items-start gap-1.5">
                    <MapPin className="h-3 w-3 text-gray-400 mt-0.5 shrink-0" />
                    <span>{caseData.address1 || <span className="text-gray-300">--</span>}</span>
                  </div>
                ) : (
                  <input type="text" value={draft.address1 ?? ""} onChange={(e) => patchDraft("address1", e.target.value)} placeholder="Street / Unit" className={FIELD_INPUT} />
                )}
              </div>
              <div>
                <div className={FIELD_LABEL}>Address 2</div>
                {!isEditing ? (
                  <div className="text-[12px] text-[#0A1F2E]">{caseData.address2 || <span className="text-gray-300">--</span>}</div>
                ) : (
                  <input type="text" value={draft.address2 ?? ""} onChange={(e) => patchDraft("address2", e.target.value)} placeholder="Area / Taman" className={FIELD_INPUT} />
                )}
              </div>
              <div>
                <div className={FIELD_LABEL}>Address 3</div>
                {!isEditing ? (
                  <div className="text-[12px] text-[#0A1F2E]">{caseData.address3 || <span className="text-gray-300">--</span>}</div>
                ) : (
                  <input type="text" value={draft.address3 ?? ""} onChange={(e) => patchDraft("address3", e.target.value)} placeholder="City / Postcode" className={FIELD_INPUT} />
                )}
              </div>
              <div>
                <div className={FIELD_LABEL}>Address 4</div>
                {!isEditing ? (
                  <div className="text-[12px] text-[#0A1F2E]">{caseData.address4 || <span className="text-gray-300">--</span>}</div>
                ) : (
                  <input type="text" value={draft.address4 ?? ""} onChange={(e) => patchDraft("address4", e.target.value)} placeholder="State" className={FIELD_INPUT} />
                )}
              </div>
            </div>
          </div>

          {/* Assignment */}
          <div className={CARD}>
            <div className={CARD_HEADER}>Assignment</div>
            <div className="px-4 py-4 space-y-3">
              <div>
                <div className={FIELD_LABEL}>PIC (Sales Person)</div>
                {!isEditing ? (
                  <div className="text-[12px] font-semibold text-[#0A1F2E]">
                    {caseData.salesPerson || (
                      <span className="text-gray-300">--</span>
                    )}
                  </div>
                ) : (
                  <SearchableSelect
                    value={draft.salesPerson ?? ""}
                    onChange={(v) => patchDraft("salesPerson", v)}
                    options={STAFF_LIST}
                    placeholder="Select PIC..."
                  />
                )}
              </div>
            </div>
          </div>

          {/* SLA */}
          <div className={CARD}>
            <div className={CARD_HEADER}>
              <span className="inline-flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5" /> SLA
              </span>
            </div>
            <div className="px-4 py-4 space-y-3">
              <div>
                <div className={FIELD_LABEL}>Deadline</div>
                <div className="text-[12px] font-semibold text-[#0A1F2E]">
                  {caseData.slaDeadline
                    ? new Date(caseData.slaDeadline).toLocaleDateString(
                        "en-GB",
                        { day: "2-digit", month: "short", year: "numeric" },
                      )
                    : "--"}
                </div>
              </div>
              {slaInfo && (
                <div>
                  <div className={FIELD_LABEL}>Status</div>
                  {slaInfo.overdue ? (
                    <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-red-50 text-red-700 text-[12px] font-semibold">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      {Math.abs(slaInfo.diffDays)} day
                      {Math.abs(slaInfo.diffDays) !== 1 ? "s" : ""} overdue
                    </div>
                  ) : (
                    <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-emerald-50 text-emerald-700 text-[12px] font-semibold">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      {slaInfo.diffDays} day
                      {slaInfo.diffDays !== 1 ? "s" : ""} remaining
                    </div>
                  )}
                </div>
              )}
              <div>
                <div className={FIELD_LABEL}>Priority</div>
                <span
                  className={cn(
                    "px-2.5 py-0.5 rounded-full text-[10px] font-semibold",
                    PRIORITY_COLORS[caseData.priority],
                  )}
                >
                  {caseData.priority}
                </span>
              </div>
            </div>
          </div>

          {/* Timeline */}
          <div className={CARD}>
            <div className="px-4 py-2.5 border-b border-[#DDE5E5] bg-[#F4F7F7] flex items-center justify-between">
              <span className="text-[12px] font-semibold uppercase tracking-wider text-[#0A1F2E] inline-flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5" /> Timeline
              </span>
              <button
                type="button"
                onClick={() => setShowAddNote(true)}
                className="h-6 px-2 rounded-md bg-[#0F766E] text-white text-[10px] font-semibold hover:bg-[#0c5f59] inline-flex items-center gap-1 transition"
              >
                <Plus className="h-3 w-3" /> Add Note
              </button>
            </div>
            <div className="max-h-[420px] overflow-y-auto">
              {/* Inline add-note form */}
              {showAddNote && (
                <div className="px-4 py-3 border-b border-[#DDE5E5] bg-[#FAFBFB] space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <div className={FIELD_LABEL}>Action</div>
                      <input
                        type="text"
                        value={noteAction}
                        onChange={(e) => setNoteAction(e.target.value)}
                        placeholder="e.g. Note added"
                        className={FIELD_INPUT}
                      />
                    </div>
                    <div>
                      <div className={FIELD_LABEL}>User</div>
                      <input
                        type="text"
                        value={noteUser}
                        onChange={(e) => setNoteUser(e.target.value)}
                        placeholder="Your name"
                        className={FIELD_INPUT}
                      />
                    </div>
                  </div>
                  <div>
                    <div className={FIELD_LABEL}>Notes</div>
                    <textarea
                      rows={2}
                      value={noteText}
                      onChange={(e) => setNoteText(e.target.value)}
                      placeholder="Enter your note..."
                      className={cn(FIELD_INPUT, "h-auto py-2 resize-y")}
                    />
                  </div>
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setShowAddNote(false);
                        setNoteText("");
                        setNoteUser("");
                        setNoteAction("Note added");
                      }}
                      className="h-7 px-2.5 rounded-md border border-[#DDE5E5] bg-white text-[10px] font-semibold text-gray-600 hover:bg-gray-50 transition"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={submitNote}
                      disabled={!noteText.trim()}
                      className="h-7 px-3 rounded-md bg-[#0F766E] text-white text-[10px] font-semibold hover:bg-[#0c5f59] disabled:opacity-40 disabled:cursor-not-allowed transition"
                    >
                      Submit
                    </button>
                  </div>
                </div>
              )}

              {/* Timeline entries */}
              {sortedTimeline.length === 0 ? (
                <div className="px-4 py-6 text-center text-[11px] text-gray-400">
                  No timeline entries yet
                </div>
              ) : (
                <div className="relative">
                  {/* Left border line */}
                  <div className="absolute left-[23px] top-0 bottom-0 w-[2px] bg-[#DDE5E5]" />
                  {sortedTimeline.map((entry, i) => (
                    <div
                      key={entry.id}
                      className={cn(
                        "relative pl-12 pr-4 py-3",
                        i % 2 === 0 ? "bg-white" : "bg-[#FAFBFB]",
                      )}
                    >
                      {/* Dot */}
                      <div className="absolute left-[18px] top-4 h-[12px] w-[12px] rounded-full border-2 border-[#0F766E] bg-white z-10" />
                      <div className="text-[10px] text-gray-400 mb-0.5">
                        {new Date(entry.timestamp).toLocaleString("en-GB", {
                          day: "2-digit",
                          month: "short",
                          year: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </div>
                      <div className="text-[11px] font-semibold text-[#0A1F2E]">
                        {entry.action}
                      </div>
                      <div className="text-[10px] text-gray-500">
                        by {entry.user}
                      </div>
                      {entry.notes && (
                        <p className="text-[11px] text-gray-600 mt-1 leading-relaxed">
                          {entry.notes}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
