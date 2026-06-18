import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "../../components/Layout";
import { DataTable, type Column } from "../../components/DataTable";
import { useQuery } from "../../hooks/useQuery";
import { api, buildQuery } from "../../api/client";
import { SCM, fmtCenti, scmStatusClasses } from "../../lib/scm";
import { formatDate } from "../../lib/utils";
import { cn } from "../../lib/utils";

// Response shape from GET /api/scm/purchase-invoices — snake_case, verbatim
// from the Hono route. The list endpoint embeds supplier + purchase_order + grn
// (each as a to-one object). Money fields are integer *_centi.
export interface PurchaseInvoiceRow {
  id: string;
  invoice_number: string;
  supplier_invoice_ref: string | null;
  invoice_date: string | null;
  due_date: string | null;
  currency: string | null;
  total_centi: number | null;
  paid_centi: number | null;
  status: string;
  supplier: { id: string; code: string; name: string } | null;
  purchase_order: { id: string; po_number: string } | null;
  grn: { id: string; grn_number: string } | null;
}

// purchase_invoice_status enum: POSTED / PARTIALLY_PAID / PAID / CANCELLED.
// POSTED reads as "Confirmed" (a PI is confirmed the moment it exists).
const STATUS_TABS = ["all", "POSTED", "PARTIALLY_PAID", "PAID", "CANCELLED"] as const;
type StatusTab = (typeof STATUS_TABS)[number];

const STATUS_LABEL: Record<string, string> = {
  POSTED: "Confirmed",
  PARTIALLY_PAID: "Partially Paid",
  PAID: "Paid",
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

export function ScmPurchaseInvoices() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<StatusTab>("all");
  const [search, setSearch] = useState("");

  const list = useQuery<{ purchaseInvoices: PurchaseInvoiceRow[] }>(
    () =>
      api.get(
        `${SCM}/purchase-invoices${buildQuery({
          status: status === "all" ? undefined : status,
        })}`,
      ),
    [status],
  );

  // The backend filters by status only; search is applied client-side over the
  // embedded supplier / source-doc / invoice number (mirrors Suppliers.tsx,
  // whose backend does search server-side — here the endpoint has no search
  // param, so we narrow in-memory).
  const all = list.data?.purchaseInvoices ?? null;
  const rows =
    all && search.trim()
      ? all.filter((r) => {
          const q = search.trim().toLowerCase();
          return (
            r.invoice_number.toLowerCase().includes(q) ||
            (r.supplier?.name ?? "").toLowerCase().includes(q) ||
            (r.supplier?.code ?? "").toLowerCase().includes(q) ||
            (r.supplier_invoice_ref ?? "").toLowerCase().includes(q) ||
            (r.grn?.grn_number ?? "").toLowerCase().includes(q) ||
            (r.purchase_order?.po_number ?? "").toLowerCase().includes(q)
          );
        })
      : all;

  const columns: Column<PurchaseInvoiceRow>[] = [
    {
      key: "invoice_number",
      label: "Invoice No.",
      render: (r) => <span className="font-mono text-[12px] font-semibold text-ink">{r.invoice_number}</span>,
      getValue: (r) => r.invoice_number,
    },
    {
      key: "supplier",
      label: "Supplier",
      render: (r) => <span className="font-medium text-ink">{r.supplier?.name || r.supplier?.code || "—"}</span>,
      getValue: (r) => r.supplier?.name || r.supplier?.code || "",
    },
    {
      key: "source",
      label: "From (GRN / PO)",
      render: (r) => (
        <span className="font-mono text-[12px] text-ink-secondary">
          {r.grn?.grn_number || r.purchase_order?.po_number || "—"}
        </span>
      ),
      getValue: (r) => r.grn?.grn_number || r.purchase_order?.po_number || "",
    },
    {
      key: "supplier_ref",
      label: "Supplier Ref",
      render: (r) => r.supplier_invoice_ref || "—",
      getValue: (r) => r.supplier_invoice_ref || "",
    },
    {
      key: "invoice_date",
      label: "Invoice Date",
      render: (r) => formatDate(r.invoice_date),
      getValue: (r) => r.invoice_date || "",
    },
    {
      key: "due_date",
      label: "Due Date",
      render: (r) => formatDate(r.due_date),
      getValue: (r) => r.due_date || "",
    },
    {
      key: "total",
      label: "Total",
      align: "right",
      render: (r) => <span className="font-mono font-semibold text-ink">{fmtCenti(r.total_centi, r.currency ?? "MYR")}</span>,
      getValue: (r) => r.total_centi ?? 0,
    },
    {
      key: "balance",
      label: "Balance",
      align: "right",
      render: (r) => (
        <span className="font-mono text-ink-secondary">
          {fmtCenti((r.total_centi ?? 0) - (r.paid_centi ?? 0), r.currency ?? "MYR")}
        </span>
      ),
      getValue: (r) => (r.total_centi ?? 0) - (r.paid_centi ?? 0),
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
        title="Purchase Invoices"
        description="Supplier billing after goods receipt (AP). Converted from a GRN."
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
        tableId="scm_purchase_invoices"
        columns={columns}
        rows={rows}
        loading={list.loading}
        error={list.error}
        getRowKey={(r) => r.id}
        onRowClick={(r) => navigate(`/scm/purchase-invoices/${r.id}`)}
        getRowClassName={(r) => (r.status === "CANCELLED" ? "opacity-60" : undefined)}
        search={{
          value: search,
          onChange: setSearch,
          placeholder: "Search invoice, supplier, GRN/PO…",
        }}
        emptyLabel="No purchase invoices found"
        exportName="purchase-invoices"
      />
    </div>
  );
}
