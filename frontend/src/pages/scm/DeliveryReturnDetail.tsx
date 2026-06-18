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

// Shapes from GET /api/scm/delivery-returns/:id — snake_case, verbatim from the
// Hono route. The header is a DO-clone (customer / source DO + per-category
// rollups); items carry a resolved warehouse_code (display-only, the per-line
// warehouse each returned line restocks into).
interface DeliveryReturnHeader {
  id: string;
  return_number: string;
  do_doc_no: string | null;
  delivery_order_id: string | null;
  status: string;
  return_date: string | null;
  reason: string | null;
  debtor_code: string | null;
  debtor_name: string;
  email: string | null;
  phone: string | null;
  customer_so_no: string | null;
  ref: string | null;
  sales_location: string | null;
  venue: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  customer_state: string | null;
  postcode: string | null;
  note: string | null;
  notes: string | null;
  received_at: string | null;
  refunded_at: string | null;
  mattress_sofa_centi: number | null;
  bedframe_centi: number | null;
  accessories_centi: number | null;
  others_centi: number | null;
  refund_centi: number | null;
  local_total_centi: number | null;
  total_cost_centi: number | null;
  total_margin_centi: number | null;
  line_count: number | null;
  currency: string | null;
  created_at: string | null;
}

interface DeliveryReturnItem {
  id: string;
  item_code: string;
  item_group: string | null;
  description: string | null;
  description2: string | null;
  uom: string | null;
  qty_returned: number | null;
  condition: string | null;
  unit_price_centi: number | null;
  discount_centi: number | null;
  line_total_centi: number | null;
  unit_cost_centi: number | null;
  line_cost_centi: number | null;
  line_margin_centi: number | null;
  // Resolved server-side (the warehouse this returned line restocks into).
  warehouse_code: string | null;
}

const STATUS_LABEL: Record<string, string> = {
  PENDING: "Pending",
  RECEIVED: "Received",
  INSPECTED: "Inspected",
  REFUNDED: "Refunded",
  CREDIT_NOTED: "Credit Noted",
  REJECTED: "Rejected",
  CANCELLED: "Cancelled",
};

export function ScmDeliveryReturnDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const detail = useQuery<{ deliveryReturn: DeliveryReturnHeader; items: DeliveryReturnItem[] }>(
    () => api.get(`${SCM}/delivery-returns/${id}`),
    [id],
  );

  const dr = detail.data?.deliveryReturn;
  const items = detail.data?.items ?? null;
  const currency = dr?.currency ?? "MYR";

  if (detail.error) {
    return (
      <div>
        <BackLink onClick={() => navigate("/scm/delivery-returns")} />
        <EmptyState message="Failed to load delivery return" description={detail.error} />
      </div>
    );
  }

  // Returned-value total — live from the line items (Σ line_total_centi),
  // falling back to qty × unit when the rollup column is null.
  const returnedTotal = (items ?? []).reduce(
    (s, it) => s + (it.line_total_centi ?? (it.qty_returned ?? 0) * (it.unit_price_centi ?? 0)),
    0,
  );

  const itemCols: Column<DeliveryReturnItem>[] = [
    {
      key: "item_code",
      label: "Item Code",
      render: (it) => <span className="font-mono text-[12px]">{it.item_code || "—"}</span>,
      getValue: (it) => it.item_code || "",
    },
    {
      key: "description",
      label: "Description",
      render: (it) => it.description || it.description2 || "—",
      getValue: (it) => it.description || it.description2 || "",
    },
    {
      key: "group",
      label: "Group",
      render: (it) => (
        <span className="text-[12px] capitalize text-ink-secondary">
          {(it.item_group || "").replace("_", " ") || "—"}
        </span>
      ),
      getValue: (it) => it.item_group || "",
    },
    {
      key: "condition",
      label: "Condition",
      render: (it) => it.condition || "—",
      getValue: (it) => it.condition || "",
    },
    {
      key: "warehouse",
      label: "Warehouse",
      render: (it) =>
        it.warehouse_code ? <span className="font-mono text-[12px]">{it.warehouse_code}</span> : "—",
      getValue: (it) => it.warehouse_code || "",
    },
    {
      key: "qty",
      label: "Qty",
      align: "right",
      render: (it) => it.qty_returned ?? 0,
      getValue: (it) => it.qty_returned ?? 0,
    },
    {
      key: "unit",
      label: "Unit",
      align: "right",
      render: (it) => <span className="font-mono">{fmtCenti(it.unit_price_centi, currency)}</span>,
      getValue: (it) => it.unit_price_centi ?? 0,
    },
    {
      key: "total",
      label: "Total",
      align: "right",
      render: (it) => (
        <span className="font-mono font-semibold">
          {fmtCenti(
            it.line_total_centi ?? (it.qty_returned ?? 0) * (it.unit_price_centi ?? 0),
            currency,
          )}
        </span>
      ),
      getValue: (it) =>
        it.line_total_centi ?? (it.qty_returned ?? 0) * (it.unit_price_centi ?? 0),
    },
  ];

  return (
    <div>
      <BackLink onClick={() => navigate("/scm/delivery-returns")} />
      <PageHeader
        eyebrow={dr ? `Delivery Return · ${dr.return_number}` : "Delivery Return"}
        title={
          dr
            ? dr.debtor_name || dr.debtor_code || dr.return_number
            : detail.loading
            ? "Loading…"
            : "Delivery Return"
        }
      />

      {/* Header / status / returned-value summary */}
      {dr && (
        <div className="mb-5 rounded-lg border border-border bg-surface p-5 shadow-stone">
          <div className="mb-3 flex items-center gap-2">
            <span className="h-px w-3 bg-accent/60" />
            <h3 className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
              Return Record
            </h3>
            <span
              className={cn(
                "ml-auto inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-semibold",
                scmStatusClasses(dr.status),
              )}
            >
              {STATUS_LABEL[dr.status] ?? dr.status.replace(/_/g, " ")}
            </span>
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
            <Info label="Return No." value={dr.return_number} mono />
            <Info label="Customer" value={dr.debtor_name || dr.debtor_code} />
            <Info label="From DO" value={dr.do_doc_no} mono />
            <Info label="Customer SO Ref" value={dr.customer_so_no ?? dr.ref} />
            <Info label="Return Date" value={dr.return_date ? formatDate(dr.return_date) : null} />
            <Info label="Returned Value" value={fmtCenti(dr.local_total_centi ?? dr.refund_centi, currency)} mono />
            <Info label="Lines" value={dr.line_count != null ? String(dr.line_count) : null} />
            <Info label="Phone" value={dr.phone} />
            <Info label="Email" value={dr.email} />
            <Info label="Venue" value={dr.venue} />
            <Info label="Sales Location" value={dr.sales_location} />
            <Info label="State" value={dr.customer_state} />
          </dl>
          {dr.reason && (
            <div className="mt-4 border-t border-border-subtle pt-3">
              <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
                Reason
              </div>
              <div className="mt-0.5 text-[13px] text-ink-secondary">{dr.reason}</div>
            </div>
          )}
          {(dr.note || dr.notes) && (
            <div className="mt-3 border-t border-border-subtle pt-3 text-[13px] text-ink-secondary">
              {dr.note || dr.notes}
            </div>
          )}
        </div>
      )}

      {/* Line items */}
      <div className="mb-2 flex items-center gap-2">
        <span className="h-px w-3 bg-accent/60" />
        <h3 className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
          Returned Items{items ? ` (${items.length})` : ""}
        </h3>
      </div>
      <DataTable
        tableId="scm_delivery_return_items"
        columns={itemCols}
        rows={items}
        loading={detail.loading}
        getRowKey={(it) => it.id}
        emptyLabel="No items on this return"
        exportName="delivery-return-items"
      />

      {/* Totals */}
      {items && items.length > 0 && (
        <div className="mt-4 flex justify-end">
          <div className="w-full max-w-xs rounded-lg border border-border bg-surface p-4 shadow-stone">
            <div className="flex items-baseline justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
                Returned Value
              </span>
              <span className="font-display text-[20px] font-bold tracking-tight text-ink">
                {fmtCenti(dr?.local_total_centi ?? returnedTotal, currency)}
              </span>
            </div>
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
      Delivery Returns
    </button>
  );
}

function Info({
  label,
  value,
  mono,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">{label}</dt>
      <dd className={cn("mt-0.5 text-[13px] text-ink", mono && "font-mono")}>{value || "—"}</dd>
    </div>
  );
}
