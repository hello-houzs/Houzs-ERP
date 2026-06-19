import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "../../components/Layout";
import { DataTable, type Column } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { useQuery } from "../../hooks/useQuery";
import { api } from "../../api/client";
import { SCM, fmtCenti, scmStatusClasses } from "../../lib/scm";
import { cn } from "../../lib/utils";
import { ScmLinePhotos, readPhotoKeys } from "./ScmLinePhotos";

// GET /api/scm/consignment-orders/:docNo → { salesOrder, items }. The header is
// the full consignment_sales_orders row + has_children (any non-cancelled
// Consignment Note → downstream-locked); each item carries a `deliveries[]`
// breakdown (which note shipped how much against the line).
interface CoHeader {
  doc_no: string;
  so_date: string | null;
  debtor_code: string | null;
  debtor_name: string;
  agent: string | null;
  sales_location: string | null;
  ref: string | null;
  venue: string | null;
  phone: string | null;
  email: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  postcode: string | null;
  customer_state: string | null;
  currency: string;
  status: string;
  line_count: number | null;
  local_total_centi: number;
  total_revenue_centi: number | null;
  total_cost_centi: number | null;
  total_margin_centi: number | null;
  balance_centi: number | null;
  customer_delivery_date: string | null;
  internal_expected_dd: string | null;
  customer_so_no: string | null;
  note: string | null;
  has_children?: boolean;
}

interface CoLineDelivery {
  noNumber: string;
  qty: number;
  status: string;
}

interface CoItem {
  id: string;
  item_code: string;
  item_group: string | null;
  description: string | null;
  description2: string | null;
  uom: string | null;
  qty: number;
  unit_price_centi: number;
  discount_centi: number | null;
  total_centi: number;
  unit_cost_centi: number | null;
  line_cost_centi: number | null;
  line_margin_centi: number | null;
  cancelled: boolean | null;
  deliveries: CoLineDelivery[] | null;
  photo_urls?: unknown;
}

const STATUS_LABEL: Record<string, string> = {
  CONFIRMED: "Confirmed",
  CLOSED: "Closed",
  ON_HOLD: "On Hold",
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

export function ScmConsignmentOrderDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const detail = useQuery<{ salesOrder: CoHeader; items: CoItem[] }>(
    () => api.get(`${SCM}/consignment-orders/${encodeURIComponent(id ?? "")}`),
    [id],
  );

  const co = detail.data?.salesOrder;
  const items = detail.data?.items ?? null;
  const currency = co?.currency || "MYR";

  if (detail.error) {
    return (
      <div>
        <BackLink onClick={() => navigate("/scm/consignment-orders")} />
        <EmptyState message="Failed to load consignment order" description={detail.error} />
      </div>
    );
  }

  const liveItems = (items ?? []).filter((it) => !it.cancelled);

  const itemCols: Column<CoItem>[] = [
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
      key: "qty",
      label: "Qty",
      align: "right",
      render: (it) => it.qty ?? 0,
      getValue: (it) => it.qty ?? 0,
    },
    {
      key: "delivered",
      label: "Shipped (Note)",
      render: (it) => {
        const dels = it.deliveries ?? [];
        if (dels.length === 0) return <span className="text-ink-muted">—</span>;
        const shipped = dels.reduce((s, d) => s + Number(d.qty ?? 0), 0);
        const balance = Number(it.qty ?? 0) - shipped;
        return (
          <div>
            {dels.map((d, di) => (
              <div key={di} className="whitespace-nowrap text-[12px] font-semibold text-accent">
                {d.noNumber} <span className="font-normal text-ink-muted">×{d.qty}</span>
              </div>
            ))}
            <div className={cn("text-[10px]", balance > 0 ? "text-err" : "text-synced")}>
              {balance > 0 ? `Balance ${balance}` : "Fully shipped"}
            </div>
          </div>
        );
      },
      getValue: (it) => (it.deliveries ?? []).map((d) => d.noNumber).join(" "),
    },
    {
      key: "photos",
      label: "Photos",
      disableSort: true,
      render: (it) => {
        const keys = readPhotoKeys(it);
        if (keys.length === 0) return <span className="text-ink-muted">—</span>;
        return (
          <ScmLinePhotos
            basePath={`${SCM}/consignment-orders/${encodeURIComponent(id ?? "")}/items/${encodeURIComponent(it.id)}`}
            photoKeys={keys}
          />
        );
      },
      getValue: (it) => String(readPhotoKeys(it).length),
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
      render: (it) =>
        (it.discount_centi ?? 0) > 0 ? (
          <span className="font-mono">{fmtCenti(it.discount_centi, currency)}</span>
        ) : (
          <span className="text-ink-muted">—</span>
        ),
      getValue: (it) => it.discount_centi ?? 0,
    },
    {
      key: "total",
      label: "Total",
      align: "right",
      render: (it) => (
        <span className="font-mono font-semibold text-ink">{fmtCenti(it.total_centi, currency)}</span>
      ),
      getValue: (it) => it.total_centi ?? 0,
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
      <BackLink onClick={() => navigate("/scm/consignment-orders")} />
      <PageHeader
        eyebrow={co ? `Consignment Order · ${co.doc_no}` : "Consignment Order"}
        title={co ? co.debtor_name || co.doc_no : detail.loading ? "Loading…" : "Consignment Order"}
      />

      {/* Downstream-lock notice — once a Consignment Note exists the order is
          read-only + un-cancellable until the note is cancelled. */}
      {co && co.has_children && co.status !== "CANCELLED" && (
        <div className="mb-5 rounded-lg border border-warning-text/30 bg-warning-bg px-4 py-3 text-[12.5px] text-warning-text">
          <span className="font-semibold">Locked — has a Consignment Note.</span> Cancel the
          downstream note to edit this consignment order again.
        </div>
      )}

      {/* Totals KPIs */}
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi label="Status" value={co ? STATUS_LABEL[co.status] ?? co.status : "—"} loading={detail.loading} status={co?.status} />
        <Kpi label="Total" value={co ? fmtCenti(co.local_total_centi, currency) : "—"} loading={detail.loading} />
        <Kpi label="Cost" value={co ? fmtCenti(co.total_cost_centi, currency) : "—"} loading={detail.loading} />
        <Kpi label="Margin" value={co ? fmtCenti(co.total_margin_centi, currency) : "—"} loading={detail.loading} />
      </div>

      {/* Master record */}
      {co && (
        <div className="mb-5 rounded-lg border border-border bg-surface p-5 shadow-stone">
          <div className="mb-3 flex items-center gap-2">
            <span className="h-px w-3 bg-accent/60" />
            <h3 className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
              Master Record
            </h3>
            <span
              className={cn(
                "ml-auto inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-semibold",
                scmStatusClasses(co.status),
              )}
            >
              {STATUS_LABEL[co.status] ?? co.status}
            </span>
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
            <Info label="Doc No." value={co.doc_no} mono />
            <Info label="Consignee" value={co.debtor_name} />
            <Info label="Customer Code" value={co.debtor_code} mono />
            <Info label="Currency" value={co.currency} />
            <Info label="Order Date" value={fmtDate(co.so_date)} />
            <Info label="Delivery Date" value={fmtDate(co.customer_delivery_date)} />
            <Info label="Agent" value={co.agent} />
            <Info label="Location" value={co.sales_location} />
            <Info label="Venue" value={co.venue} />
            <Info label="Reference" value={co.ref || co.customer_so_no} />
            <Info label="Phone" value={co.phone} />
            <Info label="Email" value={co.email} />
            <Info label="State" value={co.customer_state} />
            <Info
              label="Address"
              value={[co.address1, co.address2, co.city, co.postcode].filter(Boolean).join(", ")}
            />
          </dl>
          {co.note && (
            <div className="mt-4 border-t border-border-subtle pt-3 text-[13px] text-ink-secondary">
              {co.note}
            </div>
          )}
        </div>
      )}

      {/* Line items */}
      <div className="mb-2 flex items-center gap-2">
        <span className="h-px w-3 bg-accent/60" />
        <h3 className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
          Line Items{items ? ` (${liveItems.length})` : ""}
        </h3>
      </div>
      <DataTable
        tableId="scm_consignment_order_items"
        columns={itemCols}
        rows={liveItems.length || !detail.loading ? liveItems : null}
        loading={detail.loading}
        getRowKey={(it) => it.id}
        emptyLabel="No line items on this consignment order"
        exportName="consignment-order-items"
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
      Consignment Orders
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
