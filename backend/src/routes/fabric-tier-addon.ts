// ----------------------------------------------------------------------------
// /fabric-tier-addon — the singleton config (4 whole-MYR Δ values) for the POS
// selling fabric-tier add-on + the per-Model overrides. 1:1 clone of 2990s
// apps/api/src/routes/fabric-tier-addon.ts (PostgREST -> Drizzle).
//
// SEAMS (canonical rules): getDb(c.env) (rule #3); requirePermission("*") (rule
// #4 — 2990s gated writes via a staff-role lookup, collapsed to owner-only);
// updated_by -> users.id INTEGER soft-ref (c.get("user").id).
//
// Endpoints:
//   GET    /fabric-tier-addon                    singleton config
//   PATCH  /fabric-tier-addon                    edit the 4 deltas
//   GET    /fabric-tier-addon/special            per-Model overrides (+ model meta)
//   PUT    /fabric-tier-addon/special            upsert one Model's override
//   DELETE /fabric-tier-addon/special/:modelId   un-tag a Model
// ----------------------------------------------------------------------------

import { Hono } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { Env } from "../types";
import { getDb } from "../db/client";
import {
  fabricTierAddonConfig as fabricTierAddonConfigTable,
  modelFabricTierOverrides,
  productModels as productModelsTable,
} from "../db/schema";
import { requirePermission } from "../middleware/auth";

const app = new Hono<{ Bindings: Env }>();

app.use("*", requirePermission("*"));

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const patchSchema = z.object({
  sofaTier2Delta: z.number().int().nonnegative().optional(),
  sofaTier3Delta: z.number().int().nonnegative().optional(),
  bedframeTier2Delta: z.number().int().nonnegative().optional(),
  bedframeTier3Delta: z.number().int().nonnegative().optional(),
});

// GET — singleton (id=1).
app.get("/", async (c) => {
  const db = getDb(c.env);
  try {
    const rows = await db
      .select()
      .from(fabricTierAddonConfigTable)
      .where(eq(fabricTierAddonConfigTable.id, 1))
      .limit(1);
    const data = rows[0];
    if (!data) return c.json({ error: "fetch_failed", reason: "config row missing" }, 500);
    return c.json({
      sofaTier2Delta: data.sofaTier2Delta,
      sofaTier3Delta: data.sofaTier3Delta,
      bedframeTier2Delta: data.bedframeTier2Delta,
      bedframeTier3Delta: data.bedframeTier3Delta,
      updatedAt: data.updatedAt instanceof Date ? data.updatedAt.toISOString() : data.updatedAt,
      updatedBy: data.updatedBy,
    });
  } catch (e) {
    return c.json({ error: "fetch_failed", reason: errMsg(e) }, 500);
  }
});

// PATCH — edit the 4 deltas.
app.patch("/", async (c) => {
  const user = c.get("user");
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

  const patch: Record<string, unknown> = { updatedAt: new Date(), updatedBy: user.id };
  if (parsed.data.sofaTier2Delta !== undefined) patch.sofaTier2Delta = parsed.data.sofaTier2Delta;
  if (parsed.data.sofaTier3Delta !== undefined) patch.sofaTier3Delta = parsed.data.sofaTier3Delta;
  if (parsed.data.bedframeTier2Delta !== undefined) patch.bedframeTier2Delta = parsed.data.bedframeTier2Delta;
  if (parsed.data.bedframeTier3Delta !== undefined) patch.bedframeTier3Delta = parsed.data.bedframeTier3Delta;

  const db = getDb(c.env);
  try {
    const updated = await db
      .update(fabricTierAddonConfigTable)
      .set(patch)
      .where(eq(fabricTierAddonConfigTable.id, 1))
      .returning({ id: fabricTierAddonConfigTable.id });
    if (!updated.length) return c.json({ error: "update_failed", reason: "config row missing" }, 500);
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: "update_failed", reason: errMsg(e) }, 500);
  }
});

// ── Per-Model overrides ─────────────────────────────────────────────────
const specialSchema = z.object({
  modelId: z.string().uuid(),
  tier2Delta: z.number().int().nonnegative().nullable(),
  tier3Delta: z.number().int().nonnegative().nullable(),
});

// GET /special — every override row + its Model's name/code/category.
app.get("/special", async (c) => {
  const db = getDb(c.env);
  try {
    const rows = await db
      .select({
        model_id: modelFabricTierOverrides.modelId,
        tier2_delta: modelFabricTierOverrides.tier2Delta,
        tier3_delta: modelFabricTierOverrides.tier3Delta,
        updated_at: modelFabricTierOverrides.updatedAt,
        name: productModelsTable.name,
        model_code: productModelsTable.modelCode,
        category: productModelsTable.category,
      })
      .from(modelFabricTierOverrides)
      .leftJoin(productModelsTable, eq(modelFabricTierOverrides.modelId, productModelsTable.id));
    const out = rows.map((r) => ({
      modelId: r.model_id,
      modelName: r.name ?? "(unknown model)",
      modelCode: r.model_code ?? null,
      category: r.category ?? null,
      tier2Delta: r.tier2_delta,
      tier3Delta: r.tier3_delta,
      updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at,
    }));
    return c.json(out);
  } catch (e) {
    return c.json({ error: "fetch_failed", reason: errMsg(e) }, 500);
  }
});

// PUT /special — upsert one Model's override.
app.put("/special", async (c) => {
  const user = c.get("user");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const parsed = specialSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "validation_failed", issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) }, 400);
  }

  const db = getDb(c.env);
  try {
    await db
      .insert(modelFabricTierOverrides)
      .values({
        modelId: parsed.data.modelId,
        tier2Delta: parsed.data.tier2Delta,
        tier3Delta: parsed.data.tier3Delta,
        updatedAt: new Date(),
        updatedBy: user.id,
      })
      .onConflictDoUpdate({
        target: modelFabricTierOverrides.modelId,
        set: {
          tier2Delta: parsed.data.tier2Delta,
          tier3Delta: parsed.data.tier3Delta,
          updatedAt: new Date(),
          updatedBy: user.id,
        },
      });
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: "upsert_failed", reason: errMsg(e) }, 500);
  }
});

// DELETE /special/:modelId — revert to the global Δ.
app.delete("/special/:modelId", async (c) => {
  const modelId = c.req.param("modelId");
  const db = getDb(c.env);
  try {
    await db.delete(modelFabricTierOverrides).where(eq(modelFabricTierOverrides.modelId, modelId));
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: "delete_failed", reason: errMsg(e) }, 500);
  }
});

export default app;
