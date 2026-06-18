import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import { PageHeader } from "../../components/Layout";
import { Button } from "../../components/Button";
import { DataTable, type Column } from "../../components/DataTable";
import { useQuery } from "../../hooks/useQuery";
import { api, buildQuery } from "../../api/client";
import { SCM, fmtCenti, scmStatusClasses } from "../../lib/scm";
import { cn } from "../../lib/utils";

// Response shape from GET /api/scm/consignment-notes — snake_case, verbatim from
// the Hono route (consignment-notes.ts). It returns the consignment_delivery_orders
// header set and stamps has_children (any non-cancelled Consignment Return → the
// note is downstream-locked). A note ships goods OUT to the consignee.
export interface CnRow {
  id: string;
  do_number: string;
  consignment_so_doc_no: string | null;
  do_date: string | null;
  expected_delivery_at: string | null;
  customer_delivery_date: string | null;
  debtor_code: string | null;
  debtor_name: string;
  agent: string | null;
  sales_location: string | null;
  ref: string | null;
  customer_so_no: string | null;
  branding: string | null;
  venue: string | null;
  phone: string | null;
  driver_name: string | null;
  vehicle: string | null;
  currency: string;
  status: string;
  line_count: number | null;
  local_total_centi: number;
  total_cost_centi: number | null;
  total_margin_centi: number | null;
  has_children?: boolean;
}

// consignment_delivery_orders.status — a note starts at DISPATCHED on create
// (goods are OUT the moment it exists) and flows through the shipped states.
const STATUS_LABEL: Record<string, string> = {
  LOADED: "Loaded",
  DISPATCHED: "Dispatched",
  IN_TRANSIT: "In Transit",
  SIGNED: "Signed",
  DELIVERED: "Delivered",
  INVOICED: "Invoiced",
  RETURNED: "Returned",
  CANCELLED: "Cancelled",
};
const STATUS_TABS = ["all", "DISPATCHED", "DELIVERED", "CANCELLED"] as const;
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

export function ScmConsignmentNotes() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<StatusTab>("all");
  const [search, setSearch] = useState("");

  // The list endpoint filters by a single `status` query param server-side and
  // has no text-search param — so filter the searchable text columns client-side.
  const list = useQuery<{ deliveryOrders: CnRow[] }>(
    () =>
      api.get(
        `${SCM}/consignment-notes${buildQuery({
          status: status === "all" ? undefined : status,
        })}`,
      ),
    [status],
  );

  const rows = useMemo(() => {
    const all = list.data?.deliveryOrders ?? null;
    if (!all) return all;
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter((r) =>
      [
        r.do_number,
        r.consignment_so_doc_no,
        r.debtor_name,
        r.debtor_code,
        r.agent,
        r.venue,
        r.driver_name,
      ]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q)),
    );
  }, [list.data, search]);

  const columns: Column<CnRow>[] = [
    {
      key: "do_number",
      label: "Note No.",
      render: (r) => <span className="font-mono text-[12px] font-semibold text-accent">{r.do_number}</span>,
      getValue: (r) => r.do_number,
    },
    {
      key: "do_date",
      label: "Date",
      render: (r) => fmtDate(r.do_date),
      getValue: (r) => r.do_date ?? "",
    },
    {
      key: "debtor_name",
      label: "Consignee",
      render: (r) => <span className="font-medium text-ink">{r.debtor_name}</span>,
      getValue: (r) => r.debtor_name,
    },
    {
      key: "consignment_so_doc_no",
      label: "From Order",
      render: (r) =>
        r.consignment_so_doc_no ? (
          <span className="font-mono text-[12px]">{r.consignment_so_doc_no}</span>
        ) : (
          "—"
        ),
      getValue: (r) => r.consignment_so_doc_no ?? "",
    },
    {
      key: "venue",
      label: "Venue",
      render: (r) => r.venue || "—",
      getValue: (r) => r.venue || "",
    },
    {
      key: "expected_delivery_at",
      label: "Expected",
      render: (r) => fmtDate(r.expected_delivery_at),
      getValue: (r) => r.expected_delivery_at ?? "",
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
      key: "driver_name",
      label: "Driver",
      defaultHidden: true,
      render: (r) => r.driver_name || "—",
      getValue: (r) => r.driver_name || "",
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
        title="Consignment Notes"
        description="Goods shipped out to the consignee against a consignment order — the sale-through leg of the flow."
        primaryAction={
          <Button icon={<Plus size={15} />} onClick={() => navigate("/scm/consignment-notes/new")}>
            New Note
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
        tableId="scm_consignment_notes"
        columns={columns}
        rows={rows}
        loading={list.loading}
        error={list.error}
        getRowKey={(r) => r.id}
        onRowClick={(r) => navigate(`/scm/consignment-notes/${r.id}`)}
        getRowClassName={(r) => (r.status === "CANCELLED" ? "opacity-50" : undefined)}
        search={{
          value: search,
          onChange: setSearch,
          placeholder: "Search note no, consignee, order, driver…",
        }}
        emptyLabel="No consignment notes found"
        exportName="consignment-notes"
      />
    </div>
  );
}
