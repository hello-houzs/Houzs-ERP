// Tests for the variable-size virtualizer shim.
//
// The behaviour under test is the one that lets DataGrid keep windowing while a
// row is expanded. Before this, the shim read estimateSize(0) ONCE and assumed
// every row was that tall (`total = count * size`, `start = i * size`), so an
// open expansion panel — 100-400px where the shim reserved 30 — made the
// spacer rows mis-reserve the scroll height. DataGrid worked around it by
// switching virtualisation OFF whenever any row was expanded, which put ~1100
// SKUs into the DOM on one chevron click.
//
// These assert the offset arithmetic directly: getTotalSize() and each item's
// start/end ARE the spacer heights DataGrid renders (padTop = first.start,
// padBottom = getTotalSize() - last.end), so if they are right the scroll
// height is right.

import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useVirtualizer } from './react-virtual-shim';

const ROW = 30;

/* jsdom gives every element clientHeight 0, so the hook falls back to
   `averageSize * min(count, 30)` for the viewport. That is deterministic, which
   is what these assertions rely on. */
function render(opts: {
  count: number;
  sizeAt: (i: number) => number;
  overscan?: number;
  sizeVersion?: number | string;
}) {
  return renderHook(({ sizeVersion }: { sizeVersion?: number | string }) =>
    useVirtualizer({
      count: opts.count,
      getScrollElement: () => null,
      estimateSize: opts.sizeAt,
      overscan: opts.overscan ?? 0,
      sizeVersion,
    }),
  { initialProps: { sizeVersion: opts.sizeVersion } });
}

describe('useVirtualizer — uniform rows (parity with the old shim)', () => {
  it('total size is count * rowHeight', () => {
    const { result } = render({ count: 1100, sizeAt: () => ROW });
    expect(result.current.getTotalSize()).toBe(1100 * ROW);
  });

  it('item offsets are exact multiples of the row height', () => {
    const { result } = render({ count: 100, sizeAt: () => ROW });
    const items = result.current.getVirtualItems();
    expect(items[0]!.start).toBe(0);
    for (const it of items) {
      expect(it.start).toBe(it.index * ROW);
      expect(it.size).toBe(ROW);
    }
  });

  it('windows the list — it does not return every row', () => {
    const { result } = render({ count: 1100, sizeAt: () => ROW });
    expect(result.current.getVirtualItems().length).toBeLessThan(100);
  });
});

describe('useVirtualizer — variable rows (the expanded-row case)', () => {
  /* Row 3 is "expanded": 30px of row plus a 300px panel. */
  const sizeAt = (i: number) => (i === 3 ? ROW + 300 : ROW);

  it('total size accounts for the expanded row', () => {
    const { result } = render({ count: 50, sizeAt });
    // 50 rows at 30 + one 300px panel.
    expect(result.current.getTotalSize()).toBe(50 * ROW + 300);
  });

  it('rows AFTER the expanded one are pushed down by the panel height', () => {
    const { result } = render({ count: 50, sizeAt });
    const byIndex = new Map(result.current.getVirtualItems().map((i) => [i.index, i]));
    // Rows before the expansion are unaffected.
    expect(byIndex.get(2)!.start).toBe(2 * ROW);
    // The expanded row itself is 330 tall.
    expect(byIndex.get(3)!.size).toBe(ROW + 300);
    // Everything after is offset by the panel — this is what the old uniform
    // arithmetic got wrong, by exactly 300px per open panel.
    expect(byIndex.get(4)!.start).toBe(4 * ROW + 300);
  });

  it('an unexpanded list and an expanded list differ by exactly the panel', () => {
    const flat = render({ count: 50, sizeAt: () => ROW });
    const expanded = render({ count: 50, sizeAt });
    expect(expanded.result.current.getTotalSize() - flat.result.current.getTotalSize())
      .toBe(300);
  });
});

describe('useVirtualizer — sizeVersion', () => {
  it('rebuilds the offset table when sizeVersion changes', () => {
    /* Mutable so the hook returns a different answer on re-render WITHOUT the
       estimateSize identity being the trigger — sizeVersion is the trigger,
       which is the contract DataGrid relies on. */
    let panel = 0;
    const sizeAt = (i: number) => (i === 1 ? ROW + panel : ROW);
    const { result, rerender } = renderHook(
      ({ sizeVersion }: { sizeVersion: number }) =>
        useVirtualizer({
          count: 40,
          getScrollElement: () => null,
          estimateSize: sizeAt,
          overscan: 0,
          sizeVersion,
        }),
      { initialProps: { sizeVersion: 0 } },
    );

    expect(result.current.getTotalSize()).toBe(40 * ROW);

    // A panel opened and was measured at 250px.
    panel = 250;
    rerender({ sizeVersion: 1 });
    expect(result.current.getTotalSize()).toBe(40 * ROW + 250);

    // Collapsed again.
    panel = 0;
    rerender({ sizeVersion: 2 });
    expect(result.current.getTotalSize()).toBe(40 * ROW);
  });
});

describe('useVirtualizer — degenerate input', () => {
  it('count 0 returns no items and no height', () => {
    const { result } = render({ count: 0, sizeAt: () => ROW });
    expect(result.current.getVirtualItems()).toEqual([]);
    expect(result.current.getTotalSize()).toBe(0);
  });

  it('a non-finite or negative size contributes zero rather than NaN', () => {
    /* A NaN offset would propagate into the spacer <td> height and collapse the
       scroll container — fail closed to 0 instead. */
    const { result } = render({ count: 10, sizeAt: (i) => (i === 5 ? NaN : ROW) });
    expect(Number.isFinite(result.current.getTotalSize())).toBe(true);
    expect(result.current.getTotalSize()).toBe(9 * ROW);
  });
});
