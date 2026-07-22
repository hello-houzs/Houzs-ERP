import { describe, expect, test } from "vitest";
import { formatReportedStack } from "./errorReporter";

describe("error reporter request correlation", () => {
  test("keeps a valid request id suffix while strictly capping the stack", () => {
    const requestId = "a".repeat(64);
    const error = Object.assign(new Error("boom"), {
      requestId,
      stack: "s".repeat(5_000),
    });

    const reported = formatReportedStack(error);

    expect(reported).toHaveLength(4_000);
    expect(reported).toMatch(new RegExp(`\\nRequest-Id: ${requestId}$`));
  });

  test("ignores an oversized request id and still strictly caps the stack", () => {
    const error = Object.assign(new Error("boom"), {
      requestId: "x".repeat(10_000),
      stack: "s".repeat(5_000),
    });

    const reported = formatReportedStack(error);

    expect(reported).toHaveLength(4_000);
    expect(reported).not.toContain("Request-Id:");
  });
});
