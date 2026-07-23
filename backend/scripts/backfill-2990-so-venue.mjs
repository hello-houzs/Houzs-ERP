#!/usr/bin/env node
// Backfill company_2 (2990) sales orders to the 2990 showroom's venue. Owner
// 2026-07-23: "这里就有 showroom，然后你帮我把 2990 的单 sales order 里面全部
// backfill 成这个 showroom". 2990's SOs imported with venue NULLed, so they
// carry no venue; the owner wants them attributed to the PJ SHOWROOM venue.
//
// The venue MODEL (mig 0148 / venue-binding.ts): a showroom is a warehouse with
// is_showroom=true; its venue is the TEXT scm.warehouses.venue_name. An SO's
// showroom venue is stamped onto mfg_sales_orders.venue_name (+ venue_source).
// venue-binding's iron rule: NEVER guess a venue — an unset venue_name stays
// NULL. So this script only backfills when the showroom actually HAS a
// venue_name; if it does not, it reports that and writes NOTHING (the owner sets
// the Venue name in Warehouses first).
//
// SAFE: fills only blank-venue company_2 SOs, with the showroom's OWN
// venue_name; sets venue (legacy text), venue_name, venue_source='SHOWROOM'.
// Idempotent. APPLY=1 to write, DRY-RUN otherwise. ONLY_WH=<code> to pick a
// specific showroom if the company has more than one.
import postgres from "postgres";
const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const ONLY_WH = (process.env.ONLY_WH || "").trim();
const dst = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

async function main() {
  const [c2990] = await dst`SELECT id FROM companies WHERE code='2990'`;
  const cid = Number(c2990.id);
  log(`2990 company_id=${cid}  mode=${APPLY ? "APPLY" : "DRY-RUN"}${ONLY_WH ? `  ONLY_WH=${ONLY_WH}` : ""}`);

  // Resolve the company_2 showroom(s). is_showroom is authoritative post-mig 0186
  // (kept in lockstep with type='showroom' by the sync trigger).
  const showrooms = await dst`
    SELECT id, code, name, venue_name, is_showroom, type
      FROM scm.warehouses
     WHERE company_id=${cid} AND (is_showroom = true OR type = 'showroom')
     ORDER BY name`;
  log("");
  log(`=== company_2 showroom warehouses: ${showrooms.length} ===`);
  for (const w of showrooms) log(`  [${w.code}] ${w.name} — venue_name=${w.venue_name ? `"${w.venue_name}"` : "(BLANK)"}  is_showroom=${w.is_showroom} type=${w.type}`);
  if (showrooms.length === 0) { log("no showroom warehouse for company_2 — set one in Warehouses (Type=Showroom) first. Nothing to do."); return; }

  let chosen = showrooms;
  if (ONLY_WH) chosen = showrooms.filter((w) => String(w.code) === ONLY_WH || String(w.name) === ONLY_WH);
  if (chosen.length !== 1) {
    log("");
    log(`Refusing to backfill: need EXACTLY ONE showroom (found ${chosen.length}). Re-run with ONLY_WH=<code> to pick one.`);
    return;
  }
  const wh = chosen[0];
  let venue = (wh.venue_name ?? "").trim();
  // SET_VENUE (owner-provided) fills a BLANK showroom venue_name before
  // backfilling — this is the owner naming the venue, not us guessing. Owner
  // 2026-07-24: the 2990 showroom's venue is "2990s PJ".
  const SET_VENUE = (process.env.SET_VENUE || "").trim();
  if (!venue && SET_VENUE) {
    if (APPLY) { await dst`UPDATE scm.warehouses SET venue_name=${SET_VENUE} WHERE id=${wh.id}`; log(`SET ${wh.name}.venue_name = "${SET_VENUE}"`); }
    else log(`WOULD SET ${wh.name}.venue_name = "${SET_VENUE}" (then backfill SOs to it)`);
    venue = SET_VENUE;
  }
  if (!venue) {
    log("");
    log(`Showroom "${wh.name}" has NO venue_name. Per the venue rule we do NOT guess one.`);
    log(`ACTION: pass SET_VENUE=<label> (owner names it) OR set it in Warehouses, then re-run. Writing nothing.`);
    return;
  }
  log("");
  log(`Target venue: "${venue}" (showroom ${wh.name})`);

  // The SO's venue TEXT lives in mfg_sales_orders.venue (venue_name is a
  // WAREHOUSE column, mig 0148 — the SO carries venue + venue_id + venue_source).
  // Count blank-venue SOs only — never clobber a PMS/manual venue.
  const [{ n: blank }] = await dst`
    SELECT count(*)::int AS n FROM scm.mfg_sales_orders
     WHERE company_id=${cid} AND (venue IS NULL OR btrim(venue)='')`;
  const [{ n: total }] = await dst`SELECT count(*)::int AS n FROM scm.mfg_sales_orders WHERE company_id=${cid}`;
  const [{ n: already }] = await dst`
    SELECT count(*)::int AS n FROM scm.mfg_sales_orders
     WHERE company_id=${cid} AND venue=${venue}`;
  log(`company_2 SOs: ${total} total; ${blank} with blank venue (fillable); ${already} already at "${venue}".`);

  if (!APPLY) { log(""); log(`DRY-RUN — would stamp venue="${venue}", venue_source='SHOWROOM' on ${blank} SOs. Re-run APPLY=1 to write.`); return; }

  const res = await dst`
    UPDATE scm.mfg_sales_orders
       SET venue = ${venue}, venue_source = 'SHOWROOM'
     WHERE company_id=${cid} AND (venue IS NULL OR btrim(venue)='')`;
  log(`APPLIED — ${res.count} SOs stamped to venue "${venue}" (source SHOWROOM).`);
}
main().then(() => dst.end()).catch(async (e) => {
  console.error("VENUE_BACKFILL_FAIL", e.message);
  try { await dst.end(); } catch {}
  process.exit(1);
});
