// ----------------------------------------------------------------------------
// mrp-lead-times — per-category MRP lead time (Commander 2026-05-29).
//
// Backs the "Lead Time" mini-table on the Sales Order Maintenance page + feeds
// the MRP server's order-by-date calc. Five fixed categories, one integer each
// (days to order BEFORE the SO delivery date). See migration 0099.
//
// Endpoints:
//   GET /     — { leadTimes: { sofa: 0, bedframe: 7, mattress: 0, ... } }
//   PUT /     — body { category, leadDays } → upsert one category
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import { z } from 'zod';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';

export const mrpLeadTimes = new Hono<{ Bindings: Env; Variables: Variables }>();
mrpLeadTimes.use('*', supabaseAuth);

const CATEGORIES = ['sofa', 'bedframe', 'mattress', 'accessory', 'service'] as const;
type Category = (typeof CATEGORIES)[number];
const putSchema = z.object({
  category: z.enum(CATEGORIES),
  leadDays: z.number().int().min(0),
});

type DbRow = { category: string; lead_days: number };

// GET / — all five categories as a { category: leadDays } map. Missing rows
// (shouldn't happen post-seed) default to 0 so the UI always renders 5 rows.
mrpLeadTimes.get('/', async (c) => {
  const sb = c.get('supabase');
  const { data, error } = await sb
    .from('mrp_category_lead_times')
    .select('category, lead_days');
  if (error) return c.json({ error: 'fetch_failed', reason: error.message }, 500);
  const leadTimes: Record<Category, number> = {
    sofa: 0, bedframe: 0, mattress: 0, accessory: 0, service: 0,
  };
  for (const r of (data ?? []) as DbRow[]) {
    if ((CATEGORIES as readonly string[]).includes(r.category)) {
      leadTimes[r.category as Category] = r.lead_days ?? 0;
    }
  }
  return c.json({ leadTimes });
});

// PUT / — upsert one category's lead days.
mrpLeadTimes.put('/', async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = putSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);

  const sb = c.get('supabase');
  const { error } = await sb
    .from('mrp_category_lead_times')
    .upsert(
      { category: parsed.data.category, lead_days: parsed.data.leadDays, updated_at: new Date().toISOString() },
      { onConflict: 'category' },
    );
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  return c.json({ ok: true, category: parsed.data.category, leadDays: parsed.data.leadDays });
});
