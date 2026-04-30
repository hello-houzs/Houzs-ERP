import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ArrowDown, RefreshCw } from "lucide-react";
import { cn } from "../lib/utils";

interface Props {
  /**
   * Called when the user pulls past the threshold and releases.
   * Defaults to `window.location.reload()` — a hard, F5-style refresh.
   */
  onRefresh?: () => Promise<unknown> | void;
  /** Optional extra padding above the indicator (e.g. when there's a sticky bar). */
  topOffset?: number;
  children: ReactNode;
  className?: string;
}

// Sensitivity tuning. The dead-zone lets the user scroll up casually
// without engaging the pull, and the resistance multiplier means the
// indicator only travels a fraction of the finger's distance — so a
// committed pull is required, not a flick.
const DEAD_ZONE = 14;
const RESISTANCE = 0.55;
const THRESHOLD = 80;
const MAX_PULL = 130;

function findScrollAncestor(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null;
  while (node) {
    const style = getComputedStyle(node);
    if (/(auto|scroll|overlay)/.test(style.overflowY)) return node;
    node = node.parentElement;
  }
  return null;
}

/**
 * Mobile pull-to-refresh wrapper. Listens for touch on its own element,
 * walks up to find the nearest scrollable ancestor, and only engages
 * when scrollTop === 0. No-op on desktop because we only attach touch
 * listeners.
 */
export function PullToRefresh({
  onRefresh,
  topOffset = 0,
  children,
  className,
}: Props) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLElement | null>(null);
  const startYRef = useRef<number | null>(null);
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    const wrap = wrapperRef.current;
    if (!wrap) return;
    scrollRef.current = findScrollAncestor(wrap) ?? document.documentElement;
  }, []);

  useEffect(() => {
    const wrap = wrapperRef.current;
    if (!wrap) return;

    function getScrollTop() {
      const el = scrollRef.current;
      if (!el) return 0;
      return el === document.documentElement ? window.scrollY : el.scrollTop;
    }

    function handleStart(e: TouchEvent) {
      if (refreshing) return;
      if (getScrollTop() > 0) {
        startYRef.current = null;
        return;
      }
      startYRef.current = e.touches[0].clientY;
    }

    function handleMove(e: TouchEvent) {
      if (refreshing || startYRef.current == null) return;
      const dy = e.touches[0].clientY - startYRef.current;
      if (dy <= DEAD_ZONE) {
        // dead zone — finger hasn't committed to a pull yet. Casual
        // scroll-up jitter falls in here and never engages.
        setPull(0);
        return;
      }
      // Constant resistance the whole way: the indicator travels at
      // 0.55 of the finger's distance past the dead zone.
      const resisted = (dy - DEAD_ZONE) * RESISTANCE;
      setPull(Math.min(resisted, MAX_PULL));
      // Once we're past the dead zone we own the gesture — block the
      // browser's own pull-to-refresh / overscroll.
      if (e.cancelable) e.preventDefault();
    }

    async function handleEnd() {
      const start = startYRef.current;
      startYRef.current = null;
      if (start == null) {
        setPull(0);
        return;
      }
      if (pull >= THRESHOLD && !refreshing) {
        setRefreshing(true);
        setPull(THRESHOLD);
        try {
          if (onRefresh) {
            await onRefresh();
          } else {
            // F5-style hard reload — never returns, no need to clear
            // refreshing state (the page is being torn down).
            window.location.reload();
            return;
          }
        } catch {
          // swallow — onRefresh's own error handling owns the toast
        } finally {
          setRefreshing(false);
          setPull(0);
        }
      } else {
        setPull(0);
      }
    }

    wrap.addEventListener("touchstart", handleStart, { passive: true });
    wrap.addEventListener("touchmove", handleMove, { passive: false });
    wrap.addEventListener("touchend", handleEnd);
    wrap.addEventListener("touchcancel", handleEnd);
    return () => {
      wrap.removeEventListener("touchstart", handleStart);
      wrap.removeEventListener("touchmove", handleMove);
      wrap.removeEventListener("touchend", handleEnd);
      wrap.removeEventListener("touchcancel", handleEnd);
    };
  }, [pull, refreshing, onRefresh]);

  const armed = pull >= THRESHOLD;
  const opacity = Math.min(pull / 20, 1);
  const rotate = Math.min((pull / THRESHOLD) * 180, 180);
  const label = refreshing
    ? "Refreshing…"
    : armed
    ? "Release to refresh"
    : "Pull down to refresh";

  return (
    <div ref={wrapperRef} className="relative">
      <div
        aria-hidden={!refreshing && pull === 0}
        className="pointer-events-none absolute inset-x-0 z-10 flex flex-col items-center gap-1.5"
        style={{
          top: topOffset,
          transform: `translateY(${pull - 56}px)`,
          opacity,
          transition: refreshing || pull === 0 ? "transform 200ms ease-out, opacity 200ms ease-out" : "none",
        }}
      >
        <div
          className={cn(
            "grid h-9 w-9 place-items-center rounded-full border border-border bg-surface shadow-stone",
            armed && "border-accent/60",
          )}
        >
          {refreshing ? (
            <RefreshCw size={14} className="animate-spin text-accent" />
          ) : (
            <ArrowDown
              size={14}
              className={cn(
                "transition-colors",
                armed ? "text-accent" : "text-ink-muted",
              )}
              style={{
                transform: `rotate(${rotate}deg)`,
                transition: "transform 80ms linear",
              }}
            />
          )}
        </div>
        <span
          className={cn(
            "rounded-full bg-surface/95 px-2 py-0.5 font-mono text-[9.5px] font-semibold uppercase tracking-brand shadow-stone backdrop-blur-sm transition-colors",
            armed || refreshing ? "text-accent" : "text-ink-muted",
          )}
        >
          {label}
        </span>
      </div>
      <div
        className={className}
        style={{
          transform: `translateY(${pull * 0.45}px)`,
          transition: refreshing || pull === 0 ? "transform 200ms ease-out" : "none",
        }}
      >
        {children}
      </div>
    </div>
  );
}
