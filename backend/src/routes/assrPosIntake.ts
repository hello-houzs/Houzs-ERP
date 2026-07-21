import { Hono } from "hono";
import type { Env } from "../types";
import { createAssrCase } from "../services/assr";
import { timingSafeEqualStr } from "../services/auth";
import { checkRateLimit, clientIp } from "../middleware/rateLimit";

/**
 * POS → Service Case intake (owner 2026-07-21). The 2990 POS lets a
 * counter person open a service case; its Worker (apps/api) relays here
 * server-side so the shared secret never reaches the browser. Mirrors the
 * Google-Form relay (routes/assrFormIntake.ts): PRE-AUTH, shared-secret,
 * idempotent — but keyed on its OWN secret (POS_INTAKE_KEY) so the two
 * channels rotate independently, and its own `source_channel = 'pos'`.
 *
 * The heavy lifting is createAssrCase, already 2990-aware: company (2990),
 * customer, address, line items and sales agent all resolve from the SO.
 */

const app = new Hono<{ Bindings: Env }>();

// The Houzs account a POS-created case is attributed to (Decision 1A): a
// single system "2990 POS" user, resolved by email so there is no hardcoded
// id. The actual counter person's name rides in the activity note. Falls
// back to unassigned (created_by null → managers still see it) if the
// account isn't present.
const POS_CREATOR_EMAIL = "2990-pos@houzscentury.com";

// Shared-secret guard — POS_INTAKE_KEY, separate from FORM_INTAKE_KEY.
// Constant-time compare + a small delay + a per-IP failure limiter, exactly
// like the form-intake guard.
async function badPosKey(c: any): Promise<Response | null> {
  const provided = c.req.header("X-Intake-Key") || "";
  const expected = c.env.POS_INTAKE_KEY || "";
  if (expected && timingSafeEqualStr(provided, expected)) return null;
  const limited = await checkRateLimit(c, "pos_intake_badkey", clientIp(c), 10, 900);
  await new Promise((r) => setTimeout(r, 250));
  if (limited) return limited;
  return c.json({ error: "unauthorized" }, 401);
}

interface PosIntakeBody {
  /** Client-generated id for this submission — the idempotency key. A
   *  flaky POS network / double-tap must not double-create. */
  submission_id?: string;
  doc_no?: string;
  complaint_issue?: string;
  issue_category?: string | null;
  priority?: string | null;
  items?: { item_code?: string; item_description?: string; qty?: number }[];
  /** The counter person who filed it (named in the note; not the customer). */
  submitter?: { name?: string; email?: string } | null;
}

app.post("/", async (c) => {
  const denied = await badPosKey(c);
  if (denied) return denied;

  const body = await c.req.json<PosIntakeBody>().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "JSON body required" }, 400);
  }

  const docNo = (body.doc_no || "").trim();
  const complaint = (body.complaint_issue || "").trim();
  const category = (body.issue_category || "").trim() || null;
  const priority = (body.priority || "").trim() || null;
  const submissionId = (body.submission_id || "").trim().slice(0, 120) || null;
  const submitterName = (body.submitter?.name || "").trim();
  const submitterEmail = (body.submitter?.email || "").trim();

  // Server-side required-field guard — mirror the in-app create (never
  // trust the client), and make the failure messages actionable.
  if (!docNo) return c.json({ error: "doc_no (the sales order number) is required" }, 400);
  if (!complaint) return c.json({ error: "complaint_issue is required" }, 400);
  if (!category) return c.json({ error: "issue_category is required" }, 400);

  const items = (body.items ?? [])
    .map((it) => ({
      item_code: (it.item_code || "").trim(),
      item_description: it.item_description,
      qty: it.qty,
    }))
    .filter((it) => it.item_code.length > 0);
  if (!items.length) return c.json({ error: "at least one item is required" }, 400);

  // Idempotency — marker `[pos:<submission_id>]` on the case's activity
  // note. A retry with the same id returns the existing case instead of
  // creating a second one.
  if (submissionId) {
    const dupe = await c.env.DB.prepare(
      `SELECT assr_id FROM assr_activity
        WHERE source_channel = 'pos' AND note LIKE ?
        LIMIT 1`,
    )
      .bind(`%[pos:${submissionId}]%`)
      .first<{ assr_id: number }>();
    if (dupe) return c.json({ ok: true, duplicate: true, id: dupe.assr_id }, 200);
  }

  // created_by (Decision 1A): the "2990 POS" system user. If a POS submitter
  // happens to hold a Houzs account, prefer that so the case lands in their
  // own queue; else the system account; else unassigned.
  let createdBy: number | undefined;
  for (const email of [submitterEmail, POS_CREATOR_EMAIL]) {
    if (!email) continue;
    const u = await c.env.DB.prepare(`SELECT id FROM users WHERE LOWER(email) = ?`)
      .bind(email.toLowerCase())
      .first<{ id: number }>();
    if (u) {
      createdBy = u.id;
      break;
    }
  }

  // createAssrCase resolves company=2990, customer, address, line items and
  // sales agent from the SO (the 2990-aware hydration already on prod), then
  // seeds assr_no + default assignee + SLA + stage history.
  const { assr_no, id } = await createAssrCase(c.env, {
    doc_no: docNo,
    items,
    complaint_issue: complaint,
    issue_category: category,
    priority,
    created_by: createdBy,
  });

  // Provenance note carrying the idempotency marker + the counter person.
  await c.env.DB.prepare(
    `INSERT INTO assr_activity (assr_id, action, note, category, source_channel)
     VALUES (?, 'note', ?, 'customer', 'pos')`,
  )
    .bind(
      id,
      `Submitted via 2990 POS${submitterName ? ` by ${submitterName}` : ""}${
        submitterEmail ? ` <${submitterEmail}>` : ""
      }${submissionId ? ` [pos:${submissionId}]` : ""}`,
    )
    .run();

  return c.json({ ok: true, assr_no, id }, 201);
});

export default app;
