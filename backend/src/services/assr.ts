import type { Env } from "../types";
import { todayMyt } from "../scm/lib/my-time";
import { AutoCountClient, cleanPhone } from "./autocount";
import { resolveCreditorForCase } from "./stockItems";
import { getActiveStaffToken } from "./caseTracking";

// ── Types ─────────────────────────────────────────────────────

export interface CreateAssrInput {
  doc_no: string;
  items: { item_code: string; item_description?: string; qty?: number }[];
  complaint_issue: string;
  /** Optional issue taxonomy entry captured at create time. Free-text
   *  string ("Product defect", "Missing / short item", or admin
   *  custom). Replaces the older service_category-driven flow on the
   *  intake form. */
  issue_category?: string | null;
  /** Optional priority slug — drives both `sla_hours` and the per-stage
   *  target snapshot (mig 082). Defaults to 'normal' when omitted. */
  priority?: string | null;
  created_by?: number;
}

// v3.1 9-stage workflow. Old enum (registration / triage / action /
// logistics / resolution / closed) was renamed in mig 074. Inspection
// is now its own stage, and the legacy "logistics" stage split into 4
// explicit handover steps (item pickup / supplier pickup / item ready
// / delivery).
export type Stage =
  | "pending_review"            // Stage 1 — Service Admin
  | "under_verification"        // Stage 2 — Service Admin
  | "pending_solution"          // Stage 3 — Service Admin / Manager
  | "pending_inspection"        // Stage 4 — SA assigns Logistic Admin
  | "pending_item_pickup"       // Stage 5 — SA assigns Logistic Admin
  | "pending_supplier_pickup"   // Stage 6 — SA contacts supplier
  | "pending_item_ready"        // Stage 7 — SA updates on supplier return
  | "pending_delivery_service"  // Stage 8 — SA assigns Logistic Admin
  | "completed";                // Stage 9 — system

type Priority = "low" | "normal" | "high" | "urgent";

// Default SLA in hours per priority — single source of truth.
// Mirrors the backfill in 012_assr_sla.sql so new + historical rows align.
const SLA_HOURS_BY_PRIORITY: Record<Priority, number> = {
  urgent: 24,
  high: 72,
  normal: 168,  // 7 days
  low: 336,     // 14 days
};

export function slaHoursFor(priority: string | null | undefined): number {
  return SLA_HOURS_BY_PRIORITY[(priority as Priority) || "normal"] ?? 168;
}

// Maps stage → user-facing status (backward compat for legacy list
// renderers that still read `status`).
function statusForStage(stage: Stage): string {
  if (stage === "pending_review") return "Open";
  if (stage === "completed") return "Closed";
  return "In Progress";
}

// Stage transitions are unrestricted — ops can revert (e.g. flip a
// completed case back when the customer reports the same issue) or
// skip (proposal §8.3 legitimate skips: Replace Unit with in-stock SKU
// skips inspection + supplier pickup + item ready; Field Service Own
// Team skips supplier pickup + item ready; Return Visit skips item
// pickup + supplier pickup + item ready). The CHECK on the column
// still bounds the value set so bad inputs fail loud.
export const ALL_STAGES: ReadonlyArray<Stage> = [
  "pending_review",
  "under_verification",
  "pending_solution",
  "pending_inspection",
  "pending_item_pickup",
  "pending_supplier_pickup",
  "pending_item_ready",
  "pending_delivery_service",
  "completed",
];

// Default per-stage target days (proposal §8.1 — Normal profile).
// Phase B replaces this fallback with a lookup against the active
// assr_lead_time_profiles + assr_stage_targets row.
const DEFAULT_STAGE_TARGET_DAYS: Record<Stage, number> = {
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

/**
 * Snapshot of the per-stage target in days at the moment a case
 * enters that stage. Lookup order (mig 082 layered the priority
 * source on top of the existing profile):
 *
 *   1. The case's priority — `assr_priority_stage_targets` row for
 *      this (priority_slug, stage). Allows Urgent / Low to compress
 *      or stretch each stage independently.
 *   2. The currently-active Lead Time profile (mig 075) — fallback
 *      for legacy cases without a priority or priorities that haven't
 *      had targets defined yet.
 *   3. The hardcoded Normal defaults — last-resort safety net so a
 *      stage transition can never crash on missing config.
 */
async function lookupStageTargetDays(
  env: Env,
  stage: Stage,
  prioritySlug?: string | null
): Promise<number> {
  if (prioritySlug) {
    try {
      const row = await env.DB.prepare(
        `SELECT t.target_days
           FROM assr_priority_stage_targets t
           JOIN assr_priorities p ON p.id = t.priority_id
          WHERE p.slug = ? AND t.stage = ?
          LIMIT 1`
      )
        .bind(prioritySlug, stage)
        .first<{ target_days: number }>();
      if (row?.target_days != null) return row.target_days;
    } catch (e) {
      console.warn("[assr.lookupStageTargetDays] priority read failed:", e);
    }
  }
  try {
    const row = await env.DB.prepare(
      `SELECT t.target_days
         FROM assr_stage_targets t
         JOIN assr_lead_time_profiles p ON p.id = t.profile_id
        WHERE p.is_active = 1 AND t.stage = ?
        LIMIT 1`
    )
      .bind(stage)
      .first<{ target_days: number }>();
    if (row?.target_days != null) return row.target_days;
  } catch (e) {
    console.warn("[assr.lookupStageTargetDays] profile read failed:", e);
  }
  return DEFAULT_STAGE_TARGET_DAYS[stage] ?? 0;
}

/**
 * Returns the active Lead Time profile id, or null if none exists.
 * Stamped onto `assr_cases.lead_time_profile_id` at create time so
 * SLA accounting stays deterministic across amendments.
 */
export async function getActiveLeadTimeProfileId(env: Env): Promise<number | null> {
  try {
    const row = await env.DB.prepare(
      `SELECT id FROM assr_lead_time_profiles WHERE is_active = 1 LIMIT 1`
    ).first<{ id: number }>();
    return row?.id ?? null;
  } catch (e) {
    console.warn("[assr.getActiveLeadTimeProfileId] read failed:", e);
    return null;
  }
}

// ── PO number generator (internal / service-issued) ───────────

/**
 * Generates the next internal service PO number in format
 * APO/YYMM-NNN (Assr Purchase Order). Sequence resets each month
 * and is based on the highest existing po_no in assr_cases that
 * matches the prefix — no dedicated counter table.
 */
export async function nextServicePONumber(env: Env): Promise<string> {
  const now = new Date();
  const yy = String(now.getUTCFullYear()).slice(-2);
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const prefix = `APO/${yy}${mm}`;

  const row = await env.DB.prepare(
    `SELECT po_no FROM assr_cases
      WHERE po_no LIKE ?
      ORDER BY po_no DESC LIMIT 1`
  )
    .bind(`${prefix}-%`)
    .first<{ po_no: string }>();

  let next = 1;
  if (row?.po_no) {
    const seq = parseInt(row.po_no.split("-")[1] ?? "", 10);
    if (!isNaN(seq)) next = seq + 1;
  }
  return `${prefix}-${String(next).padStart(3, "0")}`;
}

// ── ASSR number generator ─────────────────────────────────────

export async function nextAssrNumber(env: Env): Promise<string> {
  const now = new Date();
  const yy = String(now.getUTCFullYear()).slice(-2);
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const prefix = `ASSR/${yy}${mm}`;

  const row = await env.DB.prepare(
    `SELECT assr_no FROM assr_cases WHERE assr_no LIKE ? ORDER BY assr_no DESC LIMIT 1`
  )
    .bind(`${prefix}-%`)
    .first<{ assr_no: string }>();

  let next = 1;
  if (row?.assr_no) {
    const parts = row.assr_no.split("-");
    const seq = parseInt(parts[1] || "", 10);
    if (!isNaN(seq)) next = seq + 1;
  }
  return `${prefix}-${String(next).padStart(3, "0")}`;
}

// ── Create case ───────────────────────────────────────────────

export async function createAssrCase(
  env: Env,
  input: CreateAssrInput
): Promise<{ assr_no: string; id: number }> {
  const client = new AutoCountClient(env);
  let context: any = null;
  try {
    context = await client.getSingle(input.doc_no);
  } catch (e) {
    console.warn(`[assr] getSingle failed for ${input.doc_no}`, e);
  }

  const assrNo = await nextAssrNumber(env);
  const today = todayMyt();
  // Use first item_code for the legacy column
  const firstItem = input.items[0]?.item_code ?? null;

  // SLA window from the case's priority (defaults to 'normal' = 168h
  // when intake didn't pick one). Priority is stored as the slug on
  // assr_cases.priority; mig 082 also drives per-stage targets off it.
  const prioritySlug = input.priority ?? "normal";
  const slaHours = slaHoursFor(prioritySlug);
  const deadlineAt = new Date(Date.now() + slaHours * 3600 * 1000).toISOString();

  // Optional default assignee — admin sets this in Settings → Service.
  // Read it on every create so a setting change takes effect without a
  // deploy. Falls back to NULL (unassigned) if missing or malformed.
  let defaultAssigneeId: number | null = null;
  try {
    const r = await env.DB.prepare(
      `SELECT value FROM system_settings WHERE key = 'assr_default_assignee_id'`
    ).first<{ value: string | null }>();
    if (r?.value != null) {
      const n = parseInt(r.value, 10);
      if (!isNaN(n)) defaultAssigneeId = n;
    }
  } catch (e) {
    console.warn("[assr.create] could not read default assignee:", e);
  }

  // v3.1 — new cases enter Stage 1 (pending_review). Stage target is
  // snapshotted from the active profile so the alert engine has a
  // deterministic SLA even if the portal is amended later. The
  // lead_time_profile_id is stamped so reporting can show which
  // profile each case ran under.
  const initialStage: Stage = "pending_review";
  // Mig 082 — pass the priority slug so the lookup checks priority
  // targets before falling back to the active Lead Time profile.
  const initialTargetDays = await lookupStageTargetDays(env, initialStage, prioritySlug);
  const activeProfileId = await getActiveLeadTimeProfileId(env);
  const nowIso = new Date().toISOString();

  const result = await env.DB.prepare(
    `INSERT INTO assr_cases (
       assr_no, status, stage, doc_no, complained_date, customer_name, phone, location,
       sales_agent, item_code, complaint_issue, issue_category, priority, po_no, addr1, addr2, addr3, addr4, created_by,
       ref_no, delivery_order, do_date,
       assigned_to, sla_hours, deadline_at,
       stage_entered_at, stage_target_days, stage_changed_at, lead_time_profile_id
     ) VALUES (?, 'Open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      assrNo,
      initialStage,
      input.doc_no,
      today,
      context?.DebtorName ?? null,
      cleanPhone(context?.Phone1),
      context?.SalesLocation ?? null,
      context?.SalesAgent ?? null,
      firstItem,
      input.complaint_issue,
      input.issue_category ?? null,
      prioritySlug,
      context?.SOUDF_ToPONo ?? null,
      context?.InvAddr1 ?? null,
      context?.InvAddr2 ?? null,
      context?.InvAddr3 ?? null,
      context?.InvAddr4 ?? null,
      input.created_by ?? null,
      // ref_no <- the SO's own customer reference (the pre-printed
      // customer docket, e.g. "HC14032"), distinct from the internal
      // service PO which maps to po_no above via SOUDF_ToPONo.
      context?.Ref ?? null,
      // delivery_order / do_date <- the SO's linked DO. The AutoCount
      // /SalesOrder/getSingle context does not expose a DO doc no or
      // date, so these stay NULL at create time (case manager fills
      // them via PATCH). Bound explicitly so the columns stay covered
      // if the context ever starts carrying DO fields.
      null,
      null,
      defaultAssigneeId,
      slaHours,
      deadlineAt,
      nowIso,
      initialTargetDays,
      nowIso,
      activeProfileId
    )
    .run();

  const assrId = result.meta.last_row_id as number;

  // Seed the per-stage lifecycle row for Stage 1 so the Workflow
  // Progress Tracker has data and the alert engine has a target.
  // alerts_fired = 1 stamps FLAG_ENTERED so the scanner doesn't
  // double-fire on first tick.
  await env.DB.prepare(
    `INSERT INTO assr_stage_history (assr_id, stage, entered_at, target_days, alerts_fired)
     VALUES (?, ?, ?, ?, 1)`
  )
    .bind(assrId, initialStage, nowIso, initialTargetDays)
    .run();

  // Insert items
  for (const item of input.items) {
    await env.DB.prepare(
      `INSERT INTO assr_items (assr_id, item_code, item_description, qty)
       VALUES (?, ?, ?, ?)`
    )
      .bind(assrId, item.item_code, item.item_description ?? null, item.qty ?? 1)
      .run();
  }

  // Activity log
  await logActivity(env, assrId, "created", null, initialStage, null, input.created_by);

  // Log the default assignment so the timeline reflects who got it.
  if (defaultAssigneeId != null) {
    await logActivity(
      env,
      assrId,
      "assignment",
      null,
      String(defaultAssigneeId),
      "default assignee",
      input.created_by
    );
  }

  // Fire-and-forget creditor resolution from the primary item. A
  // failed lookup (item unknown upstream, network, etc.) must not
  // block case creation — the case is already committed above.
  if (firstItem) {
    resolveCreditorForCase(env, assrId, firstItem).catch((e) =>
      console.warn(`[assr.create] creditor resolve failed for ${assrNo}:`, e?.message || e)
    );
  }

  return { assr_no: assrNo, id: assrId };
}

// ── Detail (composite) ───────────────────────────────────────

export async function getAssrDetail(env: Env, id: number) {
  const caseRow = await env.DB.prepare(
    `SELECT c.*,
            u1.name as assigned_to_name,
            u2.name as created_by_name,
            u3.name as approved_by_name,
            u4.name as verified_by_name,
            cr.company_name as creditor_name,
            cr.email as creditor_email,
            cr.phone1 as creditor_phone,
            cr.mobile as creditor_mobile,
            cr.attention as creditor_attention,
            CAST((julianday(c.deadline_at) - julianday('now')) * 24 AS INTEGER) as hours_to_deadline,
            CASE
              WHEN c.stage = 'completed' THEN 0
              WHEN c.deadline_at IS NOT NULL AND datetime('now') > c.deadline_at THEN 1
              ELSE 0
            END as is_breached
       FROM assr_cases c
       LEFT JOIN users u1 ON u1.id = c.assigned_to
       LEFT JOIN users u2 ON u2.id = c.created_by
       LEFT JOIN users u3 ON u3.id = c.approved_by
       LEFT JOIN users u4 ON u4.id = c.verified_by
       LEFT JOIN creditors cr ON cr.creditor_code = c.creditor_code
      WHERE c.id = ?`
  )
    .bind(id)
    .first<any>();
  if (!caseRow) return null;

  const items = await env.DB.prepare(
    `SELECT * FROM assr_items WHERE assr_id = ? ORDER BY id`
  )
    .bind(id)
    .all();

  // Child queries filter out archived rows by default. If/when a
  // manager needs to see archived children, add an endpoint that
  // takes ?include_archived=1 for surgical audits.
  const attachments = await env.DB.prepare(
    `SELECT * FROM assr_attachments
      WHERE assr_id = ? AND archived_at IS NULL
      ORDER BY created_at DESC`
  )
    .bind(id)
    .all();

  const activity = await env.DB.prepare(
    `SELECT a.*, u.name as user_name
       FROM assr_activity a
       LEFT JOIN users u ON u.id = a.user_id
      WHERE a.assr_id = ? AND a.archived_at IS NULL
      ORDER BY a.created_at DESC`
  )
    .bind(id)
    .all();

  const logistics = await env.DB.prepare(
    `SELECT l.*, u.name as assigned_to_name
       FROM assr_logistics l
       LEFT JOIN users u ON u.id = l.assigned_to
      WHERE l.assr_id = ? AND l.archived_at IS NULL
      ORDER BY l.created_at DESC`
  )
    .bind(id)
    .all();

  // v3.1 — per-stage lifecycle for the Workflow Progress Tracker.
  // Returns one row per stage (entered + exited timestamps), ordered
  // chronologically. The Tracker UI walks this list to colour completed
  // / current / skipped / future nodes.
  const stageHistory = await env.DB.prepare(
    `SELECT id, stage, entered_at, exited_at, target_days, status,
            skipped, skip_reason, alerts_fired, snoozes_applied
       FROM assr_stage_history
      WHERE assr_id = ?
      ORDER BY entered_at ASC, id ASC`
  )
    .bind(id)
    .all();

  const relatedPOs = await env.DB.prepare(
    `SELECT * FROM purchase_orders WHERE so_doc_no = ? ORDER BY doc_date DESC`
  )
    .bind(caseRow.doc_no)
    .all();

  // Active portal link (if any) so the staff UI can show the existing
  // link on panel-open instead of forcing a regenerate each time.
  const portalToken = await getActiveStaffToken(env, id);

  return {
    case: caseRow,
    items: items.results ?? [],
    attachments: attachments.results ?? [],
    activity: activity.results ?? [],
    logistics: logistics.results ?? [],
    related_pos: relatedPOs.results ?? [],
    portal_token: portalToken,
    stage_history: stageHistory.results ?? [],
  };
}

// ── Stage transition ──────────────────────────────────────────

export async function transitionStage(
  env: Env,
  id: number,
  newStage: Stage,
  userId: number,
  note?: string,
  sourceChannel: string = "app",
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT stage, stage_entered_at, stage_target_days, priority FROM assr_cases WHERE id = ?`
  )
    .bind(id)
    .first<{ stage: Stage; stage_entered_at: string | null; stage_target_days: number | null; priority: string | null }>();
  if (!row) return false;

  if (!ALL_STAGES.includes(newStage)) {
    throw new Error(`Unknown stage: ${newStage}`);
  }
  // No-op when the stage hasn't actually changed.
  if (row.stage === newStage) return true;

  const newStatus = statusForStage(newStage);
  // Mig 082 — priority-driven per-stage targets. Falls back to active
  // Lead Time profile when the priority has no targets defined.
  const newTargetDays = await lookupStageTargetDays(env, newStage, row.priority);
  const nowIso = new Date().toISOString();
  // stage_changed_at + stage_entered_at both get refreshed so the
  // "days in stage" lead-time column reads cleanly without scanning
  // the activity log. stage_target_days snapshots the new target.
  const sets = [
    "stage = ?",
    "status = ?",
    "stage_changed_at = ?",
    "stage_entered_at = ?",
    "stage_target_days = ?",
    "updated_at = datetime('now')",
  ];
  const binds: any[] = [newStage, newStatus, nowIso, nowIso, newTargetDays];

  if (newStage === "completed") {
    sets.push("closed_at = ?", "completion_date = ?");
    binds.push(nowIso, nowIso.slice(0, 10));
  }

  binds.push(id);
  await env.DB.prepare(
    `UPDATE assr_cases SET ${sets.join(", ")} WHERE id = ?`
  )
    .bind(...binds)
    .run();

  // Close the prior open stage-history row (set exited_at = now) and
  // insert a new open row for the new stage. The "open" row is
  // identified by exited_at IS NULL.
  await env.DB.prepare(
    `UPDATE assr_stage_history
        SET exited_at = ?
      WHERE assr_id = ? AND exited_at IS NULL`
  )
    .bind(nowIso, id)
    .run();

  // alerts_fired = 1 stamps the FLAG_ENTERED bit so the v3.1 alert
  // scanner (services/assrAlerts.ts) doesn't re-fire the entered
  // event on its next tick — the in-app timeline + assignment row
  // already cover "stage entered" notification.
  await env.DB.prepare(
    `INSERT INTO assr_stage_history (assr_id, stage, entered_at, target_days, alerts_fired)
     VALUES (?, ?, ?, ?, 1)`
  )
    .bind(id, newStage, nowIso, newTargetDays)
    .run();

  // v3.1 (mig 077): stamp how long the OLD stage took + what its
  // target was, plus the request's source_channel so the timeline can
  // distinguish app/portal/email-driven moves.
  let elapsedDays: number | null = null;
  if (row.stage_entered_at) {
    const enteredMs = new Date(
      row.stage_entered_at.endsWith("Z") ? row.stage_entered_at : row.stage_entered_at + "Z"
    ).getTime();
    elapsedDays = (Date.now() - enteredMs) / (1000 * 60 * 60 * 24);
  }
  await logActivity(env, id, "stage_change", row.stage, newStage, note ?? null, userId, {
    category: "system",
    stage_elapsed_days: elapsedDays,
    stage_target_days: row.stage_target_days,
    source_channel: sourceChannel,
  });
  return true;
}

// ── Admin-open auto-advance ───────────────────────────────────
//
// Mig 106 — Service Admin opens a pending_review case → the case
// auto-advances to under_verification and the activity log stamps
// who did it. No-op when the case is already past pending_review or
// when the caller doesn't have write permission (route enforces that
// gate; the service function itself is trust-based).
export async function markCaseOpened(
  env: Env,
  id: number,
  userId: number,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT stage FROM assr_cases WHERE id = ?`
  )
    .bind(id)
    .first<{ stage: Stage }>();
  if (!row) return false;
  if (row.stage !== "pending_review") return false;
  return transitionStage(
    env,
    id,
    "under_verification",
    userId,
    "auto-advanced when Service Admin opened the case",
  );
}

// ── Patch case fields ─────────────────────────────────────────

const PATCH_FIELDS = [
  "customer_name", "customer_email", "phone", "location", "sales_agent", "item_code",
  "complaint_issue", "action_remark", "service_category",
  "completion_date", "po_no", "resolution_method", "issue_category",
  "priority", "assigned_to", "ref_no", "delivery_order", "do_date",
  "satisfaction_rating", "satisfaction_notes",
  "addr1", "addr2", "addr3", "addr4",
  // QMS additions
  "ncr_category", "quality_review_passed",
  "po_amount", "customer_amount", "supplier_invoice_ref", "cost_notes",
  // SLA fields — allow manual override (ops can extend a deadline)
  "sla_hours", "deadline_at",
  // Mig 064 — supplier handover + ready dates
  "supplier_pickup_at", "items_ready_at",
  // Mig 074 — v3.1 fields
  "inspection_result", "email_for_survey",
  // Mig 081 — verification card (Under Verification → Pending Solution gate)
  "verification_outcome", "verified_root_cause",
  // Mig 105 — editable QC-on-receipt inspection date (distinct from
  // the auto-stamped verified_at audit timestamp).
  "qc_receipt_date",
  // Mig 106 — paperwork that travels with the item between Houzs and
  // supplier. Both are free text; ops edits goods_returned_note from
  // the main case, supplier edits supplier_service_note from the
  // supplier portal.
  "goods_returned_note", "supplier_service_note",
] as const;

export async function patchAssrCase(
  env: Env,
  id: number,
  body: Record<string, any>,
  userId: number
): Promise<boolean> {
  const sets: string[] = [];
  const binds: any[] = [];

  for (const k of PATCH_FIELDS) {
    if (k in body) {
      sets.push(`${k} = ?`);
      binds.push(body[k] ?? null);
    }
  }
  if (!sets.length) return false;

  // Mig 081 — when QA sets the verification outcome, server-stamp
  // verified_at + verified_by so the actor can't be spoofed from the
  // client. Clearing the outcome clears the stamps too. NULL the
  // verified_by FK when userId is 0/falsy (no auth context) — anything
  // else would trip the foreign-key constraint.
  if ("verification_outcome" in body) {
    if (body.verification_outcome) {
      sets.push("verified_at = datetime('now')", "verified_by = ?");
      binds.push(userId && userId > 0 ? userId : null);
    } else {
      sets.push("verified_at = NULL", "verified_by = NULL");
    }
  }

  // For audited fields (complaint_issue), capture the OLD value so the
  // service-log row reflects an actual diff, not just "edited at X".
  let prevComplaint: string | null = null;
  if ("complaint_issue" in body) {
    const prev = await env.DB.prepare(
      `SELECT complaint_issue FROM assr_cases WHERE id = ?`
    )
      .bind(id)
      .first<{ complaint_issue: string | null }>();
    prevComplaint = prev?.complaint_issue ?? null;
  }

  // When priority changes (and deadline isn't being set explicitly in the
  // same request), recompute deadline_at off the case's created_at so the
  // SLA clock tracks the new priority band.
  if ("priority" in body && !("deadline_at" in body) && !("sla_hours" in body)) {
    const newHours = slaHoursFor(body.priority);
    const row = await env.DB.prepare(
      `SELECT created_at FROM assr_cases WHERE id = ?`
    )
      .bind(id)
      .first<{ created_at: string }>();
    if (row?.created_at) {
      const newDeadline = new Date(new Date(row.created_at).getTime() + newHours * 3600 * 1000).toISOString();
      sets.push("sla_hours = ?", "deadline_at = ?");
      binds.push(newHours, newDeadline);
    }
  }

  sets.push("updated_at = datetime('now')");
  binds.push(id);

  const r = await env.DB.prepare(
    `UPDATE assr_cases SET ${sets.join(", ")} WHERE id = ?`
  )
    .bind(...binds)
    .run();

  // Log assignment changes
  if ("assigned_to" in body) {
    await logActivity(env, id, "assignment", null, String(body.assigned_to ?? ""), null, userId);
  }

  // Audit complaint edits so the customer-facing description has a
  // diffable trail in the service log (mig 077).
  if ("complaint_issue" in body) {
    const next = body.complaint_issue ?? null;
    if ((prevComplaint ?? null) !== (next ?? null)) {
      await logActivity(
        env,
        id,
        "complaint_edited",
        prevComplaint,
        next,
        null,
        userId,
        { category: "customer" }
      );
    }
  }

  // When the case's item_code changes, re-resolve the creditor so the
  // link to the procurement supplier stays accurate. Fire-and-forget —
  // a failed lookup shouldn't fail the PATCH.
  if ("item_code" in body) {
    resolveCreditorForCase(env, id, body.item_code ?? null).catch((e) =>
      console.warn(`[assr.patch] creditor resolve failed for case=${id}:`, e?.message || e)
    );
  }

  return r.meta.changes > 0;
}

// ── Items management ──────────────────────────────────────────

export async function addItems(
  env: Env,
  assrId: number,
  items: { item_code: string; item_description?: string; qty?: number }[]
) {
  for (const item of items) {
    await env.DB.prepare(
      `INSERT INTO assr_items (assr_id, item_code, item_description, qty) VALUES (?, ?, ?, ?)`
    )
      .bind(assrId, item.item_code, item.item_description ?? null, item.qty ?? 1)
      .run();
  }
}

export async function removeItem(env: Env, assrId: number, itemId: number) {
  await env.DB.prepare(
    `DELETE FROM assr_items WHERE id = ? AND assr_id = ?`
  )
    .bind(itemId, assrId)
    .run();
}

// ── Attachments ───────────────────────────────────────────────

export function assrAttachmentKey(
  assrId: number,
  category: string,
  ext: string
): string {
  return `assr/${assrId}/${category}-${Date.now()}.${ext}`;
}

export async function saveAttachment(
  env: Env,
  assrId: number,
  r2Key: string,
  fileName: string | null,
  contentType: string,
  category: string,
  uploadedBy: number | null
): Promise<number> {
  const r = await env.DB.prepare(
    `INSERT INTO assr_attachments (assr_id, r2_key, file_name, content_type, category, uploaded_by)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(assrId, r2Key, fileName, contentType, category, uploadedBy)
    .run();
  return r.meta.last_row_id as number;
}

// ── Logistics ─────────────────────────────────────────────────

export async function createLogistics(
  env: Env,
  assrId: number,
  body: { type: string; scheduled_date?: string; scheduled_time_range?: string; assigned_to?: number; notes?: string }
): Promise<number> {
  const r = await env.DB.prepare(
    `INSERT INTO assr_logistics (assr_id, type, scheduled_date, scheduled_time_range, assigned_to, notes)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(
      assrId,
      body.type,
      body.scheduled_date ?? null,
      body.scheduled_time_range ?? null,
      body.assigned_to ?? null,
      body.notes ?? null
    )
    .run();
  return r.meta.last_row_id as number;
}

export async function patchLogistics(
  env: Env,
  assrId: number,
  logId: number,
  body: Record<string, any>
): Promise<boolean> {
  const allowed = ["scheduled_date", "scheduled_time_range", "assigned_to", "status", "notes", "completed_at"];
  const sets: string[] = [];
  const binds: any[] = [];
  for (const k of allowed) {
    if (k in body) {
      sets.push(`${k} = ?`);
      binds.push(body[k] ?? null);
    }
  }
  if (!sets.length) return false;
  sets.push("updated_at = datetime('now')");
  binds.push(logId, assrId);
  const r = await env.DB.prepare(
    `UPDATE assr_logistics SET ${sets.join(", ")} WHERE id = ? AND assr_id = ?`
  )
    .bind(...binds)
    .run();
  return r.meta.changes > 0;
}

// ── SO item lookup ────────────────────────────────────────────

/**
 * Look up the line items for a Sales Order. Calls AutoCount's
 * /SalesOrder/getDetail/{docNo} endpoint for the authoritative list.
 * Falls back to the local purchase_orders table if the middleware is
 * unreachable so offline/degraded lookups still return something.
 */
export async function lookupSOItems(
  env: Env,
  docNo: string
): Promise<{ item_code: string; item_description: string | null; qty: number }[]> {
  try {
    const client = new AutoCountClient(env);
    const details = await client.getDetail(docNo);
    const seen = new Map<string, { item_code: string; item_description: string | null; qty: number }>();
    for (const d of details ?? []) {
      const code = (d.ItemCode ?? "").trim();
      if (!code) continue;
      const desc = d.Description ?? d.ItemDescription ?? null;
      const qty = Number(d.Qty ?? 0) || 0;
      const existing = seen.get(code);
      if (existing) {
        existing.qty += qty;
        if (!existing.item_description && desc) existing.item_description = desc;
      } else {
        seen.set(code, { item_code: code, item_description: desc, qty });
      }
    }
    if (seen.size > 0) return [...seen.values()];
  } catch (e) {
    console.warn(`[assr] getDetail failed for ${docNo}, falling back to purchase_orders`, e);
  }

  // Fallback: derive from locally-cached purchase_orders
  const rows = await env.DB.prepare(
    `SELECT DISTINCT item_code, item_description
       FROM purchase_orders
      WHERE so_doc_no = ? AND item_code IS NOT NULL
      ORDER BY item_code`
  )
    .bind(docNo)
    .all<{ item_code: string; item_description: string | null }>();
  return (rows.results ?? []).map((r) => ({ ...r, qty: 1 }));
}

// ── Listing ───────────────────────────────────────────────────

export interface ListAssrFilters {
  stage?: string;
  status?: string;
  search?: string;
  assigned_to?: number;
  creditor_code?: string;
  page?: number;
  per_page?: number;
  include_archived?: boolean;
  /** Comma-separated stage slugs to exclude. Used by the "Hide
   *  completed" toggle to drop finished cases from the working list
   *  without dropping them from the dataset. */
  exclude_stage?: string;
  sort_by?: string;
  sort_dir?: "asc" | "desc";
}

// Allow-listed sort columns. Computed aliases (stage_since,
// days_in_stage, is_breached, hours_to_deadline) and joined names
// reference the SELECT list — the outer query is wrapped in
// FROM (…) sub so the ORDER BY can name them directly.
const ASSR_SORT_MAP: Record<string, string> = {
  id: "id",
  assr_no: "assr_no",
  doc_no: "doc_no",
  status: "status",
  stage: "stage",
  priority: "priority",
  customer_name: "customer_name",
  complained_date: "complained_date",
  completion_date: "completion_date",
  deadline_at: "deadline_at",
  closed_at: "closed_at",
  assigned_to: "assigned_to_name",
  created_by: "created_by_name",
  stage_since: "stage_since",
  days_in_stage: "days_in_stage",
  // Mig 064 — supplier handover + ready milestones
  supplier_pickup_at: "supplier_pickup_at",
  items_ready_at: "items_ready_at",
  stage_changed_at: "stage_changed_at",
  hours_to_deadline: "hours_to_deadline",
  is_breached: "is_breached",
  created_at: "created_at",
  updated_at: "updated_at",
  creditor_code: "creditor_code",
  creditor_name: "creditor_name",
};

export async function listAssrCases(env: Env, f: ListAssrFilters) {
  const where: string[] = [];
  const binds: any[] = [];

  // Soft-delete filter: hide archived rows unless explicitly
  // requested. Keeps the default list clean while still letting
  // managers review archived cases with ?include_archived=1.
  if (!f.include_archived) where.push("c.archived_at IS NULL");

  if (f.stage) {
    const stages = f.stage.split(",").map((s) => s.trim()).filter(Boolean);
    if (stages.length === 1) {
      where.push("c.stage = ?");
      binds.push(stages[0]);
    } else if (stages.length > 1) {
      where.push(`c.stage IN (${stages.map(() => "?").join(",")})`);
      binds.push(...stages);
    }
  }
  if (f.exclude_stage) {
    const ex = f.exclude_stage.split(",").map((s) => s.trim()).filter(Boolean);
    if (ex.length === 1) {
      where.push("c.stage != ?");
      binds.push(ex[0]);
    } else if (ex.length > 1) {
      where.push(`c.stage NOT IN (${ex.map(() => "?").join(",")})`);
      binds.push(...ex);
    }
  }
  if (f.status) {
    where.push("c.status = ?");
    binds.push(f.status);
  }
  if (f.assigned_to != null) {
    where.push("c.assigned_to = ?");
    binds.push(f.assigned_to);
  }
  if (f.creditor_code) {
    where.push("c.creditor_code = ?");
    binds.push(f.creditor_code);
  }
  if (f.search) {
    where.push("(c.assr_no LIKE ? OR c.doc_no LIKE ? OR c.customer_name LIKE ?)");
    const like = `%${f.search}%`;
    binds.push(like, like, like);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const page = f.page && f.page > 0 ? f.page : 1;
  const perPage = Math.min(f.per_page ?? 50, 200);
  const offset = (page - 1) * perPage;

  const total = await env.DB.prepare(
    `SELECT COUNT(*) as count FROM assr_cases c ${whereSql}`
  )
    .bind(...binds)
    .first<{ count: number }>();

  // stage_since: when the case entered its current stage.
  //   - If there is a stage_change activity to the current stage, use its created_at
  //   - Otherwise fall back to the case's created_at (still in initial stage)
  // days_in_stage: whole days elapsed (SQLite julianday diff, floored)
  // We wrap the SELECT in FROM (…) sub so the outer ORDER BY can
  // reference the computed aliases (stage_since, days_in_stage,
  // hours_to_deadline, is_breached) directly without re-computing.
  const sortExpr = f.sort_by ? ASSR_SORT_MAP[f.sort_by] : null;
  const sortDir = f.sort_dir === "asc" ? "ASC" : "DESC";
  const orderBy = sortExpr
    ? `ORDER BY ${sortExpr} ${sortDir}, id DESC`
    : `ORDER BY id DESC`;

  const baseSelect = `
    SELECT c.*, u.name as assigned_to_name, u2.name as created_by_name,
           cr.company_name as creditor_name,
           cr.email as creditor_email,
           cr.phone1 as creditor_phone,
           COALESCE(
             (SELECT MAX(a.created_at)
                FROM assr_activity a
               WHERE a.assr_id = c.id
                 AND a.action = 'stage_change'
                 AND a.to_value = c.stage),
             c.created_at
           ) as stage_since,
           CAST(
             julianday('now') - julianday(
               COALESCE(
                 (SELECT MAX(a.created_at)
                    FROM assr_activity a
                   WHERE a.assr_id = c.id
                     AND a.action = 'stage_change'
                     AND a.to_value = c.stage),
                 c.created_at
               )
             ) AS INTEGER
           ) as days_in_stage,
           CAST(
             (julianday(c.deadline_at) - julianday('now')) * 24 AS INTEGER
           ) as hours_to_deadline,
           CASE
             WHEN c.stage = 'completed' THEN 0
             WHEN c.deadline_at IS NOT NULL AND datetime('now') > c.deadline_at THEN 1
             ELSE 0
           END as is_breached
      FROM assr_cases c
      LEFT JOIN users u ON u.id = c.assigned_to
      LEFT JOIN users u2 ON u2.id = c.created_by
      LEFT JOIN creditors cr ON cr.creditor_code = c.creditor_code
    ${whereSql}
  `;

  const rows = await env.DB.prepare(
    `SELECT * FROM (${baseSelect})
     ${orderBy}
     LIMIT ? OFFSET ?`
  )
    .bind(...binds, perPage, offset)
    .all();

  return {
    data: rows.results ?? [],
    page,
    per_page: perPage,
    total: total?.count ?? 0,
  };
}

// Full dump used by the CSV export route. Honors the same filters
// as listAssrCases but skips pagination — caller is responsible for
// applying a sensible safety cap if needed.
export async function exportAssrCases(
  env: Env,
  f: Omit<ListAssrFilters, "page" | "per_page">
) {
  const where: string[] = [];
  const binds: any[] = [];
  if (!f.include_archived) where.push("c.archived_at IS NULL");
  if (f.stage) {
    const stages = f.stage.split(",").map((s) => s.trim()).filter(Boolean);
    if (stages.length === 1) {
      where.push("c.stage = ?");
      binds.push(stages[0]);
    } else if (stages.length > 1) {
      where.push(`c.stage IN (${stages.map(() => "?").join(",")})`);
      binds.push(...stages);
    }
  }
  if (f.exclude_stage) {
    const ex = f.exclude_stage.split(",").map((s) => s.trim()).filter(Boolean);
    if (ex.length === 1) {
      where.push("c.stage != ?");
      binds.push(ex[0]);
    } else if (ex.length > 1) {
      where.push(`c.stage NOT IN (${ex.map(() => "?").join(",")})`);
      binds.push(...ex);
    }
  }
  if (f.status) {
    where.push("c.status = ?");
    binds.push(f.status);
  }
  if (f.assigned_to != null) {
    where.push("c.assigned_to = ?");
    binds.push(f.assigned_to);
  }
  if (f.search) {
    where.push("(c.assr_no LIKE ? OR c.doc_no LIKE ? OR c.customer_name LIKE ?)");
    const like = `%${f.search}%`;
    binds.push(like, like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = await env.DB.prepare(
    `SELECT c.assr_no, c.doc_no, c.stage, c.status, c.priority,
            c.customer_name, c.customer_phone, c.location,
            c.service_category, c.ncr_category, c.resolution_method,
            c.item_code, c.complaint_issue,
            c.complained_date, c.created_at, c.deadline_at,
            c.po_amount, c.po_no,
            u.name as assigned_to_name, u2.name as created_by_name,
            c.creditor_code as creditor_code,
            cr.company_name as creditor_name,
            CASE
              WHEN c.stage = 'completed' THEN 0
              WHEN c.deadline_at IS NOT NULL AND datetime('now') > c.deadline_at THEN 1
              ELSE 0
            END as is_breached
       FROM assr_cases c
       LEFT JOIN users u ON u.id = c.assigned_to
       LEFT JOIN users u2 ON u2.id = c.created_by
       LEFT JOIN creditors cr ON cr.creditor_code = c.creditor_code
     ${whereSql}
     ORDER BY c.id DESC
     LIMIT 10000`
  )
    .bind(...binds)
    .all();
  return rows.results ?? [];
}

// ── Activity log helper ───────────────────────────────────────

// `category` (mig 064) drives the timeline filter pills:
//   purchasing — internal team / supplier coordination
//   customer   — customer-visible milestones (rendered on the portal)
//   system     — automatic events (stage_change, assigned, created)
//
// v3.1 (mig 077) adds:
//   stage_elapsed_days / stage_target_days — snapshots on stage_change rows
//   source_channel    — request origin (app / customer_portal / supplier_portal / email / cron)
//   references_entry_id + is_correction — append-only correction pointer
//
// All v3.1 fields are optional; existing callers don't need updating.
export type LogActivityExtras = {
  category?: "purchasing" | "customer" | "system";
  stage_elapsed_days?: number | null;
  stage_target_days?: number | null;
  source_channel?: string | null;
  references_entry_id?: number | null;
  is_correction?: boolean;
};

async function logActivity(
  env: Env,
  assrId: number,
  action: string,
  fromValue: string | null,
  toValue: string | null,
  note: string | null,
  userId?: number | null,
  categoryOrExtras: "purchasing" | "customer" | "system" | LogActivityExtras = "system",
) {
  const extras: LogActivityExtras =
    typeof categoryOrExtras === "string" ? { category: categoryOrExtras } : categoryOrExtras;
  const category = extras.category ?? "system";
  await env.DB.prepare(
    `INSERT INTO assr_activity (
       assr_id, action, from_value, to_value, note, user_id, category,
       stage_elapsed_days, stage_target_days, source_channel,
       references_entry_id, is_correction
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      assrId,
      action,
      fromValue,
      toValue,
      note,
      userId ?? null,
      category,
      extras.stage_elapsed_days ?? null,
      extras.stage_target_days ?? null,
      extras.source_channel ?? null,
      extras.references_entry_id ?? null,
      extras.is_correction ? 1 : 0,
    )
    .run();
}

export { logActivity };

// ── Survey tokens ─────────────────────────────────────────────
// Reused by the manual survey-token endpoint AND by the auto-email
// dispatch on case close — pulled out so both paths agree on the
// "reuse unsubmitted token" behavior.

export async function issueSurveyToken(env: Env, assrId: number): Promise<string> {
  const existing = await env.DB.prepare(
    `SELECT token FROM assr_survey_tokens
      WHERE assr_id = ? AND submitted_at IS NULL
      ORDER BY created_at DESC LIMIT 1`
  )
    .bind(assrId)
    .first<{ token: string }>();
  if (existing) return existing.token;
  const token = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  await env.DB.prepare(
    `INSERT INTO assr_survey_tokens (token, assr_id) VALUES (?, ?)`
  )
    .bind(token, assrId)
    .run();
  return token;
}
