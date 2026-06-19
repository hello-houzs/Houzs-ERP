// ----------------------------------------------------------------------------
// PaymentsTable — multi-row payment-draft editor for the SO create flow.
//
// Ported from 2990's PaymentsTable.tsx (DRAFT mode) and rebuilt in Houzs
// Tailwind primitives. NO 2990 CSS modules / design-system.
//
// Each row carries: payment date + method (L1) + the method-scoped L2 pick
// (merchant bank + installment plan | online sub-type | none) + amount (RM↔sen)
// + an approval / reference code. The parent owns the array (PaymentDraft[]).
//
// BACKEND CONSTRAINT (deviation from 2990): the SCM POST /mfg-sales-orders
// books payments slip-less ONLY through the legacy header fields
// (paymentMethod + merchantProvider + installmentMonths + approvalCode +
// paymentDate + depositCenti), which records ONE deposit ledger row. The
// strict `payments[]` array path AND POST /:docNo/payments BOTH require a
// per-payment slip (uploadSessionId), and SCM mounts NO slip-upload endpoint.
// So this editor supports multiple draft rows for data entry, but the parent
// serialises them to the single legacy deposit (method = first row, deposit =
// Σ rows) and warns when rows disagree on method. See draftsToCreatePayment().
//
// Method values are hardcoded here (SCM mounts no so-dropdown-options route);
// they mirror 2990's locked four-method vocabulary (Cash / Card(merchant) /
// Online(transfer) / Installment) and map to the API enum via methodToApi().
// ----------------------------------------------------------------------------

import { Plus, Trash2, DollarSign } from "lucide-react";
import { Field } from "./Suppliers";
import { fmtCenti } from "../../lib/scm";

const TODAY = new Date().toISOString().slice(0, 10);

// ── API enum mapping (mirrors 2990's payment-methods locked vocabulary) ──────
// The label is what the operator sees; `api` is the mfg_sales_order_payments
// method enum the backend stores ('cash' | 'merchant' | 'transfer' |
// 'installment').
export type PaymentApiMethod = "cash" | "merchant" | "transfer" | "installment";

export const PAYMENT_METHODS: { label: string; api: PaymentApiMethod }[] = [
  { label: "Cash", api: "cash" },
  { label: "Card", api: "merchant" },
  { label: "Online Transfer", api: "transfer" },
  { label: "Installment", api: "installment" },
];

// L2 option pools (hardcoded — no so-dropdown-options endpoint in SCM, same
// reason the customer/building-type arrays are hardcoded on the create page).
export const MERCHANT_BANKS = ["Maybank", "CIMB", "Public Bank", "RHB", "Hong Leong", "AmBank"];
export const INSTALLMENT_PLANS = ["One-off", "6 months", "12 months", "24 months", "36 months"];
export const ONLINE_TYPES = ["Bank Transfer", "TNG", "DuitNow", "Cheque"];

export interface PaymentDraft {
  uid: string;
  paidAt: string; // YYYY-MM-DD
  method: PaymentApiMethod;
  merchantProvider: string; // L2 bank pick (merchant only)
  installmentPlan: string; // L2 plan label (merchant / installment)
  onlineType: string; // L2 sub-type (transfer only)
  amountCenti: number;
  approvalCode: string;
}

let pmCounter = 0;
export function newPaymentDraft(): PaymentDraft {
  pmCounter += 1;
  return {
    uid: `pm${pmCounter}-${Math.random().toString(36).slice(2, 7)}`,
    paidAt: TODAY,
    method: "cash",
    merchantProvider: "",
    installmentPlan: "",
    onlineType: "",
    amountCenti: 0,
    approvalCode: "",
  };
}

/** Parse an installment-plan label ('One-off' / 'N months') → integer term in
 *  months. 'One-off' / unrecognised → null. */
export function parseInstallmentMonths(label: string): number | null {
  if (!label || label === "One-off") return null;
  const m = /^(\d+)\s*month/i.exec(label.trim());
  return m && m[1] ? Number(m[1]) : null;
}

export interface CreatePaymentFields {
  depositCenti: number;
  paymentMethod?: PaymentApiMethod;
  merchantProvider?: string;
  installmentMonths?: number;
  approvalCode?: string;
  paymentDate?: string;
  /** True when rows disagree on method — the parent surfaces a warning so the
   *  operator knows only the primary method is booked on the header. */
  mixedMethods: boolean;
}

/** Collapse the draft rows into the legacy single-deposit create-body fields.
 *  deposit = Σ amounts; method/bank/plan/approval/date come from the FIRST
 *  amount-bearing row (the primary). `mixedMethods` flags split rows with
 *  differing methods so the parent can warn (the backend slip-less path can
 *  only book one method). Returns null when no row carries an amount. */
export function draftsToCreatePayment(
  drafts: PaymentDraft[],
): CreatePaymentFields | null {
  const paying = drafts.filter((d) => d.amountCenti > 0);
  if (paying.length === 0) return null;
  const depositCenti = paying.reduce((s, d) => s + d.amountCenti, 0);
  const primary = paying[0]!;
  const mixedMethods = paying.some(
    (d) =>
      d.method !== primary.method ||
      d.merchantProvider !== primary.merchantProvider ||
      d.installmentPlan !== primary.installmentPlan,
  );
  const merchantLike = primary.method === "merchant" || primary.method === "installment";
  const installmentMonths = merchantLike
    ? parseInstallmentMonths(primary.installmentPlan) ?? undefined
    : undefined;
  return {
    depositCenti,
    paymentMethod: primary.method,
    merchantProvider:
      primary.method === "merchant" ? primary.merchantProvider || undefined : undefined,
    installmentMonths: installmentMonths ?? undefined,
    approvalCode: primary.approvalCode.trim() || undefined,
    paymentDate: primary.paidAt || undefined,
    mixedMethods,
  };
}

const inputCls =
  "h-9 w-full rounded-md border border-border bg-surface px-2.5 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-accent focus:ring-2 focus:ring-accent/20";

interface PaymentsTableProps {
  drafts: PaymentDraft[];
  onChange: (next: PaymentDraft[]) => void;
  grandTotalCenti: number;
  /** Remove-row confirmation (dialog.confirm) — owned by the parent so this
   *  component stays presentational and never calls window.confirm. */
  onRemoveRow: (uid: string) => void;
}

export function PaymentsTable({
  drafts,
  onChange,
  grandTotalCenti,
  onRemoveRow,
}: PaymentsTableProps) {
  function patch(uid: string, p: Partial<PaymentDraft>) {
    onChange(drafts.map((d) => (d.uid === uid ? { ...d, ...p } : d)));
  }

  function addRow() {
    // Seed the new row's amount with the outstanding balance so a single
    // full-deposit row is one click (mirrors 2990's addDraft default).
    const paid = drafts.reduce((s, d) => s + (d.amountCenti || 0), 0);
    const outstanding = Math.max(0, grandTotalCenti - paid);
    onChange([...drafts, { ...newPaymentDraft(), amountCenti: outstanding }]);
  }

  const paidCenti = drafts.reduce((s, d) => s + (d.amountCenti || 0), 0);
  const balanceCenti = Math.max(0, grandTotalCenti - paidCenti);

  return (
    <div className="mb-5 rounded-lg border border-border bg-surface p-5 shadow-stone">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="h-px w-3 bg-accent/60" />
          <h3 className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
            Payments
          </h3>
          <span className="text-[11px] normal-case text-ink-muted">
            · {drafts.length} transaction{drafts.length === 1 ? "" : "s"}
          </span>
        </div>
        <button
          type="button"
          onClick={addRow}
          className="inline-flex items-center gap-1.5 rounded-md border border-accent/50 px-2.5 py-1.5 text-[12px] font-semibold text-accent transition-colors hover:bg-accent-soft"
        >
          <Plus size={14} /> Add Payment
        </button>
      </div>

      {drafts.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-[12px] text-ink-muted">
          No payments recorded yet — click "Add Payment" to log a deposit.
        </p>
      ) : (
        <div className="space-y-3">
          {drafts.map((d) => {
            const methodLabel =
              PAYMENT_METHODS.find((m) => m.api === d.method)?.label ?? d.method;
            return (
              <div
                key={d.uid}
                className="rounded-md border border-border-subtle bg-surface-dim/30 p-3"
              >
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <Field label="Date">
                    <input
                      type="date"
                      className={inputCls}
                      value={d.paidAt}
                      onChange={(e) => patch(d.uid, { paidAt: e.target.value })}
                    />
                  </Field>
                  <Field label="Method">
                    <select
                      className={inputCls}
                      value={d.method}
                      onChange={(e) => {
                        const next = e.target.value as PaymentApiMethod;
                        // Clear L2 fields that don't apply to the new method so
                        // stale picks never reach the create body.
                        patch(d.uid, {
                          method: next,
                          merchantProvider:
                            next === "merchant" ? d.merchantProvider : "",
                          installmentPlan:
                            next === "merchant" || next === "installment"
                              ? d.installmentPlan
                              : "",
                          onlineType: next === "transfer" ? d.onlineType : "",
                        });
                      }}
                      aria-label="Payment method"
                    >
                      {PAYMENT_METHODS.map((m) => (
                        <option key={m.api} value={m.api}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Amount (RM)">
                    <input
                      type="number"
                      step="0.01"
                      min={0}
                      className={`${inputCls} text-right font-mono`}
                      value={d.amountCenti === 0 ? "" : (d.amountCenti / 100).toFixed(2)}
                      onChange={(e) =>
                        patch(d.uid, {
                          amountCenti: Math.round(Number(e.target.value) * 100) || 0,
                        })
                      }
                      placeholder="0.00"
                      aria-label={`Amount for ${methodLabel}`}
                    />
                  </Field>
                  <Field label="Approval / Ref">
                    <input
                      className={inputCls}
                      value={d.approvalCode}
                      onChange={(e) => patch(d.uid, { approvalCode: e.target.value })}
                      placeholder="e.g. approval code"
                    />
                  </Field>

                  {/* L2 — Card (merchant): bank + installment plan */}
                  {d.method === "merchant" && (
                    <>
                      <Field label="Bank">
                        <select
                          className={inputCls}
                          value={d.merchantProvider}
                          onChange={(e) =>
                            patch(d.uid, { merchantProvider: e.target.value })
                          }
                          aria-label="Merchant bank"
                        >
                          <option value="">— Bank —</option>
                          {MERCHANT_BANKS.map((b) => (
                            <option key={b} value={b}>
                              {b}
                            </option>
                          ))}
                          {d.merchantProvider &&
                            !MERCHANT_BANKS.includes(d.merchantProvider) && (
                              <option value={d.merchantProvider}>
                                {d.merchantProvider}
                              </option>
                            )}
                        </select>
                      </Field>
                      <Field label="Installment Plan">
                        <select
                          className={inputCls}
                          value={d.installmentPlan}
                          onChange={(e) =>
                            patch(d.uid, { installmentPlan: e.target.value })
                          }
                          aria-label="Installment plan"
                        >
                          <option value="">— Plan —</option>
                          {INSTALLMENT_PLANS.map((p) => (
                            <option key={p} value={p}>
                              {p}
                            </option>
                          ))}
                        </select>
                      </Field>
                    </>
                  )}

                  {/* L2 — Installment: plan only */}
                  {d.method === "installment" && (
                    <Field label="Installment Plan">
                      <select
                        className={inputCls}
                        value={d.installmentPlan}
                        onChange={(e) =>
                          patch(d.uid, { installmentPlan: e.target.value })
                        }
                        aria-label="Installment plan"
                      >
                        <option value="">— Plan —</option>
                        {INSTALLMENT_PLANS.map((p) => (
                          <option key={p} value={p}>
                            {p}
                          </option>
                        ))}
                      </select>
                    </Field>
                  )}

                  {/* L2 — Online transfer: sub-type. Display-only on create —
                      the slip-less header path stores no online_type column, so
                      this annotates the row for the operator but isn't sent. */}
                  {d.method === "transfer" && (
                    <Field label="Transfer Type">
                      <select
                        className={inputCls}
                        value={d.onlineType}
                        onChange={(e) => patch(d.uid, { onlineType: e.target.value })}
                        aria-label="Online transfer type"
                      >
                        <option value="">— Type —</option>
                        {ONLINE_TYPES.map((o) => (
                          <option key={o} value={o}>
                            {o}
                          </option>
                        ))}
                      </select>
                    </Field>
                  )}
                </div>

                <div className="mt-2 flex justify-end">
                  <button
                    type="button"
                    onClick={() => onRemoveRow(d.uid)}
                    className="inline-flex items-center gap-1 rounded p-1 text-[11px] font-semibold text-ink-muted transition-colors hover:bg-err/5 hover:text-err"
                    title="Remove this payment row"
                  >
                    <Trash2 size={13} /> Remove
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Summary */}
      <div className="mt-4 flex flex-col items-end gap-1 border-t border-border-subtle pt-3 text-[13px]">
        <div className="flex w-full max-w-xs items-center justify-between text-ink-secondary">
          <span className="inline-flex items-center gap-1">
            <DollarSign size={12} /> Deposit Paid
          </span>
          <span className="font-mono font-semibold text-accent">
            {fmtCenti(paidCenti)}
          </span>
        </div>
        <div className="flex w-full max-w-xs items-center justify-between text-ink-secondary">
          <span>Balance</span>
          <span
            className={`font-mono font-semibold ${
              balanceCenti > 0 ? "text-ink" : "text-synced"
            }`}
          >
            {fmtCenti(balanceCenti)}
            {grandTotalCenti > 0 && paidCenti >= grandTotalCenti && (
              <span className="ml-1.5 text-[11px]">· PAID</span>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}
