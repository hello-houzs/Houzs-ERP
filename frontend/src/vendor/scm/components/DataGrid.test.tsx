import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { DataGrid, type DataGridColumn } from "./DataGrid";

type Row = { id: string; name: string };
const rows: Row[] = [
  { id: "1", name: "Alpha" },
  { id: "2", name: "A1" },
];
const columns: DataGridColumn<Row>[] = [
  { key: "name", label: "Name", accessor: (row) => row.name, searchValue: (row) => row.name },
];

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("DataGrid search scope", () => {
  test("states that built-in search only covers the loaded rows", () => {
    render(
      <DataGrid
        rows={rows}
        columns={columns}
        storageKey="search-scope-test"
        rowKey={(row) => row.id}
      />,
    );
    expect(screen.getByText("Searches 2 loaded rows only")).toBeTruthy();
  });
});

describe("DataGrid structural performance", () => {
  test("keeps 10,000 rows windowed and reaches the final row at the real scroll limit", () => {
    const rowHeight = 30;
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.matches("tr[data-vrow]") ? rowHeight : 0;
    });
    const largeRows: Row[] = Array.from({ length: 10_000 }, (_, index) => ({
      id: String(index + 1),
      name: `Order ${index + 1}`,
    }));

    const { container } = render(
      <DataGrid
        rows={largeRows}
        columns={columns}
        storageKey="structural-performance-10k"
        rowKey={(row) => row.id}
      />,
    );

    const tbody = container.querySelector("tbody")!;
    const scroller = container.querySelector("table")!.parentElement as HTMLElement;
    const mountedRows = () => container.querySelectorAll("tr[data-vrow]").length;
    const virtualContentHeight = () =>
      [...tbody.children].reduce((total, child) => {
        const row = child as HTMLTableRowElement;
        if (row.hasAttribute("data-vrow")) return total + row.offsetHeight;
        const spacerHeight = Number.parseFloat(row.querySelector<HTMLElement>("td")?.style.height || "0");
        return total + spacerHeight;
      }, 0);

    expect(screen.getByText("Order 1")).toBeTruthy();
    expect(screen.queryByText("Order 10000")).toBeNull();
    expect(mountedRows()).toBeGreaterThan(0);
    expect(mountedRows()).toBeLessThanOrEqual(60);
    expect(virtualContentHeight()).toBe(largeRows.length * rowHeight);

    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 320 });
    Object.defineProperty(scroller, "scrollHeight", {
      configurable: true,
      get: virtualContentHeight,
    });
    const maxScrollTop = scroller.scrollHeight - scroller.clientHeight;
    expect(maxScrollTop).toBeGreaterThan(0);
    scroller.scrollTop = maxScrollTop;
    fireEvent.scroll(scroller);

    expect(screen.getByText("Order 10000")).toBeTruthy();
    expect(screen.queryByText("Order 1")).toBeNull();
    expect(mountedRows()).toBeGreaterThan(0);
    expect(mountedRows()).toBeLessThanOrEqual(60);
    expect(virtualContentHeight()).toBe(largeRows.length * rowHeight);
  });
});
