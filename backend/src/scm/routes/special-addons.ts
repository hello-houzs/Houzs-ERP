// /special-addons — Special Add-ons CRUD (Chairman 2026-06-02). Read by any
// staff (POS configurator + Modular need it); written by admin/super_admin/
// coordinator/sales_director (server check + RLS, migration 0133).
//
// A special add-on = a per-Model product add-on priced on top of the product
// (selling surcharge + 0..N follow-up choice groups), shown as an SO line
// description — NOT a SKU. `code` is the stable key reused by the per-Model gate
// (allowed_options.specials) + the SO line (variants.specials). Pricing itself is
// enforced server-side in mfg-sales-orders (later PR); this route is just the
// master editor backing the "Special Add-ons" tab.
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';

type AppCtx = Context<{ Bindings: Env; Variables: Variables }>;

export const specialAddons = new Hono<{ Bindings: Env; Variables: Variables }>();

specialAddons.use('*', supabaseAuth);

const WRITE_ROLES = new Set(['admin', 'super_admin', 'coordinator', 'sales_director']);

const CATEGORY = z.enum(['SOFA', 'BEDFRAME', 'ACCESSORY', 'MATTRESS', 'SERVICE']);

// A single pickable choice inside a follow-up question. extraSen may be negative
// (a deduction) — matches the table's no-CHECK-on-sign design (Chairman C).
const choiceSchema = z.object({
  label:    z.string().min(1),
  extraSen: z.number().int().default(0),
});
// One follow-up question (e.g. "Thickness" → 10" / 8"). 0..N per add-on.
const groupSchema = z.object({
  label:    z.string().min(1),
  required: z.boolean().default(true),
  choices:  z.array(choiceSchema).min(1),
});

const createSchema = z.object({
  code:            z.string().min(1),
  label:           z.string().min(1),
  soDescription:   z.string().default(''),
  categories:      z.array(CATEGORY).default([]),
  sellingPriceSen: z.number().int().default(0),   // may be negative
  costPriceSen:    z.number().int().default(0),    // may be negative
  optionGroups:    z.array(groupSchema).default([]),
  active:          z.boolean().default(true),
  sortOrder:       z.number().int().default(0),
});
const patchSchema = createSchema.partial();

type OptionGroup = z.infer<typeof groupSchema>;

type AddonRow = {
  id: string;
  code: string;
  label: string;
  so_description: string;
  categories: string[] | null;
  selling_price_sen: number;
  cost_price_sen: number;
  option_groups: OptionGroup[] | null;
  active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

const toApi = (r: AddonRow) => ({
  id:              r.id,
  code:            r.code,
  label:           r.label,
  soDescription:   r.so_description,
  categories:      r.categories ?? [],
  sellingPriceSen: r.selling_price_sen,
  costPriceSen:    r.cost_price_sen,
  optionGroups:    r.option_groups ?? [],
  active:          r.active,
  sortOrder:       r.sort_order,
  createdAt:       r.created_at,
  updatedAt:       r.updated_at,
});

const SELECT =
  'id, code, label, so_description, categories, selling_price_sen, cost_price_sen, option_groups, active, sort_order, created_at, updated_at';

// Editors-only guard (server check; RLS is defence-in-depth, migration 0133).
async function requireWrite(c: AppCtx) {
  const userId = c.get('user').id;
  const supabase = c.get('supabase');
  const staffRes = await supabase.from('staff').select('role, active').eq('id', userId).maybeSingle();
  if (staffRes.error) return { ok: false as const, res: c.json({ error: 'role_lookup_failed', reason: staffRes.error.message }, 500) };
  if (!staffRes.data || !staffRes.data.active) return { ok: false as const, res: c.json({ error: 'forbidden', reason: 'no_active_staff' }, 403) };
  if (!WRITE_ROLES.has(staffRes.data.role)) return { ok: false as const, res: c.json({ error: 'forbidden', reason: 'special_addon_editor_only' }, 403) };
  return { ok: true as const, userId };
}

// GET — every authenticated staff role can read.
specialAddons.get('/', async (c) => {
  const supabase = c.get('supabase');
  const { data, error } = await supabase
    .from('special_addons')
    .select(SELECT)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) return c.json({ error: 'fetch_failed', reason: error.message }, 500);
  return c.json({ addons: (data as AddonRow[]).map(toApi) });
});

// POST — create. Editors only. 23505 (unique code) → 409.
specialAddons.post('/', async (c) => {
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
    .from('special_addons')
    .insert({
      code:              parsed.data.code,
      label:             parsed.data.label,
      so_description:    parsed.data.soDescription,
      categories:        parsed.data.categories,
      selling_price_sen: parsed.data.sellingPriceSen,
      cost_price_sen:    parsed.data.costPriceSen,
      option_groups:     parsed.data.optionGroups,
      active:            parsed.data.active,
      sort_order:        parsed.data.sortOrder,
      created_by:        gate.userId,
    })
    .select(SELECT)
    .single();
  if (error) {
    if (error.code === '23505') return c.json({ error: 'duplicate_code', reason: 'a special add-on with this code already exists' }, 409);
    return c.json({ error: 'create_failed', reason: error.message }, 500);
  }
  return c.json({ addon: toApi(data as AddonRow) }, 201);
});

// PATCH /:id — update. Editors only.
specialAddons.patch('/:id', async (c) => {
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
  if (parsed.data.code            !== undefined) patch.code              = parsed.data.code;
  if (parsed.data.label           !== undefined) patch.label             = parsed.data.label;
  if (parsed.data.soDescription   !== undefined) patch.so_description    = parsed.data.soDescription;
  if (parsed.data.categories      !== undefined) patch.categories        = parsed.data.categories;
  if (parsed.data.sellingPriceSen !== undefined) patch.selling_price_sen = parsed.data.sellingPriceSen;
  if (parsed.data.costPriceSen    !== undefined) patch.cost_price_sen    = parsed.data.costPriceSen;
  if (parsed.data.optionGroups    !== undefined) patch.option_groups     = parsed.data.optionGroups;
  if (parsed.data.active          !== undefined) patch.active            = parsed.data.active;
  if (parsed.data.sortOrder       !== undefined) patch.sort_order        = parsed.data.sortOrder;

  const supabase = c.get('supabase');
  const { data, error } = await supabase.from('special_addons').update(patch).eq('id', id).select(SELECT).maybeSingle();
  if (error) {
    if (error.code === '23505') return c.json({ error: 'duplicate_code', reason: 'a special add-on with this code already exists' }, 409);
    return c.json({ error: 'update_failed', reason: error.message }, 500);
  }
  if (!data) return c.json({ error: 'not_found' }, 404);
  return c.json({ addon: toApi(data as AddonRow) });
});

// DELETE /:id — editors only.
specialAddons.delete('/:id', async (c) => {
  const gate = await requireWrite(c);
  if (!gate.ok) return gate.res;
  const id = c.req.param('id');
  const supabase = c.get('supabase');
  const { error } = await supabase.from('special_addons').delete().eq('id', id);
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);
  return c.json({ ok: true });
});
