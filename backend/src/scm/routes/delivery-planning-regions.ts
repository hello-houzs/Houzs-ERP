// ----------------------------------------------------------------------------
// /delivery-planning-regions — CONFIG for the Delivery Planning board.
//
// Ported 1:1 from 2990 apps/api/src/routes/delivery-planning-regions.ts. The scm
// schema (migration 0053) made the board's region classification owner-maintained:
//   • delivery_planning_regions — the master list of region buckets (tabs).
//     Houzs seeds SELANGOR / KL / NORTHERN / SOUTHERN / EAST_COAST / EAST_MY,
//     owner-extensible. code + name + sort_order + active.
//   • state_delivery_regions — a per-STATE MULTI mapping of which region(s) a
//     state's orders appear under. One state can map to MANY regions so an order
//     surfaces under several tabs.
//
// A state's identity = its NAME (TEXT) — the same value held in
// mfg_sales_orders.customer_state. The frontend multi-select sends
// { stateKey, country, regionCodes }.
//
// Endpoints:
//   GET    /                       — list region masters (active+inactive, sorted)
//   POST   /                       — create a region bucket
//   PATCH  /:id                    — patch a region bucket
//   DELETE /:id                    — delete a region (BLOCKED if any state maps to it)
//   GET    /states                 — full per-state → region-codes map (for the editor)
//   GET    /states/:stateKey       — the region codes for ONE state (?country=)
//   PUT    /states/:stateKey       — REPLACE a state's region set (multi)
//
// Houzs adaptation vs 2990: import paths only (../middleware/auth, ../env,
// ../lib/paginate-all are the vendored scm equivalents). c.get('supabase') is the
// scm-scoped service client, so .from('delivery_planning_regions') = scm.delivery_
// planning_regions. snake_case columns, no camelCase transform.
//
// Mounted at '/delivery-planning-regions' in scm/index.ts.
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import { z } from 'zod';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { paginateAll } from '../lib/paginate-all';
import { activeCompanyId, stampCompany, scopeToAllowedCompanies } from '../lib/companyScope';

export const deliveryPlanningRegions = new Hono<{ Bindings: Env; Variables: Variables }>();
deliveryPlanningRegions.use('*', supabaseAuth);

const REGION_COLS = 'id, code, name, sort_order, active, created_at';

/* Shape a region master row out (dual-read camelCase — the pg/PostgREST layer
   may surface either snake_case or camelCase depending on the path). */
type RegionRow = {
  id: string; code: string | null; name: string | null;
  sort_order?: number | null; sortOrder?: number | null;
  active?: boolean | null; created_at?: string | null; createdAt?: string | null;
};
function regionOut(r: RegionRow) {
  return {
    id:        r.id,
    code:      r.code ?? '',
    name:      r.name ?? '',
    sortOrder: Number(r.sortOrder ?? r.sort_order ?? 0),
    active:    (r.active ?? true) !== false,
    createdAt: r.createdAt ?? r.created_at ?? null,
  };
}

// ── GET / — list all region buckets (active + inactive), sorted for the tab row.
deliveryPlanningRegions.get('/', async (c) => {
  const sb = c.get('supabase');
  const { data, error } = await paginateAll<RegionRow>((from, to) => {
    // CROSS-COMPANY view: widen to every allowed company (one shared config).
    let q = sb.from('delivery_planning_regions')
      .select(REGION_COLS)
      .order('sort_order', { ascending: true })
      .order('code', { ascending: true })
      .range(from, to);
    q = scopeToAllowedCompanies(q, c);
    return q;
  });
  if (error) return c.json({ error: 'fetch_failed', reason: error.message }, 500);
  return c.json({ regions: (data ?? []).map(regionOut) });
});

const regionCreateSchema = z.object({
  code:      z.string().trim().min(1).max(40),
  name:      z.string().trim().min(1).max(120),
  sortOrder: z.number().int().optional(),
  active:    z.boolean().optional(),
});

// ── POST / — create a region bucket. code is UNIQUE (case-normalised upper).
deliveryPlanningRegions.post('/', async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = regionCreateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const p = parsed.data;

  const sb = c.get('supabase');
  const { data, error } = await sb.from('delivery_planning_regions').insert({
    company_id: activeCompanyId(c),
    code:       p.code.toUpperCase(),
    name:       p.name,
    sort_order: p.sortOrder ?? 0,
    active:     p.active ?? true,
  }).select(REGION_COLS).single();
  if (error) {
    if (error.code === '23505') return c.json({ error: 'duplicate_code', reason: 'A region with that code already exists.' }, 409);
    if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
    return c.json({ error: 'insert_failed', reason: error.message }, 500);
  }
  return c.json({ region: regionOut(data as RegionRow) }, 201);
});

const regionPatchSchema = z.object({
  code:      z.string().trim().min(1).max(40).optional(),
  name:      z.string().trim().min(1).max(120).optional(),
  sortOrder: z.number().int().optional(),
  active:    z.boolean().optional(),
});

// ── PATCH /:id — patch a region bucket.
deliveryPlanningRegions.patch('/:id', async (c) => {
  const id = c.req.param('id');
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = regionPatchSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const p = parsed.data;

  const updates: Record<string, unknown> = {};
  if (p.code !== undefined)      updates.code = p.code.toUpperCase();
  if (p.name !== undefined)      updates.name = p.name;
  if (p.sortOrder !== undefined) updates.sort_order = p.sortOrder;
  if (p.active !== undefined)    updates.active = p.active;
  if (Object.keys(updates).length === 0) return c.json({ error: 'no_changes' }, 400);

  const sb = c.get('supabase');
  const { data, error } = await sb.from('delivery_planning_regions')
    .update(updates).eq('id', id).select(REGION_COLS).maybeSingle();
  if (error) {
    if (error.code === '23505') return c.json({ error: 'duplicate_code' }, 409);
    if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
    return c.json({ error: 'update_failed', reason: error.message }, 500);
  }
  if (!data) return c.json({ error: 'not_found' }, 404);
  return c.json({ region: regionOut(data as RegionRow) });
});

// ── DELETE /:id — delete a region. BLOCKED when any state still maps to it
//    (the FK is ON DELETE CASCADE, so we guard in the app to avoid silently
//    wiping a state's mapping — same "guard delete if in use" pattern).
deliveryPlanningRegions.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const sb = c.get('supabase');

  const { data: inUse, error: useErr } = await sb.from('state_delivery_regions')
    .select('id').eq('region_id', id).limit(1);
  if (useErr) return c.json({ error: 'check_failed', reason: useErr.message }, 500);
  if ((inUse ?? []).length > 0) {
    return c.json({ error: 'region_in_use', reason: 'One or more states still map to this region. Remove those mappings first.' }, 409);
  }

  const { error } = await sb.from('delivery_planning_regions').delete().eq('id', id);
  if (error) {
    if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
    return c.json({ error: 'delete_failed', reason: error.message }, 500);
  }
  return c.json({ ok: true });
});

/* ──────────────────────────────────────────────────────────────────────────
   STATE → REGION(S) mapping (the per-state MULTI mapping).
   ─────────────────────────────────────────────────────────────────────────*/

type StateRegionRow = {
  state_key?: string | null; stateKey?: string | null;
  country?: string | null;
  region_id?: string | null; regionId?: string | null;
};

/* Build code-by-id + id-by-code maps from the region master (one read). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadRegionMaps(sb: any) {
  const { data, error } = await paginateAll<RegionRow>((from, to) =>
    sb.from('delivery_planning_regions').select('id, code, name, active').range(from, to),
  );
  if (error) return { error, codeById: new Map<string, string>(), idByCode: new Map<string, string>() };
  const codeById = new Map<string, string>();
  const idByCode = new Map<string, string>();
  for (const r of (data ?? [])) {
    const code = (r.code ?? '').toUpperCase();
    if (code) { codeById.set(r.id, code); idByCode.set(code, r.id); }
  }
  return { error: null, codeById, idByCode };
}

// ── GET /states — full per-state → region-codes map (drives the editor table).
deliveryPlanningRegions.get('/states', async (c) => {
  const sb = c.get('supabase');
  const { codeById, error: rErr } = await loadRegionMaps(sb);
  if (rErr) return c.json({ error: 'fetch_failed', reason: rErr.message }, 500);

  const { data, error } = await paginateAll<StateRegionRow>((from, to) =>
    sb.from('state_delivery_regions')
      .select('state_key, country, region_id')
      .range(from, to),
  );
  if (error) return c.json({ error: 'fetch_failed', reason: error.message }, 500);

  // Group by (stateKey|country) → sorted region codes.
  const byState = new Map<string, { stateKey: string; country: string; regionCodes: string[] }>();
  for (const row of (data ?? [])) {
    const stateKey = row.stateKey ?? row.state_key ?? '';
    const country = row.country ?? 'Malaysia';
    const regionId = row.regionId ?? row.region_id ?? '';
    const code = codeById.get(regionId);
    if (!stateKey || !code) continue;
    const key = `${stateKey}|${country}`;
    const agg = byState.get(key) ?? { stateKey, country, regionCodes: [] };
    if (!agg.regionCodes.includes(code)) agg.regionCodes.push(code);
    byState.set(key, agg);
  }
  const states = [...byState.values()]
    .map((s) => ({ ...s, regionCodes: s.regionCodes.sort() }))
    .sort((a, b) => a.stateKey.localeCompare(b.stateKey));
  return c.json({ states });
});

// ── GET /states/:stateKey?country= — the region codes for ONE state.
deliveryPlanningRegions.get('/states/:stateKey', async (c) => {
  const stateKey = c.req.param('stateKey');
  const country = (c.req.query('country') ?? 'Malaysia').trim() || 'Malaysia';
  const sb = c.get('supabase');

  const { codeById, error: rErr } = await loadRegionMaps(sb);
  if (rErr) return c.json({ error: 'fetch_failed', reason: rErr.message }, 500);

  const { data, error } = await paginateAll<StateRegionRow>((from, to) =>
    sb.from('state_delivery_regions')
      .select('state_key, country, region_id')
      .eq('state_key', stateKey)
      .eq('country', country)
      .range(from, to),
  );
  if (error) return c.json({ error: 'fetch_failed', reason: error.message }, 500);

  const regionCodes = [...new Set(
    (data ?? [])
      .map((row) => codeById.get(row.regionId ?? row.region_id ?? ''))
      .filter((x): x is string => Boolean(x)),
  )].sort();
  return c.json({ stateKey, country, regionCodes });
});

const putStateSchema = z.object({
  // The set of region CODES this state should map to. [] clears the mapping.
  regionCodes: z.array(z.string().trim().min(1)).default([]),
  country:     z.string().trim().min(1).optional(),   // defaults to Malaysia
});

// ── PUT /states/:stateKey — REPLACE a state's region set (multi). Delete the
//    state's existing rows, then insert the new set. Unknown codes are reported.
deliveryPlanningRegions.put('/states/:stateKey', async (c) => {
  const stateKey = c.req.param('stateKey');
  if (!stateKey) return c.json({ error: 'state_required' }, 400);
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = putStateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const country = (parsed.data.country ?? 'Malaysia').trim() || 'Malaysia';
  const wantCodes = [...new Set(parsed.data.regionCodes.map((x) => x.toUpperCase()))];

  const sb = c.get('supabase');
  const { idByCode, error: rErr } = await loadRegionMaps(sb);
  if (rErr) return c.json({ error: 'fetch_failed', reason: rErr.message }, 500);

  // Resolve codes → ids; reject if any code is unknown (so a typo can't silently
  // drop the state from a tab).
  const unknown = wantCodes.filter((code) => !idByCode.has(code));
  if (unknown.length > 0) {
    return c.json({ error: 'unknown_region_code', reason: `Unknown region code(s): ${unknown.join(', ')}` }, 400);
  }
  const regionIds = wantCodes.map((code) => idByCode.get(code)!);

  // Replace: clear the state's existing rows, then insert the new set.
  const { error: delErr } = await sb.from('state_delivery_regions')
    .delete().eq('state_key', stateKey).eq('country', country);
  if (delErr) {
    if (delErr.code === '42501') return c.json({ error: 'forbidden', reason: delErr.message }, 403);
    return c.json({ error: 'replace_failed', reason: delErr.message }, 500);
  }

  if (regionIds.length > 0) {
    const rows = regionIds.map((region_id) => ({ state_key: stateKey, country, region_id }));
    const { error: insErr } = await sb.from('state_delivery_regions').insert(stampCompany(rows, c));
    if (insErr) {
      if (insErr.code === '42501') return c.json({ error: 'forbidden', reason: insErr.message }, 403);
      return c.json({ error: 'replace_failed', reason: insErr.message }, 500);
    }
  }

  return c.json({ ok: true, stateKey, country, regionCodes: wantCodes.sort() });
});
