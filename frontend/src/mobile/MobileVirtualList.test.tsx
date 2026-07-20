import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileVirtualList } from "./MobileVirtualList";

afterEach(() => vi.unstubAllGlobals());

describe("MobileVirtualList scalability", () => {
  it("keeps the DOM bounded and reaches the final card in a variable-height 10,000-record list", () => {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      const index = Number(this.dataset.vindex ?? 0);
      return index % 2 === 0 ? 80 : 140;
    });
    const items = Array.from({ length: 10_000 }, (_, index) => ({ id: index + 1 }));

    const { container } = render(
      <MobileVirtualList
        items={items}
        getKey={(item) => item.id}
        renderItem={(item) => <div>Order {item.id}</div>}
      />,
    );

    const mounted = container.querySelectorAll("[data-vcard]").length;
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThanOrEqual(100);

    const list = container.querySelector<HTMLElement>("[data-mobile-virtual-list]")!;
    let top = 0;
    vi.spyOn(list, "getBoundingClientRect").mockImplementation(() => ({
      top,
      bottom: top + 1_100_000,
      left: 0,
      right: 320,
      width: 320,
      height: 1_100_000,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }));
    // Derive the maximum reachable scroll from the component's own rendered
    // spacer/card geometry. An over-scroll constant would clamp to the final
    // index even if the total-height calculation were wrong.
    const children = [...list.children] as HTMLElement[];
    const contentHeight = children.reduce((sum, child) => {
      const height = child.hasAttribute("data-vcard")
        ? child.offsetHeight
        : Number.parseFloat(child.style.height || "0");
      return sum + height;
    }, 0) + Math.max(0, children.length - 1) * 11;
    top = -Math.max(0, contentHeight - window.innerHeight);
    act(() => {
      window.dispatchEvent(new Event("scroll"));
      frames.splice(0).forEach((frame) => frame(0));
    });

    expect(screen.getByText("Order 10000")).toBeTruthy();
    expect(screen.queryByText("Order 1")).toBeNull();
    expect(list.lastElementChild?.hasAttribute("data-vcard")).toBe(true);
    expect(container.querySelectorAll("[data-vcard]").length).toBeLessThanOrEqual(100);
  });
});
