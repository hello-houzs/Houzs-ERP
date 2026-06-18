// Order-state pure functions. Lifted from prototype per PORT_DESIGN.md §11.2.
// Implementations TODO — port during Phase 3 (order lifecycle).

export interface LaneCondition { lane: string; require: ('paid_full' | 'slip_verified' | 'driver_assigned' | 'do_signed')[] }

/** True if the order satisfies all conditions to enter the target lane. */
export const checkConditions = (_order: unknown, _conditions: LaneCondition): boolean => {
  throw new Error('checkConditions: not yet implemented (Phase 3)');
};

/** 0..100 — what fraction of total has been paid across all payments. */
export const paidPct = (paid: number, total: number): number => {
  if (total <= 0) return 0;
  return Math.min(100, Math.round((paid / total) * 100));
};

/** Minimum paid fraction (of the order total) to advance an order to Proceed. */
export const PROCEED_PAID_THRESHOLD = 0.5;

/** Inputs to the "ready to Proceed" gate. `paid` / `total` must share a unit
 *  (whole-MYR on the POS, centi on the server) — only their ratio is used, so
 *  either side may pass its own representation. */
export interface ProceedGateInput {
  hasCustomerName: boolean;
  hasEmail: boolean;
  /** Delivery address line 1 present. A "Fill in later" handover leaves this
   *  (and the postcode) blank, so the gate fails — exactly the case that must
   *  keep an order in Order Placed. */
  hasAddress: boolean;
  hasPostcode: boolean;
  hasDeliveryDate: boolean;
  paid: number;
  total: number;
}

/** The single source of truth for "may this SO move to Proceed?". Used by BOTH
 *  the POS "Move to Proceed" button (manual) and the server's create handler
 *  (auto-stamp proceeded_at when the handover already arrives complete) so the
 *  two can never drift. Mirrors the four checklist ticks in the POS drawer:
 *  customer info (name + email), delivery address (line 1 + postcode), a
 *  delivery date, and ≥ 50% paid. */
export const meetsProceedGate = (i: ProceedGateInput): boolean =>
  i.hasCustomerName &&
  i.hasEmail &&
  i.hasAddress &&
  i.hasPostcode &&
  i.hasDeliveryDate &&
  i.total > 0 &&
  i.paid / i.total >= PROCEED_PAID_THRESHOLD;

/** Total physical pieces in an order (for delivery slot allocation). */
export const pieceCount = (_orderItems: unknown[]): number => {
  throw new Error('pieceCount: not yet implemented (Phase 3)');
};
