// SO amendment / revision workflow — pure state machine + guards.
// Port of 2990 packages/shared/src/so-amendment.ts (shipped 2026-07-03).
//
// A supplier-confirmed, two-gate amendment revises a processing-locked SO and its
// bound PO in place. These are the pure transition rules the route handlers import
// (routes/so-amendments.ts) — no DB, no I/O, so client + server share them.

export type AmendStatus = 'REQUESTED'|'SUPPLIER_PENDING'|'SO_APPROVED'|'PO_APPROVED'|'SENT'|'REJECTED';
export type AmendAction = 'supplier-confirm'|'approve-so'|'approve-po'|'send'|'reject';

const FLOW: Record<AmendAction, { from: AmendStatus[]; to: AmendStatus }> = {
  'supplier-confirm': { from: ['REQUESTED'], to: 'SUPPLIER_PENDING' },
  'approve-so':       { from: ['SUPPLIER_PENDING','REQUESTED'], to: 'SO_APPROVED' }, // no-PO light path may skip supplier-confirm
  'approve-po':       { from: ['SO_APPROVED'], to: 'PO_APPROVED' },
  'send':             { from: ['PO_APPROVED'], to: 'SENT' },
  'reject':           { from: ['REQUESTED','SUPPLIER_PENDING','SO_APPROVED','PO_APPROVED'], to: 'REJECTED' },
};

export const canTransition = (s: AmendStatus, a: AmendAction): boolean => FLOW[a].from.includes(s);
export const nextStatus = (s: AmendStatus, a: AmendAction): AmendStatus | null =>
  canTransition(s, a) ? FLOW[a].to : null;

export const receivedFloorViolation = (
  line: { newQty: number | null }, po: { receivedQty: number },
): boolean => line.newQty != null && line.newQty < (po.receivedQty ?? 0);
