import { useMemo, useState } from "react";
import {
  ArrowRight,
  AlertTriangle,
  LayoutGrid,
  List,
  Ship,
  Truck,
  Package,
} from "lucide-react";
import { Panel, PanelSection, FieldRow } from "./Panel";
import { FilterPills } from "./FilterPills";
import { StatCard } from "./StatCard";
import { DashboardGrid } from "./Dashboard";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { api, buildQuery } from "../api/client";
import { formatCurrency, formatDate, cn } from "../lib/utils";
import type { Paginated } from "../types";

// ── Types ─────────────────────────────────────────────────────────

interface DeliveryRecord {
  doc_no: string;
  region: string;
  status: string;
  debtor_name: string | null;
  phone: string | null;
  sales_location: string | null;
  order_revenue: number;
  budget_amount: number;
  freight_cost: number;
  last_mile_cost: number;
  total_cost: number;
  customer_transport_fee: number;
  delivery_method: string;
  vendor_name: string | null;
  trip_id: number | null;
  em_warehouse: string | null;
  shipout_date: string | null;
  est_arrival_date: string | null;
  est_delivery_date: string | null;
  delivered_at: string | null;
  updated_at: string;
}

interface DeliveryDetail extends DeliveryRecord {
  do_ready_at: string | null;
  pickup_confirmed_at: string | null;
  arrived_warehouse_at: string | null;
  out_for_delivery_at: string | null;
  failed_at: string | null;
  failure_reason: string | null;
  budget_pct: number;
  notes: string | null;
  inv_addr1: string | null;
  inv_addr2: string | null;
  inv_addr3: string | null;
  inv_addr4: string | null;
  local_total: number;
  balance: number;
  log: {
    from_status: string | null;
    to_status: string;
    changed_by_name: string | null;
    created_at: string;
    notes: string | null;
  }[];
  next_statuses: string[];
}

interface OverdueData {
  shipout_overdue: any[];
  delivery_overdue: any[];
  arrival_overdue: any[];
  total: number;
}

const STATUS_LABELS: Record<string, string> = {
  do_ready: "DO Ready",
  pending_shipout: "Pending Shipout",
  shipped: "Shipped",
  in_transit: "In Transit",
  at_warehouse: "At Warehouse",
  out_for_delivery: "Out for Delivery",
  delivered: "Delivered",
  failed: "Failed",
};

const STATUS_ICONS: Record<string, any> = {
  do_ready: Package,
  pending_shipout: Package,
  shipped: Ship,
  in_transit: Ship,
  at_warehouse: Package,
  out_for_delivery: Truck,
  delivered: Package,
  failed: AlertTriangle,
};

// ── Pipelines per region ──────────────────────────────────────────

const PIPELINES: Record<string, string[]> = {
  ALL: [
    "do_ready",
    "pending_shipout",
    "shipped",
    "in_transit",
    "at_warehouse",
    "out_for_delivery",
    "delivered",
  ],
  WEST: ["do_ready", "out_for_delivery", "delivered"],
  SG: ["do_ready", "pending_shipout", "shipped", "delivered"],
  EAST: [
    "do_ready",
    "pending_shipout",
    "shipped",
    "in_transit",
    "at_warehouse",
    "out_for_delivery",
    "delivered",
  ],
};

// ── Main component ────────────────────────────────────────────────

export function TrackingTab() {
  const [region, setRegion] = useState("");
  const [view, setView] = useLocalStorage<"board" | "table">(
    "tracking:view",
    "board"
  );
  const [selected, setSelected] = useState<string | null>(null);

  // Fetch all non-delivered records for the board view
  const list = useQuery<Paginated<DeliveryRecord>>(
    () =>
      api.get(
        `/api/delivery${buildQuery({
          region: region || undefined,
          per_page: 200,
        })}`
      ),
    [region]
  );

  const overdue = useQuery<OverdueData>(() => api.get("/api/delivery/overdue"));

  const rows = list.data?.data ?? [];

  // Compute stats
  const stats = useMemo(() => {
    const byStatus: Record<string, number> = {};
    let totalRevenue = 0;
    let totalCost = 0;
    let overBudget = 0;
    for (const r of rows) {
      byStatus[r.status] = (byStatus[r.status] || 0) + 1;
      totalRevenue += r.order_revenue;
      totalCost += r.total_cost;
      if (r.total_cost > r.budget_amount && r.total_cost > 0) overBudget++;
    }
    return { byStatus, totalRevenue, totalCost, overBudget, total: rows.length };
  }, [rows]);

  const activeCount =
    stats.total - (stats.byStatus["delivered"] || 0) - (stats.byStatus["failed"] || 0);

  return (
    <div>
      {/* Stats */}
      <DashboardGrid cols={4}>
        <StatCard
          label="Active Deliveries"
          value={activeCount.toString()}
          subtitle={`${stats.total} total`}
        />
        <StatCard
          label="Overdue"
          value={(overdue.data?.total ?? 0).toString()}
          subtitle="Needs attention"
          tone={(overdue.data?.total ?? 0) > 0 ? "error" : "default"}
        />
        <StatCard
          label="In Transit"
          value={(
            (stats.byStatus["shipped"] || 0) +
            (stats.byStatus["in_transit"] || 0)
          ).toString()}
          subtitle="On the way"
        />
        <StatCard
          label="Over Budget"
          value={stats.overBudget.toString()}
          subtitle="Cost exceeds 3% allocation"
          tone={stats.overBudget > 0 ? "error" : "default"}
        />
      </DashboardGrid>

      {/* Filters + view toggle */}
      <div className="mb-4 mt-4 flex flex-wrap items-center gap-3">
        <FilterPills
          value={region}
          onChange={setRegion}
          options={[
            { value: "", label: "All Regions" },
            { value: "WEST", label: "West" },
            { value: "EAST", label: "East" },
            { value: "SG", label: "SG" },
          ]}
        />
        <div className="ml-auto flex items-center gap-1 rounded-md border border-border bg-surface p-0.5">
          <button
            onClick={() => setView("board")}
            className={cn(
              "rounded px-2 py-1",
              view === "board"
                ? "bg-accent text-white"
                : "text-ink-secondary hover:text-ink"
            )}
          >
            <LayoutGrid size={14} />
          </button>
          <button
            onClick={() => setView("table")}
            className={cn(
              "rounded px-2 py-1",
              view === "table"
                ? "bg-accent text-white"
                : "text-ink-secondary hover:text-ink"
            )}
          >
            <List size={14} />
          </button>
        </div>
      </div>

      {list.loading && (
        <div className="text-sm text-ink-secondary">Loading…</div>
      )}

      {!list.loading && view === "board" && (
        <BoardView
          rows={rows}
          region={region}
          overdue={overdue.data ?? undefined}
          onSelect={setSelected}
        />
      )}

      {!list.loading && view === "table" && (
        <TableView rows={rows} onSelect={setSelected} />
      )}

      <DeliveryPanel
        docNo={selected}
        onClose={() => setSelected(null)}
        onUpdated={() => {
          list.reload();
          overdue.reload();
        }}
      />
    </div>
  );
}

// ── Board view (kanban) ───────────────────────────────────────────

function BoardView({
  rows,
  region,
  overdue,
  onSelect,
}: {
  rows: DeliveryRecord[];
  region: string;
  overdue: OverdueData | undefined;
  onSelect: (docNo: string) => void;
}) {
  const pipeline = PIPELINES[region || "ALL"] || PIPELINES.ALL;
  const today = new Date().toISOString().slice(0, 10);

  // Build overdue set for highlighting
  const overdueSet = useMemo(() => {
    const set = new Set<string>();
    if (!overdue) return set;
    for (const r of [
      ...overdue.shipout_overdue,
      ...overdue.delivery_overdue,
      ...overdue.arrival_overdue,
    ]) {
      set.add(r.doc_no);
    }
    return set;
  }, [overdue]);

  // Group rows by status
  const grouped = useMemo(() => {
    const map: Record<string, DeliveryRecord[]> = {};
    for (const s of pipeline) map[s] = [];
    map["failed"] = [];
    for (const r of rows) {
      if (map[r.status]) map[r.status].push(r);
    }
    return map;
  }, [rows, pipeline]);

  // Don't show delivered column if it would be huge — show count instead
  const deliveredCount = grouped["delivered"]?.length ?? 0;
  const showDeliveredCards = deliveredCount <= 10;

  // Active columns (exclude delivered if too many)
  const activeCols = pipeline.filter((s) => s !== "delivered");
  const hasFailed = (grouped["failed"]?.length ?? 0) > 0;

  return (
    <div className="flex gap-3 overflow-x-auto pb-4">
      {activeCols.map((status) => {
        const cards = grouped[status] || [];
        const Icon = STATUS_ICONS[status] || Package;
        return (
          <div
            key={status}
            className="flex w-[220px] shrink-0 flex-col rounded-lg border border-border bg-bg/60"
          >
            {/* Column header */}
            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
              <Icon size={13} className="text-ink-secondary" />
              <span className="text-[10px] font-semibold uppercase tracking-brand text-ink-secondary">
                {STATUS_LABELS[status] || status}
              </span>
              <span className="ml-auto rounded-full bg-ink/10 px-1.5 py-0.5 text-[9px] font-bold text-ink">
                {cards.length}
              </span>
            </div>

            {/* Cards */}
            <div className="thin-scroll flex-1 space-y-1.5 overflow-y-auto p-2"
              style={{ maxHeight: 480 }}
            >
              {cards.map((r) => {
                const isOverdue = overdueSet.has(r.doc_no);
                return (
                  <div
                    key={r.doc_no}
                    onClick={() => onSelect(r.doc_no)}
                    className={cn(
                      "cursor-pointer rounded-md border bg-surface p-2.5 transition-colors hover:border-accent/40",
                      isOverdue
                        ? "border-err/40 bg-err/5"
                        : "border-border"
                    )}
                  >
                    <div className="flex items-start justify-between gap-1">
                      <span className="font-mono text-[10px] font-bold text-ink">
                        {r.doc_no}
                      </span>
                      <span
                        className={cn(
                          "shrink-0 rounded-full px-1.5 py-0.5 text-[8px] font-bold uppercase",
                          r.region === "WEST" && "bg-accent/10 text-accent",
                          r.region === "EAST" && "bg-warning-bg text-warning-text",
                          r.region === "SG" && "bg-ink/10 text-ink"
                        )}
                      >
                        {r.region}
                      </span>
                    </div>
                    <div className="mt-1 truncate text-[11px] text-ink">
                      {r.debtor_name || "—"}
                    </div>
                    <div className="mt-1 flex items-center justify-between text-[10px]">
                      <span className="font-mono text-ink-secondary">
                        {formatCurrency(r.order_revenue)}
                      </span>
                      {isOverdue && (
                        <span className="flex items-center gap-0.5 font-semibold text-err">
                          <AlertTriangle size={10} />
                          Overdue
                        </span>
                      )}
                    </div>
                    {r.est_delivery_date && (
                      <div
                        className={cn(
                          "mt-1 text-[10px]",
                          r.est_delivery_date < today && r.status !== "delivered"
                            ? "font-semibold text-err"
                            : "text-ink-secondary"
                        )}
                      >
                        Est. {formatDate(r.est_delivery_date)}
                      </div>
                    )}
                  </div>
                );
              })}
              {!cards.length && (
                <div className="py-4 text-center text-[10px] text-ink-muted">
                  Empty
                </div>
              )}
            </div>
          </div>
        );
      })}

      {/* Delivered column — compact */}
      <div className="flex w-[220px] shrink-0 flex-col rounded-lg border border-ok/30 bg-ok/5">
        <div className="flex items-center gap-2 border-b border-ok/20 px-3 py-2">
          <Package size={13} className="text-ok" />
          <span className="text-[10px] font-semibold uppercase tracking-brand text-ok">
            Delivered
          </span>
          <span className="ml-auto rounded-full bg-ok/20 px-1.5 py-0.5 text-[9px] font-bold text-ok">
            {deliveredCount}
          </span>
        </div>
        <div
          className="thin-scroll flex-1 space-y-1.5 overflow-y-auto p-2"
          style={{ maxHeight: 480 }}
        >
          {showDeliveredCards
            ? grouped["delivered"]?.map((r) => (
                <div
                  key={r.doc_no}
                  onClick={() => onSelect(r.doc_no)}
                  className="cursor-pointer rounded-md border border-ok/20 bg-surface p-2 transition-colors hover:border-ok/40"
                >
                  <div className="font-mono text-[10px] font-bold text-ink">
                    {r.doc_no}
                  </div>
                  <div className="mt-0.5 truncate text-[10px] text-ink-secondary">
                    {r.debtor_name}
                  </div>
                </div>
              ))
            : (
              <div className="py-4 text-center text-[11px] text-ok">
                {deliveredCount} orders delivered
              </div>
            )}
        </div>
      </div>

      {/* Failed column */}
      {hasFailed && (
        <div className="flex w-[220px] shrink-0 flex-col rounded-lg border border-err/30 bg-err/5">
          <div className="flex items-center gap-2 border-b border-err/20 px-3 py-2">
            <AlertTriangle size={13} className="text-err" />
            <span className="text-[10px] font-semibold uppercase tracking-brand text-err">
              Failed
            </span>
            <span className="ml-auto rounded-full bg-err/20 px-1.5 py-0.5 text-[9px] font-bold text-err">
              {grouped["failed"]?.length || 0}
            </span>
          </div>
          <div
            className="thin-scroll flex-1 space-y-1.5 overflow-y-auto p-2"
            style={{ maxHeight: 480 }}
          >
            {grouped["failed"]?.map((r) => (
              <div
                key={r.doc_no}
                onClick={() => onSelect(r.doc_no)}
                className="cursor-pointer rounded-md border border-err/20 bg-surface p-2 transition-colors hover:border-err/40"
              >
                <div className="font-mono text-[10px] font-bold text-ink">
                  {r.doc_no}
                </div>
                <div className="mt-0.5 truncate text-[10px] text-err">
                  {r.debtor_name}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Table view ────────────────────────────────────────────────────

function TableView({
  rows,
  onSelect,
}: {
  rows: DeliveryRecord[];
  onSelect: (docNo: string) => void;
}) {
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b border-border bg-bg/60 text-left">
            <th className="px-3 py-2 text-[10px] font-semibold uppercase tracking-brand text-ink-secondary">Doc No</th>
            <th className="px-3 py-2 text-[10px] font-semibold uppercase tracking-brand text-ink-secondary">Customer</th>
            <th className="px-3 py-2 text-[10px] font-semibold uppercase tracking-brand text-ink-secondary">Region</th>
            <th className="px-3 py-2 text-[10px] font-semibold uppercase tracking-brand text-ink-secondary">Status</th>
            <th className="px-3 py-2 text-right text-[10px] font-semibold uppercase tracking-brand text-ink-secondary">Revenue</th>
            <th className="px-3 py-2 text-right text-[10px] font-semibold uppercase tracking-brand text-ink-secondary">Cost</th>
            <th className="px-3 py-2 text-[10px] font-semibold uppercase tracking-brand text-ink-secondary">Est. Delivery</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const isOverdue =
              r.est_delivery_date &&
              r.est_delivery_date < today &&
              r.status !== "delivered" &&
              r.status !== "failed";
            return (
              <tr
                key={r.doc_no}
                onClick={() => onSelect(r.doc_no)}
                className={cn(
                  "cursor-pointer border-b border-border transition-colors hover:bg-accent/5",
                  isOverdue && "bg-err/5"
                )}
              >
                <td className="px-3 py-2 font-mono font-bold text-ink">
                  {r.doc_no}
                </td>
                <td className="max-w-[180px] truncate px-3 py-2 text-ink">
                  {r.debtor_name || "—"}
                </td>
                <td className="px-3 py-2">
                  <span className="rounded-full bg-ink/10 px-2 py-0.5 text-[10px] font-semibold uppercase">
                    {r.region}
                  </span>
                </td>
                <td className="px-3 py-2">
                  <StatusBadge status={r.status} />
                </td>
                <td className="px-3 py-2 text-right font-mono">
                  {formatCurrency(r.order_revenue)}
                </td>
                <td className="px-3 py-2 text-right font-mono">
                  <span
                    className={cn(
                      r.total_cost > r.budget_amount && r.total_cost > 0
                        ? "font-semibold text-err"
                        : ""
                    )}
                  >
                    {r.total_cost > 0 ? formatCurrency(r.total_cost) : "—"}
                  </span>
                </td>
                <td className="px-3 py-2">
                  {r.est_delivery_date ? (
                    <span className={isOverdue ? "font-semibold text-err" : ""}>
                      {formatDate(r.est_delivery_date)}
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            );
          })}
          {!rows.length && (
            <tr>
              <td colSpan={7} className="px-3 py-8 text-center text-ink-secondary">
                No delivery records
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    do_ready: "bg-ink/10 text-ink",
    pending_shipout: "bg-accent/10 text-accent",
    shipped: "bg-accent/10 text-accent",
    in_transit: "bg-warning-bg text-warning-text",
    at_warehouse: "bg-warning-bg text-warning-text",
    out_for_delivery: "bg-accent/10 text-accent",
    delivered: "bg-ok/10 text-ok",
    failed: "bg-err/10 text-err",
  };
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase",
        colors[status] || "bg-ink/10 text-ink"
      )}
    >
      {STATUS_LABELS[status] || status}
    </span>
  );
}

// ── Detail panel ──────────────────────────────────────────────────

function DeliveryPanel({
  docNo,
  onClose,
  onUpdated,
}: {
  docNo: string | null;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const toast = useToast();
  const detail = useQuery<DeliveryDetail>(
    () =>
      docNo
        ? api.get(`/api/delivery/${docNo}`)
        : Promise.resolve(null as any),
    [docNo]
  );
  const [busy, setBusy] = useState(false);
  const [advanceNotes, setAdvanceNotes] = useState("");
  const [editMode, setEditMode] = useState(false);
  const [form, setForm] = useState<Record<string, any>>({});

  const d = detail.data;

  async function advance(newStatus: string) {
    if (!docNo) return;
    setBusy(true);
    try {
      await api.post(`/api/delivery/${docNo}/advance`, {
        status: newStatus,
        notes: advanceNotes || undefined,
        ...form,
      });
      setAdvanceNotes("");
      setForm({});
      detail.reload();
      onUpdated();
    } catch (e: any) {
      toast.error(e?.message || "Advance failed");
    } finally {
      setBusy(false);
    }
  }

  async function saveFields() {
    if (!docNo) return;
    setBusy(true);
    try {
      await api.patch(`/api/delivery/${docNo}`, form);
      setEditMode(false);
      setForm({});
      detail.reload();
      onUpdated();
    } catch (e: any) {
      toast.error(e?.message || "Save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      open={!!docNo}
      onClose={() => {
        onClose();
        setEditMode(false);
        setForm({});
      }}
      title={docNo || ""}
      subtitle={
        d ? `${d.region} · ${STATUS_LABELS[d.status] || d.status}` : ""
      }
      width={520}
    >
      {d && (
        <>
          {/* Pipeline */}
          <PanelSection title="Pipeline">
            <StatusPipeline region={d.region} current={d.status} />
          </PanelSection>

          {/* Next step */}
          {d.next_statuses.length > 0 && (
            <PanelSection title="Next Step">
              {d.next_statuses.includes("pending_shipout") && (
                <label className="mb-2 block">
                  <span className="text-[9px] font-semibold uppercase tracking-brand text-ink-secondary">
                    Shipout Date
                  </span>
                  <input
                    type="date"
                    value={form.shipout_date || ""}
                    onChange={(e) =>
                      setForm({ ...form, shipout_date: e.target.value })
                    }
                    className="w-full rounded border border-border bg-paper px-2 py-1.5 text-[12px]"
                  />
                </label>
              )}
              {d.next_statuses.includes("in_transit") && (
                <label className="mb-2 block">
                  <span className="text-[9px] font-semibold uppercase tracking-brand text-ink-secondary">
                    Est. Arrival at Warehouse
                  </span>
                  <input
                    type="date"
                    value={form.est_arrival_date || ""}
                    onChange={(e) =>
                      setForm({ ...form, est_arrival_date: e.target.value })
                    }
                    className="w-full rounded border border-border bg-paper px-2 py-1.5 text-[12px]"
                  />
                </label>
              )}
              {d.next_statuses.includes("out_for_delivery") && (
                <label className="mb-2 block">
                  <span className="text-[9px] font-semibold uppercase tracking-brand text-ink-secondary">
                    Est. Delivery Date
                  </span>
                  <input
                    type="date"
                    value={form.est_delivery_date || ""}
                    onChange={(e) =>
                      setForm({ ...form, est_delivery_date: e.target.value })
                    }
                    className="w-full rounded border border-border bg-paper px-2 py-1.5 text-[12px]"
                  />
                </label>
              )}

              <textarea
                value={advanceNotes}
                onChange={(e) => setAdvanceNotes(e.target.value)}
                placeholder="Notes (optional)"
                rows={2}
                className="mb-2 w-full rounded border border-border bg-paper px-2 py-1.5 text-[12px]"
              />

              <div className="flex flex-wrap gap-2">
                {d.next_statuses.map((ns) => (
                  <button
                    key={ns}
                    disabled={busy}
                    onClick={() => advance(ns)}
                    className={cn(
                      "flex items-center gap-1.5 rounded-md px-3 py-2 text-[12px] font-bold uppercase tracking-wide disabled:opacity-50",
                      ns === "failed"
                        ? "border border-err/30 bg-err/10 text-err"
                        : ns === "delivered"
                        ? "bg-ok text-white"
                        : "bg-accent text-white"
                    )}
                  >
                    <ArrowRight size={13} />
                    {STATUS_LABELS[ns] || ns}
                  </button>
                ))}
              </div>
            </PanelSection>
          )}

          {/* Order info */}
          <PanelSection title="Order" muted>
            <FieldRow label="Customer">{d.debtor_name || "—"}</FieldRow>
            <FieldRow label="Phone">{d.phone || "—"}</FieldRow>
            <FieldRow label="Location">{d.sales_location || "—"}</FieldRow>
            {d.inv_addr1 && (
              <FieldRow label="Address">
                {[d.inv_addr1, d.inv_addr2, d.inv_addr3, d.inv_addr4]
                  .filter(Boolean)
                  .join(", ")}
              </FieldRow>
            )}
          </PanelSection>

          {/* Milestones */}
          <PanelSection title="Milestones">
            <FieldRow label="DO Ready">{formatDate(d.do_ready_at)}</FieldRow>
            {d.region !== "WEST" && (
              <>
                <FieldRow label="Shipout Date">
                  {formatDate(d.shipout_date)}
                </FieldRow>
                <FieldRow label="Pickup Confirmed">
                  {formatDate(d.pickup_confirmed_at)}
                </FieldRow>
              </>
            )}
            {d.region === "EAST" && (
              <>
                <FieldRow label="Est. Arrival">
                  {formatDate(d.est_arrival_date)}
                </FieldRow>
                <FieldRow label="Arrived Warehouse">
                  {formatDate(d.arrived_warehouse_at)}
                </FieldRow>
                <FieldRow label="EM Warehouse">
                  {d.em_warehouse || "—"}
                </FieldRow>
              </>
            )}
            <FieldRow label="Est. Delivery">
              {formatDate(d.est_delivery_date)}
            </FieldRow>
            <FieldRow label="Out for Delivery">
              {formatDate(d.out_for_delivery_at)}
            </FieldRow>
            <FieldRow label="Delivered">{formatDate(d.delivered_at)}</FieldRow>
            {d.failed_at && (
              <>
                <FieldRow label="Failed">{formatDate(d.failed_at)}</FieldRow>
                <FieldRow label="Reason">
                  {d.failure_reason || "—"}
                </FieldRow>
              </>
            )}
          </PanelSection>

          {/* Costing */}
          <PanelSection title="Costing">
            <FieldRow label="Revenue" mono>
              {formatCurrency(d.order_revenue)}
            </FieldRow>
            <FieldRow label={`Budget (${d.budget_pct}%)`} mono>
              {formatCurrency(d.budget_amount)}
            </FieldRow>
            <FieldRow label="Freight Cost" mono>
              {formatCurrency(d.freight_cost)}
            </FieldRow>
            <FieldRow label="Last Mile Cost" mono>
              {formatCurrency(d.last_mile_cost)}
            </FieldRow>
            <FieldRow label="Total Cost" mono>
              <span
                className={cn(
                  "font-bold",
                  d.total_cost > d.budget_amount ? "text-err" : "text-ok"
                )}
              >
                {formatCurrency(d.total_cost)}
              </span>
            </FieldRow>
            {d.customer_transport_fee > 0 && (
              <>
                <FieldRow label="Customer Charged" mono>
                  {formatCurrency(d.customer_transport_fee)}
                </FieldRow>
                <FieldRow label="Fee vs Cost" mono>
                  <span
                    className={cn(
                      "font-bold",
                      d.customer_transport_fee >= d.total_cost
                        ? "text-ok"
                        : "text-err"
                    )}
                  >
                    {formatCurrency(d.customer_transport_fee - d.total_cost)}
                  </span>
                </FieldRow>
              </>
            )}
            <FieldRow label="Method">{d.delivery_method}</FieldRow>
            {d.vendor_name && (
              <FieldRow label="Vendor">{d.vendor_name}</FieldRow>
            )}

            {!editMode ? (
              <button
                onClick={() => {
                  setEditMode(true);
                  setForm({
                    freight_cost: d.freight_cost,
                    last_mile_cost: d.last_mile_cost,
                    customer_transport_fee: d.customer_transport_fee,
                  });
                }}
                className="mt-2 rounded-md border border-border bg-surface px-3 py-1.5 text-[11px] font-semibold text-ink"
              >
                Edit Costs
              </button>
            ) : (
              <div className="mt-2 space-y-2 rounded-md border border-accent/30 bg-accent/5 p-3">
                <CostField
                  label="Freight Cost"
                  value={form.freight_cost}
                  onChange={(v) => setForm({ ...form, freight_cost: v })}
                />
                <CostField
                  label="Last Mile Cost"
                  value={form.last_mile_cost}
                  onChange={(v) => setForm({ ...form, last_mile_cost: v })}
                />
                <CostField
                  label="Customer Transport Fee"
                  value={form.customer_transport_fee}
                  onChange={(v) =>
                    setForm({ ...form, customer_transport_fee: v })
                  }
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setEditMode(false);
                      setForm({});
                    }}
                    className="rounded-md border border-border bg-surface px-3 py-1.5 text-[11px] font-semibold text-ink"
                  >
                    Cancel
                  </button>
                  <button
                    disabled={busy}
                    onClick={saveFields}
                    className="rounded-md bg-accent px-3 py-1.5 text-[11px] font-bold text-white disabled:opacity-50"
                  >
                    {busy ? "Saving…" : "Save"}
                  </button>
                </div>
              </div>
            )}
          </PanelSection>

          {/* History */}
          {d.log.length > 0 && (
            <PanelSection title="History">
              <div className="space-y-1">
                {d.log.map((l, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-2 text-[11px]"
                  >
                    <span className="shrink-0 text-ink-secondary">
                      {formatDate(l.created_at)}
                    </span>
                    <span>
                      {l.from_status && (
                        <span className="text-ink-secondary">
                          {STATUS_LABELS[l.from_status] || l.from_status} →{" "}
                        </span>
                      )}
                      <span className="font-semibold text-ink">
                        {STATUS_LABELS[l.to_status] || l.to_status}
                      </span>
                      {l.changed_by_name && (
                        <span className="text-ink-secondary">
                          {" "}
                          by {l.changed_by_name}
                        </span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </PanelSection>
          )}
        </>
      )}
    </Panel>
  );
}

// ── Pipeline viz ──────────────────────────────────────────────────

function StatusPipeline({
  region,
  current,
}: {
  region: string;
  current: string;
}) {
  const steps = PIPELINES[region] || PIPELINES.WEST;
  const currentIdx = steps.indexOf(current);
  const isFailed = current === "failed";

  return (
    <div className="flex items-center gap-1 overflow-x-auto">
      {steps.map((step, i) => {
        const isDone = i < currentIdx;
        const isCurrent = i === currentIdx && !isFailed;
        return (
          <div key={step} className="flex items-center gap-1">
            {i > 0 && (
              <div
                className={cn(
                  "h-px w-3",
                  isDone || isCurrent ? "bg-accent" : "bg-border"
                )}
              />
            )}
            <div
              className={cn(
                "whitespace-nowrap rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide",
                isDone && "bg-ok/10 text-ok",
                isCurrent && "bg-accent text-white",
                !isDone && !isCurrent && "bg-ink/5 text-ink-secondary"
              )}
            >
              {STATUS_LABELS[step] || step}
            </div>
          </div>
        );
      })}
      {isFailed && (
        <>
          <div className="h-px w-3 bg-err" />
          <div className="whitespace-nowrap rounded-full bg-err px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-white">
            Failed
          </div>
        </>
      )}
    </div>
  );
}

// ── Cost field ────────────────────────────────────────────────────

function CostField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-[9px] font-semibold uppercase tracking-brand text-ink-secondary">
        {label}
      </span>
      <input
        type="number"
        step="0.01"
        value={value ?? 0}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        className="w-full rounded border border-border bg-paper px-2 py-1.5 text-[12px] font-mono"
      />
    </label>
  );
}
