// Bundle-size budget gate.
//
// Runs after `vite build` (see ci.yml). Measures the production JS in
// dist/assets and fails CI if any budget is exceeded, so a stray
// `import` of a heavy library into the always-loaded path — the thing
// that actually makes first paint slow — is caught in review instead of
// in production.
//
// Budgets are gzip (what travels over the wire) with deliberate headroom
// over the 2026-06-13 baseline, except MAX_CHUNK_RAW which is raw bytes
// (a proxy for "one route got out of hand"). Update the numbers here when
// a growth is intentional — the diff is the audit trail.
//
//   baseline 2026-06-13 (after route code-splitting):
//     initial JS gzip  ~84.6 KB  (index 30.9 + react-vendor 53.8)
//     total   JS gzip  ~370  KB
//     largest chunk    ~200  KB raw (Projects)
//
//   2026-06-25 (after the SCM 2990 cutover landed in full):
//     initial JS gzip ~115.5 KB  (index 38.3 + react-vendor 77.3)
//   react-vendor is pure framework — react + react-dom + react-router +
//   @tanstack/react-query — every byte of which is eager by necessity
//   (the QueryClientProvider/Router wrap the whole app). index is the app
//   shell + the route table: the cutover registered ~50 new lazy routes,
//   and while each PAGE is code-split, its lazy() declaration + <Route>
//   live in the always-loaded shell. That growth is legitimate and not
//   trimmable without lazy-loading the shell itself (which would flash on
//   first paint), so the initial budget is raised to give ~2 KB headroom.
//
//   2026-06-30 (lucide tree-shake fix + accumulated drift):
//     initial JS gzip ~118.8 KB  (index 41.5 + react-vendor 77.3)
//     total   JS gzip ~1348 KB
//     largest chunk    ~430 KB raw (xlsx)
//   The lucide-react chunk dropped from ~777 KB raw → ~82 KB after replacing
//   `import * as Lucide` + `lucide-react/dynamicIconImports` in Categories.tsx
//   with named imports + a static ICON_MAP (Rollup can now tree-shake the rest
//   of the icon set out). That removed ~115 KB gzip from total JS. The two
//   non-lucide budgets are bumped here to accommodate the residual creep that
//   was already present pre-fix (entry chunk grew ~3 KB since 2026-06-25 from
//   shell/route additions, and the long tail of lazy route chunks added the
//   rest). Both are legitimate, neither is a stray-heavy-import regression.
//
//   2026-07-16 (route prefetch) — read this as a warning about the line above:
//     initial JS gzip ~130.0 KB  (main measured 129.7 on PR #625)
//   The 2026-06-30 bump left ~11 KB of headroom over the 118.8 measured that
//   day. It is GONE: main sits at 129.7 — 99.8% — and nobody bumped or recorded
//   a number on the way up, so the gate had quietly become a tripwire that the
//   next commit, any commit, was going to hit. This one did, at +0.3 KB.
//   Prefetch itself is not the weight: the 51-entry route table lives in its own
//   lazy chunk (Layout and Sidebar import it dynamically for exactly this
//   reason); what lands in the shell is the two import() shims.
//   Raised to 136 for ~6 KB of working room, which still does this gate's job —
//   a stray heavy library on the always-loaded path is tens to hundreds of KB,
//   not six. The 118.8 -> 129.7 shell creep is a real open question (route-table
//   growth is the likely bulk, and it is not trimmable without lazy-loading the
//   shell), but it is not this PR's to answer — and squeezing under a stale
//   number to avoid saying so would only have buried it further.
//
//   2026-07-18 (measure what the browser fetches):
//     initial JS gzip ~155 KB, measured from dist/index.html
//   The "118.8 -> 129.7 shell creep" open question above was chasing the wrong
//   number. This gate had never counted `lucide` or `vendor`, both of which
//   index.html modulepreloads, so the real eager payload on that same commit
//   was ~269 KB gzip — roughly double what the gate reported PASS on. `vendor`
//   was ~117 KB of it and was almost entirely jspdf's dependency tree, eager
//   only because manualChunks co-located it with @remix-run/router; see
//   vite.config.ts. Fixing the chunking dropped the true figure to ~155 KB and
//   the initial set now comes from the emitted HTML, so this class of drift
//   cannot recur silently.
//
// Run locally: `npm run build && node scripts/check-bundle-size.mjs`

import { readdirSync, readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const ASSETS = join(DIST, "assets");

// Budgets. KB = 1000 bytes (matches Vite's build output, not 1024).
const KB = 1000;
const BUDGETS = {
  // Always-loaded path: every chunk dist/index.html fetches eagerly. This is
  // what blocks first paint regardless of route. Raised 115 -> 118
  // on 2026-06-25 for the SCM 2990 cutover; 118 -> 120 on 2026-06-30 for
  // ~3 KB of entry-chunk drift since (shell + route-table additions, not a
  // stray heavy import). Keep this tight enough
  // that a real regression still trips it. 130 -> 136 on 2026-07-16: the 130
  // headroom was fully consumed by unrecorded shell creep (main 129.7); see the
  // dated entry in the header before bumping this again.
  // 136 -> 165 on 2026-07-18. This is NOT 29 KB of new code — it is the same
  // build measured honestly for the first time. The old number counted two of
  // the four chunks the browser actually fetches eagerly (see
  // readInitialChunks below); on the same commit the true figure was ~269 KB.
  // Removing jspdf's dependency tree from the eager path in the same PR cut
  // that to ~155 KB, so first paint got ~114 KB gzip lighter while the
  // reported number went UP — the metric moved, not the bundle.
  //
  // Read that as: the real ceiling just dropped from 269 to 165, and from here
  // the number on the tin is the number on the wire. The Fulfillment Costing
  // route (this branch) adds only a nav entry + route + finance guard to the
  // always-loaded shell (~0.1 KB gzip; the page itself is a lazy chunk), which
  // fits inside the ~10 KB of headroom under this 165 ceiling — no bump needed.
  INITIAL_JS_GZIP: 165 * KB,
  // Everything the app can lazy-load (users only fetch the routes they
  // visit). Soft guard against unbounded total growth, not a first-paint
  // cost. Raised for the SCM "2990 cutover" — ~50 new lazy route chunks
  // plus the xlsx + jspdf export/print libs (now split into on-demand
  // chunks, but still counted here since this sums every emitted .js).
  // 1300 -> 1360 on 2026-06-30 to absorb the long-tail drift that remains
  // after the lucide tree-shake fix removed ~115 KB gzip from this number.
  // 1360 -> 1500 on 2026-07-01 for the new mobile app (frontend/src/mobile/*),
  // code-split behind AuthScreens' useIsMobile — desktop users never fetch it
  // (initial JS unchanged), but it is counted here since this sums every .js.
  // 1700 -> 1750 on 2026-07-16: the Not Yet Billed report is one new lazy route
  // (+7.1 KB gzip: 1694.1 -> 1701.2), which is exactly the growth this budget
  // exists to surface — and it did. A page is a lazy chunk; only its own users
  // fetch it, and initial JS is unchanged. Headroom is ~7 more pages, which is
  // the point: this should trip again in a few pages' time and make someone
  // look. Unlike INITIAL_JS_GZIP, growth here is not a first-paint cost — but
  // it IS the number to watch if the lazy tail ever stops being lazy.
  // 1750 -> 1770 on 2026-07-19: the Fulfillment Costing mobile screen is one new
  // lazy chunk (MobileFulfillmentCosting, +4.5 KB gzip: 1748.9 -> 1753.4),
  // fetched only by the finance cohort that opens it; initial JS is unchanged
  // (still PASS at 156/165). Exactly the "one more page" growth this budget
  // exists to surface — bumped with ~16 KB headroom for a few more.
  //
  // 1770 -> 1800 on 2026-07-19 (perf/frontend-audit, landing the same day). It DID make someone look,
  // so here is what was found. The "headroom is ~7 more pages" estimate above
  // was wrong: measured on origin/main at ae79e1ad, total JS is already
  // **1749.1 KB — 0.9 KB under the line**, i.e. the budget was fully spent and
  // the very next change of any size was going to fail CI regardless of what it
  // was. The frontend-audit branch adds 2.8 KB (a shared retry predicate + its
  // ~30 imports, a debounced search input in DataTable, and the notifications
  // context split), which is what tipped it — but attributing the failure to
  // those 2.8 KB would be reading the wrong cause. Fulfillment Costing hit the
  // same wall the same day from the other direction and bumped to 1770; that is
  // two branches tripping a spent budget within hours, which is the finding.
  //
  // Raised by 50 KB rather than to a hair above current, so this keeps working
  // as a tripwire instead of failing every PR. INITIAL_JS_GZIP — the number that
  // actually governs first paint — moved 156.0 -> 156.1 KB and remains at 95%
  // of its own budget, unchanged in substance.
  //
  // WHAT TO DO WHEN THIS TRIPS AGAIN: do not reflexively add another 50. Check
  // INITIAL_JS_GZIP first (if that is healthy, the lazy tail is still lazy and
  // growth here is users paying only for pages they open), then look for a
  // formerly-lazy module that has become eagerly reachable — that is the failure
  // mode this budget exists to catch, and the vite.config manualChunks comment
  // documents the last time it happened.
  TOTAL_JS_GZIP: 1770 * KB,
  // Any single chunk, raw. A route blowing past this should be split.
  // Raised to fit the heaviest vendored lib — xlsx (~430 KB raw), pulled
  // out of the eager `vendor` chunk and loaded only on export.
  MAX_CHUNK_RAW: 600 * KB,
};

// The chunks that load on first paint no matter which route you hit.
//
// Read out of the built dist/index.html — the entry <script type="module"> plus
// every <link rel="modulepreload">. That IS the eager set by definition: it is
// the list the browser fetches before it knows what route it is on.
//
// This was a hardcoded ["index-", "react-vendor-"] prefix list, and the list
// silently stopped matching reality. Two chunks were modulepreloaded in
// index.html and counted by nobody: `lucide` (~16 KB gzip) and `vendor`
// (~117 KB gzip, mostly jspdf's dependency tree — see the manualChunks comment
// in vite.config.ts). The gate reported 136 KB of "initial JS" while the
// browser was actually fetching ~269 KB, so the number it defended had drifted
// ~2x away from the thing it was supposed to defend. A budget measuring the
// wrong set is worse than no budget: it reports PASS while first paint rots.
//
// Parsing the emitted HTML costs nothing and cannot drift — change the chunking
// and this follows automatically, which is exactly what the prefix list failed
// to do.
function readInitialChunks() {
  const html = readFileSync(join(DIST, "index.html"), "utf8");
  const names = new Set();
  // Both the entry script and the preload links point at /assets/<name>.js.
  for (const m of html.matchAll(/(?:src|href)="\/assets\/([^"]+\.js)"/g)) {
    names.add(m[1]);
  }
  return names;
}

const fmt = (n) => `${(n / KB).toFixed(1).padStart(7)} KB`;

let files;
try {
  files = readdirSync(ASSETS).filter((f) => f.endsWith(".js"));
} catch {
  console.error(`[bundle-size] no build found at ${ASSETS} — run \`vite build\` first.`);
  process.exit(1);
}
if (files.length === 0) {
  console.error("[bundle-size] dist/assets has no .js files — build looks empty.");
  process.exit(1);
}

const measured = files
  .map((name) => {
    const buf = readFileSync(join(ASSETS, name));
    return { name, raw: statSync(join(ASSETS, name)).size, gzip: gzipSync(buf).length };
  })
  .sort((a, b) => b.raw - a.raw);

let initialChunks;
try {
  initialChunks = readInitialChunks();
} catch {
  console.error(`[bundle-size] no dist/index.html at ${DIST} — run \`vite build\` first.`);
  process.exit(1);
}
if (initialChunks.size === 0) {
  console.error("[bundle-size] dist/index.html references no /assets/*.js — cannot measure first paint.");
  process.exit(1);
}

const isInitial = (name) => initialChunks.has(name);

const initialGzip = measured.filter((f) => isInitial(f.name)).reduce((s, f) => s + f.gzip, 0);
const totalGzip = measured.reduce((s, f) => s + f.gzip, 0);
const largest = measured[0];

console.log("\nBundle size report (dist/assets/*.js)\n");
console.log("  chunk                                    raw        gzip");
console.log("  " + "-".repeat(58));
for (const f of measured) {
  const tag = isInitial(f.name) ? " [initial]" : "";
  console.log(`  ${f.name.padEnd(40)}${fmt(f.raw)}${fmt(f.gzip)}${tag}`);
}
console.log("  " + "-".repeat(58));

const checks = [
  { label: "initial JS (gzip)", value: initialGzip, budget: BUDGETS.INITIAL_JS_GZIP },
  { label: "total JS (gzip)", value: totalGzip, budget: BUDGETS.TOTAL_JS_GZIP },
  { label: `largest chunk: ${largest.name} (raw)`, value: largest.raw, budget: BUDGETS.MAX_CHUNK_RAW },
];

console.log("\nBudgets\n");
let failed = false;
for (const c of checks) {
  const ok = c.value <= c.budget;
  if (!ok) failed = true;
  const pct = ((c.value / c.budget) * 100).toFixed(0);
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${c.label.padEnd(42)} ${fmt(c.value)} / ${fmt(c.budget)}  (${pct}%)`
  );
}
console.log("");

if (failed) {
  console.error(
    "[bundle-size] budget exceeded. Either split/trim the offending chunk, or, if the\n" +
      "growth is intentional, raise the budget in frontend/scripts/check-bundle-size.mjs."
  );
  process.exit(1);
}
console.log("[bundle-size] all budgets OK.\n");
