#!/usr/bin/env node
// READ-ONLY drift sentinel for the 2990 -> Houzs one-way SO mirror.
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
// CREDENTIALS -- why there are two paths.
// This script originally demanded SENTINEL_2990_DB_URL + SENTINEL_HOUZS_DB_URL,
// two secrets nobody ever set. So from the day it was scheduled it printed SKIP
// and exited 0 -- every 30 minutes, green, checking nothing. On 2026-07-17 the
// mirror was found holding at source=63 mirrored=62: one SO had been stuck for
// days and the alarm built to catch exactly that had reported healthy the whole
// time. An alarm that fails silent is worse than no alarm, because the green
// tick gets read as evidence.
//
// The repo already had working credentials for BOTH sides under other names --
// diag-2990.yml reaches 2990 via SOURCE_SUPABASE_URL + SOURCE_SERVICE_ROLE_KEY
// and Houzs via DATABASE_URL, and a 2026-07-17 prod run proved both live. So the
// sentinel was never missing credentials; it was asking for the wrong ones. It
// now accepts either:
//
//   2990:  SENTINEL_2990_DB_URL (postgres)  ||  SOURCE_SUPABASE_URL + SOURCE_SERVICE_ROLE_KEY (REST)
//   Houzs: SENTINEL_HOUZS_DB_URL (postgres) ||  DATABASE_URL (postgres)
//
// Prefer a direct URL when present (one round trip, real SQL aggregates); fall
// back to PostgREST, which needs head-count queries to do what one FILTER
// aggregate does. Same numbers either way.
//
// Usage: node scripts/mirror-drift-sentinel.mjs
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";

const url2990 = process.env.SENTINEL_2990_DB_URL;
const urlHouzs = process.env.SENTINEL_HOUZS_DB_URL || process.env.DATABASE_URL;
const restUrl = process.env.SOURCE_SUPABASE_URL;
const restKey = process.env.SOURCE_SERVICE_ROLE_KEY;

const has2990 = Boolean(url2990 || (restUrl && restKey));

// Stay inert only when a side is genuinely unreachable. This is the ONLY path
// that may exit 0 without checking anything, and reaching it now requires all
// four credential options to be absent -- not just the two nobody set.
if (!has2990 || !urlHouzs) {
  const missing = [];
  if (!has2990) missing.push("2990 (SENTINEL_2990_DB_URL, or SOURCE_SUPABASE_URL + SOURCE_SERVICE_ROLE_KEY)");
  if (!urlHouzs) missing.push("Houzs (SENTINEL_HOUZS_DB_URL, or DATABASE_URL)");
  console.log(`SKIP: no credentials for ${missing.join(" and ")} -- sentinel inert.`);
  process.exit(0);
}

// Alarm thresholds.
const STUCK_MINUTES = 15; // outbox row not 'done' this long past enqueue = stuck
const STALE_DELIVERY_HOURS = 1; // last successful delivery older than this = stale

const src = url2990 ? postgres(url2990, { ssl: "require", prepare: false, max: 1 }) : null;
const rest = src ? null : createClient(restUrl, restKey, { auth: { persistSession: false } });
const dst = postgres(urlHouzs, { ssl: "require", prepare: false, max: 1 });

/** 2990 SO count + outbox health, over whichever transport is configured.
 *  The REST branch counts with head:true rather than fetching rows: PostgREST
 *  caps a select at 1000 rows and the outbox grows one row per SO EDIT, so
 *  aggregating client-side would silently under-report past that ceiling. */
async function read2990() {
  if (src) {
    const [{ n: sourceCount }] = await src`SELECT count(*)::int AS n FROM public.mfg_sales_orders`;
    const [o] = await src`
      SELECT
        count(*) FILTER (WHERE status = 'pending')::int AS pending,
        count(*) FILTER (WHERE status = 'sent')::int    AS sent,
        count(*) FILTER (WHERE status = 'done')::int    AS done,
        count(*) FILTER (
          WHERE status <> 'done'
            AND enqueued_at < now() - (${STUCK_MINUTES} * interval '1 minute')
        )::int AS stuck,
        max(delivered_at) AS last_delivery
      FROM public.sync_outbox`;
    return {
      sourceCount: Number(sourceCount),
      pending: Number(o.pending),
      sent: Number(o.sent),
      done: Number(o.done),
      stuck: Number(o.stuck),
      lastDelivery: o.last_delivery,
    };
  }

  const outboxCount = async (build) => {
    const { count, error } = await build(
      rest.from("sync_outbox").select("*", { count: "exact", head: true }),
    );
    if (error) throw new Error(`sync_outbox count: ${error.message}`);
    return Number(count ?? 0);
  };

  const soHead = await rest.from("mfg_sales_orders").select("*", { count: "exact", head: true });
  if (soHead.error) throw new Error(`mfg_sales_orders count: ${soHead.error.message}`);

  const cutoff = new Date(Date.now() - STUCK_MINUTES * 60_000).toISOString();
  const [pending, sent, done, stuck] = await Promise.all([
    outboxCount((q) => q.eq("status", "pending")),
    outboxCount((q) => q.eq("status", "sent")),
    outboxCount((q) => q.eq("status", "done")),
    outboxCount((q) => q.neq("status", "done").lt("enqueued_at", cutoff)),
  ]);

  const last = await rest
    .from("sync_outbox")
    .select("delivered_at")
    .not("delivered_at", "is", null)
    .order("delivered_at", { ascending: false })
    .limit(1);
  if (last.error) throw new Error(`last delivery: ${last.error.message}`);

  return {
    sourceCount: Number(soHead.count ?? 0),
    pending,
    sent,
    done,
    stuck,
    lastDelivery: last.data?.[0]?.delivered_at ?? null,
  };
}

async function main() {
  const { sourceCount, pending, sent, done, stuck, lastDelivery } = await read2990();

  const [{ n: mirroredCount }] =
    await dst`SELECT count(*)::int AS n FROM scm.mfg_sales_orders WHERE company_id = 2`;

  const drift = sourceCount - mirroredCount;

  // --- last-delivery staleness (only meaningful while work is waiting) ---
  const now = Date.now();
  const lastDeliveryMs = lastDelivery ? new Date(lastDelivery).getTime() : null;
  const deliveryAgeHours = lastDeliveryMs == null ? null : (now - lastDeliveryMs) / 3_600_000;
  const staleDelivery =
    pending > 0 && (lastDeliveryMs == null || deliveryAgeHours > STALE_DELIVERY_HOURS);

  // --- alarm decision ---
  // 1) rows wedged in the outbox past the stuck window;
  // 2) a persisted drift;
  // 3) deliveries gone stale while pending work is queued.
  //
  // (2) no longer requires stuck rows. The original rule was `drift !== 0 && stuck > 0`
  // -- reasoning that a transient in-flight delta is normal, which is true, but it
  // means a trigger that never fired, or a row the reconcile sweep dropped, produces
  // drift with an EMPTY outbox and stays silent forever. That is exactly the 63-vs-62
  // case: a missing SO leaves nothing wedged to point at it. Drift now alarms on its
  // own; the transient case is excluded by requiring the delta to outlive a drain
  // cycle, which `pending == 0 && sent == 0` establishes far more precisely than
  // `stuck` ever did.
  const alarms = [];
  if (stuck > 0) alarms.push(`${stuck} outbox row(s) stuck > ${STUCK_MINUTES}m`);
  if (drift !== 0 && (stuck > 0 || (pending === 0 && sent === 0)))
    alarms.push(`persisted drift ${drift} (source ${sourceCount} - mirrored ${mirroredCount})`);
  if (staleDelivery)
    alarms.push(
      `no delivery for ${deliveryAgeHours == null ? "ever" : deliveryAgeHours.toFixed(1) + "h"} while ${pending} pending`,
    );

  const lastDeliveryStr = lastDelivery ? new Date(lastDelivery).toISOString() : "never";

  console.log(
    `mirror-sentinel: source=${sourceCount} mirrored=${mirroredCount} drift=${drift} ` +
      `stuck=${stuck} pending=${pending} sent=${sent} done=${done} lastDelivery=${lastDeliveryStr} ` +
      `transport=${src ? "pg" : "rest"}`,
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
  await src?.end({ timeout: 5 }).catch(() => {});
  await dst.end({ timeout: 5 }).catch(() => {});
}
process.exit(code);
