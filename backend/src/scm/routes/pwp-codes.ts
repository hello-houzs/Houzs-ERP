// /pwp-codes — PWP (换购) voucher codes (migration 0130, Chairman 2026-06-02).
// Adding a TRIGGER to a cart RESERVES N = rule.qty_per_trigger × qty codes (each
// = one reward redemption); removing the trigger frees them. At order Confirm
// (in mfg-sales-orders) an applied code → USED, an un-applied reserved code →
// AVAILABLE (printed on the SO, redeemable cross-order). This route is the
// reserve / free / validate surface; the consume + mark-used step lives in the
// order route so it shares the order's transaction-like flow.
//
// Any authenticated active staff may reserve/free/validate — a salesperson owns
// their cart's codes, and a cross-order redemption validates another staff's
// AVAILABLE code. RLS (migration 0130) is defence-in-depth.
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { matchComboSubset, passesRefinementColumns } from '../shared';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';

type AppCtx = Context<{ Bindings: Env; Variables: Variables }>;

export const pwpCodes = new Hono<{ Bindings: Env; Variables: Variables }>();

pwpCodes.use('*', supabaseAuth);

// product_models.id list match: [] = whole category, else the modelId must be in
// the list (null modelId never matches a non-empty list). Mirrors shared/pwp.ts.
export const inList = (modelId: string | null, list: string[]): boolean =>
  list.length === 0 ? true : modelId != null && list.includes(modelId);

// 'PWP-' + 4 digits + 4 uppercase A–Z. ~4.5B combos; retry on the (astronomically
// rare) PK collision. crypto.getRandomValues is available in the Workers runtime.
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export function genCode(): string {
  const buf = new Uint32Array(8);
  crypto.getRandomValues(buf);
  let digits = '';
  for (let i = 0; i < 4; i++) digits += String((buf[i] ?? 0) % 10);
  let letters = '';
  for (let i = 0; i < 4; i++) letters += LETTERS[(buf[4 + i] ?? 0) % 26];
  return `PWP-${digits}${letters}`;
}

type CodeRow = {
  code: string;
  rule_id: string | null;
  reward_category: string;
  eligible_reward_model_ids: string[] | null;
  reward_combo_ids: string[] | null;
  status: string;
  owner_staff_id: string | null;
  cart_line_key: string | null;
  trigger_item_code: string | null;
  source_doc_no: string | null;
  redeemed_doc_no: string | null;
  redeemed_item_code: string | null;
  customer_id: string | null;
  type: string | null;
};

const SELECT =
  'code, rule_id, reward_category, eligible_reward_model_ids, reward_combo_ids, status, owner_staff_id, ' +
  'cart_line_key, trigger_item_code, source_doc_no, redeemed_doc_no, redeemed_item_code, customer_id, type';

const toApi = (r: CodeRow) => ({
  code:                    r.code,
  ruleId:                  r.rule_id,
  rewardCategory:          r.reward_category,
  eligibleRewardModelIds:  r.eligible_reward_model_ids ?? [],
  rewardComboIds:          r.reward_combo_ids ?? [],
  type:                    (r.type ?? 'pwp') as 'pwp' | 'promo',
  status:                  r.status,
  cartLineKey:             r.cart_line_key,
  triggerItemCode:         r.trigger_item_code,
  sourceDocNo:             r.source_doc_no,
  customerId:              r.customer_id,
});

/* ── GET /mine — the caller's RESERVED codes, for the POS cart reconciler +
      the reward configurator's "Apply PWP" toggle (which code is available in
      THIS cart). Keyed by cart_line_key on the client. */
pwpCodes.get('/mine', async (c) => {
  const u = c.get('user');
  if (!u?.id) return c.json({ error: 'auth_required' }, 401);
  const userId = u.id;
  const supabase = c.get('supabase');
  const { data, error } = await supabase
    .from('pwp_codes')
    .select(SELECT)
    .eq('owner_staff_id', userId)
    .eq('status', 'RESERVED');
  if (error) return c.json({ error: 'fetch_failed', reason: error.message }, 500);
  return c.json({ codes: ((data as unknown as CodeRow[]) ?? []).map(toApi) });
});

const reserveSchema = z.object({
  cartLineKey: z.string().min(1),
  productId:   z.string().min(1),  // mfg_products.id of the trigger SKU
  qty:         z.number().int().min(1).default(1),
  // SOFA trigger (Phase 2) — the build's module codes (cell.moduleId). Matched
  // server-side against a SOFA rule's trigger_combo_ids. Omitted for non-sofa.
  sofaModules: z.array(z.string()).optional(),
  // Promo is ONE-WAY (Loo 2026-06-06): when the line is itself a reward
  // (bought with a PWP/promo code) it must never mint 'promo' codes — a free
  // ARRUS can't fund the next free ARRUS. 'pwp' rules still apply (换购 may
  // chain). The POS reconciler sets this; the order-Confirm backstop in
  // mfg-sales-orders.ts catches anything that slips through.
  rewardLine:  z.boolean().optional(),
});

/* ── POST /reserve — reserve codes for a trigger cart line. Idempotent per
      cart_line_key: re-reserving the same line tops up / trims to the current
      qty rather than double-generating. Returns the line's full RESERVED set.
      No rule matches → []. */
pwpCodes.post('/reserve', async (c) => {
  const u = c.get('user');
  if (!u?.id) return c.json({ error: 'auth_required' }, 401);
  const userId = u.id;
  const supabase = c.get('supabase');

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = reserveSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'validation_failed', issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) }, 400);
  }
  const { cartLineKey, productId, qty, rewardLine } = parsed.data;

  // 1. The trigger product (category + model + base_model for sofa combos).
  const { data: prod } = await supabase
    .from('mfg_products')
    .select('code, category, model_id, base_model, size_code')
    .eq('id', productId)
    .maybeSingle();
  if (!prod) return c.json({ codes: [] });  // unknown product → nothing to reserve
  const prodCat = String(prod.category).toUpperCase();
  const triggerSizeCode = prod.size_code ? String(prod.size_code).toUpperCase() : null;

  // 2. Active rules.
  const { data: ruleRows } = await supabase
    .from('pwp_rules')
    .select('id, trigger_category, trigger_eligible_model_ids, trigger_combo_ids, reward_category, eligible_reward_model_ids, reward_combo_ids, trigger_size_codes, trigger_compartments, reward_size_codes, reward_compartments, qty_per_trigger, type')
    .eq('active', true);
  const rules = (ruleRows ?? []) as Array<{
    id: string; trigger_category: string; trigger_eligible_model_ids: string[] | null;
    trigger_combo_ids: string[] | null; reward_category: string;
    eligible_reward_model_ids: string[] | null; reward_combo_ids: string[] | null; qty_per_trigger: number;
    trigger_size_codes: string[] | null; trigger_compartments: string[] | null;
    reward_size_codes: string[] | null; reward_compartments: string[] | null;
    type: string | null;
  }>;

  // 2b. Rules whose trigger matches this line. SOFA → match the build against the
  //     rule's trigger_combo_ids (Phase 2); other categories → model match.
  let matching: typeof rules;
  if (prodCat === 'SOFA') {
    const sofaModules = (parsed.data.sofaModules ?? []).map((s) => s.trim()).filter(Boolean);
    if (sofaModules.length === 0) return c.json({ codes: [] });
    const sofaRules = rules.filter((r) => r.trigger_category === 'SOFA' && (r.trigger_combo_ids ?? []).length > 0);
    const comboIds = [...new Set(sofaRules.flatMap((r) => r.trigger_combo_ids ?? []))];
    const combosById = new Map<string, { base_model: string; modules: string[][] }>();
    if (comboIds.length > 0) {
      const { data: comboRows } = await supabase
        .from('sofa_combo_pricing')
        .select('id, base_model, modules, deleted_at')
        .in('id', comboIds);
      for (const cr of (comboRows ?? []) as Array<{ id: string; base_model: string; modules: string[][]; deleted_at: string | null }>) {
        if (!cr.deleted_at) combosById.set(cr.id, { base_model: cr.base_model, modules: cr.modules ?? [] });
      }
    }
    matching = sofaRules.filter((r) => (r.trigger_combo_ids ?? []).some((cid) => {
      const combo = combosById.get(cid);
      return !!combo && (!prod.base_model || combo.base_model === prod.base_model) && matchComboSubset(sofaModules, combo.modules) != null;
    }));
  } else {
    matching = rules.filter((r) =>
      r.trigger_category === prodCat
      && inList(prod.model_id ?? null, r.trigger_eligible_model_ids ?? [])
      // Size refinement (0182): a mattress/bedframe trigger may require a size.
      && passesRefinementColumns(
        { category: prodCat, modelId: prod.model_id ?? null, sizeCode: triggerSizeCode, builtCompartments: [] },
        r.trigger_size_codes, r.trigger_compartments,
      ),
    );
  }

  // 2c. Promo is one-way (Loo 2026-06-06) — a reward line never mints 'promo'
  //     codes; only full-price purchases fund a free reward. 'pwp' rules stay.
  if (rewardLine) {
    matching = matching.filter((r) => String(r.type ?? 'pwp') !== 'promo');
  }

  // 3. Existing RESERVED codes for this cart line, grouped by rule.
  const { data: existingRows } = await supabase
    .from('pwp_codes')
    .select(SELECT)
    .eq('cart_line_key', cartLineKey)
    .eq('status', 'RESERVED');
  const existing = (existingRows as CodeRow[] | null) ?? [];

  // 4. Reconcile each matching rule to target = qty_per_trigger × qty.
  for (const rule of matching) {
    const target = Math.max(0, Math.floor((Number(rule.qty_per_trigger) || 1) * qty));
    const mine = existing.filter((e) => e.rule_id === rule.id);
    if (mine.length < target) {
      // Top up — insert (target − have) fresh codes, retrying on PK collision.
      for (let i = 0; i < target - mine.length; i++) {
        for (let attempt = 0; attempt < 5; attempt++) {
          const { error } = await supabase.from('pwp_codes').insert({
            code:                      genCode(),
            rule_id:                   rule.id,
            reward_category:           rule.reward_category,
            eligible_reward_model_ids: rule.eligible_reward_model_ids ?? [],
            reward_combo_ids:          rule.reward_combo_ids ?? [],
            // Snapshot the reward refinement (0182) so a claim enforces it later.
            reward_size_codes:         rule.reward_size_codes ?? [],
            reward_compartments:       rule.reward_compartments ?? [],
            type:                      rule.type ?? 'pwp',
            status:                    'RESERVED',
            owner_staff_id:            userId,
            cart_line_key:             cartLineKey,
            trigger_item_code:         prod.code,
          });
          if (!error) break;
          if (attempt === 4) return c.json({ error: 'reserve_failed', reason: error.message }, 500);
          // else: likely a code-collision (23505) → regenerate and retry.
        }
      }
    } else if (mine.length > target) {
      // Qty reduced — trim the surplus RESERVED codes for this line+rule.
      const surplus = mine.slice(target).map((e) => e.code);
      if (surplus.length > 0) {
        await supabase.from('pwp_codes').delete().in('code', surplus).eq('status', 'RESERVED');
      }
    }
  }

  // 4b. Trim RESERVED codes whose rule no longer matches this line at all —
  //     the line's model was edited away from a rule's trigger list, or the
  //     line became a reward and promo rules dropped out of `matching` (2c).
  //     Without this they'd ride to AVAILABLE at order Confirm as phantom
  //     vouchers the customer never legitimately earned.
  {
    const matchingIds = new Set(matching.map((r) => r.id));
    const strays = existing
      .filter((e) => !e.rule_id || !matchingIds.has(e.rule_id))
      .map((e) => e.code);
    if (strays.length > 0) {
      await supabase.from('pwp_codes').delete().in('code', strays).eq('status', 'RESERVED');
    }
  }

  // 5. Return the line's current RESERVED set.
  const { data: finalRows } = await supabase
    .from('pwp_codes')
    .select(SELECT)
    .eq('cart_line_key', cartLineKey)
    .eq('status', 'RESERVED');
  return c.json({ codes: ((finalRows as CodeRow[] | null) ?? []).map(toApi) });
});

/* ── DELETE /reserve?cartLineKey=… — free a trigger line's RESERVED codes
      (trigger removed from cart / cart cleared / quote deleted). Never touches
      USED / AVAILABLE. */
pwpCodes.delete('/reserve', async (c) => {
  const supabase = c.get('supabase');
  const cartLineKey = c.req.query('cartLineKey');
  if (!cartLineKey) return c.json({ error: 'cart_line_key_required' }, 400);
  const { error } = await supabase
    .from('pwp_codes')
    .delete()
    .eq('cart_line_key', cartLineKey)
    .eq('status', 'RESERVED');
  if (error) return c.json({ error: 'free_failed', reason: error.message }, 500);
  return c.json({ ok: true });
});

/* ── GET /by-so/:docNo — the PWP codes a Sales Order earned / spent (by
      source_doc_no). USED codes were applied on that order; AVAILABLE codes are
      vouchers the customer can redeem next time. Drives the SO/receipt display. */
pwpCodes.get('/by-so/:docNo', async (c) => {
  const supabase = c.get('supabase');
  const docNo = c.req.param('docNo');
  const { data, error } = await supabase
    .from('pwp_codes')
    .select(SELECT)
    .eq('source_doc_no', docNo)
    .in('status', ['USED', 'AVAILABLE']);
  if (error) return c.json({ error: 'fetch_failed', reason: error.message }, 500);
  return c.json({ codes: ((data as unknown as CodeRow[]) ?? []).map(toApi) });
});

/* ── GET /:code?rewardCategory=…&rewardModelId=…&customerId=… — validate /
      redeem-preview for the "Insert PWP Code" cross-order field + the handover
      customer-match gate. Eligibility is checked by the reward's category +
      model (the configurator has both); the per-SKU price authority stays at
      order Confirm (server uses pwp_price_sen). Marks nothing used. */
pwpCodes.get('/:code', async (c) => {
  const u = c.get('user');
  if (!u?.id) return c.json({ error: 'auth_required' }, 401);
  const userId = u.id;
  const supabase = c.get('supabase');
  const code = c.req.param('code');
  const rewardCategory = (c.req.query('rewardCategory') ?? '').toUpperCase();
  const rewardModelId = c.req.query('rewardModelId') ?? '';
  const rewardComboId = c.req.query('rewardComboId') ?? '';  // SOFA reward (Phase 2)
  const customerId = c.req.query('customerId') ?? '';

  const { data: row } = await supabase.from('pwp_codes').select(SELECT).eq('code', code).maybeSingle();
  if (!row) return c.json({ valid: false, reason: 'not_found' });
  const r = row as unknown as CodeRow;

  // Redeemable iff AVAILABLE (cross-order voucher) or RESERVED-owned-by-caller
  // (same-cart). USED → spent.
  const redeemable = r.status === 'AVAILABLE' || (r.status === 'RESERVED' && r.owner_staff_id === userId);
  if (!redeemable) return c.json({ valid: false, reason: r.status === 'USED' ? 'already_used' : 'not_redeemable' });

  if (rewardCategory && rewardCategory !== String(r.reward_category).toUpperCase()) {
    return c.json({ valid: false, reason: 'reward_category_mismatch' });
  }
  // Eligibility — SOFA matches by combo id (Phase 2); other categories by model.
  if (String(r.reward_category).toUpperCase() === 'SOFA') {
    const combos = r.reward_combo_ids ?? [];
    if (!rewardComboId || !combos.includes(rewardComboId)) {
      return c.json({ valid: false, reason: 'reward_combo_ineligible' });
    }
  } else if (!inList(rewardModelId || null, r.eligible_reward_model_ids ?? [])) {
    return c.json({ valid: false, reason: 'reward_model_ineligible' });
  }

  // Customer binding (§8.8) — an AVAILABLE code is bound to its earning customer.
  // RESERVED (same-cart) codes have no binding yet. When no customerId is passed
  // (cart-stage optimistic Apply) → matches (the handover gate re-checks).
  let customerMatches = true;
  if (r.status === 'AVAILABLE' && r.customer_id) {
    customerMatches = customerId !== '' ? customerId === r.customer_id : true;
  }

  return c.json({ valid: true, rewardCategory: r.reward_category, customerMatches, status: r.status, type: (r.type ?? 'pwp') as 'pwp' | 'promo' });
});
