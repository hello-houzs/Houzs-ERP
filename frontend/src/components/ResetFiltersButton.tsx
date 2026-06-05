import { FilterX } from "lucide-react";
import { cn } from "../lib/utils";

/**
 * Tiny toolbar button that clears the filters on a page. Stays hidden
 * until at least one filter is active so the toolbar isn't cluttered
 * on a fresh visit.
 *
 * Designed to be wired into any list/calendar that owns its own filter
 * state. The page decides what "active" means (e.g. ignoring an "ALL"
 * pill default) and what reset does (clear URL params, drop sticky
 * localStorage, reset pagination).
 */
export function ResetFiltersButton({
  active,
  onReset,
  className,
  label = "Reset",
}: {
  active: boolean;
  onReset: () => void;
  className?: string;
  label?: string;
}) {
  if (!active) return null;
  return (
    <button
      type="button"
      onClick={onReset}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[12px] font-medium text-ink-secondary transition-colors hover:border-accent/50 hover:text-accent",
        className
      )}
      title="Clear all filters and search"
    >
      <FilterX size={13} />
      {label}
    </button>
  );
}
