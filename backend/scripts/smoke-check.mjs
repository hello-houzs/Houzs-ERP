// Post-deploy smoke check.
//
// Runs in deploy.yml right after `wrangler deploy`. Confirms the freshly
// deployed Worker is actually serving AND that its DB path (Hyperdrive ->
// Supabase) is alive — the exact thing that broke on 2026-06-13 when the
// transaction pooler stalled and the Worker booted fine but every query
// hung. A green deploy that can't reach the DB is the failure mode we
// most need to catch.
//
// Probes, in order:
//   1. GET /health          -> { ok: true }                (Worker is up; no DB)
//   2. GET /api/auth/status -> { has_users: <bool> }       (full DB round-trip;
//                                                           public, no PII, one COUNT)
//
// Each probe retries with backoff to absorb deploy propagation + a cold
// Hyperdrive pool on the first hit. Deliberately low-volume (a handful of
// requests, not a burst) — the SG micro must not be hammered.
//
// This DETECTS a bad deploy and fails the job loudly; it does NOT roll
// back (Workers rollback is a manual `wrangler rollback`). A red deploy +
// notification is the signal to act.
//
// Usage: node scripts/smoke-check.mjs <base-url>
//   e.g. node scripts/smoke-check.mjs https://autocount-sync-api.houzs-erp.workers.dev

const BASE = (process.argv[2] || process.env.SMOKE_URL || "").replace(/\/$/, "");
if (!BASE) {
  console.error("[smoke] no base URL — pass it as argv[1] or set SMOKE_URL.");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retry schedule (ms): ~total 60s, front-loaded but never tight-looping.
const BACKOFFS = [0, 3000, 6000, 10000, 15000, 25000];

async function probe(path, validate) {
  const url = `${BASE}${path}`;
  let lastErr = "unknown";
  for (let i = 0; i < BACKOFFS.length; i++) {
    if (BACKOFFS[i]) await sleep(BACKOFFS[i]);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) {
        lastErr = `HTTP ${res.status}`;
      } else {
        const body = await res.json();
        const verdict = validate(body);
        if (verdict === true) {
          console.log(`[smoke] PASS ${path} (attempt ${i + 1})`);
          return true;
        }
        lastErr = `unexpected body: ${JSON.stringify(body)} (${verdict})`;
      }
    } catch (e) {
      lastErr = String(e.name === "AbortError" ? "timeout (20s)" : e.message || e);
    } finally {
      clearTimeout(t);
    }
    console.log(`[smoke] ... ${path} not ready (attempt ${i + 1}/${BACKOFFS.length}): ${lastErr}`);
  }
  console.error(`[smoke] FAIL ${path} after ${BACKOFFS.length} attempts: ${lastErr}`);
  return false;
}

const okHealth = await probe("/health", (b) => (b && b.ok === true ? true : "ok!==true"));
const okDb = await probe("/api/auth/status", (b) =>
  b && typeof b.has_users === "boolean" ? true : "has_users missing/non-bool"
);

if (okHealth && okDb) {
  console.log("[smoke] all probes passed — deploy is serving and DB is reachable.");
  // Set exitCode (don't process.exit) so the event loop drains naturally —
  // a hard exit mid-socket-teardown trips a libuv assertion on Windows.
  process.exitCode = 0;
} else {
  console.error(
    "[smoke] deploy is UNHEALTHY. Worker may be up but the DB path is down.\n" +
      "        Investigate, then `wrangler rollback` if needed (see DB-REPOINT-RUNBOOK)."
  );
  process.exitCode = 1;
}
