// /payment-vouchers — a standalone "very plain" Payment Voucher (PV).
//
// Port of 2990's apps/api/src/routes/payment-vouchers.ts (migrations 0189 +
// 0202) into Houzs SCM. Phase 1-B, MYR-only: the currency/exchange_rate columns
// are kept but always resolve to MYR / 1 here — no foreign-currency UI (phase A).
//
// A PV pays a vendor that is NOT a goods invoice (freight forwarder, one-off
// service): a payee + a credit account (the bank/cash/AP the money is paid
// FROM) + a few expense lines (description + debit account + amount) + a total
// that posts to the GL. A SUPPLIER_PAYMENT PV can also SETTLE one or more
// Purchase Invoices at face value (pv_allocations → PI paid_centi on post).
//
// GL post (source_type 'PV', mirrors postPiAccounting's JE shape but with
// DYNAMIC legs — the PV's debit accounts + chosen credit account, not the PI's
// fixed Dr 1200 / Cr 2000):
//   Dr each line.debit_account_code   round(amount_centi * exchange_rate)  (MYR)
//   Cr header.credit_account_code      = Σ of those rounded Dr legs          (MYR)
// The credit leg is the SUM of the rounded debit legs so the JE balances
// byte-for-byte even when rounding splits across lines.
//
// Houzs adaptation vs 2990:
//   * tables via the scm-scoped service-role `sb` (snake_case), scm schema.
//   * writes gated with hasHouzsPerm on flat scm.payment_voucher.* keys (2990's
//     scm.staff.role gates are dead — the SCM bridge pins every caller to one
//     super_admin row).
//   * multi-company: company_id stamped on insert (activeCompanyId / stampCompany)
//     + scopeToCompany on the list; JE + JE-lines inherit the PV's company_id.
//   * doc numbers via companyDocPrefix + nextMonthlyDocNo (max+1, self-healing)
//     with insertWithDocNoRetry on the header insert.
//   * FX removed (no currencies master): currency defaults MYR, rate 1.
//
// Idempotent: a post guards on an existing ACTIVE (non-reversed) JE for
// source_type='PV' + the pv_number; a cancel reverses that JE (contra) keyed on
// the original JE's reversed flag — re-cancels / retries no-op.

import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { nextMonthlyDocNo, insertWithDocNoRetry } from '../lib/doc-no';
import { scopeToCompany, activeCompanyId, stampCompany, companyDocPrefix } from '../lib/companyScope';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { normalizeCurrency, normalizeExchangeRate, masterRateForCurrency } from '../lib/fx';
import { todayMyt } from '../lib/my-time';

export const paymentVouchers = new Hono<{ Bindings: Env; Variables: Variables }>();
paymentVouchers.use('*', supabaseAuth);

const HEADER =
  'id, pv_number, voucher_date, payee_name, supplier_id, credit_account_code, currency, exchange_rate, purpose, notes, total_centi, status, posted_at, created_at, created_by, updated_at, company_id';

const LINE = 'id, pv_id, line_no, description, debit_account_code, amount_centi, created_at';

/* Migration 0202 — the PV purpose. Only SUPPLIER_PAYMENT settles AP (its
   allocations decrement the linked PIs' paid_centi); FREIGHT / OTHER post the GL
   but touch no PI. Default SUPPLIER_PAYMENT. */
const normalizePurpose = (raw: unknown): 'SUPPLIER_PAYMENT' | 'FREIGHT' | 'OTHER' => {
  const v = String(raw ?? '').trim().toUpperCase();
  return v === 'FREIGHT' || v === 'OTHER' ? v : 'SUPPLIER_PAYMENT';
};

/* FX (migration 0082) — exchange_rate = MYR per 1 unit of the PV currency, and
   the currency auto-fills its rate from the currency MASTER. normalizeCurrency /
   normalizeExchangeRate now come from the shared lib/fx (identical behaviour:
   MYR ⇒ rate 1, a foreign rate must be finite > 0 else 1 — the GL post can never
   be zeroed). */

/* Next PV-YYMM-NNN (company-prefixed). Mirrors purchase-invoices nextNum —
   max(suffix)+1 via nextMonthlyDocNo (self-healing; never count+1). */
const nextPvNo = async (sb: any, c: any): Promise<string> => {
  const d = new Date();
  const yymm = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`;
  const p = companyDocPrefix(c);
  const { data: existing } = await sb.from('payment_vouchers').select('pv_number').like('pv_number', `${p}PV-${yymm}-%`);
  return nextMonthlyDocNo(`${p}PV-${yymm}`, ((existing ?? []) as Array<{ pv_number: string }>).map((r) => r.pv_number));
};

const padMmDd = (d: Date): string => {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  return `${yy}${m}`;
};

/* Next JE number — copied verbatim from accounting.ts nextJeNo so PV journal
   entries slot into the same JE-YYMM-NNNN sequence as SI/PI postings. */
const nextJeNo = async (sb: any, date: Date): Promise<string> => {
  const prefix = `JE-${padMmDd(date)}`;
  const { data } = await sb
    .from('journal_entries')
    .select('je_no')
    .like('je_no', `${prefix}-%`)
    .order('je_no', { ascending: false })
    .limit(1);
  const last = data?.[0]?.je_no ?? null;
  const lastN = last ? parseInt(String(last).split('-').pop() ?? '0', 10) : 0;
  return `${prefix}-${String(lastN + 1).padStart(4, '0')}`;
};

/* ── Normalise + validate the incoming lines, recompute the header total ──── */
function buildLines(
  raw: unknown,
): { rows: Array<{ line_no: number; description: string | null; debit_account_code: string; amount_centi: number }>; total: number } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: 'lines_required' };
  const rows: Array<{ line_no: number; description: string | null; debit_account_code: string; amount_centi: number }> = [];
  let total = 0;
  raw.forEach((l, i) => {
    const line = l as Record<string, unknown>;
    const debit = (line.debitAccountCode as string | undefined)?.trim();
    const amount = Math.max(0, Math.round(Number(line.amountCenti ?? 0)) || 0);
    rows.push({
      line_no: i + 1,
      description: (line.description as string | undefined)?.trim() || null,
      debit_account_code: debit ?? '',
      amount_centi: amount,
    });
    total += amount;
  });
  if (rows.some((r) => !r.debit_account_code)) return { error: 'debit_account_required' };
  return { rows, total };
}

/* ── Normalise + validate the incoming PV→PI allocations (migration 0202) ──── */
function buildAllocations(
  raw: unknown,
): { rows: Array<{ pi_id: string; amount_centi: number }>; total: number } | { error: string } {
  if (raw === undefined || raw === null) return { rows: [], total: 0 };
  if (!Array.isArray(raw)) return { error: 'allocations_invalid' };
  const rows: Array<{ pi_id: string; amount_centi: number }> = [];
  let total = 0;
  for (const a of raw) {
    const row = a as Record<string, unknown>;
    const piId = (row.piId as string | undefined)?.trim();
    const amount = Math.max(0, Math.round(Number(row.amountCenti ?? 0)) || 0);
    if (!piId) return { error: 'allocation_pi_required' };
    if (amount <= 0) continue; // skip zero rows — nothing to settle
    rows.push({ pi_id: piId, amount_centi: amount });
    total += amount;
  }
  return { rows, total };
}

/* ── settlePiPaidCenti — increment a PI's paid_centi by a face-value amount and
   auto-flip its status (migration 0202). Optimistic-concurrency loop (gate the
   UPDATE on the paid_centi just read). delta may be NEGATIVE (a PV cancel
   reverses the settlement). A DRAFT/CANCELLED PI is skipped. Best-effort. */
async function settlePiPaidCenti(sb: any, piId: string, delta: number): Promise<void> {
  if (!piId || !Number.isFinite(delta) || delta === 0) return;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const { data: cur } = await sb.from('purchase_invoices')
      .select('paid_centi, total_centi, status').eq('id', piId).maybeSingle();
    if (!cur) return;
    const c0 = cur as { paid_centi: number; total_centi: number; status: string };
    const st = (c0.status ?? '').toUpperCase();
    if (st === 'DRAFT' || st === 'CANCELLED') return;
    const newPaid = Math.max(0, c0.paid_centi + delta);
    const newStatus = newPaid >= c0.total_centi
      ? 'PAID'
      : (newPaid > 0 ? 'PARTIALLY_PAID' : 'POSTED');
    const { data, error } = await sb.from('purchase_invoices').update({
      paid_centi: newPaid, status: newStatus, updated_at: new Date().toISOString(),
    })
      .eq('id', piId)
      .eq('paid_centi', c0.paid_centi) // only if nobody else moved it since the read
      .select('id');
    if (error) return; // best-effort — a settle hiccup never un-posts the PV
    if (data && data.length > 0) return;
    // 0 rows → a concurrent paid_centi change; loop re-reads + retries.
  }
}

/* ────────────────────────────────────────────────────────────────────────
   List / get
   ──────────────────────────────────────────────────────────────────────── */

paymentVouchers.get('/', async (c) => {
  const sb = c.get('supabase');
  let q = sb.from('payment_vouchers')
    .select(`${HEADER}, supplier:suppliers(id, code, name)`)
    .order('voucher_date', { ascending: false })
    // Bound the result so PostgREST's default 1000-row cap can't silently
    // truncate the list — matches the PI/SI/DO list convention.
    .limit(500);
  const status = c.req.query('status'); if (status) q = q.eq('status', status);
  q = scopeToCompany(q, c); // multi-company: isolate to the active company
  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ paymentVouchers: data ?? [] });
});

paymentVouchers.get('/:id', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  const [h, i, a] = await Promise.all([
    sb.from('payment_vouchers').select(`${HEADER}, supplier:suppliers(id, code, name)`).eq('id', id).maybeSingle(),
    sb.from('payment_voucher_lines').select(LINE).eq('pv_id', id).order('line_no'),
    /* PV→PI settlement (0202) — the PIs this PV applies to, joined for the PI
       number + the live total/paid so the detail page can show "Apply to PI". */
    sb.from('pv_allocations')
      .select('id, amount_centi, pi:purchase_invoices(id, invoice_number, supplier_invoice_ref, currency, total_centi, paid_centi, status)')
      .eq('pv_id', id),
  ]);
  if (h.error) return c.json({ error: 'load_failed', reason: h.error.message }, 500);
  if (!h.data) return c.json({ error: 'not_found' }, 404);
  /* Flatten the joined PI (Supabase returns a to-one FK as an array). */
  const allocations = ((a.data ?? []) as Array<{
    id: string; amount_centi: number;
    pi: { id: string; invoice_number: string; supplier_invoice_ref: string | null; currency: string | null; total_centi: number; paid_centi: number; status: string }
      | Array<{ id: string; invoice_number: string; supplier_invoice_ref: string | null; currency: string | null; total_centi: number; paid_centi: number; status: string }> | null;
  }>).map((row) => {
    const pi = Array.isArray(row.pi) ? row.pi[0] : row.pi;
    return {
      id: row.id,
      amountCenti: Number(row.amount_centi ?? 0),
      piId: pi?.id ?? null,
      invoiceNumber: pi?.invoice_number ?? null,
      supplierInvoiceRef: pi?.supplier_invoice_ref ?? null,
      currency: pi?.currency ?? null,
      totalCenti: pi ? Number(pi.total_centi ?? 0) : null,
      paidCenti: pi ? Number(pi.paid_centi ?? 0) : null,
      status: pi?.status ?? null,
    };
  });
  return c.json({ paymentVoucher: h.data, lines: i.data ?? [], allocations });
});

/* ────────────────────────────────────────────────────────────────────────
   Create (DRAFT)
   ──────────────────────────────────────────────────────────────────────── */

paymentVouchers.post('/', async (c) => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.create')) {
    return c.json({ error: 'Forbidden: missing scm.payment_voucher.create' }, 403);
  }
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }

  const payeeName = (body.payeeName as string | undefined)?.trim();
  if (!payeeName) return c.json({ error: 'payee_required' }, 400);
  const creditAccountCode = (body.creditAccountCode as string | undefined)?.trim();
  if (!creditAccountCode) return c.json({ error: 'credit_account_required' }, 400);

  const built = buildLines(body.lines);
  if ('error' in built) return c.json({ error: built.error }, 400);

  // PV→PI settlement (migration 0202) — optional allocations + purpose.
  const allocBuilt = buildAllocations(body.allocations);
  if ('error' in allocBuilt) return c.json({ error: allocBuilt.error }, 400);
  const purpose = normalizePurpose(body.purpose);
  // Guard: Σ allocations ≤ PV total (you can't apply more than the voucher pays).
  if (allocBuilt.total > built.total) {
    return c.json({ error: 'allocations_exceed_total', allocated: allocBuilt.total, total: built.total }, 400);
  }

  const sb = c.get('supabase'); const user = c.get('user');
  const currency = normalizeCurrency(body.currency);
  /* Migration 0082 — the rate auto-fills from the currency MASTER (rate_to_myr)
     unless the body sends an explicit one; MYR ⇒ 1, a strict no-op. */
  const pvRateRaw = body.exchangeRate !== undefined && body.exchangeRate !== null
    ? body.exchangeRate
    : await masterRateForCurrency(sb, currency);
  const exchangeRate = normalizeExchangeRate(pvRateRaw, currency);

  const { data: header, error: hErr } = await insertWithDocNoRetry<{ id: string; pv_number: string }>(
    () => nextPvNo(sb, c),
    (pvNumber) => sb.from('payment_vouchers').insert({
      company_id:          activeCompanyId(c), // multi-company: stamp the active company
      pv_number:           pvNumber,
      voucher_date:        (body.voucherDate as string) ?? todayMyt(),
      payee_name:          payeeName,
      supplier_id:         (body.supplierId as string | undefined) ?? null,
      credit_account_code: creditAccountCode,
      currency,
      exchange_rate:       exchangeRate,
      purpose,
      notes:               (body.notes as string | undefined) ?? null,
      total_centi:         built.total,
      status:              'DRAFT',
      created_by:          user.id,
    }).select(HEADER).single(),
  );
  if (hErr) return c.json({ error: 'insert_failed', reason: hErr.message }, 500);
  const h = header as unknown as { id: string; pv_number: string };

  const rowsWithId = built.rows.map((r) => ({ ...r, pv_id: h.id }));
  const { error: lErr } = await sb.from('payment_voucher_lines').insert(stampCompany(rowsWithId, c));
  if (lErr) { await sb.from('payment_vouchers').delete().eq('id', h.id); return c.json({ error: 'lines_insert_failed', reason: lErr.message }, 500); }

  // PV→PI settlement links (0202) — persist the allocations (compensating-delete
  // the whole PV on failure). They settle paid_centi only on POST, not here.
  if (allocBuilt.rows.length > 0) {
    const allocRows = allocBuilt.rows.map((r) => ({ ...r, pv_id: h.id }));
    const { error: aErr } = await sb.from('pv_allocations').insert(stampCompany(allocRows, c));
    if (aErr) { await sb.from('payment_vouchers').delete().eq('id', h.id); return c.json({ error: 'allocations_insert_failed', reason: aErr.message }, 500); }
  }

  return c.json({ id: h.id, pvNumber: h.pv_number }, 201);
});

/* ────────────────────────────────────────────────────────────────────────
   Update — DRAFT only (a POSTED / CANCELLED voucher is read-only)
   ──────────────────────────────────────────────────────────────────────── */

paymentVouchers.patch('/:id', async (c) => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.write')) {
    return c.json({ error: 'Forbidden: missing scm.payment_voucher.write' }, 403);
  }
  const id = c.req.param('id');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const sb = c.get('supabase');

  const { data: cur } = await sb.from('payment_vouchers').select('status').eq('id', id).maybeSingle();
  if (!cur) return c.json({ error: 'not_found' }, 404);
  if ((cur as { status: string }).status !== 'DRAFT') {
    return c.json({ error: 'not_editable', message: 'Only a DRAFT voucher can be edited' }, 409);
  }

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.payeeName !== undefined) {
    const v = String(body.payeeName).trim();
    if (!v) return c.json({ error: 'payee_required' }, 400);
    updates.payee_name = v;
  }
  if (body.creditAccountCode !== undefined) {
    const v = String(body.creditAccountCode).trim();
    if (!v) return c.json({ error: 'credit_account_required' }, 400);
    updates.credit_account_code = v;
  }
  if (body.voucherDate !== undefined) updates.voucher_date = body.voucherDate;
  if (body.supplierId !== undefined) updates.supplier_id = (body.supplierId as string | null) || null;
  if (body.notes !== undefined) updates.notes = (body.notes as string | null) ?? null;
  // PV→PI settlement (0202) — purpose is editable while DRAFT.
  if (body.purpose !== undefined) updates.purpose = normalizePurpose(body.purpose);

  // Effective currency = the new currency if set, else the stored one — so the
  // exchange_rate stays consistent (MYR-only today → 1).
  let effectiveCurrency: string | undefined = body.currency !== undefined ? normalizeCurrency(body.currency) : undefined;
  if (body.currency !== undefined) updates.currency = effectiveCurrency;
  if (body.exchangeRate !== undefined || updates.currency !== undefined) {
    if (effectiveCurrency === undefined) {
      const { data: row } = await sb.from('payment_vouchers').select('currency').eq('id', id).maybeSingle();
      effectiveCurrency = (row as { currency?: string } | null)?.currency ?? 'MYR';
    }
    if (body.exchangeRate !== undefined) {
      updates.exchange_rate = normalizeExchangeRate(body.exchangeRate, effectiveCurrency);
    } else if (String(effectiveCurrency).toUpperCase() === 'MYR') {
      updates.exchange_rate = 1;
    }
  }

  // Lines (optional) — full replace + recompute total when supplied.
  let newTotal: number | undefined;
  if (body.lines !== undefined) {
    const built = buildLines(body.lines);
    if ('error' in built) return c.json({ error: built.error }, 400);
    await sb.from('payment_voucher_lines').delete().eq('pv_id', id);
    const { error: lErr } = await sb.from('payment_voucher_lines').insert(stampCompany(built.rows.map((r) => ({ ...r, pv_id: id })), c));
    if (lErr) return c.json({ error: 'lines_update_failed', reason: lErr.message }, 500);
    updates.total_centi = built.total;
    newTotal = built.total;
  }

  // Allocations (optional, 0202) — full replace. Σ ≤ the effective PV total.
  if (body.allocations !== undefined) {
    const allocBuilt = buildAllocations(body.allocations);
    if ('error' in allocBuilt) return c.json({ error: allocBuilt.error }, 400);
    let total = newTotal;
    if (total === undefined) {
      const { data: row } = await sb.from('payment_vouchers').select('total_centi').eq('id', id).maybeSingle();
      total = (row as { total_centi?: number } | null)?.total_centi ?? 0;
    }
    if (allocBuilt.total > total) {
      return c.json({ error: 'allocations_exceed_total', allocated: allocBuilt.total, total }, 400);
    }
    await sb.from('pv_allocations').delete().eq('pv_id', id);
    if (allocBuilt.rows.length > 0) {
      const { error: aErr } = await sb.from('pv_allocations').insert(stampCompany(allocBuilt.rows.map((r) => ({ ...r, pv_id: id })), c));
      if (aErr) return c.json({ error: 'allocations_update_failed', reason: aErr.message }, 500);
    }
  }

  const { data, error } = await sb.from('payment_vouchers').update(updates).eq('id', id).select(HEADER).single();
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  return c.json({ paymentVoucher: data });
});

/* ────────────────────────────────────────────────────────────────────────
   POST /:id/post — write the balanced GL entry, flip DRAFT → POSTED
   ──────────────────────────────────────────────────────────────────────── */

paymentVouchers.post('/:id/post', async (c) => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.post')) {
    return c.json({ error: 'Forbidden: missing scm.payment_voucher.post' }, 403);
  }
  const sb = c.get('supabase'); const id = c.req.param('id');

  const { data: pvRaw } = await sb.from('payment_vouchers')
    .select(`${HEADER}, supplier:suppliers(code, name)`).eq('id', id).maybeSingle();
  if (!pvRaw) return c.json({ error: 'not_found' }, 404);
  const pv = pvRaw as unknown as {
    id: string; pv_number: string; voucher_date: string; payee_name: string;
    credit_account_code: string; total_centi: number; currency: string | null;
    exchange_rate: string | number | null; status: string; purpose: string | null;
    company_id: number | null;
    supplier: { code: string | null; name: string | null } | null;
  };
  if (pv.status === 'CANCELLED') return c.json({ error: 'cannot_post', message: 'Voucher is cancelled' }, 409);

  // Idempotency — an ACTIVE (non-reversed) PV JE already exists? (mirror
  // postPiAccounting). Flip POSTED + echo without re-writing the GL.
  const { data: existingRows } = await sb.from('journal_entries')
    .select('id, je_no, reversed').eq('source_type', 'PV').eq('source_doc_no', pv.pv_number);
  const active = ((existingRows ?? []) as Array<{ id: string; je_no: string; reversed: boolean | null }>).find((r) => !r.reversed);
  if (active) {
    if (pv.status !== 'POSTED') {
      await sb.from('payment_vouchers').update({ status: 'POSTED', posted_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', id);
    }
    return c.json({ ok: true, alreadyPosted: true, jeNo: active.je_no, jeId: active.id });
  }

  const { data: linesRaw } = await sb.from('payment_voucher_lines')
    .select('line_no, description, debit_account_code, amount_centi').eq('pv_id', id).order('line_no');
  const lines = (linesRaw ?? []) as Array<{ line_no: number; description: string | null; debit_account_code: string; amount_centi: number }>;
  if (lines.length === 0) return c.json({ error: 'no_lines', message: 'Voucher has no lines to post' }, 400);

  /* FX conversion AT POST TIME (MYR-only today → rate 1). Each Dr leg =
     round(line.amount * rate); the single Cr leg = Σ of those rounded Dr legs,
     so the JE balances exactly regardless of per-line rounding. */
  const rawRate = Number(pv.exchange_rate ?? 1);
  const rate = Number.isFinite(rawRate) && rawRate > 0 ? rawRate : 1;
  const debitLegs = lines.map((l) => ({ ...l, myrSen: Math.round(Number(l.amount_centi) * rate) }));
  const totalSen = debitLegs.reduce((s, l) => s + l.myrSen, 0);  // MYR amount posted to the GL
  if (totalSen <= 0) return c.json({ error: 'zero_total', message: 'Voucher total is zero' }, 400);

  const supplier = pv.supplier ?? { code: null, name: null };
  // Multi-company (mig 0061/0081): the JE + its lines belong to the PV's company.
  const companyId = pv.company_id ?? null;
  const jeNo = await nextJeNo(sb, new Date(pv.voucher_date));
  const { data: je, error: jeErr } = await sb.from('journal_entries').insert({
    ...(companyId != null ? { company_id: companyId } : {}),
    je_no:            jeNo,
    entry_date:       pv.voucher_date,
    source_type:      'PV',
    source_doc_no:    pv.pv_number,
    narration:        `Payment voucher ${pv.pv_number} — ${pv.payee_name}`,
    total_debit_sen:  totalSen,
    total_credit_sen: totalSen,
  }).select('*').single();
  if (jeErr) return c.json({ error: 'je_insert_failed', reason: jeErr.message }, 500);

  // Dr each expense/charge line; Cr the header's bank/cash/AP account for the
  // total (the funds that left). party stamps the payee onto the credit leg.
  const companyLine = companyId != null ? { company_id: companyId } : {};
  const lineRows: Array<Record<string, unknown>> = debitLegs.map((l, i) => ({
    ...companyLine,
    journal_entry_id: je.id,
    line_no:          i + 1,
    account_code:     l.debit_account_code,
    debit_sen:        l.myrSen,
    credit_sen:       0,
    party_type:       null,
    party_code:       null,
    party_name:       null,
    notes:            `${l.description ?? 'Payment'} — ${pv.pv_number}`,
  }));
  lineRows.push({
    ...companyLine,
    journal_entry_id: je.id,
    line_no:          debitLegs.length + 1,
    account_code:     pv.credit_account_code,
    debit_sen:        0,
    credit_sen:       totalSen,
    party_type:       supplier.code ? 'SUPPLIER' : null,
    party_code:       supplier.code ?? null,
    party_name:       supplier.name ?? pv.payee_name,
    notes:            `Payment to ${pv.payee_name} — ${pv.pv_number}`,
  });
  const { error: lErr } = await sb.from('journal_entry_lines').insert(lineRows);
  if (lErr) { await sb.from('journal_entries').delete().eq('id', je.id); return c.json({ error: 'lines_insert_failed', reason: lErr.message }, 500); }

  const { error: postErr } = await sb.from('journal_entries').update({ posted: true }).eq('id', je.id);
  if (postErr) return c.json({ error: 'post_failed', reason: postErr.message }, 500);

  await sb.from('payment_vouchers').update({
    status: 'POSTED', posted_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq('id', id);

  /* PV→PI settlement (migration 0202) — a SUPPLIER_PAYMENT PV decrements each
     linked PI's paid_centi at FACE VALUE. Runs EXACTLY ONCE (the active-JE
     idempotency guard above early-returns on a re-post). Cap each allocation at
     the PI's remaining outstanding. Best-effort. FREIGHT / OTHER settle nothing. */
  if (normalizePurpose(pv.purpose) === 'SUPPLIER_PAYMENT') {
    const { data: allocs } = await sb.from('pv_allocations')
      .select('id, pi_id, amount_centi').eq('pv_id', id);
    for (const a of (allocs ?? []) as Array<{ id: string; pi_id: string; amount_centi: number }>) {
      const want = Math.max(0, Number(a.amount_centi ?? 0));
      if (want <= 0) continue;
      const { data: piRow } = await sb.from('purchase_invoices')
        .select('total_centi, paid_centi, status').eq('id', a.pi_id).maybeSingle();
      if (!piRow) continue;
      const p = piRow as { total_centi: number; paid_centi: number; status: string };
      const st = (p.status ?? '').toUpperCase();
      if (st === 'DRAFT' || st === 'CANCELLED') continue; // not a live liability
      const outstanding = Math.max(0, Number(p.total_centi ?? 0) - Number(p.paid_centi ?? 0));
      const apply = Math.min(want, outstanding);
      if (apply > 0) {
        await settlePiPaidCenti(sb, a.pi_id, apply);
        // Record EXACTLY what we applied, so a later cancel reverses precisely this.
        await sb.from('pv_allocations').update({ applied_centi: apply }).eq('id', a.id);
      }
    }
  }

  return c.json({ ok: true, jeNo: je.je_no, jeId: je.id, totalSen });
});

/* ────────────────────────────────────────────────────────────────────────
   POST /:id/cancel — reverse the JE (if posted), flip → CANCELLED.
   ──────────────────────────────────────────────────────────────────────── */

paymentVouchers.post('/:id/cancel', async (c) => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.cancel')) {
    return c.json({ error: 'Forbidden: missing scm.payment_voucher.cancel' }, 403);
  }
  const sb = c.get('supabase'); const id = c.req.param('id');

  const { data: cur } = await sb.from('payment_vouchers').select('id, status, pv_number, purpose').eq('id', id).maybeSingle();
  if (!cur) return c.json({ error: 'not_found' }, 404);
  const head = cur as { id: string; status: string; pv_number: string; purpose: string | null };
  // Idempotent — already cancelled, echo back.
  if (head.status === 'CANCELLED') return c.json({ paymentVoucher: { id, status: 'CANCELLED' } });

  /* ATOMIC ACTIVE→CANCELLED — the conditional UPDATE excludes CANCELLED, so two
     concurrent cancels race and only ONE flips it (the other gets no row back →
     idempotent no-op). Guarantees the reversal below runs at most once. */
  const { data, error } = await sb.from('payment_vouchers').update({
    status: 'CANCELLED', updated_at: new Date().toISOString(),
  }).eq('id', id).neq('status', 'CANCELLED').select('id, status, pv_number').maybeSingle();
  if (error) return c.json({ error: 'cancel_failed', reason: error.message }, 500);
  if (!data) {
    const { data: now } = await sb.from('payment_vouchers').select('id, status').eq('id', id).maybeSingle();
    if ((now as { status: string } | null)?.status === 'CANCELLED') return c.json({ paymentVoucher: now });
    return c.json({ error: 'cannot_cancel' }, 409);
  }
  const cancelled = data as { id: string; status: string; pv_number: string };

  // Reverse the GL post if one exists. Best-effort (audit-DLQ): a reversal
  // failure never un-cancels the voucher; the contra is idempotent.
  const rev = await reversePvAccounting(sb, cancelled.pv_number);
  if (!rev.ok) {
    // eslint-disable-next-line no-console
    console.error(`[pv-accounting] reversal failed for ${cancelled.pv_number}:`, rev.status, rev.reason);
  }

  /* PV→PI settlement reversal (0202) — un-apply what this PV settled. Decrement
     each linked PI's paid_centi by the EXACT applied_centi recorded at post.
     Only a SUPPLIER_PAYMENT PV ever moved paid_centi. Best-effort. */
  if (normalizePurpose(head.purpose) === 'SUPPLIER_PAYMENT') {
    const { data: allocs } = await sb.from('pv_allocations')
      .select('id, pi_id, applied_centi').eq('pv_id', id);
    for (const a of (allocs ?? []) as Array<{ id: string; pi_id: string; applied_centi: number }>) {
      const applied = Math.max(0, Number(a.applied_centi ?? 0));
      if (applied <= 0) continue;
      await settlePiPaidCenti(sb, a.pi_id, -applied);
      await sb.from('pv_allocations').update({ applied_centi: 0 }).eq('id', a.id);
    }
  }

  return c.json({ paymentVoucher: { id: cancelled.id, status: cancelled.status } });
});

/* ── reversePvAccounting — contra the active PV JE (mirror reversePiAccounting).
   Loads the original lines + swaps Dr/Cr so the reversal nets the original to
   zero, flags the original reversed=true. Idempotent. */
async function reversePvAccounting(
  sb: any,
  pvNumber: string,
): Promise<{ ok: boolean; status: string; jeNo?: string; jeId?: string; reason?: string }> {
  const { data: origRows } = await sb.from('journal_entries')
    .select('id, je_no, entry_date, reversed, total_debit_sen, total_credit_sen, company_id')
    .eq('source_type', 'PV').eq('source_doc_no', pvNumber);
  const orig = ((origRows ?? []) as Array<{ id: string; je_no: string; entry_date: string; reversed: boolean; total_debit_sen: number; total_credit_sen: number; company_id: number | null }>)
    .find((r) => !r.reversed);
  if (!orig) return { ok: true, status: 'nothing_to_reverse' };

  const { data: revExisting } = await sb.from('journal_entries')
    .select('id, je_no').eq('source_type', 'PV_REVERSAL').eq('reversed_by_je', orig.id).limit(1);
  if (revExisting && revExisting.length > 0) {
    await sb.from('journal_entries').update({ reversed: true, reversed_by_je: revExisting[0].id }).eq('id', orig.id);
    return { ok: true, status: 'already_reversed' };
  }

  const totalSen = Number(orig.total_debit_sen ?? orig.total_credit_sen ?? 0);
  if (totalSen <= 0) {
    await sb.from('journal_entries').update({ reversed: true }).eq('id', orig.id);
    return { ok: true, status: 'reversed', jeNo: orig.je_no, jeId: orig.id };
  }

  const { data: origLines } = await sb.from('journal_entry_lines')
    .select('account_code, debit_sen, credit_sen, party_type, party_code, party_name, notes')
    .eq('journal_entry_id', orig.id).order('line_no');
  const oLines = (origLines ?? []) as Array<{
    account_code: string; debit_sen: number; credit_sen: number;
    party_type: string | null; party_code: string | null; party_name: string | null; notes: string | null;
  }>;

  const companyId = orig.company_id ?? null;
  const companyLine = companyId != null ? { company_id: companyId } : {};
  const revJeNo = await nextJeNo(sb, new Date(orig.entry_date));
  const { data: revJe, error: revErr } = await sb.from('journal_entries').insert({
    ...companyLine,
    je_no:            revJeNo,
    entry_date:       new Date().toISOString().slice(0, 10),
    source_type:      'PV_REVERSAL',
    source_doc_no:    pvNumber,
    narration:        `Reversal of ${orig.je_no} — Payment voucher ${pvNumber} cancelled`,
    total_debit_sen:  totalSen,
    total_credit_sen: totalSen,
    reversed_by_je:   orig.id,
  }).select('*').single();
  if (revErr) return { ok: false, status: 'reversal_insert_failed', reason: revErr.message };

  const swapped = oLines.length > 0
    ? oLines.map((l, i) => ({
        ...companyLine,
        journal_entry_id: revJe.id,
        line_no:          i + 1,
        account_code:     l.account_code,
        debit_sen:        Number(l.credit_sen ?? 0),
        credit_sen:       Number(l.debit_sen ?? 0),
        party_type:       l.party_type ?? null,
        party_code:       l.party_code ?? null,
        party_name:       l.party_name ?? null,
        notes:            `Reversal — ${l.notes ?? ''}`.trim(),
      }))
    : [];
  if (swapped.length > 0) {
    const { error: lErr } = await sb.from('journal_entry_lines').insert(swapped);
    if (lErr) { await sb.from('journal_entries').delete().eq('id', revJe.id); return { ok: false, status: 'reversal_lines_failed', reason: lErr.message }; }
  }

  await sb.from('journal_entries').update({ posted: true }).eq('id', revJe.id);
  await sb.from('journal_entries').update({ reversed: true, reversed_by_je: revJe.id }).eq('id', orig.id);

  return { ok: true, status: 'reversed', jeNo: revJe.je_no, jeId: revJe.id };
}
