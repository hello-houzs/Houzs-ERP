// ----------------------------------------------------------------------------
// /delivery-planning — the Delivery / TMS module board.
//
// PORTED 1:1 from 2990 apps/api/src/routes/delivery-planning.ts into the Houzs
// scm schema (migration 0053). Mirror 2990 — do NOT redesign. The Houzs
// adaptations vs 2990 are import paths only (../middleware/auth, ../env,
// ../lib/paginate-all, ../lib/doc-no, ../lib/so-readiness, ./delivery-orders-mfg
// are the vendored scm equivalents with matching signatures). c.get('supabase')
// is the scm-scoped service client, so .from('mfg_sales_orders') = scm.mfg_sales_
// orders. snake_case columns, no camelCase transform.
//
// The Delivery Planning board: which live Sales Orders still need delivering,
// bucketed into 4 DERIVED states (PENDING_DELIVERY / PENDING_SCHEDULE /
// OVERDUE / DELIVERED) and grouped by delivery REGION — config-driven buckets
// derived from the customer's STATE. One order can be split across TWO region
// trips on two dates via delivery_legs (a transit leg then a final leg) — so it
// surfaces under every leg's region tab (the leg's region maps from its warehouse
// code) with that leg's date.
//
// delivery_state is DERIVED LIVE here (migration 0053 added a nullable
// mfg_sales_orders.delivery_state / delivery_orders.delivery_state column, but
// that is for manual overrides / caching only — never the source of truth):
//   - DELIVERED        — the SO's goods are fully handed over (status DELIVERED,
//                        or every deliverable line remaining == 0 once any qty
//                        has shipped).
//   - PENDING_SCHEDULE — ready to ship (summariseReadiness.isMainReady — every
//                        MAIN line READY) but not yet fully delivered.
//   - OVERDUE          — NOT ready AND today >= EFFECTIVE delivery date − 3 days
//                        (owner rule: "3 days before delivery and goods still
//                        not ready").
//   - PENDING_DELIVERY — NOT ready and not yet inside the 3-day window.
// A manual override stored on the SO header (delivery_state) wins when present.
//
// DELIVERY-DATE INTEGRITY (owner rule): the customer's ORIGINAL
// customer_delivery_date is NEVER overwritten. The schedule action writes the
// firm/new date to amended_delivery_date instead. The EFFECTIVE delivery date —
// amended_delivery_date ?? customer_delivery_date — drives Days Left AND the
// OVERDUE 3-day window; the Original column still shows customer_delivery_date.
//
// Region = CONFIG-DRIVEN, owner-maintained (migration 0053). The region buckets
//   are a master list (delivery_planning_regions) and the per-STATE → region(s)
//   classification is a MULTI mapping (state_delivery_regions) — a state can map
//   to SEVERAL regions, so an order surfaces under several tabs. Both are loaded
//   once per request (loadRegionConfig). An unmapped state falls back to the
//   default bucket. CRUD for the config lives in the sibling route
//   /delivery-planning-regions. Legs add a FURTHER bucket: a leg's region maps
//   from its warehouse CODE (codeToRegion).
//
// VIEW-TRAP (CoE): the new SO cols (delivery_state, HC fields, amend dates) are
//   deliberately NOT in scm.mfg_sales_orders_with_payment_totals. This board
//   reads them straight off the BASE table mfg_sales_orders — NEVER add them to
//   the SO-list view-backed HEADER select in mfg-sales-orders.ts (it 500s the
//   Sales Orders list).
//
// DRAFT / CANCELLED SOs (and DRAFT / CANCELLED DOs) are excluded everywhere — an
// uncommitted doc must never enter delivery planning.
//
// Mounted at '/delivery-planning' in scm/index.ts.
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import { z } from 'zod';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { paginateAll } from '../lib/paginate-all';
import { nextMonthlyDocNo } from '../lib/doc-no';
import { summariseReadiness, type ReadinessLine } from '../lib/so-readiness';
import { soDeliverableRemaining } from './delivery-orders-mfg';

export const deliveryPlanning = new Hono<{ Bindings: Env; Variables: Variables }>();
deliveryPlanning.use('*', supabaseAuth);

/* ── Region model ─────────────────────────────────────────────────────────
   CONFIG-DRIVEN (migration 0053). The region buckets are an owner-maintained
   master (delivery_planning_regions) and the per-state → region(s) classification
   is an owner-maintained MULTI mapping (state_delivery_regions) — a state can map
   to SEVERAL regions. Both are loaded once per request (loadRegionConfig). A
   Region is therefore an open string code (any code the owner adds), NOT a fixed
   union.

   stateToRegionsFromConfig() classifies an order's customer_state via the loaded
   mapping (default fallback KL when unmapped). A leg's region is mapped from its
   warehouse CODE (codeToRegion) so the dual-trip surfaces an order under a second
   tab. */
export type Region = string;

/* The codes the fallback reproduces — used ONLY when the config tables are
   empty/unapplied so behaviour never regresses below today. (The live scm seed
   in migration 0053 is SELANGOR/KL/NORTHERN/SOUTHERN/EAST_COAST/EAST_MY; these
   fallbacks are 2990's and only fire if the config tables read empty.) */
const FALLBACK_DEFAULT_REGION = 'KL';
const FALLBACK_REGIONS: Array<{ key: Region; label: string }> = [
  { key: 'KL', label: 'KL' }, { key: 'PENANG', label: 'Penang' },
  { key: 'EM', label: 'EM' }, { key: 'SG', label: 'SG' },
];

/* Normalize free-text for tolerant matching: upper, strip punctuation/accents,
   collapse whitespace. "Pulau  Pinang" / "P.Pinang" / "pulau-pinang" all align. */
function normState(s: string | null | undefined): string {
  return (s ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')   // drop accents
    .toUpperCase()
    .replace(/[._\-,/]/g, ' ')                            // punctuation → space
    .replace(/\s+/g, ' ')
    .trim();
}

/* The region config loaded once per request from the two 0053 tables. */
type RegionConfig = {
  // Ordered, active region masters → the tab row (config-driven regionList()).
  regions: Array<{ key: Region; label: string }>;
  // The set of VALID region codes (active) for filtering/membership checks.
  validCodes: Set<Region>;
  // Normalised state NAME → region codes[]. Key = normState(state_key).
  byState: Map<string, Region[]>;
};

/* Load delivery_planning_regions (active, sorted) + state_delivery_regions into a
   RegionConfig. Best-effort: on any error / empty config, falls back to the
   seeded defaults so the board still works. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadRegionConfig(sb: any): Promise<RegionConfig> {
  // 1. Region master (id → code, ordered active list).
  const codeById = new Map<string, Region>();
  let regions: Array<{ key: Region; label: string }> = [];
  const validCodes = new Set<Region>();
  try {
    const { data: regRows } = await paginateAll<{
      id: string; code: string | null; name: string | null;
      sort_order?: number | null; sortOrder?: number | null; active?: boolean | null;
    }>((from, to) =>
      sb.from('delivery_planning_regions')
        .select('id, code, name, sort_order, active')
        .order('sort_order', { ascending: true })
        .order('code', { ascending: true })
        .range(from, to),
    );
    for (const r of (regRows ?? [])) {
      const code = (r.code ?? '').toUpperCase();
      if (!code) continue;
      codeById.set(r.id, code);
      if ((r.active ?? true) !== false) {
        regions.push({ key: code, label: r.name ?? code });
        validCodes.add(code);
      }
    }
  } catch { /* fall through to fallback below */ }

  // 2. Per-state mapping → normalised state NAME → region codes[].
  const byState = new Map<string, Region[]>();
  if (codeById.size > 0) {
    try {
      const { data: mapRows } = await paginateAll<{
        state_key?: string | null; stateKey?: string | null; region_id?: string | null; regionId?: string | null;
      }>((from, to) =>
        sb.from('state_delivery_regions').select('state_key, country, region_id').range(from, to),
      );
      for (const row of (mapRows ?? [])) {
        const stateKey = row.stateKey ?? row.state_key ?? '';
        const code = codeById.get(row.regionId ?? row.region_id ?? '');
        if (!stateKey || !code) continue;
        const k = normState(stateKey);
        const arr = byState.get(k) ?? [];
        if (!arr.includes(code)) arr.push(code);
        byState.set(k, arr);
      }
    } catch { /* mapping stays empty → fallback default applies per-order */ }
  }

  // 3. Fallback when the config tables are empty / unapplied — keep today's tabs.
  if (regions.length === 0) {
    regions = [...FALLBACK_REGIONS];
    for (const r of FALLBACK_REGIONS) validCodes.add(r.key);
  }
  return { regions, validCodes, byState };
}

/* customer_state (+ customer_country fallback) → region code(s) via the loaded
   config. Returns an ARRAY (a state can map to several regions). When the state
   isn't mapped, falls back to the default bucket (KL) so an unmapped/new state
   still lands somewhere. */
function stateToRegionsFromConfig(
  cfg: RegionConfig,
  state: string | null | undefined,
  country?: string | null | undefined,
): Region[] {
  // Try the state name first, then the country (covers a blank-state SG order
  // whose country is 'Singapore').
  const sKey = normState(state);
  const cKey = normState(country);
  const hit = (sKey && cfg.byState.get(sKey)) || (cKey && cfg.byState.get(cKey)) || null;
  if (hit && hit.length > 0) return hit;
  // Unmapped → default bucket (prefer a configured KL; else first region).
  const fallback = cfg.validCodes.has(FALLBACK_DEFAULT_REGION)
    ? FALLBACK_DEFAULT_REGION
    : (cfg.regions[0]?.key ?? FALLBACK_DEFAULT_REGION);
  return [fallback];
}

/* A leg's region bucket from its warehouse CODE (the dual-trip transit/final
   hop). PORTED VERBATIM from 2990: SLGR + PJ → KL; PG → PENANG; SBH + SRK → EM.
   CHINA + CONSIGN-OUT are skipped. NOTE: these returned codes ('KL'/'PENANG'/'EM')
   are 2990's region codes and may not match the Houzs scm region seed (SELANGOR/
   KL/NORTHERN/SOUTHERN/EAST_COAST/EAST_MY). A leg's region tab therefore only
   matches when the owner's region set / warehouse codes align — see report. */
function codeToRegion(code: string | null | undefined): Region | null {
  const c = normState(code);   // upper + collapse spaces (reuse the normalizer)
  if (c === '') return null;
  if (c.startsWith('CHINA') || c.startsWith('CONSIGN')) return null;   // skip
  if (c.startsWith('SLGR') || c.startsWith('PJ')) return 'KL';
  if (c.startsWith('PG')) return 'PENANG';
  if (c.startsWith('SBH') || c.startsWith('SRK')) return 'EM';
  return null;   // unknown warehouse code → no leg region
}

/* ── Branding derivation (mirrors the SO list 1:1) ────────────────────────────
   The Delivery Planning Branding column must show the SAME derived value the SO
   list shows. Ported VERBATIM from 2990:
     · normCategory   — the SO list's category normalizer used for item_group +
                        mfg_products.category.
     · deriveBranding — the SO list's display mapping. first_item_category drives
                        it; MATTRESS follows its own branding (house brand →
                        "2990 Mattress", any other brand shown as-is).
   Keep in lock-step with the SO list. */
function normCategory(raw: string): string {
  const g = (raw ?? '').trim().toUpperCase();
  if (g.includes('BEDFRAME')) return 'BEDFRAME';
  if (g.includes('SOFA'))     return 'SOFA';
  if (g.includes('MATTRESS')) return 'MATTRESS';
  if (g.includes('ACCESSOR')) return 'ACCESSORY';
  if (g.includes('SERVICE'))  return 'SERVICE';
  return 'OTHERS';
}

/* deriveBranding — the EXACT SO list mapping (ported from 2990):
     · first item SOFA      → "2990 Sofa"
     · first item BEDFRAME  → "Bedframe"
     · first item MATTRESS  → the mattress's OWN brand; the house brand
                              ("2990" / "2990's") displays as "2990 Mattress",
                              other brands show as-is; blank brand → "2990 Mattress"
     · ACCESSORY / OTHERS / SERVICE / no items → ""  (column renders "—") */
function deriveBranding(firstItemCategory: string | null, firstItemBranding: string | null): string {
  const cat = firstItemCategory;
  if (!cat) return '';                       // no items → "—"
  if (cat === 'SOFA')     return '2990 Sofa';
  if (cat === 'BEDFRAME') return 'Bedframe';
  if (cat === 'MATTRESS') {
    const b = (firstItemBranding ?? '').trim();
    if (!b || /^2990('?s)?$/i.test(b)) return '2990 Mattress';
    return b;
  }
  return '';                                 // accessory / others / service → none ("—")
}

type DeliveryState = 'PENDING_DELIVERY' | 'PENDING_SCHEDULE' | 'OVERDUE' | 'DELIVERED';
const DELIVERY_STATES: DeliveryState[] = ['PENDING_DELIVERY', 'PENDING_SCHEDULE', 'OVERDUE', 'DELIVERED'];

/* Malaysian "today" (UTC+8), timezone-stable on the Workers UTC runtime. The
   day boundary must be MYT so days_left / the 3-day overdue window match what
   the coordinator sees on the floor. */
function todayMY(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/* Whole-day difference (target − today) in integer days, both as YYYY-MM-DD. */
function daysBetween(fromISO: string, toISO: string | null | undefined): number | null {
  if (!toISO) return null;
  const a = new Date(`${fromISO}T00:00:00Z`).getTime();
  const b = new Date(`${String(toISO).slice(0, 10)}T00:00:00Z`).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/* A leg as returned to the client — surfaces an order under its region tab. */
type LegOut = {
  id: string;
  source_type: 'SO' | 'DO';
  source_id: string;
  leg_no: number;
  warehouse_id: string | null;
  warehouse_code: string | null;
  region: Region | null;     // the leg's bucket, mapped from its warehouse CODE
  trip_id: string | null;
  leg_date: string | null;
  leg_kind: 'transit' | 'final';
  notes: string | null;
};

/* ──────────────────────────────────────────────────────────────────────────
   GET /delivery-planning?region=<ALL|code>&state=<delivery_state|ALL>
   The board. Source = live (status NOT DRAFT/CANCELLED) mfg_sales_orders that
   need delivery (have a customer_delivery_date or internal_expected_dd) +
   their DOs. delivery_state derived LIVE per SO. Region classified from the
   customer's STATE (stateToRegionsFromConfig). Legs let an order appear in a
   SECOND bucket (mapped from the leg's warehouse code) with its own date.
   ─────────────────────────────────────────────────────────────────────────*/
deliveryPlanning.get('/', async (c) => {
  const sb = c.get('supabase');
  const today = todayMY();

  const regionParam = (c.req.query('region') ?? 'ALL').trim().toUpperCase();
  const stateParam = (c.req.query('state') ?? 'ALL').trim().toUpperCase();

  /* 0. CONFIG-DRIVEN region model (migration 0053) — load the owner-maintained
        region master + per-state MULTI mapping once per request. regionList()
        (the tabs) + each order's region(s) derive from this. */
  const regionCfg = await loadRegionConfig(sb);

  /* 1. Warehouse master → code + name maps (read-only label lookup + the
        leg-region mapping, which keys off the warehouse CODE). */
  const { data: whRows, error: whErr } = await sb
    .from('warehouses')
    .select('id, code, name');
  if (whErr) return c.json({ error: 'load_failed', reason: whErr.message }, 500);
  const whCode = new Map<string, string>();
  const whName = new Map<string, string>();
  for (const w of (whRows ?? []) as Array<{ id: string; code: string | null; name: string | null }>) {
    const code = (w.code ?? '').trim();
    whCode.set(w.id, code);
    whName.set(w.id, w.name ?? code);
  }
  /* A leg's region maps from its warehouse CODE (null = no region / skipped). */
  const regionForWarehouse = (id: string | null | undefined): Region | null =>
    id ? codeToRegion(whCode.get(id)) : null;

  /* 2. Live SO headers needing delivery — NOT DRAFT / CANCELLED, and carrying a
        delivery date signal (customer_delivery_date or internal_expected_dd).
        Paginated so the 1000-row PostgREST cap never silently truncates. */
  type SoHeaderRow = {
    doc_no: string | null; debtor_code: string | null; debtor_name: string | null;
    phone: string | null; branding: string | null; status: string | null; delivery_state: string | null;
    customer_state: string | null; customer_country: string | null;
    customer_delivery_date: string | null; internal_expected_dd: string | null; processing_date: string | null;
    so_date: string | null; address1: string | null; address2: string | null;
    postcode: string | null; building_type: string | null;
    local_total_centi: number | null; balance_centi: number | null;
    // Amendment dates. The ORIGINAL customer_delivery_date is never overwritten;
    // amended_delivery_date drives the effective countdown. dual-read camelCase.
    amend_date_from_customer: string | null; amended_delivery_date: string | null;
    amendDateFromCustomer?: string | null; amendedDeliveryDate?: string | null;
    // HC "Amend Client Date Reason". dual-read camelCase below.
    amend_reason: string | null; amendReason?: string | null;
    // HC SO-context raw-data fields. dual-read camelCase below.
    possession_date: string | null; house_type: string | null;
    replacement_disposal: string | null; referral: string | null;
    possessionDate?: string | null; houseType?: string | null;
    replacementDisposal?: string | null;
  };
  const { data: soRowsRaw, error: soErr } = await paginateAll<SoHeaderRow>((from, to) =>
    sb.from('mfg_sales_orders')
      .select('doc_no, debtor_code, debtor_name, phone, branding, status, delivery_state, customer_state, customer_country, customer_delivery_date, amend_date_from_customer, amended_delivery_date, amend_reason, internal_expected_dd, processing_date, so_date, address1, address2, postcode, building_type, local_total_centi, balance_centi, possession_date, house_type, replacement_disposal, referral')
      .neq('status', 'DRAFT')
      .neq('status', 'CANCELLED')
      .order('customer_delivery_date', { ascending: true, nullsFirst: false })
      .range(from, to),
  );
  if (soErr) return c.json({ error: 'load_failed', reason: soErr.message }, 500);
  /* Only SOs that actually need delivering — they carry a date signal
     (customer_delivery_date OR internal_expected_dd / processing_date). Filtered
     in JS (not a PostgREST .or()) to keep the paginated query's row type clean. */
  const soRows = (soRowsRaw ?? []).filter(
    (r) => r.customer_delivery_date != null || r.internal_expected_dd != null || r.processing_date != null,
  );
  const docNos = soRows.map((r) => String(r.doc_no ?? '')).filter(Boolean);

  if (docNos.length === 0) {
    return c.json({ orders: [], counts: emptyCounts(), regions: regionCfg.regions });
  }

  /* 2b. LIVE balance per SO — same source-of-truth as the SO list Balance column
        (mfg_sales_orders_with_payment_totals.balance_centi_live = local_total −
        Σpayments). Looked up by doc_no; the base-table balance_centi above stays
        as the fallback when the view row is absent. */
  const liveBalanceByDoc = new Map<string, number>();
  {
    const { data: balRows } = await paginateAll<{ doc_no: string | null; balance_centi_live: number | null }>((from, to) =>
      sb.from('mfg_sales_orders_with_payment_totals')
        .select('doc_no, balance_centi_live')
        .in('doc_no', docNos)
        .range(from, to),
    );
    for (const b of (balRows ?? [])) {
      if (b.doc_no != null && b.balance_centi_live != null) {
        liveBalanceByDoc.set(String(b.doc_no), Number(b.balance_centi_live));
      }
    }
  }

  /* 3. Per-line readiness + per-line warehouse. One batched, paginated read of
        the non-cancelled lines for every candidate SO. stock_status drives
        summariseReadiness (isMainReady = every MAIN line READY); warehouse_id
        (per SO line) drives the region grouping.
        Ordered (doc_no, line_no, created_at ASC) — IDENTICAL to the SO list's
        item fetch so the FIRST line we see per doc_no is its earliest-created
        one; that drives the SO-list-matching Branding derivation below. */
  const { data: itemRowsRaw } = await paginateAll<{
    doc_no: string; item_group: string | null; item_code: string | null;
    stock_status: string | null; cancelled: boolean | null; warehouse_id: string | null;
    branding: string | null; created_at: string | null;
  }>((from, to) =>
    sb.from('mfg_sales_order_items')
      .select('doc_no, item_group, item_code, stock_status, cancelled, warehouse_id, branding, created_at')
      .in('doc_no', docNos)
      .eq('cancelled', false)
      .order('doc_no')
      .order('line_no', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true })
      .range(from, to),
  );
  const linesByDoc = new Map<string, ReadinessLine[]>();
  const warehousesByDoc = new Map<string, Set<string>>();
  /* Branding auto-derive — REPLICATES the SO list grid exactly. The Branding
     column follows the SO's FIRST line item, catalog-resolved + mains-first. */
  const firstCat = new Map<string, string>();
  const firstBranding = new Map<string, string | null>();
  const firstItemCode = new Map<string, string | null>();
  const allCodes = new Set<string>();
  for (const it of (itemRowsRaw ?? [])) {
    const dn = it.doc_no;
    if (!dn) continue;
    const arr = linesByDoc.get(dn) ?? [];
    arr.push({ item_group: it.item_group, item_code: it.item_code, stock_status: (it.stock_status ?? 'PENDING') as ReadinessLine['stock_status'], cancelled: it.cancelled });
    linesByDoc.set(dn, arr);
    if (it.warehouse_id) {
      const ws = warehousesByDoc.get(dn) ?? new Set<string>();
      ws.add(it.warehouse_id);
      warehousesByDoc.set(dn, ws);
    }
    if (it.item_code) allCodes.add(it.item_code);
    /* Rows arrive ordered by (doc_no, line_no, created_at ASC) so the first time
       we see a doc_no IS its earliest line — record it once. */
    if (!firstCat.has(dn)) {
      firstCat.set(dn, normCategory(it.item_group ?? ''));
      firstBranding.set(dn, it.branding ?? null);
      firstItemCode.set(dn, it.item_code ?? null);
    }
  }

  /* Catalog category + branding by item_code — the SAME product-branding fetch
     the SO list runs (mfg_products.category + mfg_products.branding), chunked by
     the codes in view (bounded .in, never the whole table). */
  const productCategory = new Map<string, string>();
  const productBranding = new Map<string, string>();
  {
    const codeList = [...allCodes];
    for (let i = 0; i < codeList.length; i += 300) {
      const chunk = codeList.slice(i, i + 300);
      if (chunk.length === 0) continue;
      const { data: prodRows } = await paginateAll<{ code: string; category: string | null; branding: string | null }>((from, to) =>
        sb.from('mfg_products')
          .select('code, category, branding')
          .in('code', chunk)
          .range(from, to),
      );
      for (const p of (prodRows ?? [])) {
        if (p.category) productCategory.set(p.code, normCategory(p.category));
        if (p.branding && p.branding.trim()) productBranding.set(p.code, p.branding);
      }
    }
  }
  const resolveLineCat = (code: string | null, group: string): string =>
    (code ? productCategory.get(code) : undefined) ?? normCategory(group);
  const MAIN_CATS = new Set(['SOFA', 'BEDFRAME', 'MATTRESS']);
  /* First MAIN line per doc (catalog-resolved), re-iterating the already
     (doc_no, line_no, created_at)-ordered itemRows. Falls back to the earliest
     line captured above when an SO has no sofa/bedframe/mattress line. */
  const repCat = new Map<string, string>();
  const repBranding = new Map<string, string | null>();
  const repCode = new Map<string, string | null>();
  for (const it of (itemRowsRaw ?? [])) {
    const dn = it.doc_no;
    if (!dn || repCat.has(dn)) continue;
    const cat = resolveLineCat(it.item_code, it.item_group ?? '');
    if (MAIN_CATS.has(cat)) {
      repCat.set(dn, cat);
      repBranding.set(dn, it.branding ?? null);
      repCode.set(dn, it.item_code ?? null);
    }
  }

  /* 4. Delivery progress per SO (live remaining) — drives DELIVERED detection.
        soDeliverableRemaining excludes DRAFT / CANCELLED DOs already; an SO is
        fully delivered once every line's remaining == 0 AND at least one qty has
        shipped (delivered > 0). */
  const deliveredByDoc = new Map<string, number>();
  const remainingByDoc = new Map<string, number>();
  {
    const deliverableMap = await soDeliverableRemaining(sb, docNos);
    for (const line of deliverableMap.values()) {
      deliveredByDoc.set(line.docNo, (deliveredByDoc.get(line.docNo) ?? 0) + line.delivered);
      remainingByDoc.set(line.docNo, (remainingByDoc.get(line.docNo) ?? 0) + line.remaining);
    }
  }

  /* 5. DOs for these SOs — the cut DO doc_no + status + per-DO crew (driver /
        helper / lorry from delivery_order_crew). Non-DRAFT/CANCELLED. */
  /* HC DO-execution raw-data fields surface alongside the DO. dual-read
     camelCase (the pg driver camelCases result columns). */
  type DoExecOut = {
    time_range: string | null; time_confirmed: boolean | null;
    arrival_at: string | null; departure_at: string | null;
    shipout_date: string | null; customer_delivered_date: string | null;
    eta_arriving_port: string | null; delivery_substatus: string | null;
    // EM-region transit arrival date.
    arrives_em_warehouse_date: string | null;
    // The latest DO's OWN document date (delivery_orders.do_date) — surfaced as
    // the planning grid "DO Date" column. From the SAME latest-DO lookup as crew.
    do_date: string | null;
  };
  const { data: doRowsRaw } = await paginateAll<{
    id: string; do_number: string | null; so_doc_no: string | null; status: string | null;
    delivery_state: string | null; customer_delivery_date: string | null; do_date: string | null;
    time_range: string | null; time_confirmed: boolean | null;
    arrival_at: string | null; departure_at: string | null;
    shipout_date: string | null; customer_delivered_date: string | null;
    eta_arriving_port: string | null; delivery_substatus: string | null;
    arrives_em_warehouse_date: string | null;
    // camelCase aliases (pg driver) for dual-read
    doDate?: string | null;
    timeRange?: string | null; timeConfirmed?: boolean | null;
    arrivalAt?: string | null; departureAt?: string | null;
    shipoutDate?: string | null; customerDeliveredDate?: string | null;
    etaArrivingPort?: string | null; deliverySubstatus?: string | null;
    arrivesEmWarehouseDate?: string | null;
  }>((from, to) =>
    sb.from('delivery_orders')
      .select('id, do_number, so_doc_no, status, delivery_state, customer_delivery_date, do_date, time_range, time_confirmed, arrival_at, departure_at, shipout_date, customer_delivered_date, eta_arriving_port, delivery_substatus, arrives_em_warehouse_date')
      .in('so_doc_no', docNos)
      .range(from, to),
  );
  const doByDoc = new Map<string, Array<{ id: string; doNumber: string; status: string }>>();
  /* Latest non-DRAFT/CANCELLED DO's HC exec fields, keyed by SO doc_no — the
     same DO whose crew is shown (the last in doByDoc). null when no DO. */
  const doExecByDoc = new Map<string, DoExecOut>();
  const doIds: string[] = [];
  for (const d of (doRowsRaw ?? [])) {
    const st = (d.status ?? '').toUpperCase();
    if (st === 'DRAFT' || st === 'CANCELLED') continue;  // exclude uncommitted / voided
    const dn = d.so_doc_no ?? '';
    if (!dn) continue;
    const arr = doByDoc.get(dn) ?? [];
    arr.push({ id: d.id, doNumber: d.do_number ?? '—', status: st });
    doByDoc.set(dn, arr);
    doIds.push(d.id);
    // overwrite so the LAST DO wins (matches the crew = latest-DO convention)
    doExecByDoc.set(dn, {
      time_range: d.timeRange ?? d.time_range ?? null,
      time_confirmed: d.timeConfirmed ?? d.time_confirmed ?? null,
      arrival_at: d.arrivalAt ?? d.arrival_at ?? null,
      departure_at: d.departureAt ?? d.departure_at ?? null,
      shipout_date: d.shipoutDate ?? d.shipout_date ?? null,
      customer_delivered_date: d.customerDeliveredDate ?? d.customer_delivered_date ?? null,
      eta_arriving_port: d.etaArrivingPort ?? d.eta_arriving_port ?? null,
      delivery_substatus: d.deliverySubstatus ?? d.delivery_substatus ?? null,
      arrives_em_warehouse_date: d.arrivesEmWarehouseDate ?? d.arrives_em_warehouse_date ?? null,
      do_date: d.doDate ?? d.do_date ?? null,
    });
  }

  /* Crew snapshot per DO. Best-effort — read the assign-time snapshot so the
     board shows the driver/helper/lorry without joining the masters. */
  type CrewOut = {
    // legacy collapsed strings (kept for back-compat search / fallback)
    driver: string | null; helper: string | null; lorry: string | null;
    // expanded per-person fields (HC delivery-sheet columns, snapshot)
    driver_1_name: string | null; driver_1_ic: string | null; driver_1_contact: string | null;
    driver_2_name: string | null;
    helper_1_name: string | null; helper_2_name: string | null;
    lorry_plate: string | null;
  };
  const crewByDo = new Map<string, CrewOut>();
  if (doIds.length > 0) {
    const { data: crewRows } = await paginateAll<{
      do_id: string;
      driver_1_name: string | null; driver_1_ic: string | null; driver_1_contact: string | null;
      driver_2_name: string | null;
      helper_1_name: string | null; helper_2_name: string | null; lorry_plate: string | null;
    }>((from, to) =>
      sb.from('delivery_order_crew')
        .select('do_id, driver_1_name, driver_1_ic, driver_1_contact, driver_2_name, helper_1_name, helper_2_name, lorry_plate')
        .in('do_id', doIds)
        .range(from, to),
    );
    for (const cr of (crewRows ?? [])) {
      crewByDo.set(cr.do_id, {
        driver: [cr.driver_1_name, cr.driver_2_name].filter(Boolean).join(' / ') || null,
        helper: [cr.helper_1_name, cr.helper_2_name].filter(Boolean).join(' / ') || null,
        lorry: cr.lorry_plate ?? null,
        driver_1_name: cr.driver_1_name ?? null,
        driver_1_ic: cr.driver_1_ic ?? null,
        driver_1_contact: cr.driver_1_contact ?? null,
        driver_2_name: cr.driver_2_name ?? null,
        helper_1_name: cr.helper_1_name ?? null,
        helper_2_name: cr.helper_2_name ?? null,
        lorry_plate: cr.lorry_plate ?? null,
      });
    }
  }

  /* 6. Legs for these SOs — let one order surface in TWO region tabs/dates.
        NOTE (port caveat): delivery_legs.source_id is UUID NOT NULL in the live
        scm schema (migration 0053), but this query — like 2990's — filters it
        with SO doc_no STRINGS. Ported 1:1; the read swallows any error and
        yields no legs. See report for the source_id type mismatch. */
  const legsByDoc = new Map<string, LegOut[]>();
  {
    const { data: legRows } = await paginateAll<{
      id: string; source_type: string; source_id: string; leg_no: number;
      warehouse_id: string | null; trip_id: string | null; leg_date: string | null;
      leg_kind: string; notes: string | null;
    }>((from, to) =>
      sb.from('delivery_legs')
        .select('id, source_type, source_id, leg_no, warehouse_id, trip_id, leg_date, leg_kind, notes')
        .eq('source_type', 'SO')
        .in('source_id', docNos)
        .order('leg_no', { ascending: true })
        .range(from, to),
    );
    for (const lg of (legRows ?? [])) {
      const dn = lg.source_id;
      const arr = legsByDoc.get(dn) ?? [];
      arr.push({
        id: lg.id,
        source_type: lg.source_type === 'DO' ? 'DO' : 'SO',
        source_id: lg.source_id,
        leg_no: Number(lg.leg_no ?? 1),
        warehouse_id: lg.warehouse_id,
        warehouse_code: lg.warehouse_id ? (whCode.get(lg.warehouse_id) ?? null) : null,
        region: regionForWarehouse(lg.warehouse_id),
        trip_id: lg.trip_id,
        leg_date: lg.leg_date,
        leg_kind: lg.leg_kind === 'transit' ? 'transit' : 'final',
        notes: lg.notes,
      });
    }
  }

  /* 7. Assemble one board row per SO with its derived state + region. An SO's
        "home" bucket = stateToRegionsFromConfig(customer_state, customer_country).
        Legged orders ALSO carry each leg's bucket (mapped from the leg's
        warehouse code) so the UI can place the same order under two tabs with two
        dates. */
  const orders = soRows.map((r) => {
    const docNo = String(r.doc_no ?? '');
    /* Branding — derived 1:1 with the SO list (never the empty header field).
       Pick the catalog-resolved first-MAIN line as the SO's representative
       (repCat), falling back to the earliest-created line (firstCat); a MATTRESS
       rep with a blank own-branding falls back to mfg_products.branding. Then map
       through the ported deriveBranding. */
    const hasRep = repCat.has(docNo);
    const fCat = (hasRep ? repCat.get(docNo) : firstCat.get(docNo)) ?? null;
    let fBranding = (hasRep ? repBranding.get(docNo) : firstBranding.get(docNo)) ?? null;
    if (fCat === 'MATTRESS' && (!fBranding || !fBranding.trim())) {
      const code = hasRep ? repCode.get(docNo) : firstItemCode.get(docNo);
      fBranding = (code && productBranding.get(code)) || fBranding;
    }
    const branding = deriveBranding(fCat, fBranding) || null;
    const readiness = summariseReadiness(linesByDoc.get(docNo) ?? []);
    const delivered = deliveredByDoc.get(docNo) ?? 0;
    const remaining = remainingByDoc.get(docNo) ?? 0;
    const status = String(r.status ?? '').toUpperCase();
    const customerDD = r.customer_delivery_date ?? null;
    const internalDD = r.internal_expected_dd ?? r.processing_date ?? null;
    /* Amendment dates. The ORIGINAL customer_delivery_date is never overwritten;
       the amended date (when set) is what we now commit to. EFFECTIVE date =
       amended_delivery_date ?? customer_delivery_date — it drives days_left AND
       the OVERDUE 3-day window. dual-read camelCase. */
    const amendDateFromCustomer = r.amendDateFromCustomer ?? r.amend_date_from_customer ?? null;
    const amendedDD = r.amendedDeliveryDate ?? r.amended_delivery_date ?? null;
    const effectiveDD = amendedDD ?? customerDD;

    /* "Ready to ship" gate. summariseReadiness.isMainReady is VACUOUSLY true when
       mainCount === 0 (an accessory-only / service-only SO has no MAIN line), so
       it must NOT be used directly. Use isMainReady only when there IS a main;
       otherwise require isFullyReady (every line READY). */
    const readyToShip = readiness.mainCount > 0 ? readiness.isMainReady : readiness.isFullyReady;

    /* delivery_state derivation (the core rule). A manual override stored on the
       SO header wins; else compute live. */
    const stored = r.delivery_state ?? null;
    let state: DeliveryState;
    if (stored && (DELIVERY_STATES as string[]).includes(stored)) {
      state = stored as DeliveryState;
    } else if (status === 'DELIVERED' || (delivered > 0 && remaining <= 0)) {
      state = 'DELIVERED';
    } else if (readyToShip) {
      state = 'PENDING_SCHEDULE';
    } else {
      // NOT ready. OVERDUE once we're within 3 days of (or past) the EFFECTIVE
      // delivery date (amended ?? original) and the goods still aren't ready.
      const daysLeft = daysBetween(today, effectiveDD);
      state = daysLeft != null && daysLeft <= 3 ? 'OVERDUE' : 'PENDING_DELIVERY';
    }

    /* Region(s) for this SO = its customer-STATE bucket(s) from the config
       mapping (a state can map to MANY). Legs add a FURTHER bucket (mapped from
       each leg's warehouse code) so a legged order surfaces under its state
       buckets AND its transit bucket. primaryRegion = the first mapped bucket. */
    const stateRegions = stateToRegionsFromConfig(regionCfg, r.customer_state, r.customer_country);
    const primaryRegion = stateRegions[0] ?? FALLBACK_DEFAULT_REGION;
    const regionSet = new Set<Region>(stateRegions);
    const legs = legsByDoc.get(docNo) ?? [];
    for (const lg of legs) if (lg.region) regionSet.add(lg.region);

    const dos = doByDoc.get(docNo) ?? [];
    const crew = dos.length > 0 ? (crewByDo.get(dos[dos.length - 1]!.id) ?? null) : null;
    const warehouseIds = [...(warehousesByDoc.get(docNo) ?? new Set<string>())];
    const primaryWh = warehouseIds[0] ?? null;

    return {
      so_doc_no: docNo,
      debtor_code: r.debtor_code ?? null,
      debtor_name: r.debtor_name ?? null,
      phone: r.phone ?? null,
      branding,
      status,
      delivery_state: state,
      delivery_state_override: stored && (DELIVERY_STATES as string[]).includes(stored) ? stored : null,
      // money — balance / outstanding (centi). Live balance (= local_total −
      // Σpayments, from mfg_sales_orders_with_payment_totals view) is the SO list
      // source-of-truth; base-table balance_centi is the fallback.
      balance_centi: Number(r.balance_centi ?? 0),
      balance_centi_live: liveBalanceByDoc.has(docNo) ? liveBalanceByDoc.get(docNo)! : null,
      local_total_centi: Number(r.local_total_centi ?? 0),
      // dates
      so_date: r.so_date ?? null,
      processing_date: r.processing_date ?? null,
      // ORIGINAL date (the customer's pick — never overwritten) stays here.
      customer_delivery_date: customerDD,
      // Amendment dates: the customer's requested new date and the date WE
      // confirmed. The Original column above is unchanged.
      amend_date_from_customer: amendDateFromCustomer,
      amended_delivery_date: amendedDD,
      // HC "Amend Client Date Reason" — paired with the amend dates. dual-read.
      amend_reason: r.amendReason ?? r.amend_reason ?? null,
      // EFFECTIVE date (amended ?? original) — what the countdown actually uses.
      effective_delivery_date: effectiveDD,
      internal_expected_dd: internalDD,
      days_left: daysBetween(today, effectiveDD),
      // address (HC delivery-sheet columns)
      address: [r.address1, r.address2].filter(Boolean).join(', ') || null,
      postcode: r.postcode ?? null,
      building_type: r.building_type ?? null,
      // HC SO-context raw-data fields — dual-read camelCase.
      possession_date: r.possessionDate ?? r.possession_date ?? null,
      house_type: r.houseType ?? r.house_type ?? null,
      replacement_disposal: r.replacementDisposal ?? r.replacement_disposal ?? null,
      referral: r.referral ?? null,
      // HC DO-execution raw-data fields — from the latest DO, null when this SO
      // has no (non-DRAFT/CANCELLED) DO yet.
      time_range: doExecByDoc.get(docNo)?.time_range ?? null,
      time_confirmed: doExecByDoc.get(docNo)?.time_confirmed ?? null,
      arrival_at: doExecByDoc.get(docNo)?.arrival_at ?? null,
      departure_at: doExecByDoc.get(docNo)?.departure_at ?? null,
      shipout_date: doExecByDoc.get(docNo)?.shipout_date ?? null,
      customer_delivered_date: doExecByDoc.get(docNo)?.customer_delivered_date ?? null,
      eta_arriving_port: doExecByDoc.get(docNo)?.eta_arriving_port ?? null,
      delivery_substatus: doExecByDoc.get(docNo)?.delivery_substatus ?? null,
      // EM-region transit arrival date, from the latest DO.
      arrives_em_warehouse_date: doExecByDoc.get(docNo)?.arrives_em_warehouse_date ?? null,
      // The latest DO's OWN document date (delivery_orders.do_date), null when
      // this SO has no (non-DRAFT/CANCELLED) DO yet — drives the "DO Date" column.
      do_date: doExecByDoc.get(docNo)?.do_date ?? null,
      // stock — stock_remark is the correctly-gated label (never "READY (PARTIAL)"
      // for an acc-only / service-only SO); stock_status mirrors it.
      stock_status: readiness.isFullyReady ? 'READY' : readyToShip ? 'READY (PARTIAL)' : 'PENDING',
      stock_remark: readiness.stockRemark,
      is_main_ready: readiness.isMainReady,
      // region(s): the customer-state bucket (primary) + any leg buckets; plus
      // the warehouse label (kept for the Warehouse column, not the region).
      region: primaryRegion,
      regions: [...regionSet],
      warehouse_id: primaryWh,
      warehouse_code: primaryWh ? (whCode.get(primaryWh) ?? null) : null,
      warehouse_name: primaryWh ? (whName.get(primaryWh) ?? null) : null,
      customer_state: r.customer_state ?? null,
      // delivery progress
      delivered_qty: delivered,
      remaining_qty: remaining,
      // crew (from the latest DO) + the DOs themselves
      crew,
      delivery_orders: dos.map((d) => ({ id: d.id, do_number: d.doNumber, status: d.status })),
      // legs — the dual-trip; each carries its own region + date
      legs,
    };
  });

  /* 8. Counts per state — computed over the REGION-filtered set so the state
        tab badges reflect the active region. The state filter is applied AFTER
        counting (so switching state tabs doesn't change the badge numbers). The
        region param is validated against the config's region codes. */
  const regionFiltered = orders.filter((o) => matchesRegion(o, regionParam, regionCfg.validCodes));
  const counts = emptyCounts();
  for (const o of regionFiltered) counts[o.delivery_state] += 1;
  counts.ALL = regionFiltered.length;

  const stateFiltered = stateParam === 'ALL'
    ? regionFiltered
    : regionFiltered.filter((o) => o.delivery_state === stateParam);

  return c.json({ orders: stateFiltered, counts, regions: regionCfg.regions });
});

/* Region match: ALL → everything; else a configured region code → orders whose
   region set (customer-state buckets + leg buckets) includes it. validCodes is
   the active region master from the config; an unknown param is a defensive
   no-op (so an old bookmarked tab never empties the board). The frontend tabs
   send ALL | <any configured region code>. */
function matchesRegion(
  o: { regions: Region[] },
  regionParam: string,
  validCodes: Set<Region>,
): boolean {
  if (regionParam === 'ALL' || regionParam === '') return true;
  if (validCodes.has(regionParam)) {
    return o.regions.includes(regionParam);
  }
  return true;   // unknown param → no-op filter (defensive)
}

function emptyCounts(): Record<'ALL' | DeliveryState, number> {
  return { ALL: 0, PENDING_DELIVERY: 0, PENDING_SCHEDULE: 0, OVERDUE: 0, DELIVERED: 0 };
}

/* ──────────────────────────────────────────────────────────────────────────
   LEGS CRUD — the dual-trip. A leg = (SO/DO) × region warehouse × date × kind.
   Adding a transit leg (date A) + a final leg (date B) makes one order appear
   under TWO region tabs with two dates.
   ─────────────────────────────────────────────────────────────────────────*/
const LEG_COLS =
  'id, source_type, source_id, leg_no, warehouse_id, trip_id, leg_date, leg_kind, notes, created_at, updated_at';

const legCreateSchema = z.object({
  sourceType: z.enum(['SO', 'DO']).default('SO'),
  sourceId: z.string().min(1),          // SO doc_no or DO id
  legNo: z.number().int().positive().optional(),
  warehouseId: z.string().uuid().nullable().optional(),
  tripId: z.string().uuid().nullable().optional(),
  legDate: z.string().nullable().optional(),    // YYYY-MM-DD
  legKind: z.enum(['transit', 'final']).default('final'),
  notes: z.string().nullable().optional(),
});

deliveryPlanning.post('/legs', async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = legCreateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', reason: parsed.error.message }, 400);
  const p = parsed.data;
  const sb = c.get('supabase');
  const user = c.get('user');

  /* Next leg_no for this order if the caller didn't pin one (1 = first hop).
     The UNIQUE(source_type, source_id, leg_no) constraint keeps legs ordered. */
  let legNo = p.legNo ?? null;
  if (legNo == null) {
    const { data: existing } = await sb.from('delivery_legs')
      .select('leg_no').eq('source_type', p.sourceType).eq('source_id', p.sourceId);
    const max = ((existing ?? []) as Array<{ leg_no: number | null }>)
      .reduce((m, r) => Math.max(m, Number(r.leg_no ?? 0)), 0);
    legNo = max + 1;
  }

  const { data, error } = await sb.from('delivery_legs').insert({
    source_type: p.sourceType,
    source_id: p.sourceId,
    leg_no: legNo,
    warehouse_id: p.warehouseId ?? null,
    trip_id: p.tripId ?? null,
    leg_date: p.legDate ?? null,
    leg_kind: p.legKind,
    notes: p.notes ?? null,
    created_by: (user as { id?: string } | null)?.id ?? null,
  }).select(LEG_COLS).single();
  if (error) {
    if (error.code === '23505') return c.json({ error: 'duplicate_leg', reason: 'A leg with that number already exists for this order.' }, 409);
    if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
    return c.json({ error: 'insert_failed', reason: error.message }, 500);
  }
  return c.json({ leg: data }, 201);
});

const legPatchSchema = z.object({
  warehouseId: z.string().uuid().nullable().optional(),
  tripId: z.string().uuid().nullable().optional(),
  legDate: z.string().nullable().optional(),
  legKind: z.enum(['transit', 'final']).optional(),
  legNo: z.number().int().positive().optional(),
  notes: z.string().nullable().optional(),
});

deliveryPlanning.patch('/legs/:id', async (c) => {
  const id = c.req.param('id');
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = legPatchSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', reason: parsed.error.message }, 400);
  const p = parsed.data;

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (p.warehouseId !== undefined) updates.warehouse_id = p.warehouseId;
  if (p.tripId !== undefined) updates.trip_id = p.tripId;
  if (p.legDate !== undefined) updates.leg_date = p.legDate;
  if (p.legKind !== undefined) updates.leg_kind = p.legKind;
  if (p.legNo !== undefined) updates.leg_no = p.legNo;
  if (p.notes !== undefined) updates.notes = p.notes;
  if (Object.keys(updates).length === 1) return c.json({ error: 'no_changes' }, 400);

  const sb = c.get('supabase');
  const { data, error } = await sb.from('delivery_legs').update(updates).eq('id', id).select(LEG_COLS).single();
  if (error) {
    if (error.code === '23505') return c.json({ error: 'duplicate_leg' }, 409);
    return c.json({ error: 'update_failed', reason: error.message }, 500);
  }
  return c.json({ leg: data });
});

deliveryPlanning.delete('/legs/:id', async (c) => {
  const id = c.req.param('id');
  const sb = c.get('supabase');
  const { error } = await sb.from('delivery_legs').delete().eq('id', id);
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);
  return c.json({ ok: true });
});

/* ──────────────────────────────────────────────────────────────────────────
   PATCH /delivery-planning/:type/:id/fields — set the HC delivery-sheet raw-data
   fields. :type = so | do; :id = SO doc_no or DO id.
   - SO-CONTEXT fields (possession_date, house_type, replacement_disposal,
     referral) always update mfg_sales_orders, keyed by doc_no.
   - DO-EXECUTION fields (time_range, time_confirmed, arrival_at, departure_at,
     shipout_date, customer_delivered_date, eta_arriving_port, delivery_substatus)
     update the delivery_orders ROW — directly when :type=do, else the latest
     non-DRAFT/CANCELLED DO for the SO. Skipped (with a hint) when no DO exists.
   Field names are whitelisted; only present keys are written; idempotent.
   ─────────────────────────────────────────────────────────────────────────*/
const HC_SUBSTATUS_VALUES = [
  'Pending Pickup', 'Done Shipout', 'Arrives EM Warehouse',
  'Done Delivered', 'Confirm', 'House Not Ready', 'Request Hold',
] as const;

const fieldsSchema = z.object({
  // SO-context (→ mfg_sales_orders)
  possessionDate: z.string().nullable().optional(),       // YYYY-MM-DD
  houseType: z.string().nullable().optional(),            // New House / Replacement (free text)
  replacementDisposal: z.string().nullable().optional(),
  referral: z.string().nullable().optional(),
  // Amendment dates — the customer's ORIGINAL customer_delivery_date is NEVER
  // edited here; only the amendment columns are.
  amendDateFromCustomer: z.string().nullable().optional(),  // YYYY-MM-DD (customer's ask)
  amendedDeliveryDate: z.string().nullable().optional(),    // YYYY-MM-DD (we confirm)
  // DO-execution (→ delivery_orders)
  timeRange: z.string().nullable().optional(),
  timeConfirmed: z.boolean().nullable().optional(),
  arrivalAt: z.string().nullable().optional(),            // ISO datetime
  departureAt: z.string().nullable().optional(),
  shipoutDate: z.string().nullable().optional(),          // YYYY-MM-DD
  customerDeliveredDate: z.string().nullable().optional(),
  etaArrivingPort: z.string().nullable().optional(),      // port / shipment ref
  deliverySubstatus: z.string().nullable().optional(),    // HC "Remark 4" (whitelisted, blank allowed)
  arrivesEmWarehouseDate: z.string().nullable().optional(),  // YYYY-MM-DD
});

/* Map the camelCase request keys → the snake_case columns, split by table. */
const SO_FIELD_COLS: Record<string, string> = {
  possessionDate: 'possession_date',
  houseType: 'house_type',
  replacementDisposal: 'replacement_disposal',
  referral: 'referral',
  // Amendment dates — NEVER customer_delivery_date (the original).
  amendDateFromCustomer: 'amend_date_from_customer',
  amendedDeliveryDate: 'amended_delivery_date',
};
const DO_FIELD_COLS: Record<string, string> = {
  timeRange: 'time_range',
  timeConfirmed: 'time_confirmed',
  arrivalAt: 'arrival_at',
  departureAt: 'departure_at',
  shipoutDate: 'shipout_date',
  customerDeliveredDate: 'customer_delivered_date',
  etaArrivingPort: 'eta_arriving_port',
  deliverySubstatus: 'delivery_substatus',
  arrivesEmWarehouseDate: 'arrives_em_warehouse_date',
};

deliveryPlanning.patch('/:type/:id/fields', async (c) => {
  const type = c.req.param('type').toLowerCase();
  const id = c.req.param('id');
  if (type !== 'so' && type !== 'do') return c.json({ error: 'bad_type', reason: 'type must be so | do' }, 400);
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = fieldsSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', reason: parsed.error.message }, 400);
  const p = parsed.data as Record<string, unknown>;

  // Whitelist delivery_substatus to the known HC values (blank/null always ok).
  if (p.deliverySubstatus != null && p.deliverySubstatus !== '' &&
      !(HC_SUBSTATUS_VALUES as readonly string[]).includes(String(p.deliverySubstatus))) {
    return c.json({ error: 'invalid_substatus', reason: `delivery_substatus must be one of: ${HC_SUBSTATUS_VALUES.join(', ')} (or blank).` }, 400);
  }

  const sb = c.get('supabase');

  // Split the present keys into the two column maps.
  const soUpdates: Record<string, unknown> = {};
  for (const [k, col] of Object.entries(SO_FIELD_COLS)) {
    if (p[k] !== undefined) soUpdates[col] = p[k] === '' ? null : p[k];
  }
  const doUpdates: Record<string, unknown> = {};
  for (const [k, col] of Object.entries(DO_FIELD_COLS)) {
    if (p[k] !== undefined) doUpdates[col] = p[k] === '' ? null : p[k];
  }
  if (Object.keys(soUpdates).length === 0 && Object.keys(doUpdates).length === 0) {
    return c.json({ error: 'no_changes' }, 400);
  }

  // Resolve the SO doc_no + the target DO id (latest non-DRAFT/CANCELLED).
  let soDocNo: string | null = null;
  let doId: string | null = null;
  if (type === 'so') {
    soDocNo = id;
    if (Object.keys(doUpdates).length > 0) {
      const { data: doRows } = await sb.from('delivery_orders')
        .select('id, status').eq('so_doc_no', id);
      const live = ((doRows ?? []) as Array<{ id: string; status: string | null }>)
        .filter((d) => { const s = (d.status ?? '').toUpperCase(); return s !== 'DRAFT' && s !== 'CANCELLED'; });
      doId = live.length > 0 ? live[live.length - 1]!.id : null;
    }
  } else {
    doId = id;
    const { data: doRow } = await sb.from('delivery_orders')
      .select('so_doc_no').eq('id', id).maybeSingle();
    soDocNo = (doRow as { soDocNo?: string | null; so_doc_no?: string | null } | null)
      ? ((doRow as { soDocNo?: string | null; so_doc_no?: string | null }).soDocNo
         ?? (doRow as { so_doc_no?: string | null }).so_doc_no ?? null)
      : null;
  }

  const written: { so: boolean; do: boolean } = { so: false, do: false };
  let noDoHint: string | null = null;

  // SO-context update.
  if (Object.keys(soUpdates).length > 0 && soDocNo) {
    soUpdates.updated_at = new Date().toISOString();
    const { error } = await sb.from('mfg_sales_orders').update(soUpdates).eq('doc_no', soDocNo);
    if (error) {
      if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
      return c.json({ error: 'update_failed', reason: error.message }, 500);
    }
    written.so = true;
  }

  // DO-execution update — only when a DO exists; otherwise hint, don't error.
  if (Object.keys(doUpdates).length > 0) {
    if (doId) {
      doUpdates.updated_at = new Date().toISOString();
      const { error } = await sb.from('delivery_orders').update(doUpdates).eq('id', doId);
      if (error) {
        if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
        return c.json({ error: 'update_failed', reason: error.message }, 500);
      }
      written.do = true;
    } else {
      noDoHint = 'No delivery order exists yet for this order — DO-execution fields were not saved. Create a DO first.';
    }
  }

  return c.json({ ok: true, written, do_id: doId, so_doc_no: soDocNo, no_do_hint: noDoHint });
});

/* ──────────────────────────────────────────────────────────────────────────
   PATCH /delivery-planning/:type/:id/schedule — set the concrete schedule date
   (+ optional manual delivery_state override) on an SO or DO. :type = so | do;
   :id = SO doc_no or DO id.
   ─────────────────────────────────────────────────────────────────────────*/
const scheduleSchema = z.object({
  // The firm trip date the coordinator commits to. Written to the header's
  // amended_delivery_date — NEVER customer_delivery_date, which stays the
  // customer's ORIGINAL pick. The effective date for Days Left / OVERDUE is
  // amended_delivery_date ?? customer_delivery_date.
  scheduleDate: z.string().nullable().optional(),  // YYYY-MM-DD
  // Optional MANUAL override of the derived delivery_state (cache column).
  deliveryState: z.enum(['PENDING_DELIVERY', 'PENDING_SCHEDULE', 'OVERDUE', 'DELIVERED']).nullable().optional(),
  // ── Optional trip wiring ───────────────────────────────────────────────────
  // Scheduling an order onto a trip. Either tripId (append to an existing trip)
  // OR {lorryId, driverId, tripDate?} (find-or-create a trip for that lorry+date).
  // When given, a trip_stops row (stop_type DELIVERY, do_id/so_id, revenue from
  // the DO/SO local_total_centi) is created and the matching delivery_leg's
  // trip_id is set. With no trip info, behaviour is unchanged (date only).
  tripId: z.string().uuid().nullable().optional(),
  lorryId: z.string().uuid().nullable().optional(),
  driverId: z.string().uuid().nullable().optional(),
  tripDate: z.string().nullable().optional(),       // trip date if creating (defaults to scheduleDate)
  warehouseId: z.string().uuid().nullable().optional(),  // trip origin region (defaults from leg)
});

/* is_outsourced derives from the lorry's is_internal (NOT is_internal). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function deriveTripOutsourced(sb: any, lorryId: string | null): Promise<boolean> {
  if (!lorryId) return false;
  const { data } = await sb.from('lorries').select('is_internal').eq('id', lorryId).maybeSingle();
  if (!data) return false;
  return ((data as { isInternal?: boolean | null; is_internal?: boolean | null }).isInternal
    ?? (data as { is_internal?: boolean | null }).is_internal) === false;
}

/* Next TRIP-YYMM-NNN (mirrors trips.ts nextTripNo). max+1 via the shared
   nextMonthlyDocNo — never count+1. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function nextTripNo(sb: any): Promise<string> {
  const d = new Date();
  const yymm = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`;
  const { data: existing } = await sb.from('trips').select('trip_no').like('trip_no', `TRIP-${yymm}-%`);
  return nextMonthlyDocNo(`TRIP-${yymm}`, ((existing ?? []) as Array<{ trip_no?: string; tripNo?: string }>)
    .map((r) => r.tripNo ?? r.trip_no ?? ''));
}

deliveryPlanning.patch('/:type/:id/schedule', async (c) => {
  const type = c.req.param('type').toLowerCase();
  const id = c.req.param('id');
  if (type !== 'so' && type !== 'do') return c.json({ error: 'bad_type', reason: 'type must be so | do' }, 400);
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = scheduleSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', reason: parsed.error.message }, 400);
  const p = parsed.data;

  const wantsTrip = p.tripId != null || p.lorryId != null;

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  /* DELIVERY-DATE INTEGRITY (owner rule): the customer's ORIGINAL
     customer_delivery_date must NEVER be overwritten by the schedule action. The
     firm/new trip date is the AMENDED date — write it to amended_delivery_date on
     the SO (which exists only on mfg_sales_orders). For a :type=do schedule the SO
     header is not the target; the DO carries no amend column, so a date is a no-op
     there (the schedule date flows to the trip / leg below, not onto the DO date). */
  if (p.scheduleDate !== undefined && type === 'so') updates.amended_delivery_date = p.scheduleDate;
  if (p.deliveryState !== undefined) updates.delivery_state = p.deliveryState;
  // A trip-only schedule (no date/state) is still a valid change — only 400 when
  // there's NOTHING to do at all.
  if (Object.keys(updates).length === 1 && !wantsTrip) return c.json({ error: 'no_changes' }, 400);

  const sb = c.get('supabase');
  const table = type === 'so' ? 'mfg_sales_orders' : 'delivery_orders';
  const keyCol = type === 'so' ? 'doc_no' : 'id';
  const selectCols = type === 'so'
    ? 'doc_no, customer_delivery_date, amended_delivery_date, amend_date_from_customer, delivery_state, status'
    : 'id, do_number, customer_delivery_date, delivery_state, status';

  let data: Record<string, unknown> | null = null;
  // Skip the header UPDATE when only trip info changed (nothing to write to the
  // header) — just re-read it so the response shape is unchanged.
  if (Object.keys(updates).length > 1) {
    const res = await sb.from(table).update(updates).eq(keyCol, id).select(selectCols).single();
    if (res.error) {
      if (res.error.code === '42501') return c.json({ error: 'forbidden', reason: res.error.message }, 403);
      return c.json({ error: 'update_failed', reason: res.error.message }, 500);
    }
    data = res.data as unknown as Record<string, unknown> | null;
  } else {
    const res = await sb.from(table).select(selectCols).eq(keyCol, id).maybeSingle();
    data = res.data as unknown as Record<string, unknown> | null;
  }
  if (!data) return c.json({ error: 'not_found' }, 404);

  // ── Trip wiring — find-or-create a trip, append a stop, link leg.
  let trip: { id: string; trip_no: string } | null = null;
  if (wantsTrip) {
    trip = await scheduleOntoTrip(c, sb, type, id, p);
  }

  return c.json({ ok: true, [type]: data, trip });
});

/* ──────────────────────────────────────────────────────────────────────────
   scheduleOntoTrip — the trip integration. Find-or-create the trip, append a
   DELIVERY trip_stop for this order (revenue from the DO/SO local_total_centi),
   and set the matching delivery_leg's trip_id. Idempotent on re-schedule: an
   existing stop for the same (trip, do_id|so_id) is reused, not duplicated.
   Best-effort — a wiring failure does not fail the (already-committed) header
   schedule; it returns null and the date still stands.
   ─────────────────────────────────────────────────────────────────────────*/
async function scheduleOntoTrip(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  c: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  type: 'so' | 'do',
  id: string,
  p: z.infer<typeof scheduleSchema>,
): Promise<{ id: string; trip_no: string } | null> {
  try {
    const user = c.get('user') as { id?: string } | null;

    /* Resolve the order: its uuid (do_id / so_id), grand total → revenue, and a
       customer/address snapshot. SO id is its uuid; the SO is keyed by doc_no. */
    let doId: string | null = null;
    let soId: string | null = null;
    let soDocNo: string | null = null;
    let revenueCenti = 0;
    let customerName: string | null = null;
    let address: string | null = null;
    let legWarehouseId: string | null = p.warehouseId ?? null;

    if (type === 'do') {
      doId = id;
      const { data: doRow } = await sb.from('delivery_orders')
        .select('local_total_centi, debtor_name, address1, address2, warehouse_id').eq('id', id).maybeSingle();
      if (doRow) {
        const r = doRow as Record<string, unknown>;
        revenueCenti = Number((r.localTotalCenti ?? r.local_total_centi) ?? 0);
        customerName = (r.debtorName ?? r.debtor_name ?? null) as string | null;
        address = [r.address1, r.address2].filter(Boolean).join(', ') || null;
        if (!legWarehouseId) legWarehouseId = (r.warehouseId ?? r.warehouse_id ?? null) as string | null;
      }
    } else {
      soDocNo = id;
      const { data: soRow } = await sb.from('mfg_sales_orders')
        .select('id, local_total_centi, debtor_name, address1, address2').eq('doc_no', id).maybeSingle();
      if (soRow) {
        const r = soRow as Record<string, unknown>;
        soId = (r.id ?? null) as string | null;
        revenueCenti = Number((r.localTotalCenti ?? r.local_total_centi) ?? 0);
        customerName = (r.debtorName ?? r.debtor_name ?? null) as string | null;
        address = [r.address1, r.address2].filter(Boolean).join(', ') || null;
      }
    }
    revenueCenti = Math.max(0, Math.round(revenueCenti) || 0);

    /* Find-or-create the trip. tripId given → use it; else find an existing
       PLANNED trip for (lorry, date) or create one. */
    const tripDate = p.tripDate ?? p.scheduleDate ?? todayMY();
    let tripId = p.tripId ?? null;
    if (!tripId && p.lorryId) {
      const { data: found } = await sb.from('trips').select('id, trip_no')
        .eq('lorry_id', p.lorryId).eq('trip_date', tripDate).neq('status', 'CANCELLED').limit(1);
      const hit = ((found ?? []) as Array<{ id: string; trip_no?: string; tripNo?: string }>)[0];
      if (hit) tripId = hit.id;
    }
    if (!tripId) {
      if (!p.lorryId) return null;  // nothing to create a trip from
      const isOutsourced = await deriveTripOutsourced(sb, p.lorryId);
      const tripNo = await nextTripNo(sb);
      const { data: created, error: tErr } = await sb.from('trips').insert({
        trip_no:       tripNo,
        trip_date:     tripDate,
        lorry_id:      p.lorryId,
        driver_id:     p.driverId ?? null,
        warehouse_id:  legWarehouseId,
        trip_type:     'DELIVERY',
        status:        'PLANNED',
        is_outsourced: isOutsourced,
        created_by:    user?.id ?? null,
      }).select('id, trip_no').single();
      if (tErr || !created) return null;
      tripId = (created as { id: string }).id;
    }
    const tripIdStr = tripId as string;

    /* Append the DELIVERY stop — idempotent: reuse an existing stop for the same
       (trip, do_id|so_id) instead of duplicating on re-schedule. */
    const stopFilter = sb.from('trip_stops').select('id').eq('trip_id', tripIdStr);
    const { data: existingStops } = await (doId
      ? stopFilter.eq('do_id', doId)
      : stopFilter.eq('so_id', soId));
    const already = ((existingStops ?? []) as Array<{ id: string }>)[0];
    if (!already && (doId || soId)) {
      const { data: cntRows } = await sb.from('trip_stops').select('stop_no').eq('trip_id', tripIdStr);
      const nextStopNo = ((cntRows ?? []) as Array<{ stop_no?: number; stopNo?: number }>)
        .reduce((m, r) => Math.max(m, Number(r.stopNo ?? r.stop_no ?? 0)), 0) + 1;
      await sb.from('trip_stops').insert({
        trip_id:       tripIdStr,
        stop_no:       nextStopNo,
        stop_type:     'DELIVERY',
        do_id:         doId,
        so_id:         soId,
        customer_name: customerName,
        address,
        revenue_centi: revenueCenti,
      });
    }

    /* Set the matching delivery_leg's trip_id. The leg keys off the SO doc_no
       (source_type 'SO') — pick the final leg matching the trip's warehouse, else
       the first leg, else create a leg so the order surfaces under the trip.
       NOTE (port caveat): delivery_legs.source_id is UUID in the live scm schema
       but a SO leg is keyed by doc_no here (ported 1:1 from 2990 — see report). */
    const legSourceId = type === 'so' ? (soDocNo ?? id) : (doId ?? id);
    const legSourceType = type === 'so' ? 'SO' : 'DO';
    const { data: legs } = await sb.from('delivery_legs').select('id, warehouse_id, leg_no')
      .eq('source_type', legSourceType).eq('source_id', legSourceId).order('leg_no', { ascending: true });
    const legRows = (legs ?? []) as Array<{ id: string; warehouse_id?: string | null; warehouseId?: string | null; leg_no?: number }>;
    const targetLeg = legWarehouseId
      ? legRows.find((l) => (l.warehouseId ?? l.warehouse_id) === legWarehouseId)
      : null;
    const leg = targetLeg ?? legRows[0] ?? null;
    if (leg) {
      await sb.from('delivery_legs').update({ trip_id: tripIdStr, updated_at: new Date().toISOString() }).eq('id', leg.id);
    } else {
      await sb.from('delivery_legs').insert({
        source_type: legSourceType,
        source_id:   legSourceId,
        leg_no:      1,
        warehouse_id: legWarehouseId,
        trip_id:     tripIdStr,
        leg_date:    tripDate,
        leg_kind:    'final',
        created_by:  user?.id ?? null,
      });
    }

    /* Echo the trip_no for the response. */
    const { data: tNo } = await sb.from('trips').select('id, trip_no').eq('id', tripIdStr).maybeSingle();
    const tr = tNo as { id?: string; trip_no?: string; tripNo?: string } | null;
    return tr ? { id: tripIdStr, trip_no: (tr.tripNo ?? tr.trip_no ?? '') } : { id: tripIdStr, trip_no: '' };
  } catch {
    return null;  // best-effort — never fail the header schedule on a wiring error
  }
}
