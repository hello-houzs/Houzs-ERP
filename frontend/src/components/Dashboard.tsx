import type { ReactNode } from "react";
import { cn } from "../lib/utils";

/**
 * A horizontal dashboard strip used at the top of each tab page.
 * Composes a row of stat cards (children) plus optional breakdown panels
 * via <DashboardBreakdown />.
 */
export function DashboardGrid({
  children,
  cols = 4,
}: {
  children: ReactNode;
  cols?: 2 | 3 | 4 | 5;
}) {
  const colsClass = {
    2: "md:grid-cols-2",
    3: "md:grid-cols-3",
    4: "md:grid-cols-2 lg:grid-cols-4",
    5: "md:grid-cols-2 lg:grid-cols-5",
  }[cols];
  return (
    <div className={cn("mb-4 grid grid-cols-1 gap-3", colsClass)}>{children}</div>
  );
}

/**
 * A small distribution panel — label + a list of (label, count, optional bar%).
 * Used for "by region", "by status", "top suppliers" etc.
 */
export function DashboardBreakdown({
  title,
  items,
  emptyLabel = "No data",
  formatCount = (n) => n.toLocaleString(),
}: {
  title: string;
  items: Array<{ label: string; count: number; tone?: "default" | "success" | "warn" | "error" }>;
  emptyLabel?: string;
  formatCount?: (n: number) => string;
}) {
  const max = Math.max(1, ...items.map((i) => i.count));
  return (
    <div className="relative overflow-hidden rounded-lg border border-border bg-surface px-5 py-5 shadow-stone">
      <span className="pointer-events-none absolute left-0 top-0 h-px w-full bg-gradient-to-r from-transparent via-accent/40 to-transparent" />

      <div className="mb-4 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
        {title}
      </div>
      {items.length === 0 ? (
        <div className="text-sm text-ink-muted">{emptyLabel}</div>
      ) : (
        <div className="space-y-2.5">
          {items.map((it) => {
            const pct = (it.count / max) * 100;
            const barColor =
              it.tone === "error"
                ? "bg-err/70"
                : it.tone === "warn"
                ? "bg-warning-text/70"
                : it.tone === "success"
                ? "bg-synced/70"
                : "bg-accent/65";
            return (
              <div key={it.label}>
                <div className="mb-1 flex items-center justify-between gap-3 text-[12px]">
                  <span className="truncate font-medium text-ink-secondary">{it.label}</span>
                  <span className="shrink-0 font-mono text-[11px] font-semibold text-ink">
                    {formatCount(it.count)}
                  </span>
                </div>
                <div className="h-[5px] w-full overflow-hidden rounded-full bg-surface-dim">
                  <div
                    className={cn("h-full rounded-full transition-all duration-500", barColor)}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Two- or three-column container for breakdown panels under the stat strip.
 */
export function DashboardPanels({
  children,
  cols = 2,
}: {
  children: ReactNode;
  cols?: 1 | 2 | 3;
}) {
  const colsClass =
    cols === 3 ? "lg:grid-cols-3" : cols === 2 ? "lg:grid-cols-2" : "";
  return <div className={cn("mb-8 grid grid-cols-1 gap-3", colsClass)}>{children}</div>;
}
