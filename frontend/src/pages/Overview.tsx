import { useState } from "react";
import {
  RefreshCw,
  AlertTriangle,
  Package,
  CircleDollarSign,
  Database,
  Truck,
  Clock,
  Zap,
  ClipboardList,
  Sparkles,
  Route as RouteIcon,
  CheckCircle2,
} from "lucide-react";
import { Link } from "react-router-dom";
import { PageHeader } from "../components/Layout";
import { StatCard } from "../components/StatCard";
import { Button } from "../components/Button";
import { StatusDot } from "../components/StatusDot";
import { DashboardGrid, DashboardPanels, DashboardBreakdown } from "../components/Dashboard";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { useAuth } from "../auth/AuthContext";
import { api, buildQuery } from "../api/client";
import { formatCurrency, formatDate, relativeTime, cn } from "../lib/utils";
import type {
  ExecutionLog,
  Paginated,
  OrdersSummary,
  POSummary,
  BalanceSummary,
  AssrSummary,
  OverdueSummary,
  Trip,
  PlannerProposal,
  PlannerTrip,
} from "../types";

export function Overview() {
  const toast = useToast();
  const { can } = useAuth();
  const [busy, setBusy] = useState<string | null>(null);

  const orders = useQuery<OrdersSummary>(() => api.get("/api/orders/summary"));
  const po = useQuery<POSummary>(() => api.get("/api/po/summary"));
  const balance = useQuery<BalanceSummary>(() => api.get("/api/balance/summary"));
  const assr = useQuery<AssrSummary>(() => api.get("/api/assr/summary"));
  const overdue = useQuery<OverdueSummary>(() => api.get("/api/overdue/summary"));
  const logs = useQuery<Paginated<ExecutionLog>>(() => api.get("/api/logs?per_page=10"));

  function reloadAll() {
    orders.reload();
    po.reload();
    balance.reload();
    assr.reload();
    overdue.reload();
    logs.reload();
  }

  async function runAction(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    try {
      await fn();
      toast.success(`${label} complete`);
      reloadAll();
    } catch (e: any) {
      toast.error(`${label} failed: ${e?.message || e}`);
    } finally {
      setBusy(null);
    }
  }

  const lastSyncLog = logs.data?.data?.find((l) => l.type.startsWith("PULL")) ?? null;
  const failedLogCount =
    logs.data?.data?.filter((l) => l.status === "FAILED").length ?? 0;

  const o = orders.data?.all;
  const d = orders.data?.delivery;
  const p = po.data;
  const b = balance.data;
  const a = assr.data;
  const ov = overdue.data;

  return (
    <div>
      <PageHeader
        eyebrow="Operations · Dashboard"
        title="Overview"
        description="Today's work, system health, and pipeline activity"
        actions={
          <Button
            variant="secondary"
            icon={<RefreshCw size={14} />}
            onClick={reloadAll}
            disabled={busy !== null}
          >
            Refresh
          </Button>
        }
      />

      {can("trips.read.all") && <TodayPanel />}

      {/* Top-line headline metrics */}
      <DashboardGrid cols={4}>
        <StatCard
          label="Sales Orders"
          value={o ? o.total.toLocaleString() : "—"}
          subtitle={
            o
              ? `${formatCurrency(o.total_balance, { compact: true })} outstanding`
              : "Loading…"
          }
        />
        <StatCard
          label="Ready for Delivery"
          value={d ? d.total.toLocaleString() : "—"}
          subtitle={d ? `${d.expiring_7d} expiring in 7 days` : "Loading…"}
          tone={d && d.expired > 0 ? "error" : "default"}
        />
        <StatCard
          label="Open Purchase Orders"
          value={p ? p.totals.po_count.toLocaleString() : "—"}
          subtitle={p ? `${p.overdue} overdue` : "Loading…"}
          tone={p && p.overdue > 0 ? "error" : "default"}
        />
        <StatCard
          label="Service Cases"
          value={a ? a.total.toLocaleString() : "—"}
          subtitle={
            a
              ? `${a.by_status.find((s) => s.status === "Open")?.count ?? 0} open`
              : "Loading…"
          }
        />
      </DashboardGrid>

      {/* Risk & money */}
      <DashboardGrid cols={4}>
        <StatCard
          label="Outstanding Balance"
          value={b ? formatCurrency(b.totals.total, { compact: true }) : "—"}
          subtitle={b ? `${b.totals.count.toLocaleString()} orders` : "Loading…"}
        />
        <StatCard
          label="Expired Balance"
          value={b ? formatCurrency(b.expired.total, { compact: true }) : "—"}
          subtitle={b ? `${b.expired.count.toLocaleString()} orders` : "Loading…"}
          tone={b && b.expired.count > 0 ? "error" : "default"}
        />
        <StatCard
          label="Overdue Auto-Extended"
          value={ov ? ov.recent_30d.toLocaleString() : "—"}
          subtitle="Last 30 days"
        />
        <StatCard
          label="Last Sync"
          value={lastSyncLog ? relativeTime(lastSyncLog.started_at) : "Never"}
          subtitle={
            lastSyncLog
              ? `${lastSyncLog.type} · ${lastSyncLog.status.toLowerCase()}`
              : " "
          }
          tone={failedLogCount > 0 ? "error" : "default"}
        />
      </DashboardGrid>

      {/* Distribution panels */}
      <DashboardPanels cols={3}>
        <DashboardBreakdown
          title="Sales Orders by Region"
          items={
            o
              ? (["WEST", "EAST", "SG", "OTHER"] as const).map((k) => ({
                  label: k === "OTHER" ? "Other" : k,
                  count: o.by_region[k] ?? 0,
                }))
              : []
          }
        />
        <DashboardBreakdown
          title="Outstanding by Region"
          items={
            b?.by_region.map((r) => ({
              label: r.region,
              count: Math.round(r.total),
            })) ?? []
          }
          formatCount={(n) => formatCurrency(n, { compact: true })}
        />
        <DashboardBreakdown
          title="Top Suppliers (PO)"
          items={p?.top_suppliers.map((t) => ({ label: t.name, count: t.count })) ?? []}
        />
      </DashboardPanels>

      {/* Quick navigation */}
      <div className="mb-8 grid grid-cols-2 gap-2.5 md:grid-cols-3 lg:grid-cols-6">
        {[
          { to: "/orders", label: "Sales Orders", icon: ClipboardList },
          { to: "/delivery-orders", label: "Delivery", icon: Truck },
          { to: "/po", label: "Purchase Orders", icon: Package },
          { to: "/assr", label: "Service", icon: Zap },
          { to: "/balance", label: "Balance", icon: CircleDollarSign },
          { to: "/overdue", label: "Overdue", icon: Clock },
        ].map(({ to, label, icon: Icon }) => (
          <Link
            key={to}
            to={to}
            className={cn(
              "group relative flex items-center gap-2.5 overflow-hidden rounded-md border border-border bg-surface px-4 py-3.5 text-[12px] font-semibold text-ink-secondary shadow-stone transition-all duration-200",
              "hover:-translate-y-px hover:border-accent/40 hover:text-accent hover:shadow-slab"
            )}
          >
            <span className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/30 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
            <Icon size={15} strokeWidth={2.2} className="text-ink-muted transition-colors group-hover:text-accent" />
            <span>{label}</span>
          </Link>
        ))}
      </div>

      {/* Sync actions */}
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          icon={<RefreshCw size={14} />}
          disabled={busy !== null}
          onClick={() => runAction("Sync orders", () => api.post("/api/sync/pull"))}
        >
          {busy === "Sync orders" ? "Syncing…" : "Sync Orders (incremental)"}
        </Button>
        <Button
          variant="secondary"
          icon={<Database size={14} />}
          disabled={busy !== null}
          onClick={() =>
            runAction("Sync all (unfiltered)", () => api.post("/api/sync/pull?mode=all"))
          }
          title="Pulls every order via /SalesOrder/getAll. Slower; use after schema changes or to reset D1."
        >
          {busy === "Sync all (unfiltered)" ? "Syncing…" : "Sync All (unfiltered)"}
        </Button>
        {failedLogCount > 0 && (
          <Button
            variant="danger"
            icon={<AlertTriangle size={14} />}
            disabled={busy !== null}
            onClick={() => runAction("Retry errors", () => api.post("/api/sync/retry-errors"))}
          >
            Retry Errors
          </Button>
        )}
        <Button
          variant="secondary"
          icon={<Package size={14} />}
          disabled={busy !== null}
          onClick={() => runAction("Refresh PO", () => api.post("/api/po/pull"))}
        >
          Refresh PO
        </Button>
      </div>

      {/* Recent activity */}
      <div>
        <div className="mb-3 flex items-center gap-2">
          <span className="h-px w-6 bg-accent" />
          <h2 className="text-[10px] font-semibold uppercase tracking-brand text-accent">
            Recent Activity
          </h2>
        </div>
        <div className="overflow-hidden rounded-md border border-border bg-surface shadow-stone">
          {logs.loading && (
            <div className="px-5 py-6 text-sm text-ink-muted">Loading…</div>
          )}
          {!logs.loading && logs.data && logs.data.data.length === 0 && (
            <div className="px-5 py-6 text-sm text-ink-muted">No recent activity</div>
          )}
          {!logs.loading &&
            logs.data?.data.map((l) => (
              <div
                key={l.id}
                className="flex items-center gap-4 border-b border-border-subtle px-5 py-3.5 text-[13px] last:border-b-0 hover:bg-accent-soft/30"
              >
                <StatusDot
                  variant={
                    l.status === "SYNCED"
                      ? "synced"
                      : l.status === "FAILED"
                      ? "error"
                      : "neutral"
                  }
                />
                <span className="w-36 shrink-0 truncate font-mono text-[10px] uppercase tracking-wider text-ink-muted">
                  {l.type}
                </span>
                <span className="flex-1 truncate text-ink-secondary">{l.message || "—"}</span>
                <span className="shrink-0 font-mono text-[10px] text-ink-muted">
                  {relativeTime(l.started_at)}
                </span>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}

// ── Today panel — dispatcher home block ────────────────────────────

/**
 * The "what do I need to do right now" view, rendered at the top of
 * Overview for any user with trips.read.all. Pulls today's live trips,
 * the current draft proposal, and a count of failed stops so the
 * dispatcher can act before scrolling into the broader pipeline.
 */
function TodayPanel() {
  const today = new Date().toISOString().slice(0, 10);

  const todayTrips = useQuery<Paginated<Trip>>(
    () =>
      api.get(
        `/api/trips${buildQuery({
          date_from: today,
          date_to: today,
          status: "assigned,started,in_progress",
          per_page: 50,
        })}`
      )
  );

  const proposal = useQuery<{ proposal: PlannerProposal | null; trips?: PlannerTrip[] }>(
    () => api.get("/api/planner/current")
  );

  const trips = todayTrips.data?.data ?? [];
  const liveCount = trips.filter((t) => t.status === "started" || t.status === "in_progress").length;
  const assignedCount = trips.filter((t) => t.status === "assigned").length;
  const draftTrips = (proposal.data?.trips ?? []).filter((t) => t.trip_type !== "blocked");
  const blockedCount = proposal.data?.proposal?.summary?.blocked_orders ?? 0;

  return (
    <div className="mb-8 rounded-xl border border-accent/30 bg-accent/[0.03] p-5 shadow-sm">
      <div className="mb-4 flex items-end justify-between gap-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-brand text-accent">
            Today · {formatDate(today)}
          </div>
          <h2 className="font-display text-[18px] font-extrabold tracking-tight text-ink">
            Dispatcher Home
          </h2>
        </div>
        <Link
          to="/trips"
          className="rounded-md border border-border bg-surface px-3 py-1.5 text-[11px] font-semibold text-ink hover:border-accent/40"
        >
          Open Trips →
        </Link>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <TodayTile
          icon={<RouteIcon size={16} />}
          label="Live now"
          value={liveCount}
          tone="warning"
          to="/trips"
          subtitle="In progress / started"
        />
        <TodayTile
          icon={<CheckCircle2 size={16} />}
          label="Assigned today"
          value={assignedCount}
          tone="default"
          to="/trips"
          subtitle="Waiting to start"
        />
        <TodayTile
          icon={<Sparkles size={16} />}
          label="Drafts to review"
          value={draftTrips.length}
          tone={draftTrips.length > 0 ? "accent" : "default"}
          to="/trips"
          subtitle={proposal.data?.proposal ? "Open Drafts tab" : "No draft yet"}
        />
        <TodayTile
          icon={<AlertTriangle size={16} />}
          label="Blocked orders"
          value={blockedCount}
          tone={blockedCount > 0 ? "error" : "default"}
          to="/trips"
          subtitle={blockedCount > 0 ? "Need geocoding" : "All set"}
        />
      </div>

      {trips.length > 0 && (
        <div className="mt-4">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-brand text-ink-secondary">
            Today's trips
          </div>
          <div className="space-y-1.5">
            {trips.slice(0, 6).map((t) => (
              <Link
                key={t.id}
                to="/trips"
                className="flex items-center gap-3 rounded-md border border-border bg-surface px-3 py-2 text-[12px] hover:border-accent/40"
              >
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide",
                    t.status === "in_progress" || t.status === "started"
                      ? "bg-warning-bg text-warning-text"
                      : "bg-accent/10 text-accent"
                  )}
                >
                  {t.status.replace("_", " ")}
                </span>
                <span className="font-mono font-bold text-ink">{t.trip_no}</span>
                <span className="text-ink-secondary">{t.warehouse}</span>
                <span className="text-ink-secondary">· {t.driver_name || "—"}</span>
                <span className="ml-auto font-mono text-ink-secondary">
                  {t.stop_count} stops · {formatCurrency(t.total_revenue, { compact: true })}
                </span>
              </Link>
            ))}
            {trips.length > 6 && (
              <Link to="/trips" className="block text-center text-[11px] font-semibold text-accent">
                + {trips.length - 6} more
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function TodayTile({
  icon,
  label,
  value,
  subtitle,
  tone,
  to,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  subtitle: string;
  tone: "default" | "accent" | "warning" | "error";
  to: string;
}) {
  const toneClass = {
    default: "border-border bg-surface",
    accent: "border-accent/40 bg-accent/5",
    warning: "border-warning-text/40 bg-warning-bg/40",
    error: "border-err/40 bg-err/5",
  }[tone];
  return (
    <Link
      to={to}
      className={cn(
        "group flex flex-col gap-2 rounded-lg border p-3 transition-colors",
        toneClass
      )}
    >
      <div className="flex items-center justify-between">
        <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-secondary">
          {label}
        </div>
        <span className="text-ink-secondary group-hover:text-accent">{icon}</span>
      </div>
      <div className="font-display text-[26px] font-extrabold leading-none text-ink">
        {value}
      </div>
      <div className="text-[10px] text-ink-secondary">{subtitle}</div>
    </Link>
  );
}
