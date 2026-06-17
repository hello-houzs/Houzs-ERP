// ----------------------------------------------------------------------------
// /purchase-invoices — supplier billing us (after GRN). PO -> GRN -> Purchase
// Invoice. A PI is a FINANCE record (AP liability) with NO stock impact — the
// inventory IN landed at GRN time. On post it bumps grn_items.invoiced_qty; a
// payment moves it UNPAID(POSTED) -> PARTIALLY_PAID -> PAID; cancel reverses.
//
// 1:1 clone of 2990s apps/api/src/routes/purchase-invoices.ts. Endpoints,
// request bodies, response JSON shapes, status codes and business rules
// (POSTED-on-create, per-GRN-line invoice cap + post-insert race verify,
// invoiced_qty live-recount, payment auto-status, child-from-GRN convert paths,
// PI PO-clone line CRUD with edit-lock) are kept identical to 2990s. Only the
// SEAMS change:
//   - DB client: 2990s per-request createClient / c.get('supabase') -> Houzs
//     getDb (rule #3). Every PostgREST chain -> a Drizzle query, same JSON
//     in/out. Drizzle returns camelCase rows; the wire shapes keep 2990s's
//     snake_case via the *Response() mappers (rule #7).
//   - Auth: 2990s supabaseAuth -> Houzs requirePermission("*") (rule #4).
//   - user.id: 2990s staff.id (uuid) -> Houzs users.id (integer) (rule #4).
//   - Mount path: /api/purchase-invoices.
//
// OUT OF SCOPE — GL/accounting AP-posting. 2990s posts AP to a chart-of-accounts
// GL (reversePiAccounting / resyncPiAccounting / recostForPi / recostFromGrn).
// Houzs's finance model differs and the GL is not part of this SCM clone, so
// those calls are DROPPED (a // TODO marks each site). The PI document +
// payment-status stay fully functional. The DO/SI re-cost chain (Costing B) is
// likewise not cloned (SO slice pending) — dropped with a // TODO.
//
// Strategy-2 product-layer simplifications (Houzs is not the 2990s furniture
// business; owner enters own data — see docs/scm-clone/PLAN.md):
//   - DROPPED buildVariantSummary (the furniture description2 formatter); a PI
//     line's description2 is whatever the client sends (Houzs materials have no
//     item_group). The variant columns are still persisted for fidelity.
//
// Endpoints (same as 2990s):
//   GET    /purchase-invoices                  — list (status filter)
//   GET    /purchase-invoices/outstanding-grn-items — GRN lines with remaining-to-bill
//   GET    /purchase-invoices/:id              — detail (header + items)
//   GET    /purchase-invoices/:id/linked       — Smart Buttons: parent GRN + PO
//   POST   /purchase-invoices                  — create POSTED PI (manual / from-grn draft)
//   PATCH  /purchase-invoices/:id/post         — idempotent no-op (POSTED-on-create)
//   PATCH  /purchase-invoices/:id/payment      — record a payment (auto-status)
//   PATCH  /purchase-invoices/:id/cancel       — cancel + release GRN lines
//   POST   /purchase-invoices/from-grn-items   — multi-select GRN lines -> PIs
//   POST   /purchase-invoices/from-grn         — convert one whole GRN -> PI
//   PATCH  /purchase-invoices/:id              — header update
//   POST   /purchase-invoices/:id/items        — add line (+ GRN cap)
//   PATCH  /purchase-invoices/:id/items/:itemId— edit line (+ GRN cap)
//   DELETE /purchase-invoices/:id/items/:itemId— delete line + release GRN line
// ----------------------------------------------------------------------------

import { Hono } from "hono";
import { and, desc, eq, gt, inArray, like, ne } from "drizzle-orm";
import type { Env } from "../types";
import { getDb } from "../db/client";
import {
  purchaseInvoices as piTable,
  purchaseInvoiceItems as piItemsTable,
  suppliers as suppliersTable,
  purchaseOrders as poTable,
  grns as grnsTable,
  grnItems as grnItemsTable,
} from "../db/schema";
import { requirePermission } from "../middleware/auth";

const app = new Hono<{ Bindings: Env }>();

// Owner-only for now (rule #4). Gate every route in this module.
app.use("*", requirePermission("*"));

type Db = ReturnType<typeof getDb>;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isoOrNull(v: Date | string | null): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

// ── Wire-shape mappers (Drizzle camelCase -> 2990s snake_case) ──────────────
function toPiHeaderResponse(p: typeof piTable.$inferSelect) {
  return {
    id: p.id,
    invoice_number: p.invoiceNumber,
    supplier_invoice_ref: p.supplierInvoiceRef,
    supplier_id: p.supplierId,
    purchase_order_id: p.purchaseOrderId,
    grn_id: p.grnId,
    invoice_date: p.invoiceDate,
    due_date: p.dueDate,
    currency: p.currency,
    subtotal_centi: p.subtotalCenti,
    tax_centi: p.taxCenti,
    total_centi: p.totalCenti,
    paid_centi: p.paidCenti,
    status: p.status,
    notes: p.notes,
    posted_at: isoOrNull(p.postedAt),
    created_at: isoOrNull(p.createdAt),
    created_by: p.createdBy,
    updated_at: isoOrNull(p.updatedAt),
  };
}

function toPiItemResponse(it: typeof piItemsTable.$inferSelect) {
  return {
    id: it.id,
    purchase_invoice_id: it.purchaseInvoiceId,
    grn_item_id: it.grnItemId,
    material_kind: it.materialKind,
    material_code: it.materialCode,
    material_name: it.materialName,
    qty: it.qty,
    unit_price_centi: it.unitPriceCenti,
    line_total_centi: it.lineTotalCenti,
    notes: it.notes,
    item_group: it.itemGroup,
    description: it.description,
    description2: it.description2,
    uom: it.uom,
    discount_centi: it.discountCenti,
    variants: it.variants ?? null,
    gap_inches: it.gapInches,
    divan_height_inches: it.divanHeightInches,
    divan_price_sen: it.divanPriceSen,
    leg_height_inches: it.legHeightInches,
    leg_price_sen: it.legPriceSen,
    custom_specials: it.customSpecials ?? null,
    line_suffix: it.lineSuffix,
    special_order_price_sen: it.specialOrderPriceSen,
    unit_cost_centi: it.unitCostCenti,
    created_at: isoOrNull(it.createdAt),
  };
}

const nextNum = async (db: Db, prefix: string): Promise<string> => {
  const d = new Date();
  const yymm = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, "0")}`;
  const rows = await db
    .select({ id: piTable.id })
    .from(piTable)
    .where(like(piTable.invoiceNumber, `${prefix}-${yymm}-%`));
  return `${prefix}-${yymm}-${String(rows.length + 1).padStart(3, "0")}`;
};

/* ── Recompute PI header money rollups (mirror recomputeGrnTotals) ─────────
   Sum line_total_centi across purchase_invoice_items -> write subtotal_centi,
   then total_centi = subtotal + tax_centi (PI carries a stored tax that GRN
   does NOT, so we ADD it into total here). paid_centi is untouched — Balance
   (total - paid) is derived in the UI; payment recording stays on /payment. */
async function recomputePiTotals(db: Db, piId: string) {
  const [items, headerRows] = await Promise.all([
    db.select({ lineTotalCenti: piItemsTable.lineTotalCenti }).from(piItemsTable).where(eq(piItemsTable.purchaseInvoiceId, piId)),
    db.select({ taxCenti: piTable.taxCenti }).from(piTable).where(eq(piTable.id, piId)).limit(1),
  ]);
  const subtotal = items.reduce((s, r) => s + (r.lineTotalCenti ?? 0), 0);
  const tax = headerRows[0]?.taxCenti ?? 0;
  await db
    .update(piTable)
    .set({ subtotalCenti: subtotal, totalCenti: subtotal + tax, updatedAt: new Date() })
    .where(eq(piTable.id, piId));
}

/* ── Self-heal GRN invoiced counter (live-count model, mirrors
   recomputePoReceived) ──────────────────────────────────────────────────────
   For each given grn_item, RECOUNT invoiced_qty from scratch as the sum of qty
   across ALL live (non-cancelled) PI lines that point at it. So
   create/edit/delete/cancel all converge to the truth and the GRN line
   auto-releases for re-invoicing the moment its PI lines go away. Clamped to
   [0, qty_accepted]. Best-effort. */
async function recomputeGrnInvoiced(db: Db, grnItemIds: Array<string | null | undefined>) {
  const ids = [...new Set(grnItemIds.filter((x): x is string => Boolean(x)))];
  if (ids.length === 0) return;
  try {
    const plines = await db
      .select({ grnItemId: piItemsTable.grnItemId, qty: piItemsTable.qty, purchaseInvoiceId: piItemsTable.purchaseInvoiceId })
      .from(piItemsTable)
      .where(inArray(piItemsTable.grnItemId, ids));
    const piIds = [...new Set(plines.map((r) => r.purchaseInvoiceId).filter(Boolean))];
    const cancelled = new Set<string>();
    if (piIds.length > 0) {
      const pis = await db.select({ id: piTable.id, status: piTable.status }).from(piTable).where(inArray(piTable.id, piIds));
      for (const p of pis) if (p.status === "CANCELLED") cancelled.add(p.id);
    }
    const invByGrnItem = new Map<string, number>(ids.map((id) => [id, 0]));
    for (const r of plines) {
      if (!r.grnItemId || cancelled.has(r.purchaseInvoiceId)) continue;
      invByGrnItem.set(r.grnItemId, (invByGrnItem.get(r.grnItemId) ?? 0) + Number(r.qty ?? 0));
    }
    const giRows = await db.select({ id: grnItemsTable.id, qtyAccepted: grnItemsTable.qtyAccepted }).from(grnItemsTable).where(inArray(grnItemsTable.id, ids));
    const acceptedById = new Map<string, number>(giRows.map((g) => [g.id, g.qtyAccepted ?? 0]));
    await Promise.all(
      [...invByGrnItem.entries()].map(([giId, inv]) => {
        const capped = Math.min(acceptedById.get(giId) ?? inv, Math.max(0, inv));
        return db.update(grnItemsTable).set({ invoicedQty: capped }).where(eq(grnItemsTable.id, giId));
      }),
    );
  } catch (e) {
    console.error("[recomputeGrnInvoiced] best-effort recount failed", { grnItemIds: ids, error: e });
  }
}

/* ── verifyGrnLinesNotOverInvoiced (post-insert over-invoice race guard) ─────
   The bulk PI create paths only PRE-check each GRN line's remaining before
   inserting — a read-then-write race. After committing THIS PI's lines, re-sum
   the LIVE invoiced qty per GRN line; any over its cap (qty_accepted -
   returned_qty) means OUR insert broke it. Returns the offending lines, or []. */
async function verifyGrnLinesNotOverInvoiced(
  db: Db,
  grnItemIds: Array<string | null | undefined>,
): Promise<Array<{ grnItemId: string; invoiced: number; cap: number }>> {
  const ids = [...new Set(grnItemIds.filter((x): x is string => Boolean(x)))];
  if (ids.length === 0) return [];
  const giRows = await db
    .select({ id: grnItemsTable.id, qtyAccepted: grnItemsTable.qtyAccepted, returnedQty: grnItemsTable.returnedQty })
    .from(grnItemsTable)
    .where(inArray(grnItemsTable.id, ids));
  const capById = new Map<string, number>(giRows.map((g) => [g.id, (g.qtyAccepted ?? 0) - (g.returnedQty ?? 0)]));
  const sibRows = await db
    .select({ grnItemId: piItemsTable.grnItemId, qty: piItemsTable.qty, purchaseInvoiceId: piItemsTable.purchaseInvoiceId })
    .from(piItemsTable)
    .where(inArray(piItemsTable.grnItemId, ids));
  const piIds = [...new Set(sibRows.map((r) => r.purchaseInvoiceId).filter(Boolean))];
  const cancelled = new Set<string>();
  if (piIds.length > 0) {
    const pis = await db.select({ id: piTable.id, status: piTable.status }).from(piTable).where(inArray(piTable.id, piIds));
    for (const p of pis) if (p.status === "CANCELLED") cancelled.add(p.id);
  }
  const liveByGrnItem = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const r of sibRows) {
    if (!r.grnItemId || cancelled.has(r.purchaseInvoiceId)) continue;
    liveByGrnItem.set(r.grnItemId, (liveByGrnItem.get(r.grnItemId) ?? 0) + Number(r.qty ?? 0));
  }
  const over: Array<{ grnItemId: string; invoiced: number; cap: number }> = [];
  for (const id of ids) {
    const invoiced = liveByGrnItem.get(id) ?? 0;
    const cap = capById.get(id) ?? invoiced;
    if (invoiced > cap) over.push({ grnItemId: id, invoiced, cap });
  }
  return over;
}

/* PI edit-lock guard: a PI with ANY payment recorded (paid_centi > 0) or that's
   CANCELLED is read-only. Returns the blocking JSON, or null if editable. */
async function piLocked(db: Db, piId: string): Promise<{ error: string; message: string } | null> {
  const rows = await db.select({ paidCenti: piTable.paidCenti, status: piTable.status }).from(piTable).where(eq(piTable.id, piId)).limit(1);
  const row = rows[0];
  if (!row) return null; // not found — let the handler's own load surface 404
  if (row.status === "CANCELLED") return { error: "pi_cancelled", message: "Invoice is cancelled" };
  if ((row.paidCenti ?? 0) > 0) return { error: "pi_locked", message: "Invoice has a payment recorded — locked" };
  return null;
}

// ── List ────────────────────────────────────────────────────────────────
app.get("/", async (c) => {
  const db = getDb(c.env);
  const status = c.req.query("status");
  const conds = [];
  if (status) conds.push(eq(piTable.status, status as "POSTED" | "PARTIALLY_PAID" | "PAID" | "CANCELLED"));
  try {
    const rows = await db
      .select({
        pi: piTable,
        supplier: { id: suppliersTable.id, code: suppliersTable.code, name: suppliersTable.name },
        purchase_order: { id: poTable.id, po_number: poTable.poNumber },
        grn: { id: grnsTable.id, grn_number: grnsTable.grnNumber },
      })
      .from(piTable)
      .leftJoin(suppliersTable, eq(piTable.supplierId, suppliersTable.id))
      .leftJoin(poTable, eq(piTable.purchaseOrderId, poTable.id))
      .leftJoin(grnsTable, eq(piTable.grnId, grnsTable.id))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(piTable.invoiceDate));
    const purchaseInvoices = rows.map((r) => ({
      ...toPiHeaderResponse(r.pi),
      supplier: r.supplier?.id ? r.supplier : null,
      purchase_order: r.purchase_order?.id ? r.purchase_order : null,
      grn: r.grn?.id ? r.grn : null,
    }));
    return c.json({ purchaseInvoices });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

/* ── GET /outstanding-grn-items ─────────────────────────────────────────
   GRN LINES eligible for invoicing: remaining = qty_accepted - invoiced_qty -
   returned_qty > 0 from POSTED GRNs. A GRN line can be invoiced across multiple
   PIs until fully consumed.
   IMPORTANT (route ordering): this STATIC path MUST precede `/:id`. */
app.get("/outstanding-grn-items", async (c) => {
  const db = getDb(c.env);
  try {
    const headers = await db
      .select({
        id: grnsTable.id,
        grn_number: grnsTable.grnNumber,
        received_at: grnsTable.receivedAt,
        supplier_id: grnsTable.supplierId,
        purchase_order_id: grnsTable.purchaseOrderId,
        supplier: { code: suppliersTable.code, name: suppliersTable.name },
        purchase_order: { po_number: poTable.poNumber },
      })
      .from(grnsTable)
      .leftJoin(suppliersTable, eq(grnsTable.supplierId, suppliersTable.id))
      .leftJoin(poTable, eq(grnsTable.purchaseOrderId, poTable.id))
      .where(eq(grnsTable.status, "POSTED"))
      .orderBy(desc(grnsTable.receivedAt))
      .limit(500);
    if (headers.length === 0) return c.json({ items: [] });

    const grnIds = headers.map((h) => h.id);
    const items = await db
      .select({
        id: grnItemsTable.id,
        grn_id: grnItemsTable.grnId,
        material_kind: grnItemsTable.materialKind,
        material_code: grnItemsTable.materialCode,
        material_name: grnItemsTable.materialName,
        item_group: grnItemsTable.itemGroup,
        description: grnItemsTable.description,
        qty_accepted: grnItemsTable.qtyAccepted,
        qty_rejected: grnItemsTable.qtyRejected,
        invoiced_qty: grnItemsTable.invoicedQty,
        returned_qty: grnItemsTable.returnedQty,
        unit_price_centi: grnItemsTable.unitPriceCenti,
        variants: grnItemsTable.variants,
      })
      .from(grnItemsTable)
      .where(inArray(grnItemsTable.grnId, grnIds));

    const headerById = new Map(headers.map((h) => [h.id, h]));
    const out = items
      .map((r) => {
        const invoiced = r.invoiced_qty ?? 0;
        const returned = r.returned_qty ?? 0;
        const remaining = (r.qty_accepted ?? 0) - invoiced - returned;
        return { ...r, _remaining: remaining };
      })
      .filter((r) => r._remaining > 0)
      .map((r) => {
        const h = headerById.get(r.grn_id)!;
        return {
          grnItemId: r.id,
          grnId: r.grn_id,
          grnDocNo: h.grn_number,
          receivedAt: h.received_at,
          supplierId: h.supplier_id,
          supplierCode: h.supplier?.code ?? "",
          supplierName: h.supplier?.name ?? "",
          purchaseOrderId: h.purchase_order_id,
          poDocNo: h.purchase_order?.po_number ?? null,
          itemCode: r.material_code,
          description: r.description ?? r.material_name,
          itemGroup: r.item_group ?? "",
          qtyAccepted: r.qty_accepted,
          invoicedQty: r.invoiced_qty ?? 0,
          remaining: r._remaining,
          unitPriceCenti: r.unit_price_centi,
          variants: r.variants,
        };
      });
    return c.json({ items: out });
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
      db
        .select({
          pi: piTable,
          supplier: { id: suppliersTable.id, code: suppliersTable.code, name: suppliersTable.name },
          purchase_order: { id: poTable.id, po_number: poTable.poNumber },
          grn: { id: grnsTable.id, grn_number: grnsTable.grnNumber },
        })
        .from(piTable)
        .leftJoin(suppliersTable, eq(piTable.supplierId, suppliersTable.id))
        .leftJoin(poTable, eq(piTable.purchaseOrderId, poTable.id))
        .leftJoin(grnsTable, eq(piTable.grnId, grnsTable.id))
        .where(eq(piTable.id, id))
        .limit(1),
      db.select().from(piItemsTable).where(eq(piItemsTable.purchaseInvoiceId, id)).orderBy(piItemsTable.createdAt),
    ]);
    const headerRow = headerRows[0];
    if (!headerRow) return c.json({ error: "not_found" }, 404);
    const purchaseInvoice = {
      ...toPiHeaderResponse(headerRow.pi),
      supplier: headerRow.supplier?.id ? headerRow.supplier : null,
      purchase_order: headerRow.purchase_order?.id ? headerRow.purchase_order : null,
      grn: headerRow.grn?.id ? headerRow.grn : null,
    };
    return c.json({ purchaseInvoice, items: itemRows.map(toPiItemResponse) });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

// ── Linked docs (Smart Buttons fan-out) — parent GRN + PO ──────────────────
app.get("/:id/linked", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  try {
    const rows = await db
      .select({
        id: piTable.id,
        grn: { id: grnsTable.id, grn_number: grnsTable.grnNumber },
        purchase_order: { id: poTable.id, po_number: poTable.poNumber },
      })
      .from(piTable)
      .leftJoin(grnsTable, eq(piTable.grnId, grnsTable.id))
      .leftJoin(poTable, eq(piTable.purchaseOrderId, poTable.id))
      .where(eq(piTable.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) return c.json({ error: "not_found" }, 404);
    return c.json({ grn: row.grn?.id ? row.grn : null, purchaseOrder: row.purchase_order?.id ? row.purchase_order : null });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

// ── Create ──────────────────────────────────────────────────────────────
app.post("/", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  if (body.status === "DRAFT")
    return c.json({ error: "draft_status_not_supported", message: "DRAFT was removed in migration 0078 — PIs post immediately on create." }, 400);
  if (!body.supplierId) return c.json({ error: "supplier_required" }, 400);
  const items = body.items as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(items) || !items.length) return c.json({ error: "items_required" }, 400);

  const db = getDb(c.env);
  const user = c.get("user");

  /* Over-invoice guard: any line linked to a GRN line is capped at that line's
     REMAINING (qty_accepted - invoiced_qty - returned_qty). Sum requested qty
     per GRN line first (same GRN line can appear twice in one PI). */
  {
    const wantByGrnItem = new Map<string, number>();
    for (const it of items) {
      const gid = (it.grnItemId as string | undefined) ?? null;
      if (!gid) continue;
      wantByGrnItem.set(gid, (wantByGrnItem.get(gid) ?? 0) + Number(it.qty ?? 0));
    }
    const gids = [...wantByGrnItem.keys()];
    if (gids.length > 0) {
      const giRows = await db
        .select({ id: grnItemsTable.id, qtyAccepted: grnItemsTable.qtyAccepted, invoicedQty: grnItemsTable.invoicedQty, returnedQty: grnItemsTable.returnedQty })
        .from(grnItemsTable)
        .where(inArray(grnItemsTable.id, gids));
      const byId = new Map(giRows.map((g) => [g.id, g]));
      const over: Array<{ grnItemId: string; requested: number; remaining: number }> = [];
      for (const [gid, want] of wantByGrnItem.entries()) {
        const g = byId.get(gid);
        if (!g) return c.json({ error: "item_not_found", grnItemId: gid }, 400);
        const remaining = (g.qtyAccepted ?? 0) - (g.invoicedQty ?? 0) - (g.returnedQty ?? 0);
        if (want > remaining) over.push({ grnItemId: gid, requested: want, remaining });
      }
      if (over.length > 0) return c.json({ error: "qty_exceeds_remaining", lines: over }, 409);
    }
  }

  const invoiceNumber = await nextNum(db, "PI");
  let subtotal = 0;
  const itemRows = items.map((it) => {
    /* PI discount unification — ONE rule on every PI line write path:
       line_total_centi = qty x unit - discount, discount stored. */
    const qty = Number(it.qty ?? 0);
    const unit = Number(it.unitPriceCenti ?? 0);
    const discount = Number(it.discountCenti ?? 0) || 0;
    const total = qty * unit - discount;
    subtotal += total;
    return {
      materialKind: (it.materialKind as "mfg_product" | "fabric" | "raw") ?? "mfg_product",
      materialCode: it.materialCode as string,
      materialName: it.materialName as string,
      qty,
      unitPriceCenti: unit,
      discountCenti: discount,
      lineTotalCenti: total,
      grnItemId: (it.grnItemId as string | undefined) ?? null,
      notes: (it.notes as string | undefined) ?? null,
      itemGroup: (it.itemGroup as string | null | undefined) ?? null,
      variants: (it.variants as Record<string, unknown> | null | undefined) ?? null,
    };
  });

  // PR-DRAFT-removal — PIs are created as POSTED directly. PI is AP-only (no
  // inventory impact — that landed at GRN time), so no side-effect helper.
  let header: { id: string; invoiceNumber: string };
  try {
    const inserted = await db
      .insert(piTable)
      .values({
        invoiceNumber,
        supplierInvoiceRef: (body.supplierInvoiceRef as string) ?? null,
        supplierId: body.supplierId as string,
        purchaseOrderId: (body.purchaseOrderId as string) ?? null,
        grnId: (body.grnId as string) ?? null,
        invoiceDate: (body.invoiceDate as string) ?? new Date().toISOString().slice(0, 10),
        dueDate: (body.dueDate as string) ?? null,
        currency: (((body.currency as string) ?? "MYR").toUpperCase()) as "MYR" | "RMB" | "USD" | "SGD",
        subtotalCenti: subtotal,
        totalCenti: subtotal,
        notes: (body.notes as string) ?? null,
        status: "POSTED",
        postedAt: new Date(),
        createdBy: user.id,
      } as never)
      .returning({ id: piTable.id, invoiceNumber: piTable.invoiceNumber });
    header = inserted[0];
  } catch (e) {
    return c.json({ error: "insert_failed", reason: errMsg(e) }, 500);
  }

  const rowsWithId = itemRows.map((r) => ({ ...r, purchaseInvoiceId: header.id }));
  try {
    await db.insert(piItemsTable).values(rowsWithId as never);
  } catch (iErr) {
    await db.delete(piTable).where(eq(piTable.id, header.id));
    return c.json({ error: "items_insert_failed", reason: errMsg(iErr) }, 500);
  }

  /* Post-insert over-invoice verification (race guard). If any GRN line is over
     its cap, delete THIS PI (lines cascade) + 409. */
  {
    const over = await verifyGrnLinesNotOverInvoiced(db, itemRows.map((r) => r.grnItemId));
    if (over.length > 0) {
      await db.delete(piTable).where(eq(piTable.id, header.id));
      return c.json({ error: "qty_exceeds_remaining", lines: over }, 409);
    }
  }
  // Self-heal the GRN invoiced counter so the billed lines drop out of the picker.
  await recomputeGrnInvoiced(db, itemRows.map((r) => r.grnItemId));
  /* Costing B (2990s recostForPi: re-cost the GRN's lots -> DO -> SI so margin
     reflects the billed price) is not cloned — the DO/SI chain + recost engine
     are furniture/SO-coupled. TODO: recostForPi(db, header.id) when those land.
     AP->GL posting is out of SCM clone scope (Houzs GL differs). */
  return c.json({ id: header.id, invoiceNumber: header.invoiceNumber }, 201);
});

// ── PATCH /:id/post — idempotent no-op (POSTED-on-create) ──────────────────
app.patch("/:id/post", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const curRows = await db.select({ id: piTable.id, status: piTable.status }).from(piTable).where(eq(piTable.id, id)).limit(1);
  const cur = curRows[0];
  if (!cur) return c.json({ error: "not_found" }, 404);
  if (cur.status === "POSTED") return c.json({ purchaseInvoice: cur });
  try {
    const updated = await db
      .update(piTable)
      .set({ status: "POSTED", postedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(piTable.id, id), ne(piTable.status, "CANCELLED")))
      .returning({ id: piTable.id, status: piTable.status });
    if (!updated[0]) return c.json({ error: "cannot_post" }, 409);
    return c.json({ purchaseInvoice: updated[0] });
  } catch (e) {
    return c.json({ error: "post_failed", reason: errMsg(e) }, 500);
  }
});

/* ── PATCH /:id/payment ────────────────────────────────────────────────────
   Record a payment: add to paid_centi + auto-transition status (paid == total
   -> PAID, 0 < paid < total -> PARTIALLY_PAID). */
app.patch("/:id/payment", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  let body: { amountCenti?: number; notes?: string };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const amount = Number(body.amountCenti ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) return c.json({ error: "invalid_amount" }, 400);

  const curRows = await db.select({ paidCenti: piTable.paidCenti, totalCenti: piTable.totalCenti, status: piTable.status }).from(piTable).where(eq(piTable.id, id)).limit(1);
  const c0 = curRows[0];
  if (!c0) return c.json({ error: "not_found" }, 404);
  if (c0.status === "CANCELLED") return c.json({ error: "not_payable", message: "PI is cancelled" }, 409);

  const newPaid = (c0.paidCenti ?? 0) + amount;
  const newStatus = newPaid >= (c0.totalCenti ?? 0) ? "PAID" : "PARTIALLY_PAID";
  try {
    const updated = await db
      .update(piTable)
      .set({ paidCenti: newPaid, status: newStatus, updatedAt: new Date() })
      .where(eq(piTable.id, id))
      .returning({ id: piTable.id, paid_centi: piTable.paidCenti, status: piTable.status });
    return c.json({ purchaseInvoice: updated[0] });
  } catch (e) {
    return c.json({ error: "payment_failed", reason: errMsg(e) }, 500);
  }
});

// ── PATCH /:id/cancel — cancel + release GRN lines ─────────────────────────
app.patch("/:id/cancel", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const curRows = await db.select({ id: piTable.id, status: piTable.status, paidCenti: piTable.paidCenti }).from(piTable).where(eq(piTable.id, id)).limit(1);
  const head = curRows[0];
  if (!head) return c.json({ error: "not_found" }, 404);
  if (head.status === "PAID" || (head.paidCenti ?? 0) > 0) return c.json({ error: "cannot_cancel", message: "PI already paid" }, 409);
  if (head.status === "CANCELLED") return c.json({ purchaseInvoice: { id, status: "CANCELLED" } });

  /* ATOMIC single ACTIVE->CANCELLED transition — the conditional UPDATE excludes
     both PAID and CANCELLED, so two concurrent cancels race + only ONE flips it,
     guaranteeing the GRN release below runs exactly once. */
  let cancelled: { id: string; status: string } | undefined;
  try {
    const updated = await db
      .update(piTable)
      .set({ status: "CANCELLED", updatedAt: new Date() })
      .where(and(eq(piTable.id, id), ne(piTable.status, "PAID"), ne(piTable.status, "CANCELLED")))
      .returning({ id: piTable.id, status: piTable.status });
    cancelled = updated[0];
  } catch (e) {
    return c.json({ error: "cancel_failed", reason: errMsg(e) }, 500);
  }
  if (!cancelled) {
    const nowRows = await db.select({ status: piTable.status }).from(piTable).where(eq(piTable.id, id)).limit(1);
    if (nowRows[0]?.status === "CANCELLED") return c.json({ purchaseInvoice: { id, status: "CANCELLED" } });
    return c.json({ error: "cannot_cancel", message: "PI already paid" }, 409);
  }

  /* 2990s reverses the PI accounting (Dr Inventory / Cr Payables -> contra) here.
     AP->GL posting is out of SCM clone scope (Houzs GL differs).
     TODO: AP->GL reversal when a Houzs GL lands. */

  // Release the GRN-line consumption: recount invoiced_qty from live PI lines —
  // this cancelled PI's lines now drop out, auto-releasing the GRN line.
  const lines = await db.select({ grnItemId: piItemsTable.grnItemId }).from(piItemsTable).where(eq(piItemsTable.purchaseInvoiceId, id));
  await recomputeGrnInvoiced(db, lines.map((l) => l.grnItemId));
  // Costing B (recostForPi) — not cloned. TODO when DO/SI land.
  return c.json({ purchaseInvoice: { id: cancelled.id, status: cancelled.status } });
});

/* ── POST /from-grn-items ───────────────────────────────────────────────
   Body: { picks: [{ grnItemId, qty }], supplierInvoiceNumber?, invoiceDate?,
           dueDate?, notes? }. Groups picks by GRN (one PI per GRN), creates +
   auto-posts each. PI does NOT touch inventory. */
app.post("/from-grn-items", async (c) => {
  const db = getDb(c.env);
  const user = c.get("user");
  let body: { picks?: Array<{ grnItemId: string; qty: number }>; supplierInvoiceNumber?: string; invoiceDate?: string; dueDate?: string; notes?: string };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const picks = body.picks ?? [];
  if (picks.length === 0) return c.json({ error: "picks_required" }, 400);

  const ids = picks.map((p) => p.grnItemId);
  type ItemRow = typeof grnItemsTable.$inferSelect & {
    grn: { id: string; grn_number: string; supplier_id: string; purchase_order_id: string | null; status: string };
  };
  let itemList: ItemRow[];
  try {
    const rows = await db
      .select({
        item: grnItemsTable,
        grn: {
          id: grnsTable.id,
          grn_number: grnsTable.grnNumber,
          supplier_id: grnsTable.supplierId,
          purchase_order_id: grnsTable.purchaseOrderId,
          status: grnsTable.status,
        },
      })
      .from(grnItemsTable)
      .innerJoin(grnsTable, eq(grnItemsTable.grnId, grnsTable.id))
      .where(inArray(grnItemsTable.id, ids));
    itemList = rows.map((r) => ({ ...r.item, grn: r.grn }));
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }

  const byId = new Map<string, ItemRow>();
  for (const r of itemList) byId.set(r.id, r);

  for (const p of picks) {
    const row = byId.get(p.grnItemId);
    if (!row) return c.json({ error: "item_not_found", grnItemId: p.grnItemId }, 400);
    if (p.qty <= 0) return c.json({ error: "qty_must_be_positive", grnItemId: p.grnItemId }, 400);
    const remaining = (row.qtyAccepted ?? 0) - (row.invoicedQty ?? 0) - (row.returnedQty ?? 0);
    if (p.qty > remaining) return c.json({ error: "qty_exceeds_remaining", grnItemId: p.grnItemId, requested: p.qty, remaining }, 409);
    if (row.grn.status !== "POSTED") return c.json({ error: "grn_not_posted", grnItemId: p.grnItemId, status: row.grn.status }, 409);
  }

  // Group picks by GRN (each PI <-> one GRN, per single FK).
  type Bucket = {
    grnId: string;
    grnNumber: string;
    supplierId: string;
    purchaseOrderId: string | null;
    lines: Array<{ row: ItemRow; qty: number }>;
  };
  const buckets = new Map<string, Bucket>();
  for (const p of picks) {
    const row = byId.get(p.grnItemId)!;
    const cur =
      buckets.get(row.grn.id) ?? {
        grnId: row.grn.id,
        grnNumber: row.grn.grn_number,
        supplierId: row.grn.supplier_id,
        purchaseOrderId: row.grn.purchase_order_id,
        lines: [],
      };
    cur.lines.push({ row, qty: p.qty });
    buckets.set(row.grn.id, cur);
  }

  const d = new Date();
  const yymm = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, "0")}`;
  const existing = await db.select({ id: piTable.id }).from(piTable).where(like(piTable.invoiceNumber, `PI-${yymm}-%`));
  let counter = existing.length;

  const invoiceDate = body.invoiceDate ?? new Date().toISOString().slice(0, 10);
  const created: Array<{ id: string; invoiceNumber: string; supplierId: string; grnCount: number; lineCount: number }> = [];

  /* PI discount unification — line_total_centi = qty x unit - discount; the GRN
     line discount is pro-rated by billed qty over qty_accepted so a line billed
     across multiple PIs never subtracts more than the full GRN discount. */
  const discFor = (row: ItemRow, qty: number) => Math.round(Number(row.discountCenti ?? 0) * qty / (Number(row.qtyAccepted) || 1));

  for (const bucket of buckets.values()) {
    counter += 1;
    const invoiceNumber = `PI-${yymm}-${String(counter).padStart(3, "0")}`;
    const subtotal = bucket.lines.reduce((s, { row, qty }) => s + (qty * row.unitPriceCenti - discFor(row, qty)), 0);

    let header: { id: string; invoiceNumber: string } | undefined;
    try {
      const inserted = await db
        .insert(piTable)
        .values({
          invoiceNumber,
          supplierInvoiceRef: body.supplierInvoiceNumber ?? null,
          supplierId: bucket.supplierId,
          purchaseOrderId: bucket.purchaseOrderId,
          grnId: bucket.grnId,
          invoiceDate,
          dueDate: body.dueDate ?? null,
          currency: "MYR",
          subtotalCenti: subtotal,
          taxCenti: 0,
          totalCenti: subtotal,
          status: "POSTED",
          postedAt: new Date(),
          notes: body.notes ? `Multi-pick from ${bucket.grnNumber} · ${body.notes}` : `Multi-pick from ${bucket.grnNumber}`,
          createdBy: user.id,
        } as never)
        .returning({ id: piTable.id, invoiceNumber: piTable.invoiceNumber });
      header = inserted[0];
    } catch {
      continue;
    }
    if (!header) continue;
    const h = header;

    const rows = bucket.lines.map(({ row, qty }) => ({
      purchaseInvoiceId: h.id,
      grnItemId: row.id,
      materialKind: row.materialKind,
      materialCode: row.materialCode,
      materialName: row.materialName,
      qty,
      unitPriceCenti: row.unitPriceCenti,
      lineTotalCenti: qty * row.unitPriceCenti - discFor(row, qty),
      itemGroup: row.itemGroup,
      description: row.description,
      description2: row.description2,
      uom: row.uom ?? "UNIT",
      variants: row.variants,
      gapInches: row.gapInches,
      divanHeightInches: row.divanHeightInches,
      divanPriceSen: row.divanPriceSen ?? 0,
      legHeightInches: row.legHeightInches,
      legPriceSen: row.legPriceSen ?? 0,
      customSpecials: row.customSpecials,
      lineSuffix: row.lineSuffix,
      specialOrderPriceSen: row.specialOrderPriceSen ?? 0,
      discountCenti: discFor(row, qty),
    }));
    try {
      await db.insert(piItemsTable).values(rows as never);
    } catch {
      await db.delete(piTable).where(eq(piTable.id, h.id));
      continue;
    }
    {
      const over = await verifyGrnLinesNotOverInvoiced(db, bucket.lines.map(({ row }) => row.id));
      if (over.length > 0) {
        await db.delete(piTable).where(eq(piTable.id, h.id));
        continue;
      }
    }
    await recomputeGrnInvoiced(db, bucket.lines.map(({ row }) => row.id));
    // Costing B (recostFromGrn) — not cloned. TODO when DO/SI land.
    created.push({ id: h.id, invoiceNumber: h.invoiceNumber, supplierId: bucket.supplierId, grnCount: 1, lineCount: bucket.lines.length });
  }

  return c.json({ created, total: created.length }, 201);
});

/* ── POST /from-grn ─────────────────────────────────────────────────────
   Single-GRN convert (GRN list right-click "Convert to PI"). Copies the GRN's
   remaining-to-bill lines into a new POSTED PI. Body: { grnId } -> 201 { id }. */
app.post("/from-grn", async (c) => {
  const db = getDb(c.env);
  const user = c.get("user");
  let body: { grnId?: string };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const grnId = body.grnId;
  if (!grnId) return c.json({ error: "grn_id_required" }, 400);

  const grnRows = await db
    .select({ id: grnsTable.id, grnNumber: grnsTable.grnNumber, supplierId: grnsTable.supplierId, purchaseOrderId: grnsTable.purchaseOrderId, status: grnsTable.status })
    .from(grnsTable)
    .where(eq(grnsTable.id, grnId))
    .limit(1);
  const g = grnRows[0];
  if (!g) return c.json({ error: "grn_not_found" }, 404);
  if (g.status !== "POSTED") return c.json({ error: "grn_not_posted", status: g.status }, 409);

  const allLines = await db.select().from(grnItemsTable).where(and(eq(grnItemsTable.grnId, grnId), gt(grnItemsTable.qtyAccepted, 0)));
  const lines = allLines
    .map((it) => ({ ...it, _remaining: (it.qtyAccepted ?? 0) - (it.invoicedQty ?? 0) - (it.returnedQty ?? 0) }))
    .filter((it) => it._remaining > 0);
  if (lines.length === 0) return c.json({ error: "nothing_to_invoice", message: "GRN is fully invoiced" }, 400);

  const invoiceNumber = await nextNum(db, "PI");
  const discFor = (it: (typeof lines)[number]) => Math.round(Number(it.discountCenti ?? 0) * it._remaining / (Number(it.qtyAccepted) || 1));
  const subtotal = lines.reduce((s, it) => s + (it._remaining * it.unitPriceCenti - discFor(it)), 0);

  let header: { id: string; invoiceNumber: string };
  try {
    const inserted = await db
      .insert(piTable)
      .values({
        invoiceNumber,
        supplierId: g.supplierId,
        purchaseOrderId: g.purchaseOrderId,
        grnId: g.id,
        invoiceDate: new Date().toISOString().slice(0, 10),
        currency: "MYR",
        subtotalCenti: subtotal,
        taxCenti: 0,
        totalCenti: subtotal,
        status: "POSTED",
        postedAt: new Date(),
        notes: `From ${g.grnNumber}`,
        createdBy: user.id,
      } as never)
      .returning({ id: piTable.id, invoiceNumber: piTable.invoiceNumber });
    header = inserted[0];
  } catch (e) {
    return c.json({ error: "insert_failed", reason: errMsg(e) }, 500);
  }
  const h = header;

  const rows = lines.map((it) => ({
    purchaseInvoiceId: h.id,
    grnItemId: it.id,
    materialKind: it.materialKind,
    materialCode: it.materialCode,
    materialName: it.materialName,
    qty: it._remaining,
    unitPriceCenti: it.unitPriceCenti,
    lineTotalCenti: it._remaining * it.unitPriceCenti - discFor(it),
    itemGroup: it.itemGroup,
    description: it.description,
    description2: it.description2,
    uom: it.uom ?? "UNIT",
    variants: it.variants,
    gapInches: it.gapInches,
    divanHeightInches: it.divanHeightInches,
    divanPriceSen: it.divanPriceSen ?? 0,
    legHeightInches: it.legHeightInches,
    legPriceSen: it.legPriceSen ?? 0,
    customSpecials: it.customSpecials,
    lineSuffix: it.lineSuffix,
    specialOrderPriceSen: it.specialOrderPriceSen ?? 0,
    discountCenti: discFor(it),
  }));
  try {
    await db.insert(piItemsTable).values(rows as never);
  } catch (insErr) {
    await db.delete(piTable).where(eq(piTable.id, h.id));
    return c.json({ error: "items_insert_failed", reason: errMsg(insErr) }, 500);
  }

  {
    const over = await verifyGrnLinesNotOverInvoiced(db, lines.map((it) => it.id));
    if (over.length > 0) {
      await db.delete(piTable).where(eq(piTable.id, h.id));
      return c.json({ error: "qty_exceeds_remaining", lines: over }, 409);
    }
  }
  await recomputeGrnInvoiced(db, lines.map((it) => it.id));
  await recomputePiTotals(db, h.id);
  // Costing B (recostFromGrn) — not cloned. TODO when DO/SI land.
  return c.json({ id: h.id, invoiceNumber: h.invoiceNumber }, 201);
});

/* ════════════════════════════════════════════════════════════════════════
   PI PO-clone CRUD (PATCH header + line add / edit / delete) — mirrors the GRN
   detail page's immediate-save editing. The editable line quantity is qty;
   line_total_centi = qty * unit_price_centi - discount_centi; recomputePiTotals
   rolls the header (PI keeps the stored tax in total). PI is AP-only -> line
   delete needs no inventory release (that landed at GRN time).
   ════════════════════════════════════════════════════════════════════════ */

// ── PATCH /:id — header update ──
app.patch("/:id", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  for (const [from, to] of [
    ["supplierId", "supplierId"],
    ["supplierInvoiceRef", "supplierInvoiceRef"],
    ["invoiceDate", "invoiceDate"],
    ["dueDate", "dueDate"],
    ["currency", "currency"],
    ["notes", "notes"],
  ] as const) {
    if (body[from] !== undefined) updates[to] = body[from];
  }
  if (updates.currency !== undefined) updates.currency = String(updates.currency).toUpperCase();
  try {
    const updated = await db.update(piTable).set(updates).where(eq(piTable.id, id)).returning();
    if (!updated[0]) return c.json({ error: "not_found" }, 404);
    return c.json({ purchaseInvoice: toPiHeaderResponse(updated[0]) });
  } catch (e) {
    return c.json({ error: "update_failed", reason: errMsg(e) }, 500);
  }
});

// ── POST /:id/items — add one purchase_invoice_item. qty maps to qty. ──
app.post("/:id/items", async (c) => {
  const db = getDb(c.env);
  const piId = c.req.param("id");
  let it: Record<string, unknown>;
  try {
    it = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  if (!it.materialCode) return c.json({ error: "material_code_required" }, 400);
  if (!it.materialName) return c.json({ error: "material_name_required" }, 400);

  const lock = await piLocked(db, piId);
  if (lock) return c.json(lock, 409);

  const qty = Number(it.qty ?? 1);
  const unitPriceCenti = Number(it.unitPriceCenti ?? 0);
  const discountCenti = Number(it.discountCenti ?? 0);
  const lineTotal = qty * unitPriceCenti - discountCenti;

  // GRN-linked line: cap qty at that GRN line's remaining (accepted-invoiced-returned).
  const grnItemId = (it.grnItemId as string) ?? null;
  if (grnItemId) {
    const giRows = await db
      .select({ qtyAccepted: grnItemsTable.qtyAccepted, invoicedQty: grnItemsTable.invoicedQty, returnedQty: grnItemsTable.returnedQty })
      .from(grnItemsTable)
      .where(eq(grnItemsTable.id, grnItemId))
      .limit(1);
    const g = giRows[0];
    if (g) {
      const remaining = (g.qtyAccepted ?? 0) - (g.invoicedQty ?? 0) - (g.returnedQty ?? 0);
      if (qty > remaining) return c.json({ error: "qty_exceeds_remaining", requested: qty, remaining }, 409);
    }
  }

  const row = {
    purchaseInvoiceId: piId,
    grnItemId,
    materialKind: ((it.materialKind as string) ?? "mfg_product") as "mfg_product" | "fabric" | "raw",
    materialCode: it.materialCode as string,
    materialName: it.materialName as string,
    qty,
    unitPriceCenti,
    discountCenti,
    lineTotalCenti: lineTotal,
    unitCostCenti: Number(it.unitCostCenti ?? 0),
    notes: (it.notes as string) ?? null,
    gapInches: (it.gapInches as number) ?? null,
    divanHeightInches: (it.divanHeightInches as number) ?? null,
    divanPriceSen: Number(it.divanPriceSen ?? 0),
    legHeightInches: (it.legHeightInches as number) ?? null,
    legPriceSen: Number(it.legPriceSen ?? 0),
    customSpecials: (it.customSpecials as unknown) ?? null,
    lineSuffix: (it.lineSuffix as string) ?? null,
    specialOrderPriceSen: Number(it.specialOrderPriceSen ?? 0),
    variants: (it.variants as unknown) ?? null,
    itemGroup: (it.itemGroup as string) ?? null,
    description: (it.description as string) ?? null,
    // description2 server-owned in 2990s via buildVariantSummary (dropped per
    // Strategy-2) — pass the client value through.
    description2: (it.description2 as string) ?? null,
    uom: (it.uom as string) ?? "UNIT",
  };
  let inserted: typeof piItemsTable.$inferSelect;
  try {
    const ins = await db.insert(piItemsTable).values(row as never).returning();
    inserted = ins[0];
  } catch (e) {
    return c.json({ error: "insert_failed", reason: errMsg(e) }, 500);
  }

  /* POST-INSERT over-invoice verification (race guard). If our insert broke the
     cap (accepted - returned), delete it + 409. */
  if (grnItemId) {
    const giRows = await db.select({ qtyAccepted: grnItemsTable.qtyAccepted, returnedQty: grnItemsTable.returnedQty }).from(grnItemsTable).where(eq(grnItemsTable.id, grnItemId)).limit(1);
    const g = giRows[0];
    if (g) {
      const cap = (g.qtyAccepted ?? 0) - (g.returnedQty ?? 0);
      const sibRows = await db.select({ qty: piItemsTable.qty, purchaseInvoiceId: piItemsTable.purchaseInvoiceId }).from(piItemsTable).where(eq(piItemsTable.grnItemId, grnItemId));
      const piIds = [...new Set(sibRows.map((r) => r.purchaseInvoiceId))];
      const cancelled = new Set<string>();
      if (piIds.length > 0) {
        const pis = await db.select({ id: piTable.id, status: piTable.status }).from(piTable).where(inArray(piTable.id, piIds));
        for (const p of pis) if (p.status === "CANCELLED") cancelled.add(p.id);
      }
      const liveInvoiced = sibRows.filter((r) => !cancelled.has(r.purchaseInvoiceId)).reduce((s, r) => s + Number(r.qty ?? 0), 0);
      if (liveInvoiced > cap && inserted?.id) {
        await db.delete(piItemsTable).where(eq(piItemsTable.id, inserted.id));
        return c.json({ error: "qty_exceeds_remaining", requested: qty, remaining: cap - (liveInvoiced - qty) }, 409);
      }
    }
  }

  if (grnItemId) await recomputeGrnInvoiced(db, [grnItemId]);
  await recomputePiTotals(db, piId);
  // Costing B (recostForPi) — not cloned. TODO when DO/SI land.
  return c.json({ item: toPiItemResponse(inserted) }, 201);
});

// ── PATCH /:id/items/:itemId — partial line update. ──
app.patch("/:id/items/:itemId", async (c) => {
  const db = getDb(c.env);
  const piId = c.req.param("id");
  const itemId = c.req.param("itemId");
  let it: Record<string, unknown>;
  try {
    it = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const lock = await piLocked(db, piId);
  if (lock) return c.json(lock, 409);

  /* Scope the line to THIS PI: a mismatched itemId must 404, not edit another
     PI's line while the recompute runs against this one. */
  const prevRows = await db
    .select({ qty: piItemsTable.qty, unitPriceCenti: piItemsTable.unitPriceCenti, discountCenti: piItemsTable.discountCenti, itemGroup: piItemsTable.itemGroup, variants: piItemsTable.variants, grnItemId: piItemsTable.grnItemId })
    .from(piItemsTable)
    .where(and(eq(piItemsTable.id, itemId), eq(piItemsTable.purchaseInvoiceId, piId)))
    .limit(1);
  const prev = prevRows[0];
  if (!prev) return c.json({ error: "not_found" }, 404);

  const prevQty = prev.qty;
  const grnItemId = prev.grnItemId ?? null;
  const qty = it.qty !== undefined ? Number(it.qty) : prevQty;
  const unit = it.unitPriceCenti !== undefined ? Number(it.unitPriceCenti) : prev.unitPriceCenti;
  const discount = it.discountCenti !== undefined ? Number(it.discountCenti) : prev.discountCenti ?? 0;
  const lineTotal = qty * unit - discount;

  const updates: Record<string, unknown> = { qty, unitPriceCenti: unit, discountCenti: discount, lineTotalCenti: lineTotal };
  for (const [from, to] of [
    ["materialCode", "materialCode"],
    ["materialName", "materialName"],
    ["itemGroup", "itemGroup"],
    ["description", "description"],
    ["uom", "uom"],
    ["unitCostCenti", "unitCostCenti"],
    ["notes", "notes"],
    ["gapInches", "gapInches"],
    ["divanHeightInches", "divanHeightInches"],
    ["divanPriceSen", "divanPriceSen"],
    ["legHeightInches", "legHeightInches"],
    ["legPriceSen", "legPriceSen"],
    ["customSpecials", "customSpecials"],
    ["lineSuffix", "lineSuffix"],
    ["specialOrderPriceSen", "specialOrderPriceSen"],
    ["variants", "variants"],
    ["description2", "description2"],
  ] as const) {
    if (it[from] !== undefined) updates[to] = it[from];
  }
  /* description2 server-owned in 2990s via buildVariantSummary (dropped per
     Strategy-2). It is whatever the client sends (handled above), else stored
     value untouched. */

  // GRN-linked + qty changed: pre-check the delta won't push the GRN line over
  // its accepted (headroom = accepted - returned - (invoiced - prevQty)).
  const delta = qty - prevQty;
  if (grnItemId && delta !== 0) {
    const giRows = await db.select({ qtyAccepted: grnItemsTable.qtyAccepted, invoicedQty: grnItemsTable.invoicedQty, returnedQty: grnItemsTable.returnedQty }).from(grnItemsTable).where(eq(grnItemsTable.id, grnItemId)).limit(1);
    const g = giRows[0];
    if (g) {
      const headroom = (g.qtyAccepted ?? 0) - (g.returnedQty ?? 0) - ((g.invoicedQty ?? 0) - prevQty);
      if (qty > headroom) return c.json({ error: "qty_exceeds_remaining", requested: qty, remaining: headroom }, 409);
    }
  }

  try {
    await db.update(piItemsTable).set(updates).where(eq(piItemsTable.id, itemId));
  } catch (e) {
    return c.json({ error: "update_failed", reason: errMsg(e) }, 500);
  }
  if (grnItemId) await recomputeGrnInvoiced(db, [grnItemId]);
  await recomputePiTotals(db, piId);
  /* Costing B (recostForPi) + AP->GL resync are not cloned (Houzs GL differs;
     DO/SI chain pending). TODO when those land. */
  return c.json({ ok: true });
});

// ── DELETE /:id/items/:itemId — remove a line + recompute header. ──
app.delete("/:id/items/:itemId", async (c) => {
  const db = getDb(c.env);
  const piId = c.req.param("id");
  const itemId = c.req.param("itemId");
  const lock = await piLocked(db, piId);
  if (lock) return c.json(lock, 409);

  const lineRows = await db
    .select({ qty: piItemsTable.qty, grnItemId: piItemsTable.grnItemId })
    .from(piItemsTable)
    .where(and(eq(piItemsTable.id, itemId), eq(piItemsTable.purchaseInvoiceId, piId)))
    .limit(1);
  const line = lineRows[0];
  if (!line) return c.json({ error: "not_found" }, 404);
  try {
    await db.delete(piItemsTable).where(eq(piItemsTable.id, itemId));
  } catch (e) {
    return c.json({ error: "delete_failed", reason: errMsg(e) }, 500);
  }
  // Release: recount invoiced_qty from live PI lines — the deleted line drops out.
  if (line.grnItemId) await recomputeGrnInvoiced(db, [line.grnItemId]);
  await recomputePiTotals(db, piId);
  /* Costing B (recostFromGrn) + AP->GL resync are not cloned. TODO when those land. */
  return c.body(null, 204);
});

export default app;
