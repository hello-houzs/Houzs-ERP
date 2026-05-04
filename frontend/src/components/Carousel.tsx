import { Children, type ReactNode } from "react";
import { cn } from "../lib/utils";

type Breakpoint = "sm" | "md" | "lg";

interface Props {
  children: ReactNode;
  /** Number of columns at and above the breakpoint. Static so Tailwind JIT sees the class. */
  cols: 2 | 3 | 4 | 5;
  /** Breakpoint where the swipe row collapses back to a static grid. Defaults to "sm". */
  collapseAt?: Breakpoint;
  className?: string;
}

// Static class lookups so the JIT picks them up at build time. Each
// row covers the matching breakpoint variants we use across the app.
const RESET: Record<Breakpoint, string> = {
  sm: "sm:mx-0 sm:px-0 sm:pb-0 sm:overflow-visible sm:grid sm:snap-none",
  md: "md:mx-0 md:px-0 md:pb-0 md:overflow-visible md:grid md:snap-none",
  lg: "lg:mx-0 lg:px-0 lg:pb-0 lg:overflow-visible lg:grid lg:snap-none",
};

const COLS: Record<Breakpoint, Record<number, string>> = {
  sm: { 2: "sm:grid-cols-2", 3: "sm:grid-cols-3", 4: "sm:grid-cols-4", 5: "sm:grid-cols-5" },
  md: { 2: "md:grid-cols-2", 3: "md:grid-cols-3", 4: "md:grid-cols-4", 5: "md:grid-cols-5" },
  lg: { 2: "lg:grid-cols-2", 3: "lg:grid-cols-3", 4: "lg:grid-cols-4", 5: "lg:grid-cols-5" },
};

const ITEM_RESET: Record<Breakpoint, string> = {
  sm: "sm:w-auto",
  md: "md:w-auto",
  lg: "lg:w-auto",
};

/**
 * Mobile: horizontal swipe carousel with CSS scroll-snap.
 * `collapseAt`+: turns into a normal CSS grid so desktop is unchanged.
 *
 * Each child is wrapped in a snap cell that takes ~85% of the viewport
 * width on mobile, so the next card peeks in and hints there's more
 * to swipe to. Negative margin + matching padding lets the row bleed
 * to the screen edges within the standard `px-4` page gutter.
 */
export function Carousel({
  children,
  cols,
  collapseAt = "sm",
  className,
}: Props) {
  return (
    <div
      className={cn(
        "thin-scroll flex snap-x snap-mandatory gap-3 overflow-x-auto -mx-4 px-4 pb-2",
        RESET[collapseAt],
        COLS[collapseAt][cols],
        className,
      )}
    >
      {Children.map(children, (child, i) => (
        <div
          key={i}
          className={cn("w-[85%] shrink-0 snap-start", ITEM_RESET[collapseAt])}
        >
          {child}
        </div>
      ))}
    </div>
  );
}
