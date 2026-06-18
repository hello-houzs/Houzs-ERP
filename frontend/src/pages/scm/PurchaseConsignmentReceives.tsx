import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import { PageHeader } from "../../components/Layout";
import { Button } from "../../components/Button";
import { DataTable, type Column } from "../../components/DataTable";
import { useQuery } from "../../hooks/useQuery";
import { api, buildQuery } from "../../api/client";
import { SCM, fmtCenti, scmStatusClasses } from "../../lib/scm";
import { cn } from "../../lib/utils";
import { fmtScmDate } from "./PurchaseConsignmentOrders";

// Response shape from GET /api/scm/purchase-consignment-receives — snake_case,
// verbatim from backend/src/scm/routes/purchase-consignment-receives.ts (the
// list endpoint is keyed `grns` in the payload, cloned from the GRN route). It
// embeds the supplier + the parent PC Order join (purchase_consignment_order:
// {id, pc_number}), the stored header total_centi, and the consumption flags
// has_children (any line returned) / fully_returned.
export interface PcrRow {
  id: string;
  receive_number: string;
  status: string;
  received_at: string | null;
  delivery_note_ref: string | null;
  currency: string | null;
  total_centi: number | null;
  supplier: { id: string; code: string; name: string } | null;
  purchase_consignment_order: { id: string; pc_number: string } | null;
  has_children?: boolean;
  fully_returned?: boolean;
}

// grn_status enum is POSTED / CLOSED / CANCELLED. A receive has no draft
// lifecycle — POSTED reads as "Confirmed" (mirrors GRN). `all` is unfiltered.
const STATUS_TABS = ["all", "POSTED", "CLOSED", "CANCELLED"] as const;
type StatusTab = (typeof STATUS_TABS)[number];

const STATUS_LABEL: Record<string, string> = {
  POSTED: "Confirmed",
  CLOSED: "Closed",
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

export function ScmPurchaseConsignmentReceives() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<StatusTab>("all");
  const [search, setSearch] = useState("");

  const list = useQuery<{ grns: PcrRow[] }>(
    () =>
      api.get(
        `${SCM}/purchase-consignment-receives${buildQuery({
          status: status === "all" ? undefined : status,
        })}`,
      ),
    [status],
  );

  // The backend receive list only filters by status/supplierId (no server-side
  // text search), so the search box filters the loaded rows here.
  const all = list.data?.grns ?? null;
  const q = search.trim().toLowerCase();
  const rows =
    all && q
      ? all.filter((g) =>
          [
            g.receive_number,
            g.supplier?.name,
            g.supplier?.code,
            g.purchase_consignment_order?.pc_number,
            g.delivery_note_ref,
          ]
            .filter(Boolean)
            .some((v) => String(v).toLowerCase().includes(q)),
        )
      : all;

  const columns: Column<PcrRow>[] = [
    {
      key: "receive_number",
      label: "Receive No.",
      render: (g) => <span className="font-mono text-[12px] font-semibold text-ink">{g.receive_number}</span>,
      getValue: (g) => g.receive_number,
    },
    {
      key: "supplier",
      label: "Supplier",
      render: (g) => g.supplier?.name || g.supplier?.code || "—",
      getValue: (g) => g.supplier?.name || g.supplier?.code || "",
    },
    {
      key: "pc_number",
      label: "Transfer From (Order)",
      render: (g) =>
        g.purchase_consignment_order?.pc_number ? (
          <span className="font-mono text-[12px]">{g.purchase_consignment_order.pc_number}</span>
        ) : (
          "—"
        ),
      getValue: (g) => g.purchase_consignment_order?.pc_number || "",
    },
    {
      key: "received_at",
      label: "Received Date",
      render: (g) => fmtScmDate(g.received_at),
      getValue: (g) => g.received_at || "",
    },
    {
      key: "delivery_note_ref",
      label: "DN Ref",
      defaultHidden: true,
      render: (g) => g.delivery_note_ref || "—",
      getValue: (g) => g.delivery_note_ref || "",
    },
    {
      key: "total_centi",
      label: "Total",
      align: "right",
      render: (g) => <span className="font-mono">{fmtCenti(g.total_centi, g.currency ?? "MYR")}</span>,
      getValue: (g) => g.total_centi ?? 0,
    },
    {
      key: "status",
      label: "Status",
      render: (g) => <StatusPill status={g.status} />,
      getValue: (g) => g.status,
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Supply Chain"
        title="Purchase Consignment Receives"
        description="Receiving the supplier's consigned stock into our warehouse — books an inventory IN."
        primaryAction={
          <Button icon={<Plus size={15} />} onClick={() => navigate("/scm/purchase-consignment-receives/new")}>
            New Receive
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
            {s === "all" ? "All" : statusLabel(s)}
          </button>
        ))}
      </div>

      <DataTable
        tableId="scm_pc_receives"
        columns={columns}
        rows={rows}
        loading={list.loading}
        error={list.error}
        getRowKey={(g) => g.id}
        onRowClick={(g) => navigate(`/scm/purchase-consignment-receives/${g.id}`)}
        getRowClassName={(g) =>
          g.status === "CANCELLED" || g.status === "CLOSED" ? "opacity-60" : undefined
        }
        search={{
          value: search,
          onChange: setSearch,
          placeholder: "Search receive no., supplier, PC Order…",
        }}
        emptyLabel="No purchase consignment receives found"
        exportName="purchase-consignment-receives"
      />
    </div>
  );
}
