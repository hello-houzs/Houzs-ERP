import { SELF } from "cloudflare:test";
import { describe, expect, test } from "vitest";

describe("request log / X-Request-Id", () => {
  test("responses carry a generated X-Request-Id", async () => {
    const res = await SELF.fetch("https://test.local/api/auth/status");
    const id = res.headers.get("X-Request-Id");
    expect(id).toBeTruthy();
    expect(id!.length).toBeGreaterThanOrEqual(8);
  });

  test("a client-provided X-Request-Id is echoed back", async () => {
    const res = await SELF.fetch("https://test.local/api/auth/status", {
      headers: { "X-Request-Id": "abcd1234" },
    });
    expect(res.headers.get("X-Request-Id")).toBe("abcd1234");
  });
});
