import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { bindBrowserStorageIdentity, clearBrowserStorageIdentity } from "../lib/storageIdentity";
import { useStickyFilters } from "./useStickyFilters";

function Probe() {
  const [params] = useStickyFilters("sales", ["q", "status"]);
  return <output data-testid="params">{params.toString()}</output>;
}

afterEach(() => {
  cleanup();
  clearBrowserStorageIdentity();
  localStorage.clear();
});

describe("useStickyFilters identity scope", () => {
  it("restores only the current user's stored filter snapshot", async () => {
    localStorage.setItem("filters:sales", "q=legacy-leak");
    bindBrowserStorageIdentity(7);
    localStorage.setItem("filters:sales:u7:c0", "q=mine&status=draft");

    render(<MemoryRouter initialEntries={["/"]}><Probe /></MemoryRouter>);

    await waitFor(() => {
      expect(screen.getByTestId("params").textContent).toBe("q=mine&status=draft");
    });
    expect(screen.getByTestId("params").textContent).not.toContain("legacy-leak");
  });

  it("does not expose the previous user's filter after identity changes", async () => {
    localStorage.setItem("filters:sales:u7:c0", "q=private-customer");
    bindBrowserStorageIdentity(8);

    render(<MemoryRouter initialEntries={["/"]}><Probe /></MemoryRouter>);

    await waitFor(() => expect(screen.getByTestId("params").textContent).toBe(""));
    expect(screen.getByTestId("params").textContent).not.toContain("private-customer");
  });

  it("keeps a bookmarked URL authoritative over stored state", async () => {
    bindBrowserStorageIdentity(7);
    localStorage.setItem("filters:sales:u7:c0", "q=stored");

    render(<MemoryRouter initialEntries={["/?q=bookmark"]}><Probe /></MemoryRouter>);

    await waitFor(() => expect(screen.getByTestId("params").textContent).toBe("q=bookmark"));
  });
});
