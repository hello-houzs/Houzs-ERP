import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { RefreshCw, ArrowRight } from "lucide-react";
import { api } from "../api/client";
import { useQuery } from "../hooks/useQuery";
import { useAuth } from "../auth/AuthContext";
import { Button } from "../components/Button";
import { Badge } from "../components/Badge";
import { cn } from "../lib/utils";

// ── Types for the data this page aggregates ──────────────────
interface InboxItem {
  type: string;
  id: number;
  title: string;
  subtitle: string;
  severity: "info" | "warning" | "error";
  link: string;
}
interface InboxResp {
  my_tasks: InboxItem[];
  review_queue: InboxItem[];
  blockers: InboxItem[];
  this_week: InboxItem[];
  counts: { my_tasks: number; review_queue: number; blockers: number; this_week: number };
}

// ── Helpers ──────────────────────────────────────────────────
function greeting(h: number): string {
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}
const SEV_DOT: Record<string, string> = {
  task: "bg-primary",
  review: "bg-warning-text",
  blocker: "bg-err",
  week: "bg-synced",
};
const SEV_BADGE: Record<string, { tone: "accent" | "warning" | "error" | "success"; label: string }> = {
  task: { tone: "accent", label: "To-do" },
  review: { tone: "warning", label: "Review" },
  blocker: { tone: "error", label: "Urgent" },
  week: { tone: "success", label: "Reminder" },
};

export function Overview() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const inbox = useQuery<InboxResp>(() => api.get("/api/inbox"));
  const assr = useQuery<{ active_count: number; breach_count: number }>(
    () => api.get("/api/assr/summary"),
  );
  const projects = useQuery<{ live_count: number; upcoming_30d: number }>(
    () => api.get("/api/projects/summary"),
  );

  const now = new Date();
  const dateLabel = now
    .toLocaleDateString("en-GB", { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" })
    .toUpperCase();
  const name = user?.name || user?.email?.split("@")[0] || "";

  // Merge the inbox sections into one prioritised "needs me" feed, tagging
  // each row with its kind so we can colour the dot + badge.
  const feed = useMemo(() => {
    const d = inbox.data;
    if (!d) return [] as (InboxItem & { kind: string })[];
    return [
      ...d.blockers.map((i) => ({ ...i, kind: "blocker" })),
      ...d.my_tasks.map((i) => ({ ...i, kind: "task" })),
      ...d.review_queue.map((i) => ({ ...i, kind: "review" })),
      ...d.this_week.map((i) => ({ ...i, kind: "week" })),
    ].slice(0, 8);
  }, [inbox.data]);

  const c = inbox.data?.counts;
  const todoTotal = (c?.my_tasks ?? 0) + (c?.blockers ?? 0);
  const slaRisk = assr.data?.breach_count ?? 0;
  const review = c?.review_queue ?? 0;

  const kpis: { label: string; value: string; sub: string }[] = [
    { label: "Revenue MTD", value: "—", sub: "No source yet" },
    { label: "Outstanding PO", value: "—", sub: "Pending SCM" },
    { label: "Open Cases", value: assr.loading ? "…" : String(assr.data?.active_count ?? 0), sub: `${slaRisk} SLA risks` },
    { label: "Trips Today", value: "—", sub: "Logistics TBD" },
    { label: "Active Projects", value: projects.loading ? "…" : String(projects.data?.live_count ?? 0), sub: `${projects.data?.upcoming_30d ?? 0} due this month` },
  ];

  return (
    <div className="space-y-4">
      {/* ── Focus hero — dark slab with a petrol glow ───────────── */}
      <div className="relative overflow-hidden rounded-2xl bg-sidebar px-6 py-7 text-sidebar-ink shadow-slab sm:px-8">
        <div
          className="pointer-events-none absolute -right-20 -top-24 h-72 w-72 rounded-full opacity-60 blur-2xl"
          style={{ background: "radial-gradient(circle, rgba(22,105,95,0.55), transparent 70%)" }}
        />
        <div className="relative flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <div className="font-mono text-[10px] font-bold uppercase tracking-brand text-accent-bright">
              {dateLabel}
            </div>
            <h1 className="mt-1.5 font-display text-[26px] font-semibold leading-tight sm:text-[28px]">
              {greeting(now.getHours())}, {name}
            </h1>
            <p className="mt-1.5 text-[14px] text-sidebar-ink/90">
              <b className="font-semibold text-sidebar-ink">{todoTotal} items</b> need you today
              {" · "}
              <b className="font-semibold text-sidebar-ink">{slaRisk}</b> SLA risks
              {" · "}
              <b className="font-semibold text-sidebar-ink">{review}</b> pending review
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="primary" icon={<ArrowRight size={14} />} onClick={() => navigate("/assr?view=cases")}>
              View tasks
            </Button>
            <button
              disabled
              title="AutoCount sync coming soon"
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-sidebar-border bg-white/5 px-4 text-[13px] font-semibold text-sidebar-ink/80 disabled:opacity-60"
            >
              <RefreshCw size={14} /> Sync AutoCount
            </button>
          </div>
        </div>
      </div>

      {/* ── KPI ribbon ──────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {kpis.map((k) => (
          <div key={k.label} className="relative overflow-hidden rounded-xl border border-border bg-surface px-4 py-4 shadow-stone">
            <span className="absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-primary/0 via-primary to-primary/0" />
            <div className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-[2px] bg-primary" />
              <span className="font-mono text-[10px] font-semibold uppercase tracking-brand text-ink-muted">{k.label}</span>
            </div>
            <div className="mt-2.5 font-display text-[25px] font-extrabold leading-none tracking-tight text-ink">
              {k.value}
            </div>
            <div className="mt-1.5 text-[11px] text-ink-muted">{k.sub}</div>
          </div>
        ))}
      </div>

      {/* ── Two columns: needs-me feed + pipeline/P&L ───────────── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.3fr_1fr]">
        {/* Needs me */}
        <div className="rounded-xl border border-border bg-surface p-4 shadow-stone sm:p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-[15px] font-bold text-ink">Needs you</h2>
            <span className="font-mono text-[11px] text-ink-muted">{feed.length} items</span>
          </div>
          {inbox.loading && !inbox.data ? (
            <div className="py-8 text-center text-[12px] text-ink-muted">Loading…</div>
          ) : feed.length === 0 ? (
            <div className="py-8 text-center text-[12px] text-ink-muted">Inbox zero — nothing needs you 🎉</div>
          ) : (
            <ul className="divide-y divide-border-subtle">
              {feed.map((item) => {
                const badge = SEV_BADGE[item.kind];
                return (
                  <li key={`${item.kind}-${item.type}-${item.id}`}>
                    <button
                      onClick={() => item.link && navigate(item.link)}
                      className="group flex w-full items-center gap-3 py-2.5 text-left"
                    >
                      <span className={cn("mt-0.5 h-2 w-2 shrink-0 rounded-full", SEV_DOT[item.kind] ?? "bg-ink-muted")} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13.5px] font-semibold text-ink group-hover:text-primary">{item.title}</div>
                        <div className="truncate text-[11.5px] text-ink-muted">{item.subtitle}</div>
                      </div>
                      <Badge tone={badge.tone} variant="soft">{badge.label}</Badge>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Pipeline + P&L (data sources pending — shown honestly) */}
        <div className="space-y-4">
          <div className="rounded-xl border border-border bg-surface p-4 shadow-stone sm:p-5">
            <h2 className="mb-3 text-[15px] font-bold text-ink">Sales Pipeline</h2>
            <div className="rounded-lg border border-dashed border-border bg-surface-2 px-4 py-6 text-center text-[12px] text-ink-muted">
              No data yet — shows once the pipeline API is wired.
            </div>
          </div>
          <div className="rounded-xl border border-primary/30 bg-primary-soft p-4 shadow-stone sm:p-5">
            <div className="font-mono text-[10px] font-bold uppercase tracking-brand text-primary-ink">P&amp;L This Month</div>
            <div className="mt-1.5 font-display text-[30px] font-extrabold leading-none text-primary-ink">—</div>
            <div className="mt-1.5 text-[11px] text-primary-ink/70">Shows once the finance API is wired</div>
          </div>
        </div>
      </div>
    </div>
  );
}
