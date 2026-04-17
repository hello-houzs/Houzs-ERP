import { Link, useParams, useNavigate } from "react-router-dom";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft, Calendar as CalIcon, MapPin, Building2, User, Hash,
  Check, Minus, AlertCircle, Trash2, ExternalLink, Paperclip, Pencil, X as XIcon,
} from "lucide-react";
import {
  calendarTitle, fmtRM, fmtPct, computeCosts,
  BRANDS, STATES,
  type HouzsEvent, type WorkflowFlag, type Brand, type EventType,
  type EventStatus, type EventProgress, type MalaysianState,
} from "@/lib/mock-data";
import {
  useAllEvents, updateEvent, deleteUserEvent,
} from "@/lib/events-store";
import { useSalesMembers } from "@/lib/sales-store";
import { useEventPhotos } from "@/lib/photos-store";
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
  const activeSalesMembers = useMemo(() => salesMembers.filter(m => m.status === "ACTIVE").sort((a, b) => a.name.localeCompare(b.name)), [salesMembers]);

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
    <div className="space-y-4 max-w-6xl">
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
                <div className={FIELD_LABEL}>PIC</div>
                <div className="text-[#0A1F2E] font-medium">{event.pic ?? "—"}</div>
                <div className="text-[10px] text-gray-500">Organizer: {event.organizer}</div>
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
            <p className="text-[10px] text-gray-500 mt-0.5">Driver, lori, schedule, setup crew</p>
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
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <div className={FIELD_LABEL}>Setup Driver</div>
                <div className="text-[12px] font-semibold text-[#0A1F2E] mt-0.5">{event.setupDriver || <span className="text-gray-300 font-normal">—</span>}</div>
              </div>
              <div>
                <div className={FIELD_LABEL}>Setup Lori</div>
                <div className="text-[12px] font-semibold text-[#0A1F2E] mt-0.5 tabular-nums">{event.setupLori || <span className="text-gray-300 font-normal">—</span>}</div>
              </div>
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
          </div>
        ) : (
          <div className="px-5 py-4 space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div>
                <div className={FIELD_LABEL}>Setup Driver</div>
                <Combo
                  value={draft.setupDriver ?? ""}
                  options={master.drivers.map((d) => d.name)}
                  onChange={(v) => patchDraft("setupDriver", v)}
                  onCreate={(v) => addDriver(v, "")}
                  placeholder="Driver…"
                />
              </div>
              <div>
                <div className={FIELD_LABEL}>Setup Lori</div>
                <Combo
                  value={draft.setupLori ?? ""}
                  options={master.lori}
                  onChange={(v) => patchDraft("setupLori", v)}
                  onCreate={(v) => addLori(v)}
                  placeholder="Plate…"
                />
              </div>
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
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
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
          </div>
        )}
      </div>

      {/* Assigned Sales */}
      <div className="rounded-lg border border-[#DDE5E5] bg-white overflow-hidden">
        <div className="px-4 py-2.5 border-b border-[#DDE5E5] bg-[#F4F7F7]">
          <h2 className="text-[12px] font-semibold uppercase tracking-wider text-[#0A1F2E]">Assigned Sales</h2>
          <p className="text-[10px] text-gray-500 mt-0.5">Sales members working this fair</p>
        </div>
        {!isEditing ? (
          <div className="px-5 py-4">
            <div className="flex flex-wrap gap-1.5">
              {(event.assignedSales ?? []).length > 0
                ? (event.assignedSales ?? []).map(id => {
                    const member = salesMembers.find(m => m.id === id);
                    return member ? (
                      <span key={id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#0F766E]/10 text-[#0F766E] text-[10px] font-semibold">
                        <User className="h-2.5 w-2.5" />{member.name}
                      </span>
                    ) : null;
                  })
                : <span className="text-[11px] text-gray-300">— No sales assigned —</span>
              }
            </div>
          </div>
        ) : (
          <div className="px-5 py-4">
            <div className="rounded-md border border-[#DDE5E5] overflow-hidden">
              <div className="px-3 py-1.5 border-b border-[#F0F3F3] bg-[#FAFBFB]">
                <input type="text" value={salesSearch} onChange={(e) => setSalesSearch(e.target.value)}
                  placeholder="Search name…" className="w-full h-6 text-[11px] bg-transparent outline-none placeholder:text-gray-400" />
              </div>
              <div className="max-h-[200px] overflow-y-auto divide-y divide-[#F0F3F3]">
                {activeSalesMembers
                  .filter(m => !salesSearch.trim() || m.name.toUpperCase().includes(salesSearch.trim().toUpperCase()))
                  .map(m => {
                    const checked = (draft.assignedSales ?? []).includes(m.id);
                    return (
                      <label key={m.id} className="flex items-center gap-2 px-3 py-1.5 hover:bg-[#FAFBFB] cursor-pointer">
                        <input type="checkbox" checked={checked} onChange={() => toggleAssignedSales(m.id)} className="h-3.5 w-3.5 rounded border-gray-300 text-[#0F766E] focus:ring-[#0F766E]" />
                        <span className="text-[11px] font-semibold text-[#0A1F2E]">{m.name}</span>
                        <span className="text-[9px] text-gray-400 ml-auto">{m.position}</span>
                      </label>
                    );
                  })}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Event Chat */}
      <EventChat
        eventA42={a42}
        eventTitle={calendarTitle(event)}
        eventStartDate={event.startDate}
        eventEndDate={event.endDate}
        assignedSales={event.assignedSales ?? []}
        eventStatus={event.progress}
        pic={event.pic}
        currentUserId="dir-kingsley"
      />

      {/* Financial snapshot */}
      <div className="rounded-lg border border-[#DDE5E5] bg-white overflow-hidden">
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
      </div>

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
