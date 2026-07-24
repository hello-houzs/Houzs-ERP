# 2990 vs Houzs — allocation / batch / costing / inventory parity audit

Date: 2026-07-24. Owner-requested audit of the order-to-ship chain, run as two
parallel code reads (2990 source at `wenwei4046/2990s`; Houzs at `origin/main`).
Written so nobody has to re-excavate either codebase to answer these questions
again. File refs are as of this date.

## Verdict

The port is essentially complete: allocation priority, the MRP PO pool, the
sofa dye-lot rules, negative-stock shipping with GRN-time reconcile, the
three-layer cost model, and the inventory ledger all match 2990. **One real
gap** (below) and two cosmetic stale comments.

| Area | 2990 | Houzs | Verdict |
|---|---|---|---|
| Allocation priority | customer_delivery_date ASC (nulls last) -> SO doc_no -> created_at; per-warehouse buckets; ALL categories | identical (`so-stock-allocation.ts` needs.sort; `mrp.ts` demand walk) | MATCH |
| Category rules | no per-category priority; SOFA only carve-out = whole-SET batch match; SERVICE skipped | identical | MATCH |
| Incoming-PO assignment | pure pool per (warehouse, code, variant); earliest effective ETA (latest revised date) to highest-priority uncovered line; `so_item_id` not an ownership claim | identical | MATCH |
| Sofa dye lot | one batch (= source PO no) must cover the WHOLE set, never split; FIFO-oldest covering batch; `allocated_batch_no` on the SO line; DO guards: no-batch 409 + partial-set 409; guards survive `confirmShortStock` | identical (`sofa-set-coverage.ts`, `sofa-batch-guard.ts`) | MATCH |
| Ship without stock | soft warn -> `confirmShortStock` -> OUT written, balance goes NEGATIVE; short units ship at zero recorded cost | identical | MATCH |
| Reconcile at GRN | drop-ship reconcile (`fn_reconcile_dropship_batch`): consume shortfall from arriving lots, restamp OUT cost, cascade to DO/SI | Houzs has BOTH the drop-ship reconcile AND a plain-oversell retro-cost (`fn_reconcile_uncosted_out`, mig 0154) | MATCH (Houzs wider) |
| Cost model | SO line = snapshot at create (price tables); GRN = landed cost (PO price x rate + freight) into FIFO lots; DO OUT = actual FIFO COGS restamped onto DO lines then SI; PI recost = final authority, cascades | identical + Houzs freezes `ship_cost_centi` once (mig 0143) enabling the 3-way SO-vs-ship-vs-PI costing report | MATCH (Houzs wider) |
| Fair/Sales report cost fields | — | `total_so_cost_centi` = SO-time snapshot roll-up; `total_do_cost_centi` = frozen actual ship cost; the delta is the point | (documented) |
| Inventory ledger | `inventory_movements` (IN/OUT/ADJUSTMENT) -> AFTER-INSERT FIFO trigger -> `inventory_lots` + `inventory_lot_consumptions`; balances are a SUM view with no floor | identical design; Houzs adds consignment types (CS_DO/CS_DR/PC_RECEIVE/PC_RETURN); DO/DR reversals use signed ADJUSTMENT rows because the idempotency indexes (`uq_inv_mov_do_source` etc.) exclude movement_type | MATCH |
| Convert-from-SO guard | ordinary picker path REJECTS qty over remaining (409 `qty_exceeds_remaining`, `po_qty_picked` cap); MRP path uncapped by design (`from_mrp` lines excluded from the counter) | **GAP: no server-side cap at all.** The From-SO picker only SHOWS lines whose pooled shortage > 0 (UI-level protection); `po_qty_picked` is a soft self-healing counter, never a write guard | **GAP** |

## The one gap, and the owner's questions it answers

**Gap:** Houzs dropped 2990's hard remaining-qty rejection on the ordinary
convert-from-SO path. Normal operation is safe (the picker hides fully-covered
lines) but nothing server-side stops a duplicate over-convert. Cheap fix:
restore the 409 on the non-MRP path, mirroring 2990
(`mfg-purchase-orders.ts` in 2990 rejects with `qty_exceeds_remaining`).
Status: proposed to the owner 2026-07-24, awaiting go-ahead.

**Owner Q&A settled by this audit (2026-07-24):**
- "Mattress 是不是按 delivery date 分配?" — yes, and so is everything else;
  delivery-date-first is the global rule, mattress is not special.
- "PO 是不是跟着 delivery priority 调配?" — yes; earliest-ETA PO goes to the
  earliest-delivery uncovered line, regardless of which SO raised the PO.
- "没货强行出货会怎样?" — supported flow: warn, confirm, negative stock, batch
  stamped from the bound PO, auto-reconciled and re-costed at GRN. The
  2990-era incident (shipped sofa before GR, negative stock, SO kept its batch
  number) is exactly this designed path.
- "SO 二次 convert 怎么防重?" — 2990: hard cap on the ordinary path + pooled
  shortage view on the MRP path. Houzs: pooled shortage view only (see gap).
- "Costing / 库存进出跟 2990 一样吗?" — yes (and slightly wider).

**Stale comments (cosmetic, both repos):** the top-of-file prose in
`so-stock-allocation.ts` still describes the older "FIFO by created_at" model;
the live comparators are delivery-date-first. Fix the comment when next in the
file.
