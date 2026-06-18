// ----------------------------------------------------------------------------
// /fabric-library — PATCH the SELLING tier on a customer-pickable fabric_library
// row. 1:1 clone of 2990s apps/api/src/routes/fabric-library.ts (PostgREST ->
// Drizzle). Distinct from /fabric-tracking (procurement/cost tiers).
//
// SEAMS (canonical rules): getDb(c.env) (rule #3); requirePermission("*") (rule
// #4 — 2990s gated to a WRITE_ROLES set via a staff-role lookup, collapsed to
// the module's owner-only mount).
//
// Endpoints:
//   PATCH /fabric-library/:id/tier   body: { field: 'sofaTier'|'bedframeTier', tier }
// ----------------------------------------------------------------------------

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { Env } from "../types";
import { getDb } from "../db/client";
import { fabricLibrary } from "../db/schema";
import { requirePermission } from "../middleware/auth";

const app = new Hono<{ Bindings: Env }>();

app.use("*", requirePermission("*"));

const VALID_TIER_FIELDS = new Set(["sofaTier", "bedframeTier"]);
const VALID_TIERS = new Set(["PRICE_1", "PRICE_2", "PRICE_3"]);

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

app.patch("/:id/tier", async (c) => {
  const id = c.req.param("id");
  let body: { field?: string; tier?: string };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  if (!body.field || !VALID_TIER_FIELDS.has(body.field)) {
    return c.json({ error: "invalid_field", allowed: [...VALID_TIER_FIELDS] }, 400);
  }
  if (!body.tier || !VALID_TIERS.has(body.tier)) {
    return c.json({ error: "invalid_tier", allowed: [...VALID_TIERS] }, 400);
  }

  const db = getDb(c.env);
  try {
    const set = body.field === "sofaTier" ? { sofaTier: body.tier } : { bedframeTier: body.tier };
    const updated = await db.update(fabricLibrary).set(set).where(eq(fabricLibrary.id, id)).returning({ id: fabricLibrary.id });
    if (!updated.length) return c.json({ error: "update_failed", reason: "not_found" }, 404);
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: "update_failed", reason: errMsg(e) }, 500);
  }
});

export default app;
