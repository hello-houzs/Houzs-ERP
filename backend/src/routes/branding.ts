import { Hono } from "hono";
import type { Env } from "../types";
import { requirePermission } from "../middleware/auth";
import { getBranding, setBranding, type Branding } from "../services/branding";
import { audit } from "../services/audit";

// ── Branding (company identity) ───────────────────────────────
//
// GET  /api/branding — any authenticated user (the global auth middleware
//   already gates /api/*). The frontend reads this for PDF letterheads + the
//   shell chrome, so it must be available to every signed-in user.
// PUT  /api/branding — admin-gated (settings.manage, same as the email
//   settings route). The owner edits the single config here.

const app = new Hono<{ Bindings: Env }>();

app.get("/", async (c) => {
  const branding = await getBranding(c.env);
  return c.json({ branding });
});

app.put("/", requirePermission("settings.manage"), async (c) => {
  const user = c.get("user");
  let body: Partial<Branding>;
  try {
    body = await c.req.json<Partial<Branding>>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  // Company name is the one load-bearing field (it anchors the OCR prompt +
  // every letterhead) — reject a blank/whitespace-only name. Merge the rest
  // over the current row so a partial PUT only updates the fields it sends.
  const current = await getBranding(c.env);
  const str = (v: unknown, fallback: string): string =>
    typeof v === "string" ? v.trim() : fallback;
  const next: Branding = {
    companyName: str(body.companyName, current.companyName),
    registrationNo: str(body.registrationNo, current.registrationNo),
    address: str(body.address, current.address),
    phone: str(body.phone, current.phone),
    email: str(body.email, current.email),
    website: str(body.website, current.website),
    logoR2Key: str(body.logoR2Key, current.logoR2Key),
  };
  if (next.companyName === "") {
    return c.json({ error: "companyName is required" }, 400);
  }

  await setBranding(c.env, next, user?.id ?? null);
  await audit(c, {
    action: "settings.branding",
    entityType: "app_setting",
    entityId: "branding",
    summary: "Company branding updated",
    meta: { companyName: next.companyName },
  });
  return c.json({ branding: next });
});

export default app;
