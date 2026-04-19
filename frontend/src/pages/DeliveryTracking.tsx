import { useState } from "react";
import {
  ArrowRight,
  AlertTriangle,
  Package,
  Ship,
  Truck,
  CheckCircle2,
  XCircle,
  Clock,
} from "lucide-react";
import { PageHeader } from "../components/Layout";
import { DataTable } from "../components/DataTable";
import { FilterPills } from "../components/FilterPills";
import { Pagination } from "../components/Pagination";
import { Panel, PanelSection, FieldRow } from "../components/Panel";
import { StatCard } from "../components/StatCard";
import { DashboardGrid } from "../components/Dashboard";
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
  log: { from_status: string | null; to_status: string; changed_by_name: string | null; created_at: string; notes: string | null }[];
  next_statuses: string[];
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

const STATUS_COLORS: Record<string, string> = {
  do_ready: "bg-ink/10 text-ink",
  pending_shipout: "bg-accent/10 text-accent",
  shipped: "bg-accent/10 text-accent",
  in_transit: "bg-warning-bg text-warning-text",
  at_warehouse: "bg-warning-bg text-warning-text",
  out_for_delivery: "bg-accent/10 text-accent",
  delivered: "bg-ok/10 text-ok",
  failed: "bg-err/10 text-err",
};

// ── Main page ─────────────────────────────────────────────────────

export function DeliveryTracking() {
  const [region, setRegion] = useState("");
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useLocalStorage<number>("pp:delivery", 50);
  const [selected, setSelected] = useState<string | null>(null);

  const list = useQuery<Paginated<DeliveryRecord>>(
    () =>
      api.get(
        `/api/delivery${buildQuery({
          region,
          status,
          search,
          overdue: overdueOnly ? "1" : undefined,
          page,
          per_page: perPage,
        })}`
      ),
    [region, status, search, overdueOnly, page, perPage]
  );

  const overdue = useQuery<{ total: number }>(() => api.get("/api/delivery/overdue"));

  const rows = list.data?.data ?? [];

  return (
    <div>
      <PageHeader
        eyebrow="Operations"
        title="Delivery Tracking"
        description="Track order delivery lifecycle across all regions."
        actions={
          overdue.data && overdue.data.total > 0 ? (
            <button
              onClick={() => setOverdueOnly(!overdueOnly)}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-3 py-2 text-[12px] font-bold uppercase tracking-wide",
                overdueOnly
                  ? "bg-err text-white"
                  : "border border-err/40 bg-err/5 text-err"
              )}
            >
              <AlertTriangle size={14} />
              {overdue.data.total} Overdue
            </button>
          ) : null
        }
      />

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <FilterPills
          value={region}
          onChange={(v) => { setRegion(v); setPage(1); }}
          options={[
            { value: "", label: "All Regions" },
            { value: "WEST", label: "West" },
            { value: "EAST", label: "East" },
            { value: "SG", label: "SG" },
          ]}
        />
        <FilterPills
          value={status}
          onChange={(v) => { setStatus(v); setPage(1); }}
          options={[
            { value: "", label: "All" },
            { value: "do_ready", label: "DO Ready" },
            { value: "pending_shipout", label: "Pending Shipout" },
            { value: "shipped,in_transit", label: "In Transit" },
            { value: "at_warehouse,out_for_delivery", label: "Last Mile" },
            { value: "delivered", label: "Delivered" },
            { value: "failed", label: "Failed" },
          ]}
        />
      </div>

      <DataTable
        tableId="delivery-tracking"
        search={{
          value: search,
          onChange: (v) => { setSearch(v); setPage(1); },
          placeholder: "Search doc no, customer…",
        }}
        columns={[
          {
            key: "doc_no",
            label: "Doc No",
            render: (r: DeliveryRecord) => <span className="font-mono font-bold">{r.doc_no}</span>,
          },
          {
            key: "debtor_name",
            label: "Customer",
            render: (r: DeliveryRecord) => (
              <span className="max-w-[180px] truncate block">{r.debtor_name || "—"}</span>
            ),
          },
          {
            key: "region",
            label: "Region",
            render: (r: DeliveryRecord) => (
              <span className="rounded-full bg-ink/10 px-2 py-0.5 text-[10px] font-semibold uppercase">
                {r.region}
              </span>
            ),
          },
          {
            key: "status",
            label: "Status",
            render: (r: DeliveryRecord) => (
              <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase", STATUS_COLORS[r.status])}>
                {STATUS_LABELS[r.status] || r.status}
              </span>
            ),
          },
          {
            key: "order_revenue",
            label: "Revenue",
            render: (r: DeliveryRecord) => <span className="font-mono">{formatCurrency(r.order_revenue)}</span>,
          },
          {
            key: "total_cost",
            label: "Cost",
            render: (r: DeliveryRecord) => (
              <span className={cn("font-mono", r.total_cost > r.budget_amount && r.total_cost > 0 ? "text-err font-semibold" : "")}>
                {r.total_cost > 0 ? formatCurrency(r.total_cost) : "—"}
              </span>
            ),
          },
          {
            key: "budget_amount",
            label: "Budget",
            render: (r: DeliveryRecord) => <span className="font-mono text-ink-secondary">{formatCurrency(r.budget_amount)}</span>,
          },
          {
            key: "est_delivery_date",
            label: "Est. Delivery",
            render: (r: DeliveryRecord) => {
              if (!r.est_delivery_date) return "—";
              const isOverdue = r.est_delivery_date < new Date().toISOString().slice(0, 10) && r.status !== "delivered";
              return (
                <span className={isOverdue ? "font-semibold text-err" : ""}>{formatDate(r.est_delivery_date)}</span>
              );
            },
          },
        ]}
        rows={rows}
        loading={list.loading}
        error={list.error}
        emptyLabel="No delivery records"
        getRowKey={(r: DeliveryRecord) => r.doc_no}
        onRowClick={(r: DeliveryRecord) => setSelected(r.doc_no)}
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

      <DeliveryPanel
        docNo={selected}
        onClose={() => setSelected(null)}
        onUpdated={() => { list.reload(); overdue.reload(); }}
      />
    </div>
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
    () => (docNo ? api.get(`/api/delivery/${docNo}`) : Promise.resolve(null as any)),
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
      onClose={() => { onClose(); setEditMode(false); setForm({}); }}
      title={docNo || ""}
      subtitle={d ? `${d.region} · ${STATUS_LABELS[d.status] || d.status}` : ""}
      width={520}
    >
      {d && (
        <>
          {/* Status pipeline visualization */}
          <PanelSection title="Pipeline">
            <StatusPipeline region={d.region} current={d.status} />
          </PanelSection>

          {/* Advance actions */}
          {d.next_statuses.length > 0 && (
            <PanelSection title="Next Step">
              {/* Optional fields depending on the next status */}
              {d.next_statuses.includes("pending_shipout") && (
                <label className="block mb-2">
                  <span className="text-[9px] font-semibold uppercase tracking-brand text-ink-secondary">Shipout Date</span>
                  <input type="date" value={form.shipout_date || ""} onChange={(e) => setForm({ ...form, shipout_date: e.target.value })}
                    className="w-full rounded border border-border bg-paper px-2 py-1.5 text-[12px]" />
                </label>
              )}
              {d.next_statuses.includes("in_transit") && (
                <label className="block mb-2">
                  <span className="text-[9px] font-semibold uppercase tracking-brand text-ink-secondary">Est. Arrival at Warehouse</span>
                  <input type="date" value={form.est_arrival_date || ""} onChange={(e) => setForm({ ...form, est_arrival_date: e.target.value })}
                    className="w-full rounded border border-border bg-paper px-2 py-1.5 text-[12px]" />
                </label>
              )}
              {d.next_statuses.includes("out_for_delivery") && (
                <label className="block mb-2">
                  <span className="text-[9px] font-semibold uppercase tracking-brand text-ink-secondary">Est. Delivery Date</span>
                  <input type="date" value={form.est_delivery_date || ""} onChange={(e) => setForm({ ...form, est_delivery_date: e.target.value })}
                    className="w-full rounded border border-border bg-paper px-2 py-1.5 text-[12px]" />
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
                      ns === "failed" ? "bg-err/10 text-err border border-err/30"
                        : ns === "delivered" ? "bg-ok text-white"
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
            {d.inv_addr1 && <FieldRow label="Address">{[d.inv_addr1, d.inv_addr2, d.inv_addr3, d.inv_addr4].filter(Boolean).join(", ")}</FieldRow>}
          </PanelSection>

          {/* Milestones */}
          <PanelSection title="Milestones">
            <FieldRow label="DO Ready">{formatDate(d.do_ready_at)}</FieldRow>
            {d.region !== "WEST" && (
              <>
                <FieldRow label="Shipout Date">{formatDate(d.shipout_date)}</FieldRow>
                <FieldRow label="Pickup Confirmed">{formatDate(d.pickup_confirmed_at)}</FieldRow>
              </>
            )}
            {d.region === "EAST" && (
              <>
                <FieldRow label="Est. Arrival">{formatDate(d.est_arrival_date)}</FieldRow>
                <FieldRow label="Arrived Warehouse">{formatDate(d.arrived_warehouse_at)}</FieldRow>
                <FieldRow label="EM Warehouse">{d.em_warehouse || "—"}</FieldRow>
              </>
            )}
            <FieldRow label="Est. Delivery">{formatDate(d.est_delivery_date)}</FieldRow>
            <FieldRow label="Out for Delivery">{formatDate(d.out_for_delivery_at)}</FieldRow>
            <FieldRow label="Delivered">{formatDate(d.delivered_at)}</FieldRow>
            {d.failed_at && (
              <>
                <FieldRow label="Failed">{formatDate(d.failed_at)}</FieldRow>
                <FieldRow label="Reason">{d.failure_reason || "—"}</FieldRow>
              </>
            )}
          </PanelSection>

          {/* Costing */}
          <PanelSection title="Costing">
            <FieldRow label="Revenue" mono>{formatCurrency(d.order_revenue)}</FieldRow>
            <FieldRow label={`Budget (${d.budget_pct}%)`} mono>{formatCurrency(d.budget_amount)}</FieldRow>
            <FieldRow label="Freight Cost" mono>{formatCurrency(d.freight_cost)}</FieldRow>
            <FieldRow label="Last Mile Cost" mono>{formatCurrency(d.last_mile_cost)}</FieldRow>
            <FieldRow label="Total Cost" mono>
              <span className={cn("font-bold", d.total_cost > d.budget_amount ? "text-err" : "text-ok")}>
                {formatCurrency(d.total_cost)}
              </span>
            </FieldRow>
            {d.customer_transport_fee > 0 && (
              <>
                <FieldRow label="Customer Charged" mono>{formatCurrency(d.customer_transport_fee)}</FieldRow>
                <FieldRow label="Fee vs Cost" mono>
                  <span className={cn("font-bold", d.customer_transport_fee >= d.total_cost ? "text-ok" : "text-err")}>
                    {formatCurrency(d.customer_transport_fee - d.total_cost)}
                  </span>
                </FieldRow>
              </>
            )}
            <FieldRow label="Method">{d.delivery_method}</FieldRow>
            {d.vendor_name && <FieldRow label="Vendor">{d.vendor_name}</FieldRow>}

            {!editMode ? (
              <button
                onClick={() => { setEditMode(true); setForm({ freight_cost: d.freight_cost, last_mile_cost: d.last_mile_cost, customer_transport_fee: d.customer_transport_fee }); }}
                className="mt-2 rounded-md border border-border bg-surface px-3 py-1.5 text-[11px] font-semibold text-ink"
              >
                Edit Costs
              </button>
            ) : (
              <div className="mt-2 space-y-2 rounded-md border border-accent/30 bg-accent/5 p-3">
                <CostField label="Freight Cost" value={form.freight_cost} onChange={(v) => setForm({ ...form, freight_cost: v })} />
                <CostField label="Last Mile Cost" value={form.last_mile_cost} onChange={(v) => setForm({ ...form, last_mile_cost: v })} />
                <CostField label="Customer Transport Fee" value={form.customer_transport_fee} onChange={(v) => setForm({ ...form, customer_transport_fee: v })} />
                <div className="flex gap-2">
                  <button onClick={() => { setEditMode(false); setForm({}); }} className="rounded-md border border-border bg-surface px-3 py-1.5 text-[11px] font-semibold text-ink">Cancel</button>
                  <button disabled={busy} onClick={saveFields} className="rounded-md bg-accent px-3 py-1.5 text-[11px] font-bold text-white disabled:opacity-50">{busy ? "Saving…" : "Save"}</button>
                </div>
              </div>
            )}
          </PanelSection>

          {/* Status log */}
          {d.log.length > 0 && (
            <PanelSection title="History">
              <div className="space-y-1">
                {d.log.map((l, i) => (
                  <div key={i} className="flex items-start gap-2 text-[11px]">
                    <span className="shrink-0 text-ink-secondary">{formatDate(l.created_at)}</span>
                    <span>
                      {l.from_status && (
                        <span className="text-ink-secondary">{STATUS_LABELS[l.from_status] || l.from_status} → </span>
                      )}
                      <span className="font-semibold text-ink">{STATUS_LABELS[l.to_status] || l.to_status}</span>
                      {l.changed_by_name && <span className="text-ink-secondary"> by {l.changed_by_name}</span>}
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

// ── Status pipeline visualization ─────────────────────────────────

const PIPELINES: Record<string, string[]> = {
  WEST: ["do_ready", "out_for_delivery", "delivered"],
  SG: ["do_ready", "pending_shipout", "shipped", "delivered"],
  EAST: ["do_ready", "pending_shipout", "shipped", "in_transit", "at_warehouse", "out_for_delivery", "delivered"],
};

function StatusPipeline({ region, current }: { region: string; current: string }) {
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
            {i > 0 && <div className={cn("h-px w-3", isDone || isCurrent ? "bg-accent" : "bg-border")} />}
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

// ── Cost edit field ───────────────────────────────────────────────

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
      <span className="mb-0.5 block text-[9px] font-semibold uppercase tracking-brand text-ink-secondary">{label}</span>
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
