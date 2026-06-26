import { useEffect, useRef, useState, useMemo, useCallback, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, useSearchParams, useNavigate, useParams, Navigate } from "react-router-dom";
import {
  Plus,
  RefreshCw,
  Search,
  ChevronLeft,
  ChevronRight,
  ChevronsUp,
  ChevronUp,
  ChevronDown,
  Minus,
  Upload,
  MessageSquare,
  Truck as TruckIcon,
  Trash2,
  Pencil,
  Star,
  Package,
  UserPlus,
  Calendar,
  CalendarDays,
  List as ListIcon,
  LayoutGrid,
  ShieldCheck,
  AlertCircle,
  ClipboardCheck,
  User,
  Clock,
  DollarSign,
  Printer,
  Download,
  X,
  ClipboardList,
  Wrench,
} from "lucide-react";
import { HubGrid } from "../components/HubGrid";
import { PageHeader } from "../components/Layout";
import {
  DetailLayout,
  DetailGrid,
  DetailMain,
  DetailAside,
  HeaderButton,
} from "../components/DetailLayout";
import { Button } from "../components/Button";
import { DataTable, type Column } from "../components/DataTable";
import {
  StatusDot,
  stageVariant,
  stageLabel,
  priorityColor,
  resolutionLabel,
} from "../components/StatusDot";
import { Pagination } from "../components/Pagination";
import { EmptyState } from "../components/EmptyState";
import { Badge } from "../components/Badge";
import { Panel, PanelSection, FieldRow } from "../components/Panel";
import { InlineEdit } from "../components/InlineEdit";
import { ExpandableText } from "../components/ExpandableText";
import { StatCard } from "../components/StatCard";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { useDialog } from "../hooks/useDialog";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useServerSort } from "../hooks/useServerSort";
import { useFocusFromUrl } from "../hooks/useFocusFromUrl";
import { useAuth } from "../auth/AuthContext";
import { api, buildQuery } from "../api/client";
import { formatCurrency, formatDate, formatDateTime, cn } from "../lib/utils";
import { ServiceMetrics } from "./ServiceMetrics";
import { ServiceSettingsView } from "./ServiceSettings";
import { ServiceLeadTimePortal } from "./ServiceLeadTimePortal";
import { ServiceProgressTracker } from "../components/ServiceProgressTracker";
import type {
  Paginated,
  AssrCase,
  AssrDetail,
  AssrAttachment,
  AssrStage,
  PurchaseOrder,
} from "../types";

type StageFilter = "ALL" | AssrStage;

// v3.1 9-stage workflow (mig 074). Labels match the canonical proposal
// vocabulary; values are the SQL enum.
const STAGE_OPTIONS: { value: StageFilter; label: string }[] = [
  { value: "ALL", label: "All" },
  { value: "pending_review", label: "Pending Review" },
  { value: "under_verification", label: "Under Verification" },
  { value: "pending_solution", label: "Pending Solution" },
  { value: "pending_inspection", label: "Pending Inspection" },
  { value: "pending_item_pickup", label: "Pending Item Pickup" },
  { value: "pending_supplier_pickup", label: "Pending Supplier Pickup" },
  { value: "pending_item_ready", label: "Pending Item Ready" },
  { value: "pending_delivery_service", label: "Pending Delivery / Service" },
  { value: "completed", label: "Completed" },
];

const RESOLUTION_OPTIONS = [
  "replace_unit",
  "supplier_repair",
  "field_service_own",
  "field_service_supplier",
  "return_visit",
] as const;

const PRIORITY_OPTIONS = ["low", "normal", "high", "urgent"] as const;

const NCR_OPTIONS = [
  "material_defect",
  "workmanship",
  "transit_damage",
  "design",
  "installation",
  "customer_misuse",
  "other",
] as const;

// Default "next" suggestion for the in-form transition button. Skips
// (Replace Unit → no inspection / supplier pickup / item ready;
// Field-Service Own Team → no supplier pickup / item ready;
// Return Visit → no item pickup / supplier pickup / item ready) are
// honored by the service-admin manually picking the correct next
// stage from the dropdown — this map only seeds the primary button.
const NEXT_STAGE: Record<string, { stage: AssrStage; label: string }> = {
  pending_review:           { stage: "under_verification",       label: "Start Verification" },
  under_verification:       { stage: "pending_solution",         label: "Move to Solution" },
  pending_solution:         { stage: "pending_inspection",       label: "Schedule Inspection" },
  pending_inspection:       { stage: "pending_item_pickup",      label: "Arrange Item Pickup" },
  pending_item_pickup:      { stage: "pending_supplier_pickup",  label: "Hand to Supplier" },
  pending_supplier_pickup:  { stage: "pending_item_ready",       label: "Mark Item Ready" },
  pending_item_ready:       { stage: "pending_delivery_service", label: "Arrange Delivery" },
  pending_delivery_service: { stage: "completed",                label: "Close Case" },
};

// ── Cases-surface view modes ──────────────────────────────────
// The Cases surface can be read three ways. "list" is the dense,
// server-paginated DataTable (the original). "board" is an SLA-urgency
// kanban — cases bucketed by how close they are to their SLA deadline.
// "calendar" plots every open case on a month grid by its SLA deadline
// (or reported date). Board + Calendar fetch all matching cases in one
// shot client-side (per_page high) since they need the whole set to
// lay out, not a page at a time.
type CaseViewMode = "list" | "board" | "calendar";

// Filters shared across all three views — built once in CasesView and
// handed to Board/Calendar so every mode honours the same stage / search
// / archived / mine / creditor scope.
type CaseFilters = {
  stage?: string;
  search?: string;
  include_archived?: number;
  exclude_stage?: string;
  assigned_to?: number;
  creditor_code?: string;
};

// Stage value → human label, sourced from the canonical STAGE_OPTIONS so
// Board/Calendar chips read the same vocabulary as the filter pills
// (StatusDot.stageLabel still maps the older 6-stage enum).
const STAGE_LABEL_BY_VALUE: Record<string, string> = Object.fromEntries(
  STAGE_OPTIONS.filter((o) => o.value !== "ALL").map((o) => [o.value, o.label])
);

function caseStageLabel(stage: string): string {
  return STAGE_LABEL_BY_VALUE[stage] ?? stageLabel(stage);
}

// SLA urgency, derived from the server-computed `hours_to_deadline`
// (negative = past deadline). One model drives the colour of both the
// Board columns and the Calendar chips so the two views read identically.
type Urgency = "overdue" | "today" | "soon" | "later" | "none";

const URGENCY_ORDER: Urgency[] = ["overdue", "today", "soon", "later", "none"];

const URGENCY_META: Record<
  Urgency,
  { label: string; hint: string; hex: string; tint: string; text: string }
> = {
  overdue: { label: "Overdue",   hint: "Past SLA deadline",       hex: "#b23b3b", tint: "rgba(178,59,59,0.12)",  text: "#8f2f2f" },
  today:   { label: "Due today", hint: "SLA deadline within 24h", hex: "#c2740f", tint: "rgba(194,116,15,0.13)", text: "#8a540b" },
  soon:    { label: "Due soon",  hint: "SLA deadline in 1–3 days", hex: "#a16a2e", tint: "rgba(161,106,46,0.12)", text: "#7c5224" },
  later:   { label: "On track",  hint: "More than 3 days of SLA", hex: "#3f6b53", tint: "rgba(63,107,83,0.12)",  text: "#2f5340" },
  none:    { label: "No SLA",    hint: "No SLA deadline set",     hex: "#6c7167", tint: "rgba(108,113,103,0.10)", text: "#585d53" },
};

function caseUrgency(c: AssrCase): Urgency {
  if (c.stage === "completed") return "later";
  const h = c.hours_to_deadline;
  if (c.deadline_at == null || h == null) return "none";
  if (h < 0) return "overdue";
  if (h < 24) return "today";
  if (h < 72) return "soon";
  return "later";
}

// "3h overdue" / "2d left" — compact countdown off hours_to_deadline.
function formatCountdown(h: number | null | undefined): string | null {
  if (h == null) return null;
  const abs = Math.abs(h);
  const txt = abs >= 48 ? `${Math.round(abs / 24)}d` : `${Math.max(1, Math.round(abs))}h`;
  return h < 0 ? `${txt} overdue` : `${txt} left`;
}

// Local YYYY-MM-DD (calendar grid keys off local days, matching formatDate).
function isoLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ── Main page ─────────────────────────────────────────────────

// Shell — two tabs: the case list and the quality-metrics dashboard.
// The metrics used to live at /service-metrics as its own sidebar
// entry; it's just a report about cases so it belongs here alongside
// them rather than as a top-level module.
type ServiceView = "hub" | "cases" | "metrics" | "lead_time" | "settings";

const SERVICE_VIEWS: ServiceView[] = [
  "hub",
  "cases",
  "metrics",
  "lead_time",
  "settings",
];

// Per-view header config so each view gets its own dedicated title.
// (settings view owns its own PageHeader, so it's not in this map.)
const VIEW_HEADER: Record<
  Exclude<ServiceView, "settings">,
  { title: string; description: string }
> = {
  hub: {
    title: "Service",
    description: "Cases, quality metrics and service maintenance — pick a section.",
  },
  cases: {
    title: "Service Cases",
    description: "After-sales service request workflow.",
  },
  metrics: {
    title: "Quality Metrics",
    description: "Performance breakdown — SLA, supplier ratings, resolution times.",
  },
  lead_time: {
    title: "Lead Time Portal",
    description: "Per-stage SLA targets. Switch profile (Normal / Peak / Custom) and amend with reason.",
  },
};

export function ServiceCases() {
  // URL-driven (`?view=…`). The sidebar's Quality Management group has
  // one entry per view, so the page itself doesn't render a tab strip
  // — view selection lives in the sidebar.
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [storedView, setStoredView] = useLocalStorage<ServiceView>(
    "assr:view",
    "cases"
  );
  const urlView = params.get("view") as ServiceView | null;
  const view: ServiceView =
    urlView && SERVICE_VIEWS.includes(urlView) ? urlView : storedView;

  // Persist whatever view was rendered so a bare `/assr` lands back
  // where the user left off.
  useEffect(() => {
    if (view !== storedView) setStoredView(view);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // Legacy `/assr?view=lead_time` URL — Lead Time Portal merged into
  // Service Maintenance as a tab. Redirect any old bookmarks to the
  // new deep-link so they don't 404.
  useEffect(() => {
    if (urlView === "lead_time") {
      navigate("/assr?view=settings&tab=lead_time", { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlView]);

  // "New Case" action lives on the Cases view's header.
  const [showCreate, setShowCreate] = useState(false);

  return (
    <div>
      {view !== "settings" && (
        <PageHeader
          eyebrow="Operations · Service"
          title={VIEW_HEADER[view].title}
          description={VIEW_HEADER[view].description}
          primaryAction={
            view === "cases" ? (
              <Button
                variant="primary"
                icon={<Plus size={14} />}
                onClick={() => setShowCreate(true)}
              >
                New Case
              </Button>
            ) : undefined
          }
        />
      )}

      {view === "hub" && (
        <HubGrid
          cards={[
            { key: "cases", label: "Service Cases", description: VIEW_HEADER.cases.description, icon: ClipboardList, onClick: () => navigate("/assr?view=cases") },
            { key: "metrics", label: "Quality Metrics", description: VIEW_HEADER.metrics.description, icon: ShieldCheck, onClick: () => navigate("/assr?view=metrics") },
            { key: "settings", label: "Service Maintenance", description: "Picker lists, SLA lead-time targets and module defaults.", icon: Wrench, onClick: () => navigate("/assr?view=settings") },
          ]}
        />
      )}

      {view === "cases" && (
        <CasesView showCreate={showCreate} setShowCreate={setShowCreate} />
      )}
      {view === "metrics" && <ServiceMetrics />}
      {view === "lead_time" && <ServiceLeadTimePortal />}
      {view === "settings" && <ServiceSettingsView />}
    </div>
  );
}

function CasesView({
  showCreate,
  setShowCreate,
}: {
  showCreate: boolean;
  setShowCreate: (v: boolean) => void;
}) {
  const toast = useToast();
  const dialog = useDialog();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [stage, setStage] = useState<StageFilter>("ALL");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useLocalStorage<number>("pp:assr", 50);
  const [showArchived, setShowArchived] = useLocalStorage<boolean>("assr:showArchived", false);
  const [myCases, setMyCases] = useLocalStorage<boolean>("assr:myCases", false);
  // Hide completed cases from the working list — closed cases pile up
  // and ops mostly only cares about what's still open.
  const [hideCompleted, setHideCompleted] = useLocalStorage<boolean>("assr:hideCompleted", false);
  const [bulkSelected, setBulkSelected] = useState<Set<number>>(new Set());
  const { sort, sortParams, handleSortChange } = useServerSort(() => setPage(1));
  const [params, setParams] = useSearchParams();
  const creditorFilter = params.get("creditor_code");

  // View mode (list / board / calendar) is URL-backed (`?cases=`) so a
  // bookmark or shared link lands on the same layout. Defaults to the
  // dense list.
  const caseViewParam = params.get("cases");
  const caseView: CaseViewMode =
    caseViewParam === "board" || caseViewParam === "calendar"
      ? caseViewParam
      : "list";
  const setCaseView = (next: CaseViewMode) => {
    const nextParams = new URLSearchParams(params);
    if (next === "list") nextParams.delete("cases");
    else nextParams.set("cases", next);
    setParams(nextParams, { replace: true });
  };

  // ?focus=ID — Overview inbox deep-links straight to the detail page.
  useFocusFromUrl((id) => navigate(`/assr/${id}`, { replace: true }));

  // Skip the hide-completed param when the stage filter is explicitly
  // "completed" — otherwise the page would return zero rows and look
  // broken. Lets the user override the toggle by picking that stage.
  const excludeStageParam =
    hideCompleted && stage !== "completed" ? "completed" : undefined;

  // Shared filter scope handed to Board / Calendar so every view honours
  // the same stage / search / archived / mine / creditor selection.
  const caseFilters: CaseFilters = {
    stage: stage === "ALL" ? undefined : stage,
    search: search || undefined,
    include_archived: showArchived ? 1 : undefined,
    exclude_stage: excludeStageParam,
    assigned_to: myCases && user?.id ? user.id : undefined,
    creditor_code: creditorFilter || undefined,
  };

  const list = useQuery<Paginated<AssrCase>>(
    () =>
      api.get(
        `/api/assr${buildQuery({
          stage: stage === "ALL" ? undefined : stage,
          search,
          page,
          per_page: perPage,
          include_archived: showArchived ? 1 : undefined,
          exclude_stage: excludeStageParam,
          assigned_to: myCases && user?.id ? user.id : undefined,
          creditor_code: creditorFilter || undefined,
          ...sortParams,
        })}`
      ),
    [stage, search, page, perPage, showArchived, excludeStageParam, myCases, user?.id, creditorFilter, sort?.key, sort?.dir]
  );

  // Drop selections that are no longer on screen — keeps the bulk
  // toolbar count honest when you change pages or filters.
  useEffect(() => {
    if (bulkSelected.size === 0) return;
    const visibleIds = new Set((list.data?.data ?? []).map((r) => r.id));
    let changed = false;
    const next = new Set<number>();
    for (const id of bulkSelected) {
      if (visibleIds.has(id)) next.add(id);
      else changed = true;
    }
    if (changed) setBulkSelected(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.data?.data]);

  const visibleRows = list.data?.data ?? [];
  const allSelected =
    visibleRows.length > 0 && visibleRows.every((r) => bulkSelected.has(r.id));
  const someSelected =
    !allSelected && visibleRows.some((r) => bulkSelected.has(r.id));

  function toggleAll() {
    if (allSelected) {
      const next = new Set(bulkSelected);
      for (const r of visibleRows) next.delete(r.id);
      setBulkSelected(next);
    } else {
      const next = new Set(bulkSelected);
      for (const r of visibleRows) next.add(r.id);
      setBulkSelected(next);
    }
  }

  function toggleOne(id: number) {
    const next = new Set(bulkSelected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setBulkSelected(next);
  }

  const columns: Column<AssrCase>[] = [
    {
      key: "_select",
      label: "",
      alwaysVisible: true,
      width: "32px",
      render: (r) => (
        <div
          onClick={(e) => {
            e.stopPropagation();
            toggleOne(r.id);
          }}
          className="flex h-full items-center justify-center"
        >
          <input
            type="checkbox"
            checked={bulkSelected.has(r.id)}
            readOnly
            className="accent-accent"
          />
        </div>
      ),
    },
    {
      key: "assr_no",
      label: "ASSR No",
      alwaysVisible: true,
      render: (r) => <span className="font-mono text-xs font-medium">{r.assr_no}</span>,
      getValue: (r) => r.assr_no,
    },
    {
      key: "stage",
      label: "Stage",
      alwaysVisible: true,
      render: (r) => (
        // Single-line — `flex-wrap` removed (was the only thing
        // letting badges spill to a second row). Badges that overflow
        // are now clipped with ellipsis at the cell edge.
        <div className="flex items-center gap-1.5">
          {r.archived_at && (
            <Badge tone="neutral" variant="outline" className="bg-ink-muted/10">
              Archived
            </Badge>
          )}
          <StatusDot variant={stageVariant(r.stage)} label={caseStageLabel(r.stage)} />
          {r.stage !== "completed" && (r.is_breached === 1 || r.escalated_at) && (
            // One SLA badge: solid red = breached, outline = escalated
            // only (overdue >24h). Merged from the old separate SLA + Esc
            // pills to calm the row.
            <Badge
              tone="error"
              variant={r.is_breached === 1 ? "solid" : "outline"}
              title={
                r.is_breached === 1
                  ? `SLA breached by ${Math.abs(r.hours_to_deadline ?? 0)}h${r.escalated_at ? " · escalated" : ""}`
                  : `Auto-escalated ${r.escalated_at?.slice(0, 10)} — SLA overdue >24h`
              }
            >
              SLA
            </Badge>
          )}
          {r.stage !== "completed" && r.days_in_stage != null && r.days_in_stage > 3 && (
            // Neutral aging hint — red is reserved for actual SLA breach
            // (the badge above). Showing every >3-day case in red made the
            // whole list look on-fire.
            <Badge tone="neutral" variant="soft" title={`In this stage for ${r.days_in_stage} day(s)`}>
              {r.days_in_stage}d
            </Badge>
          )}
        </div>
      ),
      getValue: (r) => stageLabel(r.stage),
    },
    {
      key: "priority",
      label: "Priority",
      align: "center",
      // Symbol-only — chevrons encode the level (most cases are Normal,
      // so the word added noise). Urgent/High get a coloured chip so they
      // pop; Normal/Low stay quiet. Hover for the label.
      render: (r) => {
        const p = r.priority;
        const Icon =
          p === "urgent" ? ChevronsUp : p === "high" ? ChevronUp : p === "low" ? ChevronDown : Minus;
        const color =
          p === "urgent"
            ? "text-err"
            : p === "high"
            ? "text-[#c2740f]"
            : p === "low"
            ? "text-ink-muted/50"
            : "text-ink-muted";
        const chip =
          p === "urgent" ? "bg-err/12" : p === "high" ? "bg-[#c2740f]/12" : "";
        return (
          <span
            title={p}
            className={cn(
              "inline-flex h-[22px] w-[22px] items-center justify-center rounded-full",
              chip
            )}
          >
            <Icon size={16} strokeWidth={2.5} className={color} />
          </span>
        );
      },
      getValue: (r) => r.priority,
    },
    {
      key: "doc_no",
      label: "SO No",
      render: (r) => <span className="font-mono text-xs">{r.doc_no}</span>,
      getValue: (r) => r.doc_no,
    },
    {
      key: "complained_date",
      label: "Date",
      render: (r) => formatDate(r.complained_date),
      getValue: (r) => formatDate(r.complained_date),
    },
    {
      key: "customer_name",
      label: "Customer",
      render: (r) => (
        <span
          className="block max-w-[180px] truncate"
          title={r.customer_name || undefined}
        >
          {r.customer_name || "—"}
        </span>
      ),
      getValue: (r) => r.customer_name,
    },
    {
      key: "item_code",
      label: "Item",
      // Product code — visible on the detail page; hidden here to cut
      // clutter, still available from the Columns menu.
      defaultHidden: true,
      render: (r) => <span className="font-mono text-[11px]">{r.item_code || "—"}</span>,
      getValue: (r) => r.item_code,
    },
    {
      key: "resolution_method",
      label: "Resolution",
      // Empty until a case reaches the solution stage, so it's mostly
      // "—" on the working list — hidden by default to cut clutter,
      // still available from the Columns menu.
      defaultHidden: true,
      render: (r) => (
        <span className="text-[11px] text-ink-secondary">
          {resolutionLabel(r.resolution_method)}
        </span>
      ),
      getValue: (r) => resolutionLabel(r.resolution_method),
    },
    {
      key: "assigned_to_name",
      label: "Assigned To",
      render: (r) => r.assigned_to_name || "—",
      getValue: (r) => r.assigned_to_name,
    },
    {
      key: "supplier_pickup_at",
      label: "Supplier Pickup",
      defaultHidden: true,
      render: (r) => formatDate(r.supplier_pickup_at),
      getValue: (r) => r.supplier_pickup_at,
    },
    {
      key: "items_ready_at",
      label: "Items Ready",
      defaultHidden: true,
      render: (r) => formatDate(r.items_ready_at),
      getValue: (r) => r.items_ready_at,
    },
    {
      key: "stage_lead_days",
      label: "Lead Time",
      align: "right",
      defaultHidden: true,
      render: (r) =>
        r.days_in_stage == null ? (
          "—"
        ) : (
          <span
            className={cn(
              "font-mono tabular-nums text-[11px]",
              r.days_in_stage > 3 && r.stage !== "completed" && "text-err font-semibold",
            )}
            title={`In ${stageLabel(r.stage)} for ${r.days_in_stage} day(s)`}
          >
            {r.days_in_stage}d
          </span>
        ),
      getValue: (r) => r.days_in_stage,
    },
  ];

  return (
    <div>
      {creditorFilter && (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-accent/30 bg-accent-soft/40 px-3 py-2 text-[12px]">
          <span className="font-semibold uppercase tracking-wider text-accent">
            Filter · Creditor
          </span>
          <span className="font-mono text-ink">{creditorFilter}</span>
          <button
            onClick={() => {
              const next = new URLSearchParams(params);
              next.delete("creditor_code");
              setParams(next, { replace: true });
            }}
            className="ml-auto text-ink-muted hover:text-err"
            aria-label="Clear creditor filter"
          >
            ×
          </button>
        </div>
      )}
      <StageStatStrip
        stage={stage}
        onPick={(v) => { setPage(1); setStage(v); }}
      />

      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-3">
        {/* View mode — List / Board / Calendar. The board and calendar
            re-read the same cases through an SLA-urgency lens; the list
            stays the dense system-of-record. */}
        <div className="inline-flex overflow-hidden rounded-md border border-border bg-bg/40">
          {([
            { v: "list" as const, label: "List", icon: ListIcon },
            { v: "board" as const, label: "Board", icon: LayoutGrid },
            { v: "calendar" as const, label: "Calendar", icon: CalendarDays },
          ]).map(({ v, label, icon: Icon }) => (
            <button
              key={v}
              type="button"
              onClick={() => setCaseView(v)}
              aria-pressed={caseView === v}
              className={cn(
                "inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold transition-colors",
                caseView === v
                  ? "bg-accent text-white"
                  : "text-ink-muted hover:text-accent"
              )}
            >
              <Icon size={13} />
              {label}
            </button>
          ))}
        </div>
        {/* Stage selection now lives in the per-stage stat cards above —
            click a card to filter, click it again to clear back to All. */}
        <label className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-ink-secondary">
          <input
            type="checkbox"
            checked={!!myCases}
            onChange={(e) => { setPage(1); setMyCases(e.target.checked); }}
            className="accent-accent"
            disabled={!user?.id}
          />
          My cases
        </label>
        <label className="inline-flex items-center gap-1.5 text-[11px] text-ink-secondary">
          <input
            type="checkbox"
            checked={!!hideCompleted}
            onChange={(e) => { setPage(1); setHideCompleted(e.target.checked); }}
            className="accent-accent"
            disabled={stage === "completed"}
            title={stage === "completed" ? "Disabled while the Completed stage filter is active" : undefined}
          />
          Hide completed
        </label>
        <label className="inline-flex items-center gap-1.5 text-[11px] text-ink-secondary">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => { setPage(1); setShowArchived(e.target.checked); }}
            className="accent-accent"
          />
          Show archived
        </label>
        <Button
          variant="ghost"
          icon={<Download size={14} />}
          onClick={async () => {
            try {
              await api.downloadFile(
                `/api/assr/export.csv${buildQuery({
                  stage: stage === "ALL" ? undefined : stage,
                  search,
                  include_archived: showArchived ? 1 : undefined,
                  exclude_stage: excludeStageParam,
                })}`,
                "service-cases.csv"
              );
            } catch (e: any) {
              toast.error(`Export failed: ${e?.message || e}`);
            }
          }}
        >
          Export All
        </Button>
      </div>

      {caseView === "board" && (
        <CasesBoardView filters={caseFilters} onOpen={(id) => navigate(`/assr/${id}`)} />
      )}
      {caseView === "calendar" && (
        <CasesCalendarView filters={caseFilters} onOpen={(id) => navigate(`/assr/${id}`)} />
      )}

      {caseView === "list" && (
      <>
      {bulkSelected.size > 0 && (
        <BulkActionsBar
          count={bulkSelected.size}
          allSelected={allSelected}
          someSelected={someSelected}
          onToggleAll={toggleAll}
          onClear={() => setBulkSelected(new Set())}
          showArchived={showArchived}
          onArchive={async () => {
            if (!await dialog.confirm(`Archive ${bulkSelected.size} case(s)?`)) return;
            try {
              const res = await api.post<{ ok: number; failed: any[] }>(
                "/api/assr/bulk/archive",
                { ids: Array.from(bulkSelected) }
              );
              toast.success(
                `Archived ${res.ok}` + (res.failed.length ? `, ${res.failed.length} failed` : "")
              );
              setBulkSelected(new Set());
              list.reload();
            } catch (e: any) {
              toast.error(e?.message || "Bulk archive failed");
            }
          }}
          onUnarchive={async () => {
            if (!await dialog.confirm(`Restore ${bulkSelected.size} case(s)?`)) return;
            try {
              const res = await api.post<{ ok: number; failed: any[] }>(
                "/api/assr/bulk/unarchive",
                { ids: Array.from(bulkSelected) }
              );
              toast.success(
                `Restored ${res.ok}` + (res.failed.length ? `, ${res.failed.length} failed` : "")
              );
              setBulkSelected(new Set());
              list.reload();
            } catch (e: any) {
              toast.error(e?.message || "Bulk restore failed");
            }
          }}
          onAssignToMe={
            user?.id
              ? async () => {
                  try {
                    const res = await api.post<{ ok: number; failed: any[] }>(
                      "/api/assr/bulk/assign",
                      { ids: Array.from(bulkSelected), assigned_to: user.id }
                    );
                    toast.success(
                      `Assigned ${res.ok}` + (res.failed.length ? `, ${res.failed.length} failed` : "")
                    );
                    setBulkSelected(new Set());
                    list.reload();
                  } catch (e: any) {
                    toast.error(e?.message || "Bulk assign failed");
                  }
                }
              : null
          }
        />
      )}

      <DataTable
        tableId="assr"
        udfTable="assr"
        udfTableLabel="Service Cases"
        exportName="service-cases"
        search={{
          value: search,
          onChange: (v) => { setPage(1); setSearch(v); },
          placeholder: "Search ASSR no, SO no, customer…",
        }}
        resetFilters={{
          active: !!(
            search ||
            stage !== "ALL" ||
            showArchived ||
            myCases ||
            hideCompleted ||
            creditorFilter
          ),
          onReset: () => {
            setSearch("");
            setStage("ALL");
            setShowArchived(false);
            setMyCases(false);
            setHideCompleted(false);
            setPage(1);
            if (creditorFilter) {
              const next = new URLSearchParams(params);
              next.delete("creditor_code");
              setParams(next, { replace: true });
            }
          },
        }}
        columns={columns}
        rows={list.data?.data ?? null}
        loading={list.loading}
        error={list.error}
        emptyLabel="No service cases"
        getRowKey={(r) => r.id}
        getRowClassName={(r) => (r.archived_at ? "opacity-60" : undefined)}
        onRowClick={(r) => navigate(`/assr/${r.id}`)}
        serverSort
        onSortChange={handleSortChange}
      />

      {list.data && (
        <Pagination
          page={page}
          perPage={perPage}
          total={list.data.total}
          onPageChange={setPage}
          onPerPageChange={(n) => { setPerPage(n); setPage(1); }}
        />
      )}
      </>
      )}

      {/* Create panel */}
      {showCreate && (
        <CreatePanel
          onClose={() => setShowCreate(false)}
          onCreated={(id) => {
            setShowCreate(false);
            navigate(`/assr/${id}`);
            list.reload();
          }}
          toast={toast}
        />
      )}
    </div>
  );
}

// ── Cases · per-stage stat strip ──────────────────────────────
// A card per workflow stage showing how many cases sit there, with
// SLA-breach count as the sub-line (red when any are overdue). Each
// card is a drill-down: click to filter the list/board/calendar to
// that stage, click again to clear back to All. Counts come from the
// shared `/api/assr/summary` aggregate (stage_funnel = archived-excluded
// totals + breach counts); a wide window captures long-open cases.
type StageFunnelRow = { stage: string; total: number; breached: number };
type AssrSummary = {
  total?: number;
  active_count?: number;
  breach_count?: number;
  avg_e2e_days?: number | null;
  stage_funnel?: StageFunnelRow[];
};

function StageStatStrip({
  stage,
  onPick,
}: {
  stage: StageFilter;
  onPick: (s: StageFilter) => void;
}) {
  const q = useQuery<AssrSummary>(
    () => api.get("/api/assr/summary?since_days=730"),
    []
  );

  // The /summary aggregate runs ~13 queries and flakes with a 500 on a
  // cold Supabase pool during cutover (same transient issue as the list).
  // It's a read-only count, so silently retry a few times rather than
  // stranding the cards on "Unavailable" — the next attempt usually warms
  // the pool and succeeds.
  const retriesRef = useRef(0);
  useEffect(() => {
    if (q.data) {
      retriesRef.current = 0;
      return;
    }
    if (q.error && retriesRef.current < 4) {
      retriesRef.current += 1;
      const id = setTimeout(() => q.reload(), 700);
      return () => clearTimeout(id);
    }
  }, [q.error, q.data, q.reload]);

  const byStage = new Map<string, StageFunnelRow>(
    (q.data?.stage_funnel ?? []).map((r) => [r.stage, r])
  );
  const stages = STAGE_OPTIONS.filter((o) => o.value !== "ALL");
  const ready = !!q.data;
  const allTotal = (q.data?.stage_funnel ?? []).reduce((s, r) => s + r.total, 0);
  const openCount = q.data?.active_count ?? 0;

  const completedCount = byStage.get("completed")?.total ?? 0;
  const breachTotal = q.data?.breach_count ?? 0;
  const sub = (s: string) => (!ready ? (q.loading ? "Loading…" : "Unavailable") : s);

  return (
    <div className="mb-4 space-y-3">
      {/* Summary KPIs — Open / SLA Risk / Avg Resolution / Completed. */}
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatCard
          label="Open Cases"
          value={ready ? openCount.toLocaleString() : "—"}
          subtitle={sub(`${allTotal.toLocaleString()} total`)}
        />
        <StatCard
          label="SLA Risk"
          value={ready ? breachTotal.toLocaleString() : "—"}
          subtitle={sub(breachTotal > 0 ? "needs attention" : "on track")}
          tone={ready && breachTotal > 0 ? "error" : "default"}
        />
        <StatCard
          label="Avg Resolution"
          value={ready && q.data?.avg_e2e_days != null ? `${q.data.avg_e2e_days}d` : "—"}
          subtitle={sub("end-to-end")}
        />
        <StatCard
          label="Completed"
          value={ready ? completedCount.toLocaleString() : "—"}
          subtitle={sub("closed cases")}
        />
      </div>

      {/* Stage pipeline — compact horizontal funnel; click a stage to filter
          the list/board/calendar, click again (or 全部) to clear. */}
      <div className="rounded-xl border border-border bg-surface p-4 shadow-stone">
        <div className="mb-3 text-[13px] font-bold text-ink">阶段流程</div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {[
            { value: "ALL" as StageFilter, label: "全部", total: allTotal, breached: 0 },
            ...stages.map((s) => ({
              value: s.value as StageFilter,
              label: s.label,
              total: byStage.get(s.value)?.total ?? 0,
              breached: byStage.get(s.value)?.breached ?? 0,
            })),
          ].map((s) => {
            const isActive = stage === s.value;
            return (
              <button
                key={s.value}
                onClick={() => onPick(isActive ? "ALL" : s.value)}
                className={cn(
                  "flex items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors",
                  isActive
                    ? "border-primary bg-primary-soft"
                    : "border-border bg-surface-2 hover:border-primary/40",
                )}
              >
                <span
                  className={cn(
                    "grid h-6 min-w-[24px] shrink-0 place-items-center rounded-full px-1.5 font-mono text-[11px] font-bold",
                    isActive
                      ? "bg-primary text-white"
                      : s.breached > 0
                        ? "bg-err/15 text-err"
                        : "bg-surface text-ink-secondary",
                  )}
                >
                  {ready ? s.total : "—"}
                </span>
                <span className="text-[12px] font-semibold leading-tight text-ink">
                  {s.label}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Cases · SLA Board ─────────────────────────────────────────
// Kanban-by-urgency. Every open case is dropped into one of five
// columns by how close it is to its SLA deadline. Ops triage reads
// left-to-right: clear the red column first.

function CasesBoardView({
  filters,
  onOpen,
}: {
  filters: CaseFilters;
  onOpen: (id: number) => void;
}) {
  // Forward-looking triage board — completed cases carry no live SLA, so
  // drop them unless the user is explicitly filtering to that stage. This
  // also spends the 200-row server budget on open work, not closed noise.
  const effective: CaseFilters = {
    ...filters,
    exclude_stage: filters.stage === "completed" ? filters.exclude_stage : "completed",
  };
  const q = useQuery<Paginated<AssrCase>>(
    () => api.get(`/api/assr${buildQuery({ ...effective, page: 1, per_page: 500 })}`),
    [
      effective.stage,
      effective.search,
      effective.include_archived,
      effective.exclude_stage,
      effective.assigned_to,
      effective.creditor_code,
    ]
  );
  const cases = q.data?.data ?? [];
  const total = q.data?.total ?? cases.length;

  const buckets = useMemo(() => {
    const b: Record<Urgency, AssrCase[]> = {
      overdue: [],
      today: [],
      soon: [],
      later: [],
      none: [],
    };
    for (const c of cases) b[caseUrgency(c)].push(c);
    for (const k of URGENCY_ORDER) {
      b[k].sort(
        (a, z) =>
          (a.hours_to_deadline ?? Number.POSITIVE_INFINITY) -
          (z.hours_to_deadline ?? Number.POSITIVE_INFINITY)
      );
    }
    return b;
  }, [cases]);

  if (q.loading) {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {URGENCY_ORDER.map((u) => (
          <div
            key={u}
            className="h-64 animate-pulse rounded-lg border border-border bg-surface-dim/40"
          />
        ))}
      </div>
    );
  }
  if (q.error) {
    return (
      <EmptyState
        message="Couldn't load cases"
        description={q.error}
        icon={<LayoutGrid size={24} />}
      />
    );
  }
  if (cases.length === 0) {
    return (
      <EmptyState
        message="No open cases"
        description="Nothing matches the current filters."
        icon={<LayoutGrid size={24} />}
      />
    );
  }

  return (
    <div>
      {total > cases.length && (
        <p className="mb-2 text-[11px] text-ink-muted">
          Showing the first {cases.length} of {total} cases — narrow the
          filters to see the rest.
        </p>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {URGENCY_ORDER.map((u) => {
          const meta = URGENCY_META[u];
          const items = buckets[u];
          return (
            <div
              key={u}
              className="flex flex-col overflow-hidden rounded-lg border border-border bg-surface-dim/40"
            >
              <div
                className="flex items-center gap-2 border-b border-border px-3 py-2"
                style={{ borderTop: `2px solid ${meta.hex}` }}
              >
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: meta.hex }}
                />
                <span
                  className="text-[11px] font-semibold uppercase tracking-wider"
                  style={{ color: meta.text }}
                  title={meta.hint}
                >
                  {meta.label}
                </span>
                <span className="ml-auto font-mono text-[11px] font-bold text-ink-muted">
                  {items.length}
                </span>
              </div>
              <div className="flex-1 space-y-2 p-2">
                {items.length === 0 ? (
                  <p className="px-1 py-4 text-center text-[11px] text-ink-muted/70">
                    Nothing here
                  </p>
                ) : (
                  items.map((c) => (
                    <CaseCard key={c.id} c={c} onOpen={onOpen} />
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Compact case card — shared by the Board columns and the Calendar
// day-modal. Left rail + countdown colour encode SLA urgency.
function CaseCard({ c, onOpen }: { c: AssrCase; onOpen: (id: number) => void }) {
  const u = caseUrgency(c);
  const meta = URGENCY_META[u];
  const countdown = formatCountdown(c.hours_to_deadline);
  return (
    <button
      type="button"
      onClick={() => onOpen(c.id)}
      style={{ borderLeftColor: meta.hex }}
      className="block w-full rounded-md border border-border border-l-[3px] bg-surface px-3 py-2.5 text-left shadow-stone transition hover:-translate-y-px hover:border-accent/40 hover:shadow-md"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5">
        <span className="whitespace-nowrap font-mono text-[11px] font-semibold text-ink">
          {c.assr_no}
        </span>
        {countdown && c.stage !== "completed" && (
          <span
            className="shrink-0 whitespace-nowrap text-[10px] font-semibold"
            style={{ color: meta.text }}
          >
            {countdown}
          </span>
        )}
      </div>
      <div className="mt-1 truncate text-[12px] font-medium text-ink">
        {c.customer_name || "—"}
      </div>
      {c.item_code && (
        <div className="truncate font-mono text-[10px] text-ink-muted">
          {c.item_code}
        </div>
      )}
      <div className="mt-1.5 flex items-center gap-1.5">
        <span className={cn("h-2 w-2 shrink-0 rounded-full", priorityColor(c.priority))} />
        <span className="truncate text-[10px] text-ink-secondary">
          {caseStageLabel(c.stage)}
        </span>
        {c.assigned_to_name && (
          <span className="ml-auto truncate text-[10px] text-ink-muted">
            {c.assigned_to_name}
          </span>
        )}
      </div>
    </button>
  );
}

// ── Cases · Calendar ──────────────────────────────────────────
// Month grid plotting every open case on its SLA deadline (or the
// reported date). Chips are coloured by SLA urgency; hover reveals the
// case basics, "+N more" opens a day list. Mirrors the Projects
// calendar's visual language (blank adjacent cells, prominent today,
// wheel-to-navigate).

function CasesCalendarView({
  filters,
  onOpen,
}: {
  filters: CaseFilters;
  onOpen: (id: number) => void;
}) {
  const [params, setParams] = useSearchParams();
  // Reported date is the default basis: nearly every case has a
  // complained_date, whereas SLA deadlines are sparsely set — so the
  // calendar lands populated rather than mostly empty.
  const basis: "deadline" | "reported" =
    params.get("cbasis") === "deadline" ? "deadline" : "reported";

  function patch(next: Record<string, string>) {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v === "") p.delete(k);
      else p.set(k, v);
    }
    setParams(p, { replace: true });
  }

  const monthStr = params.get("cmonth") || "";
  const anchor = useMemo(() => {
    if (/^\d{4}-\d{2}$/.test(monthStr)) {
      return new Date(Number(monthStr.slice(0, 4)), Number(monthStr.slice(5, 7)) - 1, 1);
    }
    const d = new Date();
    d.setDate(1);
    return d;
  }, [monthStr]);

  const setAnchor = (d: Date) =>
    patch({ cmonth: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}` });

  // Like the board, the calendar is about live work — hide completed
  // cases unless that stage is explicitly selected.
  const effective: CaseFilters = {
    ...filters,
    exclude_stage: filters.stage === "completed" ? filters.exclude_stage : "completed",
  };
  const q = useQuery<Paginated<AssrCase>>(
    () => api.get(`/api/assr${buildQuery({ ...effective, page: 1, per_page: 500 })}`),
    [
      effective.stage,
      effective.search,
      effective.include_archived,
      effective.exclude_stage,
      effective.assigned_to,
      effective.creditor_code,
    ]
  );
  const cases = q.data?.data ?? [];
  const total = q.data?.total ?? cases.length;

  // Group by the active date basis (local day key).
  const byDate = useMemo(() => {
    const m = new Map<string, AssrCase[]>();
    for (const c of cases) {
      const raw =
        basis === "reported" ? c.complained_date : c.deadline_at || c.complained_date;
      if (!raw) continue;
      const key = raw.slice(0, 10);
      const arr = m.get(key);
      if (arr) arr.push(c);
      else m.set(key, [c]);
    }
    // Sort each day by urgency then countdown so the worst sits on top.
    for (const arr of m.values()) {
      arr.sort(
        (a, z) =>
          URGENCY_ORDER.indexOf(caseUrgency(a)) - URGENCY_ORDER.indexOf(caseUrgency(z)) ||
          (a.hours_to_deadline ?? Number.POSITIVE_INFINITY) -
            (z.hours_to_deadline ?? Number.POSITIVE_INFINITY)
      );
    }
    return m;
  }, [cases, basis]);

  // 6×7 month grid, Monday-first, starting on the Monday on/before the 1st.
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const startOffset = (first.getDay() + 6) % 7;
  const gridStart = new Date(first);
  gridStart.setDate(first.getDate() - startOffset);
  const cells: { date: Date; iso: string; inMonth: boolean }[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    cells.push({ date: d, iso: isoLocal(d), inMonth: d.getMonth() === anchor.getMonth() });
  }
  const today = isoLocal(new Date());
  const monthLabel = anchor.toLocaleDateString("en-MY", { month: "long", year: "numeric" });

  // Wheel over the grid steps months (throttled, non-passive).
  const gridRef = useRef<HTMLDivElement>(null);
  const wheelTsRef = useRef(0);
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;
  const setAnchorRef = useRef(setAnchor);
  setAnchorRef.current = setAnchor;
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      e.preventDefault();
      const now = Date.now();
      if (now - wheelTsRef.current < 380) return;
      wheelTsRef.current = now;
      const d = new Date(anchorRef.current);
      d.setMonth(d.getMonth() + (e.deltaY > 0 ? 1 : -1));
      setAnchorRef.current(d);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const [hover, setHover] = useState<{ c: AssrCase; x: number; y: number } | null>(null);
  const [dayModal, setDayModal] = useState<string | null>(null);

  const MAX_CHIPS = 3;
  const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  return (
    <div>
      {/* Toolbar */}
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="inline-flex items-center gap-1">
          <button
            type="button"
            onClick={() => {
              const d = new Date(anchor);
              d.setMonth(d.getMonth() - 1);
              setAnchor(d);
            }}
            className="rounded-md border border-border bg-surface p-1.5 text-ink-muted transition hover:border-accent/40 hover:text-accent"
            aria-label="Previous month"
          >
            <ChevronLeft size={15} />
          </button>
          <button
            type="button"
            onClick={() => {
              const d = new Date(anchor);
              d.setMonth(d.getMonth() + 1);
              setAnchor(d);
            }}
            className="rounded-md border border-border bg-surface p-1.5 text-ink-muted transition hover:border-accent/40 hover:text-accent"
            aria-label="Next month"
          >
            <ChevronRight size={15} />
          </button>
        </div>
        <h2 className="font-display text-lg font-semibold text-ink">{monthLabel}</h2>
        <button
          type="button"
          onClick={() => {
            const d = new Date();
            d.setDate(1);
            setAnchor(d);
          }}
          className="rounded-md border border-border bg-surface px-2.5 py-1 text-[11px] font-semibold text-ink-secondary transition hover:border-accent/40 hover:text-accent"
        >
          Today
        </button>

        {/* Date basis */}
        <div className="ml-auto inline-flex overflow-hidden rounded-md border border-border bg-bg/40 text-[10.5px] font-semibold">
          {([
            { v: "reported", label: "Reported date" },
            { v: "deadline", label: "SLA deadline" },
          ] as const).map(({ v, label }) => (
            <button
              key={v}
              type="button"
              onClick={() => patch({ cbasis: v === "reported" ? "" : v })}
              aria-pressed={basis === v}
              className={cn(
                "px-2.5 py-1.5 transition-colors",
                basis === v ? "bg-accent text-white" : "text-ink-muted hover:text-accent"
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Legend */}
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
        {URGENCY_ORDER.map((u) => (
          <span key={u} className="inline-flex items-center gap-1.5 text-[10.5px] text-ink-secondary">
            <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: URGENCY_META[u].hex }} />
            {URGENCY_META[u].label}
          </span>
        ))}
        <span className="ml-auto text-[10.5px] text-ink-muted">Scroll to change month</span>
      </div>

      {q.error ? (
        <EmptyState message="Couldn't load cases" description={q.error} icon={<CalendarDays size={24} />} />
      ) : (
        <>
          {total > cases.length && (
            <p className="mb-2 text-[11px] text-ink-muted">
              Showing the first {cases.length} of {total} cases — narrow the filters to see the rest.
            </p>
          )}
          <div
            ref={gridRef}
            className={cn(
              "overflow-hidden rounded-lg border border-border bg-surface",
              q.loading && "animate-pulse opacity-60"
            )}
          >
            {/* Weekday header */}
            <div className="grid grid-cols-7 border-b border-border bg-surface-dim/60">
              {WEEKDAYS.map((d) => (
                <div
                  key={d}
                  className="px-2 py-1.5 text-center text-[10px] font-semibold uppercase tracking-wider text-ink-muted"
                >
                  {d}
                </div>
              ))}
            </div>
            {/* Cells */}
            <div className="grid grid-cols-7">
              {cells.map((cell, i) => {
                const items = byDate.get(cell.iso) ?? [];
                const isToday = cell.iso === today;
                return (
                  <div
                    key={cell.iso}
                    className={cn(
                      "min-h-[104px] border-b border-r border-border/70 p-1.5",
                      i % 7 === 6 && "border-r-0",
                      i >= 35 && "border-b-0",
                      !cell.inMonth && "bg-surface-dim/40"
                    )}
                  >
                    {cell.inMonth && (
                      <>
                        <div className="mb-1 flex items-center justify-between">
                          <span
                            className={cn(
                              "inline-flex h-5 min-w-[20px] items-center justify-center rounded-full px-1 text-[11px] font-semibold",
                              isToday
                                ? "bg-accent text-white"
                                : "text-ink-secondary"
                            )}
                          >
                            {cell.date.getDate()}
                          </span>
                          {items.length > 0 && (
                            <span className="font-mono text-[9px] text-ink-muted">
                              {items.length}
                            </span>
                          )}
                        </div>
                        <div className="space-y-1">
                          {items.slice(0, MAX_CHIPS).map((c) => {
                            const meta = URGENCY_META[caseUrgency(c)];
                            return (
                              <button
                                key={c.id}
                                type="button"
                                onClick={() => onOpen(c.id)}
                                onMouseEnter={(e) =>
                                  setHover({ c, x: e.clientX, y: e.clientY })
                                }
                                onMouseMove={(e) =>
                                  setHover({ c, x: e.clientX, y: e.clientY })
                                }
                                onMouseLeave={() => setHover(null)}
                                style={{ background: meta.tint, borderLeft: `3px solid ${meta.hex}` }}
                                className="block w-full truncate rounded-[4px] px-1.5 py-1 text-left text-[10.5px] font-medium leading-tight text-ink transition hover:-translate-y-px"
                                title={`${c.assr_no} · ${c.customer_name || ""}`}
                              >
                                <span className="font-mono text-[9.5px] text-ink-muted">
                                  {c.assr_no}
                                </span>{" "}
                                {c.customer_name || "—"}
                              </button>
                            );
                          })}
                          {items.length > MAX_CHIPS && (
                            <button
                              type="button"
                              onClick={() => setDayModal(cell.iso)}
                              className="w-full rounded-[4px] px-1.5 py-0.5 text-left text-[10px] font-semibold text-accent hover:bg-accent-soft/40"
                            >
                              +{items.length - MAX_CHIPS} more
                            </button>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}

      {hover && <CaseChipPopover info={hover} basis={basis} />}

      {dayModal && (
        <CaseDayModal
          iso={dayModal}
          cases={byDate.get(dayModal) ?? []}
          basis={basis}
          onClose={() => setDayModal(null)}
          onOpen={onOpen}
        />
      )}
    </div>
  );
}

// Cursor-anchored hover card for a calendar chip.
function CaseChipPopover({
  info,
  basis,
}: {
  info: { c: AssrCase; x: number; y: number };
  basis: "deadline" | "reported";
}) {
  const { c, x, y } = info;
  const meta = URGENCY_META[caseUrgency(c)];
  const countdown = formatCountdown(c.hours_to_deadline);
  const left = Math.min(x + 14, window.innerWidth - 272);
  const top = Math.min(y + 14, window.innerHeight - 220);
  return createPortal(
    <div
      className="pointer-events-none fixed z-[70] w-64 rounded-lg border border-border bg-surface p-3 shadow-xl"
      style={{ left, top }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[12px] font-semibold text-ink">{c.assr_no}</span>
        <span
          className="rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider"
          style={{ background: meta.tint, color: meta.text }}
        >
          {c.stage === "completed" ? "Completed" : meta.label}
        </span>
      </div>
      <div className="mt-1.5 text-[13px] font-semibold text-ink">
        {c.customer_name || "—"}
      </div>
      <div className="mt-2 space-y-1 text-[11px] text-ink-secondary">
        <div className="flex justify-between gap-2">
          <span className="text-ink-muted">Stage</span>
          <span className="text-right">{caseStageLabel(c.stage)}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-ink-muted">Priority</span>
          <span className="capitalize">{c.priority}</span>
        </div>
        {c.item_code && (
          <div className="flex justify-between gap-2">
            <span className="text-ink-muted">Item</span>
            <span className="font-mono text-right">{c.item_code}</span>
          </div>
        )}
        <div className="flex justify-between gap-2">
          <span className="text-ink-muted">
            {basis === "reported" ? "Reported" : "SLA due"}
          </span>
          <span className="text-right">
            {formatDate(basis === "reported" ? c.complained_date : c.deadline_at)}
            {countdown && c.stage !== "completed" && basis === "deadline" && (
              <span className="ml-1" style={{ color: meta.text }}>
                ({countdown})
              </span>
            )}
          </span>
        </div>
        {c.assigned_to_name && (
          <div className="flex justify-between gap-2">
            <span className="text-ink-muted">Assigned</span>
            <span className="text-right">{c.assigned_to_name}</span>
          </div>
        )}
      </div>
      {c.complaint_issue && (
        <p className="mt-2 line-clamp-3 border-t border-border pt-2 text-[11px] text-ink-secondary">
          {c.complaint_issue}
        </p>
      )}
    </div>,
    document.body
  );
}

// Day overflow modal — every case landing on one day, as cards.
function CaseDayModal({
  iso,
  cases,
  basis,
  onClose,
  onOpen,
}: {
  iso: string;
  cases: AssrCase[];
  basis: "deadline" | "reported";
  onClose: () => void;
  onOpen: (id: number) => void;
}) {
  const label = new Date(iso + "T00:00:00").toLocaleDateString("en-MY", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-start justify-center overflow-y-auto bg-ink/30 p-4 backdrop-blur-sm sm:p-10"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl border border-border bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
              {basis === "reported" ? "Reported" : "SLA due"} · {cases.length} case
              {cases.length === 1 ? "" : "s"}
            </div>
            <h3 className="font-display text-sm font-semibold text-ink">{label}</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-ink-muted transition hover:bg-surface-dim hover:text-ink"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>
        <div className="max-h-[60vh] space-y-2 overflow-y-auto p-3">
          {cases.map((c) => (
            <CaseCard
              key={c.id}
              c={c}
              onOpen={(id) => {
                onClose();
                onOpen(id);
              }}
            />
          ))}
        </div>
      </div>
    </div>,
    document.body
  );
}

// ── Bulk actions toolbar ─────────────────────────────────────
// Sits above the table when one or more rows are checked. Mirrors
// the staff actions from the detail panel — archive/restore are the
// safest bulk ops; assign-to-me is a one-click triage shortcut.

function BulkActionsBar({
  count,
  allSelected,
  someSelected,
  onToggleAll,
  onClear,
  showArchived,
  onArchive,
  onUnarchive,
  onAssignToMe,
}: {
  count: number;
  allSelected: boolean;
  someSelected: boolean;
  onToggleAll: () => void;
  onClear: () => void;
  showArchived: boolean;
  onArchive: () => void;
  onUnarchive: () => void;
  onAssignToMe: (() => void) | null;
}) {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-3 rounded-md border border-accent/30 bg-accent-soft/30 px-3 py-2 text-[12px]">
      <label className="inline-flex items-center gap-1.5 font-semibold text-ink">
        <input
          type="checkbox"
          checked={allSelected}
          ref={(el) => {
            if (el) el.indeterminate = someSelected;
          }}
          onChange={onToggleAll}
          className="accent-accent"
        />
        {count} selected
      </label>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {onAssignToMe && (
          <button
            onClick={onAssignToMe}
            className="rounded-md border border-border bg-surface px-2.5 py-1 text-[11px] font-semibold text-ink hover:border-accent/40"
          >
            Assign to me
          </button>
        )}
        {showArchived ? (
          <button
            onClick={onUnarchive}
            className="rounded-md border border-synced/40 bg-synced/5 px-2.5 py-1 text-[11px] font-semibold text-synced hover:bg-synced/10"
          >
            Restore
          </button>
        ) : (
          <button
            onClick={onArchive}
            className="rounded-md border border-err/40 bg-surface px-2.5 py-1 text-[11px] font-semibold text-err hover:bg-err/5"
          >
            Archive
          </button>
        )}
        <button
          onClick={onClear}
          className="rounded-md border border-border bg-surface px-2.5 py-1 text-[11px] font-semibold text-ink-secondary hover:text-ink"
        >
          Clear
        </button>
      </div>
    </div>
  );
}

// ── Create Panel ──────────────────────────────────────────────

function CreatePanel({
  onClose,
  onCreated,
  toast,
}: {
  onClose: () => void;
  onCreated: (id: number) => void;
  toast: ReturnType<typeof useToast>;
}) {
  const [docNo, setDocNo] = useState("");
  const [lookupItems, setLookupItems] = useState<{ item_code: string; item_description: string | null; qty?: number }[] | null>(null);
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [issue, setIssue] = useState("");
  // "" → unset; OTHER_SENTINEL → user picked Other but hasn't typed yet;
  // any other string → either a canonical category or a custom label.
  const [issueCategory, setIssueCategory] = useState<string>("");
  const [customCategory, setCustomCategory] = useState("");
  // Mig 082 — priority drives the per-stage SLA targets via
  // assr_priority_stage_targets. Default "normal" matches the column
  // default; picking Urgent at intake compresses every internal stage.
  const [priority, setPriority] = useState<string>("normal");
  const [lookingUp, setLookingUp] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [customerInfo, setCustomerInfo] = useState<{ name?: string; phone?: string; location?: string } | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null);
  // Mig 065 — pull issue categories from the lookup endpoint so the
  // intake form mirrors what admins maintain in Service Maintenance.
  // Fall back to the legacy ISSUE_CATEGORIES constant if the call
  // hasn't returned yet.
  const issueCategoriesQ = useQuery<{ data: { slug: string; name: string }[] }>(
    () => api.get("/api/assr/lookups/issue-categories"),
    [],
  );
  const issueCatOptions =
    issueCategoriesQ.data?.data.map((r) => r.name) ?? [];

  const MAX_FILES = 5;
  const MAX_SIZE = 5 * 1024 * 1024; // 5 MB
  const ALLOWED_EXT = new Set(["jpg", "jpeg", "png", "webp", "mp4", "pdf"]);

  function addFiles(picked: FileList | null) {
    if (!picked || picked.length === 0) return;
    const next: File[] = [];
    for (const f of Array.from(picked)) {
      const ext = f.name.split(".").pop()?.toLowerCase() || "";
      if (!ALLOWED_EXT.has(ext)) {
        toast.error(`${f.name}: unsupported type`);
        continue;
      }
      if (f.size > MAX_SIZE) {
        toast.error(`${f.name}: exceeds 5MB`);
        continue;
      }
      next.push(f);
    }
    setFiles((prev) => [...prev, ...next].slice(0, MAX_FILES));
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  async function lookup() {
    if (!docNo.trim()) return;
    setLookingUp(true);
    setLookupItems(null);
    setCustomerInfo(null);
    try {
      const res = await api.get<{ items: { item_code: string; item_description: string | null; qty?: number }[] }>(
        `/api/assr/lookup-items/${encodeURIComponent(docNo.trim())}`
      );
      setLookupItems(res.items);
      setSelectedItems(new Set());
    } catch (e: any) {
      toast.error(`Lookup failed: ${e?.message || e}`);
    } finally {
      setLookingUp(false);
    }
  }

  async function submit() {
    if (!docNo.trim() || !issue.trim()) return;
    const items = [...selectedItems].map((code) => {
      const found = lookupItems?.find((i) => i.item_code === code);
      return {
        item_code: code,
        item_description: found?.item_description ?? null,
        qty: found?.qty && found.qty > 0 ? found.qty : 1,
      };
    });
    if (!items.length) {
      toast.error("Select at least one item");
      return;
    }
    // Resolve the chosen issue category. "Other" requires the user to
    // have typed a custom label; otherwise we send null.
    let resolvedCategory: string | null = null;
    if (issueCategory === OTHER_SENTINEL) {
      const trimmed = customCategory.trim();
      resolvedCategory = trimmed || null;
    } else if (issueCategory) {
      resolvedCategory = issueCategory;
    }

    setSubmitting(true);
    try {
      const res = await api.post<{ assr_no: string; id: number }>("/api/assr", {
        doc_no: docNo.trim(),
        items,
        complaint_issue: issue.trim(),
        issue_category: resolvedCategory,
        priority,
      });

      // Upload any staged defect photos/videos as "complaint" attachments.
      if (files.length > 0) {
        setUploadProgress({ done: 0, total: files.length });
        let failed = 0;
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          try {
            const ext = file.name.split(".").pop()?.toLowerCase() || "jpg";
            const buf = await file.arrayBuffer();
            await api.putBinary(
              `/api/assr/${res.id}/attachments?category=complaint&ext=${ext}&name=${encodeURIComponent(file.name)}`,
              buf,
              file.type
            );
          } catch (err) {
            failed++;
            console.warn(`Upload failed for ${file.name}`, err);
          }
          setUploadProgress({ done: i + 1, total: files.length });
        }
        if (failed > 0) {
          toast.error(`Created ${res.assr_no}, but ${failed} file(s) failed to upload`);
        } else {
          toast.success(`Created ${res.assr_no} with ${files.length} attachment(s)`);
        }
      } else {
        toast.success(`Created ${res.assr_no}`);
      }

      onCreated(res.id);
    } catch (e: any) {
      toast.error(`Failed: ${e?.message || e}`);
    } finally {
      setSubmitting(false);
      setUploadProgress(null);
    }
  }

  function toggleItem(code: string) {
    setSelectedItems((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  return (
    <Panel open onClose={onClose} title="New Service Case" width={480}>
      <PanelSection title="Sales Order">
        <div className="flex gap-2">
          <input
            value={docNo}
            onChange={(e) => setDocNo(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && lookup()}
            placeholder="Enter SO number…"
            className="flex-1 rounded-md border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-primary"
          />
          <Button variant="secondary" icon={<Search size={14} />} onClick={lookup} disabled={lookingUp}>
            {lookingUp ? "…" : "Lookup"}
          </Button>
        </div>
      </PanelSection>

      {lookupItems !== null && (
        <PanelSection title={`Items (${lookupItems.length})`}>
          {lookupItems.length === 0 ? (
            <div className="text-[12px] text-ink-muted">
              No PO items found for this SO. You can still create the case — enter item details manually.
            </div>
          ) : (
            <div className="space-y-1.5">
              {lookupItems.map((item) => (
                <label
                  key={item.item_code}
                  className="flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-accent-soft/20"
                >
                  <input
                    type="checkbox"
                    checked={selectedItems.has(item.item_code)}
                    onChange={() => toggleItem(item.item_code)}
                    className="accent-accent"
                  />
                  <span className="font-mono text-[11px] font-medium">{item.item_code}</span>
                  {item.item_description && (
                    <span
                      className="flex-1 truncate text-ink-secondary"
                      title={item.item_description}
                    >
                      {item.item_description}
                    </span>
                  )}
                  {item.qty != null && item.qty > 0 && (
                    <span className="ml-auto text-[11px] text-ink-muted">&times;{item.qty}</span>
                  )}
                </label>
              ))}
            </div>
          )}

          {/* Manual item entry if no items found */}
          {lookupItems.length === 0 && (
            <div className="mt-2">
              <input
                placeholder="Item code (manual)"
                className="w-full rounded-md border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-primary"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.target as HTMLInputElement).value.trim()) {
                    const code = (e.target as HTMLInputElement).value.trim();
                    setSelectedItems(new Set([...selectedItems, code]));
                    setLookupItems([...lookupItems, { item_code: code, item_description: null }]);
                    (e.target as HTMLInputElement).value = "";
                  }
                }}
              />
            </div>
          )}
        </PanelSection>
      )}

      <PanelSection title="Issue Description">
        <textarea
          value={issue}
          onChange={(e) => setIssue(e.target.value)}
          rows={4}
          placeholder="Describe the issue…"
          className="w-full rounded-md border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-primary"
        />
        <div className="mt-3">
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
            Issue Category
          </div>
          <select
            value={issueCategory}
            onChange={(e) => {
              const v = e.target.value;
              setIssueCategory(v);
              if (v !== OTHER_SENTINEL) setCustomCategory("");
            }}
            className="w-full appearance-none rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          >
            <option value="">— select —</option>
            {(issueCatOptions.length ? issueCatOptions : [...ISSUE_CATEGORIES]).map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
            <option value={OTHER_SENTINEL}>Other…</option>
          </select>
          {issueCategory === OTHER_SENTINEL && (
            <input
              value={customCategory}
              onChange={(e) => setCustomCategory(e.target.value)}
              placeholder="e.g. transport damage"
              className="mt-1.5 w-full rounded-md border border-border bg-bg px-3 py-2 text-[13px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          )}
        </div>
        {/* Mig 082 — picking the priority here drives both the e2e SLA
            window AND the per-stage target snapshot at create time. */}
        <div className="mt-3">
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
            Priority
          </div>
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            className="w-full appearance-none rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          >
            {[...PRIORITY_OPTIONS].map((p) => (
              <option key={p} value={p}>
                {p.charAt(0).toUpperCase() + p.slice(1)}
              </option>
            ))}
          </select>
        </div>
      </PanelSection>

      <PanelSection title={`Defect Photos / Videos (${files.length}/${MAX_FILES})`}>
        {files.length > 0 && (
          <div className="mb-2 grid grid-cols-3 gap-2">
            {files.map((f, i) => (
              <FilePreview key={i} file={f} onRemove={() => removeFile(i)} />
            ))}
          </div>
        )}
        <label className={cn(
          "inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-[11px] font-semibold text-ink hover:border-accent/40",
          files.length >= MAX_FILES && "pointer-events-none opacity-50"
        )}>
          <Upload size={12} />
          Add Photos / Videos
          <input
            type="file"
            accept="image/*,video/mp4,.pdf"
            multiple
            className="hidden"
            onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }}
            disabled={files.length >= MAX_FILES}
          />
        </label>
        <div className="mt-1.5 text-[10px] text-ink-muted">
          JPG / PNG / WEBP / MP4 / PDF · 5MB each · up to {MAX_FILES} files
        </div>
      </PanelSection>

      <div className="border-t border-border px-5 py-4">
        <Button
          variant="primary"
          onClick={submit}
          disabled={submitting || !docNo.trim() || !issue.trim() || selectedItems.size === 0}
        >
          {uploadProgress
            ? `Uploading ${uploadProgress.done}/${uploadProgress.total}…`
            : submitting
            ? "Creating…"
            : "Create Case"}
        </Button>
      </div>
    </Panel>
  );
}

// ── Detail Panel ──────────────────────────────────────────────

function DetailContent({
  id,
  onUpdated,
  toast,
}: {
  id: number;
  onUpdated: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const dialog = useDialog();
  const detail = useQuery<AssrDetail>(
    () => api.get(`/api/assr/${id}`),
    [id]
  );
  const users = useQuery<{ id: number; name: string; department_name?: string }[]>(
    () => api.get<any>("/api/users").then((r: any) => r.users ?? r.data ?? r ?? []),
    []
  );
  // Mig 065 — picker values come from the lookup endpoints maintained
  // in Service Maintenance. Each query is small; the four together
  // are still cheap. Fall back to the legacy hardcoded constants when
  // the API hasn't returned yet so the form stays usable.
  type LookupOpt = { slug: string; name: string };
  const issueCategoriesQ = useQuery<{ data: LookupOpt[] }>(
    () => api.get("/api/assr/lookups/issue-categories"),
    [],
  );
  const resolutionMethodsQ = useQuery<{ data: LookupOpt[] }>(
    () => api.get("/api/assr/lookups/resolution-methods"),
    [],
  );
  const prioritiesQ = useQuery<{ data: LookupOpt[] }>(
    () => api.get("/api/assr/lookups/priorities"),
    [],
  );
  const ncrCategoriesQ = useQuery<{ data: LookupOpt[] }>(
    () => api.get("/api/assr/lookups/ncr-categories"),
    [],
  );
  const issueOptions = (issueCategoriesQ.data?.data ?? []).map((r) => r.name);
  const resolutionOptions = (resolutionMethodsQ.data?.data ?? []).map((r) => r.slug);
  const priorityOptions = (prioritiesQ.data?.data ?? []).map((r) => r.slug);
  // Map slug → display name so the Lead Time pill can render "Urgent"
  // instead of the raw "urgent" slug. Recomputes only when the
  // priorities lookup changes.
  const priorityMap = useMemo(() => {
    const m: Record<string, string> = {};
    for (const p of prioritiesQ.data?.data ?? []) m[p.slug] = p.name;
    return m;
  }, [prioritiesQ.data]);
  const ncrOptions = (ncrCategoriesQ.data?.data ?? []).map((r) => r.slug);
  const [note, setNote] = useState("");
  const [noteFormOpen, setNoteFormOpen] = useState(false);
  // Mig 064 — note posting now picks a category. Default 'purchasing'
  // (internal team comms) since most notes are operational. Switch to
  // 'customer' to make the entry visible on the customer portal.
  const [noteCategory, setNoteCategory] = useState<"purchasing" | "customer">(
    "purchasing",
  );
  // Activity timeline filter. 'all' = show everything; the others
  // narrow to one category. System-emitted events (stage_change,
  // assigned, etc.) live under 'system'.
  const [activityFilter, setActivityFilter] = useState<
    "all" | "purchasing" | "customer" | "system"
  >("all");
  const [transitioning, setTransitioning] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [showClosePrompt, setShowClosePrompt] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [showAddItem, setShowAddItem] = useState(false);
  const [showAddLogistics, setShowAddLogistics] = useState(false);
  // SO-based item picker for the Add Item panel — mirrors the
  // intake form's `lookup-items` flow so ops adds items by checkbox
  // instead of re-typing them. Manual fallback covers ad-hoc entries
  // that aren't on the original SO.
  type LookupItem = { item_code: string; item_description: string | null; qty?: number };
  const [lookupItems, setLookupItems] = useState<LookupItem[] | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [pickedCodes, setPickedCodes] = useState<Set<string>>(new Set());
  const [manualCode, setManualCode] = useState("");
  const [manualDesc, setManualDesc] = useState("");

  const c = detail.data?.case;
  const items = detail.data?.items ?? [];
  const attachments = detail.data?.attachments ?? [];
  const activity = detail.data?.activity ?? [];
  const logistics = detail.data?.logistics ?? [];
  const relatedPOs = detail.data?.related_pos ?? [];

  async function patch(body: Record<string, any>) {
    await api.patch(`/api/assr/${id}`, body);
    detail.reload();
    onUpdated();
  }

  async function transition(stage: AssrStage) {
    setTransitioning(true);
    try {
      await api.post(`/api/assr/${id}/transition`, { stage });
      detail.reload();
      onUpdated();
    } catch (e: any) {
      toast.error(e?.message || "Transition failed");
    } finally {
      setTransitioning(false);
    }
  }

  // Auto-stage-transition watcher (TODO item 5). When the predicate
  // for the current stage flips from unsatisfied → satisfied, prompt
  // the user to advance. Row 2 (Under Verification → Pending Solution)
  // is owned by VerificationCard so it can use the richer outcome
  // semantics; the other six rows route through here.
  useStageAutoAdvance({ c, logistics, transition, dialog });

  async function addNote() {
    if (!note.trim()) return;
    await api.post(`/api/assr/${id}/notes`, {
      note: note.trim(),
      category: noteCategory,
    });
    setNote("");
    setNoteFormOpen(false);
    detail.reload();
  }

  async function uploadFile(e: React.ChangeEvent<HTMLInputElement>, category: string) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const ext = file.name.split(".").pop()?.toLowerCase() || "jpg";
      const buf = await file.arrayBuffer();
      await api.putBinary(
        `/api/assr/${id}/attachments?category=${category}&ext=${ext}&name=${encodeURIComponent(file.name)}`,
        buf,
        file.type
      );
      detail.reload();
      toast.success("File uploaded");
    } catch (err: any) {
      toast.error(`Upload failed: ${err?.message || err}`);
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  }

  // Open the Add Item panel and lazily fetch the case's SO items —
  // same `/api/assr/lookup-items/:doc_no` endpoint used by the
  // intake form. Cached after the first open; user can re-fetch via
  // the Refresh button if the SO has changed since.
  async function openAddItem() {
    setShowAddItem(true);
    setPickedCodes(new Set());
    if (!c?.doc_no) return;
    if (lookupItems !== null) return; // already loaded
    setLookupLoading(true);
    try {
      const res = await api.get<{ items: LookupItem[] }>(
        `/api/assr/lookup-items/${encodeURIComponent(c.doc_no)}`,
      );
      setLookupItems(res.items);
    } catch (e: any) {
      toast.error(`Lookup failed: ${e?.message || e}`);
      setLookupItems([]);
    } finally {
      setLookupLoading(false);
    }
  }

  async function reloadLookup() {
    if (!c?.doc_no) return;
    setLookupLoading(true);
    setLookupItems(null);
    try {
      const res = await api.get<{ items: LookupItem[] }>(
        `/api/assr/lookup-items/${encodeURIComponent(c.doc_no)}`,
      );
      setLookupItems(res.items);
    } catch (e: any) {
      toast.error(`Lookup failed: ${e?.message || e}`);
      setLookupItems([]);
    } finally {
      setLookupLoading(false);
    }
  }

  function closeAddItem() {
    setShowAddItem(false);
    setPickedCodes(new Set());
    setManualCode("");
    setManualDesc("");
  }

  async function addPickedItems() {
    const fromLookup = (lookupItems ?? [])
      .filter((it) => pickedCodes.has(it.item_code))
      .map((it) => ({
        item_code: it.item_code,
        item_description: it.item_description,
        qty: it.qty && it.qty > 0 ? it.qty : 1,
      }));
    const manualEntry = manualCode.trim()
      ? [{
          item_code: manualCode.trim(),
          item_description: manualDesc.trim() || null,
          qty: 1,
        }]
      : [];
    const payload = [...fromLookup, ...manualEntry];
    if (payload.length === 0) return;
    try {
      await api.post(`/api/assr/${id}/items`, { items: payload });
      closeAddItem();
      detail.reload();
    } catch (e: any) {
      toast.error(`Failed: ${e?.message || e}`);
    }
  }

  async function removeItem(itemId: number) {
    try {
      await api.del(`/api/assr/${id}/items/${itemId}`);
      detail.reload();
    } catch (e: any) {
      toast.error(`Failed: ${e?.message || e}`);
    }
  }

  function handleCloseClick() {
    setShowClosePrompt(true);
  }

  // NEXT_STAGE lookup retired in mig 064 — the header picker now
  // accepts any stage. Kept the constant defined at module scope for
  // any external consumers (tests, etc.); no live UI consumes it.
  const userOptions = Array.isArray(users.data)
    ? users.data.map((u) => ({ id: u.id, name: u.name }))
    : [];
  // PIC picker is restricted to Operations-department members. The
  // currently-assigned person is always kept selectable so an existing
  // assignment outside Operations doesn't silently vanish.
  const opsUserOptions = Array.isArray(users.data)
    ? users.data
        .filter(
          (u: any) =>
            /operation/i.test(u.department_name || "") || u.id === c?.assigned_to,
        )
        .map((u) => ({ id: u.id, name: u.name }))
    : [];

  return (
    <DetailLayout
      breadcrumbs={[
        { label: "Service Cases", to: "/assr" },
        { label: c?.assr_no || "Loading…" },
      ]}
      eyebrow="Service Case"
      title={c?.assr_no || "Loading…"}
      description={
        c
          ? [
              c.customer_name || "—",
              c.ref_no ? `Ref ${c.ref_no}` : null,
              `Stage: ${caseStageLabel(c.stage)}`,
              c.assigned_to_name ? `Assigned ${c.assigned_to_name}` : null,
            ]
              .filter(Boolean)
              .join("  ·  ")
          : undefined
      }
      backTo="/assr"
      loading={detail.loading && !c}
      error={detail.error}
      actions={
        c ? (
          <>
            {c.archived_at ? (
              <HeaderButton
                variant="ghost"
                onClick={async () => {
                  try {
                    await api.post(`/api/assr/${id}/unarchive`);
                    toast.success("Case restored");
                    detail.reload();
                    onUpdated();
                  } catch (e: any) {
                    toast.error(e?.message || "Failed");
                  }
                }}
              >
                Restore
              </HeaderButton>
            ) : (
              <HeaderButton
                variant="ghost"
                onClick={async () => {
                  if (!(await dialog.confirm("Archive this case? It will be hidden from the default list but kept on record."))) return;
                  try {
                    await api.post(`/api/assr/${id}/archive`);
                    toast.success("Case archived");
                    detail.reload();
                    onUpdated();
                  } catch (e: any) {
                    toast.error(e?.message || "Failed");
                  }
                }}
              >
                Archive
              </HeaderButton>
            )}
            {/* Stage picker moved into the Workflow Progress card below
                (rendered as "Change to"), matching the case-detail layout. */}
            {c.stage === "pending_delivery_service" && !c.archived_at && (
              <HeaderButton
                variant="primary"
                onClick={handleCloseClick}
                disabled={transitioning}
              >
                {transitioning ? "…" : "Close Case"}
                <ChevronRight size={12} />
              </HeaderButton>
            )}
          </>
        ) : undefined
      }
    >
      {false && <div className="hidden">{/* loading handled by DetailLayout */}</div>}
      {detail.loading && <div className="p-6 text-sm text-ink-muted">Loading...</div>}
      {detail.error && !detail.loading && (
        <div className="m-5 rounded-md border border-err/40 bg-err/5 p-4 text-sm">
          <div className="font-semibold text-err">Failed to load case</div>
          <div className="mt-1 text-[12px] text-ink-secondary break-words">{detail.error}</div>
          <div className="mt-2 text-[11px] text-ink-muted">
            If you just added QMS features, make sure migrations 011–013 have been applied.
          </div>
        </div>
      )}
      {c && (
        <>
          {/* Close Case Prompt — collects final customer satisfaction only. */}
          {showClosePrompt && (
            <ClosePrompt
              onConfirm={async (rating, notes) => {
                if (rating) await patch({ satisfaction_rating: rating, satisfaction_notes: notes || null });
                await transition("completed");
                setShowClosePrompt(false);
              }}
              onCancel={() => setShowClosePrompt(false)}
              transitioning={transitioning}
            />
          )}

          {/* Archived banner */}
          {c.archived_at && (
            <div className="border-b border-border bg-ink-muted/5 px-5 py-2 text-[11px] text-ink-muted">
              <span className="font-semibold uppercase tracking-wider text-ink-secondary">Archived</span>
              {" · "}
              {formatDateTime(c.archived_at)} — read-only. Use Restore to reactivate.
            </div>
          )}

          {/* v3.1 Workflow Progress Tracker — 9-step stepper, top of detail */}
          <div className="border-b border-border bg-bg/40 px-5 py-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <span className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-secondary">
                Workflow Progress
              </span>
              {!c.archived_at && (
                <label className="inline-flex items-center gap-2">
                  <span className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
                    Change to
                  </span>
                  <select
                    value={c.stage}
                    onChange={(e) => transition(e.target.value as AssrStage)}
                    disabled={transitioning}
                    className="h-8 rounded-md border border-border bg-surface px-2 text-[12px] font-semibold outline-none focus:border-primary disabled:opacity-60"
                    title="Move this case to any stage"
                  >
                    <option value="pending_review">Pending Review</option>
                    <option value="under_verification">Under Verification</option>
                    <option value="pending_solution">Pending Solution</option>
                    <option value="pending_inspection">Pending Inspection</option>
                    <option value="pending_item_pickup">Pending Item Pickup</option>
                    <option value="pending_supplier_pickup">Pending Supplier Pickup</option>
                    <option value="pending_item_ready">Pending Item Ready</option>
                    <option value="pending_delivery_service">Pending Delivery / Service</option>
                    <option value="completed">Completed</option>
                  </select>
                </label>
              )}
            </div>
            <ServiceProgressTracker
              history={(detail.data as any)?.stage_history ?? []}
              currentStage={c.stage}
              variant="full"
            />
          </div>

          {/* Stage + Priority header */}
          <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-3">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1 text-[12.5px] font-bold text-ink shadow-stone">
              <StatusDot variant={stageVariant(c.stage)} />
              {caseStageLabel(c.stage)}
            </span>
            <span className="inline-flex items-center gap-1">
              <span className={cn("h-2 w-2 rounded-full", priorityColor(c.priority))} />
              <span className="text-[11px] font-semibold capitalize text-ink-secondary">{c.priority}</span>
            </span>
            <LeadTimePill c={c} priorityMap={priorityMap} />
            {c.resolution_method && (
              <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-semibold text-accent">
                {resolutionLabel(c.resolution_method)}
              </span>
            )}
            {c.deadline_at && c.stage !== "completed" && (
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold",
                  c.is_breached === 1
                    ? "bg-err text-white"
                    : (c.hours_to_deadline ?? 9999) < 24
                    ? "bg-amber-500/10 text-amber-700"
                    : "bg-synced/10 text-synced"
                )}
                title={`Deadline: ${formatDateTime(c.deadline_at)}`}
              >
                <Calendar size={10} />
                {c.is_breached === 1
                  ? `Overdue ${Math.abs(c.hours_to_deadline ?? 0)}h`
                  : `${c.hours_to_deadline ?? 0}h left`}
              </span>
            )}
            <PrintMenu
              caseId={id}
              toast={toast}
            />
            <PortalLinksMenu
              id={id}
              existingToken={detail.data?.portal_token ?? null}
              toast={toast}
              onGenerated={() => detail.reload()}
            />
          </div>
          <DetailGrid>
            <DetailMain>
          {/* ── Issue (captured at intake) ─────────────────────
              Everything in this block was filled in (or auto-derived
              from) the original create form: the customer's reported
              complaint, the issue category, and the priority used for
              SLA calculation. service_category was removed when the
              intake form was simplified — the issue_category taxonomy
              now drives both the dashboard breakdown and triage. */}
          <PanelSection title="Issue" icon={<AlertCircle size={13} />}>
            <InlineEdit
              label="Complaint"
              textarea
              value={c.complaint_issue}
              onSave={(v) => patch({ complaint_issue: v })}
              placeholder="What the customer reported"
            />
            <IssueCategoryField
              value={c.issue_category}
              onSave={(v) => patch({ issue_category: v })}
              dialog={dialog}
              categories={
                issueOptions.length ? issueOptions : [...ISSUE_CATEGORIES]
              }
            />
            <InlineEdit
              label="Priority"
              value={c.priority}
              options={priorityOptions.length ? priorityOptions : [...PRIORITY_OPTIONS]}
              onSave={(v) => patch({ priority: v })}
            />
            {/* Photos / videos — kept inside the Issue card (intake
                evidence next to the complaint). */}
            <div className="border-t border-border-subtle/50 pt-2.5">
              <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-ink-muted">
                Photos / Videos ({attachments.length})
              </div>
            {attachments.length > 0 && (
              <div className="mb-2 grid grid-cols-3 gap-2">
                {attachments.map((att: any, i: number) => (
                  <AttachmentThumb
                    key={att.id}
                    att={att}
                    onClick={() => {
                      if ((att.content_type || "").startsWith("image/")) {
                        setLightboxIndex(i);
                      }
                    }}
                    onVisibilityChange={async (visible) => {
                      try {
                        await api.patch(`/api/assr/attachments/${att.id}/visibility`, { visible_to_customer: visible });
                        toast.success(visible ? "Now visible to customer" : "Hidden from customer");
                        detail.reload();
                      } catch (e: any) {
                        toast.error(e?.message || "Failed");
                      }
                    }}
                    onArchive={c.archived_at ? undefined : async () => {
                      if (!await dialog.confirm("Archive this attachment? It'll be hidden everywhere.")) return;
                      try {
                        await api.post(`/api/assr/attachments/${att.id}/archive`);
                        toast.success("Archived");
                        detail.reload();
                      } catch (e: any) {
                        toast.error(e?.message || "Failed");
                      }
                    }}
                  />
                ))}
              </div>
            )}
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-[11px] font-semibold text-ink hover:border-accent/40">
              <Upload size={12} />
              {uploading ? "Uploading..." : "Upload"}
              <input
                type="file"
                accept="image/*,video/mp4,.pdf"
                className="hidden"
                onChange={(e) => uploadFile(e, c.stage === "completed" ? "completion" : "evidence")}
                disabled={uploading}
              />
            </label>
            </div>
          </PanelSection>

          {/* Product Info — product attributes + procurement (PO). */}
          <PanelSection title="Product Info" icon={<Package size={13} />}>
            {items.length === 0 ? (
              <div className="text-[12px] text-ink-muted">No items</div>
            ) : (
              <div className="space-y-1">
                {items.map((item) => (
                  <div key={item.id} className="flex items-center gap-2 rounded border border-border px-3 py-1.5 text-sm">
                    <span className="font-mono text-[11px] font-medium">{item.item_code}</span>
                    <span
                      className="flex-1 truncate text-ink-secondary"
                      title={item.item_description || undefined}
                    >
                      {item.item_description || ""}
                    </span>
                    <span className="text-[11px] text-ink-muted">&times;{item.qty}</span>
                    {c.stage !== "completed" && (
                      <button
                        onClick={() => removeItem(item.id)}
                        className="rounded p-0.5 text-ink-muted hover:text-err"
                        title="Remove item"
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
            {c.stage !== "completed" && !showAddItem && (
              <button
                onClick={openAddItem}
                className="mt-2 inline-flex items-center gap-1 text-[11px] font-semibold text-accent hover:underline"
              >
                <Plus size={12} /> Add Item
              </button>
            )}
            {/* Product attributes */}
            <div className="mt-1 space-y-2.5 border-t border-border-subtle/50 pt-2.5">
              <InlineEdit
                label="Product Category"
                value={c.service_category}
                onSave={(v) => patch({ service_category: v })}
                placeholder="e.g. Mattress / Bed frame"
              />
            </div>
            {showAddItem && (() => {
              // Hide items already on the case so users only see what's
              // still pickable from the SO. Manual fallback below covers
              // anything not on the original SO.
              const existingCodes = new Set(items.map((it: any) => it.item_code));
              const available = (lookupItems ?? []).filter(
                (it) => !existingCodes.has(it.item_code),
              );
              const canAdd = pickedCodes.size > 0 || manualCode.trim().length > 0;
              return (
                <div className="mt-2 space-y-2 rounded border border-border bg-bg/60 p-3">
                  <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
                    <span>
                      Items from SO{" "}
                      <span className="font-mono normal-case text-ink">
                        {c.doc_no || "(none)"}
                      </span>
                    </span>
                    <button
                      onClick={reloadLookup}
                      disabled={lookupLoading || !c.doc_no}
                      title="Refetch items from the SO"
                      className="inline-flex items-center gap-1 rounded p-1 text-ink-muted hover:text-accent disabled:opacity-40"
                    >
                      <RefreshCw size={11} className={cn(lookupLoading && "animate-spin")} />
                    </button>
                  </div>
                  {lookupLoading && lookupItems === null && (
                    <div className="text-[12px] text-ink-muted">Loading SO items…</div>
                  )}
                  {!lookupLoading && lookupItems !== null && available.length === 0 && (
                    <div className="text-[11.5px] text-ink-muted">
                      {(lookupItems?.length ?? 0) === 0
                        ? "No items found on this SO. Use the manual entry below."
                        : "All SO items are already on this case. Use the manual entry below to add anything else."}
                    </div>
                  )}
                  {available.length > 0 && (
                    <div className="space-y-1.5">
                      {available.map((item) => {
                        const checked = pickedCodes.has(item.item_code);
                        return (
                          <label
                            key={item.item_code}
                            className="flex cursor-pointer items-center gap-2 rounded-md border border-border bg-surface px-3 py-1.5 text-sm hover:bg-accent-soft/20"
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => {
                                const next = new Set(pickedCodes);
                                if (next.has(item.item_code)) next.delete(item.item_code);
                                else next.add(item.item_code);
                                setPickedCodes(next);
                              }}
                              className="accent-accent"
                            />
                            <span className="font-mono text-[11px] font-medium">
                              {item.item_code}
                            </span>
                            {item.item_description && (
                              <span
                                className="flex-1 truncate text-ink-secondary"
                                title={item.item_description}
                              >
                                {item.item_description}
                              </span>
                            )}
                            {item.qty != null && item.qty > 0 && (
                              <span className="ml-auto text-[11px] text-ink-muted">
                                &times;{item.qty}
                              </span>
                            )}
                          </label>
                        );
                      })}
                    </div>
                  )}
                  {/* Manual fallback for items not on the SO. */}
                  <div className="rounded border border-dashed border-border bg-surface/40 p-2">
                    <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
                      Or add manually (not on SO)
                    </div>
                    <div className="space-y-1.5">
                      <input
                        value={manualCode}
                        onChange={(e) => setManualCode(e.target.value)}
                        placeholder="Item code"
                        className="w-full rounded-md border border-border bg-surface px-3 py-1.5 text-sm outline-none focus:border-primary"
                      />
                      <input
                        value={manualDesc}
                        onChange={(e) => setManualDesc(e.target.value)}
                        placeholder="Description (optional)"
                        className="w-full rounded-md border border-border bg-surface px-3 py-1.5 text-sm outline-none focus:border-primary"
                      />
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={addPickedItems}
                      disabled={!canAdd}
                      className="rounded-md bg-accent px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50"
                    >
                      Add
                      {pickedCodes.size > 0 && ` (${pickedCodes.size})`}
                      {manualCode.trim() && pickedCodes.size === 0 && " (1)"}
                      {manualCode.trim() && pickedCodes.size > 0 && " + 1"}
                    </button>
                    <button
                      onClick={closeAddItem}
                      className="rounded-md border border-border px-3 py-1.5 text-[11px] text-ink-secondary"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              );
            })()}
            {/* Procurement / PO — product-side info (moved out of
                Resolution, which now only holds supplier handling). */}
            <div className="mt-2 border-t border-border-subtle pt-2">
              <InlineEdit
                label="PO No"
                value={c.po_no}
                onSave={(v) => patch({ po_no: v })}
              />
              {!c.po_no && c.creditor_code && c.stage !== "completed" && (
                <button
                  onClick={async () => {
                    try {
                      const res = await api.post<{ po_no: string }>(`/api/assr/${id}/generate-po`);
                      toast.success(`Generated ${res.po_no}`);
                      detail.reload();
                      onUpdated();
                    } catch (e: any) {
                      toast.error(e?.message || "Failed to generate PO");
                    }
                  }}
                  className="mt-1 inline-flex items-center gap-1 text-[11px] font-semibold text-accent hover:underline"
                >
                  <Plus size={12} /> Auto-generate PO number
                </button>
              )}
            </div>
          </PanelSection>

          {/* ── Verification (gate between Under Verification and
              Pending Solution). Mig 081. QA's acceptance decision —
              when outcome=accepted AND root cause is filled, a modal
              offers to advance the stage. 'rejected' offers to short-
              circuit to Completed; 'needs_more_info' is a hold. */}
          <VerificationCard
            c={c}
            patch={patch}
            transition={transition}
            dialog={dialog}
          />

          {/* ── Resolution (filled as the case progresses) ────── */}
          <PanelSection title="Resolution" icon={<ClipboardCheck size={13} />}>
            <InlineEdit
              label="Resolution Method"
              value={c.resolution_method}
              options={resolutionOptions.length ? resolutionOptions : [...RESOLUTION_OPTIONS]}
              onSave={(v) => patch({ resolution_method: v })}
            />
            {/* Creditor (AutoCount) — derived from item_code via
                StockItem.MainSupplier. Read-only; re-resolved when
                item_code changes. Deep-links into the creditors tab
                in Purchase Orders. */}
            <div>
              <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
                Supplier
                {c.creditor_code && (
                  <Link
                    to={`/po?view=creditors&focus=${encodeURIComponent(c.creditor_code)}`}
                    className="ml-auto text-[10px] font-semibold normal-case tracking-normal text-accent hover:underline"
                  >
                    Open →
                  </Link>
                )}
              </div>
              <div className="rounded-md border border-border bg-bg/40 px-3 py-2 text-[12.5px]">
                {c.creditor_code ? (
                  <>
                    <div className="font-semibold text-ink">
                      {c.creditor_name || c.creditor_code}
                    </div>
                    <div className="font-mono text-[10px] text-ink-muted">
                      {c.creditor_code}
                    </div>
                  </>
                ) : c.item_code ? (
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[11px] text-ink-muted">
                      Not resolved yet for{" "}
                      <span className="font-mono text-ink">{c.item_code}</span>.
                    </div>
                    <button
                      onClick={async () => {
                        try {
                          const res = await api.post<{
                            creditor_code: string | null;
                            message?: string;
                          }>(`/api/assr/${id}/resolve-creditor`);
                          if (res.creditor_code) {
                            toast.success(res.message || "Creditor resolved");
                          } else {
                            toast.error(
                              res.message || "No MainSupplier set on this item in AutoCount"
                            );
                          }
                          detail.reload();
                          onUpdated();
                        } catch (e: any) {
                          toast.error(`Resolve failed: ${e?.message || e}`);
                        }
                      }}
                      className="shrink-0 rounded-md border border-accent/40 bg-accent-soft/40 px-2 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-accent transition-colors hover:bg-accent-soft/70"
                    >
                      Resolve now
                    </button>
                  </div>
                ) : (
                  <div className="text-[11px] text-ink-muted">
                    Not resolved. Set an item code to auto-link the creditor.
                  </div>
                )}
              </div>
            </div>
            <InlineEdit
              label="Supplier status update"
              textarea
              value={c.action_remark}
              onSave={(v) => patch({ action_remark: v })}
            />
            {/* Mig 064 — supplier handover dates. Surfaced inline so
                ops can record them without opening a separate panel.
                Both feed the case-list columns + future SLA reports. */}
            <InlineEdit
              label="Supplier Pickup Date"
              type="date"
              value={c.supplier_pickup_at}
              onSave={(v) => patch({ supplier_pickup_at: v || null })}
            />
            {(c.supplier_pickup_at || attachments.some((a: any) => a?.category === "pickup_form")) && (
              <MilestoneAttachmentSlot
                caseId={id}
                category="pickup_form"
                label="Pickup Form / Consignment Note"
                emptyLabel="No pickup form yet."
                uploadLabel="Upload pickup form"
                attachments={attachments}
                archived={!!c.archived_at}
                detail={detail}
                dialog={dialog}
                toast={toast}
              />
            )}
            {/* Item-ready date is set in the QC Inspection card (pass →
                item ready); the completion doc stays here with the
                supplier-handover paperwork. */}
            {(c.items_ready_at || attachments.some((a: any) => a?.category === "ready_doc")) && (
              <MilestoneAttachmentSlot
                caseId={id}
                category="ready_doc"
                label="Supplier Work Completion"
                emptyLabel="No completion doc yet."
                uploadLabel="Upload completion doc"
                attachments={attachments}
                archived={!!c.archived_at}
                detail={detail}
                dialog={dialog}
                toast={toast}
              />
            )}
          </PanelSection>

          {/* ── QC Inspection (after Resolution): pass → item ready. */}
          <InspectionCard
            c={c}
            patch={patch}
            caseId={id}
            attachments={attachments}
            archived={!!c.archived_at}
            detail={detail}
            dialog={dialog}
            toast={toast}
          />

          {/* Reference & Logistics — collapsible (v2): identifiers +
              logistics rows + related POs, folded by default. */}
          <CollapsibleBlock title="Reference & Logistics">
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
              {([
                ["SO", c.doc_no, true],
                ["DO", c.delivery_order, true],
                ["DO date", formatDate(c.do_date), false],
                ["PO", c.po_no, true],
                ["Location", c.location, false],
                ["Category", c.service_category, false],
              ] as const).map(([label, val, mono]) => (
                <div key={label}>
                  <div className="text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">{label}</div>
                  <div className={cn("text-[12.5px] text-ink", mono && "font-mono text-[11.5px]")}>{val || "—"}</div>
                </div>
              ))}
            </div>

          {/* Logistics */}
          {(c.stage === "pending_item_pickup" || c.stage === "pending_supplier_pickup" || c.stage === "pending_item_ready" || c.stage === "pending_delivery_service" || c.stage === "completed" || logistics.length > 0) && (
            <PanelSection title={`Logistics (${logistics.length})`}>
              {logistics.map((l) => (
                <LogisticsRow
                  key={l.id}
                  l={l}
                  caseId={id}
                  archived={!!c.archived_at}
                  users={userOptions}
                  attachments={attachments}
                  detail={detail}
                  dialog={dialog}
                  toast={toast}
                />
              ))}
              {c.stage !== "completed" && !showAddLogistics && (
                <button
                  onClick={() => setShowAddLogistics(true)}
                  className="mt-2 inline-flex items-center gap-1 text-[11px] font-semibold text-accent hover:underline"
                >
                  <Plus size={12} /> Schedule Pickup / Delivery
                </button>
              )}
              {showAddLogistics && (
                <LogisticsForm
                  assrId={id}
                  users={userOptions}
                  onCreated={() => { setShowAddLogistics(false); detail.reload(); }}
                  onCancel={() => setShowAddLogistics(false)}
                  toast={toast}
                />
              )}
            </PanelSection>
          )}

          {/* Related POs */}
          {relatedPOs.length > 0 && (
            <PanelSection title={`Related POs (${relatedPOs.length})`}>
              <div className="space-y-1">
                {relatedPOs.map((po) => (
                  <div key={po.id} className="flex items-start gap-2 rounded border border-border px-3 py-2 text-sm">
                    <Package size={12} className="mt-0.5 shrink-0 text-ink-muted" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[11px] font-medium">{po.doc_no}</span>
                        {po.doc_date && (
                          <span className="text-[10px] text-ink-muted">{formatDate(po.doc_date)}</span>
                        )}
                      </div>
                      <div
                        className="truncate text-[11px] text-ink-secondary"
                        title={`${po.item_code}${po.item_description ? ` — ${po.item_description}` : ""}`}
                      >
                        {po.item_code} {po.item_description ? `— ${po.item_description}` : ""}
                      </div>
                      {po.creditor_name && (
                        <div className="text-[10px] text-ink-muted">{po.creditor_name}</div>
                      )}
                      {po.supplier_date1 && (
                        <div className="text-[10px] text-ink-muted">
                          Supplier date: {formatDate(po.supplier_date1)}
                        </div>
                      )}
                    </div>
                    {po.remaining_qty != null && (
                      <span className="shrink-0 text-[10px] text-ink-muted">
                        Rem: {po.remaining_qty}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </PanelSection>
          )}
          </CollapsibleBlock>

            </DetailMain>

            <DetailAside>
          {/* Customer & Order */}
          <PanelSection title="Customer" icon={<User size={13} />}>
            <FieldRow label="SO No" mono>{c.doc_no}</FieldRow>
            <FieldRow label="Ref No" mono>{c.ref_no || "—"}</FieldRow>
            <FieldRow label="Customer">{c.customer_name || "—"}</FieldRow>
            <FieldRow label="Phone">{c.phone || "—"}</FieldRow>
            <InlineEdit
              label="Email"
              value={c.customer_email}
              onSave={(v) => patch({ customer_email: v })}
              placeholder="customer@example.com"
            />
            <FieldRow label="Location">{c.location || "—"}</FieldRow>
            <FieldRow label="Agent">{c.sales_agent || "—"}</FieldRow>
            <FieldRow label="Date">{formatDate(c.complained_date)}</FieldRow>
            {c.addr1 && <FieldRow label="Address">{[c.addr1, c.addr2, c.addr3, c.addr4].filter(Boolean).join(", ")}</FieldRow>}
          </PanelSection>

          {/* PIC — Operations team members only */}
          <PanelSection title="PIC" icon={<UserPlus size={13} />}>
            <div>
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
                Assigned To
              </div>
              <select
                className="w-full appearance-none rounded-md border border-border bg-surface px-3 py-2 pr-8 text-[13px] text-ink outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/20"
                value={c.assigned_to ?? ""}
                onChange={(e) => {
                  const v = e.target.value;
                  patch({ assigned_to: v ? parseInt(v, 10) : null });
                }}
              >
                <option value="">— unassigned —</option>
                {opsUserOptions.map((u) => (
                  <option key={u.id} value={u.id}>{u.name}</option>
                ))}
              </select>
            </div>
          </PanelSection>

          {/* SLA — compact; whole card turns red when overdue */}
          {(() => {
            const breached = c.stage !== "completed" && c.is_breached === 1;
            const h = c.hours_to_deadline ?? 0;
            const days = Math.round(Math.abs(h) / 24);
            return (
              <div
                className={cn(
                  "mb-3 rounded-lg border px-4 py-2.5 shadow-stone",
                  breached ? "border-err/40 bg-err/5" : "border-border bg-surface",
                )}
              >
                <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
                  <Clock size={12} /> SLA
                </div>
                <div className="mt-0.5 text-[11.5px] text-ink-secondary">
                  Deadline {c.deadline_at ? formatDate(c.deadline_at) : "—"} ·{" "}
                  <span className="capitalize">{c.priority}</span>
                </div>
                <div className="mt-0.5 text-[14px] font-bold leading-tight">
                  {c.stage === "completed" ? (
                    <span className="text-synced">Closed</span>
                  ) : breached ? (
                    <span className="text-err">{days} {days === 1 ? "day" : "days"} overdue</span>
                  ) : c.deadline_at ? (
                    <span className="text-synced">{Math.max(0, Math.round(h / 24))} days left</span>
                  ) : (
                    <span className="text-ink-muted">No SLA set</span>
                  )}
                </div>
              </div>
            );
          })()}

          {/* Timeline — chronological log of stage changes, notes,
              customer comments, escalations, etc. Add-note form is
              behind the header button so the timeline reads cleanly. */}
          <section className="mb-3 rounded-lg border border-border bg-surface px-4 py-3.5 shadow-stone">
            <div className="mb-3 flex items-center gap-2">
              <Clock size={13} className="shrink-0 text-ink-muted" />
              <h3 className="flex-1 text-[10.5px] font-bold uppercase tracking-wide text-ink-secondary">
                Timeline
              </h3>
              {!c.archived_at && (
                <button
                  onClick={() => setNoteFormOpen((x) => !x)}
                  className="inline-flex items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-[11px] font-bold uppercase tracking-wide text-white shadow-sm hover:bg-accent/90"
                >
                  <Plus size={11} /> Add Note
                </button>
              )}
            </div>

            {/* Add-note form — toggled by the header button. Stays
                compact so it doesn't push the timeline below the fold. */}
            {noteFormOpen && !c.archived_at && (
              <div className="mb-3 rounded-md border border-accent/30 bg-accent-soft/15 p-2">
                <div className="mb-2 flex items-center gap-2">
                  <select
                    value={noteCategory}
                    onChange={(e) =>
                      setNoteCategory(e.target.value as "purchasing" | "customer")
                    }
                    className="rounded-md border border-border bg-surface px-2 py-1.5 text-[11px] font-semibold outline-none focus:border-primary"
                    title="Where this note is visible"
                  >
                    <option value="purchasing">Purchasing (internal)</option>
                    <option value="customer">Customer-visible</option>
                  </select>
                  <span className="text-[10px] text-ink-muted">
                    {noteCategory === "customer"
                      ? "The customer will see this note on the portal."
                      : "Internal only — hidden from the customer."}
                  </span>
                </div>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) addNote();
                  }}
                  placeholder={
                    noteCategory === "customer"
                      ? "Write a note for the customer…"
                      : "Internal note…"
                  }
                  rows={2}
                  className="w-full rounded-md border border-border bg-surface px-3 py-1.5 text-[12px] outline-none focus:border-primary"
                />
                <div className="mt-2 flex items-center gap-2">
                  <button
                    onClick={() => {
                      setNote("");
                      setNoteFormOpen(false);
                    }}
                    className="rounded-md border border-border bg-surface px-3 py-1.5 text-[11px] font-semibold text-ink-secondary hover:text-ink"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={addNote}
                    disabled={!note.trim()}
                    className="ml-auto rounded-md bg-accent px-4 py-1.5 text-[11px] font-bold uppercase tracking-wide text-white disabled:opacity-50"
                  >
                    Post note
                  </button>
                </div>
              </div>
            )}

            {/* Filter pills (mig 064) — narrow the timeline to one
                category. System events (stage changes, assignments)
                live under 'system'. */}
            <div className="mb-3 flex flex-wrap gap-1">
              {(
                [
                  { value: "all" as const, label: "All" },
                  { value: "purchasing" as const, label: "Purchasing" },
                  { value: "customer" as const, label: "Customer" },
                  { value: "system" as const, label: "Service Admin" },
                ]
              ).map((opt) => {
                const active = activityFilter === opt.value;
                return (
                  <button
                    key={opt.value}
                    onClick={() => setActivityFilter(opt.value)}
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider transition-colors",
                      active
                        ? "border-accent bg-accent text-white"
                        : "border-border text-ink-muted hover:border-accent/50 hover:text-ink",
                    )}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>

            {/* Timeline list. A vertical guide runs down the left edge;
                each row anchors to a small ring marker so the eye can
                trace the case's history at a glance. */}
            {(() => {
              const rows = activity.filter((a: any) => {
                if (activityFilter === "all") return true;
                return (a.category ?? "system") === activityFilter;
              });
              if (rows.length === 0) {
                return (
                  <div className="text-[12px] text-ink-muted">
                    No activity yet
                  </div>
                );
              }
              return (
                <ol className="relative space-y-3 pl-5">
                  <span className="pointer-events-none absolute left-[7px] top-1.5 bottom-1.5 w-px bg-border" />
                  {rows.map((a: any) => {
                    const author =
                      a.source === "customer"
                        ? a.customer_name_display || a.customer_email || "Customer"
                        : a.user_name || "System";
                    const isEscalated = a.action === "escalated";
                    const isCustomer = a.source === "customer";
                    const archivable =
                      !c.archived_at &&
                      (a.action === "note" || a.action === "customer_comment");
                    let title: React.ReactNode = a.action;
                    let body: React.ReactNode = null;
                    switch (a.action) {
                      case "stage_change":
                        title = (
                          <>
                            Status changed to{" "}
                            <span className="font-bold">
                              {stageLabel(a.to_value || "")}
                            </span>
                          </>
                        );
                        if (a.note) body = a.note;
                        break;
                      case "note":
                        // Title is redundant — the CUSTOMER/PURCHASING
                        // pill on the "by" row already says which kind.
                        // The note body becomes the prominent line.
                        title = null;
                        body = a.note;
                        break;
                      case "created":
                        title = "Case created";
                        if (a.note) body = a.note;
                        break;
                      case "assignment":
                        title = `Assigned to ${
                          userOptions.find((u) => String(u.id) === a.to_value)
                            ?.name || `user #${a.to_value}`
                        }`;
                        break;
                      case "approval":
                        title = (
                          <>
                            Quality review:{" "}
                            <span className="font-bold">
                              {a.to_value === "passed" ? "Passed" : "Reviewed"}
                            </span>
                          </>
                        );
                        break;
                      case "po_generated":
                        title = (
                          <>
                            PO generated:{" "}
                            <span className="font-mono font-bold">
                              {a.to_value}
                            </span>
                          </>
                        );
                        break;
                      case "escalated":
                        title = "Case escalated — SLA breached >24h";
                        break;
                      case "survey_submitted":
                        title = (
                          <>
                            Satisfaction survey ·{" "}
                            <span className="font-bold">{a.to_value}/5</span>
                          </>
                        );
                        if (a.note) body = a.note;
                        break;
                      case "customer_comment":
                        // Same reasoning as 'note' — the customer-coloured
                        // ring marker + author "Customer" already convey
                        // the kind. Comment body becomes the headline.
                        title = null;
                        body = a.note;
                        break;
                      case "customer_upload":
                        title = "Photo uploaded";
                        if (a.note) body = a.note;
                        break;
                    }
                    return (
                      <li key={a.id} className="group relative">
                        <span
                          className={cn(
                            "absolute -left-5 top-1 h-3.5 w-3.5 rounded-full border-2 bg-surface",
                            isEscalated
                              ? "border-err"
                              : isCustomer
                                ? "border-accent"
                                : "border-border"
                          )}
                        />
                        <div className="flex items-center gap-2 text-[10.5px] text-ink-muted">
                          <span>{formatDateTime(a.created_at)}</span>
                          {archivable && (
                            <button
                              onClick={async () => {
                                if (!(await dialog.confirm("Archive this entry?")))
                                  return;
                                try {
                                  await api.post(
                                    `/api/assr/activity/${a.id}/archive`
                                  );
                                  toast.success("Archived");
                                  detail.reload();
                                } catch (e: any) {
                                  toast.error(e?.message || "Failed");
                                }
                              }}
                              className="ml-auto rounded p-0.5 text-ink-muted opacity-0 transition-opacity hover:text-err group-hover:opacity-100"
                              title="Archive entry"
                            >
                              <Trash2 size={10} />
                            </button>
                          )}
                        </div>
                        {title && (
                          <div
                            className={cn(
                              "text-[12.5px] font-bold",
                              isEscalated ? "text-err" : "text-ink"
                            )}
                          >
                            {title}
                          </div>
                        )}
                        <div className="text-[10.5px] text-ink-muted">
                          by {author}
                          {a.category && a.source !== "customer" && (
                            <span
                              className={cn(
                                "ml-1.5 inline-block rounded-full px-1.5 py-0 text-[9px] font-semibold uppercase tracking-wider align-middle",
                                a.category === "purchasing" &&
                                  "bg-amber-100 text-amber-800",
                                a.category === "customer" &&
                                  "bg-accent/15 text-accent",
                                a.category === "system" && "bg-bg text-ink-muted"
                              )}
                            >
                              {a.category === "system" ? "Service Admin" : a.category}
                            </span>
                          )}
                        </div>
                        {body && (
                          <div
                            className={cn(
                              "mt-1 whitespace-pre-line",
                              title
                                ? "text-[12px] text-ink-secondary"
                                : "text-[12.5px] text-ink"
                            )}
                          >
                            {body}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ol>
              );
            })()}
          </section>

          {/* Cost / Quality / CSAT — folded by default (v2); relevant
              mostly at sign-off / close. */}
          {/* Satisfaction (shown when completed) */}
          {c.stage === "completed" && (
            <PanelSection title="Customer Satisfaction">
              {c.satisfaction_rating ? (
                <>
                  <div className="flex items-center gap-1">
                    {[1, 2, 3, 4, 5].map((n) => (
                      <Star
                        key={n}
                        size={16}
                        className={n <= c.satisfaction_rating! ? "fill-amber-400 text-amber-400" : "text-ink-muted"}
                      />
                    ))}
                    <span className="ml-2 text-sm font-semibold">{c.satisfaction_rating}/5</span>
                  </div>
                  {c.satisfaction_notes && (
                    <div className="mt-2 text-[12px] text-ink-secondary">{c.satisfaction_notes}</div>
                  )}
                </>
              ) : (
                <div className="text-[12px] text-ink-muted">No rating yet. Send the customer a survey link:</div>
              )}
              <SurveyLinkButton id={id} toast={toast} />
            </PanelSection>
          )}
            </DetailAside>
          </DetailGrid>
        </>
      )}

      {lightboxIndex !== null && attachments[lightboxIndex] && (
        <StaffLightbox
          attachments={attachments as any[]}
          index={lightboxIndex}
          onChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </DetailLayout>
  );
}

/**
 * Page wrapper — mounted at /assr/:id. Reads the URL, hands the inner
 * content the case id and a no-op `onUpdated` (the page owns its own
 * queries).
 */
export function ServiceCaseDetail() {
  const { id: idStr } = useParams<{ id: string }>();
  const id = idStr ? parseInt(idStr, 10) : NaN;
  const toast = useToast();

  if (isNaN(id)) return <Navigate to="/assr" replace />;

  return <DetailContent id={id} onUpdated={() => {}} toast={toast} />;
}

// ── Customer history ─────────────────────────────────────────
// Surfaces prior cases for the same customer (matched on phone if
// available, else exact name) so staff can spot repeat complaints
// before promising a fix.

type CustomerHistoryRow = {
  id: number;
  assr_no: string;
  doc_no: string;
  stage: AssrStage;
  status: string | null;
  priority: string | null;
  complaint_issue: string | null;
  complained_date: string | null;
  created_at: string | null;
  item_code: string | null;
  resolution_method: string | null;
};

// ── Issue Category picker ────────────────────────────────────
// Five canonical categories + "Other" which prompts for a custom
// label. Stored as plain text on the case so existing free-text
// values still display; selecting "Other" lets ops capture niche
// cases without locking them into the standard set.

const ISSUE_CATEGORIES = [
  "Product defect",
  "Incorrect item delivered",
  "Missing / short item",
  "Warranty / service request",
  "Installation / assembly issue",
] as const;

const OTHER_SENTINEL = "__other__";

// ── Stage auto-advance (TODO item 5) ───────────────────────────
// Each non-completed stage has a "completion predicate" — when it goes
// from unsatisfied to satisfied, prompt the user to advance. They keep
// the existing manual override (Next stage button + stage chip menu).
//
// Row 2 (Under Verification → Pending Solution) is intentionally NOT in
// this table — VerificationCard owns it because the predicate is an
// explicit acceptance decision rather than a field-fill, and it has
// side-paths (rejected/needs_more_info) the other rows don't have.

interface StagePredicate {
  next: AssrStage;
  satisfied: boolean;
  label: string;
}

function getStageAdvancePredicate(
  c: AssrCase,
  logistics: any[]
): StagePredicate | null {
  const activeLog = (logistics ?? []).filter((l) => !l.archived_at);
  switch (c.stage) {
    case "pending_review":
      return {
        next: "under_verification",
        satisfied: !!(c.complaint_issue?.trim() && c.issue_category && c.priority),
        label: "Issue card complete",
      };
    case "pending_solution":
      return {
        next: "pending_inspection",
        satisfied: !!(c.resolution_method && c.po_no && c.action_remark?.trim()),
        label: "Resolution card complete",
      };
    case "pending_inspection":
      return {
        next: "pending_item_pickup",
        satisfied: !!c.supplier_pickup_at,
        label: "Supplier pickup date set",
      };
    case "pending_item_pickup":
      return {
        next: "pending_item_ready",
        satisfied: !!c.items_ready_at,
        label: "Items ready date set",
      };
    case "pending_item_ready":
      return {
        next: "pending_delivery_service",
        satisfied: activeLog.some((l) => l.scheduled_date),
        label: "Delivery scheduled",
      };
    case "pending_delivery_service":
      return {
        next: "completed",
        satisfied: activeLog.some(
          (l) => l.type === "delivery" && l.status === "completed"
        ),
        label: "Delivery completed",
      };
    default:
      return null;
  }
}

function useStageAutoAdvance({
  c,
  logistics,
  transition,
  dialog,
}: {
  c: AssrCase | undefined;
  logistics: any[];
  transition: (stage: AssrStage) => Promise<void>;
  dialog: ReturnType<typeof useDialog>;
}) {
  const lastRef = useRef<{
    caseId: number;
    stage: string;
    satisfied: boolean;
  } | null>(null);

  // Stable key derived from the fields that any predicate cares about.
  // Limited to those so unrelated patches (e.g. issuing a PO note) don't
  // re-run the effect.
  const key = useMemo(() => {
    if (!c) return "";
    return JSON.stringify({
      id: c.id,
      stage: c.stage,
      complaint: c.complaint_issue ?? "",
      cat: c.issue_category ?? "",
      prio: c.priority ?? "",
      res: c.resolution_method ?? "",
      po: c.po_no ?? "",
      act: c.action_remark ?? "",
      sp: c.supplier_pickup_at ?? "",
      ir: c.items_ready_at ?? "",
      log: (logistics ?? [])
        .filter((l) => !l.archived_at)
        .map(
          (l) =>
            `${l.id}|${l.type}|${l.status}|${l.scheduled_date ?? ""}`
        )
        .join(";"),
    });
  }, [c, logistics]);

  useEffect(() => {
    if (!c) return;
    const p = getStageAdvancePredicate(c, logistics);
    if (!p) {
      lastRef.current = null;
      return;
    }
    const last = lastRef.current;
    const sameCaseAndStage =
      last && last.caseId === c.id && last.stage === c.stage;

    if (!sameCaseAndStage) {
      // First sighting of this case/stage: set baseline silently so we
      // don't pop the modal on initial mount of an already-ready case.
      lastRef.current = {
        caseId: c.id,
        stage: c.stage,
        satisfied: p.satisfied,
      };
      return;
    }

    const wasSatisfied = last!.satisfied;
    lastRef.current = {
      caseId: c.id,
      stage: c.stage,
      satisfied: p.satisfied,
    };

    if (p.satisfied && !wasSatisfied) {
      (async () => {
        const nextName = stageLabel(p.next);
        const ok = await dialog.confirm(
          `${p.label}. Advance the case to ${nextName}?`
        );
        if (ok) {
          await transition(p.next);
        }
      })();
    }
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
}

// ── Verification card ──────────────────────────────────────────
// Mig 081. The Under Verification → Pending Solution transition is the
// only stage gate that's a true judgement call (everything else fires
// off a date/text field being filled). Three outcomes:
//
//   accepted        → real defect we'll fix. When root cause is also
//                     filled, prompt to advance the stage.
//   rejected        → not our issue. Prompt to short-circuit to Completed.
//   needs_more_info → wait on the customer; case stays put.
//
// `verified_at` / `verified_by` are server-stamped on PATCH, so the
// timestamp can't drift from the actor.

const VERIFICATION_OPTIONS = [
  { value: "accepted", label: "Accepted", tone: "ok" as const },
  { value: "needs_more_info", label: "Needs more info", tone: "warn" as const },
  { value: "rejected", label: "Rejected", tone: "err" as const },
];

// ── Inspection card ────────────────────────────────────────────
// Surfaces the v3.1 `inspection_result` field (pass / fail / na) +
// an inspection-report attachment slot. Hidden on early-stage cases
// to keep the page uncluttered; renders once the case has reached
// pending_inspection or beyond, OR when there's already a result /
// report on file.

const INSPECTION_STAGES_OR_LATER: AssrStage[] = [
  "pending_inspection",
  "pending_item_pickup",
  "pending_supplier_pickup",
  "pending_item_ready",
  "pending_delivery_service",
  "completed",
];

const INSPECTION_OPTIONS = ["pass", "fail", "na"] as const;

// Collapsible card — bold header + chevron, body hidden until expanded.
// Used to fold lower-priority detail sections (Reference & Logistics on the
// left; Cost / Quality / CSAT on the right) per the v2 layout.
function CollapsibleBlock({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="mb-3 overflow-hidden rounded-lg border border-border bg-surface shadow-stone">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-bg/40"
        aria-expanded={open}
      >
        <span className="flex-1 text-[10.5px] font-bold uppercase tracking-wide text-ink-secondary">
          {title}
        </span>
        <ChevronRight
          size={14}
          className={cn("text-ink-muted transition-transform", open && "rotate-90")}
        />
      </button>
      {open && <div className="space-y-2.5 border-t border-border-subtle px-4 py-3.5">{children}</div>}
    </section>
  );
}

function InspectionCard({
  c,
  patch,
  caseId,
  attachments,
  archived,
  detail,
  dialog,
  toast,
}: {
  c: AssrCase;
  patch: (body: Record<string, any>) => Promise<void>;
  caseId: number;
  attachments: any[];
  archived: boolean;
  detail: ReturnType<typeof useQuery>;
  dialog: ReturnType<typeof useDialog>;
  toast: ReturnType<typeof useToast>;
}) {
  const stageReached = INSPECTION_STAGES_OR_LATER.includes(c.stage);
  const hasResult = c.inspection_result != null;
  const hasReport = (attachments ?? []).some(
    (a: any) => a?.category === "inspection_report"
  );
  if (!stageReached && !hasResult && !hasReport) return null;

  return (
    <PanelSection
      icon={<ShieldCheck size={13} />}
      accent="bg-synced"
      title={
        <>
          QC Inspection{" "}
          <span className="font-normal normal-case tracking-normal text-ink-muted/70">— after repair, pass → Logistics</span>
        </>
      }
    >
      <InlineEdit
        label="QC Result"
        value={c.inspection_result}
        options={[...INSPECTION_OPTIONS]}
        onSave={(v) => patch({ inspection_result: v })}
      />
      <InlineEdit
        label="QC Inspection Date"
        type="date"
        value={c.items_ready_at}
        onSave={(v) => patch({ items_ready_at: v || null })}
      />
      <p className="-mt-1 text-[10.5px] leading-snug text-ink-muted">
        Pass + date → becomes the Item Ready date. Fail → stays pending supplier item-ready.
      </p>
      <MilestoneAttachmentSlot
        caseId={caseId}
        category="inspection_report"
        label="QC Inspection Report"
        emptyLabel="No inspection report uploaded yet."
        uploadLabel="Upload inspection report"
        attachments={attachments}
        archived={archived}
        detail={detail}
        dialog={dialog}
        toast={toast}
      />
    </PanelSection>
  );
}

function VerificationCard({
  c,
  patch,
  transition,
  dialog,
}: {
  c: AssrCase;
  patch: (body: Record<string, any>) => Promise<void>;
  transition: (stage: AssrStage) => Promise<void>;
  dialog: ReturnType<typeof useDialog>;
}) {
  const [rootDraft, setRootDraft] = useState(c.verified_root_cause ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setRootDraft(c.verified_root_cause ?? "");
  }, [c.verified_root_cause, c.id]);

  const outcome = c.verification_outcome ?? null;
  const rootCause = (c.verified_root_cause ?? "").trim();
  const isUnderVerification = c.stage === "under_verification";

  async function setOutcome(next: string | null) {
    if (next === outcome) return;
    setSaving(true);
    try {
      await patch({ verification_outcome: next });
      // Side-paths off the outcome itself.
      if (next === "rejected" && c.stage !== "completed") {
        if (
          await dialog.confirm(
            "Rejected means this isn't our issue. Close the case as Completed?"
          )
        ) {
          await transition("completed");
        }
      } else if (next === "accepted" && isUnderVerification && rootCause) {
        if (
          await dialog.confirm(
            "Mark verified and advance to Pending Solution?"
          )
        ) {
          await transition("pending_solution");
        }
      }
    } finally {
      setSaving(false);
    }
  }

  async function saveRootCause() {
    const next = rootDraft.trim();
    if (next === (c.verified_root_cause ?? "")) return;
    setSaving(true);
    try {
      await patch({ verified_root_cause: next || null });
      // If outcome was already 'accepted' and we just supplied the
      // missing root cause, prompt the same advance dialog so the user
      // doesn't have to re-tap the outcome chip.
      if (next && outcome === "accepted" && isUnderVerification) {
        if (
          await dialog.confirm(
            "Mark verified and advance to Pending Solution?"
          )
        ) {
          await transition("pending_solution");
        }
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <PanelSection
      icon={<ClipboardCheck size={13} />}
      accent="bg-accent"
      title={
        <>
          Issue Inspection{" "}
          <span className="font-normal normal-case tracking-normal text-ink-muted/70">— on receipt</span>
        </>
      }
    >
      <div>
        <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
          Outcome
        </div>
        <div className="flex flex-wrap gap-1.5">
          {VERIFICATION_OPTIONS.map((opt) => {
            const active = outcome === opt.value;
            const toneClass =
              opt.tone === "ok"
                ? active
                  ? "border-ok bg-ok/15 text-ok"
                  : "border-border text-ink-secondary hover:border-ok/40"
                : opt.tone === "warn"
                ? active
                  ? "border-warn bg-warn/15 text-warn"
                  : "border-border text-ink-secondary hover:border-warn/40"
                : active
                ? "border-err bg-err/15 text-err"
                : "border-border text-ink-secondary hover:border-err/40";
            return (
              <button
                key={opt.value}
                type="button"
                disabled={saving}
                onClick={() => setOutcome(active ? null : opt.value)}
                className={cn(
                  "rounded-full border px-3 py-1 text-[11.5px] font-semibold transition-colors disabled:opacity-50",
                  toneClass
                )}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      {outcome && (
        <div>
          <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
            Root cause
          </label>
          <input
            type="text"
            value={rootDraft}
            onChange={(e) => setRootDraft(e.target.value)}
            onBlur={saveRootCause}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            disabled={saving}
            placeholder={
              outcome === "accepted"
                ? "Material defect, transit damage, installation, etc."
                : outcome === "rejected"
                ? "Why this isn't our issue"
                : "What's missing from the customer"
            }
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-ink outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
          {outcome === "accepted" && !rootCause && isUnderVerification && (
            <div className="mt-1.5 text-[11px] text-ink-muted">
              Fill the root cause to advance to Pending Solution.
            </div>
          )}
        </div>
      )}

      {c.verified_at && (
        <div className="rounded-md border border-border bg-bg/40 px-3 py-2 text-[11.5px] text-ink-secondary">
          Verified by {c.verified_by_name || `user #${c.verified_by}`} ·{" "}
          {formatDate(c.verified_at)}
        </div>
      )}
    </PanelSection>
  );
}

// ── Sign-off attachment slot ───────────────────────────────────
// Item 2 of the QMS TODO. Single-file slot inside Quality Review for
// the verification photo / doc the QA wants on record before the case
// flips to Completed. Reuses the existing attachments endpoint with
// category=sign_off so storage + visibility toggles already work.

// ── Milestone attachment slot ──────────────────────────────────
// Generic per-category attachment slot, used at every stage handoff
// where ops needs a paper trail (sign-off, inspection report, pickup
// form, item-ready doc, delivery POD). Filters the case's existing
// attachments by the given category and exposes a small Upload button
// that hits the existing /api/assr/:id/attachments PUT route.

type MilestoneCategory =
  | "sign_off"
  | "inspection_report"
  | "pickup_form"
  | "ready_doc"
  | "delivery_pod";

function MilestoneAttachmentSlot({
  caseId,
  category,
  label,
  emptyLabel,
  uploadLabel,
  attachments,
  archived,
  detail,
  dialog,
  toast,
  compact,
}: {
  caseId: number;
  category: MilestoneCategory;
  label: string;
  emptyLabel?: string;
  uploadLabel?: string;
  attachments: any[];
  archived: boolean;
  detail: ReturnType<typeof useQuery>;
  dialog: ReturnType<typeof useDialog>;
  toast: ReturnType<typeof useToast>;
  /** Slimmer layout for inline use under a date field — drops the
   *  uppercase header label since the surrounding field already
   *  contextualises the slot. */
  compact?: boolean;
}) {
  const [uploading, setUploading] = useState(false);
  const matches = (attachments ?? []).filter(
    (a: any) => a?.category === category
  );

  async function upload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const ext = file.name.split(".").pop()?.toLowerCase() || "jpg";
      const buf = await file.arrayBuffer();
      await api.putBinary(
        `/api/assr/${caseId}/attachments?category=${category}&ext=${ext}&name=${encodeURIComponent(file.name)}`,
        buf,
        file.type
      );
      detail.reload();
      toast.success(`${label} uploaded`);
    } catch (err: any) {
      toast.error(err?.message || "Upload failed");
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  }

  return (
    <div>
      {!compact && (
        <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
          {label}
        </div>
      )}
      {matches.length > 0 ? (
        <div className="mb-2 grid grid-cols-3 gap-2">
          {matches.map((att: any) => (
            <AttachmentThumb
              key={att.id}
              att={att}
              onArchive={archived ? undefined : async () => {
                if (!await dialog.confirm(`Archive this ${label.toLowerCase()}?`)) return;
                try {
                  await api.post(`/api/assr/attachments/${att.id}/archive`);
                  toast.success("Archived");
                  detail.reload();
                } catch (err: any) {
                  toast.error(err?.message || "Failed");
                }
              }}
            />
          ))}
        </div>
      ) : !compact ? (
        <div className="mb-2 rounded-md border border-dashed border-border bg-bg/30 px-3 py-2 text-[11px] text-ink-muted">
          {emptyLabel || `No ${label.toLowerCase()} yet.`}
        </div>
      ) : null}
      {!archived && (
        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-[11px] font-semibold text-ink hover:border-accent/40">
          <Upload size={12} />
          {uploading
            ? "Uploading..."
            : matches.length
            ? "Replace / Add"
            : (uploadLabel || `Upload ${label.toLowerCase()}`)}
          <input
            type="file"
            accept="image/*,.pdf"
            className="hidden"
            onChange={upload}
            disabled={uploading}
          />
        </label>
      )}
    </div>
  );
}

// Thin wrapper preserves the existing Quality Review call site —
// shipped this morning with `category="sign_off"`. Future call sites
// should use MilestoneAttachmentSlot directly.
function SignOffAttachmentSlot(props: {
  caseId: number;
  attachments: any[];
  archived: boolean;
  detail: ReturnType<typeof useQuery>;
  dialog: ReturnType<typeof useDialog>;
  toast: ReturnType<typeof useToast>;
}) {
  return (
    <MilestoneAttachmentSlot
      {...props}
      category="sign_off"
      label="Sign-off Attachment"
      emptyLabel="No sign-off evidence yet."
      uploadLabel="Upload sign-off evidence"
    />
  );
}

// ── Logistics row (view + inline edit) ─────────────────────────
// TODO item 4. Each ASSR logistics row gets an Edit toggle so ops can
// fix the scheduled date / time / assignee / status / remark after
// saving — previously the only way to change one was archive + recreate.
// Uses the existing PATCH /api/assr/:id/logistics/:logId endpoint.

function LogisticsRow({
  l,
  caseId,
  archived,
  users,
  attachments,
  detail,
  dialog,
  toast,
}: {
  l: any;
  caseId: number;
  archived: boolean;
  users: { id: number; name: string | null; email?: string }[];
  attachments: any[];
  detail: ReturnType<typeof useQuery>;
  dialog: ReturnType<typeof useDialog>;
  toast: ReturnType<typeof useToast>;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState({
    scheduled_date: l.scheduled_date ?? "",
    scheduled_time_range: l.scheduled_time_range ?? "",
    assigned_to: l.assigned_to ?? "",
    status: l.status ?? "pending",
    notes: l.notes ?? "",
  });

  async function save() {
    setSaving(true);
    try {
      await api.patch(`/api/assr/${caseId}/logistics/${l.id}`, {
        scheduled_date: draft.scheduled_date || null,
        scheduled_time_range: draft.scheduled_time_range || null,
        assigned_to: draft.assigned_to ? Number(draft.assigned_to) : null,
        status: draft.status,
        notes: draft.notes || null,
      });
      toast.success("Logistics updated");
      detail.reload();
      setEditing(false);
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <div className="rounded border border-accent/40 bg-accent-soft/20 px-3 py-2.5 text-sm">
        <div className="mb-2 flex items-center gap-2">
          <TruckIcon size={12} className="text-ink-muted" />
          <span className="font-semibold capitalize">{l.type}</span>
          <span className="ml-auto text-[10px] uppercase tracking-wider text-accent">Editing</span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted">Date</span>
            <input
              type="date"
              value={draft.scheduled_date}
              onChange={(e) => setDraft((d) => ({ ...d, scheduled_date: e.target.value }))}
              className="h-8 w-full rounded border border-border bg-surface px-2 text-[12px] outline-none focus:border-primary"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted">Time</span>
            <input
              type="text"
              placeholder="9:00 – 11:00"
              value={draft.scheduled_time_range}
              onChange={(e) => setDraft((d) => ({ ...d, scheduled_time_range: e.target.value }))}
              className="h-8 w-full rounded border border-border bg-surface px-2 text-[12px] outline-none focus:border-primary"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted">Assigned</span>
            <select
              value={draft.assigned_to}
              onChange={(e) => setDraft((d) => ({ ...d, assigned_to: e.target.value }))}
              className="h-8 w-full rounded border border-border bg-surface px-2 text-[12px] outline-none focus:border-primary"
            >
              <option value="">— Unassigned —</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>{u.name || u.email}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted">Status</span>
            <select
              value={draft.status}
              onChange={(e) => setDraft((d) => ({ ...d, status: e.target.value }))}
              className="h-8 w-full rounded border border-border bg-surface px-2 text-[12px] outline-none focus:border-primary"
            >
              <option value="pending">Pending</option>
              <option value="scheduled">Scheduled</option>
              <option value="completed">Completed</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </label>
        </div>
        <label className="mt-2 block">
          <span className="mb-1 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted">Remark</span>
          <textarea
            value={draft.notes}
            onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
            rows={2}
            placeholder="e.g. driver needs warehouse code; pickup gate B"
            className="w-full rounded border border-border bg-surface px-2 py-1.5 text-[12px] outline-none focus:border-primary"
          />
        </label>
        <div className="mt-2 flex justify-end gap-2">
          <button
            onClick={() => setEditing(false)}
            disabled={saving}
            className="rounded-md border border-border px-3 py-1 text-[11px] font-semibold text-ink-secondary hover:border-ink-muted disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="rounded-md bg-accent px-3 py-1 text-[11px] font-semibold text-white hover:opacity-90 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="group rounded border border-border px-3 py-2 text-sm">
      <div className="flex items-center gap-2">
        <TruckIcon size={12} className="text-ink-muted" />
        <span className="font-semibold capitalize">{l.type}</span>
        <span className={cn(
          "ml-auto rounded-full px-2 py-0.5 text-[10px] font-semibold",
          l.status === "completed" && "bg-synced/10 text-synced",
          l.status === "scheduled" && "bg-accent/10 text-accent",
          l.status === "pending" && "bg-amber-500/10 text-amber-700",
          l.status === "cancelled" && "bg-ink-muted/10 text-ink-muted"
        )}>
          {l.status}
        </span>
        {!archived && (
          <>
            <button
              onClick={() => setEditing(true)}
              className="rounded p-1 text-ink-muted opacity-0 transition-opacity hover:text-accent group-hover:opacity-100"
              title="Edit entry"
            >
              <Pencil size={12} />
            </button>
            <button
              onClick={async () => {
                if (!await dialog.confirm("Archive this logistics entry?")) return;
                try {
                  await api.post(`/api/assr/${caseId}/logistics/${l.id}/archive`);
                  toast.success("Archived");
                  detail.reload();
                } catch (e: any) {
                  toast.error(e?.message || "Failed");
                }
              }}
              className="rounded p-1 text-ink-muted opacity-0 transition-opacity hover:text-err group-hover:opacity-100"
              title="Archive entry"
            >
              <Trash2 size={12} />
            </button>
          </>
        )}
      </div>
      {l.scheduled_date && (
        <div className="mt-1 text-[11px] text-ink-secondary">
          {formatDate(l.scheduled_date)} {l.scheduled_time_range || ""}
        </div>
      )}
      {l.assigned_to_name && (
        <div className="text-[11px] text-ink-secondary">Assigned: {l.assigned_to_name}</div>
      )}
      {l.notes && (
        <div className="mt-1 whitespace-pre-wrap text-[11px] text-ink-muted">
          <span className="mr-1 font-semibold uppercase tracking-wider text-ink-secondary">Remark:</span>
          {l.notes}
        </div>
      )}
      {/* Delivery POD slot — case-level attachment shown on every
          delivery row so ops can attach the signed POD next to the
          row it belongs to. Single PODs per case in v1 (the
          attachment is keyed by case, not by logistics row). */}
      {l.type === "delivery" && (
        <div className="mt-2 border-t border-border/60 pt-2">
          <MilestoneAttachmentSlot
            caseId={caseId}
            category="delivery_pod"
            label="Proof of Delivery"
            emptyLabel="No POD uploaded yet."
            uploadLabel="Upload POD"
            attachments={attachments}
            archived={archived}
            detail={detail}
            dialog={dialog}
            toast={toast}
            compact
          />
        </div>
      )}
    </div>
  );
}

// ── Print menu (header) ────────────────────────────────────────
// Replaces the single Print button with a 3-variant chooser per the
// proposal §12 print artifacts: Customer / Supplier / Office. Each
// option appends a `?variant=` query param to the existing print
// route — backend defaults to "office" so any legacy bookmark still
// works.

function PrintMenu({
  caseId,
  toast,
}: {
  caseId: number;
  toast: ReturnType<typeof useToast>;
}) {
  const [open, setOpen] = useState(false);

  async function go(variant: "customer" | "supplier" | "office") {
    setOpen(false);
    try {
      await api.openHtml(`/api/assr-print/${caseId}?variant=${variant}`);
    } catch (e: any) {
      toast.error(e?.message || "Failed to open print view");
    }
  }

  // Click-outside close — listen on document while open.
  useEffect(() => {
    if (!open) return;
    function onDown(ev: MouseEvent) {
      const target = ev.target as HTMLElement | null;
      if (target?.closest?.("[data-print-menu]")) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div className="relative ml-auto" data-print-menu>
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[10px] font-semibold text-ink hover:border-accent/40"
        title="Open print / PDF view"
      >
        <Printer size={11} /> Print
        <ChevronRight
          size={10}
          className={cn("transition-transform", open ? "rotate-90" : "rotate-90")}
          style={{ transform: open ? "rotate(270deg)" : "rotate(90deg)" }}
        />
      </button>
      {open && (
        <div
          className="absolute right-0 top-full z-30 mt-1 w-48 overflow-hidden rounded-md border border-border bg-surface shadow-stone"
          role="menu"
        >
          <PrintMenuItem
            label="Customer Copy"
            hint="Tracker + QR to portal"
            onClick={() => go("customer")}
          />
          <PrintMenuItem
            label="Supplier Copy"
            hint="PO, deadline, acknowledgement"
            onClick={() => go("supplier")}
          />
          <PrintMenuItem
            label="Office Copy"
            hint="Full internal view"
            onClick={() => go("office")}
          />
        </div>
      )}
    </div>
  );
}

// Portal-link dropdown — sits next to Print. Lets ops pick which link to
// generate (customer or supplier) instead of two always-visible rows in the
// Customer card.
function PortalLinksMenu({
  id,
  existingToken,
  onGenerated,
  toast,
}: {
  id: number;
  existingToken: string | null;
  onGenerated: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    function onDown(ev: MouseEvent) {
      const target = ev.target as HTMLElement | null;
      if (target?.closest?.("[data-portal-menu]")) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div className="relative" data-portal-menu>
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[10px] font-semibold text-ink hover:border-accent/40"
        title="Generate a customer or supplier portal link"
      >
        Portal Link
        <ChevronRight
          size={10}
          style={{ transform: open ? "rotate(270deg)" : "rotate(90deg)" }}
        />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-72 rounded-md border border-border bg-surface p-2 shadow-stone">
          <PortalLinkRow
            id={id}
            existingToken={existingToken}
            toast={toast}
            onGenerated={onGenerated}
          />
          <SupplierPortalLinkRow id={id} toast={toast} />
        </div>
      )}
    </div>
  );
}

function PrintMenuItem({
  label,
  hint,
  onClick,
}: {
  label: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      role="menuitem"
      className="block w-full border-b border-border px-3 py-2 text-left text-[11.5px] last:border-b-0 hover:bg-bg/60"
    >
      <div className="font-semibold text-ink">{label}</div>
      <div className="text-[10.5px] text-ink-muted">{hint}</div>
    </button>
  );
}

// ── Lead Time pill (header) ────────────────────────────────────
// Glanceable answer to "which priority is driving this case's SLA,
// and what's the target for the current stage?" — reads
// stage_target_days (snapshotted at stage entry per mig 082) and
// tints by elapsed/target ratio so an over-budget stage jumps out.
// Hidden on completed cases and on legacy rows without a snapshot.

function LeadTimePill({
  c,
  priorityMap,
}: {
  c: AssrCase;
  priorityMap: Record<string, string>;
}) {
  if (c.stage === "completed") return null;
  if (c.stage_target_days == null) return null;

  const target = c.stage_target_days;
  // Elapsed days since the case entered the current stage. stage_entered_at
  // is ISO without a Z suffix on some rows — normalise to UTC.
  let elapsed = 0;
  if (c.stage_entered_at) {
    const iso = c.stage_entered_at.endsWith("Z")
      ? c.stage_entered_at
      : c.stage_entered_at + "Z";
    elapsed = (Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60 * 24);
  }
  const pct = target > 0 ? elapsed / target : 0;
  const tone =
    pct >= 1
      ? "bg-err/10 text-err"
      : pct >= 0.5
      ? "bg-amber-500/10 text-amber-700"
      : "bg-synced/10 text-synced";

  const priorityName =
    priorityMap[c.priority] ||
    c.priority.charAt(0).toUpperCase() + c.priority.slice(1);
  const snapshotIso = c.stage_entered_at
    ? formatDateTime(c.stage_entered_at)
    : null;
  const title = snapshotIso
    ? `Stage target snapshotted on ${snapshotIso}. Changes to the priority's stage targets only affect future stages.`
    : "Stage target from the case's priority. Changes to the priority's stage targets only affect future stages.";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold",
        tone
      )}
      title={title}
    >
      <Clock size={10} />
      Lead Time: {target.toFixed(1)}d · {priorityName}
    </span>
  );
}

function IssueCategoryField({
  value,
  onSave,
  dialog,
  categories,
}: {
  value: string | null | undefined;
  onSave: (next: string | null) => Promise<void>;
  dialog: ReturnType<typeof useDialog>;
  // Mig 065 — passed in from the parent so the picker reflects what
  // admins added in Service Maintenance. Falls back to the legacy
  // ISSUE_CATEGORIES constant inside the parent if the API hasn't
  // returned yet.
  categories: readonly string[];
}) {
  const isCanonical = !!value && categories.includes(value);
  const showsOther = !!value && !isCanonical;

  async function onChange(next: string) {
    if (next === OTHER_SENTINEL) {
      const custom = await dialog.prompt({
        title: "Other issue category",
        message: "Describe the issue category in a few words.",
        placeholder: "e.g. transport damage",
        defaultValue: showsOther ? value || "" : "",
        required: true,
        confirmLabel: "Save",
      });
      if (!custom) return;
      await onSave(custom);
      return;
    }
    await onSave(next || null);
  }

  return (
    <div>
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
        Issue Category
      </div>
      <select
        value={isCanonical ? (value as string) : showsOther ? OTHER_SENTINEL : ""}
        onChange={(e) => onChange(e.target.value)}
        className="w-full appearance-none rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
      >
        <option value="">— select —</option>
        {categories.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
        <option value={OTHER_SENTINEL}>
          Other{showsOther ? ` — ${value}` : "…"}
        </option>
      </select>
      {showsOther && (
        <div className="mt-1 text-[10px] text-ink-muted">
          Custom label.{" "}
          <button
            onClick={() => onChange(OTHER_SENTINEL)}
            className="text-accent hover:underline"
          >
            Edit
          </button>
        </div>
      )}
    </div>
  );
}

// ── Cost tracking panel ──────────────────────────────────────
// The case carries `customer_amount` (revenue side) and `po_amount`
// (supplier cost). Both can be auto-filled from the linked SO + PO via
// /api/assr/:id/cost-suggestion — staff click "Auto-fill" to fetch a
// suggestion, review the values, then Apply (or edit manually).

interface CostSuggestion {
  customer_amount: number | null;
  po_amount: number | null;
  sources: {
    so: { doc_no: string; unit_price: number; qty: number } | null;
    po: { doc_no: string; unit_price: number; qty: number } | null;
  };
  reason?: string;
}

function CostTrackingPanel({
  c,
  patch,
  toast,
  id,
}: {
  c: AssrCase;
  patch: (body: Record<string, any>) => Promise<void>;
  toast: ReturnType<typeof useToast>;
  id: number;
}) {
  const [suggestion, setSuggestion] = useState<CostSuggestion | null>(null);
  const [fetching, setFetching] = useState(false);
  const [applying, setApplying] = useState(false);

  const customer = c.customer_amount ?? null;
  const supplier = c.po_amount ?? null;
  const margin =
    customer != null && supplier != null ? customer - supplier : null;

  async function fetchSuggestion() {
    setFetching(true);
    try {
      const res = await api.get<CostSuggestion>(
        `/api/assr/${id}/cost-suggestion`
      );
      setSuggestion(res);
    } catch (e: any) {
      toast.error(e?.message || "Lookup failed");
    } finally {
      setFetching(false);
    }
  }

  async function applySuggestion(which: "all" | "customer" | "supplier") {
    if (!suggestion) return;
    const body: Record<string, any> = {};
    if (
      (which === "all" || which === "customer") &&
      suggestion.customer_amount != null
    )
      body.customer_amount = suggestion.customer_amount;
    if ((which === "all" || which === "supplier") && suggestion.po_amount != null)
      body.po_amount = suggestion.po_amount;
    if (Object.keys(body).length === 0) return;
    setApplying(true);
    try {
      await patch(body);
      toast.success("Cost updated");
      setSuggestion(null);
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    } finally {
      setApplying(false);
    }
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[10px] text-ink-muted">
          <DollarSign size={11} />
          Auto-filled from SO + PO; edit anytime
        </div>
        <button
          onClick={fetchSuggestion}
          disabled={fetching}
          className="inline-flex items-center gap-1 rounded-md border border-accent/40 bg-accent-soft/40 px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-wider text-accent hover:bg-accent-soft disabled:opacity-50"
        >
          <RefreshCw
            size={10}
            className={fetching ? "animate-spin" : undefined}
          />
          {fetching ? "Looking up…" : "Auto-fill"}
        </button>
      </div>

      {suggestion && (
        <div className="mb-3 rounded-md border border-accent/30 bg-accent-soft/20 p-3">
          {suggestion.reason && (
            <div className="mb-2 text-[11px] text-warning-text">
              {suggestion.reason}
            </div>
          )}
          <div className="grid grid-cols-2 gap-3 text-[11px]">
            <div>
              <div className="font-mono text-[9.5px] font-semibold uppercase tracking-wider text-ink-muted">
                Suggested Customer
              </div>
              <div className="font-mono text-[13px] font-bold text-ink">
                {suggestion.customer_amount != null
                  ? formatCurrency(suggestion.customer_amount)
                  : "—"}
              </div>
              {suggestion.sources.so && (
                <div className="text-[10px] text-ink-muted">
                  SO {suggestion.sources.so.doc_no} · qty {suggestion.sources.so.qty} ×{" "}
                  {formatCurrency(suggestion.sources.so.unit_price)}
                </div>
              )}
            </div>
            <div>
              <div className="font-mono text-[9.5px] font-semibold uppercase tracking-wider text-ink-muted">
                Suggested Supplier
              </div>
              <div className="font-mono text-[13px] font-bold text-ink">
                {suggestion.po_amount != null
                  ? formatCurrency(suggestion.po_amount)
                  : "—"}
              </div>
              {suggestion.sources.po && (
                <div className="text-[10px] text-ink-muted">
                  PO {suggestion.sources.po.doc_no} · qty {suggestion.sources.po.qty} ×{" "}
                  {formatCurrency(suggestion.sources.po.unit_price)}
                </div>
              )}
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            <button
              onClick={() => applySuggestion("all")}
              disabled={
                applying ||
                (suggestion.customer_amount == null &&
                  suggestion.po_amount == null)
              }
              className="inline-flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-wider text-white disabled:opacity-50"
            >
              {applying ? "Applying…" : "Apply both"}
            </button>
            {suggestion.customer_amount != null && (
              <button
                onClick={() => applySuggestion("customer")}
                disabled={applying}
                className="inline-flex items-center rounded-md border border-border bg-surface px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-wider text-ink-secondary hover:border-accent/40 hover:text-accent disabled:opacity-50"
              >
                Customer only
              </button>
            )}
            {suggestion.po_amount != null && (
              <button
                onClick={() => applySuggestion("supplier")}
                disabled={applying}
                className="inline-flex items-center rounded-md border border-border bg-surface px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-wider text-ink-secondary hover:border-accent/40 hover:text-accent disabled:opacity-50"
              >
                Supplier only
              </button>
            )}
            <button
              onClick={() => setSuggestion(null)}
              className="ml-auto inline-flex items-center rounded-md px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-brand text-ink-muted hover:text-ink"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      <InlineEdit
        label="Customer Amount (revenue)"
        type="number"
        value={c.customer_amount}
        onSave={(v) => patch({ customer_amount: v ? Number(v) : null })}
      />
      <InlineEdit
        label="PO Amount (supplier cost)"
        type="number"
        value={c.po_amount}
        onSave={(v) => patch({ po_amount: v ? Number(v) : null })}
      />
      {margin != null && (
        <div className="mt-1 flex items-baseline justify-between text-[11px]">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">
            Gross margin
          </span>
          <span
            className={cn(
              "font-mono text-[12.5px] font-bold",
              margin >= 0 ? "text-synced" : "text-err"
            )}
          >
            {formatCurrency(margin)}
          </span>
        </div>
      )}
      <InlineEdit
        label="Supplier Invoice Ref"
        value={c.supplier_invoice_ref}
        onSave={(v) => patch({ supplier_invoice_ref: v })}
      />
      <InlineEdit
        label="Cost Notes"
        textarea
        value={c.cost_notes}
        onSave={(v) => patch({ cost_notes: v })}
      />
    </div>
  );
}

function CustomerHistory({ id }: { id: number }) {
  const q = useQuery<{ cases: CustomerHistoryRow[] }>(
    () => api.get(`/api/assr/${id}/customer-history`),
    [id]
  );
  const cases = q.data?.cases ?? [];

  if (q.loading) {
    return (
      <PanelSection title="Customer History" muted>
        <div className="text-[11px] text-ink-muted">Loading…</div>
      </PanelSection>
    );
  }
  if (q.error) return null;
  if (cases.length === 0) {
    return (
      <PanelSection title="Customer History" muted>
        <div className="text-[11px] text-ink-muted">No prior cases for this customer.</div>
      </PanelSection>
    );
  }

  return (
    <PanelSection title={`Customer History (${cases.length})`} muted>
      <div className="space-y-1.5">
        {cases.map((p) => (
          <div
            key={p.id}
            className="rounded-md border border-border bg-surface px-3 py-2 text-[11px]"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono font-semibold">{p.assr_no}</span>
              <StatusDot variant={stageVariant(p.stage)} label={stageLabel(p.stage)} />
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-ink-secondary">
              <span className="font-mono text-ink-muted">SO {p.doc_no}</span>
              {p.item_code && <span className="font-mono text-ink-muted">{p.item_code}</span>}
              <span>{formatDate(p.complained_date || p.created_at)}</span>
              {p.resolution_method && (
                <span className="text-ink-muted">{resolutionLabel(p.resolution_method)}</span>
              )}
            </div>
            {p.complaint_issue && (
              <ExpandableText
                text={p.complaint_issue}
                lines={2}
                className="mt-1 text-ink-secondary"
              />
            )}
          </div>
        ))}
      </div>
    </PanelSection>
  );
}

// ── Portal tracking link generator (shown on every case) ────

function PortalLinkRow({
  id,
  existingToken,
  onGenerated,
  toast,
}: {
  id: number;
  existingToken: string | null;
  onGenerated: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const [busy, setBusy] = useState(false);
  const link = existingToken
    ? `${window.location.origin}/portal/case/${existingToken}`
    : null;

  async function generate() {
    setBusy(true);
    try {
      await api.post<{ token: string; path: string }>(`/api/assr/${id}/track-link`);
      // Reload the case detail so existingToken propagates in.
      onGenerated();
      // The parent reload is async — optimistically tell the user it worked.
      toast.success("Portal link generated.");
    } catch (e: any) {
      toast.error(e?.message || "Failed to generate link");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 rounded-md border border-border bg-bg/40 p-3">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
        Customer Portal Link
      </div>
      {link ? (
        <>
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={link}
              onFocus={(e) => e.currentTarget.select()}
              className="flex-1 rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-[11px]"
            />
            <button
              onClick={() => {
                navigator.clipboard?.writeText(link);
                toast.success("Copied");
              }}
              className="rounded-md border border-border bg-surface px-2 py-1.5 text-[10px] font-semibold"
            >
              Copy
            </button>
          </div>
          <div className="mt-1.5 text-[10px] text-ink-muted">
            30-day link. Paste into WhatsApp for the customer.
          </div>
        </>
      ) : (
        <>
          <div className="mb-1.5 text-[11px] text-ink-secondary">
            Share with the customer — they can view status, comment, and upload photos without logging in.
          </div>
          <button
            onClick={generate}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded-md border border-accent/40 bg-accent-soft/20 px-3 py-1.5 text-[11px] font-semibold text-accent hover:bg-accent-soft/40 disabled:opacity-50"
          >
            {busy ? "Generating…" : "Generate Portal Link"}
          </button>
        </>
      )}
    </div>
  );
}

// ── Supplier portal link (v3.1) ─────────────────────────────────
//
// Mirrors PortalLinkRow but minted via /supplier-link. The endpoint is
// idempotent on (case, creditor_code), so calling it twice returns the
// same active token. The token isn't surfaced in the case detail
// payload (yet) — Generate fetches it lazily.

function SupplierPortalLinkRow({
  id,
  toast,
}: {
  id: number;
  toast: ReturnType<typeof useToast>;
}) {
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<string | null>(null);

  async function generate() {
    setBusy(true);
    try {
      const r = await api.post<{ token: string; path: string }>(
        `/api/assr/${id}/supplier-link`
      );
      setLink(`${window.location.origin}/portal/supplier/${r.token}`);
      toast.success("Supplier link generated.");
    } catch (e: any) {
      toast.error(e?.message || "Failed to generate link");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 rounded-md border border-border bg-bg/40 p-3">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
        Supplier Portal Link
      </div>
      {link ? (
        <>
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={link}
              onFocus={(e) => e.currentTarget.select()}
              className="flex-1 rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-[11px]"
            />
            <button
              onClick={() => {
                navigator.clipboard?.writeText(link);
                toast.success("Copied");
              }}
              className="rounded-md border border-border bg-surface px-2 py-1.5 text-[10px] font-semibold"
            >
              Copy
            </button>
          </div>
          <div className="mt-1.5 text-[10px] text-ink-muted">
            30-day link. Supplier can mark pickup / ready / returned.
          </div>
        </>
      ) : (
        <>
          <div className="mb-1.5 text-[11px] text-ink-secondary">
            Share with the supplier — Picked Up → Repair → Ready →
            Returned status updates, plus QC photo uploads.
          </div>
          <button
            onClick={generate}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded-md border border-accent/40 bg-accent-soft/20 px-3 py-1.5 text-[11px] font-semibold text-accent hover:bg-accent-soft/40 disabled:opacity-50"
          >
            {busy ? "Generating…" : "Generate Supplier Link"}
          </button>
        </>
      )}
    </div>
  );
}

// ── Survey link generator (shown on closed cases) ─────────────

function SurveyLinkButton({ id, toast }: { id: number; toast: ReturnType<typeof useToast> }) {
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function generate() {
    setBusy(true);
    try {
      const res = await api.post<{ token: string }>(`/api/assr/${id}/survey-token`);
      const url = `${window.location.origin}/survey/${res.token}`;
      setLink(url);
      await navigator.clipboard?.writeText(url).catch(() => void 0);
      toast.success("Survey link copied to clipboard");
    } catch (e: any) {
      toast.error(e?.message || "Failed to generate link");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3">
      {link ? (
        <div className="rounded-md border border-border bg-bg/60 p-2">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
            Share this link with the customer
          </div>
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={link}
              className="flex-1 rounded-md border border-border bg-surface px-2 py-1.5 text-[11px] font-mono outline-none"
              onFocus={(e) => e.currentTarget.select()}
            />
            <button
              onClick={() => {
                navigator.clipboard?.writeText(link);
                toast.success("Copied");
              }}
              className="rounded-md border border-border bg-surface px-2 py-1.5 text-[10px] font-semibold text-ink hover:border-accent/40"
            >
              Copy
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={generate}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-md border border-accent/40 bg-accent-soft/20 px-3 py-1.5 text-[11px] font-semibold text-accent hover:bg-accent-soft/40 disabled:opacity-50"
        >
          {busy ? "Generating…" : "Generate Survey Link"}
        </button>
      )}
    </div>
  );
}

// ── Close Case Prompt (satisfaction rating) ──────────────────

function ClosePrompt({
  onConfirm,
  onCancel,
  transitioning,
}: {
  onConfirm: (rating: number | null, notes: string) => Promise<void>;
  onCancel: () => void;
  transitioning: boolean;
}) {
  const [rating, setRating] = useState<number>(0);
  const [notes, setNotes] = useState("");

  const Stars = ({
    value,
    onChange,
  }: {
    value: number;
    onChange: (v: number) => void;
  }) => (
    <div className="mb-3 flex items-center gap-1">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          onClick={() => onChange(value === n ? 0 : n)}
          className="rounded p-0.5 transition-colors hover:bg-amber-100"
        >
          <Star
            size={20}
            className={n <= value ? "fill-amber-400 text-amber-400" : "text-ink-muted"}
          />
        </button>
      ))}
      {value > 0 && <span className="ml-2 text-sm text-ink-secondary">{value}/5</span>}
    </div>
  );

  return (
    <div className="border-b border-border bg-amber-50/40 px-5 py-4">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
        Close Case — Customer Satisfaction
      </div>
      <Stars value={rating} onChange={setRating} />
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Satisfaction notes (optional)..."
        rows={2}
        className="mb-3 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-primary"
      />

      <div className="flex gap-2">
        <button
          onClick={() => onConfirm(rating || null, notes)}
          disabled={transitioning}
          className="rounded-md bg-err px-4 py-2 text-[12px] font-semibold text-white disabled:opacity-50"
        >
          {transitioning ? "Closing..." : "Confirm Close"}
        </button>
        <button
          onClick={onCancel}
          className="rounded-md border border-border px-3 py-2 text-[12px] text-ink-secondary"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── Logistics creation form ──────────────────────────────────

function LogisticsForm({
  assrId,
  users,
  onCreated,
  onCancel,
  toast,
}: {
  assrId: number;
  users: { id: number; name: string }[];
  onCreated: () => void;
  onCancel: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const [type, setType] = useState<"pickup" | "delivery">("pickup");
  const [date, setDate] = useState("");
  const [timeRange, setTimeRange] = useState("");
  const [assignedTo, setAssignedTo] = useState<string>("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    setSubmitting(true);
    try {
      await api.post(`/api/assr/${assrId}/logistics`, {
        type,
        scheduled_date: date || undefined,
        scheduled_time_range: timeRange || undefined,
        assigned_to: assignedTo ? parseInt(assignedTo, 10) : undefined,
        notes: notes || undefined,
      });
      onCreated();
    } catch (e: any) {
      toast.error(`Failed: ${e?.message || e}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mt-2 space-y-2 rounded border border-border bg-bg/60 p-3">
      <div className="flex gap-2">
        <select
          value={type}
          onChange={(e) => setType(e.target.value as any)}
          className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm outline-none focus:border-primary"
        >
          <option value="pickup">Pickup</option>
          <option value="delivery">Delivery</option>
        </select>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="flex-1 rounded-md border border-border bg-surface px-3 py-1.5 text-sm outline-none focus:border-primary"
        />
      </div>
      <input
        value={timeRange}
        onChange={(e) => setTimeRange(e.target.value)}
        placeholder="Time range (e.g. 9AM-12PM)"
        className="w-full rounded-md border border-border bg-surface px-3 py-1.5 text-sm outline-none focus:border-primary"
      />
      <select
        value={assignedTo}
        onChange={(e) => setAssignedTo(e.target.value)}
        className="w-full appearance-none rounded-md border border-border bg-surface px-3 py-1.5 text-sm outline-none focus:border-primary"
      >
        <option value="">Assign to...</option>
        {users.map((u) => (
          <option key={u.id} value={u.id}>{u.name}</option>
        ))}
      </select>
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Notes (optional)"
        rows={2}
        className="w-full rounded-md border border-border bg-surface px-3 py-1.5 text-sm outline-none focus:border-primary"
      />
      <div className="flex gap-2">
        <button
          onClick={submit}
          disabled={submitting}
          className="rounded-md bg-accent px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50"
        >
          {submitting ? "Scheduling..." : "Schedule"}
        </button>
        <button
          onClick={onCancel}
          className="rounded-md border border-border px-3 py-1.5 text-[11px] text-ink-secondary"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── Local file preview (before upload) ─────────────────────────

function FilePreview({ file, onRemove }: { file: File; onRemove: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const isImage = file.type.startsWith("image/");
  const isVideo = file.type.startsWith("video/");

  useEffect(() => {
    if (!isImage && !isVideo) return;
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  return (
    <div className="group relative overflow-hidden rounded-md border border-border bg-bg">
      {isImage && url ? (
        <img src={url} alt={file.name} className="h-20 w-full object-cover" />
      ) : isVideo && url ? (
        <video src={url} className="h-20 w-full object-cover" muted />
      ) : (
        <div className="flex h-20 items-center justify-center text-[11px] text-ink-muted">
          PDF
        </div>
      )}
      <button
        onClick={onRemove}
        className="absolute right-0.5 top-0.5 rounded-full bg-ink/70 p-0.5 text-white opacity-0 transition-opacity hover:bg-err group-hover:opacity-100"
        title="Remove"
      >
        <Trash2 size={10} />
      </button>
      <div className="truncate px-1.5 py-1 text-[9px] text-ink-muted">{file.name}</div>
    </div>
  );
}

// ── Attachment thumbnail (loads via auth) ──────────────────────

function AttachmentThumb({ att, onClick, onVisibilityChange, onArchive }: {
  att: AssrAttachment & { source?: string; visible_to_customer?: number };
  onClick?: () => void;
  onVisibilityChange?: (visible: boolean) => void;
  onArchive?: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const isImage = att.content_type?.startsWith("image/");

  useEffect(() => {
    if (!isImage) return;
    let revoked = false;
    api.fetchBlobUrl(`/api/assr/attachments/${att.r2_key}`).then((u) => {
      if (!revoked) setUrl(u);
    });
    return () => { revoked = true; if (url) URL.revokeObjectURL(url); };
  }, [att.r2_key]);

  const isCustomer = att.source === "customer";
  const isVisible = (att.visible_to_customer ?? 1) === 1;

  return (
    <div className={cn(
      "group relative overflow-hidden rounded-md border bg-bg",
      isCustomer ? "border-accent/40" : "border-border",
      !isVisible && "opacity-60"
    )}>
      <button
        type="button"
        onClick={onClick}
        disabled={!isImage || !onClick}
        className="block w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        aria-label={isImage ? "View full-size photo" : att.category}
      >
        {isImage && url ? (
          <img
            src={url}
            alt={att.file_name || ""}
            className="h-20 w-full object-cover transition-transform duration-200 group-hover:scale-105"
          />
        ) : (
          <div className="flex h-20 items-center justify-center text-[11px] text-ink-muted">
            {att.content_type?.includes("video") ? "Video" : "File"}
          </div>
        )}
      </button>
      <div className="flex items-center justify-between px-1.5 py-1 text-[9px] text-ink-muted">
        <span className="truncate">{att.category}</span>
        {isCustomer && <span className="text-accent font-semibold">CUSTOMER</span>}
      </div>
      <div className="absolute right-0.5 top-0.5 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        {onVisibilityChange && (
          <button
            onClick={(e) => { e.stopPropagation(); onVisibilityChange(!isVisible); }}
            className="rounded-full bg-ink/70 px-1.5 py-0.5 text-[9px] font-semibold text-white hover:bg-accent"
            title={isVisible ? "Hide from customer" : "Show to customer"}
          >
            {isVisible ? "Hide" : "Show"}
          </button>
        )}
        {onArchive && (
          <button
            onClick={(e) => { e.stopPropagation(); onArchive(); }}
            className="rounded-full bg-ink/70 p-1 text-white hover:bg-err"
            title="Archive attachment"
          >
            <Trash2 size={9} />
          </button>
        )}
      </div>
    </div>
  );
}

// ── Full-screen lightbox for staff-side attachments ──────────
// Mirrors the portal lightbox but fetches via the staff auth path
// (/api/assr/attachments/:r2_key) and navigates through image
// attachments only — skips videos/PDFs.
function StaffLightbox({
  attachments,
  index,
  onChange,
  onClose,
}: {
  attachments: Array<AssrAttachment & { source?: string; visible_to_customer?: number }>;
  index: number;
  onChange: (i: number) => void;
  onClose: () => void;
}) {
  // Only image attachments participate in lightbox navigation. The
  // caller's `index` is the index into the full attachments array,
  // but we map it to the image-only list for prev/next.
  const imageIndices = useMemo(
    () => attachments
      .map((a, i) => ((a.content_type || "").startsWith("image/") ? i : -1))
      .filter((i) => i >= 0),
    [attachments]
  );
  const currentImagePos = imageIndices.indexOf(index);

  const att = attachments[index];
  const [url, setUrl] = useState<string | null>(null);

  const go = useCallback(
    (delta: number) => {
      if (currentImagePos < 0 || imageIndices.length === 0) return;
      const nextPos = (currentImagePos + delta + imageIndices.length) % imageIndices.length;
      onChange(imageIndices[nextPos]);
    },
    [currentImagePos, imageIndices, onChange]
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "ArrowRight") go(1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, onClose]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  useEffect(() => {
    setUrl(null);
    let revoked = false;
    api.fetchBlobUrl(`/api/assr/attachments/${att.r2_key}`)
      .then((u) => { if (!revoked) setUrl(u); })
      .catch(() => {});
    return () => { revoked = true; if (url) URL.revokeObjectURL(url); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [att.r2_key]);

  if (typeof document === "undefined") return null;

  const isCustomer = att.source === "customer";
  const isHidden = (att.visible_to_customer ?? 1) === 0;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 backdrop-blur-sm animate-fade-in"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="absolute inset-x-0 top-0 flex items-center justify-between gap-3 px-4 py-3 text-white sm:px-6 sm:py-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-[2pt]">
          <span className="rounded-full border border-white/30 px-2 py-0.5 font-semibold">
            {att.category}
          </span>
          {isCustomer && (
            <span className="rounded-full bg-accent/90 px-2 py-0.5 font-semibold">
              Customer
            </span>
          )}
          {isHidden && (
            <span className="rounded-full border border-white/50 bg-white/10 px-2 py-0.5 font-semibold">
              Hidden
            </span>
          )}
          {imageIndices.length > 1 && (
            <span className="font-mono text-[10px] text-white/60">
              {currentImagePos + 1} / {imageIndices.length}
            </span>
          )}
        </div>
        <button
          onClick={onClose}
          aria-label="Close"
          className="rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20"
        >
          <X size={18} />
        </button>
      </div>

      {imageIndices.length > 1 && (
        <>
          <button
            onClick={(e) => { e.stopPropagation(); go(-1); }}
            aria-label="Previous"
            className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20 sm:left-6"
          >
            <ChevronLeft size={22} />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); go(1); }}
            aria-label="Next"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20 sm:right-6"
          >
            <ChevronRight size={22} />
          </button>
        </>
      )}

      <div
        className="relative flex max-h-[90vh] max-w-[92vw] items-center justify-center"
        onClick={(e) => e.stopPropagation()}
      >
        {url ? (
          <img
            src={url}
            alt={att.file_name || att.category}
            className="max-h-[88vh] max-w-[92vw] select-none object-contain shadow-2xl"
            draggable={false}
          />
        ) : (
          <div className="flex h-64 w-64 items-center justify-center rounded bg-white/5 text-white/60">
            Loading…
          </div>
        )}
      </div>

      {att.file_name && (
        <div
          className="absolute inset-x-0 bottom-0 px-4 py-3 text-center text-[11px] text-white/70 sm:py-4"
          onClick={(e) => e.stopPropagation()}
        >
          {att.file_name}
        </div>
      )}
    </div>,
    document.body
  );
}
