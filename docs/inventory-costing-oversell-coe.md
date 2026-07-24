# Inventory Costing — Oversell Uncosted-COGS COE (Correction of Error)

**Date:** 2026-07-24
**Trigger:** Owner reported that some ACCESSORIES were already SHIPPED but the Delivery Order shows NO cost — RM0 — with margin therefore reading as pure profit on those lines. Asked for a read-only audit of the whole inventory-costing pipeline ("this is the most money-sensitive area") before any fix.
**Status:** Root cause TRACED and confirmed against the code. NO costing-logic change shipped (owner owns that decision). Shipped a READ-ONLY DETECTOR to size the exposure; the fix is DEFERRED to the owner. This is the per-class COE; the specific RM0 symptom is also logged in `BUG-HISTORY.md`.

---

## 1. Incident — what staff saw

Accessories that had physically shipped on a DO carried `unit_cost_centi = 0` / `line_cost_centi = 0`, so the DO (and its Sales Invoice) showed RM0 COGS and 100% margin on those lines. Not every shipped accessory — a subset — and they did not self-correct over time.

## 2. Root cause — traced against the code, not guessed

The FIFO costing pipeline itself is CORRECT by design. The fault is a WIRING gap in when the retro-cost reconcile is invoked.

**The pipeline (all correct, cited):**
- **IN (GRN post):** `backend/src/scm/routes/grns.ts` `postGrnAndRollup` writes an `IN` movement at landed MYR cost (`unit_cost_sen = round(PO price x rate) + allocated freight`, migration 0082, `grns.ts:435`); the FIFO trigger opens one `inventory_lots` row (`backend/scripts/scm-schema/inventory-fifo-trigger.sql`, `IN` branch).
- **OUT (DO ship):** `deductInventoryForDo` (`delivery-orders-mfg.ts:833`) writes an `OUT` movement; the trigger's `OUT` branch calls `fn_consume_fifo` / `fn_consume_fifo_batch` (oldest lot first, `ORDER BY received_at ASC, id ASC`), stamps the real COGS onto the movement, then `restampDoActualCost` (`delivery-orders-mfg.ts:529`) copies it onto the DO line, and the SI copies the DO (`sales-invoices.ts` `POST /from-dos`, line 1178).
- **Allocation:** SO line = `cost_price_sen` snapshot at create (estimate, `mfg-sales-orders.ts:1059`); DO = actual FIFO; SI = from DO; PI = final authority (`recost.ts`, `recostFromGrn`/`recostForPi`).

**The gap:** the soft "ship anyway" oversell path (`check-stock-availability.ts`, gated by `confirmShortStock`) lets a DO ship MORE than the warehouse holds. `fn_consume_fifo` then costs only the units on hand and RETURNS the remainder as `qty_short` — which the trigger's `OUT` branch **DISCARDS** (`inventory-fifo-trigger.sql`: the OUT branch only sets `total_cost_sen = v_result.total_cost_sen`; `qty_short` is never persisted). So the short units ship at **ZERO** recorded cost. That RM0 is meant to be retro-costed later by `fn_reconcile_uncosted_out` (migration `0154_scm_oversell_retrocost.sql`) when replenishing stock arrives.

**Why some never self-heal:** `fn_reconcile_uncosted_out` is invoked from EXACTLY ONE place — the GRN post handler (`grns.ts:493`, via `reconcileUncostedOuts` in `oversell-retrocost.ts`). Verified by exhaustive grep: no other caller, and no scheduled sweep exists. But lots are opened by MANY other stock-IN paths that never call any reconcile:
`stock-transfers.ts:233,259`, `stock-takes.ts`, inventory adjustments (the trigger's positive-`ADJUSTMENT` branch), `purchase-consignment-receives.ts:194`, and the return paths (`delivery-returns.ts`, `consignment-returns.ts`, `purchase-returns.ts`).

So when an oversold accessory is replenished by an **inter-warehouse transfer** or a positive **stock-take/adjustment** (routine in a multi-branch shop) rather than a GRN, the prior RM0 OUT is **never** retro-costed. COGS stays understated -> margin overstated permanently, and `inventory_balances` (signed movement sum) diverges from `v_inventory_value` (sum of `inventory_lots.qty_remaining`) forever — the exact failure mode migration 0154's own header warns about, but which 0154 only closed for the GRN entry point.

**Tool that proved it:** static trace of `origin/main` — the sole callers of `reconcileUncostedOuts` / `reconcileDropshipBatches` are `grns.ts:461,493`; `writeMovements` (the lot-creating path) is called from all the other IN routes listed above with no accompanying reconcile. The runtime SIZE of the exposure is measured by the detector shipped in §3 (production numbers land when the owner runs it).

## 3. Shipped (2026-07-24) — detection only, NO costing-logic change

| PR | What | Effect |
|----|------|--------|
| (this PR, DRAFT) | `backend/scripts/check-uncosted-cogs.mjs` + `.github/workflows/uncosted-cogs-check.yml` — a read-only detector following the `check-soak-gate.mjs` pattern (workflow_dispatch, own concurrency group, `secrets.DATABASE_URL`, SELECT-only, exit 0 for every legitimate answer, results as `::notice::` annotations). Runs two queries: (a) uncosted/RM0 OUT movements on non-cancelled DOs, split into SHORT-COSTED (units with no lot consumed — the oversell gap) vs ZERO-PRICED (fully consumed at RM0 — the self-healing Pending-price case); (b) which short-costed buckets have OPEN cover lots NOW (the TRUE permanent-miss set), with an estimated understated-COGS figure walked oldest-lot-first. | Sizes the exposure without an owner interruption or the DSN in front of a human. Touches no data and no costing logic. |

Run: Actions -> **Uncosted COGS check (read-only)** -> Run workflow; the verdict appears as run annotations.

## 4. What the audit RULED OUT

- **Category exemption for accessories — FALSE.** Only SERVICE SKUs (`SVC-*`: delivery fee / dispose / lift) are FIFO-exempt (`service-sku.ts`, `isServiceLine`; skipped in `deductInventoryForDo` and the GRN IN builder). `ACCESSORY` is a goods group with `variant_key = ''` (`variant-key.ts:19`) and IS FIFO-costed. So the RM0 is a missing-cost condition, not "accessories aren't costed."
- **A broken pipeline — FALSE.** IN/OUT/FIFO/allocation are correct by design (§2). The FIFO ordering, the DO restamp, the DO->SI copy, and the PI recost cascade all work.
- **The display switch — NOT the cause.** `costing-enabled.ts` gates cost DISPLAY only, never capture, and deliberately excludes the product-cost path; it cannot zero stored cost data.
- **3 of the 4 RM0 mechanisms self-heal.** (A) oversell shipped before the GRN posts -> reconciled when that GRN posts; (B) GRN received at 0 / "Pending" price -> fixed by `recostFromGrn` when the PI lands; (C) reconcile fired but no lot was available yet -> retried idempotently on the next receipt. Only the 4th — oversold, then replenished via a NON-GRN IN path — is the permanent miss.
- **A variant-key mismatch stranding accessory cost — LOW.** Accessories key to `''` on both the IN and OUT sides, so plain accessories match. (Sofa/bedframe legacy POS-vs-Backend keys remain a separate, noted fragility — not this incident.)

## 5. DEFERRED — owner decides (intentionally NOT auto-done)

1. **The fix itself — owner (money-critical costing change).** Options: (a) extend the `reconcileUncostedOuts` caller to the other stock-IN paths (stock-transfer / stock-take / adjustment / consignment-receive / returns) so any replenishment retro-costs prior shorts; or (b) add a periodic read-then-reconcile sweep over uncosted OUTs. Either is a change to the money-critical scm FIFO layer that lives directly in prod and is not fully reproducible from the repo, so per the 0154 header it MUST be validated on STAGING first and the apply coordinated — do NOT merge blind. Not attempted in this PR.
2. **Backfill of already-stranded rows — owner.** Once the detector quantifies the permanent-miss set, the owner decides whether to retro-cost the historical rows (and at which cost basis) — same STAGING-first discipline.
3. **Storing the shortfall explicitly — owner/eng.** The trigger discards `qty_short`; there is no column flagging an OUT as under-costed, so detection depends on the consumptions-vs-qty join. A persisted shortfall flag would make orphaned RM0 rows self-evident. Design decision, deferred.

## 6. Lessons

- **A correct function is not a correct system.** `fn_reconcile_uncosted_out` is right; it was simply wired to one of several stock-IN entry points. When a retro-cost/repair routine exists, audit EVERY path that creates the condition it repairs, not just the one it was born next to.
- **"Best-effort, self-heals later" needs a guaranteed later.** The oversell RM0 is acceptable ONLY because a receipt reconciles it — that guarantee silently doesn't hold for non-GRN replenishment. Any "will be fixed on the next X" needs X to be the ONLY way the state can change, or a sweep to catch the rest.
- **Size before fixing money data.** The safe first move on a money-critical gap is a read-only detector (this PR), not a hot fix — it quantifies the exposure and gives the owner the numbers to decide, with zero risk to the FIFO layer.
- **Verify against the pipeline, not the symptom.** The RM0 looked like "accessories aren't costed"; tracing the actual code showed accessories ARE costed and the real fault was reconcile wiring — the ruled-out list (§4) is what stops the next person re-chasing the category-exemption theory.
