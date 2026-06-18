import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "../../components/Layout";
import { DataTable, type Column } from "../../components/DataTable";
import { useQuery } from "../../hooks/useQuery";
import { api, buildQuery } from "../../api/client";
import { SCM, fmtCenti, scmStatusClasses } from "../../lib/scm";
import { cn } from "../../lib/utils";
import {
  soStatusDisplay,
  soStatusLabel,
  type SoRow,
} from "./mfgSalesOrderShared";

// ── Status filter chips ────────────────────────────────────────────────
// The SO status enum (no DRAFT — SOs start at CONFIRMED). "all" is the
// escape hatch; the backend filters the list by ?status=<ENUM>.
const STATUS_TABS = [
  "all",
  "CONFIRMED",
  "IN_PRODUCTION",
  "READY_TO_SHIP",
  "SHIPPED",
  "DELIVERED",
  "INVOICED",
  "CLOSED",
  "ON_HOLD",
  "CANCELLED",
] as const;
type StatusTab = (typeof STATUS_TABS)[number];

const TAB_LABEL: Record<StatusTab, string> = {
  all: "All",
  CONFIRMED: "Confirmed",
  IN_PRODUCTION: "Proceed",
  READY_TO_SHIP: "Stock Ready",
  SHIPPED: "Arranged",
  DELIVERED: "Delivered",
  INVOICED: "Invoiced",
  CLOSED: "Closed",
  ON_HOLD: "On Hold",
  CANCELLED: "Cancelled",
};

// Compact date — "2026/04/21". Falls back to the raw string when unparseable.
function compactDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[1]}/${m[2]}/${m[3]}` : iso;
}

// Branding pill label — auto-derived from the SO's FIRST line item
// (the API hands back first_item_category + first_item_branding). Mirrors
// 2990's deriveBranding: SOFA → "Sofa", BEDFRAME → "Bedframe",
// MATTRESS → its own brand (fallback "Mattress"), accessory/other → blank.
function deriveBranding(r: SoRow): string {
  const cat = r.first_item_category;
  if (!cat) return "";
  if (cat === "SOFA") return "Sofa";
  if (cat === "BEDFRAME") return "Bedframe";
  if (cat === "MATTRESS") {
    const b = (r.first_item_branding ?? "").trim();
    return b || "Mattress";
  }
  return "";
}

// Live balance — view's balance_centi_live → stored balance_centi →
// (local_total − paid). Matches the backend's source-of-truth chain.
function liveBalance(r: SoRow): number {
  if (typeof r.balance_centi_live === "number") return r.balance_centi_live;
  if (typeof r.balance_centi === "number") return r.balance_centi;
  return (r.local_total_centi ?? 0) - (r.paid_centi ?? 0);
}

function StatusPill({ row }: { row: SoRow }) {
  const eff = soStatusDisplay(row.status, row.delivery_state, row.lifecycle_state);
  const label = eff.label ?? soStatusLabel(row.status);
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-semibold",
        scmStatusClasses(eff.classKey),
      )}
    >
      {label}
    </span>
  );
}

export function ScmMfgSalesOrders() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<StatusTab>("all");
  const [search, setSearch] = useState("");

  const list = useQuery<{ salesOrders: SoRow[] }>(
    () =>
      api.get(
        `${SCM}/mfg-sales-orders${buildQuery({
          status: status === "all" ? undefined : status,
        })}`,
      ),
    [status],
  );

  const rows = list.data?.salesOrders ?? null;

  const columns: Column<SoRow>[] = [
    {
      key: "doc_no",
      label: "Doc No",
      render: (r) => (
        <span className="font-mono text-[12px] font-semibold text-accent">{r.doc_no}</span>
      ),
      getValue: (r) => r.doc_no,
    },
    {
      key: "current_doc_no",
      label: "Current",
      render: (r) => (
        <span className="font-mono text-[12px] text-ink-secondary">
          {r.current_doc_no ?? r.doc_no}
        </span>
      ),
      getValue: (r) => r.current_doc_no ?? r.doc_no,
      defaultHidden: true,
    },
    {
      key: "so_date",
      label: "Date",
      render: (r) => compactDate(r.so_date),
      getValue: (r) => r.so_date ?? "",
    },
    {
      key: "debtor_name",
      label: "Customer",
      render: (r) => <span className="font-medium text-ink">{r.debtor_name || "—"}</span>,
      getValue: (r) => r.debtor_name || "",
    },
    {
      key: "branding",
      label: "Branding",
      render: (r) => deriveBranding(r) || "—",
      getValue: (r) => deriveBranding(r),
    },
    {
      key: "reference",
      label: "Reference",
      render: (r) => r.customer_so_no || r.po_doc_no || r.ref || "—",
      getValue: (r) => r.customer_so_no || r.po_doc_no || r.ref || "",
      defaultHidden: true,
    },
    {
      key: "venue",
      label: "Venue",
      render: (r) => r.venue || "—",
      getValue: (r) => r.venue || "",
      defaultHidden: true,
    },
    {
      key: "stock_remark",
      label: "Stock Status",
      render: (r) => {
        const remark = (r.stock_remark ?? "").trim();
        if (!remark) return <span className="text-ink-muted">—</span>;
        const cls =
          remark === "READY"
            ? "bg-synced/15 text-synced border-synced/30"
            : remark === "READY (PARTIAL)"
              ? "bg-warning-bg text-warning-text border-warning-text/30"
              : "bg-surface-dim text-ink-muted border-border";
        return (
          <span
            className={cn(
              "inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-semibold",
              cls,
            )}
          >
            {remark}
          </span>
        );
      },
      getValue: (r) => r.stock_remark ?? "",
    },
    {
      key: "payment_methods_summary",
      label: "Payment",
      render: (r) => r.payment_methods_summary || r.payment_method || "—",
      getValue: (r) => r.payment_methods_summary || r.payment_method || "",
      defaultHidden: true,
    },
    {
      key: "local_total_centi",
      label: "Local Total",
      align: "right",
      render: (r) => (
        <span className="font-mono font-semibold text-ink">
          {fmtCenti(r.local_total_centi, r.currency)}
        </span>
      ),
      getValue: (r) => r.local_total_centi ?? 0,
    },
    {
      key: "balance",
      label: "Balance",
      align: "right",
      render: (r) => {
        const bal = liveBalance(r);
        return (
          <span className={cn("font-mono", bal > 0 ? "text-err" : "text-synced")}>
            {fmtCenti(bal, r.currency)}
          </span>
        );
      },
      getValue: (r) => liveBalance(r),
    },
    {
      key: "status",
      label: "Status",
      render: (r) => <StatusPill row={r} />,
      getValue: (r) => r.status,
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Supply Chain"
        title="Manufacturing Sales Orders"
        description="Customer sales orders — sofa / bedframe / mattress build lines, payments, and delivery progress."
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
        tableId="scm_mfg_sales_orders"
        columns={columns}
        rows={rows}
        loading={list.loading}
        error={list.error}
        getRowKey={(r) => r.doc_no}
        getRowClassName={(r) =>
          r.status === "CANCELLED" ? "opacity-60" : undefined
        }
        onRowClick={(r) => navigate(`/scm/sales-orders/${encodeURIComponent(r.doc_no)}`)}
        search={{
          value: search,
          onChange: setSearch,
          placeholder: "Search doc no, customer…",
        }}
        emptyLabel="No sales orders found"
        exportName="mfg-sales-orders"
      />
    </div>
  );
}
