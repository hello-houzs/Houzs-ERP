import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "../../components/Layout";
import { DataTable, type Column } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { useQuery } from "../../hooks/useQuery";
import { api } from "../../api/client";
import { SCM, fmtCenti, scmStatusClasses } from "../../lib/scm";
import { formatDate } from "../../lib/utils";
import { cn } from "../../lib/utils";

// GET /api/scm/purchase-invoices/:id → { purchaseInvoice, items } (snake_case).
// The header embeds supplier (to-one). Money fields are integer *_centi; tax is
// a stored header value GRN does NOT carry (total = subtotal + tax).
interface PurchaseInvoiceHeader {
  id: string;
  invoice_number: string;
  supplier_invoice_ref: string | null;
  supplier_id: string | null;
  purchase_order_id: string | null;
  grn_id: string | null;
  invoice_date: string | null;
  due_date: string | null;
  currency: string | null;
  subtotal_centi: number | null;
  tax_centi: number | null;
  total_centi: number | null;
  paid_centi: number | null;
  status: string;
  notes: string | null;
  posted_at: string | null;
  created_at: string | null;
  supplier: { id: string; code: string; name: string } | null;
}

interface PurchaseInvoiceItem {
  id: string;
  material_kind: string | null;
  material_code: string | null;
  material_name: string | null;
  description: string | null;
  description2: string | null;
  item_group: string | null;
  uom: string | null;
  qty: number | null;
  unit_price_centi: number | null;
  discount_centi: number | null;
  line_total_centi: number | null;
}

const STATUS_LABEL: Record<string, string> = {
  POSTED: "Confirmed",
  PARTIALLY_PAID: "Partially Paid",
  PAID: "Paid",
  CANCELLED: "Cancelled",
};

function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status.replace(/_/g, " ");
}

export function ScmPurchaseInvoiceDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const detail = useQuery<{ purchaseInvoice: PurchaseInvoiceHeader; items: PurchaseInvoiceItem[] }>(
    () => api.get(`${SCM}/purchase-invoices/${id}`),
    [id],
  );

  const pi = detail.data?.purchaseInvoice;
  const items = detail.data?.items ?? null;

  if (detail.error) {
    return (
      <div>
        <BackLink onClick={() => navigate("/scm/purchase-invoices")} />
        <EmptyState message="Failed to load purchase invoice" description={detail.error} />
      </div>
    );
  }

  const currency = pi?.currency ?? "MYR";
  const subtotal = pi?.subtotal_centi ?? 0;
  const tax = pi?.tax_centi ?? 0;
  const total = pi?.total_centi ?? subtotal + tax;
  const paid = pi?.paid_centi ?? 0;
  const balance = total - paid;

  const itemCols: Column<PurchaseInvoiceItem>[] = [
    {
      key: "material_code",
      label: "Item Code",
      render: (it) => <span className="font-mono text-[12px] font-semibold text-ink">{it.material_code || "—"}</span>,
      getValue: (it) => it.material_code || "",
    },
    {
      key: "description",
      label: "Description",
      render: (it) => (it.description || "").trim() || it.material_name || "—",
      getValue: (it) => it.description || it.material_name || "",
    },
    {
      key: "description2",
      label: "Variant",
      render: (it) => it.description2 || "—",
      getValue: (it) => it.description2 || "",
    },
    {
      key: "qty",
      label: "Qty",
      align: "right",
      render: (it) => it.qty ?? 0,
      getValue: (it) => it.qty ?? 0,
    },
    {
      key: "unit_price",
      label: "Unit Price",
      align: "right",
      render: (it) => <span className="font-mono">{fmtCenti(it.unit_price_centi, currency)}</span>,
      getValue: (it) => it.unit_price_centi ?? 0,
    },
    {
      key: "discount",
      label: "Disc.",
      align: "right",
      render: (it) => ((it.discount_centi ?? 0) > 0 ? fmtCenti(it.discount_centi, currency) : "—"),
      getValue: (it) => it.discount_centi ?? 0,
    },
    {
      key: "line_total",
      label: "Line Total",
      align: "right",
      render: (it) => <span className="font-mono font-semibold text-ink">{fmtCenti(it.line_total_centi, currency)}</span>,
      getValue: (it) => it.line_total_centi ?? 0,
    },
  ];

  return (
    <div>
      <BackLink onClick={() => navigate("/scm/purchase-invoices")} />
      <PageHeader
        eyebrow={pi ? `Purchase Invoice · ${pi.invoice_number}` : "Purchase Invoice"}
        title={pi?.supplier?.name ?? pi?.supplier?.code ?? (detail.loading ? "Loading…" : "Purchase Invoice")}
      />

      {/* Header / master record */}
      {pi && (
        <div className="mb-5 rounded-lg border border-border bg-surface p-5 shadow-stone">
          <div className="mb-3 flex items-center gap-2">
            <span className="h-px w-3 bg-accent/60" />
            <h3 className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">Invoice Header</h3>
            <span
              className={cn(
                "ml-auto inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-semibold",
                scmStatusClasses(pi.status),
              )}
            >
              {statusLabel(pi.status)}
            </span>
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
            <Info label="Invoice No." value={pi.invoice_number} mono />
            <Info label="Supplier" value={pi.supplier?.name || pi.supplier?.code} />
            <Info label="Supplier Ref" value={pi.supplier_invoice_ref} />
            <Info label="Currency" value={pi.currency} />
            <Info label="Invoice Date" value={pi.invoice_date ? formatDate(pi.invoice_date) : null} />
            <Info label="Due Date" value={pi.due_date ? formatDate(pi.due_date) : null} />
            <Info label="Posted" value={pi.posted_at ? formatDate(pi.posted_at) : null} />
            <Info label="Created" value={pi.created_at ? formatDate(pi.created_at) : null} />
          </dl>
          {pi.notes && (
            <div className="mt-4 border-t border-border-subtle pt-3 text-[13px] text-ink-secondary">{pi.notes}</div>
          )}
        </div>
      )}

      {/* Line items */}
      <div className="mb-2 flex items-center gap-2">
        <span className="h-px w-3 bg-accent/60" />
        <h3 className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
          Line Items{items ? ` (${items.length})` : ""}
        </h3>
      </div>
      <DataTable
        tableId="scm_purchase_invoice_items"
        columns={itemCols}
        rows={items}
        loading={detail.loading}
        getRowKey={(it) => it.id}
        emptyLabel="No items on this invoice"
        exportName="purchase-invoice-items"
      />

      {/* Totals */}
      {pi && (
        <div className="mt-5 flex justify-end">
          <div className="w-full max-w-xs rounded-lg border border-border bg-surface p-5 shadow-stone">
            <div className="mb-3 flex items-center gap-2">
              <span className="h-px w-3 bg-accent/60" />
              <h3 className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">Totals</h3>
            </div>
            <dl className="space-y-2 text-[13px]">
              <TotalRow label="Subtotal" value={fmtCenti(subtotal, currency)} />
              <TotalRow label="Tax" value={fmtCenti(tax, currency)} />
              <TotalRow label="Total" value={fmtCenti(total, currency)} emphasis />
              <TotalRow label="Paid" value={fmtCenti(paid, currency)} />
              <TotalRow label="Balance" value={fmtCenti(balance, currency)} />
            </dl>
          </div>
        </div>
      )}
    </div>
  );
}

function BackLink({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="mb-3 inline-flex items-center gap-1.5 text-[12px] font-medium text-ink-secondary transition-colors hover:text-accent"
    >
      <ArrowLeft size={14} />
      Purchase Invoices
    </button>
  );
}

function Info({ label, value, mono }: { label: string; value: string | null | undefined; mono?: boolean }) {
  return (
    <div>
      <dt className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">{label}</dt>
      <dd className={cn("mt-0.5 text-[13px] text-ink", mono && "font-mono")}>{value || "—"}</dd>
    </div>
  );
}

function TotalRow({ label, value, emphasis }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div className={cn("flex items-baseline justify-between gap-3", emphasis && "border-t border-border-subtle pt-2")}>
      <span
        className={cn(
          "text-[11px] font-medium uppercase tracking-wide text-ink-muted",
          emphasis && "text-ink-secondary",
        )}
      >
        {label}
      </span>
      <span className={cn("font-mono text-[13px] text-ink", emphasis && "text-[15px] font-bold")}>{value}</span>
    </div>
  );
}
