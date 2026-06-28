// ----------------------------------------------------------------------------
// Delivery Planning — STAGE 4 (the core) of the Delivery / TMS module.
//
// The planning board: which live Sales Orders still need delivering, organised
// by a top row of 4 DELIVERY-STATE tabs (Pending Delivery / Pending Schedule /
// Overdue / Delivered, each with a live count) and a region chip row of FOUR
// FIXED buckets classified by customer STATE (All · KL · Penang · EM · SG).
// Both the active state tab and the active region (bucket key) live in the URL
// (useSearchParams) so a link / refresh keeps the view. The HC-sheet columns
// render in the shared DataGrid; the delivery state shows as an inline pill, and
// a legged order (one with delivery_legs) surfaces under each of its leg buckets
// (mapped from the leg's warehouse code) with that leg's date.
//
// Backend-derived: delivery_state, region grouping, readiness, crew, legs, and
// days_left all come from GET /delivery-planning — this page only filters by
// the active state/region and renders. Schedule + leg editing call the
// PATCH/POST endpoints via the queries hook.
//
// Style: 2990 cream brand (CSS modules + design-system). Singapore region is
// visually distinct (dashed teal chip + a teal row accent).
//
// HOUZS VENDOR NOTE: imports rewired to the vendored locations —
//   ../components/* → ../../vendor/scm/components/*
//   ../lib/category-badges → ../../vendor/scm/lib/category-badges
//   ../lib/delivery-planning-queries → ../../vendor/scm/lib/delivery-planning-queries
//   useMfgSalesOrderDetail lives in ../../vendor/scm/lib/sales-order-queries
//     (Houzs co-locates it with the SO queries; 2990 has it under flow-queries).
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Split, MapPinned, Truck } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { fmtCenti, fmtDateOrDash, fmtDateTime, buildVariantSummary } from '@2990s/shared';
import { formatPhone } from '@2990s/shared/phone';
import { DataGrid, type DataGridColumn } from '../../vendor/scm/components/DataGrid';
import { DeliveryFieldsDrawer } from '../../vendor/scm/components/DeliveryFieldsDrawer';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { badgeFor } from '../../vendor/scm/lib/category-badges';
import { useMfgSalesOrderDetail } from '../../vendor/scm/lib/sales-order-queries';
import {
  useDeliveryPlanning,
  useConvertSosToDo,
  DELIVERY_STATES,
  DELIVERY_STATE_LABEL,
  type DeliveryState,
  type PlanningOrder,
} from '../../vendor/scm/lib/delivery-planning-queries';
import styles from './DeliveryPlanning.module.css';

/* HC "Remark 4" delivery sub-status → a small pill class (reuse the cream
   palette; unknown/blank → muted). Default-shown column. */
const SUBSTATUS_TONE: Record<string, string> = {
  'Pending Pickup': 'var(--fg-muted)',
  'Done Shipout': 'var(--c-secondary-a)',
  'Arrives EM Warehouse': 'var(--c-secondary-a)',
  'Done Delivered': 'var(--c-green, #2e7d32)',
  'Confirm': 'var(--c-secondary-a)',
  'House Not Ready': 'var(--c-burnt)',
  'Request Hold': 'var(--c-burnt)',
};
function SubstatusPill({ value }: { value: string | null }) {
  if (!value) return <span style={{ color: 'var(--fg-muted)' }}>—</span>;
  const tone = SUBSTATUS_TONE[value] ?? 'var(--fg-muted)';
  return (
    <span style={{
      display: 'inline-block', padding: '1px 8px', borderRadius: 999,
      border: `1px solid ${tone}`, color: tone, fontSize: 'var(--fs-10)',
      fontWeight: 600, whiteSpace: 'nowrap',
    }}>{value}</span>
  );
}
/* A datetime-or-dash cell (TIMESTAMPTZ columns). */
const dtOrDash = (iso: string | null): string => (iso ? fmtDateTime(iso) : '—');

/* Region chips — CONFIG-DRIVEN buckets (migration 0198) classified by customer
   STATE. The bucket list now comes from the API's `regions` master (owner-
   maintained in Delivery Regions), with an "All" tab prepended. SG is visually
   distinct (dashed teal chip — cross-border, no MY warehouse); that styling keys
   off the region CODE === 'SG', not a hardcoded position, so it survives the
   owner reordering / adding buckets. The chip's key is sent verbatim as ?region=
   to the API, which buckets every order by customer state. */
type RegionTab = { key: string; label: string; sg?: boolean };

/* The 4 state tabs (the top row). */
const STATE_TABS = DELIVERY_STATES;

const DSTATE_PILL_CLASS: Record<DeliveryState, string> = {
  PENDING_DELIVERY: styles.dstatePendingDelivery!,
  PENDING_SCHEDULE: styles.dstatePendingSchedule!,
  OVERDUE: styles.dstateOverdue!,
  DELIVERED: styles.dstateDelivered!,
};

function DeliveryStatePill({ state }: { state: DeliveryState }) {
  return (
    <span className={`${styles.dstatePill} ${DSTATE_PILL_CLASS[state]}`}>
      {DELIVERY_STATE_LABEL[state]}
    </span>
  );
}

/* Balance source-of-truth (mirrors the SO list's liveBalance, PR #83):
   the payment-totals view's balance_centi_live (local_total − Σpayments) when
   present, else the header's stored balance_centi. */
const liveBalance = (o: PlanningOrder): number =>
  typeof o.balance_centi_live === 'number' ? o.balance_centi_live : o.balance_centi;

/* days_left cell — overdue (<0) red, due-soon (0..3) burnt, else plain. */
function DaysLeftCell({ days }: { days: number | null }) {
  if (days == null) return <span style={{ color: 'var(--fg-muted)' }}>—</span>;
  const cls = days < 0 ? styles.daysOverdue : days <= 3 ? styles.daysSoon : styles.daysOk;
  const label = days < 0 ? `${Math.abs(days)}d overdue` : days === 0 ? 'today' : `${days}d`;
  return <span className={cls}>{label}</span>;
}

/* ── SO line-item drill-down (parity with the Sales Order list) ───────────────
   Each planning row expands (▼ caret on the left, added by DataGrid's
   `expandable` API) to show that SO's line items — same four columns the SO list
   drill-down shows: Group · Item Code · Description · Description 2.

   Items are sourced EXACTLY the way MfgSalesOrdersList sources them: the shared
   `useMfgSalesOrderDetail(docNo)` hook, lazy-fetched per row on expand and
   TanStack-cached by doc_no, so re-expanding the same SO is instant and no new
   endpoint is introduced. The planning row already carries `so_doc_no`, which
   keys the fetch.

   Rendering mirrors the SO list: `CategoryPill` via the shared `badgeFor`
   palette, `buildVariantSummary` for the variant ("Description 2") cell, and the
   same embedded `DataGrid` chrome so the two pages read identically. */
type DrillItem = {
  id: string;
  /* snake_case off the SO detail REST response (see SoItem in
     MfgSalesOrdersList) — the API never transforms these. */
  item_code: string | null;
  item_group: string | null;
  description: string | null;
  variants: Record<string, unknown> | null;
  cancelled: boolean | null;
};

/* Inline category pill — same shape + shared `badgeFor` palette as the SO list
   drill-down's CategoryPill so the colours stay in lockstep across both pages. */
const CategoryPill = ({ group }: { group: string | null | undefined }) => {
  const spec = badgeFor(group);
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      padding: '1px 8px', borderRadius: 999,
      background: spec.bg, color: spec.fg,
      fontFamily: 'var(--font-button)', fontSize: 'var(--fs-10)',
      fontWeight: 700, letterSpacing: '0.06em',
      textTransform: 'uppercase', lineHeight: 1.4, whiteSpace: 'nowrap',
    }}>
      {spec.label}
    </span>
  );
};

/* Four drill-down columns — Group · Item Code · Description · Description 2.
   Matches the SO list's accessors/markup verbatim. Shared layout key so the
   operator's column prefs persist across every SO they expand. */
const DRILLDOWN_COLUMNS: DataGridColumn<DrillItem>[] = [
  {
    key: 'group', label: 'Group', width: 90, groupable: true,
    accessor: (it) => <CategoryPill group={it.item_group} />,
    searchValue: (it) => it.item_group ?? '',
    groupValue: (it) => it.item_group ?? '(none)',
    sortFn: (a, b) => (a.item_group ?? '').localeCompare(b.item_group ?? ''),
  },
  {
    key: 'item_code', label: 'Item Code', width: 130,
    accessor: (it) => <span style={{ fontWeight: 700, color: 'var(--c-burnt)' }}>{it.item_code ?? '—'}</span>,
    searchValue: (it) => it.item_code ?? '',
    sortFn: (a, b) => (a.item_code ?? '').localeCompare(b.item_code ?? ''),
  },
  {
    key: 'description', label: 'Description', width: 240, minWidth: 180,
    accessor: (it) => {
      const manual = (it.description ?? '').trim();
      if (manual) return <div>{manual}</div>;
      const summary = buildVariantSummary(it.item_group, it.variants);
      return summary ? <div>{summary}</div> : '—';
    },
    searchValue: (it) => `${it.description ?? ''} ${buildVariantSummary(it.item_group, it.variants)}`.trim(),
  },
  {
    key: 'description2', label: 'Description 2', width: 220, minWidth: 160,
    accessor: (it) => {
      const summary = buildVariantSummary(it.item_group, it.variants);
      return summary ? <div>{summary}</div> : <span style={{ color: 'var(--fg-muted)' }}>—</span>;
    },
    searchValue: (it) => buildVariantSummary(it.item_group, it.variants),
  },
];

const PlanningExpandedLines = ({ docNo }: { docNo: string }) => {
  /* SAME hook the SO list uses — lazy on expand, cached by doc_no. No new
     endpoint. */
  const q = useMfgSalesOrderDetail(docNo);
  if (q.isLoading) {
    return (
      <div style={{ padding: '8px 12px', fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>
        Loading lines for {docNo}…
      </div>
    );
  }
  if (q.error) {
    return (
      <div style={{ padding: '8px 12px', fontSize: 'var(--fs-11)', color: 'var(--c-festive-b, #B8331F)' }}>
        Failed to load lines: {q.error instanceof Error ? q.error.message : String(q.error)}
      </div>
    );
  }
  const allItems = (q.data?.items ?? []) as DrillItem[];
  /* Filter cancelled lines client-side — the detail endpoint returns them too
     (matches the SO list drill-down). */
  const items = allItems.filter((it) => !it.cancelled);

  if (items.length === 0) {
    return (
      <div style={{ padding: '8px 12px', fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>
        No line items.
      </div>
    );
  }

  return (
    <div style={{
      padding: 'var(--space-2) var(--space-3) var(--space-2) 40px',
      background: 'var(--c-cream)',
    }}>
      <DataGrid<DrillItem>
        rows={items}
        columns={DRILLDOWN_COLUMNS}
        storageKey="delivery-planning-drilldown-grid.v1"
        rowKey={(it) => it.id}
        embedded
        groupBanner={false}
      />
    </div>
  );
};

export const DeliveryPlanning = () => {
  const navigate = useNavigate();
  const askConfirm = useConfirm();
  const notify = useNotify();
  const [params, setParams] = useSearchParams();
  const activeState = (params.get('state') ?? 'ALL').toUpperCase();
  const activeRegion = (params.get('region') ?? 'ALL').toUpperCase();

  /* The order whose HC fields are being edited (drawer open when non-null). */
  const [editing, setEditing] = useState<PlanningOrder | null>(null);

  /* Multi-select → bulk "Convert N to DO". Selection keys are so_doc_no strings
     (the DataGrid rowKey). The convert reuses POST /from-sos one-DO-per-SO. */
  const [sel, setSel] = useState<Set<string>>(new Set());
  const convertSos = useConvertSosToDo();

  /* Convert a set of SOs → DOs (single row or the bulk selection). Skips SOs
     with no deliverable remaining (already fully delivered); reports the result
     via the in-app NotifyDialog. Reused by the row action + the selection bar. */
  const runConvert = async (docNos: string[]) => {
    const wanted = [...new Set(docNos.filter(Boolean))];
    if (wanted.length === 0 || convertSos.isPending) return;
    try {
      const res = await convertSos.mutateAsync({ docNos: wanted });
      setSel(new Set());
      const parts: string[] = [];
      if (res.converted.length > 0) {
        parts.push(`Converted ${res.converted.length} sales order${res.converted.length === 1 ? '' : 's'} to DO (${res.converted.map((r) => r.doNumber).join(', ')}).`);
      }
      if (res.skipped.length > 0) {
        parts.push(`Skipped ${res.skipped.length} already fully delivered: ${res.skipped.map((r) => r.docNo).join(', ')}.`);
      }
      if (res.failed.length > 0) {
        parts.push(`Failed ${res.failed.length}: ${res.failed.map((r) => `${r.docNo} (${r.message})`).join('; ')}.`);
      }
      notify({
        title: res.converted.length > 0 ? 'Conversion complete' : 'Nothing converted',
        body: parts.join(' ') || 'No deliverable lines were found.',
        tone: res.failed.length > 0 ? 'error' : 'info',
      });
    } catch (e) {
      notify({ title: 'Convert failed', body: e instanceof Error ? e.message : String(e), tone: 'error' });
    }
  };

  /* Single-row convert (context-menu action). */
  const convertOne = (o: PlanningOrder) => { void runConvert([o.so_doc_no]); };

  /* Bulk convert (selection bar) — confirm first (useConfirm, no window.*). */
  const convertSelected = async () => {
    const docNos = [...sel];
    if (docNos.length === 0) return;
    if (!(await askConfirm({
      title: `Convert ${docNos.length} sales order${docNos.length === 1 ? '' : 's'} to delivery orders?`,
      body: 'Each selected Sales Order’s still-undelivered lines become a new Delivery Order (one DO per SO). Fully delivered orders are skipped.',
      confirmLabel: `Convert ${docNos.length}`,
    }))) return;
    await runConvert(docNos);
  };

  /* EM/SG nicety: when the active region is EM or SG, the cross-border columns
     (shipout date, port ref, customer-delivered date) default-SHOW; elsewhere
     they sit in the Columns menu like the rest. */
  const isEmSg = activeRegion === 'EM' || activeRegion === 'SG';

  /* Fetch scoped to the active REGION; counts come back region-scoped so the
     state-tab badges are stable as the operator flips state tabs. We pass the
     state to the server too (it filters), but render-time we already have the
     region-filtered orders so switching states is instant via the cache key. */
  const { data, isLoading, error } = useDeliveryPlanning({ region: activeRegion, state: 'ALL' });

  /* Region chips = the CONFIG-DRIVEN buckets from the API master (+ "All"
     prepended). SG (by CODE) is the dashed-teal cross-border chip. Falls back to
     the four seeded defaults if the API hasn't returned the list yet. */
  const regionTabs = useMemo<RegionTab[]>(() => {
    const masters = data?.regions ?? [
      { key: 'KL', label: 'KL' }, { key: 'PENANG', label: 'Penang' },
      { key: 'EM', label: 'EM' }, { key: 'SG', label: 'SG' },
    ];
    return [
      { key: 'ALL', label: 'All' },
      ...masters.map((r) => ({ key: r.key, label: r.label, sg: r.key === 'SG' })),
    ];
  }, [data?.regions]);

  /* code → display label, from the master (drives the Region grid column). */
  const regionLabel = useMemo<Record<string, string>>(() => {
    const m: Record<string, string> = {};
    for (const r of data?.regions ?? []) m[r.key] = r.label;
    return m;
  }, [data?.regions]);
  const regionLabelOf = (code: string): string => regionLabel[code] ?? code;

  const activeRegionLabel = regionTabs.find((r) => r.key === activeRegion)?.label ?? 'All';

  const setState = (s: string) => {
    const next = new URLSearchParams(params);
    if (s === 'ALL') next.delete('state'); else next.set('state', s);
    setParams(next, { replace: true });
  };
  const setRegion = (r: string) => {
    const next = new URLSearchParams(params);
    if (r === 'ALL') next.delete('region'); else next.set('region', r);
    setParams(next, { replace: true });
  };

  const allOrders = useMemo<PlanningOrder[]>(() => data?.orders ?? [], [data]);
  const counts = data?.counts ?? { ALL: 0, PENDING_DELIVERY: 0, PENDING_SCHEDULE: 0, OVERDUE: 0, DELIVERED: 0 };

  /* Apply the active state tab in the client (the fetch already region-scoped). */
  const rows = useMemo<PlanningOrder[]>(
    () => (activeState === 'ALL' ? allOrders : allOrders.filter((o) => o.delivery_state === activeState)),
    [allOrders, activeState],
  );

  /* For a legged order under a specific region bucket, surface THAT leg's date
     as the row's planned date. Helper: pick the leg whose bucket == the active
     region so the same order shows its transit date in KL and its final date in
     Penang/EM. (No SG warehouse exists, so SG never matches a leg.) */
  const legDateForRegion = (o: PlanningOrder): string | null => {
    if (activeRegion === 'ALL' || o.legs.length === 0) return null;
    const leg = o.legs.find((l) => l.region === activeRegion);
    return leg?.leg_date ?? null;
  };

  const columns = useMemo<DataGridColumn<PlanningOrder>[]>(() => [
    {
      key: 'so_doc_no', label: 'SO No.', width: 150, sortable: true,
      accessor: (o) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', fontWeight: 700, color: 'var(--c-burnt)', fontVariantNumeric: 'tabular-nums' }}>
          {o.so_doc_no}
          {o.legs.length > 0 && (
            <span className={styles.legBadge} title={`${o.legs.length} delivery legs (multi-region trip)`}>
              <Split size={9} strokeWidth={2} />{o.legs.length}
            </span>
          )}
        </span>
      ),
      searchValue: (o) => o.so_doc_no,
      exportValue: (o) => o.so_doc_no,
      sortFn: (a, b) => a.so_doc_no.localeCompare(b.so_doc_no),
    },
    {
      key: 'debtor_name', label: 'Customer', width: 200, sortable: true, groupable: true,
      accessor: (o) => o.debtor_name ?? o.debtor_code ?? '—',
      searchValue: (o) => `${o.debtor_name ?? ''} ${o.debtor_code ?? ''}`.trim(),
      groupValue: (o) => o.debtor_name ?? o.debtor_code ?? '(none)',
      sortFn: (a, b) => (a.debtor_name ?? '').localeCompare(b.debtor_name ?? ''),
    },
    {
      key: 'phone', label: 'Phone', width: 150,
      accessor: (o) => formatPhone(o.phone) || '—',
      searchValue: (o) => o.phone ?? '',
    },
    {
      key: 'branding', label: 'Branding', width: 130, groupable: true,
      accessor: (o) => o.branding ?? '—',
      searchValue: (o) => o.branding ?? '',
      groupValue: (o) => o.branding ?? '(none)',
    },
    {
      key: 'address', label: 'Address', width: 220, defaultHidden: true,
      accessor: (o) => o.address ?? '—',
      searchValue: (o) => o.address ?? '',
    },
    {
      key: 'postcode', label: 'Postcode', width: 100, defaultHidden: true,
      accessor: (o) => o.postcode ?? '—',
      searchValue: (o) => o.postcode ?? '',
    },
    {
      key: 'customer_state', label: 'State', width: 120, groupable: true, defaultHidden: true,
      accessor: (o) => o.customer_state ?? '—',
      searchValue: (o) => o.customer_state ?? '',
      groupValue: (o) => o.customer_state ?? '(none)',
    },
    {
      key: 'building_type', label: 'Property', width: 120, groupable: true, defaultHidden: true,
      accessor: (o) => o.building_type ?? '—',
      searchValue: (o) => o.building_type ?? '',
      groupValue: (o) => o.building_type ?? '(none)',
    },
    /* HC SO-context raw-data fields (migration 0197) — all default-HIDDEN,
       available in the Columns menu. */
    {
      key: 'possession_date', label: 'Possession', width: 120, sortable: true, defaultHidden: true,
      accessor: (o) => fmtDateOrDash(o.possession_date),
      searchValue: (o) => o.possession_date ?? '',
      sortFn: (a, b) => String(a.possession_date ?? '').localeCompare(String(b.possession_date ?? '')),
      filterType: 'date', dateValue: (o) => o.possession_date,
    },
    {
      key: 'house_type', label: 'House Type', width: 130, groupable: true, defaultHidden: true,
      accessor: (o) => o.house_type ?? '—',
      searchValue: (o) => o.house_type ?? '',
      groupValue: (o) => o.house_type ?? '(none)',
    },
    {
      key: 'replacement_disposal', label: 'Replacement/Disposal', width: 180, defaultHidden: true,
      accessor: (o) => o.replacement_disposal ?? '—',
      searchValue: (o) => o.replacement_disposal ?? '',
    },
    {
      key: 'referral', label: 'Referral', width: 140, groupable: true, defaultHidden: true,
      accessor: (o) => o.referral ?? '—',
      searchValue: (o) => o.referral ?? '',
      groupValue: (o) => o.referral ?? '(none)',
    },
    {
      key: 'region', label: 'Region', width: 110, sortable: true, groupable: true,
      accessor: (o) => regionLabelOf(o.region),
      searchValue: (o) => regionLabelOf(o.region),
      groupValue: (o) => regionLabelOf(o.region),
      exportValue: (o) => regionLabelOf(o.region),
      sortFn: (a, b) => regionLabelOf(a.region).localeCompare(regionLabelOf(b.region)),
    },
    {
      key: 'warehouse', label: 'Warehouse', width: 150, sortable: true, groupable: true, defaultHidden: true,
      accessor: (o) => o.warehouse_code ?? '—',
      searchValue: (o) => `${o.warehouse_code ?? ''} ${o.warehouse_name ?? ''}`.trim(),
      groupValue: (o) => o.warehouse_code ?? '(none)',
    },
    {
      key: 'so_date', label: 'SO Date', width: 120, sortable: true, defaultHidden: true,
      accessor: (o) => fmtDateOrDash(o.so_date),
      searchValue: (o) => o.so_date ?? '',
      sortFn: (a, b) => String(a.so_date ?? '').localeCompare(String(b.so_date ?? '')),
      filterType: 'date', dateValue: (o) => o.so_date,
    },
    {
      key: 'processing_date', label: 'Processing', width: 120, sortable: true, defaultHidden: true,
      accessor: (o) => fmtDateOrDash(o.processing_date),
      searchValue: (o) => o.processing_date ?? '',
      sortFn: (a, b) => String(a.processing_date ?? '').localeCompare(String(b.processing_date ?? '')),
      filterType: 'date', dateValue: (o) => o.processing_date,
    },
    {
      key: 'customer_delivery_date', label: 'Delivery Date', width: 130, sortable: true,
      accessor: (o) => {
        const legDate = legDateForRegion(o);
        return (
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>
            {fmtDateOrDash(legDate ?? o.customer_delivery_date)}
            {legDate && legDate !== o.customer_delivery_date && (
              <span style={{ marginLeft: 4, fontSize: 'var(--fs-10)', color: 'var(--c-secondary-a)' }}>(leg)</span>
            )}
          </span>
        );
      },
      searchValue: (o) => o.customer_delivery_date ?? '',
      sortFn: (a, b) => String(a.customer_delivery_date ?? '').localeCompare(String(b.customer_delivery_date ?? '')),
      filterType: 'date', dateValue: (o) => o.customer_delivery_date,
    },
    /* Amendment dates (migration 0199). "Amended" (the date WE confirmed / the
       proposed delivery date) default-SHOWS — it's the firm date the board commits
       to. "Amend (Cust)" (the customer's requested new date) default-HIDES. The
       ORIGINAL "Delivery Date" column above is unchanged. */
    {
      key: 'amended_delivery_date', label: 'Amended', width: 130, sortable: true,
      accessor: (o) => fmtDateOrDash(o.amended_delivery_date),
      searchValue: (o) => o.amended_delivery_date ?? '',
      sortFn: (a, b) => String(a.amended_delivery_date ?? '').localeCompare(String(b.amended_delivery_date ?? '')),
      filterType: 'date', dateValue: (o) => o.amended_delivery_date,
    },
    {
      key: 'amend_date_from_customer', label: 'Amend (Cust)', width: 130, sortable: true, defaultHidden: true,
      accessor: (o) => fmtDateOrDash(o.amend_date_from_customer),
      searchValue: (o) => o.amend_date_from_customer ?? '',
      sortFn: (a, b) => String(a.amend_date_from_customer ?? '').localeCompare(String(b.amend_date_from_customer ?? '')),
      filterType: 'date', dateValue: (o) => o.amend_date_from_customer,
    },
    /* HC "Amend Client Date Reason" (migration 0201) — free-text reason paired
       with the amend dates above. default-HIDES (off in the Columns menu). */
    {
      key: 'amend_reason', label: 'Amend Reason', width: 200, defaultHidden: true,
      accessor: (o) => o.amend_reason ?? '—',
      searchValue: (o) => o.amend_reason ?? '',
    },
    {
      key: 'internal_expected_dd', label: 'Est. (New)', width: 120, sortable: true, defaultHidden: true,
      accessor: (o) => fmtDateOrDash(o.internal_expected_dd),
      searchValue: (o) => o.internal_expected_dd ?? '',
      sortFn: (a, b) => String(a.internal_expected_dd ?? '').localeCompare(String(b.internal_expected_dd ?? '')),
      filterType: 'date', dateValue: (o) => o.internal_expected_dd,
    },
    {
      key: 'days_left', label: 'Days Left', width: 110, align: 'right', sortable: true,
      accessor: (o) => <DaysLeftCell days={o.days_left} />,
      searchValue: (o) => (o.days_left == null ? '' : String(o.days_left)),
      sortFn: (a, b) => (a.days_left ?? 99999) - (b.days_left ?? 99999),
      numberValue: (o) => o.days_left,
    },
    {
      key: 'stock_remark', label: 'Stock', width: 150, groupable: true,
      accessor: (o) => (
        <span style={{ fontSize: 'var(--fs-12)', color: o.stock_status === 'PENDING' ? 'var(--fg-muted)' : 'var(--c-secondary-a)' }}>
          {o.stock_remark || o.stock_status}
        </span>
      ),
      searchValue: (o) => `${o.stock_remark} ${o.stock_status}`.trim(),
      groupValue: (o) => o.stock_status,
    },
    {
      key: 'delivery_state', label: 'State', width: 150, sortable: true, groupable: true,
      accessor: (o) => <DeliveryStatePill state={o.delivery_state} />,
      searchValue: (o) => DELIVERY_STATE_LABEL[o.delivery_state],
      groupValue: (o) => DELIVERY_STATE_LABEL[o.delivery_state],
      exportValue: (o) => DELIVERY_STATE_LABEL[o.delivery_state],
      sortFn: (a, b) => a.delivery_state.localeCompare(b.delivery_state),
    },
    /* HC DO-execution raw-data fields (migration 0197). delivery_substatus (a
       small pill) + customer_delivered_date default-SHOW; the rest default-HIDE.
       The cross-border ones (shipout_date, eta_arriving_port,
       customer_delivered_date) default-SHOW when the active region is EM/SG. */
    {
      key: 'delivery_substatus', label: 'Delivery Status', width: 160, groupable: true,
      accessor: (o) => <SubstatusPill value={o.delivery_substatus} />,
      searchValue: (o) => o.delivery_substatus ?? '',
      groupValue: (o) => o.delivery_substatus ?? '(none)',
      exportValue: (o) => o.delivery_substatus ?? '',
    },
    {
      key: 'customer_delivered_date', label: 'Delivered Date', width: 130, sortable: true,
      accessor: (o) => fmtDateOrDash(o.customer_delivered_date),
      searchValue: (o) => o.customer_delivered_date ?? '',
      sortFn: (a, b) => String(a.customer_delivered_date ?? '').localeCompare(String(b.customer_delivered_date ?? '')),
      filterType: 'date', dateValue: (o) => o.customer_delivered_date,
    },
    {
      key: 'time_range', label: 'Time Range', width: 120, defaultHidden: true,
      accessor: (o) => o.time_range ?? '—',
      searchValue: (o) => o.time_range ?? '',
    },
    {
      key: 'time_confirmed', label: 'Time OK', width: 90, align: 'right', defaultHidden: true,
      accessor: (o) => (o.time_confirmed == null ? '—' : o.time_confirmed ? 'Yes' : 'No'),
      searchValue: (o) => (o.time_confirmed == null ? '' : o.time_confirmed ? 'Yes' : 'No'),
    },
    {
      key: 'arrival_at', label: 'Arrival', width: 150, sortable: true, defaultHidden: true,
      accessor: (o) => dtOrDash(o.arrival_at),
      searchValue: (o) => o.arrival_at ?? '',
      sortFn: (a, b) => String(a.arrival_at ?? '').localeCompare(String(b.arrival_at ?? '')),
    },
    {
      key: 'departure_at', label: 'Departure', width: 150, sortable: true, defaultHidden: true,
      accessor: (o) => dtOrDash(o.departure_at),
      searchValue: (o) => o.departure_at ?? '',
      sortFn: (a, b) => String(a.departure_at ?? '').localeCompare(String(b.departure_at ?? '')),
    },
    {
      key: 'shipout_date', label: 'Shipout', width: 120, sortable: true, defaultHidden: !isEmSg,
      accessor: (o) => fmtDateOrDash(o.shipout_date),
      searchValue: (o) => o.shipout_date ?? '',
      sortFn: (a, b) => String(a.shipout_date ?? '').localeCompare(String(b.shipout_date ?? '')),
      filterType: 'date', dateValue: (o) => o.shipout_date,
    },
    {
      key: 'eta_arriving_port', label: 'ETA / Port', width: 150, defaultHidden: !isEmSg,
      accessor: (o) => o.eta_arriving_port ?? '—',
      searchValue: (o) => o.eta_arriving_port ?? '',
    },
    /* EM-region cross-border transit-warehouse arrival date (migration 0199).
       Default-HIDDEN, but auto-SHOWS on the EM/SG region tabs like shipout / ETA
       (these cross-border columns only matter for the EM trip). */
    {
      key: 'arrives_em_warehouse_date', label: 'Arrives EM Whse', width: 150, sortable: true, defaultHidden: !isEmSg,
      accessor: (o) => fmtDateOrDash(o.arrives_em_warehouse_date),
      searchValue: (o) => o.arrives_em_warehouse_date ?? '',
      sortFn: (a, b) => String(a.arrives_em_warehouse_date ?? '').localeCompare(String(b.arrives_em_warehouse_date ?? '')),
      filterType: 'date', dateValue: (o) => o.arrives_em_warehouse_date,
    },
    /* Crew — split into the HC delivery-sheet columns. Driver + Lorry show by
       default; IC / contact / driver 2 / helpers are in the show/hide menu. */
    {
      key: 'driver', label: 'Driver', width: 150,
      accessor: (o) => o.crew?.driver_1_name || <span style={{ color: 'var(--fg-muted)' }}>—</span>,
      searchValue: (o) => o.crew?.driver_1_name ?? '',
    },
    {
      key: 'driver_ic', label: 'Driver IC', width: 140, defaultHidden: true,
      accessor: (o) => o.crew?.driver_1_ic || <span style={{ color: 'var(--fg-muted)' }}>—</span>,
      searchValue: (o) => o.crew?.driver_1_ic ?? '',
    },
    {
      key: 'driver_contact', label: 'Driver Contact', width: 150, defaultHidden: true,
      accessor: (o) => (o.crew?.driver_1_contact ? formatPhone(o.crew.driver_1_contact) || o.crew.driver_1_contact : <span style={{ color: 'var(--fg-muted)' }}>—</span>),
      searchValue: (o) => o.crew?.driver_1_contact ?? '',
    },
    {
      key: 'driver_2', label: 'Driver 2', width: 150, defaultHidden: true,
      accessor: (o) => o.crew?.driver_2_name || <span style={{ color: 'var(--fg-muted)' }}>—</span>,
      searchValue: (o) => o.crew?.driver_2_name ?? '',
    },
    {
      key: 'helper_1', label: 'Helper 1', width: 150, defaultHidden: true,
      accessor: (o) => o.crew?.helper_1_name || <span style={{ color: 'var(--fg-muted)' }}>—</span>,
      searchValue: (o) => o.crew?.helper_1_name ?? '',
    },
    {
      key: 'helper_2', label: 'Helper 2', width: 150, defaultHidden: true,
      accessor: (o) => o.crew?.helper_2_name || <span style={{ color: 'var(--fg-muted)' }}>—</span>,
      searchValue: (o) => o.crew?.helper_2_name ?? '',
    },
    {
      key: 'lorry', label: 'Lorry', width: 130,
      accessor: (o) => o.crew?.lorry_plate || <span style={{ color: 'var(--fg-muted)' }}>—</span>,
      searchValue: (o) => o.crew?.lorry_plate ?? '',
    },
    {
      key: 'balance_centi', label: 'Balance', width: 130, align: 'right', sortable: true,
      accessor: (o) => (
        <span style={{ fontFamily: 'var(--font-mark)', fontWeight: 700, color: liveBalance(o) > 0 ? 'var(--c-burnt)' : 'var(--fg-muted)' }}>
          {fmtCenti(liveBalance(o))}
        </span>
      ),
      searchValue: (o) => String(liveBalance(o)),
      exportValue: (o) => liveBalance(o) / 100,
      sortFn: (a, b) => liveBalance(a) - liveBalance(b),
      numberValue: (o) => liveBalance(o) / 100,
    },
    {
      key: 'do', label: 'DO', width: 130, groupable: true,
      accessor: (o) => (o.delivery_orders.length > 0 ? o.delivery_orders.map((d) => d.do_number).join(', ') : '—'),
      searchValue: (o) => o.delivery_orders.map((d) => d.do_number).join(' '),
    },
    /* DO Date — the latest DO's OWN document date (delivery_orders.do_date), from
       the same latest-DO lookup the crew / HC fields use. Default-SHOWS so a
       converted row immediately reads its DO date. "—" until a DO exists. */
    {
      key: 'do_date', label: 'DO Date', width: 120, sortable: true,
      accessor: (o) => fmtDateOrDash(o.do_date),
      searchValue: (o) => o.do_date ?? '',
      sortFn: (a, b) => String(a.do_date ?? '').localeCompare(String(b.do_date ?? '')),
      filterType: 'date', dateValue: (o) => o.do_date,
    },
  // legDateForRegion + the EM/SG cross-border default-show (isEmSg) depend on
  // activeRegion → recompute the columns on region change. regionLabel feeds the
  // Region column's display labels (from the config master).
  ], [activeRegion, regionLabel]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={styles.page ?? ''} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', padding: 'var(--space-3) var(--space-4) var(--space-4)', background: 'var(--c-cream)', minHeight: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-4)', flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontFamily: 'var(--font-title)', fontSize: 'var(--fs-15, 15px)', fontWeight: 600, color: 'var(--c-ink)', margin: 0 }}>
            Delivery Planning
          </h1>
          <p style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-11)', color: 'var(--fg-muted)', margin: '2px 0 0' }}>
            Orders that need delivering · grouped by region (customer state) · {counts.ALL} in {activeRegionLabel}
          </p>
        </div>
        {/* Secondary header control — open the owner-maintained region-bucket
            master (formerly a standalone sidebar line; now reached from here). */}
        <Button
          variant="secondary"
          size="sm"
          onClick={() => navigate('/delivery-planning-regions')}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          <MapPinned size={16} strokeWidth={1.75} />
          Manage regions
        </Button>
      </div>

      {/* 4 STATE TABS (top row) — Pending Delivery / Pending Schedule / Overdue / Delivered, with counts. */}
      <div className={styles.stateTabs}>
        <button
          type="button"
          className={`${styles.stateTab} ${activeState === 'ALL' ? styles.stateTabActive : ''}`}
          onClick={() => setState('ALL')}
        >
          All <span className={styles.tabCount}>{counts.ALL}</span>
        </button>
        {STATE_TABS.map((s) => (
          <button
            key={s}
            type="button"
            className={[
              styles.stateTab,
              s === 'OVERDUE' ? styles.stateTabOverdue : '',
              activeState === s ? styles.stateTabActive : '',
            ].filter(Boolean).join(' ')}
            onClick={() => setState(s)}
          >
            {DELIVERY_STATE_LABEL[s]} <span className={styles.tabCount}>{counts[s]}</span>
          </button>
        ))}
      </div>

      {/* REGION chip row — the CONFIG-DRIVEN buckets from the API master (All +
          whatever the owner maintains in Delivery Regions). SG (by code) is
          dashed-teal (cross-border). Classified by customer state. */}
      <div className={styles.regionChips}>
        {regionTabs.map((r) => (
          <button
            key={r.key}
            type="button"
            className={[
              styles.regionChip,
              r.sg ? styles.regionChipSg : '',
              activeRegion === r.key ? styles.regionChipActive : '',
            ].filter(Boolean).join(' ')}
            onClick={() => setRegion(r.key)}
          >
            {r.label}
          </button>
        ))}
      </div>

      {error && !isLoading && (
        <div style={{ background: 'rgba(232, 107, 58, 0.08)', border: '1px solid var(--c-orange)', color: 'var(--c-burnt)', padding: 'var(--space-3) var(--space-4)', borderRadius: 'var(--radius-md)', fontSize: 'var(--fs-12)' }}>
          <strong>Failed to load delivery planning.</strong>{' '}
          {error instanceof Error ? error.message : String(error)}
        </div>
      )}

      {/* Selection bar — appears once one or more rows are ticked; "Convert N to
          DO" bulk-converts every selected SO (one DO per SO, useConfirm first). */}
      {sel.size > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: 'var(--space-2) var(--space-3)',
          background: 'rgba(232, 107, 58, 0.06)',
          border: '1px solid var(--c-orange)',
          borderRadius: 'var(--radius-md)',
          gap: 'var(--space-3)',
        }}>
          <span style={{ fontWeight: 600, color: 'var(--c-burnt)' }}>{sel.size} selected</span>
          <span style={{ display: 'inline-flex', gap: 'var(--space-2)' }}>
            <Button variant="ghost" size="sm" onClick={() => setSel(new Set())}>Clear</Button>
            <Button variant="secondary" size="sm" disabled={convertSos.isPending} onClick={() => void convertSelected()}>
              <Truck size={14} strokeWidth={1.75} />
              <span>{convertSos.isPending ? 'Converting…' : `Convert ${sel.size} to DO`}</span>
            </Button>
          </span>
        </div>
      )}

      <DataGrid
        rows={rows}
        columns={columns}
        storageKey="dg-delivery-planning"
        exportName="DeliveryPlanning"
        rowKey={(o) => o.so_doc_no}
        searchPlaceholder="Search SO / customer / phone…"
        groupBanner={false}
        isLoading={isLoading}
        emptyMessage="No orders need delivering in this view."
        /* First-class multi-select (so_doc_no keys) → the bulk Convert-to-DO bar. */
        selectable={{
          selectedKeys: sel,
          onToggle: (k) => setSel((p) => {
            const n = new Set(p);
            if (n.has(k)) n.delete(k); else n.add(k);
            return n;
          }),
          onToggleAll: (keys, allSel) => setSel((p) => {
            const n = new Set(p);
            if (allSel) { for (const k of keys) n.delete(k); }
            else { for (const k of keys) n.add(k); }
            return n;
          }),
        }}
        onRowDoubleClick={(row) => navigate('/mfg-sales-orders/' + row.so_doc_no)}
        expandable={{
          renderExpansion: (row) => <PlanningExpandedLines docNo={row.so_doc_no} />,
          rowExpansionKey: (row) => row.so_doc_no,
        }}
        rowStyle={(o) => (o.region === 'SG' ? { boxShadow: 'inset 3px 0 0 var(--c-secondary-a)' } : undefined)}
        contextMenu={(row) => [
          { label: 'Edit HC fields…', onClick: () => setEditing(row) },
          { label: 'Convert to DO', onClick: () => convertOne(row) },
          { divider: true },
          { label: 'Open Sales Order', onClick: () => navigate('/mfg-sales-orders/' + row.so_doc_no) },
        ]}
      />

      {/* Per-row HC fields editor (right-click → Edit HC fields). SO-context
          always editable; DO-execution editable only when the order has a DO. */}
      {editing && (
        <DeliveryFieldsDrawer order={editing} onClose={() => setEditing(null)} />
      )}
    </div>
  );
};
