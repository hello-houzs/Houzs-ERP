#!/usr/bin/env node
/**
 * Generate `backend/src/services/positionAccessSnapshot.ts` from the LIVE
 * `position_page_access` rows, by calling GET /api/positions/page-access/export.
 *
 * WHY THIS IS A SCRIPT AND NOT A HUMAN WITH A KEYBOARD. The whole point of the
 * snapshot is that the owner does not re-configure a single cell. He said it
 * four times: "那我之前很多（例如銷售員看不到的東西等等）還要重新設定過嗎?" and
 * "如果你能在拆掉的同時，又保持我現在看到的東西和我會 edit 的東西完全不受影響，
 * 每一個 position 的數據都保留". 17 positions x ~26 keys is ~442 cells; a human
 * or an LLM transcribing them will get one wrong, and one wrong cell is a real
 * employee locked out of their job on a Monday. So the snapshot is MECHANICAL:
 * a photograph of his rows, never a redrawing. Reconstructing it from code,
 * from git history, or from memory is the one failure this exists to prevent —
 * the code demonstrably cannot answer what a position sees (nav ORs
 * anyPerm/anyAccess, navFilter.ts:76-91), and on 2026-07-17 a report made from
 * the code alone was wrong and the owner corrected it from memory.
 *
 * Usage — TWO ways in, and --input is the one that works:
 *
 *   1. --input <file>   Read a JSON export already on disk. This is the real
 *                       path. Team -> Positions has an Export button that
 *                       downloads exactly this file; the owner clicks it and
 *                       the file lands in Downloads. No credential is handled
 *                       by anyone but his own browser.
 *
 *   2. --url + --token  Fetch it directly. Kept for a caller who legitimately
 *                       holds a bearer token, but note what 2026-07-17 proved:
 *                       $DASHBOARD_API_KEY is a Cloudflare secret and secrets
 *                       there are WRITE-ONLY BY DESIGN. Nobody can read it back
 *                       — not tooling, not the owner. The command this file
 *                       used to advertise could not be run by anyone. That is
 *                       why (1) exists, and why it is listed first.
 *
 * Real invocation (PROD):
 *   node backend/scripts/export-position-access.mjs \
 *     --input ~/Downloads/houzs-position-access.json
 *
 * Flags:
 *   --input          Path to a JSON export on disk (from the Export button).
 *                    Mutually exclusive with --url; every guard below still
 *                    applies, INCLUDING the prod check — a file read from disk
 *                    is not more trustworthy than one fetched, it is only
 *                    easier to obtain.
 *   --url            API base URL. Required unless --input.
 *   --token          Bearer token. Defaults to $DASHBOARD_API_KEY.
 *   --out            Output path. Defaults to src/services/positionAccessSnapshot.ts
 *   --json           Also write the raw export JSON here (for review/diffing).
 *   --allow-nonprod  Permit generating from a non-prod URL. Off by default:
 *                    staging is a DIFFERENT Supabase project with different
 *                    rows, and a staging snapshot shipped as prod's would
 *                    overwrite real access with test data.
 *   --dry            Print the summary and write nothing.
 *
 * Idempotency: re-running against unchanged rows produces a byte-identical
 * file. Positions sort by id, page keys sort lexicographically, and timestamps
 * are not exported — so a diff on this file is a real access change, never
 * churn. `generatedAt` is deliberately NOT written into the module for the same
 * reason; the provenance that matters (which DB) is.
 */
import { writeFileSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const INPUT = arg("input");
const BASE = (arg("url") || process.env.EXPORT_URL || "").replace(/\/$/, "");
const TOKEN = arg("token") || process.env.DASHBOARD_API_KEY || "";
const OUT = resolve(__dirname, "..", arg("out") || "src/services/positionAccessSnapshot.ts");
const JSON_OUT = arg("json");
const DRY = has("dry");

// --input and --url answer the same question from different places. Taking both
// would mean silently picking one, and the wrong pick writes a snapshot from a
// source the operator did not mean — the exact class of invisible error the
// guards below exist to stop.
if (INPUT && BASE) {
  console.error("[export] --input and --url are mutually exclusive. Pass one.");
  process.exit(2);
}
if (!INPUT && !BASE) {
  console.error("[export] no --input and no --url. See the header of this file.");
  process.exit(2);
}

let data;
if (INPUT) {
  const path = resolve(process.cwd(), INPUT);
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    console.error(`[export] could not read ${path} — ${e.message}`);
    process.exit(2);
  }
  try {
    data = JSON.parse(raw);
  } catch (e) {
    // A truncated or HTML-error-page download parses as neither, and silently
    // treating it as "no data" is how an empty snapshot ships. Fail loudly.
    console.error(`[export] ${path} is not valid JSON — ${e.message}`);
    process.exit(2);
  }
} else {
  if (!TOKEN) {
    console.error(
      "[export] no --token and no $DASHBOARD_API_KEY.\n" +
        "         Note $DASHBOARD_API_KEY cannot be read back out of Cloudflare —\n" +
        "         secrets there are write-only. Use --input with the file from the\n" +
        "         Export button on Team -> Positions.",
    );
    process.exit(2);
  }
  const res = await fetch(`${BASE}/api/positions/page-access/export`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) {
    console.error(`[export] HTTP ${res.status} — ${(await res.text()).slice(0, 400)}`);
    process.exit(1);
  }
  data = await res.json();
}

// ---- Refuse to write anything questionable -------------------------------
// Every check below prefers writing NOTHING over writing something plausible.
// A missing snapshot is a visible failure; a subtly wrong one is an invisible
// one that surfaces as a locked-out employee weeks later.

if (!Array.isArray(data.positions) || data.positions.length === 0) {
  console.error("[export] the export returned no positions — refusing to write an empty snapshot.");
  process.exit(1);
}
if ((data.totals?.explicit_rows ?? 0) === 0) {
  console.error(
    "[export] the export returned 0 explicit rows across every position. That is not a\n" +
      "         plausible photograph of a live matrix — it is far more likely the wrong DB\n" +
      "         or an empty one. Refusing to write.",
  );
  process.exit(1);
}

const from = String(data.generatedFrom ?? "");
const looksProd = /houzscentury\.com|houzs-erp\.pages\.dev|autocount-sync-api\.houzs-erp\.workers\.dev/.test(from) &&
  !/staging/i.test(from);
if (!looksProd && !has("allow-nonprod")) {
  console.error(
    `[export] generatedFrom = "${from}" does not look like PROD.\n` +
      "         Staging is a different Supabase project with different rows; a staging\n" +
      "         snapshot shipped as prod's would overwrite real people's access with test\n" +
      "         data. Re-run against prod, or pass --allow-nonprod if you genuinely mean it.",
  );
  process.exit(1);
}

// ---- Summary -------------------------------------------------------------
console.log(`[export] from            : ${from}`);
console.log(`[export] positions       : ${data.totals.positions}`);
console.log(`[export] explicit rows   : ${data.totals.explicit_rows}`);
console.log(`[export] orphan rows     : ${data.totals.orphan_rows}  (page_key not in the registry)`);
console.log(`[export] gap cells       : ${data.totals.gap_cells}  (registry page with NO row)`);
console.log(`[export] registry pages  : ${data.registryPageCount}`);
for (const p of data.positions) {
  const n = Object.keys(p.entries).length;
  const flags = [
    p.orphan_keys.length ? `${p.orphan_keys.length} orphan` : null,
    n === 0 ? "NO ROWS AT ALL" : null,
  ].filter(Boolean);
  console.log(
    `  #${String(p.id).padStart(3)} ${(p.name ?? "").padEnd(28)} ${String(n).padStart(3)} rows` +
      (flags.length ? `   [${flags.join(", ")}]` : ""),
  );
}

if (JSON_OUT) {
  const jsonPath = resolve(process.cwd(), JSON_OUT);
  if (!DRY) writeFileSync(jsonPath, JSON.stringify(data, null, 2) + "\n", "utf8");
  console.log(`[export] raw JSON -> ${jsonPath}${DRY ? " (dry, not written)" : ""}`);
}

// ---- Emit the module -----------------------------------------------------
// `entries` carries the EXPLICIT rows only — exactly what is in the table, and
// nothing for what is not. This is load-bearing: an absent row and a
// `level:"none"` row are different facts. loadPageAccessForPosition resolves a
// child as `explicit[key] ?? out[parent]` (pageAccess.ts:748) — absent means
// INHERIT, "none" means DENIED even under a full parent. Backfilling the gaps
// here would nail every child to today's parent value and sever the
// inheritance he set up. The gaps stay gaps.
// Joined with a `//` continuation, NOT ` * ` — this is emitted into a
// line-comment header, and the old ` * ` join produced a broken hybrid the
// generated file carried on every line but the first.
//
// It advertises --input, not --token. The old command named
// $DASHBOARD_API_KEY, which is a Cloudflare secret: write-only by design and
// unreadable by anyone, the owner included. This file's own regenerate
// instruction could not be followed by the person it was written for.
const REGEN = [
  "node backend/scripts/export-position-access.mjs \\",
  "  --input ~/Downloads/houzs-position-access.json",
  "",
  "(the JSON comes from the Export button on Team -> Positions)",
].join("\n//   ");

const positions = [...data.positions].sort((a, b) => a.id - b.id);

const body = positions
  .map((p) => {
    const keys = Object.keys(p.entries).sort();
    const entries = keys.map((k) => `      ${JSON.stringify(k)}: ${JSON.stringify(p.entries[k])},`);
    const notes = [
      `  // ${p.department_name ?? "(no department)"}${p.active ? "" : " - INACTIVE"}`,
      p.orphan_keys.length
        ? `  // orphan keys (not in the page registry, inert at login): ${p.orphan_keys.join(", ")}`
        : null,
      keys.length === 0
        ? "  // NO EXPLICIT ROWS - this position was never configured. That is a GAP, not a\n  // decision to deny. Do not read it as \"none\"."
        : null,
    ].filter(Boolean);
    return [
      notes.join("\n"),
      `  {`,
      `    id: ${p.id},`,
      `    name: ${JSON.stringify(p.name)},`,
      `    slug: ${JSON.stringify(p.slug)},`,
      `    department_id: ${p.department_id === null ? "null" : p.department_id},`,
      `    department_name: ${JSON.stringify(p.department_name)},`,
      `    entries: {`,
      ...(entries.length ? entries : ["      // (none)"]),
      `    },`,
      `  },`,
    ].join("\n");
  })
  .join("\n");

const file = `// ----------------------------------------------------------------------------
// positionAccessSnapshot — a PHOTOGRAPH of \`position_page_access\`, generated.
//
// DO NOT HAND-EDIT. DO NOT "fix" a cell that looks wrong to you. Every value
// here was read out of the owner's live rows by a script. If a cell is wrong,
// the TABLE is wrong — change it there and regenerate, or the next regeneration
// silently reverts you.
//
// Regenerate:
//   ${REGEN}
//
// Generated from : ${from}
// Positions      : ${data.totals.positions}
// Explicit rows  : ${data.totals.explicit_rows}
// Orphan rows    : ${data.totals.orphan_rows} (page_key absent from the registry; inert at login)
// Gap cells      : ${data.totals.gap_cells} (registry page with no row for that position)
//
// WHY A PHOTOGRAPH AND NOT A REDRAWING. The rules are moving out of this matrix
// and into backend code, one JD at a time (services/salesJdAccess.ts is the
// first). The owner's constraint on that move is the whole acceptance test:
// "如果你能在拆掉的同時，又保持我現在看到的東西和我會 edit 的東西完全不受影響，
// 每一個 position 的數據都保留". He must not re-configure a single cell — so the
// values cannot be inferred from code, reconstructed from git history, or
// recalled from memory. They are read from his rows. On 2026-07-17 a report of
// Sales Director's access made from the code alone was WRONG and he corrected
// it from memory: nav visibility ORs anyPerm/anyAccess (navFilter.ts:76-91) and
// with scm_l2_configured the scm.access term is dropped, so for a non-\`*\` user
// the matrix cell alone decides. The data is the authority, not the code.
//
// \`entries\` IS THE EXPLICIT ROWS ONLY — the keys that HAVE a row. A key absent
// from \`entries\` had NO ROW, which is NOT the same fact as a row of "none":
// loadPageAccessForPosition resolves a child as \`explicit[key] ?? out[parent]\`
// (pageAccess.ts:748), so absent means INHERIT THE PARENT and "none" means
// DENIED even under a full parent. Anything that consumes this must preserve
// that distinction. Backfilling the gaps to "none" would sever inheritance on
// every child and is exactly the bug this file is built to avoid
// (reference_houzs_nullish_hides_ignorance).
//
// NOT WIRED. Nothing reads this yet. auth.ts still hydrates page_access from
// the live table (auth.ts:295-299) and the matrix is still editable. The
// sequence is deliberate: export -> the owner reviews the table -> he states
// his adjustments -> we encode them -> THEN the switch. Shipping the switch
// before he has reviewed the table is what would force him to reconfigure.
// ----------------------------------------------------------------------------

import type { AccessLevel } from "./pageAccess";

export interface PositionAccessSnapshotEntry {
  id: number;
  name: string;
  slug: string;
  department_id: number | null;
  department_name: string | null;
  /** EXPLICIT rows only. An absent key means NO ROW (inherit), not "none". */
  entries: Readonly<Partial<Record<string, AccessLevel>>>;
}

/** Which database this was photographed from. Provenance is part of the data:
 *  staging and prod are different Supabase projects with different rows. */
export const POSITION_ACCESS_SNAPSHOT_SOURCE = ${JSON.stringify(from)};

export const POSITION_ACCESS_SNAPSHOT: readonly PositionAccessSnapshotEntry[] = [
${body}
];
`;

if (DRY) {
  console.log(`[export] dry — would write ${OUT} (${file.split("\n").length} lines)`);
} else {
  writeFileSync(OUT, file, "utf8");
  console.log(`[export] wrote ${OUT} (${file.split("\n").length} lines)`);
}
