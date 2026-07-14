// /purchase-invoices — supplier billing us (after GRN).

import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { buildVariantSummary } from '../shared';
import {
  orderSofaModuleRowsWithinBuilds,
  sortSoLinesByGroupRank,
} from '../shared/so-line-display';
import { postPiAccounting, reversePiAccounting, resyncPiAccounting } from './accounting';
import { recostForPi, recostFromGrn } from '../lib/recost';
import { normalizeCurrency, normalizeExchangeRate, masterRateForCurrency } from '../lib/fx';
import { nextMonthlyDocNo, insertWithDocNoRetry } from '../lib/doc-no';
import { escapeForOr } from '../lib/postgrest-search';
import { scopeToCompany, activeCompanyId, stampCompany, companyDocPrefix } from '../lib/companyScope';
import { todayMyt } from '../lib/my-time';

export const purchaseInvoices = new Hono<{ Bindings: Env; Variables: Variables }>();
purchaseInvoices.use('*', supabaseAuth);

const HEADER =
  'id, invoice_number, supplier_invoice_ref, supplier_id, purchase_order_id, grn_id, invoice_date, due_date, currency, exchange_rate, subtotal_centi, tax_centi, total_centi, paid_centi, status, notes, posted_at, created_at, created_by, updated_at';
const ITEM =
  'id, purchase_invoice_id, grn_item_id, material_kind, material_code, material_name, qty, unit_price_centi, line_total_centi, notes, ' +
  /* PR #42 — variant fields (migration 0057) */
  'item_group, description, description2, uom, discount_centi, variants, ' +
  'gap_inches, divan_height_inches, divan_price_sen, leg_height_inches, leg_price_sen, ' +
  'custom_specials, line_suffix, special_order_price_sen, unit_cost_centi, created_at';

const nextNum = async (sb: any, prefix: string, c: any): Promise<string> => {
  const d = new Date();
  const yymm = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`;
  const p = companyDocPrefix(c);
  const { data: existing } = await sb.from('purchase_invoices').select('invoice_number').like('invoice_number', `${p}${prefix}-${yymm}-%`);
  return nextMonthlyDocNo(`${p}${prefix}-${yymm}`, ((existing ?? []) as Array<{ invoice_number: string }>).map((r) => r.invoice_number));
};

/* ── Recompute PI header money rollups (mirror recomputeGrnTotals) ─────────
   Sum line_total_centi across purchase_invoice_items → write subtotal_centi,
   then total_centi = subtotal + tax_centi (PI carries a stored tax that GRN
   does NOT, so we ADD it into total here). paid_centi is untouched — Balance
   (total - paid) is derived in the UI; payment recording stays on /payment. */
async function recomputePiTotals(sb: any, piId: string) {
  const [itemsRes, headerRes] = await Promise.all([
    sb.from('purchase_invoice_items').select('line_total_centi').eq('purchase_invoice_id', piId),
    sb.from('purchase_invoices').select('tax_centi').eq('id', piId).maybeSingle(),
  ]);
  const subtotal = (itemsRes.data ?? []).reduce((s: number, r: any) => s + (r.line_total_centi ?? 0), 0);
  const tax = (headerRes.data as { tax_centi?: number } | null)?.tax_centi ?? 0;
  await sb.from('purchase_invoices').update({
    subtotal_centi: subtotal,
    total_centi: subtotal + tax,
    updated_at: new Date().toISOString(),
  }).eq('id', piId);
}

/* ── Self-heal GRN invoiced counter (live-count model, mirrors recomputeSoPicked
   / recomputePoReceived) ────────────────────────────────────────────────────
   For each given grn_item, RECOUNT invoiced_qty from scratch as the sum of qty
   across ALL live (non-cancelled) PI lines that point at it. This replaces the
   old delta-based +/- arithmetic so create / edit / delete / cancel all
   converge to the truth and the GRN line auto-releases for re-invoicing the
   moment its PI lines go away. Clamped to [0, qty_accepted]. Best-effort. */
async function recomputeGrnInvoiced(sb: any, grnItemIds: Array<string | null | undefined>) {
  const ids = [...new Set(grnItemIds.filter((x): x is string => Boolean(x)))];
  if (ids.length === 0) return;

  // Best-effort, never throws (Commander 2026-05-30): the primary write already
  // committed. If this secondary recount hiccups we log + skip — the live-count
  // model self-heals on the next operation that touches these GRN lines.
  try {
    // 1. Sum qty from live (non-cancelled) PI lines per GRN item.
    const { data: plines } = await sb.from('purchase_invoice_items')
      .select('grn_item_id, qty, purchase_invoice_id')
      .in('grn_item_id', ids);
    const rows = (plines ?? []) as Array<{ grn_item_id: string; qty: number; purchase_invoice_id: string }>;
    const piIds = [...new Set(rows.map((r) => r.purchase_invoice_id).filter(Boolean))];
    /* LEAK GUARD (DRAFT, PI two-state — 2026-06-25 anchoring diff vs 2990) — exclude
       DRAFT as well as CANCELLED PIs from the invoiced_qty recount. A DRAFT PI
       consumes NO GRN qty until it's confirmed (the confirm transition flips it to
       POSTED and re-runs this recount, at which point its lines DO count). Without
       this, a sibling op recounting the same GRN line would silently consume the
       line against a still-draft PI. */
    const excluded = new Set<string>();
    if (piIds.length > 0) {
      const { data: pis } = await sb.from('purchase_invoices').select('id, status').in('id', piIds);
      for (const p of (pis ?? []) as Array<{ id: string; status: string }>) {
        if (p.status === 'CANCELLED' || p.status === 'DRAFT') excluded.add(p.id);
      }
    }
    const invByGrnItem = new Map<string, number>(ids.map((id) => [id, 0]));
    for (const r of rows) {
      if (excluded.has(r.purchase_invoice_id)) continue;
      invByGrnItem.set(r.grn_item_id, (invByGrnItem.get(r.grn_item_id) ?? 0) + Number(r.qty ?? 0));
    }

    // 2. Clamp into [0, qty_accepted] per line, then write.
    const { data: giRows } = await sb.from('grn_items')
      .select('id, qty_accepted').in('id', ids);
    const acceptedById = new Map<string, number>(
      ((giRows ?? []) as Array<{ id: string; qty_accepted: number }>).map((g) => [g.id, g.qty_accepted ?? 0]),
    );
    await Promise.all([...invByGrnItem.entries()].map(([giId, inv]) => {
      const capped = Math.min(acceptedById.get(giId) ?? inv, Math.max(0, inv));
      return sb.from('grn_items').update({ invoiced_qty: capped }).eq('id', giId);
    }));
  } catch (e) {
    console.error('[recomputeGrnInvoiced] best-effort recount failed', { grnItemIds: ids, error: e });
  }
}

/* ── verifyGrnLinesNotOverInvoiced (post-insert over-invoice race guard) ─────
   The bulk PI create paths (POST /, /from-grn-items, /from-grn) only PRE-check
   each GRN line's remaining before inserting — a read-then-write race: two
   concurrent bulk creates against the same GRN line can each pass the pre-check
   and both insert → the line is over-billed past (qty_accepted - returned_qty).
   After committing THIS PI's lines, re-sum the LIVE invoiced qty (across ALL
   non-cancelled PI lines) per GRN line; if any exceeds its cap, OUR insert broke
   it → delete THIS PI's just-created lines and signal the caller to 409. Mirrors
   the single add-line path (POST /:id/items). Returns the offending lines, or []
   when every GRN line is within cap. */
async function verifyGrnLinesNotOverInvoiced(
  sb: any,
  grnItemIds: Array<string | null | undefined>,
): Promise<Array<{ grnItemId: string; invoiced: number; cap: number }>> {
  const ids = [...new Set(grnItemIds.filter((x): x is string => Boolean(x)))];
  if (ids.length === 0) return [];
  // Cap per GRN line = qty_accepted - returned_qty.
  const { data: giRows } = await sb.from('grn_items')
    .select('id, qty_accepted, returned_qty').in('id', ids);
  const capById = new Map<string, number>(
    ((giRows ?? []) as Array<{ id: string; qty_accepted: number; returned_qty: number }>)
      .map((g) => [g.id, (g.qty_accepted ?? 0) - (g.returned_qty ?? 0)]),
  );
  // Live invoiced per GRN line = sum(qty) across all committed (non-cancelled,
  // non-draft) PI lines.
  const { data: sib } = await sb.from('purchase_invoice_items')
    .select('grn_item_id, qty, purchase_invoice_id').in('grn_item_id', ids);
  const sibRows = (sib ?? []) as Array<{ grn_item_id: string; qty: number; purchase_invoice_id: string }>;
  const piIds = [...new Set(sibRows.map((r) => r.purchase_invoice_id).filter(Boolean))];
  /* LEAK GUARD (DRAFT, PI two-state — 2026-06-25 anchoring diff vs 2990) — exclude
     DRAFT as well as CANCELLED from the over-invoice cap re-sum: a DRAFT PI consumes
     no GRN qty, so it never counts against the qty_accepted-returned cap. The cap is
     re-checked at confirm (recomputeGrnInvoiced clamps to qty_accepted), so a DRAFT
     that would over-bill is caught the moment it's confirmed, not while still a
     draft. */
  const excluded = new Set<string>();
  if (piIds.length > 0) {
    const { data: pis } = await sb.from('purchase_invoices').select('id, status').in('id', piIds);
    for (const p of (pis ?? []) as Array<{ id: string; status: string }>) {
      if (p.status === 'CANCELLED' || p.status === 'DRAFT') excluded.add(p.id);
    }
  }
  const liveByGrnItem = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const r of sibRows) {
    if (excluded.has(r.purchase_invoice_id)) continue;
    liveByGrnItem.set(r.grn_item_id, (liveByGrnItem.get(r.grn_item_id) ?? 0) + Number(r.qty ?? 0));
  }
  const over: Array<{ grnItemId: string; invoiced: number; cap: number }> = [];
  for (const id of ids) {
    const invoiced = liveByGrnItem.get(id) ?? 0;
    const cap = capById.get(id) ?? invoiced;
    if (invoiced > cap) over.push({ grnItemId: id, invoiced, cap });
  }
  return over;
}

/* PI edit-lock guard: a PI with ANY payment recorded (paid_centi > 0) or that's
   CANCELLED is read-only. Returns the blocking JSON response, or null if the PI
   is editable. */
async function piLocked(sb: any, piId: string): Promise<{ error: string; message: string } | null> {
  const { data } = await sb.from('purchase_invoices')
    .select('paid_centi, status').eq('id', piId).maybeSingle();
  if (!data) return null; // not found — let the handler's own load surface 404
  const row = data as { paid_centi: number | null; status: string };
  if (row.status === 'CANCELLED') return { error: 'pi_cancelled', message: 'Invoice is cancelled' };
  if ((row.paid_centi ?? 0) > 0) return { error: 'pi_locked', message: 'Invoice has a payment recorded — locked' };
  return null;
}

/* Filter-pill bucket → the raw purchase_invoices.status values it covers. Single
   source of truth for BOTH the status-count queries and the list `status`
   filter. All five buckets are 1:1 today, but the FE sends the BUCKET NAME as
   `status`; a raw DB status still works (backward-compatible fallback). */
const PI_STATUS_BUCKETS: Record<string, string[]> = {
  draft: ['DRAFT'],
  posted: ['POSTED'],
  partial: ['PARTIALLY_PAID'],
  paid: ['PAID'],
  cancelled: ['CANCELLED'],
};

purchaseInvoices.get('/', async (c) => {
  const sb = c.get('supabase');
  const SELECT = `${HEADER}, supplier:suppliers(id, code, name), purchase_order:purchase_orders(id, po_number), grn:grns(id, grn_number)`;

  /* Opt-in server-side pagination + search + sort + status-counts (mirrors the
     SO list in mfg-sales-orders.ts). The PRESENCE of `page` switches paging on;
     when it is absent/empty the query below is BYTE-IDENTICAL to the historical
     behavior (order invoice_date desc, limit 500, status param, company scope,
     `{ purchaseInvoices }` shape). */
  const pageRaw = c.req.query('page');
  const paginate = pageRaw !== undefined && pageRaw !== '';

  if (!paginate) {
    /* --- LEGACY PATH (unchanged) --- */
    let q = sb.from('purchase_invoices')
      .select(SELECT)
      .order('invoice_date', { ascending: false })
      // Bound the result so PostgREST's default 1000-row cap can't silently
      // truncate the PI list — match the SO/DO/SI list convention.
      .limit(500);
    const status = c.req.query('status'); if (status) q = q.eq('status', status);
    q = scopeToCompany(q, c); // multi-company: isolate to the active company
    const { data, error } = await q;
    if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
    return c.json({ purchaseInvoices: data ?? [] });
  }

  /* --- PAGINATED PATH (opt-in via `page`) --- */
  const page = Math.max(0, Math.trunc(Number(pageRaw)) || 0);
  const psRaw = Number(c.req.query('pageSize'));
  const pageSize = Number.isFinite(psRaw) && psRaw > 0 ? Math.min(100, Math.max(1, Math.trunc(psRaw))) : 50;

  const SORT_COLS = new Set(['invoice_date', 'invoice_number', 'status', 'total_centi']);
  const [rawCol, rawDir] = (c.req.query('sort') ?? 'invoice_date:desc').split(':');
  const sortCol = SORT_COLS.has(rawCol) ? rawCol : 'invoice_date';
  const sortAsc = rawDir === 'asc';

  let q = sb.from('purchase_invoices').select(SELECT, { count: 'exact' }).order(sortCol, { ascending: sortAsc });
  /* unique tiebreaker so range paging can't skip/repeat rows sharing the sort key */
  if (sortCol !== 'invoice_number') q = q.order('invoice_number', { ascending: sortAsc });
  /* Resolve the incoming `status`: a known bucket key → all its raw statuses;
     'all'/empty → no filter; otherwise treat it as a raw DB status. */
  const status = c.req.query('status');
  if (status && status !== 'all') {
    if (PI_STATUS_BUCKETS[status]) q = q.in('status', PI_STATUS_BUCKETS[status]);
    else q = q.eq('status', status);
  }
  q = scopeToCompany(q, c); // multi-company: isolate to the active company
  /* free-text search over the base-table text columns the FE searches
     (PurchaseInvoicesListV2 hay). Supplier name / PO / GRN source are embedded
     resources, not base purchase_invoices columns, so they can't be ilike'd here. */
  const search = c.req.query('q');
  if (search) {
    const s = escapeForOr(search);
    if (s) q = q.or(`invoice_number.ilike.%${s}%,supplier_invoice_ref.ilike.%${s}%,notes.ilike.%${s}%`);
  }
  const from = c.req.query('from'); if (from) q = q.gte('invoice_date', from);
  const to = c.req.query('to'); if (to) q = q.lte('invoice_date', to);
  q = q.range(page * pageSize, page * pageSize + pageSize - 1);
  const { data, error, count } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const total = count ?? (data?.length ?? 0);

  /* Status counts mirror the FE filter-pill buckets (draft / posted / partial /
     paid / cancelled) over the SAME company filter but WITHOUT status / search /
     pagination. */
  const countBase = () => scopeToCompany(sb.from('purchase_invoices').select('*', { count: 'exact', head: true }), c);
  const [allC, draftC, postedC, partialC, paidC, cancelledC] = await Promise.all([
    countBase(),
    countBase().in('status', PI_STATUS_BUCKETS.draft),
    countBase().in('status', PI_STATUS_BUCKETS.posted),
    countBase().in('status', PI_STATUS_BUCKETS.partial),
    countBase().in('status', PI_STATUS_BUCKETS.paid),
    countBase().in('status', PI_STATUS_BUCKETS.cancelled),
  ]);
  const statusCounts = {
    all: allC.count ?? 0,
    draft: draftC.count ?? 0,
    posted: postedC.count ?? 0,
    partial: partialC.count ?? 0,
    paid: paidC.count ?? 0,
    cancelled: cancelledC.count ?? 0,
  };

  return c.json({ purchaseInvoices: data ?? [], total, page, pageSize, statusCounts });
});

/* ── GET /outstanding-grn-items ─────────────────────────────────────────
   Returns GRN LINES eligible for invoicing. Migration 0106 added
   grn_items.invoiced_qty, so this now tracks PER-LINE remaining (Commander
   2026-05-30 unified consumption model): for each grn_item from a POSTED GRN
   we return remaining = qty_accepted - invoiced_qty and include only lines
   with remaining > 0. A GRN line can be invoiced across MULTIPLE PIs until
   fully consumed (replaces the old header-level all-or-nothing dedupe).

   IMPORTANT (route ordering): this STATIC path MUST be registered before
   the `/:id` param route below — otherwise Hono matches `/:id` first and
   tries to cast "outstanding-grn-items" to a uuid → 500. (Bug fix
   2026-05-28, same class as the PO-from-SO shadowing.) */
purchaseInvoices.get('/outstanding-grn-items', async (c) => {
  const sb = c.get('supabase');
  // Pull every POSTED GRN with its supplier + parent PO so we can group
  // and present in the picker.
  const { data: grnHeaders, error: hErr } = await scopeToCompany(
    sb
      .from('grns')
      .select(`
      id, grn_number, received_at, supplier_id, purchase_order_id,
      supplier:suppliers ( code, name ),
      purchase_order:purchase_orders ( po_number )
    `),
    c,
  )
    .eq('status', 'POSTED')
    .order('received_at', { ascending: false })
    .limit(500);
  if (hErr) return c.json({ error: 'load_failed', reason: hErr.message }, 500);
  const headers = (grnHeaders ?? []) as unknown as Array<{
    id: string; grn_number: string; received_at: string; supplier_id: string;
    purchase_order_id: string | null;
    supplier: { code: string; name: string } | null;
    purchase_order: { po_number: string } | null;
  }>;
  if (headers.length === 0) return c.json({ items: [] });

  // Load the GRN items for every POSTED GRN. Per-line remaining tracking
  // (migration 0106) replaces the header-level dedupe — a partially-invoiced
  // GRN keeps surfacing its lines that still have remaining > 0.
  const grnIds = headers.map((h) => h.id);
  const { data: items, error: iErr } = await sb
    .from('grn_items')
    .select(`
      id, grn_id, material_kind, material_code, material_name, item_group,
      description, qty_accepted, qty_rejected, invoiced_qty, returned_qty, unit_price_centi, variants
    `)
    .in('grn_id', grnIds);
  if (iErr) return c.json({ error: 'load_failed', reason: iErr.message }, 500);

  const headerById = new Map(headers.map((h) => [h.id, h]));
  const out = ((items ?? []) as Array<{
    id: string; grn_id: string; material_kind: string; material_code: string;
    material_name: string; item_group: string | null; description: string | null;
    qty_accepted: number; qty_rejected: number; invoiced_qty: number; returned_qty: number;
    unit_price_centi: number; variants: unknown;
  }>)
    .map((r) => {
      const invoiced = r.invoiced_qty ?? 0;
      const returned = r.returned_qty ?? 0;
      const remaining = (r.qty_accepted ?? 0) - invoiced - returned;
      return { ...r, _remaining: remaining };
    })
    .filter((r) => r._remaining > 0)
    .map((r) => {
      const h = headerById.get(r.grn_id)!;
      return {
        grnItemId:      r.id,
        grnId:          r.grn_id,
        grnDocNo:       h.grn_number,
        receivedAt:     h.received_at,
        supplierId:     h.supplier_id,
        supplierCode:   h.supplier?.code ?? '',
        supplierName:   h.supplier?.name ?? '',
        purchaseOrderId: h.purchase_order_id,
        poDocNo:        h.purchase_order?.po_number ?? null,
        itemCode:       r.material_code,
        description:    r.description ?? r.material_name,
        itemGroup:      r.item_group ?? '',
        qtyAccepted:    r.qty_accepted,
        invoicedQty:    r.invoiced_qty ?? 0,
        remaining:      r._remaining,
        unitPriceCenti: r.unit_price_centi,
        variants:       r.variants,
      };
    });

  return c.json({ items: out });
});

purchaseInvoices.get('/:id', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  const [h, i] = await Promise.all([
    sb.from('purchase_invoices').select(`${HEADER}, supplier:suppliers(id, code, name)`).eq('id', id).maybeSingle(),
    sb.from('purchase_invoice_items').select(ITEM).eq('purchase_invoice_id', id).order('created_at'),
  ]);
  if (h.error) return c.json({ error: 'load_failed', reason: h.error.message }, 500);
  if (!h.data) return c.json({ error: 'not_found' }, 404);
  /* Canonical SKU/build order at READ (sofa modules LHF→NA→RHF, mains→
     accessories→services), mirroring the SO detail GET. The shared helper keys
     on `item_code`; PI lines expose `material_code`, so sort a shimmed view
     that carries the original row back unchanged. `.order('created_at')` above
     stays as the stable tiebreaker — pure ordering, no persistence touched. */
  type PiItemRow = Record<string, unknown> & { id: string; material_code: string; item_code: string };
  const items = orderSofaModuleRowsWithinBuilds(
    sortSoLinesByGroupRank(
      ((i.data ?? []) as unknown as Array<Record<string, unknown> & { id: string; material_code: string }>)
        .map((it): PiItemRow => ({ ...it, item_code: it.material_code })),
      (r) => r.item_group as string | null | undefined,
    ),
  );
  return c.json({ purchaseInvoice: h.data, items });
});

// ── Linked docs (Smart Buttons fan-out) ─────────────────────────────
// For a PI: the parent GRN + parent PO (both via FK on purchase_invoices).
purchaseInvoices.get('/:id/linked', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  const { data, error } = await sb
    .from('purchase_invoices')
    .select(`
      id,
      grn:grns(id, grn_number),
      purchase_order:purchase_orders(id, po_number)
    `)
    .eq('id', id)
    .maybeSingle();
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if (!data) return c.json({ error: 'not_found' }, 404);
  // Supabase typegen returns joined rows as arrays even for to-one FKs.
  const raw = data as unknown as {
    grn?: { id: string; grn_number: string } | Array<{ id: string; grn_number: string }> | null;
    purchase_order?: { id: string; po_number: string } | Array<{ id: string; po_number: string }> | null;
  };
  const grn: { id: string; grn_number: string } | null =
    Array.isArray(raw.grn) ? (raw.grn[0] ?? null) : (raw.grn ?? null);
  const po: { id: string; po_number: string } | null =
    Array.isArray(raw.purchase_order) ? (raw.purchase_order[0] ?? null) : (raw.purchase_order ?? null);
  return c.json({ grn, purchaseOrder: po });
});

purchaseInvoices.post('/', async (c) => {
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (!body.supplierId) return c.json({ error: 'supplier_required' }, 400);
  const items = body.items as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(items) || !items.length) return c.json({ error: 'items_required' }, 400);

  /* DRAFT lifecycle (re-added per the full 6-doc Draft/Confirmed plan; reverses
     migration 0078's PI DRAFT removal). asDraft is opt-in per request — a normal
     create still defaults to POSTED (the committed state), exactly like SO. A
     DRAFT PI commits NOTHING: no GRN-line consume, no GL post, no recost. Those
     all move to the confirm transition (PATCH /:id/post). */
  const asDraft = body.asDraft === true;

  const sb = c.get('supabase'); const user = c.get('user');

  /* Over-invoice guard (mirrors /from-grn-items line ~432 + /:id/items): any
     line linked to a GRN line is capped at that line's REMAINING
     (qty_accepted - invoiced_qty - returned_qty). Sum requested qty per GRN
     line first, since the same GRN line can appear twice in one PI. Without
     this the ?grnId= draft path could over-bill or double-invoice. */
  {
    const wantByGrnItem = new Map<string, number>();
    for (const it of items) {
      const gid = (it.grnItemId as string | undefined) ?? null;
      if (!gid) continue;
      wantByGrnItem.set(gid, (wantByGrnItem.get(gid) ?? 0) + Number(it.qty ?? 0));
    }
    const gids = [...wantByGrnItem.keys()];
    if (gids.length > 0) {
      const { data: giRows } = await sb.from('grn_items')
        .select('id, qty_accepted, invoiced_qty, returned_qty').in('id', gids);
      const byId = new Map<string, { qty_accepted: number; invoiced_qty: number; returned_qty: number }>(
        ((giRows ?? []) as Array<{ id: string; qty_accepted: number; invoiced_qty: number; returned_qty: number }>)
          .map((g) => [g.id, g]),
      );
      const over: Array<{ grnItemId: string; requested: number; remaining: number }> = [];
      for (const [gid, want] of wantByGrnItem.entries()) {
        const g = byId.get(gid);
        if (!g) return c.json({ error: 'item_not_found', grnItemId: gid }, 400);
        const remaining = (g.qty_accepted ?? 0) - (g.invoiced_qty ?? 0) - (g.returned_qty ?? 0);
        if (want > remaining) over.push({ grnItemId: gid, requested: want, remaining });
      }
      if (over.length > 0) {
        return c.json({ error: 'qty_exceeds_remaining', lines: over }, 409);
      }
    }
  }

  let subtotal = 0;
  const itemRows = items.map((it) => {
    /* PI discount unification (audit 2026-06-11 M3) — ONE rule on every PI
       line write path: line_total_centi = qty × unit − discount, discount
       stored. This path used to drop the client discount entirely (totals
       overstated whenever the form sent one). */
    const qty = Number(it.qty ?? 0); const unit = Number(it.unitPriceCenti ?? 0);
    const discount = Number(it.discountCenti ?? 0) || 0;
    // Audit (ported from 2990 20190257) — clamp like the PO create path (negative-money guard).
    const total = Math.max(0, qty * unit - discount); subtotal += total;
    return {
      material_kind: it.materialKind,
      material_code: it.materialCode,
      material_name: it.materialName,
      qty, unit_price_centi: unit, discount_centi: discount, line_total_centi: total,
      grn_item_id: (it.grnItemId as string | undefined) ?? null,
      notes: (it.notes as string | undefined) ?? null,
      // Commander 2026-05-29 — manual PI lines carry their category + variant
      // selections so the PI mirrors WHAT was billed (same as the from-grn-items
      // path). Columns exist on purchase_invoice_items (migration 0057).
      item_group: (it.itemGroup as string | null | undefined) ?? null,
      variants: (it.variants as Record<string, unknown> | null | undefined) ?? null,
    };
  });

  /* PR-DRAFT-removal — PIs are now created as POSTED directly. PI is
     AP-only (no inventory impact — that landed at GRN time), so there's
     no side-effect helper to call after insert. */
  /* Migration 0082 — the PI's currency (MYR default) + its exchange_rate (MYR per
     1 unit of that currency). The rate auto-fills from the currency MASTER unless
     the body sends one; MYR ⇒ rate 1 (a strict no-op — the AP GL post converts at
     this rate). */
  const piCurrency = normalizeCurrency(body.currency);
  const piRateRaw = body.exchangeRate !== undefined && body.exchangeRate !== null
    ? body.exchangeRate
    : await masterRateForCurrency(sb, piCurrency);
  const piExchangeRate = normalizeExchangeRate(piRateRaw, piCurrency);
  const { data: header, error: hErr } = await insertWithDocNoRetry<{ id: string; invoice_number: string }>(
    () => nextNum(sb, 'PI', c),
    (invoiceNumber) => sb.from('purchase_invoices').insert({
    company_id: activeCompanyId(c), // multi-company: stamp the active company
    invoice_number: invoiceNumber,
    supplier_invoice_ref: (body.supplierInvoiceRef as string) ?? null,
    supplier_id: body.supplierId,
    purchase_order_id: (body.purchaseOrderId as string) ?? null,
    grn_id: (body.grnId as string) ?? null,
    invoice_date: (body.invoiceDate as string) ?? todayMyt(),
    due_date: (body.dueDate as string) ?? null,
    currency: piCurrency,
    exchange_rate: piExchangeRate,
    subtotal_centi: subtotal,
    total_centi: subtotal,
    notes: (body.notes as string) ?? null,
    status: asDraft ? 'DRAFT' : 'POSTED',
    posted_at: asDraft ? null : new Date().toISOString(),
    created_by: user.id,
    }).select(HEADER).single(),
  );
  if (hErr) return c.json({ error: 'insert_failed', reason: hErr.message }, 500);
  const h = header as unknown as { id: string; invoice_number: string };

  const rowsWithId = itemRows.map((r) => ({ ...r, purchase_invoice_id: h.id }));
  const { error: iErr } = await sb.from('purchase_invoice_items').insert(stampCompany(rowsWithId, c));
  if (iErr) { await sb.from('purchase_invoices').delete().eq('id', h.id); return c.json({ error: 'items_insert_failed', reason: iErr.message }, 500); }

  /* Post-insert over-invoice verification (race guard) — the pre-check above is
     read-before-write; re-sum live invoiced per GRN line now that OUR lines are
     committed. If any GRN line is over its cap, delete THIS PI (header cascades
     its lines) + 409. Mirrors POST /:id/items. */
  {
    const over = await verifyGrnLinesNotOverInvoiced(sb, itemRows.map((r) => r.grn_item_id));
    if (over.length > 0) {
      await sb.from('purchase_invoices').delete().eq('id', h.id);
      return c.json({ error: 'qty_exceeds_remaining', lines: over }, 409);
    }
  }
  /* LEAK GUARD (DRAFT) — a DRAFT PI commits nothing: it must NOT consume the GRN
     line (recomputeGrnInvoiced) nor re-cost (recostForPi). Both move to the
     confirm transition (PATCH /:id/post). GL/AP posting (postPiAccounting) is
     ALSO skipped for DRAFT — but note PI never auto-posts the GL on create even
     when POSTED (it posts only on demand via /post/pi), so there's no GL call to
     gate here on this path; the confirm transition is where it now posts. */
  if (!asDraft) {
    // Self-heal the GRN invoiced counter so the just-billed lines drop out of the
    // outstanding picker (mirrors /from-grn-items line ~523 + /:id/items).
    await recomputeGrnInvoiced(sb, itemRows.map((r) => r.grn_item_id));
    // Costing B — a new PI is the authoritative cost: re-cost the GRN's lots →
    // consumptions → movements → DO → SI so a shipped order's margin reflects the
    // billed price (or its later correction) in real time.
    await recostForPi(sb, h.id);
  }
  return c.json({ id: h.id, invoiceNumber: h.invoice_number }, 201);
});

/* ── PATCH /:id/post — CONFIRM transition (DRAFT → POSTED) ───────────────────
   This is where a DRAFT PI commits. It mirrors the SO confirm: an atomic
   DRAFT → POSTED flip, then the side-effects that a DRAFT deliberately skipped
   on create now run exactly once here:
     · recomputeGrnInvoiced  — consume the source GRN lines (drop them out of the
       outstanding picker) — the SAME chokepoint POST/ runs for a non-DRAFT PI.
     · postPiAccounting       — post Dr Inventory 1200 / Cr Payables 2000 (AP/GL).
     · recostForPi            — push the billed price down the lots → DO → SI.
   Idempotent + back-compat: a PI already POSTED (e.g. created non-DRAFT) echoes
   back without re-committing — postPiAccounting is itself idempotent (keyed on an
   active PI JE) and recomputeGrnInvoiced is a from-scratch recount, so a stray
   double-call can't double-bill. */
purchaseInvoices.patch('/:id/post', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  const { data: cur } = await sb.from('purchase_invoices').select('id, status, invoice_number').eq('id', id).maybeSingle();
  if (!cur) return c.json({ error: 'not_found' }, 404);
  const curRow = cur as { id: string; status: string; invoice_number: string };
  // Already POSTED (or beyond — PARTIALLY_PAID / PAID) → nothing to confirm.
  if (curRow.status !== 'DRAFT') return c.json({ purchaseInvoice: cur });

  /* Atomic single DRAFT → POSTED transition — the conditional UPDATE only fires
     when the row is still DRAFT, so two concurrent confirms race and exactly ONE
     flips it (the other gets no row → idempotent echo). This guarantees the
     GRN-consume + GL post + recost below run exactly once. */
  const { data, error } = await sb.from('purchase_invoices').update({
    status: 'POSTED', posted_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq('id', id).eq('status', 'DRAFT').select('id, status').maybeSingle();
  if (error) return c.json({ error: 'post_failed', reason: error.message }, 500);
  if (!data) {
    // Lost the race — a concurrent confirm already flipped it. Echo the live row.
    const { data: now } = await sb.from('purchase_invoices').select('id, status').eq('id', id).maybeSingle();
    return c.json({ purchaseInvoice: now ?? cur });
  }

  // COMMIT (was skipped at DRAFT create). Consume the GRN lines so the just-billed
  // rows drop out of the outstanding picker.
  const { data: lines } = await sb.from('purchase_invoice_items')
    .select('grn_item_id').eq('purchase_invoice_id', id);
  const grnItemIds = (lines ?? []).map((l: { grn_item_id: string | null }) => l.grn_item_id);
  await recomputeGrnInvoiced(sb, grnItemIds);
  // Post the AP/GL entry (Dr Inventory 1200 / Cr Payables 2000). Best-effort —
  // idempotent + a post failure never un-confirms the PI.
  const postRes = await postPiAccounting(sb, curRow.invoice_number);
  if (!postRes.ok) {
    // eslint-disable-next-line no-console
    console.error(`[pi-accounting] confirm post failed for ${curRow.invoice_number}:`, postRes.status, postRes.reason);
  }
  // Costing B — the now-confirmed PI is the authoritative cost: re-cost lots/DO/SI.
  await recostForPi(sb, id);
  return c.json({ purchaseInvoice: data });
});

// Record a payment against the PI. Adds to paid_centi and auto-transitions
// status: paid_centi == total → PAID, paid_centi > 0 && < total → PARTIALLY_PAID.
purchaseInvoices.patch('/:id/payment', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  let body: { amountCenti?: number; notes?: string };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const amount = Number(body.amountCenti ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) return c.json({ error: 'invalid_amount' }, 400);

  // Optimistic-concurrency loop (Bug#5, ported from 2990 1355332c). The old code
  // did read-modify-write — two payments hitting the SAME PI at once both read X
  // and both wrote X+amount, silently LOSING one. PI has no payment ledger to
  // re-sum (unlike SI's recomputePaid), and PostgREST can't do `col = col + x`,
  // so we gate the UPDATE on `paid_centi = <the value we just read>`: if a
  // concurrent payment moved it, the update matches 0 rows and we retry with a
  // fresh read.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const { data: cur } = await sb.from('purchase_invoices')
      .select('paid_centi, total_centi, status').eq('id', id).maybeSingle();
    if (!cur) return c.json({ error: 'not_found' }, 404);
    const c0 = cur as { paid_centi: number; total_centi: number; status: string };
    // LEAK GUARD (DRAFT) — a DRAFT PI is not yet a real liability; reject payment
    // until it's confirmed. (Re-added with the DRAFT lifecycle — see POST/.)
    if (c0.status === 'DRAFT') return c.json({ error: 'not_payable', message: 'PI is a draft — confirm it before recording payment' }, 409);
    if (c0.status === 'CANCELLED') return c.json({ error: 'not_payable', message: 'PI is cancelled' }, 409);

    const newPaid = c0.paid_centi + amount;
    const newStatus = newPaid >= c0.total_centi ? 'PAID' : 'PARTIALLY_PAID';

    const { data, error } = await sb.from('purchase_invoices').update({
      paid_centi: newPaid, status: newStatus, updated_at: new Date().toISOString(),
    })
      .eq('id', id)
      .eq('paid_centi', c0.paid_centi) // only if nobody else moved it since the read
      .select('id, paid_centi, status');
    if (error) return c.json({ error: 'payment_failed', reason: error.message }, 500);
    if (data && data.length > 0) return c.json({ purchaseInvoice: data[0] });
    // 0 rows updated → a concurrent payment changed paid_centi; loop re-reads + retries.
  }
  return c.json({ error: 'payment_conflict', message: 'Another payment was recorded at the same moment — please check the balance and retry.' }, 409);
});

purchaseInvoices.patch('/:id/cancel', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');

  // Read → guard → release → cancel. Keep the existing PAID guard; a PI with
  // any payment can't be cancelled.
  const { data: cur } = await sb.from('purchase_invoices')
    .select('id, status, paid_centi').eq('id', id).maybeSingle();
  if (!cur) return c.json({ error: 'not_found' }, 404);
  const head = cur as { id: string; status: string; paid_centi: number | null };
  if (head.status === 'PAID' || (head.paid_centi ?? 0) > 0) {
    return c.json({ error: 'cannot_cancel', message: 'PI already paid' }, 409);
  }
  // Idempotent — already cancelled, echo back without re-releasing.
  if (head.status === 'CANCELLED') return c.json({ purchaseInvoice: { id, status: 'CANCELLED' } });

  /* LEAK GUARD (DRAFT) — a DRAFT PI never committed anything (no GL post, no
     GRN consume, no recost), so cancelling it is a plain status flip: skip the
     accounting reversal + GRN release + recost entirely (nothing to reverse). */
  if (head.status === 'DRAFT') {
    const { data: d } = await sb.from('purchase_invoices').update({
      status: 'CANCELLED', updated_at: new Date().toISOString(),
    }).eq('id', id).eq('status', 'DRAFT').select('id, status').maybeSingle();
    return c.json({ purchaseInvoice: d ?? { id, status: 'CANCELLED' } });
  }

  /* Bug #3/#11 — ATOMIC single ACTIVE→CANCELLED transition. The conditional
     UPDATE excludes both PAID and CANCELLED, so two concurrent cancels race on
     the same row and only ONE flips it (the other gets no row back → idempotent
     no-op). This guarantees the accounting reversal + GRN release below run
     exactly once, never double-reversing. .maybeSingle() (not .single()) so a
     lost race returns null instead of a PGRST116 throw. */
  const { data, error } = await sb.from('purchase_invoices').update({
    status: 'CANCELLED', updated_at: new Date().toISOString(),
  }).eq('id', id).neq('status', 'PAID').neq('status', 'CANCELLED').select('id, status, invoice_number').maybeSingle();
  if (error) return c.json({ error: 'cancel_failed', reason: error.message }, 500);
  if (!data) {
    // Lost the race (a concurrent cancel already flipped it) or it became PAID.
    // Re-read to distinguish: a CANCELLED row → idempotent success echo.
    const { data: now } = await sb.from('purchase_invoices').select('id, status').eq('id', id).maybeSingle();
    if ((now as { status: string } | null)?.status === 'CANCELLED') {
      return c.json({ purchaseInvoice: now });
    }
    return c.json({ error: 'cannot_cancel', message: 'PI already paid' }, 409);
  }
  const cancelled = data as { id: string; status: string; invoice_number: string };

  /* Bug #5 — reverse the PI accounting (Dr Inventory / Cr Payables → contra).
     "取消 PI 要追溯回去". Best-effort (audit-DLQ): a reversal failure never
     un-cancels the PI; it's idempotent so a retry / re-cancel converges. */
  const rev = await reversePiAccounting(sb, cancelled.invoice_number);
  if (!rev.ok) {
    // eslint-disable-next-line no-console
    console.error(`[pi-accounting] reversal failed for ${cancelled.invoice_number}:`, rev.status, rev.reason);
  }

  // Release the GRN-line consumption: recount invoiced_qty from live PI lines —
  // this cancelled PI's lines now drop out, auto-releasing the GRN line.
  const { data: lines } = await sb.from('purchase_invoice_items')
    .select('grn_item_id').eq('purchase_invoice_id', id);
  await recomputeGrnInvoiced(sb, (lines ?? []).map((l: { grn_item_id: string | null }) => l.grn_item_id));
  // Costing B — a cancelled PI is no longer the authoritative price; re-cost the
  // GRN so its buckets fall back to the GR price (or Pending), and DOs/SIs follow.
  await recostForPi(sb, id);
  return c.json({ purchaseInvoice: { id: cancelled.id, status: cancelled.status } });
});

/* ── POST /from-grn-items ───────────────────────────────────────────────
   Body: { picks: [{ grnItemId, qty }], supplierInvoiceNumber?, invoiceDate?,
           notes? }.
   Server logic:
     1. Load all selected GRN items with parent GRN (for supplier_id + po_id)
     2. Group by GRN (each PI has single grn_id FK → one PI per GRN)
     3. Create + auto-post one PI per GRN, with each PI scoped to one supplier
        (already true since a GRN has exactly one supplier).
   PI does NOT touch inventory (PI is AP-only — inventory landed at GRN time).
   Returns { created: [{ id, invoiceNumber, supplierId, grnCount, lineCount }], total }. */
purchaseInvoices.post('/from-grn-items', async (c) => {
  const sb = c.get('supabase'); const user = c.get('user');
  let body: {
    picks?: Array<{ grnItemId: string; qty: number }>;
    supplierInvoiceNumber?: string;
    invoiceDate?: string;
    dueDate?: string;
    notes?: string;
  };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const picks = body.picks ?? [];
  if (picks.length === 0) return c.json({ error: 'picks_required' }, 400);

  // Load picked GRN items + parent GRN headers.
  const ids = picks.map((p) => p.grnItemId);
  const { data: itemsData, error: itemsErr } = await sb
    .from('grn_items')
    .select(`
      id, grn_id, material_kind, material_code, material_name, item_group,
      description, description2, uom, qty_accepted, invoiced_qty, returned_qty, unit_price_centi,
      variants, gap_inches, divan_height_inches, divan_price_sen,
      leg_height_inches, leg_price_sen, custom_specials, line_suffix,
      special_order_price_sen, discount_centi,
      grn:grns!inner ( id, grn_number, supplier_id, purchase_order_id, status, currency, exchange_rate )
    `)
    .in('id', ids);
  if (itemsErr) return c.json({ error: 'load_failed', reason: itemsErr.message }, 500);

  type ItemRow = {
    id: string; grn_id: string; material_kind: string; material_code: string;
    material_name: string; item_group: string | null; description: string | null;
    description2: string | null; uom: string | null;
    qty_accepted: number; invoiced_qty: number; returned_qty: number; unit_price_centi: number;
    variants: unknown; gap_inches: number | null; divan_height_inches: number | null;
    divan_price_sen: number; leg_height_inches: number | null; leg_price_sen: number;
    custom_specials: unknown; line_suffix: string | null; special_order_price_sen: number;
    discount_centi: number;
    grn: { id: string; grn_number: string; supplier_id: string; purchase_order_id: string | null; status: string; currency?: string | null; exchange_rate?: string | number | null };
  };

  const itemList = (itemsData ?? []) as unknown as ItemRow[];
  const byId = new Map<string, ItemRow>();
  for (const r of itemList) byId.set(r.id, r);

  for (const p of picks) {
    const row = byId.get(p.grnItemId);
    if (!row) return c.json({ error: 'item_not_found', grnItemId: p.grnItemId }, 400);
    if (p.qty <= 0) return c.json({ error: 'qty_must_be_positive', grnItemId: p.grnItemId }, 400);
    // Cap each pick at the GRN line's REMAINING (qty_accepted - invoiced_qty -
    // returned_qty), not raw qty_accepted — a line can be invoiced across
    // multiple PIs, and returned-to-supplier qty is no longer invoiceable.
    const remaining = (row.qty_accepted ?? 0) - (row.invoiced_qty ?? 0) - (row.returned_qty ?? 0);
    if (p.qty > remaining) {
      return c.json({ error: 'qty_exceeds_remaining', grnItemId: p.grnItemId, requested: p.qty, remaining }, 409);
    }
    if (row.grn.status !== 'POSTED') {
      return c.json({ error: 'grn_not_posted', grnItemId: p.grnItemId, status: row.grn.status }, 409);
    }
  }

  // Group picks by GRN (each PI ↔ one GRN, per single FK).
  type Bucket = {
    grnId: string; grnNumber: string; supplierId: string; purchaseOrderId: string | null;
    currency: string; exchangeRate: number;
    lines: Array<{ row: ItemRow; qty: number }>;
  };
  const buckets = new Map<string, Bucket>();
  for (const p of picks) {
    const row = byId.get(p.grnItemId)!;
    // Migration 0082 — the PI inherits its source GRN's currency + exchange_rate
    // (the receipt already fixed the FX). MYR ⇒ rate 1, no-op.
    const grnCur = normalizeCurrency(row.grn.currency);
    const cur = buckets.get(row.grn.id) ?? {
      grnId: row.grn.id, grnNumber: row.grn.grn_number,
      supplierId: row.grn.supplier_id, purchaseOrderId: row.grn.purchase_order_id,
      currency: grnCur, exchangeRate: normalizeExchangeRate(row.grn.exchange_rate, grnCur),
      lines: [],
    };
    cur.lines.push({ row, qty: p.qty });
    buckets.set(row.grn.id, cur);
  }

  // Generate PI numbers sequentially within this batch.
  const d = new Date();
  const yymm = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`;
  // Seed from max(suffix), NOT count — count+1 is non-self-healing (a mid-month
  // delete re-mints a surviving number → UNIQUE collision). Derive the next
  // suffix via nextMonthlyDocNo, then counter starts one below it.
  const cp = companyDocPrefix(c);
  const { data: existingPiNos } = await sb.from('purchase_invoices').select('invoice_number').like('invoice_number', `${cp}PI-${yymm}-%`);
  let counter = parseInt(nextMonthlyDocNo(`${cp}PI-${yymm}`, ((existingPiNos ?? []) as Array<{ invoice_number: string }>).map((r) => r.invoice_number)).slice(`${cp}PI-${yymm}-`.length), 10) - 1;

  const invoiceDate = body.invoiceDate ?? todayMyt();
  const created: Array<{ id: string; invoiceNumber: string; supplierId: string; grnCount: number; lineCount: number }> = [];

  /* PI discount unification (audit 2026-06-11 M3) — ONE rule on every PI line
     write path: line_total_centi = qty × unit − discount, discount stored.
     The GRN line discount is pro-rated by billed qty over qty_accepted so a
     line billed across multiple PIs never subtracts more than the full GRN
     discount in total. (This path used to store the discount but exclude it
     from line_total + subtotal.) */
  const discFor = (row: ItemRow, qty: number) =>
    Math.round(Number(row.discount_centi ?? 0) * qty / (Number(row.qty_accepted) || 1));

  for (const bucket of buckets.values()) {
    counter += 1;
    // Audit (ported from 2990 b30f0bb1) — clamp each line before summing so a
    // discount > qty×price can't drive the PI subtotal negative.
    const subtotal = bucket.lines.reduce((s, { row, qty }) => s + Math.max(0, qty * row.unit_price_centi - discFor(row, qty)), 0);
    const piPayload = {
      company_id: activeCompanyId(c), // multi-company: stamp the active company
      supplier_invoice_ref: body.supplierInvoiceNumber ?? null,
      supplier_id: bucket.supplierId,
      purchase_order_id: bucket.purchaseOrderId,
      grn_id: bucket.grnId,
      invoice_date: invoiceDate,
      due_date: body.dueDate ?? null,
      currency: bucket.currency,
      exchange_rate: bucket.exchangeRate,
      subtotal_centi: subtotal,
      tax_centi: 0,
      total_centi: subtotal,
      // Auto-post per Commander preference (matches GRN/PO behaviour).
      status: 'POSTED',
      posted_at: new Date().toISOString(),
      notes: body.notes ? `Multi-pick from ${bucket.grnNumber} · ${body.notes}` : `Multi-pick from ${bucket.grnNumber}`,
      created_by: user.id,
    };
    /* Audit (ported from 2990 b30f0bb1) — concurrent PI creation can collide on
       invoice_number (UNIQUE); the old `if (hErr) continue` silently dropped the
       PI (GRN left un-billed, no AP posting). Retry on 23505: re-derive the next
       free suffix from a fresh live count + bump. */
    let h: { id: string; invoice_number: string } | null = null;
    for (let attempt = 0; attempt < 8 && !h; attempt += 1) {
      const invoiceNumber = `${cp}PI-${yymm}-${String(counter).padStart(3, '0')}`;
      const { data: header, error: hErr } = await sb.from('purchase_invoices')
        .insert({ invoice_number: invoiceNumber, ...piPayload })
        .select('id, invoice_number').single();
      if (!hErr && header) { h = header as unknown as { id: string; invoice_number: string }; break; }
      if (!hErr || (hErr as { code?: string }).code !== '23505') break;
      const { data: live } = await sb.from('purchase_invoices')
        .select('invoice_number').like('invoice_number', `${cp}PI-${yymm}-%`);
      counter = parseInt(nextMonthlyDocNo(`${cp}PI-${yymm}`, ((live ?? []) as Array<{ invoice_number: string }>).map((r) => r.invoice_number)).slice(`${cp}PI-${yymm}-`.length), 10);
    }
    if (!h) continue;

    const rows = bucket.lines.map(({ row, qty }) => ({
      purchase_invoice_id: h.id,
      grn_item_id: row.id,
      material_kind: row.material_kind,
      material_code: row.material_code,
      material_name: row.material_name,
      qty,
      unit_price_centi: row.unit_price_centi,
      // Audit (ported from 2990 20190257) — clamp like the PO create path (negative-money guard).
      line_total_centi: Math.max(0, qty * row.unit_price_centi - discFor(row, qty)),
      item_group: row.item_group,
      description: row.description,
      description2: row.description2,
      uom: row.uom ?? 'UNIT',
      variants: row.variants,
      gap_inches: row.gap_inches,
      divan_height_inches: row.divan_height_inches,
      divan_price_sen: row.divan_price_sen ?? 0,
      leg_height_inches: row.leg_height_inches,
      leg_price_sen: row.leg_price_sen ?? 0,
      custom_specials: row.custom_specials,
      line_suffix: row.line_suffix,
      special_order_price_sen: row.special_order_price_sen ?? 0,
      discount_centi: discFor(row, qty),
    }));
    const { error: iErr } = await sb.from('purchase_invoice_items').insert(stampCompany(rows, c));
    if (iErr) {
      await sb.from('purchase_invoices').delete().eq('id', h.id);
      continue;
    }
    /* Post-insert over-invoice verification (race guard) — the per-pick pre-check
       above is read-before-write; re-sum live invoiced per GRN line now that this
       bucket's lines are committed. On overshoot, delete THIS PI (cascades its
       lines) and skip the bucket rather than over-bill the GRN line. */
    {
      const over = await verifyGrnLinesNotOverInvoiced(sb, bucket.lines.map(({ row }) => row.id));
      if (over.length > 0) {
        await sb.from('purchase_invoices').delete().eq('id', h.id);
        continue;
      }
    }
    // Consume the GRN lines: recount invoiced_qty from live PI lines.
    await recomputeGrnInvoiced(sb, bucket.lines.map(({ row }) => row.id));
    // Costing B — push the billed price down to the GRN's lots / DO / SI.
    await recostFromGrn(sb, bucket.grnId);
    created.push({
      id: h.id, invoiceNumber: h.invoice_number,
      supplierId: bucket.supplierId, grnCount: 1, lineCount: bucket.lines.length,
    });
  }

  return c.json({ created, total: created.length }, 201);
});

/* ── POST /from-grn ─────────────────────────────────────────────────────
   Single-GRN convert (GRN list right-click "Convert to PI"). Copies ALL of
   the GRN's accepted lines (with variants) into a new POSTED PI and returns
   the created PI's { id } so the caller can navigate straight to it. Mirrors
   from-grn-items but scoped to one whole GRN and returns a single id.

   Body: { grnId }  →  201 { id, invoiceNumber }. */
purchaseInvoices.post('/from-grn', async (c) => {
  const sb = c.get('supabase'); const user = c.get('user');
  let body: { grnId?: string };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const grnId = body.grnId;
  if (!grnId) return c.json({ error: 'grn_id_required' }, 400);

  const { data: grn, error: grnErr } = await sb.from('grns')
    .select('id, grn_number, supplier_id, purchase_order_id, status, currency, exchange_rate')
    .eq('id', grnId).maybeSingle();
  if (grnErr) return c.json({ error: 'load_failed', reason: grnErr.message }, 500);
  if (!grn) return c.json({ error: 'grn_not_found' }, 404);
  const g = grn as { id: string; grn_number: string; supplier_id: string; purchase_order_id: string | null; status: string; currency?: string | null; exchange_rate?: string | number | null };
  if (g.status !== 'POSTED') return c.json({ error: 'grn_not_posted', status: g.status }, 409);

  const { data: items, error: iErr } = await sb.from('grn_items')
    .select('id, material_kind, material_code, material_name, item_group, description, description2, uom, qty_accepted, invoiced_qty, returned_qty, unit_price_centi, variants, gap_inches, divan_height_inches, divan_price_sen, leg_height_inches, leg_price_sen, custom_specials, line_suffix, special_order_price_sen, discount_centi')
    .eq('grn_id', grnId)
    .gt('qty_accepted', 0);
  if (iErr) return c.json({ error: 'load_failed', reason: iErr.message }, 500);
  type GrnLine = {
    id: string; material_kind: string; material_code: string; material_name: string;
    item_group: string | null; description: string | null; description2: string | null;
    uom: string | null; qty_accepted: number; invoiced_qty: number; returned_qty: number; unit_price_centi: number; variants: unknown;
    gap_inches: number | null; divan_height_inches: number | null; divan_price_sen: number;
    leg_height_inches: number | null; leg_price_sen: number; custom_specials: unknown;
    line_suffix: string | null; special_order_price_sen: number; discount_centi: number;
  };
  // Only copy lines that still have remaining = qty_accepted - invoiced_qty -
  // returned_qty > 0, and bill the REMAINING qty (a GRN can be invoiced across
  // multiple PIs, 0106; returned-to-supplier qty is no longer invoiceable).
  const allLines = (items ?? []) as unknown as GrnLine[];
  const lines = allLines
    .map((it) => ({ ...it, _remaining: (it.qty_accepted ?? 0) - (it.invoiced_qty ?? 0) - (it.returned_qty ?? 0) }))
    .filter((it) => it._remaining > 0);
  if (lines.length === 0) return c.json({ error: 'nothing_to_invoice', message: 'GRN is fully invoiced' }, 400);

  /* PI discount unification (audit 2026-06-11 M3) — ONE rule on every PI line
     write path: line_total_centi = qty × unit − discount, discount stored.
     The GRN line discount is pro-rated by the billed (remaining) qty over
     qty_accepted so a second /from-grn pass over a partially-billed line
     can't subtract the full discount twice. */
  const discFor = (it: GrnLine & { _remaining: number }) =>
    Math.round(Number(it.discount_centi ?? 0) * it._remaining / (Number(it.qty_accepted) || 1));
  const subtotal = lines.reduce((s, it) => s + (it._remaining * it.unit_price_centi - discFor(it)), 0);

  const { data: header, error: hErr } = await insertWithDocNoRetry<{ id: string; invoice_number: string }>(
    () => nextNum(sb, 'PI', c),
    (invoiceNumber) => sb.from('purchase_invoices').insert({
    company_id: activeCompanyId(c), // multi-company: stamp the active company
    invoice_number: invoiceNumber,
    supplier_id: g.supplier_id,
    purchase_order_id: g.purchase_order_id,
    grn_id: g.id,
    invoice_date: todayMyt(),
    // Migration 0082 — inherit the source GRN's currency + rate (MYR ⇒ 1, no-op).
    currency: normalizeCurrency(g.currency),
    exchange_rate: normalizeExchangeRate(g.exchange_rate, normalizeCurrency(g.currency)),
    subtotal_centi: subtotal,
    tax_centi: 0,
    total_centi: subtotal,
    status: 'POSTED',
    posted_at: new Date().toISOString(),
    notes: `From ${g.grn_number}`,
    created_by: user.id,
    }).select('id, invoice_number').single(),
  );
  if (hErr) return c.json({ error: 'insert_failed', reason: hErr.message }, 500);
  const h = header as unknown as { id: string; invoice_number: string };

  const rows = lines.map((it) => ({
    purchase_invoice_id: h.id,
    grn_item_id: it.id,
    material_kind: it.material_kind,
    material_code: it.material_code,
    material_name: it.material_name,
    qty: it._remaining,
    unit_price_centi: it.unit_price_centi,
    // Audit (ported from 2990 20190257) — clamp like the PO create path (negative-money guard).
    line_total_centi: Math.max(0, it._remaining * it.unit_price_centi - discFor(it)),
    item_group: it.item_group,
    description: it.description,
    description2: it.description2,
    uom: it.uom ?? 'UNIT',
    variants: it.variants,
    gap_inches: it.gap_inches,
    divan_height_inches: it.divan_height_inches,
    divan_price_sen: it.divan_price_sen ?? 0,
    leg_height_inches: it.leg_height_inches,
    leg_price_sen: it.leg_price_sen ?? 0,
    custom_specials: it.custom_specials,
    line_suffix: it.line_suffix,
    special_order_price_sen: it.special_order_price_sen ?? 0,
    discount_centi: discFor(it),
  }));
  const { error: insErr } = await sb.from('purchase_invoice_items').insert(stampCompany(rows, c));
  if (insErr) { await sb.from('purchase_invoices').delete().eq('id', h.id); return c.json({ error: 'items_insert_failed', reason: insErr.message }, 500); }

  /* Post-insert over-invoice verification (race guard) — the remaining filter
     above is read-before-write; re-sum live invoiced per GRN line now that this
     PI's lines are committed. On overshoot, delete THIS PI (cascades its lines)
     + 409. */
  {
    const over = await verifyGrnLinesNotOverInvoiced(sb, lines.map((it) => it.id));
    if (over.length > 0) {
      await sb.from('purchase_invoices').delete().eq('id', h.id);
      return c.json({ error: 'qty_exceeds_remaining', lines: over }, 409);
    }
  }

  // Consume each GRN line: recount invoiced_qty from live PI lines.
  await recomputeGrnInvoiced(sb, lines.map((it) => it.id));

  // Refresh header subtotal/total from the inserted lines (parity with GRN/PR).
  await recomputePiTotals(sb, h.id);

  // Costing B — push the billed price down to the GRN's lots / DO / SI.
  await recostFromGrn(sb, g.id);

  return c.json({ id: h.id, invoiceNumber: h.invoice_number }, 201);
});

/* ════════════════════════════════════════════════════════════════════════
   PI PO-clone CRUD (PATCH header + line add / edit / delete) — mirrors the
   GRN detail page's confirmed/immediate-save editing (apps/api/src/routes/grns.ts).
   The editable line quantity is qty; line_total_centi =
   qty * unit_price_centi - discount_centi; recomputePiTotals rolls the header
   subtotal/total (PI keeps the stored tax in total, unlike GRN). PI is AP-only
   → line delete needs no inventory release (that landed at GRN time).
   ════════════════════════════════════════════════════════════════════════ */

/* ── PATCH /:id — header update (mirror GRN's PATCH /:id) ── */
purchaseInvoices.patch('/:id', async (c) => {
  const id = c.req.param('id');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const [from, to] of [
    ['supplierId', 'supplier_id'], ['supplierInvoiceRef', 'supplier_invoice_ref'],
    ['invoiceDate', 'invoice_date'], ['dueDate', 'due_date'],
    ['currency', 'currency'], ['notes', 'notes'],
  ] as const) {
    if (body[from] !== undefined) updates[to] = body[from];
  }
  // currency is normalised to upper-case like POST does.
  if (updates.currency !== undefined) updates.currency = normalizeCurrency(updates.currency);
  const sb = c.get('supabase');
  /* Migration 0082 — keep exchange_rate consistent with the effective currency
     (rate explicitly sent → normalise against it; currency flipped to MYR without
     a rate → reset to 1; else untouched). MYR ⇒ 1, a no-op. */
  let piRateChanged = false;
  if (body.exchangeRate !== undefined || updates.currency !== undefined) {
    let effectiveCurrency = updates.currency as string | undefined;
    if (effectiveCurrency === undefined) {
      const { data: curRow } = await sb.from('purchase_invoices').select('currency').eq('id', id).maybeSingle();
      effectiveCurrency = (curRow as { currency?: string } | null)?.currency ?? 'MYR';
    }
    if (body.exchangeRate !== undefined) {
      updates.exchange_rate = normalizeExchangeRate(body.exchangeRate, effectiveCurrency);
      piRateChanged = true;
    } else if (String(effectiveCurrency).toUpperCase() === 'MYR') {
      updates.exchange_rate = 1;
      piRateChanged = true;
    }
  }
  const { data, error } = await sb.from('purchase_invoices').update(updates).eq('id', id).select(HEADER).single();
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  /* A rate change moves the MYR AP amount posted to the GL. If the PI is posted,
     re-align its JE (void stale + re-post at the new MYR total) + recost its lots
     (the PI drives the authoritative MYR lot cost). Best-effort; no-op for MYR. */
  if (piRateChanged) {
    const inv = (data as { invoice_number?: string } | null)?.invoice_number;
    if (inv) {
      try { await resyncPiAccounting(sb, inv); } catch (e) { /* eslint-disable-next-line no-console */ console.error('[pi-patch] resync failed:', inv, e); }
    }
    try { await recostForPi(sb, id); } catch (e) { /* eslint-disable-next-line no-console */ console.error('[pi-patch] recost failed:', id, e); }
  }
  return c.json({ purchaseInvoice: data });
});

/* ── POST /:id/items — add one purchase_invoice_item. qty maps to qty. ── */
purchaseInvoices.post('/:id/items', async (c) => {
  const piId = c.req.param('id');
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (!it.materialCode) return c.json({ error: 'material_code_required' }, 400);
  if (!it.materialName) return c.json({ error: 'material_name_required' }, 400);

  const sb = c.get('supabase');
  // PI edit-lock: a paid / cancelled PI is read-only.
  const lock = await piLocked(sb, piId);
  if (lock) return c.json(lock, 409);

  const qty = Number(it.qty ?? 1);
  const unitPriceCenti = Number(it.unitPriceCenti ?? 0);
  const discountCenti = Number(it.discountCenti ?? 0);
  // Audit (ported from 2990 20190257) — clamp like the PO create path (negative-money guard).
  const lineTotal = Math.max(0, (qty * unitPriceCenti) - discountCenti);

  // GRN-linked line: cap qty at that GRN line's remaining
  // (accepted - invoiced - returned).
  const grnItemId = (it.grnItemId as string) ?? null;
  if (grnItemId) {
    const { data: gi } = await sb.from('grn_items')
      .select('qty_accepted, invoiced_qty, returned_qty').eq('id', grnItemId).maybeSingle();
    if (gi) {
      const g = gi as { qty_accepted: number; invoiced_qty: number; returned_qty: number };
      const remaining = (g.qty_accepted ?? 0) - (g.invoiced_qty ?? 0) - (g.returned_qty ?? 0);
      if (qty > remaining) return c.json({ error: 'qty_exceeds_remaining', requested: qty, remaining }, 409);
    }
  }

  const row: Record<string, unknown> = {
    purchase_invoice_id: piId,
    grn_item_id: (it.grnItemId as string) ?? null,
    material_kind: (it.materialKind as string) ?? 'mfg_product',
    material_code: it.materialCode,
    material_name: it.materialName,
    qty,
    unit_price_centi: unitPriceCenti,
    discount_centi: discountCenti,
    line_total_centi: lineTotal,
    unit_cost_centi: Number(it.unitCostCenti ?? 0),
    notes: (it.notes as string) ?? null,
    /* variant fields (mirror GRN/PO line) */
    gap_inches: (it.gapInches as number) ?? null,
    divan_height_inches: (it.divanHeightInches as number) ?? null,
    divan_price_sen: Number(it.divanPriceSen ?? 0),
    leg_height_inches: (it.legHeightInches as number) ?? null,
    leg_price_sen: Number(it.legPriceSen ?? 0),
    custom_specials: (it.customSpecials as unknown) ?? null,
    line_suffix: (it.lineSuffix as string) ?? null,
    special_order_price_sen: Number(it.specialOrderPriceSen ?? 0),
    variants: (it.variants as unknown) ?? null,
    item_group: (it.itemGroup as string) ?? null,
    description: (it.description as string) ?? null,
    description2: buildVariantSummary(String(it.itemGroup ?? ''), (it.variants as Record<string, unknown> | null) ?? null) || null,
    uom: (it.uom as string) ?? 'UNIT',
  };
  const { data, error } = await sb.from('purchase_invoice_items').insert({ ...row, company_id: activeCompanyId(c) }).select(ITEM).single();
  if (error) return c.json({ error: 'insert_failed', reason: error.message }, 500);

  /* Bug #3/#11 — POST-INSERT over-invoice verification. The pre-check is a
     read-then-write race: two concurrent adds against the same GRN line can each
     read remaining and both insert → over-billed. After committing, re-read the
     GRN line's accepted/returned + the LIVE sum of qty across all non-cancelled
     PI lines for it; if invoiced now exceeds (accepted - returned), OUR insert
     broke the cap → delete it + 409. (Fully DB-atomic needs an RPC — see report.) */
  if (grnItemId) {
    const inserted = data as unknown as { id: string } | null;
    const { data: gi } = await sb.from('grn_items')
      .select('qty_accepted, returned_qty').eq('id', grnItemId).maybeSingle();
    if (gi) {
      const g = gi as { qty_accepted: number; returned_qty: number };
      const cap = (g.qty_accepted ?? 0) - (g.returned_qty ?? 0);
      const { data: sib } = await sb.from('purchase_invoice_items')
        .select('qty, purchase_invoice_id').eq('grn_item_id', grnItemId);
      const sibRows = (sib ?? []) as Array<{ qty: number; purchase_invoice_id: string }>;
      const piIds = [...new Set(sibRows.map((r) => r.purchase_invoice_id))];
      const cancelled = new Set<string>();
      if (piIds.length > 0) {
        const { data: pis } = await sb.from('purchase_invoices').select('id, status').in('id', piIds);
        for (const p of (pis ?? []) as Array<{ id: string; status: string }>) {
          if (p.status === 'CANCELLED') cancelled.add(p.id);
        }
      }
      const liveInvoiced = sibRows
        .filter((r) => !cancelled.has(r.purchase_invoice_id))
        .reduce((s, r) => s + Number(r.qty ?? 0), 0);
      if (liveInvoiced > cap && inserted?.id) {
        await sb.from('purchase_invoice_items').delete().eq('id', inserted.id);
        return c.json({ error: 'qty_exceeds_remaining', requested: qty, remaining: cap - (liveInvoiced - qty) }, 409);
      }
    }
  }

  // Consume the GRN line if this PI line is GRN-linked (manual lines consume
  // nothing). Recount invoiced_qty from live PI lines.
  if (grnItemId) await recomputeGrnInvoiced(sb, [grnItemId]);
  await recomputePiTotals(sb, piId);
  // Costing B — a newly added PI line bills a GRN line: re-cost its lots / DO / SI.
  await recostForPi(sb, piId);
  return c.json({ item: data }, 201);
});

/* ── PATCH /:id/items/:itemId — partial line update. ── */
purchaseInvoices.patch('/:id/items/:itemId', async (c) => {
  const piId = c.req.param('id'); const itemId = c.req.param('itemId');
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const sb = c.get('supabase');

  // PI edit-lock: a paid / cancelled PI is read-only.
  const lock = await piLocked(sb, piId);
  if (lock) return c.json(lock, 409);

  /* Audit 2026-06-11 M10 — scope the line to THIS PI: a mismatched itemId
     must 404, not edit another PI's line while the recompute / recost / GL
     resync run against this one. */
  const { data: prev } = await sb.from('purchase_invoice_items')
    .select('qty, unit_price_centi, discount_centi, item_group, variants, grn_item_id')
    .eq('id', itemId).eq('purchase_invoice_id', piId).maybeSingle();
  if (!prev) return c.json({ error: 'not_found' }, 404);

  const prevQty = (prev as { qty: number }).qty;
  const grnItemId = (prev as { grn_item_id: string | null }).grn_item_id ?? null;
  const qty = it.qty !== undefined ? Number(it.qty) : prevQty;
  const unit = it.unitPriceCenti !== undefined ? Number(it.unitPriceCenti) : (prev as { unit_price_centi: number }).unit_price_centi;
  const discount = it.discountCenti !== undefined ? Number(it.discountCenti) : ((prev as { discount_centi: number }).discount_centi ?? 0);
  /* PI discount unification (audit 2026-06-11 M3) — this IS the canonical rule
     (line_total_centi = qty × unit − discount, discount stored); all four
     create paths now write the same way, so an edit no longer shifts a line's
     total by a stored-but-previously-unapplied discount. */
  // Audit (ported from 2990 20190257) — clamp like the PO create path (negative-money guard).
  const lineTotal = Math.max(0, (qty * unit) - discount);

  const updates: Record<string, unknown> = {
    qty,
    unit_price_centi: unit,
    discount_centi: discount,
    line_total_centi: lineTotal,
  };
  for (const [from, to] of [
    ['materialCode', 'material_code'], ['materialName', 'material_name'],
    ['itemGroup', 'item_group'], ['description', 'description'], ['uom', 'uom'],
    ['unitCostCenti', 'unit_cost_centi'], ['notes', 'notes'],
    ['gapInches', 'gap_inches'], ['divanHeightInches', 'divan_height_inches'],
    ['divanPriceSen', 'divan_price_sen'], ['legHeightInches', 'leg_height_inches'],
    ['legPriceSen', 'leg_price_sen'], ['customSpecials', 'custom_specials'],
    ['lineSuffix', 'line_suffix'], ['specialOrderPriceSen', 'special_order_price_sen'],
    ['variants', 'variants'],
  ] as const) {
    if (it[from] !== undefined) updates[to] = it[from];
  }
  /* description2 is server-owned: recompute from effective itemGroup + variants. */
  {
    const effGroup = (it.itemGroup ?? (prev as { item_group?: string }).item_group) as string | null | undefined;
    const effVariants = (it.variants ?? (prev as { variants?: unknown }).variants) as Record<string, unknown> | null | undefined;
    updates['description2'] = buildVariantSummary(String(effGroup ?? ''), effVariants ?? null) || null;
  }

  // GRN-linked + qty changed: pre-check the delta won't push the GRN line over
  // its accepted (remaining excluding THIS line's existing draw must cover the
  // new qty). delta = qty - prevQty.
  const delta = qty - prevQty;
  if (grnItemId && delta !== 0) {
    const { data: gi } = await sb.from('grn_items')
      .select('qty_accepted, invoiced_qty, returned_qty').eq('id', grnItemId).maybeSingle();
    if (gi) {
      const accepted = (gi as { qty_accepted: number }).qty_accepted ?? 0;
      const invoiced = (gi as { invoiced_qty: number }).invoiced_qty ?? 0;
      const returned = (gi as { returned_qty: number }).returned_qty ?? 0;
      // remaining headroom for THIS line = accepted - returned - (invoiced - prevQty).
      const headroom = accepted - returned - (invoiced - prevQty);
      if (qty > headroom) return c.json({ error: 'qty_exceeds_remaining', requested: qty, remaining: headroom }, 409);
    }
  }

  const { error } = await sb.from('purchase_invoice_items').update(updates).eq('id', itemId);
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  // Recount the source GRN line's invoiced_qty from live PI lines (clamps to
  // [0, qty_accepted]).
  if (grnItemId) await recomputeGrnInvoiced(sb, [grnItemId]);
  await recomputePiTotals(sb, piId);
  // Costing B — a PI price EDIT (incl. human-error correction) re-costs the
  // GRN's lots and cascades to every shipped DO + Sales Invoice in real time.
  await recostForPi(sb, piId);
  /* If this PI was already posted to the accounts, its total just changed — void
     the stale entry + re-post at the new amount. No-op when never posted (PI
     posts to the GL only on demand). Best-effort. */
  try {
    const { data: h } = await sb.from('purchase_invoices').select('invoice_number').eq('id', piId).maybeSingle();
    if (h) await resyncPiAccounting(sb, (h as { invoice_number: string }).invoice_number);
  } catch (e) { /* eslint-disable-next-line no-console */ console.error('[pi-accounting] post-line-edit resync failed:', e); }
  return c.json({ ok: true });
});

/* ── DELETE /:id/items/:itemId — remove a line + recompute header. ── */
purchaseInvoices.delete('/:id/items/:itemId', async (c) => {
  const piId = c.req.param('id'); const itemId = c.req.param('itemId');
  const sb = c.get('supabase');
  // PI edit-lock: a paid / cancelled PI is read-only.
  const lock = await piLocked(sb, piId);
  if (lock) return c.json(lock, 409);

  // Read the line first so we can release its GRN-line consumption on delete.
  // Audit 2026-06-11 M10 — scoped to THIS PI: a mismatched itemId must 404,
  // not delete another PI's line while the recompute / GL resync run here.
  const { data: line } = await sb.from('purchase_invoice_items')
    .select('qty, grn_item_id').eq('id', itemId).eq('purchase_invoice_id', piId).maybeSingle();
  if (!line) return c.json({ error: 'not_found' }, 404);
  const { error } = await sb.from('purchase_invoice_items').delete().eq('id', itemId);
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);
  if (line) {
    const l = line as { qty: number; grn_item_id: string | null };
    // Release: recount invoiced_qty from live PI lines — the deleted line drops out.
    if (l.grn_item_id) await recomputeGrnInvoiced(sb, [l.grn_item_id]);
    // Costing B — removing a PI line drops its authoritative price; re-cost the
    // GRN so the bucket falls back to the GR price (or Pending) and DOs/SIs follow.
    if (l.grn_item_id) {
      const { data: gi } = await sb.from('grn_items').select('grn_id').eq('id', l.grn_item_id).maybeSingle();
      const gid = (gi as { grn_id: string | null } | null)?.grn_id ?? null;
      if (gid) await recostFromGrn(sb, gid);
    }
  }
  await recomputePiTotals(sb, piId);
  /* Deleting a line lowers the PI total — if it was posted to the accounts, void
     the stale entry + re-post (or void to nothing if it was the last line). No-op
     when never posted. Best-effort. */
  try {
    const { data: h } = await sb.from('purchase_invoices').select('invoice_number').eq('id', piId).maybeSingle();
    if (h) await resyncPiAccounting(sb, (h as { invoice_number: string }).invoice_number);
  } catch (e) { /* eslint-disable-next-line no-console */ console.error('[pi-accounting] post-line-delete resync failed:', e); }
  return c.body(null, 204);
});
