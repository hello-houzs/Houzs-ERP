import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "../lib/utils";

/**
 * ListPager — a 0-based server-pagination footer WITH a per-page selector.
 *
 * Unifies the ten hand-rolled `PaginationFooter` copies across the SCM lists
 * (owner 2026-07-24: "应用到全部" — every list should have the per-page control
 * the shared Pagination already had, and the operator noticed it missing on the
 * Sales Orders list). Those copies were byte-identical bar a `noun`, tracked
 * `page` 0-based (`from = page*pageSize + 1`), and had only Prev/Next.
 *
 * 0-based on purpose — that is how every SCM list holds `page`. The older
 * components/Pagination is 1-based and stays for the non-SCM pages already on
 * it; this doesn't replace it.
 *
 * Left-aligned in one flowing row (range · per-page · pager), which also lifts
 * the pager out from under the floating action buttons that used to cover a
 * far-right Next.
 */

const DEFAULT_PER_PAGE = [25, 50, 100];

interface Props {
  /** 0-based page index. */
  page: number;
  pageSize: number;
  total: number;
  /** Called with the new 0-based page. */
  onPageChange: (page: number) => void;
  /** When provided, the per-page selector shows. Callers reset to page 0. */
  onPageSizeChange?: (size: number) => void;
  /** Page-size options. Default 25 / 50 / 100 (the SCM list routes cap at 100). */
  perPageOptions?: number[];
  /** Pluralised row label — "orders" → "Showing 1–50 of 68 orders". */
  noun?: string;
}

export function ListPager({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  perPageOptions = DEFAULT_PER_PAGE,
  noun,
}: Props) {
  const from = total === 0 ? 0 : page * pageSize + 1;
  const to = Math.min((page + 1) * pageSize, total);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(page + 1, totalPages);
  const atStart = page <= 0;
  const atEnd = (page + 1) * pageSize >= total;

  const navBtn = (disabled: boolean) =>
    cn(
      "flex h-8 w-8 items-center justify-center rounded-md border border-border bg-surface transition-colors sm:h-7 sm:w-7",
      disabled
        ? "text-ink-muted opacity-40"
        : "hover:border-accent/40 hover:bg-accent-soft/50 hover:text-accent",
    );

  return (
    <div className="mt-4 flex flex-wrap items-center gap-3 text-[11px] font-medium text-ink-secondary">
      <span className="text-[12px] text-ink-muted">
        {total === 0
          ? `No ${noun ?? "results"}`
          : `Showing ${from.toLocaleString()}–${to.toLocaleString()} of ${total.toLocaleString()}${noun ? ` ${noun}` : ""}`}
      </span>

      {onPageSizeChange && (
        <div className="flex items-center gap-1.5">
          <span className="hidden text-[10px] font-semibold uppercase tracking-wider text-ink-muted sm:inline">
            Show
          </span>
          <select
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
            aria-label="Rows per page"
            className="h-8 cursor-pointer rounded-md border border-border bg-surface pl-2 pr-6 text-[11px] font-semibold text-ink outline-none transition-colors hover:border-accent/50 focus:border-primary focus:ring-2 focus:ring-primary/20 sm:h-7"
          >
            {perPageOptions.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <span className="hidden text-[10px] font-semibold uppercase tracking-wider text-ink-muted sm:inline">
            per page
          </span>
        </div>
      )}

      <div className="flex items-center gap-1 sm:ml-1">
        <button
          type="button"
          disabled={atStart}
          onClick={() => onPageChange(page - 1)}
          aria-label="Previous page"
          className={navBtn(atStart)}
        >
          <ChevronLeft size={14} />
        </button>
        <span className="px-3 font-mono text-[11px] text-ink">
          {current} <span className="text-ink-muted">/</span> {totalPages}
        </span>
        <button
          type="button"
          disabled={atEnd}
          onClick={() => onPageChange(page + 1)}
          aria-label="Next page"
          className={navBtn(atEnd)}
        >
          <ChevronRight size={14} />
        </button>
      </div>
    </div>
  );
}
