// Read-only. Dumps the CURRENT definition of the two public compatibility
// VIEWs that migration 0055 left behind: public.trips and public.lorries.
//
// 0055 DROPped the old public.trips / public.lorries TABLES in favour of
// scm.*. The compat VIEWs (public.trips / public.lorries over scm.*) were then
// created OUT-OF-BAND — they exist in prod but in NO migration file, so a fresh
// env rebuilt from the tree has neither, and getProjectDetail's `LEFT JOIN
// lorries` 500s on every project there.
//
// This probe captures the ground-truth body so migration 0128 can recreate them
// byte-faithfully (the DB is the source of truth — never hand-write the DDL,
// a drifted column would 500 and block ALL deploys). Same shape + workflow
// pattern as scripts/dump-views.mjs. No writes.
//
// Run via .github/workflows/dump-compat-views.yml (staging default, prod opt-in).
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL missing"); process.exit(2); }

const VIEWS = ["public.trips", "public.lorries"];

const pg = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 25 });

try {
  for (const v of VIEWS) {
    console.log(`\n========== ${v} ==========`);
    // relkind tells us whether prod really has a VIEW ('v') here, not a table.
    try {
      const meta = await pg`
        SELECT c.relkind, n.nspname, c.relname
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = split_part(${v}, '.', 1)
           AND c.relname = split_part(${v}, '.', 2)`;
      if (!meta.length) { console.log(`!!! ${v} DOES NOT EXIST`); continue; }
      console.log(`relkind=${meta[0].relkind} (v=view, r=table, m=matview)`);
    } catch (e) {
      console.log(`!!! ${v} meta failed: ${e.message}`);
    }
    // The canonical, pretty-printed body — paste this into migration 0128.
    try {
      const rows = await pg`SELECT pg_get_viewdef(${v}::regclass, true) AS def`;
      console.log(`----- BEGIN ${v} -----`);
      console.log(rows[0].def);
      console.log(`----- END ${v} -----`);
    } catch (e) {
      console.log(`!!! ${v} viewdef failed: ${e.message}`);
    }
    // Column name + type of the view's output — so the reviewer can confirm
    // which columns are uuid (id, driver_id) vs bigint/int (project_id) before
    // wiring the migration. This is what makes `bigint = uuid` visible.
    try {
      const cols = await pg`
        SELECT a.attname AS column, format_type(a.atttypid, a.atttypmod) AS type
          FROM pg_attribute a
         WHERE a.attrelid = ${v}::regclass AND a.attnum > 0 AND NOT a.attisdropped
         ORDER BY a.attnum`;
      console.log(`----- COLUMNS ${v} -----`);
      for (const c of cols) console.log(`  ${c.column} ${c.type}`);
      console.log(`----- END COLUMNS ${v} -----`);
    } catch (e) {
      console.log(`!!! ${v} columns failed: ${e.message}`);
    }
  }
} catch (e) {
  console.error("DUMP_FAIL", e.message);
  process.exitCode = 1;
} finally {
  await pg.end({ timeout: 5 });
}
