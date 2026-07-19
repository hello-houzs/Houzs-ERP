import { describe, expect, test } from "vitest";
import { humanHttpMessage } from "./client";

// The operator must never be shown a machine code. The backend sends errors as
// { error: "<code>", message: "<sentence>" } (middleware/idempotency.ts), and
// this mapper used to return `error` verbatim — so a key collision surfaced as
// the literal string "idempotency_in_flight".
describe("humanHttpMessage", () => {
  test("a curated error CODE maps to plain language, never the raw code", () => {
    const body = JSON.stringify({
      error: "idempotency_in_flight",
      message: "This request is already being processed.",
    });
    const msg = humanHttpMessage(409, body);
    expect(msg).not.toContain("idempotency_in_flight");
    expect(msg).not.toContain("_");
    // It must read as "in progress", NOT as a failure — telling the operator it
    // failed at the moment it is going through invites the double-submit the
    // idempotency key exists to prevent.
    expect(msg).toMatch(/already going through/i);
  });

  test("an UNcurated error code falls back to the body's human message", () => {
    const body = JSON.stringify({
      error: "some_unmapped_code",
      message: "The warehouse is on hold.",
    });
    expect(humanHttpMessage(409, body)).toBe("The warehouse is on hold.");
  });

  test("an uncurated code with no message falls through to the status map", () => {
    const msg = humanHttpMessage(409, JSON.stringify({ error: "some_unmapped_code" }));
    expect(msg).not.toContain("some_unmapped_code");
    expect(msg).toBe("That conflicts with existing data. Please refresh and try again.");
  });

  test("a sentence-shaped `error` is still surfaced as-is (historic behaviour)", () => {
    const body = JSON.stringify({ error: "That code is already in use." });
    expect(humanHttpMessage(400, body)).toBe("That code is already in use.");
  });

  test("a non-JSON body falls through to the status map", () => {
    expect(humanHttpMessage(500, "<html>502 Bad Gateway</html>")).toBe(
      "Something went wrong on our end. Please try again.",
    );
  });

  test("the 503 wording keeps the phrases isColdPool503 matches on", () => {
    // Cold-pool retry keys off this sentence; changing it silently disables the
    // mutation retry that rides out a Hyperdrive cold start.
    expect(humanHttpMessage(503, "")).toMatch(/briefly unavailable|try again in a moment/i);
  });
});
