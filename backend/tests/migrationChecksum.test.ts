import { describe, expect, it } from "vitest";
// @ts-expect-error - plain .mjs helper shared with the deploy-time migration runner
import {
  canonicalizeMigrationSql,
  checksumMigrationSql,
  planMigrationChecksums,
} from "../scripts/lib/migration-checksum.mjs";
// @ts-expect-error - plain .mjs helper shared with the deploy-time migration runner
import { loadAppliedMigrationRows } from "../scripts/lib/migration-tracker.mjs";

describe("migration checksum canonicalisation", () => {
  it("has the same checksum on LF and CRLF checkouts", async () => {
    const lf = "CREATE TABLE example (id int);\n-- keep history\n";
    const crlf = lf.replace(/\n/g, "\r\n");

    expect(canonicalizeMigrationSql(crlf)).toBe(lf);
    expect(await checksumMigrationSql(crlf)).toBe(
      await checksumMigrationSql(lf),
    );
  });

  it("ignores a UTF-8 BOM but detects actual content changes", async () => {
    const original = "CREATE TABLE example (id int);\n";
    expect(await checksumMigrationSql(`\uFEFF${original}`)).toBe(
      await checksumMigrationSql(original),
    );
    expect(await checksumMigrationSql(`${original}-- edited\n`)).not.toBe(
      await checksumMigrationSql(original),
    );
  });
});

describe("migration checksum plan", () => {
  const file = (filename: string, checksum: string) => ({ filename, checksum });

  it("backfills old tracker rows once and leaves new files pending", () => {
    const result = planMigrationChecksums(
      [file("0001.sql", "sha256:a"), file("0002.sql", "sha256:b")],
      [{ filename: "0001.sql", checksum: null }],
    );

    expect(
      result.backfill.map((entry: { filename: string }) => entry.filename),
    ).toEqual(["0001.sql"]);
    expect(
      result.pending.map((entry: { filename: string }) => entry.filename),
    ).toEqual(["0002.sql"]);
    expect(result.drift).toEqual([]);
  });

  it("fails closed when an applied file changes", () => {
    const result = planMigrationChecksums(
      [file("0001.sql", "sha256:new")],
      [{ filename: "0001.sql", checksum: "sha256:old" }],
    );

    expect(result.drift).toEqual([
      expect.objectContaining({
        filename: "0001.sql",
        reason: "content_changed",
        storedChecksum: "sha256:old",
        currentChecksum: "sha256:new",
      }),
    ]);
  });

  it("fails closed when a checksum-tracked file is deleted", () => {
    const result = planMigrationChecksums([], [
      { filename: "0001.sql", checksum: "sha256:old" },
    ]);

    expect(result.drift).toEqual([
      expect.objectContaining({ filename: "0001.sql", reason: "file_deleted" }),
    ]);
  });

  it("fails closed for unverifiable pre-checksum deletions", () => {
    const result = planMigrationChecksums([], [
      { filename: "0001.sql", checksum: null },
    ]);

    expect(result.drift).toEqual([
      expect.objectContaining({
        filename: "0001.sql",
        reason: "legacy_file_deleted_unverifiable",
        storedChecksum: null,
        currentChecksum: null,
      }),
    ]);
  });

  it("fails closed when a retired historical filename is reused", () => {
    const retired = {
      filename: "0017_removed.sql",
      archivedChecksum: "sha256:archived",
      gitBlob: "0123456789012345678901234567890123456789",
    };
    const result = planMigrationChecksums(
      [file("0017_removed.sql", "sha256:new")],
      [],
      { retiredMigrations: [retired] },
    );

    expect(result.pending).toEqual([]);
    expect(result.drift).toEqual([
      expect.objectContaining({
        filename: "0017_removed.sql",
        reason: "retired_filename_reused",
      }),
    ]);
  });

  it("accepts only a known retirement with a legacy NULL or archived checksum", () => {
    const retired = {
      filename: "0017_removed.sql",
      archivedChecksum: "sha256:archived",
      gitBlob: "0123456789012345678901234567890123456789",
    };
    const legacy = planMigrationChecksums(
      [],
      [{ filename: retired.filename, checksum: null }],
      { retiredMigrations: [retired] },
    );
    expect(legacy.drift).toEqual([]);
    expect(legacy.retired).toEqual([expect.objectContaining({ filename: retired.filename })]);

    const archived = planMigrationChecksums(
      [],
      [{ filename: retired.filename, checksum: retired.archivedChecksum }],
      { retiredMigrations: [retired] },
    );
    expect(archived.drift).toEqual([]);
    expect(archived.retired).toHaveLength(1);

    const mismatch = planMigrationChecksums(
      [],
      [{ filename: retired.filename, checksum: "sha256:different" }],
      { retiredMigrations: [retired] },
    );
    expect(mismatch.retired).toEqual([]);
    expect(mismatch.drift).toEqual([
      expect.objectContaining({
        filename: retired.filename,
        reason: "retired_checksum_mismatch",
      }),
    ]);
  });
});

describe("read-only migration tracker inspection", () => {
  function fakePg(tracker: { tracker_exists: boolean; checksum_exists: boolean }) {
    const calls: string[] = [];
    const rows = [{ filename: "0001.sql", checksum: tracker.checksum_exists ? "sha256:a" : null }];
    const pg = async (parts: TemplateStringsArray) => {
      const sql = parts.join("?").replace(/\s+/g, " ").trim();
      calls.push(sql);
      if (sql.includes("to_regclass")) return [tracker];
      return rows;
    };
    return { pg, calls, rows };
  }

  it.each([
    { tracker_exists: false, checksum_exists: false },
    { tracker_exists: true, checksum_exists: false },
    { tracker_exists: true, checksum_exists: true },
  ])("never executes DDL/DML in read-only mode: %o", async (tracker) => {
    const { pg, calls } = fakePg(tracker);
    await loadAppliedMigrationRows(pg, { readOnly: true });

    expect(calls.length).toBe(tracker.tracker_exists ? 2 : 1);
    expect(calls.every((sql) => /^SELECT\b/i.test(sql))).toBe(true);
    expect(calls.join("\n")).not.toMatch(/\b(CREATE|ALTER|INSERT|UPDATE|DELETE|DROP)\b/i);
    if (tracker.tracker_exists && !tracker.checksum_exists) {
      expect(calls[1]).toContain("NULL::text AS checksum");
    }
  });
});
