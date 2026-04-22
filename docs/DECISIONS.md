# Decision Log — Sales Module

Record of every change made and **why**. Read this before touching any of these areas so you don't undo a deliberate choice.

---

## 2026-04-22 — New Sales Order modal

### What
A `+ New Sales Order` button on `/sales/orders` opens a modal to create a new SO.

### Why
User manually creates SOs on their old Inistate system. We need the same workflow inside houzs-erp so they stop switching apps. Matching Inistate's layout (labels on left, values on right, borderless inputs) means **zero retraining**.

### Key rules
| Field behaviour | Why |
|---|---|
| **Doc No auto-generated** (`nextSODocNo()` = highest existing + 1) | User should never type a duplicate number |
| **Group is locked** (derived from SKU's itemGroup, shown as read-only pill) | Changing group on a line breaks cost lookup + category-specific variant fields |
| **Unit Price user-typed** (NOT auto-filled from SKU sellingPrice) | Our SKU master has cost only, no reliable selling price. User decides per sale |
| **Qty allows empty state** (reverts to 1 on blur) | User couldn't delete and retype — forced-min was blocking |
| **Payments auto-compute Balance** (Total − Σ payments) | Matches Inistate exactly; no manual balance entry |
| **Balance outstanding flows to SO header** | SO list shows correct outstanding per doc |

---

## 2026-04-22 — Category-specific line cards

### What
Items section is no longer a flat grid. Each line is a **card** with fields that depend on `line.category`:

- **Bedframe**: Category · Product · Size · Fabric · Qty · Base Price · Gap · Divan Height · Leg Height · Total Height · Special Orders · Line Notes
- **Sofa**: Category · Model · Fabric · Qty · Seat Size · Leg · Base Price · Module · Special Orders · Line Notes
- **Mattress / Accessories**: Qty · Unit Price · (minimal)
- **Others**: Qty · Unit Price

### Why
Different product categories have different pricing logic:
- Bedframe price = **base (depends on fabric tier) + divan height surcharge + leg height surcharge + special orders**
- Sofa price = **base (depends on seat size × model tier) + leg surcharge + special orders**
- Mattress/Acc = **flat unit price** (no variants)

One grid can't hold all this — fields are category-specific, so layout must be too.

### Key rules
| Rule | Why |
|---|---|
| **Category drives which fields render** | Matches how pricing is actually composed |
| **SKU dropdown is filtered by category** | 1,468 SKUs in one dropdown is unusable. Pick category → only relevant products show |
| **Base Price disabled until Fabric selected** (Bedframe) | Fabric tier (PRICE_1 / PRICE_2) determines the base; showing surcharge before base is meaningless |
| **Special Orders is collapsible** | Some orders have 0 specials; keeping list always open wastes vertical space |
| **Surcharges stored per-line with the amount** (not just the name) | Variant prices can change in Maintenance; order should preserve the price at time of sale |
| **Unit Price computed live** via `computeUnitPrice(line)` = base + divan + leg + specials | Single source of truth for line total |

---

## 2026-04-22 — Variants pulled from localStorage

### What
LineCard reads maintenance data from localStorage keys:
- `houzs-variants-config` → divan heights, leg heights, gaps, specials, sofa sizes/legs
- `houzs-fabric-tracking` → fabric codes with price tier

### Why
User already edits these in `/sales/sku-costing → Variant Maintenance` tab (copied from hookka-erp-vite). We reuse that config — no duplicate data. Edit a surcharge in Maintenance → next new SO uses the new price.

### Trade-off
Fabrics list is empty on a fresh browser (user hasn't added any yet). The Base Price field shows an amber "Select fabric" state to tell them what to do.

---

## 2026-04-22 — Remove revenue-per-category columns (then restore)

### What
Added revenue columns (Mattress/Sofa, Bedframe, Accessories) alongside cost columns on `/sales/orders`. Removed them when user said "不需要revenue per category". Restored them when user showed the earlier screenshot.

### Why the flip-flop
Ambiguity. Final rule: **revenue + cost are both per-category, side by side**, so user can eyeball margin per group. Total Cost column at end sums all cost columns.

Columns order: `Local Total | Mattress/Sofa | Bedframe | Accessories | Mattress/Sofa Cost | Bedframe Cost | Accessories Cost | Cost (Total) | Margin | Margin%`.

---

## 2026-04-22 — localStorage key versioning + migration

### What
All store keys end in `-v{N}`. When seed data or shape changes, bump `N`. Reading falls back through legacy keys.

### Why
Without this:
- **User loses edits** on every seed update (broke user's column arrangement + cost edits today)

### Rule
1. When adding/changing seed: bump version (`v3` → `v4`)
2. In the read function, try legacy keys (`v3`, `v2`, `v1`) and **merge user edits forward** onto the new seed
3. For column prefs: pass `legacyKeys[]` to `useColumnPrefs(currentKey, defaults, defaults, legacyKeys)`

### Rule of thumb
Never delete a legacy key. Always migrate forward.

---

## 2026-04-22 — SKU Costing: 2-tier tab layout (not multiple sidebar entries)

### What
One sidebar entry `SKU Costing`. Inside:
- Primary tabs (left, beside title): `[SKU Master] [Maintenance]`
- Secondary tabs (right, visible when SKU Master): `[Bedframe] [Sofa] [Mattress & Acc] [Others]` + `[Export] [Import] [Reset] [New]`

### Why
We tried splitting into 4 sidebar entries (`Bedframe SKU`, `Sofa SKU`, etc.) — user rejected. Reason:
- **Sidebar fragmentation** makes the left nav bloated
- **User thinks in one task**: "I'm maintaining the SKU master", not "I'm maintaining 4 different lists"
- **Mirrors hookka-erp-vite `/products`** — same mental model

### Consequence
Changing category is 1 click (a tab) rather than a sidebar navigation — faster for users cross-referencing categories.

---

## 2026-04-22 — Font choice (Tahoma, NOT Consolas)

### What
- Body font: `Tahoma, "Segoe UI", Arial, Verdana, sans-serif`
- Mono slot: **same as sans** (NOT Consolas / JetBrains Mono)
- `font-feature-settings: "tnum" 1` globally for tabular numbers

### Why
User's reference systems (AutoCount, Inistate) are Windows desktop apps using Tahoma/Segoe UI. Consolas was the original mono choice but its zero glyph has a dot in the middle (reads as `Ø` at small sizes) — user called it "ugly". Sans-serif tabular numbers from Tahoma are cleaner for money columns.

### Rule
Only two font-weights: **regular (400)** + **semibold (600)**. Converted all `font-bold` → `font-semibold` and `font-medium` → `font-semibold` site-wide.

---

## 2026-04-22 — Cost lookup is live, not stored

### What
`SODetailsPage` + `SalesOrderPage` compute `lineCost` at render time via `costByCode: Map<itemCode, number>` built from `useSKUCostings()`.

### Why
Alternative: store `lineCost` on each SO line. Problem: when user edits a cost in `/sales/sku-costing`, the 1,653 existing SO lines are stale.

Live lookup = **edit cost once, everything updates**. No recompute button, no stale data, no migration.

### Cost
O(n × m) per render where n = lines, m = SKUs. For 1,653 × 1,468 that's 2.4M comparisons — but Map lookup is O(1) so actual cost is 1,653 lookups (sub-millisecond).

---

## 2026-04-22 — Balance dedup per docNo

### What
`getConsolidatedSOs()` takes `docLines[0].balance` instead of `Σ docLines.balance`.

### Why
Excel export stores balance **on every line of an SO** (same value repeated). Summing across lines inflates by line-count (6 lines = 6× balance).

Quick check: SO-011193 had balance 6,000, 10 lines. Wrong code showed 60,000. Balance is an SO-level number, not a line-level one.

---

## 2026-04-22 — Median fill for missing costs

### What
438 SKUs had `costPrice = 0` (bedframe 282, mattress 120, acc 18). Filled with **median of non-zero peers within (itemGroup × size)**.

### Why
User asked to fill them. Options considered:
1. Group average — distorted by outliers
2. Group median — resilient, our choice
3. Size-class median within group — most accurate, our choice
4. Hand-enter — not scalable to 438 items

Python script (`scripts/extract-excel-seed.py`) runs it on next Excel update.

---

## 2026-04-22 — Variant surcharges flow through to cost

### What
When a bedframe/sofa SO line has variants (12" divan, drawers, etc.), the surcharge adds to **both** selling price AND cost:

```
unitCost = SKU.costPrice + Σ variant surcharges
lineCost = unitCost × qty
```

Variants are stored per-SO-line in `SODetailLine.variants` (optional field).

### Why
Previously, variants only affected revenue. Cost stayed at SKU's flat costPrice. That made margin % on every upsell artificially high — user picks 12" divan (+RM 120 sell), we thought it was pure profit, but the factory also pays more for taller divan material.

Rule: **cost tracks sell** when variants are involved. Exact cost delta unknown without separate cost-variant data, so we use the sell-surcharge as a 1:1 proxy (conservative — real cost may be less).

### Ripple effects
- `recomputeLineCost()` now adds `variantSurchargeRM(line)` to unitCost
- `getConsolidatedSOs()` uses the same live calc for category cost rollups
- `SODetailsPage` Line Cost / Margin columns reflect variants automatically
- `NewSalesOrderForm.submit()` stores variant fields on each line so SO Details can read them

### Future
Add separate `costSen` to variant options in `VariantMaintenance` so cost deltas are independently maintained (not tied to sell-surcharge).

---

## 2026-04-22 — SKU → variant binding is by itemGroup

### What
When user picks a SKU in the New SO line:
- `itemGroup === BEDFRAME` → shows Fabrics, Gaps, Divan Heights, Leg Heights, Bedframe Specials
- `itemGroup === SOFA` → shows Fabrics, Sizes, Sofa Leg Heights, Sofa Specials
- `itemGroup === MATTRESS | ACC | BEDLINES` → no variants (just Qty + Unit Price)
- `itemGroup === OTHERS` → no variants

### Why
Different product types have different configurable dimensions. Binding by `itemGroup` means:
- User doesn't choose category — derived automatically from picked SKU
- Variants from `VariantMaintenance` (localStorage `houzs-variants-config`) are the single source
- When API replaces localStorage, swap 3 helpers only:
  - `useSKUCostings()` → `useQuery('/api/skus')`
  - `loadMaintCfg()` → `fetch('/api/variants')`
  - `loadFabrics()` → `fetch('/api/fabrics')`

No UI changes needed because `LineRow` shape + `computeUnitPrice()` are data-shape-agnostic.

---

## Anti-patterns (do NOT)

| Don't | Why |
|---|---|
| Reset user's local data on key bump | Use migration instead |
| Auto-fill unit price from SKU | Our SKUs only have cost, not reliable sell price |
| Let user change Group on a line | Breaks cost lookup + variant fields |
| Force qty to min 1 on every keystroke | User can't delete-and-retype |
| Put sales categories as separate sidebar entries | Fragments nav |
| Sum `line.balance` across an SO | Balance is SO-level, Excel duplicates per line |
| Cache computed costs on lines | Goes stale when SKU cost edits |
| Use Consolas for numbers | Dotted zero looks wrong |
| Mix font-bold / font-medium / font-semibold | Looks inconsistent — stick to 2 weights |
