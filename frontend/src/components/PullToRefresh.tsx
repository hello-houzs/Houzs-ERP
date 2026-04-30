import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ArrowDown, RefreshCw } from "lucide-react";
import { cn } from "../lib/utils";

interface Props {
  /** Called when the user pulls past the threshold and releases. */
  onRefresh: () => Promise<unknown> | void;
  /** Optional extra padding above the indicator (e.g. when there's a sticky bar). */
  topOffset?: number;
  children: ReactNode;
  className?: string;
}

const THRESHOLD = 70;
const MAX_PULL = 110;

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
      if (dy <= 0) {
        // user is scrolling up again — abort the pull
        setPull(0);
        return;
      }
      // resistance: linear up to threshold, eased beyond
      const resisted =
        dy <= THRESHOLD
          ? dy
          : THRESHOLD + (dy - THRESHOLD) * 0.45;
      setPull(Math.min(resisted, MAX_PULL));
      // Prevent the browser's own pull-to-refresh / overscroll once we're
      // actively pulling — but only if we have meaningful movement.
      if (dy > 6 && e.cancelable) e.preventDefault();
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
          await onRefresh();
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
  const opacity = Math.min(pull / 30, 1);
  const rotate = Math.min((pull / THRESHOLD) * 180, 180);

  return (
    <div ref={wrapperRef} className="relative">
      <div
        aria-hidden={!refreshing && pull === 0}
        className="pointer-events-none absolute inset-x-0 z-10 flex justify-center"
        style={{
          top: topOffset,
          transform: `translateY(${pull - 36}px)`,
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
