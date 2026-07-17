#!/usr/bin/env node
// TEMPORARY PROBE (branch diag/selling-price-probe -- NEVER MERGE).
// This file normally holds the Phase 2 import diagnostics; it is replaced here
// only so the existing read-only diag-2990.yml workflow can run one question.
//
// THE QUESTION, read-only: does 2990's live maintenance config actually carry
// sellingPriceSen values today?
//
// Why it decides everything: Houzs's Maintenance writes ONE price (priceSen =
// COST, owner rule 2026-06-22) and deliberately omits sellingPriceSen -- see
// migrations-pg/0030 "costSen/sellingPriceSen are opt-in and intentionally
// omitted". 2990's POS charges the customer from sellingPriceSen ALONE
// (apps/pos/src/lib/queries.ts:720 `surcharge: Math.round(o.sellingPriceSen ?? 0) / 100`).
// 2990's only config write endpoint takes the WHOLE blob, so pushing Houzs's
// config over would drop that field -> `?? 0` -> every surcharge becomes RM 0.00
// on the POS, live within ~300ms via the Realtime subscription, with no error.
//
// So: if sellingPriceSen is unset everywhere today, the POS surcharges are
// ALREADY 0 and a push loses nothing. If it carries values, a push is real
// revenue loss. The code comment claiming "Unset today everywhere" is dated
// 2026-05-28 and cannot be trusted two months on.
import { createClient } from "@supabase/supabase-js";

const SUPA_URL = process.env.SOURCE_SUPABASE_URL;
const SUPA_KEY = process.env.SOURCE_SERVICE_ROLE_KEY;
if (!SUPA_URL || !SUPA_KEY) {
  console.error("SOURCE_SUPABASE_URL / SOURCE_SERVICE_ROLE_KEY missing");
  process.exit(2);
}
const src = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false } });

const PRICED_POOLS = ["divanHeights", "legHeights", "totalHeights", "specials", "sofaLegHeights", "sofaSpecials"];

async function main() {
  const { data, error } = await src
    .from("maintenance_config_history")
    .select("id, scope, effective_from, created_at, config")
    .eq("scope", "master")
    .order("effective_from", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`maintenance_config_history: ${error.message}`);
  if (!data?.length) {
    console.log("NO_MASTER_ROW -- 2990 has no scope='master' config row.");
    return;
  }

  const row = data[0];
  console.log(`resolved master row: id=${row.id} effective_from=${row.effective_from} created_at=${row.created_at}`);
  const cfg = row.config ?? {};

  let total = 0;
  let withSelling = 0;
  let nonZeroSelling = 0;

  console.log("");
  console.log("pool                | entries | has selling | selling>0 | sample");
  console.log("--------------------+---------+-------------+-----------+--------");
  for (const pool of PRICED_POOLS) {
    const arr = Array.isArray(cfg[pool]) ? cfg[pool] : null;
    if (!arr) {
      console.log(`${pool.padEnd(19)} | ABSENT from the blob`);
      continue;
    }
    const ws = arr.filter((o) => o?.sellingPriceSen !== undefined && o?.sellingPriceSen !== null);
    const nz = ws.filter((o) => Number(o.sellingPriceSen) > 0);
    total += arr.length;
    withSelling += ws.length;
    nonZeroSelling += nz.length;
    const sample = nz[0]
      ? `${nz[0].value}: selling=${nz[0].sellingPriceSen} priceSen=${nz[0].priceSen}`
      : arr[0]
        ? `${arr[0].value}: priceSen=${arr[0].priceSen} selling=${arr[0].sellingPriceSen ?? "(unset)"}`
        : "(empty pool)";
    console.log(
      `${pool.padEnd(19)} | ${String(arr.length).padStart(7)} | ${String(ws.length).padStart(11)} | ${String(nz.length).padStart(9)} | ${sample}`,
    );
  }

  console.log("");
  console.log(`TOTALS entries=${total} withSellingPriceSen=${withSelling} sellingGreaterThanZero=${nonZeroSelling}`);
  console.log("");
  if (nonZeroSelling === 0) {
    console.log("VERDICT: SELLING_UNSET -- no priced option carries a non-zero sellingPriceSen.");
    console.log("  POS surcharge for these pools is ALREADY RM 0.00 (queries.ts:720 `?? 0`).");
    console.log("  A whole-blob push from Houzs would not lose retail revenue on these pools.");
  } else {
    console.log(`VERDICT: SELLING_IN_USE -- ${nonZeroSelling} option(s) carry a real sellingPriceSen.`);
    console.log("  A whole-blob push from Houzs WOULD zero these on the POS within ~300ms, silently.");
    console.log("  Any push must read-modify-write and preserve sellingPriceSen per entry.");
  }

  const meta = cfg.sofaCompartmentMeta;
  if (meta && typeof meta === "object") {
    const entries = Object.entries(meta);
    const priced = entries.filter(([, v]) => Number(v?.defaultPriceCenti ?? 0) > 0);
    console.log("");
    console.log(`sofaCompartmentMeta: ${entries.length} entries, ${priced.length} with defaultPriceCenti > 0`);
    if (priced.length) console.log(`  e.g. ${priced[0][0]} = ${priced[0][1].defaultPriceCenti} centi`);
  }

  const pools = Object.keys(cfg).sort();
  console.log("");
  console.log(`config keys present on 2990 (${pools.length}): ${pools.join(", ")}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FAIL", e.message);
    process.exit(1);
  });
