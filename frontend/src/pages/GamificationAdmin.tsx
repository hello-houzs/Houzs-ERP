import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  Plus,
  Trash2,
  Image as ImageIcon,
  CheckCircle2,
  Truck,
  XCircle,
  Clock,
  ArrowLeft,
  Coins,
  Power,
  PowerOff,
  Save,
  Lightbulb,
  MessageCircle,
  ArrowUp,
  Rocket,
  Hourglass,
} from "lucide-react";
import { PageHeader } from "../components/Layout";
import { TabStrip, type TabOption } from "../components/TabStrip";
import { DataTable } from "../components/DataTable";
import { EmptyState } from "../components/EmptyState";
import { ListSkeleton } from "../components/Skeleton";
import { AwardImage } from "../components/AwardImage";
import { useStickyFilters } from "../hooks/useStickyFilters";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { useAuth } from "../auth/AuthContext";
import { api } from "../api/client";
import { cn, relativeTime } from "../lib/utils";

type AdminTab = "catalog" | "redemptions" | "innovations" | "suggestions";

interface AwardRow {
  id: number;
  name: string;
  description: string | null;
  cost_points: number;
  stock: number | null;
  image_r2_key: string | null;
  active: number;
  sort_order: number;
}

interface RedemptionRow {
  id: number;
  award_id: number;
  award_name: string;
  award_image_r2_key: string | null;
  user_id: number;
  user_name: string | null;
  user_email: string | null;
  cost_points: number;
  status: "pending" | "shipped" | "delivered" | "cancelled";
  shipping_addr: string | null;
  admin_note: string | null;
  created_at: string;
  shipped_at: string | null;
  delivered_at: string | null;
  cancelled_at: string | null;
}

export function GamificationAdmin() {
  const { user } = useAuth();
  const isAdmin = !!user?.permissions?.includes("*");
  const [params, setParams] = useStickyFilters("gamify-admin", ["sub", "status"]);

  const tab = (params.get("sub") as AdminTab) || "catalog";
  const setTab = (v: AdminTab) => {
    const next = new URLSearchParams(params);
    if (v === "catalog") next.delete("sub");
    else next.set("sub", v);
    setParams(next, { replace: true });
  };

  if (!isAdmin) {
    return (
      <div>
        <PageHeader
          eyebrow="Engagement admin"
          title="Award shop admin"
          description="Manage the catalog and process redemptions."
        />
        <EmptyState
          icon={<XCircle size={20} />}
          message="Admins only"
          description="You need the wildcard permission to manage the award shop."
        />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        eyebrow="Engagement admin"
        title="Award shop admin"
        description="Curate the catalog and walk redemptions through fulfilment."
        actions={
          <Link
            to="/gamification"
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] font-semibold text-ink-secondary transition-colors hover:border-accent/50 hover:text-accent"
          >
            <ArrowLeft size={11} /> Back to Engagement
          </Link>
        }
      />

      <TabStrip<AdminTab>
        value={tab}
        onChange={setTab}
        options={[
          { value: "catalog", label: "Catalog" },
          { value: "redemptions", label: "Redemptions" },
          { value: "innovations", label: "Innovations" },
          { value: "suggestions", label: "Suggestions" },
        ] as TabOption<AdminTab>[]}
      />

      {tab === "catalog" && <CatalogPanel />}
      {tab === "redemptions" && (
        <RedemptionsPanel
          status={params.get("status")}
          onStatusChange={(s) => {
            const next = new URLSearchParams(params);
            if (s) next.set("status", s);
            else next.delete("status");
            setParams(next, { replace: true });
          }}
        />
      )}
      {tab === "innovations" && <InnovationsAdminPanel />}
      {tab === "suggestions" && <SuggestionsAdminPanel />}
    </div>
  );
}

// ── Catalog ────────────────────────────────────────────────────

function CatalogPanel() {
  const toast = useToast();
  const list = useQuery<{ rows: AwardRow[] }>(() => api.get("/api/awards/admin"));
  const [creating, setCreating] = useState(false);

  if (list.loading) return <ListSkeleton rows={5} />;
  if (list.error) {
    return (
      <EmptyState
        icon={<XCircle size={20} />}
        message="Couldn't load catalog"
        description={list.error}
      />
    );
  }
  const rows = list.data?.rows ?? [];

  async function createAward() {
    setCreating(true);
    try {
      await api.post("/api/awards", {
        name: "New award",
        cost_points: 100,
        stock: null,
        sort_order: rows.length,
      });
      toast.success("New award added — fill in the details");
      list.reload();
    } catch (e: any) {
      toast.error(e?.message || "Couldn't add");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div className="text-[12px] text-ink-secondary">
          {rows.length} {rows.length === 1 ? "item" : "items"}
        </div>
        <button
          type="button"
          onClick={createAward}
          disabled={creating}
          className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[12px] font-bold uppercase tracking-wide text-white shadow-sm transition-all hover:bg-accent/90 active:scale-95 disabled:opacity-50"
        >
          <Plus size={13} /> New award
        </button>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={<Coins size={20} />}
          message="No awards yet"
          description="Add your first award above to kick off the shop."
        />
      ) : (
        <div className="space-y-2">
          {rows.map((a) => (
            <CatalogRow key={a.id} row={a} onChange={() => list.reload()} />
          ))}
        </div>
      )}
    </div>
  );
}

function CatalogRow({
  row,
  onChange,
}: {
  row: AwardRow;
  onChange: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(row.name);
  const [description, setDescription] = useState(row.description ?? "");
  const [cost, setCost] = useState(String(row.cost_points));
  const [stock, setStock] = useState(row.stock === null ? "" : String(row.stock));
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [version, setVersion] = useState(0);

  // Whenever the parent reload brings down updated row data, reset the
  // local form values so the editor reflects the canonical server state
  // (and the dirty indicator correctly clears).
  useEffect(() => {
    setName(row.name);
    setDescription(row.description ?? "");
    setCost(String(row.cost_points));
    setStock(row.stock === null || row.stock === undefined ? "" : String(row.stock));
  }, [row.id, row.name, row.description, row.cost_points, row.stock]);

  // Compare local state to canonical row to surface a "dirty" pulse so
  // the user can see when there are unsaved edits — the most common
  // reason "Save" feels like nothing happened was that nothing visible
  // changed when state already matched what the server stored.
  const dirty =
    name.trim() !== (row.name || "") ||
    description.trim() !== (row.description ?? "") ||
    String(parseInt(cost, 10) || 0) !== String(row.cost_points) ||
    (stock.trim() === ""
      ? row.stock !== null && row.stock !== undefined
      : parseInt(stock, 10) !== row.stock);

  // Brief "saved" flash after a successful save — clears after 1.6 s.
  useEffect(() => {
    if (!savedAt) return;
    const t = window.setTimeout(() => setSavedAt(null), 1600);
    return () => window.clearTimeout(t);
  }, [savedAt]);

  async function save() {
    setBusy(true);
    try {
      const c = parseInt(cost, 10);
      const s = stock.trim() === "" ? null : parseInt(stock, 10);
      if (!Number.isFinite(c) || c <= 0) throw new Error("Cost must be > 0");
      if (s !== null && (!Number.isFinite(s) || s < 0)) {
        throw new Error("Stock must be a non-negative integer or empty");
      }
      await api.patch(`/api/awards/${row.id}`, {
        name: name.trim(),
        description: description.trim() || null,
        cost_points: c,
        stock: s,
      });
      toast.success(`Saved "${name.trim() || row.name}"`);
      setSavedAt(Date.now());
      onChange();
    } catch (e: any) {
      console.error("[catalog save] failed", e);
      toast.error(e?.message || "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive() {
    try {
      await api.patch(`/api/awards/${row.id}`, {
        active: row.active ? 0 : 1,
      });
      onChange();
    } catch (e: any) {
      toast.error(e?.message || "Couldn't toggle");
    }
  }

  async function removeAward() {
    if (!confirm(`Hide "${row.name}" from the shop?`)) return;
    try {
      await api.del(`/api/awards/${row.id}`);
      onChange();
    } catch (e: any) {
      toast.error(e?.message || "Couldn't remove");
    }
  }

  async function uploadImage(f: File) {
    setBusy(true);
    try {
      await api.putBinary(
        `/api/awards/${row.id}/image?name=${encodeURIComponent(f.name)}`,
        f,
        f.type || "application/octet-stream",
      );
      toast.success("Image uploaded");
      setVersion((v) => v + 1);
      onChange();
    } catch (e: any) {
      toast.error(e?.message || "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={cn(
        "grid grid-cols-1 items-start gap-3 rounded-lg border border-border bg-surface p-3 shadow-stone transition-shadow hover:shadow-slab sm:grid-cols-[120px_1fr_auto]",
        !row.active && "opacity-60",
      )}
    >
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        className="group relative aspect-[4/3] w-full overflow-hidden rounded-md border border-dashed border-border bg-bg/40 transition-colors hover:border-accent/60"
        title="Click to upload image"
      >
        <AwardImage
          key={`${row.id}-${version}`}
          awardId={row.id}
          hasImage={!!row.image_r2_key}
          alt={row.name}
          className="h-full w-full object-cover"
          iconSize={28}
        />
        <span className="absolute inset-0 grid place-items-center bg-ink/0 transition-colors group-hover:bg-ink/40">
          <span className="flex items-center gap-1 rounded-md bg-surface/95 px-2 py-1 text-[10px] font-semibold opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
            <ImageIcon size={11} /> Upload
          </span>
        </span>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) uploadImage(f);
            e.target.value = "";
          }}
        />
      </button>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="block sm:col-span-2">
          <span className="text-[9px] font-semibold uppercase tracking-brand text-ink-muted">
            Name
          </span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-0.5 w-full rounded-md border border-border bg-paper px-2 py-1.5 text-[13px] font-semibold"
          />
        </label>
        <label className="block sm:col-span-2">
          <span className="text-[9px] font-semibold uppercase tracking-brand text-ink-muted">
            Description
          </span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value.slice(0, 500))}
            rows={2}
            className="thin-scroll mt-0.5 w-full resize-none rounded-md border border-border bg-paper px-2 py-1.5 text-[12px]"
          />
        </label>
        <label className="block">
          <span className="text-[9px] font-semibold uppercase tracking-brand text-ink-muted">
            Cost (points)
          </span>
          <input
            type="number"
            min={1}
            value={cost}
            onChange={(e) => setCost(e.target.value)}
            className="mt-0.5 w-full rounded-md border border-border bg-paper px-2 py-1.5 text-[13px] font-mono font-bold"
          />
        </label>
        <label className="block">
          <span className="text-[9px] font-semibold uppercase tracking-brand text-ink-muted">
            Stock (blank = unlimited)
          </span>
          <input
            type="number"
            min={0}
            value={stock}
            onChange={(e) => setStock(e.target.value)}
            placeholder="∞"
            className="mt-0.5 w-full rounded-md border border-border bg-paper px-2 py-1.5 text-[13px] font-mono"
          />
        </label>
      </div>

      <div className="flex flex-row items-stretch gap-1.5 sm:flex-col">
        <button
          type="button"
          onClick={save}
          disabled={busy || (!dirty && !savedAt)}
          className={cn(
            "flex flex-1 items-center justify-center gap-1 rounded-md px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-wide text-white shadow-sm transition-all active:scale-95 disabled:opacity-50 sm:flex-initial",
            savedAt
              ? "bg-synced"
              : dirty
                ? "bg-accent ring-2 ring-accent/30 hover:bg-accent/90"
                : "bg-accent/60 hover:bg-accent",
          )}
        >
          {savedAt ? (
            <>
              <CheckCircle2 size={11} /> Saved
            </>
          ) : busy ? (
            <>
              <Save size={11} /> Saving…
            </>
          ) : dirty ? (
            <>
              <Save size={11} /> Save changes
            </>
          ) : (
            <>
              <Save size={11} /> Saved
            </>
          )}
        </button>
        <button
          type="button"
          onClick={toggleActive}
          className={cn(
            "flex items-center justify-center gap-1 rounded-md border px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-brand transition-colors",
            row.active
              ? "border-synced/40 text-synced hover:bg-synced-bg/40"
              : "border-border text-ink-muted hover:border-accent/50 hover:text-accent",
          )}
        >
          {row.active ? <Power size={11} /> : <PowerOff size={11} />}
          {row.active ? "Active" : "Hidden"}
        </button>
        <button
          type="button"
          onClick={removeAward}
          className="flex items-center justify-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-brand text-ink-muted transition-colors hover:border-err/40 hover:text-err"
        >
          <Trash2 size={11} />
        </button>
      </div>
    </div>
  );
}

// ── Redemptions queue ──────────────────────────────────────────

function RedemptionsPanel({
  status,
  onStatusChange,
}: {
  status: string | null;
  onStatusChange: (s: string | null) => void;
}) {
  const toast = useToast();
  const list = useQuery<{ rows: RedemptionRow[] }>(
    () =>
      api.get(
        `/api/awards/redemptions${status ? `?status=${encodeURIComponent(status)}` : ""}`,
      ),
    [status],
  );

  if (list.loading) return <ListSkeleton rows={6} />;
  if (list.error) {
    return (
      <EmptyState
        icon={<XCircle size={20} />}
        message="Couldn't load redemptions"
        description={list.error}
      />
    );
  }

  async function action(
    id: number,
    op: "ship" | "deliver" | "cancel",
    note?: string,
  ) {
    try {
      await api.post(`/api/awards/redemptions/${id}/${op}`, {
        admin_note: note,
      });
      toast.success(`Marked as ${op === "ship" ? "shipped" : op + "ed"}`);
      list.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    }
  }

  const rows = list.data?.rows ?? [];
  const counts = {
    pending: rows.filter((r) => r.status === "pending").length,
    shipped: rows.filter((r) => r.status === "shipped").length,
    delivered: rows.filter((r) => r.status === "delivered").length,
    cancelled: rows.filter((r) => r.status === "cancelled").length,
  };

  return (
    <div>
      <div className="mb-4 inline-flex flex-wrap rounded-md border border-border bg-surface p-0.5 text-[11px] font-semibold">
        {[
          { v: null, label: "All" },
          { v: "pending", label: `Pending${counts.pending ? " · " + counts.pending : ""}` },
          { v: "shipped", label: `Shipped${counts.shipped ? " · " + counts.shipped : ""}` },
          { v: "delivered", label: "Delivered" },
          { v: "cancelled", label: "Cancelled" },
        ].map((opt) => (
          <button
            key={opt.label}
            onClick={() => onStatusChange(opt.v)}
            className={cn(
              "rounded px-3 py-1 transition-colors",
              status === opt.v || (!status && opt.v === null)
                ? "bg-accent text-white"
                : "text-ink-secondary hover:text-ink",
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={<CheckCircle2 size={20} />}
          message="Inbox zero"
          description="No redemptions match the current filter."
        />
      ) : (
        <DataTable<RedemptionRow>
          tableId="gamify-redemptions"
          rows={rows}
          getRowKey={(r) => r.id}
          mobileCard={{
            primary: "user_name",
            cells: ["award_name", "status", "cost_points"],
            layout: "stack",
          }}
          columns={[
            {
              key: "award_name",
              label: "Award",
              render: (r) => (
                <div className="flex items-center gap-2">
                  <div className="grid h-9 w-12 shrink-0 place-items-center overflow-hidden rounded-md bg-bg/40">
                    <AwardImage
                      awardId={r.award_id}
                      hasImage={!!r.award_image_r2_key}
                      alt={r.award_name}
                      className="h-full w-full object-cover"
                      iconSize={14}
                    />
                  </div>
                  <span className="truncate text-[12.5px] font-semibold text-ink">
                    {r.award_name}
                  </span>
                </div>
              ),
              getValue: (r) => r.award_name,
            },
            {
              key: "user_name",
              label: "Member",
              render: (r) => (
                <div className="flex flex-col">
                  <span className="font-semibold text-ink">
                    {r.user_name || r.user_email || `User #${r.user_id}`}
                  </span>
                  {r.shipping_addr && (
                    <span className="truncate text-[10.5px] text-ink-muted">
                      {r.shipping_addr}
                    </span>
                  )}
                </div>
              ),
              getValue: (r) => r.user_name,
            },
            {
              key: "cost_points",
              label: "Cost",
              align: "right",
              render: (r) => (
                <span className="font-mono text-[12px] font-bold text-accent">
                  {r.cost_points.toLocaleString()}
                </span>
              ),
              getValue: (r) => r.cost_points,
            },
            {
              key: "status",
              label: "Status",
              render: (r) => <StatusChip status={r.status} />,
              getValue: (r) => r.status,
            },
            {
              key: "created_at",
              label: "Requested",
              render: (r) => (
                <span className="font-mono text-[11px] text-ink-muted">
                  {relativeTime(r.created_at)}
                </span>
              ),
              getValue: (r) => r.created_at,
            },
            {
              key: "_actions",
              label: "",
              alwaysVisible: true,
              disableSort: true,
              align: "right",
              render: (r) => (
                <div className="flex items-center justify-end gap-1">
                  {r.status === "pending" && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        action(r.id, "ship");
                      }}
                      className="rounded-md border border-accent/40 px-2 py-1 text-[10px] font-semibold uppercase tracking-brand text-accent transition-colors hover:bg-accent/10"
                    >
                      Mark shipped
                    </button>
                  )}
                  {r.status === "shipped" && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        action(r.id, "deliver");
                      }}
                      className="rounded-md border border-synced/40 px-2 py-1 text-[10px] font-semibold uppercase tracking-brand text-synced transition-colors hover:bg-synced-bg/40"
                    >
                      Mark delivered
                    </button>
                  )}
                  {(r.status === "pending" || r.status === "shipped") && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        const reason = prompt("Cancellation reason?");
                        if (reason !== null) action(r.id, "cancel", reason);
                      }}
                      className="rounded-md border border-border px-2 py-1 text-[10px] font-semibold uppercase tracking-brand text-ink-muted transition-colors hover:border-err/40 hover:text-err"
                    >
                      Cancel
                    </button>
                  )}
                </div>
              ),
            },
          ]}
        />
      )}
    </div>
  );
}

function StatusChip({ status }: { status: RedemptionRow["status"] }) {
  const Icon =
    status === "delivered"
      ? CheckCircle2
      : status === "shipped"
        ? Truck
        : status === "cancelled"
          ? XCircle
          : Clock;
  const tone =
    status === "delivered"
      ? "bg-synced-bg/60 text-synced"
      : status === "cancelled"
        ? "bg-err-bg/60 text-err"
        : status === "shipped"
          ? "bg-accent-soft/60 text-accent-ink"
          : "bg-bg/60 text-ink-secondary";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-brand",
        tone,
      )}
    >
      <Icon size={10} /> {status}
    </span>
  );
}

// ── Innovation triage queue ────────────────────────────────────

interface InnovationAdminRow {
  id: number;
  user_id: number;
  user_name: string | null;
  title: string;
  body: string;
  tags: string | null;
  status:
    | "review"
    | "accepted"
    | "in_progress"
    | "shipped"
    | "declined";
  decided_at: string | null;
  decline_reason: string | null;
  created_at: string;
  vote_count: number;
  has_voted: number;
}

function InnovationsAdminPanel() {
  const [statusFilter, setStatusFilter] = useState<
    "review" | "accepted" | "in_progress" | "shipped" | "declined" | null
  >("review");
  const list = useQuery<{ rows: InnovationAdminRow[] }>(
    () =>
      api.get(
        `/api/innovations${statusFilter ? `?status=${statusFilter}` : ""}`,
      ),
    [statusFilter],
  );
  const counts = useMemo(() => {
    const rows = list.data?.rows ?? [];
    return rows.reduce(
      (acc, r) => {
        acc[r.status] = (acc[r.status] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );
  }, [list.data]);

  return (
    <IdeaAdminPanel
      kind="innovation"
      list={list}
      statuses={[
        { value: "review", label: "Under review" },
        { value: "accepted", label: "Accepted" },
        { value: "in_progress", label: "In progress" },
        { value: "shipped", label: "Shipped" },
        { value: "declined", label: "Declined" },
      ]}
      filter={statusFilter}
      onFilterChange={(v) => setStatusFilter(v as any)}
      counts={counts}
      icon={<Lightbulb size={20} />}
      emptyMessage="No innovations to triage"
      emptyDescription="Anything submitted under /innovations lands here for review."
    />
  );
}

// ── Suggestion triage queue ────────────────────────────────────

interface SuggestionAdminRow {
  id: number;
  user_id: number;
  user_name: string | null;
  title: string;
  body: string | null;
  status: "review" | "approved" | "declined";
  decided_at: string | null;
  decline_reason: string | null;
  created_at: string;
  vote_count: number;
  has_voted: number;
}

function SuggestionsAdminPanel() {
  const [statusFilter, setStatusFilter] = useState<
    "review" | "approved" | "declined" | null
  >("review");
  const list = useQuery<{ rows: SuggestionAdminRow[] }>(
    () =>
      api.get(
        `/api/suggestions${statusFilter ? `?status=${statusFilter}` : ""}`,
      ),
    [statusFilter],
  );
  const counts = useMemo(() => {
    const rows = list.data?.rows ?? [];
    return rows.reduce(
      (acc, r) => {
        acc[r.status] = (acc[r.status] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );
  }, [list.data]);

  return (
    <IdeaAdminPanel
      kind="suggestion"
      list={list}
      statuses={[
        { value: "review", label: "Under review" },
        { value: "approved", label: "Approved" },
        { value: "declined", label: "Declined" },
      ]}
      filter={statusFilter}
      onFilterChange={(v) => setStatusFilter(v as any)}
      counts={counts}
      icon={<MessageCircle size={20} />}
      emptyMessage="No suggestions to triage"
      emptyDescription="Anything submitted under /suggestions lands here for review."
    />
  );
}

// ── Shared idea-admin panel ────────────────────────────────────

interface IdeaAdminPanelProps<T extends InnovationAdminRow | SuggestionAdminRow> {
  kind: "innovation" | "suggestion";
  list: { data: { rows: T[] } | null; loading: boolean; error: string | null; reload: () => void };
  statuses: { value: string; label: string }[];
  filter: string | null;
  onFilterChange: (v: string | null) => void;
  counts: Record<string, number>;
  icon: React.ReactNode;
  emptyMessage: string;
  emptyDescription: string;
}

function IdeaAdminPanel<T extends InnovationAdminRow | SuggestionAdminRow>({
  kind,
  list,
  statuses,
  filter,
  onFilterChange,
  counts,
  icon,
  emptyMessage,
  emptyDescription,
}: IdeaAdminPanelProps<T>) {
  if (list.loading) return <ListSkeleton rows={5} />;
  if (list.error) {
    return (
      <EmptyState
        icon={<XCircle size={20} />}
        message="Couldn't load"
        description={list.error}
      />
    );
  }
  const rows = list.data?.rows ?? [];

  return (
    <div>
      <div className="mb-4 inline-flex flex-wrap rounded-md border border-border bg-surface p-0.5 text-[11px] font-semibold">
        <button
          onClick={() => onFilterChange(null)}
          className={cn(
            "rounded px-3 py-1 transition-colors",
            !filter
              ? "bg-accent text-white"
              : "text-ink-secondary hover:text-ink",
          )}
        >
          All
        </button>
        {statuses.map((s) => (
          <button
            key={s.value}
            onClick={() => onFilterChange(s.value)}
            className={cn(
              "rounded px-3 py-1 transition-colors",
              filter === s.value
                ? "bg-accent text-white"
                : "text-ink-secondary hover:text-ink",
            )}
          >
            {s.label}
            {counts[s.value] ? ` · ${counts[s.value]}` : ""}
          </button>
        ))}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={icon}
          message={emptyMessage}
          description={emptyDescription}
        />
      ) : (
        <ul className="space-y-2">
          {rows.map((r, i) => (
            <IdeaAdminRow
              key={r.id}
              kind={kind}
              row={r}
              statuses={statuses}
              onChange={() => list.reload()}
              index={i}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function IdeaAdminRow<T extends InnovationAdminRow | SuggestionAdminRow>({
  kind,
  row,
  statuses,
  onChange,
  index,
}: {
  kind: "innovation" | "suggestion";
  row: T;
  statuses: { value: string; label: string }[];
  onChange: () => void;
  index: number;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("");
  const [showFull, setShowFull] = useState(false);

  async function decide(s: string) {
    if (s === row.status) return;
    if (s === "declined" && !reason.trim()) {
      toast.error("Add a decline reason first");
      return;
    }
    setBusy(true);
    try {
      await api.post(`/api/${kind}s/${row.id}/decision`, {
        status: s,
        decline_reason: s === "declined" ? reason.trim() : undefined,
      });
      const verb =
        s === "shipped"
          ? "shipped"
          : s === "approved"
            ? "approved"
            : s === "declined"
              ? "declined"
              : `moved to ${s}`;
      toast.success(`Marked ${verb}`);
      onChange();
    } catch (e: any) {
      toast.error(e?.message || "Decision failed");
    } finally {
      setBusy(false);
    }
  }

  const tags = (row as InnovationAdminRow).tags;
  const body = row.body;

  return (
    <li
      className="overflow-hidden rounded-xl border border-border bg-surface shadow-stone transition-all hover:border-accent/40 animate-rise"
      style={{ animationDelay: `${Math.min(index * 30, 600)}ms` }}
    >
      <div className="flex items-start gap-3 p-3">
        {/* Vote count column */}
        <div className="flex w-12 shrink-0 flex-col items-center gap-0.5 rounded-lg border border-border bg-bg/40 px-2 py-2">
          <ArrowUp size={14} className="text-ink-muted" />
          <span className="font-mono text-[12px] font-bold leading-none text-ink">
            {row.vote_count}
          </span>
          <span className="text-[8.5px] uppercase tracking-brand text-ink-muted">
            votes
          </span>
        </div>

        {/* Body */}
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="font-display text-[15px] font-extrabold leading-tight tracking-tight text-ink">
              {row.title}
            </h3>
            <IdeaStatusBadge status={row.status} />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-ink-muted">
            <span>
              by{" "}
              <span className="font-semibold text-ink-secondary">
                {row.user_name || `User #${row.user_id}`}
              </span>
            </span>
            <span className="font-mono">{relativeTime(row.created_at)}</span>
            {tags && (
              <span className="inline-flex items-center gap-1">
                {tags
                  .split(",")
                  .map((t) => t.trim())
                  .filter(Boolean)
                  .slice(0, 4)
                  .map((t) => (
                    <span
                      key={t}
                      className="rounded-full bg-accent-soft/40 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-brand text-accent-ink"
                    >
                      {t}
                    </span>
                  ))}
              </span>
            )}
          </div>

          {body && (
            <div className="mt-2 text-[12px] leading-relaxed text-ink-secondary">
              {showFull ? (
                <p className="whitespace-pre-wrap">{body}</p>
              ) : (
                <p className="line-clamp-2">{body}</p>
              )}
              {body.length > 150 && (
                <button
                  type="button"
                  onClick={() => setShowFull((v) => !v)}
                  className="mt-1 text-[10.5px] font-semibold text-accent hover:underline"
                >
                  {showFull ? "Show less" : "Show more"}
                </button>
              )}
            </div>
          )}

          {row.decline_reason && (
            <div className="mt-2 rounded-md border border-err/30 bg-err-bg/40 p-2 text-[11px] text-err">
              <span className="font-semibold uppercase tracking-brand">
                Declined:{" "}
              </span>
              {row.decline_reason}
            </div>
          )}

          {/* Decision row */}
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {statuses.map((s) => (
              <button
                key={s.value}
                type="button"
                disabled={busy || s.value === row.status}
                onClick={() => decide(s.value)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-[10.5px] font-bold uppercase tracking-brand transition-all active:scale-95",
                  s.value === row.status
                    ? "cursor-default bg-ink/10 text-ink-muted"
                    : statusButton(s.value),
                  busy && "opacity-50",
                )}
              >
                {s.label}
              </button>
            ))}
          </div>

          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Decline reason (only required when declining)"
            className="mt-2 w-full rounded-md border border-border bg-paper px-2 py-1.5 text-[11.5px]"
          />
        </div>
      </div>
    </li>
  );
}

function IdeaStatusBadge({ status }: { status: string }) {
  const Icon =
    status === "shipped" || status === "approved"
      ? Rocket
      : status === "in_progress"
        ? Hourglass
        : status === "accepted"
          ? CheckCircle2
          : status === "declined"
            ? XCircle
            : Clock;
  const tone =
    status === "shipped" || status === "approved"
      ? "bg-synced-bg/70 text-synced"
      : status === "in_progress"
        ? "bg-warning-bg/70 text-warning-text"
        : status === "accepted"
          ? "bg-accent-soft/60 text-accent-ink"
          : status === "declined"
            ? "bg-err-bg/60 text-err"
            : "bg-bg/60 text-ink-secondary";
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-brand",
        tone,
      )}
    >
      <Icon size={10} />
      {status.replace(/_/g, " ")}
    </span>
  );
}

function statusButton(status: string): string {
  switch (status) {
    case "review":
      return "bg-bg/60 text-ink-secondary hover:bg-bg/80";
    case "accepted":
      return "bg-accent-soft/60 text-accent-ink hover:bg-accent-soft";
    case "in_progress":
      return "bg-warning-bg/70 text-warning-text hover:bg-warning-bg";
    case "shipped":
    case "approved":
      return "bg-synced-bg/70 text-synced hover:bg-synced-bg";
    case "declined":
      return "bg-err-bg/60 text-err hover:bg-err-bg";
    default:
      return "bg-bg/60 text-ink-secondary hover:bg-bg/80";
  }
}
