// ----------------------------------------------------------------------------
// /quotes — saved POS quotes (port of 2990 apps/api/src/routes/quotes.ts, #386).
//
// A quote is a saved cart, NOT yet promoted to an order. "Open" = not yet
// promoted (promoted_to_order_id IS NULL).
//
//   GET    /quotes       — list open quotes (company-scoped)
//   POST   /quotes       — save the current cart as a quote
//   PATCH  /quotes/:id   — update an OPEN quote's cart in place
//   DELETE /quotes/:id   — delete a quote
//
// Houzs port notes (mirror sofa-quick-picks.ts + the companyScope helpers):
//   * `supabaseAuth` attaches the scm-scoped service-role client (c.get('supabase'))
//     whose `.from('quotes')` resolves to scm.quotes (db.schema='scm').
//   * created_by = the caller's REAL scm.staff uuid via resolveCallerStaffId
//     (mig-0066 staff.user_id link). NOT `c.get('user').id` — the scm auth
//     bridge pins that to one shared system staff row, so every quote was
//     stamped "system" and the list could not answer WHO quoted this customer.
//     An unresolvable caller degrades to the pinned row (attribution is lost,
//     but the quote still saves) — created_by is NOT NULL and nothing gates on
//     it, so this cannot leak a cart the way pos-cart's shared key did.
//   * EVERY query is company_2-scoped: scopeToCompany on read/update/delete,
//     stampCompany (via activeCompanyId) on insert. No-op only when the active
//     company is unresolved (pre-migration / cold-start), keeping single-company
//     Houzs working unchanged.
//   * 2990's showroom resolution (staff.showroom_id + elevated-role fallback) is
//     POS-staff-specific and does not translate to the Houzs system-staff bridge;
//     showroom_id is left NULL (the column stays in the wire shape). company_id
//     scoping replaces showroom-based isolation.
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import type { Env, Variables } from '../env';
import { supabaseAuth } from '../middleware/auth';
import { activeCompanyId, scopeToCompany } from '../lib/companyScope';
import { resolveCallerStaffId } from '../lib/salesScope';

export const quotes = new Hono<{ Bindings: Env; Variables: Variables }>();

quotes.use('*', supabaseAuth);

const QUOTE_PRICING_VERSION = 'v1';

const QUOTE_COLUMNS =
  'id, created_by, showroom_id, customer_name, customer_phone, customer_email, cart, addons, subtotal, addon_total, total, pricing_version, expires_at, promoted_to_order_id, created_at, updated_at';

// GET /quotes — list open quotes (company-scoped). "Open" = not yet promoted.
quotes.get('/', async (c) => {
  const supabase = c.get('supabase');
  const { data, error } = await scopeToCompany(
    supabase.from('quotes').select(QUOTE_COLUMNS).is('promoted_to_order_id', null),
    c,
  )
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) {
    return c.json({ error: 'db_fetch_failed', detail: error.message }, 500);
  }
  return c.json({ quotes: data ?? [] });
});

// POST /quotes — save the current cart as a quote. id is generated server-side
// (TEXT PK, no default), mirroring 2990.
quotes.post('/', async (c) => {
  const supabase = c.get('supabase');
  // Real per-salesperson attribution; the pinned system row is the last resort
  // (see the created_by note in the header).
  const userId =
    (await resolveCallerStaffId(supabase, c.get('houzsUser')?.id)) ?? c.get('user').id;

  // scm.quotes.company_id is NOT NULL with NO default (mig 0101, created after the
  // 0091 default backfill), so an insert with an unresolved company_id (Hyperdrive
  // cold-start negative-cache, up to 30s) would 500 on the NOT NULL constraint.
  // Guard up front with a clean 409 — mirrors sales-analysis.ts PUT /targets.
  if (activeCompanyId(c) == null) {
    return c.json({ error: 'company_unresolved' }, 409);
  }

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const customerName = String(body?.customerName ?? '').trim();
  const customerPhone = body?.customerPhone ? String(body.customerPhone).trim() : null;
  const customerEmail = body?.customerEmail ? String(body.customerEmail).trim() : null;
  const cart = body?.cart ?? body?.lines;
  const subtotal = Number(body?.subtotal);
  const total = Number(body?.total);

  if (!customerName) return c.json({ error: 'missing_customer_name' }, 400);
  if (!Array.isArray(cart) || cart.length === 0) {
    return c.json({ error: 'missing_cart' }, 400);
  }
  if (!Number.isFinite(subtotal) || subtotal < 0) {
    return c.json({ error: 'invalid_subtotal' }, 400);
  }
  if (!Number.isFinite(total) || total < 0) {
    return c.json({ error: 'invalid_total' }, 400);
  }

  const id = `QU-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

  const { data, error } = await supabase
    .from('quotes')
    .insert({
      id,
      company_id: activeCompanyId(c),
      created_by: userId,
      customer_name: customerName,
      customer_phone: customerPhone,
      customer_email: customerEmail,
      cart,
      addons: [],
      subtotal: Math.round(subtotal),
      addon_total: 0,
      total: Math.round(total),
      pricing_version: QUOTE_PRICING_VERSION,
    })
    .select('id, customer_name, total, created_at')
    .maybeSingle();

  if (error) {
    return c.json({ error: 'db_insert_failed', detail: error.message }, 500);
  }
  return c.json({ quote: data }, 201);
});

// PATCH /quotes/:id — update an OPEN quote's cart in place (company-scoped).
// Customer name/phone are intentionally left untouched (the cart is what changes).
quotes.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const supabase = c.get('supabase');

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const cart = body?.cart ?? body?.lines;
  const subtotal = Number(body?.subtotal);
  const total = Number(body?.total);
  if (!Array.isArray(cart) || cart.length === 0) {
    return c.json({ error: 'missing_cart' }, 400);
  }
  if (!Number.isFinite(subtotal) || subtotal < 0) {
    return c.json({ error: 'invalid_subtotal' }, 400);
  }
  if (!Number.isFinite(total) || total < 0) {
    return c.json({ error: 'invalid_total' }, 400);
  }

  const { data, error } = await scopeToCompany(
    supabase
      .from('quotes')
      .update({
        cart,
        subtotal: Math.round(subtotal),
        total: Math.round(total),
      })
      .eq('id', id)
      .is('promoted_to_order_id', null), // never edit an already-converted quote
    c,
  )
    .select('id, customer_name, total, updated_at')
    .maybeSingle();

  if (error) {
    return c.json({ error: 'db_update_failed', detail: error.message }, 500);
  }
  if (!data) {
    // Missing, wrong company, or already promoted to an order.
    return c.json({ error: 'not_found_or_converted' }, 404);
  }
  return c.json({ quote: data });
});

// DELETE /quotes/:id — delete a quote (company-scoped).
quotes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const supabase = c.get('supabase');
  const { error } = await scopeToCompany(
    supabase.from('quotes').delete().eq('id', id),
    c,
  );
  if (error) {
    return c.json({ error: 'db_delete_failed', detail: error.message }, 500);
  }
  return c.json({ ok: true });
});
