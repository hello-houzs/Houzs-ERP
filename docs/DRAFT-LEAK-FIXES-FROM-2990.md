# DRAFT money-leak fixes (ported from 2990) — 2026-06-25

These six fixes were found by a **2990 ↔ Houzs anchoring diff on 2026-06-25**.
Houzs's SCM already has the DRAFT/Confirmed two-state lifecycle for SO/DO/SI/PI/
GRN/etc., but several money/stock aggregates were written before that lifecycle
landed (or were ported from an older 2990 snapshot) and still excluded **only**
`'CANCELLED'`. They forgot the matching `'DRAFT'` exclusion.

The invariant everywhere:

> A query/aggregate that excludes `'CANCELLED'` must **also** exclude `'DRAFT'`.
> A DRAFT document has committed nothing — no shipped stock, no posted revenue/AP,
> no authoritative cost — so it must never leak into a money or stock figure.

All edits are confined to `backend/src/scm/`. No migrations were touched (the scm
views are frozen DDL, so view-backed leaks are filtered at the route instead). No
currency/FX code was touched.

Each leak below: **what could go wrong → file:line fixed → how to verify.**

---

## 1. DO invoiceable / returnable — a DRAFT DO's lines were billable

**What could go wrong:** A DRAFT delivery order has not shipped — it delivered
nothing. But `doLineRemaining` only dropped `CANCELLED` headers, and
`resolveCandidateDoIds` only filtered `CANCELLED`. So a DRAFT DO's lines showed up
in the "Pending" pool that **both** downstream pickers read — meaning you could
raise a Sales Invoice (recognise revenue) or a Delivery Return against goods that
were never actually delivered.

**Fixed (`backend/src/scm/lib/do-line-remaining.ts`):**
- **~line 87** — `doLineRemaining` header filter: now `st === 'CANCELLED' || st === 'DRAFT'` (was CANCELLED only).
- **~line 232** — `resolveCandidateDoIds`: now `.not('status', 'in', '("CANCELLED","DRAFT")')` (was `.neq('status', 'CANCELLED')`), preserving the existing `paginateAll` paging.

(The SI/DR *child* status checks inside `doLineRemaining` correctly stay
`!== 'CANCELLED'` — a draft SI/DR can't exist on a confirmed pool path, and 2990
leaves those untouched too.)

**How to verify:** Create a DRAFT DO with line qty, then open the "convert from DO"
picker for both a Sales Invoice and a Delivery Return — the DRAFT DO's lines must
NOT appear. Confirm the DO (DRAFT → shipped) and they appear.

---

## 2. SI manual re-post — a DRAFT SI's revenue could be posted out-of-band

**What could go wrong:** `POST /accounting/post/si/:invoiceNumber` is the manual
re-post endpoint. It called `postSiRevenue` directly, and `postSiRevenue` does NOT
check status. So an operator hitting this endpoint on a DRAFT SI would post that
draft's revenue to the GL — bypassing the SI confirm transition, which is the only
path that should ever post a draft.

**Fixed (`backend/src/scm/routes/accounting.ts`, `/post/si/:invoiceNumber`, ~line 207):**
Added a pre-check that loads the SI status and returns **409 `not_postable`** when
it's DRAFT (404 if the invoice doesn't exist).

**How to verify:** `POST /accounting/post/si/<a-draft-SI-number>` → expect
`409 { error: "not_postable" }` and no JE created. Confirm the SI first, then the
same call posts revenue normally.

---

## 3. SI AR-aging — DRAFT invoices polluted the AR aging buckets

**What could go wrong:** The `v_ar_aging` view filters `CANCELLED`/`VOID` but not
`DRAFT` (it predates the SI two-state). A DRAFT SI has posted no AR, yet it showed
up in the aging report — overstating receivables and customer balances.

**Fixed (`backend/src/scm/routes/accounting.ts`, `/ar-aging`, ~line 527):**
Added `.neq('status', 'DRAFT')` at the route. The view exposes `s.status`, so this
filters cleanly without a migration.

**How to verify:** With at least one DRAFT SI that has an outstanding balance, call
`GET /accounting/ar-aging` — the DRAFT invoice number must not appear in the rows.

---

## 4. PI recost (MOST money-critical) — a DRAFT PI's price became a GRN lot cost and polluted DO/SI margin

**What could go wrong:** `recostFromGrn` derives each GRN bucket's authoritative
unit cost from its billing PI lines, then cascades that cost down to inventory lots
→ lot consumptions → OUT movements → DO lines → Sales Invoice COGS/margin. The
PI-price aggregate excluded only `CANCELLED` PIs (`piCancelled`). So a **DRAFT** PI's
line price was treated as authoritative — it silently became the carrying cost of
the GRN's lots and flowed all the way into the COGS and margin of every already-
shipped DO and Sales Invoice that drew from those lots. A not-yet-real bill was
rewriting realised margin.

**Fixed (`backend/src/scm/lib/recost.ts`, `recostFromGrn`, ~line 161):**
Renamed `piCancelled` → `piExcluded` and the membership test now skips
`CANCELLED || DRAFT`. Only a confirmed POSTED/PARTIALLY_PAID/PAID PI is treated as
authoritative cost. (No FX/currency logic was introduced — Houzs's recost has no
exchange-rate path, and the fix is purely the status exclusion.)

**How to verify:** Receive a GRN, ship it on a DO, then create a **DRAFT** PI for
that GRN at a wildly different unit price. The DO line's `unit_cost_centi` and its
Sales Invoice margin must NOT move. Confirm the PI (DRAFT → POSTED) and the recost
then flows the billed price down to the DO/SI.

---

## 5. PI GRN-consume — a DRAFT PI could consume a GRN line against a sibling recount

**What could go wrong:** Two helpers recount how much of a GRN line has been
invoiced:
- `recomputeGrnInvoiced` rebuilds `grn_items.invoiced_qty` from live PI lines.
- `verifyGrnLinesNotOverInvoiced` re-sums live invoiced qty to catch over-billing.

Both excluded only `CANCELLED` PIs. So when any sibling operation recounted a GRN
line, a still-**DRAFT** PI's qty was counted as consumed — the GRN line dropped out
of the outstanding-to-invoice picker (or tripped the over-invoice 409) even though
nothing had actually been billed yet.

**Fixed (`backend/src/scm/routes/purchase-invoices.ts`):**
- **~line 74** (`recomputeGrnInvoiced`) — exclusion set now skips `CANCELLED || DRAFT` (renamed `cancelled` → `excluded`).
- **~line 130** (`verifyGrnLinesNotOverInvoiced`) — same `CANCELLED || DRAFT` exclusion (renamed `cancelled` → `excluded`).

The DRAFT's qty is correctly counted only at the confirm transition
(`PATCH /:id/post`), which flips it POSTED and re-runs `recomputeGrnInvoiced`.

**How to verify:** Create a DRAFT PI billing part of a GRN line, then trigger any
op that recounts that GRN line (e.g. open the outstanding-grn-items picker / create
a sibling PI). The GRN line's remaining must still reflect the DRAFT as
**un**-consumed. Confirm the DRAFT PI and the remaining then drops.

---

## 6. PI AP-aging + manual /post/pi — DRAFT PIs leaked into payables

**What could go wrong:** Two leaks, mirroring the SI side:
- `POST /accounting/post/pi/:invoiceNumber` (manual re-post) called
  `postPiAccounting` with no status check — a DRAFT PI's payables could be posted
  to the GL out-of-band.
- The `v_ap_aging` view filters `CANCELLED`/`VOID` but not `DRAFT`, so DRAFT PIs
  overstated the AP aging report.

**Fixed (`backend/src/scm/routes/accounting.ts`):**
- **`/post/pi/:invoiceNumber` (~line 333)** — added the DRAFT pre-check → **409 `not_postable`** (404 if not found), mirroring the `/post/si` guard.
- **`/ap-aging` (~line 549)** — added `.neq('status', 'DRAFT')`; the view exposes `p.status`.

**How to verify:**
- `POST /accounting/post/pi/<a-draft-PI-number>` → expect `409 { error: "not_postable" }`, no JE.
- `GET /accounting/ap-aging` with a DRAFT PI outstanding → the DRAFT must not appear.

---

## Sites checked and already correct (no edit needed)

The PI route's own DRAFT lifecycle was already complete and was **not** part of these
leaks — left as-is:
- `POST /purchase-invoices` create — already gates `recomputeGrnInvoiced` /
  `recostForPi` behind `if (!asDraft)`.
- `PATCH /:id/post` confirm — already runs consume + post + recost exactly once.
- `PATCH /:id/payment` — already rejects DRAFT with `not_payable` (409).
- `PATCH /:id/cancel` — already short-circuits a DRAFT cancel (nothing to reverse).

The SI/DR **child** status filters inside `doLineRemaining` were intentionally left
at `!== 'CANCELLED'` (matches 2990; a draft child can't reach the confirmed pool).

---

## Summary

| # | Leak | File | Status |
|---|------|------|--------|
| 1 | DO invoiceable/returnable | `scm/lib/do-line-remaining.ts` (~87, ~232) | Fixed (both sites) |
| 2 | SI manual re-post | `scm/routes/accounting.ts` `/post/si` (~207) | Fixed |
| 3 | SI AR-aging | `scm/routes/accounting.ts` `/ar-aging` (~527) | Fixed |
| 4 | PI recost (most critical) | `scm/lib/recost.ts` `recostFromGrn` (~161) | Fixed |
| 5 | PI GRN-consume | `scm/routes/purchase-invoices.ts` (~74, ~130) | Fixed (both sites) |
| 6 | PI AP-aging + /post/pi | `scm/routes/accounting.ts` (~333, ~549) | Fixed (both sites) |

No migrations changed. No currency/FX code changed. `backend` typechecks clean.
