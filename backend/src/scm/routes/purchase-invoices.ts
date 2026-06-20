// /purchase-invoices — supplier billing us (after GRN).

import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { buildVariantSummary } from '../shared';
import {
  orderSofaModuleRowsWithinBuilds,
  sortSoLinesByGroupRank,
} from '../shared/so-line-display';
import { reversePiAccounting, resyncPiAccounting } from './accounting';
import { recostForPi, recostFromGrn } from '../lib/recost';

export const purchaseInvoices = new Hono<{ Bindings: Env; Variables: Variables }>();
purchaseInvoices.use('*', supabaseAuth);

const HEADER =
  'id, invoice_number, supplier_invoice_ref, supplier_id, purchase_order_id, grn_id, invoice_date, due_date, currency, subtotal_centi, tax_centi, total_centi, paid_centi, status, notes, posted_at, created_at, created_by, updated_at';
const ITEM =
  'id, purchase_invoice_id, grn_item_id, material_kind, material_code, material_name, qty, unit_price_centi, line_total_centi, notes, ' +
  /* PR #42 — variant fields (migration 0057) */
  'item_group, description, description2, uom, discount_centi, variants, ' +
  'gap_inches, divan_height_inches, divan_price_sen, leg_height_inches, leg_price_sen, ' +
  'custom_specials, line_suffix, special_order_price_sen, unit_cost_centi, created_at';

const nextNum = async (sb: any, prefix: string): Promise<string> => {
  const d = new Date();
  const yymm = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`;
  const { count } = await sb.from('purchase_invoices').select('id', { head: true, count: 'exact' }).like('invoice_number', `${prefix}-${yymm}-%`);
  return `${prefix}-${yymm}-${String((count ?? 0) + 1).padStart(3, '0')}`;
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
    const cancelled = new Set<string>();
    if (piIds.length > 0) {
      const { data: pis } = await sb.from('purchase_invoices').select('id, status').in('id', piIds);
      for (const p of (pis ?? []) as Array<{ id: string; status: string }>) {
        if (p.status === 'CANCELLED') cancelled.add(p.id);
      }
    }
    const invByGrnItem = new Map<string, number>(ids.map((id) => [id, 0]));
    for (const r of rows) {
      if (cancelled.has(r.purchase_invoice_id)) continue;
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
  // Live invoiced per GRN line = sum(qty) across all non-cancelled PI lines.
  const { data: sib } = await sb.from('purchase_invoice_items')
    .select('grn_item_id, qty, purchase_invoice_id').in('grn_item_id', ids);
  const sibRows = (sib ?? []) as Array<{ grn_item_id: string; qty: number; purchase_invoice_id: string }>;
  const piIds = [...new Set(sibRows.map((r) => r.purchase_invoice_id).filter(Boolean))];
  const cancelled = new Set<string>();
  if (piIds.length > 0) {
    const { data: pis } = await sb.from('purchase_invoices').select('id, status').in('id', piIds);
    for (const p of (pis ?? []) as Array<{ id: string; status: string }>) {
      if (p.status === 'CANCELLED') cancelled.add(p.id);
    }
  }
  const liveByGrnItem = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const r of sibRows) {
    if (cancelled.has(r.purchase_invoice_id)) continue;
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

purchaseInvoices.get('/', async (c) => {
  const sb = c.get('supabase');
  let q = sb.from('purchase_invoices')
    .select(`${HEADER}, supplier:suppliers(id, code, name), purchase_order:purchase_orders(id, po_number), grn:grns(id, grn_number)`)
    .order('invoice_date', { ascending: false });
  const status = c.req.query('status'); if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ purchaseInvoices: data ?? [] });
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
  const { data: grnHeaders, error: hErr } = await sb
    .from('grns')
    .select(`
      id, grn_number, received_at, supplier_id, purchase_order_id,
      supplier:suppliers ( code, name ),
      purchase_order:purchase_orders ( po_number )
    `)
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
  if (body.status === 'DRAFT') return c.json({ error: 'draft_status_not_supported', message: 'DRAFT was removed in migration 0078 — PIs post immediately on create.' }, 400);
  if (!body.supplierId) return c.json({ error: 'supplier_required' }, 400);
  const items = body.items as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(items) || !items.length) return c.json({ error: 'items_required' }, 400);

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

  const invoiceNumber = await nextNum(sb, 'PI');
  let subtotal = 0;
  const itemRows = items.map((it) => {
    /* PI discount unification (audit 2026-06-11 M3) — ONE rule on every PI
       line write path: line_total_centi = qty × unit − discount, discount
       stored. This path used to drop the client discount entirely (totals
       overstated whenever the form sent one). */
    const qty = Number(it.qty ?? 0); const unit = Number(it.unitPriceCenti ?? 0);
    const discount = Number(it.discountCenti ?? 0) || 0;
    const total = qty * unit - discount; subtotal += total;
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
  const { data: header, error: hErr } = await sb.from('purchase_invoices').insert({
    invoice_number: invoiceNumber,
    supplier_invoice_ref: (body.supplierInvoiceRef as string) ?? null,
    supplier_id: body.supplierId,
    purchase_order_id: (body.purchaseOrderId as string) ?? null,
    grn_id: (body.grnId as string) ?? null,
    invoice_date: (body.invoiceDate as string) ?? new Date().toISOString().slice(0, 10),
    due_date: (body.dueDate as string) ?? null,
    currency: ((body.currency as string) ?? 'MYR').toUpperCase(),
    subtotal_centi: subtotal,
    total_centi: subtotal,
    notes: (body.notes as string) ?? null,
    status: 'POSTED',
    posted_at: new Date().toISOString(),
    created_by: user.id,
  }).select(HEADER).single();
  if (hErr) return c.json({ error: 'insert_failed', reason: hErr.message }, 500);
  const h = header as unknown as { id: string; invoice_number: string };

  const rowsWithId = itemRows.map((r) => ({ ...r, purchase_invoice_id: h.id }));
  const { error: iErr } = await sb.from('purchase_invoice_items').insert(rowsWithId);
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
  // Self-heal the GRN invoiced counter so the just-billed lines drop out of the
  // outstanding picker (mirrors /from-grn-items line ~523 + /:id/items).
  await recomputeGrnInvoiced(sb, itemRows.map((r) => r.grn_item_id));
  // Costing B — a new PI is the authoritative cost: re-cost the GRN's lots →
  // consumptions → movements → DO → SI so a shipped order's margin reflects the
  // billed price (or its later correction) in real time.
  await recostForPi(sb, h.id);
  return c.json({ id: h.id, invoiceNumber: h.invoice_number }, 201);
});

purchaseInvoices.patch('/:id/post', async (c) => {
  /* PR-DRAFT-removal — kept for backward compat; idempotent. POST now
     creates PIs as POSTED directly. */
  const sb = c.get('supabase'); const id = c.req.param('id');
  const { data: cur } = await sb.from('purchase_invoices').select('id, status').eq('id', id).maybeSingle();
  if (!cur) return c.json({ error: 'not_found' }, 404);
  if ((cur as { status: string }).status === 'POSTED') return c.json({ purchaseInvoice: cur });
  const { data, error } = await sb.from('purchase_invoices').update({
    status: 'POSTED', posted_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq('id', id).neq('status', 'CANCELLED').select('id, status').single();
  if (error) return c.json({ error: 'post_failed', reason: error.message }, 500);
  if (!data) return c.json({ error: 'cannot_post' }, 409);
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

  const { data: cur } = await sb.from('purchase_invoices').select('paid_centi, total_centi, status').eq('id', id).maybeSingle();
  if (!cur) return c.json({ error: 'not_found' }, 404);
  const c0 = cur as { paid_centi: number; total_centi: number; status: string };
  // DRAFT removed in migration 0078 — only block CANCELLED now.
  if (c0.status === 'CANCELLED') return c.json({ error: 'not_payable', message: 'PI is cancelled' }, 409);

  const newPaid = c0.paid_centi + amount;
  const newStatus = newPaid >= c0.total_centi ? 'PAID' : 'PARTIALLY_PAID';
  const ts: Record<string, string> = { updated_at: new Date().toISOString() };

  const { data, error } = await sb.from('purchase_invoices').update({
    paid_centi: newPaid, status: newStatus, ...ts,
  }).eq('id', id).select('id, paid_centi, status').single();
  if (error) return c.json({ error: 'payment_failed', reason: error.message }, 500);
  return c.json({ purchaseInvoice: data });
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
      grn:grns!inner ( id, grn_number, supplier_id, purchase_order_id, status )
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
    grn: { id: string; grn_number: string; supplier_id: string; purchase_order_id: string | null; status: string };
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
    lines: Array<{ row: ItemRow; qty: number }>;
  };
  const buckets = new Map<string, Bucket>();
  for (const p of picks) {
    const row = byId.get(p.grnItemId)!;
    const cur = buckets.get(row.grn.id) ?? {
      grnId: row.grn.id, grnNumber: row.grn.grn_number,
      supplierId: row.grn.supplier_id, purchaseOrderId: row.grn.purchase_order_id,
      lines: [],
    };
    cur.lines.push({ row, qty: p.qty });
    buckets.set(row.grn.id, cur);
  }

  // Generate PI numbers sequentially within this batch.
  const d = new Date();
  const yymm = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`;
  const { count } = await sb.from('purchase_invoices').select('id', { head: true, count: 'exact' }).like('invoice_number', `PI-${yymm}-%`);
  let counter = count ?? 0;

  const invoiceDate = body.invoiceDate ?? new Date().toISOString().slice(0, 10);
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
    const invoiceNumber = `PI-${yymm}-${String(counter).padStart(3, '0')}`;
    const subtotal = bucket.lines.reduce((s, { row, qty }) => s + (qty * row.unit_price_centi - discFor(row, qty)), 0);

    const { data: header, error: hErr } = await sb.from('purchase_invoices').insert({
      invoice_number: invoiceNumber,
      supplier_invoice_ref: body.supplierInvoiceNumber ?? null,
      supplier_id: bucket.supplierId,
      purchase_order_id: bucket.purchaseOrderId,
      grn_id: bucket.grnId,
      invoice_date: invoiceDate,
      due_date: body.dueDate ?? null,
      currency: 'MYR',
      subtotal_centi: subtotal,
      tax_centi: 0,
      total_centi: subtotal,
      // Auto-post per Commander preference (matches GRN/PO behaviour).
      status: 'POSTED',
      posted_at: new Date().toISOString(),
      notes: body.notes ? `Multi-pick from ${bucket.grnNumber} · ${body.notes}` : `Multi-pick from ${bucket.grnNumber}`,
      created_by: user.id,
    }).select('id, invoice_number').single();
    if (hErr) continue;
    const h = header as unknown as { id: string; invoice_number: string };

    const rows = bucket.lines.map(({ row, qty }) => ({
      purchase_invoice_id: h.id,
      grn_item_id: row.id,
      material_kind: row.material_kind,
      material_code: row.material_code,
      material_name: row.material_name,
      qty,
      unit_price_centi: row.unit_price_centi,
      line_total_centi: qty * row.unit_price_centi - discFor(row, qty),
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
    const { error: iErr } = await sb.from('purchase_invoice_items').insert(rows);
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
    .select('id, grn_number, supplier_id, purchase_order_id, status')
    .eq('id', grnId).maybeSingle();
  if (grnErr) return c.json({ error: 'load_failed', reason: grnErr.message }, 500);
  if (!grn) return c.json({ error: 'grn_not_found' }, 404);
  const g = grn as { id: string; grn_number: string; supplier_id: string; purchase_order_id: string | null; status: string };
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

  const invoiceNumber = await nextNum(sb, 'PI');
  /* PI discount unification (audit 2026-06-11 M3) — ONE rule on every PI line
     write path: line_total_centi = qty × unit − discount, discount stored.
     The GRN line discount is pro-rated by the billed (remaining) qty over
     qty_accepted so a second /from-grn pass over a partially-billed line
     can't subtract the full discount twice. */
  const discFor = (it: GrnLine & { _remaining: number }) =>
    Math.round(Number(it.discount_centi ?? 0) * it._remaining / (Number(it.qty_accepted) || 1));
  const subtotal = lines.reduce((s, it) => s + (it._remaining * it.unit_price_centi - discFor(it)), 0);

  const { data: header, error: hErr } = await sb.from('purchase_invoices').insert({
    invoice_number: invoiceNumber,
    supplier_id: g.supplier_id,
    purchase_order_id: g.purchase_order_id,
    grn_id: g.id,
    invoice_date: new Date().toISOString().slice(0, 10),
    currency: 'MYR',
    subtotal_centi: subtotal,
    tax_centi: 0,
    total_centi: subtotal,
    status: 'POSTED',
    posted_at: new Date().toISOString(),
    notes: `From ${g.grn_number}`,
    created_by: user.id,
  }).select('id, invoice_number').single();
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
    line_total_centi: it._remaining * it.unit_price_centi - discFor(it),
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
  const { error: insErr } = await sb.from('purchase_invoice_items').insert(rows);
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
  // currency is an enum — normalise to upper-case like POST does.
  if (updates.currency !== undefined) updates.currency = String(updates.currency).toUpperCase();
  const sb = c.get('supabase');
  const { data, error } = await sb.from('purchase_invoices').update(updates).eq('id', id).select(HEADER).single();
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
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
  const lineTotal = (qty * unitPriceCenti) - discountCenti;

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
  const { data, error } = await sb.from('purchase_invoice_items').insert(row).select(ITEM).single();
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
  const lineTotal = (qty * unit) - discount;

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
