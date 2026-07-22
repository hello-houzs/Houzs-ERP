// Backfill stored contact numbers to E.164, reversibly.
//
// Owner approved 2026-07-22 after the read-only audit reported 3788 values
// without a country code across 7 columns.
//
// WHY THIS IS A SCRIPT AND NOT A MIGRATION. pg-migrate runs on a push to main
// against production, and deploy-staging.yml runs on the same push against
// staging — so a migration file gives no "staging first", it gives "both at
// once". A workflow_dispatch script is the only shape where the staging run
// can be inspected before production is touched.
//
// SAFETY, in the order it matters:
//
//  1. DRY RUN IS THE DEFAULT. Writing needs --apply. A run with no flags
//     reports what it would do and changes nothing.
//  2. EVERY CHANGE IS RECORDED BEFORE IT IS MADE, in phone_normalisation_backup
//     (table, column, row id, old value, new value, run id). Reversing the
//     whole backfill is one UPDATE ... FROM that table. 3788 customer phone
//     numbers is not something to change without a way back.
//  3. THE SAME CONSERVATIVE GUARD THE API USES. canonicalizeSinglePhone
//     refuses anything that is not unambiguously ONE number — these are free
//     text columns and creditors.phone1 in particular has held "03-1234 5678 /
//     019-876 5432". Collapsing that into one string would destroy a supplier
//     contact, so a value we cannot canonicalise is LEFT ALONE and counted as
//     skipped, never guessed at.
//  4. NO ROW IS TOUCHED TWICE. Only rows whose canonical form actually differs
//     are updated, so re-running is a no-op and an interrupted run resumes
//     safely.
//  5. ONE TRANSACTION PER COLUMN. A failure rolls that column back whole
//     rather than leaving it half-converted.
//
// Usage:
//   node scripts/normalize-stored-phones.mjs             # dry run, changes nothing
//   node scripts/normalize-stored-phones.mjs --apply     # writes, with backup
//   node scripts/normalize-stored-phones.mjs --revert=<runId>
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { canonicalizeSinglePhone } from "./lib/phone-normalise.mjs";

// The columns the audit found, named explicitly rather than introspected: a
// backfill must change exactly the set a human approved, not whatever a
// pattern happens to match on the day it runs.
const TARGETS = [
  { table: "sales_orders", column: "phone" },
  { table: "assr_cases", column: "phone" },
  { table: "users", column: "phone" },
  { table: "creditors", column: "phone1" },
  { table: "creditors", column: "mobile" },
  { table: "creditors", column: "phone2" },
  { table: "sales_entries", column: "customer_phone" },
];

/* WHICH STORED VALUES MAY BE ASSUMED MALAYSIAN.
 *
 * canonicalizeSinglePhone is the API's rule, and for LIVE INPUT it is right: a
 * person typing into a form with a country picker set to Malaysia means
 * Malaysia. For a BACKFILL over rows nobody is looking at, the same rule is
 * dangerous, because normalizePhone treats any bare 8+ digit string as
 * Malaysian:
 *
 *     "61234567"  ->  "+6061234567"
 *
 * If that row was a Singapore landline (6123 4567) the migration has just
 * turned an obviously-broken number into a CONFIDENTLY WRONG one. Before, a
 * human looking at it would ask the customer. After, it looks like a normal
 * +60 number and nobody ever questions it — and the customer is unreachable.
 * That is strictly worse than leaving it alone.
 *
 * So the backfill converts only what is UNAMBIGUOUSLY Malaysian local:
 *   - leading trunk 0  ("0123456789")      — the ordinary local form
 *   - leading 60       ("60123456789")     — already says Malaysia
 *   - bare 9-10 digits starting with 1     — a mobile written without the 0,
 *                                            the shape the OCR rule produces
 * Everything else is REPORTED, not guessed at. A number a human must look at
 * is not a number a script should decide.
 */
function malaysianLocalShape(raw) {
  const digits = String(raw ?? '').replace(/\D+/g, '');
  if (digits.startsWith('0')) return true;
  if (digits.startsWith('60')) return true;
  if (digits.startsWith('1') && (digits.length === 9 || digits.length === 10)) return true;
  return false;
}

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.find((a) => a.startsWith("--revert="))?.slice(9);

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

const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const warn = (m) => console.log(process.env.GITHUB_ACTIONS ? `::warning::${m}` : m);

// A run id ties every backup row to the run that wrote it, so a revert can
// target one run rather than "everything ever backfilled".
const RUN_ID = process.env.GITHUB_RUN_ID
  ? `gh-${process.env.GITHUB_RUN_ID}`
  : `local-${process.env.RUN_ID ?? "manual"}`;

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

async function ensureBackupTable() {
  await pg`
    CREATE TABLE IF NOT EXISTS phone_normalisation_backup (
      id          bigserial PRIMARY KEY,
      run_id      text        NOT NULL,
      table_name  text        NOT NULL,
      column_name text        NOT NULL,
      row_id      bigint      NOT NULL,
      old_value   text,
      new_value   text,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )`;
  await pg`
    CREATE INDEX IF NOT EXISTS idx_phone_backup_run
      ON phone_normalisation_backup (run_id)`;
}

async function revert(runId) {
  const rows = await pg`
    SELECT table_name, column_name, row_id, old_value
    FROM phone_normalisation_backup
    WHERE run_id = ${runId}`;
  if (rows.length === 0) {
    warn(`No backup rows for run ${runId} — nothing to revert.`);
    return;
  }
  let n = 0;
  for (const r of rows) {
    await pg`
      UPDATE ${pg(r.table_name)}
      SET ${pg(r.column_name)} = ${r.old_value}
      WHERE id = ${r.row_id}`;
    n += 1;
  }
  notice(`Reverted ${n} values from run ${runId}.`);
}

async function processColumn({ table, column }) {
  const rows = await pg`
    SELECT id, ${pg(column)} AS value
    FROM ${pg(table)}
    WHERE ${pg(column)} IS NOT NULL
      AND btrim(${pg(column)}) <> ''
      AND left(btrim(${pg(column)}), 1) <> '+'`;

  const changes = [];
  const refusedRows = [];
  const ambiguous = [];
  for (const r of rows) {
    if (!malaysianLocalShape(r.value)) {
      // Not unambiguously Malaysian — could be a foreign number stored without
      // its country code. Reported, never guessed at. See malaysianLocalShape.
      ambiguous.push(r);
      continue;
    }
    const next = canonicalizeSinglePhone(r.value);
    if (next === r.value || next === "" || !next.startsWith("+")) {
      refusedRows.push(r);
      continue;
    }
    changes.push({ id: r.id, old: r.value, next });
  }
  const refused = refusedRows.length;

  notice(
    `${table}.${column}: ${rows.length} without a country code — ` +
      `${changes.length} convertible, ${refused} unparseable, ` +
      `${ambiguous.length} AMBIGUOUS (left alone, need a human)`,
  );

  // A count does not prove correctness. Show what would actually change, so a
  // human can see that no number is being mangled before any of it is written.
  for (const c of changes.slice(0, 8)) {
    notice(`    ${JSON.stringify(c.old)}  ->  ${c.next}`);
  }
  if (changes.length > 8) notice(`    … and ${changes.length - 8} more of the same shapes`);

  for (const a of ambiguous.slice(0, 8)) {
    notice(`    AMBIGUOUS, untouched: ${JSON.stringify(a.value)} — could be a foreign number without its country code`);
  }
  if (ambiguous.length > 8) notice(`    … and ${ambiguous.length - 8} more ambiguous`);

  for (const r of refusedRows.slice(0, 3)) {
    notice(`    unparseable, untouched: ${JSON.stringify(r.value)}`);
  }

  if (!APPLY || changes.length === 0) return { table, column, would: changes.length, refused };

  await pg.begin(async (tx) => {
    for (const c of changes) {
      await tx`
        INSERT INTO phone_normalisation_backup
          (run_id, table_name, column_name, row_id, old_value, new_value)
        VALUES (${RUN_ID}, ${table}, ${column}, ${c.id}, ${c.old}, ${c.next})`;
      await tx`
        UPDATE ${tx(table)} SET ${tx(column)} = ${c.next} WHERE id = ${c.id}`;
    }
  });

  notice(`  APPLIED ${changes.length} to ${table}.${column}`);
  return { table, column, applied: changes.length, refused };
}

try {
  if (REVERT) {
    await revert(REVERT);
  } else {
    notice(APPLY ? `APPLY mode — run id ${RUN_ID}` : "DRY RUN — nothing will be written");
    if (APPLY) await ensureBackupTable();

    let total = 0;
    let refusedTotal = 0;
    for (const t of TARGETS) {
      const r = await processColumn(t);
      total += r.applied ?? r.would ?? 0;
      refusedTotal += r.refused ?? 0;
    }

    if (APPLY) {
      notice(`DONE — ${total} values normalised, ${refusedTotal} left alone.`);
      notice(`To undo this run: node scripts/normalize-stored-phones.mjs --revert=${RUN_ID}`);
    } else {
      notice(`DRY RUN — would normalise ${total}, would leave ${refusedTotal} alone.`);
      notice("Re-run with --apply to write. Nothing has been changed.");
    }
  }
} finally {
  await pg.end({ timeout: 5 });
}
