import { cn } from "../lib/utils";

/**
 * StreakBoard — 26-week heatmap of weekly upvote counts.
 *
 * Cheaper than a 365-day GitHub grid because the streak metric is
 * weekly, not daily. Each square is one ISO week; intensity is the
 * upvote count; a brass ring marks weeks that cleared the qualifying
 * threshold.
 */

export interface StreakWeek {
  iso_week: string;
  upvotes_count: number;
  qualified: number;
}

interface Props {
  weeks: StreakWeek[];
  threshold: number;
  currentStreak: number;
  loading?: boolean;
}

function intensityClass(n: number, threshold: number): string {
  if (n <= 0) return "bg-bg/60 border-border";
  if (n >= threshold * 2) return "bg-accent/85 border-accent";
  if (n >= threshold) return "bg-accent/55 border-accent/70";
  if (n >= Math.max(1, Math.floor(threshold / 2))) return "bg-accent/30 border-accent/40";
  return "bg-accent/15 border-accent/30";
}

export function StreakBoard({ weeks, threshold, currentStreak, loading }: Props) {
  // Always render exactly 26 cells. Pad with empty placeholders if the
  // server returned fewer (new accounts).
  const padded: (StreakWeek | null)[] = [];
  const start = Math.max(0, weeks.length - 26);
  for (let i = 0; i < 26; i++) {
    const idx = start + i - (26 - weeks.length);
    padded.push(idx >= 0 && idx < weeks.length ? weeks[idx] : null);
  }

  if (loading) {
    return (
      <div className="rounded-lg border border-border bg-surface p-4 shadow-stone">
        <div className="mb-3 h-3 w-32 animate-pulse rounded bg-bg/60" />
        <div className="grid grid-cols-[repeat(13,minmax(0,1fr))] gap-1.5 sm:grid-cols-[repeat(26,minmax(0,1fr))]">
          {Array.from({ length: 26 }).map((_, i) => (
            <div
              key={i}
              className="aspect-square animate-pulse rounded bg-bg/50"
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-surface p-4 shadow-stone">
      <div className="mb-3 flex items-end justify-between">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
            Weekly streak
          </div>
          <div className="mt-1 font-display text-[22px] font-extrabold leading-none tracking-tight text-ink">
            {currentStreak} <span className="text-[12px] font-medium text-ink-muted">week{currentStreak === 1 ? "" : "s"}</span>
          </div>
        </div>
        <div className="text-right text-[10px] text-ink-muted">
          <div>Threshold</div>
          <div className="font-mono text-[11px] font-semibold text-ink">{threshold}/wk</div>
        </div>
      </div>

      <div className="grid grid-cols-[repeat(13,minmax(0,1fr))] gap-1.5 sm:grid-cols-[repeat(26,minmax(0,1fr))]">
        {padded.map((w, i) => {
          if (!w) {
            return (
              <div
                key={`pad-${i}`}
                className="aspect-square rounded border border-dashed border-border/60 bg-bg/30"
                title="No data"
              />
            );
          }
          return (
            <div
              key={w.iso_week}
              title={`${w.iso_week} · ${w.upvotes_count} upvote${w.upvotes_count === 1 ? "" : "s"}${w.qualified ? " (qualified)" : ""}`}
              className={cn(
                "relative aspect-square rounded border transition-transform hover:scale-110",
                intensityClass(w.upvotes_count, threshold),
                w.qualified
                  ? "ring-1 ring-accent ring-offset-1 ring-offset-surface"
                  : ""
              )}
            />
          );
        })}
      </div>

      <div className="mt-3 flex items-center justify-between text-[10px] text-ink-muted">
        <span>Older →</span>
        <div className="flex items-center gap-1.5">
          <span>Less</span>
          <div className="h-3 w-3 rounded border border-border bg-bg/60" />
          <div className="h-3 w-3 rounded border border-accent/40 bg-accent/30" />
          <div className="h-3 w-3 rounded border border-accent/70 bg-accent/55" />
          <div className="h-3 w-3 rounded border border-accent bg-accent/85" />
          <span>More</span>
        </div>
      </div>
    </div>
  );
}
