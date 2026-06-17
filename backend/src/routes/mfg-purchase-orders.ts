// ----------------------------------------------------------------------------
// /purchase-orders — manufacturer-side POs to suppliers.
//
// 1:1 clone of 2990s apps/api/src/routes/mfg-purchase-orders.ts. Endpoints,
// request bodies, response JSON shapes, status codes and business rules
// (SUBMITTED-on-create, child-lock, cancel/reopen, max-status transitions,
// release-on-delete) are kept identical to 2990s. Only the SEAMS change:
//   - DB client: 2990s per-request createClient -> Houzs getDb (rule #3).
//   - Query layer: 2990s Supabase PostgREST chains -> Drizzle against the cloned
//     schema, same JSON in/out (rule #3 + #7). Drizzle returns camelCase rows,
//     so toX*Response() mappers emit the snake_case wire shape 2990s expects.
//   - Auth: 2990s Supabase-JWT/RLS -> Houzs requirePermission("*") (rule #4).
//   - created_by: 2990s staff.id (uuid) -> Houzs users.id (integer) (rule #4).
//   - Mount path: /api/purchase-orders (DISTINCT from the AutoCount /api/po).
//
// Strategy-2 product-layer simplifications (Houzs is not the 2990s furniture
// business; owner enters own data — see docs/scm-clone/PLAN.md):
//   - DROPPED the furniture pricing engine entirely (po-pricing.ts,
//     computeMfgPoUnitCost, sofa-combo redistribution, fabric-tier resolution,
//     maintenance-config). A PO line's price is the generic
//     qty * unit_price_centi - discount_centi. The variant columns
//     (gap/divan/leg/customSpecials/variants jsonb) are KEPT on the table for
//     fidelity but the create/edit handlers pass them through as-is.
//   - The From-SO flow + the GRN/PI/PR downstream all reference tables that are
//     NOT cloned yet (mfg_sales_orders, mfg_sales_order_items, grns,
//     purchase_invoices, purchase_returns, warehouses). Those endpoints are
//     STUBBED to faithful empty/guarded shapes so the core PO module is fully
//     usable now and the pages render. Each carries a // TODO to wire on the
//     relevant slice. The core PO (manual create / list / detail / edit /
//     cancel / uncancel / delete / status) is cloned fully.
//
// Endpoints:
//   GET   /purchase-orders                  — list with filters
//   GET   /purchase-orders/outstanding-so-items — STUB (SO slice) -> { items: [] }
//   GET   /purchase-orders/:id              — detail (header + items)
//   GET   /purchase-orders/:id/linked       — STUB (GRN/PI/PR slices) -> empties
//   POST  /purchase-orders                  — create SUBMITTED PO from items
//   POST  /purchase-orders/from-sos         — STUB (SO slice) -> guarded
//   PATCH /purchase-orders/:id              — update header
//   POST  /purchase-orders/:id/items        — add line
//   PATCH /purchase-orders/:id/items/:itemId— edit line
//   DELETE /purchase-orders/:id/items/:itemId— delete line
//   POST  /purchase-orders/:id/convert-from-so — STUB (SO slice) -> guarded
//   PATCH /purchase-orders/:id/submit       — idempotent no-op (DRAFT removed)
//   PATCH /purchase-orders/:id/cancel       — -> CANCELLED
//   PATCH /purchase-orders/:id/reopen       — CANCELLED -> SUBMITTED
//   DELETE /purchase-orders/:id             — hard delete (CANCELLED only)
// ----------------------------------------------------------------------------

import { Hono } from "hono";
import { and, asc, desc, eq, inArray, like, ne } from "drizzle-orm";
import type { Env } from "../types";
import { getDb } from "../db/client";
import {
  purchaseOrders as poTable,
  purchaseOrderItems as poItemsTable,
  suppliers as suppliersTable,
  grns as grnsTable,
  grnItems as grnItemsTable,
  purchaseInvoices as piTable,
  purchaseReturns as prTable,
  mfgSalesOrderItems as soItemsTable,
} from "../db/schema";
import { requirePermission } from "../middleware/auth";

const app = new Hono<{ Bindings: Env }>();

// Owner-only for now (rule #4). Gate every route in this module.
app.use("*", requirePermission("*"));

const VALID_STATUSES = new Set(["SUBMITTED", "PARTIALLY_RECEIVED", "RECEIVED", "CANCELLED"]);
const VALID_CURRENCIES = new Set(["MYR", "RMB", "USD", "SGD"]);
const VALID_KINDS = new Set(["mfg_product", "fabric", "raw"]);

type PoStatusT = "SUBMITTED" | "PARTIALLY_RECEIVED" | "RECEIVED" | "CANCELLED";
type CurrencyT = "MYR" | "RMB" | "USD" | "SGD";
type MaterialKindT = "mfg_product" | "fabric" | "raw";

/* ── PO child-lock guard (Tier 2 — downstream lock) ─────────────────────────
   A PO locks (read-only — no header edit / no line edit / no cancel) once it has
   ANY non-cancelled GRN. The convert-to-GRN path is NOT gated by this: partial
   receiving is still allowed (the PO can keep emitting GRNs); only header/line
   MUTATIONS + CANCEL are blocked, mirroring grnHasDownstream in routes/grns.ts.
   Wired to the real grns table now that the GRN slice has landed. */
async function poHasDownstream(
  db: ReturnType<typeof getDb>,
  poId: string,
): Promise<{ error: string; message: string } | null> {
  const rows = await db
    .select({ id: grnsTable.id })
    .from(grnsTable)
    .where(and(eq(grnsTable.purchaseOrderId, poId), ne(grnsTable.status, "CANCELLED")));
  if (rows.length > 0) {
    return { error: "po_has_downstream", message: "PO has a Goods Receipt — delete or cancel it first to edit" };
  }
  return null;
}

/* Per-line goods-receipt breakdown — which GR(s) each PO line was received into
   (one entry per GRN line), carrying the GR number + net qty + status. Cancelled
   GRNs are excluded. Net qty = qty_accepted − returned_qty; zero/negative nets
   (fully returned) are dropped. Read-only display aid. (Mirror 2990s
   poLineReceipts, now that grn_items exists.) */
type PoLineReceiptInternal = { grnNumber: string; qty: number; status: string };
async function poLineReceipts(
  db: ReturnType<typeof getDb>,
  poItemIds: string[],
): Promise<Map<string, PoLineReceiptInternal[]>> {
  const out = new Map<string, PoLineReceiptInternal[]>();
  if (poItemIds.length === 0) return out;
  const grnLines = await db
    .select({
      purchaseOrderItemId: grnItemsTable.purchaseOrderItemId,
      qtyAccepted: grnItemsTable.qtyAccepted,
      returnedQty: grnItemsTable.returnedQty,
      grnId: grnItemsTable.grnId,
    })
    .from(grnItemsTable)
    .where(inArray(grnItemsTable.purchaseOrderItemId, poItemIds));
  const grnIds = [...new Set(grnLines.map((r) => r.grnId).filter(Boolean))];
  if (grnIds.length === 0) return out;
  const grnRows = await db
    .select({ id: grnsTable.id, grnNumber: grnsTable.grnNumber, status: grnsTable.status })
    .from(grnsTable)
    .where(inArray(grnsTable.id, grnIds));
  const grnMeta = new Map<string, { grnNumber: string; status: string }>();
  for (const g of grnRows) {
    if ((g.status ?? "").toUpperCase() === "CANCELLED") continue;
    grnMeta.set(g.id, { grnNumber: g.grnNumber ?? "—", status: (g.status ?? "").toUpperCase() });
  }
  for (const r of grnLines) {
    if (!r.purchaseOrderItemId) continue;
    const meta = grnMeta.get(r.grnId);
    if (!meta) continue; // cancelled GRN — excluded
    const net = Number(r.qtyAccepted ?? 0) - Number(r.returnedQty ?? 0);
    if (net <= 0) continue;
    const arr = out.get(r.purchaseOrderItemId) ?? [];
    arr.push({ grnNumber: meta.grnNumber, qty: net, status: meta.status });
    out.set(r.purchaseOrderItemId, arr);
  }
  return out;
}

// ── List ──────────────────────────────────────────────────────────────
app.get("/", async (c) => {
  const status = c.req.query("status");
  const supplierId = c.req.query("supplierId");
  const db = getDb(c.env);

  // 2990s ordered by po_date desc, created_at desc and embedded
  // supplier:suppliers(id,code,name) + items:purchase_order_items(...) in one
  // nested PostgREST select. Reproduce with a supplier left-join for the header
  // rows, then one batched items query stitched in below (same shapes).
  const conds = [];
  if (status && VALID_STATUSES.has(status)) {
    conds.push(eq(poTable.status, status as PoStatusT));
  }
  if (supplierId) {
    conds.push(eq(poTable.supplierId, supplierId));
  }

  try {
    const headerRows = await db
      .select({
        po: poTable,
        supplier: {
          id: suppliersTable.id,
          code: suppliersTable.code,
          name: suppliersTable.name,
        },
      })
      .from(poTable)
      .leftJoin(suppliersTable, eq(poTable.supplierId, suppliersTable.id))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(poTable.poDate), desc(poTable.createdAt));

    // PO list rows surface a per-row items summary (AutoCount-style). One
    // batched query over every PO id, grouped client-side (mirrors 2990s's
    // nested items:purchase_order_items(material_code, material_name, qty)).
    const ids = headerRows.map((r) => r.po.id);
    const itemsByPo = new Map<string, Array<{ material_code: string; material_name: string; qty: number }>>();
    if (ids.length > 0) {
      const itemRows = await db
        .select({
          purchaseOrderId: poItemsTable.purchaseOrderId,
          materialCode: poItemsTable.materialCode,
          materialName: poItemsTable.materialName,
          qty: poItemsTable.qty,
        })
        .from(poItemsTable)
        .where(inArray(poItemsTable.purchaseOrderId, ids));
      for (const it of itemRows) {
        const arr = itemsByPo.get(it.purchaseOrderId) ?? [];
        arr.push({ material_code: it.materialCode, material_name: it.materialName, qty: it.qty });
        itemsByPo.set(it.purchaseOrderId, arr);
      }
    }

    /* Tier 2 downstream-lock (mirror computeGrnFlags in routes/grns.ts) — one
       extra query: pull the distinct purchase_order_ids that have any non-
       cancelled GRN, then stamp has_children on every PO row. The list grid uses
       this to hide Edit / Cancel from POs that are downstream-locked. (Wired now
       that the GRN slice has landed.) */
    const childIds = new Set<string>();
    if (ids.length > 0) {
      const grnRows = await db
        .select({ purchaseOrderId: grnsTable.purchaseOrderId })
        .from(grnsTable)
        .where(and(inArray(grnsTable.purchaseOrderId, ids), ne(grnsTable.status, "CANCELLED")));
      for (const g of grnRows) if (g.purchaseOrderId) childIds.add(g.purchaseOrderId);
    }
    const purchaseOrders = headerRows.map((r) => ({
      ...toPoHeaderResponse(r.po),
      supplier: r.supplier?.id ? r.supplier : null,
      items: itemsByPo.get(r.po.id) ?? [],
      has_children: childIds.has(r.po.id),
    }));
    return c.json({ purchaseOrders });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

/* ── Outstanding SO items for the "From SO" picker ──────────────────────────
   STUB. 2990s reads mfg_sales_order_items (+ pooled MRP shortage). The SO slice
   is not cloned yet, so there are no outstanding SO lines -> return the faithful
   empty shape. The PurchaseOrderFromSo page renders its "available after the
   Sales Orders slice" empty state from this.
   IMPORTANT (route ordering): this STATIC path stays registered BEFORE `/:id`
   so Hono doesn't try to cast "outstanding-so-items" to a uuid.
   TODO: wire to mfg_sales_order_items when the SO slice lands. */
app.get("/outstanding-so-items", async (c) => {
  return c.json({ items: [] as unknown[] });
});

// ── Detail ────────────────────────────────────────────────────────────
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const db = getDb(c.env);

  try {
    const [headerRows, itemRows] = await Promise.all([
      db
        .select({
          po: poTable,
          supplier: {
            id: suppliersTable.id,
            code: suppliersTable.code,
            name: suppliersTable.name,
            contact_person: suppliersTable.contactPerson,
            phone: suppliersTable.phone,
            email: suppliersTable.email,
            address: suppliersTable.address,
          },
        })
        .from(poTable)
        .leftJoin(suppliersTable, eq(poTable.supplierId, suppliersTable.id))
        .where(eq(poTable.id, id))
        .limit(1),
      db.select().from(poItemsTable).where(eq(poItemsTable.purchaseOrderId, id)).orderBy(asc(poItemsTable.createdAt)),
    ]);

    const headerRow = headerRows[0];
    if (!headerRow) return c.json({ error: "not_found" }, 404);

    /* Tier 2 downstream-lock — stamp has_children on the detail header so the PO
       Detail page can lock once any non-cancelled GRN exists. (Wired now that the
       GRN slice has landed.) */
    const childGrns = await db
      .select({ id: grnsTable.id })
      .from(grnsTable)
      .where(and(eq(grnsTable.purchaseOrderId, id), ne(grnsTable.status, "CANCELLED")));
    const purchaseOrder = {
      ...toPoHeaderResponse(headerRow.po),
      supplier: headerRow.supplier?.id ? headerRow.supplier : null,
      has_children: childGrns.length > 0,
    };

    /* Per-line GR breakdown so the PO list expansion / detail can show a
       "Received" column (which GR took how much). */
    const receiptsMap = await poLineReceipts(db, itemRows.map((it) => it.id));

    /* so_doc_no + so_drift — WIRED now that the SO slice has landed (mirror
       2990s). For each PO line with a source so_item_id, look up the live SO
       line and surface (a) the SO doc_no, (b) a drift flag when the live SO spec
       no longer matches this PO line's snapshot, so the purchaser re-sends.
       STRATEGY-2 DEVIATION: 2990s computes the spec via buildVariantSummary (the
       furniture formatter, dropped) — here the spec compare uses description2
       (or description) instead; the item-code-change signal is unchanged. */
    type SoSnap = { item_code: string; item_group: string | null; description: string | null; description2: string | null };
    const soLineById = new Map<string, SoSnap>();
    const soDocByItem = new Map<string, string>();
    try {
      const soItemIds = [...new Set(itemRows.map((it) => it.soItemId as string | null | undefined).filter(Boolean))] as string[];
      if (soItemIds.length > 0) {
        const soLines = await db
          .select({ id: soItemsTable.id, docNo: soItemsTable.docNo, itemCode: soItemsTable.itemCode, itemGroup: soItemsTable.itemGroup, description: soItemsTable.description, description2: soItemsTable.description2 })
          .from(soItemsTable)
          .where(inArray(soItemsTable.id, soItemIds));
        for (const r of soLines) {
          soDocByItem.set(r.id, r.docNo);
          soLineById.set(r.id, { item_code: r.itemCode, item_group: r.itemGroup, description: r.description, description2: r.description2 });
        }
      }
    } catch {
      /* leave so_doc_no / drift null */
    }

    const items = itemRows.map((it) => {
      const soId = it.soItemId as string | null;
      const so = soId ? soLineById.get(soId) ?? null : null;
      let so_drift: null | { specPo: string; specSo: string; itemPo: string; itemSo: string; itemChanged: boolean } = null;
      if (so) {
        const specPo = String(it.description2 ?? it.description ?? "");
        const specSo = String(so.description2 ?? so.description ?? "");
        const itemPo = String(it.materialCode ?? "");
        const itemSo = String(so.item_code ?? "");
        const itemChanged = itemPo !== itemSo;
        if (specPo !== specSo || itemChanged) {
          so_drift = { specPo, specSo, itemPo, itemSo, itemChanged };
        }
      }
      return {
        ...toPoItemResponse(it),
        receipts: receiptsMap.get(it.id) ?? [],
        so_doc_no: soId ? soDocByItem.get(soId) ?? null : null,
        so_drift,
      };
    });

    return c.json({ purchaseOrder, items });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

// ── Linked docs (Smart Buttons fan-out) ─────────────────────────────
// Returns the GRNs (wired now that the GRN slice landed) + Purchase Invoices /
// Purchase Returns (still empty until those slices land) that descend from this
// PO. Tiny shape per child — counters + clickable link only.
// TODO: wire invoices / returns to purchase_invoices / purchase_returns.
app.get("/:id/linked", async (c) => {
  const id = c.req.param("id");
  const db = getDb(c.env);
  try {
    // GRN/PI/PR slices have all landed -> wire the real downstream docs tied to
    // this PO (each links back via its purchase_order_id FK). Mirrors 2990s's
    // PO /:id/linked Smart-Buttons fan-out.
    const [grnRows, invoiceRows, returnRows] = await Promise.all([
      db
        .select({ id: grnsTable.id, grn_number: grnsTable.grnNumber, status: grnsTable.status, received_at: grnsTable.receivedAt })
        .from(grnsTable)
        .where(eq(grnsTable.purchaseOrderId, id))
        .orderBy(desc(grnsTable.receivedAt)),
      db
        .select({ id: piTable.id, invoice_number: piTable.invoiceNumber, status: piTable.status, invoice_date: piTable.invoiceDate, total_centi: piTable.totalCenti })
        .from(piTable)
        .where(eq(piTable.purchaseOrderId, id))
        .orderBy(desc(piTable.invoiceDate)),
      db
        .select({ id: prTable.id, return_number: prTable.returnNumber, status: prTable.status, return_date: prTable.returnDate, refund_centi: prTable.refundCenti })
        .from(prTable)
        .where(eq(prTable.purchaseOrderId, id))
        .orderBy(desc(prTable.returnDate)),
    ]);
    return c.json({ grns: grnRows, invoices: invoiceRows, returns: returnRows });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

// ── Create ────────────────────────────────────────────────────────────
// body: {
//   supplierId, currency?, poDate?, expectedAt, purchaseLocationId, notes?,
//   items: [{ materialKind, materialCode, materialName, supplierSku?, qty,
//             unitPriceCenti, bindingId?, discountCenti?, deliveryDate?,
//             warehouseId?, itemGroup?, variants?, description?, soItemId? }]
// }
app.post("/", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const supplierId = body.supplierId as string | undefined;
  if (!supplierId) return c.json({ error: "supplier_id_required" }, 400);

  // PR #157 — Expected Delivery + Purchase Location are required on submit. Both
  // fan out to per-line warehouse + delivery date downstream. (Frontend also
  // blocks submit until both are filled.)
  const expectedAt = body.expectedAt as string | undefined;
  if (!expectedAt) return c.json({ error: "expected_at_required" }, 400);
  const purchaseLocationId = body.purchaseLocationId as string | undefined;
  if (!purchaseLocationId) return c.json({ error: "purchase_location_id_required" }, 400);

  // PR #41 — allow blank-draft creation (no items); add lines on the detail page.
  const items = (body.items as Array<Record<string, unknown>> | undefined) ?? [];

  const currency = ((body.currency as string) ?? "MYR").toUpperCase();
  if (!VALID_CURRENCIES.has(currency)) return c.json({ error: "invalid_currency" }, 400);

  const db = getDb(c.env);
  const user = c.get("user");

  const yymm = (() => {
    const d = new Date();
    return `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, "0")}`;
  })();

  // Crude PO# generation: count current-month POs + 1. Race-prone in theory;
  // in practice a small org with <100 POs/month — fine for now. (Verbatim from
  // 2990s; harden with a SEQUENCE later.)
  let monthCount = 0;
  try {
    const existing = await db
      .select({ id: poTable.id })
      .from(poTable)
      .where(like(poTable.poNumber, `PO-${yymm}-%`));
    monthCount = existing.length;
  } catch (e) {
    return c.json({ error: "insert_failed", reason: errMsg(e) }, 500);
  }
  const poNumber = `PO-${yymm}-${String(monthCount + 1).padStart(3, "0")}`;

  // Compute totals + build line rows.
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
      // PR #97 — line total honours per-line discount (generic non-furniture
      // path; the sofa/combo pricing engine is dropped per Strategy-2).
      const lineTotal = Math.max(0, qty * unit - discountCenti);
      subtotal += lineTotal;
      return {
        materialKind: kind as MaterialKindT,
        materialCode: it.materialCode as string,
        materialName: it.materialName as string,
        supplierSku: (it.supplierSku as string | undefined) ?? null,
        bindingId: (it.bindingId as string | undefined) ?? null,
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
        // 2990s auto-generates Description 2 from the variants via
        // buildVariantSummary (furniture formatter). Strategy-2: that helper is
        // furniture-coupled and dropped; pass the client's description2 through
        // (or null). The variant columns are still persisted for fidelity.
        description2: (it.description2 as string | undefined) ?? null,
        // Source SO line (release-on-delete). The SO slice isn't cloned, so this
        // is a soft uuid with no enforcement; manual lines send null.
        soItemId: (it.soItemId as string | undefined) ?? null,
      };
    });
  } catch (e) {
    return c.json({ error: "invalid_item", reason: errMsg(e) }, 400);
  }

  /* PR #131 — "PO 是直接 create 的，不需要进入 DRAFT": POST creates SUBMITTED
     directly (migration 0078 removed DRAFT from po_status). PATCH /submit is
     kept as an idempotent no-op for legacy callers. */
  const headerInsert: Record<string, unknown> = {
    poNumber,
    supplierId,
    status: "SUBMITTED" as PoStatusT,
    submittedAt: new Date(),
    currency: currency as CurrencyT,
    expectedAt,
    notes: (body.notes as string | undefined) ?? null,
    subtotalCenti: subtotal,
    taxCenti: 0,
    totalCenti: subtotal,
    // rule #4 — created_by is the integer users.id (2990s used staff.id uuid).
    createdBy: user.id,
    purchaseLocationId,
  };
  // Optional poDate — if absent, the column default (now()) wins.
  if (body.poDate) headerInsert.poDate = body.poDate as string;

  try {
    const inserted = await db.insert(poTable).values(headerInsert as never).returning();
    const header = inserted[0];

    if (itemRows.length > 0) {
      const itemsToInsert = itemRows.map((r) => ({ ...r, purchaseOrderId: header.id }));
      try {
        await db.insert(poItemsTable).values(itemsToInsert as never).returning();
      } catch (iErr) {
        // Best-effort rollback of the header so we don't leak a no-items PO.
        await db.delete(poTable).where(eq(poTable.id, header.id));
        return c.json({ error: "items_insert_failed", reason: errMsg(iErr) }, 500);
      }
    }

    return c.json({ id: header.id, poNumber: header.poNumber }, 201);
  } catch (e) {
    if (isUniqueViolation(e)) return c.json({ error: "duplicate_po_number", reason: errMsg(e) }, 409);
    return c.json({ error: "insert_failed", reason: errMsg(e) }, 500);
  }
});

/* ── POST /from-sos — create POs from selected Sales Order items ─────────────
   STUB. 2990s resolves SO lines -> main-supplier bindings -> groups into POs.
   The SO slice (mfg_sales_orders / mfg_sales_order_items) is not cloned yet, so
   this path has no source data. Returns a guarded response (created: []) so the
   From-SO page never fakes SO data.
   TODO: port the full from-SO grouping + (Strategy-2-trimmed) pricing when the
   SO slice lands. */
app.post("/from-sos", async (c) => {
  return c.json(
    {
      error: "so_slice_unavailable",
      message: "Convert-from-Sales-Order is available after the Sales Orders slice lands.",
      created: [] as unknown[],
      total: 0,
    },
    409,
  );
});

/* ── PATCH header (po_date, expected_at, currency, notes, supplier, location) ── */
app.patch("/:id", async (c) => {
  const id = c.req.param("id");
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const db = getDb(c.env);

  /* Tier 2 downstream-lock — PO header is read-only once a non-cancelled GRN
     exists. No GRN table yet -> never locks (see poHasDownstream). */
  const childLock = await poHasDownstream(db, id);
  if (childLock) return c.json(childLock, 409);

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  // [bodyKey, drizzleColumnKey] — same field set as 2990s's [from,to] map.
  const map: Array<[string, string]> = [
    ["poDate", "poDate"],
    ["expectedAt", "expectedAt"],
    ["currency", "currency"],
    ["notes", "notes"],
    ["supplierId", "supplierId"],
    ["purchaseLocationId", "purchaseLocationId"],
  ];
  for (const [from, to] of map) {
    if (body[from] !== undefined) updates[to] = body[from];
  }

  try {
    const updated = await db.update(poTable).set(updates).where(eq(poTable.id, id)).returning();
    if (!updated[0]) return c.json({ error: "not_found" }, 404);
    return c.json({ purchaseOrder: toPoHeaderResponse(updated[0]) });
  } catch (e) {
    return c.json({ error: "update_failed", reason: errMsg(e) }, 500);
  }
});

/* ── PO line items: add / edit / delete ─────────────────────────────────── */
async function recomputePoTotals(db: ReturnType<typeof getDb>, poId: string) {
  const items = await db
    .select({ lineTotalCenti: poItemsTable.lineTotalCenti })
    .from(poItemsTable)
    .where(eq(poItemsTable.purchaseOrderId, poId));
  const subtotal = items.reduce((s, r) => s + (r.lineTotalCenti ?? 0), 0);
  await db
    .update(poTable)
    .set({ subtotalCenti: subtotal, totalCenti: subtotal, updatedAt: new Date() })
    .where(eq(poTable.id, poId));
}

/* ── Self-healing SO "picked" counter ───────────────────────────────────────
   Recounts mfg_sales_order_items.po_qty_picked from the live PO lines on every
   PO mutation (add/edit/delete/cancel/reopen) so SO lines drop in/out of the
   From-SO picker. WIRED now that the SO slice has landed — 1:1 with 2990s's
   recomputeSoPicked (PostgREST -> Drizzle).

   MRP-origin PO lines (from_mrp = true) are reference-only: they do NOT lock the
   source SO line via po_qty_picked, so the recount excludes them (Commander
   2026-05-31; the picker drops MRP-covered lines via the pooled-supply model
   instead — which the From-SO picker itself lives in the SO slice, deferred).

   Best-effort, never throws: the primary write already committed; the live-count
   model self-heals on the next operation that touches these SO lines. */
async function recomputeSoPicked(
  db: ReturnType<typeof getDb>,
  soItemIds: Array<string | null | undefined>,
): Promise<void> {
  const ids = [...new Set(soItemIds.filter((x): x is string => Boolean(x)))];
  if (ids.length === 0) return;
  try {
    const lines = await db
      .select({
        soItemId: poItemsTable.soItemId,
        qty: poItemsTable.qty,
        purchaseOrderId: poItemsTable.purchaseOrderId,
        fromMrp: poItemsTable.fromMrp,
      })
      .from(poItemsTable)
      .where(inArray(poItemsTable.soItemId, ids));
    const rows = lines.filter((r) => r.fromMrp !== true && r.soItemId);
    const poIds = [...new Set(rows.map((r) => r.purchaseOrderId).filter(Boolean))];
    const cancelled = new Set<string>();
    if (poIds.length > 0) {
      const pos = await db.select({ id: poTable.id, status: poTable.status }).from(poTable).where(inArray(poTable.id, poIds));
      for (const p of pos) if (p.status === "CANCELLED") cancelled.add(p.id);
    }
    const pickedBySo = new Map<string, number>(ids.map((id) => [id, 0]));
    for (const r of rows) {
      if (cancelled.has(r.purchaseOrderId)) continue;
      const k = r.soItemId as string;
      pickedBySo.set(k, (pickedBySo.get(k) ?? 0) + Number(r.qty ?? 0));
    }
    await Promise.all(
      [...pickedBySo.entries()].map(([soItemId, picked]) =>
        db.update(soItemsTable).set({ poQtyPicked: picked }).where(eq(soItemsTable.id, soItemId)),
      ),
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[recomputeSoPicked] best-effort recount failed", { soItemIds: ids, error: errMsg(e) });
  }
}

app.post("/:id/items", async (c) => {
  const poId = c.req.param("id");
  let it: Record<string, unknown>;
  try {
    it = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  if (!it.materialCode) return c.json({ error: "material_code_required" }, 400);
  if (!it.materialName) return c.json({ error: "material_name_required" }, 400);

  const db = getDb(c.env);
  /* Tier 2 downstream-lock — line-add is blocked once a GRN exists (no-op now). */
  const childLock = await poHasDownstream(db, poId);
  if (childLock) return c.json(childLock, 409);

  const qty = Number(it.qty ?? 1);
  const unitPriceCenti = Number(it.unitPriceCenti ?? 0);
  const discountCenti = Number(it.discountCenti ?? 0);
  const lineTotal = qty * unitPriceCenti - discountCenti;

  const row: Record<string, unknown> = {
    purchaseOrderId: poId,
    bindingId: (it.bindingId as string) ?? null,
    materialKind: ((it.materialKind as string) ?? "mfg_product") as MaterialKindT,
    materialCode: it.materialCode as string,
    materialName: it.materialName as string,
    supplierSku: (it.supplierSku as string) ?? null,
    qty,
    unitPriceCenti,
    lineTotalCenti: lineTotal,
    notes: (it.notes as string) ?? null,
    /* PR #41 — variant fields (kept for fidelity; Strategy-2 UI doesn't edit
       them, but a client that sends them is honoured). */
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
    // Description 2 server-owned in 2990s via buildVariantSummary (furniture
    // formatter, dropped per Strategy-2) — pass the client value through.
    description2: (it.description2 as string) ?? null,
    uom: (it.uom as string) ?? "UNIT",
    discountCenti,
    unitCostCenti: Number(it.unitCostCenti ?? 0),
    // PR #77 — per-line ship-to (soft ref). Both nullable; empty = inherit header.
    deliveryDate: (it.deliveryDate as string) ?? null,
    warehouseId: (it.warehouseId as string) ?? null,
  };

  try {
    const inserted = await db.insert(poItemsTable).values(row as never).returning();
    await recomputePoTotals(db, poId);
    return c.json({ item: toPoItemResponse(inserted[0]) }, 201);
  } catch (e) {
    return c.json({ error: "insert_failed", reason: errMsg(e) }, 500);
  }
});

app.patch("/:id/items/:itemId", async (c) => {
  const poId = c.req.param("id");
  const itemId = c.req.param("itemId");
  let it: Record<string, unknown>;
  try {
    it = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const db = getDb(c.env);

  /* Tier 2 downstream-lock — line-edit is blocked once a GRN exists (no-op now). */
  const childLock = await poHasDownstream(db, poId);
  if (childLock) return c.json(childLock, 409);

  const prevRows = await db
    .select({
      qty: poItemsTable.qty,
      unitPriceCenti: poItemsTable.unitPriceCenti,
      discountCenti: poItemsTable.discountCenti,
      itemGroup: poItemsTable.itemGroup,
      variants: poItemsTable.variants,
      soItemId: poItemsTable.soItemId,
    })
    .from(poItemsTable)
    .where(eq(poItemsTable.id, itemId))
    .limit(1);
  const prev = prevRows[0];
  if (!prev) return c.json({ error: "not_found" }, 404);

  const qty = it.qty !== undefined ? Number(it.qty) : prev.qty;
  const unit = it.unitPriceCenti !== undefined ? Number(it.unitPriceCenti) : prev.unitPriceCenti;
  const discount = it.discountCenti !== undefined ? Number(it.discountCenti) : prev.discountCenti;
  const lineTotal = qty * unit - discount;

  const updates: Record<string, unknown> = {
    qty,
    unitPriceCenti: unit,
    discountCenti: discount,
    lineTotalCenti: lineTotal,
  };
  const map: Array<[string, string]> = [
    ["materialCode", "materialCode"],
    ["materialName", "materialName"],
    ["supplierSku", "supplierSku"],
    ["itemGroup", "itemGroup"],
    ["description", "description"],
    ["description2", "description2"],
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
    ["warehouseId", "warehouseId"],
  ];
  for (const [from, to] of map) {
    if (it[from] !== undefined) updates[to] = it[from];
  }
  // 2990s recomputes description2 here from buildVariantSummary (furniture
  // formatter, dropped per Strategy-2). Description 2 is whatever the client
  // sends (handled by the map above), else the stored value is left untouched.

  try {
    await db.update(poItemsTable).set(updates).where(eq(poItemsTable.id, itemId));
    await recomputePoTotals(db, poId);
    // Release-on-delete counter recount (no-op — SO slice not cloned).
    const editedSoItem = prev.soItemId ?? null;
    if (editedSoItem) {
      try {
        await recomputeSoPicked(db, [editedSoItem]);
      } catch {
        /* don't fail the edit on a counter recount */
      }
    }
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: "update_failed", reason: errMsg(e) }, 500);
  }
});

app.delete("/:id/items/:itemId", async (c) => {
  const poId = c.req.param("id");
  const itemId = c.req.param("itemId");
  const db = getDb(c.env);

  /* Tier 2 downstream-lock — line-delete is blocked once a GRN exists (no-op). */
  const childLock = await poHasDownstream(db, poId);
  if (childLock) return c.json(childLock, 409);

  // Read the source SO link before deleting (for the counter recount no-op).
  const doomedRows = await db
    .select({ soItemId: poItemsTable.soItemId })
    .from(poItemsTable)
    .where(eq(poItemsTable.id, itemId))
    .limit(1);

  try {
    await db.delete(poItemsTable).where(eq(poItemsTable.id, itemId));
    await recomputePoTotals(db, poId);
    const releasedSoItem = doomedRows[0]?.soItemId ?? null;
    if (releasedSoItem) {
      try {
        await recomputeSoPicked(db, [releasedSoItem]);
      } catch {
        /* line already deleted — don't fail on counter recount */
      }
    }
    return c.body(null, 204);
  } catch (e) {
    return c.json({ error: "delete_failed", reason: errMsg(e) }, 500);
  }
});

/* ── POST /:id/convert-from-so — copy an SO's items into this PO ─────────────
   STUB. 2990s copies a Sales Order's items into the current PO (supplier-cost
   priced). The SO slice isn't cloned -> guarded response. Manual line-add via
   POST /:id/items covers the non-SO path fully.
   TODO: port convert-from-so when the SO slice lands. */
app.post("/:id/convert-from-so", async (c) => {
  return c.json(
    {
      error: "so_slice_unavailable",
      message: "Convert-from-Sales-Order is available after the Sales Orders slice lands.",
    },
    409,
  );
});

// ── Submit / cancel / reopen ──────────────────────────────────────────
// PR-DRAFT-removal — POST creates SUBMITTED directly. This endpoint is kept as
// an idempotent no-op so legacy callers still work.
app.patch("/:id/submit", async (c) => {
  const id = c.req.param("id");
  const db = getDb(c.env);
  const rows = await db
    .select({ id: poTable.id, status: poTable.status, submittedAt: poTable.submittedAt })
    .from(poTable)
    .where(eq(poTable.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return c.json({ error: "not_found" }, 404);
  if (row.status === "SUBMITTED") return c.json({ purchaseOrder: row });
  return c.json({ error: "cannot_submit", message: `PO is ${row.status}` }, 409);
});

app.patch("/:id/cancel", async (c) => {
  const id = c.req.param("id");
  const db = getDb(c.env);

  // Read -> guard -> update -> re-read (2990s split this to dodge PostgREST
  // PGRST116; we keep the same shape).
  const curRows = await db
    .select({ id: poTable.id, status: poTable.status })
    .from(poTable)
    .where(eq(poTable.id, id))
    .limit(1);
  const cur = curRows[0];
  if (!cur) return c.json({ error: "not_found" }, 404);
  const curStatus = cur.status;
  if (curStatus === "RECEIVED") return c.json({ error: "cannot_cancel", message: "PO already received" }, 409);
  // Idempotent — already cancelled, just echo back.
  if (curStatus === "CANCELLED") {
    return c.json({ purchaseOrder: { id, status: "CANCELLED" } });
  }

  /* Tier 2 downstream-lock — can't cancel a PO that has a downstream GRN (no-op). */
  const childLock = await poHasDownstream(db, id);
  if (childLock) return c.json(childLock, 409);

  try {
    await db
      .update(poTable)
      .set({ status: "CANCELLED", cancelledAt: new Date(), updatedAt: new Date() })
      .where(eq(poTable.id, id));
  } catch (e) {
    return c.json({ error: "cancel_failed", reason: errMsg(e) }, 500);
  }

  /* Cancelling releases every converted SO line's quota back to the From-SO
     picker (recompute no-op until the SO slice lands). */
  try {
    const lines = await db
      .select({ soItemId: poItemsTable.soItemId })
      .from(poItemsTable)
      .where(eq(poItemsTable.purchaseOrderId, id));
    await recomputeSoPicked(db, lines.map((l) => l.soItemId));
  } catch {
    /* best-effort — PO already cancelled */
  }

  const afterRows = await db
    .select({ id: poTable.id, status: poTable.status, cancelledAt: poTable.cancelledAt })
    .from(poTable)
    .where(eq(poTable.id, id))
    .limit(1);
  return c.json({ purchaseOrder: afterRows[0] ?? { id, status: "CANCELLED" } });
});

/* Reopen — the inverse of cancel (Commander 2026-06-16). Only a CANCELLED PO
   can be reopened; it returns to SUBMITTED and its converted SO lines re-claim
   their quota. */
app.patch("/:id/reopen", async (c) => {
  const id = c.req.param("id");
  const db = getDb(c.env);

  const curRows = await db
    .select({ id: poTable.id, status: poTable.status })
    .from(poTable)
    .where(eq(poTable.id, id))
    .limit(1);
  const cur = curRows[0];
  if (!cur) return c.json({ error: "not_found" }, 404);
  const curStatus = cur.status;
  // Idempotent — a live PO is already open, echo back.
  if (curStatus === "SUBMITTED" || curStatus === "PARTIALLY_RECEIVED") {
    return c.json({ purchaseOrder: { id, status: curStatus } });
  }
  if (curStatus !== "CANCELLED") {
    return c.json({ error: "cannot_reopen", message: `Only a cancelled PO can be reopened (this is ${curStatus})` }, 409);
  }

  try {
    await db
      .update(poTable)
      .set({ status: "SUBMITTED", cancelledAt: null, updatedAt: new Date() })
      .where(eq(poTable.id, id));
  } catch (e) {
    return c.json({ error: "reopen_failed", reason: errMsg(e) }, 500);
  }

  try {
    const lines = await db
      .select({ soItemId: poItemsTable.soItemId })
      .from(poItemsTable)
      .where(eq(poItemsTable.purchaseOrderId, id));
    await recomputeSoPicked(db, lines.map((l) => l.soItemId));
  } catch {
    /* best-effort — PO already reopened */
  }

  const afterRows = await db
    .select({ id: poTable.id, status: poTable.status, cancelledAt: poTable.cancelledAt })
    .from(poTable)
    .where(eq(poTable.id, id))
    .limit(1);
  return c.json({ purchaseOrder: afterRows[0] ?? { id, status: "SUBMITTED" } });
});

// ── Delete ────────────────────────────────────────────────────────────
// Hard-delete a PO + its line items. Only CANCELLED POs may be deleted
// (SUBMITTED+ have downstream docs — use Cancel first). Items cascade via FK.
app.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const db = getDb(c.env);

  const curRows = await db
    .select({ id: poTable.id, status: poTable.status, poNumber: poTable.poNumber })
    .from(poTable)
    .where(eq(poTable.id, id))
    .limit(1);
  const row = curRows[0];
  if (!row) return c.json({ error: "not_found" }, 404);
  if (row.status !== "CANCELLED") {
    return c.json(
      {
        error: "cannot_delete",
        message: `PO ${row.poNumber} is ${row.status}. Only CANCELLED POs can be deleted. Use Cancel first.`,
      },
      409,
    );
  }

  // Capture the source SO links before the cascade wipes the lines.
  const doomedLines = await db
    .select({ soItemId: poItemsTable.soItemId })
    .from(poItemsTable)
    .where(eq(poItemsTable.purchaseOrderId, id));

  try {
    await db.delete(poTable).where(eq(poTable.id, id)); // items cascade
  } catch (e) {
    return c.json({ error: "delete_failed", reason: errMsg(e) }, 500);
  }

  try {
    await recomputeSoPicked(db, doomedLines.map((l) => l.soItemId));
  } catch {
    /* PO already deleted */
  }

  return c.json({ ok: true, deleted: row.poNumber });
});

// ── Response shaping ─────────────────────────────────────────────────
// Map Drizzle's camelCase rows to the snake_case JSON the 2990s frontend
// consumes (PoHeaderRow / PoItemRow). Keeps the wire shape identical to 2990s
// (rule #7) even though the ORM returns camelCase.

type PoHeaderDb = typeof poTable.$inferSelect;
type PoItemDb = typeof poItemsTable.$inferSelect;

function isoOrNull(v: Date | string | null): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

function toPoHeaderResponse(p: PoHeaderDb) {
  return {
    id: p.id,
    po_number: p.poNumber,
    supplier_id: p.supplierId,
    status: p.status,
    po_date: p.poDate,
    expected_at: p.expectedAt,
    purchase_location_id: p.purchaseLocationId,
    currency: p.currency,
    subtotal_centi: p.subtotalCenti,
    tax_centi: p.taxCenti,
    total_centi: p.totalCenti,
    notes: p.notes,
    submitted_at: isoOrNull(p.submittedAt),
    received_at: isoOrNull(p.receivedAt),
    cancelled_at: isoOrNull(p.cancelledAt),
    created_at: isoOrNull(p.createdAt),
    created_by: p.createdBy,
    updated_at: isoOrNull(p.updatedAt),
  };
}

function toPoItemResponse(it: PoItemDb) {
  return {
    id: it.id,
    purchase_order_id: it.purchaseOrderId,
    binding_id: it.bindingId,
    material_kind: it.materialKind,
    material_code: it.materialCode,
    material_name: it.materialName,
    supplier_sku: it.supplierSku,
    qty: it.qty,
    unit_price_centi: it.unitPriceCenti,
    line_total_centi: it.lineTotalCenti,
    received_qty: it.receivedQty,
    notes: it.notes,
    gap_inches: it.gapInches,
    divan_height_inches: it.divanHeightInches,
    divan_price_sen: it.divanPriceSen,
    leg_height_inches: it.legHeightInches,
    leg_price_sen: it.legPriceSen,
    custom_specials: it.customSpecials ?? null,
    line_suffix: it.lineSuffix,
    special_order_price_sen: it.specialOrderPriceSen,
    variants: it.variants ?? null,
    item_group: it.itemGroup,
    description: it.description,
    description2: it.description2,
    uom: it.uom,
    discount_centi: it.discountCenti,
    unit_cost_centi: it.unitCostCenti,
    delivery_date: it.deliveryDate,
    warehouse_id: it.warehouseId,
    so_item_id: it.soItemId,
    from_mrp: it.fromMrp,
    created_at: isoOrNull(it.createdAt),
  };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Postgres unique-violation (SQLSTATE 23505), surfaced by postgres.js as
// err.code. Mirrors 2990s's check for error.code === '23505'.
function isUniqueViolation(e: unknown): boolean {
  return Boolean(e && typeof e === "object" && (e as { code?: string }).code === "23505");
}

export default app;
