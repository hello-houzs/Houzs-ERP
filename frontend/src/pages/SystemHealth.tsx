import { useMemo, useState, type ReactNode } from "react";
import {
  Activity,
  Database,
  Gauge,
  ShieldAlert,
  RefreshCw,
  Clock,
  Users,
  ClipboardCheck,
  HardDrive,
  KeyRound,
  Boxes,
} from "lucide-react";
import { PageHeader } from "../components/Layout";
import { Button } from "../components/Button";
import { DashboardBreakdown } from "../components/Dashboard";
import { ListSkeleton } from "../components/Skeleton";
import { useQuery } from "../hooks/useQuery";
import { api } from "../api/client";
import { cn, relativeTime } from "../lib/utils";

// ---------------------------------------------------------------------------
// System Health — owner-only ("*"). "Real data" phase 1, ported from Hookka's
// /admin/health but limited to what runs on Houzs's current infra (no
// Cloudflare Analytics Engine yet): live DB/connection health (so the
// cold-start stall is visible), KV reachability, headcount, and the
// audit_events feed. AE-backed latency-percentile / slow-SQL / RUM panels are
// deferred to phase 2.
// ---------------------------------------------------------------------------

type LivePayload = {
  ok: boolean;
  time: string;
  db: { ok: boolean; latency_ms: number; error?: string };
  kv: { bound: boolean; ok: boolean; latency_ms: number };
  // R2 slip/photo bucket, Anthropic-key presence, and the SCM-route probe — all
  // fed by /live but previously ignored here, so the banner showed green while
  // SCM or R2 was down. Optional-ish (older deploys may omit them) so the banner
  // logic guards on presence.
  r2?: { bound: boolean; ok: boolean; latency_ms: number };
  anthropic?: { configured: boolean };
  scm?: { configured: boolean; ok: boolean; latency_ms: number; error?: string };
  counts: {
    users_active: number;
    users_invited: number;
    users_disabled: number;
    audit_24h: number;
    audit_7d: number;
    sensitive_24h: number;
    last_event_at: string | null;
  };
};

type AuditRow = {
  // public.audit_events rows are numeric ids; merged SCM rows arrive as
  // "scm:<uuid>" strings — so the key type is widened to string | number.
  id: number | string;
  created_at: string;
  actor_id: number | string | null;
  actor_email: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  summary: string | null;
};

type LedgerPayload = {
  check: string;
  label: string;
  ok: boolean;
  status: "ok" | "warn" | "unknown";
  configured: boolean;
  issueCount: number;
  asOf?: string;
  error?: string;
};
type AuditFeed = {
  success: boolean;
  data: AuditRow[];
  summary: {
    byAction: Array<{ action: string; n: number }>;
    byResource: Array<{ resource: string; n: number }>;
  };
};

type Range = "24h" | "7d" | "30d" | "90d";
const RANGES: Range[] = ["24h", "7d", "30d", "90d"];

// Cold-start thresholds (ms). A warm request-path ping is ~0.5s; the
// Hyperdrive cold-connection stall pushes it to ~20s before it warms.
const SLOW_MS = 2500;
const VERY_SLOW_MS = 6000;

type Tone = "green" | "amber" | "red" | "loading";

function StatCard({
  icon,
  label,
  value,
  sub,
  tone = "neutral",
}: {
  icon: ReactNode;
  label: string;
  value: string | number;
  sub?: string;
  tone?: "neutral" | "accent" | "warning" | "error";
}) {
  const bar = {
    neutral: "bg-border",
    accent: "bg-accent",
    warning: "bg-amber-500",
    error: "bg-err",
  }[tone];
  const valC = {
    neutral: "text-ink",
    accent: "text-accent",
    warning: "text-amber-700",
    error: "text-err",
  }[tone];
  const icoC = {
    neutral: "text-ink-muted",
    accent: "text-accent",
    warning: "text-amber-600",
    error: "text-err",
  }[tone];
  return (
    <div className="relative overflow-hidden rounded-lg border border-border bg-surface px-4 py-3 shadow-stone">
      <span className={cn("absolute left-0 top-0 h-full w-[3px]", bar)} aria-hidden />
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
        <span className={icoC}>{icon}</span>
        <span>{label}</span>
      </div>
      <div
        className={cn(
          "mt-1.5 font-display text-[22px] font-extrabold leading-none tracking-tight",
          valC
        )}
      >
        {typeof value === "number" ? value.toLocaleString() : value}
      </div>
      {sub && <div className="mt-1 text-[10.5px] text-ink-muted">{sub}</div>}
    </div>
  );
}

function HealthBanner({ tone, label, detail }: { tone: Tone; label: string; detail: string }) {
  const cls: Record<Tone, string> = {
    green: "border-synced/40 bg-synced/10 text-synced",
    amber: "border-amber-300 bg-amber-50 text-amber-800",
    red: "border-err/40 bg-err/10 text-err",
    loading: "border-border bg-surface text-ink-muted",
  };
  const dot: Record<Tone, string> = {
    green: "bg-synced",
    amber: "bg-amber-500",
    red: "bg-err",
    loading: "bg-ink-muted",
  };
  return (
    <div className={cn("flex items-center gap-3 rounded-lg border p-3", cls[tone])}>
      <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", dot[tone], tone !== "loading" && "animate-pulse")} />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-semibold">{label}</div>
        {detail && <div className="mt-0.5 text-[11px] opacity-90">{detail}</div>}
      </div>
    </div>
  );
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

export function SystemHealth() {
  const [range, setRange] = useState<Range>("24h");
  const [sensitiveOnly, setSensitiveOnly] = useState(false);

  const live = useQuery<LivePayload>(() => api.get("/api/admin/health/live"));
  // Inventory-ledger integrity — the working corruption-check endpoint that was
  // previously never called by the frontend. Surfaces silent partial stock
  // writes as a count the operator can act on.
  const ledger = useQuery<LedgerPayload>(() => api.get("/api/admin/health/ledger"));
  const feed = useQuery<AuditFeed>(
    () =>
      api.get(
        `/api/admin/health/audit-feed?range=${range}${sensitiveOnly ? "&sensitive=1" : ""}`
      ),
    [range, sensitiveOnly]
  );

  const d = live.data;
  const banner = useMemo<{ tone: Tone; label: string; detail: string }>(() => {
    if (!d) return { tone: "loading", label: "Checking…", detail: "" };
    const detail = `DB ${fmtMs(d.db.latency_ms)} · KV ${d.kv.bound ? fmtMs(d.kv.latency_ms) : "—"} · ${d.counts.users_active} active users`;
    if (!d.db.ok)
      return { tone: "red", label: "Database unreachable", detail: d.db.error || detail };
    if (d.db.latency_ms >= VERY_SLOW_MS)
      return {
        tone: "red",
        label: `Database very slow (${fmtMs(d.db.latency_ms)}) — cold-connection stall`,
        detail,
      };
    // SCM / R2 outages: the backend already flips d.ok for these, but surface the
    // specific subsystem so the banner names what's down instead of silently
    // staying green. SCM 500ing or slip-photo storage unreachable is red — those
    // break document flows and photo/slip storage outright.
    const scmDown = !!(d.scm && d.scm.configured && !d.scm.ok);
    const r2Down = !!(d.r2 && d.r2.bound && !d.r2.ok);
    if (scmDown || r2Down) {
      const which = [scmDown && "SCM stack", r2Down && "R2 storage"].filter(Boolean).join(" + ");
      return {
        tone: "red",
        label: `${which} unreachable`,
        detail: (scmDown && d.scm?.error) || detail,
      };
    }
    if (!d.ok || d.db.latency_ms >= SLOW_MS || (d.kv.bound && !d.kv.ok))
      return {
        tone: "amber",
        label: "Investigate — connection warming up",
        detail,
      };
    return { tone: "green", label: "All systems normal", detail };
  }, [d]);

  const rows = feed.data?.data ?? [];

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="System · Health"
        title="System Health"
        description="Live database and connection health, plus the audit trail of who changed what. Owner-only."
        actions={
          <Button
            variant="secondary"
            icon={<RefreshCw size={14} className={live.loading ? "animate-spin" : undefined} />}
            onClick={() => {
              live.reload();
              feed.reload();
              ledger.reload();
            }}
          >
            Refresh
          </Button>
        }
      />

      <HealthBanner tone={banner.tone} label={banner.label} detail={banner.detail} />

      {live.error && (
        <div className="rounded-md border border-err/40 bg-err/5 p-3 text-[12px] text-err">
          Failed to load live health: {live.error}
        </div>
      )}

      {!live.data && live.loading ? (
        <ListSkeleton rows={3} />
      ) : (
        d && (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatCard
                icon={<Gauge size={14} />}
                label="DB latency"
                value={fmtMs(d.db.latency_ms)}
                sub={d.db.ok ? "Live request-path ping" : "Ping failed"}
                tone={!d.db.ok || d.db.latency_ms >= VERY_SLOW_MS ? "error" : d.db.latency_ms >= SLOW_MS ? "warning" : "accent"}
              />
              <StatCard
                icon={<Database size={14} />}
                label="KV cache"
                value={d.kv.bound ? fmtMs(d.kv.latency_ms) : "—"}
                sub={d.kv.bound ? (d.kv.ok ? "Reachable" : "Unreachable") : "Not bound"}
                tone={d.kv.bound && !d.kv.ok ? "warning" : "neutral"}
              />
              <StatCard
                icon={<Users size={14} />}
                label="Active users"
                value={d.counts.users_active}
                sub={`${d.counts.users_invited} invited · ${d.counts.users_disabled} disabled`}
              />
              <StatCard
                icon={<Activity size={14} />}
                label="Audit events 24h"
                value={d.counts.audit_24h}
                sub={`${d.counts.audit_7d} in 7d`}
                tone={d.counts.sensitive_24h > 0 ? "warning" : "neutral"}
              />
              <StatCard
                icon={<ClipboardCheck size={14} />}
                label="Ledger integrity"
                value={
                  ledger.loading && !ledger.data
                    ? "…"
                    : !ledger.data || ledger.data.status === "unknown"
                      ? "—"
                      : ledger.data.issueCount
                }
                sub={
                  !ledger.data
                    ? ledger.error || "Checking…"
                    : ledger.data.status === "unknown"
                      ? ledger.data.error || "Not configured"
                      : ledger.data.issueCount === 0
                        ? "No silent stock writes"
                        : `${ledger.data.issueCount} doc${ledger.data.issueCount === 1 ? "" : "s"} moved stock on paper only`
                }
                tone={
                  !ledger.data || ledger.data.status === "unknown"
                    ? "neutral"
                    : ledger.data.issueCount > 0
                      ? "error"
                      : "accent"
                }
              />
              {/* SCM-route probe — one bounded PostgREST read; red when the SCM
                  stack is configured but 500ing (the page must not stay green). */}
              <StatCard
                icon={<Boxes size={14} />}
                label="SCM stack"
                value={d.scm ? (d.scm.configured ? fmtMs(d.scm.latency_ms) : "—") : "—"}
                sub={
                  !d.scm || !d.scm.configured
                    ? "Not configured"
                    : d.scm.ok
                      ? "Reachable"
                      : d.scm.error || "Unreachable"
                }
                tone={d.scm && d.scm.configured && !d.scm.ok ? "error" : "neutral"}
              />
              {/* R2 slip/photo bucket reachability. */}
              <StatCard
                icon={<HardDrive size={14} />}
                label="R2 storage"
                value={d.r2 ? (d.r2.bound ? fmtMs(d.r2.latency_ms) : "—") : "—"}
                sub={
                  !d.r2 || !d.r2.bound
                    ? "Not bound"
                    : d.r2.ok
                      ? "Reachable"
                      : "Unreachable"
                }
                tone={d.r2 && d.r2.bound && !d.r2.ok ? "error" : "neutral"}
              />
              {/* Anthropic key presence — SO-slip OCR /extract 503s when unset. */}
              <StatCard
                icon={<KeyRound size={14} />}
                label="Anthropic key"
                value={d.anthropic ? (d.anthropic.configured ? "Set" : "Missing") : "—"}
                sub={
                  !d.anthropic
                    ? "Unknown"
                    : d.anthropic.configured
                      ? "OCR /extract enabled"
                      : "OCR /extract will 503"
                }
                tone={d.anthropic && !d.anthropic.configured ? "warning" : "neutral"}
              />
            </div>

            {/* DB / connection health explainer — the cold-start signal. */}
            <div className="rounded-lg border border-border bg-surface px-5 py-5 shadow-stone">
              <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
                <Gauge size={13} className="text-accent" /> Database / connection
              </div>
              <div className="font-display text-[26px] font-extrabold leading-none tracking-tight text-ink">
                {fmtMs(d.db.latency_ms)}
                <span className="ml-2 text-[12px] font-normal text-ink-muted">
                  this check{" "}
                  {d.counts.last_event_at && (
                    <>· last write {relativeTime(d.counts.last_event_at)}</>
                  )}
                </span>
              </div>
              <p className="mt-3 text-[11.5px] leading-relaxed text-ink-secondary">
                A warm ping is well under a second. Anything over ~{SLOW_MS / 1000}s means the
                pooled DB connection went cold and is re-establishing — the Hyperdrive cold-start
                stall behind the occasional "Failed to fetch". Reads now auto-retry once the
                connection warms, so users recover instead of erroring; the lasting fix is moving
                Supabase off the micro tier.
              </p>
            </div>

            {/* Audit feed — who changed what, from audit_events. */}
            <div className="rounded-lg border border-border bg-surface px-5 py-5 shadow-stone">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
                  Audit feed — recent changes
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setSensitiveOnly((v) => !v)}
                    className={cn(
                      "inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[10.5px] font-semibold transition-colors",
                      sensitiveOnly
                        ? "border-amber-400 bg-amber-50 text-amber-800"
                        : "border-border bg-surface text-ink-secondary hover:border-accent/40 hover:text-accent"
                    )}
                    title="Show only security-sensitive actions (user disable/delete/reset, role changes, finance, TOTP)"
                  >
                    <ShieldAlert size={12} /> Sensitive only
                  </button>
                  <div className="inline-flex rounded-md border border-border bg-surface p-0.5">
                    {RANGES.map((r) => (
                      <button
                        key={r}
                        type="button"
                        onClick={() => setRange(r)}
                        className={cn(
                          "h-6 rounded px-2 text-[10.5px] font-semibold transition-colors",
                          range === r
                            ? "bg-accent text-white"
                            : "text-ink-secondary hover:text-accent"
                        )}
                      >
                        {r}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {(feed.data?.summary.byAction.length ?? 0) > 0 && (
                <div className="mb-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
                  <DashboardBreakdown
                    title="By action"
                    items={(feed.data?.summary.byAction ?? []).map((a) => ({
                      label: a.action,
                      count: a.n,
                    }))}
                  />
                  <DashboardBreakdown
                    title="By resource"
                    items={(feed.data?.summary.byResource ?? []).map((a) => ({
                      label: a.resource,
                      count: a.n,
                    }))}
                  />
                </div>
              )}

              {feed.loading && rows.length === 0 ? (
                <ListSkeleton rows={4} />
              ) : rows.length === 0 ? (
                <div className="py-6 text-center text-[12px] text-ink-muted">
                  No {sensitiveOnly ? "sensitive " : ""}events in the last {range}.
                </div>
              ) : (
                <div className="thin-scroll max-h-[28rem] overflow-auto">
                  <table className="w-full text-[12px]">
                    <thead className="sticky top-0">
                      <tr className="border-b-2 border-border bg-surface-dim text-left text-[10px] font-semibold uppercase tracking-brand text-ink-secondary">
                        <th className="py-1.5 pr-3">When</th>
                        <th className="py-1.5 pr-3">Who</th>
                        <th className="py-1.5 pr-3">Action</th>
                        <th className="py-1.5">What</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.id} className="border-b border-border/60 align-top">
                          <td
                            className="whitespace-nowrap py-1.5 pr-3 font-mono text-[10.5px] text-ink-muted"
                            title={r.created_at}
                          >
                            {relativeTime(r.created_at)}
                          </td>
                          <td className="py-1.5 pr-3 text-ink-secondary">
                            {r.actor_email || (r.actor_id ? `#${r.actor_id}` : "system")}
                          </td>
                          <td className="py-1.5 pr-3 font-mono text-[10.5px] text-ink">{r.action}</td>
                          <td className="py-1.5 text-ink-secondary">
                            {r.summary ||
                              [r.entity_type, r.entity_id].filter(Boolean).join(" ") ||
                              "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="text-[10.5px] text-ink-muted">
              Latency percentiles, slow-SQL and front-end performance need Cloudflare Analytics
              Engine (not wired yet) — staged for phase 2.
            </div>
          </>
        )
      )}
    </div>
  );
}
