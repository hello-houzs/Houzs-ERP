// ----------------------------------------------------------------------------
// /reports — read-only reporting endpoints (AutoCount-style listings).
//
// Ported from 2990's apps/api/src/routes/reports.ts. Serves the four
// AutoCount-style "Detail Listing" reads the vendored report pages render:
//   GET /reports/sales-order-detail-listing
//   GET /reports/delivery-order-detail-listing
//   GET /reports/sales-invoice-detail-listing
//   GET /reports/delivery-return-detail-listing
// (the vendored authedFetch base prepends /api/scm).
//
// One row per LINE ITEM, with the parent document header denormalised onto
// each row. The client decides which AutoCount columns to render.
//
// Houzs adaptation: same plumbing as the sibling SCM routes — supabaseAuth
// bridge + scm-scoped service client via c.get('supabase'); every table ref
// already resolves against the `scm` schema (mfg_sales_orders / *_items /
// mfg_sales_order_payments / staff / delivery_orders / *_items / sales_invoices
// / *_items / delivery_returns / *_items — all confirmed present in
// scripts/scm-schema/2990s-full-schema.sql). Read-only: this route never
// writes. Mounted at '/reports' in scm/index.ts.
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';

export const reports = new Hono<{ Bindings: Env; Variables: Variables }>();
reports.use('*', supabaseAuth);

reports.get('/sales-order-detail-listing', async (c) => {
  const sb = c.get('supabase');

  const dateFrom         = c.req.query('dateFrom');
  const dateTo           = c.req.query('dateTo');
  const docNo            = c.req.query('docNo');
  const debtorCode       = c.req.query('debtorCode');
  const itemCode         = c.req.query('itemCode');
  const deliveryDateFrom = c.req.query('deliveryDateFrom');
  const deliveryDateTo   = c.req.query('deliveryDateTo');
  const sortBy           = (c.req.query('sortBy') ?? 'date') as 'date' | 'doc_no' | 'item_code';

  // Pull SO header + items as nested join. supabase-js renders the nested
  // table as a property on the item row — we flatten it back out below so
  // the client doesn't need to traverse mfg_sales_orders.*.
  let q = sb
    .from('mfg_sales_order_items')
    .select(`
      id, doc_no, line_date, debtor_code, debtor_name, agent, item_group, item_code,
      description, description2, uom, location, qty, unit_price_centi, discount_centi,
      total_centi, tax_centi, total_inc_centi, balance_centi, payment_status, venue,
      branding, remark, cancelled, variants, created_at,
      unit_cost_centi, line_cost_centi, line_margin_centi,
      divan_height_inches, leg_height_inches, custom_specials,
      mfg_sales_orders!inner (
        doc_no, so_date, debtor_code, debtor_name, agent, branding, venue, ref,
        po_doc_no, phone, address1, address2, address3, address4,
        currency, status, remark2, remark3, remark4, note,
        processing_date, sales_exemption_expiry, approval_code,
        local_total_centi, balance_centi, deposit_centi,
        mattress_sofa_centi, bedframe_centi, accessories_centi, others_centi, service_centi,
        mattress_sofa_cost_centi, bedframe_cost_centi, accessories_cost_centi, others_cost_centi, service_cost_centi,
        total_cost_centi, total_margin_centi, margin_pct_basis,
        customer_delivery_date, internal_expected_dd, target_date,
        customer_state, customer_country, customer_po, customer_po_id, customer_po_date, customer_so_no,
        hub_name
      )
    `)
    .limit(2000);

  if (docNo)      q = q.ilike('doc_no', `%${docNo}%`);
  if (itemCode)   q = q.ilike('item_code', `%${itemCode}%`);
  if (debtorCode) q = q.eq('debtor_code', debtorCode);

  // Sort: line-level for item_code, header-level (joined) for date/doc_no.
  if (sortBy === 'item_code') {
    q = q.order('item_code', { ascending: true });
  } else if (sortBy === 'doc_no') {
    q = q.order('doc_no', { ascending: false });
  } else {
    q = q.order('line_date', { ascending: false });
  }

  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  type ItemRow = Record<string, unknown> & {
    // Supabase's foreign-table join can return either a single object or an
    // array — both shapes are normalised in the flatten pass below.
    mfg_sales_orders: Record<string, unknown> | Record<string, unknown>[] | null;
    line_date: string | null;
    doc_no: string;
    variants:             Record<string, unknown> | null;
    divan_height_inches:  number | null;
    leg_height_inches:    number | null;
    custom_specials:      unknown;
  };
  const itemsRaw = (data ?? []) as unknown as ItemRow[];

  // paid_centi is derived live from the mfg_sales_order_payments ledger.
  // Aggregate once for all docs in this result and attach as paid_total_centi.
  // Also capture per-doc: last_payment_at (MAX paid_at) + the most-recent
  // payment's account_sheet / approval_code / collected_by. collected_by is a
  // staff.id uuid, so resolve once via a second batch query to staff.
  const docNos = Array.from(new Set(itemsRaw.map((i) => i.doc_no))).filter(Boolean);
  const paidByDoc = new Map<string, number>();
  type PaymentMeta = {
    lastPaidAt: string | null;
    accountSheet: string | null;
    approvalCode: string | null;
    collectedById: string | null;
  };
  const paymentMetaByDoc = new Map<string, PaymentMeta>();
  // The Approval Code column aggregates EVERY ledger code (a doc can be paid
  // in multiple instalments, each with its own code).
  const approvalCodesByDoc = new Map<string, Array<{ paidAt: string | null; code: string }>>();
  if (docNos.length > 0) {
    const { data: paymentTotals, error: payErr } = await sb
      .from('mfg_sales_order_payments')
      .select('so_doc_no, amount_centi, paid_at, account_sheet, approval_code, collected_by')
      .in('so_doc_no', docNos);
    if (payErr) return c.json({ error: 'load_failed', reason: payErr.message }, 500);
    for (const p of paymentTotals ?? []) {
      const row = p as {
        so_doc_no: string;
        amount_centi: number | null;
        paid_at: string | null;
        account_sheet: string | null;
        approval_code: string | null;
        collected_by: string | null;
      };
      const key = row.so_doc_no;
      paidByDoc.set(key, (paidByDoc.get(key) ?? 0) + Number(row.amount_centi ?? 0));
      if (row.approval_code && row.approval_code.trim() !== '') {
        const arr = approvalCodesByDoc.get(key) ?? [];
        arr.push({ paidAt: row.paid_at ?? null, code: row.approval_code.trim() });
        approvalCodesByDoc.set(key, arr);
      }
      const prev = paymentMetaByDoc.get(key);
      // "Most recent" = max paid_at; on tie keep first seen. Null paid_at
      // sorts older than any real date.
      const isNewer = !prev || !prev.lastPaidAt || (row.paid_at && row.paid_at > prev.lastPaidAt);
      if (isNewer) {
        paymentMetaByDoc.set(key, {
          lastPaidAt:    row.paid_at ?? prev?.lastPaidAt ?? null,
          accountSheet:  row.account_sheet  ?? prev?.accountSheet  ?? null,
          approvalCode:  row.approval_code  ?? prev?.approvalCode  ?? null,
          collectedById: row.collected_by   ?? prev?.collectedById ?? null,
        });
      }
    }
  }

  // Resolve collected_by uuids → staff.name in a single batch query so
  // each row can display a human-readable collector name.
  const collectorIds = Array.from(new Set(
    [...paymentMetaByDoc.values()].map((m) => m.collectedById).filter((v): v is string => Boolean(v))
  ));
  const staffNameById = new Map<string, string>();
  if (collectorIds.length > 0) {
    const { data: staffRows, error: staffErr } = await sb
      .from('staff')
      .select('id, name')
      .in('id', collectorIds);
    if (staffErr) return c.json({ error: 'load_failed', reason: staffErr.message }, 500);
    for (const s of staffRows ?? []) {
      const row = s as { id: string; name: string | null };
      if (row.id && row.name) staffNameById.set(row.id, row.name);
    }
  }

  // Flatten the join + apply the header-level date range filters in JS
  // (supabase-js can't .gte() across a joined table without rpc).
  const rows = itemsRaw
    .map((r) => {
      // Supabase returns the joined header as either a single object or
      // a one-element array depending on selection — normalise to single.
      const rawHeader = r.mfg_sales_orders;
      const h: Record<string, unknown> = Array.isArray(rawHeader)
        ? ((rawHeader[0] as Record<string, unknown>) ?? {})
        : ((rawHeader as Record<string, unknown>) ?? {});
      const flat: Record<string, unknown> = { ...r };
      delete flat.mfg_sales_orders;
      // Header fields fill any line field that's empty (debtor_code, agent, etc.).
      for (const [k, v] of Object.entries(h)) {
        if (k in flat && flat[k] != null && flat[k] !== '') continue;
        flat[k] = v;
      }
      // Always expose so_date + currency + status under canonical names too.
      flat.so_date  = h.so_date  ?? flat.so_date  ?? flat.line_date ?? null;
      flat.currency = h.currency ?? 'MYR';
      flat.status   = h.status   ?? null;
      flat.customer_delivery_date = h.customer_delivery_date ?? null;
      // Per-doc paid total from the payments ledger (replaces legacy paid_centi).
      flat.paid_total_centi = paidByDoc.get(r.doc_no) ?? 0;
      /* Light the Fabric / Divan / Leg columns from what SO lines ACTUALLY
         carry. Fabric: three sources, most specific first — fabricColor
         (GRN hand-keyed) ?? colourLabel (POS human label) ?? fabricCode (the
         shared code). Divan/Leg: real column (GRN paths) ?? the variants the
         SO paths write — legHeight / sofaLegHeight / divanHeight. Values can
         be strings ('4"', 'No Leg'): normalise to a NUMBER when parseable
         (frontend renders n″ + numeric sort) else pass the raw string. */
      const variantsObj = (r.variants ?? null) as Record<string, unknown> | null;
      const vStr = (k: string): string | null => {
        const v = variantsObj?.[k];
        return typeof v === 'string' && v.trim() ? v.trim() : null;
      };
      flat.fabric = vStr('fabricColor') ?? vStr('colourLabel') ?? vStr('fabricCode');
      const heightVal = (col: unknown, ...keys: string[]): number | string | null => {
        if (col != null) return col as number;
        for (const k of keys) {
          const raw = vStr(k);
          if (!raw) continue;
          const m = raw.match(/^(-?\d+(?:\.\d+)?)\s*(?:"|”|inch(?:es)?)?$/i);
          return m && m[1] ? Number(m[1]) : raw; // '4"' → 4; 'No Leg' → as-is
        }
        return null;
      };
      flat.divan_height = heightVal(r.divan_height_inches, 'divanHeight');
      flat.leg_height   = heightVal(r.leg_height_inches, 'legHeight', 'sofaLegHeight');
      // Per-doc payment meta (last receipt only).
      const pm = paymentMetaByDoc.get(r.doc_no);
      flat.last_payment_at = pm?.lastPaidAt   ?? null;
      flat.account_sheet   = pm?.accountSheet ?? null;
      /* ALL approval codes, oldest→newest, plus a count when there are several
         ("123123 + 456456 (2)"). Header-level code covers legacy single-shot
         SOs with no ledger rows. */
      const codes = (approvalCodesByDoc.get(r.doc_no) ?? [])
        .sort((a, b) => String(a.paidAt ?? '').localeCompare(String(b.paidAt ?? '')))
        .map((x) => x.code);
      flat.approval_code = codes.length > 0
        ? codes.join(' + ') + (codes.length > 1 ? ` (${codes.length})` : '')
        : ((h.approval_code as string | null) ?? null);
      flat.collected_by    = pm?.collectedById ? (staffNameById.get(pm.collectedById) ?? null) : null;
      return flat;
    })
    .filter((r) => {
      const soDate = (r.so_date ?? r.line_date) as string | null;
      if (dateFrom && (!soDate || soDate < dateFrom)) return false;
      if (dateTo   && (!soDate || soDate > dateTo))   return false;
      const dd = r.customer_delivery_date as string | null;
      if (deliveryDateFrom && (!dd || dd < deliveryDateFrom)) return false;
      if (deliveryDateTo   && (!dd || dd > deliveryDateTo))   return false;
      return true;
    });

  return c.json({ rows });
});

// ----------------------------------------------------------------------------
// L2 line-level Detail Listings for Delivery Order / Sales Invoice / Delivery
// Return. Same shape as /sales-order-detail-listing: flatten the header onto
// every line, apply filter params, return { rows: [...] }.
//
//   DO  : delivery_order_items     joined with delivery_orders
//   SI  : sales_invoice_items      joined with sales_invoices
//   DR  : delivery_return_items    joined with delivery_returns
//
// Delivery Return has a `refund_centi` instead of revenue — surfaced as
// `total_centi` so the column reuse is straightforward.
// ----------------------------------------------------------------------------

type AnyRow = Record<string, unknown>;

const flattenJoin = (item: AnyRow, headerKey: string): AnyRow => {
  const rawHeader = item[headerKey];
  const h: AnyRow = Array.isArray(rawHeader)
    ? ((rawHeader[0] as AnyRow) ?? {})
    : ((rawHeader as AnyRow) ?? {});
  const flat: AnyRow = { ...item };
  delete flat[headerKey];
  // Item columns win over header columns when both exist (line-level
  // debtor_code etc.); fall through to header values otherwise.
  for (const [k, v] of Object.entries(h)) {
    if (k in flat && flat[k] != null && flat[k] !== '') continue;
    flat[k] = v;
  }
  return flat;
};

/* ── Delivery Order Detail Listing ──────────────────────────────────── */
reports.get('/delivery-order-detail-listing', async (c) => {
  const sb = c.get('supabase');
  const dateFrom    = c.req.query('dateFrom');
  const dateTo      = c.req.query('dateTo');
  const docNo       = c.req.query('docNo');
  const debtorCode  = c.req.query('debtorCode');
  const itemCode    = c.req.query('itemCode');

  let q = sb
    .from('delivery_order_items')
    .select(`
      id, delivery_order_id, so_item_id, item_code, description, description2,
      qty, m3_milli, unit_price_centi, discount_centi, line_total_centi,
      uom, item_group, variants, line_suffix, notes, created_at,
      delivery_orders!inner (
        id, do_number, so_doc_no, debtor_code, debtor_name, do_date,
        expected_delivery_at, signed_at, delivered_at, dispatched_at,
        driver_name, vehicle, address1, address2, city, state, postcode, phone,
        status, notes, m3_total_milli
      )
    `)
    .limit(2000);

  if (docNo)      q = q.ilike('delivery_orders.do_number', `%${docNo}%`);
  if (itemCode)   q = q.ilike('item_code', `%${itemCode}%`);
  if (debtorCode) q = q.eq('delivery_orders.debtor_code', debtorCode);

  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  const rows = ((data ?? []) as unknown as AnyRow[])
    .map((r) => {
      const flat = flattenJoin(r, 'delivery_orders');
      // Normalise common field names used by the L2 page.
      flat.doc_no = flat.do_number;
      flat.line_date = flat.do_date;
      flat.total_centi = flat.line_total_centi ?? 0;
      return flat;
    })
    .filter((r) => {
      const d = (r.do_date ?? r.line_date) as string | null;
      if (dateFrom && (!d || d < dateFrom)) return false;
      if (dateTo   && (!d || d > dateTo))   return false;
      return true;
    });

  return c.json({ rows });
});

/* ── Sales Invoice Detail Listing ───────────────────────────────────── */
reports.get('/sales-invoice-detail-listing', async (c) => {
  const sb = c.get('supabase');
  const dateFrom    = c.req.query('dateFrom');
  const dateTo      = c.req.query('dateTo');
  const docNo       = c.req.query('docNo');
  const debtorCode  = c.req.query('debtorCode');
  const itemCode    = c.req.query('itemCode');

  let q = sb
    .from('sales_invoice_items')
    .select(`
      id, sales_invoice_id, so_item_id, item_code, description, description2,
      qty, unit_price_centi, discount_centi, tax_centi, line_total_centi,
      uom, item_group, variants, line_suffix, notes, created_at,
      sales_invoices!inner (
        id, invoice_number, so_doc_no, delivery_order_id, debtor_code, debtor_name,
        invoice_date, due_date, currency,
        subtotal_centi, discount_centi, tax_centi, total_centi, paid_centi,
        status, notes, sent_at, paid_at
      )
    `)
    .limit(2000);

  if (docNo)      q = q.ilike('sales_invoices.invoice_number', `%${docNo}%`);
  if (itemCode)   q = q.ilike('item_code', `%${itemCode}%`);
  if (debtorCode) q = q.eq('sales_invoices.debtor_code', debtorCode);

  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  const rows = ((data ?? []) as unknown as AnyRow[])
    .map((r) => {
      // Capture header totals before flatten — line items have their own
      // discount_centi / tax_centi, and the LINE values win in flatten, so the
      // header values must be snapshotted up front for the outstanding calc.
      const headerRaw = r.sales_invoices as AnyRow | AnyRow[] | null;
      const headerObj: AnyRow = Array.isArray(headerRaw)
        ? ((headerRaw[0] as AnyRow) ?? {})
        : ((headerRaw as AnyRow) ?? {});
      const headerTotal = Number(headerObj.total_centi ?? 0);
      const headerPaid  = Number(headerObj.paid_centi ?? 0);
      const headerDiscount = Number(headerObj.discount_centi ?? 0);
      const headerTax      = Number(headerObj.tax_centi ?? 0);

      const flat = flattenJoin(r, 'sales_invoices');
      flat.doc_no = flat.invoice_number;
      flat.line_date = flat.invoice_date;
      // Use the LINE total, not the header total, for revenue column on L2.
      flat.total_centi = flat.line_total_centi ?? 0;
      // Outstanding = header total − header paid (per doc, repeated per line).
      flat.header_total_centi    = headerTotal;
      flat.header_paid_centi     = headerPaid;
      flat.header_discount_centi = headerDiscount;
      flat.header_tax_centi      = headerTax;
      flat.balance_centi = Math.max(headerTotal - headerPaid, 0);
      return flat;
    })
    .filter((r) => {
      const d = (r.invoice_date ?? r.line_date) as string | null;
      if (dateFrom && (!d || d < dateFrom)) return false;
      if (dateTo   && (!d || d > dateTo))   return false;
      return true;
    });

  return c.json({ rows });
});

/* ── Delivery Return Detail Listing ────────────────────────────────── */
reports.get('/delivery-return-detail-listing', async (c) => {
  const sb = c.get('supabase');
  const dateFrom    = c.req.query('dateFrom');
  const dateTo      = c.req.query('dateTo');
  const docNo       = c.req.query('docNo');
  const debtorCode  = c.req.query('debtorCode');
  const itemCode    = c.req.query('itemCode');

  let q = sb
    .from('delivery_return_items')
    .select(`
      id, delivery_return_id, do_item_id, item_code, description,
      qty_returned, condition, unit_price_centi, refund_centi, notes, created_at,
      delivery_returns!inner (
        id, return_number, delivery_order_id, sales_invoice_id, debtor_code,
        debtor_name, return_date, reason, status, refund_centi,
        received_at, inspected_at, refunded_at, inspection_notes, notes
      )
    `)
    .limit(2000);

  if (docNo)      q = q.ilike('delivery_returns.return_number', `%${docNo}%`);
  if (itemCode)   q = q.ilike('item_code', `%${itemCode}%`);
  if (debtorCode) q = q.eq('delivery_returns.debtor_code', debtorCode);

  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  const rows = ((data ?? []) as unknown as AnyRow[])
    .map((r) => {
      // Both line and header have refund_centi. Capture each explicitly
      // before flattenJoin's "line wins" rule discards the header value.
      const lineRefund = Number(r.refund_centi ?? 0);
      const headerRaw = r.delivery_returns as AnyRow | AnyRow[] | null;
      const headerObj: AnyRow = Array.isArray(headerRaw)
        ? ((headerRaw[0] as AnyRow) ?? {})
        : ((headerRaw as AnyRow) ?? {});
      const headerRefund = Number(headerObj.refund_centi ?? 0);
      const flat = flattenJoin(r, 'delivery_returns');
      flat.line_refund_centi = lineRefund;
      flat.refund_centi_header = headerRefund;
      flat.doc_no = flat.return_number;
      flat.line_date = flat.return_date;
      flat.total_centi = lineRefund;
      // "Outstanding" for a return = pending payout (status not yet REFUNDED
      // / CREDIT_NOTED / REJECTED).
      const headerStatus = String(flat.status ?? '');
      const settled = headerStatus === 'REFUNDED' || headerStatus === 'CREDIT_NOTED' || headerStatus === 'REJECTED';
      flat.balance_centi = settled ? 0 : headerRefund;
      return flat;
    })
    .filter((r) => {
      const d = (r.return_date ?? r.line_date) as string | null;
      if (dateFrom && (!d || d < dateFrom)) return false;
      if (dateTo   && (!d || d > dateTo))   return false;
      return true;
    });

  return c.json({ rows });
});
