#!/usr/bin/env node
// READ-ONLY drift sentinel for the 2990 -> Houzs one-way mirrors (SO + SO
// amendments). The two are separate transports that share one outbox table, so
// every query here is scoped by `entity` -- see the note on the outbox query.
//
// The mirror is: a trigger on 2990 (dolvxrchzbnqvahocwsu) enqueues every SO into
// public.sync_outbox; pg_cron workers (so_outbox_drain / _confirm / _reconcile)
// POST each SO to the Houzs receiver, which idempotently upserts it into Houzs
// (anogrigyjbduyzclzjgn) as scm.mfg_sales_orders WHERE company_id = 2.
//
// There is no alarm today if the mirror silently stops (pg_cron paused,
// receiver down, or rows wedged). This script is that alarm: it compares the
// source SO count against the mirrored count and inspects outbox health, prints
// a one-line summary, and EXITS NON-ZERO when an alarm condition is met so the
// scheduled GitHub Action fails and the owner gets the standard failed-workflow
// email. Exit 0 when healthy. It only ever SELECTs -- never writes.
//
// Env (connection strings; session-pooler postgresql://...pooler... URLs):
//   SENTINEL_2990_DB_URL   -> 2990 Postgres (source + outbox)
//   SENTINEL_HOUZS_DB_URL  -> Houzs Postgres (mirror target)
//
// Usage: node scripts/mirror-drift-sentinel.mjs
import postgres from "postgres";

const url2990 = process.env.SENTINEL_2990_DB_URL;
const urlHouzs = process.env.SENTINEL_HOUZS_DB_URL;

// No secrets configured yet -> stay inert (skip, exit 0) rather than failing.
// This lets the scheduled workflow land before the owner adds the two secrets.
if (!url2990 || !urlHouzs) {
  console.log(
    "SKIP: SENTINEL_2990_DB_URL and/or SENTINEL_HOUZS_DB_URL not set -- sentinel inert until the owner adds both repo secrets.",
  );
  process.exit(0);
}

// Alarm thresholds.
const STUCK_MINUTES = 15; // outbox row not 'done' this long past enqueue = stuck
const STALE_DELIVERY_HOURS = 1; // last successful delivery older than this = stale

const src = postgres(url2990, { ssl: "require", prepare: false, max: 1 });
const dst = postgres(urlHouzs, { ssl: "require", prepare: false, max: 1 });

async function main() {
  // --- 2990 source SO count ---
  const [{ n: sourceCount }] =
    await src`SELECT count(*)::int AS n FROM public.mfg_sales_orders`;

  // --- 2990 outbox health ---
  // entity = 'sales_order' is LOAD-BEARING, not tidiness. sync_outbox is shared
  // with the amendment mirror (entity = 'so_amendment', docs/2990-live-sync/
  // 04_amendment_outbox_2990.sql). Unscoped, this query broke in both directions
  // the moment a second entity existed:
  //   * MASKING — last_delivery is max(delivered_at) across ALL entities, so a
  //     healthy amendment stream keeps it fresh and the staleDelivery alarm
  //     never fires even if the SO mirror has stopped delivering entirely. That
  //     is the alarm on the one link the owner says must not break.
  //   * FALSE ALARM — a pending amendment row (e.g. 04 applied but the drain not
  //     yet enabled, so nothing drains it) counts as `stuck` and reports as an
  //     SO-mirror failure.
  // The SO alarm is scoped to the SO mirror; amendments get their own block below.
  const [outbox] = await src`
    SELECT
      count(*) FILTER (WHERE status = 'pending')::int AS pending,
      count(*) FILTER (WHERE status = 'sent')::int    AS sent,
      count(*) FILTER (WHERE status = 'done')::int    AS done,
      count(*) FILTER (
        WHERE status <> 'done'
          AND enqueued_at < now() - (${STUCK_MINUTES} * interval '1 minute')
      )::int AS stuck,
      max(delivered_at) AS last_delivery
    FROM public.sync_outbox
    WHERE entity = 'sales_order'`;

  const pending = Number(outbox.pending);
  const sent = Number(outbox.sent);
  const done = Number(outbox.done);
  const stuck = Number(outbox.stuck);
  const lastDelivery = outbox.last_delivery; // Date | null

  // --- Houzs mirrored SO count ---
  const [{ n: mirroredCount }] =
    await dst`SELECT count(*)::int AS n FROM scm.mfg_sales_orders WHERE company_id = 2`;

  const drift = sourceCount - mirroredCount;

  // --- amendment mirror health (only while it is switched on) ---
  // Gated on the same sync_config row that gates the drain, so the period
  // between "04 applied" and "owner enables it" reports as disabled instead of
  // alarming on rows nothing is draining yet. Reports parity but alarms ONLY on
  // stuck rows: an unmirrored-but-moving amendment is a transient, whereas the
  // FK failures this receiver can hit (a 2990 staff member hired after the
  // one-time import has no scm.staff row) do NOT self-heal and must be seen.
  const [amdCfg] = await src`
    SELECT COALESCE((SELECT v FROM sync_config WHERE k = 'enabled_entities'), '') AS v`;
  const amendmentOn = String(amdCfg.v)
    .split(",")
    .map((s) => s.trim())
    .includes("so_amendment");

  const amendmentAlarms = [];
  let amendmentSummary = "amendments=off";
  if (amendmentOn) {
    const [{ n: amdSource }] =
      await src`SELECT count(*)::int AS n FROM public.so_amendments`;
    const [amdOutbox] = await src`
      SELECT count(*) FILTER (
        WHERE status <> 'done'
          AND enqueued_at < now() - (${STUCK_MINUTES} * interval '1 minute')
      )::int AS stuck
      FROM public.sync_outbox
      WHERE entity = 'so_amendment'`;
    const [{ n: amdMirrored }] =
      await dst`SELECT count(*)::int AS n FROM scm.so_amendments WHERE company_id = 2`;
    const amdStuck = Number(amdOutbox.stuck);
    amendmentSummary =
      `amendments src=${amdSource} mirrored=${amdMirrored} stuck=${amdStuck}`;
    if (amdStuck > 0)
      amendmentAlarms.push(
        `${amdStuck} amendment outbox row(s) stuck > ${STUCK_MINUTES}m ` +
          `(read net._http_response.content for the receiver's reason)`,
      );
  }

  // --- last-delivery staleness (only meaningful while work is waiting) ---
  const now = Date.now();
  const lastDeliveryMs = lastDelivery ? new Date(lastDelivery).getTime() : null;
  const deliveryAgeHours =
    lastDeliveryMs == null ? null : (now - lastDeliveryMs) / 3_600_000;
  const staleDelivery =
    pending > 0 &&
    (lastDeliveryMs == null || deliveryAgeHours > STALE_DELIVERY_HOURS);

  // --- alarm decision ---
  // 1) rows wedged in the outbox past the stuck window;
  // 2) a real, PERSISTED drift (count mismatch AND stuck rows -- a transient
  //    in-flight delta with no stuck rows is normal and does NOT alarm);
  // 3) deliveries have gone stale while pending work is queued.
  // 4) the amendment mirror's own stuck rows (see the block above). Kept in the
  //    same alarm list so one failing workflow still means "the mirror needs a
  //    look", but worded so the reader knows WHICH mirror.
  const alarms = [...amendmentAlarms];
  if (stuck > 0) alarms.push(`${stuck} SO outbox row(s) stuck > ${STUCK_MINUTES}m`);
  if (drift !== 0 && stuck > 0)
    alarms.push(`persisted drift ${drift} (source-mirror) with stuck rows`);
  if (staleDelivery)
    alarms.push(
      `no delivery for ${
        deliveryAgeHours == null ? "ever" : deliveryAgeHours.toFixed(1) + "h"
      } while ${pending} pending`,
    );

  const lastDeliveryStr = lastDelivery
    ? new Date(lastDelivery).toISOString()
    : "never";

  console.log(
    `mirror-sentinel: source=${sourceCount} mirrored=${mirroredCount} drift=${drift} ` +
      `stuck=${stuck} pending=${pending} sent=${sent} done=${done} lastDelivery=${lastDeliveryStr} ` +
      `| ${amendmentSummary}`,
  );

  if (alarms.length > 0) {
    console.error(`ALARM: ${alarms.join("; ")}`);
    return 1;
  }
  console.log("OK: mirror healthy (no stuck rows, no persisted drift, deliveries current).");
  return 0;
}

let code = 0;
try {
  code = await main();
} catch (e) {
  console.error("FAIL: sentinel error -", e.message);
  code = 1;
} finally {
  await src.end({ timeout: 5 }).catch(() => {});
  await dst.end({ timeout: 5 }).catch(() => {});
}
process.exit(code);
