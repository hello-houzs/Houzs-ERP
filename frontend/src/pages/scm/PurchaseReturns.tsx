import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "../../components/Layout";
import { DataTable, type Column } from "../../components/DataTable";
import { useQuery } from "../../hooks/useQuery";
import { api, buildQuery } from "../../api/client";
import { SCM, fmtCenti, scmStatusClasses } from "../../lib/scm";
import { formatDate } from "../../lib/utils";
import { cn } from "../../lib/utils";

// Response shape from GET /api/scm/purchase-returns — snake_case, verbatim from
// the Hono route (apps/api purchase-returns.ts). The list embeds supplier /
// purchase_order / grn as nested objects and carries the header refund_centi.
interface SupplierRef {
  id: string;
  code: string;
  name: string;
}
interface PoRef {
  id: string;
  po_number: string;
}
interface GrnRef {
  id: string;
  grn_number: string;
}

export interface PurchaseReturnRow {
  id: string;
  return_number: string;
  status: string;
  return_date: string | null;
  reason: string | null;
  refund_centi: number | null;
  credit_note_ref: string | null;
  supplier: SupplierRef | null;
  purchase_order: PoRef | null;
  grn: GrnRef | null;
}

// purchase_return_status enum: POSTED / COMPLETED / CANCELLED. POSTED reads as
// "Confirmed" — a return is confirmed the moment it exists (no DRAFT lifecycle).
const STATUS_LABEL: Record<string, string> = {
  POSTED: "Confirmed",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};
const STATUS_TABS = ["all", "POSTED", "COMPLETED", "CANCELLED"] as const;
type StatusTab = (typeof STATUS_TABS)[number];

function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-semibold",
        scmStatusClasses(status),
      )}
    >
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

export function ScmPurchaseReturns() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<StatusTab>("all");
  const [search, setSearch] = useState("");

  const list = useQuery<{ purchaseReturns: PurchaseReturnRow[] }>(
    () =>
      api.get(
        `${SCM}/purchase-returns${buildQuery({
          status: status === "all" ? undefined : status,
        })}`,
      ),
    [status],
  );

  // The list endpoint has no `search` param, so filter client-side across the
  // searchable text columns (return no, supplier, GRN).
  const all = list.data?.purchaseReturns ?? null;
  const q = search.trim().toLowerCase();
  const rows =
    all && q
      ? all.filter((r) =>
          [
            r.return_number,
            r.supplier?.name,
            r.supplier?.code,
            r.grn?.grn_number,
            r.purchase_order?.po_number,
          ]
            .filter(Boolean)
            .some((v) => String(v).toLowerCase().includes(q)),
        )
      : all;

  const columns: Column<PurchaseReturnRow>[] = [
    {
      key: "return_number",
      label: "Return No.",
      render: (r) => <span className="font-mono text-[12px] font-semibold text-ink">{r.return_number}</span>,
      getValue: (r) => r.return_number,
    },
    {
      key: "supplier",
      label: "Supplier",
      render: (r) => <span className="font-medium text-ink">{r.supplier?.name ?? r.supplier?.code ?? "—"}</span>,
      getValue: (r) => r.supplier?.name ?? r.supplier?.code ?? "",
    },
    {
      key: "grn",
      label: "From GRN",
      render: (r) => (r.grn?.grn_number ? <span className="font-mono text-[12px]">{r.grn.grn_number}</span> : "—"),
      getValue: (r) => r.grn?.grn_number ?? "",
    },
    {
      key: "po",
      label: "PO",
      render: (r) => (r.purchase_order?.po_number ? <span className="font-mono text-[12px]">{r.purchase_order.po_number}</span> : "—"),
      getValue: (r) => r.purchase_order?.po_number ?? "",
    },
    {
      key: "return_date",
      label: "Return Date",
      render: (r) => (r.return_date ? formatDate(r.return_date) : "—"),
      getValue: (r) => r.return_date ?? "",
    },
    {
      key: "refund",
      label: "Refund",
      align: "right",
      render: (r) => <span className="font-mono">{fmtCenti(r.refund_centi)}</span>,
      getValue: (r) => r.refund_centi ?? 0,
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
        title="Purchase Returns"
        description="Goods sent back to the supplier — closes the PO → GRN → return → credit-note loop."
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
        tableId="scm_purchase_returns"
        columns={columns}
        rows={rows}
        loading={list.loading}
        error={list.error}
        getRowKey={(r) => r.id}
        onRowClick={(r) => navigate(`/scm/purchase-returns/${r.id}`)}
        getRowClassName={(r) =>
          r.status === "COMPLETED" || r.status === "CANCELLED" ? "opacity-60" : undefined
        }
        search={{
          value: search,
          onChange: setSearch,
          placeholder: "Search return no, supplier, GRN…",
        }}
        emptyLabel="No purchase returns found"
        exportName="purchase-returns"
      />
    </div>
  );
}
