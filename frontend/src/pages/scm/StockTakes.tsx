import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "../../components/Layout";
import { DataTable, type Column } from "../../components/DataTable";
import { useQuery } from "../../hooks/useQuery";
import { api, buildQuery } from "../../api/client";
import { SCM, scmStatusClasses } from "../../lib/scm";
import { cn } from "../../lib/utils";

// Response shape from GET /api/scm/stock-takes — snake_case, verbatim from the
// Hono route (backend/src/scm/routes/stock-takes.ts `stockTakes.get('/')`). The
// list embeds the warehouse join and two cheap follow-up aggregates the route
// computes per take: line_count and variance_total (sum of counted-line
// variances).
export interface StockTakeRow {
  id: string;
  take_no: string;
  status: string;
  warehouse_id: string;
  scope_type: string;
  scope_value: string | null;
  take_date: string | null;
  notes: string | null;
  posted_at: string | null;
  cancelled_at: string | null;
  created_at: string | null;
  warehouse: { id: string; code: string; name: string } | null;
  line_count?: number;
  variance_total?: number;
}

interface WarehouseOption {
  id: string;
  code: string;
  name: string;
}

// stock_takes status is OPEN / POSTED / CANCELLED (see the route's VALID_STATUS).
const STATUS_TABS = ["all", "OPEN", "POSTED", "CANCELLED"] as const;
type StatusTab = (typeof STATUS_TABS)[number];

const STATUS_LABEL: Record<string, string> = {
  OPEN: "Open",
  POSTED: "Posted",
  CANCELLED: "Cancelled",
};

function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status.replace(/_/g, " ");
}

function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-semibold",
        scmStatusClasses(status),
      )}
    >
      {statusLabel(status)}
    </span>
  );
}

function fmtDate(value: string | null | undefined): string {
  if (!value) return "—";
  return value.slice(0, 10);
}

function scopeLabel(scopeType: string, scopeValue: string | null): string {
  if (scopeType === "ALL") return "All SKUs";
  if (scopeType === "CATEGORY") return `Category · ${scopeValue ?? "—"}`;
  if (scopeType === "CODE_PREFIX") return `Prefix · ${scopeValue ?? "—"}`;
  return scopeType;
}

// Signed variance with a leading sign; red when stock was lost (negative),
// green when found (positive), muted at zero. No new colour tokens — reuses
// the synced/err semantic tokens already in the palette.
function VarianceCell({ value }: { value: number }) {
  if (value === 0) return <span className="font-mono text-ink-muted">0</span>;
  return (
    <span className={cn("font-mono font-semibold", value > 0 ? "text-synced" : "text-err")}>
      {value > 0 ? "+" : ""}
      {value.toLocaleString("en-MY")}
    </span>
  );
}

export function ScmStockTakes() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<StatusTab>("all");
  const [warehouseId, setWarehouseId] = useState("");
  const [search, setSearch] = useState("");

  const list = useQuery<{ takes: StockTakeRow[] }>(
    () =>
      api.get(
        `${SCM}/stock-takes${buildQuery({
          status: status === "all" ? undefined : status,
          warehouseId: warehouseId || undefined,
        })}`,
      ),
    [status, warehouseId],
  );

  // Warehouse picker options (mirrors /inventory's pattern). Loaded once;
  // the filter narrows the server query by warehouse_id.
  const warehouses = useQuery<{ warehouses: WarehouseOption[] }>(
    () => api.get(`${SCM}/inventory/warehouses`),
    [],
  );
  const warehouseOptions = warehouses.data?.warehouses ?? [];

  // The backend list endpoint filters by status/warehouse/date only (no
  // server-side text search), so the search box filters loaded rows here.
  const all = list.data?.takes ?? null;
  const q = search.trim().toLowerCase();
  const rows =
    all && q
      ? all.filter((t) =>
          [
            t.take_no,
            t.warehouse?.code,
            t.warehouse?.name,
            scopeLabel(t.scope_type, t.scope_value),
          ]
            .filter(Boolean)
            .some((v) => String(v).toLowerCase().includes(q)),
        )
      : all;

  const columns: Column<StockTakeRow>[] = [
    {
      key: "take_no",
      label: "Stock Take No.",
      render: (t) => <span className="font-mono text-[12px] font-semibold text-ink">{t.take_no}</span>,
      getValue: (t) => t.take_no,
    },
    {
      key: "take_date",
      label: "Date",
      render: (t) => fmtDate(t.take_date),
      getValue: (t) => t.take_date || "",
    },
    {
      key: "warehouse",
      label: "Warehouse",
      render: (t) =>
        t.warehouse ? (
          <span>
            <span className="font-semibold text-ink">{t.warehouse.code}</span>
            <span className="ml-1.5 text-ink-muted">{t.warehouse.name}</span>
          </span>
        ) : (
          "—"
        ),
      getValue: (t) => (t.warehouse ? `${t.warehouse.code} ${t.warehouse.name}` : ""),
    },
    {
      key: "scope",
      label: "Scope",
      render: (t) => <span className="text-[12px]">{scopeLabel(t.scope_type, t.scope_value)}</span>,
      getValue: (t) => scopeLabel(t.scope_type, t.scope_value),
    },
    {
      key: "line_count",
      label: "Lines",
      align: "right",
      render: (t) => <span className="font-mono">{(t.line_count ?? 0).toLocaleString("en-MY")}</span>,
      getValue: (t) => t.line_count ?? 0,
    },
    {
      key: "variance_total",
      label: "Variance Total",
      align: "right",
      render: (t) => <VarianceCell value={t.variance_total ?? 0} />,
      getValue: (t) => t.variance_total ?? 0,
    },
    {
      key: "status",
      label: "Status",
      render: (t) => <StatusPill status={t.status} />,
      getValue: (t) => t.status,
    },
  ];

  const filtersActive = status !== "all" || warehouseId !== "" || search.trim() !== "";

  return (
    <div>
      <PageHeader
        eyebrow="Supply Chain"
        title="Stock Takes"
        description="AutoCount-style cycle counts — snapshot system qty, count, post variance adjustments."
      />

      {/* Status filter chips */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {STATUS_TABS.map((s) => (
          <button
            key={s}
            onClick={() => setStatus(s)}
            className={cn(
              "rounded-md border px-3 py-1 text-[12px] font-semibold transition-colors",
              status === s
                ? "border-accent bg-accent-soft text-accent"
                : "border-border bg-surface text-ink-secondary hover:border-accent/40 hover:text-accent",
            )}
          >
            {s === "all" ? "All" : statusLabel(s)}
          </button>
        ))}

        {/* Warehouse filter — narrows the server query. */}
        <select
          value={warehouseId}
          onChange={(e) => setWarehouseId(e.target.value)}
          className="ml-1 h-8 rounded-md border border-border bg-surface px-2 text-[12px] text-ink-secondary outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20"
        >
          <option value="">Any warehouse</option>
          {warehouseOptions.map((w) => (
            <option key={w.id} value={w.id}>
              {w.code} · {w.name}
            </option>
          ))}
        </select>
      </div>

      <DataTable
        tableId="scm_stock_takes"
        columns={columns}
        rows={rows}
        loading={list.loading}
        error={list.error}
        getRowKey={(t) => t.id}
        onRowClick={(t) => navigate(`/scm/stock-takes/${t.id}`)}
        getRowClassName={(t) => (t.status === "CANCELLED" ? "opacity-60" : undefined)}
        search={{
          value: search,
          onChange: setSearch,
          placeholder: "Search take no., warehouse, scope…",
        }}
        resetFilters={{
          active: filtersActive,
          onReset: () => {
            setStatus("all");
            setWarehouseId("");
            setSearch("");
          },
        }}
        emptyLabel="No stock takes found"
        exportName="stock-takes"
      />
    </div>
  );
}
