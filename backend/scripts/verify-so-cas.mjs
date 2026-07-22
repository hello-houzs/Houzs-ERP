// Read-only post-deploy check for #927's Sales Order CAS cutover.
//
// The one that matters: apply_so_header_cas must exist EXACTLY ONCE. Postgres
// allows overloads, so if the pre-#927 signature survived alongside the new
// 13-argument one, every caller resolves by argument shape — and a caller that
// happens to match the OLD overload silently skips the CAS check and goes back
// to last-writer-wins. Nothing errors. Two rows here is the whole failure.
//
// Also reports whether the grace window is still open, because while it is, a
// request that omits `version` is deliberately accepted with the pre-CAS
// semantics — so "CAS is not rejecting anything yet" is expected, not broken.
import { readFileSync } from "node:fs";
import postgres from "postgres";

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch { return undefined; }
}
const url = resolveUrl();
if (!url) { console.error("DATABASE_URL not set. Aborting."); process.exit(1); }
const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const fail = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR: ${m}`);

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });
let bad = false;
try {
  const fns = await pg`
    SELECT n.nspname AS schema, p.proname, p.pronargs
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'apply_so_header_cas'
    ORDER BY n.nspname, p.pronargs`;

  if (fns.length === 0) {
    fail("apply_so_header_cas does not exist — 0173 did not create it.");
    bad = true;
  } else if (fns.length > 1) {
    fail(`apply_so_header_cas has ${fns.length} overloads: ${fns.map((f) => `${f.schema}(${f.pronargs} args)`).join(", ")}. The old signature survived; callers can resolve to it and silently skip the CAS check.`);
    bad = true;
  } else {
    const f = fns[0];
    notice(`apply_so_header_cas: exactly one, ${f.schema}, ${f.pronargs} args`);
    if (Number(f.pronargs) !== 13) {
      fail(`expected 13 args, found ${f.pronargs} — the deployed signature is not the one #927 ships.`);
      bad = true;
    }
  }

  const [m] = await pg`
    SELECT count(*)::int AS n FROM public._pg_migrations
    WHERE filename IN ('0172_scm_so_edit_lease_and_followers.sql',
                       '0173_scm_so_concurrency_domain_closure.sql',
                       '0174_scm_stock_allocation_recompute_queue.sql',
                       '0171_idempotency_phase2_constraints.sql')`;
  notice(`migrations 0171-0174 tracked as applied: ${m.n} of 4`);
  if (m.n !== 4) { fail("not all four are tracked — pg-migrate did not finish."); bad = true; }
} finally {
  await pg.end({ timeout: 5 });
}
if (bad) process.exitCode = 1;
