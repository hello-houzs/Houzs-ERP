// ---------------------------------------------------------------------------
// dp-orders.ts — the DP Order (delivery-planning job) route.
//
// Owner spec 2026-07-18. Six job types, each auto-filling its party from a
// different master (scm/lib/dp-party.ts does the mapping); one flat snapshot in
// scm.dp_orders (mig 0129). The DP number is minted at SCHEDULE from the assigned
// lorry's plate + the trip date (scm/lib/dp-no.ts) — "schedule then DP number".
//
// Mounted at /api/scm/dp-orders. Reads scm.* via the PostgREST client and the
// PMS/service masters (public.projects / users / assr_cases) via c.env.DB raw
// SQL, exactly as delivery-planning.ts does for the ASSR union.
// ---------------------------------------------------------------------------

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Env, Variables } from '../env';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;
import { activeCompanyId } from '../lib/companyScope';
import {
  partyTypeFor, emptySnapshot, snapshotFromSo, snapshotFromSupplier,
  snapshotFromProject, snapshotFromAssr, type DpJobType, type DpPartySnapshot,
} from '../lib/dp-party';
import { mintDpNo } from '../lib/dp-no';

export const dpOrders = new Hono<{ Bindings: Env; Variables: Variables }>();

const JOB_TYPES = ['DELIVERY', 'PICKUP', 'SERVICE', 'SETUP', 'DISMANTLE', 'SUPPLIER_PICKUP'] as const;

const createSchema = z.object({
  jobType: z.enum(JOB_TYPES),
  // At most one source reference — which one is expected depends on the type,
  // but the resolver tolerates any and falls back to a manual (empty) snapshot.
  soDocNo: z.string().optional(),
  doId: z.string().uuid().optional(),
  assrCaseId: z.number().int().optional(),
  supplierId: z.string().uuid().optional(),
  projectId: z.number().int().optional(),
  requestedDate: z.string().optional(), // YYYY-MM-DD
  remark: z.string().optional(),
  // Manual overrides — applied ON TOP of the auto-filled snapshot so the operator
  // can correct any field the master got wrong.
  overrides: z.record(z.string(), z.string().nullable()).optional(),
});

/** Read the source master (if any) and map it to the party snapshot. Falls back
 *  to an empty snapshot of the right type for a manual order. */
async function resolveSnapshot(
  c: Ctx,
  jobType: DpJobType,
  p: z.infer<typeof createSchema>,
): Promise<DpPartySnapshot> {
  const sb = c.get('supabase');
  if (p.soDocNo) {
    const { data } = await sb.from('mfg_sales_orders')
      .select('debtor_name, phone, address1, address2, address3, address4, city, postcode, customer_state')
      .eq('doc_no', p.soDocNo).maybeSingle();
    if (data) return snapshotFromSo(data as Record<string, unknown>);
  }
  if (p.supplierId) {
    const { data } = await sb.from('suppliers')
      .select('name, contact_person, attention, phone, mobile, address, address1, address2, address3, address4, city, postcode, state')
      .eq('id', p.supplierId).maybeSingle();
    if (data) return snapshotFromSupplier(data as Record<string, unknown>);
  }
  if (p.projectId != null) {
    // public schema → raw SQL, like delivery-planning's ASSR union.
    const proj = await c.env.DB.prepare(
      'SELECT venue, venue_address, organizer, state, pic_id FROM projects WHERE id = ?',
    ).bind(p.projectId).first<Record<string, unknown>>();
    if (proj) {
      let picUser: Record<string, unknown> | null = null;
      if (proj.pic_id != null) {
        picUser = await c.env.DB.prepare('SELECT name, phone FROM users WHERE id = ?')
          .bind(proj.pic_id).first<Record<string, unknown>>();
      }
      return snapshotFromProject(proj, picUser);
    }
  }
  if (p.assrCaseId != null) {
    const a = await c.env.DB.prepare(
      'SELECT customer_name, phone, addr1, addr2, addr3, addr4, location FROM assr_cases WHERE id = ?',
    ).bind(p.assrCaseId).first<Record<string, unknown>>();
    if (a) return snapshotFromAssr(a);
  }
  return emptySnapshot(jobType);
}

/* ── POST /api/scm/dp-orders — create (type-aware auto-fill) ───────────────── */
dpOrders.post('/', async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', reason: parsed.error.message }, 400);
  const p = parsed.data;
  const jobType = p.jobType as DpJobType;

  const snap = await resolveSnapshot(c, jobType, p);
  // Manual overrides win over the auto-fill — only for keys the snapshot has.
  const merged: Record<string, unknown> = { ...snap };
  for (const [k, v] of Object.entries(p.overrides ?? {})) {
    if (k in merged) merged[k] = v;
  }

  const sb = c.get('supabase');
  const user = c.get('user') as { id?: string } | null;
  const insert = {
    company_id: activeCompanyId(c) ?? null,
    dp_no: null, // minted at schedule
    job_type: jobType,
    party_type: partyTypeFor(jobType),
    so_doc_no: p.soDocNo ?? null,
    do_id: p.doId ?? null,
    assr_case_id: p.assrCaseId ?? null,
    supplier_id: p.supplierId ?? null,
    project_id: p.projectId ?? null,
    party_name: merged.party_name ?? null,
    contact_name: merged.contact_name ?? null,
    contact_phone: merged.contact_phone ?? null,
    address1: merged.address1 ?? null, address2: merged.address2 ?? null,
    address3: merged.address3 ?? null, address4: merged.address4 ?? null,
    city: merged.city ?? null, postcode: merged.postcode ?? null, state: merged.state ?? null,
    requested_date: p.requestedDate ?? null,
    status: 'PENDING_SCHEDULE',
    remark: p.remark ?? null,
    created_by: user?.id ?? null,
  };
  const { data, error } = await sb.from('dp_orders').insert(insert).select('*').maybeSingle();
  if (error) return c.json({ error: 'create_failed', reason: error.message }, 500);
  return c.json({ dpOrder: data }, 201);
});

/* ── GET /api/scm/dp-orders — list ────────────────────────────────────────── */
dpOrders.get('/', async (c) => {
  const sb = c.get('supabase');
  const status = c.req.query('status');
  let q = sb.from('dp_orders').select('*').order('created_at', { ascending: false }).limit(500);
  if (status) q = q.eq('status', status);
  const companyId = activeCompanyId(c);
  if (companyId != null) q = q.eq('company_id', companyId);
  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ dpOrders: data ?? [] });
});

/* ── PATCH /api/scm/dp-orders/:id — edit an unscheduled job ────────────────────
   Only while PENDING_SCHEDULE: once a DP number is minted and the job sits on a
   trip, its details are on a manifest a driver may already be holding — changing
   them silently is the "silent date change" the spec forbids. Cancel and raise a
   new one instead. */
const patchSchema = z.object({
  partyName: z.string().nullable().optional(),
  contactName: z.string().nullable().optional(),
  contactPhone: z.string().nullable().optional(),
  address1: z.string().nullable().optional(),
  address2: z.string().nullable().optional(),
  address3: z.string().nullable().optional(),
  address4: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  postcode: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  requestedDate: z.string().nullable().optional(),
  remark: z.string().nullable().optional(),
});

const PATCH_COLS: Record<keyof z.infer<typeof patchSchema>, string> = {
  partyName: 'party_name', contactName: 'contact_name', contactPhone: 'contact_phone',
  address1: 'address1', address2: 'address2', address3: 'address3', address4: 'address4',
  city: 'city', postcode: 'postcode', state: 'state',
  requestedDate: 'requested_date', remark: 'remark',
};

dpOrders.patch('/:id', async (c) => {
  const id = c.req.param('id');
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', reason: parsed.error.message }, 400);

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const [k, col] of Object.entries(PATCH_COLS)) {
    const v = (parsed.data as Record<string, unknown>)[k];
    if (v !== undefined) updates[col] = v;
  }
  if (Object.keys(updates).length === 1) return c.json({ error: 'no_changes' }, 400);

  const sb = c.get('supabase');
  const { data, error } = await sb.from('dp_orders')
    .update(updates)
    .eq('id', id).eq('status', 'PENDING_SCHEDULE')
    .select('*').maybeSingle();
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  if (!data) {
    return c.json({ error: 'not_editable', message: 'Only a job that is still pending schedule can be edited. Cancel it and raise a new one.' }, 409);
  }
  return c.json({ dpOrder: data });
});

/* ── POST /api/scm/dp-orders/:id/cancel — cancel a job ─────────────────────────
   Cancelling a SCHEDULED job also removes its trip_stop: leaving the stop behind
   would keep a cancelled job on the driver's route, which is the worst possible
   place to discover it. Reported if that removal fails — never silently. */
dpOrders.post('/:id/cancel', async (c) => {
  const id = c.req.param('id');
  const sb = c.get('supabase');

  const { data, error } = await sb.from('dp_orders')
    .update({ status: 'CANCELLED', updated_at: new Date().toISOString() })
    .eq('id', id).neq('status', 'CANCELLED')
    .select('*').maybeSingle();
  if (error) return c.json({ error: 'cancel_failed', reason: error.message }, 500);
  if (!data) return c.json({ error: 'not_found_or_already_cancelled' }, 409);

  let stopRemoved: { removed: boolean; failed: boolean; reason?: string } = { removed: false, failed: false };
  const stopId = (data as { trip_stop_id?: string | null }).trip_stop_id ?? null;
  if (stopId) {
    try {
      const del = await sb.from('trip_stops').delete().eq('id', stopId);
      stopRemoved = del.error
        ? { removed: false, failed: true, reason: del.error.message }
        : { removed: true, failed: false };
    } catch (e) {
      stopRemoved = { removed: false, failed: true, reason: String((e as Error)?.message ?? e).slice(0, 140) };
    }
  }
  return c.json({ dpOrder: data, stopRemoved });
});

const scheduleSchema = z.object({
  lorryId: z.string().uuid(),
  tripDate: z.string(), // YYYY-MM-DD
  tripId: z.string().uuid().optional(),
});

/* ── POST /api/scm/dp-orders/:id/schedule — assign lorry+date, MINT the DP no ─ */
dpOrders.post('/:id/schedule', async (c) => {
  const id = c.req.param('id');
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = scheduleSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', reason: parsed.error.message }, 400);
  const p = parsed.data;
  const sb = c.get('supabase');

  const lorry = await sb.from('lorries').select('plate').eq('id', p.lorryId).maybeSingle();
  const plate = (lorry.data as { plate?: string } | null)?.plate;
  if (!plate) return c.json({ error: 'lorry_not_found' }, 404);

  // Existing DP numbers for this day+plate — the minter filters by the exact
  // prefix, so reading the day's numbers is enough. max+1, never count+1.
  const prefix = `DP-${p.tripDate.slice(2, 4)}${p.tripDate.slice(5, 7)}${p.tripDate.slice(8, 10)}-`;
  const existing = await sb.from('dp_orders').select('dp_no').like('dp_no', `${prefix}%`);
  const existingNos = ((existing.data ?? []) as Array<{ dp_no?: string }>)
    .map((r) => r.dp_no).filter((x): x is string => typeof x === 'string');
  const dpNo = mintDpNo(p.tripDate, plate, existingNos);

  const { data, error } = await sb.from('dp_orders')
    .update({ dp_no: dpNo, trip_id: p.tripId ?? null, status: 'SCHEDULED', updated_at: new Date().toISOString() })
    .eq('id', id).eq('status', 'PENDING_SCHEDULE') // claim: only schedule an unscheduled one
    .select('*').maybeSingle();
  if (error) return c.json({ error: 'schedule_failed', reason: error.message }, 500);
  if (!data) return c.json({ error: 'not_pending', reason: 'DP order is not pending schedule (already scheduled or gone)' }, 409);

  /* Put the DP order ONTO the trip as a stop, so it flows into the trip view and
     the route optimiser. job_type IS a scm.trip_stop_type (SUPPLIER_PICKUP was
     added in 0128), so it maps straight through. The structured address is
     flattened to the stop's single `address` line — the form the optimiser
     geocodes. Only when a trip was named; a header-only schedule (dp_no minted,
     no trip) is valid too.

     Best-effort like the board's scheduleOntoTrip — the schedule already
     committed — but the outcome is REPORTED (tripStop.failed), never a silent
     null, per the #720 lesson. */
  let tripStop: { id: string | null; failed: boolean; reason?: string } = { id: null, failed: false };
  if (p.tripId) {
    try {
      const d = data as Record<string, unknown>;
      const stops = await sb.from('trip_stops').select('stop_no').eq('trip_id', p.tripId);
      const nextStopNo = ((stops.data ?? []) as Array<{ stop_no?: number }>)
        .reduce((m, r) => Math.max(m, Number(r.stop_no ?? 0)), 0) + 1;
      const address = [d.address1, d.address2, d.address3, d.address4, d.city, d.postcode, d.state]
        .filter(Boolean).join(', ') || null;
      const ins = await sb.from('trip_stops').insert({
        company_id: activeCompanyId(c) ?? null,
        trip_id: p.tripId,
        stop_no: nextStopNo,
        stop_type: d.job_type,
        customer_name: (d.party_name as string | null) ?? null,
        address,
        revenue_centi: 0,
      }).select('id').maybeSingle();
      const stopId = (ins.data as { id?: string } | null)?.id ?? null;
      if (ins.error || !stopId) {
        tripStop = { id: null, failed: true, reason: ins.error?.message ?? 'trip_stop insert returned no row' };
      } else {
        await sb.from('dp_orders').update({ trip_stop_id: stopId }).eq('id', id);
        tripStop = { id: stopId, failed: false };
      }
    } catch (e) {
      tripStop = { id: null, failed: true, reason: `trip_stop wiring failed: ${String((e as Error)?.message ?? e).slice(0, 140)}` };
    }
  }
  return c.json({ dpOrder: data, dp_no: dpNo, tripStop });
});

export default dpOrders;
