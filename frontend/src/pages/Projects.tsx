import { useState, useMemo, useEffect } from "react";
import { useNavigate, useParams, Navigate, useSearchParams } from "react-router-dom";
import {
  Plus,
  Calendar,
  CheckCircle2,
  Circle,
  MinusCircle,
  Ban,
  Lock,
  Trash2,
  Upload,
  FileText,
  Image as ImageIcon,
  Link2,
  Unlink,
  Upload as UploadIcon,
  X,
  ExternalLink,
  MessageSquare,
  Truck,
  Banknote,
  Monitor,
  Receipt,
  AlertTriangle,
  Info,
  AlertOctagon,
  Printer,
  BarChart3,
  Download,
  Pencil,
  Send,
  type LucideIcon,
} from "lucide-react";
import { PageHeader } from "../components/Layout";
import { Button } from "../components/Button";
import { FilterPills } from "../components/FilterPills";
import { ProjectMaintenanceView } from "./ProjectMaintenance";
import { PnlCalendar } from "../components/PnlCalendar";
import { DataTable, type Column } from "../components/DataTable";
import { StatusDot } from "../components/StatusDot";
import { Pagination } from "../components/Pagination";
import { Panel, PanelSection, FieldRow } from "../components/Panel";
import {
  DetailLayout,
  DetailGrid,
  DetailMain,
  DetailAside,
  HeaderButton,
} from "../components/DetailLayout";
import { InlineEdit } from "../components/InlineEdit";
import { StatCard } from "../components/StatCard";
import { DashboardGrid } from "../components/Dashboard";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { useDialog } from "../hooks/useDialog";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useServerSort } from "../hooks/useServerSort";
import { useFocusFromUrl } from "../hooks/useFocusFromUrl";
import { useAuth } from "../auth/AuthContext";
import { api, buildQuery } from "../api/client";
import { formatDate, formatCurrency, cn, relativeTime } from "../lib/utils";

// ── Types (module-local) ─────────────────────────────────────
// Kept in this file until something else imports them. Promoting to
// types.ts is a no-brainer move once a second page needs them.

type ProjectStage =
  | "draft"
  | "planning"
  | "build"
  | "live"
  | "teardown"
  | "closed"
  | "cancelled";

type ChecklistStatus = "pending" | "done" | "na" | "blocked";

interface ProjectRow {
  id: number;
  code: string;
  name: string;
  stage: ProjectStage;
  brand: string | null;
  start_date: string | null;
  end_date: string | null;
  state: string | null;
  venue: string | null;
  booth_no: string | null;
  size_sqm: number | null;
  archived_at: string | null;
  event_type_name: string | null;
  rental: number | null;
  total_sales: number | null;
  contractor_cost: number | null;
  progress_pct: number;
}

interface ProjectDetail {
  project: ProjectRow & {
    organizer: string | null;
    venue_address: string | null;
    event_type_id: number | null;
    notion_url: string | null;
    notes: string | null;
    created_by_name: string | null;
    created_at: string;
    updated_at: string;
    duration_days: number | null;
    // Logistics schedule (Notion parity)
    setup_start_at: string | null;
    setup_end_at: string | null;
    dismantle_start_at: string | null;
    dismantle_end_at: string | null;
    setup_driver_user_id: number | null;
    setup_driver_name: string | null;
    setup_lorry_id: number | null;
    setup_lorry_plate: string | null;
    dismantle_driver_user_id: number | null;
    dismantle_driver_name: string | null;
    dismantle_lorry_id: number | null;
    dismantle_lorry_plate: string | null;
    banner_message: string | null;
    banner_tone: "info" | "warning" | "error" | null;
    // Payment workflow
    payment_status: PaymentStatus | null;
    payment_proof_r2_key: string | null;
    payment_proof_file_name: string | null;
    payment_notes: string | null;
    payment_updated_at: string | null;
  };
  finance: {
    rental: number | null;
    contractor_cost: number | null;
    license_fee: number | null;
    deposit_paid: number | null;
    deposit_refund: number | null;
    misc_cost: number | null;
    total_sales: number | null;
    notes: string | null;
  } | null;
  finance_lines: FinanceLine[];
  stock_transfers: StockTransfer[];
  checklist: ChecklistItem[];
  checklist_comments: ChecklistComment[];
  attachments: ProjectAttachment[];
  defects: ProjectDefect[];
  sales_reports: SalesReport[];
  activity: ActivityRow[];
  team: any[];
  trips: ProjectTrip[];
}

type PaymentStatus =
  | "not_started"
  | "deposit_paid"
  | "paid"
  | "refund_pending"
  | "refunded";

interface StockTransfer {
  id: number;
  project_id: number;
  direction: "out" | "return";
  transferred_at: string | null;
  record_r2_key: string | null;
  file_name: string | null;
  mime_type: string | null;
  notes: string | null;
  confirmed_at: string | null;
  confirmed_by: number | null;
  confirmed_by_name: string | null;
  created_by: number | null;
  created_by_name: string | null;
  created_at: string;
}

interface FinanceLine {
  id: number;
  project_id: number;
  kind: "income" | "cost";
  category: string;
  description: string | null;
  amount: number;
  occurred_at: string | null;
  r2_key: string | null;
  file_name: string | null;
  mime_type: string | null;
  notes: string | null;
  created_by_name: string | null;
  created_at: string;
}

type AttachRole = "sales" | "driver" | "design" | "office";

interface ProjectAttachment {
  id: number;
  category: string | null;
  r2_key: string;
  file_name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  uploader_name: string | null;
  uploaded_by_role: AttachRole | null;
  created_at: string;
}

interface ProjectDefect {
  id: number;
  project_id: number;
  phase: "setup" | "dismantle";
  reported_by_role: "sales" | "logistic";
  item_code: string | null;
  item_description: string | null;
  size: string | null;
  quantity: number | null;
  reason: string | null;
  photo_r2_key: string | null;
  reported_by_name: string | null;
  reported_at: string;
  resolved: number;
  resolved_notes: string | null;
  linked_assr_id: number | null;
  linked_assr_no: string | null;
}

interface SalesReport {
  id: number;
  project_id: number;
  title: string | null;
  sales_amount: number | null;
  period_start: string | null;
  period_end: string | null;
  r2_key: string | null;
  file_name: string | null;
  mime_type: string | null;
  uploaded_by_name: string | null;
  created_at: string;
}

interface ChecklistComment {
  id: number;
  item_id: number;
  kind: "note" | "submit" | "reject" | "amend" | "approve";
  body: string | null;
  user_name: string | null;
  created_at: string;
}

interface ProjectTrip {
  id: number;
  code: string;
  status: string;
  scheduled_date: string | null;
  trip_type: string | null;
  description: string | null;
}

interface ChecklistItem {
  id: number;
  seq: number;
  title: string;
  description: string | null;
  required_perm: string | null;
  due_date: string | null;
  owner_user_id: number | null;
  owner_name: string | null;
  status: ChecklistStatus;
  review_status: "pending_review" | "rejected" | "amended" | "approved" | null;
  rejection_reason: string | null;
  completed_by: number | null;
  completed_by_name: string | null;
  completed_at: string | null;
  notes: string | null;
}

interface ActivityRow {
  id: number;
  action: string;
  from_value: string | null;
  to_value: string | null;
  note: string | null;
  user_name: string | null;
  created_at: string;
}

interface EventType {
  id: number;
  slug: string;
  name: string;
  default_template_id: number | null;
}

interface Paginated<T> {
  data: T[];
  page: number;
  per_page: number;
  total: number;
}

// ── Malaysia states (picker) ─────────────────────────────────
// Mirrors the backend constant. Kept here to avoid an extra API round
// trip for what is effectively static data.

const MALAYSIA_STATES = [
  "Kuala Lumpur",
  "Selangor",
  "Johor",
  "Penang",
  "Perak",
  "Pahang",
  "Kedah",
  "Kelantan",
  "Terengganu",
  "Negeri Sembilan",
  "Melaka",
  "Sabah",
  "Sarawak",
  "Putrajaya",
  "Labuan",
] as const;

// ── Payment workflow ─────────────────────────────────────────

const PAYMENT_STATUS_META: Record<
  PaymentStatus,
  { label: string; tone: "default" | "open" | "synced" | "warning"; next?: PaymentStatus }
> = {
  not_started:    { label: "Not started",    tone: "default", next: "deposit_paid" },
  deposit_paid:   { label: "Deposit paid",   tone: "open",    next: "paid" },
  paid:           { label: "Paid in full",   tone: "synced",  next: "refund_pending" },
  refund_pending: { label: "Refund pending", tone: "warning", next: "refunded" },
  refunded:       { label: "Refunded",       tone: "synced" },
};

// Canonical event name helper. Builds the `STATE - BRAND - TYPE - VENUE`
// convention teams use internally. Empty fields are skipped so a
// half-filled project still produces something readable.
// ── Organizer picker ─────────────────────────────────────────
// Combobox-style: select from existing organizers OR add a new one
// inline. Picks land in projects.organizer (free text) and also get
// recorded in project_organizers so the next project sees them.

function OrganizerPicker({
  value,
  onChange,
  className,
}: {
  value: string | null | undefined;
  onChange: (next: string | null) => void;
  className?: string;
}) {
  const dialog = useDialog();
  const toast = useToast();
  const q = useQuery<{ data: { id: number; name: string }[] }>(
    () => api.get("/api/projects/organizers"),
    []
  );
  const options = q.data?.data ?? [];

  async function addNew() {
    const name = await dialog.prompt({
      title: "Add organizer",
      message: "Add a new organizer to the picker. Subsequent projects will see it too.",
      placeholder: "e.g. PIKOM",
      required: true,
      confirmLabel: "Add",
    });
    if (!name) return;
    try {
      await api.post("/api/projects/organizers", { name });
      await q.reload();
      onChange(name);
      toast.success(`Added ${name}`);
    } catch (e: any) {
      toast.error(e?.message || "Failed to add");
    }
  }

  const SENTINEL_NEW = "__add_new__";

  return (
    <select
      value={value || ""}
      onChange={(e) => {
        const v = e.target.value;
        if (v === SENTINEL_NEW) {
          // Don't commit the sentinel — open the prompt and let it
          // call onChange with the actual new name.
          addNew();
          return;
        }
        onChange(v || null);
      }}
      className={
        className ??
        "w-full appearance-none rounded-md border border-border bg-surface px-3 py-2 text-[13px]"
      }
    >
      <option value="">— select organizer —</option>
      {/* Surface legacy values that aren't in the lookup yet */}
      {value && !options.some((o) => o.name === value) && (
        <option value={value}>{value}</option>
      )}
      {options.map((o) => (
        <option key={o.id} value={o.name}>
          {o.name}
        </option>
      ))}
      <option value={SENTINEL_NEW}>＋ Add new organizer…</option>
    </select>
  );
}

// Same pattern as OrganizerPicker but for project_venues. Includes an
// optional `state` callback that fires when the picked venue carries a
// state hint, so the create form can pre-fill the state field.
function VenuePicker({
  value,
  onChange,
  onStateHint,
  className,
}: {
  value: string | null | undefined;
  onChange: (next: string | null) => void;
  onStateHint?: (state: string | null) => void;
  className?: string;
}) {
  const dialog = useDialog();
  const toast = useToast();
  const q = useQuery<{
    data: { id: number; name: string; state: string | null }[];
  }>(() => api.get("/api/projects/venues"), []);
  const options = q.data?.data ?? [];

  async function addNew() {
    const name = await dialog.prompt({
      title: "Add venue",
      message:
        "Add a new venue to the picker. Subsequent projects will see it too.",
      placeholder: "e.g. KLCC Convention Centre",
      required: true,
      confirmLabel: "Add",
    });
    if (!name) return;
    try {
      const r = await api.post<{ id: number; name: string; state: string | null }>(
        "/api/projects/venues",
        { name }
      );
      await q.reload();
      onChange(r.name);
      if (r.state && onStateHint) onStateHint(r.state);
      toast.success(`Added ${r.name}`);
    } catch (e: any) {
      toast.error(e?.message || "Failed to add");
    }
  }

  const SENTINEL_NEW = "__add_new__";

  return (
    <select
      value={value || ""}
      onChange={(e) => {
        const v = e.target.value;
        if (v === SENTINEL_NEW) {
          addNew();
          return;
        }
        onChange(v || null);
        if (v && onStateHint) {
          const match = options.find((o) => o.name === v);
          if (match?.state) onStateHint(match.state);
        }
      }}
      className={
        className ??
        "w-full appearance-none rounded-md border border-border bg-surface px-3 py-2 text-[13px]"
      }
    >
      <option value="">— select venue —</option>
      {value && !options.some((o) => o.name === value) && (
        <option value={value}>{value}</option>
      )}
      {options.map((o) => (
        <option key={o.id} value={o.name}>
          {o.name}
          {o.state ? ` · ${o.state}` : ""}
        </option>
      ))}
      <option value={SENTINEL_NEW}>＋ Add new venue…</option>
    </select>
  );
}

function composeEventName(p: {
  state?: string | null;
  brand?: string | null;
  event_type_name?: string | null;
  venue?: string | null;
}): string {
  const parts = [p.state, p.brand, p.event_type_name?.toUpperCase(), p.venue]
    .map((s) => (s || "").trim())
    .filter(Boolean);
  return parts.join(" - ");
}

// ── Stage helpers ────────────────────────────────────────────

const STAGE_OPTIONS: { value: "ALL" | ProjectStage; label: string }[] = [
  { value: "ALL", label: "All" },
  { value: "draft", label: "Draft" },
  { value: "planning", label: "Planning" },
  { value: "build", label: "Build" },
  { value: "live", label: "Live" },
  { value: "teardown", label: "Teardown" },
  { value: "closed", label: "Closed" },
];

const STAGE_LABEL: Record<ProjectStage, string> = {
  draft: "Draft",
  planning: "Planning",
  build: "Build",
  live: "Live",
  teardown: "Teardown",
  closed: "Closed",
  cancelled: "Cancelled",
};

function stageVariant(
  stage: ProjectStage
): "neutral" | "open" | "in-progress" | "closed" | "error" {
  switch (stage) {
    case "draft":
      return "neutral";
    case "planning":
      return "open";
    case "build":
    case "live":
    case "teardown":
      return "in-progress";
    case "closed":
      return "closed";
    case "cancelled":
      return "error";
  }
}

const NEXT_STAGE: Partial<Record<ProjectStage, { stage: ProjectStage; label: string }>> = {
  draft: { stage: "planning", label: "Move to Planning" },
  planning: { stage: "build", label: "Start Build" },
  build: { stage: "live", label: "Go Live" },
  live: { stage: "teardown", label: "Start Teardown" },
  teardown: { stage: "closed", label: "Close Project" },
};

// ── Main page ────────────────────────────────────────────────

type ProjectsView = "list" | "calendar" | "finances" | "maintenance";

const PROJECTS_VIEWS: ProjectsView[] = [
  "list",
  "calendar",
  "finances",
  "maintenance",
];

export function Projects() {
  // URL-driven (`?view=…`). The sidebar's Project Management group has
  // one entry per view, so the page itself doesn't render a tab strip
  // — view selection lives in the sidebar.
  const [params] = useSearchParams();
  const [storedView, setStoredView] = useLocalStorage<ProjectsView>(
    "projects:view",
    "list"
  );
  const urlView = params.get("view") as ProjectsView | null;
  const view: ProjectsView =
    urlView && PROJECTS_VIEWS.includes(urlView)
      ? urlView
      : params.has("focus")
      ? "list"
      : storedView;

  // Persist whatever view was rendered so a bare `/projects` lands
  // back where the user left off.
  useEffect(() => {
    if (view !== storedView) setStoredView(view);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  return (
    <div>
      {view === "list" && <ProjectsListView />}
      {view === "calendar" && <ProjectsCalendarView />}
      {view === "finances" && <ProjectsFinancesView />}
      {view === "maintenance" && <ProjectMaintenanceView />}
    </div>
  );
}

function ProjectsListView() {
  const { can } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [stage, setStage] = useState<"ALL" | ProjectStage>("ALL");
  const [search, setSearch] = useState("");
  const [brand, setBrand] = useState<string>("");
  const [year, setYear] = useState<string>("");
  const [month, setMonth] = useState<string>("");
  const [state, setState] = useState<string>("");
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useLocalStorage<number>("pp:projects", 50);
  const [showCreate, setShowCreate] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showArchived, setShowArchived] = useLocalStorage<boolean>("projects:showArchived", false);

  // ?focus=ID — Overview inbox deep-links straight to the detail page.
  useFocusFromUrl((id) => navigate(`/projects/${id}`, { replace: true }));

  const { sort, sortParams, handleSortChange } = useServerSort(() => setPage(1));

  const list = useQuery<Paginated<ProjectRow>>(
    () =>
      api.get(
        `/api/projects${buildQuery({
          stage: stage === "ALL" ? undefined : stage,
          brand: brand || undefined,
          year: year || undefined,
          month: month || undefined,
          state: state || undefined,
          search,
          page,
          per_page: perPage,
          include_archived: showArchived ? 1 : undefined,
          ...sortParams,
        })}`
      ),
    [stage, brand, year, month, state, search, page, perPage, showArchived, sort?.key, sort?.dir]
  );

  const summary = useQuery<{
    by_stage: { stage: string; count: number }[];
    upcoming_30d: number;
    live_count: number;
    overdue_tasks: number;
  }>(() => api.get("/api/projects/summary"));

  const brands = useQuery<{ data: string[] }>(() => api.get("/api/projects/brands"));
  const eventTypes = useQuery<{ data: EventType[] }>(() =>
    api.get("/api/projects/event-types")
  );

  const stageCountMap = useMemo(() => {
    const m: Record<string, number> = {};
    for (const s of summary.data?.by_stage ?? []) m[s.stage] = s.count;
    return m;
  }, [summary.data]);

  const columns: Column<ProjectRow>[] = [
    {
      key: "code",
      label: "Code",
      alwaysVisible: true,
      render: (r) => <span className="font-mono text-xs font-medium">{r.code}</span>,
      getValue: (r) => r.code,
    },
    {
      key: "name",
      label: "Project",
      alwaysVisible: true,
      render: (r) => (
        <div className="flex flex-col">
          <span className="text-[13px] font-semibold">{r.name}</span>
          {r.venue && <span className="text-[10px] text-ink-muted">{r.venue}</span>}
        </div>
      ),
      getValue: (r) => r.name,
    },
    {
      key: "stage",
      label: "Stage",
      render: (r) => (
        <div className="flex items-center gap-1.5">
          {r.archived_at && (
            <span className="inline-flex items-center rounded-full border border-ink-muted/40 bg-ink-muted/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-ink-muted">
              Archived
            </span>
          )}
          <StatusDot variant={stageVariant(r.stage)} label={STAGE_LABEL[r.stage]} />
        </div>
      ),
      getValue: (r) => STAGE_LABEL[r.stage],
    },
    {
      key: "progress_pct",
      label: "Progress",
      align: "right",
      render: (r) => <ProgressBar pct={r.progress_pct ?? 0} />,
      getValue: (r) => r.progress_pct,
    },
    {
      key: "brand",
      label: "Brand",
      render: (r) => <span className="text-[11px]">{r.brand || "—"}</span>,
      getValue: (r) => r.brand,
    },
    {
      key: "event_type_name",
      label: "Type",
      render: (r) => <span className="text-[11px]">{r.event_type_name || "—"}</span>,
      getValue: (r) => r.event_type_name,
    },
    {
      key: "start_date",
      label: "Start",
      render: (r) => formatDate(r.start_date),
      getValue: (r) => r.start_date,
    },
    {
      key: "end_date",
      label: "End",
      render: (r) => formatDate(r.end_date),
      getValue: (r) => r.end_date,
    },
    {
      key: "state",
      label: "State",
      render: (r) => <span className="text-[11px]">{r.state || "—"}</span>,
      getValue: (r) => r.state,
    },
    {
      key: "booth_no",
      label: "Booth",
      render: (r) => <span className="font-mono text-[11px]">{r.booth_no || "—"}</span>,
      getValue: (r) => r.booth_no,
    },
    {
      key: "size_sqm",
      label: "Size",
      align: "right",
      render: (r) => (r.size_sqm != null ? `${r.size_sqm} m²` : "—"),
      getValue: (r) => r.size_sqm,
    },
    {
      key: "rental",
      label: "Rental",
      align: "right",
      render: (r) => (
        <span className="font-mono text-[11px]">
          {r.rental != null ? formatCurrency(r.rental, { compact: true }) : "—"}
        </span>
      ),
      getValue: (r) => r.rental,
    },
    {
      key: "total_sales",
      label: "Sales",
      align: "right",
      render: (r) => (
        <span className="font-mono text-[11px]">
          {r.total_sales != null ? formatCurrency(r.total_sales, { compact: true }) : "—"}
        </span>
      ),
      getValue: (r) => r.total_sales,
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Operations · Projects"
        title="Project Management"
        description="Exhibitions and solo events — lifecycle, checklist, logistics, finance"
        actions={
          <div className="flex items-center gap-2">
            {can("projects.manage") && (
              <Button
                variant="secondary"
                icon={<UploadIcon size={14} />}
                onClick={() => setShowImport(true)}
              >
                Import CSV
              </Button>
            )}
            <Button variant="primary" icon={<Plus size={14} />} onClick={() => setShowCreate(true)}>
              New Project
            </Button>
          </div>
        }
      />

      <DashboardGrid cols={4}>
        <StatCard
          label="Live Now"
          value={(summary.data?.live_count ?? 0).toString()}
          subtitle="Events currently running"
          tone={(summary.data?.live_count ?? 0) > 0 ? "success" : "default"}
        />
        <StatCard
          label="Upcoming (30d)"
          value={(summary.data?.upcoming_30d ?? 0).toString()}
          subtitle="Starting within the next month"
        />
        <StatCard
          label="In Planning"
          value={(stageCountMap.planning ?? 0).toString()}
          subtitle="Pre-build stage"
        />
        <StatCard
          label="Overdue Tasks"
          value={(summary.data?.overdue_tasks ?? 0).toString()}
          subtitle="Checklist items past due"
          tone={(summary.data?.overdue_tasks ?? 0) > 0 ? "error" : "default"}
        />
      </DashboardGrid>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <FilterPills
          value={stage}
          onChange={(v) => {
            setPage(1);
            setStage(v);
          }}
          options={STAGE_OPTIONS}
        />
        <select
          value={brand}
          onChange={(e) => {
            setPage(1);
            setBrand(e.target.value);
          }}
          className="h-8 rounded-md border border-border bg-surface px-2 text-[12px]"
        >
          <option value="">All brands</option>
          {(brands.data?.data ?? []).map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
        <select
          value={year}
          onChange={(e) => {
            setPage(1);
            setYear(e.target.value);
          }}
          className="h-8 rounded-md border border-border bg-surface px-2 text-[12px]"
        >
          <option value="">All years</option>
          {(() => {
            const y = new Date().getFullYear();
            const years: number[] = [];
            for (let i = y + 1; i >= y - 4; i--) years.push(i);
            return years.map((yy) => (
              <option key={yy} value={yy}>
                {yy}
              </option>
            ));
          })()}
        </select>
        <select
          value={month}
          onChange={(e) => {
            setPage(1);
            setMonth(e.target.value);
          }}
          className="h-8 rounded-md border border-border bg-surface px-2 text-[12px]"
        >
          <option value="">All months</option>
          {[
            "January", "February", "March", "April", "May", "June",
            "July", "August", "September", "October", "November", "December",
          ].map((label, i) => (
            <option key={label} value={i + 1}>
              {label}
            </option>
          ))}
        </select>
        <select
          value={state}
          onChange={(e) => {
            setPage(1);
            setState(e.target.value);
          }}
          className="h-8 rounded-md border border-border bg-surface px-2 text-[12px]"
        >
          <option value="">All states</option>
          {MALAYSIA_STATES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <label className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-ink-secondary">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => {
              setPage(1);
              setShowArchived(e.target.checked);
            }}
            className="accent-accent"
          />
          Show archived
        </label>
      </div>

      <DataTable
        tableId="projects"
        exportName="projects"
        search={{
          value: search,
          onChange: (v) => {
            setPage(1);
            setSearch(v);
          },
          placeholder: "Search code, name, venue, organizer…",
        }}
        columns={columns}
        rows={list.data?.data ?? null}
        loading={list.loading}
        error={list.error}
        emptyLabel="No projects yet"
        getRowKey={(r) => r.id}
        getRowClassName={(r) => (r.archived_at ? "opacity-60" : undefined)}
        onRowClick={(r) => navigate(`/projects/${r.id}`)}
        serverSort
        onSortChange={handleSortChange}
      />

      {list.data && (
        <Pagination
          page={page}
          perPage={perPage}
          total={list.data.total}
          onPageChange={setPage}
          onPerPageChange={(n) => {
            setPerPage(n);
            setPage(1);
          }}
        />
      )}

      {showCreate && (
        <CreateProjectPanel
          onClose={() => setShowCreate(false)}
          onCreated={(id) => {
            setShowCreate(false);
            navigate(`/projects/${id}`);
            list.reload();
            summary.reload();
          }}
          toast={toast}
          brands={brands.data?.data ?? []}
          eventTypes={eventTypes.data?.data ?? []}
        />
      )}

      {showImport && (
        <ImportCsvPanel
          onClose={() => setShowImport(false)}
          onDone={() => {
            list.reload();
            summary.reload();
          }}
          toast={toast}
        />
      )}
    </div>
  );
}

// ── Calendar view ────────────────────────────────────────────
// Month grid: events render as colored bars spanning their date range,
// overdue checklist items render as dots on their due date. Brand is
// used as the color key.

const BRAND_COLORS: Record<string, string> = {
  AKEMI: "bg-accent/70 text-accent-ink",
  ZANOTTI: "bg-blue-500/70 text-white",
  DUNLOPILLO: "bg-emerald-500/70 text-white",
  ERGOTEX: "bg-purple-500/70 text-white",
  "MY SOFA FACTORY": "bg-amber-500/70 text-white",
  "AKEMI C&C": "bg-rose-500/70 text-white",
};

function brandClass(brand: string | null | undefined): string {
  if (!brand) return "bg-ink-muted/60 text-white";
  return BRAND_COLORS[brand] ?? "bg-ink-muted/60 text-white";
}

// Solid brand dot — extracted from the bg-accent/70 etc above. Used
// inline next to task titles so a row's brand is readable even when
// the row itself isn't a coloured bar.
const BRAND_DOT_HEX: Record<string, string> = {
  AKEMI: "#a16a2e",
  ZANOTTI: "#3b82f6",
  DUNLOPILLO: "#10b981",
  ERGOTEX: "#a855f7",
  "MY SOFA FACTORY": "#f59e0b",
  "AKEMI C&C": "#f43f5e",
};

function brandDot(brand: string | null | undefined): string {
  return brand ? BRAND_DOT_HEX[brand] ?? "#8a8e85" : "#8a8e85";
}

// Per-task chip rendered inside a calendar cell. Compact: brand dot,
// truncated title, owner initials, overdue tint. Click opens the
// parent project's detail panel.
function CalendarTaskChip({
  task,
  onOpen,
}: {
  task: CalendarTask;
  onOpen: () => void;
}) {
  const overdue = task.is_overdue === 1;
  const initials = (task.owner_name || "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0])
    .join("")
    .toUpperCase();
  return (
    <button
      onClick={onOpen}
      title={
        `${task.project_code} · ${task.project_name}\n` +
        `${task.title}` +
        (task.owner_name ? `\nOwner: ${task.owner_name}` : "\nUnassigned") +
        (overdue ? "\n⚠ Overdue" : "")
      }
      className={cn(
        "group flex w-full items-center gap-1 rounded border px-1 py-0.5 text-left",
        overdue
          ? "border-err/40 bg-err/5 hover:bg-err/10"
          : "border-border bg-surface hover:border-accent/40 hover:bg-accent-soft/30"
      )}
    >
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ background: brandDot(task.brand) }}
      />
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-[9px] font-medium",
          overdue ? "text-err" : "text-ink"
        )}
      >
        {task.title}
      </span>
      {initials ? (
        <span
          className={cn(
            "shrink-0 rounded-full px-1 text-[8px] font-bold leading-tight",
            overdue ? "bg-err/15 text-err" : "bg-accent-soft text-accent-ink"
          )}
        >
          {initials}
        </span>
      ) : (
        <span
          className="shrink-0 rounded-full bg-bg/80 px-1 text-[8px] font-bold leading-tight text-ink-muted"
          title="Unassigned"
        >
          —
        </span>
      )}
    </button>
  );
}

interface CalendarProject {
  id: number;
  code: string;
  name: string;
  stage: ProjectStage;
  brand: string | null;
  start_date: string;
  end_date: string | null;
  venue: string | null;
  state: string | null;
}

interface CalendarTask {
  id: number;
  project_id: number;
  project_code: string;
  project_name: string;
  brand: string | null;
  title: string;
  due_date: string;
  status: string;
  required_perm: string | null;
  review_status: string | null;
  owner_name: string | null;
  is_overdue: number;
}

// ── Profitability / analytics ────────────────────────────────
// Aggregate view across every project. Four cuts (brand / state /
// event type / month) plus the biggest and smallest events by
// profit. All data served by /api/projects/analytics/profitability
// which reads from the finance rollup (already synced by the
// ledger write path).

interface ProfitabilityBreakdown {
  key: string;
  count: number;
  income: number;
  cost: number;
  profit: number;
  margin: number | null;
}

interface ProfitabilityResponse {
  filters: {
    date_from: string | null;
    date_to: string | null;
    brand: string | null;
    event_type_id: string | null;
    organizer: string | null;
  };
  totals: {
    projects: number;
    income: number;
    cost: number;
    profit: number;
    margin_pct: number | null;
  };
  by_brand: ProfitabilityBreakdown[];
  by_organizer: ProfitabilityBreakdown[];
  by_event_type: ProfitabilityBreakdown[];
  by_venue: ProfitabilityBreakdown[];
  by_month: ProfitabilityBreakdown[];
  top: Array<{
    id: number;
    code: string;
    name: string;
    brand: string | null;
    venue: string | null;
    start_date: string | null;
    income: number;
    cost: number;
    profit: number;
    margin: number | null;
  }>;
  bottom: ProfitabilityResponse["top"];
}

// Combined Finances view — what the sidebar exposes as "Finances".
// Stacks the monthly P&L calendar above the analytics breakdown so
// users see the time-series trend first, then the per-project drill-in.
function ProjectsFinancesView() {
  return (
    <div className="space-y-8">
      <PnlCalendar
        scope="projects"
        title="Project Cost — Monthly"
        subtitle="Ledger costs across all projects, grouped by month."
      />
      <ProjectsAnalyticsView />
    </div>
  );
}

function ProjectsAnalyticsView() {
  // Date range default: current year. User can clear or change.
  const thisYear = new Date().getFullYear();
  const navigate = useNavigate();
  const [dateFrom, setDateFrom] = useState<string>(`${thisYear}-01-01`);
  const [dateTo, setDateTo] = useState<string>(`${thisYear}-12-31`);
  const [brand, setBrand] = useState<string>("");
  const [organizer, setOrganizer] = useState<string>("");
  const [eventTypeId, setEventTypeId] = useState<string>("");
  const toast = useToast();

  const brands = useQuery<{ data: string[] }>(() => api.get("/api/projects/brands"));
  const eventTypes = useQuery<{ data: EventType[] }>(() =>
    api.get("/api/projects/event-types")
  );
  const organizers = useQuery<{ data: { id: number; name: string }[] }>(() =>
    api.get("/api/projects/organizers")
  );

  const q = useQuery<ProfitabilityResponse>(
    () =>
      api.get(
        `/api/projects/analytics/profitability${buildQuery({
          date_from: dateFrom || undefined,
          date_to: dateTo || undefined,
          brand: brand || undefined,
          organizer: organizer || undefined,
          event_type_id: eventTypeId || undefined,
        })}`
      ),
    [dateFrom, dateTo, brand, organizer, eventTypeId]
  );

  const d = q.data;

  return (
    <div>
      <PageHeader
        eyebrow="Operations · Projects"
        title="Profitability"
        description="Income, cost, and margin across every event — sliced by brand, venue, type, and month."
      />

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
            From
          </div>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="h-8 rounded-md border border-border bg-surface px-2 text-[12px]"
          />
        </div>
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
            To
          </div>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="h-8 rounded-md border border-border bg-surface px-2 text-[12px]"
          />
        </div>
        <select
          value={brand}
          onChange={(e) => setBrand(e.target.value)}
          className="h-8 appearance-none rounded-md border border-border bg-surface px-2 text-[12px]"
        >
          <option value="">All brands</option>
          {(brands.data?.data ?? []).map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
        <select
          value={eventTypeId}
          onChange={(e) => setEventTypeId(e.target.value)}
          className="h-8 appearance-none rounded-md border border-border bg-surface px-2 text-[12px]"
        >
          <option value="">All types</option>
          {(eventTypes.data?.data ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <select
          value={organizer}
          onChange={(e) => setOrganizer(e.target.value)}
          className="h-8 appearance-none rounded-md border border-border bg-surface px-2 text-[12px]"
        >
          <option value="">All organizers</option>
          {(organizers.data?.data ?? []).map((o) => (
            <option key={o.id} value={o.name}>
              {o.name}
            </option>
          ))}
        </select>
        <button
          onClick={() => {
            setDateFrom("");
            setDateTo("");
            setBrand("");
            setOrganizer("");
            setEventTypeId("");
          }}
          className="h-8 rounded-md border border-border bg-surface px-2.5 text-[11px] text-ink-secondary hover:border-accent/40 hover:text-accent"
        >
          Clear
        </button>
        {q.loading && <span className="text-[11px] text-ink-muted">Loading…</span>}
      </div>

      {q.error && (
        <div className="mb-4 rounded-md border border-err/40 bg-err/5 px-4 py-2 text-[12px] text-err">
          {q.error}
        </div>
      )}

      {d && (
        <>
          {/* Headline */}
          <DashboardGrid cols={4}>
            <StatCard
              label="Projects"
              value={d.totals.projects.toLocaleString()}
              subtitle="In scope"
            />
            <StatCard
              label="Income"
              value={formatCurrency(d.totals.income, { compact: true })}
              subtitle="Total sales + refunds"
            />
            <StatCard
              label="Cost"
              value={formatCurrency(d.totals.cost, { compact: true })}
              subtitle="Rental + contractor + misc"
              tone="error"
            />
            <StatCard
              label="Profit"
              value={formatCurrency(d.totals.profit, { compact: true })}
              subtitle={
                d.totals.margin_pct != null
                  ? `${d.totals.margin_pct.toFixed(1)}% margin`
                  : "—"
              }
              tone={d.totals.profit >= 0 ? "success" : "error"}
            />
          </DashboardGrid>

          {/* Breakdowns — two columns */}
          <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <BreakdownCard title="By Brand" rows={d.by_brand} />
            <BreakdownCard title="By Event Type" rows={d.by_event_type} />
            <BreakdownCard title="By Organizer" rows={d.by_organizer} />
            <BreakdownCard title="By Venue" rows={d.by_venue} />
            <BreakdownCard title="By Month" rows={d.by_month} monthMode />
          </div>

          {/* Ranked events */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <RankedCard
              title="Top 5 by profit"
              tone="synced"
              rows={d.top}
              onOpen={(id) => navigate(`/projects/${id}`)}
            />
            <RankedCard
              title="Bottom 5 by profit"
              tone="err"
              rows={d.bottom}
              onOpen={(id) => navigate(`/projects/${id}`)}
            />
          </div>
        </>
      )}
    </div>
  );
}

function BreakdownCard({
  title,
  rows,
  monthMode,
}: {
  title: string;
  rows: ProfitabilityBreakdown[] | undefined;
  monthMode?: boolean;
}) {
  // Defensive: a stale API response (or a cache miss against an older
  // worker version) can leave a breakdown field undefined. Don't crash.
  const safeRows = rows ?? [];
  const maxAbsProfit = Math.max(1, ...safeRows.map((r) => Math.abs(r.profit)));
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-surface shadow-stone">
      <header className="flex items-center justify-between border-b border-border-subtle px-4 py-2.5">
        <h3 className="inline-flex items-center gap-2 text-[11px] font-bold uppercase tracking-brand text-ink">
          <BarChart3 size={12} className="text-accent" />
          {title}
        </h3>
        <span className="text-[10px] text-ink-muted">{safeRows.length} groups</span>
      </header>
      {safeRows.length === 0 ? (
        <div className="px-4 py-6 text-center text-[11px] text-ink-muted">No data.</div>
      ) : (
        <div className="max-h-[320px] overflow-y-auto">
          <table className="w-full text-[11px]">
            <thead className="bg-bg/40 text-[9px] font-semibold uppercase tracking-wider text-ink-muted">
              <tr>
                <th className="px-3 py-1.5 text-left">{monthMode ? "Month" : "Name"}</th>
                <th className="px-2 py-1.5 text-right">#</th>
                <th className="px-2 py-1.5 text-right">Income</th>
                <th className="px-2 py-1.5 text-right">Profit</th>
                <th className="px-2 py-1.5 text-right">Margin</th>
              </tr>
            </thead>
            <tbody>
              {safeRows.map((r) => {
                const barPct = Math.round((Math.abs(r.profit) / maxAbsProfit) * 100);
                return (
                  <tr key={r.key} className="border-t border-border-subtle">
                    <td className="px-3 py-1.5">
                      <div className="font-semibold text-ink">
                        {monthMode ? formatMonth(r.key) : r.key}
                      </div>
                      <div className="mt-0.5 h-[3px] w-full rounded-full bg-bg">
                        <div
                          className={cn(
                            "h-full rounded-full",
                            r.profit >= 0 ? "bg-synced" : "bg-err"
                          )}
                          style={{ width: `${barPct}%` }}
                        />
                      </div>
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono">{r.count}</td>
                    <td className="px-2 py-1.5 text-right font-mono">
                      {formatCurrency(r.income, { compact: true })}
                    </td>
                    <td
                      className={cn(
                        "px-2 py-1.5 text-right font-mono font-bold",
                        r.profit >= 0 ? "text-synced" : "text-err"
                      )}
                    >
                      {formatCurrency(r.profit, { compact: true })}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono text-ink-secondary">
                      {r.margin != null ? `${r.margin.toFixed(1)}%` : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function RankedCard({
  title,
  tone,
  rows,
  onOpen,
}: {
  title: string;
  tone: "synced" | "err";
  rows: ProfitabilityResponse["top"] | undefined;
  onOpen: (id: number) => void;
}) {
  const safeRows = rows ?? [];
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-surface shadow-stone">
      <header className="flex items-center justify-between border-b border-border-subtle px-4 py-2.5">
        <h3
          className={cn(
            "text-[11px] font-bold uppercase tracking-brand",
            tone === "synced" ? "text-synced" : "text-err"
          )}
        >
          {title}
        </h3>
        <span className="text-[10px] text-ink-muted">{safeRows.length}</span>
      </header>
      {safeRows.length === 0 ? (
        <div className="px-4 py-6 text-center text-[11px] text-ink-muted">No data.</div>
      ) : (
        <ul>
          {safeRows.map((r) => (
            <li key={r.id}>
              <button
                onClick={() => onOpen(r.id)}
                className="flex w-full items-start gap-3 border-t border-border-subtle px-4 py-2 text-left hover:bg-accent-soft/30"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono text-[10px] text-ink-muted">{r.code}</span>
                    {r.brand && (
                      <span className="rounded bg-accent/10 px-1 text-[9px] font-bold text-accent">
                        {r.brand}
                      </span>
                    )}
                    <span className="truncate text-[12px] font-semibold text-ink">
                      {r.name}
                    </span>
                  </div>
                  <div className="text-[10px] text-ink-muted">
                    {r.venue || "—"}
                    {r.start_date && ` · ${formatDate(r.start_date)}`}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div
                    className={cn(
                      "font-mono text-[12px] font-bold",
                      tone === "synced" ? "text-synced" : "text-err"
                    )}
                  >
                    {formatCurrency(r.profit, { compact: true })}
                  </div>
                  <div className="text-[10px] text-ink-muted">
                    {r.margin != null ? `${r.margin.toFixed(1)}%` : "—"}
                  </div>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function formatMonth(yyyy_mm: string): string {
  const [y, m] = yyyy_mm.split("-");
  if (!y || !m) return yyyy_mm;
  const d = new Date(Number(y), Number(m) - 1, 1);
  return d.toLocaleDateString("en-MY", { month: "short", year: "numeric" });
}

function ProjectsCalendarView() {
  const toast = useToast();
  const navigate = useNavigate();
  const [anchor, setAnchor] = useState<Date>(() => {
    const d = new Date();
    d.setDate(1);
    return d;
  });

  // First of month → last of month. Cover 6 weeks (42 cells) starting
  // from the first Sunday on/before the 1st.
  const first = new Date(Date.UTC(anchor.getFullYear(), anchor.getMonth(), 1));
  const startDay = new Date(first);
  startDay.setUTCDate(first.getUTCDate() - first.getUTCDay());
  const endDay = new Date(startDay);
  endDay.setUTCDate(startDay.getUTCDate() + 41);

  const fromStr = startDay.toISOString().slice(0, 10);
  const toStr = endDay.toISOString().slice(0, 10);

  const q = useQuery<{ projects: CalendarProject[]; tasks: CalendarTask[] }>(
    () => api.get(`/api/projects/calendar/events?from=${fromStr}&to=${toStr}`),
    [fromStr, toStr]
  );

  // Build 42-cell grid
  const cells: { date: Date; iso: string }[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(startDay);
    d.setUTCDate(startDay.getUTCDate() + i);
    cells.push({ date: d, iso: d.toISOString().slice(0, 10) });
  }

  const projects = q.data?.projects ?? [];
  const tasks = q.data?.tasks ?? [];

  // Group tasks by date for fast lookup
  const tasksByDate = new Map<string, CalendarTask[]>();
  for (const t of tasks) {
    const key = t.due_date.slice(0, 10);
    const arr = tasksByDate.get(key) ?? [];
    arr.push(t);
    tasksByDate.set(key, arr);
  }

  // Projects that touch each cell — include events that span multiple
  // cells by checking both start and end.
  function projectsOn(iso: string): CalendarProject[] {
    return projects.filter((p) => {
      const s = p.start_date.slice(0, 10);
      const e = (p.end_date || p.start_date).slice(0, 10);
      return iso >= s && iso <= e;
    });
  }

  const monthLabel = anchor.toLocaleDateString("en-MY", { month: "long", year: "numeric" });
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div>
      <PageHeader
        eyebrow="Operations · Projects"
        title="Project Calendar"
        description="Event spans and checklist due dates across all brands"
      />

      <div className="mb-4 flex items-center gap-2">
        <button
          onClick={() => {
            const d = new Date(anchor);
            d.setMonth(d.getMonth() - 1);
            setAnchor(d);
          }}
          className="rounded-md border border-border bg-surface px-3 py-1.5 text-[12px] hover:border-accent/40"
        >
          ←
        </button>
        <button
          onClick={() => {
            const d = new Date();
            d.setDate(1);
            setAnchor(d);
          }}
          className="rounded-md border border-border bg-surface px-3 py-1.5 text-[12px] hover:border-accent/40"
        >
          Today
        </button>
        <button
          onClick={() => {
            const d = new Date(anchor);
            d.setMonth(d.getMonth() + 1);
            setAnchor(d);
          }}
          className="rounded-md border border-border bg-surface px-3 py-1.5 text-[12px] hover:border-accent/40"
        >
          →
        </button>
        <span className="ml-2 font-display text-lg font-bold">{monthLabel}</span>
        <div className="ml-auto flex flex-wrap items-center gap-1.5 text-[10px]">
          {Object.entries(BRAND_COLORS).map(([b, cls]) => (
            <span key={b} className="inline-flex items-center gap-1">
              <span className={cn("h-2 w-2 rounded-full", cls.split(" ")[0])} />
              <span className="text-ink-muted">{b}</span>
            </span>
          ))}
        </div>
      </div>

      {q.loading && <div className="text-[12px] text-ink-muted">Loading calendar…</div>}
      {q.error && (
        <div className="rounded-md border border-err/40 bg-err/5 p-3 text-[12px] text-err">
          {q.error}
        </div>
      )}

      <div className="rounded-md border border-border bg-surface">
        {/* Weekday header */}
        <div className="grid grid-cols-7 border-b border-border bg-bg/60">
          {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
            <div
              key={d}
              className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted"
            >
              {d}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {cells.map((cell, idx) => {
            const inMonth = cell.date.getUTCMonth() === anchor.getMonth();
            const cellProjects = projectsOn(cell.iso);
            const cellTasks = tasksByDate.get(cell.iso) ?? [];
            const isToday = cell.iso === today;
            return (
              <div
                key={idx}
                className={cn(
                  "min-h-[110px] border-b border-r border-border px-1.5 py-1 text-[10px]",
                  !inMonth && "bg-bg/40 text-ink-muted",
                  isToday && "bg-accent-soft/30"
                )}
              >
                <div className="mb-1 flex items-center justify-between">
                  <span className={cn("font-mono", isToday && "font-bold text-accent")}>
                    {cell.date.getUTCDate()}
                  </span>
                  {cellTasks.length > 0 && (
                    <span
                      title={`${cellTasks.length} task(s) due`}
                      className={cn(
                        "inline-flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-[9px] font-bold",
                        cellTasks.some((t) => t.is_overdue)
                          ? "bg-err text-white"
                          : "bg-amber-100 text-amber-800"
                      )}
                    >
                      {cellTasks.length}
                    </span>
                  )}
                </div>

                {/* Project event bars (existing) */}
                <div className="space-y-0.5">
                  {cellProjects.slice(0, 2).map((p) => (
                    <button
                      key={p.id}
                      onClick={() => navigate(`/projects/${p.id}`)}
                      title={`${p.code} — ${p.name}${p.venue ? ` · ${p.venue}` : ""}`}
                      className={cn(
                        "block w-full truncate rounded px-1 py-0.5 text-left text-[9px] font-semibold",
                        brandClass(p.brand)
                      )}
                    >
                      {p.name}
                    </button>
                  ))}
                  {cellProjects.length > 2 && (
                    <div className="text-[9px] text-ink-muted">
                      +{cellProjects.length - 2} more event{cellProjects.length - 2 === 1 ? "" : "s"}
                    </div>
                  )}
                </div>

                {/* Task chips — clickable, brand-tinted, owner initial */}
                {cellTasks.length > 0 && (
                  <div className="mt-1 space-y-0.5 border-t border-border-subtle pt-1">
                    {cellTasks.slice(0, 2).map((t) => (
                      <CalendarTaskChip
                        key={t.id}
                        task={t}
                        onOpen={() => navigate(`/projects/${t.project_id}`)}
                      />
                    ))}
                    {cellTasks.length > 2 && (
                      <button
                        onClick={() => {
                          // Open the project of the first remaining task — best
                          // we can do without a tasks-per-day modal.
                          const first = cellTasks[2];
                          if (first) navigate(`/projects/${first.project_id}`);
                        }}
                        title={cellTasks
                          .slice(2)
                          .map((t) => `${t.project_code}: ${t.title}`)
                          .join("\n")}
                        className="block text-[9px] font-semibold text-accent hover:underline"
                      >
                        +{cellTasks.length - 2} more task{cellTasks.length - 2 === 1 ? "" : "s"}
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

    </div>
  );
}

// ── Progress bar ─────────────────────────────────────────────

function ProgressBar({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div className="inline-flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-border">
        <div
          className={cn(
            "h-full rounded-full transition-all",
            clamped >= 100 ? "bg-synced" : "bg-accent"
          )}
          style={{ width: `${clamped}%` }}
        />
      </div>
      <span className="font-mono text-[11px] text-ink-secondary">{clamped}%</span>
    </div>
  );
}

// ── Create Panel ─────────────────────────────────────────────

function CreateProjectPanel({
  onClose,
  onCreated,
  toast,
  brands,
  eventTypes,
}: {
  onClose: () => void;
  onCreated: (id: number) => void;
  toast: ReturnType<typeof useToast>;
  brands: string[];
  eventTypes: EventType[];
}) {
  const [name, setName] = useState("");
  const [eventTypeId, setEventTypeId] = useState<string>("");
  const [brand, setBrand] = useState<string>("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [venue, setVenue] = useState("");
  const [state, setState] = useState("");
  const [organizer, setOrganizer] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (!name.trim()) {
      toast.error("Name is required");
      return;
    }
    setSubmitting(true);
    try {
      const res = await api.post<{ id: number; code: string }>("/api/projects", {
        name: name.trim(),
        event_type_id: eventTypeId ? parseInt(eventTypeId, 10) : undefined,
        brand: brand || undefined,
        start_date: startDate || undefined,
        end_date: endDate || undefined,
        venue: venue.trim() || undefined,
        state: state.trim() || undefined,
        organizer: organizer.trim() || undefined,
      });
      toast.success(`Created ${res.code}`);
      onCreated(res.id);
    } catch (e: any) {
      toast.error(e?.message || "Failed to create");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Panel
      open
      onClose={onClose}
      title="New Project"
      subtitle="Picking an event type pre-loads the default checklist"
      width={480}
      footer={
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-md border border-border bg-surface px-3 py-2 text-[12px] text-ink-secondary"
          >
            Cancel
          </button>
          <Button variant="primary" onClick={submit} disabled={submitting || !name.trim()}>
            {submitting ? "Creating…" : "Create Project"}
          </Button>
        </div>
      }
    >
      <PanelSection title="Basics">
        <div>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
            Project Name
          </div>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. PIKOM PC Fair 2026"
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
              Event Type
            </div>
            <select
              value={eventTypeId}
              onChange={(e) => setEventTypeId(e.target.value)}
              className="w-full appearance-none rounded-md border border-border bg-surface px-3 py-2 text-[13px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
            >
              <option value="">— none —</option>
              {eventTypes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
              Brand
            </div>
            <select
              value={brand}
              onChange={(e) => setBrand(e.target.value)}
              className="w-full appearance-none rounded-md border border-border bg-surface px-3 py-2 text-[13px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
            >
              <option value="">— none —</option>
              {brands.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </div>
        </div>
      </PanelSection>

      <PanelSection title="Dates">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
              Start
            </div>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px]"
            />
          </div>
          <div>
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
              End
            </div>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px]"
            />
          </div>
        </div>
      </PanelSection>

      <PanelSection title="Venue">
        <div>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
            Venue
          </div>
          <VenuePicker
            value={venue || null}
            onChange={(v) => setVenue(v ?? "")}
            onStateHint={(s) => {
              if (s && !state) setState(s);
            }}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
              State
            </div>
            <select
              value={state}
              onChange={(e) => setState(e.target.value)}
              className="w-full appearance-none rounded-md border border-border bg-surface px-3 py-2 text-[13px]"
            >
              <option value="">— select —</option>
              {MALAYSIA_STATES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div>
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
              Organizer
            </div>
            <OrganizerPicker
              value={organizer}
              onChange={(v) => setOrganizer(v ?? "")}
            />
          </div>
        </div>
      </PanelSection>
    </Panel>
  );
}

// ── Detail Panel ─────────────────────────────────────────────

function ProjectDetailContent({
  id,
  onUpdated,
  toast,
  brands,
  eventTypes,
}: {
  id: number;
  onUpdated: () => void;
  toast: ReturnType<typeof useToast>;
  brands: string[];
  eventTypes: EventType[];
}) {
  const { can } = useAuth();
  const dialog = useDialog();
  const detail = useQuery<ProjectDetail>(() => api.get(`/api/projects/${id}`), [id]);
  // Users list — fetched once per open panel, reused for owner pickers
  // in the logistics section, checklist add form, and reassign dropdowns.
  const usersQ = useQuery<{ id: number; name: string }[]>(
    () => api.get<any>("/api/users").then((r: any) => r.users ?? r.data ?? r ?? []),
    []
  );
  const users = usersQ.data ?? [];
  const [transitioning, setTransitioning] = useState(false);
  const [addItemOpen, setAddItemOpen] = useState(false);

  const p = detail.data?.project;
  const checklist = detail.data?.checklist ?? [];
  const activity = detail.data?.activity ?? [];
  const trips = detail.data?.trips ?? [];
  const attachments = detail.data?.attachments ?? [];
  const [showTripPicker, setShowTripPicker] = useState(false);

  async function patch(body: Record<string, any>) {
    await api.patch(`/api/projects/${id}`, body);
    detail.reload();
    onUpdated();
  }

  async function transition(stage: ProjectStage) {
    setTransitioning(true);
    try {
      await patch({ stage });
    } catch (e: any) {
      toast.error(e?.message || "Transition failed");
    } finally {
      setTransitioning(false);
    }
  }

  async function setItemStatus(item: ChecklistItem, status: ChecklistStatus) {
    if (item.required_perm && !can(item.required_perm)) {
      toast.error(`Requires ${item.required_perm} permission`);
      return;
    }
    try {
      await api.post(`/api/projects/checklist/${item.id}/status`, { status });
      detail.reload();
      onUpdated();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    }
  }

  async function deleteItem(item: ChecklistItem) {
    if (!await dialog.confirm(`Remove "${item.title}"?`)) return;
    try {
      await api.del(`/api/projects/checklist/${item.id}`);
      detail.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    }
  }

  const nextStage = p ? NEXT_STAGE[p.stage] : null;

  return (
    <DetailLayout
      breadcrumbs={[
        { label: "Projects", to: "/projects" },
        { label: p?.code || "Loading…" },
      ]}
      eyebrow={p?.code ? `Project · ${p.code}` : "Project"}
      title={p?.name || "Loading…"}
      description={p ? `${STAGE_LABEL[p.stage]}${p.brand ? ` · ${p.brand}` : ""}${p.venue ? ` · ${p.venue}` : ""}${p.duration_days ? ` · ${p.duration_days} day${p.duration_days === 1 ? "" : "s"}` : ""}` : undefined}
      backTo="/projects"
      loading={detail.loading && !p}
      error={detail.error}
      actions={
        p ? (
          <>
            {p.archived_at ? (
              <HeaderButton
                variant="ghost"
                onClick={async () => {
                  try {
                    await api.post(`/api/projects/${id}/unarchive`);
                    toast.success("Restored");
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
                  if (!(await dialog.confirm("Archive this project?"))) return;
                  try {
                    await api.post(`/api/projects/${id}/archive`);
                    toast.success("Archived");
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
            {nextStage && !p.archived_at && (
              <HeaderButton
                variant="primary"
                onClick={() => transition(nextStage.stage)}
                disabled={transitioning}
              >
                {transitioning ? "…" : nextStage.label}
              </HeaderButton>
            )}
          </>
        ) : undefined
      }
    >
      {/* DetailLayout owns the loading/error chrome — keep this no-op for legacy in-page loading hint */}
      {false && <div className="hidden">noop</div>}
      {detail.loading && <div className="p-6 text-sm text-ink-muted">Loading…</div>}
      {detail.error && !detail.loading && (
        <div className="m-5 rounded-md border border-err/40 bg-err/5 p-4 text-sm">
          <div className="font-semibold text-err">Failed to load project</div>
          <div className="mt-1 text-[12px] text-ink-secondary break-words">{detail.error}</div>
        </div>
      )}
      {p && (
        <>
          {/* Banner — optional per-project warning */}
          {p.banner_message && <ProjectBanner message={p.banner_message} tone={p.banner_tone} />}

          {/* Stage + progress header */}
          <div className="mb-5 flex flex-wrap items-center gap-3 rounded-md border border-border bg-bg/60 px-4 py-3">
            <StatusDot variant={stageVariant(p.stage)} label={STAGE_LABEL[p.stage]} />
            <ProgressBar pct={p.progress_pct ?? 0} />
            {p.duration_days != null && (
              <span className="inline-flex items-center gap-1 text-[11px] text-ink-secondary">
                <Calendar size={11} />
                {p.duration_days} day{p.duration_days === 1 ? "" : "s"}
              </span>
            )}
            {p.brand && (
              <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-bold tracking-wide text-accent">
                {p.brand}
              </span>
            )}
            <button
              onClick={async () => {
                try {
                  await api.openHtml(`/api/projects-print/${id}`);
                } catch (e: any) {
                  toast.error(e?.message || "Failed to open print view");
                }
              }}
              className="ml-auto inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2.5 py-1 text-[10.5px] font-semibold text-ink hover:border-accent/40 hover:text-accent"
              title="Open event summary — A4 printable"
            >
              <Printer size={11} /> Print
            </button>
          </div>
          <DetailGrid>
            <DetailMain>
          <PaymentSection
            projectId={id}
            project={p}
            onChange={() => {
              detail.reload();
              onUpdated();
            }}
            toast={toast}
          />

          <LogisticsScheduleSection project={p} patch={patch} />

          <StockTransferSection
            projectId={id}
            transfers={detail.data?.stock_transfers ?? []}
            onChange={() => detail.reload()}
            toast={toast}
          />

          {/* DefectsSection intentionally not rendered — kept in code as a
              future option but the team isn't using it day-to-day. */}

          <SalesReportsSection
            projectId={id}
            reports={detail.data?.sales_reports ?? []}
            onChange={() => detail.reload()}
            toast={toast}
          />

          <PanelSection title={`Checklist (${checklist.length})`}>
            <div className="space-y-1.5">
              {checklist.map((item) => (
                <ChecklistRow
                  key={item.id}
                  item={item}
                  users={users}
                  comments={(detail.data?.checklist_comments ?? []).filter(
                    (c) => c.item_id === item.id
                  )}
                  canApprove={!item.required_perm || can(item.required_perm)}
                  onStatus={(s) => setItemStatus(item, s)}
                  onDelete={() => deleteItem(item)}
                  onReassign={async (ownerId) => {
                    try {
                      await api.patch(`/api/projects/checklist/${item.id}`, {
                        owner_user_id: ownerId,
                      });
                      detail.reload();
                    } catch (e: any) {
                      toast.error(e?.message || "Failed");
                    }
                  }}
                  onReview={async (action, payload) => {
                    try {
                      await api.post(`/api/projects/checklist/${item.id}/review`, {
                        action,
                        ...payload,
                      });
                      detail.reload();
                    } catch (e: any) {
                      toast.error(e?.message || "Failed");
                    }
                  }}
                />
              ))}
              {checklist.length === 0 && (
                <div className="text-[11px] text-ink-muted">No checklist items.</div>
              )}
            </div>
            {addItemOpen ? (
              <AddChecklistItem
                projectId={id}
                users={users}
                onAdded={() => {
                  setAddItemOpen(false);
                  detail.reload();
                }}
                onCancel={() => setAddItemOpen(false)}
                toast={toast}
              />
            ) : (
              <button
                onClick={() => setAddItemOpen(true)}
                className="mt-2 inline-flex items-center gap-1 rounded-md border border-dashed border-border px-3 py-1.5 text-[11px] text-ink-muted hover:border-accent/40 hover:text-accent"
              >
                <Plus size={11} /> Add item
              </button>
            )}
          </PanelSection>

          <FinanceLedgerSection
            projectId={id}
            sizeSqm={p.size_sqm ?? null}
            durationDays={p.duration_days ?? null}
            lines={detail.data?.finance_lines ?? []}
            onChange={() => detail.reload()}
            toast={toast}
          />

          <AttachmentsSection
            projectId={id}
            attachments={attachments}
            onChange={() => detail.reload()}
            toast={toast}
          />

          <PanelSection title={`Linked Trips (${trips.length})`}>
            {trips.length === 0 ? (
              <div className="text-[11px] text-ink-muted">
                No trips linked yet.
              </div>
            ) : (
              <div className="space-y-1.5">
                {trips.map((t) => (
                  <div
                    key={t.id}
                    className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-[11px]"
                  >
                    <span className="font-mono font-semibold">{t.code}</span>
                    <span className="text-ink-muted">·</span>
                    <span>{formatDate(t.scheduled_date)}</span>
                    <span className="text-ink-muted">·</span>
                    <span className="capitalize">{t.status}</span>
                    {t.trip_type && (
                      <span className="rounded-full bg-accent/10 px-1.5 py-0.5 text-[9px] font-semibold text-accent">
                        {t.trip_type}
                      </span>
                    )}
                    {t.description && (
                      <span className="truncate text-ink-secondary">— {t.description}</span>
                    )}
                    <button
                      onClick={async () => {
                        if (!await dialog.confirm("Unlink this trip from the project?")) return;
                        try {
                          await api.post(`/api/projects/trips/${t.id}/unlink`, {});
                          detail.reload();
                        } catch (e: any) {
                          toast.error(e?.message || "Failed");
                        }
                      }}
                      className="ml-auto rounded p-1 text-ink-muted hover:text-err"
                      title="Unlink"
                    >
                      <Unlink size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <button
              onClick={() => setShowTripPicker(true)}
              className="mt-2 inline-flex items-center gap-1 rounded-md border border-dashed border-border px-3 py-1.5 text-[11px] text-ink-muted hover:border-accent/40 hover:text-accent"
            >
              <Link2 size={11} /> Link existing trip
            </button>
            {showTripPicker && (
              <TripPicker
                projectId={id}
                onClose={() => setShowTripPicker(false)}
                onLinked={() => {
                  setShowTripPicker(false);
                  detail.reload();
                }}
                toast={toast}
              />
            )}
          </PanelSection>

          <PanelSection title="Chat">
            <ProjectChat
              projectId={id}
              activity={activity}
              canPost={can("projects.write")}
              onPosted={() => detail.reload()}
              toast={toast}
            />
          </PanelSection>
            </DetailMain>

            <DetailAside>
          <PanelSection title="Basics" muted>
            <InlineEdit label="Name" value={p.name} onSave={(v) => patch({ name: v })} />
            {(() => {
              const suggested = composeEventName({
                state: p.state,
                brand: p.brand,
                event_type_name: p.event_type_name,
                venue: p.venue,
              });
              if (!suggested || suggested === p.name) return null;
              return (
                <button
                  onClick={() => patch({ name: suggested })}
                  className="-mt-1 inline-flex items-center gap-1 self-start rounded-md border border-dashed border-accent/40 bg-accent-soft/20 px-2 py-1 text-[10px] font-semibold text-accent hover:bg-accent-soft/40"
                  title="Replace name with STATE - BRAND - TYPE - VENUE"
                >
                  Use convention: {suggested}
                </button>
              );
            })()}
            <InlineEdit
              label="Brand"
              value={p.brand}
              options={brands}
              onSave={(v) => patch({ brand: v })}
            />
            <div>
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
                Event Type
              </div>
              <select
                value={p.event_type_id ?? ""}
                onChange={(e) => {
                  const v = e.target.value;
                  patch({ event_type_id: v ? parseInt(v, 10) : null });
                }}
                className="w-full appearance-none rounded-md border border-border bg-surface px-3 py-2 text-[13px]"
              >
                <option value="">— none —</option>
                {eventTypes.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
            <FieldRow label="Code" mono>{p.code}</FieldRow>
            <FieldRow label="Created">
              {formatDate(p.created_at)} · {p.created_by_name || "—"}
            </FieldRow>
          </PanelSection>

          <PanelSection title="Dates" muted>
            <InlineEdit
              label="Start Date"
              type="date"
              value={p.start_date}
              onSave={(v) => patch({ start_date: v })}
            />
            <InlineEdit
              label="End Date"
              type="date"
              value={p.end_date}
              onSave={(v) => patch({ end_date: v })}
            />
          </PanelSection>

          <PanelSection title="Venue">
            <div>
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
                Venue
              </div>
              <VenuePicker
                value={p.venue}
                onChange={(v) => patch({ venue: v })}
                onStateHint={(s) => {
                  if (s && !p.state) patch({ state: s });
                }}
              />
            </div>
            <InlineEdit
              label="State"
              value={p.state}
              options={MALAYSIA_STATES}
              onSave={(v) => patch({ state: v })}
            />
            <div>
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
                Organizer
              </div>
              <OrganizerPicker
                value={p.organizer}
                onChange={(v) => patch({ organizer: v })}
              />
            </div>
          </PanelSection>

          <PanelSection title="Booth">
            <InlineEdit label="Booth No" value={p.booth_no} onSave={(v) => patch({ booth_no: v })} />
            <InlineEdit
              label="Size (m²)"
              type="number"
              value={p.size_sqm}
              onSave={(v) => patch({ size_sqm: v ? parseFloat(v) : null })}
            />
          </PanelSection>

          <PanelSection title="External Links">
            <InlineEdit
              label="Notion URL"
              value={p.notion_url}
              onSave={(v) => patch({ notion_url: v })}
              placeholder="https://notion.so/…"
            />
            {p.notion_url && (
              <a
                href={p.notion_url}
                target="_blank"
                rel="noreferrer"
                className="text-[12px] text-accent underline"
              >
                Open in Notion ↗
              </a>
            )}
          </PanelSection>

          {p.start_date && (
            <PanelSection title="Add to Calendar" muted>
              <a
                href={googleCalendarUrl(p)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-[11px] font-semibold text-ink hover:border-accent/40 hover:text-accent"
              >
                <Calendar size={11} /> Open in Google Calendar
                <ExternalLink size={10} />
              </a>
              <div className="mt-1 text-[10px] text-ink-muted">
                Opens Google Calendar's prefilled "new event" form. Saves to your own calendar only.
              </div>
            </PanelSection>
          )}

            </DetailAside>
          </DetailGrid>
        </>
      )}
    </DetailLayout>
  );
}

/**
 * Page wrapper — mounted at /projects/:id. Reads the URL, fetches the
 * brand + event-type lookup lists once, hands the inner content the
 * project id and a no-op `onUpdated` (the page owns its own queries).
 */
export function ProjectDetail() {
  const { id: idStr } = useParams<{ id: string }>();
  const id = idStr ? parseInt(idStr, 10) : NaN;
  const toast = useToast();
  const brandsQ = useQuery<{ data: string[] }>(() => api.get("/api/projects/brands"));
  const eventTypesQ = useQuery<{ data: EventType[] }>(() =>
    api.get("/api/projects/event-types")
  );

  if (isNaN(id)) return <Navigate to="/projects" replace />;

  return (
    <ProjectDetailContent
      id={id}
      onUpdated={() => {}}
      toast={toast}
      brands={brandsQ.data?.data ?? []}
      eventTypes={eventTypesQ.data?.data ?? []}
    />
  );
}

// ── Checklist row ────────────────────────────────────────────

const REVIEW_BADGES: Record<string, { label: string; cls: string }> = {
  pending_review: { label: "In Review", cls: "bg-amber-100 text-amber-800" },
  rejected: { label: "Rejected", cls: "bg-err/10 text-err" },
  amended: { label: "Amended", cls: "bg-accent/15 text-accent" },
  approved: { label: "Approved", cls: "bg-synced/15 text-synced" },
};

function ChecklistRow({
  item,
  comments,
  users,
  canApprove,
  onStatus,
  onDelete,
  onReview,
  onReassign,
}: {
  item: ChecklistItem;
  comments: ChecklistComment[];
  users: { id: number; name: string }[];
  canApprove: boolean;
  onStatus: (s: ChecklistStatus) => void;
  onDelete: () => void;
  onReview: (
    action: "submit" | "reject" | "amend" | "approve" | "comment",
    payload: { reason?: string; note?: string }
  ) => void | Promise<void>;
  onReassign: (ownerId: number | null) => void | Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");

  const overdue =
    item.status === "pending" &&
    item.due_date &&
    new Date(item.due_date) < new Date(new Date().toISOString().slice(0, 10));
  const reviewBadge = item.review_status ? REVIEW_BADGES[item.review_status] : null;
  const awaitingReview = item.review_status === "pending_review" || item.review_status === "amended";

  return (
    <div
      className={cn(
        "rounded-md border border-border bg-surface px-2.5 py-2",
        item.status === "done" && "bg-synced/5",
        item.status === "na" && "opacity-60",
        overdue && "border-err/40 bg-err/5",
        item.review_status === "rejected" && "border-err/30"
      )}
    >
      <div className="flex items-start gap-2">
        <button
          onClick={() => onStatus(item.status === "done" ? "pending" : "done")}
          disabled={!canApprove}
          className="mt-0.5 shrink-0"
          title={canApprove ? "Toggle done" : `Requires ${item.required_perm}`}
        >
          {item.status === "done" ? (
            <CheckCircle2 size={16} className="text-synced" />
          ) : !canApprove ? (
            <Lock size={16} className="text-ink-muted" />
          ) : (
            <Circle size={16} className="text-ink-muted hover:text-accent" />
          )}
        </button>
        <div className="flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                "text-[12px] font-medium",
                item.status === "done" && "text-ink-muted line-through"
              )}
            >
              {item.title}
            </span>
            {item.required_perm && (
              <span
                className="inline-flex items-center gap-0.5 rounded-full bg-accent-soft px-1.5 py-0.5 text-[9px] font-semibold text-accent"
                title={item.required_perm}
              >
                <Lock size={8} /> gated
              </span>
            )}
            {reviewBadge && (
              <span
                className={cn(
                  "rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider",
                  reviewBadge.cls
                )}
              >
                {reviewBadge.label}
              </span>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-ink-muted">
            {item.due_date && (
              <span className={cn(overdue && "font-semibold text-err")}>
                Due {formatDate(item.due_date)}
              </span>
            )}
            {item.owner_name && <span>· {item.owner_name}</span>}
            {item.completed_at && item.completed_by_name && (
              <span>
                · Done by {item.completed_by_name} {formatDate(item.completed_at)}
              </span>
            )}
            {item.description && (
              <span className="basis-full text-ink-secondary">{item.description}</span>
            )}
            {item.rejection_reason && item.review_status === "rejected" && (
              <span className="basis-full rounded bg-err/10 px-2 py-1 text-err">
                Rejected: {item.rejection_reason}
              </span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            onClick={() => setExpanded((x) => !x)}
            className={cn(
              "inline-flex items-center gap-0.5 rounded px-1 py-1 text-[10px] font-semibold hover:text-accent",
              comments.length > 0 ? "text-accent" : "text-ink-muted"
            )}
            title="Review / comments"
          >
            <MessageSquare size={12} />
            {comments.length > 0 && <span>{comments.length}</span>}
          </button>
          {item.status !== "na" && (
            <button
              onClick={() => onStatus("na")}
              className="rounded p-1 text-ink-muted hover:bg-surface-dim hover:text-ink"
              title="Not applicable"
            >
              <MinusCircle size={13} />
            </button>
          )}
          {item.status !== "blocked" && item.status !== "done" && (
            <button
              onClick={() => onStatus("blocked")}
              className="rounded p-1 text-ink-muted hover:bg-surface-dim hover:text-amber-600"
              title="Blocked"
            >
              <Ban size={13} />
            </button>
          )}
          <button
            onClick={onDelete}
            className="rounded p-1 text-ink-muted hover:bg-err/10 hover:text-err"
            title="Remove"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="mt-2 border-t border-border pt-2">
          {/* Assignment — pick who owns this item */}
          <div className="mb-2 flex items-center gap-2 rounded-md bg-bg/60 px-2 py-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
              Assigned to
            </span>
            <select
              value={item.owner_user_id ?? ""}
              onChange={(e) =>
                onReassign(e.target.value ? parseInt(e.target.value, 10) : null)
              }
              className="flex-1 rounded-md border border-border bg-surface px-2 py-1 text-[11px] outline-none focus:border-accent"
            >
              <option value="">— unassigned —</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </div>

          {/* Review actions row */}
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            {!item.review_status && (
              <button
                onClick={() => onReview("submit", {})}
                className="rounded-md border border-border bg-surface px-2 py-1 text-[10px] font-semibold hover:border-accent/40 hover:text-accent"
              >
                Submit for review
              </button>
            )}
            {item.review_status === "rejected" && (
              <button
                onClick={() => onReview("amend", { note: note.trim() || undefined })}
                className="rounded-md border border-accent/40 bg-accent/5 px-2 py-1 text-[10px] font-semibold text-accent hover:bg-accent/10"
              >
                Mark amended
              </button>
            )}
            {awaitingReview && canApprove && (
              <>
                <button
                  onClick={() => onReview("approve", {})}
                  className="rounded-md bg-synced/90 px-2 py-1 text-[10px] font-semibold text-white hover:bg-synced"
                >
                  Approve
                </button>
                <button
                  onClick={() => setRejectOpen((x) => !x)}
                  className="rounded-md border border-err/40 bg-surface px-2 py-1 text-[10px] font-semibold text-err hover:bg-err/5"
                >
                  Reject…
                </button>
              </>
            )}
          </div>

          {rejectOpen && (
            <div className="mb-2 rounded-md border border-err/30 bg-err/5 p-2">
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Reason for rejection…"
                className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-[11px] outline-none focus:border-err"
              />
              <div className="mt-1.5 flex items-center gap-2">
                <button
                  onClick={async () => {
                    if (!reason.trim()) return;
                    await onReview("reject", { reason: reason.trim() });
                    setReason("");
                    setRejectOpen(false);
                  }}
                  className="rounded-md bg-err px-2.5 py-1 text-[10px] font-semibold text-white"
                >
                  Confirm reject
                </button>
                <button
                  onClick={() => {
                    setRejectOpen(false);
                    setReason("");
                  }}
                  className="rounded-md border border-border bg-surface px-2 py-1 text-[10px] text-ink-secondary"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Comment thread */}
          {comments.length > 0 && (
            <div className="mb-2 space-y-1">
              {comments.map((c) => (
                <div key={c.id} className="rounded bg-bg/60 px-2 py-1 text-[10.5px]">
                  <span className={cn("font-semibold", commentKindColor(c.kind))}>
                    {commentKindLabel(c.kind)}
                  </span>
                  {c.body && <span className="ml-1 text-ink-secondary">— {c.body}</span>}
                  <span className="ml-2 text-ink-muted">
                    {c.user_name || "—"} · {formatDate(c.created_at)}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Add plain comment */}
          <div className="flex items-center gap-1.5">
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Add a note…"
              className="flex-1 rounded-md border border-border bg-surface px-2 py-1 text-[11px] outline-none focus:border-accent"
            />
            <button
              onClick={async () => {
                if (!note.trim()) return;
                await onReview("comment", { note: note.trim() });
                setNote("");
              }}
              disabled={!note.trim()}
              className="rounded-md border border-border bg-surface px-2 py-1 text-[10px] font-semibold text-ink-secondary hover:border-accent/40 hover:text-accent disabled:opacity-40"
            >
              Post
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function commentKindLabel(k: string): string {
  switch (k) {
    case "submit":
      return "Submitted for review";
    case "reject":
      return "Rejected";
    case "amend":
      return "Marked amended";
    case "approve":
      return "Approved";
    default:
      return "Note";
  }
}

function commentKindColor(k: string): string {
  switch (k) {
    case "reject":
      return "text-err";
    case "approve":
      return "text-synced";
    case "submit":
    case "amend":
      return "text-accent";
    default:
      return "text-ink";
  }
}

function AddChecklistItem({
  projectId,
  users,
  onAdded,
  onCancel,
  toast,
}: {
  projectId: number;
  users: { id: number; name: string }[];
  onAdded: () => void;
  onCancel: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [ownerId, setOwnerId] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  async function submit() {
    if (!title.trim()) return;
    setSubmitting(true);
    try {
      await api.post(`/api/projects/${projectId}/checklist`, {
        title: title.trim(),
        description: description.trim() || undefined,
        due_date: dueDate || undefined,
        owner_user_id: ownerId ? parseInt(ownerId, 10) : undefined,
      });
      onAdded();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <div className="mt-2 rounded-md border border-border bg-bg/60 p-3">
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Task title…"
        className="mb-2 w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-[12px] outline-none focus:border-accent"
      />
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description (optional) — context, instructions, acceptance criteria…"
        rows={2}
        className="mb-2 w-full resize-y rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] outline-none focus:border-accent"
      />
      <div className="mb-2 flex items-center gap-2">
        <input
          type="date"
          value={dueDate}
          onChange={(e) => setDueDate(e.target.value)}
          placeholder="Due date"
          className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px]"
        />
        <select
          value={ownerId}
          onChange={(e) => setOwnerId(e.target.value)}
          className="flex-1 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] outline-none focus:border-accent"
        >
          <option value="">— assign to —</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={submit}
          disabled={submitting || !title.trim()}
          className="ml-auto rounded-md bg-accent px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50"
        >
          Add
        </button>
        <button
          onClick={onCancel}
          className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] text-ink-secondary"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── Datetime field (inline commit on blur) ───────────────────
// The existing InlineEdit only supports text/date/number. This is a
// thin analog for datetime-local values so the logistics schedule
// section can edit start/end times without extra round-trips.

function DateTimeField({
  label,
  value,
  onSave,
}: {
  label: string;
  value: string | null | undefined;
  onSave: (next: string | null) => Promise<void> | void;
}) {
  const initial = toLocalInput(value);
  const [draft, setDraft] = useState(initial);
  useEffect(() => {
    setDraft(toLocalInput(value));
  }, [value]);

  async function commit() {
    const normalized = draft || null;
    if ((normalized ?? "") === (toLocalInput(value) || "")) return;
    await onSave(normalized);
  }

  return (
    <div>
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
        {label}
      </div>
      <input
        type="datetime-local"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        className="w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
      />
    </div>
  );
}

// datetime-local inputs expect "YYYY-MM-DDTHH:mm" (no seconds, no Z).
// Our backend stores ISO strings like "2025-08-25T23:00:00.000Z" OR
// "2025-08-25T23:00". Strip to the first 16 chars after normalization.
function toLocalInput(v: string | null | undefined): string {
  if (!v) return "";
  // Drop any trailing "Z" or ms — we treat stored values as already
  // local-ish since the user enters them in local time.
  return v.slice(0, 16);
}

// ── Project banner ───────────────────────────────────────────
// Optional warning/info strip shown above every section.

function ProjectBanner({
  message,
  tone,
}: {
  message: string;
  tone: "info" | "warning" | "error" | null;
}) {
  const t = tone || "warning";
  const palette =
    t === "error"
      ? "border-err/40 bg-err/10 text-err"
      : t === "info"
      ? "border-accent/40 bg-accent-soft/30 text-ink"
      : "border-amber-500/50 bg-amber-50 text-amber-900";
  const Icon = t === "error" ? AlertOctagon : t === "info" ? Info : AlertTriangle;
  return (
    <div
      className={cn(
        "mb-4 flex items-center gap-2 rounded-md border px-4 py-2 text-[12px]",
        palette
      )}
    >
      <Icon size={14} className="shrink-0" />
      <span>{message}</span>
    </div>
  );
}

// ── Logistics schedule + crew ────────────────────────────────
// Separate from the customer-facing event date range. This is when
// the booth is actually being built / torn down, who's driving, and
// which lorry is moving stock.

// ── Payment workflow section ─────────────────────────────────
// Five-state machine shown as pill buttons. Clicking advances to
// that state (any → any allowed, ops reality isn't linear). Upload
// a rental-proof image/PDF + notes with each status change.

function PaymentSection({
  projectId,
  project,
  onChange,
  toast,
}: {
  projectId: number;
  project: ProjectDetail["project"];
  onChange: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const [uploading, setUploading] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [notesDraft, setNotesDraft] = useState(project.payment_notes ?? "");
  const current = (project.payment_status || "not_started") as PaymentStatus;
  const meta = PAYMENT_STATUS_META[current];

  async function advance(next: PaymentStatus) {
    try {
      await api.post(`/api/projects/${projectId}/payment`, { status: next });
      toast.success(`Payment: ${PAYMENT_STATUS_META[next].label}`);
      onChange();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    }
  }

  async function saveNotes() {
    try {
      await api.post(`/api/projects/${projectId}/payment`, {
        status: current,
        notes: notesDraft,
      });
      setNotesOpen(false);
      onChange();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    }
  }

  async function uploadProof(file: File) {
    if (file.size > 10 * 1024 * 1024) {
      toast.error("File exceeds 10MB");
      return;
    }
    setUploading(true);
    try {
      const ext = file.name.split(".").pop()?.toLowerCase() || "jpg";
      const buf = await file.arrayBuffer();
      const up = await api.putBinary<{ key: string; mime_type: string }>(
        `/api/projects/${projectId}/payment/proof?ext=${ext}`,
        buf,
        file.type
      );
      await api.post(`/api/projects/${projectId}/payment`, {
        status: current,
        proof_r2_key: up.key,
        proof_file_name: file.name,
      });
      toast.success("Proof uploaded");
      onChange();
    } catch (e: any) {
      toast.error(e?.message || "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function openProof() {
    if (!project.payment_proof_r2_key) return;
    try {
      const url = await api.fetchBlobUrl(
        `/api/projects/attachments/${project.payment_proof_r2_key}`
      );
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    }
  }

  const toneCls: Record<typeof meta.tone, string> = {
    default: "bg-surface-dim text-ink-muted",
    open: "bg-amber-100 text-amber-800",
    synced: "bg-synced/15 text-synced",
    warning: "bg-amber-500/15 text-amber-900",
  };

  return (
    <PanelSection title="Payment" muted>
      <div className="mb-3 flex items-center gap-2">
        <span
          className={cn(
            "rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-wider",
            toneCls[meta.tone]
          )}
        >
          {meta.label}
        </span>
        {project.payment_updated_at && (
          <span className="text-[10px] text-ink-muted">
            updated {formatDate(project.payment_updated_at)}
          </span>
        )}
      </div>

      {/* Status buttons */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {(Object.keys(PAYMENT_STATUS_META) as PaymentStatus[]).map((s) => {
          const isCurrent = s === current;
          return (
            <button
              key={s}
              onClick={() => (isCurrent ? null : advance(s))}
              disabled={isCurrent}
              className={cn(
                "rounded-md border px-2.5 py-1 text-[10.5px] font-semibold",
                isCurrent
                  ? "border-accent bg-accent text-white"
                  : "border-border bg-surface text-ink hover:border-accent/40 hover:text-accent"
              )}
            >
              {PAYMENT_STATUS_META[s].label}
            </button>
          );
        })}
      </div>

      {/* Proof + notes row */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] font-semibold hover:border-accent/40 hover:text-accent">
          <Upload size={11} />
          {project.payment_proof_r2_key ? "Replace proof" : "Upload proof"}
          <input
            type="file"
            accept=".jpg,.jpeg,.png,.webp,.pdf"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) uploadProof(f);
              e.target.value = "";
            }}
          />
        </label>
        {project.payment_proof_r2_key && (
          <button
            onClick={openProof}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] text-accent hover:border-accent/40"
          >
            <ExternalLink size={11} />
            {project.payment_proof_file_name || "View proof"}
          </button>
        )}
        {uploading && <span className="text-[10px] text-ink-muted">Uploading…</span>}
        <button
          onClick={() => {
            setNotesDraft(project.payment_notes ?? "");
            setNotesOpen((x) => !x);
          }}
          className="ml-auto inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] font-semibold hover:border-accent/40 hover:text-accent"
        >
          Notes{project.payment_notes ? " ·" : ""}
        </button>
      </div>

      {project.payment_notes && !notesOpen && (
        <div className="mt-2 rounded-md bg-bg/60 px-2.5 py-2 text-[11px] text-ink-secondary">
          {project.payment_notes}
        </div>
      )}

      {notesOpen && (
        <div className="mt-2 rounded-md border border-accent/30 bg-accent-soft/20 p-2">
          <textarea
            value={notesDraft}
            onChange={(e) => setNotesDraft(e.target.value)}
            rows={3}
            placeholder="Payment notes…"
            className="w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] outline-none focus:border-accent"
          />
          <div className="mt-1.5 flex items-center gap-2">
            <button
              onClick={saveNotes}
              className="rounded-md bg-accent px-3 py-1 text-[11px] font-semibold text-white"
            >
              Save
            </button>
            <button
              onClick={() => setNotesOpen(false)}
              className="rounded-md border border-border bg-surface px-2 py-1 text-[11px] text-ink-secondary"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </PanelSection>
  );
}

// ── Stock transfer section ───────────────────────────────────
// OUT (to venue) + RETURN (back to warehouse). Each row has optional
// attached sheet image/PDF and a confirmed-at stamp separate from
// transferred_at — "we moved it" vs "someone verified the count".

function StockTransferSection({
  projectId,
  transfers,
  onChange,
  toast,
}: {
  projectId: number;
  transfers: StockTransfer[];
  onChange: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const dialog = useDialog();
  const [adding, setAdding] = useState<null | "out" | "return">(null);
  const outgoing = transfers.filter((t) => t.direction === "out");
  const returning = transfers.filter((t) => t.direction === "return");

  async function toggleConfirm(t: StockTransfer) {
    try {
      if (t.confirmed_at) {
        await api.post(`/api/projects/stock-transfers/${t.id}/unconfirm`, {});
      } else {
        await api.post(`/api/projects/stock-transfers/${t.id}/confirm`, {});
      }
      onChange();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    }
  }

  async function remove(t: StockTransfer) {
    if (!await dialog.confirm("Remove this transfer record?")) return;
    try {
      await api.del(`/api/projects/stock-transfers/${t.id}`);
      onChange();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    }
  }

  async function openFile(t: StockTransfer) {
    if (!t.record_r2_key) return;
    try {
      const url = await api.fetchBlobUrl(`/api/projects/attachments/${t.record_r2_key}`);
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    }
  }

  function Row({ t }: { t: StockTransfer }) {
    const confirmed = !!t.confirmed_at;
    return (
      <div
        className={cn(
          "flex items-center gap-2 rounded-md border px-3 py-2 text-[11px]",
          confirmed ? "border-synced/30 bg-synced/5" : "border-border bg-surface"
        )}
      >
        <span
          className={cn(
            "rounded-full px-1.5 py-0.5 text-[9px] font-semibold",
            t.direction === "out" ? "bg-amber-100 text-amber-800" : "bg-accent/15 text-accent"
          )}
        >
          {t.direction === "out" ? "OUT" : "RETURN"}
        </span>
        <div className="flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            {t.transferred_at && (
              <span>{t.transferred_at.slice(0, 16).replace("T", " ")}</span>
            )}
            {t.notes && <span className="text-ink-secondary">— {t.notes}</span>}
          </div>
          <div className="text-[10px] text-ink-muted">
            {t.created_by_name && `Logged by ${t.created_by_name}`}
            {confirmed && t.confirmed_by_name && (
              <span className="ml-2 text-synced">
                ✓ Confirmed by {t.confirmed_by_name} {formatDate(t.confirmed_at)}
              </span>
            )}
          </div>
        </div>
        {t.record_r2_key && (
          <button
            onClick={() => openFile(t)}
            className="rounded p-1 text-ink-muted hover:text-accent"
            title="Open transfer sheet"
          >
            <ExternalLink size={12} />
          </button>
        )}
        <button
          onClick={() => toggleConfirm(t)}
          className={cn(
            "rounded p-1",
            confirmed ? "text-synced hover:bg-synced/10" : "text-ink-muted hover:bg-accent-soft hover:text-accent"
          )}
          title={confirmed ? "Unconfirm" : "Confirm"}
        >
          <CheckCircle2 size={12} />
        </button>
        <button
          onClick={() => remove(t)}
          className="rounded p-1 text-ink-muted hover:bg-err/10 hover:text-err"
          title="Remove"
        >
          <Trash2 size={12} />
        </button>
      </div>
    );
  }

  return (
    <PanelSection title={`Stock Transfer (${transfers.length})`}>
      <div className="mb-3">
        <div className="mb-1.5 flex items-center justify-between">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-amber-800">
            OUT — to venue ({outgoing.length})
          </div>
          <button
            onClick={() => setAdding("out")}
            className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-accent hover:underline"
          >
            <Plus size={11} /> Log OUT
          </button>
        </div>
        {outgoing.length === 0 ? (
          <div className="rounded-md border border-dashed border-border bg-bg/40 px-3 py-2 text-[11px] text-ink-muted">
            No outbound transfers.
          </div>
        ) : (
          <div className="space-y-1">{outgoing.map((t) => <Row key={t.id} t={t} />)}</div>
        )}
      </div>

      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-accent">
            RETURN — back to warehouse ({returning.length})
          </div>
          <button
            onClick={() => setAdding("return")}
            className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-accent hover:underline"
          >
            <Plus size={11} /> Log RETURN
          </button>
        </div>
        {returning.length === 0 ? (
          <div className="rounded-md border border-dashed border-border bg-bg/40 px-3 py-2 text-[11px] text-ink-muted">
            No return transfers.
          </div>
        ) : (
          <div className="space-y-1">{returning.map((t) => <Row key={t.id} t={t} />)}</div>
        )}
      </div>

      {adding && (
        <AddStockTransferForm
          projectId={projectId}
          direction={adding}
          onCancel={() => setAdding(null)}
          onSaved={() => {
            setAdding(null);
            onChange();
          }}
          toast={toast}
        />
      )}
    </PanelSection>
  );
}

function AddStockTransferForm({
  projectId,
  direction,
  onCancel,
  onSaved,
  toast,
}: {
  projectId: number;
  direction: "out" | "return";
  onCancel: () => void;
  onSaved: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const [transferredAt, setTransferredAt] = useState("");
  const [notes, setNotes] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    setSubmitting(true);
    try {
      let r2Key: string | undefined;
      let fileName: string | undefined;
      let mimeType: string | undefined;
      if (file) {
        if (file.size > 10 * 1024 * 1024) {
          toast.error("File exceeds 10MB");
          setSubmitting(false);
          return;
        }
        const ext = file.name.split(".").pop()?.toLowerCase() || "jpg";
        const buf = await file.arrayBuffer();
        const up = await api.putBinary<{ key: string; mime_type: string }>(
          `/api/projects/${projectId}/stock-transfers/upload?ext=${ext}`,
          buf,
          file.type
        );
        r2Key = up.key;
        fileName = file.name;
        mimeType = up.mime_type;
      }
      await api.post(`/api/projects/${projectId}/stock-transfers`, {
        direction,
        transferred_at: transferredAt || undefined,
        notes: notes.trim() || undefined,
        record_r2_key: r2Key,
        file_name: fileName,
        mime_type: mimeType,
      });
      onSaved();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mt-3 rounded-md border border-accent/30 bg-accent-soft/20 p-3">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-accent">
        New {direction === "out" ? "OUT" : "RETURN"} transfer
      </div>
      <div className="grid grid-cols-2 gap-2">
        <input
          type="datetime-local"
          value={transferredAt}
          onChange={(e) => setTransferredAt(e.target.value)}
          className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] outline-none focus:border-accent"
        />
        <input
          type="file"
          accept=".jpg,.jpeg,.png,.webp,.pdf,.xlsx"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] outline-none"
        />
        <input
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Notes (item list, qty, driver, etc.)"
          className="col-span-2 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] outline-none focus:border-accent"
        />
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={submit}
          disabled={submitting}
          className="rounded-md bg-accent px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50"
        >
          {submitting ? "Saving…" : "Save"}
        </button>
        <button
          onClick={onCancel}
          className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] text-ink-secondary"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function LogisticsScheduleSection({
  project,
  patch,
}: {
  project: ProjectDetail["project"];
  patch: (body: Record<string, any>) => Promise<void>;
}) {
  const [drivers, setDrivers] = useState<{ id: number; name: string }[]>([]);
  const [lorries, setLorries] = useState<{ id: number; plate: string; size: string | null }[]>([]);

  useEffect(() => {
    // Fleet endpoints already return the full crew + vehicle list.
    // Fail silently if either is missing (e.g. permission issue) —
    // the section still works with free-text fields.
    api
      .get<{ users?: { id: number; name: string }[] } | { id: number; name: string }[]>(
        "/api/users"
      )
      .then((r: any) => setDrivers(r.users ?? r.data ?? r ?? []))
      .catch(() => {});
    api
      .get<{ data: { id: number; plate: string; size: string | null }[] }>("/api/lorries")
      .then((r) => setLorries(r.data ?? []))
      .catch(() => {});
  }, []);

  return (
    <PanelSection title="Logistics Schedule" muted>
      <div className="grid grid-cols-2 gap-3">
        <DateTimeField
          label="Setup Start"
          value={project.setup_start_at}
          onSave={(v) => patch({ setup_start_at: v })}
        />
        <DateTimeField
          label="Setup End"
          value={project.setup_end_at}
          onSave={(v) => patch({ setup_end_at: v })}
        />
        <div>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
            Setup Driver
          </div>
          <select
            className="w-full appearance-none rounded-md border border-border bg-surface px-3 py-2 text-[13px]"
            value={project.setup_driver_user_id ?? ""}
            onChange={(e) =>
              patch({
                setup_driver_user_id: e.target.value ? parseInt(e.target.value, 10) : null,
              })
            }
          >
            <option value="">— none —</option>
            {drivers.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
            Setup Lorry
          </div>
          <select
            className="w-full appearance-none rounded-md border border-border bg-surface px-3 py-2 text-[13px]"
            value={project.setup_lorry_id ?? ""}
            onChange={(e) =>
              patch({
                setup_lorry_id: e.target.value ? parseInt(e.target.value, 10) : null,
              })
            }
          >
            <option value="">— none —</option>
            {lorries.map((l) => (
              <option key={l.id} value={l.id}>
                {l.plate}
                {l.size && ` · ${l.size}`}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 border-t border-border pt-3">
        <DateTimeField
          label="Dismantle Start"
          value={project.dismantle_start_at}
          onSave={(v) => patch({ dismantle_start_at: v })}
        />
        <DateTimeField
          label="Dismantle End"
          value={project.dismantle_end_at}
          onSave={(v) => patch({ dismantle_end_at: v })}
        />
        <div>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
            Dismantle Driver
          </div>
          <select
            className="w-full appearance-none rounded-md border border-border bg-surface px-3 py-2 text-[13px]"
            value={project.dismantle_driver_user_id ?? ""}
            onChange={(e) =>
              patch({
                dismantle_driver_user_id: e.target.value ? parseInt(e.target.value, 10) : null,
              })
            }
          >
            <option value="">— none —</option>
            {drivers.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
            Dismantle Lorry
          </div>
          <select
            className="w-full appearance-none rounded-md border border-border bg-surface px-3 py-2 text-[13px]"
            value={project.dismantle_lorry_id ?? ""}
            onChange={(e) =>
              patch({
                dismantle_lorry_id: e.target.value ? parseInt(e.target.value, 10) : null,
              })
            }
          >
            <option value="">— none —</option>
            {lorries.map((l) => (
              <option key={l.id} value={l.id}>
                {l.plate}
                {l.size && ` · ${l.size}`}
              </option>
            ))}
          </select>
        </div>
      </div>
    </PanelSection>
  );
}

// ── Defects ──────────────────────────────────────────────────
// Two sub-lists per project — one for Setup, one for Dismantle. Each
// entry records who reported it (Sales vs Logistics) because that
// distinction is the point: they cross-check each other.

const DEFECT_ROLE_META: Record<
  "sales" | "logistic",
  { label: string; Icon: LucideIcon; cls: string }
> = {
  sales: { label: "Sales", Icon: Banknote, cls: "text-emerald-700 bg-emerald-50" },
  logistic: { label: "Logistic", Icon: Truck, cls: "text-amber-800 bg-amber-50" },
};

function DefectsSection({
  projectId,
  defects,
  onChange,
  toast,
}: {
  projectId: number;
  defects: ProjectDefect[];
  onChange: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const dialog = useDialog();
  const [adding, setAdding] = useState<null | { phase: "setup" | "dismantle" }>(null);
  const setupItems = defects.filter((d) => d.phase === "setup");
  const dismantleItems = defects.filter((d) => d.phase === "dismantle");

  return (
    <PanelSection title={`Defect Items (${defects.length})`}>
      <DefectList
        title="Setup phase"
        items={setupItems}
        onAdd={() => setAdding({ phase: "setup" })}
        onRemove={async (id) => {
          if (!await dialog.confirm("Remove this defect item?")) return;
          try {
            await api.del(`/api/projects/defects/${id}`);
            onChange();
          } catch (e: any) {
            toast.error(e?.message || "Failed");
          }
        }}
        onToggleResolved={async (d) => {
          try {
            await api.patch(`/api/projects/defects/${d.id}`, { resolved: d.resolved ? 0 : 1 });
            onChange();
          } catch (e: any) {
            toast.error(e?.message || "Failed");
          }
        }}
      />
      <DefectList
        title="Dismantle phase"
        items={dismantleItems}
        onAdd={() => setAdding({ phase: "dismantle" })}
        onRemove={async (id) => {
          if (!await dialog.confirm("Remove this defect item?")) return;
          try {
            await api.del(`/api/projects/defects/${id}`);
            onChange();
          } catch (e: any) {
            toast.error(e?.message || "Failed");
          }
        }}
        onToggleResolved={async (d) => {
          try {
            await api.patch(`/api/projects/defects/${d.id}`, { resolved: d.resolved ? 0 : 1 });
            onChange();
          } catch (e: any) {
            toast.error(e?.message || "Failed");
          }
        }}
      />
      {adding && (
        <AddDefectForm
          projectId={projectId}
          phase={adding.phase}
          onCancel={() => setAdding(null)}
          onSaved={() => {
            setAdding(null);
            onChange();
          }}
          toast={toast}
        />
      )}
    </PanelSection>
  );
}

function DefectList({
  title,
  items,
  onAdd,
  onRemove,
  onToggleResolved,
}: {
  title: string;
  items: ProjectDefect[];
  onAdd: () => void;
  onRemove: (id: number) => void;
  onToggleResolved: (d: ProjectDefect) => void;
}) {
  return (
    <div className="mb-3">
      <div className="mb-1.5 flex items-center justify-between">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
          {title} ({items.length})
        </div>
        <button
          onClick={onAdd}
          className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-accent hover:underline"
        >
          <Plus size={11} /> Add
        </button>
      </div>
      {items.length === 0 ? (
        <div className="text-[11px] text-ink-muted">No defects reported.</div>
      ) : (
        <div className="space-y-1">
          {items.map((d) => (
            <div
              key={d.id}
              className={cn(
                "flex items-start gap-2 rounded-md border border-border bg-surface px-3 py-2 text-[11px]",
                d.resolved ? "opacity-60" : ""
              )}
            >
              {(() => {
                const m = DEFECT_ROLE_META[d.reported_by_role];
                const I = m.Icon;
                return (
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-semibold",
                      m.cls
                    )}
                  >
                    <I size={10} /> {m.label}
                  </span>
                );
              })()}
              <div className="flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  {d.item_code && <span className="font-mono font-semibold">{d.item_code}</span>}
                  {d.item_description && <span>{d.item_description}</span>}
                  {d.size && <span className="text-ink-muted">· {d.size}</span>}
                  {d.quantity != null && d.quantity > 0 && (
                    <span className="text-ink-muted">× {d.quantity}</span>
                  )}
                </div>
                {d.reason && <div className="mt-0.5 text-ink-secondary">{d.reason}</div>}
                <div className="mt-0.5 text-[10px] text-ink-muted">
                  {d.reported_by_name || "—"} · {formatDate(d.reported_at)}
                  {d.linked_assr_no && (
                    <span className="ml-2 text-accent">→ {d.linked_assr_no}</span>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  onClick={() => onToggleResolved(d)}
                  className={cn(
                    "rounded p-1 hover:bg-synced/10 hover:text-synced",
                    d.resolved ? "text-synced" : "text-ink-muted"
                  )}
                  title={d.resolved ? "Mark unresolved" : "Mark resolved"}
                >
                  <CheckCircle2 size={12} />
                </button>
                <button
                  onClick={() => onRemove(d.id)}
                  className="rounded p-1 text-ink-muted hover:bg-err/10 hover:text-err"
                  title="Remove"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AddDefectForm({
  projectId,
  phase,
  onCancel,
  onSaved,
  toast,
}: {
  projectId: number;
  phase: "setup" | "dismantle";
  onCancel: () => void;
  onSaved: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const [role, setRole] = useState<"sales" | "logistic">("sales");
  const [itemCode, setItemCode] = useState("");
  const [desc, setDesc] = useState("");
  const [size, setSize] = useState("");
  const [qty, setQty] = useState("1");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (!itemCode.trim() && !desc.trim()) {
      toast.error("Item code or description required");
      return;
    }
    setSubmitting(true);
    try {
      await api.post(`/api/projects/${projectId}/defects`, {
        phase,
        reported_by_role: role,
        item_code: itemCode.trim() || null,
        item_description: desc.trim() || null,
        size: size.trim() || null,
        quantity: parseInt(qty, 10) || 1,
        reason: reason.trim() || null,
      });
      onSaved();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mt-3 rounded-md border border-accent/30 bg-accent-soft/20 p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-accent">
          New defect — {phase}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setRole("sales")}
            className={cn(
              "inline-flex items-center gap-1 rounded px-2 py-1 text-[10px] font-semibold",
              role === "sales" ? "bg-accent text-white" : "bg-surface text-ink-muted"
            )}
          >
            <Banknote size={11} /> Sales
          </button>
          <button
            onClick={() => setRole("logistic")}
            className={cn(
              "inline-flex items-center gap-1 rounded px-2 py-1 text-[10px] font-semibold",
              role === "logistic" ? "bg-accent text-white" : "bg-surface text-ink-muted"
            )}
          >
            <Truck size={11} /> Logistic
          </button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <input
          value={itemCode}
          onChange={(e) => setItemCode(e.target.value)}
          placeholder="Item code"
          className="rounded-md border border-border bg-surface px-2.5 py-1.5 font-mono text-[11px] outline-none focus:border-accent"
        />
        <input
          value={size}
          onChange={(e) => setSize(e.target.value)}
          placeholder="Size"
          className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] outline-none focus:border-accent"
        />
        <input
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder="Description"
          className="col-span-2 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] outline-none focus:border-accent"
        />
        <input
          type="number"
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          placeholder="Qty"
          className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] outline-none focus:border-accent"
        />
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason / notes"
          className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] outline-none focus:border-accent"
        />
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={submit}
          disabled={submitting}
          className="rounded-md bg-accent px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50"
        >
          {submitting ? "Saving…" : "Save"}
        </button>
        <button
          onClick={onCancel}
          className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] text-ink-secondary"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── Sales reports ────────────────────────────────────────────

function SalesReportsSection({
  projectId,
  reports,
  onChange,
  toast,
}: {
  projectId: number;
  reports: SalesReport[];
  onChange: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const dialog = useDialog();
  const [adding, setAdding] = useState(false);
  const total = reports.reduce((s, r) => s + (r.sales_amount || 0), 0);

  return (
    <PanelSection title={`Sales Reports (${reports.length})`}>
      {reports.length === 0 ? (
        <div className="text-[11px] text-ink-muted">No reports uploaded yet.</div>
      ) : (
        <div className="space-y-1.5">
          {reports.map((r) => (
            <div
              key={r.id}
              className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-[11px]"
            >
              <div className="flex-1">
                <div className="flex flex-wrap items-center gap-x-2 font-semibold">
                  {r.title || "(untitled)"}
                  {r.sales_amount != null && (
                    <span className="font-mono text-accent">
                      {formatCurrency(r.sales_amount)}
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-[10px] text-ink-muted">
                  {r.uploaded_by_name || "—"} · {formatDate(r.created_at)}
                  {r.period_start && r.period_end && (
                    <span className="ml-2">
                      {formatDate(r.period_start)} → {formatDate(r.period_end)}
                    </span>
                  )}
                </div>
              </div>
              {r.r2_key && (
                <button
                  onClick={async () => {
                    try {
                      const url = await api.fetchBlobUrl(`/api/projects/attachments/${r.r2_key}`);
                      window.open(url, "_blank");
                      setTimeout(() => URL.revokeObjectURL(url), 30_000);
                    } catch (e: any) {
                      toast.error(e?.message || "Failed");
                    }
                  }}
                  className="rounded p-1 text-ink-muted hover:text-accent"
                  title="Open attachment"
                >
                  <ExternalLink size={12} />
                </button>
              )}
              <button
                onClick={async () => {
                  if (!await dialog.confirm("Remove this report? total_sales will be recomputed.")) return;
                  try {
                    await api.del(`/api/projects/sales-reports/${r.id}`);
                    onChange();
                  } catch (e: any) {
                    toast.error(e?.message || "Failed");
                  }
                }}
                className="rounded p-1 text-ink-muted hover:bg-err/10 hover:text-err"
                title="Remove"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
          <div className="pt-1 text-right text-[11px] text-ink-secondary">
            Total sum: <span className="font-mono font-bold">{formatCurrency(total)}</span>
          </div>
        </div>
      )}
      {adding ? (
        <AddSalesReportForm
          projectId={projectId}
          onCancel={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            onChange();
          }}
          toast={toast}
        />
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="mt-2 inline-flex items-center gap-1 rounded-md border border-dashed border-border px-3 py-1.5 text-[11px] text-ink-muted hover:border-accent/40 hover:text-accent"
        >
          <Plus size={11} /> Add report
        </button>
      )}
    </PanelSection>
  );
}

function AddSalesReportForm({
  projectId,
  onCancel,
  onSaved,
  toast,
}: {
  projectId: number;
  onCancel: () => void;
  onSaved: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    setSubmitting(true);
    try {
      let r2Key: string | undefined;
      let fileName: string | undefined;
      let mimeType: string | undefined;
      if (file) {
        const ext = file.name.split(".").pop()?.toLowerCase() || "jpg";
        if (file.size > 10 * 1024 * 1024) {
          toast.error("File exceeds 10MB");
          setSubmitting(false);
          return;
        }
        const buf = await file.arrayBuffer();
        const up = await api.putBinary<{ key: string; mime_type: string }>(
          `/api/projects/${projectId}/sales-reports/upload?ext=${ext}`,
          buf,
          file.type
        );
        r2Key = up.key;
        fileName = file.name;
        mimeType = up.mime_type;
      }
      await api.post(`/api/projects/${projectId}/sales-reports`, {
        title: title.trim() || null,
        sales_amount: amount ? parseFloat(amount) : null,
        period_start: periodStart || null,
        period_end: periodEnd || null,
        r2_key: r2Key,
        file_name: fileName,
        mime_type: mimeType,
      });
      onSaved();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mt-3 rounded-md border border-accent/30 bg-accent-soft/20 p-3">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-accent">
        New sales report
      </div>
      <div className="grid grid-cols-2 gap-2">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title (e.g. Day 1)"
          className="col-span-2 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] outline-none focus:border-accent"
        />
        <input
          type="number"
          step="0.01"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="Sales amount (RM)"
          className="rounded-md border border-border bg-surface px-2.5 py-1.5 font-mono text-[11px] outline-none focus:border-accent"
        />
        <input
          type="file"
          accept=".jpg,.jpeg,.png,.webp,.pdf"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] outline-none"
        />
        <input
          type="date"
          value={periodStart}
          onChange={(e) => setPeriodStart(e.target.value)}
          className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] outline-none focus:border-accent"
        />
        <input
          type="date"
          value={periodEnd}
          onChange={(e) => setPeriodEnd(e.target.value)}
          className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] outline-none focus:border-accent"
        />
      </div>
      <div className="mt-2 text-[10px] text-ink-muted">
        Sum of all reports syncs into Finance → Total Sales.
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={submit}
          disabled={submitting}
          className="rounded-md bg-accent px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50"
        >
          {submitting ? "Saving…" : "Save"}
        </button>
        <button
          onClick={onCancel}
          className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] text-ink-secondary"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── Finance ledger ───────────────────────────────────────────
// Line-item finance. Each entry is an income or cost line tagged with
// a category. Live totals + margin + per-sqm / per-day views are
// computed client-side so edits feel instant; the backend keeps
// project_finance in sync for list-view rollups.

const LEDGER_COST_CATS = [
  "rental", "contractor", "license", "deposit", "permit",
  "transport", "accommodation", "staffing", "marketing", "misc",
];
const LEDGER_INCOME_CATS = ["sales", "deposit_refund", "rebate", "other_income"];

function catLabel(cat: string): string {
  switch (cat) {
    case "contractor":
      return "Contractor";
    case "license":
      return "License";
    case "deposit":
      return "Deposit paid";
    case "deposit_refund":
      return "Deposit refund";
    case "other_income":
      return "Other income";
    default:
      return cat.charAt(0).toUpperCase() + cat.slice(1).replace(/_/g, " ");
  }
}

function FinanceLedgerSection({
  projectId,
  sizeSqm,
  durationDays,
  lines,
  onChange,
  toast,
}: {
  projectId: number;
  sizeSqm: number | null;
  durationDays: number | null;
  lines: FinanceLine[];
  onChange: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const [adding, setAdding] = useState<null | "income" | "cost">(null);

  const income = lines.filter((l) => l.kind === "income");
  const cost = lines.filter((l) => l.kind === "cost");
  const totalIncome = income.reduce((s, l) => s + (l.amount || 0), 0);
  const totalCost = cost.reduce((s, l) => s + (l.amount || 0), 0);
  const profit = totalIncome - totalCost;
  const margin = totalIncome > 0 ? (profit / totalIncome) * 100 : null;
  const rentalTotal = cost
    .filter((l) => l.category === "rental")
    .reduce((s, l) => s + (l.amount || 0), 0);
  const rentalPerSqm = sizeSqm && sizeSqm > 0 ? rentalTotal / sizeSqm : null;
  const rentalPerDay =
    durationDays && durationDays > 0 ? rentalTotal / durationDays : null;

  return (
    <PanelSection title={`Finance Ledger (${lines.length})`} muted>
      {/* ── Totals strip ───────────────────────────────── */}
      <div className="grid grid-cols-3 gap-3 rounded-md border border-border bg-surface px-3 py-2 text-[11px]">
        <TotalCell label="Income" value={formatCurrency(totalIncome)} />
        <TotalCell label="Cost" value={formatCurrency(totalCost)} />
        <TotalCell
          label="Profit"
          value={formatCurrency(profit)}
          tone={profit >= 0 ? "synced" : "err"}
        />
      </div>
      {(margin != null || rentalPerSqm != null || rentalPerDay != null) && (
        <div className="mt-2 grid grid-cols-3 gap-3 text-[10px] text-ink-muted">
          <div>
            <span className="text-[9px] uppercase tracking-wider">Margin</span>
            <div className="font-mono text-[12px] font-bold text-ink">
              {margin != null ? `${margin.toFixed(1)}%` : "—"}
            </div>
          </div>
          <div>
            <span className="text-[9px] uppercase tracking-wider">Rental / m²</span>
            <div className="font-mono text-[12px] font-bold text-ink">
              {rentalPerSqm != null ? formatCurrency(rentalPerSqm) : "—"}
            </div>
          </div>
          <div>
            <span className="text-[9px] uppercase tracking-wider">Rental / day</span>
            <div className="font-mono text-[12px] font-bold text-ink">
              {rentalPerDay != null ? formatCurrency(rentalPerDay) : "—"}
            </div>
          </div>
        </div>
      )}

      {/* ── Income lines ──────────────────────────────── */}
      <LedgerGroup
        title="Income"
        tone="synced"
        lines={income}
        onAdd={() => setAdding("income")}
        onChange={onChange}
        toast={toast}
      />
      {/* ── Cost lines ────────────────────────────────── */}
      <LedgerGroup
        title="Cost"
        tone="err"
        lines={cost}
        onAdd={() => setAdding("cost")}
        onChange={onChange}
        toast={toast}
      />

      {adding && (
        <AddFinanceLineForm
          projectId={projectId}
          kind={adding}
          onCancel={() => setAdding(null)}
          onSaved={() => {
            setAdding(null);
            onChange();
          }}
          toast={toast}
        />
      )}
    </PanelSection>
  );
}

function TotalCell({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "synced" | "err";
}) {
  return (
    <div>
      <div className="text-[9px] font-semibold uppercase tracking-wider text-ink-muted">
        {label}
      </div>
      <div
        className={cn(
          "font-mono text-[13px] font-bold",
          tone === "synced" && "text-synced",
          tone === "err" && "text-err",
          !tone && "text-ink"
        )}
      >
        {value}
      </div>
    </div>
  );
}

function LedgerGroup({
  title,
  tone,
  lines,
  onAdd,
  onChange,
  toast,
}: {
  title: string;
  tone: "synced" | "err";
  lines: FinanceLine[];
  onAdd: () => void;
  onChange: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const dialog = useDialog();
  const total = lines.reduce((s, l) => s + (l.amount || 0), 0);

  async function del(line: FinanceLine) {
    if (!await dialog.confirm("Remove this line? Totals will re-compute.")) return;
    try {
      await api.del(`/api/projects/finance/lines/${line.id}`);
      onChange();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    }
  }

  async function openFile(line: FinanceLine) {
    if (!line.r2_key) return;
    try {
      const url = await api.fetchBlobUrl(`/api/projects/attachments/${line.r2_key}`);
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    }
  }

  return (
    <div className="mt-4">
      <div className="mb-1.5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "text-[10px] font-semibold uppercase tracking-wider",
              tone === "synced" ? "text-synced" : "text-err"
            )}
          >
            {title}
          </span>
          <span className="font-mono text-[10px] text-ink-muted">
            {lines.length} line{lines.length === 1 ? "" : "s"} · {formatCurrency(total)}
          </span>
        </div>
        <button
          onClick={onAdd}
          className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-accent hover:underline"
        >
          <Plus size={11} /> Add
        </button>
      </div>
      {lines.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-bg/40 px-3 py-2 text-[11px] text-ink-muted">
          No {title.toLowerCase()} lines.
        </div>
      ) : (
        <div className="space-y-1">
          {lines.map((l) => (
            <div
              key={l.id}
              className="group flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-[11px]"
            >
              <span
                className={cn(
                  "rounded-full px-1.5 py-0.5 text-[9px] font-semibold",
                  tone === "synced" ? "bg-synced/10 text-synced" : "bg-err/10 text-err"
                )}
              >
                {catLabel(l.category)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate">
                  {l.description || <span className="text-ink-muted">No description</span>}
                </div>
                <div className="text-[10px] text-ink-muted">
                  {l.occurred_at ? formatDate(l.occurred_at) : formatDate(l.created_at)}
                  {l.created_by_name && ` · ${l.created_by_name}`}
                </div>
              </div>
              <span
                className={cn(
                  "font-mono text-[12px] font-bold",
                  tone === "synced" ? "text-synced" : "text-err"
                )}
              >
                {tone === "err" && "−"}
                {formatCurrency(l.amount)}
              </span>
              {l.r2_key && (
                <button
                  onClick={() => openFile(l)}
                  className="rounded p-1 text-ink-muted hover:text-accent"
                  title="Open attached file"
                >
                  <ExternalLink size={12} />
                </button>
              )}
              <button
                onClick={() => del(l)}
                className="rounded p-1 text-ink-muted opacity-0 hover:bg-err/10 hover:text-err group-hover:opacity-100"
                title="Remove"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AddFinanceLineForm({
  projectId,
  kind,
  onCancel,
  onSaved,
  toast,
}: {
  projectId: number;
  kind: "income" | "cost";
  onCancel: () => void;
  onSaved: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const categories = kind === "income" ? LEDGER_INCOME_CATS : LEDGER_COST_CATS;
  const [category, setCategory] = useState<string>(categories[0]);
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [occurredAt, setOccurredAt] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    const n = parseFloat(amount);
    if (!Number.isFinite(n) || n < 0) {
      toast.error("Amount must be a non-negative number");
      return;
    }
    setSubmitting(true);
    try {
      let r2Key: string | undefined;
      let fileName: string | undefined;
      let mimeType: string | undefined;
      if (file) {
        if (file.size > 10 * 1024 * 1024) {
          toast.error("File exceeds 10MB");
          setSubmitting(false);
          return;
        }
        const ext = file.name.split(".").pop()?.toLowerCase() || "jpg";
        const buf = await file.arrayBuffer();
        const up = await api.putBinary<{ key: string; mime_type: string }>(
          `/api/projects/${projectId}/finance/upload?ext=${ext}`,
          buf,
          file.type
        );
        r2Key = up.key;
        fileName = file.name;
        mimeType = up.mime_type;
      }
      await api.post(`/api/projects/${projectId}/finance/lines`, {
        kind,
        category,
        amount: n,
        description: description.trim() || null,
        occurred_at: occurredAt || null,
        r2_key: r2Key,
        file_name: fileName,
        mime_type: mimeType,
      });
      onSaved();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mt-3 rounded-md border border-accent/30 bg-accent-soft/20 p-3">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-accent">
        New {kind} line
      </div>
      <div className="grid grid-cols-2 gap-2">
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] outline-none focus:border-accent"
        >
          {categories.map((c) => (
            <option key={c} value={c}>
              {catLabel(c)}
            </option>
          ))}
        </select>
        <input
          type="number"
          step="0.01"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="Amount (RM)"
          className="rounded-md border border-border bg-surface px-2.5 py-1.5 font-mono text-[11px] outline-none focus:border-accent"
        />
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description"
          className="col-span-2 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] outline-none focus:border-accent"
        />
        <input
          type="date"
          value={occurredAt}
          onChange={(e) => setOccurredAt(e.target.value)}
          className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] outline-none focus:border-accent"
          title="Payment date"
        />
        <input
          type="file"
          accept=".jpg,.jpeg,.png,.webp,.pdf,.xlsx"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] outline-none"
        />
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={submit}
          disabled={submitting || !amount}
          className="rounded-md bg-accent px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50"
        >
          {submitting ? "Saving…" : "Save"}
        </button>
        <button
          onClick={onCancel}
          className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] text-ink-secondary"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── Attachments ──────────────────────────────────────────────

const ATTACH_CATEGORIES: { value: string; label: string }[] = [
  { value: "floorplan", label: "Floorplan" },
  { value: "render_3d", label: "3D Render" },
  { value: "contract", label: "Contract" },
  { value: "permit", label: "Permit" },
  { value: "photo", label: "Photo" },
  { value: "stock_transfer", label: "Stock Transfer" },
  { value: "other", label: "Other" },
];

const ATTACH_ROLES: {
  value: AttachRole;
  Icon: LucideIcon;
  label: string;
}[] = [
  { value: "design", Icon: Monitor, label: "Design" },
  { value: "office", Icon: Receipt, label: "Office" },
  { value: "sales", Icon: Banknote, label: "Sales" },
  { value: "driver", Icon: Truck, label: "Driver" },
];

function roleMeta(role: AttachRole | null | undefined) {
  return ATTACH_ROLES.find((x) => x.value === role) ?? null;
}

function roleLabel(role: AttachRole | null | undefined): string {
  return roleMeta(role)?.label ?? "";
}

function RoleBadge({
  role,
  withLabel = true,
  size = 10,
}: {
  role: AttachRole | null | undefined;
  withLabel?: boolean;
  size?: number;
}) {
  const meta = roleMeta(role);
  if (!meta) return null;
  const Icon = meta.Icon;
  return (
    <span className="inline-flex items-center gap-1">
      <Icon size={size} />
      {withLabel && meta.label}
    </span>
  );
}

function AttachmentsSection({
  projectId,
  attachments,
  onChange,
  toast,
}: {
  projectId: number;
  attachments: ProjectAttachment[];
  onChange: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const [category, setCategory] = useState<string>("floorplan");
  const [uploadRole, setUploadRole] = useState<AttachRole | "">("");
  const [filterRole, setFilterRole] = useState<AttachRole | "">("");
  const [uploading, setUploading] = useState<{ done: number; total: number } | null>(null);

  const filtered = filterRole
    ? attachments.filter((a) => a.uploaded_by_role === filterRole)
    : attachments;

  async function onFiles(list: FileList | null) {
    if (!list || !list.length) return;
    const files = Array.from(list);
    const MAX = 25 * 1024 * 1024;
    const ALLOWED = new Set(["jpg", "jpeg", "png", "webp", "mp4", "pdf", "dwg", "skp"]);
    const staged: File[] = [];
    for (const f of files) {
      const ext = f.name.split(".").pop()?.toLowerCase() || "";
      if (!ALLOWED.has(ext)) {
        toast.error(`${f.name}: unsupported type`);
        continue;
      }
      if (f.size > MAX) {
        toast.error(`${f.name}: exceeds 25MB`);
        continue;
      }
      staged.push(f);
    }
    if (!staged.length) return;
    setUploading({ done: 0, total: staged.length });
    let failed = 0;
    for (let i = 0; i < staged.length; i++) {
      const f = staged[i];
      try {
        const ext = f.name.split(".").pop()?.toLowerCase() || "jpg";
        const buf = await f.arrayBuffer();
        const roleQs = uploadRole ? `&role=${uploadRole}` : "";
        await api.putBinary(
          `/api/projects/${projectId}/attachments?category=${category}&ext=${ext}&name=${encodeURIComponent(f.name)}${roleQs}`,
          buf,
          f.type
        );
      } catch (e: any) {
        failed++;
        console.warn(e);
      }
      setUploading({ done: i + 1, total: staged.length });
    }
    setUploading(null);
    if (failed > 0) toast.error(`${failed} upload(s) failed`);
    else toast.success(`Uploaded ${staged.length} file(s)`);
    onChange();
  }

  return (
    <PanelSection title={`Attachments (${attachments.length})`}>
      {/* Upload controls */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="rounded-md border border-border bg-surface px-2 py-1.5 text-[11px]"
        >
          {ATTACH_CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
        <select
          value={uploadRole}
          onChange={(e) => setUploadRole(e.target.value as AttachRole | "")}
          className="rounded-md border border-border bg-surface px-2 py-1.5 text-[11px]"
          title="Your role for this upload"
        >
          <option value="">— no role —</option>
          {ATTACH_ROLES.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
        <label className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] font-semibold hover:border-accent/40 hover:text-accent cursor-pointer">
          <Upload size={11} />
          Upload
          <input
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              onFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </label>
        {uploading && (
          <span className="text-[10px] text-ink-muted">
            Uploading {uploading.done}/{uploading.total}…
          </span>
        )}
      </div>

      {/* Role filter chips */}
      {attachments.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          <button
            onClick={() => setFilterRole("")}
            className={cn(
              "rounded-full border px-2 py-0.5 text-[10px] font-semibold",
              filterRole === ""
                ? "border-accent bg-accent text-white"
                : "border-border bg-surface text-ink-muted hover:border-accent/40"
            )}
          >
            All ({attachments.length})
          </button>
          {ATTACH_ROLES.map((r) => {
            const count = attachments.filter((a) => a.uploaded_by_role === r.value).length;
            if (count === 0) return null;
            const active = filterRole === r.value;
            const Icon = r.Icon;
            return (
              <button
                key={r.value}
                onClick={() => setFilterRole(active ? "" : r.value)}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold",
                  active
                    ? "border-accent bg-accent text-white"
                    : "border-border bg-surface text-ink-muted hover:border-accent/40"
                )}
              >
                <Icon size={10} /> {r.label} ({count})
              </button>
            );
          })}
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="mt-2 text-[11px] text-ink-muted">
          {attachments.length === 0 ? "No attachments yet." : "No attachments match that role."}
        </div>
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-2">
          {filtered.map((a) => (
            <AttachmentTile key={a.id} attachment={a} onArchive={onChange} toast={toast} />
          ))}
        </div>
      )}
    </PanelSection>
  );
}

function AttachmentTile({
  attachment,
  onArchive,
  toast,
}: {
  attachment: ProjectAttachment;
  onArchive: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const dialog = useDialog();
  const [thumb, setThumb] = useState<string | null>(null);
  const isImage = (attachment.mime_type || "").startsWith("image/");

  useEffect(() => {
    if (!isImage) return;
    let revoked = false;
    api
      .fetchBlobUrl(`/api/projects/attachments/${attachment.r2_key}`)
      .then((url) => {
        if (revoked) URL.revokeObjectURL(url);
        else setThumb(url);
      })
      .catch(() => {});
    return () => {
      revoked = true;
      if (thumb) URL.revokeObjectURL(thumb);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachment.r2_key, isImage]);

  async function openFile() {
    try {
      const url = await api.fetchBlobUrl(`/api/projects/attachments/${attachment.r2_key}`);
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (e: any) {
      toast.error(e?.message || "Failed to open");
    }
  }

  async function downloadFile() {
    try {
      const url = await api.fetchBlobUrl(`/api/projects/attachments/${attachment.r2_key}`);
      const a = document.createElement("a");
      a.href = url;
      a.download =
        attachment.file_name || attachment.r2_key.split("/").pop() || "download";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (e: any) {
      toast.error(e?.message || "Download failed");
    }
  }

  async function renameFile() {
    const next = await dialog.prompt({
      title: "Rename attachment",
      message: "Pick a new display name. The file content stays the same.",
      defaultValue: attachment.file_name || "",
      placeholder: "e.g. floorplan-final-v3.pdf",
      required: true,
      confirmLabel: "Rename",
    });
    if (!next || next === attachment.file_name) return;
    try {
      await api.patch(`/api/projects/attachments/${attachment.id}`, {
        file_name: next,
      });
      toast.success("Renamed");
      onArchive(); // reuses the parent's reload callback
    } catch (e: any) {
      toast.error(e?.message || "Rename failed");
    }
  }

  return (
    <div className="group relative overflow-hidden rounded-md border border-border bg-surface">
      <button onClick={openFile} className="block w-full text-left">
        {isImage && thumb ? (
          <img
            src={thumb}
            alt={attachment.file_name || ""}
            className="h-24 w-full object-cover"
          />
        ) : (
          <div className="flex h-24 w-full items-center justify-center bg-bg/60 text-ink-muted">
            {isImage ? <ImageIcon size={24} /> : <FileText size={24} />}
          </div>
        )}
        <div className="px-2 py-1.5">
          <div className="truncate text-[11px] font-semibold">
            {attachment.file_name || attachment.r2_key.split("/").pop()}
          </div>
          <div className="flex items-center gap-1 text-[9px] uppercase tracking-wider text-ink-muted">
            <span>{attachment.category || "—"}</span>
            {attachment.uploaded_by_role && (
              <>
                <span>·</span>
                <span
                  className="inline-flex items-center gap-0.5"
                  title={roleLabel(attachment.uploaded_by_role)}
                >
                  <RoleBadge role={attachment.uploaded_by_role} size={9} />
                </span>
              </>
            )}
          </div>
        </div>
      </button>
      {/* Hover action cluster — download / rename / remove. Stays
          hidden until the tile is hovered so the thumbnail isn't
          cluttered. */}
      <div className="absolute right-1 top-1 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <button
          onClick={downloadFile}
          className="rounded bg-surface/80 p-1 text-ink-muted hover:bg-accent-soft hover:text-accent"
          title="Download"
        >
          <Download size={11} />
        </button>
        <button
          onClick={renameFile}
          className="rounded bg-surface/80 p-1 text-ink-muted hover:bg-accent-soft hover:text-accent"
          title="Rename"
        >
          <Pencil size={11} />
        </button>
        <button
          onClick={async () => {
            if (!(await dialog.confirm("Remove this attachment?"))) return;
            try {
              await api.post(`/api/projects/attachments/${attachment.id}/archive`, {});
              onArchive();
            } catch (e: any) {
              toast.error(e?.message || "Failed");
            }
          }}
          className="rounded bg-surface/80 p-1 text-ink-muted hover:bg-err/10 hover:text-err"
          title="Remove"
        >
          <Trash2 size={11} />
        </button>
      </div>
    </div>
  );
}

// ── Trip picker (link existing trip) ─────────────────────────

function TripPicker({
  projectId,
  onClose,
  onLinked,
  toast,
}: {
  projectId: number;
  onClose: () => void;
  onLinked: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const [search, setSearch] = useState("");
  const trips = useQuery<{ data: { id: number; trip_no: string; status: string; trip_date: string; trip_type: string; notes: string | null }[] }>(
    () => api.get(`/api/projects/trips/unlinked${buildQuery({ search })}`),
    [search]
  );
  async function link(tripId: number) {
    try {
      await api.post(`/api/projects/${projectId}/trips/link`, { trip_id: tripId });
      toast.success("Linked");
      onLinked();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    }
  }
  return (
    <div className="mt-2 rounded-md border border-accent/30 bg-accent-soft/20 p-3">
      <div className="mb-2 flex items-center gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search trip no or notes…"
          className="flex-1 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px]"
        />
        <button
          onClick={onClose}
          className="rounded-md border border-border bg-surface px-2 py-1.5 text-[11px] text-ink-muted"
        >
          <X size={11} />
        </button>
      </div>
      <div className="max-h-60 space-y-1 overflow-y-auto">
        {(trips.data?.data ?? []).map((t) => (
          <button
            key={t.id}
            onClick={() => link(t.id)}
            className="flex w-full items-center gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5 text-left text-[11px] hover:border-accent/40"
          >
            <span className="font-mono font-semibold">{t.trip_no}</span>
            <span className="text-ink-muted">·</span>
            <span>{formatDate(t.trip_date)}</span>
            <span className="text-ink-muted">·</span>
            <span className="capitalize">{t.status}</span>
            <span className="rounded bg-accent/10 px-1 text-[9px] text-accent">
              {t.trip_type}
            </span>
          </button>
        ))}
        {!trips.loading && !(trips.data?.data ?? []).length && (
          <div className="text-[11px] text-ink-muted">No unlinked trips.</div>
        )}
      </div>
    </div>
  );
}

// ── Google Calendar URL ──────────────────────────────────────
// Uses the public /calendar/render?action=TEMPLATE endpoint — no OAuth,
// opens Google Calendar with the event pre-filled. User still has to
// click "Save" in Google.

function googleCalendarUrl(p: {
  name: string;
  code: string;
  start_date: string | null;
  end_date: string | null;
  venue: string | null;
  venue_address: string | null;
  organizer: string | null;
}): string {
  const fmt = (d: string) => d.replace(/-/g, "");
  const start = p.start_date ? fmt(p.start_date) : "";
  // Google wants end date exclusive for all-day events, so +1 day
  const endRaw = p.end_date || p.start_date || "";
  const endDate = endRaw ? new Date(endRaw) : null;
  if (endDate) endDate.setUTCDate(endDate.getUTCDate() + 1);
  const end = endDate ? endDate.toISOString().slice(0, 10).replace(/-/g, "") : start;
  const dates = `${start}/${end}`;
  const details = [
    `Project: ${p.code}`,
    p.organizer && `Organizer: ${p.organizer}`,
  ]
    .filter(Boolean)
    .join("\n");
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: p.name,
    dates,
    details,
    location: [p.venue, p.venue_address].filter(Boolean).join(", "),
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

// ── Import CSV panel ─────────────────────────────────────────

function ImportCsvPanel({
  onClose,
  onDone,
  toast,
}: {
  onClose: () => void;
  onDone: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ imported: number; errors: string[]; total_rows: number } | null>(null);

  async function submit() {
    if (!text.trim()) return;
    setSubmitting(true);
    try {
      // Raw text body (POST text/csv) — api helpers all assume JSON, so
      // we call fetch directly. Auth token is the same one api uses.
      const token = localStorage.getItem("auth:token") || "";
      const resp = await fetch(`${api.baseUrl}/api/projects/import/csv`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "text/csv",
        },
        body: text,
      });
      if (!resp.ok) throw new Error(`${resp.status}: ${await resp.text()}`);
      const data = (await resp.json()) as { imported: number; errors: string[]; total_rows: number };
      setResult(data);
      if (data.imported > 0) toast.success(`Imported ${data.imported} of ${data.total_rows} row(s)`);
      onDone();
    } catch (e: any) {
      toast.error(e?.message || "Import failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Panel
      open
      onClose={onClose}
      title="Import Projects from CSV"
      subtitle="Paste rows from the Google Sheet — header row recognised"
      width={560}
      footer={
        <div className="flex items-center justify-end gap-2">
          <button onClick={onClose} className="rounded-md border border-border bg-surface px-3 py-2 text-[12px]">
            Close
          </button>
          <Button variant="primary" onClick={submit} disabled={submitting || !text.trim()}>
            {submitting ? "Importing…" : "Import"}
          </Button>
        </div>
      }
    >
      <PanelSection title="Columns">
        <div className="space-y-1.5 text-[11px] text-ink-secondary">
          <p>Supported header names (case-insensitive, use underscores or spaces):</p>
          <ul className="ml-4 list-disc space-y-0.5 font-mono text-[10.5px]">
            <li>name <span className="text-err">(required)</span></li>
            <li>brand · event_type · start_date · end_date</li>
            <li>venue · state · organizer · booth_no · size_sqm</li>
            <li>rental · total_sales · contractor_cost · license_fee</li>
            <li>notion_url</li>
          </ul>
          <p>Dates may be YYYY-MM-DD or DD/MM/YYYY. Unknown columns are ignored.</p>
        </div>
      </PanelSection>

      <PanelSection title="CSV">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"name,brand,event_type,start_date,end_date,venue,state\nPIKOM PC Fair 2026,AKEMI,exhibition,2026-05-10,2026-05-12,KLCC,Kuala Lumpur"}
          rows={14}
          className="w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-[11px] outline-none focus:border-accent"
        />
      </PanelSection>

      {result && (
        <PanelSection title="Result" muted>
          <div className="text-[11px]">
            <span className="font-semibold text-synced">{result.imported}</span> imported,{" "}
            <span className="font-semibold text-ink-muted">{result.total_rows - result.imported}</span> skipped of{" "}
            {result.total_rows}
          </div>
          {result.errors.length > 0 && (
            <div className="mt-2 max-h-40 overflow-y-auto rounded-md border border-err/30 bg-err/5 p-2 text-[10px]">
              {result.errors.map((e, i) => (
                <div key={i}>{e}</div>
              ))}
            </div>
          )}
        </PanelSection>
      )}
    </Panel>
  );
}

// ── Chat panel ───────────────────────────────────────────────
// Free-text messages interleaved with the project's system activity
// (stage transitions, finance edits, checklist changes…). Mirrors the
// ASSR notes pattern — same backend table (project_activity), one
// composer that POSTs to /api/projects/:id/notes with action="note".

function ProjectChat({
  projectId,
  activity,
  canPost,
  onPosted,
  toast,
}: {
  projectId: number;
  activity: ActivityRow[];
  canPost: boolean;
  onPosted: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  async function send() {
    const note = draft.trim();
    if (!note || sending) return;
    setSending(true);
    try {
      await api.post(`/api/projects/${projectId}/notes`, { note });
      setDraft("");
      onPosted();
    } catch (e: any) {
      toast.error(e?.message || "Failed to send");
    } finally {
      setSending(false);
    }
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      send();
    }
  }

  return (
    <div className="space-y-3">
      {canPost && (
        <div className="rounded-md border border-border bg-surface p-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            placeholder="Write a message…"
            rows={2}
            className="w-full resize-none border-0 bg-transparent p-1 text-[12px] text-ink outline-none placeholder:text-ink-muted"
          />
          <div className="mt-1 flex items-center justify-between">
            <span className="text-[10px] text-ink-muted">⌘/Ctrl + Enter to send</span>
            <button
              onClick={send}
              disabled={sending || !draft.trim()}
              className="inline-flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-white shadow-sm disabled:bg-surface-dim disabled:text-ink-muted disabled:shadow-none"
            >
              <Send size={11} /> Send
            </button>
          </div>
        </div>
      )}

      {activity.length === 0 ? (
        <div className="text-[11px] text-ink-muted">No messages yet.</div>
      ) : (
        <div className="space-y-2">
          {activity.map((a) =>
            a.action === "note" ? (
              <div
                key={a.id}
                className="rounded-md border border-border bg-surface px-3 py-2"
              >
                <div className="mb-0.5 flex items-baseline justify-between gap-2">
                  <span className="text-[11.5px] font-semibold text-ink">
                    {a.user_name || "Unknown"}
                  </span>
                  <span
                    className="font-mono text-[9.5px] text-ink-muted"
                    title={a.created_at}
                  >
                    {relativeTime(a.created_at)}
                  </span>
                </div>
                <div className="whitespace-pre-wrap text-[12px] text-ink-secondary">
                  {a.note}
                </div>
              </div>
            ) : (
              <div
                key={a.id}
                className="flex items-start gap-2 px-1 text-[10.5px] italic text-ink-muted"
              >
                <span
                  className="font-mono not-italic"
                  title={a.created_at}
                >
                  {relativeTime(a.created_at)}
                </span>
                <span className="flex-1">
                  {actionLabel(a.action)}
                  {a.from_value && a.to_value && a.from_value !== a.to_value && (
                    <span> · {a.from_value} → {a.to_value}</span>
                  )}
                  {a.to_value && !a.from_value && <span> · {a.to_value}</span>}
                  {a.note && <span> · {a.note}</span>}
                  {a.user_name && <span> · {a.user_name}</span>}
                </span>
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
}

function actionLabel(action: string): string {
  switch (action) {
    case "created":
      return "Project created";
    case "stage_change":
      return "Stage changed";
    case "checklist_status":
      return "Checklist updated";
    case "checklist_add":
      return "Checklist item added";
    case "checklist_remove":
      return "Checklist item removed";
    case "finance_edit":
      return "Finance updated";
    case "archived":
      return "Archived";
    case "restored":
      return "Restored";
    case "note":
      return "Message";
    default:
      return action;
  }
}
