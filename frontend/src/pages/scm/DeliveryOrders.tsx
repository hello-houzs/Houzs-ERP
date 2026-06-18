import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "../../components/Layout";
import { DataTable, type Column } from "../../components/DataTable";
import { useQuery } from "../../hooks/useQuery";
import { api, buildQuery } from "../../api/client";
import { SCM, fmtCenti, scmStatusClasses } from "../../lib/scm";
import { cn } from "../../lib/utils";

// Response shape from GET /api/scm/delivery-orders-mfg — snake_case, verbatim
// from the Hono route (backend/src/scm/routes/delivery-orders-mfg.ts
// `deliveryOrdersMfg.get('/')`). The list endpoint returns the HEADER columns
// plus the Tier-2 downstream-lock flag (has_children) and a document-driven
// lifecycle_state ('shipped' | 'invoiced' | 'returned'). Rows stay loosely
// typed where the upstream payload is wide; the fields below are the ones the
// list grid reads.
export interface DoRow {
  id: string;
  do_number: string;
  so_doc_no: string | null;
  do_date: string | null;
  expected_delivery_at: string | null;
  customer_delivery_date: string | null;
  debtor_code: string | null;
  debtor_name: string | null;
  customer_so_no: string | null;
  po_doc_no: string | null;
  ref: string | null;
  driver_name: string | null;
  vehicle: string | null;
  venue: string | null;
  branding: string | null;
  phone: string | null;
  email: string | null;
  sales_location: string | null;
  customer_state: string | null;
  line_count: number | null;
  local_total_centi: number | null;
  total_cost_centi: number | null;
  total_margin_centi: number | null;
  currency: string | null;
  status: string;
  has_children?: boolean;
  lifecycle_state?: "shipped" | "invoiced" | "returned";
}

// The stored DO `status` is the operational stage (LOADED → DISPATCHED →
// IN_TRANSIT → SIGNED → DELIVERED → INVOICED, plus CANCELLED). On top of that
// the list endpoint sends a document-driven `lifecycle_state` ("latest event
// wins"): a DO ships on creation (Shipped); a non-cancelled Sales Invoice or
// Delivery Return pointing back at it becomes the badge. CANCELLED (operator
// action) always wins. The effective key drives both the pill and the chips,
// mirroring 2990's doEffectiveKey.
const STATUS_TABS = ["all", "DISPATCHED", "INVOICED", "RETURNED", "CANCELLED"] as const;
type StatusTab = (typeof STATUS_TABS)[number];

const STATUS_LABEL: Record<string, string> = {
  DISPATCHED: "Shipped",
  INVOICED: "Invoiced",
  RETURNED: "Delivery Return",
  CANCELLED: "Cancelled",
};

function effectiveKey(status: string, lifecycle?: DoRow["lifecycle_state"]): string {
  if ((status ?? "").toUpperCase() === "CANCELLED") return "CANCELLED";
  if (lifecycle === "returned") return "RETURNED";
  if (lifecycle === "invoiced") return "INVOICED";
  return "DISPATCHED"; // shipped baseline
}

function statusLabel(key: string): string {
  return STATUS_LABEL[key] ?? key.replace(/_/g, " ");
}

function StatusPill({ status, lifecycle }: { status: string; lifecycle?: DoRow["lifecycle_state"] }) {
  const key = effectiveKey(status, lifecycle);
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-semibold",
        // CANCELLED / RETURNED reuse the negative vocabulary; the shipped /
        // invoiced baselines map to the synced (delivered) vocabulary.
        scmStatusClasses(key === "DISPATCHED" || key === "INVOICED" ? "DELIVERED" : key),
      )}
    >
      {statusLabel(key)}
    </span>
  );
}

function fmtDate(value: string | null | undefined): string {
  if (!value) return "—";
  return value.slice(0, 10);
}

export function ScmDeliveryOrders() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<StatusTab>("all");
  const [search, setSearch] = useState("");

  // The DO list endpoint filters by the raw stored `status` only; the chips key
  // off the derived effective state, so we don't pass `status` to the server —
  // we load the full set and filter the effective key client-side (same shape
  // the GRN list page uses for its client-side text search).
  const list = useQuery<{ deliveryOrders: DoRow[] }>(
    () => api.get(`${SCM}/delivery-orders-mfg${buildQuery({})}`),
    [],
  );

  const all = list.data?.deliveryOrders ?? null;
  const q = search.trim().toLowerCase();
  const rows =
    all
      ? all
          .filter((r) => status === "all" || effectiveKey(r.status, r.lifecycle_state) === status)
          .filter((r) =>
            !q
              ? true
              : [
                  r.do_number,
                  r.so_doc_no,
                  r.debtor_name,
                  r.debtor_code,
                  r.customer_so_no,
                  r.po_doc_no,
                  r.ref,
                  r.driver_name,
                  r.venue,
                ]
                  .filter(Boolean)
                  .some((v) => String(v).toLowerCase().includes(q)),
          )
      : null;

  const columns: Column<DoRow>[] = [
    {
      key: "do_number",
      label: "DO No.",
      render: (r) => <span className="font-mono text-[12px] font-semibold text-ink">{r.do_number}</span>,
      getValue: (r) => r.do_number,
    },
    {
      key: "so_doc_no",
      label: "Transfer From (SO)",
      render: (r) =>
        r.so_doc_no ? <span className="font-mono text-[12px]">{r.so_doc_no}</span> : "—",
      getValue: (r) => r.so_doc_no || "",
    },
    {
      key: "debtor_name",
      label: "Customer",
      render: (r) => <span className="font-medium text-ink">{r.debtor_name || r.debtor_code || "—"}</span>,
      getValue: (r) => r.debtor_name || r.debtor_code || "",
    },
    {
      key: "do_date",
      label: "Date",
      render: (r) => fmtDate(r.do_date),
      getValue: (r) => r.do_date || "",
    },
    {
      key: "expected_delivery_at",
      label: "Expected Delivery",
      render: (r) => fmtDate(r.expected_delivery_at),
      getValue: (r) => r.expected_delivery_at || "",
    },
    {
      key: "ref",
      label: "Reference",
      render: (r) => r.customer_so_no || r.po_doc_no || r.ref || "—",
      getValue: (r) => r.customer_so_no || r.po_doc_no || r.ref || "",
    },
    {
      key: "driver_name",
      label: "Driver",
      defaultHidden: true,
      render: (r) => r.driver_name || "—",
      getValue: (r) => r.driver_name || "",
    },
    {
      key: "venue",
      label: "Venue",
      defaultHidden: true,
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
      render: (r) => <span className="font-mono">{fmtCenti(r.local_total_centi, r.currency ?? "MYR")}</span>,
      getValue: (r) => r.local_total_centi ?? 0,
    },
    {
      key: "status",
      label: "Status",
      render: (r) => <StatusPill status={r.status} lifecycle={r.lifecycle_state} />,
      getValue: (r) => statusLabel(effectiveKey(r.status, r.lifecycle_state)),
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Supply Chain"
        title="Delivery Orders"
        description="Customer delivery orders — the SO → DO → Sales Invoice dispatch step."
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
        tableId="scm_delivery_orders"
        columns={columns}
        rows={rows}
        loading={list.loading}
        error={list.error}
        getRowKey={(r) => r.id}
        onRowClick={(r) => navigate(`/scm/delivery-orders/${r.id}`)}
        getRowClassName={(r) => (r.status === "CANCELLED" ? "opacity-60" : undefined)}
        search={{
          value: search,
          onChange: setSearch,
          placeholder: "Search DO no., SO, customer, driver…",
        }}
        emptyLabel="No delivery orders found"
        exportName="delivery-orders"
      />
    </div>
  );
}
