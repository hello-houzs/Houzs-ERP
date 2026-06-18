import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "../../components/Layout";
import { DataTable, type Column } from "../../components/DataTable";
import { useQuery } from "../../hooks/useQuery";
import { api, buildQuery } from "../../api/client";
import { SCM, fmtCenti, scmStatusClasses } from "../../lib/scm";
import { cn } from "../../lib/utils";

// Response shape from GET /api/scm/consignment-orders — snake_case, verbatim
// from the Hono route (consignment-orders.ts). The list query stamps per-CO
// item_categories, first_item_branding, payment_methods_summary and has_children
// (any non-cancelled Consignment Note references it → downstream-locked).
export interface CoRow {
  doc_no: string;
  so_date: string | null;
  debtor_code: string | null;
  debtor_name: string;
  agent: string | null;
  sales_location: string | null;
  ref: string | null;
  venue: string | null;
  phone: string | null;
  currency: string;
  status: string;
  line_count: number | null;
  local_total_centi: number;
  total_revenue_centi: number | null;
  total_cost_centi: number | null;
  total_margin_centi: number | null;
  balance_centi: number | null;
  customer_delivery_date: string | null;
  internal_expected_dd: string | null;
  payment_methods_summary?: string;
  first_item_branding?: string | null;
  has_children?: boolean;
}

// consignment_sales_orders.status — a CO is CONFIRMED on insert (no DRAFT step),
// and the only other states are the closed/parked ones.
const STATUS_LABEL: Record<string, string> = {
  CONFIRMED: "Confirmed",
  CLOSED: "Closed",
  ON_HOLD: "On Hold",
  CANCELLED: "Cancelled",
};
const STATUS_TABS = ["all", "CONFIRMED", "CLOSED", "CANCELLED"] as const;
type StatusTab = (typeof STATUS_TABS)[number];

function fmtDate(d: string | null | undefined): string {
  if (!d) return "—";
  const ms = Date.parse(d.length <= 10 ? `${d}T00:00:00Z` : d);
  if (Number.isNaN(ms)) return d;
  return new Date(ms).toLocaleDateString("en-MY", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-semibold",
        scmStatusClasses(status),
      )}
    >
      {STATUS_LABEL[status] ?? status.replace(/_/g, " ")}
    </span>
  );
}

export function ScmConsignmentOrders() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<StatusTab>("all");
  const [search, setSearch] = useState("");

  // The list endpoint filters by a single `status` query param server-side and
  // has no text-search param — so filter the searchable text columns client-side.
  const list = useQuery<{ salesOrders: CoRow[] }>(
    () =>
      api.get(
        `${SCM}/consignment-orders${buildQuery({
          status: status === "all" ? undefined : status,
        })}`,
      ),
    [status],
  );

  const rows = useMemo(() => {
    const all = list.data?.salesOrders ?? null;
    if (!all) return all;
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter((r) =>
      [r.doc_no, r.debtor_name, r.debtor_code, r.agent, r.venue, r.ref, r.phone]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q)),
    );
  }, [list.data, search]);

  const columns: Column<CoRow>[] = [
    {
      key: "doc_no",
      label: "Doc No.",
      render: (r) => <span className="font-mono text-[12px] font-semibold text-accent">{r.doc_no}</span>,
      getValue: (r) => r.doc_no,
    },
    {
      key: "so_date",
      label: "Date",
      render: (r) => fmtDate(r.so_date),
      getValue: (r) => r.so_date ?? "",
    },
    {
      key: "debtor_name",
      label: "Consignee",
      render: (r) => <span className="font-medium text-ink">{r.debtor_name}</span>,
      getValue: (r) => r.debtor_name,
    },
    {
      key: "agent",
      label: "Agent",
      render: (r) => r.agent || "—",
      getValue: (r) => r.agent || "",
    },
    {
      key: "sales_location",
      label: "Location",
      render: (r) => r.sales_location || "—",
      getValue: (r) => r.sales_location || "",
    },
    {
      key: "venue",
      label: "Venue",
      render: (r) => r.venue || "—",
      getValue: (r) => r.venue || "",
    },
    {
      key: "line_count",
      label: "Lines",
      align: "right",
      render: (r) => r.line_count ?? 0,
      getValue: (r) => r.line_count ?? 0,
    },
    {
      key: "local_total_centi",
      label: "Total",
      align: "right",
      render: (r) => (
        <span className="font-mono font-semibold text-ink">
          {fmtCenti(r.local_total_centi, r.currency || "MYR")}
        </span>
      ),
      getValue: (r) => r.local_total_centi ?? 0,
    },
    {
      key: "balance_centi",
      label: "Balance",
      align: "right",
      defaultHidden: true,
      render: (r) => <span className="font-mono">{fmtCenti(r.balance_centi, r.currency || "MYR")}</span>,
      getValue: (r) => r.balance_centi ?? 0,
    },
    {
      key: "delivery_date",
      label: "Delivery",
      defaultHidden: true,
      render: (r) => fmtDate(r.customer_delivery_date),
      getValue: (r) => r.customer_delivery_date ?? "",
    },
    {
      key: "currency",
      label: "Curr.",
      defaultHidden: true,
      render: (r) => r.currency || "MYR",
      getValue: (r) => r.currency || "MYR",
    },
    {
      key: "status",
      label: "Status",
      render: (r) => <StatusPill status={r.status} />,
      getValue: (r) => STATUS_LABEL[r.status] ?? r.status,
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Supply Chain"
        title="Consignment Orders"
        description="Goods placed on consignment at a consignee — the start of the consign-out flow (order → note → return)."
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
            {s === "all" ? "All" : STATUS_LABEL[s] ?? s}
          </button>
        ))}
      </div>

      <DataTable
        tableId="scm_consignment_orders"
        columns={columns}
        rows={rows}
        loading={list.loading}
        error={list.error}
        getRowKey={(r) => r.doc_no}
        onRowClick={(r) => navigate(`/scm/consignment-orders/${encodeURIComponent(r.doc_no)}`)}
        getRowClassName={(r) => (r.status === "CANCELLED" ? "opacity-50" : undefined)}
        search={{
          value: search,
          onChange: setSearch,
          placeholder: "Search doc no, consignee, agent, venue…",
        }}
        emptyLabel="No consignment orders found"
        exportName="consignment-orders"
      />
    </div>
  );
}
