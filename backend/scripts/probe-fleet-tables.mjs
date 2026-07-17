// TEMPORARY read-only probe. Runs the EXACT shapes the live handlers run, to
// observe whether they raise, rather than inferring it. SELECT only.
import postgres from "postgres";
const url = process.env.DATABASE_URL;
if (!url) { console.error("no url"); process.exit(2); }
const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

async function probe(label, sql) {
  try {
    const r = await pg.unsafe(sql);
    console.log(`RUN ${label} => OK rows=${r.length}`);
  } catch (e) {
    console.log(`RUN ${label} => RAISES ${e.message.slice(0, 130)}`);
  }
}

try {
  console.log("PROBE_START");

  const t = await pg`
    SELECT table_name, column_name, data_type FROM information_schema.columns
     WHERE table_schema='public'
       AND (table_name, column_name) IN (
         ('trips','driver_user_id'), ('trips','id'), ('trips','project_id'),
         ('trip_stops','trip_id'), ('trip_stops','id'),
         ('users','id'), ('projects','setup_lorry_id'), ('lorries','id'))
     ORDER BY 1,2`;
  for (const r of t) console.log(`TYPE ${r.table_name}.${r.column_name} :: ${r.data_type}`);

  const n = await pg`SELECT
      (SELECT count(*) FROM scm.trips)::int AS scm_trips,
      (SELECT count(*) FROM public.trip_stops)::int AS old_stops,
      (SELECT count(*) FROM scm.lorries)::int AS scm_lorries`;
  console.log(`COUNT scm.trips=${n[0].scm_trips} public.trip_stops=${n[0].old_stops} scm.lorries=${n[0].scm_lorries}`);

  // inbox.ts:231 loadMyTasks -- the driver's trips for today (3rd of 3 loaders).
  await probe("inbox_my_tasks_trips", `
    SELECT t.id, t.trip_no, t.trip_date, t.status, t.warehouse,
           (SELECT COUNT(*) FROM trip_stops s WHERE s.trip_id = t.id) as stop_count
      FROM trips t
     WHERE t.driver_user_id = 1
       AND t.trip_date = '2026-07-17'
       AND t.status IN ('assigned','started','in_progress')
     ORDER BY t.id DESC LIMIT 10`);

  // inbox.ts:541 loadThisWeek -- the showAll branch binds no user id at all.
  await probe("inbox_this_week_trips_showall", `
    SELECT id, trip_no, trip_date, status, warehouse, driver_user_id,
           (SELECT name FROM users WHERE id = trips.driver_user_id) as driver_name
      FROM trips
     WHERE trip_date BETWEEN '2026-07-17' AND '2026-07-24'
       AND status IN ('assigned','started','in_progress')
     ORDER BY trip_date ASC, id ASC LIMIT 10`);

  // services/projects.ts:723 -- linked trips on project detail.
  await probe("project_detail_linked_trips", `
    SELECT id, trip_no as code, status, trip_date as scheduled_date, trip_type,
           notes as description
      FROM trips WHERE project_id = 1
     ORDER BY trip_date DESC, id DESC LIMIT 50`);

  // services/projects.ts:606 -- the project detail head, incl. the lorries join.
  await probe("project_detail_head", `
    SELECT p.id, l1.plate as setup_lorry_plate, l2.plate as dismantle_lorry_plate
      FROM projects p
      LEFT JOIN lorries l1 ON l1.id = p.setup_lorry_id
      LEFT JOIN lorries l2 ON l2.id = p.dismantle_lorry_id
     WHERE p.id = 1`);

  // routes/events.ts:139 -- the Drizzle leftJoin shape.
  await probe("events_setup_lorry_join", `
    SELECT p.id, sl.plate
      FROM projects p
      LEFT JOIN lorries sl ON sl.id = p.setup_lorry_id
     WHERE p.archived_at IS NULL LIMIT 5`);

  // routes/projects.ts:3457 -- the trip<->project link write shape (READ-ONLY
  // rehearsal: same predicate, SELECT instead of UPDATE).
  await probe("projects_link_trip_predicate", `SELECT id FROM trips WHERE id = 1 LIMIT 1`);

  console.log("PROBE_END");
} catch (e) { console.error("PFAIL", e.message); process.exitCode = 1; }
finally { await pg.end({ timeout: 5 }); }
