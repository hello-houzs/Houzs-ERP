// ---------------------------------------------------------------------------
// assistant.ts — the unified ERP Assistant endpoint (spec §2).
//
// POST /api/assistant/chat { message } → one grounded answer + which specialist
// agents were consulted (the routing trace the UI shows).
//
// OWNER-ONLY for now (requirePermission("*")), deliberately. The specialists'
// briefs carry MARGIN, per-salesperson performance and company-wide receivables —
// exactly the class of aggregate that leaked to every Sales Executive once before
// (fix/c1-reports: "READ-ONLY IS NOT THE SAME AS SAFE"). Serving this to all staff
// needs per-role scoping of what each specialist may contribute, which is a
// follow-up, not something to guess at now.
//
// READ-ONLY: this route never writes a business row. The assistant answers and
// points at the screen where a human acts.
// ---------------------------------------------------------------------------

import { Hono } from "hono";
import type { Env } from "../types";
import { requirePermission } from "../middleware/auth";
import { askAssistant } from "../services/assistant";

const app = new Hono<{ Bindings: Env }>();

app.use("*", requirePermission("*"));

app.post("/chat", async (c) => {
  let body: { message?: unknown } = {};
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    body = {};
  }
  const message = typeof body.message === "string" ? body.message : "";
  if (!message.trim()) {
    return c.json({ success: false, error: "message required" }, 400);
  }
  const res = await askAssistant(c.env, message);
  return c.json({ success: true, data: res });
});

export default app;
