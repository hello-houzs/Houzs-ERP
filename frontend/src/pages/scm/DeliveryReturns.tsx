import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import { PageHeader } from "../../components/Layout";
import { Button } from "../../components/Button";
import { DataTable, type Column } from "../../components/DataTable";
import { useQuery } from "../../hooks/useQuery";
import { api, buildQuery } from "../../api/client";
import { SCM, fmtCenti, scmStatusClasses } from "../../lib/scm";
import { formatDate } from "../../lib/utils";
import { cn } from "../../lib/utils";

// Response shape from GET /api/scm/delivery-returns — snake_case, verbatim from
// the Hono route (backend/src/scm/routes/delivery-returns.ts). A Delivery
// Return is goods a customer sends back from a Delivery Order; the header is a
// DO-clone, so it carries the debtor (customer) + source DO ref + per-category
// rollups. local_total_centi is the returned value (mirrored into refund_centi).
export interface DeliveryReturnRow {
  id: string;
  return_number: string;
  do_doc_no: string | null;
  delivery_order_id: string | null;
  status: string;
  return_date: string | null;
  debtor_code: string | null;
  debtor_name: string;
  reason: string | null;
  sales_location: string | null;
  ref: string | null;
  customer_so_no: string | null;
  refund_centi: number | null;
  local_total_centi: number | null;
  line_count: number | null;
  currency: string | null;
}

// delivery_return status enum: a return is RECEIVED the moment it's created
// (stock is increased then), so the everyday statuses are Received / Refunded /
// Cancelled. The rest of the enum still renders verbatim when present.
const STATUS_LABEL: Record<string, string> = {
  PENDING: "Pending",
  RECEIVED: "Received",
  INSPECTED: "Inspected",
  REFUNDED: "Refunded",
  CREDIT_NOTED: "Credit Noted",
  REJECTED: "Rejected",
  CANCELLED: "Cancelled",
};
const STATUS_TABS = ["all", "RECEIVED", "REFUNDED", "CANCELLED"] as const;
type StatusTab = (typeof STATUS_TABS)[number];

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

export function ScmDeliveryReturns() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<StatusTab>("all");
  const [search, setSearch] = useState("");

  const list = useQuery<{ deliveryReturns: DeliveryReturnRow[] }>(
    () =>
      api.get(
        `${SCM}/delivery-returns${buildQuery({
          status: status === "all" ? undefined : status,
        })}`,
      ),
    [status],
  );

  // The list endpoint has no `search` param, so filter client-side across the
  // searchable text columns (return no, customer, source DO, reason).
  const all = list.data?.deliveryReturns ?? null;
  const q = search.trim().toLowerCase();
  const rows =
    all && q
      ? all.filter((r) =>
          [
            r.return_number,
            r.debtor_name,
            r.debtor_code,
            r.do_doc_no,
            r.reason,
            r.customer_so_no ?? r.ref,
          ]
            .filter(Boolean)
            .some((v) => String(v).toLowerCase().includes(q)),
        )
      : all;

  const columns: Column<DeliveryReturnRow>[] = [
    {
      key: "return_number",
      label: "Return No.",
      render: (r) => (
        <span className="font-mono text-[12px] font-semibold text-ink">{r.return_number}</span>
      ),
      getValue: (r) => r.return_number,
    },
    {
      key: "debtor",
      label: "Customer",
      render: (r) => (
        <span className="font-medium text-ink">{r.debtor_name || r.debtor_code || "—"}</span>
      ),
      getValue: (r) => r.debtor_name || r.debtor_code || "",
    },
    {
      key: "do",
      label: "From DO",
      render: (r) =>
        r.do_doc_no ? <span className="font-mono text-[12px]">{r.do_doc_no}</span> : "—",
      getValue: (r) => r.do_doc_no ?? "",
    },
    {
      key: "reason",
      label: "Reason",
      render: (r) => r.reason || "—",
      getValue: (r) => r.reason ?? "",
    },
    {
      key: "return_date",
      label: "Return Date",
      render: (r) => (r.return_date ? formatDate(r.return_date) : "—"),
      getValue: (r) => r.return_date ?? "",
    },
    {
      key: "lines",
      label: "Lines",
      align: "right",
      render: (r) => r.line_count ?? 0,
      getValue: (r) => r.line_count ?? 0,
    },
    {
      key: "value",
      label: "Returned Value",
      align: "right",
      render: (r) => (
        <span className="font-mono">
          {fmtCenti(r.local_total_centi ?? r.refund_centi, r.currency ?? "MYR")}
        </span>
      ),
      getValue: (r) => r.local_total_centi ?? r.refund_centi ?? 0,
    },
    {
      key: "status",
      label: "Status",
      render: (r) => <StatusPill status={r.status} />,
      getValue: (r) => r.status,
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Supply Chain"
        title="Delivery Returns"
        description="Goods a customer sends back from a delivery — restocks inventory and re-opens the sales order."
        primaryAction={
          <Button icon={<Plus size={15} />} onClick={() => navigate("/scm/delivery-returns/new")}>
            New Return
          </Button>
        }
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
        tableId="scm_delivery_returns"
        columns={columns}
        rows={rows}
        loading={list.loading}
        error={list.error}
        getRowKey={(r) => r.id}
        onRowClick={(r) => navigate(`/scm/delivery-returns/${r.id}`)}
        getRowClassName={(r) =>
          r.status === "CANCELLED" || r.status === "REJECTED" ? "opacity-60" : undefined
        }
        search={{
          value: search,
          onChange: setSearch,
          placeholder: "Search return no, customer, DO, reason…",
        }}
        emptyLabel="No delivery returns found"
        exportName="delivery-returns"
      />
    </div>
  );
}
