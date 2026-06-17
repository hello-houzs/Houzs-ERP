// ----------------------------------------------------------------------------
// /purchase-returns — we send goods back to the supplier. Closes the loop:
// PO -> GRN -> (defect / oversupply / wrong item) -> PurchaseReturn -> supplier
// credit note. A PR is OUTBOUND stock: on post it writes inventory OUT movements
// (FIFO trigger, migration 0026), bumps grn_items.returned_qty, and recomputes
// the parent PO's received_qty (net received drops when stock is returned).
// Cancel reverses (writeMovements IN via reverseMovements + release returned_qty).
//
// 1:1 clone of 2990s apps/api/src/routes/purchase-returns.ts. Endpoints, request
// bodies, response JSON shapes, status codes and business rules (POSTED-on-create
// with inventory OUT inline, per-GRN-line return cap + post-insert race verify,
// returned_qty live-recount + PO re-open, complete-with-CN, cancel + reverse,
// line CRUD with inventory delta movements + line-lock) are kept identical to
// 2990s. Only the SEAMS change:
//   - DB client: 2990s per-request createClient / c.get('supabase') -> Houzs
//     getDb (rule #3). Every PostgREST chain -> a Drizzle query, same JSON
//     in/out. Drizzle returns camelCase rows; the wire shapes keep 2990s's
//     snake_case via the *Response() mappers (rule #7).
//   - Auth: 2990s supabaseAuth -> Houzs requirePermission("*") (rule #4).
//   - user.id: 2990s staff.id (uuid) -> Houzs users.id (integer) (rule #4).
//   - Mount path: /api/purchase-returns.
//   - Inventory writes go through the shared lib/inventory-movements helpers
//     (writeMovements / reverseMovements / defaultWarehouseId), exactly where
//     2990s used them; recomputePoReceived / resolvePoBatchByItem are imported
//     from routes/grns.ts (the GRN slice exports them).
//
// Strategy-2 product-layer simplifications (Houzs is not the 2990s furniture
// business; owner enters own data — see docs/scm-clone/PLAN.md):
//   - DROPPED buildVariantSummary (the furniture description2 formatter); a PR
//     line's description2 is whatever the client sends. Variant columns persist.
//   - DROPPED recomputeSoStockAllocation (SO slice not cloned). 2990s re-walks
//     PENDING SO lines after a PR post/cancel changes on-hand; the call sites are
//     removed with a // TODO. variant_key uses the generic shared computeVariantKey.
//   - warehouseCodeMap reads mfg_warehouses (the cloned inventory warehouse
//     table) for the per-line Warehouse display column.
//
// Endpoints (same as 2990s):
//   GET    /purchase-returns                — list + filters
//   GET    /purchase-returns/:id            — header + items (+ per-line warehouse)
//   GET    /purchase-returns/:id/linked     — Smart Buttons: parent GRN + PO
//   POST   /purchase-returns                — create POSTED PR (+ inventory OUT)
//   POST   /purchase-returns/from-grns      — batch-convert many GRNs (rejected qty)
//   POST   /purchase-returns/from-grn       — convert one whole GRN -> PR
//   PATCH  /purchase-returns/:id/post       — idempotent no-op (POSTED-on-create)
//   PATCH  /purchase-returns/:id/complete   — POSTED -> COMPLETED (with CN ref)
//   PATCH  /purchase-returns/:id/cancel     — cancel + reverse the return
//   PATCH  /purchase-returns/:id            — header update
//   POST   /purchase-returns/:id/items      — add line (+ inventory OUT delta)
//   PATCH  /purchase-returns/:id/items/:itemId — edit line (+ inventory delta)
//   DELETE /purchase-returns/:id/items/:itemId — delete line (+ reverse, IN)
// ----------------------------------------------------------------------------

import { Hono } from "hono";
import { and, desc, eq, gt, inArray, like, ne } from "drizzle-orm";
import type { Env } from "../types";
import { getDb } from "../db/client";
import {
  purchaseReturns as prTable,
  purchaseReturnItems as prItemsTable,
  suppliers as suppliersTable,
  purchaseOrders as poTable,
  grns as grnsTable,
  grnItems as grnItemsTable,
  inventoryMovements,
  mfgWarehouses as warehousesTable,
} from "../db/schema";
import { requirePermission } from "../middleware/auth";
import { writeMovements, reverseMovements, defaultWarehouseId } from "../lib/inventory-movements";
import { recomputeSoStockAllocation } from "../lib/so-stock-allocation";
import { recomputePoReceived, resolvePoBatchByItem } from "./grns";
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

// ── Wire-shape mappers (Drizzle camelCase -> 2990s snake_case) ──────────────
function toPrHeaderResponse(p: typeof prTable.$inferSelect) {
  return {
    id: p.id,
    return_number: p.returnNumber,
    purchase_order_id: p.purchaseOrderId,
    grn_id: p.grnId,
    supplier_id: p.supplierId,
    return_date: p.returnDate,
    reason: p.reason,
    status: p.status,
    posted_at: isoOrNull(p.postedAt),
    completed_at: isoOrNull(p.completedAt),
    credit_note_ref: p.creditNoteRef,
    refund_centi: p.refundCenti,
    notes: p.notes,
    created_at: isoOrNull(p.createdAt),
    created_by: p.createdBy,
    updated_at: isoOrNull(p.updatedAt),
  };
}

function toPrItemResponse(it: typeof prItemsTable.$inferSelect) {
  return {
    id: it.id,
    purchase_return_id: it.purchaseReturnId,
    grn_item_id: it.grnItemId,
    material_kind: it.materialKind,
    material_code: it.materialCode,
    material_name: it.materialName,
    qty_returned: it.qtyReturned,
    unit_price_centi: it.unitPriceCenti,
    line_refund_centi: it.lineRefundCenti,
    reason: it.reason,
    notes: it.notes,
    item_group: it.itemGroup,
    description: it.description,
    description2: it.description2,
    uom: it.uom,
    variants: it.variants ?? null,
    gap_inches: it.gapInches,
    divan_height_inches: it.divanHeightInches,
    divan_price_sen: it.divanPriceSen,
    leg_height_inches: it.legHeightInches,
    leg_price_sen: it.legPriceSen,
    custom_specials: it.customSpecials ?? null,
    line_suffix: it.lineSuffix,
    special_order_price_sen: it.specialOrderPriceSen,
    created_at: isoOrNull(it.createdAt),
  };
}

const nextNum = async (db: Db): Promise<string> => {
  const d = new Date();
  const yymm = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, "0")}`;
  const rows = await db.select({ id: prTable.id }).from(prTable).where(like(prTable.returnNumber, `PRT-${yymm}-%`));
  return `PRT-${yymm}-${String(rows.length + 1).padStart(3, "0")}`;
};

/* ── Recompute PR header money rollup (mirror recomputeGrnTotals) ──────────
   Sum line_refund_centi across purchase_return_items -> write refund_centi on
   the header. A return is qty x unit price (no tax/discount). */
async function recomputePrTotals(db: Db, prId: string) {
  const items = await db.select({ lineRefundCenti: prItemsTable.lineRefundCenti }).from(prItemsTable).where(eq(prItemsTable.purchaseReturnId, prId));
  const refund = items.reduce((s, r) => s + (r.lineRefundCenti ?? 0), 0);
  await db.update(prTable).set({ refundCenti: refund, updatedAt: new Date() }).where(eq(prTable.id, prId));
}

/* ── GRN->PR consumption helper (unified model, mirrors recomputeGrnInvoiced) ──
   Track grn_items.returned_qty as the SUM of qty_returned across LIVE
   (non-cancelled) purchase_return_items for this GRN line, clamped to
   [0, qty_accepted]. Then recompute the parent PO's received_qty (returning goods
   nets it down, re-opening the PO for a replacement shipment). `_delta` is
   ignored (kept for call-site compatibility; every caller mutated the PR rows
   BEFORE calling, so the live sum is authoritative). Best-effort. */
async function adjustGrnReturnedQty(db: Db, grnItemId: string, _delta?: number) {
  if (!grnItemId) return;
  const prLines = await db.select({ qtyReturned: prItemsTable.qtyReturned, purchaseReturnId: prItemsTable.purchaseReturnId }).from(prItemsTable).where(eq(prItemsTable.grnItemId, grnItemId));
  const prIds = [...new Set(prLines.map((r) => r.purchaseReturnId).filter(Boolean))];
  const cancelled = new Set<string>();
  if (prIds.length > 0) {
    const prs = await db.select({ id: prTable.id, status: prTable.status }).from(prTable).where(inArray(prTable.id, prIds));
    for (const p of prs) if ((p.status ?? "").toUpperCase() === "CANCELLED") cancelled.add(p.id);
  }
  let returned = 0;
  for (const r of prLines) if (!cancelled.has(r.purchaseReturnId)) returned += Number(r.qtyReturned ?? 0);

  const giRows = await db.select({ qtyAccepted: grnItemsTable.qtyAccepted, purchaseOrderItemId: grnItemsTable.purchaseOrderItemId }).from(grnItemsTable).where(eq(grnItemsTable.id, grnItemId)).limit(1);
  const gi = giRows[0];
  if (!gi) return;
  const accepted = gi.qtyAccepted ?? 0;
  const next = Math.min(accepted, Math.max(0, returned)); // clamp [0, accepted]
  await db.update(grnItemsTable).set({ returnedQty: next }).where(eq(grnItemsTable.id, grnItemId));
  // Net down the parent PO line's received_qty (re-opens for a replacement).
  const poItemId = gi.purchaseOrderItemId;
  if (poItemId) await recomputePoReceived(db, [poItemId]);
}

/* ── resolvePrLineWarehouses ───────────────────────────────────────────────
   PER-WAREHOUSE CORRECTNESS for the supplier-return side. A PR takes stock OUT
   of the warehouse the goods were RECEIVED into — the source GRN line's
   warehouse. A batched PR (/from-grns) can span warehouses, so resolve per line.
   Order: (1) source GRN line's GRN warehouse, (2) the primary GRN's warehouse
   (manual lines), (3) the global default warehouse. Returns id -> warehouse_id. */
async function resolvePrLineWarehouses(
  db: Db,
  items: Array<{ id: string; grn_item_id?: string | null }>,
  primaryGrnId: string | null,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const grnItemIds = [...new Set(items.map((it) => it.grn_item_id ?? null).filter((x): x is string => !!x))];

  const grnItemToGrn = new Map<string, string | null>();
  const grnIds = new Set<string>();
  if (grnItemIds.length > 0) {
    const giRows = await db.select({ id: grnItemsTable.id, grnId: grnItemsTable.grnId }).from(grnItemsTable).where(inArray(grnItemsTable.id, grnItemIds));
    for (const r of giRows) {
      grnItemToGrn.set(r.id, r.grnId ?? null);
      if (r.grnId) grnIds.add(r.grnId);
    }
  }
  if (primaryGrnId) grnIds.add(primaryGrnId);
  const grnWh = new Map<string, string | null>();
  if (grnIds.size > 0) {
    const grnRows = await db.select({ id: grnsTable.id, warehouseId: grnsTable.warehouseId }).from(grnsTable).where(inArray(grnsTable.id, [...grnIds]));
    for (const r of grnRows) grnWh.set(r.id, r.warehouseId ?? null);
  }

  const fallback = (primaryGrnId ? grnWh.get(primaryGrnId) ?? null : null) ?? (await defaultWarehouseId(db));
  for (const it of items) {
    const grnId = it.grn_item_id ? (grnItemToGrn.get(it.grn_item_id) ?? null) : null;
    const fromGrn = grnId ? (grnWh.get(grnId) ?? null) : null;
    out.set(it.id, fromGrn ?? fallback);
  }
  return out;
}

/* warehouseCodeMap — warehouse_id -> display CODE for the per-line Warehouse
   column on the PR detail GET. Read-only. Reads mfg_warehouses (cloned table). */
async function warehouseCodeMap(db: Db, ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const uniq = [...new Set(ids.filter((x): x is string => !!x))];
  if (uniq.length === 0) return out;
  const rows = await db.select({ id: warehousesTable.id, code: warehousesTable.code, name: warehousesTable.name }).from(warehousesTable).where(inArray(warehousesTable.id, uniq));
  for (const w of rows) out.set(w.id, w.code ?? w.name ?? "");
  return out;
}

/* ── writePurchaseReturnMovements ──────────────────────────────────────────
   The create path writes the inventory OUT for every initial line. Each line
   draws OUT of its source GRN line's warehouse (a batched PR can span warehouses),
   carrying the EXACT dye-lot batch the goods came in under at GRN time (the
   source GRN's IN movement stamped batch_no = source PO number, migration 0120;
   keyed warehouse+product+variant) so the FIFO trigger depletes THAT PO/lot. */
async function writePurchaseReturnMovements(db: Db, prId: string, returnNumber: string, grnId: string | null, userId: number) {
  const items = await db
    .select({ id: prItemsTable.id, grnItemId: prItemsTable.grnItemId, materialCode: prItemsTable.materialCode, materialName: prItemsTable.materialName, qtyReturned: prItemsTable.qtyReturned, itemGroup: prItemsTable.itemGroup, variants: prItemsTable.variants })
    .from(prItemsTable)
    .where(eq(prItemsTable.purchaseReturnId, prId));
  if (!items.length) return;
  const itemList = items.map((it) => ({ id: it.id, grn_item_id: it.grnItemId, material_code: it.materialCode, material_name: it.materialName, qty_returned: it.qtyReturned, item_group: it.itemGroup, variants: it.variants as VariantAttrs | null }));
  const lineWh = await resolvePrLineWarehouses(db, itemList, grnId);

  // PR line id -> source GRN id (its own GRN line's GRN, else the primary GRN).
  const lineGrnId = new Map<string, string | null>();
  {
    const giIds = [...new Set(itemList.map((it) => it.grn_item_id ?? null).filter((x): x is string => !!x))];
    const giToGrn = new Map<string, string | null>();
    if (giIds.length > 0) {
      const giRows = await db.select({ id: grnItemsTable.id, grnId: grnItemsTable.grnId }).from(grnItemsTable).where(inArray(grnItemsTable.id, giIds));
      for (const r of giRows) giToGrn.set(r.id, r.grnId ?? null);
    }
    for (const it of itemList) lineGrnId.set(it.id, (it.grn_item_id ? giToGrn.get(it.grn_item_id) : null) ?? grnId ?? null);
  }
  // Read the IN movements of every source GRN, keyed grnId::warehouse::code::variant -> batch_no.
  const batchByBucket = new Map<string, string>();
  {
    const srcGrnIds = [...new Set([...lineGrnId.values()].filter((x): x is string => !!x))];
    if (srcGrnIds.length > 0) {
      try {
        const inRows = await db
          .select({ sourceDocId: inventoryMovements.sourceDocId, productCode: inventoryMovements.productCode, variantKey: inventoryMovements.variantKey, warehouseId: inventoryMovements.warehouseId, batchNo: inventoryMovements.batchNo })
          .from(inventoryMovements)
          .where(and(eq(inventoryMovements.sourceDocType, "GRN"), eq(inventoryMovements.movementType, "IN"), inArray(inventoryMovements.sourceDocId, srcGrnIds)));
        for (const m of inRows) {
          if (m.batchNo == null || m.sourceDocId == null) continue;
          batchByBucket.set(`${m.sourceDocId}::${m.warehouseId}::${m.productCode}::${m.variantKey ?? ""}`, m.batchNo);
        }
      } catch {
        /* IN-movement read failed — every line un-batched (plain FIFO) */
      }
    }
  }

  const movements = itemList
    .filter((it) => it.qty_returned > 0)
    .map((it) => {
      const warehouseId = lineWh.get(it.id) ?? null;
      if (!warehouseId) return null;
      const variantKey = computeVariantKey(it.item_group, it.variants ?? null);
      const srcGrn = lineGrnId.get(it.id) ?? null;
      const batchNo = srcGrn ? (batchByBucket.get(`${srcGrn}::${warehouseId}::${it.material_code}::${variantKey}`) ?? null) : null;
      return {
        movement_type: "OUT" as const,
        warehouse_id: warehouseId,
        product_code: it.material_code,
        variant_key: variantKey,
        product_name: it.material_name,
        qty: it.qty_returned,
        source_doc_type: "PURCHASE_RETURN" as const,
        source_doc_id: prId,
        source_doc_no: returnNumber,
        ...(batchNo ? { batch_no: batchNo } : {}),
        performed_by: userId,
      };
    })
    .filter((m): m is NonNullable<typeof m> => m !== null);
  if (movements.length > 0) {
    await writeMovements(db, movements);
    /* PR post = stock OUT to supplier -> READY SOs that needed that stock may
       regress to PENDING. WIRED now that the SO slice has landed. Best-effort. */
    try {
      await recomputeSoStockAllocation(db);
    } catch (e) {
      console.error("[so-allocation] post-PR failed:", e);
    }
  }
}

/* ── writePrLineDeltaMovement ───────────────────────────────────────────────
   Line CRUD after create (add / edit qty / delete) moves real inventory:
   deltaQty>0 -> OUT (more goods leave to supplier); deltaQty<0 -> IN (goods come
   back). Resolves the line's source-GRN warehouse + its OWN dye-lot batch
   deterministically (grn_item_id -> purchase_order_item_id -> PO number).
   Reversing IN re-enters at the PR OUT's stamped cost. Best-effort. */
async function writePrLineDeltaMovement(
  db: Db,
  args: {
    prId: string;
    returnNumber: string;
    headerGrnId: string | null;
    userId: number;
    line: { id: string; grn_item_id?: string | null; material_code: string; material_name: string | null; item_group?: string | null; variants?: VariantAttrs | null };
    deltaQty: number;
  },
) {
  if (!args.deltaQty) return;
  try {
    const lineWh = await resolvePrLineWarehouses(db, [{ id: args.line.id, grn_item_id: args.line.grn_item_id ?? null }], args.headerGrnId);
    const warehouseId = lineWh.get(args.line.id) ?? null;
    if (!warehouseId) return;
    const variantKey = computeVariantKey(args.line.item_group, args.line.variants ?? null);
    const isOut = args.deltaQty > 0;
    // Batch: resolve THIS line's OWN dye-lot from its source GRN line's PO.
    let batchNo: string | null = null;
    if (args.line.grn_item_id) {
      const giRows = await db.select({ purchaseOrderItemId: grnItemsTable.purchaseOrderItemId }).from(grnItemsTable).where(eq(grnItemsTable.id, args.line.grn_item_id)).limit(1);
      const poItemId = giRows[0]?.purchaseOrderItemId ?? null;
      if (poItemId) batchNo = (await resolvePoBatchByItem(db, [poItemId])).get(poItemId) ?? null;
    }
    // Cost (reversing IN only): the PR OUT's stamped cost for this bucket.
    let unitCostSen = 0;
    if (!isOut) {
      const inRows = await db
        .select({ unitCostSen: inventoryMovements.unitCostSen })
        .from(inventoryMovements)
        .where(
          and(
            eq(inventoryMovements.sourceDocType, "PURCHASE_RETURN"),
            eq(inventoryMovements.sourceDocId, args.prId),
            eq(inventoryMovements.movementType, "OUT"),
            eq(inventoryMovements.warehouseId, warehouseId),
            eq(inventoryMovements.productCode, args.line.material_code),
            eq(inventoryMovements.variantKey, variantKey),
          ),
        )
        .limit(1);
      unitCostSen = Number(inRows[0]?.unitCostSen ?? 0);
    }
    await writeMovements(db, [
      {
        movement_type: isOut ? "OUT" : "IN",
        warehouse_id: warehouseId,
        product_code: args.line.material_code,
        variant_key: variantKey,
        product_name: args.line.material_name,
        qty: Math.abs(args.deltaQty),
        ...(isOut ? {} : { unit_cost_sen: unitCostSen }),
        ...(batchNo ? { batch_no: batchNo } : {}),
        source_doc_type: "PURCHASE_RETURN" as const,
        source_doc_id: args.prId,
        source_doc_no: args.returnNumber,
        performed_by: args.userId,
        notes: isOut ? "PR line added/increased" : "PR line reduced/removed — reversing return",
      },
    ]);
    /* PR line delta moved real stock -> re-walk SO allocation. WIRED now that
       the SO slice has landed. Best-effort. */
    try {
      await recomputeSoStockAllocation(db);
    } catch (e2) {
      console.error("[so-allocation] post-PR-line-delta failed:", e2);
    }
  } catch (e) {
    console.error("[pr-line-delta] movement failed:", e);
  }
}

/* PR line-lock: a CANCELLED / COMPLETED purchase return is terminal — its line
   CRUD moves real inventory, so editing a reversed PR would re-corrupt stock. */
async function prLineLock(db: Db, prId: string): Promise<{ error: string; message: string } | null> {
  const rows = await db.select({ status: prTable.status }).from(prTable).where(eq(prTable.id, prId)).limit(1);
  const st = rows[0]?.status;
  if (st === "CANCELLED") return { error: "pr_cancelled", message: "This purchase return is cancelled — its lines can no longer be changed." };
  if (st === "COMPLETED") return { error: "pr_completed", message: "This purchase return is completed — its lines can no longer be changed." };
  return null;
}

// ── List ────────────────────────────────────────────────────────────────
app.get("/", async (c) => {
  const db = getDb(c.env);
  const status = c.req.query("status");
  const supplierId = c.req.query("supplierId");
  const conds = [];
  if (status) conds.push(eq(prTable.status, status as "POSTED" | "COMPLETED" | "CANCELLED"));
  if (supplierId) conds.push(eq(prTable.supplierId, supplierId));
  try {
    const rows = await db
      .select({
        pr: prTable,
        supplier: { id: suppliersTable.id, code: suppliersTable.code, name: suppliersTable.name },
        purchase_order: { id: poTable.id, po_number: poTable.poNumber },
        grn: { id: grnsTable.id, grn_number: grnsTable.grnNumber },
      })
      .from(prTable)
      .leftJoin(suppliersTable, eq(prTable.supplierId, suppliersTable.id))
      .leftJoin(poTable, eq(prTable.purchaseOrderId, poTable.id))
      .leftJoin(grnsTable, eq(prTable.grnId, grnsTable.id))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(prTable.returnDate))
      .limit(300);
    const purchaseReturns = rows.map((r) => ({
      ...toPrHeaderResponse(r.pr),
      supplier: r.supplier?.id ? r.supplier : null,
      purchase_order: r.purchase_order?.id ? r.purchase_order : null,
      grn: r.grn?.id ? r.grn : null,
    }));
    return c.json({ purchaseReturns });
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
          pr: prTable,
          supplier: { id: suppliersTable.id, code: suppliersTable.code, name: suppliersTable.name, contact_person: suppliersTable.contactPerson, phone: suppliersTable.phone, email: suppliersTable.email, address: suppliersTable.address },
          purchase_order: { id: poTable.id, po_number: poTable.poNumber },
          grn: { id: grnsTable.id, grn_number: grnsTable.grnNumber },
        })
        .from(prTable)
        .leftJoin(suppliersTable, eq(prTable.supplierId, suppliersTable.id))
        .leftJoin(poTable, eq(prTable.purchaseOrderId, poTable.id))
        .leftJoin(grnsTable, eq(prTable.grnId, grnsTable.id))
        .where(eq(prTable.id, id))
        .limit(1),
      db.select().from(prItemsTable).where(eq(prItemsTable.purchaseReturnId, id)).orderBy(prItemsTable.createdAt),
    ]);
    const headerRow = headerRows[0];
    if (!headerRow) return c.json({ error: "not_found" }, 404);
    const purchaseReturn = {
      ...toPrHeaderResponse(headerRow.pr),
      supplier: headerRow.supplier?.id ? headerRow.supplier : null,
      purchase_order: headerRow.purchase_order?.id ? headerRow.purchase_order : null,
      grn: headerRow.grn?.id ? headerRow.grn : null,
    };
    /* Per-line Warehouse column: resolve the SAME warehouse the return OUT pulls
       stock from (grn_item -> GRN warehouse -> header GRN -> default). Display-only. */
    const rawItems = itemRows.map((it) => ({ ...toPrItemResponse(it), _grnItemId: it.grnItemId }));
    const headerGrnId = headerRow.pr.grnId ?? null;
    const lineWh = await resolvePrLineWarehouses(db, rawItems.map((it) => ({ id: it.id, grn_item_id: it._grnItemId })), headerGrnId);
    const codeMap = await warehouseCodeMap(db, [...lineWh.values()]);
    const items = rawItems.map((it) => {
      const wid = lineWh.get(it.id) ?? null;
      const { _grnItemId, ...rest } = it;
      void _grnItemId;
      return { ...rest, warehouse_id: wid, warehouse_code: wid ? (codeMap.get(wid) ?? null) : null };
    });
    return c.json({ purchaseReturn, items });
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
        id: prTable.id,
        grn: { id: grnsTable.id, grn_number: grnsTable.grnNumber },
        purchase_order: { id: poTable.id, po_number: poTable.poNumber },
      })
      .from(prTable)
      .leftJoin(grnsTable, eq(prTable.grnId, grnsTable.id))
      .leftJoin(poTable, eq(prTable.purchaseOrderId, poTable.id))
      .where(eq(prTable.id, id))
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
    return c.json({ error: "draft_status_not_supported", message: "DRAFT was removed in migration 0078 — PRs post immediately on create." }, 400);
  if (!body.supplierId) return c.json({ error: "supplier_required" }, 400);
  const items = body.items as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(items) || !items.length) return c.json({ error: "items_required" }, 400);

  const db = getDb(c.env);
  const user = c.get("user");
  const returnNumber = await nextNum(db);

  /* Clamp each GRN-linked line to its remaining (qty_accepted - returned_qty) so
     a bare create can't over-return. Manual lines uncapped. */
  const preGrnItemIds = [...new Set(items.map((it) => (it.grnItemId as string | undefined) ?? null).filter((x): x is string => !!x))];
  const remainingByGrnItem = new Map<string, number>();
  if (preGrnItemIds.length > 0) {
    const giRows = await db.select({ id: grnItemsTable.id, qtyAccepted: grnItemsTable.qtyAccepted, returnedQty: grnItemsTable.returnedQty }).from(grnItemsTable).where(inArray(grnItemsTable.id, preGrnItemIds));
    for (const r of giRows) remainingByGrnItem.set(r.id, Math.max(0, (r.qtyAccepted ?? 0) - (r.returnedQty ?? 0)));
  }

  let totalRefund = 0;
  const itemRows = items
    .map((it) => {
      const grnItemId = (it.grnItemId as string | undefined) ?? null;
      let qty = Number(it.qtyReturned ?? 0);
      if (grnItemId && remainingByGrnItem.has(grnItemId)) qty = Math.min(qty, remainingByGrnItem.get(grnItemId) as number);
      const unit = Number(it.unitPriceCenti ?? 0);
      const lineRefund = qty * unit;
      totalRefund += lineRefund;
      return {
        grnItemId,
        materialKind: (it.materialKind as "mfg_product" | "fabric" | "raw") ?? "mfg_product",
        materialCode: it.materialCode as string,
        materialName: it.materialName as string,
        qtyReturned: qty,
        unitPriceCenti: unit,
        lineRefundCenti: lineRefund,
        reason: (it.reason as string | undefined) ?? null,
        notes: (it.notes as string | undefined) ?? null,
        itemGroup: (it.itemGroup as string | null | undefined) ?? null,
        variants: (it.variants as Record<string, unknown> | null | undefined) ?? null,
      };
    })
    .filter((r) => Number(r.qtyReturned) > 0);

  if (itemRows.length === 0) return c.json({ error: "no_returnable_qty", message: "Every line is already fully returned (nothing left to return)." }, 400);

  const grnId = (body.grnId as string | undefined) ?? null;
  let header: { id: string; returnNumber: string };
  try {
    const inserted = await db
      .insert(prTable)
      .values({
        returnNumber,
        purchaseOrderId: (body.purchaseOrderId as string | undefined) ?? null,
        grnId,
        supplierId: body.supplierId as string,
        returnDate: (body.returnDate as string) ?? new Date().toISOString().slice(0, 10),
        reason: (body.reason as string | undefined) ?? null,
        refundCenti: totalRefund,
        notes: (body.notes as string | undefined) ?? null,
        status: "POSTED",
        postedAt: new Date(),
        createdBy: user.id,
      } as never)
      .returning({ id: prTable.id, returnNumber: prTable.returnNumber });
    header = inserted[0];
  } catch (e) {
    return c.json({ error: "insert_failed", reason: errMsg(e) }, 500);
  }

  const rowsWithId = itemRows.map((r) => ({ ...r, purchaseReturnId: header.id }));
  try {
    await db.insert(prItemsTable).values(rowsWithId as never);
  } catch (iErr) {
    await db.delete(prTable).where(eq(prTable.id, header.id));
    return c.json({ error: "items_insert_failed", reason: errMsg(iErr) }, 500);
  }

  await writePurchaseReturnMovements(db, header.id, header.returnNumber, grnId, user.id);

  // Consume each GRN-linked line's returned_qty + re-open the PO.
  for (const r of itemRows) {
    if (r.grnItemId) await adjustGrnReturnedQty(db, r.grnItemId, Number(r.qtyReturned));
  }

  return c.json({ id: header.id, returnNumber: header.returnNumber }, 201);
});

/* ── POST /from-grns — batch-convert many POSTED GRNs into ONE PR ───────────
   Aggregates qty_rejected lines across the selected GRNs (must share a supplier),
   capped at each line's remaining (qty_accepted - returned_qty). */
app.post("/from-grns", async (c) => {
  const db = getDb(c.env);
  const user = c.get("user");
  let body: { grnIds?: string[]; reason?: string; notes?: string };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const grnIds = body.grnIds ?? [];
  if (grnIds.length === 0) return c.json({ error: "grn_ids_required" }, 400);

  let grnList: Array<{ id: string; grnNumber: string; supplierId: string; purchaseOrderId: string | null; status: string }>;
  try {
    grnList = await db.select({ id: grnsTable.id, grnNumber: grnsTable.grnNumber, supplierId: grnsTable.supplierId, purchaseOrderId: grnsTable.purchaseOrderId, status: grnsTable.status }).from(grnsTable).where(inArray(grnsTable.id, grnIds));
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
  if (grnList.length === 0) return c.json({ error: "grns_not_found" }, 404);

  const notPosted = grnList.filter((g) => g.status !== "POSTED");
  if (notPosted.length > 0) return c.json({ error: "not_all_posted", message: `These GRNs are not POSTED: ${notPosted.map((g) => g.grnNumber).join(", ")}` }, 400);
  const supplierIds = new Set(grnList.map((g) => g.supplierId));
  if (supplierIds.size > 1) return c.json({ error: "mixed_suppliers", message: "All selected GRNs must be from the same supplier" }, 400);
  const supplierId = [...supplierIds][0]!;

  const items = await db.select().from(grnItemsTable).where(and(inArray(grnItemsTable.grnId, grnIds), gt(grnItemsTable.qtyRejected, 0)));
  const rejectedItems = items
    .map((it) => {
      const remaining = (it.qtyAccepted ?? 0) - (it.returnedQty ?? 0);
      return { ...it, _qty: Math.min(it.qtyRejected ?? 0, Math.max(0, remaining)) };
    })
    .filter((it) => it._qty > 0);
  if (rejectedItems.length === 0) return c.json({ error: "no_rejected_qty", message: "None of the selected GRNs have remaining rejected qty to return" }, 400);

  const returnNumber = await nextNum(db);
  const grnNumbersJoined = grnList.map((g) => g.grnNumber).join(", ");
  const totalRefund = rejectedItems.reduce((s, it) => s + it._qty * it.unitPriceCenti, 0);
  const primaryGrnId = grnList[0]!.id;

  let header: { id: string; returnNumber: string };
  try {
    const inserted = await db
      .insert(prTable)
      .values({
        returnNumber,
        purchaseOrderId: grnList[0]!.purchaseOrderId,
        grnId: primaryGrnId,
        supplierId,
        returnDate: new Date().toISOString().slice(0, 10),
        reason: body.reason ?? `Batch from ${grnList.length} GRNs: ${grnNumbersJoined}`,
        refundCenti: totalRefund,
        notes: body.notes ?? null,
        status: "POSTED",
        postedAt: new Date(),
        createdBy: user.id,
      } as never)
      .returning({ id: prTable.id, returnNumber: prTable.returnNumber });
    header = inserted[0];
  } catch (e) {
    return c.json({ error: "insert_failed", reason: errMsg(e) }, 500);
  }

  const rows = rejectedItems.map((it) => ({
    purchaseReturnId: header.id,
    grnItemId: it.id,
    materialKind: it.materialKind,
    materialCode: it.materialCode,
    materialName: it.materialName,
    qtyReturned: it._qty,
    unitPriceCenti: it.unitPriceCenti,
    lineRefundCenti: it._qty * it.unitPriceCenti,
    reason: it.rejectionReason,
    itemGroup: it.itemGroup,
    variants: it.variants,
    description: it.description,
    // description2 server-owned in 2990s via buildVariantSummary (dropped) — keep stored value.
    description2: it.description2 ?? null,
    uom: it.uom ?? "UNIT",
  }));
  try {
    await db.insert(prItemsTable).values(rows as never);
  } catch (iErr) {
    await db.delete(prTable).where(eq(prTable.id, header.id));
    return c.json({ error: "items_insert_failed", reason: errMsg(iErr) }, 500);
  }

  // Consume each GRN line's returned_qty (+ PO re-open).
  for (const it of rejectedItems) await adjustGrnReturnedQty(db, it.id, it._qty);

  await writePurchaseReturnMovements(db, header.id, header.returnNumber, primaryGrnId, user.id);

  return c.json({ id: header.id, returnNumber: header.returnNumber, grnCount: grnList.length, lineCount: rejectedItems.length }, 201);
});

/* ── POST /from-grn ─────────────────────────────────────────────────────
   Single-GRN convert (GRN list right-click "Convert to PR"). Copies the GRN's
   remaining lines (qty_accepted - returned_qty > 0) into a NEW PR. Body:
   { grnId, reason?, notes? } -> 201 { id, returnNumber }. */
app.post("/from-grn", async (c) => {
  const db = getDb(c.env);
  const user = c.get("user");
  let body: { grnId?: string; reason?: string; notes?: string };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const grnId = body.grnId;
  if (!grnId) return c.json({ error: "grn_id_required" }, 400);

  const grnRows = await db.select({ id: grnsTable.id, grnNumber: grnsTable.grnNumber, supplierId: grnsTable.supplierId, purchaseOrderId: grnsTable.purchaseOrderId, status: grnsTable.status }).from(grnsTable).where(eq(grnsTable.id, grnId)).limit(1);
  const g = grnRows[0];
  if (!g) return c.json({ error: "grn_not_found" }, 404);
  if (g.status !== "POSTED") return c.json({ error: "grn_not_posted", status: g.status }, 409);

  const allLines = await db.select().from(grnItemsTable).where(and(eq(grnItemsTable.grnId, grnId), gt(grnItemsTable.qtyAccepted, 0)));
  const lines = allLines
    .map((it) => ({ ...it, _remaining: (it.qtyAccepted ?? 0) - (it.returnedQty ?? 0) }))
    .filter((it) => it._remaining > 0);
  if (lines.length === 0) return c.json({ error: "nothing_to_return", message: "GRN is fully returned" }, 400);

  const returnNumber = await nextNum(db);
  const totalRefund = lines.reduce((s, it) => s + it._remaining * it.unitPriceCenti, 0);

  let header: { id: string; returnNumber: string };
  try {
    const inserted = await db
      .insert(prTable)
      .values({
        returnNumber,
        purchaseOrderId: g.purchaseOrderId,
        grnId: g.id,
        supplierId: g.supplierId,
        returnDate: new Date().toISOString().slice(0, 10),
        reason: body.reason ?? `From ${g.grnNumber}`,
        refundCenti: totalRefund,
        notes: body.notes ?? null,
        status: "POSTED",
        postedAt: new Date(),
        createdBy: user.id,
      } as never)
      .returning({ id: prTable.id, returnNumber: prTable.returnNumber });
    header = inserted[0];
  } catch (e) {
    return c.json({ error: "insert_failed", reason: errMsg(e) }, 500);
  }

  const rows = lines.map((it) => ({
    purchaseReturnId: header.id,
    grnItemId: it.id,
    materialKind: it.materialKind,
    materialCode: it.materialCode,
    materialName: it.materialName,
    qtyReturned: it._remaining,
    unitPriceCenti: it.unitPriceCenti,
    lineRefundCenti: it._remaining * it.unitPriceCenti,
    reason: it.rejectionReason,
    itemGroup: it.itemGroup,
    variants: it.variants,
    description: it.description,
    description2: it.description2 ?? null,
    uom: it.uom ?? "UNIT",
  }));
  try {
    await db.insert(prItemsTable).values(rows as never);
  } catch (iErr) {
    await db.delete(prTable).where(eq(prTable.id, header.id));
    return c.json({ error: "items_insert_failed", reason: errMsg(iErr) }, 500);
  }

  for (const it of lines) await adjustGrnReturnedQty(db, it.id, it._remaining);

  await writePurchaseReturnMovements(db, header.id, header.returnNumber, g.id, user.id);
  await recomputePrTotals(db, header.id);

  return c.json({ id: header.id, returnNumber: header.returnNumber }, 201);
});

// ── PATCH /:id/post — idempotent no-op (POSTED-on-create) ──────────────────
app.patch("/:id/post", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const rows = await db.select({ id: prTable.id, status: prTable.status, postedAt: prTable.postedAt, returnNumber: prTable.returnNumber, grnId: prTable.grnId }).from(prTable).where(eq(prTable.id, id)).limit(1);
  const row = rows[0];
  if (!row) return c.json({ error: "not_found" }, 404);
  if (row.status === "POSTED" || row.status === "COMPLETED") return c.json({ purchaseReturn: row });
  return c.json({ error: "cannot_post", message: `Cannot post a ${row.status} return.` }, 409);
});

// ── PATCH /:id/complete — POSTED -> COMPLETED (with CN ref) ─────────────────
app.patch("/:id/complete", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  let body: { creditNoteRef?: string };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    body = {};
  }
  const updates: Record<string, unknown> = { status: "COMPLETED", completedAt: new Date(), updatedAt: new Date() };
  if (body.creditNoteRef) updates.creditNoteRef = body.creditNoteRef;
  try {
    const updated = await db
      .update(prTable)
      .set(updates)
      .where(and(eq(prTable.id, id), eq(prTable.status, "POSTED")))
      .returning({ id: prTable.id, status: prTable.status, completed_at: prTable.completedAt });
    if (!updated[0]) return c.json({ error: "not_posted" }, 409);
    return c.json({ purchaseReturn: updated[0] });
  } catch (e) {
    return c.json({ error: "complete_failed", reason: errMsg(e) }, 500);
  }
});

/* ── PATCH /:id/cancel — cancel a PR + reverse its return ───────────────────
   1. status='CANCELLED' (idempotent — already-cancelled echoes back; a COMPLETED
      return cannot be cancelled). 2. Reverses the inventory OUT: writes an IN per
   bucket carrying the EXACT batch_no + cost the OUT stamped (reverseMovements,
   signed-net-per-bucket idempotent). 3. Releases returned_qty. Steps 2/3 are
   best-effort — never un-cancel on a movement failure. */
app.patch("/:id/cancel", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const user = c.get("user");

  const curRows = await db.select({ id: prTable.id, status: prTable.status, returnNumber: prTable.returnNumber, grnId: prTable.grnId }).from(prTable).where(eq(prTable.id, id)).limit(1);
  const head = curRows[0];
  if (!head) return c.json({ error: "not_found" }, 404);
  if (head.status === "COMPLETED") return c.json({ error: "cannot_cancel", message: "Already completed" }, 409);
  if (head.status === "CANCELLED") return c.json({ purchaseReturn: { id, status: "CANCELLED" } });

  /* ATOMIC single ACTIVE->CANCELLED transition — the conditional UPDATE excludes
     COMPLETED and CANCELLED so two concurrent cancels race + only ONE flips it,
     so the inventory reversal + release below run exactly once. */
  let updRow: { id: string } | undefined;
  try {
    const upd = await db
      .update(prTable)
      .set({ status: "CANCELLED", updatedAt: new Date() })
      .where(and(eq(prTable.id, id), ne(prTable.status, "CANCELLED"), ne(prTable.status, "COMPLETED")))
      .returning({ id: prTable.id });
    updRow = upd[0];
  } catch (e) {
    return c.json({ error: "cancel_failed", reason: errMsg(e) }, 500);
  }
  if (!updRow) {
    const nowRows = await db.select({ status: prTable.status }).from(prTable).where(eq(prTable.id, id)).limit(1);
    const st = nowRows[0]?.status;
    if (st === "CANCELLED") return c.json({ purchaseReturn: { id, status: "CANCELLED" } });
    if (st === "COMPLETED") return c.json({ error: "cannot_cancel", message: "Already completed" }, 409);
    return c.json({ error: "cannot_cancel" }, 409);
  }

  // Reverse the inventory OUT via the shared helper: reads THIS PR's own OUT
  // movements + posts an opposite IN per bucket carrying the EXACT batch_no +
  // unit_cost_sen the OUT stamped (idempotent, per-line-warehouse aware).
  try {
    await reverseMovements(db, "PURCHASE_RETURN", id, user.id);
    /* PR cancel reversed the OUT (stock IN) -> PENDING SOs that stock now covers
       may flip to READY. WIRED now that the SO slice has landed. Best-effort. */
    try {
      await recomputeSoStockAllocation(db);
    } catch (e) {
      console.error("[so-allocation] post-PR-cancel failed:", e);
    }
  } catch {
    /* best-effort: never un-cancel on a movement failure */
  }

  // Release the GRN-line consumption: decrement returned_qty for every GRN-linked
  // line. The lines are reloaded so we know each line's qty_returned + grn_item_id.
  try {
    const relLines = await db.select({ qtyReturned: prItemsTable.qtyReturned, grnItemId: prItemsTable.grnItemId }).from(prItemsTable).where(eq(prItemsTable.purchaseReturnId, id));
    for (const l of relLines) {
      if (l.grnItemId) await adjustGrnReturnedQty(db, l.grnItemId, -(l.qtyReturned ?? 0));
    }
  } catch {
    /* best-effort */
  }

  return c.json({ purchaseReturn: { id, status: "CANCELLED" } });
});

/* ════════════════════════════════════════════════════════════════════════
   PR PO-clone CRUD (PATCH header + line add / edit / delete) — mirrors the GRN
   detail page's immediate-save editing. The editable line quantity is
   qty_returned; line_refund_centi = qty_returned * unit_price_centi (no
   discount/delivery); recomputePrTotals rolls the header refund_centi. Line CRUD
   moves real inventory (writePrLineDeltaMovement).
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
    ["returnDate", "returnDate"],
    ["reason", "reason"],
    ["creditNoteRef", "creditNoteRef"],
    ["notes", "notes"],
  ] as const) {
    if (body[from] !== undefined) updates[to] = body[from];
  }
  try {
    const updated = await db.update(prTable).set(updates).where(eq(prTable.id, id)).returning();
    if (!updated[0]) return c.json({ error: "not_found" }, 404);
    return c.json({ purchaseReturn: toPrHeaderResponse(updated[0]) });
  } catch (e) {
    return c.json({ error: "update_failed", reason: errMsg(e) }, 500);
  }
});

// ── POST /:id/items — add one purchase_return_item. qty -> qty_returned. ──
app.post("/:id/items", async (c) => {
  const db = getDb(c.env);
  const prId = c.req.param("id");
  const user = c.get("user");
  let it: Record<string, unknown>;
  try {
    it = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  if (!it.materialCode) return c.json({ error: "material_code_required" }, 400);
  if (!it.materialName) return c.json({ error: "material_name_required" }, 400);

  const lock = await prLineLock(db, prId);
  if (lock) return c.json(lock, 409);
  const qtyReturned = Number(it.qty ?? 1);
  const unitPriceCenti = Number(it.unitPriceCenti ?? 0);
  const lineRefund = qtyReturned * unitPriceCenti;

  // GRN-linked line: cap qty at that GRN line's remaining (accepted - returned).
  const grnItemId = (it.grnItemId as string) ?? null;
  if (grnItemId) {
    const giRows = await db.select({ qtyAccepted: grnItemsTable.qtyAccepted, returnedQty: grnItemsTable.returnedQty }).from(grnItemsTable).where(eq(grnItemsTable.id, grnItemId)).limit(1);
    const g = giRows[0];
    if (g) {
      const remaining = (g.qtyAccepted ?? 0) - (g.returnedQty ?? 0);
      if (qtyReturned > remaining) return c.json({ error: "qty_exceeds_remaining", requested: qtyReturned, remaining }, 409);
    }
  }

  const row = {
    purchaseReturnId: prId,
    grnItemId,
    materialKind: ((it.materialKind as string) ?? "mfg_product") as "mfg_product" | "fabric" | "raw",
    materialCode: it.materialCode as string,
    materialName: it.materialName as string,
    qtyReturned,
    unitPriceCenti,
    lineRefundCenti: lineRefund,
    reason: (it.reason as string) ?? null,
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
    // description2 server-owned in 2990s via buildVariantSummary (dropped) — pass through.
    description2: (it.description2 as string) ?? null,
    uom: (it.uom as string) ?? "UNIT",
  };
  let inserted: typeof prItemsTable.$inferSelect;
  try {
    const ins = await db.insert(prItemsTable).values(row as never).returning();
    inserted = ins[0];
  } catch (e) {
    return c.json({ error: "insert_failed", reason: errMsg(e) }, 500);
  }

  /* POST-INSERT over-return verification (race guard). If our insert broke the
     cap (qty_accepted), delete it + 409. */
  if (grnItemId) {
    const giRows = await db.select({ qtyAccepted: grnItemsTable.qtyAccepted }).from(grnItemsTable).where(eq(grnItemsTable.id, grnItemId)).limit(1);
    const g = giRows[0];
    if (g) {
      const cap = g.qtyAccepted ?? 0;
      const sibRows = await db.select({ qtyReturned: prItemsTable.qtyReturned, purchaseReturnId: prItemsTable.purchaseReturnId }).from(prItemsTable).where(eq(prItemsTable.grnItemId, grnItemId));
      const prIds = [...new Set(sibRows.map((r) => r.purchaseReturnId))];
      const cancelled = new Set<string>();
      if (prIds.length > 0) {
        const prs = await db.select({ id: prTable.id, status: prTable.status }).from(prTable).where(inArray(prTable.id, prIds));
        for (const p of prs) if (p.status === "CANCELLED") cancelled.add(p.id);
      }
      const liveReturned = sibRows.filter((r) => !cancelled.has(r.purchaseReturnId)).reduce((s, r) => s + Number(r.qtyReturned ?? 0), 0);
      if (liveReturned > cap && inserted?.id) {
        await db.delete(prItemsTable).where(eq(prItemsTable.id, inserted.id));
        return c.json({ error: "qty_exceeds_remaining", requested: qtyReturned, remaining: cap - (liveReturned - qtyReturned) }, 409);
      }
    }
  }

  // Consume the GRN line if GRN-linked + write the inventory OUT for the new line.
  if (grnItemId) await adjustGrnReturnedQty(db, grnItemId, qtyReturned);
  await recomputePrTotals(db, prId);

  if (qtyReturned > 0 && inserted?.id) {
    const hdrRows = await db.select({ returnNumber: prTable.returnNumber, grnId: prTable.grnId }).from(prTable).where(eq(prTable.id, prId)).limit(1);
    const hdr = hdrRows[0];
    if (hdr) {
      await writePrLineDeltaMovement(db, {
        prId,
        returnNumber: hdr.returnNumber,
        headerGrnId: hdr.grnId ?? null,
        userId: user.id,
        line: { id: inserted.id, grn_item_id: grnItemId, material_code: String(it.materialCode), material_name: (it.materialName as string | null) ?? null, item_group: (it.itemGroup as string | null) ?? null, variants: (it.variants as VariantAttrs | null) ?? null },
        deltaQty: qtyReturned,
      });
    }
  }
  return c.json({ item: toPrItemResponse(inserted) }, 201);
});

// ── PATCH /:id/items/:itemId — partial line update. qty -> qty_returned. ──
app.patch("/:id/items/:itemId", async (c) => {
  const db = getDb(c.env);
  const prId = c.req.param("id");
  const itemId = c.req.param("itemId");
  const user = c.get("user");
  let it: Record<string, unknown>;
  try {
    it = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const lock = await prLineLock(db, prId);
  if (lock) return c.json(lock, 409);

  /* Scope the line to THIS PR: a mismatched itemId must 404. */
  const prevRows = await db
    .select({ qtyReturned: prItemsTable.qtyReturned, unitPriceCenti: prItemsTable.unitPriceCenti, itemGroup: prItemsTable.itemGroup, variants: prItemsTable.variants, grnItemId: prItemsTable.grnItemId, materialCode: prItemsTable.materialCode, materialName: prItemsTable.materialName })
    .from(prItemsTable)
    .where(and(eq(prItemsTable.id, itemId), eq(prItemsTable.purchaseReturnId, prId)))
    .limit(1);
  const prev = prevRows[0];
  if (!prev) return c.json({ error: "not_found" }, 404);

  const prevQty = prev.qtyReturned;
  const grnItemId = prev.grnItemId ?? null;
  const qtyReturned = it.qty !== undefined ? Number(it.qty) : prevQty;
  const unit = it.unitPriceCenti !== undefined ? Number(it.unitPriceCenti) : prev.unitPriceCenti;
  const lineRefund = qtyReturned * unit;

  const updates: Record<string, unknown> = { qtyReturned, unitPriceCenti: unit, lineRefundCenti: lineRefund };
  for (const [from, to] of [
    ["materialCode", "materialCode"],
    ["materialName", "materialName"],
    ["itemGroup", "itemGroup"],
    ["description", "description"],
    ["uom", "uom"],
    ["reason", "reason"],
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
  /* description2 server-owned in 2990s via buildVariantSummary (dropped) — client value or untouched. */

  // GRN-linked + qty changed: pre-check the delta won't push over accepted
  // (headroom = accepted - (returned - prevQty)).
  const delta = qtyReturned - prevQty;
  if (grnItemId && delta !== 0) {
    const giRows = await db.select({ qtyAccepted: grnItemsTable.qtyAccepted, returnedQty: grnItemsTable.returnedQty }).from(grnItemsTable).where(eq(grnItemsTable.id, grnItemId)).limit(1);
    const g = giRows[0];
    if (g) {
      const headroom = (g.qtyAccepted ?? 0) - ((g.returnedQty ?? 0) - prevQty);
      if (qtyReturned > headroom) return c.json({ error: "qty_exceeds_remaining", requested: qtyReturned, remaining: headroom }, 409);
    }
  }

  try {
    await db.update(prItemsTable).set(updates).where(eq(prItemsTable.id, itemId));
  } catch (e) {
    return c.json({ error: "update_failed", reason: errMsg(e) }, 500);
  }
  if (grnItemId && delta !== 0) await adjustGrnReturnedQty(db, grnItemId, delta);
  await recomputePrTotals(db, prId);

  // Write the compensating inventory movement for the qty change.
  if (delta !== 0) {
    const hdrRows = await db.select({ returnNumber: prTable.returnNumber, grnId: prTable.grnId }).from(prTable).where(eq(prTable.id, prId)).limit(1);
    const hdr = hdrRows[0];
    if (hdr) {
      const effGroup = (it.itemGroup ?? prev.itemGroup) as string | null | undefined;
      const effVariants = (it.variants ?? prev.variants) as VariantAttrs | null | undefined;
      await writePrLineDeltaMovement(db, {
        prId,
        returnNumber: hdr.returnNumber,
        headerGrnId: hdr.grnId ?? null,
        userId: user.id,
        line: { id: itemId, grn_item_id: grnItemId, material_code: String(it.materialCode ?? prev.materialCode), material_name: ((it.materialName ?? prev.materialName) as string | null) ?? null, item_group: effGroup ?? null, variants: effVariants ?? null },
        deltaQty: delta,
      });
    }
  }
  return c.json({ ok: true });
});

// ── DELETE /:id/items/:itemId — remove a line + recompute header. ──
app.delete("/:id/items/:itemId", async (c) => {
  const db = getDb(c.env);
  const prId = c.req.param("id");
  const itemId = c.req.param("itemId");
  const user = c.get("user");
  const lock = await prLineLock(db, prId);
  if (lock) return c.json(lock, 409);

  const lineRows = await db
    .select({ qtyReturned: prItemsTable.qtyReturned, grnItemId: prItemsTable.grnItemId, materialCode: prItemsTable.materialCode, materialName: prItemsTable.materialName, itemGroup: prItemsTable.itemGroup, variants: prItemsTable.variants })
    .from(prItemsTable)
    .where(and(eq(prItemsTable.id, itemId), eq(prItemsTable.purchaseReturnId, prId)))
    .limit(1);
  const line = lineRows[0];
  if (!line) return c.json({ error: "not_found" }, 404);
  try {
    await db.delete(prItemsTable).where(eq(prItemsTable.id, itemId));
  } catch (e) {
    return c.json({ error: "delete_failed", reason: errMsg(e) }, 500);
  }

  // Release: decrement returned_qty by the deleted line's qty.
  if (line.grnItemId) await adjustGrnReturnedQty(db, line.grnItemId, -(line.qtyReturned ?? 0));

  // Deleting a line reverses its return: bring the goods back IN (deltaQty negative).
  const qty = Number(line.qtyReturned ?? 0);
  if (qty > 0) {
    const hdrRows = await db.select({ returnNumber: prTable.returnNumber, grnId: prTable.grnId }).from(prTable).where(eq(prTable.id, prId)).limit(1);
    const hdr = hdrRows[0];
    if (hdr) {
      await writePrLineDeltaMovement(db, {
        prId,
        returnNumber: hdr.returnNumber,
        headerGrnId: hdr.grnId ?? null,
        userId: user.id,
        line: { id: itemId, grn_item_id: line.grnItemId, material_code: line.materialCode, material_name: line.materialName, item_group: line.itemGroup, variants: line.variants as VariantAttrs | null },
        deltaQty: -qty,
      });
    }
  }
  await recomputePrTotals(db, prId);
  return c.body(null, 204);
});

export default app;
