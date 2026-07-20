import { cn } from "../lib/utils";

export function SearchScopeHint({
  scope,
  searching = false,
  countPending = false,
  resultCount,
  term = "",
  className,
}: {
  scope: "server" | "loaded";
  searching?: boolean;
  countPending?: boolean;
  resultCount?: number;
  term?: string;
  className?: string;
}) {
  return (
    <div className={cn("text-[10px] text-ink-muted", className)} data-search-scope>
      {scope === "server"
        ? "Searches across all pages you can access"
        : "Searches loaded rows only"}
      {!searching && !countPending && resultCount != null && (
        <span>
          {" · "}
          {term.trim()
            ? `${resultCount.toLocaleString()} matches`
            : `${resultCount.toLocaleString()} records`}
        </span>
      )}
    </div>
  );
}
