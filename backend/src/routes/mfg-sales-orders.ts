// ----------------------------------------------------------------------------
// /mfg-sales-orders — B2B sales orders (HOUZS pattern).
//
// 1:1 clone of 2990s apps/api/src/routes/mfg-sales-orders.ts. Endpoints, request
// bodies, response JSON shapes, status codes and business rules (CONFIRMED on
// create, the SO lifecycle/lanes, child-lock, processing-date lock, line CRUD,
// payments-as-transactions, price overrides, stock-status flip + auto-advance,
// the unified audit trail) are kept identical to 2990s. Only the SEAMS change:
//   - DB client: 2990s per-request createClient / c.get('supabase') -> Houzs
//     getDb(c.env) (rule #3).
//   - Query layer: 2990s Supabase PostgREST chains -> Drizzle against the cloned
//     schema. Drizzle returns camelCase rows; the detail/list/item handlers emit
//     the snake_case wire shape 2990s's frontend expects (rule #7).
//   - Auth: 2990s Supabase-JWT/RLS -> Houzs requirePermission("*") (rule #4).
//   - Actors: 2990s staff.id (uuid) -> Houzs users.id (integer) from
//     c.get("user") (rule #4). user.name -> the audit actor snapshot.
//   - Mount path: /api/mfg-sales-orders.
//
// Strategy-2 product-layer simplifications (Houzs is not the 2990s furniture
// business; owner enters own data — see docs/scm-clone/PLAN.md):
//   - DROPPED the entire furniture pricing engine: no computeMfgLinePrice /
//     recomputeFromSnapshot / mfgPricingDriftExceeds (the "honest pricing"
//     recompute), no sofa-combo / fabric-tier / variant pricing, no
//     allowed-options / variant-completeness checks, no PWP / free-gift / TBC
//     sofa-exchange handlers, no cross-category delivery-fee engine. A SO line's
//     price is the GENERIC qty × unit_price_centi − discount_centi entered
//     directly (same as the PO/GRN/PI slices). The variant columns
//     (gap/divan/leg/customSpecials/variants jsonb) are KEPT on the schema for
//     fidelity; the create/edit handlers pass them through as-is. Description 2
//     is whatever the client sends (2990s's buildVariantSummary formatter is
//     furniture-coupled and dropped).
//   - DROPPED the DO/SI/DR-dependent aggregates (delivery state / lifecycle /
//     current-doc / deliverable-remaining / per-line delivered breakdown / MRP
//     coverage) — those slices are NOT cloned yet. The list/detail responses
//     carry the faithful empty/default shapes (delivery_state:'none', etc.) so
//     the pages render; each carries a // TODO: DO/SI slice.
//   - DROPPED customer-credits (SO-cancel -> credit) + slip-upload R2 plumbing
//     (SI slice / no R2 binding) — stubbed with // TODO.
//   - KEPT verbatim (generic, faithful): the document lifecycle/lanes/status,
//     so-readiness (stock readiness), so-stock-allocation (allocate inventory to
//     SO lines — wired to the inventory ledger), so-audit (history), the
//     customer directory, payments-as-transactions, price overrides, the
//     stock-status flip + auto-advance.
//
// Endpoints:
//   GET   /mfg-sales-orders                  — list with filters (+ ?summary)
//   GET   /mfg-sales-orders/mine             — caller's own SOs (board)
//   GET   /mfg-sales-orders/customer-search  — returning-customer autocomplete
//   GET   /mfg-sales-orders/customer-credit/:debtorCode — STUB (SI slice) -> 0
//   GET   /mfg-sales-orders/debtors/search   — debtor autocomplete
//   GET   /mfg-sales-orders/:docNo           — detail (header + items)
//   POST  /mfg-sales-orders                  — create CONFIRMED SO
//   POST  /mfg-sales-orders/recompute-allocation — re-walk stock allocation
//   PATCH /mfg-sales-orders/:docNo/status    — status transition (+ audit)
//   GET   /mfg-sales-orders/:docNo/audit-log — unified history feed
//   GET   /mfg-sales-orders/:docNo/status-changes — legacy status timeline
//   GET   /mfg-sales-orders/:docNo/price-overrides — override audit list
//   POST  /mfg-sales-orders/:docNo/items/:itemId/override — line price override
//   PATCH /mfg-sales-orders/:docNo           — edit header
//   POST  /mfg-sales-orders/:docNo/items     — add line
//   PATCH /mfg-sales-orders/:docNo/items/:itemId — edit line
//   DELETE /mfg-sales-orders/:docNo/items/:itemId — delete line
//   GET   /mfg-sales-orders/:docNo/payments  — list payments
//   POST  /mfg-sales-orders/:docNo/payments  — record a payment
//   DELETE /mfg-sales-orders/:docNo/payments/:id — delete a payment
//   PATCH /mfg-sales-orders/:docNo/items/:itemId/stock-status — manual READY toggle
// ----------------------------------------------------------------------------

import { Hono } from "hono";
import { z } from "zod";
import { and, asc, desc, eq, ilike, inArray, like, or, sql } from "drizzle-orm";
import type { Env } from "../types";
import { getDb } from "../db/client";
import {
  mfgSalesOrders as soTable,
  mfgSalesOrderItems as soItemsTable,
  mfgSoStatusChanges as soStatusChangesTable,
  mfgSoPriceOverrides as soOverridesTable,
  mfgSoAuditLog as soAuditTable,
  mfgSalesOrderPayments as soPaymentsTable,
  users as usersTable,
} from "../db/schema";
import { requirePermission } from "../middleware/auth";
import { recordSoAudit, type FieldChange } from "../lib/so-audit";
import { recomputeSoStockAllocation } from "../lib/so-stock-allocation";
import { summariseReadiness } from "../lib/so-readiness";
import { isServiceLine, isDeliveryFeeServiceCode } from "../lib/service-sku";

const app = new Hono<{ Bindings: Env }>();

// Owner-only for now (rule #4). Gate every route in this module.
app.use("*", requirePermission("*"));

type Db = ReturnType<typeof getDb>;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/* ── SO child-lock guard (Tier 2 — downstream lock) ─────────────────────────
   An SO locks (read-only — no line edit / no CANCELLED transition) once it has
   ANY non-cancelled Delivery Order OR Sales Invoice referencing it. The DO/SI
   tables are NOT cloned yet -> no downstream can exist -> never locks. Kept as
   a function so the call sites stay verbatim; wire when the DO/SI slice lands.
   TODO: DO/SI slice — query delivery_orders / sales_invoices by so_doc_no. */
async function soHasDownstream(_db: Db, _soDocNo: string): Promise<{ error: string; message: string } | null> {
  return null;
}

/* ── SO processing-date lock (Owner 2026-06-12) ─────────────────────────────
   Once the SO's processing day has PASSED (from midnight Malaysia time, UTC+8,
   the day AFTER the processing date) the SO is LOCKED: header edits, line
   add/edit/delete and price overrides are rejected with 409 so_locked_processing.
   Status transitions, payments and reads stay open. The UI's "Processing Date"
   lives in internal_expected_dd; legacy processing_date is honoured as a
   fallback. Ported verbatim. */
const SO_PROCESSING_LOCKED_RESPONSE = {
  error: "so_locked_processing",
  reason: "Processing date has passed — this Sales Order is locked. (Locked orders are what we PO to the supplier.)",
} as const;

function soProcessingLocked(
  header: { internal_expected_dd?: string | null; processing_date?: string | null } | null | undefined,
): boolean {
  if (!header) return false;
  const proc = header.internal_expected_dd ?? header.processing_date ?? null;
  if (!proc) return false;
  const procYmd = String(proc).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(procYmd)) return false;
  const todayMY = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  return procYmd < todayMY;
}

async function soProcessingLockBlocked(db: Db, docNo: string): Promise<typeof SO_PROCESSING_LOCKED_RESPONSE | null> {
  const rows = await db
    .select({ internalExpectedDd: soTable.internalExpectedDd, processingDate: soTable.processingDate })
    .from(soTable)
    .where(eq(soTable.docNo, docNo))
    .limit(1);
  const h = rows[0];
  return soProcessingLocked(
    h ? { internal_expected_dd: h.internalExpectedDd as string | null, processing_date: h.processingDate as string | null } : null,
  )
    ? SO_PROCESSING_LOCKED_RESPONSE
    : null;
}

/* POS line quantity gate — qty must be a positive whole number when present.
   Verbatim from 2990s (pure). */
function invalidQtyResponse(rawQty: unknown, itemCode: unknown, lineIdx = 0): Record<string, unknown> | null {
  if (rawQty == null) return null;
  const q = Number(rawQty);
  if (Number.isInteger(q) && q >= 1) return null;
  return { error: "invalid_qty", reason: "qty must be a positive whole number.", lineIdx, itemCode: String(itemCode ?? ""), qty: rawQty };
}

/* ── Doc number generation: SO-YYMM-NNN — matches PO/DO/GRN/SI/DR/PI/PRT. ──── */
const nextDocNo = async (db: Db): Promise<string> => {
  const yymm = (() => {
    const d = new Date();
    return `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, "0")}`;
  })();
  // max+1 (not count+1) so a mid-month delete can't re-mint a surviving doc_no
  // and jam the pkey (2990s lib/doc-no.ts rationale).
  const rows = await db
    .select({ docNo: soTable.docNo })
    .from(soTable)
    .where(like(soTable.docNo, `SO-${yymm}-%`));
  let maxN = 0;
  for (const r of rows) {
    const m = /-(\d+)$/.exec(r.docNo);
    if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
  }
  return `SO-${yymm}-${String(maxN + 1).padStart(3, "0")}`;
};

/* ─────────────────────────── Response shaping ─────────────────────────────
   Map Drizzle's camelCase rows to the snake_case JSON the 2990s frontend
   consumes. Keeps the wire shape identical (rule #7). */
type SoHeaderDb = typeof soTable.$inferSelect;
type SoItemDb = typeof soItemsTable.$inferSelect;

function isoOrNull(v: Date | string | null): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

function toSoHeaderResponse(p: SoHeaderDb): Record<string, unknown> {
  return {
    doc_no: p.docNo,
    transfer_to: p.transferTo,
    so_date: p.soDate,
    branding: p.branding,
    debtor_code: p.debtorCode,
    debtor_name: p.debtorName,
    agent: p.agent,
    sales_location: p.salesLocation,
    ref: p.ref,
    po_doc_no: p.poDocNo,
    venue: p.venue,
    venue_id: p.venueId,
    address1: p.address1,
    address2: p.address2,
    address3: p.address3,
    address4: p.address4,
    phone: p.phone,
    mattress_sofa_centi: p.mattressSofaCenti,
    bedframe_centi: p.bedframeCenti,
    accessories_centi: p.accessoriesCenti,
    others_centi: p.othersCenti,
    mattress_sofa_cost_centi: p.mattressSofaCostCenti,
    bedframe_cost_centi: p.bedframeCostCenti,
    accessories_cost_centi: p.accessoriesCostCenti,
    others_cost_centi: p.othersCostCenti,
    service_centi: p.serviceCenti,
    service_cost_centi: p.serviceCostCenti,
    local_total_centi: p.localTotalCenti,
    balance_centi: p.balanceCenti,
    total_cost_centi: p.totalCostCenti,
    total_revenue_centi: p.totalRevenueCenti,
    total_margin_centi: p.totalMarginCenti,
    margin_pct_basis: p.marginPctBasis,
    line_count: p.lineCount,
    fabric_tier_addon_centi: p.fabricTierAddonCenti,
    delivery_fee_centi: p.deliveryFeeCenti,
    cross_category_source_doc_no: p.crossCategorySourceDocNo,
    currency: p.currency,
    status: p.status,
    remark2: p.remark2,
    remark3: p.remark3,
    remark4: p.remark4,
    note: p.note,
    processing_date: p.processingDate,
    proceeded_at: isoOrNull(p.proceededAt),
    sales_exemption_expiry: p.salesExemptionExpiry,
    customer_id: p.customerId,
    customer_state: p.customerState,
    customer_country: p.customerCountry,
    customer_po: p.customerPo,
    customer_po_id: p.customerPoId,
    customer_po_date: p.customerPoDate,
    customer_po_image_b64: p.customerPoImageB64,
    customer_so_no: p.customerSoNo,
    hub_id: p.hubId,
    hub_name: p.hubName,
    customer_delivery_date: p.customerDeliveryDate,
    internal_expected_dd: p.internalExpectedDd,
    linked_do_doc_no: p.linkedDoDocNo,
    ship_to_address: p.shipToAddress,
    bill_to_address: p.billToAddress,
    install_to_address: p.installToAddress,
    subtotal_sen: p.subtotalSen,
    overdue: p.overdue,
    email: p.email,
    customer_type: p.customerType,
    salesperson_id: p.salespersonId,
    city: p.city,
    postcode: p.postcode,
    building_type: p.buildingType,
    emergency_contact_name: p.emergencyContactName,
    emergency_contact_phone: p.emergencyContactPhone,
    emergency_contact_relationship: p.emergencyContactRelationship,
    target_date: p.targetDate,
    signature_b64: p.signatureB64,
    slip_key: p.slipKey,
    slip_state: p.slipState,
    payment_method: p.paymentMethod,
    installment_months: p.installmentMonths,
    merchant_provider: p.merchantProvider,
    approval_code: p.approvalCode,
    payment_date: p.paymentDate,
    deposit_centi: p.depositCenti,
    paid_centi: p.paidCenti,
    created_at: isoOrNull(p.createdAt),
    created_by: p.createdBy,
    updated_at: isoOrNull(p.updatedAt),
  };
}

function toSoItemResponse(it: SoItemDb): Record<string, unknown> {
  return {
    id: it.id,
    doc_no: it.docNo,
    line_date: it.lineDate,
    debtor_code: it.debtorCode,
    debtor_name: it.debtorName,
    agent: it.agent,
    item_group: it.itemGroup,
    item_code: it.itemCode,
    description: it.description,
    description2: it.description2,
    uom: it.uom,
    location: it.location,
    warehouse_id: it.warehouseId,
    qty: it.qty,
    unit_price_centi: it.unitPriceCenti,
    discount_centi: it.discountCenti,
    total_centi: it.totalCenti,
    tax_centi: it.taxCenti,
    total_inc_centi: it.totalIncCenti,
    balance_centi: it.balanceCenti,
    payment_status: it.paymentStatus,
    venue: it.venue,
    branding: it.branding,
    remark: it.remark,
    cancelled: it.cancelled,
    variants: it.variants ?? null,
    unit_cost_centi: it.unitCostCenti,
    line_cost_centi: it.lineCostCenti,
    line_margin_centi: it.lineMarginCenti,
    gap_inches: it.gapInches,
    divan_height_inches: it.divanHeightInches,
    divan_price_sen: it.divanPriceSen,
    leg_height_inches: it.legHeightInches,
    leg_price_sen: it.legPriceSen,
    custom_specials: it.customSpecials ?? null,
    line_suffix: it.lineSuffix,
    special_order_price_sen: it.specialOrderPriceSen,
    po_qty_picked: it.poQtyPicked,
    line_delivery_date: it.lineDeliveryDate,
    line_delivery_date_overridden: it.lineDeliveryDateOverridden,
    photo_urls: it.photoUrls ?? [],
    stock_status: it.stockStatus,
    stock_qty_ready: it.stockQtyReady,
    allocated_batch_no: it.allocatedBatchNo,
    line_no: it.lineNo,
    created_at: isoOrNull(it.createdAt),
  };
}

/* ─────────────────────────── recomputeTotals ──────────────────────────────
   Re-roll the SO header's category revenue/cost buckets + margin from the live
   line items. 1:1 with 2990s's recomputeTotals minus the sofa-combo COST
   spread (furniture, dropped per Strategy-2). SERVICE lines get their own
   bucket (checked first). The delivery_fee_centi header fallback is kept (folds
   in only when no SVC-DELIVERY* line exists). Exported so the override + line
   handlers reuse it. */
export async function recomputeTotals(db: Db, docNo: string): Promise<void> {
  const items = await db
    .select({
      id: soItemsTable.id,
      itemCode: soItemsTable.itemCode,
      itemGroup: soItemsTable.itemGroup,
      qty: soItemsTable.qty,
      totalCenti: soItemsTable.totalCenti,
      lineCostCenti: soItemsTable.lineCostCenti,
    })
    .from(soItemsTable)
    .where(and(eq(soItemsTable.docNo, docNo), eq(soItemsTable.cancelled, false)));

  let mattressSofa = 0,
    bedframe = 0,
    accessories = 0,
    others = 0,
    service = 0,
    total = 0,
    totalCost = 0;
  let mattressSofaCost = 0,
    bedframeCost = 0,
    accessoriesCost = 0,
    othersCost = 0,
    serviceCost = 0;
  for (const it of items) {
    const lineTotal = it.totalCenti || 0;
    const lineCost = it.lineCostCenti || 0;
    total += lineTotal;
    totalCost += lineCost;
    const g = (it.itemGroup ?? "").toLowerCase();
    if (isServiceLine({ itemGroup: g, itemCode: it.itemCode })) {
      service += lineTotal;
      serviceCost += lineCost;
    } else if (g.includes("mattress") || g.includes("sofa")) {
      mattressSofa += lineTotal;
      mattressSofaCost += lineCost;
    } else if (g.includes("bedframe")) {
      bedframe += lineTotal;
      bedframeCost += lineCost;
    } else if (g.includes("accessor")) {
      accessories += lineTotal;
      accessoriesCost += lineCost;
    } else {
      others += lineTotal;
      othersCost += lineCost;
    }
  }
  // Delivery fee header fallback — only a line-less / no-SVC-DELIVERY SO reads
  // the header snapshot back (the SVC-DELIVERY* line amounts are already in
  // `service`/`total`).
  const hasDeliveryFeeLines = items.some((r) => isDeliveryFeeServiceCode(r.itemCode));
  let deliveryCenti = 0;
  if (!hasDeliveryFeeLines) {
    const hdr = await db.select({ deliveryFeeCenti: soTable.deliveryFeeCenti }).from(soTable).where(eq(soTable.docNo, docNo)).limit(1);
    deliveryCenti = Number(hdr[0]?.deliveryFeeCenti ?? 0);
  }
  const grandTotal = total + deliveryCenti;
  const grandMargin = grandTotal - totalCost;
  await db
    .update(soTable)
    .set({
      mattressSofaCenti: mattressSofa,
      bedframeCenti: bedframe,
      accessoriesCenti: accessories,
      othersCenti: others,
      serviceCenti: service,
      serviceCostCenti: serviceCost,
      mattressSofaCostCenti: mattressSofaCost,
      bedframeCostCenti: bedframeCost,
      accessoriesCostCenti: accessoriesCost,
      othersCostCenti: othersCost,
      localTotalCenti: grandTotal,
      balanceCenti: grandTotal,
      totalCostCenti: totalCost,
      totalRevenueCenti: grandTotal,
      totalMarginCenti: grandMargin,
      marginPctBasis: grandTotal > 0 ? Math.round((grandMargin / grandTotal) * 10000) : 0,
      lineCount: items.length,
      updatedAt: new Date(),
    })
    .where(eq(soTable.docNo, docNo));
}

// ── List ──────────────────────────────────────────────────────────────
app.get("/", async (c) => {
  const db = getDb(c.env);

  /* Dashboard summary mode (?summary=1): bucket SOs by status/proceeded_at +
     count "new today" without the line-item aggregation. */
  if (c.req.query("summary")) {
    try {
      const rows = await db
        .select({
          doc_no: soTable.docNo,
          status: soTable.status,
          proceeded_at: soTable.proceededAt,
          local_total_centi: soTable.localTotalCenti,
          created_at: soTable.createdAt,
          so_date: soTable.soDate,
        })
        .from(soTable)
        .orderBy(desc(soTable.soDate))
        .limit(500);
      return c.json({
        salesOrders: rows.map((r) => ({ ...r, proceeded_at: isoOrNull(r.proceeded_at), created_at: isoOrNull(r.created_at) })),
      });
    } catch (e) {
      return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
    }
  }

  const conds = [];
  const status = c.req.query("status");
  if (status) conds.push(eq(soTable.status, status as SoHeaderDb["status"]));
  const debtor = c.req.query("debtor");
  if (debtor) conds.push(ilike(soTable.debtorName, `%${debtor}%`));

  try {
    const headerRows = await db
      .select()
      .from(soTable)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(soTable.soDate))
      .limit(500);

    const rows = headerRows.map((h) => toSoHeaderResponse(h));
    const docNos = rows.map((r) => r.doc_no as string).filter(Boolean);

    if (docNos.length > 0) {
      // One batched read of all non-cancelled lines for stock-status aggregate +
      // readiness + first-item branding (mirrors 2990s's single line fetch).
      const itemRows = await db
        .select({
          docNo: soItemsTable.docNo,
          itemGroup: soItemsTable.itemGroup,
          itemCode: soItemsTable.itemCode,
          stockStatus: soItemsTable.stockStatus,
          cancelled: soItemsTable.cancelled,
          branding: soItemsTable.branding,
          createdAt: soItemsTable.createdAt,
          lineNo: soItemsTable.lineNo,
        })
        .from(soItemsTable)
        .where(and(inArray(soItemsTable.docNo, docNos), eq(soItemsTable.cancelled, false)))
        .orderBy(asc(soItemsTable.docNo), sql`${soItemsTable.lineNo} ASC NULLS LAST`, asc(soItemsTable.createdAt));

      const normCategory = (raw: string): string => {
        const g = (raw ?? "").trim().toUpperCase();
        if (g.includes("BEDFRAME")) return "BEDFRAME";
        if (g.includes("SOFA")) return "SOFA";
        if (g.includes("MATTRESS")) return "MATTRESS";
        if (g.includes("ACCESSOR")) return "ACCESSORY";
        if (g.includes("SERVICE")) return "SERVICE";
        return "OTHERS";
      };
      const agg = new Map<string, Map<string, { total: number; ready: number }>>();
      const cats = new Map<string, Set<string>>();
      const firstCat = new Map<string, string>();
      const firstBranding = new Map<string, string | null>();
      const linesByDoc = new Map<string, Array<{ item_group: string | null; item_code: string | null; stock_status: string; cancelled: boolean }>>();
      for (const it of itemRows) {
        let perGroup = agg.get(it.docNo);
        if (!perGroup) {
          perGroup = new Map();
          agg.set(it.docNo, perGroup);
        }
        const g = (it.itemGroup ?? "").trim().toUpperCase() || "OTHERS";
        let cell = perGroup.get(g);
        if (!cell) {
          cell = { total: 0, ready: 0 };
          perGroup.set(g, cell);
        }
        cell.total += 1;
        if (it.stockStatus === "READY") cell.ready += 1;

        let catSet = cats.get(it.docNo);
        if (!catSet) {
          catSet = new Set();
          cats.set(it.docNo, catSet);
        }
        catSet.add(normCategory(it.itemGroup ?? ""));

        if (!firstCat.has(it.docNo)) {
          firstCat.set(it.docNo, normCategory(it.itemGroup ?? ""));
          firstBranding.set(it.docNo, it.branding ?? null);
        }

        const arr = linesByDoc.get(it.docNo) ?? [];
        arr.push({ item_group: it.itemGroup, item_code: it.itemCode, stock_status: it.stockStatus, cancelled: it.cancelled });
        linesByDoc.set(it.docNo, arr);
      }

      const readinessByDoc = new Map<string, ReturnType<typeof summariseReadiness>>();
      for (const [docNo, ls] of linesByDoc) readinessByDoc.set(docNo, summariseReadiness(ls));

      // Distinct ledger payment methods per SO ("Cash + Card").
      const paymentMethods = new Map<string, Set<string>>();
      {
        const payRows = await db
          .select({ soDocNo: soPaymentsTable.soDocNo, method: soPaymentsTable.method, onlineType: soPaymentsTable.onlineType })
          .from(soPaymentsTable)
          .where(inArray(soPaymentsTable.soDocNo, docNos));
        for (const p of payRows) {
          const m = (p.method ?? "").trim().toLowerCase();
          let label: string;
          if (m === "cash") label = "Cash";
          else if (m === "merchant") label = "Card";
          else if (m === "transfer") label = p.onlineType && p.onlineType.trim() ? p.onlineType.trim() : "Transfer";
          else if (m === "installment") label = "Installment";
          else continue;
          let set = paymentMethods.get(p.soDocNo);
          if (!set) {
            set = new Set();
            paymentMethods.set(p.soDocNo, set);
          }
          set.add(label);
        }
      }

      for (const r of rows) {
        const docNo = (r.doc_no as string) ?? "";
        const perGroup = agg.get(docNo);
        r.item_categories = [...(cats.get(docNo) ?? [])].sort();
        /* Tier 2 downstream-lock + DO/SI lifecycle aggregates: DO/SI not cloned
           -> faithful defaults. TODO: DO/SI slice. */
        r.has_children = false;
        r.delivery_state = "none";
        r.lifecycle_state = "none";
        r.current_doc_no = docNo || null;
        r.has_undelivered = true;
        const readiness = readinessByDoc.get(docNo);
        r.stock_remark = readiness?.stockRemark ?? "";
        r.is_main_ready = readiness?.isMainReady ?? false;
        r.first_item_category = firstCat.get(docNo) ?? null;
        r.first_item_branding = firstBranding.get(docNo) ?? null;
        const pm = paymentMethods.get(docNo);
        r.payment_methods_summary = pm ? [...pm].sort().join(" + ") : "";
        if (!perGroup) {
          r.ready_categories = [];
          r.is_fully_ready = false;
          continue;
        }
        const ready: string[] = [];
        let allReady = true;
        for (const [grp, cell] of perGroup) {
          if (cell.total > 0 && cell.ready === cell.total) ready.push(grp);
          else allReady = false;
        }
        r.ready_categories = ready;
        r.is_fully_ready = allReady && perGroup.size > 0;
      }
    }

    return c.json({ salesOrders: rows });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

/* POS "My orders" board — the caller's OWN Sales Orders (salesperson_id =
   caller). Lightweight columns; excludes CANCELLED / ON_HOLD. Registered
   BEFORE '/:docNo'. */
app.get("/mine", async (c) => {
  const db = getDb(c.env);
  const user = c.get("user");
  try {
    const rows = await db
      .select({
        doc_no: soTable.docNo,
        status: soTable.status,
        debtor_name: soTable.debtorName,
        local_total_centi: soTable.localTotalCenti,
        proceeded_at: soTable.proceededAt,
        so_date: soTable.soDate,
        created_at: soTable.createdAt,
      })
      .from(soTable)
      .where(and(eq(soTable.salespersonId, user.id), sql`${soTable.status} NOT IN ('CANCELLED','ON_HOLD')`))
      .orderBy(desc(soTable.soDate))
      .limit(500);
    return c.json({ salesOrders: rows.map((r) => ({ ...r, proceeded_at: isoOrNull(r.proceeded_at), created_at: isoOrNull(r.created_at) })) });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

/* Returning-customer autocomplete — prior SOs by debtor name, per-identity
   COALESCE (newest order wins per field; emergency contact as a group).
   Verbatim logic; PostgREST -> Drizzle. */
app.get("/customer-search", async (c) => {
  const db = getDb(c.env);
  const q = (c.req.query("name") ?? "").trim();
  if (q.length < 2) return c.json({ customers: [] });
  const esc = q.replace(/[\\%_]/g, (m) => `\\${m}`);
  try {
    const data = await db
      .select({
        doc_no: soTable.docNo,
        debtor_name: soTable.debtorName,
        phone: soTable.phone,
        email: soTable.email,
        customer_type: soTable.customerType,
        address1: soTable.address1,
        address2: soTable.address2,
        city: soTable.city,
        postcode: soTable.postcode,
        customer_state: soTable.customerState,
        building_type: soTable.buildingType,
        emergency_contact_name: soTable.emergencyContactName,
        emergency_contact_phone: soTable.emergencyContactPhone,
        emergency_contact_relationship: soTable.emergencyContactRelationship,
        created_at: soTable.createdAt,
      })
      .from(soTable)
      .where(and(ilike(soTable.debtorName, `%${esc}%`), sql`${soTable.status} <> 'CANCELLED'`))
      .orderBy(desc(soTable.createdAt))
      .limit(60);

    type Row = (typeof data)[number];
    const byKey = new Map<string, Record<string, unknown>>();
    const FILL_FIELDS = [
      ["email", "email"],
      ["customerType", "customer_type"],
      ["address1", "address1"],
      ["address2", "address2"],
      ["city", "city"],
      ["postcode", "postcode"],
      ["customerState", "customer_state"],
      ["buildingType", "building_type"],
    ] as const;
    const hasEmergency = (e: Record<string, unknown>): boolean =>
      Boolean(e.emergencyContactName || e.emergencyContactPhone || e.emergencyContactRelationship);
    const emergencyOf = (r: Row) => ({
      emergencyContactName: r.emergency_contact_name,
      emergencyContactPhone: r.emergency_contact_phone,
      emergencyContactRelationship: r.emergency_contact_relationship,
    });
    for (const r of data) {
      const name = (r.debtor_name ?? "").trim();
      if (!name) continue;
      const key = `${name.toLowerCase()}|${(r.phone ?? "").trim()}`;
      const existing = byKey.get(key);
      if (existing) {
        for (const [out, col] of FILL_FIELDS) {
          if (existing[out] == null || existing[out] === "") existing[out] = (r as Record<string, unknown>)[col];
        }
        if (!hasEmergency(existing) && hasEmergency(emergencyOf(r))) Object.assign(existing, emergencyOf(r));
        continue;
      }
      byKey.set(key, {
        debtorName: name,
        phone: r.phone,
        email: r.email,
        customerType: r.customer_type,
        address1: r.address1,
        address2: r.address2,
        city: r.city,
        postcode: r.postcode,
        customerState: r.customer_state,
        buildingType: r.building_type,
        ...emergencyOf(r),
        lastDocNo: r.doc_no,
        lastOrderAt: isoOrNull(r.created_at),
      });
    }
    return c.json({ customers: [...byKey.values()].slice(0, 8) });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

/* Customer credit balance lookup. STUB — customer_credits + sales_invoices
   (SI slice) are not cloned -> always 0. TODO: SI slice. */
app.get("/customer-credit/:debtorCode", async (c) => {
  return c.json({ debtorCode: c.req.param("debtorCode"), balanceCenti: 0 });
});

/* Debtor autocomplete from prior SOs. */
app.get("/debtors/search", async (c) => {
  const db = getDb(c.env);
  const q = (c.req.query("q") ?? "").trim();
  try {
    const conds = [];
    if (q) {
      const esc = q.replace(/[\\%_]/g, (m) => `\\${m}`);
      conds.push(or(ilike(soTable.debtorName, `%${esc}%`), ilike(soTable.debtorCode, `%${esc}%`)));
    }
    const data = await db
      .select({
        debtor_code: soTable.debtorCode,
        debtor_name: soTable.debtorName,
        phone: soTable.phone,
        address1: soTable.address1,
        address2: soTable.address2,
        address3: soTable.address3,
        address4: soTable.address4,
      })
      .from(soTable)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(soTable.updatedAt))
      .limit(200);
    const seen = new Set<string>();
    const out: typeof data = [];
    for (const r of data) {
      const key = (r.debtor_code || r.debtor_name || "").trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(r);
      if (out.length >= 25) break;
    }
    return c.json({ debtors: out });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

// ── Detail ────────────────────────────────────────────────────────────
app.get("/:docNo", async (c) => {
  const db = getDb(c.env);
  const docNo = c.req.param("docNo");
  try {
    const [headerRows, itemRows] = await Promise.all([
      db.select().from(soTable).where(eq(soTable.docNo, docNo)).limit(1),
      db
        .select()
        .from(soItemsTable)
        .where(eq(soItemsTable.docNo, docNo))
        .orderBy(sql`${soItemsTable.lineNo} ASC NULLS LAST`, asc(soItemsTable.createdAt)),
    ]);
    const header = headerRows[0];
    if (!header) return c.json({ error: "not_found" }, 404);

    /* Live paid rollup — sum the payments ledger, add the header deposit ONLY
       when no ledger row already carries it (is_deposit marker). */
    let paidLedgerCenti = 0;
    let depositInLedger = false;
    const payRows = await db
      .select({ amountCenti: soPaymentsTable.amountCenti, isDeposit: soPaymentsTable.isDeposit })
      .from(soPaymentsTable)
      .where(eq(soPaymentsTable.soDocNo, docNo));
    for (const p of payRows) {
      paidLedgerCenti += p.amountCenti ?? 0;
      if (p.isDeposit) depositInLedger = true;
    }
    const headerDepositCenti = header.depositCenti ?? 0;
    const totalRevenueCenti = header.totalRevenueCenti ?? 0;
    const paidCentiTotal = (depositInLedger ? 0 : headerDepositCenti) + paidLedgerCenti;

    const salesOrder = {
      ...toSoHeaderResponse(header),
      /* DO/SI not cloned -> faithful defaults. TODO: DO/SI slice. */
      has_children: false,
      customer_credit_centi: 0,
      paid_centi_total: paidCentiTotal,
      balance_centi: Math.max(0, totalRevenueCenti - paidCentiTotal),
      delivery_state: "none",
      lifecycle_state: "none",
      current_doc_no: docNo || null,
    };

    const items = itemRows.map((it) => ({
      ...toSoItemResponse(it),
      /* Per-line delivered breakdown + MRP coverage come from the DO/MRP slices
         (not cloned) -> faithful empties. TODO: DO/SI slice. */
      deliveries: [] as unknown[],
      delivered_qty: 0,
      remaining_qty: Number(it.qty ?? 0),
      stock_state: it.stockStatus === "READY" ? "stock" : null,
      coverage_po: null as string | null,
      coverage_eta: null as string | null,
    }));

    // pwpCodes — PWP (换购) is furniture (dropped). Faithful empty array.
    return c.json({ salesOrder, items, pwpCodes: [] as unknown[] });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

// ── Create ────────────────────────────────────────────────────────────
// body: { debtorName|customerName (req), phone (req), items?: [...], + any
//   header field (camelCase) }. Each item: { itemGroup, itemCode (req), qty,
//   unitPriceCenti, discountCenti?, description?, description2?, variants?,
//   warehouseId?, lineDeliveryDate?, uom? }.
app.post("/", async (c) => {
  const db = getDb(c.env);
  const user = c.get("user");

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const customerName = (body.debtorName ?? body.customerName) as string | undefined;
  if (!customerName) return c.json({ error: "customer_name_required" }, 400);
  // Phone is COMPULSORY on every SO (server-enforced).
  const rawPhone = typeof body.phone === "string" ? body.phone.trim() : "";
  if (!rawPhone) return c.json({ error: "phone_required", reason: "A phone number is required on every sales order." }, 400);

  const items = (body.items as Array<Record<string, unknown>> | undefined) ?? [];

  // POS line quantity gate (before any work).
  for (let i = 0; i < items.length; i++) {
    const badQty = invalidQtyResponse(items[i]?.qty, items[i]?.itemCode, i);
    if (badQty) return c.json(badQty, 422);
  }

  /* Processing Date + Delivery Date all-or-nothing + order + not-in-past guards
     (the generic subset of 2990s's create-composition rules; the furniture
     variant-completeness + sofa-mix rules are dropped per Strategy-2). */
  const procDate = (body.internalExpectedDd as string | null | undefined) || null;
  const delivDate = (body.customerDeliveryDate as string | null | undefined) || null;
  if (Boolean(procDate) !== Boolean(delivDate)) {
    return c.json({ error: "processing_delivery_must_pair", reason: "Processing Date and Delivery Date must be set together (or both left empty)." }, 400);
  }
  if (procDate && delivDate && procDate > delivDate) {
    return c.json({ error: "processing_after_delivery", reason: "Processing Date cannot be later than the Delivery Date." }, 400);
  }
  const todayMY = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  if (procDate && procDate < todayMY) return c.json({ error: "processing_date_past", reason: "Processing Date cannot be in the past — today or a future date only." }, 400);
  if (delivDate && delivDate < todayMY) return c.json({ error: "delivery_date_past", reason: "Delivery Date cannot be in the past — today or a future date only." }, 400);

  const docNo = await nextDocNo(db);

  // Header insert (camelCase passthrough of the known columns).
  const headerInsert: Record<string, unknown> = {
    docNo,
    debtorName: customerName,
    phone: rawPhone,
    status: "CONFIRMED",
    currency: ((body.currency as string) ?? "MYR").toUpperCase(),
    createdBy: user.id,
    salespersonId: typeof body.salespersonId === "number" ? body.salespersonId : user.id,
  };
  const HEADER_PASSTHRU: Array<[bodyKey: string, col: string]> = [
    ["transferTo", "transferTo"],
    ["soDate", "soDate"],
    ["branding", "branding"],
    ["debtorCode", "debtorCode"],
    ["agent", "agent"],
    ["salesLocation", "salesLocation"],
    ["ref", "ref"],
    ["poDocNo", "poDocNo"],
    ["venue", "venue"],
    ["venueId", "venueId"],
    ["address1", "address1"],
    ["address2", "address2"],
    ["address3", "address3"],
    ["address4", "address4"],
    ["remark2", "remark2"],
    ["remark3", "remark3"],
    ["remark4", "remark4"],
    ["note", "note"],
    ["processingDate", "processingDate"],
    ["customerId", "customerId"],
    ["customerState", "customerState"],
    ["customerCountry", "customerCountry"],
    ["customerPo", "customerPo"],
    ["customerPoId", "customerPoId"],
    ["customerPoDate", "customerPoDate"],
    ["customerPoImageB64", "customerPoImageB64"],
    ["customerSoNo", "customerSoNo"],
    ["hubId", "hubId"],
    ["hubName", "hubName"],
    ["customerDeliveryDate", "customerDeliveryDate"],
    ["internalExpectedDd", "internalExpectedDd"],
    ["shipToAddress", "shipToAddress"],
    ["billToAddress", "billToAddress"],
    ["installToAddress", "installToAddress"],
    ["email", "email"],
    ["customerType", "customerType"],
    ["city", "city"],
    ["postcode", "postcode"],
    ["buildingType", "buildingType"],
    ["emergencyContactName", "emergencyContactName"],
    ["emergencyContactPhone", "emergencyContactPhone"],
    ["emergencyContactRelationship", "emergencyContactRelationship"],
    ["targetDate", "targetDate"],
    ["paymentMethod", "paymentMethod"],
    ["installmentMonths", "installmentMonths"],
    ["merchantProvider", "merchantProvider"],
    ["approvalCode", "approvalCode"],
    ["paymentDate", "paymentDate"],
    ["depositCenti", "depositCenti"],
  ];
  for (const [bk, col] of HEADER_PASSTHRU) {
    if (body[bk] !== undefined) headerInsert[col] = body[bk];
  }

  try {
    await db.insert(soTable).values(headerInsert as never);
  } catch (e) {
    if (isUniqueViolation(e)) return c.json({ error: "duplicate_doc_no", reason: errMsg(e) }, 409);
    return c.json({ error: "insert_failed", reason: errMsg(e) }, 500);
  }

  // Item insert — generic line pricing (qty × unit − discount). Variant columns
  // passed through for fidelity. line_no = array index (the persisted order).
  if (items.length > 0) {
    let lineIdx = 0;
    const itemRows: Array<Record<string, unknown>> = [];
    try {
      for (const it of items) {
        if (!it.itemCode) throw new Error("item_code required per item");
        const qty = Math.max(1, Number(it.qty ?? 1));
        const unit = Math.max(0, Number(it.unitPriceCenti ?? 0));
        const discount = Math.max(0, Number(it.discountCenti ?? 0));
        if (discount > qty * unit) throw new Error("discountCenti must be between 0 and qty × unit price");
        const lineTotal = qty * unit - discount;
        const unitCost = Math.max(0, Number(it.unitCostCenti ?? 0));
        const lineCost = unitCost * qty;
        const itemGroup = String(it.itemGroup ?? "others");
        const isSvc = isServiceLine({ itemGroup, itemCode: String(it.itemCode) });
        itemRows.push({
          docNo,
          lineNo: lineIdx++,
          lineDate: (it.lineDate as string) ?? todayMY,
          debtorCode: (body.debtorCode as string | undefined) ?? null,
          debtorName: customerName,
          agent: (body.agent as string | undefined) ?? null,
          itemGroup,
          itemCode: it.itemCode as string,
          description: (it.description as string | undefined) ?? null,
          description2: (it.description2 as string | undefined) ?? null,
          uom: (it.uom as string | undefined) ?? "UNIT",
          warehouseId: (it.warehouseId as string | undefined) ?? null,
          qty,
          unitPriceCenti: unit,
          discountCenti: discount,
          totalCenti: lineTotal,
          totalIncCenti: lineTotal,
          balanceCenti: lineTotal,
          venue: (body.venue as string | undefined) ?? null,
          branding: (body.branding as string | undefined) ?? null,
          variants: (it.variants as unknown) ?? null,
          unitCostCenti: unitCost,
          lineCostCenti: lineCost,
          lineMarginCenti: lineTotal - lineCost,
          gapInches: (it.gapInches as number | undefined) ?? null,
          divanHeightInches: (it.divanHeightInches as number | undefined) ?? null,
          divanPriceSen: Number(it.divanPriceSen ?? 0),
          legHeightInches: (it.legHeightInches as number | undefined) ?? null,
          legPriceSen: Number(it.legPriceSen ?? 0),
          customSpecials: (it.customSpecials as unknown) ?? null,
          lineSuffix: (it.lineSuffix as string | undefined) ?? null,
          specialOrderPriceSen: Number(it.specialOrderPriceSen ?? 0),
          lineDeliveryDate: (it.lineDeliveryDate as string | undefined) ?? (delivDate ?? null),
          lineDeliveryDateOverridden: Boolean(it.lineDeliveryDateOverridden ?? false),
          // SERVICE lines start READY (allocation skips them).
          ...(isSvc ? { stockStatus: "READY" } : {}),
        });
      }
    } catch (e) {
      await db.delete(soTable).where(eq(soTable.docNo, docNo));
      return c.json({ error: "invalid_item", reason: errMsg(e) }, 400);
    }
    try {
      await db.insert(soItemsTable).values(itemRows as never);
    } catch (e) {
      await db.delete(soTable).where(eq(soTable.docNo, docNo));
      return c.json({ error: "items_insert_failed", reason: errMsg(e) }, 500);
    }
  }

  await recomputeTotals(db, docNo);

  // Optional POS deposit -> one is_deposit ledger row (mirrors 2990s).
  const depositCenti = Number(body.depositCenti ?? 0);
  if (depositCenti > 0 && body.paymentMethod) {
    try {
      await db.insert(soPaymentsTable).values({
        soDocNo: docNo,
        paidAt: (body.paymentDate as string | undefined) ?? todayMY,
        method: String(body.paymentMethod),
        merchantProvider: (body.merchantProvider as string | undefined) ?? null,
        installmentMonths: typeof body.installmentMonths === "number" ? (body.installmentMonths as number) : null,
        approvalCode: (body.approvalCode as string | undefined) ?? null,
        amountCenti: depositCenti,
        isDeposit: true,
        collectedBy: user.id,
        createdBy: user.id,
      } as never);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[so] deposit ledger insert failed (non-fatal):", errMsg(e));
    }
  }

  // Audit CREATE.
  await recordSoAudit(db, {
    docNo,
    action: "CREATE",
    actorId: user.id,
    actorName: user.name ?? null,
    fieldChanges: [
      { field: "debtorName", to: customerName },
      { field: "lineCount", to: items.length },
    ],
    statusSnapshot: "CONFIRMED",
  });

  /* New order = new demand -> recompute stock allocation (scoped to this SO but
     respecting older orders' claims). Best-effort. */
  try {
    await recomputeSoStockAllocation(db, docNo);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[so-allocation] post-create failed:", e);
  }

  return c.json({ docNo, doc_no: docNo }, 201);
});

/* Re-walk the global stock allocation on demand. */
app.post("/recompute-allocation", async (c) => {
  const db = getDb(c.env);
  const res = await recomputeSoStockAllocation(db);
  return c.json(res);
});

// ── Status transition (+ audit) ───────────────────────────────────────
app.patch("/:docNo/status", async (c) => {
  const db = getDb(c.env);
  const docNo = c.req.param("docNo");
  const user = c.get("user");
  let body: { status?: string; notes?: string };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  if (!body.status) return c.json({ error: "status_required" }, 400);

  const prevRows = await db.select({ status: soTable.status, proceededAt: soTable.proceededAt }).from(soTable).where(eq(soTable.docNo, docNo)).limit(1);
  if (!prevRows[0]) return c.json({ error: "not_found" }, 404);
  const fromStatus = prevRows[0].status as string;

  /* A CANCELLED SO is FINAL — re-order via a NEW SO (mirrors 2990s). */
  if (fromStatus === "CANCELLED" && body.status !== "CANCELLED") {
    return c.json({ error: "so_cancelled_final", reason: "A cancelled Sales Order cannot be reactivated — create a new SO instead." }, 409);
  }
  /* Tier 2 downstream-lock — only the CANCELLED transition is gated (no-op until
     DO/SI slice). */
  if (body.status === "CANCELLED" && fromStatus !== "CANCELLED") {
    const childLock = await soHasDownstream(db, docNo);
    if (childLock) return c.json(childLock, 409);
  }

  const patch: Record<string, unknown> = { status: body.status, updatedAt: new Date() };
  if (body.status === "IN_PRODUCTION" && !prevRows[0].proceededAt) {
    patch.proceededAt = new Date();
  }
  let updated: SoHeaderDb | undefined;
  try {
    const res = await db.update(soTable).set(patch).where(eq(soTable.docNo, docNo)).returning();
    updated = res[0];
  } catch (e) {
    return c.json({ error: "update_failed", reason: errMsg(e) }, 500);
  }

  // Legacy status-changes row + unified audit-log row (both best-effort).
  try {
    await db.insert(soStatusChangesTable).values({ docNo, fromStatus, toStatus: body.status, changedBy: user.id, notes: body.notes ?? null } as never);
  } catch {
    /* best-effort */
  }
  await recordSoAudit(db, {
    docNo,
    action: "UPDATE_STATUS",
    actorId: user.id,
    actorName: user.name ?? null,
    fieldChanges: [{ field: "status", from: fromStatus, to: body.status }],
    statusSnapshot: body.status,
    note: body.notes ?? undefined,
  });

  /* Status change -> recompute allocation (CANCELLED / terminal release their
     claims; other queued SOs may move into READY). Best-effort. */
  try {
    await recomputeSoStockAllocation(db);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[so-allocation] post-status failed:", e);
  }

  /* SO cancel -> deposit becomes customer credit. customer_credits (SI slice)
     not cloned -> no-op. TODO: SI slice. */

  return c.json({ salesOrder: updated ? { doc_no: updated.docNo, status: updated.status, proceeded_at: isoOrNull(updated.proceededAt) } : { doc_no: docNo, status: body.status } });
});

// ── Audit feeds ───────────────────────────────────────────────────────
app.get("/:docNo/audit-log", async (c) => {
  const db = getDb(c.env);
  const docNo = c.req.param("docNo");
  try {
    const rows = await db
      .select({
        id: soAuditTable.id,
        so_doc_no: soAuditTable.soDocNo,
        action: soAuditTable.action,
        actor_id: soAuditTable.actorId,
        actor_name_snapshot: soAuditTable.actorNameSnapshot,
        field_changes: soAuditTable.fieldChanges,
        status_snapshot: soAuditTable.statusSnapshot,
        source: soAuditTable.source,
        note: soAuditTable.note,
        created_at: soAuditTable.createdAt,
      })
      .from(soAuditTable)
      .where(eq(soAuditTable.soDocNo, docNo))
      .orderBy(desc(soAuditTable.createdAt));
    return c.json({ entries: rows.map((r) => ({ ...r, created_at: isoOrNull(r.created_at) })) });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

app.get("/:docNo/status-changes", async (c) => {
  const db = getDb(c.env);
  const docNo = c.req.param("docNo");
  try {
    const rows = await db
      .select({
        id: soStatusChangesTable.id,
        doc_no: soStatusChangesTable.docNo,
        from_status: soStatusChangesTable.fromStatus,
        to_status: soStatusChangesTable.toStatus,
        changed_by: soStatusChangesTable.changedBy,
        notes: soStatusChangesTable.notes,
        auto_actions: soStatusChangesTable.autoActions,
        created_at: soStatusChangesTable.createdAt,
      })
      .from(soStatusChangesTable)
      .where(eq(soStatusChangesTable.docNo, docNo))
      .orderBy(desc(soStatusChangesTable.createdAt));
    return c.json({ statusChanges: rows.map((r) => ({ ...r, created_at: isoOrNull(r.created_at) })) });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

app.get("/:docNo/price-overrides", async (c) => {
  const db = getDb(c.env);
  const docNo = c.req.param("docNo");
  try {
    const rows = await db
      .select({
        id: soOverridesTable.id,
        doc_no: soOverridesTable.docNo,
        item_id: soOverridesTable.itemId,
        item_code: soOverridesTable.itemCode,
        original_price_sen: soOverridesTable.originalPriceSen,
        override_price_sen: soOverridesTable.overridePriceSen,
        reason: soOverridesTable.reason,
        approved_by: soOverridesTable.approvedBy,
        created_at: soOverridesTable.createdAt,
      })
      .from(soOverridesTable)
      .where(eq(soOverridesTable.docNo, docNo))
      .orderBy(desc(soOverridesTable.createdAt));
    return c.json({ overrides: rows.map((r) => ({ ...r, created_at: isoOrNull(r.created_at) })) });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

// POST — override the price on a single line item. Captures the original in the
// audit row. (2990s gates this on admin-only roles; Houzs is owner-only "*" for
// the whole module so the gate is the route mount.)
app.post("/:docNo/items/:itemId/override", async (c) => {
  const db = getDb(c.env);
  const docNo = c.req.param("docNo");
  const itemId = c.req.param("itemId");
  const user = c.get("user");

  const procLock = await soProcessingLockBlocked(db, docNo);
  if (procLock) return c.json(procLock, 409);

  let body: { overridePriceSen?: number; reason?: string };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const newPrice = Number(body.overridePriceSen ?? 0);
  if (!Number.isFinite(newPrice) || newPrice < 0) return c.json({ error: "invalid_price" }, 400);

  const itemRows = await db
    .select({ id: soItemsTable.id, docNo: soItemsTable.docNo, itemCode: soItemsTable.itemCode, unitPriceCenti: soItemsTable.unitPriceCenti, qty: soItemsTable.qty, discountCenti: soItemsTable.discountCenti, lineCostCenti: soItemsTable.lineCostCenti })
    .from(soItemsTable)
    .where(eq(soItemsTable.id, itemId))
    .limit(1);
  const i = itemRows[0];
  if (!i) return c.json({ error: "item_not_found" }, 404);
  if (i.docNo !== docNo) return c.json({ error: "item_doc_mismatch" }, 400);
  if (Number(i.discountCenti ?? 0) > i.qty * newPrice) {
    return c.json({ error: "invalid_discount", reason: "Stored line discount exceeds qty × override price — the line total would go negative.", discount: Number(i.discountCenti ?? 0), max: i.qty * newPrice }, 422);
  }

  const originalPriceSen = i.unitPriceCenti;
  await db.insert(soOverridesTable).values({ docNo, itemId, itemCode: i.itemCode, originalPriceSen, overridePriceSen: newPrice, reason: body.reason ?? null, approvedBy: user.id } as never);

  const newLineTotal = i.qty * newPrice - i.discountCenti;
  const currentLineCost = Number(i.lineCostCenti ?? 0);
  try {
    await db.update(soItemsTable).set({ unitPriceCenti: newPrice, totalCenti: newLineTotal, totalIncCenti: newLineTotal, balanceCenti: newLineTotal, lineMarginCenti: newLineTotal - currentLineCost }).where(eq(soItemsTable.id, itemId));
  } catch (e) {
    return c.json({ error: "update_failed", reason: errMsg(e) }, 500);
  }
  await recomputeTotals(db, docNo);

  await recordSoAudit(db, {
    docNo,
    action: "UPDATE_LINE",
    actorId: user.id,
    actorName: user.name ?? null,
    fieldChanges: [{ field: "unitPriceCenti", from: originalPriceSen, to: newPrice }],
    note: (body.reason as string) || undefined,
  });

  return c.json({ ok: true, itemId, newPrice });
});

// ── PATCH header ──────────────────────────────────────────────────────
app.patch("/:docNo", async (c) => {
  const db = getDb(c.env);
  const docNo = c.req.param("docNo");
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  // Tier 2 downstream-lock (no-op until DO/SI) + processing-date lock.
  const childLock = await soHasDownstream(db, docNo);
  if (childLock) return c.json(childLock, 409);
  const procLock = await soProcessingLockBlocked(db, docNo);
  if (procLock) return c.json(procLock, 409);

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  const MAP: Array<[bodyKey: string, col: string]> = [
    ["transferTo", "transferTo"],
    ["soDate", "soDate"],
    ["branding", "branding"],
    ["debtorCode", "debtorCode"],
    ["debtorName", "debtorName"],
    ["agent", "agent"],
    ["salesLocation", "salesLocation"],
    ["ref", "ref"],
    ["poDocNo", "poDocNo"],
    ["venue", "venue"],
    ["venueId", "venueId"],
    ["address1", "address1"],
    ["address2", "address2"],
    ["address3", "address3"],
    ["address4", "address4"],
    ["phone", "phone"],
    ["currency", "currency"],
    ["remark2", "remark2"],
    ["remark3", "remark3"],
    ["remark4", "remark4"],
    ["note", "note"],
    ["processingDate", "processingDate"],
    ["customerId", "customerId"],
    ["customerState", "customerState"],
    ["customerCountry", "customerCountry"],
    ["customerPo", "customerPo"],
    ["customerPoId", "customerPoId"],
    ["customerPoDate", "customerPoDate"],
    ["customerPoImageB64", "customerPoImageB64"],
    ["customerSoNo", "customerSoNo"],
    ["hubId", "hubId"],
    ["hubName", "hubName"],
    ["customerDeliveryDate", "customerDeliveryDate"],
    ["internalExpectedDd", "internalExpectedDd"],
    ["shipToAddress", "shipToAddress"],
    ["billToAddress", "billToAddress"],
    ["installToAddress", "installToAddress"],
    ["email", "email"],
    ["customerType", "customerType"],
    ["salespersonId", "salespersonId"],
    ["city", "city"],
    ["postcode", "postcode"],
    ["buildingType", "buildingType"],
    ["emergencyContactName", "emergencyContactName"],
    ["emergencyContactPhone", "emergencyContactPhone"],
    ["emergencyContactRelationship", "emergencyContactRelationship"],
    ["targetDate", "targetDate"],
    ["paymentMethod", "paymentMethod"],
    ["installmentMonths", "installmentMonths"],
    ["merchantProvider", "merchantProvider"],
    ["approvalCode", "approvalCode"],
    ["paymentDate", "paymentDate"],
    ["depositCenti", "depositCenti"],
  ];
  for (const [bk, col] of MAP) {
    if (body[bk] !== undefined) updates[col] = body[bk];
  }

  try {
    const updated = await db.update(soTable).set(updates).where(eq(soTable.docNo, docNo)).returning();
    if (!updated[0]) return c.json({ error: "not_found" }, 404);

    /* PR-E — header customer_delivery_date change cascades to non-overridden
       lines (the master-follower rule, ported). */
    if (body.customerDeliveryDate !== undefined) {
      await db
        .update(soItemsTable)
        .set({ lineDeliveryDate: (body.customerDeliveryDate as string | null) ?? null })
        .where(and(eq(soItemsTable.docNo, docNo), eq(soItemsTable.lineDeliveryDateOverridden, false)));
    }

    return c.json({ salesOrder: toSoHeaderResponse(updated[0]) });
  } catch (e) {
    return c.json({ error: "update_failed", reason: errMsg(e) }, 500);
  }
});

/* Self-healing SO "picked" counter — recounts mfg_sales_order_items.po_qty_picked
   from the live PO lines. The PO route owns this (recomputeSoPicked); on the SO
   side the line CRUD doesn't touch po_qty_picked, so no recount is needed here. */

// ── Line items: add / edit / delete ────────────────────────────────────
const nextLineNo = async (db: Db, docNo: string): Promise<number | null> => {
  const rows = await db
    .select({ lineNo: soItemsTable.lineNo })
    .from(soItemsTable)
    .where(eq(soItemsTable.docNo, docNo))
    .orderBy(sql`${soItemsTable.lineNo} DESC NULLS LAST`)
    .limit(1);
  const v = rows[0]?.lineNo;
  return typeof v === "number" ? v + 1 : null;
};

app.post("/:docNo/items", async (c) => {
  const db = getDb(c.env);
  const docNo = c.req.param("docNo");
  const user = c.get("user");
  let it: Record<string, unknown>;
  try {
    it = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  if (!it.itemCode) return c.json({ error: "item_code_required" }, 400);

  const childLock = await soHasDownstream(db, docNo);
  if (childLock) return c.json(childLock, 409);

  const headerRows = await db
    .select({ debtorCode: soTable.debtorCode, debtorName: soTable.debtorName, agent: soTable.agent, branding: soTable.branding, venue: soTable.venue, customerDeliveryDate: soTable.customerDeliveryDate, internalExpectedDd: soTable.internalExpectedDd, processingDate: soTable.processingDate })
    .from(soTable)
    .where(eq(soTable.docNo, docNo))
    .limit(1);
  const header = headerRows[0];
  if (!header) return c.json({ error: "not_found" }, 404);
  if (soProcessingLocked({ internal_expected_dd: header.internalExpectedDd as string | null, processing_date: header.processingDate as string | null })) {
    return c.json(SO_PROCESSING_LOCKED_RESPONSE, 409);
  }

  const badQty = invalidQtyResponse(it.qty, it.itemCode);
  if (badQty) return c.json(badQty, 422);
  const qty = Math.max(1, Number(it.qty ?? 1));
  const unit = Math.max(0, Number(it.unitPriceCenti ?? 0));
  const discount = Math.max(0, Number(it.discountCenti ?? 0));
  if (discount > qty * unit) {
    return c.json({ error: "invalid_discount", reason: "discountCenti must be between 0 and qty × unit price.", itemCode: String(it.itemCode), discount, max: qty * unit }, 422);
  }
  const lineTotal = qty * unit - discount;
  const unitCost = Math.max(0, Number(it.unitCostCenti ?? 0));
  const lineCost = unitCost * qty;
  const itemGroup = String(it.itemGroup ?? "others");
  const isSvc = isServiceLine({ itemGroup, itemCode: String(it.itemCode) });

  const hasExplicitLineDate = it.lineDeliveryDate !== undefined && it.lineDeliveryDate !== null;
  const lineDeliveryDate = hasExplicitLineDate ? (it.lineDeliveryDate as string | null) : ((header.customerDeliveryDate as string | null) ?? null);
  const lineDeliveryDateOverridden = hasExplicitLineDate ? (it.lineDeliveryDateOverridden === undefined ? true : Boolean(it.lineDeliveryDateOverridden)) : Boolean(it.lineDeliveryDateOverridden ?? false);
  const lineNo = await nextLineNo(db, docNo);

  const row: Record<string, unknown> = {
    docNo,
    lineDate: (it.lineDate as string) ?? new Date().toISOString().slice(0, 10),
    ...(lineNo !== null ? { lineNo } : {}),
    debtorCode: header.debtorCode,
    debtorName: header.debtorName,
    agent: header.agent,
    itemGroup,
    itemCode: it.itemCode as string,
    description: (it.description as string | undefined) ?? null,
    description2: (it.description2 as string | undefined) ?? null,
    uom: (it.uom as string | undefined) ?? "UNIT",
    qty,
    unitPriceCenti: unit,
    discountCenti: discount,
    totalCenti: lineTotal,
    totalIncCenti: lineTotal,
    balanceCenti: lineTotal,
    venue: header.venue,
    branding: header.branding,
    variants: (it.variants as unknown) ?? null,
    unitCostCenti: unitCost,
    lineCostCenti: lineCost,
    lineMarginCenti: lineTotal - lineCost,
    gapInches: (it.gapInches as number | undefined) ?? null,
    divanHeightInches: (it.divanHeightInches as number | undefined) ?? null,
    divanPriceSen: Number(it.divanPriceSen ?? 0),
    legHeightInches: (it.legHeightInches as number | undefined) ?? null,
    legPriceSen: Number(it.legPriceSen ?? 0),
    customSpecials: (it.customSpecials as unknown) ?? null,
    lineSuffix: (it.lineSuffix as string | undefined) ?? null,
    specialOrderPriceSen: Number(it.specialOrderPriceSen ?? 0),
    lineDeliveryDate,
    lineDeliveryDateOverridden,
    warehouseId: (it.warehouseId as string | undefined) ?? null,
    ...(isSvc ? { stockStatus: "READY" } : {}),
  };

  try {
    const inserted = await db.insert(soItemsTable).values(row as never).returning();
    await recomputeTotals(db, docNo);
    await recordSoAudit(db, {
      docNo,
      action: "ADD_LINE",
      actorId: user.id,
      actorName: user.name ?? null,
      fieldChanges: [
        { field: "itemCode", to: row.itemCode },
        { field: "qty", to: row.qty },
        { field: "unitPriceCenti", to: row.unitPriceCenti },
        { field: "totalCenti", to: row.totalCenti },
      ],
    });
    try {
      await recomputeSoStockAllocation(db);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[so-allocation] post-line-add failed:", e);
    }
    return c.json({ item: toSoItemResponse(inserted[0]) }, 201);
  } catch (e) {
    return c.json({ error: "insert_failed", reason: errMsg(e) }, 500);
  }
});

app.patch("/:docNo/items/:itemId", async (c) => {
  const db = getDb(c.env);
  const docNo = c.req.param("docNo");
  const itemId = c.req.param("itemId");
  const user = c.get("user");
  let it: Record<string, unknown>;
  try {
    it = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const childLock = await soHasDownstream(db, docNo);
  if (childLock) return c.json(childLock, 409);
  const procLock = await soProcessingLockBlocked(db, docNo);
  if (procLock) return c.json(procLock, 409);

  const prevRows = await db
    .select({ qty: soItemsTable.qty, unitPriceCenti: soItemsTable.unitPriceCenti, discountCenti: soItemsTable.discountCenti, unitCostCenti: soItemsTable.unitCostCenti, itemCode: soItemsTable.itemCode })
    .from(soItemsTable)
    .where(eq(soItemsTable.id, itemId))
    .limit(1);
  const prev = prevRows[0];
  if (!prev) return c.json({ error: "not_found" }, 404);

  const badQty = invalidQtyResponse(it.qty, prev.itemCode);
  if (badQty) return c.json(badQty, 422);
  const qty = it.qty !== undefined ? Math.max(1, Number(it.qty)) : prev.qty;
  const unit = it.unitPriceCenti !== undefined ? Math.max(0, Number(it.unitPriceCenti)) : prev.unitPriceCenti;
  const discount = it.discountCenti !== undefined ? Math.max(0, Number(it.discountCenti)) : prev.discountCenti;
  if (discount > qty * unit) {
    return c.json({ error: "invalid_discount", reason: "discountCenti must be between 0 and qty × unit price.", itemCode: prev.itemCode, discount, max: qty * unit }, 422);
  }
  const lineTotal = qty * unit - discount;
  const unitCost = it.unitCostCenti !== undefined ? Math.max(0, Number(it.unitCostCenti)) : prev.unitCostCenti;
  const lineCost = unitCost * qty;

  const updates: Record<string, unknown> = {
    qty,
    unitPriceCenti: unit,
    discountCenti: discount,
    totalCenti: lineTotal,
    totalIncCenti: lineTotal,
    balanceCenti: lineTotal,
    unitCostCenti: unitCost,
    lineCostCenti: lineCost,
    lineMarginCenti: lineTotal - lineCost,
  };
  const MAP: Array<[bodyKey: string, col: string]> = [
    ["itemCode", "itemCode"],
    ["itemGroup", "itemGroup"],
    ["description", "description"],
    ["description2", "description2"],
    ["uom", "uom"],
    ["remark", "remark"],
    ["variants", "variants"],
    ["gapInches", "gapInches"],
    ["divanHeightInches", "divanHeightInches"],
    ["divanPriceSen", "divanPriceSen"],
    ["legHeightInches", "legHeightInches"],
    ["legPriceSen", "legPriceSen"],
    ["customSpecials", "customSpecials"],
    ["lineSuffix", "lineSuffix"],
    ["specialOrderPriceSen", "specialOrderPriceSen"],
    ["lineDeliveryDate", "lineDeliveryDate"],
    ["lineDeliveryDateOverridden", "lineDeliveryDateOverridden"],
    ["warehouseId", "warehouseId"],
    ["location", "location"],
    ["paymentStatus", "paymentStatus"],
  ];
  for (const [bk, col] of MAP) {
    if (it[bk] !== undefined) updates[col] = it[bk];
  }

  try {
    await db.update(soItemsTable).set(updates).where(eq(soItemsTable.id, itemId));
    await recomputeTotals(db, docNo);
    await recordSoAudit(db, {
      docNo,
      action: "UPDATE_LINE",
      actorId: user.id,
      actorName: user.name ?? null,
      fieldChanges: [
        { field: "itemCode", from: prev.itemCode, to: updates.itemCode ?? prev.itemCode },
        { field: "qty", from: prev.qty, to: qty },
        { field: "unitPriceCenti", from: prev.unitPriceCenti, to: unit },
      ],
    });
    try {
      await recomputeSoStockAllocation(db);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[so-allocation] post-line-edit failed:", e);
    }
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: "update_failed", reason: errMsg(e) }, 500);
  }
});

app.delete("/:docNo/items/:itemId", async (c) => {
  const db = getDb(c.env);
  const docNo = c.req.param("docNo");
  const itemId = c.req.param("itemId");
  const user = c.get("user");

  const childLock = await soHasDownstream(db, docNo);
  if (childLock) return c.json(childLock, 409);
  const procLock = await soProcessingLockBlocked(db, docNo);
  if (procLock) return c.json(procLock, 409);

  const prevRows = await db
    .select({ itemCode: soItemsTable.itemCode, qty: soItemsTable.qty, unitPriceCenti: soItemsTable.unitPriceCenti, totalCenti: soItemsTable.totalCenti })
    .from(soItemsTable)
    .where(eq(soItemsTable.id, itemId))
    .limit(1);
  const prev = prevRows[0];

  try {
    await db.delete(soItemsTable).where(eq(soItemsTable.id, itemId));
    await recomputeTotals(db, docNo);
    if (prev) {
      await recordSoAudit(db, {
        docNo,
        action: "DELETE_LINE",
        actorId: user.id,
        actorName: user.name ?? null,
        fieldChanges: [
          { field: "itemCode", from: prev.itemCode },
          { field: "qty", from: prev.qty },
          { field: "unitPriceCenti", from: prev.unitPriceCenti },
          { field: "totalCenti", from: prev.totalCenti },
        ],
      });
    }
    try {
      await recomputeSoStockAllocation(db);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[so-allocation] post-line-delete failed:", e);
    }
    return c.body(null, 204);
  } catch (e) {
    return c.json({ error: "delete_failed", reason: errMsg(e) }, 500);
  }
});

// ── Payments ──────────────────────────────────────────────────────────
const PAYMENT_SELECT = {
  id: soPaymentsTable.id,
  so_doc_no: soPaymentsTable.soDocNo,
  paid_at: soPaymentsTable.paidAt,
  method: soPaymentsTable.method,
  merchant_provider: soPaymentsTable.merchantProvider,
  installment_months: soPaymentsTable.installmentMonths,
  online_type: soPaymentsTable.onlineType,
  approval_code: soPaymentsTable.approvalCode,
  amount_centi: soPaymentsTable.amountCenti,
  account_sheet: soPaymentsTable.accountSheet,
  slip_key: soPaymentsTable.slipKey,
  collected_by: soPaymentsTable.collectedBy,
  note: soPaymentsTable.note,
  is_deposit: soPaymentsTable.isDeposit,
  created_at: soPaymentsTable.createdAt,
  created_by: soPaymentsTable.createdBy,
} as const;

app.get("/:docNo/payments", async (c) => {
  const db = getDb(c.env);
  const docNo = c.req.param("docNo");
  try {
    const rows = await db
      .select(PAYMENT_SELECT)
      .from(soPaymentsTable)
      .where(eq(soPaymentsTable.soDocNo, docNo))
      .orderBy(desc(soPaymentsTable.paidAt), desc(soPaymentsTable.createdAt));
    // collected_by_name resolved against users (best-effort, batched).
    const ids = [...new Set(rows.map((r) => r.collected_by).filter((x): x is number => x != null))];
    const nameById = new Map<number, string | null>();
    if (ids.length > 0) {
      const us = await db.select({ id: usersTable.id, name: usersTable.name }).from(usersTable).where(inArray(usersTable.id, ids));
      for (const u of us) nameById.set(u.id, u.name ?? null);
    }
    return c.json({ payments: rows.map((r) => ({ ...r, created_at: isoOrNull(r.created_at), collected_by_name: r.collected_by != null ? nameById.get(r.collected_by) ?? null : null })) });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

const paymentCreateSchema = z.object({
  paidAt: z.string().min(1),
  method: z.enum(["merchant", "transfer", "cash", "installment"]),
  merchantProvider: z.string().trim().min(1).optional().nullable(),
  installmentMonths: z.number().int().min(0).max(60).optional().nullable(),
  onlineType: z.string().trim().min(1).optional().nullable(),
  approvalCode: z.string().optional().nullable(),
  amountCenti: z.number().int().nonnegative(),
  accountSheet: z.string().optional().nullable(),
  collectedBy: z.number().int().optional().nullable(),
  note: z.string().optional().nullable(),
});

/* Account Sheet default by method (ported; the cascade UI sends a value, this
   is the fallback). */
function deriveAccountSheet(method: string, merchantProvider: string | null, onlineType: string | null): string | null {
  if (method === "cash") return "Cash";
  if (method === "merchant" || method === "installment") return merchantProvider ?? "Merchant";
  if (method === "transfer") return onlineType ?? "Bank Transfer";
  return null;
}

app.post("/:docNo/payments", async (c) => {
  const db = getDb(c.env);
  const docNo = c.req.param("docNo");
  const user = c.get("user");

  const soRows = await db.select({ docNo: soTable.docNo, totalRevenueCenti: soTable.totalRevenueCenti }).from(soTable).where(eq(soTable.docNo, docNo)).limit(1);
  if (!soRows[0]) return c.json({ error: "sales_order_not_found" }, 404);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const parsed = paymentCreateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
  const p = parsed.data;

  // Overpayment guard — Σ(ledger) + this payment may never exceed the SO total.
  const totalCenti = Number(soRows[0].totalRevenueCenti ?? 0);
  const paidRows = await db.select({ amountCenti: soPaymentsTable.amountCenti }).from(soPaymentsTable).where(eq(soPaymentsTable.soDocNo, docNo));
  const paidCenti = paidRows.reduce((s, r) => s + Number(r.amountCenti ?? 0), 0);
  if (totalCenti > 0 && paidCenti + p.amountCenti > totalCenti) {
    return c.json({ error: "over_payment", reason: `Payment exceeds the order total. Balance: ${((totalCenti - paidCenti) / 100).toFixed(2)}`, balanceCenti: Math.max(0, totalCenti - paidCenti) }, 400);
  }

  const merchantLike = p.method === "merchant" || p.method === "installment";
  const merchantProvider = merchantLike ? p.merchantProvider ?? null : null;
  const installmentMonths = merchantLike ? (typeof p.installmentMonths === "number" && p.installmentMonths > 0 ? p.installmentMonths : null) : null;
  const onlineType = p.method === "transfer" ? p.onlineType ?? null : null;

  /* Slip plumbing (R2 pending_slip_uploads) is out of scope this slice (no R2
     binding) — the payment is recorded without a slip resolve. */
  try {
    const inserted = await db
      .insert(soPaymentsTable)
      .values({
        soDocNo: docNo,
        paidAt: p.paidAt,
        method: p.method,
        merchantProvider,
        installmentMonths,
        onlineType,
        approvalCode: p.approvalCode ?? null,
        amountCenti: p.amountCenti,
        accountSheet: p.accountSheet?.trim() || deriveAccountSheet(p.method, merchantProvider, onlineType),
        collectedBy: p.collectedBy ?? null,
        note: p.note ?? null,
        createdBy: user.id,
      } as never)
      .returning(PAYMENT_SELECT);

    await recordSoAudit(db, {
      docNo,
      action: "ADD_PAYMENT",
      actorId: user.id,
      actorName: user.name ?? null,
      fieldChanges: [
        { field: "paidAt", from: null, to: p.paidAt },
        { field: "method", from: null, to: p.method },
        { field: "amountCenti", from: null, to: p.amountCenti },
        ...(merchantProvider ? [{ field: "merchantProvider", from: null, to: merchantProvider } satisfies FieldChange] : []),
        ...(installmentMonths ? [{ field: "installmentMonths", from: null, to: installmentMonths } satisfies FieldChange] : []),
        ...(onlineType ? [{ field: "onlineType", from: null, to: onlineType } satisfies FieldChange] : []),
        ...(p.approvalCode ? [{ field: "approvalCode", from: null, to: p.approvalCode } satisfies FieldChange] : []),
        ...(p.accountSheet ? [{ field: "accountSheet", from: null, to: p.accountSheet } satisfies FieldChange] : []),
      ],
    });

    return c.json({ payment: { ...inserted[0], created_at: isoOrNull(inserted[0].created_at) } }, 201);
  } catch (e) {
    return c.json({ error: "insert_failed", reason: errMsg(e) }, 500);
  }
});

app.delete("/:docNo/payments/:id", async (c) => {
  const db = getDb(c.env);
  const docNo = c.req.param("docNo");
  const id = c.req.param("id");
  const user = c.get("user");

  const rows = await db
    .select({ soDocNo: soPaymentsTable.soDocNo, paidAt: soPaymentsTable.paidAt, method: soPaymentsTable.method, amountCenti: soPaymentsTable.amountCenti, approvalCode: soPaymentsTable.approvalCode })
    .from(soPaymentsTable)
    .where(eq(soPaymentsTable.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return c.json({ error: "not_found" }, 404);
  if (row.soDocNo !== docNo) return c.json({ error: "payment_doc_mismatch" }, 400);

  try {
    await db.delete(soPaymentsTable).where(eq(soPaymentsTable.id, id));
  } catch (e) {
    return c.json({ error: "delete_failed", reason: errMsg(e) }, 500);
  }

  await recordSoAudit(db, {
    docNo,
    action: "DELETE_PAYMENT",
    actorId: user.id,
    actorName: user.name ?? null,
    fieldChanges: [
      { field: "paidAt", from: row.paidAt, to: null },
      { field: "method", from: row.method, to: null },
      { field: "amountCenti", from: row.amountCenti, to: null },
      ...(row.approvalCode ? [{ field: "approvalCode", from: row.approvalCode, to: null } satisfies FieldChange] : []),
    ],
  });

  return c.json({ ok: true });
});

// ── PATCH /:docNo/items/:itemId/stock-status ──────────────────────────
// Manual per-line stock fulfillment flag. After the flip, re-aggregate at the
// SO level + auto-advance to READY_TO_SHIP when every MAIN line is READY.
app.patch("/:docNo/items/:itemId/stock-status", async (c) => {
  const db = getDb(c.env);
  const docNo = c.req.param("docNo");
  const itemId = c.req.param("itemId");
  const user = c.get("user");

  let body: { status?: string };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const nextStatus = (body.status ?? "").trim().toUpperCase();
  if (nextStatus !== "PENDING" && nextStatus !== "READY") {
    return c.json({ error: "status_invalid", message: "PENDING or READY" }, 400);
  }

  const prevRows = await db
    .select({ stockStatus: soItemsTable.stockStatus, itemCode: soItemsTable.itemCode, itemGroup: soItemsTable.itemGroup, cancelled: soItemsTable.cancelled })
    .from(soItemsTable)
    .where(and(eq(soItemsTable.id, itemId), eq(soItemsTable.docNo, docNo)))
    .limit(1);
  const prev = prevRows[0];
  if (!prev) return c.json({ error: "not_found" }, 404);
  if (prev.cancelled) return c.json({ error: "item_cancelled", message: "Cannot change stock_status on a cancelled line." }, 400);
  if (prev.stockStatus === nextStatus) return c.json({ ok: true, unchanged: true });

  try {
    await db.update(soItemsTable).set({ stockStatus: nextStatus }).where(eq(soItemsTable.id, itemId));
  } catch (e) {
    return c.json({ error: "update_failed", reason: errMsg(e) }, 500);
  }

  await recordSoAudit(db, {
    docNo,
    action: "UPDATE_LINE",
    actorId: user.id,
    actorName: user.name ?? null,
    fieldChanges: [
      { field: "stockStatus", from: prev.stockStatus, to: nextStatus },
      { field: "itemCode", from: prev.itemCode, to: prev.itemCode },
    ],
    note: nextStatus === "READY" ? "Stock marked ready" : "Stock marked pending",
  });

  // Re-aggregate at the SO level (MAIN-ready auto-advance).
  const allLines = await db
    .select({ itemGroup: soItemsTable.itemGroup, itemCode: soItemsTable.itemCode, stockStatus: soItemsTable.stockStatus, cancelled: soItemsTable.cancelled })
    .from(soItemsTable)
    .where(eq(soItemsTable.docNo, docNo));
  const liveRows = allLines.filter((l) => !l.cancelled).map((l) => ({ item_group: l.itemGroup, item_code: l.itemCode, stock_status: l.stockStatus, cancelled: l.cancelled }));
  const readiness = summariseReadiness(liveRows);

  let advancedTo: string | null = null;
  if (readiness.isMainReady) {
    const headerRows = await db.select({ status: soTable.status }).from(soTable).where(eq(soTable.docNo, docNo)).limit(1);
    const cur = headerRows[0]?.status ?? null;
    if (cur === "CONFIRMED" || cur === "IN_PRODUCTION") {
      try {
        await db.update(soTable).set({ status: "READY_TO_SHIP" }).where(eq(soTable.docNo, docNo));
        advancedTo = "READY_TO_SHIP";
        await recordSoAudit(db, {
          docNo,
          action: "UPDATE_STATUS",
          actorId: user.id,
          actorName: user.name ?? null,
          statusSnapshot: "READY_TO_SHIP",
          fieldChanges: [{ field: "status", from: cur, to: "READY_TO_SHIP" }],
          note: "Auto-advanced: all lines READY",
        });
      } catch {
        /* best-effort */
      }
    }
  }

  return c.json({ ok: true, advancedTo });
});

// Postgres unique-violation (SQLSTATE 23505).
function isUniqueViolation(e: unknown): boolean {
  return Boolean(e && typeof e === "object" && (e as { code?: string }).code === "23505");
}

export default app;
