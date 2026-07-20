import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  mergeAndWriteAnnouncementAcks,
  readAnnouncementAcks,
  sanitizeAnnouncementAcks,
} from "./announcementLocalAcks";

describe("announcement local acknowledgements", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
  });

  test("removes invalid timestamps and keeps only the newest 200", () => {
    const input = Object.fromEntries(Array.from({ length: 205 }, (_, i) => [`a${i}`, i + 1]));
    const result = sanitizeAnnouncementAcks({ ...input, bad: Infinity, future: 2_000_000 }, 1_000_000);
    expect(Object.keys(result)).toHaveLength(200);
    expect(result.a204).toBe(205);
    expect(result.a0).toBeUndefined();
    expect(result.bad).toBeUndefined();
    expect(result.future).toBeUndefined();
  });

  test("re-reads and merges another tab's acknowledgement before writing", () => {
    localStorage.setItem("acks", JSON.stringify({ first: 100 }));
    const merged = mergeAndWriteAnnouncementAcks("acks", { second: 200 });
    expect(merged).toEqual({ second: 200, first: 100 });
    expect(readAnnouncementAcks("acks")).toEqual(merged);
  });
});
