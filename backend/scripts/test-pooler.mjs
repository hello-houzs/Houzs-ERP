// SAFE, read-only diagnostic: connect DIRECTLY to Houzs's Supabase poolers
// (NOT via Hyperdrive, NOT touching the prod worker) and measure whether the
// 6543 transaction pooler is healthy for THIS database — the question behind
// "why does HOOKKA not have the cold-start (it uses 6543) and can we move
// Houzs to 6543 too". Tests both 5432 (session, current) and 6543
// (transaction, HOOKKA's). SELECT 1 only. Never prints the password.
//
//   node scripts/test-pooler.mjs
import { readFileSync } from "node:fs";
import postgres from "postgres";

const raw = (readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/) || [])[1] || "";
if (!raw) {
  console.error(".dev.vars DATABASE_URL not found");
  process.exit(1);
}
const url5432 = raw.replace(/(@[^/@:]+:)\d+/, "$15432");
const url6543 = raw.replace(/(@[^/@:]+:)\d+/, "$16543");
const hostPort = (u) => (u.match(/@([^/@]+)/) || [])[1] || "?";

const withTimeout = (p, ms, label) =>
  Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} TIMED OUT after ${ms}ms (hung)`)), ms)),
  ]);

const opts = (url) => ({
  prepare: false,
  max: 1, // prod uses max:1 per request — replicate exactly
  ssl: "require",
  idle_timeout: 5,
  connect_timeout: 12,
  fetch_types: false,
});

async function testPooler(url, name) {
  console.log(`\n=== ${name} pooler — ${hostPort(url)} ===`);
  const sql = postgres(url, opts(url));
  try {
    let t = Date.now();
    await withTimeout(sql`SELECT 1 AS ok`, 25000, "cold query");
    console.log(`  cold  SELECT 1 (max:1)      : ${Date.now() - t}ms`);
    t = Date.now();
    await withTimeout(sql`SELECT 1 AS ok`, 25000, "warm query");
    console.log(`  warm  SELECT 1 (max:1)      : ${Date.now() - t}ms`);
  } catch (e) {
    console.log(`  single-query RESULT: FAILED -> ${e.message}`);
  } finally {
    try { await withTimeout(sql.end({ timeout: 5 }), 6000, "end"); } catch {}
  }

  // PROD-ACCURATE concurrency: N independent clients, each max:1 (one per
  // request), all firing at once — this is what real prod traffic looks like.
  const N = 10;
  const t = Date.now();
  try {
    await withTimeout(
      Promise.all(
        Array.from({ length: N }, async () => {
          const s = postgres(url, opts(url));
          try {
            return await s`SELECT 1 AS ok`;
          } finally {
            s.end({ timeout: 5 }).catch(() => {});
          }
        }),
      ),
      25000,
      `${N} independent max:1 clients`,
    );
    console.log(`  ${N}x independent max:1 conc : ${Date.now() - t}ms  -> OK, no hang`);
    console.log(`  RESULT: ${name} pooler is HEALTHY under prod-like load`);
  } catch (e) {
    console.log(`  ${N}x independent max:1 conc : FAILED -> ${e.message}`);
    console.log(`  RESULT: ${name} pooler HANGS under prod-like concurrency`);
  }
}

await testPooler(url5432, "SESSION 5432");
await testPooler(url6543, "TRANSACTION 6543");
console.log("\nDone.");
process.exit(0);
