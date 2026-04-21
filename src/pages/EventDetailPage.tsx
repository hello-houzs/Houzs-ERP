import { Link, useParams, useNavigate } from "react-router-dom";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft, Calendar as CalIcon, MapPin, Building2, User, Hash,
  Check, Minus, AlertCircle, Trash2, ExternalLink, Paperclip, Pencil, X as XIcon,
  Plus, FileText, ShieldCheck, Truck,
} from "lucide-react";
import {
  calendarTitle, fmtRM, fmtPct, computeCosts,
  BRANDS, STATES, PREPARATION_CONDITIONS,
  type HouzsEvent, type WorkflowFlag, type Brand, type EventType,
  type EventStatus, type EventProgress, type MalaysianState,
  type EventDriver, type PreparationCondition,
} from "@/lib/mock-data";
import {
  useBoothDocs, createBoothDoc, updateBoothDoc, deleteBoothDoc, setApproval,
  BOOTH_DOC_LABELS, BOOTH_DOC_HINTS, BOOTH_DOC_POSITION,
  BOOTH_LAYOUT_DOCS, SETUP_DISMANTLE_DOCS, PREPARATION_DOCS,
  type BoothDoc, type BoothDocType, type ApprovalStatus,
} from "@/lib/booth-docs-store";
import {
  useCompetitors, addCompetitor, updateCompetitor, removeCompetitor,
  type CompetitorEntry,
} from "@/lib/expo-map-store";
import {
  useAllEvents, updateEvent, deleteUserEvent,
} from "@/lib/events-store";
import { useSalesMembers, type SalesMember } from "@/lib/sales-store";
import { useEventPhotos, type PhotoRecord } from "@/lib/photos-store";
import { useCurrentUser, canViewEvent, canViewFullEvent, isAdmin } from "@/lib/auth-store";
import {
  useMasterData,
  addOrganizer, addVenue, addPic, addContractor, addDriver, addLori,
} from "@/lib/master-data-store";
import { Combo } from "@/components/ui/combo";
import { WorkflowAttachmentDialog } from "@/components/ui/workflow-attachment-dialog";
import { EventChat } from "@/components/ui/event-chat";
import { FIELD_LABEL, FIELD_INPUT, FIELD_SELECT } from "@/lib/ui-tokens";

const STATUS_OPTIONS: EventStatus[] = ["CONFIRMED", "PENDING", "CANCELLED"];
const PROGRESS_OPTIONS: EventProgress[] = ["NOT STARTED", "IN PROGRESS", "COMPLETED"];
const TYPE_OPTIONS: EventType[] = ["SOLO", "EXHIBITION"];
const SD_STATUSES: NonNullable<HouzsEvent["setupDismantleStatus"]>[] = [
  "", "PREPARED", "SETUP DONE", "DISMANTLE DONE",
];

const WORKFLOW_FIELDS: { key: keyof HouzsEvent; label: string; stage: string }[] = [
  { key: "agreementApproval",       label: "Agreement / Quotation Approval", stage: "Contract" },
  { key: "floorplan",               label: "Floorplan",                      stage: "Design" },
  { key: "sendFloorplanToDesigner", label: "Send Floorplan to Designer",     stage: "Design" },
  { key: "threeDCheckedByMgt",      label: "3D Checked by MGT",              stage: "3D Approval" },
  { key: "threeDApprovedByPeter",   label: "3D Approved by Peter",           stage: "3D Approval" },
  { key: "threeDUploadedInNotion",  label: "3D Uploaded in Notion",          stage: "3D Approval" },
  { key: "weekendActivityTheme",    label: "Weekend Activity (Theme)",       stage: "Operation" },
  { key: "licenseMajlis",           label: "License (from Majlis)",          stage: "Operation" },
  { key: "workLoadingBayPermit",    label: "Work / Loading Bay Permit",      stage: "Operation" },
  { key: "decoCoffeeTable",         label: "Deco / Coffee Table",            stage: "Operation" },
  { key: "secDepoRefund",           label: "Sec Depo Refund",                stage: "Closeout" },
];

const FLAG_OPTIONS: { value: WorkflowFlag; label: string; color: string }[] = [
  { value: "",        label: "—",       color: "bg-white text-gray-400 border-[#DDE5E5]" },
  { value: "TRUE",    label: "TRUE",    color: "bg-[#0F766E]/10 text-[#0F766E] border-[#0F766E]/30" },
  { value: "DONE",    label: "DONE",    color: "bg-[#0F766E]/10 text-[#0F766E] border-[#0F766E]/30" },
  { value: "FALSE",   label: "FALSE",   color: "bg-amber-100 text-amber-700 border-amber-300" },
  { value: "NO NEED", label: "NO NEED", color: "bg-gray-100 text-gray-500 border-gray-300" },
];

function isDone(v: WorkflowFlag) { return v === "TRUE" || v === "DONE"; }
function isSkipped(v: WorkflowFlag) { return v === "NO NEED"; }

export default function EventDetailPage() {
  const navigate = useNavigate();
  const params = useParams<{ id: string }>();
  const a42 = decodeURIComponent(params.id!);
  const allEvents = useAllEvents();
  const event = useMemo(() => allEvents.find((e) => e.a42 === a42), [allEvents, a42]);
  const master = useMasterData();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [openAttach, setOpenAttach] = useState<{ key: string; label: string } | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState<Partial<HouzsEvent>>({});
  const { photos: allPhotos } = useEventPhotos(a42);
  const salesMembers = useSalesMembers();
  const currentUser = useCurrentUser();
  const userIsAdmin = isAdmin(currentUser);
  const activeSalesMembers = useMemo(() => salesMembers.filter(m => m.status === "ACTIVE").sort((a, b) => a.name.localeCompare(b.name)), [salesMembers]);

  // Booth docs & competitor state
  const boothDocs = useBoothDocs(a42);
  const competitors = useCompetitors(a42);
  const [openBoothDoc, setOpenBoothDoc] = useState<BoothDoc | null>(null);
  const [attendanceEdit, setAttendanceEdit] = useState(false);
  const [attendanceSearch, setAttendanceSearch] = useState("");

  function toggleAttendance(memberId: string) {
    if (!event) return;
    const current = event.assignedSales ?? [];
    const next = current.includes(memberId)
      ? current.filter((x) => x !== memberId)
      : [...current, memberId];
    updateEvent(a42, { assignedSales: next });
  }
  const [openCompetitorForm, setOpenCompetitorForm] = useState<CompetitorEntry | "new" | null>(null);
  const [approvalNotesDraft, setApprovalNotesDraft] = useState("");

  // Draft drivers/loris in edit mode
  const [draftDrivers, setDraftDrivers] = useState<EventDriver[]>([]);
  const [draftLoris, setDraftLoris] = useState<string[]>([]);
  const [newDriverName, setNewDriverName] = useState("");
  const [newDriverPhone, setNewDriverPhone] = useState("");
  const [newLoriPlate, setNewLoriPlate] = useState("");

  // Seed draft whenever we enter edit mode (or event changes while editing)
  useEffect(() => {
    if (isEditing && event) {
      setDraft({
        status: event.status,
        progress: event.progress,
        brand: event.brand,
        eventType: event.eventType,
        startDate: event.startDate,
        endDate: event.endDate,
        organizer: event.organizer,
        state: event.state,
        venue: event.venue,
        contractor: event.contractor,
        boothNo: event.boothNo,
        sizeSqm: event.sizeSqm,
        pic: event.pic ?? "",
        totalSalesRm: event.totalSalesRm,
        rentalRm: event.rentalRm,
        setupDriver: event.setupDriver ?? "",
        setupLori: event.setupLori ?? "",
        setupDatetime: event.setupDatetime ?? "",
        dismantleDatetime: event.dismantleDatetime ?? "",
        setupDismantleStatus: event.setupDismantleStatus ?? "",
        assignedSales: event.assignedSales ?? [],
      });
      setDraftDrivers(event.setupDrivers ?? []);
      setDraftLoris(event.setupLoris ?? []);
      setNewDriverName("");
      setNewDriverPhone("");
      setNewLoriPlate("");
    }
  }, [isEditing, event]);
  const countByKey = useMemo(() => {
    const map: Record<string, number> = {};
    for (const p of allPhotos) {
      if (p.workflowKey) map[p.workflowKey] = (map[p.workflowKey] ?? 0) + 1;
    }
    return map;
  }, [allPhotos]);

  if (!event) {
    return (
      <div className="space-y-4">
        <Link to="/pms" className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-gray-500 hover:text-[#0F766E]">
          <ArrowLeft className="h-3.5 w-3.5" /> Back to Project Details
        </Link>
        <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-center">
          <AlertCircle className="h-8 w-8 text-red-400 mx-auto mb-2" />
          <div className="text-[13px] font-semibold text-red-700">Event not found</div>
          <div className="text-[11px] text-red-600 mt-1 font-mono">{a42}</div>
        </div>
      </div>
    );
  }

  if (!canViewEvent(currentUser, event)) {
    return (
      <div className="space-y-4">
        <Link to="/pms" className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-gray-500 hover:text-[#0F766E]">
          <ArrowLeft className="h-3.5 w-3.5" /> Back to Project Details
        </Link>
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-8 text-center">
          <AlertCircle className="h-8 w-8 text-amber-400 mx-auto mb-3" />
          <div className="text-[14px] font-semibold text-amber-800">Access Denied</div>
          <div className="text-[12px] text-amber-700 mt-1">
            This event is not assigned to you.
          </div>
          <Link
            to="/pms"
            className="mt-4 inline-flex items-center gap-1.5 text-[11px] font-semibold text-[#0F766E] hover:underline"
          >
            <ArrowLeft className="h-3 w-3" /> Return to Project Details
          </Link>
        </div>
      </div>
    );
  }

  const hasFullAccess = canViewFullEvent(currentUser, event);

  // Limited view for non-assigned sales during LIVE events —
  // they can only see basic info, floorplan section (with upload), and chat.
  if (!hasFullAccess) {
    const floorplanCount = countByKey["floorplan"] ?? 0;
    const sendFpCount = countByKey["sendFloorplanToDesigner"] ?? 0;
    return (
      <div className="space-y-4 max-w-6xl">
        <Link
          to="/pms"
          className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-gray-500 hover:text-[#0F766E]"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to Project Details
        </Link>

        {/* Limited-access banner */}
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-2 flex items-start gap-2">
          <AlertCircle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
          <div className="text-[11px] text-amber-800">
            <span className="font-semibold">Limited view</span> — you are not assigned to this event.
            You can see the floorplan and chat while the event is running.
          </div>
        </div>

        {/* Basic header (read-only, no edit button) */}
        <div className="rounded-lg border border-[#DDE5E5] bg-white overflow-hidden">
          <div className="px-5 py-4 border-b border-[#F0F3F3]">
            <div className="flex items-center gap-1 text-[10px] font-mono text-gray-400">
              <Hash className="h-2.5 w-2.5 shrink-0" />
              <span className="truncate">{event.a42}</span>
            </div>
            <h1 className="text-2xl font-bold text-[#0A1F2E] mt-1 leading-tight">
              {calendarTitle(event)}
            </h1>
          </div>
          <div className="px-5 py-3 bg-[#FAFBFB] grid grid-cols-2 md:grid-cols-4 gap-3 text-[11px]">
            <div className="flex items-start gap-1.5">
              <CalIcon className="h-3 w-3 text-gray-400 mt-0.5 shrink-0" />
              <div>
                <div className={FIELD_LABEL}>Dates</div>
                <div className="text-[#0A1F2E] font-medium">{event.startDate} → {event.endDate}</div>
              </div>
            </div>
            <div className="flex items-start gap-1.5">
              <MapPin className="h-3 w-3 text-gray-400 mt-0.5 shrink-0" />
              <div>
                <div className={FIELD_LABEL}>Venue</div>
                <div className="text-[#0A1F2E] font-medium truncate">{event.venue}</div>
                <div className="text-[10px] text-gray-500">{event.state}</div>
              </div>
            </div>
            <div className="flex items-start gap-1.5">
              <Building2 className="h-3 w-3 text-gray-400 mt-0.5 shrink-0" />
              <div>
                <div className={FIELD_LABEL}>Booth</div>
                <div className="text-[#0A1F2E] font-medium">{event.boothNo}</div>
              </div>
            </div>
            <div className="flex items-start gap-1.5">
              <User className="h-3 w-3 text-gray-400 mt-0.5 shrink-0" />
              <div>
                <div className={FIELD_LABEL}>PIC</div>
                <div className="text-[#0A1F2E] font-medium">{event.pic ?? "—"}</div>
              </div>
            </div>
          </div>
        </div>

        {/* Floorplan section — view + upload */}
        <div className="rounded-lg border border-[#DDE5E5] bg-white overflow-hidden">
          <div className="px-4 py-2.5 border-b border-[#DDE5E5] bg-[#F4F7F7]">
            <h2 className="text-[12px] font-semibold uppercase tracking-wider text-[#0A1F2E]">Floorplan</h2>
            <p className="text-[10px] text-gray-500 mt-0.5">View or upload booth floorplan files</p>
          </div>
          <div className="px-5 py-4 space-y-2">
            <button
              type="button"
              onClick={() => setOpenAttach({ key: "floorplan", label: "Floorplan" })}
              className="w-full flex items-center justify-between px-3 py-2.5 rounded-md border border-[#DDE5E5] bg-white hover:border-[#0F766E] hover:bg-[#F4F7F7] transition"
            >
              <div className="flex items-center gap-2">
                <Paperclip className="h-4 w-4 text-[#0F766E]" />
                <span className="text-[12px] font-semibold text-[#0A1F2E]">Floorplan files</span>
              </div>
              <span className={`text-[10px] px-2 py-0.5 rounded font-semibold ${
                floorplanCount > 0 ? "bg-[#0F766E]/10 text-[#0F766E]" : "bg-gray-100 text-gray-500"
              }`}>
                {floorplanCount} file{floorplanCount === 1 ? "" : "s"}
              </span>
            </button>
            <button
              type="button"
              onClick={() => setOpenAttach({ key: "sendFloorplanToDesigner", label: "Send Floorplan to Designer" })}
              className="w-full flex items-center justify-between px-3 py-2.5 rounded-md border border-[#DDE5E5] bg-white hover:border-[#0F766E] hover:bg-[#F4F7F7] transition"
            >
              <div className="flex items-center gap-2">
                <Paperclip className="h-4 w-4 text-[#0F766E]" />
                <span className="text-[12px] font-semibold text-[#0A1F2E]">Designer-ready Floorplan</span>
              </div>
              <span className={`text-[10px] px-2 py-0.5 rounded font-semibold ${
                sendFpCount > 0 ? "bg-[#0F766E]/10 text-[#0F766E]" : "bg-gray-100 text-gray-500"
              }`}>
                {sendFpCount} file{sendFpCount === 1 ? "" : "s"}
              </span>
            </button>
          </div>
        </div>

        {/* Chat */}
        <EventChat
          eventA42={a42}
          eventTitle={calendarTitle(event)}
          eventStartDate={event.startDate}
          eventEndDate={event.endDate}
          assignedSales={event.assignedSales ?? []}
          eventStatus={event.progress}
          pic={event.pic}
        />

        {openAttach && (
          <WorkflowAttachmentDialog
            eventA42={a42}
            workflowKey={openAttach.key}
            label={openAttach.label}
            onClose={() => setOpenAttach(null)}
          />
        )}
      </div>
    );
  }

  const c = computeCosts(event);

  // workflow stats
  const doneCount = WORKFLOW_FIELDS.filter((f) => isDone(event[f.key] as WorkflowFlag)).length;
  const skippedCount = WORKFLOW_FIELDS.filter((f) => isSkipped(event[f.key] as WorkflowFlag)).length;
  const required = WORKFLOW_FIELDS.length - skippedCount;
  const donePct = required > 0 ? (doneCount / required) * 100 : 0;

  // group workflow by stage (Notion-style sections)
  const stages = Array.from(new Set(WORKFLOW_FIELDS.map((f) => f.stage)));

  function setFlag(key: keyof HouzsEvent, v: WorkflowFlag) {
    updateEvent(a42, { [key]: v });
  }

  function patchDraft<K extends keyof HouzsEvent>(k: K, v: HouzsEvent[K] | string) {
    setDraft((d) => ({ ...d, [k]: v }));
  }

  function toggleAssignedSales(id: string) {
    setDraft(d => {
      const current = d.assignedSales ?? [];
      return { ...d, assignedSales: current.includes(id) ? current.filter(x => x !== id) : [...current, id] };
    });
  }
  const [salesSearch, setSalesSearch] = useState("");

  function saveEdits() {
    // recompute durationDays from dates
    const patch: Partial<HouzsEvent> = { ...draft };
    if (draft.startDate && draft.endDate) {
      const s = new Date(draft.startDate);
      const en = new Date(draft.endDate);
      patch.durationDays = Math.max(1, Math.round((en.getTime() - s.getTime()) / 86400000) + 1);
    }
    // persist multi-driver/lori arrays
    patch.setupDrivers = draftDrivers;
    patch.setupLoris = draftLoris;
    updateEvent(a42, patch);
    setIsEditing(false);
  }

  function cancelEdits() {
    setIsEditing(false);
    setDraft({});
  }

  function onDelete() {
    deleteUserEvent(a42);
    navigate("/pms");
  }

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[1fr_280px] gap-4 max-w-[1400px]">
      {/* ═══════════════ MAIN COLUMN ═══════════════ */}
      <div className="space-y-4 min-w-0">
      {/* Back link */}
      <Link
        to="/pms"
        className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-gray-500 hover:text-[#0F766E]"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Back to Project Details
      </Link>

      {/* Header — calendar title format (view + edit) */}
      <div className="rounded-lg border border-[#DDE5E5] bg-white overflow-hidden">
        <div className="px-5 py-4 border-b border-[#F0F3F3]">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1 text-[10px] font-mono text-gray-400">
                <Hash className="h-2.5 w-2.5 shrink-0" />
                <span className="truncate">{event.a42}</span>
              </div>
              <h1 className="text-2xl font-bold text-[#0A1F2E] mt-1 leading-tight">
                {calendarTitle(event)}
              </h1>
            </div>
            <div className="flex flex-wrap gap-1.5 items-center shrink-0">
              {!isEditing && (
                <>
                  <span className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                    event.status === "CONFIRMED" ? "bg-[#0F766E] text-white" :
                    event.status === "PENDING"   ? "bg-amber-100 text-amber-700" :
                                                    "bg-red-100 text-red-700"}`}>
                    {event.status}
                  </span>
                  <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-[#0F766E]/10 text-[#0F766E]">
                    {event.brand}
                  </span>
                  <span className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                    event.eventType === "EXHIBITION" ? "bg-[#0A1F2E] text-white" : "bg-gray-100 text-gray-700"}`}>
                    {event.eventType}
                  </span>
                  <span className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                    event.progress === "COMPLETED"   ? "bg-blue-100 text-blue-700" :
                    event.progress === "IN PROGRESS" ? "bg-amber-100 text-amber-700" :
                                                        "bg-gray-100 text-gray-600"}`}>
                    {event.progress}
                  </span>
                </>
              )}
              {!isEditing ? (
                <button
                  type="button"
                  onClick={() => setIsEditing(true)}
                  className="h-8 px-2.5 rounded-md border border-[#DDE5E5] bg-white text-[11px] font-semibold text-gray-600 hover:border-[#0F766E] hover:text-[#0F766E] inline-flex items-center gap-1.5"
                >
                  <Pencil className="h-3 w-3" /> Edit
                </button>
              ) : (
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={cancelEdits}
                    className="h-8 px-2.5 rounded-md border border-[#DDE5E5] bg-white text-[11px] font-semibold text-gray-600 hover:bg-gray-50 inline-flex items-center gap-1"
                  >
                    <XIcon className="h-3 w-3" /> Cancel
                  </button>
                  <button
                    type="button"
                    onClick={saveEdits}
                    className="h-8 px-3 rounded-md bg-[#0F766E] text-white text-[11px] font-semibold hover:bg-[#0c5f59] inline-flex items-center gap-1"
                  >
                    <Check className="h-3 w-3" /> Save
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Metadata strip — view mode */}
        {!isEditing && (
          <div className="px-5 py-3 bg-[#FAFBFB] grid grid-cols-2 md:grid-cols-4 gap-3 text-[11px]">
            <div className="flex items-start gap-1.5">
              <CalIcon className="h-3 w-3 text-gray-400 mt-0.5 shrink-0" />
              <div>
                <div className={FIELD_LABEL}>Dates</div>
                <div className="text-[#0A1F2E] font-medium">{event.startDate} → {event.endDate}</div>
                <div className="text-[10px] text-gray-500">{event.durationDays} day{event.durationDays === 1 ? "" : "s"}</div>
              </div>
            </div>
            <div className="flex items-start gap-1.5">
              <MapPin className="h-3 w-3 text-gray-400 mt-0.5 shrink-0" />
              <div>
                <div className={FIELD_LABEL}>Location</div>
                <div className="text-[#0A1F2E] font-medium truncate">{event.venue}</div>
                <div className="text-[10px] text-gray-500">{event.state}</div>
              </div>
            </div>
            <div className="flex items-start gap-1.5">
              <Building2 className="h-3 w-3 text-gray-400 mt-0.5 shrink-0" />
              <div>
                <div className={FIELD_LABEL}>Booth</div>
                <div className="text-[#0A1F2E] font-medium">{event.boothNo}</div>
                <div className="text-[10px] text-gray-500">{event.sizeSqm} sqm · {event.contractor}</div>
              </div>
            </div>
            <div className="flex items-start gap-1.5">
              <User className="h-3 w-3 text-gray-400 mt-0.5 shrink-0" />
              <div>
                <div className={FIELD_LABEL}>Organizer</div>
                <div className="text-[#0A1F2E] font-medium">{event.organizer}</div>
                <div className="text-[10px] text-gray-500">{event.eventType}</div>
              </div>
            </div>
          </div>
        )}

        {/* Edit form */}
        {isEditing && (
          <div className="px-5 py-4 bg-[#FAFBFB] space-y-4">
            {/* Row 1: status / progress / brand / type */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div>
                <div className={FIELD_LABEL}>Status</div>
                <select
                  value={draft.status ?? ""}
                  onChange={(e) => patchDraft("status", e.target.value as EventStatus)}
                  className={FIELD_SELECT}
                >
                  {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <div className={FIELD_LABEL}>Progress</div>
                <select
                  value={draft.progress ?? ""}
                  onChange={(e) => patchDraft("progress", e.target.value as EventProgress)}
                  className={FIELD_SELECT}
                >
                  {PROGRESS_OPTIONS.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              <div>
                <div className={FIELD_LABEL}>Brand</div>
                <select
                  value={draft.brand ?? ""}
                  onChange={(e) => patchDraft("brand", e.target.value as Brand)}
                  className={FIELD_SELECT}
                >
                  {BRANDS.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              </div>
              <div>
                <div className={FIELD_LABEL}>Event Type</div>
                <select
                  value={draft.eventType ?? ""}
                  onChange={(e) => patchDraft("eventType", e.target.value as EventType)}
                  className={FIELD_SELECT}
                >
                  {TYPE_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
            </div>

            {/* Row 2: dates + state */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div>
                <div className={FIELD_LABEL}>Start Date</div>
                <input
                  type="date"
                  value={draft.startDate ?? ""}
                  onChange={(e) => patchDraft("startDate", e.target.value)}
                  className={FIELD_INPUT}
                />
              </div>
              <div>
                <div className={FIELD_LABEL}>End Date</div>
                <input
                  type="date"
                  value={draft.endDate ?? ""}
                  onChange={(e) => patchDraft("endDate", e.target.value)}
                  className={FIELD_INPUT}
                />
              </div>
              <div>
                <div className={FIELD_LABEL}>State</div>
                <select
                  value={draft.state ?? ""}
                  onChange={(e) => patchDraft("state", e.target.value as MalaysianState)}
                  className={FIELD_SELECT}
                >
                  {STATES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <div className={FIELD_LABEL}>Organizer</div>
                <Combo
                  value={draft.organizer ?? ""}
                  options={master.organizers}
                  onChange={(v) => patchDraft("organizer", v)}
                  onCreate={(v) => addOrganizer(v)}
                  placeholder="Organizer…"
                />
              </div>
            </div>

            {/* Row 3: venue + contractor + pic */}
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <div>
                <div className={FIELD_LABEL}>Venue</div>
                <Combo
                  value={draft.venue ?? ""}
                  options={master.venues.map((v) => v.name)}
                  onChange={(v) => patchDraft("venue", v)}
                  onCreate={(v) => addVenue(v, (draft.state ?? event.state) as MalaysianState)}
                  placeholder="Venue…"
                />
              </div>
              <div>
                <div className={FIELD_LABEL}>Contractor</div>
                <Combo
                  value={draft.contractor ?? ""}
                  options={master.contractors}
                  onChange={(v) => patchDraft("contractor", v)}
                  onCreate={(v) => addContractor(v)}
                  placeholder="Contractor…"
                />
              </div>
              <div>
                <div className={FIELD_LABEL}>PIC</div>
                <Combo
                  value={draft.pic ?? ""}
                  options={activeSalesMembers.map(m => m.name)}
                  onChange={(v) => patchDraft("pic", v)}
                  onCreate={(v) => addPic(v)}
                  placeholder="PIC…"
                />
              </div>
            </div>

            {/* Row 4: booth + size + sales + rental */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div>
                <div className={FIELD_LABEL}>Booth No</div>
                <input
                  type="text"
                  value={draft.boothNo ?? ""}
                  onChange={(e) => patchDraft("boothNo", e.target.value)}
                  placeholder="e.g. P1ExtB"
                  className={FIELD_INPUT}
                />
              </div>
              <div>
                <div className={FIELD_LABEL}>Size (sqm)</div>
                <input
                  type="number"
                  step="0.01"
                  value={draft.sizeSqm ?? 0}
                  onChange={(e) => patchDraft("sizeSqm", Number(e.target.value))}
                  className={FIELD_INPUT}
                />
              </div>
              <div>
                <div className={FIELD_LABEL}>Total Sales (RM)</div>
                <input
                  type="number"
                  step="0.01"
                  value={draft.totalSalesRm ?? 0}
                  onChange={(e) => patchDraft("totalSalesRm", Number(e.target.value))}
                  className={FIELD_INPUT}
                />
              </div>
              <div>
                <div className={FIELD_LABEL}>Rental (RM)</div>
                <input
                  type="number"
                  step="0.01"
                  value={draft.rentalRm ?? 0}
                  onChange={(e) => patchDraft("rentalRm", Number(e.target.value))}
                  className={FIELD_INPUT}
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Preparation Condition (stage) */}
      <div className="rounded-lg border border-[#DDE5E5] bg-white overflow-hidden">
        <div className="px-4 py-2.5 border-b border-[#DDE5E5] bg-[#F4F7F7]">
          <h2 className="text-[12px] font-semibold uppercase tracking-wider text-[#0A1F2E]">Project Stage</h2>
          <p className="text-[10px] text-gray-500 mt-0.5">Preparation pipeline status</p>
        </div>
        <div className="px-5 py-4">
          <div className={FIELD_LABEL}>Preparation Condition</div>
          {userIsAdmin ? (
            <select
              value={event.preparationCondition ?? ""}
              onChange={(e) => updateEvent(a42, { preparationCondition: (e.target.value || undefined) as PreparationCondition | undefined })}
              className={`${FIELD_SELECT} max-w-sm`}
            >
              <option value="">— Not set —</option>
              {PREPARATION_CONDITIONS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          ) : (
            <div className="text-[12px] font-semibold text-[#0A1F2E]">{event.preparationCondition ?? <span className="text-gray-300 font-normal">—</span>}</div>
          )}
        </div>
      </div>

      {/* Workflow (Notion-style stages) */}
      <div className="rounded-lg border border-[#DDE5E5] bg-white overflow-hidden">
        <div className="px-4 py-2.5 border-b border-[#DDE5E5] bg-[#F4F7F7] flex items-center justify-between gap-3">
          <div>
            <h2 className="text-[12px] font-semibold uppercase tracking-wider text-[#0A1F2E]">PM Workflow</h2>
            <p className="text-[10px] text-gray-500 mt-0.5">
              {doneCount}/{required} done{skippedCount > 0 ? ` · ${skippedCount} N/A` : ""}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-40 h-1.5 rounded-full bg-gray-200 overflow-hidden">
              <div
                className={`h-full transition-all ${donePct === 100 ? "bg-[#0F766E]" : "bg-amber-400"}`}
                style={{ width: `${donePct}%` }}
              />
            </div>
            <span className={`text-[11px] font-bold ${donePct === 100 ? "text-[#0F766E]" : "text-amber-600"}`}>
              {donePct.toFixed(0)}%
            </span>
          </div>
        </div>

        <div className="divide-y divide-[#F0F3F3]">
          {stages.map((stage) => {
            const fields = WORKFLOW_FIELDS.filter((f) => f.stage === stage);
            return (
              <div key={stage} className="px-5 py-3">
                <div className="text-[9px] font-semibold uppercase tracking-wider text-gray-400 mb-2">
                  {stage}
                </div>
                <div className="space-y-1.5">
                  {fields.map((f) => {
                    const v = event[f.key] as WorkflowFlag;
                    const keyStr = f.key as string;
                    const attachCount = countByKey[keyStr] ?? 0;
                    return (
                      <div key={keyStr} className="flex items-center justify-between gap-3 py-1">
                        <div className="flex items-center gap-2 min-w-0">
                          {isDone(v) ? (
                            <div className="h-4 w-4 rounded-full bg-[#0F766E] inline-flex items-center justify-center shrink-0">
                              <Check className="h-2.5 w-2.5 text-white" strokeWidth={3} />
                            </div>
                          ) : isSkipped(v) ? (
                            <div className="h-4 w-4 rounded-full bg-gray-200 inline-flex items-center justify-center shrink-0">
                              <Minus className="h-2.5 w-2.5 text-gray-500" />
                            </div>
                          ) : (
                            <div className="h-4 w-4 rounded-full border-2 border-amber-400 shrink-0" />
                          )}
                          <span className="text-[12px] text-[#0A1F2E] truncate">{f.label}</span>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={() => setOpenAttach({ key: keyStr, label: f.label })}
                            title={attachCount > 0 ? `${attachCount} file(s) — click to view` : "Upload files"}
                            className={`h-6 px-2 rounded border text-[10px] font-semibold inline-flex items-center gap-1 transition ${
                              attachCount > 0
                                ? "bg-[#0F766E]/10 text-[#0F766E] border-[#0F766E]/30 hover:bg-[#0F766E]/20"
                                : "bg-white text-gray-400 border-[#DDE5E5] hover:border-[#0F766E] hover:text-[#0F766E]"
                            }`}
                          >
                            <Paperclip className="h-3 w-3" />
                            {attachCount > 0 ? attachCount : ""}
                          </button>
                          <span className="w-px h-5 bg-[#F0F3F3] mx-0.5" />
                          {FLAG_OPTIONS.map((opt) => (
                            <button
                              key={opt.value || "empty"}
                              type="button"
                              onClick={() => setFlag(f.key, opt.value)}
                              className={`h-6 px-2 rounded border text-[9px] font-semibold transition ${
                                v === opt.value ? opt.color : "bg-white text-gray-400 border-[#DDE5E5] hover:border-[#0F766E]"
                              }`}
                            >
                              {opt.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Setup & Dismantle logistics */}
      <div className="rounded-lg border border-[#DDE5E5] bg-white overflow-hidden">
        <div className="px-4 py-2.5 border-b border-[#DDE5E5] bg-[#F4F7F7] flex items-center justify-between">
          <div>
            <h2 className="text-[12px] font-semibold uppercase tracking-wider text-[#0A1F2E]">Setup &amp; Dismantle</h2>
            <p className="text-[10px] text-gray-500 mt-0.5">Driver team, lorries, schedule</p>
          </div>
          {event.setupDismantleStatus && (
            <span className={`px-2 py-[2px] rounded text-[10px] font-semibold ${
              event.setupDismantleStatus === "DISMANTLE DONE" ? "bg-emerald-100 text-emerald-700" :
              event.setupDismantleStatus === "SETUP DONE"     ? "bg-sky-100 text-sky-700" :
              event.setupDismantleStatus === "PREPARED"       ? "bg-amber-100 text-amber-700" :
                                                                 "bg-gray-100 text-gray-500"
            }`}>{event.setupDismantleStatus}</span>
          )}
        </div>
        {!isEditing ? (
          <div className="px-5 py-4 space-y-4">
            {/* Schedule */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <div className={FIELD_LABEL}>Setup Time</div>
                <div className="text-[11px] text-[#0A1F2E] mt-0.5 tabular-nums">
                  {event.setupDatetime ? new Date(event.setupDatetime).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : <span className="text-gray-300">—</span>}
                </div>
              </div>
              <div>
                <div className={FIELD_LABEL}>Dismantle Time</div>
                <div className="text-[11px] text-[#0A1F2E] mt-0.5 tabular-nums">
                  {event.dismantleDatetime ? new Date(event.dismantleDatetime).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : <span className="text-gray-300">—</span>}
                </div>
              </div>
            </div>

            {/* Drivers (prefer new array; fall back to legacy string) */}
            <div>
              <div className={FIELD_LABEL}>Driver Team</div>
              {(event.setupDrivers && event.setupDrivers.length > 0) ? (
                <div className="flex flex-wrap gap-2 mt-1">
                  {event.setupDrivers.map((d) => (
                    <div key={d.id} className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#F4F7F7] border border-[#DDE5E5]">
                      <User className="h-3 w-3 text-[#0F766E]" />
                      <span className="text-[11px] font-semibold text-[#0A1F2E]">{d.name}</span>
                      {d.phone && <span className="text-[10px] text-gray-500">{d.phone}</span>}
                    </div>
                  ))}
                </div>
              ) : event.setupDriver ? (
                <div className="text-[12px] font-semibold text-[#0A1F2E] mt-0.5">{event.setupDriver}</div>
              ) : (
                <div className="text-[11px] text-gray-300 mt-0.5">— No drivers assigned —</div>
              )}
            </div>

            {/* Loris (prefer new array; fall back to legacy string) */}
            <div>
              <div className={FIELD_LABEL}>Lorry / Vehicle</div>
              {(event.setupLoris && event.setupLoris.length > 0) ? (
                <div className="flex flex-wrap gap-2 mt-1">
                  {event.setupLoris.map((plate) => (
                    <div key={plate} className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#F4F7F7] border border-[#DDE5E5]">
                      <Truck className="h-3 w-3 text-[#0F766E]" />
                      <span className="text-[11px] font-semibold text-[#0A1F2E] tabular-nums">{plate}</span>
                    </div>
                  ))}
                </div>
              ) : event.setupLori ? (
                <div className="text-[12px] font-semibold text-[#0A1F2E] mt-0.5 tabular-nums">{event.setupLori}</div>
              ) : (
                <div className="text-[11px] text-gray-300 mt-0.5">— No lorry assigned —</div>
              )}
            </div>
          </div>
        ) : (
          <div className="px-5 py-4 space-y-4">
            {/* Schedule */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div>
                <div className={FIELD_LABEL}>Setup Time</div>
                <input
                  type="datetime-local"
                  value={draft.setupDatetime ?? ""}
                  onChange={(e) => patchDraft("setupDatetime", e.target.value)}
                  className={FIELD_INPUT}
                />
              </div>
              <div>
                <div className={FIELD_LABEL}>Dismantle Time</div>
                <input
                  type="datetime-local"
                  value={draft.dismantleDatetime ?? ""}
                  onChange={(e) => patchDraft("dismantleDatetime", e.target.value)}
                  className={FIELD_INPUT}
                />
              </div>
              <div>
                <div className={FIELD_LABEL}>Setup/Dismantle Status</div>
                <select
                  value={draft.setupDismantleStatus ?? ""}
                  onChange={(e) => patchDraft("setupDismantleStatus", e.target.value as HouzsEvent["setupDismantleStatus"])}
                  className={FIELD_SELECT}
                >
                  {SD_STATUSES.map((s) => <option key={s || "none"} value={s}>{s || "—"}</option>)}
                </select>
              </div>
            </div>

            {/* Multi-driver */}
            <div>
              <div className={FIELD_LABEL}>Driver Team</div>
              <div className="space-y-1.5 mt-1">
                {draftDrivers.map((d) => (
                  <div key={d.id} className="flex items-center gap-2 px-3 py-1.5 rounded-md border border-[#DDE5E5] bg-[#FAFBFB]">
                    <User className="h-3 w-3 text-[#0F766E] shrink-0" />
                    <span className="text-[11px] font-semibold text-[#0A1F2E] flex-1">{d.name}</span>
                    {d.phone && <span className="text-[10px] text-gray-500">{d.phone}</span>}
                    <button type="button" onClick={() => setDraftDrivers(prev => prev.filter(x => x.id !== d.id))}
                      className="h-5 w-5 rounded inline-flex items-center justify-center text-gray-400 hover:text-red-600 hover:bg-red-50">
                      <XIcon className="h-3 w-3" />
                    </button>
                  </div>
                ))}
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newDriverName}
                    onChange={(e) => setNewDriverName(e.target.value)}
                    placeholder="Driver name…"
                    className={`${FIELD_INPUT} flex-1`}
                  />
                  <input
                    type="text"
                    value={newDriverPhone}
                    onChange={(e) => setNewDriverPhone(e.target.value)}
                    placeholder="Phone…"
                    className={`${FIELD_INPUT} flex-1`}
                  />
                  <button
                    type="button"
                    disabled={!newDriverName.trim()}
                    onClick={() => {
                      if (!newDriverName.trim()) return;
                      setDraftDrivers(prev => [...prev, { id: crypto.randomUUID(), name: newDriverName.trim().toUpperCase(), phone: newDriverPhone.trim() }]);
                      setNewDriverName("");
                      setNewDriverPhone("");
                    }}
                    className="h-8 px-2.5 rounded-md bg-[#0F766E] text-white text-[11px] font-semibold disabled:opacity-40 inline-flex items-center gap-1"
                  >
                    <Plus className="h-3 w-3" /> Add
                  </button>
                </div>
              </div>
            </div>

            {/* Multi-lori */}
            <div>
              <div className={FIELD_LABEL}>Lorry / Vehicle</div>
              <div className="space-y-1.5 mt-1">
                {draftLoris.map((plate) => (
                  <div key={plate} className="flex items-center gap-2 px-3 py-1.5 rounded-md border border-[#DDE5E5] bg-[#FAFBFB]">
                    <Truck className="h-3 w-3 text-[#0F766E] shrink-0" />
                    <span className="text-[11px] font-semibold text-[#0A1F2E] tabular-nums flex-1">{plate}</span>
                    <button type="button" onClick={() => setDraftLoris(prev => prev.filter(x => x !== plate))}
                      className="h-5 w-5 rounded inline-flex items-center justify-center text-gray-400 hover:text-red-600 hover:bg-red-50">
                      <XIcon className="h-3 w-3" />
                    </button>
                  </div>
                ))}
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newLoriPlate}
                    onChange={(e) => setNewLoriPlate(e.target.value)}
                    placeholder="Plate number e.g. NCN 6553…"
                    className={`${FIELD_INPUT} flex-1`}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && newLoriPlate.trim()) {
                        const plate = newLoriPlate.trim().toUpperCase();
                        if (!draftLoris.includes(plate)) setDraftLoris(prev => [...prev, plate]);
                        setNewLoriPlate("");
                      }
                    }}
                  />
                  <button
                    type="button"
                    disabled={!newLoriPlate.trim()}
                    onClick={() => {
                      if (!newLoriPlate.trim()) return;
                      const plate = newLoriPlate.trim().toUpperCase();
                      if (!draftLoris.includes(plate)) setDraftLoris(prev => [...prev, plate]);
                      setNewLoriPlate("");
                    }}
                    className="h-8 px-2.5 rounded-md bg-[#0F766E] text-white text-[11px] font-semibold disabled:opacity-40 inline-flex items-center gap-1"
                  >
                    <Plus className="h-3 w-3" /> Add
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Assigned Sales moved to right sidebar — no separate card here */}

      {/* ─────── BOOTH LAYOUT & SETUP ─────────────────────────── */}
      <BoothDocSection
        title="BOOTH LAYOUT & SETUP"
        subtitle="Stock transfer records and 2D display layout (Floorplan / 3D already in PM Workflow)"
        docTypes={BOOTH_LAYOUT_DOCS}
        boothDocs={boothDocs}
        eventA42={a42}
        currentUser={currentUser}
        hasFullAccess={hasFullAccess}
        onOpenDoc={setOpenBoothDoc}
        onOpenAttach={setOpenAttach}
        allPhotos={allPhotos}
      />

      {/* ─────── SETUP & DISMANTLE DOCUMENTS ─────────────────── */}
      <BoothDocSection
        title="SETUP & DISMANTLE DOCUMENTS"
        subtitle="On-site documentation during setup and dismantle phases"
        docTypes={SETUP_DISMANTLE_DOCS}
        boothDocs={boothDocs}
        eventA42={a42}
        currentUser={currentUser}
        hasFullAccess={hasFullAccess}
        onOpenDoc={setOpenBoothDoc}
        onOpenAttach={setOpenAttach}
        allPhotos={allPhotos}
      />

      {/* ─────── EXPO MAP — COMPETITOR RESEARCH ──────────────── */}
      <ExpoMapSection
        eventA42={a42}
        boothDocs={boothDocs}
        competitors={competitors}
        currentUser={currentUser}
        hasFullAccess={hasFullAccess}
        onOpenAttach={setOpenAttach}
        onOpenCompetitorForm={setOpenCompetitorForm}
        allPhotos={allPhotos}
      />

      {/* Event Chat */}
      <EventChat
        eventA42={a42}
        eventTitle={calendarTitle(event)}
        eventStartDate={event.startDate}
        eventEndDate={event.endDate}
        assignedSales={event.assignedSales ?? []}
        eventStatus={event.progress}
        pic={event.pic}
        currentUserId={currentUser?.id ?? "dir-kingsley"}
      />

      {/* Financial snapshot — directors only */}
      {userIsAdmin && <div className="rounded-lg border border-[#DDE5E5] bg-white overflow-hidden">
        <div className="px-4 py-2.5 border-b border-[#DDE5E5] bg-[#F4F7F7]">
          <h2 className="text-[12px] font-semibold uppercase tracking-wider text-[#0A1F2E]">Financial Snapshot</h2>
          <p className="text-[10px] text-gray-500 mt-0.5">
            From Exhibition Report cost model · Sales − COGS = GP · Sales − all costs = Net Profit
          </p>
        </div>

        <div className="px-5 py-4 grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <div className="text-[9px] font-semibold uppercase tracking-wider text-gray-400">Total Sales</div>
            <div className="text-[16px] font-bold text-[#0A1F2E] mt-0.5">{fmtRM(event.totalSalesRm)}</div>
            <div className="text-[9px] text-gray-500 mt-0.5">{fmtRM(c.salesPerDay)} / day</div>
          </div>
          <div>
            <div className="text-[9px] font-semibold uppercase tracking-wider text-gray-400">Gross Profit</div>
            <div className={`text-[16px] font-bold mt-0.5 ${c.grossProfit >= 0 ? "text-[#0F766E]" : "text-red-600"}`}>
              {fmtRM(c.grossProfit)}
            </div>
            <div className="text-[9px] text-gray-500 mt-0.5">{fmtPct(c.grossProfitPct)} after COGS</div>
          </div>
          <div>
            <div className="text-[9px] font-semibold uppercase tracking-wider text-gray-400">Total Cost</div>
            <div className="text-[16px] font-bold text-[#0A1F2E] mt-0.5">{fmtRM(c.totalCost)}</div>
            <div className="text-[9px] text-gray-500 mt-0.5">All cost lines</div>
          </div>
          <div>
            <div className="text-[9px] font-semibold uppercase tracking-wider text-gray-400">Net Profit</div>
            <div className={`text-[16px] font-bold mt-0.5 ${c.netProfit >= 0 ? "text-[#0F766E]" : "text-red-600"}`}>
              {fmtRM(c.netProfit)}
            </div>
            <div className="text-[9px] text-gray-500 mt-0.5">{fmtPct(c.netProfitPct)} bottom line</div>
          </div>
        </div>

        <div className="px-5 pb-4">
          <div className="rounded-md border border-[#DDE5E5] overflow-hidden">
            <table className="w-full text-[11px]">
              <tbody className="divide-y divide-[#F0F3F3]">
                <tr>
                  <td className="px-3 py-1.5 text-gray-500">COGS — Matt/Sofa</td>
                  <td className="px-3 py-1.5 text-right font-mono text-[#0A1F2E]">{fmtRM(c.cogsMattSofa)}</td>
                </tr>
                <tr>
                  <td className="px-3 py-1.5 text-gray-500">COGS — Bedframe</td>
                  <td className="px-3 py-1.5 text-right font-mono text-[#0A1F2E]">{fmtRM(c.cogsBedframe)}</td>
                </tr>
                <tr>
                  <td className="px-3 py-1.5 text-gray-500">COGS — Accessories</td>
                  <td className="px-3 py-1.5 text-right font-mono text-[#0A1F2E]">{fmtRM(c.cogsAcc)}</td>
                </tr>
                <tr className="bg-[#FAFBFB]">
                  <td className="px-3 py-1.5 font-semibold text-[#0A1F2E]">COGS Total</td>
                  <td className="px-3 py-1.5 text-right font-mono font-semibold text-[#0A1F2E]">{fmtRM(c.cogsTotal)}</td>
                </tr>
                <tr>
                  <td className="px-3 py-1.5 text-gray-500">
                    Rental
                    <span className="text-[9px] text-gray-400 ml-1">({fmtRM(c.rentalPerSqmPerDay)}/sqm/day)</span>
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-[#0A1F2E]">{fmtRM(c.rental)}</td>
                </tr>
                <tr>
                  <td className="px-3 py-1.5 text-gray-500">Setup</td>
                  <td className="px-3 py-1.5 text-right font-mono text-[#0A1F2E]">{fmtRM(c.setup)}</td>
                </tr>
                <tr>
                  <td className="px-3 py-1.5 text-gray-500">Transport Fee</td>
                  <td className="px-3 py-1.5 text-right font-mono text-[#0A1F2E]">{fmtRM(c.transportFee)}</td>
                </tr>
                <tr>
                  <td className="px-3 py-1.5 text-gray-500">Transport Setup &amp; Dismantle</td>
                  <td className="px-3 py-1.5 text-right font-mono text-[#0A1F2E]">{fmtRM(c.transportSetupDismantle)}</td>
                </tr>
                <tr>
                  <td className="px-3 py-1.5 text-gray-500">Commission</td>
                  <td className="px-3 py-1.5 text-right font-mono text-[#0A1F2E]">{fmtRM(c.commission)}</td>
                </tr>
                <tr>
                  <td className="px-3 py-1.5 text-gray-500">Merchandise</td>
                  <td className="px-3 py-1.5 text-right font-mono text-[#0A1F2E]">{fmtRM(c.merch)}</td>
                </tr>
                <tr>
                  <td className="px-3 py-1.5 text-gray-500">Others Costing</td>
                  <td className="px-3 py-1.5 text-right font-mono text-[#0A1F2E]">{fmtRM(c.othersCosting)}</td>
                </tr>
                <tr className="bg-[#FAFBFB]">
                  <td className="px-3 py-2 font-semibold text-[#0A1F2E]">Total Cost</td>
                  <td className="px-3 py-2 text-right font-mono font-semibold text-[#0A1F2E]">{fmtRM(c.totalCost)}</td>
                </tr>
                <tr className="bg-[#0F766E]/5">
                  <td className="px-3 py-2 font-semibold text-[#0A1F2E]">Net Profit</td>
                  <td className={`px-3 py-2 text-right font-mono font-bold ${c.netProfit >= 0 ? "text-[#0F766E]" : "text-red-600"}`}>
                    {fmtRM(c.netProfit)} <span className="text-[9px] font-normal">({fmtPct(c.netProfitPct)})</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>}

      {/* Integration + actions */}
      <div className="rounded-lg border border-[#DDE5E5] bg-white overflow-hidden">
        <div className="px-4 py-2.5 border-b border-[#DDE5E5] bg-[#F4F7F7]">
          <h2 className="text-[12px] font-semibold uppercase tracking-wider text-[#0A1F2E]">Integrations</h2>
        </div>
        <div className="px-5 py-3 flex flex-wrap gap-3 text-[11px]">
          {event.linkNotion ? (
            <a href={event.linkNotion} target="_blank" rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-[#0F766E] hover:underline">
              <ExternalLink className="h-3 w-3" /> Notion page
            </a>
          ) : (
            <span className="text-gray-400">No Notion link</span>
          )}
          {event.gcalId ? (
            <span className="text-gray-500 font-mono">GCal: {event.gcalId}</span>
          ) : (
            <span className="text-gray-400">No Google Calendar ID</span>
          )}
        </div>
      </div>

      {/* Danger zone */}
      <div className="rounded-lg border border-[#DDE5E5] bg-white overflow-hidden">
        <div className="px-4 py-2.5 border-b border-[#DDE5E5] bg-[#F4F7F7]">
          <h2 className="text-[12px] font-semibold uppercase tracking-wider text-[#0A1F2E]">Actions</h2>
        </div>
        <div className="px-5 py-3 flex items-center justify-between gap-3">
          <div className="text-[10px] text-gray-500">
            Note: mock/seeded events cannot be fully deleted — only user-created events are removable.
          </div>
          {!confirmDelete ? (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="h-8 px-3 rounded-md border border-red-200 bg-white text-[11px] font-semibold text-red-600 hover:bg-red-50 inline-flex items-center gap-1.5"
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete event
            </button>
          ) : (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="h-8 px-3 rounded-md border border-[#DDE5E5] bg-white text-[11px] font-semibold text-gray-600"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onDelete}
                className="h-8 px-3 rounded-md bg-red-600 text-white text-[11px] font-semibold hover:bg-red-700"
              >
                Yes, delete
              </button>
            </div>
          )}
        </div>
      </div>

      </div>
      {/* ═══════════════ END MAIN COLUMN ═══════════════ */}

      {/* ═══════════════ RIGHT SIDEBAR ═══════════════ */}
      <aside className="space-y-4 xl:sticky xl:top-4 xl:self-start">
        {/* Sales PIC + Attendance */}
        <div className="rounded-lg border border-[#DDE5E5] bg-white overflow-hidden">
          <div className="px-4 py-2.5 border-b border-[#DDE5E5] bg-[#F4F7F7]">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-[#0A1F2E]">Sales Team</h2>
          </div>
          <div className="px-4 py-3 space-y-3">
            <div>
              <div className={FIELD_LABEL}>Sales PIC</div>
              {userIsAdmin ? (
                <Combo
                  value={event.salesPic ?? event.pic ?? ""}
                  options={activeSalesMembers.map((m) => m.name)}
                  onChange={(v) => updateEvent(a42, { salesPic: v || undefined })}
                  onCreate={(v) => { addPic(v); updateEvent(a42, { salesPic: v }); }}
                  placeholder="Sales PIC…"
                />
              ) : (
                <div className="text-[12px] font-semibold text-[#0A1F2E]">{event.salesPic ?? event.pic ?? <span className="text-gray-300 font-normal">—</span>}</div>
              )}
            </div>
            <div>
              <div className="flex items-center justify-between">
                <div className={FIELD_LABEL}>Sales Attendance</div>
                {userIsAdmin && (
                  <button
                    type="button"
                    onClick={() => setAttendanceEdit((v) => !v)}
                    className="text-[9px] font-semibold text-gray-400 hover:text-[#0F766E] uppercase tracking-wider"
                  >
                    {attendanceEdit ? "Done" : "Edit"}
                  </button>
                )}
              </div>
              {!attendanceEdit ? (
                <div className="flex flex-wrap gap-1 mt-1">
                  {(event.assignedSales ?? []).length === 0 ? (
                    <span className="text-[11px] text-gray-300">— No sales assigned —</span>
                  ) : (
                    (event.assignedSales ?? []).map((id) => {
                      const m = salesMembers.find((x) => x.id === id);
                      return m ? (
                        <span key={id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#0F766E]/10 text-[#0F766E] text-[10px] font-semibold">
                          <User className="h-2.5 w-2.5" />{m.name}
                        </span>
                      ) : null;
                    })
                  )}
                </div>
              ) : (
                <div className="mt-1 rounded-md border border-[#DDE5E5] overflow-hidden">
                  <div className="px-2 py-1 border-b border-[#F0F3F3] bg-[#FAFBFB]">
                    <input
                      type="text"
                      value={attendanceSearch}
                      onChange={(e) => setAttendanceSearch(e.target.value)}
                      placeholder="Search…"
                      className="w-full h-5 text-[10px] bg-transparent outline-none placeholder:text-gray-400"
                    />
                  </div>
                  <div className="max-h-[260px] overflow-y-auto divide-y divide-[#F0F3F3]">
                    {activeSalesMembers
                      .filter((m) => !attendanceSearch.trim() || m.name.toUpperCase().includes(attendanceSearch.trim().toUpperCase()))
                      .map((m) => {
                        const checked = (event.assignedSales ?? []).includes(m.id);
                        return (
                          <label key={m.id} className="flex items-center gap-1.5 px-2 py-1 hover:bg-[#FAFBFB] cursor-pointer">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleAttendance(m.id)}
                              className="h-3 w-3 rounded border-gray-300 text-[#0F766E] focus:ring-[#0F766E]"
                            />
                            <span className="text-[10px] font-semibold text-[#0A1F2E]">{m.name}</span>
                          </label>
                        );
                      })}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </aside>

      {/* Modals rendered at grid root so they overlay properly */}
      {openAttach && (
        <WorkflowAttachmentDialog
          eventA42={a42}
          workflowKey={openAttach.key}
          label={openAttach.label}
          onClose={() => setOpenAttach(null)}
        />
      )}

      {openBoothDoc && (
        <BoothDocModal
          doc={openBoothDoc}
          eventA42={a42}
          currentUser={currentUser}
          hasFullAccess={hasFullAccess}
          allPhotos={allPhotos}
          approvalNotesDraft={approvalNotesDraft}
          onApprovalNotesChange={setApprovalNotesDraft}
          onClose={() => { setOpenBoothDoc(null); setApprovalNotesDraft(""); }}
          onOpenAttach={setOpenAttach}
        />
      )}

      {openCompetitorForm && (
        <CompetitorFormModal
          eventA42={a42}
          entry={openCompetitorForm === "new" ? null : openCompetitorForm}
          currentUser={currentUser}
          hasFullAccess={hasFullAccess}
          allPhotos={allPhotos}
          onOpenAttach={setOpenAttach}
          onClose={() => setOpenCompetitorForm(null)}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components (defined after default export to keep main function readable)
// ─────────────────────────────────────────────────────────────────────────────

// ── Approval badge ────────────────────────────────────────────────────────────

function ApprovalBadge({ status }: { status: ApprovalStatus }) {
  if (status === "APPROVED") return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#0F766E]/10 text-[#0F766E] text-[9px] font-semibold">
      <ShieldCheck className="h-2.5 w-2.5" /> APPROVED
    </span>
  );
  if (status === "REJECTED") return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-100 text-red-700 text-[9px] font-semibold">
      <XIcon className="h-2.5 w-2.5" /> REJECTED
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 text-[9px] font-semibold">
      <AlertCircle className="h-2.5 w-2.5" /> PENDING
    </span>
  );
}

// ── BoothDocSection ───────────────────────────────────────────────────────────

function BoothDocSection({
  title, subtitle, docTypes, boothDocs, eventA42,
  currentUser, hasFullAccess, onOpenDoc, onOpenAttach, allPhotos,
}: {
  title: string;
  subtitle: string;
  docTypes: BoothDocType[];
  boothDocs: BoothDoc[];
  eventA42: string;
  currentUser: SalesMember | null;
  hasFullAccess: boolean;
  onOpenDoc: (doc: BoothDoc) => void;
  onOpenAttach: (a: { key: string; label: string }) => void;
  allPhotos: PhotoRecord[];
}) {
  // Count photos per doc id
  const photoCounts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const p of allPhotos) {
      if (p.workflowKey?.startsWith("booth:")) {
        const docId = p.workflowKey.slice(6);
        map[docId] = (map[docId] ?? 0) + 1;
      }
    }
    return map;
  }, [allPhotos]);

  function getOrCreate(type: BoothDocType): BoothDoc | undefined {
    return boothDocs.find((d) => d.type === type);
  }

  function handleAddDoc(type: BoothDocType) {
    if (!currentUser) return;
    const doc = createBoothDoc(eventA42, type, currentUser.id, currentUser.name);
    onOpenDoc(doc);
  }

  return (
    <div className="rounded-lg border border-[#DDE5E5] bg-white overflow-hidden">
      <div className="px-4 py-2.5 border-b border-[#DDE5E5] bg-[#F4F7F7]">
        <h2 className="text-[12px] font-semibold uppercase tracking-wider text-[#0A1F2E]">{title}</h2>
        <p className="text-[10px] text-gray-500 mt-0.5">{subtitle}</p>
      </div>

      {!hasFullAccess && (
        <div className="px-4 py-2 flex items-center gap-2 bg-amber-50 border-b border-amber-100">
          <AlertCircle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
          <span className="text-[10px] text-amber-800">Read-only — you are not assigned to this event</span>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="bg-[#F4F7F7] text-[10px] font-semibold uppercase tracking-wider text-gray-500">
              <th className="text-left px-4 py-2 whitespace-nowrap">Document</th>
              <th className="text-left px-3 py-2 whitespace-nowrap">Remarks</th>
              <th className="text-center px-3 py-2 whitespace-nowrap">Files</th>
              <th className="text-left px-3 py-2 whitespace-nowrap">Uploaded by</th>
              <th className="text-left px-3 py-2 whitespace-nowrap">Approval</th>
              <th className="text-center px-3 py-2 whitespace-nowrap">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#F0F3F3]">
            {docTypes.map((type) => {
              const doc = getOrCreate(type);
              const fileCount = doc ? (photoCounts[doc.id] ?? 0) : 0;
              return (
                <tr key={type} className="hover:bg-[#FAFBFB] transition-colors">
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <FileText className="h-3.5 w-3.5 text-gray-400 shrink-0" />
                      <span className="font-medium text-[#0A1F2E]">{BOOTH_DOC_LABELS[type]}</span>
                      {(() => {
                        const pos = BOOTH_DOC_POSITION[type];
                        const color =
                          pos === "Driver" ? "bg-blue-100 text-blue-700 border-blue-200" :
                          pos === "Sales"  ? "bg-[#0F766E]/10 text-[#0F766E] border-[#0F766E]/30" :
                          pos === "PC"     ? "bg-purple-100 text-purple-700 border-purple-200" :
                                             "bg-gray-100 text-gray-600 border-gray-200";
                        return (
                          <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[9px] font-semibold uppercase tracking-wider ${color}`}>
                            {pos}
                          </span>
                        );
                      })()}
                      {BOOTH_DOC_HINTS[type] && (
                        <span className="text-[9px] text-gray-400 italic">· {BOOTH_DOC_HINTS[type]}</span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-gray-500 max-w-[140px]">
                    <span className="truncate block">{doc?.remarks || <span className="text-gray-300">—</span>}</span>
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    {doc ? (
                      <button
                        type="button"
                        onClick={() => onOpenAttach({ key: `booth:${doc.id}`, label: BOOTH_DOC_LABELS[type] })}
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] font-semibold transition ${
                          fileCount > 0
                            ? "bg-[#0F766E]/10 text-[#0F766E] border-[#0F766E]/30 hover:bg-[#0F766E]/20"
                            : "bg-white text-gray-400 border-[#DDE5E5] hover:border-[#0F766E] hover:text-[#0F766E]"
                        }`}
                      >
                        <Paperclip className="h-2.5 w-2.5" />
                        {fileCount > 0 ? fileCount : "0"}
                      </button>
                    ) : <span className="text-gray-300 text-[10px]">—</span>}
                  </td>
                  <td className="px-3 py-2.5 text-gray-500">
                    {doc ? (
                      <div>
                        <div className="font-medium text-[#0A1F2E]">{doc.uploadedByName}</div>
                        <div className="text-[9px] text-gray-400">
                          {new Date(doc.uploadedAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })}
                        </div>
                      </div>
                    ) : <span className="text-gray-300">—</span>}
                  </td>
                  <td className="px-3 py-2.5">
                    {doc ? <ApprovalBadge status={doc.approvalStatus} /> : <span className="text-gray-300 text-[10px]">—</span>}
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    {doc ? (
                      <button
                        type="button"
                        onClick={() => onOpenDoc(doc)}
                        className="h-6 px-2 rounded border border-[#DDE5E5] text-[10px] font-semibold text-gray-600 hover:border-[#0F766E] hover:text-[#0F766E] transition"
                      >
                        View
                      </button>
                    ) : hasFullAccess ? (
                      <button
                        type="button"
                        onClick={() => handleAddDoc(type)}
                        className="inline-flex items-center gap-0.5 h-6 px-2 rounded border border-dashed border-[#DDE5E5] text-[10px] font-semibold text-gray-400 hover:border-[#0F766E] hover:text-[#0F766E] transition"
                      >
                        <Plus className="h-3 w-3" /> Add
                      </button>
                    ) : (
                      <span className="text-gray-300 text-[10px]">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── BoothDocModal ─────────────────────────────────────────────────────────────

function BoothDocModal({
  doc, eventA42, currentUser, hasFullAccess, allPhotos,
  approvalNotesDraft, onApprovalNotesChange, onClose, onOpenAttach,
}: {
  doc: BoothDoc;
  eventA42: string;
  currentUser: SalesMember | null;
  hasFullAccess: boolean;
  allPhotos: PhotoRecord[];
  approvalNotesDraft: string;
  onApprovalNotesChange: (v: string) => void;
  onClose: () => void;
  onOpenAttach: (a: { key: string; label: string }) => void;
}) {
  const [remarks, setRemarks] = useState(doc.remarks ?? "");
  const [saving, setSaving] = useState(false);
  const fileCount = useMemo(() =>
    allPhotos.filter((p) => p.workflowKey === `booth:${doc.id}`).length,
    [allPhotos, doc.id]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function saveRemarks() {
    setSaving(true);
    updateBoothDoc(doc.id, { remarks });
    setTimeout(() => setSaving(false), 400);
  }

  function handleApproval(status: ApprovalStatus) {
    if (!currentUser) return;
    setApproval(doc.id, status, currentUser.id, currentUser.name, approvalNotesDraft.trim() || undefined);
    onApprovalNotesChange("");
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-3 border-b border-[#DDE5E5] bg-[#F4F7F7] flex items-start justify-between gap-3 shrink-0">
          <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Booth Document</div>
            <h3 className="text-[14px] font-bold text-[#0A1F2E] truncate">{BOOTH_DOC_LABELS[doc.type]}</h3>
            <div className="mt-1"><ApprovalBadge status={doc.approvalStatus} /></div>
          </div>
          <button type="button" onClick={onClose}
            className="h-8 w-8 rounded inline-flex items-center justify-center text-gray-400 hover:text-[#0A1F2E] hover:bg-gray-100 shrink-0">
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4 flex-1">
          {/* Remarks */}
          <div>
            <label className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 block mb-1">Remarks</label>
            {hasFullAccess ? (
              <div className="flex gap-2">
                <input
                  type="text"
                  value={remarks}
                  onChange={(e) => setRemarks(e.target.value)}
                  placeholder="e.g. Booth B34"
                  className="flex-1 h-8 rounded-md border border-[#DDE5E5] px-2 text-[11px] bg-white focus:outline-none focus:ring-2 focus:ring-[#0F766E]/30 focus:border-[#0F766E]"
                />
                <button type="button" onClick={saveRemarks} disabled={saving}
                  className="h-8 px-3 rounded-md bg-[#0F766E] text-white text-[11px] font-semibold hover:bg-[#0c5f59] disabled:opacity-50">
                  {saving ? "Saved" : "Save"}
                </button>
              </div>
            ) : (
              <div className="text-[11px] text-[#0A1F2E]">{doc.remarks || <span className="text-gray-300">—</span>}</div>
            )}
          </div>

          {/* Files */}
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-2">Files</div>
            <button
              type="button"
              onClick={() => onOpenAttach({ key: `booth:${doc.id}`, label: BOOTH_DOC_LABELS[doc.type] })}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-md border transition ${
                fileCount > 0
                  ? "border-[#0F766E]/30 bg-[#0F766E]/5 hover:bg-[#0F766E]/10"
                  : "border-dashed border-[#DDE5E5] hover:border-[#0F766E] hover:bg-[#F4F7F7]"
              }`}
            >
              <div className="flex items-center gap-2">
                <Paperclip className="h-4 w-4 text-[#0F766E]" />
                <span className="text-[12px] font-semibold text-[#0A1F2E]">
                  {fileCount > 0 ? `${fileCount} file${fileCount === 1 ? "" : "s"} attached` : "Upload files"}
                </span>
              </div>
              {hasFullAccess && <Plus className="h-4 w-4 text-gray-400" />}
            </button>
          </div>

          {/* Approval (only for full access users) */}
          {hasFullAccess && (
            <div className="border-t border-[#F0F3F3] pt-4">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-2">Approval</div>
              {doc.approvedByName && (
                <div className="text-[10px] text-gray-500 mb-2">
                  {doc.approvalStatus} by {doc.approvedByName}
                  {doc.approvedAt && ` · ${new Date(doc.approvedAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })}`}
                  {doc.approvalNotes && <div className="italic mt-0.5">"{doc.approvalNotes}"</div>}
                </div>
              )}
              <textarea
                value={approvalNotesDraft}
                onChange={(e) => onApprovalNotesChange(e.target.value)}
                placeholder="Approval notes (optional)…"
                rows={2}
                className="w-full rounded-md border border-[#DDE5E5] px-2 py-1.5 text-[11px] bg-white focus:outline-none focus:ring-2 focus:ring-[#0F766E]/30 focus:border-[#0F766E] resize-y mb-2"
              />
              <div className="flex gap-2">
                <button type="button" onClick={() => handleApproval("APPROVED")}
                  className="flex-1 h-8 rounded-md bg-[#0F766E] text-white text-[11px] font-semibold hover:bg-[#0c5f59] inline-flex items-center justify-center gap-1">
                  <Check className="h-3.5 w-3.5" /> Approve
                </button>
                <button type="button" onClick={() => handleApproval("REJECTED")}
                  className="flex-1 h-8 rounded-md border border-red-200 bg-white text-red-600 text-[11px] font-semibold hover:bg-red-50 inline-flex items-center justify-center gap-1">
                  <XIcon className="h-3.5 w-3.5" /> Reject
                </button>
                <button type="button" onClick={() => handleApproval("PENDING")}
                  className="h-8 px-3 rounded-md border border-[#DDE5E5] bg-white text-[11px] font-semibold text-gray-500 hover:bg-gray-50">
                  Reset
                </button>
              </div>
            </div>
          )}

          {/* Delete */}
          {hasFullAccess && (
            <div className="border-t border-[#F0F3F3] pt-3">
              <button type="button"
                onClick={() => { deleteBoothDoc(doc.id); onClose(); }}
                className="text-[10px] text-red-400 hover:text-red-600 hover:underline">
                Delete this document record
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── ExpoMapSection ────────────────────────────────────────────────────────────

function ExpoMapSection({
  eventA42, boothDocs, competitors, currentUser, hasFullAccess,
  onOpenAttach, onOpenCompetitorForm, allPhotos,
}: {
  eventA42: string;
  boothDocs: BoothDoc[];
  competitors: CompetitorEntry[];
  currentUser: SalesMember | null;
  hasFullAccess: boolean;
  onOpenAttach: (a: { key: string; label: string }) => void;
  onOpenCompetitorForm: (e: CompetitorEntry | "new") => void;
  allPhotos: PhotoRecord[];
}) {
  const blankDoc = boothDocs.find((d) => d.type === "EXPO_MAP");
  const filledDoc = boothDocs.find((d) => d.type === "EXPO_MAP_FILLED");
  const blankFileCount = useMemo(() =>
    allPhotos.filter((p) => p.workflowKey === `booth:${blankDoc?.id}`).length,
    [allPhotos, blankDoc]
  );
  const filledFileCount = useMemo(() =>
    allPhotos.filter((p) => p.workflowKey === `booth:${filledDoc?.id}`).length,
    [allPhotos, filledDoc]
  );
  const competitorPhotoCounts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const p of allPhotos) {
      if (p.workflowKey?.startsWith("expo:")) {
        const id = p.workflowKey.slice(5);
        map[id] = (map[id] ?? 0) + 1;
      }
    }
    return map;
  }, [allPhotos]);

  function handleAddExpoBlank() {
    if (!currentUser) return;
    const doc = createBoothDoc(eventA42, "EXPO_MAP", currentUser.id, currentUser.name, "Blank base floorplan downloaded from venue");
    onOpenAttach({ key: `booth:${doc.id}`, label: "Expo Map — Blank" });
  }
  function handleAddExpoFilled() {
    if (!currentUser) return;
    const doc = createBoothDoc(eventA42, "EXPO_MAP_FILLED", currentUser.id, currentUser.name, "Floorplan marked with competitor booths");
    onOpenAttach({ key: `booth:${doc.id}`, label: "Expo Map — Filled" });
  }

  return (
    <div className="rounded-lg border border-[#DDE5E5] bg-white overflow-hidden">
      <div className="px-4 py-2.5 border-b border-[#DDE5E5] bg-[#F4F7F7]">
        <h2 className="text-[12px] font-semibold uppercase tracking-wider text-[#0A1F2E]">Expo Map — Competitor Research</h2>
        <p className="text-[10px] text-gray-500 mt-0.5">During the fair, record competitor booths spotted at the venue</p>
      </div>

      {!hasFullAccess && (
        <div className="px-4 py-2 flex items-center gap-2 bg-amber-50 border-b border-amber-100">
          <AlertCircle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
          <span className="text-[10px] text-amber-800">Read-only — you are not assigned to this event</span>
        </div>
      )}

      <div className="px-5 py-4 space-y-4">
        {/* Floorplan — 2 columns: blank vs filled */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {/* Column 1: BLANK base floorplan (downloaded, unmarked) */}
          <div className="rounded-md border border-[#DDE5E5] bg-[#FAFBFB] p-3">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 mb-2">Blank Floorplan</div>
            <div className="text-[9px] text-gray-400 mb-2">Download from venue · no markings yet</div>
            {blankDoc ? (
              <button
                type="button"
                onClick={() => onOpenAttach({ key: `booth:${blankDoc.id}`, label: "Expo Map — Blank" })}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-md border border-[#0F766E]/30 bg-white hover:bg-[#0F766E]/10 transition"
              >
                <MapPin className="h-4 w-4 text-[#0F766E]" />
                <span className="text-[12px] font-semibold text-[#0A1F2E]">Blank Venue Map</span>
                <span className={`ml-auto text-[10px] px-2 py-0.5 rounded font-semibold ${
                  blankFileCount > 0 ? "bg-[#0F766E]/10 text-[#0F766E]" : "bg-gray-100 text-gray-500"
                }`}>
                  {blankFileCount} file{blankFileCount === 1 ? "" : "s"}
                </span>
              </button>
            ) : hasFullAccess ? (
              <button
                type="button"
                onClick={handleAddExpoBlank}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-md border border-dashed border-[#DDE5E5] hover:border-[#0F766E] hover:text-[#0F766E] text-gray-400 transition"
              >
                <Plus className="h-4 w-4" />
                <span className="text-[12px] font-semibold">Upload blank floorplan</span>
              </button>
            ) : (
              <div className="text-[11px] text-gray-300 text-center py-3">— Not uploaded —</div>
            )}
          </div>

          {/* Column 2: FILLED floorplan (annotated with competitors) */}
          <div className="rounded-md border border-[#DDE5E5] bg-[#FAFBFB] p-3">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 mb-2">Filled Floorplan</div>
            <div className="text-[9px] text-gray-400 mb-2">Annotated with competitor booths during the fair</div>
            {filledDoc ? (
              <button
                type="button"
                onClick={() => onOpenAttach({ key: `booth:${filledDoc.id}`, label: "Expo Map — Filled" })}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-md border border-amber-300 bg-white hover:bg-amber-50 transition"
              >
                <MapPin className="h-4 w-4 text-amber-600" />
                <span className="text-[12px] font-semibold text-[#0A1F2E]">Filled Map</span>
                <span className={`ml-auto text-[10px] px-2 py-0.5 rounded font-semibold ${
                  filledFileCount > 0 ? "bg-amber-100 text-amber-700" : "bg-gray-100 text-gray-500"
                }`}>
                  {filledFileCount} file{filledFileCount === 1 ? "" : "s"}
                </span>
              </button>
            ) : hasFullAccess ? (
              <button
                type="button"
                onClick={handleAddExpoFilled}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-md border border-dashed border-[#DDE5E5] hover:border-amber-500 hover:text-amber-600 text-gray-400 transition"
              >
                <Plus className="h-4 w-4" />
                <span className="text-[12px] font-semibold">Upload filled floorplan</span>
              </button>
            ) : (
              <div className="text-[11px] text-gray-300 text-center py-3">— Not uploaded —</div>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}

// ── CompetitorFormModal ───────────────────────────────────────────────────────

function CompetitorFormModal({
  eventA42, entry, currentUser, hasFullAccess, allPhotos, onOpenAttach, onClose,
}: {
  eventA42: string;
  entry: CompetitorEntry | null;
  currentUser: SalesMember | null;
  hasFullAccess: boolean;
  allPhotos: PhotoRecord[];
  onOpenAttach: (a: { key: string; label: string }) => void;
  onClose: () => void;
}) {
  const [boothNo, setBoothNo] = useState(entry?.boothNo ?? "");
  const [brand, setBrand] = useState(entry?.brand ?? "");
  const [company, setCompany] = useState(entry?.company ?? "");
  const [notes, setNotes] = useState(entry?.notes ?? "");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const photoCount = useMemo(() =>
    entry ? allPhotos.filter((p) => p.workflowKey === `expo:${entry.id}`).length : 0,
    [allPhotos, entry]
  );

  function handleSave() {
    if (!boothNo.trim() || !brand.trim()) return;
    if (!currentUser) return;
    if (entry) {
      updateCompetitor(entry.id, { boothNo: boothNo.trim().toUpperCase(), brand: brand.trim(), company: company.trim() || undefined, notes: notes.trim() || undefined });
    } else {
      addCompetitor(eventA42, {
        boothNo: boothNo.trim().toUpperCase(),
        brand: brand.trim(),
        company: company.trim() || undefined,
        notes: notes.trim() || undefined,
        recordedById: currentUser.id,
        recordedByName: currentUser.name,
      });
    }
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-[#DDE5E5] bg-[#F4F7F7] flex items-center justify-between shrink-0">
          <h3 className="text-[14px] font-bold text-[#0A1F2E]">{entry ? "Edit Competitor" : "Add Competitor"}</h3>
          <button type="button" onClick={onClose}
            className="h-8 w-8 rounded inline-flex items-center justify-center text-gray-400 hover:text-[#0A1F2E] hover:bg-gray-100">
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3 flex-1">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 block mb-1">Booth No *</label>
              <input type="text" value={boothNo} onChange={(e) => setBoothNo(e.target.value)}
                placeholder="e.g. A12" className="w-full h-8 rounded-md border border-[#DDE5E5] px-2 text-[11px] bg-white focus:outline-none focus:ring-2 focus:ring-[#0F766E]/30 focus:border-[#0F766E]" />
            </div>
            <div>
              <label className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 block mb-1">Brand *</label>
              <input type="text" value={brand} onChange={(e) => setBrand(e.target.value)}
                placeholder="e.g. King Koil" className="w-full h-8 rounded-md border border-[#DDE5E5] px-2 text-[11px] bg-white focus:outline-none focus:ring-2 focus:ring-[#0F766E]/30 focus:border-[#0F766E]" />
            </div>
          </div>
          <div>
            <label className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 block mb-1">Company</label>
            <input type="text" value={company} onChange={(e) => setCompany(e.target.value)}
              placeholder="Company name…" className="w-full h-8 rounded-md border border-[#DDE5E5] px-2 text-[11px] bg-white focus:outline-none focus:ring-2 focus:ring-[#0F766E]/30 focus:border-[#0F766E]" />
          </div>
          <div>
            <label className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 block mb-1">Notes</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)}
              placeholder="Observations, pricing, products…" rows={2}
              className="w-full rounded-md border border-[#DDE5E5] px-2 py-1.5 text-[11px] bg-white focus:outline-none focus:ring-2 focus:ring-[#0F766E]/30 focus:border-[#0F766E] resize-y" />
          </div>

          {/* Photos (only available when editing an existing entry) */}
          {entry && (
            <div>
              <label className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 block mb-1">Photos</label>
              <button type="button"
                onClick={() => onOpenAttach({ key: `expo:${entry.id}`, label: `${entry.brand} — Booth ${entry.boothNo}` })}
                className={`flex items-center gap-2 px-3 py-2 rounded-md border w-full transition ${
                  photoCount > 0 ? "border-[#0F766E]/30 bg-[#0F766E]/5 hover:bg-[#0F766E]/10" : "border-dashed border-[#DDE5E5] hover:border-[#0F766E]"
                }`}
              >
                <Paperclip className="h-4 w-4 text-[#0F766E]" />
                <span className="text-[12px] font-semibold text-[#0A1F2E]">
                  {photoCount > 0 ? `${photoCount} photo${photoCount === 1 ? "" : "s"} attached` : "Upload photos"}
                </span>
              </button>
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-[#DDE5E5] flex justify-end gap-2 shrink-0">
          <button type="button" onClick={onClose}
            className="h-8 px-3 rounded-md border border-[#DDE5E5] bg-white text-[11px] font-semibold text-gray-600 hover:bg-gray-50">
            Cancel
          </button>
          <button type="button" onClick={handleSave}
            disabled={!boothNo.trim() || !brand.trim()}
            className="h-8 px-3 rounded-md bg-[#0F766E] text-white text-[11px] font-semibold hover:bg-[#0c5f59] disabled:opacity-40">
            {entry ? "Save Changes" : "Add Competitor"}
          </button>
        </div>
      </div>
    </div>
  );
}
