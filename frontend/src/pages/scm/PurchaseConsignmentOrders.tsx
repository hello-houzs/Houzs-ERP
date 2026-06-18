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

// Response shape from GET /api/scm/purchase-consignment-orders — snake_case,
// verbatim from backend/src/scm/routes/purchase-consignment-orders.ts. The list
// query embeds a tiny supplier + an items summary (material_code/name/qty) per
// row, and stamps has_children (any non-cancelled PC Receive exists) so locked
// PC Orders can hide Edit/Cancel downstream. NOTE: the PC Order's own number
// column is pc_number (PCO-YYMM-NNN), not po_number.
interface PcoSupplierLite {
  id: string;
  code: string;
  name: string;
}

interface PcoItemLite {
  material_code: string;
  material_name: string;
  qty: number;
}

export interface PcoHeaderRow {
  id: string;
  pc_number: string;
  supplier_id: string;
  status: string;
  po_date: string | null;
  expected_at: string | null;
  currency: string;
  subtotal_centi: number;
  tax_centi: number;
  total_centi: number;
  notes: string | null;
  purchase_location_id: string | null;
  has_children?: boolean;
  supplier: PcoSupplierLite | null;
  items: PcoItemLite[] | null;
}

// Mirrors the PO list: the 95% view is "what still has goods inbound"
// (Outstanding = SUBMITTED ∪ PARTIALLY_RECEIVED), with explicit chips for the
// closed states and All as the escape hatch. The backend list endpoint filters
// by a single status; "outstanding" is resolved client-side.
const STATUS_TABS = [
  "outstanding",
  "SUBMITTED",
  "PARTIALLY_RECEIVED",
  "RECEIVED",
  "CANCELLED",
  "all",
] as const;
type StatusTab = (typeof STATUS_TABS)[number];

const TAB_LABEL: Record<StatusTab, string> = {
  outstanding: "Outstanding",
  SUBMITTED: "Submitted",
  PARTIALLY_RECEIVED: "Partially Received",
  RECEIVED: "Received",
  CANCELLED: "Cancelled",
  all: "All",
};

const STATUS_LABEL: Record<string, string> = {
  SUBMITTED: "Submitted",
  PARTIALLY_RECEIVED: "Partially Received",
  RECEIVED: "Received",
  CANCELLED: "Cancelled",
};

export function pcoStatusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status.replace(/_/g, " ");
}

export function PcoStatusPill({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-semibold",
        scmStatusClasses(status),
      )}
    >
      {pcoStatusLabel(status)}
    </span>
  );
}

export function fmtScmDate(d: string | null | undefined): string {
  if (!d) return "—";
  // ISO date / timestamp → "DD MMM YYYY"; keep raw on parse failure.
  const ms = Date.parse(d.length <= 10 ? `${d}T00:00:00Z` : d);
  if (Number.isNaN(ms)) return d;
  return new Date(ms).toLocaleDateString("en-MY", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

// First 3 items as `CODE×qty · CODE×qty · +N more`, AutoCount style.
function summarizeItems(items: PcoItemLite[] | null): string {
  if (!items || items.length === 0) return "—";
  const HEAD = 3;
  const shown = items
    .slice(0, HEAD)
    .map((it) => `${it.material_code}×${it.qty}`)
    .join(" · ");
  const extra = items.length - HEAD;
  return extra > 0 ? `${shown} · +${extra} more` : shown;
}

export function ScmPurchaseConsignmentOrders() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<StatusTab>("outstanding");
  const [search, setSearch] = useState("");

  const serverStatus =
    status === "all" || status === "outstanding" ? undefined : status;

  const list = useQuery<{ purchaseOrders: PcoHeaderRow[] }>(
    () =>
      api.get(
        `${SCM}/purchase-consignment-orders${buildQuery({ status: serverStatus })}`,
      ),
    [serverStatus],
  );

  const rows = useMemo(() => {
    const all = list.data?.purchaseOrders ?? null;
    if (!all) return all;
    if (status === "outstanding") {
      return all.filter(
        (r) => r.status === "SUBMITTED" || r.status === "PARTIALLY_RECEIVED",
      );
    }
    return all;
  }, [list.data, status]);

  const columns: Column<PcoHeaderRow>[] = [
    {
      key: "pc_number",
      label: "P/CO No.",
      render: (r) => (
        <span className="font-mono text-[12px] font-semibold text-accent">{r.pc_number}</span>
      ),
      getValue: (r) => r.pc_number,
    },
    {
      key: "supplier",
      label: "Supplier",
      render: (r) => (
        <span className="font-medium text-ink">
          {r.supplier?.name ?? r.supplier?.code ?? "—"}
        </span>
      ),
      getValue: (r) => r.supplier?.name ?? r.supplier?.code ?? "",
    },
    {
      key: "items",
      label: "Items",
      width: "320px",
      render: (r) => {
        const summary = summarizeItems(r.items);
        return (
          <span
            title={(r.items ?? []).map((it) => `${it.material_code} × ${it.qty}`).join("\n")}
            className={cn(
              "block truncate font-mono text-[11.5px]",
              summary === "—" ? "text-ink-muted" : "text-ink-secondary",
            )}
          >
            {summary}
          </span>
        );
      },
      getValue: (r) => (r.items ?? []).map((it) => `${it.material_code} ${it.qty}`).join(" "),
    },
    {
      key: "po_date",
      label: "Date",
      render: (r) => fmtScmDate(r.po_date),
      getValue: (r) => r.po_date ?? "",
    },
    {
      key: "expected_at",
      label: "Expected",
      render: (r) => fmtScmDate(r.expected_at),
      getValue: (r) => r.expected_at ?? "",
    },
    {
      key: "currency",
      label: "Curr.",
      render: (r) => r.currency || "MYR",
      getValue: (r) => r.currency || "MYR",
    },
    {
      key: "total_centi",
      label: "Total",
      align: "right",
      render: (r) => (
        <span className="font-mono font-semibold text-ink">
          {fmtCenti(r.total_centi, r.currency || "MYR")}
        </span>
      ),
      getValue: (r) => r.total_centi ?? 0,
    },
    {
      key: "status",
      label: "Status",
      render: (r) => <PcoStatusPill status={r.status} />,
      getValue: (r) => pcoStatusLabel(r.status),
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Supply Chain"
        title="Purchase Consignment Orders"
        description="Supplier places stock with us on consignment — the order step, before any receive."
        primaryAction={
          <Button icon={<Plus size={15} />} onClick={() => navigate("/scm/purchase-consignment-orders/new")}>
            New Order
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
            {TAB_LABEL[s]}
          </button>
        ))}
      </div>

      <DataTable
        tableId="scm_pc_orders"
        columns={columns}
        rows={rows}
        loading={list.loading}
        error={list.error}
        getRowKey={(r) => r.id}
        onRowClick={(r) => navigate(`/scm/purchase-consignment-orders/${r.id}`)}
        getRowClassName={(r) =>
          r.status === "CANCELLED" ? "opacity-50" : undefined
        }
        search={{
          value: search,
          onChange: setSearch,
          placeholder: "Search PC Order no, supplier, item…",
        }}
        emptyLabel="No purchase consignment orders found"
        exportName="purchase-consignment-orders"
      />
    </div>
  );
}
