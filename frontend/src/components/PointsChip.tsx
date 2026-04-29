import { NavLink } from "react-router-dom";
import { Coins, Flame } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { useNotifications } from "../hooks/useNotifications";
import { cn } from "../lib/utils";

interface Props {
  /** Compact halves chip widths and hides labels on the points side. */
  compact?: boolean;
  className?: string;
}

/**
 * Topbar Houzs Points + streak indicator. Two adjacent pills sharing a
 * border so they read as one unit, each linking into the relevant
 * sub-tab of the gamification page. Reads from useNotifications which
 * already piggybacks the 30 s poll — no extra round-trip.
 */
export function PointsChip({ compact, className }: Props) {
  const { user } = useAuth();
  const { pointsBalance, currentStreak } = useNotifications();
  if (!user) return null;

  return (
    <div
      className={cn(
        "flex items-stretch overflow-hidden rounded-md border border-border bg-surface text-[11px] font-semibold leading-none",
        className,
      )}
      title={`${pointsBalance} Houzs Points · ${currentStreak} week streak`}
    >
      <NavLink
        to="/gamification?sub=activity"
        className="flex items-center gap-1.5 px-2 py-1.5 text-ink transition-colors hover:bg-accent-soft/50 hover:text-accent"
        aria-label={`Houzs Points: ${pointsBalance}`}
      >
        <Coins size={13} className="text-accent" />
        <span className="font-mono tabular-nums">{pointsBalance}</span>
        {!compact && (
          <span className="hidden text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted xl:inline">
            pts
          </span>
        )}
      </NavLink>
      <div className="w-px bg-border" aria-hidden="true" />
      <NavLink
        to="/gamification?sub=streak"
        className={cn(
          "flex items-center gap-1 px-2 py-1.5 transition-colors hover:bg-accent-soft/50",
          currentStreak > 0
            ? "text-warning-text hover:text-warning-text"
            : "text-ink-muted hover:text-accent",
        )}
        aria-label={`Streak: ${currentStreak} week${currentStreak === 1 ? "" : "s"}`}
      >
        <Flame
          size={13}
          className={cn(
            currentStreak > 0 ? "fill-warning-text/30" : "",
            currentStreak >= 4 && "drop-shadow-[0_0_4px_rgba(110,77,18,0.6)]",
          )}
        />
        <span className="font-mono tabular-nums">{currentStreak}</span>
      </NavLink>
    </div>
  );
}
