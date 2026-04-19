import { Hono } from "hono";
import type { Env } from "../types";
import { verifyAndIssueCustomerToken } from "../services/caseTracking";

// Public tracking form endpoint. Unauthenticated — mounted before the
// /api/* auth gate. Validates (case number, phone) against assr_cases
// and issues a 30-min token on match.

const app = new Hono<{ Bindings: Env }>();

async function bruteGuard() {
  // Small always-on sleep so repeated enumeration attempts cost real
  // time. Not a substitute for proper rate limiting but blunts brute
  // force across the predictable ASSR-number space.
  await new Promise((r) => setTimeout(r, 500));
}

app.post("/", async (c) => {
  const body = await c.req
    .json<{ assr_no?: string; phone?: string }>()
    .catch(() => ({} as { assr_no?: string; phone?: string }));
  const assrNo = (body.assr_no || "").trim();
  const phone = (body.phone || "").trim();
  if (!assrNo || !phone) {
    await bruteGuard();
    return c.json({ error: "Case number and phone are required" }, 400);
  }

  const res = await verifyAndIssueCustomerToken(c.env, assrNo, phone);
  if (!res) {
    await bruteGuard();
    return c.json({ error: "No matching case. Check the case number and phone." }, 404);
  }

  return c.json({ token: res.token, assr_no: res.assr_no });
});

export default app;
