// BackToTopFAB — floating "scroll to top" button, mounted alongside
// QuickActionsFAB. Nick 2026-07-09: "可以在每个页面都添加回去顶部的
// 在右下角 + 的左边" — a jump-to-top affordance sits to the LEFT of the
// existing "+" (New SO) FAB on every page.
//
// Only shows once the user has scrolled past ~400 px so it doesn't
// clutter the corner on short pages. Scrolls the same <main> element
// that QuickActionsFAB shares as a peer (Layout.tsx mounts the <main
// class="overflow-y-auto">; that's the app's real scroll container,
// window/document scrolling is disabled by `overflow: hidden` on the
// html/body).

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "react-router-dom";
import { ArrowUp } from "lucide-react";
import { cn } from "../lib/utils";

const SCROLL_THRESHOLD = 400;

export function BackToTopFAB() {
  const [visible, setVisible] = useState(false);
  const scrollElRef = useRef<HTMLElement | null>(null);
  const location = useLocation();

  useEffect(() => {
    // The Houzs layout wraps content in a single <main class="… overflow-y-auto …">
    // and disables document-level scrolling. That element IS the scroll container
    // — window.scrollTo would no-op.
    const main = document.querySelector("main");
    scrollElRef.current = main;
    if (!main) return;
    const onScroll = () => setVisible(main.scrollTop > SCROLL_THRESHOLD);
    onScroll();
    main.addEventListener("scroll", onScroll, { passive: true });
    return () => main.removeEventListener("scroll", onScroll);
  }, []);

  // Reset visibility on route change — a fresh page starts scrolled to top.
  useEffect(() => {
    setVisible(false);
  }, [location.pathname]);

  // Hide on the driver shell (separate layout, no <main> scroll container).
  if (location.pathname.startsWith("/driver")) return null;
  if (!visible) return null;

  const scrollToTop = () => {
    scrollElRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  };

  const node = (
    <button
      onClick={scrollToTop}
      aria-label="Back to top"
      title="Back to top"
      className={cn(
        "fixed z-40 inline-flex items-center justify-center rounded-full",
        "bg-surface text-ink-secondary border border-border shadow-slab",
        "transition-all duration-200 hover:scale-105 hover:text-primary hover:border-primary/40 active:scale-95",
        // Sits LEFT of QuickActionsFAB. That FAB uses
        //   mobile: h-12 w-12 · right-4 · bottom-24 + safe-area
        //   desktop: h-14 w-14 · right-5 · bottom-5
        // Push this one by (fab-width + gap) so the two live side-by-side.
        "h-12 w-12 right-[calc(theme(spacing.4)+theme(spacing.12)+theme(spacing.2))]",
        "lg:h-14 lg:w-14 lg:right-[calc(theme(spacing.5)+theme(spacing.14)+theme(spacing.2))]",
        "bottom-[calc(theme(spacing.24)+env(safe-area-inset-bottom))] lg:bottom-5",
      )}
    >
      <ArrowUp size={20} strokeWidth={2.4} />
    </button>
  );

  if (typeof document === "undefined") return null;
  return createPortal(node, document.body);
}
