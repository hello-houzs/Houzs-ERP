// DataGrid virtualisation — the measurement behind the "one chevron click puts
// ~1100 SKUs in the DOM" finding, and the proof it no longer does.
//
// Until 2026-07 `canVirtualize` included `expandedRows.size === 0`: expanding a
// single row switched windowing off for the WHOLE grid, so Inventory Balances
// (~1100 SKUs) went from a windowed slice to every row at once. The virtualizer
// sized rows uniformly, so a variable-height expansion panel would have made the
// spacers reserve the wrong scroll height — the gate was a real workaround for a
// real problem, which is why the shim had to learn per-index sizes first.
//
// These tests count actual <tr> nodes. jsdom reports clientHeight 0, so the shim
// falls back to a deterministic ~30-row viewport; the absolute slice size is not
// the assertion, the ORDER OF MAGNITUDE is.

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DataGrid, type DataGridColumn } from './DataGrid';

/* vitest runs with `globals: false`, so @testing-library/react never registers
   its automatic afterEach cleanup — without this the previous test's grid stays
   mounted in document.body and a `screen` query resolves against IT. Every
   query below is also scoped to the render's own container for the same
   reason. */
afterEach(cleanup);

type Row = { id: string; code: string; qty: number };

const makeRows = (n: number): Row[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `r${i}`,
    code: `SKU-${String(i).padStart(4, '0')}`,
    qty: i,
  }));

const columns: DataGridColumn<Row>[] = [
  { key: 'code', label: 'Code', accessor: (r) => r.code, searchValue: (r) => r.code },
  { key: 'qty', label: 'Qty', accessor: (r) => String(r.qty) },
];

/* Data rows only — group banners and the two aria-hidden spacer rows are not
   rows of content and must not be counted as if they were. */
function dataRowCount(container: HTMLElement): number {
  return container.querySelectorAll('tbody tr:not([aria-hidden="true"])').length;
}

function renderGrid(rowCount: number, opts: { expandable?: boolean } = {}) {
  return render(
    <DataGrid<Row>
      rows={makeRows(rowCount)}
      columns={columns}
      storageKey={`test-grid-${rowCount}-${opts.expandable ? 'exp' : 'flat'}-${Math.random()}`}
      rowKey={(r) => r.id}
      {...(opts.expandable
        ? {
            expandable: {
              renderExpansion: (r: Row) => (
                <div data-testid={`panel-${r.id}`} style={{ height: 300 }}>
                  Detail for {r.code}
                </div>
              ),
            },
          }
        : {})}
    />,
  );
}

describe('DataGrid — windowing a large flat list', () => {
  it('renders a slice, not all 1100 rows', () => {
    const { container } = renderGrid(1100);
    const rendered = dataRowCount(container);
    expect(rendered).toBeGreaterThan(0);
    // The whole point: two orders of magnitude fewer nodes than rows.
    expect(rendered).toBeLessThan(120);
  });

  it('renders every row below the windowing threshold', () => {
    const { container } = renderGrid(10);
    expect(dataRowCount(container)).toBe(10);
  });
});

describe('DataGrid — expanding a row keeps the list windowed', () => {
  it('one chevron click does not put all 1100 rows in the DOM', async () => {
    const user = userEvent.setup();
    const { container } = renderGrid(1100, { expandable: true });

    const before = dataRowCount(container);
    expect(before).toBeLessThan(120);

    const chevron = within(container).getAllByRole('button', { name: /expand row/i })[0]!;
    await user.click(chevron);

    const after = dataRowCount(container);

    // The panel opened...
    expect(container.querySelectorAll('[data-testid^="panel-"]').length).toBe(1);
    // ...and the grid is still windowed. This is the regression that matters:
    // before the fix `after` was 1100 (plus the panel row).
    expect(after).toBeLessThan(150);
    // Expanding adds roughly one row (the panel), not a thousand.
    expect(after - before).toBeLessThan(20);
  });

  it('collapsing returns to the collapsed slice', async () => {
    const user = userEvent.setup();
    const { container } = renderGrid(1100, { expandable: true });
    const before = dataRowCount(container);

    const chevron = within(container).getAllByRole('button', { name: /expand row/i })[0]!;
    await user.click(chevron);
    expect(container.querySelectorAll('[data-testid^="panel-"]').length).toBe(1);

    const collapse = within(container).getAllByRole('button', { name: /collapse row/i })[0]!;
    await user.click(collapse);

    expect(container.querySelectorAll('[data-testid^="panel-"]').length).toBe(0);
    expect(dataRowCount(container)).toBe(before);
  });

  it('the expanded row still shows its own content', async () => {
    const user = userEvent.setup();
    const { container } = renderGrid(1100, { expandable: true });
    const chevron = within(container).getAllByRole('button', { name: /expand row/i })[0]!;
    await user.click(chevron);
    const panel = container.querySelector('[data-testid^="panel-"]')!;
    expect(within(panel as HTMLElement).getByText(/Detail for SKU-/)).toBeTruthy();
  });
});
