// ----------------------------------------------------------------------------
// so-stock-allocation — auto-allocate live inventory to PENDING SO lines
// (Commander 2026-05-30, B2C READY-when-stock-on-hand model). 1:1 clone of
// 2990s apps/api/src/lib/so-stock-allocation.ts, translated PostgREST -> Drizzle
// and trimmed to the GENERIC per-line FIFO walk per Strategy-2.
//
// B2C reality: customer orders a SKU at the showroom. If it's on the shelf, the
// SO is "ready"; if not, wait for the GRN. The operator should NOT manually flip
// stock_status — the system derives it from live inventory_balances + the
// outstanding SO claims (older orders claim stock first).
//
// Algorithm (unchanged from 2990s for the generic path):
//   1. Pull every non-cancelled, non-terminal SO line (PENDING + READY).
//   2. Sum live inventory_balances per (warehouse, product_code, variant_key).
//   3. Walk lines in priority order (customer_delivery_date ASC NULLS LAST →
//      SO doc_no → created_at), deducting each line's deliverable_remaining
//      from its warehouse bucket: enough → READY, partial → PARTIAL, none →
//      PENDING. Idempotent on stable stock.
//   4. UPDATE stock_status only on changed lines.
//   5. Per touched SO: re-aggregate header (all MAIN READY → READY_TO_SHIP;
//      a MAIN line back to PENDING → CONFIRMED).
//
// SEAMS / Strategy-2 deviations (documented inline):
//   - DB layer: 2990s Supabase (`sb`) -> Houzs Drizzle (`db = getDb(c.env)`),
//     passed as the first arg. inventory_balances is a VIEW (migration 0026),
//     read via db.execute(sql`...`).
//   - DROPPED the SOFA whole-set batch coverage path (sofa-set-coverage +
//     mfg_products category lookup are furniture). Every line takes the plain
//     per-line FIFO bucket fill, exactly like 2990s's non-sofa lines.
//   - SERVICE detection uses the local ./service-sku predicates (no catalog).
//     computeVariantKey -> a local generic variantKey (item_group + variants
//     JSON), since the furniture computeVariantKey lives in @2990s/shared.
//   - The pg_try_advisory_lock single-flight mutex is dropped (best-effort; the
//     algorithm is deterministic + idempotent so interleaving is benign, same
//     fallback 2990s itself takes when the RPC isn't wired).
//   - delivered/returned netting reads delivery_orders / delivery_returns,
//     which are NOT cloned yet -> those reads are STUBBED to empty (every line
//     deliverable_remaining = qty). TODO: DO/SI slice — wire the DO/DR netting.
//   - so-audit row on flip: kept (best-effort).
// ----------------------------------------------------------------------------

import { and, asc, eq, inArray } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { getDb } from "../db/client";
import { mfgSalesOrders, mfgSalesOrderItems, mfgSoAuditLog } from "../db/schema";
import { isServiceLine } from "./service-sku";
import { summariseReadiness } from "./so-readiness";

type Db = ReturnType<typeof getDb>;

export type AllocationResult = {
  ok: boolean;
  linesFlipped: number;
  ordersAdvanced: number;
  ordersRegressed: number;
  reason?: string;
};

/* Generic variant-key (Strategy-2 replacement for @2990s/shared
   computeVariantKey, which is furniture-coupled). The inventory ledger buckets
   stock by (warehouse, product_code, variant_key); a SO line's variant_key is
   the canonical JSON of its `variants` blob (empty/null = unclassified ''). This
   matches how Houzs's own inventory writes leave variant_key '' for plain
   stock, so a plain SO line draws plain stock. */
function variantKeyOf(variants: unknown): string {
  if (!variants || typeof variants !== "object") return "";
  const keys = Object.keys(variants as Record<string, unknown>);
  if (keys.length === 0) return "";
  try {
    return JSON.stringify(variants);
  } catch {
    return "";
  }
}

/**
 * Resolve READY/PENDING for every active SO line based on live inventory.
 * Idempotent — running twice on the same DB state is a no-op.
 *
 * `scopeToDocNo` (optional): when provided, only WRITES lines on that one SO
 * (still deducts ALL outstanding qty from the bucket first so older orders'
 * claims are respected).
 */
export async function recomputeSoStockAllocation(
  db: Db,
  scopeToDocNo?: string,
): Promise<AllocationResult> {
  try {
    /* 1. All non-cancelled, non-terminal SOs. Allocation priority:
            a) customer_delivery_date ASC NULLS LAST  — earlier delivery wins
            b) created_at ASC  — tiebreaker */
    const orderRows = await db
      .select({
        docNo: mfgSalesOrders.docNo,
        status: mfgSalesOrders.status,
        createdAt: mfgSalesOrders.createdAt,
        customerDeliveryDate: mfgSalesOrders.customerDeliveryDate,
      })
      .from(mfgSalesOrders)
      .where(
        sql`${mfgSalesOrders.status} NOT IN ('CANCELLED','CLOSED','SHIPPED','DELIVERED','INVOICED')`,
      )
      .orderBy(
        sql`${mfgSalesOrders.customerDeliveryDate} ASC NULLS LAST`,
        asc(mfgSalesOrders.createdAt),
      );
    const orders = orderRows.map((o) => ({
      doc_no: o.docNo,
      status: o.status as string,
      created_at: o.createdAt ? new Date(o.createdAt).toISOString() : "",
      customer_delivery_date: o.customerDeliveryDate as string | null,
    }));
    if (orders.length === 0) return { ok: true, linesFlipped: 0, ordersAdvanced: 0, ordersRegressed: 0 };
    const orderByDoc = new Map(orders.map((o) => [o.doc_no, o]));

    // 2. Non-cancelled lines on those SOs.
    const docNos = orders.map((o) => o.doc_no);
    const lineRows = await db
      .select({
        id: mfgSalesOrderItems.id,
        docNo: mfgSalesOrderItems.docNo,
        itemCode: mfgSalesOrderItems.itemCode,
        itemGroup: mfgSalesOrderItems.itemGroup,
        variants: mfgSalesOrderItems.variants,
        qty: mfgSalesOrderItems.qty,
        warehouseId: mfgSalesOrderItems.warehouseId,
        stockStatus: mfgSalesOrderItems.stockStatus,
        stockQtyReady: mfgSalesOrderItems.stockQtyReady,
      })
      .from(mfgSalesOrderItems)
      .where(and(inArray(mfgSalesOrderItems.docNo, docNos), eq(mfgSalesOrderItems.cancelled, false)));
    const lines = lineRows.map((l) => ({
      id: l.id,
      doc_no: l.docNo,
      item_code: l.itemCode,
      item_group: l.itemGroup as string | null,
      variants: l.variants as unknown,
      qty: Number(l.qty ?? 0),
      warehouse_id: l.warehouseId as string | null,
      stock_status: l.stockStatus as string,
      stock_qty_ready: Number(l.stockQtyReady ?? 0),
    }));
    if (lines.length === 0) return { ok: true, linesFlipped: 0, ordersAdvanced: 0, ordersRegressed: 0 };

    /* 3. deliverable_remaining per line = qty − Σ delivered + Σ returned.
          DO/DR are NOT cloned yet -> delivered = returned = 0 -> remaining =
          qty for every line. TODO: DO/SI slice — wire delivery_order_items /
          delivery_return_items netting here (mirrors 2990s lines 154-197). */
    const WH_NONE = "NOWH";
    type LineNeed = { id: string; doc_no: string; bucket: string; need: number; current: string; curReady: number };
    const needs: LineNeed[] = [];
    for (const l of lines) {
      // SERVICE lines are services, not goods: never allocate stock to them.
      if (isServiceLine({ itemGroup: l.item_group, itemCode: l.item_code })) continue;
      const remaining = l.qty; // = qty − delivered + returned, with DO/DR stubbed to 0
      if (remaining <= 0) continue;
      const variant_key = variantKeyOf(l.variants);
      const whId = l.warehouse_id ?? null;
      const bucket = `${whId ?? WH_NONE}::${l.item_code}::${variant_key}`;
      needs.push({
        id: l.id,
        doc_no: l.doc_no,
        bucket,
        need: remaining,
        current: l.stock_status,
        curReady: l.stock_qty_ready,
      });
    }
    if (needs.length === 0) return { ok: true, linesFlipped: 0, ordersAdvanced: 0, ordersRegressed: 0 };

    /* 4. Sort needs by allocation priority (delivery date → SO doc_no →
          created_at + line id). */
    const FAR_FUTURE = "9999-12-31";
    needs.sort((a, b) => {
      const A = orderByDoc.get(a.doc_no);
      const B = orderByDoc.get(b.doc_no);
      const ad = A?.customer_delivery_date ?? FAR_FUTURE;
      const bd = B?.customer_delivery_date ?? FAR_FUTURE;
      if (ad !== bd) return ad.localeCompare(bd);
      if (a.doc_no !== b.doc_no) return a.doc_no.localeCompare(b.doc_no);
      const ac = A?.created_at ?? "";
      const bc = B?.created_at ?? "";
      return ac.localeCompare(bc) || a.id.localeCompare(b.id);
    });

    /* 5. Pull live on-hand, keyed strictly per-warehouse (inventory_balances is
          a VIEW: warehouse_id, product_code, variant_key, qty). */
    const productCodes = [
      ...new Set(needs.map((n) => n.bucket.split("::")[1] ?? "").filter(Boolean)),
    ];
    const onHandByBucket = new Map<string, number>();
    if (productCodes.length > 0) {
      const codeList = productCodes.map((c) => `'${c.replace(/'/g, "''")}'`).join(",");
      const balRes = await db.execute(
        sql.raw(
          `SELECT warehouse_id, product_code, variant_key, qty FROM inventory_balances WHERE product_code IN (${codeList})`,
        ),
      );
      const balRows = (balRes as unknown as { rows?: unknown[] }).rows ?? (balRes as unknown as unknown[]);
      for (const r of (balRows as Array<{ warehouse_id: string; product_code: string; variant_key: string | null; qty: number | string }>)) {
        const v = r.variant_key ?? "";
        const qty = Number(r.qty ?? 0);
        const whKey = `${r.warehouse_id}::${r.product_code}::${v}`;
        onHandByBucket.set(whKey, (onHandByBucket.get(whKey) ?? 0) + qty);
      }
    }

    /* 6. Walk needs in priority order. Partial fill -> PARTIAL, full -> READY,
          zero -> PENDING. */
    type TargetState = { status: "READY" | "PENDING" | "PARTIAL"; qtyReady: number };
    const targetById = new Map<string, TargetState>();
    const remaining = new Map(onHandByBucket);
    for (const n of needs) {
      const avail = remaining.get(n.bucket) ?? 0;
      if (avail >= n.need) {
        targetById.set(n.id, { status: "READY", qtyReady: n.need });
        remaining.set(n.bucket, avail - n.need);
      } else if (avail > 0) {
        targetById.set(n.id, { status: "PARTIAL", qtyReady: avail });
        remaining.set(n.bucket, 0);
      } else {
        targetById.set(n.id, { status: "PENDING", qtyReady: 0 });
      }
    }

    /* 7. Flip lines that changed. Group by (status, qtyReady). Optionally scope
          writes to scopeToDocNo. */
    let linesFlipped = 0;
    type FlipBatch = { ids: string[]; status: "READY" | "PENDING" | "PARTIAL"; qtyReady: number };
    const flipBatches = new Map<string, FlipBatch>();
    for (const n of needs) {
      if (scopeToDocNo && n.doc_no !== scopeToDocNo) continue;
      const t = targetById.get(n.id);
      if (!t) continue;
      if (t.status === n.current && t.qtyReady === n.curReady) continue;
      const key = `${t.status}|${t.qtyReady}`;
      const batch = flipBatches.get(key) ?? { ids: [], status: t.status, qtyReady: t.qtyReady };
      batch.ids.push(n.id);
      flipBatches.set(key, batch);
    }
    for (const batch of flipBatches.values()) {
      await db
        .update(mfgSalesOrderItems)
        .set({ stockStatus: batch.status, stockQtyReady: batch.qtyReady })
        .where(inArray(mfgSalesOrderItems.id, batch.ids));
      linesFlipped += batch.ids.length;
    }

    const targetStatusById = new Map<string, string>();
    for (const [id, t] of targetById) targetStatusById.set(id, t.status);
    const toReady = needs.filter((n) => targetById.get(n.id)?.status === "READY" && targetById.get(n.id)?.status !== n.current).map((n) => n.id);
    const toPending = needs.filter((n) => targetById.get(n.id)?.status === "PENDING" && targetById.get(n.id)?.status !== n.current).map((n) => n.id);
    const toPartial = needs.filter((n) => targetById.get(n.id)?.status === "PARTIAL" && targetById.get(n.id)?.status !== n.current).map((n) => n.id);

    // Audit trail: one entry per affected SO summarising the auto-flip. Best-effort.
    if (toReady.length > 0 || toPending.length > 0 || toPartial.length > 0) {
      const lineToDoc = new Map(lines.map((l) => [l.id, l.doc_no]));
      const byDoc = new Map<string, { ready: string[]; pending: string[]; partial: string[] }>();
      const bucket = (id: string, key: "ready" | "pending" | "partial") => {
        const doc = lineToDoc.get(id);
        if (!doc) return;
        const cur = byDoc.get(doc) ?? { ready: [], pending: [], partial: [] };
        cur[key].push(id);
        byDoc.set(doc, cur);
      };
      for (const id of toReady) bucket(id, "ready");
      for (const id of toPending) bucket(id, "pending");
      for (const id of toPartial) bucket(id, "partial");
      const auditRows: Array<Record<string, unknown>> = [];
      for (const [docNo, flips] of byDoc) {
        const parts: string[] = [];
        if (flips.ready.length) parts.push(`${flips.ready.length} line(s) → READY`);
        if (flips.partial.length) parts.push(`${flips.partial.length} line(s) → PARTIAL`);
        if (flips.pending.length) parts.push(`${flips.pending.length} line(s) → PENDING`);
        auditRows.push({
          soDocNo: docNo,
          action: "UPDATE_LINE",
          actorId: null,
          actorNameSnapshot: "system (auto-allocate)",
          fieldChanges: [{ field: "stockStatus", from: "auto", to: parts.join(", ") }],
          statusSnapshot: null,
          source: "auto-allocation",
          note: "Stock allocation recomputed against live inventory",
        });
      }
      if (auditRows.length > 0) {
        try {
          await db.insert(mfgSoAuditLog).values(auditRows as never);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error("[so-allocation] audit insert failed:", e);
        }
      }
    }

    // 8. Per-SO header re-aggregation (only SOs that had a line flip, + scope).
    const touchedDocs = new Set<string>();
    for (const id of [...toReady, ...toPending, ...toPartial]) {
      const ln = lines.find((l) => l.id === id);
      if (ln) touchedDocs.add(ln.doc_no);
    }
    if (scopeToDocNo) touchedDocs.add(scopeToDocNo);

    let ordersAdvanced = 0,
      ordersRegressed = 0;
    for (const docNo of touchedDocs) {
      const order = orderByDoc.get(docNo);
      if (!order) continue;
      const docLines = lines.filter((l) => l.doc_no === docNo);
      const readinessLines = docLines.map((l) => ({
        item_group: l.item_group,
        item_code: l.item_code,
        stock_status: targetStatusById.get(l.id) ?? l.stock_status,
      }));
      const r = summariseReadiness(readinessLines);
      const cur = order.status;
      if (r.isMainReady && (cur === "CONFIRMED" || cur === "IN_PRODUCTION")) {
        try {
          await db.update(mfgSalesOrders).set({ status: "READY_TO_SHIP" }).where(eq(mfgSalesOrders.docNo, docNo));
          ordersAdvanced += 1;
        } catch {
          /* best-effort */
        }
      } else if (!r.isMainReady && cur === "READY_TO_SHIP") {
        try {
          await db.update(mfgSalesOrders).set({ status: "CONFIRMED" }).where(eq(mfgSalesOrders.docNo, docNo));
          ordersRegressed += 1;
        } catch {
          /* best-effort */
        }
      }
    }

    return { ok: true, linesFlipped, ordersAdvanced, ordersRegressed };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[so-allocation] recompute failed:", e);
    return { ok: false, linesFlipped: 0, ordersAdvanced: 0, ordersRegressed: 0, reason: e instanceof Error ? e.message : String(e) };
  }
}
