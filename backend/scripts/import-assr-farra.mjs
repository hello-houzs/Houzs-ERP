#!/usr/bin/env node
/**
 * Import ASSR cases from the "assr case farra" Google Sheet.
 *
 *   node scripts/import-assr-farra.mjs <tsv> [--dry] [--wipe] [--limit N] [--owner-email <email>]
 *
 * Prod is Supabase Postgres now (post 2026-06-13 cutover). This
 * replaces the old seed-assr-cases.mjs which targeted D1 and mapped
 * to the pre-v3.1 6-stage flow. Attachments are NOT handled here —
 * see notes at the bottom.
 *
 * Idempotent on assr_no: rerunning without --wipe skips rows whose
 * assr_no already exists.
 */
import { readFileSync } from "node:fs";
import postgres from "postgres";

// ── CLI ────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const tsvPath = argv.find((a) => !a.startsWith("--"));
if (!tsvPath) {
  console.error("usage: node scripts/import-assr-farra.mjs <tsv> [--dry] [--wipe] [--limit N] [--owner-email <email>]");
  process.exit(2);
}
const dry = argv.includes("--dry");
const wipe = argv.includes("--wipe");
const limitIdx = argv.indexOf("--limit");
const LIMIT = limitIdx >= 0 ? parseInt(argv[limitIdx + 1], 10) : null;
const ownerEmailIdx = argv.indexOf("--owner-email");
const OWNER_EMAIL =
  ownerEmailIdx >= 0 ? argv[ownerEmailIdx + 1] : (process.env.OWNER_EMAIL || "hello@houzscentury.com");

// ── DB ─────────────────────────────────────────────────────────
import { existsSync } from "node:fs";
const dotEnv = existsSync(".dev.vars") ? ".dev.vars" : "backend/.dev.vars";
const dbUrl = readFileSync(dotEnv, "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
if (!dbUrl) {
  console.error("DATABASE_URL not found in backend/.dev.vars");
  process.exit(2);
}
const pg = postgres(dbUrl, { ssl: "require", prepare: false, max: 1 });

// ── Stage mapping (v3.1 nine-stage, mig 074) ───────────────────
const STAGE_MAP = {
  "Completed":                "completed",
  "Pending Delivery/Service": "pending_delivery_service",
  "Pending Delivery / Service": "pending_delivery_service",
  "Pending Item Ready":       "pending_item_ready",
  "Pending Supplier Pickup":  "pending_supplier_pickup",
  "Pending Item Pickup":      "pending_item_pickup",
  "Pending Inspection":       "pending_inspection",
  "Pending Solution":         "pending_solution",
  "Under Verification":       "under_verification",
  "Pending Review":           "pending_review",
  "Open":                     "pending_review",
  "":                         "pending_review",
};

function statusForStage(stage) {
  if (stage === "pending_review") return "Open";
  if (stage === "completed") return "Closed";
  return "In Progress";
}

// Default per-stage target days — matches DEFAULT_STAGE_TARGET_DAYS
// in services/assr.ts. Used as fallback when the priority-specific
// lookup misses (historical rows all import as 'normal').
const DEFAULT_STAGE_TARGET_DAYS = {
  pending_review: 1,
  under_verification: 2,
  pending_solution: 2,
  pending_inspection: 2,
  pending_item_pickup: 2,
  pending_supplier_pickup: 3,
  pending_item_ready: 5,
  pending_delivery_service: 4,
  completed: 0,
};

// ── TSV parser (kept in-sync with seed-assr-cases.mjs semantics) ─
function parseDate(s) {
  if (s == null) return null;
  const t = String(s).trim();
  if (!t) return null;
  if (t === "*" || t === "-" || t === "—") return null;
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = t.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}

function parseTsv(path) {
  const raw = readFileSync(path, "utf8");
  const lines = raw.split(/\r?\n/);
  const headerRow = lines.findIndex((l) => /^ASSR Status\tS\/O\tASSR NO\b/.test(l));
  if (headerRow < 0) throw new Error("Couldn't find header row (`ASSR Status\\tS/O\\tASSR NO`)");
  const headers = lines[headerRow].split("\t").map((h) => h.trim());
  const rows = [];
  for (let i = headerRow + 1; i < lines.length; i++) {
    const cells = lines[i].split("\t");
    if (cells.every((c) => !c || !c.trim())) continue;
    const row = {};
    headers.forEach((h, j) => (row[h] = (cells[j] ?? "").trim()));
    rows.push(row);
  }
  return rows;
}

// ── Parse rows first — dry-run never needs the DB ──────────────
const rows = parseTsv(tsvPath);
console.log(`▶ Parsed ${rows.length} candidate row(s)`);

let ownerId = null;
let activeProfileId = null;
let existing = new Set();
if (!dry) {
  console.log(`▶ Owner: ${OWNER_EMAIL}`);
  const [ownerRow] = await pg`SELECT id FROM users WHERE email = ${OWNER_EMAIL}`;
  if (!ownerRow) { console.error(`No user for ${OWNER_EMAIL}`); process.exit(1); }
  ownerId = ownerRow.id;
  console.log(`  ownerId=${ownerId}`);

  const profileRow = await pg`SELECT id FROM assr_lead_time_profiles WHERE is_active = 1 LIMIT 1`;
  activeProfileId = profileRow[0]?.id ?? null;
  console.log(`  activeProfileId=${activeProfileId ?? "(none)"}`);

  if (!wipe) {
    const exRows = await pg`SELECT assr_no FROM assr_cases WHERE assr_no IS NOT NULL`;
    existing = new Set(exRows.map((r) => r.assr_no));
    console.log(`  existing assr_no on remote: ${existing.size}`);
  }
}

const planned = [];
let skipped = 0;

for (const row of rows) {
  const assrNo = (row["ASSR NO"] ?? "").trim();
  if (!assrNo || assrNo === "ASSR NO") { skipped++; continue; }
  if (existing.has(assrNo)) { skipped++; continue; }
  if (LIMIT && planned.length >= LIMIT) break;

  const statusText = (row["ASSR Status"] ?? "").trim();
  const stage = STAGE_MAP[statusText] ?? "pending_review";
  const docNo = (row["S/O"] ?? "").trim() || "";
  const customerName = (row["Customer Name"] ?? "").trim() || null;
  const phone = (row["HP"] ?? "").trim() || null;
  const location = (row["Location"] ?? "").trim() || null;
  const salesAgent = (row["Sales Agent"] ?? "").trim() || null;
  const itemCode =
    (row["Item Details"] ?? row["Service Item Code"] ?? row["Item"] ?? "").trim() || null;
  const complaint =
    (row["Complant issue"] ?? row["Complaint issue"] ?? row["Complaint"] ?? "").trim() || null;
  const actionRemark =
    (row["Action Taken : (Summarize)"] ?? row["Action Taken"] ?? "").trim() || null;
  const callLog = (row["Call Log: Purchasing Action Taken"] ?? "").trim() || null;
  const supplier = (row["Supplier"] ?? "").trim() || null;
  const poNo = (row["PO No"] ?? "").trim() || null;
  const refNo = (row["Ref No"] ?? "").trim() || null;
  const serviceCategory = (row["Service Category"] ?? "").trim() || null;
  const addr1 = (row["Address 1"] ?? "").trim() || null;
  const addr2 = (row["Address 2"] ?? "").trim() || null;
  const addr3 = (row["Address 3"] ?? "").trim() || null;
  const addr4 = (row["Address 4"] ?? "").trim() || null;

  const complainedDate = parseDate(row["Complained date"]);
  const completionDate = parseDate(
    row["Service Delivery Date (Completion)"] ?? row["Completion Date"]
  );
  const closedAt = stage === "completed" ? completionDate : null;

  // Fold columns without dedicated destination into complaint_issue
  // as tagged suffixes so historical context isn't lost. The primary
  // complaint text stays first; context blocks are separated visually.
  const parts = [];
  if (complaint) parts.push(complaint);
  if (actionRemark) parts.push(`[Action] ${actionRemark}`);
  if (callLog) parts.push(`[Purchasing] ${callLog}`);
  if (supplier) parts.push(`[Supplier] ${supplier}`);
  if (refNo) parts.push(`[Ref] ${refNo}`);
  const complaintText = parts.join("\n\n") || "(no description on import)";

  const priority = "normal";
  const slaHours = 168;
  // For imported historical rows, anchor deadline_at at complained_date
  // + SLA when unresolved so overdue reports still highlight legit
  // stragglers. Closed rows get NULL — no active SLA to report on.
  const deadlineAt =
    stage === "completed" || !complainedDate
      ? null
      : new Date(new Date(complainedDate).getTime() + slaHours * 3600 * 1000).toISOString();

  const stageTargetDays = DEFAULT_STAGE_TARGET_DAYS[stage] ?? 2;
  const stageEnteredAt = (closedAt ?? complainedDate ?? new Date().toISOString().slice(0, 10)) + "T00:00:00Z";
  const stageChangedAt = stageEnteredAt;
  const createdAt = complainedDate ? complainedDate + "T00:00:00Z" : new Date().toISOString();

  planned.push({
    assrNo, docNo, complainedDate, customerName, phone, location, salesAgent,
    itemCode, complaintText, serviceCategory, poNo, addr1, addr2, addr3, addr4,
    stage, sysStatus: statusForStage(stage),
    priority, slaHours, deadlineAt,
    stageEnteredAt, stageTargetDays, stageChangedAt,
    createdAt, closedAt,
  });
}

console.log(`▶ Planned ${planned.length}; skipped ${skipped}`);
if (planned.length === 0 && !wipe) { console.log("Nothing to do."); await pg.end(); process.exit(0); }

if (dry) {
  console.log("\n── Dry-run sample (first 3) ─────────────────────────");
  for (const p of planned.slice(0, 3)) console.log(JSON.stringify(p, null, 2));
  console.log("\n(--dry: not writing)");
  await pg.end();
  process.exit(0);
}

// ── Write ──────────────────────────────────────────────────────
if (wipe) {
  console.log("▶ Wiping assr_cases (children cascade)…");
  await pg`DELETE FROM assr_cases`;
}

let inserted = 0;
let failed = 0;
for (const p of planned) {
  try {
    await pg.begin(async (tx) => {
      const [caseRow] = await tx`
        INSERT INTO assr_cases (
          assr_no, status, stage, doc_no, complained_date,
          customer_name, phone, location, sales_agent, item_code,
          complaint_issue, priority, po_no, addr1, addr2, addr3, addr4,
          created_by, assigned_to, sla_hours, deadline_at,
          stage_entered_at, stage_target_days, stage_changed_at,
          lead_time_profile_id, created_at
        ) VALUES (
          ${p.assrNo}, ${p.sysStatus}, ${p.stage}, ${p.docNo}, ${p.complainedDate},
          ${p.customerName}, ${p.phone}, ${p.location}, ${p.salesAgent}, ${p.itemCode},
          ${p.complaintText}, ${p.priority}, ${p.poNo}, ${p.addr1}, ${p.addr2}, ${p.addr3}, ${p.addr4},
          ${ownerId}, ${ownerId}, ${p.slaHours}, ${p.deadlineAt},
          ${p.stageEnteredAt}, ${p.stageTargetDays}, ${p.stageChangedAt},
          ${activeProfileId}, ${p.createdAt}
        )
        RETURNING id
      `;
      await tx`
        INSERT INTO assr_stage_history (assr_id, stage, entered_at, target_days, alerts_fired)
        VALUES (${caseRow.id}, ${p.stage}, ${p.stageEnteredAt}, ${p.stageTargetDays}, 1)
      `;
      if (p.itemCode) {
        await tx`
          INSERT INTO assr_items (assr_id, item_code, item_description, qty)
          VALUES (${caseRow.id}, ${p.itemCode}, ${null}, ${1})
        `;
      }
    });
    inserted++;
    if (inserted % 50 === 0) console.log(`  … ${inserted}/${planned.length}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL ${p.assrNo}: ${e.message}`);
  }
}

console.log(`\nDone. inserted=${inserted}, failed=${failed}`);
await pg.end();

// ── Attachments (phase 2) ──────────────────────────────────────
// Photos in the sheet live on Google Drive. Migrating them means:
//   1. Grant this script Drive read access (service-account JSON or
//      "anyone with the link can view" on the folder).
//   2. For each linked file: fetch via
//      https://drive.google.com/uc?export=download&id=<FILE_ID>
//      (25 MB+ files hit the confirm interstitial — needs a cookie
//      round-trip; use the Drive REST API if the folder is large).
//   3. Upload to R2 under the standard key
//      (see assrAttachmentKey in services/assr.ts).
//   4. Insert into assr_attachments with the r2_key + case id.
// Left out of this pass so text rows can land first — user can start
// working from the imported cases immediately.
