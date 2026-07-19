// Postgres migration runner + tracker. Ported (trimmed) from Hookka's
// incremental runner. Applies every src/db/migrations-pg/*.sql once, in name
// order, recording each in a _pg_migrations tracker table; already-applied
// files are skipped. Each file runs inside a transaction (rollback on error).
//
// Build order for a fresh DB: load-d1-dump-to-pg.mjs (tables + data) THEN this
// (indexes + future schema changes). Migrations here must be idempotent
// (IF NOT EXISTS / ON CONFLICT) so applying to the live DB is always safe.
//
// Usage:
//   node scripts/pg-migrate.mjs            # apply pending
//   node scripts/pg-migrate.mjs --dry-run  # list pending, change nothing
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { splitSqlStatements } from "./lib/split-sql.mjs";

const DRY = process.argv.includes("--dry-run");
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

await pg`CREATE TABLE IF NOT EXISTS _pg_migrations (
  filename text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

const applied = new Set(
  (await pg`SELECT filename FROM _pg_migrations`).map((r) => r.filename),
);

// Only top-level .sql files (skip the drizzle meta/ + the 0000 baseline, which
// the loader owns — tables are built by load-d1-dump-to-pg, not replayed here).
const files = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql") && f !== "0000_baseline.sql")
  .sort();

const pending = files.filter((f) => !applied.has(f));
console.log(`${files.length} migration(s), ${applied.size} applied, ${pending.length} pending`);
if (DRY) {
  for (const f of pending) console.log(`  PENDING ${f}`);
  await pg.end();
  process.exit(0);
}

for (const f of pending) {
  const sql = readFileSync(path.join(DIR, f), "utf8");
  // Multi-statement files run statement-by-statement inside one transaction
  // (postgres.js .unsafe runs a single statement at a time). The splitter is
  // dollar-quote aware, so a PL/pgSQL body survives intact — see
  // scripts/lib/split-sql.mjs.
  const stmts = splitSqlStatements(sql);
  try {
    await pg.begin(async (tx) => {
      for (const s of stmts) await tx.unsafe(s);
      await tx`INSERT INTO _pg_migrations (filename) VALUES (${f})`;
    });
    console.log(`  APPLIED ${f} (${stmts.length} statements)`);
  } catch (e) {
    console.error(`  FAILED  ${f}: ${String(e.message || e).slice(0, 160)}`);
    await pg.end();
    process.exit(1);
  }
}
console.log("done");
await pg.end();
