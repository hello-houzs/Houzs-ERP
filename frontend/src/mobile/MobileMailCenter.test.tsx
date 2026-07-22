import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileMailCenter } from "./MobileMailCenter";

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));

vi.mock("../api/client", () => ({
  api: { get: apiGet },
}));

vi.mock("../hooks/useQuery", () => ({
  useQuery: () => ({ data: [], loading: false, error: null, reload: vi.fn() }),
}));

vi.mock("./MobileVirtualList", () => ({
  MobileVirtualList: ({ items, renderItem }: any) => (
    <div>{items.map((item: any, index: number) => renderItem(item, index))}</div>
  ),
}));

function thread(id: string, subject: string) {
  return {
    id,
    mailboxAddress: "sales@example.com",
    subject,
    counterpartyEmail: "customer@example.com",
    counterpartyName: "Customer",
    status: "open",
    lastMessageAt: "2026-07-20T08:00:00Z",
    lastDirection: "inbound",
    lastSnippet: `${subject} snippet`,
    messageCount: 1,
    unread: false,
    starred: false,
    labels: [],
    hasOutbound: false,
    createdAt: "2026-07-20T08:00:00Z",
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("MobileMailCenter paginated search", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    apiGet.mockReset();
    apiGet.mockImplementation(async (url: string) => {
      const parsed = new URL(url, "https://houzs.test");
      const query = parsed.searchParams.get("q");
      const page = Number(parsed.searchParams.get("page"));
      if (query === "A1" && page === 2) {
        return { threads: [thread("51", "A1 result 51")], total: 51, page: 2, pageSize: 50, hasMore: false };
      }
      if (query === "A1") {
        return { threads: [thread("1", "A1 result 1")], total: 51, page: 1, pageSize: 50, hasMore: true };
      }
      return { threads: [thread("old", "Old inbox row")], total: 1, page: 1, pageSize: 50, hasMore: false };
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("searches on the server, hides stale rows immediately, and loads later pages", async () => {
    render(<MobileMailCenter />);
    await flush();

    expect(apiGet.mock.calls[0][0]).toContain("status=open");
    expect(apiGet.mock.calls[0][0]).toContain("page=1");
    expect(apiGet.mock.calls[0][0]).toContain("pageSize=50");
    expect(screen.getByText("Old inbox row")).toBeTruthy();

    const input = screen.getByRole("textbox", { name: "Search all mail" });
    fireEvent.change(input, { target: { value: "A1" } });
    expect(screen.queryByText("Old inbox row")).toBeNull();
    expect(screen.getAllByRole("status").some((status) => status.textContent?.includes("Searching"))).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    });
    await flush();

    const searchCall = apiGet.mock.calls.find(([url]) => String(url).includes("q=A1"));
    expect(searchCall?.[0]).toContain("page=1");
    expect(screen.getByText("A1 result 1")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Load more mail/ }));
    await flush();
    expect(apiGet.mock.calls.some(([url]) => String(url).includes("q=A1") && String(url).includes("page=2"))).toBe(true);
    expect(screen.getByText("A1 result 51")).toBeTruthy();
  });
});
