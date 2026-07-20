// ----------------------------------------------------------------------------
// /pos-pools — catalog + configurator read seam for the 2990 POS repoint.
//
// The POS (apps/pos) reads its whole catalog + configurator pools from this
// family. Before the cutover it hit 2990's API + direct Supabase; pointed at
// Houzs (VITE_BACKEND_TARGET=houzs) it reads here. Nine reads, company-scoped
// via X-Company-Id (POS = company 2):
//   GET /pos-pools/mfg-catalog[?id | ?modelId | ?baseModel&category]  <- spine
//   GET /pos-pools/product-size-variants?productId=
//   GET /pos-pools/size-library
//   GET /pos-pools/product-bundles?productId=
//   GET /pos-pools/product-compartments?productId=
//   GET /pos-pools/product-fabrics?productId=
//   GET /pos-pools/bedframe-colours
//   GET /pos-pools/product-bedframe-colours?productId=
//   GET /pos-pools/bedframe-options
//
// mfg-catalog is the live path (mfg_products + product_models embed); the eight
// pools back the legacy-retail configurator. Everything here is SELLING-only:
// cost columns (base_price_sen / price1_sen / cost_price_sen, and
// seat_height_prices[].priceSen) are never selected or emitted (#625). Units:
// mfg-catalog is in sen; the eight pools are whole MYR (their price/surcharge
// columns are int MYR, no cost column exists on any of them).
//
// Handlers are exported (like listMfgProductsHandler) so tests can drive them on
// a bare Hono app with an injected fake supabase + companyId.
// ----------------------------------------------------------------------------

import { Hono, type Context } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import { paginateAll } from '../lib/paginate-all';
import { scopeToCompany } from '../lib/companyScope';
import type { Env, Variables } from '../env';

export const posPools = new Hono<{ Bindings: Env; Variables: Variables }>();

posPools.use('*', supabaseAuth);

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

// SELLING-only projection. cost_price_sen / base_price_sen / price1_sen are
// deliberately absent (#625) — the POS never needs them and they are cost.
// retail_product_id is added explicitly (the standard /mfg-products select
// omits it) so the POS's legacy-UUID bridge can resolve.
export const MFG_CATALOG_COLS =
  'id, code, name, category, description, branding, size_label, size_code, ' +
  'sell_price_sen, pwp_price_sen, seat_height_prices, included_addons, ' +
  'base_model, model_id, retail_product_id, status, pos_active, ' +
  'product_models(id, name, model_code, photo_url, active, allowed_options)';

// seat_height_prices holds a per-height COST (priceSen) next to the selling
// side (sellingPriceSen). Strip the cost per entry, keep {height,tier,sellingPriceSen}.
function stripSeatHeightCost(rows: unknown): unknown {
  if (!Array.isArray(rows)) return rows;
  return rows.map((r) => {
    if (r && typeof r === 'object' && 'priceSen' in (r as Record<string, unknown>)) {
      const { priceSen, ...rest } = r as Record<string, unknown>;
      void priceSen;
      return rest;
    }
    return r;
  });
}

// ── GET /mfg-catalog ─────────────────────────────────────────────────────────
// The catalog spine + configurator loader. Four mutually-exclusive variants
// share ONE row shape; only the filter differs. Precedence id > modelId >
// baseModel > spine. HARD RULE: the id/modelId/baseModel variants must NOT
// filter on status/pos_active — a discontinued (status=INACTIVE) but pos_active
// sibling has to survive so the size picker keeps every size (greyed
// client-side). Only the paramless spine filters to pos_active=true (any status).
export const mfgCatalogHandler = async (c: AppContext) => {
  const supabase = c.get('supabase');
  const id = c.req.query('id');
  const modelId = c.req.query('modelId');
  const baseModel = c.req.query('baseModel');
  const category = c.req.query('category');

  const { data, error } = await paginateAll((from, to) => {
    let q = supabase.from('mfg_products').select(MFG_CATALOG_COLS);
    if (id) {
      q = q.eq('id', id);
    } else if (modelId) {
      q = q.eq('model_id', modelId);
    } else if (baseModel) {
      q = q.eq('base_model', baseModel);
      if (category) q = q.eq('category', category);
    } else {
      q = q.eq('pos_active', true);
    }
    q = scopeToCompany(q, c);
    return q.order('code', { ascending: true }).range(from, to);
  });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  const products = ((data ?? []) as unknown as Array<Record<string, unknown>>).map((p) => ({
    ...p,
    seat_height_prices: stripSeatHeightCost(p.seat_height_prices),
  }));
  // Short PRIVATE cache like /mfg-products; Vary on X-Company-Id so a company
  // switch does not serve the other company's cached catalogue.
  c.header('cache-control', 'private, max-age=60');
  c.header('vary', 'X-Company-Id');
  return c.json({ products });
};
posPools.get('/mfg-catalog', mfgCatalogHandler);

// ── legacy-retail configurator pools ─────────────────────────────────────────
// Each backs one 2990 direct-Supabase read; whole-MYR selling values, no cost
// column exists on any of these tables. All company-scoped. productId-scoped
// pools return [] when the param is absent (mfg-* ids short-circuit client-side
// before ever calling; only legacy-UUID products reach these).

export const productSizeVariantsHandler = async (c: AppContext) => {
  const supabase = c.get('supabase');
  const productId = c.req.query('productId');
  if (!productId) return c.json({ rows: [] });
  const { data, error } = await scopeToCompany(
    supabase.from('product_size_variants').select('size_id, active, price').eq('product_id', productId),
    c,
  );
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const rows = ((data ?? []) as Array<{ size_id: string; active: boolean; price: number }>).map((r) => ({
    sizeId: r.size_id,
    active: r.active,
    price: r.price,
    pwpPrice: null,
  }));
  return c.json({ rows });
};
posPools.get('/product-size-variants', productSizeVariantsHandler);

export const sizeLibraryHandler = async (c: AppContext) => {
  const supabase = c.get('supabase');
  const { data, error } = await scopeToCompany(
    supabase.from('size_library').select('id, label, width_cm, length_cm, sort_order').order('sort_order'),
    c,
  );
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const rows = ((data ?? []) as Array<{ id: string; label: string; width_cm: number; length_cm: number; sort_order: number }>).map((r) => ({
    id: r.id,
    label: r.label,
    widthCm: r.width_cm,
    lengthCm: r.length_cm,
    sortOrder: r.sort_order,
  }));
  return c.json({ rows });
};
posPools.get('/size-library', sizeLibraryHandler);

export const productBundlesHandler = async (c: AppContext) => {
  const supabase = c.get('supabase');
  const productId = c.req.query('productId');
  if (!productId) return c.json({ rows: [] });
  const { data, error } = await scopeToCompany(
    supabase.from('product_bundles').select('bundle_id, active, price').eq('product_id', productId),
    c,
  );
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const rows = ((data ?? []) as Array<{ bundle_id: string; active: boolean; price: number }>).map((r) => ({
    bundleId: r.bundle_id,
    active: r.active,
    price: r.price,
  }));
  return c.json({ rows });
};
posPools.get('/product-bundles', productBundlesHandler);

export const productCompartmentsHandler = async (c: AppContext) => {
  const supabase = c.get('supabase');
  const productId = c.req.query('productId');
  if (!productId) return c.json({ rows: [] });
  const { data, error } = await scopeToCompany(
    supabase.from('product_compartments').select('compartment_id, active, price').eq('product_id', productId),
    c,
  );
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const rows = ((data ?? []) as Array<{ compartment_id: string; active: boolean; price: number }>).map((r) => ({
    compartmentId: r.compartment_id,
    active: r.active,
    price: r.price,
  }));
  return c.json({ rows });
};
posPools.get('/product-compartments', productCompartmentsHandler);

export const productFabricsHandler = async (c: AppContext) => {
  const supabase = c.get('supabase');
  const productId = c.req.query('productId');
  if (!productId) return c.json({ rows: [] });
  const { data, error } = await scopeToCompany(
    supabase.from('product_fabrics').select('fabric_id, active, surcharge').eq('product_id', productId),
    c,
  );
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const rows = ((data ?? []) as Array<{ fabric_id: string; active: boolean; surcharge: number }>).map((r) => ({
    fabricId: r.fabric_id,
    active: r.active,
    surcharge: r.surcharge,
  }));
  return c.json({ rows });
};
posPools.get('/product-fabrics', productFabricsHandler);

export const bedframeColoursHandler = async (c: AppContext) => {
  const supabase = c.get('supabase');
  const { data, error } = await scopeToCompany(
    supabase.from('bedframe_colours').select('id, label, swatch_hex, surcharge, sort_order').eq('active', true).order('sort_order'),
    c,
  );
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const rows = ((data ?? []) as Array<{ id: string; label: string; swatch_hex: string | null; surcharge: number; sort_order: number }>).map((r) => ({
    id: r.id,
    label: r.label,
    swatchHex: r.swatch_hex,
    surcharge: r.surcharge,
    sortOrder: r.sort_order,
  }));
  return c.json({ rows });
};
posPools.get('/bedframe-colours', bedframeColoursHandler);

export const productBedframeColoursHandler = async (c: AppContext) => {
  const supabase = c.get('supabase');
  const productId = c.req.query('productId');
  if (!productId) return c.json({ rows: [] });
  const { data, error } = await scopeToCompany(
    supabase.from('product_bedframe_colours').select('colour_id, active').eq('product_id', productId),
    c,
  );
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const rows = ((data ?? []) as Array<{ colour_id: string; active: boolean }>).map((r) => ({
    colourId: r.colour_id,
    active: r.active,
  }));
  return c.json({ rows });
};
posPools.get('/product-bedframe-colours', productBedframeColoursHandler);

export const bedframeOptionsHandler = async (c: AppContext) => {
  const supabase = c.get('supabase');
  const { data, error } = await scopeToCompany(
    supabase.from('bedframe_options').select('id, kind, value, surcharge, sort_order').eq('active', true).order('sort_order'),
    c,
  );
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const rows = ((data ?? []) as Array<{ id: string; kind: string; value: string; surcharge: number; sort_order: number }>).map((r) => ({
    id: r.id,
    kind: r.kind,
    value: r.value,
    surcharge: r.surcharge,
    sortOrder: r.sort_order,
  }));
  return c.json({ rows });
};
posPools.get('/bedframe-options', bedframeOptionsHandler);
