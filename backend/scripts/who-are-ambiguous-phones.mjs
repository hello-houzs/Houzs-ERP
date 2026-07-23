// Read-only: who are the creditors whose phone looks US-or-Chinese?
//
// The phone backfill cannot tell "13362748640" apart as +1 vs +86 from digits
// alone. The company NAME and the currency can. This lists them so the owner
// decides once, by looking, instead of the script guessing per row.
import { readFileSync } from "node:fs";
import postgres from "postgres";

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try { return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1]; }
  catch { return undefined; }
}
const url = resolveUrl();
if (!url) { console.error("DATABASE_URL not set."); process.exit(1); }
const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });
try {
  // 11-digit numbers opening 1[3-9] across all three creditor phone columns.
  const rows = await pg`
    SELECT creditor_code, company_name, currency_code, phone1, mobile, phone2
    FROM creditors
    WHERE regexp_replace(coalesce(phone1,''), '\D', '', 'g') ~ '^1[3-9][0-9]{9}$'
       OR regexp_replace(coalesce(mobile,''), '\D', '', 'g') ~ '^1[3-9][0-9]{9}$'
       OR regexp_replace(coalesce(phone2,''), '\D', '', 'g') ~ '^1[3-9][0-9]{9}$'
    ORDER BY currency_code NULLS LAST, company_name`;

  if (rows.length === 0) { notice("No creditors with a US/CN-shaped phone."); }
  for (const r of rows) {
    const ph = [r.phone1, r.mobile, r.phone2].filter(Boolean).join(" / ");
    notice(`${r.creditor_code} | ${r.company_name ?? "(no name)"} | cur=${r.currency_code ?? "—"} | ${ph}`);
  }
  notice(`${rows.length} creditor(s) to classify.`);
} finally { await pg.end({ timeout: 5 }); }
