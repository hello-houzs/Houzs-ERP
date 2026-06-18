// /fabric-library — PATCH the SELLING tier on a customer-pickable fabric_library
// row. Distinct from /fabric-tracking (procurement/cost tiers). Master Admin only
// (server role check + RLS defence-in-depth, migration 0124).
import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';

export const fabricLibrary = new Hono<{ Bindings: Env; Variables: Variables }>();

fabricLibrary.use('*', supabaseAuth);

// super_admin added 2026-06-12 — the role (mig 0162) postdates this route (0124);
// without it Loo's tier clicks 403'd while the POS UI showed the buttons enabled.
const WRITE_ROLES = new Set(['admin', 'super_admin', 'coordinator', 'sales_director']);
const VALID_TIER_FIELDS = new Set(['sofaTier', 'bedframeTier']);
const VALID_TIERS = new Set(['PRICE_1', 'PRICE_2', 'PRICE_3']);
const TIER_FIELD_TO_COL: Record<string, string> = { sofaTier: 'sofa_tier', bedframeTier: 'bedframe_tier' };

fabricLibrary.patch('/:id/tier', async (c) => {
  const id       = c.req.param('id');
  const userId   = c.get('user').id;
  const supabase = c.get('supabase');

  const staffRes = await supabase.from('staff').select('role, active').eq('id', userId).maybeSingle();
  if (staffRes.error) return c.json({ error: 'role_lookup_failed', reason: staffRes.error.message }, 500);
  if (!staffRes.data || !staffRes.data.active) return c.json({ error: 'forbidden', reason: 'no_active_staff' }, 403);
  if (!WRITE_ROLES.has(staffRes.data.role)) return c.json({ error: 'forbidden', reason: 'fabric_tier_editor_only' }, 403);

  let body: { field?: string; tier?: string };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (!body.field || !VALID_TIER_FIELDS.has(body.field)) return c.json({ error: 'invalid_field', allowed: [...VALID_TIER_FIELDS] }, 400);
  if (!body.tier  || !VALID_TIERS.has(body.tier))        return c.json({ error: 'invalid_tier',  allowed: [...VALID_TIERS] }, 400);

  const col = TIER_FIELD_TO_COL[body.field]!;
  // .select() so an RLS USING-filter (0 rows touched) surfaces as an error
  // instead of a phantom ok:true.
  const { data: updated, error } = await supabase.from('fabric_library').update({ [col]: body.tier }).eq('id', id).select('id');
  if (error) {
    if (error.code === '42501' || /permission denied/i.test(error.message)) {
      return c.json({ error: 'forbidden', reason: error.message }, 403);
    }
    return c.json({ error: 'update_failed', reason: error.message }, 500);
  }
  if (!updated || updated.length === 0) return c.json({ error: 'update_failed', reason: 'not_found_or_rls_blocked' }, 404);
  return c.json({ ok: true });
});
