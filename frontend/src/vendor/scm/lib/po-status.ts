// Purchase Order status display — relabels the stored PO status enum into the
// receipt vocabulary the commander asked for (Wei Siang 2026-05-31: "应该叫作
// Received、Partially Received", NOT "Convert").
//
// Unlike the SO status (which doesn't auto-advance on delivery and needs a live
// delivery_state overlay — see so-status.ts), the PO status enum ALREADY
// auto-detects receipt progress: recomputePoReceived flips
// SUBMITTED → PARTIALLY_RECEIVED → RECEIVED from the GRN received_qty rollup on
// every goods receipt. So this is a pure display relabel — nothing is manually
// selectable; the operator only ever raises GRs and the status follows.
//   SUBMITTED          → "Confirmed"           (no goods received yet — unified with SO's first-active label)
//   PARTIALLY_RECEIVED → "Partially Received"  (some qty received into a GR)
//   RECEIVED           → "Received"            (every line fully received)
//   CANCELLED          → "Cancelled"

import type { PoStatus } from './suppliers-queries';

export const PO_STATUS_LABEL: Record<PoStatus, string> = {
  SUBMITTED: 'Confirmed',
  PARTIALLY_RECEIVED: 'Partially Received',
  RECEIVED: 'Received',
  CANCELLED: 'Cancelled',
};

export function poStatusLabel(status: PoStatus): string {
  return PO_STATUS_LABEL[status] ?? status.replace(/_/g, ' ');
}
