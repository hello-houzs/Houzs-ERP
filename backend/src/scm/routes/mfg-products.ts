// ----------------------------------------------------------------------------
// /mfg-products — Manufacturer SKU master (HOOKKA port).
//
// Separate from /products (the retail/POS catalogue). Wires into the
// Products & Maintenance page in apps/backend.
//
// Endpoints:
//   GET  /mfg-products?category=BEDFRAME&search=hilton
//   GET  /mfg-products/:id
//   PATCH /mfg-products/:id   body: { basePriceSen?, price1Sen?, ..., notes? }
//
// CREATE is intentionally deferred to a follow-up — most SKUs come from
// the Excel import. Inline create in the UI hits POST /mfg-products once
// we add a `create_mfg_product_with_history` RPC (mirrors the retail
// /products POST pattern at apps/api/src/routes/products.ts:37).
// ----------------------------------------------------------------------------

import { Hono, type Context } from 'hono';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { supabaseAuth } from '../middleware/auth';
import { escapeForOr } from '../lib/postgrest-search';
import { findSkuUsage } from '../lib/sku-usage';
import { productToBindingPatch } from '../lib/cost-anchor-sync';
import { moduleCodeFromSku, normalizeSofaTier, parseDefaultFreeGifts } from '../shared';
import type { Env, Variables } from '../env';

export const mfgProducts = new Hono<{ Bindings: Env; Variables: Variables }>();

mfgProducts.use('*', supabaseAuth);

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

// mfg_products has NO RLS — this app-layer gate is the only thing stopping a
// junior salesperson from rewriting SKU prices/data via a direct API call (the
// POS productsMode client gate is bypassable). Mirrors sofa-combos.ts.
//   EDIT/DELETE: the POS "full" set {admin, super_admin, sales_director} +
//                backend coordinator. sales_director is the POS selling-side
//                master (inherits the retired master_account, 2026-06-15) and
//                now has FULL edit (Loo 2026-06-15), not the old add-only.
//   CREATE: same set (sales_director is already a full editor).
// GET stays open — the POS salesperson must read the catalogue to price builds.
const EDIT_ROLES   = new Set(['admin', 'super_admin', 'coordinator', 'sales_director']);
const CREATE_ROLES = new Set([...EDIT_ROLES]);

async function requireRole(c: AppContext, allowed: Set<string>): Promise<{ ok: true } | { ok: false; res: Response }> {
  const supabase = c.get('supabase');
  const userId = c.get('user').id;
  const staffRes = await supabase.from('staff').select('role, active').eq('id', userId).maybeSingle();
  if (staffRes.error) return { ok: false, res: c.json({ error: 'role_lookup_failed', reason: staffRes.error.message }, 500) };
  if (!staffRes.data || !staffRes.data.active) return { ok: false, res: c.json({ error: 'forbidden', reason: 'no_active_staff' }, 403) };
  if (!allowed.has(staffRes.data.role)) return { ok: false, res: c.json({ error: 'forbidden', reason: 'product_editor_only' }, 403) };
  return { ok: true };
}

// Allowed values for the `field` column on master_price_history.
const PRICE_FIELDS = new Set(['base_price_sen', 'price1_sen', 'cost_price_sen', 'sell_price_sen', 'pwp_price_sen']);

/* ── Cost anchor (migration 0177) ─────────────────────────────────────────
   The product→binding leg of R8-at-SKU-level. After a product's COST
   (base_price_sen / price1_sen) is written, if any supplier_material_bindings
   row for this code is the cost anchor (is_cost_anchor=true), mirror the
   product cost back onto that binding so the two sides stay equal. BEST-EFFORT:
   the product write already committed, so any failure here is swallowed. SOFA
   is skipped by the pure helper. The mirror targets the binding row directly —
   it does NOT re-enter mfg-products PATCH, so there's no sync loop. */
async function syncAnchorBindingFromProduct(
  supabase: SupabaseClient,
  productCode: string,
  product: { base_price_sen: number | null; price1_sen: number | null },
): Promise<void> {
  try {
    // The anchor binding for this code (at most one — enforced app-side).
    const { data: binding } = await supabase
      .from('supplier_material_bindings')
      .select('id, price_matrix')
      .eq('material_kind', 'mfg_product')
      .eq('material_code', productCode)
      .eq('is_cost_anchor', true)
      .maybeSingle();
    if (!binding) return;

    // Category drives the mapping lane — read it off the product row we just
    // updated (passed in so we don't re-query mfg_products).
    const { data: prod } = await supabase
      .from('mfg_products')
      .select('category')
      .eq('code', productCode)
      .maybeSingle();

    const result = productToBindingPatch(
      { base_price_sen: product.base_price_sen, price1_sen: product.price1_sen },
      {
        category: (prod as { category: string | null } | null)?.category ?? null,
        price_matrix: (binding as { price_matrix: unknown }).price_matrix,
      },
    );
    if (result.skipped) return;
    if (Object.keys(result.patch).length === 0) return;

    await supabase
      .from('supplier_material_bindings')
      .update({ ...result.patch, updated_at: new Date().toISOString() })
      .eq('id', (binding as { id: string }).id);
  } catch {
    // Best-effort mirror — never surface to the primary product write.
  }
}

// ── GET / ──────────────────────────────────────────────────────────────
mfgProducts.get('/', async (c) => {
  const category = c.req.query('category');
  const search = c.req.query('search');
  const supabase = c.get('supabase');

  // PR #104 — Commander 2026-05-26: dropped fabric_usage_centi /
  // production_time_minutes / fabric_color from the public shape. The
  // columns still exist in the DB (historical data preserved) but
  // 2990's retail catalogue doesn't surface or write them anymore.
  let q = supabase
    .from('mfg_products')
    .select(
      'id, code, name, category, description, base_model, size_code, size_label, base_price_sen, price1_sen, sell_price_sen, pwp_price_sen, ' +
        'unit_m3_milli, status, pos_active, one_shot, source_doc_no, included_addons, sku_code, model_id, ' +
        'branding, barcode, sub_assemblies, pieces, seat_height_prices, default_variants, updated_at, ' +
        // Commander 2026-05-29 — surface the Model's allowed_options so the SO
        // line editor can hide variant choices the SKU doesn't allow (instead
        // of letting them be picked and failing on save with variant_not_allowed).
        'model:product_models(allowed_options)',
    )
    .eq('status', 'ACTIVE')
    .order('code', { ascending: true });

  if (category) q = q.eq('category', category);
  // 0166 — barcode rides the same OR-chain so a scanner blast into the SKU
  // Master search box finds the row (escapeForOr keeps the grammar safe).
  if (search) { const s = escapeForOr(search); if (s) q = q.or(`code.ilike.%${s}%,name.ilike.%${s}%,description.ilike.%${s}%,barcode.ilike.%${s}%`); }

  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  // Flatten the joined model → a plain allowed_options field on each product.
  const products = ((data ?? []) as unknown as Array<Record<string, unknown> & { model?: { allowed_options: unknown } | Array<{ allowed_options: unknown }> | null }>)
    .map(({ model, ...p }) => {
      const m = Array.isArray(model) ? model[0] : model;
      return { ...p, allowed_options: m?.allowed_options ?? null };
    });
  return c.json({ products });
});

// ── POST / ─────────────────────────────────────────────────────────────
// Create a new mfg_product. id is text PK — we generate a short uuid-ish
// id since the existing import uses Excel-style ids like 'mfg-xxxxxxx'.
const VALID_CATEGORIES = new Set(['SOFA', 'BEDFRAME', 'ACCESSORY', 'MATTRESS', 'SERVICE']);
mfgProducts.post('/', async (c) => {
  const gate = await requireRole(c, CREATE_ROLES);
  if (!gate.ok) return gate.res;
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const code = String(body.code ?? '').trim();
  const name = String(body.name ?? '').trim();
  const category = String(body.category ?? '').trim();
  if (!code)  return c.json({ error: 'code_required' }, 400);
  if (!name)  return c.json({ error: 'name_required' }, 400);
  if (!VALID_CATEGORIES.has(category)) return c.json({ error: 'invalid_category', allowed: [...VALID_CATEGORIES] }, 400);

  const supabase = c.get('supabase');
  // Generate a stable id matching the existing seed convention. crypto is
  // global in CF Workers; fall back if absent.
  const rand = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const id = `mfg-${rand.replace(/-/g, '').slice(0, 12)}`;

  const row: Record<string, unknown> = {
    id,
    code,
    name,
    category,
    status: 'ACTIVE',
    description: (body.description as string) ?? null,
    base_model: (body.baseModel as string) ?? null,
    size_code: (body.sizeCode as string) ?? null,
    size_label: (body.sizeLabel as string) ?? null,
    base_price_sen: body.basePriceSen == null ? null : Number(body.basePriceSen),
    price1_sen: body.price1Sen == null ? null : Number(body.price1Sen),
    cost_price_sen: body.costPriceSen == null ? 0 : Number(body.costPriceSen),
    unit_m3_milli: body.unitM3Milli == null ? 0 : Number(body.unitM3Milli),
    branding: (body.branding as string) ?? null,
    // 0166 — optional free-text barcode on create.
    barcode: typeof body.barcode === 'string' && body.barcode.trim() ? body.barcode.trim() : null,
    /* PR #104 — fabric_usage_centi / production_time_minutes /
       fabric_color removed (not used by 2990's retail catalogue). */
  };

  const { data, error } = await supabase.from('mfg_products').insert(row).select('id, code').single();
  if (error) {
    if (error.code === '23505') return c.json({ error: 'duplicate_code', reason: error.message }, 409);
    if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
    return c.json({ error: 'insert_failed', reason: error.message }, 500);
  }
  return c.json(data, 201);
});

// ── POST /batch-import ─────────────────────────────────────────────────
// Bulk upsert from a CSV import. Body: { rows: [{ code, name, category, ... }] }.
// Upserts by code (ON CONFLICT DO UPDATE). Returns count inserted/updated.
mfgProducts.post('/batch-import', async (c) => {
  const gate = await requireRole(c, CREATE_ROLES);
  if (!gate.ok) return gate.res;
  let body: { rows?: Array<Record<string, unknown>> };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const list = body.rows ?? [];
  if (list.length === 0) return c.json({ error: 'rows_required' }, 400);
  if (list.length > 500) return c.json({ error: 'too_many', message: 'Max 500 rows per import' }, 400);

  const supabase = c.get('supabase');
  let upserted = 0;
  const failures: Array<{ code: string; reason: string }> = [];

  // Data-loss-safe upsert (Wei Siang). Only fields PRESENT and non-empty in
  // the body row are written. On an ON CONFLICT update that means a column the
  // operator left blank in the CSV is NOT touched — so re-importing an edited
  // export can never zero a price or wipe a description. On a fresh INSERT,
  // the omitted columns fall back to their DB defaults.
  const hasVal = (v: unknown): boolean => v != null && v !== '';
  for (const r of list) {
    const code = String(r.code ?? '').trim();
    const name = String(r.name ?? '').trim();
    const category = String(r.category ?? '').trim();
    if (!code || !name || !VALID_CATEGORIES.has(category)) {
      failures.push({ code, reason: 'missing code/name or invalid category' });
      continue;
    }
    const row: Record<string, unknown> = { code, name, category };

    // String fields — include only when the cell actually has a value.
    if (hasVal(r.status))      row.status = String(r.status);
    if (hasVal(r.description)) row.description = String(r.description);
    if (hasVal(r.base_model))  row.base_model = String(r.base_model);
    if (hasVal(r.size_label))  row.size_label = String(r.size_label);
    if (hasVal(r.branding))    row.branding = String(r.branding);

    // Numeric (sen / milli) fields — include only when present. No ?? 0
    // default, so a blank cell leaves the stored number untouched on update.
    if (hasVal(r.base_price_sen)) row.base_price_sen = Number(r.base_price_sen);
    if (hasVal(r.price1_sen))     row.price1_sen = Number(r.price1_sen);
    if (hasVal(r.unit_m3_milli))  row.unit_m3_milli = Number(r.unit_m3_milli);

    // Sofa per (size × tier) prices — JSONB array. Accept either camelCase
    // (frontend import) or snake_case.
    type SeatEntry = { height: string; priceSen: number; tier?: string };
    const seatRaw = (r.seatHeightPrices ?? r.seat_height_prices) as unknown;
    const rawSeat = (Array.isArray(seatRaw) ? seatRaw : []) as SeatEntry[];
    // Recognise + canonicalise each price's tier (P2 / "Price 2" / 2 → PRICE_2).
    // Missing tier = legacy → PRICE_2; an UNrecognisable one rejects the whole
    // row so a mislabelled price can never land in the wrong tier.
    let badTier: string | null = null;
    const incomingSeat: SeatEntry[] = [];
    for (const e of rawSeat) {
      const t = (e.tier == null || e.tier === '') ? 'PRICE_2' : normalizeSofaTier(e.tier);
      if (!t) { badTier = String(e.tier); break; }
      incomingSeat.push({ ...e, tier: t });
    }
    if (badTier !== null) {
      failures.push({ code, reason: `price tier "${badTier}" not recognized — use P1, P2, or P3` });
      continue;
    }
    const tierOf = (e: SeatEntry) => e.tier ?? 'PRICE_2';

    // Never rewrite the PK id on re-import: UPDATE an existing SKU by code (id +
    // any omitted column left untouched), INSERT a brand-new SKU with a fresh id.
    const { data: existing } = await supabase.from('mfg_products')
      .select('id, seat_height_prices').eq('code', code).maybeSingle();
    let error;
    if (existing) {
      // Merge sofa prices BY TIER: the export ships one tier at a time, so an
      // import must only replace the tiers it carries and leave the other tiers
      // (P1/P2/P3) on the SKU untouched — never wipe them.
      if (incomingSeat.length > 0) {
        const incomingTiers = new Set(incomingSeat.map(tierOf));
        const existingSeat = (Array.isArray((existing as { seat_height_prices?: unknown }).seat_height_prices)
          ? (existing as { seat_height_prices: SeatEntry[] }).seat_height_prices
          : []);
        const kept = existingSeat.filter((e) => !incomingTiers.has(tierOf(e)));
        row.seat_height_prices = [...kept, ...incomingSeat];
      }
      ({ error } = await supabase.from('mfg_products').update(row).eq('code', code));
    } else {
      if (incomingSeat.length > 0) row.seat_height_prices = incomingSeat;
      const rand = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const id = `mfg-${rand.replace(/-/g, '').slice(0, 12)}`;
      ({ error } = await supabase.from('mfg_products').insert({ ...row, id }));
    }
    if (error) {
      failures.push({ code, reason: error.message });
    } else {
      upserted += 1;
    }
  }

  return c.json({ upserted, failed: failures.length, failures: failures.slice(0, 50) });
});

// ── DELETE /:id ────────────────────────────────────────────────────────
// PR #82 (Commander 2026-05-26) — SKU Master multi-select delete needs a
// per-row DELETE endpoint. Bulk delete = N parallel DELETE calls from the
// client (matches the pattern PR #62 used for fabric_trackings wipe).
//
// PR #94 (Commander 2026-05-26) — `?force=true` query flag. Test SKUs that
// have lingering inventory_stock_lots / inventory_movements / supplier_
// material_bindings rows from earlier QA reject the plain DELETE with a
// 23503 FK violation. Force mode wipes those side-tables first (by
// material_code / product_code) then drops the SKU row. Front-end exposes
// it as a follow-up "Force delete" button after a normal delete fails so
// commander never destroys side data unintentionally.
mfgProducts.delete('/:id', async (c) => {
  const gate = await requireRole(c, EDIT_ROLES);
  if (!gate.ok) return gate.res;
  const id    = c.req.param('id');
  const force = c.req.query('force') === 'true';
  const supabase = c.get('supabase');

  // Resolve the SKU code up front — needed for both the usage guard and the
  // force-cleanup side tables (which key off code, not id).
  const { data: row, error: loadErr } = await supabase
    .from('mfg_products')
    .select('code')
    .eq('id', id)
    .maybeSingle();
  if (loadErr) return c.json({ error: 'load_failed', reason: loadErr.message }, 500);
  if (!row)    return c.json({ error: 'not_found' }, 404);
  const code = row.code;

  // (C) Wei Siang 2026-06-08 — lock USED SKUs. If this SKU has been sold on an
  // SO, ordered on a PO, or moved in stock, block the delete — NOT EVEN by
  // force. Deleting it would orphan live order lines / wipe stock history.
  // Unused SKUs (setup-phase typos) stay deletable.
  const used = await findSkuUsage(supabase, code);
  if (used) {
    return c.json({
      error: 'sku_in_use',
      reason: `“${code}” is used in ${used.where}${used.doc ? ` (${used.doc})` : ''} and can’t be deleted.`,
    }, 409);
  }

  if (force) {
    const cleanup: Array<{ table: string; column: string; value: string }> = [
      // Inventory side — stock lots + movements key off product_code.
      { table: 'inventory_stock_lots',         column: 'product_code',  value: code },
      { table: 'inventory_movements',          column: 'product_code',  value: code },
      // Procurement side — supplier ↔ material bindings key off material_code.
      { table: 'supplier_material_bindings',   column: 'material_code', value: code },
    ];
    for (const c2 of cleanup) {
      const { error: delErr } = await supabase.from(c2.table).delete().eq(c2.column, c2.value);
      // Best-effort: missing table / no-rows-affected is fine. RLS denial we
      // surface so commander knows force isn't actually clearing.
      if (delErr && delErr.code === '42501') {
        return c.json({ error: 'forbidden', reason: `${c2.table}: ${delErr.message}` }, 403);
      }
      // Other errors (e.g. relation does not exist on a fresh deployment)
      // get swallowed — the SKU delete below will surface anything still
      // blocking.
    }
  }

  const { error } = await supabase.from('mfg_products').delete().eq('id', id);
  if (error) {
    if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
    if (error.code === '23503') {
      // PR #94 — Echo the actual constraint name back so the UI can suggest
      // force-delete with a meaningful hint.
      return c.json({
        error:      'product_in_use',
        reason:     'Product is referenced by an order / PO / GRN line; remove those first or use force delete.',
        constraint: (error as { details?: string }).details ?? null,
        message:    error.message,
      }, 409);
    }
    return c.json({ error: 'delete_failed', reason: error.message }, 500);
  }
  return c.body(null, 204);
});

// ── GET /:id ───────────────────────────────────────────────────────────
mfgProducts.get('/:id', async (c) => {
  const id = c.req.param('id');
  const supabase = c.get('supabase');

  const { data, error } = await supabase
    .from('mfg_products')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if (!data) return c.json({ error: 'not_found' }, 404);

  // Side-load the per-dept config row (one-to-one on product_code) so the
  // UI can show working times without a second roundtrip.
  const { data: cfg } = await supabase
    .from('product_dept_configs')
    .select('*')
    .eq('product_code', data.code)
    .maybeSingle();

  return c.json({ product: data, deptConfig: cfg ?? null });
});

// ── PATCH /:id ─────────────────────────────────────────────────────────
// Updates base/price1/cost prices. Each numeric change emits a row to
// `master_price_history` for the audit drawer.
mfgProducts.patch('/:id', async (c) => {
  const gate = await requireRole(c, EDIT_ROLES);
  if (!gate.ok) return gate.res;
  const id = c.req.param('id');
  let body: {
    basePriceSen?: number | null;
    price1Sen?: number | null;
    costPriceSen?: number | null;
    sellPriceSen?: number | null;
    /** PWP (换购) SELLING base price (migration 0128). Selling-side, like sellPriceSen. */
    pwpPriceSen?: number | null;
    notes?: string;
    defaultVariants?: unknown;
    subAssemblies?: unknown;
    pieces?: unknown;
    seatHeightPrices?: Array<{ height: string; priceSen: number; tier?: 'PRICE_1' | 'PRICE_2' | 'PRICE_3'; sellingPriceSen?: number }>;
    branding?: string | null;
    /** PR #87 — per-SKU active toggle. Commander uses this from the Model
        detail "SKU variants" table to mark individual SKUs as no longer sold
        without having to delete the row (preserves stock + history). */
    status?: 'ACTIVE' | 'INACTIVE';
    /** D5 (cost/sell split Phase 2) — selling-only POS catalog visibility.
        Master Account (POS) writes this; SEPARATE from `status` (cost/PO).
        The Backend cost editor never sends it. */
    posActive?: boolean;
    /** D7 (Phase 3) — permanent free gifts ({addonId, qty}[]). Master Account
        sets; Configurator renders "× N INCLUDED". Display-only, no inventory. */
    includedAddons?: Array<{ addonId: string; qty: number }>;
    /** 0170 — Default Free Gift (accessory). [{giftProductId, qty, campaignName?}]. */
    defaultFreeGifts?: Array<{ giftProductId: string; qty: number; campaignName?: string | null }>;
    /* PR #89 (Commander 2026-05-26) — inline edit of SKU code + name from
       SKU Master. Unique-constraint on code → 23505 surfaces as 409. */
    code?: string;
    name?: string;
    /** 0166 — free-text SKU barcode. Empty string clears to NULL. */
    barcode?: string | null;
  };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const supabase = c.get('supabase');
  const user = c.get('user');

  const { data: current, error: loadErr } = await supabase
    .from('mfg_products')
    .select('code, base_price_sen, price1_sen, cost_price_sen, sell_price_sen, pwp_price_sen, default_variants, seat_height_prices')
    .eq('id', id)
    .maybeSingle();
  if (loadErr) return c.json({ error: 'load_failed', reason: loadErr.message }, 500);
  if (!current) return c.json({ error: 'not_found' }, 404);

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  const priceChanges: Array<{ field: string; oldValueSen: number | null; newValueSen: number | null }> = [];

  if (body.basePriceSen !== undefined && body.basePriceSen !== current.base_price_sen) {
    updates.base_price_sen = body.basePriceSen;
    priceChanges.push({ field: 'base_price_sen', oldValueSen: current.base_price_sen, newValueSen: body.basePriceSen });
  }
  if (body.price1Sen !== undefined && body.price1Sen !== current.price1_sen) {
    updates.price1_sen = body.price1Sen;
    priceChanges.push({ field: 'price1_sen', oldValueSen: current.price1_sen, newValueSen: body.price1Sen });
  }
  if (body.sellPriceSen !== undefined && body.sellPriceSen !== current.sell_price_sen) {
    updates.sell_price_sen = body.sellPriceSen;
    priceChanges.push({ field: 'sell_price_sen', oldValueSen: current.sell_price_sen, newValueSen: body.sellPriceSen });
  }
  // PWP (换购) selling base price (migration 0128) — selling-side, audited like the others.
  if (body.pwpPriceSen !== undefined && body.pwpPriceSen !== current.pwp_price_sen) {
    updates.pwp_price_sen = body.pwpPriceSen;
    priceChanges.push({ field: 'pwp_price_sen', oldValueSen: current.pwp_price_sen, newValueSen: body.pwpPriceSen });
  }
  if (body.costPriceSen !== undefined && body.costPriceSen !== current.cost_price_sen) {
    updates.cost_price_sen = body.costPriceSen;
    priceChanges.push({ field: 'cost_price_sen', oldValueSen: current.cost_price_sen, newValueSen: body.costPriceSen });
  }
  if (body.defaultVariants !== undefined) {
    updates.default_variants = body.defaultVariants;
  }
  if (body.subAssemblies !== undefined) {
    updates.sub_assemblies = body.subAssemblies;
  }
  if (body.pieces !== undefined) {
    updates.pieces = body.pieces;
  }
  if (body.branding !== undefined) {
    const trimmed = typeof body.branding === 'string' ? body.branding.trim() : null;
    updates.branding = trimmed ? trimmed : null;
  }
  // 0166 — barcode edit from the SKU drawers. Trimmed; empty clears to NULL.
  if (body.barcode !== undefined) {
    const trimmed = typeof body.barcode === 'string' ? body.barcode.trim() : null;
    updates.barcode = trimmed ? trimmed : null;
  }
  // PR #87 — per-SKU active toggle. Stored as 'ACTIVE' | 'INACTIVE' to match
  // the rest of the schema (matches mfg_products.status default in inserts).
  if (body.status === 'ACTIVE' || body.status === 'INACTIVE') {
    updates.status = body.status;
  }
  // D5 — selling-only POS catalog visibility. Independent of status (cost/PO).
  if (typeof body.posActive === 'boolean') {
    updates.pos_active = body.posActive;
  }
  // D7 — permanent free gifts (display-only). Master Account sets the array.
  if (Array.isArray(body.includedAddons)) {
    updates.included_addons = body.includedAddons;
  }
  // 0170 — Default Free Gift (accessory). Coerce via the shared parser so a
  // malformed entry can never poison the column.
  if (Array.isArray(body.defaultFreeGifts)) {
    updates.default_free_gifts = parseDefaultFreeGifts(body.defaultFreeGifts);
  }
  /* PR #89 — code + name inline edit from SKU Master. code is unique;
     duplicate triggers 23505 below. Both trimmed; empty rejected to keep
     the NOT NULL invariants on the schema. */
  if (body.code !== undefined) {
    const trimmed = typeof body.code === 'string' ? body.code.trim() : '';
    if (!trimmed) return c.json({ error: 'code_required' }, 400);
    updates.code = trimmed;
  }
  if (body.name !== undefined) {
    const trimmed = typeof body.name === 'string' ? body.name.trim() : '';
    if (!trimmed) return c.json({ error: 'name_required' }, 400);
    updates.name = trimmed;
  }
  // Sofa tier matrix — diff per (height × tier) slot so the audit trail
  // captures each change instead of a single opaque blob write.
  if (Array.isArray(body.seatHeightPrices)) {
    // Light validation: a present sellingPriceSen must be a finite, non-negative
    // integer (sen). priceSen (cost) keeps its existing tolerant handling.
    for (const s of body.seatHeightPrices) {
      if (s.sellingPriceSen != null &&
          (!Number.isInteger(s.sellingPriceSen) || s.sellingPriceSen < 0)) {
        return c.json({ error: 'invalid_selling_price' }, 400);
      }
    }
    type Slot = { height: string; priceSen: number; tier?: 'PRICE_1' | 'PRICE_2' | 'PRICE_3'; sellingPriceSen?: number };
    const oldArr = (Array.isArray(current.seat_height_prices)
      ? (current.seat_height_prices as Slot[])
      : []);
    const newArr = body.seatHeightPrices as Slot[];
    const keyOf = (s: Slot) => `${s.height}|${s.tier ?? 'PRICE_2'}`;

    /* Audit 2026-06-20 — seat_height_prices JSONB carries TWO independent
       dimensions per slot: priceSen (COST, Backend "Edit Prices" grid) and
       sellingPriceSen (SELLING, POS Sales-Director). A cost-only client omits
       sellingPriceSen, so the old verbatim store wiped the POS selling price on
       every edited slot — the combo COST-edit-wipes-SELLING bug twinned onto the
       SKU JSONB. MERGE each incoming slot over the matching current slot so an
       omitted dimension carries forward (an explicit incoming value still wins). */
    const oldByKey = new Map(oldArr.map((s) => [keyOf(s), s] as const));
    const mergedArr: Slot[] = newArr.map((s) => ({ ...oldByKey.get(keyOf(s)), ...s }));
    updates.seat_height_prices = mergedArr;

    const oldMap = new Map(oldArr.map((s) => [keyOf(s), s.priceSen] as const));
    const newMap = new Map(mergedArr.map((s) => [keyOf(s), s.priceSen] as const));
    const keys = new Set([...oldMap.keys(), ...newMap.keys()]);
    for (const k of keys) {
      const oldVal = oldMap.get(k) ?? null;
      const newVal = newMap.get(k) ?? null;
      if (oldVal !== newVal) {
        priceChanges.push({ field: `seat_height:${k}`, oldValueSen: oldVal, newValueSen: newVal });
      }
    }
    // SELLING side (POS Edit-Price grid writes sellingPriceSen; Chairman
    // 2026-06-01). Diffed against the MERGED array so the audit reflects what is
    // actually stored (an omitted slot now carries its prior selling forward).
    const oldSellMap = new Map(oldArr.map((s) => [keyOf(s), s.sellingPriceSen ?? null] as const));
    const newSellMap = new Map(mergedArr.map((s) => [keyOf(s), s.sellingPriceSen ?? null] as const));
    for (const k of new Set([...oldSellMap.keys(), ...newSellMap.keys()])) {
      const oldVal = oldSellMap.get(k) ?? null;
      const newVal = newSellMap.get(k) ?? null;
      if (oldVal !== newVal) {
        priceChanges.push({ field: `seat_height_selling:${k}`, oldValueSen: oldVal, newValueSen: newVal });
      }
    }
  }

  if (Object.keys(updates).length === 1) {
    // only updated_at — nothing meaningful to write
    return c.json({ ok: true, changed: 0 });
  }

  const { error: updErr } = await supabase.from('mfg_products').update(updates).eq('id', id);
  if (updErr) {
    if (updErr.code === '42501' || /permission denied/i.test(updErr.message)) {
      return c.json({ error: 'forbidden', reason: updErr.message }, 403);
    }
    if (updErr.code === '23505') {
      // PR #89 — only the `code` column has a UNIQUE constraint that the
      // inline editor can collide with, so safe to label it that way.
      return c.json({ error: 'duplicate_code', reason: 'Another SKU already uses that code.' }, 409);
    }
    return c.json({ error: 'update_failed', reason: updErr.message }, 500);
  }

  /* Cost anchor (0177) — mirror the new COST onto this SKU's anchor binding
     (if any). Only fires when base_price_sen / price1_sen actually changed
     (the two cost fields the mapping reads). Uses the FINAL values: the
     written value if it changed, else the unchanged current value. Best-effort
     — runs after the product write committed. */
  const costFieldChanged = priceChanges.some(
    (ch) => ch.field === 'base_price_sen' || ch.field === 'price1_sen',
  );
  if (costFieldChanged) {
    // Use the FINAL values. `'key' in updates` (not ??) so an explicit clear to
    // null is honoured rather than falling back to the old value.
    await syncAnchorBindingFromProduct(supabase, current.code, {
      base_price_sen: 'base_price_sen' in updates
        ? (updates.base_price_sen as number | null)
        : current.base_price_sen,
      price1_sen: 'price1_sen' in updates
        ? (updates.price1_sen as number | null)
        : current.price1_sen,
    });
  }

  // Audit trail. Best-effort — if these fail the price update has already
  // committed, so we log and move on (matches the audit-dlq pattern used
  // elsewhere in 2990s).
  for (const ch of priceChanges) {
    // PRICE_FIELDS covers the flat columns; `seat_height*` carries the per-(height,
    // tier) cost + selling diffs (the old guard silently dropped ALL seat_height
    // rows — fixed here in one line; master_price_history.field is free-text).
    if (!PRICE_FIELDS.has(ch.field) && !ch.field.startsWith('seat_height')) continue;
    await supabase.from('master_price_history').insert({
      product_code: current.code,
      field: ch.field,
      old_value_sen: ch.oldValueSen,
      new_value_sen: ch.newValueSen,
      reason: body.notes ?? null,
      changed_by: user.id,
    });
  }

  return c.json({ ok: true, changed: priceChanges.length });
});

// ── POST /:id/activate-one-shot ───────────────────────────────────────────────
// Re-activate a one-shot SKU (minted from a remark + extra charge) so it is
// selectable again in POS. Flips pos_active=true; for SOFA it also adds the
// custom compartment code to the Model's allowed_options.compartments so the
// configurator palette shows it (art/price auto-flow via the shared helpers).
mfgProducts.post('/:id/activate-one-shot', async (c) => {
  const gate = await requireRole(c, EDIT_ROLES);
  if (!gate.ok) return gate.res;
  const id = c.req.param('id');
  const admin = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: sku, error: skuErr } = await admin
    .from('mfg_products')
    .select('id, code, category, base_model, model_id, one_shot')
    .eq('id', id).maybeSingle();
  if (skuErr) return c.json({ error: 'lookup_failed', reason: skuErr.message }, 500);
  if (!sku || !(sku as { one_shot?: boolean }).one_shot) return c.json({ error: 'not_one_shot' }, 400);

  const { error: upErr } = await admin.from('mfg_products').update({ pos_active: true }).eq('id', id);
  if (upErr) return c.json({ error: 'activate_failed', reason: upErr.message }, 500);

  const s = sku as { category: string; code: string; base_model: string | null; model_id: string | null };
  if (s.category === 'SOFA' && s.model_id) {
    const moduleCode = moduleCodeFromSku(s.code, s.base_model);
    const { data: model } = await admin.from('product_models')
      .select('allowed_options').eq('id', s.model_id).maybeSingle();
    const opts = ((model as { allowed_options?: Record<string, unknown> } | null)?.allowed_options) ?? {};
    const comps = Array.isArray((opts as { compartments?: unknown }).compartments)
      ? ((opts as { compartments: unknown[] }).compartments).map(String) : [];
    if (!comps.includes(moduleCode)) {
      const next = { ...opts, compartments: [...comps, moduleCode] };
      const { error: moErr } = await admin.from('product_models')
        .update({ allowed_options: next }).eq('id', s.model_id);
      if (moErr) return c.json({ error: 'allowed_options_update_failed', reason: moErr.message }, 500);
    }
  }
  return c.json({ ok: true });
});

// ── GET /:id/price-history ────────────────────────────────────────────
mfgProducts.get('/:id/price-history', async (c) => {
  const id = c.req.param('id');
  const supabase = c.get('supabase');

  const { data: product, error: pErr } = await supabase
    .from('mfg_products')
    .select('code')
    .eq('id', id)
    .maybeSingle();
  if (pErr) return c.json({ error: 'load_failed', reason: pErr.message }, 500);
  if (!product) return c.json({ error: 'not_found' }, 404);

  const { data, error } = await supabase
    .from('master_price_history')
    .select('id, product_code, field, old_value_sen, new_value_sen, reason, changed_at, changed_by')
    .eq('product_code', product.code)
    .order('changed_at', { ascending: false });

  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ history: data ?? [] });
});

// ── GET /:id/suppliers ────────────────────────────────────────────────
// PR #38 — Returns every supplier that carries this product (via
// supplier_material_bindings), with their supplier-side SKU + price +
// lead time + is_main flag. Used by the Products page double-click drawer.
mfgProducts.get('/:id/suppliers', async (c) => {
  const id = c.req.param('id');
  const supabase = c.get('supabase');

  const { data: product, error: pErr } = await supabase
    .from('mfg_products')
    .select('code, name, category')
    .eq('id', id)
    .maybeSingle();
  if (pErr) return c.json({ error: 'load_failed', reason: pErr.message }, 500);
  if (!product) return c.json({ error: 'not_found' }, 404);

  const { data, error } = await supabase
    .from('supplier_material_bindings')
    .select(`
      id, supplier_id, supplier_sku, unit_price_centi, currency,
      lead_time_days, moq, is_main_supplier, notes,
      suppliers(code, name, phone)
    `)
    .eq('material_code', (product as { code: string }).code)
    .order('is_main_supplier', { ascending: false })
    .order('unit_price_centi', { ascending: true });

  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ product, suppliers: data ?? [] });
});
