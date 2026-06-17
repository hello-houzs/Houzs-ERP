// ----------------------------------------------------------------------------
// /mrp-lead-times — per-category MRP lead time (1:1 clone of 2990s
// apps/api/src/routes/mrp-lead-times.ts).
//
// Backs the "Lead Time" mini-table + feeds the MRP server's order-by-date calc.
// Five fixed categories, one integer each (days to order BEFORE the SO delivery
// date). See migration 0032 (mrp_category_lead_times).
//
// Endpoints (identical wire shapes to 2990s):
//   GET /     — { leadTimes: { sofa: 0, bedframe: 7, mattress: 0, ... } }
//   PUT /     — body { category, leadDays } → upsert one category
//
// SEAMS (canonical clone rules):
//   - DB layer: 2990s Supabase PostgREST (sb.from().upsert()) -> Houzs Drizzle
//     getDb(c.env) + onConflictDoUpdate (rule #3). Same JSON in/out (rule #7).
//   - Auth: 2990s supabaseAuth -> Houzs requirePermission("*") (rule #4).
// ----------------------------------------------------------------------------

import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import { getDb } from "../db/client";
import { mrpCategoryLeadTimes } from "../db/schema";
import { requirePermission } from "../middleware/auth";

const app = new Hono<{ Bindings: Env }>();
app.use("*", requirePermission("*"));

const CATEGORIES = ["sofa", "bedframe", "mattress", "accessory", "service"] as const;
type Category = (typeof CATEGORIES)[number];
const putSchema = z.object({
  category: z.enum(CATEGORIES),
  leadDays: z.number().int().min(0),
});

// GET / — all five categories as a { category: leadDays } map. Missing rows
// (shouldn't happen post-seed) default to 0 so the UI always renders 5 rows.
app.get("/", async (c) => {
  const db = getDb(c.env);
  try {
    const rows = await db
      .select({ category: mrpCategoryLeadTimes.category, leadDays: mrpCategoryLeadTimes.leadDays })
      .from(mrpCategoryLeadTimes);
    const leadTimes: Record<Category, number> = {
      sofa: 0, bedframe: 0, mattress: 0, accessory: 0, service: 0,
    };
    for (const r of rows) {
      if ((CATEGORIES as readonly string[]).includes(r.category)) {
        leadTimes[r.category as Category] = r.leadDays ?? 0;
      }
    }
    return c.json({ leadTimes });
  } catch (e) {
    return c.json({ error: "fetch_failed", reason: e instanceof Error ? e.message : String(e) }, 500);
  }
});

// PUT / — upsert one category's lead days.
app.put("/", async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }
  const parsed = putSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);

  const db = getDb(c.env);
  try {
    await db
      .insert(mrpCategoryLeadTimes)
      .values({ category: parsed.data.category, leadDays: parsed.data.leadDays, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: mrpCategoryLeadTimes.category,
        set: { leadDays: parsed.data.leadDays, updatedAt: new Date() },
      });
    return c.json({ ok: true, category: parsed.data.category, leadDays: parsed.data.leadDays });
  } catch (e) {
    return c.json({ error: "save_failed", reason: e instanceof Error ? e.message : String(e) }, 500);
  }
});

export default app;
