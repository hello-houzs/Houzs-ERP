// /sales-invoices — we bill the customer (B2B sales side).
//
// Ported from 2990's apps/api/src/routes/sales-invoices.ts. A faithful clone of
// the Delivery Order API (delivery-orders-mfg.ts), itself a Sales Order clone:
// editable SO-style header, line-item CRUD, a payments ledger, a recomputeTotals
// rollup, plus a convert-from-DO that copies a Delivery Order's header + all line
// items (with variants + prices) into a new invoice.
//
// REVENUE: a Sales Invoice records revenue the moment it is created/confirmed.
// The POST handler calls the shared idempotent poster (post-si-revenue) which
// writes Dr 1100 (AR) / Cr 4000 (Sales Revenue) = total_centi into
// journal_entries + journal_entry_lines, keyed on (source_type='SI',
// source_doc_no=invoice_number) so it can never double-post. Posting failures
// never roll back the invoice (audit-DLQ pattern).
//
// Houzs adaptation: same plumbing as the sibling SCM routes — supabaseAuth bridge
// + scm-scoped service client via c.get('supabase'). Imports repointed from
// @2990s/shared → ../shared. NOTE: GL posting needs scm.accounts seeded with at
// least codes 1100 / 4000; customer-credit + payment paths need the two tables
// in scripts/scm-schema/0103-0110-si-payments-and-credits.sql applied.
//
// Mounted at '/sales-invoices' in scm/index.ts.

import { Hono } from 'hono';
import { z } from 'zod';
import { normalizePhone, buildVariantSummary, isServiceLine } from '../shared';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { postSiRevenue, reverseSiRevenue, resyncSiRevenue } from '../lib/post-si-revenue';
import { nextMonthlyDocNo } from '../lib/doc-no';
import { resolveSalesScopeIds } from '../lib/salesScope';
import { doLineRemaining, doRemainingByItemId, resolveCandidateDoIds, custKeyOf, type DoRemainingLine } from '../lib/do-line-remaining';
import { validateItemCodes, unknownItemCodeResponse } from '../lib/validate-item-codes';
import { applyCustomerCreditToSi, creditFromCancelledSi, reverseCancelledSiCredit, reconcileSiOverpay } from '../lib/customer-credits';

export const salesInvoices = new Hono<{ Bindings: Env; Variables: Variables }>();
salesInvoices.use('*', supabaseAuth);

/* Full SI header — mirrors the editable DO header shape. */
const HEADER =
  'id, invoice_number, so_doc_no, delivery_order_id, debtor_code, debtor_name, ' +
  'invoice_date, due_date, customer_delivery_date, currency, ' +
  'subtotal_centi, discount_centi, tax_centi, total_centi, paid_centi, ' +
  'salesperson_id, agent, email, customer_type, building_type, branding, venue, venue_id, ref, ' +
  'customer_so_no, po_doc_no, sales_location, customer_state, customer_country, note, ' +
  'address1, address2, city, state, postcode, phone, ' +
  'emergency_contact_name, emergency_contact_phone, emergency_contact_relationship, ' +
  'mattress_sofa_centi, bedframe_centi, accessories_centi, others_centi, service_centi, ' +
  'mattress_sofa_cost_centi, bedframe_cost_centi, accessories_cost_centi, others_cost_centi, service_cost_centi, ' +
  'local_total_centi, total_cost_centi, total_margin_centi, margin_pct_basis, line_count, ' +
  'status, notes, sent_at, paid_at, confirmed_at, created_at, created_by, updated_at';

const ITEM =
  'id, sales_invoice_id, so_item_id, do_item_id, item_code, item_group, description, description2, ' +
  'uom, qty, unit_price_centi, discount_centi, tax_centi, line_total_centi, ' +
  'unit_cost_centi, line_cost_centi, line_margin_centi, variants, notes, created_at';

const PAYMENT_COLS =
  'id, sales_invoice_id, paid_at, method, merchant_provider, installment_months, ' +
  'online_type, approval_code, amount_centi, account_sheet, collected_by, note, ' +
  'created_at, created_by';

const nextNum = async (sb: any): Promise<string> => {
  const d = new Date();
  const yymm = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`;
  const { data: existing } = await sb.from('sales_invoices').select('invoice_number').like('invoice_number', `SI-${yymm}-%`);
  return nextMonthlyDocNo(`SI-${yymm}`, ((existing ?? []) as Array<{ invoice_number: string }>).map((r) => r.invoice_number));
};

/* Re-derive the SI header's per-category revenue/cost totals + grand total from
   its line items. Mirrors the DO recomputeTotals plain per-category rollup. Also
   keeps subtotal_centi / total_centi in sync (they back the GL posting + the
   legacy payments path). Called after every item mutation. */
async function recomputeTotals(sb: any, salesInvoiceId: string) {
  const { data: items } = await sb.from('sales_invoice_items')
    .select('item_code, item_group, line_total_centi, line_cost_centi')
    .eq('sales_invoice_id', salesInvoiceId);
  let mattressSofa = 0, bedframe = 0, accessories = 0, others = 0, service = 0, total = 0, totalCost = 0;
  let mattressSofaCost = 0, bedframeCost = 0, accessoriesCost = 0, othersCost = 0, serviceCost = 0;
  for (const it of (items ?? []) as Array<{ item_code: string | null; item_group: string | null; line_total_centi: number | null; line_cost_centi: number | null }>) {
    const lineTotal = Number(it.line_total_centi ?? 0);
    const lineCost  = Number(it.line_cost_centi ?? 0);
    total += lineTotal;
    totalCost += lineCost;
    const g = (it.item_group ?? '').toLowerCase();
    if (isServiceLine({ itemGroup: g, itemCode: it.item_code })) { service += lineTotal; serviceCost += lineCost; }
    else if (g.includes('mattress') || g.includes('sofa')) { mattressSofa += lineTotal; mattressSofaCost += lineCost; }
    else if (g.includes('bedframe')) { bedframe += lineTotal; bedframeCost += lineCost; }
    else if (g.includes('accessor')) { accessories += lineTotal; accessoriesCost += lineCost; }
    else { others += lineTotal; othersCost += lineCost; }
  }
  const margin = total - totalCost;
  await sb.from('sales_invoices').update({
    mattress_sofa_centi: mattressSofa,
    bedframe_centi: bedframe,
    accessories_centi: accessories,
    others_centi: others,
    service_centi: service,
    mattress_sofa_cost_centi: mattressSofaCost,
    bedframe_cost_centi: bedframeCost,
    accessories_cost_centi: accessoriesCost,
    others_cost_centi: othersCost,
    service_cost_centi: serviceCost,
    local_total_centi: total,
    total_cost_centi: totalCost,
    total_margin_centi: margin,
    margin_pct_basis: total > 0 ? Math.round((margin / total) * 10000) : 0,
    line_count: (items ?? []).length,
    subtotal_centi: total,
    total_centi: total,
    updated_at: new Date().toISOString(),
  }).eq('id', salesInvoiceId);
}

/* Build one sales_invoice_items insert row from a client line payload. */
function buildItemRow(salesInvoiceId: string, it: Record<string, unknown>, lineNo?: number | null) {
  const qty = Number(it.qty ?? 1);
  const unitPrice = Number(it.unitPriceCenti ?? 0);
  const discount = Number(it.discountCenti ?? 0);
  const tax = Number(it.taxCenti ?? 0);
  const unitCost = Number(it.unitCostCenti ?? 0);
  const lineTotal = (qty * unitPrice) - discount + tax;
  const lineCost = qty * unitCost;
  const itemGroup = (it.itemGroup as string) ?? null;
  const variants = (it.variants as unknown) ?? null;
  return {
    sales_invoice_id: salesInvoiceId,
    so_item_id: (it.soItemId as string | undefined) ?? null,
    do_item_id: (it.doItemId as string | undefined) ?? null,
    item_code: it.itemCode,
    item_group: itemGroup,
    description: (it.description as string) ?? null,
    description2: buildVariantSummary(String(itemGroup ?? ''), (variants as Record<string, unknown> | null) ?? null) || (it.description2 as string) || null,
    uom: (it.uom as string) ?? 'UNIT',
    qty,
    unit_price_centi: unitPrice,
    discount_centi: discount,
    tax_centi: tax,
    line_total_centi: lineTotal,
    unit_cost_centi: unitCost,
    line_cost_centi: lineCost,
    line_margin_centi: lineTotal - lineCost,
    variants,
    notes: (it.notes as string) ?? null,
    ...(typeof lineNo === 'number' ? { line_no: lineNo } : {}),
  };
}

/* LINE-LEVEL, QUANTITY-BASED DO → Sales Invoice remaining. Wraps the shared
   Pending formula: remaining_to_invoice = delivered − invoiced − returned. */
async function doInvoiceableRemaining(sb: any, doIds: string[]): Promise<Map<string, DoRemainingLine>> {
  return doLineRemaining(sb, doIds);
}

/* Remaining-to-invoice write guard. */
async function checkSiOverRemaining(
  sb: any,
  lines: Array<Record<string, unknown>>,
  excludeByDoItem?: Map<string, number>,
): Promise<{ error: string; lines: Array<{ doItemId: string; requested: number; remaining: number }> } | null> {
  const wanted = new Map<string, number>();
  for (const it of lines) {
    const doItemId = (it.doItemId as string | undefined) ?? null;
    if (!doItemId) continue;
    wanted.set(doItemId, (wanted.get(doItemId) ?? 0) + Number(it.qty ?? 0));
  }
  if (wanted.size === 0) return null;
  const remainingMap = await doRemainingByItemId(sb, [...wanted.keys()]);
  const offenders: Array<{ doItemId: string; requested: number; remaining: number }> = [];
  for (const [doItemId, requested] of wanted) {
    const cap = (remainingMap.get(doItemId) ?? 0) + (excludeByDoItem?.get(doItemId) ?? 0);
    if (requested > cap) offenders.push({ doItemId, requested, remaining: cap });
  }
  return offenders.length > 0 ? { error: 'over_remaining', lines: offenders } : null;
}

// ── List ────────────────────────────────────────────────────────────────
salesInvoices.get('/', async (c) => {
  const sb = c.get('supabase');
  const user = c.get('user');
  // Row-level "own / subordinates" scope — see lib/salesScope.ts.
  const scopeIds = await resolveSalesScopeIds(sb, c.env, user.id);
  let q = sb.from('sales_invoices').select(HEADER).order('invoice_date', { ascending: false }).limit(500);
  if (scopeIds) q = q.in('salesperson_id', scopeIds);
  const status = c.req.query('status'); if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ salesInvoices: data ?? [] });
});

// ── Invoiceable DO lines (line-level partial-invoice picker) ──────────────
/* STATIC path MUST be registered BEFORE the `/:id` param route below. */
salesInvoices.get('/invoiceable-do-lines', async (c) => {
  const sb = c.get('supabase');
  const doIds = await resolveCandidateDoIds(sb, c.req.query('doIds'));
  if (doIds.length === 0) return c.json({ lines: [] });
  const remainingMap = await doInvoiceableRemaining(sb, doIds);
  const lines = [...remainingMap.values()].filter((l) => l.remaining > 0);
  return c.json({ lines });
});

// ── Detail ──────────────────────────────────────────────────────────────
salesInvoices.get('/:id', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  const [h, i] = await Promise.all([
    sb.from('sales_invoices').select(HEADER).eq('id', id).maybeSingle(),
    sb.from('sales_invoice_items').select(ITEM).eq('sales_invoice_id', id)
      .order('line_no', { ascending: true, nullsFirst: false })
      .order('created_at'),
  ]);
  if (h.error) return c.json({ error: 'load_failed', reason: h.error.message }, 500);
  if (!h.data) return c.json({ error: 'not_found' }, 404);
  return c.json({ salesInvoice: h.data, items: i.data ?? [] });
});

// ── Create ──────────────────────────────────────────────────────────────
salesInvoices.post('/', async (c) => {
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const debtorName = (body.debtorName ?? body.customerName) as string | undefined;
  if (!debtorName) return c.json({ error: 'debtor_name_required' }, 400);
  const items = (body.items as Array<Record<string, unknown>> | undefined) ?? [];

  const sb = c.get('supabase'); const user = c.get('user');

  if (items.length > 0) {
    const codeCheck = await validateItemCodes(sb, items.map((it) => it.itemCode as string | null | undefined));
    if (!codeCheck.ok) return c.json(unknownItemCodeResponse(codeCheck.unknown), 409);
  }

  {
    const over = await checkSiOverRemaining(sb, items);
    if (over) return c.json(over, 409);
  }

  const invoiceNumber = await nextNum(sb);

  const phoneRaw = (body.phone as string | undefined) ?? null;
  const emPhoneRaw = (body.emergencyContactPhone as string | undefined) ?? null;
  const nowIso = new Date().toISOString();

  /* DRAFT flow (mirror SO mfg-sales-orders.ts:3072) — opt-in `asDraft` lands the
     invoice as DRAFT. A DRAFT SI commits NOTHING: no AR/GL revenue, no customer
     credit. It also leaves sent_at / confirmed_at NULL (stamped on confirm).
     The confirm transition (PATCH /:id/status DRAFT→SENT) does the posting. */
  const isDraft = (body as { asDraft?: unknown }).asDraft === true;

  const { data: header, error: hErr } = await sb.from('sales_invoices').insert({
    invoice_number: invoiceNumber,
    so_doc_no: (body.soDocNo as string) ?? null,
    delivery_order_id: (body.deliveryOrderId as string) ?? null,
    debtor_code: (body.debtorCode as string) ?? null,
    debtor_name: debtorName,
    invoice_date: (body.invoiceDate as string) ?? new Date().toISOString().slice(0, 10),
    due_date: (body.dueDate as string) ?? null,
    customer_delivery_date: (body.customerDeliveryDate as string) ?? null,
    address1: (body.address1 as string) ?? null,
    address2: (body.address2 as string) ?? null,
    city: (body.city as string) ?? null,
    state: (body.state as string) ?? (body.customerState as string) ?? null,
    customer_state: (body.customerState as string) ?? (body.state as string) ?? null,
    customer_country: (body.customerCountry as string) ?? null,
    postcode: (body.postcode as string) ?? null,
    phone: phoneRaw ? (normalizePhone(phoneRaw) ?? phoneRaw) : null,
    salesperson_id: (body.salespersonId as string) ?? null,
    agent: (body.agent as string) ?? null,
    email: (body.email as string) ?? null,
    customer_type: (body.customerType as string) ?? null,
    building_type: (body.buildingType as string) ?? null,
    branding: (body.branding as string) ?? null,
    venue: (body.venue as string) ?? null,
    venue_id: (body.venueId as string) ?? null,
    ref: (body.ref as string) ?? null,
    customer_so_no: (body.customerSoNo as string) ?? null,
    po_doc_no: (body.poDocNo as string) ?? null,
    sales_location: (body.salesLocation as string) ?? null,
    note: (body.note as string) ?? null,
    emergency_contact_name: (body.emergencyContactName as string) ?? null,
    emergency_contact_phone: emPhoneRaw ? (normalizePhone(emPhoneRaw) ?? emPhoneRaw) : null,
    emergency_contact_relationship: (body.emergencyContactRelationship as string) ?? null,
    currency: ((body.currency as string) ?? 'MYR').toUpperCase(),
    status: isDraft ? 'DRAFT' : 'SENT',
    sent_at: isDraft ? null : nowIso,
    confirmed_at: isDraft ? null : nowIso,
    notes: (body.notes as string) ?? null,
    created_by: user.id,
  }).select(HEADER).single();
  if (hErr) return c.json({ error: 'insert_failed', reason: hErr.message }, 500);
  const h = header as unknown as { id: string; invoice_number: string; debtor_code: string | null; debtor_name: string | null; total_centi: number | null; paid_centi: number | null };

  if (items.length > 0) {
    const rows = items.map((it, lineNo) => buildItemRow(h.id, it, lineNo));
    const { error: iErr } = await sb.from('sales_invoice_items').insert(rows);
    if (iErr) { await sb.from('sales_invoices').delete().eq('id', h.id); return c.json({ error: 'items_insert_failed', reason: iErr.message }, 500); }
    await recomputeTotals(sb, h.id);
  }

  /* LEAK GUARD (DRAFT) — a DRAFT SI must NOT post AR/GL revenue nor auto-apply
     customer credit. Both happen on confirm (PATCH /:id/status DRAFT→SENT). */
  if (isDraft) {
    return c.json({ id: h.id, invoiceNumber: h.invoice_number, revenue: { posted: false, status: 'draft' }, creditApplied: 0 }, 201);
  }

  /* REVENUE — record it now. Idempotent + best-effort. */
  let revenue: { posted: boolean; jeNo?: string; status: string } = { posted: false, status: 'skipped' };
  const post = await postSiRevenue(sb, h.invoice_number);
  if (post.ok) {
    revenue = { posted: post.status === 'posted', jeNo: post.jeNo, status: post.status };
  } else {
    revenue = { posted: false, status: post.status };
    if (post.status !== 'zero_total' && post.status !== 'invoice_not_found') {
      // eslint-disable-next-line no-console
      console.error(`[si-revenue] post failed for ${h.invoice_number}:`, post.status, post.reason);
    }
  }

  /* Edge #11 — auto-apply existing customer credit balance toward this new SI. */
  let creditApplied = 0;
  if (h.debtor_code) {
    try {
      const { data: latest } = await sb.from('sales_invoices').select('total_centi, paid_centi').eq('id', h.id).maybeSingle();
      const total = Number((latest as { total_centi: number } | null)?.total_centi ?? 0);
      const paid  = Number((latest as { paid_centi: number } | null)?.paid_centi ?? 0);
      const due   = Math.max(0, total - paid);
      const res = await applyCustomerCreditToSi(sb, {
        debtorCode: h.debtor_code,
        debtorName: h.debtor_name,
        siId: h.id,
        siNumber: h.invoice_number,
        remainingDueCenti: due,
        createdBy: user.id,
      });
      creditApplied = res.applied;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[customer-credit] apply-on-create failed for ${h.invoice_number}:`, e);
    }
  }

  if (creditApplied > 0) await recomputePaid(sb, h.id);
  return c.json({ id: h.id, invoiceNumber: h.invoice_number, revenue, creditApplied }, 201);
});

/* ── Convert picked DO LINES (partial qty) → ONE Sales Invoice ───────────── */
salesInvoices.post('/from-dos', async (c) => {
  const sb = c.get('supabase'); const user = c.get('user');
  let body: { picks?: Array<{ doItemId?: string; qty?: number }>; asDraft?: unknown };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }
  /* DRAFT flow — opt-in, identical to POST /. A DRAFT SI off DO lines commits
     nothing (no AR/GL revenue, no credit) until confirm. A DRAFT SI is allowed
     to draw from DO lines (a draft is just a draft; confirm does the posting). */
  const isDraft = body.asDraft === true;

  const pickQtyById = new Map<string, number>();
  for (const p of (body.picks ?? [])) {
    if (!p || !p.doItemId) continue;
    const q = Number(p.qty ?? 0);
    if (!(q > 0)) continue;
    pickQtyById.set(p.doItemId, (pickQtyById.get(p.doItemId) ?? 0) + q);
  }
  if (pickQtyById.size === 0) return c.json({ error: 'picks_required' }, 400);

  const pickedIds = [...pickQtyById.keys()];
  const { data: pickedItemRows, error: pErr } = await sb
    .from('delivery_order_items')
    .select('id, delivery_order_id')
    .in('id', pickedIds);
  if (pErr) return c.json({ error: 'load_failed', reason: pErr.message }, 500);
  const idToDo = new Map<string, string>();
  for (const r of (pickedItemRows ?? []) as Array<{ id: string; delivery_order_id: string }>) idToDo.set(r.id, r.delivery_order_id);
  const missing = pickedIds.filter((id) => !idToDo.has(id));
  if (missing.length > 0) return c.json({ error: 'do_item_not_found', missing }, 404);

  const doIds = [...new Set([...idToDo.values()])];
  const remainingMap = await doInvoiceableRemaining(sb, doIds);

  const customers = new Set<string>();
  const customerNames = new Set<string>();
  for (const id of pickedIds) {
    const line = remainingMap.get(id);
    if (!line) return c.json({ error: 'do_item_not_found', missing: [id] }, 404);
    customers.add(custKeyOf(line));
    customerNames.add(line.debtorName ?? line.debtorCode ?? '(none)');
  }
  if (customers.size > 1) {
    return c.json({
      error: 'mixed_customers',
      message: 'All picked Delivery Order lines must belong to the same customer to combine into one Sales Invoice.',
      customers: [...customerNames],
    }, 400);
  }

  for (const id of pickedIds) {
    const line = remainingMap.get(id)!;
    const qty = pickQtyById.get(id)!;
    if (qty < 1 || qty > line.remaining) {
      return c.json({
        error: 'over_remaining',
        message: `${line.itemCode} on ${line.doNumber}: pick qty ${qty} exceeds remaining ${line.remaining}.`,
        doItemId: id,
        doNumber: line.doNumber,
        itemCode: line.itemCode,
        remaining: line.remaining,
        requested: qty,
      }, 409);
    }
  }

  const sortedPicks = pickedIds
    .map((id) => remainingMap.get(id)!)
    .sort((a, b) => a.doNumber.localeCompare(b.doNumber) || (a.lineSeq - b.lineSeq) || a.doItemId.localeCompare(b.doItemId));
  const firstDoId = sortedPicks[0]!.deliveryOrderId;
  const distinctDoNumbers = [...new Set(sortedPicks.map((l) => l.doNumber))].sort();

  const DO_HEADER =
    'id, do_number, so_doc_no, debtor_code, debtor_name, customer_delivery_date, ' +
    'salesperson_id, agent, email, customer_type, building_type, branding, venue, venue_id, ref, ' +
    'customer_so_no, po_doc_no, sales_location, customer_state, customer_country, note, ' +
    'address1, address2, city, state, postcode, phone, currency, ' +
    'emergency_contact_name, emergency_contact_phone, emergency_contact_relationship';
  const { data: doHeaderRow, error: hLoadErr } = await sb
    .from('delivery_orders')
    .select(DO_HEADER)
    .eq('id', firstDoId)
    .maybeSingle();
  if (hLoadErr) return c.json({ error: 'load_failed', reason: hLoadErr.message }, 500);
  if (!doHeaderRow) return c.json({ error: 'delivery_order_not_found' }, 404);
  const head = doHeaderRow as unknown as Record<string, unknown>;

  const invoiceNumber = await nextNum(sb);
  const nowIso = new Date().toISOString();
  const phoneRaw = head.phone as string | null;
  const emPhoneRaw = head.emergency_contact_phone as string | null;

  const { data: header, error: hErr } = await sb.from('sales_invoices').insert({
    invoice_number: invoiceNumber,
    so_doc_no: (head.so_doc_no as string | null) ?? null,
    delivery_order_id: firstDoId,
    debtor_code: (head.debtor_code as string | null) ?? null,
    debtor_name: (head.debtor_name as string | null) ?? 'Customer',
    invoice_date: new Date().toISOString().slice(0, 10),
    customer_delivery_date: (head.customer_delivery_date as string | null) ?? null,
    address1: (head.address1 as string | null) ?? null,
    address2: (head.address2 as string | null) ?? null,
    city: (head.city as string | null) ?? null,
    state: (head.state as string | null) ?? (head.customer_state as string | null) ?? null,
    customer_state: (head.customer_state as string | null) ?? (head.state as string | null) ?? null,
    customer_country: (head.customer_country as string | null) ?? null,
    postcode: (head.postcode as string | null) ?? null,
    phone: phoneRaw ? (normalizePhone(phoneRaw) ?? phoneRaw) : null,
    salesperson_id: (head.salesperson_id as string | null) ?? null,
    agent: (head.agent as string | null) ?? null,
    email: (head.email as string | null) ?? null,
    customer_type: (head.customer_type as string | null) ?? null,
    building_type: (head.building_type as string | null) ?? null,
    branding: (head.branding as string | null) ?? null,
    venue: (head.venue as string | null) ?? null,
    venue_id: (head.venue_id as string | null) ?? null,
    ref: distinctDoNumbers.length > 1
      ? `Merged from ${distinctDoNumbers.join(', ')}`
      : ((head.ref as string | null) ?? null),
    customer_so_no: (head.customer_so_no as string | null) ?? null,
    po_doc_no: (head.po_doc_no as string | null) ?? null,
    sales_location: (head.sales_location as string | null) ?? null,
    note: (head.note as string | null) ?? null,
    emergency_contact_name: (head.emergency_contact_name as string | null) ?? null,
    emergency_contact_phone: emPhoneRaw ? (normalizePhone(emPhoneRaw) ?? emPhoneRaw) : null,
    emergency_contact_relationship: (head.emergency_contact_relationship as string | null) ?? null,
    currency: ((head.currency as string | null) ?? 'MYR').toUpperCase(),
    status: isDraft ? 'DRAFT' : 'SENT',
    sent_at: isDraft ? null : nowIso,
    confirmed_at: isDraft ? null : nowIso,
    created_by: user.id,
  }).select(HEADER).single();
  if (hErr) return c.json({ error: 'insert_failed', reason: hErr.message }, 500);
  const h = header as unknown as { id: string; invoice_number: string };

  const rows = sortedPicks.map((line, lineNo) => buildItemRow(h.id, {
    doItemId: line.doItemId,
    itemCode: line.itemCode,
    itemGroup: line.itemGroup,
    description: line.description,
    description2: line.description2,
    uom: line.uom,
    qty: pickQtyById.get(line.doItemId)!,
    unitPriceCenti: line.unitPriceCenti,
    discountCenti: line.discountCenti,
    unitCostCenti: line.unitCostCenti,
    variants: line.variants,
  }, lineNo));
  const { error: iErr } = await sb.from('sales_invoice_items').insert(rows);
  if (iErr) {
    await sb.from('sales_invoices').delete().eq('id', h.id);
    return c.json({ error: 'items_insert_failed', reason: iErr.message }, 500);
  }

  await recomputeTotals(sb, h.id);

  /* LEAK GUARD (DRAFT) — no AR/GL revenue, no customer credit on a DRAFT SI.
     Both move to the confirm transition (PATCH /:id/status DRAFT→SENT). */
  if (isDraft) {
    return c.json({ id: h.id, invoiceNumber: h.invoice_number, revenue: { posted: false, status: 'draft' }, creditApplied: 0 }, 201);
  }

  let revenue: { posted: boolean; jeNo?: string; status: string } = { posted: false, status: 'skipped' };
  const post = await postSiRevenue(sb, h.invoice_number);
  if (post.ok) {
    revenue = { posted: post.status === 'posted', jeNo: post.jeNo, status: post.status };
  } else {
    revenue = { posted: false, status: post.status };
    if (post.status !== 'zero_total' && post.status !== 'invoice_not_found') {
      // eslint-disable-next-line no-console
      console.error(`[si-revenue] post failed for ${h.invoice_number}:`, post.status, post.reason);
    }
  }

  let creditApplied = 0;
  try {
    const { data: latest } = await sb.from('sales_invoices').select('total_centi, paid_centi, debtor_code, debtor_name').eq('id', h.id).maybeSingle();
    const l = latest as { total_centi: number | null; paid_centi: number | null; debtor_code: string | null; debtor_name: string | null } | null;
    if (l?.debtor_code) {
      const due = Math.max(0, Number(l.total_centi ?? 0) - Number(l.paid_centi ?? 0));
      const res = await applyCustomerCreditToSi(sb, {
        debtorCode: l.debtor_code,
        debtorName: l.debtor_name,
        siId: h.id,
        siNumber: h.invoice_number,
        remainingDueCenti: due,
        createdBy: user.id,
      });
      creditApplied = res.applied;
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[customer-credit] apply-on-from-dos failed for ${h.invoice_number}:`, e);
  }

  if (creditApplied > 0) await recomputePaid(sb, h.id);
  return c.json({ id: h.id, invoiceNumber: h.invoice_number, revenue, creditApplied }, 201);
});

/* ── Append a Delivery Order's lines into an EXISTING invoice ────────────── */
salesInvoices.post('/:id/items/from-do/:doId', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const doId = c.req.param('doId');

  const { data: si } = await sb.from('sales_invoices').select('id, invoice_number, status').eq('id', id).maybeSingle();
  if (!si) return c.json({ error: 'not_found' }, 404);
  if ((si as { status: string }).status === 'CANCELLED') return c.json({ error: 'invoice_cancelled' }, 409);

  const { data: doHeader } = await sb.from('delivery_orders').select('id, status').eq('id', doId).maybeSingle();
  if (!doHeader) return c.json({ error: 'delivery_order_not_found' }, 404);
  if ((doHeader as { status: string }).status === 'CANCELLED') return c.json({ error: 'do_cancelled' }, 409);

  const { data: doItems } = await sb.from('delivery_order_items').select(
    'id, item_code, item_group, description, description2, uom, qty, ' +
    'unit_price_centi, discount_centi, unit_cost_centi, variants, notes',
  ).eq('delivery_order_id', doId)
    .order('line_no', { ascending: true, nullsFirst: false })
    .order('created_at');

  const doLines = (doItems as Array<Record<string, unknown>> | null) ?? [];
  const remainingMap = await doRemainingByItemId(sb, doLines.map((it) => it.id as string));
  const { data: maxNoRow } = await sb
    .from('sales_invoice_items')
    .select('line_no')
    .eq('sales_invoice_id', id)
    .order('line_no', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  const baseLineNo = typeof (maxNoRow as { line_no?: number | null } | null)?.line_no === 'number'
    ? (maxNoRow as { line_no: number }).line_no + 1
    : null;
  const rows = doLines
    .map((it) => ({ it, remaining: remainingMap.get(it.id as string) ?? 0 }))
    .filter(({ remaining }) => remaining > 0)
    .map(({ it, remaining }, idx) => buildItemRow(id, {
      doItemId: it.id,
      itemCode: it.item_code,
      itemGroup: it.item_group,
      description: it.description,
      description2: it.description2,
      uom: it.uom,
      qty: Math.min(Number(it.qty ?? 0), remaining),
      unitPriceCenti: it.unit_price_centi,
      discountCenti: it.discount_centi,
      unitCostCenti: it.unit_cost_centi,
      variants: it.variants,
      notes: it.notes,
    }, baseLineNo === null ? null : baseLineNo + idx));
  if (rows.length === 0) return c.json({ error: 'do_fully_invoiced' }, 409);

  const { error: iErr } = await sb.from('sales_invoice_items').insert(rows);
  if (iErr) return c.json({ error: 'items_insert_failed', reason: iErr.message }, 500);
  await recomputeTotals(sb, id);
  await recomputePaid(sb, id);
  /* LEAK GUARD (DRAFT) — appending DO lines to a DRAFT invoice must NOT post
     AR/GL revenue. Posting happens once, on confirm. */
  if ((si as { status: string }).status !== 'DRAFT') {
    await postSiRevenue(sb, (si as { invoice_number: string }).invoice_number);
  }
  return c.json({ ok: true, added: rows.length }, 201);
});

// ── Header PATCH (editable SO/DO-style fields) ─────────────────────────────
salesInvoices.patch('/:id', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }

  const map: Array<[string, string]> = [
    ['debtorCode', 'debtor_code'], ['debtorName', 'debtor_name'], ['agent', 'agent'],
    ['salesLocation', 'sales_location'], ['ref', 'ref'], ['poDocNo', 'po_doc_no'],
    ['venue', 'venue'], ['venueId', 'venue_id'], ['branding', 'branding'],
    ['address1', 'address1'], ['address2', 'address2'],
    ['city', 'city'], ['state', 'state'], ['postcode', 'postcode'], ['phone', 'phone'],
    ['note', 'note'], ['notes', 'notes'],
    ['invoiceDate', 'invoice_date'], ['dueDate', 'due_date'], ['currency', 'currency'],
    ['customerState', 'customer_state'], ['customerCountry', 'customer_country'],
    ['customerSoNo', 'customer_so_no'],
    ['customerDeliveryDate', 'customer_delivery_date'],
    ['email', 'email'], ['customerType', 'customer_type'],
    ['salespersonId', 'salesperson_id'], ['buildingType', 'building_type'],
    ['emergencyContactName', 'emergency_contact_name'],
    ['emergencyContactPhone', 'emergency_contact_phone'],
    ['emergencyContactRelationship', 'emergency_contact_relationship'],
  ];
  const PHONE_FIELDS = new Set(['phone', 'emergencyContactPhone']);
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const [from, to] of map) {
    if (body[from] === undefined) continue;
    if (PHONE_FIELDS.has(from) && typeof body[from] === 'string') {
      const raw = body[from] as string;
      updates[to] = normalizePhone(raw) ?? raw;
    } else {
      updates[to] = body[from];
    }
  }
  if (Object.keys(updates).length === 1) return c.json({ ok: true, changed: 0 });

  const { data, error } = await sb.from('sales_invoices').update(updates).eq('id', id).select('id').maybeSingle();
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  if (!data) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true, id });
});

// ── Item CRUD ─────────────────────────────────────────────────────────────
salesInvoices.post('/:id/items', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (!it.itemCode) return c.json({ error: 'item_code_required' }, 400);

  {
    const codeCheck = await validateItemCodes(sb, [it.itemCode as string]);
    if (!codeCheck.ok) return c.json(unknownItemCodeResponse(codeCheck.unknown), 409);
  }

  const { data: header } = await sb.from('sales_invoices').select('id, invoice_number, status').eq('id', id).maybeSingle();
  if (!header) return c.json({ error: 'not_found' }, 404);
  if (((header as { status: string }).status ?? '').toUpperCase() === 'CANCELLED') {
    return c.json({ error: 'invoice_cancelled', message: 'This invoice is cancelled — reopen it before adding lines.' }, 409);
  }

  {
    const over = await checkSiOverRemaining(sb, [it]);
    if (over) return c.json(over, 409);
  }

  const { data: maxNoRow } = await sb
    .from('sales_invoice_items')
    .select('line_no')
    .eq('sales_invoice_id', id)
    .order('line_no', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  const nextLineNo = typeof (maxNoRow as { line_no?: number | null } | null)?.line_no === 'number'
    ? (maxNoRow as { line_no: number }).line_no + 1
    : null;
  const row = buildItemRow(id, it, nextLineNo);
  const { data, error } = await sb.from('sales_invoice_items').insert(row).select(ITEM).single();
  if (error) return c.json({ error: 'insert_failed', reason: error.message }, 500);
  await recomputeTotals(sb, id);
  await recomputePaid(sb, id);
  try {
    await resyncSiRevenue(sb, (header as { invoice_number: string }).invoice_number);
  } catch (e) { /* eslint-disable-next-line no-console */ console.error('[si-revenue] post-add-line resync failed:', e); }
  return c.json({ item: data }, 201);
});

salesInvoices.patch('/:id/items/:itemId', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const itemId = c.req.param('itemId');
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }

  {
    const { data: hd } = await sb.from('sales_invoices').select('status').eq('id', id).maybeSingle();
    if (hd && ((hd as { status: string }).status ?? '').toUpperCase() === 'CANCELLED') {
      return c.json({ error: 'invoice_cancelled', message: 'This invoice is cancelled — reopen it before editing lines.' }, 409);
    }
  }

  if (it.itemCode !== undefined) {
    const codeCheck = await validateItemCodes(sb, [it.itemCode as string]);
    if (!codeCheck.ok) return c.json(unknownItemCodeResponse(codeCheck.unknown), 409);
  }

  const { data: prev } = await sb.from('sales_invoice_items')
    .select('qty, unit_price_centi, discount_centi, tax_centi, unit_cost_centi, item_code, item_group, description, uom, variants, notes, do_item_id')
    .eq('id', itemId).eq('sales_invoice_id', id).maybeSingle();
  if (!prev) return c.json({ error: 'not_found' }, 404);

  const qty = it.qty !== undefined ? Number(it.qty) : Number(prev.qty);

  if (it.qty !== undefined && prev.do_item_id && qty > Number(prev.qty)) {
    const exclude = new Map<string, number>([[prev.do_item_id as string, Number(prev.qty)]]);
    const over = await checkSiOverRemaining(sb, [{ doItemId: prev.do_item_id, qty }], exclude);
    if (over) return c.json(over, 409);
  }
  const unitPrice = it.unitPriceCenti !== undefined ? Number(it.unitPriceCenti) : Number(prev.unit_price_centi);
  const discount = it.discountCenti !== undefined ? Number(it.discountCenti) : Number(prev.discount_centi);
  const tax = it.taxCenti !== undefined ? Number(it.taxCenti) : Number(prev.tax_centi ?? 0);
  const unitCost = it.unitCostCenti !== undefined ? Number(it.unitCostCenti) : Number(prev.unit_cost_centi);
  const lineTotal = (qty * unitPrice) - discount + tax;
  const lineCost = qty * unitCost;

  const updates: Record<string, unknown> = {
    qty, unit_price_centi: unitPrice, discount_centi: discount, tax_centi: tax, unit_cost_centi: unitCost,
    line_total_centi: lineTotal, line_cost_centi: lineCost, line_margin_centi: lineTotal - lineCost,
  };
  for (const [from, to] of [
    ['itemCode', 'item_code'], ['itemGroup', 'item_group'], ['description', 'description'],
    ['uom', 'uom'], ['variants', 'variants'], ['notes', 'notes'],
  ] as const) {
    if (it[from] !== undefined) updates[to] = it[from];
  }
  {
    const effGroup = (it.itemGroup ?? prev.item_group) as string | null | undefined;
    const effVariants = (it.variants ?? prev.variants) as Record<string, unknown> | null | undefined;
    updates['description2'] = buildVariantSummary(String(effGroup ?? ''), effVariants ?? null) || null;
  }

  const { error } = await sb.from('sales_invoice_items').update(updates).eq('id', itemId);
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  await recomputeTotals(sb, id);
  await recomputePaid(sb, id);
  try {
    const { data: h } = await sb.from('sales_invoices').select('invoice_number').eq('id', id).maybeSingle();
    if (h) await resyncSiRevenue(sb, (h as { invoice_number: string }).invoice_number);
  } catch (e) { /* eslint-disable-next-line no-console */ console.error('[si-revenue] post-line-edit resync failed:', e); }
  return c.json({ ok: true });
});

salesInvoices.delete('/:id/items/:itemId', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const itemId = c.req.param('itemId');
  {
    const { data: hd } = await sb.from('sales_invoices').select('status').eq('id', id).maybeSingle();
    if (hd && ((hd as { status: string }).status ?? '').toUpperCase() === 'CANCELLED') {
      return c.json({ error: 'invoice_cancelled', message: 'This invoice is cancelled — reopen it before deleting lines.' }, 409);
    }
  }
  {
    const { data: line } = await sb.from('sales_invoice_items')
      .select('id').eq('id', itemId).eq('sales_invoice_id', id).maybeSingle();
    if (!line) return c.json({ error: 'not_found' }, 404);
  }
  const { error } = await sb.from('sales_invoice_items').delete().eq('id', itemId);
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);
  await recomputeTotals(sb, id);
  await recomputePaid(sb, id);
  try {
    const { data: h } = await sb.from('sales_invoices').select('invoice_number').eq('id', id).maybeSingle();
    if (h) await resyncSiRevenue(sb, (h as { invoice_number: string }).invoice_number);
  } catch (e) { /* eslint-disable-next-line no-console */ console.error('[si-revenue] post-line-delete resync failed:', e); }
  return c.json({ ok: true });
});

// ── Payments (mirror DO / SO payments ledger) ──────────────────────────────
salesInvoices.get('/:id/payments', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  const { data, error } = await sb
    .from('sales_invoice_payments')
    .select(`${PAYMENT_COLS}, staff:collected_by ( name )`)
    .eq('sales_invoice_id', id)
    .order('paid_at', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const payments = (data ?? []).map((r: unknown) => {
    const row = r as Record<string, unknown> & { staff: { name: string } | null };
    const { staff, ...rest } = row;
    return { ...rest, collected_by_name: staff?.name ?? null };
  });
  return c.json({ payments });
});

const paymentCreateSchema = z.object({
  paidAt:             z.string().min(1),
  method:             z.enum(['merchant', 'transfer', 'cash', 'installment']),
  merchantProvider:   z.string().trim().min(1).optional().nullable(),
  installmentMonths:  z.number().int().min(0).max(60).optional().nullable(),
  onlineType:         z.string().trim().min(1).optional().nullable(),
  approvalCode:       z.string().optional().nullable(),
  amountCenti:        z.number().int().nonnegative(),
  accountSheet:       z.string().optional().nullable(),
  collectedBy:        z.string().uuid().optional().nullable(),
  note:               z.string().optional().nullable(),
});

/* Roll the SI paid_centi + status (PARTIALLY_PAID / PAID) from the persisted
   payments ledger. Mirrors the DO ledger; never moves a CANCELLED invoice. */
async function recomputePaid(sb: any, salesInvoiceId: string) {
  const { data: pays } = await sb.from('sales_invoice_payments')
    .select('amount_centi').eq('sales_invoice_id', salesInvoiceId);
  const paid = (pays ?? []).reduce((s: number, p: { amount_centi: number }) => s + Number(p.amount_centi ?? 0), 0);
  const { data: cur } = await sb.from('sales_invoices').select('total_centi, status').eq('id', salesInvoiceId).maybeSingle();
  if (!cur) return;
  const c0 = cur as { total_centi: number; status: string };
  const updates: Record<string, unknown> = { paid_centi: paid, updated_at: new Date().toISOString() };
  /* LEAK GUARD (DRAFT) — never auto-advance a DRAFT invoice's status off the
     payments rollup. A DRAFT stays DRAFT until it is explicitly confirmed; the
     `else` branch below would otherwise silently flip it to SENT on a line edit.
     CANCELLED is likewise frozen. */
  if (c0.status !== 'CANCELLED' && c0.status !== 'DRAFT') {
    if (paid >= c0.total_centi && c0.total_centi > 0) {
      updates.status = 'PAID';
      updates.paid_at = new Date().toISOString();
    } else if (paid > 0) {
      updates.status = 'PARTIALLY_PAID';
    } else {
      updates.status = 'SENT';
    }
  }
  await sb.from('sales_invoices').update(updates).eq('id', salesInvoiceId);
}

salesInvoices.post('/:id/payments', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const user = c.get('user');

  const { data: doc } = await sb.from('sales_invoices').select('id, status').eq('id', id).maybeSingle();
  if (!doc) return c.json({ error: 'sales_invoice_not_found' }, 404);
  if ((doc as { status?: string }).status === 'CANCELLED') return c.json({ error: 'not_payable', message: 'SI is cancelled' }, 409);
  /* LEAK GUARD (DRAFT) — a DRAFT invoice is not yet committed; it cannot accept
     payments. Confirm it first (DRAFT → SENT), then record payments. */
  if ((doc as { status?: string }).status === 'DRAFT') return c.json({ error: 'not_payable', message: 'SI is a draft — confirm it before recording payments' }, 409);

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = paymentCreateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const p = parsed.data;

  const merchantLike      = p.method === 'merchant' || p.method === 'installment';
  const merchantProvider  = merchantLike ? (p.merchantProvider ?? null) : null;
  const installmentMonths = merchantLike
    ? (typeof p.installmentMonths === 'number' && p.installmentMonths > 0 ? p.installmentMonths : null)
    : null;
  const onlineType        = p.method === 'transfer' ? (p.onlineType ?? null) : null;

  const { data, error } = await sb.from('sales_invoice_payments').insert({
    sales_invoice_id:   id,
    paid_at:            p.paidAt,
    method:             p.method,
    merchant_provider:  merchantProvider,
    installment_months: installmentMonths,
    online_type:        onlineType,
    approval_code:      p.approvalCode ?? null,
    amount_centi:       p.amountCenti,
    account_sheet:      p.accountSheet ?? null,
    collected_by:       p.collectedBy ?? null,
    note:               p.note ?? null,
    created_by:         user.id,
  }).select(PAYMENT_COLS).single();
  if (error) return c.json({ error: 'insert_failed', reason: error.message }, 500);
  await recomputePaid(sb, id);
  try { await reconcileSiOverpay(sb, id); }
  catch (e) { /* eslint-disable-next-line no-console */ console.error('[customer-credit] overpay reconcile failed (post):', e); }
  return c.json({ payment: data }, 201);
});

salesInvoices.delete('/:id/payments/:paymentId', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const paymentId = c.req.param('paymentId');
  const { data: row } = await sb.from('sales_invoice_payments').select('sales_invoice_id').eq('id', paymentId).maybeSingle();
  if (!row) return c.json({ error: 'not_found' }, 404);
  if ((row as { sales_invoice_id: string }).sales_invoice_id !== id) return c.json({ error: 'payment_doc_mismatch' }, 400);
  const { data: inv } = await sb.from('sales_invoices').select('status').eq('id', id).maybeSingle();
  if ((inv as { status?: string } | null)?.status === 'CANCELLED') return c.json({ error: 'not_payable', message: 'SI is cancelled' }, 409);
  const { error } = await sb.from('sales_invoice_payments').delete().eq('id', paymentId);
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);
  await recomputePaid(sb, id);
  try { await reconcileSiOverpay(sb, id); }
  catch (e) { /* eslint-disable-next-line no-console */ console.error('[customer-credit] overpay reconcile failed (delete):', e); }
  return c.json({ ok: true });
});

// ── Status transition (Cancel / Reopen) ────────────────────────────────────
salesInvoices.patch('/:id/status', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  let body: { status?: string }; try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (!body.status) return c.json({ error: 'status_required' }, 400);
  const now = new Date().toISOString();
  const ts: Record<string, string> = { updated_at: now };
  if (body.status === 'SENT' || body.status === 'ISSUED') ts.sent_at = now;
  if (body.status === 'PAID') ts.paid_at = now;
  const status = body.status === 'ISSUED' ? 'SENT' : body.status;

  const { data: curRow, error: curErr } = await sb.from('sales_invoices')
    .select('status').eq('id', id).maybeSingle();
  if (curErr) return c.json({ error: 'load_failed', reason: curErr.message }, 500);
  if (!curRow) return c.json({ error: 'not_found' }, 404);
  const prevStatus = ((curRow as { status: string }).status ?? '').toUpperCase();

  /* ── CONFIRM transition (DRAFT → SENT) ─────────────────────────────────
     A DRAFT SI committed nothing on create. Confirming it is where the
     posting now happens: stamp sent_at / confirmed_at, post AR/GL revenue
     (postSiRevenue — idempotent), then auto-apply any customer credit
     (applyCustomerCreditToSi). DRAFT may ONLY move to SENT (or be cancelled,
     handled below). This mirrors the SO confirm (status PATCH DRAFT→CONFIRMED). */
  if (prevStatus === 'DRAFT' && status !== 'CANCELLED') {
    if (status !== 'SENT') {
      return c.json({
        error: 'invalid_transition',
        message: `A draft invoice can only be confirmed (to SENT) or cancelled. Cannot move directly to ${status}.`,
        from: prevStatus, to: status,
      }, 409);
    }
    const { data: confirmed, error: cErr } = await sb.from('sales_invoices')
      .update({ status: 'SENT', sent_at: now, confirmed_at: now, updated_at: now })
      .eq('id', id).eq('status', 'DRAFT')
      .select('id, status, invoice_number, debtor_code, debtor_name, total_centi, paid_centi')
      .maybeSingle();
    if (cErr) return c.json({ error: 'update_failed', reason: cErr.message }, 500);
    if (!confirmed) return c.json({ error: 'not_found' }, 404);
    const d = confirmed as { id: string; status: string; invoice_number: string; debtor_code: string | null; debtor_name: string | null; total_centi: number | null; paid_centi: number | null };

    /* POST revenue now (was skipped on draft create). Idempotent + best-effort. */
    const post = await postSiRevenue(sb, d.invoice_number);
    if (!post.ok && post.status !== 'zero_total' && post.status !== 'invoice_not_found') {
      // eslint-disable-next-line no-console
      console.error(`[si-revenue] confirm post failed for ${d.invoice_number}:`, post.status, (post as { reason?: string }).reason);
    }

    /* Auto-apply customer credit now (was skipped on draft create). */
    if (d.debtor_code) {
      try {
        const { data: latest } = await sb.from('sales_invoices').select('total_centi, paid_centi').eq('id', id).maybeSingle();
        const total = Number((latest as { total_centi: number } | null)?.total_centi ?? 0);
        const paid  = Number((latest as { paid_centi: number } | null)?.paid_centi ?? 0);
        const res = await applyCustomerCreditToSi(sb, {
          debtorCode: d.debtor_code,
          debtorName: d.debtor_name,
          siId: id,
          siNumber: d.invoice_number,
          remainingDueCenti: Math.max(0, total - paid),
          createdBy: c.get('user')?.id,
        });
        if (res.applied > 0) await recomputePaid(sb, id);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(`[customer-credit] apply-on-confirm failed for ${d.invoice_number}:`, e);
      }
    }
    return c.json({ salesInvoice: { id, status: 'SENT' } });
  }

  if (status === 'CANCELLED' && prevStatus === 'CANCELLED') {
    return c.json({ salesInvoice: { id, status: 'CANCELLED' } });
  }

  const ACTIVE = new Set(['SENT', 'PARTIALLY_PAID', 'PAID', 'OVERDUE']);
  const isReopen = prevStatus === 'CANCELLED' && status !== 'CANCELLED';
  if (isReopen && status !== 'SENT') {
    return c.json({
      error: 'invalid_transition',
      message: `Cannot reopen a cancelled invoice straight to ${status}. Reopen to SENT first; payment status is re-derived from the ledger.`,
      from: prevStatus, to: status,
    }, 409);
  }
  if (isReopen && status === 'SENT') {
    const { data: reopenLines } = await sb
      .from('sales_invoice_items')
      .select('do_item_id, qty')
      .eq('sales_invoice_id', id);
    const linesForCheck = ((reopenLines ?? []) as Array<{ do_item_id: string | null; qty: number }>)
      .filter((l) => l.do_item_id)
      .map((l) => ({ doItemId: l.do_item_id as string, qty: l.qty }));
    const over = await checkSiOverRemaining(sb, linesForCheck);
    if (over) {
      return c.json({
        error: 'over_remaining',
        message: 'Cannot reopen — the delivered quantity has since been invoiced elsewhere. The DO lines no longer have room for this invoice.',
        lines: over.lines,
      }, 409);
    }
  }
  if (status !== 'CANCELLED' && status !== 'SENT' && !ACTIVE.has(prevStatus)) {
    return c.json({
      error: 'invalid_transition',
      message: `Cannot move from ${prevStatus} to ${status}. Payment statuses are derived from the payments ledger.`,
      from: prevStatus, to: status,
    }, 409);
  }

  let data: { id: string; status: string; invoice_number: string; paid_centi: number | null; debtor_code: string | null; debtor_name: string | null } | null;
  if (status === 'CANCELLED') {
    const { data: updated, error } = await sb.from('sales_invoices')
      .update({ status, ...ts })
      .eq('id', id).neq('status', 'CANCELLED')
      .select('id, status, invoice_number, paid_centi, debtor_code, debtor_name')
      .maybeSingle();
    if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
    if (!updated) {
      return c.json({ salesInvoice: { id, status: 'CANCELLED' } });
    }
    data = updated as typeof data;
  } else {
    const { data: updated, error } = await sb.from('sales_invoices')
      .update({ status, ...ts })
      .eq('id', id)
      .select('id, status, invoice_number, paid_centi, debtor_code, debtor_name')
      .single();
    if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
    data = updated as typeof data;
  }

  if (status === 'CANCELLED') {
    const d = data as { invoice_number: string; paid_centi: number | null; debtor_code: string | null; debtor_name: string | null };
    const rev = await reverseSiRevenue(sb, d.invoice_number);
    if (!rev.ok) {
      // eslint-disable-next-line no-console
      console.error(`[si-revenue] reversal failed for ${d.invoice_number}:`, rev.status, rev.reason);
    }
    if (Number(d.paid_centi ?? 0) > 0) {
      try {
        const user = c.get('user');
        await creditFromCancelledSi(sb, {
          siId: id,
          siNumber: d.invoice_number,
          debtorCode: d.debtor_code,
          debtorName: d.debtor_name,
          paidCenti: Number(d.paid_centi),
          createdBy: user?.id,
        });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(`[customer-credit] credit-from-cancel failed for ${d.invoice_number}:`, e);
      }
    }
  }

  if (isReopen) {
    const d = data as { invoice_number: string; debtor_code: string | null; debtor_name: string | null };
    const post = await postSiRevenue(sb, d.invoice_number);
    if (!post.ok) {
      // eslint-disable-next-line no-console
      console.error(`[si-revenue] re-post on reopen failed for ${d.invoice_number}:`, post.status, (post as { reason?: string }).reason);
    }
    try {
      const user = c.get('user');
      await reverseCancelledSiCredit(sb, {
        siId: id,
        siNumber: d.invoice_number,
        debtorCode: d.debtor_code,
        debtorName: d.debtor_name,
        createdBy: user?.id,
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[customer-credit] reopen credit-reversal failed for ${d.invoice_number}:`, e);
    }
    try { await recomputePaid(sb, id); }
    catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[si-paid] reopen status recompute failed for ${d.invoice_number}:`, e);
    }
  }

  return c.json({ salesInvoice: data });
});

// Legacy quick-payment endpoint (kept for the Outstanding page + any callers
// that POST a single amount). Records into the payments ledger + rolls status.
salesInvoices.patch('/:id/payment', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const user = c.get('user');
  let body: { amountCenti?: number; notes?: string };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const amount = Number(body.amountCenti ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) return c.json({ error: 'invalid_amount' }, 400);

  const { data: cur } = await sb.from('sales_invoices').select('status').eq('id', id).maybeSingle();
  if (!cur) return c.json({ error: 'not_found' }, 404);
  if ((cur as { status: string }).status === 'CANCELLED') return c.json({ error: 'not_payable', message: 'SI is cancelled' }, 409);
  /* LEAK GUARD (DRAFT) — same as POST /:id/payments: a draft can't be paid. */
  if ((cur as { status: string }).status === 'DRAFT') return c.json({ error: 'not_payable', message: 'SI is a draft — confirm it before recording payments' }, 409);

  const { error } = await sb.from('sales_invoice_payments').insert({
    sales_invoice_id: id,
    paid_at: new Date().toISOString().slice(0, 10),
    method: 'cash',
    amount_centi: amount,
    note: body.notes ?? null,
    created_by: user.id,
  });
  if (error) return c.json({ error: 'payment_failed', reason: error.message }, 500);
  await recomputePaid(sb, id);
  /* Edge #A — an overpayment via this legacy quick-pay must book the excess as a
     customer-credit, same as the POST /payments + DELETE paths. Without this the
     overpaid amount was silently lost (no OVERPAY credit row). */
  try { await reconcileSiOverpay(sb, id); }
  catch (e) { /* eslint-disable-next-line no-console */ console.error('[customer-credit] overpay reconcile failed (quick-pay):', e); }
  const { data } = await sb.from('sales_invoices').select('id, paid_centi, status').eq('id', id).maybeSingle();
  return c.json({ salesInvoice: data });
});
