import { Hono } from "hono";
import type { Env } from "../types";

// Public customer-satisfaction survey. Accessed via a one-off token;
// no login required. Mounted OUTSIDE the /api/* auth middleware so
// external customers can reach it.

const app = new Hono<{ Bindings: Env }>();

// ── Get public case info for the survey screen ────────────────
app.get("/:token", async (c) => {
  const token = c.req.param("token");
  const row = await c.env.DB.prepare(
    `SELECT t.token, t.submitted_at,
            a.assr_no, a.customer_name, a.doc_no, a.complained_date,
            a.satisfaction_rating, a.satisfaction_notes
       FROM assr_survey_tokens t
       JOIN assr_cases a ON a.id = t.assr_id
      WHERE t.token = ?`
  )
    .bind(token)
    .first<{
      token: string;
      submitted_at: string | null;
      assr_no: string;
      customer_name: string | null;
      doc_no: string;
      complained_date: string | null;
      satisfaction_rating: number | null;
      satisfaction_notes: string | null;
    }>();
  if (!row) return c.json({ error: "Survey not found or expired" }, 404);

  return c.json({
    already_submitted: !!row.submitted_at,
    assr_no: row.assr_no,
    customer_name: row.customer_name,
    doc_no: row.doc_no,
    complained_date: row.complained_date,
    existing_rating: row.satisfaction_rating,
    existing_notes: row.satisfaction_notes,
  });
});

// ── Submit the survey ─────────────────────────────────────────
app.post("/:token", async (c) => {
  const token = c.req.param("token");
  const body = await c.req.json<{ rating: number; notes?: string }>();

  if (!body.rating || body.rating < 1 || body.rating > 5) {
    return c.json({ error: "Rating must be 1–5" }, 400);
  }

  const tok = await c.env.DB.prepare(
    `SELECT t.assr_id, t.submitted_at
       FROM assr_survey_tokens t
      WHERE t.token = ?`
  )
    .bind(token)
    .first<{ assr_id: number; submitted_at: string | null }>();
  if (!tok) return c.json({ error: "Survey not found" }, 404);
  if (tok.submitted_at) return c.json({ error: "Survey already submitted" }, 409);

  // Write the rating back onto the case, mark the token as used, and
  // log to the case timeline so Service Admins see the feedback.
  await c.env.DB.prepare(
    `UPDATE assr_cases
        SET satisfaction_rating = ?, satisfaction_notes = ?, updated_at = datetime('now')
      WHERE id = ?`
  )
    .bind(body.rating, body.notes || null, tok.assr_id)
    .run();

  await c.env.DB.prepare(
    `UPDATE assr_survey_tokens SET submitted_at = datetime('now') WHERE token = ?`
  )
    .bind(token)
    .run();

  await c.env.DB.prepare(
    `INSERT INTO assr_activity (assr_id, action, from_value, to_value, note, user_id)
     VALUES (?, 'survey_submitted', NULL, ?, ?, NULL)`
  )
    .bind(tok.assr_id, String(body.rating), body.notes || null)
    .run();

  return c.json({ ok: true });
});

export default app;
