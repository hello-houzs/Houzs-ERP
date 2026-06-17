// ----------------------------------------------------------------------------
// /purchase-consignment-orders — PC Orders to suppliers for goods held on
// CONSIGNMENT (the supplier's stock parked at MY warehouse). ORDER-ONLY (no
// inventory): the order itself writes no inventory_movements; its receive/return
// children are on-ledger.
//
// 1:1 clone of 2990s apps/api/src/routes/purchase-consignment-orders.ts (itself a
// clone of mfg-purchase-orders with the owned-PO pipeline stripped). Endpoints,
// request bodies, response JSON shapes, status codes and business rules
// (SUBMITTED-on-create, child-lock vs PC Receives, cancel/delete, line CRUD) kept
// identical to 2990s. Only the SEAMS change (same playbook as prior slices):
//   - DB client: 2990s per-request createClient / c.get('supabase') -> Houzs
//     getDb (rule #3). Every PostgREST chain -> a Drizzle query, same JSON in/out.
//     Drizzle returns camelCase rows -> toX*Response() mappers emit the snake_case
//     wire shape 2990s's frontend expects (rule #7).
//   - Auth: 2990s supabaseAuth -> Houzs requirePermission("*") (rule #4).
//   - created_by: 2990s staff.id (uuid) -> Houzs users.id (integer) (rule #4).
//   - Mount path: /api/purchase-consignment-orders.
//
// Strategy-2: DROPPED buildVariantSummary (description2 is server-owned in 2990s
// via that sofa formatter) -> the client's description2 is passed through; the
// variant columns are still persisted for fidelity.
// ----------------------------------------------------------------------------

import { Hono } from "hono";
import { and, asc, desc, eq, inArray, like, ne } from "drizzle-orm";
import type { Env } from "../types";
import { getDb } from "../db/client";
import {
  purchaseConsignmentOrders as pcoTable,
  purchaseConsignmentOrderItems as pcoItemsTable,
  purchaseConsignmentReceives as pcrTable,
  purchaseConsignmentReceiveItems as pcrItemsTable,
  purchaseConsignmentReturns as pctTable,
  suppliers as suppliersTable,
} from "../db/schema";
import { requirePermission } from "../middleware/auth";

const app = new Hono<{ Bindings: Env }>();

// Owner-only for now (rule #4). Gate every route in this module.
app.use("*", requirePermission("*"));

const VALID_STATUSES = new Set(["SUBMITTED", "PARTIALLY_RECEIVED", "RECEIVED", "CANCELLED"]);
const VALID_CURRENCIES = new Set(["MYR", "RMB", "USD", "SGD"]);
const VALID_KINDS = new Set(["mfg_product", "fabric", "raw"]);

type Db = ReturnType<typeof getDb>;

const yymm = (): string => {
  const d = new Date();
  return `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, "0")}`;
};

/* ── PC Order child-lock guard (Tier 2 — downstream lock) ────────────────────
   A PC Order locks (read-only — no header edit / no line edit / no cancel) once
   it has ANY non-cancelled PC Receive. Mirrors 2990s pcoHasDownstream. */
async function pcoHasDownstream(db: Db, pcoId: string): Promise<{ error: string; message: string } | null> {
  const rows = await db
    .select({ id: pcrTable.id })
    .from(pcrTable)
    .where(and(eq(pcrTable.purchaseConsignmentOrderId, pcoId), ne(pcrTable.status, "CANCELLED")));
  if (rows.length > 0) {
    return { error: "pco_has_downstream", message: "PC Order has a Consignment Receive — delete or cancel it first to edit" };
  }
  return null;
}

/* Per-line receive breakdown — which PC Receive(s) each PC Order line was
   received into. Net qty = qty_accepted − returned_qty; zero/negative dropped.
   Cancelled receives excluded. (2990s pcoLineReceipts.) */
type PcoLineReceipt = { receiveNumber: string; qty: number; status: string };
async function pcoLineReceipts(db: Db, pcoItemIds: string[]): Promise<Map<string, PcoLineReceipt[]>> {
  const out = new Map<string, PcoLineReceipt[]>();
  if (pcoItemIds.length === 0) return out;
  const recvLines = await db
    .select({
      pcOrderItemId: pcrItemsTable.pcOrderItemId,
      qtyAccepted: pcrItemsTable.qtyAccepted,
      returnedQty: pcrItemsTable.returnedQty,
      pcReceiveId: pcrItemsTable.pcReceiveId,
    })
    .from(pcrItemsTable)
    .where(inArray(pcrItemsTable.pcOrderItemId, pcoItemIds));
  const recvIds = [...new Set(recvLines.map((r) => r.pcReceiveId).filter((x): x is string => !!x))];
  if (recvIds.length === 0) return out;
  const receives = await db
    .select({ id: pcrTable.id, receiveNumber: pcrTable.receiveNumber, status: pcrTable.status })
    .from(pcrTable)
    .where(inArray(pcrTable.id, recvIds));
  const recvMeta = new Map<string, { receiveNumber: string; status: string }>();
  for (const g of receives) {
    if ((g.status ?? "").toUpperCase() === "CANCELLED") continue;
    recvMeta.set(g.id, { receiveNumber: g.receiveNumber ?? "—", status: (g.status ?? "").toUpperCase() });
  }
  for (const r of recvLines) {
    if (!r.pcOrderItemId) continue;
    const meta = recvMeta.get(r.pcReceiveId);
    if (!meta) continue;
    const net = Number(r.qtyAccepted ?? 0) - Number(r.returnedQty ?? 0);
    if (net <= 0) continue;
    const arr = out.get(r.pcOrderItemId) ?? [];
    arr.push({ receiveNumber: meta.receiveNumber, qty: net, status: meta.status });
    out.set(r.pcOrderItemId, arr);
  }
  return out;
}

/* Drizzle camelCase row -> 2990s snake_case wire shape (rule #7). */
type PcoHeaderRow = typeof pcoTable.$inferSelect;
type PcoItemRow = typeof pcoItemsTable.$inferSelect;
type SupplierLite = { id: string; code: string; name: string } | null;

function toPcoResponse(r: PcoHeaderRow, supplier?: SupplierLite, items?: Array<{ material_code: string; material_name: string; qty: number }>) {
  return {
    id: r.id,
    pc_number: r.pcNumber,
    supplier_id: r.supplierId,
    status: r.status,
    po_date: r.poDate,
    expected_at: r.expectedAt,
    currency: r.currency,
    subtotal_centi: r.subtotalCenti,
    tax_centi: r.taxCenti,
    total_centi: r.totalCenti,
    notes: r.notes,
    submitted_at: r.submittedAt,
    received_at: r.receivedAt,
    cancelled_at: r.cancelledAt,
    created_at: r.createdAt,
    created_by: r.createdBy,
    updated_at: r.updatedAt,
    purchase_location_id: r.purchaseLocationId,
    ...(supplier !== undefined ? { supplier } : {}),
    ...(items !== undefined ? { items } : {}),
  };
}

function toPcoItemResponse(r: PcoItemRow) {
  return {
    id: r.id,
    purchase_consignment_order_id: r.purchaseConsignmentOrderId,
    binding_id: r.bindingId,
    material_kind: r.materialKind,
    material_code: r.materialCode,
    material_name: r.materialName,
    supplier_sku: r.supplierSku,
    qty: r.qty,
    unit_price_centi: r.unitPriceCenti,
    line_total_centi: r.lineTotalCenti,
    received_qty: r.receivedQty,
    notes: r.notes,
    created_at: r.createdAt,
    item_group: r.itemGroup,
    description: r.description,
    description2: r.description2,
    uom: r.uom,
    discount_centi: r.discountCenti,
    unit_cost_centi: r.unitCostCenti,
    gap_inches: r.gapInches,
    divan_height_inches: r.divanHeightInches,
    divan_price_sen: r.divanPriceSen,
    leg_height_inches: r.legHeightInches,
    leg_price_sen: r.legPriceSen,
    custom_specials: r.customSpecials,
    line_suffix: r.lineSuffix,
    special_order_price_sen: r.specialOrderPriceSen,
    variants: r.variants,
    delivery_date: r.deliveryDate,
    warehouse_id: r.warehouseId,
  };
}

async function suppliersByIds(db: Db, ids: string[]): Promise<Map<string, { id: string; code: string; name: string }>> {
  const out = new Map<string, { id: string; code: string; name: string }>();
  const uniq = [...new Set(ids.filter(Boolean))];
  if (uniq.length === 0) return out;
  const rows = await db
    .select({ id: suppliersTable.id, code: suppliersTable.code, name: suppliersTable.name })
    .from(suppliersTable)
    .where(inArray(suppliersTable.id, uniq));
  for (const r of rows) out.set(r.id, { id: r.id, code: r.code, name: r.name });
  return out;
}

// ── List ──────────────────────────────────────────────────────────────
app.get("/", async (c) => {
  const db = getDb(c.env);
  const status = c.req.query("status");
  const supplierId = c.req.query("supplierId");

  const conds = [] as ReturnType<typeof eq>[];
  if (status && VALID_STATUSES.has(status)) conds.push(eq(pcoTable.status, status as PcoHeaderRow["status"]));
  if (supplierId) conds.push(eq(pcoTable.supplierId, supplierId));

  const rows = await db
    .select()
    .from(pcoTable)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(pcoTable.poDate), desc(pcoTable.createdAt));

  // Supplier joins + per-order item summary + has_children stamp.
  const supMap = await suppliersByIds(db, rows.map((r) => r.supplierId));
  const ids = rows.map((r) => r.id);
  const itemsByPco = new Map<string, Array<{ material_code: string; material_name: string; qty: number }>>();
  const childIds = new Set<string>();
  if (ids.length > 0) {
    const itemRows = await db
      .select({ pcoId: pcoItemsTable.purchaseConsignmentOrderId, material_code: pcoItemsTable.materialCode, material_name: pcoItemsTable.materialName, qty: pcoItemsTable.qty })
      .from(pcoItemsTable)
      .where(inArray(pcoItemsTable.purchaseConsignmentOrderId, ids));
    for (const it of itemRows) {
      const arr = itemsByPco.get(it.pcoId) ?? [];
      arr.push({ material_code: it.material_code, material_name: it.material_name, qty: it.qty });
      itemsByPco.set(it.pcoId, arr);
    }
    const recvRows = await db
      .select({ pcoId: pcrTable.purchaseConsignmentOrderId })
      .from(pcrTable)
      .where(and(inArray(pcrTable.purchaseConsignmentOrderId, ids), ne(pcrTable.status, "CANCELLED")));
    for (const g of recvRows) if (g.pcoId) childIds.add(g.pcoId);
  }

  const purchaseOrders = rows.map((r) => ({
    ...toPcoResponse(r, supMap.get(r.supplierId) ?? null, itemsByPco.get(r.id) ?? []),
    has_children: childIds.has(r.id),
  }));
  return c.json({ purchaseOrders });
});

// ── Detail ────────────────────────────────────────────────────────────
app.get("/:id", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");

  const [header] = await db.select().from(pcoTable).where(eq(pcoTable.id, id)).limit(1);
  if (!header) return c.json({ error: "not_found" }, 404);

  const supMap = await suppliersByIds(db, [header.supplierId]);
  const itemRows = await db.select().from(pcoItemsTable).where(eq(pcoItemsTable.purchaseConsignmentOrderId, id)).orderBy(asc(pcoItemsTable.createdAt));

  const childRows = await db
    .select({ id: pcrTable.id })
    .from(pcrTable)
    .where(and(eq(pcrTable.purchaseConsignmentOrderId, id), ne(pcrTable.status, "CANCELLED")));

  const receiptsMap = await pcoLineReceipts(db, itemRows.map((it) => it.id));
  const purchaseOrder = {
    ...toPcoResponse(header, supMap.get(header.supplierId) ?? null),
    has_children: childRows.length > 0,
  };
  const items = itemRows.map((it) => ({ ...toPcoItemResponse(it), receipts: receiptsMap.get(it.id) ?? [] }));
  return c.json({ purchaseOrder, items });
});

// ── Linked docs (Smart Buttons fan-out) ─────────────────────────────
app.get("/:id/linked", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const [receives, returns] = await Promise.all([
    db
      .select({ id: pcrTable.id, receive_number: pcrTable.receiveNumber, status: pcrTable.status, received_at: pcrTable.receivedAt })
      .from(pcrTable)
      .where(eq(pcrTable.purchaseConsignmentOrderId, id))
      .orderBy(desc(pcrTable.receivedAt)),
    db
      .select({ id: pctTable.id, return_number: pctTable.returnNumber, status: pctTable.status, return_date: pctTable.returnDate })
      .from(pctTable)
      .where(eq(pctTable.pcOrderId, id))
      .orderBy(desc(pctTable.returnDate)),
  ]);
  return c.json({ receives, returns });
});

// ── Create ────────────────────────────────────────────────────────────
app.post("/", async (c) => {
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: "invalid_json" }, 400); }

  const supplierId = body.supplierId as string | undefined;
  if (!supplierId) return c.json({ error: "supplier_id_required" }, 400);
  const expectedAt = body.expectedAt as string | undefined;
  if (!expectedAt) return c.json({ error: "expected_at_required" }, 400);
  const purchaseLocationId = body.purchaseLocationId as string | undefined;
  if (!purchaseLocationId) return c.json({ error: "purchase_location_id_required" }, 400);

  const items = (body.items as Array<Record<string, unknown>> | undefined) ?? [];
  const currency = ((body.currency as string) ?? "MYR").toUpperCase();
  if (!VALID_CURRENCIES.has(currency)) return c.json({ error: "invalid_currency" }, 400);

  const db = getDb(c.env);
  const user = c.get("user");

  const cntRows = await db.select({ id: pcoTable.id }).from(pcoTable).where(like(pcoTable.pcNumber, `PCO-${yymm()}-%`));
  const pcNumber = `PCO-${yymm()}-${String(cntRows.length + 1).padStart(3, "0")}`;

  // Compute totals + build item rows.
  let subtotal = 0;
  let itemRows: Array<Record<string, unknown>>;
  try {
    itemRows = items.map((it) => {
      const kind = it.materialKind as string;
      if (!VALID_KINDS.has(kind)) throw new Error(`invalid material_kind: ${kind}`);
      if (!it.materialCode || !it.materialName) throw new Error("material_code + material_name required per item");
      const qty = Math.max(0, Number(it.qty ?? 0));
      const unit = Math.max(0, Number(it.unitPriceCenti ?? 0));
      const discountCenti = Math.max(0, Number(it.discountCenti ?? 0));
      const lineTotal = Math.max(0, qty * unit - discountCenti);
      subtotal += lineTotal;
      return {
        bindingId: (it.bindingId as string | undefined) ?? null,
        materialKind: kind as PcoItemRow["materialKind"],
        materialCode: it.materialCode as string,
        materialName: it.materialName as string,
        supplierSku: (it.supplierSku as string | undefined) ?? null,
        qty,
        unitPriceCenti: unit,
        lineTotalCenti: lineTotal,
        notes: (it.notes as string | undefined) ?? null,
        discountCenti,
        deliveryDate: (it.deliveryDate as string | undefined) ?? null,
        warehouseId: (it.warehouseId as string | undefined) ?? null,
        itemGroup: (it.itemGroup as string | undefined) ?? null,
        variants: (it.variants as unknown) ?? null,
        description: (it.description as string | undefined) ?? null,
        description2: (it.description2 as string | undefined) ?? null,
      };
    });
  } catch (e) {
    return c.json({ error: "invalid_item", reason: e instanceof Error ? e.message : String(e) }, 400);
  }

  const [header] = await db
    .insert(pcoTable)
    .values({
      pcNumber,
      supplierId,
      status: "SUBMITTED",
      submittedAt: new Date(),
      currency: currency as PcoHeaderRow["currency"],
      expectedAt,
      notes: (body.notes as string | undefined) ?? null,
      subtotalCenti: subtotal,
      taxCenti: 0,
      totalCenti: subtotal,
      createdBy: user?.id ?? null,
      purchaseLocationId,
      ...(body.poDate ? { poDate: body.poDate as string } : {}),
    } as never)
    .returning();

  if (itemRows.length > 0) {
    try {
      await db.insert(pcoItemsTable).values(itemRows.map((r) => ({ ...r, purchaseConsignmentOrderId: header.id })) as never);
    } catch (e) {
      await db.delete(pcoTable).where(eq(pcoTable.id, header.id));
      return c.json({ error: "items_insert_failed", reason: e instanceof Error ? e.message : String(e) }, 500);
    }
  }

  return c.json({ id: header.id, pcNumber: header.pcNumber }, 201);
});

/* ── PATCH header ── */
app.patch("/:id", async (c) => {
  const id = c.req.param("id");
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: "invalid_json" }, 400); }
  const db = getDb(c.env);
  const childLock = await pcoHasDownstream(db, id);
  if (childLock) return c.json(childLock, 409);

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  for (const [from, to] of [
    ["poDate", "poDate"], ["expectedAt", "expectedAt"], ["currency", "currency"],
    ["notes", "notes"], ["supplierId", "supplierId"],
    ["purchaseLocationId", "purchaseLocationId"],
  ] as const) {
    if (body[from] !== undefined) updates[to] = body[from];
  }
  const [data] = await db.update(pcoTable).set(updates as never).where(eq(pcoTable.id, id)).returning();
  if (!data) return c.json({ error: "not_found" }, 404);
  return c.json({ purchaseConsignmentOrder: toPcoResponse(data) });
});

/* ── PC Order line items: add / edit / delete ─────────────────────────── */
async function recomputePcoTotals(db: Db, pcoId: string) {
  const items = await db.select({ lineTotalCenti: pcoItemsTable.lineTotalCenti }).from(pcoItemsTable).where(eq(pcoItemsTable.purchaseConsignmentOrderId, pcoId));
  const subtotal = items.reduce((s, r) => s + (r.lineTotalCenti ?? 0), 0);
  await db.update(pcoTable).set({ subtotalCenti: subtotal, totalCenti: subtotal, updatedAt: new Date() } as never).where(eq(pcoTable.id, pcoId));
}

app.post("/:id/items", async (c) => {
  const pcoId = c.req.param("id");
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: "invalid_json" }, 400); }
  if (!it.materialCode) return c.json({ error: "material_code_required" }, 400);
  if (!it.materialName) return c.json({ error: "material_name_required" }, 400);

  const db = getDb(c.env);
  const childLock = await pcoHasDownstream(db, pcoId);
  if (childLock) return c.json(childLock, 409);

  const qty = Number(it.qty ?? 1);
  const unitPriceCenti = Number(it.unitPriceCenti ?? 0);
  const discountCenti = Number(it.discountCenti ?? 0);
  const lineTotal = qty * unitPriceCenti - discountCenti;

  const [data] = await db
    .insert(pcoItemsTable)
    .values({
      purchaseConsignmentOrderId: pcoId,
      bindingId: (it.bindingId as string) ?? null,
      materialKind: ((it.materialKind as string) ?? "mfg_product") as PcoItemRow["materialKind"],
      materialCode: it.materialCode as string,
      materialName: it.materialName as string,
      supplierSku: (it.supplierSku as string) ?? null,
      qty,
      unitPriceCenti,
      lineTotalCenti: lineTotal,
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
      description2: (it.description2 as string) ?? null,
      uom: (it.uom as string) ?? "UNIT",
      discountCenti,
      unitCostCenti: Number(it.unitCostCenti ?? 0),
      deliveryDate: (it.deliveryDate as string) ?? null,
      warehouseId: (it.warehouseId as string) ?? null,
    } as never)
    .returning();
  await recomputePcoTotals(db, pcoId);
  return c.json({ item: toPcoItemResponse(data) }, 201);
});

app.patch("/:id/items/:itemId", async (c) => {
  const pcoId = c.req.param("id"); const itemId = c.req.param("itemId");
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: "invalid_json" }, 400); }
  const db = getDb(c.env);

  const childLock = await pcoHasDownstream(db, pcoId);
  if (childLock) return c.json(childLock, 409);

  const [prev] = await db.select().from(pcoItemsTable).where(eq(pcoItemsTable.id, itemId)).limit(1);
  if (!prev) return c.json({ error: "not_found" }, 404);

  const qty = it.qty !== undefined ? Number(it.qty) : prev.qty;
  const unit = it.unitPriceCenti !== undefined ? Number(it.unitPriceCenti) : prev.unitPriceCenti;
  const discount = it.discountCenti !== undefined ? Number(it.discountCenti) : prev.discountCenti;
  const lineTotal = qty * unit - discount;

  const updates: Record<string, unknown> = { qty, unitPriceCenti: unit, discountCenti: discount, lineTotalCenti: lineTotal };
  for (const [from, to] of [
    ["materialCode", "materialCode"], ["materialName", "materialName"],
    ["supplierSku", "supplierSku"], ["itemGroup", "itemGroup"],
    ["description", "description"], ["description2", "description2"],
    ["uom", "uom"], ["unitCostCenti", "unitCostCenti"], ["notes", "notes"],
    ["gapInches", "gapInches"], ["divanHeightInches", "divanHeightInches"],
    ["divanPriceSen", "divanPriceSen"], ["legHeightInches", "legHeightInches"],
    ["legPriceSen", "legPriceSen"], ["customSpecials", "customSpecials"],
    ["lineSuffix", "lineSuffix"], ["specialOrderPriceSen", "specialOrderPriceSen"],
    ["variants", "variants"],
    ["deliveryDate", "deliveryDate"], ["warehouseId", "warehouseId"],
  ] as const) {
    if (it[from] !== undefined) updates[to] = it[from];
  }

  await db.update(pcoItemsTable).set(updates as never).where(eq(pcoItemsTable.id, itemId));
  await recomputePcoTotals(db, pcoId);
  return c.json({ ok: true });
});

app.delete("/:id/items/:itemId", async (c) => {
  const pcoId = c.req.param("id"); const itemId = c.req.param("itemId");
  const db = getDb(c.env);
  const childLock = await pcoHasDownstream(db, pcoId);
  if (childLock) return c.json(childLock, 409);
  await db.delete(pcoItemsTable).where(eq(pcoItemsTable.id, itemId));
  await recomputePcoTotals(db, pcoId);
  return c.body(null, 204);
});

// ── Submit / cancel / delete ──────────────────────────────────────────
app.patch("/:id/submit", async (c) => {
  const id = c.req.param("id");
  const db = getDb(c.env);
  const [row] = await db.select({ id: pcoTable.id, status: pcoTable.status, submittedAt: pcoTable.submittedAt }).from(pcoTable).where(eq(pcoTable.id, id)).limit(1);
  if (!row) return c.json({ error: "not_found" }, 404);
  if (row.status === "SUBMITTED") return c.json({ purchaseConsignmentOrder: row });
  return c.json({ error: "cannot_submit", message: `PC Order is ${row.status}` }, 409);
});

app.patch("/:id/cancel", async (c) => {
  const id = c.req.param("id");
  const db = getDb(c.env);
  const [cur] = await db.select({ id: pcoTable.id, status: pcoTable.status }).from(pcoTable).where(eq(pcoTable.id, id)).limit(1);
  if (!cur) return c.json({ error: "not_found" }, 404);
  if (cur.status === "RECEIVED") return c.json({ error: "cannot_cancel", message: "PC Order already received" }, 409);
  if (cur.status === "CANCELLED") return c.json({ purchaseConsignmentOrder: { id, status: "CANCELLED" } });

  const childLock = await pcoHasDownstream(db, id);
  if (childLock) return c.json(childLock, 409);

  await db.update(pcoTable).set({ status: "CANCELLED", cancelledAt: new Date(), updatedAt: new Date() } as never).where(eq(pcoTable.id, id));
  const [after] = await db.select({ id: pcoTable.id, status: pcoTable.status, cancelledAt: pcoTable.cancelledAt }).from(pcoTable).where(eq(pcoTable.id, id)).limit(1);
  return c.json({ purchaseConsignmentOrder: after ?? { id, status: "CANCELLED" } });
});

app.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const db = getDb(c.env);
  const [row] = await db.select({ id: pcoTable.id, status: pcoTable.status, pcNumber: pcoTable.pcNumber }).from(pcoTable).where(eq(pcoTable.id, id)).limit(1);
  if (!row) return c.json({ error: "not_found" }, 404);
  if (row.status !== "CANCELLED") {
    return c.json({ error: "cannot_delete", message: `PC Order ${row.pcNumber} is ${row.status}. Only CANCELLED PC Orders can be deleted. Use Cancel first.` }, 409);
  }
  await db.delete(pcoTable).where(eq(pcoTable.id, id)); // items cascade
  return c.json({ ok: true, deleted: row.pcNumber });
});

export default app;
