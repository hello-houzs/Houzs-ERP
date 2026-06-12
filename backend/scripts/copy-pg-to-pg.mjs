// Full-fidelity copy of every public table from one Postgres to another.
// Used to move production data from the interim Supabase project to the
// company-owned one. Target schema must already exist (run
// load-d1-dump-to-pg.mjs against the target first, then this).
//
// Usage:
//   node scripts/copy-pg-to-pg.mjs "<SOURCE_URL>" "<TARGET_URL>"
// URLs are session-pooler (5432) connection strings.
import postgres from "postgres";

const [src, dst] = process.argv.slice(2);
if (!src || !dst) {
  console.error('usage: node scripts/copy-pg-to-pg.mjs "<src url>" "<dst url>"');
  process.exit(2);
}
const S = postgres(src, { ssl: "require", prepare: false, max: 1 });
const D = postgres(dst, { ssl: "require", prepare: false, max: 1 });

const tables = (
  await S.unsafe(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`,
  )
).map((r) => r.table_name);
console.log(`source tables: ${tables.length}`);

// Loader-created schemas carry no FK constraints, but try replica mode
// anyway so this also works if constraints were added later.
await D.unsafe(`SET session_replication_role = replica`).catch(() => {});

let totalRows = 0;
const failed = [];
for (const t of tables) {
  try {
    const cols = (
      await S.unsafe(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema='public' AND table_name='${t}' ORDER BY ordinal_position`,
      )
    ).map((r) => r.column_name);
    const colList = cols.map((c) => `"${c}"`).join(",");

    await D.unsafe(`TRUNCATE TABLE "${t}"`);
    const rows = await S.unsafe(`SELECT ${colList} FROM "${t}"`);
    // Chunked multi-row inserts via postgres.js helper.
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      if (chunk.length) await D`INSERT INTO ${D(t)} ${D(chunk, ...cols)}`;
    }
    totalRows += rows.length;
    if (rows.length) console.log(`  ${t}: ${rows.length}`);

    // Keep identity sequences ahead of the data.
    if (cols.includes("id")) {
      await D.unsafe(
        `SELECT setval(pg_get_serial_sequence('"${t}"','id'),
                       coalesce((SELECT max(id) FROM "${t}"), 1))`,
      ).catch(() => {});
    }
  } catch (e) {
    failed.push({ t, err: e.message.slice(0, 140) });
  }
}

console.log(`\ncopied ${totalRows} rows across ${tables.length} tables`);
if (failed.length) {
  console.log("FAILED tables:");
  for (const f of failed) console.log(`  ${f.t}: ${f.err}`);
}

// Row-count verification, source vs target.
let mismatches = 0;
for (const t of tables) {
  const [[a], [b]] = await Promise.all([
    S.unsafe(`SELECT count(*)::int AS n FROM "${t}"`),
    D.unsafe(`SELECT count(*)::int AS n FROM "${t}"`).catch(() => [{ n: -1 }]),
  ]);
  if (a.n !== b.n) {
    console.log(`MISMATCH ${t}: src=${a.n} dst=${b.n}`);
    mismatches++;
  }
}
console.log(mismatches ? `${mismatches} mismatched tables` : "row counts verified: all match");
await S.end();
await D.end();
process.exit(failed.length || mismatches ? 1 : 0);
