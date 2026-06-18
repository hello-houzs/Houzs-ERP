// sku-usage — "has this SKU / Model been used yet?" guard.
//
// Wei Siang 2026-06-08: once a SKU has been USED in a real document — sold on a
// Sales Order, ordered on a Purchase Order, or moved in stock (any inventory
// movement) — it must NOT be deletable, not even by force. Deleting it would
// orphan live order lines (which store item_code as a text snapshot, no FK) and
// destroy stock-movement history. A Model is locked the moment ANY of its SKUs
// is used. Before first use (setup phase) deletes stay allowed so a mistyped
// model can still be removed and re-created.

import type { SupabaseClient } from '@supabase/supabase-js';

export type SkuUsage = { where: string; doc: string | null };

const CHECKS: Array<{ table: string; col: string; label: string; docCol: string | null }> = [
  { table: 'mfg_sales_order_items', col: 'item_code',    label: 'a sales order',    docCol: 'doc_no' },
  { table: 'purchase_order_items',  col: 'item_code',    label: 'a purchase order', docCol: null },
  { table: 'inventory_movements',   col: 'product_code', label: 'a stock movement', docCol: 'source_doc_no' },
];

/** First place a SKU code is referenced by a real document, or null if unused. */
export async function findSkuUsage(sb: SupabaseClient, code: string): Promise<SkuUsage | null> {
  if (!code) return null;
  for (const ch of CHECKS) {
    const sel = ch.docCol ?? ch.col;
    const { data, error } = await sb.from(ch.table).select(sel).eq(ch.col, code).limit(1);
    if (error) continue; // table absent on a fresh DB → treat as not-used (best effort)
    if (data && data.length > 0) {
      const doc = ch.docCol ? ((data[0] as unknown as Record<string, unknown>)[ch.docCol] as string | null) : null;
      return { where: ch.label, doc };
    }
  }
  return null;
}

/** First used SKU under a Model (with the place it's used), or null if the whole
 *  Model is still unused and therefore safe to delete. */
export async function findModelUsage(
  sb: SupabaseClient,
  modelId: string,
): Promise<(SkuUsage & { code: string }) | null> {
  const { data: skus } = await sb.from('mfg_products').select('code').eq('model_id', modelId);
  for (const s of (skus ?? []) as Array<{ code: string }>) {
    const u = await findSkuUsage(sb, s.code);
    if (u) return { ...u, code: s.code };
  }
  return null;
}
