// ----------------------------------------------------------------------------
// so-save-problems — collect EVERY Processing-Date / save gate failure into ONE
// list, so the operator sees all the reasons at once instead of fixing them one
// at a time.
//
// Why this exists (owner 2026-07-18): setting a Processing Date (or saving a
// confirmed SO) ran the gates SEQUENTIALLY — the routes `return`ed on the FIRST
// failing gate, so the owner fixed one thing, saved, hit the NEXT gate, saved
// again, hit the next. The backend already knew WHICH line + WHICH variant + the
// deposit shortfall; it just never reported more than one at a time. This
// re-expresses the gates the routes already compute as a flat problem list.
//
// PRESENTATION ONLY. It changes NOTHING about what counts as valid: the same
// category-mandatory variant axes (so-variant-rule), the same 30% deposit
// threshold (order-rules), the same past-date / processing-≤-delivery date
// rules. It only aggregates + names them. Pure — no I/O, no DB, no Hono.
// ----------------------------------------------------------------------------
import { REQUIRED_VARIANT_AXES_BY_CATEGORY } from './so-variant-rule';
import { meetsProcessingDatePaymentGate, PROCESSING_DATE_PAID_THRESHOLD } from './order-rules';
import { fmtRM } from './format';

/** One machine- + human-readable reason a save was rejected.
 *  - `code`  — stable gate identifier (mirrors the legacy single-error codes:
 *              variants_incomplete / processing_date_unpaid / processing_date_past
 *              / delivery_date_past / processing_after_delivery), so any consumer
 *              can still branch on it.
 *  - `message` — the plain-language sentence the operator reads (already 白话文).
 *  - `line`  — the offending item code, when the problem is line-specific.
 *  - `field` — the concrete input to fix (a variant axis label, a date, or the
 *              deposit), so the UI can name / anchor it. */
export type SaveProblem = { code: string; message: string; line?: string; field?: string };

/** Offender shape produced by findIncompleteVariantLines — kept structural here
 *  so this pure module never imports from the routes/lib layer (avoids a shared↔
 *  lib import cycle). `missing` carries canonical axis keys (e.g. 'legHeight'). */
export type VariantOffenderLike = {
  itemCode: string;
  group: string;
  missing: readonly string[];
};

/** Canonical axis key → human label for the given category ('legHeight' →
 *  'Leg Height'). Falls back to the raw key if the axis isn't in the rule. */
const axisLabel = (group: string, key: string): string => {
  const axes = REQUIRED_VARIANT_AXES_BY_CATEGORY[(group ?? '').toLowerCase()] ?? [];
  return axes.find((a) => a.key === key)?.label ?? key;
};

export type ProcessingGateFacts = {
  /** Effective processing date on this save (YYYY-MM-DD) or null. */
  procDate: string | null;
  /** Effective delivery date on this save (YYYY-MM-DD) or null. */
  delivDate: string | null;
  /** Malaysia calendar day (YYYY-MM-DD) — the not-in-the-past floor. */
  todayMY: string;
  /** Stored dates BEFORE this save, for the grandfather carve-out on the edit
   *  path: an already-saved past date this edit does NOT change is a historical
   *  record, not a fresh past entry, and must not block. Omit (leave undefined)
   *  on the create path — every date there is new. */
  origProcDate?: string | null;
  origDelivDate?: string | null;
  /** Lines whose category-mandatory variants aren't filled — exactly what the
   *  routes get from findIncompleteVariantLines. */
  variantOffenders?: readonly VariantOffenderLike[];
  /** Deposit-vs-total for the 30% gate, SAME unit on both sides (centi on the
   *  server). Omit / null when the gate doesn't apply on this path (the
   *  consignment mirror has no deposit gate). The shortfall is reported only
   *  when a processing date is actually being set. */
  deposit?: { paidCenti: number; totalCenti: number } | null;
};

/** Every reason THIS save fails its Processing-Date gates, in the order the
 *  operator reads them: the concrete line+axis variant gaps first, then the
 *  money gate, then the date rules. [] = the save clears every gate.
 *
 *  Each gate here is the SAME predicate the routes used to `return` on — see the
 *  per-branch comments. Nothing new is rejected; failures are just collected. */
export function collectProcessingGateProblems(facts: ProcessingGateFacts): SaveProblem[] {
  const out: SaveProblem[] = [];

  // 1. Category-mandatory variants — one problem per (line, missing axis) so the
  //    UI can name the exact line AND the exact field to fill. Mirrors the
  //    routes' findIncompleteVariantLines → 409 variants_incomplete.
  for (const off of facts.variantOffenders ?? []) {
    for (const key of off.missing) {
      const label = axisLabel(off.group, key);
      out.push({
        code: 'variants_incomplete',
        message: `${off.itemCode} — ${label} is required`,
        line: off.itemCode,
        field: label,
      });
    }
  }

  // 2. 30% deposit — a Processing Date is production's "ready to build" signal,
  //    so it can't be set until >=30% is collected. Reported with the concrete
  //    amount + threshold. Mirrors meetsProcessingDatePaymentGate → 400
  //    processing_date_unpaid. Only fires when a date is actually being set.
  if (facts.deposit && facts.procDate) {
    const { paidCenti, totalCenti } = facts.deposit;
    if (!meetsProcessingDatePaymentGate(paidCenti, totalCenti)) {
      const pct = Math.round(PROCESSING_DATE_PAID_THRESHOLD * 100);
      const neededCenti = Math.ceil(totalCenti * PROCESSING_DATE_PAID_THRESHOLD);
      out.push({
        code: 'processing_date_unpaid',
        // fmtRM takes whole-MYR — the ledger is centi, so divide by 100.
        message: `Deposit ${fmtRM(Math.round(paidCenti / 100))} of ${fmtRM(Math.round(neededCenti / 100))} needed (${pct}%) before a Processing Date can be set`,
        field: 'Deposit',
      });
    }
  }

  // 3. Date rules. A freshly-typed / moved past date is rejected; an unchanged
  //    already-past date is grandfathered (proc/deliv !== their originals).
  const { procDate, delivDate, todayMY } = facts;
  const origProc = facts.origProcDate ?? null;
  const origDeliv = facts.origDelivDate ?? null;

  if (procDate && procDate < todayMY && procDate !== origProc) {
    out.push({
      code: 'processing_date_past',
      message: 'Processing Date cannot be in the past — today or a future date only.',
      field: 'Processing Date',
    });
  }
  if (delivDate && delivDate < todayMY && delivDate !== origDeliv) {
    out.push({
      code: 'delivery_date_past',
      message: 'Delivery Date cannot be in the past — today or a future date only.',
      field: 'Delivery Date',
    });
  }
  // Factory start can't fall after the promised delivery. Both plain ISO
  // YYYY-MM-DD, so a string compare is correct.
  if (procDate && delivDate && procDate > delivDate) {
    out.push({
      code: 'processing_after_delivery',
      message: 'Processing Date cannot be later than the Delivery Date.',
      field: 'Processing Date',
    });
  }

  return out;
}

/** Build the aggregated HTTP body the routes return in place of the old
 *  single-error responses. Callers do:
 *    const problems = collectProcessingGateProblems(facts);
 *    if (problems.length) return c.json(validationFailedBody(problems), 422);
 *  `message` stays a single plain sentence for any surface that only reads
 *  `message` (mobile scan, PDF, un-migrated clients) — the full list is in
 *  `problems`. */
export function validationFailedBody(problems: SaveProblem[]): {
  error: 'validation_failed';
  message: string;
  problems: SaveProblem[];
} {
  const message =
    problems.length === 1
      ? problems[0]!.message
      : `${problems.length} things need fixing before this can be saved.`;
  return { error: 'validation_failed', message, problems };
}
