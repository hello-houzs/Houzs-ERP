// ----------------------------------------------------------------------------
// /grns — Goods Receipt Notes (procurement receiving step). PO -> GRN ->
// Purchase Invoice. On POST, qty_received rolls up to PO items + an inventory IN
// movement is written (FIFO trigger, migration 0026).
//
// 1:1 clone of 2990s apps/api/src/routes/grns.ts. Endpoints, request bodies,
// response JSON shapes, status codes and business rules (POSTED-on-create,
// over-receipt guards + post-insert verification, received_qty live-recount, PO
// status re-evaluation, child-lock on PI/PR, downstream-consumption guard,
// cancel + reverse, line CRUD with inventory deltas, warehouse relocation) are
// kept identical to 2990s. Only the SEAMS change:
//   - DB client: 2990s per-request createClient / c.get('supabase') -> Houzs
//     getDb (rule #3). Every PostgREST chain -> a Drizzle query, same JSON
//     in/out. Drizzle returns camelCase rows; the wire shapes keep 2990s's
//     snake_case via the *Response() mappers (rule #7).
//   - Auth: 2990s supabaseAuth -> Houzs requirePermission("*") (rule #4).
//   - user.id: 2990s staff.id (uuid) -> Houzs users.id (integer) (rule #4).
//   - Mount path: /api/grns.
//   - Inventory writes go through the shared lib/inventory-movements helpers
//     (writeMovements / defaultWarehouseId), exactly where 2990s used them.
//
// Strategy-2 product-layer simplifications (Houzs is not the 2990s furniture
// business; owner enters own data — see docs/scm-clone/PLAN.md):
//   - DROPPED the furniture formatters: buildVariantSummary (description2 is
//     server-owned in 2990s via that sofa formatter) -> the client's description2
//     is passed through (Houzs materials have no item_group). The variant columns
//     are still persisted for fidelity. computeVariantKey is the generic shared
//     one (returns '' for Houzs materials -> one bucket per product_code).
//   - DROPPED recostFromGrn (furniture cost-roll engine) + recomputeSoStock
//     Allocation (SO slice not cloned). The call sites are removed; a // TODO
//     marks where they re-attach when those slices land. The rack placement
//     (grn-rack-sync) IS ported.
//   - inventory_balances is read by the downstream-consumption guard
//     (grnReverseWouldGoNegative); that VIEW is product-table-free and was
//     created in migration 0026, so the guard works fully.
//
// Endpoints (same as 2990s):
//   GET    /grns                       — list (status / supplierId filters)
//   GET    /grns/outstanding-po-items   — PO lines with remaining qty (picker)
//   GET    /grns/:id                   — detail (header + items + per-line source PO)
//   GET    /grns/:id/linked            — Smart Buttons: parent PO + PIs + PRs
//   POST   /grns                       — create POSTED GRN (manual / single / multi)
//   POST   /grns/from-pos              — batch-convert many POs into ONE GRN
//   PATCH  /grns/:id/post              — idempotent no-op (POSTED-on-create)
//   POST   /grns/from-po-items         — multi-select line-level GRN creator
//   PATCH  /grns/:id/cancel            — cancel + reverse receipt
//   PATCH  /grns/:id                   — header update (+ warehouse relocation)
//   POST   /grns/:id/items             — add line (+ inventory IN)
//   PATCH  /grns/:id/items/:itemId     — edit line (+ inventory delta)
//   DELETE /grns/:id/items/:itemId     — delete line (+ reverse receipt)
// ----------------------------------------------------------------------------

import { Hono } from "hono";
import { and, asc, desc, eq, inArray, like, ne, sql } from "drizzle-orm";
import type { Env } from "../types";
import { getDb } from "../db/client";
import {
  grns as grnsTable,
  grnItems as grnItemsTable,
  purchaseOrders as poTable,
  purchaseOrderItems as poItemsTable,
  suppliers as suppliersTable,
} from "../db/schema";
import { requirePermission } from "../middleware/auth";
import { writeMovements, defaultWarehouseId } from "../lib/inventory-movements";
import { computeVariantKey, type VariantAttrs } from "@shared/index";

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

/* ── Migration 0120 — resolve the production batch (source PO number) for each
   GRN line, keyed by purchase_order_item_id. A GRN can aggregate lines from
   several POs (the add-PO picker), so we resolve PER LINE, not off the GRN
   header. Lines with no PO link (free GRN) get no batch. The IN movement carries
   batch_no -> the FIFO trigger stamps it on the lot, so a sofa set's components
   share a batch and Stage 3 can ship the whole set from one dye lot. */
export async function resolvePoBatchByItem(
  db: Db,
  poItemIds: Array<string | null>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(poItemIds.filter((x): x is string => !!x))];
  if (ids.length === 0) return out;
  const poi = await db
    .select({ id: poItemsTable.id, purchaseOrderId: poItemsTable.purchaseOrderId })
    .from(poItemsTable)
    .where(inArray(poItemsTable.id, ids));
  const poIds = [...new Set(poi.map((r) => r.purchaseOrderId).filter((x): x is string => !!x))];
  if (poIds.length === 0) return out;
  const pos = await db
    .select({ id: poTable.id, poNumber: poTable.poNumber })
    .from(poTable)
    .where(inArray(poTable.id, poIds));
  const poNo = new Map<string, string>();
  for (const p of pos) poNo.set(p.id, p.poNumber);
  for (const r of poi) {
    const n = r.purchaseOrderId ? poNo.get(r.purchaseOrderId) : undefined;
    if (n) out.set(r.id, n);
  }
  return out;
}

/* ── Shared helper: post a GRN, roll up to PO items, write inventory IN ──
   Pulled out so both single-doc post and the multi-PO `/from-po-items` route can
   reuse the same logic. Best-effort inventory write (matches /post behaviour). */
async function postGrnAndRollup(
  db: Db,
  grnId: string,
  userId: number,
): Promise<{ ok: true } | { ok: false; reason: string; status?: number }> {
  const grnHeaderRows = await db
    .select({ grnNumber: grnsTable.grnNumber, warehouseId: grnsTable.warehouseId })
    .from(grnsTable)
    .where(eq(grnsTable.id, grnId))
    .limit(1);
  const grnHeader = grnHeaderRows[0] ?? null;
  const items = await db
    .select({
      purchaseOrderItemId: grnItemsTable.purchaseOrderItemId,
      qtyAccepted: grnItemsTable.qtyAccepted,
      materialCode: grnItemsTable.materialCode,
      materialName: grnItemsTable.materialName,
      unitPriceCenti: grnItemsTable.unitPriceCenti,
      itemGroup: grnItemsTable.itemGroup,
      variants: grnItemsTable.variants,
    })
    .from(grnItemsTable)
    .where(eq(grnItemsTable.grnId, grnId));

  // Recount received_qty + re-evaluate PO status from live GRN lines.
  const touchedPoItemIds = items.map((it) => it.purchaseOrderItemId);
  await recomputePoReceived(db, touchedPoItemIds);

  // PR-DRAFT-removal — GRNs are created as POSTED directly. Idempotent: matches
  // any non-CLOSED status. Returns ok:true when posted_at is in place.
  let posted: { id: string } | undefined;
  try {
    const updated = await db
      .update(grnsTable)
      .set({ status: "POSTED", postedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(grnsTable.id, grnId), ne(grnsTable.status, "CLOSED")))
      .returning({ id: grnsTable.id });
    posted = updated[0];
  } catch (e) {
    return { ok: false, reason: errMsg(e), status: 500 };
  }
  if (!posted) return { ok: false, reason: "cannot_post", status: 409 };

  // ── Inventory IN per item — best effort, doesn't roll back the post. ─
  const grnNo = grnHeader?.grnNumber ?? grnId;
  const warehouseId = grnHeader?.warehouseId ?? (await defaultWarehouseId(db));
  if (warehouseId && items.length > 0) {
    // Migration 0120 — stamp each IN with its source PO number as the batch.
    const batchByItem = await resolvePoBatchByItem(db, items.map((it) => it.purchaseOrderItemId));
    const movements = items
      .filter((it) => (it.qtyAccepted ?? 0) > 0)
      .map((it) => ({
        movement_type: "IN" as const,
        warehouse_id: warehouseId,
        product_code: it.materialCode,
        // Bucket received stock by its attribute composition (migration 0095).
        variant_key: computeVariantKey(it.itemGroup, (it.variants as VariantAttrs | null) ?? null),
        product_name: it.materialName,
        qty: it.qtyAccepted,
        unit_cost_sen: Number(it.unitPriceCenti ?? 0),
        source_doc_type: "GRN" as const,
        source_doc_id: grnId,
        source_doc_no: grnNo,
        // Production batch = source PO number (migration 0120). NULL for free GRNs.
        batch_no: it.purchaseOrderItemId ? (batchByItem.get(it.purchaseOrderItemId) ?? null) : null,
        performed_by: userId,
      }));
    if (movements.length > 0) await writeMovements(db, movements);
  }
  /* Physical rack placement — lines that chose a rack on the GRN form get placed
     onto that rack (separate ledger). Best-effort. */
  try {
    const { placeGrnLinesOnRacks } = await import("../lib/grn-rack-sync");
    await placeGrnLinesOnRacks(db, grnId, grnNo, userId);
  } catch (e) {
    console.error("[grn-rack] place failed:", e);
  }
  /* SO auto-allocation (SO slice not cloned per Strategy-2) — was a re-walk of
     PENDING SO lines after new stock arrived. No-op here.
     TODO: recomputeSoStockAllocation(db) when the SO slice lands. */
  return { ok: true };
}

// ── grn_status column-set for the header response (mirrors 2990s HEADER) ──
function toGrnHeaderResponse(g: typeof grnsTable.$inferSelect) {
  return {
    id: g.id,
    grn_number: g.grnNumber,
    purchase_order_id: g.purchaseOrderId,
    supplier_id: g.supplierId,
    warehouse_id: g.warehouseId,
    received_at: g.receivedAt,
    delivery_note_ref: g.deliveryNoteRef,
    status: g.status,
    notes: g.notes,
    currency: g.currency,
    subtotal_centi: g.subtotalCenti,
    tax_centi: g.taxCenti,
    total_centi: g.totalCenti,
    posted_at: isoOrNull(g.postedAt),
    created_at: isoOrNull(g.createdAt),
    created_by: g.createdBy,
    updated_at: isoOrNull(g.updatedAt),
  };
}

function toGrnItemResponse(it: typeof grnItemsTable.$inferSelect) {
  return {
    id: it.id,
    grn_id: it.grnId,
    purchase_order_item_id: it.purchaseOrderItemId,
    material_kind: it.materialKind,
    material_code: it.materialCode,
    material_name: it.materialName,
    supplier_sku: it.supplierSku,
    qty_received: it.qtyReceived,
    qty_accepted: it.qtyAccepted,
    qty_rejected: it.qtyRejected,
    rejection_reason: it.rejectionReason,
    unit_price_centi: it.unitPriceCenti,
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
    line_total_centi: it.lineTotalCenti,
    delivery_date: it.deliveryDate,
    unit_cost_centi: it.unitCostCenti,
    invoiced_qty: it.invoicedQty,
    returned_qty: it.returnedQty,
    rack_id: it.rackId,
    created_at: isoOrNull(it.createdAt),
  };
}

const nextNumber = async (db: Db, prefix: string): Promise<string> => {
  const d = new Date();
  const yymm = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, "0")}`;
  const rows = await db
    .select({ id: grnsTable.id })
    .from(grnsTable)
    .where(like(grnsTable.grnNumber, `${prefix}-${yymm}-%`));
  return `${prefix}-${yymm}-${String(rows.length + 1).padStart(3, "0")}`;
};

/* ── Recompute GRN header money rollups (migration 0101) ──────────────────
   sum line_total_centi across grn_items -> write subtotal_centi + total_centi on
   the grns header. GRN carries no tax, so total = subtotal. */
async function recomputeGrnTotals(db: Db, grnId: string) {
  const items = await db
    .select({ lineTotalCenti: grnItemsTable.lineTotalCenti })
    .from(grnItemsTable)
    .where(eq(grnItemsTable.grnId, grnId));
  const subtotal = items.reduce((s, r) => s + (r.lineTotalCenti ?? 0), 0);
  await db
    .update(grnsTable)
    .set({ subtotalCenti: subtotal, totalCenti: subtotal, updatedAt: new Date() })
    .where(eq(grnsTable.id, grnId));
}

/* ── Post-insert over-receipt verification for BULK GRN creates ────────────
   The bulk create paths only PRE-check remaining qty before insert — a read-then-
   write race lets two concurrent receives both pass and over-receive a PO line.
   After the GRN's lines are committed, re-sum the LIVE qty_accepted across all
   non-cancelled GRN lines per affected PO line; if any now exceeds the PO line's
   qty, THIS GRN broke the cap -> delete the whole GRN + signal a 409. */
async function verifyGrnOverReceipt(
  db: Db,
  grnId: string,
  poItemIds: Array<string | null | undefined>,
): Promise<{ poItemId: string; requested: number; remaining: number } | null> {
  const ids = [...new Set(poItemIds.filter((x): x is string => Boolean(x)))];
  if (ids.length === 0) return null;
  try {
    // PO line caps.
    const poItems = await db
      .select({ id: poItemsTable.id, qty: poItemsTable.qty })
      .from(poItemsTable)
      .where(inArray(poItemsTable.id, ids));
    const capById = new Map<string, number>(poItems.map((r) => [r.id, r.qty ?? 0]));
    // Live accepted per PO line across all non-cancelled GRN lines.
    const sibRows = await db
      .select({
        purchaseOrderItemId: grnItemsTable.purchaseOrderItemId,
        qtyAccepted: grnItemsTable.qtyAccepted,
        grnId: grnItemsTable.grnId,
      })
      .from(grnItemsTable)
      .where(inArray(grnItemsTable.purchaseOrderItemId, ids));
    const grnIds = [...new Set(sibRows.map((r) => r.grnId).filter(Boolean))];
    const cancelled = new Set<string>();
    if (grnIds.length > 0) {
      const gs = await db
        .select({ id: grnsTable.id, status: grnsTable.status })
        .from(grnsTable)
        .where(inArray(grnsTable.id, grnIds));
      for (const g of gs) if (g.status === "CANCELLED") cancelled.add(g.id);
    }
    // This GRN's own contribution per PO line — what we'd give back on rollback.
    const liveByPoi = new Map<string, number>();
    const thisGrnByPoi = new Map<string, number>();
    for (const r of sibRows) {
      if (!r.purchaseOrderItemId || cancelled.has(r.grnId)) continue;
      const q = Number(r.qtyAccepted ?? 0);
      liveByPoi.set(r.purchaseOrderItemId, (liveByPoi.get(r.purchaseOrderItemId) ?? 0) + q);
      if (r.grnId === grnId) thisGrnByPoi.set(r.purchaseOrderItemId, (thisGrnByPoi.get(r.purchaseOrderItemId) ?? 0) + q);
    }
    for (const poiId of ids) {
      const cap = capById.get(poiId) ?? 0;
      const live = liveByPoi.get(poiId) ?? 0;
      if (live > cap) {
        const mine = thisGrnByPoi.get(poiId) ?? 0;
        return { poItemId: poiId, requested: mine, remaining: cap - (live - mine) };
      }
    }
    return null;
  } catch {
    // Best-effort: a verification read failure must not block the receipt.
    return null;
  }
}

/* ── Self-heal PO receipt counter (live-count model) ────────────────────────
   For each given purchase_order_item, RECOUNT received_qty as the sum of
   qty_accepted across ALL live (non-cancelled) GRN lines that point at it, net of
   returned_qty, then re-evaluate the parent PO's status. Never resurrects a
   CANCELLED PO. Best-effort. */
export async function recomputePoReceived(db: Db, poItemIds: Array<string | null | undefined>) {
  const ids = [...new Set(poItemIds.filter((x): x is string => Boolean(x)))];
  if (ids.length === 0) return;

  try {
    // 1. Recount received_qty per PO item from live GRN lines, net of returns.
    const glines = await db
      .select({
        purchaseOrderItemId: grnItemsTable.purchaseOrderItemId,
        qtyAccepted: grnItemsTable.qtyAccepted,
        returnedQty: grnItemsTable.returnedQty,
        grnId: grnItemsTable.grnId,
      })
      .from(grnItemsTable)
      .where(inArray(grnItemsTable.purchaseOrderItemId, ids));
    const grnIds = [...new Set(glines.map((r) => r.grnId).filter(Boolean))];
    const cancelled = new Set<string>();
    if (grnIds.length > 0) {
      const gs = await db
        .select({ id: grnsTable.id, status: grnsTable.status })
        .from(grnsTable)
        .where(inArray(grnsTable.id, grnIds));
      for (const g of gs) if (g.status === "CANCELLED") cancelled.add(g.id);
    }
    const recvByPoi = new Map<string, number>(ids.map((id) => [id, 0]));
    for (const r of glines) {
      if (!r.purchaseOrderItemId || cancelled.has(r.grnId)) continue;
      const net = Number(r.qtyAccepted ?? 0) - Number(r.returnedQty ?? 0);
      recvByPoi.set(r.purchaseOrderItemId, (recvByPoi.get(r.purchaseOrderItemId) ?? 0) + Math.max(0, net));
    }
    await Promise.all(
      [...recvByPoi.entries()].map(([poiId, recv]) =>
        db.update(poItemsTable).set({ receivedQty: recv }).where(eq(poItemsTable.id, poiId)),
      ),
    );

    // 2. Re-evaluate each touched PO's status from its (now-recounted) lines.
    const poiRows = await db
      .select({ purchaseOrderId: poItemsTable.purchaseOrderId })
      .from(poItemsTable)
      .where(inArray(poItemsTable.id, ids));
    const poIds = [...new Set(poiRows.map((r) => r.purchaseOrderId).filter(Boolean))];
    for (const poId of poIds) {
      const ll = await db
        .select({ qty: poItemsTable.qty, receivedQty: poItemsTable.receivedQty })
        .from(poItemsTable)
        .where(eq(poItemsTable.purchaseOrderId, poId));
      if (ll.length === 0) continue;
      const anyReceived = ll.some((l) => (l.receivedQty ?? 0) > 0);
      const fully = ll.every((l) => (l.receivedQty ?? 0) >= l.qty);
      const newStatus = fully ? "RECEIVED" : anyReceived ? "PARTIALLY_RECEIVED" : "SUBMITTED";
      const headRows = await db
        .select({ receivedAt: poTable.receivedAt })
        .from(poTable)
        .where(eq(poTable.id, poId))
        .limit(1);
      const prevReceivedAt = headRows[0]?.receivedAt ?? null;
      const patch: Record<string, unknown> = { status: newStatus, updatedAt: new Date() };
      // Stamp received_at on first full receipt, preserve if set, clear on regression.
      patch.receivedAt = fully ? (prevReceivedAt ?? new Date()) : null;
      await db.update(poTable).set(patch).where(and(eq(poTable.id, poId), ne(poTable.status, "CANCELLED")));
    }
  } catch (e) {
    console.error("[recomputePoReceived] best-effort recount failed", { poItemIds: ids, error: e });
  }
}

/* ── GRN child-lock guard (migration 0106) ─────────────────────────────────
   A GRN locks (read-only) once ANY line has a downstream child: invoiced_qty > 0
   OR returned_qty > 0 (a PI or PR line is drawn from it). The PI/PR slices that
   WRITE these counters land later; this READS them. */
async function grnHasDownstream(db: Db, grnId: string): Promise<{ error: string; message: string } | null> {
  const data = await db
    .select({ invoicedQty: grnItemsTable.invoicedQty, returnedQty: grnItemsTable.returnedQty })
    .from(grnItemsTable)
    .where(eq(grnItemsTable.grnId, grnId));
  const any = data.some((r) => (r.invoicedQty ?? 0) > 0 || (r.returnedQty ?? 0) > 0);
  if (any) return { error: "grn_has_downstream", message: "GRN has a Purchase Invoice / Return — delete it first to edit" };
  return null;
}

/* ── Downstream-consumption guard (bug #2) ─────────────────────────────────
   Reversing a GRN receipt writes an inventory OUT per line. The FIFO trigger
   ALLOWS negative stock, so if the received goods were ALREADY consumed
   downstream, that reversing OUT eats some OTHER lot's batch -> negative stock +
   wrong COGS. This checks, per (warehouse, product, variant) bucket, whether the
   CURRENT on-hand (inventory_balances) still covers the qty we're about to
   reverse out. Best-effort read: if the balance query errors we DON'T block. */
async function grnReverseWouldGoNegative(
  db: Db,
  warehouseId: string | null,
  lines: Array<{ qty_accepted: number; material_code: string; item_group?: string | null; variants?: VariantAttrs | null }>,
): Promise<{ error: string; message: string } | null> {
  if (!warehouseId) return null;
  const needByBucket = new Map<string, { product_code: string; variant_key: string; need: number }>();
  for (const l of lines) {
    const qty = Number(l.qty_accepted ?? 0);
    if (qty <= 0) continue;
    const variant_key = computeVariantKey(l.item_group, l.variants ?? null);
    const k = `${l.material_code}::${variant_key}`;
    const cur = needByBucket.get(k) ?? { product_code: l.material_code, variant_key, need: 0 };
    cur.need += qty;
    needByBucket.set(k, cur);
  }
  if (needByBucket.size === 0) return null;

  const productCodes = [...new Set([...needByBucket.values()].map((b) => b.product_code))];
  // inventory_balances is a VIEW (migration 0026), not a Drizzle table -> read it
  // with db.execute(sql`...`), exactly like routes/inventory.ts does. The product
  // codes go through sql.join so they're parameterised (no string interpolation).
  let balRows: Array<{ product_code: string; variant_key: string | null; qty: number | null }>;
  try {
    balRows = await db.execute<{ product_code: string; variant_key: string | null; qty: number | null }>(
      sql`SELECT product_code, variant_key, qty FROM inventory_balances
          WHERE warehouse_id = ${warehouseId}
          AND product_code IN (${sql.join(productCodes.map((p) => sql`${p}`), sql`, `)})`,
    );
  } catch {
    return null; // best-effort: don't block on a balance read failure
  }
  const onHand = new Map<string, number>();
  for (const r of balRows) onHand.set(`${r.product_code}::${r.variant_key ?? ""}`, Number(r.qty ?? 0));
  for (const [k, b] of needByBucket) {
    const have = onHand.get(k) ?? 0;
    if (have < b.need) {
      return {
        error: "grn_consumed_downstream",
        message: "Received goods were already consumed downstream (shipped / used in production) — cannot reverse this GRN. Make a Purchase Return instead.",
      };
    }
  }
  return null;
}

/* ── Per-GRN consumption flags (migration 0106) ────────────────────────────
   has_children (any line invoiced_qty>0 or returned_qty>0), fully_invoiced
   (every accepted line invoiced_qty >= qty_accepted), fully_returned (likewise).
   A line with qty_accepted = 0 is treated as already satisfied. */
function computeGrnFlags(items: Array<{ qty_accepted?: number | null; invoiced_qty?: number | null; returned_qty?: number | null }>) {
  const accepted = items.filter((r) => (r.qty_accepted ?? 0) > 0);
  const hasChildren = items.some((r) => (r.invoiced_qty ?? 0) > 0 || (r.returned_qty ?? 0) > 0);
  const fullyInvoiced = accepted.length > 0 && accepted.every((r) => (r.invoiced_qty ?? 0) >= (r.qty_accepted ?? 0));
  const fullyReturned = accepted.length > 0 && accepted.every((r) => (r.returned_qty ?? 0) >= (r.qty_accepted ?? 0));
  return { has_children: hasChildren, fully_invoiced: fullyInvoiced, fully_returned: fullyReturned };
}

// ── List ────────────────────────────────────────────────────────────────
app.get("/", async (c) => {
  const db = getDb(c.env);
  const status = c.req.query("status");
  const supplierId = c.req.query("supplierId");

  const conds = [];
  if (status) conds.push(eq(grnsTable.status, status as "POSTED" | "CLOSED" | "CANCELLED"));
  if (supplierId) conds.push(eq(grnsTable.supplierId, supplierId));

  try {
    const headerRows = await db
      .select({
        grn: grnsTable,
        supplier: { id: suppliersTable.id, code: suppliersTable.code, name: suppliersTable.name },
        purchase_order: { id: poTable.id, po_number: poTable.poNumber },
      })
      .from(grnsTable)
      .leftJoin(suppliersTable, eq(grnsTable.supplierId, suppliersTable.id))
      .leftJoin(poTable, eq(grnsTable.purchaseOrderId, poTable.id))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(grnsTable.receivedAt));

    const ids = headerRows.map((r) => r.grn.id);
    // Migration 0106 — collect each GRN's lines for the lock/convert flags.
    const linesByGrn = new Map<string, Array<{ qty_accepted: number | null; invoiced_qty: number | null; returned_qty: number | null }>>();
    if (ids.length > 0) {
      const lineRows = await db
        .select({
          grnId: grnItemsTable.grnId,
          qtyAccepted: grnItemsTable.qtyAccepted,
          invoicedQty: grnItemsTable.invoicedQty,
          returnedQty: grnItemsTable.returnedQty,
        })
        .from(grnItemsTable)
        .where(inArray(grnItemsTable.grnId, ids));
      for (const li of lineRows) {
        const arr = linesByGrn.get(li.grnId) ?? [];
        arr.push({ qty_accepted: li.qtyAccepted, invoiced_qty: li.invoicedQty, returned_qty: li.returnedQty });
        linesByGrn.set(li.grnId, arr);
      }
    }
    const grns = headerRows.map((r) => ({
      ...toGrnHeaderResponse(r.grn),
      supplier: r.supplier?.id ? r.supplier : null,
      purchase_order: r.purchase_order?.id ? r.purchase_order : null,
      // Stored header total (= Σ qty*unit − discount). Falls back to 0 if unset.
      total_centi: r.grn.totalCenti ?? 0,
      ...computeGrnFlags(linesByGrn.get(r.grn.id) ?? []),
    }));
    return c.json({ grns });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

/* ── GET /outstanding-po-items ──────────────────────────────────────────
   A flat list of PO line items with remaining qty > 0. Used by the multi-select
   "GRN from POs (line-level)" picker.
     - parent PO status must be SUBMITTED or PARTIALLY_RECEIVED
     - line item must have qty - received_qty > 0
     - limit 500
   IMPORTANT (route ordering): this STATIC path MUST be registered before `/:id`
   below — else Hono matches `/:id` first and tries to cast it to a uuid. */
app.get("/outstanding-po-items", async (c) => {
  const db = getDb(c.env);
  try {
    const rows = await db
      .select({
        item: poItemsTable,
        po: {
          id: poTable.id,
          po_number: poTable.poNumber,
          supplier_id: poTable.supplierId,
          status: poTable.status,
          po_date: poTable.poDate,
          expected_at: poTable.expectedAt,
          purchase_location_id: poTable.purchaseLocationId,
        },
        supplier: { code: suppliersTable.code, name: suppliersTable.name },
      })
      .from(poItemsTable)
      .innerJoin(poTable, eq(poItemsTable.purchaseOrderId, poTable.id))
      .leftJoin(suppliersTable, eq(poTable.supplierId, suppliersTable.id))
      .orderBy(desc(poItemsTable.purchaseOrderId))
      .limit(500);

    const eligible = rows
      .filter((r) => r.po.status === "SUBMITTED" || r.po.status === "PARTIALLY_RECEIVED")
      .filter((r) => r.item.qty - (r.item.receivedQty ?? 0) > 0);

    /* Warehouse-lock — the warehouse a PO line ships into is the LINE's own
       warehouse_id when set, falling back to the PO header's purchase_location_id
       (the per-line warehouse OVERRIDES the header). The GRN's warehouse_id is set
       from this same effective value at create time. */
    const effWh = (r: (typeof eligible)[number]): string | null =>
      r.item.warehouseId ?? r.po.purchase_location_id ?? null;

    const outstanding = eligible.map((r) => {
      const effWhId = effWh(r);
      return {
        poItemId: r.item.id,
        poId: r.po.id,
        poDocNo: r.po.po_number,
        itemCode: r.item.materialCode,
        description: r.item.description ?? r.item.materialName,
        itemGroup: r.item.itemGroup ?? "",
        qty: r.item.qty,
        receivedQty: r.item.receivedQty ?? 0,
        remainingQty: r.item.qty - (r.item.receivedQty ?? 0),
        unitPriceCenti: r.item.unitPriceCenti,
        warehouseId: r.item.warehouseId,
        variants: r.item.variants,
        deliveryDate: r.item.deliveryDate ?? null,
        supplierId: r.po.supplier_id,
        supplierCode: r.supplier?.code ?? "",
        supplierName: r.supplier?.name ?? "",
        poDate: r.po.po_date,
        expectedAt: r.po.expected_at,
        // The line's EFFECTIVE ship-into warehouse. One warehouse per GRN.
        // SEAM: warehouse code/name resolution dropped (Houzs has no cloned
        // warehouse-by-id name lookup wired here; the inventory warehouse route
        // serves it). The id is enough for the picker's lock.
        warehouseLocationId: effWhId,
        warehouseLocationCode: null as string | null,
        warehouseLocationName: null as string | null,
      };
    });

    return c.json({ items: outstanding });
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
          grn: grnsTable,
          supplier: { id: suppliersTable.id, code: suppliersTable.code, name: suppliersTable.name },
          purchase_order: { id: poTable.id, po_number: poTable.poNumber },
        })
        .from(grnsTable)
        .leftJoin(suppliersTable, eq(grnsTable.supplierId, suppliersTable.id))
        .leftJoin(poTable, eq(grnsTable.purchaseOrderId, poTable.id))
        .where(eq(grnsTable.id, id))
        .limit(1),
      db.select().from(grnItemsTable).where(eq(grnItemsTable.grnId, id)).orderBy(asc(grnItemsTable.createdAt)),
    ]);

    const headerRow = headerRows[0];
    if (!headerRow) return c.json({ error: "not_found" }, 404);

    // Migration 0106 — surface convert-eligibility / lock flags on the grn object.
    const flagSrc = itemRows.map((it) => ({ qty_accepted: it.qtyAccepted, invoiced_qty: it.invoicedQty, returned_qty: it.returnedQty }));
    const grn = {
      ...toGrnHeaderResponse(headerRow.grn),
      supplier: headerRow.supplier?.id ? headerRow.supplier : null,
      purchase_order: headerRow.purchase_order?.id ? headerRow.purchase_order : null,
      ...computeGrnFlags(flagSrc),
    };

    /* Per GRN line: "received from which PO" + receive date. The header carries
       received_at; each line links to a PO item, so resolve its source PO number
       (item -> po_item -> po). source_po_number is null for manual lines. */
    const headerReceivedAt = headerRow.grn.receivedAt ?? null;
    const poItemIds = [...new Set(itemRows.map((it) => it.purchaseOrderItemId).filter((x): x is string => Boolean(x)))];
    const poNoByItemId = new Map<string, string>();
    if (poItemIds.length > 0) {
      const poiRows = await db
        .select({ id: poItemsTable.id, poNumber: poTable.poNumber })
        .from(poItemsTable)
        .leftJoin(poTable, eq(poItemsTable.purchaseOrderId, poTable.id))
        .where(inArray(poItemsTable.id, poItemIds));
      for (const r of poiRows) if (r.poNumber) poNoByItemId.set(r.id, r.poNumber);
    }
    /* downstream (per-line PI/PR breakdown) — the PI/PR slices that create those
       docs are not cloned yet -> faithful empty array per line.
       TODO: wire grnLineDownstream when the PI/PR slice lands. */
    const items = itemRows.map((it) => ({
      ...toGrnItemResponse(it),
      source_po_number: it.purchaseOrderItemId ? (poNoByItemId.get(it.purchaseOrderItemId) ?? null) : null,
      received_at: headerReceivedAt,
      downstream: [] as unknown[],
    }));
    return c.json({ grn, items });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

// ── Linked docs (Smart Buttons fan-out) ─────────────────────────────
// For a GRN: the parent PO + downstream PIs + PRs. The PI/PR slices are not
// cloned yet -> faithful empty arrays so the page renders zero counters.
// TODO: wire invoices / returns to purchase_invoices / purchase_returns.
app.get("/:id/linked", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  try {
    const rows = await db
      .select({
        id: grnsTable.id,
        purchase_order_id: grnsTable.purchaseOrderId,
        po: { id: poTable.id, po_number: poTable.poNumber },
      })
      .from(grnsTable)
      .leftJoin(poTable, eq(grnsTable.purchaseOrderId, poTable.id))
      .where(eq(grnsTable.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) return c.json({ error: "not_found" }, 404);
    return c.json({
      purchaseOrder: row.po?.id ? row.po : null,
      invoices: [] as unknown[],
      returns: [] as unknown[],
    });
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
    return c.json({ error: "draft_status_not_supported", message: "DRAFT was removed in migration 0078 — GRNs post immediately on create." }, 400);
  /* A GRN may be created WITHOUT a parent PO (blank/manual receipt). Only the
     supplier is required; purchaseOrderId is optional. Each grn_item still carries
     its own purchase_order_item_id (or null). */
  if (!body.supplierId) return c.json({ error: "supplier_required" }, 400);
  const items = body.items as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(items) || !items.length) return c.json({ error: "items_required" }, 400);

  const db = getDb(c.env);
  const user = c.get("user");

  /* Over-receipt guard — PO-linked lines can't accept more than the PO line's
     remaining (qty - received_qty). Lines with no purchase_order_item_id are
     uncapped. Picks targeting the SAME PO line within one GRN are summed. */
  {
    const acceptedByPoItem = new Map<string, number>();
    for (const it of items) {
      const poItemId = (it.purchaseOrderItemId as string | undefined) ?? null;
      if (!poItemId) continue;
      const accepted = Number(it.qtyAccepted ?? it.qtyReceived ?? 0);
      acceptedByPoItem.set(poItemId, (acceptedByPoItem.get(poItemId) ?? 0) + accepted);
    }
    if (acceptedByPoItem.size > 0) {
      const poItems = await db
        .select({ id: poItemsTable.id, qty: poItemsTable.qty, receivedQty: poItemsTable.receivedQty })
        .from(poItemsTable)
        .where(inArray(poItemsTable.id, [...acceptedByPoItem.keys()]));
      const remByPoItem = new Map<string, number>(poItems.map((r) => [r.id, (r.qty ?? 0) - (r.receivedQty ?? 0)]));
      for (const [poItemId, accepted] of acceptedByPoItem) {
        const remaining = remByPoItem.get(poItemId) ?? 0;
        if (accepted > remaining) {
          return c.json({ error: "qty_exceeds_remaining", poItemId, requested: accepted, remaining }, 409);
        }
      }
    }
  }

  const grnNumber = await nextNumber(db, "GRN");

  /* GRN is created as POSTED directly + posted_at, then postGrnAndRollup does the
     receipt rollup + inventory IN. Header includes a "Receive into" warehouse;
     when omitted, fall back to the default warehouse. */
  const headerWarehouseId = (body.warehouseId as string | undefined) ?? (await defaultWarehouseId(db)) ?? null;

  let header: { id: string; grnNumber: string };
  try {
    const inserted = await db
      .insert(grnsTable)
      .values({
        grnNumber,
        purchaseOrderId: (body.purchaseOrderId as string | undefined) ?? null,
        supplierId: body.supplierId as string,
        warehouseId: headerWarehouseId,
        receivedAt: (body.receivedAt as string) ?? new Date().toISOString().slice(0, 10),
        deliveryNoteRef: (body.deliveryNoteRef as string) ?? null,
        notes: (body.notes as string) ?? null,
        status: "POSTED",
        postedAt: new Date(),
        createdBy: user.id,
      } as never)
      .returning({ id: grnsTable.id, grnNumber: grnsTable.grnNumber });
    header = inserted[0];
  } catch (e) {
    return c.json({ error: "insert_failed", reason: errMsg(e) }, 500);
  }

  const rows = items.map((it) => {
    const qtyReceived = Number(it.qtyReceived ?? 0);
    const unitPriceCenti = Number(it.unitPriceCenti ?? 0);
    const discountCenti = Number(it.discountCenti ?? 0);
    return {
      grnId: header.id,
      purchaseOrderItemId: (it.purchaseOrderItemId as string | undefined) ?? null,
      materialKind: it.materialKind as "mfg_product" | "fabric" | "raw",
      materialCode: it.materialCode as string,
      materialName: it.materialName as string,
      supplierSku: (it.supplierSku as string | undefined) ?? null,
      qtyReceived,
      qtyAccepted: Number(it.qtyAccepted ?? it.qtyReceived ?? 0),
      qtyRejected: Number(it.qtyRejected ?? 0),
      rejectionReason: (it.rejectionReason as string | undefined) ?? null,
      unitPriceCenti,
      discountCenti,
      // Migration 0101 — GRN line money: qty_received * unit - discount.
      lineTotalCenti: qtyReceived * unitPriceCenti - discountCenti,
      deliveryDate: (it.deliveryDate as string | undefined) ?? null,
      unitCostCenti: Number(it.unitCostCenti ?? 0),
      notes: (it.notes as string | undefined) ?? null,
      itemGroup: (it.itemGroup as string | undefined) ?? null,
      variants: (it.variants as unknown) ?? null,
      description: (it.description as string | undefined) ?? null,
      // Description 2 server-owned in 2990s via buildVariantSummary (furniture
      // formatter, dropped per Strategy-2) — pass the client value through.
      description2: (it.description2 as string | undefined) ?? null,
      // Migration 0151 — physical rack this received line is placed onto.
      rackId: (it.rackId as string | undefined) || null,
    };
  });
  try {
    await db.insert(grnItemsTable).values(rows as never);
  } catch (iErr) {
    await db.delete(grnsTable).where(eq(grnsTable.id, header.id));
    return c.json({ error: "items_insert_failed", reason: errMsg(iErr) }, 500);
  }

  /* Post-insert over-receipt verification — the pre-check is a read-then-write
     race. Re-sum live received per PO line; if THIS GRN broke a cap, delete + 409. */
  {
    const over = await verifyGrnOverReceipt(db, header.id, items.map((it) => (it.purchaseOrderItemId as string | undefined) ?? null));
    if (over) {
      await db.delete(grnItemsTable).where(eq(grnItemsTable.grnId, header.id));
      await db.delete(grnsTable).where(eq(grnsTable.id, header.id));
      return c.json({ error: "qty_exceeds_remaining", poItemId: over.poItemId, requested: over.requested, remaining: over.remaining }, 409);
    }
  }

  // Roll up qty_accepted to PO items + write inventory IN. Best-effort.
  await postGrnAndRollup(db, header.id, user.id);
  // Migration 0101 — populate header money rollups from the inserted lines.
  await recomputeGrnTotals(db, header.id);

  return c.json({ id: header.id, grnNumber: header.grnNumber }, 201);
});

// ── POST /from-pos ───────────────────────────────────────────────────────
// Batch-convert multiple POs into ONE GRN. Validates same supplier across all
// POs. Pre-fills qty_received + qty_accepted with the outstanding qty per line.
app.post("/from-pos", async (c) => {
  const db = getDb(c.env);
  const user = c.get("user");
  let body: { purchaseOrderIds?: string[]; deliveryNoteRef?: string; notes?: string };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const poIds = body.purchaseOrderIds ?? [];
  if (poIds.length === 0) return c.json({ error: "po_ids_required" }, 400);

  let poList: Array<{ id: string; poNumber: string; supplierId: string; status: string }>;
  try {
    poList = await db
      .select({ id: poTable.id, poNumber: poTable.poNumber, supplierId: poTable.supplierId, status: poTable.status })
      .from(poTable)
      .where(inArray(poTable.id, poIds));
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
  if (poList.length === 0) return c.json({ error: "pos_not_found" }, 404);

  const supplierIds = new Set(poList.map((p) => p.supplierId));
  if (supplierIds.size > 1) {
    return c.json({ error: "mixed_suppliers", message: "All selected POs must be from the same supplier" }, 400);
  }
  const supplierId = [...supplierIds][0]!;

  const itemList = (
    await db.select().from(poItemsTable).where(inArray(poItemsTable.purchaseOrderId, poIds))
  ).filter((it) => it.qty - (it.receivedQty ?? 0) > 0);

  if (itemList.length === 0) return c.json({ error: "nothing_outstanding", message: "All PO items are already fully received" }, 400);

  const grnNumber = await nextNumber(db, "GRN");
  const poNumbersJoined = poList.map((p) => p.poNumber).join(", ");

  let header: { id: string; grnNumber: string };
  try {
    const inserted = await db
      .insert(grnsTable)
      .values({
        grnNumber,
        purchaseOrderId: poList[0]!.id, // primary PO ref (first one)
        supplierId,
        receivedAt: new Date().toISOString().slice(0, 10),
        deliveryNoteRef: body.deliveryNoteRef ?? null,
        notes: `Batch-converted from ${poList.length} POs: ${poNumbersJoined}${body.notes ? ` · ${body.notes}` : ""}`,
        status: "POSTED",
        postedAt: new Date(),
        createdBy: user.id,
      } as never)
      .returning({ id: grnsTable.id, grnNumber: grnsTable.grnNumber });
    header = inserted[0];
  } catch (e) {
    return c.json({ error: "insert_failed", reason: errMsg(e) }, 500);
  }

  const rows = itemList.map((it) => {
    const qtyReceived = it.qty - (it.receivedQty ?? 0);
    const discountCenti = it.discountCenti ?? 0;
    return {
      grnId: header.id,
      purchaseOrderItemId: it.id,
      materialKind: it.materialKind,
      materialCode: it.materialCode,
      materialName: it.materialName,
      qtyReceived,
      qtyAccepted: qtyReceived,
      qtyRejected: 0,
      unitPriceCenti: it.unitPriceCenti,
      lineTotalCenti: qtyReceived * it.unitPriceCenti - discountCenti,
      unitCostCenti: it.unitCostCenti ?? 0,
      itemGroup: it.itemGroup ?? null,
      description: it.description ?? null,
      description2: it.description2 ?? null,
      uom: it.uom ?? "UNIT",
      variants: it.variants ?? null,
      gapInches: it.gapInches ?? null,
      divanHeightInches: it.divanHeightInches ?? null,
      divanPriceSen: it.divanPriceSen ?? 0,
      legHeightInches: it.legHeightInches ?? null,
      legPriceSen: it.legPriceSen ?? 0,
      customSpecials: it.customSpecials ?? null,
      lineSuffix: it.lineSuffix ?? null,
      specialOrderPriceSen: it.specialOrderPriceSen ?? 0,
      discountCenti,
      deliveryDate: it.deliveryDate ?? null,
    };
  });
  try {
    await db.insert(grnItemsTable).values(rows as never);
  } catch (iErr) {
    await db.delete(grnsTable).where(eq(grnsTable.id, header.id));
    return c.json({ error: "items_insert_failed", reason: errMsg(iErr) }, 500);
  }

  {
    const over = await verifyGrnOverReceipt(db, header.id, itemList.map((it) => it.id));
    if (over) {
      await db.delete(grnItemsTable).where(eq(grnItemsTable.grnId, header.id));
      await db.delete(grnsTable).where(eq(grnsTable.id, header.id));
      return c.json({ error: "qty_exceeds_remaining", poItemId: over.poItemId, requested: over.requested, remaining: over.remaining }, 409);
    }
  }

  await postGrnAndRollup(db, header.id, user.id);
  await recomputeGrnTotals(db, header.id);

  return c.json({ id: header.id, grnNumber: header.grnNumber, poCount: poList.length, lineCount: itemList.length }, 201);
});

// ── PATCH /:id/post — idempotent no-op (POSTED-on-create) ──────────────────
app.patch("/:id/post", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const user = c.get("user");
  const curRows = await db
    .select({ id: grnsTable.id, status: grnsTable.status, postedAt: grnsTable.postedAt })
    .from(grnsTable)
    .where(eq(grnsTable.id, id))
    .limit(1);
  const row = curRows[0];
  if (!row) return c.json({ error: "not_found" }, 404);
  if (row.status === "POSTED") return c.json({ grn: row });
  const res = await postGrnAndRollup(db, id, user.id);
  if (!res.ok) return c.json({ error: "post_failed", reason: res.reason }, 500);
  const afterRows = await db
    .select({ id: grnsTable.id, status: grnsTable.status, postedAt: grnsTable.postedAt })
    .from(grnsTable)
    .where(eq(grnsTable.id, id))
    .limit(1);
  return c.json({ grn: afterRows[0] });
});

/* ── POST /from-po-items — multi-select line-level GRN creator ──────────────
   Body: { picks: [{ poItemId, qty }], notes?, receivedDate? }. Groups picks by
   SUPPLIER (one GRN per supplier; a supplier's lines may span several POs). Each
   GRN is created POSTED then rolled up via postGrnAndRollup. */
app.post("/from-po-items", async (c) => {
  const db = getDb(c.env);
  const user = c.get("user");
  let body: { picks?: Array<{ poItemId: string; qty: number }>; notes?: string; receivedDate?: string };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const picks = body.picks ?? [];
  if (picks.length === 0) return c.json({ error: "picks_required" }, 400);

  const ids = picks.map((p) => p.poItemId);
  let itemList: Array<
    typeof poItemsTable.$inferSelect & {
      po: { id: string; po_number: string; supplier_id: string; status: string; purchase_location_id: string | null };
    }
  >;
  try {
    const rows = await db
      .select({
        item: poItemsTable,
        po: {
          id: poTable.id,
          po_number: poTable.poNumber,
          supplier_id: poTable.supplierId,
          status: poTable.status,
          purchase_location_id: poTable.purchaseLocationId,
        },
      })
      .from(poItemsTable)
      .innerJoin(poTable, eq(poItemsTable.purchaseOrderId, poTable.id))
      .where(inArray(poItemsTable.id, ids));
    itemList = rows.map((r) => ({ ...r.item, po: r.po }));
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }

  const byId = new Map(itemList.map((r) => [r.id, r]));

  // Validate every pick — qty > 0 and qty ≤ remaining.
  for (const p of picks) {
    const row = byId.get(p.poItemId);
    if (!row) return c.json({ error: "item_not_found", poItemId: p.poItemId }, 400);
    if (p.qty <= 0) return c.json({ error: "qty_must_be_positive", poItemId: p.poItemId }, 400);
    const remaining = row.qty - (row.receivedQty ?? 0);
    if (p.qty > remaining) {
      return c.json({ error: "qty_exceeds_remaining", poItemId: p.poItemId, requested: p.qty, remaining }, 409);
    }
    if (row.po.status !== "SUBMITTED" && row.po.status !== "PARTIALLY_RECEIVED") {
      return c.json({ error: "po_not_receivable", poItemId: p.poItemId, status: row.po.status }, 409);
    }
  }

  // Group picks by SUPPLIER → one GRN per supplier.
  type ItemRow = (typeof itemList)[number];
  type Bucket = {
    supplierId: string;
    primaryPoId: string;
    poNumbers: Set<string>;
    warehouseId: string | null;
    lines: Array<{ row: ItemRow; qty: number }>;
  };
  const buckets = new Map<string, Bucket>();
  for (const p of picks) {
    const row = byId.get(p.poItemId)!;
    const key = row.po.supplier_id;
    const cur =
      buckets.get(key) ?? {
        supplierId: row.po.supplier_id,
        primaryPoId: row.po.id,
        poNumbers: new Set<string>(),
        warehouseId: row.po.purchase_location_id,
        lines: [],
      };
    cur.poNumbers.add(row.po.po_number);
    cur.lines.push({ row, qty: p.qty });
    buckets.set(key, cur);
  }

  const d = new Date();
  const yymm = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, "0")}`;
  const existing = await db
    .select({ id: grnsTable.id })
    .from(grnsTable)
    .where(like(grnsTable.grnNumber, `GRN-${yymm}-%`));
  let counter = existing.length;

  const receivedAt = body.receivedDate ?? new Date().toISOString().slice(0, 10);
  const created: Array<{ id: string; grnNumber: string; purchaseOrderId: string; poNumber: string; lineCount: number }> = [];
  let overReceipt: { poItemId: string; requested: number; remaining: number } | null = null;

  for (const bucket of buckets.values()) {
    counter += 1;
    const grnNumber = `GRN-${yymm}-${String(counter).padStart(3, "0")}`;
    let header: { id: string; grnNumber: string } | undefined;
    try {
      const inserted = await db
        .insert(grnsTable)
        .values({
          grnNumber,
          purchaseOrderId: bucket.primaryPoId,
          supplierId: bucket.supplierId,
          receivedAt,
          warehouseId: bucket.warehouseId,
          notes: body.notes
            ? `Received from ${[...bucket.poNumbers].join(", ")} · ${body.notes}`
            : `Received from ${[...bucket.poNumbers].join(", ")}`,
          status: "POSTED",
          postedAt: new Date(),
          createdBy: user.id,
        } as never)
        .returning({ id: grnsTable.id, grnNumber: grnsTable.grnNumber });
      header = inserted[0];
    } catch {
      continue;
    }
    if (!header) continue;
    const h = header;

    const rows = bucket.lines.map(({ row, qty }) => {
      const discountCenti = row.discountCenti ?? 0;
      return {
        grnId: h.id,
        purchaseOrderItemId: row.id,
        materialKind: row.materialKind,
        materialCode: row.materialCode,
        materialName: row.materialName,
        qtyReceived: qty,
        qtyAccepted: qty,
        qtyRejected: 0,
        unitPriceCenti: row.unitPriceCenti,
        lineTotalCenti: qty * row.unitPriceCenti - discountCenti,
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
        discountCenti,
        deliveryDate: row.deliveryDate ?? null,
      };
    });
    try {
      await db.insert(grnItemsTable).values(rows as never);
    } catch {
      await db.delete(grnsTable).where(eq(grnsTable.id, h.id));
      continue;
    }
    const over = await verifyGrnOverReceipt(db, h.id, bucket.lines.map(({ row }) => row.id));
    if (over) {
      await db.delete(grnItemsTable).where(eq(grnItemsTable.grnId, h.id));
      await db.delete(grnsTable).where(eq(grnsTable.id, h.id));
      overReceipt = over;
      continue;
    }
    await postGrnAndRollup(db, h.id, user.id);
    await recomputeGrnTotals(db, h.id);
    created.push({
      id: h.id,
      grnNumber: h.grnNumber,
      purchaseOrderId: bucket.primaryPoId,
      poNumber: [...bucket.poNumbers].join(", "),
      lineCount: bucket.lines.length,
    });
  }

  if (overReceipt) {
    return c.json(
      {
        error: "qty_exceeds_remaining",
        poItemId: overReceipt.poItemId,
        requested: overReceipt.requested,
        remaining: overReceipt.remaining,
        created,
      },
      409,
    );
  }

  return c.json({ created, total: created.length }, 201);
});

/* ── PATCH /:id/cancel — cancel a GRN + reverse its receipt ─────────────────
     1. status='CANCELLED' (idempotent — already-cancelled echoes back).
     2. Reverses the inventory IN: an OUT movement per line for qty_accepted.
     3. Recounts each linked PO item's received_qty + re-evaluates PO status.
   Steps 2+3 are best-effort. grns has no cancelled_at column → status + updated_at. */
app.patch("/:id/cancel", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const user = c.get("user");

  const curRows = await db
    .select({ id: grnsTable.id, status: grnsTable.status, grnNumber: grnsTable.grnNumber, warehouseId: grnsTable.warehouseId })
    .from(grnsTable)
    .where(eq(grnsTable.id, id))
    .limit(1);
  const head = curRows[0];
  if (!head) return c.json({ error: "not_found" }, 404);
  // Idempotent — already cancelled, echo back without re-reversing.
  if (head.status === "CANCELLED") {
    const rows = await db.select().from(grnsTable).where(eq(grnsTable.id, id)).limit(1);
    return c.json({ grn: rows[0] ? toGrnHeaderResponse(rows[0]) : { id, status: "CANCELLED" } });
  }

  // GRN child-lock: can't cancel a GRN that has a downstream PI/PR.
  const childLock = await grnHasDownstream(db, id);
  if (childLock) return c.json(childLock, 409);

  // Load the GRN lines once — needed by the consumption guard + both reversals.
  const lineList = await db
    .select({
      purchaseOrderItemId: grnItemsTable.purchaseOrderItemId,
      qtyAccepted: grnItemsTable.qtyAccepted,
      materialCode: grnItemsTable.materialCode,
      materialName: grnItemsTable.materialName,
      unitPriceCenti: grnItemsTable.unitPriceCenti,
      itemGroup: grnItemsTable.itemGroup,
      variants: grnItemsTable.variants,
    })
    .from(grnItemsTable)
    .where(eq(grnItemsTable.grnId, id));

  // Bug #2 — block the cancel if the received stock was already consumed downstream.
  const consumedLock = await grnReverseWouldGoNegative(
    db,
    head.warehouseId,
    lineList.map((it) => ({ qty_accepted: it.qtyAccepted, material_code: it.materialCode, item_group: it.itemGroup, variants: it.variants as VariantAttrs | null })),
  );
  if (consumedLock) return c.json(consumedLock, 409);

  /* Bug #3/#11 — ATOMIC single ACTIVE→CANCELLED transition. The conditional
     UPDATE excludes CANCELLED so two concurrent cancels race + only ONE flips it. */
  let updRow: { id: string } | undefined;
  try {
    const upd = await db
      .update(grnsTable)
      .set({ status: "CANCELLED", updatedAt: new Date() })
      .where(and(eq(grnsTable.id, id), ne(grnsTable.status, "CANCELLED")))
      .returning({ id: grnsTable.id });
    updRow = upd[0];
  } catch (e) {
    return c.json({ error: "cancel_failed", reason: errMsg(e) }, 500);
  }
  if (!updRow) {
    const rows = await db.select().from(grnsTable).where(eq(grnsTable.id, id)).limit(1);
    return c.json({ grn: rows[0] ? toGrnHeaderResponse(rows[0]) : { id, status: "CANCELLED" } });
  }

  // (a) Inventory OUT per line — negate the original GRN IN. Best-effort.
  try {
    const warehouseId = head.warehouseId ?? (await defaultWarehouseId(db));
    if (warehouseId) {
      const batchByItem = await resolvePoBatchByItem(db, lineList.map((it) => it.purchaseOrderItemId));
      const movements = lineList
        .filter((it) => (it.qtyAccepted ?? 0) > 0)
        .map((it) => {
          const variant_key = computeVariantKey(it.itemGroup, (it.variants as VariantAttrs | null) ?? null);
          const batch_no = it.purchaseOrderItemId ? (batchByItem.get(it.purchaseOrderItemId) ?? null) : null;
          return {
            movement_type: "OUT" as const,
            warehouse_id: warehouseId,
            product_code: it.materialCode,
            variant_key,
            product_name: it.materialName,
            qty: it.qtyAccepted,
            source_doc_type: "GRN" as const,
            source_doc_id: id,
            source_doc_no: head.grnNumber,
            performed_by: user.id,
            ...(batch_no != null ? { batch_no } : {}),
            notes: "GRN cancelled — reversing receipt",
          };
        });
      if (movements.length > 0) await writeMovements(db, movements);
    }
  } catch {
    /* best-effort: never un-cancel on a movement failure */
  }

  // (a2) Physical rack reversal — pull every rack item this GRN placed. Best-effort.
  try {
    const { reverseGrnRacks } = await import("../lib/grn-rack-sync");
    await reverseGrnRacks(db, id, head.grnNumber, user.id);
  } catch (e) {
    console.error("[grn-rack] reverse failed:", e);
  }

  // (b) Recount received_qty on each linked PO item — this GRN's lines now drop out.
  try {
    await recomputePoReceived(db, lineList.map((it) => it.purchaseOrderItemId));
  } catch {
    /* best-effort */
  }

  const afterRows = await db.select().from(grnsTable).where(eq(grnsTable.id, id)).limit(1);
  return c.json({ grn: afterRows[0] ? toGrnHeaderResponse(afterRows[0]) : { id, status: "CANCELLED" } });
});

/* ════════════════════════════════════════════════════════════════════════
   GRN PO-clone CRUD (PATCH header + line add / edit / delete) — mirrors the PO
   detail page's draft-mode editing. The editable line quantity is qty_received;
   line_total_centi = qty_received * unit_price_centi - discount_centi.
   ════════════════════════════════════════════════════════════════════════ */

// ── PATCH /:id — header update (+ warehouse relocation) ──
app.patch("/:id", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const user = c.get("user");
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  /* Warehouse relocation — a posted GRN already pushed its IN stock into the OLD
     warehouse. Changing the warehouse physically moves it: OUT of old + IN to new,
     carrying the same cost + source-PO batch. Same downstream-consumption guard as
     cancel — if the old-warehouse stock was already shipped/used, block. */
  if (body.warehouseId !== undefined) {
    const curRows = await db
      .select({ id: grnsTable.id, grnNumber: grnsTable.grnNumber, status: grnsTable.status, warehouseId: grnsTable.warehouseId })
      .from(grnsTable)
      .where(eq(grnsTable.id, id))
      .limit(1);
    const c0 = curRows[0] ?? null;
    const oldWh = c0?.warehouseId ?? null;
    const newWh = (body.warehouseId as string | null) ?? null;
    if (c0 && (c0.status ?? "").toUpperCase() === "POSTED" && newWh && oldWh && newWh !== oldWh) {
      const lineList = await db
        .select({
          purchaseOrderItemId: grnItemsTable.purchaseOrderItemId,
          qtyAccepted: grnItemsTable.qtyAccepted,
          materialCode: grnItemsTable.materialCode,
          materialName: grnItemsTable.materialName,
          unitPriceCenti: grnItemsTable.unitPriceCenti,
          itemGroup: grnItemsTable.itemGroup,
          variants: grnItemsTable.variants,
        })
        .from(grnItemsTable)
        .where(eq(grnItemsTable.grnId, id));
      const consumedLock = await grnReverseWouldGoNegative(
        db,
        oldWh,
        lineList.map((it) => ({ qty_accepted: it.qtyAccepted, material_code: it.materialCode, item_group: it.itemGroup, variants: it.variants as VariantAttrs | null })),
      );
      if (consumedLock) return c.json(consumedLock, 409);
      const batchByItem = await resolvePoBatchByItem(db, lineList.map((it) => it.purchaseOrderItemId));
      const movements = lineList
        .filter((it) => (it.qtyAccepted ?? 0) > 0)
        .flatMap((it) => {
          const variant_key = computeVariantKey(it.itemGroup, (it.variants as VariantAttrs | null) ?? null);
          const batch_no = it.purchaseOrderItemId ? (batchByItem.get(it.purchaseOrderItemId) ?? null) : null;
          const base = {
            product_code: it.materialCode,
            variant_key,
            product_name: it.materialName,
            qty: it.qtyAccepted,
            source_doc_type: "GRN" as const,
            source_doc_id: id,
            source_doc_no: c0.grnNumber,
            batch_no,
            performed_by: user.id,
          };
          return [
            { ...base, movement_type: "OUT" as const, warehouse_id: oldWh, notes: "GRN warehouse changed — out of old warehouse" },
            { ...base, movement_type: "IN" as const, warehouse_id: newWh, unit_cost_sen: Number(it.unitPriceCenti ?? 0), notes: "GRN warehouse changed — into new warehouse" },
          ];
        });
      if (movements.length > 0) {
        try {
          await writeMovements(db, movements);
        } catch (e) {
          return c.json({ error: "relocate_failed", reason: errMsg(e) }, 500);
        }
      }
    }
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  for (const [from, to] of [
    ["supplierId", "supplierId"],
    ["receivedAt", "receivedAt"],
    ["deliveryNoteRef", "deliveryNoteRef"],
    ["warehouseId", "warehouseId"],
    ["notes", "notes"],
    ["currency", "currency"],
  ] as const) {
    if (body[from] !== undefined) updates[to] = body[from];
  }
  try {
    const updated = await db.update(grnsTable).set(updates).where(eq(grnsTable.id, id)).returning();
    if (!updated[0]) return c.json({ error: "not_found" }, 404);
    return c.json({ grn: toGrnHeaderResponse(updated[0]) });
  } catch (e) {
    return c.json({ error: "update_failed", reason: errMsg(e) }, 500);
  }
});

// ── POST /:id/items — add one grn_item. qty maps to qty_received. ──
app.post("/:id/items", async (c) => {
  const db = getDb(c.env);
  const grnId = c.req.param("id");
  const user = c.get("user");
  let it: Record<string, unknown>;
  try {
    it = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  if (!it.materialCode) return c.json({ error: "material_code_required" }, 400);
  if (!it.materialName) return c.json({ error: "material_name_required" }, 400);

  // GRN child-lock: a GRN with any downstream PI/PR is read-only.
  const childLock = await grnHasDownstream(db, grnId);
  if (childLock) return c.json(childLock, 409);
  /* Line CRUD on a CANCELLED/CLOSED GRN was a silent stock door — block it. */
  const gateRows = await db.select({ status: grnsTable.status }).from(grnsTable).where(eq(grnsTable.id, grnId)).limit(1);
  const grnGateStatus = (gateRows[0]?.status ?? "").toUpperCase();
  if (grnGateStatus === "CANCELLED" || grnGateStatus === "CLOSED") {
    return c.json({ error: "grn_locked", message: `This GRN is ${grnGateStatus} — its lines can no longer be changed.` }, 409);
  }

  const qtyReceived = Number(it.qty ?? 1);
  const unitPriceCenti = Number(it.unitPriceCenti ?? 0);
  const discountCenti = Number(it.discountCenti ?? 0);
  const lineTotal = qtyReceived * unitPriceCenti - discountCenti;

  /* Over-receipt guard — a PO-linked added line can't accept more than the PO
     line's remaining. Manual (no PO link) lines are uncapped. */
  const addLinePoItemId = (it.purchaseOrderItemId as string) ?? null;
  if (addLinePoItemId) {
    const poItemRows = await db
      .select({ qty: poItemsTable.qty, receivedQty: poItemsTable.receivedQty })
      .from(poItemsTable)
      .where(eq(poItemsTable.id, addLinePoItemId))
      .limit(1);
    const p = poItemRows[0];
    if (p) {
      const remaining = (p.qty ?? 0) - (p.receivedQty ?? 0);
      if (qtyReceived > remaining) {
        return c.json({ error: "qty_exceeds_remaining", poItemId: addLinePoItemId, requested: qtyReceived, remaining }, 409);
      }
    }
  }

  const row = {
    grnId,
    purchaseOrderItemId: (it.purchaseOrderItemId as string) ?? null,
    materialKind: ((it.materialKind as string) ?? "mfg_product") as "mfg_product" | "fabric" | "raw",
    materialCode: it.materialCode as string,
    materialName: it.materialName as string,
    supplierSku: (it.supplierSku as string) ?? null,
    qtyReceived,
    qtyAccepted: qtyReceived,
    qtyRejected: 0,
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
    // Description 2 server-owned in 2990s via buildVariantSummary (dropped) —
    // pass the client value through.
    description2: (it.description2 as string) ?? null,
    uom: (it.uom as string) ?? "UNIT",
    deliveryDate: (it.deliveryDate as string) ?? null,
  };
  let inserted: typeof grnItemsTable.$inferSelect;
  try {
    const ins = await db.insert(grnItemsTable).values(row as never).returning();
    inserted = ins[0];
  } catch (e) {
    return c.json({ error: "insert_failed", reason: errMsg(e) }, 500);
  }

  /* POST-INSERT over-receipt verification — the pre-check is a read-then-write
     race. Re-read PO line qty + live sum of qty_accepted; if it exceeds qty, OUR
     insert broke the cap → delete it + 409. */
  if (addLinePoItemId) {
    const poItemRows = await db.select({ qty: poItemsTable.qty }).from(poItemsTable).where(eq(poItemsTable.id, addLinePoItemId)).limit(1);
    const p = poItemRows[0];
    if (p) {
      const cap = p.qty ?? 0;
      const sibRows = await db
        .select({ qtyAccepted: grnItemsTable.qtyAccepted, grnId: grnItemsTable.grnId })
        .from(grnItemsTable)
        .where(eq(grnItemsTable.purchaseOrderItemId, addLinePoItemId));
      const grnIds = [...new Set(sibRows.map((r) => r.grnId))];
      const cancelled = new Set<string>();
      if (grnIds.length > 0) {
        const gs = await db.select({ id: grnsTable.id, status: grnsTable.status }).from(grnsTable).where(inArray(grnsTable.id, grnIds));
        for (const g of gs) if (g.status === "CANCELLED") cancelled.add(g.id);
      }
      const liveAccepted = sibRows.filter((r) => !cancelled.has(r.grnId)).reduce((s, r) => s + Number(r.qtyAccepted ?? 0), 0);
      if (liveAccepted > cap && inserted?.id) {
        await db.delete(grnItemsTable).where(eq(grnItemsTable.id, inserted.id));
        return c.json({ error: "qty_exceeds_remaining", poItemId: addLinePoItemId, requested: qtyReceived, remaining: cap - (liveAccepted - qtyReceived) }, 409);
      }
    }
  }

  await recomputeGrnTotals(db, grnId);

  /* A line added to a POSTED GRN must roll up exactly like one created at post
     time, else its PO line stays outstanding + its stock never enters inventory —
     yet DELETE still writes an OUT. Mirror postGrnAndRollup for this one line. */
  const addedPoiId = (it.purchaseOrderItemId as string) ?? null;
  try {
    await recomputePoReceived(db, [addedPoiId]);
  } catch {
    /* best-effort */
  }
  if (qtyReceived > 0) {
    try {
      const grnHeadRows = await db
        .select({ grnNumber: grnsTable.grnNumber, warehouseId: grnsTable.warehouseId })
        .from(grnsTable)
        .where(eq(grnsTable.id, grnId))
        .limit(1);
      const warehouseId = grnHeadRows[0]?.warehouseId ?? (await defaultWarehouseId(db));
      if (warehouseId) {
        const batchByItem = await resolvePoBatchByItem(db, [addedPoiId]);
        await writeMovements(db, [
          {
            movement_type: "IN" as const,
            warehouse_id: warehouseId,
            product_code: String(it.materialCode),
            variant_key: computeVariantKey((it.itemGroup as string) ?? null, (it.variants as VariantAttrs | null) ?? null),
            product_name: String(it.materialName),
            qty: qtyReceived,
            unit_cost_sen: unitPriceCenti,
            source_doc_type: "GRN" as const,
            source_doc_id: grnId,
            source_doc_no: grnHeadRows[0]?.grnNumber ?? grnId,
            batch_no: addedPoiId ? (batchByItem.get(addedPoiId) ?? null) : null,
            performed_by: user.id,
            notes: "GRN line added — receipt",
          },
        ]);
      }
    } catch {
      /* best-effort */
    }
  }
  return c.json({ item: toGrnItemResponse(inserted) }, 201);
});

// ── PATCH /:id/items/:itemId — partial line update. qty → qty_received. ──
app.patch("/:id/items/:itemId", async (c) => {
  const db = getDb(c.env);
  const grnId = c.req.param("id");
  const itemId = c.req.param("itemId");
  const user = c.get("user");
  let it: Record<string, unknown>;
  try {
    it = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  // GRN child-lock: a GRN with any downstream PI/PR is read-only.
  const childLock = await grnHasDownstream(db, grnId);
  if (childLock) return c.json(childLock, 409);
  const gateRows = await db.select({ status: grnsTable.status }).from(grnsTable).where(eq(grnsTable.id, grnId)).limit(1);
  const grnGateStatus = (gateRows[0]?.status ?? "").toUpperCase();
  if (grnGateStatus === "CANCELLED" || grnGateStatus === "CLOSED") {
    return c.json({ error: "grn_locked", message: `This GRN is ${grnGateStatus} — its lines can no longer be changed.` }, 409);
  }

  const prevRows = await db
    .select({
      qtyReceived: grnItemsTable.qtyReceived,
      qtyAccepted: grnItemsTable.qtyAccepted,
      unitPriceCenti: grnItemsTable.unitPriceCenti,
      discountCenti: grnItemsTable.discountCenti,
      itemGroup: grnItemsTable.itemGroup,
      variants: grnItemsTable.variants,
      purchaseOrderItemId: grnItemsTable.purchaseOrderItemId,
      materialCode: grnItemsTable.materialCode,
      materialName: grnItemsTable.materialName,
    })
    .from(grnItemsTable)
    .where(eq(grnItemsTable.id, itemId))
    .limit(1);
  const prev = prevRows[0];
  if (!prev) return c.json({ error: "not_found" }, 404);

  const prevAccepted = prev.qtyAccepted ?? 0;
  const qtyReceived = it.qty !== undefined ? Number(it.qty) : prev.qtyReceived;

  /* Over-receipt guard on edit — a PO-linked line can't be raised past headroom =
     qty - (received_qty - this line's current receipt). */
  {
    const poItemId = prev.purchaseOrderItemId;
    const prevQty = prev.qtyReceived ?? 0;
    if (poItemId && qtyReceived > prevQty) {
      const poItemRows = await db
        .select({ qty: poItemsTable.qty, receivedQty: poItemsTable.receivedQty })
        .from(poItemsTable)
        .where(eq(poItemsTable.id, poItemId))
        .limit(1);
      const p = poItemRows[0];
      if (p) {
        const headroom = (p.qty ?? 0) - ((p.receivedQty ?? 0) - prevQty);
        if (qtyReceived > headroom) {
          return c.json({ error: "qty_exceeds_remaining", poItemId, requested: qtyReceived, remaining: headroom }, 409);
        }
      }
    }
  }

  const unit = it.unitPriceCenti !== undefined ? Number(it.unitPriceCenti) : prev.unitPriceCenti;
  const discount = it.discountCenti !== undefined ? Number(it.discountCenti) : prev.discountCenti ?? 0;
  const lineTotal = qtyReceived * unit - discount;

  const updates: Record<string, unknown> = {
    qtyReceived,
    qtyAccepted: qtyReceived,
    unitPriceCenti: unit,
    discountCenti: discount,
    lineTotalCenti: lineTotal,
  };
  for (const [from, to] of [
    ["materialCode", "materialCode"],
    ["materialName", "materialName"],
    ["supplierSku", "supplierSku"],
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
    ["deliveryDate", "deliveryDate"],
    ["description2", "description2"],
  ] as const) {
    if (it[from] !== undefined) updates[to] = it[from];
  }
  /* description2 server-owned in 2990s via buildVariantSummary (furniture
     formatter, dropped per Strategy-2). It is whatever the client sends (handled
     by the map above), else the stored value is left untouched. */

  const newAccepted = updates.qtyAccepted as number;
  const oldGroup = prev.itemGroup ?? null;
  const oldVariants = (prev.variants as VariantAttrs | null) ?? null;
  const effGroup = updates.itemGroup !== undefined ? (updates.itemGroup as string | null) : oldGroup;
  const effVariants = updates.variants !== undefined ? (updates.variants as VariantAttrs | null) : oldVariants;
  const oldKey = computeVariantKey(oldGroup, oldVariants);
  const newKey = computeVariantKey(effGroup, effVariants);
  const matCode = (updates.materialCode as string | undefined) ?? prev.materialCode;
  const matName = (updates.materialName as string | undefined) ?? prev.materialName;
  const bucketChanged = oldKey !== newKey;
  const qtyChanged = newAccepted !== prevAccepted;
  const inventoryChange = (qtyChanged || bucketChanged) && (prevAccepted > 0 || newAccepted > 0);

  // Resolve warehouse once (needed by both the guard and the movement write).
  let editWarehouseId: string | null = null;
  let editGrnNo = grnId;
  if (inventoryChange) {
    const grnHeadRows = await db
      .select({ grnNumber: grnsTable.grnNumber, warehouseId: grnsTable.warehouseId })
      .from(grnsTable)
      .where(eq(grnsTable.id, grnId))
      .limit(1);
    editWarehouseId = grnHeadRows[0]?.warehouseId ?? (await defaultWarehouseId(db));
    editGrnNo = grnHeadRows[0]?.grnNumber ?? grnId;

    // GUARD (bug #2) — pre-check any OUT against current on-hand BEFORE writing.
    if (editWarehouseId) {
      const guardLines: Array<{ qty_accepted: number; material_code: string; item_group?: string | null; variants?: VariantAttrs | null }> = [];
      if (bucketChanged) {
        if (prevAccepted > 0) guardLines.push({ qty_accepted: prevAccepted, material_code: matCode, item_group: oldGroup, variants: oldVariants });
      } else if (newAccepted < prevAccepted) {
        guardLines.push({ qty_accepted: prevAccepted - newAccepted, material_code: matCode, item_group: effGroup, variants: effVariants });
      }
      const consumedLock = await grnReverseWouldGoNegative(db, editWarehouseId, guardLines);
      if (consumedLock) return c.json(consumedLock, 409); // row untouched — safe
    }
  }

  try {
    await db.update(grnItemsTable).set(updates).where(eq(grnItemsTable.id, itemId));
  } catch (e) {
    return c.json({ error: "update_failed", reason: errMsg(e) }, 500);
  }

  // Now write the inventory delta (best-effort, mirroring add/delete-line).
  if (inventoryChange && editWarehouseId) {
    const warehouseId = editWarehouseId;
    const editPoItemId = prev.purchaseOrderItemId;
    const editBatch = editPoItemId ? ((await resolvePoBatchByItem(db, [editPoItemId])).get(editPoItemId) ?? null) : null;
    const batchTag = editBatch ? { batch_no: editBatch } : {};
    const movements: Parameters<typeof writeMovements>[1] = [];
    if (bucketChanged) {
      if (prevAccepted > 0)
        movements.push({
          movement_type: "OUT",
          warehouse_id: warehouseId,
          product_code: matCode,
          variant_key: oldKey,
          product_name: matName,
          qty: prevAccepted,
          source_doc_type: "GRN",
          source_doc_id: grnId,
          source_doc_no: editGrnNo,
          performed_by: user.id,
          notes: "GRN line edited — variant changed, reversing old bucket",
          ...batchTag,
        });
      if (newAccepted > 0)
        movements.push({
          movement_type: "IN",
          warehouse_id: warehouseId,
          product_code: matCode,
          variant_key: newKey,
          product_name: matName,
          qty: newAccepted,
          unit_cost_sen: unit,
          source_doc_type: "GRN",
          source_doc_id: grnId,
          source_doc_no: editGrnNo,
          performed_by: user.id,
          notes: "GRN line edited — variant changed, re-adding new bucket",
          ...batchTag,
        });
    } else {
      const delta = newAccepted - prevAccepted;
      if (delta > 0)
        movements.push({
          movement_type: "IN",
          warehouse_id: warehouseId,
          product_code: matCode,
          variant_key: newKey,
          product_name: matName,
          qty: delta,
          unit_cost_sen: unit,
          source_doc_type: "GRN",
          source_doc_id: grnId,
          source_doc_no: editGrnNo,
          performed_by: user.id,
          notes: "GRN line qty edited — receiving delta",
          ...batchTag,
        });
      else if (delta < 0)
        movements.push({
          movement_type: "OUT",
          warehouse_id: warehouseId,
          product_code: matCode,
          variant_key: newKey,
          product_name: matName,
          qty: -delta,
          source_doc_type: "GRN",
          source_doc_id: grnId,
          source_doc_no: editGrnNo,
          performed_by: user.id,
          notes: "GRN line qty edited — reversing delta",
          ...batchTag,
        });
    }
    if (movements.length > 0) {
      try {
        await writeMovements(db, movements);
      } catch {
        /* best-effort */
      }
    }
  }

  await recomputeGrnTotals(db, grnId);
  // Editing qty_accepted changes how much the PO counts as received — recount it.
  try {
    await recomputePoReceived(db, [prev.purchaseOrderItemId]);
  } catch {
    /* best-effort */
  }
  /* Costing B — 2990s re-costs lots → consumptions → movements → DO → SI here
     (recostFromGrn) when the GR price/bucket changed. That engine + the DO/SI
     chain are not cloned (Strategy-2) — dropped.
     TODO: recostFromGrn(db, grnId) when the PI/DO/SI slices land. */
  return c.json({ ok: true });
});

// ── DELETE /:id/items/:itemId — remove a line + roll back its PO receipt. ──
app.delete("/:id/items/:itemId", async (c) => {
  const db = getDb(c.env);
  const grnId = c.req.param("id");
  const itemId = c.req.param("itemId");
  const user = c.get("user");

  // GRN child-lock: a GRN with any downstream PI/PR is read-only.
  const childLock = await grnHasDownstream(db, grnId);
  if (childLock) return c.json(childLock, 409);
  const gateRows = await db.select({ status: grnsTable.status }).from(grnsTable).where(eq(grnsTable.id, grnId)).limit(1);
  const grnGateStatus = (gateRows[0]?.status ?? "").toUpperCase();
  if (grnGateStatus === "CANCELLED" || grnGateStatus === "CLOSED") {
    return c.json({ error: "grn_locked", message: `This GRN is ${grnGateStatus} — its lines can no longer be changed.` }, 409);
  }

  // Read the line's PO link + accepted qty + variant/cost fields BEFORE deleting.
  const lineRows = await db
    .select({
      qtyAccepted: grnItemsTable.qtyAccepted,
      purchaseOrderItemId: grnItemsTable.purchaseOrderItemId,
      materialCode: grnItemsTable.materialCode,
      materialName: grnItemsTable.materialName,
      unitPriceCenti: grnItemsTable.unitPriceCenti,
      itemGroup: grnItemsTable.itemGroup,
      variants: grnItemsTable.variants,
    })
    .from(grnItemsTable)
    .where(eq(grnItemsTable.id, itemId))
    .limit(1);
  const line = lineRows[0] ?? null;

  // Bug #2 — deleting a posted GRN line writes an OUT to reverse its receipt.
  // Block if that line's received stock was already consumed downstream.
  if (line && (line.qtyAccepted ?? 0) > 0) {
    const grnHeadRows = await db.select({ warehouseId: grnsTable.warehouseId }).from(grnsTable).where(eq(grnsTable.id, grnId)).limit(1);
    const warehouseId = grnHeadRows[0]?.warehouseId ?? (await defaultWarehouseId(db));
    const consumedLock = await grnReverseWouldGoNegative(db, warehouseId, [
      { qty_accepted: line.qtyAccepted, material_code: line.materialCode, item_group: line.itemGroup, variants: line.variants as VariantAttrs | null },
    ]);
    if (consumedLock) return c.json(consumedLock, 409);
  }

  try {
    await db.delete(grnItemsTable).where(eq(grnItemsTable.id, itemId));
  } catch (e) {
    return c.json({ error: "delete_failed", reason: errMsg(e) }, 500);
  }

  if (line) {
    // (a) Recount the PO receipt for the removed line's source (best-effort).
    try {
      await recomputePoReceived(db, [line.purchaseOrderItemId]);
    } catch {
      /* best-effort */
    }

    // (b) Reverse the inventory IN the GRN post wrote for THIS line.
    if ((line.qtyAccepted ?? 0) > 0) {
      try {
        const grnHeadRows = await db
          .select({ grnNumber: grnsTable.grnNumber, warehouseId: grnsTable.warehouseId })
          .from(grnsTable)
          .where(eq(grnsTable.id, grnId))
          .limit(1);
        const warehouseId = grnHeadRows[0]?.warehouseId ?? (await defaultWarehouseId(db));
        if (warehouseId) {
          const variantKey = computeVariantKey(line.itemGroup, (line.variants as VariantAttrs | null) ?? null);
          const batchMap = await resolvePoBatchByItem(db, [line.purchaseOrderItemId]);
          const batchNo: string | null = line.purchaseOrderItemId ? (batchMap.get(line.purchaseOrderItemId) ?? null) : null;
          await writeMovements(db, [
            {
              movement_type: "OUT" as const,
              warehouse_id: warehouseId,
              product_code: line.materialCode,
              variant_key: variantKey,
              product_name: line.materialName,
              qty: line.qtyAccepted,
              ...(batchNo ? { batch_no: batchNo } : {}),
              source_doc_type: "GRN" as const,
              source_doc_id: grnId,
              source_doc_no: grnHeadRows[0]?.grnNumber ?? grnId,
              performed_by: user.id,
              notes: "GRN line deleted — reversing receipt",
            },
          ]);
        }
      } catch {
        /* best-effort */
      }
    }
  }

  await recomputeGrnTotals(db, grnId);
  return c.body(null, 204);
});

export default app;
