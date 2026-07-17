// TEMPORARY read-only probe. Answers what the four-broken-things audit inferred
// from the schema rather than observed. No writes, no DDL.
import postgres from "postgres";
const url = process.env.DATABASE_URL;
if (!url) { console.error("no url"); process.exit(2); }
const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

try {
  console.log("PROBE_START");

  // The public.lorries / public.trips VIEWs are not in the migration tree.
  // Dump their definitions -- they decide whether item 2's callers work.
  const defs = await pg`
    SELECT n.nspname AS schema, c.relname AS name,
           pg_get_viewdef(c.oid, true) AS def
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname='public' AND c.relname IN ('lorries','trips') AND c.relkind='v'`;
  for (const r of defs) {
    console.log(`VIEWDEF ${r.schema}.${r.name} :: ${r.def.replace(/\s+/g, " ")}`);
  }

  const vcols = await pg`
    SELECT table_name, string_agg(column_name, ',' ORDER BY ordinal_position) AS cols
      FROM information_schema.columns
     WHERE table_schema='public' AND table_name IN ('lorries','trips','trip_stops')
     GROUP BY 1 ORDER BY 1`;
  for (const r of vcols) console.log(`VCOLS public.${r.table_name} = ${r.cols}`);

  // Who owns the views / when were they made? pg_class has no timestamp, but a
  // comment or the owner is a clue to whether this was a deliberate shim.
  const own = await pg`
    SELECT c.relname AS name, pg_get_userbyid(c.relowner) AS owner,
           obj_description(c.oid, 'pg_class') AS comment
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relname IN ('lorries','trips')`;
  for (const r of own) console.log(`VOWNER ${r.name} owner=${r.owner} comment=${r.comment ?? "(none)"}`);

  // Item 1: the creditors table the generate-po fix would join.
  const cred = await pg`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name='creditors'
     ORDER BY ordinal_position`;
  console.log(`CRED cols=${cred.map((r) => r.column_name).join(",")}`);

  // Item 3: the real column types behind the 6 comparison sites the audit
  // called safe. TEXT <op> TEXT is fine; timestamptz <op> TEXT raises.
  const t = await pg`
    SELECT table_name, column_name, data_type FROM information_schema.columns
     WHERE table_schema='public'
       AND (table_name, column_name) IN (
         ('assr_alert_acks','snoozed_until'),
         ('assr_lead_time_scheduled_activations','scheduled_for'),
         ('case_track_tokens','expires_at'),
         ('assr_supplier_tokens','expires_at'),
         ('assr_cases','deadline_at'))
     ORDER BY 1,2`;
  for (const r of t) console.log(`TYPE ${r.table_name}.${r.column_name} :: ${r.data_type}`);

  console.log("PROBE_END");
} catch (e) { console.error("PFAIL", e.message); process.exitCode = 1; }
finally { await pg.end({ timeout: 5 }); }
