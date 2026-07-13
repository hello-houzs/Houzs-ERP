import postgres from "postgres";
const url = process.env.DATABASE_URL;
if (!url) { console.error("no url"); process.exit(2); }
const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });
const MASTERS = ['suppliers','products','customers','accounts','warehouses','product_models','product_fabrics','product_size_variants','pwp_codes','special_addons'];
try {
  const uni = await pg`SELECT tc.table_name AS t, tc.constraint_name AS c, string_agg(kcu.column_name, ',' ORDER BY kcu.ordinal_position) AS cols FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON kcu.constraint_name=tc.constraint_name AND kcu.constraint_schema=tc.constraint_schema WHERE tc.constraint_schema='scm' AND tc.constraint_type='UNIQUE' AND tc.table_name = ANY(${MASTERS}) GROUP BY 1,2 ORDER BY 1,2`;
  console.log("UNIQUE_START");
  for (const r of uni) console.log(`UNI ${r.t} (${r.cols}) name=${r.c}`);
  console.log("UNIQUE_END");
  const fk = await pg`SELECT tc.table_name AS child, kcu.column_name AS child_col, ccu.table_name AS parent, ccu.column_name AS parent_col FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON kcu.constraint_name=tc.constraint_name AND kcu.constraint_schema=tc.constraint_schema JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name=tc.constraint_name AND ccu.constraint_schema=tc.constraint_schema WHERE tc.constraint_schema='scm' AND tc.constraint_type='FOREIGN KEY' AND ccu.table_name = ANY(${MASTERS}) AND ccu.column_name <> 'id' ORDER BY 1`;
  console.log("FKCODE_START");
  for (const r of fk) console.log(`FK ${r.child}.${r.child_col} -> ${r.parent}.${r.parent_col}`);
  console.log("FKCODE_END");
} catch (e) { console.error("CFAIL", e.message); process.exitCode = 1; }
finally { await pg.end({ timeout: 5 }); }
