// READ-ONLY: sample actual stored phone values after the backfill, so we can
// see the real E.164 form in the database rather than trusting a screen.
import { readFileSync } from "node:fs";
import postgres from "postgres";
function url(){ if(process.env.DATABASE_URL)return process.env.DATABASE_URL;
  try{return readFileSync(".dev.vars","utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];}catch{return undefined;} }
const u=url(); if(!u){console.error("no DATABASE_URL");process.exit(1);}
const notice=(m)=>console.log(process.env.GITHUB_ACTIONS?`::notice::${m}`:m);
const pg=postgres(u,{ssl:"require",prepare:false,max:1});
try{
  const u1=await pg`SELECT name, phone FROM users WHERE phone IS NOT NULL AND btrim(phone)<>'' ORDER BY id LIMIT 8`;
  notice("── users (staff):");
  for(const r of u1) notice(`   ${r.name}: ${r.phone}`);
  const c1=await pg`SELECT creditor_code, company_name, phone1 FROM creditors WHERE phone1 IS NOT NULL AND btrim(phone1)<>'' ORDER BY creditor_code LIMIT 8`;
  notice("── creditors (suppliers):");
  for(const r of c1) notice(`   ${r.creditor_code} ${r.company_name}: ${r.phone1}`);
  // the four China suppliers specifically
  const cn=await pg`SELECT creditor_code, phone1 FROM creditors WHERE creditor_code IN ('400-C005','400-J002','405-N001','400-N003')`;
  notice("── the 4 China suppliers (should be +86):");
  for(const r of cn) notice(`   ${r.creditor_code}: ${r.phone1}`);
  // counts: how many now start with +
  const pct=await pg`SELECT
    count(*) FILTER (WHERE phone IS NOT NULL AND btrim(phone)<>'' AND left(btrim(phone),1)='+')::int AS with_plus,
    count(*) FILTER (WHERE phone IS NOT NULL AND btrim(phone)<>'')::int AS total
    FROM users`;
  notice(`── users with a leading +: ${pct[0].with_plus} / ${pct[0].total}`);
} finally { await pg.end({timeout:5}); }
