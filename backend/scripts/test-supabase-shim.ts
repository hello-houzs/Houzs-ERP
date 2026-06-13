// Live validation of the D1-compat shim + dialect rewrites against the real
// Supabase database. Read-only for real tables; all writes go to a session
// TEMP table that vanishes on disconnect. Run: npx tsx scripts/test-supabase-shim.ts
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { d1Compat } from "../src/db/d1-compat";

// Pull DATABASE_URL out of .dev.vars (KEY="value" lines).
const devVars = readFileSync(".dev.vars", "utf8");
const url = (devVars.match(/^\s*DATABASE_URL\s*=\s*"?([^"\n]+)"?/m) || [])[1];
if (!url) throw new Error("DATABASE_URL not found in .dev.vars");

// ssl:"require" mirrors the proven migration scripts — this machine's CA store
// can't verify the pooler chain, and prod uses Hyperdrive (no driver TLS), so
// chain validation is irrelevant to what we're testing (SQL dialect).
const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });
const DB = d1Compat(() => sql);

let pass = 0;
let fail = 0;
async function check(name: string, fn: () => Promise<unknown>) {
  try {
    const r = await fn();
    console.log(`  PASS  ${name}  ->  ${JSON.stringify(r)?.slice(0, 110)}`);
    pass++;
  } catch (e) {
    console.log(`  FAIL  ${name}  ->  ${(e as Error).message?.slice(0, 200)}`);
    fail++;
  }
}

async function main() {
  console.log("\n— connectivity —");
  await check("SELECT 1", () => DB.prepare("SELECT 1 AS one").first());

  console.log("\n— read-side dialect (real tables) —");
  await check("julianday diff (assr_cases age)", () =>
    DB.prepare(
      `SELECT COUNT(*) AS n,
              ROUND(AVG(julianday('now') - julianday(created_at))::numeric, 1) AS avg_age_days
         FROM assr_cases`,
    ).first(),
  );
  await check("date('now','-N days') filter", () =>
    DB.prepare(
      `SELECT COUNT(*) AS n FROM assr_cases
        WHERE COALESCE(complained_date, created_at) >= date('now', '-3650 days')`,
    ).first(),
  );
  await check("strftime('%Y-%m') group", () =>
    DB.prepare(
      `SELECT strftime('%Y-%m', created_at) AS ym, COUNT(*) AS n
         FROM assr_cases GROUP BY ym ORDER BY ym DESC LIMIT 3`,
    ).all(),
  );
  await check("datetime('now')", () =>
    DB.prepare(`SELECT datetime('now') AS now_ts`).first(),
  );
  await check("instr -> strpos", () =>
    DB.prepare(`SELECT instr('sofa bed', 'bed') AS pos`).first(),
  );
  await check("string_agg(chr(31)) (GROUP_CONCAT repl)", () =>
    DB.prepare(
      `SELECT string_agg(x, chr(31)) AS j FROM (VALUES ('a'),('b'),('c')) t(x)`,
    ).first(),
  );
  await check("project sales_per_day julianday rewrite", () =>
    DB.prepare(
      `SELECT COUNT(*) AS n FROM projects
        WHERE start_date IS NOT NULL AND end_date IS NOT NULL
          AND end_date::timestamptz >= start_date::timestamptz`,
    ).first(),
  );

  console.log("\n— write semantics (session TEMP table) —");
  await sql.unsafe(
    `CREATE TEMP TABLE _shimtest (id serial PRIMARY KEY, k text UNIQUE, v int,
       updated_at text)`,
  );
  await check("INSERT .run() -> last_row_id + changes", async () => {
    const r = await DB.prepare(
      `INSERT INTO _shimtest (k, v, updated_at) VALUES (?, ?, datetime('now'))`,
    )
      .bind("alpha", 1)
      .run();
    if (r.meta.last_row_id == null) throw new Error("last_row_id null");
    if (r.meta.changes !== 1) throw new Error(`changes=${r.meta.changes}`);
    return r.meta;
  });
  await check("UPDATE .run() -> changes counts affected", async () => {
    const r = await DB.prepare(`UPDATE _shimtest SET v = v + 1 WHERE k = ?`)
      .bind("alpha")
      .run();
    if (r.meta.changes !== 1) throw new Error(`changes=${r.meta.changes}`);
    return r.meta;
  });
  await check("UPDATE no match -> changes 0 (the !changes guard)", async () => {
    const r = await DB.prepare(`UPDATE _shimtest SET v = 0 WHERE k = ?`)
      .bind("nope")
      .run();
    if (r.meta.changes !== 0) throw new Error(`changes=${r.meta.changes}`);
    return r.meta;
  });
  await check("INSERT ... ON CONFLICT DO UPDATE (upsert)", async () => {
    await DB.prepare(
      `INSERT INTO _shimtest (k, v, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
    )
      .bind("alpha", 99)
      .run();
    const row = await DB.prepare(`SELECT v FROM _shimtest WHERE k = ?`)
      .bind("alpha")
      .first<{ v: number }>();
    if (row?.v !== 99) throw new Error(`v=${row?.v}`);
    return row;
  });

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  await sql.end();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
