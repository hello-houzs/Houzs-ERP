/**
 * Return the canonical bytes used by the migration drift gate.
 *
 * Git may check the same SQL file out as CRLF on Windows and LF in CI. Those
 * byte-level differences do not change the migration, so normalise line
 * endings before hashing. Everything else (including comments/whitespace) is
 * deliberately significant: applied migration files are immutable history.
 */
export function canonicalizeMigrationSql(sql) {
  return sql.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

export async function checksumMigrationSql(sql) {
  const bytes = new TextEncoder().encode(canonicalizeMigrationSql(sql));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
}

/**
 * Classify the local migration tree against tracker rows already in Postgres.
 *
 * `checksum = null` is the one-time compatibility state created by the old
 * runner. Existing files in that state are trusted once and backfilled. A
 * legacy tracker row whose file was removed before checksums existed cannot be
 * proven, so it is fail-closed drift too. Once a row has a checksum, both
 * content changes and file deletion are likewise fail-closed drift.
 */
export function planMigrationChecksums(localFiles, appliedRows) {
  const localByName = new Map(localFiles.map((file) => [file.filename, file]));
  const appliedByName = new Map(appliedRows.map((row) => [row.filename, row]));

  const pending = [];
  const backfill = [];
  const drift = [];

  for (const file of localFiles) {
    const applied = appliedByName.get(file.filename);
    if (!applied) {
      pending.push(file);
      continue;
    }

    if (!applied.checksum) {
      backfill.push(file);
      continue;
    }

    if (applied.checksum !== file.checksum) {
      drift.push({
        filename: file.filename,
        storedChecksum: applied.checksum,
        currentChecksum: file.checksum,
        reason: "content_changed",
      });
    }
  }

  for (const applied of appliedRows) {
    if (localByName.has(applied.filename)) continue;
    if (applied.checksum) {
      drift.push({
        filename: applied.filename,
        storedChecksum: applied.checksum,
        currentChecksum: null,
        reason: "file_deleted",
      });
    } else {
      drift.push({
        filename: applied.filename,
        storedChecksum: null,
        currentChecksum: null,
        reason: "legacy_file_deleted_unverifiable",
      });
    }
  }

  return { pending, backfill, drift };
}
