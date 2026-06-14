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
  // This is what blocks first paint regardless of route.
  INITIAL_JS_GZIP: 115 * KB,
  // Everything the app can lazy-load (users only fetch the routes they
  // visit). Soft guard against unbounded total growth, not a first-paint
  // cost — headroom left for in-flight features (User Management, etc.).
  TOTAL_JS_GZIP: 520 * KB,
  // Any single chunk, raw. A route blowing past this should be split.
  MAX_CHUNK_RAW: 260 * KB,
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
