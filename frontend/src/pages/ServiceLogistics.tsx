import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Wrench, Search } from "lucide-react";
import { PageHeader } from "../components/Layout";
import { DataTable, type Column } from "../components/DataTable";
import { Pagination } from "../components/Pagination";
import { EmptyState } from "../components/EmptyState";
import { FilterPills } from "../components/FilterPills";
import { useQuery } from "../hooks/useQuery";
import { api, buildQuery } from "../api/client";
import { formatDate } from "../lib/utils";

/**
 * Service Logistics — third tab on the Logistics page (alongside Trips
 * and Fleet). Lists ASSR case pickups + deliveries with case context so
 * ops can see what's moving across all open service cases without
 * drilling into individual case detail pages.
 *
 * Backed by GET /api/assr/logistics/all (mig 081 era — new endpoint
 * added when TODO item 4 shipped). Row click navigates to the source
 * case detail.
 */

interface ServiceLogisticsRow {
  id: number;
  assr_id: number;
  type: "pickup" | "delivery";
  status: "pending" | "scheduled" | "completed" | "cancelled";
  scheduled_date: string | null;
  scheduled_time_range: string | null;
  notes: string | null;
  assigned_to_name: string | null;
  assr_no: string;
  customer_name: string | null;
  stage: string;
  priority: string;
}

interface ServiceLogisticsResponse {
  rows: ServiceLogisticsRow[];
  total: number;
  page: number;
  per_page: number;
}

const STATUS_PILLS = [
  { value: "", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "scheduled", label: "Scheduled" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
];

const TYPE_PILLS = [
  { value: "", label: "All types" },
  { value: "pickup", label: "Pickup" },
  { value: "delivery", label: "Delivery" },
];

export function ServiceLogistics() {
  const nav = useNavigate();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<string>("");
  const [type, setType] = useState<string>("");
  const [search, setSearch] = useState("");

  const list = useQuery<ServiceLogisticsResponse>(
    () =>
      api.get(
        "/api/assr/logistics/all" +
          buildQuery({ page, per_page: 50, status, type, search })
      ),
    [page, status, type, search]
  );

  const columns: Column<ServiceLogisticsRow>[] = useMemo(
    () => [
      {
        key: "assr_no",
        label: "Case",
        render: (r) => (
          <div className="flex flex-col">
            <span className="font-mono text-[11.5px] font-semibold text-accent">
              {r.assr_no}
            </span>
            <span className="text-[11px] text-ink-secondary">
              {r.customer_name || "—"}
            </span>
          </div>
        ),
      },
      {
        key: "type",
        label: "Type",
        render: (r) => (
          <span className="rounded-full border border-border bg-bg/40 px-2 py-0.5 text-[10.5px] font-semibold capitalize">
            {r.type}
          </span>
        ),
      },
      {
        key: "status",
        label: "Status",
        render: (r) => {
          const tone =
            r.status === "completed" ? "bg-synced/10 text-synced" :
            r.status === "scheduled" ? "bg-accent/10 text-accent" :
            r.status === "cancelled" ? "bg-ink-muted/10 text-ink-muted" :
            "bg-amber-500/10 text-amber-700";
          return (
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold capitalize ${tone}`}>
              {r.status}
            </span>
          );
        },
      },
      {
        key: "scheduled_date",
        label: "Scheduled",
        render: (r) =>
          r.scheduled_date ? (
            <span className="text-[11.5px]">
              {formatDate(r.scheduled_date)}
              {r.scheduled_time_range ? (
                <span className="ml-1 text-ink-muted">· {r.scheduled_time_range}</span>
              ) : null}
            </span>
          ) : (
            <span className="text-ink-muted">—</span>
          ),
      },
      {
        key: "assigned_to_name",
        label: "Assigned",
        render: (r) => r.assigned_to_name || <span className="text-ink-muted">—</span>,
      },
      {
        key: "notes",
        label: "Remark",
        render: (r) =>
          r.notes ? (
            <span className="line-clamp-2 max-w-[280px] text-[11.5px] text-ink-secondary">
              {r.notes}
            </span>
          ) : (
            <span className="text-ink-muted">—</span>
          ),
      },
    ],
    []
  );

  return (
    <div>
      <PageHeader
        eyebrow="Logistics · Service"
        title="Service Logistics"
        description="Pickups and deliveries across all open ASSR service cases. Click a row to open the source case."
      />

      <div className="mb-3 flex flex-wrap items-end gap-3">
        <FilterPills
          value={status}
          options={STATUS_PILLS}
          onChange={(v: string) => { setStatus(v); setPage(1); }}
        />
        <FilterPills
          value={type}
          options={TYPE_PILLS}
          onChange={(v: string) => { setType(v); setPage(1); }}
        />
        <div className="relative">
          <Search
            size={13}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-muted"
          />
          <input
            type="search"
            placeholder="Case no, customer, remark"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            className="h-9 w-[260px] rounded-md border border-border bg-surface pl-8 pr-3 text-[12px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
        </div>
      </div>

      {list.loading ? (
        <div className="rounded-md border border-border bg-surface p-8 text-center text-[12px] text-ink-muted">
          Loading…
        </div>
      ) : !list.data || list.data.rows.length === 0 ? (
        <EmptyState
          icon={<Wrench size={20} />}
          message="No service logistics rows for this filter."
        />
      ) : (
        <>
          <DataTable
            tableId="service-logistics"
            columns={columns}
            rows={list.data.rows}
            getRowKey={(r) => r.id}
            onRowClick={(r) => nav(`/assr/${r.assr_id}`)}
            resetFilters={{
              active: !!(search || status || type),
              onReset: () => {
                setSearch("");
                setStatus("");
                setType("");
                setPage(1);
              },
            }}
          />
          <div className="mt-4">
            <Pagination
              page={page}
              perPage={list.data.per_page}
              total={list.data.total}
              onPageChange={setPage}
            />
          </div>
        </>
      )}
    </div>
  );
}
