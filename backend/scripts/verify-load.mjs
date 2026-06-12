import { readFileSync } from "node:fs";
import postgres from "postgres";
const url = readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)[1];
const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });
const dump = readFileSync("houzs-d1-full.sql", "utf8");

const tables = (await pg`select tablename from pg_tables where schemaname='public' order by tablename`).map(
  (r) => r.tablename,
);
let totalPg = 0,
  totalDump = 0,
  mism = 0;
for (const t of tables) {
  const pgN = (await pg.unsafe(`select count(*)::int n from "${t}"`))[0].n;
  const dumpN = (dump.match(new RegExp('^INSERT INTO "' + t + '"', "gm")) || []).length;
  totalPg += pgN;
  totalDump += dumpN;
  if (pgN !== dumpN) {
    mism++;
    console.log(`  MISMATCH ${t}: pg=${pgN} dump=${dumpN}`);
  }
}
console.log(`\ntables: ${tables.length}`);
console.log(`PG rows:   ${totalPg}`);
console.log(`dump rows: ${totalDump}`);
console.log(`mismatched tables: ${mism}`);
// spot-check a few headline tables
for (const t of ["sales_orders", "sales_entries", "projects", "users", "assr_cases"]) {
  try {
    const n = (await pg.unsafe(`select count(*)::int n from "${t}"`))[0].n;
    console.log(`  ${t}: ${n} rows`);
  } catch {}
}
await pg.end();
