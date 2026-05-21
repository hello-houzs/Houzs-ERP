import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Star, TrendingUp, AlertTriangle, Clock, CheckCircle2, Activity, Smile, Hourglass, ExternalLink } from "lucide-react";
import { FilterPills } from "../components/FilterPills";
import { StatCard } from "../components/StatCard";
import { DashboardGrid, DashboardPanels, DashboardBreakdown } from "../components/Dashboard";
import { Panel } from "../components/Panel";
import { ListSkeleton } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { useQuery } from "../hooks/useQuery";
import { api } from "../api/client";
import { cn, formatDate } from "../lib/utils";
import { resolutionLabel } from "../components/StatusDot";
import type { AssrMetrics } from "../types";

// v3.1 enriched summary (mig 074 stage names + new aggregates)
type AssrSummaryV31 = {
  total: number;
  by_stage: { stage: string; count: number }[];
  pending_review_count: number;
  aging_count: number;
  breach_count: number;
  avg_e2e_days: number | null;
  stage_funnel: { stage: string; total: number; breached: number }[];
  csat_trend: { week: string; avg_rating: number; n: number }[];
};

const STAGE_FUNNEL_ORDER = [
  "pending_review",
  "under_verification",
  "pending_solution",
  "pending_inspection",
  "pending_item_pickup",
  "pending_supplier_pickup",
  "pending_item_ready",
  "pending_delivery_service",
  "completed",
] as const;

const STAGE_FUNNEL_LABEL: Record<string, string> = {
  pending_review: "Pending Review",
  under_verification: "Under Verification",
  pending_solution: "Pending Solution",
  pending_inspection: "Pending Inspection",
  pending_item_pickup: "Pending Item Pickup",
  pending_supplier_pickup: "Pending Supplier Pickup",
  pending_item_ready: "Pending Item Ready",
  pending_delivery_service: "Pending Delivery / Service",
  completed: "Completed",
};

const NCR_LABEL: Record<string, string> = {
  material_defect: "Material Defect",
  workmanship: "Workmanship",
  transit_damage: "Transit Damage",
  design: "Design",
  installation: "Installation",
  customer_misuse: "Customer Misuse",
  other: "Other",
  unclassified: "Unclassified",
};

function ncrLabel(k: string) {
  return NCR_LABEL[k] ?? k;
}

// Drill metric → user-facing panel title. Only metrics listed here
// (and accepted by the backend /metrics/drill endpoint) are clickable.
const DRILL_LABELS: Record<string, string> = {
  pending_review: "Pending Review — cases",
  aging: "Aging > 3 days — cases stuck in a stage",
  breach_now: "SLA Breached now — open cases past deadline",
  open_now: "Open — cases still in progress",
  total_period: "Total cases in period",
  closed_period: "Closed cases in period",
  breach_period: "SLA Breached in period",
  qa_passed: "QA Passed — manager-signed-off cases",
  opening_count: "Opening cases — all open",
  over_1_month: "Open ≥ 30 days",
  over_3_weeks: "Open 21–29 days",
  over_2_weeks: "Open 14–20 days",
};

// Drill state — for metric-only drills (e.g. "pending_review") just the
// metric name is enough. For row-driven drills (Repeat Customers /
// Items) we also carry the row identity + an override title so the
// panel header reads the customer's name instead of a generic label.
type DrillState =
  | { metric: string; title?: string; extra?: Record<string, string> };

export function ServiceMetrics() {
  const [since, setSince] = useState<"30" | "90" | "180" | "365">("90");
  const [drill, setDrill] = useState<DrillState | null>(null);

  const metrics = useQuery<AssrMetrics>(
    () => api.get(`/api/assr/metrics?since_days=${since}`),
    [since]
  );
  // v3.1 — pull the enriched /summary alongside the legacy metrics
  // payload. Both share the same since_days filter so the pulse row
  // and Stage Funnel narrow with the dropdown. CSAT trend on the
  // summary is still a fixed 13-week rolling window (it's a trend
  // chart, not a window-aware stat).
  const summary = useQuery<AssrSummaryV31>(
    () => api.get(`/api/assr/summary?since_days=${since}`),
    [since]
  );

  const m = metrics.data;
  const h = m?.headline;
  const s = summary.data;

  const completionRate = useMemo(() => {
    if (!h || !h.total) return null;
    return Math.round((h.closed / h.total) * 100);
  }, [h]);

  return (
    <div>
      <div className="mb-4">
        <FilterPills
          value={since}
          onChange={setSince}
          options={[
            { value: "30", label: "Last 30d" },
            { value: "90", label: "Last 90d" },
            { value: "180", label: "Last 180d" },
            { value: "365", label: "Last 12m" },
          ]}
        />
      </div>

      {/* v3.1 Pulse — real-time per-stage health. Lives above the
          windowed metrics so dispatchers see "what's wrong NOW"
          before the period-aggregates. */}
      <DashboardGrid cols={4}>
        <StatCard
          label="Pending Review"
          value={s ? s.pending_review_count.toLocaleString() : "—"}
          subtitle="Cases awaiting triage"
          tone={(s?.pending_review_count ?? 0) > 0 ? "warning" : "default"}
          onClick={() => setDrill({ metric: "pending_review" })}
        />
        <StatCard
          label="Aging > 3 days"
          value={s ? s.aging_count.toLocaleString() : "—"}
          subtitle="Open cases stuck in a stage"
          tone={(s?.aging_count ?? 0) > 0 ? "warning" : "default"}
          onClick={() => setDrill({ metric: "aging" })}
        />
        <StatCard
          label="SLA Breached (now)"
          value={s ? s.breach_count.toLocaleString() : "—"}
          subtitle="Past deadline, not yet closed"
          tone={(s?.breach_count ?? 0) > 0 ? "error" : "default"}
          onClick={() => setDrill({ metric: "breach_now" })}
        />
        <StatCard
          label="Avg E2E Lead Time"
          value={s?.avg_e2e_days != null ? `${s.avg_e2e_days.toFixed(1)}d` : "—"}
          subtitle={`Created → closed, last ${since}d`}
        />
      </DashboardGrid>

      {/* Stage Funnel — proposal §11.2 */}
      <div className="mb-6 rounded-lg border border-border bg-surface p-5">
        <div className="mb-3 flex items-center gap-2">
          <Activity size={14} className="text-accent" />
          <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
            Stage Funnel
          </div>
        </div>
        {s && s.stage_funnel.length > 0 ? (
          <StageFunnel data={s.stage_funnel} />
        ) : (
          <div className="py-4 text-[12px] text-ink-muted">No open cases right now.</div>
        )}
      </div>

      {/* CSAT trend — proposal §11.2 */}
      <div className="mb-6 rounded-lg border border-border bg-surface p-5">
        <div className="mb-3 flex items-center gap-2">
          <Smile size={14} className="text-accent" />
          <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
            CSAT — 13-week rolling
          </div>
        </div>
        {s && s.csat_trend.length > 0 ? (
          <CsatTrend data={s.csat_trend} />
        ) : (
          <div className="py-4 text-[12px] text-ink-muted">
            No survey responses in the last 13 weeks.
          </div>
        )}
      </div>

      <DashboardGrid cols={4}>
        <StatCard
          label="Total Cases"
          value={h ? h.total.toLocaleString() : "—"}
          subtitle={`Period: ${m?.since_days ?? since} days`}
          onClick={() => setDrill({ metric: "total_period" })}
        />
        <StatCard
          label="Completion Rate"
          value={completionRate != null ? `${completionRate}%` : "—"}
          subtitle={h ? `${h.closed.toLocaleString()} of ${h.total.toLocaleString()} closed` : " "}
          tone={completionRate != null && completionRate >= 80 ? "success" : "default"}
          onClick={() => setDrill({ metric: "closed_period" })}
        />
        <StatCard
          label="SLA Breached"
          value={h ? h.breached.toLocaleString() : "—"}
          subtitle="Open cases past deadline"
          tone={(h?.breached ?? 0) > 0 ? "error" : "default"}
          onClick={() => setDrill({ metric: "breach_period" })}
        />
        <StatCard
          label="Avg Satisfaction"
          value={h?.avg_satisfaction != null ? `${h.avg_satisfaction.toFixed(2)} / 5` : "—"}
          subtitle="Customer rating on close"
        />
      </DashboardGrid>

      <DashboardGrid cols={3}>
        <StatCard
          label="QA Passed"
          value={h ? h.qa_passed.toLocaleString() : "—"}
          subtitle="Cases with manager sign-off"
          onClick={() => setDrill({ metric: "qa_passed" })}
        />
        <StatCard
          label="Avg Resolution"
          value={
            h?.avg_resolution_hours != null
              ? h.avg_resolution_hours >= 24
                ? `${(h.avg_resolution_hours / 24).toFixed(1)}d`
                : `${Math.round(h.avg_resolution_hours)}h`
              : "—"
          }
          subtitle="Created → closed"
        />
        <StatCard
          label="Open"
          value={h ? h.open_count.toLocaleString() : "—"}
          subtitle="Still in progress"
          onClick={() => setDrill({ metric: "open_now" })}
        />
      </DashboardGrid>

      {/* Case Duration — mirrors the legacy Excel "Case Duration" tile.
          Bucketed by age of OPEN cases since complained_date. */}
      <div className="mb-6 rounded-lg border border-border bg-surface p-5">
        <div className="mb-3 flex items-center gap-2">
          <Hourglass size={14} className="text-accent" />
          <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
            Case Duration
          </div>
        </div>
        <DashboardGrid cols={5}>
          <StatCard
            label="Opening Cases"
            value={m?.case_duration?.opening_count != null
              ? m.case_duration.opening_count.toLocaleString()
              : "—"}
            subtitle="Currently open"
            onClick={() => setDrill({ metric: "opening_count" })}
          />
          <StatCard
            label="Over 1 month"
            value={m?.case_duration?.over_1_month != null
              ? m.case_duration.over_1_month.toLocaleString()
              : "—"}
            subtitle="Aged ≥ 30 days"
            tone={(m?.case_duration?.over_1_month ?? 0) > 0 ? "error" : "default"}
            onClick={() => setDrill({ metric: "over_1_month" })}
          />
          <StatCard
            label="Over 3 weeks"
            value={m?.case_duration?.over_3_weeks != null
              ? m.case_duration.over_3_weeks.toLocaleString()
              : "—"}
            subtitle="21–29 days old"
            tone={(m?.case_duration?.over_3_weeks ?? 0) > 0 ? "warning" : "default"}
            onClick={() => setDrill({ metric: "over_3_weeks" })}
          />
          <StatCard
            label="Over 2 weeks"
            value={m?.case_duration?.over_2_weeks != null
              ? m.case_duration.over_2_weeks.toLocaleString()
              : "—"}
            subtitle="14–20 days old"
            tone={(m?.case_duration?.over_2_weeks ?? 0) > 0 ? "warning" : "default"}
            onClick={() => setDrill({ metric: "over_2_weeks" })}
          />
          <StatCard
            label="Avg / month"
            value={
              m?.case_duration?.avg_per_month != null
                ? m.case_duration.avg_per_month.toFixed(2)
                : "—"
            }
            subtitle="Last 4 months"
          />
        </DashboardGrid>
      </div>

      <DashboardPanels cols={2}>
        <DashboardBreakdown
          title="Service Issue Categories"
          items={
            m?.issue_categories?.map((r) => ({
              label: r.category || "Other",
              count: r.count,
            })) ?? []
          }
        />
        <DashboardBreakdown
          title="Resolution Method Mix"
          items={m?.resolutions.map((r) => ({ label: resolutionLabel(r.method === "unset" ? null : r.method), count: r.count })) ?? []}
        />
      </DashboardPanels>

      <DashboardPanels cols={1}>
        <DashboardBreakdown
          title="NCR Categories (root-cause)"
          items={m?.ncr.map((r) => ({ label: ncrLabel(r.category), count: r.count })) ?? []}
        />
      </DashboardPanels>

      {/* Monthly trend */}
      <div className="mb-6 rounded-lg border border-border bg-surface p-5">
        <div className="mb-3 flex items-center gap-2">
          <TrendingUp size={14} className="text-accent" />
          <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
            Monthly Trend
          </div>
        </div>
        {m && m.monthly_trend.length > 0 ? (
          <Trend data={m.monthly_trend} />
        ) : (
          <div className="py-4 text-[12px] text-ink-muted">Not enough data</div>
        )}
      </div>

      {/* Creditor performance */}
      <div className="mb-6 rounded-lg border border-border bg-surface">
        <div className="flex items-center gap-2 border-b border-border px-5 py-3">
          <CheckCircle2 size={14} className="text-accent" />
          <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
            Creditor Performance
          </div>
        </div>
        {m && m.creditor_performance.length > 0 ? (
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-ink-muted">
                <th className="px-5 py-2 font-semibold">Creditor</th>
                <th className="px-3 py-2 text-right font-semibold">Cases</th>
                <th className="px-3 py-2 text-right font-semibold">Closed</th>
                <th className="px-3 py-2 text-right font-semibold">Breached</th>
                <th className="px-3 py-2 text-right font-semibold">Avg Resolution</th>
                <th className="px-3 py-2 text-right font-semibold">Rating</th>
              </tr>
            </thead>
            <tbody>
              {m.creditor_performance.map((s) => (
                <tr key={s.creditor_code} className="border-t border-border">
                  <td className="px-5 py-2">
                    <div className="font-semibold">{s.name || s.creditor_code}</div>
                    <div className="font-mono text-[10px] text-ink-muted">{s.creditor_code}</div>
                  </td>
                  <td className="px-3 py-2 text-right font-mono">{s.total_cases}</td>
                  <td className="px-3 py-2 text-right font-mono text-synced">{s.closed_cases}</td>
                  <td className={cn("px-3 py-2 text-right font-mono", s.breached > 0 ? "font-bold text-err" : "text-ink-muted")}>
                    {s.breached}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {s.avg_resolution_hours != null
                      ? s.avg_resolution_hours >= 24
                        ? `${(s.avg_resolution_hours / 24).toFixed(1)}d`
                        : `${Math.round(s.avg_resolution_hours)}h`
                      : "—"}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {s.avg_rating != null ? (
                      <span className="inline-flex items-center gap-1">
                        <Star size={10} className="fill-amber-400 text-amber-400" />
                        <span className="font-mono">{s.avg_rating.toFixed(1)}</span>
                      </span>
                    ) : (
                      <span className="text-ink-muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="px-5 py-4 text-[12px] text-ink-muted">No creditor assignments in this period</div>
        )}
      </div>

      <DashboardPanels cols={2}>
        {/* Repeat items */}
        <div className="rounded-lg border border-border bg-surface">
          <div className="flex items-center gap-2 border-b border-border px-5 py-3">
            <AlertTriangle size={14} className="text-err" />
            <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
              Repeat-Issue Items (≥ 2 cases)
            </div>
          </div>
          {m && m.repeat_items.length > 0 ? (
            <ul>
              {m.repeat_items.map((r) => (
                <li key={r.item_code} className="border-b border-border last:border-b-0">
                  <button
                    type="button"
                    onClick={() =>
                      setDrill({
                        metric: "item_cases",
                        title: `${r.item_code} — ${r.cases} cases in period`,
                        extra: { item_code: r.item_code },
                      })
                    }
                    className="flex w-full items-center gap-3 px-5 py-2 text-left text-[12px] transition-colors hover:bg-bg/60"
                  >
                    <span className="font-mono text-[11px] font-semibold">{r.item_code}</span>
                    <span className="ml-auto text-ink-muted">last: {formatDate(r.latest)}</span>
                    <span className="rounded-full bg-err/10 px-2 py-0.5 text-[11px] font-bold text-err">
                      {r.cases}×
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="px-5 py-4 text-[12px] text-ink-muted">No repeat items in this period</div>
          )}
        </div>

        {/* Repeat customers */}
        <div className="rounded-lg border border-border bg-surface">
          <div className="flex items-center gap-2 border-b border-border px-5 py-3">
            <Clock size={14} className="text-err" />
            <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
              Repeat Customers (≥ 2 cases)
            </div>
          </div>
          {m && m.repeat_customers.length > 0 ? (
            <ul>
              {m.repeat_customers.map((r, i) => (
                <li key={i} className="border-b border-border last:border-b-0">
                  <button
                    type="button"
                    onClick={() => {
                      const extra: Record<string, string> = { customer_name: r.customer_name };
                      if (r.phone) extra.phone = r.phone;
                      setDrill({
                        metric: "customer_cases",
                        title: `${r.customer_name} — ${r.cases} cases in period`,
                        extra,
                      });
                    }}
                    className="flex w-full items-center gap-3 px-5 py-2 text-left text-[12px] transition-colors hover:bg-bg/60"
                  >
                    <span className="flex-1 truncate font-semibold">{r.customer_name}</span>
                    <span className="text-[11px] text-ink-muted">last: {formatDate(r.latest)}</span>
                    <span className="rounded-full bg-err/10 px-2 py-0.5 text-[11px] font-bold text-err">
                      {r.cases}×
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="px-5 py-4 text-[12px] text-ink-muted">No repeat customers in this period</div>
          )}
        </div>
      </DashboardPanels>

      {drill && (
        <DrillPanel
          drill={drill}
          sinceDays={parseInt(since, 10)}
          onClose={() => setDrill(null)}
        />
      )}
    </div>
  );
}

// ── Metric drill-down panel ────────────────────────────────────
//
// Fetches `/api/assr/metrics/drill?metric=…` and renders the matching
// cases. Mounted only when `drill` is set so the fetch fires once per
// open instead of on every render.

type DrillCase = {
  id: number;
  assr_no: string;
  customer_name: string | null;
  stage: string;
  priority: string | null;
  complained_date: string | null;
  deadline_at: string | null;
  issue_category: string | null;
  creditor_code: string | null;
  creditor_name: string | null;
  age_days: number | null;
  is_breached: number;
};

function DrillPanel({
  drill,
  sinceDays,
  onClose,
}: {
  drill: DrillState;
  sinceDays: number;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [data, setData] = useState<{ cases: DrillCase[]; limited: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Serialise `extra` so the effect re-runs when its values change.
  // String-key form keeps the equality check stable across re-renders.
  const extraKey = drill.extra
    ? Object.entries(drill.extra)
        .map(([k, v]) => `${k}=${v}`)
        .join("&")
    : "";

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    const params = new URLSearchParams({
      metric: drill.metric,
      since_days: String(sinceDays),
    });
    if (drill.extra) {
      for (const [k, v] of Object.entries(drill.extra)) params.set(k, v);
    }
    api
      .get<{ cases: DrillCase[]; limited: boolean }>(
        `/api/assr/metrics/drill?${params.toString()}`
      )
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: any) => {
        if (!cancelled) setErr(e?.message || "Failed to load");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [drill.metric, sinceDays, extraKey]);

  const title = drill.title ?? DRILL_LABELS[drill.metric] ?? drill.metric;
  const count = data?.cases.length ?? 0;

  return (
    <Panel
      open
      onClose={onClose}
      title={title}
      subtitle={loading ? "Loading…" : `${count} case${count === 1 ? "" : "s"}${data?.limited ? " (showing first 100)" : ""}`}
      width={560}
    >
      {loading ? (
        <ListSkeleton rows={6} />
      ) : err ? (
        <div className="rounded-md border border-err/40 bg-err/5 p-3 text-[12px] text-err">
          {err}
        </div>
      ) : !data || data.cases.length === 0 ? (
        <EmptyState compact message="No cases match this metric." />
      ) : (
        <ul className="divide-y divide-border">
          {data.cases.map((cs) => (
            <li key={cs.id}>
              <button
                type="button"
                onClick={() => {
                  onClose();
                  navigate(`/assr/${cs.id}`);
                }}
                className="group flex w-full items-start gap-3 px-1 py-2.5 text-left transition-colors hover:bg-bg/60"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[12px] font-semibold text-ink">
                      {cs.assr_no}
                    </span>
                    {cs.is_breached === 1 && (
                      <span className="rounded bg-err/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-err">
                        Breached
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 truncate text-[12px] text-ink">
                    {cs.customer_name || "—"}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px] text-ink-muted">
                    <span>{STAGE_FUNNEL_LABEL[cs.stage] ?? cs.stage}</span>
                    {cs.complained_date && (
                      <>
                        <span>·</span>
                        <span>{formatDate(cs.complained_date)}</span>
                      </>
                    )}
                    {cs.age_days != null && (
                      <>
                        <span>·</span>
                        <span>{Math.floor(cs.age_days)}d old</span>
                      </>
                    )}
                    {(cs.creditor_name || cs.creditor_code) && (
                      <>
                        <span>·</span>
                        <span className="truncate">{cs.creditor_name || cs.creditor_code}</span>
                      </>
                    )}
                  </div>
                </div>
                <ExternalLink
                  size={12}
                  className="mt-1 shrink-0 text-ink-muted opacity-0 transition-opacity group-hover:opacity-100"
                />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// ── Simple trend chart (CSS bar chart, no deps) ─────────────

function Trend({ data }: { data: AssrMetrics["monthly_trend"] }) {
  const max = Math.max(...data.map((d) => Math.max(d.opened, d.closed)), 1);
  return (
    <div className="flex gap-1.5 h-40">
      {/* Columns: stretched to full parent height (default `items-stretch`)
          so the bars area below can use `flex-1` to consume all space minus
          the month label. The earlier `items-end` + child `h-full` combo
          collapsed bars to 0 because the column had no height to inherit. */}
      {data.map((d) => {
        const openedH = (d.opened / max) * 100;
        const closedH = (d.closed / max) * 100;
        return (
          <div
            key={d.month}
            className="flex flex-1 flex-col items-center gap-1"
            title={`${d.month}: ${d.opened} opened, ${d.closed} closed`}
          >
            <div className="flex w-full flex-1 items-end gap-0.5">
              <div
                className="flex-1 rounded-t-sm bg-accent/60 transition-all"
                style={{ height: `${openedH}%`, minHeight: d.opened > 0 ? 2 : 0 }}
              />
              <div
                className="flex-1 rounded-t-sm bg-synced/70 transition-all"
                style={{ height: `${closedH}%`, minHeight: d.closed > 0 ? 2 : 0 }}
              />
            </div>
            <div className="text-[9px] font-mono text-ink-muted">{d.month.slice(5)}</div>
          </div>
        );
      })}
      <div className="ml-3 flex shrink-0 flex-col justify-end gap-1 pb-4 text-[10px] text-ink-muted">
        <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-2 bg-accent/60" /> Opened</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-2 bg-synced/70" /> Closed</span>
      </div>
    </div>
  );
}

// ── Stage funnel (horizontal bars, breach overlay) ──────────────

function StageFunnel({ data }: { data: AssrSummaryV31["stage_funnel"] }) {
  const byStage = new Map(data.map((d) => [d.stage, d]));
  const max = Math.max(...data.map((d) => d.total), 1);
  return (
    <div className="space-y-2">
      {STAGE_FUNNEL_ORDER.map((stage, idx) => {
        const row = byStage.get(stage);
        const total = row?.total ?? 0;
        const breached = row?.breached ?? 0;
        const pct = (total / max) * 100;
        const breachPct = total > 0 ? (breached / total) * 100 : 0;
        const fillTone =
          breachPct >= 50 ? "bg-err/80" : breachPct > 0 ? "bg-amber-500/80" : "bg-accent/70";
        return (
          <div
            key={stage}
            className="grid grid-cols-[160px_1fr_60px] items-center gap-3 text-[11px]"
          >
            <div className="truncate font-semibold text-ink">
              <span className="mr-1.5 inline-block w-4 text-right font-mono text-ink-muted">
                {idx + 1}
              </span>
              {STAGE_FUNNEL_LABEL[stage]}
            </div>
            <div className="relative h-5 overflow-hidden rounded bg-border/40">
              <div
                className={cn("absolute inset-y-0 left-0 transition-all", fillTone)}
                style={{ width: `${pct}%` }}
              />
              {breached > 0 && (
                <div
                  className="absolute inset-y-0 left-0 bg-err/80"
                  style={{ width: `${(breached / max) * 100}%` }}
                  title={`${breached} breached`}
                />
              )}
            </div>
            <div className="text-right font-mono">
              <span className="font-semibold text-ink">{total}</span>
              {breached > 0 && (
                <span className="ml-1 text-[10px] text-err">({breached})</span>
              )}
            </div>
          </div>
        );
      })}
      <div className="mt-2 flex items-center gap-3 text-[10px] text-ink-muted">
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded bg-accent/70" /> Healthy
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded bg-amber-500/80" /> Some breached
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded bg-err/80" /> Mostly breached
        </span>
      </div>
    </div>
  );
}

// ── CSAT 13-week rolling trend (line chart) ────────────────────

function CsatTrend({ data }: { data: AssrSummaryV31["csat_trend"] }) {
  const max = 5;
  const min = 1;
  const w = 100; // SVG width %; will scale via viewBox
  const h = 60;
  const last13 = data.slice(-13);
  const xStep = last13.length > 1 ? w / (last13.length - 1) : 0;
  const points = last13.map((d, i) => {
    const y = h - ((d.avg_rating - min) / (max - min)) * h;
    return `${i * xStep},${isFinite(y) ? y : h}`;
  });
  const avg = last13.length
    ? last13.reduce((s, d) => s + d.avg_rating, 0) / last13.length
    : null;
  return (
    <div>
      <div className="mb-2 flex items-center gap-3 text-[11px] text-ink-muted">
        <span>Avg: <b className="text-ink">{avg != null ? avg.toFixed(2) : "—"}</b> / 5</span>
        <span>·</span>
        <span>{last13.length} week(s)</span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="h-32 w-full" preserveAspectRatio="none">
        <line x1={0} y1={h} x2={w} y2={h} stroke="currentColor" strokeOpacity={0.1} />
        <polyline
          points={points.join(" ")}
          fill="none"
          stroke="currentColor"
          strokeWidth={0.6}
          className="text-accent"
        />
        {last13.map((d, i) => {
          const y = h - ((d.avg_rating - min) / (max - min)) * h;
          return (
            <circle
              key={d.week}
              cx={i * xStep}
              cy={isFinite(y) ? y : h}
              r={0.8}
              className="fill-accent"
            >
              <title>{`${d.week}: ${d.avg_rating.toFixed(2)} avg (n=${d.n})`}</title>
            </circle>
          );
        })}
      </svg>
      <div className="mt-1 flex justify-between text-[9px] font-mono text-ink-muted">
        {last13.length > 0 && (
          <>
            <span>{last13[0]?.week}</span>
            <span>{last13[last13.length - 1]?.week}</span>
          </>
        )}
      </div>
    </div>
  );
}
