// TEMPORARY read-only probe. Answers the three questions the four-broken-things
// audit inferred from the schema rather than observed. No writes, no DDL.
import postgres from "postgres";
const url = process.env.DATABASE_URL;
if (!url) { console.error("no url"); process.exit(2); }
const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

try {
  console.log("PROBE_START");

  // Q1 (item 2): do the tables 0055 dropped actually exist? relkind tells a
  // table ('r') from a compatibility VIEW ('v') — 0083 guarded on relkind.
  const rel = await pg`
    SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relname IN ('lorries','trips','trip_stops','driver_clock_records')
       AND n.nspname IN ('public','scm')
     ORDER BY 1,2`;
  for (const r of rel) console.log(`REL ${r.schema}.${r.name} kind=${r.kind}`);
  if (!rel.length) console.log("REL none");

  // Q2 (item 2): is 0055 actually applied, and did the runner get past it?
  const mig = await pg`
    SELECT filename FROM _pg_migrations
     WHERE filename LIKE '0055%' OR filename LIKE '0098%' OR filename LIKE '0121%'
     ORDER BY 1`;
  for (const r of mig) console.log(`MIG applied=${r.filename}`);
  const maxMig = await pg`SELECT max(filename) AS m, count(*)::int AS n FROM _pg_migrations`;
  console.log(`MIG max=${maxMig[0].m} count=${maxMig[0].n}`);

  // Q3 (item 1): does assr_cases have a `supplier` column, and what supplier-ish
  // columns does it actually carry?
  const cols = await pg`
    SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema='public' AND table_name='assr_cases'
       AND (column_name LIKE '%supplier%' OR column_name LIKE '%creditor%')
     ORDER BY 1`;
  for (const r of cols) console.log(`ASSR ${r.column_name} :: ${r.data_type}`);

  // Q4 (item 3): the sweep predicate's column type + current table size.
  const idem = await pg`
    SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema='public' AND table_name='idempotency_keys' ORDER BY 1`;
  for (const r of idem) console.log(`IDEM ${r.column_name} :: ${r.data_type}`);
  const idemN = await pg`SELECT count(*)::int AS n FROM idempotency_keys`;
  console.log(`IDEM rows=${idemN[0].n}`);
  // Prove the predicate raises rather than trusting the type mapping.
  try {
    await pg.unsafe(`SELECT 1 FROM idempotency_keys WHERE created_at < to_char((now() - interval '24 hours')::timestamptz, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') LIMIT 1`);
    console.log("IDEM predicate=OK (no error)");
  } catch (e) {
    console.log(`IDEM predicate=RAISES ${e.message.slice(0, 120)}`);
  }

  // Q5 (item 3): the 6 sites the audit called safe — confirm each column is TEXT.
  const other = await pg`
    SELECT table_name, column_name, data_type FROM information_schema.columns
     WHERE table_schema='public'
       AND (table_name, column_name) IN (
         ('assr_cases','sla_due_at'), ('assr_cases','created_at'),
         ('assr_survey_tokens','expires_at'), ('case_track_tokens','expires_at'),
         ('supplier_portal_tokens','expires_at'), ('assr_logistics','eta_date'))
     ORDER BY 1,2`;
  for (const r of other) console.log(`OTHER ${r.table_name}.${r.column_name} :: ${r.data_type}`);

  console.log("PROBE_END");
} catch (e) { console.error("PFAIL", e.message); process.exitCode = 1; }
finally { await pg.end({ timeout: 5 }); }
