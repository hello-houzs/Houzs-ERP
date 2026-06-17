// ----------------------------------------------------------------------------
// /mrp — Material Requirements Planning (trading-company / finished-goods).
// 1:1 clone of 2990s apps/api/src/routes/mrp.ts (the PURE CALCULATOR).
//
// 2990 is a TRADING company (buys finished goods and resells), so this is NOT a
// BOM-explosion MRP — it's a finished-goods demand-vs-supply reconciliation:
//
//   Demand   = outstanding Sales-Order line items (qty, delivery date, SO no)
//   Supply   = on-hand stock (inventory_balances) + outstanding PO lines
//              (qty - received, with ETA = line delivery_date ?? po.expected_at)
//   Allocate = greedy by SO delivery date (earliest first):
//                stock first -> outstanding PO (earliest ETA) -> shortage.
//
// PURE CALCULATOR — NO dedicated table, NO persistence. Recomputed on every GET.
// (The ONLY persisted MRP state is the per-category lead-times config, see
//  routes/mrp-lead-times.ts + migration 0032.)
//
// PER-WAREHOUSE: every bucket is keyed by (warehouse_id, item_code, variant_key).
// Stock NEVER crosses warehouses (a cross-WH pull needs a stock transfer), so the
// warehouse is part of the demand AND the supply identity. warehouseId omitted /
// 'all' -> the UNION of every warehouse's buckets (each warehouse computed
// independently), NOT a cross-WH pooled recompute.
//
// NO SO<->PO linkage. Supply is a pool of stock + ALL open PO lines (by
// warehouse+variant), allocated greedy by delivery date. The same SO line is
// infinitely convertible to PO from MRP (reference only; purchase_order_items.from_mrp).
//
// Endpoint:
//   GET /mrp?category=BEDFRAME&warehouseId=<uuid>&includeUndated=true
//
// SEAMS vs 2990s (canonical clone rules + Strategy-2):
//   - DB layer: 2990s Supabase PostgREST (sb.from().select().eq()) -> Houzs
//     Drizzle getDb(c.env) (rule #3). Same response JSON shape (rule #7) so the
//     ported page reads it unchanged.
//   - Auth: 2990s supabaseAuth -> Houzs requirePermission("*") (rule #4).
//   - inventory_balances is a DB VIEW (migration 0026), not a Drizzle table ->
//     read via raw `sql` (same as routes/inventory.ts).
//   - STRATEGY-2 — DROPPED the furniture engine: the sofa SETS path (2990s
//     section 8), the sofa-only colour-match / module-cells / splitSofaCode
//     logic, buildVariantSummary (-> formatVariantKey, the generic Houzs label),
//     and isServiceLine (no item-group taxonomy on Houzs lines). There is NO
//     mfg_products catalogue in Houzs, so the product category + name come purely
//     from the SO line's own item_group (catFromGroup) + description — the SAME
//     fallback 2990s already uses for un-catalogued codes. `sofaSets` is returned
//     as an empty array for wire compatibility with the ported page. Demand is
//     grouped GENERICALLY by (warehouse, item_code, variant_key) regardless of
//     category. The demand/supply/shortage core + greedy allocation are verbatim.
//   - so_drift / sofa batch dimensions: not applicable (generic lines).
// ----------------------------------------------------------------------------

import { Hono } from "hono";
import { and, eq, inArray, sql } from "drizzle-orm";
import { computeVariantKey, formatVariantKey, type VariantAttrs } from "@shared/index";
import type { Env } from "../types";
import { getDb } from "../db/client";
import {
  mfgSalesOrders as soTable,
  mfgSalesOrderItems as soItemsTable,
  purchaseOrders as poTable,
  purchaseOrderItems as poItemsTable,
  suppliers as suppliersTable,
  supplierMaterialBindings as bindingsTable,
  mfgWarehouses as warehousesTable,
  mrpCategoryLeadTimes,
} from "../db/schema";
import { requirePermission } from "../middleware/auth";
import { soDeliverableRemaining } from "./delivery-orders-mfg";

const app = new Hono<{ Bindings: Env }>();
app.use("*", requirePermission("*"));

/* SO statuses that no longer create demand (already shipped / closed). */
const SO_DONE = new Set(["DELIVERED", "INVOICED", "CLOSED", "CANCELLED"]);
/* PO statuses that no longer supply goods. */
const PO_DEAD = new Set(["CANCELLED"]);

type DemandRow = {
  id: string;
  doc_no: string;
  item_code: string;
  description: string | null;
  item_group: string | null;
  variants: Record<string, unknown> | null;
  qty: number;
  warehouse_id: string | null; // SO line's ship-from warehouse
  line_delivery_date: string | null;
  cancelled: boolean;
  so: {
    debtor_name: string | null;
    status: string;
    so_date: string | null;
    customer_delivery_date: string | null;
    internal_expected_dd: string | null; // processing date (drives when to order)
  } | null;
};

type PoLineRow = {
  material_code: string;
  item_group: string | null;
  variants: Record<string, unknown> | null;
  qty: number;
  received_qty: number | null;
  delivery_date: string | null;
  warehouse_id: string | null;        // per-line ship-to warehouse (overrides header)
  so_item_id: string | null;          // SO line this PO line was raised from (informational only now)
  po: { po_number: string; status: string; expected_at: string | null; purchase_location_id: string | null; supplier_id: string | null } | null;
};

type BalanceRow = { product_code: string; warehouse_id: string; variant_key: string | null; qty: number };

type AllocSource = "stock" | "po" | "shortage";

/* Bucket key by (item_code + variant key) — the variant key is the shared
   inventory identity (computeVariantKey — same one inventory_balances.variant_key
   is built from, so stock matches byte-for-byte). Houzs lines have no item-group
   taxonomy so the key resolves to '' (one bucket per item_code) in practice. */
const variantKeyOf = (itemGroup: string | null | undefined, variants: unknown): string =>
  computeVariantKey(itemGroup, (variants ?? null) as VariantAttrs | null);
/* Every bucket is scoped by warehouse: stock can't cross warehouses, so a
   (code, variant) pair in KL is a DIFFERENT bucket from the same pair in PJ.
   NULL warehouse gets its own WH_NONE bucket so it never silently shares
   another warehouse's stock. */
const WH_NONE = "NOWH";
const composite = (whId: string | null, code: string, vkey: string): string =>
  `${whId ?? WH_NONE}|${code}|${vkey}`;

type MrpLine = {
  soItemId: string;
  soDocNo: string;
  debtorName: string | null;
  soDate: string | null;
  deliveryDate: string | null;
  processingDate: string | null;
  /* order-by date = delivery date - category lead days. */
  orderByDate: string | null;
  qty: number;
  source: AllocSource;
  poNumber: string | null;
  poEta: string | null;
  shortageQty: number; // units still uncovered on this line (orange highlight)
  /* When covered by a PO (source==='po'), the covering PO's supplier so the UI
     can show it READ-ONLY. NULL for stock / shortage lines. */
  poSupplierId: string | null;
  poSupplierName: string | null;
};

type MrpSku = {
  /* Each row is scoped to ONE warehouse (per-WH MRP). NULL when the demand line
     has no warehouse bound yet. */
  warehouseId: string | null;
  warehouseCode: string | null;
  warehouseName: string | null;
  itemCode: string;
  variantKey: string;
  variantLabel: string | null;
  description: string | null;
  category: string | null;
  qtyNeeded: number;
  stock: number;
  poOutstanding: number;
  shortage: number;
  mainSupplierCode: string | null;
  mainSupplierName: string | null;
  /* All suppliers bound to this SKU (main first) — lets the UI switch supplier
     in-place before posting the PO. */
  suppliers: Array<{ supplierId: string; code: string; name: string; isMain: boolean }>;
  lines: MrpLine[];
};

/* Earliest-first comparator that pushes NULL dates to the end. */
function byDateAsc(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a < b ? -1 : 1;
}

export type MrpResult = {
  asOf: string;
  categories: string[];
  warehouses: unknown[];
  skus: MrpSku[];
  // STRATEGY-2: the sofa SETS path is dropped (furniture engine). Returned as an
  // empty array so the ported page's `data.sofaSets ?? []` paths stay safe.
  sofaSets: unknown[];
  totals: {
    skuCount: number;
    shortageSkuCount: number;
    shortageUnits: number;
    sofaSetCount: number;
    sofaSetShortageCount: number;
  };
};

/* Per-SO-line coverage the drill-down needs: is this line covered by stock, by
   an outstanding PO (then which + when), or still short. */
export type SoLineCoverage = { source: AllocSource; po: string | null; eta: string | null };

type Db = ReturnType<typeof getDb>;

/* Shared MRP allocation engine. The /mrp route is a thin wrapper around this;
   the Sales-Order drill-down can read the SAME allocation (via mrpLineCoverage)
   so the Stock column and the MRP page never disagree. */
export async function computeMrp(
  db: Db,
  opts: { catFilter: string | null; whFilter: string | null; includeUndated: boolean },
): Promise<MrpResult> {
  const { catFilter, whFilter, includeUndated } = opts;

  // ── 0. Per-category lead times ────────────────────────────────────────
  // order-by date = delivery date - lead_days[category]. Keyed lowercase to
  // match item_group; product category is uppercase so we lowercase on lookup.
  const leadRows = await db
    .select({ category: mrpCategoryLeadTimes.category, leadDays: mrpCategoryLeadTimes.leadDays })
    .from(mrpCategoryLeadTimes);
  const leadDaysByCat = new Map<string, number>();
  for (const r of leadRows) {
    leadDaysByCat.set((r.category ?? "").toLowerCase(), r.leadDays ?? 0);
  }
  const orderByOf = (deliveryDate: string | null, category: string | null): string | null => {
    if (!deliveryDate) return null;
    const days = leadDaysByCat.get((category ?? "").toLowerCase()) ?? 0;
    if (days <= 0) return deliveryDate;
    const d = new Date(`${deliveryDate.slice(0, 10)}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return deliveryDate;
    d.setUTCDate(d.getUTCDate() - days);
    return d.toISOString().slice(0, 10);
  };

  // ── 1. Demand — outstanding SO lines ──────────────────────────────────
  const demandRaw = await db
    .select({
      id: soItemsTable.id,
      doc_no: soItemsTable.docNo,
      item_code: soItemsTable.itemCode,
      description: soItemsTable.description,
      item_group: soItemsTable.itemGroup,
      variants: soItemsTable.variants,
      qty: soItemsTable.qty,
      warehouse_id: soItemsTable.warehouseId,
      line_delivery_date: soItemsTable.lineDeliveryDate,
      cancelled: soItemsTable.cancelled,
      debtor_name: soTable.debtorName,
      status: soTable.status,
      so_date: soTable.soDate,
      customer_delivery_date: soTable.customerDeliveryDate,
      internal_expected_dd: soTable.internalExpectedDd,
    })
    .from(soItemsTable)
    .innerJoin(soTable, eq(soItemsTable.docNo, soTable.docNo))
    .where(eq(soItemsTable.cancelled, false))
    .limit(5000);

  const demandActive: DemandRow[] = (demandRaw as Array<Record<string, unknown>>)
    .map((r) => ({
      id: r.id as string,
      doc_no: r.doc_no as string,
      item_code: r.item_code as string,
      description: (r.description as string | null) ?? null,
      item_group: (r.item_group as string | null) ?? null,
      variants: (r.variants as Record<string, unknown> | null) ?? null,
      qty: Number(r.qty ?? 0),
      warehouse_id: (r.warehouse_id as string | null) ?? null,
      line_delivery_date: (r.line_delivery_date as string | null) ?? null,
      cancelled: Boolean(r.cancelled),
      so: {
        debtor_name: (r.debtor_name as string | null) ?? null,
        status: (r.status as string) ?? "",
        so_date: (r.so_date as string | null) ?? null,
        customer_delivery_date: (r.customer_delivery_date as string | null) ?? null,
        internal_expected_dd: (r.internal_expected_dd as string | null) ?? null,
      },
    }))
    .filter(
      (r) =>
        r.item_code && r.so && !SO_DONE.has(r.so.status) && r.qty > 0
        // Undated lines (no line delivery date AND no SO delivery date) are not
        // ready to order — drop them unless the caller explicitly asks for them.
        && (includeUndated || Boolean(r.line_delivery_date ?? r.so.customer_delivery_date)),
    );

  // A partially-delivered SO keeps its header status active, so already-delivered
  // lines would otherwise phantom back in as demand and over-order. Subtract
  // delivered-net-of-returns per line and drop any line with nothing left to
  // fulfil. Single source of truth: soDeliverableRemaining (same query the DO
  // convert flow uses), so MRP can never disagree with the SO's remaining.
  const demandDocNos = [...new Set(demandActive.map((d) => d.doc_no).filter(Boolean))];
  const deliverable = await soDeliverableRemaining(db, demandDocNos);
  const deliveredNetOf = (soItemId: string): number => {
    const d = deliverable.get(soItemId);
    if (!d) return 0;
    return Math.max(0, (d.delivered ?? 0) - (d.returned ?? 0));
  };
  const effQtyOf = (r: DemandRow): number => Math.max(0, r.qty - deliveredNetOf(r.id));
  const demand = demandActive.filter((r) => effQtyOf(r) > 0);

  // ── 2. Category dropdown + warehouses ─────────────────────────────────
  // STRATEGY-2: Houzs has no mfg_products catalogue, so there is no separate
  // product-master category source. The category for a line is derived from its
  // own item_group (catFromGroup) — the SAME fallback 2990s uses for codes that
  // aren't catalogued. The category dropdown lists the distinct derived
  // categories actually present in the current demand.
  const categorySet = new Set<string>();

  const warehouses = await db
    .select({ id: warehousesTable.id, code: warehousesTable.code, name: warehousesTable.name })
    .from(warehousesTable)
    .where(eq(warehousesTable.isActive, true))
    .orderBy(warehousesTable.code);
  const whById = new Map<string, { code: string; name: string }>();
  for (const w of warehouses) whById.set(w.id, { code: w.code, name: w.name });

  // ── 3. Stock on hand — inventory_balances keyed by (warehouse, code, variant) ──
  // inventory_balances is a VIEW (one row per warehouse/product_code/variant_key =
  // SUM(signed movements)); read it directly via raw sql (no product table).
  const balWhere = whFilter ? sql` WHERE warehouse_id = ${whFilter}` : sql``;
  const balances = await db.execute<BalanceRow>(
    sql`SELECT product_code, warehouse_id, variant_key, qty FROM inventory_balances${balWhere}`,
  );
  const stockByKey = new Map<string, number>();
  for (const b of balances) {
    const k = composite(b.warehouse_id ?? null, b.product_code, b.variant_key ?? "");
    stockByKey.set(k, (stockByKey.get(k) ?? 0) + Number(b.qty ?? 0));
  }

  // ── 4. Outstanding PO supply — open PO lines with ETA, keyed by (warehouse, code, variant) ──
  // Each PO line's ship-to warehouse = line warehouse_id, falling back to the PO
  // header's purchase_location_id. No SO<->PO linkage — supply is a pure pool.
  const poRaw = await db
    .select({
      material_code: poItemsTable.materialCode,
      item_group: poItemsTable.itemGroup,
      variants: poItemsTable.variants,
      qty: poItemsTable.qty,
      received_qty: poItemsTable.receivedQty,
      delivery_date: poItemsTable.deliveryDate,
      warehouse_id: poItemsTable.warehouseId,
      so_item_id: poItemsTable.soItemId,
      po_number: poTable.poNumber,
      status: poTable.status,
      expected_at: poTable.expectedAt,
      purchase_location_id: poTable.purchaseLocationId,
      supplier_id: poTable.supplierId,
    })
    .from(poItemsTable)
    .innerJoin(poTable, eq(poItemsTable.purchaseOrderId, poTable.id))
    .limit(5000);

  type PoSupply = { poNumber: string; eta: string | null; qtyLeft: number; supplierId: string | null };
  const poByKey = new Map<string, PoSupply[]>();
  const poOutstandingByKey = new Map<string, number>();
  const poSupplierIds = new Set<string>();
  for (const raw of poRaw as Array<Record<string, unknown>>) {
    const r: PoLineRow = {
      material_code: raw.material_code as string,
      item_group: (raw.item_group as string | null) ?? null,
      variants: (raw.variants as Record<string, unknown> | null) ?? null,
      qty: Number(raw.qty ?? 0),
      received_qty: raw.received_qty == null ? null : Number(raw.received_qty),
      delivery_date: (raw.delivery_date as string | null) ?? null,
      warehouse_id: (raw.warehouse_id as string | null) ?? null,
      so_item_id: (raw.so_item_id as string | null) ?? null,
      po: raw.po_number
        ? {
            po_number: raw.po_number as string,
            status: (raw.status as string) ?? "",
            expected_at: (raw.expected_at as string | null) ?? null,
            purchase_location_id: (raw.purchase_location_id as string | null) ?? null,
            supplier_id: (raw.supplier_id as string | null) ?? null,
          }
        : null,
    };
    if (!r.po || PO_DEAD.has(r.po.status)) continue;
    const eta = r.delivery_date ?? r.po.expected_at ?? null;
    const left = (r.qty ?? 0) - (r.received_qty ?? 0);
    if (left <= 0) continue;
    const poWh = r.warehouse_id ?? r.po.purchase_location_id ?? null;
    if (whFilter && poWh !== whFilter) continue;
    const k = composite(poWh, r.material_code, variantKeyOf(r.item_group, r.variants));
    const arr = poByKey.get(k) ?? [];
    arr.push({ poNumber: r.po.po_number, eta, qtyLeft: left, supplierId: r.po.supplier_id ?? null });
    poByKey.set(k, arr);
    poOutstandingByKey.set(k, (poOutstandingByKey.get(k) ?? 0) + left);
    if (r.po.supplier_id) poSupplierIds.add(r.po.supplier_id);
  }
  // Resolve PO supplier ids -> names for the read-only covered-line display.
  const supplierNameById = new Map<string, string>();
  if (poSupplierIds.size > 0) {
    const poSups = await db
      .select({ id: suppliersTable.id, name: suppliersTable.name })
      .from(suppliersTable)
      .where(inArray(suppliersTable.id, [...poSupplierIds]));
    for (const s of poSups) supplierNameById.set(s.id, s.name);
  }
  for (const arr of poByKey.values()) arr.sort((a, b) => byDateAsc(a.eta, b.eta));

  // ── 5. Suppliers per SKU — main + alternates (so the UI can switch supplier
  //       in-place before posting the PO). ──────────────────────────────────
  type SupplierOpt = { supplierId: string; code: string; name: string; isMain: boolean };
  const codes = [...new Set(demand.map((d) => d.item_code))];
  const mainByCode = new Map<string, { code: string; name: string }>();
  const suppliersByCode = new Map<string, SupplierOpt[]>();
  if (codes.length > 0) {
    const binds = await db
      .select({
        material_code: bindingsTable.materialCode,
        is_main_supplier: bindingsTable.isMainSupplier,
        supplier_id: bindingsTable.supplierId,
        supplier_code: suppliersTable.code,
        supplier_name: suppliersTable.name,
      })
      .from(bindingsTable)
      .innerJoin(suppliersTable, eq(bindingsTable.supplierId, suppliersTable.id))
      .where(and(eq(bindingsTable.materialKind, "mfg_product"), inArray(bindingsTable.materialCode, codes)))
      .orderBy(sql`${bindingsTable.isMainSupplier} DESC`);
    for (const b of binds) {
      const arr = suppliersByCode.get(b.material_code) ?? [];
      arr.push({ supplierId: b.supplier_id, code: b.supplier_code, name: b.supplier_name, isMain: b.is_main_supplier });
      suppliersByCode.set(b.material_code, arr);
      // First (is_main_supplier first via ORDER BY) wins as the default main.
      if (!mainByCode.has(b.material_code)) mainByCode.set(b.material_code, { code: b.supplier_code, name: b.supplier_name });
    }
  }

  // ── 6. Group demand by (warehouse + SKU + variant), apply category filter ─
  // STRATEGY-2: generic grouping — every line is bucketed the same way,
  // regardless of category (the furniture sofa-SET split is dropped). Category
  // comes from the line's own item_group (catFromGroup), the only taxonomy Houzs
  // carries; un-derivable -> null (still grouped + shown under "all").
  type Bucket = { whId: string | null; code: string; vkey: string; vlabel: string; rows: DemandRow[] };
  const catFromGroup = (g: string | null | undefined): string | null => {
    const s = (g ?? "").trim().toUpperCase();
    if (s.includes("BEDFRAME")) return "BEDFRAME";
    if (s.includes("SOFA")) return "SOFA";
    if (s.includes("MATTRESS")) return "MATTRESS";
    if (s.includes("ACCESSOR")) return "ACCESSORY";
    if (s.includes("SERVICE")) return "SERVICE";
    return null;
  };
  const demandByKey = new Map<string, Bucket>();
  for (const d of demand) {
    const cat = catFromGroup(d.item_group);
    if (cat) categorySet.add(cat);
    if (catFilter && cat !== catFilter) continue;
    if (whFilter && (d.warehouse_id ?? null) !== whFilter) continue;
    const whId = d.warehouse_id ?? null;
    const vkey = variantKeyOf(d.item_group, d.variants);
    const k = composite(whId, d.item_code, vkey);
    const bucket = demandByKey.get(k)
      ?? { whId, code: d.item_code, vkey, vlabel: formatVariantKey(vkey), rows: [] };
    bucket.rows.push(d);
    demandByKey.set(k, bucket);
  }

  // ── 7. Allocate (greedy by SO delivery date) per (warehouse + SKU + variant) ─
  // Pure date-priority pooling, NO po_qty_picked lock. Supply = this bucket's
  // stock + open PO lines (same warehouse+variant). The earliest-delivery SO line
  // claims stock first, then the earliest-ETA PO; what remains is shortage.
  const skus: MrpSku[] = [];
  for (const [k, bucket] of demandByKey.entries()) {
    const { whId, code, vlabel, rows } = bucket;
    // Deterministic same-day allocation: when two SO lines share a delivery
    // date, allocate by SO doc number ascending so the greedy walk never flips.
    rows.sort((a, b) => {
      const byDate = byDateAsc(
        a.line_delivery_date ?? a.so?.customer_delivery_date ?? null,
        b.line_delivery_date ?? b.so?.customer_delivery_date ?? null,
      );
      if (byDate !== 0) return byDate;
      return (a.doc_no ?? "").localeCompare(b.doc_no ?? "");
    });

    let stockLeft = stockByKey.get(k) ?? 0;
    // Clone PO supply so the greedy walk can mutate qtyLeft without touching the
    // shared map. Fold in the same-warehouse EMPTY-variant PO pool (legacy POs
    // created before SO->PO carried variants -> key ''), so a PO raised for a
    // variant SKU still shows as supply against the variant row.
    const legacyKey = composite(whId, code, "");
    const useLegacy = bucket.vkey !== "" && legacyKey !== k;
    const poQueue: PoSupply[] = [
      ...(poByKey.get(k) ?? []),
      ...(useLegacy ? (poByKey.get(legacyKey) ?? []) : []),
    ].map((p) => ({ ...p })).sort((a, b) => byDateAsc(a.eta, b.eta));

    const lines: MrpLine[] = [];
    let qtyNeeded = 0;
    for (const r of rows) {
      const eff = effQtyOf(r);                              // qty still to fulfil (ordered - delivered + returned)
      qtyNeeded += eff;
      let need = eff;
      const fromStock = Math.min(stockLeft, need);
      stockLeft -= fromStock;
      need -= fromStock;

      let poNumber: string | null = null;
      let poEta: string | null = null;
      let poSupplierId: string | null = null;
      while (need > 0 && poQueue.length > 0) {
        const front = poQueue[0];
        if (!front) break;
        const take = Math.min(front.qtyLeft, need);
        if (poNumber == null) { poNumber = front.poNumber; poEta = front.eta; poSupplierId = front.supplierId; }
        front.qtyLeft -= take;
        need -= take;
        if (front.qtyLeft <= 0) poQueue.shift();
      }

      // need>0 -> still uncovered (SHORT). need==0 -> covered by a pooled PO
      // (poNumber set) or by stock.
      const source: AllocSource =
        need > 0 ? "shortage"
        : poNumber != null ? "po"
        : "stock";
      const lineDelivery = r.line_delivery_date ?? r.so?.customer_delivery_date ?? null;
      const cat = catFromGroup(r.item_group);
      lines.push({
        soItemId: r.id,
        soDocNo: r.doc_no,
        debtorName: r.so?.debtor_name ?? null,
        soDate: r.so?.so_date ?? null,
        deliveryDate: lineDelivery,
        processingDate: r.so?.internal_expected_dd ?? null,
        orderByDate: orderByOf(lineDelivery, cat),
        qty: eff,
        source,
        poNumber,
        poEta,
        shortageQty: need,
        // Only covered-by-PO lines carry a read-only supplier; stock/shortage = null.
        poSupplierId: source === "po" ? poSupplierId : null,
        poSupplierName: source === "po" && poSupplierId ? (supplierNameById.get(poSupplierId) ?? null) : null,
      });
    }

    const stock = stockByKey.get(k) ?? 0;
    const poOutstanding = (poOutstandingByKey.get(k) ?? 0)
      + (useLegacy ? (poOutstandingByKey.get(legacyKey) ?? 0) : 0);
    const shortage = lines.reduce((acc, l) => acc + l.shortageQty, 0);
    const main = mainByCode.get(code);
    const wh = whId ? whById.get(whId) : null;
    skus.push({
      warehouseId: whId,
      warehouseCode: wh?.code ?? null,
      warehouseName: wh?.name ?? null,
      itemCode: code,
      variantKey: bucket.vkey,
      variantLabel: vlabel || null,
      description: rows[0]?.description ?? null,
      category: catFromGroup(rows[0]?.item_group),
      qtyNeeded,
      stock,
      poOutstanding,
      shortage,
      mainSupplierCode: main?.code ?? null,
      mainSupplierName: main?.name ?? null,
      suppliers: suppliersByCode.get(code) ?? [],
      lines,
    });
  }

  // Shortage SKUs first, then by earliest order-by date, then code + variant —
  // so the rows that need ordering float to the top (the orange ones to act on).
  const earliestOrderBy = (s: MrpSku): string | null =>
    s.lines.reduce<string | null>((min, l) => (l.orderByDate && (!min || l.orderByDate < min) ? l.orderByDate : min), null);
  skus.sort((a, b) => {
    if ((b.shortage > 0 ? 1 : 0) !== (a.shortage > 0 ? 1 : 0)) {
      return (b.shortage > 0 ? 1 : 0) - (a.shortage > 0 ? 1 : 0);
    }
    const byOrderBy = byDateAsc(earliestOrderBy(a), earliestOrderBy(b));
    if (byOrderBy !== 0) return byOrderBy;
    if (a.itemCode !== b.itemCode) return a.itemCode < b.itemCode ? -1 : 1;
    return (a.variantLabel ?? "") < (b.variantLabel ?? "") ? -1 : 1;
  });

  return {
    asOf: new Date().toISOString(),
    categories: [...categorySet].sort(),
    warehouses,
    skus,
    sofaSets: [], // STRATEGY-2: furniture sofa-SETS path dropped (wire compat only)
    totals: {
      skuCount: skus.length,
      shortageSkuCount: skus.filter((s) => s.shortage > 0).length,
      shortageUnits: skus.reduce((acc, s) => acc + s.shortage, 0),
      sofaSetCount: 0,
      sofaSetShortageCount: 0,
    },
  };
}

/* Flatten an MRP result into a per-SO-line coverage map (keyed by
   mfg_sales_order_items.id). A Sales-Order drill-down can stamp each line from
   this so its Stock column shows the exact same Stock / PO·ETA / Pending the
   MRP page computed — one allocation, one source of truth. */
export function mrpLineCoverage(result: MrpResult): Map<string, SoLineCoverage> {
  const map = new Map<string, SoLineCoverage>();
  for (const sku of result.skus) {
    for (const l of sku.lines) {
      map.set(l.soItemId, { source: l.source, po: l.poNumber, eta: l.poEta });
    }
  }
  return map;
}

app.get("/", async (c) => {
  const db = getDb(c.env);
  const category = c.req.query("category");
  const warehouseId = c.req.query("warehouseId");
  const catFilter = category && category !== "all" ? category.toUpperCase() : null;
  const whFilter = warehouseId && warehouseId !== "all" ? warehouseId : null;
  // An SO line with NO delivery date means the customer isn't ready for goods
  // yet, so it shouldn't drive ordering. Exclude undated demand by default;
  // ?includeUndated=true brings it back for a full view.
  const includeUndated = c.req.query("includeUndated") === "true";
  try {
    const result = await computeMrp(db, { catFilter, whFilter, includeUndated });
    return c.json(result);
  } catch (e) {
    return c.json({ error: "load_failed", reason: e instanceof Error ? e.message : String(e) }, 500);
  }
});

export default app;
