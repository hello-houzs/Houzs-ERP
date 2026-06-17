# Houzs ← 2990s SCM — 1:1 Clone Program

> Durable spec for the multi-week clone. Read this first every session; it is
> the brain that survives context compaction. Update the **Status log** at the
> bottom as slices land.

## Decision (2026-06-17, owner)

Clone 2990s's **Supply Chain super-module 1:1 (frontend + backend, "直接 copy
paste")** into Houzs, and eventually **delete the AutoCount core**. The earlier
adapted/trimmed SCM (the `scm_*` island) was rejected and is being removed.

**Strategy 2 — locked by owner:** Houzs is **NOT** the same furniture business as
2990s (different products / not pure furniture). So:

- **Clone VERBATIM:** the SCM *document-flow* tables, routes, business logic, and
  pages — Suppliers, PO, GRN, Purchase Invoice/Return, Inventory/FIFO, Warehouse,
  Transfers, Stock Take, MRP, Sales Order/DO/SI/Delivery Return, Consignment.
- **Do NOT clone:** the furniture engine — sofa/bedframe/mattress configurators,
  Sofa Combo pricing, fabric-tier surcharges, PWP, `mfg-pricing`/`sofa-*` shared
  packages, the Products catalog *pricing editor*. These are dead weight for Houzs.
- **Product layer → Houzs's own data.** 2990s couples SCM to its catalog by **TEXT
  `material_code` + `material_kind`, NOT hard FKs** (verified: `material_code:
  text(...)`). So Houzs just puts its own product/stock codes there; the furniture-
  only `price_matrix` jsonb stays nullable/empty. This makes Strategy 2 light.

**Excluded entirely:** TRANSPORTATION group ("transportation 不需要" — keep Houzs's
existing Logistics/trips).

## Repos & the DB seam (the good news)

| | Source — 2990s | Target — Houzs |
|---|---|---|
| Path | `C:\Users\User\Desktop\2990s` (READ-ONLY, shared live tree — never write) | `C:\Users\User\Desktop\Houzs-ERP-cutover` |
| Monorepo | pnpm + turbo; `apps/api` (Hono), `apps/backend` (React admin SPA), `apps/pos`, `packages/{db,shared,design-system}` | npm; `backend/` (Hono), `frontend/` (React SPA), out-of-tree `shared/` |
| ORM/DB | Drizzle + **Postgres (pg-core)**, `postgres-js`, `casing:'snake_case'` | Drizzle + **Postgres (pg-core)** via Hyperdrive, `getDb(env)` |
| Schema | `packages/db/src/schema.ts` (~87 tables / 27 enums, source of truth) | `backend/src/db/schema.pg.ts` (re-exported by `schema.ts`) |

**Both sides are pg-core Drizzle on Postgres** → table defs, column types, and
`pgEnum`s transfer almost verbatim (no dialect translation). This is what makes a
real 1:1 feasible.

Branch: **`scm-clone-2990s`**. Staging-first, then prod. Staging Supabase
`minnapsemfzjmtvnnvdd` / Hyperdrive `b776100058d04d609bb6e19182263683`.

## Canonical adaptation rules (the only allowed deviations from verbatim)

Apply these *consistently* at every seam so ported routes/pages compile unchanged:

1. **Table names:** use 2990s's names verbatim (`suppliers`, `purchase_orders`,
   `grns`, ...). NOT the rejected `scm_` prefix.
2. **Drizzle style:** copy 2990s's table defs verbatim — **camelCase property keys
   + explicit snake_case column strings + `pgEnum`s** (e.g. `whatsappNumber:
   text('whatsapp_number')`). Ported routes reference `.whatsappNumber`, so keep the
   keys. Houzs's existing tables use snake_case keys; mixed conventions per-table is
   fine in Drizzle. Columns are explicitly named so `getDb` (no `casing` option)
   still emits correct SQL.
3. **DB client:** `import { getDb } from "../db/client"` then `const db =
   getDb(c.env)`. (2990s uses a per-request `createClient(databaseUrl)`.)
4. **Auth/RBAC:** 2990s verifies a Supabase JWT (`middleware/auth.ts`) + RLS role
   helpers + `staff` table. Houzs uses Bearer token + `requirePermission(...)` +
   `users` table. **Map `staff` → Houzs `users`; `created_by` = users.id (integer).**
   Gate SCM routes with Houzs's permission middleware (start Owner-only `"*"`, then
   add real permission keys in the Auth/seam phase).
5. **Money:** keep 2990s's `*_centi` integer columns verbatim. (Houzs's AutoCount
   money is mixed; the cloned SCM stays centi-internal.)
6. **Frontend styling:** bring the **`.module.css` files VERBATIM** alongside each
   page (Vite supports CSS Modules out of the box — most faithful, least work). Do
   NOT rewrite to Tailwind. Pull 2990s `packages/design-system` tokens as needed.
7. **Frontend data:** 2990s uses TanStack Query + a typed api client. Houzs has
   TanStack under its `useQuery` hook + `frontend/src/api/client.ts` (reads
   `VITE_API_URL`). Re-point ported pages at Houzs's client; keep query shapes.
8. **Shared Zod:** 2990s schemas live in `packages/shared/src/schemas`. Houzs uses
   out-of-tree `shared/` via `@shared/*` alias. Port the SCM Zod schemas into
   `shared/` and **alias `zod` in all 4 toolchains** (tsconfig paths ×2, vite
   resolve.alias, wrangler `[alias]`, vitest resolve.alias) — the out-of-tree bare
   `import {z} from "zod"` broke CI 2× before; this is mandatory.
9. **Imports:** 2990s `@2990s/db|shared|design-system` and `@/...` → Houzs relative
   / `@shared/*` equivalents.

## Collision map (Houzs already has these)

- **`purchase_orders`** (Houzs AutoCount, schema.pg.ts:398) ⟂ 2990s `purchase_orders`.
- **`warehouses`** (Houzs AutoCount, :279) ⟂ 2990s `warehouses` (richer, + racks).
- **`creditors`** (Houzs AutoCount suppliers, :421) ↔ 2990s `suppliers` (different
  name, conceptual overlap).
- **`sales_orders`** (Houzs AutoCount, :330, ~2695 live rows) ↔ 2990s
  `mfg_sales_orders` (different name). Referenced by Logistics(trips)/ASSR/Projects.
- **`order_details`**, **`purchase_order_docs`** — AutoCount SO/PO children.
- These AutoCount tables are removed only at the **gated cutover** (task #71), never
  on the branch casually. On the branch, 2990s tables are added under their own
  names and coexist until cutover.
- The rejected **`scm_*` island** (schema.pg.ts:905–1307) is dead/unreferenced and
  is dropped by migration `0023` + removed from schema.pg.ts (Phase 0).

## Phase order → tracked tasks

Vertical slices (each = schema + migration + route + page(s) + wiring + **staging
e2e test**), mirroring the owner's own proven sequencing. Task IDs in the tracker:

| # | Slice | Task |
|---|---|---|
| 0 | Drop `scm_*` island + establish canonical pattern | #56 |
| 1 | Suppliers + material bindings | #57 |
| 2 | Products & Maintenance (→ Houzs product layer) | #58 |
| 3 | Purchase Orders | #59 |
| 4 | Goods Receipt + inventory-in | #60 |
| 5 | Purchase Invoices + Purchase Returns | #61 |
| 6 | Warehouse + Inventory (FIFO/moves/valuation) | #62 |
| 7 | Stock Transfers + Stock Takes | #63 |
| 8 | MRP · Stock Status | #64 |
| 9 | Sales Orders + SO Detail | #65 |
| 10 | Delivery Orders + Sales Invoices + Delivery Returns | #66 |
| 11 | Consignment (sales + purchase) | #67 |
| 12 | Auth/seam integration + wiring all modules | #68 |
| 13 | Rewire Logistics/ASSR/Projects → new SO model | #69 |
| 14 | Staging end-to-end acceptance | #70 |
| 15 | **(GATED)** Prod cutover — delete AutoCount + data migration | #71 |

Dependency: 1→3→4→5 (procurement chain); 6 underpins 4/7/9/10; 9→10→11; 12 after
modules exist; 13 before 15; 15 needs owner sign-off + written data plan.

## Source file locations (2990s)

- Backend routes: `apps/api/src/routes/*.ts` — suppliers, products, product-models,
  maintenance-config, categories, mrp-lead-times, purchase-orders (verify name),
  grns, purchase-invoices, purchase-returns, inventory, warehouse, stock-takes,
  stock-transfers, state-warehouse-mappings, mfg-sales-orders (verify), scan-so,
  so-dropdown-options, so-settings, delivery-orders-mfg, sales-invoices,
  delivery-returns, consignment-notes, consignment-returns, purchase-consignment-*,
  outstanding, document-flow, accounting (AP/AR posting — port the SCM-relevant bits).
- Backend logic: `apps/api/src/lib/*.ts` — po, po-pricing (strip furniture),
  recost, inventory-movements, grn-rack-sync, check-stock-availability,
  so-delivery-sync, so-readiness, so-stock-allocation, so-audit, current-doc,
  doc-no, my-time, postgrest-search. Port per-slice as imported.
- Frontend pages: `apps/backend/src/pages/*.tsx` (+ `.module.css`) — Suppliers,
  SupplierDetail, Products/ProductModels, Mrp, PurchaseOrders, PurchaseOrderFromSo,
  GrnFromPo/GrnNew/GoodsReceivedList, PurchaseInvoice*/PurchaseInvoicesList,
  PurchaseReturnsList, Inventory/StockCard/StockAdjustments/Warehouses,
  StockTransfers/StockTakes, MfgSalesOrdersList/SalesOrderDetail*/sales-order/*,
  Mfg* DO/SI/DR lists+details + *FromSo/*FromDo, Consignment*/PurchaseConsignment*.
- Schema: `packages/db/src/schema.ts`. SCM table line map (approx): suppliers 860,
  supplier_material_bindings 911, purchase_orders 948, purchase_order_items 979,
  grns 1057, grn_items 1083, purchase_invoices 1129, purchase_returns 1778,
  warehouses 2348, inventory_movements 2424, inventory_lots 2456, stock_transfers
  2488, stock_takes 2529, mfg_sales_orders 1210, delivery_orders 1575, sales_invoices
  1647, delivery_returns 1725. **Re-glob/grep per slice — the route list truncates.**

## Migration conventions (Houzs)

- Dir `backend/src/db/migrations-pg/`, name-sorted, applied once, tracked in
  `_pg_migrations`. Next free number after 0023 = **0024**.
- Runner `backend/scripts/pg-migrate.mjs`: **splits on `;\n`**, strips `--` comment
  lines, runs each statement via `tx.unsafe` inside ONE transaction. So: each
  statement ends with `;` on its own line; **no `BEGIN/COMMIT`** (runner wraps);
  must be **idempotent** (`IF NOT EXISTS` / `ON CONFLICT` / `IF EXISTS`).
- Hand-written `.sql`, immutable after deploy. Schema source of truth = schema.pg.ts.
- `deploy.yml` runs `pg-migrate.mjs` against **PROD** on push to `main` — so a merge
  applies all pending migrations to prod. Keep them safe on prod data.

## Cutover gating (task #71) — non-negotiable

Deleting AutoCount drops ~2695 live sales_orders + delivery/PO/creditors/warehouses
and breaks Logistics/ASSR/Projects FKs. This happens **only** after: (a) all modules
cloned + rewired (task #69), (b) a written data-migration plan, (c) explicit owner
sign-off. Never on the branch casually; never blindly. Prefer reversible steps.

## Proven pattern + findings (Suppliers slice, 2026-06-17)

**MAJOR FINDING — 2990s routes use the Supabase PostgREST query builder, NOT
Drizzle queries.** (`supabase.from().select().eq().or()`...). Houzs has no
Supabase-JS client — it is Drizzle-over-Hyperdrive. So **every route port is a
faithful PostgREST→Drizzle TRANSLATION**, not a copy: keep endpoints, request
bodies, response JSON shapes, status codes, and business rules identical; rewrite
only the query mechanism. Drizzle returns camelCase rows, so add
`toXResponse()` mappers to emit the snake_case wire shape the 2990s frontend
expects. (Schema/migrations DO transfer near-verbatim; only the runtime queries
need translation.)

**Per-slice verification gates (both must be EXIT 0 before a slice is "done"):**
- Backend: `npm --prefix backend run typecheck` (`tsc --noEmit`).
- Frontend: `npm --prefix frontend run build` (`tsc -b` + vite).
- **Staging e2e is BATCHED at task #70**, not run per-slice (deploying 16× is
  wasteful). "Slice done" = code-complete + both gates green + reviewed. Live
  staging acceptance happens once, at the end, under #70.

**Import-rewrite map (reuse every slice):**
| 2990s | Houzs |
|---|---|
| `@2990s/db` tables/enums | `../db/schema` (re-exports `schema.pg.ts`) |
| per-request `createClient(url)` / `c.get('supabase')` | `import { getDb } from "../db/client"` → `getDb(c.env)` |
| PostgREST `.from().select().eq().or().order()` | Drizzle `db.select().from().where(and/or/eq/ilike).orderBy(asc/desc)` |
| Supabase JWT/RLS middleware | `import { requirePermission } from "../middleware/auth"` → `app.use("*", requirePermission("*"))` |
| `lib/postgrest-search` `escapeForOr` | inline (small) |
| `import type { Env, Variables } from '../env'` | `import type { Env } from "../types"` (no `Variables`) |
| `export const x = new Hono(...)` | `const app = new Hono<{ Bindings: Env }>(); export default app;` |
| FE `lib/*-queries` `authedFetch` | `../api/client` `api.{get,post,patch,del}` + `@tanstack/react-query` |
| `@2990s/design-system` `Button` (has `size`) | `../components/Button` (variant only) |
| 2990s `DataGrid` | plain `<table>` + the verbatim `.module.css` `.table*` classes |
| `react-router` | `react-router-dom` (same hooks) |
| furniture libs (mfg-products, product-models, SofaComboTab, FabricTracking, MoneyInput, PhoneInput, localities) | drop / replace with plain text inputs (Strategy-2 product layer) |
| `./X.module.css` | identical — copy verbatim (Vite supports CSS Modules) |

## Collisions / decisions for UPCOMING slices

- **`warehouses`** — Houzs AutoCount `warehouses` (schema.pg.ts:279) collides with
  2990s `warehouses`. Since the owner re-enters data and AutoCount is deleted at
  cutover, the end state is 2990s's warehouses. Resolve in the Warehouse slice.
  Until then, cross-slice warehouse refs (PO `purchaseLocationId`, GRN/inventory
  `warehouse_code`) use **nullable SOFT refs (no FK)**; tighten when warehouses lands.
- **`/po` + `PurchaseOrders.tsx`** — Houzs ALREADY has an AutoCount PO page at
  `/po`. Mount the 2990s PO clone at a DISTINCT route (e.g. `/purchase-orders`) so
  both coexist until cutover; don't overwrite the existing page.
- **Cross-slice refs to not-yet-cloned tables** (warehouses, mfg_sales_orders via
  PO `soItemId`) → nullable soft refs initially; this is a documented sequencing
  deviation from 2990s's hard FKs (behaviourally identical; tighten later).

## Status log

- **2026-06-17:** Program defined. Strategy 2 locked. 16 tasks (#56–71) tracked.
- **2026-06-17 — Phase 0 DONE (#56):** `scm_*` island removed from schema.pg.ts +
  migration `0023` drops the physical tables; backend typecheck green.
- **2026-06-17 — Suppliers slice DONE (#57):** verbatim clone of 2990s
  suppliers + supplier_material_bindings (migration `0024`, real pgEnums) + route
  (PostgREST→Drizzle) + Suppliers/SupplierDetail pages (CSS Modules verbatim) +
  wiring (App.tsx `/suppliers`, Sidebar "Supply Chain" group). Backend typecheck
  AND frontend build both EXIT 0. Owner re-enters data → no migration of vendor
  data. Material bindings use TEXT codes (plain-text inputs; product picker
  deferred to Products slice). Scorecard is a zero-shape stub until PO/GRN land.
  Migration `0024` NOT yet applied to any DB (batched for staging at #70).
- **2026-06-17 — PO slice DONE (#59):** verbatim clone → tables
  `mfg_purchase_orders`/`_items`/`_lines` (AutoCount owns bare `purchase_orders`),
  `po_status` enum, route at `/api/purchase-orders`, pages in `pages/scm/`, nav
  under Supply Chain. Furniture pricing dropped (line = qty×unit−disc); variant
  columns kept in schema. From-SO + GRN-downstream stubbed (TODO when those land).
  `created_by` = `users.id` from auth (`c.get("user")`). Both gates EXIT 0.
- **NAMING CONVENTION (decided):** when a 2990s table name collides with a live
  AutoCount table, the clone takes a distinct physical name reusing 2990s's `mfg_`
  vocabulary — `purchase_orders`→`mfg_purchase_orders`, `warehouses`→`mfg_warehouses`.
  The Drizzle export key stays 2990s's camelCase key (route code verbatim) UNLESS
  that identifier already exists in schema.pg.ts — a single-word name like
  `warehouses` is identical in snake/camel and AutoCount already exports it, so the
  export key ALSO takes the prefix (`mfgWarehouses`), imported in routes as
  `mfgWarehouses as warehousesTable` so handler bodies stay verbatim. (`purchaseOrders`
  camel ≠ AutoCount's `purchase_orders` snake, so PO kept the bare camel key.)
  Rename to the bare name at cutover (#71). Non-colliding tables (grns, purchase_invoices,
  inventory_*, stock_*, mfg_sales_orders, delivery_orders — Houzs has none of these)
  use bare names.
- **SLICE REORDER:** Inventory/Warehouse (#62) moves BEFORE GRN (#60): GRN / purchase-
  return / transfer / stocktake POSTs all write into the inventory ledger, so the
  ledger + `inventory-movements` lib must exist first. Order now: Suppliers ✓ → PO ✓
  → **Inventory/Warehouse (#62)** → GRN (#60) → PI/PR (#61) → Transfers/Stocktake
  (#63) → Products (#58) → MRP (#64) → SO (#65) → DO/SI/DR (#66) → Consignment (#67).
- **2026-06-17 — Inventory + Warehouse DONE (#62):** migration `0026` (11 tables:
  `mfg_warehouses` + inventory_movements/lots/lot_consumptions + stock_transfers/
  _lines + stock_takes/_lines + warehouse_racks/_items/_movements; `inventory_movement_type`
  enum; 3 single-line plpgsql FIFO fns + `trg_inventory_movement_fifo` trigger + 4
  product-free views; KL/PJ seed). Routes `/api/inventory` + `/api/mfg-warehouses`;
  lib `inventory-movements.ts`; pages in `pages/scm/`. Catalogue-coupled views
  (`v_inventory_all_skus`, `v_inventory_product_totals` — CROSS JOIN mfg_products)
  NOT created → `/inventory?showAll` + `/inventory/products` return empty until
  Products slice. Both gates EXIT 0.
  - **`inventory-movements` lib API (GRN/PR/transfer/stocktake call this):**
    `writeMovements(db, rows: MovementInput[])` (fires the DB FIFO trigger — lots/
    consumptions/COGS auto-maintained; never touch lots directly),
    `reverseMovements(db, sourceDocType, sourceDocId, performedBy)`,
    `defaultWarehouseId(db)`, `resolveWarehouseLotBatches(db, whId)`,
    `resolveWarehouseLotCosts(db, whId)`. `MovementInput` = `{ movement_type
    'IN'|'OUT'|'ADJUSTMENT'; warehouse_id; product_code; variant_key?; product_name?;
    qty; unit_cost_sen?; source_doc_type 'GRN'|'DO'|'DR'|'PURCHASE_RETURN'|...;
    source_doc_id?; source_doc_no?; batch_no?; reason_code?; performed_by?: number }`.
- **2026-06-18 — GRN slice DONE (#60):** verbatim clone → tables `grns`+`grn_items`
  (BARE names, no AutoCount collision), `grn_status` enum (POSTED/CLOSED/CANCELLED),
  migration `0027_grns.sql`, route at `/api/grns`, lib `grn-rack-sync.ts`, pages
  GoodsReceivedList/GrnNew/GrnFromPo/GoodsReceivedDetail + `grn-queries.ts` in
  `pages/scm/`, routes in App.tsx (`/grns`, `/grns/new`, `/grns/from-po`, `/grns/:id`),
  nav "Goods Received" under Supply Chain. GRN POST flow wired faithfully: (a)
  `writeMovements(db, ... source_doc_type:'GRN', batch_no=source PO no)` for IN; (b)+(c)
  `recomputePoReceived` recounts `mfg_purchase_order_items.received_qty` + re-evaluates
  parent PO status (SUBMITTED→PARTIALLY_RECEIVED→RECEIVED); (d) `placeGrnLinesOnRacks`.
  Cancel reverses (OUT + rack reversal + PO recount). All over-receipt guards +
  child-lock + downstream-consumption guard + line-edit inventory deltas + warehouse
  relocation ported. Both gates EXIT 0.
  - **PO route un-stubbed:** `poHasDownstream` (PO locks once it has a non-cancelled
    GRN), list+detail `has_children`, per-line `receipts` (poLineReceipts), and
    `/:id/linked` `grns` now query the real grns/grn_items. SO stubs
    (recomputeSoPicked, so_drift, so_doc_no) kept stubbed (SO slice pending).
  - **SEAM/deviations (documented in files):** `grns.purchase_order_id` made NULLABLE
    (2990s declares NOT NULL but the route inserts null for manual GRNs — schema/route
    mismatch in 2990s); `warehouse_id`→real FK to `mfg_warehouses`; `created_by`→int
    soft-ref (users.id); dropped furniture engine (buildVariantSummary, recostFromGrn,
    mfg_products/maintenance-config variant editors, per-line rack picker UX) +
    so-stock-allocation (SO slice) per Strategy-2; rack-sync idempotency keyed on
    `source_doc_no` (= GRN no) since warehouse_rack_items has no source_grn_id column
    in 2990s's schema.ts. Convert-to-PI/PR actions dropped (PI/PR slices pending).
  - Migration `0027` NOT applied to any DB (batched for staging at #70).
- **2026-06-18 — PI + PR slice DONE (#61):** verbatim clone → tables
  `purchase_invoices`+`purchase_invoice_items` (`purchase_invoice_status` enum
  POSTED/PARTIALLY_PAID/PAID/CANCELLED) + `purchase_returns`+`purchase_return_items`
  (`purchase_return_status` enum POSTED/COMPLETED/CANCELLED), all BARE names (no
  AutoCount collision); migration `0028_purchase_billing.sql`; routes at
  `/api/purchase-invoices` + `/api/purchase-returns`; query hooks `flow-queries.ts`;
  pages PurchaseInvoicesList/New/FromGrn/Detail + PurchaseReturnsList/New/Detail in
  `pages/scm/`; App.tsx routes (`/purchase-invoices[/new|/from-grn|/:id]`,
  `/purchase-returns[/new|/:id]`, all `<Guard perm="*">`); nav "Purchase Invoices"
  (Receipt) + "Purchase Returns" (Undo2) under Supply Chain. Both gates EXIT 0.
  - **PI = FINANCE record, NO stock impact** (inventory landed at GRN time). POST
    creates POSTED; payment endpoint moves UNPAID→PARTIALLY_PAID→PAID
    (`paid_centi` vs `total_centi`); cancel releases. On every PI write path
    `recomputeGrnInvoiced` recounts `grn_items.invoiced_qty` from live PI lines
    (per-GRN-line cap = accepted − invoiced − returned, + post-insert race verify).
    From-GRN convert paths (`/from-grn`, `/from-grn-items`) + manual create ported.
  - **PR = return-to-supplier, OUTBOUND stock.** On post `writePurchaseReturnMovements`
    writes inventory **OUT** via `writeMovements(db, ... movement_type:'OUT',
    source_doc_type:'PURCHASE_RETURN', source_doc_id=PR id, qty=qty_returned,
    batch_no=source GRN's dye-lot)`, per-line warehouse-resolved (source GRN line's
    warehouse → primary GRN → default); then `adjustGrnReturnedQty` recounts
    `grn_items.returned_qty` from live PR lines + calls `recomputePoReceived(db,
    [poItemId])` (net received drops → PO re-opens). Line CRUD writes compensating
    delta movements (`writePrLineDeltaMovement`: add/+qty → OUT, reduce/delete → IN
    at the OUT's stamped cost/batch). **Cancel reverses via `reverseMovements(db,
    'PURCHASE_RETURN', id, userId)`** (signed-net-per-bucket IN) + releases
    returned_qty. Complete (with CN ref) POSTED→COMPLETED. From-GRN converts
    (`/from-grns` rejected-qty batch, `/from-grn` whole-GRN) ported.
  - **PO route un-stubbed:** `/:id/linked` `invoices`/`returns` now query the real
    `purchase_invoices`/`purchase_returns` tied to the PO (were `[]` after GRN slice).
  - **GRN route un-stubbed:** detail `/:id` per-line `downstream` PI/PR breakdown
    (new `grnLineDownstream` Drizzle helper, cancelled docs excluded) + `/:id/linked`
    `invoices`/`returns` now query real tables (were `[]`). `grnHasDownstream`
    child-lock already READ invoiced/returned qty — now those counters are actually
    WRITTEN by the PI/PR routes, so GRN edit-lock fully engages.
  - **GL/accounting OUT OF SCOPE (Houzs GL differs):** 2990s's AP→GL posting
    (`reversePiAccounting`/`resyncPiAccounting` on PI, AP post on PR) is DROPPED with
    a `// TODO: AP→GL posting is out of SCM clone scope` at each site; the PI/PR docs
    + payment-status stay fully functional. The 2990s Costing-B re-cost chain
    (`recostForPi`/`recostFromGrn` → DO/SI margin) is NOT cloned (SO/DO/SI slices
    pending) → dropped with `// TODO`. SO-allocation re-walk
    (`recomputeSoStockAllocation`, fired by 2990s after a PR moves stock) likewise
    `// TODO` (SO slice pending).
  - **SEAM/deviations (documented in files):** `created_by`→int soft-ref (users.id);
    `purchase_order_id`→real FK to `mfg_purchase_orders` (nullable, as 2990s);
    `grn_id`/`grn_item_id`/`supplier_id`→real FKs; dropped `buildVariantSummary`
    (description2 passes the client value through; variant columns persisted for
    fidelity); New pages use plain-text manual lines (no furniture variant editor /
    mfg-products / supplier-binding lookup / auto-due-date) per Strategy-2. `sql`
    import unused → removed from PR route; unused `navigate` removed from detail pages.
  - Migration `0028` NOT applied to any DB (batched for staging at #70).
- **2026-06-18 — Stock Transfers + Stock Takes slice DONE (#63):** verbatim clone
  of 2990s `stock-transfers.ts` + `stock-takes.ts` (PostgREST→Drizzle). Routes at
  `/api/stock-transfers` + `/api/stock-takes` (mounted in index.ts, owner-only
  perm `"*"`); pages StockTransfers/New/Detail + StockTakes/New/Detail in
  `pages/scm/` + query hooks `stock-transfers-queries.ts` + `stock-takes-queries.ts`;
  App.tsx routes (`/stock-transfers[/new|/:id]`, `/stock-takes[/new|/:id]`, all
  `<Guard perm="*">`, static `/new` before `/:id`); nav "Stock Transfers"
  (ArrowLeftRight) + "Stock Takes" (ClipboardList) under Supply Chain. List pages
  use plain `<table>` + `Inventory.module.css` verbatim (StockAdjustments pattern,
  2990s DataGrid dropped); New/Detail pages use a slice-local `StockDoc.module.css`
  reproducing 2990s's `SalesOrderDetail.module.css` look (SO slice not cloned).
  **NO migration needed** — `0026` already created `stock_transfers`/`_lines` +
  `stock_takes`/`_lines` with columns IDENTICAL to 2990s's schema.ts (verified
  field-by-field); the only diffs are the already-applied seams (`created_by`
  integer, FKs→`mfg_warehouses`, `variance` generated). Both gates EXIT 0.
  - **Transfer→inventory wiring (faithful):** POST creates POSTED + inline writes,
    per line: (1) direct `db.insert(inventoryMovements)` of an **OUT@from**
    (`source_doc_type:'STOCK_TRANSFER'`, source dye-lot stamped via the lib's
    `resolveWarehouseLotBatches` when the source bucket sits in ONE batch), then
    **RE-QUERY** that row's `total_cost_sen` (the FIFO trigger stamps cost via a
    separate UPDATE that INSERT…RETURNING can't see — the 2990s C-1 fix), then
    (2) `writeMovements(db, [IN@to])` with `unit_cost_sen = OUT.total/OUT.qty` so
    the destination lot opens at the consumed basis (+ mirrored batch_no). Cancel
    (POSTED→CANCELLED, gated, idempotent) → `reverseMovements(db,'STOCK_TRANSFER',
    id,userId)` (signed-net-per-bucket reversal). `/post` = legacy no-op.
  - **Stocktake→inventory wiring (faithful):** create snapshots `system_qty` per
    in-scope SKU then inserts OPEN lines (counted_qty NULL); `/lines` bulk-updates
    counted_qty (OPEN only); **`/post`** (OPEN→POSTED, gated) writes ONE
    `movement_type:'ADJUSTMENT'` of the SIGNED `(counted−system)` variance per
    non-zero line via `writeMovements(db, …, source_doc_type:'STOCK_TAKE',
    reason_code:'COUNT')` so the ledger reconciles to the counted figure; `/reverse`
    (POSTED→CANCELLED, gated) writes the opposite-signed ADJUSTMENT per forward
    movement; `/cancel` (OPEN) + `/delete` (OPEN) terminal. SO-allocation re-walk
    is a no-op stub (SO slice pending), call sites kept.
  - **SEAM/deviations (documented in files):** `created_by`→int (users.id from
    `c.get("user")`); from/to warehouses must differ (CHECK already exists).
    **Stocktake snapshot source SWAPPED** — 2990s reads `v_inventory_all_skus`
    (CROSS JOIN mfg_products, NOT created in Houzs) → Houzs snapshots from
    `inventory_balances` (movement rollup, product-free, exists): ALL =
    every product_code with a balance row at the wh; CODE_PREFIX = filtered by
    `product_code ILIKE prefix%`; **CATEGORY = zero rows** (no category column in
    Houzs balances → server returns `scope_empty`; kept in the UI dropdown for
    fidelity, preview shows 0, TODO when a product layer + categories land).
    StockTakeNew preview reads `inventory_balances` (showAll=false) — the SAME
    source the server snapshots from — so ALL/CODE_PREFIX previews are honest.
    Dropped per Strategy-2: `useMfgProducts` (SKU-picker datalist + auto-name +
    prefix suggestions) → plain text inputs; `buildVariantSummary` → "Description 2"
    shows stored description2 (none on Houzs transfer/take lines) else em-dash;
    `fmtDateOrDash`/`SkeletonDetailPage` inlined / replaced with plain loading text
    (done-slice precedent). window.confirm/alert kept verbatim (1:1 fidelity; done
    slices kept it). No migration `0029`.
  - Nothing applied to any DB (no migration; batched for staging at #70).
