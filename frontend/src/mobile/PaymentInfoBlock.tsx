// ----------------------------------------------------------------------------
// PaymentInfoBlock — the ONE presentation of a recorded (persisted) payment's
// details, shared by the confirmed SO detail (MobileSODetail) and the draft SO
// edit view (MobileNewSO).
//
// Owner 2026-07-13: a "Recorded" payment used to render DIFFERENTLY in the
// draft-edit view (a thin "date · raw-enum · amount" box) versus the confirmed
// SO detail (method label + account + collected-by + bank/tenure + online type
// + approval code). This component is the single source for that left-hand info
// block so the two surfaces can never drift again. The amount, slip thumbnail
// and delete affordance stay OUTSIDE this block — they are the same on detail
// and (intentionally read-only) on the draft edit view, which owns their layout.
//
// Uses the shared `.hz-m` theme CSS vars (mobile.css), available under both
// screens' `.hz-m` root, so the block looks identical in either context.
// ----------------------------------------------------------------------------

/** A recorded payment as either surface holds it. Fields are optional so the
 *  draft-edit view's reduced fetch and the detail view's full fetch both fit;
 *  camelCase aliases cover the postgres.js / PostgREST casing drift. */
export type RecordedPaymentLike = {
  method: string | null;
  paid_at: string | null;
  account_sheet?: string | null;
  collected_by_name?: string | null;
  approval_code?: string | null;
  merchant_provider?: string | null;
  installment_months?: number | null;
  online_type?: string | null;
  merchantProvider?: string | null;
  installmentMonths?: number | null;
  onlineType?: string | null;
};

const METHOD_LABELS: Record<string, string> = {
  cash: 'Cash', transfer: 'Online', merchant: 'Merchant', installment: 'Installment',
};
const methodLabel = (m: string | null): string => (m ? METHOD_LABELS[m] ?? m : '—');

/** Short "14 Jun" date, em-dash when empty/unparseable — matches MobileSODetail. */
const dm = (d: string | null | undefined): string => {
  if (!d) return '—';
  const dt = new Date(d);
  if (isNaN(+dt)) return '—';
  return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
};

export function PaymentInfoBlock({ payment }: { payment: RecordedPaymentLike }) {
  const p = payment;
  const bank = p.merchantProvider ?? p.merchant_provider;
  const months = p.installmentMonths ?? p.installment_months;
  const online = p.onlineType ?? p.online_type;
  const meta = [dm(p.paid_at), p.account_sheet, p.collected_by_name]
    .filter((x) => x && String(x).trim())
    .join(' · ');
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--ink)' }}>{methodLabel(p.method)}</div>
      <div className="money" style={{ fontSize: 10.5, color: 'var(--mut)', marginTop: 2 }}>{meta}</div>
      {/* Bank + tenure (Merchant) / online type (Transfer) — parity with desktop
          PaymentsTable. Dual-read camelCase ?? snake_case. */}
      {p.method === 'merchant' && (
        <div className="money" style={{ fontSize: 10, color: 'var(--mut2)' }}>
          {[bank, typeof months === 'number' ? `${months} month${months === 1 ? '' : 's'}` : 'One shot']
            .filter((x) => x && String(x).trim())
            .join(' · ')}
        </div>
      )}
      {p.method === 'transfer' && online ? (
        <div className="money" style={{ fontSize: 10, color: 'var(--mut2)' }}>{online}</div>
      ) : null}
      {p.approval_code ? (
        <div className="money" style={{ fontSize: 10, color: 'var(--mut2)' }}>Approval {p.approval_code}</div>
      ) : null}
    </div>
  );
}
