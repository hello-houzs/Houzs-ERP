# Methodology — Sales Module Rebuild (2026-04-22)

What, why, and how we built today — so future changes follow the same pattern.

---

## 1. Goals

1. **Replace mock data with real Excel exports** — Supplier Price List (costing), Sales Orders header, Sales Order details, FAIR Report
2. **Make costs flow end-to-end** — SKU master (cost) → SO lines (line cost) → SO header (total cost, margin) → venue/project rollup
3. **Mirror AutoCount / Inistate UX** — our users already know those systems; match their visual density, column sets, and field layouts
4. **Split / group pages per user mental model** — one sidebar entry per task, not per data table

---

## 2. Data Pipeline

```
Excel (.xlsx)
   │
   ▼  (scripts/extract-excel-seed.py — openpyxl)
JSON seeds committed to repo
   │  src/data/sku-master.json    (1,468 SKUs)
   │  src/data/so-lines.json      (1,653 line items)
   │  src/data/so-headers.json    (341 headers, enriched with cost rollup)
   ▼
TypeScript stores (src/lib/*-store.ts)
   │  localStorage-backed, versioned keys (`houzs-sku-costings-v4`, etc.)
   │  seed-on-first-read, user edits persist, bump version to ship new seed
   ▼
React pages consume via useSyncExternalStore hooks
```

### Extraction rules

- **Brand inferred from item-code prefix** (`AK-` → AKEMI, `ZNT-` → ZANOTTI, etc.)
- **Size inferred from suffix** (`(K)` = 6FT King, `(Q)` = 5FT Queen, etc.)
- **Balance de-duplicated per docNo** — Excel stores balance on every line of an SO, so we take `lines[0].balance` not `sum()`
- **Gaps filled by group-median** — 438 empty costs (Mattress 120, Bedframe 282, ACC 18) back-filled using median of non-zero peers in the same (itemGroup, size) bucket

### Seed versioning

When seed data changes, **bump the localStorage key** so existing browsers reload fresh:

```ts
const K = "houzs-sku-costings-v4";  // was v3
```

This is the canonical way to ship new seed data without a hard user reset.

---

## 3. Cost Calculation Flow

**Single source of truth**: `SKU Costing.costPrice`. Every downstream computation reads from this via a live `Map<itemCode, number>` built per render:

```ts
// In a page that needs costs:
const skus = useSKUCostings();
const costByCode = useMemo(() => {
  const m = new Map<string, number>();
  for (const s of skus) m.set(s.itemCode, s.costPrice);
  return m;
}, [skus]);
```

Then in cell renderers:

```ts
const cost = costByCode.get(line.itemCode) ?? 0;
const lineCost = cost * line.qty;
const margin = line.total - lineCost;
```

**Why live lookup, not stored**: edit a cost in `/sales/sku-costing` and every SO line updates immediately. No recompute button, no stale data.

### Aggregation hierarchy

| Level | Field | Formula |
|---|---|---|
| Line | `lineCost` | `sku.costPrice × line.qty` |
| Line | `lineMargin` | `line.total − lineCost` |
| SO | `mattressSofaCost` | `Σ lineCost where itemGroup in [MATTRESS, SOFA]` |
| SO | `bedframeCost` | `Σ lineCost where itemGroup = BEDFRAME` |
| SO | `accessoriesCost` | `Σ lineCost where itemGroup in [ACC, BEDLINES]` |
| SO | `othersCost` | `Σ lineCost where itemGroup not in above` |
| SO | `totalCost` | sum of the 4 above |
| SO | `totalMargin` | `totalRevenue − totalCost` |
| SO | `marginPct` | `totalMargin / totalRevenue × 100` |

Computed in `getConsolidatedSOs()` per render. Venue/project rollup in `getVenueRollup()` uses the same pattern.

---

## 4. Page Structure Rules

### One sidebar entry per user task

- ✅ `SKU Costing` — one entry, 4 category tabs + Maintenance tab inside
- ❌ **Don't** create separate `/sales/sku/bedframe`, `/sales/sku/sofa`, etc. sidebar entries — it fragments the user's mental model

### Two-tier tab pattern (mirrors hookka-erp-vite `/products`)

```
┌─ Page Title + [SKU Master | Maintenance] ──── [Cat1 | Cat2 | Cat3 | Cat4]  [Export] [Import] [New] ─┐
│                                                                                                     │
│  (filter bar)                                                                                       │
│  (grid, columns depend on active category)                                                          │
└─────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Primary mode** (view toggle) on the **left** next to title
- **Secondary mode** (category) on the **right** — only visible when primary = "SKU Master"
- Action buttons (Export/Import/Reset/New) rightmost

### Per-category column templates

Each category can have different columns. Don't force one template to serve all:
- **Bedframe**: Product Code · Description · Category · Size · Price 2 · Price 1 · Unit M3 · Variants
- **Sofa**: Product Code · Description · Model · 24"/28"/30"/32"/35" · Unit M3 · Variants
- **Mattress & Acc / Others**: Product Code · Description · Category · UOM · Supplier · Cost RM

The grid header + row render functions switch on `category`:

```tsx
{category === "BEDFRAME" && <BedframeHeader />}
{visible.map(sku =>
  category === "BEDFRAME" ? <BedframeRow sku={sku} /> :
  category === "SOFA"     ? <SofaRow     sku={sku} /> :
                            <PlainRow    sku={sku} />
)}
```

---

## 5. Visual System

### Font stack — AutoCount / Windows desktop

```css
--font-sans: Tahoma, "Segoe UI", Arial, Verdana, sans-serif;
/* intentionally NOT Consolas for mono — its dotted 0 looks wrong */
--font-mono: Tahoma, "Segoe UI", Arial, sans-serif;

body {
  font-feature-settings: "tnum" 1, "lnum" 1;  /* tabular lining numerals */
}
table, .tabular-nums, input[type="number"] {
  font-variant-numeric: tabular-nums lining-nums;
}
```

### Two weights only

Normalize `font-bold` → `font-semibold` and `font-medium` → `font-semibold`. Result: every page uses only **regular (400)** or **semibold (600)**. More weights = less consistent.

### Density guidelines

- **Compact AutoCount grid** (Sales Orders, SKU Costing): `text-[11–12px]`, thin grid lines between every cell, alternating zebra rows
- **Spacious form** (SO Details, New SO modal): `text-[12–13px]`, no grid lines, pill chips for group/payment/branding
- **Never wrap** in table cells — `whitespace-nowrap` + `overflow-hidden text-ellipsis`

### Inistate form style (for SO New / Edit)

Row = label (right-aligned, small gray, with trailing icon) + borderless input. Underline on focus only.

```tsx
<Row label="Order Date" icon={<CalIcon className="h-3 w-3" />}>
  <Inp type="date" value={...} onChange={...} />
</Row>
```

No section headers, no card backgrounds — flat two-column grid. Right column usually short (Salesperson, Debtor Code, Payment, Note).

---

## 6. Component Patterns

### Column preferences

All grids use `useColumnPrefs(key, defaultOrder, defaultHidden)` — user can show/hide columns and reorder via drag-handle; state persists to localStorage under per-page keys.

### Portal for overflow-bounded popovers

The filter dropdown on Sales Orders lives inside an `overflow-auto` table container. `position: absolute` gets clipped. Fix:

```tsx
{open && pos && createPortal(
  <div style={{ position: "fixed", top: pos.top, left: pos.left, ... }}>
    ...
  </div>,
  document.body,
)}
```

Compute `pos` from `btnRef.current.getBoundingClientRect()` on open; listen for `resize` and capture-phase `scroll` to keep it anchored.

### Inline cell editing

For fields that should be quick to edit (cost, sell price):

```tsx
<CellEditor value={sku.costPrice} onSave={(v) =>
  updateSKU(sku.id, { costPrice: v, lastUpdated: new Date().toISOString() })
} />
```

Click cell → becomes input → Enter/blur commits → localStorage persists → all consumers re-render via subscriber pattern.

---

## 7. New SO Modal (Inistate-style)

Structure:

```
┌─ [Customer Name] · Sales Order · [STATUS chip]                              [×]
│  SO-011501 · External · just now
├─────────────────────────────────────────────────────────────────────────────
│ LEFT COL                              │ RIGHT COL
│ Order Date    📅  [21/04/2026]       │ Salesperson 👤 [KINGSLEY]
│ Processing    📅  [21/04/2026]       │ Branding    🏷 [AKEMI]
│ Delivery      📅  [...]               │ Debtor Code #  [300-C001]
│ Status        🏷  [...]               │ PO Doc No.  📄 [...]
│ Status 2      🏷  [MATTRESS/ACC]     │ Payment     $  [Unchecked]
│ Name          👤  [...]               │ Note        📄 [...]
│ Address 1/2   📍  [...]
│ Postcode / State #/📍
│ Contact 1/2   📞  [...]
│ Email         ✉  [...]
│ Venue/Warehouse/Reference/Source
├─────────────────────────────────────────────────────────────────────────────
│ Items 📦                                                   [+ Add Line]
│ # │ Item (SKU dropdown) │ Remarks │ Qty │ Unit Price │ Amount │ Group │ 🗑
│ Remarks   [...]
│ Total     $  10,200.00
├─────────────────────────────────────────────────────────────────────────────
│ Payments $                                                [+ Add Payment]
│ Date │ Method │ Amount │ Account Sheet │ Approval Code │ Collected By │ 🗑
│                           Deposit Paid $  5,800.00
│                           Balance       $  4,400.00
├─────────────────────────────────────────────────────────────────────────────
│ [N line(s) · Total · Paid · Balance]     [Update Details] [Cancel] [Sales Order]
└─────────────────────────────────────────────────────────────────────────────
```

Key rules:
- **SKU typeahead**: `<datalist>` of 1,500 SKUs → on select, auto-fill description, UOM, itemGroup from the master
- **Amount auto-calculated** from `qty × unitPrice`
- **Balance auto-calculated** from `total − Σ payments`
- **Doc No auto-generated** via `nextSODocNo()` (highest existing + 1)
- **Payment status auto-derived**: `Checked` if fully paid, `Pending` if partial, else whatever user picked

On submit → `addSOHeader(...)` + loop `addSOLine(...)` for each valid line → modal closes → page re-renders with new SO at top.

---

## 8. Deployment

- **Repo**: `github.com/hello-houzs/Houzs-ERP` branch `vite-migration`
- **Hosting**: Cloudflare Pages auto-deploys on push → `houzs-erp-4r4.pages.dev`
- **Dev**: `npm run dev` (port 3200) · reference app on 3000 (hookka-erp-vite)
- **Browser state**: `localStorage.clear()` to reset all seeded data; the versioned keys (`v4`) force fresh seed load on deploy

---

## 9. What NOT to Do (lessons learned)

| Don't | Why |
|---|---|
| Use multiple font weights (bold/medium/semibold mixed) | Looks inconsistent. Stick to 400 + 600. |
| Use `font-mono: Consolas` | Zero has a center dot → reads as "Ø" |
| Store computed costs in the line | Stale when SKU cost changes. Compute at render time. |
| Sum `line.balance` across lines | Excel duplicates balance per line — you over-count |
| `absolute` popovers inside `overflow-auto` | Gets clipped. Use portal + `fixed`. |
| Create 4 sidebar entries for 4 categories | Fragments nav. Use tabs inside one entry. |
| Pre-compute per-category revenue from header | Excel doesn't fill those columns reliably. Compute from lines. |

---

## 10. File Map

```
src/
├── data/                          Seed JSON (sku-master, so-lines, so-headers)
├── lib/
│   ├── so-store.ts                SO lines + headers + consolidation + cost calc
│   └── sku-costing-store.ts       SKU master + getCostByItemCode
├── components/
│   ├── NewSalesOrderForm.tsx      Inistate-style New SO modal
│   └── VariantMaintenance.tsx     Divan heights, legs, gaps, fabrics
├── pages/
│   ├── SalesOrderPage.tsx         /sales/orders — consolidated list + expand
│   ├── SODetailsPage.tsx          /sales/details — line-item grid
│   └── SKUCostingPage.tsx         /sales/sku-costing — 2-tier tabs
└── index.css                      Font stack + tabular-nums globals

scripts/
└── extract-excel-seed.py          Excel → JSON seed generator
```

---

## 11. Running extraction again

If the user updates any of the three Excel files:

```bash
cd C:/Users/User/Desktop/houzs-erp
python scripts/extract-excel-seed.py
# Updates src/data/*.json in place
# Bump localStorage key in stores if data shape changed
```

That's it. Rest flows through the same pipeline.
