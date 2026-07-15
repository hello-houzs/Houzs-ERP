// ----------------------------------------------------------------------------
// DeliveryOrderNew — full-page Create DO at /scm/delivery-orders/new.
//
// Replaces the old window.confirm() "Issue Delivery Order" dialog. This is an
// SO-style editable Create form (clone of SalesOrderNew): the same Customer /
// Delivery Info / Emergency / Delivery Address cards + SoLineCard list +
// PaymentsTable in DRAFT mode.
//
// Prefill: when navigated with ?fromSo=<SO docNo>, it fetches the SO header +
// items + payments and seeds EVERY field (debtor, salesperson/agent, address,
// phone, line items with variants + prices, AND payment records) so the
// operator can review/edit before Saving to create the DO. Without ?fromSo it
// is a blank Create-DO form.
//
// On Save: POST /delivery-orders-mfg (header + items), then replay the payment
// drafts through POST /:id/payments before navigating to the new DO detail.
// ----------------------------------------------------------------------------

import { todayMyt } from '../../vendor/scm/lib/dates';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRightLeft, ChevronDown, Plus, Save, X } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { PhoneInput } from '../../vendor/scm/components/PhoneInput';
import { DateField } from '../../vendor/scm/components/DateField';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import {
  useCreateMfgDeliveryOrder, useAddDeliveryOrderPayment,
  useMfgSalesOrderDetail, useSalesOrderPayments,
} from '../../vendor/scm/lib/delivery-order-queries';
import { useStaff } from '../../vendor/scm/lib/admin-queries';
import { useDrivers } from '../../vendor/scm/lib/drivers-queries';
import { sortByText, sortByNumeric } from '../../vendor/scm/lib/sort-options';
import {
  useLocalities, distinctStates, citiesInState, postcodesInCity,
} from '../../vendor/scm/lib/localities-queries';
import {
  useSoDropdownOptions, optionsOrFallback,
} from '../../vendor/scm/lib/so-dropdown-options-queries';
import { SoLineCard, emptySoLine, type SoLineDraft } from '../../vendor/scm/components/SoLineCard';
import { canonicalizeVariants } from '@2990s/shared';
import {
  PaymentsTable, labelToApi, draftMethodFields, type PaymentDraft,
} from '../../vendor/scm/components/PaymentsTable';
import styles from './SalesOrderDetail.module.css';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

type DraftLine = SoLineDraft & { rid: string };

const newLine = (): DraftLine => ({
  ...emptySoLine(),
  rid: `l${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
});

const fmtRm = (centi: number, currency = 'MYR'): string =>
  `${currency} ${(centi / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const DeliveryOrderNew = () => {
  const navigate = useNavigate();
  const notify = useNotify();
  const [searchParams] = useSearchParams();
  const fromSo = searchParams.get('fromSo');
  const fromPicks = searchParams.get('fromPicks') === '1';

  const create = useCreateMfgDeliveryOrder();
  const addPayment = useAddDeliveryOrderPayment();
  const staffQ = useStaff();
  const driversQ = useDrivers();
  const loc = useLocalities();

  // Prefill source — the SO this DO is being issued from (if any).
  const soDetail = useMfgSalesOrderDetail(fromSo);
  const soPayments = useSalesOrderPayments(fromSo);

  const customerTypeOptsQ = useSoDropdownOptions('customer_type');
  const buildingTypeOptsQ = useSoDropdownOptions('building_type');
  const relationshipOptsQ = useSoDropdownOptions('relationship');
  const customerTypeOpts = optionsOrFallback('customer_type', customerTypeOptsQ.data);
  const buildingTypeOpts = optionsOrFallback('building_type', buildingTypeOptsQ.data);
  const relationshipOpts = optionsOrFallback('relationship', relationshipOptsQ.data);

  // ── Customer ──
  const [debtorCode, setDebtorCode] = useState('');
  const [debtorName, setDebtorName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [salespersonId, setSalespersonId] = useState('');
  const [customerType, setCustomerType] = useState('');
  const [customerSoNo, setCustomerSoNo] = useState('');

  // ── Delivery info ──
  const [doDate, setDoDate] = useState(() => todayMyt());
  const [driverId, setDriverId] = useState('');
  const [driverName, setDriverName] = useState('');
  const [vehicle, setVehicle] = useState('');
  const [buildingType, setBuildingType] = useState('');
  const [venue, setVenue] = useState('');
  const [venueId, setVenueId] = useState('');
  const [expectedDeliveryAt, setExpectedDeliveryAt] = useState('');
  const [customerDeliveryDate, setCustomerDeliveryDate] = useState('');
  const [note, setNote] = useState('');

  // ── Address ──
  const [address1, setAddress1] = useState('');
  const [address2, setAddress2] = useState('');
  const [state, setState] = useState('');
  const [city, setCity] = useState('');
  const [postcode, setPostcode] = useState('');
  const [salesLocation, setSalesLocation] = useState('');
  const [branding, setBranding] = useState('');

  // ── Emergency ──
  const [emergencyName, setEmergencyName] = useState('');
  const [emergencyRel, setEmergencyRel] = useState('');
  const [emergencyPhone, setEmergencyPhone] = useState('');

  // ── Items + payments ──
  const [lines, setLines] = useState<DraftLine[]>(() => [newLine()]);
  const [paymentDrafts, setPaymentDrafts] = useState<PaymentDraft[]>([]);

  /* Prefill from the SO once its detail + payments load. Guarded so we only
     seed once (when the form is still pristine) — re-fetches don't clobber
     the operator's edits. */
  const [prefilled, setPrefilled] = useState(false);
  useEffect(() => {
    if (!fromSo || prefilled) return;
    const so = soDetail.data?.salesOrder as Record<string, unknown> | undefined;
    const soItems = (soDetail.data?.items as Array<Record<string, unknown>> | undefined) ?? [];
    if (!so) return;

    setDebtorCode((so.debtor_code as string) ?? '');
    setDebtorName((so.debtor_name as string) ?? '');
    setPhone((so.phone as string) ?? '');
    setEmail((so.email as string) ?? '');
    setSalespersonId((so.salesperson_id as string) ?? '');
    setCustomerType((so.customer_type as string) ?? '');
    setCustomerSoNo((so.customer_so_no as string) ?? '');
    setBuildingType((so.building_type as string) ?? '');
    setVenue((so.venue as string) ?? '');
    setVenueId((so.venue_id as string) ?? '');
    setExpectedDeliveryAt((so.customer_delivery_date as string) ?? '');
    setCustomerDeliveryDate((so.customer_delivery_date as string) ?? '');
    setNote((so.note as string) ?? '');
    setAddress1((so.address1 as string) ?? '');
    setAddress2((so.address2 as string) ?? '');
    setState((so.customer_state as string) ?? '');
    setCity((so.city as string) ?? '');
    setPostcode((so.postcode as string) ?? '');
    setSalesLocation((so.sales_location as string) ?? '');
    setBranding((so.branding as string) ?? '');
    setEmergencyName((so.emergency_contact_name as string) ?? '');
    setEmergencyRel((so.emergency_contact_relationship as string) ?? '');
    setEmergencyPhone((so.emergency_contact_phone as string) ?? '');

    // Line items.
    //  • From the SO-line picker (fromPicks): the operator has already chosen
    //    exactly which lines + quantities to deliver — possibly across several
    //    same-customer Sales Orders — so the lines come from that picked set,
    //    not from this one SO's items.
    //  • Direct from a single SO (?fromSo only): carry every line that still has
    //    an undelivered balance, seeded with its REMAINING qty.
    if (fromPicks) {
      let stash: Array<Record<string, unknown>> = [];
      try {
        stash = JSON.parse(sessionStorage.getItem('doFromSoPicks') ?? '[]');
      } catch { stash = []; }
      if (Array.isArray(stash) && stash.length > 0) {
        setLines(stash.map((it, i) => ({
          ...emptySoLine(),
          rid: `l${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${i}`,
          itemCode: (it.itemCode as string) ?? '',
          itemGroup: (it.itemGroup as string) ?? 'others',
          description: (it.description as string) ?? '',
          uom: (it.uom as string) ?? 'UNIT',
          qty: Number(it.qty ?? 1),
          unitPriceCenti: Number(it.unitPriceCenti ?? 0),
          discountCenti: Number(it.discountCenti ?? 0),
          unitCostCenti: Number(it.unitCostCenti ?? 0),
          variants: canonicalizeVariants((it.itemGroup as string) ?? 'others', (it.variants as Record<string, unknown>) ?? {}),
          remark: '',
          soItemId: (it.soItemId as string) ?? undefined,
        } as DraftLine & { soItemId?: string })));
      }
      sessionStorage.removeItem('doFromSoPicks');
    } else if (soItems.length > 0) {
      setLines(soItems
        .filter((it) => !it.cancelled && Number(it.remaining_qty ?? it.qty ?? 0) > 0)
        .map((it) => ({
          ...emptySoLine(),
          rid: `l${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${String(it.id)}`,
          itemCode: (it.item_code as string) ?? '',
          itemGroup: (it.item_group as string) ?? 'others',
          description: (it.description as string) ?? '',
          uom: (it.uom as string) ?? 'UNIT',
          qty: Number(it.remaining_qty ?? it.qty ?? 1),
          unitPriceCenti: Number(it.unit_price_centi ?? 0),
          discountCenti: Number(it.discount_centi ?? 0),
          unitCostCenti: Number(it.unit_cost_centi ?? 0),
          variants: canonicalizeVariants((it.item_group as string) ?? 'others', (it.variants as Record<string, unknown>) ?? {}),
          remark: (it.remark as string) ?? '',
          soItemId: (it.id as string) ?? undefined,
        } as DraftLine & { soItemId?: string })));
    }

    // Payment records — map SO payments to PaymentsTable drafts. Skipped on the
    // picker path: a multi-SO delivery has no single SO's payments to copy, and
    // the auto-convert path it replaces never copied payments either.
    const pays = fromPicks ? [] : (soPayments.data ?? []);
    if (pays.length > 0) {
      setPaymentDrafts(pays.map((p) => {
        const methodLabel = p.method === 'cash' ? 'Cash' : p.method === 'transfer' ? 'Online' : 'Merchant';
        const installmentLabel = p.installment_months && p.installment_months > 0 ? `${p.installment_months} months` : '';
        return {
          uid: `so-${p.id}`,
          paidAt: p.paid_at,
          methodLabel,
          merchantProvider: p.merchant_provider ?? '',
          installmentMonthsLabel: installmentLabel,
          onlineType: p.online_type ?? '',
          amountCenti: p.amount_centi,
          accountSheet: p.account_sheet ?? '',
          approvalCode: p.approval_code ?? '',
          collectedBy: p.collected_by ?? '',
          // Copied SO payments become fresh DO drafts; DO route needs no slip.
          slipUploadSessionId: null,
        };
      }));
    }

    setPrefilled(true);
  }, [fromSo, fromPicks, prefilled, soDetail.data, soPayments.data]);

  const staffList = useMemo(() => (staffQ.data ?? []).filter((s) => s.active), [staffQ.data]);
  const drivers = driversQ.data ?? [];

  const locRows = useMemo(() => loc.data ?? [], [loc.data]);
  const states = useMemo(() => distinctStates(locRows), [locRows]);
  const cities = useMemo(() => (state ? citiesInState(locRows, state) : []), [locRows, state]);
  const postcodes = useMemo(() => ((state && city) ? postcodesInCity(locRows, state, city) : []), [locRows, state, city]);

  const updateLine = (rid: string, patch: Partial<SoLineDraft>) =>
    setLines((prev) => prev.map((l) => (l.rid === rid ? { ...l, ...patch } : l)));
  const addLine = () => setLines((prev) => [...prev, newLine()]);
  const dropLine = (rid: string) => setLines((prev) => prev.filter((l) => l.rid !== rid));

  const subtotalCenti = useMemo(
    () => lines.reduce((s, l) => s + Math.max(0, l.qty * l.unitPriceCenti - l.discountCenti), 0),
    [lines],
  );

  const canSave = debtorName.trim().length > 0;

  const flushPaymentDrafts = async (id: string): Promise<{ failed: number }> => {
    if (paymentDrafts.length === 0) return { failed: 0 };
    const tasks = paymentDrafts
      .filter((d) => d.amountCenti > 0)
      .map(async (d) => {
        const { method } = labelToApi(d.methodLabel);
        const body: { id: string } & Record<string, unknown> = {
          id,
          paidAt: d.paidAt,
          method,
          amountCenti: d.amountCenti,
          accountSheet: d.accountSheet || null,
          approvalCode: d.approvalCode || null,
          collectedBy: d.collectedBy || null,
        };
        Object.assign(body, draftMethodFields(method, d));
        try { await addPayment.mutateAsync(body); return true; }
        catch (e) {
          // eslint-disable-next-line no-console
          console.error('[do-payment] post failed for new DO:', e);
          return false;
        }
      });
    const results = await Promise.all(tasks);
    return { failed: results.filter((ok) => !ok).length };
  };

  const onSave = (asDraft = false) => {
    if (loadingPrefill) { notify({ title: 'Still loading the Sales Order', body: 'please wait a moment.' }); return; }
    if (!canSave) { notify({ title: 'Customer name is required.', tone: 'error' }); return; }
    const validLines = lines.filter((l) => l.itemCode.trim() && l.qty > 0);
    if (validLines.length === 0) {
      notify({ title: 'Add at least one item via "+ Add Line Item".', tone: 'error' });
      return;
    }

    create.mutate(
      {
        /* DRAFT flow (2026-06-24) — asDraft lands the DO as DRAFT (no stock OUT,
           no SO-delivered sync) so the operator can review before shipping. */
        asDraft: asDraft || undefined,
        soDocNo: fromSo || undefined,
        doDate: doDate || undefined,
        debtorName,
        debtorCode: debtorCode || undefined,
        phone: phone || undefined,
        email: email || undefined,
        salespersonId: salespersonId || undefined,
        customerType: customerType || undefined,
        customerSoNo: customerSoNo || undefined,
        buildingType: buildingType || undefined,
        venue: venue || undefined,
        venueId: venueId || undefined,
        branding: branding || undefined,
        driverId: driverId || undefined,
        driverName: driverName || undefined,
        vehicle: vehicle || undefined,
        address1: address1 || undefined,
        address2: address2 || undefined,
        customerState: state || undefined,
        state: state || undefined,
        city: city || undefined,
        postcode: postcode || undefined,
        salesLocation: salesLocation || undefined,
        expectedDeliveryAt: expectedDeliveryAt || undefined,
        customerDeliveryDate: customerDeliveryDate || undefined,
        emergencyContactName: emergencyName || undefined,
        emergencyContactRelationship: emergencyRel || undefined,
        emergencyContactPhone: emergencyPhone || undefined,
        note: note || undefined,
        items: validLines.map((l) => ({
          itemGroup: l.itemGroup,
          itemCode: l.itemCode,
          description: l.description,
          uom: l.uom,
          qty: l.qty,
          unitPriceCenti: l.unitPriceCenti,
          discountCenti: l.discountCenti,
          unitCostCenti: l.unitCostCenti,
          variants: l.variants,
          soItemId: (l as DraftLine & { soItemId?: string }).soItemId,
        })),
      },
      {
        onSuccess: async (res: { id: string; doNumber: string }) => {
          const { failed } = await flushPaymentDrafts(res.id);
          if (failed > 0) {
            await notify({
              title: `Delivery order ${res.doNumber} was created, but ${failed} payment ` +
                `row${failed === 1 ? '' : 's'} failed to save. Please re-enter ` +
                `${failed === 1 ? 'it' : 'them'} on the Detail page.`,
              tone: 'error',
            });
          }
          navigate(`/scm/delivery-orders/${res.id}`);
        },
        onError: (err) => {
          const raw = err instanceof Error ? err.message : String(err);
          /* Operator declined the "Ship anyway?" short-stock prompt (the hook
             re-throws the original 409) — they chose not to ship, so swallow
             the raw payload instead of dumping it. */
          if (raw.includes('"short_stock"')) return;
          /* Operator declined the "Ship as drop-ship?" prompt — they chose not
             to ship, so swallow the no-batch payload instead of showing an error. */
          if (raw.includes('"sofa_no_batch"')) return;
          notify({ title: 'Save failed', body: raw, tone: 'error' });
        },
      },
    );
  };

  const loadingPrefill = Boolean(fromSo) && !prefilled && (soDetail.isLoading || soPayments.isLoading);

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div className={styles.titleBlock}>
          <Link to="/scm/delivery-orders" className={styles.backBtn}>
            <ArrowLeft {...ICON} /> <span>Delivery Orders</span>
          </Link>
          <h1 className={styles.title}>
            New Delivery Order{fromSo ? ` — from ${fromSo}` : ''}
          </h1>
        </div>
        <div className={styles.actions}>
          {/* Pull lines from a Sales Order — mirrors New GRN's "From Purchase Order". */}
          <Button variant="ghost" size="md" onClick={() => navigate('/scm/delivery-orders/from-so')}>
            <ArrowRightLeft {...ICON} /> From Sales Order
          </Button>
          <Button variant="ghost" size="md" onClick={() => navigate('/scm/delivery-orders')}>
            <X {...ICON} /> Cancel
          </Button>
          {/* DRAFT flow — save without shipping (no stock OUT). Confirm later on
              the detail page to deduct stock + ship. */}
          <Button variant="ghost" size="md" onClick={() => onSave(true)} disabled={create.isPending}>
            <Save {...ICON} />
            {create.isPending ? 'Saving…' : 'Save as Draft'}
          </Button>
          <Button variant="primary" size="md" onClick={() => onSave(false)} disabled={create.isPending}>
            <Save {...ICON} />
            {create.isPending ? 'Saving…' : 'Create Delivery Order'}
          </Button>
        </div>
      </div>

      {loadingPrefill && (
        <div className={styles.bannerWarn} style={{ background: 'var(--c-cream)', border: '1px solid var(--line)', color: 'var(--fg-muted)' }}>
          Loading {fromSo}…
        </div>
      )}

      {/* ── CUSTOMER ── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}><h2 className={styles.cardTitle}>Customer</h2></header>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <label className={styles.field} style={{ gridColumn: 'span 3' }}>
              <span className={`${styles.fieldLabel} ${styles.fieldLabelReq}`}>Customer Name <span className={styles.req}>*</span></span>
              <input className={styles.fieldInput} value={debtorName}
                onChange={(e) => setDebtorName(e.target.value)} placeholder="e.g. Lim Mei Hua" required />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Customer SO Ref</span>
              <input className={styles.fieldInput} value={customerSoNo}
                placeholder="Their PO / SO number" onChange={(e) => setCustomerSoNo(e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Phone</span>
              <PhoneInput className={styles.fieldInput} value={phone} onChange={setPhone} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Email</span>
              <input type="email" className={styles.fieldInput} value={email}
                onChange={(e) => setEmail(e.target.value)} placeholder="customer@example.com" />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Customer Type</span>
              <span className={styles.selectWrap}>
                <select className={styles.fieldSelect} value={customerType} onChange={(e) => setCustomerType(e.target.value)}>
                  <option value="">—</option>
                  {customerTypeOpts.map((t) => <option key={t.id} value={t.value}>{t.label}</option>)}
                  {customerType && !customerTypeOpts.some((t) => t.value === customerType) && <option value={customerType}>{customerType}</option>}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Salesperson</span>
              <span className={styles.selectWrap}>
                <select className={styles.fieldSelect} value={salespersonId} onChange={(e) => setSalespersonId(e.target.value)}>
                  <option value="">— Pick staff —</option>
                  {sortByText(staffList).map((s) => <option key={s.id} value={s.id}>{s.name} ({s.staffCode})</option>)}
                  {salespersonId && !staffList.some((s) => s.id === salespersonId) && <option value={salespersonId}>(former staff)</option>}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
          </div>
        </div>
      </section>

      {/* ── DELIVERY INFO ── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}><h2 className={styles.cardTitle}>Delivery Info</h2></header>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>DO Date</span>
              <DateField fullWidth className={styles.fieldInput} value={doDate ?? ''}
                onChange={(iso) => setDoDate(iso)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Driver</span>
              <span className={styles.selectWrap}>
                <select className={styles.fieldSelect} value={driverId}
                  onChange={(e) => {
                    const d = drivers.find((x) => x.id === e.target.value);
                    setDriverId(e.target.value);
                    setDriverName(d?.name ?? '');
                    if (d?.vehicle) setVehicle(d.vehicle);
                  }}>
                  <option value="">— Pick driver —</option>
                  {sortByText(drivers).map((d) => <option key={d.id} value={d.id}>{d.name}{d.vehicle ? ` · ${d.vehicle}` : ''}</option>)}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Vehicle</span>
              <input className={styles.fieldInput} value={vehicle} onChange={(e) => setVehicle(e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Building Type</span>
              <span className={styles.selectWrap}>
                <select className={styles.fieldSelect} value={buildingType} onChange={(e) => setBuildingType(e.target.value)}>
                  <option value="">—</option>
                  {buildingTypeOpts.map((b) => <option key={b.id} value={b.value}>{b.label}</option>)}
                  {buildingType && !buildingTypeOpts.some((b) => b.value === buildingType) && <option value={buildingType}>{buildingType}</option>}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Venue</span>
              <input className={styles.fieldInput} value={venue} onChange={(e) => setVenue(e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Expected Delivery</span>
              <DateField fullWidth className={styles.fieldInput} value={expectedDeliveryAt ?? ''} onChange={(iso) => setExpectedDeliveryAt(iso)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Customer Delivery Date</span>
              <DateField fullWidth className={styles.fieldInput} value={customerDeliveryDate ?? ''} onChange={(iso) => setCustomerDeliveryDate(iso)} />
            </label>
            <label className={styles.field} style={{ gridColumn: 'span 2' }}>
              <span className={styles.fieldLabel}>Note</span>
              <input className={styles.fieldInput} value={note} onChange={(e) => setNote(e.target.value)}
                placeholder="Internal notes — visible on the DO detail page only" />
            </label>
          </div>
        </div>
      </section>

      {/* ── EMERGENCY CONTACT ── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Emergency Contact</h2>
          <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
            Used only if we cannot reach the customer on delivery day
          </span>
        </header>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Contact Name</span>
              <input className={styles.fieldInput} value={emergencyName} placeholder="e.g. Lim Mei Hua"
                onChange={(e) => setEmergencyName(e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Relationship</span>
              <span className={styles.selectWrap}>
                <select className={styles.fieldSelect} value={emergencyRel} onChange={(e) => setEmergencyRel(e.target.value)}>
                  <option value="">—</option>
                  {relationshipOpts.map((r) => <option key={r.id} value={r.value}>{r.label}</option>)}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <label className={styles.field} style={{ gridColumn: 'span 2' }}>
              <span className={styles.fieldLabel}>Phone</span>
              <PhoneInput className={styles.fieldInput} value={emergencyPhone} onChange={setEmergencyPhone} />
            </label>
          </div>
        </div>
      </section>

      {/* ── DELIVERY ADDRESS ── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}><h2 className={styles.cardTitle}>Delivery Address</h2></header>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <label className={styles.field} style={{ gridColumn: 'span 4' }}>
              <span className={styles.fieldLabel}>Address Line 1</span>
              <input className={styles.fieldInput} value={address1} onChange={(e) => setAddress1(e.target.value)} placeholder="Unit, street, area" />
            </label>
            <label className={styles.field} style={{ gridColumn: 'span 4' }}>
              <span className={styles.fieldLabel}>Address Line 2</span>
              <input className={styles.fieldInput} value={address2} onChange={(e) => setAddress2(e.target.value)} placeholder="Apt, floor, building (optional)" />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>State</span>
              <span className={styles.selectWrap}>
                <select className={styles.fieldSelect} value={state}
                  onChange={(e) => { setState(e.target.value); setCity(''); setPostcode(''); }}
                  disabled={loc.isLoading}>
                  <option value="">{loc.isLoading ? 'Loading…' : 'Pick state'}</option>
                  {sortByText(states).map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>City</span>
              <span className={styles.selectWrap}>
                <select className={styles.fieldSelect} value={city}
                  onChange={(e) => { setCity(e.target.value); setPostcode(''); }} disabled={!state}>
                  <option value="">{state ? 'Pick city' : '— pick state first'}</option>
                  {sortByText(cities).map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Postcode</span>
              <span className={styles.selectWrap}>
                <select className={styles.fieldSelect} value={postcode}
                  onChange={(e) => setPostcode(e.target.value)} disabled={!state || !city}>
                  <option value="">{(state && city) ? 'Pick postcode' : '— pick city first'}</option>
                  {sortByNumeric(postcodes).map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            {/* Sales Location (Wei Siang 2026-06-01) — the dispatch warehouse the
                goods ship from. Carried from the Sales Order; read-only here
                (stock never crosses warehouses, so the DO can't re-pick it). */}
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Sales Location</span>
              <span className={styles.fieldInput} style={{
                display: 'inline-flex', alignItems: 'center', height: 26,
                color: 'var(--fg-muted)',
              }}
                title={salesLocation
                  ? 'Dispatch warehouse carried from the Sales Order'
                  : 'Set on the Sales Order'}
              >
                {salesLocation || '—'}
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* ── LINE ITEMS ── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}><h2 className={styles.cardTitle}>Line Items ({lines.length})</h2></header>
        <div className={styles.cardBody} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          {lines.map((line, idx) => (
            <SoLineCard
              key={line.rid}
              index={idx}
              draft={line}
              onChange={(patch) => updateLine(line.rid, patch)}
              onRemove={() => dropLine(line.rid)}
              canRemove={lines.length > 1}
            />
          ))}
          <button type="button" onClick={addLine}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, width: '100%',
              padding: '12px 14px', background: 'transparent', border: '1px dashed var(--c-orange)',
              borderRadius: 'var(--radius-md)', color: 'var(--c-orange)', fontFamily: 'var(--font-sans)',
              fontSize: 'var(--fs-13)', fontWeight: 600, cursor: 'pointer',
            }}>
            <Plus {...ICON} /> Add Line Item
          </button>
          <div style={{
            display: 'flex', justifyContent: 'flex-end', marginTop: 'var(--space-2)', paddingTop: 'var(--space-3)',
            borderTop: '1px solid var(--line)', fontFamily: 'var(--font-mark)', fontSize: 'var(--fs-20)',
            fontWeight: 800, color: 'var(--c-burnt)',
          }}>
            Subtotal: {fmtRm(subtotalCenti)}
          </div>
        </div>
      </section>

      {/* ── PAYMENTS (shared draft-mode ledger) ── */}
      <PaymentsTable
        docNo={null}
        payments={paymentDrafts}
        onChange={setPaymentDrafts}
        grandTotalCenti={subtotalCenti}
        currency="MYR"
      />
    </div>
  );
};
