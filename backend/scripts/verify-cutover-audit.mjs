#!/usr/bin/env node
// Post-flip data-integrity audit (A1..A3, read-only).
// Owner sighting 2026-07-22 — after the 07-21 flip + mig 0164 (upsert_customer
// company scope) + PR #990 (assr scope) + PR #744 (staff picker), verify no
// data on prod was mis-bound during the window BEFORE those fixes landed.
//
// A1 — cross-company customer binding: any SO whose SO.company_id disagrees
//      with its bound customer's company_id (the mig 0164 bug class).
// A2 — product_fabrics dangling: any pf.fabric_id that doesn't resolve to a
//      fabric_library row (same class as the psv bug fixed 07-21).
// A3 — mig 0091 default-company bleed: any SO created by a 2990-only staff
//      that landed under Houzs's company_id (the "created_by ∈ 2990-only,
//      company_id defaulted to Houzs" class).
//
// DRY-RUN ONLY. No UPDATE/DELETE anywhere — findings are printed for the owner
// to decide fixes on. Idempotent.
import postgres from "postgres";
const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const db = postgres(DST, { ssl: "require", prepare: false, max: 1 });

async function main() {
  const cos = await db`SELECT id, code FROM companies WHERE code IN ('HOUZS','2990') ORDER BY code`;
  const cidHouzs = cos.find(r => r.code === "HOUZS")?.id;
  const cid2990 = cos.find(r => r.code === "2990")?.id;
  if (!cidHouzs || !cid2990) throw new Error(`companies missing: got ${JSON.stringify(cos)}`);
  console.log(`companies: HOUZS=${cidHouzs} 2990=${cid2990}`);
  const flip = "2026-07-21";

  // ─── A1 ──────────────────────────────────────────────────────────────
  // Every SO since flip WHERE SO.company_id != customer.company_id.
  // (Both sides company_id NOT NULL. If customer.company_id IS NULL, that's
  // a separate class — not this audit.)
  console.log("\n=== A1 · cross-company customer binding ===");
  const a1Rows = await db`
    SELECT
      so.company_id AS so_company,
      c.company_id  AS customer_company,
      count(*)::int AS n
    FROM scm.mfg_sales_orders so
    JOIN scm.customers c ON c.id = so.customer_id
    WHERE so.created_at >= ${flip}::date
      AND so.customer_id IS NOT NULL
      AND c.company_id IS NOT NULL
      AND so.company_id IS NOT NULL
      AND so.company_id <> c.company_id
    GROUP BY so.company_id, c.company_id
    ORDER BY n DESC`;
  if (a1Rows.length === 0) {
    console.log("A1 PASS — no mismatched SO↔customer company bindings since flip");
  } else {
    console.log(`A1 FAIL — ${a1Rows.length} mismatched buckets:`);
    for (const r of a1Rows) console.log(`  so.company=${r.so_company}  customer.company=${r.customer_company}  n=${r.n}`);
    // Also print a small sample of doc_no for the owner to eyeball
    const a1Sample = await db`
      SELECT so.doc_no, so.company_id AS so_c, c.company_id AS cust_c, c.name AS customer_name, so.created_at
      FROM scm.mfg_sales_orders so
      JOIN scm.customers c ON c.id = so.customer_id
      WHERE so.created_at >= ${flip}::date
        AND so.company_id IS NOT NULL AND c.company_id IS NOT NULL
        AND so.company_id <> c.company_id
      ORDER BY so.created_at
      LIMIT 20`;
    console.log("A1 sample (up to 20):");
    for (const r of a1Sample) console.log(`  ${r.doc_no}  so=${r.so_c} cust=${r.cust_c}  ${r.customer_name}  ${r.created_at.toISOString().slice(0,19)}`);
  }

  // ─── A2 ──────────────────────────────────────────────────────────────
  // product_fabrics.fabric_id dangling (same class as psv bug).
  // Report both companies + summarise so we can see if the 2990 verbatim-id
  // importer leaked the same dangling pattern into fabrics.
  console.log("\n=== A2 · product_fabrics dangling probe ===");
  const pfExists = await db`SELECT to_regclass('scm.product_fabrics')::text AS t`;
  if (!pfExists[0].t) {
    console.log("A2 SKIP — scm.product_fabrics does not exist");
  } else {
    const flExists = await db`SELECT to_regclass('scm.fabric_library')::text AS t`;
    if (!flExists[0].t) {
      console.log("A2 SKIP — scm.fabric_library does not exist");
    } else {
      // Two probes: same-company match (strict) and any-match (lenient — some
      // codebases treat fabric_library as SHARED across companies).
      const a2 = await db`
        SELECT
          pf.company_id AS company,
          count(*)::int AS total,
          count(*) FILTER (
            WHERE NOT EXISTS (
              SELECT 1 FROM scm.fabric_library f
              WHERE f.id = pf.fabric_id AND f.company_id = pf.company_id)
          )::int AS same_company_missing,
          count(*) FILTER (
            WHERE NOT EXISTS (SELECT 1 FROM scm.fabric_library f WHERE f.id = pf.fabric_id)
          )::int AS any_company_missing
        FROM scm.product_fabrics pf
        GROUP BY pf.company_id
        ORDER BY pf.company_id`;
      for (const r of a2) console.log(`  company=${r.company}  total=${r.total}  same-company-missing=${r.same_company_missing}  any-company-missing=${r.any_company_missing}`);
      const worst = a2.find(r => r.any_company_missing > 0);
      if (!worst) console.log("A2 PASS — no dangling product_fabrics.fabric_id");
      else console.log(`A2 FLAG — ${worst.any_company_missing} rows in company_${worst.company} have NO fabric_library row anywhere; ownership needs a hand-decision (delete vs re-map)`);
    }
  }

  // ─── A3 ──────────────────────────────────────────────────────────────
  // mig 0091 company_id default bleed: 2990-only staff creating SOs since
  // flip. Their SO.company_id MUST be cid2990. Anything else = bleed.
  //
  // "2990-only staff" = a public.users row whose user_companies grants are
  // exactly {2990} (no HOUZS grant). We JOIN scm.staff -> public.users on
  // staff.user_id (LINKED rows only — UNLINKED rows are receiver-side mirror
  // rows that shouldn't be creating SOs from the POS).
  console.log("\n=== A3 · mig 0091 company_id default bleed probe ===");
  const a3 = await db`
    WITH v_users AS (
      SELECT uc.user_id
      FROM public.user_companies uc
      GROUP BY uc.user_id
      HAVING bool_or(uc.company_id = ${cid2990}) AND NOT bool_or(uc.company_id = ${cidHouzs})
    ),
    v_staff AS (
      SELECT s.id AS staff_id, s.user_id
      FROM scm.staff s
      WHERE s.user_id IS NOT NULL
        AND s.user_id IN (SELECT user_id FROM v_users)
    )
    SELECT
      so.company_id,
      count(*)::int AS n,
      min(so.created_at) AS earliest,
      max(so.created_at) AS latest
    FROM scm.mfg_sales_orders so
    JOIN v_staff vs ON vs.staff_id = so.created_by
    WHERE so.created_at >= ${flip}::date
    GROUP BY so.company_id
    ORDER BY so.company_id`;
  if (a3.length === 0) {
    console.log("A3 INFO — no SOs created by 2990-only staff since flip (unusual; verify Scarlett etc. have been active)");
  } else {
    for (const r of a3) console.log(`  so.company_id=${r.company_id}  n=${r.n}  earliest=${r.earliest?.toISOString().slice(0,19)}  latest=${r.latest?.toISOString().slice(0,19)}`);
    const bleed = a3.filter(r => Number(r.company_id) !== Number(cid2990));
    if (bleed.length === 0) {
      console.log(`A3 PASS — all 2990-only staff SOs landed in company_${cid2990}`);
    } else {
      console.log(`A3 FAIL — ${bleed.reduce((s, r) => s + r.n, 0)} SOs from 2990-only staff landed in a NON-2990 company`);
      const a3Sample = await db`
        WITH v_users AS (
          SELECT uc.user_id
          FROM public.user_companies uc
          GROUP BY uc.user_id
          HAVING bool_or(uc.company_id = ${cid2990}) AND NOT bool_or(uc.company_id = ${cidHouzs})
        )
        SELECT so.doc_no, so.company_id, u.email, so.created_at
        FROM scm.mfg_sales_orders so
        JOIN scm.staff s ON s.id = so.created_by
        JOIN public.users u ON u.id = s.user_id
        WHERE s.user_id IN (SELECT user_id FROM v_users)
          AND so.created_at >= ${flip}::date
          AND so.company_id <> ${cid2990}
        ORDER BY so.created_at
        LIMIT 20`;
      console.log("A3 sample (up to 20):");
      for (const r of a3Sample) console.log(`  ${r.doc_no}  company=${r.company_id}  by=${r.email}  ${r.created_at.toISOString().slice(0,19)}`);
    }
  }

  // ─── Sanity summary ──────────────────────────────────────────────────
  console.log("\n=== SANITY summary ===");
  const totals = await db`
    SELECT company_id, count(*)::int AS n_since_flip
    FROM scm.mfg_sales_orders
    WHERE created_at >= ${flip}::date
    GROUP BY company_id
    ORDER BY company_id`;
  console.log(`SOs created since ${flip}:`);
  for (const r of totals) console.log(`  company_id=${r.company_id}  n=${r.n_since_flip}`);
}

main().then(() => db.end()).catch(async e => {
  console.error("AUDIT_FAIL", e.message);
  await db.end();
  process.exit(1);
});
