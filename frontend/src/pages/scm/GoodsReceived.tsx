import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "../../components/Layout";
import { DataTable, type Column } from "../../components/DataTable";
import { useQuery } from "../../hooks/useQuery";
import { api, buildQuery } from "../../api/client";
import { SCM, fmtCenti, scmStatusClasses } from "../../lib/scm";
import { cn } from "../../lib/utils";

// Response shape from GET /api/scm/grns — snake_case, verbatim from the Hono
// route (backend/src/scm/routes/grns.ts `grns.get('/')`). The list endpoint
// embeds the supplier + parent PO joins, the stored header total_centi, and the
// migration-0106 convert/lock flags. Rows stay loosely typed where the upstream
// payload is wide; the fields below are the ones the list grid reads.
export interface GrnRow {
  id: string;
  grn_number: string;
  status: string;
  received_at: string | null;
  delivery_note_ref: string | null;
  currency: string | null;
  total_centi: number | null;
  supplier: { id: string; code: string; name: string } | null;
  purchase_order: { id: string; po_number: string } | null;
  has_children?: boolean;
  fully_invoiced?: boolean;
  fully_returned?: boolean;
}

// grn_status enum is POSTED / CLOSED / CANCELLED. A GRN has no draft lifecycle —
// POSTED reads as "Confirmed" (mirrors 2990's). `all` is the unfiltered view.
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

function fmtDate(value: string | null | undefined): string {
  if (!value) return "—";
  return value.slice(0, 10);
}

export function ScmGoodsReceived() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<StatusTab>("all");
  const [search, setSearch] = useState("");

  const list = useQuery<{ grns: GrnRow[] }>(
    () =>
      api.get(
        `${SCM}/grns${buildQuery({
          status: status === "all" ? undefined : status,
        })}`,
      ),
    [status],
  );

  // The backend GRN list endpoint only filters by status/supplierId (no
  // server-side text search), so the search box filters the loaded rows here.
  const all = list.data?.grns ?? null;
  const q = search.trim().toLowerCase();
  const rows =
    all && q
      ? all.filter((g) =>
          [
            g.grn_number,
            g.supplier?.name,
            g.supplier?.code,
            g.purchase_order?.po_number,
            g.delivery_note_ref,
          ]
            .filter(Boolean)
            .some((v) => String(v).toLowerCase().includes(q)),
        )
      : all;

  const columns: Column<GrnRow>[] = [
    {
      key: "grn_number",
      label: "GRN No.",
      render: (g) => <span className="font-mono text-[12px] font-semibold text-ink">{g.grn_number}</span>,
      getValue: (g) => g.grn_number,
    },
    {
      key: "supplier",
      label: "Supplier",
      render: (g) => g.supplier?.name || g.supplier?.code || "—",
      getValue: (g) => g.supplier?.name || g.supplier?.code || "",
    },
    {
      key: "po_number",
      label: "Transfer From (PO)",
      render: (g) =>
        g.purchase_order?.po_number ? (
          <span className="font-mono text-[12px]">{g.purchase_order.po_number}</span>
        ) : (
          "—"
        ),
      getValue: (g) => g.purchase_order?.po_number || "",
    },
    {
      key: "received_at",
      label: "Received Date",
      render: (g) => fmtDate(g.received_at),
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
        title="Goods Received"
        description="Goods Receipt Notes — the PO → GRN → Purchase Invoice receiving step."
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
        tableId="scm_grns"
        columns={columns}
        rows={rows}
        loading={list.loading}
        error={list.error}
        getRowKey={(g) => g.id}
        onRowClick={(g) => navigate(`/scm/grns/${g.id}`)}
        getRowClassName={(g) =>
          g.status === "CANCELLED" || g.status === "CLOSED" ? "opacity-60" : undefined
        }
        search={{
          value: search,
          onChange: setSearch,
          placeholder: "Search GRN no., supplier, PO…",
        }}
        emptyLabel="No goods received notes found"
        exportName="grns"
      />
    </div>
  );
}
