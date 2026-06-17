// ----------------------------------------------------------------------------
// /consignment-orders — B2B CONSIGNMENT ORDERS (the upstream sales-consignment
// order). 1:1 clone of 2990s apps/api/src/routes/consignment-orders.ts (itself a
// /mfg-sales-orders clone) onto the consignment_sales_* tables (migration 0031).
//
// A Consignment Order writes NO inventory movements (order only — same as the SO).
// Audit rows go to consignment_so_audit_log (NOT mfg_so_audit_log) via the
// consignment-scoped recordCoAudit helper, so CS- doc numbers don't collide.
//
// SEAMS only (rule #3/#4/#7):
//   - DB: 2990s per-request Supabase PostgREST -> Houzs Drizzle (getDb(c.env));
//     every .from().select/insert/update -> a Drizzle query; Drizzle camelCase
//     rows -> the snake_case wire shape via toCoHeaderResponse / toCoItemResponse.
//   - Auth: Supabase-JWT/RLS -> requirePermission("*").
//   - Actors: staff.id (uuid) -> users.id (integer) from c.get("user").
//   - Mount: /api/consignment-orders.
//
// Strategy-2 product-layer simplifications (Houzs is not the 2990s furniture
// business — see docs/scm-clone/PLAN.md) — the SAME stripping the SO slice did:
//   - DROPPED the ENTIRE furniture pricing engine: no recomputeFromSnapshot /
//     mfg-pricing-recompute, no sofa-combo / fabric-tier / variant pricing, no
//     allowed-options / variant-completeness checks, no validateItemCodes catalog
//     guard, no customer auto-resolve RPC, no state->country/sales-location derive,
//     no per-line R2 photo plumbing (no SO_ITEM_PHOTOS binding). A CO line's price
//     is the GENERIC qty x unit_price_centi - discount_centi entered directly. The
//     variant columns (gap/divan/leg/customSpecials/variants jsonb) are KEPT on the
//     schema for fidelity; create/edit pass them through. Description 2 is whatever
//     the client sends (2990s's buildVariantSummary is furniture-coupled, dropped).
//   - DROPPED the sofa-combo COST spread in recomputeTotals (the plain per-category
//     rollup is kept verbatim).
//   - The CO child-lock (coHasDownstream) queries consignment_delivery_orders by
//     consignment_so_doc_no — the CO's real downstream (Consignment Notes).
// ----------------------------------------------------------------------------

import { Hono } from "hono";
import { z } from "zod";
import { and, asc, desc, eq, ilike, inArray, like, or, sql } from "drizzle-orm";
import type { Env } from "../types";
import { getDb } from "../db/client";
import {
  consignmentSalesOrders as coTable,
  consignmentSalesOrderItems as coItemsTable,
  consignmentSalesOrderPayments as coPaymentsTable,
  consignmentSoAuditLog as coAuditTable,
  consignmentDeliveryOrders as cnTable,
  consignmentDeliveryOrderItems as cnItemsTable,
  users as usersTable,
} from "../db/schema";
import { requirePermission } from "../middleware/auth";
import type { FieldChange } from "../lib/so-audit";

const app = new Hono<{ Bindings: Env }>();
app.use("*", requirePermission("*"));

type Db = ReturnType<typeof getDb>;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
function isoOrNull(v: Date | string | null): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

/* ── Consignment-scoped audit helper ─────────────────────────────────────────
   Mirror of lib/so-audit.recordSoAudit but writes to consignment_so_audit_log
   (its FK so_doc_no -> consignment_sales_orders). Best-effort; never throws. */
async function recordCoAudit(
  db: Db,
  args: { docNo: string; action: string; actorId?: number | null; actorName?: string | null; fieldChanges?: FieldChange[]; statusSnapshot?: string | null; source?: string; note?: string },
): Promise<void> {
  try {
    let actorName = args.actorName ?? null;
    if (!actorName && args.actorId != null) {
      try {
        const rows = await db.select({ name: usersTable.name }).from(usersTable).where(eq(usersTable.id, args.actorId)).limit(1);
        actorName = rows[0]?.name ?? null;
      } catch { /* swallow */ }
    }
    await db.insert(coAuditTable).values({
      soDocNo: args.docNo,
      action: args.action,
      actorId: args.actorId ?? null,
      actorNameSnapshot: actorName,
      fieldChanges: (args.fieldChanges ?? []) as unknown,
      statusSnapshot: args.statusSnapshot ?? null,
      source: args.source ?? "web",
      note: args.note ?? null,
    } as never);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[co-audit] insert failed (non-fatal):", args.docNo, args.action, errMsg(e));
  }
}

/* diffFields — local copy (the lib one is fine too, but keep this route's import
   surface tight). Loose equality: null and '' collapse. */
function diffFields(before: Record<string, unknown>, patchCamel: Record<string, unknown>, aliases: Array<[string, string]>): FieldChange[] {
  const out: FieldChange[] = [];
  for (const [camel, snake] of aliases) {
    if (patchCamel[camel] === undefined) continue;
    const fromVal = before[snake];
    const toVal = patchCamel[camel];
    const a = fromVal == null ? "" : String(fromVal);
    const b = toVal == null ? "" : String(toVal);
    if (a !== b) out.push({ field: camel, from: fromVal ?? null, to: toVal ?? null });
  }
  return out;
}

/* ── Response shaping (Drizzle camelCase -> snake_case wire, rule #7). ──────── */
type CoHeaderDb = typeof coTable.$inferSelect;
type CoItemDb = typeof coItemsTable.$inferSelect;

function toCoHeaderResponse(p: CoHeaderDb): Record<string, unknown> {
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
    local_total_centi: p.localTotalCenti,
    balance_centi: p.balanceCenti,
    total_cost_centi: p.totalCostCenti,
    total_revenue_centi: p.totalRevenueCenti,
    total_margin_centi: p.totalMarginCenti,
    margin_pct_basis: p.marginPctBasis,
    line_count: p.lineCount,
    subtotal_sen: p.subtotalSen,
    overdue: p.overdue,
    currency: p.currency,
    status: p.status,
    remark2: p.remark2,
    remark3: p.remark3,
    remark4: p.remark4,
    note: p.note,
    processing_date: p.processingDate,
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
function toCoItemResponse(it: CoItemDb): Record<string, unknown> {
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
    divan_price_sen: it.divanPriceSen,
    leg_price_sen: it.legPriceSen,
    special_order_price_sen: it.specialOrderPriceSen,
    custom_specials: it.customSpecials ?? null,
    line_delivery_date: it.lineDeliveryDate,
    line_delivery_date_overridden: it.lineDeliveryDateOverridden,
    photo_urls: it.photoUrls ?? [],
    created_at: isoOrNull(it.createdAt),
  };
}

/* ── CO child-lock guard (Tier 2 — downstream lock) ─────────────────────────
   A CO locks (read-only — no line edit / no CANCELLED transition) once it has
   ANY non-cancelled Consignment Note (consignment_delivery_orders keyed on
   consignment_so_doc_no) referencing it. Returns the blocking JSON, or null. */
async function coHasDownstream(db: Db, coDocNo: string): Promise<{ error: string; message: string } | null> {
  const rows = await db
    .select({ id: cnTable.id })
    .from(cnTable)
    .where(and(eq(cnTable.consignmentSoDocNo, coDocNo), sql`${cnTable.status} <> 'CANCELLED'`))
    .limit(1);
  if (rows.length > 0) {
    return { error: "co_has_downstream", message: "Consignment Order has a Consignment Note — cancel it first to edit" };
  }
  return null;
}

/* Identity + value columns a downstream Note snapshots. Frozen on the CO header
   once a non-cancelled child exists; payment/remark/scheduling cols are NOT here.
   Keyed by Drizzle property name (we diff against the camelCase row). */
const CO_IDENTITY_LOCK_COLS = new Set<string>([
  "debtorCode", "debtorName", "agent", "salesLocation", "ref", "poDocNo",
  "venue", "venueId", "branding", "address1", "address2", "address3", "address4",
  "phone", "currency", "soDate", "customerId", "customerState", "customerPo",
  "customerPoId", "customerPoDate", "customerPoImageB64", "customerSoNo",
  "hubId", "hubName", "shipToAddress", "billToAddress", "installToAddress",
  "email", "customerType", "salespersonId", "city", "postcode", "buildingType",
  "emergencyContactName", "emergencyContactPhone", "emergencyContactRelationship",
]);

function norm(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

const nextDocNo = async (db: Db): Promise<string> => {
  // Format: CS-YYMM-NNN (Consignment Order numbering, counts within month).
  const d = new Date();
  const yymm = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, "0")}`;
  const rows = await db.select({ docNo: coTable.docNo }).from(coTable).where(like(coTable.docNo, `CS-${yymm}-%`));
  let maxN = 0;
  for (const r of rows) { const m = /-(\d+)$/.exec(r.docNo); if (m) maxN = Math.max(maxN, parseInt(m[1], 10)); }
  return `CS-${yymm}-${String(maxN + 1).padStart(3, "0")}`;
};

/* ── recomputeTotals — plain per-category rollup (Strategy-2: the sofa-combo COST
   spread is dropped; the rest is verbatim from the SO/Note recompute). ──────── */
async function recomputeTotals(db: Db, docNo: string): Promise<void> {
  const items = await db
    .select({ itemGroup: coItemsTable.itemGroup, totalCenti: coItemsTable.totalCenti, lineCostCenti: coItemsTable.lineCostCenti })
    .from(coItemsTable)
    .where(and(eq(coItemsTable.docNo, docNo), eq(coItemsTable.cancelled, false)));
  let mattressSofa = 0, bedframe = 0, accessories = 0, others = 0, total = 0, totalCost = 0;
  let mattressSofaCost = 0, bedframeCost = 0, accessoriesCost = 0, othersCost = 0;
  for (const it of items) {
    const lineTotal = Number(it.totalCenti ?? 0);
    const lineCost = Number(it.lineCostCenti ?? 0);
    total += lineTotal;
    totalCost += lineCost;
    const g = (it.itemGroup ?? "").toLowerCase();
    if (g.includes("mattress") || g.includes("sofa")) { mattressSofa += lineTotal; mattressSofaCost += lineCost; }
    else if (g.includes("bedframe")) { bedframe += lineTotal; bedframeCost += lineCost; }
    else if (g.includes("accessor")) { accessories += lineTotal; accessoriesCost += lineCost; }
    else { others += lineTotal; othersCost += lineCost; }
  }
  const margin = total - totalCost;
  await db.update(coTable).set({
    mattressSofaCenti: mattressSofa, bedframeCenti: bedframe, accessoriesCenti: accessories, othersCenti: others,
    mattressSofaCostCenti: mattressSofaCost, bedframeCostCenti: bedframeCost, accessoriesCostCenti: accessoriesCost, othersCostCenti: othersCost,
    localTotalCenti: total, balanceCenti: total, totalCostCenti: totalCost, totalRevenueCenti: total, totalMarginCenti: margin,
    marginPctBasis: total > 0 ? Math.round((margin / total) * 10000) : 0, lineCount: items.length, updatedAt: new Date(),
  }).where(eq(coTable.docNo, docNo));
}

/* Per-CO-line delivery breakdown — which Consignment Note (=CN) shipped how much
   against each order line. Mirrors the SO detail's per-line `deliveries`.
   Cancelled notes excluded. */
type CoLineDelivery = { noNumber: string; qty: number; status: string };
async function coLineDeliveries(db: Db, soItemIds: string[]): Promise<Map<string, CoLineDelivery[]>> {
  const out = new Map<string, CoLineDelivery[]>();
  if (soItemIds.length === 0) return out;
  const doLines = await db
    .select({ consignmentSoItemId: cnItemsTable.consignmentSoItemId, qty: cnItemsTable.qty, consignmentDeliveryOrderId: cnItemsTable.consignmentDeliveryOrderId })
    .from(cnItemsTable)
    .where(inArray(cnItemsTable.consignmentSoItemId, soItemIds));
  const doIds = [...new Set(doLines.map((r) => r.consignmentDeliveryOrderId).filter(Boolean))];
  if (doIds.length === 0) return out;
  const dos = await db.select({ id: cnTable.id, doNumber: cnTable.doNumber, status: cnTable.status }).from(cnTable).where(inArray(cnTable.id, doIds));
  const doMeta = new Map<string, { noNumber: string; status: string }>();
  for (const g of dos) { if ((g.status ?? "").toUpperCase() === "CANCELLED") continue; doMeta.set(g.id, { noNumber: g.doNumber ?? "—", status: (g.status ?? "").toUpperCase() }); }
  for (const r of doLines) {
    if (!r.consignmentSoItemId) continue;
    const meta = doMeta.get(r.consignmentDeliveryOrderId);
    if (!meta) continue;
    const qty = Number(r.qty ?? 0);
    if (qty <= 0) continue;
    const arr = out.get(r.consignmentSoItemId) ?? [];
    arr.push({ noNumber: meta.noNumber, qty, status: meta.status });
    out.set(r.consignmentSoItemId, arr);
  }
  return out;
}

/* normCategory — list-aggregate helper (verbatim from 2990s). */
const normCategory = (raw: string): string => {
  const g = (raw ?? "").trim().toUpperCase();
  if (g.includes("BEDFRAME")) return "BEDFRAME";
  if (g.includes("SOFA")) return "SOFA";
  if (g.includes("MATTRESS")) return "MATTRESS";
  if (g.includes("ACCESSOR")) return "ACCESSORY";
  return "OTHERS";
};

// ── List ──────────────────────────────────────────────────────────────
app.get("/", async (c) => {
  const db = getDb(c.env);
  try {
    const conds = [];
    const status = c.req.query("status");
    if (status) conds.push(eq(coTable.status, status as CoHeaderDb["status"]));
    const debtor = c.req.query("debtor");
    if (debtor) conds.push(ilike(coTable.debtorName, `%${debtor}%`));
    const headerRows = await db.select().from(coTable).where(conds.length ? and(...conds) : undefined).orderBy(desc(coTable.soDate)).limit(500);
    const rows = headerRows.map((h) => toCoHeaderResponse(h));
    const docNos = headerRows.map((h) => h.docNo).filter(Boolean);

    if (docNos.length > 0) {
      // Per-CO category set + first-item branding source (ordered doc_no, created_at ASC).
      const itemRows = await db
        .select({ docNo: coItemsTable.docNo, itemGroup: coItemsTable.itemGroup, branding: coItemsTable.branding, itemCode: coItemsTable.itemCode, createdAt: coItemsTable.createdAt })
        .from(coItemsTable)
        .where(and(inArray(coItemsTable.docNo, docNos), eq(coItemsTable.cancelled, false)))
        .orderBy(asc(coItemsTable.docNo), asc(coItemsTable.createdAt));
      const cats = new Map<string, Set<string>>();
      const firstCat = new Map<string, string>();
      const firstBranding = new Map<string, string | null>();
      for (const it of itemRows) {
        let catSet = cats.get(it.docNo);
        if (!catSet) { catSet = new Set(); cats.set(it.docNo, catSet); }
        catSet.add(normCategory(it.itemGroup ?? ""));
        if (!firstCat.has(it.docNo)) {
          firstCat.set(it.docNo, normCategory(it.itemGroup ?? ""));
          firstBranding.set(it.docNo, it.branding ?? null);
        }
      }

      // Payment Method summary from the payments LEDGER.
      const paymentMethods = new Map<string, Set<string>>();
      const payRows = await db.select({ soDocNo: coPaymentsTable.soDocNo, method: coPaymentsTable.method, onlineType: coPaymentsTable.onlineType }).from(coPaymentsTable).where(inArray(coPaymentsTable.soDocNo, docNos));
      for (const p of payRows) {
        const m = (p.method ?? "").trim().toLowerCase();
        let label: string;
        if (m === "cash") label = "Cash";
        else if (m === "merchant") label = "Card";
        else if (m === "transfer") label = p.onlineType && p.onlineType.trim() ? p.onlineType.trim() : "Transfer";
        else continue;
        let set = paymentMethods.get(p.soDocNo);
        if (!set) { set = new Set(); paymentMethods.set(p.soDocNo, set); }
        set.add(label);
      }

      // Tier 2 downstream-lock — has_children from non-cancelled Consignment Notes.
      const downstreamDocNos = new Set<string>();
      const noteRows = await db.select({ consignmentSoDocNo: cnTable.consignmentSoDocNo }).from(cnTable).where(and(inArray(cnTable.consignmentSoDocNo, docNos), sql`${cnTable.status} <> 'CANCELLED'`));
      for (const d of noteRows) if (d.consignmentSoDocNo) downstreamDocNos.add(d.consignmentSoDocNo);

      for (const r of rows) {
        const docNo = (r.doc_no as string) ?? "";
        r.item_categories = [...(cats.get(docNo) ?? [])].sort();
        r.has_children = downstreamDocNos.has(docNo);
        r.first_item_category = firstCat.get(docNo) ?? null;
        r.first_item_branding = firstBranding.get(docNo) ?? null;
        const pm = paymentMethods.get(docNo);
        r.payment_methods_summary = pm ? [...pm].sort().join(" + ") : "";
      }
    }

    return c.json({ salesOrders: rows });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

/* "My consignment orders" board — the salesperson's OWN COs (lightweight). */
app.get("/mine", async (c) => {
  const db = getDb(c.env);
  const user = c.get("user");
  try {
    const rows = await db.select().from(coTable)
      .where(and(eq(coTable.salespersonId, user.id), sql`${coTable.status} NOT IN ('CANCELLED','ON_HOLD')`))
      .orderBy(desc(coTable.createdAt)).limit(80);
    const docNos = rows.map((r) => r.docNo).filter(Boolean);
    const itemsByDoc = new Map<string, Array<{ item_code: string; description: string | null; qty: number; total_centi: number; variants: unknown }>>();
    if (docNos.length > 0) {
      const itemRows = await db.select({ docNo: coItemsTable.docNo, itemCode: coItemsTable.itemCode, description: coItemsTable.description, qty: coItemsTable.qty, totalCenti: coItemsTable.totalCenti, variants: coItemsTable.variants })
        .from(coItemsTable).where(and(inArray(coItemsTable.docNo, docNos), eq(coItemsTable.cancelled, false))).orderBy(asc(coItemsTable.createdAt));
      for (const it of itemRows) {
        const arr = itemsByDoc.get(it.docNo) ?? [];
        arr.push({ item_code: it.itemCode, description: it.description, qty: it.qty, total_centi: Number(it.totalCenti ?? 0), variants: it.variants ?? null });
        itemsByDoc.set(it.docNo, arr);
      }
    }
    const paidLedgerByDoc = new Map<string, number>();
    if (docNos.length > 0) {
      const payRows = await db.select({ soDocNo: coPaymentsTable.soDocNo, amountCenti: coPaymentsTable.amountCenti }).from(coPaymentsTable).where(inArray(coPaymentsTable.soDocNo, docNos));
      for (const p of payRows) paidLedgerByDoc.set(p.soDocNo, (paidLedgerByDoc.get(p.soDocNo) ?? 0) + Number(p.amountCenti ?? 0));
    }
    const salesOrders = rows.map((r) => {
      const base = toCoHeaderResponse(r);
      const deposit = Number(r.depositCenti ?? 0);
      const ledger = paidLedgerByDoc.get(r.docNo) ?? 0;
      return { ...base, paid_centi_total: deposit + ledger, items: itemsByDoc.get(r.docNo) ?? [] };
    });
    return c.json({ salesOrders });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

// ── Debtor lookup — autocomplete from prior consignment orders. STATIC, pre /:docNo ──
app.get("/debtors/search", async (c) => {
  const db = getDb(c.env);
  const q = c.req.query("q") ?? "";
  try {
    const s = q.trim();
    const conds = s ? or(ilike(coTable.debtorName, `%${s}%`), ilike(coTable.debtorCode, `%${s}%`)) : undefined;
    const rows = await db.select({ debtor_code: coTable.debtorCode, debtor_name: coTable.debtorName, phone: coTable.phone, address1: coTable.address1, address2: coTable.address2, address3: coTable.address3, address4: coTable.address4 })
      .from(coTable).where(conds).orderBy(desc(coTable.updatedAt)).limit(200);
    const seen = new Set<string>();
    const out: typeof rows = [];
    for (const r of rows) {
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

// ── Detail ──────────────────────────────────────────────────────────────
app.get("/:docNo", async (c) => {
  const db = getDb(c.env);
  const docNo = c.req.param("docNo");
  try {
    const [headerRows, itemRows] = await Promise.all([
      db.select().from(coTable).where(eq(coTable.docNo, docNo)).limit(1),
      db.select().from(coItemsTable).where(eq(coItemsTable.docNo, docNo)).orderBy(asc(coItemsTable.createdAt)),
    ]);
    const header = headerRows[0];
    if (!header) return c.json({ error: "not_found" }, 404);
    const { length: noteCount } = await db.select({ id: cnTable.id }).from(cnTable).where(and(eq(cnTable.consignmentSoDocNo, docNo), sql`${cnTable.status} <> 'CANCELLED'`)).limit(1);
    const salesOrder = { ...toCoHeaderResponse(header), has_children: noteCount > 0 };
    const deliveriesMap = await coLineDeliveries(db, itemRows.map((it) => it.id));
    const items = itemRows.map((it) => ({ ...toCoItemResponse(it), deliveries: deliveriesMap.get(it.id) ?? [] }));
    return c.json({ salesOrder, items });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

/* Build one consignment_sales_order_items insert row from a client line payload.
   Strategy-2: GENERIC line math (qty x unit - discount). Variant cols passed
   through; description2 = whatever the client sends. */
function buildItemRow(docNo: string, header: { debtorCode: string | null; debtorName: string; agent: string | null; branding: string | null; venue: string | null; customerDeliveryDate: string | null }, it: Record<string, unknown>): Record<string, unknown> {
  const qty = Number(it.qty ?? 1);
  const unit = Number(it.unitPriceCenti ?? 0);
  const discount = Number(it.discountCenti ?? 0);
  const unitCost = Number(it.unitCostCenti ?? 0);
  const lineTotal = qty * unit - discount;
  const lineCost = unitCost * qty;
  const hasExplicitLineDate = it.lineDeliveryDate !== undefined && it.lineDeliveryDate !== null;
  const lineDeliveryDate = hasExplicitLineDate ? (it.lineDeliveryDate as string | null) : header.customerDeliveryDate;
  const lineDeliveryDateOverridden = hasExplicitLineDate ? (it.lineDeliveryDateOverridden === undefined ? true : Boolean(it.lineDeliveryDateOverridden)) : Boolean(it.lineDeliveryDateOverridden ?? false);
  return {
    docNo,
    lineDate: (it.lineDate as string) ?? new Date().toISOString().slice(0, 10),
    debtorCode: header.debtorCode,
    debtorName: header.debtorName,
    agent: header.agent,
    itemGroup: (it.itemGroup as string) ?? "others",
    itemCode: it.itemCode,
    description: (it.description as string) ?? null,
    description2: (it.description2 as string) ?? null,
    uom: (it.uom as string) ?? "UNIT",
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
    lineDeliveryDate,
    lineDeliveryDateOverridden,
  };
}

// ── Create ──────────────────────────────────────────────────────────────
app.post("/", async (c) => {
  const db = getDb(c.env);
  const user = c.get("user");
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: "invalid_json" }, 400); }
  const customerName = (body.debtorName ?? body.customerName) as string | undefined;
  if (!customerName) return c.json({ error: "customer_name_required" }, 400);
  // Phone is COMPULSORY (mirrors the SO route). Strategy-2: no phone normalisation lib.
  const rawPhone = typeof body.phone === "string" ? body.phone.trim() : "";
  if (!rawPhone) return c.json({ error: "phone_required", reason: "A phone number is required on every consignment order." }, 400);
  const items = (body.items as Array<Record<string, unknown>> | undefined) ?? [];

  // CO composition rules (mirror the SO create path; Strategy-2 drops the
  // catalog/category lookup + variant-completeness — generic item_group only):
  {
    const procDate = (body.internalExpectedDd as string | null | undefined) || null;
    const delivDate = (body.customerDeliveryDate as string | null | undefined) || null;
    if (Boolean(procDate) !== Boolean(delivDate)) return c.json({ error: "processing_delivery_must_pair", reason: "Processing Date and Delivery Date must be set together (or both left empty)." }, 400);
    if (procDate && delivDate && procDate > delivDate) return c.json({ error: "processing_after_delivery", reason: "Processing Date cannot be later than the Delivery Date." }, 400);
    const todayMY = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    if (procDate && procDate < todayMY) return c.json({ error: "processing_date_past", reason: "Processing Date cannot be in the past — today or a future date only." }, 400);
    if (delivDate && delivDate < todayMY) return c.json({ error: "delivery_date_past", reason: "Delivery Date cannot be in the past — today or a future date only." }, 400);
  }

  const docNo = await nextDocNo(db);

  // Compute totals + category breakdown (generic; no pricing engine).
  let mattressSofa = 0, bedframe = 0, accessories = 0, others = 0, total = 0, totalCost = 0;
  let mattressSofaCost = 0, bedframeCost = 0, accessoriesCost = 0, othersCost = 0;
  const headerDeliveryDate = (body.customerDeliveryDate as string | null | undefined) ?? null;
  const headerForLines = {
    debtorCode: ((body.debtorCode ?? body.customerCode) as string) ?? null,
    debtorName: customerName,
    agent: (body.agent as string) ?? null,
    branding: (body.branding as string) ?? null,
    venue: (body.venue as string) ?? null,
    customerDeliveryDate: headerDeliveryDate,
  };

  const itemRows = items.map((it) => {
    const row = buildItemRow(docNo, headerForLines, it);
    const lineTotal = Number(row.totalCenti ?? 0);
    const lineCost = Number(row.lineCostCenti ?? 0);
    total += lineTotal;
    totalCost += lineCost;
    const g = String(it.itemGroup ?? "").toLowerCase();
    if (g.includes("mattress") || g.includes("sofa")) { mattressSofa += lineTotal; mattressSofaCost += lineCost; }
    else if (g.includes("bedframe")) { bedframe += lineTotal; bedframeCost += lineCost; }
    else if (g.includes("accessor")) { accessories += lineTotal; accessoriesCost += lineCost; }
    else { others += lineTotal; othersCost += lineCost; }
    return row;
  });

  const margin = total - totalCost;
  const marginPctBasis = total > 0 ? Math.round((margin / total) * 10000) : 0;

  try {
    await db.insert(coTable).values({
      docNo,
      transferTo: (body.transferTo as string) ?? null,
      soDate: (body.soDate as string) ?? new Date().toISOString().slice(0, 10),
      branding: (body.branding as string) ?? null,
      debtorCode: ((body.debtorCode ?? body.customerCode) as string) ?? null,
      debtorName: customerName,
      agent: (body.agent as string) ?? null,
      salesLocation: (body.salesLocation as string) ?? null,
      ref: (body.ref as string) ?? null,
      poDocNo: (body.poDocNo as string) ?? null,
      venue: (body.venue as string) ?? null,
      venueId: (body.venueId as string) ?? null,
      address1: (body.address1 as string) ?? null,
      address2: (body.address2 as string) ?? null,
      address3: (body.address3 as string) ?? null,
      address4: (body.address4 as string) ?? null,
      phone: rawPhone,
      mattressSofaCenti: mattressSofa,
      bedframeCenti: bedframe,
      accessoriesCenti: accessories,
      othersCenti: others,
      mattressSofaCostCenti: mattressSofaCost,
      bedframeCostCenti: bedframeCost,
      accessoriesCostCenti: accessoriesCost,
      othersCostCenti: othersCost,
      localTotalCenti: total,
      balanceCenti: total,
      totalCostCenti: totalCost,
      totalRevenueCenti: total,
      totalMarginCenti: margin,
      marginPctBasis,
      lineCount: items.length,
      currency: (((body.currency as string) ?? "MYR").toUpperCase()) as never,
      note: (body.note as string) ?? null,
      email: (body.email as string) ?? null,
      customerType: (body.customerType as string) ?? null,
      salespersonId: typeof body.salespersonId === "number" ? (body.salespersonId as number) : null,
      city: (body.city as string) ?? null,
      postcode: (body.postcode as string) ?? null,
      buildingType: (body.buildingType as string) ?? null,
      emergencyContactName: (body.emergencyContactName as string) ?? null,
      emergencyContactPhone: (body.emergencyContactPhone as string) ?? null,
      emergencyContactRelationship: (body.emergencyContactRelationship as string) ?? null,
      targetDate: (body.targetDate as string) ?? null,
      customerId: (body.customerId as string) ?? null,
      customerState: (body.customerState as string) ?? null,
      customerCountry: (body.customerCountry as string) ?? null,
      customerDeliveryDate: (body.customerDeliveryDate as string) ?? null,
      internalExpectedDd: (body.internalExpectedDd as string) ?? null,
      customerSoNo: (body.customerSoNo as string) ?? null,
      customerPo: (body.customerPo as string) ?? null,
      hubId: (body.hubId as string) ?? null,
      hubName: (body.hubName as string) ?? null,
      billToAddress: (body.billToAddress as string) ?? null,
      signatureB64: (body.signatureB64 as string) ?? null,
      paymentMethod: (body.paymentMethod as string) ?? null,
      installmentMonths: typeof body.installmentMonths === "number" ? (body.installmentMonths as number) : null,
      merchantProvider: (body.merchantProvider as string) ?? null,
      approvalCode: (body.approvalCode as string) ?? null,
      paymentDate: (body.paymentDate as string) ?? null,
      depositCenti: typeof body.depositCenti === "number" ? (body.depositCenti as number) : 0,
      paidCenti: typeof body.paidCenti === "number" ? (body.paidCenti as number) : 0,
      // Every new CO is CONFIRMED on insert (2990 has no DRAFT step).
      status: "CONFIRMED",
      createdBy: user.id,
    } as never);
  } catch (e) {
    return c.json({ error: "insert_failed", reason: errMsg(e) }, 500);
  }

  if (itemRows.length > 0) {
    try {
      await db.insert(coItemsTable).values(itemRows as never);
      await recomputeTotals(db, docNo);
    } catch (e) {
      await db.delete(coTable).where(eq(coTable.docNo, docNo));
      return c.json({ error: "items_insert_failed", reason: errMsg(e) }, 500);
    }
  }

  // Audit row — one CREATE entry.
  const createFields: FieldChange[] = [];
  const captureIfSet = (k: string, v: unknown) => { if (v !== undefined && v !== null && v !== "") createFields.push({ field: k, to: v }); };
  captureIfSet("debtorName", customerName);
  captureIfSet("debtorCode", body.debtorCode);
  captureIfSet("agent", body.agent);
  captureIfSet("phone", body.phone);
  captureIfSet("email", body.email);
  captureIfSet("soDate", body.soDate);
  captureIfSet("lineCount", items.length);
  captureIfSet("localTotalCenti", total);
  captureIfSet("paymentMethod", body.paymentMethod);
  captureIfSet("depositCenti", body.depositCenti);
  captureIfSet("internalExpectedDd", body.internalExpectedDd);
  captureIfSet("customerSoNo", body.customerSoNo);
  captureIfSet("customerPo", body.customerPo);
  await recordCoAudit(db, { docNo, action: "CREATE", actorId: user.id, fieldChanges: createFields, statusSnapshot: "CONFIRMED" });

  return c.json({ docNo }, 201);
});

// ── Status transition (+ audit) ───────────────────────────────────────────
app.patch("/:docNo/status", async (c) => {
  const db = getDb(c.env);
  const docNo = c.req.param("docNo");
  const user = c.get("user");
  let body: { status?: string; notes?: string };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: "invalid_json" }, 400); }
  if (!body.status) return c.json({ error: "status_required" }, 400);

  const prevRows = await db.select({ status: coTable.status }).from(coTable).where(eq(coTable.docNo, docNo)).limit(1);
  const fromStatus = prevRows[0]?.status ?? null;

  if (body.status === "CANCELLED" && fromStatus !== "CANCELLED") {
    const childLock = await coHasDownstream(db, docNo);
    if (childLock) return c.json(childLock, 409);
  }

  try {
    const updated = await db.update(coTable).set({ status: body.status as CoHeaderDb["status"], updatedAt: new Date() }).where(eq(coTable.docNo, docNo)).returning({ doc_no: coTable.docNo, status: coTable.status });
    if (!updated[0]) return c.json({ error: "not_found" }, 404);
    await recordCoAudit(db, { docNo, action: "UPDATE_STATUS", actorId: user.id, fieldChanges: [{ field: "status", from: fromStatus, to: body.status }], statusSnapshot: body.status, note: body.notes ?? undefined });
    return c.json({ salesOrder: updated[0] });
  } catch (e) {
    return c.json({ error: "update_failed", reason: errMsg(e) }, 500);
  }
});

// ── GET /:docNo/audit-log — unified history feed (newest first). ──────
app.get("/:docNo/audit-log", async (c) => {
  const db = getDb(c.env);
  const docNo = c.req.param("docNo");
  try {
    const rows = await db.select().from(coAuditTable).where(eq(coAuditTable.soDocNo, docNo)).orderBy(desc(coAuditTable.createdAt));
    const entries = rows.map((r) => ({
      id: r.id, so_doc_no: r.soDocNo, action: r.action, actor_id: r.actorId, actor_name_snapshot: r.actorNameSnapshot,
      field_changes: r.fieldChanges ?? [], status_snapshot: r.statusSnapshot, source: r.source, note: r.note, created_at: isoOrNull(r.createdAt),
    }));
    return c.json({ entries });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

// POST — override the price on a single line item.
app.post("/:docNo/items/:itemId/override", async (c) => {
  const db = getDb(c.env);
  const docNo = c.req.param("docNo");
  const itemId = c.req.param("itemId");
  const user = c.get("user");
  let body: { overridePriceSen?: number; reason?: string };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: "invalid_json" }, 400); }
  const newPrice = Number(body.overridePriceSen ?? 0);
  if (!Number.isFinite(newPrice) || newPrice < 0) return c.json({ error: "invalid_price" }, 400);

  const itemRows = await db.select({ id: coItemsTable.id, docNo: coItemsTable.docNo, unitPriceCenti: coItemsTable.unitPriceCenti, qty: coItemsTable.qty, discountCenti: coItemsTable.discountCenti, lineCostCenti: coItemsTable.lineCostCenti }).from(coItemsTable).where(eq(coItemsTable.id, itemId)).limit(1);
  const item = itemRows[0];
  if (!item) return c.json({ error: "item_not_found" }, 404);
  if (item.docNo !== docNo) return c.json({ error: "item_doc_mismatch" }, 400);

  const originalPriceSen = Number(item.unitPriceCenti ?? 0);
  const newLineTotal = Number(item.qty ?? 0) * newPrice - Number(item.discountCenti ?? 0);
  const currentLineCost = Number(item.lineCostCenti ?? 0);
  try {
    await db.update(coItemsTable).set({ unitPriceCenti: newPrice, totalCenti: newLineTotal, totalIncCenti: newLineTotal, balanceCenti: newLineTotal, lineMarginCenti: newLineTotal - currentLineCost }).where(eq(coItemsTable.id, itemId));
    await recomputeTotals(db, docNo);
    await recordCoAudit(db, { docNo, action: "UPDATE_LINE", actorId: user.id, fieldChanges: [{ field: "unitPriceCenti", from: originalPriceSen, to: newPrice }], note: body.reason || undefined });
    return c.json({ ok: true, itemId, newPrice });
  } catch (e) {
    return c.json({ error: "update_failed", reason: errMsg(e) }, 500);
  }
});

// ── PATCH header — edit debtor info, addresses, note, etc. ───────────
app.patch("/:docNo", async (c) => {
  const db = getDb(c.env);
  const docNo = c.req.param("docNo");
  const user = c.get("user");
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: "invalid_json" }, 400); }

  if (body.phone !== undefined) {
    const patchPhone = typeof body.phone === "string" ? body.phone.trim() : "";
    if (!patchPhone) return c.json({ error: "phone_required", reason: "A phone number is required on every consignment order." }, 400);
  }

  // [camel body key, Drizzle property]
  const MAP: Array<[string, string]> = [
    ["debtorCode", "debtorCode"], ["debtorName", "debtorName"], ["agent", "agent"],
    ["salesLocation", "salesLocation"], ["ref", "ref"], ["poDocNo", "poDocNo"],
    ["venue", "venue"], ["venueId", "venueId"], ["branding", "branding"], ["transferTo", "transferTo"],
    ["address1", "address1"], ["address2", "address2"], ["address3", "address3"], ["address4", "address4"],
    ["phone", "phone"], ["note", "note"], ["remark2", "remark2"], ["remark3", "remark3"], ["remark4", "remark4"],
    ["soDate", "soDate"], ["currency", "currency"], ["customerId", "customerId"], ["customerState", "customerState"],
    ["customerPo", "customerPo"], ["customerPoId", "customerPoId"], ["customerPoDate", "customerPoDate"], ["customerPoImageB64", "customerPoImageB64"],
    ["customerSoNo", "customerSoNo"], ["hubId", "hubId"], ["hubName", "hubName"],
    ["customerDeliveryDate", "customerDeliveryDate"], ["internalExpectedDd", "internalExpectedDd"], ["linkedDoDocNo", "linkedDoDocNo"],
    ["shipToAddress", "shipToAddress"], ["billToAddress", "billToAddress"], ["installToAddress", "installToAddress"],
    ["email", "email"], ["customerType", "customerType"], ["salespersonId", "salespersonId"],
    ["city", "city"], ["postcode", "postcode"], ["buildingType", "buildingType"],
    ["emergencyContactName", "emergencyContactName"], ["emergencyContactPhone", "emergencyContactPhone"], ["emergencyContactRelationship", "emergencyContactRelationship"],
    ["targetDate", "targetDate"], ["paymentMethod", "paymentMethod"], ["installmentMonths", "installmentMonths"],
    ["merchantProvider", "merchantProvider"], ["approvalCode", "approvalCode"], ["paymentDate", "paymentDate"],
    ["depositCenti", "depositCenti"], ["paidCenti", "paidCenti"],
  ];
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  for (const [from, to] of MAP) if (body[from] !== undefined) updates[to] = body[from];
  if (Object.keys(updates).length === 1) return c.json({ ok: true, changed: 0 });

  // Snapshot before update for the audit diff + the date/lock guards.
  const beforeRows = await db.select().from(coTable).where(eq(coTable.docNo, docNo)).limit(1);
  const before = beforeRows[0];
  if (!before) return c.json({ error: "not_found" }, 404);

  // Processing & Delivery Date may only be today or future; an unchanged past value is grandfathered.
  {
    const todayMY = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    const proc = body.internalExpectedDd;
    const deliv = body.customerDeliveryDate;
    const origProc = (before.internalExpectedDd as string | null) ?? null;
    const origDeliv = (before.customerDeliveryDate as string | null) ?? null;
    if (typeof proc === "string" && proc && proc < todayMY && proc !== origProc) return c.json({ error: "processing_date_past", reason: "Processing Date cannot be in the past — today or a future date only." }, 400);
    if (typeof deliv === "string" && deliv && deliv < todayMY && deliv !== origDeliv) return c.json({ error: "delivery_date_past", reason: "Delivery Date cannot be in the past — today or a future date only." }, 400);
    const effProc = typeof proc === "string" ? proc || null : origProc;
    const effDeliv = typeof deliv === "string" ? deliv || null : origDeliv;
    if (effProc && effDeliv && effProc > effDeliv) return c.json({ error: "processing_after_delivery", reason: "Processing Date cannot be later than the Delivery Date." }, 400);
  }

  // Partial header lock — IDENTITY/VALUE fields freeze once a non-cancelled Note exists.
  {
    const beforeRow = before as unknown as Record<string, unknown>;
    const changedLocked = [...CO_IDENTITY_LOCK_COLS].filter((col) => col in updates && norm(updates[col]) !== norm(beforeRow[col]));
    if (changedLocked.length > 0) {
      const lock = await coHasDownstream(db, docNo);
      if (lock) return c.json({ error: "co_identity_locked", message: "Consignment Order has a Consignment Note — customer, branding, address, reference and value fields are locked. Payment and remarks can still be edited.", lockedFields: changedLocked }, 409);
    }
  }

  try {
    const updated = await db.update(coTable).set(updates).where(eq(coTable.docNo, docNo)).returning({ docNo: coTable.docNo });
    if (!updated[0]) return c.json({ error: "not_found" }, 404);

    // Master-follower cascade: header delivery date -> non-overridden lines.
    if (body.customerDeliveryDate !== undefined) {
      const newDate = body.customerDeliveryDate as string | null;
      await db.update(coItemsTable).set({ lineDeliveryDate: newDate }).where(and(eq(coItemsTable.docNo, docNo), eq(coItemsTable.lineDeliveryDateOverridden, false)));
    }

    // Audit log row.
    const fieldChanges = diffFields(before as unknown as Record<string, unknown>, body, MAP);
    if (fieldChanges.length > 0) {
      await recordCoAudit(db, { docNo, action: "UPDATE_DETAILS", actorId: user.id, fieldChanges, statusSnapshot: (before.status as string) ?? null });
    }
    return c.json({ ok: true, docNo });
  } catch (e) {
    return c.json({ error: "update_failed", reason: errMsg(e) }, 500);
  }
});

// ── Item CRUD ─────────────────────────────────────────────────────────
app.post("/:docNo/items", async (c) => {
  const db = getDb(c.env);
  const docNo = c.req.param("docNo");
  const user = c.get("user");
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: "invalid_json" }, 400); }
  if (!it.itemCode) return c.json({ error: "item_code_required" }, 400);

  const childLock = await coHasDownstream(db, docNo);
  if (childLock) return c.json(childLock, 409);

  const headerRows = await db.select({ debtorCode: coTable.debtorCode, debtorName: coTable.debtorName, agent: coTable.agent, branding: coTable.branding, venue: coTable.venue, customerDeliveryDate: coTable.customerDeliveryDate }).from(coTable).where(eq(coTable.docNo, docNo)).limit(1);
  const header = headerRows[0];
  if (!header) return c.json({ error: "not_found" }, 404);

  const row = buildItemRow(docNo, header, it);
  try {
    const inserted = await db.insert(coItemsTable).values(row as never).returning();
    await recomputeTotals(db, docNo);
    await recordCoAudit(db, { docNo, action: "ADD_LINE", actorId: user.id, fieldChanges: [{ field: "itemCode", to: row.itemCode }, { field: "qty", to: row.qty }, { field: "unitPriceCenti", to: row.unitPriceCenti }, { field: "totalCenti", to: row.totalCenti }] });
    return c.json({ item: toCoItemResponse(inserted[0]) }, 201);
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
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: "invalid_json" }, 400); }

  const childLock = await coHasDownstream(db, docNo);
  if (childLock) return c.json(childLock, 409);

  const prevRows = await db.select({ qty: coItemsTable.qty, unitPriceCenti: coItemsTable.unitPriceCenti, discountCenti: coItemsTable.discountCenti, unitCostCenti: coItemsTable.unitCostCenti, itemCode: coItemsTable.itemCode, itemGroup: coItemsTable.itemGroup, description: coItemsTable.description, description2: coItemsTable.description2, uom: coItemsTable.uom, remark: coItemsTable.remark, cancelled: coItemsTable.cancelled }).from(coItemsTable).where(eq(coItemsTable.id, itemId)).limit(1);
  const prev = prevRows[0];
  if (!prev) return c.json({ error: "not_found" }, 404);

  const qty = it.qty !== undefined ? Number(it.qty) : Number(prev.qty);
  const unit = it.unitPriceCenti !== undefined ? Number(it.unitPriceCenti) : Number(prev.unitPriceCenti);
  const discount = it.discountCenti !== undefined ? Number(it.discountCenti) : Number(prev.discountCenti);
  const unitCost = it.unitCostCenti !== undefined ? Number(it.unitCostCenti) : Number(prev.unitCostCenti);
  const lineTotal = qty * unit - discount;
  const lineCost = unitCost * qty;

  const updates: Record<string, unknown> = {
    qty, unitPriceCenti: unit, discountCenti: discount, unitCostCenti: unitCost,
    totalCenti: lineTotal, totalIncCenti: lineTotal, balanceCenti: lineTotal, lineCostCenti: lineCost, lineMarginCenti: lineTotal - lineCost,
  };
  for (const [from, to] of [["itemCode", "itemCode"], ["itemGroup", "itemGroup"], ["description", "description"], ["description2", "description2"], ["uom", "uom"], ["variants", "variants"], ["remark", "remark"], ["cancelled", "cancelled"]] as const) {
    if (it[from] !== undefined) updates[to] = it[from];
  }
  if (it.lineDeliveryDate !== undefined) { updates.lineDeliveryDate = it.lineDeliveryDate as string | null; updates.lineDeliveryDateOverridden = true; }
  if (it.lineDeliveryDateOverridden !== undefined) updates.lineDeliveryDateOverridden = Boolean(it.lineDeliveryDateOverridden);

  try {
    await db.update(coItemsTable).set(updates).where(eq(coItemsTable.id, itemId));
    await recomputeTotals(db, docNo);

    const fieldChanges: FieldChange[] = [];
    const cmp = (field: string, fromVal: unknown, toVal: unknown) => { const a = fromVal == null ? "" : String(fromVal); const b = toVal == null ? "" : String(toVal); if (a !== b) fieldChanges.push({ field, from: fromVal ?? null, to: toVal ?? null }); };
    cmp("qty", prev.qty, qty);
    cmp("unitPriceCenti", prev.unitPriceCenti, unit);
    cmp("discountCenti", prev.discountCenti, discount);
    cmp("unitCostCenti", prev.unitCostCenti, unitCost);
    for (const [from, to] of [["itemCode", "itemCode"], ["itemGroup", "itemGroup"], ["description", "description"], ["description2", "description2"], ["uom", "uom"], ["remark", "remark"], ["cancelled", "cancelled"]] as const) {
      if (it[from] !== undefined) cmp(from, (prev as Record<string, unknown>)[to], it[from]);
    }
    if (fieldChanges.length > 0) {
      fieldChanges.unshift({ field: "itemCode", to: prev.itemCode });
      await recordCoAudit(db, { docNo, action: "UPDATE_LINE", actorId: user.id, fieldChanges });
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

  const childLock = await coHasDownstream(db, docNo);
  if (childLock) return c.json(childLock, 409);

  const prevRows = await db.select({ itemCode: coItemsTable.itemCode, qty: coItemsTable.qty, unitPriceCenti: coItemsTable.unitPriceCenti, totalCenti: coItemsTable.totalCenti }).from(coItemsTable).where(eq(coItemsTable.id, itemId)).limit(1);
  const prev = prevRows[0];

  try {
    await db.delete(coItemsTable).where(eq(coItemsTable.id, itemId));
    await recomputeTotals(db, docNo);
    if (prev) {
      await recordCoAudit(db, { docNo, action: "DELETE_LINE", actorId: user.id, fieldChanges: [{ field: "itemCode", from: prev.itemCode }, { field: "qty", from: prev.qty }, { field: "unitPriceCenti", from: prev.unitPriceCenti }, { field: "totalCenti", from: prev.totalCenti }] });
    }
    return c.body(null, 204);
  } catch (e) {
    return c.json({ error: "delete_failed", reason: errMsg(e) }, 500);
  }
});

// ── Payments — transaction ledger per CO ──────────────────────────────
const PAYMENT_SELECT = {
  id: coPaymentsTable.id, so_doc_no: coPaymentsTable.soDocNo, paid_at: coPaymentsTable.paidAt, method: coPaymentsTable.method,
  merchant_provider: coPaymentsTable.merchantProvider, installment_months: coPaymentsTable.installmentMonths, online_type: coPaymentsTable.onlineType,
  approval_code: coPaymentsTable.approvalCode, amount_centi: coPaymentsTable.amountCenti, account_sheet: coPaymentsTable.accountSheet,
  collected_by: coPaymentsTable.collectedBy, note: coPaymentsTable.note, created_at: coPaymentsTable.createdAt, created_by: coPaymentsTable.createdBy,
} as const;

app.get("/:docNo/payments", async (c) => {
  const db = getDb(c.env);
  const docNo = c.req.param("docNo");
  try {
    const rows = await db.select(PAYMENT_SELECT).from(coPaymentsTable).where(eq(coPaymentsTable.soDocNo, docNo)).orderBy(desc(coPaymentsTable.paidAt), desc(coPaymentsTable.createdAt));
    const ids = [...new Set(rows.map((r) => r.collected_by).filter((x): x is number => x != null))];
    const nameById = new Map<number, string | null>();
    if (ids.length > 0) { const us = await db.select({ id: usersTable.id, name: usersTable.name }).from(usersTable).where(inArray(usersTable.id, ids)); for (const u of us) nameById.set(u.id, u.name ?? null); }
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

app.post("/:docNo/payments", async (c) => {
  const db = getDb(c.env);
  const docNo = c.req.param("docNo");
  const user = c.get("user");
  const so = await db.select({ docNo: coTable.docNo }).from(coTable).where(eq(coTable.docNo, docNo)).limit(1);
  if (!so[0]) return c.json({ error: "sales_order_not_found" }, 404);

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }
  const parsed = paymentCreateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
  const p = parsed.data;
  const merchantLike = p.method === "merchant" || p.method === "installment";
  const merchantProvider = merchantLike ? p.merchantProvider ?? null : null;
  const installmentMonths = merchantLike ? (typeof p.installmentMonths === "number" && p.installmentMonths > 0 ? p.installmentMonths : null) : null;
  const onlineType = p.method === "transfer" ? p.onlineType ?? null : null;

  try {
    const inserted = await db.insert(coPaymentsTable).values({ soDocNo: docNo, paidAt: p.paidAt, method: p.method, merchantProvider, installmentMonths, onlineType, approvalCode: p.approvalCode ?? null, amountCenti: p.amountCenti, accountSheet: p.accountSheet ?? null, collectedBy: p.collectedBy ?? null, note: p.note ?? null, createdBy: user.id } as never).returning(PAYMENT_SELECT);
    await recordCoAudit(db, { docNo, action: "ADD_PAYMENT", actorId: user.id, fieldChanges: [{ field: "paidAt", from: null, to: p.paidAt }, { field: "method", from: null, to: p.method }, { field: "amountCenti", from: null, to: p.amountCenti }] });
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
  const rows = await db.select({ soDocNo: coPaymentsTable.soDocNo, paidAt: coPaymentsTable.paidAt, method: coPaymentsTable.method, amountCenti: coPaymentsTable.amountCenti }).from(coPaymentsTable).where(eq(coPaymentsTable.id, id)).limit(1);
  if (!rows[0]) return c.json({ error: "not_found" }, 404);
  if (rows[0].soDocNo !== docNo) return c.json({ error: "payment_doc_mismatch" }, 400);
  try {
    await db.delete(coPaymentsTable).where(eq(coPaymentsTable.id, id));
    await recordCoAudit(db, { docNo, action: "DELETE_PAYMENT", actorId: user.id, fieldChanges: [{ field: "paidAt", from: rows[0].paidAt, to: null }, { field: "method", from: rows[0].method, to: null }, { field: "amountCenti", from: rows[0].amountCenti, to: null }] });
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: "delete_failed", reason: errMsg(e) }, 500);
  }
});

export default app;
