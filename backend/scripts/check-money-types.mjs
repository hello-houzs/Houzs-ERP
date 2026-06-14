// Read-only: what integer types did the loader create for money/amount columns
// in the live SG DB? int4/int2 = real overflow risk (needs ALTER to bigint).
import { readFileSync } from "node:fs";
import postgres from "postgres";
const url = readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)[1];
const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

const all = await pg`
  SELECT table_name, column_name, data_type
    FROM information_schema.columns
   WHERE table_schema='public'
   ORDER BY table_name, column_name`;

const moneyish = /(amount|total|balance|_sen|cents|cost|price|rental|fee|pct|revenue|sales|freight|charge|deposit|budget|qty|quantity)/i;
const risky = all.filter(
  (r) => moneyish.test(r.column_name) && (r.data_type === "integer" || r.data_type === "smallint"),
);

console.log(`money-ish int4/int2 columns (overflow risk): ${risky.length}`);
const byTable = {};
for (const r of risky) (byTable[r.table_name] ??= []).push(`${r.column_name}(${r.data_type})`);
for (const [t, cols] of Object.entries(byTable)) console.log(`  ${t}: ${cols.join(", ")}`);

const counts = all.reduce((m, r) => ((m[r.data_type] = (m[r.data_type] || 0) + 1), m), {});
console.log(`\ntype histogram:`, JSON.stringify(counts));
await pg.end();
