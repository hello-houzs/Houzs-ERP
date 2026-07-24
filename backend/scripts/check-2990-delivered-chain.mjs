// Read-only report: for every SO the 2990 SOURCE marked DELIVERED, what does
// the SOP chain look like in Houzs — does the SO exist, does it have DOs, what
// status are they, are there SIs?
//
// WHY: 2990 said 19 SOs were DELIVERED; Houzs derives SO-delivered from a
// delivered DO/SI and shows only ~7. The owner's ruling: status must follow
// the SOP chain (SO -> DO -> delivered), so the question is NOT "backfill the
// SO status" but "does each delivered order HAVE its DO, and is the DO's
// status the thing to correct?" This prints the chain per order so that
// decision is made on evidence.
//
// SELECTs only, on BOTH databases (Houzs Postgres via DATABASE_URL, 2990
// source Supabase via SOURCE_SUPABASE_URL/SOURCE_SERVICE_ROLE_KEY — the same
// secrets migrate-2990.yml and check-2990-completeness.yml already use).
// Exits 0 for every legitimate answer.
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}
const url = resolveUrl();
const SOURCE_URL = process.env.SOURCE_SUPABASE_URL;
const SOURCE_KEY = process.env.SOURCE_SERVICE_ROLE_KEY;
if (!url || !SOURCE_URL || !SOURCE_KEY) {
  console.error("Need DATABASE_URL + SOURCE_SUPABASE_URL + SOURCE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

const notice = (msg) =>
  console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });
const src = createClient(SOURCE_URL, SOURCE_KEY, { auth: { persistSession: false } });

try {
  // 1) every DELIVERED SO in the 2990 source
  const { data: srcRows, error: srcErr } = await src
    .from("mfg_sales_orders")
    .select("doc_no, status, customer_name, delivery_date")
    .eq("status", "DELIVERED")
    .order("doc_no");
  if (srcErr) {
    console.error(`source query failed: ${srcErr.message}`);
    process.exit(1);
  }
  notice(`2990 SOURCE: ${srcRows.length} SO(s) with status DELIVERED.`);

  for (const s of srcRows) {
    // importer prefixes 2990 doc numbers; match either form defensively
    const candidates = [`2990-${s.doc_no}`, s.doc_no];
    const ho = await pg`
      SELECT doc_no, status FROM scm.mfg_sales_orders
      WHERE company_id = 2 AND doc_no IN ${pg(candidates)} LIMIT 1`;
    if (ho.length === 0) {
      notice(`${s.doc_no}: MISSING in Houzs (no company-2 SO under either doc form).`);
      continue;
    }
    const h = ho[0];
    const dos = await pg`
      SELECT do_number, status FROM scm.delivery_orders
      WHERE company_id = 2 AND so_doc_no = ${h.doc_no} ORDER BY do_number`;
    const sis = await pg`
      SELECT count(*)::int AS n FROM scm.sales_invoices
      WHERE company_id = 2 AND so_doc_no = ${h.doc_no}`;
    const doStr = dos.length
      ? dos.map((d) => `${d.do_number}=${d.status}`).join(", ")
      : "NO DO AT ALL";
    const verdict =
      h.status === "DELIVERED"
        ? "OK (already derived DELIVERED)"
        : dos.length === 0
          ? "GAP: no DO exists — the chain was never built (create DO or decide)"
          : dos.every((d) => ["DELIVERED", "SIGNED", "INVOICED"].includes(d.status))
            ? "CHECK: DOs look delivered yet SO is not — derivation gap?"
            : `FIX PATH: mark DO(s) delivered -> SO derives DELIVERED (DOs now: ${dos.map((d) => d.status).join("/")})`;
    notice(
      `${s.doc_no} -> ${h.doc_no}: SO=${h.status} | DO: ${doStr} | SI: ${sis[0].n} | ${verdict}`,
    );
  }
} finally {
  await pg.end();
}
