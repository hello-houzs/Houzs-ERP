import postgres from "postgres";
const url = process.env.DATABASE_URL;
if (!url) { console.error("no url"); process.exit(2); }
const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });
try {
  const co = await pg`SELECT id, code, name FROM companies ORDER BY id`;
  console.log("COMPANIES", JSON.stringify(co));
  const chk = await pg`SELECT count(*) AS n FROM information_schema.columns WHERE table_schema='scm' AND column_name='company_id'`;
  console.log("SCM_TABLES_WITH_company_id", chk[0].n);
  for (const v of ['mfg_sales_orders_with_payment_totals','suppliers_with_derived_category','inventory_balances']) {
    const hc = await pg`SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='scm' AND table_name=${v} AND column_name='company_id') AS h`;
    let ok='?'; try { await pg.unsafe(`SELECT company_id FROM scm.${v} LIMIT 1`); ok='SELECT_OK'; } catch(e){ ok='SELECT_FAIL '+e.message; }
    console.log("VIEW", v, "has_company_id="+hc[0].h, ok);
  }
  const uc = await pg`SELECT to_regclass('public.user_companies') AS t`;
  console.log("user_companies", uc[0].t);
  console.log("VERIFY_DONE");
} catch(e){ console.error("VERIFY_FAIL", e.message); process.exitCode=1; }
finally { await pg.end({timeout:5}); }
