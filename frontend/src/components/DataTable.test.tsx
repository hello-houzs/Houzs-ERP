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
});
