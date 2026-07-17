import { describe, it, expect } from "vitest";
import { createMirrorMapper, prefixDoc, toPgArray, C2990 } from "./mirror-map";

/* These primitives carry two documented production 500s between them — the
   text[] coercion (PR #471: an empty JS array reached Postgres as "" and every
   delivery 500'd with "malformed array literal") and id remapping (the previous
   mirror rewrote uuids, matched no imported row, and FK-violated). They had no
   test until they were extracted out of so-mirror.ts for the amendment mirror.
   Pure functions, so the workers pool is incidental here. */

// information_schema stand-in — the mapper only reads {col, dtype} rows.
const fakeDB = (cols: Array<{ col: string; dtype: string }>) =>
  ({
    prepare: () => ({ bind: () => ({ all: async () => ({ results: cols }) }) }),
  }) as never;

describe("toPgArray", () => {
  it("renders an empty array as {} and not the empty string (PR #471)", () => {
    expect(toPgArray([])).toBe("{}");
  });

  it("quotes elements", () => {
    expect(toPgArray(["a", "b"])).toBe('{"a","b"}');
  });

  it("escapes embedded quotes and backslashes", () => {
    expect(toPgArray(['a"b\\c'])).toBe('{"a\\"b\\\\c"}');
  });

  it("renders a null element as an unquoted NULL", () => {
    expect(toPgArray([null])).toBe("{NULL}");
  });
});

describe("prefixDoc", () => {
  it("stamps the 2990 prefix", () => {
    expect(prefixDoc("SO-2607-006")).toBe("2990-SO-2607-006");
  });

  it("is idempotent so a re-delivered outbox row cannot double-prefix", () => {
    expect(prefixDoc("2990-SO-2607-006")).toBe("2990-SO-2607-006");
  });

  it("passes null through", () => {
    expect(prefixDoc(null)).toBeNull();
  });
});

describe("createMirrorMapper / applyMap", () => {
  const CANON = new Set([
    "REQUESTED", "SUPPLIER_PENDING", "SO_APPROVED", "PO_APPROVED", "SENT", "REJECTED",
  ]);
  const mapper = createMirrorMapper({
    so_amendments: {
      prefixCols: ["so_doc_no", "amendment_no"],
      nullCols: ["header_changes", "old_header_snapshot"],
      normalize: {
        status: (v: unknown) => {
          const s = v == null ? "" : String(v).trim().toUpperCase();
          if (!CANON.has(s)) throw new Error(`unknown_amendment_status:${String(v)}`);
          return s;
        },
      },
    },
  });

  const DB = fakeDB([
    { col: "id", dtype: "uuid" },
    { col: "so_doc_no", dtype: "text" },
    { col: "amendment_no", dtype: "text" },
    { col: "status", dtype: "USER-DEFINED" },
    { col: "requested_by", dtype: "uuid" },
    { col: "header_changes", dtype: "jsonb" },
    { col: "old_header_snapshot", dtype: "jsonb" },
    { col: "company_id", dtype: "bigint" },
    { col: "tags", dtype: "ARRAY" },
  ]);

  const row = {
    id: "b1f2c3d4-0000-4000-8000-000000000001",
    so_doc_no: "SO-2607-006",
    amendment_no: "SO-2607-006/A1",
    status: "REQUESTED",
    requested_by: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    tags: [],
    hr_only_2990_column: "dropped: exists in 2990, not in scm",
  };

  it("copies uuids verbatim and never remaps them", async () => {
    const out = mapper.applyMap(row, await mapper.tableMap(DB, "so_amendments"));
    expect(out.id).toBe("b1f2c3d4-0000-4000-8000-000000000001");
    expect(out.requested_by).toBe("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  });

  it("prefixes so_doc_no so the FK reaches the mirrored SO, and amendment_no with it", async () => {
    const out = mapper.applyMap(row, await mapper.tableMap(DB, "so_amendments"));
    expect(out.so_doc_no).toBe("2990-SO-2607-006");
    expect(out.amendment_no).toBe("2990-SO-2607-006/A1");
  });

  it("stamps company_id and drops columns absent from the dest table", async () => {
    const out = mapper.applyMap(row, await mapper.tableMap(DB, "so_amendments"));
    expect(out.company_id).toBe(C2990);
    expect("hr_only_2990_column" in out).toBe(false);
  });

  /* The real traffic shape: 2990 has no header_changes column, so it is never in
     the payload. It must STILL be written NULL, or it is absent from the upsert's
     SET list and a stale value would survive a re-delivery. */
  it("forces a nullCol the source never sends, so the UPDATE clears it too", async () => {
    const out = mapper.applyMap(row, await mapper.tableMap(DB, "so_amendments"));
    expect("header_changes" in out).toBe(true);
    expect(out.header_changes).toBeNull();
    expect(out.old_header_snapshot).toBeNull();
  });

  it("coerces an empty array-typed column to a Postgres array literal", async () => {
    const out = mapper.applyMap(row, await mapper.tableMap(DB, "so_amendments"));
    expect(out.tags).toBe("{}");
  });

  it("forces header_changes NULL even if a value arrives — a 2990 amendment is line-changes-only", async () => {
    const m = await mapper.tableMap(DB, "so_amendments");
    const out = mapper.applyMap(
      { ...row, header_changes: { customerDeliveryDate: "2026-08-01" } },
      m,
    );
    expect(out.header_changes).toBeNull();
  });

  /* Guards the venue_id contract the SO mirror depends on: a nullCol absent from
     the DEST table must not be invented as a column, or the INSERT names a column
     that does not exist and every delivery 500s. */
  it("does not invent a nullCol that the dest table does not have", async () => {
    const m2 = createMirrorMapper({ t: { nullCols: ["not_in_dest"] } });
    const out = m2.applyMap({ id: "x" }, await m2.tableMap(fakeDB([{ col: "id", dtype: "uuid" }]), "t"));
    expect("not_in_dest" in out).toBe(false);
  });

  it("refuses an unknown status rather than guessing a state", async () => {
    const m = await mapper.tableMap(DB, "so_amendments");
    expect(() => mapper.applyMap({ ...row, status: "PARTIALLY_APPROVED" }, m)).toThrow(
      /unknown_amendment_status/,
    );
  });

  it("normalizes status case and whitespace", async () => {
    const m = await mapper.tableMap(DB, "so_amendments");
    expect(mapper.applyMap({ ...row, status: " sent " }, m).status).toBe("SENT");
  });
});
