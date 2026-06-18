import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "../../components/Layout";
import { DataTable, type Column } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { useQuery } from "../../hooks/useQuery";
import { api } from "../../api/client";
import { SCM, fmtCenti, scmStatusClasses } from "../../lib/scm";
import { cn } from "../../lib/utils";

// GET /api/scm/consignment-notes/:id → { deliveryOrder, items }. The header is
// the full consignment_delivery_orders row + has_children (any non-cancelled
// Consignment Return → downstream-locked); each item is resolved with its
// per-line ship-from warehouse_code (display-only).
interface CnHeader {
  id: string;
  do_number: string;
  consignment_so_doc_no: string | null;
  do_date: string | null;
  expected_delivery_at: string | null;
  customer_delivery_date: string | null;
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
  driver_name: string | null;
  vehicle: string | null;
  currency: string;
  status: string;
  line_count: number | null;
  local_total_centi: number;
  total_cost_centi: number | null;
  total_margin_centi: number | null;
  note: string | null;
  dispatched_at: string | null;
  delivered_at: string | null;
  has_children?: boolean;
}

interface CnItem {
  id: string;
  consignment_so_item_id: string | null;
  item_code: string;
  item_group: string | null;
  description: string | null;
  description2: string | null;
  uom: string | null;
  qty: number;
  unit_price_centi: number;
  discount_centi: number | null;
  line_total_centi: number;
  unit_cost_centi: number | null;
  line_cost_centi: number | null;
  line_margin_centi: number | null;
  warehouse_code: string | null;
}

const STATUS_LABEL: Record<string, string> = {
  LOADED: "Loaded",
  DISPATCHED: "Dispatched",
  IN_TRANSIT: "In Transit",
  SIGNED: "Signed",
  DELIVERED: "Delivered",
  INVOICED: "Invoiced",
  RETURNED: "Returned",
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

export function ScmConsignmentNoteDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const detail = useQuery<{ deliveryOrder: CnHeader; items: CnItem[] }>(
    () => api.get(`${SCM}/consignment-notes/${id}`),
    [id],
  );

  const cn0 = detail.data?.deliveryOrder;
  const items = detail.data?.items ?? null;
  const currency = cn0?.currency || "MYR";

  if (detail.error) {
    return (
      <div>
        <BackLink onClick={() => navigate("/scm/consignment-notes")} />
        <EmptyState message="Failed to load consignment note" description={detail.error} />
      </div>
    );
  }

  const itemCols: Column<CnItem>[] = [
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
      key: "total",
      label: "Total",
      align: "right",
      render: (it) => (
        <span className="font-mono font-semibold text-ink">{fmtCenti(it.line_total_centi, currency)}</span>
      ),
      getValue: (it) => it.line_total_centi ?? 0,
    },
    {
      key: "line_cost",
      label: "Line Cost",
      align: "right",
      defaultHidden: true,
      render: (it) => <span className="font-mono">{fmtCenti(it.line_cost_centi, currency)}</span>,
      getValue: (it) => it.line_cost_centi ?? 0,
    },
    {
      key: "line_margin",
      label: "Margin",
      align: "right",
      defaultHidden: true,
      render: (it) => <span className="font-mono">{fmtCenti(it.line_margin_centi, currency)}</span>,
      getValue: (it) => it.line_margin_centi ?? 0,
    },
  ];

  return (
    <div>
      <BackLink onClick={() => navigate("/scm/consignment-notes")} />
      <PageHeader
        eyebrow={cn0 ? `Consignment Note · ${cn0.do_number}` : "Consignment Note"}
        title={cn0 ? cn0.debtor_name || cn0.do_number : detail.loading ? "Loading…" : "Consignment Note"}
      />

      {/* Downstream-lock notice — once a Consignment Return exists the note is
          read-only + un-cancellable until the return is cancelled. */}
      {cn0 && cn0.has_children && cn0.status !== "CANCELLED" && (
        <div className="mb-5 rounded-lg border border-warning-text/30 bg-warning-bg px-4 py-3 text-[12.5px] text-warning-text">
          <span className="font-semibold">Locked — has a Consignment Return.</span> Cancel the
          downstream return to edit this consignment note again.
        </div>
      )}

      {/* Totals KPIs */}
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi label="Status" value={cn0 ? STATUS_LABEL[cn0.status] ?? cn0.status : "—"} loading={detail.loading} status={cn0?.status} />
        <Kpi label="Total" value={cn0 ? fmtCenti(cn0.local_total_centi, currency) : "—"} loading={detail.loading} />
        <Kpi label="Cost" value={cn0 ? fmtCenti(cn0.total_cost_centi, currency) : "—"} loading={detail.loading} />
        <Kpi label="Margin" value={cn0 ? fmtCenti(cn0.total_margin_centi, currency) : "—"} loading={detail.loading} />
      </div>

      {/* Master record */}
      {cn0 && (
        <div className="mb-5 rounded-lg border border-border bg-surface p-5 shadow-stone">
          <div className="mb-3 flex items-center gap-2">
            <span className="h-px w-3 bg-accent/60" />
            <h3 className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
              Master Record
            </h3>
            <span
              className={cn(
                "ml-auto inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-semibold",
                scmStatusClasses(cn0.status),
              )}
            >
              {STATUS_LABEL[cn0.status] ?? cn0.status}
            </span>
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
            <Info label="Note No." value={cn0.do_number} mono />
            <Info label="Consignee" value={cn0.debtor_name} />
            <Info label="From Order" value={cn0.consignment_so_doc_no} mono />
            <Info label="Currency" value={cn0.currency} />
            <Info label="Note Date" value={fmtDate(cn0.do_date)} />
            <Info label="Expected Delivery" value={fmtDate(cn0.expected_delivery_at)} />
            <Info label="Agent" value={cn0.agent} />
            <Info label="Location" value={cn0.sales_location} />
            <Info label="Venue" value={cn0.venue} />
            <Info label="Reference" value={cn0.ref || cn0.customer_so_no} />
            <Info label="Driver" value={cn0.driver_name} />
            <Info label="Vehicle" value={cn0.vehicle} />
            <Info label="Phone" value={cn0.phone} />
            <Info label="Email" value={cn0.email} />
            <Info label="State" value={cn0.state} />
            <Info
              label="Address"
              value={[cn0.address1, cn0.address2, cn0.city, cn0.postcode].filter(Boolean).join(", ")}
            />
          </dl>
          {cn0.note && (
            <div className="mt-4 border-t border-border-subtle pt-3 text-[13px] text-ink-secondary">
              {cn0.note}
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
        tableId="scm_consignment_note_items"
        columns={itemCols}
        rows={items}
        loading={detail.loading}
        getRowKey={(it) => it.id}
        emptyLabel="No line items on this consignment note"
        exportName="consignment-note-items"
      />
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
      Consignment Notes
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
