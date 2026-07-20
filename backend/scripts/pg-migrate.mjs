// Postgres migration runner + tracker. Ported (trimmed) from Hookka's
// incremental runner. Applies every src/db/migrations-pg/*.sql once, in name
// order, recording each filename + checksum in a _pg_migrations tracker table;
// already-applied files are verified, then skipped. Each file runs inside a
// transaction (rollback on error).
//
// Build order for a fresh DB: load-d1-dump-to-pg.mjs (tables + data) THEN this
// (indexes + future schema changes). Migrations here must be idempotent
// (IF NOT EXISTS / ON CONFLICT) so applying to the live DB is always safe.
//
// Usage:
//   node scripts/pg-migrate.mjs            # apply pending
//   node scripts/pg-migrate.mjs --dry-run  # list pending, change nothing
//   node scripts/pg-migrate.mjs --verify-only # require an already-clean tracker
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { splitSqlStatements } from "./lib/split-sql.mjs";
import {
  checksumMigrationSql,
  planMigrationChecksums,
} from "./lib/migration-checksum.mjs";
import { loadAppliedMigrationRows } from "./lib/migration-tracker.mjs";
import { RETIRED_MIGRATIONS } from "./lib/migration-retirements.mjs";

const DRY = process.argv.includes("--dry-run");
const VERIFY_ONLY = process.argv.includes("--verify-only");
const READ_ONLY = DRY || VERIFY_ONLY;
const DIR = "src/db/migrations-pg";
// CI/deploy passes DATABASE_URL as an env var (GitHub secret); locally we read
// it from .dev.vars. Env wins so the deploy pipeline can apply migrations with
// no .dev.vars present.
function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}
const url = resolveUrl();
if (!url) {
  console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
  process.exit(1);
}
const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

/* A dry-run/verification is a production diagnostic, so it must be literally
   read-only. The helper introspects the catalog and projects NULL for a legacy
   tracker instead of "helpfully" creating or upgrading it. A normal apply owns
   the compatibility DDL and the one-time TOFU backfill below. */
const appliedRows = await loadAppliedMigrationRows(pg, { readOnly: READ_ONLY });

// Only top-level .sql files (skip the drizzle meta/ + the 0000 baseline, which
// the loader owns — tables are built by load-d1-dump-to-pg, not replayed here).
const filenames = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql") && f !== "0000_baseline.sql")
  .sort();
const files = await Promise.all(
  filenames.map(async (filename) => {
    const sql = readFileSync(path.join(DIR, filename), "utf8");
    return {
      filename,
      sql,
      checksum: await checksumMigrationSql(sql),
    };
  }),
);

const { pending, backfill, drift, retired } = planMigrationChecksums(
  files,
  appliedRows,
  { retiredMigrations: RETIRED_MIGRATIONS },
);

console.log(
  `${files.length} migration(s), ${appliedRows.length} applied, ` +
    `${pending.length} pending, ${backfill.length} checksum(s) to backfill, ` +
    `${retired.length} reviewed retirement(s)`,
);

if (drift.length > 0) {
  console.error("Migration drift detected. Applied migration history is immutable:");
  for (const item of drift) {
    if (item.reason === "retired_filename_reused") {
      console.error(
        `  DRIFT   ${item.filename}: this historical filename is retired and may never be reused`,
      );
    } else if (item.reason === "retired_checksum_mismatch") {
      console.error(
        `  DRIFT   ${item.filename}: retired row checksum ${item.storedChecksum} ` +
          `does not match archived ${item.currentChecksum}`,
      );
    } else if (item.reason === "legacy_file_deleted_unverifiable") {
      console.error(
        `  DRIFT   ${item.filename}: legacy tracker row has no checksum and ` +
          "the migration file is missing; applied history cannot be verified",
      );
    } else if (item.reason === "file_deleted") {
      console.error(
        `  DRIFT   ${item.filename}: file deleted (stored ${item.storedChecksum})`,
      );
    } else {
      console.error(
        `  DRIFT   ${item.filename}: stored ${item.storedChecksum}, ` +
          `current ${item.currentChecksum}`,
      );
    }
  }
  console.error("Add a new migration instead of editing or deleting an applied one.");
  await pg.end();
  process.exit(1);
}

if (DRY) {
  for (const item of retired) console.log(`  RETIRED ${item.filename}`);
  for (const file of backfill) console.log(`  BACKFILL ${file.filename}`);
  for (const file of pending) console.log(`  PENDING ${file.filename}`);
  await pg.end();
  process.exit(0);
}

if (VERIFY_ONLY) {
  for (const item of retired) console.log(`  RETIRED ${item.filename}`);
  for (const file of backfill) console.error(`  UNVERIFIED ${file.filename}: checksum backfill required`);
  for (const file of pending) console.error(`  PENDING ${file.filename}`);
  if (backfill.length > 0 || pending.length > 0) {
    console.error(
      "Schema verification failed: apply migrations normally before deploying this Worker.",
    );
    await pg.end();
    process.exit(1);
  }
  console.log("Schema verification passed; tracker and migration tree are clean.");
  await pg.end();
  process.exit(0);
}

if (backfill.length > 0) {
  try {
    await pg.begin(async (tx) => {
      for (const file of backfill) {
        // The second predicate makes concurrent first-rollout runners safe. A
        // peer may have backfilled the same checksum since our initial SELECT;
        // that is fine. A different checksum means two deploys disagree about
        // immutable history, so this runner must stop before applying anything.
        const updated = await tx`
          UPDATE _pg_migrations
          SET checksum = ${file.checksum}
          WHERE filename = ${file.filename}
            AND (checksum IS NULL OR checksum = ${file.checksum})
          RETURNING checksum
        `;
        if (updated.length !== 1) {
          throw new Error(
            `Migration drift detected while backfilling ${file.filename}; ` +
              "another runner stored a different checksum",
          );
        }
      }
    });
  } catch (e) {
    console.error(
      `  FAILED  checksum backfill: ${String(e.message || e).slice(0, 240)}`,
    );
    await pg.end();
    process.exit(1);
  }
  for (const file of backfill) {
    console.log(`  BACKFILLED ${file.filename} (${file.checksum})`);
  }
}

for (const file of pending) {
  // Multi-statement files run statement-by-statement inside one transaction
  // (postgres.js .unsafe runs a single statement at a time). The splitter is
  // dollar-quote aware, so a PL/pgSQL body survives intact — see
  // scripts/lib/split-sql.mjs.
  const stmts = splitSqlStatements(file.sql);
  try {
    await pg.begin(async (tx) => {
      for (const s of stmts) await tx.unsafe(s);
      await tx`
        INSERT INTO _pg_migrations (filename, checksum)
        VALUES (${file.filename}, ${file.checksum})
      `;
    });
    console.log(
      `  APPLIED ${file.filename} (${stmts.length} statements, ${file.checksum})`,
    );
  } catch (e) {
    console.error(
      `  FAILED  ${file.filename}: ${String(e.message || e).slice(0, 160)}`,
    );
    await pg.end();
    process.exit(1);
  }
}
console.log("done");
await pg.end();
