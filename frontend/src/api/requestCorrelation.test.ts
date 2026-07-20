import { afterEach, describe, expect, test, vi } from "vitest";
import { api, requestIdFromError } from "./client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("API request correlation", () => {
  test("stamps a bounded request id and keeps the server id on HTTP errors", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const sent = new Headers(init?.headers).get("X-Request-Id");
      expect(sent).toMatch(/^[a-f0-9]{32}$/);
      return new Response(JSON.stringify({ error: "No such record" }), {
        status: 404,
        headers: {
          "Content-Type": "application/json",
          "X-Request-Id": "servertrace1234",
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    let caught: unknown;
    try {
      await api.post("/api/request-correlation-test", { probe: true });
    } catch (error) {
      caught = error;
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestIdFromError(caught)).toBe("servertrace1234");
  });

  test("stamps binary requests and correlates their HTTP failures", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("X-Request-Id"))
        .toMatch(/^[a-f0-9]{32}$/);
      return new Response("upload rejected", {
        status: 400,
        headers: { "X-Request-Id": "binarytrace1234" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    let caught: unknown;
    try {
      await api.putBinary("/api/request-correlation-upload", new Blob(["x"]), "text/plain");
    } catch (error) {
      caught = error;
    }

    expect(requestIdFromError(caught)).toBe("binarytrace1234");
  });

  test("keeps the actual binary client id when the response does not echo one", async () => {
    let sent: string | null = null;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      sent = new Headers(init?.headers).get("X-Request-Id");
      return new Response("gateway rejected upload", { status: 502 });
    }));

    let caught: unknown;
    try {
      await api.putBinary("/api/request-correlation-upload", new Blob(["x"]), "text/plain");
    } catch (error) {
      caught = error;
    }

    expect(sent).toMatch(/^[a-f0-9]{32}$/);
    expect(requestIdFromError(caught)).toBe(sent);
  });

  test("rejects an oversized response id and falls back to the actual client id", async () => {
    let sent: string | null = null;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      sent = new Headers(init?.headers).get("X-Request-Id");
      return new Response("bad gateway", {
        status: 502,
        headers: { "X-Request-Id": "x".repeat(1_000) },
      });
    }));

    let caught: unknown;
    try {
      await api.post("/api/request-correlation-test", { probe: true });
    } catch (error) {
      caught = error;
    }

    expect(sent).toMatch(/^[a-f0-9]{32}$/);
    expect(requestIdFromError(caught)).toBe(sent);
  });

  test("rejects malformed and oversized request ids already attached to errors", () => {
    expect(requestIdFromError(Object.assign(new Error("bad"), { requestId: "bad id" })))
      .toBeUndefined();
    expect(requestIdFromError(Object.assign(new Error("bad"), { requestId: "x".repeat(65) })))
      .toBeUndefined();
  });
});
