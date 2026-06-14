// Incident diagnostic: is the xxoszh TRANSACTION pooler (6543, what
// Hyperdrive uses) healthy, or only the SESSION pooler (5432)? Opens a
// few concurrent connections to each and reports. Reads only this
// workspace's own .dev.vars.
import { readFileSync } from "node:fs";
import postgres from "postgres";

const base = readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)[1];

async function probe(label, url, conns) {
  const results = [];
  await Promise.all(
    Array.from({ length: conns }, async (_, i) => {
      const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 12, idle_timeout: 2 });
      const t0 = Date.now();
      try {
        const r = await sql`SELECT 1 AS one`;
        results.push(`c${i}:ok ${Date.now() - t0}ms`);
      } catch (e) {
        results.push(`c${i}:FAIL ${String(e.message || e).slice(0, 60)}`);
      } finally {
        await sql.end({ timeout: 3 }).catch(() => {});
      }
    }),
  );
  console.log(`${label}\n  ${results.join("\n  ")}`);
}

await probe("SESSION pooler :5432", base, 5);
await probe("TRANSACTION pooler :6543", base.replace(":5432/", ":6543/"), 5);
process.exit(0);
