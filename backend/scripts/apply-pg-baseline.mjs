// One-shot: apply the generated Postgres baseline to the Supabase DB.
// Reads DATABASE_URL from backend/.dev.vars. Splits drizzle's
// `--> statement-breakpoint` markers and runs each statement.
import { readFileSync } from "node:fs";
import postgres from "postgres";

const env = readFileSync(".dev.vars", "utf8");
const url = env.match(/DATABASE_URL="([^"]+)"/)[1];
const sql = postgres(url, { ssl: "require", prepare: false });

const file = readFileSync("src/db/migrations-pg/0000_baseline.sql", "utf8");
const stmts = file
  .split("--> statement-breakpoint")
  .map((s) => s.trim())
  .filter((s) => s && !s.startsWith("--"));

let ok = 0,
  fail = 0;
for (const s of stmts) {
  try {
    await sql.unsafe(s);
    ok++;
  } catch (e) {
    fail++;
    console.log("FAIL:", e.message);
    console.log("  >>", s.slice(0, 100).replace(/\s+/g, " "));
  }
}
console.log(`\napplied ${ok}/${stmts.length} statements, ${fail} failed`);
const t = await sql`select count(*)::int n from information_schema.tables where table_schema='public'`;
console.log("tables now in public schema:", t[0].n);
await sql.end();
