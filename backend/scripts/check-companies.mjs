#!/usr/bin/env node
// READ-ONLY: why is the company switcher hidden? Dumps the companies master +
// user_companies grants so we can see whether /api/companies would return >1.
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
async function main() {
  const cos = await sql`SELECT id, code, name, is_active FROM public.companies ORDER BY id`;
  console.log("COMPANIES:", JSON.stringify(cos));
  console.log("ACTIVE_COUNT:", cos.filter((c) => Number(c.is_active) === 1).length);
  let ucCount = 0, grants = [];
  try {
    ucCount = Number((await sql`SELECT count(*)::int AS n FROM public.user_companies`)[0].n);
    grants = await sql`SELECT user_id, company_id FROM public.user_companies ORDER BY user_id LIMIT 30`;
  } catch (e) { console.log("USER_COMPANIES_ERR:", e.message); }
  console.log("USER_COMPANIES_ROWS:", ucCount);
  console.log("GRANTS_SAMPLE:", JSON.stringify(grants));
  // per-user grant counts (a user with grants to only 1 company => switcher hidden by the #404 filter)
  try {
    const byUser = await sql`SELECT user_id, count(*)::int AS n FROM public.user_companies GROUP BY user_id HAVING count(*) = 1 LIMIT 30`;
    console.log("USERS_GRANTED_ONLY_ONE:", JSON.stringify(byUser));
  } catch {}
}
main().then(() => sql.end()).catch(async (e) => { console.error("FAIL", e.message); await sql.end(); process.exit(1); });
