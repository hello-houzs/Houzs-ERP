import { useMemo, useState } from "react";
import { Star, TrendingUp, AlertTriangle, Clock, CheckCircle2 } from "lucide-react";
import { FilterPills } from "../components/FilterPills";
import { StatCard } from "../components/StatCard";
import { DashboardGrid, DashboardPanels, DashboardBreakdown } from "../components/Dashboard";
import { useQuery } from "../hooks/useQuery";
import { api } from "../api/client";
import { cn, formatDate } from "../lib/utils";
import { resolutionLabel } from "../components/StatusDot";
import type { AssrMetrics } from "../types";

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

export function ServiceMetrics() {
  const [since, setSince] = useState<"30" | "90" | "180" | "365">("90");

  const metrics = useQuery<AssrMetrics>(
    () => api.get(`/api/assr/metrics?since_days=${since}`),
    [since]
  );

  const m = metrics.data;
  const h = m?.headline;

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

      <DashboardGrid cols={4}>
        <StatCard
          label="Total Cases"
          value={h ? h.total.toLocaleString() : "—"}
          subtitle={`Period: ${m?.since_days ?? since} days`}
        />
        <StatCard
          label="Completion Rate"
          value={completionRate != null ? `${completionRate}%` : "—"}
          subtitle={h ? `${h.closed.toLocaleString()} of ${h.total.toLocaleString()} closed` : " "}
          tone={completionRate != null && completionRate >= 80 ? "success" : "default"}
        />
        <StatCard
          label="SLA Breached"
          value={h ? h.breached.toLocaleString() : "—"}
          subtitle="Open cases past deadline"
          tone={(h?.breached ?? 0) > 0 ? "error" : "default"}
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
        />
      </DashboardGrid>

      <DashboardPanels cols={2}>
        <DashboardBreakdown
          title="NCR Categories"
          items={m?.ncr.map((r) => ({ label: ncrLabel(r.category), count: r.count })) ?? []}
        />
        <DashboardBreakdown
          title="Resolution Method Mix"
          items={m?.resolutions.map((r) => ({ label: resolutionLabel(r.method === "unset" ? null : r.method), count: r.count })) ?? []}
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
                <li key={r.item_code} className="flex items-center gap-3 border-b border-border px-5 py-2 last:border-b-0 text-[12px]">
                  <span className="font-mono text-[11px] font-semibold">{r.item_code}</span>
                  <span className="ml-auto text-ink-muted">last: {formatDate(r.latest)}</span>
                  <span className="rounded-full bg-err/10 px-2 py-0.5 text-[11px] font-bold text-err">
                    {r.cases}×
                  </span>
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
                <li key={i} className="flex items-center gap-3 border-b border-border px-5 py-2 last:border-b-0 text-[12px]">
                  <span className="flex-1 truncate font-semibold">{r.customer_name}</span>
                  <span className="text-[11px] text-ink-muted">last: {formatDate(r.latest)}</span>
                  <span className="rounded-full bg-err/10 px-2 py-0.5 text-[11px] font-bold text-err">
                    {r.cases}×
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="px-5 py-4 text-[12px] text-ink-muted">No repeat customers in this period</div>
          )}
        </div>
      </DashboardPanels>
    </div>
  );
}

// ── Simple trend chart (CSS bar chart, no deps) ─────────────

function Trend({ data }: { data: AssrMetrics["monthly_trend"] }) {
  const max = Math.max(...data.map((d) => Math.max(d.opened, d.closed)), 1);
  return (
    <div className="flex items-end gap-1.5 h-32">
      {data.map((d) => {
        const openedH = (d.opened / max) * 100;
        const closedH = (d.closed / max) * 100;
        return (
          <div key={d.month} className="flex-1 flex flex-col items-center gap-1" title={`${d.month}: ${d.opened} opened, ${d.closed} closed`}>
            <div className="relative flex gap-0.5 w-full h-full items-end">
              <div
                className="flex-1 bg-accent/60 rounded-t-sm"
                style={{ height: `${openedH}%` }}
              />
              <div
                className="flex-1 bg-synced/70 rounded-t-sm"
                style={{ height: `${closedH}%` }}
              />
            </div>
            <div className="text-[9px] font-mono text-ink-muted">{d.month.slice(5)}</div>
          </div>
        );
      })}
      <div className="ml-3 flex flex-col gap-1 text-[10px] text-ink-muted">
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 bg-accent/60" /> Opened</span>
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 bg-synced/70" /> Closed</span>
      </div>
    </div>
  );
}
