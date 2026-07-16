// ----------------------------------------------------------------------------
// Delivery Planning — STAGE 4 (the core) of the Delivery / TMS module.
//
// The planning board: which live Sales Orders still need delivering, organised
// by a top row of 4 DELIVERY-STATE tabs (Pending Delivery / Pending Schedule /
// Overdue / Delivered, each with a live count) and a region chip row of FOUR
// FIXED buckets classified by customer STATE (All · KL · Penang · EM · SG).
// Both the active state tab and the active region (bucket key) live in the URL
// (useSearchParams) so a link / refresh keeps the view. The HC-sheet columns
// render in the shared DataGrid; the delivery state shows as an inline pill.
//
// NOTE: the "delivery leg" (multi-hop / dual-trip) sub-feature was REMOVED —
// China-PO transit flow, not in use yet; re-add later.
//
// Backend-derived: delivery_state, region grouping, readiness, crew, and
// days_left all come from GET /delivery-planning — this page only filters by
// the active state/region and renders. Schedule editing calls the PATCH
// endpoints via the queries hook.
//
// Style: 2990 cream brand (CSS modules + design-system). Singapore region is
// visually distinct (dashed teal chip + a teal row accent).
//
// HOUZS VENDOR NOTE: imports rewired to the vendored locations —
//   ../components/* → ../../vendor/scm/components/*
//   ../lib/category-badges → ../../vendor/scm/lib/category-badges
//   ../lib/delivery-planning-queries → ../../vendor/scm/lib/delivery-planning-queries
//
// SHARED-QUEUE NOTE (multi-company): the board reads BOTH companies' SOs. Row
// expand uses useDeliveryPlanningLines (GET /delivery-planning/:docNo/lines,
// scoped to ALLOWED companies) — NOT the per-company SO detail hook, which 404s
// a cross-company row. A default-visible Company column tags each row.
// ----------------------------------------------------------------------------

import { useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { MapPinned, Truck } from 'lucide-react';
import { Button } from '../../components/Button';
import { PageHeader } from '../../components/Layout';
import { fmtCenti, fmtDateOrDash, fmtDateTime, buildVariantSummary } from '@2990s/shared';
import { formatPhone } from '@2990s/shared/phone';
import { DataGrid, type DataGridColumn } from '../../vendor/scm/components/DataGrid';
import { DeliveryFieldsDrawer } from '../../vendor/scm/components/DeliveryFieldsDrawer';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { badgeFor } from '../../vendor/scm/lib/category-badges';
import {
  useDeliveryPlanning,
  useDeliveryPlanningLines,
  useConvertSosToDo,
  useScheduleDelivery,
  DELIVERY_STATES,
  DELIVERY_STATE_LABEL,
  type DeliveryState,
  type PlanningOrder,
} from '../../vendor/scm/lib/delivery-planning-queries';
import { useDrivers, type DriverRow } from '../../vendor/scm/lib/drivers-queries';
import { useLorries, type LorryRow } from '../../vendor/scm/lib/lorries-queries';
import styles from './DeliveryPlanning.module.css';

/* HC "Remark 4" delivery sub-status → a small pill class (reuse the cream
   palette; unknown/blank → muted). Default-shown column. */
const SUBSTATUS_TONE: Record<string, string> = {
  'Pending Pickup': '#767b6e',
  'Done Shipout': '#2f5d4f',
  'Arrives EM Warehouse': '#2f5d4f',
  'Done Delivered': '#2e7d32',
  'Confirm': '#2f5d4f',
  'House Not Ready': '#0c3f39',
  'Request Hold': '#0c3f39',
};
function SubstatusPill({ value }: { value: string | null }) {
  if (!value) return <span style={{ color: '#767b6e' }}>—</span>;
  const tone = SUBSTATUS_TONE[value] ?? '#767b6e';
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

/* Company badge for the SHARED cross-company queue — a small code chip
   (HOUZS / 2990). null (e.g. ASSR rows / unresolved) renders a muted dash. */
function CompanyBadge({ code }: { code: string | null }) {
  if (!code) return <span style={{ color: '#767b6e' }}>—</span>;
  return (
    <span style={{
      display: 'inline-block', padding: '1px 8px', borderRadius: 999,
      border: '1px solid #2f5d4f', color: '#2f5d4f',
      fontSize: 'var(--fs-10)', fontWeight: 700, letterSpacing: '0.04em',
      whiteSpace: 'nowrap',
    }}>{code}</span>
  );
}

/* ── Row-type helpers (SO delivery vs ASSR service-case job) ───────────────────
   The board now mixes SO-delivery rows (the original) with Service-Case (ASSR)
   rows added by the backend. `isAssr` gates every ASSR-specific behaviour;
   `rowIdOf` is the stable DataGrid key (prefixed so SO doc_nos and ASSR case ids
   never collide). */
const isAssr = (o: PlanningOrder): boolean => o.row_type === 'assr';
/* ASSR key includes job_kind — a case with BOTH a customer-pickup and a
   delivery date emits TWO rows sharing one assr_id, so the key must carry the
   leg to stay unique (the backend's so_doc_no is already `<assrNo>#<jobKind>`). */
const rowIdOf = (o: PlanningOrder): string => (isAssr(o) ? `assr:${o.assr_id ?? o.ref ?? ''}:${o.job_kind ?? ''}` : `so:${o.so_doc_no}`);

/* The Type column's chip. SO rows read a neutral "SO delivery"; ASSR rows read
   their job kind — amber "Cust. pickup" for a pickup, green "Delivery" for a
   delivery. Same inline-pill shape the SO drill-down's CategoryPill / the
   SubstatusPill use, so it reads consistently across the board. */
function TypeChip({ order }: { order: PlanningOrder }) {
  let label = 'SO delivery';
  let tone = '#767b6e';
  let bg = 'rgba(34, 31, 32, 0.06)';
  if (isAssr(order)) {
    if (order.job_kind === 'customer_pickup') {
      label = 'Cust. pickup';
      tone = '#0c3f39';
      bg = 'rgba(232, 107, 58, 0.12)';
    } else {
      label = 'Delivery';
      tone = '#2f5d4f';
      bg = 'rgba(47, 93, 79, 0.12)';
    }
  }
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      padding: '1px 8px', borderRadius: 999,
      background: bg, color: tone,
      fontFamily: 'var(--font-button)', fontSize: 'var(--fs-10)',
      fontWeight: 700, letterSpacing: '0.06em',
      textTransform: 'uppercase', lineHeight: 1.4, whiteSpace: 'nowrap',
    }}>
      {label}
    </span>
  );
}

/* A muted em-dash cell — the shared "not applicable" render for columns that
   don't apply to an ASSR row (stock, driver, lorry). */
const NotApplicable = () => <span style={{ color: '#767b6e' }}>—</span>;

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

/* Per-state tint for the Status cell's editable select — the same cream palette
   the old inline pill used, applied as the select's text/background so an
   overridden state still reads at a glance. */
const DSTATE_TONE: Record<DeliveryState, { bg: string; fg: string }> = {
  PENDING_DELIVERY: { bg: 'rgba(34, 31, 32, 0.06)', fg: '#767b6e' },
  PENDING_SCHEDULE: { bg: 'rgba(232, 107, 58, 0.12)', fg: '#0c3f39' },
  OVERDUE:          { bg: 'rgba(184, 51, 31, 0.12)', fg: '#b8331f' },
  DELIVERED:        { bg: 'rgba(47, 93, 79, 0.12)', fg: '#2f5d4f' },
};

/* ── Inline (Excel-style) cell editors ────────────────────────────────────────
   Each cell IS the control (no drill-in). All of them stopPropagation on click /
   double-click so editing a cell never selects the row or triggers the row's
   double-click → open-SO navigation. Every change persists immediately through
   useScheduleDelivery (shared `sched` mutation, optimistic + invalidate).

   Manual-override semantics (owner rule): the Status cell writes deliveryState —
   the backend treats this as the override that WINS over the derived state, so a
   coordinator can force e.g. an OVERDUE SO into PENDING_SCHEDULE. The real stock
   readiness stays visible in its own Stock column (never hidden by the override).

   SO rows write type:'so', id: so_doc_no — matching the amended_delivery_date /
   delivery_state override path on mfg_sales_orders. ASSR (service-case) rows are
   date-only for now: the Sched. Date cell writes type:'assr' (+ jobKind); their
   Status / Driver / Lorry cells are read-only / non-applicable (not wired yet). */
type SchedMutation = ReturnType<typeof useScheduleDelivery>;

/* Small shared wrapper so clicks inside an editor stay in the editor. */
const stopRow = {
  onClick: (e: ReactMouseEvent) => e.stopPropagation(),
  onDoubleClick: (e: ReactMouseEvent) => e.stopPropagation(),
};

function StatusEditCell({ order, sched }: { order: PlanningOrder; sched: SchedMutation }) {
  const tone = DSTATE_TONE[order.delivery_state];
  /* ASSR rows: the delivery-state override is not wired for service cases yet, so
     show the state read-only (as a tinted pill) instead of an editable select. */
  if (isAssr(order)) {
    return (
      <span
        className={styles.dstatePill}
        style={{ background: tone.bg, color: tone.fg }}
        title="Service-case state (override not wired for ASSR)"
      >
        {DELIVERY_STATE_LABEL[order.delivery_state]}
      </span>
    );
  }
  return (
    <select
      className={styles.inlineEdit}
      style={{ background: tone.bg, color: tone.fg, fontWeight: 600 }}
      value={order.delivery_state}
      disabled={sched.isPending}
      title="Manual delivery-state override (wins over the derived state)"
      {...stopRow}
      onChange={(e) => {
        const deliveryState = e.target.value as DeliveryState;
        if (deliveryState === order.delivery_state) return;
        sched.mutate({ type: 'so', id: order.so_doc_no, deliveryState });
      }}
    >
      {DELIVERY_STATES.map((s) => (
        <option key={s} value={s}>{DELIVERY_STATE_LABEL[s]}</option>
      ))}
    </select>
  );
}

/* Delivery date → scheduleDate → the SO's amended_delivery_date (the firm date;
   the customer's ORIGINAL customer_delivery_date is never overwritten). */
function ScheduleDateEditCell({ order, sched }: { order: PlanningOrder; sched: SchedMutation }) {
  const current = (order.amended_delivery_date ?? '').slice(0, 10);
  const assr = isAssr(order);
  return (
    <input
      type="date"
      className={styles.inlineEdit}
      value={current}
      disabled={sched.isPending}
      title={assr
        ? 'Scheduled date for this service-case job'
        : 'Firm / amended delivery date (original customer date is preserved)'}
      {...stopRow}
      onChange={(e) => {
        const v = e.target.value || null;   // clearing → null
        if ((v ?? '') === (current || '')) return;
        /* ASSR rows write back through the same hook with type:'assr' — the id is
           the service case's id and jobKind carries the row's kind (the backend
           now accepts this). SO rows keep their existing so-doc-no path. */
        if (assr) {
          sched.mutate({ type: 'assr', id: String(order.assr_id ?? ''), scheduleDate: v, jobKind: order.job_kind });
        } else {
          sched.mutate({ type: 'so', id: order.so_doc_no, scheduleDate: v });
        }
      }}
    />
  );
}

/* Sentinel for an existing crew assignment whose name/plate is NOT in the active
   master list — shown as a selected option so the cell never blanks an existing
   assignment; picking it is a no-op (guarded in onChange). */
const KEEP_CURRENT = '__current__';

function DriverEditCell({ order, sched, drivers }: { order: PlanningOrder; sched: SchedMutation; drivers: DriverRow[] }) {
  /* Driver assignment is not wired for ASSR rows yet → non-applicable. */
  if (isAssr(order)) return <NotApplicable />;
  /* No driver_id on the row (crew carries names only) → preselect by matching the
     current driver_1_name against the option list. */
  const currentName = order.crew?.driver_1_name ?? '';
  const matchedId = drivers.find((d) => d.name === currentName)?.id ?? '';
  const offList = currentName !== '' && matchedId === '';
  return (
    <select
      className={styles.inlineEdit}
      value={offList ? KEEP_CURRENT : matchedId}
      disabled={sched.isPending}
      {...stopRow}
      onChange={(e) => {
        const picked = e.target.value;
        if (picked === KEEP_CURRENT) return;   // re-picking the off-list current = no-op
        const driverId = picked || null;
        const driverNameOptimistic = driverId ? (drivers.find((d) => d.id === driverId)?.name ?? null) : null;
        sched.mutate({ type: 'so', id: order.so_doc_no, driverId, driverNameOptimistic });
      }}
    >
      <option value="">—</option>
      {/* Keep the current name selectable even if it's not (or no longer) in the
          active driver master, so an existing assignment never silently blanks. */}
      {offList && <option value={KEEP_CURRENT}>{currentName}</option>}
      {drivers.map((d) => (
        <option key={d.id} value={d.id}>{d.name}</option>
      ))}
    </select>
  );
}

function LorryEditCell({ order, sched, lorries }: { order: PlanningOrder; sched: SchedMutation; lorries: LorryRow[] }) {
  /* Lorry assignment is not wired for ASSR rows yet → non-applicable. */
  if (isAssr(order)) return <NotApplicable />;
  const currentPlate = order.crew?.lorry_plate ?? '';
  const matchedId = lorries.find((l) => l.plate === currentPlate)?.id ?? '';
  const offList = currentPlate !== '' && matchedId === '';
  return (
    <select
      className={styles.inlineEdit}
      value={offList ? KEEP_CURRENT : matchedId}
      disabled={sched.isPending}
      {...stopRow}
      onChange={(e) => {
        const picked = e.target.value;
        if (picked === KEEP_CURRENT) return;
        const lorryId = picked || null;
        const lorryPlateOptimistic = lorryId ? (lorries.find((l) => l.id === lorryId)?.plate ?? null) : null;
        sched.mutate({ type: 'so', id: order.so_doc_no, lorryId, lorryPlateOptimistic });
      }}
    >
      <option value="">—</option>
      {offList && <option value={KEEP_CURRENT}>{currentPlate}</option>}
      {lorries.map((l) => (
        <option key={l.id} value={l.id}>{l.plate}</option>
      ))}
    </select>
  );
}

/* Balance source-of-truth (mirrors the SO list's liveBalance, PR #83):
   the payment-totals view's balance_centi_live (local_total − Σpayments) when
   present, else the header's stored balance_centi. */
const liveBalance = (o: PlanningOrder): number =>
  typeof o.balance_centi_live === 'number' ? o.balance_centi_live : o.balance_centi;

/* days_left cell — overdue (<0) red, due-soon (0..3) burnt, else plain. */
function DaysLeftCell({ days }: { days: number | null }) {
  if (days == null) return <span style={{ color: '#767b6e' }}>—</span>;
  const cls = days < 0 ? styles.daysOverdue : days <= 3 ? styles.daysSoon : styles.daysOk;
  const label = days < 0 ? `${Math.abs(days)}d overdue` : days === 0 ? 'today' : `${days}d`;
  return <span className={cls}>{label}</span>;
}

/* ── SO line-item drill-down (parity with the Sales Order list) ───────────────
   Each planning row expands (▼ caret on the left, added by DataGrid's
   `expandable` API) to show that SO's line items — same four columns the SO list
   drill-down shows: Group · Item Code · Description · Description 2.

   Items are fetched from the SHARED cross-company endpoint
   `useDeliveryPlanningLines(docNo)` (GET /delivery-planning/:docNo/lines), scoped
   to the caller's ALLOWED companies — lazy-fetched per row on expand and
   TanStack-cached by doc_no, so re-expanding the same SO is instant. This
   deliberately does NOT reuse the per-company SO detail hook: that scopes to the
   ACTIVE company and 404s a cross-company (e.g. 2990) row on the shared board.
   The planning row already carries `so_doc_no`, which keys the fetch.

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
    accessor: (it) => <span style={{ fontWeight: 700, color: '#0c3f39' }}>{it.item_code ?? '—'}</span>,
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
      return summary ? <div>{summary}</div> : <span style={{ color: '#767b6e' }}>—</span>;
    },
    searchValue: (it) => buildVariantSummary(it.item_group, it.variants),
  },
];

const PlanningExpandedLines = ({ docNo }: { docNo: string }) => {
  /* SHARED-QUEUE line fetch — /delivery-planning/:docNo/lines, scoped to the
     caller's ALLOWED companies (not the active one). Lazy on expand, cached by
     doc_no. Using the cross-company endpoint (not the per-company SO detail)
     means a 2990 row opened while browsing as Houzs loads instead of 404ing. */
  const q = useDeliveryPlanningLines(docNo);
  if (q.isLoading) {
    return (
      <div style={{ padding: '8px 12px', fontSize: 'var(--fs-11)', color: '#767b6e' }}>
        Loading lines for {docNo}…
      </div>
    );
  }
  if (q.error) {
    return (
      <div style={{ padding: '8px 12px', fontSize: 'var(--fs-11)', color: '#b8331f' }}>
        Failed to load lines: {q.error instanceof Error ? q.error.message : String(q.error)}
      </div>
    );
  }
  const allItems = (q.data ?? []) as DrillItem[];
  /* Filter cancelled lines client-side — the lines endpoint returns them too
     (matches the SO list drill-down). */
  const items = allItems.filter((it) => !it.cancelled);

  if (items.length === 0) {
    return (
      <div style={{ padding: '8px 12px', fontSize: 'var(--fs-11)', color: '#767b6e' }}>
        No line items.
      </div>
    );
  }

  return (
    <div style={{
      padding: 'var(--space-2) var(--space-3) var(--space-2) 40px',
      background: '#fff',
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

  /* Inline-cell + bulk-edit write path (shared). The backend schedule endpoint
     already accepts scheduleDate / deliveryState / driverId / lorryId. */
  const sched = useScheduleDelivery();
  /* Option lists for the Driver / Lorry inline selects + the bulk value control.
     Active-only (the pickers offer current crew); an existing off-list assignment
     stays selectable via the cell's fallback <option>. */
  const { data: drivers = [] } = useDrivers();
  const { data: lorries = [] } = useLorries();

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

  /* Open a row's underlying document: an ASSR row goes to the SERVICE CASE detail
     (/assr/:id, keyed on the numeric case id); an SO row keeps its Sales Order
     route. Shared by the row double-click + the context-menu "Open" action. */
  const openRow = (o: PlanningOrder) => {
    if (isAssr(o)) {
      if (o.assr_id != null) navigate(`/assr/${o.assr_id}`);
    } else {
      navigate('/scm/sales-orders/' + o.so_doc_no);
    }
  };

  /* ── Bulk-edit bar state ────────────────────────────────────────────────────
     One field at a time: Status | Delivery date | Driver | Lorry. The second
     control's TYPE depends on the chosen field; `bulkValue` holds its raw value
     (state code / YYYY-MM-DD / driver id / lorry id). Apply fans out one
     useScheduleDelivery call per selected SO (capped concurrency), then clears
     the selection and reports a summary via the in-app NotifyDialog. */
  type BulkField = 'STATUS' | 'DATE' | 'DRIVER' | 'LORRY';
  const [bulkField, setBulkField] = useState<BulkField>('STATUS');
  const [bulkValue, setBulkValue] = useState<string>('');
  const [bulkBusy, setBulkBusy] = useState(false);

  /* Reset the value control whenever the field type changes (a date value makes
     no sense once the field is Driver, etc.). */
  const changeBulkField = (f: BulkField) => { setBulkField(f); setBulkValue(''); };

  /* Selection keys are prefixed (`so:<docNo>` / `assr:<id>`). The bulk actions
     (Convert-to-DO, Status/Date/Driver/Lorry) are SO-only — driver/lorry/state
     writes and DO conversion aren't wired for ASSR — so every bulk path operates
     on the SO doc_nos extracted from the selection. */
  const selectedSoDocNos = (): string[] =>
    [...sel].filter((k) => k.startsWith('so:')).map((k) => k.slice(3));

  const applyBulk = async () => {
    const docNos = selectedSoDocNos();
    if (docNos.length === 0 || bulkBusy) return;

    /* Build the single-field patch + a human label for the confirm/summary. */
    const patch: Partial<Parameters<typeof sched.mutateAsync>[0]> = {};
    let valueLabel = '';
    if (bulkField === 'STATUS') {
      if (!bulkValue) return;
      patch.deliveryState = bulkValue as DeliveryState;
      valueLabel = DELIVERY_STATE_LABEL[bulkValue as DeliveryState];
    } else if (bulkField === 'DATE') {
      patch.scheduleDate = bulkValue || null;   // empty → clear the amended date
      valueLabel = bulkValue || '(cleared)';
    } else if (bulkField === 'DRIVER') {
      patch.driverId = bulkValue || null;
      patch.driverNameOptimistic = bulkValue ? (drivers.find((d) => d.id === bulkValue)?.name ?? null) : null;
      valueLabel = bulkValue ? (drivers.find((d) => d.id === bulkValue)?.name ?? bulkValue) : '(none)';
    } else {
      patch.lorryId = bulkValue || null;
      patch.lorryPlateOptimistic = bulkValue ? (lorries.find((l) => l.id === bulkValue)?.plate ?? null) : null;
      valueLabel = bulkValue ? (lorries.find((l) => l.id === bulkValue)?.plate ?? bulkValue) : '(none)';
    }

    const fieldLabel = bulkField === 'STATUS' ? 'Status' : bulkField === 'DATE' ? 'Delivery date' : bulkField === 'DRIVER' ? 'Driver' : 'Lorry';
    if (!(await askConfirm({
      title: `Set ${fieldLabel} on ${docNos.length} order${docNos.length === 1 ? '' : 's'}?`,
      body: `${fieldLabel} → ${valueLabel} will be applied to every selected order.`,
      confirmLabel: `Apply to ${docNos.length}`,
    }))) return;

    setBulkBusy(true);
    let ok = 0;
    const failed: string[] = [];
    const LIMIT = 4;
    try {
      for (let i = 0; i < docNos.length; i += LIMIT) {
        const batch = docNos.slice(i, i + LIMIT);
        await Promise.all(batch.map(async (docNo) => {
          try {
            await sched.mutateAsync({ type: 'so', id: docNo, ...patch });
            ok += 1;
          } catch (e) {
            failed.push(`${docNo} (${e instanceof Error ? e.message : String(e)})`);
          }
        }));
      }
    } finally {
      setBulkBusy(false);
    }
    setSel(new Set());
    setBulkValue('');
    const parts = [`${fieldLabel} set to ${valueLabel} on ${ok} order${ok === 1 ? '' : 's'}.`];
    if (failed.length > 0) parts.push(`Failed ${failed.length}: ${failed.join('; ')}.`);
    notify({
      title: failed.length > 0 ? 'Bulk update finished with errors' : 'Bulk update complete',
      body: parts.join(' '),
      tone: failed.length > 0 ? 'error' : 'info',
    });
  };

  /* Bulk convert (selection bar) — confirm first (useConfirm, no window.*). */
  const convertSelected = async () => {
    const docNos = selectedSoDocNos();
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

  const columns = useMemo<DataGridColumn<PlanningOrder>[]>(() => [
    {
      /* Row type — SO delivery vs ASSR (service-case) job. A chip per row so the
         two kinds read apart at a glance. */
      key: 'row_type', label: 'Type', width: 130, groupable: true,
      accessor: (o) => <TypeChip order={o} />,
      searchValue: (o) => (isAssr(o) ? (o.job_kind === 'customer_pickup' ? 'Cust. pickup customer pickup' : 'Delivery') : 'SO delivery'),
      groupValue: (o) => (isAssr(o) ? (o.job_kind === 'customer_pickup' ? 'Cust. pickup' : 'Delivery') : 'SO delivery'),
      exportValue: (o) => (isAssr(o) ? (o.job_kind === 'customer_pickup' ? 'Cust. pickup' : 'Delivery') : 'SO delivery'),
    },
    {
      /* SO No. for SO rows; the ASSR ref (assr_no) for service-case rows. */
      key: 'so_doc_no', label: 'SO / Ref', width: 150, sortable: true,
      accessor: (o) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', fontWeight: 700, color: '#0c3f39', fontVariantNumeric: 'tabular-nums' }}>
          {isAssr(o) ? (o.ref ?? '—') : o.so_doc_no}
        </span>
      ),
      searchValue: (o) => (isAssr(o) ? (o.ref ?? '') : o.so_doc_no),
      exportValue: (o) => (isAssr(o) ? (o.ref ?? '') : o.so_doc_no),
      sortFn: (a, b) => (isAssr(a) ? (a.ref ?? '') : a.so_doc_no).localeCompare(isAssr(b) ? (b.ref ?? '') : b.so_doc_no),
    },
    {
      /* Company — the SHARED cross-company queue serves both HOUZS + 2990, so
         each row is tagged with its owning company. Default-VISIBLE so the two
         companies read apart at a glance. ASSR rows have no company (dash). */
      key: 'company_code', label: 'Company', width: 90, groupable: true,
      accessor: (o) => <CompanyBadge code={o.company_code ?? null} />,
      searchValue: (o) => o.company_code ?? '',
      groupValue: (o) => o.company_code ?? '(none)',
      exportValue: (o) => o.company_code ?? '',
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
      accessor: (o) => (
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>
          {fmtDateOrDash(o.customer_delivery_date)}
        </span>
      ),
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
      /* ASSR rows carry no stock/DO data → non-applicable. */
      accessor: (o) => (isAssr(o) ? <NotApplicable /> : (
        <span style={{ fontSize: 'var(--fs-12)', color: o.stock_status === 'PENDING' ? '#767b6e' : '#2f5d4f' }}>
          {o.stock_remark || o.stock_status}
        </span>
      )),
      searchValue: (o) => (isAssr(o) ? '' : `${o.stock_remark} ${o.stock_status}`.trim()),
      groupValue: (o) => (isAssr(o) ? '(n/a)' : o.stock_status),
    },
    {
      key: 'delivery_state', label: 'State', width: 160, sortable: true, groupable: true,
      /* Inline-editable: writes a manual delivery_state override (wins over the
         derived state). Real stock readiness stays visible in the Stock column. */
      accessor: (o) => <StatusEditCell order={o} sched={sched} />,
      searchValue: (o) => DELIVERY_STATE_LABEL[o.delivery_state],
      groupValue: (o) => DELIVERY_STATE_LABEL[o.delivery_state],
      exportValue: (o) => DELIVERY_STATE_LABEL[o.delivery_state],
      sortFn: (a, b) => a.delivery_state.localeCompare(b.delivery_state),
    },
    {
      /* Inline-editable firm/amended delivery date → scheduleDate (writes the SO's
         amended_delivery_date; the customer's original date is preserved). Shown
         by default so operators can plan without opening the HC drawer. */
      key: 'sched_date', label: 'Sched. Date', width: 150, sortable: true,
      accessor: (o) => <ScheduleDateEditCell order={o} sched={sched} />,
      searchValue: (o) => o.amended_delivery_date ?? '',
      exportValue: (o) => fmtDateOrDash(o.amended_delivery_date),
      sortFn: (a, b) => String(a.amended_delivery_date ?? '').localeCompare(String(b.amended_delivery_date ?? '')),
      filterType: 'date', dateValue: (o) => o.amended_delivery_date,
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
      /* Inline-editable: assigns the trip driver (writes driverId; the backend
         find-or-creates the trip + appends the stop). */
      key: 'driver', label: 'Driver', width: 160,
      accessor: (o) => <DriverEditCell order={o} sched={sched} drivers={drivers} />,
      searchValue: (o) => o.crew?.driver_1_name ?? '',
      exportValue: (o) => o.crew?.driver_1_name ?? '',
    },
    {
      key: 'driver_ic', label: 'Driver IC', width: 140, defaultHidden: true,
      accessor: (o) => o.crew?.driver_1_ic || <span style={{ color: '#767b6e' }}>—</span>,
      searchValue: (o) => o.crew?.driver_1_ic ?? '',
    },
    {
      key: 'driver_contact', label: 'Driver Contact', width: 150, defaultHidden: true,
      accessor: (o) => (o.crew?.driver_1_contact ? formatPhone(o.crew.driver_1_contact) || o.crew.driver_1_contact : <span style={{ color: '#767b6e' }}>—</span>),
      searchValue: (o) => o.crew?.driver_1_contact ?? '',
    },
    {
      key: 'driver_2', label: 'Driver 2', width: 150, defaultHidden: true,
      accessor: (o) => o.crew?.driver_2_name || <span style={{ color: '#767b6e' }}>—</span>,
      searchValue: (o) => o.crew?.driver_2_name ?? '',
    },
    {
      key: 'helper_1', label: 'Helper 1', width: 150, defaultHidden: true,
      accessor: (o) => o.crew?.helper_1_name || <span style={{ color: '#767b6e' }}>—</span>,
      searchValue: (o) => o.crew?.helper_1_name ?? '',
    },
    {
      key: 'helper_2', label: 'Helper 2', width: 150, defaultHidden: true,
      accessor: (o) => o.crew?.helper_2_name || <span style={{ color: '#767b6e' }}>—</span>,
      searchValue: (o) => o.crew?.helper_2_name ?? '',
    },
    {
      /* Inline-editable: assigns the trip lorry (writes lorryId). */
      key: 'lorry', label: 'Lorry', width: 150,
      accessor: (o) => <LorryEditCell order={o} sched={sched} lorries={lorries} />,
      searchValue: (o) => o.crew?.lorry_plate ?? '',
      exportValue: (o) => o.crew?.lorry_plate ?? '',
    },
    {
      key: 'balance_centi', label: 'Balance', width: 130, align: 'right', sortable: true,
      accessor: (o) => (
        <span style={{ fontFamily: 'var(--font-mark)', fontWeight: 700, color: liveBalance(o) > 0 ? '#0c3f39' : '#767b6e' }}>
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
  // The EM/SG cross-border default-show (isEmSg) depends on activeRegion →
  // recompute the columns on region change. regionLabel feeds the Region column's
  // display labels (from the config master). The editable Status/Date/Driver/Lorry
  // accessors close over `sched` + the driver/lorry option lists, so they join the
  // deps (a new driver/lorry list must re-render the pickers).
  ], [activeRegion, regionLabel, sched, drivers, lorries]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Delivery"
        title="Delivery Planning"
        description={`Orders that need delivering · grouped by region (customer state) · ${counts.ALL} in ${activeRegionLabel}`}
        primaryAction={
          /* Secondary header control — open the owner-maintained region-bucket
             master (formerly a standalone sidebar line; now reached from here).
             Kept as an inline <Button> rather than a `secondaryActions` MenuItem
             so it keeps its MapPinned icon. */
          <Button variant="secondary" onClick={() => navigate('/scm/delivery-planning-regions')}>
            <MapPinned size={16} strokeWidth={1.75} />
            Manage regions
          </Button>
        }
      />

      {/* 4 STATE TABS (top row) — Pending Delivery / Pending Schedule / Overdue / Delivered, with counts.
          Reskinned to the design-system underline rail (was the bespoke
          .stateTabs/.stateTab, whose colours only resolved via the removed
          .page cascade). OVERDUE keeps its red tone so a backlog reads at a
          glance; the count badge tints with the active/overdue state. */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border pb-0.5">
        {([{ key: 'ALL' as const, label: 'All' },
           ...STATE_TABS.map((s) => ({ key: s, label: DELIVERY_STATE_LABEL[s] }))]
        ).map((t) => {
          const active = activeState === t.key;
          const overdue = t.key === 'OVERDUE';
          return (
            <button
              key={t.key}
              type="button"
              className={[
                'inline-flex h-[34px] items-center gap-2 whitespace-nowrap border-b-2 px-3 text-[12px] font-semibold transition-colors duration-150',
                overdue
                  ? 'text-err'
                  : active
                    ? 'text-primary-ink'
                    : 'text-ink-muted hover:text-ink',
                active
                  ? (overdue ? 'border-err' : 'border-primary-ink')
                  : 'border-transparent',
              ].join(' ')}
              onClick={() => setState(t.key)}
            >
              {t.label}
              <span
                className={[
                  'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-[5px] font-mono text-[11px] font-bold tabular-nums',
                  active
                    ? (overdue ? 'bg-err/10 text-err' : 'bg-primary-soft text-primary-ink')
                    : 'bg-surface-dim text-ink-muted',
                ].join(' ')}
              >
                {counts[t.key]}
              </span>
            </button>
          );
        })}
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
        <div className="rounded-lg border border-err/40 bg-err/10 px-4 py-3 text-[13px] text-err">
          <strong>Failed to load delivery planning.</strong>{' '}
          {error instanceof Error ? error.message : String(error)}
        </div>
      )}

      {/* Compact bulk-edit bar — appears once one or more rows are ticked.
          "<N> selected · Set [field] → [value] [Apply]" mass-writes one field
          across every selected SO via useScheduleDelivery; the value control's
          TYPE follows the chosen field. The existing "Convert N to DO" bulk
          action is folded in on the right. */}
      {sel.size > 0 && (
        <div className={styles.bulkBar}>
          <span className={styles.bulkCount}>{sel.size} selected</span>
          <span className={styles.bulkSep}>·</span>
          <span className={styles.bulkLabel}>Set</span>
          <select
            className={styles.bulkControl}
            style={{ minWidth: 130 }}
            value={bulkField}
            disabled={bulkBusy}
            onChange={(e) => changeBulkField(e.target.value as typeof bulkField)}
            aria-label="Bulk-edit field"
          >
            <option value="STATUS">Status</option>
            <option value="DATE">Delivery date</option>
            <option value="DRIVER">Driver</option>
            <option value="LORRY">Lorry</option>
          </select>
          <span className={styles.bulkLabel}>&rarr;</span>
          {/* Value control — type depends on the field. */}
          {bulkField === 'STATUS' && (
            <select
              className={styles.bulkControl}
              value={bulkValue}
              disabled={bulkBusy}
              onChange={(e) => setBulkValue(e.target.value)}
              aria-label="New status"
            >
              <option value="">Choose status…</option>
              {DELIVERY_STATES.map((s) => (
                <option key={s} value={s}>{DELIVERY_STATE_LABEL[s]}</option>
              ))}
            </select>
          )}
          {bulkField === 'DATE' && (
            <input
              type="date"
              className={styles.bulkControl}
              value={bulkValue}
              disabled={bulkBusy}
              onChange={(e) => setBulkValue(e.target.value)}
              aria-label="New delivery date"
            />
          )}
          {bulkField === 'DRIVER' && (
            <select
              className={styles.bulkControl}
              value={bulkValue}
              disabled={bulkBusy}
              onChange={(e) => setBulkValue(e.target.value)}
              aria-label="New driver"
            >
              <option value="">Unassign / choose driver…</option>
              {drivers.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          )}
          {bulkField === 'LORRY' && (
            <select
              className={styles.bulkControl}
              value={bulkValue}
              disabled={bulkBusy}
              onChange={(e) => setBulkValue(e.target.value)}
              aria-label="New lorry"
            >
              <option value="">Unassign / choose lorry…</option>
              {lorries.map((l) => (
                <option key={l.id} value={l.id}>{l.plate}</option>
              ))}
            </select>
          )}
          <Button
            variant="primary"
            disabled={bulkBusy || (bulkField === 'STATUS' && !bulkValue)}
            onClick={() => void applyBulk()}
          >
            {bulkBusy ? 'Applying…' : 'Apply'}
          </Button>

          <span className={styles.bulkSpacer} />

          <Button variant="secondary" disabled={convertSos.isPending} onClick={() => void convertSelected()}>
            <Truck size={14} strokeWidth={1.75} />
            <span>{convertSos.isPending ? 'Converting…' : `Convert ${sel.size} to DO`}</span>
          </Button>
          <Button variant="ghost" onClick={() => setSel(new Set())} title="Clear selection">x</Button>
        </div>
      )}

      <DataGrid
        rows={rows}
        columns={columns}
        storageKey="dg-delivery-planning"
        exportName="DeliveryPlanning"
        rowKey={rowIdOf}
        searchPlaceholder="Search SO / ref / customer / phone…"
        groupBanner={false}
        isLoading={isLoading}
        emptyMessage="No orders need delivering in this view."
        /* First-class multi-select (prefixed so:/assr: keys) → the bulk bar. The
           bulk actions themselves are SO-only (see selectedSoDocNos). */
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
        onRowDoubleClick={openRow}
        expandable={{
          /* Line-item drill-down is SO-only (ASSR rows carry no SO lines). */
          renderExpansion: (row) => (isAssr(row) ? null : <PlanningExpandedLines docNo={row.so_doc_no} />),
          /* Falsy key suppresses the expand chevron for ASSR rows. */
          rowExpansionKey: (row) => (isAssr(row) ? '' : row.so_doc_no),
        }}
        rowStyle={(o) => (o.region === 'SG' ? { boxShadow: 'inset 3px 0 0 #2f5d4f' } : undefined)}
        contextMenu={(row) => (isAssr(row)
          ? [
              { label: 'Open Service Case', onClick: () => openRow(row) },
            ]
          : [
              { label: 'Edit HC fields…', onClick: () => setEditing(row) },
              { label: 'Convert to DO', onClick: () => convertOne(row) },
              { divider: true },
              { label: 'Open Sales Order', onClick: () => openRow(row) },
            ])}
      />

      {/* Per-row HC fields editor (right-click → Edit HC fields). SO-context
          always editable; DO-execution editable only when the order has a DO. */}
      {editing && (
        <DeliveryFieldsDrawer order={editing} onClose={() => setEditing(null)} />
      )}
    </div>
  );
};
