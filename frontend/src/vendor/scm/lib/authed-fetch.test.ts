import { beforeEach, describe, expect, test, vi } from "vitest";
import { AUTH_TOKEN_KEY } from "../../../lib/authToken";
import { combineAbortSignals } from "../../../lib/abort";
import { authedFetch } from "./authed-fetch";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem(AUTH_TOKEN_KEY, "test-token");
  vi.restoreAllMocks();
});

describe("authedFetch cancellation", () => {
  test("caller and deadline cancellation both reach the combined signal", () => {
    const caller = new AbortController();
    const deadline = new AbortController();
    const combined = combineAbortSignals(caller.signal, deadline.signal);
    expect(combined?.aborted).toBe(false);
    caller.abort("superseded");
    expect(combined?.aborted).toBe(true);

    const caller2 = new AbortController();
    const deadline2 = new AbortController();
    const combined2 = combineAbortSignals(caller2.signal, deadline2.signal);
    deadline2.abort("deadline");
    expect(combined2?.aborted).toBe(true);
  });

  test("a superseded GET aborts once and is not retried", async () => {
    const caller = new AbortController();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    });

    const pending = authedFetch("/mfg-sales-orders?q=A", { signal: caller.signal });
    caller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("cancellation during retry backoff prevents the second fetch", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("warming up", { status: 503 }),
    );
    const pending = authedFetch("/mfg-sales-orders?q=A", { signal: caller.signal });
    await Promise.resolve();
    caller.abort(new DOMException("Aborted", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  test("a real request combines the caller signal with its deadline", async () => {
    const originalTimeout = Object.getOwnPropertyDescriptor(AbortSignal, "timeout");
    const caller = new AbortController();
    const deadline = new AbortController();
    Object.defineProperty(AbortSignal, "timeout", {
      configurable: true,
      value: vi.fn(() => deadline.signal),
    });

    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        const rejectOnAbort = () => reject(requestSignal?.reason ?? new DOMException("Aborted", "AbortError"));
        if (requestSignal?.aborted) rejectOnAbort();
        else requestSignal?.addEventListener("abort", rejectOnAbort, { once: true });
      });
    });

    try {
      const pending = authedFetch("/mfg-sales-orders?q=A", { signal: caller.signal });
      await vi.waitFor(() => expect(requestSignal).toBeTruthy());
      deadline.abort(new DOMException("Timed out", "TimeoutError"));
      caller.abort(new DOMException("Aborted", "AbortError"));

      await expect(pending).rejects.toBeTruthy();
      expect(requestSignal?.aborted).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      if (originalTimeout) Object.defineProperty(AbortSignal, "timeout", originalTimeout);
      else delete (AbortSignal as { timeout?: typeof AbortSignal.timeout }).timeout;
    }
  });
});
