// Read-only audit: which stored contact numbers have no country code?
//
// Owner ask, 2026-07-22: "確保我的聯係方式都是要有 +60 或者 country code 的".
//
// The canonical storage form is E.164 — a leading `+` then digits — produced by
// backend/src/scm/shared/phone.ts. Rows written before the normalising write
// paths existed, or through a path that only trimmed, hold the local form
// ("0123456789") instead. This script counts them so the gap is a number
// rather than a guess. It CHANGES NOTHING: fixing the rows is a migration, and
// a migration should be written against a known count, not a hunch.
//
// WHY IT INTROSPECTS INSTEAD OF LISTING TABLES. A hardcoded list of phone
// columns is wrong the moment somebody adds one, and it would then report a
// clean bill of health for a column it never looked at — the worst possible
// failure for an audit. So the column set comes from information_schema every
// run. A new `*_phone` column joins the audit automatically.
//
// Run it in CI (workflow "Phone country-code audit"), not locally: the
// credential lives in secrets.DATABASE_URL and nobody needs to hold it.
import { readFileSync } from "node:fs";
import postgres from "postgres";

// Same resolution order as pg-migrate.mjs: env wins so CI needs no .dev.vars.
function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

const url = resolveUrl();
if (!url) {
  console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
  process.exit(1);
}

const notice = (msg) =>
  console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

try {
  // Text-ish columns in the public schema whose NAME says phone. `contact_no`
  // and `whatsapp*` are included because this repo has used both spellings.
  const columns = await pg`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND data_type IN ('text', 'character varying', 'character')
      AND (
        column_name LIKE '%phone%'
        OR column_name = 'mobile'
        OR column_name LIKE '%whatsapp%'
        OR column_name LIKE '%contact_no%'
      )
    ORDER BY table_name, column_name`;

  if (columns.length === 0) {
    notice("No phone-shaped columns found — check the pattern, not the data.");
  }

  const findings = [];
  let scanned = 0;

  for (const { table_name, column_name } of columns) {
    // Identifiers cannot be parameterised; they come from information_schema,
    // not from input, and are re-quoted here so an odd name cannot break out.
    const t = pg(table_name);
    const col = pg(column_name);
    let row;
    try {
      [row] = await pg`
        SELECT count(*)::int                                        AS total,
               count(*) FILTER (
                 WHERE ${col} IS NOT NULL
                   AND btrim(${col}) <> ''
                   AND left(btrim(${col}), 1) <> '+'
               )::int                                               AS no_country_code,
               count(*) FILTER (
                 WHERE ${col} IS NOT NULL
                   AND btrim(${col}) <> ''
               )::int                                               AS non_empty
        FROM ${t}`;
    } catch (e) {
      // A view or a permission-restricted table must not abort the whole audit.
      notice(`SKIPPED ${table_name}.${column_name} — ${e.message}`);
      continue;
    }
    scanned += 1;
    if (row.no_country_code > 0) {
      findings.push({ table: table_name, column: column_name, ...row });
    }
  }

  notice(`Scanned ${scanned} phone-shaped columns.`);

  if (findings.length === 0) {
    notice("CLEAN — every non-empty contact number starts with a country code.");
  } else {
    findings.sort((a, b) => b.no_country_code - a.no_country_code);
    let worst = 0;
    for (const f of findings) {
      worst += f.no_country_code;
      notice(
        `${f.table}.${f.column}: ${f.no_country_code} of ${f.non_empty} filled ` +
          `values have NO country code (table has ${f.total} rows)`,
      );
    }
    notice(
      `TOTAL ${worst} stored contact numbers have no country code, across ` +
        `${findings.length} columns. Fixing them is a migration — write it ` +
        `against these counts.`,
    );
  }
} finally {
  await pg.end({ timeout: 5 });
}
