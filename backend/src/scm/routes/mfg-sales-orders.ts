// /mfg-sales-orders — B2B sales orders (HOUZS pattern).
// Separate from retail `orders` (POS) — different lifecycle, different ID format.

import { Hono } from 'hono';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { normalizePhone } from '../shared/phone';
import {
  pickComboMatch, spreadComboTotal, splitSofaCode, sofaHeightKey,
  buildVariantSummary, comboChargedPrices, matchComboSubset, type SofaComboRow, type SofaPriceTier,
  oneShotSofaCode, oneShotSimpleCode, remarkSlug,
  fabricTierAddon,
  validateFreeGiftClaims, buildFreeGiftTriggers,
  type FreeGiftLineClaim, type TriggerLine,
  campaignsCoveringLine,
  isFreeItemLine,
  resolveFabricTierOverride,
  type RuleLineInput,
  passesRefinementColumns,
} from '../shared';
import { computeSoDeliveryFee, type SoDeliveryFeeResult } from '../shared/pricing';
/* Special delivery fee rules (migration 0024, #691 RuleTarget) — the model |
   variant | compartment | combo matcher shared with the POS, used at BOTH
   recompute sites (create + cross-category re-detect). */
import { specialDeliveryFeesForLines, reconstructDeliveryRuleLines } from '../lib/special-delivery';
/* Per-compartment fabric-tier Δ (migration 0025) — reconstruct a split sofa
   build's compartment codes from its persisted module lines for the TBC path. */
import { buildCompartmentsFromModuleLines } from '../lib/compartments-from-module-lines';
/* POS auto-Proceed (Loo 2026-06-09) — when a handover arrives already complete
   (customer + address + delivery date + ≥50% paid) we stamp proceeded_at at
   create so the order lands in Proceed without a manual click. Same gate the
   POS "Move to Proceed" button uses, so the two never drift. */
import { meetsProceedGate } from '../shared/order-rules';
/* SO-SKU spec P2 — every charge is a SKU line. Predicates from P1; the
   fee/addon → SERVICE-line decomposition builders are pure + shared. */
import {
  isServiceLine, isDeliveryFeeServiceCode,
  SVC_DELIVERY, SVC_DELIVERY_CROSS, SVC_DELIVERY_ADD,
} from '../shared/service-sku';
import {
  buildDeliveryFeeServiceLines,
  computeAddonServiceLines,
  type AddonSelectionInput,
  type ServiceLineSpec,
} from '../shared/service-lines';
/* SO-SKU spec P3 — a POS sofa build splits into per-compartment module lines
   (SO-2606-018 reference shape). Pure decomposition in shared; the build-level
   recompute + drift gate stay authoritative for the money. */
import { splitSofaBuildIntoModuleLines } from '../shared/so-sofa-split';
/* SO line ORDER rules (Loo 2026-06-12) — persisted row order: mains
   (sofa/mattress/bedframe) first, accessories after, services last; within a
   rank the cart order is preserved. Shared with the Backend PDF + POS print
   so every surface ranks identically. */
import { orderSofaModuleRowsWithinBuilds, sortSoLinesByGroupRank } from '../shared/so-line-display';
/* Task 5 — mint one-shot SKUs at SO create when a line carries an extra add-on
   charge (gated by so_settings.pos_remark_extra_auto_sku). Pure code-resolution
   + row-build lives in the lib; this route batches the DB collision check. */
import { buildOneShotMints, type OneShotMintReq } from '../lib/one-shot-mint';
import { supabaseAuth } from '../middleware/auth';
import { escapeForOr } from '../lib/postgrest-search';
import { monthBoundsMy, rangeBoundsMy, todayMyt } from '../lib/my-time';
// (canViewAllSales / isSelfScopedSales removed — replaced by flat permission
// gates `scm.so.view_all` / `scm.so.attribute_other` against the REAL Houzs
// caller; see lib/houzs-perms.ts.)
import { hasHouzsPerm } from '../lib/houzs-perms';
import { resolveSalesScopeIds, salesDocOutOfScope, resolveCallerStaffId } from '../lib/salesScope';
import { recordSoAudit, diffFields, type FieldChange } from '../lib/so-audit';
/* TBC sofa exchange PWP re-evaluation (Loo 2026-06-12) — reuse the voucher
   generator + model-list matcher from the reserve route. */
import { genCode, inList } from './pwp-codes';
import { signSoItemPhotoUrl, soItemPhotoBindings, type SlipMime } from '../lib/r2';
import { slipBindings } from '../lib/slip';
import {
  loadMaintenanceConfig,
  loadSpecialAddons,
  recomputeFromSnapshot,
  loadProductByCode,
  loadProductsByCodes,
  loadFabricByCode,
  loadFabricsByCodes,
  loadFabricSellingTiers,
  loadFabricSellingTiersByIds,
  loadFabricTierAddonConfig,
  loadModelFabricTierOverrides,
  loadCompartmentFabricTierOverrides,
  loadModelDefaultGifts,
  loadModelSofaModulePrices,
  loadModelSofaModuleCostRows,
  loadActiveFreeItemCampaigns,
  type MfgItemForRecompute,
  type RecomputedLine,
  type SofaModuleCostRowLite,
} from '../lib/mfg-pricing-recompute';
/* PR #216 — per-Model variant chip enforcement (Commander 2026-05-27
   follow-up to PR #205). Reject POST/PATCH SO line items that carry a
   variant excluded by the Model's allowed_options. Empty pool = no
   restriction; null model_id = skip entirely. */
import {
  checkAllowedOptions,
  loadProductAndModel,
  loadProductsAndModels,
} from '../lib/allowed-options-check';
import { findIncompleteVariantLines } from '../lib/so-variant-check';
/* Variants-vocabulary unification (port of 2990 73aeeb1e, 2026-06-26):
   POS-handover sofa lines speak `depth`/`sofaLegHeight`/`fabricColor`, Backend
   editors read `seatHeight`/`legHeight`/`fabricCode`. canonicalizeVariants
   rewrites POS keys to canonical Backend keys at PERSIST time so every stored
   row is canonical — used at all 4 SO persist seams (create, sofa-split shared,
   add-line, add-line split, PATCH, sofa-exchange/tbc-swap-sofa) below. */
import { canonicalizeVariants } from '../shared/so-variant-rule';
/* Default Free Gift (migration 0170/0174, D9) — ONE per-Model trigger builder
   (in ../shared) is shared by the SO-create validator below and the
   placed-SO edit reconciler, so create and reconcile can never compute a
   different gift set. */
import { reconcileFreeGiftLinesForSo } from '../lib/free-gift-reconcile';
import { claimPwpForSingleLine, rollbackSinglePwpClaim } from '../lib/pwp-claim-single';
import { validateItemCodes, unknownItemCodeResponse } from '../lib/validate-item-codes';
import { pickCrossCategoryMatch, type AutoMatchCandidate } from '../lib/cross-category-match';
import { recomputeSoStockAllocation } from '../lib/so-stock-allocation';
import { creditFromCancelledSo, getCustomerCreditBalance } from '../lib/customer-credits';
import { summariseReadiness } from '../lib/so-readiness';
import { nextMonthlyDocNo } from '../lib/doc-no';
import { soDeliverableRemaining, soLineDeliveries, computeSoLifecycle, soCurrentDocNo } from './delivery-orders-mfg';
/* Shared 4-state delivery-planning derivation — the SO list emits planning_state
   (the mobile Orders-list card's status) from the SAME helper the Delivery
   Planning board uses, so the two can never drift. */
import { derivePlanningState } from './delivery-planning';
import { computeMrp, mrpLineCoverage } from './mrp';
import type { Env, Variables } from '../env';
/* scan-bg-job — the headless createDraftSalesOrder below runs the create core
   without a request-scoped client; it uses the scm-scoped service client. */
import { getSupabaseService } from '../../db/supabase';

export const mfgSalesOrders = new Hono<{ Bindings: Env; Variables: Variables }>();
mfgSalesOrders.use('*', supabaseAuth);

/* ── SO child-lock guard (Tier 2 — downstream lock) ─────────────────────────
   An SO locks (read-only — no line edit / no CANCELLED transition) once it has
   ANY non-cancelled Delivery Order OR Sales Invoice referencing it. Convert-to-
   DO (partial delivery) is NOT gated by this: the SO can keep emitting DOs;
   only line MUTATIONS + the CANCELLED status transition are blocked. Mirrors
   grnHasDownstream in apps/api/src/routes/grns.ts. Returns the blocking JSON,
   or null if the SO is free to edit. */
async function soHasDownstream(sb: any, soDocNo: string): Promise<{ error: string; message: string } | null> {
  const [{ count: doCount }, { count: siCount }] = await Promise.all([
    sb.from('delivery_orders')
      .select('id', { head: true, count: 'exact' })
      .eq('so_doc_no', soDocNo)
      .neq('status', 'CANCELLED'),
    sb.from('sales_invoices')
      .select('id', { head: true, count: 'exact' })
      .eq('so_doc_no', soDocNo)
      .neq('status', 'CANCELLED'),
  ]);
  if ((doCount ?? 0) > 0 || (siCount ?? 0) > 0) {
    return { error: 'so_has_downstream', message: 'SO has a Delivery Order / Sales Invoice — delete or cancel it first to edit' };
  }
  return null;
}

/* ── SO processing-date lock (Owner 2026-06-12) ─────────────────────────────
   Once the SO's processing day has PASSED (from midnight Malaysia time, UTC+8,
   the day AFTER the processing date) the SO is LOCKED: locked orders are what
   we PO to the supplier, so header edits, line add/edit/delete and price
   overrides are all rejected with 409 so_locked_processing. Status transitions
   (deliver / cancel flow), payments, PO/DO conversions and reads stay open.
   The UI's "Processing Date" lives in internal_expected_dd (PR #140 renamed
   only the label); legacy processing_date is honoured as a fallback. */
const SO_PROCESSING_LOCKED_RESPONSE = {
  error: 'so_locked_processing',
  reason: 'Processing date has passed — this Sales Order is locked. (Locked orders are what we PO to the supplier.)',
} as const;

function soProcessingLocked(
  header: { internal_expected_dd?: string | null; processing_date?: string | null; proceeded_at?: string | null } | null | undefined,
): boolean {
  if (!header) return false;
  /* Owner 2026-07-05 — the lock requires BOTH: the SO was actually PROCEEDED
     (proceeded_at stamped) AND its processing day has passed. A future-dated
     or never-proceeded SO whose processing date merely elapsed stays editable
     — we only PO to the supplier once the sales side has Proceeded. */
  if (!header.proceeded_at) return false;
  const proc = header.internal_expected_dd ?? header.processing_date ?? null;
  if (!proc) return false;
  const procYmd = String(proc).slice(0, 10);            // 'YYYY-MM-DD' (date or timestamp)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(procYmd)) return false;
  /* "Today" in Malaysia: shift the UTC clock +8 h, read the calendar date.
     Locked strictly AFTER the processing day — procYmd === today stays open. */
  const todayMY = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  return procYmd < todayMY;
}

/* Shared route guard — fetches the two date columns and returns the 409 body
   when locked, null when free. Callers that already hold the header row use
   soProcessingLocked directly instead of re-querying. */
async function soProcessingLockBlocked(sb: any, docNo: string): Promise<typeof SO_PROCESSING_LOCKED_RESPONSE | null> {
  const { data } = await sb.from('mfg_sales_orders')
    .select('internal_expected_dd, processing_date, proceeded_at')
    .eq('doc_no', docNo).maybeSingle();
  return soProcessingLocked(data as { internal_expected_dd?: string | null; processing_date?: string | null; proceeded_at?: string | null } | null)
    ? SO_PROCESSING_LOCKED_RESPONSE
    : null;
}

/* Owner 2026-05-31 — Identity + value columns a downstream DO / SI snapshots.
   These are frozen on the SO header once a non-cancelled child exists; payment,
   remark and scheduling columns are intentionally NOT in this set so the shop
   can still record payment after delivery. Keyed by DB column name. */
const SO_IDENTITY_LOCK_COLS = new Set<string>([
  'debtor_code', 'debtor_name', 'agent', 'sales_location', 'ref', 'po_doc_no',
  'venue', 'venue_id', 'branding', 'address1', 'address2', 'address3', 'address4',
  'phone', 'currency', 'so_date', 'customer_id', 'customer_state', 'customer_po',
  'customer_po_id', 'customer_po_date', 'customer_po_image_b64', 'customer_so_no',
  'hub_id', 'hub_name', 'ship_to_address', 'bill_to_address', 'install_to_address',
  'email', 'customer_type', 'salesperson_id', 'city', 'postcode', 'building_type',
  'emergency_contact_name', 'emergency_contact_phone', 'emergency_contact_relationship',
]);

/* Owner 2026-06-12 + Loo 2026-06-13 — after the processing date passes the SO is
   what we PO to the supplier, so the columns that feed the supplier PO freeze on
   the header PATCH. The rest of the customer / delivery-address / payment fields
   stay editable in the Proceed lane (POS "edit in Proceed"); items have their
   own per-route processing lock. Keyed by DB column name.

   Owner 2026-06-16 — customer_state + sales_location ALSO freeze here. State
   drives each SO line's warehouse_id (deriveWarehouseIdFromState), and that
   warehouse is what the PO ships from. Once the SO is locked the line warehouse
   is frozen + PO'd, so letting State change afterwards would silently desync the
   warehouse / PO from the customer's address. The REST of the address (address
   lines / city) + payment stay editable — the State (and the Location it
   derives) plus the Postcode lock.

   Owner 2026-07-05 — postcode ALSO freezes here. Like State, the postcode is
   part of the PO delivery location the supplier ships to, so it must not drift
   after the SO is locked + PO'd. */
const SO_PROCESSING_LOCK_COLS = new Set<string>([
  'internal_expected_dd', 'customer_delivery_date',
  'customer_state', 'sales_location', 'postcode',
]);

/* Loose equality for the lock diff — null / undefined / '' all collapse so a
   UI re-sending an empty field as '' does not read as a change from null. */
function norm(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

/* Pricing trust boundary (Owner 2026-05-31).
   The selling unit price is operator-authored on the Backend SO form, and the
   owner ruled the selling price legitimately varies per order. So a Backend /
   office author may set ANY selling price: the server still recomputes COST,
   but it PERSISTS the operator's selling figure and never drift-rejects it.

   The POS tablet roles (sales / sales_executive / outlet_manager) stay on the
   server-authoritative selling price + >0.5% drift reject — this preserves the
   CLAUDE.md anti-tamper non-negotiable (a tampered POS must never submit a
   doctored low total). Returns true ONLY for those POS tablet callers; every
   Backend / office role (admin, super_admin, sales_director, coordinator, …)
   returns false and is trusted to author the price. */
// Houzs has no POS tablet — every SCM caller hits this backend via the same
// Houzs session auth. The 2990 staff_role lookup is dead here (the SCM bridge
// pins every caller to one super_admin row) so this gate trivially passed for
// nobody. Hardcode false; price-drift checks become office-trusted everywhere.
// Signature kept for call-site compatibility — args ignored.
async function isPosTabletCaller(_sb: any, _userId: string | null | undefined): Promise<boolean> {
  return false;
}

/* SO-SKU spec P4 (D4, Loo 2026-06-05) — the SELLING price is locked to the
   SKU Master; only admin-level callers may hand-override it (the audited
   /override route). Houzs-flavoured: gate on the flat permission key
   `scm.so.price_override` against the REAL caller; the original
   scm.staff.role lookup is dead in Houzs (bridge pins to one super_admin
   row). Owner + IT Admin pass via `*`; grant to other positions via the
   Team > Positions matrix. Signature takes the Hono context so we can read
   the real user's permissions stash. */
async function isPriceOverrideCaller(c: any): Promise<boolean> {
  return hasHouzsPerm(c, 'scm.so.price_override');
}

/* TBC fill-in + hatch hardening (Loo 2026-06-11) — self-scoped selling roles
   used to be gated by scm.staff.role. Houzs has NO POS-self-scoped sellers
   (the SCM bridge pins every caller to one super_admin row, so this gate
   trivially passed for nobody). Hardcode false; the every-line edit path is
   already gated upstream by the Houzs session auth + the scm.access gate.
   Signature kept for call-site compatibility — args ignored. */
async function selfScopedSalesBlocked(_sb: any, _userId: string, _docNo: string): Promise<boolean> {
  return false;
}

/* Anti-tamper (Task 6) — Strip variants.freeItem from a client-supplied
   variants blob. The freeItem marker is ONLY ever stamped by the validated
   POST /mfg-sales-orders create path (campaign check + cap). Any SO-EDIT
   endpoint that writes client variants must call this before persisting so
   a crafted request cannot inject an unvalidated marker that the grandfather
   guard (isFreeItemLine) would later honour to force a line to RM 0. */
function stripFreeItem(v: unknown): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v) && 'freeItem' in v) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { freeItem: _fi, ..._rest } = v as Record<string, unknown>;
    return _rest;
  }
  return v;
}

/* POS line quantity (Loo 2026-06-12) — line qty is a money input the
   unit-price drift gate does NOT cover: qty 0 zeroes a line for free, a
   fraction / NaN corrupts total_centi math, and the discount ceiling is
   qty × unit. An absent qty (defaults to 1 downstream) is fine; anything
   else must be a positive integer. Returns the 422 payload, or null when
   valid. Shared by POST /, POST /:docNo/items and PATCH /:docNo/items/:itemId. */
function invalidQtyResponse(rawQty: unknown, itemCode: unknown, lineIdx = 0): Record<string, unknown> | null {
  if (rawQty == null) return null;
  const q = Number(rawQty);
  if (Number.isInteger(q) && q >= 1) return null;
  return {
    error:    'invalid_qty',
    reason:   'qty must be a positive whole number.',
    lineIdx,
    itemCode: String(itemCode ?? ''),
    qty:      rawQty,
  };
}

/* MAIN-mix composition (the PR #519 create rule, extended to line add / swap,
   Loo 2026-06-11): SOFA is exclusive among the MAIN categories. Returns true
   when replacing `excludeItemId`'s line (null = a pure add) with `newCode`
   INTRODUCES a sofa × (bedframe | mattress) mix that did not exist before —
   a pre-rule SO that already mixes stays editable (grandfathered). */
async function soMainMixIntroduced(sb: any, docNo: string, excludeItemId: string | null, newCode: string): Promise<boolean> {
  const { data: lines } = await sb.from('mfg_sales_order_items')
    .select('id, item_code')
    .eq('doc_no', docNo).eq('cancelled', false);
  const rows = ((lines ?? []) as Array<{ id: string; item_code: string }>);
  const cats = await loadProductsByCodes(sb, rows.map((r) => r.item_code).concat(newCode));
  const mix = (codeList: string[]): boolean => {
    let sofa = false, bedOrMatt = false;
    for (const code of codeList) {
      const cat = String(cats.get(code)?.category ?? '').toUpperCase();
      if (cat === 'SOFA') sofa = true;
      else if (cat === 'BEDFRAME' || cat === 'MATTRESS') bedOrMatt = true;
    }
    return sofa && bedOrMatt;
  };
  const beforeCodes = rows.map((r) => r.item_code);
  const afterCodes = rows.filter((r) => r.id !== excludeItemId).map((r) => r.item_code).concat(newCode);
  return mix(afterCodes) && !mix(beforeCodes);
}

/* PR — Commander 2026-05-28 — Server-side combo recompute.
   Fetches all active sofa_combo_pricing rows once (small table; ~64 rows
   in steady state) and returns them as SofaComboRow[] for the pure
   pickComboPrice() picker. Called by POST / and PATCH /:docNo/items/:itemId
   before the line is persisted; if a sofa line's variants.cells match a
   combo's modules at the line's seat-height tier, the combo price OVERRIDES
   the client-submitted unit_price (anti-tamper). */
async function loadActiveSofaCombos(sb: any): Promise<SofaComboRow[]> {
  const { data } = await sb
    .from('sofa_combo_pricing')
    .select('id, base_model, modules, tier, customer_id, prices_by_height, selling_prices_by_height, pwp_prices_by_height, label, effective_from, deleted_at, default_free_gifts')
    .is('deleted_at', null)
    .is('customer_id', null)   // 2990 B2C — default-scope rows only
    .is('supplier_id', null);  // sales-side only — never auto-price a SO from a supplier's purchasing combos
  return ((data ?? []) as Array<{
    id: string; base_model: string; modules: string[][]; tier: SofaPriceTier | null;
    customer_id: string | null; prices_by_height: Record<string, number | null>;
    selling_prices_by_height: Record<string, number | null>;
    pwp_prices_by_height: Record<string, number | null> | null;
    label: string | null; effective_from: string; deleted_at: string | null;
    default_free_gifts: unknown;
  }>).map((r) => ({
    id: r.id, baseModel: r.base_model, modules: r.modules ?? [],
    tier: r.tier, customerId: r.customer_id,
    // Combo cost/sell split — the engine charges SELLING merged over cost.
    pricesByHeight: comboChargedPrices(r.selling_prices_by_height, r.prices_by_height),
    // PWP (换购) selling price per height (Phase 2) — used INSTEAD of the above
    // only when a sofa-reward line redeems a valid PWP code (see recompute).
    pwpPricesByHeight: r.pwp_prices_by_height ?? {},
    label: r.label, effectiveFrom: r.effective_from, deletedAt: r.deleted_at,
    // Default Free Gift (migration 0170, D9) — passthrough jsonb; the SO-create
    // handler parses it to build the per-combo free-gift trigger.
    defaultFreeGifts: r.default_free_gifts ?? [],
  }));
}

/* Extract module ids + seat-height from a sofa line's `variants` blob.
   POS handover writes variants.cells = [{ moduleId, x, y, rot }] and
   variants.depth = '24' | '28' | '30' | ... so the picker has everything
   it needs to match a combo. Returns null when the line isn't a sofa
   custom build (e.g. quick-pick bundle = `bundleId` only; price already
   matches the bundle row). */
function extractSofaComboLookupArgs(
  itemGroup: string | undefined | null,
  variants: unknown,
): { modules: string[]; height: string; tier: SofaPriceTier } | null {
  if ((itemGroup ?? '').toLowerCase() !== 'sofa') return null;
  if (!variants || typeof variants !== 'object') return null;
  const v = variants as Record<string, unknown>;
  const cells = v.cells as Array<{ moduleId?: string }> | undefined;
  if (!Array.isArray(cells) || cells.length === 0) return null;
  const modules = cells.map((c) => String(c.moduleId ?? '')).filter(Boolean);
  if (modules.length === 0) return null;
  const height = String(v.depth ?? v.seatHeight ?? '24');
  /* Tier: prefer an explicit tier on variants; fall back to PRICE_2 (HOOKKA
     legacy default per the SO rendering code in Products.tsx). When the
     POS fabric model carries a tier per row, wire it here. */
  const tier = (v.tier ?? v.fabricTier ?? 'PRICE_2') as SofaPriceTier;
  return { modules, height, tier };
}

/* VIEW-TRAP (see backend/docs/scm-view-trap-coe.md): this HEADER feeds BOTH the
   SO detail GET (reads BASE TABLE scm.mfg_sales_orders) AND the SO list GET
   (reads the VIEW scm.mfg_sales_orders_with_payment_totals; LIST_COLS = HEADER
   + 3). The view was created `SELECT so.*` from 2990 mig 0155 — Postgres FREEZES
   that column set at CREATE VIEW, so new base-table columns are NOT visible
   through it. Adding a column here REQUIRES a same-PR migration that recreates
   the view (CREATE OR REPLACE VIEW … AS SELECT so.* …) — else the SO LIST 500s
   ("Failed to load") in prod. For a field only the detail needs, append it on
   the detail SELECT (see slip_image_key/receipt_image_key/proceeded_at at the
   `/:docNo` handler), NOT here. 2990 hit this 2026-06-26 (their mig 0200). */
const HEADER =
  'doc_no, transfer_to, so_date, branding, debtor_code, debtor_name, agent, sales_location, ref, po_doc_no, venue, venue_id, ' +
  'address1, address2, address3, address4, phone, ' +
  'mattress_sofa_centi, bedframe_centi, accessories_centi, others_centi, service_centi, local_total_centi, balance_centi, ' +
  /* Task #114 — per-category cost columns (migration 0079). Mirrors the
     four category revenue columns above so the SO list grid + Totals card
     can show category-level margins without per-item rollups. */
  'mattress_sofa_cost_centi, bedframe_cost_centi, accessories_cost_centi, others_cost_centi, service_cost_centi, ' +
  'total_cost_centi, total_revenue_centi, total_margin_centi, margin_pct_basis, line_count, ' +
  'currency, status, remark2, remark3, remark4, note, processing_date, sales_exemption_expiry, ' +
  /* PR #35 + #46 — extended PO + POS handover fields */
  'customer_id, customer_po, customer_po_id, customer_po_date, customer_po_image_b64, customer_so_no, hub_id, hub_name, ' +
  /* Task #121 — customer_country snapshot auto-derived from customer_state
     via my_localities lookup on POST/PATCH (migration 0082). */
  'customer_state, customer_country, customer_delivery_date, internal_expected_dd, linked_do_doc_no, ' +
  'ship_to_address, bill_to_address, install_to_address, subtotal_sen, overdue, ' +
  /* PR #46 — POS handover */
  'email, customer_type, salesperson_id, city, postcode, building_type, ' +
  'emergency_contact_name, emergency_contact_phone, emergency_contact_relationship, target_date, ' +
  /* PR #143 + #150 + #157 — Payment (migrations 0068 + 0069 + 0070) */
  'payment_method, installment_months, merchant_provider, approval_code, payment_date, deposit_centi, paid_centi, ' +
  /* Delivery fee snapshot (migration 0133) — folded into local_total/revenue/margin. */
  'delivery_fee_centi, ' +
  'created_at, created_by, updated_at';
const ITEM =
  'id, doc_no, line_date, debtor_code, debtor_name, agent, item_group, item_code, description, description2, ' +
  'uom, location, qty, unit_price_centi, discount_centi, total_centi, tax_centi, total_inc_centi, balance_centi, ' +
  'payment_status, venue, branding, remark, cancelled, variants, unit_cost_centi, line_cost_centi, line_margin_centi, ' +
  /* PR-E — per-item delivery date + cascade override flag (migration 0074) */
  'line_delivery_date, line_delivery_date_overridden, ' +
  /* PR-F — per-line photo keys (migration 0076) */
  'photo_urls, ' +
  /* PR — Commander 2026-05-28: per-line stock fulfillment flag (migration 0091) */
  'stock_status, ' +
  'created_at';

/* ─────────────────────────── Country auto-derive (Task #121) ──────────
   Given a customer_state, look up any my_localities row carrying that
   state and read its `country` column. Returns null when the state is
   unknown / not yet seeded — caller decides whether to fall back to a
   default. Cheap single-row lookup; the read is on the indexed `state`
   column so it stays under a millisecond even with the full ~7k MY
   postcode set. ─────────────────────────────────────────────────────── */
const deriveCountryFromState = async (
  sb: any,
  state: string | null | undefined,
): Promise<string | null> => {
  if (!state) return null;
  const { data } = await sb
    .from('my_localities')
    .select('country')
    .eq('state', state)
    .limit(1)
    .maybeSingle();
  const country = (data as { country?: string } | null)?.country;
  /* Commander 2026-05-28: a SO with a state set was showing a BLANK Country
     when the state name didn't match a seeded locality — e.g. my_localities
     stores "Pulau Pinang" but the form/caller used the common alias "Penang".
     2990 is Malaysia-only today (every my_localities row is 'Malaysia'), so
     fall back to 'Malaysia' for any non-empty-but-unmatched state instead of
     leaving Country empty. The exact match above still wins first, so a future
     non-MY locality set keeps working. */
  return country ?? 'Malaysia';
};

/* Commander 2026-05-29 — the Sales/shipping Location (warehouse) follows the
   customer's State. The create FORM resolves it via state_warehouse_mappings
   and sends salesLocation; this server-side derive closes the gap for callers
   that set a State but no salesLocation (e.g. API/import) so Location is bound
   to the address everywhere, not only through the form. Returns the warehouse
   code for the state, or null when unmapped. */
const deriveSalesLocationFromState = async (
  sb: any,
  state: string | null | undefined,
): Promise<string | null> => {
  if (!state) return null;
  // state_warehouse_mappings keys on the canonical state name; map the common
  // WP-KL alias the locality table doesn't carry under the WP prefix.
  const key = state === 'Wilayah Persekutuan Kuala Lumpur' ? 'Kuala Lumpur' : state;
  const { data: m } = await sb
    .from('state_warehouse_mappings')
    .select('warehouse_id')
    .eq('state', key)
    .maybeSingle();
  const whId = (m as { warehouse_id?: string } | null)?.warehouse_id;
  if (!whId) return null;
  const { data: w } = await sb
    .from('warehouses')
    .select('name, code')
    .eq('id', whId)
    .maybeSingle();
  const wh = w as { name?: string; code?: string } | null;
  return wh ? (wh.code ?? wh.name ?? null) : null;
};

/* Commander 2026-05-31 (MRP/Supply-Chain rebuild) — the per-LINE warehouse_id
   UUID (migration 0118) drives MRP + auto-allocation, which run strictly
   per-warehouse. It defaults from the SO's customer_state (same mapping the
   text sales_location uses) and is editable per line. Returns the warehouse
   UUID for the state, or null when unmapped/no state. */
const deriveWarehouseIdFromState = async (
  sb: any,
  state: string | null | undefined,
): Promise<string | null> => {
  if (!state) return null;
  /* Match the state against state_warehouse_mappings tolerantly: trim +
     lowercase + collapse spaces + a few known aliases, matched in JS over the
     (small, operator-maintained) table. The old exact case-sensitive .eq
     silently missed e.g. "Pulau Pinang" vs "Penang", a stray-case row, or a
     trailing space → NULL warehouse despite a filled state. */
  const canon = (s: string): string => {
    const t = s.trim().toLowerCase().replace(/\s+/g, ' ');
    const aliases: Record<string, string> = {
      'wilayah persekutuan kuala lumpur': 'kuala lumpur',
      'wp kuala lumpur': 'kuala lumpur',
      'kl': 'kuala lumpur',
      'penang': 'pulau pinang',
      'malacca': 'melaka',
    };
    return aliases[t] ?? t;
  };
  const want = canon(state);
  const { data: rows } = await sb
    .from('state_warehouse_mappings')
    .select('state, warehouse_id');
  for (const m of (rows ?? []) as Array<{ state: string; warehouse_id: string | null }>) {
    if (m.warehouse_id && canon(m.state) === want) return m.warehouse_id;
  }
  return null;
};

const nextDocNo = async (sb: any): Promise<string> => {
  // Format: SO-YYMM-NNN — matches PO/DO/GRN/SI/DR/PI/PRT.
  // Legacy SO-NNNNNN numbers stay as-is; only newly created SOs use this scheme.
  // max+1 via nextMonthlyDocNo, NOT count+1 — see lib/doc-no.ts for why
  // (2026-06-12: count+1 re-minted a surviving doc_no after a mid-month
  // delete and jammed every SO create on the pkey).
  const yymm = (() => {
    const d = new Date();
    return `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`;
  })();
  const { data } = await sb
    .from('mfg_sales_orders')
    .select('doc_no')
    .like('doc_no', `SO-${yymm}-%`);
  const existing = ((data ?? []) as Array<{ doc_no: string }>).map((r) => r.doc_no);
  return nextMonthlyDocNo(`SO-${yymm}`, existing);
};

/* ─────────────────────────── Cost snapshot ────────────────────────────
   Task #114 — Pull cost_price_sen off mfg_products on line create so the
   header's total_cost_centi / category cost columns get populated even
   when the client doesn't snapshot the cost themselves. Falls through in
   order: explicit client value (when > 0) → mfg_products.cost_price_sen
   → 0. Returns sen (integer). itemCode is matched on mfg_products.code
   which is the canonical lookup key (sku_code is denormalized text).

   Note: Houzs builds cost from a live skusMaster store + variant
   surcharges. We use a server snapshot instead (simpler + tamper-proof)
   per Task #114 spec. ─────────────────────────────────────────────────── */
const snapshotUnitCostSen = async (
  sb: any,
  itemCode: string,
  explicit: number,
): Promise<number> => {
  if (explicit > 0) return explicit;
  if (!itemCode) return 0;
  const { data } = await sb
    .from('mfg_products')
    .select('cost_price_sen')
    .eq('code', itemCode)
    .maybeSingle();
  return Number((data as { cost_price_sen?: number } | null)?.cost_price_sen ?? 0);
};

mfgSalesOrders.get('/', async (c) => {
  const sb = c.get('supabase');

  /* Row-level visibility scope — list of allowed salesperson_ids (scm.staff
     uuids), or null = unrestricted. Single source of truth in
     lib/salesScope.ts: view-all callers (`*` / scm.so.view_all) → all;
     everyone else → SELF + full manager_id downline chain (owner spec).
     NOTE: must pass the REAL Houzs integer user id — user.id here is the
     bridge's pinned system staff uuid and feeding it to the scope lookup
     was the non-admin 500 (uuid bound to an integer column). */
  const scopeIds = await resolveSalesScopeIds(sb, c.env, c.get('houzsUser')?.id, hasHouzsPerm(c, 'scm.so.view_all'));

  /* Dashboard summary mode (`?summary=1`): the landing page only needs to bucket
     SOs by status/proceeded_at and count "new today" — it does NOT need the
     payment-totals view join or the per-line stock-status second query. Return
     just those 6 columns so the Dashboard isn't paying for 500 fully-hydrated
     rows + a line-item aggregation on first paint. Bucketing stays in the
     frontend (single source of truth — no SQL duplication). */
  if (c.req.query('summary')) {
    let sq = sb
      .from('mfg_sales_orders')
      .select('doc_no, status, proceeded_at, local_total_centi, created_at, so_date')
      .neq('status', 'DRAFT')
      .order('so_date', { ascending: false })
      .limit(500);
    if (scopeIds) sq = sq.in('salesperson_id', scopeIds);
    const { data, error } = await sq;
    if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
    return c.json({ salesOrders: data ?? [] });
  }

  /* Follow-up #83 — read from the view that joins payments ledger totals so
     Balance column is live (= local_total − sum(payments)). Header column
     `balance_centi` is still in the SELECT for backward compat (the grid
     falls back to it if the view's `balance_centi_live` is absent). */
  /* VIEW-TRAP (see backend/docs/scm-view-trap-coe.md): this select hits the
     VIEW `mfg_sales_orders_with_payment_totals`, which has a FROZEN column set
     captured at CREATE VIEW time (2990 mig 0155, `SELECT so.*`). Any column you
     add to HEADER above MUST already exist in the view — else this query 500s
     the whole SO list page in prod. If you're adding a new base-table column,
     ship a recreate-view migration in the SAME PR FIRST, or keep the col out
     of HEADER (detail-only). proceeded_at + paid_total_centi + balance_centi_live
     are all view-native (paid_total_centi/balance_centi_live are the view's
     computed cols; proceeded_at was added to the base table BEFORE the view
     was last recreated by the 2990-views script, so it IS present). */
  const LIST_COLS = `${HEADER}, proceeded_at, paid_total_centi, balance_centi_live`;
  let q = sb.from('mfg_sales_orders_with_payment_totals').select(LIST_COLS).order('so_date', { ascending: false }).limit(500);
  if (scopeIds) q = q.in('salesperson_id', scopeIds);
  const status = c.req.query('status'); if (status) q = q.eq('status', status);
  const debtor = c.req.query('debtor'); if (debtor) q = q.ilike('debtor_name', `%${debtor}%`);
  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  /* PR — Commander 2026-05-28: Stock Status chip column.
     Per-SO aggregate computed from mfg_sales_order_items.stock_status grouped
     by item_group. UI renders:
       · empty            — no category fully ready
       · ["MATTRESS"]     — all mattress lines READY, but other categories pending
       · isFullyReady     — every non-cancelled line READY (chip column shows "READY")
     We hand the per-row arrays back so the UI doesn't need a second round-trip. */
  const rows = (data ?? []) as Array<{ doc_no?: string } & Record<string, unknown>>;
  const docNos = rows.map((r) => r.doc_no).filter((x): x is string => !!x);
  if (docNos.length > 0) {
    /* Order deterministically so the FIRST line per doc_no is the earliest
       one created (matches the detail endpoint's `.order('created_at')`). We
       add `branding`, `item_code` and `created_at` to the select: branding is
       the mattress brand source for the first-item rule below; item_code lets
       us fall back to mfg_products.branding when a mattress line's own branding
       is blank; created_at drives the first-line pick. */
    const { data: itemRows } = await sb
      .from('mfg_sales_order_items')
      .select('doc_no, item_group, stock_status, cancelled, branding, item_code, warehouse_id, created_at')
      .in('doc_no', docNos)
      .eq('cancelled', false)
      .order('doc_no')
      .order('line_no', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true });
    const agg = new Map<string, Map<string, { total: number; ready: number }>>();
    /* Branding auto-derive (Commander 2026-05-28, refined PR #266): the SO list
       grid derives its Branding pill from the SO's FIRST line item — no longer
       "Mixed" when categories differ. We track per doc_no:
         · item_categories     — DISTINCT normalized categories (kept for back-compat)
         · first_item_category — normalized category of the earliest-created line
         · first_item_branding — that line's own `branding` text (the mattress brand)
       The header revenue columns merge mattress + sofa into one bucket, so the
       grid can't tell SOFA from MATTRESS at the header level — hence this
       per-line first-item read (from the same fetch already running for stock
       status). The UI maps SOFA → "2990 Sofa", BEDFRAME → "Bedframe", MATTRESS
       → first_item_branding (its own brand) ?? "2990 Mattress", else → "2990". */
    const cats = new Map<string, Set<string>>();
    const firstCat = new Map<string, string>();
    const firstBranding = new Map<string, string | null>();
    const firstItemCode = new Map<string, string | null>();
    /* Primary warehouse per SO — the FIRST non-null line warehouse_id (mirrors
       the Delivery Planning board's primaryWh = warehouseIds[0]). Drives the
       mobile Orders-list card's warehouse_name. */
    const firstWarehouseByDoc = new Map<string, string>();
    const allCodes = new Set<string>();
    const normCategory = (raw: string): string => {
      const g = (raw ?? '').trim().toUpperCase();
      if (g.includes('BEDFRAME')) return 'BEDFRAME';
      if (g.includes('SOFA'))     return 'SOFA';
      if (g.includes('MATTRESS')) return 'MATTRESS';
      if (g.includes('ACCESSOR')) return 'ACCESSORY';
      if (g.includes('SERVICE')) return 'SERVICE'; // SO-SKU spec P2 — synced with normCat below
      return 'OTHERS';
    };
    for (const it of (itemRows ?? []) as Array<{ doc_no: string; item_group: string; stock_status: string; cancelled: boolean; branding: string | null; item_code: string | null; warehouse_id: string | null; created_at: string | null }>) {
      let perGroup = agg.get(it.doc_no);
      if (!perGroup) { perGroup = new Map(); agg.set(it.doc_no, perGroup); }
      const g = (it.item_group ?? '').trim().toUpperCase() || 'OTHERS';
      let cell = perGroup.get(g);
      if (!cell) { cell = { total: 0, ready: 0 }; perGroup.set(g, cell); }
      cell.total += 1;
      if (it.stock_status === 'READY') cell.ready += 1;

      let catSet = cats.get(it.doc_no);
      if (!catSet) { catSet = new Set(); cats.set(it.doc_no, catSet); }
      catSet.add(normCategory(it.item_group));
      if (it.item_code) allCodes.add(it.item_code);
      /* First non-null line warehouse per doc (rows are line_no/created_at
         ordered) — the SO's primary warehouse for the mobile card. */
      if (it.warehouse_id && !firstWarehouseByDoc.has(it.doc_no)) {
        firstWarehouseByDoc.set(it.doc_no, it.warehouse_id);
      }

      /* Rows arrive ordered by (doc_no, created_at ASC) so the first time we
         see a doc_no IS its earliest line — record it once. */
      if (!firstCat.has(it.doc_no)) {
        firstCat.set(it.doc_no, normCategory(it.item_group));
        firstBranding.set(it.doc_no, it.branding ?? null);
        firstItemCode.set(it.doc_no, it.item_code ?? null);
      }
    }

    /* Resolve each line's category from the CATALOG (mfg_products.category),
       not just the line's free-text item_group. A sofa module line saved with
       item_group 'others' (or a leading SERVICE/delivery line) must not blank
       the SO's Branding pill — so we (a) trust the catalog category and (b) pick
       the first MAIN line (sofa/bedframe/mattress) as the SO's representative,
       falling back to the earliest line when there is none. Batch-fetch the
       catalog by the codes actually in view (bounded .in, chunked — never the
       whole table) so this can't hit the PostgREST row cap. The same map also
       supplies the mattress-brand fallback (mfg_products.branding). */
    const productCategory = new Map<string, string>();
    const productBranding = new Map<string, string>();
    const codeList = [...allCodes];
    for (let i = 0; i < codeList.length; i += 300) {
      const chunk = codeList.slice(i, i + 300);
      if (chunk.length === 0) continue;
      const { data: prodRows } = await sb
        .from('mfg_products')
        .select('code, category, branding')
        .in('code', chunk);
      for (const p of (prodRows ?? []) as Array<{ code: string; category: string | null; branding: string | null }>) {
        if (p.category) productCategory.set(p.code, normCategory(p.category));
        if (p.branding && p.branding.trim()) productBranding.set(p.code, p.branding);
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
    for (const it of (itemRows ?? []) as Array<{ doc_no: string; item_group: string; branding: string | null; item_code: string | null }>) {
      if (repCat.has(it.doc_no)) continue;
      const cat = resolveLineCat(it.item_code, it.item_group);
      if (MAIN_CATS.has(cat)) {
        repCat.set(it.doc_no, cat);
        repBranding.set(it.doc_no, it.branding ?? null);
        repCode.set(it.doc_no, it.item_code ?? null);
      }
    }

    /* Commander 2026-05-29 (#19) — Payment Method column summarises the
       payments LEDGER, not just the header's single payment_method field. A
       SO can be settled across several methods (e.g. a cash deposit + a card
       balance), so we collect the DISTINCT method labels per doc_no and join
       them with " + " (→ "Cash + Card"). Label rules mirror the payment form
       cascade: cash→"Cash"; merchant→"Card"; transfer→its online_type
       (Bank Transfer / TNG / Cheque / DuitNow) when set, else "Transfer";
       installment→"Installment" (2026-06-06 unify — these rows were
       silently dropped from the summary before).
       One cheap batched read over the same doc_no set already in play. */
    const paymentMethods = new Map<string, Set<string>>();
    {
      const { data: payRows } = await sb
        .from('mfg_sales_order_payments')
        .select('so_doc_no, method, online_type')
        .in('so_doc_no', docNos);
      for (const p of (payRows ?? []) as Array<{ so_doc_no: string; method: string | null; online_type: string | null }>) {
        const m = (p.method ?? '').trim().toLowerCase();
        let label: string;
        if (m === 'cash') label = 'Cash';
        else if (m === 'merchant') label = 'Card';
        else if (m === 'transfer') label = (p.online_type && p.online_type.trim()) ? p.online_type.trim() : 'Transfer';
        else if (m === 'installment') label = 'Installment';
        else continue;
        let set = paymentMethods.get(p.so_doc_no);
        if (!set) { set = new Set(); paymentMethods.set(p.so_doc_no, set); }
        set.add(label);
      }
    }

    /* Tier 2 downstream-lock — one extra batched read per doc set: pull every
       non-cancelled DO/SI that points back to a listed SO and mark has_children
       on the row. The list grid uses this to hide Edit / Cancel from SOs that
       are downstream-locked (mirrors computeGrnFlags in routes/grns.ts). */
    const downstreamDocNos = new Set<string>();
    const [doRowsRes, siRowsRes] = await Promise.all([
      sb.from('delivery_orders')
        .select('so_doc_no')
        .in('so_doc_no', docNos)
        .neq('status', 'CANCELLED'),
      sb.from('sales_invoices')
        .select('so_doc_no')
        .in('so_doc_no', docNos)
        .neq('status', 'CANCELLED'),
    ]);
    for (const d of ((doRowsRes.data ?? []) as Array<{ so_doc_no: string | null }>)) {
      if (d.so_doc_no) downstreamDocNos.add(d.so_doc_no);
    }
    for (const s of ((siRowsRes.data ?? []) as Array<{ so_doc_no: string | null }>)) {
      if (s.so_doc_no) downstreamDocNos.add(s.so_doc_no);
    }

    /* B2C readiness summary per SO (Commander 2026-05-30) — derive the
       "Stock Remark" the operator's existing ERP shows: READY when everything
       in, READY (PARTIAL) when MAIN done + ACC outstanding, else list the
       categories still pending. */
    const readinessByDoc = new Map<string, ReturnType<typeof summariseReadiness>>();
    {
      const linesByDoc = new Map<string, Array<{ item_group: string | null; item_code: string | null; stock_status: string; cancelled: boolean }>>();
      for (const it of (itemRows ?? []) as Array<{ doc_no: string; item_group: string; item_code: string | null; stock_status: string; cancelled: boolean }>) {
        const arr = linesByDoc.get(it.doc_no) ?? [];
        arr.push({ item_group: it.item_group, item_code: it.item_code, stock_status: it.stock_status, cancelled: it.cancelled });
        linesByDoc.set(it.doc_no, arr);
      }
      for (const [docNo, ls] of linesByDoc) {
        readinessByDoc.set(docNo, summariseReadiness(ls));
      }
    }

    /* "Has undelivered qty" per SO (Wei Siang 2026-05-30) — drives the Issue
       Delivery Order menu gate. Recomputed LIVE (remaining = qty − delivered +
       returned, cancelled DOs excluded) by the same helper the line-level
       picker uses, so it re-opens after a DO is cancelled / a DO line is
       deleted and closes once every line is fully delivered. Replaces the old
       status-only gate that hid the action at SHIPPED/DELIVERED. */
    const hasUndelivered = new Set<string>();
    /* Per-SO delivery progress — drives the "Partially Delivered" / "Delivered"
       badge (Wei Siang 2026-05-31). Aggregated from the same live engine: a SO
       is 'partial' once any qty has shipped but some remains, 'full' once
       nothing remains, 'none' before the first DO. */
    const deliveredTotal = new Map<string, number>();
    const remainingTotal = new Map<string, number>();
    {
      const deliverableMap = await soDeliverableRemaining(sb, docNos);
      for (const line of deliverableMap.values()) {
        if (line.remaining > 0) hasUndelivered.add(line.docNo);
        deliveredTotal.set(line.docNo, (deliveredTotal.get(line.docNo) ?? 0) + line.delivered);
        remainingTotal.set(line.docNo, (remainingTotal.get(line.docNo) ?? 0) + line.remaining);
      }
    }

    /* Per-SO status badge driver — "latest event wins" across DO / SI / DR
       (Wei Siang 2026-05-31). 'none' falls back to the stored status. */
    const [lifecycleByDoc, currentByDoc] = await Promise.all([
      computeSoLifecycle(sb, docNos),
      soCurrentDocNo(sb, docNos),
    ]);

    /* Warehouse label map (id → name) for the mobile Orders-list card's
       warehouse_name. Mirrors the Delivery Planning board's read-only master
       lookup (delivery-planning.ts step 1). Small master, unpaginated like there. */
    const whName = new Map<string, string>();
    {
      const { data: whRows } = await sb.from('warehouses').select('id, code, name');
      for (const w of (whRows ?? []) as Array<{ id: string; code: string | null; name: string | null }>) {
        const label = (w.name ?? w.code ?? '').trim();
        if (label) whName.set(w.id, label);
      }
    }

    /* Planning-state inputs that live ONLY on the BASE table (NOT in the
       payment-totals VIEW backing this list): the manual delivery_state override
       and amended_delivery_date. Per the VIEW-TRAP CoE these post-view columns
       must NEVER be added to LIST_COLS/HEADER (they 500 the list), so read them
       straight off mfg_sales_orders keyed by doc_no. customer_delivery_date +
       status are already on the view rows (`r`). */
    const overrideByDoc = new Map<string, string | null>();
    const amendedDDByDoc = new Map<string, string | null>();
    {
      const { data: baseRows } = await sb
        .from('mfg_sales_orders')
        .select('doc_no, delivery_state, amended_delivery_date')
        .in('doc_no', docNos);
      for (const b of (baseRows ?? []) as Array<{ doc_no: string | null; delivery_state?: string | null; deliveryState?: string | null; amended_delivery_date?: string | null; amendedDeliveryDate?: string | null }>) {
        if (!b.doc_no) continue;
        overrideByDoc.set(b.doc_no, b.deliveryState ?? b.delivery_state ?? null);
        amendedDDByDoc.set(b.doc_no, b.amendedDeliveryDate ?? b.amended_delivery_date ?? null);
      }
    }
    const planningToday = todayMyt();

    for (const r of rows) {
      const docNo = r.doc_no ?? '';
      const perGroup = agg.get(docNo);
      (r as Record<string, unknown>).item_categories = [...(cats.get(docNo) ?? [])].sort();
      (r as Record<string, unknown>).has_children = downstreamDocNos.has(docNo);
      const dDelivered = deliveredTotal.get(docNo) ?? 0;
      const dRemaining = remainingTotal.get(docNo) ?? 0;
      (r as Record<string, unknown>).delivery_state =
        dDelivered <= 0 ? 'none' : dRemaining > 0 ? 'partial' : 'full';
      (r as Record<string, unknown>).lifecycle_state = lifecycleByDoc.get(docNo) ?? 'none';
      (r as Record<string, unknown>).current_doc_no = currentByDoc.get(docNo) ?? (docNo || null);
      (r as Record<string, unknown>).has_undelivered = hasUndelivered.has(docNo);
      const readiness = readinessByDoc.get(docNo);
      (r as Record<string, unknown>).stock_remark = readiness?.stockRemark ?? '';
      (r as Record<string, unknown>).is_main_ready = readiness?.isMainReady ?? false;
      /* Mobile Orders-list card fields (snake_case, dual-read by the FE):
         · warehouse_name  — the SO's primary line warehouse label ('—' until set).
         · planning_state  — the 4-state Delivery-Planning status, derived from the
           SAME shared helper the board uses. delivery_state (above) is the DO-
           progress none/partial/full field — this is the ORTHOGONAL planning
           status; both are emitted. */
      const primaryWh = firstWarehouseByDoc.get(docNo) ?? null;
      (r as Record<string, unknown>).warehouse_name = primaryWh ? (whName.get(primaryWh) ?? null) : null;
      const effectiveDD = (amendedDDByDoc.get(docNo) ?? null) ?? ((r as Record<string, unknown>).customer_delivery_date as string | null ?? null);
      (r as Record<string, unknown>).planning_state = derivePlanningState({
        storedOverride: overrideByDoc.get(docNo) ?? null,
        status: (r as Record<string, unknown>).status as string | null,
        readiness: {
          mainCount: readiness?.mainCount ?? 0,
          isMainReady: readiness?.isMainReady ?? false,
          isFullyReady: readiness?.isFullyReady ?? false,
        },
        delivered: dDelivered,
        remaining: dRemaining,
        effectiveDD,
        today: planningToday,
      });
      /* First-item branding source (PR #266; catalog-resolved + mains-first). */
      const hasRep = repCat.has(docNo);
      const fCat = (hasRep ? repCat.get(docNo) : firstCat.get(docNo)) ?? null;
      (r as Record<string, unknown>).first_item_category = fCat ?? null;
      let fBranding = (hasRep ? repBranding.get(docNo) : firstBranding.get(docNo)) ?? null;
      if (fCat === 'MATTRESS' && (!fBranding || !fBranding.trim())) {
        const code = hasRep ? repCode.get(docNo) : firstItemCode.get(docNo);
        fBranding = (code && productBranding.get(code)) || fBranding;
      }
      (r as Record<string, unknown>).first_item_branding = fBranding;
      /* #19 — distinct ledger payment methods, sorted + joined ("Cash + Card").
         Empty string when no payments recorded yet (UI falls back to the
         header payment_method field). */
      const pm = paymentMethods.get(docNo);
      (r as Record<string, unknown>).payment_methods_summary = pm ? [...pm].sort().join(' + ') : '';
      if (!perGroup) {
        (r as Record<string, unknown>).ready_categories = [];
        (r as Record<string, unknown>).is_fully_ready = false;
        continue;
      }
      const ready: string[] = [];
      let allReady = true;
      for (const [grp, cell] of perGroup) {
        if (cell.total > 0 && cell.ready === cell.total) ready.push(grp);
        else allReady = false;
      }
      (r as Record<string, unknown>).ready_categories = ready;
      (r as Record<string, unknown>).is_fully_ready = allReady && perGroup.size > 0;
    }
  }

  return c.json({ salesOrders: rows });
});

/* Salesperson MTD scoreboard — feeds the mobile Profile v7 tiles
   (Orders MTD / Sales MTD). Self-scoped the same way as '/mine':
   salesperson_id === auth user id, on the caller's RLS-scoped client, so a
   caller only ever sees their OWN orders. Counts orders created within the
   current Malaysia-calendar month, excluding CANCELLED / DRAFT (not real
   sales). Registered BEFORE '/:docNo' so 'my-mtd' is never a doc-no param. */
mfgSalesOrders.get('/my-mtd', async (c) => {
  const sb = c.get('supabase');
  /* Self = the caller's REAL scm.staff uuid (mig 0066), NOT user.id — the
     bridge pins user.id to the shared system staff row, so matching on it
     returned the SAME (system-attributed) orders for every caller instead
     of the person's own. No sync row → zero stats, not someone else's. */
  const myStaffId = await resolveCallerStaffId(sb, c.get('houzsUser')?.id);
  if (!myStaffId) return c.json({ mtd_orders: 0, mtd_sales_centi: 0 });
  // Current month in Malaysia time → UTC [start, end) bounds for created_at.
  const ymd = todayMyt();
  const { startUtc, endUtc } = monthBoundsMy(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1);
  // A single salesperson's monthly orders never approach the 1000-row cap.
  const { data, error } = await sb
    .from('mfg_sales_orders')
    .select('local_total_centi, total_revenue_centi')
    .eq('salesperson_id', myStaffId)
    .not('status', 'in', '("CANCELLED","DRAFT")')
    .gte('created_at', startUtc)
    .lt('created_at', endUtc)
    .limit(1000);
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const rows = (data ?? []) as Array<{ local_total_centi: number | null; total_revenue_centi: number | null }>;
  const mtd_sales_centi = rows.reduce(
    (sum, r) => sum + Number(r.local_total_centi ?? r.total_revenue_centi ?? 0),
    0,
  );
  return c.json({ mtd_orders: rows.length, mtd_sales_centi });
});

/* POS "My orders" board — the salesperson's OWN Sales Orders, lightweight
   columns for the 3-status board (Order Placed / Proceed / Delivered).
   Filtered by salesperson_id = caller (staff.id === auth.users.id, schema.ts
   line 162; the POS handover writes the placing salesperson's id into
   salesperson_id) so a POS tablet sees only its own orders WITHOUT relying on
   an RLS SELECT policy. Excludes CANCELLED / ON_HOLD (mirrors the legacy
   board's cancelled exclusion). Registered BEFORE '/:docNo' so 'mine' is never
   captured as a doc-no param. */
mfgSalesOrders.get('/mine', async (c) => {
  const sb = c.get('supabase'); const user = c.get('user');
  /* Read the BASE table (NOT the mfg_sales_orders_with_payment_totals view):
     a Postgres view fixes its column list at creation, and that view predates
     proceeded_at (migration 0110) — selecting proceeded_at from the view 500s
     at runtime. The base table has every column incl. proceeded_at +
     deposit_centi. Paid is summed from the payments ledger separately below. */
  /* Board filters (POS My-orders toolbar):
       ?q=   free-text → searches doc_no / debtor_name / phone across ALL dates
             (the period is intentionally ignored — search is a global lookup).
       ?from=&to=  YYYY-MM-DD (MY-local, `to` inclusive) → filter created_at
             (order-placed date) to that period. Only applied when there's no q.
     The default (no params) returns everything; the POS always passes the
     current-month window, so the board mirrors the KPI cards. */
  const q = (c.req.query('q') ?? '').trim();
  const fromYmd = c.req.query('from') ?? null;
  const toYmd = c.req.query('to') ?? null;
  const LIMIT = 300;

  /* ?salesperson=<id|all> — only view-all roles (super_admin / sales_director /
     outlet_manager) may view OTHER salespeople. We verify the caller's role with a service-role
     lookup; if they qualify we run the whole board on the service-role client
     (so RLS can't clip another salesperson's rows/items/payments). Everyone
     else: the param is ignored and they stay self-scoped on their own client. */
  const wantSalesperson = c.req.query('salesperson') ?? null;
  let client = sb;
  /* Self = the caller's REAL scm.staff uuid (mig 0066) — user.id is the
     bridge's pinned system row shared by every caller (see /my-mtd note).
     Fall back to user.id so a missing sync row degrades to the old
     (system-attributed) behavior instead of erroring. */
  let targetSalespersonId: string | null =
    (await resolveCallerStaffId(sb, c.get('houzsUser')?.id)) ?? user.id; // default: own orders only
  if (wantSalesperson) {
    // Houzs-flavoured: gate on the flat permission key `scm.so.view_all`
    // against the REAL caller (the 2990 staff_role lookup is dead in Houzs —
    // the SCM bridge pins every caller to one super_admin row). Owner + IT
    // Admin pass via `*`; grant to other positions via the Team > Positions
    // matrix.
    if (hasHouzsPerm(c, 'scm.so.view_all')) {
      const admin = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      client = admin;
      targetSalespersonId = wantSalesperson === 'all' ? null : wantSalesperson;
    }
  }

  let query = client
    .from('mfg_sales_orders')
    .select(
      'doc_no, debtor_name, phone, email, address1, address2, city, postcode, customer_state, ' +
      'customer_delivery_date, internal_expected_dd, status, payment_method, approval_code, note, so_date, created_at, ' +
      'proceeded_at, total_revenue_centi, line_count, deposit_centi',
    )
    .not('status', 'in', '("CANCELLED","ON_HOLD","DRAFT")');
  if (targetSalespersonId) query = query.eq('salesperson_id', targetSalespersonId);

  if (q) {
    const safe = escapeForOr(q);
    if (safe) {
      query = query.or(
        `doc_no.ilike.%${safe}%,debtor_name.ilike.%${safe}%,phone.ilike.%${safe}%`,
      );
    }
  } else {
    const { startUtc, endUtc } = rangeBoundsMy(fromYmd, toYmd);
    if (startUtc) query = query.gte('created_at', startUtc);
    if (endUtc) query = query.lt('created_at', endUtc);
  }

  const { data, error } = await query
    .order('created_at', { ascending: false })
    .limit(LIMIT);
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if ((data?.length ?? 0) >= LIMIT) {
    console.log(`[/mine] ${LIMIT}-row cap hit caller=${user.id} target=${targetSalespersonId ?? 'all'} q=${q ? 'yes' : 'no'} from=${fromYmd ?? '-'} to=${toYmd ?? '-'}`);
  }

  // Cast via `unknown` first — supabase-js types a view select as
  // GenericStringError[] until the schema cache materialises (same pattern as
  // the list route's joined-select casts above).
  const rows = (data ?? []) as unknown as Array<{ doc_no?: string; deposit_centi?: number } & Record<string, unknown>>;

  /* Attach the line items so the drawer can render the cart without a second
     fetch. Group non-cancelled lines by doc_no → each item the board needs:
     { item_code, description, qty, total_centi, variants }. */
  const docNos = rows.map((r) => r.doc_no).filter((x): x is string => !!x);
  /* TBC fill-in (Loo 2026-06-11) — the editor needs the line id (mutation
     target), item_group (which picker set to render) and unit/discount (the
     floor-rule preview), so they ride the same fetch. */
  const itemsByDoc = new Map<string, Array<{ id: string; item_code: string; item_group: string | null; description: string | null; qty: number; unit_price_centi: number; discount_centi: number; total_centi: number; variants: unknown; remark: string | null }>>();
  if (docNos.length > 0) {
    const { data: itemRows } = await client
      .from('mfg_sales_order_items')
      .select('id, doc_no, item_code, item_group, description, qty, unit_price_centi, discount_centi, total_centi, variants, remark')
      .in('doc_no', docNos)
      .eq('cancelled', false)
      .order('line_no', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true });
    for (const it of (itemRows ?? []) as Array<{ id: string; doc_no: string; item_code: string; item_group: string | null; description: string | null; qty: number; unit_price_centi: number; discount_centi: number; total_centi: number; variants: unknown; remark: string | null }>) {
      const arr = itemsByDoc.get(it.doc_no) ?? [];
      arr.push({ id: it.id, item_code: it.item_code, item_group: it.item_group ?? null, description: it.description, qty: it.qty, unit_price_centi: it.unit_price_centi, discount_centi: it.discount_centi, total_centi: it.total_centi, variants: it.variants, remark: it.remark ?? null });
      itemsByDoc.set(it.doc_no, arr);
    }
  }

  /* Live paid = the payments ledger, PLUS the header deposit ONLY for legacy
     SOs whose deposit never reached the ledger. Since P2 (D5, migration 0155)
     the SO create path writes the deposit as an is_deposit ledger row (and
     0155 backfilled history), so adding the header column on top would double
     count — the is_deposit marker tells the two worlds apart. The header
     `paid_centi` is deprecated; not read. One batched ledger query. */
  const paidLedgerByDoc = new Map<string, number>();
  const depositInLedger = new Set<string>();
  if (docNos.length > 0) {
    const { data: payRows } = await client
      .from('mfg_sales_order_payments')
      .select('so_doc_no, amount_centi, is_deposit')
      .in('so_doc_no', docNos);
    for (const p of (payRows ?? []) as Array<{ so_doc_no: string; amount_centi: number; is_deposit?: boolean | null }>) {
      paidLedgerByDoc.set(p.so_doc_no, (paidLedgerByDoc.get(p.so_doc_no) ?? 0) + (p.amount_centi ?? 0));
      if (p.is_deposit) depositInLedger.add(p.so_doc_no);
    }
  }

  const salesOrders = rows.map((r) => {
    const docNo = r.doc_no ?? '';
    const deposit = typeof r.deposit_centi === 'number' ? r.deposit_centi : 0;
    const ledger = paidLedgerByDoc.get(docNo) ?? 0;
    const soItems = itemsByDoc.get(docNo) ?? [];
    return {
      ...r,
      // Total received = ledger payments (+ header deposit only when the
      // ledger doesn't already carry it as an is_deposit row).
      paid_centi_total: (depositInLedger.has(docNo) ? 0 : deposit) + ledger,
      items: soItems,
    };
  });

  return c.json({ salesOrders });
});

/* P1 (Owner 2026-06-03, migration 0143) — serve an SO's payment slip so the
   Backend SO detail page can display the proof. (Mirrored the legacy
   /orders/:id/slip-url route, removed 2026-06-12.) Auth is router-level (same
   as the SO detail GET); RLS governs which SOs the caller can read.

   2026-07-04 — converted from returning a presigned S3 GET URL (JSON {url})
   to STREAMING the object through the SLIPS binding, part of killing the
   never-provisioned R2 S3 creds (see routes/slips.ts header). The frontend
   (vendor/scm/lib/slip.ts fetchSoSlipUrl / fetchPaymentSlipUrl) blob-fetches
   this and hands consumers an object URL, keeping their {url, contentType}
   contract intact. */
function mimeFromKey(key: string): SlipMime {
  const ext = key.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'jpg': case 'jpeg': return 'image/jpeg';
    case 'png': return 'image/png';
    case 'webp': return 'image/webp';
    case 'pdf': return 'application/pdf';
    default: throw new Error(`unknown slip extension: ${key}`);
  }
}

mfgSalesOrders.get('/:docNo/slip-url', async (c) => {
  const sb = c.get('supabase');
  const docNo = c.req.param('docNo');
  const { data: row, error } = await sb
    .from('mfg_sales_orders')
    .select('slip_key')
    .eq('doc_no', docNo)
    .maybeSingle();
  if (error) return c.json({ error: 'db_fetch_failed', detail: error.message }, 500);
  if (!row) return c.json({ error: 'not_found' }, 404);
  const slipKey = (row as { slip_key?: string | null }).slip_key ?? null;
  if (!slipKey) return c.json({ error: 'no_slip_attached' }, 400);

  let bindings;
  try { bindings = slipBindings(c.env); }
  catch (e) { return c.json({ error: 'r2_not_configured', reason: (e as Error).message }, 500); }
  const obj = await bindings.bucket.get(slipKey);
  if (!obj) return c.json({ error: 'file_not_in_r2' }, 404);
  return new Response(obj.body as unknown as BodyInit, {
    headers: {
      'content-type': obj.httpMetadata?.contentType ?? mimeFromKey(slipKey),
      'content-disposition': 'inline',
      'cache-control': 'private, max-age=300',
    },
  });
});

/* Cross-category delivery link (migration 0141) — shared eligibility check used
   by BOTH the live handover preview (GET /cross-category-eligibility) and the
   order POST, so the fee shown equals the fee charged. A non-empty SO number is
   eligible only when it exists, isn't cancelled, belongs to the same customer
   (by normalized phone, when both have one), and hasn't already backed another
   follow-up (the unique index is the hard backstop). */
type CrossCatEligibility = {
  eligible: boolean;
  reason?: 'not_found' | 'cancelled' | 'different_customer' | 'already_used' | 'lookup_failed';
  debtorName?: string | null;
};

async function checkCrossCategorySource(
  sb: any,
  docNo: string,
  newPhoneRaw: string | null,
  newCustomerId: string | null = null,
): Promise<CrossCatEligibility> {
  const { data: srcRow, error: srcErr } = await sb
    .from('mfg_sales_orders')
    .select('doc_no, status, phone, debtor_name, customer_id')
    .eq('doc_no', docNo)
    .maybeSingle();
  /* Loo 2026-06-06 (SO-2606-025 incident) — a FAILED query is not a missing
     order. This used to swallow the error and report "Order was not found"
     for a real SO when the CF Workers free-plan subrequest cap killed this
     exact fetch (#51 of 50). Surface it as retryable instead. */
  if (srcErr) {
    console.error('[mfg-so] cross-category source lookup failed:', srcErr.message ?? srcErr);
    return { eligible: false, reason: 'lookup_failed' };
  }
  const src = srcRow as { doc_no: string; status: string; phone: string | null; debtor_name: string | null; customer_id: string | null } | null;
  if (!src) return { eligible: false, reason: 'not_found' };
  if (src.status === 'CANCELLED') return { eligible: false, reason: 'cancelled' };
  /* "Same customer" — prefer the real customer_id link (exact) now that every
     new SO resolves one (migration 0144). Fall back to normalised phone only
     when the SOURCE is a legacy row with no customer_id; the NEW order always
     carries both a compulsory phone and a resolved customer_id. */
  if (src.customer_id && newCustomerId) {
    if (src.customer_id !== newCustomerId) return { eligible: false, reason: 'different_customer' };
  } else {
    const newPhone = newPhoneRaw ? (normalizePhone(newPhoneRaw) ?? newPhoneRaw) : null;
    const srcPhone = src.phone ? (normalizePhone(src.phone) ?? src.phone) : null;
    if (newPhone && srcPhone && newPhone !== srcPhone) return { eligible: false, reason: 'different_customer' };
  }
  const { count, error: countErr } = await sb
    .from('mfg_sales_orders')
    .select('doc_no', { count: 'exact', head: true })
    .eq('cross_category_source_doc_no', docNo);
  // Same honesty rule as above — a failed count must not silently pass the
  // already-used gate (fail-open) nor masquerade as another reason.
  if (countErr) {
    console.error('[mfg-so] cross-category already-used count failed:', countErr.message ?? countErr);
    return { eligible: false, reason: 'lookup_failed' };
  }
  if ((count ?? 0) > 0) return { eligible: false, reason: 'already_used' };
  return { eligible: true, debtorName: src.debtor_name ?? null };
}

const crossCatReasonText = (docNo: string, reason?: string): string =>
  reason === 'not_found'         ? `Order ${docNo} was not found.`
  : reason === 'cancelled'         ? `Order ${docNo} is cancelled.`
  : reason === 'different_customer'? `Order ${docNo} belongs to a different customer.`
  : reason === 'already_used'      ? `Order ${docNo} was already used for a cross-category discount.`
  : reason === 'lookup_failed'     ? `Could not verify order ${docNo} — please try again.`
  :                                  `Order ${docNo} is not a valid linked order.`;

// GET /cross-category-eligibility?docNo&phone — live check for the handover
// preview so the cross-category delivery discount only applies for a real,
// eligible SO (sales can no longer "type anything" and get the reduced rate).
// Static path is registered before /:docNo so it isn't captured as a docNo.
mfgSalesOrders.get('/cross-category-eligibility', async (c) => {
  const sb = c.get('supabase');
  const docNo = (c.req.query('docNo') ?? '').trim();
  const phone = (c.req.query('phone') ?? '').trim();
  if (!docNo) return c.json({ eligible: false });
  const result = await checkCrossCategorySource(sb, docNo, phone || null);
  return c.json({
    eligible:  result.eligible,
    debtorName: result.debtorName ?? null,
    message:   result.eligible ? null : crossCatReasonText(docNo, result.reason),
  });
});

// GET /cross-category-match?name&phone — the Confirm-screen "Auto-match" button.
// Scans THIS customer's earlier sales orders and returns the most recent one
// that can still back a cross-category follow-up, so sales don't have to recall
// the SO number. "Same customer" = the (name, phone) identity key (migration
// 0144) — a shared phone with a different name is a different customer. The SO
// must not be cancelled and must not already be linked-from by another order
// (single-use; the unique index on cross_category_source_doc_no is the hard
// gate, this just keeps the button from offering a burnt SO). Read-only: it
// never mints a customer row (unlike the order POST). Registered before /:docNo
// so the static path isn't captured as a docNo.
mfgSalesOrders.get('/cross-category-match', async (c) => {
  const sb = c.get('supabase');
  const name = (c.req.query('name') ?? '').trim();
  const phoneRaw = (c.req.query('phone') ?? '').trim();
  const normPhone = phoneRaw ? (normalizePhone(phoneRaw) ?? phoneRaw) : null;
  // Both halves of the identity key are required to find a customer's orders.
  if (!name || !normPhone) return c.json({ found: false });

  // Candidate earlier SOs for this phone, newest first. Name is matched in the
  // pure helper with the same lower(trim) rule as the customers unique index.
  const { data: rows } = await sb
    .from('mfg_sales_orders')
    .select('doc_no, debtor_name, created_at')
    .eq('phone', normPhone)
    .not('status', 'in', '("CANCELLED","DRAFT")')
    .order('created_at', { ascending: false })
    .limit(50);
  const candidates: AutoMatchCandidate[] = ((rows ?? []) as Array<{ doc_no: string; debtor_name: string | null }>)
    .map((r) => ({ docNo: r.doc_no, debtorName: r.debtor_name }));
  if (candidates.length === 0) return c.json({ found: false });

  // Which of those candidate SOs are already linked-from by another order.
  const { data: usedRows } = await sb
    .from('mfg_sales_orders')
    .select('cross_category_source_doc_no')
    .in('cross_category_source_doc_no', candidates.map((c2) => c2.docNo));
  const used = ((usedRows ?? []) as Array<{ cross_category_source_doc_no: string | null }>)
    .map((r) => r.cross_category_source_doc_no)
    .filter((v): v is string => !!v);

  const match = pickCrossCategoryMatch(candidates, name, used);
  return match
    ? c.json({ found: true, docNo: match.docNo, debtorName: match.debtorName })
    : c.json({ found: false });
});

/* GET /customer-search?name= — POS customer-name autocomplete (Loo
   2026-06-06: "when key in customer name, search the customer list, give
   option for same name"). Searches past SO headers by name (ilike) and
   dedupes to ONE entry per (lower-trim name, phone) identity — the same key
   as migration 0144's customers unique index — keeping the NEWEST order's
   contact + address snapshot for the autofill. Header-based (not the
   customers registry) so it covers ALL order history today; the registry
   only has rows minted since 0144 went live (backfill = Phase 2). Phone is
   returned in full — this is a staff-only surface behind auth, and the
   phone is exactly how sales tell two same-name customers apart.
   Read-only: never mints a customer row. Registered before /:docNo so the
   static path isn't captured as a docNo. */
mfgSalesOrders.get('/customer-search', async (c) => {
  const sb = c.get('supabase');
  const q = (c.req.query('name') ?? '').trim();
  if (q.length < 2) return c.json({ customers: [] });
  // Escape LIKE metacharacters so a literal "%" in a name can't widen the scan.
  const esc = q.replace(/[\\%_]/g, (m) => `\\${m}`);
  const { data, error } = await sb
    .from('mfg_sales_orders')
    .select('doc_no, debtor_name, phone, email, customer_type, address1, address2, city, postcode, customer_state, building_type, emergency_contact_name, emergency_contact_phone, emergency_contact_relationship, created_at')
    .ilike('debtor_name', `%${esc}%`)
    .not('status', 'in', '("CANCELLED","DRAFT")')
    .order('created_at', { ascending: false })
    .limit(60);
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  type Row = {
    doc_no: string; debtor_name: string | null; phone: string | null;
    email: string | null; customer_type: string | null;
    address1: string | null; address2: string | null; city: string | null;
    postcode: string | null; customer_state: string | null;
    building_type: string | null;
    emergency_contact_name: string | null; emergency_contact_phone: string | null;
    emergency_contact_relationship: string | null;
    created_at: string;
  };
  /* Per-identity COALESCE (Loo 2026-06-06 follow-up: "link them with address
     as well") — the newest order wins per FIELD, not per row. A customer whose
     latest SO was "fill in address later" still autofills from their previous
     order's address: rows arrive newest-first, the first occurrence seeds the
     entry, and older same-identity rows only patch fields that are still
     empty. lastDocNo/lastOrderAt always stay the newest order's. */
  const byKey = new Map<string, Record<string, unknown>>();
  const FILL_FIELDS = [
    ['email', 'email'], ['customerType', 'customer_type'],
    ['address1', 'address1'], ['address2', 'address2'], ['city', 'city'],
    ['postcode', 'postcode'], ['customerState', 'customer_state'],
    ['buildingType', 'building_type'],
  ] as const;
  /* Emergency contact coalesces as a GROUP, not per field (Loo 2026-06-12:
     copy it over like the address) — name/phone/relationship describe ONE
     person, so mixing the name from one order with the phone of another
     would invent a contact that doesn't exist. The newest order carrying
     any of the three wins all three. */
  const hasEmergency = (e: Record<string, unknown>): boolean =>
    Boolean(e.emergencyContactName || e.emergencyContactPhone || e.emergencyContactRelationship);
  const emergencyOf = (r: Row) => ({
    emergencyContactName:         r.emergency_contact_name,
    emergencyContactPhone:        r.emergency_contact_phone,
    emergencyContactRelationship: r.emergency_contact_relationship,
  });
  for (const r of (data ?? []) as Row[]) {
    const name = (r.debtor_name ?? '').trim();
    if (!name) continue;
    const key = `${name.toLowerCase()}|${(r.phone ?? '').trim()}`;
    const existing = byKey.get(key);
    if (existing) {
      for (const [out, col] of FILL_FIELDS) {
        if (existing[out] == null || existing[out] === '') existing[out] = r[col];
      }
      if (!hasEmergency(existing) && hasEmergency(emergencyOf(r))) {
        Object.assign(existing, emergencyOf(r));
      }
      continue;
    }
    byKey.set(key, {
      debtorName:    name,
      phone:         r.phone,
      email:         r.email,
      customerType:  r.customer_type,
      address1:      r.address1,
      address2:      r.address2,
      city:          r.city,
      postcode:      r.postcode,
      customerState: r.customer_state,
      buildingType:  r.building_type,
      ...emergencyOf(r),
      lastDocNo:     r.doc_no,
      lastOrderAt:   r.created_at,
    });
  }
  return c.json({ customers: [...byKey.values()].slice(0, 8) });
});

// Houzs — resolve the logged-in salesperson's ACTIVE exhibition project venue
// so the New-SO / OCR form can auto-select it in the Venue dropdown. MUST be
// registered BEFORE "/:docNo" (single-segment static path, else Hono treats
// "active-venue" as a docNo). Returns the project venue NAME + the matching
// project_venues id (string, by name; null if the venue isn't in the master) +
// the project name (for the FE hint). Resolution = the latest project (by
// start_date <= date) the user is the PIC of OR a Sales Attending rep of.
mfgSalesOrders.get('/active-venue', async (c) => {
  const hu = c.get('houzsUser');
  const uid = hu?.id != null ? Number(hu.id) : NaN;
  const dateRaw = c.req.query('date');
  const soDate =
    typeof dateRaw === 'string' && /^\d{4}-\d{2}-\d{2}/.test(dateRaw)
      ? dateRaw.slice(0, 10)
      : todayMyt();
  if (!Number.isFinite(uid)) {
    return c.json({ venueId: null, venueName: null, projectName: null });
  }
  try {
    const row = await c.env.DB.prepare(
      `SELECT p.venue AS venue, p.name AS projectname, v.id AS masterid
         FROM projects p
         LEFT JOIN project_venues v
           ON lower(trim(v.name)) = lower(trim(p.venue)) AND v.active = 1
        WHERE p.start_date IS NOT NULL
          AND p.start_date <= ?
          AND p.venue IS NOT NULL AND p.venue <> ''
          AND (
            p.pic_id = ?
            OR EXISTS (
              SELECT 1 FROM project_sales_attendees psa
                JOIN sales_reps sr ON sr.id = psa.sales_rep_id
               WHERE psa.project_id = p.id AND sr.user_id = ?
            )
          )
        ORDER BY p.start_date DESC
        LIMIT 1`,
    )
      .bind(soDate, uid, uid)
      .first<{ venue?: string | null; projectname?: string | null; masterid?: number | null }>();
    const venueName = typeof row?.venue === 'string' && row.venue.trim() ? row.venue.trim() : null;
    const projectName =
      typeof row?.projectname === 'string' && row.projectname.trim() ? row.projectname.trim() : null;
    const masterId = row?.masterid ?? null;
    return c.json({
      venueId: masterId != null ? String(masterId) : null,
      venueName,
      projectName,
    });
  } catch {
    return c.json({ venueId: null, venueName: null, projectName: null });
  }
});

mfgSalesOrders.get('/:docNo', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo');
  const [h, i] = await Promise.all([
    /* `${HEADER}, proceeded_at` — proceeded_at lives ONLY on the base table,
       NOT the mfg_sales_orders_with_payment_totals view that the LIST route
       (LIST_COLS = HEADER + …) reads. Keeping it out of the shared HEADER and
       appending it only here means the detail page still gets the Proceed Date
       while the list view query stays valid. amend_date_from_customer /
       amended_delivery_date / amend_reason (mig 0053, port of 2990 0199 + 0201)
       are in the SAME boat — the payment-totals view's frozen column set
       (see VIEW-TRAP note above) does NOT carry them, so they're appended on
       the base-table detail read only. POST/PATCH persist them. */
    sb.from('mfg_sales_orders').select(`${HEADER}, proceeded_at, amend_date_from_customer, amended_delivery_date, amend_reason, signature_b64, slip_key, slip_state, slip_image_key, receipt_image_key`).eq('doc_no', docNo).maybeSingle(),
    /* line_no = the persisted listing order (0165); NULLS LAST so pre-0165
       docs fall back to created_at + the rule re-derive below. */
    sb.from('mfg_sales_order_items').select(ITEM).eq('doc_no', docNo)
      .order('line_no', { ascending: true, nullsFirst: false })
      .order('created_at'),
  ]);
  if (h.error) return c.json({ error: 'load_failed', reason: h.error.message }, 500);
  if (!h.data) return c.json({ error: 'not_found' }, 404);
  /* TEMPORARY (Loo 2026-06-10, Backend SO emergency hatch) — self-scoped
     selling roles may open only their OWN SO; another salesperson's doc_no
     answers 404 (not 403) so it's indistinguishable from a nonexistent one.
     POS reads its own orders through /mine, and the salesperson's own POS
     print/detail fetches carry salesperson_id = caller, so those still pass.
     Remove with the hatch (see lib/roles.ts isSelfScopedSales). */
  {
    // Same tiering as the list (lib/salesScope.ts): view-all roles pass; POS
    // sellers pass only their own; other reps are held to their subtree. An
    // out-of-scope doc_no answers 404 — indistinguishable from a missing one.
    const sp = (h.data as { salesperson_id?: number | string | null }).salesperson_id;
    if (await salesDocOutOfScope(sb, c.env, c.get('houzsUser')?.id, hasHouzsPerm(c, 'scm.so.view_all'), sp)) {
      return c.json({ error: 'not_found' }, 404);
    }
  }
  /* Tier 2 downstream-lock — stamp has_children so the SO Detail page can lock
     once any non-cancelled DO / SI references it. */
  const [{ count: doCount }, { count: siCount }] = await Promise.all([
    sb.from('delivery_orders')
      .select('id', { head: true, count: 'exact' })
      .eq('so_doc_no', docNo)
      .neq('status', 'CANCELLED'),
    sb.from('sales_invoices')
      .select('id', { head: true, count: 'exact' })
      .eq('so_doc_no', docNo)
      .neq('status', 'CANCELLED'),
  ]);
  /* Edge #D — surface the customer's current credit balance on the SO Detail
     response so the page can show "Customer has RM X available" without a
     second round-trip. 0 when no debtor / no credit history. */
  const debtorCode = (h.data as { debtor_code?: string | null }).debtor_code ?? null;
  const customerCreditCenti = debtorCode ? await getCustomerCreditBalance(sb, debtorCode) : 0;
  /* Live paid rollup — same rule as the LIST route (lines ~678): sum the
     payments ledger, and add the header deposit ONLY for legacy SOs whose
     deposit never reached the ledger (is_deposit marker distinguishes them).
     Without this the single-SO response carried only the deprecated
     `paid_centi` (0 for a balance payment recorded via the drawer), so the
     customer-facing print showed "Deposit paid 0.00" + a wrong balance even
     though money had been collected (Loo 2026-06-09). */
  let paidLedgerCenti = 0;
  let depositInLedger = false;
  {
    const { data: payRows } = await sb
      .from('mfg_sales_order_payments')
      .select('amount_centi, is_deposit')
      .eq('so_doc_no', docNo);
    for (const p of (payRows ?? []) as Array<{ amount_centi: number; is_deposit?: boolean | null }>) {
      paidLedgerCenti += p.amount_centi ?? 0;
      if (p.is_deposit) depositInLedger = true;
    }
  }
  const headerDepositCenti = typeof (h.data as { deposit_centi?: number }).deposit_centi === 'number'
    ? (h.data as { deposit_centi: number }).deposit_centi : 0;
  const totalRevenueCenti = typeof (h.data as { total_revenue_centi?: number }).total_revenue_centi === 'number'
    ? (h.data as { total_revenue_centi: number }).total_revenue_centi : 0;
  const paidCentiTotal = (depositInLedger ? 0 : headerDepositCenti) + paidLedgerCenti;
  const salesOrder = {
    ...(h.data as unknown as Record<string, unknown>),
    has_children: (doCount ?? 0) > 0 || (siCount ?? 0) > 0,
    customer_credit_centi: customerCreditCenti,
    // Authoritative received-to-date + remaining balance for the detail page
    // and the customer-facing print (so-doc.ts reads paid_centi_total).
    paid_centi_total: paidCentiTotal,
    balance_centi: Math.max(0, totalRevenueCenti - paidCentiTotal),
  };
  /* Owner batch 2026-07 — resolve the salesperson's display name + contact
     phone (scm.staff) so the SO PDF's ORDER DETAILS can print "Salesperson:
     name · phone" without a second round-trip. Best-effort: a failed lookup
     (or a null salesperson_id) leaves both null and the PDF row is skipped. */
  {
    const spId = (h.data as { salesperson_id?: string | null }).salesperson_id ?? null;
    let spName: string | null = null;
    let spPhone: string | null = null;
    if (spId) {
      try {
        const { data: sp } = await sb
          .from('staff')
          .select('name, phone')
          .eq('id', spId)
          .maybeSingle();
        const row = sp as { name?: string | null; phone?: string | null } | null;
        spName = (row?.name ?? '').trim() || null;
        spPhone = (row?.phone ?? '').trim() || null;
      } catch { /* best-effort — PDF falls back to omitting the row */ }
    }
    (salesOrder as Record<string, unknown>).salesperson_name = spName;
    (salesOrder as Record<string, unknown>).salesperson_phone = spPhone;
  }
  /* Per-line delivery breakdown so the SO views can show a "Delivered" column
     (which DO took how much, and the live balance) without a second round-trip.
     remaining/delivered come from the authoritative soDeliverableRemaining
     engine; the DO-number breakdown rides alongside from soLineDeliveries. */
  /* Rule-order the rows at READ (Loo 2026-06-12). The bulk insert gives every
     line of an SO the same created_at, so the persisted order is NOT
     recoverable from the timestamp once routine updates (stock_status flips,
     recomputeTotals' combo spread) physically relocate rows. Rank
     (mains → accessories → services) + each build's left-to-right walk are
     re-derived from the rows themselves; within-rank residual order keeps the
     read-back order (usually the cart order). */
  const itemRows = orderSofaModuleRowsWithinBuilds(
    sortSoLinesByGroupRank(
      (i.data ?? []) as unknown as Array<Record<string, unknown> & { id: string; item_code: string; qty?: number | null }>,
      (r) => r.item_group as string | null | undefined,
    ),
  );
  /* Brand letterhead resolution (owner 2026-07) — stamp the R2 key of the
     brand logo the SO PDF should print IN PLACE OF the company logo (the
     company letterhead stays the fallback when this is null). Brands +
     their logos live in public.project_brands (Project Maintenance →
     Brands; logo_r2_key, migration-pg 0069), read via c.env.DB — same
     public-schema hop as the venue lookup above. Rules:
       1. Any line whose item_group contains SOFA → the brand named
          "ZANOTTI" (case-insensitive), but only if it has a logo.
       2. Else match the FIRST item's description prefix against the
          active brand names (longest name wins) → that brand's logo key.
       3. Else null.
     Best-effort: any failure stamps null and the PDF keeps the company
     letterhead — a PDF must never fail because of a logo. */
  {
    let brandLogoKey: string | null = null;
    try {
      const brandRows = await c.env.DB.prepare(
        `SELECT name, logo_r2_key FROM project_brands WHERE active = 1`
      ).all<{ name: string; logo_r2_key: string | null }>();
      /* Dual-read logoR2Key ?? logo_r2_key — the pg driver camelCases
         result columns (#1 recurring bug). */
      const brands = ((brandRows.results ?? []) as Array<Record<string, unknown>>)
        .map((r) => ({
          name: String(r.name ?? '').trim(),
          logoKey: (() => {
            const v = (r.logoR2Key ?? r.logo_r2_key) as string | null | undefined;
            const s = typeof v === 'string' ? v.trim() : '';
            return s || null;
          })(),
        }))
        .filter((b) => b.name);
      const hasSofa = itemRows.some((it) =>
        String((it as { item_group?: string | null }).item_group ?? '').toUpperCase().includes('SOFA'),
      );
      if (hasSofa) {
        const zanotti = brands.find((b) => b.name.toUpperCase() === 'ZANOTTI' && b.logoKey);
        if (zanotti) brandLogoKey = zanotti.logoKey;
      }
      if (!brandLogoKey) {
        const firstDesc = String(
          ((itemRows[0] ?? {}) as { description?: string | null }).description ?? '',
        ).trim().toUpperCase();
        if (firstDesc) {
          let best: { name: string; logoKey: string | null } | null = null;
          for (const b of brands) {
            if (!firstDesc.startsWith(b.name.toUpperCase())) continue;
            if (!best || b.name.length > best.name.length) best = b;
          }
          brandLogoKey = best?.logoKey ?? null;
        }
      }
    } catch { brandLogoKey = null; }
    (salesOrder as Record<string, unknown>).resolvedBrandLogoKey = brandLogoKey;
  }
  /* Coverage comes from the SAME allocation engine the MRP page uses (Wei Siang
     2026-05-31): stock first → earliest-ETA outstanding PO → shortage. A bare
     FK-only PO lookup missed stock-replenishment POs (raised without a per-line
     link), so genuinely-ordered lines showed "—". Running the MRP allocation
     here keeps the Stock column and the MRP page in lock-step. Best-effort: if
     the allocation fails the page still loads, lines just fall back to Pending. */
  let coverageMap = new Map<string, { source: string; po: string | null; eta: string | null }>();
  try {
    const mrpResult = await computeMrp(sb, { catFilter: null, whFilter: null, includeUndated: true });
    coverageMap = mrpLineCoverage(mrpResult);
  } catch {
    coverageMap = new Map();
  }
  const [remainingMap, deliveriesMap] = await Promise.all([
    soDeliverableRemaining(sb, [docNo]),
    soLineDeliveries(sb, itemRows.map((it) => it.id)),
  ]);
  const items = itemRows.map((it) => {
    const rem = remainingMap.get(it.id);
    const deliveries = deliveriesMap.get(it.id) ?? [];
    const deliveredQty = deliveries.reduce((s, d) => s + d.qty, 0);
    const cov = coverageMap.get(it.id);
    const covered = cov?.source === 'po';
    /* SOFA stock-coverage is decided by the batch-aware allocator (stock_status),
       NOT the MRP SKU-pool: MRP doesn't know about dye-lot batches, so it would
       wrongly report a sofa set as "stock" whenever same-SKU units exist in ANY
       batch — even one that can't cover the whole set. For sofa, trust
       stock_status (READY only when ONE batch covers the set); keep MRP's PO/ETA
       if an outstanding PO is on the way. (Wei Siang 2026-06-03) */
    const isSofaLine = String((it as { item_group?: string | null }).item_group ?? '').toUpperCase().includes('SOFA');
    const stockState = isSofaLine
      ? (it.stock_status === 'READY' ? 'stock' : (cov?.source === 'po' ? 'po' : 'shortage'))
      : (cov?.source ?? null);
    return {
      ...it,
      deliveries,
      delivered_qty: rem?.delivered ?? deliveredQty,
      remaining_qty: rem?.remaining ?? Number(it.qty ?? 0),
      /* Incoming-stock coverage (Wei Siang 2026-05-31) — stock_state is the
         allocation outcome (stock / po / shortage). coverage_po + eta are only
         set when an outstanding PO covers the line, so the UI shows PO·ETA. */
      stock_state: stockState,
      coverage_po: covered ? cov?.po ?? null : null,
      coverage_eta: covered ? cov?.eta ?? null : null,
    };
  });
  const totalDelivered = items.reduce((s, it) => s + Number(it.delivered_qty ?? 0), 0);
  const totalRemaining = items.reduce((s, it) => s + Number(it.remaining_qty ?? 0), 0);
  (salesOrder as Record<string, unknown>).delivery_state =
    totalDelivered <= 0 ? 'none' : totalRemaining > 0 ? 'partial' : 'full';
  /* Status badge driver — same "latest event wins" engine as the list. */
  const [lifecycleByDoc, currentByDoc] = await Promise.all([
    computeSoLifecycle(sb, [docNo]),
    soCurrentDocNo(sb, [docNo]),
  ]);
  (salesOrder as Record<string, unknown>).lifecycle_state = lifecycleByDoc.get(docNo) ?? 'none';
  (salesOrder as Record<string, unknown>).current_doc_no = currentByDoc.get(docNo) ?? (docNo || null);
  /* PWP vouchers THIS order's trigger items issued (Loo 2026-06-05) — the
     customer-facing prints mark the trigger line with the code (used → short
     reference; unused → "issued, not redeemed yet"). pwp_codes always intended
     this ("printed on the SO, redeemable cross-order"); this is the read half.
     Best-effort: a failed lookup never blocks the SO detail. */
  let pwpCodes: Array<Record<string, unknown>> = [];
  try {
    const { data: codeRows } = await sb
      .from('pwp_codes')
      .select('code, status, trigger_item_code, redeemed_doc_no, cart_line_key')
      .eq('source_doc_no', docNo)
      // Deterministic batch order for allocatePwpTriggerNotes — codes earned
      // by the first-added trigger line print on the first matching line.
      .order('created_at', { ascending: true });
    pwpCodes = (codeRows ?? []) as Array<Record<string, unknown>>;
  } catch {
    pwpCodes = [];
  }
  return c.json({ salesOrder, items, pwpCodes });
});

/* Customer credit balance lookup — used by the New Sales Order form to flash
   "Customer has RM X credit available" once the operator picks the customer.
   Returns 0 (not 404) when there's no history yet. */
mfgSalesOrders.get('/customer-credit/:debtorCode', async (c) => {
  const sb = c.get('supabase');
  const debtorCode = c.req.param('debtorCode');
  const balance = await getCustomerCreditBalance(sb, debtorCode);
  return c.json({ debtorCode, balanceCenti: balance });
});

/* Loo 2026-06-05 — 409 gate for the maintained SO dropdown header fields.
   customer_type / building_type / emergency_contact_relationship must hold a
   value from the ACTIVE so_dropdown_options rows: these columns freeze under
   the SO identity lock once a DO/SI exists, so a dirty value would be locked
   in forever. Null / empty passes (the fields are optional); matching is exact
   (the POS / Backend selects submit the maintained `value` verbatim).
   Fail-open when the lookup itself returns nothing — a maintenance-table
   hiccup must never block a paying customer at the counter. */
const SO_DROPDOWN_FIELDS: Array<{ bodyKey: string; category: string }> = [
  { bodyKey: 'customerType',                 category: 'customer_type' },
  { bodyKey: 'buildingType',                 category: 'building_type' },
  { bodyKey: 'emergencyContactRelationship', category: 'relationship' },
];
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- same loose sb
// typing the other loaders in this file use.
async function validateSoDropdownFields(
  sb: any,
  body: Record<string, unknown>,
): Promise<{ error: string; reason: string; offenders: Array<{ field: string; value: string }> } | null> {
  const present = SO_DROPDOWN_FIELDS
    .map(({ bodyKey, category }) => ({ bodyKey, category, value: body[bodyKey] }))
    .filter((f): f is { bodyKey: string; category: string; value: string } =>
      typeof f.value === 'string' && f.value.trim().length > 0);
  if (present.length === 0) return null;
  const { data, error } = await sb
    .from('so_dropdown_options')
    .select('category, value')
    .eq('active', true)
    .in('category', present.map((f) => f.category));
  if (error || !data || data.length === 0) return null;  // fail-open
  const allowed = new Set(
    (data as Array<{ category: string; value: string }>).map((r) => `${r.category}:${r.value}`),
  );
  const offenders = present
    .filter((f) => !allowed.has(`${f.category}:${f.value.trim()}`))
    .map((f) => ({ field: f.bodyKey, value: f.value.trim() }));
  if (offenders.length === 0) return null;
  return {
    error: 'dropdown_value_invalid',
    reason: offenders
      .map((o) => `${o.field} "${o.value}" is not an active option in Sales Order Maintenance`)
      .join('; '),
    offenders,
  };
}

/* One-time backfill — bind a warehouse to every SO line that still has none, by
   re-deriving from its SO's State. The create-time derive only ran once, so SOs
   placed before per-line warehouse routing existed (or via paths that sent no
   address) kept NULL warehouses and show "—" in MRP. Admin-only. SOs with no /
   unmapped State are skipped (they need a location set). Only NULL lines are
   touched — explicit per-line warehouses are never overwritten. */
mfgSalesOrders.post('/backfill-warehouses', async (c) => {
  const sb = c.get('supabase');
  if (!(await isPriceOverrideCaller(c))) return c.json({ error: 'forbidden' }, 403);

  const { data: nullLines } = await sb
    .from('mfg_sales_order_items')
    .select('doc_no')
    .is('warehouse_id', null)
    .eq('cancelled', false);
  const docNos = [...new Set(
    ((nullLines ?? []) as Array<{ doc_no: string | null }>).map((r) => r.doc_no).filter((x): x is string => !!x),
  )];
  if (docNos.length === 0) return c.json({ filled: 0, skipped: 0, orders: 0 });

  // States for those SOs (chunk the .in to dodge the PostgREST row cap).
  const stateByDoc = new Map<string, string | null>();
  for (let i = 0; i < docNos.length; i += 200) {
    const { data: sos } = await sb
      .from('mfg_sales_orders')
      .select('doc_no, customer_state')
      .in('doc_no', docNos.slice(i, i + 200));
    for (const s of (sos ?? []) as Array<{ doc_no: string; customer_state: string | null }>) {
      stateByDoc.set(s.doc_no, s.customer_state);
    }
  }

  let filled = 0; let skipped = 0;
  for (const docNo of docNos) {
    const wh = await deriveWarehouseIdFromState(sb, stateByDoc.get(docNo) ?? null);
    if (!wh) { skipped += 1; continue; }
    await sb
      .from('mfg_sales_order_items')
      .update({ warehouse_id: wh })
      .eq('doc_no', docNo)
      .is('warehouse_id', null)
      .eq('cancelled', false);
    filled += 1;
  }
  return c.json({ filled, skipped, orders: docNos.length });
});

/* ── SO create core (scan-bg-job factoring, 2026-07-04) ─────────────────────
   The POST / handler body below is PRICING-CRITICAL and must stay the single
   authority for SO creation. The background scan job (scan-so.ts /enqueue)
   needs to create a DRAFT SO AFTER the HTTP request has already returned, so
   the handler body is factored MECHANICALLY into `createSalesOrderCore` — the
   body is UNCHANGED; it now takes a minimal structural context instead of the
   full Hono context. The HTTP route wires the real context through (auth /
   validation / response behaviour identical), while `createDraftSalesOrder`
   below feeds it a synthetic context built from Env + the identities captured
   at enqueue time. `c.json(body, status)` inside the core returns a plain
   outcome object; the HTTP route re-emits it as the real JSON response. */
export type SoCreateOutcome = { status: number; body: Record<string, unknown> };
export type SoCreateContext = {
  req: { json(): Promise<unknown> };
  /* supabase keeps the REAL client type — the core body relies on the typed
     query builders for callback inference (an `any` here turns every
     `.map((r) => ...)` inside the body into an implicit-any TS7006). */
  get(key: 'supabase'): Variables['supabase'];
  get(key: 'user'): { id: string; user_metadata?: unknown };
  get(key: 'houzsUser'): Variables['houzsUser'];
  env: Env;
  json(body: unknown, status?: number): SoCreateOutcome;
  /* Audit-trail source tag for the CREATE entry ("via <source>" in the History
     panel). Omitted → 'web' (interactive POST /). The background scan job
     passes 'scan' so the timeline distinguishes an OCR-created draft from a
     hand-typed order. */
  auditSource?: string;
  /* Optional free-text note stamped on the CREATE audit row (the scan job uses
     it to say the draft came from the background OCR pipeline). */
  auditNote?: string;
};

async function createSalesOrderCore(c: SoCreateContext): Promise<SoCreateOutcome> {
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  /* PR #46 — accept customerName as alias for debtorName (rename in flight).
     Commander 2026-05-26: "Debtor Name 其实可以换成 Customer Name". */
  const customerName = (body.debtorName ?? body.customerName) as string | undefined;
  if (!customerName) return c.json({ error: 'customer_name_required' }, 400);
  /* Owner 2026-06-03 (migration 0144) — phone is COMPULSORY on every SO,
     enforced server-side: the POS already client-gates it (validateCustomer)
     and the Backend New SO form gates it too, but the server is the layer a
     tampered or direct API caller can't bypass. Normalise ONCE here and reuse
     for both the SO snapshot (phone column) and the customer identity key. A
     non-MY / unparseable number keeps its raw form (normalizePhone → null)
     rather than being rejected — only an empty phone is blocked. */
  const rawPhone = typeof body.phone === 'string' ? body.phone.trim() : '';
  if (!rawPhone) {
    return c.json({ error: 'phone_required', reason: 'A phone number is required on every sales order.' }, 400);
  }
  const normPhone = normalizePhone(rawPhone) ?? rawPhone;
  /* PR #46 — Items optional. POS handover may create the SO header first,
     then add items via POST /:docNo/items. Matches PR #41 PO blank-draft
     pattern. Only B2B-bulk path requires items at create. */
  const items = (body.items as Array<Record<string, unknown>> | undefined) ?? [];

  const sb = c.get('supabase'); const user = c.get('user');

  // Edge #4 — itemCode catalog guard. Reject typos / stale codes before any
  // pricing / variant / inventory work runs.
  if (items.length > 0) {
    const codeCheck = await validateItemCodes(sb, items.map((it) => it.itemCode as string | null | undefined));
    if (!codeCheck.ok) return c.json(unknownItemCodeResponse(codeCheck.unknown), 409);
  }

  /* POS line quantity (Loo 2026-06-12) — see invalidQtyResponse. Runs before
     any PWP claim so a reject burns nothing. */
  for (let i = 0; i < items.length; i++) {
    const badQty = invalidQtyResponse(items[i]?.qty, items[i]?.itemCode, i);
    if (badQty) return c.json(badQty, 422);
  }

  /* PR — Commander 2026-05-28 — SO composition rules, enforced on the CREATE
     path so the API matches what the SO Detail edit page already blocks.
     (Bug: the create path let through both "delivery date without a processing
     date" AND a sofa+mattress mixed cart — the test batch hit both.)
       1. Processing Date + Delivery Date are all-or-nothing — never one without
          the other (mirrors the edit page's "must be set together" guard).
       2. SOFA is exclusive among MAIN products (sofa / bedframe / mattress):
          a sofa SO may NOT also contain a bedframe or mattress. SERVICE and
          ACCESSORY (and other add-on lines) ride on ANY SO — they never trip
          this. (Commander 2026-05-28: "main product 不能添加…但 service 或
          accessory 什么 products 都可以配".)
       3. All MATTRESS lines in one SO must share ONE brand — different mattress
          brands bill on separate SOs. (Bedframe may ride with a single-brand
          mattress; that combo stays allowed.) */
  {
    const procDate  = (body.internalExpectedDd  as string | null | undefined) || null;
    const delivDate = (body.customerDeliveryDate as string | null | undefined) || null;
    if (Boolean(procDate) !== Boolean(delivDate)) {
      return c.json({
        error: 'processing_delivery_must_pair',
        reason: 'Processing Date and Delivery Date must be set together (or both left empty).',
      }, 400);
    }
    /* Owner 2026-06-03 — Process Date is the factory start; it cannot fall after
       the Delivery Date (you can't start building after the day you promised to
       deliver). Both are plain ISO YYYY-MM-DD, so a string compare is correct. */
    if (procDate && delivDate && procDate > delivDate) {
      return c.json({
        error: 'processing_after_delivery',
        reason: 'Processing Date cannot be later than the Delivery Date.',
      }, 400);
    }
    /* Commander 2026-05-29 — a Processing Date means "ready to build", so every
       line must carry its category-mandatory variants. This guard existed on
       the PATCH header path + the UI but the CREATE path skipped it, so a direct
       POST with a processing date + blank bedframe/sofa variants slipped through
       (found while seeding test SOs). Shared helper keeps POST/PATCH/UI in sync. */
    if (procDate) {
      const offenders = findIncompleteVariantLines(
        items.map((it) => ({
          itemCode: String(it.itemCode ?? ''),
          group:    (it.itemGroup as string | null | undefined) ?? null,
          variants: (it.variants as Record<string, unknown> | null) ?? null,
        })),
      );
      if (offenders.length > 0) {
        return c.json({
          error: 'variants_incomplete',
          message: 'Processing Date requires all category-mandatory variants on every line.',
          offenders,
        }, 409);
      }
    }
    /* Commander 2026-05-28 — Processing Date + Delivery Date can only be today
       or in the future; a past date is rejected. "Today" is Malaysia time
       (UTC+8) so an early-UTC request near midnight doesn't wrongly reject a
       valid MY today. */
    const todayMY = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    if (procDate && procDate < todayMY) {
      return c.json({ error: 'processing_date_past', reason: 'Processing Date cannot be in the past — today or a future date only.' }, 400);
    }
    if (delivDate && delivDate < todayMY) {
      return c.json({ error: 'delivery_date_past', reason: 'Delivery Date cannot be in the past — today or a future date only.' }, 400);
    }
    if (items.length > 0) {
      const lineCodes = items.map((it) => String(it.itemCode ?? '')).filter(Boolean);
      const metaByCode = new Map<string, { category: string }>();
      if (lineCodes.length > 0) {
        const { data: meta } = await sb
          .from('mfg_products')
          .select('code, category')
          .in('code', lineCodes);
        for (const m of (meta ?? []) as Array<{ code: string; category: string }>) {
          metaByCode.set(m.code, { category: m.category });
        }
      }
      const normCat = (raw: string): string => {
        const g = (raw ?? '').trim().toUpperCase();
        if (g.includes('BEDFRAME')) return 'BEDFRAME';
        if (g.includes('SOFA'))     return 'SOFA';
        if (g.includes('MATTRESS')) return 'MATTRESS';
        if (g.includes('ACCESSOR')) return 'ACCESSORY';
        if (g.includes('SERVICE'))  return 'SERVICE';
        return 'OTHERS';
      };
      // MAIN products carry the mixing constraints; SERVICE / ACCESSORY /
      // OTHERS are universal add-ons that ride on any SO.
      const MAIN = new Set(['SOFA', 'BEDFRAME', 'MATTRESS']);
      const cats = items.map((it) =>
        normCat(metaByCode.get(String(it.itemCode ?? ''))?.category ?? (it.itemGroup as string) ?? ''),
      );
      // Rule 2 — sofa is exclusive among MAIN products: no bedframe / mattress
      // alongside a sofa. Service / accessory add-ons are always fine.
      if (cats.includes('SOFA') && cats.some((cat) => cat !== 'SOFA' && MAIN.has(cat))) {
        return c.json({
          error: 'so_sofa_no_other_main',
          reason: 'A sofa Sales Order cannot also contain a bedframe or mattress. Service and accessory items are fine.',
        }, 400);
      }
      /* Loo 2026-06-07 — mattress lines MAY mix brands on one SO. The old
         Rule 3 (`so_mattress_one_brand`, #280) blocked e.g. a Happi.S +
         2990 mattress in one order at the POS counter; the owner never set
         that rule. Sofa exclusivity above is the only MAIN-mix gate.
         Don't re-add a brand gate here. */
    }
  }

  const docNo = await nextDocNo(sb);

  /* Caller's REAL scm.staff identity (mig 0066 deterministic sync row,
     linked by staff.user_id) — drives the venue auto-stamp AND the
     salesperson self-lock below. `user.id` is the bridge's pinned SYSTEM
     staff uuid shared by every caller; stamping it as salesperson_id made
     every self-created SO belong to "System" instead of the person, which
     breaks the self-scoped visibility (own + downline) rule. Fall back to
     the system row only when the sync row is missing (inactive/unsynced). */
  const callerStaffId = (await resolveCallerStaffId(sb, c.get('houzsUser')?.id)) ?? user.id;
  const { data: callerStaff } = await sb
    .from('staff')
    .select('role, venue_id')
    .eq('id', callerStaffId)
    .maybeSingle();
  /* Loo 2026-06-05 — a self-scoped sales caller can only create orders under
     their OWN account: whatever salespersonId the client sent is overridden
     with the caller's id (the POS locks the picker too; this closes the API
     hole). Houzs-flavoured: gate on the flat permission key
     `scm.so.attribute_other` against the REAL caller (the 2990 scm.staff.role
     lookup is dead in Houzs — the SCM bridge pins every caller to one
     super_admin row). Owner + IT Admin pass via `*`; grant to other positions
     via the Team > Positions matrix. */
  const salespersonIdToStamp = hasHouzsPerm(c, 'scm.so.attribute_other')
    ? ((body.salespersonId as string) ?? null)
    : callerStaffId;

  /* Migration 0086 + Loo 2026-06-06 — venue follows the SELECTED salesperson:
     an admin/coordinator entering an SO on behalf of a PJ salesperson stamps
     PJ automatically (before, only the CALLER's venue counted, so any
     admin-placed POS order carried a blank venue). Priority:
       1. explicit body.venueId (the Backend form types/derives it)
       2. the stamped salesperson's staff.venue_id
       3. the caller's own staff.venue_id when they're a POS-side role
     A venue-less salesperson (admin testing under their own name) stays
     NULL — admins oversee every venue by design. */
  let venueIdToStamp: string | null = (body.venueId as string | null | undefined) ?? null;
  if (!venueIdToStamp && salespersonIdToStamp) {
    if (salespersonIdToStamp === callerStaffId) {
      venueIdToStamp = (callerStaff?.venue_id as string | null) ?? null;
    } else {
      const { data: spStaff } = await sb
        .from('staff')
        .select('venue_id')
        .eq('id', salespersonIdToStamp)
        .maybeSingle();
      venueIdToStamp = (spStaff as { venue_id?: string | null } | null)?.venue_id ?? null;
    }
  }
  if (!venueIdToStamp) {
    if (callerStaff && callerStaff.venue_id &&
        ['sales', 'sales_executive', 'outlet_manager'].includes(callerStaff.role)) {
      venueIdToStamp = callerStaff.venue_id as string;
    }
  }

  /* SO-SKU spec P5 (§4.5) — resolve the venue FK to its display name once.
     Until now venue_id was stamped but the `venue` TEXT stayed NULL, so the
     Detail Listing's Venue column never lit for POS orders. An explicit
     body.venue still wins (the Backend form types it); lines inherit via the
     report flatten. */
  let resolvedVenueName: string | null =
    typeof body.venue === 'string' && body.venue.trim() ? body.venue.trim() : null;
  if (!resolvedVenueName && venueIdToStamp) {
    const { data: venueRow } = await sb
      .from('venues').select('name').eq('id', venueIdToStamp).maybeSingle();
    resolvedVenueName = (venueRow as { name?: string } | null)?.name ?? null;
  }

  /* Houzs venue-by-project (owner 2026-06-25) — scm.staff is unused in Houzs, so
     the home-venue logic above always leaves venue NULL. Fall back to the
     LOGGED-IN salesperson's currently-active exhibition project: the latest
     project (by start_date, <= the SO date) they are the PIC of OR a Sales
     Attending rep of (owner 2026-06-25: "PIC 或 Sales Attending 都算"). The
     over-assigned PICs in Houzs data are NON-salespeople (user 1 = the HOUZS
     CENTURY system account; orphan pic_ids with no users row) who never log in
     to create SOs, so they don't mis-resolve; real salesperson-PICs are clean.
     Stamps the venue
     TEXT only (the project venue isn't a scm.venues row, so venue_id stays
     NULL); an explicit body.venue still wins. Reads the PUBLIC schema via
     c.env.DB — the scm supabase client can't reach public. */
  if (!resolvedVenueName) {
    const houzsUser = c.get('houzsUser');
    const uid = houzsUser?.id != null ? Number(houzsUser.id) : NaN;
    if (Number.isFinite(uid)) {
      const soDateForVenue =
        typeof body.soDate === 'string' && body.soDate.trim()
          ? body.soDate.trim().slice(0, 10)
          : todayMyt();
      try {
        const projRow = await c.env.DB.prepare(
          `SELECT p.venue AS venue
             FROM projects p
            WHERE p.start_date IS NOT NULL
              AND p.start_date <= ?
              AND p.venue IS NOT NULL AND p.venue <> ''
              AND (
                p.pic_id = ?
                OR EXISTS (
                  SELECT 1 FROM project_sales_attendees psa
                    JOIN sales_reps sr ON sr.id = psa.sales_rep_id
                   WHERE psa.project_id = p.id AND sr.user_id = ?
                )
              )
            ORDER BY p.start_date DESC
            LIMIT 1`,
        )
          .bind(soDateForVenue, uid, uid)
          .first<{ venue?: string | null }>();
        const v = projRow?.venue ?? null;
        if (typeof v === 'string' && v.trim()) resolvedVenueName = v.trim();
      } catch {
        /* non-fatal — leave venue NULL if the project lookup fails */
      }
    }
  }

  /* Houzs venue_id guard — the New-SO Venue dropdown is sourced from
     public.project_venues (INTEGER ids, mapped to string in the FE), but
     mfg_sales_orders.venue_id is a UUID FK to the (empty/unused) scm.venues.
     Writing a project_venues integer id into the uuid column 500s the insert
     ("invalid input syntax for type uuid"). So only stamp venue_id when it is a
     real uuid (a legacy scm.venues id); else NULL it — the venue TEXT column
     (resolvedVenueName) is the source of truth for the venue. */
  const venueIdUuid =
    typeof venueIdToStamp === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(venueIdToStamp)
      ? venueIdToStamp
      : null;

  // Compute totals + category breakdown
  let mattressSofa = 0, bedframe = 0, accessories = 0, others = 0, total = 0, totalCost = 0;
  // Task #114 — also accumulate per-category COST so the four cost columns
  // on the header (migration 0079) get populated on insert. Mirrors the
  // revenue accumulators above.
  let mattressSofaCost = 0, bedframeCost = 0, accessoriesCost = 0, othersCost = 0;
  /* PR-E — Per-item delivery date inherits the SO header's
     customer_delivery_date on create unless the client explicitly
     supplies a per-line lineDeliveryDate. Override flag mirrors the
     client's choice (defaults false → cascade-tracked). */
  const headerDeliveryDate = (body.customerDeliveryDate as string | null | undefined) ?? null;
  /* MFG-PRICING-ENGINE — Server-side recompute (Commander 2026-05-27
     non-negotiable; the honest-pricing red line). Load the master
     maintenance config once, then for each line item recompute the
     unit price from (product, fabric, variants). Drift > 0.5% rejects
     the request with HTTP 400. Manual override path (mfgSoPriceOverrides)
     stays intact at PATCH /:docNo/items/:itemId/override. */
  const cachedConfig = await loadMaintenanceConfig(sb);
  // Special Add-ons (migration 0134) — fetched once; each line's specials pool is
  // built from these so POS add-ons price from special_addons, not the legacy pool.
  const cachedSpecialAddons = await loadSpecialAddons(sb);
  /* PR #216 — allowed_options pre-flight. Run BEFORE the pricing recompute
     so a disallowed variant returns the precise field/value/allowed
     payload instead of getting silently re-priced. Batched (Loo 2026-06-06):
     2 `in()` queries for the whole order instead of 2 × lines — per-line
     loads helped a 6-item order blow the CF Workers subrequest cap.
     First violation across all lines short-circuits the request. */
  const pmByCode = await loadProductsAndModels(sb, items.map((it) => String(it?.itemCode ?? '')));
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it) continue;
    const code = String(it.itemCode ?? '');
    if (!code) continue;
    const pm = pmByCode.get(code) ?? { product: null, model: null };
    const err = checkAllowedOptions(
      pm.product,
      pm.model,
      (it.variants as Parameters<typeof checkAllowedOptions>[2]) ?? null,
    );
    if (err) {
      return c.json({ ...err, lineIdx: i, itemCode: code }, 400);
    }
  }
  const cachedCombos = await loadActiveSofaCombos(sb);  // Phase 4b — sofa selling recompute
  const cachedFabricAddonConfig = await loadFabricTierAddonConfig(sb);  // migration 0124 — fabric-tier Δ
  const cachedModelOverrides = await loadModelFabricTierOverrides(sb);  // migration 0172 — per-Model Δ
  const cachedCompartmentOverrides = await loadCompartmentFabricTierOverrides(sb);  // migration 0025 — per-compartment Δ

  /* Loo 2026-06-05 — maintained-dropdown 409 gate. Runs BEFORE any side
     effect (customer upsert, PWP claims) so a rejected request leaves
     nothing behind. */
  const dropdownErr = await validateSoDropdownFields(sb, body);
  if (dropdownErr) return c.json(dropdownErr, 409);

  // Subrequest diet (Loo 2026-06-06) — one `in()` query for every line's
  // product row instead of one query per line.
  const productRowByCode = await loadProductsByCodes(sb, items.map((it) => String(it.itemCode ?? '')));
  const lineProducts = items.map((it) => productRowByCode.get(String(it.itemCode ?? '').trim()) ?? null);
  /* PWP Code Voucher (migration 0130) — code-driven grant + atomic claim. A
     reward line earns its per-SKU pwp_price_sen ONLY if it carries a valid
     `variants.pwpCode`: the code exists, is redeemable (AVAILABLE, or RESERVED
     owned by the caller), its snapshot reward_category + eligible model list
     match the reward product, the reward SKU has pwp_price_sen > 0, and — for an
     AVAILABLE cross-order voucher — the order's customer matches the code's bound
     customer (§8.8). Each valid code is CLAIMED atomically (conditional UPDATE →
     USED) so two orders can't double-spend one; a lost race / forged / used /
     ineligible code is simply not granted → that line reprices at full
     sell_price_sen → drift → 400 for a POS-tablet caller. Un-applied reserved
     codes owned by this order's triggers are flipped to AVAILABLE after insert
     (carried-forward voucher). Default data (no codes) → nothing granted → no
     change. NOTE: applied on the create path; backend per-line PATCH/override
     re-prices at full sell price (no order context) — re-create to re-apply. */
  /* Owner 2026-06-03 (migration 0144) — resolve the REAL customer identity
     (find-or-create by name + phone) and stamp it on the SO. Phone is validated
     above so the key is always complete. Best-effort: an unexpected RPC error
     must not block a paying customer at the counter, so we log it and fall back
     to null (a Phase 2 backfill can repair it). The resolved id flows into the
     SO header (customer_id), the cross-category "same customer" match, and the
     PWP voucher binding below — all of which previously saw a permanently-null
     customer_id (the POS never sent one). */
  let orderCustomerId: string | null = null;
  /* Scan blank-draft shell (owner 2026-07-04) — a scan that could not read the
     customer's name/phone still lands a draft the rep completes by hand, but it
     carries PLACEHOLDER name/phone. Resolving a customer identity off those
     placeholders would spawn a phantom customer (and collide every blank shell
     onto one bogus record), so shells skip the upsert; customer_id stays null
     until the rep fills the real name/phone and re-saves. */
  if (body._scanShell !== true) {
    const { data: resolvedCustomerId, error: customerErr } = await sb.rpc('upsert_customer_by_name_phone', {
      p_name:  customerName,
      p_phone: normPhone,
      p_email: typeof body.email === 'string' && body.email.trim() ? body.email.trim() : null,
    });
    if (customerErr) {
      console.error('[mfg-so] customer resolve failed:', customerErr.message ?? customerErr);
    } else {
      orderCustomerId = (resolvedCustomerId as string | null) ?? null;
    }
  }
  const pwpBaseByIdx = new Map<number, number>();            // non-sofa idx → pwp_price_sen
  const pwpSofaByIdx = new Map<number, string[]>();          // sofa idx → granted reward combo ids
  /* Default Free Gift (migration 0170) — a line tagged variants.freeGift is
     priced to RM 0 ONLY when the order also carries a real qualifying trigger
     (a non-sofa product's default_free_gifts, or a sofa build matching a combo's
     default_free_gifts — D9). Validated below, after PWP settles; an ineligible
     gift is rejected 409 free_gift_not_eligible. The grant rides the SAME 0-base
     path PWP uses (pwpBaseSen = 0 ⇒ free), so recomputeFromSnapshot needs no new
     parameter. Honest-pricing (CLAUDE.md): a gift with no trigger reprices to the
     accessory's real sell_price_sen → a tampered "free" client price drifts. */
  const freeGiftBaseByIdx = new Map<number, number>();       // gift line idx → granted base (always 0)
  // Free Item Campaign (migration 0176) — idx → resolved {campaignId, campaignName}.
  const freeItemByIdx = new Map<number, { campaignId: string; campaignName: string }>();
  const claimedPwpCodes: Array<{ code: string; prevStatus: string }> = [];
  /* Loo 2026-06-05 (VALOR / PW-Test-voucher incident) — a line that CARRIES a
     pwpCode but fails the grant used to be silently repriced at full price,
     surfacing later as an inscrutable pricing_drift. Track WHY each code was
     refused and reject the whole order with an explicit 409 instead — the
     salesperson sees "code belongs to a different customer", not a price diff. */
  const pwpRejections: Array<{ idx: number; itemCode: string; code: string; reason: string }> = [];
  /* One code = one redemption (Loo 2026-06-06, PWP-1528WLIE incident) — the
     same code on TWO lines of one order used to double-grant: line A's claim
     flips it USED → redeemed_doc_no = docNo, but the SO row isn't inserted
     until after this loop, so line B's orphan check found no such SO and
     "self-healed" line A's fresh claim. Gate duplicates up front. */
  const seenPwpCodes = new Set<string>();
  /* Subrequest diet (Loo 2026-06-06) — prefetch every carried code in ONE
     `in()` query instead of one read per code. The conditional UPDATE below
     stays the atomicity authority: a code claimed by a parallel order between
     this read and the claim simply fails the claim ("just claimed — try
     again"), exactly as before. */
  const allPwpCodes = Array.from(new Set(
    items
      .map((it) => String((it?.variants as { pwpCode?: string | null } | null)?.pwpCode ?? '').trim())
      .filter(Boolean),
  ));
  const pwpRowByCode = new Map<string, Record<string, any>>();
  let pwpPrefetchFailed = false;
  if (allPwpCodes.length > 0) {
    const { data: codeRows, error: codeReadErr } = await sb
      .from('pwp_codes')
      .select('code, status, owner_staff_id, reward_category, eligible_reward_model_ids, reward_combo_ids, reward_size_codes, reward_compartments, customer_id, source_doc_no, redeemed_doc_no, type')
      .in('code', allPwpCodes);
    if (codeReadErr) {
      // A failed read is NOT "code not found" (same honesty rule as the
      // cross-category lookup) — reject as retryable, burn nothing.
      console.error('[mfg-so] pwp code prefetch failed:', codeReadErr.message ?? codeReadErr);
      pwpPrefetchFailed = true;
    }
    for (const r of ((codeRows as Array<Record<string, any>>) ?? [])) pwpRowByCode.set(String(r.code), r);
  }
  for (let idx = 0; idx < items.length; idx++) {
    const it = items[idx];
    const code = String((it?.variants as { pwpCode?: string | null } | null)?.pwpCode ?? '').trim();
    if (!code) continue;
    const reject = (reason: string) =>
      pwpRejections.push({ idx, itemCode: String(it?.itemCode ?? ''), code, reason });
    if (seenPwpCodes.has(code)) { reject('code is already applied to another line on this order'); continue; }
    seenPwpCodes.add(code);
    /* One code = one redemption = ONE unit (Loo 2026-06-12, POS line-quantity).
       A reward line with qty > 1 would price every unit at the PWP grant off a
       single voucher. The POS stepper + cart store pin reward lines to 1; this
       is the authority. */
    if (Number(it?.qty ?? 1) !== 1) { reject('a PWP reward line must be quantity 1'); continue; }
    const product = lineProducts[idx];
    if (!product) { reject('unknown item code'); continue; }
    if (pwpPrefetchFailed) { reject('could not verify the code — please try again'); continue; }
    const cRow = pwpRowByCode.get(code) ?? null;
    if (!cRow) { reject('code not found — it may have been replaced; re-apply PWP on this line'); continue; }
    const redeemable = cRow.status === 'AVAILABLE' || (cRow.status === 'RESERVED' && cRow.owner_staff_id === user.id);
    /* Orphan self-heal (2026-06-05, SO-2606-020 incident) — a code claimed by a
       create attempt that died on a path without rollbackPwpClaims (uncaught
       exception / Worker timeout) is left USED pointing at a doc_no that was
       never inserted. Every retry then sees USED → no grant → full reprice →
       pricing_drift, bricking the cart forever. If the redeemed SO does not
       exist, the claim never really happened — treat the code as redeemable
       again. (A legitimately USED code points at a real SO and stays burned.) */
    let orphanedUsed = false;
    // Never treat THIS request's own docNo as a dead SO — it is inserted only
    // after this loop, so a code claimed earlier in this request would look
    // orphaned and get double-granted (belt to the seenPwpCodes braces above).
    if (!redeemable && cRow.status === 'USED' && cRow.redeemed_doc_no && cRow.redeemed_doc_no !== docNo) {
      const { data: deadSo } = await sb
        .from('mfg_sales_orders')
        .select('doc_no')
        .eq('doc_no', cRow.redeemed_doc_no)
        .maybeSingle();
      orphanedUsed = !deadSo;
    }
    if (!redeemable && !orphanedUsed) {
      reject(cRow.status === 'USED'
        ? `code already used${cRow.redeemed_doc_no ? ` on ${cRow.redeemed_doc_no}` : ''}`
        : cRow.status === 'RESERVED'
          ? 'code is reserved by another salesperson'
          : `code is not redeemable (${cRow.status})`);
      continue;
    }
    const prodCat = String(product.category ?? '').toUpperCase();
    if (prodCat !== String(cRow.reward_category).toUpperCase()) {
      reject(`code rewards ${String(cRow.reward_category)}, not this item`);
      continue;
    }
    // Customer binding — an AVAILABLE voucher only redeems for its earner.
    if (cRow.status === 'AVAILABLE' && cRow.customer_id && orderCustomerId && cRow.customer_id !== orderCustomerId) {
      reject('code belongs to a different customer');
      continue;
    }

    // Eligibility — SOFA is matched by Combo (Phase 2); other categories by the
    // reward Model + a per-SKU PWP price. A miss → not granted → the line keeps
    // its full price → a claimed-PWP tamper drifts → 400 (the code is NOT burned).
    let grantSofaComboIds: string[] | null = null;
    let grantPwpPrice = 0;
    if (prodCat === 'SOFA') {
      const rewardComboIds = (cRow.reward_combo_ids as string[] | null) ?? [];
      if (rewardComboIds.length === 0) { reject('voucher has no reward combos'); continue; }
      const sofaArgs = extractSofaComboLookupArgs(String(it?.itemGroup ?? 'sofa'), (it?.variants as Record<string, unknown> | null) ?? null);
      const built = sofaArgs?.modules ?? [];
      if (built.length === 0) { reject('sofa line carries no build modules'); continue; }
      const candidate = cachedCombos.filter(
        (c) => rewardComboIds.includes(c.id) && (!product.base_model || c.baseModel === product.base_model),
      );
      if (!candidate.some((c) => matchComboSubset(built, c.modules) != null)) {
        reject("sofa build doesn't match the voucher's reward combo");
        continue;
      }
      // Reward compartment refinement (0182) — the code snapshots the rule's
      // reward refinement; the build must satisfy it.
      if (!passesRefinementColumns(
        { category: 'SOFA', modelId: product.model_id ?? null, sizeCode: null, builtCompartments: built },
        (cRow.reward_size_codes as string[] | null) ?? null,
        (cRow.reward_compartments as string[] | null) ?? null,
      )) { reject("sofa build doesn't match the voucher's reward compartment"); continue; }
      grantSofaComboIds = rewardComboIds;
    } else {
      const pwpPrice = Math.round(Number(product.pwp_price_sen ?? 0));
      // A 'promo' code prices a 0 reward as FREE; a 'pwp' code still needs a set
      // price (> 0), where 0 means "no PWP price". (migration 0145)
      const isPromo = String(cRow.type ?? 'pwp') === 'promo';
      if (!isPromo && !(pwpPrice > 0)) { reject('this SKU has no PWP price set (SKU Master)'); continue; }
      const elig = (cRow.eligible_reward_model_ids as string[] | null) ?? [];
      const modelOk = elig.length === 0 || (product.model_id != null && elig.includes(product.model_id));
      if (!modelOk) { reject('code is not valid for this model'); continue; }
      // Reward size refinement (0182).
      if (!passesRefinementColumns(
        { category: prodCat, modelId: product.model_id ?? null, sizeCode: product.size_code ? String(product.size_code).toUpperCase() : null, builtCompartments: [] },
        (cRow.reward_size_codes as string[] | null) ?? null,
        (cRow.reward_compartments as string[] | null) ?? null,
      )) { reject('code is not valid for this size'); continue; }
      grantPwpPrice = pwpPrice;
    }

    // Atomic claim — USED only if still redeemable. Preserve the original
    // source_doc_no (earning SO) for a cross-order voucher; stamp it for a
    // same-cart one.
    let claimQ = sb
      .from('pwp_codes')
      .update({
        status:             'USED',
        source_doc_no:      cRow.source_doc_no ?? docNo,
        redeemed_doc_no:    docNo,
        redeemed_item_code: product.code,
        updated_at:         new Date().toISOString(),
      })
      .eq('code', code);
    // Orphaned-USED re-claim must match the orphan row exactly (USED + the same
    // dead doc_no) so a parallel legitimate redemption can't be hijacked.
    claimQ = orphanedUsed
      ? claimQ.eq('status', 'USED').eq('redeemed_doc_no', cRow.redeemed_doc_no)
      : claimQ.in('status', ['RESERVED', 'AVAILABLE']);
    const { data: claimed } = await claimQ.select('code').maybeSingle();
    if (!claimed) { reject('code was just claimed by another order — try again'); continue; }
    /* prevStatus drives the rollback restore. For an orphan re-claim the true
       pre-incident status is unknown (the dead attempt never rolled back), so
       restore to the most plausible redeemable state — RESERVED when the code
       has an owner (same-cart voucher), else AVAILABLE — never back to the
       bricked USED. */
    const prevStatus = orphanedUsed
      ? (cRow.owner_staff_id ? 'RESERVED' : 'AVAILABLE')
      : cRow.status;
    claimedPwpCodes.push({ code, prevStatus });
    if (grantSofaComboIds) pwpSofaByIdx.set(idx, grantSofaComboIds);
    else pwpBaseByIdx.set(idx, grantPwpPrice);
  }
  /* Restore claimed codes to their prior state when the request is rejected
     after the claim (drift 400 / insert failure) so a failed order never
     silently burns a voucher. */
  const rollbackPwpClaims = async () => {
    for (const { code, prevStatus } of claimedPwpCodes) {
      const patch: Record<string, unknown> = {
        status: prevStatus, redeemed_doc_no: null, redeemed_item_code: null,
        updated_at: new Date().toISOString(),
      };
      if (prevStatus === 'RESERVED') patch.source_doc_no = null;  // we stamped it on claim
      await sb.from('pwp_codes').update(patch).eq('code', code).eq('status', 'USED');
    }
  };

  /* Explicit 409 when ANY carried code was refused (Loo 2026-06-05). Without
     this the refused line silently repriced at full price and the order died
     later as a bare pricing_drift — undebuggable from the tablet. Codes that
     DID claim for other lines are rolled back so nothing burns. */
  if (pwpRejections.length > 0) {
    await rollbackPwpClaims();
    return c.json({
      error: 'pwp_code_rejected',
      reason: pwpRejections
        .map((r) => `${r.itemCode || `line ${r.idx + 1}`}: ${r.code} — ${r.reason}`)
        .join('; '),
      offendersPwp: pwpRejections,
    }, 409);
  }

  /* Default Free Gift validation (migration 0170, D9) — runs AFTER PWP settles
     (so a gift never collides with a voucher) and BEFORE the recompute pass (so
     a granted gift can ride the pwpBaseSen = 0 path). A line tagged
     `variants.freeGift` is granted base 0 ONLY when the order ALSO carries a real
     qualifying trigger: a NON-sofa product whose default_free_gifts grants the
     claimed gift product, OR a SOFA line whose build matches a combo carrying
     default_free_gifts (D9). Triggers and claims are pure data fed to the shared
     validateFreeGiftClaims; ANY ineligible gift → 409 free_gift_not_eligible
     (after rollbackPwpClaims so nothing burns). Honest-pricing: a rejected /
     un-granted gift reprices to the accessory's real sell_price_sen below, so a
     tampered "free" client price drifts → 400. */
  {
    // Per-Model default-gift map (migration 0174), keyed by product_models.id,
    // loaded ONCE for the whole request (never per-line — CF Workers subrequest
    // cap). Shared with reconcile via the per-Model buildFreeGiftTriggers so
    // create + edit can never compute a different gift set.
    const modelGiftsById = await loadModelDefaultGifts(sb);

    // Flatten each request line to a TriggerLine for the shared builder. The
    // per-line index keys the trigger (`idx-${idx}`); a gift line (freeGift)
    // is flagged so the builder skips it as a trigger (one-way). Gifts resolve
    // from the line's Model (model_id), not the combo — combo gifting is retired.
    const triggerLines: TriggerLine[] = items.map((it, idx) => {
      const variants = (it?.variants as Record<string, unknown> | null) ?? null;
      const product = lineProducts[idx] ?? null;
      const modelId = product?.model_id ?? null;
      return {
        triggerKey: `idx-${idx}`,
        itemCode:   product?.code ?? '',
        category:   String(product?.category ?? ''),
        qty:        Number(it?.qty ?? 1),
        modelId,
        buildKey:   (variants?.buildKey as string | undefined) ?? null,
        isFreeGift: Boolean(variants?.freeGift),
        gifts:      modelId ? (modelGiftsById.get(modelId) ?? []) : [],
      };
    });
    const triggers = buildFreeGiftTriggers(triggerLines);

    const claims: FreeGiftLineClaim[] = [];
    for (let idx = 0; idx < items.length; idx++) {
      const it = items[idx];
      const variants = (it?.variants as Record<string, unknown> | null) ?? null;
      const fg = variants?.freeGift;
      if (!fg) continue;
      const fgObj = (fg && typeof fg === 'object') ? (fg as Record<string, unknown>) : null;
      // giftProductId is an mfg_products.id (set by the POS marshaller). No
      // itemCode (SKU) fallback — a SKU would never match the UUID-keyed trigger
      // config, so an empty id fails honestly as `no_trigger` rather than
      // masquerading as ineligibility.
      const giftProductId = String(fgObj?.giftProductId ?? '');
      claims.push({ idx, giftProductId, qty: Number(it?.qty ?? 1) });
    }

    if (claims.length > 0) {
      const { valid, rejected } = validateFreeGiftClaims(claims, triggers);
      if (rejected.length > 0) {
        await rollbackPwpClaims();
        return c.json({
          error: 'free_gift_not_eligible',
          reason: rejected
            .map((r) => `line ${r.idx + 1}: ${r.giftProductId} — ${r.reason}`)
            .join('; '),
          offendersFreeGift: rejected,
        }, 409);
      }
      for (const idx of valid) freeGiftBaseByIdx.set(idx, 0);
    }
  }

  /* Free Item Campaign (migration 0176) — a line tagged variants.freeItem
     { campaignId } is forced to RM0 ONLY when an ACTIVE campaign covers the
     line's Model (sofa 'combo' scope: the build must match the pinned combo) AND
     the line qty <= the campaign's per-line cap. Eligibility uses the SAME shared
     campaignsCoveringLine the POS button uses (no drift). Ineligible → 409
     free_item_not_eligible (after rollbackPwpClaims). The forced-zero + drift skip
     live in the persist pass below; here we only validate + resolve the name. */
  {
    const activeCampaigns = await loadActiveFreeItemCampaigns(sb);
    const comboModulesById = new Map<string, string[][]>(
      cachedCombos.map((cb) => [cb.id, cb.modules]),
    );
    const rejections: Array<{ idx: number; reason: string }> = [];
    for (let idx = 0; idx < items.length; idx++) {
      const it = items[idx];
      const variants = (it?.variants as Record<string, unknown> | null) ?? null;
      const fi = variants?.freeItem;
      if (!fi || typeof fi !== 'object') continue;
      const campaignId = String((fi as Record<string, unknown>).campaignId ?? '');
      if (!campaignId) { rejections.push({ idx, reason: 'no_campaign' }); continue; }
      const product = lineProducts[idx] ?? null;
      const cells = (variants?.cells as Array<{ moduleId?: unknown }> | undefined) ?? [];
      const built = Array.isArray(cells)
        ? cells.map((cl) => String(cl?.moduleId ?? '')).filter(Boolean)
        : [];
      const covering = campaignsCoveringLine(
        { category: String(product?.category ?? ''), modelId: product?.model_id ?? null, builtModuleIds: built },
        activeCampaigns,
        comboModulesById,
      );
      const chosen = covering.find((c) => c.id === campaignId);
      if (!chosen) { rejections.push({ idx, reason: 'not_eligible' }); continue; }
      if (Number(it?.qty ?? 1) > chosen.maxFreeQty) { rejections.push({ idx, reason: 'over_cap' }); continue; }
      // Stamp the resolved name onto the persisted variants (D8) + mark forced-zero.
      if (!it) continue; // narrowing guard — items[idx] is always set at this point
      const v = (it.variants as Record<string, unknown> | null) ?? {};
      v.freeItem = { campaignId: chosen.id, campaignName: chosen.name };
      (it as { variants?: unknown }).variants = v;
      freeItemByIdx.set(idx, { campaignId: chosen.id, campaignName: chosen.name });
    }
    if (rejections.length > 0) {
      await rollbackPwpClaims();
      return c.json({
        error: 'free_item_not_eligible',
        reason: rejections.map((r) => `line ${r.idx + 1}: ${r.reason}`).join('; '),
        offendersFreeItem: rejections,
      }, 409);
    }
  }

  /* P3 — keep each sofa item's module price map so the split below distributes
     the build total with the SAME weights the drift gate priced from. */
  const sofaModulePricesByIdx = new Map<number, Record<string, number> | null>();
  /* Loo 2026-06-13 — the POS product-page remark + special add-on (note + extra
     charge) is always available; the pos_product_remark gate was removed. The
     only flag still read here is the retired pos_remark_extra_auto_sku (one-shot
     mint, OFF by default); resolve it just for the lines that declare an extra. */
  const hasDeclaredExtra = items.some((it) =>
    Number((it.variants as { extraAddonAmountRM?: unknown } | null)?.extraAddonAmountRM ?? 0) > 0);
  let autoSkuEnabled = false;
  if (hasDeclaredExtra) {
    const { data: flagRows, error: flagErr } = await sb
      .from('so_settings').select('key, enabled')
      .in('key', ['pos_remark_extra_auto_sku']);
    if (flagErr) {
      await rollbackPwpClaims();
      return c.json({ error: 'lookup_failed', reason: flagErr.message }, 500);
    }
    const flags = new Map((flagRows ?? []).map((r) => [(r as { key: string }).key, (r as { enabled: boolean }).enabled]));
    autoSkuEnabled = flags.get('pos_remark_extra_auto_sku') === true; // missing row → OFF
  }

  /* Subrequest diet (Loo 2026-06-06) — prefetch every line's fabric rows in
     TWO `in()` queries (was 2 × lines), and memoize the per-(base_model,
     depth) sofa module-price load so N lines of the same Model cost one
     query instead of N. */
  const fabricRowByCode = await loadFabricsByCodes(
    sb, items.map((it) => (it.variants as { fabricCode?: string } | null)?.fabricCode ?? null));
  const sellingTiersByFabricId = await loadFabricSellingTiersByIds(
    sb, items.map((it) => (it.variants as { fabricId?: string } | null)?.fabricId ?? null));
  const sofaModulePricesMemo = new Map<string, Promise<Record<string, number> | null>>();
  // Audit 2026-06-11 C2 — module COST rows, memoized per base_model (the
  // per-line seat size + fabric tier resolution happens inside the recompute).
  const sofaModuleCostRowsMemo = new Map<string, Promise<SofaModuleCostRowLite[] | null>>();
  const recomputes: Array<RecomputedLine | null> = await Promise.all(items.map(async (it, idx) => {
    const itemCode = String(it.itemCode ?? '');
    if (!itemCode) return null;
    const product = lineProducts[idx] ?? null;
    const fabricCode = ((it.variants as { fabricCode?: string } | null)?.fabricCode ?? '').trim();
    const fabricId = ((it.variants as { fabricId?: string } | null)?.fabricId ?? '').trim();
    const fabric = fabricCode ? (fabricRowByCode.get(fabricCode) ?? null) : null;
    const sellingTiers = fabricId ? (sellingTiersByFabricId.get(fabricId) ?? null) : null;
    // SOFA-SELLING-PLAN — a sofa's per-module SELLING prices are its Model's
    // module-SKU sell_price_sen; load them so the drift gate reprices the build
    // from the same source the POS used. Non-sofa lines skip it.
    let sofaModulePrices: Record<string, number> | null = null;
    let sofaModuleCostRows: SofaModuleCostRowLite[] | null = null;
    if (product?.category === 'SOFA') {
      const depth = String((it.variants as { depth?: unknown } | null)?.depth ?? '24');
      const memoKey = `${product.base_model ?? ''}|${depth}`;
      let pending = sofaModulePricesMemo.get(memoKey);
      if (!pending) {
        pending = loadModelSofaModulePrices(sb, product.base_model, depth);
        sofaModulePricesMemo.set(memoKey, pending);
      }
      // C2 — COST rows ride the same diet: one load per base_model.
      const costKey = product.base_model ?? '';
      let pendingCost = sofaModuleCostRowsMemo.get(costKey);
      if (!pendingCost) {
        pendingCost = loadModelSofaModuleCostRows(sb, product.base_model);
        sofaModuleCostRowsMemo.set(costKey, pendingCost);
      }
      [sofaModulePrices, sofaModuleCostRows] = await Promise.all([pending, pendingCost]);
    }
    sofaModulePricesByIdx.set(idx, sofaModulePrices);
    const draft: MfgItemForRecompute = {
      itemCode,
      itemGroup:      String(it.itemGroup ?? 'others'),
      qty:            Number(it.qty ?? 1),
      unitPriceCenti: Number(it.unitPriceCenti ?? 0),
      variants:       (it.variants as MfgItemForRecompute['variants']) ?? null,
    };
    // PWP grant for this line when its code was claimed: a per-SKU base (non-
    // sofa) or the reward combo ids (sofa). Else null → normal base / price.
    // Default Free Gift (migration 0170) — a validated gift line falls back to a
    // 0 base on the SAME pwpBaseSen path (0 ⇒ free), so no recompute signature
    // change. PWP always wins if both somehow apply (a gift is non-sofa, no code).
    const pwpBaseSen = pwpBaseByIdx.get(idx) ?? freeGiftBaseByIdx.get(idx) ?? null;
    const pwpSofaComboIds = pwpSofaByIdx.get(idx) ?? null;
    return recomputeFromSnapshot(draft, product, fabric, cachedConfig, cachedCombos, sofaModulePrices, sellingTiers, cachedFabricAddonConfig, pwpBaseSen, pwpSofaComboIds, cachedSpecialAddons, sofaModuleCostRows, cachedModelOverrides, cachedCompartmentOverrides);
  }));
  /* Commander 2026-05-29 (system-wide) — the SELLING unit price is now
     operator-authored on every SO line. The product price tables are COST,
     so there is no server-computed selling figure to enforce a combo floor /
     ceiling against. The former combo selling-price override (which replaced
     the line's selling price with a cheaper whole-build combo total, or
     clamped/rejected an out-of-band client price) is therefore retired — it
     would clobber or reject the operator's manual selling price. The COST
     path (computeMfgLineCost → unit_cost_centi / line_cost_centi /
     line_margin_centi) is untouched; combos never fed it.

     Combos DO feed the COST side now (Commander 2026-05-29): recomputeTotals
     applies the master sofa-combo price to a matched sofa set's cost. They are
     still NOT applied to the operator's manual SELLING price here.
     `extractSofaComboLookupArgs` is retained for the POS handover path. */
  void extractSofaComboLookupArgs;

  /* Pricing trust boundary (Owner 2026-05-31, see isPosTabletCaller). Only the
     untrusted POS tablet roles are drift-rejected; a Backend / office author
     sets the selling price freely (the owner ruled it varies per order). */
  const posTablet = await isPosTabletCaller(sb, user.id);
  if (posTablet) {
    for (let i = 0; i < recomputes.length; i++) {
      const r = recomputes[i];
      if (r && r.drift && !freeItemByIdx.has(i)) {
        await rollbackPwpClaims();  // don't burn a voucher on a rejected order
        return c.json({
          error:    'pricing_drift',
          reason:   'Client unitPriceCenti differs >0.5% from server compute.',
          lineIdx:  i,
          itemCode: r.itemCode,
          client:   Number(items[i]?.unitPriceCenti ?? 0),
          server:   r.unit_price_sen,
          breakdown: r.breakdown,
        }, 400);
      }
    }
  }
  /* Audit 2026-06-11 C-2 — discountCenti is client-authored and was NOT covered
     by the drift gate: a tampered POS could submit the correct catalog unit
     price (passing drift) then zero the line out with an arbitrary discount —
     or inflate the total with a negative one. Reject any discount outside
     [0, qty × unit] on every line (422, reject-don't-normalize). */
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it) continue;
    const r = recomputes[i];
    const qtyI = Number(it.qty ?? 1);
    const unitI = freeItemByIdx.has(i) ? 0 : (r ? r.unit_price_sen : Number(it.unitPriceCenti ?? 0));
    const discI = Number(it.discountCenti ?? 0);
    if (!Number.isFinite(discI) || discI < 0 || discI > qtyI * unitI) {
      await rollbackPwpClaims();  // don't burn a voucher on a rejected order
      return c.json({
        error:    'invalid_discount',
        reason:   'discountCenti must be between 0 and qty × unit price.',
        lineIdx:  i,
        itemCode: String(it.itemCode ?? ''),
        discount: discI,
        max:      qtyI * unitI,
      }, 422);
    }
  }
  /* Commander 2026-05-31 — per-line ship-from warehouse default. MRP +
     auto-allocation run strictly per-warehouse; each line gets the SO state's
     warehouse by default, editable per line via it.warehouseId. */
  const defaultWarehouseId = await deriveWarehouseIdFromState(
    sb,
    (body.customerState as string | null | undefined) ?? null,
  );

  /* Task 5 — one-shot SKU mint accumulator. When pos_remark_extra_auto_sku is
     ON and a line declares an extra add-on charge, we collect a mint request per
     affected SO line (one per sofa module; one for non-sofa) here, then resolve
     collision-free codes + insert the inactive mfg_products rows after the build
     pass. The line rows are mutated in place to point at the minted codes. */
  const oneShotReqs: OneShotMintReq[] = [];
  /* PWP trigger re-stamp source (Loo 2026-06-12, SO-2606-008) — the first
     BOOKED row per POS cart line. A sofa build's payload itemCode is the POS
     ANCHOR SKU (the catalog card's mfg row), which the per-module split never
     books onto the document — so the re-stamp below must read the lead MODULE
     row instead of the raw payload. Row OBJECT references on purpose: the
     one-shot mint pass rewrites item_code in place, and the reference keeps
     the map pointing at the final booked SKU. */
  const pwpLeadRowByCartKey = new Map<string, { item_code?: unknown }>();
  const extraRMof = (it: { variants?: unknown }) =>
    Math.max(0, Math.round(Number((it.variants as { extraAddonAmountRM?: unknown } | null)?.extraAddonAmountRM ?? 0)));
  const remarkTextOf = (it: { variants?: unknown }) => {
    const r = (it.variants as { remark?: unknown } | null)?.remark;
    return typeof r === 'string' ? r.trim() : '';
  };
  const catOf = (g: string): 'SOFA' | 'BEDFRAME' | 'MATTRESS' | 'ACCESSORY' =>
    g.includes('sofa') ? 'SOFA' : g.includes('bedframe') ? 'BEDFRAME' : g.includes('mattress') ? 'MATTRESS' : 'ACCESSORY';

  /* Task #114 — snapshot unit cost from mfg_products when client didn't.
     Build itemRows sequentially with Promise.all so the cost lookup runs
     in parallel across lines but each row still has its own awaited cost. */
  const itemRows = await Promise.all(items.map(async (it, idx) => {
    const qty = Number(it.qty ?? 1);
    const recomputed = recomputes[idx] ?? null;
    /* The server-computed selling price (the bound price-list figure) is always
       persisted — the Backend is costing-only and sends no real selling price,
       so we carry the catalog price out instead of the client's junk value.
       POS-tablet drift is rejected above; Backend drift is accepted silently. */
    // Free Item Campaign (mig 0176): a validated free-item line is forced to 0
    // (server-validated above), which zeroes the non-sofa row AND, via
    // buildUnitPriceSen below, every sofa module row of the build.
    const unit = freeItemByIdx.has(idx)
      ? 0
      : (recomputed ? recomputed.unit_price_sen : Number(it.unitPriceCenti ?? 0));
    const discount = Number(it.discountCenti ?? 0);
    const lineTotal = (qty * unit) - discount;
    // Commander 2026-05-28 — the server-computed cost (base + Σ backend
    // priceSen surcharges via computeMfgLineCost) is the source of truth.
    // Fall back to mfg_products.cost_price_sen / explicit client cost only
    // when the recompute didn't produce a cost (e.g. product not found).
    const itemCode = String(it.itemCode ?? '');
    const unitCost = recomputed && recomputed.unit_cost_sen > 0
      ? recomputed.unit_cost_sen
      : await snapshotUnitCostSen(sb, itemCode, Number(it.unitCostCenti ?? 0));
    const lineCost = unitCost * qty;
    const group = String(it.itemGroup ?? '').toLowerCase();
    total += lineTotal;
    totalCost += lineCost;
    if (group.includes('mattress') || group.includes('sofa')) {
      mattressSofa += lineTotal;
      mattressSofaCost += lineCost;
    } else if (group.includes('bedframe')) {
      bedframe += lineTotal;
      bedframeCost += lineCost;
    } else if (group.includes('accessor')) {
      accessories += lineTotal;
      accessoriesCost += lineCost;
    } else {
      others += lineTotal;
      othersCost += lineCost;
    }
    /* Task 5 — the per-line declared extra add-on (whole RM), only honoured when
       the auto-SKU flag is ON. Drives whether this line mints a one-shot SKU. */
    const extraRM = autoSkuEnabled ? extraRMof(it) : 0;
    /* PR-E — Per-line cascade defaults. If the client sent a
       lineDeliveryDate it wins (and overridden=true unless explicitly
       false). Otherwise inherit the header date with overridden=false. */
    const hasExplicitLineDate = it.lineDeliveryDate !== undefined && it.lineDeliveryDate !== null;
    const lineDeliveryDate = hasExplicitLineDate
      ? (it.lineDeliveryDate as string | null)
      : headerDeliveryDate;
    const lineDeliveryDateOverridden = hasExplicitLineDate
      ? (it.lineDeliveryDateOverridden === undefined ? true : Boolean(it.lineDeliveryDateOverridden))
      : Boolean(it.lineDeliveryDateOverridden ?? false);
    const baseRow = {
      line_date: (it.lineDate as string) ?? todayMyt(),
      debtor_code: (body.debtorCode as string) ?? null,
      debtor_name: body.debtorName,
      agent: (body.agent as string) ?? null,
      item_group: it.itemGroup ?? 'others',
      item_code: it.itemCode,
      description: (it.description as string) ?? null,
      /* Commander 2026-05-28 — "Description 2" is the auto-combined variant
         summary (the long attribute string). Server-generated from the line's
         variants so it stays the single source of truth. */
      description2: buildVariantSummary(String(it.itemGroup ?? ''), (it.variants as Record<string, unknown> | null) ?? null) || null,
      /* Spec 2026-06-06 — per-line operator remark from the POS product page.
         Same column SoLineCard edits (mfg_sales_order_items.remark). */
      remark: (() => {
        const r = (it.variants as { remark?: unknown } | null)?.remark;
        return typeof r === 'string' && r.trim() !== '' ? r.trim() : null;
      })(),
      uom: (it.uom as string) ?? 'UNIT',
      qty,
      unit_price_centi: unit,
      discount_centi: discount,
      total_centi: lineTotal,
      total_inc_centi: lineTotal,
      balance_centi: lineTotal,
      /* Variants-vocabulary unification (port of 2990 73aeeb1e) — canonicalize
         at the LAST step before the DB write. Every depth-keyed read
         (recompute, split, fabricCode/fabricId loads) above ran on the raw
         `it.variants`, so a POS-created sofa line ends up stored with the
         canonical Backend keys (seatHeight/legHeight/fabricCode) and the read
         seams in DO/SI/PO/GRN/PI/PR editors never render blank dropdowns. */
      variants: canonicalizeVariants(String(it.itemGroup ?? ''), (it.variants as Record<string, unknown> | null) ?? null),
      unit_cost_centi: unitCost,
      line_cost_centi: lineCost,
      line_margin_centi: lineTotal - lineCost,
      // MFG-PRICING-ENGINE — Persist the line-level breakdown columns from
      // the server recompute so the SO detail page + cost reports show the
      // canonical surcharge mix without re-deriving from the variants blob.
      divan_price_sen:         recomputed?.divan_price_sen ?? 0,
      leg_price_sen:           recomputed?.leg_price_sen ?? 0,
      special_order_price_sen: recomputed?.special_order_sen ?? 0,
      custom_specials:         recomputed?.custom_specials ?? null,
      line_delivery_date: lineDeliveryDate,
      line_delivery_date_overridden: lineDeliveryDateOverridden,
      // Commander 2026-05-31 — per-line ship-from warehouse (migration 0118).
      // Explicit per-line override wins; else the SO state's default.
      warehouse_id: (it.warehouseId as string | null | undefined) ?? defaultWarehouseId,
      /* SO-SKU spec P5 (§4.5) — per-line snapshots so the Detail Listing's
         Branding / Venue columns light without joins: branding from the SKU's
         catalog row (mainly MATTRESS brands — already loaded, zero extra
         queries), venue from the resolved header name (mirrors the add-line
         path, which snapshots header.venue/branding). */
      branding: lineProducts[idx]?.branding ?? null,
      venue: resolvedVenueName,
      /* SO-SKU spec P2 — explicit (= the column default). Service rows appended
         below start READY; PostgREST bulk inserts null-fill missing keys
         instead of applying column defaults, so every row spells it out. */
      stock_status: 'PENDING',
    };

    /* ── SO-SKU spec P3 (§4.3 + D3) — a POS sofa BUILD becomes one SO line per
       compartment module SKU (the Backend hand-opened SO-2606-018 shape). The
       money is settled ABOVE this point: `unit` is the authoritative per-build
       selling price (combo / PWP / fabric-tier folded in by the recompute, the
       drift gate already passed on it). Splitting only decomposes it — each
       line gets its module-sell-price share, residue on the last line, so
       Σ line totals === build total exactly. Shared variants ride every line
       (the per-line variant-rule gate keeps passing); the cells array is
       replaced by per-line buildKey/cellIndex/x/y/rot so DO picking, returns
       and previews can regroup the set. Breakdown columns + custom_specials
       stay on the FIRST line only — they are build-level report figures and
       duplicating them ×N would double-display in SO Details. Non-splittable
       payloads (no cells / unknown base model) keep the legacy single line. */
    if (group === 'sofa') {
      const product = lineProducts[idx] ?? null;
      const modulePrices = sofaModulePricesByIdx.get(idx) ?? null;
      if (!modulePrices && product?.base_model) {
        // Catalog gap — split degrades to an equal-price split. Surface it so
        // ops can fix the Model's module SKU prices instead of silently
        // booking approximate per-line figures (Σ stays exact regardless).
        // eslint-disable-next-line no-console
        console.warn(`[so-create] no module prices for ${product.base_model} — sofa split uses equal weights`);
      }
      const split = splitSofaBuildIntoModuleLines({
        baseModel: product?.base_model ?? null,
        cells: (it.variants as { cells?: unknown } | null)?.cells,
        buildUnitPriceSen: unit,
        buildUnitCostSen: unitCost,
        modulePrices,
        // Task 5 (D4) — when this line mints one-shot SKUs (extra charge), the
        // selling price is split EVENLY across modules; cost stays proportional.
        evenSplitPrice: extraRM > 0,
        // Left-to-right walk (Loo 2026-06-12) sizes footprints at the build's
        // real seat depth so adjacency matches the canvas the cells came from.
        depth: String((it.variants as { depth?: unknown } | null)?.depth ?? '24'),
      });
      if (split && split.length > 0) {
        const buildKey = `build-${idx + 1}`;
        /* Variants-vocabulary unification (port of 2990 73aeeb1e) —
           canonicalize BEFORE deriving the split's shared variants so every
           module row stores seatHeight/legHeight/fabricCode. Safe: the split's
           own depth read above ran on the raw `it.variants`, so dropping the
           `depth` alias here does NOT change the geometry. */
        const { cells: _cells, ...sharedVariants } =
          canonicalizeVariants('sofa', (it.variants as Record<string, unknown> | null) ?? {});
        const moduleRows = split.map((s, i) => {
          const moduleVariants: Record<string, unknown> = {
            ...sharedVariants,
            buildKey,
            cellIndex: s.cellIndex,
            x: s.x,
            y: s.y,
            rot: s.rot,
          };
          const moduleLineTotal = (qty * s.unitPriceSen) - (i === 0 ? discount : 0);
          const moduleLineCost = qty * s.unitCostSen;
          const row = {
            ...baseRow,
            item_code: s.itemCode,
            description: s.description,
            description2: buildVariantSummary('sofa', moduleVariants) || null,
            unit_price_centi: s.unitPriceSen,
            discount_centi: i === 0 ? discount : 0,
            total_centi: moduleLineTotal,
            total_inc_centi: moduleLineTotal,
            balance_centi: moduleLineTotal,
            variants: moduleVariants,
            unit_cost_centi: s.unitCostSen,
            line_cost_centi: moduleLineCost,
            line_margin_centi: moduleLineTotal - moduleLineCost,
            divan_price_sen:         i === 0 ? (recomputed?.divan_price_sen ?? 0) : 0,
            leg_price_sen:           i === 0 ? (recomputed?.leg_price_sen ?? 0) : 0,
            special_order_price_sen: i === 0 ? (recomputed?.special_order_sen ?? 0) : 0,
            /* Loo 2026-06-13 — custom_specials is the DISPLAY composition of the
               line's specials (incl. the POS special add-on note), NOT a money
               figure: the money lives in unit_price_centi (split across modules)
               + the i===0 breakdown columns above. So, like the remark below, it
               rides EVERY module line of a split sofa — each row of the internal
               Detail Listing then shows the same specials, matching the per-module
               SoLineCard editor and the every-line description2. The customer
               print folds the build into one line and never reads custom_specials,
               so this can't double on the invoice. */
            custom_specials:         recomputed?.custom_specials ?? null,
            /* Loo 2026-06-09 — the operator remark rides EVERY compartment line
               of the sofa, not just the first. One sofa = one remark, so each
               piece (and its printed SO line) carries the same note. Unlike the
               i===0 breakdown columns above, the remark is not a build-level money
               figure, so duplicating it across the set is not double-counting. */
            remark: baseRow.remark,
          };
          /* Task 5 — mint a one-shot SKU per module when an extra charge was
             declared. The minted sell price = this module's catalog base + its
             EVEN share of the extra (N = module count); the SO line is rewritten
             to point at the minted code by buildOneShotMints later. */
          if (extraRM > 0 && product?.base_model) {
            const remarkText = remarkTextOf(it);
            const n = split.length;
            const baseSell = modulePrices?.[s.moduleCode] ?? 0;
            const brand = (product as { branding?: string | null }).branding ?? null;
            oneShotReqs.push({
              row,
              category: 'SOFA',
              modelCode: product.base_model,
              baseSkuCode: s.itemCode,
              baseName: (brand ? `${String(brand).toUpperCase()} ` : '') + s.description,
              modelId: (product as { model_id?: string | null }).model_id ?? null,
              branding: brand,
              compartment: s.moduleCode,
              remarkText,
              sellPriceSen: baseSell + Math.round((extraRM * 100) / n),
            });
          }
          return row;
        });
        {
          const pwpKey = String((it as { cartLineKey?: string }).cartLineKey ?? '');
          if (pwpKey && moduleRows[0] && !pwpLeadRowByCartKey.has(pwpKey)) {
            pwpLeadRowByCartKey.set(pwpKey, moduleRows[0]);
          }
        }
        return moduleRows;
      }
    }
    /* Task 5 — non-sofa (or non-splittable) line: mint a single one-shot SKU
       when an extra charge was declared. unit_price_centi already carries the
       D9 list price (base + extra, N=1) from the recompute, so reuse it as the
       minted SKU's sell price. */
    if (extraRM > 0 && lineProducts[idx]) {
      const product = lineProducts[idx]!;
      oneShotReqs.push({
        row: baseRow,
        category: catOf(group),
        modelCode: (product as { base_model?: string | null }).base_model ?? '',
        baseSkuCode: String((product as { code?: string }).code ?? baseRow.item_code),
        baseName: String((product as { name?: string }).name ?? baseRow.description ?? baseRow.item_code),
        modelId: (product as { model_id?: string | null }).model_id ?? null,
        branding: (product as { branding?: string | null }).branding ?? null,
        compartment: '',
        remarkText: remarkTextOf(it),
        sellPriceSen: Number(baseRow.unit_price_centi ?? 0), // base + extra (N=1)
      });
    }
    {
      const pwpKey = String((it as { cartLineKey?: string }).cartLineKey ?? '');
      if (pwpKey && !pwpLeadRowByCartKey.has(pwpKey)) pwpLeadRowByCartKey.set(pwpKey, baseRow);
    }
    return [baseRow];
  })).then((rows) =>
    /* Priority lines (Loo 2026-06-12): persist mains (sofa/mattress/bedframe)
       ahead of accessories/others. Stable, so the cart order survives within a
       rank and a split build's module rows stay contiguous (same item_group).
       SERVICE rows are pushed after this array and stay last either way. */
    sortSoLinesByGroupRank(rows.flat(), (r) => r.item_group as string | null | undefined));

  const margin = total - totalCost;
  const marginPctBasis = total > 0 ? Math.round((margin / total) * 10000) : 0;

  /* ── Delivery fee (migration 0133) — POS handover path only ──────────────
     Activates the dormant delivery fee on the LIVE SO. Gated on the explicit
     applyDeliveryFee flag the POS handover sends, so backend-authored SOs are
     untouched (delivery_fee_centi stays 0). Fully server-recomputed via the
     pure computeSoDeliveryFee — the only client value trusted is the free-form
     additionalDeliveryFee (clamped >= 0). Categories are the cart's distinct
     DELIVERABLE item_groups (sofa/mattress/bedframe); accessories/others don't
     trip cross-category. delivery_fee_config is whole-MYR, the SO ledger is
     sen, so the config is scaled ×100 before the pure call. The result folds
     into the grand totals + margin like the fabric-tier add-on; the per-
     category revenue buckets stay goods-only. (Phase 1 special-model fees +
     Phase 2 cross-order follow-up plug into the same call.) */
  let deliveryFeeCenti = 0;
  let deliveryFee: SoDeliveryFeeResult | null = null;
  let crossCategorySourceDocNo: string | null = null;
  if (body.applyDeliveryFee) {
    const { data: dcfg } = await sb
      .from('delivery_fee_config')
      .select('base_fee, cross_category_fee')
      .eq('id', 1)
      .single();
    const DELIVERABLE = new Set(['sofa', 'mattress', 'bedframe']);
    const categoryIds = items
      .map((it) => String((it as { itemGroup?: string }).itemGroup ?? '').toLowerCase())
      .filter((g) => DELIVERABLE.has(g));
    const additionalSen = Math.max(0, Math.round(Number(body.additionalDeliveryFee ?? 0) * 100));
    // delivery_fee_config + special fees are whole-MYR; the SO ledger is sen → ×100.
    const cfgSen = {
      baseFee:          Number((dcfg as { base_fee?: number } | null)?.base_fee ?? 0) * 100,
      crossCategoryFee: Number((dcfg as { cross_category_fee?: number } | null)?.cross_category_fee ?? 0) * 100,
    };

    /* Phase 1 — special delivery fee rules (migration 0024). Generalises the old
       model-only model_special_delivery_fees lookup onto the #691 RuleTarget
       abstraction: any cart line a rule's target covers (model | variant |
       compartment | combo) contributes a special fee; computeSoDeliveryFee folds
       in the highest standalone (overriding base) + the cross-followup. Lines are
       flattened to RuleLineInput[] and matched by the SAME shared matcher the POS
       runs — no drift. Free-item lines are skipped (a free giveaway carries no
       special transport fee). */
    const comboModulesById = new Map<string, string[][]>(
      cachedCombos.map((cb) => [cb.id, cb.modules]),
    );
    const deliveryRuleLines: RuleLineInput[] = [];
    for (let idx = 0; idx < items.length; idx++) {
      if (freeItemByIdx.has(idx)) continue;
      const product = lineProducts[idx] ?? null;
      if (!product) continue;
      const variants = (items[idx]?.variants as Record<string, unknown> | null) ?? null;
      const cells = (variants?.cells as Array<{ moduleId?: unknown }> | undefined) ?? [];
      const built = Array.isArray(cells)
        ? cells.map((cl) => String(cl?.moduleId ?? '')).filter(Boolean)
        : [];
      deliveryRuleLines.push({
        category: String((product as { category?: string | null }).category ?? ''),
        modelId: (product as { model_id?: string | null }).model_id ?? null,
        sizeCode: (product as { size_code?: string | null }).size_code
          ? String((product as { size_code?: string | null }).size_code).toUpperCase()
          : null,
        builtCompartments: built,
      });
    }
    const specialModels = await specialDeliveryFeesForLines(sb, deliveryRuleLines, comboModulesById);

    /* Phase 2 — cross-order link. Sales typed the earlier SO's doc_no at
       handover. Validate it (exists, not cancelled, same customer by phone
       when both have one, not already used), then this SO charges only the
       reduced cross / special-cross rate. A 400 here rolls back any PWP claim
       so a voucher isn't burned on a rejected order. The unique index on
       cross_category_source_doc_no is the hard anti-double-dip backstop. */
    let isCrossCategoryFollowup = false;
    const rawLink = String((body.crossCategorySourceDocNo as string | undefined) ?? '').trim();
    if (rawLink) {
      const elig = await checkCrossCategorySource(
        sb, rawLink, typeof body.phone === 'string' ? body.phone : null, orderCustomerId,
      );
      if (!elig.eligible) {
        await rollbackPwpClaims();  // don't burn a voucher on a rejected order
        return c.json({ error: 'cross_category_link_invalid', reason: crossCatReasonText(rawLink, elig.reason) }, 400);
      }
      crossCategorySourceDocNo = rawLink;
      isCrossCategoryFollowup = true;
    }

    deliveryFee = computeSoDeliveryFee(
      { categoryIds, specialModels, isCrossCategoryFollowup, additionalFee: additionalSen },
      cfgSen,
    );
    deliveryFeeCenti = deliveryFee.total;
  }

  /* ── SO-SKU spec P2 (§4.1 + §4.2, D2/D6/D9 final) — every charge is a SKU
     line. The delivery fee just computed decomposes into SVC-DELIVERY* lines
     (Σ lines === deliveryFeeCenti always); POS handover add-ons (dispose /
     lift) are re-priced server-side from the addons table — the client's
     amounts are never trusted — and become SVC-DISPOSE-* / SVC-LIFT-CARRY
     lines. The header delivery_fee_centi keeps being written (dual-write
     transition; recomputeTotals only folds it back in when NO fee lines
     exist, so nothing double-counts). Lines ride the whole SO→DO→SI chain;
     they are not goods — P1 guards keep them out of allocation / inventory /
     MRP / returns, and stock_status starts READY so the stock remark never
     shows a phantom PENDING service. */
  const feeServiceSpecs = deliveryFee
    ? buildDeliveryFeeServiceLines(deliveryFee, crossCategorySourceDocNo)
    : [];
  let addonServiceSpecs: ServiceLineSpec[] = [];
  const addonSelections: AddonSelectionInput[] = Array.isArray(body.addons)
    ? (body.addons as Array<Record<string, unknown>>)
        .filter((a) => a && typeof a.id === 'string' && (a.id as string).trim())
        .map((a) => ({
          id:          (a.id as string).trim(),
          qty:         typeof a.qty === 'number' ? a.qty : undefined,
          floorsCount: typeof a.floorsCount === 'number' ? a.floorsCount : undefined,
          itemsCount:  typeof a.itemsCount === 'number' ? a.itemsCount : undefined,
        }))
    : [];
  if (addonSelections.length > 0) {
    const { data: addonRows } = await sb
      .from('addons')
      .select('id, kind, price, per_floor_item, label, enabled, service_sku')
      .in('id', [...new Set(addonSelections.map((a) => a.id))]);
    addonServiceSpecs = computeAddonServiceLines(
      addonSelections,
      ((addonRows ?? []) as Array<{ id: string; kind: string; price: number; per_floor_item: number | null; label: string | null; enabled: boolean | null; service_sku: string | null }>)
        .map((r) => ({ id: r.id, kind: r.kind, price: Number(r.price ?? 0), perFloorItem: r.per_floor_item, label: r.label, enabled: r.enabled, serviceSku: r.service_sku })),
    );
  }
  const serviceSpecs = [...feeServiceSpecs, ...addonServiceSpecs];
  const serviceCenti = serviceSpecs.reduce((s, l) => s + l.totalSen, 0);
  if (serviceSpecs.length > 0) {
    /* Same Edge #4 contract as goods lines: a SERVICE line's SKU must exist in
       the catalog (seeded by migration 0155). A 409 here means the seed is
       missing — fail loudly rather than booking an off-catalog charge. */
    const svcCheck = await validateItemCodes(sb, serviceSpecs.map((s) => s.itemCode));
    if (!svcCheck.ok) {
      await rollbackPwpClaims();
      return c.json(unknownItemCodeResponse(svcCheck.unknown), 409);
    }
    const lineDateToday = todayMyt();
    for (const spec of serviceSpecs) {
      itemRows.push({
        line_date: lineDateToday,
        debtor_code: (body.debtorCode as string) ?? null,
        debtor_name: customerName,
        agent: (body.agent as string) ?? null,
        item_group: 'service',
        item_code: spec.itemCode,
        description: spec.description,
        description2: null,
        /* Loo 2026-06-10 — the order-specific detail (cross-order source SO,
           lift floors×items math) rides in remark; description stays the
           stable SKU wording so the line reads as the catalog service. */
        remark: spec.remark ?? null,
        uom: 'UNIT',
        qty: spec.qty,
        unit_price_centi: spec.unitPriceSen,
        discount_centi: 0,
        total_centi: spec.totalSen,
        total_inc_centi: spec.totalSen,
        balance_centi: spec.totalSen,
        variants: null,
        unit_cost_centi: 0,
        line_cost_centi: 0,
        line_margin_centi: spec.totalSen,
        divan_price_sen: 0,
        leg_price_sen: 0,
        special_order_price_sen: 0,
        custom_specials: null,
        line_delivery_date: headerDeliveryDate,
        line_delivery_date_overridden: false,
        // Services don't ship from a warehouse; NULL keeps them out of every
        // per-warehouse pool (allocation skips them anyway, P1).
        warehouse_id: null,
        /* P5 — key parity with the goods rows (PostgREST null-fills missing
           keys). Services carry no brand; venue mirrors the header. */
        branding: null,
        venue: resolvedVenueName,
        // Not goods — nothing to allocate; READY from birth (spec §4.6).
        stock_status: 'READY',
        /* Variants-vocabulary unification (port of 2990 73aeeb1e) — goods rows
           above now type `variants` as the non-null canonicalizeVariants
           result, so a SERVICE row's null variants needs `unknown` widening. */
      } as unknown as (typeof itemRows)[number]);
    }
  }

  const grandTotal          = total + serviceCenti;
  /* Service lines carry zero cost, so the whole serviceCenti is margin —
     same treatment the header-only delivery fee got before. */
  const grandMargin         = margin + serviceCenti;
  const grandMarginPctBasis = grandTotal > 0 ? Math.round((grandMargin / grandTotal) * 10000) : 0;

  /* SO-SKU spec P3 — Edge #4 for the ASSEMBLED rows. The payload-level gate
     at the top validated what the client sent; the split just minted module
     SKUs (ANNSA-1A(RHF) …) that must ALSO exist in the catalog. A 409 here
     means the Model's module SKU is missing from the SKU Master — fail loudly
     BEFORE the header insert so a rejected order leaves nothing behind. */
  {
    const rowCodes = itemRows.map((r) => (r as { item_code?: string | null }).item_code);
    const rowCheck = await validateItemCodes(sb, rowCodes);
    if (!rowCheck.ok) {
      await rollbackPwpClaims();
      return c.json(unknownItemCodeResponse(rowCheck.unknown), 409);
    }
  }

  /* Task #121 — derive country from the picked customer_state via the
     localities lookup. Stays null when the state is unknown so we don't
     forge a country the locality table never declared. */
  const customerCountrySnapshot = await deriveCountryFromState(
    sb,
    (body.customerState as string | null | undefined) ?? null,
  );

  /* Commander 2026-05-29 — Location follows the address (State). When the
     caller already sent a salesLocation it wins; otherwise derive it from the
     State so API/import callers get the same warehouse binding the form gives.
     Stays null when the State is unmapped. */
  const derivedSalesLocation =
    (body.salesLocation as string | null | undefined) ??
    (await deriveSalesLocationFromState(
      sb,
      (body.customerState as string | null | undefined) ?? null,
    ));

  /* P1 (Owner 2026-06-03, migration 0143) — resolve the POS handover payment
     slip. The POS uploads the slip to R2 first (via /slips/init + confirm) and
     sends us the uploadSessionId; we look up its committed R2 key and attach it
     to the SO so the coordinator can see the payment proof. Best-effort: a
     missing / un-uploaded session just leaves the SO slip-less (slip_state stays
     'none') rather than blocking the order. */
  let slipKey: string | null = null;
  const uploadSessionId = (body.uploadSessionId as string | null | undefined) ?? null;
  if (uploadSessionId) {
    const { data: slipRow } = await sb
      .from('pending_slip_uploads')
      .select('r2_key, status')
      .eq('upload_session_id', uploadSessionId)
      .maybeSingle();
    const sr = slipRow as { r2_key?: string; status?: string } | null;
    if (sr?.r2_key && (sr.status === 'uploaded' || sr.status === 'promoted')) {
      slipKey = sr.r2_key;
    }
  }

  /* ── POS split payment (Loo 2026-06-06) — optional `payments[]` on create.
     A handover deposit can now arrive as SEVERAL transactions (e.g. half
     cash + half card). Validated STRICTLY (unlike the tolerant single-deposit
     fallback below, a money row must never be silently dropped) and booked
     atomically with the order: deposit_centi on the header = Σ rows, each row
     lands in mfg_sales_order_payments as an is_deposit row. Absent payments[]
     → the legacy single depositCenti/paymentMethod path runs unchanged, so
     old PWA clients keep working. */
  let posPayments: Array<{
    method: 'merchant' | 'transfer' | 'cash' | 'installment';
    amountCenti: number;
    approvalCode?: string | null;
    merchantProvider?: string | null;
    installmentMonths?: number | null;
    uploadSessionId: string;
  }> | null = null;
  if (body.payments !== undefined) {
    const parsed = z.array(z.object({
      method:            z.enum(['merchant', 'transfer', 'cash', 'installment']),
      amountCenti:       z.number().int().positive(),
      approvalCode:      z.string().optional().nullable(),
      merchantProvider:  z.string().trim().min(1).optional().nullable(),
      installmentMonths: z.number().int().min(0).max(60).optional().nullable(),
      uploadSessionId:   z.string().min(1),        // spec D4 — one slip per payment
    })).min(1).max(10).safeParse(body.payments);
    if (!parsed.success) {
      await rollbackPwpClaims();
      return c.json({ error: 'invalid_payments', issues: parsed.error.issues }, 400);
    }
    posPayments = parsed.data;
  }
  const posPaymentsTotalCenti = posPayments
    ? posPayments.reduce((acc, p) => acc + p.amountCenti, 0)
    : null;

  /* Spec D4 — resolve each split payment's slip session → R2 key up front.
     All-or-nothing: any unresolved slip rejects the order BEFORE the header
     insert (and rolls back PWP claims), so no SO is created with half its
     payment proofs missing. Accepts 'uploaded' only — a promoted session
     belongs to an earlier payment (replay guard). */
  let posPaymentSlipKeys: string[] | null = null;
  if (posPayments) {
    const sessionIds = posPayments.map((p) => p.uploadSessionId);
    if (new Set(sessionIds).size !== sessionIds.length) {
      await rollbackPwpClaims();
      return c.json({ error: 'slip_required', reason: 'Each payment needs its own slip.' }, 400);
    }
    const { data: slipRows, error: slipRowsErr } = await sb
      .from('pending_slip_uploads')
      .select('upload_session_id, r2_key, status')
      .in('upload_session_id', sessionIds);
    if (slipRowsErr) {
      await rollbackPwpClaims();
      return c.json({ error: 'lookup_failed', reason: slipRowsErr.message }, 500);
    }
    const slipById = new Map((slipRows ?? []).map((r) => {
      const t = r as { upload_session_id: string; r2_key: string | null; status: string };
      return [t.upload_session_id, t] as const;
    }));
    posPaymentSlipKeys = [];
    for (let i = 0; i < sessionIds.length; i++) {
      const row = slipById.get(sessionIds[i]!);
      if (!row || row.status !== 'uploaded' || !row.r2_key) {
        await rollbackPwpClaims();
        return c.json({
          error: 'slip_required',
          reason: `Payment ${i + 1} slip missing or not uploaded.`,
        }, 400);
      }
      posPaymentSlipKeys.push(row.r2_key);
    }
  }

  /* POS auto-Proceed (Loo 2026-06-09) — if this handover already satisfies the
     same gate as the POS "Move to Proceed" button (customer name + email, a
     delivery address line 1 + postcode, a delivery date, and ≥50% collected),
     stamp proceeded_at now so the order skips Order Placed and lands directly in
     Proceed. A "Fill in later" handover (blank address) fails the gate and stays
     in Order Placed for the salesperson to complete + proceed manually. */
  const depositTotalCenti = posPaymentsTotalCenti
    ?? Math.max(0, typeof body.depositCenti === 'number' ? body.depositCenti : 0);
  const autoProceed = meetsProceedGate({
    hasCustomerName: !!customerName?.trim(),
    hasEmail: typeof body.email === 'string' && !!body.email.trim(),
    hasAddress: typeof body.address1 === 'string' && !!body.address1.trim(),
    hasPostcode: typeof body.postcode === 'string' && !!body.postcode.trim(),
    hasDeliveryDate: typeof body.customerDeliveryDate === 'string' && !!body.customerDeliveryDate.trim(),
    paid: depositTotalCenti,
    total: grandTotal,
  });

  const { error: hErr } = await sb.from('mfg_sales_orders').insert({
    doc_no: docNo,
    proceeded_at: autoProceed ? new Date().toISOString() : null,
    transfer_to: (body.transferTo as string) ?? null,
    so_date: (body.soDate as string) ?? todayMyt(),
    branding: (body.branding as string) ?? null,
    debtor_code: (body.debtorCode ?? body.customerCode as string) ?? null,
    debtor_name: customerName,
    agent: (body.agent as string) ?? null,
    sales_location: derivedSalesLocation ?? null,
    ref: (body.ref as string) ?? null,
    po_doc_no: (body.poDocNo as string) ?? null,
    /* SO-SKU spec P5 — the resolved venue NAME (explicit body.venue wins,
       else looked up from the stamped venue_id) so the column finally lights. */
    venue: resolvedVenueName,
    /* Migration 0086 — venue master FK (separate from legacy `venue` text).
       Guarded to a real uuid; project_venues integer ids are nulled (the venue
       TEXT carries the value). See the venueIdUuid guard above. */
    venue_id: venueIdUuid,
    address1: (body.address1 as string) ?? null,
    address2: (body.address2 as string) ?? null,
    address3: (body.address3 as string) ?? null,
    address4: (body.address4 as string) ?? null,
    /* Task #91 — defensively normalize to E.164 storage form. The UI does this
       on blur via <PhoneInput>, but a misbehaving client could still POST a
       raw "+60 12 345 6789" — normalize once on the server so the DB never
       holds a half-typed format. Falls back to the raw value if normalize
       returns null (e.g. non-MY international numbers we don't recognise). */
    phone: normPhone,
    mattress_sofa_centi: mattressSofa,
    bedframe_centi: bedframe,
    accessories_centi: accessories,
    others_centi: others,
    // Task #114 — per-category cost (migration 0079).
    mattress_sofa_cost_centi: mattressSofaCost,
    bedframe_cost_centi:      bedframeCost,
    accessories_cost_centi:   accessoriesCost,
    others_cost_centi:        othersCost,
    /* SO-SKU spec P2 (D1, migration 0155) — SERVICE bucket = fee + addon
       lines (cost 0). Keeps Finance's "Others" goods-only. */
    service_centi: serviceCenti,
    service_cost_centi: 0,
    local_total_centi: grandTotal,
    balance_centi: grandTotal,
    total_cost_centi: totalCost,
    total_revenue_centi: grandTotal,
    total_margin_centi: grandMargin,
    margin_pct_basis: grandMarginPctBasis,
    // Delivery fee snapshot (migration 0133) — DUAL-WRITE transition (P2):
    // still written for view/report back-compat, but recomputeTotals now folds
    // it in ONLY when no SVC-DELIVERY* lines exist (they are the new truth).
    delivery_fee_centi: deliveryFeeCenti,
    // Cross-category follow-up link (migration 0141) — null unless sales linked
    // this SO back to an earlier one for the reduced delivery rate.
    cross_category_source_doc_no: crossCategorySourceDocNo,
    // P3 — itemRows now carries split sofa module lines + SERVICE lines;
    // its length IS the line count (recomputeTotals re-derives it anyway).
    line_count: itemRows.length,
    currency: ((body.currency as string) ?? 'MYR').toUpperCase(),
    note: (body.note as string) ?? null,
    /* PR #46 — POS handover fields written at create */
    email: (body.email as string) ?? null,
    customer_type: (body.customerType as string) ?? null,
    salesperson_id: salespersonIdToStamp,
    city: (body.city as string) ?? null,
    postcode: (body.postcode as string) ?? null,
    building_type: (body.buildingType as string) ?? null,
    emergency_contact_name: (body.emergencyContactName as string) ?? null,
    /* Task #91 — also normalize the emergency contact phone. */
    emergency_contact_phone: typeof body.emergencyContactPhone === 'string'
      ? (normalizePhone(body.emergencyContactPhone) ?? body.emergencyContactPhone)
      : null,
    emergency_contact_relationship: (body.emergencyContactRelationship as string) ?? null,
    target_date: (body.targetDate as string) ?? null,
    customer_id: orderCustomerId,
    customer_state: (body.customerState as string) ?? null,
    /* Task #121 — country snapshot auto-derived above. */
    customer_country: customerCountrySnapshot,
    customer_delivery_date: (body.customerDeliveryDate as string) ?? null,
    /* PR #144 — Commander: "当我已经 create 好了这个 sales order 的时候，
       为什么我点进去 edit processing 的 delivery date 时，怎么没看到呢".
       internal_expected_dd was wired on PATCH (update header) but missed
       on the POST (create) — so the New SO form's Processing Date field
       never persisted; reopening the SO showed an empty field. */
    internal_expected_dd: (body.internalExpectedDd as string) ?? null,
    /* Mig 0053 (port of 2990 0199 + 0201) — amendment carriers. The customer's
       ORIGINAL `customer_delivery_date` above is NEVER overwritten by an
       amend; the customer's REQUESTED-changed date lands here, the date WE
       confirm goes to `amended_delivery_date`, and the free-text "why" goes to
       `amend_reason`. The effective date for Days Left / OVERDUE is
       amended_delivery_date ?? customer_delivery_date. Persisted on CREATE so
       an amend captured at SO entry (e.g. customer asked for a date change
       between quote + sign-off) doesn't get lost waiting for a follow-up PATCH. */
    amend_date_from_customer: (body.amendDateFromCustomer as string) ?? null,
    amended_delivery_date: (body.amendedDeliveryDate as string) ?? null,
    amend_reason: (body.amendReason as string) ?? null,
    // PR #121 — POS-aligned Order Details fields
    customer_so_no: (body.customerSoNo as string) ?? null,
    customer_po: (body.customerPo as string) ?? null,
    hub_id: (body.hubId as string) ?? null,
    hub_name: (body.hubName as string) ?? null,
    /* P1 (Owner 2026-06-03) — billing address from the POS handover, sent only
       when it differs from the delivery address. Single text column (already
       persisted on PATCH + shown on the SO detail page); just wire it on create
       so a POS order's separate billing address isn't lost. */
    bill_to_address: (body.billToAddress as string) ?? null,
    /* P1 (Owner 2026-06-03, migration 0142) — POS handover signature data URL. */
    signature_b64: (body.signatureB64 as string) ?? null,
    /* P1 (Owner 2026-06-03, migration 0143) — POS handover payment slip (R2 key
       resolved above). slip_state → 'pending' (coordinator to check) when a slip
       is attached; left at the column default 'none' otherwise. */
    slip_key: slipKey,
    slip_state: slipKey ? 'pending' : 'none',
    /* Original-slip provenance (migration 0033) — the R2 key of the handwritten
       slip photo this SO was scanned from, carried over from the Scan Order
       flow so the SO detail page can show it as "Original Slip" proof. null for
       manually-keyed orders. */
    slip_image_key: (body.slipImageKey as string) ?? null,
    /* Payment-receipt provenance (migration 0034) — the R2 key of the printed
       card-terminal payment receipt this SO was scanned from, carried over from
       the Scan Order flow so the SO detail page can show it as "Payment Receipt"
       proof. null for manually-keyed orders / scans with no receipt photo. */
    receipt_image_key: (body.receiptImageKey as string) ?? null,
    /* PR #148 + #150 — Payment fields on create (mirror PATCH handler).
       Lets commander set payment_method + deposit_centi straight from the
       New SO form, including approval_code for merchant transactions. */
    payment_method:     (body.paymentMethod as string) ?? null,
    installment_months: typeof body.installmentMonths === 'number' ? body.installmentMonths : null,
    merchant_provider:  (body.merchantProvider as string) ?? null,
    approval_code:      (body.approvalCode as string) ?? null,
    payment_date:       (body.paymentDate as string) ?? null,
    // Clamped ≥ 0 — a negative deposit would deflate the live paid rollup.
    // Split payment (Loo 2026-06-06): with payments[] the deposit IS the sum
    // of the validated rows (each positive by schema), not the legacy field.
    deposit_centi:      posPaymentsTotalCenti ?? Math.max(0, typeof body.depositCenti === 'number' ? body.depositCenti : 0),
    paid_centi:         typeof body.paidCenti === 'number' ? body.paidCenti : 0,
    /* PR #154 — Commander 2026-05-27: "我们的整个系统是没有 Draft 功能的，
       把 Draft 的功能去除掉, 我们 create 的全部都是 confirm 的". 2990 is a
       trading company; we don't need a DRAFT staging step. Every new SO is
       CONFIRMED on insert. The DRAFT enum value still exists for legacy
       row compatibility, but new rows skip it entirely. */
    status: (body as { asDraft?: unknown }).asDraft === true ? 'DRAFT' : 'CONFIRMED',
    created_by: user.id,
  });
  if (hErr) { await rollbackPwpClaims(); return c.json({ error: 'insert_failed', reason: hErr.message }, 500); }

  /* P1 (migration 0143) — the slip is now owned by this SO, so promote its
     pending row. 'promoted' rows are excluded from the reaper that deletes the
     R2 object for expired 'pending'/'uploaded' uploads (schema.ts slipUpload-
     Status comment). Best-effort — a failed promote never blocks the order. */
  if (slipKey && uploadSessionId) {
    await sb.from('pending_slip_uploads')
      .update({ status: 'promoted', promoted_at: new Date().toISOString() })
      .eq('upload_session_id', uploadSessionId);
  }

  /* ── SO-SKU spec P2 (D5, migration 0155) — the POS deposit becomes a real
     payments-ledger row at create, so Paid / Last Payment / Account Sheet /
     Collected By / Balance derive live instead of sitting dead in the
     deposit_centi header. is_deposit=true marks it so the list paid-rollup
     doesn't ALSO add the header column (double count) and Finance can tell
     deposits from balance payments. Method-scoped fields mirror the manual
     POST /:docNo/payments route. Best-effort: a ledger failure must never
     block the order (the header column still carries the deposit). */
  if (posPayments) {
    /* Split payment — book EVERY validated row. Best-effort like the single
       path (the header already carries the Σ, so a ledger hiccup never blocks
       the order); rows are schema-validated so nothing is silently dropped. */
    const paidAt = (body.paymentDate as string) ?? todayMyt();
    for (let i = 0; i < posPayments.length; i++) {
      const p = posPayments[i]!;
      const merchantLike = p.method === 'merchant' || p.method === 'installment';
      const merchantProvider = merchantLike ? (p.merchantProvider ?? null) : null;
      const installmentMonths = merchantLike
        && typeof p.installmentMonths === 'number' && p.installmentMonths > 0
        ? p.installmentMonths : null;
      const { error: depErr } = await sb.from('mfg_sales_order_payments').insert({
        so_doc_no:          docNo,
        paid_at:            paidAt,
        method:             p.method,
        merchant_provider:  merchantProvider,
        installment_months: installmentMonths,
        approval_code:      p.approvalCode ?? null,
        slip_key:           posPaymentSlipKeys![i],
        /* Account Sheet auto-fill (Loo 2026-06-07) — split rows carry no
           onlineType, so transfer falls back to 'Bank transfer'. */
        account_sheet:      deriveAccountSheet(p.method, merchantProvider, null),
        amount_centi:       p.amountCenti,
        collected_by:       (body.salespersonId as string) ?? user.id,
        created_by:         user.id,
        is_deposit:         true,
        note:               'POS split payment (auto-recorded at SO create)',
      });
      if (depErr) {
        // eslint-disable-next-line no-console
        console.error('[so-create] split-payment ledger insert failed:', depErr.message);
        continue;
      }
      /* Promote — 'promoted' rows are excluded from the slip reaper (same dance
         as the SO-create order slip). The UPDATE runs under the caller's RLS
         (pending_slip_uploads allows the UPLOADER to promote); in this flow the
         uploader IS the order creator, so it matches. If it ever doesn't (or
         errors), the row stays 'uploaded' → the reaper would delete the R2
         object after TTL and the same session would be replayable — so a no-op
         promote is logged LOUDLY instead of swallowed. Best-effort: the payment
         row stands either way (slip_key already persisted on it). */
      const { data: promoted, error: promoteErr } = await sb
        .from('pending_slip_uploads')
        .update({ status: 'promoted', promoted_at: new Date().toISOString() })
        .eq('upload_session_id', p.uploadSessionId)
        .select('upload_session_id');
      if (promoteErr || !promoted || promoted.length === 0) {
        // eslint-disable-next-line no-console
        console.error(
          `[so-create] slip promote FAILED for session ${p.uploadSessionId} on ${docNo}: `
          + (promoteErr?.message ?? 'no row matched (RLS uploader mismatch?)')
          + ' — slip will be reaped after TTL; replay window open until then.',
        );
      }
      await recordSoAudit(sb, {
        docNo,
        action: 'ADD_PAYMENT',
        actorId: user.id,
        actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
        source: 'automation',
        note: 'Auto: POS split payment recorded at SO create',
        fieldChanges: [
          { field: 'paidAt',      from: null, to: paidAt },
          { field: 'method',      from: null, to: p.method },
          { field: 'amountCenti', from: null, to: p.amountCenti },
          ...(merchantProvider ? [{ field: 'merchantProvider', from: null, to: merchantProvider } satisfies FieldChange] : []),
          ...(installmentMonths ? [{ field: 'installmentMonths', from: null, to: installmentMonths } satisfies FieldChange] : []),
          ...(p.approvalCode ? [{ field: 'approvalCode', from: null, to: p.approvalCode } satisfies FieldChange] : []),
        ],
      });
    }
  } else {
    const depositCenti = typeof body.depositCenti === 'number' ? body.depositCenti : 0;
    /* Whitelist — the ledger's method vocabulary is closed; an arbitrary
       string must not reach Finance reports. Unknown method → header-only
       (the deposit still shows via the legacy fallback), no ledger row. */
    const VALID_METHODS = new Set(['cash', 'merchant', 'transfer', 'installment']);
    const rawMethod = typeof body.paymentMethod === 'string' ? body.paymentMethod.trim() : '';
    const depositMethod = VALID_METHODS.has(rawMethod) ? rawMethod : null;
    if (depositCenti > 0 && depositMethod) {
      /* 'installment' is a merchant transaction with a term — both keep the
         provider/months fields (prod uses both method values). */
      const merchantLike = depositMethod === 'merchant' || depositMethod === 'installment';
      const merchantProvider = merchantLike ? ((body.merchantProvider as string) ?? null) : null;
      const installmentMonths = merchantLike
        && typeof body.installmentMonths === 'number' && body.installmentMonths > 0
        ? body.installmentMonths : null;
      const paidAt = (body.paymentDate as string) ?? todayMyt();
      const { error: depErr } = await sb.from('mfg_sales_order_payments').insert({
        so_doc_no:          docNo,
        paid_at:            paidAt,
        method:             depositMethod,
        merchant_provider:  merchantProvider,
        installment_months: installmentMonths,
        approval_code:      (body.approvalCode as string) ?? null,
        slip_key:           slipKey,        // order-level handover slip = the deposit's proof
        /* Account Sheet auto-fill (Loo 2026-06-07). */
        account_sheet:      deriveAccountSheet(depositMethod, merchantProvider, null),
        amount_centi:       depositCenti,
        collected_by:       (body.salespersonId as string) ?? user.id,
        created_by:         user.id,
        is_deposit:         true,
        note:               'POS deposit (auto-recorded at SO create)',
      });
      if (depErr) {
        // eslint-disable-next-line no-console
        console.error('[so-create] deposit ledger insert failed:', depErr.message);
      } else {
        await recordSoAudit(sb, {
          docNo,
          action: 'ADD_PAYMENT',
          actorId: user.id,
          actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
          source: 'automation',
          note: 'Auto: POS deposit recorded at SO create',
          fieldChanges: [
            { field: 'paidAt',      from: null, to: paidAt },
            { field: 'method',      from: null, to: depositMethod },
            { field: 'amountCenti', from: null, to: depositCenti },
            ...(merchantProvider ? [{ field: 'merchantProvider', from: null, to: merchantProvider } satisfies FieldChange] : []),
            ...(body.approvalCode ? [{ field: 'approvalCode', from: null, to: body.approvalCode as string } satisfies FieldChange] : []),
          ],
        });
      }
    }
  }

  /* Task 5 — mint the one-shot SKUs (gated + collision-safe). Runs BEFORE the
     item insert: buildOneShotMints mutates each accumulated row's item_code to
     the minted code, and the insert below spreads those rows. Uses a service-
     role client so the minted catalog rows land regardless of the caller's RLS.
     Best-effort: a minted row is an inactive tombstone — an orphan (insert that
     fails for a non-collision reason) is harmless and the SO line still carries
     the code, so we never fail the SO on a mint error. */
  if (oneShotReqs.length > 0) {
    const admin = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    // Probe a few collision suffixes (n=1..3) per request in ONE query so the
    // code buildOneShotMints picks is free even if a prior order already minted
    // the same remark on the same module (mfg_products.code is NOT uniquely
    // constrained, so a plain .insert() can't ON CONFLICT — we must pre-resolve).
    const candidate = (r: OneShotMintReq, n: number) => r.category === 'SOFA'
      ? oneShotSofaCode(r.modelCode, r.compartment, remarkSlug(r.remarkText), n)
      : oneShotSimpleCode(r.baseSkuCode, remarkSlug(r.remarkText), n);
    const probe = oneShotReqs.flatMap((r) => [1, 2, 3].map((n) => candidate(r, n)));
    const { data: existing } = await admin.from('mfg_products').select('code').in('code', probe);
    const taken = new Set((existing ?? []).map((x) => (x as { code: string }).code));
    const nowIso = new Date().toISOString();
    const idGen = () => {
      const rand = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      return `mfg-${rand.replace(/-/g, '').slice(0, 12)}`;
    };
    const skuRows = buildOneShotMints(oneShotReqs, taken, docNo, idGen, nowIso).map((r) => ({
      ...r,
      // mfg_products.cost_price_sen is NOT NULL DEFAULT 0; the minted cost is
      // unknown, so book 0 (the column default) rather than sending NULL — an
      // explicit NULL would trip a 23502 and silently drop every mint.
      cost_price_sen: r.cost_price_sen ?? 0,
    }));
    // Codes are pre-resolved free against the probe above, so a plain batched
    // insert won't collide in practice. Best-effort: any residual error (e.g. a
    // 23505 from an extremely rare 3+-order same-remark clash, or a transient
    // fault) is logged but never fails the SO — the line already references the
    // code and the SKU can be re-created from SKU Master.
    const { error: skuErr } = await admin.from('mfg_products').insert(skuRows);
    if (skuErr && skuErr.code !== '23505') {
      // eslint-disable-next-line no-console
      console.error(`[so-create] one-shot SKU mint failed for ${docNo}: ${skuErr.message}`);
    }
  }

  if (itemRows.length > 0) {
    /* Migration 0165 — line_no makes the ranked/walked array order a
       first-class column (created_at is identical across one bulk insert,
       so it can never recover this order on read). */
    const rowsWithDoc = itemRows.map((r, lineNo) => ({ ...r, doc_no: docNo, line_no: lineNo }));
    const { error: iErr } = await sb.from('mfg_sales_order_items').insert(rowsWithDoc);
    if (iErr) { await rollbackPwpClaims(); await sb.from('mfg_sales_orders').delete().eq('doc_no', docNo); return c.json({ error: 'items_insert_failed', reason: iErr.message }, 500); }
    /* Commander 2026-05-29 — re-roll the header through recomputeTotals so a
       matched sofa SET picks up its MASTER combo cost (spread across the lines).
       The inline rollup above set per-module costs; this corrects them + the
       header totals to the combo. No-op for non-sofa / non-matching SOs. */
    await recomputeTotals(sb, docNo);
  }

  /* PWP Code Voucher (migration 0130) — carry forward the un-applied reserved
     codes. Any code still RESERVED against one of THIS order's cart lines (the
     applied ones already flipped to USED in the claim pass above) becomes an
     AVAILABLE voucher bound to this order's customer: printed on the SO and
     redeemable in a future order. Keyed by the trigger line's cart_line_key,
     which the POS threads on each line as `cartLineKey`. */
  const pwpCartLineKeys = Array.from(new Set(
    items.map((it) => String((it as { cartLineKey?: string } | null)?.cartLineKey ?? '')).filter(Boolean),
  ));
  /* Promo is ONE-WAY (Loo 2026-06-06, the PWP-7615UAWC incident) — a reward
     line (bought with a code, variants.pwpCode) must never mint a FREE
     voucher of its own: with a rule whose trigger set == reward set (buy
     ARRUS → free ARRUS) the free unit would fund the next free unit, forever.
     The POS reconciler + /pwp-codes/reserve already refuse to mint these;
     this backstop kills anything reserved before that gate (old carts /
     tampered clients) instead of carrying it forward as an AVAILABLE voucher. */
  const rewardLineKeys = Array.from(new Set(
    items
      .filter((it) => String((it?.variants as { pwpCode?: string | null } | null)?.pwpCode ?? '').trim() !== '')
      .map((it) => String((it as { cartLineKey?: string } | null)?.cartLineKey ?? ''))
      .filter(Boolean),
  ));
  if (rewardLineKeys.length > 0) {
    await sb.from('pwp_codes').delete()
      .eq('owner_staff_id', user.id).eq('status', 'RESERVED').eq('type', 'promo')
      .in('cart_line_key', rewardLineKeys);
  }
  if (pwpCartLineKeys.length > 0) {
    await sb.from('pwp_codes').update({
      status: 'AVAILABLE', source_doc_no: docNo, customer_id: orderCustomerId, updated_at: new Date().toISOString(),
    }).eq('owner_staff_id', user.id).eq('status', 'RESERVED').in('cart_line_key', pwpCartLineKeys);
  }

  /* Re-stamp trigger_item_code (Loo 2026-06-06, the (K)→(Q) drift; reworked
     Loo 2026-06-12, SO-2606-008) — the snapshot is written ONCE at reserve
     time as the cart line's ANCHOR SKU. The printed SO's trigger / unused-
     voucher annotations (matched by item_code in shared/so-line-display.ts)
     need it to be a SKU that's actually ON the document, so re-stamp from
     pwpLeadRowByCartKey: the first BOOKED row per cart line (a sofa build's
     lead MODULE row — the payload anchor never lands post-split; one-shot
     mints are reflected via the in-place row rewrite). One batched read, then
     one update per distinct lead code that drifted. Covers both USED (claimed
     above — cart_line_key survives the claim) and AVAILABLE. */
  if (pwpCartLineKeys.length > 0) {
    const { data: stampRows } = await sb.from('pwp_codes')
      .select('code, cart_line_key, trigger_item_code')
      .eq('owner_staff_id', user.id)
      .in('cart_line_key', pwpCartLineKeys);
    const codesByLead = new Map<string, string[]>();
    for (const r of ((stampRows ?? []) as Array<{ code: string; cart_line_key: string | null; trigger_item_code: string | null }>)) {
      const leadRow = r.cart_line_key ? pwpLeadRowByCartKey.get(r.cart_line_key) : undefined;
      const lead = leadRow ? String(leadRow.item_code ?? '') : '';
      if (lead && r.trigger_item_code !== lead) {
        const arr = codesByLead.get(lead) ?? [];
        arr.push(r.code);
        codesByLead.set(lead, arr);
      }
    }
    for (const [lead, codes] of codesByLead) {
      const { error: stampErr } = await sb.from('pwp_codes')
        .update({ trigger_item_code: lead, updated_at: new Date().toISOString() })
        .in('code', codes);
      // eslint-disable-next-line no-console
      if (stampErr) console.error('[so-create] pwp trigger restamp failed:', lead, stampErr.message);
    }
  }

  // PR-D — audit row. Emit one CREATE entry with every non-null field the
  // commander typed on the new-SO form so the timeline shows the genesis
  // state. We deliberately include the line count rather than each line
  // (those get their own ADD_LINE rows if they're added later via PATCH).
  const createFields: FieldChange[] = [];
  const captureIfSet = (k: string, v: unknown) => {
    if (v !== undefined && v !== null && v !== '') createFields.push({ field: k, to: v });
  };
  captureIfSet('debtorName', customerName);
  captureIfSet('debtorCode', body.debtorCode);
  captureIfSet('agent', body.agent);
  captureIfSet('phone', body.phone);
  captureIfSet('email', body.email);
  captureIfSet('soDate', body.soDate);
  captureIfSet('lineCount', items.length);
  captureIfSet('localTotalCenti', total);
  captureIfSet('paymentMethod', body.paymentMethod);
  captureIfSet('depositCenti', body.depositCenti);
  captureIfSet('internalExpectedDd', body.internalExpectedDd);
  captureIfSet('customerSoNo', body.customerSoNo);
  captureIfSet('customerPo', body.customerPo);
  await recordSoAudit(sb, {
    docNo,
    action: 'CREATE',
    actorId: user.id,
    actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
    fieldChanges: createFields,
    /* Snapshot the REAL insert status — asDraft creates land as DRAFT (the
       background scan job path), everything else as CONFIRMED. Previously
       hardcoded 'CONFIRMED', which mislabelled scan drafts. */
    statusSnapshot: (body as { asDraft?: unknown }).asDraft === true ? 'DRAFT' : 'CONFIRMED',
    source: c.auditSource ?? 'web',
    note: c.auditNote,
  });

  /* B2C auto-allocation — if stock is already on hand, the new SO's lines flip
     to READY immediately and the header advances to READY_TO_SHIP. Runs a GLOBAL
     re-walk (not scoped to this doc) so that if this higher-priority order steals
     stock from a lower-priority one, the loser regresses from READY in the SAME
     pass instead of lagging. Best-effort: a failure never sinks the SO create. */
  try { await recomputeSoStockAllocation(sb); }
  catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-allocation] post-create failed:', e); }

  return c.json({ docNo }, 201);
}

/* HTTP route — auth (router-level supabaseAuth) + the real Hono context wired
   into the core verbatim, so the request path behaves exactly as before the
   factoring. The dynamic-status cast is safe: every core outcome status is a
   contentful JSON status the old inline c.json calls already used. */
mfgSalesOrders.post('/', async (c) => {
  const out = await createSalesOrderCore({
    req: { json: () => c.req.json() },
    get: ((key: 'supabase' | 'user' | 'houzsUser') => c.get(key as 'supabase')) as unknown as SoCreateContext['get'],
    env: c.env,
    json: (b, status) => ({ status: status ?? 200, body: b as Record<string, unknown> }),
  });
  return c.json(out.body, out.status as 201);
});

/* ── createDraftSalesOrder — headless SO create for the background scan job ──
   Runs the SAME createSalesOrderCore (pricing / guards / doc-no / audit all
   identical) without an HTTP request: the scan /enqueue endpoint captures the
   caller's identities while the request is still authed, and the waitUntil
   pipeline replays them here through a synthetic context.
     - salespersonId  = c.get('user').id captured at enqueue (scm.staff UUID —
       the SCM auth bridge identity the interactive create stamps).
     - houzsUserId    = c.get('houzsUser').id captured at enqueue (public users
       bigint — drives the venue-by-active-project auto-fill). No permissions
       are carried, so hasHouzsPerm gates resolve false — the draft is always
       self-attributed, exactly like a self-scoped interactive caller.
   Uses the scm-scoped service-role client (getSupabaseService) — authorization
   already happened at enqueue time; there is no request-scoped client here. */
export async function createDraftSalesOrder(
  env: Env,
  opts: {
    salespersonId: string;
    salespersonName?: string | null;
    houzsUserId?: number | null;
    body: Record<string, unknown>;
  },
): Promise<SoCreateOutcome> {
  const svc = getSupabaseService(env);
  const syntheticGet = (key: 'supabase' | 'user' | 'houzsUser'): unknown => {
    if (key === 'supabase') return svc;
    if (key === 'user') {
      return {
        id: opts.salespersonId,
        user_metadata: opts.salespersonName ? { name: opts.salespersonName } : undefined,
      };
    }
    // houzsUser — id only; permissions intentionally absent (see doc above).
    return opts.houzsUserId != null ? { id: opts.houzsUserId } : undefined;
  };
  return createSalesOrderCore({
    req: { json: async () => opts.body },
    get: syntheticGet as unknown as SoCreateContext['get'],
    env,
    json: (b, status) => ({ status: status ?? 200, body: b as Record<string, unknown> }),
    /* History attribution — the CREATE audit row shows the salesperson captured
       at enqueue time as the actor, tagged "via scan" so a rep can't claim a
       hand-typed order was OCR'd (or vice versa). */
    auditSource: 'scan',
    auditNote: 'Draft created by the background slip-scan job (photo OCR)',
  });
}

/* ── POST /recompute-allocation — re-walk every active SO line, flip
       PENDING/READY against live inventory, advance / regress SO header
       status. Manual trigger from the SO list "Re-allocate stock" button or
       admin debug. Best-effort. */
mfgSalesOrders.post('/recompute-allocation', async (c) => {
  const sb = c.get('supabase');
  const res = await recomputeSoStockAllocation(sb);
  return c.json(res);
});

// Status transition with audit row. Reads the prior status, updates, then
// inserts to mfg_so_status_changes — best-effort (audit failure does NOT
// roll back the status change).
mfgSalesOrders.patch('/:docNo/status', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo'); const user = c.get('user');
  let body: { status?: string; notes?: string };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (!body.status) return c.json({ error: 'status_required' }, 400);

  /* Audit 2026-06-20 — self-scoped sales (sales / sales_executive) must NOT
     transition or cancel another salesperson's SO by doc_no — a cancel even
     converts that SO's deposit into a customer credit. Mirror the
     line-mutation endpoints' self-scope guard. */
  if (await selfScopedSalesBlocked(sb, user.id, docNo)) return c.json({ error: 'not_found' }, 404);

  const { data: prev } = await sb.from('mfg_sales_orders').select('status').eq('doc_no', docNo).maybeSingle();
  const fromStatus = (prev as { status: string } | null)?.status ?? null;

  /* Audit 2026-06-11 C-1/H1 — a CANCELLED SO is FINAL (mirrors do_cancelled_final).
     Un-cancelling left the Edge #B SO_CANCEL_REFUND customer credit standing while
     the SO's deposit payments went live again — the same money existed twice
     (there is no SO_REOPEN_CONTRA claw-back on the SO side). Re-order via a NEW
     SO instead. Re-cancel (CANCELLED→CANCELLED) still rides through below and is
     idempotent (creditFromCancelledSo no-ops on the source pair). */
  if (fromStatus === 'CANCELLED' && body.status !== 'CANCELLED') {
    return c.json({
      error: 'so_cancelled_final',
      reason: 'A cancelled Sales Order cannot be reactivated — its deposit was already converted to customer credit. Create a new SO instead.',
    }, 409);
  }

  /* Tier 2 downstream-lock — only the CANCELLED transition is gated (mirrors
     the GRN cancel guard). Other status transitions (CONFIRMED ↔ READY_TO_SHIP
     ↔ SHIPPED ↔ DELIVERED…) ride through untouched so the existing state
     machine + auto-advance (e.g. all-lines-READY → READY_TO_SHIP) keep working. */
  if (body.status === 'CANCELLED' && fromStatus !== 'CANCELLED') {
    const childLock = await soHasDownstream(sb, docNo);
    if (childLock) return c.json(childLock, 409);
  }

  /* POS "Proceed" → stamp proceeded_at ONCE, on the first move into
     IN_PRODUCTION. Read the existing value first so re-entering IN_PRODUCTION
     (or toggling status back and forth) never overwrites the original Proceed
     date the coordinator sees on the SO detail page. (Merged with main's
     CANCELLED downstream-lock guard above — both apply.) */
  const patch: Record<string, unknown> = { status: body.status, updated_at: new Date().toISOString() };
  if (body.status === 'IN_PRODUCTION') {
    const { data: cur } = await sb.from('mfg_sales_orders').select('proceeded_at').eq('doc_no', docNo).maybeSingle();
    if (!(cur as { proceeded_at?: string } | null)?.proceeded_at) {
      patch.proceeded_at = new Date().toISOString();
    }
  }
  const { data, error } = await sb.from('mfg_sales_orders').update(patch)
    .eq('doc_no', docNo).select('doc_no, status, proceeded_at').maybeSingle();
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  // Stale/missing docNo (deleted, wrong tab) matches 0 rows → a clean 404
  // ("no longer found, refresh") instead of an opaque 500 (bug-hunt 2026-06-20).
  if (!data) return c.json({ error: 'not_found' }, 404);

  // Audit row — best-effort. We keep writing the legacy mfg_so_status_changes
  // row for now (the existing StatusTimeline panel still reads it) and ALSO
  // emit the unified mfg_so_audit_log row for the PR-D History panel.
  await sb.from('mfg_so_status_changes').insert({
    doc_no: docNo,
    from_status: fromStatus,
    to_status: body.status,
    changed_by: user.id,
    notes: body.notes ?? null,
  });
  await recordSoAudit(sb, {
    docNo,
    action: 'UPDATE_STATUS',
    actorId: user.id,
    actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
    fieldChanges: [{ field: 'status', from: fromStatus, to: body.status }],
    statusSnapshot: body.status,
    note: body.notes ?? undefined,
  });

  /* SO status changed → recompute allocation. CANCELLED removes the SO from
     the queue (its claim releases); terminal statuses (SHIPPED/DELIVERED/…)
     also drop it out. Other PENDING SOs may move into READY. Best-effort. */
  try { await recomputeSoStockAllocation(sb); }
  catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-allocation] post-status failed:', e); }

  /* Edge #B — SO cancel with deposit paid turns the deposit into a customer
     credit. Idempotent on (source_type, source_doc_no). Best-effort. */
  if (body.status === 'CANCELLED' && fromStatus !== 'CANCELLED' && fromStatus !== 'DRAFT') {
    try {
      const { data: so } = await sb.from('mfg_sales_orders').select('debtor_code, debtor_name').eq('doc_no', docNo).maybeSingle();
      const s = so as { debtor_code: string | null; debtor_name: string | null } | null;
      if (s?.debtor_code) {
        await creditFromCancelledSo(sb, {
          docNo,
          debtorCode: s.debtor_code,
          debtorName: s.debtor_name,
          createdBy: user.id,
        });
      }
    } catch (e) { /* eslint-disable-next-line no-console */ console.error('[customer-credit] so-cancel credit failed:', e); }
  }

  return c.json({ salesOrder: data });
});

// ── GET /mfg-sales-orders/:docNo/audit-log ──────────────────────────
// PR-D — unified history feed (newest first). Returns one envelope:
//   { entries: [{ id, so_doc_no, action, actor_id, actor_name_snapshot,
//                  field_changes, status_snapshot, source, note, created_at }] }
mfgSalesOrders.get('/:docNo/audit-log', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo');
  const { data, error } = await sb.from('mfg_so_audit_log')
    .select('id, so_doc_no, action, actor_id, actor_name_snapshot, field_changes, status_snapshot, source, note, created_at')
    .eq('so_doc_no', docNo)
    .order('created_at', { ascending: false });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ entries: data ?? [] });
});

// GET — list status change history for the SO detail timeline.
mfgSalesOrders.get('/:docNo/status-changes', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo');
  const { data, error } = await sb.from('mfg_so_status_changes')
    .select('id, doc_no, from_status, to_status, changed_by, notes, auto_actions, created_at')
    .eq('doc_no', docNo)
    .order('created_at', { ascending: false });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ statusChanges: data ?? [] });
});

// GET — list line price overrides for the audit panel.
mfgSalesOrders.get('/:docNo/price-overrides', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo');
  const { data, error } = await sb.from('mfg_so_price_overrides')
    .select('id, doc_no, item_id, item_code, original_price_sen, override_price_sen, reason, approved_by, created_at')
    .eq('doc_no', docNo)
    .order('created_at', { ascending: false });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ overrides: data ?? [] });
});

// POST — override the price on a single line item. Captures the original
// in the audit row so we never lose the history.
mfgSalesOrders.post('/:docNo/items/:itemId/override', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo'); const itemId = c.req.param('itemId');
  const user = c.get('user');
  /* SO-SKU spec P4 (D4) — price overrides are admin-level only. Everyone else
     gets the SKU Master price (auto-filled in the UI, enforced by the server
     recompute on POST/PATCH); this audited side-door is the ONLY way to
     deviate, so it carries the role gate. */
  if (!(await isPriceOverrideCaller(c))) {
    return c.json({
      error: 'price_override_admin_only',
      message: 'Unit prices follow the SKU Master sell price. Only an admin can override a line price.',
    }, 403);
  }
  /* Owner 2026-06-12 — processing-date lock: no price overrides once the
     processing day has passed (the locked order is already PO'd). */
  {
    const procLock = await soProcessingLockBlocked(sb, docNo);
    if (procLock) return c.json(procLock, 409);
  }
  let body: { overridePriceSen?: number; reason?: string };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const newPrice = Number(body.overridePriceSen ?? 0);
  if (!Number.isFinite(newPrice) || newPrice < 0) return c.json({ error: 'invalid_price' }, 400);

  const { data: item } = await sb.from('mfg_sales_order_items')
    .select('id, doc_no, item_code, unit_price_centi, qty, discount_centi')
    .eq('id', itemId).maybeSingle();
  if (!item) return c.json({ error: 'item_not_found' }, 404);
  const i = item as { id: string; doc_no: string; item_code: string; unit_price_centi: number; qty: number; discount_centi: number };
  if (i.doc_no !== docNo) return c.json({ error: 'item_doc_mismatch' }, 400);
  /* Audit 2026-06-11 C-2 — the override recomputes total as qty × newPrice −
     stored discount; reject an override price that would push the line total
     negative (discount invariant: 0 ≤ discount ≤ qty × unit). */
  if (Number(i.discount_centi ?? 0) > i.qty * newPrice) {
    return c.json({
      error:    'invalid_discount',
      reason:   'Stored line discount exceeds qty × override price — the line total would go negative.',
      discount: Number(i.discount_centi ?? 0),
      max:      i.qty * newPrice,
    }, 422);
  }

  // Audit first (so we don't lose original even if the update fails)
  const originalPriceSen = i.unit_price_centi;
  const overridePriceSen = newPrice;
  await sb.from('mfg_so_price_overrides').insert({
    doc_no: docNo,
    item_id: itemId,
    item_code: i.item_code,
    original_price_sen: originalPriceSen,
    override_price_sen: overridePriceSen,
    reason: body.reason ?? null,
    approved_by: user.id,
  });

  const newLineTotal = (i.qty * newPrice) - i.discount_centi;
  /* Task #114 — pull current line_cost_centi so the price override
     recomputes line_margin_centi correctly. Previous code used `- 0`
     which silently broke margin tracking on every override. */
  const { data: costRow } = await sb.from('mfg_sales_order_items')
    .select('line_cost_centi')
    .eq('id', itemId)
    .maybeSingle();
  const currentLineCost = Number((costRow as { line_cost_centi?: number } | null)?.line_cost_centi ?? 0);
  const { error } = await sb.from('mfg_sales_order_items').update({
    unit_price_centi: newPrice,
    total_centi: newLineTotal,
    total_inc_centi: newLineTotal,
    balance_centi: newLineTotal,
    line_margin_centi: newLineTotal - currentLineCost,
  }).eq('id', itemId);
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  /* Task #114 — also refresh the header totals after the override so
     total_cost_centi / total_margin_centi / category cost columns stay
     consistent with the new line revenue + margin. */
  await recomputeTotals(sb, docNo);

  // PR-D — also emit a unified audit-log entry so the History drawer
  // shows this price override alongside other UPDATE_LINE actions.
  await recordSoAudit(sb, {
    docNo,
    action: 'UPDATE_LINE',
    actorId: user.id,
    actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
    fieldChanges: [
      { field: 'unitPriceCenti', from: originalPriceSen, to: overridePriceSen },
    ],
    note: (body.reason as string) || undefined,
  });

  return c.json({ ok: true, itemId, newPrice });
});

// ── PATCH header — edit debtor info, addresses, note, etc. ───────────
/* ── Customer change on an existing SO (Loo 2026-06-13, bug-fix round 2) ───────
   When a Save re-points an SO to a different customer:
     • PWP PRODUCT lines are MAINTAINED — a customer/name edit must not re-price
       a reward. Only an ITEM change re-prices PWP (tbc-swap). So there is NO
       strip here.
     • the SO's MINTED vouchers (source_doc_no = docNo) follow the order — their
       customer_id is re-pointed to the new customer.
     • the cross-category DELIVERY fee (a SERVICE line whose rate depends on the
       customer's other orders) is RE-DETECTED — see redetectCrossCategoryDelivery. */
async function repointMintedVouchers(sb: any, docNo: string, newCustomerId: string | null): Promise<number> {
  if (!newCustomerId) return 0;
  const { data } = await sb.from('pwp_codes')
    .update({ customer_id: newCustomerId, updated_at: new Date().toISOString() })
    .eq('source_doc_no', docNo)
    .select('code');
  return ((data ?? []) as Array<{ code: string }>).length;
}

/* Core delivery-fee recompute — re-derives the authoritative delivery FEE from
   the SO's CURRENT items, for a CALLER-SUPPLIED cross-category sourceDocNo. It
   does NOT auto-match a source: the caller decides whether to re-run the
   customer auto-match (the customer-change path, redetectCrossCategoryDelivery)
   or to pass the SO's already-stored source through unchanged (the item-edit
   path, rederiveDeliveryFee). Preserves the operator's free-form additional fee
   (recovered from the existing SVC-DELIVERY-ADD line), recomputes on the
   authoritative computeSoDeliveryFee, and rebuilds the SVC-DELIVERY* lines. Only
   runs when the SO already carries a delivery fee (else returns null BEFORE
   recomputeTotals — the caller is responsible for any totals refresh).
   Best-effort: logs DB errors, never throws. */
async function recomputeDeliveryFeeCore(
  sb: any, docNo: string, sourceDocNo: string | null,
): Promise<{ isFollowup: boolean; sourceDocNo: string | null; total: number } | null> {
  const { data: lineRows } = await sb.from('mfg_sales_order_items')
    .select('item_code, item_group, total_centi, line_no, variants')
    .eq('doc_no', docNo).eq('cancelled', false);
  const lines = (lineRows ?? []) as Array<{ item_code: string; item_group: string | null; total_centi: number | null; line_no: number | null; variants: Record<string, unknown> | null }>;
  const deliveryLines = lines.filter((l) => isDeliveryFeeServiceCode(l.item_code));
  if (deliveryLines.length === 0) return null; // no delivery fee → nothing to re-detect

  // The rebuilt SVC-DELIVERY* lines append AFTER the kept lines (services sort
  // last anyway, but a numbered line_no keeps the order stable + matches create).
  const keptMaxLineNo = Math.max(
    -1,
    ...lines.filter((l) => !isDeliveryFeeServiceCode(l.item_code))
      .map((l) => (typeof l.line_no === 'number' ? l.line_no : -1)),
  );

  // Operator free-form fee — preserved across the recompute.
  const additionalSen = deliveryLines
    .filter((l) => l.item_code === SVC_DELIVERY_ADD)
    .reduce((s, l) => s + Number(l.total_centi ?? 0), 0);

  // Deliverable categories (sofa / mattress / bedframe) + their special-model fees.
  const DELIVERABLE = new Set(['sofa', 'mattress', 'bedframe']);
  const categoryIds = lines
    .map((l) => String(l.item_group ?? '').toLowerCase())
    .filter((g) => DELIVERABLE.has(g));
  const goodsLines = lines.filter((l) => DELIVERABLE.has(String(l.item_group ?? '').toLowerCase()));
  const goodsCodes = [...new Set(goodsLines.map((l) => l.item_code))];
  /* Phase 1 — special delivery fee rules (migration 0024, #691 RuleTarget).
     The persisted SO carries the split sofa as one row PER module SKU (cells
     stripped, buildKey kept). A sofa module's compartment code lives in its
     item_code SUFFIX (every sofa SKU has size_code = NULL); size_code is the
     real variant code ONLY for mattress/bedframe. Sofa rows are regrouped by
     buildKey so combo matching sees the WHOLE build's modules together. The
     reconstruction is a pure helper (reconstructDeliveryRuleLines) and the
     result is matched by the SAME shared matcher the create path runs. */
  let specialModels: { standaloneFee: number; crossCategoryFollowupFee: number }[] = [];
  if (goodsCodes.length > 0) {
    const { data: prodRows } = await sb.from('mfg_products')
      .select('code, category, model_id, size_code').in('code', goodsCodes);
    const prodByCode = new Map(
      ((prodRows ?? []) as Array<{ code: string; category: string | null; model_id: string | null; size_code: string | null }>)
        .map((p) => [p.code, p]),
    );
    const deliveryRuleLines = reconstructDeliveryRuleLines(
      goodsLines.map((l) => {
        const prod = prodByCode.get(l.item_code) ?? null;
        return {
          itemCode: l.item_code,
          category: prod?.category ?? l.item_group ?? null,
          modelId: prod?.model_id ?? null,
          sizeCode: prod?.size_code ?? null, // NULL for sofa; the helper reads the item_code suffix
          buildKey: ((l.variants as { buildKey?: unknown } | null)?.buildKey as string | null) ?? null,
        };
      }),
    );
    const { data: comboRows } = await sb.from('sofa_combo_pricing').select('id, modules');
    const comboModulesById = new Map<string, string[][]>(
      ((comboRows ?? []) as Array<{ id: string; modules: string[][] | null }>)
        .map((cb) => [cb.id, cb.modules ?? []]),
    );
    specialModels = await specialDeliveryFeesForLines(sb, deliveryRuleLines, comboModulesById);
  }

  const { data: dcfg } = await sb.from('delivery_fee_config').select('base_fee, cross_category_fee').eq('id', 1).single();
  const cfgSen = {
    baseFee: Number((dcfg as { base_fee?: number } | null)?.base_fee ?? 0) * 100,
    crossCategoryFee: Number((dcfg as { cross_category_fee?: number } | null)?.cross_category_fee ?? 0) * 100,
  };

  /* sourceDocNo is the caller's responsibility (see the function doc). No
     auto-match here — the item-edit path MUST pass the SO's stored source
     through unchanged. */
  const isFollowup = !!sourceDocNo;
  const fee = computeSoDeliveryFee(
    { categoryIds, specialModels, isCrossCategoryFollowup: isFollowup, additionalFee: additionalSen },
    cfgSen,
  );
  const specs = buildDeliveryFeeServiceLines(fee, sourceDocNo);

  // Header context for the rebuilt service rows.
  const { data: hdr } = await sb.from('mfg_sales_orders')
    .select('debtor_name, venue, customer_delivery_date').eq('doc_no', docNo).maybeSingle();
  const h = (hdr ?? {}) as { debtor_name?: string | null; venue?: string | null; customer_delivery_date?: string | null };

  // Replace the SVC-DELIVERY* lines: delete the old, insert the recomputed.
  const { error: delErr } = await sb.from('mfg_sales_order_items').delete()
    .eq('doc_no', docNo).in('item_code', [SVC_DELIVERY, SVC_DELIVERY_CROSS, SVC_DELIVERY_ADD]);
  if (delErr) { /* eslint-disable-next-line no-console */ console.error('[so-redetect] delivery line delete failed:', delErr.message); }
  if (specs.length > 0) {
    const lineDateToday = todayMyt();
    const rows = specs.map((spec, i) => ({
      doc_no: docNo,                                    // ⚠️ NOT NULL — omitting it silently dropped the line (the bug)
      line_no: keptMaxLineNo >= 0 ? keptMaxLineNo + 1 + i : null,
      line_date: lineDateToday,
      debtor_name: h.debtor_name ?? null,
      item_group: 'service',
      item_code: spec.itemCode,
      description: spec.description,
      description2: null,
      remark: spec.remark ?? null,
      uom: 'UNIT',
      qty: spec.qty,
      unit_price_centi: spec.unitPriceSen,
      discount_centi: 0,
      total_centi: spec.totalSen,
      total_inc_centi: spec.totalSen,
      balance_centi: spec.totalSen,
      variants: null,
      unit_cost_centi: 0,
      line_cost_centi: 0,
      line_margin_centi: spec.totalSen,
      divan_price_sen: 0,
      leg_price_sen: 0,
      special_order_price_sen: 0,
      custom_specials: null,
      line_delivery_date: h.customer_delivery_date ?? null,
      line_delivery_date_overridden: false,
      warehouse_id: null,
      branding: null,
      venue: h.venue ?? null,
      stock_status: 'READY',
    }));
    const { error: insErr } = await sb.from('mfg_sales_order_items').insert(rows);
    if (insErr) { /* eslint-disable-next-line no-console */ console.error('[so-redetect] delivery line insert failed:', insErr.message); }
  }

  await sb.from('mfg_sales_orders').update({
    cross_category_source_doc_no: sourceDocNo,
    delivery_fee_centi: fee.total,
    updated_at: new Date().toISOString(),
  }).eq('doc_no', docNo);
  await recomputeTotals(sb, docNo);
  return { isFollowup, sourceDocNo, total: fee.total };
}

/* Re-detect the cross-category delivery fee against a (re-resolved) customer —
   the CUSTOMER-CHANGE path. Auto-matches the new customer's eligible source SO
   with the SAME logic as the handover Auto-match button (pickCrossCategoryMatch),
   self-excluding THIS SO so changing BACK to the original customer restores the
   discount. The match (or null) is then handed to recomputeDeliveryFeeCore which
   rebuilds the SVC-DELIVERY* lines + header on the authoritative
   computeSoDeliveryFee. Only runs when the SO already carries a delivery fee.
   Best-effort. */
async function redetectCrossCategoryDelivery(
  sb: any, docNo: string, newName: string, newPhone: string | null,
): Promise<{ isFollowup: boolean; sourceDocNo: string | null; total: number } | null> {
  // Auto-match the new customer for an eligible cross-category source SO.
  let sourceDocNo: string | null = null;
  const normPhone = newPhone ? (normalizePhone(newPhone) ?? newPhone) : null;
  if (newName && normPhone) {
    const { data: candRows } = await sb.from('mfg_sales_orders')
      .select('doc_no, debtor_name, created_at')
      .eq('phone', normPhone).not('status', 'in', '("CANCELLED","DRAFT")').neq('doc_no', docNo)
      .order('created_at', { ascending: false }).limit(50);
    const candidates: AutoMatchCandidate[] = ((candRows ?? []) as Array<{ doc_no: string; debtor_name: string | null }>)
      .map((r) => ({ docNo: r.doc_no, debtorName: r.debtor_name }));
    if (candidates.length > 0) {
      const { data: usedRows } = await sb.from('mfg_sales_orders')
        .select('cross_category_source_doc_no')
        .in('cross_category_source_doc_no', candidates.map((x) => x.docNo))
        .neq('doc_no', docNo); // self-excluded: this SO's own link must not burn its own source
      const used = ((usedRows ?? []) as Array<{ cross_category_source_doc_no: string | null }>)
        .map((r) => r.cross_category_source_doc_no).filter((v): v is string => !!v);
      const match = pickCrossCategoryMatch(candidates, newName, used);
      if (match) sourceDocNo = match.docNo;
    }
  }
  return recomputeDeliveryFeeCore(sb, docNo, sourceDocNo);
}

/* Re-derive the delivery fee from the SO's CURRENT items — the ITEM-EDIT path.
   Unlike the customer-change path, this MUST NOT re-run the customer auto-match:
   it reads the SO's already-stored cross_category_source_doc_no and passes it
   THROUGH unchanged, so a benign item edit never drops or flips an operator-
   pinned cross-category source link. Only the FEE re-derives (special-delivery
   triggers + sofa↔mattress cross-category mix follow the current items). When
   the SO carries no delivery fee, the core early-bails (null) before
   recomputeTotals, so we still refresh the header totals for the edit.
   Best-effort. */
async function rederiveDeliveryFee(sb: any, docNo: string): Promise<void> {
  let storedSource: string | null = null;
  const { data: hdr } = await sb.from('mfg_sales_orders')
    .select('cross_category_source_doc_no').eq('doc_no', docNo).maybeSingle();
  storedSource = (hdr as { cross_category_source_doc_no?: string | null } | null)?.cross_category_source_doc_no ?? null;
  const res = await recomputeDeliveryFeeCore(sb, docNo, storedSource);
  if (res === null) await recomputeTotals(sb, docNo);
}

mfgSalesOrders.patch('/:docNo', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo'); const user = c.get('user');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }

  /* Audit 2026-06-20 — self-scoped sales may only edit their OWN SO. Without
     this a sales/sales_executive reaching the Backend SO detail could PATCH any
     order by doc_no (customer fields, even salesperson_id reassignment). Mirror
     the line-mutation endpoints' self-scope guard. */
  if (await selfScopedSalesBlocked(sb, user.id, docNo)) return c.json({ error: 'not_found' }, 404);

  /* Owner 2026-06-03 (migration 0144) — phone is COMPULSORY on every SO. The
     CREATE path blocks an empty phone (phone_required); the EDIT path must too,
     or the compulsory-phone rule is bypassable by PATCHing phone to blank.
     Only guard when phone is actually present in the body (a PATCH that doesn't
     touch phone leaves the existing value untouched). */
  if (body.phone !== undefined) {
    const patchPhone = typeof body.phone === 'string' ? body.phone.trim() : '';
    if (!patchPhone) {
      return c.json({ error: 'phone_required', reason: 'A phone number is required on every sales order.' }, 400);
    }
  }

  /* Loo 2026-06-05 — maintained-dropdown 409 gate on edit too, or the create
     gate is bypassable by PATCHing a dirty value in afterwards. */
  const dropdownErr = await validateSoDropdownFields(sb, body);
  if (dropdownErr) return c.json(dropdownErr, 409);

  const map: Array<[string, string]> = [
    ['debtorCode', 'debtor_code'], ['debtorName', 'debtor_name'], ['agent', 'agent'],
    ['salesLocation', 'sales_location'], ['ref', 'ref'], ['poDocNo', 'po_doc_no'],
    ['venue', 'venue'], ['venueId', 'venue_id'], ['branding', 'branding'], ['transferTo', 'transfer_to'],
    ['address1', 'address1'], ['address2', 'address2'], ['address3', 'address3'],
    ['address4', 'address4'], ['phone', 'phone'], ['note', 'note'],
    ['remark2', 'remark2'], ['remark3', 'remark3'], ['remark4', 'remark4'],
    ['soDate', 'so_date'], ['currency', 'currency'],
    // PR #35 — new header fields
    ['customerId', 'customer_id'], ['customerState', 'customer_state'],
    ['customerPo', 'customer_po'], ['customerPoId', 'customer_po_id'],
    ['customerPoDate', 'customer_po_date'], ['customerPoImageB64', 'customer_po_image_b64'],
    // PR #121 — customer's own SO number (their ERP ref)
    ['customerSoNo', 'customer_so_no'],
    ['hubId', 'hub_id'], ['hubName', 'hub_name'],
    ['customerDeliveryDate', 'customer_delivery_date'],
    ['internalExpectedDd', 'internal_expected_dd'],
    /* Mig 0053 (port of 2990 0199 + 0201) — amendment carriers. The customer's
       original `customer_delivery_date` above is NEVER overwritten by an amend;
       these three columns hold the customer's REQUESTED-changed date, the date
       WE confirm, and the free-text "why". Delivery Planning's `/fields` route
       also writes `amend_date_from_customer` + `amended_delivery_date` (and the
       `/schedule` action stamps `amended_delivery_date`); this PATCH lets the
       SO Detail page edit any of them inline too, including the reason. */
    ['amendDateFromCustomer', 'amend_date_from_customer'],
    ['amendedDeliveryDate', 'amended_delivery_date'],
    ['amendReason', 'amend_reason'],
    /* POS "Proceed" — sales-side done marker; stamp-once guard below. */
    ['proceededAt', 'proceeded_at'],
    ['linkedDoDocNo', 'linked_do_doc_no'],
    ['shipToAddress', 'ship_to_address'], ['billToAddress', 'bill_to_address'],
    ['installToAddress', 'install_to_address'],
    /* PR #46 — POS handover fields */
    ['email', 'email'], ['customerType', 'customer_type'],
    ['salespersonId', 'salesperson_id'],
    ['city', 'city'], ['postcode', 'postcode'], ['buildingType', 'building_type'],
    ['emergencyContactName', 'emergency_contact_name'],
    ['emergencyContactPhone', 'emergency_contact_phone'],
    ['emergencyContactRelationship', 'emergency_contact_relationship'],
    ['targetDate', 'target_date'],
    /* PR #143 + #150 — Payment fields */
    ['paymentMethod', 'payment_method'],
    ['installmentMonths', 'installment_months'],
    ['merchantProvider', 'merchant_provider'],
    ['approvalCode', 'approval_code'],
    ['paymentDate', 'payment_date'],
    ['depositCenti', 'deposit_centi'],
    ['paidCenti', 'paid_centi'],
  ];
  /* Task #91 — phone columns get normalized to E.164 storage form before any
     UPDATE. UI sends the storage form already (PhoneInput blur), but a
     misbehaving client could still PATCH a raw "+60 12 345 6789". */
  const PHONE_FIELDS = new Set(['phone', 'emergencyContactPhone']);
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const [from, to] of map) {
    if (body[from] === undefined) continue;
    if (PHONE_FIELDS.has(from) && typeof body[from] === 'string') {
      const raw = body[from] as string;
      updates[to] = normalizePhone(raw) ?? raw;
    } else {
      updates[to] = body[from];
    }
  }
  /* Task #121 — when customerState changes, re-derive customer_country
     from my_localities so the SO snapshot follows the new state's country.
     A null state explicitly clears the snapshot (so an SO whose state is
     wiped doesn't keep a stale country). */
  if (body['customerState'] !== undefined) {
    updates['customer_country'] = await deriveCountryFromState(
      sb,
      body['customerState'] as string | null,
    );
    /* Commander 2026-05-29 — Location follows the address. When the State
       changes and the caller didn't also send an explicit salesLocation,
       re-derive the warehouse so Location tracks the new State. An explicit
       salesLocation in the same patch still wins (already mapped above). A
       null/unmapped State leaves Location untouched rather than wiping it. */
    if (body['salesLocation'] === undefined) {
      const derived = await deriveSalesLocationFromState(
        sb,
        body['customerState'] as string | null,
      );
      if (derived) updates['sales_location'] = derived;
    }
    /* Re-bind the per-line warehouse: the create-time derive runs only once, so
       an SO whose State was filled in / corrected AFTER creation kept its lines'
       warehouse_id NULL → "—" in MRP. Backfill the warehouse onto lines that
       don't have one yet (NULL only — explicit per-line overrides untouched).
       Wei Siang 2026-06-16. */
    const reboundWh = await deriveWarehouseIdFromState(sb, body['customerState'] as string | null);
    if (reboundWh) {
      await sb
        .from('mfg_sales_order_items')
        .update({ warehouse_id: reboundWh })
        .eq('doc_no', docNo)
        .eq('cancelled', false)
        .is('warehouse_id', null);
    }
  }

  if (Object.keys(updates).length === 1) return c.json({ ok: true, changed: 0 });

  /* PR — Commander 2026-05-28 — Server-side variant rule enforcement.
     When the caller sets internalExpectedDd (Processing Date) to a non-null
     value, EVERY non-cancelled line for this SO must have its category-
     required variants filled. Mirrors the UI warning in SalesOrderDetail
     (REQUIRED_BY_CATEGORY: bedframe needs divanHeight+legHeight+gap+fabricCode;
     sofa needs seatHeight+legHeight+fabricCode). Without this guard, the
     coordinator can ignore the red banner and still hit the API directly.

     Bedframes + sofas with incomplete variants block the request with HTTP
     409 + a list of offending lines so the UI can re-render the warning. */
  if (body['internalExpectedDd'] !== undefined && body['internalExpectedDd'] !== null && body['internalExpectedDd'] !== '') {
    const { data: liveItems } = await sb
      .from('mfg_sales_order_items')
      .select('id, item_code, item_group, variants, cancelled')
      .eq('doc_no', docNo);
    // Shared with the POST create path (so-variant-check) — one rule, no drift.
    const offenders = findIncompleteVariantLines(
      ((liveItems ?? []) as Array<{ id: string; item_code: string; item_group: string; variants: Record<string, unknown> | null; cancelled: boolean }>)
        .filter((it) => !it.cancelled)
        .map((it) => ({ id: it.id, itemCode: it.item_code, group: it.item_group, variants: it.variants })),
    );
    if (offenders.length > 0) {
      return c.json({
        error: 'variants_incomplete',
        message: 'Processing Date requires all category-mandatory variants on every line.',
        offenders,
      }, 409);
    }
  }

  // PR-D — snapshot the row before update so we can emit a field-level diff
  // in the audit log. Only fields actually in the patch body are compared.
  const beforeCols = map.map(([, snake]) => snake).concat(['status', 'processing_date']).join(', ');
  const { data: before } = await sb.from('mfg_sales_orders').select(beforeCols).eq('doc_no', docNo).maybeSingle();

  /* Owner 2026-06-12 — processing-date lock: once the processing day has
     passed (midnight MYT after), the SO is what we PO to the supplier — every
     header edit is rejected wholesale. Status transitions (/status route),
     the payments ledger and PO/DO conversions do NOT come through this PATCH
     and stay open. Sits AFTER the cancelled/downstream-agnostic validations
     above but before any write. (`before` carries internal_expected_dd via
     the map + processing_date appended above.) */
  if (soProcessingLocked(before as unknown as { internal_expected_dd?: string | null; processing_date?: string | null; proceeded_at?: string | null } | null)) {
    /* Field-scoped (Loo 2026-06-13) — only a genuine change to a production-
       schedule date column is rejected; customer / address / payment header
       fields stay editable in the Proceed lane. `before` carries every patched
       column via the map snapshot above. */
    const beforeRowProc = before as unknown as Record<string, unknown>;
    const changedSchedule = [...SO_PROCESSING_LOCK_COLS].filter(
      (col) => col in updates && norm(updates[col]) !== norm(beforeRowProc[col]),
    );
    if (changedSchedule.length > 0) {
      return c.json(SO_PROCESSING_LOCKED_RESPONSE, 409);
    }
  }

  /* proceeded_at is stamp-once for the FORWARD move (the POS "Proceed" marker):
     once set, a later header edit / repeat proceed must NOT overwrite the
     original sales-side timestamp, so a non-null re-stamp on an already-
     proceeded row is dropped. An explicit `null`, though, is the POS
     "Move to Order placed" un-proceed (Loo 2026-06-13) — it clears the marker
     so the SO drops back to the editable Order-placed lane, so null passes
     through. The processing-date lock above already 409s this once the
     processing day has passed (a locked SO is what we PO to the supplier and
     can't be pulled back). */
  if (updates['proceeded_at'] !== undefined && updates['proceeded_at'] !== null
      && before && (before as unknown as Record<string, unknown>)['proceeded_at']) {
    delete updates['proceeded_at'];
  }

  /* Commander 2026-05-28 / Owner 2026-06-01 — Processing & Delivery Date may
     only be today or a future date, BUT an already-past value the edit does NOT
     change is grandfathered through. The old rule rejected ANY past value, so an
     SO whose Processing Date had simply elapsed could never be edited again
     (e.g. to postpone the Delivery Date). Now only a genuinely NEW past value is
     rejected — an unchanged elapsed date passes. today = Malaysia UTC+8. */
  {
    const beforeRow = (before as unknown as Record<string, unknown> | null);
    const todayMY = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    const proc = body['internalExpectedDd'];
    const deliv = body['customerDeliveryDate'];
    const origProc = (beforeRow?.['internal_expected_dd'] as string | null) ?? null;
    const origDeliv = (beforeRow?.['customer_delivery_date'] as string | null) ?? null;
    if (typeof proc === 'string' && proc && proc < todayMY && proc !== origProc) {
      return c.json({ error: 'processing_date_past', reason: 'Processing Date cannot be in the past — today or a future date only.' }, 400);
    }
    if (typeof deliv === 'string' && deliv && deliv < todayMY && deliv !== origDeliv) {
      return c.json({ error: 'delivery_date_past', reason: 'Delivery Date cannot be in the past — today or a future date only.' }, 400);
    }
    /* Owner 2026-06-03 — Process Date ≤ Delivery Date (factory start can't be
       after the promised delivery). Use the EFFECTIVE values: the patch value
       when this request sets the key, else the stored value — so editing only
       one date still validates against the other already on the row. */
    const effProc  = typeof proc  === 'string' ? (proc  || null) : origProc;
    const effDeliv = typeof deliv === 'string' ? (deliv || null) : origDeliv;
    if (effProc && effDeliv && effProc > effDeliv) {
      return c.json({ error: 'processing_after_delivery', reason: 'Processing Date cannot be later than the Delivery Date.' }, 400);
    }
    /* Owner 2026-07-04 — Processing + Delivery are all-or-nothing (both set or
       both empty), same as the CREATE path. The CREATE guard existed but the
       edit path skipped it, so a PATCH could set one date without the other and
       bypass the rule. Only fires when THIS request touches a date — a patch
       that doesn't touch dates grandfathers any legacy unpaired row through. */
    const touchesDates = typeof proc === 'string' || typeof deliv === 'string';
    if (touchesDates && Boolean(effProc) !== Boolean(effDeliv)) {
      return c.json({
        error: 'processing_delivery_must_pair',
        reason: 'Processing Date and Delivery Date must be set together (or both left empty).',
      }, 400);
    }
  }

  /* Loo 2026-06-13 — POS "Save" opt-in (recustomer:true). Re-resolve customer_id
     from the edited name+phone exactly as create does, and write it into
     `updates` BEFORE the identity lock below so a DO/SI still freezes a customer
     reassignment. PWP product lines are NOT touched (only an item swap re-prices
     those). When the identity changed we re-detect the cross-category delivery
     fee + re-point this SO's minted vouchers AFTER the write (see below). */
  const beforeRowAll = before as unknown as Record<string, unknown> | null;
  const oldCustomerId = (beforeRowAll?.['customer_id'] as string | null) ?? null;
  let resolvedNewCustomerId: string | null = null;
  let customerIdentityChanged = false; // name or phone changed → re-detect cross-category
  let reNewName = '';
  let reNewPhone: string | null = null;
  if (body['recustomer'] === true) {
    const nm = typeof body['debtorName'] === 'string' ? (body['debtorName'] as string).trim()
             : typeof body['customerName'] === 'string' ? (body['customerName'] as string).trim()
             : ((beforeRowAll?.['debtor_name'] as string | null) ?? '');
    const ph = typeof updates['phone'] === 'string' ? (updates['phone'] as string)
             : ((beforeRowAll?.['phone'] as string | null) ?? null);
    const nameChanged = nm !== ((beforeRowAll?.['debtor_name'] as string | null) ?? '');
    const phoneChanged = ph !== null && norm(ph) !== norm(beforeRowAll?.['phone']);
    if ((nameChanged || phoneChanged) && nm && ph) {
      customerIdentityChanged = true;
      reNewName = nm;
      reNewPhone = ph;
      const { data: rid } = await sb.rpc('upsert_customer_by_name_phone', {
        p_name: nm, p_phone: ph,
        p_email: typeof body['email'] === 'string' && (body['email'] as string).trim() ? (body['email'] as string).trim() : null,
      });
      resolvedNewCustomerId = (rid as string | null) ?? null;
      if (resolvedNewCustomerId) {
        updates['customer_id'] = resolvedNewCustomerId; // visible to the identity lock below
      }
    }
  }

  /* Owner 2026-05-31 — Partial header lock. Once a non-cancelled DO / SI exists,
     the IDENTITY + VALUE fields that downstream documents snapshot (customer,
     branding, addresses, ref, location, customer PO, currency, SO date, etc.)
     are frozen. Payment / remark / scheduling fields stay editable because a
     small shop records customer payment AFTER delivery. We compare the patch
     against the stored row so a UI that re-sends unchanged identity fields does
     not falsely trip the lock — only a genuine change to a locked field blocks. */
  if (before) {
    const beforeRow = before as unknown as Record<string, unknown>;
    const changedLocked = [...SO_IDENTITY_LOCK_COLS].filter(
      (col) => col in updates && norm(updates[col]) !== norm(beforeRow[col]),
    );
    if (changedLocked.length > 0) {
      const lock = await soHasDownstream(sb, docNo);
      if (lock) {
        return c.json({
          error: 'so_identity_locked',
          message: 'SO has a Delivery Order / Sales Invoice — customer, branding, address, reference and value fields are locked. Payment and remarks can still be edited.',
          lockedFields: changedLocked,
        }, 409);
      }
    }
  }

  const { data, error } = await sb.from('mfg_sales_orders').update(updates).eq('doc_no', docNo).select('doc_no').maybeSingle();
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  if (!data) return c.json({ error: 'not_found' }, 404);

  /* Customer identity changed → the minted vouchers follow the order, and the
     cross-category delivery fee re-detects against the new customer. PWP PRODUCT
     prices are deliberately UNTOUCHED. Best-effort: the header is already saved;
     a failure here is logged, not surfaced. */
  let crossCategoryRedetect: { isFollowup: boolean; sourceDocNo: string | null; total: number } | null = null;
  if (customerIdentityChanged) {
    try {
      if (resolvedNewCustomerId && resolvedNewCustomerId !== oldCustomerId) {
        await repointMintedVouchers(sb, docNo, resolvedNewCustomerId);
      }
      crossCategoryRedetect = await redetectCrossCategoryDelivery(sb, docNo, reNewName, reNewPhone);
    } catch (e) {
      /* eslint-disable-next-line no-console */
      console.error('[mfg-so] customer-change re-detect failed:', e);
    }
  }

  /* PR-E — Master-follower cascade. When the header's customer_delivery_date
     changes, EVERY line picks up the new date and its per-line override flag is
     cleared (Commander 2026-06-18 #4: the header delivery date is the source of
     truth for ordering, so MRP — which derives each line's suggested PO/order-by
     date from line_delivery_date — stays accurate after a header date edit,
     including lines that were previously edited individually). Previously lines
     with line_delivery_date_overridden=true were skipped, which left MRP showing
     a stale order-by date. Best-effort: if the cascade UPDATE fails we still
     report success for the header; the next refresh shows the divergence. */
  if (body['customerDeliveryDate'] !== undefined) {
    const newDate = body['customerDeliveryDate'] as string | null;
    await sb.from('mfg_sales_order_items')
      .update({ line_delivery_date: newDate, line_delivery_date_overridden: false })
      .eq('doc_no', docNo);
  }

  /* PR-D — Audit log row capturing field-level from→to diff. */
  if (before) {
    // Cast via `unknown` first: Supabase types the joined select result as
    // `GenericStringError` until proven typed, which doesn't structurally
    // overlap with our Record. The runtime shape IS a Record though, so the
    // double-cast is safe.
    const beforeRow = before as unknown as Record<string, unknown>;
    const fieldChanges = diffFields(beforeRow, body, map);
    if (fieldChanges.length > 0) {
      await recordSoAudit(sb, {
        docNo,
        action: 'UPDATE_DETAILS',
        actorId: user.id,
        actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
        fieldChanges,
        statusSnapshot: (beforeRow as { status?: string }).status ?? null,
      });
    }
  }

  /* SO header edit may have changed customer_delivery_date or
     allocation_warehouse_id — both reshuffle the allocation queue. Recompute.
     Best-effort. */
  try { await recomputeSoStockAllocation(sb); }
  catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-allocation] post-header-patch failed:', e); }

  return c.json({
    ok: true,
    docNo,
    ...(crossCategoryRedetect ? {
      deliveryRedetected: true,
      crossCategory: crossCategoryRedetect.isFollowup,
      crossCategorySourceDocNo: crossCategoryRedetect.sourceDocNo,
      deliveryFeeCenti: crossCategoryRedetect.total,
    } : {}),
  });
});

// ── Item CRUD ─────────────────────────────────────────────────────────
//
// Each mutation recomputes the header totals + category breakdown so the
// list view stays accurate without a separate refresh step.
// Exported so the free-gift reconciler (lib/free-gift-reconcile.ts) can finish
// with the SAME authoritative roll-up the edit endpoints used to call directly.
// route<->lib function cycle is safe (not invoked at module-eval time).
export async function recomputeTotals(sb: any, docNo: string) {
  const { data: items } = await sb.from('mfg_sales_order_items')
    .select('id, item_code, item_group, variants, qty, total_centi, line_cost_centi')
    .eq('doc_no', docNo).eq('cancelled', false);
  type Row = { id: string; item_code: string; item_group: string; variants: Record<string, unknown> | null; qty: number; total_centi: number; line_cost_centi: number };
  const rows = (items ?? []) as Row[];

  /* ── Master sofa-combo COST spread (Commander 2026-05-29) ──────────────────
     A sofa is a set of per-module lines. When those lines (same base model)
     match a MASTER combo (sofa_combo_pricing where supplier_id IS NULL — the
     Product-Maintenance combo), the set's COST = the combo price, spread across
     the matched lines (mirror of the PO side, but master-scoped). We spread off
     the stored per-line line_cost_centi (the per-module base cost). Idempotent:
     spreadComboTotal re-normalises an already-spread group to the same total. */
  const sofaRows = rows.filter((r) => (r.item_group ?? '').toLowerCase() === 'sofa');
  if (sofaRows.length > 0) {
    const combos = await loadActiveSofaCombos(sb); // master scope only
    if (combos.length > 0) {
      const fabricCodes = [...new Set(sofaRows.map((r) => String((r.variants ?? {} as Record<string, unknown>).fabricCode ?? '')).filter(Boolean))];
      const tierByFabric = new Map<string, SofaPriceTier>();
      if (fabricCodes.length > 0) {
        const { data: fabs } = await sb.from('fabric_trackings').select('fabric_code, price_tier, sofa_price_tier').in('fabric_code', fabricCodes);
        for (const f of (fabs ?? []) as Array<{ fabric_code: string; price_tier: SofaPriceTier | null; sofa_price_tier: SofaPriceTier | null }>) {
          tierByFabric.set(f.fabric_code, (f.sofa_price_tier ?? f.price_tier ?? 'PRICE_2'));
        }
      }
      const groups = new Map<string, Row[]>();
      for (const r of sofaRows) {
        const { baseModel, sizeCode } = splitSofaCode(r.item_code);
        /* Audit 2026-06-11 I-1 — the old `sizeCode.includes('-')` gate was a
           legacy dash-vocabulary sniff that skipped EVERY canonical parens
           module (`1A(LHF)`) AND whole-unit codes (1S/2S/3S), making this
           whole spread dead code since the 2026-06-04 vocabulary unification.
           Module-set matching is pickComboMatch's job (it already rejects
           non-matching sets); we only skip codes with no module token at all. */
        if (!sizeCode) continue; // bare model code → nothing to match
        const key = baseModel.toUpperCase();
        const arr = groups.get(key) ?? [];
        arr.push(r); groups.set(key, arr);
      }
      for (const [bm, members] of groups) {
        const tierOf = (m: Row) => tierByFabric.get(String((m.variants ?? {} as Record<string, unknown>).fabricCode ?? '')) ?? 'PRICE_2';
        const tiers = new Set(members.map(tierOf));
        if (tiers.size !== 1) continue;
        const tier = [...tiers][0]!;
        const heights = new Set(members.map((m) => sofaHeightKey(m.variants)));
        if (heights.size !== 1) continue;
        const height = [...heights][0]!;
        if (!height) continue;
        /* Audit 2026-06-11 I2 — combos must match the SAME base model only
           (owner rule: no cross-model fallback). Module codes are a shared
           vocabulary, so falling back to ALL combos let a Model with no combos
           silently take another Model's combo price as its set cost. */
        const pool = combos.filter((cmb) => (cmb.baseModel ?? '').toUpperCase() === bm);
        if (pool.length === 0) continue; // no combo named for this Model → no combo
        const match = pickComboMatch(
          { baseModel: '', modules: members.map((m) => splitSofaCode(m.item_code).sizeCode), customerId: null, tier, height },
          pool,
        );
        if (!match) continue;
        const matched = match.matchedIndices.map((i) => members[i]).filter((m): m is Row => !!m);
        if (matched.length === 0) continue;
        /* Audit 2026-06-11 I1 — the combo price is ONE set; line_cost_centi is
           a LINE total (unit × qty). Owner rule: combo cost MUST multiply by
           qty. Uniform qty q across the matched lines → q sets → comboTotal×q.
           Mixed qtys → no clean set count → SKIP the combo and keep the
           per-module costs (never under-book). */
        const qtySet = new Set(matched.map((m) => Math.max(1, m.qty || 1)));
        if (qtySet.size !== 1) continue;
        const uniformQty = [...qtySet][0]!;
        const comboTotal = match.comboPriceCenti * uniformQty;
        if (comboTotal <= 0) continue;
        const spread = spreadComboTotal(matched.map((m) => m.line_cost_centi || 0), comboTotal);
        for (let i = 0; i < matched.length; i++) {
          const m = matched[i]!; const newLineCost = spread[i] ?? 0; const q = Math.max(1, m.qty || 1);
          m.line_cost_centi = newLineCost; // mutate in place so the rollup below sees it
          await sb.from('mfg_sales_order_items').update({
            line_cost_centi:   newLineCost,
            unit_cost_centi:   Math.round(newLineCost / q),
            line_margin_centi: (m.total_centi || 0) - newLineCost,
          }).eq('id', m.id);
        }
      }
    }
  }

  let mattressSofa = 0, bedframe = 0, accessories = 0, others = 0, service = 0, total = 0, totalCost = 0;
  // Task #114 — per-category cost mirrors the revenue accumulators. Each
  // bucket below tracks both revenue (total_centi) and cost (line_cost_centi)
  // so the SO header's cost columns (migration 0079 + 0155) stay in sync
  // with the revenue columns.
  let mattressSofaCost = 0, bedframeCost = 0, accessoriesCost = 0, othersCost = 0, serviceCost = 0;
  for (const it of rows) {
    const lineTotal = it.total_centi || 0;
    const lineCost  = it.line_cost_centi || 0;
    total += lineTotal;
    totalCost += lineCost;
    const g = (it.item_group ?? '').toLowerCase();
    /* SO-SKU spec P2 (D1) — SERVICE lines get their own bucket; checked
       FIRST so a service line can never leak into the goods buckets. */
    if (isServiceLine({ itemGroup: g, itemCode: it.item_code })) {
      service += lineTotal;
      serviceCost += lineCost;
    } else if (g.includes('mattress') || g.includes('sofa')) {
      mattressSofa += lineTotal;
      mattressSofaCost += lineCost;
    } else if (g.includes('bedframe')) {
      bedframe += lineTotal;
      bedframeCost += lineCost;
    } else if (g.includes('accessor')) {
      accessories += lineTotal;
      accessoriesCost += lineCost;
    } else {
      others += lineTotal;
      othersCost += lineCost;
    }
  }
  // Delivery fee (migration 0133) — header-only on legacy SOs, so the lines-
  // only roll-up would erase it there. P2 transition rule: the SVC-DELIVERY*
  // LINES are the truth when they exist (their amounts are already inside
  // `service`/`total` above — folding the header snapshot back in would
  // double-count); only a line-less legacy SO still reads the header back.
  // ⚠️ DO NOT DELETE this fallback without retiring the delivery_fee_centi
  // header column itself (SO-SKU spec §5 P6 — Loo decides the retirement).
  const hasDeliveryFeeLines = rows.some((r) => isDeliveryFeeServiceCode(r.item_code));
  let deliveryCenti = 0;
  if (!hasDeliveryFeeLines) {
    const { data: hdrFee } = await sb
      .from('mfg_sales_orders')
      .select('delivery_fee_centi')
      .eq('doc_no', docNo)
      .maybeSingle();
    deliveryCenti = Number((hdrFee as { delivery_fee_centi?: number } | null)?.delivery_fee_centi ?? 0);
  }
  const grandTotal  = total + deliveryCenti;
  const grandMargin = grandTotal - totalCost;
  await sb.from('mfg_sales_orders').update({
    mattress_sofa_centi: mattressSofa,
    bedframe_centi: bedframe,
    accessories_centi: accessories,
    others_centi: others,
    /* SO-SKU spec P2 (D1, migration 0155). */
    service_centi: service,
    service_cost_centi: serviceCost,
    // Task #114 — per-category cost (migration 0079).
    mattress_sofa_cost_centi: mattressSofaCost,
    bedframe_cost_centi:      bedframeCost,
    accessories_cost_centi:   accessoriesCost,
    others_cost_centi:        othersCost,
    local_total_centi: grandTotal,
    balance_centi: grandTotal,
    total_cost_centi: totalCost,
    total_revenue_centi: grandTotal,
    total_margin_centi: grandMargin,
    margin_pct_basis: grandTotal > 0 ? Math.round((grandMargin / grandTotal) * 10000) : 0,
    line_count: (items ?? []).length,
    updated_at: new Date().toISOString(),
  }).eq('doc_no', docNo);
}

mfgSalesOrders.post('/:docNo/items', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo'); const user = c.get('user');
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (!it.itemCode) return c.json({ error: 'item_code_required' }, 400);

  /* Edge #4 — itemCode catalog guard. */
  {
    const codeCheck = await validateItemCodes(sb, [it.itemCode as string]);
    if (!codeCheck.ok) return c.json(unknownItemCodeResponse(codeCheck.unknown), 409);
  }

  /* Tier 2 downstream-lock — line-add is blocked once a DO / SI exists. */
  const childLock = await soHasDownstream(sb, docNo);
  if (childLock) return c.json(childLock, 409);

  /* TBC fill-in (Loo 2026-06-11) — self-scoped selling roles only touch
     their own SO. */
  if (await selfScopedSalesBlocked(sb, user.id, docNo)) return c.json({ error: 'not_found' }, 404);

  /* Composition guard (Loo 2026-06-11) — the create-path MAIN-mix rule
     (sofa never shares a bill with bedframe / mattress, PR #519) now also
     holds when a line is ADDED later. Only a change that INTRODUCES the
     violation is rejected — a pre-rule SO that already mixes is left
     editable (grandfathered). */
  {
    const introduced = await soMainMixIntroduced(sb, docNo, null, it.itemCode as string);
    if (introduced) {
      return c.json({
        error: 'so_sofa_no_other_main',
        reason: 'A sofa cannot share a Sales Order with a bedframe or mattress.',
      }, 400);
    }
  }

  /* PR-E — pull customer_delivery_date alongside debtor/agent/venue so a
     line added later still inherits the SO header's delivery date by
     default. Client can override by sending lineDeliveryDate explicitly. */
  const { data: header } = await sb.from('mfg_sales_orders').select('debtor_code, debtor_name, agent, branding, venue, customer_delivery_date, customer_state, internal_expected_dd, processing_date, proceeded_at, customer_id').eq('doc_no', docNo).maybeSingle();
  if (!header) return c.json({ error: 'not_found' }, 404);
  /* Owner 2026-06-12 — processing-date lock: no line ADD once the SO is
     proceeded AND the processing day has passed (already PO'd to the supplier). */
  if (soProcessingLocked(header as { internal_expected_dd?: string | null; processing_date?: string | null; proceeded_at?: string | null })) {
    return c.json(SO_PROCESSING_LOCKED_RESPONSE, 409);
  }
  /* Commander 2026-05-31 — a line added later inherits the SO state's warehouse
     by default (migration 0118). Explicit it.warehouseId override wins. */
  const addLineWarehouseId = (it.warehouseId as string | null | undefined)
    ?? await deriveWarehouseIdFromState(sb, (header.customer_state as string | null) ?? null);

  /* POS line quantity (Loo 2026-06-12) — same 422 gate as POST / (review
     found the create-only gate left qty 0 free-line inserts open here). */
  const badQty = invalidQtyResponse(it.qty, it.itemCode);
  if (badQty) return c.json(badQty, 422);
  const qty = Number(it.qty ?? 1);
  const discount = Number(it.discountCenti ?? 0);
  // MFG-PRICING-ENGINE — Recompute unit price server-side. Same path as
  // POST /. Drift > 0.5% returns HTTP 400 with the breakdown so the UI can
  // show what went wrong.
  const itemCodeStr = String(it.itemCode ?? '');
  const variantsObj = (it.variants as MfgItemForRecompute['variants']) ?? null;
  /* PR #216 — allowed_options check on add-item. Same shape as POST /. */
  {
    const { product, model } = await loadProductAndModel(sb, itemCodeStr);
    const aoErr = checkAllowedOptions(
      product,
      model,
      variantsObj as Parameters<typeof checkAllowedOptions>[2],
    );
    if (aoErr) return c.json({ ...aoErr, itemCode: itemCodeStr }, 400);
  }
  const [cachedConfig, productLite, fabricLite, sofaCombosLite, sellingTiersLite, fabricAddonConfigLite, specialAddonsLite, modelOverridesLite, compartmentOverridesLite] = await Promise.all([
    loadMaintenanceConfig(sb),
    loadProductByCode(sb, itemCodeStr),
    loadFabricByCode(sb, variantsObj?.fabricCode ?? null),
    loadActiveSofaCombos(sb),
    loadFabricSellingTiers(sb, (variantsObj as { fabricId?: string } | null)?.fabricId ?? null),
    loadFabricTierAddonConfig(sb),
    loadSpecialAddons(sb),
    loadModelFabricTierOverrides(sb),
    loadCompartmentFabricTierOverrides(sb),
  ]);
  // SOFA-SELLING-PLAN — per-Model module SELLING prices for the sofa drift gate.
  // Audit 2026-06-11 C2 — module COST rows so a build's cost = Σ module costs.
  const [sofaModulePricesLite, sofaModuleCostRowsLite] = productLite?.category === 'SOFA'
    ? await Promise.all([
        loadModelSofaModulePrices(
          sb,
          productLite.base_model,
          String((variantsObj as { depth?: unknown } | null)?.depth ?? '24'),
        ),
        loadModelSofaModuleCostRows(sb, productLite.base_model),
      ])
    : [null, null];
  /* Free Item Campaign (add-line path, Task 4) — body field `freeItemCampaignId`
     opts a single added line into server-validated forced-RM0. Mutually exclusive
     with PWP (both cannot apply to the same line). Check mutual exclusion BEFORE
     the PWP claim so we never burn a code and then reject. */
  const addLineFreeItemCampaignId = String((it.freeItemCampaignId as string | null | undefined) ?? '').trim();
  const addLinePwpCodeEarly = String((variantsObj as { pwpCode?: string | null } | null)?.pwpCode ?? '').trim();
  if (addLineFreeItemCampaignId && addLinePwpCodeEarly) {
    return c.json({ error: 'free_and_pwp_exclusive', reason: 'A line cannot be both a free-item and a PWP reward.' }, 400);
  }
  // Resolved after validation below — { campaignId, campaignName } or null.
  let addLineFreeItem: { campaignId: string; campaignName: string } | null = null;

  /* PWP claim (add-line path) — mirrors the create-path loop for ONE code.
     If the client sends variants.pwpCode we attempt to claim the voucher now,
     BEFORE recompute so the PWP base feeds the drift gate correctly.
     On rejection we return 409 (same shape as create). On success we carry
     `addLinePwpClaimed` for rollback on a subsequent insert failure. */
  let addLinePwpBaseSen: number | null = null;
  let addLinePwpSofaComboIds: string[] | null = null;
  let addLinePwpClaimed: { code: string; prevStatus: string } | null = null;
  const addLinePwpCode = String((variantsObj as { pwpCode?: string | null } | null)?.pwpCode ?? '').trim();
  if (addLinePwpCode) {
    /* PWP reward qty lock (Loo 2026-06-12) — a reward line must be exactly 1
       unit; the claim helper enforces this too, but a fast 422 mirrors the
       create-path pattern so the error shape is consistent. */
    if (qty !== 1) {
      return c.json({
        error: 'invalid_qty',
        reason: 'A PWP reward line must have quantity 1.',
        itemCode: itemCodeStr,
        qty,
      }, 422);
    }
    const pwpClaimResult = await claimPwpForSingleLine(sb, {
      code: addLinePwpCode,
      docNo,
      itemCode: productLite?.code ?? itemCodeStr,  // resolved catalog SKU — matches create audit
      product: {
        category:      productLite?.category ?? '',
        model_id:      productLite?.model_id ?? null,
        base_model:    productLite?.base_model ?? null,
        pwp_price_sen: productLite?.pwp_price_sen ?? null,
      },
      customerId:    (header.customer_id as string | null) ?? null,
      ownerStaffId:  user.id,
      qty,
      variants:      variantsObj as Record<string, unknown> | null,
    });
    if (pwpClaimResult.rejection) {
      return c.json({
        error:  'pwp_code_rejected',
        code:   pwpClaimResult.rejection.code,
        reason: pwpClaimResult.rejection.reason,
      }, 409);
    }
    addLinePwpBaseSen      = pwpClaimResult.pwpBaseSen;
    addLinePwpSofaComboIds = pwpClaimResult.pwpSofaComboIds;
    addLinePwpClaimed      = pwpClaimResult.claimed;
  }

  /* Free Item Campaign validation (Task 4) — if freeItemCampaignId was supplied,
     verify it against active campaigns + the line's model/category/build before
     persisting anything. Mirrors the create-path block (~2111-2159). */
  if (addLineFreeItemCampaignId) {
    const addLineActiveCampaigns = await loadActiveFreeItemCampaigns(sb);
    const addLineComboModulesById = new Map<string, string[][]>(
      sofaCombosLite.map((cb) => [cb.id, cb.modules]),
    );
    const addLineCells = (variantsObj as { cells?: Array<{ moduleId?: unknown }> } | null)?.cells ?? [];
    const addLineBuiltModuleIds = Array.isArray(addLineCells)
      ? addLineCells.map((cl) => String(cl?.moduleId ?? '')).filter(Boolean)
      : [];
    const addLineCovering = campaignsCoveringLine(
      {
        category:       String(productLite?.category ?? ''),
        modelId:        productLite?.model_id ?? null,
        builtModuleIds: addLineBuiltModuleIds,
      },
      addLineActiveCampaigns,
      addLineComboModulesById,
    );
    const addLineChosen = addLineCovering.find((camp) => camp.id === addLineFreeItemCampaignId);
    if (!addLineChosen) {
      if (addLinePwpClaimed) await rollbackSinglePwpClaim(sb, addLinePwpClaimed);
      return c.json({ error: 'free_item_not_eligible', reason: 'not_eligible' }, 409);
    }
    if (qty > addLineChosen.maxFreeQty) {
      if (addLinePwpClaimed) await rollbackSinglePwpClaim(sb, addLinePwpClaimed);
      return c.json({ error: 'free_item_not_eligible', reason: 'over_cap' }, 409);
    }
    // Resolved: stamp the server-resolved name so the UI never depends on a client string.
    addLineFreeItem = { campaignId: addLineChosen.id, campaignName: addLineChosen.name };
  }

  const recomputed = recomputeFromSnapshot(
    {
      itemCode:       itemCodeStr,
      itemGroup:      String(it.itemGroup ?? 'others'),
      qty,
      unitPriceCenti: Number(it.unitPriceCenti ?? 0),
      variants:       variantsObj,
    },
    productLite,
    fabricLite,
    cachedConfig,
    sofaCombosLite,
    sofaModulePricesLite,
    sellingTiersLite,
    fabricAddonConfigLite,
    addLinePwpBaseSen,       // pwpBaseSen — claimed above, or null for non-PWP lines
    addLinePwpSofaComboIds,  // pwpSofaComboIds — claimed above, or null
    specialAddonsLite,
    sofaModuleCostRowsLite,
    modelOverridesLite,      // migration 0172 — per-Model Δ
    compartmentOverridesLite, // migration 0025 — per-compartment Δ
  );
  /* Pricing trust boundary (Owner 2026-05-31, see isPosTabletCaller). POS tablet
     roles are drift-rejected + take the server price; Backend / office authors
     set the selling price freely.
     Free Item Campaign (Task 4) — drift check is SKIPPED for a validated free
     line (unit will be forced to 0 below; client always submits 0, so there is
     no meaningful drift to gate on — and the cap check already enforced qty). */
  const posTablet = await isPosTabletCaller(sb, user.id);
  if (posTablet && recomputed.drift && !addLineFreeItem) {
    /* Rollback any PWP claim before rejecting — must not burn a code on drift. */
    if (addLinePwpClaimed) await rollbackSinglePwpClaim(sb, addLinePwpClaimed);
    return c.json({
      error:    'pricing_drift',
      reason:   'Client unitPriceCenti differs >0.5% from server compute.',
      itemCode: itemCodeStr,
      client:   Number(it.unitPriceCenti ?? 0),
      server:   recomputed.unit_price_sen,
      breakdown: recomputed.breakdown,
    }, 400);
  }
  /* Carry the bound price-list figure out (costing-only Backend sends no real
     selling price). POS drift rejects above; Backend drift saves silently.
     Free Item Campaign (Task 4) — forced to 0 when validated above. */
  const unit = addLineFreeItem ? 0 : recomputed.unit_price_sen;
  /* Audit 2026-06-11 C-2 — same discount gate as POST /: client-authored
     discount must sit in [0, qty × unit] (422, reject-don't-normalize). */
  if (!Number.isFinite(discount) || discount < 0 || discount > qty * unit) {
    /* Rollback any PWP claim before rejecting — must not burn a code on invalid discount. */
    if (addLinePwpClaimed) await rollbackSinglePwpClaim(sb, addLinePwpClaimed);
    return c.json({
      error:    'invalid_discount',
      reason:   'discountCenti must be between 0 and qty × unit price.',
      itemCode: itemCodeStr,
      discount,
      max:      qty * unit,
    }, 422);
  }
  const lineTotal = (qty * unit) - discount;
  // Commander 2026-05-28 — server-computed cost (base + Σ backend priceSen
  // surcharges) wins. Fall back to mfg_products.cost_price_sen / explicit
  // client cost only when the recompute produced no cost.
  const unitCost = recomputed.unit_cost_sen > 0
    ? recomputed.unit_cost_sen
    : await snapshotUnitCostSen(sb, itemCodeStr, Number(it.unitCostCenti ?? 0));
  const lineCost = unitCost * qty;
  /* PR-E — same inheritance rule as POST /. Explicit per-line value wins
     (and flips overridden=true unless the client says otherwise);
     otherwise fall back to header.customer_delivery_date with
     overridden=false so the line tracks future header changes. */
  const hasExplicitLineDate = it.lineDeliveryDate !== undefined && it.lineDeliveryDate !== null;
  const lineDeliveryDate = hasExplicitLineDate
    ? (it.lineDeliveryDate as string | null)
    : (header.customer_delivery_date as string | null) ?? null;
  const lineDeliveryDateOverridden = hasExplicitLineDate
    ? (it.lineDeliveryDateOverridden === undefined ? true : Boolean(it.lineDeliveryDateOverridden))
    : Boolean(it.lineDeliveryDateOverridden ?? false);
  /* 0165 — continue the doc's line numbering; a pre-0165 doc (max NULL)
     stays un-numbered so its lines keep one consistent ordering regime. */
  const { data: maxNoRow } = await sb
    .from('mfg_sales_order_items')
    .select('line_no')
    .eq('doc_no', docNo)
    .order('line_no', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  const nextLineNo = typeof (maxNoRow as { line_no?: number | null } | null)?.line_no === 'number'
    ? (maxNoRow as { line_no: number }).line_no + 1
    : null;
  /* Shared base fields — used for both the single-row non-sofa path and as the
     template for each sofa module row (create-path convention: baseRow). */
  const baseRow = {
    doc_no: docNo,
    line_date: (it.lineDate as string) ?? todayMyt(),
    debtor_code: header.debtor_code,
    debtor_name: header.debtor_name,
    agent: header.agent,
    item_group: it.itemGroup ?? 'others',
    item_code: it.itemCode,
    description: (it.description as string) ?? null,
    uom: (it.uom as string) ?? 'UNIT',
    qty,
    unit_price_centi: unit,
    discount_centi: discount,
    total_centi: lineTotal,
    total_inc_centi: lineTotal,
    balance_centi: lineTotal,
    venue: header.venue,
    branding: header.branding,
    /* Anti-tamper (Task 6) — strip any client-supplied freeItem marker from a
       line added via the SO-edit path. The freeItem marker is ONLY stamped by
       the server after campaign validation — never trusted from the client.
       Task 4: if freeItemCampaignId was validated above, re-stamp the server-
       resolved marker (campaignId + campaignName) after stripping. This is the
       same pattern as the create path (strip then re-add validated marker). */
    /* Variants-vocabulary unification (port of 2990 73aeeb1e) — canonicalize at
       the LAST step before the DB write. Every depth-keyed read (recompute,
       split, fabricCode/fabricId/pwpCode loads) above ran on the raw
       variantsObj/it.variants, so dropping POS aliases here is safe; the
       persisted single-row line stores seatHeight/legHeight/fabricCode. */
    variants: canonicalizeVariants(
      String(it.itemGroup ?? ''),
      addLineFreeItem
        ? { ...(stripFreeItem(it.variants) as Record<string, unknown> | null ?? {}), freeItem: addLineFreeItem }
        : ((stripFreeItem(it.variants) as Record<string, unknown> | null) ?? null),
    ),
    unit_cost_centi: unitCost,
    line_cost_centi: lineCost,
    line_margin_centi: lineTotal - lineCost,
    // MFG-PRICING-ENGINE — Persist breakdown columns (same as POST /).
    divan_price_sen:         recomputed.divan_price_sen,
    leg_price_sen:           recomputed.leg_price_sen,
    special_order_price_sen: recomputed.special_order_sen,
    custom_specials:         recomputed.custom_specials ?? null,
    line_delivery_date: lineDeliveryDate,
    line_delivery_date_overridden: lineDeliveryDateOverridden,
    warehouse_id: addLineWarehouseId,
    /* SO-SKU spec P2 — a hand-added SERVICE line (Backend SoLineCard picks a
       SVC SKU → itemGroup 'service') is not goods: allocation skips it (P1),
       so it must start READY or its PENDING badge would never clear. */
    ...(isServiceLine({ itemGroup: String(it.itemGroup ?? ''), itemCode: itemCodeStr })
      ? { stock_status: 'READY' }
      : {}),
  };

  /* SO-SKU spec P3 (add-line mirror) — a sofa BUILD added to a placed SO is
     split into per-compartment module rows, exactly like the create path
     (~2456-2559). The money is already settled above: `unit` is the
     authoritative per-build selling price and the drift gate already passed.
     Splitting only decomposes it — each module gets its price share, residue
     on the last, Σ totals === build total. Non-splittable lines (no cells /
     unknown base model) keep the single-row insert below. */
  const addLineCells = (it.variants as { cells?: unknown } | null)?.cells;
  if (
    productLite?.category === 'SOFA' &&
    Array.isArray(addLineCells) && addLineCells.length > 0 &&
    productLite.base_model
  ) {
    if (!sofaModulePricesLite && productLite.base_model) {
      // Catalog gap — split degrades to equal-price weights. Surface so ops
      // can fix the Model's module SKU prices.
      // eslint-disable-next-line no-console
      console.warn(`[so-add-line] no module prices for ${productLite.base_model} — sofa split uses equal weights`);
    }
    // add-line has no extra-charge path, so always proportional split (no evenSplitPrice).
    const split = splitSofaBuildIntoModuleLines({
      baseModel: productLite.base_model,
      cells: addLineCells,
      buildUnitPriceSen: unit,
      buildUnitCostSen: unitCost,
      modulePrices: sofaModulePricesLite,
      depth: String((it.variants as { depth?: unknown } | null)?.depth ?? '24'),
    });
    if (split && split.length > 0) {
      const buildKey = `build-add-${nextLineNo ?? crypto.randomUUID().slice(0, 8)}`;
      /* Variants-vocabulary unification (port of 2990 73aeeb1e) — canonicalize
         BEFORE deriving the split's shared variants so each module row stores
         seatHeight/legHeight/fabricCode. Safe: the split's depth read above
         ran on the raw it.variants. */
      const { cells: _cells, freeItem: _clientFreeItem, ...sharedVariants } =
        canonicalizeVariants('sofa', (it.variants as Record<string, unknown> | null) ?? {});
      const moduleRows = split.map((s, i) => {
        const moduleVariants: Record<string, unknown> = {
          ...sharedVariants,
          buildKey,
          cellIndex: s.cellIndex,
          x: s.x,
          y: s.y,
          rot: s.rot,
          /* Task 4 — stamp server-validated freeItem on every module row so the
             grandfather guard (isFreeItemLine) sees the marker on each piece of
             the split build, exactly mirroring the create-path behaviour. */
          ...(addLineFreeItem ? { freeItem: addLineFreeItem } : {}),
        };
        const moduleLineTotal = (qty * s.unitPriceSen) - (i === 0 ? discount : 0);
        const moduleLineCost = qty * s.unitCostSen;
        return {
          ...baseRow,
          /* line_no: first module gets nextLineNo (same as single-row), each
             subsequent module increments. Pre-0165 docs (nextLineNo === null)
             stay un-numbered consistent with the rest of the SO. */
          ...(nextLineNo !== null ? { line_no: nextLineNo + i } : {}),
          item_code: s.itemCode,
          description: s.description,
          description2: buildVariantSummary('sofa', moduleVariants) || null,
          unit_price_centi: s.unitPriceSen,
          discount_centi: i === 0 ? discount : 0,
          total_centi: moduleLineTotal,
          total_inc_centi: moduleLineTotal,
          balance_centi: moduleLineTotal,
          variants: moduleVariants,
          unit_cost_centi: s.unitCostSen,
          line_cost_centi: moduleLineCost,
          line_margin_centi: moduleLineTotal - moduleLineCost,
          /* Breakdown columns (divan/leg/special) on first row only; custom_specials + remark on every row (display, same as create). */
          divan_price_sen:         i === 0 ? (recomputed.divan_price_sen ?? 0) : 0,
          leg_price_sen:           i === 0 ? (recomputed.leg_price_sen ?? 0) : 0,
          special_order_price_sen: i === 0 ? (recomputed.special_order_sen ?? 0) : 0,
          custom_specials:         recomputed.custom_specials ?? null,
          remark: typeof sharedVariants.remark === 'string' && (sharedVariants.remark as string).trim() !== ''
            ? (sharedVariants.remark as string).trim()
            : null,
        };
      });
      const { data: moduleData, error: moduleError } = await sb
        .from('mfg_sales_order_items')
        .insert(moduleRows)
        .select('*');
      if (moduleError) {
        /* Don't burn a PWP code on a failed insert — mirror create's rollbackPwpClaims. */
        if (addLinePwpClaimed) await rollbackSinglePwpClaim(sb, addLinePwpClaimed);
        return c.json({ error: 'insert_failed', reason: moduleError.message }, 500);
      }
      const firstRow = (moduleData ?? [])[0] ?? moduleRows[0];

      // Default Free Gift — adding a sofa trigger may grant a gift.
      await reconcileFreeGiftLinesForSo(sb, docNo);
      // Re-derive the delivery fee — a new sofa can introduce a cross-category
      // mix or a special-delivery trigger. Stored cross-category source kept.
      await rederiveDeliveryFee(sb, docNo);

      await recordSoAudit(sb, {
        docNo,
        action: 'ADD_LINE',
        actorId: user.id,
        actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
        fieldChanges: [
          { field: 'itemCode', to: String(firstRow.item_code ?? itemCodeStr) },
          { field: 'qty', to: qty },
          { field: 'unitPriceCenti', to: unit },
          { field: 'totalCenti', to: lineTotal },
        ],
      });

      try { await recomputeSoStockAllocation(sb); }
      catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-allocation] post-line-add failed:', e); }

      return c.json({ item: firstRow }, 201);
    }
  }

  /* Non-sofa (or non-splittable sofa) — single-row insert, original path. */
  const row = {
    ...baseRow,
    ...(nextLineNo !== null ? { line_no: nextLineNo } : {}),
    /* Commander 2026-05-28 — "Description 2" auto-generated from variants. */
    description2: buildVariantSummary(String(it.itemGroup ?? ''), (it.variants as Record<string, unknown> | null) ?? null) || null,
  };
  const { data, error } = await sb.from('mfg_sales_order_items').insert(row).select('*').single();
  if (error) {
    /* Don't burn a PWP code on a failed insert — mirror create's rollbackPwpClaims. */
    if (addLinePwpClaimed) await rollbackSinglePwpClaim(sb, addLinePwpClaimed);
    return c.json({ error: 'insert_failed', reason: error.message }, 500);
  }
  // Default Free Gift (0170) — adding a trigger line may grant a new accessory
  // gift; reconcile auto-inserts/deletes gift lines, then recomputes totals.
  await reconcileFreeGiftLinesForSo(sb, docNo);
  // Re-derive the delivery fee — a new goods line can introduce a cross-category
  // mix or a special-delivery trigger. Stored cross-category source kept.
  await rederiveDeliveryFee(sb, docNo);

  // PR-D — emit ADD_LINE audit row. Capture item code + qty + unit price
  // so the timeline shows the meaningful what-was-added without an explosion
  // of every column.
  await recordSoAudit(sb, {
    docNo,
    action: 'ADD_LINE',
    actorId: user.id,
    actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
    fieldChanges: [
      { field: 'itemCode', to: row.item_code },
      { field: 'qty', to: row.qty },
      { field: 'unitPriceCenti', to: row.unit_price_centi },
      { field: 'totalCenti', to: row.total_centi },
    ],
  });

  /* New line = new demand → recompute may flip this SO into READY (or
     bump another SO out). Best-effort. */
  try { await recomputeSoStockAllocation(sb); }
  catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-allocation] post-line-add failed:', e); }

  return c.json({ item: data }, 201);
});

mfgSalesOrders.patch('/:docNo/items/:itemId', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo'); const itemId = c.req.param('itemId'); const user = c.get('user');
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }

  /* Edge #4 — itemCode catalog guard (only when caller is changing it). */
  if (it.itemCode !== undefined) {
    const codeCheck = await validateItemCodes(sb, [it.itemCode as string]);
    if (!codeCheck.ok) return c.json(unknownItemCodeResponse(codeCheck.unknown), 409);
  }

  /* Tier 2 downstream-lock — line-edit is blocked once a DO / SI exists. */
  const childLock = await soHasDownstream(sb, docNo);
  if (childLock) return c.json(childLock, 409);

  /* TBC fill-in (Loo 2026-06-11) — self-scoped selling roles only touch
     their own SO. */
  if (await selfScopedSalesBlocked(sb, user.id, docNo)) return c.json({ error: 'not_found' }, 404);

  /* Owner 2026-06-12 — processing-date lock: no line EDIT once the processing
     day has passed (the locked order is already PO'd to the supplier). */
  {
    const procLock = await soProcessingLockBlocked(sb, docNo);
    if (procLock) return c.json(procLock, 409);
  }

  /* Composition guard (Loo 2026-06-11) — a product swap must not INTRODUCE a
     sofa × (bedframe | mattress) mix (PR #519 create rule, now on swap too). */
  if (it.itemCode !== undefined) {
    const introduced = await soMainMixIntroduced(sb, docNo, itemId, it.itemCode as string);
    if (introduced) {
      return c.json({
        error: 'so_sofa_no_other_main',
        reason: 'A sofa cannot share a Sales Order with a bedframe or mattress.',
      }, 400);
    }
  }

  /* Pricing trust boundary (Owner 2026-05-31, see isPosTabletCaller). */
  const posTablet = await isPosTabletCaller(sb, user.id);

  // Re-derive totals if qty/price/discount changed. PR-D — also pull the
  // human-facing columns (item_code, description, uom) for the audit diff.
  const { data: prev } = await sb.from('mfg_sales_order_items')
    .select('qty, unit_price_centi, discount_centi, unit_cost_centi, item_code, item_group, description, description2, uom, variants, remark, cancelled')
    .eq('id', itemId).maybeSingle();
  if (!prev) return c.json({ error: 'not_found' }, 404);
  /* POS line quantity (Loo 2026-06-12) — same 422 gate as POST /. */
  const badQty = invalidQtyResponse(it.qty, prev.item_code);
  if (badQty) return c.json(badQty, 422);
  const qty = it.qty !== undefined ? Number(it.qty) : prev.qty;
  /* One code = one redemption = ONE unit (Loo 2026-06-12) — mirror of the
     create-path claim-loop gate. A qty-only PATCH skips the recompute, so a
     reward line bumped to qty N would book N units at the stored PWP grant
     price off a single voucher (review blocker 2026-06-12). */
  const prevPwp = (prev.variants ?? null) as { pwp?: boolean; pwpCode?: string | null } | null;
  const prevIsReward = prevPwp?.pwp === true ||
    (typeof prevPwp?.pwpCode === 'string' && prevPwp.pwpCode.trim() !== '');
  if (prevIsReward && qty !== 1) {
    return c.json({
      error:  'pwp_reward_qty_locked',
      reason: 'A PWP reward line redeems one unit per code — quantity stays 1.',
    }, 422);
  }
  const clientUnit = it.unitPriceCenti !== undefined ? Number(it.unitPriceCenti) : prev.unit_price_centi;
  const discount = it.discountCenti !== undefined ? Number(it.discountCenti) : prev.discount_centi;

  /* MFG-PRICING-ENGINE — Server-side recompute on PATCH. Triggered when
     the caller touches variants OR unitPriceCenti (qty alone doesn't move
     the unit price). For variant-driven edits we use the merged item shape
     (prev + patch) so omitted variants stay sticky. The manual-override
     audit path (POST /:docNo/items/:itemId/override → mfg_so_price_overrides)
     is unaffected — it routes around this PATCH entirely. */
  let recomputedPatch: RecomputedLine | null = null;
  const variantsAfter = it.variants !== undefined
    ? (it.variants as MfgItemForRecompute['variants'])
    : ((prev as { variants?: MfgItemForRecompute['variants'] }).variants ?? null);
  const itemCodeAfter = it.itemCode !== undefined ? String(it.itemCode) : prev.item_code;
  const itemGroupAfter = it.itemGroup !== undefined ? String(it.itemGroup) : prev.item_group;

  /* Did the caller actually CHANGE the priced shape of this line? Loo 2026-06-28:
     the Backend SO Detail Save re-commits EVERY line, even untouched ones, so an
     unrelated header / customer / demographics edit re-sends a line verbatim. We
     must NOT re-validate or re-price a line whose itemCode + variants + price the
     caller left identical — the Model's allowed_options can drift after the SO is
     placed (a changed pool, or a stored value with a curly inch-mark "12“" while
     the pool now lists the straight "12\"") and would wrongly reject (or silently
     re-price) a line the user never touched. canonJson is key-order-independent
     because Postgres jsonb reorders object keys, so a naive JSON.stringify of the
     stored blob vs the incoming one would false-positive "changed". */
  const canonJson = (o: unknown): string => {
    if (o == null) return 'null';
    if (typeof o !== 'object') return JSON.stringify(o);
    if (Array.isArray(o)) return '[' + o.map(canonJson).join(',') + ']';
    return '{' + Object.keys(o as Record<string, unknown>).sort()
      .map((k) => JSON.stringify(k) + ':' + canonJson((o as Record<string, unknown>)[k]))
      .join(',') + '}';
  };
  const variantsChanged = it.variants !== undefined
    && canonJson(variantsAfter ?? null) !== canonJson((prev as { variants?: unknown }).variants ?? null);
  const itemCodeChangedOnPatch = it.itemCode !== undefined && String(it.itemCode) !== prev.item_code;
  const priceChanged = it.unitPriceCenti !== undefined && Number(it.unitPriceCenti) !== prev.unit_price_centi;
  const shouldRecompute = variantsChanged || itemCodeChangedOnPatch || priceChanged;

  /* PR #216 — allowed_options check on PATCH. Only when the caller actually
     CHANGES variants or the item code (see above) — a genuine edit picks from
     the CURRENT pool so it still validates; an untouched line is grandfathered. */
  if (variantsChanged || itemCodeChangedOnPatch) {
    const { product, model } = await loadProductAndModel(sb, itemCodeAfter);
    const aoErr = checkAllowedOptions(
      product,
      model,
      variantsAfter as Parameters<typeof checkAllowedOptions>[2],
    );
    if (aoErr) return c.json({ ...aoErr, itemCode: itemCodeAfter }, 400);
  }
  if (shouldRecompute && itemCodeAfter) {
    const [cfg, prodLite, fabLite, sofaCombosPatch, sellingTiersPatch, fabricAddonConfigPatch, specialAddonsPatch, modelOverridesPatch, compartmentOverridesPatch] = await Promise.all([
      loadMaintenanceConfig(sb),
      loadProductByCode(sb, itemCodeAfter),
      loadFabricByCode(sb, variantsAfter?.fabricCode ?? null),
      loadActiveSofaCombos(sb),
      loadFabricSellingTiers(sb, (variantsAfter as { fabricId?: string } | null)?.fabricId ?? null),
      loadFabricTierAddonConfig(sb),
      loadSpecialAddons(sb),
      loadModelFabricTierOverrides(sb),
      loadCompartmentFabricTierOverrides(sb),
    ]);
    // SOFA-SELLING-PLAN — per-Model module SELLING prices for the sofa drift gate.
    // Audit 2026-06-11 C2 — module COST rows so a build's cost = Σ module costs.
    const [sofaModulePricesPatch, sofaModuleCostRowsPatch] = prodLite?.category === 'SOFA'
      ? await Promise.all([
          loadModelSofaModulePrices(
            sb,
            prodLite.base_model,
            String((variantsAfter as { depth?: unknown } | null)?.depth ?? '24'),
          ),
          loadModelSofaModuleCostRows(sb, prodLite.base_model),
        ])
      : [null, null];
    recomputedPatch = recomputeFromSnapshot(
      {
        itemCode:       itemCodeAfter,
        itemGroup:      itemGroupAfter,
        qty,
        unitPriceCenti: clientUnit,
        variants:       variantsAfter,
      },
      prodLite,
      fabLite,
      cfg,
      sofaCombosPatch,
      sofaModulePricesPatch,
      sellingTiersPatch,
      fabricAddonConfigPatch,
      null,                // pwpBaseSen
      null,                // pwpSofaComboIds
      specialAddonsPatch,
      sofaModuleCostRowsPatch,
      modelOverridesPatch, // migration 0172 — per-Model Δ
      compartmentOverridesPatch, // migration 0025 — per-compartment Δ
    );
    /* Task 6 — grandfathering: a line already carrying variants.freeItem was
       made free at create time and must STAY at RM 0 on edit recompute, even
       if the campaign has since been toggled off. Skip the drift check too —
       the client always sends 0 for a free-item line so there is no drift to
       gate against. */
    /* PWP reward lines are grandfathered too (Loo 2026-06-28). The grant price
       was locked when the voucher was claimed; the edit path passes no
       pwpBaseSen, so recompute returns FULL RETAIL — comparing the stored grant
       price against it always "drifts". Skip the gate for a reward line exactly
       like a free-item line; the unit below is forced back to the stored grant. */
    if (!isFreeItemLine(prev.variants) && !prevIsReward && posTablet && recomputedPatch.drift) {
      return c.json({
        error:    'pricing_drift',
        reason:   'Client unitPriceCenti differs >0.5% from server compute.',
        itemCode: itemCodeAfter,
        client:   clientUnit,
        server:   recomputedPatch.unit_price_sen,
        breakdown: recomputedPatch.breakdown,
      }, 400);
    }
  }
  /* Carry the bound price-list figure out when a recompute ran (costing-only
     Backend sends no real selling price). POS drift rejects above; Backend
     drift saves silently. Task 6 — a persisted free-item line is grandfathered
     at RM 0 regardless of what the current recompute produced. */
  const unit = isFreeItemLine(prev.variants)
    ? 0
    /* PWP reward — keep the grant price locked at claim time. Recompute (no
       pwpBaseSen on the edit path) would reset it to full retail and the
       Backend, not being a POS tablet, would save that silently — turning a
       RM490 加购 into RM990 with no warning (Loo 2026-06-28). */
    : prevIsReward
    ? prev.unit_price_centi
    : (recomputedPatch ? recomputedPatch.unit_price_sen : clientUnit);
  /* Audit 2026-06-11 C-2 — same discount gate as POST /: the effective
     (patch-else-stored) discount must sit in [0, qty × unit] against the
     effective unit price (422, reject-don't-normalize). */
  if (!Number.isFinite(discount) || discount < 0 || discount > qty * unit) {
    return c.json({
      error:    'invalid_discount',
      reason:   'discountCenti must be between 0 and qty × unit price.',
      itemCode: itemCodeAfter,
      discount,
      max:      qty * unit,
    }, 422);
  }
  /* Total floor (Loo 2026-06-11) — a POS sales caller may never save a line
     change that lowers the bill below the original sales order total. The
     header total is Σ line totals, so per line: the new total (0 when
     cancelling) must be ≥ the stored one. Backend / office roles stay free
     to discount or correct downward. */
  if (posTablet) {
    const prevLineTotal = prev.cancelled ? 0 : ((prev.qty * prev.unit_price_centi) - prev.discount_centi);
    const cancelledAfter = it.cancelled !== undefined ? Boolean(it.cancelled) : Boolean(prev.cancelled);
    const newLineTotal = cancelledAfter ? 0 : ((qty * unit) - discount);
    if (newLineTotal < prevLineTotal) {
      return c.json({
        error:    'so_total_below_original',
        reason:   'Changes cannot reduce the bill below the original sales order total.',
        itemCode: itemCodeAfter,
        previous: prevLineTotal,
        next:     newLineTotal,
      }, 422);
    }
  }
  /* Commander 2026-05-28 — cost snapshot on PATCH. Order of precedence:
       1. Client sent unitCostCenti > 0 → use it (explicit override).
       2. A recompute ran (variants/itemCode/price touched) AND produced a
          cost > 0 → use the server-computed cost (base + Σ backend priceSen
          surcharges via computeMfgLineCost). This is the source of truth.
       3. Client changed itemCode but recompute had no cost → re-snapshot
          mfg_products under the new code.
       4. Otherwise keep the prior unit_cost_centi unchanged. */
  let unitCost: number;
  const explicitCost = it.unitCostCenti !== undefined ? Number(it.unitCostCenti) : 0;
  const itemCodeChanged = it.itemCode !== undefined && it.itemCode !== prev.item_code;
  if (explicitCost > 0) {
    unitCost = explicitCost;
  } else if (recomputedPatch && recomputedPatch.unit_cost_sen > 0) {
    unitCost = recomputedPatch.unit_cost_sen;
  } else if (itemCodeChanged) {
    unitCost = await snapshotUnitCostSen(sb, String(it.itemCode ?? ''), 0);
  } else {
    unitCost = prev.unit_cost_centi;
  }
  const lineTotal = (qty * unit) - discount;
  const lineCost = unitCost * qty;

  const updates: Record<string, unknown> = {
    qty, unit_price_centi: unit, discount_centi: discount, unit_cost_centi: unitCost,
    total_centi: lineTotal, total_inc_centi: lineTotal, balance_centi: lineTotal,
    line_cost_centi: lineCost, line_margin_centi: lineTotal - lineCost,
  };
  // MFG-PRICING-ENGINE — Refresh the persisted breakdown columns when we
  // ran a recompute. Without this they'd drift from `variants` over time.
  if (recomputedPatch) {
    updates.divan_price_sen         = recomputedPatch.divan_price_sen;
    updates.leg_price_sen           = recomputedPatch.leg_price_sen;
    updates.special_order_price_sen = recomputedPatch.special_order_sen;
    updates.custom_specials         = recomputedPatch.custom_specials ?? null;
  }
  for (const [from, to] of [
    ['itemCode', 'item_code'], ['itemGroup', 'item_group'], ['description', 'description'],
    ['description2', 'description2'], ['uom', 'uom'], ['variants', 'variants'],
    ['remark', 'remark'], ['cancelled', 'cancelled'],
  ] as const) {
    if (it[from] !== undefined) updates[to] = it[from];
  }
  /* Anti-tamper (Task 6) — when the client sends variants, strip any client-supplied
     freeItem marker, then re-graft the persisted marker (if any) so an already-free
     line stays free and a normal line cannot be made free via a crafted PATCH.
     Must run AFTER the loop above so variants is already in updates. */
  if (it.variants !== undefined) {
    const clientVariants = stripFreeItem(updates['variants']);
    const prevFreeItem = (prev.variants as Record<string, unknown> | null | undefined)?.freeItem;
    updates['variants'] = prevFreeItem !== undefined
      ? { ...(clientVariants as Record<string, unknown> ?? {}), freeItem: prevFreeItem }
      : clientVariants ?? null;
    /* Variants-vocabulary unification (port of 2990 73aeeb1e) — canonicalize
       the FINAL persisted variants. The recompute + sofa depth loads above
       already ran on the raw variantsAfter, so dropping aliases here is safe;
       the persisted row stores seatHeight/legHeight/fabricCode and the
       description2 block below (which reads updates['variants']) sees the
       canonical object. */
    const itemGroupAfter = String(it.itemGroup ?? prev.item_group ?? '');
    updates['variants'] = canonicalizeVariants(
      itemGroupAfter,
      updates['variants'] as Record<string, unknown> | null,
    );
  }
  /* Commander 2026-05-28 — "Description 2" is ALWAYS the server-generated
     variant summary; never trust a client-sent value. Recompute from the
     effective itemGroup + variants (incoming patch, else the stored row).
     Use the FINAL persisted variants (updates['variants']) if variants were patched,
     to ensure description2 matches the stripped-and-re-grafted variants that will
     actually be persisted, not the raw client input. */
  {
    const effGroup = (it.itemGroup ?? prev.item_group) as string | null | undefined;
    const effVariants = (it.variants !== undefined ? updates['variants'] : prev.variants) as Record<string, unknown> | null | undefined;
    updates['description2'] = buildVariantSummary(String(effGroup ?? ''), effVariants ?? null) || null;
  }

  /* PR-E — Per-item delivery date PATCH. If the caller sends
     lineDeliveryDate (including null to clear it), we ALSO server-side
     flip line_delivery_date_overridden to true. This is defensive — the
     UI should already mark the line as overridden when the user types
     into the field, but enforcing it here protects against clients that
     forget. A separate lineDeliveryDateOverridden=false reset path lets
     the UI deliberately rejoin the header cascade. */
  if (it.lineDeliveryDate !== undefined) {
    updates['line_delivery_date'] = it.lineDeliveryDate as string | null;
    updates['line_delivery_date_overridden'] = true;
  }
  if (it.lineDeliveryDateOverridden !== undefined) {
    updates['line_delivery_date_overridden'] = Boolean(it.lineDeliveryDateOverridden);
  }
  /* Commander 2026-05-31 — per-line ship-from warehouse is editable. Moving a
     line to another warehouse reshuffles the per-warehouse allocation pool, so
     recomputeSoStockAllocation below re-derives stock_status. */
  if (it.warehouseId !== undefined) {
    updates['warehouse_id'] = it.warehouseId as string | null;
  }

  const { error } = await sb.from('mfg_sales_order_items').update(updates).eq('id', itemId);
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  // Default Free Gift (0170) — editing a line (code/qty) may add or drop a
  // trigger; reconcile auto-syncs the gift lines, then recomputes totals.
  await reconcileFreeGiftLinesForSo(sb, docNo);
  // Re-derive the delivery fee — a line code/qty change can flip a cross-category
  // mix or a special-delivery trigger. Stored cross-category source kept.
  await rederiveDeliveryFee(sb, docNo);

  // PR-D — diff old vs new and emit one UPDATE_LINE row only if any field
  // moved. Compare across both the derived columns (qty/price/discount)
  // and the passthrough columns (code/group/description/uom/etc).
  const fieldChanges: FieldChange[] = [];
  const cmp = (field: string, fromVal: unknown, toVal: unknown) => {
    const a = fromVal == null ? '' : String(fromVal);
    const b = toVal == null ? '' : String(toVal);
    if (a !== b) fieldChanges.push({ field, from: fromVal ?? null, to: toVal ?? null });
  };
  cmp('qty', prev.qty, qty);
  cmp('unitPriceCenti', prev.unit_price_centi, unit);
  cmp('discountCenti', prev.discount_centi, discount);
  cmp('unitCostCenti', prev.unit_cost_centi, unitCost);
  for (const [from, to] of [
    ['itemCode', 'item_code'], ['itemGroup', 'item_group'], ['description', 'description'],
    ['description2', 'description2'], ['uom', 'uom'], ['remark', 'remark'], ['cancelled', 'cancelled'],
  ] as const) {
    if (it[from] !== undefined) cmp(from, (prev as Record<string, unknown>)[to], it[from]);
  }
  if (fieldChanges.length > 0) {
    // Prefix with itemCode so the timeline can show "Updated line ITEM-123"
    // without a dedicated column on the audit row.
    fieldChanges.unshift({ field: 'itemCode', to: prev.item_code });
    await recordSoAudit(sb, {
      docNo,
      action: 'UPDATE_LINE',
      actorId: user.id,
      actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
      fieldChanges,
    });
  }

  /* Line qty / variants / category may have changed → recompute. */
  try { await recomputeSoStockAllocation(sb); }
  catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-allocation] post-line-patch failed:', e); }

  return c.json({ ok: true });
});

mfgSalesOrders.delete('/:docNo/items/:itemId', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo'); const itemId = c.req.param('itemId'); const user = c.get('user');

  /* Tier 2 downstream-lock — line-delete is blocked once a DO / SI exists. */
  const childLock = await soHasDownstream(sb, docNo);
  if (childLock) return c.json(childLock, 409);

  /* TBC fill-in (Loo 2026-06-11) — self-scoped selling roles only touch
     their own SO. */
  if (await selfScopedSalesBlocked(sb, user.id, docNo)) return c.json({ error: 'not_found' }, 404);

  /* Owner 2026-06-12 — processing-date lock: no line DELETE once the
     processing day has passed (the locked order is already PO'd). */
  {
    const procLock = await soProcessingLockBlocked(sb, docNo);
    if (procLock) return c.json(procLock, 409);
  }

  // PR-D — capture the line snapshot before delete so the timeline can
  // show what was removed (item code + qty + unit price).
  // Task #93 — also fetch photo_urls so we can clean up R2 orphans
  // after the DB row is gone. We grab them BEFORE the delete because
  // the row is the source of truth for which keys belong to this line.
  const { data: prev } = await sb.from('mfg_sales_order_items')
    .select('item_code, qty, unit_price_centi, total_centi, photo_urls, cancelled')
    .eq('id', itemId).maybeSingle();
  const prevTyped = prev as
    | { item_code: string; qty: number; unit_price_centi: number; total_centi: number; photo_urls: string[] | null; cancelled?: boolean }
    | null;

  /* Total floor (Loo 2026-06-11) — removing a priced line lowers the bill
     below the original sales order total, so POS sales callers may not
     delete one (a cancelled / zero line is fine). Backend roles stay free. */
  if (prevTyped && !prevTyped.cancelled && prevTyped.total_centi > 0
      && await isPosTabletCaller(sb, user.id)) {
    return c.json({
      error:    'so_total_below_original',
      reason:   'Removing a line would reduce the bill below the original sales order total.',
      itemCode: prevTyped.item_code,
    }, 422);
  }

  const { error } = await sb.from('mfg_sales_order_items').delete().eq('id', itemId);
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);
  // Default Free Gift (0170) — removing a trigger line (e.g. a mattress) must
  // auto-delete its free gift; reconcile drops orphaned gifts, then recomputes.
  await reconcileFreeGiftLinesForSo(sb, docNo);
  // Re-derive the delivery fee — removing a goods line can drop a cross-category
  // mix or a special-delivery trigger. Stored cross-category source kept.
  await rederiveDeliveryFee(sb, docNo);

  // Task #93 — orphan cleanup. Loop over the photo keys and best-effort
  // delete each from R2. Failures are swallowed (logged) so a flaky R2
  // op doesn't leave the user with a "delete failed" toast on top of a
  // DB delete that already succeeded — rolling back the row to recover
  // a few KB of blob is worse than the orphan.
  let photosCleaned = 0;
  const photoKeys = prevTyped?.photo_urls ?? [];
  if (photoKeys.length > 0 && c.env.SO_ITEM_PHOTOS) {
    for (const key of photoKeys) {
      try {
        await c.env.SO_ITEM_PHOTOS.delete(key);
        photosCleaned += 1;
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[so-item-photo] orphan cleanup failed for', key, e);
      }
    }
  }

  if (prevTyped) {
    await recordSoAudit(sb, {
      docNo,
      action: 'DELETE_LINE',
      actorId: user.id,
      actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
      fieldChanges: [
        { field: 'itemCode', from: prevTyped.item_code },
        { field: 'qty', from: prevTyped.qty },
        { field: 'unitPriceCenti', from: prevTyped.unit_price_centi },
        { field: 'totalCenti', from: prevTyped.total_centi },
        // Task #93 — note the photo cleanup so the timeline shows
        // "deleted N photos" alongside the line removal.
        ...(photoKeys.length > 0
          ? [{ field: 'photosCleaned', from: photoKeys.length, to: photosCleaned } satisfies FieldChange]
          : []),
      ],
    });
  }

  /* Line delete = demand drops → other queued SOs may move into READY. */
  try { await recomputeSoStockAllocation(sb); }
  catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-allocation] post-line-delete failed:', e); }

  return c.body(null, 204);
});

/* ───────────────────── TBC fill-in (Loo 2026-06-11) ──────────────────────
   POS sales complete a customer's deferred picks (fabric / leg height / gap /
   divan / special add-ons) on an EXISTING SO line, from My orders. Pricing is
   a server-computed DELTA:

       newUnitPrice = storedUnitPrice
                    + (surcharges(nextVariants) − surcharges(prevVariants))
                    + (fabricTierΔ(next) − fabricTierΔ(prev))

   The stored deal (combo proration on split sofa lines, PWP bases, any
   negotiated figure) is never re-derived — only the CHANGED options move the
   bill. computeMfgLinePrice runs twice with identical base inputs, so every
   constant term cancels; the selling fabric-tier Δ (migration 0124) rides
   separately, mirroring recomputeFromSnapshot's authoritative branches.

   Sofa builds (P3 per-module lines): the shared picks (fabric + leg) copy
   onto EVERY line of the build (variants.buildKey) so so-variant-rule sees a
   complete build, while the price delta lands ONCE on the requested line.

   Floor rule: for POS tablet callers the delta may never be negative — the
   bill only grows or stays equal vs the original sales order total. Backend
   roles keep using SoLineCard / the generic PATCH. */

const TBC_VARIANT_KEYS = [
  'fabricId', 'fabricCode', 'fabricLabel', 'colourId', 'colourLabel', 'colourHex',
  'sofaLegHeight',
  'gap', 'gapLabel', 'legHeight', 'legHeightLabel', 'divanHeight', 'divanHeightLabel',
  'specials', 'specialIds', 'specialLabels', 'specialChoices',
] as const;
/* Picks shared by every module line of a sofa build. */
const TBC_BUILD_SHARED_KEYS = ['fabricId', 'fabricCode', 'fabricLabel', 'colourId', 'colourLabel', 'colourHex', 'sofaLegHeight'] as const;

mfgSalesOrders.post('/:docNo/items/:itemId/tbc-update', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo'); const itemId = c.req.param('itemId'); const user = c.get('user');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const patch = (body.variants ?? {}) as Record<string, unknown>;
  if (Object.keys(patch).length === 0) return c.json({ error: 'variants_required' }, 400);
  const badKey = Object.keys(patch).find((k) => !(TBC_VARIANT_KEYS as readonly string[]).includes(k));
  if (badKey) return c.json({ error: 'invalid_variant_key', key: badKey, allowed: TBC_VARIANT_KEYS }, 400);

  const childLock = await soHasDownstream(sb, docNo);
  if (childLock) return c.json(childLock, 409);
  if (await selfScopedSalesBlocked(sb, user.id, docNo)) return c.json({ error: 'not_found' }, 404);

  /* Owner 2026-06-12 — processing-date lock: a TBC fill-in is still a line
     EDIT (it changes what we PO to the supplier), so it locks too. */
  {
    const procLock = await soProcessingLockBlocked(sb, docNo);
    if (procLock) return c.json(procLock, 409);
  }

  const { data: prev } = await sb.from('mfg_sales_order_items')
    .select('id, item_code, item_group, qty, unit_price_centi, discount_centi, unit_cost_centi, variants, cancelled')
    .eq('id', itemId).eq('doc_no', docNo).maybeSingle();
  if (!prev) return c.json({ error: 'not_found' }, 404);
  if (prev.cancelled) return c.json({ error: 'line_cancelled' }, 409);
  const prevVariants = ((prev.variants ?? {}) as Record<string, unknown>);
  /* PWP reward lines ARE editable here (Loo 2026-06-12 — SO-2606-009's
     FENRIR-(K) reward arrived all-TBC and could never be completed). Safe
     because the delta below never re-derives the base: only the surcharge
     difference + fabric-tier Δ move the price, exactly the components a PWP
     line stacks on top of its granted base at create — and the
     TBC_VARIANT_KEYS whitelist keeps pwp / pwpCode untouchable. Only the
     product SWAP stays locked for PWP (it would break the voucher binding). */

  /* Merge — a present key overwrites; null / '' / [] clears the key (the
     sales picked "Confirm later" again). */
  const nextVariants: Record<string, unknown> = { ...prevVariants };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === '' || (Array.isArray(v) && v.length === 0)
        || (k === 'specialChoices' && typeof v === 'object' && v !== null && Object.keys(v as object).length === 0)) {
      delete nextVariants[k];
    } else {
      nextVariants[k] = v;
    }
  }

  /* allowed_options gate on the merged shape (same as the generic PATCH). */
  {
    const { product, model } = await loadProductAndModel(sb, prev.item_code);
    const aoErr = checkAllowedOptions(product, model, nextVariants as Parameters<typeof checkAllowedOptions>[2]);
    if (aoErr) return c.json({ ...aoErr, itemCode: prev.item_code }, 400);
  }

  const [cfg, prodLite, fabPrev, fabNext, tiersPrev, tiersNext, addonCfg, specialDefs, modelOverrides, compartmentOverrides] = await Promise.all([
    loadMaintenanceConfig(sb),
    loadProductByCode(sb, prev.item_code),
    loadFabricByCode(sb, (prevVariants.fabricCode as string | undefined) ?? null),
    loadFabricByCode(sb, (nextVariants.fabricCode as string | undefined) ?? null),
    loadFabricSellingTiers(sb, (prevVariants.fabricId as string | undefined) ?? null),
    loadFabricSellingTiers(sb, (nextVariants.fabricId as string | undefined) ?? null),
    loadFabricTierAddonConfig(sb),
    loadSpecialAddons(sb),
    loadModelFabricTierOverrides(sb),
    loadCompartmentFabricTierOverrides(sb),
  ]);
  /* Two snapshots, identical base inputs — only `variants` (and its fabric
     row) differ, so base / combo / PWP terms cancel in the difference. The
     fabric-tier Δ inputs (sellingTiers / addonConfig) are deliberately NOT
     passed: the Δ is applied once, below, never double-counted. */
  const snap = (variants: Record<string, unknown>, fab: typeof fabPrev) =>
    recomputeFromSnapshot(
      {
        itemCode:       prev.item_code,
        itemGroup:      String(prev.item_group ?? 'others'),
        qty:            Number(prev.qty),
        unitPriceCenti: Number(prev.unit_price_centi),
        variants:       variants as MfgItemForRecompute['variants'],
      },
      prodLite, fab, cfg, null, null, null, null, null, null, specialDefs, null, null,
    );
  const before = snap(prevVariants, fabPrev);
  const after  = snap(nextVariants, fabNext);
  const category = String(prodLite?.category ?? '').toUpperCase();
  // migration 0172 — per-Model Δ override (same for prev/next; the Model doesn't
  // change on a TBC fill-in). Resolved by the line's model_id, replaces global.
  // migration 0025 — folded with any matching per-compartment Δ (MAX per tier)
  // over the build's cells; cells don't change on a TBC fill-in (fabric only).
  const tbcBaseOverride = (modelOverrides && prodLite?.model_id) ? (modelOverrides.get(prodLite.model_id) ?? null) : null;
  /* A persisted split-sofa module line STRIPS `variants.cells`, so the build's
     compartment codes can't be read off `nextVariants` — that yielded `[]` and
     resolved model-only, under-charging a build that carries a per-compartment
     Δ (the POS preview showed the higher Δ but the server billed less; no drift
     gate here). Reconstruct them from the SIBLING module lines' item_code suffix,
     the same way the create path does. */
  let tbcCells: string[] = [];
  if (category === 'SOFA') {
    const buildKeyForCells = (prevVariants.buildKey as string | undefined) ?? null;
    if (buildKeyForCells) {
      const { data: cellRows } = await sb.from('mfg_sales_order_items')
        .select('item_code, variants')
        .eq('doc_no', docNo).eq('cancelled', false)
        .filter('variants->>buildKey', 'eq', buildKeyForCells);
      tbcCells = buildCompartmentsFromModuleLines(
        ((cellRows ?? []) as Array<{ item_code: string; variants: Record<string, unknown> | null }>)
          .map((r) => ({ item_code: r.item_code, buildKey: String((r.variants ?? {}).buildKey ?? '') })),
        buildKeyForCells,
      );
    } else {
      // Not a split build (whole-unit code carries cells inline) — fall back to
      // the inline cells if present.
      tbcCells = Array.isArray((nextVariants as { cells?: unknown }).cells)
        ? ((nextVariants as { cells?: Array<{ moduleId?: unknown }> }).cells ?? []).map((cl) => String(cl?.moduleId ?? '')).filter(Boolean)
        : [];
    }
  }
  const tbcOverride = resolveFabricTierOverride(tbcCells, tbcBaseOverride, compartmentOverrides ?? new Map());
  const tierDeltaCenti = (addonCfg && (category === 'SOFA' || category === 'BEDFRAME'))
    ? (fabricTierAddon(category, (category === 'SOFA' ? tiersNext?.sofaTier : tiersNext?.bedframeTier) ?? null, addonCfg, tbcOverride)
     - fabricTierAddon(category, (category === 'SOFA' ? tiersPrev?.sofaTier : tiersPrev?.bedframeTier) ?? null, addonCfg, tbcOverride)) * 100
    : 0;
  const sellingDeltaCenti = (after.breakdown.unitPriceSen - before.breakdown.unitPriceSen) + tierDeltaCenti;
  const costDeltaCenti = after.unit_cost_sen - before.unit_cost_sen;

  /* Task 6 — grandfathering: a line carrying variants.freeItem was made free
     at create time and must STAY at RM 0 regardless of any fabric/option delta.
     Treat it as a no-price-change TBC edit (the variant picks still land).
     Also skip the POS floor check — a zero-priced line can never lower the
     bill further; the check is meaningless and would compare 0 vs 0. */
  const isFreeItemGrandfathered = isFreeItemLine(prevVariants);
  const posTablet = await isPosTabletCaller(sb, user.id);
  if (!isFreeItemGrandfathered && posTablet && sellingDeltaCenti < 0) {
    return c.json({
      error:    'so_total_below_original',
      reason:   'Changes cannot reduce the bill below the original sales order total.',
      itemCode: prev.item_code,
      deltaCenti: sellingDeltaCenti * Number(prev.qty),
    }, 422);
  }

  const qty = Number(prev.qty);
  const newUnit = isFreeItemGrandfathered ? 0 : Math.max(0, Number(prev.unit_price_centi) + sellingDeltaCenti);
  const newTotal = (qty * newUnit) - Number(prev.discount_centi ?? 0);
  const newUnitCost = Math.max(0, Number(prev.unit_cost_centi ?? 0) + costDeltaCenti);
  const { error: upErr } = await sb.from('mfg_sales_order_items').update({
    variants: nextVariants,
    description2: buildVariantSummary(String(prev.item_group ?? ''), nextVariants) || null,
    unit_price_centi: newUnit,
    total_centi: newTotal,
    total_inc_centi: newTotal,
    balance_centi: newTotal,
    unit_cost_centi: newUnitCost,
    line_cost_centi: newUnitCost * qty,
    line_margin_centi: newTotal - (newUnitCost * qty),
    divan_price_sen: after.breakdown.divanSurchargeSen,
    leg_price_sen: after.breakdown.legSurchargeSen,
    special_order_price_sen: after.breakdown.specialsSurchargeSen,
    custom_specials: after.custom_specials ?? null,
  }).eq('id', itemId);
  if (upErr) return c.json({ error: 'update_failed', reason: upErr.message }, 500);

  /* Mirror the SHARED picks onto the rest of the sofa build — variants only;
     the money landed once above. */
  const buildKey = String(prev.item_group) === 'sofa' ? ((prevVariants.buildKey as string | undefined) ?? null) : null;
  if (buildKey) {
    const { data: rows } = await sb.from('mfg_sales_order_items')
      .select('id, variants')
      .eq('doc_no', docNo).eq('cancelled', false)
      .filter('variants->>buildKey', 'eq', buildKey);
    for (const row of ((rows ?? []) as Array<{ id: string; variants: Record<string, unknown> | null }>)) {
      if (row.id === itemId) continue;
      const merged: Record<string, unknown> = { ...((row.variants ?? {}) as Record<string, unknown>) };
      for (const k of TBC_BUILD_SHARED_KEYS) {
        if (!(k in patch)) continue;
        const v = patch[k];
        if (v === null || v === '') delete merged[k]; else merged[k] = v;
      }
      await sb.from('mfg_sales_order_items').update({
        variants: merged,
        description2: buildVariantSummary('sofa', merged) || null,
      }).eq('id', row.id);
    }
  }

  // Default Free Gift (0170) — a sofa/variant build change may newly match (or
  // stop matching) a gifting combo; reconcile syncs the gift lines, then totals.
  await reconcileFreeGiftLinesForSo(sb, docNo);
  // Re-derive the delivery fee — a TBC variant fill-in can resolve a special-
  // delivery trigger (model/variant/combo). Stored cross-category source kept.
  await rederiveDeliveryFee(sb, docNo);
  await recordSoAudit(sb, {
    docNo,
    action: 'UPDATE_LINE',
    actorId: user.id,
    actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
    fieldChanges: [
      { field: 'itemCode', to: prev.item_code },
      { field: 'tbcVariants', to: Object.keys(patch).join(', ') },
      ...(sellingDeltaCenti !== 0
        ? [{ field: 'unitPriceCenti', from: prev.unit_price_centi, to: newUnit } satisfies FieldChange]
        : []),
    ],
  });

  return c.json({ ok: true, unitPriceCenti: newUnit, deltaCenti: sellingDeltaCenti, totalCenti: newTotal });
});

/* TBC product swap (Loo 2026-06-11) — exchange a line for a DIFFERENT product
   from My orders. Non-sofa ↔ non-sofa only (a sofa is a multi-line build).
   The new line reprices from the catalog (sell_price_sen) with every option
   reset to TBC; the floor rule keeps a POS sales caller from swapping the
   bill downward. The composition guard keeps sofa exclusive on the SO. */
mfgSalesOrders.post('/:docNo/items/:itemId/tbc-swap', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo'); const itemId = c.req.param('itemId'); const user = c.get('user');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const newCode = String(body.itemCode ?? '').trim();
  if (!newCode) return c.json({ error: 'item_code_required' }, 400);

  const childLock = await soHasDownstream(sb, docNo);
  if (childLock) return c.json(childLock, 409);
  if (await selfScopedSalesBlocked(sb, user.id, docNo)) return c.json({ error: 'not_found' }, 404);

  /* Owner 2026-06-12 — processing-date lock: a product swap is a line EDIT
     (it changes what we PO to the supplier), so it locks too. */
  {
    const procLock = await soProcessingLockBlocked(sb, docNo);
    if (procLock) return c.json(procLock, 409);
  }

  const { data: prev } = await sb.from('mfg_sales_order_items')
    .select('id, item_code, item_group, qty, unit_price_centi, discount_centi, total_centi, variants, cancelled')
    .eq('id', itemId).eq('doc_no', docNo).maybeSingle();
  if (!prev) return c.json({ error: 'not_found' }, 404);
  if (prev.cancelled) return c.json({ error: 'line_cancelled' }, 409);
  const prevVariants = ((prev.variants ?? {}) as Record<string, unknown>);
  if (String(prev.item_group) === 'sofa' || prevVariants.buildKey || prevVariants.cells) {
    return c.json({ error: 'sofa_swap_not_supported', reason: 'A sofa build is exchanged by rebuilding the order, not by swapping one line.' }, 400);
  }

  const { data: prodRow } = await sb.from('mfg_products')
    .select('code, name, category, status, pos_active, sell_price_sen, cost_price_sen, pwp_price_sen, model_id, size_code')
    .eq('code', newCode).maybeSingle();
  const prod = prodRow as { code: string; name: string; category: string; status: string; pos_active: boolean; sell_price_sen: number | null; cost_price_sen: number | null; pwp_price_sen: number | null; model_id: string | null; size_code: string | null } | null;
  if (!prod) return c.json(unknownItemCodeResponse([newCode]), 409);
  if (String(prod.category).toUpperCase() === 'SOFA') {
    return c.json({ error: 'sofa_swap_not_supported', reason: 'A sofa build is added through the configurator, not a line swap.' }, 400);
  }
  if (prod.status !== 'ACTIVE' || !prod.pos_active) {
    return c.json({ error: 'product_inactive', itemCode: newCode }, 409);
  }

  /* ── PWP swap ranges (Loo 2026-06-12) ─────────────────────────────────
     A line tied to a PWP (换购) promotion may only be exchanged WITHIN the
     promotion's own range:
       • REWARD line (variants.pwp + pwpCode) → only SKUs inside the code's
         snapshotted reward set (reward_category + eligible_reward_model_ids,
         [] = whole category), priced at the new SKU's PWP price — the deal
         survives the exchange; redeemed_item_code is re-stamped after.
       • TRIGGER line (this SO minted codes off it — pwp_codes.source_doc_no
         = docNo, trigger_item_code = the line's SKU) → only SKUs inside
         EVERY anchoring rule's trigger set (trigger_category +
         trigger_eligible_model_ids); trigger_item_code is re-stamped after.
     A code whose rule is gone can't be validated → locked (coordinator). */
  const rewardPwpCode = prevVariants.pwp ? String(prevVariants.pwpCode ?? '').trim() : '';
  let unitSen: number;
  let variantsAfterSwap: Record<string, unknown> | null = null;
  /* PWP dynamic re-evaluation (Loo 2026-06-12, unified with the sofa
     exchange): classified before any write, applied after the line lands. */
  type SwapPwpRule = {
    id: string; trigger_category: string; trigger_eligible_model_ids: string[] | null;
    trigger_combo_ids: string[] | null; reward_category: string;
    eligible_reward_model_ids: string[] | null; reward_combo_ids: string[] | null;
    trigger_size_codes: string[] | null; trigger_compartments: string[] | null;
    reward_size_codes: string[] | null; reward_compartments: string[] | null;
    qty_per_trigger: number | null; type: string | null;
  };
  type SwapRewardRevertLine = {
    id: string; item_code: string; item_group: string; qty: number;
    unit_price_centi: number; discount_centi: number | null;
    unit_cost_centi: number | null; variants: Record<string, unknown> | null;
  };
  let triggerCodesToRestamp: string[] = [];
  const pwpDeleteCodes: string[] = [];
  const pwpRevertCodes: string[] = [];
  let rewardLinesToRevert: SwapRewardRevertLine[] = [];
  const sofaRevertPlans: SofaRewardRevertUpdate[] = [];
  let pwpNewlyTriggered: SwapPwpRule[] = [];
  if (prevVariants.pwp) {
    if (!rewardPwpCode) {
      return c.json({ error: 'pwp_line_locked', reason: 'This PWP reward carries no voucher code — ask the coordinator to exchange it.' }, 409);
    }
    const { data: codeRow } = await sb.from('pwp_codes')
      .select('code, reward_category, eligible_reward_model_ids, reward_size_codes, reward_compartments, type')
      .eq('code', rewardPwpCode).maybeSingle();
    const codeTyped = codeRow as { code: string; reward_category: string; eligible_reward_model_ids: string[] | null; reward_size_codes: string[] | null; reward_compartments: string[] | null; type: string } | null;
    if (!codeTyped) {
      return c.json({ error: 'pwp_line_locked', reason: 'This PWP voucher could not be found — ask the coordinator to exchange it.' }, 409);
    }
    const inCategory = String(prod.category).toUpperCase() === String(codeTyped.reward_category).toUpperCase();
    const eligibleModels = codeTyped.eligible_reward_model_ids ?? [];
    const inModels = eligibleModels.length === 0 || (prod.model_id != null && eligibleModels.includes(prod.model_id));
    // 0182 reward refinement — a refined voucher's size narrowing applies to a swap too.
    const inRefinement = passesRefinementColumns(
      { category: String(prod.category), modelId: prod.model_id ?? null, sizeCode: prod.size_code ? String(prod.size_code).toUpperCase() : null, builtCompartments: [] },
      codeTyped.reward_size_codes, codeTyped.reward_compartments,
    );
    if (!inCategory || !inModels || !inRefinement) {
      return c.json({
        error: 'pwp_swap_out_of_range',
        reason: 'A PWP reward can only be exchanged for another item inside the promotion\'s reward range.',
        itemCode: newCode,
      }, 409);
    }
    const pwpSen = Math.max(0, Math.round(Number(prod.pwp_price_sen ?? 0)));
    if (codeTyped.type !== 'promo' && pwpSen <= 0) {
      return c.json({ error: 'pwp_reward_unpriced', reason: 'This item has no PWP price yet — ask an admin to set it in the SKU Master.', itemCode: newCode }, 409);
    }
    unitSen = pwpSen;  // 'promo' grants may redeem at 0 (free) — migration 0145
    variantsAfterSwap = { pwp: true, pwpCode: rewardPwpCode };
  } else {
    /* PWP dynamic re-evaluation (Loo 2026-06-12 - same model as the sofa
       exchange): a trigger line may be exchanged into ANYTHING; the
       promotion then re-evaluates against the NEW product:
         - rule still triggered: voucher survives, stamp re-points;
         - trigger gone + voucher redeemed on THIS order: that reward line
           reverts to its normal price and the code is deleted;
         - trigger gone + un-redeemed: code deleted (released);
         - trigger gone + redeemed on ANOTHER order: blocked (the reward
           was already given out - coordinator only);
         - newly triggered rule: fresh vouchers mint after the swap.
       Anchoring is RANGE-based with the stamp as fallback (stamps go stale
       - SO-2606-009), plus orphan-stamp adoption for legacy swaps. */
    const { data: soCodes } = await sb.from('pwp_codes')
      .select('code, rule_id, status, trigger_item_code, redeemed_doc_no')
      .eq('source_doc_no', docNo);
    const anchors = (soCodes ?? []) as Array<{ code: string; rule_id: string | null; status: string; trigger_item_code: string | null; redeemed_doc_no: string | null }>;
    {
      const { data: ruleRows } = await sb.from('pwp_rules')
        .select('id, trigger_category, trigger_eligible_model_ids, trigger_combo_ids, reward_category, eligible_reward_model_ids, reward_combo_ids, trigger_size_codes, trigger_compartments, reward_size_codes, reward_compartments, qty_per_trigger, type')
        .eq('active', true);
      const rules = (ruleRows ?? []) as SwapPwpRule[];
      const ruleById = new Map(rules.map((r) => [r.id, r]));
      const fitsTrigger = (r: SwapPwpRule | undefined,
                           p: { category?: string | null; model_id?: string | null; size_code?: string | null } | null): boolean => {
        if (!r || !p) return false;
        // Combo-defined (sofa) triggers can never be satisfied by a one-line
        // product swap; the category check below also excludes them.
        if ((r.trigger_combo_ids ?? []).length > 0) return false;
        const inCat = String(p.category ?? '').toUpperCase() === String(r.trigger_category).toUpperCase();
        const models = r.trigger_eligible_model_ids ?? [];
        if (!inCat || !(models.length === 0 || (p.model_id != null && models.includes(p.model_id)))) return false;
        // Size refinement (0182) — a one-line swap is non-sofa, so only size_codes apply.
        return passesRefinementColumns(
          { category: String(p.category ?? ''), modelId: p.model_id ?? null, sizeCode: p.size_code ? String(p.size_code).toUpperCase() : null, builtCompartments: [] },
          r.trigger_size_codes, r.trigger_compartments,
        );
      };
      if (anchors.length > 0) {
        const prevProd = await loadProductByCode(sb, prev.item_code);
        const { data: lineRows } = await sb.from('mfg_sales_order_items')
          .select('item_code').eq('doc_no', docNo).eq('cancelled', false);
        const liveCodes = new Set(((lineRows ?? []) as Array<{ item_code: string }>).map((r) => r.item_code));
        /* Anchored to THIS line: stamp match, current product in the rule's
           trigger range, or an orphaned stamp whose rule matches the line's
           category (legacy pre-restamp swaps). */
        const anchored = anchors.filter((a) => {
          if (a.trigger_item_code === prev.item_code) return true;
          const r = a.rule_id ? ruleById.get(a.rule_id) : undefined;
          if (fitsTrigger(r, prevProd)) return true;
          return a.trigger_item_code != null && !liveCodes.has(a.trigger_item_code)
            && !!r && String(r.trigger_category).toUpperCase() === String(prevProd?.category ?? '').toUpperCase();
        });
        for (const cd of anchored) {
          const r = cd.rule_id ? ruleById.get(cd.rule_id) : undefined;
          if (r && fitsTrigger(r, prod)) { triggerCodesToRestamp.push(cd.code); continue; }
          if (cd.status === 'USED') {
            if (cd.redeemed_doc_no && cd.redeemed_doc_no !== docNo) {
              return c.json({
                error: 'pwp_trigger_cross_order',
                reason: `This item triggered voucher ${cd.code}, already redeemed on ${cd.redeemed_doc_no} - ask the coordinator to exchange it.`,
              }, 409);
            }
            pwpRevertCodes.push(cd.code);
          } else {
            pwpDeleteCodes.push(cd.code);
          }
        }
        if (pwpRevertCodes.length > 0) {
          const { data: pwpLines } = await sb.from('mfg_sales_order_items')
            .select('id, item_code, item_group, qty, unit_price_centi, discount_centi, unit_cost_centi, variants')
            .eq('doc_no', docNo).eq('cancelled', false)
            .filter('variants->>pwp', 'eq', 'true');
          const revertSet = new Set(pwpRevertCodes);
          const allRevertLines = ((pwpLines ?? []) as SwapRewardRevertLine[])
            .filter((l) => revertSet.has(String(((l.variants ?? {}) as Record<string, unknown>).pwpCode ?? '')));
          rewardLinesToRevert = allRevertLines.filter((l) => String(l.item_group) !== 'sofa');
          /* Sofa rewards revert as a WHOLE build (read-only plan first - a
             build that can't be safely repriced blocks before any write). */
          const sofaRevertCodes = [...new Set(allRevertLines
            .filter((l) => String(l.item_group) === 'sofa')
            .map((l) => String(((l.variants ?? {}) as Record<string, unknown>).pwpCode ?? ''))
            .filter(Boolean))];
          for (const cdx of sofaRevertCodes) {
            const plan = await planSofaRewardRevert(sb, docNo, cdx);
            if (!plan.ok) {
              return c.json({
                error: 'pwp_reward_sofa_revert_unsupported',
                reason: 'The sofa reward this voucher paid for cannot be auto-repriced - ask the coordinator to exchange it.',
              }, 409);
            }
            sofaRevertPlans.push(...plan.updates);
          }
        }
      }
      pwpNewlyTriggered = rules.filter((r) => fitsTrigger(r, prod));
    }
    const sellSen = Math.max(0, Math.round(Number(prod.sell_price_sen ?? 0)));
    if (sellSen <= 0) {
      return c.json({ error: 'product_unpriced', reason: 'This product has no selling price yet — ask an admin to price it in the SKU Master.', itemCode: newCode }, 409);
    }
    unitSen = sellSen;
  }

  /* Composition — a swap must not INTRODUCE a sofa × (bedframe|mattress) mix. */
  if (await soMainMixIntroduced(sb, docNo, itemId, newCode)) {
    return c.json({
      error: 'so_sofa_no_other_main',
      reason: 'A sofa cannot share a Sales Order with a bedframe or mattress.',
    }, 400);
  }

  const qty = Number(prev.qty);
  const discount = Number(prev.discount_centi ?? 0);
  const newTotal = (qty * unitSen) - discount;
  const prevTotal = Number(prev.total_centi ?? ((qty * Number(prev.unit_price_centi)) - discount));
  if (newTotal < prevTotal && await isPosTabletCaller(sb, user.id)) {
    return c.json({
      error:    'so_total_below_original',
      reason:   'Changes cannot reduce the bill below the original sales order total.',
      itemCode: newCode,
      previous: prevTotal,
      next:     newTotal,
    }, 422);
  }

  const newCost = Math.max(0, Math.round(Number(prod.cost_price_sen ?? 0)));
  const { error: upErr } = await sb.from('mfg_sales_order_items').update({
    item_code: newCode,
    item_group: String(prod.category ?? 'others').toLowerCase(),
    description: prod.name,
    description2: null,
    variants: variantsAfterSwap,
    unit_price_centi: unitSen,
    total_centi: newTotal,
    total_inc_centi: newTotal,
    balance_centi: newTotal,
    unit_cost_centi: newCost,
    line_cost_centi: newCost * qty,
    line_margin_centi: newTotal - (newCost * qty),
    divan_price_sen: 0,
    leg_price_sen: 0,
    special_order_price_sen: 0,
    custom_specials: null,
  }).eq('id', itemId);
  if (upErr) return c.json({ error: 'update_failed', reason: upErr.message }, 500);

  /* Re-stamp the voucher audit columns so the codes keep pointing at the
     line's CURRENT SKU (best-effort — the line is already correct). */
  if (rewardPwpCode) {
    const { error: e1 } = await sb.from('pwp_codes')
      .update({ redeemed_item_code: newCode })
      .eq('code', rewardPwpCode).eq('redeemed_doc_no', docNo);
    if (e1) console.error('[tbc-swap] reward code restamp failed:', e1.message); // eslint-disable-line no-console
  }
  if (triggerCodesToRestamp.length > 0) {
    const { error: e2 } = await sb.from('pwp_codes')
      .update({ trigger_item_code: newCode, updated_at: new Date().toISOString() })
      .in('code', triggerCodesToRestamp);
    if (e2) console.error('[tbc-swap] trigger code restamp failed:', e2.message); // eslint-disable-line no-console
  }

  /* ── PWP mutations (classified above, applied after the line landed) —
     mirrors the sofa exchange (tbc-swap-sofa). ── */
  const pwpMintedCodes: string[] = [];
  /* Sofa-reward builds revert via the pre-computed whole-build plan. */
  for (const u of sofaRevertPlans) {
    const { id: uid, ...cols } = u;
    const { error } = await sb.from('mfg_sales_order_items').update({
      ...cols,
      total_inc_centi: cols.total_centi,
      balance_centi: cols.total_centi,
    }).eq('id', uid);
    if (error) console.error('[tbc-swap] sofa reward revert failed for', uid, error.message); // eslint-disable-line no-console
  }
  if (rewardLinesToRevert.length > 0 || pwpDeleteCodes.length > 0 || pwpRevertCodes.length > 0 || pwpNewlyTriggered.length > 0) {
    // Loaders only when the re-evaluation actually has work to do.
    const [cfgX, addonCfgX, specialDefsX, modelOverridesX, compartmentOverridesX] = await Promise.all([
      loadMaintenanceConfig(sb),
      loadFabricTierAddonConfig(sb),
      loadSpecialAddons(sb),
      loadModelFabricTierOverrides(sb),
      loadCompartmentFabricTierOverrides(sb),
    ]);
    // 1. Rewards whose trigger is gone revert to their normal price (picks +
    //    surcharges survive; pwp markers stripped). clientUnit 0 lets the
    //    recompute FILL the authoritative price without a drift reject.
    for (const line of rewardLinesToRevert) {
      const v: Record<string, unknown> = { ...((line.variants ?? {}) as Record<string, unknown>) };
      delete v.pwp; delete v.pwpCode; delete v.pwpTriggerLabel;
      const [rp, rfab, rtiers] = await Promise.all([
        loadProductByCode(sb, line.item_code),
        loadFabricByCode(sb, (v.fabricCode as string | undefined) ?? null),
        loadFabricSellingTiers(sb, (v.fabricId as string | undefined) ?? null),
      ]);
      const rec = recomputeFromSnapshot(
        { itemCode: line.item_code, itemGroup: String(line.item_group ?? 'others'), qty: Number(line.qty), unitPriceCenti: 0, variants: v as MfgItemForRecompute['variants'] },
        rp, rfab, cfgX, null, null, rtiers, addonCfgX, null, null, specialDefsX, null, modelOverridesX, compartmentOverridesX,
      );
      const revertUnit = rec.unit_price_sen > 0 ? rec.unit_price_sen : Number(line.unit_price_centi);
      const lqty = Number(line.qty);
      const ldisc = Number(line.discount_centi ?? 0);
      const lTotal = (lqty * revertUnit) - ldisc;
      const lCost = Number(line.unit_cost_centi ?? 0);
      const { error } = await sb.from('mfg_sales_order_items').update({
        variants: v,
        description2: buildVariantSummary(String(line.item_group ?? ''), v) || null,
        unit_price_centi: revertUnit,
        total_centi: lTotal,
        total_inc_centi: lTotal,
        balance_centi: lTotal,
        line_margin_centi: lTotal - (lCost * lqty),
        divan_price_sen: rec.breakdown.divanSurchargeSen,
        leg_price_sen: rec.breakdown.legSurchargeSen,
        special_order_price_sen: rec.breakdown.specialsSurchargeSen,
        custom_specials: rec.custom_specials ?? null,
      }).eq('id', line.id);
      if (error) console.error('[tbc-swap] reward revert failed for', line.id, error.message); // eslint-disable-line no-console
    }
    // 2. Dead vouchers go (un-redeemed + reverted ones - Loo: delete).
    const toDelete = [...pwpDeleteCodes, ...pwpRevertCodes];
    if (toDelete.length > 0) {
      const { error } = await sb.from('pwp_codes').delete().in('code', toDelete);
      if (error) console.error('[tbc-swap] code delete failed:', error.message); // eslint-disable-line no-console
    }
    // 3. Newly-triggered rules mint fresh vouchers (AVAILABLE, customer-bound),
    //    topped up against the codes this line kept.
    if (pwpNewlyTriggered.length > 0) {
      const { data: hdr } = await sb.from('mfg_sales_orders').select('customer_id').eq('doc_no', docNo).maybeSingle();
      const customerId = ((hdr as { customer_id?: string | null } | null)?.customer_id) ?? null;
      const { data: keptRows } = triggerCodesToRestamp.length > 0
        ? await sb.from('pwp_codes').select('code, rule_id').in('code', triggerCodesToRestamp)
        : { data: [] };
      const keptByRule = new Map<string, number>();
      for (const k of ((keptRows ?? []) as Array<{ rule_id: string | null }>)) {
        if (k.rule_id) keptByRule.set(k.rule_id, (keptByRule.get(k.rule_id) ?? 0) + 1);
      }
      for (const r of pwpNewlyTriggered) {
        const target = Math.max(0, Math.floor((Number(r.qty_per_trigger) || 1) * qty));
        const have = keptByRule.get(r.id) ?? 0;
        for (let i = have; i < target; i++) {
          for (let attempt = 0; attempt < 5; attempt++) {
            const code = genCode();
            const { error } = await sb.from('pwp_codes').insert({
              code,
              rule_id: r.id,
              reward_category: r.reward_category,
              eligible_reward_model_ids: r.eligible_reward_model_ids ?? [],
              reward_combo_ids: r.reward_combo_ids ?? [],
              reward_size_codes: r.reward_size_codes ?? [],
              reward_compartments: r.reward_compartments ?? [],
              type: r.type ?? 'pwp',
              status: 'AVAILABLE',
              owner_staff_id: user.id,
              cart_line_key: null,
              trigger_item_code: newCode,
              source_doc_no: docNo,
              customer_id: customerId,
            });
            if (!error) { pwpMintedCodes.push(code); break; }
            if (attempt === 4) console.error('[tbc-swap] voucher mint failed:', error.message); // eslint-disable-line no-console
          }
        }
      }
    }
  }

  // Default Free Gift (0170) — runs AFTER the PWP re-evaluation above, in place
  // of the final recomputeTotals: a product swap can add/drop a trigger, so
  // reconcile syncs the accessory gift lines and then recomputes header totals.
  await reconcileFreeGiftLinesForSo(sb, docNo);
  // Re-derive the delivery fee — a product swap can flip a cross-category mix or
  // a special-delivery trigger. Stored cross-category source kept.
  await rederiveDeliveryFee(sb, docNo);
  await recordSoAudit(sb, {
    docNo,
    action: 'UPDATE_LINE',
    actorId: user.id,
    actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
    fieldChanges: [
      { field: 'itemCode', from: prev.item_code, to: newCode },
      { field: 'unitPriceCenti', from: prev.unit_price_centi, to: unitSen },
      { field: 'totalCenti', from: prev.total_centi, to: newTotal },
      ...(rewardPwpCode ? [{ field: 'pwpCode', to: rewardPwpCode } satisfies FieldChange] : []),
      ...(pwpRevertCodes.length > 0
        ? [{ field: 'pwpRewardsReverted', to: pwpRevertCodes.join(', ') } satisfies FieldChange] : []),
      ...(pwpDeleteCodes.length > 0
        ? [{ field: 'pwpCodesDeleted', to: pwpDeleteCodes.join(', ') } satisfies FieldChange] : []),
      ...(pwpMintedCodes.length > 0
        ? [{ field: 'pwpCodesMinted', to: pwpMintedCodes.join(', ') } satisfies FieldChange] : []),
    ],
  });
  /* Demand changed product → stock allocation may shift. Best-effort. */
  try { await recomputeSoStockAllocation(sb); }
  catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-allocation] post-tbc-swap failed:', e); }

  return c.json({
    ok: true,
    itemCode: newCode,
    unitPriceCenti: unitSen,
    totalCenti: newTotal,
    pwp: {
      kept: triggerCodesToRestamp.length,
      reverted: pwpRevertCodes.length,
      deleted: pwpDeleteCodes.length,
      minted: pwpMintedCodes,
    },
  });
});

/* ── Sofa-reward revert plan (Loo 2026-06-12) ──
   When a TRIGGER swap strands a SOFA reward on the same SO, the reward must
   revert to its normal selling price — but a sofa lives as per-module split
   lines whose PWP total was spread proportionally, so the revert is a
   whole-build job: reconstruct the build from the split lines (module code
   from the SKU, x/y/rot/cellIndex from variants), reprice it on the
   authoritative engine WITHOUT the PWP grant, re-spread across the same
   lines, strip the pwp markers. Planned READ-ONLY before any write — a
   build that can't be safely repriced (no module prices / line-count
   mismatch) returns ok:false and the caller blocks for the coordinator. */
type SofaRewardRevertUpdate = {
  id: string;
  unit_price_centi: number;
  total_centi: number;
  line_margin_centi: number;
  variants: Record<string, unknown>;
  description2: string | null;
  divan_price_sen: number;
  leg_price_sen: number;
  special_order_price_sen: number;
  custom_specials: unknown;
};
async function planSofaRewardRevert(
  sb: any,
  docNo: string,
  pwpCode: string,
): Promise<{ ok: true; updates: SofaRewardRevertUpdate[] } | { ok: false }> {
  const { data } = await sb.from('mfg_sales_order_items')
    .select('id, item_code, item_group, qty, unit_price_centi, discount_centi, unit_cost_centi, line_cost_centi, variants')
    .eq('doc_no', docNo).eq('cancelled', false)
    .filter('variants->>pwpCode', 'eq', pwpCode);
  type Row = {
    id: string; item_code: string; item_group: string; qty: number;
    unit_price_centi: number; discount_centi: number | null;
    unit_cost_centi: number | null; line_cost_centi: number | null;
    variants: Record<string, unknown> | null;
  };
  const lines = (((data ?? []) as Row[]))
    .filter((l) => String(l.item_group) === 'sofa' && ((l.variants ?? {}) as Record<string, unknown>).pwp)
    .sort((a, b) =>
      Number(((a.variants ?? {}) as Record<string, unknown>).cellIndex ?? 0)
      - Number(((b.variants ?? {}) as Record<string, unknown>).cellIndex ?? 0));
  if (lines.length === 0) return { ok: true, updates: [] };

  const lead = lines[0]!;
  const leadV = ((lead.variants ?? {}) as Record<string, unknown>);
  const baseModel = splitSofaCode(lead.item_code).baseModel;
  if (!baseModel) return { ok: false };
  const cells = lines.map((l) => {
    const v = ((l.variants ?? {}) as Record<string, unknown>);
    return {
      moduleId: splitSofaCode(l.item_code).sizeCode || l.item_code,
      x: typeof v.x === 'number' ? v.x : 0,
      y: typeof v.y === 'number' ? v.y : 0,
      rot: typeof v.rot === 'number' ? v.rot : 0,
    };
  });
  /* Variants-vocabulary unification (port of 2990 73aeeb1e) — dual-read:
     post-unification a persisted sofa row stores `seatHeight`; legacy rows
     stored `depth`. */
  const depth = String(leadV.depth ?? leadV.seatHeight ?? '24');
  const [cfg, prodLite, fabLite, combos, sellingTiers, addonCfg, specialDefs, modulePrices, modelOverridesLead, compartmentOverridesLead] = await Promise.all([
    loadMaintenanceConfig(sb),
    loadProductByCode(sb, lead.item_code),
    loadFabricByCode(sb, (leadV.fabricCode as string | undefined) ?? null),
    loadActiveSofaCombos(sb),
    loadFabricSellingTiers(sb, (leadV.fabricId as string | undefined) ?? null),
    loadFabricTierAddonConfig(sb),
    loadSpecialAddons(sb),
    loadModelSofaModulePrices(sb, splitSofaCode(lead.item_code).baseModel, depth),
    loadModelFabricTierOverrides(sb),
    loadCompartmentFabricTierOverrides(sb),
  ]);
  if (!prodLite || !modulePrices) return { ok: false };
  const pricingVariants: Record<string, unknown> = { ...leadV, cells };
  delete pricingVariants.pwp; delete pricingVariants.pwpCode; delete pricingVariants.pwpTriggerLabel;
  delete pricingVariants.buildKey; delete pricingVariants.cellIndex;
  delete pricingVariants.x; delete pricingVariants.y; delete pricingVariants.rot;
  const rec = recomputeFromSnapshot(
    { itemCode: lead.item_code, itemGroup: 'sofa', qty: Number(lead.qty), unitPriceCenti: 0, variants: pricingVariants as MfgItemForRecompute['variants'] },
    prodLite, fabLite, cfg, combos, modulePrices, sellingTiers, addonCfg,
    null, null,   // NO pwp grant — this IS the revert
    specialDefs, null, modelOverridesLead,
  );
  if (rec.unit_price_sen <= 0) return { ok: false };
  const split = splitSofaBuildIntoModuleLines({
    baseModel,
    cells,
    buildUnitPriceSen: rec.unit_price_sen,
    buildUnitCostSen: 0,   // costs stay per-line as already booked
    modulePrices,
  });
  if (!split || split.length !== lines.length) return { ok: false };
  const updates: SofaRewardRevertUpdate[] = lines.map((l, i) => {
    const v: Record<string, unknown> = { ...((l.variants ?? {}) as Record<string, unknown>) };
    delete v.pwp; delete v.pwpCode; delete v.pwpTriggerLabel;
    const unitSenI = split[i]!.unitPriceSen;
    const lqty = Number(l.qty);
    const ldisc = Number(l.discount_centi ?? 0);
    const lTotal = (lqty * unitSenI) - ldisc;
    const lCost = Number(l.line_cost_centi ?? (Number(l.unit_cost_centi ?? 0) * lqty));
    return {
      id: l.id,
      unit_price_centi: unitSenI,
      total_centi: lTotal,
      line_margin_centi: lTotal - lCost,
      variants: v,
      description2: buildVariantSummary('sofa', v) || null,
      divan_price_sen: i === 0 ? rec.breakdown.divanSurchargeSen : 0,
      leg_price_sen: i === 0 ? rec.breakdown.legSurchargeSen : 0,
      special_order_price_sen: i === 0 ? rec.breakdown.specialsSurchargeSen : 0,
      custom_specials: i === 0 ? (rec.custom_specials ?? null) : null,
    };
  });
  return { ok: true, updates };
}

/* TBC sofa exchange (Loo 2026-06-12) — replace a WHOLE sofa build from the
   POS configurator's "Confirm Change". The new build arrives as ONE
   handover-shaped sofa item (variants.cells + depth + fabric / leg /
   specials); the server reprices it on the SAME authoritative path as SO
   create (per-Model module sell prices + combos + fabric-tier Δ + special
   add-ons, drift-gated for POS callers), splits it into per-module lines
   (P3) under the OLD buildKey, inserts the new set, then removes the old —
   so a failure can roll the inserts back without ever losing the build.
   Floor rule: the new build total may not sit below the old one (sales).
   PWP reward sofa builds stay coordinator-only (the reward is combo-bound). */
mfgSalesOrders.post('/:docNo/items/:itemId/tbc-swap-sofa', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo'); const itemId = c.req.param('itemId'); const user = c.get('user');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const item = (body.item ?? null) as { itemCode?: unknown; qty?: unknown; unitPriceCenti?: unknown; description?: unknown; variants?: Record<string, unknown> | null } | null;
  const newCode = String(item?.itemCode ?? '').trim();
  if (!item || !newCode) return c.json({ error: 'item_code_required' }, 400);

  const childLock = await soHasDownstream(sb, docNo);
  if (childLock) return c.json(childLock, 409);
  {
    const procLock = await soProcessingLockBlocked(sb, docNo);
    if (procLock) return c.json(procLock, 409);
  }
  if (await selfScopedSalesBlocked(sb, user.id, docNo)) return c.json({ error: 'not_found' }, 404);

  const { data: prevRow } = await sb.from('mfg_sales_order_items')
    .select('id, item_code, item_group, qty, discount_centi, total_centi, variants, cancelled, line_date, debtor_code, debtor_name, agent, venue, branding, line_delivery_date, line_delivery_date_overridden, warehouse_id, remark')
    .eq('id', itemId).eq('doc_no', docNo).maybeSingle();
  const prev = prevRow as {
    id: string; item_code: string; item_group: string; qty: number; discount_centi: number | null;
    total_centi: number | null; variants: Record<string, unknown> | null; cancelled: boolean;
    line_date: string | null; debtor_code: string | null; debtor_name: string | null; agent: string | null;
    venue: string | null; branding: string | null; line_delivery_date: string | null;
    line_delivery_date_overridden: boolean | null; warehouse_id: string | null; remark: string | null;
  } | null;
  if (!prev) return c.json({ error: 'not_found' }, 404);
  if (prev.cancelled) return c.json({ error: 'line_cancelled' }, 409);
  if (String(prev.item_group) !== 'sofa') {
    return c.json({ error: 'sofa_swap_only', reason: 'This exchange path only replaces sofa builds.' }, 400);
  }
  const prevVariants = ((prev.variants ?? {}) as Record<string, unknown>);
  const buildKey = (prevVariants.buildKey as string | undefined) ?? null;

  /* The whole OLD build — every non-cancelled line sharing the buildKey
     (legacy single-line sofas have no buildKey → just the requested line). */
  let oldLines: Array<{ id: string; item_code: string; total_centi: number | null; variants: Record<string, unknown> | null; photo_urls: string[] | null; line_no?: number | null }> = [];
  if (buildKey) {
    const { data: rows } = await sb.from('mfg_sales_order_items')
      .select('id, item_code, total_centi, variants, photo_urls, line_no')
      .eq('doc_no', docNo).eq('cancelled', false)
      .filter('variants->>buildKey', 'eq', buildKey);
    oldLines = ((rows ?? []) as typeof oldLines);
  }
  if (oldLines.length === 0) {
    const { data: solo } = await sb.from('mfg_sales_order_items')
      .select('id, item_code, total_centi, variants, photo_urls, line_no').eq('id', itemId).maybeSingle();
    if (solo) oldLines = [solo as (typeof oldLines)[number]];
  }
  /* PWP REWARD build (Loo 2026-06-12) — exchangeable: the new build
     re-matches the voucher's reward combos. Matched -> priced at that
     combo's PWP price and the voucher rides on (redeemed_item_code
     re-points). Unmatched -> the build prices as a normal sale and the
     voucher RELEASES back to AVAILABLE: the customer earned it off a
     trigger that still stands, so deleting it would strip a paid-for
     entitlement (the trigger-side path deletes when the JUSTIFICATION
     dies instead). */
  let rewardCtx: { code: string; comboIds: string[]; type: string } | null = null;
  if (oldLines.some((l) => ((l.variants ?? {}) as Record<string, unknown>).pwp)) {
    const codeStr = String(
      oldLines.map((l) => ((l.variants ?? {}) as Record<string, unknown>).pwpCode).find(Boolean) ?? '',
    ).trim();
    if (!codeStr) {
      return c.json({ error: 'pwp_line_locked', reason: 'This PWP reward carries no voucher code — ask the coordinator to exchange it.' }, 409);
    }
    const { data: codeRow } = await sb.from('pwp_codes')
      .select('code, reward_combo_ids, type, redeemed_doc_no')
      .eq('code', codeStr).maybeSingle();
    const ct = codeRow as { code: string; reward_combo_ids: string[] | null; type: string | null; redeemed_doc_no: string | null } | null;
    if (!ct) {
      return c.json({ error: 'pwp_line_locked', reason: 'This PWP voucher could not be found — ask the coordinator to exchange it.' }, 409);
    }
    if (ct.redeemed_doc_no && ct.redeemed_doc_no !== docNo) {
      return c.json({ error: 'pwp_line_locked', reason: 'This voucher is redeemed on a different order — ask the coordinator to exchange it.' }, 409);
    }
    rewardCtx = { code: ct.code, comboIds: ct.reward_combo_ids ?? [], type: String(ct.type ?? 'pwp') };
  }

  /* New build validation — must be a real configurator build on a SOFA SKU. */
  {
    const codeCheck = await validateItemCodes(sb, [newCode]);
    if (!codeCheck.ok) return c.json(unknownItemCodeResponse(codeCheck.unknown), 409);
  }
  const newVariants: Record<string, unknown> = { ...((item.variants ?? {}) as Record<string, unknown>) };
  /* A swap build is a normal sale — strip any PWP markers the configurator
     PWP machinery could have left on the snapshot. Also strip freeItem: a
     sofa swap cannot inject a free-item marker (anti-tamper, Task 6). */
  delete newVariants.pwp; delete newVariants.pwpCode; delete newVariants.pwpTriggerLabel;
  delete newVariants.freeItem;
  const newCells = newVariants.cells;
  if (!Array.isArray(newCells) || newCells.length === 0) {
    return c.json({ error: 'sofa_swap_requires_build', reason: 'Configure the sofa (its modules) before confirming the exchange.' }, 400);
  }
  const prodLite = await loadProductByCode(sb, newCode);
  if (!prodLite || String(prodLite.category).toUpperCase() !== 'SOFA') {
    return c.json({ error: 'sofa_swap_only', reason: 'The replacement must be a sofa.' }, 400);
  }
  {
    const { product, model } = await loadProductAndModel(sb, newCode);
    const aoErr = checkAllowedOptions(product, model, newVariants as Parameters<typeof checkAllowedOptions>[2]);
    if (aoErr) return c.json({ ...aoErr, itemCode: newCode }, 400);
  }

  /* Authoritative reprice — the SAME inputs as SO create / item PATCH. */
  /* Variants-vocabulary unification (port of 2990 73aeeb1e) — dual-read: a
     Backend-loaded swap build may carry the canonical `seatHeight`; POS posts
     `depth`. recomputeFromSnapshot below also reads `depth ?? seatHeight`. */
  const depth = String((newVariants as { depth?: unknown; seatHeight?: unknown }).depth ?? (newVariants as { seatHeight?: unknown }).seatHeight ?? '24');
  const [cfg, fabLite, combos, sellingTiers, fabricAddonCfg, specialDefs, modulePrices, moduleCostRows, modelOverridesSwap] = await Promise.all([
    loadMaintenanceConfig(sb),
    loadFabricByCode(sb, (newVariants.fabricCode as string | undefined) ?? null),
    loadActiveSofaCombos(sb),
    loadFabricSellingTiers(sb, (newVariants.fabricId as string | undefined) ?? null),
    loadFabricTierAddonConfig(sb),
    loadSpecialAddons(sb),
    loadModelSofaModulePrices(sb, prodLite.base_model, depth),
    loadModelSofaModuleCostRows(sb, prodLite.base_model),
    loadModelFabricTierOverrides(sb),
  ]);
  const qty = Math.max(1, Math.floor(Number(item.qty ?? 1)));
  const clientUnit = Math.max(0, Math.round(Number(item.unitPriceCenti ?? 0)));
  /* Does the NEW build match one of the voucher's reward combos? Same
     matcher the engine + POS use. Matched -> the recompute charges those
     combos' PWP prices (pwpSofaComboIds); unmatched -> normal selling. */
  const rewardComboMatch = rewardCtx != null && (() => {
    const comboByIdR = new Map((combos ?? []).map((cb) => [cb.id, cb]));
    const mods = (newCells as Array<{ moduleId?: unknown }>)
      .map((cl) => String(cl?.moduleId ?? '').trim()).filter(Boolean);
    return rewardCtx.comboIds.some((id) => {
      const cb = comboByIdR.get(id);
      if (!cb) return false;
      if (cb.baseModel && cb.baseModel !== (prodLite.base_model ?? '')) return false;
      return matchComboSubset(mods, cb.modules) != null;
    });
  })();
  const recomputed = recomputeFromSnapshot(
    { itemCode: newCode, itemGroup: 'sofa', qty, unitPriceCenti: clientUnit, variants: newVariants as MfgItemForRecompute['variants'] },
    prodLite, fabLite, cfg, combos, modulePrices, sellingTiers, fabricAddonCfg,
    null,
    rewardComboMatch && rewardCtx ? rewardCtx.comboIds : null,
    specialDefs, moduleCostRows, modelOverridesSwap,
  );
  const posTablet = await isPosTabletCaller(sb, user.id);
  /* Reward swaps skip the drift COMPARISON (the POS configurator prices the
     build at normal selling — it has no voucher awareness); the persisted
     figure is the server's authoritative PWP price either way, so a client
     can still never author the money. */
  if (posTablet && recomputed.drift && !rewardCtx) {
    return c.json({
      error: 'pricing_drift',
      reason: 'Client unitPriceCenti differs >0.5% from server compute.',
      itemCode: newCode,
      client: clientUnit,
      server: recomputed.unit_price_sen,
      breakdown: recomputed.breakdown,
    }, 400);
  }
  const unit = recomputed.unit_price_sen;
  const unitCost = recomputed.unit_cost_sen > 0
    ? recomputed.unit_cost_sen
    : await snapshotUnitCostSen(sb, newCode, 0);
  const discount = Number(prev.discount_centi ?? 0);
  const newBuildTotal = (qty * unit) - discount;
  const oldBuildTotal = oldLines.reduce((s, l) => s + Number(l.total_centi ?? 0), 0);
  if (posTablet && newBuildTotal < oldBuildTotal) {
    return c.json({
      error: 'so_total_below_original',
      reason: 'Changes cannot reduce the bill below the original sales order total.',
      previous: oldBuildTotal,
      next: newBuildTotal,
    }, 422);
  }

  /* A still-matched reward keeps its voucher markers — they ride every
     split line like at SO create. An unmatched one stays stripped (normal
     sale; the voucher releases below). */
  if (rewardCtx && rewardComboMatch) {
    newVariants.pwp = true;
    newVariants.pwpCode = rewardCtx.code;
  }

  /* Variants-vocabulary unification (port of 2990 73aeeb1e) — the sofa-exchange
     path is a 4th persist seam (beyond create/add-line/PATCH). Canonicalize
     the swap build's variants into a separate object that feeds ONLY the
     persisted rows (split or single-line below), so they store seatHeight/
     legHeight/fabricCode. Safe: the authoritative reprice (recomputeFromSnapshot
     above, depth load further up) already ran on the raw POS-vocabulary
     `newVariants`, and splitSofaBuildIntoModuleLines below doesn't read `depth`.
     PWP markers added just above are preserved. */
  const persistVariants = canonicalizeVariants('sofa', newVariants);

  /* Split into per-module lines (P3) — same decomposition as SO create. */
  const split = splitSofaBuildIntoModuleLines({
    baseModel: prodLite.base_model ?? null,
    cells: newCells,
    buildUnitPriceSen: unit,
    buildUnitCostSen: unitCost,
    modulePrices,
  });
  const newBuildKey = buildKey ?? `build-x${String(itemId).slice(0, 8)}`;
  const newLeadCode = split?.[0]?.itemCode ?? newCode;

  /* ── PWP dynamic re-evaluation (Loo 2026-06-12) ──────────────────────
     A trigger sofa may be exchanged into ANYTHING — the promotion then
     re-evaluates against the NEW build instead of restricting the swap:
       • a voucher whose rule the new build STILL triggers survives (its
         trigger stamp re-points at the new lead SKU);
       • a voucher whose trigger is GONE: redeemed on THIS order → that
         reward line reverts to its normal price and the code is deleted;
         un-redeemed (AVAILABLE/RESERVED) → the code is deleted;
         redeemed on ANOTHER order → the exchange is blocked (the reward
         was already given out — coordinator only);
       • a rule the new build NEWLY triggers mints fresh vouchers
         (AVAILABLE, customer-bound, printed on the SO).
     Everything is CLASSIFIED here, before any line is written, so a block
     aborts cleanly; the mutations run after the build replacement. */
  type PwpRuleRow = {
    id: string; trigger_category: string; trigger_eligible_model_ids: string[] | null;
    trigger_combo_ids: string[] | null; reward_category: string;
    eligible_reward_model_ids: string[] | null; reward_combo_ids: string[] | null;
    trigger_size_codes: string[] | null; trigger_compartments: string[] | null;
    reward_size_codes: string[] | null; reward_compartments: string[] | null;
    qty_per_trigger: number | null; type: string | null; active: boolean;
  };
  type RewardRevertLine = {
    id: string; item_code: string; item_group: string; qty: number;
    unit_price_centi: number; discount_centi: number | null;
    unit_cost_centi: number | null; variants: Record<string, unknown> | null;
  };
  const pwpKeepCodes: string[] = [];
  const pwpDeleteCodes: string[] = [];
  const pwpRevertCodes: string[] = [];
  const sofaRevertPlans: SofaRewardRevertUpdate[] = [];
  let pwpRules: PwpRuleRow[] = [];
  let pwpNewlyTriggered: PwpRuleRow[] = [];
  let rewardLinesToRevert: RewardRevertLine[] = [];
  {
    const { data: ruleRows } = await sb.from('pwp_rules')
      .select('id, trigger_category, trigger_eligible_model_ids, trigger_combo_ids, reward_category, eligible_reward_model_ids, reward_combo_ids, trigger_size_codes, trigger_compartments, reward_size_codes, reward_compartments, qty_per_trigger, type, active')
      .eq('active', true);
    pwpRules = ((ruleRows ?? []) as PwpRuleRow[]);
    const comboById = new Map((combos ?? []).map((cb) => [cb.id, cb]));
    const newModuleIds = (newCells as Array<{ moduleId?: unknown }>)
      .map((cell) => String(cell?.moduleId ?? '').trim()).filter(Boolean);
    const ruleTriggeredByNewBuild = (r: PwpRuleRow): boolean => {
      const comboIds = r.trigger_combo_ids ?? [];
      if (comboIds.length > 0) {
        return comboIds.some((id) => {
          const cb = comboById.get(id);
          if (!cb) return false;
          if (cb.baseModel && cb.baseModel !== (prodLite.base_model ?? '')) return false;
          return matchComboSubset(newModuleIds, cb.modules) != null;
        });
      }
      return String(r.trigger_category).toUpperCase() === 'SOFA'
        && inList(prodLite.model_id ?? null, r.trigger_eligible_model_ids ?? [])
        // Compartment refinement (0182) — an any-build sofa trigger may require a module.
        && passesRefinementColumns(
          { category: 'SOFA', modelId: prodLite.model_id ?? null, sizeCode: null, builtCompartments: newModuleIds },
          r.trigger_size_codes, r.trigger_compartments,
        );
    };
    const ruleById = new Map(pwpRules.map((r) => [r.id, r]));

    const { data: soCodeRows } = await sb.from('pwp_codes')
      .select('code, rule_id, status, trigger_item_code, redeemed_doc_no')
      .eq('source_doc_no', docNo);
    const soCodes = ((soCodeRows ?? []) as Array<{ code: string; rule_id: string | null; status: string; trigger_item_code: string | null; redeemed_doc_no: string | null }>);
    if (soCodes.length > 0) {
      const oldBuildCodes = new Set(oldLines.map((l) => l.item_code));
      const { data: liveRows } = await sb.from('mfg_sales_order_items')
        .select('item_code').eq('doc_no', docNo).eq('cancelled', false);
      const liveCodes = new Set(((liveRows ?? []) as Array<{ item_code: string }>).map((r) => r.item_code));
      /* Anchored to THIS build: stamp inside the build, or an ORPHANED stamp
         (matches no live line — legacy pre-restamp swaps) whose rule is
         sofa-triggered, adopted by this exchange. */
      const anchored = soCodes.filter((cd) => {
        if (!cd.trigger_item_code) return false;
        if (oldBuildCodes.has(cd.trigger_item_code)) return true;
        if (liveCodes.has(cd.trigger_item_code)) return false;
        const r = cd.rule_id ? ruleById.get(cd.rule_id) : undefined;
        return !!r && ((r.trigger_combo_ids ?? []).length > 0 || String(r.trigger_category).toUpperCase() === 'SOFA');
      });
      for (const cd of anchored) {
        const r = cd.rule_id ? ruleById.get(cd.rule_id) : undefined;
        if (r && ruleTriggeredByNewBuild(r)) { pwpKeepCodes.push(cd.code); continue; }
        if (cd.status === 'USED') {
          if (cd.redeemed_doc_no && cd.redeemed_doc_no !== docNo) {
            return c.json({
              error: 'pwp_trigger_cross_order',
              reason: `This sofa triggered voucher ${cd.code}, already redeemed on ${cd.redeemed_doc_no} — ask the coordinator to exchange it.`,
            }, 409);
          }
          pwpRevertCodes.push(cd.code);
        } else {
          pwpDeleteCodes.push(cd.code);
        }
      }
    }
    if (pwpRevertCodes.length > 0) {
      const { data: pwpLines } = await sb.from('mfg_sales_order_items')
        .select('id, item_code, item_group, qty, unit_price_centi, discount_centi, unit_cost_centi, variants')
        .eq('doc_no', docNo).eq('cancelled', false)
        .filter('variants->>pwp', 'eq', 'true');
      const revertSet = new Set(pwpRevertCodes);
      const allRevertLines = ((pwpLines ?? []) as RewardRevertLine[])
        .filter((l) => revertSet.has(String(((l.variants ?? {}) as Record<string, unknown>).pwpCode ?? '')));
      rewardLinesToRevert = allRevertLines.filter((l) => String(l.item_group) !== 'sofa');
      /* Sofa rewards revert as a WHOLE build (read-only plan first - a
         build that can't be safely repriced blocks before any write). */
      const sofaRevertCodes = [...new Set(allRevertLines
        .filter((l) => String(l.item_group) === 'sofa')
        .map((l) => String(((l.variants ?? {}) as Record<string, unknown>).pwpCode ?? ''))
        .filter(Boolean))];
      for (const cdx of sofaRevertCodes) {
        const plan = await planSofaRewardRevert(sb, docNo, cdx);
        if (!plan.ok) {
          return c.json({
            error: 'pwp_reward_sofa_revert_unsupported',
            reason: 'The sofa reward this voucher paid for cannot be auto-repriced — ask the coordinator to exchange it.',
          }, 409);
        }
        sofaRevertPlans.push(...plan.updates);
      }
    }
    /* Promo one-way (PWP-7615UAWC): a build that is still a REWARD must
       never mint trigger vouchers of its own — free funding free, forever. */
    pwpNewlyTriggered = (rewardCtx && rewardComboMatch) ? [] : pwpRules.filter(ruleTriggeredByNewBuild);
  }
  const baseRow = {
    doc_no: docNo,
    line_date: prev.line_date ?? todayMyt(),
    debtor_code: prev.debtor_code,
    debtor_name: prev.debtor_name,
    agent: prev.agent,
    item_group: 'sofa',
    uom: 'UNIT',
    qty,
    venue: prev.venue,
    branding: prev.branding,
    line_delivery_date: prev.line_delivery_date,
    line_delivery_date_overridden: Boolean(prev.line_delivery_date_overridden ?? false),
    warehouse_id: prev.warehouse_id,
    stock_status: 'PENDING',
    remark: (newVariants.remark as string | undefined) ?? null,
  };
  let rows: Array<Record<string, unknown>>;
  if (split && split.length > 0) {
    const { cells: _cells, ...sharedVariants } = persistVariants;
    rows = split.map((s, i) => {
      const moduleVariants: Record<string, unknown> = {
        ...sharedVariants, buildKey: newBuildKey, cellIndex: s.cellIndex, x: s.x, y: s.y, rot: s.rot,
      };
      const moduleLineTotal = (qty * s.unitPriceSen) - (i === 0 ? discount : 0);
      const moduleLineCost = qty * s.unitCostSen;
      return {
        ...baseRow,
        item_code: s.itemCode,
        description: s.description,
        description2: buildVariantSummary('sofa', moduleVariants) || null,
        unit_price_centi: s.unitPriceSen,
        discount_centi: i === 0 ? discount : 0,
        total_centi: moduleLineTotal,
        total_inc_centi: moduleLineTotal,
        balance_centi: moduleLineTotal,
        variants: moduleVariants,
        unit_cost_centi: s.unitCostSen,
        line_cost_centi: moduleLineCost,
        line_margin_centi: moduleLineTotal - moduleLineCost,
        divan_price_sen: i === 0 ? recomputed.breakdown.divanSurchargeSen : 0,
        leg_price_sen: i === 0 ? recomputed.breakdown.legSurchargeSen : 0,
        special_order_price_sen: i === 0 ? recomputed.breakdown.specialsSurchargeSen : 0,
        custom_specials: i === 0 ? (recomputed.custom_specials ?? null) : null,
      };
    });
  } else {
    /* Unknown base model — keep the legacy single-line shape (cells inline). */
    const lineTotal = (qty * unit) - discount;
    rows = [{
      ...baseRow,
      item_code: newCode,
      description: String(item.description ?? newCode),
      description2: buildVariantSummary('sofa', persistVariants) || null,
      unit_price_centi: unit,
      discount_centi: discount,
      total_centi: lineTotal,
      total_inc_centi: lineTotal,
      balance_centi: lineTotal,
      variants: persistVariants,
      unit_cost_centi: unitCost,
      line_cost_centi: unitCost * qty,
      line_margin_centi: lineTotal - (unitCost * qty),
      divan_price_sen: recomputed.breakdown.divanSurchargeSen,
      leg_price_sen: recomputed.breakdown.legSurchargeSen,
      special_order_price_sen: recomputed.breakdown.specialsSurchargeSen,
      custom_specials: recomputed.custom_specials ?? null,
    }];
  }

  /* 0165 — the replacement build INHERITS the old build's position: new rows
     number from the old set's lowest line_no (un-numbered docs stay NULL).
     A different module count can overlap following numbers — ordering-only,
     and the read-side rank/walk re-derive keeps the rules intact. */
  {
    const oldNos = oldLines
      .map((l) => l.line_no)
      .filter((n): n is number => typeof n === 'number');
    if (oldNos.length > 0) {
      const base = Math.min(...oldNos);
      rows = rows.map((r, i) => ({ ...r, line_no: base + i }));
    }
  }

  /* Insert the NEW set first, then remove the OLD — an insert failure leaves
     the order untouched; a delete failure rolls the inserts back. */
  const { data: inserted, error: insErr } = await sb.from('mfg_sales_order_items').insert(rows).select('id');
  if (insErr) return c.json({ error: 'insert_failed', reason: insErr.message }, 500);
  const oldIds = oldLines.map((l) => l.id);
  const { error: delErr } = await sb.from('mfg_sales_order_items').delete().in('id', oldIds);
  if (delErr) {
    const newIds = ((inserted ?? []) as Array<{ id: string }>).map((r) => r.id);
    if (newIds.length > 0) await sb.from('mfg_sales_order_items').delete().in('id', newIds);
    return c.json({ error: 'swap_failed', reason: delErr.message }, 500);
  }

  /* Old build photos → best-effort R2 cleanup (same as line DELETE). */
  if (c.env.SO_ITEM_PHOTOS) {
    for (const l of oldLines) {
      for (const key of (l.photo_urls ?? [])) {
        try { await c.env.SO_ITEM_PHOTOS.delete(key); }
        catch (e) { console.warn('[tbc-swap-sofa] photo cleanup failed for', key, e); } // eslint-disable-line no-console
      }
    }
  }

  /* ── PWP mutations (classified above, applied after the build landed) ── */
  const pwpMintedCodes: string[] = [];
  let pwpVoucherReleased: string | null = null;
  /* Sofa-reward builds stranded by this exchange revert via the
     pre-computed whole-build plan. */
  for (const u of sofaRevertPlans) {
    const { id: uid, ...cols } = u;
    const { error } = await sb.from('mfg_sales_order_items').update({
      ...cols,
      total_inc_centi: cols.total_centi,
      balance_centi: cols.total_centi,
    }).eq('id', uid);
    if (error) console.error('[tbc-swap-sofa] sofa reward revert failed for', uid, error.message); // eslint-disable-line no-console
  }
  if (rewardCtx) {
    if (rewardComboMatch) {
      const { error } = await sb.from('pwp_codes')
        .update({ redeemed_item_code: newLeadCode, updated_at: new Date().toISOString() })
        .eq('code', rewardCtx.code);
      if (error) console.error('[tbc-swap-sofa] reward code re-point failed:', error.message); // eslint-disable-line no-console
    } else {
      const { error } = await sb.from('pwp_codes')
        .update({ status: 'AVAILABLE', redeemed_doc_no: null, redeemed_item_code: null, updated_at: new Date().toISOString() })
        .eq('code', rewardCtx.code);
      if (error) console.error('[tbc-swap-sofa] reward code release failed:', error.message); // eslint-disable-line no-console
      else pwpVoucherReleased = rewardCtx.code;
    }
  }
  {
    // 1. Surviving vouchers re-point at the new lead SKU.
    if (pwpKeepCodes.length > 0) {
      const { error } = await sb.from('pwp_codes')
        .update({ trigger_item_code: newLeadCode, updated_at: new Date().toISOString() })
        .in('code', pwpKeepCodes);
      if (error) console.error('[tbc-swap-sofa] keep-code restamp failed:', error.message); // eslint-disable-line no-console
    }
    // 2. Rewards whose trigger is gone revert to their normal price (the PWP
    //    base is replaced by the catalog-authoritative figure; picks and their
    //    surcharges survive). clientUnit 0 → the recompute FILLS the
    //    authoritative price without a drift reject.
    for (const line of rewardLinesToRevert) {
      const v: Record<string, unknown> = { ...((line.variants ?? {}) as Record<string, unknown>) };
      delete v.pwp; delete v.pwpCode; delete v.pwpTriggerLabel;
      const [rp, rfab, rtiers] = await Promise.all([
        loadProductByCode(sb, line.item_code),
        loadFabricByCode(sb, (v.fabricCode as string | undefined) ?? null),
        loadFabricSellingTiers(sb, (v.fabricId as string | undefined) ?? null),
      ]);
      const rec = recomputeFromSnapshot(
        { itemCode: line.item_code, itemGroup: String(line.item_group ?? 'others'), qty: Number(line.qty), unitPriceCenti: 0, variants: v as MfgItemForRecompute['variants'] },
        rp, rfab, cfg, null, null, rtiers, fabricAddonCfg, null, null, specialDefs, null, modelOverridesSwap,
      );
      const revertUnit = rec.unit_price_sen > 0 ? rec.unit_price_sen : Number(line.unit_price_centi);
      const lqty = Number(line.qty);
      const ldisc = Number(line.discount_centi ?? 0);
      const lTotal = (lqty * revertUnit) - ldisc;
      const lCost = Number(line.unit_cost_centi ?? 0);
      const { error } = await sb.from('mfg_sales_order_items').update({
        variants: v,
        description2: buildVariantSummary(String(line.item_group ?? ''), v) || null,
        unit_price_centi: revertUnit,
        total_centi: lTotal,
        total_inc_centi: lTotal,
        balance_centi: lTotal,
        line_margin_centi: lTotal - (lCost * lqty),
        divan_price_sen: rec.breakdown.divanSurchargeSen,
        leg_price_sen: rec.breakdown.legSurchargeSen,
        special_order_price_sen: rec.breakdown.specialsSurchargeSen,
        custom_specials: rec.custom_specials ?? null,
      }).eq('id', line.id);
      if (error) console.error('[tbc-swap-sofa] reward revert failed for', line.id, error.message); // eslint-disable-line no-console
    }
    // 3. Dead vouchers go (un-redeemed + the reverted ones — Loo: delete).
    const toDelete = [...pwpDeleteCodes, ...pwpRevertCodes];
    if (toDelete.length > 0) {
      const { error } = await sb.from('pwp_codes').delete().in('code', toDelete);
      if (error) console.error('[tbc-swap-sofa] code delete failed:', error.message); // eslint-disable-line no-console
    }
    // 4. Newly-triggered rules mint fresh vouchers (AVAILABLE, customer-bound,
    //    printed on the SO) — topped up against the surviving codes per rule.
    if (pwpNewlyTriggered.length > 0) {
      const { data: hdr } = await sb.from('mfg_sales_orders').select('customer_id').eq('doc_no', docNo).maybeSingle();
      const customerId = ((hdr as { customer_id?: string | null } | null)?.customer_id) ?? null;
      const { data: keptRows } = pwpKeepCodes.length > 0
        ? await sb.from('pwp_codes').select('code, rule_id').in('code', pwpKeepCodes)
        : { data: [] };
      const keptByRule = new Map<string, number>();
      for (const k of ((keptRows ?? []) as Array<{ rule_id: string | null }>)) {
        if (k.rule_id) keptByRule.set(k.rule_id, (keptByRule.get(k.rule_id) ?? 0) + 1);
      }
      for (const r of pwpNewlyTriggered) {
        const target = Math.max(0, Math.floor((Number(r.qty_per_trigger) || 1) * qty));
        const have = keptByRule.get(r.id) ?? 0;
        for (let i = have; i < target; i++) {
          for (let attempt = 0; attempt < 5; attempt++) {
            const code = genCode();
            const { error } = await sb.from('pwp_codes').insert({
              code,
              rule_id: r.id,
              reward_category: r.reward_category,
              eligible_reward_model_ids: r.eligible_reward_model_ids ?? [],
              reward_combo_ids: r.reward_combo_ids ?? [],
              reward_size_codes: r.reward_size_codes ?? [],
              reward_compartments: r.reward_compartments ?? [],
              type: r.type ?? 'pwp',
              status: 'AVAILABLE',
              owner_staff_id: user.id,
              cart_line_key: null,
              trigger_item_code: newLeadCode,
              source_doc_no: docNo,
              customer_id: customerId,
            });
            if (!error) { pwpMintedCodes.push(code); break; }
            if (attempt === 4) console.error('[tbc-swap-sofa] voucher mint failed:', error.message); // eslint-disable-line no-console
          }
        }
      }
    }
  }

  // Default Free Gift (0170) — runs AFTER the sofa PWP re-evaluation above, in
  // place of the final recomputeTotals: a sofa build swap can newly match (or
  // stop matching) a gifting combo, so reconcile syncs the accessory gift lines
  // and then recomputes header totals.
  await reconcileFreeGiftLinesForSo(sb, docNo);
  // Re-derive the delivery fee — a sofa build swap can flip a cross-category mix
  // or a special-delivery trigger (model/combo/compartment). Source kept.
  await rederiveDeliveryFee(sb, docNo);
  await recordSoAudit(sb, {
    docNo,
    action: 'UPDATE_LINE',
    actorId: user.id,
    actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
    fieldChanges: [
      { field: 'itemCode', from: prev.item_code, to: split?.[0]?.itemCode ?? newCode },
      { field: 'sofaBuild', from: `${oldLines.length} lines`, to: `${rows.length} lines` },
      { field: 'totalCenti', from: oldBuildTotal, to: newBuildTotal },
      ...(pwpRevertCodes.length > 0
        ? [{ field: 'pwpRewardsReverted', to: pwpRevertCodes.join(', ') } satisfies FieldChange] : []),
      ...(pwpDeleteCodes.length > 0
        ? [{ field: 'pwpCodesDeleted', to: pwpDeleteCodes.join(', ') } satisfies FieldChange] : []),
      ...(pwpMintedCodes.length > 0
        ? [{ field: 'pwpCodesMinted', to: pwpMintedCodes.join(', ') } satisfies FieldChange] : []),
      ...(rewardCtx && rewardComboMatch
        ? [{ field: 'pwpRewardKept', to: rewardCtx.code } satisfies FieldChange] : []),
      ...(pwpVoucherReleased
        ? [{ field: 'pwpVoucherReleased', to: pwpVoucherReleased } satisfies FieldChange] : []),
    ],
  });
  try { await recomputeSoStockAllocation(sb); }
  catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-allocation] post-tbc-swap-sofa failed:', e); }

  return c.json({
    ok: true,
    totalCenti: newBuildTotal,
    lines: rows.length,
    pwp: {
      kept: pwpKeepCodes.length,
      reverted: pwpRevertCodes.length,
      deleted: pwpDeleteCodes.length,
      minted: pwpMintedCodes,
      rewardKept: rewardCtx && rewardComboMatch ? rewardCtx.code : null,
      rewardReleased: pwpVoucherReleased,
    },
  });
});

// ── Per-line photos — PR-F (migration 0076) ──────────────────────────
//
// Commander 2026-05-27: customisation orders attach photos per line
// (color swatches, sketches, customer-supplied refs). HOOKKA's
// AutoCount-style detail view shows a "Photo" column on each line; we
// mirror that with an R2-backed photo array on every SO item.
//
// Storage: keys live in mfg_sales_order_items.photo_urls (text[]),
// objects live in the SO_ITEM_PHOTOS R2 bucket (private). The proxy
// GET endpoint streams bytes back so the bucket itself never needs
// public access. A custom domain (e.g. r2.2990s.com) can replace the
// proxy later — until then this is the only read path.
//
// Key layout: so-items/<docNo>/<itemId>/<uuid>.<ext>
//   The docNo + itemId prefix keeps the bucket browseable by SO and
//   makes lifecycle policies (delete-on-cancel) straightforward.

const MAX_PHOTO_BYTES = 10 * 1024 * 1024; // 10 MB

const extFromMime = (mime: string): string => {
  // Conservative whitelist — image/* only. Fallback to 'bin' if a
  // browser-supplied subtype isn't recognised; the bucket-key suffix
  // is cosmetic (Content-Type stored as R2 metadata).
  const m = mime.toLowerCase();
  if (m === 'image/jpeg' || m === 'image/jpg') return 'jpg';
  if (m === 'image/png')                       return 'png';
  if (m === 'image/webp')                      return 'webp';
  if (m === 'image/gif')                       return 'gif';
  if (m === 'image/heic')                      return 'heic';
  if (m === 'image/heif')                      return 'heif';
  if (m === 'image/avif')                      return 'avif';
  if (m.startsWith('image/'))                  return 'bin';
  return '';
};

mfgSalesOrders.post('/:docNo/items/:itemId/photos', async (c) => {
  const sb = c.get('supabase');
  const docNo = c.req.param('docNo');
  const itemId = c.req.param('itemId');
  const user = c.get('user');
  // Audit 2026-06-20 — self-scoped sales may only touch their OWN SO (mirror the line/header guards).
  if (await selfScopedSalesBlocked(sb, user.id, docNo)) return c.json({ error: 'not_found' }, 404);

  if (!c.env.SO_ITEM_PHOTOS) {
    return c.json({ error: 'photo_bucket_not_configured' }, 500);
  }

  // Verify the line exists + belongs to this SO. Cheaper to fail here
  // than after a multi-MB upload to R2.
  const { data: item, error: itemErr } = await sb
    .from('mfg_sales_order_items')
    .select('id, doc_no, item_code, photo_urls')
    .eq('id', itemId)
    .maybeSingle();
  if (itemErr) return c.json({ error: 'item_lookup_failed', reason: itemErr.message }, 500);
  if (!item) return c.json({ error: 'item_not_found' }, 404);
  const i = item as { id: string; doc_no: string; item_code: string; photo_urls: string[] | null };
  if (i.doc_no !== docNo) return c.json({ error: 'item_doc_mismatch' }, 400);

  // Parse multipart body via Hono's c.req.parseBody(). The slip route
  // uses presigned URLs (out-of-band PUT) — this route is the
  // simpler proxy path because per-item photo files are small (<10 MB)
  // and commander wants drag-drop straight from the line card without
  // a two-step handshake.
  let form: Record<string, unknown>;
  try {
    form = await c.req.parseBody();
  } catch (e) {
    return c.json({ error: 'invalid_multipart', reason: e instanceof Error ? e.message : String(e) }, 400);
  }
  const file = form.file as File | undefined;
  if (!file || typeof file === 'string') return c.json({ error: 'file_field_required' }, 400);

  if (!file.type || !file.type.toLowerCase().startsWith('image/')) {
    return c.json({ error: 'invalid_mime', got: file.type || '(none)' }, 400);
  }
  if (file.size > MAX_PHOTO_BYTES) {
    return c.json({ error: 'file_too_large', maxBytes: MAX_PHOTO_BYTES, got: file.size }, 400);
  }

  const photoId = crypto.randomUUID();
  const ext = extFromMime(file.type) || 'bin';
  const photoKey = `so-items/${docNo}/${itemId}/${photoId}.${ext}`;

  try {
    await c.env.SO_ITEM_PHOTOS.put(photoKey, file.stream(), {
      httpMetadata: { contentType: file.type },
      customMetadata: {
        docNo,
        itemId,
        itemCode: i.item_code,
        uploadedBy: user.id,
      },
    });
  } catch (e) {
    return c.json({ error: 'r2_put_failed', reason: e instanceof Error ? e.message : String(e) }, 500);
  }

  // Append the new key to photo_urls. Pulled-then-pushed (rather than
  // a Postgres array_append RPC) so the call stays inside the standard
  // Supabase REST surface — supabase-js doesn't expose array operators.
  const nextKeys = [...(i.photo_urls ?? []), photoKey];
  const { error: updErr } = await sb
    .from('mfg_sales_order_items')
    .update({ photo_urls: nextKeys })
    .eq('id', itemId);
  if (updErr) {
    // Rollback the R2 object so we don't leak a dangling blob.
    await c.env.SO_ITEM_PHOTOS.delete(photoKey).catch(() => {});
    return c.json({ error: 'db_update_failed', reason: updErr.message }, 500);
  }

  // PR-D — emit an ADD_LINE-style audit row noting the photo addition.
  // Reuses UPDATE_LINE so the History panel groups it with other line
  // edits; itemCode prefix gives the timeline a human label.
  await recordSoAudit(sb, {
    docNo,
    action: 'UPDATE_LINE',
    actorId: user.id,
    actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
    fieldChanges: [
      { field: 'itemCode', to: i.item_code },
      { field: 'photoAdded', to: photoKey },
    ],
  });

  // Task #92 — return a short-lived signed GET URL alongside the key.
  // Frontend uses this directly as <img src> (no Worker proxy roundtrip
  // on first render). When the URL expires the frontend re-fetches via
  // GET /photos/:photoKey/signed. Falling back to the legacy proxy path
  // here keeps existing callers (and stale clients) working until a
  // post-deploy cleanup removes the proxy entirely.
  try {
    const bindings = soItemPhotoBindings(c.env);
    const { signedUrl, expiresAt } = await signSoItemPhotoUrl(bindings, photoKey);
    return c.json({ photoKey, photoUrl: signedUrl, expiresAt }, 201);
  } catch (e) {
    // Signing should never fail in production (creds + endpoint validated
    // at boot), but if it does we fall back to the proxy URL rather than
    // losing the upload — the row is already inserted.
    const photoUrl = `/mfg-sales-orders/${docNo}/items/${itemId}/photos/${encodeURIComponent(photoKey)}`;
    // eslint-disable-next-line no-console
    console.warn('[so-item-photo] signing failed, falling back to proxy:', e);
    return c.json({ photoKey, photoUrl }, 201);
  }
});

// Task #92 — refresh a signed GET URL for an existing key. Frontend
// hits this on mount when no cached URL exists for a key, and on a
// 403 (URL expired). Auth-checked the same way as the proxy: the key
// must belong to this SO+item and currently be in photo_urls.
mfgSalesOrders.get('/:docNo/items/:itemId/photos/:photoKey/signed', async (c) => {
  const sb = c.get('supabase');
  const docNo = c.req.param('docNo');
  const itemId = c.req.param('itemId');
  const photoKey = decodeURIComponent(c.req.param('photoKey'));

  const { data: item } = await sb
    .from('mfg_sales_order_items')
    .select('doc_no, photo_urls')
    .eq('id', itemId)
    .maybeSingle();
  if (!item) return c.json({ error: 'item_not_found' }, 404);
  const i = item as { doc_no: string; photo_urls: string[] | null };
  if (i.doc_no !== docNo) return c.json({ error: 'item_doc_mismatch' }, 400);
  if (!(i.photo_urls ?? []).includes(photoKey)) {
    return c.json({ error: 'photo_not_in_item' }, 404);
  }

  try {
    const bindings = soItemPhotoBindings(c.env);
    const { signedUrl, expiresAt } = await signSoItemPhotoUrl(bindings, photoKey);
    return c.json({ signedUrl, expiresAt });
  } catch (e) {
    return c.json({ error: 'signing_failed', reason: e instanceof Error ? e.message : String(e) }, 500);
  }
});

/**
 * @deprecated Task #92 — superseded by signed-URL flow. The frontend
 * now reads photos directly from R2 via short-lived signed URLs minted
 * by `GET /photos/:photoKey/signed`. This proxy endpoint is retained
 * as a fallback for legacy clients holding old proxy URLs in the wild;
 * remove after the post-deploy cooldown (~7 days, longer than any
 * signed-URL TTL or cached page load).
 */
mfgSalesOrders.get('/:docNo/items/:itemId/photos/:photoKey', async (c) => {
  const sb = c.get('supabase');
  const docNo = c.req.param('docNo');
  const itemId = c.req.param('itemId');
  const photoKey = decodeURIComponent(c.req.param('photoKey'));

  if (!c.env.SO_ITEM_PHOTOS) {
    return c.json({ error: 'photo_bucket_not_configured' }, 500);
  }

  // Authorise: the photo key must belong to this SO+item AND be
  // currently listed in photo_urls. Prevents enumeration of unrelated
  // objects via a guessed key.
  const { data: item } = await sb
    .from('mfg_sales_order_items')
    .select('doc_no, photo_urls')
    .eq('id', itemId)
    .maybeSingle();
  if (!item) return c.json({ error: 'item_not_found' }, 404);
  const i = item as { doc_no: string; photo_urls: string[] | null };
  if (i.doc_no !== docNo) return c.json({ error: 'item_doc_mismatch' }, 400);
  if (!(i.photo_urls ?? []).includes(photoKey)) {
    return c.json({ error: 'photo_not_in_item' }, 404);
  }

  const obj = await c.env.SO_ITEM_PHOTOS.get(photoKey);
  if (!obj) return c.json({ error: 'photo_not_found_in_r2' }, 404);

  const contentType =
    obj.httpMetadata?.contentType ?? 'application/octet-stream';
  return new Response(obj.body, {
    headers: {
      'content-type': contentType,
      // 1-hour browser cache. Photos are immutable per key (new uploads
      // get a new uuid), so this is safe.
      'cache-control': 'private, max-age=3600',
    },
  });
});

mfgSalesOrders.delete('/:docNo/items/:itemId/photos/:photoKey', async (c) => {
  const sb = c.get('supabase');
  const docNo = c.req.param('docNo');
  const itemId = c.req.param('itemId');
  const photoKey = decodeURIComponent(c.req.param('photoKey'));
  const user = c.get('user');
  // Audit 2026-06-20 — self-scoped sales may only touch their OWN SO (mirror the line/header guards).
  if (await selfScopedSalesBlocked(sb, user.id, docNo)) return c.json({ error: 'not_found' }, 404);

  if (!c.env.SO_ITEM_PHOTOS) {
    return c.json({ error: 'photo_bucket_not_configured' }, 500);
  }

  const { data: item } = await sb
    .from('mfg_sales_order_items')
    .select('doc_no, item_code, photo_urls')
    .eq('id', itemId)
    .maybeSingle();
  if (!item) return c.json({ error: 'item_not_found' }, 404);
  const i = item as { doc_no: string; item_code: string; photo_urls: string[] | null };
  if (i.doc_no !== docNo) return c.json({ error: 'item_doc_mismatch' }, 400);
  const existing = i.photo_urls ?? [];
  if (!existing.includes(photoKey)) {
    return c.json({ error: 'photo_not_in_item' }, 404);
  }

  const nextKeys = existing.filter((k) => k !== photoKey);
  const { error: updErr } = await sb
    .from('mfg_sales_order_items')
    .update({ photo_urls: nextKeys })
    .eq('id', itemId);
  if (updErr) return c.json({ error: 'db_update_failed', reason: updErr.message }, 500);

  // R2 delete best-effort — if it fails we've already removed the key
  // from the array, so the orphan is invisible to the UI. A future
  // reaper job could sweep for dangling objects.
  await c.env.SO_ITEM_PHOTOS.delete(photoKey).catch(() => {});

  await recordSoAudit(sb, {
    docNo,
    action: 'UPDATE_LINE',
    actorId: user.id,
    actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
    fieldChanges: [
      { field: 'itemCode', to: i.item_code },
      { field: 'photoRemoved', from: photoKey, to: null },
    ],
  });

  return c.json({ ok: true });
});

// ── Payments — PR #163 (migration 0073) ───────────────────────────────
//
// HOOKKA-style transaction ledger per SO. Each row is one receipt /
// auth slip. UI lists them, sums into a "Deposit Paid" total, and the
// balance computes from header.local_total_centi − sum(amount_centi).
//
// Legacy single-row payment fields on mfg_sales_orders (payment_method,
/* Account Sheet auto-fill (Loo 2026-06-07) — "where did the money land".
   Derived from the payment's own method fields whenever the operator didn't
   type one, so the Detail Listing column stops rendering dashes:
     merchant / installment → the acquiring bank (merchant_provider)
     transfer               → the online sub-type (DuitNow / TNG / …)
     cash                   → 'Cash'
   A hand-typed value (Finance, backend PaymentsTable) ALWAYS wins — this is
   a default, not an overwrite. Hoisted `function` so the SO-create deposit
   paths above can call it too. */
function deriveAccountSheet(
  method: string,
  merchantProvider?: string | null,
  onlineType?: string | null,
): string {
  if (method === 'merchant' || method === 'installment') {
    return merchantProvider?.trim() || 'Card terminal';
  }
  if (method === 'transfer') return onlineType?.trim() || 'Bank transfer';
  return 'Cash';
}

// merchant_provider, installment_months, approval_code, payment_date,
// paid_centi) are NOT touched here — those columns are scheduled for
// drop in a follow-up migration once live data is migrated.
const PAYMENT_COLS =
  'id, so_doc_no, paid_at, method, merchant_provider, installment_months, ' +
  'online_type, approval_code, amount_centi, account_sheet, slip_key, collected_by, note, ' +
  'created_at, created_by';

mfgSalesOrders.get('/:docNo/payments', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo');
  const { data, error } = await sb
    .from('mfg_sales_order_payments')
    .select(`${PAYMENT_COLS}, staff:collected_by ( name )`)
    .eq('so_doc_no', docNo)
    .order('paid_at', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  // Flatten the joined `staff.name` onto `collected_by_name` so the UI
  // doesn't need to drill into a nested object.
  const payments = (data ?? []).map((r: unknown) => {
    const row = r as Record<string, unknown> & { staff: { name: string } | null };
    const { staff, ...rest } = row;
    return { ...rest, collected_by_name: staff?.name ?? null };
  });
  return c.json({ payments });
});

/* Task #122 (cascade) — Method is a 3-step pick now. merchantProvider was
   a fixed 4-bank enum and installmentMonths was 6|12 only; both widened.
   Banks are now an open-ended text field sourced from
   so_dropdown_options('payment_merchant'). Installment plans likewise come
   from so_dropdown_options('installment_plan') and are sent here as an
   integer 0..60 (0 = "One-off", which we coerce to NULL below). A new
   onlineType field carries the Online sub-type (Bank Transfer / TNG /
   Cheque / DuitNow). */
const paymentCreateSchema = z.object({
  paidAt:             z.string().min(1),
  /* 2026-06-06 payment-method unify — 'installment' joins the manual route.
     It was already a first-class method on the POS deposit path (SO create
     writes method='installment' raw); now Finance can record installment
     receipts directly too. Kept in sync with PAYMENT_METHOD_CODES in
     packages/shared/src/payment-methods.ts. */
  method:             z.enum(['merchant', 'transfer', 'cash', 'installment']),
  merchantProvider:   z.string().trim().min(1).optional().nullable(),
  installmentMonths:  z.number().int().min(0).max(60).optional().nullable(),
  onlineType:         z.string().trim().min(1).optional().nullable(),
  approvalCode:       z.string().optional().nullable(),
  amountCenti:        z.number().int().nonnegative(),
  accountSheet:       z.string().optional().nullable(),
  collectedBy:        z.string().uuid().optional().nullable(),
  note:               z.string().optional().nullable(),
  /* Spec D4 (2026-06-06) — every payment carries its own slip. The client
     uploads via /slips/init + confirm and sends the session id here. */
  uploadSessionId:    z.string().min(1),
});

/* ── recordSoPaymentRow — the factored insert+audit core of
   POST /:docNo/payments (same pattern as createSalesOrderCore). ONE place
   derives the method-scoped fields (merchant/installment vs transfer vs cash),
   auto-fills the Account Sheet, inserts the mfg_sales_order_payments row and
   appends the ADD_PAYMENT audit entry. The HTTP route keeps its own guards
   (self-scope, SO existence, overpayment, slip-session resolution + promote)
   and calls this for the write; the background scan job (scan-so.ts) calls it
   directly with an R2 key it already owns (scan-jobs/{jobId}/{n}) — payment
   field derivation is never reimplemented outside this function. */
export type SoPaymentRowInput = {
  docNo: string;
  paidAt: string;
  method: 'merchant' | 'transfer' | 'cash' | 'installment';
  merchantProvider?: string | null;
  installmentMonths?: number | null;
  onlineType?: string | null;
  approvalCode?: string | null;
  amountCenti: number;
  accountSheet?: string | null;
  slipKey: string | null;
  collectedBy?: string | null;
  note?: string | null;
  createdBy: string;
  actorName?: string | null;
  /* First-deposit marker — the list/detail paid-rollup adds the header
     deposit_centi on top of the ledger UNLESS an is_deposit row marks the
     deposit as already booked (migration 0155 semantics). The scan job's
     first receipt row IS the header deposit, so it sets this. */
  isDeposit?: boolean;
  auditSource?: string;
  auditNote?: string;
};

export async function recordSoPaymentRow(
  sb: any,
  p: SoPaymentRowInput,
): Promise<{ payment: Record<string, unknown> | null; errorMessage: string | null }> {
  // Method-scoped fields per the cascade:
  //   merchant    → merchant_provider + installment_months (0 / null = One-off)
  //   installment → merchant_provider + installment_months (merchant-like —
  //                 mirrors the SO-create deposit path, which keeps both)
  //   transfer    → online_type
  //   cash        → no extras
  const merchantLike      = p.method === 'merchant' || p.method === 'installment';
  const merchantProvider  = merchantLike ? (p.merchantProvider ?? null) : null;
  // 0 = "One-off" — store as NULL so the integer column carries semantic
  // "no installment". Anything > 0 is the term in months.
  const installmentMonths = merchantLike
    ? (typeof p.installmentMonths === 'number' && p.installmentMonths > 0 ? p.installmentMonths : null)
    : null;
  const onlineType        = p.method === 'transfer' ? (p.onlineType ?? null) : null;

  const { data, error } = await sb.from('mfg_sales_order_payments').insert({
    so_doc_no:          p.docNo,
    paid_at:            p.paidAt,
    method:             p.method,
    merchant_provider:  merchantProvider,
    installment_months: installmentMonths,
    online_type:        onlineType,
    approval_code:      p.approvalCode ?? null,
    amount_centi:       p.amountCenti,
    /* Account Sheet auto-fill (Loo 2026-06-07) — a hand-typed value wins;
       blank/whitespace falls back to the method-derived default. */
    account_sheet:      p.accountSheet?.trim() || deriveAccountSheet(p.method, merchantProvider, onlineType),
    slip_key:           p.slipKey,
    collected_by:       p.collectedBy ?? null,
    note:               p.note ?? null,
    created_by:         p.createdBy,
    /* Only set when explicitly asked — the manual route's rows are balance
       payments and keep the column default (false). */
    ...(p.isDeposit === true ? { is_deposit: true } : {}),
  }).select(PAYMENT_COLS).single();
  if (error) return { payment: null, errorMessage: error.message };

  /* Post-merge stitch — wire ADD_PAYMENT into the PR-D audit ledger.
     Field-changes list mirrors what the user typed so the History panel
     can render a readable diff. Best-effort inside recordSoAudit. */
  await recordSoAudit(sb, {
    docNo: p.docNo,
    action: 'ADD_PAYMENT',
    actorId: p.createdBy,
    actorName: p.actorName ?? null,
    ...(p.auditSource ? { source: p.auditSource } : {}),
    ...(p.auditNote ? { note: p.auditNote } : {}),
    fieldChanges: [
      { field: 'paidAt',             from: null, to: p.paidAt },
      { field: 'method',             from: null, to: p.method },
      { field: 'amountCenti',        from: null, to: p.amountCenti },
      ...(merchantProvider  ? [{ field: 'merchantProvider',  from: null, to: merchantProvider  } satisfies FieldChange] : []),
      ...(installmentMonths ? [{ field: 'installmentMonths', from: null, to: installmentMonths } satisfies FieldChange] : []),
      ...(onlineType        ? [{ field: 'onlineType',        from: null, to: onlineType        } satisfies FieldChange] : []),
      ...(p.approvalCode    ? [{ field: 'approvalCode',      from: null, to: p.approvalCode    } satisfies FieldChange] : []),
      ...(p.accountSheet    ? [{ field: 'accountSheet',      from: null, to: p.accountSheet    } satisfies FieldChange] : []),
    ],
  });

  return { payment: data as Record<string, unknown>, errorMessage: null };
}

mfgSalesOrders.post('/:docNo/payments', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo'); const user = c.get('user');
  // Audit 2026-06-20 — self-scoped sales may only touch their OWN SO (mirror the line/header guards).
  if (await selfScopedSalesBlocked(sb, user.id, docNo)) return c.json({ error: 'not_found' }, 404);

  // Ensure the SO exists before inserting a child row (gives a cleaner
  // 404 than a deferred FK violation).
  const { data: so } = await sb.from('mfg_sales_orders').select('doc_no').eq('doc_no', docNo).maybeSingle();
  if (!so) return c.json({ error: 'sales_order_not_found' }, 404);

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = paymentCreateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const p = parsed.data;

  /* Spec D6 — server-side overpayment guard. The SO total is authoritative;
     Σ(ledger) + this payment may never exceed it. Honest error: the client
     shows the remaining balance. */
  const { data: soTotalRow, error: totalErr } = await sb
    .from('mfg_sales_orders').select('total_revenue_centi').eq('doc_no', docNo).maybeSingle();
  if (totalErr) return c.json({ error: 'lookup_failed', reason: totalErr.message }, 500);
  const totalCenti = Number((soTotalRow as { total_revenue_centi: number | null } | null)?.total_revenue_centi ?? 0);
  const { data: paidRows, error: paidErr } = await sb
    .from('mfg_sales_order_payments').select('amount_centi').eq('so_doc_no', docNo);
  if (paidErr) return c.json({ error: 'lookup_failed', reason: paidErr.message }, 500);
  const paidCenti = (paidRows ?? []).reduce((s, r) => s + Number((r as { amount_centi: number }).amount_centi ?? 0), 0);
  if (totalCenti > 0 && paidCenti + p.amountCenti > totalCenti) {
    return c.json({
      error: 'over_payment',
      reason: `Payment exceeds the order total. Balance: ${((totalCenti - paidCenti) / 100).toFixed(2)}`,
      balanceCenti: Math.max(0, totalCenti - paidCenti),
    }, 400);
  }

  /* Spec D4 — resolve the slip upload session → committed R2 key. Required:
     a payment without a slip is rejected (same vocabulary as the order-level
     slip_required guard). Mirrors the SO-create resolve. */
  const { data: slipRow, error: slipErr } = await sb
    .from('pending_slip_uploads')
    .select('r2_key, status')
    .eq('upload_session_id', p.uploadSessionId)
    .maybeSingle();
  if (slipErr) return c.json({ error: 'lookup_failed', reason: slipErr.message }, 500);
  const slipRowT = slipRow as { r2_key: string | null; status: string } | null;
  if (!slipRowT || slipRowT.status !== 'uploaded' || !slipRowT.r2_key) {
    return c.json({ error: 'slip_required', reason: 'Upload the payment slip first.' }, 400);
  }
  const paymentSlipKey = slipRowT.r2_key;

  /* Insert + ADD_PAYMENT audit — the factored recordSoPaymentRow core (shared
     with the background scan job). Same derivation, same insert, same audit
     shape as the pre-factoring inline code. */
  const { payment, errorMessage } = await recordSoPaymentRow(sb, {
    docNo,
    paidAt:            p.paidAt,
    method:            p.method,
    merchantProvider:  p.merchantProvider,
    installmentMonths: p.installmentMonths,
    onlineType:        p.onlineType,
    approvalCode:      p.approvalCode,
    amountCenti:       p.amountCenti,
    accountSheet:      p.accountSheet,
    slipKey:           paymentSlipKey,
    collectedBy:       p.collectedBy,
    note:              p.note,
    createdBy:         user.id,
    actorName:         (user.user_metadata as { name?: string } | undefined)?.name ?? null,
  });
  if (errorMessage) return c.json({ error: 'insert_failed', reason: errorMessage }, 500);

  /* Promote — 'promoted' rows are excluded from the slip reaper (same dance
     as the SO-create slip). The UPDATE runs under the caller's RLS
     (pending_slip_uploads allows the UPLOADER to promote); in this flow the
     uploader IS the payment recorder, so it matches. If it ever doesn't
     (or errors), the row stays 'uploaded' → the reaper would delete the R2
     object after TTL and the same session would be replayable — so a
     no-op promote is logged LOUDLY instead of swallowed. Best-effort: the
     payment itself stands either way (slip_key already persisted). */
  const { data: promoted, error: promoteErr } = await sb
    .from('pending_slip_uploads')
    .update({ status: 'promoted', promoted_at: new Date().toISOString() })
    .eq('upload_session_id', p.uploadSessionId)
    .select('upload_session_id');
  if (promoteErr || !promoted || promoted.length === 0) {
    // eslint-disable-next-line no-console
    console.error(
      `[payments] slip promote FAILED for session ${p.uploadSessionId} on ${docNo}: `
      + (promoteErr?.message ?? 'no row matched (RLS uploader mismatch?)')
      + ' — slip will be reaped after TTL; replay window open until then.',
    );
  }

  /* ADD_PAYMENT audit already appended inside recordSoPaymentRow. */
  return c.json({ payment }, 201);
});

mfgSalesOrders.delete('/:docNo/payments/:id', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo'); const id = c.req.param('id');
  const user = c.get('user');
  // Audit 2026-06-20 — self-scoped sales may only touch their OWN SO (mirror the line/header guards).
  if (await selfScopedSalesBlocked(sb, user.id, docNo)) return c.json({ error: 'not_found' }, 404);

  // Guard: only delete if the row belongs to this docNo. Prevents a
  // mis-routed call from nuking another SO's payment.
  const { data: row } = await sb.from('mfg_sales_order_payments').select('*').eq('id', id).maybeSingle();
  if (!row) return c.json({ error: 'not_found' }, 404);
  const rowTyped = row as { so_doc_no: string; paid_at: string; method: string; amount_centi: number; approval_code: string | null };
  if (rowTyped.so_doc_no !== docNo) return c.json({ error: 'payment_doc_mismatch' }, 400);

  const { error } = await sb.from('mfg_sales_order_payments').delete().eq('id', id);
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);

  /* Post-merge stitch — DELETE_PAYMENT audit row. */
  await recordSoAudit(sb, {
    docNo,
    action: 'DELETE_PAYMENT',
    actorId: user.id,
    actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
    fieldChanges: [
      { field: 'paidAt',       from: rowTyped.paid_at,       to: null },
      { field: 'method',       from: rowTyped.method,        to: null },
      { field: 'amountCenti',  from: rowTyped.amount_centi,  to: null },
      ...(rowTyped.approval_code ? [{ field: 'approvalCode', from: rowTyped.approval_code, to: null } satisfies FieldChange] : []),
    ],
  });

  return c.json({ ok: true });
});

/* Spec D4 — per-payment slip view. Same binding-served proxy + vocabulary as
   the order-level /:docNo/slip-url route (converted from presign 2026-07-04,
   see that route's comment); legacy rows (slip_key NULL) → no_slip_attached
   and the UI falls back to the order slip. */
mfgSalesOrders.get('/:docNo/payments/:id/slip-url', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo'); const id = c.req.param('id');
  const { data: row, error } = await sb
    .from('mfg_sales_order_payments')
    .select('so_doc_no, slip_key')
    .eq('id', id)
    .maybeSingle();
  if (error) return c.json({ error: 'db_fetch_failed', detail: error.message }, 500);
  const r = row as { so_doc_no: string; slip_key: string | null } | null;
  if (!r || r.so_doc_no !== docNo) return c.json({ error: 'not_found' }, 404);
  if (!r.slip_key) return c.json({ error: 'no_slip_attached' }, 400);

  let bindings;
  try { bindings = slipBindings(c.env); }
  catch (e) { return c.json({ error: 'r2_not_configured', reason: (e as Error).message }, 500); }
  const obj = await bindings.bucket.get(r.slip_key);
  if (!obj) return c.json({ error: 'file_not_in_r2' }, 404);
  return new Response(obj.body as unknown as BodyInit, {
    headers: {
      'content-type': obj.httpMetadata?.contentType ?? mimeFromKey(r.slip_key),
      'content-disposition': 'inline',
      'cache-control': 'private, max-age=300',
    },
  });
});

// ── Debtor lookup — autocomplete from prior SOs ───────────────────────
mfgSalesOrders.get('/debtors/search', async (c) => {
  const sb = c.get('supabase'); const q = c.req.query('q') ?? '';
  let query = sb.from('mfg_sales_orders').select('debtor_code, debtor_name, phone, address1, address2, address3, address4').order('updated_at', { ascending: false }).limit(200);
  { const s = escapeForOr(q); if (s) query = query.or(`debtor_name.ilike.%${s}%,debtor_code.ilike.%${s}%`); }
  const { data, error } = await query;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  // Dedupe by (debtor_code || debtor_name) — keep most recent only.
  const seen = new Set<string>();
  const out = [];
  for (const r of (data ?? []) as Array<Record<string, string | null>>) {
    const key = (r.debtor_code || r.debtor_name || '').trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(r);
    if (out.length >= 25) break;
  }
  return c.json({ debtors: out });
});

/* ════════════════════════════════════════════════════════════════════════
   PATCH /:docNo/items/:itemId/stock-status
   ────────────────────────────────────────────────────────────────────────
   Commander 2026-05-28: per-line stock fulfillment flag. body { status:
   'PENDING' | 'READY' }. After the flip, recompute the SO-level aggregate
   and auto-advance the SO's status to READY_TO_SHIP when EVERY non-cancelled
   line is READY (and the order is currently in a pre-ready state). An
   audit log entry is written for both the line flip and the status
   transition.
   ════════════════════════════════════════════════════════════════════════ */
mfgSalesOrders.patch('/:docNo/items/:itemId/stock-status', async (c) => {
  const sb = c.get('supabase');
  const docNo = c.req.param('docNo');
  const itemId = c.req.param('itemId');
  const user = c.get('user');
  // Audit 2026-06-20 — self-scoped sales may only touch their OWN SO (mirror the line/header guards).
  if (await selfScopedSalesBlocked(sb, user.id, docNo)) return c.json({ error: 'not_found' }, 404);

  let body: { status?: string };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const nextStatus = (body.status ?? '').trim().toUpperCase();
  if (nextStatus !== 'PENDING' && nextStatus !== 'READY') {
    return c.json({ error: 'status_invalid', message: 'PENDING or READY' }, 400);
  }

  // Look up the current row so the audit log can capture from→to.
  const { data: prev, error: findErr } = await sb
    .from('mfg_sales_order_items')
    .select('doc_no, stock_status, item_code, item_group, cancelled')
    .eq('id', itemId)
    .eq('doc_no', docNo)
    .maybeSingle();
  if (findErr) return c.json({ error: 'load_failed', reason: findErr.message }, 500);
  if (!prev) return c.json({ error: 'not_found' }, 404);

  const prevTyped = prev as { stock_status: string; item_code: string; item_group: string; cancelled: boolean };
  if (prevTyped.cancelled) {
    return c.json({ error: 'item_cancelled', message: 'Cannot change stock_status on a cancelled line.' }, 400);
  }
  if (prevTyped.stock_status === nextStatus) {
    return c.json({ ok: true, unchanged: true });
  }

  // Flip the line.
  const { error: updErr } = await sb
    .from('mfg_sales_order_items')
    .update({ stock_status: nextStatus })
    .eq('id', itemId);
  if (updErr) return c.json({ error: 'update_failed', reason: updErr.message }, 500);

  await recordSoAudit(sb, {
    docNo,
    action: 'UPDATE_LINE',
    actorId: user.id,
    actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
    fieldChanges: [
      { field: 'stockStatus', from: prevTyped.stock_status, to: nextStatus },
      { field: 'itemCode',    from: prevTyped.item_code,    to: prevTyped.item_code },
    ],
    note: nextStatus === 'READY' ? 'Stock marked ready' : 'Stock marked pending',
  });

  // Re-aggregate at the SO level. B2C semantic: an SO is ship-able once every
  // MAIN product line (sofa/bedframe/mattress) is READY — accessories pending
  // are OK ("READY (PARTIAL)"). So auto-advance fires on main-ready, not
  // all-ready.
  const { data: allLines } = await sb
    .from('mfg_sales_order_items')
    .select('item_group, stock_status, cancelled')
    .eq('doc_no', docNo);
  const liveRows = ((allLines ?? []) as Array<{ item_group: string; stock_status: string; cancelled: boolean }>).filter((l) => !l.cancelled);
  const readiness = summariseReadiness(liveRows);
  const allReady = readiness.isMainReady;

  let advancedTo: string | null = null;
  if (allReady) {
    const { data: header } = await sb
      .from('mfg_sales_orders')
      .select('status')
      .eq('doc_no', docNo)
      .maybeSingle();
    const cur = (header as { status?: string } | null)?.status ?? null;
    if (cur === 'CONFIRMED' || cur === 'IN_PRODUCTION') {
      const { error: stUpdErr } = await sb
        .from('mfg_sales_orders')
        .update({ status: 'READY_TO_SHIP' })
        .eq('doc_no', docNo);
      if (!stUpdErr) {
        advancedTo = 'READY_TO_SHIP';
        await recordSoAudit(sb, {
          docNo,
          action: 'UPDATE_STATUS',
          actorId: user.id,
          actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
          statusSnapshot: 'READY_TO_SHIP',
          fieldChanges: [{ field: 'status', from: cur, to: 'READY_TO_SHIP' }],
          note: 'Auto-advanced: all lines READY',
        });
      }
    }
  }

  return c.json({ ok: true, advancedTo });
});
