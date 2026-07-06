/**
 * Google Form → ERP intake webhook (Nick 2026-07-05).
 *
 * The staff-facing service-request Google Form feeds the "Form
 * Responses 3" tab of the HC Delivery sheet; a sheet-bound Apps Script
 * onFormSubmit trigger POSTs the submitted row here so the case lands
 * in the ERP immediately. The form carries only the SO number + item +
 * issue (+ Drive photo links) — customer name/phone/address resolve
 * from the SO via createAssrCase, exactly like the in-app New Case
 * intake.
 *
 * Auth: shared secret in the X-Intake-Key header, compared against the
 * FORM_INTAKE_KEY worker secret (set via GitHub secret → wrangler
 * deploy). No user session — this endpoint is called by Google's
 * servers.
 *
 * Payload: { response_id?: string, row?: number, values: Record<string,string> }
 * where `values` keys are the Form Responses tab's column headers:
 *   Timestamp · Email Address · Doc. No. (SO) · Item Code ·
 *   Issue Category · Issue Description · Photo / Video
 *
 * Idempotent on response_id: the google_form activity note carries
 * `[gform:<response_id>]`; a duplicate trigger for the same response is
 * acknowledged without creating a second case.
 */
import { Hono } from "hono";
import type { Env } from "../types";
import { createAssrCase } from "../services/assr";

const app = new Hono<{ Bindings: Env }>();

const pick = (values: Record<string, unknown>, key: string): string | null => {
  const v = values[key];
  const s = typeof v === "string" ? v.trim() : v != null ? String(v).trim() : "";
  return s || null;
};

app.post("/", async (c) => {
  const provided = c.req.header("X-Intake-Key") || "";
  const expected = c.env.FORM_INTAKE_KEY || "";
  if (!expected || provided !== expected) {
    // Diagnostic breadcrumbs only — presence + lengths, never values.
    // (Added while chasing a 401 after the secret upload reported OK.)
    return c.json(
      { error: "unauthorized", has_key: !!expected, key_len: expected.length, provided_len: provided.length },
      401
    );
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
        WHERE source_channel = 'google_form' AND note LIKE ?
        LIMIT 1`
    )
      .bind(`%[gform:${responseId}]%`)
      .first<{ assr_id: number }>();
    if (dupe) {
      return c.json({ ok: true, duplicate: true, id: dupe.assr_id });
    }
  }

  const soNo = pick(values, "Doc. No. (SO)");
  const itemCode = pick(values, "Item Code");
  const category = pick(values, "Issue Category");
  const description = pick(values, "Issue Description");
  const photos = pick(values, "Photo / Video");
  const submitter = pick(values, "Email Address");

  if (!soNo && !description) {
    return c.json({ error: "submission carries neither SO number nor description" }, 400);
  }

  // Drive photo links ride in the complaint text for now — attachment
  // migration to R2 is a later pass (mapping doc tab 3).
  const complaint =
    [description, photos ? `[Photos] ${photos}` : null].filter(Boolean).join("\n\n") ||
    "(no description on form)";

  // created_by: the submitter when their email has an ERP account,
  // else Farra (the form's owner-operator).
  let createdBy: number | undefined;
  for (const email of [submitter, "farraellya02@gmail.com"]) {
    if (!email) continue;
    const u = await c.env.DB.prepare(`SELECT id FROM users WHERE LOWER(email) = ?`)
      .bind(email.toLowerCase())
      .first<{ id: number }>();
    if (u) {
      createdBy = u.id;
      break;
    }
  }

  // Same path as the in-app New Case intake: SO context (customer,
  // phone, address, agent, ref) resolves from AutoCount's live
  // getSingle; assr_no auto-generates; default assignee + SLA +
  // stage history all seeded inside.
  const { assr_no, id } = await createAssrCase(c.env, {
    doc_no: soNo ?? "",
    items: itemCode ? [{ item_code: itemCode }] : [],
    complaint_issue: complaint,
    issue_category: category,
    created_by: createdBy,
  });

  await c.env.DB.prepare(
    `INSERT INTO assr_activity (assr_id, action, note, category, source_channel)
     VALUES (?, 'note', ?, 'customer', 'google_form')`
  )
    .bind(
      id,
      `Submitted via Google Form${submitter ? ` by ${submitter}` : ""}${body.row ? ` (sheet row ${body.row})` : ""}${responseId ? ` [gform:${responseId}]` : ""}`
    )
    .run();

  return c.json({ ok: true, id, assr_no }, 201);
});

export default app;
