import type { ReactNode } from "react";
import { cn } from "../lib/utils";

interface Props {
  label: string;
  value: ReactNode;
  subtitle?: ReactNode;
  tone?: "default" | "success" | "warning" | "error";
  /** When set, the card renders as a button — focusable, keyboard-activatable. */
  onClick?: () => void;
  /** Highlight the card as the currently-selected drill-down (brass border + tint). */
  active?: boolean;
}

/**
 * Atelier stat card — a slab on the cream canvas with a thin brass
 * top hairline that turns full-brass on hover. The number takes the
 * display weight; the label is a small uppercase eyebrow.
 *
 * Pass `onClick` to make the card a drill-down affordance. The element
 * type switches to <button> so it's keyboard-accessible; we also bump
 * hover affordance to make it read as clickable.
 */
export function StatCard({ label, value, subtitle, tone = "default", onClick, active }: Props) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      onClick={onClick}
      type={onClick ? "button" : undefined}
      aria-pressed={onClick ? !!active : undefined}
      className={cn(
        "group relative h-full overflow-hidden rounded-lg border border-border bg-surface px-4 py-4 text-left shadow-stone transition-all duration-200 hover:-translate-y-px hover:shadow-slab sm:px-5 sm:py-5",
        onClick &&
          "cursor-pointer hover:border-accent/40 focus:outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30",
        active && "border-accent/60 bg-accent-soft/30 ring-1 ring-accent/30"
      )}
    >
      {/* Brass top edge — thin by default, glows on hover (full when active) */}
      <span
        className={cn(
          "pointer-events-none absolute left-0 top-0 h-px w-full bg-gradient-to-r from-transparent to-transparent transition-opacity duration-300 group-hover:via-accent",
          active ? "via-accent" : "via-accent/40"
        )}
      />

      <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
        {label}
      </div>
      <div
        className={cn(
          "mt-2 font-display text-[22px] font-extrabold leading-none tracking-tight sm:mt-3 sm:text-[26px]",
          tone === "default" && "text-ink",
          tone === "success" && "text-synced",
          tone === "warning" && "text-warning-text",
          tone === "error" && "text-err"
        )}
      >
        {value}
      </div>
      {subtitle && (
        <div className="mt-2 text-[11px] font-medium text-ink-secondary">{subtitle}</div>
      )}
    </Tag>
  );
}
