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
import { formatCurrency, formatDate, cn, APP_TZ, todayInAppTz } from "../lib/utils";
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
  const today = todayInAppTz();
  // en-GB locale puts the day before the month ("Monday, 4 May" rather
  // than en-US's "Monday, May 4"), matching the rest of the SPA's
  // DD/MM date format. Pinned to GMT+8 so the headline reads as
  // Malaysia time regardless of the browser's local zone.
  const todayHuman = new Date().toLocaleDateString("en-GB", {
    timeZone: APP_TZ,
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

  // Inbox columns as data so we can split "needs action" (rendered as
  // cards) from "cleared" (collapsed into one slim strip) — empty cards
  // used to stretch to row height and leave large dead whitespace.
  const actionColumns: InboxColumnConfig[] = [
    {
      key: "my_tasks",
      icon: <InboxIcon size={14} />,
      title: "My Tasks",
      subtitle: "Assigned to you, due soon or overdue",
      items: data?.my_tasks ?? [],
    },
    {
      key: "review_queue",
      icon: <MessageSquare size={14} />,
      title: "Review Queue",
      subtitle: "Waiting on your approval or decision",
      items: data?.review_queue ?? [],
    },
    {
      key: "blockers",
      icon: <Flag size={14} />,
      title: "Blockers",
      subtitle: "Stuck, overdue, or unresolved",
      items: data?.blockers ?? [],
      accent: "error",
    },
    {
      key: "this_week",
      icon: <Calendar size={14} />,
      title: "This Week",
      subtitle: "Events and trips in the next 7 days",
      items: data?.this_week ?? [],
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
            <h1 className="font-display text-[19px] font-extrabold leading-tight tracking-tight text-ink sm:text-[26px] lg:text-[28px]">
              {name ? (
                <>
                  {greeting},{" "}
                  <span className="text-accent">{name}</span>
                </>
              ) : (
                "Overview"
              )}
            </h1>
            <p className="mt-2 max-w-xl text-[12px] leading-relaxed text-ink-secondary sm:text-sm">
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
        {inbox.loading ? (
          <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
            {actionColumns.map((c) => (
              <InboxColumn key={c.key} {...c} loading />
            ))}
          </div>
        ) : (
          <ActionInbox columns={actionColumns} />
        )}
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
        <h2 className="font-display text-[15px] font-bold leading-tight tracking-tight text-ink">
          {title}
        </h2>
      </div>
      {hint && (
        <div className="hidden text-[10.5px] uppercase tracking-brand text-ink-muted sm:block">
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
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
        <span className={iconClass}>{icon}</span>
        <span>{label}</span>
      </div>
      <div className={cn("mt-1.5 font-display text-[22px] font-extrabold leading-none tracking-tight", valueClass)}>
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
      <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
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

// ── Inbox column config ──────────────────────────────────────

interface InboxColumnConfig {
  key: string;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  items: InboxItem[];
  accent?: "error";
}

// ── Action inbox — smart layering ────────────────────────────
// Columns with items render as cards; columns that are clear collapse
// into one slim strip so inbox-zero reads as a light "all clear" line
// instead of large empty cards stretched to the grid row height.

function ActionInbox({ columns }: { columns: InboxColumnConfig[] }) {
  const active = columns.filter((c) => c.items.length > 0);
  const cleared = columns.filter((c) => c.items.length === 0);

  if (active.length === 0) {
    return <ClearedStrip columns={cleared} allClear />;
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
        {active.map((c) => (
          <InboxColumn key={c.key} {...c} loading={false} />
        ))}
      </div>
      {cleared.length > 0 && <ClearedStrip columns={cleared} />}
    </div>
  );
}

function ClearedStrip({
  columns,
  allClear,
}: {
  columns: InboxColumnConfig[];
  allClear?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border px-4 py-3",
        allClear ? "border-synced/30 bg-synced/5" : "border-border-subtle bg-bg/40"
      )}
    >
      <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-brand text-synced">
        <CheckCircle2 size={13} />
        {allClear ? "Inbox zero — nothing needs you" : "All clear"}
      </span>
      <span className="h-3.5 w-px bg-border" aria-hidden />
      {columns.map((c) => (
        <span
          key={c.key}
          className="flex items-center gap-1.5 text-[11.5px] text-ink-secondary"
        >
          <span className="text-ink-muted">{c.icon}</span>
          {c.title}
        </span>
      ))}
    </div>
  );
}

// ── Inbox column ─────────────────────────────────────────────

function InboxColumn({
  icon,
  title,
  subtitle,
  items,
  loading,
  accent,
}: InboxColumnConfig & { loading: boolean }) {
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
            <h3 className="font-display text-[15px] font-bold leading-tight tracking-tight text-ink">{title}</h3>
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
