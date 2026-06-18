import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "../../components/Layout";
import { DataTable, type Column } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { useQuery } from "../../hooks/useQuery";
import { api } from "../../api/client";
import { SCM, fmtCenti, scmStatusClasses } from "../../lib/scm";
import { cn } from "../../lib/utils";

// Response shapes from GET /api/scm/delivery-orders-mfg/:id — snake_case,
// verbatim from the Hono route (backend/src/scm/routes/delivery-orders-mfg.ts
// `deliveryOrdersMfg.get('/:id')`). It returns { deliveryOrder, items }: the
// header carries the SO-cloned customer/address/category-total fields plus the
// downstream-lock flag + document-driven lifecycle_state; each item carries qty
// + money + a per-line warehouse (resolved from its SO line) and a downstream
// SI/DR breakdown.
interface DoHeader {
  id: string;
  do_number: string;
  so_doc_no: string | null;
  do_date: string | null;
  expected_delivery_at: string | null;
  customer_delivery_date: string | null;
  signed_at: string | null;
  delivered_at: string | null;
  dispatched_at: string | null;
  debtor_code: string | null;
  debtor_name: string | null;
  customer_so_no: string | null;
  po_doc_no: string | null;
  ref: string | null;
  driver_name: string | null;
  vehicle: string | null;
  venue: string | null;
  branding: string | null;
  phone: string | null;
  email: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  state: string | null;
  postcode: string | null;
  customer_state: string | null;
  customer_country: string | null;
  sales_location: string | null;
  customer_type: string | null;
  building_type: string | null;
  note: string | null;
  notes: string | null;
  line_count: number | null;
  local_total_centi: number | null;
  total_cost_centi: number | null;
  total_margin_centi: number | null;
  currency: string | null;
  status: string;
  has_children?: boolean;
  lifecycle_state?: "shipped" | "invoiced" | "returned";
}

interface Downstream {
  docNumber: string;
  docType: "SI" | "DR";
  qty: number;
  status: string;
}

interface DoItem {
  id: string;
  item_code: string | null;
  item_group: string | null;
  description: string | null;
  description2: string | null;
  uom: string | null;
  qty: number | null;
  unit_price_centi: number | null;
  discount_centi: number | null;
  line_total_centi: number | null;
  unit_cost_centi: number | null;
  line_cost_centi: number | null;
  line_margin_centi: number | null;
  line_delivery_date: string | null;
  warehouse_id: string | null;
  warehouse_code: string | null;
  downstream: Downstream[];
}

const STATUS_LABEL: Record<string, string> = {
  DISPATCHED: "Shipped",
  INVOICED: "Invoiced",
  RETURNED: "Delivery Return",
  CANCELLED: "Cancelled",
};

function effectiveKey(status: string, lifecycle?: DoHeader["lifecycle_state"]): string {
  if ((status ?? "").toUpperCase() === "CANCELLED") return "CANCELLED";
  if (lifecycle === "returned") return "RETURNED";
  if (lifecycle === "invoiced") return "INVOICED";
  return "DISPATCHED"; // shipped baseline
}

function statusLabel(key: string): string {
  return STATUS_LABEL[key] ?? key.replace(/_/g, " ");
}

function pillClasses(key: string): string {
  // shipped / invoiced map to the synced (delivered) vocabulary; the rest use
  // their own.
  return scmStatusClasses(key === "DISPATCHED" || key === "INVOICED" ? "DELIVERED" : key);
}

function fmtDate(value: string | null | undefined): string {
  if (!value) return "—";
  return value.slice(0, 10);
}

export function ScmDeliveryOrderDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const detail = useQuery<{ deliveryOrder: DoHeader; items: DoItem[] }>(
    () => api.get(`${SCM}/delivery-orders-mfg/${id}`),
    [id],
  );

  const order = detail.data?.deliveryOrder;
  const items = detail.data?.items ?? null;
  const currency = order?.currency ?? "MYR";
  const effKey = order ? effectiveKey(order.status, order.lifecycle_state) : "";

  if (detail.error) {
    return (
      <div>
        <BackLink onClick={() => navigate("/scm/delivery-orders")} />
        <EmptyState message="Failed to load delivery order" description={detail.error} />
      </div>
    );
  }

  // Live subtotal from the lines (matches the GRN detail "computed from visible
  // lines" pattern). A DO carries no tax line, so the grand total is the sum of
  // the line totals.
  const itemsSubtotal = (items ?? []).reduce((s, it) => s + (it.line_total_centi ?? 0), 0);

  const itemCols: Column<DoItem>[] = [
    {
      key: "item_code",
      label: "Item Code",
      render: (it) => <span className="font-mono text-[12px]">{it.item_code || "—"}</span>,
      getValue: (it) => it.item_code || "",
    },
    {
      key: "item_group",
      label: "Group",
      render: (it) => it.item_group || "—",
      getValue: (it) => it.item_group || "",
    },
    {
      key: "description",
      label: "Description",
      render: (it) => it.description?.trim() || "—",
      getValue: (it) => it.description || "",
    },
    {
      key: "description2",
      label: "Description 2",
      defaultHidden: true,
      render: (it) => it.description2 || "—",
      getValue: (it) => it.description2 || "",
    },
    {
      key: "uom",
      label: "UOM",
      render: (it) => it.uom || "UNIT",
      getValue: (it) => it.uom || "UNIT",
    },
    {
      key: "qty",
      label: "Qty",
      align: "right",
      render: (it) => it.qty ?? 0,
      getValue: (it) => it.qty ?? 0,
    },
    {
      key: "warehouse_code",
      label: "Warehouse",
      render: (it) => it.warehouse_code || "—",
      getValue: (it) => it.warehouse_code || "",
    },
    {
      key: "transfer_to",
      label: "Transfer To",
      render: (it) => {
        const ds = it.downstream ?? [];
        if (ds.length === 0) return <span className="text-ink-muted">—</span>;
        return (
          <div className="space-y-0.5">
            {ds.map((d, di) => (
              <div key={di} className="whitespace-nowrap text-[12px] font-medium text-ink">
                {d.docNumber} <span className="text-ink-muted">x{d.qty}</span>
              </div>
            ))}
          </div>
        );
      },
      getValue: (it) => (it.downstream ?? []).map((d) => d.docNumber).join(" "),
    },
    {
      key: "unit_price",
      label: "Unit Price",
      align: "right",
      render: (it) => <span className="font-mono">{fmtCenti(it.unit_price_centi, currency)}</span>,
      getValue: (it) => it.unit_price_centi ?? 0,
    },
    {
      key: "line_total",
      label: "Line Total",
      align: "right",
      render: (it) => (
        <span className="font-mono font-semibold text-ink">{fmtCenti(it.line_total_centi, currency)}</span>
      ),
      getValue: (it) => it.line_total_centi ?? 0,
    },
    {
      key: "line_delivery_date",
      label: "Delivery",
      defaultHidden: true,
      render: (it) => fmtDate(it.line_delivery_date),
      getValue: (it) => it.line_delivery_date || "",
    },
  ];

  return (
    <div>
      <BackLink onClick={() => navigate("/scm/delivery-orders")} />
      <PageHeader
        eyebrow={order ? `Delivery Order · ${order.do_number}` : "Delivery Order"}
        title={order?.debtor_name ?? order?.debtor_code ?? (detail.loading ? "Loading…" : "Delivery Order")}
      />

      {/* KPI tiles */}
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi label="Lines" value={items ? String(items.length) : "—"} loading={detail.loading} />
        <Kpi
          label="Total"
          value={order ? fmtCenti(order.local_total_centi, currency) : "—"}
          loading={detail.loading}
        />
        <Kpi label="DO Date" value={order ? fmtDate(order.do_date) : "—"} loading={detail.loading} />
        <Kpi label="Status" value={order ? statusLabel(effKey) : "—"} loading={detail.loading} />
      </div>

      {/* Master record */}
      {order && (
        <div className="mb-5 rounded-lg border border-border bg-surface p-5 shadow-stone">
          <div className="mb-3 flex items-center gap-2">
            <span className="h-px w-3 bg-accent/60" />
            <h3 className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">Delivery Order</h3>
            <span
              className={cn(
                "ml-auto inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-semibold",
                pillClasses(effKey),
              )}
            >
              {statusLabel(effKey)}
            </span>
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
            <Info label="DO No." value={order.do_number} mono />
            <Info label="Transfer From (SO)" value={order.so_doc_no} mono />
            <Info label="Customer" value={order.debtor_name ?? order.debtor_code} />
            <Info label="Reference" value={order.customer_so_no ?? order.po_doc_no ?? order.ref} />
            <Info label="DO Date" value={fmtDate(order.do_date)} />
            <Info label="Expected Delivery" value={fmtDate(order.expected_delivery_at)} />
            <Info label="Delivery Date" value={fmtDate(order.customer_delivery_date)} />
            <Info label="Driver" value={order.driver_name} />
            <Info label="Vehicle" value={order.vehicle} />
            <Info label="Venue" value={order.venue} />
            <Info label="Phone" value={order.phone} />
            <Info label="Currency" value={order.currency} />
            <Info label="Total" value={fmtCenti(order.local_total_centi, currency)} mono />
          </dl>
          {(order.address1 || order.address2 || order.city || order.customer_state) && (
            <div className="mt-4 border-t border-border-subtle pt-3">
              <dt className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
                Delivery Address
              </dt>
              <dd className="mt-0.5 text-[13px] text-ink">
                {[order.address1, order.address2, order.city, order.postcode, order.customer_state, order.customer_country]
                  .filter((v) => v && String(v).trim())
                  .join(", ") || "—"}
              </dd>
            </div>
          )}
          {(order.note || order.notes) && (
            <div className="mt-4 border-t border-border-subtle pt-3 text-[13px] text-ink-secondary">
              {order.note || order.notes}
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
        tableId="scm_delivery_order_items"
        columns={itemCols}
        rows={items}
        loading={detail.loading}
        getRowKey={(it) => it.id}
        emptyLabel="No line items on this delivery order"
        exportName="delivery-order-items"
      />

      {/* Totals */}
      {order && (
        <div className="mt-5 flex justify-end">
          <div className="w-full max-w-xs rounded-lg border border-border bg-surface p-4 shadow-stone">
            <div className="flex items-baseline justify-between py-1">
              <span className="text-[11px] font-semibold uppercase tracking-brand text-ink-muted">Subtotal</span>
              <span className="font-mono text-[13px] text-ink">{fmtCenti(itemsSubtotal, currency)}</span>
            </div>
            <div className="mt-1 flex items-baseline justify-between border-t border-border-subtle pt-2">
              <span className="text-[11px] font-semibold uppercase tracking-brand text-ink">Total</span>
              <span className="font-mono text-[15px] font-bold text-ink">
                {fmtCenti(order.local_total_centi, currency)}
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
      Delivery Orders
    </button>
  );
}

function Kpi({ label, value, loading }: { label: string; value: string; loading?: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4 shadow-stone">
      <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">{label}</div>
      <div className="mt-1 font-display text-[22px] font-bold tracking-tight text-ink">{loading ? "…" : value}</div>
    </div>
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
