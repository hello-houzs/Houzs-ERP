/* ----------------------------------------------------------------------------
   Payment methods — the single source of truth for the L1 method vocabulary.

   Loo 2026-06-06: "i want all same together and decide from so maintenance
   page". The POS handover cards, the Backend New-SO / SO-Detail Payments
   cascade, and the SO Maintenance editor all share ONE list: the
   so_dropdown_options 'payment_method' category. This module is the bridge
   between that list and the code that branches on a method:

   - Each maintenance row's VALUE is an immutable key ('Merchant' / 'Online' /
     'Installment' / 'Cash') — the API blocks value edits, adds, deletes and
     deactivation for this category (see routes/so-dropdown-options.ts).
   - Each VALUE maps here to an internal CODE ('merchant' / 'transfer' /
     'installment' / 'cash') — what the ledger stores
     (mfg_sales_order_payments.method) and what branch logic switches on.
   - The row's LABEL is free — renaming it in SO Maintenance re-labels the
     POS cards and the Backend selects everywhere, with zero code impact.

   Don't add a 5th code here without wiring its branch logic end-to-end
   (POS card behaviour, deposit ledger, payments route, list-grid summary).
   ---------------------------------------------------------------------------- */

/** Internal method code — persisted on payment rows, branched on in code. */
export type PaymentMethodCode = 'merchant' | 'transfer' | 'installment' | 'cash';

export const PAYMENT_METHOD_CODES = ['merchant', 'transfer', 'installment', 'cash'] as const;

/** Maintenance row VALUE (immutable key) → internal code.
 *  'Online' → 'transfer' is historical: the ledger enum predates the
 *  maintenance cascade (migration 0083) and renaming stored methods would
 *  orphan Finance data. */
export const PAYMENT_METHOD_VALUE_TO_CODE: Readonly<Record<string, PaymentMethodCode>> = {
  Merchant:    'merchant',
  Online:      'transfer',
  Installment: 'installment',
  Cash:        'cash',
};

/** Internal code → maintenance row VALUE (the immutable key). */
export const PAYMENT_METHOD_CODE_TO_VALUE: Readonly<Record<PaymentMethodCode, string>> = {
  merchant:    'Merchant',
  transfer:    'Online',
  installment: 'Installment',
  cash:        'Cash',
};

/** Display-label fallbacks — used before the maintenance fetch lands or if a
 *  row is somehow missing. The LIVE labels come from the payment_method rows;
 *  these mirror the seeds in migration 0156. */
export const PAYMENT_METHOD_DEFAULT_LABELS: Readonly<Record<PaymentMethodCode, string>> = {
  merchant:    'Merchant',
  transfer:    'Bank transfer / DuitNow',
  installment: 'Installment',
  cash:        'Cash',
};

/** Resolve a maintenance VALUE to its internal code, or null when the value
 *  isn't one of the four core rows (shouldn't happen — the category is
 *  locked — but renders must never crash on bad data). */
export const paymentMethodCodeForValue = (value: string): PaymentMethodCode | null =>
  PAYMENT_METHOD_VALUE_TO_CODE[value] ?? null;

/** True when this (category, value) pair is one of the four locked core
 *  payment-method rows — the API refuses to delete/deactivate these and the
 *  maintenance UIs render them with the lock affordance. */
export const isCorePaymentMethodRow = (category: string, value: string): boolean =>
  category === 'payment_method' && value in PAYMENT_METHOD_VALUE_TO_CODE;
