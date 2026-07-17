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
// Run locally: `npm run build && node scripts/check-bundle-size.mjs`

import { readdirSync, readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "assets");

// Budgets. KB = 1000 bytes (matches Vite's build output, not 1024).
const KB = 1000;
const BUDGETS = {
  // Always-loaded path: the entry chunk + the shared react vendor chunk.
  // This is what blocks first paint regardless of route. Raised 115 -> 118
  // on 2026-06-25 for the SCM 2990 cutover; 118 -> 120 on 2026-06-30 for
  // ~3 KB of entry-chunk drift since (shell + route-table additions, not a
  // stray heavy import — lucide lives in its own chunk and is not counted
  // here). The pieces here are framework + shell, so keep this tight enough
  // that a real regression still trips it. 130 -> 136 on 2026-07-16: the 130
  // headroom was fully consumed by unrecorded shell creep (main 129.7); see the
  // dated entry in the header before bumping this again.
  INITIAL_JS_GZIP: 136 * KB,
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
  TOTAL_JS_GZIP: 1750 * KB,
  // Any single chunk, raw. A route blowing past this should be split.
  // Raised to fit the heaviest vendored lib — xlsx (~430 KB raw), pulled
  // out of the eager `vendor` chunk and loaded only on export.
  MAX_CHUNK_RAW: 600 * KB,
};

// The chunks that load on first paint no matter which route you hit.
// Matched by filename prefix (Vite appends a content hash).
const INITIAL_PREFIXES = ["index-", "react-vendor-"];

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

const isInitial = (name) => INITIAL_PREFIXES.some((p) => name.startsWith(p));

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
