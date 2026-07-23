// ----------------------------------------------------------------------------
// /inventory — trading-company stock model w/ FIFO COGS (PR #37).
//
// Two warehouses (KL + 2990 PJ) by default — CRUD via /inventory/warehouses.
// Balance = SUM(movements) via the inventory_balances VIEW.
// COGS = FIFO consumption of lots, maintained by trg_inventory_movement_fifo.
//
// Endpoints:
//   GET   /inventory/warehouses               — list
//   POST  /inventory/warehouses               — create
//   PATCH /inventory/warehouses/:id           — update / toggle active
//   GET   /inventory                          — balance per (warehouse, product)
//                                                ?category=BEDFRAME&warehouseId&search
//                                                ?showAll=true → LEFT JOIN every SKU
//   GET   /inventory/movements                — ledger (filtered)
//   GET   /inventory/lots/:productCode        — FIFO lots for one product
//   GET   /inventory/batches                  — open lots grouped by (warehouse, batch)
//                                                ?warehouseId&productCode (Stage 2 sofa batch view)
//   GET   /inventory/cogs                     — COGS stream (consumption flat list)
//   GET   /inventory/value                    — inventory valuation (qty × cost)
//
// The manual stock ADJUSTMENT write (POST /inventory/adjustments) lives in its
// own router (routes/inventory-adjustments.ts) so it can be gated on the
// separate `scm.warehouse.adjustments` permission — see that file + scm/index.ts.
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import { escapeForOr } from '../lib/postgrest-search';
import { paginateAll, chunkIn } from '../lib/paginate-all';
import { reconcileLedger } from '../lib/reconcile-ledger';
import {
  activeCompanyId, scopeToCompany,
  requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY,
} from '../lib/companyScope';
import { canonicalizeMyState } from '../lib/canonical-state';
import type { Env, Variables } from '../env';

export const inventory = new Hono<{ Bindings: Env; Variables: Variables }>();
inventory.use('*', supabaseAuth);

/* ── Warehouses CRUD ─────────────────────────────────────────────────── */
inventory.get('/warehouses', async (c) => {
  const sb = c.get('supabase');
  const includeInactive = c.req.query('includeInactive') === 'true';
  let q = scopeToCompany(
    sb.from('warehouses').select('id, code, name, location, state, postcode, city, is_active, is_default, is_showroom, venue_name, type'),
    c,
  ).order('code');
  if (!includeInactive) q = q.eq('is_active', true);
  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ warehouses: data ?? [] });
});

inventory.post('/warehouses', async (c) => {
  const sb = c.get('supabase');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const code = String(body.code ?? '').trim().toUpperCase();
  const name = String(body.name ?? '').trim();
  if (!code) return c.json({ error: 'code_required' }, 400);
  if (!name) return c.json({ error: 'name_required' }, 400);

  /* Company is REQUIRED here, not best-effort. `company_id: activeCompanyId(c)`
     sent `undefined` when unresolved, supabase-js dropped the key, and mig 0091's
     `DEFAULT <HOUZS id>` then stamped the row HOUZS — so a 2990 warehouse could
     be silently filed under Houzs instead of failing. Resolve or refuse. */
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  /* TYPE (mig 0171) — 5-bucket enum on scm.warehouses. Default 'warehouse'
     when unspecified so existing callers that don't know about the field still
     land a valid row. `isShowroom=true` is treated as an implicit type upgrade
     to 'showroom' so the two boolean callers (WarehouseFormDrawer with its old
     checkbox path, plus any programmatic seeder) stay coherent — the invariant
     `is_showroom = (type = 'showroom')` is what the venue-binding resolver
     (mig 0148) reads. */
  const rawType = typeof body.type === 'string' ? body.type.trim().toLowerCase() : '';
  const ALLOWED_TYPES = ['warehouse', 'showroom', 'display', 'service', 'others'] as const;
  const wantType: (typeof ALLOWED_TYPES)[number] | null =
    (ALLOWED_TYPES as readonly string[]).includes(rawType) ? (rawType as (typeof ALLOWED_TYPES)[number]) : null;
  const finalType: (typeof ALLOWED_TYPES)[number] =
    wantType ?? (body.isShowroom === true ? 'showroom' : 'warehouse');
  const finalIsShowroom = finalType === 'showroom' || body.isShowroom === true;

  /* Mig 0180 — structured address. `state` is canonicalized at ingress so
     'PENANG' / 'Kl' land as the canonical my_localities spelling; foreign
     state names (Guangdong etc.) round-trip unchanged. postcode/city are
     plain strings — validation lives in the frontend cascade. */
  const state = canonicalizeMyState((body.state as string | null | undefined) ?? null);
  const postcode = typeof body.postcode === 'string' && body.postcode.trim()
    ? body.postcode.trim() : null;
  const city = typeof body.city === 'string' && body.city.trim()
    ? body.city.trim() : null;

  const { data, error } = await sb.from('warehouses').insert({
    company_id: co.companyId, // multi-company: stamp the active company (mig 0086)
    code, name,
    location: (body.location as string) ?? null,
    state, postcode, city,
    is_active: body.isActive === false ? false : true,
    is_default: body.isDefault === true,
    /* SHOWROOM (migration 0148) — "Mark as Showroom" makes this warehouse a
       venue source: it appears in the Sales Maintenance venue list, and any
       salesperson parked under it on the Members page attributes their orders
       to venue_name. venue_name is NOT derived from `name`: a warehouse is
       named for stock ("KL-WH-02"), a venue for the report ("Kuala Lumpur
       Showroom"), and auto-deriving would put a stock code into exhibition
       P&L. A flagged showroom with no venue_name simply resolves to nothing.
       Mig 0171 keeps is_showroom = (type = 'showroom'). */
    is_showroom: finalIsShowroom,
    venue_name: typeof body.venueName === 'string' && body.venueName.trim()
      ? body.venueName.trim() : null,
    type: finalType,
  }).select('id, code, name, location, state, postcode, city, is_active, is_default, is_showroom, venue_name, type').single();
  if (error) {
    if (error.code === '23505') return c.json({ error: 'duplicate_code' }, 409);
    return c.json({ error: 'insert_failed', reason: error.message }, 500);
  }
  /* Audit 2026-06-20 — enforce a SINGLE default warehouse: clear is_default on
     every other row when this one is set default. Two defaults make
     defaultWarehouseId() (maybeSingle) error → null, breaking the warehouse
     fallback on GRN/DO/return/consignment posts.
     LEAK FIX: scoped to this company. Unscoped, "single default" was enforced
     GLOBALLY, so creating a default warehouse in one company cleared the
     other's. */
  if (body.isDefault === true) {
    await scopeToCompanyId(
      sb.from('warehouses').update({ is_default: false })
        .eq('is_default', true).neq('id', (data as { id: string }).id),
      co.companyId,
    );
  }
  return c.json({ warehouse: data }, 201);
});

/* PATCH /warehouses/:id — update a warehouse, incl. promoting it to default.
 *
 * LEAK FIX (audit item 2), and this one was not hypothetical and needed no
 * id-guessing: it fired on a normal click. The single-default enforcement below
 * ran `UPDATE warehouses SET is_default = false WHERE is_default = true AND id
 * <> $1` with NO company predicate, so setting your own default DEMOTED THE
 * OTHER COMPANY'S DEFAULT. The other company then had no default warehouse, and
 * defaultWarehouseId() (a maybeSingle) started returning null — which is the
 * fallback GRN / DO / return / consignment posts rely on.
 *
 * Scoping the demote alone is not enough: if A could still PATCH B's warehouse
 * by id, A would promote B's row and the now-scoped demote would clear A's own
 * default — strictly worse. So the target row is scoped too.
 *
 * Exported for the route test (see postJournalEntryHandler for why). */
export const patchWarehouseHandler = async (c: any) => {
  const sb = c.get('supabase');
  const id = c.req.param('id');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const updates: Record<string, unknown> = {};
  if (typeof body.code === 'string')      updates.code = body.code.trim().toUpperCase();
  if (typeof body.name === 'string')      updates.name = body.name.trim();
  if (typeof body.location === 'string')  updates.location = body.location;
  /* Mig 0180 — structured address. State canonicalized on the way in. */
  if (body.state !== undefined) {
    updates.state = canonicalizeMyState((body.state as string | null | undefined) ?? null);
  }
  if (body.postcode !== undefined) {
    const p = typeof body.postcode === 'string' ? body.postcode.trim() : '';
    updates.postcode = p || null;
  }
  if (body.city !== undefined) {
    const cc = typeof body.city === 'string' ? body.city.trim() : '';
    updates.city = cc || null;
  }
  if (typeof body.isActive === 'boolean') updates.is_active = body.isActive;
  if (typeof body.isDefault === 'boolean') updates.is_default = body.isDefault;
  /* SHOWROOM (migration 0148) + TYPE (mig 0171). Un-flagging is deliberately
     NOT cascaded to the staff parked under this warehouse: the resolver
     re-checks is_showroom at resolve time, so clearing the flag stops it
     supplying venues immediately while the parkings stay visible on the
     Members page for whoever has to re-home those people. A silent mass-unpark
     would lose that information.

     The `type` and `isShowroom` fields must move together (invariant:
     is_showroom = (type = 'showroom')). If the caller sends either, derive the
     other so the row stays coherent — a caller sending only isShowroom=true
     upgrades type to 'showroom', a caller sending type='warehouse' clears
     is_showroom. */
  const ALLOWED_TYPES = ['warehouse', 'showroom', 'display', 'service', 'others'] as const;
  const rawType = typeof body.type === 'string' ? body.type.trim().toLowerCase() : null;
  const typedType = rawType && (ALLOWED_TYPES as readonly string[]).includes(rawType)
    ? (rawType as (typeof ALLOWED_TYPES)[number]) : null;
  if (typedType) {
    updates.type = typedType;
    updates.is_showroom = typedType === 'showroom';
  } else if (typeof body.isShowroom === 'boolean') {
    updates.is_showroom = body.isShowroom;
    updates.type = body.isShowroom ? 'showroom' : 'warehouse';
  }
  if (body.venueName !== undefined) {
    const v = typeof body.venueName === 'string' ? body.venueName.trim() : '';
    updates.venue_name = v || null;
  }
  if (Object.keys(updates).length === 0) return c.json({ error: 'no_changes' }, 400);

  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  const { data, error } = await scopeToCompanyId(
    sb.from('warehouses').update(updates).eq('id', id),
    co.companyId,
  ).select('id, code, name, location, state, postcode, city, is_active, is_default, is_showroom, venue_name, type').maybeSingle();
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  // No row matched id + company: not this company's warehouse, or gone.
  if (!data) return c.json(NOT_THIS_COMPANY, 404);
  /* Audit 2026-06-20 — single-default enforcement (see POST): promoting this
     warehouse to default demotes every other one IN THIS COMPANY. The company
     predicate is the whole fix — see the header comment. */
  if (updates.is_default === true) {
    await scopeToCompanyId(
      sb.from('warehouses').update({ is_default: false })
        .eq('is_default', true).neq('id', id),
      co.companyId,
    );
  }
  return c.json({ warehouse: data });
};

inventory.patch('/warehouses/:id', patchWarehouseHandler);

/* Task #121 — Hard DELETE of a warehouse. Used by the inline Warehouses
   table on /mfg-sales-orders/maintenance so a coordinator can drop a
   row they just typed by mistake. Postgres FKs from inventory_movements
   / lots / cogs reject the delete when there's referenced history;
   commander should toggle is_active=false via PATCH in that case. We
   surface the FK error so the UI can hint at deactivate instead.

   Scoped to the active company alongside the PATCH above. Not one of the two
   items this pass was sequenced for, but it is the same blind-id defect on the
   same table three lines away — company A could DELETE company B's warehouse —
   and scoping a delete can only ever refuse a cross-company write, never hide a
   company's own rows from itself. */
inventory.delete('/warehouses/:id', async (c) => {
  const sb = c.get('supabase');
  const id = c.req.param('id');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const { error } = await scopeToCompanyId(
    sb.from('warehouses').delete().eq('id', id),
    co.companyId,
  );
  if (error) {
    // 23503 = foreign_key_violation — there are movements/lots/etc. tied
    // to this warehouse. Bubble up so the client can show a friendlier
    // "deactivate instead" path.
    if (error.code === '23503') return c.json({ error: 'in_use', reason: error.message }, 409);
    return c.json({ error: 'delete_failed', reason: error.message }, 500);
  }
  return c.json({ ok: true });
});

/* ── Balances ─────────────────────────────────────────────────────────── */
// When showAll=true, returns one row per (warehouse × SKU) including
// zero-balance rows — the UI uses this for the "all SKUs" view.
// When showAll=false (default), returns only rows with movements.
//
// Exported for the route test (see patchWarehouseHandler / productPickerCompanyScope
// for why the handler is lifted out — the supabaseAuth bridge can't run in the
// harness). The test pins that showAll is company-scoped in BOTH directions.
export const listInventoryHandler = async (c: any) => {
  const sb = c.get('supabase');
  const warehouseId = c.req.query('warehouseId');
  const search = c.req.query('search');
  const category = c.req.query('category');
  const showAll = c.req.query('showAll') === 'true';

  const tableName = showAll ? 'v_inventory_all_skus' : 'inventory_balances';
  // showAll = catalog rollup (one row per SKU incl. zero, product_code level).
  // default = live balances, now one row per (warehouse, product_code,
  // variant_key) so the UI can break a SKU into its attribute-composition rows.
  const cols = showAll
    ? 'warehouse_id, warehouse_code, warehouse_name, product_code, product_name, category, size_label, qty, last_movement_at, value_sen, main_supplier_code, main_supplier_name'
    : 'warehouse_id, product_code, variant_key, product_name, qty, last_movement_at';

  // PostgREST's default 1000-row cap silently truncates stock balances —
  // partial stock reads like MISSING stock (showAll returns 17,115 rows live).
  // Page through with .range() so the full set comes back. Any ?warehouseId/
  // ?search/?category filter only narrows the set, so filtered views stay correct.
  const s = search ? escapeForOr(search) : '';
  const { data, error } = await paginateAll((from, to) => {
    let q = sb.from(tableName).select(cols);
    if (warehouseId) q = q.eq('warehouse_id', warehouseId);
    if (s) q = q.or(`product_code.ilike.%${s}%,product_name.ilike.%${s}%`);
    if (showAll && category && category !== 'all') q = q.eq('category', category);
    // multi-company: BOTH reads are per-company now. inventory_balances has
    // carried company_id since mig 0084; the showAll SKU rollup
    // (v_inventory_all_skus) gained company_id in mig 0154, which also stopped
    // its product-by-warehouse cross join from pairing the two companies. Scope
    // EVERY read so showAll can no longer leak the other company's catalogue,
    // warehouses, on-hand qty, valuation or main supplier. scopeToCompany still
    // degrades to no predicate when the active company is unresolved
    // (pre-migration / cold-start), so single-company Houzs is unchanged.
    q = scopeToCompany(q, c);
    return q.order('product_code').range(from, to);
  });
  if (error) {
    if (/relation .* does not exist/i.test(error.message) || /column .* does not exist/i.test(error.message)) {
      return c.json({ error: 'migration_pending', reason: 'Run the SCM inventory view migrations (including 0154, which adds company_id to v_inventory_all_skus) against Supabase.' }, 500);
    }
    return c.json({ error: 'load_failed', reason: error.message }, 500);
  }

  /* Show active warehouses PLUS consignment/showroom warehouses (those are kept
     is_active=false so they stay out of the normal GRN/DO pickers) — so consigned
     stock sitting at a showroom is visible in Inventory. (2026-06-05) */
  const { data: whs } = await sb.from('warehouses')
    .select('id, code, name, is_consignment')
    .or('is_active.eq.true,is_consignment.eq.true');
  return c.json({ balances: data ?? [], warehouses: whs ?? [] });
};

inventory.get('/', listInventoryHandler);

/* Σ delivered / Σ returned per SO line id (net-of-delivered). Only
   non-cancelled AND non-draft DOs count as delivered (a DRAFT DO hasn't
   shipped); only non-cancelled DRs traced back through the active DO line count
   as returned. Used to net gross open SO-line qty down to the still-open claim
   for the Reserved / Available KPIs so a partially-shipped SO isn't
   double-counted. Mirrors so-readiness's soDeliverableRemaining leak guard. */
async function deliveredReturnedBySoItem(
  sb: any,
  soItemIds: string[],
): Promise<{ deliveredBySoItem: Map<string, number>; returnedBySoItem: Map<string, number> }> {
  const deliveredBySoItem = new Map<string, number>();
  const returnedBySoItem = new Map<string, number>();
  if (soItemIds.length === 0) return { deliveredBySoItem, returnedBySoItem };

  const { data: doLines } = await chunkIn<{ id: string; so_item_id: string | null; qty: number; delivery_order_id: string }>(soItemIds, (batch, from, to) => sb
    .from('delivery_order_items')
    .select('id, so_item_id, qty, delivery_order_id')
    .in('so_item_id', batch)
    .range(from, to));
  const doLineRows = (doLines ?? []) as Array<{ id: string; so_item_id: string | null; qty: number; delivery_order_id: string }>;
  const doIds = [...new Set(doLineRows.map((l) => l.delivery_order_id).filter(Boolean))];
  const activeDoIds = new Set<string>();
  const doLineToSoItem = new Map<string, string>();
  if (doIds.length > 0) {
    const { data: dos } = await chunkIn<{ id: string; status: string | null }>(doIds, (batch, from, to) =>
      sb.from('delivery_orders').select('id, status').in('id', batch).range(from, to));
    for (const d of (dos ?? []) as Array<{ id: string; status: string | null }>) {
      // DRAFT DO hasn't shipped and hasn't moved stock — excluding it (like
      // soDeliverableRemaining's LEAK GUARD) keeps its units in Reserved so a
      // free-to-sell KPI can't be inflated into over-sell. (DRs have no DRAFT.)
      const st = (d.status ?? '').toUpperCase();
      if (st !== 'CANCELLED' && st !== 'DRAFT') activeDoIds.add(d.id);
    }
  }
  for (const l of doLineRows) {
    if (!l.so_item_id || !activeDoIds.has(l.delivery_order_id)) continue;
    doLineToSoItem.set(l.id, l.so_item_id);
    deliveredBySoItem.set(l.so_item_id, (deliveredBySoItem.get(l.so_item_id) ?? 0) + Number(l.qty ?? 0));
  }

  const activeDoLineIds = [...doLineToSoItem.keys()];
  if (activeDoLineIds.length > 0) {
    const { data: drLines } = await chunkIn<{ do_item_id: string | null; qty_returned: number; delivery_return_id: string }>(activeDoLineIds, (batch, from, to) => sb
      .from('delivery_return_items')
      .select('do_item_id, qty_returned, delivery_return_id')
      .in('do_item_id', batch)
      .range(from, to));
    const drLineRows = (drLines ?? []) as Array<{ do_item_id: string | null; qty_returned: number; delivery_return_id: string }>;
    const drIds = [...new Set(drLineRows.map((l) => l.delivery_return_id).filter(Boolean))];
    const activeDrIds = new Set<string>();
    if (drIds.length > 0) {
      const { data: drs } = await chunkIn<{ id: string; status: string | null }>(drIds, (batch, from, to) =>
        sb.from('delivery_returns').select('id, status').in('id', batch).range(from, to));
      for (const d of (drs ?? []) as Array<{ id: string; status: string | null }>) {
        if ((d.status ?? '').toUpperCase() !== 'CANCELLED') activeDrIds.add(d.id);
      }
    }
    for (const l of drLineRows) {
      if (!l.do_item_id || !activeDrIds.has(l.delivery_return_id)) continue;
      const soItemId = doLineToSoItem.get(l.do_item_id);
      if (!soItemId) continue;
      returnedBySoItem.set(soItemId, (returnedBySoItem.get(soItemId) ?? 0) + Number(l.qty_returned ?? 0));
    }
  }

  return { deliveredBySoItem, returnedBySoItem };
}

/* ── Product totals (AutoCount-style list view) — PR #38 ─────────────────
   One row per product_code with summed qty across all warehouses + main
   supplier. Double-click a row in the UI to drill into per-warehouse
   breakdown via GET /inventory?showAll=true&search=... */
inventory.get('/products', async (c) => {
  const sb = c.get('supabase');
  const search = c.req.query('search');
  const category = c.req.query('category');

  // PostgREST's default 1000-row cap silently truncates product totals — page
  // through with .range() so the full catalogue comes back. Any ?search/?category
  // filter only narrows the set, so filtered views stay correct.
  const s = search ? escapeForOr(search) : '';
  const { data, error } = await paginateAll((from, to) => {
    let q = sb.from('v_inventory_product_totals').select('*');
    q = scopeToCompany(q, c); // multi-company: isolate product totals to the active company (view exposes company_id, mig 0106)
    if (s) q = q.or(`product_code.ilike.%${s}%,product_name.ilike.%${s}%`);
    if (category && category !== 'all') q = q.eq('category', category);
    return q.order('product_code').range(from, to);
  });
  if (error) {
    if (/relation .* does not exist/i.test(error.message)) {
      return c.json({ error: 'migration_pending', reason: 'Run migrations 0050/0053/0054.' }, 500);
    }
    return c.json({ error: 'load_failed', reason: error.message }, 500);
  }

  /* Commander 2026-05-29 — enrich each SKU with the live stock picture:
       reserve 7d/14d  = open Sales-Order demand due within 7 / 14 days
       reserved_total  = all open SO demand (committed to customers)
       available_qty   = stock − reserved_total (what's free to sell)
       incoming_qty    = outstanding PO supply (qty − received) coming in
       oldest_lot_at   = the oldest open FIFO lot → "age" of the stock
     Computed by SKU code across all variants (the list is one row per SKU). */
  const products = (data ?? []) as Array<Record<string, unknown>>;
  const codes = products.map((p) => String(p.product_code));
  const SO_DONE = new Set(['DELIVERED', 'INVOICED', 'CLOSED', 'CANCELLED']);
  const todayMY = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const plus = (n: number): string => {
    const d = new Date(`${todayMY}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const d7 = plus(7), d14 = plus(14);

  const reserve7 = new Map<string, number>();
  const reserve14 = new Map<string, number>();
  const reservedTotal = new Map<string, number>();
  const incoming = new Map<string, number>();
  const oldestLot = new Map<string, string>();

  if (codes.length > 0) {
    // chunkIn — codes can now exceed 1000 (un-truncated catalogue), so batch the
    // .in() lists and page each batch (PostgREST default cap is 1000 rows).
    // Scope demand to the active company — the stock figure (v_inventory_product_totals)
    // and the open-lots query below are already company-scoped, so leaving demand
    // un-scoped would subtract OTHER companies' claims on a shared SKU from THIS
    // company's stock (mfg_sales_order_items carries company_id, mig 0083).
    const { data: demand } = await chunkIn(codes, (batch, from, to) => scopeToCompany(sb
      .from('mfg_sales_order_items')
      .select('id, item_code, qty, line_delivery_date, cancelled, so:mfg_sales_orders!inner(status, customer_delivery_date)'), c)
      .in('item_code', batch).eq('cancelled', false).range(from, to));
    const demandRows = ((demand ?? []) as Array<{ id: string; item_code: string; qty: number; line_delivery_date: string | null; so: { status: string; customer_delivery_date: string | null } | Array<{ status: string; customer_delivery_date: string | null }> | null }>)
      .map((r) => ({ id: r.id, item_code: r.item_code, qty: Number(r.qty ?? 0), line_delivery_date: r.line_delivery_date, so: Array.isArray(r.so) ? r.so[0] : r.so }))
      .filter((r) => r.so != null && !SO_DONE.has(r.so.status) && r.qty > 0);

    // Net-of-delivered per line — mirror so-stock-allocation: an open SO line's
    // live claim is qty − Σ delivered + Σ returned, floored at 0. Summing gross
    // qty double-counts the shipped units of a partially-delivered SO and drives
    // available_qty wrongly negative.
    const { deliveredBySoItem, returnedBySoItem } = await deliveredReturnedBySoItem(sb, demandRows.map((r) => r.id));

    for (const r of demandRows) {
      const so = r.so!;
      const net = Math.max(0, r.qty - (deliveredBySoItem.get(r.id) ?? 0) + (returnedBySoItem.get(r.id) ?? 0));
      if (net <= 0) continue;
      const code = r.item_code;
      reservedTotal.set(code, (reservedTotal.get(code) ?? 0) + net);
      const dd = (r.line_delivery_date ?? so.customer_delivery_date)?.slice(0, 10);
      if (dd) {
        if (dd <= d7) reserve7.set(code, (reserve7.get(code) ?? 0) + net);
        if (dd <= d14) reserve14.set(code, (reserve14.get(code) ?? 0) + net);
      }
    }

    const { data: poItems } = await chunkIn(codes, (batch, from, to) => sb
      .from('purchase_order_items')
      .select('material_code, qty, received_qty, po:purchase_orders!inner(status)')
      .in('material_code', batch).range(from, to));
    for (const r of (poItems ?? []) as Array<{ material_code: string; qty: number; received_qty: number | null; po: { status: string } | Array<{ status: string }> | null }>) {
      const po = Array.isArray(r.po) ? r.po[0] : r.po;
      if (!po || (po.status !== 'SUBMITTED' && po.status !== 'PARTIALLY_RECEIVED')) continue;
      const left = Number(r.qty ?? 0) - Number(r.received_qty ?? 0);
      if (left > 0) incoming.set(r.material_code, (incoming.get(r.material_code) ?? 0) + left);
    }

    const { data: lots } = await chunkIn(codes, (batch, from, to) => scopeToCompany(sb
      .from('v_inventory_lots_open')
      .select('product_code, received_at'), c) // multi-company: isolate open lots to the active company (view exposes company_id, mig 0106)
      .in('product_code', batch).range(from, to));
    for (const r of (lots ?? []) as Array<{ product_code: string; received_at: string | null }>) {
      if (!r.received_at) continue;
      const cur = oldestLot.get(r.product_code);
      if (!cur || r.received_at < cur) oldestLot.set(r.product_code, r.received_at);
    }
  }

  const enriched = products.map((p) => {
    const code = String(p.product_code);
    const rt = reservedTotal.get(code) ?? 0;
    return {
      ...p,
      reserve_7d:     reserve7.get(code) ?? 0,
      reserve_14d:    reserve14.get(code) ?? 0,
      reserved_total: rt,
      available_qty:  Number(p.total_qty ?? 0) - rt,
      incoming_qty:   incoming.get(code) ?? 0,
      oldest_lot_at:  oldestLot.get(code) ?? null,
    };
  });
  return c.json({ products: enriched });
});

/* ── Per (warehouse × variant) breakdown for one product (drilldown drawer) ─
   Migration 0095. One row per warehouse + attribute composition, with qty
   (from balances) + value (from open FIFO lots) + a readable variant label
   resolved client-side. This is what powers the SKU → attribute-rows view. */
inventory.get('/breakdown/:productCode', async (c) => {
  const sb = c.get('supabase');
  const productCode = c.req.param('productCode');

  const { data: bal, error: balErr } = await sb.from('inventory_balances')
    .select('warehouse_id, variant_key, qty, last_movement_at')
    .eq('product_code', productCode)
    .eq('company_id', activeCompanyId(c));
  if (balErr) {
    if (/relation .* does not exist/i.test(balErr.message) || /column .* does not exist/i.test(balErr.message)) {
      return c.json({ error: 'migration_pending', reason: 'Run migration 0095 against Supabase.' }, 500);
    }
    return c.json({ error: 'load_failed', reason: balErr.message }, 500);
  }
  const { data: val } = await scopeToCompany(sb.from('v_inventory_value')
    .select('warehouse_id, variant_key, value_sen')
    .eq('product_code', productCode), c); // multi-company: isolate valuation to the active company (view exposes company_id, mig 0106)
  const { data: whs } = await sb.from('warehouses').select('id, code, name');

  const whMap = new Map((whs ?? []).map((w: { id: string; code: string; name: string }) => [w.id, w]));
  const valMap = new Map(
    ((val ?? []) as Array<{ warehouse_id: string; variant_key: string; value_sen: number }>)
      .map((v) => [`${v.warehouse_id}|${v.variant_key}`, Number(v.value_sen ?? 0)]),
  );
  const balances = ((bal ?? []) as Array<{ warehouse_id: string; variant_key: string | null; qty: number; last_movement_at: string | null }>)
    .map((b) => {
      const vk = b.variant_key ?? '';
      const w = whMap.get(b.warehouse_id);
      return {
        warehouse_id: b.warehouse_id,
        warehouse_code: w?.code ?? null,
        warehouse_name: w?.name ?? null,
        variant_key: vk,
        product_code: productCode,
        qty: Number(b.qty ?? 0),
        value_sen: valMap.get(`${b.warehouse_id}|${vk}`) ?? 0,
        last_movement_at: b.last_movement_at ?? null,
      };
    });
  return c.json({ balances });
});

inventory.get('/movements', async (c) => {
  const sb = c.get('supabase');
  const warehouseId = c.req.query('warehouseId');
  const productCode = c.req.query('productCode');
  const docType = c.req.query('docType');
  const dateFrom = c.req.query('dateFrom');
  const dateTo = c.req.query('dateTo');
  const limit = Math.min(500, Number(c.req.query('limit') ?? 200));

  let q = sb.from('inventory_movements')
    .select('id, movement_type, warehouse_id, product_code, product_name, qty, unit_cost_sen, total_cost_sen, source_doc_type, source_doc_id, source_doc_no, reason_code, notes, performed_by, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (warehouseId) q = q.eq('warehouse_id', warehouseId);
  if (productCode) q = q.eq('product_code', productCode);
  if (docType) q = q.eq('source_doc_type', docType);
  if (dateFrom) q = q.gte('created_at', dateFrom);
  if (dateTo) q = q.lte('created_at', `${dateTo}T23:59:59Z`);
  q = scopeToCompany(q, c); // stock ledger is per-company — don't leak the other company's movements.

  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ movements: data ?? [] });
});

/* ── FIFO lots drilldown for one product ─────────────────────────────── */
inventory.get('/lots/:productCode', async (c) => {
  const sb = c.get('supabase');
  const productCode = c.req.param('productCode');
  const warehouseId = c.req.query('warehouseId');
  const includeClosed = c.req.query('includeClosed') === 'true';

  const tbl = includeClosed ? 'inventory_lots' : 'v_inventory_lots_open';
  let q = sb.from(tbl).select('*').eq('product_code', productCode);
  if (warehouseId) q = q.eq('warehouse_id', warehouseId);
  q = scopeToCompany(q, c); // FIFO lots are per-company (both table + view carry company_id).
  const { data, error } = await q.order('received_at', { ascending: true });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ lots: data ?? [] });
});

/* ── Batch availability (Stage 2 — Commander 2026-05-31) ──────────────────
   Sofa is colour-matched and produced as a SET on ONE PO (one dye lot). Stage 1
   tagged every inbound lot with batch_no = source PO number. This view groups
   the OPEN lots (qty_remaining > 0) by (warehouse, batch) so the outbound side
   can see each batch's surviving component SKUs at a glance — the raw material
   Stage 3 uses to ship a whole set from ONE batch.

   Shape: one row per (warehouse_id, batch_no) with its component SKUs:
     { warehouseId, warehouseName, batchNo, supplierId, supplierName,
       receivedAt (earliest), totalRemaining,
       components: [{ productCode, variantKey, productName, qtyRemaining,
                      unitCostSen, receivedAt }] }
   ?warehouseId filters; ?productCode keeps only batches that still hold that SKU.
   batch_no IS NULL lots (free GRN / un-batched stock) are excluded by design —
   only produced-to-PO stock carries a batch. */
inventory.get('/batches', async (c) => {
  const sb = c.get('supabase');
  const warehouseId = c.req.query('warehouseId');
  const productCode = c.req.query('productCode');

  let q = sb.from('v_inventory_lots_open')
    .select('warehouse_id, batch_no, product_code, variant_key, product_name, qty_remaining, unit_cost_sen, received_at')
    .not('batch_no', 'is', null)
    .gt('qty_remaining', 0);
  q = scopeToCompany(q, c); // multi-company: isolate batches to the active company (view exposes company_id, mig 0106)
  if (warehouseId) q = q.eq('warehouse_id', warehouseId);
  const { data: lots, error } = await q.order('received_at', { ascending: true });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  type Lot = {
    warehouse_id: string; batch_no: string; product_code: string;
    variant_key: string | null; product_name: string | null;
    qty_remaining: number; unit_cost_sen: number | null; received_at: string | null;
  };
  const rows = (lots ?? []) as Lot[];

  // Warehouse names (small table).
  const { data: whs } = await sb.from('warehouses').select('id, name');
  const whName = new Map<string, string>();
  for (const w of (whs ?? []) as Array<{ id: string; name: string }>) whName.set(w.id, w.name);

  // batch_no = PO number → resolve supplier for display.
  const batchNos = [...new Set(rows.map((r) => r.batch_no))];
  const supplierByPo = new Map<string, { id: string | null; name: string | null }>();
  if (batchNos.length > 0) {
    const { data: pos } = await sb.from('purchase_orders')
      .select('po_number, supplier_id, suppliers(name)')
      .in('po_number', batchNos);
    for (const p of (pos ?? []) as unknown as Array<{ po_number: string; supplier_id: string | null; suppliers: { name: string | null } | { name: string | null }[] | null }>) {
      const sup = Array.isArray(p.suppliers) ? (p.suppliers[0] ?? null) : p.suppliers;
      supplierByPo.set(p.po_number, { id: p.supplier_id ?? null, name: sup?.name ?? null });
    }
  }

  type Component = {
    productCode: string; variantKey: string | null; productName: string | null;
    qtyRemaining: number; unitCostSen: number; receivedAt: string | null;
  };
  type Batch = {
    warehouseId: string; warehouseName: string | null; batchNo: string;
    supplierId: string | null; supplierName: string | null;
    receivedAt: string | null; totalRemaining: number; components: Component[];
  };
  const byBatch = new Map<string, Batch>();
  for (const r of rows) {
    const key = `${r.warehouse_id}|${r.batch_no}`;
    let b = byBatch.get(key);
    if (!b) {
      const sup = supplierByPo.get(r.batch_no) ?? { id: null, name: null };
      b = {
        warehouseId: r.warehouse_id,
        warehouseName: whName.get(r.warehouse_id) ?? null,
        batchNo: r.batch_no,
        supplierId: sup.id,
        supplierName: sup.name,
        receivedAt: r.received_at,
        totalRemaining: 0,
        components: [],
      };
      byBatch.set(key, b);
    }
    // Merge same (product_code, variant_key) lots within a batch into one component.
    const existing = b.components.find((c2) => c2.productCode === r.product_code && (c2.variantKey ?? '') === (r.variant_key ?? ''));
    if (existing) {
      existing.qtyRemaining += r.qty_remaining;
    } else {
      b.components.push({
        productCode: r.product_code,
        variantKey: r.variant_key,
        productName: r.product_name,
        qtyRemaining: r.qty_remaining,
        unitCostSen: Number(r.unit_cost_sen ?? 0),
        receivedAt: r.received_at,
      });
    }
    b.totalRemaining += r.qty_remaining;
    // Keep the earliest received_at on the batch header.
    if (r.received_at && (!b.receivedAt || r.received_at < b.receivedAt)) b.receivedAt = r.received_at;
  }

  let batches = [...byBatch.values()];
  if (productCode) batches = batches.filter((b) => b.components.some((c2) => c2.productCode === productCode));
  // FIFO order — oldest batch first (matches outbound consumption preference).
  batches.sort((a, b) => (a.receivedAt ?? '').localeCompare(b.receivedAt ?? ''));

  return c.json({ batches });
});

/* ── COGS stream ─────────────────────────────────────────────────────── */
inventory.get('/cogs', async (c) => {
  const sb = c.get('supabase');
  const warehouseId = c.req.query('warehouseId');
  const productCode = c.req.query('productCode');
  const from = c.req.query('from');
  const to = c.req.query('to');

  // PostgREST's 1000-row cap silently truncated the COGS export — page through
  // so a long date range exports every consumption row, not just the first 1000.
  const { data, error } = await paginateAll((pFrom, pTo) => {
    let q = sb.from('v_cogs_entries').select('*');
    q = scopeToCompany(q, c); // multi-company: isolate COGS stream to the active company (view exposes company_id, mig 0106)
    if (warehouseId) q = q.eq('warehouse_id', warehouseId);
    if (productCode) q = q.eq('product_code', productCode);
    if (from) q = q.gte('consumed_at', from);
    if (to)   q = q.lte('consumed_at', `${to}T23:59:59Z`);
    return q.range(pFrom, pTo);
  });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ cogs: data ?? [] });
});

/* ── Inventory valuation (qty × cost) ────────────────────────────────── */
inventory.get('/value', async (c) => {
  const sb = c.get('supabase');
  const warehouseId = c.req.query('warehouseId');
  // PostgREST's 1000-row cap silently truncated the valuation — page through so
  // every SKU's qty × cost is summed, not just the first 1000. The optional
  // warehouse filter stays inside the page query.
  const { data, error } = await paginateAll((from, to) => {
    let q = sb.from('v_inventory_value').select('*');
    q = scopeToCompany(q, c); // multi-company: isolate valuation to the active company (view exposes company_id, mig 0106)
    if (warehouseId) q = q.eq('warehouse_id', warehouseId);
    return q.order('product_code').range(from, to);
  });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ value: data ?? [] });
});

/* ── Inventory analytics / KPI board ─────────────────────────────────────
   Pure read-only reporting computed from open lots + COGS stream. No new
   tables. Returns: stock aging buckets, dead-stock (has stock but no sale in
   the window), turnover + days-on-hand, and an ABC classification by trailing
   sales value. ?days=90 (window), ?warehouseId optional. */
inventory.get('/analytics', async (c) => {
  const sb = c.get('supabase');
  const warehouseId = c.req.query('warehouseId');
  const days = Math.max(1, Math.min(365, Math.round(Number(c.req.query('days') ?? 90)) || 90));
  const nowMs = Date.now();
  const cutoffIso = new Date(nowMs - days * 86_400_000).toISOString();

  // Open lots → aging buckets + per-product on-hand value + names. Page through —
  // a bare .limit(50_000) is still capped at PostgREST's 1000-row ceiling, so a
  // warehouse with >1000 open lots would silently under-report on-hand value +
  // aging. The optional warehouse filter stays inside the page query.
  const { data: lots, error: lotsErr } = await paginateAll((from, to) => {
    let lotsQ = sb.from('v_inventory_lots_open')
      .select('product_code, product_name, qty_remaining, remaining_value_sen, received_at, warehouse_id');
    lotsQ = scopeToCompany(lotsQ, c); // multi-company: isolate open lots to the active company (view exposes company_id, mig 0106)
    if (warehouseId) lotsQ = lotsQ.eq('warehouse_id', warehouseId);
    return lotsQ.range(from, to);
  });
  if (lotsErr) return c.json({ error: 'load_failed', reason: lotsErr.message }, 500);

  // Full COGS stream → trailing-window sales value per product + all-time last-sold
  // date. Page through (same 1000-row cap as above) so turnover / dead-stock /
  // ABC aren't computed off a truncated COGS window.
  const { data: cogs, error: cogsErr } = await paginateAll((from, to) => {
    let cogsQ = sb.from('v_cogs_entries')
      .select('product_code, total_cost_sen, consumed_at, warehouse_id');
    cogsQ = scopeToCompany(cogsQ, c); // multi-company: isolate COGS stream to the active company (view exposes company_id, mig 0106)
    if (warehouseId) cogsQ = cogsQ.eq('warehouse_id', warehouseId);
    return cogsQ.range(from, to);
  });
  if (cogsErr) return c.json({ error: 'load_failed', reason: cogsErr.message }, 500);

  const lotRows = lots ?? [];
  const cogsRows = cogs ?? [];

  // Aging buckets (days since lot received).
  const BUCKETS = [
    { key: '0-30', label: '0–30 days', max: 30 },
    { key: '31-60', label: '31–60 days', max: 60 },
    { key: '61-90', label: '61–90 days', max: 90 },
    { key: '91-180', label: '91–180 days', max: 180 },
    { key: '180+', label: '180+ days', max: Infinity },
  ];
  const aging = BUCKETS.map((b) => ({ key: b.key, label: b.label, qty: 0, valueSen: 0 }));
  // Per-product current on-hand value + name.
  const prod = new Map<string, { name: string; qty: number; valueSen: number }>();
  let totalValueSen = 0;
  for (const l of lotRows) {
    const ageDays = (nowMs - new Date(l.received_at as string).getTime()) / 86_400_000;
    const idx = BUCKETS.findIndex((b) => ageDays <= b.max);
    const bucket = aging[idx < 0 ? aging.length - 1 : idx];
    const qty = Number(l.qty_remaining ?? 0);
    const val = Number(l.remaining_value_sen ?? 0);
    if (bucket) { bucket.qty += qty; bucket.valueSen += val; }
    totalValueSen += val;
    const code = String(l.product_code ?? '');
    const p = prod.get(code) ?? { name: String(l.product_name ?? code), qty: 0, valueSen: 0 };
    p.qty += qty; p.valueSen += val;
    prod.set(code, p);
  }

  // Trailing-window COGS per product + all-time last-sold.
  const trailingCogs = new Map<string, number>();
  const lastSold = new Map<string, string>();
  let trailingCogsTotal = 0;
  for (const e of cogsRows) {
    const code = String(e.product_code ?? '');
    const at = String(e.consumed_at ?? '');
    const prev = lastSold.get(code);
    if (!prev || at > prev) lastSold.set(code, at);
    if (at >= cutoffIso) {
      const v = Number(e.total_cost_sen ?? 0);
      trailingCogs.set(code, (trailingCogs.get(code) ?? 0) + v);
      trailingCogsTotal += v;
    }
  }

  // Turnover + days-on-hand (current value as the average-inventory proxy).
  const annualizedCogs = trailingCogsTotal * (365 / days);
  const turns = totalValueSen > 0 ? annualizedCogs / totalValueSen : 0;
  const daysOnHand = trailingCogsTotal > 0 ? (totalValueSen * days) / trailingCogsTotal : null;

  // Dead stock — has on-hand value but no sale inside the window.
  const deadStock = [...prod.entries()]
    .filter(([code]) => !(trailingCogs.get(code) ?? 0))
    .map(([code, p]) => ({
      product_code: code, product_name: p.name, qty: p.qty, valueSen: p.valueSen,
      lastSoldAt: lastSold.get(code) ?? null,
    }))
    .sort((a, b) => b.valueSen - a.valueSen);

  // ABC — rank every product (stock or sales) by trailing sales value desc.
  const codes = new Set<string>([...prod.keys(), ...trailingCogs.keys()]);
  const ranked = [...codes]
    .map((code) => ({
      product_code: code,
      product_name: prod.get(code)?.name ?? code,
      cogsSen: trailingCogs.get(code) ?? 0,
      onHandValueSen: prod.get(code)?.valueSen ?? 0,
    }))
    .sort((a, b) => b.cogsSen - a.cogsSen);
  const summary = { A: { count: 0, valueSen: 0 }, B: { count: 0, valueSen: 0 }, C: { count: 0, valueSen: 0 } };
  let cum = 0;
  const abcItems = ranked.map((r) => {
    cum += r.cogsSen;
    const cumPct = trailingCogsTotal > 0 ? (cum / trailingCogsTotal) * 100 : 100;
    const cls: 'A' | 'B' | 'C' = cumPct <= 80 ? 'A' : cumPct <= 95 ? 'B' : 'C';
    summary[cls].count += 1;
    summary[cls].valueSen += r.onHandValueSen;
    return { ...r, cumPct, class: cls };
  });

  return c.json({
    asOf: new Date(nowMs).toISOString(),
    windowDays: days,
    totalValueSen,
    distinctSkus: prod.size,
    aging,
    turnover: { trailingCogsSen: trailingCogsTotal, annualizedTurns: turns, daysOnHand },
    deadStock,
    abc: { items: abcItems, summary },
  });
});

/* ── Ledger reconciliation sweep ─────────────────────────────────────────
   Read-only integrity check. Inventory writes are best-effort (a failed
   movement insert does NOT roll back the document), so a doc can be POSTED /
   shipped while its stock movement silently never landed. This flags every
   non-cancelled stock-moving document (GRN / DO / Purchase Return / Delivery
   Return / Stock Transfer / Consignment Note / Consignment Return / PC Receive
   / PC Return) that should have moved stock but has ZERO movement rows — the
   operator can then re-post or investigate. Stock Take is intentionally
   excluded (a zero-variance take legitimately writes no movements). The full
   sweep lives in scm/lib/reconcile-ledger so System Health can reuse it. */
inventory.get('/reconcile', async (c) => {
  const sb = c.get('supabase');
  try {
    return c.json(await reconcileLedger(sb));
  } catch (e: any) {
    return c.json({ error: 'load_failed', reason: e?.message ?? 'reconcile failed' }, 500);
  }
});

// Manual stock ADJUSTMENT write (POST /inventory/adjustments) moved to its own
// router — routes/inventory-adjustments.ts — so it can be gated on the separate
// `scm.warehouse.adjustments` permission instead of `scm.warehouse.inventory`.
// See that file's header and scm/index.ts for the sub-mount ordering.

/* ── Open stock buckets for one product (decrease-adjustment picker) ───────
   Groups the OPEN lots (qty_remaining > 0) of one SKU by (variant_key, batch_no)
   so a manual DECREASE adjustment can target the EXACT bucket it takes stock
   from — never into a non-existent or wrong-attribute/-batch bucket. ?warehouseId
   scopes to one warehouse. */
inventory.get('/buckets/:productCode', async (c) => {
  const sb = c.get('supabase');
  const productCode = c.req.param('productCode');
  const warehouseId = c.req.query('warehouseId');

  let q = sb.from('v_inventory_lots_open')
    .select('warehouse_id, variant_key, batch_no, product_name, qty_remaining')
    .eq('product_code', productCode);
  q = scopeToCompany(q, c); // multi-company: isolate stock buckets to the active company (view exposes company_id, mig 0106)
  if (warehouseId) q = q.eq('warehouse_id', warehouseId);
  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  type Lot = {
    warehouse_id: string; variant_key: string | null; batch_no: string | null;
    product_name: string | null; qty_remaining: number | null;
  };
  const byBucket = new Map<string, {
    warehouse_id: string; variant_key: string; batch_no: string | null;
    product_name: string | null; qty: number;
  }>();
  for (const l of (data ?? []) as Lot[]) {
    const vk = l.variant_key ?? '';
    const bn = l.batch_no ?? null;
    const key = `${l.warehouse_id}|${vk}|${bn ?? ''}`;
    const cur = byBucket.get(key);
    if (cur) cur.qty += Number(l.qty_remaining ?? 0);
    else byBucket.set(key, { warehouse_id: l.warehouse_id, variant_key: vk, batch_no: bn, product_name: l.product_name, qty: Number(l.qty_remaining ?? 0) });
  }
  const buckets = [...byBucket.values()]
    .filter((b) => b.qty > 0)
    .sort((a, b) => (a.batch_no ?? '').localeCompare(b.batch_no ?? '') || a.variant_key.localeCompare(b.variant_key));
  return c.json({ buckets });
});
