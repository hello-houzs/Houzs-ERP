// READ-ONLY: how far did the phone backfill get? Reads the backup table it
// writes to before each UPDATE, so this shows real progress even while the
// apply is still running (or after it was cancelled).
import { readFileSync } from "node:fs";
import postgres from "postgres";
function resolveUrl(){ if(process.env.DATABASE_URL)return process.env.DATABASE_URL;
  try{return readFileSync(".dev.vars","utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];}catch{return undefined;} }
const url=resolveUrl(); if(!url){console.error("no DATABASE_URL");process.exit(1);}
const notice=(m)=>console.log(process.env.GITHUB_ACTIONS?`::notice::${m}`:m);
const pg=postgres(url,{ssl:"require",prepare:false,max:1});
try{
  const exists=await pg`SELECT to_regclass('public.phone_normalisation_backup') AS t`;
  if(!exists[0].t){ notice("backup table does NOT exist yet — apply has not written anything."); }
  else {
    const byRun=await pg`SELECT run_id, count(*)::int AS n, min(applied_at) AS started, max(applied_at) AS last
      FROM phone_normalisation_backup GROUP BY run_id ORDER BY max(applied_at) DESC LIMIT 5`;
    for(const r of byRun) notice(`run ${r.run_id}: ${r.n} rows backed-up+updated, ${r.started} → ${r.last}`);
    const byCol=await pg`SELECT table_name, column_name, count(*)::int AS n
      FROM phone_normalisation_backup GROUP BY table_name, column_name ORDER BY 1,2`;
    for(const r of byCol) notice(`   ${r.table_name}.${r.column_name}: ${r.n}`);
  }
} finally { await pg.end({timeout:5}); }
