// /pwp-rules — purchase-with-purchase (换购优惠) rules CRUD. Read by any staff;
// written by admin/super_admin/coordinator/sales_director (server check + RLS,
// migration 0128). A rule: buying a TRIGGER (eligible model in trigger_category)
// unlocks REWARD models (eligible list in reward_category) at their pwp_price_sen.
// Pricing itself is enforced server-side in mfg-sales-orders (shared resolvePwp).
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';

type AppCtx = Context<{ Bindings: Env; Variables: Variables }>;

export const pwpRules = new Hono<{ Bindings: Env; Variables: Variables }>();

pwpRules.use('*', supabaseAuth);

const WRITE_ROLES = new Set(['admin', 'super_admin', 'coordinator', 'sales_director']);

const CATEGORY = z.enum(['SOFA', 'BEDFRAME', 'ACCESSORY', 'MATTRESS', 'SERVICE']);

const createSchema = z.object({
  triggerCategory:         CATEGORY,
  triggerEligibleModelIds: z.array(z.string()).default([]),
  triggerComboIds:         z.array(z.string()).default([]),  // SOFA trigger (Phase 2)
  rewardCategory:          CATEGORY,
  eligibleRewardModelIds:  z.array(z.string()).default([]),
  rewardComboIds:          z.array(z.string()).default([]),  // SOFA reward (Phase 2)
  qtyPerTrigger:           z.number().int().min(1).default(1),
  type:                    z.enum(['pwp', 'promo']).default('pwp'),  // promo lets a 0 reward redeem free (migration 0145)
  active:                  z.boolean().default(true),
});
const patchSchema = createSchema.partial();

type RuleRow = {
  id: string;
  trigger_category: string;
  trigger_eligible_model_ids: string[] | null;
  trigger_combo_ids: string[] | null;
  reward_category: string;
  eligible_reward_model_ids: string[] | null;
  reward_combo_ids: string[] | null;
  qty_per_trigger: number;
  type: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
};

const toApi = (r: RuleRow) => ({
  id:                      r.id,
  triggerCategory:         r.trigger_category,
  triggerEligibleModelIds: r.trigger_eligible_model_ids ?? [],
  triggerComboIds:         r.trigger_combo_ids ?? [],
  rewardCategory:          r.reward_category,
  eligibleRewardModelIds:  r.eligible_reward_model_ids ?? [],
  rewardComboIds:          r.reward_combo_ids ?? [],
  qtyPerTrigger:           r.qty_per_trigger,
  type:                    (r.type ?? 'pwp') as 'pwp' | 'promo',
  active:                  r.active,
  createdAt:               r.created_at,
  updatedAt:               r.updated_at,
});

const SELECT =
  'id, trigger_category, trigger_eligible_model_ids, trigger_combo_ids, reward_category, eligible_reward_model_ids, reward_combo_ids, qty_per_trigger, type, active, created_at, updated_at';

// Editors-only guard (server check; RLS is defence-in-depth, migration 0128).
async function requireWrite(c: AppCtx) {
  const userId = c.get('user').id;
  const supabase = c.get('supabase');
  const staffRes = await supabase.from('staff').select('role, active').eq('id', userId).maybeSingle();
  if (staffRes.error) return { ok: false as const, res: c.json({ error: 'role_lookup_failed', reason: staffRes.error.message }, 500) };
  if (!staffRes.data || !staffRes.data.active) return { ok: false as const, res: c.json({ error: 'forbidden', reason: 'no_active_staff' }, 403) };
  if (!WRITE_ROLES.has(staffRes.data.role)) return { ok: false as const, res: c.json({ error: 'forbidden', reason: 'pwp_editor_only' }, 403) };
  return { ok: true as const, userId };
}

// GET — every authenticated staff role can read (POS configurator needs it).
pwpRules.get('/', async (c) => {
  const supabase = c.get('supabase');
  const { data, error } = await supabase
    .from('pwp_rules')
    .select(SELECT)
    .order('created_at', { ascending: true });
  if (error) return c.json({ error: 'fetch_failed', reason: error.message }, 500);
  return c.json({ rules: (data as RuleRow[]).map(toApi) });
});

// POST — create. Editors only. 23505 (one-active-per-pair) → 409.
pwpRules.post('/', async (c) => {
  const gate = await requireWrite(c);
  if (!gate.ok) return gate.res;

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'validation_failed', issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) }, 400);
  }

  const supabase = c.get('supabase');
  const { data, error } = await supabase
    .from('pwp_rules')
    .insert({
      trigger_category:           parsed.data.triggerCategory,
      trigger_eligible_model_ids: parsed.data.triggerEligibleModelIds,
      trigger_combo_ids:          parsed.data.triggerComboIds,
      reward_category:            parsed.data.rewardCategory,
      eligible_reward_model_ids:  parsed.data.eligibleRewardModelIds,
      reward_combo_ids:           parsed.data.rewardComboIds,
      qty_per_trigger:            parsed.data.qtyPerTrigger,
      type:                       parsed.data.type,
      active:                     parsed.data.active,
      created_by:                 gate.userId,
    })
    .select(SELECT)
    .single();
  if (error) {
    return c.json({ error: 'create_failed', reason: error.message }, 500);
  }
  return c.json({ rule: toApi(data as RuleRow) }, 201);
});

// PATCH /:id — update. Editors only.
pwpRules.patch('/:id', async (c) => {
  const gate = await requireWrite(c);
  if (!gate.ok) return gate.res;
  const id = c.req.param('id');

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'validation_failed', issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) }, 400);
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (parsed.data.triggerCategory         !== undefined) patch.trigger_category           = parsed.data.triggerCategory;
  if (parsed.data.triggerEligibleModelIds !== undefined) patch.trigger_eligible_model_ids = parsed.data.triggerEligibleModelIds;
  if (parsed.data.triggerComboIds         !== undefined) patch.trigger_combo_ids          = parsed.data.triggerComboIds;
  if (parsed.data.rewardCategory          !== undefined) patch.reward_category            = parsed.data.rewardCategory;
  if (parsed.data.eligibleRewardModelIds  !== undefined) patch.eligible_reward_model_ids  = parsed.data.eligibleRewardModelIds;
  if (parsed.data.rewardComboIds          !== undefined) patch.reward_combo_ids           = parsed.data.rewardComboIds;
  if (parsed.data.qtyPerTrigger           !== undefined) patch.qty_per_trigger            = parsed.data.qtyPerTrigger;
  if (parsed.data.type                    !== undefined) patch.type                       = parsed.data.type;
  if (parsed.data.active                  !== undefined) patch.active                     = parsed.data.active;

  const supabase = c.get('supabase');
  const { data, error } = await supabase.from('pwp_rules').update(patch).eq('id', id).select(SELECT).maybeSingle();
  if (error) {
    return c.json({ error: 'update_failed', reason: error.message }, 500);
  }
  if (!data) return c.json({ error: 'not_found' }, 404);
  return c.json({ rule: toApi(data as RuleRow) });
});

// DELETE /:id — editors only.
pwpRules.delete('/:id', async (c) => {
  const gate = await requireWrite(c);
  if (!gate.ok) return gate.res;
  const id = c.req.param('id');
  const supabase = c.get('supabase');
  const { error } = await supabase.from('pwp_rules').delete().eq('id', id);
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);
  return c.json({ ok: true });
});
