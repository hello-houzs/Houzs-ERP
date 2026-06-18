import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "../../components/Layout";
import { DataTable, type Column } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { useQuery } from "../../hooks/useQuery";
import { api } from "../../api/client";
import { SCM, fmtCenti, scmStatusClasses } from "../../lib/scm";
import { cn } from "../../lib/utils";
import {
  soStatusDisplay,
  soStatusLabel,
  lineSpecSummary,
  paymentMethodLabel,
  type SoHeader,
  type SoItem,
  type SoPayment,
} from "./mfgSalesOrderShared";

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

export function ScmMfgSalesOrderDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const detail = useQuery<{ salesOrder: SoHeader; items: SoItem[] }>(
    () => api.get(`${SCM}/mfg-sales-orders/${encodeURIComponent(id ?? "")}`),
    [id],
  );
  const paymentsQ = useQuery<{ payments: SoPayment[] }>(
    () => api.get(`${SCM}/mfg-sales-orders/${encodeURIComponent(id ?? "")}/payments`),
    [id],
  );

  const so = detail.data?.salesOrder;
  const items = detail.data?.items ?? null;
  const payments = paymentsQ.data?.payments ?? null;
  const currency = so?.currency || "MYR";

  if (detail.error) {
    return (
      <div>
        <BackLink onClick={() => navigate("/scm/sales-orders")} />
        <EmptyState message="Failed to load sales order" description={detail.error} />
      </div>
    );
  }

  const eff = so
    ? soStatusDisplay(so.status, so.delivery_state, so.lifecycle_state)
    : null;
  const statusLabel = so ? (eff?.label ?? soStatusLabel(so.status)) : "—";

  const paidCenti =
    typeof so?.paid_centi_total === "number"
      ? so.paid_centi_total
      : (payments ?? []).reduce((s, p) => s + (p.amount_centi ?? 0), 0);
  const grandTotal = so?.total_revenue_centi ?? so?.local_total_centi ?? 0;
  const balanceCenti =
    typeof so?.balance_centi === "number"
      ? so.balance_centi
      : Math.max(0, grandTotal - paidCenti);
  const marginPct = so ? so.margin_pct_basis / 100 : 0;

  const itemCols: Column<SoItem>[] = [
    {
      key: "item_code",
      label: "Item",
      render: (it) => (
        <div>
          <div className="font-mono text-[12px] font-semibold text-accent">
            {it.item_code || "—"}
          </div>
          {it.description && (
            <div className="text-[11px] text-ink-muted">{it.description}</div>
          )}
          {it.remark && (
            <div className="text-[11px] italic text-ink-muted">Remark: {it.remark}</div>
          )}
        </div>
      ),
      getValue: (it) => it.item_code || "",
    },
    {
      key: "item_group",
      label: "Group",
      render: (it) => (
        <span className="text-[12px] capitalize text-ink-secondary">
          {(it.item_group ?? "").replace(/_/g, " ") || "—"}
        </span>
      ),
      getValue: (it) => it.item_group ?? "",
    },
    {
      key: "description2",
      label: "Description",
      render: (it) => {
        const spec = lineSpecSummary(it);
        return spec ? (
          <span className="text-[12px] text-ink-secondary">{spec}</span>
        ) : (
          <span className="text-ink-muted">—</span>
        );
      },
      getValue: (it) => lineSpecSummary(it),
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
      label: "Delivered",
      render: (it) => {
        const deliveries = it.deliveries ?? [];
        const remaining = it.remaining_qty;
        if (deliveries.length === 0) {
          if (it.coverage_po) {
            return (
              <span className="whitespace-nowrap text-[11px] font-semibold text-accent">
                {it.coverage_po}
                {it.coverage_eta ? ` · ETA ${fmtDate(it.coverage_eta)}` : ""}
              </span>
            );
          }
          return <span className="text-ink-muted">—</span>;
        }
        return (
          <div>
            {deliveries.map((d, di) => (
              <div key={di} className="whitespace-nowrap text-[12px] font-semibold text-accent">
                {d.doNumber} <span className="font-normal text-ink-muted">×{d.qty}</span>
              </div>
            ))}
            {typeof remaining === "number" && (
              <div className={cn("text-[10px]", remaining > 0 ? "text-err" : "text-synced")}>
                {remaining > 0 ? `Balance ${remaining}` : "Fully delivered"}
              </div>
            )}
          </div>
        );
      },
      getValue: (it) => (it.deliveries ?? []).map((d) => d.doNumber).join(" "),
    },
    {
      key: "unit_price",
      label: "Unit Price",
      align: "right",
      render: (it) => (
        <span className="font-mono">{fmtCenti(it.unit_price_centi, currency)}</span>
      ),
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
      defaultHidden: true,
    },
    {
      key: "total_centi",
      label: "Line Total",
      align: "right",
      render: (it) => (
        <span className="font-mono font-semibold text-ink">
          {fmtCenti(it.total_centi, currency)}
        </span>
      ),
      getValue: (it) => it.total_centi ?? 0,
    },
    {
      key: "line_cost_centi",
      label: "Line Cost",
      align: "right",
      render: (it) => (
        <span className="font-mono text-ink-muted">
          {fmtCenti(it.line_cost_centi ?? 0, currency)}
        </span>
      ),
      getValue: (it) => it.line_cost_centi ?? 0,
      defaultHidden: true,
    },
    {
      key: "line_margin_centi",
      label: "Margin",
      align: "right",
      render: (it) => {
        const m = it.line_margin_centi ?? 0;
        return (
          <span className={cn("font-mono", m > 0 ? "text-synced" : m < 0 ? "text-err" : "text-ink-muted")}>
            {fmtCenti(m, currency)}
          </span>
        );
      },
      getValue: (it) => it.line_margin_centi ?? 0,
      defaultHidden: true,
    },
  ];

  const paymentCols: Column<SoPayment>[] = [
    {
      key: "paid_at",
      label: "Date",
      render: (p) => fmtDate(p.paid_at),
      getValue: (p) => p.paid_at ?? "",
    },
    {
      key: "method",
      label: "Method",
      render: (p) => {
        const sub =
          p.method === "merchant"
            ? [p.merchant_provider, p.installment_months ? `${p.installment_months}m` : null]
                .filter(Boolean)
                .join(" · ")
            : p.method === "transfer"
              ? ""
              : p.method === "installment"
                ? p.installment_months
                  ? `${p.installment_months}m`
                  : ""
                : "";
        return (
          <div>
            <span className="inline-flex items-center rounded border border-border bg-surface-dim px-2 py-0.5 text-[11px] font-semibold text-ink-secondary">
              {paymentMethodLabel(p)}
            </span>
            {sub && <div className="mt-0.5 text-[11px] text-ink-muted">{sub}</div>}
          </div>
        );
      },
      getValue: (p) => paymentMethodLabel(p),
    },
    {
      key: "amount_centi",
      label: "Amount",
      align: "right",
      render: (p) => (
        <span className="font-mono font-semibold text-ink">
          {fmtCenti(p.amount_centi, currency)}
        </span>
      ),
      getValue: (p) => p.amount_centi ?? 0,
    },
    {
      key: "account_sheet",
      label: "Account Sheet",
      render: (p) => p.account_sheet || "—",
      getValue: (p) => p.account_sheet || "",
    },
    {
      key: "approval_code",
      label: "Approval Code",
      render: (p) => p.approval_code || "—",
      getValue: (p) => p.approval_code || "",
    },
    {
      key: "collected_by_name",
      label: "Collected By",
      render: (p) => p.collected_by_name || "—",
      getValue: (p) => p.collected_by_name || "",
    },
  ];

  return (
    <div>
      <BackLink onClick={() => navigate("/scm/sales-orders")} />
      <PageHeader
        eyebrow={so ? `Sales Order · ${so.doc_no}` : "Sales Order"}
        title={
          so
            ? so.debtor_name || so.doc_no
            : detail.loading
              ? "Loading…"
              : "Sales Order"
        }
      />

      {/* KPI tiles */}
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi label="Status" value={statusLabel} loading={detail.loading} status={eff?.classKey} />
        <Kpi
          label="Revenue"
          value={so ? fmtCenti(grandTotal, currency) : "—"}
          loading={detail.loading}
        />
        <Kpi
          label="Paid"
          value={so || payments ? fmtCenti(paidCenti, currency) : "—"}
          loading={detail.loading || paymentsQ.loading}
        />
        <Kpi
          label="Balance"
          value={so ? fmtCenti(balanceCenti, currency) : "—"}
          loading={detail.loading}
        />
      </div>

      {/* Customer / master record */}
      {so && (
        <div className="mb-5 rounded-lg border border-border bg-surface p-5 shadow-stone">
          <div className="mb-3 flex items-center gap-2">
            <span className="h-px w-3 bg-accent/60" />
            <h3 className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
              Order
            </h3>
            <span
              className={cn(
                "ml-auto inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-semibold",
                scmStatusClasses(eff?.classKey),
              )}
            >
              {statusLabel}
            </span>
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
            <Info label="Doc No." value={so.doc_no} mono />
            <Info label="Current Doc" value={so.current_doc_no ?? so.doc_no} mono />
            <Info label="Customer" value={so.debtor_name} />
            <Info label="Customer Code" value={so.debtor_code} mono />
            <Info label="SO Date" value={fmtDate(so.so_date)} />
            <Info label="Proceed Date" value={fmtDate(so.processing_date ?? so.proceeded_at)} />
            <Info label="Delivery Date" value={fmtDate(so.customer_delivery_date)} />
            <Info label="Currency" value={so.currency} />
            <Info label="Reference" value={so.customer_so_no ?? so.po_doc_no ?? so.ref} />
            <Info label="Venue" value={so.venue} />
            <Info label="Phone" value={so.phone} />
            <Info label="Email" value={so.email} />
            <Info label="Sales Location" value={so.sales_location} />
            <Info label="Payment Method" value={so.payment_method} />
            <Info label="Ship To" value={so.ship_to_address} />
            <Info
              label="Address"
              value={[so.address1, so.address2, so.city, so.postcode, so.customer_state]
                .filter((x) => x && String(x).trim())
                .join(", ")}
            />
          </dl>
          {so.note && (
            <div className="mt-4 border-t border-border-subtle pt-3 text-[13px] text-ink-secondary">
              {so.note}
            </div>
          )}
        </div>
      )}

      {/* Totals / margin */}
      {so && (
        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Kpi label="Revenue" value={fmtCenti(so.total_revenue_centi ?? so.local_total_centi, currency)} />
          <Kpi label="Cost" value={fmtCenti(so.total_cost_centi, currency)} />
          <Kpi
            label="Margin"
            value={fmtCenti(so.total_margin_centi, currency)}
            status={so.total_margin_centi <= 0 ? "CANCELLED" : "POSTED"}
          />
          <Kpi
            label="Margin %"
            value={(so.total_revenue_centi ?? so.local_total_centi) > 0 ? `${marginPct.toFixed(1)}%` : "—"}
            status={so.total_margin_centi <= 0 ? "CANCELLED" : "POSTED"}
          />
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
        tableId="scm_so_items"
        columns={itemCols}
        rows={items}
        loading={detail.loading}
        getRowKey={(it) => it.id}
        getRowClassName={(it) => (it.cancelled ? "opacity-50" : undefined)}
        emptyLabel="No line items on this sales order"
        exportName="sales-order-items"
      />

      {/* Payments */}
      <div className="mb-2 mt-6 flex items-center gap-2">
        <span className="h-px w-3 bg-accent/60" />
        <h3 className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
          Payments{payments ? ` (${payments.length})` : ""}
        </h3>
      </div>
      <DataTable
        tableId="scm_so_payments"
        columns={paymentCols}
        rows={payments}
        loading={paymentsQ.loading}
        error={paymentsQ.error}
        getRowKey={(p) => p.id}
        emptyLabel="No payments recorded on this sales order"
        exportName="sales-order-payments"
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
      Sales Orders
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
