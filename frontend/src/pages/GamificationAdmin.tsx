import { useRef, useState } from "react";
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
import { api, tokenStore } from "../api/client";
import { cn, relativeTime } from "../lib/utils";

type AdminTab = "catalog" | "redemptions";

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
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [version, setVersion] = useState(0);

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
      toast.success("Saved");
      onChange();
    } catch (e: any) {
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
      const buf = await f.arrayBuffer();
      const token = tokenStore.get();
      const res = await fetch(
        `/api/awards/${row.id}/image?name=${encodeURIComponent(f.name)}`,
        {
          method: "PUT",
          headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            "Content-Type": f.type || "application/octet-stream",
          },
          body: buf,
        },
      );
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
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
          disabled={busy}
          className="flex flex-1 items-center justify-center gap-1 rounded-md bg-accent px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-wide text-white transition-all hover:bg-accent/90 active:scale-95 disabled:opacity-50 sm:flex-initial"
        >
          <Save size={11} /> Save
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
