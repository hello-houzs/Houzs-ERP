// ----------------------------------------------------------------------------
// SO ← DO/SI/DR downstream aggregates. Ported from the read-only helpers in
// 2990s apps/api/src/routes/delivery-orders-mfg.ts (computeSoLifecycle /
// soCurrentDocNo / soDeliverableRemaining / soLineDeliveries) + the SO
// child-lock. Co-located in a lib (not the route file) so routes/mfg-sales-orders
// can un-stub its DO/SI-dependent aggregates without importing a whole route
// module. SEAMS: Supabase PostgREST -> Drizzle (rule #3).
//
// The DO/SI/DR slice (#66) cloned delivery_orders / sales_invoices /
// delivery_returns, so these are now LIVE (were faithful empties while the SO
// slice shipped). The 2990s sofa-module listing-order re-walk is dropped per
// Strategy-2 — lines order by line_no then created_at (generic).
// ----------------------------------------------------------------------------

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { getDb } from "../db/client";
import {
  mfgSalesOrderItems as soItemsTable,
  deliveryOrders as doTable,
  deliveryOrderItems as doItemsTable,
  salesInvoices as siTable,
  deliveryReturns as drTable,
  deliveryReturnItems as drItemsTable,
} from "../db/schema";

type Db = ReturnType<typeof getDb>;

/* SO child-lock — an SO locks (no line edit / no CANCELLED transition) once it
   has ANY non-cancelled Delivery Order OR Sales Invoice referencing it. Returns
   the blocking JSON or null. */
export async function soChildLock(db: Db, soDocNo: string): Promise<{ error: string; message: string } | null> {
  const [doRows, siRows] = await Promise.all([
    db.select({ id: doTable.id }).from(doTable).where(and(eq(doTable.soDocNo, soDocNo), sql`${doTable.status} <> 'CANCELLED'`)).limit(1),
    db.select({ id: siTable.id }).from(siTable).where(and(eq(siTable.soDocNo, soDocNo), sql`${siTable.status} <> 'CANCELLED'`)).limit(1),
  ]);
  if (doRows.length > 0 || siRows.length > 0) {
    return { error: "so_has_downstream", message: "This Sales Order has a Delivery Order / Sales Invoice — delete or cancel it first to edit or cancel." };
  }
  return null;
}

/* Which SOs (of the given doc nos) have ANY non-cancelled DO or SI. */
export async function soHasChildrenSet(db: Db, docNos: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (docNos.length === 0) return out;
  const [doRows, siRows] = await Promise.all([
    db.select({ soDocNo: doTable.soDocNo }).from(doTable).where(and(inArray(doTable.soDocNo, docNos), sql`${doTable.status} <> 'CANCELLED'`)),
    db.select({ soDocNo: siTable.soDocNo }).from(siTable).where(and(inArray(siTable.soDocNo, docNos), sql`${siTable.status} <> 'CANCELLED'`)),
  ]);
  for (const r of doRows) if (r.soDocNo) out.add(r.soDocNo);
  for (const r of siRows) if (r.soDocNo) out.add(r.soDocNo);
  return out;
}

const day = (d: string) => (d ?? "").slice(0, 10);

/* Per-SO lifecycle by "latest event wins": no events -> 'none'; latest DO ->
   'delivered'; latest SI -> 'invoiced'; latest DR -> 'returned'. A DR carries
   delivery_order_id (no so_doc_no), so it is attributed back via the DO. */
export type SoLifecycle = "none" | "delivered" | "invoiced" | "returned";
export async function computeSoLifecycle(db: Db, docNos: string[]): Promise<Map<string, SoLifecycle>> {
  const out = new Map<string, SoLifecycle>();
  const ids = [...new Set(docNos.filter(Boolean))];
  if (ids.length === 0) return out;
  type Ev = { date: string; createdAt: string; kind: SoLifecycle };
  const events = new Map<string, Ev[]>();
  const push = (doc: string | null | undefined, ev: Ev) => { if (!doc) return; const arr = events.get(doc) ?? []; arr.push(ev); events.set(doc, arr); };

  const [doRes, siRes] = await Promise.all([
    db.select({ id: doTable.id, soDocNo: doTable.soDocNo, doDate: doTable.doDate, createdAt: doTable.createdAt, status: doTable.status }).from(doTable).where(and(inArray(doTable.soDocNo, ids), sql`${doTable.status} <> 'CANCELLED'`)),
    db.select({ soDocNo: siTable.soDocNo, invoiceDate: siTable.invoiceDate, createdAt: siTable.createdAt, status: siTable.status }).from(siTable).where(and(inArray(siTable.soDocNo, ids), sql`${siTable.status} <> 'CANCELLED'`)),
  ]);
  const doToSo = new Map<string, string>();
  for (const d of doRes) { if (d.soDocNo) doToSo.set(d.id, d.soDocNo); push(d.soDocNo, { date: (d.doDate as string) ?? isoStr(d.createdAt), createdAt: isoStr(d.createdAt), kind: "delivered" }); }
  for (const s of siRes) push(s.soDocNo, { date: (s.invoiceDate as string) ?? isoStr(s.createdAt), createdAt: isoStr(s.createdAt), kind: "invoiced" });

  const doIds = [...doToSo.keys()];
  if (doIds.length > 0) {
    const drRows = await db.select({ deliveryOrderId: drTable.deliveryOrderId, returnDate: drTable.returnDate, createdAt: drTable.createdAt, status: drTable.status }).from(drTable).where(and(inArray(drTable.deliveryOrderId, doIds), sql`${drTable.status} <> 'CANCELLED'`));
    for (const r of drRows) { const so = r.deliveryOrderId ? doToSo.get(r.deliveryOrderId) : undefined; push(so, { date: (r.returnDate as string) ?? isoStr(r.createdAt), createdAt: isoStr(r.createdAt), kind: "returned" }); }
  }

  const priority: Record<SoLifecycle, number> = { none: 0, delivered: 1, invoiced: 2, returned: 3 };
  for (const [doc, evs] of events) {
    let best: Ev | null = null;
    for (const ev of evs) {
      if (!best) { best = ev; continue; }
      const dc = day(ev.date).localeCompare(day(best.date));
      if (dc > 0) { best = ev; continue; }
      if (dc < 0) continue;
      const cc = ev.createdAt.localeCompare(best.createdAt);
      if (cc > 0) { best = ev; continue; }
      if (cc < 0) continue;
      if (priority[ev.kind] > priority[best.kind]) best = ev;
    }
    out.set(doc, best ? best.kind : "none");
  }
  return out;
}

/* Current document per SO — the number of the furthest-forward non-cancelled doc
   (DO rank 1 -> SI rank 2 -> DR rank 3), by latest business date then created_at
   then rank. SOs with no downstream are ABSENT (caller falls back to the SO no). */
export async function soCurrentDocNo(db: Db, docNos: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(docNos.filter(Boolean))];
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  type Ev = { date: string; createdAt: string; rank: number; docNumber: string };
  const byKey = new Map<string, Ev[]>();
  const push = (doc: string | null | undefined, ev: Ev) => { if (!doc) return; const arr = byKey.get(doc) ?? []; arr.push(ev); byKey.set(doc, arr); };

  const [doRes, siRes] = await Promise.all([
    db.select({ id: doTable.id, soDocNo: doTable.soDocNo, doNumber: doTable.doNumber, doDate: doTable.doDate, createdAt: doTable.createdAt, status: doTable.status }).from(doTable).where(and(inArray(doTable.soDocNo, ids), sql`${doTable.status} <> 'CANCELLED'`)),
    db.select({ soDocNo: siTable.soDocNo, invoiceNumber: siTable.invoiceNumber, invoiceDate: siTable.invoiceDate, createdAt: siTable.createdAt, status: siTable.status }).from(siTable).where(and(inArray(siTable.soDocNo, ids), sql`${siTable.status} <> 'CANCELLED'`)),
  ]);
  const doToSo = new Map<string, string>();
  for (const d of doRes) { if (d.soDocNo) doToSo.set(d.id, d.soDocNo); push(d.soDocNo, { date: (d.doDate as string) ?? isoStr(d.createdAt), createdAt: isoStr(d.createdAt), rank: 1, docNumber: d.doNumber ?? "—" }); }
  for (const s of siRes) push(s.soDocNo, { date: (s.invoiceDate as string) ?? isoStr(s.createdAt), createdAt: isoStr(s.createdAt), rank: 2, docNumber: s.invoiceNumber ?? "—" });

  const doIds = [...doToSo.keys()];
  if (doIds.length > 0) {
    const drRows = await db.select({ deliveryOrderId: drTable.deliveryOrderId, returnNumber: drTable.returnNumber, returnDate: drTable.returnDate, createdAt: drTable.createdAt, status: drTable.status }).from(drTable).where(and(inArray(drTable.deliveryOrderId, doIds), sql`${drTable.status} <> 'CANCELLED'`));
    for (const r of drRows) { const so = r.deliveryOrderId ? doToSo.get(r.deliveryOrderId) : undefined; push(so, { date: (r.returnDate as string) ?? isoStr(r.createdAt), createdAt: isoStr(r.createdAt), rank: 3, docNumber: r.returnNumber ?? "—" }); }
  }

  for (const [doc, evs] of byKey) {
    let best: Ev | null = null;
    for (const ev of evs) {
      if (!best) { best = ev; continue; }
      const dc = day(ev.date).localeCompare(day(best.date));
      if (dc > 0) { best = ev; continue; }
      if (dc < 0) continue;
      const cc = ev.createdAt.localeCompare(best.createdAt);
      if (cc > 0) { best = ev; continue; }
      if (cc < 0) continue;
      if (ev.rank > best.rank) best = ev;
    }
    if (best) out.set(doc, best.docNumber);
  }
  return out;
}

/* Per-SO-LINE live delivery/remaining for ONE SO's detail. Returns, per SO item
   id: delivered (Σ non-cancelled DO), returned (Σ non-cancelled DR via DO line),
   remaining (qty − delivered + returned), and the list of DO deliveries
   (do_number + qty + status, cancelled DOs excluded). */
export type SoLineDelivery = { doNumber: string; qty: number; status: string };
export type SoLineDeliveryInfo = { delivered: number; returned: number; remaining: number; deliveries: SoLineDelivery[] };

export async function soLineDeliveryInfo(db: Db, docNo: string): Promise<Map<string, SoLineDeliveryInfo>> {
  const out = new Map<string, SoLineDeliveryInfo>();
  const soItems = await db.select({ id: soItemsTable.id, qty: soItemsTable.qty }).from(soItemsTable).where(and(eq(soItemsTable.docNo, docNo), eq(soItemsTable.cancelled, false))).orderBy(sql`${soItemsTable.lineNo} ASC NULLS LAST`, asc(soItemsTable.createdAt));
  if (soItems.length === 0) return out;
  const soItemIds = soItems.map((l) => l.id);

  const doLineRows = await db.select({ id: doItemsTable.id, soItemId: doItemsTable.soItemId, qty: doItemsTable.qty, deliveryOrderId: doItemsTable.deliveryOrderId }).from(doItemsTable).where(inArray(doItemsTable.soItemId, soItemIds));
  const doIds = [...new Set(doLineRows.map((l) => l.deliveryOrderId).filter(Boolean))];
  const doMeta = new Map<string, { doNumber: string; status: string }>();
  if (doIds.length > 0) {
    const dos = await db.select({ id: doTable.id, doNumber: doTable.doNumber, status: doTable.status }).from(doTable).where(inArray(doTable.id, doIds));
    for (const d of dos) { if ((d.status ?? "").toUpperCase() === "CANCELLED") continue; doMeta.set(d.id, { doNumber: d.doNumber ?? "—", status: (d.status ?? "").toUpperCase() }); }
  }
  const doLineToSoItem = new Map<string, string>();
  const deliveredBySoItem = new Map<string, number>();
  const deliveriesBySoItem = new Map<string, SoLineDelivery[]>();
  for (const l of doLineRows) {
    const meta = doMeta.get(l.deliveryOrderId);
    if (!l.soItemId || !meta) continue;
    doLineToSoItem.set(l.id, l.soItemId);
    deliveredBySoItem.set(l.soItemId, (deliveredBySoItem.get(l.soItemId) ?? 0) + Number(l.qty ?? 0));
    const arr = deliveriesBySoItem.get(l.soItemId) ?? [];
    arr.push({ doNumber: meta.doNumber, qty: Number(l.qty ?? 0), status: meta.status });
    deliveriesBySoItem.set(l.soItemId, arr);
  }

  const returnedBySoItem = new Map<string, number>();
  const activeDoLineIds = [...doLineToSoItem.keys()];
  if (activeDoLineIds.length > 0) {
    const drLineRows = await db.select({ doItemId: drItemsTable.doItemId, qtyReturned: drItemsTable.qtyReturned, deliveryReturnId: drItemsTable.deliveryReturnId }).from(drItemsTable).where(inArray(drItemsTable.doItemId, activeDoLineIds));
    const drIds = [...new Set(drLineRows.map((l) => l.deliveryReturnId).filter(Boolean))];
    const activeDrIds = new Set<string>();
    if (drIds.length > 0) {
      const drs = await db.select({ id: drTable.id, status: drTable.status }).from(drTable).where(inArray(drTable.id, drIds));
      for (const d of drs) if ((d.status ?? "").toUpperCase() !== "CANCELLED") activeDrIds.add(d.id);
    }
    for (const l of drLineRows) {
      if (!l.doItemId || !activeDrIds.has(l.deliveryReturnId)) continue;
      const soItemId = doLineToSoItem.get(l.doItemId);
      if (!soItemId) continue;
      returnedBySoItem.set(soItemId, (returnedBySoItem.get(soItemId) ?? 0) + Number(l.qtyReturned ?? 0));
    }
  }

  for (const l of soItems) {
    const qty = Number(l.qty ?? 0);
    const delivered = deliveredBySoItem.get(l.id) ?? 0;
    const returned = returnedBySoItem.get(l.id) ?? 0;
    out.set(l.id, { delivered, returned, remaining: qty - delivered + returned, deliveries: deliveriesBySoItem.get(l.id) ?? [] });
  }
  return out;
}

/* Batched net delivered/returned per SO ITEM id (for ANY set of line ids, across
   many SOs). delivered = Σ qty on non-cancelled DO lines; returned = Σ
   qty_returned on non-cancelled DR lines traced via the DO line. Used by
   so-stock-allocation to compute deliverable_remaining = qty − delivered +
   returned without importing a route. Same DO/DR netting as soLineDeliveryInfo,
   only batched + keyed by the caller's id list. */
export async function soNetDeliveredByItem(
  db: Db,
  soItemIds: string[],
): Promise<Map<string, { delivered: number; returned: number }>> {
  const out = new Map<string, { delivered: number; returned: number }>();
  if (soItemIds.length === 0) return out;

  const doLineRows = await db
    .select({ id: doItemsTable.id, soItemId: doItemsTable.soItemId, qty: doItemsTable.qty, deliveryOrderId: doItemsTable.deliveryOrderId })
    .from(doItemsTable)
    .where(inArray(doItemsTable.soItemId, soItemIds));
  const doIds = [...new Set(doLineRows.map((l) => l.deliveryOrderId).filter(Boolean))];
  const activeDoIds = new Set<string>();
  if (doIds.length > 0) {
    const dos = await db.select({ id: doTable.id, status: doTable.status }).from(doTable).where(inArray(doTable.id, doIds));
    for (const d of dos) if ((d.status ?? "").toUpperCase() !== "CANCELLED") activeDoIds.add(d.id);
  }
  const doLineToSoItem = new Map<string, string>();
  for (const l of doLineRows) {
    if (!l.soItemId || !activeDoIds.has(l.deliveryOrderId)) continue;
    doLineToSoItem.set(l.id, l.soItemId);
    const cur = out.get(l.soItemId) ?? { delivered: 0, returned: 0 };
    cur.delivered += Number(l.qty ?? 0);
    out.set(l.soItemId, cur);
  }

  const activeDoLineIds = [...doLineToSoItem.keys()];
  if (activeDoLineIds.length > 0) {
    const drLineRows = await db
      .select({ doItemId: drItemsTable.doItemId, qtyReturned: drItemsTable.qtyReturned, deliveryReturnId: drItemsTable.deliveryReturnId })
      .from(drItemsTable)
      .where(inArray(drItemsTable.doItemId, activeDoLineIds));
    const drIds = [...new Set(drLineRows.map((l) => l.deliveryReturnId).filter(Boolean))];
    const activeDrIds = new Set<string>();
    if (drIds.length > 0) {
      const drs = await db.select({ id: drTable.id, status: drTable.status }).from(drTable).where(inArray(drTable.id, drIds));
      for (const d of drs) if ((d.status ?? "").toUpperCase() !== "CANCELLED") activeDrIds.add(d.id);
    }
    for (const l of drLineRows) {
      if (!l.doItemId || !activeDrIds.has(l.deliveryReturnId)) continue;
      const soItemId = doLineToSoItem.get(l.doItemId);
      if (!soItemId) continue;
      const cur = out.get(soItemId) ?? { delivered: 0, returned: 0 };
      cur.returned += Number(l.qtyReturned ?? 0);
      out.set(soItemId, cur);
    }
  }
  return out;
}

/* Batched per-SO delivery_state for the list: 'none' (nothing delivered),
   'partial' (some but not all net-delivered), 'full' (every non-cancelled SO
   line's NET delivered (Σ DO − Σ DR) ≥ qty). Also returns has_undelivered (any
   line with remaining > 0). Net-delivered counts non-cancelled DOs minus
   non-cancelled DRs traced via the DO line. Computed for MANY SOs in one pass. */
export type SoDeliveryState = "none" | "partial" | "full";
export async function soDeliveryStateMap(db: Db, docNos: string[]): Promise<Map<string, { state: SoDeliveryState; hasUndelivered: boolean }>> {
  const out = new Map<string, { state: SoDeliveryState; hasUndelivered: boolean }>();
  const ids = [...new Set(docNos.filter(Boolean))];
  if (ids.length === 0) return out;

  const soItems = await db.select({ id: soItemsTable.id, docNo: soItemsTable.docNo, qty: soItemsTable.qty }).from(soItemsTable).where(and(inArray(soItemsTable.docNo, ids), eq(soItemsTable.cancelled, false)));
  if (soItems.length === 0) {
    for (const d of ids) out.set(d, { state: "none", hasUndelivered: false });
    return out;
  }
  const soItemIds = soItems.map((l) => l.id);
  const soItemToDoc = new Map<string, string>();
  for (const l of soItems) soItemToDoc.set(l.id, l.docNo);

  // Σ delivered per SO line via non-cancelled DOs.
  const doLineRows = await db.select({ id: doItemsTable.id, soItemId: doItemsTable.soItemId, qty: doItemsTable.qty, deliveryOrderId: doItemsTable.deliveryOrderId }).from(doItemsTable).where(inArray(doItemsTable.soItemId, soItemIds));
  const doIds = [...new Set(doLineRows.map((l) => l.deliveryOrderId).filter(Boolean))];
  const activeDoIds = new Set<string>();
  if (doIds.length > 0) { const dos = await db.select({ id: doTable.id, status: doTable.status }).from(doTable).where(inArray(doTable.id, doIds)); for (const d of dos) if ((d.status ?? "").toUpperCase() !== "CANCELLED") activeDoIds.add(d.id); }
  const doLineToSoItem = new Map<string, string>();
  const deliveredBySoItem = new Map<string, number>();
  for (const l of doLineRows) { if (!l.soItemId || !activeDoIds.has(l.deliveryOrderId)) continue; doLineToSoItem.set(l.id, l.soItemId); deliveredBySoItem.set(l.soItemId, (deliveredBySoItem.get(l.soItemId) ?? 0) + Number(l.qty ?? 0)); }

  // Σ returned per SO line via non-cancelled DRs (traced through the DO line).
  const returnedBySoItem = new Map<string, number>();
  const activeDoLineIds = [...doLineToSoItem.keys()];
  if (activeDoLineIds.length > 0) {
    const drLineRows = await db.select({ doItemId: drItemsTable.doItemId, qtyReturned: drItemsTable.qtyReturned, deliveryReturnId: drItemsTable.deliveryReturnId }).from(drItemsTable).where(inArray(drItemsTable.doItemId, activeDoLineIds));
    const drIds = [...new Set(drLineRows.map((l) => l.deliveryReturnId).filter(Boolean))];
    const activeDrIds = new Set<string>();
    if (drIds.length > 0) { const drs = await db.select({ id: drTable.id, status: drTable.status }).from(drTable).where(inArray(drTable.id, drIds)); for (const d of drs) if ((d.status ?? "").toUpperCase() !== "CANCELLED") activeDrIds.add(d.id); }
    for (const l of drLineRows) { if (!l.doItemId || !activeDrIds.has(l.deliveryReturnId)) continue; const soItemId = doLineToSoItem.get(l.doItemId); if (!soItemId) continue; returnedBySoItem.set(soItemId, (returnedBySoItem.get(soItemId) ?? 0) + Number(l.qtyReturned ?? 0)); }
  }

  // Roll per-line net-delivered up to the SO: full = every line covered; partial
  // = some net-delivered but not all; none = nothing net-delivered.
  type Acc = { lines: number; fully: number; anyDelivered: boolean; hasUndelivered: boolean };
  const acc = new Map<string, Acc>();
  for (const d of ids) acc.set(d, { lines: 0, fully: 0, anyDelivered: false, hasUndelivered: false });
  for (const l of soItems) {
    const a = acc.get(l.docNo)!;
    const qty = Number(l.qty ?? 0);
    const net = (deliveredBySoItem.get(l.id) ?? 0) - (returnedBySoItem.get(l.id) ?? 0);
    a.lines += 1;
    if (net >= qty && qty > 0) a.fully += 1;
    if (net > 0) a.anyDelivered = true;
    if (qty - net > 0) a.hasUndelivered = true;
  }
  for (const [doc, a] of acc) {
    let state: SoDeliveryState = "none";
    if (a.lines > 0 && a.fully === a.lines) state = "full";
    else if (a.anyDelivered) state = "partial";
    out.set(doc, { state, hasUndelivered: a.hasUndelivered });
  }
  return out;
}

function isoStr(v: Date | string | null): string {
  if (v == null) return "";
  return v instanceof Date ? v.toISOString() : String(v);
}
