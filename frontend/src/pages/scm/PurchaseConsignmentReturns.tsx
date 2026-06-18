import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "../../components/Layout";
import { DataTable, type Column } from "../../components/DataTable";
import { useQuery } from "../../hooks/useQuery";
import { api, buildQuery } from "../../api/client";
import { SCM, fmtCenti, scmStatusClasses } from "../../lib/scm";
import { cn } from "../../lib/utils";
import { fmtScmDate } from "./PurchaseConsignmentOrders";

// Response shape from GET /api/scm/purchase-consignment-returns — snake_case,
// verbatim from backend/src/scm/routes/purchase-consignment-returns.ts (the
// list endpoint is keyed `purchaseReturns` in the payload). It embeds the
// supplier, the parent PC Order (purchase_consignment_order: {id, pc_number}),
// and the parent PC Receive (pc_receive: {id, receive_number}). Money lives in
// refund_centi. Status enum is POSTED / COMPLETED / CANCELLED.
export interface PctRow {
  id: string;
  return_number: string;
  status: string;
  return_date: string | null;
  reason: string | null;
  credit_note_ref: string | null;
  refund_centi: number | null;
  supplier: { id: string; code: string; name: string } | null;
  purchase_consignment_order: { id: string; pc_number: string } | null;
  pc_receive: { id: string; receive_number: string } | null;
}

const STATUS_TABS = ["all", "POSTED", "COMPLETED", "CANCELLED"] as const;
type StatusTab = (typeof STATUS_TABS)[number];

const STATUS_LABEL: Record<string, string> = {
  POSTED: "Confirmed",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

export function pctStatusLabel(status: string): string {
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
      {pctStatusLabel(status)}
    </span>
  );
}

export function ScmPurchaseConsignmentReturns() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<StatusTab>("all");
  const [search, setSearch] = useState("");

  const list = useQuery<{ purchaseReturns: PctRow[] }>(
    () =>
      api.get(
        `${SCM}/purchase-consignment-returns${buildQuery({
          status: status === "all" ? undefined : status,
        })}`,
      ),
    [status],
  );

  // The backend return list only filters by status/supplierId (no server-side
  // text search), so the search box filters the loaded rows here.
  const all = list.data?.purchaseReturns ?? null;
  const q = search.trim().toLowerCase();
  const rows =
    all && q
      ? all.filter((r) =>
          [
            r.return_number,
            r.supplier?.name,
            r.supplier?.code,
            r.pc_receive?.receive_number,
            r.purchase_consignment_order?.pc_number,
            r.credit_note_ref,
          ]
            .filter(Boolean)
            .some((v) => String(v).toLowerCase().includes(q)),
        )
      : all;

  const columns: Column<PctRow>[] = [
    {
      key: "return_number",
      label: "Return No.",
      render: (r) => <span className="font-mono text-[12px] font-semibold text-accent">{r.return_number}</span>,
      getValue: (r) => r.return_number,
    },
    {
      key: "supplier",
      label: "Supplier",
      render: (r) => r.supplier?.name || r.supplier?.code || "—",
      getValue: (r) => r.supplier?.name || r.supplier?.code || "",
    },
    {
      key: "receive_number",
      label: "Transfer From (Receive)",
      render: (r) =>
        r.pc_receive?.receive_number ? (
          <span className="font-mono text-[12px]">{r.pc_receive.receive_number}</span>
        ) : (
          "—"
        ),
      getValue: (r) => r.pc_receive?.receive_number || "",
    },
    {
      key: "return_date",
      label: "Return Date",
      render: (r) => fmtScmDate(r.return_date),
      getValue: (r) => r.return_date || "",
    },
    {
      key: "refund_centi",
      label: "Refund",
      align: "right",
      render: (r) => <span className="font-mono font-semibold text-ink">{fmtCenti(r.refund_centi, "MYR")}</span>,
      getValue: (r) => r.refund_centi ?? 0,
    },
    {
      key: "status",
      label: "Status",
      render: (r) => <StatusPill status={r.status} />,
      getValue: (r) => pctStatusLabel(r.status),
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Supply Chain"
        title="Purchase Consignment Returns"
        description="Sending unsold or defective consigned goods back to the supplier — books an inventory OUT."
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
            {s === "all" ? "All" : pctStatusLabel(s)}
          </button>
        ))}
      </div>

      <DataTable
        tableId="scm_pc_returns"
        columns={columns}
        rows={rows}
        loading={list.loading}
        error={list.error}
        getRowKey={(r) => r.id}
        onRowClick={(r) => navigate(`/scm/purchase-consignment-returns/${r.id}`)}
        getRowClassName={(r) =>
          r.status === "CANCELLED" || r.status === "COMPLETED" ? "opacity-60" : undefined
        }
        search={{
          value: search,
          onChange: setSearch,
          placeholder: "Search return no., supplier, receive…",
        }}
        emptyLabel="No purchase consignment returns found"
        exportName="purchase-consignment-returns"
      />
    </div>
  );
}
