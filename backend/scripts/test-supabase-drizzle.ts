// Smoke-test the Drizzle (postgres-js) layer against real Supabase: a plain
// select, an alias self-join (the events/users pattern), the db.get helper,
// and db.execute (the db.all replacement). Read-only. Run with tsx.
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql, eq, desc } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import * as schema from "../src/db/schema.pg";

const devVars = readFileSync(".dev.vars", "utf8");
const url = (devVars.match(/^\s*DATABASE_URL\s*=\s*"?([^"\n]+)"?/m) || [])[1];
const client = postgres(url, { ssl: "require", prepare: false, max: 1 });
const db = drizzle(client, { schema });

let pass = 0;
let fail = 0;
async function check(name: string, fn: () => Promise<unknown>) {
  try {
    const r = await fn();
    console.log(`  PASS  ${name}  ->  ${JSON.stringify(r)?.slice(0, 120)}`);
    pass++;
  } catch (e) {
    console.log(`  FAIL  ${name}  ->  ${(e as Error).message?.slice(0, 200)}`);
    fail++;
  }
}

async function main() {
  const { users } = schema;

  await check("db.select().from(users).limit(2)", () =>
    db.select({ id: users.id, email: users.email }).from(users).limit(2),
  );

  await check("alias self-join (manager)", () => {
    const mgr = alias(users, "m");
    return db
      .select({ id: users.id, name: users.name, manager: mgr.name })
      .from(users)
      .leftJoin(mgr, eq(mgr.id, users.manager_id))
      .orderBy(desc(users.id))
      .limit(2);
  });

  await check("db.execute<T>(sql) (db.all replacement)", () =>
    db.execute<{ c: number }>(sql`SELECT count(*)::int AS c FROM ${users}`),
  );

  await check("db.get<T>(sql) helper", async () => {
    const row = await (
      db.execute<{ c: number }>(sql`SELECT count(*)::int AS c FROM ${users}`)
    ).then((r) => r[0]);
    return row;
  });

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  await client.end();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
