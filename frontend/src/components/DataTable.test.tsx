import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DataTable, type Column } from "./DataTable";

type Row = { id: number; name: string; status: string };

const rows: Row[] = Array.from({ length: 200 }, (_, index) => ({
  id: index + 1,
  name: `Order ${index + 1}`,
  status: index % 2 ? "Open" : "Closed",
}));

const columns: Column<Row>[] = [
  { key: "name", label: "Order", render: (row) => row.name, getValue: (row) => row.name },
  { key: "status", label: "Status", render: (row) => row.status, getValue: (row) => row.status },
];

const originalMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");
const originalInnerWidth = Object.getOwnPropertyDescriptor(window, "innerWidth");

function setViewport(width: number) {
  let currentWidth = width;
  const listeners = new Set<EventListener>();
  const setInnerWidth = (next: number) =>
    Object.defineProperty(window, "innerWidth", { configurable: true, value: next });
  setInnerWidth(currentWidth);
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      get matches() {
        return query === "(max-width: 639px)" ? currentWidth < 640 : false;
      },
      media: query,
      onchange: null,
      addEventListener: vi.fn((_type: string, listener: EventListener) => listeners.add(listener)),
      removeEventListener: vi.fn((_type: string, listener: EventListener) => listeners.delete(listener)),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  return {
    resize(next: number) {
      currentWidth = next;
      setInnerWidth(next);
      listeners.forEach((listener) => listener(new Event("change")));
    },
    listenerCount: () => listeners.size,
  };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalMatchMedia) Object.defineProperty(window, "matchMedia", originalMatchMedia);
  else Reflect.deleteProperty(window, "matchMedia");
  if (originalInnerWidth) Object.defineProperty(window, "innerWidth", originalInnerWidth);
});

describe("DataTable responsive rendering", () => {
  it("does not build the hidden mobile-card tree on desktop", () => {
    setViewport(1280);

    const { container } = render(
      <DataTable tableId="orders" rows={rows} columns={columns} getRowKey={(row) => row.id} />,
    );

    expect(container.querySelectorAll("[data-mobile-card]")).toHaveLength(0);
    const renderedRows = container.querySelectorAll("tr[data-vrow]").length;
    expect(renderedRows).toBeGreaterThan(0);
    expect(renderedRows).toBeLessThanOrEqual(60);
  });

  it("keeps all mobile cards accessible while applying off-screen layout containment", () => {
    setViewport(375);

    const { container } = render(
      <DataTable tableId="orders" rows={rows} columns={columns} getRowKey={(row) => row.id} />,
    );

    expect(container.querySelector("table")).toBeNull();
    const renderedCards = container.querySelectorAll<HTMLElement>("[data-mobile-card]");
    expect(renderedCards).toHaveLength(rows.length);
    expect(renderedCards[0]?.style.contentVisibility).toBe("auto");

    fireEvent.click(screen.getByRole("button", { name: "Switch to table view" }));
    expect(container.querySelector("table")).not.toBeNull();
    expect(container.querySelectorAll("[data-mobile-card]")).toHaveLength(0);
  });

  it("switches the mounted representation at the sm breakpoint and cleans up its listener", () => {
    const viewport = setViewport(1280);
    const { container, unmount } = render(
      <DataTable tableId="orders" rows={rows} columns={columns} getRowKey={(row) => row.id} />,
    );

    expect(container.querySelector("table")).not.toBeNull();
    act(() => viewport.resize(375));
    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelectorAll("[data-mobile-card]")).toHaveLength(rows.length);
    act(() => viewport.resize(1280));
    expect(container.querySelector("table")).not.toBeNull();
    expect(container.querySelectorAll("[data-mobile-card]")).toHaveLength(0);

    expect(viewport.listenerCount()).toBe(1);
    unmount();
    expect(viewport.listenerCount()).toBe(0);
  });

  it("keeps the DOM bounded and reaches the final row in a 10,000-row dataset", () => {
    setViewport(1280);
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const largeRows: Row[] = Array.from({ length: 10_000 }, (_, index) => ({
      id: index + 1,
      name: `Order ${index + 1}`,
      status: index % 2 ? "Open" : "Closed",
    }));
    const { container } = render(
      <DataTable tableId="orders-10k" rows={largeRows} columns={columns} getRowKey={(row) => row.id} />,
    );

    expect(container.querySelectorAll("tr[data-vrow]").length).toBeLessThanOrEqual(60);
    expect(screen.queryByText("Order 10000")).toBeNull();

    const body = container.querySelector("tbody")!;
    let top = 0;
    vi.spyOn(body, "getBoundingClientRect").mockImplementation(() => ({
      top,
      bottom: top + 330_000,
      left: 0,
      right: 1000,
      width: 1000,
      height: 330_000,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }));
    top = -329_200;
    act(() => {
      window.dispatchEvent(new Event("scroll"));
      frames.splice(0).forEach((frame) => frame(0));
    });

    expect(screen.getByText("Order 10000")).toBeTruthy();
    expect(screen.queryByText("Order 1")).toBeNull();
    expect(container.querySelectorAll("tr[data-vrow]").length).toBeLessThanOrEqual(60);
  });
});

describe("DataTable server search feedback", () => {
  it("propagates every keystroke and announces when rows are still catching up", () => {
    setViewport(1280);
    const onChange = vi.fn();
    const onToggleAll = vi.fn();

    render(
      <DataTable
        tableId="search-orders"
        rows={rows.slice(0, 2)}
        columns={columns}
        getRowKey={(row) => row.id}
        search={{
          value: "A",
          onChange,
          debounceMs: 0,
          searching: false,
        }}
        selection={{
          selectedIds: new Set(),
          onToggle: vi.fn(),
          onToggleAll,
        }}
      />,
    );

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "A1" } });

    expect(onChange).toHaveBeenLastCalledWith("A1");
    expect(screen.getByRole("status").textContent).toContain("Searching…");
    expect(screen.queryByText("Order 1")).toBeNull();
    expect(screen.getByRole("button", { name: "Export" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("checkbox", { name: "Select all rows" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all rows" }));
    expect(onToggleAll).not.toHaveBeenCalled();
  });

  it("keeps stale row actions disabled when the replacement search fails", () => {
    setViewport(1280);
    render(
      <DataTable
        tableId="failed-search-orders"
        rows={rows.slice(0, 2)}
        columns={columns}
        getRowKey={(row) => row.id}
        error="Search failed"
        selection={{ selectedIds: new Set(), onToggle: vi.fn(), onToggleAll: vi.fn() }}
      />,
    );

    expect(screen.getByRole("button", { name: "Export" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("checkbox", { name: "Select all rows" }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByText("2 rows")).toBeNull();
  });

  it("states whether search covers the server set or only loaded rows", () => {
    setViewport(1280);
    const { rerender } = render(
      <DataTable
        tableId="search-scope"
        rows={rows.slice(0, 2)}
        columns={columns}
        getRowKey={(row) => row.id}
        search={{ value: "", onChange: vi.fn(), scope: "server", totalRecords: 200 }}
      />,
    );
    expect(screen.getByText(/Searches across all pages you can access/)).toBeTruthy();
    expect(screen.getByText(/200 records/)).toBeTruthy();

    rerender(
      <DataTable
        tableId="search-scope"
        rows={rows.slice(0, 2)}
        columns={columns}
        getRowKey={(row) => row.id}
        search={{ value: "", onChange: vi.fn() }}
      />,
    );
    expect(screen.getByText("Searches loaded rows only")).toBeTruthy();
  });

  it("does not show a stale result count while replacement results are pending", () => {
    setViewport(1280);
    render(
      <DataTable
        tableId="search-scope-pending"
        rows={rows.slice(0, 2)}
        columns={columns}
        getRowKey={(row) => row.id}
        search={{
          value: "A1",
          onChange: vi.fn(),
          searching: true,
          scope: "server",
          totalRecords: 200,
        }}
      />,
    );
    expect(screen.getByText("Searches across all pages you can access")).toBeTruthy();
    expect(screen.queryByText(/200 matches/)).toBeNull();
  });

  it("does not announce zero records before the first server count settles", () => {
    setViewport(1280);
    render(
      <DataTable
        tableId="search-scope-initial-count"
        rows={[]}
        columns={columns}
        getRowKey={(row) => row.id}
        search={{
          value: "",
          onChange: vi.fn(),
          searching: false,
          countPending: true,
          scope: "server",
          totalRecords: 0,
        }}
      />,
    );
    expect(screen.getByText("Searches across all pages you can access")).toBeTruthy();
    expect(screen.queryByText(/0 records/)).toBeNull();
  });
});
