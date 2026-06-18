import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { PageHeader } from "../../components/Layout";
import { DataTable, type Column } from "../../components/DataTable";
import { useQuery } from "../../hooks/useQuery";
import { api, buildQuery } from "../../api/client";
import { SCM, scmStatusClasses } from "../../lib/scm";
import { cn } from "../../lib/utils";

// Response shape from GET /api/scm/stock-transfers — snake_case, verbatim from
// the Hono route (backend/src/scm/routes/stock-transfers.ts `stockTransfers.get('/')`).
// Each row embeds the from/to warehouse joins and a computed line_count. A
// stock transfer moves SKU qty between two warehouses; it carries no money.
export interface StockTransferRow {
  id: string;
  transfer_no: string;
  status: string;
  from_warehouse_id: string;
  to_warehouse_id: string;
  transfer_date: string | null;
  notes: string | null;
  posted_at: string | null;
  cancelled_at: string | null;
  created_at: string | null;
  created_by: string | null;
  from_warehouse: { id: string; code: string; name: string } | null;
  to_warehouse: { id: string; code: string; name: string } | null;
  line_count: number;
}

// stock_transfer status enum is POSTED / CANCELLED (DRAFT was removed upstream).
// Transfers post on create. `all` is the unfiltered view.
const STATUS_TABS = ["all", "POSTED", "CANCELLED"] as const;
type StatusTab = (typeof STATUS_TABS)[number];

const STATUS_LABEL: Record<string, string> = {
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

function whCode(w: { code: string; name: string } | null): string {
  return w?.code || w?.name || "—";
}

export function ScmStockTransfers() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<StatusTab>("all");
  const [search, setSearch] = useState("");

  const list = useQuery<{ transfers: StockTransferRow[] }>(
    () =>
      api.get(
        `${SCM}/stock-transfers${buildQuery({
          status: status === "all" ? undefined : status,
        })}`,
      ),
    [status],
  );

  // The backend list endpoint filters by status / warehouse / date (no
  // server-side text search), so the search box filters the loaded rows here —
  // mirrors GoodsReceived.
  const all = list.data?.transfers ?? null;
  const q = search.trim().toLowerCase();
  const rows =
    all && q
      ? all.filter((t) =>
          [
            t.transfer_no,
            whCode(t.from_warehouse),
            whCode(t.to_warehouse),
            t.from_warehouse?.name,
            t.to_warehouse?.name,
          ]
            .filter(Boolean)
            .some((v) => String(v).toLowerCase().includes(q)),
        )
      : all;

  const columns: Column<StockTransferRow>[] = [
    {
      key: "transfer_no",
      label: "ST No.",
      render: (t) => <span className="font-mono text-[12px] font-semibold text-ink">{t.transfer_no}</span>,
      getValue: (t) => t.transfer_no,
    },
    {
      key: "transfer_date",
      label: "Date",
      render: (t) => fmtDate(t.transfer_date),
      getValue: (t) => t.transfer_date || "",
    },
    {
      key: "from_to",
      label: "From → To",
      render: (t) => (
        <span className="inline-flex items-center gap-1.5">
          <span className="font-medium text-ink">{whCode(t.from_warehouse)}</span>
          <ArrowRight size={12} className="text-ink-muted" />
          <span className="font-medium text-ink">{whCode(t.to_warehouse)}</span>
        </span>
      ),
      getValue: (t) => `${whCode(t.from_warehouse)} ${whCode(t.to_warehouse)}`,
    },
    {
      key: "line_count",
      label: "Lines",
      align: "right",
      render: (t) => t.line_count ?? 0,
      getValue: (t) => t.line_count ?? 0,
    },
    {
      key: "status",
      label: "Status",
      render: (t) => <StatusPill status={t.status} />,
      getValue: (t) => t.status,
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Supply Chain"
        title="Stock Transfers"
        description="Move stock between warehouses — a paired out/in movement per posted transfer."
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
      </div>

      <DataTable
        tableId="scm_stock_transfers"
        columns={columns}
        rows={rows}
        loading={list.loading}
        error={list.error}
        getRowKey={(t) => t.id}
        onRowClick={(t) => navigate(`/scm/stock-transfers/${t.id}`)}
        getRowClassName={(t) => (t.status === "CANCELLED" ? "opacity-60" : undefined)}
        search={{
          value: search,
          onChange: setSearch,
          placeholder: "Search ST no., warehouse…",
        }}
        emptyLabel="No stock transfers found"
        exportName="stock-transfers"
      />
    </div>
  );
}
