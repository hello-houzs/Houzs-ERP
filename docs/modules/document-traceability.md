# Module: Cross-document traceability display (SCM)

Read-time, DISPLAY-ONLY surfacing of "which Sales-side documents did this
purchase document's items end up assigned to", on the expandable rows of the
Purchase Order / GRN / Purchase Invoice lists. No DB writes, no snapshot, no
schema change — every linkage below is resolved at read time from data that
already exists. A persisted-snapshot approach was considered and rejected as
unsafe.

> Owner ask (2026-07-24 live testing): across the procurement chain each
> document should show the Sales Order it is assigned to (+ that SO line's
> delivery date) and, once delivered, the DO and SI the item ended up in.

Line references are against `feat/doc-traceability-display` off `origin/main`
@ `985ee12c`.

---

## 1. The linkage map (read this before changing anything)

There are THREE distinct linkages in play. They are NOT interchangeable; the
whole point of this doc is to record which one answers which question.

| # | Linkage | Where it lives | Semantics | Survives delivery? |
|---|---------|----------------|-----------|--------------------|
| A | **Floating MRP coverage** | `mrp.ts` `computeMrp()` → `mrpLineCoverage()` | Which outstanding PO currently covers which SO line, greedy by delivery date over a POOLED supply. `MrpLine.poNumber` is the forward map (SO line → PO). | **No** — computes over OUTSTANDING demand only; a delivered line is subtracted out (`effQtyOf` / `soDeliverableRemaining`) and `SO_DONE` statuses are excluded. The coverage evaporates the moment the line ships. |
| B | **Stored raise-link + document relationship** | `document-flow.ts` (`/document-flow/:type/:id`) | The SAP-B1 relationship graph. Real stored FKs: `purchase_order_items.so_item_id` (the SO line a PO line was RAISED from, 2026-07-09 onward), the PO "From SOs:" note (pre-MRP shared buys), `grns.purchase_order_id`, `purchase_invoices.grn_id`, `delivery_orders.so_doc_no`, `sales_invoices.*`. | **Yes** — these are immutable stored links; the graph resolves the whole family for any anchor. |
| C | **Physical batch/lot trail** | `soLineShippedSourcePos()` (`delivery-orders-mfg.ts`) | `batch_no = source PO number` (stamped by the GRN, mig 0120, copied onto the FIFO lot by the trigger). Recovers, for a SHIPPED SO line, the PO(s) its goods physically came from, via DO OUT movements ∪ `inventory_lot_consumptions` → `inventory_lots.batch_no`. | **Yes, but only for BATCHED stock** — plain-FIFO un-batched stock carries no batch, so the trail is best-effort and incomplete. |

Key trap: **A ≠ B.** For a PO raised via convert-from-SO, `so_item_id` (B) is the
SO line it was raised for, but the pooled coverage (A) may attribute that PO's
stock to a DIFFERENT, higher-priority SO line. Showing both would present two
conflicting "assigned to" SOs.

---

## 2. What shipped (cleanly derivable)

### 2.1 PO / GRN / PI traceability strip — uses linkage **B**
`frontend/src/components/DocumentTraceability.tsx`, rendered above the per-line
`DocumentLinesExpansion` in each of `PurchaseOrdersListV2` / `GoodsReceivedListV2`
/ `PurchaseInvoicesListV2` (the `Xxx LinesExpansion` wrappers).

- Reuses the EXISTING `useDocumentFlow(type, id)` hook (`vendor/scm/lib/flow-queries.ts`)
  → `GET /api/scm/document-flow/:type/:id`. No new backend endpoint.
- Renders the resolved **Sales Order / Delivery Order / Sales Invoice** documents
  the anchor descends from (anchor node excluded; empty stages omitted).
- The endpoint is already **read-only and company-scoped** server-side
  (`activeCompanyId` gate on the root SOs; `scopeToCompany` on every anchor read).
- Honesty: this is the DOCUMENT RELATIONSHIP (linkage B), NOT a physical-unit
  claim. GRN → PO → SO → DO/SI and PI → GRN → PO → SO → DO/SI both resolve
  through B's stored FKs; the DO/SI simply appear once they exist.

### 2.2 SO-side Q2 — SERVICE lines read READY
Read path, `mfg-sales-orders.ts` `GET /:docNo` and `/:docNo/items`: a service
line (`isServiceLine`) now stamps `stock_state='stock'` so it renders READY, not
a blank cell. Frontend `drillStock` (SO list) service branch returns READY.
Logged in `BUG-HISTORY.md` (bug-class fix).

### 2.3 SO amendments surfaced on the Relationship Map — uses linkage **B**
`GET /document-flow/:type/:id` now returns an extra read-only `amendments` array
alongside `nodes` / `edges` / `rootSos`: `{ id, soDocNo, amendmentNo, status,
createdAt }` for every `so_amendments` row whose `so_doc_no` is one of the
company-scoped `rootSos` (so the amendments inherit the exact company scope the
graph already enforces — no new gate). The field is ADDITIVE: existing consumers
(`DocumentTraceability.tsx`, the vendor `DocumentFlowModal`) ignore it.

The Sales Order relationship map (`so-relationship-map.ts` →
`DocumentRelationshipMapModal`, used by both `SalesOrderDetailV2` and the
`?edit=1` editor `SalesOrderDetail`) reads that array and renders an
"Amendments off the Sales Order" branch of clickable chips beneath the graph,
each opening its job card at `/scm/amendments/:id` (gated `scm.sales.orders` +
allowSales, same as the SO — no extra access check). PO amendments are NOT a
separate document: a PO revision is the PO leg of an SO amendment (approve-po →
`reviseBoundPo` → `po_revisions`), so there is nothing extra to branch off the
PO. The SI / DO / DR maps do not pass amendments and are unchanged.

---

## 3. What was STOP-and-reported (not built — would require fabricating a linkage or new persistence)

### 3.1 PO "assigned to SO + that SO line's delivery date" as a FLOATING view
The floating coverage (A) is derivable-by-inversion of `computeMrp`'s existing
output (group `MrpLine.poNumber` → SO lines; no re-implementation of allocation),
and `computeMrp` already requires `companyId`. BUT:
- It only exists for OUTSTANDING demand, so it cannot also serve the "once
  delivered" half (see 3.2) — the two halves would come from different linkages.
- The covering SO line's **delivery date** is not on any existing PO read path;
  surfacing it needs a small read enrichment, but attaching it to the floating
  assignment (A) while the delivered chain uses the raise-link (B) risks showing
  two different SOs for one PO.
- `PoSupply` in `computeMrp` carries only `po_number` (a string), not the PO id
  or PO-line id, and a split line records only its FIRST covering PO
  (`if (poNumber == null)`), so an inversion under-attributes multi-PO lines.

Decision: shipped the stable stored relationship (B, §2.1) instead. A floating
"assigned to SO (delivery date)" overlay for still-outstanding POs is deferred
pending the owner choosing which semantics to display, because A and B disagree
by design.

### 3.2 "DO# / SI# the item ended up in" as a PHYSICAL trail on the PO
- Via linkage B (shipped): the DO/SI in the relationship graph — honest as a
  document relationship, not a physical-unit trace.
- Via linkage C (physical): a PO → DO reverse of `soLineShippedSourcePos`
  (`batch_no = po_number`) IS technically derivable for BATCHED lots, but is
  best-effort and **incomplete for plain-FIFO un-batched stock** — there is no
  stored trail from a plain-FIFO PO's received units to the specific DO/SI that
  shipped them without new persistence. Not built; reported.

### 3.3 SO-side Q1 — retain the covering PO after a line goes READY
When a covering PO is received (GRN), the line flips to READY-by-STOCK; the
floating coverage (A) drops the PO (demand satisfied) and, until the line ships,
the physical trail (C) has no DO yet — so `coverage_po` goes null in that window.
- **SOFA:** derivable IF `mfg_sales_order_items.allocated_batch_no` (= locked
  source PO, sofa-only, mig 0121, forward-compat-guarded) is read — it is NOT in
  the SO `ITEM` select today.
- **Non-sofa:** NOT derivable — FIFO-pool stock has no per-line batch allocation
  before it ships, so there is no stored PO trail for a READY-by-stock line
  without new persistence.
Reported, not built. `shipped_source_pos` (C) already restores the source PO once
the line SHIPS; the gap is only the received-but-not-yet-shipped window.

---

## 4. Files changed
- `frontend/src/components/DocumentTraceability.tsx` (new).
- `frontend/src/pages/scm-v2/PurchaseOrdersListV2.tsx`, `GoodsReceivedListV2.tsx`,
  `PurchaseInvoicesListV2.tsx` — render the strip in the row-expansion wrappers.
- `frontend/src/pages/scm-v2/MfgSalesOrdersListV2.tsx` — `drillStock` service → READY.
- `backend/src/scm/routes/mfg-sales-orders.ts` — service line `stock_state='stock'`
  (both SO read callsites).

Amendments-on-map + clickability (`feat/relmap-clickable-amendment`, §2.3):
- `backend/src/scm/routes/document-flow.ts` — `amendments` array on the SO-chain response.
- `frontend/src/vendor/scm/lib/flow-queries.ts` — `FlowAmendment` type + response shape.
- `frontend/src/pages/scm-v2/so-relationship-map.ts` — expose amendments + `onAmendmentClick`;
  mark the candidate-PO node `actionable`.
- `frontend/src/components/scm-v2/DocumentRelationshipMapModal.tsx` — amendments branch,
  `AmendmentChip` type, `actionable` flag + clickable-logic fix.
- `frontend/src/pages/scm-v2/SalesOrderDetailV2.tsx`, `SalesOrderDetail.tsx` — pass amendments.

## 5. Out of scope (do not touch)
Delivery-Order surfaces and DO/delivery status logic are owned by a concurrent
session. This work is read-only and never touches DO files.
