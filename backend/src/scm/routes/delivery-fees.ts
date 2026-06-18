import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

export const deliveryFees = new Hono<{ Bindings: Env; Variables: Variables }>();

deliveryFees.use('*', supabaseAuth);

// admin + coordinator (legacy) plus sales_director — cost/sell split Phase 2
// moved the delivery fee onto the POS Master Account surface. Kept in lockstep
// with the delivery_fee_config UPDATE RLS policy (migration 0112).
const WRITE_ROLES = new Set(['admin', 'coordinator', 'sales_director']);

// Same form holds fees + lead days. Each field is independent so the PATCH
// can partial-update either group without nuking the other.
const patchSchema = z.object({
  baseFee:                  z.number().int().nonnegative().optional(),
  crossCategoryFee:         z.number().int().nonnegative().optional(),
  mattressBedframeLeadDays: z.number().int().nonnegative().optional(),
  sofaLeadDays:             z.number().int().nonnegative().optional(),
});

// GET — every authenticated staff role can read.
deliveryFees.get('/', async (c) => {
  const supabase = c.get('supabase');
  const { data, error } = await supabase
    .from('delivery_fee_config')
    .select('base_fee, cross_category_fee, mattress_bedframe_lead_days, sofa_lead_days, updated_at, updated_by')
    .eq('id', 1)
    .single();
  if (error) return c.json({ error: 'fetch_failed', reason: error.message }, 500);
  return c.json({
    baseFee:                  data.base_fee,
    crossCategoryFee:         data.cross_category_fee,
    mattressBedframeLeadDays: data.mattress_bedframe_lead_days,
    sofaLeadDays:             data.sofa_lead_days,
    updatedAt:                data.updated_at,
    updatedBy:                data.updated_by,
  });
});

// PATCH — fee editors only (admin / coordinator / sales_director). Server-side
// role check + RLS as defence-in-depth (migrations 0029 + 0112 grant UPDATE to
// exactly these roles).
deliveryFees.patch('/', async (c) => {
  const userId   = c.get('user').id;
  const supabase = c.get('supabase');

  const staffRes = await supabase.from('staff').select('role, active').eq('id', userId).maybeSingle();
  if (staffRes.error) {
    return c.json({ error: 'role_lookup_failed', reason: staffRes.error.message }, 500);
  }
  if (!staffRes.data || !staffRes.data.active) {
    return c.json({ error: 'forbidden', reason: 'no_active_staff' }, 403);
  }
  if (!WRITE_ROLES.has(staffRes.data.role)) {
    return c.json({ error: 'forbidden', reason: 'delivery_fee_editor_only' }, 403);
  }

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      error: 'validation_failed',
      issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
    }, 400);
  }

  const patch: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    updated_by: userId,
  };
  if (parsed.data.baseFee                  !== undefined) patch.base_fee                    = parsed.data.baseFee;
  if (parsed.data.crossCategoryFee         !== undefined) patch.cross_category_fee          = parsed.data.crossCategoryFee;
  if (parsed.data.mattressBedframeLeadDays !== undefined) patch.mattress_bedframe_lead_days = parsed.data.mattressBedframeLeadDays;
  if (parsed.data.sofaLeadDays             !== undefined) patch.sofa_lead_days              = parsed.data.sofaLeadDays;

  const { error } = await supabase
    .from('delivery_fee_config')
    .update(patch)
    .eq('id', 1);
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  return c.json({ ok: true });
});

/* ─── Per-Model special delivery fees (migration 0140) ─────────────────────
   A row tags a Model as special: standalone_fee overrides the base delivery
   fee; cross_cat_followup_fee applies when the model's SO is a cross-category
   follow-up. Read for any staff (the order POST recomputes from it); write for
   the same fee-editor roles as the config above. Fees are whole MYR. */

const specialFeeSchema = z.object({
  modelId:             z.string().uuid(),
  standaloneFee:       z.number().int().nonnegative(),
  crossCatFollowupFee: z.number().int().nonnegative(),
});

// Reused role gate for the special-fee writes.
const requireFeeEditor = async (c: AppContext) => {
  const userId   = c.get('user').id;
  const supabase = c.get('supabase');
  const staffRes = await supabase.from('staff').select('role, active').eq('id', userId).maybeSingle();
  if (staffRes.error)                       return { error: c.json({ error: 'role_lookup_failed', reason: staffRes.error.message }, 500) };
  if (!staffRes.data || !staffRes.data.active) return { error: c.json({ error: 'forbidden', reason: 'no_active_staff' }, 403) };
  if (!WRITE_ROLES.has(staffRes.data.role)) return { error: c.json({ error: 'forbidden', reason: 'delivery_fee_editor_only' }, 403) };
  return { userId, supabase };
};

// GET — list every special-fee row with its Model's name + category.
deliveryFees.get('/special', async (c) => {
  const supabase = c.get('supabase');
  const { data, error } = await supabase
    .from('model_special_delivery_fees')
    .select('model_id, standalone_fee, cross_cat_followup_fee, updated_at, product_models(name, model_code, category)');
  if (error) return c.json({ error: 'fetch_failed', reason: error.message }, 500);
  const rows = (data ?? []).map((r) => {
    const pm = (r as { product_models?: { name?: string; model_code?: string; category?: string } | null }).product_models ?? null;
    return {
      modelId:             (r as { model_id: string }).model_id,
      modelName:           pm?.name ?? '(unknown model)',
      modelCode:           pm?.model_code ?? null,
      category:            pm?.category ?? null,
      standaloneFee:       (r as { standalone_fee: number }).standalone_fee,
      crossCatFollowupFee: (r as { cross_cat_followup_fee: number }).cross_cat_followup_fee,
      updatedAt:           (r as { updated_at: string }).updated_at,
    };
  });
  return c.json(rows);
});

// PUT — upsert one Model's special fees (whole MYR).
deliveryFees.put('/special', async (c) => {
  const gate = await requireFeeEditor(c);
  if ('error' in gate) return gate.error;

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = specialFeeSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      error: 'validation_failed',
      issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
    }, 400);
  }

  const { error } = await gate.supabase
    .from('model_special_delivery_fees')
    .upsert({
      model_id:               parsed.data.modelId,
      standalone_fee:         parsed.data.standaloneFee,
      cross_cat_followup_fee: parsed.data.crossCatFollowupFee,
      updated_at:             new Date().toISOString(),
      updated_by:             gate.userId,
    }, { onConflict: 'model_id' });
  if (error) return c.json({ error: 'upsert_failed', reason: error.message }, 500);
  return c.json({ ok: true });
});

// DELETE — un-tag a Model (it reverts to the normal base/cross fee).
deliveryFees.delete('/special/:modelId', async (c) => {
  const gate = await requireFeeEditor(c);
  if ('error' in gate) return gate.error;
  const modelId = c.req.param('modelId');
  const { error } = await gate.supabase
    .from('model_special_delivery_fees')
    .delete()
    .eq('model_id', modelId);
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);
  return c.json({ ok: true });
});
