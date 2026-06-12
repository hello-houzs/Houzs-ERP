// Eyeball test for rewriteDialect against the actual SQLite-isms found in the
// codebase. Run: npx tsx scripts/test-dialect.ts
import { rewriteDialect, toPgPlaceholders } from "../src/db/d1-compat";

const cases: string[] = [
  `julianday('now') - julianday(h.entered_at)`,
  `AVG(julianday(closed_at) - julianday(created_at)) AS avg_days`,
  `CAST((julianday(c.deadline_at) - julianday('now')) * 24 AS INTEGER) as hours_to_deadline`,
  `CAST(julianday(p.end_date) - julianday(p.start_date) + 1 AS INTEGER)`,
  `AND COALESCE(c.complained_date, c.created_at) >= date('now', '-30 days')`,
  `date('now', '-4 months')`,
  `date('now', '-12 months')`,
  `datetime('now')`,
  `datetime('now', '-1 day')`,
  `strftime('%Y-W%W', closed_at)`,
  `strftime('%Y-%m', COALESCE(complained_date, created_at))`,
  `strftime('%Y', p.start_date)`,
  `WHERE x = char(10)`,
  `instr(name, 'sofa')`,
  `SELECT * FROM t WHERE note = 'julianday(now) literal stays' AND a = char(9)`,
  `varchar_col LIKE 'x'`, // must NOT touch varchar
  `INSERT OR REPLACE INTO kv (k,v) VALUES (?, ?)`, // pass-through (source-fixed)
  `datetime('now', '-' || ? || ' hours')`, // dynamic — will drop offset, flag it
];

for (const q of cases) {
  console.log("IN :", q);
  console.log("OUT:", toPgPlaceholders(rewriteDialect(q)));
  console.log("");
}
