import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Windowed vertical card list for the mobile screens. Renders only the cards
 * scrolled into view (plus overscan), so a 1,000-row list keeps ~30 nodes in
 * the DOM instead of all of them — the mobile analogue of the desktop DataTable
 * windowing.
 *
 * Page-scroll-preserving: a CAPTURING window scroll listener catches the mobile
 * scroll container's scroll (scroll events don't bubble), the visible slice is
 * measured from the list's viewport position, and two spacer divs reserve the
 * off-screen height so the scrollbar behaves normally. Card height is measured
 * from a real rendered card so the spacers can't drift.
 *
 * `gap` matches the caller's inter-card gap (default 11) so a short list looks
 * byte-identical to the plain `.map` container it replaces — it feeds both the
 * flex gap and the spacer math.
 *
 * No-op below `threshold` — short lists render exactly as before, so wiring this
 * into a list that's usually small (most modules) costs nothing until it grows.
 */
export function MobileVirtualList<T>({
  items,
  renderItem,
  getKey,
  estimateHeight = 88,
  threshold = 40,
  overscan = 8,
  gap = 11,
}: {
  items: T[];
  renderItem: (item: T, index: number) => ReactNode;
  getKey: (item: T, index: number) => string | number;
  estimateHeight?: number;
  threshold?: number;
  overscan?: number;
  gap?: number;
}) {
  const on = items.length > threshold;
  const ref = useRef<HTMLDivElement>(null);
  const rowH = useRef(estimateHeight + gap);
  const [range, setRange] = useState({ start: 0, end: threshold * 2 });

  useEffect(() => {
    if (!on) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const el = ref.current;
      if (!el) return;
      const card = el.querySelector<HTMLElement>("[data-vcard]");
      if (card && card.offsetHeight > 0) rowH.current = card.offsetHeight + gap;
      const rh = rowH.current || estimateHeight + gap;
      const top = el.getBoundingClientRect().top; // list top relative to viewport
      const first = Math.max(0, Math.floor(-top / rh) - overscan);
      const count = Math.ceil(window.innerHeight / rh) + overscan * 2;
      const last = Math.min(items.length, first + count);
      setRange((p) => (p.start === first && p.end === last ? p : { start: first, end: last }));
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [on, items.length, overscan, estimateHeight, gap]);

  const start = on ? range.start : 0;
  const end = on ? Math.min(items.length, range.end) : items.length;
  const rh = rowH.current;

  return (
    <div ref={ref} style={{ display: "flex", flexDirection: "column", gap }}>
      {on && start > 0 && <div aria-hidden style={{ height: Math.max(0, start * rh - gap) }} />}
      {items.slice(start, end).map((item, i) => (
        <div data-vcard="" key={getKey(item, start + i)}>
          {renderItem(item, start + i)}
        </div>
      ))}
      {on && end < items.length && (
        <div aria-hidden style={{ height: Math.max(0, (items.length - end) * rh - gap) }} />
      )}
    </div>
  );
}
