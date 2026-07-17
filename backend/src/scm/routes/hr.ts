// ----------------------------------------------------------------------------
// /hr — HR / Commission module. Port of 2990 apps/api/src/routes/hr.ts.
//
// This is the module that decides whether 2990's apps/api can be switched off:
// it is the only place anyone's commission is calculated. The MATH is not here —
// it lives in ../shared/hr-commission (byte-identical to 2990's) and
// ../lib/kpi-units. This file is I/O, authorization and company scope only.
//
// Endpoints (12, 1:1 with 2990):
//   GET    /config            PATCH  /config
//   GET    /profiles          POST   /profiles
//   PATCH  /profiles/:id      DELETE /profiles/:id
//   GET    /item-kpi          POST   /item-kpi
//   PATCH  /item-kpi/:id      DELETE /item-kpi/:id
//   GET    /pickers           GET    /commission
//
// ── AUTHORIZATION (why these keys) ──────────────────────────────────────────
// 2990 gates on scm.staff.role: mutations = admin|super_admin, reads = those
// plus sales_director. Those gates are DEAD under the Houzs bridge — it pins
// every /api/scm/* caller to ONE system scm.staff super_admin row, so a
// role check here would pass for literally everyone. So we gate the REAL caller
// (houzsUser) on two NEW flat keys:
//
//   scm.hr.read   — GET config / profiles / item-kpi / pickers / commission
//   scm.hr.manage — every write (rates, profiles, item-KPI flags)
//
// The read/write SPLIT is 2990's own (sales_director may see the numbers but not
// change the rates); the keys are new because no existing Houzs key means this.
// Deliberately NOT reused:
//   · scm.access — the coarse SCM umbrella. index.ts's own header warns
//     "READ-ONLY IS NOT THE SAME AS SAFE" about exactly this mistake: reports
//     rode the umbrella and shipped every salesperson's cost + margin to any
//     Sales Executive. /commission returns every colleague's SALARY. It is the
//     most sensitive read in the SCM surface and needs its own key.
//   · canViewScmFinance — that gate answers "may this caller see cost/margin on
//     a DOCUMENT". Payroll is a different question about different data, and
//     silently borrowing it would mean any future change to the finance tier
//     quietly re-permissions salaries.
//   · scm.so.view_all — orthogonal (whose ORDERS you may see, not whose PAY).
// Owner + IT Admin hold both new keys via the `*` wildcard, so the module is
// reachable on day one; every other position is granted explicitly via
// Team > Positions. That means it fails CLOSED for everyone else by default,
// which for payroll is the right default.
//
// ── COMPANY SCOPE ───────────────────────────────────────────────────────────
// Houzs runs both companies' books in ONE database. Every read and every write
// here is company-scoped, and the active company must RESOLVE: a commission
// figure computed against an unknown company is a guess, and this is payroll.
// So unlike the rest of SCM (which degrades to "no predicate" when the company
// context is unresolved — see lib/companyScope.ts), HR REFUSES. Migration 0123
// seeds one config row per company, so a resolved company always has an answer.
//
// ── MISSING DATA IS AN ERROR, NOT A ZERO ────────────────────────────────────
// There is no `?? 0` on any money or rate path here. A missing config row, an
// unresolved company or a failed read returns an explicit error. RM 0 is a
// legitimate commission (sold nothing); it must never also be how the module
// says "I don't know".
// ----------------------------------------------------------------------------

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
  computeShowroomCommission,
  kpiFlagFiresOnUnit,
  unitKpiCenti,
  unitKpiExcludedCenti,
  type CommissionConfig,
  type SalespersonInput,
} from '../shared/hr-commission';
import { loadKpiUnitsByDoc } from '../lib/kpi-units';
import { supabaseAuth } from '../middleware/auth';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { activeCompanyId } from '../lib/companyScope';
import { resolveCallerStaffId } from '../lib/salesScope';
import { chunkIn, paginateAll } from '../lib/paginate-all';
import type { Env, Variables } from '../env';

export const hr = new Hono<{ Bindings: Env; Variables: Variables }>();

hr.use('*', supabaseAuth);

type HrContext = Context<{ Bindings: Env; Variables: Variables }>;

const HR_READ = 'scm.hr.read';
const HR_MANAGE = 'scm.hr.manage';

const forbidden = (c: HrContext, perm: string) =>
  c.json({ error: 'forbidden', reason: `missing ${perm}` }, 403);

/* The active company, or a refusal. See COMPANY SCOPE above — HR does not
   degrade to unscoped like the rest of SCM. 503 (not 500): the usual cause is a
   Hyperdrive/companies-master cold start, which self-heals on retry. */
function requireCompany(c: HrContext): { ok: true; companyId: number } | { ok: false; res: Response } {
  const id = activeCompanyId(c);
  if (id == null || !Number.isFinite(Number(id))) {
    return {
      ok: false,
      res: c.json(
        { error: 'company_unresolved', reason: 'The active company could not be determined, so commission cannot be calculated. Please retry in a moment.' },
        503,
      ),
    };
  }
  return { ok: true, companyId: Number(id) };
}

const issues = (e: z.ZodError) => e.issues.map((i) => ({ path: i.path, message: i.message }));

// ── config ───────────────────────────────────────────────────────────────
const CONFIG_SELECT =
  'base_bps, personal_kpi_threshold_centi, personal_kpi_bonus_bps, showroom_kpi_threshold_centi, showroom_kpi_bonus_bps, override_base_bps, override_kpi_bonus_bps, updated_at';

type ConfigRow = {
  base_bps: number;
  personal_kpi_threshold_centi: number;
  personal_kpi_bonus_bps: number;
  showroom_kpi_threshold_centi: number;
  showroom_kpi_bonus_bps: number;
  override_base_bps: number;
  override_kpi_bonus_bps: number;
  updated_at?: string;
};

const toConfigApi = (r: ConfigRow) => ({
  baseBps: r.base_bps,
  personalKpiThresholdCenti: r.personal_kpi_threshold_centi,
  personalKpiBonusBps: r.personal_kpi_bonus_bps,
  showroomKpiThresholdCenti: r.showroom_kpi_threshold_centi,
  showroomKpiBonusBps: r.showroom_kpi_bonus_bps,
  overrideBaseBps: r.override_base_bps,
  overrideKpiBonusBps: r.override_kpi_bonus_bps,
  updatedAt: r.updated_at,
});

const toConfig = (r: ConfigRow): CommissionConfig => ({
  baseBps: r.base_bps,
  personalKpiThresholdCenti: r.personal_kpi_threshold_centi,
  personalKpiBonusBps: r.personal_kpi_bonus_bps,
  showroomKpiThresholdCenti: r.showroom_kpi_threshold_centi,
  showroomKpiBonusBps: r.showroom_kpi_bonus_bps,
  overrideBaseBps: r.override_base_bps,
  overrideKpiBonusBps: r.override_kpi_bonus_bps,
});

/* Load THIS company's config row. 2990 keys the singleton `.eq('id', 1)`;
   Houzs keys on company_id (migration 0123 retired the singleton, because a
   HOUZS-stamped row is invisible to a 2990-scoped read — and an invisible
   config must not become a 0% rate). A missing row is an explicit error: the
   module cannot honestly compute anything without it. */
async function loadConfigRow(
  c: HrContext,
  companyId: number,
): Promise<{ ok: true; row: ConfigRow } | { ok: false; res: Response }> {
  const sb = c.get('supabase');
  const { data, error } = await sb
    .from('hr_commission_config')
    .select(CONFIG_SELECT)
    .eq('company_id', companyId)
    .maybeSingle();
  if (error) return { ok: false, res: c.json({ error: 'fetch_failed', reason: error.message }, 500) };
  if (!data) {
    return {
      ok: false,
      res: c.json(
        { error: 'config_missing', reason: 'No commission rate settings exist for this company yet, so no commission can be calculated. Set the rates in HR Settings first.' },
        409,
      ),
    };
  }
  return { ok: true, row: data as ConfigRow };
}

hr.get('/config', async (c) => {
  if (!hasHouzsPerm(c, HR_READ)) return forbidden(c, HR_READ);
  const co = requireCompany(c);
  if (!co.ok) return co.res;
  const cfg = await loadConfigRow(c, co.companyId);
  if (!cfg.ok) return cfg.res;
  return c.json({ config: toConfigApi(cfg.row) });
});

const configPatchSchema = z.object({
  baseBps: z.number().int().nonnegative().optional(),
  personalKpiThresholdCenti: z.number().int().nonnegative().optional(),
  personalKpiBonusBps: z.number().int().nonnegative().optional(),
  showroomKpiThresholdCenti: z.number().int().nonnegative().optional(),
  showroomKpiBonusBps: z.number().int().nonnegative().optional(),
  overrideBaseBps: z.number().int().nonnegative().optional(),
  overrideKpiBonusBps: z.number().int().nonnegative().optional(),
});

hr.patch('/config', async (c) => {
  if (!hasHouzsPerm(c, HR_MANAGE)) return forbidden(c, HR_MANAGE);
  const co = requireCompany(c);
  if (!co.ok) return co.res;
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = configPatchSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'validation_failed', issues: issues(parsed.error) }, 400);

  const sb = c.get('supabase');
  /* 2990 stamps updated_by with the Supabase auth uid, which IS its staff id.
     In Houzs the real caller is a public.users INTEGER (houzsUser.id) and the
     column is uuid, so we map through the mig-0066 staff link. Not c.get('user')
     .id — that is the bridge's pinned system row, and attributing every rate
     change on a PAYROLL table to "system" is an audit lie. null when the caller
     has no staff row: unattributed is honest, wrongly-attributed is not. */
  const patch: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    updated_by: await resolveCallerStaffId(sb, c.get('houzsUser')?.id),
  };
  const d = parsed.data;
  if (d.baseBps !== undefined) patch.base_bps = d.baseBps;
  if (d.personalKpiThresholdCenti !== undefined) patch.personal_kpi_threshold_centi = d.personalKpiThresholdCenti;
  if (d.personalKpiBonusBps !== undefined) patch.personal_kpi_bonus_bps = d.personalKpiBonusBps;
  if (d.showroomKpiThresholdCenti !== undefined) patch.showroom_kpi_threshold_centi = d.showroomKpiThresholdCenti;
  if (d.showroomKpiBonusBps !== undefined) patch.showroom_kpi_bonus_bps = d.showroomKpiBonusBps;
  if (d.overrideBaseBps !== undefined) patch.override_base_bps = d.overrideBaseBps;
  if (d.overrideKpiBonusBps !== undefined) patch.override_kpi_bonus_bps = d.overrideKpiBonusBps;

  const { data, error } = await sb
    .from('hr_commission_config')
    .update(patch)
    .eq('company_id', co.companyId)
    .select(CONFIG_SELECT)
    .maybeSingle();
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  if (!data) return c.json({ error: 'config_missing', reason: 'No commission rate settings exist for this company yet.' }, 409);
  return c.json({ config: toConfigApi(data as ConfigRow) });
});

// ── salesperson profiles ───────────────────────────────────────────────────
const PROFILE_SELECT = 'id, staff_id, tier, showroom_id, active, created_at, updated_at';

type ProfileRow = {
  id: string; staff_id: string; tier: string; showroom_id: string; active: boolean;
  created_at: string; updated_at: string;
};

type StaffLite = { name: string; staffCode: string };

/* Staff labels for a set of profiles.
 *
 * 2990 pulls these with a PostgREST embed (`staff:staff(name, staff_code)`).
 * Not ported, for two reasons:
 *   · an embed needs PostgREST to KNOW the hr_salesperson_profiles.staff_id ->
 *     staff.id FK from its schema cache. These tables were applied out-of-band
 *     and migration 0123 may be the thing that creates them, in which case the
 *     cache is stale until a reload — the embed would 400 while a plain read
 *     works fine. Payroll should not depend on the cache being warm.
 *   · supabase-js types a to-one embed as an ARRAY without generated DB types;
 *     2990 hides that with `data as ProfileRow[]`, which is a cast over a shape
 *     the compiler actively disagrees with.
 * A keyed lookup is one extra query on a table with a handful of rows. */
async function loadStaffLite(sb: any, staffIds: string[]): Promise<{ data: Map<string, StaffLite>; error: { message: string } | null }> {
  const ids = [...new Set(staffIds.filter(Boolean))];
  if (ids.length === 0) return { data: new Map(), error: null };
  const res = await chunkIn<{ id: string; name: string | null; staff_code: string | null }>(
    ids,
    (batch, from, to) => sb.from('staff').select('id, name, staff_code').in('id', batch).order('id').range(from, to),
  );
  if (res.error) return { data: new Map(), error: res.error };
  return {
    data: new Map(res.data.map((s) => [s.id, { name: s.name ?? '', staffCode: s.staff_code ?? '' }])),
    error: null,
  };
}

const toProfileApi = (r: ProfileRow, staff: Map<string, StaffLite>) => ({
  id: r.id,
  staffId: r.staff_id,
  staffName: staff.get(r.staff_id)?.name ?? '',
  staffCode: staff.get(r.staff_id)?.staffCode ?? '',
  tier: r.tier,
  showroomId: r.showroom_id,
  active: r.active,
});

hr.get('/profiles', async (c) => {
  if (!hasHouzsPerm(c, HR_READ)) return forbidden(c, HR_READ);
  const co = requireCompany(c);
  if (!co.ok) return co.res;
  const sb = c.get('supabase');
  const { data, error } = await paginateAll<ProfileRow>((from, to) => sb
    .from('hr_salesperson_profiles')
    .select(PROFILE_SELECT)
    .eq('company_id', co.companyId)
    .order('created_at', { ascending: true })
    .range(from, to),
  );
  if (error) return c.json({ error: 'fetch_failed', reason: error.message }, 500);
  const rows = data ?? [];
  const staff = await loadStaffLite(sb, rows.map((r) => r.staff_id));
  if (staff.error) return c.json({ error: 'fetch_failed', reason: staff.error.message }, 500);
  return c.json({ profiles: rows.map((r) => toProfileApi(r, staff.data)) });
});

const profileCreateSchema = z.object({
  staffId: z.string().uuid(),
  tier: z.enum(['sales', 'manager']),
  showroomId: z.string().uuid(),
  active: z.boolean().default(true),
});

hr.post('/profiles', async (c) => {
  if (!hasHouzsPerm(c, HR_MANAGE)) return forbidden(c, HR_MANAGE);
  const co = requireCompany(c);
  if (!co.ok) return co.res;
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = profileCreateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'validation_failed', issues: issues(parsed.error) }, 400);
  const sb = c.get('supabase');
  const { data, error } = await sb
    .from('hr_salesperson_profiles')
    .insert({
      staff_id: parsed.data.staffId,
      tier: parsed.data.tier,
      showroom_id: parsed.data.showroomId,
      active: parsed.data.active,
      company_id: co.companyId,
    })
    .select(PROFILE_SELECT)
    .single();
  if (error) {
    // 23505 is now the COMPOSITE (company_id, staff_id) key — migration 0089
    // converted 2990's bare UNIQUE(staff_id) so both companies can profile the
    // same shared staff row (scm.staff is deliberately not company-scoped).
    if (error.code === '23505') return c.json({ error: 'duplicate_staff', reason: 'this staff already has an HR profile in this company' }, 409);
    return c.json({ error: 'create_failed', reason: error.message }, 500);
  }
  const row = data as ProfileRow;
  const staff = await loadStaffLite(sb, [row.staff_id]);
  if (staff.error) return c.json({ error: 'fetch_failed', reason: staff.error.message }, 500);
  return c.json({ profile: toProfileApi(row, staff.data) }, 201);
});

const profilePatchSchema = z.object({
  tier: z.enum(['sales', 'manager']).optional(),
  showroomId: z.string().uuid().optional(),
  active: z.boolean().optional(),
});

hr.patch('/profiles/:id', async (c) => {
  if (!hasHouzsPerm(c, HR_MANAGE)) return forbidden(c, HR_MANAGE);
  const co = requireCompany(c);
  if (!co.ok) return co.res;
  const id = c.req.param('id');
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = profilePatchSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'validation_failed', issues: issues(parsed.error) }, 400);
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (parsed.data.tier !== undefined) patch.tier = parsed.data.tier;
  if (parsed.data.showroomId !== undefined) patch.showroom_id = parsed.data.showroomId;
  if (parsed.data.active !== undefined) patch.active = parsed.data.active;
  const sb = c.get('supabase');
  // company_id on the WHERE, not just the read: an id alone would let one
  // company edit the other's profile (404 is also what a wrong-company id
  // should look like).
  const { data, error } = await sb
    .from('hr_salesperson_profiles')
    .update(patch)
    .eq('id', id)
    .eq('company_id', co.companyId)
    .select(PROFILE_SELECT)
    .maybeSingle();
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  if (!data) return c.json({ error: 'not_found' }, 404);
  const row = data as ProfileRow;
  const staff = await loadStaffLite(sb, [row.staff_id]);
  if (staff.error) return c.json({ error: 'fetch_failed', reason: staff.error.message }, 500);
  return c.json({ profile: toProfileApi(row, staff.data) });
});

hr.delete('/profiles/:id', async (c) => {
  if (!hasHouzsPerm(c, HR_MANAGE)) return forbidden(c, HR_MANAGE);
  const co = requireCompany(c);
  if (!co.ok) return co.res;
  const id = c.req.param('id');
  const sb = c.get('supabase');
  const { error } = await sb
    .from('hr_salesperson_profiles')
    .delete()
    .eq('id', id)
    .eq('company_id', co.companyId);
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);
  return c.json({ ok: true });
});

// ── item KPIs ───────────────────────────────────────────────────────────────
const ITEM_KPI_SELECT = 'id, flag_type, ref, label, bonus_centi, active, created_at, updated_at';

type ItemKpiRow = {
  id: string; flag_type: 'product' | 'fabric' | 'special'; ref: string;
  label: string; bonus_centi: number; active: boolean;
};

const toItemKpiApi = (r: ItemKpiRow) => ({
  id: r.id,
  flagType: r.flag_type,
  ref: r.ref,
  label: r.label,
  bonusCenti: r.bonus_centi,
  active: r.active,
});

hr.get('/item-kpi', async (c) => {
  if (!hasHouzsPerm(c, HR_READ)) return forbidden(c, HR_READ);
  const co = requireCompany(c);
  if (!co.ok) return co.res;
  const sb = c.get('supabase');
  const { data, error } = await paginateAll<ItemKpiRow>((from, to) => sb
    .from('hr_item_kpi')
    .select(ITEM_KPI_SELECT)
    .eq('company_id', co.companyId)
    .order('created_at', { ascending: true })
    .range(from, to),
  );
  if (error) return c.json({ error: 'fetch_failed', reason: error.message }, 500);
  return c.json({ items: (data ?? []).map(toItemKpiApi) });
});

const itemKpiCreateSchema = z.object({
  flagType: z.enum(['product', 'fabric', 'special']),
  ref: z.string().min(1),
  label: z.string().default(''),
  bonusCenti: z.number().int().nonnegative(),
  active: z.boolean().default(true),
});

hr.post('/item-kpi', async (c) => {
  if (!hasHouzsPerm(c, HR_MANAGE)) return forbidden(c, HR_MANAGE);
  const co = requireCompany(c);
  if (!co.ok) return co.res;
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = itemKpiCreateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'validation_failed', issues: issues(parsed.error) }, 400);
  const sb = c.get('supabase');
  const { data, error } = await sb
    .from('hr_item_kpi')
    .insert({
      flag_type: parsed.data.flagType,
      ref: parsed.data.ref,
      label: parsed.data.label,
      bonus_centi: parsed.data.bonusCenti,
      active: parsed.data.active,
      company_id: co.companyId,
    })
    .select(ITEM_KPI_SELECT)
    .single();
  if (error) return c.json({ error: 'create_failed', reason: error.message }, 500);
  return c.json({ item: toItemKpiApi(data as ItemKpiRow) }, 201);
});

const itemKpiPatchSchema = z.object({
  label: z.string().optional(),
  bonusCenti: z.number().int().nonnegative().optional(),
  active: z.boolean().optional(),
});

hr.patch('/item-kpi/:id', async (c) => {
  if (!hasHouzsPerm(c, HR_MANAGE)) return forbidden(c, HR_MANAGE);
  const co = requireCompany(c);
  if (!co.ok) return co.res;
  const id = c.req.param('id');
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = itemKpiPatchSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'validation_failed', issues: issues(parsed.error) }, 400);
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (parsed.data.label !== undefined) patch.label = parsed.data.label;
  if (parsed.data.bonusCenti !== undefined) patch.bonus_centi = parsed.data.bonusCenti;
  if (parsed.data.active !== undefined) patch.active = parsed.data.active;
  const sb = c.get('supabase');
  const { data, error } = await sb
    .from('hr_item_kpi')
    .update(patch)
    .eq('id', id)
    .eq('company_id', co.companyId)
    .select(ITEM_KPI_SELECT)
    .maybeSingle();
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  if (!data) return c.json({ error: 'not_found' }, 404);
  return c.json({ item: toItemKpiApi(data as ItemKpiRow) });
});

hr.delete('/item-kpi/:id', async (c) => {
  if (!hasHouzsPerm(c, HR_MANAGE)) return forbidden(c, HR_MANAGE);
  const co = requireCompany(c);
  if (!co.ok) return co.res;
  const id = c.req.param('id');
  const sb = c.get('supabase');
  const { error } = await sb
    .from('hr_item_kpi')
    .delete()
    .eq('id', id)
    .eq('company_id', co.companyId);
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);
  return c.json({ ok: true });
});

// ── pickers: assignable staff + showrooms + products/fabrics/specials to flag ──
hr.get('/pickers', async (c) => {
  if (!hasHouzsPerm(c, HR_READ)) return forbidden(c, HR_READ);
  const co = requireCompany(c);
  if (!co.ok) return co.res;
  const sb = c.get('supabase');

  /* scm.staff is deliberately NOT company-scoped (0089: "Deliberately NOT
     stamped — staff, currencies, ..."), so the staff picker is unscoped by
     design; every other picker feeds a company-scoped ref and is scoped. */
  const [staffRes, showroomRes, productRes, fabricRes, specialRes] = await Promise.all([
    paginateAll<{ id: string; name: string; staff_code: string; role: string }>((from, to) =>
      sb.from('staff').select('id, name, staff_code, role, active').eq('active', true).order('name').range(from, to)),
    paginateAll<{ id: string; name: string }>((from, to) =>
      sb.from('showrooms').select('id, name').eq('active', true).eq('company_id', co.companyId).order('sort_order').range(from, to)),
    paginateAll<{ code: string; name: string }>((from, to) =>
      sb.from('mfg_products').select('code, name').eq('pos_active', true).eq('company_id', co.companyId).order('code').range(from, to)),
    paginateAll<{ id: string; label: string }>((from, to) =>
      sb.from('fabric_library').select('id, label').eq('company_id', co.companyId).order('label').range(from, to)),
    paginateAll<{ code: string; label: string }>((from, to) =>
      sb.from('special_addons').select('code, label').eq('company_id', co.companyId).order('label').range(from, to)),
  ]);
  const firstErr = staffRes.error || showroomRes.error || productRes.error || fabricRes.error || specialRes.error;
  if (firstErr) return c.json({ error: 'fetch_failed', reason: firstErr.message }, 500);

  return c.json({
    staff: (staffRes.data ?? []).map((s) => ({ id: s.id, name: s.name, staffCode: s.staff_code, role: s.role })),
    showrooms: (showroomRes.data ?? []).map((s) => ({ id: s.id, name: s.name })),
    products: (productRes.data ?? []).map((p) => ({ ref: p.code, label: `${p.code} — ${p.name}` })),
    fabrics: (fabricRes.data ?? []).map((f) => ({ ref: f.id, label: f.label })),
    specials: (specialRes.data ?? []).map((s) => ({ ref: s.code, label: s.label })),
  });
});

// ── commission computation ──────────────────────────────────────────────────
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

type OrderRow = {
  doc_no: string;
  salesperson_id: string | null;
  mattress_sofa_centi: number | null;
  bedframe_centi: number | null;
  accessories_centi: number | null;
  others_centi: number | null;
};

/* Goods that drive commission = the four GOODS category buckets only. Delivery
 * fee + SERVICE-category lines (SVC-DELIVERY* / dispose / lift) live in their own
 * `service_centi` bucket (recomputeTotals routes them there FIRST so they can
 * never leak into goods) and `delivery_fee_centi` is a separate header column —
 * neither is summed here. So delivery + service are ALREADY excluded from both
 * the % commission and the 100k/400k thresholds (Loo 2026-06-20). The item-KPI
 * add-on exclusion below removes the remaining flagged-add-on amounts.
 *
 * The `?? 0` here is 2990's and is CORRECT — these four columns are NOT NULL
 * DEFAULT 0 in the schema, so the coalesce is a type narrowing, not a guess
 * about an unknown. Contrast the config/read paths above, where a missing value
 * genuinely means "unknown" and is an explicit error. */
const goodsOf = (o: OrderRow): number =>
  (o.mattress_sofa_centi ?? 0) + (o.bedframe_centi ?? 0) + (o.accessories_centi ?? 0) + (o.others_centi ?? 0);

// display order within a showroom: managers (tier 2) first, then sales (tier 1).
const TIER_RANK: Record<string, number> = { manager: 0, sales: 1 };

hr.get('/commission', async (c) => {
  if (!hasHouzsPerm(c, HR_READ)) return forbidden(c, HR_READ);
  const co = requireCompany(c);
  if (!co.ok) return co.res;
  const from = (c.req.query('from') ?? '').trim();
  const to = (c.req.query('to') ?? '').trim();
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) return c.json({ error: 'invalid_range', reason: 'from and to must be YYYY-MM-DD' }, 400);
  if (from > to) return c.json({ error: 'invalid_range', reason: 'from must be <= to' }, 400);

  const sb = c.get('supabase');

  // config
  const cfgRes = await loadConfigRow(c, co.companyId);
  if (!cfgRes.ok) return cfgRes.res;
  const config = toConfig(cfgRes.row);

  // active profiles (tier + HR-assigned showroom + staff name for labels).
  // The HR-assigned showroom is the SINGLE source of truth for the showroom
  // dimension: a salesperson's goods, their grouping, and the whole-showroom
  // total all key off the profile, so they can never diverge.
  type ProfRow = { staff_id: string; tier: string; showroom_id: string };
  const profRes = await paginateAll<ProfRow>((f, t) => sb
    .from('hr_salesperson_profiles')
    .select('staff_id, tier, showroom_id')
    .eq('active', true)
    .eq('company_id', co.companyId)
    .order('staff_id')
    .range(f, t),
  );
  if (profRes.error) return c.json({ error: 'profiles_failed', reason: profRes.error.message }, 500);
  const profiles = profRes.data ?? [];
  // Labels via a keyed lookup rather than 2990's embed — see loadStaffLite.
  const staffLite = await loadStaffLite(sb, profiles.map((p) => p.staff_id));
  if (staffLite.error) return c.json({ error: 'profiles_failed', reason: staffLite.error.message }, 500);
  const staffName = new Map<string, string>(profiles.map((p) => [p.staff_id, staffLite.data.get(p.staff_id)?.name ?? '']));

  const showroomRes = await paginateAll<{ id: string; name: string }>((f, t) => sb
    .from('showrooms').select('id, name').eq('company_id', co.companyId).order('id').range(f, t));
  if (showroomRes.error) return c.json({ error: 'showrooms_failed', reason: showroomRes.error.message }, 500);
  const showroomName = new Map<string, string>((showroomRes.data ?? []).map((s) => [s.id, s.name]));

  // orders in range, excluding cancelled/on-hold. Header category columns only.
  const ordRes = await paginateAll<OrderRow>((f, t) => sb
    .from('mfg_sales_orders')
    .select('doc_no, salesperson_id, mattress_sofa_centi, bedframe_centi, accessories_centi, others_centi')
    .gte('so_date', from)
    .lte('so_date', to)
    .not('status', 'in', '(CANCELLED,ON_HOLD)')
    .eq('company_id', co.companyId)
    .order('doc_no')
    .range(f, t),
  );
  if (ordRes.error) return c.json({ error: 'orders_failed', reason: ordRes.error.message }, 500);
  const orders = ordRes.data ?? [];

  const personalGoods = new Map<string, number>(); // salesperson_id → goods centi
  const docToSalesperson = new Map<string, string>();
  for (const o of orders) {
    if (!o.salesperson_id) continue;
    personalGoods.set(o.salesperson_id, (personalGoods.get(o.salesperson_id) ?? 0) + goodsOf(o));
    docToSalesperson.set(o.doc_no, o.salesperson_id);
  }

  // item-KPI — a flagged purchase earns the FIXED bonus INSTEAD of % commission
  // on the flagged add-on, so that amount leaves goods (kpi-units.ts is the
  // single source).
  const itemKpiCenti = new Map<string, number>();       // salesperson_id → fixed bonus centi
  const kpiExcludedGoods = new Map<string, number>();   // salesperson_id → goods to remove
  const kpiDetail = new Map<string, Map<string, { label: string; qty: number; bonusCenti: number; lineCenti: number }>>();
  if (docToSalesperson.size > 0) {
    let kpi;
    try {
      kpi = await loadKpiUnitsByDoc(sb, [...docToSalesperson.keys()], co.companyId);
    } catch (e) {
      // A KPI read failure must NOT fall through to "no flags" — that would pay
      // every bonus as RM 0 and silently stop excluding flagged goods.
      return c.json({ error: 'kpi_failed', reason: e instanceof Error ? e.message : String(e) }, 500);
    }
    const { flags, flagLabel, unitsByDoc } = kpi;
    for (const [docNo, units] of unitsByDoc) {
      const sp = docToSalesperson.get(docNo);
      if (!sp) continue;
      for (const u of units) {
        const bonus = unitKpiCenti(u, flags);
        const excluded = unitKpiExcludedCenti(u, flags);
        if (bonus > 0) itemKpiCenti.set(sp, (itemKpiCenti.get(sp) ?? 0) + bonus);
        if (excluded > 0) kpiExcludedGoods.set(sp, (kpiExcludedGoods.get(sp) ?? 0) + excluded);
        if (bonus <= 0) continue;
        for (const f of flags) {
          if (!kpiFlagFiresOnUnit(f, u)) continue;
          const key = `${f.flagType}:${f.ref}`;
          if (!kpiDetail.has(sp)) kpiDetail.set(sp, new Map());
          const m = kpiDetail.get(sp)!;
          const prev = m.get(key) ?? { label: flagLabel.get(key) ?? f.ref, qty: 0, bonusCenti: f.bonusCenti, lineCenti: 0 };
          prev.qty += u.qty;
          prev.lineCenti += u.qty * f.bonusCenti;
          m.set(key, prev);
        }
      }
    }
  }

  // group profiles by their HR-assigned showroom, then compute. The KPI add-on
  // exclusion is subtracted from each salesperson's goods (clamped ≥ 0): a
  // flagged add-on earns the fixed bonus above instead of % commission, and is
  // dropped from the goods the % rate + the 100k/400k thresholds run on.
  const byShowroom = new Map<string, SalespersonInput[]>();
  for (const p of profiles) {
    const sid = p.showroom_id;
    if (!byShowroom.has(sid)) byShowroom.set(sid, []);
    byShowroom.get(sid)!.push({
      staffId: p.staff_id,
      tier: p.tier as 'sales' | 'manager',
      personalGoodsCenti: Math.max(0, (personalGoods.get(p.staff_id) ?? 0) - (kpiExcludedGoods.get(p.staff_id) ?? 0)),
      itemKpiCenti: itemKpiCenti.get(p.staff_id) ?? 0,
    });
  }

  const showrooms = [...byShowroom.entries()].map(([sid, people]) => {
    // whole-showroom total = sum of this showroom's profiled members' personal
    // goods. Single source of truth: the displayed rows always add up to this
    // figure, and both the 400k gate and the manager override base use it.
    const sg = people.reduce((acc, m) => acc + m.personalGoodsCenti, 0);
    const rows = computeShowroomCommission(config, sg, people).map((r) => ({
      ...r,
      staffName: staffName.get(r.staffId) ?? '',
      kpiDetail: [...(kpiDetail.get(r.staffId)?.values() ?? [])],
    }));
    // managers first, then sales; stable within tier (preserves existing order).
    rows.sort((a, b) => (TIER_RANK[a.tier] ?? 9) - (TIER_RANK[b.tier] ?? 9));
    return {
      showroomId: sid,
      showroomName: showroomName.get(sid) ?? sid,
      showroomGoodsCenti: sg,
      showroomKpiHit: sg >= config.showroomKpiThresholdCenti,
      rows,
    };
  });

  return c.json({ from, to, config: toConfigApi(cfgRes.row), showrooms });
});
