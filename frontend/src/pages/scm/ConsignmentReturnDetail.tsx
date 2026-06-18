import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "../../components/Layout";
import { DataTable, type Column } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { useQuery } from "../../hooks/useQuery";
import { api } from "../../api/client";
import { SCM, fmtCenti, scmStatusClasses } from "../../lib/scm";
import { cn } from "../../lib/utils";

// GET /api/scm/consignment-returns/:id → { deliveryReturn, items }. The header is
// the full consignment_delivery_returns row; each item is resolved with its
// per-line destination warehouse_code (display-only) and carries qty_returned +
// condition + a per-line refund_centi.
interface CrHeader {
  id: string;
  return_number: string;
  do_doc_no: string | null;
  consignment_do_id: string | null;
  return_date: string | null;
  reason: string | null;
  debtor_code: string | null;
  debtor_name: string;
  agent: string | null;
  sales_location: string | null;
  ref: string | null;
  customer_so_no: string | null;
  branding: string | null;
  venue: string | null;
  phone: string | null;
  email: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  state: string | null;
  postcode: string | null;
  currency: string;
  status: string;
  line_count: number | null;
  local_total_centi: number;
  refund_centi: number | null;
  total_cost_centi: number | null;
  total_margin_centi: number | null;
  inspection_notes: string | null;
  notes: string | null;
  received_at: string | null;
  inspected_at: string | null;
  refunded_at: string | null;
}

interface CrItem {
  id: string;
  consignment_do_item_id: string | null;
  item_code: string;
  item_group: string | null;
  description: string | null;
  description2: string | null;
  uom: string | null;
  qty_returned: number;
  condition: string | null;
  unit_price_centi: number;
  discount_centi: number | null;
  line_total_centi: number;
  unit_cost_centi: number | null;
  line_cost_centi: number | null;
  line_margin_centi: number | null;
  refund_centi: number | null;
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

function fmtDate(d: string | null | undefined): string {
  if (!d) return "—";
  const ms = Date.parse(d.length <= 10 ? `${d}T00:00:00Z` : d);
  if (Number.isNaN(ms)) return d;
  return new Date(ms).toLocaleDateString("en-MY", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function ScmConsignmentReturnDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const detail = useQuery<{ deliveryReturn: CrHeader; items: CrItem[] }>(
    () => api.get(`${SCM}/consignment-returns/${id}`),
    [id],
  );

  const cr = detail.data?.deliveryReturn;
  const items = detail.data?.items ?? null;
  const currency = cr?.currency || "MYR";

  if (detail.error) {
    return (
      <div>
        <BackLink onClick={() => navigate("/scm/consignment-returns")} />
        <EmptyState message="Failed to load consignment return" description={detail.error} />
      </div>
    );
  }

  // Refund total — live from the line items (Σ line refund), falling back to the
  // header rollup, then to qty × unit when a per-line refund is null.
  const refundTotal = (items ?? []).reduce(
    (s, it) => s + (it.refund_centi ?? it.line_total_centi ?? (it.qty_returned ?? 0) * (it.unit_price_centi ?? 0)),
    0,
  );

  const itemCols: Column<CrItem>[] = [
    {
      key: "item_code",
      label: "Item",
      render: (it) => (
        <div>
          <div className="font-mono text-[12px] font-semibold text-accent">{it.item_code}</div>
          {(() => {
            const sub = it.description2 || it.description;
            return sub ? <div className="text-[11px] text-ink-muted">{sub}</div> : null;
          })()}
        </div>
      ),
      getValue: (it) => it.item_code,
    },
    {
      key: "group",
      label: "Group",
      render: (it) => (
        <span className="text-[12px] capitalize text-ink-secondary">
          {(it.item_group ?? "").replace(/_/g, " ") || "—"}
        </span>
      ),
      getValue: (it) => it.item_group ?? "",
    },
    {
      key: "condition",
      label: "Condition",
      render: (it) => (
        <span className="text-[12px] capitalize text-ink-secondary">{it.condition || "—"}</span>
      ),
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
      key: "unit_price",
      label: "Unit Price",
      align: "right",
      render: (it) => <span className="font-mono">{fmtCenti(it.unit_price_centi, currency)}</span>,
      getValue: (it) => it.unit_price_centi ?? 0,
    },
    {
      key: "refund",
      label: "Refund",
      align: "right",
      render: (it) => (
        <span className="font-mono font-semibold text-ink">
          {fmtCenti(it.refund_centi ?? it.line_total_centi, currency)}
        </span>
      ),
      getValue: (it) => it.refund_centi ?? it.line_total_centi ?? 0,
    },
    {
      key: "line_cost",
      label: "Line Cost",
      align: "right",
      defaultHidden: true,
      render: (it) => <span className="font-mono">{fmtCenti(it.line_cost_centi, currency)}</span>,
      getValue: (it) => it.line_cost_centi ?? 0,
    },
  ];

  return (
    <div>
      <BackLink onClick={() => navigate("/scm/consignment-returns")} />
      <PageHeader
        eyebrow={cr ? `Consignment Return · ${cr.return_number}` : "Consignment Return"}
        title={cr ? cr.debtor_name || cr.return_number : detail.loading ? "Loading…" : "Consignment Return"}
      />

      {/* Totals KPIs */}
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi label="Status" value={cr ? STATUS_LABEL[cr.status] ?? cr.status : "—"} loading={detail.loading} status={cr?.status} />
        <Kpi label="Returned Value" value={cr ? fmtCenti(cr.local_total_centi, currency) : "—"} loading={detail.loading} />
        <Kpi label="Refund" value={cr ? fmtCenti(cr.refund_centi ?? cr.local_total_centi, currency) : "—"} loading={detail.loading} />
        <Kpi label="Cost" value={cr ? fmtCenti(cr.total_cost_centi, currency) : "—"} loading={detail.loading} />
      </div>

      {/* Master record */}
      {cr && (
        <div className="mb-5 rounded-lg border border-border bg-surface p-5 shadow-stone">
          <div className="mb-3 flex items-center gap-2">
            <span className="h-px w-3 bg-accent/60" />
            <h3 className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
              Return Record
            </h3>
            <span
              className={cn(
                "ml-auto inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-semibold",
                scmStatusClasses(cr.status),
              )}
            >
              {STATUS_LABEL[cr.status] ?? cr.status}
            </span>
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
            <Info label="Return No." value={cr.return_number} mono />
            <Info label="Consignee" value={cr.debtor_name} />
            <Info label="From Note" value={cr.do_doc_no} mono />
            <Info label="Currency" value={cr.currency} />
            <Info label="Return Date" value={fmtDate(cr.return_date)} />
            <Info label="Received" value={fmtDate(cr.received_at)} />
            <Info label="Agent" value={cr.agent} />
            <Info label="Location" value={cr.sales_location} />
            <Info label="Venue" value={cr.venue} />
            <Info label="Reference" value={cr.ref || cr.customer_so_no} />
            <Info label="Phone" value={cr.phone} />
            <Info label="Email" value={cr.email} />
            <Info label="State" value={cr.state} />
            <Info
              label="Address"
              value={[cr.address1, cr.address2, cr.city, cr.postcode].filter(Boolean).join(", ")}
            />
          </dl>
          {cr.reason && (
            <div className="mt-4 border-t border-border-subtle pt-3">
              <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">Reason</div>
              <div className="mt-0.5 text-[13px] text-ink-secondary">{cr.reason}</div>
            </div>
          )}
          {cr.inspection_notes && (
            <div className="mt-3 border-t border-border-subtle pt-3">
              <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">Inspection</div>
              <div className="mt-0.5 text-[13px] text-ink-secondary">{cr.inspection_notes}</div>
            </div>
          )}
          {cr.notes && (
            <div className="mt-3 border-t border-border-subtle pt-3 text-[13px] text-ink-secondary">
              {cr.notes}
            </div>
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
        tableId="scm_consignment_return_items"
        columns={itemCols}
        rows={items}
        loading={detail.loading}
        getRowKey={(it) => it.id}
        emptyLabel="No items on this consignment return"
        exportName="consignment-return-items"
      />

      {/* Totals */}
      {items && items.length > 0 && (
        <div className="mt-4 flex justify-end">
          <div className="w-full max-w-xs rounded-lg border border-border bg-surface p-4 shadow-stone">
            <div className="flex items-baseline justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
                Total Refund
              </span>
              <span className="font-display text-[20px] font-bold tracking-tight text-ink">
                {fmtCenti(refundTotal, currency)}
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
      Consignment Returns
    </button>
  );
}

function Kpi({
  label,
  value,
  loading,
  status,
}: {
  label: string;
  value: string;
  loading?: boolean;
  status?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4 shadow-stone">
      <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">{label}</div>
      <div
        className={cn(
          "mt-1 font-display text-[20px] font-bold tracking-tight text-ink",
          status && "text-[16px]",
        )}
      >
        {loading ? "…" : value}
      </div>
    </div>
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
