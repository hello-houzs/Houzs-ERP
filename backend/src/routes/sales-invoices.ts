// ----------------------------------------------------------------------------
// /sales-invoices — we bill the customer (B2B sales side).
//
// 1:1 clone of 2990s apps/api/src/routes/sales-invoices.ts (itself a DO clone):
// editable SO/DO-style header, line CRUD, a payments ledger, a recomputeTotals
// rollup, plus a convert-from-DO that copies a Delivery Order's lines into a new
// invoice. Endpoints, request bodies, response JSON shapes, status codes and
// business rules are kept identical. SEAMS only (rule #3 + #4): Supabase
// PostgREST -> Drizzle (getDb), staff.id (uuid) -> users.id (integer),
// requirePermission("*"), mount /api/sales-invoices.
//
// SI = an AR FINANCE record — NO stock impact (inventory landed at DO ship). The
// payment status (SENT -> PARTIALLY_PAID -> PAID) is derived from the ledger.
//
// Strategy-2 + scope:
//   - GL/AR posting is OUT OF SCM-clone scope (Houzs GL differs from 2990s's
//     journal_entries). The 2990s revenue chain (postSiRevenue / reverseSiRevenue
//     / resyncSiRevenue) is DROPPED with a // TODO at each site; the SI doc +
//     payment status stay fully functional, no journal_entries are written.
//   - customer_credits (apply-on-create / cancel-with-payment / overpay
//     reconcile) is DROPPED (not cloned) — // TODO.
//   - DROPPED the catalog itemCode guard (validateItemCodes) +
//     buildVariantSummary (furniture). description2 passes through.
// ----------------------------------------------------------------------------

import { Hono } from "hono";
import { z } from "zod";
import { and, asc, desc, eq, inArray, like, sql } from "drizzle-orm";
import type { Env } from "../types";
import { getDb } from "../db/client";
import {
  salesInvoices as siTable,
  salesInvoiceItems as siItemsTable,
  salesInvoicePayments as siPaymentsTable,
  deliveryOrders as doTable,
  deliveryOrderItems as doItemsTable,
  deliveryReturns as drTable,
  deliveryReturnItems as drItemsTable,
  users as usersTable,
} from "../db/schema";
import { requirePermission } from "../middleware/auth";
import { isServiceLine } from "../lib/service-sku";

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

type SiHeaderDb = typeof siTable.$inferSelect;
type SiItemDb = typeof siItemsTable.$inferSelect;

function toSiHeaderResponse(p: SiHeaderDb): Record<string, unknown> {
  return {
    id: p.id,
    invoice_number: p.invoiceNumber,
    so_doc_no: p.soDocNo,
    delivery_order_id: p.deliveryOrderId,
    debtor_code: p.debtorCode,
    debtor_name: p.debtorName,
    invoice_date: p.invoiceDate,
    due_date: p.dueDate,
    customer_delivery_date: p.customerDeliveryDate,
    currency: p.currency,
    subtotal_centi: p.subtotalCenti,
    discount_centi: p.discountCenti,
    tax_centi: p.taxCenti,
    total_centi: p.totalCenti,
    paid_centi: p.paidCenti,
    salesperson_id: p.salespersonId,
    agent: p.agent,
    email: p.email,
    customer_type: p.customerType,
    building_type: p.buildingType,
    branding: p.branding,
    venue: p.venue,
    venue_id: p.venueId,
    ref: p.ref,
    customer_so_no: p.customerSoNo,
    po_doc_no: p.poDocNo,
    sales_location: p.salesLocation,
    customer_state: p.customerState,
    customer_country: p.customerCountry,
    note: p.note,
    address1: p.address1,
    address2: p.address2,
    city: p.city,
    state: p.state,
    postcode: p.postcode,
    phone: p.phone,
    emergency_contact_name: p.emergencyContactName,
    emergency_contact_phone: p.emergencyContactPhone,
    emergency_contact_relationship: p.emergencyContactRelationship,
    mattress_sofa_centi: p.mattressSofaCenti,
    bedframe_centi: p.bedframeCenti,
    accessories_centi: p.accessoriesCenti,
    others_centi: p.othersCenti,
    service_centi: p.serviceCenti,
    mattress_sofa_cost_centi: p.mattressSofaCostCenti,
    bedframe_cost_centi: p.bedframeCostCenti,
    accessories_cost_centi: p.accessoriesCostCenti,
    others_cost_centi: p.othersCostCenti,
    service_cost_centi: p.serviceCostCenti,
    local_total_centi: p.localTotalCenti,
    total_cost_centi: p.totalCostCenti,
    total_margin_centi: p.totalMarginCenti,
    margin_pct_basis: p.marginPctBasis,
    line_count: p.lineCount,
    status: p.status,
    notes: p.notes,
    sent_at: isoOrNull(p.sentAt),
    paid_at: isoOrNull(p.paidAt),
    confirmed_at: isoOrNull(p.confirmedAt),
    created_at: isoOrNull(p.createdAt),
    created_by: p.createdBy,
    updated_at: isoOrNull(p.updatedAt),
  };
}
function toSiItemResponse(it: SiItemDb): Record<string, unknown> {
  return {
    id: it.id,
    sales_invoice_id: it.salesInvoiceId,
    so_item_id: it.soItemId,
    do_item_id: it.doItemId,
    item_code: it.itemCode,
    item_group: it.itemGroup,
    description: it.description,
    description2: it.description2,
    uom: it.uom,
    qty: it.qty,
    unit_price_centi: it.unitPriceCenti,
    discount_centi: it.discountCenti,
    tax_centi: it.taxCenti,
    line_total_centi: it.lineTotalCenti,
    unit_cost_centi: it.unitCostCenti,
    line_cost_centi: it.lineCostCenti,
    line_margin_centi: it.lineMarginCenti,
    variants: it.variants ?? null,
    notes: it.notes,
    line_no: it.lineNo,
    created_at: isoOrNull(it.createdAt),
  };
}

const nextNum = async (db: Db): Promise<string> => {
  const d = new Date();
  const yymm = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, "0")}`;
  const rows = await db.select({ invoiceNumber: siTable.invoiceNumber }).from(siTable).where(like(siTable.invoiceNumber, `SI-${yymm}-%`));
  let maxN = 0;
  for (const r of rows) { const m = /-(\d+)$/.exec(r.invoiceNumber); if (m) maxN = Math.max(maxN, parseInt(m[1], 10)); }
  return `SI-${yymm}-${String(maxN + 1).padStart(3, "0")}`;
};

/* Re-derive the SI header's per-category revenue/cost totals + grand total +
   subtotal/total from its line items. Mirrors the DO recomputeTotals rollup. */
async function recomputeTotals(db: Db, salesInvoiceId: string): Promise<void> {
  const items = await db
    .select({ itemCode: siItemsTable.itemCode, itemGroup: siItemsTable.itemGroup, lineTotalCenti: siItemsTable.lineTotalCenti, lineCostCenti: siItemsTable.lineCostCenti })
    .from(siItemsTable)
    .where(eq(siItemsTable.salesInvoiceId, salesInvoiceId));
  let mattressSofa = 0, bedframe = 0, accessories = 0, others = 0, service = 0, total = 0, totalCost = 0;
  let mattressSofaCost = 0, bedframeCost = 0, accessoriesCost = 0, othersCost = 0, serviceCost = 0;
  for (const it of items) {
    const lineTotal = Number(it.lineTotalCenti ?? 0);
    const lineCost = Number(it.lineCostCenti ?? 0);
    total += lineTotal;
    totalCost += lineCost;
    const g = (it.itemGroup ?? "").toLowerCase();
    if (isServiceLine({ itemGroup: g, itemCode: it.itemCode })) { service += lineTotal; serviceCost += lineCost; }
    else if (g.includes("mattress") || g.includes("sofa")) { mattressSofa += lineTotal; mattressSofaCost += lineCost; }
    else if (g.includes("bedframe")) { bedframe += lineTotal; bedframeCost += lineCost; }
    else if (g.includes("accessor")) { accessories += lineTotal; accessoriesCost += lineCost; }
    else { others += lineTotal; othersCost += lineCost; }
  }
  const margin = total - totalCost;
  await db.update(siTable).set({
    mattressSofaCenti: mattressSofa, bedframeCenti: bedframe, accessoriesCenti: accessories, othersCenti: others, serviceCenti: service,
    mattressSofaCostCenti: mattressSofaCost, bedframeCostCenti: bedframeCost, accessoriesCostCenti: accessoriesCost, othersCostCenti: othersCost, serviceCostCenti: serviceCost,
    localTotalCenti: total, totalCostCenti: totalCost, totalMarginCenti: margin, marginPctBasis: total > 0 ? Math.round((margin / total) * 10000) : 0, lineCount: items.length,
    subtotalCenti: total, totalCenti: total, updatedAt: new Date(),
  }).where(eq(siTable.id, salesInvoiceId));
}

/* Build one sales_invoice_items insert row from a client line payload. */
function buildItemRow(salesInvoiceId: string, it: Record<string, unknown>, lineNo?: number | null): Record<string, unknown> {
  const qty = Number(it.qty ?? 1);
  const unitPrice = Number(it.unitPriceCenti ?? 0);
  const discount = Number(it.discountCenti ?? 0);
  const tax = Number(it.taxCenti ?? 0);
  const unitCost = Number(it.unitCostCenti ?? 0);
  const lineTotal = qty * unitPrice - discount + tax;
  const lineCost = qty * unitCost;
  return {
    salesInvoiceId,
    soItemId: (it.soItemId as string | undefined) ?? null,
    doItemId: (it.doItemId as string | undefined) ?? null,
    itemCode: it.itemCode,
    itemGroup: (it.itemGroup as string) ?? null,
    description: (it.description as string) ?? null,
    description2: (it.description2 as string) ?? null,
    uom: (it.uom as string) ?? "UNIT",
    qty,
    unitPriceCenti: unitPrice,
    discountCenti: discount,
    taxCenti: tax,
    lineTotalCenti: lineTotal,
    unitCostCenti: unitCost,
    lineCostCenti: lineCost,
    lineMarginCenti: lineTotal - lineCost,
    variants: (it.variants as unknown) ?? null,
    notes: (it.notes as string) ?? null,
    ...(typeof lineNo === "number" ? { lineNo } : {}),
  };
}

/* DO → SI line-level remaining: remaining_to_invoice = delivered − invoiced −
   returned, per DO line, derived live (non-cancelled SI/DR excluded). */
type DoRemainingLine = {
  doItemId: string; deliveryOrderId: string; doNumber: string; debtorCode: string | null; debtorName: string | null;
  itemCode: string; itemGroup: string | null; description: string | null; description2: string | null; uom: string | null;
  unitPriceCenti: number; discountCenti: number; unitCostCenti: number; variants: unknown; delivered: number; invoiced: number; returned: number; remaining: number; lineSeq: number;
};

async function doLineRemaining(db: Db, doIds: string[]): Promise<Map<string, DoRemainingLine>> {
  const out = new Map<string, DoRemainingLine>();
  if (doIds.length === 0) return out;
  // Only NON-cancelled DOs contribute deliverable lines.
  const dos = await db.select({ id: doTable.id, doNumber: doTable.doNumber, debtorCode: doTable.debtorCode, debtorName: doTable.debtorName, status: doTable.status }).from(doTable).where(inArray(doTable.id, doIds));
  const activeDo = new Map<string, { doNumber: string; debtorCode: string | null; debtorName: string | null }>();
  for (const d of dos) if ((d.status ?? "").toUpperCase() !== "CANCELLED") activeDo.set(d.id, { doNumber: d.doNumber, debtorCode: d.debtorCode, debtorName: d.debtorName });
  const activeDoIds = [...activeDo.keys()];
  if (activeDoIds.length === 0) return out;

  const doLines = await db
    .select({ id: doItemsTable.id, deliveryOrderId: doItemsTable.deliveryOrderId, itemCode: doItemsTable.itemCode, itemGroup: doItemsTable.itemGroup, description: doItemsTable.description, description2: doItemsTable.description2, uom: doItemsTable.uom, qty: doItemsTable.qty, unitPriceCenti: doItemsTable.unitPriceCenti, discountCenti: doItemsTable.discountCenti, unitCostCenti: doItemsTable.unitCostCenti, variants: doItemsTable.variants, lineNo: doItemsTable.lineNo, createdAt: doItemsTable.createdAt })
    .from(doItemsTable)
    .where(inArray(doItemsTable.deliveryOrderId, activeDoIds))
    .orderBy(asc(doItemsTable.deliveryOrderId), sql`${doItemsTable.lineNo} ASC NULLS LAST`, asc(doItemsTable.createdAt));
  const doLineIds = doLines.map((l) => l.id);
  if (doLineIds.length === 0) return out;

  // Σ invoiced via non-cancelled SI.
  const invoicedByDoLine = new Map<string, number>();
  const siLines = await db.select({ doItemId: siItemsTable.doItemId, qty: siItemsTable.qty, salesInvoiceId: siItemsTable.salesInvoiceId }).from(siItemsTable).where(inArray(siItemsTable.doItemId, doLineIds));
  const siIds = [...new Set(siLines.map((l) => l.salesInvoiceId).filter(Boolean))];
  const activeSi = new Set<string>();
  if (siIds.length > 0) { const sis = await db.select({ id: siTable.id, status: siTable.status }).from(siTable).where(inArray(siTable.id, siIds)); for (const s of sis) if ((s.status ?? "").toUpperCase() !== "CANCELLED") activeSi.add(s.id); }
  for (const l of siLines) { if (!l.doItemId || !activeSi.has(l.salesInvoiceId)) continue; invoicedByDoLine.set(l.doItemId, (invoicedByDoLine.get(l.doItemId) ?? 0) + Number(l.qty ?? 0)); }

  // Σ returned via non-cancelled DR.
  const returnedByDoLine = new Map<string, number>();
  const drLines = await db.select({ doItemId: drItemsTable.doItemId, qtyReturned: drItemsTable.qtyReturned, deliveryReturnId: drItemsTable.deliveryReturnId }).from(drItemsTable).where(inArray(drItemsTable.doItemId, doLineIds));
  const drIds = [...new Set(drLines.map((l) => l.deliveryReturnId).filter(Boolean))];
  const activeDr = new Set<string>();
  if (drIds.length > 0) { const drs = await db.select({ id: drTable.id, status: drTable.status }).from(drTable).where(inArray(drTable.id, drIds)); for (const d of drs) if ((d.status ?? "").toUpperCase() !== "CANCELLED") activeDr.add(d.id); }
  for (const l of drLines) { if (!l.doItemId || !activeDr.has(l.deliveryReturnId)) continue; returnedByDoLine.set(l.doItemId, (returnedByDoLine.get(l.doItemId) ?? 0) + Number(l.qtyReturned ?? 0)); }

  const seqByDo = new Map<string, number>();
  for (const l of doLines) {
    const meta = activeDo.get(l.deliveryOrderId)!;
    const delivered = Number(l.qty ?? 0);
    const invoiced = invoicedByDoLine.get(l.id) ?? 0;
    const returned = returnedByDoLine.get(l.id) ?? 0;
    const lineSeq = seqByDo.get(l.deliveryOrderId) ?? 0;
    seqByDo.set(l.deliveryOrderId, lineSeq + 1);
    out.set(l.id, {
      doItemId: l.id, deliveryOrderId: l.deliveryOrderId, doNumber: meta.doNumber, debtorCode: meta.debtorCode, debtorName: meta.debtorName,
      itemCode: l.itemCode, itemGroup: l.itemGroup ?? null, description: l.description ?? null, description2: l.description2 ?? null, uom: l.uom ?? null,
      unitPriceCenti: Number(l.unitPriceCenti ?? 0), discountCenti: Number(l.discountCenti ?? 0), unitCostCenti: Number(l.unitCostCenti ?? 0), variants: l.variants ?? null,
      delivered, invoiced, returned, remaining: delivered - invoiced - returned, lineSeq,
    });
  }
  return out;
}

const custKeyOf = (l: DoRemainingLine): string => (l.debtorCode && l.debtorCode.trim() ? `code:${l.debtorCode.trim().toUpperCase()}` : `name:${(l.debtorName ?? "").trim().toUpperCase()}`);

/* Resolve candidate DO ids: explicit ?doIds=A,B wins; else every non-cancelled DO. */
async function resolveCandidateDoIds(db: Db, doIdsParam: string | undefined): Promise<string[]> {
  if (doIdsParam && doIdsParam.trim()) return [...new Set(doIdsParam.split(",").map((d) => d.trim()).filter(Boolean))];
  const dos = await db.select({ id: doTable.id }).from(doTable).where(sql`${doTable.status} <> 'CANCELLED'`).orderBy(desc(doTable.doDate)).limit(1000);
  return dos.map((d) => d.id);
}

async function doRemainingByItemId(db: Db, doItemIds: string[]): Promise<Map<string, number>> {
  const ids = [...new Set(doItemIds.filter(Boolean))];
  const out = new Map<string, number>();
  if (ids.length === 0) return out;
  const rows = await db.select({ deliveryOrderId: doItemsTable.deliveryOrderId }).from(doItemsTable).where(inArray(doItemsTable.id, ids));
  const doIds = [...new Set(rows.map((r) => r.deliveryOrderId).filter(Boolean))];
  const remainingMap = await doLineRemaining(db, doIds);
  for (const id of ids) out.set(id, remainingMap.get(id)?.remaining ?? 0);
  return out;
}

/* Over-invoice write guard. excludeByDoItem adds back the qty the line being
   edited already contributes (so a no-op/decrease never trips). */
async function checkSiOverRemaining(db: Db, lines: Array<Record<string, unknown>>, excludeByDoItem?: Map<string, number>): Promise<{ error: string; lines: Array<{ doItemId: string; requested: number; remaining: number }> } | null> {
  const wanted = new Map<string, number>();
  for (const it of lines) { const doItemId = (it.doItemId as string | undefined) ?? null; if (!doItemId) continue; wanted.set(doItemId, (wanted.get(doItemId) ?? 0) + Number(it.qty ?? 0)); }
  if (wanted.size === 0) return null;
  const remainingMap = await doRemainingByItemId(db, [...wanted.keys()]);
  const offenders: Array<{ doItemId: string; requested: number; remaining: number }> = [];
  for (const [doItemId, requested] of wanted) { const cap = (remainingMap.get(doItemId) ?? 0) + (excludeByDoItem?.get(doItemId) ?? 0); if (requested > cap) offenders.push({ doItemId, requested, remaining: cap }); }
  return offenders.length > 0 ? { error: "over_remaining", lines: offenders } : null;
}

// ── List ────────────────────────────────────────────────────────────────
app.get("/", async (c) => {
  const db = getDb(c.env);
  try {
    const conds = [];
    const status = c.req.query("status");
    if (status) conds.push(eq(siTable.status, status as SiHeaderDb["status"]));
    const rows = await db.select().from(siTable).where(conds.length ? and(...conds) : undefined).orderBy(desc(siTable.invoiceDate)).limit(500);
    return c.json({ salesInvoices: rows.map((r) => toSiHeaderResponse(r)) });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

// ── Invoiceable DO lines (line-level partial-invoice picker) — STATIC, before /:id ──
app.get("/invoiceable-do-lines", async (c) => {
  const db = getDb(c.env);
  try {
    const doIds = await resolveCandidateDoIds(db, c.req.query("doIds"));
    if (doIds.length === 0) return c.json({ lines: [] });
    const remainingMap = await doLineRemaining(db, doIds);
    const lines = [...remainingMap.values()].filter((l) => l.remaining > 0);
    return c.json({ lines });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

// ── Detail ──────────────────────────────────────────────────────────────
app.get("/:id", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  try {
    const [headerRows, itemRows] = await Promise.all([
      db.select().from(siTable).where(eq(siTable.id, id)).limit(1),
      db.select().from(siItemsTable).where(eq(siItemsTable.salesInvoiceId, id)).orderBy(sql`${siItemsTable.lineNo} ASC NULLS LAST`, asc(siItemsTable.createdAt)),
    ]);
    if (!headerRows[0]) return c.json({ error: "not_found" }, 404);
    return c.json({ salesInvoice: toSiHeaderResponse(headerRows[0]), items: itemRows.map((it) => toSiItemResponse(it)) });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

// ── Create ──────────────────────────────────────────────────────────────
app.post("/", async (c) => {
  const db = getDb(c.env);
  const user = c.get("user");
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: "invalid_json" }, 400); }
  const debtorName = (body.debtorName ?? body.customerName) as string | undefined;
  if (!debtorName) return c.json({ error: "debtor_name_required" }, 400);
  const items = (body.items as Array<Record<string, unknown>> | undefined) ?? [];

  // Remaining-to-invoice guard — DO-linked lines respect the live Pending pool.
  {
    const over = await checkSiOverRemaining(db, items);
    if (over) return c.json(over, 409);
  }

  const invoiceNumber = await nextNum(db);
  const now = new Date();
  let header: SiHeaderDb;
  try {
    const inserted = await db.insert(siTable).values({
      invoiceNumber,
      soDocNo: (body.soDocNo as string) ?? null,
      deliveryOrderId: (body.deliveryOrderId as string) ?? null,
      debtorCode: (body.debtorCode as string) ?? null,
      debtorName,
      invoiceDate: (body.invoiceDate as string) ?? new Date().toISOString().slice(0, 10),
      dueDate: (body.dueDate as string) ?? null,
      customerDeliveryDate: (body.customerDeliveryDate as string) ?? null,
      address1: (body.address1 as string) ?? null,
      address2: (body.address2 as string) ?? null,
      city: (body.city as string) ?? null,
      state: (body.state as string) ?? (body.customerState as string) ?? null,
      customerState: (body.customerState as string) ?? (body.state as string) ?? null,
      customerCountry: (body.customerCountry as string) ?? null,
      postcode: (body.postcode as string) ?? null,
      phone: (body.phone as string) ?? null,
      salespersonId: typeof body.salespersonId === "number" ? (body.salespersonId as number) : null,
      agent: (body.agent as string) ?? null,
      email: (body.email as string) ?? null,
      customerType: (body.customerType as string) ?? null,
      buildingType: (body.buildingType as string) ?? null,
      branding: (body.branding as string) ?? null,
      venue: (body.venue as string) ?? null,
      venueId: (body.venueId as string) ?? null,
      ref: (body.ref as string) ?? null,
      customerSoNo: (body.customerSoNo as string) ?? null,
      poDocNo: (body.poDocNo as string) ?? null,
      salesLocation: (body.salesLocation as string) ?? null,
      note: (body.note as string) ?? null,
      emergencyContactName: (body.emergencyContactName as string) ?? null,
      emergencyContactPhone: (body.emergencyContactPhone as string) ?? null,
      emergencyContactRelationship: (body.emergencyContactRelationship as string) ?? null,
      currency: (((body.currency as string) ?? "MYR").toUpperCase()) as never,
      // An issued invoice is SENT; payment status is derived from the ledger.
      status: "SENT",
      sentAt: now,
      confirmedAt: now,
      notes: (body.notes as string) ?? null,
      createdBy: user.id,
    } as never).returning();
    header = inserted[0];
  } catch (e) {
    return c.json({ error: "insert_failed", reason: errMsg(e) }, 500);
  }

  if (items.length > 0) {
    try {
      const rows = items.map((it, lineNo) => buildItemRow(header.id, it, lineNo));
      await db.insert(siItemsTable).values(rows as never);
      await recomputeTotals(db, header.id);
    } catch (e) {
      await db.delete(siTable).where(eq(siTable.id, header.id));
      return c.json({ error: "items_insert_failed", reason: errMsg(e) }, 500);
    }
  }

  // TODO: AR->GL revenue posting is out of SCM-clone scope (postSiRevenue).
  // TODO: customer-credit auto-apply on create is out of SCM-clone scope.
  return c.json({ id: header.id, invoiceNumber: header.invoiceNumber, revenue: { posted: false, status: "out_of_scope" }, creditApplied: 0 }, 201);
});

// ── Convert picked DO LINES (partial qty) → ONE Sales Invoice ─────────────
app.post("/from-dos", async (c) => {
  const db = getDb(c.env);
  const user = c.get("user");
  let body: { picks?: Array<{ doItemId?: string; qty?: number }> };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: "invalid_json" }, 400); }

  const pickQtyById = new Map<string, number>();
  for (const p of body.picks ?? []) { if (!p || !p.doItemId) continue; const q = Number(p.qty ?? 0); if (!(q > 0)) continue; pickQtyById.set(p.doItemId, (pickQtyById.get(p.doItemId) ?? 0) + q); }
  if (pickQtyById.size === 0) return c.json({ error: "picks_required" }, 400);

  const pickedIds = [...pickQtyById.keys()];
  const pickedItemRows = await db.select({ id: doItemsTable.id, deliveryOrderId: doItemsTable.deliveryOrderId }).from(doItemsTable).where(inArray(doItemsTable.id, pickedIds));
  const idToDo = new Map<string, string>();
  for (const r of pickedItemRows) idToDo.set(r.id, r.deliveryOrderId);
  const missing = pickedIds.filter((id) => !idToDo.has(id));
  if (missing.length > 0) return c.json({ error: "do_item_not_found", missing }, 404);

  const doIds = [...new Set([...idToDo.values()])];
  const remainingMap = await doLineRemaining(db, doIds);

  const customers = new Set<string>();
  const customerNames = new Set<string>();
  for (const id of pickedIds) {
    const line = remainingMap.get(id);
    if (!line) return c.json({ error: "do_item_not_found", missing: [id] }, 404);
    customers.add(custKeyOf(line));
    customerNames.add(line.debtorName ?? line.debtorCode ?? "(none)");
  }
  if (customers.size > 1) return c.json({ error: "mixed_customers", message: "All picked Delivery Order lines must belong to the same customer to combine into one Sales Invoice.", customers: [...customerNames] }, 400);

  for (const id of pickedIds) {
    const line = remainingMap.get(id)!;
    const qty = pickQtyById.get(id)!;
    if (qty < 1 || qty > line.remaining) return c.json({ error: "over_remaining", message: `${line.itemCode} on ${line.doNumber}: pick qty ${qty} exceeds remaining ${line.remaining}.`, doItemId: id, doNumber: line.doNumber, itemCode: line.itemCode, remaining: line.remaining, requested: qty }, 409);
  }

  const sortedPicks = pickedIds.map((id) => remainingMap.get(id)!).sort((a, b) => a.doNumber.localeCompare(b.doNumber) || a.lineSeq - b.lineSeq || a.doItemId.localeCompare(b.doItemId));
  const firstDoId = sortedPicks[0]!.deliveryOrderId;
  const distinctDoNumbers = [...new Set(sortedPicks.map((l) => l.doNumber))].sort();

  const doHeaderRows = await db
    .select({ id: doTable.id, doNumber: doTable.doNumber, soDocNo: doTable.soDocNo, debtorCode: doTable.debtorCode, debtorName: doTable.debtorName, customerDeliveryDate: doTable.customerDeliveryDate, salespersonId: doTable.salespersonId, agent: doTable.agent, email: doTable.email, customerType: doTable.customerType, buildingType: doTable.buildingType, branding: doTable.branding, venue: doTable.venue, venueId: doTable.venueId, ref: doTable.ref, customerSoNo: doTable.customerSoNo, poDocNo: doTable.poDocNo, salesLocation: doTable.salesLocation, customerState: doTable.customerState, customerCountry: doTable.customerCountry, note: doTable.note, address1: doTable.address1, address2: doTable.address2, city: doTable.city, state: doTable.state, postcode: doTable.postcode, phone: doTable.phone, currency: doTable.currency, emergencyContactName: doTable.emergencyContactName, emergencyContactPhone: doTable.emergencyContactPhone, emergencyContactRelationship: doTable.emergencyContactRelationship })
    .from(doTable)
    .where(eq(doTable.id, firstDoId))
    .limit(1);
  const head = doHeaderRows[0];
  if (!head) return c.json({ error: "delivery_order_not_found" }, 404);

  const invoiceNumber = await nextNum(db);
  const now = new Date();
  let header: SiHeaderDb;
  try {
    const inserted = await db.insert(siTable).values({
      invoiceNumber,
      soDocNo: head.soDocNo ?? null,
      deliveryOrderId: firstDoId,
      debtorCode: head.debtorCode ?? null,
      debtorName: head.debtorName ?? "Customer",
      invoiceDate: new Date().toISOString().slice(0, 10),
      customerDeliveryDate: (head.customerDeliveryDate as string | null) ?? null,
      address1: head.address1 ?? null,
      address2: head.address2 ?? null,
      city: head.city ?? null,
      state: head.state ?? head.customerState ?? null,
      customerState: head.customerState ?? head.state ?? null,
      customerCountry: head.customerCountry ?? null,
      postcode: head.postcode ?? null,
      phone: head.phone ?? null,
      salespersonId: head.salespersonId ?? null,
      agent: head.agent ?? null,
      email: head.email ?? null,
      customerType: head.customerType ?? null,
      buildingType: head.buildingType ?? null,
      branding: head.branding ?? null,
      venue: head.venue ?? null,
      venueId: head.venueId ?? null,
      ref: distinctDoNumbers.length > 1 ? `Merged from ${distinctDoNumbers.join(", ")}` : head.ref ?? null,
      customerSoNo: head.customerSoNo ?? null,
      poDocNo: head.poDocNo ?? null,
      salesLocation: head.salesLocation ?? null,
      note: head.note ?? null,
      emergencyContactName: head.emergencyContactName ?? null,
      emergencyContactPhone: head.emergencyContactPhone ?? null,
      emergencyContactRelationship: head.emergencyContactRelationship ?? null,
      currency: ((head.currency ?? "MYR") as string).toUpperCase() as never,
      status: "SENT",
      sentAt: now,
      confirmedAt: now,
      createdBy: user.id,
    } as never).returning();
    header = inserted[0];
  } catch (e) {
    return c.json({ error: "insert_failed", reason: errMsg(e) }, 500);
  }

  const rows = sortedPicks.map((line, lineNo) => buildItemRow(header.id, { doItemId: line.doItemId, itemCode: line.itemCode, itemGroup: line.itemGroup, description: line.description, description2: line.description2, uom: line.uom, qty: pickQtyById.get(line.doItemId)!, unitPriceCenti: line.unitPriceCenti, discountCenti: line.discountCenti, unitCostCenti: line.unitCostCenti, variants: line.variants }, lineNo));
  try {
    await db.insert(siItemsTable).values(rows as never);
  } catch (e) {
    await db.delete(siTable).where(eq(siTable.id, header.id));
    return c.json({ error: "items_insert_failed", reason: errMsg(e) }, 500);
  }

  await recomputeTotals(db, header.id);
  // TODO: AR->GL revenue posting is out of SCM-clone scope.
  // TODO: customer-credit auto-apply is out of SCM-clone scope.
  return c.json({ id: header.id, invoiceNumber: header.invoiceNumber, revenue: { posted: false, status: "out_of_scope" }, creditApplied: 0 }, 201);
});

/* Append a Delivery Order's lines into an EXISTING invoice. */
app.post("/:id/items/from-do/:doId", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const doId = c.req.param("doId");

  const si = await db.select({ id: siTable.id, status: siTable.status }).from(siTable).where(eq(siTable.id, id)).limit(1);
  if (!si[0]) return c.json({ error: "not_found" }, 404);
  if ((si[0].status ?? "").toUpperCase() === "CANCELLED") return c.json({ error: "invoice_cancelled" }, 409);

  const doHeader = await db.select({ id: doTable.id, status: doTable.status }).from(doTable).where(eq(doTable.id, doId)).limit(1);
  if (!doHeader[0]) return c.json({ error: "delivery_order_not_found" }, 404);
  if ((doHeader[0].status ?? "").toUpperCase() === "CANCELLED") return c.json({ error: "do_cancelled" }, 409);

  const doLines = await db.select({ id: doItemsTable.id, itemCode: doItemsTable.itemCode, itemGroup: doItemsTable.itemGroup, description: doItemsTable.description, description2: doItemsTable.description2, uom: doItemsTable.uom, qty: doItemsTable.qty, unitPriceCenti: doItemsTable.unitPriceCenti, discountCenti: doItemsTable.discountCenti, unitCostCenti: doItemsTable.unitCostCenti, variants: doItemsTable.variants, notes: doItemsTable.notes }).from(doItemsTable).where(eq(doItemsTable.deliveryOrderId, doId)).orderBy(sql`${doItemsTable.lineNo} ASC NULLS LAST`, asc(doItemsTable.createdAt));
  const remainingMap = await doRemainingByItemId(db, doLines.map((it) => it.id));
  const maxNoRow = await db.select({ lineNo: siItemsTable.lineNo }).from(siItemsTable).where(eq(siItemsTable.salesInvoiceId, id)).orderBy(sql`${siItemsTable.lineNo} DESC NULLS LAST`).limit(1);
  const baseLineNo = typeof maxNoRow[0]?.lineNo === "number" ? (maxNoRow[0].lineNo as number) + 1 : null;
  const rows = doLines
    .map((it) => ({ it, remaining: remainingMap.get(it.id) ?? 0 }))
    .filter(({ remaining }) => remaining > 0)
    .map(({ it, remaining }, idx) => buildItemRow(id, { doItemId: it.id, itemCode: it.itemCode, itemGroup: it.itemGroup, description: it.description, description2: it.description2, uom: it.uom, qty: Math.min(Number(it.qty ?? 0), remaining), unitPriceCenti: it.unitPriceCenti, discountCenti: it.discountCenti, unitCostCenti: it.unitCostCenti, variants: it.variants, notes: it.notes }, baseLineNo === null ? null : baseLineNo + idx));
  if (rows.length === 0) return c.json({ error: "do_fully_invoiced" }, 409);

  try {
    await db.insert(siItemsTable).values(rows as never);
    await recomputeTotals(db, id);
    // TODO: AR->GL revenue re-post is out of SCM-clone scope.
    return c.json({ ok: true, added: rows.length }, 201);
  } catch (e) {
    return c.json({ error: "items_insert_failed", reason: errMsg(e) }, 500);
  }
});

// ── Header PATCH ───────────────────────────────────────────────────────────
app.patch("/:id", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: "invalid_json" }, 400); }
  const MAP: Array<[string, string]> = [
    ["debtorCode", "debtorCode"], ["debtorName", "debtorName"], ["agent", "agent"], ["salesLocation", "salesLocation"], ["ref", "ref"], ["poDocNo", "poDocNo"],
    ["venue", "venue"], ["venueId", "venueId"], ["branding", "branding"], ["address1", "address1"], ["address2", "address2"],
    ["city", "city"], ["state", "state"], ["postcode", "postcode"], ["phone", "phone"], ["note", "note"], ["notes", "notes"],
    ["invoiceDate", "invoiceDate"], ["dueDate", "dueDate"], ["currency", "currency"], ["customerState", "customerState"], ["customerCountry", "customerCountry"], ["customerSoNo", "customerSoNo"],
    ["customerDeliveryDate", "customerDeliveryDate"], ["email", "email"], ["customerType", "customerType"], ["salespersonId", "salespersonId"], ["buildingType", "buildingType"],
    ["emergencyContactName", "emergencyContactName"], ["emergencyContactPhone", "emergencyContactPhone"], ["emergencyContactRelationship", "emergencyContactRelationship"],
  ];
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  for (const [from, to] of MAP) if (body[from] !== undefined) updates[to] = body[from];
  if (Object.keys(updates).length === 1) return c.json({ ok: true, changed: 0 });
  try {
    const updated = await db.update(siTable).set(updates).where(eq(siTable.id, id)).returning({ id: siTable.id });
    if (!updated[0]) return c.json({ error: "not_found" }, 404);
    return c.json({ ok: true, id });
  } catch (e) {
    return c.json({ error: "update_failed", reason: errMsg(e) }, 500);
  }
});

// ── Item CRUD ─────────────────────────────────────────────────────────────
app.post("/:id/items", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: "invalid_json" }, 400); }
  if (!it.itemCode) return c.json({ error: "item_code_required" }, 400);

  const header = await db.select({ id: siTable.id, status: siTable.status }).from(siTable).where(eq(siTable.id, id)).limit(1);
  if (!header[0]) return c.json({ error: "not_found" }, 404);
  if ((header[0].status ?? "").toUpperCase() === "CANCELLED") return c.json({ error: "invoice_cancelled", message: "This invoice is cancelled — reopen it before adding lines." }, 409);

  {
    const over = await checkSiOverRemaining(db, [it]);
    if (over) return c.json(over, 409);
  }

  const maxNoRow = await db.select({ lineNo: siItemsTable.lineNo }).from(siItemsTable).where(eq(siItemsTable.salesInvoiceId, id)).orderBy(sql`${siItemsTable.lineNo} DESC NULLS LAST`).limit(1);
  const nextLineNo = typeof maxNoRow[0]?.lineNo === "number" ? (maxNoRow[0].lineNo as number) + 1 : null;
  try {
    const inserted = await db.insert(siItemsTable).values(buildItemRow(id, it, nextLineNo) as never).returning();
    await recomputeTotals(db, id);
    // TODO: AR->GL revenue resync is out of SCM-clone scope.
    return c.json({ item: toSiItemResponse(inserted[0]) }, 201);
  } catch (e) {
    return c.json({ error: "insert_failed", reason: errMsg(e) }, 500);
  }
});

app.patch("/:id/items/:itemId", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const itemId = c.req.param("itemId");
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: "invalid_json" }, 400); }

  const hd = await db.select({ status: siTable.status }).from(siTable).where(eq(siTable.id, id)).limit(1);
  if (hd[0] && (hd[0].status ?? "").toUpperCase() === "CANCELLED") return c.json({ error: "invoice_cancelled", message: "This invoice is cancelled — reopen it before editing lines." }, 409);

  const prevRows = await db.select({ qty: siItemsTable.qty, unitPriceCenti: siItemsTable.unitPriceCenti, discountCenti: siItemsTable.discountCenti, taxCenti: siItemsTable.taxCenti, unitCostCenti: siItemsTable.unitCostCenti, doItemId: siItemsTable.doItemId }).from(siItemsTable).where(and(eq(siItemsTable.id, itemId), eq(siItemsTable.salesInvoiceId, id))).limit(1);
  const prev = prevRows[0];
  if (!prev) return c.json({ error: "not_found" }, 404);

  const qty = it.qty !== undefined ? Number(it.qty) : Number(prev.qty);
  if (it.qty !== undefined && prev.doItemId && qty > Number(prev.qty)) {
    const exclude = new Map<string, number>([[prev.doItemId, Number(prev.qty)]]);
    const over = await checkSiOverRemaining(db, [{ doItemId: prev.doItemId, qty }], exclude);
    if (over) return c.json(over, 409);
  }
  const unitPrice = it.unitPriceCenti !== undefined ? Number(it.unitPriceCenti) : Number(prev.unitPriceCenti);
  const discount = it.discountCenti !== undefined ? Number(it.discountCenti) : Number(prev.discountCenti);
  const tax = it.taxCenti !== undefined ? Number(it.taxCenti) : Number(prev.taxCenti ?? 0);
  const unitCost = it.unitCostCenti !== undefined ? Number(it.unitCostCenti) : Number(prev.unitCostCenti);
  const lineTotal = qty * unitPrice - discount + tax;
  const lineCost = qty * unitCost;

  const updates: Record<string, unknown> = { qty, unitPriceCenti: unitPrice, discountCenti: discount, taxCenti: tax, unitCostCenti: unitCost, lineTotalCenti: lineTotal, lineCostCenti: lineCost, lineMarginCenti: lineTotal - lineCost };
  for (const [from, to] of [["itemCode", "itemCode"], ["itemGroup", "itemGroup"], ["description", "description"], ["description2", "description2"], ["uom", "uom"], ["variants", "variants"], ["notes", "notes"]] as const) {
    if (it[from] !== undefined) updates[to] = it[from];
  }
  try {
    await db.update(siItemsTable).set(updates).where(eq(siItemsTable.id, itemId));
    await recomputeTotals(db, id);
    // TODO: AR->GL revenue resync is out of SCM-clone scope.
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: "update_failed", reason: errMsg(e) }, 500);
  }
});

app.delete("/:id/items/:itemId", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const itemId = c.req.param("itemId");
  const hd = await db.select({ status: siTable.status }).from(siTable).where(eq(siTable.id, id)).limit(1);
  if (hd[0] && (hd[0].status ?? "").toUpperCase() === "CANCELLED") return c.json({ error: "invoice_cancelled", message: "This invoice is cancelled — reopen it before deleting lines." }, 409);
  const line = await db.select({ id: siItemsTable.id }).from(siItemsTable).where(and(eq(siItemsTable.id, itemId), eq(siItemsTable.salesInvoiceId, id))).limit(1);
  if (!line[0]) return c.json({ error: "not_found" }, 404);
  try {
    await db.delete(siItemsTable).where(eq(siItemsTable.id, itemId));
    await recomputeTotals(db, id);
    // TODO: AR->GL revenue resync is out of SCM-clone scope.
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: "delete_failed", reason: errMsg(e) }, 500);
  }
});

// ── Payments (mirror DO/SO payments ledger) ──────────────────────────────
const PAYMENT_SELECT = {
  id: siPaymentsTable.id, sales_invoice_id: siPaymentsTable.salesInvoiceId, paid_at: siPaymentsTable.paidAt, method: siPaymentsTable.method,
  merchant_provider: siPaymentsTable.merchantProvider, installment_months: siPaymentsTable.installmentMonths, online_type: siPaymentsTable.onlineType,
  approval_code: siPaymentsTable.approvalCode, amount_centi: siPaymentsTable.amountCenti, account_sheet: siPaymentsTable.accountSheet,
  collected_by: siPaymentsTable.collectedBy, note: siPaymentsTable.note, created_at: siPaymentsTable.createdAt, created_by: siPaymentsTable.createdBy,
} as const;

app.get("/:id/payments", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  try {
    const rows = await db.select(PAYMENT_SELECT).from(siPaymentsTable).where(eq(siPaymentsTable.salesInvoiceId, id)).orderBy(desc(siPaymentsTable.paidAt), desc(siPaymentsTable.createdAt));
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

/* Roll the SI paid_centi + status (PARTIALLY_PAID / PAID / SENT) from the ledger.
   Never moves a CANCELLED invoice. */
async function recomputePaid(db: Db, salesInvoiceId: string): Promise<void> {
  const pays = await db.select({ amountCenti: siPaymentsTable.amountCenti }).from(siPaymentsTable).where(eq(siPaymentsTable.salesInvoiceId, salesInvoiceId));
  const paid = pays.reduce((s, p) => s + Number(p.amountCenti ?? 0), 0);
  const cur = await db.select({ totalCenti: siTable.totalCenti, status: siTable.status }).from(siTable).where(eq(siTable.id, salesInvoiceId)).limit(1);
  if (!cur[0]) return;
  const updates: Record<string, unknown> = { paidCenti: paid, updatedAt: new Date() };
  if (cur[0].status !== "CANCELLED") {
    if (paid >= Number(cur[0].totalCenti ?? 0) && Number(cur[0].totalCenti ?? 0) > 0) { updates.status = "PAID"; updates.paidAt = new Date(); }
    else if (paid > 0) updates.status = "PARTIALLY_PAID";
    else updates.status = "SENT";
  }
  await db.update(siTable).set(updates).where(eq(siTable.id, salesInvoiceId));
}

app.post("/:id/payments", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const user = c.get("user");
  const doc = await db.select({ id: siTable.id, status: siTable.status }).from(siTable).where(eq(siTable.id, id)).limit(1);
  if (!doc[0]) return c.json({ error: "sales_invoice_not_found" }, 404);
  if (doc[0].status === "CANCELLED") return c.json({ error: "not_payable", message: "SI is cancelled" }, 409);

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
    const inserted = await db.insert(siPaymentsTable).values({ salesInvoiceId: id, paidAt: p.paidAt, method: p.method, merchantProvider, installmentMonths, onlineType, approvalCode: p.approvalCode ?? null, amountCenti: p.amountCenti, accountSheet: p.accountSheet ?? null, collectedBy: p.collectedBy ?? null, note: p.note ?? null, createdBy: user.id } as never).returning(PAYMENT_SELECT);
    await recomputePaid(db, id);
    return c.json({ payment: { ...inserted[0], created_at: isoOrNull(inserted[0].created_at) } }, 201);
  } catch (e) {
    return c.json({ error: "insert_failed", reason: errMsg(e) }, 500);
  }
});

app.delete("/:id/payments/:paymentId", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const paymentId = c.req.param("paymentId");
  const row = await db.select({ salesInvoiceId: siPaymentsTable.salesInvoiceId }).from(siPaymentsTable).where(eq(siPaymentsTable.id, paymentId)).limit(1);
  if (!row[0]) return c.json({ error: "not_found" }, 404);
  if (row[0].salesInvoiceId !== id) return c.json({ error: "payment_doc_mismatch" }, 400);
  const inv = await db.select({ status: siTable.status }).from(siTable).where(eq(siTable.id, id)).limit(1);
  if ((inv[0]?.status ?? "") === "CANCELLED") return c.json({ error: "not_payable", message: "SI is cancelled" }, 409);
  try {
    await db.delete(siPaymentsTable).where(eq(siPaymentsTable.id, paymentId));
    await recomputePaid(db, id);
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: "delete_failed", reason: errMsg(e) }, 500);
  }
});

// ── Status transition (Cancel / Reopen) ────────────────────────────────────
app.patch("/:id/status", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  let body: { status?: string };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: "invalid_json" }, 400); }
  if (!body.status) return c.json({ error: "status_required" }, 400);
  const now = new Date();
  const ts: Record<string, unknown> = { updatedAt: now };
  if (body.status === "SENT" || body.status === "ISSUED") ts.sentAt = now;
  if (body.status === "PAID") ts.paidAt = now;
  const status = body.status === "ISSUED" ? "SENT" : body.status;

  const curRow = await db.select({ status: siTable.status }).from(siTable).where(eq(siTable.id, id)).limit(1);
  if (!curRow[0]) return c.json({ error: "not_found" }, 404);
  const prevStatus = (curRow[0].status ?? "").toUpperCase();

  if (status === "CANCELLED" && prevStatus === "CANCELLED") return c.json({ salesInvoice: { id, status: "CANCELLED" } });

  const ACTIVE = new Set(["SENT", "PARTIALLY_PAID", "PAID", "OVERDUE"]);
  const isReopen = prevStatus === "CANCELLED" && status !== "CANCELLED";
  if (isReopen && status !== "SENT") return c.json({ error: "invalid_transition", message: `Cannot reopen a cancelled invoice straight to ${status}. Reopen to SENT first; payment status is re-derived from the ledger.`, from: prevStatus, to: status }, 409);
  if (isReopen && status === "SENT") {
    const reopenLines = await db.select({ doItemId: siItemsTable.doItemId, qty: siItemsTable.qty }).from(siItemsTable).where(eq(siItemsTable.salesInvoiceId, id));
    const linesForCheck = reopenLines.filter((l) => l.doItemId).map((l) => ({ doItemId: l.doItemId as string, qty: l.qty }));
    const over = await checkSiOverRemaining(db, linesForCheck);
    if (over) return c.json({ error: "over_remaining", message: "Cannot reopen — the delivered quantity has since been invoiced elsewhere. The DO lines no longer have room for this invoice.", lines: over.lines }, 409);
  }
  if (status !== "CANCELLED" && status !== "SENT" && !ACTIVE.has(prevStatus)) return c.json({ error: "invalid_transition", message: `Cannot move from ${prevStatus} to ${status}. Payment statuses are derived from the payments ledger.`, from: prevStatus, to: status }, 409);

  let data: { id: string; status: string } | null;
  if (status === "CANCELLED") {
    const updated = await db.update(siTable).set({ status: status as never, ...ts }).where(and(eq(siTable.id, id), sql`${siTable.status} <> 'CANCELLED'`)).returning({ id: siTable.id, status: siTable.status });
    if (!updated[0]) return c.json({ salesInvoice: { id, status: "CANCELLED" } });
    data = updated[0] as { id: string; status: string };
  } else {
    const updated = await db.update(siTable).set({ status: status as never, ...ts }).where(eq(siTable.id, id)).returning({ id: siTable.id, status: siTable.status });
    if (!updated[0]) return c.json({ error: "not_found" }, 404);
    data = updated[0] as { id: string; status: string };
  }

  // TODO: AR->GL revenue reversal on CANCEL / re-post on REOPEN is out of
  // SCM-clone scope (reverseSiRevenue / postSiRevenue). The cancelled SI's qty
  // returns to Pending automatically (doLineRemaining filters non-cancelled SIs).
  // TODO: customer-credit cancel-with-payment / reopen-claw-back is out of scope.
  if (isReopen) await recomputePaid(db, id);

  return c.json({ salesInvoice: data });
});

// Legacy quick-payment endpoint (Outstanding page + single-amount callers).
app.patch("/:id/payment", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const user = c.get("user");
  let body: { amountCenti?: number; notes?: string };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: "invalid_json" }, 400); }
  const amount = Number(body.amountCenti ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) return c.json({ error: "invalid_amount" }, 400);

  const cur = await db.select({ status: siTable.status }).from(siTable).where(eq(siTable.id, id)).limit(1);
  if (!cur[0]) return c.json({ error: "not_found" }, 404);
  if (cur[0].status === "CANCELLED") return c.json({ error: "not_payable", message: "SI is cancelled" }, 409);

  try {
    await db.insert(siPaymentsTable).values({ salesInvoiceId: id, paidAt: new Date().toISOString().slice(0, 10), method: "cash", amountCenti: amount, note: body.notes ?? null, createdBy: user.id } as never);
    await recomputePaid(db, id);
    const data = await db.select({ id: siTable.id, paid_centi: siTable.paidCenti, status: siTable.status }).from(siTable).where(eq(siTable.id, id)).limit(1);
    return c.json({ salesInvoice: data[0] });
  } catch (e) {
    return c.json({ error: "payment_failed", reason: errMsg(e) }, 500);
  }
});

export default app;
