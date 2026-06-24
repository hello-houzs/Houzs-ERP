#!/usr/bin/env node
/**
 * One-shot: re-seed the Houzs SOFA catalog as per-MODEL rows.
 *
 * THE BUG THIS FIXES
 *   scm.mfg_products WHERE category='SOFA' currently holds 102 rows, ALL
 *   per-SECTION (e.g. code '5531-1A(L)', name "5531 1seater with 1 arm on
 *   left hand side (1A(L))"), every one with base_model=NULL and
 *   model_id=NULL. There is NO Model layer: scm.product_models WHERE
 *   category='SOFA' = 0 rows. So the Sofa SKU Master grid shows "—" in the
 *   Model column (Products.tsx Model accessor = row.base_model ?? '—') and
 *   the Model filter chips are empty.
 *
 * HOW A SOFA MODEL SHOULD LOOK (per 2990, confirmed in code)
 *   ONE row per MODEL in scm.product_models (model_code, name, branding,
 *   category='SOFA', allowed_options jsonb). The sections live as a JSONB
 *   array allowed_options.compartments on that model row — the single
 *   source the SKU generator reads (product-models.ts:538 compsArr =
 *   opts.compartments; :573-581 mints one mfg_products SKU per compartment
 *   as code {model_code}-{comp}, name "{branding} SOFA {name} {comp}",
 *   base_model={model_code}, model_id=<model uuid>). Compartment codes must
 *   equal scm.compartment_library.id EXACTLY (case-sensitive).
 *
 * WHAT THIS SCRIPT DOES (and DELIBERATELY does NOT do)
 *   (1) DELETE every current per-section SOFA SKU (all 102 are orphans —
 *       model_id NULL, nothing references them as a Model). Reports count.
 *   (2) INSERT one scm.product_models row per MODEL {model_code, name,
 *       branding='Houzs', category='SOFA', allowed_options.compartments}.
 *       NO price is written (pricing is separate, handled per task #84).
 *   It does NOT call generate-skus and does NOT hand-insert section rows.
 *   After this script, the parent runs POST /product-models/:id/generate-skus
 *   per model to mint the per-section SKUs correctly (base_model + model_id
 *   populated). Do not also insert section rows by hand or you double-seed.
 *
 * IDEMPOTENT
 *   product_models is upserted on (category, model_code) — re-running
 *   updates name/branding/allowed_options in place, never duplicates.
 *   The DELETE is naturally idempotent (0 rows the second time).
 *   The 1S/2S/3S compartment_library seed is ON CONFLICT (id) DO NOTHING.
 *
 * OWNER CORRECTION (2026-06-24) — whole seaters 1S / 2S / 3S ARE seeded
 *   The Excel lists 1S/2S/3S as sections on every model ("1s 2s 3s 都有").
 *   The pool had NO 1S/2S/3S ids, so before any product_models upsert this
 *   script FIRST inserts the three whole-seater rows into
 *   scm.compartment_library (idempotent). They are seating pieces, not
 *   modular arm/corner pieces — is_accessory=false so the sofa-build
 *   accessory filters never skip them. comp_group has no '3-seater' enum
 *   value, so all three are grouped under 'Accessory' (the only enum value
 *   valid for all three; comp_group is NOT used to mint or filter SKUs —
 *   product-models.ts iterates the compartments array directly, the id just
 *   has to exist in compartment_library).
 *
 * OWNER CORRECTION (2026-06-24) — use ONLY section codes in the Excel
 *   Each model's `compartments` is now its REAL per-model Excel section set
 *   (derived from the Internal Code column, grouped by DSL code for
 *   9058/8030/9028/8038/8050/8051 and HOOKKA code for 5531/5535), mapped to
 *   pool ids. STOOL is in the pool but NOT in the Excel sense the owner
 *   wants kept — it is DROPPED from every model. 1B/2B are never used.
 *   Models legitimately differ: only 9058 (MAYBATCH) carries Console (its
 *   Excel has a CSL row); the other seven do not.
 *
 * Excel section -> pool id mapping
 *   1s/1S -> 1S   2s/2S -> 2S   3s/3S -> 3S   (whole seaters, seeded above)
 *   1NA -> 1NA    2NA -> 2NA
 *   1A(L) -> 1A(LHF)   1A(R) -> 1A(RHF)
 *   2A(L) -> 2A(LHF)   2A(R) -> 2A(RHF)
 *   L(L)/2L(L) -> L(LHF)   L(R) -> L(RHF)
 *   CNR -> CNR    CSL -> Console    STOOL -> (dropped)
 *
 * Per CLAUDE.md this is a one-shot script (NOT a numbered migration):
 * environment-specific data convergence, not a schema change.
 *
 * Usage (from backend/, reads DATABASE_URL from .dev.vars):
 *   node scripts/reseed-sofa-models.mjs [--dry]
 *
 * SAFETY: without --dry this DELETEs 100+ live rows. The parent runs it
 * after review. --dry performs zero writes.
 */
import { readFileSync } from "node:fs";
import postgres from "postgres";

const dry = process.argv.slice(2).includes("--dry");
const url = readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="?([^"\n]+)"?/)[1];
const sql = postgres(url, {
  ssl: "require",
  prepare: false,
  max: 1,
  idle_timeout: 5,
  connect_timeout: 15,
});

// branding drives the SKU-name prefix. Empty => "SOFA <name> <comp>" (no brand
// word), matching 2990 + the owner's preference (no "HOUZS" in the SKU name).
const BRANDING = "";

// Whole-seater pieces the Excel lists on EVERY model but the pool lacked.
// Inserted into scm.compartment_library before the model upserts so the ids
// are valid FK targets. Column shape matches the 2990 seed (mig 0022):
// (id, comp_group, label, width_cm, depth_cm, cushions, default_price,
//  art_filename, is_accessory, sort_order). comp_group enum has no
// '3-seater' value -> all three use 'Accessory' (comp_group is cosmetic for
// minting). is_accessory=false (seating, not a console/stool). default_price
// 0 (pricing is separate, task #84). sort_order 100+ to sit after the 15
// existing rows. Dims are nominal whole-sofa footprints.
const SEATERS = [
  { id: "1S", comp_group: "Accessory", label: "1 Seater", width_cm: 95,  depth_cm: 95, cushions: 1, default_price: 0, art_filename: null, is_accessory: false, sort_order: 101 },
  { id: "2S", comp_group: "Accessory", label: "2 Seater", width_cm: 158, depth_cm: 95, cushions: 2, default_price: 0, art_filename: null, is_accessory: false, sort_order: 102 },
  { id: "3S", comp_group: "Accessory", label: "3 Seater", width_cm: 210, depth_cm: 95, cushions: 3, default_price: 0, art_filename: null, is_accessory: false, sort_order: 103 },
];

// 8 distinct sofa MODELS derived from the Excel (Internal Code column,
// grouped by DSL code for 9058/8030/9028/8038/8050/8051 and HOOKKA code for
// 5531/5535). model_code = DSL number (5531/5535 = HOOKKA number); name =
// friendly HOUZS name (5531/5535 keep the number). compartments = each
// model's REAL Excel section set mapped to pool ids — 1S/2S/3S INCLUDED,
// STOOL and 1B/2B EXCLUDED. Only 9058 carries Console (its Excel has CSL).
// Codes MUST match scm.compartment_library.id case-sensitively.
const MODELS = [
  {
    model_code: "9058",
    name: "MAYBATCH",
    // Excel: 1s 2s 3s 1NA 2NA 1A(L) 1A(R) 2A(L) 2A(R) L(L) L(R) CNR CSL
    compartments: ["1S", "2S", "3S", "1NA", "2NA", "1A(LHF)", "1A(RHF)", "2A(LHF)", "2A(RHF)", "L(LHF)", "L(RHF)", "CNR", "Console"],
  },
  {
    model_code: "8030",
    name: "SOFFIO",
    // Excel: 1S 2S 3S 1NA 2NA 1A(L) 1A(R) 2A(L) 2A(R) L(L) L(R) STOOL CNR  (STOOL dropped)
    compartments: ["1S", "2S", "3S", "1NA", "2NA", "1A(LHF)", "1A(RHF)", "2A(LHF)", "2A(RHF)", "L(LHF)", "L(RHF)", "CNR"],
  },
  {
    model_code: "9028",
    name: "VERANO",
    // Excel: 1S 2S 3S 1NA 2NA 1A(L) 1A(R) 2A(L) 2A(R) L(L) L(R) STOOL CNR  (STOOL dropped)
    compartments: ["1S", "2S", "3S", "1NA", "2NA", "1A(LHF)", "1A(RHF)", "2A(LHF)", "2A(RHF)", "L(LHF)", "L(RHF)", "CNR"],
  },
  {
    model_code: "5531",
    name: "5531",
    // Excel: 1S 2S 3S 1NA 2NA 1A(L) 1A(R) 2A(L) 2A(R) L(L) L(R) CNR
    compartments: ["1S", "2S", "3S", "1NA", "2NA", "1A(LHF)", "1A(RHF)", "2A(LHF)", "2A(RHF)", "L(LHF)", "L(RHF)", "CNR"],
  },
  {
    model_code: "5535",
    name: "5535",
    // Excel: 1S 2S 3S 1NA 2NA 1A(L) 1A(R) 2A(L) 2A(R) L(L) L(R) CNR
    compartments: ["1S", "2S", "3S", "1NA", "2NA", "1A(LHF)", "1A(RHF)", "2A(LHF)", "2A(RHF)", "L(LHF)", "L(RHF)", "CNR"],
  },
  {
    model_code: "8038",
    name: "DISCOVERY",
    // Excel: 1S 2S 3S 1NA 2NA 1A(L) 1A(R) 2A(L) 2A(R) L(L) L(R) STOOL CNR  (STOOL dropped)
    compartments: ["1S", "2S", "3S", "1NA", "2NA", "1A(LHF)", "1A(RHF)", "2A(LHF)", "2A(RHF)", "L(LHF)", "L(RHF)", "CNR"],
  },
  {
    model_code: "8050",
    name: "LAZIO",
    // Excel: 1S 2S 3S 1NA 2NA 1A(L) 1A(R) 2A(L) 2A(R) 2L(L) L(R) STOOL CNR  (2L(L)->L(LHF), STOOL dropped)
    compartments: ["1S", "2S", "3S", "1NA", "2NA", "1A(LHF)", "1A(RHF)", "2A(LHF)", "2A(RHF)", "L(LHF)", "L(RHF)", "CNR"],
  },
  {
    model_code: "8051",
    name: "PRESTIGE",
    // Excel: 1S 2S 3S 1NA 2NA 1A(L) 1A(R) 2A(L) 2A(R) 2L(L) L(R) STOOL CNR  (2L(L)->L(LHF), STOOL dropped)
    compartments: ["1S", "2S", "3S", "1NA", "2NA", "1A(LHF)", "1A(RHF)", "2A(LHF)", "2A(RHF)", "L(LHF)", "L(RHF)", "CNR"],
  },
];

try {
  console.log(`${dry ? "[dry] " : ""}Houzs SOFA catalog re-seed — target scm schema\n`);

  // --- (1) INSERT the whole-seater 1S/2S/3S compartment_library rows ------
  // MUST run before the model upserts: the models reference these ids and
  // SKU minting FKs against compartment_library.id. Idempotent.
  // The 15 ids the pool ships with (2990 seed / mig 0022), used as a dry-run
  // fallback when the local DB is unreachable so --dry self-checks offline.
  const KNOWN_POOL_15 = [
    "1A(LHF)", "1A(RHF)", "1B(LHF)", "1B(RHF)", "1NA",
    "2A(LHF)", "2A(RHF)", "2B(LHF)", "2B(RHF)", "2NA",
    "CNR", "Console", "L(LHF)", "L(RHF)", "STOOL",
  ];
  let poolBefore;
  try {
    poolBefore = (await sql`SELECT id FROM scm.compartment_library`).map((r) => r.id);
  } catch (e) {
    if (!dry) throw e; // a real run MUST read the live pool
    poolBefore = KNOWN_POOL_15;
    console.log(`  [dry] DB unreachable (${e.message}); using known 15-id pool fallback.`);
  }
  const missingSeaters = SEATERS.filter((s) => !poolBefore.includes(s.id));
  console.log(`scm.compartment_library pool size : ${poolBefore.length}`);
  console.log(
    `  Whole-seater rows to add          : ${missingSeaters.length === 0 ? "none (all present)" : missingSeaters.map((s) => s.id).join(", ")}`
  );
  for (const s of SEATERS) {
    console.log(
      `  ${dry ? "[dry] " : ""}${poolBefore.includes(s.id) ? "exists " : "ADD    "}${s.id.padEnd(3)} ` +
        `comp_group=${s.comp_group} label="${s.label}" ${s.width_cm}x${s.depth_cm} is_accessory=${s.is_accessory}`
    );
  }
  if (!dry) {
    for (const s of SEATERS) {
      await sql`
        INSERT INTO scm.compartment_library
          (id, comp_group, label, width_cm, depth_cm, cushions, default_price, art_filename, is_accessory, sort_order)
        VALUES
          (${s.id}, ${s.comp_group}::scm.comp_group, ${s.label}, ${s.width_cm}, ${s.depth_cm},
           ${s.cushions}, ${s.default_price}, ${s.art_filename}, ${s.is_accessory}, ${s.sort_order})
        ON CONFLICT (id) DO NOTHING`;
    }
  }

  // Post-insert pool = existing pool + the seaters we (would) add. Validate
  // EVERY model compartment id resolves against it before touching anything.
  const poolAfter = new Set([...poolBefore, ...SEATERS.map((s) => s.id)]);
  const badRefs = [];
  for (const m of MODELS) {
    for (const comp of m.compartments) {
      if (!poolAfter.has(comp)) badRefs.push(`${m.model_code}:${comp}`);
    }
  }
  if (badRefs.length > 0) {
    throw new Error(`compartment id(s) not in post-insert pool: ${badRefs.join(", ")}`);
  }
  console.log(
    `  Pool after seaters                : ${poolAfter.size} ids — all ${MODELS.reduce((n, m) => n + m.compartments.length, 0)} model compartment refs valid.`
  );

  // --- (2) DELETE the wrong per-section SOFA SKUs -------------------------
  let before, orphan;
  try {
    before = await sql`SELECT count(*)::int AS n FROM scm.mfg_products WHERE category = 'SOFA'`;
    orphan = await sql`SELECT count(*)::int AS n FROM scm.mfg_products WHERE category = 'SOFA' AND model_id IS NULL`;
  } catch (e) {
    if (!dry) throw e;
    before = [{ n: "?" }];
    orphan = [{ n: "?" }];
    console.log(`\n  [dry] DB unreachable (${e.message}); SOFA row counts unknown.`);
  }
  console.log(`\nscm.mfg_products SOFA rows present : ${before[0].n} (model_id NULL: ${orphan[0].n})`);

  if (dry) {
    console.log(`  [dry] WOULD DELETE ${before[0].n} scm.mfg_products SOFA row(s).`);
  } else {
    const del = await sql`DELETE FROM scm.mfg_products WHERE category = 'SOFA'`;
    console.log(`  DELETED ${del.count} scm.mfg_products SOFA row(s).`);
  }

  // --- (3) INSERT one product_models row per MODEL (no price) -------------
  console.log(`\n${dry ? "[dry] " : ""}Seeding ${MODELS.length} SOFA model(s) into scm.product_models:`);
  for (const m of MODELS) {
    console.log(
      `  ${dry ? "[dry] " : ""}${m.model_code.padEnd(5)}  name="${m.name}"  branding="${BRANDING}"  ` +
        `compartments[${m.compartments.length}]=${JSON.stringify(m.compartments)}`
    );
  }

  let inserted = 0,
    updated = 0;
  if (!dry) {
    for (const m of MODELS) {
      const allowed = { compartments: m.compartments };
      // Idempotent upsert on (category, model_code). No price columns exist
      // on product_models — pricing is separate (seat_height_prices on the
      // generated mfg_products SKUs, task #84), so nothing price-related is
      // written here.
      const rows = await sql`
        INSERT INTO scm.product_models (branding, model_code, name, category, allowed_options, active)
        VALUES (${BRANDING}, ${m.model_code}, ${m.name}, 'SOFA', ${sql.json(allowed)}, true)
        ON CONFLICT (category, model_code) DO UPDATE
          SET branding        = EXCLUDED.branding,
              name            = EXCLUDED.name,
              allowed_options = EXCLUDED.allowed_options,
              active          = true,
              updated_at      = now()
        RETURNING (xmax = 0) AS inserted`;
      if (rows[0]?.inserted) inserted++;
      else updated++;
    }
  }

  console.log(
    `\n${dry ? "[dry] " : ""}Summary: deleted_skus=${dry ? before[0].n + " (planned)" : before[0].n} ` +
      `models_inserted=${dry ? "0 (planned " + MODELS.length + ")" : inserted} ` +
      `models_updated=${dry ? "-" : updated}`
  );

  if (dry) {
    console.log(
      `\n[dry] No writes performed. Re-run without --dry to apply, then run\n` +
        `      POST /product-models/:id/generate-skus per model to mint the SKUs.`
    );
  } else {
    const after = await sql`SELECT model_code, name FROM scm.product_models WHERE category = 'SOFA' ORDER BY model_code`;
    console.log(`\nscm.product_models SOFA rows now : ${after.length}`);
    console.log(
      `Next step: POST /product-models/:id/generate-skus for each of the ${after.length} models to mint per-section SKUs.`
    );
  }
} catch (e) {
  console.error("ERROR:", e.message);
  process.exitCode = 2;
} finally {
  await sql.end({ timeout: 5 }).catch(() => {});
}
