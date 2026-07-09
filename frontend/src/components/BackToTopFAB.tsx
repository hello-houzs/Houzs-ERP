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

const SCROLL_THRESHOLD = 160;

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
        // Sits to the LEFT of the QuickActionsFAB "+". Sizes/right-offsets
        // tuned to hard pixel values (Tailwind arbitrary-`calc(theme(...))`
        // sometimes fails to JIT-compile) so the button lands exactly one
        // FAB-width + 8 px to the left of the "+".
        //   Mobile "+":   h-12 w-12 (48 px) · right-4 (16 px) · bottom-24 (96 px)
        //   Desktop "+":  h-14 w-14 (56 px) · right-5 (20 px) · bottom-5 (20 px)
        //   Back-to-top mobile:  right-[72px] = 48 + 16 + 8
        //   Back-to-top desktop: right-[84px] = 56 + 20 + 8
        "h-12 w-12 right-[72px] bottom-[calc(6rem+env(safe-area-inset-bottom))]",
        "lg:h-14 lg:w-14 lg:right-[84px] lg:bottom-5",
      )}
    >
      <ArrowUp size={20} strokeWidth={2.4} />
    </button>
  );

  if (typeof document === "undefined") return null;
  return createPortal(node, document.body);
}
