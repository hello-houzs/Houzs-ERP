// Customers — SCM customer directory, aggregated from Sales Order history.
// Ported from 2990's backend Customers page (GROUP BY phone/name over
// mfg_sales_orders with order count / lifetime value / last-order date), adapted
// to Houzs conventions: the aggregation runs SERVER-side (GET
// /api/scm/mfg-sales-orders/customers, company + sales-scope scoped) and the page
// is composed with the real Houzs DS primitives (PageHeader / StatCard / DataTable
// with an expandable order-history sub-row), DD/MM/YYYY dates, no emoji.
//
// Read-only: no mutations. A new entry appears here automatically when a Sales
// Order is created for a new phone/customer.

import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "../../components/Layout";
import { StatCard } from "../../components/StatCard";
import { DataTable, type Column } from "../../components/DataTable";
import { Badge } from "../../components/Badge";
import { formatDate } from "../../lib/utils";
import {
  useMfgCustomers,
  type ScmCustomer,
  type ScmCustomerOrder,
} from "../../vendor/scm/lib/sales-order-queries";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmtRm = (centi: number): string =>
  `RM ${(centi / 100).toLocaleString("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

// "3 days ago" style relative recency next to the DD/MM/YYYY last-order date.
const daysAgo = (iso: string): string => {
  if (!iso) return "";
  const then = new Date(iso);
  const t = then.getTime();
  if (!Number.isFinite(t)) return "";
  const days = Math.floor((Date.now() - t) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "1 day ago";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months === 1) return "1 month ago";
  if (months < 12) return `${months} months ago`;
  const years = Math.floor(days / 365);
  return years === 1 ? "1 year ago" : `${years} years ago`;
};

// SO status → short label + tone. Mirrors the SO listing vocabulary so the
// directory reads the same as the Sales Orders ledger.
const STATUS_LABEL: Record<string, { tone: "success" | "warning" | "error" | "neutral"; label: string }> = {
  DRAFT: { tone: "warning", label: "Draft" },
  CONFIRMED: { tone: "success", label: "Confirmed" },
  IN_PRODUCTION: { tone: "success", label: "Proceed" },
  READY_TO_SHIP: { tone: "success", label: "Stock Ready" },
  SHIPPED: { tone: "success", label: "Arranged" },
  DELIVERED: { tone: "success", label: "Delivered" },
  INVOICED: { tone: "success", label: "Invoiced" },
  CLOSED: { tone: "neutral", label: "Closed" },
  CANCELLED: { tone: "error", label: "Cancelled" },
  ON_HOLD: { tone: "warning", label: "On Hold" },
};
const statusFor = (s: string): { tone: "success" | "warning" | "error" | "neutral"; label: string } =>
  STATUS_LABEL[s] ?? { tone: "neutral", label: s.replace(/_/g, " ") };

const orderDateOf = (o: ScmCustomerOrder): string => o.created_at ?? o.so_date ?? "";

// ─── Order-history sub-row ────────────────────────────────────────────────────

function CustomerHistory({ customer }: { customer: ScmCustomer }) {
  const navigate = useNavigate();
  return (
    <div className="px-5 py-4">
      <div className="mb-2.5 font-mono text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
        Order history · {customer.order_count}{" "}
        {customer.order_count === 1 ? "order" : "orders"}
      </div>
      <div className="overflow-hidden rounded-lg border border-border">
        <div className="grid grid-cols-[140px_110px_120px_1fr_120px_64px] gap-2 border-b border-border-subtle bg-surface-2 px-4 py-2 font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
          <span>Order</span>
          <span>Placed</span>
          <span>Status</span>
          <span>Items</span>
          <span className="text-right">Total</span>
          <span />
        </div>
        {customer.orders.map((o) => {
          const st = statusFor(o.status);
          return (
            <div
              key={o.doc_no}
              className="grid grid-cols-[140px_110px_120px_1fr_120px_64px] items-center gap-2 border-b border-border-subtle px-4 py-2.5 text-[12.5px] last:border-b-0"
            >
              <span className="font-mono font-semibold text-ink">{o.doc_no}</span>
              <span className="text-ink-secondary">{formatDate(orderDateOf(o))}</span>
              <span>
                <Badge tone={st.tone} size="xs">
                  {st.label}
                </Badge>
              </span>
              <span className="text-ink-secondary">
                {o.line_count} {o.line_count === 1 ? "item" : "items"}
              </span>
              <span className="text-right font-money font-semibold text-ink">
                {fmtRm(o.local_total_centi)}
              </span>
              <span className="text-right">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate(`/scm/sales-orders/${o.doc_no}`);
                  }}
                  className="text-[11.5px] font-semibold text-primary hover:underline"
                >
                  Open
                </button>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function Customers() {
  const { data, isLoading, error } = useMfgCustomers();
  const [search, setSearch] = useState("");

  const customers = useMemo<ScmCustomer[]>(() => data?.customers ?? [], [data]);

  // The DataTable `search` prop only renders the input — row filtering is the
  // page's job. Match on name or phone (raw digits), case-insensitive.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return customers;
    return customers.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (c.phone ?? "").toLowerCase().includes(q),
    );
  }, [customers, search]);

  // Header KPI tiles — total customers, aggregate lifetime value, total orders.
  const stats = useMemo(() => {
    let ltvCenti = 0;
    let orders = 0;
    for (const c of customers) {
      ltvCenti += c.lifetime_value_centi;
      orders += c.order_count;
    }
    return { count: customers.length, ltvCenti, orders };
  }, [customers]);

  const columns: Column<ScmCustomer>[] = [
    {
      key: "name",
      label: "Customer",
      width: "240px",
      alwaysVisible: true,
      getValue: (c) => c.name,
      render: (c) => <span className="text-[13px] font-semibold text-ink">{c.name}</span>,
    },
    {
      key: "phone",
      label: "Phone",
      width: "160px",
      getValue: (c) => c.phone ?? "",
      render: (c) => (
        <span className="font-mono text-[12.5px] text-ink-secondary">{c.phone || "—"}</span>
      ),
    },
    {
      key: "orders",
      label: "Orders",
      width: "100px",
      align: "right",
      getValue: (c) => c.order_count,
      render: (c) => (
        <span className="font-money text-[13px] font-semibold text-ink">{c.order_count}</span>
      ),
    },
    {
      key: "ltv",
      label: "Lifetime value",
      width: "150px",
      align: "right",
      getValue: (c) => c.lifetime_value_centi,
      render: (c) => (
        <span className="font-money text-[13px] font-semibold text-ink">
          {fmtRm(c.lifetime_value_centi)}
        </span>
      ),
    },
    {
      key: "last",
      label: "Last order",
      width: "200px",
      getValue: (c) => c.last_order_at,
      render: (c) => (
        <span className="text-[12.5px] text-ink-secondary">
          {formatDate(c.last_order_at)}
          {c.last_order_at ? (
            <span className="ml-1.5 text-ink-muted">· {daysAgo(c.last_order_at)}</span>
          ) : null}
        </span>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Operations · Supply Chain"
        title="Customers"
        description="Read-only directory aggregated from Sales Order history. Search by phone or name, then expand a customer to see every order they've placed. New entries appear automatically when a Sales Order is created."
      />

      <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Customers" value={stats.count.toLocaleString()} rail="bg-primary" />
        <StatCard
          label="Lifetime value"
          value={fmtRm(stats.ltvCenti)}
          subtitle="Across all customers"
          rail="bg-accent"
        />
        <StatCard
          label="Orders"
          value={stats.orders.toLocaleString()}
          subtitle="Non-cancelled sales orders"
          rail="bg-synced"
        />
      </div>

      <DataTable
        tableId="scm-customers"
        columns={columns}
        rows={filtered}
        loading={isLoading}
        error={error ? "Could not load customers. Please try again." : null}
        getRowKey={(c) => c.key}
        exportName="customers"
        caption="Directory · grouped by phone"
        emptyLabel="No customers yet. Each Sales Order adds an entry here."
        search={{
          value: search,
          onChange: setSearch,
          placeholder: "Search by phone or name…",
        }}
        resetFilters={{ active: search.trim().length > 0, onReset: () => setSearch("") }}
        expandable={{ render: (c) => <CustomerHistory customer={c} />, rowKey: (c) => c.key }}
      />
    </div>
  );
}
