// ----------------------------------------------------------------------------
// sku-usage — "has this SKU / Model been used yet?" guard.
//
// 1:1 clone of 2990s apps/api/src/lib/sku-usage.ts. Once a SKU has been USED in
// a real document — sold on a Sales Order, ordered on a Purchase Order, or moved
// in stock — it must NOT be deletable (deleting orphans live order lines that
// store item_code as a text snapshot, and destroys stock-movement history). A
// Model is locked the moment ANY of its SKUs is used. Before first use (setup
// phase) deletes stay allowed so a mistyped model can be removed + re-created.
//
// SEAM: 2990s queried via the Supabase PostgREST client (SupabaseClient arg).
// Houzs is Drizzle-over-Hyperdrive, so this takes the Drizzle db handle and uses
// the cloned mfg_sales_order_items / mfg_purchase_order_items / inventory_movements
// tables (all already cloned in prior slices). Same checks, same result shape.
// ----------------------------------------------------------------------------

import { eq } from "drizzle-orm";
import type { getDb } from "../db/client";
import {
  mfgProducts,
  mfgSalesOrderItems,
  purchaseOrderItems,
  inventoryMovements,
} from "../db/schema";

type Db = ReturnType<typeof getDb>;

export type SkuUsage = { where: string; doc: string | null };

/** First place a SKU code is referenced by a real document, or null if unused. */
export async function findSkuUsage(db: Db, code: string): Promise<SkuUsage | null> {
  if (!code) return null;

  // a sales order — mfg_sales_order_items.item_code -> doc_no.
  const soRows = await db
    .select({ doc: mfgSalesOrderItems.docNo })
    .from(mfgSalesOrderItems)
    .where(eq(mfgSalesOrderItems.itemCode, code))
    .limit(1);
  if (soRows.length > 0) return { where: "a sales order", doc: soRows[0].doc ?? null };

  // a purchase order — Houzs's cloned mfg_purchase_order_items uses the
  // supplier-binding `material_code` vocabulary (no item_code column); the SKU
  // code IS the material_code on a PO line. No doc col on the line.
  const poRows = await db
    .select({ id: purchaseOrderItems.id })
    .from(purchaseOrderItems)
    .where(eq(purchaseOrderItems.materialCode, code))
    .limit(1);
  if (poRows.length > 0) return { where: "a purchase order", doc: null };

  // a stock movement — inventory_movements.product_code -> source_doc_no.
  const mvRows = await db
    .select({ doc: inventoryMovements.sourceDocNo })
    .from(inventoryMovements)
    .where(eq(inventoryMovements.productCode, code))
    .limit(1);
  if (mvRows.length > 0) return { where: "a stock movement", doc: mvRows[0].doc ?? null };

  return null;
}

/** First used SKU under a Model (with the place it's used), or null if the whole
 *  Model is still unused and therefore safe to delete. */
export async function findModelUsage(
  db: Db,
  modelId: string,
): Promise<(SkuUsage & { code: string }) | null> {
  const skus = await db
    .select({ code: mfgProducts.code })
    .from(mfgProducts)
    .where(eq(mfgProducts.modelId, modelId));
  for (const s of skus) {
    const u = await findSkuUsage(db, s.code);
    if (u) return { ...u, code: s.code };
  }
  return null;
}
