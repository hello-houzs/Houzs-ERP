// /fabric-tier-addon — the singleton config (4 whole-MYR Δ values) for the POS
// selling fabric-tier add-on. Mirrors delivery-fees.ts. Read by any staff;
// written by admin/coordinator/sales_director (server check + RLS, migration 0124).
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

// Exported name avoids clashing with the shared `fabricTierAddon` pure function.
export const fabricTierAddonConfig = new Hono<{ Bindings: Env; Variables: Variables }>();

fabricTierAddonConfig.use('*', supabaseAuth);

// super_admin added 2026-06-12 — the role (mig 0162) postdates this route (0124).
// RLS counterpart: migration 0166 adds super_admin to the UPDATE policy.
const WRITE_ROLES = new Set(['admin', 'super_admin', 'coordinator', 'sales_director']);

const patchSchema = z.object({
  sofaTier2Delta:     z.number().int().nonnegative().optional(),
  sofaTier3Delta:     z.number().int().nonnegative().optional(),
  bedframeTier2Delta: z.number().int().nonnegative().optional(),
  bedframeTier3Delta: z.number().int().nonnegative().optional(),
});

// GET — every authenticated staff role can read.
fabricTierAddonConfig.get('/', async (c) => {
  const supabase = c.get('supabase');
  const { data, error } = await supabase
    .from('fabric_tier_addon_config')
    .select('sofa_tier2_delta, sofa_tier3_delta, bedframe_tier2_delta, bedframe_tier3_delta, updated_at, updated_by')
    .eq('id', 1)
    .single();
  if (error) return c.json({ error: 'fetch_failed', reason: error.message }, 500);
  return c.json({
    sofaTier2Delta:     data.sofa_tier2_delta,
    sofaTier3Delta:     data.sofa_tier3_delta,
    bedframeTier2Delta: data.bedframe_tier2_delta,
    bedframeTier3Delta: data.bedframe_tier3_delta,
    updatedAt:          data.updated_at,
    updatedBy:          data.updated_by,
  });
});

// PATCH — editors only. Server role check + RLS defence-in-depth (migration 0124).
fabricTierAddonConfig.patch('/', async (c) => {
  const userId   = c.get('user').id;
  const supabase = c.get('supabase');

  const staffRes = await supabase.from('staff').select('role, active').eq('id', userId).maybeSingle();
  if (staffRes.error) return c.json({ error: 'role_lookup_failed', reason: staffRes.error.message }, 500);
  if (!staffRes.data || !staffRes.data.active) return c.json({ error: 'forbidden', reason: 'no_active_staff' }, 403);
  if (!WRITE_ROLES.has(staffRes.data.role)) return c.json({ error: 'forbidden', reason: 'fabric_tier_editor_only' }, 403);

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'validation_failed', issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) }, 400);
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString(), updated_by: userId };
  if (parsed.data.sofaTier2Delta     !== undefined) patch.sofa_tier2_delta     = parsed.data.sofaTier2Delta;
  if (parsed.data.sofaTier3Delta     !== undefined) patch.sofa_tier3_delta     = parsed.data.sofaTier3Delta;
  if (parsed.data.bedframeTier2Delta !== undefined) patch.bedframe_tier2_delta = parsed.data.bedframeTier2Delta;
  if (parsed.data.bedframeTier3Delta !== undefined) patch.bedframe_tier3_delta = parsed.data.bedframeTier3Delta;

  // .select() so an RLS USING-filter (0 rows touched) surfaces as an error
  // instead of a phantom ok:true — exactly how the super_admin gap hid for days.
  const { data: updated, error } = await supabase.from('fabric_tier_addon_config').update(patch).eq('id', 1).select('id');
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  if (!updated || updated.length === 0) return c.json({ error: 'update_failed', reason: 'rls_blocked_zero_rows' }, 403);
  return c.json({ ok: true });
});

/* ─── Per-Model fabric-tier Δ overrides (migration 0172) ───────────────────
   A row gives a Model its own selling fabric-tier Δ that REPLACES the global
   config for that Model; NULL tier = inherit. Read by all staff (the SO POST
   recomputes from it); write for the same editor set as the global config.
   Mirrors delivery-fees.ts /special. */

const specialSchema = z.object({
  modelId:    z.string().uuid(),
  tier2Delta: z.number().int().nonnegative().nullable(),
  tier3Delta: z.number().int().nonnegative().nullable(),
});

// Reused role gate for the per-Model writes (mirrors the PATCH gate above).
const requireFabricEditor = async (c: AppContext) => {
  const userId   = c.get('user').id;
  const supabase = c.get('supabase');
  const staffRes = await supabase.from('staff').select('role, active').eq('id', userId).maybeSingle();
  if (staffRes.error)                          return { error: c.json({ error: 'role_lookup_failed', reason: staffRes.error.message }, 500) };
  if (!staffRes.data || !staffRes.data.active) return { error: c.json({ error: 'forbidden', reason: 'no_active_staff' }, 403) };
  if (!WRITE_ROLES.has(staffRes.data.role))    return { error: c.json({ error: 'forbidden', reason: 'fabric_tier_editor_only' }, 403) };
  return { userId, supabase };
};

// GET — list every override row with its Model's name + code + category.
fabricTierAddonConfig.get('/special', async (c) => {
  const supabase = c.get('supabase');
  const { data, error } = await supabase
    .from('model_fabric_tier_overrides')
    .select('model_id, tier2_delta, tier3_delta, updated_at, product_models(name, model_code, category)');
  if (error) return c.json({ error: 'fetch_failed', reason: error.message }, 500);
  const rows = (data ?? []).map((r) => {
    const pm = (r as { product_models?: { name?: string; model_code?: string; category?: string } | null }).product_models ?? null;
    return {
      modelId:    (r as { model_id: string }).model_id,
      modelName:  pm?.name ?? '(unknown model)',
      modelCode:  pm?.model_code ?? null,
      category:   pm?.category ?? null,
      tier2Delta: (r as { tier2_delta: number | null }).tier2_delta,
      tier3Delta: (r as { tier3_delta: number | null }).tier3_delta,
      updatedAt:  (r as { updated_at: string }).updated_at,
    };
  });
  return c.json(rows);
});

// PUT — upsert one Model's override (tier deltas may be null = inherit global).
fabricTierAddonConfig.put('/special', async (c) => {
  const gate = await requireFabricEditor(c);
  if ('error' in gate) return gate.error;

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = specialSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'validation_failed', issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) }, 400);
  }

  const { data: updated, error } = await gate.supabase
    .from('model_fabric_tier_overrides')
    .upsert({
      model_id:    parsed.data.modelId,
      tier2_delta: parsed.data.tier2Delta,
      tier3_delta: parsed.data.tier3Delta,
      updated_at:  new Date().toISOString(),
      updated_by:  gate.userId,
    }, { onConflict: 'model_id' })
    .select('model_id');
  if (error) return c.json({ error: 'upsert_failed', reason: error.message }, 500);
  if (!updated || updated.length === 0) return c.json({ error: 'upsert_failed', reason: 'rls_blocked_zero_rows' }, 403);
  return c.json({ ok: true });
});

// DELETE — un-tag a Model (reverts to the global Δ).
fabricTierAddonConfig.delete('/special/:modelId', async (c) => {
  const gate = await requireFabricEditor(c);
  if ('error' in gate) return gate.error;
  const modelId = c.req.param('modelId');
  const { error } = await gate.supabase
    .from('model_fabric_tier_overrides')
    .delete()
    .eq('model_id', modelId);
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);
  return c.json({ ok: true });
});
