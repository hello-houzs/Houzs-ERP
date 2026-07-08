// ----------------------------------------------------------------------------
// PaymentsTable — shared Houzs-pattern payments ledger.
//
// Task #105 — Commander 2026-05-27: "Edit SO 和 New SO 界面一定要一样的啊"
// New SO and Edit SO must render an IDENTICAL Payments section. This component
// was extracted verbatim from SalesOrderDetail.tsx's PaymentCard so both pages
// can reuse it without drift.
//
// Two modes:
//   - SAVED mode  (docNo: string)
//       Uses useSalesOrderPayments / useAddSalesOrderPayment /
//       useDeleteSalesOrderPayment. Each row commit POSTs to
//       /mfg-sales-orders/:docNo/payments.
//   - DRAFT mode  (docNo: null + payments + onChange)
//       Holds payments in caller-supplied local state. No API calls. Used
//       on the New SO page where the docNo doesn't exist until the SO has
//       been created. After the parent POSTs the SO, it replays each draft
//       through POST /:docNo/payments before navigating to the Detail page.
//
// Visuals + columns + method options + label→API enum mapping are identical
// across both modes.
// ----------------------------------------------------------------------------

import { memo, useEffect, useRef, useState, type CSSProperties } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  DollarSign, Plus, Trash2, Save, FileText, Image as ImageIcon,
  Calendar as CalIcon, User as UserIcon, Tag,
} from 'lucide-react';
import { sortByText } from '../lib/sort-options';
import { fetchPaymentSlipUrl, scanPaymentReceipt, type SlipUrlResponse } from '../lib/slip';
import { SlipUploadField } from './SlipUploadField';
import { MoneyInput } from './MoneyInput';
import { DateField } from './DateField';
import { useNotify } from './NotifyDialog';
import { useConfirm } from './ConfirmDialog';
import { todayMyt } from '../lib/dates';
import {
  PAYMENT_METHOD_CODE_TO_VALUE,
  PAYMENT_METHOD_DEFAULT_LABELS,
  paymentMethodCodeForValue,
  type PaymentMethodCode,
} from '@2990s/shared/payment-methods';
import { useAuth } from '../lib/auth';
import { useStaff } from '../lib/admin-queries';
import {
  useSalesOrderPayments,
  useAddSalesOrderPayment,
  useDeleteSalesOrderPayment,
  type SoPayment,
} from '../lib/sales-order-queries';
import {
  useSoDropdownOptions, optionsOrFallback,
} from '../lib/so-dropdown-options-queries';
import detailStyles from '../../../pages/scm-v2/SalesOrderDetail.module.css';
import paymentsStyles from '../../../pages/scm-v2/Payments.module.css';

const fmtRm = (centi: number, currency = 'MYR'): string =>
  `${currency} ${(centi / 100).toLocaleString('en-MY', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;

/* installment_plan "One Shot" option VALUE (spec 1 + 6) — the default plan for
   a Merchant card with no written tenure. Parsed to null months on persist. */
const ONE_SHOT_PLAN = 'One Shot';

/* ════════════════════════════════════════════════════════════════════════
   API enum + Houzs friendly-label mapping (kept verbatim from PaymentCard
   so the Detail page's ledger semantics don't change).
   ════════════════════════════════════════════════════════════════════════ */

export type PaymentMethod = PaymentMethodCode;
/* Bank provider name (now open-ended — sourced from
   so_dropdown_options('payment_merchant'), no longer constrained to the
   legacy 4-bank enum). */
export type MerchantProvider = string;

/* 2026-06-06 payment-method unify (Loo) — the L1 cascade and the POS
   handover cards now share ONE maintenance list (payment_method category,
   locked to four rows whose VALUE is the immutable key):
     Method (L1)    → Merchant | Online | Installment | Cash
       Merchant     → pick Merchant bank + Installment plan
       Online       → pick Online sub-type (Bank Transfer / TNG / Cheque / DuitNow)
       Installment  → pick Installment plan (term in months)
       Cash         → done
   Routing keys off the row VALUE via the shared map — labels are freely
   renameable in SO Maintenance and never affect booking. The cash fallback
   below can only fire on data that predates the API lock. */
export type PaymentMethodLabel = string;

export const labelToApi = (label: PaymentMethodLabel): {
  method: PaymentMethod;
  merchantProvider: MerchantProvider | null;
} => {
  const method = paymentMethodCodeForValue(label);
  if (method) return { method, merchantProvider: null };
  // The payment_method category is locked server-side to the four core
  // values, so an unknown value here means pre-lock drifted data — surface
  // it and fall back to cash so we don't book a card payment as transfer.
  // eslint-disable-next-line no-console
  console.warn(
    `[PaymentsTable] Unknown payment method value "${label}" — falling ` +
    `back to method=cash. Values are locked to Merchant / Online / ` +
    `Installment / Cash (see @2990s/shared/payment-methods).`,
  );
  return { method: 'cash', merchantProvider: null };
};

/* Persisted method code → the maintenance row VALUE (for select rehydrate
   + the locked-set keys). Display labels resolve live from methodOpts. */
const apiToValue = (p: SoPayment): string =>
  PAYMENT_METHOD_CODE_TO_VALUE[p.method] ?? 'Cash';

const methodPillStyle = (m: PaymentMethod): CSSProperties => {
  const bg =
    m === 'merchant'    ? 'rgba(232, 107, 58, 0.12)' :
    m === 'transfer'    ? 'rgba(47, 93, 79, 0.12)'   :
    m === 'installment' ? 'rgba(34, 31, 32, 0.08)'   :
                          'rgba(0, 0, 0, 0.06)';
  const fg =
    m === 'merchant'    ? 'var(--c-burnt)' :
    m === 'transfer'    ? 'var(--c-secondary-a, #2F5D4F)' :
    m === 'installment' ? 'var(--c-ink)' :
                          'var(--fg-muted)';
  return {
    display: 'inline-block',
    fontFamily: 'var(--font-sans)',
    fontSize: 'var(--fs-11)',
    fontWeight: 600,
    padding: '1px 8px',
    borderRadius: 'var(--radius-pill)',
    background: bg,
    color: fg,
    letterSpacing: '0.02em',
  };
};

/* ════════════════════════════════════════════════════════════════════════
   Shared draft row shape — what the inline-editor renders.

   In SAVED mode this is internal state; rows promote to API rows on commit.
   In DRAFT mode the parent owns the array (PaymentDraft[]) so we expose the
   same shape minus the `uid` (parent can derive a key per row).
   ════════════════════════════════════════════════════════════════════════ */

/* Task #122 (cascade) — methodLabel is the L1 pick (Merchant / Online /
   Cash). The three optional sub-fields below carry the L2 picks; only the
   field(s) relevant to the current methodLabel are populated.
     methodLabel = Merchant → merchantProvider + installmentMonthsLabel
     methodLabel = Online   → onlineType
     methodLabel = Cash     → all three sub-fields stay ''
   installmentMonthsLabel is stored verbatim from the dropdown (e.g.
   'One-off', '3 months', '12 months') and parsed to an integer on
   persist (One-off → null/0; 'N months' → N). */
export type PaymentDraft = {
  uid:                      string;
  paidAt:                   string;             // YYYY-MM-DD
  methodLabel:              PaymentMethodLabel;
  merchantProvider:         string;             // L2 bank pick (Merchant only)
  installmentMonthsLabel:   string;             // L2 plan pick (Merchant only)
  onlineType:               string;             // L2 sub-type (Online only)
  amountCenti:              number;
  accountSheet:             string;
  approvalCode:             string;
  collectedBy:              string;             // staff.id (uuid) | ''
  /* Spec D4 (2026-06-06) — committed slip upload session for this row. In
     SAVED mode (SO route) it is REQUIRED before commit; in DRAFT mode it is
     optional and the batching pages (DO / SI / consignment) ignore it. */
  slipUploadSessionId:      string | null;
  /* Bug #3 (2026-06-24) — when this draft was seeded from a card receipt scanned
     in the Scan-Order modal, the receipt's R2 key (scan-slips/…-receipt). The
     receipt IS the slip, so a draft carrying this satisfies the New SO slip-
     required guard without a second upload; SalesOrderNew records it via the SO-
     create deposit fields (which reuse the order-level proof) instead of the
     strict per-payment slip route. '' / undefined for a manually-added row. */
  receiptImageKey?:         string;
};

export const newPaymentDraft = (defaultStaffId = ''): PaymentDraft => ({
  uid: Math.random().toString(36).slice(2, 10),
  paidAt: todayMyt(),
  methodLabel: 'Cash',
  merchantProvider:       '',
  installmentMonthsLabel: '',
  onlineType:             '',
  amountCenti: 0,
  accountSheet: '',
  approvalCode: '',
  collectedBy: defaultStaffId,
  slipUploadSessionId: null,
});

/* Parse an installment-plan label like 'One Shot' / 'One-off' / '3 months' /
   '12 months' into an integer term in months. The one-shot labels and any
   unrecognised string return null (= no installment); otherwise the leading
   number. */
export const parseInstallmentMonths = (label: string): number | null => {
  if (!label || label === 'One-off' || label === ONE_SHOT_PLAN) return null;
  const m = /^(\d+)\s*month/i.exec(label.trim());
  return m ? Number(m[1]) : null;
};

/* Cascade required-field check (spec 1) — returns a human reason when the
   chosen method is missing a required sub-field, else null:
     Merchant → Bank (merchantProvider) AND Plan (installmentMonthsLabel)
     Online   → Sub-Type (onlineType)
     Cash     → nothing
   Keyed off the L1 methodLabel VALUE (Merchant / Online / Cash). Unknown /
   pre-lock labels are treated as Cash (no sub-field), matching labelToApi's
   cash fallback. Shared by the per-row commit gate (SAVED mode) and the New SO
   batch-save guard (DRAFT mode) so both pages enforce the same rule. */
export const missingMethodSubField = (
  d: Pick<PaymentDraft, 'methodLabel' | 'merchantProvider' | 'installmentMonthsLabel' | 'onlineType'>,
): string | null => {
  if (d.methodLabel === 'Merchant') {
    if (!d.merchantProvider) return 'Bank';
    if (!d.installmentMonthsLabel) return 'Plan';
    return null;
  }
  if (d.methodLabel === 'Online') {
    if (!d.onlineType) return 'Sub-Type';
    return null;
  }
  return null;
};

/* Method-scoped L2 fields for a draft row — shared by commitDraft below and
   every page that batches PaymentDraft[] to a payments endpoint (New SO /
   DO / SI / consignment flows), so the installment branch lives in exactly
   one place. */
export const draftMethodFields = (
  method: PaymentMethod,
  d: Pick<PaymentDraft, 'merchantProvider' | 'installmentMonthsLabel' | 'onlineType'>,
): Record<string, unknown> => {
  if (method === 'merchant') {
    return {
      merchantProvider:  d.merchantProvider || null,
      installmentMonths: parseInstallmentMonths(d.installmentMonthsLabel),
    };
  }
  if (method === 'installment') {
    return { installmentMonths: parseInstallmentMonths(d.installmentMonthsLabel) };
  }
  if (method === 'transfer') {
    return { onlineType: d.onlineType || null };
  }
  return {};
};

/* ════════════════════════════════════════════════════════════════════════
   Props — discriminated union on `docNo`.
   - docNo: string   → SAVED mode (mutations + remote fetch)
   - docNo: null     → DRAFT mode (caller-owned state)
   ════════════════════════════════════════════════════════════════════════ */

type SavedModeProps = {
  docNo: string;
  /** Grand total used to compute the Balance summary at the bottom. */
  grandTotalCenti: number;
  currency?: string;
  /** When true, hides Add Payment + per-row trash/save controls. */
  locked?: boolean;
  /** Optional payment-slip column (Wei Siang 2026-06-06). When provided, a
   *  "Slip" column is rendered immediately LEFT of "Collected By", showing the
   *  order's POS-handover payment slip thumbnail (one slip per order — the same
   *  proof backs each payment row). Only the Sales Order detail passes this; the
   *  DO / SI tables that also use PaymentsTable leave it unset and are unchanged. */
  slip?: { slipKey: string | null; fetcher: (id: string) => Promise<SlipUrlResponse> };
};

type DraftModeProps = {
  docNo: null;
  payments: PaymentDraft[];
  onChange: (next: PaymentDraft[]) => void;
  grandTotalCenti: number;
  currency?: string;
  locked?: boolean;
  /** Render the per-draft slip uploader (SO-route batching only — the SO payments
   *  endpoint requires a slip per payment; DO/SI endpoints don't accept one). */
  slipUpload?: boolean;
};

export type PaymentsTableProps = SavedModeProps | DraftModeProps;

/* ════════════════════════════════════════════════════════════════════════
   Per-payment slip thumbnail (Spec D4, migration 0159).

   Per-payment slip (0159) first; legacy rows fall back to the order slip
   (Wei Siang's 2026-06-06 column semantics). The per-row slip (blob object
   URL via the Worker proxy) is fetched lazily and only when the row actually
   carries a slip_key.
   ════════════════════════════════════════════════════════════════════════ */
const PaymentSlipThumb = ({ docNo, payment, orderSlipUrl, orderSlipType }: {
  docNo: string;
  payment: SoPayment;
  orderSlipUrl: string | null;
  orderSlipType: string;
}) => {
  const perRowQ = useQuery({
    queryKey: ['payment-slip', payment.id],
    enabled: Boolean(payment.slip_key),
    // Houzs proxy deviation: fetchPaymentSlipUrl now returns a blob object URL
    // (no 5-min presign expiry); the staleTime just bounds re-fetch churn.
    staleTime: 4 * 60 * 1000,
    queryFn: () => fetchPaymentSlipUrl(docNo, payment.id),
  });
  const url = payment.slip_key ? (perRowQ.data?.url ?? null) : orderSlipUrl;
  const contentType = payment.slip_key ? (perRowQ.data?.contentType ?? 'image/jpeg') : orderSlipType;
  if (!url) return <span className={detailStyles.muted}>—</span>;
  if (contentType.startsWith('image/')) {
    return (
      <a href={url} target="_blank" rel="noreferrer" title="Open payment slip">
        <img src={url} alt="Slip" style={{ width: 34, height: 34, objectFit: 'cover', borderRadius: 4, border: '1px solid var(--line)', display: 'block' }} />
      </a>
    );
  }
  return <a href={url} target="_blank" rel="noreferrer" style={{ fontSize: 'var(--fs-11)', color: 'var(--c-burnt)' }}>PDF</a>;
};

/* ════════════════════════════════════════════════════════════════════════
   Component.
   ════════════════════════════════════════════════════════════════════════ */

const PaymentsTableInner = (props: PaymentsTableProps) => {
  const notify = useNotify();
  const askConfirm = useConfirm();
  const currency = props.currency ?? 'MYR';
  const grandTotal = props.grandTotalCenti ?? 0;
  const locked = props.locked ?? false;

  const staffQ = useStaff();
  const staff  = staffQ.data ?? [];
  const auth   = useAuth();

  /* Task #118 — methods are DB-backed (so_dropdown_options 'payment_method',
     locked to the four core rows since the 2026-06-06 unify). Falls back to
     FALLBACK_OPTIONS during loading + when the DB has zero rows so the user
     never sees an empty select.

     Task #122 (cascade) — three additional categories for the L2 picks
     under Merchant / Online / Installment. */
  const methodOptsQ      = useSoDropdownOptions('payment_method');
  const methodOpts       = optionsOrFallback('payment_method', methodOptsQ.data);
  const merchantOptsQ    = useSoDropdownOptions('payment_merchant');
  const merchantOpts     = optionsOrFallback('payment_merchant', merchantOptsQ.data);
  const onlineOptsQ      = useSoDropdownOptions('online_type');
  const onlineOpts       = optionsOrFallback('online_type', onlineOptsQ.data);
  const installmentOptsQ = useSoDropdownOptions('installment_plan');
  const installmentOpts  = optionsOrFallback('installment_plan', installmentOptsQ.data);

  /* ── SAVED MODE hooks (always called — TanStack Query lazily skips
        when enabled=false). docNo is non-null in SAVED mode. ──────────── */
  const isSaved = props.docNo !== null;
  const paymentsQ     = useSalesOrderPayments(isSaved ? props.docNo : null);
  const addPayment    = useAddSalesOrderPayment();
  const deletePayment = useDeleteSalesOrderPayment();

  /* SAVED-mode local drafts (pre-commit rows). DRAFT mode uses parent's
     `payments` array directly. */
  const [savedDrafts, setSavedDrafts] = useState<PaymentDraft[]>([]);

  const persistedPayments: SoPayment[] = isSaved ? (paymentsQ.data ?? []) : [];
  const drafts: PaymentDraft[] = isSaved ? savedDrafts : (props as DraftModeProps).payments;

  /* Latest drafts mirror — the receipt-scan handler resolves asynchronously
     (a late scan can land after the operator has kept typing), so it must read
     each row's CURRENT values by uid, never the values captured when the scan
     was fired. This ref is kept in sync with `drafts` every render. */
  const draftsRef = useRef<PaymentDraft[]>(drafts);
  draftsRef.current = drafts;

  /* Default Collected By → current logged-in staff. Nick 2026-07-09:
     "Collect By needs default user" — the row was landing empty when
     auth.staff resolved AFTER the staff dropdown, since the previous
     check filtered the id out when it wasn't found in the active list
     yet. Relax to: always return auth.staff?.id when auth has it,
     regardless of whether staff has loaded. If the id turns out to
     match no active staff, the dropdown falls through to '—' at render
     time — but the common case (owner / staff clicking Add Payment on
     their own account) now defaults reliably.
     Existing persisted payments still show their stored `collected_by`
     name — this default only seeds NEW draft rows. */
  const defaultStaffId = auth.staff?.id ?? '';

  const addDraft = () => {
    /* Loo 2026-06-09 — seed the new row's amount with the OUTSTANDING balance
       (grand total − already paid − amounts on other in-flight rows) so a full
       balance payment is one click. On SO create the first row defaults to the
       full total; a split second row defaults to the remainder. Mirrors the POS
       Record-payment drawer + handover default. */
    const paidNow =
      persistedPayments.reduce((s, p) => s + (p.amount_centi || 0), 0) +
      drafts.reduce((s, dr) => s + (dr.amountCenti || 0), 0);
    const outstanding = Math.max(0, grandTotal - paidNow);
    const d = { ...newPaymentDraft(defaultStaffId), amountCenti: outstanding };
    if (isSaved) {
      setSavedDrafts((prev) => [...prev, d]);
    } else {
      (props as DraftModeProps).onChange([...(props as DraftModeProps).payments, d]);
    }
  };

  const patchDraft = (uid: string, patch: Partial<PaymentDraft>) => {
    if (isSaved) {
      setSavedDrafts((prev) => prev.map((d) => d.uid === uid ? { ...d, ...patch } : d));
    } else {
      const cur = (props as DraftModeProps).payments;
      (props as DraftModeProps).onChange(
        cur.map((d) => d.uid === uid ? { ...d, ...patch } : d),
      );
    }
  };

  const removeDraft = (uid: string) => {
    if (isSaved) {
      setSavedDrafts((prev) => prev.filter((d) => d.uid !== uid));
    } else {
      const cur = (props as DraftModeProps).payments;
      (props as DraftModeProps).onChange(cur.filter((d) => d.uid !== uid));
    }
  };

  /* Receipt OCR fill (card-terminal / EPP slip). Fired by SlipUploadField when
     an IMAGE is uploaded to a row's slip — the receipt IS the slip. Reads the
     row's CURRENT state by uid (draftsRef) and fills ONLY blank fields, so a
     late scan never clobbers anything the operator already typed. Method maps
     to the locked payment_method VALUE: Merchant → bank; Online → online type;
     Installment → tenure plan; Cash → nothing. Owner convention: a card EPP
     receipt comes back as method=Installment + the N-month plan.

     UI: SUCCESS is SILENT — the visible feedback is the fields populating
     themselves; we render NOTHING in the narrow Slip column (the reason the
     last version was reverted). Only a hard scan FAILURE surfaces a brief
     in-app notice so the operator knows to fill manually; that notice is the
     shared modal (never rendered inside the Slip cell). Best-effort — a
     failure changes no fields. */
  const scanReceiptIntoRow = async (uid: string, file: File): Promise<void> => {
    let rec;
    try {
      rec = await scanPaymentReceipt(file);
    } catch {
      void notify({ title: 'Could not read receipt', body: 'Fill the payment fields manually.', tone: 'info' });
      return;
    }
    const row = draftsRef.current.find((d) => d.uid === uid);
    if (!row) return;

    /* 3-method model (spec 1 + 2) — a card-terminal receipt is always a
       Merchant payment (drop the legacy Installment carve-out: a bank EPP is
       Merchant + an N-month plan). Fold any legacy "Installment" match to
       Merchant so a stale backend never seeds a dropped method. */
    const rawMethod = rec.paymentMethodMatch?.value ?? '';
    const method = rawMethod === 'Installment' ? 'Merchant' : rawMethod;
    const patch: Partial<PaymentDraft> = {};
    // methodLabel ← payment_method VALUE (only when the row still holds the
    // default 'Cash' OR is blank — i.e. the operator hasn't deliberately set it).
    if (method && (row.methodLabel === '' || row.methodLabel === 'Cash')) {
      patch.methodLabel = method;
    }
    // The method the row WILL have once this patch applies (so the L2 fills are
    // gated against the post-patch method, not the stale one).
    const effectiveMethod = patch.methodLabel ?? row.methodLabel;
    if (effectiveMethod === 'Merchant') {
      // Bank (merchant_provider).
      if (rec.bankMatch?.value && !row.merchantProvider) {
        patch.merchantProvider = rec.bankMatch.value;
      }
      // Plan (installment_months) — a matched tenure (e.g. AEON 12 Months) wins;
      // a Merchant swipe with NO tenure on the receipt → "One Shot" (spec 6).
      if (!row.installmentMonthsLabel) {
        patch.installmentMonthsLabel = rec.installmentPlanMatch?.value || ONE_SHOT_PLAN;
      }
    }
    if (effectiveMethod === 'Online' && rec.onlineTypeMatch?.value && !row.onlineType) {
      patch.onlineType = rec.onlineTypeMatch.value;
    }
    if (rec.approvalCode && !row.approvalCode) {
      patch.approvalCode = rec.approvalCode;
    }
    if (rec.amountRm != null && rec.amountRm > 0 && row.amountCenti <= 0) {
      patch.amountCenti = Math.round(rec.amountRm * 100);
    }
    /* paid_at ← the receipt's swipe date (spec 2). THIS MAY BE A PAST DATE —
       the salesperson can open the SO days after collecting the money — so we
       set it verbatim and never clamp to today. Only fills when the row still
       holds the default todayMyt() value (the operator hasn't set a date). */
    if (rec.paidAt && (row.paidAt === '' || row.paidAt === todayMyt())) {
      patch.paidAt = rec.paidAt;
    }

    if (Object.keys(patch).length > 0) patchDraft(uid, patch);
  };

  /* SAVED mode commit — fire POST /:docNo/payments. DRAFT mode has no
     commit affordance; the parent batches them at SO-create time. */
  const commitDraft = (d: PaymentDraft) => {
    if (!isSaved) return;
    /* Spec D4 — a SAVED-mode (SO route) payment is rejected by the API
       without a slip; gate the commit on both the amount and a confirmed
       slip upload session so the user never round-trips a 400. */
    if (d.amountCenti <= 0 || !d.slipUploadSessionId) return;
    /* Cascade guard (spec 1) — block the commit when the chosen method is
       missing a required sub-field (Merchant → Bank + Plan; Online → Sub-Type)
       and tell the operator which one. */
    const missing = missingMethodSubField(d);
    if (missing) {
      void notify({
        title: `Pick the ${missing} for this ${d.methodLabel} payment.`,
        tone: 'error',
      });
      return;
    }
    const { method } = labelToApi(d.methodLabel);
    /* Cascade payload — populate sub-fields by the L1 method only
       (draftMethodFields). The API mirrors the same guard and will scrub any
       irrelevant sub-fields (e.g. a stale onlineType left over from a
       Merchant→Online toggle). */
    const body: Record<string, unknown> = {
      docNo:           (props as SavedModeProps).docNo,
      paidAt:          d.paidAt,
      method,
      amountCenti:     d.amountCenti,
      accountSheet:    d.accountSheet || null,
      approvalCode:    d.approvalCode || null,
      collectedBy:     d.collectedBy  || null,
      uploadSessionId: d.slipUploadSessionId,
      ...draftMethodFields(method, d),
    };
    addPayment.mutate(body as { docNo: string } & Record<string, unknown>, {
      onSuccess: () => removeDraft(d.uid),
      onError: (e) => {
        // eslint-disable-next-line no-console
        console.error('[payment] add failed:', e);
        notify({ title: 'Failed to save payment', body: e instanceof Error ? e.message : String(e), tone: 'error' });
      },
    });
  };

  /* Summary maths — identical across modes. In DRAFT mode there are no
     persisted rows yet, so paid is just Σ drafts. In SAVED mode paid is
     Σ persisted (drafts only enter the total once committed via API). */
  const paidCenti = isSaved
    ? persistedPayments.reduce((sum, p) => sum + (p.amount_centi || 0), 0)
    : drafts.reduce((sum, d) => sum + (d.amountCenti || 0), 0);
  const balanceCenti = Math.max(0, grandTotal - paidCenti);

  const staffNameById = (id: string | null): string | null => {
    if (!id) return null;
    return staff.find((s) => s.id === id)?.name ?? null;
  };

  /* Persisted row → display label. Resolves the live maintenance label for
     the row's method (so a rename in SO Maintenance re-labels history too);
     falls back to the shared defaults. */
  const methodDisplay = (p: SoPayment): string => {
    const value = apiToValue(p);
    return methodOpts.find((m) => m.value === value)?.label
      ?? PAYMENT_METHOD_DEFAULT_LABELS[p.method as PaymentMethodCode]
      ?? value;
  };

  const totalRowCount = persistedPayments.length + drafts.length;

  /* Optional payment-slip column. One slip per order, so we fetch it once and
     render the same proof thumbnail on each persisted row, in a "Slip" column
     immediately left of Collected By. */
  const slipProp = isSaved ? (props as SavedModeProps).slip : undefined;
  /* Show the Slip column when the order prop is passed (SO detail) OR when any
     persisted row carries its own per-payment slip (Spec D4). DO/SI tables
     pass no prop and their payments have no slip_key, so they stay unchanged. */
  const showSlip = Boolean(slipProp) || persistedPayments.some((p) => p.slip_key);
  const [slipUrl, setSlipUrl] = useState<string | null>(null);
  const [slipType, setSlipType] = useState<string>('image/jpeg');
  useEffect(() => {
    if (!isSaved || !slipProp?.slipKey) { setSlipUrl(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const r = await slipProp.fetcher((props as SavedModeProps).docNo);
        if (!cancelled) { setSlipUrl(r.url); setSlipType(r.contentType); }
      } catch { if (!cancelled) setSlipUrl(null); }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSaved, slipProp?.slipKey]);

  /* 8-column override when the Slip column is shown. Nick 2026-07-09:
     the previous 1040px min-width forced a horizontal scrollbar even on
     wide desktop viewports, so the whole row wouldn't fit at a glance
     ("间隔太远 需要缩小一些 一页看完"). Tightened every track by ~20%
     and dropped min-width to 800px so the grid fits inside a typical
     ~960-1000px SCM detail body without scrolling; when the aside
     drawer is open, the scroll wrapper still lets the tail nudge into
     view without clipping the Slip cell.
     New sum: 112+116+92+104+104+52+128+28 = 736px of track. */
  const gridStyle: CSSProperties | undefined = showSlip
    ? {
        gridTemplateColumns:
          '112px 116px minmax(92px, 0.9fr) minmax(104px, 1fr) minmax(104px, 1fr) 52px 128px 28px',
        minWidth: 800,
      }
    : undefined;

  return (
    <section className={detailStyles.card}>
      <header className={detailStyles.cardHeader}>
        <h2 className={detailStyles.cardTitle}>
          <DollarSign size={14} strokeWidth={1.75} /> Payments
        </h2>
      </header>
      <div className={detailStyles.cardBody}>
        <div className={paymentsStyles.section}>
          {/* Top bar with + Add Payment trigger ─────────────────────── */}
          <div className={paymentsStyles.head}>
            <span className={paymentsStyles.headLabel}>
              {totalRowCount} transaction{totalRowCount === 1 ? '' : 's'}
            </span>
            {!locked && (
              <button
                type="button"
                className={paymentsStyles.addBtn}
                onClick={addDraft}
                disabled={isSaved && addPayment.isPending}
              >
                <Plus size={14} strokeWidth={1.75} />
                Add Payment
              </button>
            )}
          </div>

          {/* Transactions table ──────────────────────────────────────── */}
          {/* Bug #4 — OUTER scroll wrapper: the wide slip-mode grid scrolls
              horizontally INSIDE the overflow:hidden card instead of being
              clipped at the right edge. overflow lives on the wrapper, the
              min-width on the inner .grid (must be different elements). */}
          <div className={paymentsStyles.gridScroll}>
          <div className={paymentsStyles.grid} style={gridStyle}>
            {/* Header row */}
            <span className={paymentsStyles.headerCell}>
              Date <CalIcon size={12} strokeWidth={1.75} />
            </span>
            <span className={paymentsStyles.headerCell}>
              Payment Method <Tag size={12} strokeWidth={1.75} />
            </span>
            <span className={paymentsStyles.headerCellRight}>
              Amount <DollarSign size={12} strokeWidth={1.75} />
            </span>
            <span className={paymentsStyles.headerCell}>
              Account Sheet <FileText size={12} strokeWidth={1.75} />
            </span>
            <span className={paymentsStyles.headerCell}>
              Approval Code <FileText size={12} strokeWidth={1.75} />
            </span>
            {showSlip && (
              <span className={paymentsStyles.headerCell}>
                Slip <ImageIcon size={12} strokeWidth={1.75} />
              </span>
            )}
            <span className={paymentsStyles.headerCell}>
              Collected By <UserIcon size={12} strokeWidth={1.75} />
            </span>
            <span className={paymentsStyles.headerCell} />

            {/* Empty + loading states */}
            {isSaved && paymentsQ.isLoading && (
              <span className={paymentsStyles.emptyRow} style={{ gridColumn: '1 / -1' }}>
                Loading…
              </span>
            )}
            {(!isSaved || !paymentsQ.isLoading) &&
              persistedPayments.length === 0 &&
              drafts.length === 0 && (
              <span className={paymentsStyles.emptyRow} style={{ gridColumn: '1 / -1' }}>
                No payments recorded yet · click "Add Payment" to log a deposit
              </span>
            )}

            {/* Persisted payment rows (SAVED mode only) */}
            {persistedPayments.map((p) => (
              <div className={paymentsStyles.row} key={p.id}>
                <span className={paymentsStyles.cell} data-label="Date" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {p.paid_at}
                </span>
                <span className={paymentsStyles.cell} data-label="Method" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
                  <span className={paymentsStyles.methodPill} style={methodPillStyle(p.method)}>
                    {methodDisplay(p)}
                  </span>
                  {/* Task #122 (cascade) — surface the L2 picks below the
                      pill so a Merchant row reads as "Merchant · MBB · 12
                      months", an Online row as "Online · TNG", an
                      Installment row as "Installment · 12m". */}
                  {p.method === 'merchant' && (p.merchant_provider || p.installment_months) && (
                    <span style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>
                      {p.merchant_provider ?? '—'}
                      {p.installment_months ? ` · ${p.installment_months}m` : ''}
                    </span>
                  )}
                  {p.method === 'transfer' && p.online_type && (
                    <span style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>
                      {p.online_type}
                    </span>
                  )}
                  {p.method === 'installment' && (p.merchant_provider || p.installment_months) && (
                    <span style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>
                      {p.merchant_provider ? `${p.merchant_provider} · ` : ''}
                      {p.installment_months ? `${p.installment_months}m` : ''}
                    </span>
                  )}
                  {/* Approval code — parity with mobile MobileSODetail. Dual-read
                      camelCase ?? snake_case. */}
                  {(((p as unknown as { approvalCode?: string | null }).approvalCode ?? p.approval_code)) && (
                    <span style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>
                      Approval {(p as unknown as { approvalCode?: string | null }).approvalCode ?? p.approval_code}
                    </span>
                  )}
                </span>
                <span className={paymentsStyles.cellRight} data-label="Amount"
                      style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                  {fmtRm(p.amount_centi, currency)}
                </span>
                <span className={paymentsStyles.cell} data-label="Account Sheet">
                  {p.account_sheet ?? <span className={detailStyles.muted}>—</span>}
                </span>
                <span className={paymentsStyles.cell} data-label="Approval Code" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {p.approval_code ?? <span className={detailStyles.muted}>—</span>}
                </span>
                {showSlip && (
                  <span className={paymentsStyles.cell} data-label="Slip">
                    {isSaved ? (
                      <PaymentSlipThumb
                        docNo={(props as SavedModeProps).docNo}
                        payment={p}
                        orderSlipUrl={slipUrl}
                        orderSlipType={slipType}
                      />
                    ) : (
                      <span className={detailStyles.muted}>—</span>
                    )}
                  </span>
                )}
                <span className={paymentsStyles.cell} data-label="Collected By">
                  {p.collected_by_name ?? staffNameById(p.collected_by) ?? <span className={detailStyles.muted}>—</span>}
                </span>
                <span className={paymentsStyles.cell}>
                  {!locked && (
                    <button
                      type="button"
                      className={paymentsStyles.trashBtn}
                      disabled={deletePayment.isPending}
                      onClick={async () => {
                        if (await askConfirm({
                          title: `Delete this ${methodDisplay(p)} payment of ${fmtRm(p.amount_centi, currency)}?`,
                          confirmLabel: 'Delete',
                          danger: true,
                        })) {
                          deletePayment.mutate({ docNo: (props as SavedModeProps).docNo, id: p.id });
                        }
                      }}
                      title="Remove payment"
                    >
                      <Trash2 size={14} strokeWidth={1.75} />
                    </button>
                  )}
                </span>
              </div>
            ))}

            {/* In-flight draft rows (SAVED + DRAFT) */}
            {drafts.map((d) => (
              <div className={paymentsStyles.row} key={d.uid}>
                <span className={paymentsStyles.cell} data-label="Date">
                  <DateField
                    className={paymentsStyles.inlineInput}
                    value={d.paidAt ?? ''}
                    disabled={locked}
                    onChange={(iso) => patchDraft(d.uid, { paidAt: iso })}
                  />
                </span>
                <span className={paymentsStyles.cell} data-label="Method" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
                  {/* L1 — Method (always visible) */}
                  <select
                    className={paymentsStyles.inlineSelect}
                    value={d.methodLabel}
                    disabled={locked}
                    onChange={(e) => {
                      /* When Method changes, clear the L2 fields that
                         don't apply to the new pick. Keeps stale data
                         out of the API call + the audit log. */
                      const next = e.target.value;
                      patchDraft(d.uid, {
                        methodLabel: next,
                        merchantProvider:       next === 'Merchant' ? d.merchantProvider : '',
                        installmentMonthsLabel: next === 'Merchant' || next === 'Installment'
                          ? d.installmentMonthsLabel : '',
                        onlineType:             next === 'Online'   ? d.onlineType       : '',
                      });
                    }}
                  >
                    {methodOpts.map((m) => (
                      <option key={m.id} value={m.value}>{m.label}</option>
                    ))}
                    {/* Persist labels that are no longer active in the
                        list so existing drafts (rehydrated from
                        somewhere) still render their selection. */}
                    {d.methodLabel && !methodOpts.some((m) => m.value === d.methodLabel) && (
                      <option value={d.methodLabel}>{d.methodLabel}</option>
                    )}
                  </select>

                  {/* L2 — Merchant cascade: pick the Bank + Installment plan. */}
                  {d.methodLabel === 'Merchant' && (
                    <>
                      <select
                        className={paymentsStyles.inlineSelect}
                        style={{ fontSize: 'var(--fs-11)' }}
                        value={d.merchantProvider}
                        disabled={locked}
                        onChange={(e) => patchDraft(d.uid, { merchantProvider: e.target.value })}
                        aria-label="Merchant bank"
                      >
                        <option value="">— Bank —</option>
                        {merchantOpts.map((m) => (
                          <option key={m.id} value={m.value}>{m.label}</option>
                        ))}
                        {d.merchantProvider && !merchantOpts.some((m) => m.value === d.merchantProvider) && (
                          <option value={d.merchantProvider}>{d.merchantProvider}</option>
                        )}
                      </select>
                      <select
                        className={paymentsStyles.inlineSelect}
                        style={{ fontSize: 'var(--fs-11)' }}
                        value={d.installmentMonthsLabel}
                        disabled={locked}
                        onChange={(e) => patchDraft(d.uid, { installmentMonthsLabel: e.target.value })}
                        aria-label="Installment plan"
                      >
                        <option value="">— Plan —</option>
                        {installmentOpts.map((m) => (
                          <option key={m.id} value={m.value}>{m.label}</option>
                        ))}
                        {d.installmentMonthsLabel && !installmentOpts.some((m) => m.value === d.installmentMonthsLabel) && (
                          <option value={d.installmentMonthsLabel}>{d.installmentMonthsLabel}</option>
                        )}
                      </select>
                    </>
                  )}

                  {/* L2 — Online cascade: pick the sub-type. */}
                  {d.methodLabel === 'Online' && (
                    <select
                      className={paymentsStyles.inlineSelect}
                      style={{ fontSize: 'var(--fs-11)' }}
                      value={d.onlineType}
                      disabled={locked}
                      onChange={(e) => patchDraft(d.uid, { onlineType: e.target.value })}
                      aria-label="Online sub-type"
                    >
                      <option value="">— Type —</option>
                      {onlineOpts.map((o) => (
                        <option key={o.id} value={o.value}>{o.label}</option>
                      ))}
                      {d.onlineType && !onlineOpts.some((o) => o.value === d.onlineType) && (
                        <option value={d.onlineType}>{d.onlineType}</option>
                      )}
                    </select>
                  )}

                  {/* L2 — Installment cascade: pick the plan (term). */}
                  {d.methodLabel === 'Installment' && (
                    <select
                      className={paymentsStyles.inlineSelect}
                      style={{ fontSize: 'var(--fs-11)' }}
                      value={d.installmentMonthsLabel}
                      disabled={locked}
                      onChange={(e) => patchDraft(d.uid, { installmentMonthsLabel: e.target.value })}
                      aria-label="Installment plan"
                    >
                      <option value="">— Plan —</option>
                      {installmentOpts.map((m) => (
                        <option key={m.id} value={m.value}>{m.label}</option>
                      ))}
                      {d.installmentMonthsLabel && !installmentOpts.some((m) => m.value === d.installmentMonthsLabel) && (
                        <option value={d.installmentMonthsLabel}>{d.installmentMonthsLabel}</option>
                      )}
                    </select>
                  )}

                  {/* L2 — Cash: no extra fields */}
                </span>
                <span className={paymentsStyles.cellRight} data-label="Amount">
                  <MoneyInput
                    bare allowBlank
                    valueSen={d.amountCenti === 0 ? null : d.amountCenti}
                    inputClassName={paymentsStyles.inlineInputRight}
                    placeholder="0"
                    disabled={locked}
                    onCommit={(sen) => patchDraft(d.uid, { amountCenti: sen ?? 0 })}
                  />
                </span>
                <span className={paymentsStyles.cell} data-label="Account Sheet">
                  <input
                    type="text"
                    className={`${paymentsStyles.inlineInput} ${paymentsStyles.placeholderHint}`}
                    placeholder="e.g. AKHC 3809"
                    value={d.accountSheet}
                    disabled={locked}
                    onChange={(e) => patchDraft(d.uid, { accountSheet: e.target.value })}
                  />
                </span>
                <span className={paymentsStyles.cell} data-label="Approval Code">
                  <input
                    type="text"
                    className={paymentsStyles.inlineInput}
                    value={d.approvalCode}
                    disabled={locked}
                    onChange={(e) => patchDraft(d.uid, { approvalCode: e.target.value })}
                  />
                </span>
                {showSlip && (
                  <span className={paymentsStyles.cell} data-label="Slip">
                    {/* Spec D4 — per-payment slip uploader. SAVED mode (SO
                        route) REQUIRES it; the commit button stays disabled
                        until a slip is confirmed. */}
                    <SlipUploadField
                      required={isSaved}
                      disabled={locked}
                      onConfirmed={(sid) => patchDraft(d.uid, { slipUploadSessionId: sid })}
                      onCleared={() => patchDraft(d.uid, { slipUploadSessionId: null })}
                      onImageScan={(file) => scanReceiptIntoRow(d.uid, file)}
                    />
                  </span>
                )}
                <span className={paymentsStyles.cell} data-label="Collected By">
                  <select
                    className={paymentsStyles.inlineInputUser}
                    value={d.collectedBy}
                    disabled={locked}
                    onChange={(e) => patchDraft(d.uid, { collectedBy: e.target.value })}
                  >
                    <option value="">—</option>
                    {sortByText(staff.filter((s) => s.active)).map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </span>
                <span className={paymentsStyles.cell}>
                  <div style={{ display: 'flex', gap: 2, justifyContent: 'flex-end', alignItems: 'center' }}>
                    {/* DRAFT mode slip uploader — opt-in via slipUpload prop.
                        Only the SO-route batching page (SalesOrderNew) sets
                        slipUpload; DO / SI / consignment pages do NOT, so their
                        tables render no uploader (the endpoint doesn't accept
                        one). Required-marked ("Slip *") when rendered here. */}
                    {!isSaved && (props as DraftModeProps).slipUpload && (
                      <SlipUploadField
                        required
                        disabled={locked}
                        onConfirmed={(sid) => patchDraft(d.uid, { slipUploadSessionId: sid })}
                        onCleared={() => patchDraft(d.uid, { slipUploadSessionId: null })}
                        onImageScan={(file) => scanReceiptIntoRow(d.uid, file)}
                      />
                    )}
                    {/* SAVED mode shows the Save (commit) button next to
                        Discard. DRAFT mode has no Save — the parent batches
                        all drafts on SO-create. We still show Discard so the
                        user can drop a half-typed row. */}
                    {isSaved && (() => {
                      /* Spec D4 — commit needs an amount AND a confirmed slip
                         (the SO route 400s without one). Spec 1 — a chosen
                         method also needs its required sub-field(s). */
                      const noAmount = d.amountCenti <= 0;
                      const noSlip   = !d.slipUploadSessionId;
                      const missing  = missingMethodSubField(d);
                      const blocked  = noAmount || noSlip || missing !== null;
                      const title = noAmount
                        ? 'Enter an amount > 0 first'
                        : noSlip
                          ? 'Upload the payment slip first'
                          : missing
                            ? `Pick the ${missing} for this ${d.methodLabel} payment first`
                            : 'Save payment';
                      return (
                        <button
                          type="button"
                          onClick={() => commitDraft(d)}
                          disabled={locked || addPayment.isPending || blocked}
                          title={title}
                          style={{
                            background: 'transparent', border: 'none', padding: 4,
                            cursor: blocked ? 'not-allowed' : 'pointer',
                            color: blocked ? 'var(--fg-muted)' : 'var(--c-secondary-a, #2F5D4F)',
                          }}
                        >
                          <Save size={14} strokeWidth={1.75} />
                        </button>
                      );
                    })()}
                    <button
                      type="button"
                      className={paymentsStyles.trashBtn}
                      onClick={() => removeDraft(d.uid)}
                      title="Discard"
                      disabled={locked}
                    >
                      <Trash2 size={14} strokeWidth={1.75} />
                    </button>
                  </div>
                </span>
              </div>
            ))}
          </div>
          </div>

          {/* ── Summary (Deposit Paid + Balance) ────────────────────── */}
          <div className={paymentsStyles.summary}>
            <span className={paymentsStyles.summaryLabel}>
              Deposit Paid <DollarSign size={12} strokeWidth={1.75} />
            </span>
            <span className={paymentsStyles.summaryValueAccent}>
              {fmtRm(paidCenti, currency)}
            </span>
            <span className={paymentsStyles.summaryLabel}>
              Balance <DollarSign size={12} strokeWidth={1.75} />
            </span>
            <span className={balanceCenti > 0 ? paymentsStyles.balanceOutstanding : paymentsStyles.balanceClear}>
              {fmtRm(balanceCenti, currency)}
              {grandTotal > 0 && paidCenti >= grandTotal && (
                <span style={{ marginLeft: 8, fontSize: 'var(--fs-11)' }}>· PAID</span>
              )}
            </span>
          </div>
        </div>
      </div>
    </section>
  );
};

export const PaymentsTable = memo(PaymentsTableInner) as typeof PaymentsTableInner;
