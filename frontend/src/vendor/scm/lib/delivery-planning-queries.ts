// Vendored from apps/backend/src/lib/delivery-planning-queries.ts — Delivery
// Planning queries (STAGE 4 of the Delivery / TMS module). Reads the planning
// board (GET /delivery-planning) + the per-doc schedule date. Cloned from the
// drivers / lorries query pattern (TanStack Query + authedFetch). Rows are
// snake_case as the API emits them; consumers dual-read camelCase where the pg
// driver would camelCase a column.
//
// NOTE: the "delivery leg" (multi-hop / dual-trip) hooks were REMOVED — China-PO
// transit flow, not in use yet; re-add later.
//
// HOUZS VENDOR NOTE: the source has NO `import { supabase } from './supabase'`
// to drop (it only used authedFetch). Everything else is copied verbatim.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { invalidateSoLists } from './sales-order-queries';

export const DELIVERY_STATES = [
  'PENDING_DELIVERY', 'PENDING_SCHEDULE', 'OVERDUE', 'DELIVERED',
] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];

export const DELIVERY_STATE_LABEL: Record<DeliveryState, string> = {
  PENDING_DELIVERY: 'Pending Delivery',
  PENDING_SCHEDULE: 'Pending Schedule',
  OVERDUE: 'Overdue',
  DELIVERED: 'Delivered',
};

// A region is a CONFIG-DRIVEN bucket code (migration 0198) derived from the
// customer's STATE (not the line warehouse). The seeded defaults are KL · Penang
// · EM (East Malaysia: Sabah/Sarawak/Labuan) · SG (Singapore), but the owner can
// add more in the Delivery Regions master, so a region code is now an OPEN string
// (not a fixed union). 'ALL' is the no-filter param; the rest are bucket codes.
export type RegionCode = string;
export type RegionKey = 'ALL' | RegionCode;

/* A board row is either a Sales-Order delivery (the original rows) or a
   Service-Case (ASSR) job. row_type discriminates; it defaults to 'so' for the
   long-standing SO rows (the backend now stamps it explicitly on every row). */
export type PlanningRowType = 'so' | 'assr' | 'dp';
/* ASSR job kind (only meaningful when row_type === 'assr'). */
export type AssrJobKind = 'customer_pickup' | 'delivery';

export type PlanningOrder = {
  /* SO rows: 'so' (default). ASSR (service-case) rows: 'assr'. DP-Order jobs
     (manual setup / dismantle / supplier-pickup, no source SO) : 'dp'. */
  row_type: PlanningRowType;
  /* DP-only. The DP job type (DELIVERY/PICKUP/SERVICE/SETUP/DISMANTLE/
     SUPPLIER_PICKUP) and the minted DP number (null until scheduled). Null on
     SO/ASSR rows. */
  dp_job_type?: string | null;
  dp_no?: string | null;
  /* ASSR-only. The service case's NUMERIC id (drives the /assr/:id detail route)
     and its human ref (= assr_no, shown in the SO No. cell). null on SO rows. */
  assr_id: number | null;
  ref: string | null;
  /* ASSR-only. Whether the job is a customer pickup or a delivery. null on SO
     rows. */
  job_kind: AssrJobKind | null;
  so_doc_no: string;
  debtor_code: string | null;
  debtor_name: string | null;
  phone: string | null;
  branding: string | null;
  status: string;
  delivery_state: DeliveryState;
  delivery_state_override: string | null;
  balance_centi: number;
  /* Live balance (= local_total − Σpayments, from the SO-list payment-totals
     view); null when the view has no row → fall back to balance_centi. */
  balance_centi_live: number | null;
  local_total_centi: number;
  so_date: string | null;
  processing_date: string | null;
  /* The customer's ORIGINAL delivery date — never overwritten (migration 0199). */
  customer_delivery_date: string | null;
  /* Amendment dates (migration 0199): the customer's requested NEW date and the
     date WE confirmed (the proposed/amended delivery date). effective = amended ??
     original, what Days Left / OVERDUE actually use. */
  amend_date_from_customer: string | null;
  amended_delivery_date: string | null;
  /* HC "Amend Client Date Reason" (migration 0201) — free-text reason paired
     with the amend dates above. */
  amend_reason: string | null;
  effective_delivery_date: string | null;
  internal_expected_dd: string | null;
  days_left: number | null;
  /* HC delivery-sheet address columns. */
  address: string | null;
  postcode: string | null;
  building_type: string | null;
  /* HC SO-context raw-data fields (migration 0197), always editable. */
  possession_date: string | null;
  house_type: string | null;
  replacement_disposal: string | null;
  referral: string | null;
  /* HC DO-execution raw-data fields (migration 0197), from the latest DO;
     null when this SO has no DO yet (editable only once a DO exists). */
  time_range: string | null;
  time_confirmed: boolean | null;
  arrival_at: string | null;
  departure_at: string | null;
  shipout_date: string | null;
  customer_delivered_date: string | null;
  eta_arriving_port: string | null;
  delivery_substatus: string | null;
  /* EM-region cross-border transit-warehouse arrival date (migration 0199),
     from the latest DO; null when no DO. */
  arrives_em_warehouse_date: string | null;
  /* The latest DO's OWN document date (delivery_orders.do_date); null when this
     SO has no (non-DRAFT/CANCELLED) DO yet — drives the "DO Date" grid column. */
  do_date: string | null;
  stock_status: string;
  stock_remark: string;
  is_main_ready: boolean;
  /* Multi-company: readable company code for the SHARED cross-company queue
     (e.g. 'HOUZS' / '2990'). null on ASSR rows or when unresolved. */
  company_code?: string | null;
  region: RegionCode;   // the order's primary bucket (from customer_state)
  regions: RegionCode[];  // primary + any leg buckets
  warehouse_id: string | null;
  warehouse_code: string | null;
  warehouse_name: string | null;
  customer_state: string | null;
  delivered_qty: number;
  remaining_qty: number;
  crew: {
    driver: string | null; helper: string | null; lorry: string | null;
    driver_1_name: string | null; driver_1_ic: string | null; driver_1_contact: string | null;
    driver_2_name: string | null;
    helper_1_name: string | null; helper_2_name: string | null;
    lorry_plate: string | null;
  } | null;
  delivery_orders: Array<{ id: string; do_number: string; status: string }>;
};

export type PlanningCounts = Record<'ALL' | DeliveryState, number>;

export type PlanningResponse = {
  orders: PlanningOrder[];
  counts: PlanningCounts;
  regions: Array<{ key: RegionKey; label: string }>;
};

/* The board. region = ALL | KL | PENANG | EM | SG; state = DeliveryState | 'ALL'.
   Counts come back scoped to the active region (not the state) so the 4 state
   tab badges stay stable as the operator switches between state tabs. */
export function useDeliveryPlanning(opts: { region?: string; state?: string }) {
  const region = opts.region ?? 'ALL';
  const state = opts.state ?? 'ALL';
  return useQuery({
    queryKey: ['delivery-planning', region, state],
    queryFn: () => {
      const params = new URLSearchParams();
      if (region !== 'ALL') params.set('region', region);
      if (state !== 'ALL') params.set('state', state);
      const qs = params.toString();
      return authedFetch<PlanningResponse>(`/delivery-planning${qs ? `?${qs}` : ''}`);
    },
    // Switching region / state tabs keeps the previous board on screen while the
    // next slice loads, instead of flashing an empty table (keepPreviousData).
    placeholderData: (prev) => prev,
    staleTime: 30_000,
  });
}

/* One expand-row line item, as GET /delivery-planning/:docNo/lines emits it
   (snake_case, no transform). Mirrors the SO-detail item columns the board's
   drill-down consumes (group / code / description / variants / cancelled). */
export type PlanningLineItem = {
  id: string;
  doc_no: string | null;
  item_group: string | null;
  item_code: string | null;
  description: string | null;
  description2: string | null;
  uom: string | null;
  qty: number | null;
  unit_price_centi: number | null;
  discount_centi: number | null;
  total_centi: number | null;
  variants: Record<string, unknown> | null;
  stock_status: string | null;
  cancelled: boolean | null;
};

/* Expand-row lines for one SO on the SHARED cross-company board. Uses the
   dedicated /delivery-planning/:docNo/lines endpoint (scoped to the caller's
   ALLOWED companies) instead of the PER-COMPANY SO detail — so expanding a
   cross-company (e.g. 2990) row while browsing as Houzs no longer 404s. Lazy
   (enabled only when a docNo is set) + cached by docNo. */
export function useDeliveryPlanningLines(docNo: string | null | undefined) {
  return useQuery({
    queryKey: ['delivery-planning', 'lines', docNo],
    enabled: !!docNo,
    queryFn: () =>
      authedFetch<{ items: PlanningLineItem[] }>(
        `/delivery-planning/${encodeURIComponent(docNo!)}/lines`,
      ).then((r) => r.items),
    staleTime: 30_000,
  });
}

/* HC "Remark 4" delivery sub-status — the known values (must mirror the API
   whitelist). Blank ('') is always allowed (clears it). */
export const HC_SUBSTATUS_VALUES = [
  'Pending Pickup', 'Done Shipout', 'Arrives EM Warehouse',
  'Done Delivered', 'Confirm', 'House Not Ready', 'Request Hold',
] as const;
export type HcSubstatus = (typeof HC_SUBSTATUS_VALUES)[number];

/* The editable HC fields (migration 0197), split by where they're owned. The
   SO-context fields always save; the DO-execution fields need a DO to land on. */
export type HcFieldsPatch = {
  // SO-context (→ mfg_sales_orders)
  possessionDate?: string | null;
  houseType?: string | null;
  replacementDisposal?: string | null;
  referral?: string | null;
  // DO-execution (→ delivery_orders, when a DO exists)
  timeRange?: string | null;
  timeConfirmed?: boolean | null;
  arrivalAt?: string | null;
  departureAt?: string | null;
  shipoutDate?: string | null;
  customerDeliveredDate?: string | null;
  etaArrivingPort?: string | null;
  deliverySubstatus?: string | null;
};

export type HcFieldsResult = {
  ok: true;
  written: { so: boolean; do: boolean };
  do_id: string | null;
  so_doc_no: string | null;
  /* Set when DO-execution fields were submitted but no DO exists yet. */
  no_do_hint: string | null;
};

/* Save the HC raw-data fields for an order. type = 'so' | 'do'; id = SO doc_no
   or DO id. Calls PATCH /delivery-planning/:type/:id/fields and invalidates the
   planning board. The result's no_do_hint tells the UI when DO-execution fields
   were skipped because there's no DO. */
export function useUpdateDeliveryFields() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ type, id, ...body }: { type: 'so' | 'do'; id: string } & HcFieldsPatch) =>
      authedFetch<HcFieldsResult>(`/delivery-planning/${type}/${id}/fields`, {
        method: 'PATCH', body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['delivery-planning'] }),
  });
}

/* The DP job-type vocabulary — the SINGLE source of truth for the set the whole
   Delivery Planning surface uses. Mirrors the `scm.trip_stop_type` enum (mig 0053
   + SUPPLIER_PICKUP in 0128), ORDERED as the enum declares them so the create
   dropdown and any future list read the same order. Both the New-DP-Order dropdown
   AND the board's Type chip resolve their label from DP_JOB_TYPE_LABEL below, so
   the value a user PICKS is byte-identical to what the board SHOWS — they can no
   longer drift (owner: the dropdown type must equal the type we normally show). */
export const DP_JOB_TYPES = [
  'DELIVERY', 'PICKUP', 'SERVICE', 'SETUP', 'DISMANTLE', 'SUPPLIER_PICKUP',
] as const;
export type DpJobType = (typeof DP_JOB_TYPES)[number];

export const DP_JOB_TYPE_LABEL: Record<DpJobType, string> = {
  DELIVERY: 'Delivery',
  PICKUP: 'Pickup',
  SERVICE: 'Service',
  SETUP: 'Setup',
  DISMANTLE: 'Dismantle',
  SUPPLIER_PICKUP: 'Supplier Pickup',
};

/* The label the board / dropdown show for a DP job type. Reads the canonical map;
   falls back to a Title-Cased prettify for any value not in the set (defensive —
   the board's Type chip previously prettified inline, so unknown/legacy stored
   values keep rendering rather than blanking). */
export const dpJobTypeLabel = (value: string | null | undefined): string => {
  const key = (value ?? '').toUpperCase();
  if (key in DP_JOB_TYPE_LABEL) return DP_JOB_TYPE_LABEL[key as DpJobType];
  return (value ?? '')
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (m) => m.toUpperCase());
};

/* Create a DP Order (delivery-planning job). The server auto-fills the party from
   whichever source ref is given (SO / supplier / project / service case); manual
   `overrides` win over the auto-fill. POST /dp-orders, then the board refreshes. */
export type DpOrderCreate = {
  jobType: DpJobType;
  soDocNo?: string;
  supplierId?: string;
  projectId?: number;
  assrCaseId?: number;
  requestedDate?: string;
  remark?: string;
  overrides?: Record<string, string | null>;
};
export function useCreateDpOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: DpOrderCreate) =>
      authedFetch<{ dpOrder: unknown }>(`/dp-orders`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['delivery-planning'] }),
  });
}

/* Cancel a DP Order (and drop its trip stop, backend-side). */
export function useCancelDpOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      authedFetch<{ stopRemoved?: { failed?: boolean; reason?: string } }>(
        `/dp-orders/${id}/cancel`, { method: 'POST', body: JSON.stringify({}) },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['delivery-planning'] }),
  });
}

/* Set the concrete schedule date (+ optional manual delivery_state override,
   + optional driver / lorry trip-wiring) on an SO or DO. type = 'so' | 'do';
   id = SO doc_no or DO id.

   NOTE (Delivery Planning inline-edit, 2026-07): the board's inline cells write
   through THIS hook. The backend schedule endpoint already accepts driverId /
   lorryId / tripId / tripDate / warehouseId (it find-or-creates a trip and
   appends a stop); the previous frontend signature dropped them, so we widen it
   here to forward driverId / lorryId. The `*Optimistic` fields are DISPLAY-ONLY
   values (driver name / lorry plate / the effective delivery date) used purely
   for the optimistic cache patch — they are NOT sent to the API. */
export type ScheduleDeliveryVars = {
  /* 'so' | 'do' are the original SO/DO schedule paths. 'assr' schedules a
     service-case job (Delivery Planning ASSR rows) — the backend now accepts it;
     for ASSR the id is the service case's id and jobKind carries the row's kind. */
  type: 'so' | 'do' | 'assr';
  id: string;
  scheduleDate?: string | null;
  deliveryState?: DeliveryState | null;
  driverId?: string | null;
  lorryId?: string | null;
  /* ASSR-only: forwarded so the backend knows which job (pickup vs delivery) is
     being scheduled. Ignored for 'so' | 'do'. */
  jobKind?: AssrJobKind | null;
  /* Display-only, for optimistic UI (never posted). */
  driverNameOptimistic?: string | null;
  lorryPlateOptimistic?: string | null;
};

export function useScheduleDelivery() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, ScheduleDeliveryVars, { snapshots: Array<[readonly unknown[], PlanningResponse]> }>({
    mutationFn: ({ type, id, scheduleDate, deliveryState, driverId, lorryId, jobKind }) => {
      /* Only include keys the caller actually set, so an unrelated field is never
         nulled out by an inline single-field edit. */
      const body: Record<string, unknown> = {};
      if (scheduleDate !== undefined) body.scheduleDate = scheduleDate;
      if (deliveryState !== undefined) body.deliveryState = deliveryState;
      if (driverId !== undefined) body.driverId = driverId;
      if (lorryId !== undefined) body.lorryId = lorryId;
      if (jobKind !== undefined) body.jobKind = jobKind;
      return authedFetch<{ ok: true }>(`/delivery-planning/${type}/${id}/schedule`, {
        method: 'PATCH', body: JSON.stringify(body),
      });
    },
    /* Optimistic patch — reflect the edit immediately on every cached planning
       board (all region/state keys), then invalidate on settle for the truth. */
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: ['delivery-planning'] });
      const entries = qc.getQueriesData<PlanningResponse>({ queryKey: ['delivery-planning'] });
      const snapshots: Array<[readonly unknown[], PlanningResponse]> = [];
      for (const [key, prev] of entries) {
        if (!prev) continue;
        snapshots.push([key, prev]);
        qc.setQueryData<PlanningResponse>(key, {
          ...prev,
          orders: prev.orders.map((o) => {
            /* Match by the row's identity: ASSR rows key on the numeric case id
               (vars.id is that id as a string); SO/DO rows key on so_doc_no. */
            const matches = vars.type === 'assr'
              ? o.row_type === 'assr' && String(o.assr_id ?? '') === vars.id
              : o.so_doc_no === vars.id;
            if (!matches) return o;
            const next: PlanningOrder = { ...o };
            if (vars.deliveryState !== undefined && vars.deliveryState !== null) next.delivery_state = vars.deliveryState;
            if (vars.scheduleDate !== undefined) next.amended_delivery_date = vars.scheduleDate;
            if (vars.driverNameOptimistic !== undefined || vars.lorryPlateOptimistic !== undefined) {
              const crew = { ...(o.crew ?? { driver: null, helper: null, lorry: null, driver_1_name: null, driver_1_ic: null, driver_1_contact: null, driver_2_name: null, helper_1_name: null, helper_2_name: null, lorry_plate: null }) };
              if (vars.driverNameOptimistic !== undefined) crew.driver_1_name = vars.driverNameOptimistic;
              if (vars.lorryPlateOptimistic !== undefined) crew.lorry_plate = vars.lorryPlateOptimistic;
              next.crew = crew;
            }
            return next;
          }),
        });
      }
      return { snapshots };
    },
    onError: (_err, _vars, ctx) => {
      /* Roll every board back to its pre-edit snapshot. */
      for (const [key, prev] of ctx?.snapshots ?? []) qc.setQueryData(key, prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['delivery-planning'] }),
  });
}

/* ── Convert SO → DO from the Delivery Planning board ──────────────────────────
   REUSES the existing line-level converter POST /delivery-orders-mfg/from-sos
   (the variant-carry fix already lives there). That endpoint is LINE-level —
   it takes picks: [{ soItemId, qty }] and creates ONE DO from those lines,
   MERGING into one DO when picks span >1 SO. To keep "one DO per Sales Order"
   semantics here (single + multi-select), we resolve each SO's still-deliverable
   lines and call from-sos ONCE PER SO (sequential with a small concurrency
   limit), never one merged call.

   The already-has-DO guard is intrinsic: from-sos only converts the line-level
   REMAINING (qty − delivered + returned), so an SO with every line fully
   delivered yields zero deliverable lines → it is reported as `skipped`
   (already_delivered) and never double-converted. */

type DeliverablePickLine = { soItemId: string; docNo: string; remaining: number };

export type ConvertSoResult = {
  /** SOs that produced a new DO. */
  converted: Array<{ docNo: string; doNumber: string }>;
  /** SOs with nothing left to deliver (no remaining lines) — not converted. */
  skipped: Array<{ docNo: string; reason: 'already_delivered' }>;
  /** SOs the endpoint rejected (e.g. sofa no-batch / short-stock / race). */
  failed: Array<{ docNo: string; message: string }>;
};

/* Resolve still-deliverable lines for the given SOs, then convert one DO per SO
   by reusing from-sos. Concurrency capped so a large bulk select doesn't fan out
   into a burst of Worker subrequests. */
export function useConvertSosToDo() {
  const qc = useQueryClient();
  return useMutation<ConvertSoResult, Error, { docNos: string[] }>({
    mutationFn: async ({ docNos }) => {
      const wanted = [...new Set(docNos.filter(Boolean))];
      const out: ConvertSoResult = { converted: [], skipped: [], failed: [] };
      if (wanted.length === 0) return out;

      // 1. One batched read of the deliverable (remaining > 0) lines for every
      //    selected SO, grouped by doc_no.
      const qs = wanted.map((d) => encodeURIComponent(d)).join(',');
      const { lines } = await authedFetch<{ lines: DeliverablePickLine[] }>(
        `/delivery-orders-mfg/deliverable-so-lines?docNos=${qs}`,
      );
      const picksByDoc = new Map<string, Array<{ soItemId: string; qty: number }>>();
      for (const l of lines) {
        if (!l.soItemId || !(l.remaining > 0)) continue;
        const arr = picksByDoc.get(l.docNo) ?? [];
        arr.push({ soItemId: l.soItemId, qty: l.remaining });
        picksByDoc.set(l.docNo, arr);
      }

      // 2. SOs with no deliverable lines → already fully delivered (or no lines).
      for (const docNo of wanted) {
        if (!picksByDoc.has(docNo)) out.skipped.push({ docNo, reason: 'already_delivered' });
      }

      // 3. Convert one DO per SO, capped concurrency (4 at a time).
      const jobs = [...picksByDoc.entries()];
      const LIMIT = 4;
      for (let i = 0; i < jobs.length; i += LIMIT) {
        const batch = jobs.slice(i, i + LIMIT);
        await Promise.all(batch.map(async ([docNo, picks]) => {
          try {
            const res = await authedFetch<{ id: string; doNumber: string }>(
              `/delivery-orders-mfg/from-sos`,
              { method: 'POST', body: JSON.stringify({ picks }) },
            );
            out.converted.push({ docNo, doNumber: res.doNumber });
          } catch (e) {
            out.failed.push({ docNo, message: e instanceof Error ? e.message : String(e) });
          }
        }));
      }
      return out;
    },
    onSuccess: () => {
      // The new DO(s) + their DO-execution data must appear on the planning rows.
      qc.invalidateQueries({ queryKey: ['delivery-planning'] });
      qc.invalidateQueries({ queryKey: ['mfg-delivery-orders'] });
      qc.invalidateQueries({ queryKey: ['mfg-delivery-orders', 'deliverable-so-lines'], refetchType: 'all' });
      invalidateSoLists(qc);
      qc.invalidateQueries({ queryKey: ['inventory'] });
    },
  });
}
