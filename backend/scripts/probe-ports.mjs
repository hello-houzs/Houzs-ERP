// Test BOTH poolers of the SG project directly: session (5432) and transaction
// (6543, what Hyperdrive uses). If 6543 hangs/fails while 5432 works, the
// transaction pooler is the problem (saturated/disabled) and Hyperdrive should
// point at 5432 instead.
import postgres from "postgres";
const REF = "anogrigyjbduyzclzjgn";
const PW = process.argv[2];
const HOST = "aws-1-ap-southeast-1.pooler.supabase.com";

for (const port of [5432, 6543]) {
  const url = `postgresql://postgres.${REF}:${PW}@${HOST}:${port}/postgres`;
  const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 15, idle_timeout: 2 });
  const t0 = Date.now();
  try {
    const [{ one }] = await sql`SELECT 1 AS one`;
    console.log(`OK   :${port}  SELECT 1=${one} (${Date.now() - t0}ms)`);
  } catch (e) {
    console.log(`FAIL :${port}  ${Date.now() - t0}ms -> ${String(e.message || e).slice(0, 80)}`);
  } finally {
    await sql.end({ timeout: 3 }).catch(() => {});
  }
}
process.exit(0);
