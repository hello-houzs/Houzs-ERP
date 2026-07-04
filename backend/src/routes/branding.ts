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
//
// Logo (2026-07 — owner batch):
// POST   /api/branding/logo — admin-gated raw-binary upload (png/jpg, ≤1 MB).
//   Follows the users.ts profile-pic pattern exactly (raw body + content-type
//   header). Bytes live in R2 (POD_BUCKET) under branding/logo-<ts>.<ext>;
//   the key is stored in the branding config row (logoR2Key).
// GET    /api/branding/logo — any authenticated user; streams the bytes back
//   through the worker (same serve pattern as profile-pic / POD photos) so the
//   PDF generator and <img> can fetch it with the bearer token.
// DELETE /api/branding/logo — admin-gated; clears the pointer and best-effort
//   deletes the R2 object.

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

// ── Logo upload / serve / remove ──────────────────────────────

/* Only the two web-safe raster formats the jspdf letterhead can embed.
   Maps the upload's Content-Type to the stored extension. */
const LOGO_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
};
const LOGO_MAX_BYTES = 1 * 1024 * 1024; // ~1 MB — a letterhead logo, not a photo

/**
 * POST /api/branding/logo
 * Raw binary upload of the company logo (admin-gated). The R2 key carries a
 * Date.now() stamp — same convention as profile pics — so every upload yields
 * a NEW key and every consumer (blob-URL previews, the PDF logo memo) can use
 * the key itself as the cache-buster.
 */
app.post("/logo", requirePermission("settings.manage"), async (c) => {
  const user = c.get("user");
  const contentType = (c.req.header("content-type") || "").split(";")[0].trim().toLowerCase();
  const ext = LOGO_TYPES[contentType];
  if (!ext) {
    return c.json({ error: "Logo must be a PNG or JPG image" }, 415);
  }
  const buf = await c.req.arrayBuffer();
  if (!buf.byteLength) return c.json({ error: "Empty body" }, 400);
  if (buf.byteLength > LOGO_MAX_BYTES) {
    return c.json({ error: "Logo must be under 1 MB" }, 413);
  }

  const key = `branding/logo-${Date.now()}.${ext}`;
  await c.env.POD_BUCKET.put(key, buf, { httpMetadata: { contentType } });

  // Point the single branding row at the new object; best-effort clean up the
  // previous one (orphans are cheap; a failed delete never fails the upload).
  const current = await getBranding(c.env);
  const prevKey = current.logoR2Key;
  const next: Branding = { ...current, logoR2Key: key };
  await setBranding(c.env, next, user?.id ?? null);
  if (prevKey && prevKey !== key) {
    try { await c.env.POD_BUCKET.delete(prevKey); } catch { /* orphan is fine */ }
  }

  await audit(c, {
    action: "settings.branding",
    entityType: "app_setting",
    entityId: "branding",
    summary: "Company logo uploaded",
    meta: { logoR2Key: key, bytes: buf.byteLength },
  });
  return c.json({ ok: true, branding: next });
});

/**
 * GET /api/branding/logo
 * Streams the stored logo bytes. Any authed user — the PDF letterhead is
 * drawn client-side by every signed-in user. 404 when no logo is set.
 */
app.get("/logo", async (c) => {
  const branding = await getBranding(c.env);
  if (!branding.logoR2Key) return c.json({ error: "No logo uploaded" }, 404);
  const obj = await c.env.POD_BUCKET.get(branding.logoR2Key);
  if (!obj) return c.json({ error: "Logo missing" }, 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("cache-control", "private, max-age=300");
  return new Response(obj.body, { headers });
});

/**
 * DELETE /api/branding/logo
 * Clears the logo pointer (admin-gated) and best-effort deletes the object —
 * the letterheads fall back to the text-only header.
 */
app.delete("/logo", requirePermission("settings.manage"), async (c) => {
  const user = c.get("user");
  const current = await getBranding(c.env);
  const prevKey = current.logoR2Key;
  if (prevKey) {
    const next: Branding = { ...current, logoR2Key: "" };
    await setBranding(c.env, next, user?.id ?? null);
    try { await c.env.POD_BUCKET.delete(prevKey); } catch { /* orphan is fine */ }
  }
  await audit(c, {
    action: "settings.branding",
    entityType: "app_setting",
    entityId: "branding",
    summary: "Company logo removed",
    meta: { logoR2Key: prevKey },
  });
  return c.json({ ok: true, branding: { ...current, logoR2Key: "" } });
});

export default app;
