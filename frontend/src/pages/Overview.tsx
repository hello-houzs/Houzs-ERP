import {
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  Inbox as InboxIcon,
  MessageSquare,
  Flag,
  Calendar,
  ChevronRight,
  TrendingUp,
  ShieldAlert,
  Clock,
  Hourglass,
} from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { Button } from "../components/Button";
import { TabStrip, type TabOption } from "../components/TabStrip";
import { PnlCalendar } from "../components/PnlCalendar";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { useAuth } from "../auth/AuthContext";
import { api } from "../api/client";
import { formatCurrency, formatDate, cn } from "../lib/utils";
import type {
  OrdersSummary,
  POSummary,
  BalanceSummary,
  AssrSummary,
} from "../types";

// ── Inbox types (local) ─────────────────────────────────────

interface InboxItem {
  type: string;
  id: number;
  title: string;
  subtitle: string;
  severity: "info" | "warning" | "error";
  due_date?: string | null;
  link: string;
  meta?: Record<string, any>;
}

interface InboxResponse {
  my_tasks: InboxItem[];
  review_queue: InboxItem[];
  blockers: InboxItem[];
  this_week: InboxItem[];
  counts: {
    my_tasks: number;
    review_queue: number;
    blockers: number;
    this_week: number;
  };
}

type SummaryTab = "briefing" | "action" | "pipeline";

export function Overview() {
  const toast = useToast();
  const { user, can } = useAuth();
  const inbox = useQuery<InboxResponse>(() => api.get("/api/inbox"));
  const orders = useQuery<OrdersSummary>(() => api.get("/api/orders/summary"));
  const po = useQuery<POSummary>(() => api.get("/api/po/summary"));
  const balance = useQuery<BalanceSummary>(() => api.get("/api/balance/summary"));
  const assr = useQuery<AssrSummary>(() => api.get("/api/assr/summary"));

  // Mobile tab state — URL-backed so it survives reload and links. lg+
  // hides the tab bar and renders all three sections stacked, so the
  // value is irrelevant on desktop.
  const [params, setParams] = useSearchParams();
  const tab: SummaryTab =
    params.get("tab") === "action" || params.get("tab") === "pipeline"
      ? (params.get("tab") as SummaryTab)
      : "briefing";
  const setTab = (next: SummaryTab) => {
    const p = new URLSearchParams(params);
    if (next === "briefing") p.delete("tab");
    else p.set("tab", next);
    setParams(p, { replace: true });
  };

  function reloadAll() {
    inbox.reload();
    orders.reload();
    po.reload();
    balance.reload();
    assr.reload();
  }

  const name = (user?.name || user?.email || "").split(" ")[0].split("@")[0];
  const data = inbox.data;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const today = new Date().toISOString().slice(0, 10);
  const todayHuman = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });

  // KPI tiles in the hero — picked for "needs attention now" not vanity.
  const kpis: HeroKpi[] = [
    {
      icon: <InboxIcon size={14} />,
      label: "My tasks",
      value: data?.counts.my_tasks ?? null,
      tone: (data?.counts.my_tasks ?? 0) > 0 ? "accent" : "neutral",
    },
    {
      icon: <Flag size={14} />,
      label: "Blockers",
      value: data?.counts.blockers ?? null,
      tone: (data?.counts.blockers ?? 0) > 0 ? "error" : "positive",
    },
    {
      icon: <ShieldAlert size={14} />,
      label: "SLA breached",
      value: assr.data?.breach_count ?? null,
      tone: (assr.data?.breach_count ?? 0) > 0 ? "error" : "positive",
    },
    {
      icon: <Hourglass size={14} />,
      label: "Expired balance",
      value: balance.data ? formatCurrency(balance.data.expired.total, { compact: true }) : null,
      sub: balance.data ? `${balance.data.expired.count} order${balance.data.expired.count === 1 ? "" : "s"}` : undefined,
      tone:
        balance.data && balance.data.expired.count > 0
          ? "warning"
          : "positive",
    },
  ];

  return (
    <div>
      {/* ── HERO ──────────────────────────────────────────── */}
      <header className="mb-6 sm:mb-8">
        <div className="mb-4 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-brand text-accent">
          <span className="h-px w-6 bg-accent" />
          <span>Daily Briefing · {todayHuman}</span>
        </div>
        <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
          <div className="min-w-0">
            <h1 className="font-display text-[32px] font-extrabold leading-[1.05] tracking-tight text-ink sm:text-[40px] lg:text-[48px]">
              {name ? (
                <>
                  {greeting},{" "}
                  <span className="text-accent">{name}</span>
                </>
              ) : (
                "Overview"
              )}
            </h1>
            <p className="mt-2 max-w-xl text-[13px] leading-relaxed text-ink-secondary">
              Tasks, reviews, and blockers across every module — the day's open
              loops in one place.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              icon={<RefreshCw size={14} />}
              onClick={() => {
                reloadAll();
                toast.success("Refreshed");
              }}
            >
              Refresh
            </Button>
          </div>
        </div>
      </header>

      {/* Inbox load error — surfaced so a silent empty state doesn't hide a bug */}
      {inbox.error && (
        <div className="mb-4 rounded-md border border-err/40 bg-err/5 px-4 py-2 text-[12px] text-err">
          Failed to load inbox: {inbox.error}
        </div>
      )}

      {/* ── MOBILE TAB BAR ─────────────────────────────────
          Sticky under the page topbar (h-14) so dispatchers can switch
          summary slices without scrolling back up. Hidden on lg+ where
          the three sections stack vertically and a tab bar would just
          add chrome. */}
      <div className="sticky top-14 z-10 -mx-4 mb-4 bg-paper px-4 sm:-mx-6 sm:px-6 lg:hidden">
        <TabStrip<SummaryTab>
          value={tab}
          onChange={setTab}
          options={[
            { value: "briefing", label: "Briefing" },
            {
              value: "action",
              label: "Action",
              count: data
                ? data.counts.my_tasks +
                  data.counts.review_queue +
                  data.counts.blockers
                : undefined,
            } as TabOption<SummaryTab>,
            { value: "pipeline", label: "Pipeline" },
          ]}
        />
      </div>

      {/* ── BRIEFING (KPI ribbon) ──────────────────────────
          Mobile: visible only when the Briefing tab is active.
          lg+: always rendered as the first stacked block. */}
      <section className={cn("mb-10", tab !== "briefing" && "hidden lg:block")}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {kpis.map((k, i) => (
            <HeroKpiCard key={i} {...k} />
          ))}
        </div>
      </section>

      {/* ── INBOX (Action) ─────────────────────────────────
          Mobile: visible only when the Action tab is active.
          lg+: always rendered, with its own SectionHeader for desktop
          users who scan the whole page in one pass. */}
      <section className={cn("mb-10", tab !== "action" && "hidden lg:block")}>
        <SectionHeader
          eyebrow="Action"
          title="What needs you"
          hint={data ? `${(data.counts.my_tasks + data.counts.review_queue + data.counts.blockers).toLocaleString()} open` : undefined}
        />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <InboxColumn
            icon={<InboxIcon size={14} />}
            title="My Tasks"
            subtitle="Assigned to you, due soon or overdue"
            emptyLabel="Inbox zero. Nothing assigned or due."
            emptyTone="positive"
            items={data?.my_tasks ?? []}
            loading={inbox.loading}
          />
          <InboxColumn
            icon={<MessageSquare size={14} />}
            title="Review Queue"
            subtitle="Waiting on your approval or decision"
            emptyLabel="Nothing waiting on you."
            emptyTone="positive"
            items={data?.review_queue ?? []}
            loading={inbox.loading}
          />
          <InboxColumn
            icon={<Flag size={14} />}
            title="Blockers"
            subtitle="Stuck, overdue, or unresolved"
            emptyLabel="No blockers."
            emptyTone="positive"
            items={data?.blockers ?? []}
            loading={inbox.loading}
            accent="error"
          />
          <InboxColumn
            icon={<Calendar size={14} />}
            title="This Week"
            subtitle="Events and trips in the next 7 days"
            emptyLabel="No events or trips scheduled."
            emptyTone="neutral"
            items={data?.this_week ?? []}
            loading={inbox.loading}
          />
        </div>
      </section>

      {/* ── PIPELINE ───────────────────────────────────────
          Mobile: visible only when the Pipeline tab is active.
          lg+: always rendered. */}
      <section className={cn("mb-10", tab !== "pipeline" && "hidden lg:block")}>
        <SectionHeader
          eyebrow="Pipeline"
          title="Across the modules"
          hint={`Snapshot · ${formatDate(today)}`}
        />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <PipelineTile
            to="/orders"
            icon={<TrendingUp size={14} />}
            label="Sales Orders"
            value={orders.data ? orders.data.all.total.toLocaleString() : "—"}
            sub={
              orders.data
                ? `${formatCurrency(orders.data.all.total_balance, { compact: true })} outstanding`
                : "Loading…"
            }
          />
          <PipelineTile
            to="/orders"
            icon={<Clock size={14} />}
            label="Ready for Delivery"
            value={orders.data ? orders.data.delivery.total.toLocaleString() : "—"}
            sub={
              orders.data ? `${orders.data.delivery.expiring_7d} expiring in 7 days` : "Loading…"
            }
            tone={orders.data && orders.data.delivery.expired > 0 ? "error" : undefined}
          />
          <PipelineTile
            to="/po"
            icon={<TrendingUp size={14} />}
            label="Open Purchase Orders"
            value={po.data ? (po.data.totals.outstanding_count ?? 0).toLocaleString() : "—"}
            sub={po.data ? `${po.data.overdue} overdue` : "Loading…"}
            tone={po.data && po.data.overdue > 0 ? "error" : undefined}
          />
          <PipelineTile
            to="/assr"
            icon={<MessageSquare size={14} />}
            label="Service Cases"
            value={assr.data ? assr.data.total.toLocaleString() : "—"}
            sub={
              assr.data
                ? `${assr.data.by_status.find((s) => s.status === "Open")?.count ?? 0} open · ${assr.data.aging_count} aging`
                : "Loading…"
            }
            tone={assr.data && assr.data.aging_count > 0 ? "warning" : undefined}
          />
        </div>
      </section>

      {/* ── FINANCIALS ────────────────────────────────────── */}
      {can("projects.read") && (
        <>
          <SectionHeader
            eyebrow="Financials"
            title="Profit & Loss"
            hint="Cash basis · Gross profit"
          />
          <div className="mb-10">
            <PnlCalendar
              scope="all"
              title="P&L — All Sources"
              subtitle="Revenue from sales orders, cost from project ledger + service cases + PO docs."
            />
          </div>
        </>
      )}
    </div>
  );
}

// ── Section header — uppercase eyebrow + title + optional hint ─

function SectionHeader({
  eyebrow,
  title,
  hint,
}: {
  eyebrow: string;
  title: string;
  hint?: string;
}) {
  return (
    <div className="mb-3 flex items-end justify-between gap-3">
      <div>
        <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-brand text-accent">
          <span className="h-px w-4 bg-accent" />
          <span>{eyebrow}</span>
        </div>
        <h2 className="font-display text-[18px] font-extrabold tracking-tight text-ink">
          {title}
        </h2>
      </div>
      {hint && (
        <div className="hidden text-[10.5px] uppercase tracking-wider text-ink-muted sm:block">
          {hint}
        </div>
      )}
    </div>
  );
}

// ── Hero KPI card ────────────────────────────────────────────

interface HeroKpi {
  icon: React.ReactNode;
  label: string;
  value: string | number | null;
  sub?: string;
  tone: "neutral" | "accent" | "positive" | "warning" | "error";
}

function HeroKpiCard({ icon, label, value, sub, tone }: HeroKpi) {
  const accentBar = {
    neutral: "bg-border",
    accent: "bg-accent",
    positive: "bg-synced",
    warning: "bg-amber-500",
    error: "bg-err",
  }[tone];
  const valueClass = {
    neutral: "text-ink",
    accent: "text-accent",
    positive: "text-ink",
    warning: "text-amber-700",
    error: "text-err",
  }[tone];
  const iconClass = {
    neutral: "text-ink-muted",
    accent: "text-accent",
    positive: "text-synced",
    warning: "text-amber-600",
    error: "text-err",
  }[tone];

  const display =
    value === null
      ? "—"
      : typeof value === "number"
      ? value.toLocaleString()
      : value;

  return (
    <div className="relative overflow-hidden rounded-lg border border-border bg-surface px-4 py-3 shadow-stone">
      <span
        className={cn("absolute left-0 top-0 h-full w-[3px]", accentBar)}
        aria-hidden
      />
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
        <span className={iconClass}>{icon}</span>
        <span>{label}</span>
      </div>
      <div className={cn("mt-1.5 font-display text-[26px] font-extrabold leading-none tracking-tight", valueClass)}>
        {display}
      </div>
      {sub && <div className="mt-1 text-[10.5px] text-ink-muted">{sub}</div>}
    </div>
  );
}

// ── Pipeline tile — compact link card ─────────────────────────

function PipelineTile({
  to,
  icon,
  label,
  value,
  sub,
  tone,
}: {
  to: string;
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  tone?: "error" | "warning";
}) {
  const toneCls = tone === "error" ? "text-err" : tone === "warning" ? "text-amber-700" : "text-ink";
  return (
    <Link
      to={to}
      className="group flex flex-col gap-1.5 rounded-lg border border-border bg-surface px-4 py-3 shadow-stone transition-colors hover:border-accent/40 hover:bg-accent-soft/15"
    >
      <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
        <span className="flex items-center gap-1.5">
          <span className="text-accent/80 group-hover:text-accent">{icon}</span>
          {label}
        </span>
        <ChevronRight
          size={12}
          className="opacity-0 transition-opacity group-hover:opacity-100 text-accent"
        />
      </div>
      <div className={cn("font-display text-[22px] font-extrabold leading-none tracking-tight", toneCls)}>
        {value}
      </div>
      <div className="text-[10.5px] text-ink-muted">{sub}</div>
    </Link>
  );
}

// ── Inbox column ─────────────────────────────────────────────

function InboxColumn({
  icon,
  title,
  subtitle,
  items,
  loading,
  emptyLabel,
  emptyTone,
  accent,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  items: InboxItem[];
  loading: boolean;
  emptyLabel: string;
  emptyTone: "positive" | "neutral";
  accent?: "error";
}) {
  const count = items.length;
  const border = accent === "error" && count > 0 ? "border-err/40" : "border-border";
  return (
    <section
      className={cn(
        "flex flex-col overflow-hidden rounded-xl border bg-surface shadow-stone",
        border
      )}
    >
      <header className="flex items-center gap-3 border-b border-border-subtle bg-bg/40 px-4 py-3">
        <span
          className={cn(
            "flex h-7 w-7 items-center justify-center rounded-md",
            accent === "error" && count > 0
              ? "bg-err/10 text-err"
              : count > 0
              ? "bg-accent/10 text-accent"
              : "bg-surface-dim text-ink-muted"
          )}
        >
          {icon}
        </span>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h3 className="font-display text-[13px] font-extrabold text-ink">{title}</h3>
            <span
              className={cn(
                "inline-flex h-5 min-w-[20px] items-center justify-center rounded-full px-1.5 font-mono text-[10px] font-bold",
                accent === "error" && count > 0
                  ? "bg-err text-white"
                  : count > 0
                  ? "bg-accent/15 text-accent"
                  : "bg-surface-dim text-ink-muted"
              )}
            >
              {count}
            </span>
          </div>
          <div className="text-[10.5px] text-ink-muted">{subtitle}</div>
        </div>
      </header>

      <div className="max-h-[420px] overflow-y-auto">
        {loading && (
          <div className="px-4 py-6 text-center text-[11px] text-ink-muted">Loading…</div>
        )}
        {!loading && items.length === 0 && (
          <div className="flex flex-col items-center gap-1 px-4 py-8 text-center">
            {emptyTone === "positive" ? (
              <CheckCircle2 size={18} className="text-synced" />
            ) : (
              <InboxIcon size={18} className="text-ink-muted" />
            )}
            <div className="text-[11.5px] text-ink-muted">{emptyLabel}</div>
          </div>
        )}
        {!loading &&
          items.map((item) => <InboxRow key={`${item.type}-${item.id}`} item={item} />)}
      </div>
    </section>
  );
}

// Decide which row id should drive the destination page's detail
// panel. ASSR/trip items focus on their own id; project sub-rows
// (checklist task / review / defect) focus on the parent project so
// the panel shows where they live.
function focusIdFor(item: InboxItem): number | null {
  switch (item.type) {
    case "assr":
    case "assr_review":
    case "assr_breach":
    case "assr_stuck":
    case "project_upcoming":
    case "trip":
    case "trip_upcoming":
      return item.id;
    case "project_task":
    case "project_review":
    case "project_defect":
      return (item.meta?.project_id as number) ?? null;
    default:
      return null;
  }
}

function buildFocusLink(item: InboxItem): string {
  const fid = focusIdFor(item);
  if (fid == null) return item.link;
  const sep = item.link.includes("?") ? "&" : "?";
  return `${item.link}${sep}focus=${fid}`;
}

function InboxRow({ item }: { item: InboxItem }) {
  const sevDot =
    item.severity === "error"
      ? "bg-err"
      : item.severity === "warning"
      ? "bg-amber-500"
      : "bg-accent/60";
  return (
    <Link
      to={buildFocusLink(item)}
      className="group flex items-start gap-3 border-b border-border-subtle px-4 py-2.5 last:border-b-0 hover:bg-accent-soft/40"
    >
      <span className={cn("mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full", sevDot)} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-[12.5px] font-semibold text-ink">{item.title}</span>
          <TypeChip type={item.type} />
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-ink-secondary">
          <span className="truncate">{item.subtitle}</span>
        </div>
        {item.due_date && (
          <div className="mt-0.5 flex items-center gap-1 text-[10px] text-ink-muted">
            <Calendar size={9} />
            <span>{formatDate(item.due_date)}</span>
            {item.severity === "error" && (
              <span className="ml-1 rounded bg-err/10 px-1 font-bold text-err">
                <AlertTriangle size={8} className="mr-0.5 inline" />
                Overdue
              </span>
            )}
          </div>
        )}
      </div>
      <ChevronRight size={13} className="mt-2 shrink-0 text-ink-muted group-hover:text-accent" />
    </Link>
  );
}

const TYPE_META: Record<string, { label: string; cls: string }> = {
  assr: { label: "ASSR", cls: "bg-purple-100 text-purple-800" },
  assr_review: { label: "ASSR Review", cls: "bg-purple-100 text-purple-800" },
  assr_breach: { label: "ASSR Breach", cls: "bg-red-100 text-red-800" },
  assr_stuck: { label: "ASSR Stuck", cls: "bg-amber-100 text-amber-800" },
  project_task: { label: "Project", cls: "bg-accent-soft text-accent-ink" },
  project_review: { label: "Project Review", cls: "bg-accent-soft text-accent-ink" },
  project_defect: { label: "Defect", cls: "bg-amber-100 text-amber-800" },
  project_upcoming: { label: "Project", cls: "bg-accent-soft text-accent-ink" },
  trip: { label: "Trip", cls: "bg-blue-100 text-blue-800" },
  trip_upcoming: { label: "Trip", cls: "bg-blue-100 text-blue-800" },
};

function TypeChip({ type }: { type: string }) {
  const meta = TYPE_META[type] ?? { label: type, cls: "bg-surface-dim text-ink-muted" };
  return (
    <span
      className={cn(
        "rounded-full px-1.5 py-0 text-[9px] font-bold uppercase tracking-wider",
        meta.cls
      )}
    >
      {meta.label}
    </span>
  );
}
