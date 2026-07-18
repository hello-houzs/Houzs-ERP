import { describe, expect, test } from "vitest";
import { sanitizeDrafts } from "./mail-local";

/* WHY THIS TEST EXISTS.
   Compose drafts live in localStorage, which means the app reads back JSON that
   an older build wrote, that a user may have hand-edited, and that no server
   ever validated. `load()` used to check only that `drafts` was an array and
   then trust every element. One element missing `updatedAt` crashed the entire
   Mail Center: the Drafts list rendered it through
   `new Date(d.updatedAt).toISOString()`, and `toISOString()` on an invalid date
   THROWS rather than returning something falsy, so React unmounted the tree.

   HOOKKA hit both halves of this separately — a shared localStorage key written
   in two incompatible shapes (BUG-2026-04-22-001) and toISOString on an
   undefined field (BUG-2026-05-12-008). The lesson worth keeping is that the
   container check and the element check are different checks. */

const VALID = {
  id: "d1",
  to: "a@b.com",
  subject: "Quote",
  body: "text",
  fromAddress: "me@houzs.com",
  updatedAt: 1_700_000_000_000,
};

describe("sanitizeDrafts", () => {
  test("a well-formed draft survives untouched", () => {
    expect(sanitizeDrafts([VALID])).toEqual([VALID]);
  });

  test("a non-array (null, object, string, absent) yields no drafts, never throws", () => {
    for (const bad of [null, undefined, {}, "", "[]", 7]) {
      expect(sanitizeDrafts(bad)).toEqual([]);
    }
  });

  test("a draft missing updatedAt is kept but its timestamp is neutralised", () => {
    // THE CRASH CASE. Pre-fix this element reached the renderer verbatim and
    // `new Date(undefined).toISOString()` threw RangeError. 0 is falsy, so the
    // formatter's own `if (!iso) return ""` short-circuits and renders blank.
    const { updatedAt: _omitted, ...noStamp } = VALID;
    const out = sanitizeDrafts([noStamp]);
    expect(out).toHaveLength(1);
    expect(out[0].updatedAt).toBe(0);
    // The guarantee that matters: whatever comes out is safe to date-format.
    expect(() => new Date(out[0].updatedAt).toISOString()).not.toThrow();
  });

  test("a non-numeric or non-finite updatedAt is neutralised the same way", () => {
    for (const bad of ["2026-07-19", NaN, Infinity, null, {}]) {
      const out = sanitizeDrafts([{ ...VALID, updatedAt: bad }]);
      expect(out[0].updatedAt).toBe(0);
      expect(() => new Date(out[0].updatedAt).toISOString()).not.toThrow();
    }
  });

  test("missing text fields degrade to empty strings rather than dropping the draft", () => {
    // A draft written by an older build that lacked a field is still resumable;
    // losing the user's body text would be a worse outcome than a blank subject.
    const out = sanitizeDrafts([{ id: "d1", updatedAt: 1 }]);
    expect(out).toEqual([{ id: "d1", to: "", subject: "", body: "", fromAddress: "", updatedAt: 1 }]);
  });

  test("an entry with no usable id IS dropped — it could never be resumed or deleted", () => {
    // id keys saveDraft/deleteDraft. Keeping an id-less row would render a
    // draft whose Discard button silently does nothing.
    expect(sanitizeDrafts([{ ...VALID, id: undefined }])).toEqual([]);
    expect(sanitizeDrafts([{ ...VALID, id: "" }])).toEqual([]);
    expect(sanitizeDrafts([{ ...VALID, id: 42 }])).toEqual([]);
  });

  test("one malformed element does not take the readable ones down with it", () => {
    // The whole point: partial recovery beats an all-or-nothing crash.
    const out = sanitizeDrafts([VALID, null, "junk", { ...VALID, id: "d2" }]);
    expect(out.map((d) => d.id)).toEqual(["d1", "d2"]);
  });
});
