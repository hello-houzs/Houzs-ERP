// ---------------------------------------------------------------------------
// assistant.ts — the unified ERP Assistant endpoint (spec §2).
//
// POST /api/assistant/chat { message } → one grounded answer + which specialist
// agents were consulted (the routing trace the UI shows).
//
// OPEN TO AUTHENTICATED STAFF, with the protection in the SCOPING rather than in
// the door. It was owner-only until the scoping existed, because the specialists'
// briefs carry MARGIN, per-salesperson performance and company-wide receivables —
// the class of aggregate that leaked to every Sales Executive once before
// (fix/c1-reports: "READ-ONLY IS NOT THE SAME AS SAFE").
//
// What changed: services/assistant-scope.ts derives each caller's visibility from
// positionPolicy — the SAME flags every other surface obeys — gates the money
// specialists, and redacts money keys from the payload BEFORE the model is called.
// A rep asking about margin now reaches an agent list that never included the
// commercial-intelligence brief, over a payload where those keys are already
// markers. The door is no longer what protects the numbers, so the door can open.
//
// READ-ONLY: this route never writes a business row. The assistant answers and
// points at the screen where a human acts.
// ---------------------------------------------------------------------------

import { Hono } from "hono";
import type { Env } from "../types";
import { askAssistant } from "../services/assistant";
import { canUseAssistant, scopeForUser } from "../services/assistant-scope";
import { resolvePositionPolicy } from "../services/positionPolicy";

const app = new Hono<{ Bindings: Env }>();


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
  /* Scope is resolved per REQUEST from the caller's own position — never cached,
     never passed in by the client. A user with no position resolves to money
     hidden: the policy has no basis to decide, and "cannot tell" must not become
     "entitled". */
  const user = c.get("user") as
    | { permissions?: unknown; position_name?: string | null; department_name?: string | null }
    | undefined;
  /* Field crew are denied the surface outright (owner 2026-07-18: operation gets
     the Assistant EXCEPT driver / helper / storekeeper). Checked here, not only in
     the nav — a hidden menu item is not a control, and this endpoint is reachable
     by anyone who can send a POST. */
  if (!canUseAssistant(user)) {
    return c.json(
      { success: false, error: "The assistant is not available for your role. Your jobs are on the Delivery Planning board." },
      403,
    );
  }
  const scope = scopeForUser(user, (i) => resolvePositionPolicy(i));
  const res = await askAssistant(c.env, message, undefined, scope);
  return c.json({ success: true, data: res });
});

export default app;
