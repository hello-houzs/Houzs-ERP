#!/usr/bin/env node
// Phase 2 diagnostics — READ-ONLY. Explains src-vs-imported gaps (series 7->3)
// and audits dangling FKs on company_id=2990 rows (load ran with FK checks off).
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";
const SUPA_URL = process.env.SOURCE_SUPABASE_URL, SUPA_KEY = process.env.SOURCE_SERVICE_ROLE_KEY, DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const dst = postgres(DST, { ssl: "require", prepare: false, max: 1 });

async function main() {
  const cidRow = await dst`SELECT id FROM companies WHERE code='2990'`;
  const cid = Number(cidRow[0].id);
  console.log(`2990 company_id=${cid}`);

  console.log("=== scm.series constraints ===");
  const cons = await dst`SELECT conname, pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_class cl ON cl.oid=c.conrelid JOIN pg_namespace n ON n.oid=cl.relnamespace WHERE n.nspname='scm' AND cl.relname='series'`;
  for (const r of cons) console.log(`${r.conname}: ${r.def}`);

  console.log("=== dest scm.series rows ===");
  const destSeries = await dst.unsafe("SELECT * FROM scm.series ORDER BY id");
  for (const r of destSeries) console.log(JSON.stringify(r));

  if (SUPA_URL && SUPA_KEY) {
    console.log("=== source (2990) series rows ===");
    const src = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false } });
    const { data, error } = await src.schema("public").from("series").select("*");
    if (error) console.log("SRC_ERR " + error.message);
    else for (const r of data) console.log(JSON.stringify(r));
  }

  console.log("=== dangling-FK audit on company_id=2990 rows (scm, single-col FKs) ===");
  const fks = await dst`
    SELECT c.conname, cl.relname AS child, a.attname AS col, fn.nspname AS pns, fcl.relname AS parent, fa.attname AS pcol
    FROM pg_constraint c
    JOIN pg_class cl ON cl.oid=c.conrelid
    JOIN pg_namespace n ON n.oid=cl.relnamespace
    JOIN pg_class fcl ON fcl.oid=c.confrelid
    JOIN pg_namespace fn ON fn.oid=fcl.relnamespace
    CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY k(attnum,ord)
    JOIN pg_attribute a ON a.attrelid=cl.oid AND a.attnum=k.attnum
    CROSS JOIN LATERAL unnest(c.confkey) WITH ORDINALITY fk(attnum,ord2)
    JOIN pg_attribute fa ON fa.attrelid=fcl.oid AND fa.attnum=fk.attnum AND fk.ord2=k.ord
    WHERE c.contype='f' AND n.nspname='scm' AND array_length(c.conkey,1)=1`;
  let bad = 0;
  for (const f of fks) {
    const hasCid = await dst`SELECT 1 FROM information_schema.columns WHERE table_schema='scm' AND table_name=${f.child} AND column_name='company_id'`;
    if (!hasCid.length) continue;
    const q = `SELECT count(*)::int AS n FROM scm."${f.child}" t WHERE t.company_id=${cid} AND t."${f.col}" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "${f.pns}"."${f.parent}" p WHERE p."${f.pcol}" = t."${f.col}")`;
    let n; try { n = (await dst.unsafe(q))[0].n; } catch (e) { console.log(`ERR ${f.child}.${f.col}: ${e.message}`); continue; }
    if (n > 0) { bad += n; console.log(`DANGLING ${f.child}.${f.col} -> ${f.parent}.${f.pcol}: ${n} rows`); }
  }
  console.log(bad === 0 ? "FK_AUDIT_CLEAN" : `FK_AUDIT_TOTAL_DANGLING=${bad}`);

  console.log("=== unprefixed doc-ref scan (text cols named like doc refs, company=2990 rows) ===");
  const tabs = await dst`SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema='scm' AND column_name='company_id'`;
  let hits = 0;
  for (const { table_name: t } of tabs) {
    const cols = await dst`SELECT column_name FROM information_schema.columns WHERE table_schema='scm' AND table_name=${t} AND data_type IN ('text','character varying') AND (column_name LIKE '%doc_no%' OR column_name LIKE '%\\_number%' OR column_name LIKE '%reference%')`;
    for (const { column_name: c } of cols) {
      const q = `SELECT count(*)::int AS n, min("${c}") AS sample FROM scm."${t}" WHERE company_id=${cid} AND "${c}" IS NOT NULL AND "${c}" NOT LIKE '2990-%'`;
      try { const [r] = await dst.unsafe(q); if (r.n > 0) { hits += r.n; console.log(`UNPREFIXED ${t}.${c}: ${r.n} (e.g. ${r.sample})`); } } catch {}
    }
  }
  console.log(hits === 0 ? "DOCREF_SCAN_CLEAN" : `DOCREF_SCAN_HITS=${hits} (judge each: internal doc refs need prefix, external/supplier numbers do not)`);

  console.log("=== company separation: per-table row counts (c1 | c2 | NULL) ===");
  const scoped = await dst`SELECT t.table_name FROM information_schema.tables t WHERE t.table_schema='scm' AND t.table_type='BASE TABLE' AND EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema='scm' AND c.table_name=t.table_name AND c.column_name='company_id') ORDER BY t.table_name`;
  let nullTagged = 0;
  for (const { table_name: t } of scoped) {
    const [r] = await dst.unsafe(`SELECT count(*) FILTER (WHERE company_id=1)::int AS c1, count(*) FILTER (WHERE company_id=2)::int AS c2, count(*) FILTER (WHERE company_id IS NULL)::int AS cn FROM scm."${t}"`);
    if (r.c1 + r.c2 + r.cn > 0) console.log(`${t}: ${r.c1} | ${r.c2} | ${r.cn}`);
    if (r.cn > 0) { nullTagged += r.cn; console.log(`NULL_COMPANY ${t}: ${r.cn} rows untagged`); }
  }
  console.log(nullTagged === 0 ? "NULL_TAG_CLEAN" : `NULL_TAG_TOTAL=${nullTagged}`);

  console.log("=== cross-company FK leak scan (child company_id <> parent company_id) ===");
  let leaks = 0;
  for (const f of fks) {
    const bothScoped = await dst`SELECT (SELECT count(*) FROM information_schema.columns WHERE table_schema='scm' AND table_name=${f.child} AND column_name='company_id')::int + (SELECT count(*) FROM information_schema.columns WHERE table_schema=${f.pns} AND table_name=${f.parent} AND column_name='company_id')::int AS n`;
    if (Number(bothScoped[0].n) !== 2) continue;
    const q = `SELECT count(*)::int AS n FROM scm."${f.child}" t JOIN "${f.pns}"."${f.parent}" p ON p."${f.pcol}" = t."${f.col}" WHERE t."${f.col}" IS NOT NULL AND t.company_id IS DISTINCT FROM p.company_id`;
    try { const [r] = await dst.unsafe(q); if (r.n > 0) { leaks += r.n; console.log(`XLEAK ${f.child}.${f.col} -> ${f.pns}.${f.parent}: ${r.n} rows cross-company`); } } catch (e) { console.log(`ERR xleak ${f.child}.${f.col}: ${e.message}`); }
  }
  console.log(leaks === 0 ? "XCOMPANY_CLEAN" : `XCOMPANY_TOTAL=${leaks} (known exception: products.series_id -> shared seeded series)`);
}
main().then(() => dst.end()).catch(async e => { console.error("DIAG_FAIL", e.message); await dst.end(); process.exit(1); });
