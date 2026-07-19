// react-virtual-shim — a minimal, dependency-free stand-in for the exact slice
// of @tanstack/react-virtual that DataGrid uses (`useVirtualizer` →
// getVirtualItems / getTotalSize). The Houzs frontend does NOT have
// @tanstack/react-virtual installed and we must not run npm install, so this
// reimplements just enough to keep DataGrid.tsx importing `useVirtualizer`
// from '@tanstack/react-virtual' (aliased to this file in vite.config +
// tsconfig paths).
//
// Behaviour parity for DataGrid's use:
//   - PER-INDEX estimateSize (rows are no longer assumed uniform)
//   - overscan
//   - windows the visible slice from a scroll container
//   - re-measures on scroll + resize
//
// VARIABLE SIZES (2026-07, unbounded-lists pass). The original shim read
// `estimateSize(0)` once and multiplied: `total = count * size`, `start =
// i * size`. That is why DataGrid had to switch windowing OFF entirely the
// moment a row was expanded — an open expansion panel is 100-400px tall, the
// spacers reserved 30px for it, and the scroll height was wrong by the
// difference. Sizes are now accumulated into a prefix-sum offset table, so a
// row may be any height and the spacers still reserve exactly the right space.
// Offsets are rebuilt only when `count` or `sizeVersion` changes — NOT on
// every scroll frame, which fires a re-render.
import { useEffect, useMemo, useRef, useState } from 'react';

export type VirtualItem = {
  index: number;
  start: number;
  end: number;
  size: number;
  key: number;
};

type VirtualizerOptions = {
  count: number;
  getScrollElement: () => HTMLElement | null;
  estimateSize: (index: number) => number;
  overscan?: number;
  /* Bumped by the caller whenever `estimateSize` would return a different
     answer for any index (a measured row height landed, a row expanded or
     collapsed, an expansion panel resized). `estimateSize` is a fresh closure
     every render, so it cannot itself be a dependency — this is the signal
     that the offset table is stale. */
  sizeVersion?: number | string;
};

export type Virtualizer = {
  getVirtualItems: () => VirtualItem[];
  getTotalSize: () => number;
};

/* Index of the last offset <= target. offsets has count+1 entries and is
   non-decreasing, so a plain binary search over it locates the row containing
   a given scroll position in O(log n) instead of the old O(1) division that
   only worked because every row was the same height. */
function findIndexAtOffset(offsets: number[], target: number): number {
  let lo = 0;
  let hi = offsets.length - 2; // last valid ROW index
  if (hi < 0) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid]! <= target) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function useVirtualizer(opts: VirtualizerOptions): Virtualizer {
  const { count, getScrollElement, estimateSize, overscan = 0, sizeVersion } = opts;
  const [, force] = useState(0);
  const rerender = () => force((n) => n + 1);

  /* estimateSize is a new closure each render; keep the latest in a ref so the
     memo below can call it without taking it as a dependency (which would
     rebuild the table every render and defeat the point). */
  const estimateRef = useRef(estimateSize);
  estimateRef.current = estimateSize;

  /* Prefix sums: offsets[i] is the pixel offset of row i, offsets[count] is
     the total height. */
  const offsets = useMemo(() => {
    const acc = new Array<number>(count + 1);
    acc[0] = 0;
    for (let i = 0; i < count; i++) {
      const h = estimateRef.current(i);
      acc[i + 1] = acc[i]! + (Number.isFinite(h) && h > 0 ? h : 0);
    }
    return acc;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count, sizeVersion]);

  const scrollTopRef = useRef(0);
  const viewportRef = useRef(0);

  useEffect(() => {
    const el = getScrollElement();
    if (!el) return;
    const read = () => {
      scrollTopRef.current = el.scrollTop;
      viewportRef.current = el.clientHeight;
      rerender();
    };
    read();
    el.addEventListener('scroll', read, { passive: true });
    const ro =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(read) : null;
    ro?.observe(el);
    window.addEventListener('resize', read);
    return () => {
      el.removeEventListener('scroll', read);
      ro?.disconnect();
      window.removeEventListener('resize', read);
    };
    // getScrollElement is a stable closure in DataGrid (returns a ref); count
    // change re-runs to re-read the viewport.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count]);

  const total = count > 0 ? offsets[count]! : 0;
  const averageSize = count > 0 ? total / count || 1 : 1;

  const getTotalSize = () => total;

  const getVirtualItems = (): VirtualItem[] => {
    if (count === 0) return [];
    const scrollTop = scrollTopRef.current;
    const viewport = viewportRef.current || averageSize * Math.min(count, 30);

    const firstVisible = findIndexAtOffset(offsets, scrollTop);
    const first = Math.max(0, firstVisible - overscan);

    /* Walk forward until the accumulated height covers the viewport, then add
       `overscan` more. With uniform rows this lands on the same slice the old
       division did; with a tall expansion panel open it correctly renders
       FEWER rows rather than over-reserving. */
    const viewportEnd = scrollTop + viewport;
    let last = firstVisible;
    while (last < count - 1 && offsets[last + 1]! < viewportEnd) last++;
    last = Math.min(count - 1, last + overscan);

    const items: VirtualItem[] = [];
    for (let i = first; i <= last; i++) {
      const start = offsets[i]!;
      const end = offsets[i + 1]!;
      items.push({ index: i, start, end, size: end - start, key: i });
    }
    return items;
  };

  return { getVirtualItems, getTotalSize };
}
