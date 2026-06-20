// Read-only introspection: list roles + active-user count per role, and check
// whether a positions/org-chart layer exists. Config data only (no PII).
import { readFileSync } from "node:fs";
import postgres from "postgres";

const url = readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)[1];
const sql = postgres(url, { ssl: "require", prepare: false, max: 1, idle_timeout: 2 });

const roles = await sql`
  SELECT r.id, r.name, r.is_system,
         (SELECT count(*) FROM users u WHERE u.role_id = r.id AND u.status = 'active') AS active_users
  FROM roles r ORDER BY r.id`;
console.log("ROLES (id | name | system | active_users):");
for (const r of roles) {
  console.log(`  ${String(r.id).padStart(3)} | ${r.name.padEnd(18)} | sys=${r.is_system} | users=${r.active_users}`);
}

const hasPositions = await sql`SELECT to_regclass('public.positions') AS t`;
console.log(`\npositions table exists: ${hasPositions[0].t ? "YES" : "NO"}`);

await sql.end({ timeout: 3 }).catch(() => {});
process.exitCode = 0;
