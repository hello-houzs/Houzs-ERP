/**
 * Google Form → ERP intake webhook (Nick 2026-07-05).
 *
 * The customer-facing service-request Google Form keeps feeding the
 * farra sheet; a sheet-bound Apps Script onFormSubmit trigger POSTs the
 * submitted row here so the case lands in the ERP immediately (stage
 * pending_review, auto ASSR number). Dual-write transition — the sheet
 * stays authoritative-adjacent until Nick retires the form.
 *
 * Auth: shared secret in the X-Intake-Key header, compared against the
 * FORM_INTAKE_KEY worker secret (set via GitHub secret → wrangler
 * deploy). No user session — this endpoint is called by Google's
 * servers.
 *
 * Payload: { response_id?: string, row?: number, values: Record<string,string> }
 * where `values` keys are the sheet's column headers (same vocabulary
 * as scripts/import-assr-farra.mjs).
 *
 * Idempotent on response_id: the created-activity note carries
 * `[gform:<response_id>]`; a duplicate trigger for the same response is
 * acknowledged without creating a second case.
 */
import { Hono } from "hono";
import type { Env } from "../types";
import {
  nextAssrNumber,
  getActiveLeadTimeProfileId,
  slaHoursFor,
} from "../services/assr";

const app = new Hono<{ Bindings: Env }>();

const pick = (values: Record<string, unknown>, key: string): string | null => {
  const v = values[key];
  const s = typeof v === "string" ? v.trim() : v != null ? String(v).trim() : "";
  return s || null;
};

app.post("/", async (c) => {
  const provided = c.req.header("X-Intake-Key") || "";
  const expected = (c.env as any).FORM_INTAKE_KEY || "";
  if (!expected || provided !== expected) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const body = await c.req
    .json<{ response_id?: string; row?: number; values?: Record<string, string> }>()
    .catch(() => null);
  if (!body?.values || typeof body.values !== "object") {
    return c.json({ error: "values object is required" }, 400);
  }
  const values = body.values;
  const responseId = (body.response_id || "").trim().slice(0, 120) || null;

  // Idempotency — a Google trigger can fire twice for one submission.
  if (responseId) {
    const dupe = await c.env.DB.prepare(
      `SELECT assr_id FROM assr_activity
        WHERE action = 'created' AND note LIKE ?
        LIMIT 1`
    )
      .bind(`%[gform:${responseId}]%`)
      .first<{ assr_id: number }>();
    if (dupe) {
      return c.json({ ok: true, duplicate: true, id: dupe.assr_id });
    }
  }

  const customerName = pick(values, "Customer Name");
  const complaint = pick(values, "Complant issue") ?? pick(values, "Complaint issue");
  if (!customerName && !complaint) {
    return c.json({ error: "submission carries neither customer nor complaint" }, 400);
  }

  const assrNo = await nextAssrNumber(c.env);
  const priority = "normal";
  const slaHours = slaHoursFor(priority);
  const deadlineAt = new Date(Date.now() + slaHours * 3600 * 1000).toISOString();
  const profileId = await getActiveLeadTimeProfileId(c.env);
  const nowIso = new Date().toISOString();
  const today = nowIso.slice(0, 10);

  // Default assignee — same Settings → Service knob the in-app intake
  // reads, so form cases land with the service admin (Farra) too.
  let assignedTo: number | null = null;
  try {
    const r = await c.env.DB.prepare(
      `SELECT value FROM system_settings WHERE key = 'assr_default_assignee_id'`
    ).first<{ value: string | null }>();
    if (r?.value != null && !isNaN(parseInt(r.value, 10))) assignedTo = parseInt(r.value, 10);
  } catch {
    /* unassigned is fine */
  }

  const itemDetails = pick(values, "Item Details");

  const result = await c.env.DB.prepare(
    `INSERT INTO assr_cases (
       assr_no, status, stage, doc_no, complained_date,
       customer_name, phone, location, sales_agent, ref_no, item_code,
       complaint_issue, issue_category, priority, po_no,
       addr1, addr2, addr3, addr4,
       assigned_to, sla_hours, deadline_at,
       stage_entered_at, stage_target_days, stage_changed_at,
       lead_time_profile_id, created_at
     ) VALUES (?, 'Open', 'pending_review', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      assrNo,
      pick(values, "SO NO") ?? "",
      pick(values, "Complained date") ?? today,
      customerName,
      pick(values, "HP"),
      pick(values, "Location"),
      pick(values, "Sales Agent"),
      pick(values, "Ref No"),
      itemDetails,
      complaint ?? "(no description on form)",
      pick(values, "Service Category"),
      priority,
      pick(values, "PO No"),
      pick(values, "Address 1"),
      pick(values, "Address 2"),
      pick(values, "Address 3"),
      pick(values, "Address 4"),
      assignedTo,
      slaHours,
      deadlineAt,
      nowIso,
      1,
      nowIso,
      profileId,
      nowIso
    )
    .run();
  const caseId = result.meta.last_row_id as number;

  await c.env.DB.prepare(
    `INSERT INTO assr_stage_history (assr_id, stage, entered_at, target_days)
     VALUES (?, 'pending_review', ?, 1)`
  )
    .bind(caseId, nowIso)
    .run();

  if (itemDetails) {
    await c.env.DB.prepare(
      `INSERT INTO assr_items (assr_id, item_code, item_description, qty)
       VALUES (?, ?, NULL, 1)`
    )
      .bind(caseId, itemDetails)
      .run();
  }

  await c.env.DB.prepare(
    `INSERT INTO assr_activity (assr_id, action, note, source_channel)
     VALUES (?, 'created', ?, 'google_form')`
  )
    .bind(
      caseId,
      `Created from Google Form submission${body.row ? ` (sheet row ${body.row})` : ""}${responseId ? ` [gform:${responseId}]` : ""}`
    )
    .run();

  return c.json({ ok: true, id: caseId, assr_no: assrNo }, 201);
});

export default app;
