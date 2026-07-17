#!/usr/bin/env node
// TEMPORARY PROBE (branch diag/selling-price-probe -- NEVER MERGE).
// Replaces the Phase 2 import diagnostics only so the existing read-only
// diag-2990.yml workflow can carry one question to prod.
//
// THE QUESTION: why does the Houzs receiver return HTTP 500 for SO-2607-013?
//
// State (mirror-sentinel, 2026-07-17): source=63 mirrored=62. Six outbox rows
// for SO-2607-013 (header + 3 items + 1 payment + 1 update), enqueued
// 2026-07-16T04:39Z, attempts=6582, last_error='http 500'. 2990 is behaving
// correctly -- drain sends, confirm sees the 500, resets to pending, drain
// resends, forever. Houzs is rejecting it. `last_error` stores only the status,
// and the response body lives in 2990's net._http_response which PostgREST
// cannot reach, so the reason has to be derived.
//
// Design risk R3 predicted exactly this: a 2990 record created AFTER the frozen
// one-time master import references a parent that does not exist in Houzs -> FK
// violation -> 500 -> retry forever. The earlier FK audit came back CLEAN, but
// that audit only inspects rows ALREADY in Houzs -- a row that never landed has
// no dangling FK to find. It could not see this. So: resolve every FK target
// SO-2607-013 carries against Houzs and name the missing one.
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";

const SUPA_URL = process.env.SOURCE_SUPABASE_URL;
const SUPA_KEY = process.env.SOURCE_SERVICE_ROLE_KEY;
const DST = process.env.DATABASE_URL;
if (!SUPA_URL || !SUPA_KEY || !DST) {
  console.error("need SOURCE_SUPABASE_URL + SOURCE_SERVICE_ROLE_KEY + DATABASE_URL");
  process.exit(2);
}
const src = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false } });
const dst = postgres(DST, { ssl: "require", prepare: false, max: 1 });

const DOC = "SO-2607-013";

async function main() {
  // --- the source row, verbatim ---
  const { data: sos, error: soErr } = await src
    .from("mfg_sales_orders")
    .select("*")
    .eq("doc_no", DOC)
    .limit(1);
  if (soErr) throw new Error(`source SO: ${soErr.message}`);
  if (!sos?.length) {
    console.log(`SOURCE_MISSING -- ${DOC} not in 2990.mfg_sales_orders`);
    return;
  }
  const so = sos[0];
  console.log(`=== 2990 ${DOC} ===`);
  for (const [k, v] of Object.entries(so)) {
    if (v === null || v === "") continue;
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    console.log(`  ${k} = ${s.length > 90 ? s.slice(0, 90) + "..." : s}`);
  }

  // --- what the receiver will try to insert into, and what those columns FK to ---
  console.log("");
  console.log("=== Houzs scm.mfg_sales_orders FK targets ===");
  const fks = await dst`
    SELECT a.attname AS col, fn.nspname AS pns, fcl.relname AS parent, fa.attname AS pcol
      FROM pg_constraint c
      JOIN pg_class cl      ON cl.oid = c.conrelid
      JOIN pg_namespace n   ON n.oid = cl.relnamespace
      JOIN pg_class fcl     ON fcl.oid = c.confrelid
      JOIN pg_namespace fn  ON fn.oid = fcl.relnamespace
      JOIN unnest(c.conkey)  WITH ORDINALITY AS ck(attnum, ord) ON true
      JOIN unnest(c.confkey) WITH ORDINALITY AS fk(attnum, ord) ON fk.ord = ck.ord
      JOIN pg_attribute a   ON a.attrelid = cl.oid  AND a.attnum = ck.attnum
      JOIN pg_attribute fa  ON fa.attrelid = fcl.oid AND fa.attnum = fk.attnum
     WHERE c.contype = 'f' AND n.nspname = 'scm' AND cl.relname = 'mfg_sales_orders'`;
  if (!fks.length) console.log("  (none -- the DDL port dropped the FKs; a bad ref would be SILENT, not a 500)");

  let missing = 0;
  for (const f of fks) {
    const val = so[f.col];
    if (val === null || val === undefined || val === "") {
      console.log(`  ${f.col} -> ${f.pns}.${f.parent}.${f.pcol}  :: source NULL, skip`);
      continue;
    }
    const q = `SELECT count(*)::int AS n FROM "${f.pns}"."${f.parent}" WHERE "${f.pcol}"::text = $1`;
    let n;
    try {
      n = (await dst.unsafe(q, [String(val)]))[0].n;
    } catch (e) {
      console.log(`  ${f.col} -> ${f.pns}.${f.parent}.${f.pcol}  :: CHECK FAILED ${e.message}`);
      continue;
    }
    const verdict = n > 0 ? "ok" : "*** MISSING IN HOUZS ***";
    if (n === 0) missing++;
    console.log(`  ${f.col} = ${val}  ->  ${f.pns}.${f.parent}.${f.pcol}  :: ${verdict}`);
  }

  // --- the same for the child tables the receiver writes ---
  for (const child of ["mfg_sales_order_items", "mfg_sales_order_payments"]) {
    const { data: rows, error } = await src.from(child).select("*").eq("doc_no", DOC);
    if (error) {
      console.log(`\n${child}: SRC_ERR ${error.message}`);
      continue;
    }
    console.log(`\n=== ${child}: ${rows?.length ?? 0} source row(s) ===`);
    const cfks = await dst`
      SELECT a.attname AS col, fn.nspname AS pns, fcl.relname AS parent, fa.attname AS pcol
        FROM pg_constraint c
        JOIN pg_class cl      ON cl.oid = c.conrelid
        JOIN pg_namespace n   ON n.oid = cl.relnamespace
        JOIN pg_class fcl     ON fcl.oid = c.confrelid
        JOIN pg_namespace fn  ON fn.oid = fcl.relnamespace
        JOIN unnest(c.conkey)  WITH ORDINALITY AS ck(attnum, ord) ON true
        JOIN unnest(c.confkey) WITH ORDINALITY AS fk(attnum, ord) ON fk.ord = ck.ord
        JOIN pg_attribute a   ON a.attrelid = cl.oid  AND a.attnum = ck.attnum
        JOIN pg_attribute fa  ON fa.attrelid = fcl.oid AND fa.attnum = fk.attnum
       WHERE c.contype = 'f' AND n.nspname = 'scm' AND cl.relname = ${child}`;
    const seen = new Set();
    for (const r of rows ?? []) {
      for (const f of cfks) {
        const val = r[f.col];
        if (val === null || val === undefined || val === "") continue;
        const key = `${f.col}:${val}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const q = `SELECT count(*)::int AS n FROM "${f.pns}"."${f.parent}" WHERE "${f.pcol}"::text = $1`;
        let n;
        try {
          n = (await dst.unsafe(q, [String(val)]))[0].n;
        } catch (e) {
          console.log(`  ${f.col} -> ${f.parent}  :: CHECK FAILED ${e.message}`);
          continue;
        }
        if (n === 0) missing++;
        console.log(`  ${f.col} = ${val}  ->  ${f.pns}.${f.parent}.${f.pcol}  :: ${n > 0 ? "ok" : "*** MISSING IN HOUZS ***"}`);
      }
    }
  }

  // --- column drift: does Houzs have every column 2990 is sending? ---
  console.log("");
  const cols = await dst`
    SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
     WHERE table_schema='scm' AND table_name='mfg_sales_orders'`;
  const have = new Set(cols.map((c) => c.column_name));
  const extra = Object.keys(so).filter((k) => !have.has(k));
  console.log(`column drift: 2990 sends ${Object.keys(so).length}, Houzs has ${have.size}`);
  console.log(`  columns 2990 sends that Houzs LACKS (receiver drops these): ${extra.length ? extra.join(", ") : "(none)"}`);
  const notNullNoDefault = cols.filter(
    (c) => c.is_nullable === "NO" && !["doc_no", "company_id"].includes(c.column_name) && !(c.column_name in so),
  );
  console.log(
    `  Houzs NOT NULL columns absent from the source payload: ${
      notNullNoDefault.length ? notNullNoDefault.map((c) => c.column_name).join(", ") : "(none)"
    }`,
  );

  console.log("");
  console.log(missing > 0 ? `VERDICT: ${missing} FK target(s) MISSING in Houzs -- that is the 500.` : "VERDICT: every FK resolves. The 500 is NOT a missing parent -- look at column drift / NOT NULL / a CHECK.");
}

main()
  .then(() => dst.end({ timeout: 5 }))
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error("FAIL", e.message);
    await dst.end({ timeout: 5 }).catch(() => {});
    process.exit(1);
  });
