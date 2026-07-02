// ----------------------------------------------------------------------------
// post-si-revenue — idempotent Sales Invoice → General Ledger posting.
//
// Confirming / creating a Sales Invoice records revenue: it writes a balanced
// journal entry Dr 1100 (Accounts Receivable) / Cr 4000 (Sales Revenue) for the
// invoice total into journal_entries + journal_entry_lines, then marks it
// posted.
//
// IDEMPOTENT: keyed on (source_type='SI', source_doc_no=invoice_number). If a
// JE for that invoice already exists, this is a no-op that reports the existing
// JE — it never double-posts. This is the single source of truth shared by:
//   • POST /accounting/post/si/:invoiceNumber  (manual / explicit re-post)
//   • POST /sales-invoices                     (auto-post on create/confirm)
// ----------------------------------------------------------------------------

import { todayMyt } from './my-time';

const padMmDd = (d: Date): string => {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  return `${yy}${m}`;
};

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

export type PostSiResult =
  | { ok: true; status: 'posted'; jeNo: string; jeId: string; totalSen: number }
  | { ok: true; status: 'already_posted'; jeNo: string; jeId: string }
  | { ok: false; status: 'invoice_not_found' | 'zero_total' | 'je_insert_failed' | 'lines_insert_failed' | 'post_failed'; reason?: string };

/**
 * Post (or no-op if already posted) the GL entry for a Sales Invoice.
 * Returns a structured result; never throws on the expected failure paths.
 */
export async function postSiRevenue(sb: any, invoiceNumber: string): Promise<PostSiResult> {
  // ── Idempotency guard — does an ACTIVE (non-reversed) SI JE already exist? ──
  // We deliberately ignore REVERSED JEs: after resyncSiRevenue voids a stale
  // entry it calls us to post a FRESH one at the new total, so a reversed
  // original must NOT block the re-post. The trial-balance views already exclude
  // reversed entries, so only a live one means "already posted".
  const { data: existingRows } = await sb
    .from('journal_entries')
    .select('id, je_no, reversed')
    .eq('source_type', 'SI')
    .eq('source_doc_no', invoiceNumber);
  const activeExisting = ((existingRows ?? []) as Array<{ id: string; je_no: string; reversed: boolean | null }>)
    .find((r) => !r.reversed);
  if (activeExisting) {
    return { ok: true, status: 'already_posted', jeNo: activeExisting.je_no, jeId: activeExisting.id };
  }

  const { data: si, error } = await sb
    .from('sales_invoices')
    .select('invoice_number, invoice_date, debtor_code, debtor_name, total_centi')
    .eq('invoice_number', invoiceNumber)
    .single();
  if (error || !si) return { ok: false, status: 'invoice_not_found' };

  const totalSen = Number(si.total_centi);
  if (totalSen <= 0) return { ok: false, status: 'zero_total' };

  const lines = [
    {
      accountCode: '1100',                                   // Accounts Receivable
      debitSen: totalSen,
      creditSen: 0,
      partyType: 'CUSTOMER',
      partyCode: si.debtor_code,
      partyName: si.debtor_name,
      notes: `AR for ${si.invoice_number}`,
    },
    {
      accountCode: '4000',                                   // Sales Revenue
      debitSen: 0,
      creditSen: totalSen,
      partyType: null,
      partyCode: null,
      partyName: null,
      notes: `Revenue from ${si.invoice_number}`,
    },
  ];

  const jeNo = await nextJeNo(sb, new Date(si.invoice_date));
  const { data: je, error: jeErr } = await sb
    .from('journal_entries')
    .insert({
      je_no: jeNo,
      entry_date: si.invoice_date,
      source_type: 'SI',
      source_doc_no: si.invoice_number,
      narration: `Sales invoice ${si.invoice_number} — ${si.debtor_name}`,
      total_debit_sen: totalSen,
      total_credit_sen: totalSen,
    })
    .select('*')
    .single();
  if (jeErr) return { ok: false, status: 'je_insert_failed', reason: jeErr.message };

  const lineRows = lines.map((l, i) => ({
    journal_entry_id: je.id,
    line_no: i + 1,
    account_code: l.accountCode,
    debit_sen: l.debitSen ?? 0,
    credit_sen: l.creditSen ?? 0,
    party_type: l.partyType ?? null,
    party_code: l.partyCode ?? null,
    party_name: l.partyName ?? null,
    notes: l.notes ?? null,
  }));
  const { error: linesErr } = await sb.from('journal_entry_lines').insert(lineRows);
  if (linesErr) {
    await sb.from('journal_entries').delete().eq('id', je.id);
    return { ok: false, status: 'lines_insert_failed', reason: linesErr.message };
  }

  const { error: postErr } = await sb
    .from('journal_entries')
    .update({ posted: true })
    .eq('id', je.id);
  if (postErr) return { ok: false, status: 'post_failed', reason: postErr.message };

  return { ok: true, status: 'posted', jeNo: je.je_no, jeId: je.id, totalSen };
}

export type ReverseSiResult =
  | { ok: true; status: 'reversed'; jeNo: string; jeId: string }
  | { ok: true; status: 'already_reversed' | 'nothing_to_reverse' }
  | { ok: false; status: 'reversal_insert_failed' | 'reversal_lines_failed'; reason?: string };

/**
 * Reverse (void) the revenue JE for a Sales Invoice when it is CANCELLED.
 *
 * Writes a MIRROR journal entry — Dr 4000 (Sales Revenue) / Cr 1100 (Accounts
 * Receivable) for the same total — that nets the original to zero, then flags
 * the original `reversed = true` + `reversed_by_je`. The trial-balance /
 * account-balance views (migration 0052) only count `posted = TRUE AND
 * reversed = FALSE`, so once flagged the original revenue no longer counts and
 * the reversing entry exactly cancels it — net GL impact zero.
 *
 * IDEMPOTENT: keyed on the original JE's `reversed` flag AND on the existence
 * of a reversing JE (source_type='SI_REVERSAL', source_doc_no=invoice_number).
 * Re-cancelling, retries, or a second status PATCH all no-op.
 */
export async function reverseSiRevenue(sb: any, invoiceNumber: string): Promise<ReverseSiResult> {
  // Find the ACTIVE (non-reversed) SI revenue JE — an invoice may carry several
  // historical SI JEs after edit-driven void+repost cycles (resyncSiRevenue), so
  // we void the live one, not an arbitrary `.limit(1)` row. Nothing live →
  // nothing to reverse.
  const { data: origRows } = await sb
    .from('journal_entries')
    .select('id, je_no, entry_date, reversed, total_debit_sen, total_credit_sen, narration')
    .eq('source_type', 'SI')
    .eq('source_doc_no', invoiceNumber);
  const orig = ((origRows ?? []) as Array<{ id: string; je_no: string; entry_date: string; reversed: boolean; total_debit_sen: number; total_credit_sen: number; narration: string | null }>)
    .find((r) => !r.reversed);
  if (!orig) return { ok: true, status: 'nothing_to_reverse' };

  // Idempotency guard — a reversing JE already tied to THIS original exists (the
  // flag never stuck). Keyed on reversed_by_je = orig.id, NOT just "any reversal
  // for this invoice", so a prior cycle's reversal doesn't block voiding the
  // current live JE.
  const { data: revExisting } = await sb
    .from('journal_entries')
    .select('id, je_no')
    .eq('source_type', 'SI_REVERSAL')
    .eq('reversed_by_je', orig.id)
    .limit(1);
  if (revExisting && revExisting.length > 0) {
    // The reversing JE exists but the flag never got set — make the flag stick.
    await sb.from('journal_entries').update({ reversed: true, reversed_by_je: revExisting[0].id }).eq('id', orig.id);
    return { ok: true, status: 'already_reversed' };
  }

  const totalSen = Number(orig.total_debit_sen ?? orig.total_credit_sen ?? 0);
  if (totalSen <= 0) {
    // Nothing of value to reverse — just flag it so re-cancels no-op.
    await sb.from('journal_entries').update({ reversed: true }).eq('id', orig.id);
    return { ok: true, status: 'reversed', jeNo: orig.je_no, jeId: orig.id };
  }

  // Load the original lines so the reversal mirrors the SAME accounts + parties,
  // just with debit/credit swapped (a faithful contra entry).
  const { data: origLines } = await sb
    .from('journal_entry_lines')
    .select('account_code, debit_sen, credit_sen, party_type, party_code, party_name, notes')
    .eq('journal_entry_id', orig.id)
    .order('line_no');
  const oLines = (origLines ?? []) as Array<{
    account_code: string; debit_sen: number; credit_sen: number;
    party_type: string | null; party_code: string | null; party_name: string | null; notes: string | null;
  }>;

  const revJeNo = await nextJeNo(sb, new Date(orig.entry_date));
  const { data: revJe, error: revErr } = await sb
    .from('journal_entries')
    .insert({
      je_no: revJeNo,
      entry_date: todayMyt(),
      source_type: 'SI_REVERSAL',
      source_doc_no: invoiceNumber,
      narration: `Reversal of ${orig.je_no} — Sales invoice ${invoiceNumber} cancelled`,
      total_debit_sen: totalSen,
      total_credit_sen: totalSen,
      reversed_by_je: orig.id,
    })
    .select('*')
    .single();
  if (revErr) return { ok: false, status: 'reversal_insert_failed', reason: revErr.message };

  // Swap each original line's debit/credit so the reversal nets the original to
  // zero. Fall back to the canonical 2-line entry if the original had no lines.
  const swapped = oLines.length > 0
    ? oLines.map((l, i) => ({
        journal_entry_id: revJe.id,
        line_no: i + 1,
        account_code: l.account_code,
        debit_sen: Number(l.credit_sen ?? 0),
        credit_sen: Number(l.debit_sen ?? 0),
        party_type: l.party_type ?? null,
        party_code: l.party_code ?? null,
        party_name: l.party_name ?? null,
        notes: `Reversal — ${l.notes ?? ''}`.trim(),
      }))
    : [
        { journal_entry_id: revJe.id, line_no: 1, account_code: '4000', debit_sen: totalSen, credit_sen: 0, party_type: null, party_code: null, party_name: null, notes: `Reverse revenue ${invoiceNumber}` },
        { journal_entry_id: revJe.id, line_no: 2, account_code: '1100', debit_sen: 0, credit_sen: totalSen, party_type: null, party_code: null, party_name: null, notes: `Reverse AR ${invoiceNumber}` },
      ];
  const { error: linesErr } = await sb.from('journal_entry_lines').insert(swapped);
  if (linesErr) {
    await sb.from('journal_entries').delete().eq('id', revJe.id);
    return { ok: false, status: 'reversal_lines_failed', reason: linesErr.message };
  }

  // Post the reversal + flag the original. Order matters: if the flag update
  // fails the reversing JE still exists, so guard #2 makes a retry idempotent.
  await sb.from('journal_entries').update({ posted: true }).eq('id', revJe.id);
  await sb.from('journal_entries').update({ reversed: true, reversed_by_je: revJe.id }).eq('id', orig.id);

  return { ok: true, status: 'reversed', jeNo: revJe.je_no, jeId: revJe.id };
}

export type ResyncSiResult =
  | { ok: true; status: 'unchanged' | 'not_posted' | 'resynced' | 'reversed_to_zero' | 'posted' }
  | { ok: false; status: string; reason?: string };

/**
 * Re-align a Sales Invoice's revenue JE with its CURRENT total after a line was
 * edited / added / deleted post-issue. Wei Siang 2026-06-01 chose "auto void the
 * stale entry + re-post at the new amount" (auto credit-note + reissue) so the
 * GL never drifts from the invoice.
 *
 *   • No live JE yet + total > 0  → post a fresh one (covers a blank invoice
 *     getting its first line, and self-heals a never-posted issued invoice).
 *   • No live JE + total ≤ 0      → nothing to do.
 *   • Live JE, total unchanged    → no-op (no needless churn).
 *   • Live JE, total changed > 0  → void the stale JE, post a fresh one.
 *   • Live JE, new total ≤ 0      → void only (all lines gone → no revenue left).
 *
 * Idempotent: a second call finds the JE already matching → 'unchanged'.
 * Best-effort caller pattern — never blocks the line edit on a GL hiccup.
 */
export async function resyncSiRevenue(sb: any, invoiceNumber: string): Promise<ResyncSiResult> {
  // Current live SI JE (non-reversed) + its booked total.
  const { data: jeRows } = await sb
    .from('journal_entries')
    .select('id, total_debit_sen, reversed')
    .eq('source_type', 'SI')
    .eq('source_doc_no', invoiceNumber);
  const active = ((jeRows ?? []) as Array<{ id: string; total_debit_sen: number; reversed: boolean | null }>)
    .find((r) => !r.reversed);

  // Current invoice total + status.
  const { data: si } = await sb
    .from('sales_invoices')
    .select('total_centi, status')
    .eq('invoice_number', invoiceNumber)
    .maybeSingle();
  const newTotal = Number((si as { total_centi?: number } | null)?.total_centi ?? 0);

  /* A CANCELLED or DRAFT invoice must never (re)post revenue. CANCELLED: its JE
     was already reversed on cancel. DRAFT: it has not committed any revenue yet
     (posting happens on confirm) — editing a draft's lines must NOT post GL.
     Both are short-circuited so a line mutation can't leak revenue. */
  {
    const s = ((si as { status?: string } | null)?.status ?? '').toUpperCase();
    if (s === 'CANCELLED' || s === 'DRAFT') {
      return { ok: true, status: 'not_posted' };
    }
  }

  if (!active) {
    // Never posted (or fully reversed). Post fresh only when there's value —
    // SI posts revenue on issue, so a positive total with no live JE should post.
    if (newTotal > 0) {
      const post = await postSiRevenue(sb, invoiceNumber);
      return post.ok ? { ok: true, status: 'posted' } : { ok: false, status: post.status, reason: (post as { reason?: string }).reason };
    }
    return { ok: true, status: 'not_posted' };
  }

  if (Number(active.total_debit_sen) === newTotal) return { ok: true, status: 'unchanged' };

  // Total changed → void the stale JE.
  const rev = await reverseSiRevenue(sb, invoiceNumber);
  if (!rev.ok) return { ok: false, status: rev.status, reason: (rev as { reason?: string }).reason };

  // Re-post at the new total. A new total of 0 (all lines removed) means there is
  // nothing left to record — the void alone leaves the GL flat.
  if (newTotal <= 0) return { ok: true, status: 'reversed_to_zero' };
  const post = await postSiRevenue(sb, invoiceNumber);
  return post.ok ? { ok: true, status: 'resynced' } : { ok: false, status: post.status, reason: (post as { reason?: string }).reason };
}
