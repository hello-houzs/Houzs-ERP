// ----------------------------------------------------------------------------
// so-field-policy (frontend vendored copy) — THE single source of truth for
// "what can be edited on a processing-locked Sales Order, and does Save write
// it or raise an amendment".
//
// THIS FILE IS A VENDORED MIRROR of backend/src/scm/shared/so-field-policy.ts.
// The two builds are separate TypeScript projects with no shared import path
// (that is what frontend/src/vendor/scm IS — the vendoring boundary), so the
// table is physically duplicated. It is NOT duplicated in the sense that
// matters: so-field-policy.test.ts reads the backend file off disk and fails
// the frontend CI job if a single policy row differs. Edit the backend table,
// then mirror it here; the test tells you if you forgot.
//
// Read the backend file for the full rationale. The short version:
//   * FREE       — Save writes straight to the database, no gate. Audited.
//   * CONTROLLED — Save raises an AMENDMENT for approval instead.
//   * DERIVED    — frozen like CONTROLLED but recomputed server-side, so the
//                  client must OMIT it rather than send it.
//
// Owner's test for which is which: does the field change what gets DELIVERED or
// what gets CHARGED? Contact details are not that.
// ----------------------------------------------------------------------------

export type SoFieldClass = 'FREE' | 'CONTROLLED' | 'DERIVED';

export type SoHeaderFieldPolicy = {
  column: string;
  payloadKey: string;
  label: string;
  cls: SoFieldClass;
  reason: string;
};

/* MIRROR of the backend table — column / payloadKey / label / cls must match
   row-for-row and in order. `reason` is prose and is NOT drift-tested. */
export const SO_HEADER_FIELD_POLICY: readonly SoHeaderFieldPolicy[] = [
  {
    column: 'internal_expected_dd',
    payloadKey: 'internalExpectedDd',
    label: 'Processing Date',
    cls: 'CONTROLLED',
    reason: 'The lock boundary itself, and the date the supplier works to.',
  },
  {
    column: 'customer_delivery_date',
    payloadKey: 'customerDeliveryDate',
    label: 'Delivery Date',
    cls: 'CONTROLLED',
    reason: 'What the customer was promised and what the supplier schedules to.',
  },
  {
    column: 'customer_state',
    payloadKey: 'customerState',
    label: 'State',
    cls: 'CONTROLLED',
    reason: 'Resolves each line\'s warehouse and the delivery region. The PO ships from it.',
  },
  {
    column: 'sales_location',
    payloadKey: 'salesLocation',
    label: 'Sales Location',
    cls: 'DERIVED',
    reason: 'Derived from State; re-derived server-side. Callers must omit it.',
  },
  {
    column: 'postcode',
    payloadKey: 'postcode',
    label: 'Postcode',
    cls: 'CONTROLLED',
    reason: 'Printed on the supplier PO as the delivery destination. Resolves nothing.',
  },
  {
    column: 'city',
    payloadKey: 'city',
    label: 'City',
    cls: 'CONTROLLED',
    reason: 'Same as Postcode: part of the PO delivery destination.',
  },
];

/** payloadKeys an amendment may carry, in table order. */
export const soAmendableHeaderKeys = (): string[] =>
  SO_HEADER_FIELD_POLICY.filter((f) => f.cls === 'CONTROLLED').map((f) => f.payloadKey);

/** Columns the server freezes on a processing-locked header PATCH. */
export const soProcessingLockColumns = (): Set<string> =>
  new Set(SO_HEADER_FIELD_POLICY.map((f) => f.column));

/** Classify a payload key. 'FREE' for anything absent from the table — the
    documented default, not a lookup miss. */
export const soHeaderFieldClass = (payloadKey: string): SoFieldClass => {
  const hit = SO_HEADER_FIELD_POLICY.find((f) => f.payloadKey === payloadKey);
  return hit ? hit.cls : 'FREE';
};

/* ── Payments ──────────────────────────────────────────────────────────────
   Owner 2026-07-17: ADDING a payment is FREE — money arrives over time and it
   must be recordable at any point, including after delivery.

   Owner 2026-07-19: a payment row may be EDITED or DELETED only on the day it
   was keyed in ("删除只有在当天才行 ... 当天都可以任意更改"). Same-day entries
   are still fluid because nothing has locked yet; from the next day, no.

   "Same day" keys off the row's CREATION time, not the payment date on the
   document — otherwise editing an old payment's date to today would unlock its
   own deletion. The boundary is MYT midnight; use isCreatedTodayMyt/todayMyt
   from vendor/scm/lib/dates, never a raw UTC date slice.

   The delete/edit CONTROLS must be genuinely ABSENT once the window closes,
   not disabled and not CSS-hidden ("off, not hide"). The server refuses too —
   the missing button is the courtesy, the endpoint is the control.

   Full rationale, and where the deferred bank-reconciliation condition will
   go, live in the backend copy of this file. */

export type PaymentMutationKind = 'ADD' | 'EDIT' | 'DELETE';

export type PaymentRowMutability = {
  mutable: boolean;
  /** Plain-language reason when it may not — shown verbatim. null when it may. */
  problem: string | null;
};

/** Why the control is gone. Operators must be told, not left guessing. */
export const PAYMENT_WINDOW_CLOSED_MESSAGE =
  'This payment can only be changed or removed on the day it was keyed in. That day has passed, '
  + 'so it is now locked. Record a new payment instead, or ask the office to adjust it.';

export const PAYMENT_WINDOW_CLOSED_ERROR = 'payment_edit_locked';

/**
 * The single predicate behind "may this recorded payment still be changed".
 * Server and both clients call this; nothing else decides.
 *
 * Both dates are required strings — no `?? ''` fallback, because an unreadable
 * created_at is an error to surface rather than a value to default into a
 * silent deny or a silent allow.
 */
export const paymentRowMutable = (
  createdDateMyt: string,
  todayDateMyt: string,
  soIsDraft: boolean,
): PaymentRowMutability => {
  if (soIsDraft) return { mutable: true, problem: null };
  if (createdDateMyt === todayDateMyt) return { mutable: true, problem: null };
  return { mutable: false, problem: PAYMENT_WINDOW_CLOSED_MESSAGE };
};

/* ── Delivery-address staleness — A KNOWN GAP, NOT CLOSED HERE ─────────────
   The owner ruled the delivery address FREE-EDIT and that ruling stands. The
   destination IDENTITY (State / City / Postcode) is CONTROLLED, so a change
   there goes through approval. What stays free is the street/unit text
   (address1-4), and changing THAT late does not re-plan an already-scheduled
   delivery trip — the trip holds its own stop, and delivery-planning buckets an
   SO by customer STATE, which did not move. So the driver can still be sent to
   the old street address.

   A warning at the point of edit was considered and NOT shipped, because no SO
   detail surface — desktop, mobile, or the header API — currently carries any
   "this order has a delivery scheduled" signal. Showing the warning
   unconditionally would fire on every address edit including the large majority
   with nothing scheduled, and a warning that is usually wrong is how operators
   learn to dismiss warnings without reading them.

   Closing it properly means surfacing a scheduled-trip flag on the SO header
   (delivery-planning already knows; the SO does not ask) and gating the warning
   on it. That is a real change to the header payload and to delivery-planning's
   read surface, so it is reported for the owner rather than half-built here. */
