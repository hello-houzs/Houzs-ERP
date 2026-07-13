// ----------------------------------------------------------------------------
// /pos-cart — the salesperson's live in-progress POS cart (ported from 2990's,
// issue #385). Company-scoped for the Houzs merged backend (company_2 = 2990).
//
// Chairman 2026-05-31 (2990's): the in-progress cart moves from POS localStorage
// to the DB (scm.pos_carts) so it (a) follows the salesperson across devices and
// (b) does NOT bleed to the next person on a shared tablet — it is loaded by the
// logged-in identity, not by device storage. A saved/finalized cart already
// persists as a quote or order; this is only the live working cart.
//
//   GET /pos-cart   — the caller's cart ({ lines, sourceQuoteId } or empty)
//   PUT /pos-cart   — upsert the caller's cart (debounced write-through)
//
// Company scoping (Houzs merge): GET filters via scopeToCompany and PUT stamps
// company_id = activeCompanyId(c) (= 2 for the 2990 POS). See migration
// 0100_pos_cart.sql (adds scm.pos_carts.company_id) and scm/lib/companyScope.ts.
//
// ⚠️ IDENTITY (Houzs bridge limitation): inside /api/scm/* the scm auth bridge
// (scm/middleware/auth.ts) pins EVERY caller's `user.id` to one seeded system
// staff uuid — the per-user scm.staff identity is not yet bridged (houzsUser.id
// is an INTEGER and staff_id is a uuid column, so it can't key this table
// as-is). We therefore key by `user.id` to stay faithful to the 2990 contract
// and the imported uuid PK. /api/scm/* is owner-gated today, so this is
// acceptable for the port; true per-salesperson carts land with the 2990 POS
// auth bridge (which will supply each caller's real scm.staff uuid). See
// MEMORY "SCM staff-UUID bigint trap".
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import { activeCompanyId, scopeToCompany } from '../lib/companyScope';
import type { Env, Variables } from '../env';

export const posCart = new Hono<{ Bindings: Env; Variables: Variables }>();

posCart.use('*', supabaseAuth);

type Row = {
  staff_id: string;
  lines: unknown[];
  source_quote_id: string | null;
  updated_at: string;
};

// ── GET / ──────────────────────────────────────────────────────────────
// The caller's single cart row (empty cart if none yet).
posCart.get('/', async (c) => {
  const supabase = c.get('supabase');
  const userId = c.get('user').id;
  const { data, error } = await scopeToCompany(
    supabase
      .from('pos_carts')
      .select('staff_id, lines, source_quote_id, updated_at')
      .eq('staff_id', userId),
    c,
  ).maybeSingle();

  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if (!data) return c.json({ lines: [], sourceQuoteId: null });
  const r = data as unknown as Row;
  return c.json({ lines: r.lines ?? [], sourceQuoteId: r.source_quote_id, updatedAt: r.updated_at });
});

// ── PUT / ──────────────────────────────────────────────────────────────
// Upsert the caller's single cart row. body: { lines: CartLine[], sourceQuoteId?: string|null }.
posCart.put('/', async (c) => {
  let body: { lines?: unknown; sourceQuoteId?: string | null };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  if (!Array.isArray(body.lines)) return c.json({ error: 'lines_required' }, 400);

  const supabase = c.get('supabase');
  const userId = c.get('user').id;

  const { error } = await supabase.from('pos_carts').upsert(
    {
      staff_id: userId,
      lines: body.lines,
      source_quote_id: body.sourceQuoteId ?? null,
      updated_at: new Date().toISOString(),
      // company_2 = 2990 in the POS context; no-op (undefined) pre-activation.
      company_id: activeCompanyId(c),
    },
    { onConflict: 'staff_id' },
  );

  if (error) {
    if (error.code === '42501' || /permission denied/i.test(error.message)) {
      return c.json({ error: 'forbidden', reason: error.message }, 403);
    }
    return c.json({ error: 'save_failed', reason: error.message }, 500);
  }
  return c.body(null, 204);
});
