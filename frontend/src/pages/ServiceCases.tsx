import { useEffect, useState, useMemo, useCallback } from "react";
import { createPortal } from "react-dom";
import { Link, useSearchParams, useNavigate, useParams, Navigate } from "react-router-dom";
import {
  Plus,
  RefreshCw,
  Search,
  ChevronLeft,
  ChevronRight,
  Upload,
  MessageSquare,
  Truck as TruckIcon,
  Trash2,
  Star,
  Package,
  UserPlus,
  Calendar,
  ShieldCheck,
  DollarSign,
  Printer,
  Download,
  X,
} from "lucide-react";
import { PageHeader } from "../components/Layout";
import {
  DetailLayout,
  DetailGrid,
  DetailMain,
  DetailAside,
  HeaderButton,
} from "../components/DetailLayout";
import { Button } from "../components/Button";
import { FilterPills } from "../components/FilterPills";
import { TabStrip } from "../components/TabStrip";
import { PnlCalendar } from "../components/PnlCalendar";
import { DataTable, type Column } from "../components/DataTable";
import {
  StatusDot,
  stageVariant,
  stageLabel,
  priorityColor,
  resolutionLabel,
} from "../components/StatusDot";
import { Pagination } from "../components/Pagination";
import { Panel, PanelSection, FieldRow } from "../components/Panel";
import { InlineEdit } from "../components/InlineEdit";
import { StatCard } from "../components/StatCard";
import { DashboardGrid, DashboardPanels, DashboardBreakdown } from "../components/Dashboard";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { useDialog } from "../hooks/useDialog";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useServerSort } from "../hooks/useServerSort";
import { useFocusFromUrl } from "../hooks/useFocusFromUrl";
import { useAuth } from "../auth/AuthContext";
import { api, buildQuery } from "../api/client";
import { formatDate, cn } from "../lib/utils";
import { ServiceMetrics } from "./ServiceMetrics";
import type {
  Paginated,
  AssrCase,
  AssrSummary,
  AssrDetail,
  AssrAttachment,
  AssrStage,
  PurchaseOrder,
} from "../types";

type StageFilter = "ALL" | AssrStage;

const STAGE_OPTIONS: { value: StageFilter; label: string }[] = [
  { value: "ALL", label: "All" },
  { value: "registration", label: "Pending Review" },
  { value: "triage", label: "Under Verification" },
  { value: "action", label: "Pending Solution" },
  { value: "logistics", label: "Pending Logistics" },
  { value: "resolution", label: "Pending Completion" },
  { value: "closed", label: "Completed" },
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

const NEXT_STAGE: Record<string, { stage: AssrStage; label: string }> = {
  registration: { stage: "triage", label: "Start Verification" },
  triage: { stage: "action", label: "Move to Solution" },
  action: { stage: "logistics", label: "Assign Logistics" },
  logistics: { stage: "resolution", label: "Mark Ready to Complete" },
  resolution: { stage: "closed", label: "Close Case" },
};

// ── Main page ─────────────────────────────────────────────────

// Shell — two tabs: the case list and the quality-metrics dashboard.
// The metrics used to live at /service-metrics as its own sidebar
// entry; it's just a report about cases so it belongs here alongside
// them rather than as a top-level module.
type ServiceView = "cases" | "by_creditor" | "metrics" | "pnl";

// Per-tab header config so each tab gets its own dedicated title.
const TAB_HEADER: Record<ServiceView, { title: string; description: string }> = {
  cases: {
    title: "Service Cases (ASSR)",
    description: "After-sales service request workflow.",
  },
  by_creditor: {
    title: "Service Cases by Creditor",
    description:
      "Grouped by the AutoCount creditor who supplies the item. Click a row to see their cases.",
  },
  metrics: {
    title: "Service Quality Metrics",
    description: "Performance breakdown — SLA, supplier ratings, resolution times.",
  },
  pnl: {
    title: "Service Cost — P&L",
    description: "Supplier PO payments from closed cases, grouped by month.",
  },
};

export function ServiceCases() {
  const [view, setView] = useLocalStorage<ServiceView>("assr:view", "cases");
  // Lifted from CasesView so the parent PageHeader can host the
  // "New Case" action when the cases tab is active.
  const [showCreate, setShowCreate] = useState(false);

  return (
    <div>
      <TabStrip
        value={view}
        onChange={setView}
        options={[
          { value: "cases" as const, label: "Cases" },
          { value: "by_creditor" as const, label: "By Creditor" },
          { value: "metrics" as const, label: "Quality Metrics" },
          { value: "pnl" as const, label: "P&L" },
        ]}
      />

      <PageHeader
        eyebrow="Operations · Service"
        title={TAB_HEADER[view].title}
        description={TAB_HEADER[view].description}
        actions={
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

      {view === "cases" && (
        <CasesView showCreate={showCreate} setShowCreate={setShowCreate} />
      )}
      {view === "by_creditor" && <ByCreditorView onPickCreditor={() => setView("cases")} />}
      {view === "metrics" && <ServiceMetrics />}
      {view === "pnl" && (
        <PnlCalendar
          scope="service"
          title="Service Cost — Monthly"
          subtitle="Supplier PO payments from closed cases, grouped by month."
        />
      )}
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
  const [bulkSelected, setBulkSelected] = useState<Set<number>>(new Set());
  const { sort, sortParams, handleSortChange } = useServerSort(() => setPage(1));
  const [params, setParams] = useSearchParams();
  const creditorFilter = params.get("creditor_code");

  // ?focus=ID — Overview inbox deep-links straight to the detail page.
  useFocusFromUrl((id) => navigate(`/assr/${id}`, { replace: true }));

  const list = useQuery<Paginated<AssrCase>>(
    () =>
      api.get(
        `/api/assr${buildQuery({
          stage: stage === "ALL" ? undefined : stage,
          search,
          page,
          per_page: perPage,
          include_archived: showArchived ? 1 : undefined,
          assigned_to: myCases && user?.id ? user.id : undefined,
          creditor_code: creditorFilter || undefined,
          ...sortParams,
        })}`
      ),
    [stage, search, page, perPage, showArchived, myCases, user?.id, creditorFilter, sort?.key, sort?.dir]
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

  const summary = useQuery<AssrSummary>(() => api.get("/api/assr/summary"));

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
        <div className="flex flex-wrap items-center gap-1.5">
          {r.archived_at && (
            <span className="inline-flex items-center rounded-full border border-ink-muted/40 bg-ink-muted/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-ink-muted">
              Archived
            </span>
          )}
          <StatusDot variant={stageVariant(r.stage)} label={stageLabel(r.stage)} />
          {r.stage !== "closed" && r.is_breached === 1 && (
            <span
              className="inline-flex items-center rounded-full bg-err px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-white"
              title={`SLA breached by ${Math.abs(r.hours_to_deadline ?? 0)}h`}
            >
              SLA
            </span>
          )}
          {r.stage !== "closed" && r.escalated_at && (
            <span
              className="inline-flex items-center rounded-full border border-err px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-err"
              title={`Auto-escalated ${r.escalated_at.slice(0, 10)} — SLA overdue >24h`}
            >
              Esc
            </span>
          )}
          {r.stage !== "closed" && r.days_in_stage != null && r.days_in_stage > 3 && (
            <span
              className="inline-flex items-center rounded-full bg-err/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-err"
              title={`In this stage for ${r.days_in_stage} day(s)`}
            >
              {r.days_in_stage}d
            </span>
          )}
        </div>
      ),
      getValue: (r) => stageLabel(r.stage),
    },
    {
      key: "priority",
      label: "Priority",
      align: "center",
      render: (r) => (
        <span className="inline-flex items-center gap-1">
          <span className={cn("h-2 w-2 rounded-full", priorityColor(r.priority))} />
          <span className="text-[11px] capitalize text-ink-secondary">{r.priority}</span>
        </span>
      ),
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
        <span className="block max-w-[180px] truncate">{r.customer_name || "—"}</span>
      ),
      getValue: (r) => r.customer_name,
    },
    {
      key: "item_code",
      label: "Item",
      render: (r) => <span className="font-mono text-[11px]">{r.item_code || "—"}</span>,
      getValue: (r) => r.item_code,
    },
    {
      key: "resolution_method",
      label: "Resolution",
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
  ];

  const stageCountMap = useMemo(() => {
    const m: Record<string, number> = {};
    for (const s of summary.data?.by_stage ?? []) m[s.stage] = s.count;
    return m;
  }, [summary.data]);

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
      <DashboardGrid cols={4}>
        <StatCard
          label="Pending Review"
          value={stageCountMap.registration?.toLocaleString() ?? "0"}
          subtitle="Awaiting verification"
          tone={stageCountMap.registration > 0 ? "error" : "default"}
        />
        <StatCard
          label="SLA Breached"
          value={summary.data?.breach_count?.toLocaleString() ?? "—"}
          subtitle="Open cases past deadline"
          tone={(summary.data?.breach_count ?? 0) > 0 ? "error" : "default"}
        />
        <StatCard
          label="Completed"
          value={stageCountMap.closed?.toLocaleString() ?? "0"}
          subtitle="Closed cases"
          tone="success"
        />
        <StatCard
          label="Aging (&gt;3d)"
          value={summary.data?.aging_count?.toLocaleString() ?? "—"}
          subtitle="Open cases stuck in a stage"
          tone={(summary.data?.aging_count ?? 0) > 0 ? "error" : "default"}
        />
      </DashboardGrid>

      <DashboardPanels cols={2}>
        <DashboardBreakdown
          title="By Location"
          items={summary.data?.by_location.map((l) => ({ label: l.location, count: l.count })) ?? []}
        />
        <DashboardBreakdown
          title="By Category"
          items={summary.data?.by_category.map((c) => ({ label: c.name, count: c.count })) ?? []}
        />
      </DashboardPanels>

      <div className="mb-4 flex items-center gap-4">
        <FilterPills
          value={stage}
          onChange={(v) => { setPage(1); setStage(v); }}
          options={STAGE_OPTIONS}
        />
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
              summary.reload();
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
              summary.reload();
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

      {/* Create panel */}
      {showCreate && (
        <CreatePanel
          onClose={() => setShowCreate(false)}
          onCreated={(id) => {
            setShowCreate(false);
            navigate(`/assr/${id}`);
            list.reload();
            summary.reload();
          }}
          toast={toast}
        />
      )}
    </div>
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
  const [lookingUp, setLookingUp] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [customerInfo, setCustomerInfo] = useState<{ name?: string; phone?: string; location?: string } | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null);

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
    setSubmitting(true);
    try {
      const res = await api.post<{ assr_no: string; id: number }>("/api/assr", {
        doc_no: docNo.trim(),
        items,
        complaint_issue: issue.trim(),
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
            className="flex-1 rounded-md border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
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
                    <span className="flex-1 truncate text-ink-secondary">{item.item_description}</span>
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
                className="w-full rounded-md border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
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
          className="w-full rounded-md border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
        />
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
  const users = useQuery<{ id: number; name: string }[]>(
    () => api.get<any>("/api/users").then((r: any) => r.users ?? r.data ?? r ?? []),
    []
  );
  const [note, setNote] = useState("");
  const [transitioning, setTransitioning] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [showClosePrompt, setShowClosePrompt] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [showAddItem, setShowAddItem] = useState(false);
  const [showAddLogistics, setShowAddLogistics] = useState(false);
  const [newItemCode, setNewItemCode] = useState("");
  const [newItemDesc, setNewItemDesc] = useState("");

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

  async function addNote() {
    if (!note.trim()) return;
    await api.post(`/api/assr/${id}/notes`, { note: note.trim() });
    setNote("");
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

  async function addItem() {
    if (!newItemCode.trim()) return;
    try {
      await api.post(`/api/assr/${id}/items`, {
        items: [{ item_code: newItemCode.trim(), item_description: newItemDesc.trim() || null }],
      });
      setNewItemCode("");
      setNewItemDesc("");
      setShowAddItem(false);
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

  const nextStage = c ? NEXT_STAGE[c.stage] : null;
  const userOptions = Array.isArray(users.data)
    ? users.data.map((u) => ({ id: u.id, name: u.name }))
    : [];

  return (
    <DetailLayout
      breadcrumbs={[
        { label: "Service Cases", to: "/assr" },
        { label: c?.assr_no || "Loading…" },
      ]}
      eyebrow={c?.assr_no ? `Service Case · ${c.assr_no}` : "Service Case"}
      title={c?.customer_name || "Loading…"}
      description={c ? `Stage: ${c.stage}${c.priority ? ` · Priority ${c.priority}` : ""}${c.assigned_to_name ? ` · Assigned ${c.assigned_to_name}` : ""}` : undefined}
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
            {c.stage !== "closed" &&
              !c.archived_at &&
              c.stage !== "resolution" && (
                <HeaderButton variant="ghost" onClick={handleCloseClick}>
                  Close
                </HeaderButton>
              )}
            {c.stage === "resolution" && !c.archived_at && (
              <HeaderButton
                variant="primary"
                onClick={handleCloseClick}
                disabled={transitioning}
              >
                {transitioning ? "…" : "Close Case"}
                <ChevronRight size={12} />
              </HeaderButton>
            )}
            {nextStage && c.stage !== "resolution" && !c.archived_at && (
              <HeaderButton
                variant="primary"
                onClick={() => transition(nextStage.stage)}
                disabled={transitioning}
              >
                {transitioning ? "…" : nextStage.label}
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
                await transition("closed");
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
              {c.archived_at.slice(0, 16).replace("T", " ")} — read-only. Use Restore to reactivate.
            </div>
          )}

          {/* Stage + Priority header */}
          <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-3">
            <StatusDot variant={stageVariant(c.stage)} label={stageLabel(c.stage)} />
            <span className="inline-flex items-center gap-1">
              <span className={cn("h-2 w-2 rounded-full", priorityColor(c.priority))} />
              <span className="text-[11px] capitalize text-ink-secondary">{c.priority}</span>
            </span>
            {c.resolution_method && (
              <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-semibold text-accent">
                {resolutionLabel(c.resolution_method)}
              </span>
            )}
            {c.deadline_at && c.stage !== "closed" && (
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold",
                  c.is_breached === 1
                    ? "bg-err text-white"
                    : (c.hours_to_deadline ?? 9999) < 24
                    ? "bg-amber-500/10 text-amber-700"
                    : "bg-synced/10 text-synced"
                )}
                title={`Deadline: ${c.deadline_at.slice(0, 16).replace("T", " ")}`}
              >
                <Calendar size={10} />
                {c.is_breached === 1
                  ? `Overdue ${Math.abs(c.hours_to_deadline ?? 0)}h`
                  : `${c.hours_to_deadline ?? 0}h left`}
              </span>
            )}
            <button
              onClick={async () => {
                try {
                  await api.openHtml(`/api/assr-print/${id}`);
                } catch (e: any) {
                  toast.error(e?.message || "Failed to open print view");
                }
              }}
              className="ml-auto inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[10px] font-semibold text-ink hover:border-accent/40"
              title="Open print / PDF view"
            >
              <Printer size={11} /> Print
            </button>
          </div>
          <DetailGrid>
            <DetailMain>
          {/* Items */}
          <PanelSection title={`Items (${items.length})`}>
            {items.length === 0 ? (
              <div className="text-[12px] text-ink-muted">No items</div>
            ) : (
              <div className="space-y-1">
                {items.map((item) => (
                  <div key={item.id} className="flex items-center gap-2 rounded border border-border px-3 py-1.5 text-sm">
                    <span className="font-mono text-[11px] font-medium">{item.item_code}</span>
                    <span className="flex-1 truncate text-ink-secondary">{item.item_description || ""}</span>
                    <span className="text-[11px] text-ink-muted">&times;{item.qty}</span>
                    {c.stage !== "closed" && (
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
            {c.stage !== "closed" && !showAddItem && (
              <button
                onClick={() => setShowAddItem(true)}
                className="mt-2 inline-flex items-center gap-1 text-[11px] font-semibold text-accent hover:underline"
              >
                <Plus size={12} /> Add Item
              </button>
            )}
            {showAddItem && (
              <div className="mt-2 space-y-2 rounded border border-border bg-bg/60 p-3">
                <input
                  value={newItemCode}
                  onChange={(e) => setNewItemCode(e.target.value)}
                  placeholder="Item code"
                  className="w-full rounded-md border border-border bg-surface px-3 py-1.5 text-sm outline-none focus:border-accent"
                />
                <input
                  value={newItemDesc}
                  onChange={(e) => setNewItemDesc(e.target.value)}
                  placeholder="Description (optional)"
                  className="w-full rounded-md border border-border bg-surface px-3 py-1.5 text-sm outline-none focus:border-accent"
                />
                <div className="flex gap-2">
                  <button
                    onClick={addItem}
                    disabled={!newItemCode.trim()}
                    className="rounded-md bg-accent px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50"
                  >
                    Add
                  </button>
                  <button
                    onClick={() => { setShowAddItem(false); setNewItemCode(""); setNewItemDesc(""); }}
                    className="rounded-md border border-border px-3 py-1.5 text-[11px] text-ink-secondary"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </PanelSection>

          {/* Issue & Resolution */}
          <PanelSection title="Issue & Resolution">
            <FieldRow label="Complaint">{c.complaint_issue || "—"}</FieldRow>
            <IssueCategoryField
              value={c.issue_category}
              onSave={(v) => patch({ issue_category: v })}
              dialog={dialog}
            />
            <InlineEdit
              label="Resolution Method"
              value={c.resolution_method}
              options={[...RESOLUTION_OPTIONS]}
              onSave={(v) => patch({ resolution_method: v })}
            />
            <InlineEdit
              label="Priority"
              value={c.priority}
              options={[...PRIORITY_OPTIONS]}
              onSave={(v) => patch({ priority: v })}
            />
            <InlineEdit
              label="Service Category"
              value={c.service_category}
              onSave={(v) => patch({ service_category: v })}
            />
            {/* Creditor (AutoCount) — derived from item_code via
                StockItem.MainSupplier. Read-only; re-resolved when
                item_code changes. Deep-links into the creditors tab
                in Purchase Orders. */}
            <div>
              <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
                Creditor
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
                    {(c.creditor_email || c.creditor_phone) && (
                      <div className="mt-1 text-[11px] text-ink-secondary">
                        {c.creditor_email}
                        {c.creditor_email && c.creditor_phone ? " · " : ""}
                        {c.creditor_phone}
                      </div>
                    )}
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
              label="PO No"
              value={c.po_no}
              onSave={(v) => patch({ po_no: v })}
            />
            {!c.po_no && c.creditor_code && c.stage !== "closed" && (
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
                className="inline-flex items-center gap-1 text-[11px] font-semibold text-accent hover:underline"
              >
                <Plus size={12} /> Auto-generate PO number
              </button>
            )}
            <InlineEdit
              label="Action Remark"
              textarea
              value={c.action_remark}
              onSave={(v) => patch({ action_remark: v })}
            />
          </PanelSection>

          {/* Attachments */}
          <PanelSection title={`Attachments (${attachments.length})`}>
            {attachments.length > 0 && (
              <div className="mb-2 grid grid-cols-3 gap-2">
                {attachments.map((att: any, i: number) => (
                  <AttachmentThumb
                    key={att.id}
                    att={att}
                    onClick={() => {
                      // Only open the lightbox for images; PDFs/videos
                      // just open via the usual thumb click otherwise.
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
                onChange={(e) => uploadFile(e, c.stage === "closed" ? "completion" : "evidence")}
                disabled={uploading}
              />
            </label>
          </PanelSection>

          {/* Logistics */}
          {(c.stage === "logistics" || c.stage === "resolution" || c.stage === "closed" || logistics.length > 0) && (
            <PanelSection title={`Logistics (${logistics.length})`}>
              {logistics.map((l) => (
                <div key={l.id} className="group rounded border border-border px-3 py-2 text-sm">
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
                    {!c.archived_at && (
                      <button
                        onClick={async () => {
                          if (!await dialog.confirm("Archive this logistics entry?")) return;
                          try {
                            await api.post(`/api/assr/${id}/logistics/${l.id}/archive`);
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
                  {l.notes && <div className="mt-1 text-[11px] text-ink-muted">{l.notes}</div>}
                </div>
              ))}
              {c.stage !== "closed" && !showAddLogistics && (
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
                      <div className="truncate text-[11px] text-ink-secondary">
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

          {/* Activity */}
          <PanelSection title="Activity">
            <div className="mb-3 flex gap-2">
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addNote()}
                placeholder="Add a note..."
                className="flex-1 rounded-md border border-border bg-bg px-3 py-1.5 text-sm outline-none focus:border-accent"
              />
              <button
                onClick={addNote}
                disabled={!note.trim()}
                className="rounded-md bg-accent px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50"
              >
                <MessageSquare size={12} />
              </button>
            </div>
            <div className="space-y-2">
              {activity.map((a: any) => (
                <div key={a.id} className={cn("group border-l-2 pl-3 text-[12px]", a.source === "customer" ? "border-accent" : "border-border")}>
                  <div className="flex items-center gap-2 text-ink-muted">
                    <span className="font-medium text-ink-secondary">
                      {a.source === "customer"
                        ? (a.customer_name_display || a.customer_email || "Customer")
                        : (a.user_name || "System")}
                    </span>
                    {a.source === "customer" && (
                      <span className="rounded-full bg-accent/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-accent">
                        Customer
                      </span>
                    )}
                    <span>&middot;</span>
                    <span>{a.created_at.slice(0, 16).replace("T", " ")}</span>
                    {/* Archive button — only on retractable action types.
                        Stage changes, approvals, POs, escalations etc. are
                        audit-trail and intentionally NOT archivable. */}
                    {!c.archived_at && (a.action === "note" || a.action === "customer_comment") && (
                      <button
                        onClick={async () => {
                          if (!await dialog.confirm("Archive this entry?")) return;
                          try {
                            await api.post(`/api/assr/activity/${a.id}/archive`);
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
                  {a.action === "stage_change" && (
                    <div className="text-ink-secondary">
                      Stage: {stageLabel(a.from_value || "")} &rarr; <span className="font-semibold">{stageLabel(a.to_value || "")}</span>
                    </div>
                  )}
                  {a.action === "note" && <div className="text-ink">{a.note}</div>}
                  {a.action === "created" && <div className="text-ink-secondary">Case created</div>}
                  {a.action === "assignment" && (
                    <div className="text-ink-secondary">
                      Assigned to {userOptions.find((u) => String(u.id) === a.to_value)?.name || `user #${a.to_value}`}
                    </div>
                  )}
                  {a.action === "approval" && (
                    <div className="text-ink-secondary">
                      Quality review: <span className="font-semibold">{a.to_value === "passed" ? "Passed" : "Reviewed"}</span>
                    </div>
                  )}
                  {a.action === "po_generated" && (
                    <div className="text-ink-secondary">
                      PO generated: <span className="font-mono font-semibold">{a.to_value}</span>
                    </div>
                  )}
                  {a.action === "escalated" && (
                    <div className="text-err font-semibold">
                      Case escalated — SLA breached &gt;24h
                    </div>
                  )}
                  {a.action === "survey_submitted" && (
                    <div className="text-ink-secondary">
                      Customer submitted satisfaction survey: <span className="font-semibold">{a.to_value}/5</span>
                      {a.note && <span className="ml-1 italic text-ink-muted">— {a.note}</span>}
                    </div>
                  )}
                  {a.action === "customer_comment" && (
                    <div className="text-ink">{a.note}</div>
                  )}
                  {a.action === "customer_upload" && (
                    <div className="text-ink-secondary">
                      Uploaded a photo{a.note ? ` (${a.note})` : ""}
                    </div>
                  )}
                  {a.note && a.action === "stage_change" && (
                    <div className="text-ink-muted italic">{a.note}</div>
                  )}
                </div>
              ))}
              {activity.length === 0 && (
                <div className="text-[12px] text-ink-muted">No activity yet</div>
              )}
            </div>
          </PanelSection>
            </DetailMain>

            <DetailAside>
          {/* Customer & Order */}
          <PanelSection title="Customer & Order" muted>
            <FieldRow label="SO No" mono>{c.doc_no}</FieldRow>
            <FieldRow label="Customer">{c.customer_name || "—"}</FieldRow>
            <FieldRow label="Phone">{c.phone || "—"}</FieldRow>
            <InlineEdit
              label="Email (for survey)"
              value={c.customer_email}
              onSave={(v) => patch({ customer_email: v })}
              placeholder="customer@example.com"
            />
            <FieldRow label="Location">{c.location || "—"}</FieldRow>
            <FieldRow label="Agent">{c.sales_agent || "—"}</FieldRow>
            <FieldRow label="Date">{formatDate(c.complained_date)}</FieldRow>
            {c.addr1 && <FieldRow label="Address">{[c.addr1, c.addr2, c.addr3, c.addr4].filter(Boolean).join(", ")}</FieldRow>}
            <PortalLinkRow
              id={id}
              existingToken={detail.data?.portal_token ?? null}
              toast={toast}
              onGenerated={() => detail.reload()}
            />
          </PanelSection>

          <CustomerHistory id={id} />

          {/* Assigned To */}
          <PanelSection title="Assignment">
            <div>
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
                Assigned To
              </div>
              <select
                className="w-full appearance-none rounded-md border border-border bg-surface px-3 py-2 pr-8 text-[13px] text-ink outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20"
                value={c.assigned_to ?? ""}
                onChange={(e) => {
                  const v = e.target.value;
                  patch({ assigned_to: v ? parseInt(v, 10) : null });
                }}
              >
                <option value="">— unassigned —</option>
                {userOptions.map((u) => (
                  <option key={u.id} value={u.id}>{u.name}</option>
                ))}
              </select>
            </div>
          </PanelSection>

          {/* Cost Tracking */}
          <PanelSection title="Cost Tracking">
            <div className="mb-2 flex items-center gap-1.5 text-[10px] text-ink-muted">
              <DollarSign size={11} />
              PO amounts and reconciliation
            </div>
            <InlineEdit
              label="PO Amount"
              type="number"
              value={c.po_amount}
              onSave={(v) => patch({ po_amount: v ? Number(v) : null })}
            />
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
          </PanelSection>

          {/* Manager Approval / Quality Review */}
          <PanelSection title="Quality Review">
            <div className="mb-2 flex items-center gap-1.5 text-[10px] text-ink-muted">
              <ShieldCheck size={11} />
              Manager sign-off and NCR classification
            </div>
            <InlineEdit
              label="NCR Category"
              value={c.ncr_category}
              options={[...NCR_OPTIONS]}
              onSave={(v) => patch({ ncr_category: v })}
            />
            {c.approved_at ? (
              <div className="rounded-md border border-synced/40 bg-synced/5 p-3 text-[12px]">
                <div className="flex items-center gap-1.5 text-synced">
                  <ShieldCheck size={12} />
                  <span className="font-semibold">
                    {c.quality_review_passed ? "Quality Review Passed" : "Approved"}
                  </span>
                </div>
                <div className="mt-1 text-ink-secondary">
                  By {c.approved_by_name || `user #${c.approved_by}`} ·{" "}
                  {c.approved_at.slice(0, 16).replace("T", " ")}
                </div>
              </div>
            ) : (
              <div className="flex gap-2">
                <button
                  onClick={async () => {
                    await api.post(`/api/assr/${id}/approve`, { quality_review_passed: true });
                    detail.reload();
                    onUpdated();
                  }}
                  className="rounded-md bg-synced px-3 py-1.5 text-[11px] font-semibold text-white hover:opacity-90"
                >
                  Approve &amp; Pass QA
                </button>
                <button
                  onClick={async () => {
                    await api.post(`/api/assr/${id}/approve`, { quality_review_passed: false });
                    detail.reload();
                    onUpdated();
                  }}
                  className="rounded-md border border-border px-3 py-1.5 text-[11px] font-semibold text-ink"
                >
                  Mark Reviewed
                </button>
              </div>
            )}
          </PanelSection>

          {/* Satisfaction (shown when closed) */}
          {c.stage === "closed" && (
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

function IssueCategoryField({
  value,
  onSave,
  dialog,
}: {
  value: string | null | undefined;
  onSave: (next: string | null) => Promise<void>;
  dialog: ReturnType<typeof useDialog>;
}) {
  const isCanonical = !!value && (ISSUE_CATEGORIES as readonly string[]).includes(value);
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
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
        Issue Category
      </div>
      <select
        value={isCanonical ? (value as string) : showsOther ? OTHER_SENTINEL : ""}
        onChange={(e) => onChange(e.target.value)}
        className="w-full appearance-none rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
      >
        <option value="">— select —</option>
        {ISSUE_CATEGORIES.map((c) => (
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
              <div className="mt-1 line-clamp-2 text-ink-secondary">{p.complaint_issue}</div>
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
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
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
          <div className="mb-1 text-[10px] uppercase tracking-wider text-ink-muted">
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
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
        Close Case — Customer Satisfaction
      </div>
      <Stars value={rating} onChange={setRating} />
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Satisfaction notes (optional)..."
        rows={2}
        className="mb-3 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
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
          className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm outline-none focus:border-accent"
        >
          <option value="pickup">Pickup</option>
          <option value="delivery">Delivery</option>
        </select>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="flex-1 rounded-md border border-border bg-surface px-3 py-1.5 text-sm outline-none focus:border-accent"
        />
      </div>
      <input
        value={timeRange}
        onChange={(e) => setTimeRange(e.target.value)}
        placeholder="Time range (e.g. 9AM-12PM)"
        className="w-full rounded-md border border-border bg-surface px-3 py-1.5 text-sm outline-none focus:border-accent"
      />
      <select
        value={assignedTo}
        onChange={(e) => setAssignedTo(e.target.value)}
        className="w-full appearance-none rounded-md border border-border bg-surface px-3 py-1.5 text-sm outline-none focus:border-accent"
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
        className="w-full rounded-md border border-border bg-surface px-3 py-1.5 text-sm outline-none focus:border-accent"
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
        className="block w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
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

// ── "By Creditor" tab ─────────────────────────────────────────
// Rollup view over /api/assr/by-creditor. One row per creditor with
// total / open / closed / breached counts. Row click filters the main
// Cases tab by `creditor_code` (via URL param). Secondary link opens
// the creditor's panel in /po.

interface CreditorRow {
  creditor_code: string;
  creditor_name: string | null;
  email: string | null;
  phone: string | null;
  total: number;
  open: number;
  closed: number;
  breached: number;
  last_activity_at: string | null;
}

interface ByCreditorResponse {
  rows: CreditorRow[];
  unassigned: { total: number; open: number };
}

function ByCreditorView({ onPickCreditor }: { onPickCreditor: () => void }) {
  const toast = useToast();
  const [search, setSearch] = useState("");
  const [, setParams] = useSearchParams();
  const [refreshing, setRefreshing] = useState(false);

  const q = useQuery<ByCreditorResponse>(
    () => api.get(`/api/assr/by-creditor${search ? `?search=${encodeURIComponent(search)}` : ""}`),
    [search]
  );

  async function refreshAll() {
    setRefreshing(true);
    try {
      const res = await api.post<{
        fetched: number;
        upserted: number;
        cases_updated: number;
        message: string;
      }>("/api/stockitems/refresh");
      toast.success(res.message || "Refreshed");
      q.reload();
    } catch (e: any) {
      toast.error(`Refresh failed: ${e?.message || e}`);
    } finally {
      setRefreshing(false);
    }
  }

  const columns: Column<CreditorRow>[] = [
    {
      key: "creditor_code",
      label: "Code",
      alwaysVisible: true,
      render: (r) => <span className="font-mono text-xs font-medium">{r.creditor_code}</span>,
      getValue: (r) => r.creditor_code,
    },
    {
      key: "creditor_name",
      label: "Name",
      alwaysVisible: true,
      render: (r) => r.creditor_name || <span className="text-ink-muted">—</span>,
      getValue: (r) => r.creditor_name,
    },
    {
      key: "contact",
      label: "Contact",
      render: (r) => (
        <div className="text-xs">
          {r.email && <div>{r.email}</div>}
          {r.phone && <div className="text-ink-muted">{r.phone}</div>}
          {!r.email && !r.phone && <span className="text-ink-muted">—</span>}
        </div>
      ),
      getValue: (r) => `${r.email || ""} ${r.phone || ""}`.trim(),
    },
    {
      key: "total",
      label: "Total",
      align: "right",
      render: (r) => <span className="font-mono text-xs font-semibold">{r.total}</span>,
      getValue: (r) => r.total,
    },
    {
      key: "open",
      label: "Open",
      align: "right",
      render: (r) => (
        <span className={cn("font-mono text-xs", r.open > 0 && "font-semibold text-amber-700")}>
          {r.open}
        </span>
      ),
      getValue: (r) => r.open,
    },
    {
      key: "closed",
      label: "Closed",
      align: "right",
      render: (r) => <span className="font-mono text-xs text-ink-muted">{r.closed}</span>,
      getValue: (r) => r.closed,
    },
    {
      key: "breached",
      label: "Breached",
      align: "right",
      render: (r) => (
        <span className={cn("font-mono text-xs", r.breached > 0 && "font-bold text-err")}>
          {r.breached}
        </span>
      ),
      getValue: (r) => r.breached,
    },
    {
      key: "last_activity_at",
      label: "Last Activity",
      render: (r) => formatDate(r.last_activity_at),
      getValue: (r) => r.last_activity_at,
    },
    {
      key: "actions",
      label: "",
      align: "right",
      render: (r) => (
        <Link
          to={`/po?view=creditors&focus=${encodeURIComponent(r.creditor_code)}`}
          onClick={(e) => e.stopPropagation()}
          className="text-[11px] font-semibold text-accent hover:underline"
          title="Open creditor in Purchase Orders"
        >
          Open Creditor →
        </Link>
      ),
    },
  ];

  function pickCreditor(code: string) {
    // Switch to the Cases tab with a creditor_code filter in the URL.
    // CasesView reads the `creditor_code` param and applies it.
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("creditor_code", code);
        return next;
      },
      { replace: true }
    );
    onPickCreditor();
  }

  const totalCases = (q.data?.rows ?? []).reduce((s, r) => s + r.total, 0);
  const openCases = (q.data?.rows ?? []).reduce((s, r) => s + r.open, 0);
  const breachedCases = (q.data?.rows ?? []).reduce((s, r) => s + r.breached, 0);
  const unassigned = q.data?.unassigned;

  return (
    <div>
      <DashboardGrid cols={4}>
        <StatCard
          label="Creditors with Cases"
          value={q.data ? q.data.rows.length.toLocaleString() : "—"}
          subtitle="Distinct procurement suppliers"
        />
        <StatCard
          label="Total Cases"
          value={q.data ? totalCases.toLocaleString() : "—"}
          subtitle="Across all creditors"
        />
        <StatCard
          label="Open"
          value={q.data ? openCases.toLocaleString() : "—"}
          subtitle={q.data ? `${breachedCases} breached` : "Loading…"}
          tone={breachedCases > 0 ? "error" : "default"}
        />
        <StatCard
          label="Unassigned"
          value={unassigned ? unassigned.total.toLocaleString() : "—"}
          subtitle={
            unassigned
              ? `${unassigned.open} open · no creditor resolved`
              : "Loading…"
          }
          tone={unassigned && unassigned.total > 0 ? "default" : "default"}
        />
      </DashboardGrid>

      <div className="mb-3 flex items-center justify-end">
        <button
          onClick={refreshAll}
          disabled={refreshing}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[11px] font-semibold uppercase tracking-wider text-ink-secondary transition-colors hover:border-accent/40 hover:bg-accent-soft/50 hover:text-accent disabled:opacity-40"
          title="Re-pull MainSupplier for every referenced item and re-write creditor_code on cases"
        >
          <RefreshCw size={13} className={refreshing ? "animate-spin" : ""} />
          {refreshing ? "Refreshing…" : "Refresh from AutoCount"}
        </button>
      </div>

      <DataTable
        tableId="assr-by-creditor"
        exportName="service-cases-by-creditor"
        search={{
          value: search,
          onChange: setSearch,
          placeholder: "Search creditor code or name…",
        }}
        columns={columns}
        rows={q.data?.rows ?? null}
        loading={q.loading}
        error={q.error}
        emptyLabel="No cases linked to a creditor yet — run POST /api/stockitems/refresh."
        getRowKey={(r) => r.creditor_code}
        onRowClick={(r) => pickCreditor(r.creditor_code)}
      />
    </div>
  );
}
