// ----------------------------------------------------------------------------
// /suppliers — full master + supplier_material_bindings management.
//
// Ports HOOKKA's suppliers + supplier_material_bindings tables. The bindings
// table maps OUR internal material codes (mfg_products.code or fabrics.code)
// to the SUPPLIER's own SKU + price + currency + lead time + MOQ.
//
// Endpoints:
//   GET   /suppliers
//   GET   /suppliers/:id                       — supplier + all bindings
//   POST  /suppliers                           — create
//   PATCH /suppliers/:id                       — update
//
//   GET   /suppliers/:id/bindings              — list bindings for a supplier
//   POST  /suppliers/:id/bindings              — add binding
//   PATCH /suppliers/:id/bindings/:bindingId   — update binding
//   DELETE /suppliers/:id/bindings/:bindingId  — remove binding
//
//   GET   /suppliers/material/:kind/:code      — find suppliers for a material
//                                                 (?mainOnly=true for primary)
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizePhone } from '../shared/phone';
import { effectiveDelivery } from '../shared/effective-delivery';
import { supabaseAuth } from '../middleware/auth';
import { escapeForOr } from '../lib/postgrest-search';
import { bindingToProductPatch } from '../lib/cost-anchor-sync';
import type { Env, Variables } from '../env';

/* Task #91 — small helper: normalize a body field to E.164 phone storage,
   passing through nullish + non-string values untouched. */
const normPhone = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  return normalizePhone(v) ?? v;
};

export const suppliers = new Hono<{ Bindings: Env; Variables: Variables }>();

suppliers.use('*', supabaseAuth);

const SUPPLIER_STATUSES = new Set(['ACTIVE', 'INACTIVE', 'BLOCKED']);
const CURRENCIES = new Set(['MYR', 'RMB', 'USD', 'SGD']);
const MATERIAL_KINDS = new Set(['mfg_product', 'fabric', 'raw']);

/* PR #40 — full master record (Commander 2026-05-26 AutoCount parity) */
/* Mig 0028 — registration_no / nature_of_business / exemption_no / phone2
   (AutoCount creditor-export parity). */
const SUPPLIER_COLS =
  'id, code, name, whatsapp_number, email, contact_person, phone, address, state, ' +
  'payment_terms, status, rating, notes, supplier_type, category, tin_number, ' +
  'business_reg_no, postcode, area, mobile, fax, website, attention, business_nature, ' +
  'currency, statement_type, aging_basis, credit_limit_sen, country, ' +
  'registration_no, nature_of_business, exemption_no, phone2, created_at, updated_at';

/* PR — Commander 2026-05-27 ("当 Assign SKU 之后，你就会知道它是什么 Category 了呀"):
   List endpoint queries the `suppliers_with_derived_category` view (migration
   0088) which adds a `derived_category` column auto-computed from the
   distinct mfg_products.category of each supplier's assigned SKUs. Used by
   the Suppliers list page's visible Category column. Detail/create/patch
   keep reading from the base `suppliers` table because they don't need
   the derived field (and to avoid touching the rest of the file). */
const SUPPLIER_LIST_COLS = `${SUPPLIER_COLS}, derived_category`;

const STATEMENT_TYPES = new Set(['OPEN_ITEM', 'BALANCE_FORWARD', 'NO_STATEMENT']);
const AGING_BASES = new Set(['INVOICE_DATE', 'DUE_DATE']);

const BINDING_COLS =
  'id, supplier_id, material_kind, material_code, material_name, supplier_sku, ' +
  'unit_price_centi, currency, lead_time_days, payment_terms_override, moq, ' +
  'price_valid_from, price_valid_to, is_main_supplier, notes, price_matrix, ' +
  'is_cost_anchor, created_at, updated_at';

/* PR — Commander 2026-05-27 ("跟着 Product Maintenance 的排版"): per-category
   supplier cost matrix. Validates the JSONB shape against the SKU's
   mfg_products.category. Returns the cleaned matrix (numeric cells), or
   undefined to drop the field, or throws a string error code for the route
   to translate to a 400.

   Shapes (centi int, ≥0):
     SOFA      → { "<height>": { "P1"?: n, "P2"?: n, "P3"?: n }, ... }
     BEDFRAME  → { "P1"?: n, "P2"?: n }
     MATTRESS / ACCESSORY / SERVICE → must be null/undefined (single price
                                       flows via unit_price_centi).
   Unknown / null / empty → undefined (caller should write NULL). */
const TIER_KEYS = new Set(['P1', 'P2', 'P3']);
function validatePriceMatrix(
  raw: unknown,
  category: string | null,
): Record<string, unknown> | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('invalid_price_matrix:not_object');
  }
  const cat = (category ?? '').toUpperCase();

  // Categories with no matrix — accept empty object as "clear" (→ null),
  // reject any populated shape so callers don't accidentally hide prices in
  // an unread column.
  if (cat === 'MATTRESS' || cat === 'ACCESSORY' || cat === 'SERVICE') {
    if (Object.keys(raw as Record<string, unknown>).length === 0) return null;
    throw new Error(`invalid_price_matrix:not_supported_for_${cat || 'UNKNOWN'}`);
  }

  if (cat === 'BEDFRAME') {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!TIER_KEYS.has(k)) throw new Error(`invalid_price_matrix:bedframe_key:${k}`);
      if (v === null || v === undefined || v === '') continue;
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isFinite(n) || n < 0) {
        throw new Error(`invalid_price_matrix:bedframe_value:${k}`);
      }
      out[k] = Math.round(n);
    }
    return Object.keys(out).length === 0 ? null : out;
  }

  if (cat === 'SOFA') {
    const out: Record<string, Record<string, number>> = {};
    for (const [height, inner] of Object.entries(raw as Record<string, unknown>)) {
      // Heights are free-form numeric strings (24/26/28/30/32/35 by default
      // but commander can edit the maintenance config). Allow anything that
      // parses to a number.
      if (!Number.isFinite(Number(height))) {
        throw new Error(`invalid_price_matrix:sofa_height:${height}`);
      }
      if (inner === null || inner === undefined) continue;
      if (typeof inner !== 'object' || Array.isArray(inner)) {
        throw new Error(`invalid_price_matrix:sofa_inner_not_object:${height}`);
      }
      const tiers: Record<string, number> = {};
      for (const [tier, val] of Object.entries(inner as Record<string, unknown>)) {
        if (!TIER_KEYS.has(tier)) {
          throw new Error(`invalid_price_matrix:sofa_tier:${height}.${tier}`);
        }
        if (val === null || val === undefined || val === '') continue;
        const n = typeof val === 'number' ? val : Number(val);
        if (!Number.isFinite(n) || n < 0) {
          throw new Error(`invalid_price_matrix:sofa_value:${height}.${tier}`);
        }
        tiers[tier] = Math.round(n);
      }
      if (Object.keys(tiers).length > 0) out[height] = tiers;
    }
    return Object.keys(out).length === 0 ? null : out;
  }

  // Unknown category (e.g. fabric / raw bindings) — accept empty only.
  if (Object.keys(raw as Record<string, unknown>).length === 0) return null;
  throw new Error(`invalid_price_matrix:unsupported_category:${cat || 'UNKNOWN'}`);
}

/* Look up the mfg_products.category for a material_code so the matrix can
   be shape-validated. Returns null for non-mfg_product kinds (fabric/raw)
   or codes that aren't in the catalogue — those bindings should not carry
   a price_matrix. */
async function categoryForMaterial(
  supabase: SupabaseClient,
  kind: string,
  code: string,
): Promise<string | null> {
  if (kind !== 'mfg_product') return null;
  const { data } = await supabase
    .from('mfg_products')
    .select('category')
    .eq('code', code)
    .maybeSingle();
  return (data?.category as string | undefined) ?? null;
}

/* ── Cost anchor (migration 0177) ─────────────────────────────────────────
   R8 at the SKU level. When a binding flagged is_cost_anchor has its cost
   written, mirror that cost onto the matching mfg_products row so
   Product-Maintenance cost == this supplier's cost. BEST-EFFORT: any failure
   here is swallowed (the primary binding write already committed). SOFA is
   skipped by the pure helper (ambiguous per-height grid). The mirror write
   targets mfg_products directly — it does NOT re-enter the binding PATCH route,
   so there is no sync loop. */
async function syncAnchoredProductFromBinding(
  supabase: SupabaseClient,
  binding: {
    is_cost_anchor?: boolean | null;
    material_kind?: string | null;
    material_code?: string | null;
    unit_price_centi?: number | null;
    price_matrix?: unknown;
  },
): Promise<void> {
  try {
    if (!binding.is_cost_anchor) return;
    if (binding.material_kind !== 'mfg_product') return;
    const code = binding.material_code;
    if (!code) return;

    const { data: product } = await supabase
      .from('mfg_products')
      .select('id, category')
      .eq('code', code)
      .maybeSingle();
    if (!product) return;

    const result = bindingToProductPatch({
      category: (product as { category: string | null }).category,
      unit_price_centi: binding.unit_price_centi ?? null,
      price_matrix: binding.price_matrix ?? null,
    });
    if (result.skipped) return;
    if (Object.keys(result.patch).length === 0) return;

    await supabase
      .from('mfg_products')
      .update({ ...result.patch, updated_at: new Date().toISOString() })
      .eq('id', (product as { id: string }).id);
  } catch {
    // Best-effort mirror — never surface to the primary write.
  }
}

// ── List suppliers ────────────────────────────────────────────────────
suppliers.get('/', async (c) => {
  const status = c.req.query('status');
  const search = c.req.query('search');
  const supabase = c.get('supabase');

  /* Query the derived-category view so the list page can show an
     auto-derived Category column (see migration 0088). */
  let q = supabase
    .from('suppliers_with_derived_category')
    .select(SUPPLIER_LIST_COLS)
    .order('name', { ascending: true })
    // Bound the result so PostgREST's default 1000-row cap can't silently
    // truncate the supplier master — match the SO/DO/SI list convention.
    .limit(2000);
  if (status && SUPPLIER_STATUSES.has(status)) q = q.eq('status', status);
  if (search) { const s = escapeForOr(search); if (s) q = q.or(`code.ilike.%${s}%,name.ilike.%${s}%,contact_person.ilike.%${s}%`); }

  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ suppliers: data ?? [] });
});

// ── Supplier detail (+ bindings) ──────────────────────────────────────
suppliers.get('/:id', async (c) => {
  const id = c.req.param('id');
  const supabase = c.get('supabase');

  const [supplierRes, bindingsRes] = await Promise.all([
    supabase.from('suppliers').select(SUPPLIER_COLS).eq('id', id).maybeSingle(),
    supabase.from('supplier_material_bindings').select(BINDING_COLS).eq('supplier_id', id).order('material_code'),
  ]);

  if (supplierRes.error) return c.json({ error: 'load_failed', reason: supplierRes.error.message }, 500);
  if (!supplierRes.data) return c.json({ error: 'not_found' }, 404);
  if (bindingsRes.error) return c.json({ error: 'load_failed', reason: bindingsRes.error.message }, 500);

  return c.json({ supplier: supplierRes.data, bindings: bindingsRes.data ?? [] });
});

// ── Create supplier ──────────────────────────────────────────────────
suppliers.post('/', async (c) => {
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const code = (body.code as string | undefined)?.trim();
  const name = (body.name as string | undefined)?.trim();
  if (!code) return c.json({ error: 'code_required' }, 400);
  if (!name) return c.json({ error: 'name_required' }, 400);

  const row = {
    code,
    name,
    /* Task #91 — normalize phone-like fields to E.164 on the server too. */
    whatsapp_number: normPhone(body.whatsappNumber),
    email: (body.email as string) ?? null,
    contact_person: (body.contactPerson as string) ?? null,
    phone: normPhone(body.phone),
    address: (body.address as string) ?? null,
    state: (body.state as string) ?? null,
    payment_terms: (body.paymentTerms as string) ?? null,
    status: SUPPLIER_STATUSES.has(body.status as string) ? body.status : 'ACTIVE',
    rating: typeof body.rating === 'number' ? body.rating : 0,
    notes: (body.notes as string) ?? null,
    /* PR #40 — full master record */
    supplier_type: (body.supplierType as string) ?? null,
    category: (body.category as string) ?? null,
    /* PR #47 — country (defaults Malaysia at DB level) */
    country: (body.country as string) ?? 'Malaysia',
    tin_number: (body.tinNumber as string) ?? null,
    business_reg_no: (body.businessRegNo as string) ?? null,
    postcode: (body.postcode as string) ?? null,
    area: (body.area as string) ?? null,
    mobile: normPhone(body.mobile),
    fax: (body.fax as string) ?? null,
    website: (body.website as string) ?? null,
    attention: (body.attention as string) ?? null,
    business_nature: (body.businessNature as string) ?? null,
    currency: CURRENCIES.has(body.currency as string) ? body.currency : 'MYR',
    statement_type: STATEMENT_TYPES.has(body.statementType as string) ? body.statementType : 'OPEN_ITEM',
    aging_basis: AGING_BASES.has(body.agingBasis as string) ? body.agingBasis : 'INVOICE_DATE',
    credit_limit_sen: typeof body.creditLimitSen === 'number' ? body.creditLimitSen : 0,
    /* Mig 0028 — AutoCount creditor-export parity. phone2 normalizes to E.164
       like the other phone fields. */
    registration_no: (body.registrationNo as string) ?? null,
    nature_of_business: (body.natureOfBusiness as string) ?? null,
    exemption_no: (body.exemptionNo as string) ?? null,
    phone2: normPhone(body.phone2),
  };

  const supabase = c.get('supabase');
  const { data, error } = await supabase.from('suppliers').insert(row).select(SUPPLIER_COLS).single();
  if (error) {
    if (error.code === '23505') return c.json({ error: 'duplicate_code' }, 409);
    if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
    return c.json({ error: 'insert_failed', reason: error.message }, 500);
  }
  return c.json({ supplier: data }, 201);
});

// ── Update supplier ─────────────────────────────────────────────────
suppliers.patch('/:id', async (c) => {
  const id = c.req.param('id');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  const map: Array<[keyof typeof body, string]> = [
    ['code', 'code'], ['name', 'name'], ['whatsappNumber', 'whatsapp_number'],
    ['email', 'email'], ['contactPerson', 'contact_person'], ['phone', 'phone'],
    ['address', 'address'], ['state', 'state'], ['paymentTerms', 'payment_terms'],
    ['rating', 'rating'], ['notes', 'notes'],
    /* PR #40 — full master record */
    ['supplierType', 'supplier_type'], ['category', 'category'], ['country', 'country'],
    ['tinNumber', 'tin_number'], ['businessRegNo', 'business_reg_no'],
    ['postcode', 'postcode'], ['area', 'area'], ['mobile', 'mobile'],
    ['fax', 'fax'], ['website', 'website'], ['attention', 'attention'],
    ['businessNature', 'business_nature'], ['creditLimitSen', 'credit_limit_sen'],
    /* Mig 0028 — AutoCount creditor-export parity. */
    ['registrationNo', 'registration_no'], ['natureOfBusiness', 'nature_of_business'],
    ['exemptionNo', 'exemption_no'], ['phone2', 'phone2'],
  ];
  /* Task #91 — normalize phone-like columns to E.164 on PATCH too.
     Mig 0028 — phone2 joins the same normalization set. */
  const PHONE_FIELDS = new Set(['phone', 'mobile', 'whatsappNumber', 'phone2']);
  for (const [from, to] of map) {
    if (body[from] === undefined) continue;
    if (PHONE_FIELDS.has(from as string) && typeof body[from] === 'string') {
      const raw = body[from] as string;
      updates[to] = normalizePhone(raw) ?? raw;
    } else {
      updates[to] = body[from];
    }
  }
  if (body.status !== undefined && SUPPLIER_STATUSES.has(body.status as string)) {
    updates.status = body.status;
  }
  if (body.currency !== undefined && CURRENCIES.has(body.currency as string)) {
    updates.currency = body.currency;
  }
  if (body.statementType !== undefined && STATEMENT_TYPES.has(body.statementType as string)) {
    updates.statement_type = body.statementType;
  }
  if (body.agingBasis !== undefined && AGING_BASES.has(body.agingBasis as string)) {
    updates.aging_basis = body.agingBasis;
  }

  const supabase = c.get('supabase');
  const { data, error } = await supabase.from('suppliers').update(updates).eq('id', id).select(SUPPLIER_COLS).single();
  if (error) {
    if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
    return c.json({ error: 'update_failed', reason: error.message }, 500);
  }
  return c.json({ supplier: data });
});

// ── Bindings: list / create / update / delete ─────────────────────────
suppliers.get('/:id/bindings', async (c) => {
  const id = c.req.param('id');
  const supabase = c.get('supabase');
  const { data, error } = await supabase
    .from('supplier_material_bindings')
    .select(BINDING_COLS)
    .eq('supplier_id', id)
    .order('material_code');
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ bindings: data ?? [] });
});

suppliers.post('/:id/bindings', async (c) => {
  const supplierId = c.req.param('id');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const kind = body.materialKind as string;
  if (!MATERIAL_KINDS.has(kind)) return c.json({ error: 'invalid_material_kind' }, 400);
  if (!body.materialCode) return c.json({ error: 'material_code_required' }, 400);
  if (!body.materialName) return c.json({ error: 'material_name_required' }, 400);
  if (!body.supplierSku) return c.json({ error: 'supplier_sku_required' }, 400);
  const currency = (body.currency as string) ?? 'MYR';
  if (!CURRENCIES.has(currency)) return c.json({ error: 'invalid_currency' }, 400);

  const supabase = c.get('supabase');

  // PR — Commander 2026-05-27: validate per-category price_matrix shape
  // against the SKU's mfg_products.category.
  let priceMatrix: Record<string, unknown> | null | undefined;
  if (body.priceMatrix !== undefined) {
    const cat = await categoryForMaterial(supabase, kind, String(body.materialCode));
    try {
      priceMatrix = validatePriceMatrix(body.priceMatrix, cat);
    } catch (e) {
      const reason = e instanceof Error ? e.message : 'invalid_price_matrix';
      return c.json({ error: 'invalid_price_matrix', reason }, 400);
    }
  }

  const row: Record<string, unknown> = {
    supplier_id: supplierId,
    material_kind: kind,
    material_code: body.materialCode,
    material_name: body.materialName,
    supplier_sku: body.supplierSku,
    unit_price_centi: typeof body.unitPriceCenti === 'number' ? body.unitPriceCenti : 0,
    currency,
    lead_time_days: typeof body.leadTimeDays === 'number' ? body.leadTimeDays : 0,
    payment_terms_override: (body.paymentTermsOverride as string) ?? null,
    moq: typeof body.moq === 'number' ? body.moq : 0,
    price_valid_from: (body.priceValidFrom as string) ?? null,
    price_valid_to: (body.priceValidTo as string) ?? null,
    is_main_supplier: Boolean(body.isMainSupplier),
    notes: (body.notes as string) ?? null,
  };
  if (priceMatrix !== undefined) row.price_matrix = priceMatrix;

  // If marking as main supplier, demote any other main for the same material.
  if (row.is_main_supplier) {
    await supabase
      .from('supplier_material_bindings')
      .update({ is_main_supplier: false })
      .eq('material_kind', row.material_kind)
      .eq('material_code', row.material_code)
      .eq('is_main_supplier', true);
  }

  const { data, error } = await supabase.from('supplier_material_bindings').insert(row).select(BINDING_COLS).single();
  if (error) {
    if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
    return c.json({ error: 'insert_failed', reason: error.message }, 500);
  }
  return c.json({ binding: data }, 201);
});

// Batch-create bindings — multi-select from Products app maps to N bindings
// in a single POST. Each row may have its own supplier_sku/price/lead/moq.
// Skips materials already bound for this supplier (returns count skipped).
suppliers.post('/:id/bindings/batch', async (c) => {
  const supplierId = c.req.param('id');
  let body: { bindings?: Array<Record<string, unknown>> };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const list = body.bindings;
  if (!Array.isArray(list) || list.length === 0) return c.json({ error: 'bindings_required' }, 400);

  const supabase = c.get('supabase');

  // Pre-check: drop rows already bound for this supplier (avoid 23505).
  const codes = list.map((b) => String(b.materialCode ?? '')).filter(Boolean);
  const { data: existing } = await supabase
    .from('supplier_material_bindings')
    .select('material_code, material_kind')
    .eq('supplier_id', supplierId)
    .in('material_code', codes);
  const seen = new Set<string>(
    ((existing ?? []) as Array<{ material_code: string; material_kind: string }>)
      .map((r) => `${r.material_kind}|${r.material_code}`),
  );

  const rows: Array<Record<string, unknown>> = [];
  let skipped = 0;
  for (const b of list) {
    const kind = String(b.materialKind ?? 'mfg_product');
    if (!MATERIAL_KINDS.has(kind)) continue;
    if (!b.materialCode || !b.materialName || !b.supplierSku) continue;
    const key = `${kind}|${b.materialCode}`;
    if (seen.has(key)) { skipped += 1; continue; }
    const currency = String(b.currency ?? 'MYR');
    if (!CURRENCIES.has(currency)) continue;
    const row: Record<string, unknown> = {
      supplier_id: supplierId,
      material_kind: kind,
      material_code: b.materialCode,
      material_name: b.materialName,
      supplier_sku: b.supplierSku,
      unit_price_centi: typeof b.unitPriceCenti === 'number' ? b.unitPriceCenti : 0,
      currency,
      lead_time_days: typeof b.leadTimeDays === 'number' ? b.leadTimeDays : 0,
      moq: typeof b.moq === 'number' ? b.moq : 0,
      is_main_supplier: Boolean(b.isMainSupplier),
      notes: (b.notes as string | undefined) ?? null,
    };
    // PR — Commander 2026-05-27: optional per-category cost matrix on batch
    // create. Shape validated against the SKU's category; on error we skip
    // the row rather than 400ing the whole batch (caller can read the
    // inserted/skipped counts to know something dropped).
    if (b.priceMatrix !== undefined) {
      const cat = await categoryForMaterial(supabase, kind, String(b.materialCode));
      try {
        const pm = validatePriceMatrix(b.priceMatrix, cat);
        if (pm !== undefined) row.price_matrix = pm;
      } catch {
        // Invalid matrix for this row — drop the row from the batch.
        skipped += 1;
        continue;
      }
    }
    rows.push(row);
    seen.add(key);
  }

  if (rows.length === 0) return c.json({ inserted: 0, skipped });

  const { data, error } = await supabase
    .from('supplier_material_bindings')
    .insert(rows)
    .select(BINDING_COLS);
  if (error) {
    if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
    return c.json({ error: 'insert_failed', reason: error.message }, 500);
  }
  return c.json({ inserted: (data ?? []).length, skipped, bindings: data ?? [] }, 201);
});

suppliers.patch('/:id/bindings/:bindingId', async (c) => {
  const bindingId = c.req.param('bindingId');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  const map: Array<[keyof typeof body, string]> = [
    ['materialCode', 'material_code'], ['materialName', 'material_name'],
    ['supplierSku', 'supplier_sku'], ['unitPriceCenti', 'unit_price_centi'],
    ['leadTimeDays', 'lead_time_days'], ['paymentTermsOverride', 'payment_terms_override'],
    ['moq', 'moq'], ['priceValidFrom', 'price_valid_from'], ['priceValidTo', 'price_valid_to'],
    ['notes', 'notes'],
  ];
  for (const [from, to] of map) if (body[from] !== undefined) updates[to] = body[from];
  if (body.currency !== undefined && CURRENCIES.has(body.currency as string)) updates.currency = body.currency;
  if (body.materialKind !== undefined && MATERIAL_KINDS.has(body.materialKind as string)) updates.material_kind = body.materialKind;
  if (body.isMainSupplier !== undefined) updates.is_main_supplier = Boolean(body.isMainSupplier);

  const supabase = c.get('supabase');

  // PR — Commander 2026-05-27: validate price_matrix shape against the
  // binding's current category. We fetch the existing row's material_kind +
  // material_code (since the PATCH body may omit them), then look up the
  // SKU's category.
  if (body.priceMatrix !== undefined) {
    const { data: existing } = await supabase
      .from('supplier_material_bindings')
      .select('material_kind, material_code')
      .eq('id', bindingId)
      .maybeSingle();
    if (!existing) return c.json({ error: 'not_found' }, 404);
    const kind = (updates.material_kind as string | undefined) ?? existing.material_kind;
    const code = (updates.material_code as string | undefined) ?? existing.material_code;
    const cat = await categoryForMaterial(supabase, kind, code);
    try {
      updates.price_matrix = validatePriceMatrix(body.priceMatrix, cat);
    } catch (e) {
      const reason = e instanceof Error ? e.message : 'invalid_price_matrix';
      return c.json({ error: 'invalid_price_matrix', reason }, 400);
    }
  }

  // If promoting to main, demote others first (need to fetch the binding's material info).
  if (updates.is_main_supplier === true) {
    const { data: existing } = await supabase
      .from('supplier_material_bindings')
      .select('material_kind, material_code')
      .eq('id', bindingId)
      .maybeSingle();
    if (existing) {
      await supabase
        .from('supplier_material_bindings')
        .update({ is_main_supplier: false })
        .eq('material_kind', existing.material_kind)
        .eq('material_code', existing.material_code)
        .eq('is_main_supplier', true)
        .neq('id', bindingId);
    }
  }

  const { data, error } = await supabase.from('supplier_material_bindings').update(updates).eq('id', bindingId).select(BINDING_COLS).single();
  if (error) {
    if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
    return c.json({ error: 'update_failed', reason: error.message }, 500);
  }

  /* Cost anchor (0177) — if this binding is the cost anchor for its
     material_code, mirror its (just-written) cost onto the linked
     mfg_products row. Best-effort: the binding write above already
     committed, so a sync failure must not 500 this response. */
  await syncAnchoredProductFromBinding(supabase, data as unknown as Record<string, unknown>);

  return c.json({ binding: data });
});

// ── Set / clear the cost anchor for a binding ────────────────────────────
// PATCH /suppliers/:id/bindings/:bindingId/cost-anchor   body { anchor: boolean }
//
// Migration 0177. Flags (or clears) this binding as THE cost anchor for its
// material_code. At most one anchor per material_code is enforced here (app
// layer, like is_main_supplier): setting the anchor first clears the flag on
// every OTHER binding with the same material_code. On SET we also push the
// binding's current cost → the product immediately, so the two sides start
// aligned. Gated by RLS on supplier_material_bindings (write denial → 403),
// the same gate the cost-field PATCH above relies on.
suppliers.patch('/:id/bindings/:bindingId/cost-anchor', async (c) => {
  const bindingId = c.req.param('bindingId');
  let body: { anchor?: unknown };
  try { body = (await c.req.json()) as typeof body; } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  if (typeof body.anchor !== 'boolean') return c.json({ error: 'anchor_required' }, 400);
  const anchor = body.anchor;

  const supabase = c.get('supabase');

  // Fetch the binding's material identity (needed to clear sibling anchors and
  // to drive the initial sync).
  const { data: existing, error: loadErr } = await supabase
    .from('supplier_material_bindings')
    .select('id, material_kind, material_code')
    .eq('id', bindingId)
    .maybeSingle();
  if (loadErr) return c.json({ error: 'load_failed', reason: loadErr.message }, 500);
  if (!existing) return c.json({ error: 'not_found' }, 404);

  // Set this binding's flag first (this is the write RLS gates → 403 on denial).
  const { data: updated, error: setErr } = await supabase
    .from('supplier_material_bindings')
    .update({ is_cost_anchor: anchor, updated_at: new Date().toISOString() })
    .eq('id', bindingId)
    .select(BINDING_COLS)
    .single();
  if (setErr) {
    if (setErr.code === '42501') return c.json({ error: 'forbidden', reason: setErr.message }, 403);
    return c.json({ error: 'update_failed', reason: setErr.message }, 500);
  }

  // Enforce one-anchor-per-material: clear the flag on every OTHER binding for
  // the same material_code (only when turning this one ON).
  if (anchor) {
    await supabase
      .from('supplier_material_bindings')
      .update({ is_cost_anchor: false })
      .eq('material_kind', existing.material_kind)
      .eq('material_code', existing.material_code)
      .eq('is_cost_anchor', true)
      .neq('id', bindingId);

    // Initial sync — push the binding's current cost onto the product so they
    // start aligned. Best-effort (never fails the anchor toggle).
    await syncAnchoredProductFromBinding(supabase, updated as unknown as Record<string, unknown>);
  }

  return c.json({ binding: updated });
});

suppliers.delete('/:id/bindings/:bindingId', async (c) => {
  const bindingId = c.req.param('bindingId');
  const supabase = c.get('supabase');
  const { error } = await supabase.from('supplier_material_bindings').delete().eq('id', bindingId);
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);
  return c.body(null, 204);
});

// ── Scorecard: live PO + GRN aggregation for KPI tiles ───────────────
//
// Returns:
//   { onTimeRate %, defectRate %, averageLeadDays, totalPOs, receivedPOs,
//     onTimeCount, last10POs: [...] }
//
// Computed live (NOT from a cached supplier_scorecards row — keep this
// single endpoint truthful while volumes stay low). Promote to a view +
// nightly refresh job if/when PO volume passes a few hundred per supplier.
suppliers.get('/:id/scorecard', async (c) => {
  const id = c.req.param('id');
  const supabase = c.get('supabase');

  const { data: pos, error: posErr } = await supabase
    .from('purchase_orders')
    .select('id, po_number, status, po_date, expected_at, supplier_delivery_date_2, supplier_delivery_date_3, supplier_delivery_date_4, received_at, total_centi')
    .eq('supplier_id', id)
    .order('po_date', { ascending: false });

  if (posErr) return c.json({ error: 'load_failed', reason: posErr.message }, 500);

  const all = pos ?? [];
  const totalPOs = all.length;
  const receivedRows = all.filter((p) => p.status === 'RECEIVED' && p.received_at);

  let onTimeCount = 0;
  let leadDaysSum = 0;
  for (const p of receivedRows) {
    /* Migration 0180 — on-time is measured against the EFFECTIVE (LATEST revised)
       delivery date, per owner decision: MAX over non-null of [expected_at,
       _2, _3, _4]. camelCase trap — dual-read snake_case off the raw row. */
    const pr = p as Record<string, string | null | undefined>;
    const effExpected = effectiveDelivery(
      p.expected_at,
      pr.supplierDeliveryDate2 ?? pr.supplier_delivery_date_2,
      pr.supplierDeliveryDate3 ?? pr.supplier_delivery_date_3,
      pr.supplierDeliveryDate4 ?? pr.supplier_delivery_date_4,
    );
    if (effExpected && p.received_at) {
      const rec = new Date(p.received_at).getTime();
      const exp = new Date(effExpected).getTime();
      if (Number.isFinite(rec) && Number.isFinite(exp) && rec <= exp) onTimeCount += 1;
    }
    if (p.received_at && p.po_date) {
      const rec = new Date(p.received_at).getTime();
      const ord = new Date(p.po_date).getTime();
      if (Number.isFinite(rec) && Number.isFinite(ord)) {
        leadDaysSum += Math.max(0, Math.round((rec - ord) / 86400000));
      }
    }
  }

  const receivedPOs = receivedRows.length;
  const onTimeRate = receivedPOs > 0 ? (onTimeCount / receivedPOs) * 100 : 0;
  const averageLeadDays = receivedPOs > 0 ? leadDaysSum / receivedPOs : 0;

  // Defect rate = rejected_qty / received_qty across this supplier's posted GRNs.
  const { data: grnAgg } = await supabase
    .from('grn_items')
    .select('qty_received, qty_rejected, grn:grns!inner(supplier_id, status)')
    .eq('grn.supplier_id', id)
    .eq('grn.status', 'POSTED');

  let totalReceived = 0;
  let totalRejected = 0;
  for (const row of (grnAgg ?? []) as Array<{ qty_received: number; qty_rejected: number }>) {
    totalReceived += row.qty_received || 0;
    totalRejected += row.qty_rejected || 0;
  }
  const defectRate = totalReceived > 0 ? (totalRejected / totalReceived) * 100 : 0;

  // Last 10 POs with ordered/received qty totals
  const last10Raw = all.slice(0, 10);
  const last10POs = await Promise.all(
    last10Raw.map(async (po) => {
      const { data: items } = await supabase
        .from('purchase_order_items')
        .select('qty, received_qty')
        .eq('purchase_order_id', po.id);
      const orderedQty = (items ?? []).reduce((s, r) => s + (r.qty || 0), 0);
      const receivedQty = (items ?? []).reduce((s, r) => s + (r.received_qty || 0), 0);
      return {
        id: po.id,
        poNo: po.po_number,
        status: po.status,
        poDate: po.po_date,
        expectedDate: po.expected_at,
        receivedDate: po.received_at,
        totalCenti: po.total_centi,
        orderedQty,
        receivedQty,
      };
    }),
  );

  return c.json({
    supplierId: id,
    onTimeRate,
    defectRate,
    averageLeadDays,
    totalPOs,
    receivedPOs,
    onTimeCount,
    last10POs,
  });
});

// ── Reverse lookup: who supplies this material? ──────────────────────
suppliers.get('/material/:kind/:code', async (c) => {
  const kind = c.req.param('kind');
  const code = c.req.param('code');
  const mainOnly = c.req.query('mainOnly') === 'true';

  if (!MATERIAL_KINDS.has(kind)) return c.json({ error: 'invalid_material_kind' }, 400);

  const supabase = c.get('supabase');
  let q = supabase
    .from('supplier_material_bindings')
    .select(`${BINDING_COLS}, supplier:suppliers(id, code, name, status)`)
    .eq('material_kind', kind)
    .eq('material_code', code)
    .order('is_main_supplier', { ascending: false })
    .order('unit_price_centi', { ascending: true });
  if (mainOnly) q = q.eq('is_main_supplier', true);

  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ bindings: data ?? [] });
});
