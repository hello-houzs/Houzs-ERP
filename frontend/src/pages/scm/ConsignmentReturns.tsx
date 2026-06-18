import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "../../components/Layout";
import { DataTable, type Column } from "../../components/DataTable";
import { useQuery } from "../../hooks/useQuery";
import { api, buildQuery } from "../../api/client";
import { SCM, fmtCenti, scmStatusClasses } from "../../lib/scm";
import { cn } from "../../lib/utils";

// Response shape from GET /api/scm/consignment-returns — snake_case, verbatim
// from the Hono route (consignment-returns.ts). It returns the
// consignment_delivery_returns header set. A return books unsold consignment
// goods back IN — it may reference a Consignment Note or be free-entry.
export interface CrRow {
  id: string;
  return_number: string;
  do_doc_no: string | null;
  consignment_do_id: string | null;
  return_date: string | null;
  reason: string | null;
  debtor_code: string | null;
  debtor_name: string;
  agent: string | null;
  sales_location: string | null;
  ref: string | null;
  customer_so_no: string | null;
  branding: string | null;
  venue: string | null;
  phone: string | null;
  currency: string;
  status: string;
  line_count: number | null;
  local_total_centi: number;
  refund_centi: number | null;
  total_cost_centi: number | null;
  total_margin_centi: number | null;
}

// consignment_delivery_returns.status — a return is RECEIVED on create (goods
// are physically back) and may move on to inspected / refunded / credit-noted.
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

export function ScmConsignmentReturns() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<StatusTab>("all");
  const [search, setSearch] = useState("");

  // The list endpoint filters by a single `status` query param server-side and
  // has no text-search param — so filter the searchable text columns client-side.
  const list = useQuery<{ deliveryReturns: CrRow[] }>(
    () =>
      api.get(
        `${SCM}/consignment-returns${buildQuery({
          status: status === "all" ? undefined : status,
        })}`,
      ),
    [status],
  );

  const rows = useMemo(() => {
    const all = list.data?.deliveryReturns ?? null;
    if (!all) return all;
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter((r) =>
      [r.return_number, r.do_doc_no, r.debtor_name, r.debtor_code, r.agent, r.venue, r.reason]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q)),
    );
  }, [list.data, search]);

  const columns: Column<CrRow>[] = [
    {
      key: "return_number",
      label: "Return No.",
      render: (r) => <span className="font-mono text-[12px] font-semibold text-accent">{r.return_number}</span>,
      getValue: (r) => r.return_number,
    },
    {
      key: "return_date",
      label: "Date",
      render: (r) => fmtDate(r.return_date),
      getValue: (r) => r.return_date ?? "",
    },
    {
      key: "debtor_name",
      label: "Consignee",
      render: (r) => <span className="font-medium text-ink">{r.debtor_name}</span>,
      getValue: (r) => r.debtor_name,
    },
    {
      key: "do_doc_no",
      label: "From Note",
      render: (r) =>
        r.do_doc_no ? <span className="font-mono text-[12px]">{r.do_doc_no}</span> : "—",
      getValue: (r) => r.do_doc_no ?? "",
    },
    {
      key: "reason",
      label: "Reason",
      render: (r) => r.reason || "—",
      getValue: (r) => r.reason || "",
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
      key: "refund_centi",
      label: "Refund",
      align: "right",
      render: (r) => (
        <span className="font-mono font-semibold text-ink">
          {fmtCenti(r.refund_centi ?? r.local_total_centi, r.currency || "MYR")}
        </span>
      ),
      getValue: (r) => r.refund_centi ?? r.local_total_centi ?? 0,
    },
    {
      key: "agent",
      label: "Agent",
      defaultHidden: true,
      render: (r) => r.agent || "—",
      getValue: (r) => r.agent || "",
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
        title="Consignment Returns"
        description="Unsold consignment goods coming back from the consignee — books stock back into the warehouse."
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
        tableId="scm_consignment_returns"
        columns={columns}
        rows={rows}
        loading={list.loading}
        error={list.error}
        getRowKey={(r) => r.id}
        onRowClick={(r) => navigate(`/scm/consignment-returns/${r.id}`)}
        getRowClassName={(r) =>
          r.status === "CANCELLED" || r.status === "REJECTED" ? "opacity-50" : undefined
        }
        search={{
          value: search,
          onChange: setSearch,
          placeholder: "Search return no, consignee, note, reason…",
        }}
        emptyLabel="No consignment returns found"
        exportName="consignment-returns"
      />
    </div>
  );
}
