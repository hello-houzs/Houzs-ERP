import { useMemo, useState } from "react";
import { Plus, MapPin } from "lucide-react";
import { StatCard } from "./StatCard";
import { DashboardGrid } from "./Dashboard";
import { DataTable, type Column } from "./DataTable";
import { Pagination } from "./Pagination";
import { useQuery } from "../hooks/useQuery";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { api, buildQuery } from "../api/client";
import { formatCurrency } from "../lib/utils";
import { getSalesOrderColumns } from "../lib/orderColumns";
import type {
  Paginated,
  SalesOrder,
  Warehouse,
  OrdersSummary,
} from "../types";

/**
 * Queue tab — orders waiting to be planned.
 *
 * Filtered to:
 *   - delivery orders (DELIVERY_WHERE)
 *   - NOT on any active trip
 *   - NOT on a current draft proposal
 *
 * The dispatcher multi-selects rows and clicks "Schedule selected" to
 * pop the parent's New Trip dialog with those orders pre-picked. They
 * can also rely on the planner (Drafts tab) to bundle the queue
 * automatically.
 */
export function QueueTab({
  onScheduleSelected,
}: {
  onScheduleSelected: (orders: SalesOrder[]) => void;
}) {
  const [warehouse, setWarehouse] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useLocalStorage<number>("pp:queue", 50);
  const [picked, setPicked] = useState<Record<string, SalesOrder>>({});

  const list = useQuery<Paginated<SalesOrder>>(
    () =>
      api.get(
        `/api/orders${buildQuery({
          view: "do",
          unscheduled: "true",
          warehouse,
          search,
          page,
          per_page: perPage,
        })}`
      ),
    [warehouse, search, page, perPage]
  );

  const summary = useQuery<OrdersSummary>(() => api.get("/api/orders/summary"));
  const warehouses = useQuery<{ data: Warehouse[] }>(() => api.get("/api/warehouses"));

  const rows = list.data?.data ?? [];
  const pickedList = useMemo(() => Object.values(picked), [picked]);
  const pickedTotal = pickedList.reduce((s, o) => s + (o.local_total || 0), 0);

  function toggle(o: SalesOrder) {
    setPicked((prev) => {
      const copy = { ...prev };
      if (copy[o.doc_no]) delete copy[o.doc_no];
      else copy[o.doc_no] = o;
      return copy;
    });
  }

  function toggleAll() {
    if (rows.every((r) => picked[r.doc_no])) {
      // Deselect everything currently visible
      setPicked((prev) => {
        const copy = { ...prev };
        for (const r of rows) delete copy[r.doc_no];
        return copy;
      });
    } else {
      setPicked((prev) => {
        const copy = { ...prev };
        for (const r of rows) copy[r.doc_no] = r;
        return copy;
      });
    }
  }

  function scheduleSelected() {
    if (!pickedList.length) return;
    onScheduleSelected(pickedList);
    setPicked({});
  }

  const allVisibleChecked = rows.length > 0 && rows.every((r) => picked[r.doc_no]);
  const d = summary.data?.delivery;

  // Reuse the shared sales-order column set so the chooser exposes
  // every AutoCount field — DocNo, TransferTo, DocDate, Branding,
  // DebtorName, SalesAgent, SalesLocation, Ref, Total, Balance,
  // Remark2/3/4, ProcessingDate (SOUDF_PDate), ExpiryDate, Note,
  // PO No, InvAddr1-4, Phone, Venue, Attention — plus a Warehouse
  // column we add for the planner workflow. The leading "_select"
  // column is alwaysVisible so the chooser can't hide the checkbox.
  const sharedColumns = useMemo(() => getSalesOrderColumns(), []);

  const columns: Column<SalesOrder>[] = useMemo(
    () => [
      {
        key: "_select",
        label: "",
        width: "32px",
        alwaysVisible: true,
        render: (r) => (
          <input
            type="checkbox"
            checked={!!picked[r.doc_no]}
            onClick={(e) => e.stopPropagation()}
            onChange={() => toggle(r)}
          />
        ),
      },
      // Warehouse column lives in the order_details join — added here
      // because it's specific to the trip workflow (Sales/Delivery
      // pages don't surface it yet). Planner-blocked rows show "—".
      {
        key: "warehouse",
        label: "Warehouse",
        render: (r) =>
          (r as any).warehouse ? (
            <span className="text-ink">
              <MapPin size={11} className="mr-1 inline" />
              {(r as any).warehouse}
            </span>
          ) : (
            <span className="text-warning-text">—</span>
          ),
        getValue: (r) => (r as any).warehouse || "",
      },
      ...sharedColumns,
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [picked, sharedColumns]
  );

  return (
    <div>
      <DashboardGrid cols={4}>
        <StatCard
          label="Queue total"
          value={list.data ? list.data.total.toLocaleString() : "—"}
          subtitle="Unscheduled delivery orders"
        />
        <StatCard
          label="Expiring 7 days"
          value={d ? d.expiring_7d.toLocaleString() : "—"}
          subtitle="Schedule soon"
          tone={d && d.expiring_7d > 0 ? "error" : "default"}
        />
        <StatCard
          label="Already expired"
          value={d ? d.expired.toLocaleString() : "—"}
          subtitle="Past deadline"
          tone={d && d.expired > 0 ? "error" : "default"}
        />
        <StatCard
          label="Outstanding"
          value={d ? formatCurrency(d.total_balance, { compact: true }) : "—"}
          subtitle={d ? `${d.outstanding_count.toLocaleString()} with balance` : " "}
        />
      </DashboardGrid>

      {/* Filter row + selection action */}
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-0.5">
          <span className="text-[9px] font-semibold uppercase tracking-brand text-ink-secondary">
            Warehouse
          </span>
          <select
            value={warehouse}
            onChange={(e) => {
              setPage(1);
              setWarehouse(e.target.value);
            }}
            className="rounded-md border border-border bg-surface px-2 py-1.5 text-[12px]"
          >
            <option value="">All</option>
            {warehouses.data?.data.map((w) => (
              <option key={w.code} value={w.code}>
                {w.code} · {w.name}
              </option>
            ))}
          </select>
        </label>

        <button
          onClick={toggleAll}
          disabled={rows.length === 0}
          className="rounded-md border border-border bg-surface px-3 py-1.5 text-[11px] font-semibold text-ink disabled:opacity-40"
        >
          {allVisibleChecked ? "Deselect visible" : "Select visible"}
        </button>

        {pickedList.length > 0 && (
          <div className="ml-auto flex items-center gap-2">
            <span className="text-[11px] text-ink-secondary">
              {pickedList.length} picked · {formatCurrency(pickedTotal)}
            </span>
            <button
              onClick={() => setPicked({})}
              className="rounded-md border border-border bg-surface px-3 py-2 text-[11px] font-semibold text-ink"
            >
              Clear
            </button>
            <button
              onClick={scheduleSelected}
              className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-2 text-[12px] font-bold uppercase tracking-wide text-white shadow-sm"
            >
              <Plus size={13} /> Schedule selected
            </button>
          </div>
        )}
      </div>

      {/* Table — uses the shared DataTable so dispatchers get the column
          chooser ("Columns" toolbar button), the Fields button for UDFs,
          density toggle, search, and CSV export for free. */}
      <DataTable
        tableId="trips-queue"
        udfTable="sales_orders"
        udfTableLabel="Sales Orders (shared)"
        exportName="trips-queue"
        search={{
          value: search,
          onChange: (v) => {
            setPage(1);
            setSearch(v);
          },
          placeholder: "Search doc no, customer, phone…",
        }}
        columns={columns}
        rows={list.data?.data ?? null}
        loading={list.loading}
        error={list.error}
        emptyLabel="Queue is empty — every delivery order has been planned."
        getRowKey={(r) => r.doc_no}
        getRowClassName={(r) => (picked[r.doc_no] ? "bg-accent/5" : "")}
        onRowClick={(r) => toggle(r)}
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
    </div>
  );
}
