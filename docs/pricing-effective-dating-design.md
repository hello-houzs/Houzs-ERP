# Effective-dated pricing (Pricing "Option B") — design

Owner (2026-07-24): *"我要B"* — prices should be **scheduled by date**, and a
document should take the price that was effective **on its own date**, not just
"today's price". Model it on Hookka, which already does this well
(*"去 Hookka-ERP 那邊…Report 就是做到蠻完善的，直接跟著做就行了"*).

Worked example the owner gave:

> 1月1号 100块，3月1号 200块，5月1号 500块

An order dated **2026-02-10** must price at **100**; one dated **2026-04-01** at
**200**; **2026-06-01** at **500**. Change the future without touching the past.

## What exists today (verified against the code)

Houzs already runs TWO working effective-dated systems — we copy their shape, we
do not invent one:

- **`maintenance_config_history`** — the surcharge pools (divan/leg/specials).
  Resolver `loadConfigForScope` (`backend/src/scm/lib/po-pricing.ts:31-47`):
  `.eq('scope', s).lte('effective_from', asOf).order('effective_from', desc)
  .order('created_at', desc).limit(1).maybeSingle()`. Append-only writes via
  `POST /maintenance-config/changes`. **This is the pattern.**
- **`sofa_combo_pricing`** — richer: future-dating + soft-delete + scope
  precedence + deterministic tie-breaks (`pickComboMatch`,
  `sofa-combo-pricing.ts:378-437`). Copy this when a price row needs
  future-dating/soft-delete.

But the two prices the owner actually schedules are NOT effective-dated yet:

- **Product SELLING price** — a FLAT column `scm.mfg_products.sell_price_sen`
  (`2990s-full-schema.sql:550`). The SO recompute reads it with **no date**
  (`mfg-pricing-recompute.ts:415`, via `loadProductByCode`). `master_price_history`
  exists but is **audit-only** (per-field change log, no resolver reads it).
- **Supplier unit price** — flat `supplier_material_bindings.unit_price_centi` +
  `price_matrix` jsonb. Dormant `price_valid_from/to` columns exist but **no read
  path consults them**. No history table.

Money unit throughout: **integer sen/centi** (1/100 MYR; `sen == centi`).
As-of-today helper: `todayMyt()` (`backend/src/scm/lib/my-time.ts:29`, MYT/UTC+8);
frontend mirror `todayMyt()` (`frontend/src/vendor/scm/lib/dates.ts:14`).

## Design principle — ADDITIVE and BACKWARD-COMPATIBLE

The resolver **falls back to the current flat column** when no history row applies.
So with an empty history table, every price resolves EXACTLY as today — zero
behaviour change until someone schedules a price. This is what makes a
money-critical change safe to ship incrementally: the schema + resolver can land
and sit inert; behaviour only moves when the owner uses the feature.

## Phase 1 — Product selling price (this milestone)

### Schema — `scm.mfg_product_price_history` (migration 0187)

```
id              uuid  PK default gen_random_uuid()
company_id      int   NOT NULL          -- per-company: same code can exist in both companies
product_code    text  NOT NULL          -- natural key the pricing path already reads by
sell_price_sen  integer                 -- NULL = "no change to selling price at this date"
effective_from  date  NOT NULL
notes           text
created_at      timestamptz NOT NULL default now()
created_by      text
```
Index: `(company_id, product_code, effective_from DESC, created_at DESC)` — the
exact lookup order. Append-only; rows are immutable history. NO per-column
migration to `mfg_products` — the flat `sell_price_sen` stays the live "current"
value and the fallback.

Keyed by `(company_id, product_code)` — NOT product_id — because the SO pricing
path resolves by code (`loadProductByCode`), and code is unique per company
(task #95 will enforce the DB constraint; today it is unique in practice).

### Resolver — `backend/src/scm/lib/product-pricing-history.ts`

```
resolveSellPriceSenAsOf(sb, companyId, productCode, asOf): Promise<number | null>
```
Newest `effective_from <= asOf` for `(company_id, product_code)`, ordered
`effective_from DESC, created_at DESC, limit 1`; returns its `sell_price_sen`, or
**null** when no such row — caller then uses the flat `mfg_products.sell_price_sen`.
Direct copy of `loadConfigForScope`'s query shape.

`resolvePendingSellPriceSenAfter(...)` — the mirror query with
`effective_from > asOf ... ASC limit 1` — powers a "next price: RM X from
<date>" badge (Hookka shows this; `maintenance-config.ts resolvedHandler` does too).

### Write — `POST /mfg-products/:id/price-changes`

Append one `{ effective_from, sell_price_sen, notes }` row (company-stamped via
`requireActiveCompanyId`). **Auto-baseline** (Hookka trick): when scheduling the
FIRST future price for a product that has none, also insert a history row for
`todayMyt()` snapshotting the product's CURRENT flat `sell_price_sen`, so the
timeline reads "today = current, <future> = new" instead of implying the new price
was always in effect. Append-only — editing a past price means adding a new row.

### Read integration (the ONE money-sensitive change)

`mfg-pricing-recompute.ts` — where `product.sell_price_sen` is consumed
(`:415`): resolve `sell = resolveSellPriceSenAsOf(sb, companyId, code, docDate)
?? product.sell_price_sen`. `docDate` = the SO's own order date (already on the
header), NOT today. Empty history → the `?? flat` branch → identical to today.
Ships in its OWN PR, AFTER the resolver has tests and the write path exists, so
the behaviour change is isolated and reviewable.

### UI — Product Maintenance (`Products.tsx`)

A price-timeline editor on the product: list history rows (date · price · who),
an "add future price" form (date + amount), and a "next: RM X from <date>" badge.
Mirror the maintenance-config editor already in `Products.tsx` and Hookka's
report layout.

### Report

A price-timeline view (per product, and a cross-product "what changed when"),
mirroring Hookka's report. Backed by the history table.

## Phase 2 — Supplier unit price (follow-up)

Same shape, `scm.supplier_binding_price_history` keyed by
`(company_id, supplier_id, material_kind, material_code)` carrying
`unit_price_centi` + `price_matrix` (nullable). Resolver used by
`po-pricing.ts deriveMfgPoUnitCost` (`:111`) and the bulk create-PO path
(`mfg-purchase-orders.ts:1521`), as-of the PO date. Retire or repurpose the
dormant `price_valid_from/to`.

## Rollout order (each its own PR, verified before the next)

1. **DONE (PR #1160)** — migration 0187 + resolver + resolver unit tests. Inert
   (nothing reads it yet). Safe to merge.
2. **DONE** — Write endpoint `POST /mfg-products/:id/price-changes` + auto-baseline
   + tests (`backend/tests/mfgProductPriceChanges.test.ts`).
3. **HELD — money-critical, own CI-verified PR.** Read integration in
   `mfg-pricing-recompute.ts` (as-of doc date, flat fallback) + tests proving
   empty-history == today's price. Deliberately NOT in the ph.2/4 PR, so no
   existing order changes how it is priced.
4. **DONE** — Product Maintenance timeline UI + pending badge (a price-timeline
   panel on the SKU detail drawer in `Products.tsx`: current + "Next: RM X from
   <date>" badges, dated history, and an add-future-price form).
5. Price-timeline report.
6. Phase 2 — supplier price history.

### Go-live backfill (one-time, runs AFTER phase 2 merges)

So no existing price is date-less when effective-dating goes live, a manual
backfill seeds `scm.mfg_product_price_history` from what we already know, PER
COMPANY. `backend/scripts/backfill-product-price-baseline.mjs` +
`.github/workflows/backfill-product-price-baseline.yml` (DRY-RUN default, `apply=1`
to write, staging/prod choice, own concurrency group, `secrets.DATABASE_URL`).

- Keys on `scm.master_price_history` where **`field = 'sell_price_sen'`** (the exact
  value `mfg-products.ts` PATCH writes for the selling price) — reconstructs one
  row per change (`sell_price_sen = new_value_sen`, `effective_from =
  changed_at::date` in **MYT**), plus a baseline for the value BEFORE the first
  change (`old_value_sen` of the earliest record) dated at the product's
  **`created_at::date` (MYT)**, fallback anchor **2024-01-01** when null.
- No audit rows → ONE baseline = the current flat `sell_price_sen` at
  `created_at::date`.
- ALWAYS guarantees a row whose value equals the current flat price so
  `resolveSellPriceSenAsOf(today) == today's price` — no visible change on go-live.
- Non-clobbering + idempotent: any `(company_id, product_code)` that already has
  rows is skipped whole.

## Why this is safe on money

- Additive: no existing column changed; flat prices remain the source of truth
  until a history row exists.
- The as-of date is the DOCUMENT's date — the past cannot silently re-price.
- Append-only history — an audit trail by construction; a wrong future price is
  corrected by appending, and the past rows still show what was charged.
- Every phase after this one is gated on the resolver being tested first.
