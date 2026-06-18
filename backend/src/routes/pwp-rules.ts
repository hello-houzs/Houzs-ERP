// ----------------------------------------------------------------------------
// /pwp-rules — purchase-with-purchase (换购优惠) rules CRUD. 1:1 clone of 2990s
// apps/api/src/routes/pwp-rules.ts (PostgREST -> Drizzle). A rule: buying a
// TRIGGER (eligible model in trigger_category) unlocks REWARD models (eligible
// list in reward_category) at their pwp_price_sen.
//
// SEAMS (canonical rules): getDb(c.env) (rule #3); requirePermission("*") (rule
// #4 — 2990s gated writes via a WRITE_ROLES staff-role lookup, collapsed to the
// module's owner-only mount); created_by -> users.id INTEGER soft-ref.
//
// Endpoints: GET / · POST / · PATCH /:id · DELETE /:id
// ----------------------------------------------------------------------------

import { Hono } from "hono";
import { z } from "zod";
import { asc, eq } from "drizzle-orm";
import type { Env } from "../types";
import { getDb } from "../db/client";
import { pwpRules as pwpRulesTable } from "../db/schema";
import { requirePermission } from "../middleware/auth";

const app = new Hono<{ Bindings: Env }>();

app.use("*", requirePermission("*"));

const CATEGORY = z.enum(["SOFA", "BEDFRAME", "ACCESSORY", "MATTRESS", "SERVICE"]);
const createSchema = z.object({
  triggerCategory: CATEGORY,
  triggerEligibleModelIds: z.array(z.string()).default([]),
  triggerComboIds: z.array(z.string()).default([]),
  rewardCategory: CATEGORY,
  eligibleRewardModelIds: z.array(z.string()).default([]),
  rewardComboIds: z.array(z.string()).default([]),
  qtyPerTrigger: z.number().int().min(1).default(1),
  type: z.enum(["pwp", "promo"]).default("pwp"),
  active: z.boolean().default(true),
});
const patchSchema = createSchema.partial();

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type RuleRowDb = typeof pwpRulesTable.$inferSelect;
const toApi = (r: RuleRowDb) => ({
  id: r.id,
  triggerCategory: r.triggerCategory,
  triggerEligibleModelIds: r.triggerEligibleModelIds ?? [],
  triggerComboIds: r.triggerComboIds ?? [],
  rewardCategory: r.rewardCategory,
  eligibleRewardModelIds: r.eligibleRewardModelIds ?? [],
  rewardComboIds: r.rewardComboIds ?? [],
  qtyPerTrigger: r.qtyPerTrigger,
  type: (r.type ?? "pwp") as "pwp" | "promo",
  active: r.active,
  createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
  updatedAt: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : r.updatedAt,
});

// GET — every authenticated user reads (the configurator needs it).
app.get("/", async (c) => {
  const db = getDb(c.env);
  try {
    const rows = await db.select().from(pwpRulesTable).orderBy(asc(pwpRulesTable.createdAt));
    return c.json({ rules: rows.map(toApi) });
  } catch (e) {
    return c.json({ error: "fetch_failed", reason: errMsg(e) }, 500);
  }
});

// POST — create.
app.post("/", async (c) => {
  const user = c.get("user");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "validation_failed", issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) }, 400);
  }

  const db = getDb(c.env);
  try {
    const inserted = await db
      .insert(pwpRulesTable)
      .values({
        triggerCategory: parsed.data.triggerCategory,
        triggerEligibleModelIds: parsed.data.triggerEligibleModelIds,
        triggerComboIds: parsed.data.triggerComboIds,
        rewardCategory: parsed.data.rewardCategory,
        eligibleRewardModelIds: parsed.data.eligibleRewardModelIds,
        rewardComboIds: parsed.data.rewardComboIds,
        qtyPerTrigger: parsed.data.qtyPerTrigger,
        type: parsed.data.type,
        active: parsed.data.active,
        createdBy: user.id,
      })
      .returning();
    return c.json({ rule: toApi(inserted[0]) }, 201);
  } catch (e) {
    return c.json({ error: "create_failed", reason: errMsg(e) }, 500);
  }
});

// PATCH /:id — update.
app.patch("/:id", async (c) => {
  const id = c.req.param("id");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "validation_failed", issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) }, 400);
  }

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (parsed.data.triggerCategory !== undefined) patch.triggerCategory = parsed.data.triggerCategory;
  if (parsed.data.triggerEligibleModelIds !== undefined) patch.triggerEligibleModelIds = parsed.data.triggerEligibleModelIds;
  if (parsed.data.triggerComboIds !== undefined) patch.triggerComboIds = parsed.data.triggerComboIds;
  if (parsed.data.rewardCategory !== undefined) patch.rewardCategory = parsed.data.rewardCategory;
  if (parsed.data.eligibleRewardModelIds !== undefined) patch.eligibleRewardModelIds = parsed.data.eligibleRewardModelIds;
  if (parsed.data.rewardComboIds !== undefined) patch.rewardComboIds = parsed.data.rewardComboIds;
  if (parsed.data.qtyPerTrigger !== undefined) patch.qtyPerTrigger = parsed.data.qtyPerTrigger;
  if (parsed.data.type !== undefined) patch.type = parsed.data.type;
  if (parsed.data.active !== undefined) patch.active = parsed.data.active;

  const db = getDb(c.env);
  try {
    const updated = await db.update(pwpRulesTable).set(patch).where(eq(pwpRulesTable.id, id)).returning();
    if (!updated[0]) return c.json({ error: "not_found" }, 404);
    return c.json({ rule: toApi(updated[0]) });
  } catch (e) {
    return c.json({ error: "update_failed", reason: errMsg(e) }, 500);
  }
});

// DELETE /:id.
app.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const db = getDb(c.env);
  try {
    await db.delete(pwpRulesTable).where(eq(pwpRulesTable.id, id));
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: "delete_failed", reason: errMsg(e) }, 500);
  }
});

export default app;
