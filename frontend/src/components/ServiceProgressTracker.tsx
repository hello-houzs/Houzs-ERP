/**
 * Workflow Progress Tracker — proposal §13.
 *
 * 9-node horizontal stepper rendered everywhere a case shows up:
 *   - top of case detail (variant="full")
 *   - list hover-card (variant="compact")
 *   - customer portal page (variant="compact")
 *   - supplier portal page (variant="compact")
 *
 * Visuals:
 *   Completed  — solid coloured circle with a check (synced/green)
 *   Current    — pulsing coloured circle with the stage number
 *   Skipped    — dashed greyed outline with skip reason as tooltip
 *   Future     — empty outline with grey number
 *   Connector  — green / amber / red based on the prior stage's health
 *
 * Mobile (< sm): collapses to a single line showing "Stage 4 of 8 —
 * Item Pickup · 2.1 / 2 days". Avoids a vertical stepper that
 * pushes the actual case content off-screen.
 */
import { Check, Clock } from "lucide-react";
import type { AssrStage, AssrStageHistoryRow } from "../types";
import { cn, formatTimestamp } from "../lib/utils";

// ── Canonical 8-stage order + display labels (mirrors backend mig 074 + 0105) ──

const STAGES: { value: AssrStage; label: string; short: string; owner: string }[] = [
  { value: "pending_review",           label: "Review",                   short: "Review",         owner: "Service Admin" },
  { value: "under_verification",       label: "Verification",             short: "Verify",         owner: "Service Admin" },
  { value: "pending_solution",         label: "Solution",                 short: "Solution",       owner: "Service Admin" },
  { value: "pending_item_pickup",      label: "Item Pickup",              short: "Item Pickup",    owner: "Logistic Admin" },
  { value: "pending_supplier_pickup",  label: "Supplier Pickup",          short: "Supplier",       owner: "Service Admin" },
  { value: "pending_item_ready",       label: "Item Ready",               short: "Item Ready",     owner: "Service Admin" },
  { value: "pending_delivery_service", label: "Delivery / Service",       short: "Delivery",     owner: "Logistic Admin" },
  { value: "completed",                label: "Completed",                short: "Completed",      owner: "System" },
];

export type ServiceProgressTrackerProps = {
  history?: AssrStageHistoryRow[];
  currentStage: AssrStage;
  variant?: "full" | "compact";
  className?: string;
};

// ── Helpers ────────────────────────────────────────────────────────

type NodeState =
  | { kind: "completed"; days_actual: number | null; target_days: number | null; entered_at: string | null; exited_at: string | null }
  | { kind: "current"; elapsed_days: number; target_days: number | null; pct: number; tone: "green" | "amber" | "red"; entered_at: string }
  | { kind: "skipped"; reason: string | null }
  | { kind: "future" };

function elapsedDaysBetween(from: string, to: string | null): number {
  const a = new Date(from.endsWith("Z") ? from : from + "Z").getTime();
  const b = to ? new Date(to.endsWith("Z") ? to : to + "Z").getTime() : Date.now();
  return (b - a) / (1000 * 60 * 60 * 24);
}

function toneForPct(pct: number): "green" | "amber" | "red" {
  if (pct >= 1.0) return "red";
  if (pct >= 0.5) return "amber";
  return "green";
}

function computeNodeStates(
  history: AssrStageHistoryRow[],
  currentStage: AssrStage
): Record<AssrStage, NodeState> {
  const map: Partial<Record<AssrStage, NodeState>> = {};
  const lastByStage = new Map<AssrStage, AssrStageHistoryRow>();
  for (const h of history) {
    // Most-recent entry per stage wins (the alert/skip flags live on
    // the latest revisit, which matches what ops cares about).
    lastByStage.set(h.stage, h);
  }
  const currentIdx = STAGES.findIndex((s) => s.value === currentStage);

  STAGES.forEach((s, idx) => {
    const h = lastByStage.get(s.value);
    if (h?.skipped) {
      map[s.value] = { kind: "skipped", reason: h.skip_reason };
      return;
    }
    if (idx < currentIdx) {
      // Past stage. Completed if we have history; future-looking if not
      // (shouldn't happen but guard against it).
      if (h) {
        map[s.value] = {
          kind: "completed",
          days_actual: h.exited_at ? elapsedDaysBetween(h.entered_at, h.exited_at) : null,
          target_days: h.target_days,
          entered_at: h.entered_at,
          exited_at: h.exited_at,
        };
      } else {
        map[s.value] = { kind: "skipped", reason: null };
      }
      return;
    }
    if (idx === currentIdx) {
      if (h) {
        const elapsed = elapsedDaysBetween(h.entered_at, h.exited_at);
        const pct = h.target_days ? elapsed / h.target_days : 0;
        map[s.value] = {
          kind: "current",
          elapsed_days: elapsed,
          target_days: h.target_days,
          pct,
          tone: toneForPct(pct),
          entered_at: h.entered_at,
        };
      } else {
        map[s.value] = {
          kind: "current",
          elapsed_days: 0,
          target_days: null,
          pct: 0,
          tone: "green",
          entered_at: new Date().toISOString(),
        };
      }
      return;
    }
    // Future stage
    map[s.value] = { kind: "future" };
  });
  return map as Record<AssrStage, NodeState>;
}

// ── Component ──────────────────────────────────────────────────────

export function ServiceProgressTracker({
  history = [],
  currentStage,
  variant = "full",
  className,
}: ServiceProgressTrackerProps) {
  const states = computeNodeStates(history, currentStage);
  const currentIdx = STAGES.findIndex((s) => s.value === currentStage);
  const currentNode = states[currentStage];

  // Mobile + compact: single-line summary
  if (variant === "compact") {
    return (
      <CompactSummary
        currentStage={currentStage}
        currentIdx={currentIdx}
        node={currentNode}
        className={className}
      />
    );
  }

  return (
    <div className={cn("w-full", className)}>
      {/* Single-line summary above the stepper for the mobile layout */}
      <div className="mb-3 sm:hidden">
        <CompactSummary
          currentStage={currentStage}
          currentIdx={currentIdx}
          node={currentNode}
        />
      </div>

      {/* Stepper — hidden on mobile (under sm:) to avoid horizontal scroll on tiny screens */}
      <ol className="hidden items-start gap-0 overflow-x-auto py-2 sm:flex">
        {STAGES.map((s, idx) => {
          const state = states[s.value];
          const next = STAGES[idx + 1];
          const connectorTone =
            state.kind === "completed"
              ? "bg-synced"
              : state.kind === "current"
              ? state.tone === "red"
                ? "bg-err"
                : state.tone === "amber"
                ? "bg-amber-500"
                : "bg-synced"
              : "bg-border";
          return (
            <li key={s.value} className="flex flex-1 items-start gap-0">
              <Node state={state} idx={idx} label={s.short} owner={s.owner} fullLabel={s.label} />
              {next && (
                <div
                  className={cn(
                    "mt-3 h-0.5 flex-1 transition-colors",
                    connectorTone
                  )}
                />
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function CompactSummary({
  currentStage,
  currentIdx,
  node,
  className,
}: {
  currentStage: AssrStage;
  currentIdx: number;
  node: NodeState | undefined;
  className?: string;
}) {
  const stage = STAGES[currentIdx];
  const isCurrent = node?.kind === "current";
  const tone = isCurrent && node.tone === "red"
    ? "text-err"
    : isCurrent && node.tone === "amber"
    ? "text-amber-700"
    : "text-ink";
  return (
    <div className={cn("flex items-center gap-2 text-[12px]", className)}>
      <span className="inline-flex items-center gap-1 rounded bg-accent/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-accent">
        Stage {currentIdx + 1} / {STAGES.length}
      </span>
      <span className={cn("font-semibold", tone)}>{stage?.label ?? currentStage}</span>
      {isCurrent && node.target_days != null && node.target_days > 0 && (
        <span className="text-[11px] text-ink-muted">
          · {node.elapsed_days.toFixed(1)} / {node.target_days}d
        </span>
      )}
    </div>
  );
}

function Node({
  state,
  idx,
  label,
  owner,
  fullLabel,
}: {
  state: NodeState | undefined;
  idx: number;
  label: string;
  owner: string;
  fullLabel: string;
}) {
  const tooltip = buildTooltip(state, idx, fullLabel, owner);

  let circleClass = "border-2 border-border bg-surface text-ink-muted";
  let inner: React.ReactNode = <span>{idx + 1}</span>;

  if (state?.kind === "completed") {
    circleClass = "border-2 border-synced bg-synced text-white";
    inner = <Check size={12} strokeWidth={3} />;
  } else if (state?.kind === "current") {
    const ring =
      state.tone === "red"
        ? "border-err bg-err text-white animate-pulse"
        : state.tone === "amber"
        ? "border-amber-500 bg-amber-500 text-white animate-pulse"
        : "border-accent bg-accent text-white animate-pulse";
    circleClass = `border-2 ${ring}`;
    inner = <span>{idx + 1}</span>;
  } else if (state?.kind === "skipped") {
    circleClass = "border-2 border-dashed border-ink-muted/40 bg-bg text-ink-muted/60";
    inner = <span>{idx + 1}</span>;
  }

  // Single sentence form for screen readers — the visible label is the
  // short word and the tooltip is multi-line, both of which SRs ignore.
  const ariaLabel = ariaLabelForNode(state, idx, fullLabel);

  return (
    <div className="flex w-16 flex-col items-center text-center" title={tooltip}>
      <div
        role="img"
        aria-label={ariaLabel}
        className={cn(
          "flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-bold transition-colors",
          circleClass
        )}
      >
        {inner}
      </div>
      <span className="mt-1 line-clamp-2 text-[9px] font-semibold uppercase tracking-brand text-ink-muted">
        {label}
      </span>
    </div>
  );
}

function ariaLabelForNode(state: NodeState | undefined, idx: number, fullLabel: string): string {
  const base = `Stage ${idx + 1} of ${STAGES.length}: ${fullLabel}`;
  if (!state) return `${base}, not started`;
  if (state.kind === "completed") return `${base}, completed`;
  if (state.kind === "current") {
    const tone =
      state.tone === "red" ? "breaching SLA" : state.tone === "amber" ? "approaching SLA" : "on track";
    if (state.target_days != null && state.target_days > 0) {
      return `${base}, in progress, ${state.elapsed_days.toFixed(1)} of ${state.target_days} days, ${tone}`;
    }
    return `${base}, in progress, ${tone}`;
  }
  if (state.kind === "skipped") return `${base}, skipped${state.reason ? ` — ${state.reason}` : ""}`;
  return `${base}, not started`;
}

function buildTooltip(state: NodeState | undefined, idx: number, fullLabel: string, owner: string): string {
  const lines: string[] = [`Stage ${idx + 1}: ${fullLabel}`, `Owner: ${owner}`];
  if (!state) return lines.join("\n");
  if (state.kind === "current") {
    lines.push(`Entered: ${formatTimestamp(state.entered_at)}`);
    if (state.target_days != null && state.target_days > 0) {
      lines.push(`Elapsed: ${state.elapsed_days.toFixed(1)} / ${state.target_days} days (${Math.round(state.pct * 100)}%)`);
    }
  } else if (state.kind === "completed") {
    if (state.entered_at) {
      lines.push(`Entered: ${formatTimestamp(state.entered_at)}`);
    }
    if (state.exited_at) {
      lines.push(`Exited: ${formatTimestamp(state.exited_at)}`);
    }
    if (state.days_actual != null && state.target_days) {
      lines.push(`Took: ${state.days_actual.toFixed(1)} / ${state.target_days} days`);
    }
  } else if (state.kind === "skipped") {
    lines.push(`Skipped${state.reason ? ` — ${state.reason}` : ""}`);
  }
  return lines.join("\n");
}
