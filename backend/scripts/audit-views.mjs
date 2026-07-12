// READ-ONLY prod schema audit (Phase 0f). Lists every VIEW / materialized view
// in the scm + public schemas so the multi-company company_id migration can
// recreate any that a scoped route reads. NO writes — a single SELECT against
// pg_class. Run in CI via the DATABASE_URL secret (workflow: db-audit.yml).
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set. Aborting.");
  process.exit(2);
}

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });
try {
  const rows = await pg`
    SELECT n.nspname AS schema, c.relname AS name,
           CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'matview' ELSE c.relkind::text END AS kind
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('scm', 'public') AND c.relkind IN ('v', 'm')
    ORDER BY 1, 2`;
  console.log("VIEWAUDIT_START");
  for (const r of rows) console.log(`VIEW ${r.schema}.${r.name} ${r.kind}`);
  console.log(`VIEWAUDIT_COUNT ${rows.length}`);
  console.log("VIEWAUDIT_END");
} catch (e) {
  console.error("VIEWAUDIT_FAILED", e.message);
  process.exitCode = 1;
} finally {
  await pg.end({ timeout: 5 });
}
