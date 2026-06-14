// Sanity: confirm the hot inbox/overview-style queries now use index scans.
import { readFileSync } from "node:fs";
import postgres from "postgres";

const url = readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)[1];
const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

const cases = [
  ["checklist by project+due", `SELECT * FROM project_checklist WHERE project_id = 100 AND status = 'pending' ORDER BY due_date LIMIT 5`],
  ["sales_entries by project", `SELECT * FROM sales_entries WHERE project_id = 100 AND archived_at IS NULL LIMIT 5`],
  ["sessions by token", `SELECT * FROM sessions WHERE token = 'x' LIMIT 1`],
  ["assr by stage", `SELECT count(*) FROM assr_cases WHERE stage = 'pending_solution'`],
  ["activity by project", `SELECT * FROM project_activity WHERE project_id = 100 ORDER BY created_at DESC LIMIT 10`],
];

for (const [name, q] of cases) {
  const plan = await pg.unsafe(`EXPLAIN ${q}`);
  const first = plan.map((r) => Object.values(r)[0]).join("\n  ");
  const usesIndex = /Index/.test(first);
  console.log(`${usesIndex ? "INDEX " : "SEQSCAN"}  ${name}\n  ${first.split("\n")[0]}`);
}
await pg.end();
