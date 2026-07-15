// ScmDashboard — read-only Sales-lifecycle KPI dashboard for the Supply Chain.
// Ported from 2990's backend Dashboard (mfg_sales_orders summarised into
// lifecycle buckets), adapted to Houzs: it reuses the EXISTING scm endpoints —
// GET /mfg-sales-orders?summary=1 for the lifecycle buckets + "new today", and
// the paginated GET /mfg-sales-orders (page 0) for the full-set money aggregates
// (revenue / outstanding / collected) + total-order + status counts. Both are
// company + sales-scope scoped server-side. No new backend, no mutations.
//
// Composed with the real Houzs DS primitives (PageHeader / StatCard), DD/MM/YYYY
// dates, no emoji.

import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Inbox, ArrowRightCircle, CheckCircle2 } from "lucide-react";
import { PageHeader } from "../../components/Layout";
import { StatCard } from "../../components/StatCard";
import { useAuth } from "../../auth/AuthContext";
import {
  useMfgSalesOrdersSummary,
  useMfgSalesOrdersPaged,
  type SoSummaryRow,
} from "../../vendor/scm/lib/sales-order-queries";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmtRm = (centi: number): string =>
  `RM ${(centi / 100).toLocaleString("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

// SO lifecycle bucket (2990 parity). The summary feed already excludes DRAFT.
// CONFIRMED without a proceeded_at stamp is "placed" (awaiting the salesperson's
// proceed); with it, or any production/terminal status, it moves along.
// ON_HOLD / CANCELLED bucket to null (excluded from every count).
type SoBucket = "placed" | "proceed" | "delivered";
const bucketFor = (o: SoSummaryRow): SoBucket | null => {
  if (o.status === "DELIVERED" || o.status === "INVOICED" || o.status === "CLOSED") return "delivered";
  if (o.status === "IN_PRODUCTION" || o.status === "READY_TO_SHIP" || o.status === "SHIPPED") return "proceed";
  if (o.status === "CONFIRMED") return o.proceeded_at ? "proceed" : "placed";
  return null;
};

const isToday = (iso: string | null | undefined): boolean => {
  if (!iso) return false;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return false;
  const t = new Date();
  return (
    d.getFullYear() === t.getFullYear() &&
    d.getMonth() === t.getMonth() &&
    d.getDate() === t.getDate()
  );
};

const greetingForHour = (h: number): string => {
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
};

// ─── Lifecycle bucket card ────────────────────────────────────────────────────

function BucketCard({
  icon: Icon,
  label,
  count,
  hint,
  onClick,
}: {
  icon: typeof Inbox;
  label: string;
  count: number;
  hint: string;
  onClick?: () => void;
}) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className="group flex items-center gap-4 rounded-lg border border-border bg-surface px-5 py-4 text-left shadow-stone transition-all duration-200 hover:-translate-y-px hover:border-primary/40 hover:shadow-slab"
    >
      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-surface-2 text-ink-secondary transition-colors group-hover:bg-primary-soft group-hover:text-primary">
        <Icon size={20} strokeWidth={1.75} />
      </span>
      <div className="min-w-0">
        <div className="font-display text-[26px] font-extrabold leading-none text-ink">
          {count.toLocaleString()}
        </div>
        <div className="mt-1 text-[12.5px] font-semibold text-ink">{label}</div>
        <div className="text-[11px] text-ink-muted">{hint}</div>
      </div>
    </Tag>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function ScmDashboard() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const summaryQ = useMfgSalesOrdersSummary();
  // Page 0 with a minimal pageSize — we only read the full-set `aggregates`,
  // `statusCounts` and `total`, all computed server-side over the whole scoped
  // set regardless of page size (see the SO list contract). Rows are ignored.
  const pagedQ = useMfgSalesOrdersPaged({ page: 0, pageSize: 1 });

  const list = useMemo<SoSummaryRow[]>(
    () => summaryQ.data?.salesOrders ?? [],
    [summaryQ.data],
  );

  const counts = useMemo(() => {
    const c = { placed: 0, proceed: 0, delivered: 0 };
    for (const o of list) {
      const b = bucketFor(o);
      if (b) c[b]++;
    }
    return c;
  }, [list]);

  const newToday = useMemo(
    () => list.filter((o) => isToday(o.created_at ?? o.so_date)).length,
    [list],
  );

  const aggregates = pagedQ.data?.aggregates;
  const totalOrders = pagedQ.data?.total ?? 0;

  const firstName = user?.name?.split(" ")[0] ?? "there";
  const needsAttention = counts.placed;
  const goList = (status?: string) =>
    navigate(status ? `/scm/sales-orders?status=${status}` : "/scm/sales-orders");

  const loading = summaryQ.isLoading || pagedQ.isLoading;

  return (
    <div>
      <PageHeader
        eyebrow="Operations · Supply Chain"
        title="Dashboard"
        description={`${greetingForHour(new Date().getHours())}, ${firstName}. ${needsAttention} ${
          needsAttention === 1 ? "order needs" : "orders need"
        } a careful look today — ${newToday} placed today.`}
      />

      {summaryQ.error || pagedQ.error ? (
        <div className="rounded-lg border border-err/30 bg-err-bg px-5 py-4 text-[13px] text-err">
          Could not load the dashboard. Please try again.
        </div>
      ) : (
        <>
          {/* Money KPIs — full-set, server-computed over the whole scoped set. */}
          <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label="Total orders"
              value={loading ? "…" : totalOrders.toLocaleString()}
              subtitle="All sales orders"
              rail="bg-primary"
            />
            <StatCard
              label="Revenue"
              value={loading || !aggregates ? "…" : fmtRm(aggregates.revenueCenti)}
              subtitle="Order value, all orders"
              rail="bg-synced"
            />
            <StatCard
              label="Outstanding"
              value={loading || !aggregates ? "…" : fmtRm(aggregates.outstandingCenti)}
              subtitle="Unpaid balance"
              tone="warning"
              rail="bg-accent-bright"
            />
            <StatCard
              label="Collected"
              value={loading || !aggregates ? "…" : fmtRm(aggregates.paidCenti)}
              subtitle="Payments received"
              tone="success"
              rail="bg-accent"
            />
          </div>

          {/* Lifecycle buckets — order counts by stage. */}
          <div className="mb-2.5 flex items-center gap-2">
            <h2 className="font-mono text-[10px] font-bold uppercase tracking-brand text-ink-muted">
              Order lifecycle
            </h2>
            <span className="h-px flex-1 bg-border-subtle" />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <BucketCard
              icon={Inbox}
              label="Order placed"
              count={counts.placed}
              hint="Confirmed, awaiting proceed"
              onClick={() => goList("confirmed")}
            />
            <BucketCard
              icon={ArrowRightCircle}
              label="In proceed"
              count={counts.proceed}
              hint="Proceeded — in production or shipping"
              onClick={() => goList()}
            />
            <BucketCard
              icon={CheckCircle2}
              label="Delivered"
              count={counts.delivered}
              hint="Delivered, invoiced or closed"
              onClick={() => goList()}
            />
          </div>
        </>
      )}
    </div>
  );
}
