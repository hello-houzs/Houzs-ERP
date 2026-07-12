// ----------------------------------------------------------------------------
// customer-credits — append-only ledger of customer credit balances
// (Commander 2026-05-30, Edge #11).
//
// When a customer overpays, or when a paid Sales Invoice is cancelled, the
// excess turns into a CREDIT BALANCE the customer can spend on future invoices.
// Each event = one row in customer_credits. Sum of amount_centi per
// debtor_code = current credit balance. Apply-to-SI writes a NEGATIVE entry
// AND a payment row on the new SI, so paid_centi advances naturally and the
// SI shows as "covered by previous credit".
//
// This also handles Edge #9: when an SI with paid_centi > 0 is cancelled, the
// cash on the books stays put — the customer just carries the equivalent as a
// credit. No automatic refund.
// ----------------------------------------------------------------------------

export type CreditSourceType =
  | 'SI_CANCEL_REFUND'   // SI was cancelled with paid_centi > 0 → credit equal to paid_centi
  | 'SI_REOPEN_CONTRA'   // a cancelled SI was reopened → reverse the SI_CANCEL_REFUND credit
  | 'SO_CANCEL_REFUND'   // SO was cancelled with paid deposit > 0 → credit equal to paid deposit
  | 'OVERPAY'            // payment recorded > remaining due → excess turned into credit
  | 'APPLIED_TO_SI'      // negative entry — credit applied to a new invoice
  | 'MANUAL_ADJUST';     // operator-entered adjustment

export type AddCreditInput = {
  debtorCode: string;
  debtorName?: string | null;
  amountCenti: number;                    // signed: + adds, − applies
  sourceType: CreditSourceType;
  sourceDocNo?: string | null;
  sourceDocId?: string | null;
  notes?: string | null;
  createdBy?: string | null;
  // Multi-company (mig 0061): the ledger row's company (from the source SI/SO).
  companyId?: number | null;
};

/** Insert one ledger row. Idempotency note: callers that need it (cancel /
 *  apply) check existence first via the (sourceType, sourceDocNo) pair before
 *  calling addCustomerCredit. */
export async function addCustomerCredit(sb: any, args: AddCreditInput): Promise<{ ok: boolean; id?: string; reason?: string }> {
  if (!args.debtorCode || !args.debtorCode.trim()) return { ok: false, reason: 'debtor_code_required' };
  if (!Number.isFinite(args.amountCenti) || args.amountCenti === 0) return { ok: false, reason: 'amount_zero' };
  const { data, error } = await sb.from('customer_credits').insert({
    ...(args.companyId != null ? { company_id: args.companyId } : {}),
    debtor_code:   args.debtorCode,
    debtor_name:   args.debtorName ?? null,
    amount_centi:  Math.round(args.amountCenti),
    source_type:   args.sourceType,
    source_doc_no: args.sourceDocNo ?? null,
    source_doc_id: args.sourceDocId ?? null,
    notes:         args.notes ?? null,
    created_by:    args.createdBy ?? null,
  }).select('id').single();
  if (error) return { ok: false, reason: error.message };
  return { ok: true, id: (data as { id: string }).id };
}

/** Sum the live credit balance for a customer. */
export async function getCustomerCreditBalance(sb: any, debtorCode: string): Promise<number> {
  if (!debtorCode || !debtorCode.trim()) return 0;
  const { data } = await sb
    .from('customer_credits')
    .select('amount_centi')
    .eq('debtor_code', debtorCode);
  let sum = 0;
  for (const r of (data ?? []) as Array<{ amount_centi: number }>) sum += Number(r.amount_centi ?? 0);
  return sum;
}

/**
 * Apply available customer credit toward a new Sales Invoice.
 *
 *   1. Resolve current balance for debtorCode.
 *   2. Apply = min(balance, remainingDueCenti).
 *   3. Insert a sales_invoice_payments row (method='credit', amount = applied).
 *   4. Insert a customer_credits APPLIED_TO_SI row with amount = −applied.
 *   5. Increment sales_invoices.paid_centi by the applied amount.
 *
 * No-op when balance ≤ 0. Idempotent via a guard: if a credit-payment for
 * this SI already exists, we don't re-apply.
 */
export async function applyCustomerCreditToSi(
  sb: any,
  args: {
    debtorCode: string;
    debtorName?: string | null;
    siId: string;
    siNumber: string;
    remainingDueCenti: number;
    createdBy?: string | null;
  },
): Promise<{ applied: number; reason?: string }> {
  if (!args.debtorCode || !args.debtorCode.trim()) return { applied: 0, reason: 'no_debtor' };
  if (!(args.remainingDueCenti > 0)) return { applied: 0, reason: 'no_due' };

  // Idempotency — already applied to this SI?
  const { data: existing } = await sb
    .from('sales_invoice_payments')
    .select('id, amount_centi')
    .eq('sales_invoice_id', args.siId)
    .eq('method', 'credit')
    .limit(1);
  if (existing && existing.length > 0) {
    return { applied: 0, reason: 'already_applied' };
  }

  const balance = await getCustomerCreditBalance(sb, args.debtorCode);
  if (balance <= 0) return { applied: 0, reason: 'no_balance' };
  const apply = Math.min(balance, args.remainingDueCenti);
  if (apply <= 0) return { applied: 0, reason: 'no_due' };

  // Multi-company (mig 0061): the payment + ledger rows inherit the SI's company.
  const { data: siCo } = await sb.from('sales_invoices').select('company_id').eq('id', args.siId).maybeSingle();
  const companyId = (siCo as { company_id?: number | null } | null)?.company_id ?? null;

  // 1. Payment row on the SI — marks the SI as (partly) paid.
  const { error: payErr } = await sb.from('sales_invoice_payments').insert({
    ...(companyId != null ? { company_id: companyId } : {}),
    sales_invoice_id: args.siId,
    method: 'credit',
    amount_centi: apply,
    note: `Applied customer credit balance toward ${args.siNumber}`,
    created_by: args.createdBy ?? null,
  });
  if (payErr) return { applied: 0, reason: payErr.message };

  // 2. Ledger entry — negative (credit consumed).
  await addCustomerCredit(sb, {
    debtorCode: args.debtorCode,
    debtorName: args.debtorName ?? null,
    amountCenti: -apply,
    sourceType: 'APPLIED_TO_SI',
    sourceDocNo: args.siNumber,
    sourceDocId: args.siId,
    notes: `Auto-applied to ${args.siNumber}`,
    createdBy: args.createdBy ?? null,
    companyId,
  });

  // 3. Bump SI's paid_centi — optimistic-concurrency loop (Bug#5 class, ported
  //    from 2990 ce04e468). The old read-modify-write lost a concurrent SI
  //    payment; gate the UPDATE on the value we read and retry on a 0-row
  //    (concurrent) result.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const { data: cur } = await sb.from('sales_invoices').select('paid_centi').eq('id', args.siId).maybeSingle();
    const prev = Number((cur as { paid_centi: number } | null)?.paid_centi ?? 0);
    const { data: upd } = await sb.from('sales_invoices')
      .update({ paid_centi: prev + apply })
      .eq('id', args.siId)
      .eq('paid_centi', prev)
      .select('id');
    if (upd && upd.length > 0) break; // applied; else a concurrent change → re-read + retry
  }

  return { applied: apply };
}

/**
 * Reconcile the OVERPAY ledger entry for one Sales Invoice. After any change
 * to paid_centi (payment add / delete), the customer's credit balance must
 * match (paid_centi − total_centi) clamped at zero. Edge #A.
 *
 *   target_overpay = max(0, paid − total)
 *   existing_overpay = Σ OVERPAY entries for this SI
 *   delta = target − existing
 *
 * If delta > 0: write a positive OVERPAY entry for the new excess.
 * If delta < 0: write a negative entry (correction — operator removed a
 *               payment, the overpay is partially or fully reversed).
 * Skips when delta is 0 (no change). Skips CANCELLED invoices — cancel-credit
 * is handled by creditFromCancelledSi instead.
 */
export async function reconcileSiOverpay(
  sb: any,
  siId: string,
): Promise<{ delta: number; reason?: string }> {
  const { data: si } = await sb
    .from('sales_invoices')
    .select('invoice_number, total_centi, paid_centi, debtor_code, debtor_name, status, company_id')
    .eq('id', siId)
    .maybeSingle();
  if (!si) return { delta: 0, reason: 'not_found' };
  const s = si as { invoice_number: string; total_centi: number | null; paid_centi: number | null; debtor_code: string | null; debtor_name: string | null; status: string | null; company_id: number | null };
  if (!s.debtor_code) return { delta: 0, reason: 'no_debtor' };
  if ((s.status ?? '').toUpperCase() === 'CANCELLED') return { delta: 0, reason: 'cancelled' };

  const paid  = Number(s.paid_centi ?? 0);
  const total = Number(s.total_centi ?? 0);
  const target = Math.max(0, paid - total);

  // Σ existing OVERPAY entries already booked for this SI (signed).
  const { data: existing } = await sb
    .from('customer_credits')
    .select('amount_centi')
    .eq('source_type', 'OVERPAY')
    .eq('source_doc_no', s.invoice_number);
  const existingTotal = ((existing ?? []) as Array<{ amount_centi: number }>)
    .reduce((acc, r) => acc + Number(r.amount_centi ?? 0), 0);

  const delta = target - existingTotal;
  if (delta === 0) return { delta: 0 };

  const r = await addCustomerCredit(sb, {
    debtorCode: s.debtor_code,
    debtorName: s.debtor_name,
    amountCenti: delta,
    sourceType: 'OVERPAY',
    sourceDocNo: s.invoice_number,
    sourceDocId: siId,
    notes: delta > 0
      ? `Overpayment recorded on ${s.invoice_number} (received ${paid / 100}, due ${total / 100}).`
      : `Overpayment corrected on ${s.invoice_number} after payment removal.`,
    companyId: s.company_id,
  });
  return r.ok ? { delta } : { delta: 0, reason: r.reason };
}

/**
 * Record a refund-as-credit when a paid Sales Invoice is cancelled. Looks at
 * paid_centi > 0 → writes a positive credit row for the customer (idempotent
 * on source_doc_no, so a second cancel-PATCH no-ops).
 */
export async function creditFromCancelledSi(
  sb: any,
  args: { siId: string; siNumber: string; debtorCode: string | null; debtorName: string | null; paidCenti: number; createdBy?: string | null },
): Promise<{ credited: number; reason?: string }> {
  if (!args.debtorCode || !args.debtorCode.trim()) return { credited: 0, reason: 'no_debtor' };
  if (!(args.paidCenti > 0)) return { credited: 0, reason: 'no_paid' };

  // Idempotency — is a cancel-refund credit for this invoice STILL STANDING?
  // We net SI_CANCEL_REFUND against any SI_REOPEN_CONTRA (written when the
  // invoice was reopened): net > 0 means a live credit already exists → no-op.
  // net ≤ 0 means it was never credited OR was reversed on a prior reopen, so a
  // fresh cancel after reopen correctly credits again. (Wei Siang 2026-06-03)
  const { data: priorRows } = await sb
    .from('customer_credits')
    .select('amount_centi')
    .eq('source_doc_no', args.siNumber)
    .in('source_type', ['SI_CANCEL_REFUND', 'SI_REOPEN_CONTRA']);
  const standing = ((priorRows ?? []) as Array<{ amount_centi: number }>)
    .reduce((s, r) => s + Number(r.amount_centi ?? 0), 0);
  if (standing > 0) {
    return { credited: 0, reason: 'already_credited' };
  }

  /* Audit 2026-06-11 H2 — an over-paid SI already booked its excess as a live
     OVERPAY credit (reconcileSiOverpay, which skips CANCELLED invoices and so
     never corrects it). Crediting the full paid_centi here would hand the
     excess out twice, so the cancel credit is paid − Σ live OVERPAY entries
     for this SI (net, never negative). */
  const { data: overRows } = await sb
    .from('customer_credits')
    .select('amount_centi')
    .eq('source_type', 'OVERPAY')
    .eq('source_doc_no', args.siNumber);
  const liveOverpay = ((overRows ?? []) as Array<{ amount_centi: number }>)
    .reduce((s, r) => s + Number(r.amount_centi ?? 0), 0);
  const creditCenti = Math.max(0, args.paidCenti - Math.max(0, liveOverpay));
  if (creditCenti <= 0) return { credited: 0, reason: 'covered_by_overpay' };

  // Multi-company (mig 0061): the ledger row inherits the SI's company.
  const { data: siCo } = await sb.from('sales_invoices').select('company_id').eq('id', args.siId).maybeSingle();
  const companyId = (siCo as { company_id?: number | null } | null)?.company_id ?? null;

  const r = await addCustomerCredit(sb, {
    debtorCode: args.debtorCode,
    debtorName: args.debtorName ?? null,
    amountCenti: creditCenti,
    sourceType: 'SI_CANCEL_REFUND',
    sourceDocNo: args.siNumber,
    sourceDocId: args.siId,
    notes: `Cancelled invoice ${args.siNumber} carried ${creditCenti / 100} as customer credit.`,
    createdBy: args.createdBy ?? null,
    companyId,
  });
  return r.ok ? { credited: creditCenti } : { credited: 0, reason: r.reason };
}

/**
 * Reverse the SI_CANCEL_REFUND credit when a cancelled Sales Invoice is REOPENED.
 * On reopen the invoice goes live again and its payments ledger restores
 * paid_centi — so the credit handed out at cancel must be clawed back, or the
 * customer is credited twice. Writes a NEGATIVE contra row (SI_REOPEN_CONTRA) of
 * the net standing cancel-refund. Idempotent: once net ≤ 0, no-op. (2026-06-03)
 */
export async function reverseCancelledSiCredit(
  sb: any,
  args: { siId: string; siNumber: string; debtorCode: string | null; debtorName: string | null; createdBy?: string | null },
): Promise<{ reversed: number; reason?: string }> {
  if (!args.debtorCode || !args.debtorCode.trim()) return { reversed: 0, reason: 'no_debtor' };
  const { data: rows } = await sb
    .from('customer_credits')
    .select('amount_centi')
    .eq('source_doc_no', args.siNumber)
    .in('source_type', ['SI_CANCEL_REFUND', 'SI_REOPEN_CONTRA']);
  const standing = ((rows ?? []) as Array<{ amount_centi: number }>)
    .reduce((s, r) => s + Number(r.amount_centi ?? 0), 0);
  if (standing <= 0) return { reversed: 0, reason: 'nothing_to_reverse' };

  // Multi-company (mig 0061): the contra row inherits the SI's company.
  const { data: siCo } = await sb.from('sales_invoices').select('company_id').eq('id', args.siId).maybeSingle();
  const companyId = (siCo as { company_id?: number | null } | null)?.company_id ?? null;

  const r = await addCustomerCredit(sb, {
    debtorCode: args.debtorCode,
    debtorName: args.debtorName ?? null,
    amountCenti: -standing,
    sourceType: 'SI_REOPEN_CONTRA',
    sourceDocNo: args.siNumber,
    sourceDocId: args.siId,
    notes: `Reopened invoice ${args.siNumber} — cancel-refund credit (${standing / 100}) reversed.`,
    createdBy: args.createdBy ?? null,
    companyId,
  });
  return r.ok ? { reversed: standing } : { reversed: 0, reason: r.reason };
}

/**
 * Record a refund-as-credit when a Sales Order with deposit payments is
 * cancelled. Reads mfg_sales_order_payments to sum what was paid, then writes
 * one positive credit entry (SO_CANCEL_REFUND). Idempotent on
 * (source_type, source_doc_no=docNo) so re-cancel no-ops. Edge #B.
 */
export async function creditFromCancelledSo(
  sb: any,
  args: { docNo: string; debtorCode: string | null; debtorName: string | null; createdBy?: string | null },
): Promise<{ credited: number; reason?: string }> {
  if (!args.debtorCode || !args.debtorCode.trim()) return { credited: 0, reason: 'no_debtor' };

  // Idempotency — already credited?
  const { data: existing } = await sb
    .from('customer_credits')
    .select('id')
    .eq('source_type', 'SO_CANCEL_REFUND')
    .eq('source_doc_no', args.docNo)
    .limit(1);
  if (existing && existing.length > 0) {
    return { credited: 0, reason: 'already_credited' };
  }

  // Sum deposits on the SO. The payments table keys on so_doc_no
  // (mfg_sales_order_payments — migration 0073).
  const { data: pays } = await sb
    .from('mfg_sales_order_payments')
    .select('amount_centi, company_id')
    .eq('so_doc_no', args.docNo);
  const payRows = (pays ?? []) as Array<{ amount_centi: number; company_id?: number | null }>;
  const total = payRows.reduce((s, p) => s + Number(p.amount_centi ?? 0), 0);
  if (total <= 0) return { credited: 0, reason: 'no_paid' };
  // Multi-company (mig 0061): the ledger row inherits the SO's company (via its payments).
  const companyId = payRows.find((p) => p.company_id != null)?.company_id ?? null;

  const r = await addCustomerCredit(sb, {
    debtorCode: args.debtorCode,
    debtorName: args.debtorName ?? null,
    amountCenti: total,
    sourceType: 'SO_CANCEL_REFUND',
    sourceDocNo: args.docNo,
    notes: `Cancelled Sales Order ${args.docNo} carried deposit ${total / 100} as customer credit.`,
    createdBy: args.createdBy ?? null,
    companyId,
  });
  return r.ok ? { credited: total } : { credited: 0, reason: r.reason };
}
