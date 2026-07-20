import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DataTable, type Column } from "./DataTable";
import { downloadCSV } from "../lib/csv";

vi.mock("../lib/csv", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/csv")>();
  return { ...actual, downloadCSV: vi.fn() };
});

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
const originalInnerHeight = Object.getOwnPropertyDescriptor(window, "innerHeight");

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
  if (originalInnerHeight) Object.defineProperty(window, "innerHeight", originalInnerHeight);
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

  it("keeps short mobile lists complete and preserves the Cards/Table representation toggle", () => {
    setViewport(375);
    const onRowClick = vi.fn();

    const { container } = render(
      <DataTable
        tableId="orders-short-mobile"
        rows={rows.slice(0, 20)}
        columns={columns}
        getRowKey={(row) => row.id}
        onRowClick={onRowClick}
      />,
    );

    expect(container.querySelector("table")).toBeNull();
    const renderedCards = container.querySelectorAll<HTMLElement>("[data-mobile-card]");
    expect(renderedCards).toHaveLength(20);
    expect(renderedCards[0]?.style.contentVisibility).toBe("auto");
    expect(renderedCards[0]?.getAttribute("role")).toBe("button");
    expect(renderedCards[0]?.tabIndex).toBe(0);
    fireEvent.keyDown(renderedCards[0]!, { key: "Enter" });
    expect(onRowClick).toHaveBeenLastCalledWith(rows[0]);

    fireEvent.click(screen.getByRole("button", { name: "Switch to table view" }));
    expect(container.querySelector("table")).not.toBeNull();
    expect(container.querySelectorAll("[data-mobile-card]")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Switch to card view" }));
    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelectorAll("[data-mobile-card]")).toHaveLength(20);
  });

  it("switches the mounted representation at the sm breakpoint and cleans up its listener", () => {
    const viewport = setViewport(1280);
    const { container, unmount } = render(
      <DataTable tableId="orders" rows={rows} columns={columns} getRowKey={(row) => row.id} />,
    );

    expect(container.querySelector("table")).not.toBeNull();
    act(() => viewport.resize(375));
    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelectorAll("[data-mobile-card]").length).toBeGreaterThan(0);
    expect(container.querySelectorAll("[data-mobile-card]").length).toBeLessThanOrEqual(100);
    act(() => viewport.resize(1280));
    expect(container.querySelector("table")).not.toBeNull();
    expect(container.querySelectorAll("[data-mobile-card]")).toHaveLength(0);

    expect(viewport.listenerCount()).toBe(1);
    unmount();
    expect(viewport.listenerCount()).toBe(0);
  });

  it("keeps a variable-height 10,000-card mobile list bounded and reaches its tail", () => {
    setViewport(375);
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      if (!this.hasAttribute("data-vcard")) return 0;
      return Number(this.dataset.vindex) % 2 === 0 ? 80 : 140;
    });
    const largeRows: Row[] = Array.from({ length: 10_000 }, (_, index) => ({
      id: index + 1,
      name: `Order ${index + 1}`,
      status: index % 2 ? "Open" : "Closed",
    }));
    const { container } = render(
      <DataTable
        tableId="orders-mobile-10k"
        rows={largeRows}
        columns={columns}
        getRowKey={(row) => row.id}
      />,
    );

    const list = container.querySelector<HTMLElement>("[data-mobile-virtual-list]")!;
    const mountedCards = () => [...list.querySelectorAll<HTMLElement>("[data-vcard]")];
    expect(list.getAttribute("role")).toBe("list");
    expect(list.getAttribute("aria-label")).toBe(
      "10000 loaded records. Only visible records are mounted; scroll to browse this loaded set.",
    );
    expect(mountedCards().length).toBeGreaterThan(0);
    expect(mountedCards().length).toBeLessThanOrEqual(100);
    expect(mountedCards()[0]?.getAttribute("role")).toBe("listitem");
    expect(mountedCards()[0]?.getAttribute("aria-posinset")).toBe("1");
    expect(mountedCards()[0]?.getAttribute("aria-setsize")).toBe("10000");
    expect(mountedCards()[0]?.offsetHeight).toBe(80);
    expect(mountedCards()[1]?.offsetHeight).toBe(140);
    expect(screen.queryByText("Order 10000")).toBeNull();

    let top = 0;
    const virtualContentHeight = () => {
      const children = [...list.children] as HTMLElement[];
      return children.reduce((sum, child) => {
        const height = child.hasAttribute("data-vcard")
          ? child.offsetHeight
          : Number.parseFloat(child.style.height || "0");
        return sum + height;
      }, 0) + Math.max(0, children.length - 1) * 8;
    };
    vi.spyOn(list, "getBoundingClientRect").mockImplementation(() => ({
      top,
      bottom: top + virtualContentHeight(),
      left: 0,
      right: 375,
      width: 375,
      height: virtualContentHeight(),
      x: 0,
      y: top,
      toJSON: () => ({}),
    }));
    const maxScrollTop = virtualContentHeight() - window.innerHeight;
    expect(maxScrollTop).toBeGreaterThan(0);
    top = -maxScrollTop;
    act(() => {
      window.dispatchEvent(new Event("scroll"));
      frames.splice(0).forEach((frame) => frame(0));
    });

    expect(screen.getByText("Order 10000")).toBeTruthy();
    expect(screen.queryByText("Order 1")).toBeNull();
    expect(list.lastElementChild?.hasAttribute("data-vcard")).toBe(true);
    expect(mountedCards().length).toBeLessThanOrEqual(100);
    expect(mountedCards().at(-1)?.getAttribute("aria-posinset")).toBe("10000");
    expect(mountedCards().at(-1)?.getAttribute("aria-setsize")).toBe("10000");

    const download = vi.mocked(downloadCSV);
    download.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(download).toHaveBeenCalledOnce();
    const exportedCSV = download.mock.calls[0]?.[1] ?? "";
    expect(exportedCSV.split("\r\n")).toHaveLength(largeRows.length + 1);
    expect(exportedCSV).toContain("Order 1,Closed");
    expect(exportedCSV).toContain("Order 10000,Open");

    fireEvent.click(screen.getByRole("button", { name: "Switch to table view" }));
    expect(container.querySelector("table")).not.toBeNull();
    expect(container.querySelector("[data-mobile-virtual-list]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Switch to card view" }));
    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelector("[data-mobile-virtual-list]")).not.toBeNull();
    expect(container.querySelectorAll("[data-mobile-card]").length).toBeLessThanOrEqual(100);
  });

  it("keeps the DOM bounded and reaches the final row in a 10,000-row dataset", () => {
    setViewport(1280);
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    const rowHeight = 33;
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.matches("tr[data-vrow]") ? rowHeight : 0;
    });
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
    const virtualContentHeight = () =>
      [...body.children].reduce((total, child) => {
        const row = child as HTMLTableRowElement;
        if (row.hasAttribute("data-vrow")) return total + row.offsetHeight;
        return total + Number.parseFloat(row.querySelector<HTMLElement>("td")?.style.height || "0");
      }, 0);
    expect(virtualContentHeight()).toBe(largeRows.length * rowHeight);
    let top = 0;
    vi.spyOn(body, "getBoundingClientRect").mockImplementation(() => ({
      top,
      bottom: top + virtualContentHeight(),
      left: 0,
      right: 1000,
      width: 1000,
      height: virtualContentHeight(),
      x: 0,
      y: top,
      toJSON: () => ({}),
    }));
    const maxScrollTop = virtualContentHeight() - window.innerHeight;
    expect(maxScrollTop).toBeGreaterThan(0);
    top = -maxScrollTop;
    act(() => {
      window.dispatchEvent(new Event("scroll"));
      frames.splice(0).forEach((frame) => frame(0));
    });

    expect(screen.getByText("Order 10000")).toBeTruthy();
    expect(screen.queryByText("Order 1")).toBeNull();
    expect(container.querySelectorAll("tr[data-vrow]").length).toBeLessThanOrEqual(60);
    expect(virtualContentHeight()).toBe(largeRows.length * rowHeight);
  });
});

describe("DataTable column width persistence", () => {
  it("updates the drag width live without writing storage, then persists once on mouseup", () => {
    setViewport(1280);
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    render(
      <DataTable
        tableId="resize-persistence"
        rows={rows.slice(0, 2)}
        columns={columns}
        getRowKey={(row) => row.id}
      />,
    );

    // Ignore the preference hooks' initial mount writes; this assertion is
    // specifically about writes caused by the resize gesture.
    setItem.mockClear();
    const handle = screen.getAllByRole("separator", { name: "Resize column" })[0];

    fireEvent.mouseDown(handle, { clientX: 100 });
    fireEvent.mouseMove(window, { clientX: 140 });

    expect(handle.parentElement?.style.width).toBe("200px");
    expect(setItem.mock.calls.filter(([key]) => key === "dt:widths:resize-persistence")).toHaveLength(0);

    fireEvent.mouseUp(window);

    const widthWrites = setItem.mock.calls.filter(
      ([key]) => key === "dt:widths:resize-persistence",
    );
    expect(widthWrites).toHaveLength(1);
    expect(JSON.parse(String(widthWrites[0]?.[1]))).toEqual({ name: 200 });
  });

  it("persists the final width and detaches drag listeners when the window blurs", () => {
    setViewport(1280);
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const removeEventListener = vi.spyOn(window, "removeEventListener");

    render(
      <DataTable
        tableId="resize-blur"
        rows={rows.slice(0, 2)}
        columns={columns}
        getRowKey={(row) => row.id}
      />,
    );

    setItem.mockClear();
    removeEventListener.mockClear();
    const handle = screen.getAllByRole("separator", { name: "Resize column" })[0];

    fireEvent.mouseDown(handle, { clientX: 100 });
    fireEvent.mouseMove(window, { clientX: 130 });
    fireEvent(window, new Event("blur"));

    const widthWrites = setItem.mock.calls.filter(([key]) => key === "dt:widths:resize-blur");
    expect(widthWrites).toHaveLength(1);
    expect(JSON.parse(String(widthWrites[0]?.[1]))).toEqual({ name: 190 });
    expect(removeEventListener.mock.calls.some(([type]) => type === "mousemove")).toBe(true);
    expect(removeEventListener.mock.calls.some(([type]) => type === "mouseup")).toBe(true);
    expect(removeEventListener.mock.calls.some(([type]) => type === "blur")).toBe(true);

    fireEvent.mouseMove(window, { clientX: 180 });
    fireEvent.mouseUp(window);
    expect(handle.parentElement?.style.width).toBe("190px");
    expect(setItem.mock.calls.filter(([key]) => key === "dt:widths:resize-blur")).toHaveLength(1);
  });

  it("cleans up an active drag on unmount and directly persists its last width", () => {
    setViewport(1280);
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const addEventListener = vi.spyOn(window, "addEventListener");
    const removeEventListener = vi.spyOn(window, "removeEventListener");

    const { unmount } = render(
      <DataTable
        tableId="resize-unmount"
        rows={rows.slice(0, 2)}
        columns={columns}
        getRowKey={(row) => row.id}
      />,
    );

    setItem.mockClear();
    addEventListener.mockClear();
    removeEventListener.mockClear();
    const handle = screen.getAllByRole("separator", { name: "Resize column" })[0];
    fireEvent.mouseDown(handle, { clientX: 100 });
    fireEvent.mouseMove(window, { clientX: 150 });

    const dragListeners = new Map(
      addEventListener.mock.calls
        .filter(([type]) => type === "mousemove" || type === "mouseup" || type === "blur")
        .map(([type, listener]) => [type, listener]),
    );
    expect([...dragListeners.keys()].sort()).toEqual(["blur", "mousemove", "mouseup"]);

    unmount();

    for (const [type, listener] of dragListeners) {
      expect(removeEventListener).toHaveBeenCalledWith(type, listener);
    }
    const widthWrites = setItem.mock.calls.filter(([key]) => key === "dt:widths:resize-unmount");
    expect(widthWrites).toHaveLength(1);
    expect(JSON.parse(String(widthWrites[0]?.[1]))).toEqual({ name: 210 });

    fireEvent.mouseMove(window, { clientX: 200 });
    fireEvent.mouseUp(window);
    fireEvent(window, new Event("blur"));
    expect(setItem.mock.calls.filter(([key]) => key === "dt:widths:resize-unmount")).toHaveLength(1);
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
