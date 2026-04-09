import type { ReactNode } from "react";
import { cn } from "../lib/utils";

interface Props {
  label: string;
  value: ReactNode;
  subtitle?: ReactNode;
  tone?: "default" | "success" | "error";
}

/**
 * Atelier stat card — a slab on the cream canvas with a thin brass
 * top hairline that turns full-brass on hover. The number takes the
 * display weight; the label is a small uppercase eyebrow.
 */
export function StatCard({ label, value, subtitle, tone = "default" }: Props) {
  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-lg border border-border bg-surface px-5 py-5 shadow-stone transition-all duration-200 hover:-translate-y-px hover:shadow-slab"
      )}
    >
      {/* Brass top edge — thin by default, glows on hover */}
      <span className="pointer-events-none absolute left-0 top-0 h-px w-full bg-gradient-to-r from-transparent via-accent/40 to-transparent transition-opacity duration-300 group-hover:via-accent" />

      <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
        {label}
      </div>
      <div
        className={cn(
          "mt-3 font-display text-[26px] font-extrabold leading-none tracking-tight",
          tone === "default" && "text-ink",
          tone === "success" && "text-synced",
          tone === "error" && "text-err"
        )}
      >
        {value}
      </div>
      {subtitle && (
        <div className="mt-2 text-[11px] font-medium text-ink-secondary">{subtitle}</div>
      )}
    </div>
  );
}
