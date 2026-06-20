// HOUZS VENDOR STUB — ScanOrderModal.
//
// The real 2990 component (apps/backend/src/components/ScanOrderModal.tsx, ~670
// lines) is the handwritten showroom-slip OCR flow that prefills a NEW Sales
// Order. That belongs to the SalesOrderNew configurator wave (explicitly
// deferred — SoFromProducts / SalesOrderNew come later), so it is stubbed here:
// the SO list's "Scan Order" button opens this notice instead of the OCR
// pipeline. Replace with the verbatim component when the SO-create wave lands
// (it needs the /scan-* OCR endpoints + ScanOrderModal.module.css).

import { X } from 'lucide-react';
import { Button } from '@2990s/design-system';

/* HOUZS VENDOR — the OCR pipeline is stubbed, but SalesOrderNew imports the
   sessionStorage handoff key + the prefill payload shape (it reads
   ?fromScan=1 and seeds the form from sessionStorage). These are copied
   verbatim from the source so the create page compiles + still consumes a
   prefill if one is ever written by a future real ScanOrderModal. */
export const SCAN_PREFILL_KEY = 'soScanPrefill';
export type ScanPrefillLine = {
  itemCode:       string;        // '' when no SKU picked — operator fills in the form
  itemGroup:      string;        // 'sofa' | 'bedframe' | 'mattress' | 'accessory' | 'service' | 'others'
  description:    string;
  qty:            number;
  unitPriceCenti: number;        // RM handwriting × 100, rounded
  remark:         string;        // rawText + notes so nothing on the slip is lost
};
export type ScanPrefillPayment = {
  methodValue:      string;
  bankValue:        string;        // payment_merchant value ('' = none)
  installmentLabel: string;        // installment_plan value, e.g. '12 months'
  onlineTypeValue:  string;        // online_type value ('' = none)
  depositCenti:     number;        // deposit on slip ×100 (0 = operator fills)
};
export type ScanPrefill = {
  customerName:   string;
  phone:          string;        // first phone, raw string
  address1:       string;
  note:           string;        // remarks + location + extra phones + non-date delivery text
  deliveryDate:   string | null; // only when a clean YYYY-MM-DD
  processingDate: string | null;
  customerType:   string;        // customer_type value matched to SO Maintenance ('' = none)
  buildingType:   string;        // building_type value matched to SO Maintenance ('' = none)
  payment:        ScanPrefillPayment | null;
  lines:          ScanPrefillLine[];
};

export function ScanOrderModal({ onClose }: { onClose: () => void }) {
  return (
    <div
      onClick={onClose}
      role="presentation"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.28)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 92, padding: 'var(--space-4)',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        style={{
          background: 'var(--c-paper)', border: '1px solid var(--line-strong)',
          borderRadius: 'var(--radius-xl)', boxShadow: 'var(--shadow-3)',
          width: 'min(440px, 95vw)', padding: 'var(--space-5)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-3)' }}>
          <h2 style={{ fontFamily: 'var(--font-title)', fontWeight: 700, fontSize: 'var(--fs-18, 18px)', color: 'var(--c-ink)', margin: 0 }}>
            Scan Order
          </h2>
          <button type="button" onClick={onClose} title="Close" style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--c-ink)' }}>
            <X size={18} strokeWidth={1.75} />
          </button>
        </div>
        <p style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-13)', color: 'var(--c-ink)', lineHeight: 1.5, margin: '0 0 var(--space-4)' }}>
          Handwritten-slip scanning prefills a new Sales Order. It ships with the
          Sales Order create flow in a later wave and is not available yet.
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button variant="primary" size="md" onClick={onClose}>Got it</Button>
        </div>
      </div>
    </div>
  );
}
