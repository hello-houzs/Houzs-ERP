// ----------------------------------------------------------------------------
// /lorries — CRUD for the lorries table (TMS fleet master, migration 0053).
// Cloned from drivers.ts. is_internal is the In-house / Outsource marker
// (Houzs parity); the list accepts a ?fleet=internal|outsourced filter.
//
// Houzs adaptation of 2990's apps/api/src/routes/lorries.ts — same plumbing as
// the sibling SCM routes (supabaseAuth bridge + scm-scoped client via
// c.get('supabase')). scm.lorries already exists (migration 0053). Mounted at
// '/lorries' in scm/index.ts.
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { activeCompanyId, scopeToAllowedCompanies } from '../lib/companyScope';

export const lorries = new Hono<{ Bindings: Env; Variables: Variables }>();
lorries.use('*', supabaseAuth);

const COLS = 'id, plate, type, is_internal, warehouse_id, capacity_m3, capacity_kg, active, notes, created_at, updated_at';

// Mirrors the lorry_type enum in migration 0053. Reject anything else so a bad
// client can't write a value Postgres would 22P02 on.
const LORRY_TYPES = new Set([
  'LORRY_10FT', 'LORRY_14FT', 'LORRY_17FT', 'LORRY_21FT', 'VAN', 'OUTSOURCE', 'OTHER',
]);

/** numeric(.,.) capacity — accept a number/string, store null when blank/invalid. */
function toNumericOrNull(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

lorries.get('/', async (c) => {
  const sb = c.get('supabase');
  const onlyActive = c.req.query('active') !== 'false';   // default: active only
  const fleet = c.req.query('fleet');                     // 'internal' | 'outsourced' | undefined (=all)
  let q = sb.from('lorries').select(COLS).order('plate');
  if (onlyActive) q = q.eq('active', true);
  if (fleet === 'internal') q = q.eq('is_internal', true);
  if (fleet === 'outsourced') q = q.eq('is_internal', false);
  // CROSS-COMPANY view: widen to every allowed company (one shared fleet).
  q = scopeToAllowedCompanies(q, c);
  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ lorries: data ?? [] });
});

lorries.post('/', async (c) => {
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const plate = String(body.plate ?? '').trim();
  if (!plate) return c.json({ error: 'plate_required' }, 400);
  const type = String(body.type ?? 'OTHER').trim();
  if (!LORRY_TYPES.has(type)) return c.json({ error: 'invalid_type' }, 400);

  const sb = c.get('supabase');
  const { data, error } = await sb.from('lorries').insert({
    company_id: activeCompanyId(c),
    plate,
    type,
    is_internal: body.isInternal === false ? false : true,
    warehouse_id: (body.warehouseId as string) || null,
    capacity_m3: toNumericOrNull(body.capacityM3),
    capacity_kg: toNumericOrNull(body.capacityKg),
    notes: (body.notes as string) ?? null,
    active: body.active === false ? false : true,
  }).select(COLS).single();
  if (error) {
    if (error.code === '23505') return c.json({ error: 'duplicate_plate' }, 409);
    if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
    return c.json({ error: 'insert_failed', reason: error.message }, 500);
  }
  return c.json({ lorry: data }, 201);
});

lorries.patch('/:id', async (c) => {
  const id = c.req.param('id');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }

  const updates: Record<string, unknown> = {};
  if (body.plate !== undefined) {
    const plate = String(body.plate).trim();
    if (!plate) return c.json({ error: 'plate_required' }, 400);
    updates.plate = plate;
  }
  if (body.type !== undefined) {
    const type = String(body.type).trim();
    if (!LORRY_TYPES.has(type)) return c.json({ error: 'invalid_type' }, 400);
    updates.type = type;
  }
  if (body.warehouseId !== undefined) updates.warehouse_id = (body.warehouseId as string) || null;
  if (body.capacityM3 !== undefined) updates.capacity_m3 = toNumericOrNull(body.capacityM3);
  if (body.capacityKg !== undefined) updates.capacity_kg = toNumericOrNull(body.capacityKg);
  if (body.notes !== undefined) updates.notes = (body.notes as string) || null;
  if (body.isInternal !== undefined) updates.is_internal = Boolean(body.isInternal);
  if (body.active !== undefined) updates.active = Boolean(body.active);
  // Touch updated_at on any edit (the master has an updated_at column).
  if (Object.keys(updates).length === 0) return c.json({ error: 'no_changes' }, 400);
  updates.updated_at = new Date().toISOString();

  const sb = c.get('supabase');
  const { data, error } = await sb.from('lorries').update(updates).eq('id', id).select(COLS).single();
  if (error) {
    if (error.code === '23505') return c.json({ error: 'duplicate_plate' }, 409);
    return c.json({ error: 'update_failed', reason: error.message }, 500);
  }
  return c.json({ lorry: data });
});

export default lorries;
