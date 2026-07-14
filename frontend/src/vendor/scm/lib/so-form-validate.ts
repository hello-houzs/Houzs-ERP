// ----------------------------------------------------------------------------
// so-form-validate — PURE save-time guards for the NEW / EDIT Sales-Order form.
// NO React, no I/O. Desktop `SalesOrderNew` and mobile `MobileNewSO` both feed
// their own state into these, so a guard can't exist on one surface and be
// missing on the other (mobile was missing the past-date / processing>delivery
// guards, and silently DROPPED a slip-less payment — a real money bug where a
// cashier's payment never posted).
//
// Each guard returns the FIRST blocking error as `{ title, body? }` (both
// surfaces short-circuit on the first failure) or null when the input passes.
// Desktop renders it via notify({title, body}); mobile flattens to a sentence.
// ----------------------------------------------------------------------------

export interface SoFormError {
  title: string;
  body?: string;
}

/** Flatten a structured error into a single sentence (mobile `setError`). */
export const soErrorText = (e: SoFormError): string =>
  e.body ? `${e.title} ${e.body}` : e.title;

export interface SoDateGuardInput {
  /** '' when unset. */
  processingDate: string;
  deliveryDate: string;
  /** todayMyt() — MYT calendar day, NOT the device clock. */
  today: string;
  /**
   * Enforce the "both dates or neither" rule. Desktop always does; mobile skips
   * it for a draft (it strips both dates), so pass false there.
   */
  requireDatesTogether?: boolean;
}

/**
 * Date sanity for an SO: dates set together, not in the past, and processing
 * (factory start) not after delivery. Mirrors desktop `SalesOrderNew.onSave`
 * (Commander 2026-05-28 / Owner 2026-06-03) verbatim.
 */
export function soDateGuardError(i: SoDateGuardInput): SoFormError | null {
  const hasP = i.processingDate.trim() !== "";
  const hasD = i.deliveryDate.trim() !== "";
  if ((i.requireDatesTogether ?? true) && hasP !== hasD) {
    return {
      title: "Processing Date and Delivery Date must be set together.",
      body:
        "Either fill in BOTH dates, or leave BOTH empty — partial dates cause scheduling issues.",
    };
  }
  if (hasP && i.processingDate < i.today) {
    return { title: "Processing Date cannot be in the past — pick today or a future date." };
  }
  if (hasD && i.deliveryDate < i.today) {
    return { title: "Delivery Date cannot be in the past — pick today or a future date." };
  }
  if (hasP && hasD && i.processingDate > i.deliveryDate) {
    return { title: "Processing Date cannot be later than the Delivery Date." };
  }
  return null;
}

export interface SoPaymentGuardRow {
  /** Payment amount in sen/cents. */
  amountCenti: number;
  /**
   * True when this amount-bearing row has proof attached — a freshly uploaded
   * slip session OR (desktop) a scanned receipt whose R2 key IS the slip.
   */
  hasSlip: boolean;
}

/**
 * Every amount-bearing payment must carry a slip before the SO is saved — the
 * POST /:docNo/payments route 400s a slip-less payment, and (the bug this
 * closes on mobile) silently dropping such a row loses the payment entirely.
 * Mirrors desktop `SalesOrderNew.onSave` Spec D4.
 */
export function soSliplessPaymentError(rows: SoPaymentGuardRow[]): SoFormError | null {
  const n = rows.filter((r) => r.amountCenti > 0 && !r.hasSlip).length;
  if (n === 0) return null;
  return {
    title: "Each payment needs a slip uploaded before saving.",
    body:
      `${n} payment row${n === 1 ? "" : "s"} ${n === 1 ? "is" : "are"} missing a slip — upload ` +
      `${n === 1 ? "it" : "them"} (the "Slip *" button) and try again.`,
  };
}
