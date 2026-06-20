# Houzs ERP — Codebase Map & Audit

Generated 2026-06-18 from a full read of `main` @ `7f2a60e` (in sync with `origin/main`).
Repo: `hello-houzs/Houzs-ERP` (private). This is a reference map: architecture, the
complete endpoint inventory, the data model, and an audit of unfinished work.

> Scope note: `main` currently carries the merged **`scm-clone-2990s`** work. So the
> entire SCM supply-chain (purchasing / inventory / order-to-cash / consignment /
> catalogue) lives in the codebase, but its production Postgres migrations
> (`0024`–`0033`) are **not yet applied to the live DB** and the routes are
> owner-only gated. See "Unfinished work".

---

## 1. What this repo is

Internal ERP for Houzs Century. Two self-deploying sub-apps:

- **backend/** — Cloudflare **Workers + Hono** API (`autocount-sync-api`). 82 route
  modules, ~250 endpoints. Originally D1 SQLite; **now runs on Supabase Postgres**
  via Hyperdrive (the cutover shipped 2026-06-13).
- **frontend/** — React 18 + Vite **SPA** on **Cloudflare Pages** (`houzs-erp`,
  served at `erp.houzscentury.com`). Route-level lazy loading, React Router v6.
- **shared/** — shared zod schemas/types.

> The root `CLAUDE.md` still describes the stack as "D1 SQLite, R2 storage" — that
> line is **stale**; the live data store is Supabase Postgres (D1 is now test-only).

External integration: **AutoCount** (accounting) via a .NET middleware at
`it-houzs.dev`. Both sync directions are currently **switched off** (see §7).

---

## 2. Architecture & infrastructure

### Backend Worker (`backend/wrangler.toml`)

- **Name**: `autocount-sync-api` (prod) / `autocount-sync-api-staging` (staging env).
- **Account**: `816e457307d7fa0491c2a08a72ad5dcd` (hello@houzscentury.com).
- `compatibility_date = 2024-12-01`, `compatibility_flags = ["nodejs_compat"]`.
- Origins: `autocount-sync-api.houzs-erp.workers.dev`; app at `erp.houzscentury.com`
  (+ `houzs-erp.pages.dev`).

**Bindings (prod):**

| Binding | Type | Target |
|---|---|---|
| `HYPERDRIVE` | Hyperdrive | `f0f9bd0d…` (`houzs-erp-pg-v2`) → SG Supabase `anogrigyjbduyzclzjgn`, **session pooler :5432** |
| `POD_BUCKET` | R2 | bucket `houzs-erp` (proof-of-delivery, attachments) |
| `SESSION_CACHE` | KV | `c25f593f…` (60s session-user cache + rate-limit counters) |
| ~~D1~~ | — | **removed 2026-06-13**; old `autocount-sync` D1 kept cold, unbound |
| `ERP_METRICS` | Analytics Engine | commented out / deferred |

- **Vars** (names only): `AUTOCOUNT_API_URL`, `AUTOCOUNT_SYNC_DISABLED="true"`,
  `PUBLIC_APP_URL`, `EMAIL_FROM`, `EMAIL_REPLY_TO`.
- **Secrets** (via `wrangler secret put`): `AUTOCOUNT_API_KEY`, `DASHBOARD_API_KEY`,
  `RESEND_API_KEY`, `GOOGLE_MAPS_API_KEY`.
- **Cron** (`[triggers]`): `*/5 * * * *` SO incremental pull · `*/30 * * * *` PO pull ·
  `0 2 * * *` daily batch (overdue auto-extend, SLA escalation, project reminders,
  creditors resync, stock-items refresh, weekly streak + leaderboard cache, monthly
  gifting reset). Staging `crons = []`.
- Observability: `[observability.logs]` with `invocation_logs` on.

### Frontend (Cloudflare Pages)

- `frontend/wrangler.toml`: `name = "houzs-erp"`, `pages_build_output_dir = "./dist"`.
- Build = `tsc + vite`; bakes `VITE_*` env into the bundle.
- `vite.config.ts`: dev proxy `/api` → Worker; manual vendor chunks
  (`react-vendor`, `leaflet`, `lucide`, `vendor`). **No `_routes.json`** — `_redirects`
  rewrites `/api/*` to the Worker; SPA routing is client-side.

### Database reality (the important part)

- **Live prod DB = Supabase Postgres.** D1/SQLite is now **test-only** (replayed
  against vitest's SQLite for schema parity).
- `db/client.ts` → `getDb(env)` builds a Drizzle `postgres-js` client **per request**
  (postgres.js sockets can't cross the Worker request boundary).
- `db/pg.ts` `getSql(url)`: prod branch goes Hyperdrive → Supavisor pooler with
  `max:1, prepare:false, idle_timeout:0`, **no ssl / no connect_timeout** (both
  hard-won fixes — Hyperdrive terminates TLS; a 10s cap fast-failed slow queries).
- **D1-compat shim** (`middleware/db.ts` `dbInject`) swaps `env.DB` for a D1-shaped
  wrapper over Postgres so the ~685 legacy `env.DB.prepare(...)` call sites keep
  working (rewrites `?`→`$n`, `datetime('now')`, returns `meta.changes/last_row_id`
  via `RETURNING`). `withPgDb(env)` does the same for the cron path.
- Connection URL: `env.DATABASE_URL ?? env.HYPERDRIVE.connectionString`.
- **Caveat**: `MIGRATION-D1-TO-SUPABASE.md` / `HANDOFF-supabase-cutover.md` still name
  the *old abandoned* project `xxoszhxglfgkqkokvofa` and describe D1 as bound for
  rollback. They are **historical** — the live config is the SG project above with D1
  removed.

---

## 3. Data model (grouped)

`schema.pg.ts` (~3,646 lines, ~140 tables). Money is stored as integer minor units
(`*_sen` / `*_centi`). Project row-scope is 2-D: `projects.pic_id` (PIC one-hop) +
`user_brands` allow-list.

- **Auth / org**: `users`, `sessions`, `invitations`, `password_resets`, `roles`,
  `role_page_access`, `positions`, `position_page_access`, `departments`, `user_brands`.
- **Projects (events ERP)**: `projects`, `project_brands`, `project_activity`,
  `project_reads`, `project_phase_photos`, `project_sales_attendees`,
  `project_checklist(+_sections/_templates/_template_sections/_template_items/_attachments)`,
  `project_finance(+_lines)`, `project_cost_rates`, `events`.
- **ASSR / service**: `assr_cases` + lookups/logistics/activity/attachments (largely in
  the pg-migration tables, not all surfaced in `schema.pg.ts`).
- **Trips / fleet**: `trips`, `trip_stops`, `trip_locations`, `lorries`,
  `lorry_incidents`, `warehouses`, `salary_trip_lines`.
- **Sales / orders (AutoCount mirror)**: `sales_orders`, `order_details`,
  `purchase_orders`, `purchase_order_docs`, `creditors`, `overdue_history`, `customers`.
- **Sales team / commission**: `sales_reps`, `sales_positions`, `sales_commission_tiers`,
  `sales_rep_commission_tiers`, `sales_rep_brands`, `sales_team_activity`.
- **SCM purchasing**: `mfg_suppliers`, `supplier_material_bindings`,
  `mfg_purchase_orders(+_items/_lines)`, `grns(+_items)`,
  `purchase_invoices(+_items)`, `purchase_returns(+_items)`.
- **SCM inventory**: `mfg_warehouses`, `inventory_lots`, `inventory_lot_consumptions`,
  `inventory_movements` (FIFO), `stock_transfers(+_lines)`, `stock_takes(+_lines)`,
  `warehouse_racks(+_items/_movements)`.
- **SCM order-to-cash (mfg)**: `mfg_sales_orders(+_items/_payments/_audit_log/
  _price_overrides/_status_changes)`, `delivery_orders(+_items/_payments)`,
  `delivery_returns(+_items)`, `sales_invoices(+_items/_payments)`.
- **Consignment**: `consignment_sales_orders(+items/payments/audit)`,
  `consignment_delivery_orders/_notes/_returns(+items)`,
  `purchase_consignment_orders/_receives/_returns(+items)`.
- **Catalogue / pricing**: `products`, `mfg_products`, `product_models`, `categories`,
  `series`, `addons`, `special_addons`, `product_size_variants`, `product_fabrics`,
  `product_bundles`, `product_compartments`, `product_bedframe_colours`,
  `product_dept_configs`, `fabrics`, `fabric_library`, `fabric_trackings`,
  `fabric_tier_addon_config`, `model_fabric_tier_overrides`, `sofa_combo_pricing`,
  `sofa_quick_picks`, `pwp_codes`, `pwp_rules`, `master_price_history`,
  `maintenance_config_history`, `mrp_category_lead_times`.
- **Engagement**: `point_transactions`, `gamify_settings`, `user_streak_weeks`,
  `leaderboard_cache`, `awards`, `award_redemptions`, `innovations`, `suggestions`,
  `votes`, `idea_attachments`, `petty_cash_entries`.

---

## 4. Migrations (two sets)

- **`backend/src/db/migrations-pg/`** — PRODUCTION Postgres. **34 files, highest =
  `0033_products_maintenance.sql`**. `0024`–`0033` are the SCM clone (suppliers, POs,
  inventory/warehouse, GRNs, purchase billing, sales orders, delivery billing,
  consignment, MRP, products). **Not yet applied to the live DB** (per
  `docs/scm-clone/PLAN.md` #70).
- **`backend/src/db/migrations/`** — D1/SQLite, **test-only, 102 files (up to `101`)**.
  Most ≥093 mirror the pg set for vitest schema parity.

Last test-set migrations: 095 email_outbox · 096 audit_events · 097 totp_2fa ·
098 document_email (`sales_orders.customer_email`) · 099 member_invite_toggle (seed) ·
100 users_phone · 101 checklist_amendments_test_parity.

> CLAUDE.md flags "demo seed in numbered migrations" as an anti-pattern. Current seed
> migrations (`0011/0012` sales_reps defaults, `0016` storekeeper role, `099` invite
> toggle) are canonical/default rows (the allowed kind), not fake demo data.

---

## 5. Backend API surface — endpoint inventory

Global middleware order (`backend/src/index.ts`): `requestLog` → `cors()` →
`dbInject`. Public routes (`/`, `/health`, `/api/auth/*`, `/api/survey`, `/api/track`,
`/api/portal/*`, `/api/supplier-portal/*`) mount **before** the `auth` gate; everything
else under `/api/*` requires a valid bearer session, then `idempotency` (opt-in via
`Idempotency-Key`). **Gate** column = the per-route gate on top of that baseline.
`*` = `requirePermission('*')` (owner-only) — used uniformly by the SCM-clone modules
because real permission keys are deferred to the auth-seam phase.

### 5.1 Auth & identity

**`/api/auth`** (pre-auth / public unless noted) — `auth.ts`

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET | /api/auth/status | public | Whether any active users exist (login vs bootstrap) |
| POST | /api/auth/bootstrap | zero-users only | Create the first Owner |
| POST | /api/auth/login | public (rate-limited) | Email+password → session (or 2FA challenge) |
| POST | /api/auth/totp/login | public (rate-limited) | 2FA second step → session |
| POST | /api/auth/forgot-password | public (rate-limited) | Self-service reset email |
| GET | /api/auth/invite/:token | public | Invite preflight |
| POST | /api/auth/accept-invite | public | Accept invite → active user + session |
| POST | /api/auth/logout | self | Invalidate caller session |
| GET | /api/auth/me | bearer / DASHBOARD_API_KEY | Current user + permissions |
| GET\|POST | /api/auth/reset/:token | public | Verify / consume reset token |
| PATCH | /api/auth/me | self | Edit own display name |
| POST | /api/auth/me/password | self | Change own password |

**`/api/totp`** — `totp.ts`: GET `/status`, POST `/setup`, POST `/enable`,
POST `/disable` (all requireAuth; self-service 2FA).

**`/api/users`** — `users.ts` (gate `users.read` / `users.manage`): list users,
get/replace user brands, upload/remove/stream profile pic, invite + resend + revoke
invitations, patch/disable user, admin reset-password, admin disable user 2FA.

**`/api/roles`** — `roles.ts` (`roles.read` / `roles.manage`): permission catalogue,
list/create/update/delete roles, page catalogue, get/upsert role page-access.

**`/api/positions`** — `positions.ts` (`users.read` / `users.manage`): list/create/
update/delete positions, page catalogue, get/upsert position page-access (dept×position
matrix).

**`/api/departments`** — `departments.ts` (`users.read` / `users.manage`): CRUD
departments + member counts.

**`/api/presence`** — `presence.ts` (requireAuth): POST `/heartbeat`, GET `/` (active
users in window).

### 5.2 Projects (events ERP) — `projects.ts`, `projects_print.ts`, `events.ts`

Gated by `projects.*` permissions and `requirePageAccess('projects.*')`. ~90 endpoints,
including: event-types CRUD+reorder+default-template; brands CRUD+reorder; cost-rates;
`GET /summary`, `GET /` (scoped list), `GET /:id`; create/patch/archive/unarchive;
notes/chat, activity polling, mark-read; finance rollup + ledger lines + uploads +
resync; phase-photos (upload/list/delete); payment status + proof; stock-transfers
(create/confirm/unconfirm/archive); checklist items + status + review + attachments;
sections CRUD+reorder; defects + photos; sales-reports + resync; team members; sales
attendees; trip link/unlink; project attachments; calendar events; CSV import. Plus
`GET /api/projects-print/:id` (A4 printable). `events.ts`: manual calendar events CRUD
(`trips.manage`). `finance.ts`: `GET /api/finance/pnl(+/bucket,/month)` cross-module
cash-basis P&L (`projects.read`).

### 5.3 ASSR (after-sales service) + portals

**`/api/assr`** — `assr.ts` (`service_cases.read/write/manage/approve`): ~45 endpoints —
settings, lookups CRUD+reorder, case list/detail/create/patch, cost-suggestion, summary
KPIs, by-creditor, bulk archive/assign, CSV export, customer-history, track/supplier/
survey token issue, archive/unarchive, logistics CRUD+feed, attachments (upload/stream/
visibility), notes + corrections, transition (+survey email), generate-PO, approve,
metrics + drill, timeline CSV, items add/remove.

**`/api/assr/portal`** — `assrPortal.ts`: lead-time profiles + scheduled activations,
priority×stage targets, target amendments + audit, stages list, alerts ack/snooze/
override.

**`/api/assr-print/:id`** — `assr_print.ts`: printable case HTML (office/customer/
supplier variants).

Public/portal (token-gated, no session):
- **`/api/track`** (`track.ts`): POST verify ASSR no + phone → customer token.
- **`/api/portal`** (`portal.ts`, customer token): case detail, comments, attachment
  upload/stream, retract.
- **`/api/supplier-portal`** (`supplierPortal.ts`, supplier token): case bundle, stage
  transition, remarks, attachment upload/stream/retract.
- **`/api/survey/:token`** (`survey.ts`, public): GET case info, POST satisfaction survey.

**`/api/inbox`** (`inbox.ts`): aggregated "what needs me" dashboard (ASSR + projects +
trips), per-section permission-gated internally.

### 5.4 Trips / fleet / logistics

- **`/api/trips`** (`trips.ts`): list (scope by `trips.read.all`), mine/today, detail,
  create (`trips.manage`), patch/transition, reorder stops, permanent-delete, clear
  history, cancel, update stop, append/read GPS locations, upload/stream POD.
- **`/api/delivery`** (`delivery.ts`, `delivery_orders.*`): list, overdue, detail,
  advance status, patch, manual create.
- **`/api/driver/projects`** (`driverProjects.ts`, crew-scoped): list, brief, upload +
  attach phase photos.
- **`/api/fleet`** (`fleet.ts`): staff list/detail/update, me profile, clock in/out/
  status/history, daily inspection + missing, lorry detail/edit + maintenance/incidents,
  compliance expiring, salary views.
- **`/api/lorries`** (`lorries.ts`): list, create/reactivate, soft-delete (`fleet.manage`).
- **`/api/maps`** (`maps.ts`): geocode, directions, backfill-orders, geocode one order.
- **`/api/planner`** (`planner.ts`, `planner.run`): generate draft proposal, current,
  edit/drop proposed trip, confirm (materialize), discard.

### 5.5 Sales — AutoCount core

- **`/api/orders`** (`orders.ts`): list, stats, summary, items (line fan-out), detail,
  live lines, patch remark4/expiry (push to AutoCount), upsert order_details.
- **`/api/po`** (`po.ts`): summary, line list, docs, doc detail, lines, live details,
  manual pull, patch line, sync dates to AutoCount.
- **`/api/creditors`** (`creditors.ts`): list + PO aggregate, summary, detail, live
  read-through, manual pull.
- **`/api/balance`** (`balance.ts`): SO outstanding-balance summary + list.
- **`/api/overdue`** (`overdue.ts`): summary, run pull, history, grouped orders.
- **`/api/sales`** (`sales.ts`, `requirePageAccess('sales')`): entries list/export/
  detail/create/patch/submit/unsubmit/void/delete; `POST /entries/:id/push` is a
  **501 stub** (AutoCount push disabled).
- **`/api/sales-team`** (`sales-team.ts`, `sales_team.*`): reps CRUD, admin/brands/
  commission-tiers, activity, lookups CRUD+reorder, reset-positions.
- **`/api/stockitems`** (`stockItems.ts`): cached rows, read-through item, bulk refresh.
- **`/api/warehouses`** (`warehouses.ts`): list active AutoCount warehouses.
- **`/api/sync`** (`sync.ts`): pull (kill-switch aware), retry-errors, status.

### 5.6 SCM purchasing (owner-only `*`)

- **`/api/purchase-orders`** (`mfg-purchase-orders.ts`): list, outstanding-SO-items,
  detail, linked, create, from-sos, header/line CRUD, convert-from-so, submit, cancel,
  reopen, delete.
- **`/api/grns`** (`grns.ts`): list, outstanding-po-items, detail, linked, create,
  from-pos, post (inventory IN), from-po-items, cancel, header/line CRUD.
- **`/api/purchase-invoices`** (`purchase-invoices.ts`): list, outstanding-grn-items,
  detail, linked, create, post, payment, cancel, from-grn(-items), header/line CRUD.
- **`/api/purchase-returns`** (`purchase-returns.ts`): list, detail, linked, create,
  from-grn(s), post, complete, cancel, header/line CRUD.
- **`/api/suppliers`** (`suppliers.ts`): list, detail, create, update, bindings CRUD +
  batch, scorecard, suppliers-by-material.

### 5.7 SCM inventory / warehouse (owner-only `*`)

- **`/api/inventory`** (`inventory.ts`): warehouses CRUD, balances, **`/products`
  hard-stub returns `[]`**, breakdown, movements, lots, batches, cogs, value,
  analytics, reconcile, adjustments, buckets.
- **`/api/stock-takes`** (`stock-takes.ts`): list, detail, create, update lines, cancel,
  reverse, delete, post (signed ADJUSTMENT movements).
- **`/api/stock-transfers`** (`stock-transfers.ts`): list, detail, create (paired
  OUT@from + IN@to), cancel, post.
- **`/api/mfg-warehouses`** (`warehouse.ts`): warehouses + racks, rack CRUD, stock-in,
  stock-out, rack transfer, movements.

### 5.8 SCM order-to-cash, mfg side (owner-only `*`)

- **`/api/mfg-sales-orders`** (`mfg-sales-orders.ts`): list, mine, customer-search,
  `customer-credit/:debtorCode` (**stubbed to 0** — SI slice not cloned), detail,
  create, recompute-allocation, status, audit/status/price-override history, line
  price override, header/line CRUD, payments, per-line stock-status flip.
- **`/api/mfg-delivery-orders`** (`delivery-orders-mfg.ts`): list, deliverable-so-lines,
  detail, create, from-sos, header/line CRUD, payments, status (ship = inventory OUT).
- **`/api/delivery-returns`** (`delivery-returns.ts`): list, returnable-do-lines, detail,
  create (inventory IN), from-do(s), header/line CRUD, status.
- **`/api/sales-invoices`** (`sales-invoices.ts`): list, invoiceable-do-lines, detail,
  create, from-dos, append-from-do, header/line CRUD, payments, status, legacy payment.

### 5.9 Consignment (owner-only `*`)

- Sales side: **`/api/consignment-orders`**, **`/api/consignment-notes`**,
  **`/api/consignment-returns`** — full order → note (ship OUT) → return (book IN)
  doc-flow with payments + status transitions.
- Purchase side: **`/api/purchase-consignment-orders`**,
  **`/api/purchase-consignment-receives`** (POSTED = inventory IN),
  **`/api/purchase-consignment-returns`** (POSTED = inventory OUT) — with from-* batch
  conversions and post/cancel/complete transitions.

### 5.10 Catalogue / pricing (owner-only `*`)

- **`/api/products`** (`products.ts`): list, create (+ per-pricing-kind rows).
- **`/api/product-models`** (`product-models.ts`): list/detail/create/update/delete,
  generate-skus; **photo GET/POST are 501 stubs** (R2 not wired).
- **`/api/mfg-products`** (`mfg-products.ts`): SKU list/create/batch-import/delete/
  detail/patch, activate-one-shot, price-history, suppliers.
- **`/api/categories`** (`categories.ts`): CRUD; **`POST /:id/hero-image` is a 501 stub**.
- **`/api/fabric-library`**, **`/api/fabric-tier-addon`**, **`/api/fabric-tracking`** —
  fabric tiers, tier-addon config + per-model overrides, fabric CRUD + bulk upsert.
- **`/api/sofa-combos`** (`sofa-combos.ts`): effective-dated combo pricing CRUD + history.
- **`/api/pwp-codes`**, **`/api/pwp-rules`** — purchase-with-purchase code reserve/
  validate + rule CRUD.
- **`/api/mrp`** (`mrp.ts`): pure MRP calculator (no persistence). **`/api/mrp-lead-times`**:
  per-category lead-times.
- **`/api/maintenance-config`** (`maintenance-config.ts`): resolved/history/changes;
  **`POST /sofa-compartments/rename` is a 501 stub**.

### 5.11 Engagement

- **`/api/gamify`** (`gamify.ts`): me, leaderboard, transactions, streak, gift,
  recipients, settings (admin edit), admin adjust/recompute/reset/refresh, departments.
- **`/api/awards`** (`awards.ts`): catalog, admin catalog, CRUD, image up/stream, redeem,
  my/all redemptions, ship/deliver/cancel.
- **`/api/innovations`** (`innovations.ts`) & **`/api/suggestions`** (`suggestions.ts`):
  submit, detail, edit-own, vote/unvote, voters, admin decision (awards points), archive.
- **`/api/idea-comments`** (`ideaComments.ts`) & **`/api/idea-attachments`**
  (`ideaAttachments.ts`): comments + image attachments on innovations/suggestions.
- **`/api/petty-cash`** (`pettyCash.ts`): ledger list, add entry, edit (own+24h or
  manage), archive, receipt up/stream, categories.

### 5.12 Admin / system

- **`/api/settings`** (`settings.ts`, `settings.manage`): email channel toggles +
  config, email log, test send.
- **`/api/audit`** (`audit.ts`, `settings.manage`): read-only `audit_events` ledger.
- **`/api/logs`** (`logs.ts`): paginated `execution_logs`.
- **`/api/admin/health`** (`systemHealth.ts`, `*`): live DB/KV ping + headcount/audit
  counts, audit-feed.
- **`/api/udf`** (`udf.ts`): user-defined fields per table (list/create/delete/upsert).
- **`/api/search`** (`search.ts`): global cross-module Cmd+K search.
- **`/api/notifications`** (`notifications.ts`, `projects.read`): scoped activity feed +
  per-project unread + points snapshot.

---

## 6. Frontend map

- **Entry** `main.tsx` forks by URL prefix: **public** (`/survey`, `/track`, `/portal`,
  `/reset` — no AuthProvider) vs **staff app** (AuthProvider → AuthGate → App). Inside
  `App.tsx`, `/driver*` renders the mobile `DriverLayout`; everything else the
  dispatcher `Layout`. **Every page is `React.lazy`-loaded.**
- **Guards**: `PageGuard page=… [minLevel]` (per-page access level partial/full),
  `Guard perm=…`/`anyPerm=…` (flat permission, `*` = owner), or none (any authed user).
  Denials render `<Forbidden>` inline.
- **Page groups** (`pages/` ~55 + `pages/scm/` ~67 + `portal/`): Orders/Sales/PO/
  Creditors/Balance/Overdue; ServiceCases (huge) + Metrics/Settings/Logistics/LeadTime;
  Logistics/Trips/Fleet; Driver* (mobile); Projects/ProjectMaintenance; Team/Roles/
  Positions/SalesTeam/SystemDashboard/SystemHealth/Settings/Logs; Gamification/Shop/
  Innovations/Suggestions/PettyCash/Notifications; Suppliers; and the full **SCM clone**
  under `scm/` (purchasing, inventory, order-to-cash, consignment, MRP, products).
- **API client** (`api/client.ts` + `api/cache.ts`): hand-rolled, no axios. Base URL =
  `VITE_API_URL` else `https://autocount-sync-api.houzs-erp.workers.dev`. Bearer token
  from `localStorage["auth:token"]`. Global `onUnauthorized`/`onForbidden` listeners.
  **GET-only retry**: 27s `AbortController` timeout, 2 retries w/ backoff (survives
  Hyperdrive cold-start "Failed to fetch"); mutations never retried. 15s in-memory SWR
  cache + cross-tab `BroadcastChannel` invalidation; `NEVER_CACHE` for auth/activity/
  presence/health.
- **Auth**: boots `/api/auth/status` → bootstrap-vs-login, then `/api/auth/me`. Two-step
  TOTP login supported. Permissions = flat-string `Set` (`*` short-circuits). Page
  access = per-page level map (mig 073). Driver-only users auto-route to `/driver`.

> **Frontend bug to flag**: `/delivery-orders` is declared **twice** in `App.tsx` — the
> AutoCount `DeliveryOrders` (`PageGuard delivery_orders`) wins, so the SCM
> `ScmDeliveryOrders` list at that path is unreachable.

---

## 7. Middleware & AutoCount integration

**`backend/src/middleware/`**: `requestLog` (access log + X-Request-Id) · `db`
(`dbInject` PG shim + `withPgDb`) · `auth` (session → user + RBAC) · `idempotency`
(opt-in replay) · `rateLimit` (KV brute-force speed bump) · `caseTrack` (customer portal
token) · `supplierTrack` (supplier portal token).

**AutoCount** (`services/autocount.ts`, `pull.ts`, `push.ts`) — both directions OFF:

- **Outbound writes — HARD OFF**: `const AUTOCOUNT_WRITES_DISABLED = true`
  (`autocount.ts:27`). Code-edit-to-flip; `pushSalesOrder`/`pushPODates` short-circuit.
- **Inbound sync — env kill switch**: `isAutoCountSyncDisabled(env)` reads
  `AUTOCOUNT_SYNC_DISABLED="true"` (set 2026-06-13); cron + `/api/sync` skip all pulls.

Net: read-from-AutoCount and write-to-AutoCount are both disabled in prod; the ERP runs
self-contained on Supabase.

---

## 8. Unfinished work (audit)

### 8.1 Hard stubs (501 / empty-return)

| Location | What's missing |
|---|---|
| `routes/sales.ts:878` `POST /entries/:id/push` | 501 — AutoCount push disabled (placeholder so FE button doesn't 404) |
| `routes/categories.ts:150` `POST /:id/hero-image` | 501 `not_configured` — `PUBLIC_ASSETS` R2 not wired |
| `routes/product-models.ts:531-539` photo GET/POST/DELETE | 501 `photo_bucket_not_configured` — `SO_ITEM_PHOTOS` R2 not wired |
| `routes/maintenance-config.ts:179` `POST /sofa-compartments/rename` | 501 — cascade rename fn not ported |
| `routes/inventory.ts:30,223,250,288` `/products` + product-total views | returns empty `[]` — catalogue-coupled views not created |
| `routes/mfg-sales-orders.ts:725` `/customer-credit/:debtorCode` | returns 0 — SI slice not cloned |
| `services/delivery.ts:195` `buildDeliveryOrderEmail` | foundation built, NOT wired to any status transition (owner to specify trigger) |
| `pages/SalesTeamDetail.tsx:109,115` | org tree + performance metrics "coming soon" |
| `pages/SystemHealth.tsx:377` | latency percentiles / slow-SQL "staged for phase 2" (needs Analytics Engine) |

### 8.2 Deferred SCM-clone scope (dropped from the 2990s clone on purpose)

Every site is marked `// TODO`; these are functional gaps vs the 2990s source, not bugs:

- **GL / AP posting** — dropped across `purchase-invoices.ts`, `purchase-returns.ts`.
- **GL / AR revenue posting** — `postSiRevenue`/`reverseSiRevenue`/`resyncSiRevenue`
  dropped in `sales-invoices.ts`; SI returns `revenue:{posted:false,status:"out_of_scope"}`.
- **Customer-credits auto-apply** — `sales-invoices.ts`, `mfg-sales-orders.ts`.
- **Costing-B re-cost chain** (`recostFromGrn`/`recostForPi` → DO/SI margin) — not
  cloned: `grns.ts:1879`, `purchase-invoices.ts` (multiple).
- **Furniture PDF print (jsPDF)** — all SCM doc PDFs dropped (`scm/*Detail.tsx` `// TODO
  generic print`).
- **R2 photo/asset plumbing** — SO slip-upload, category hero-image, product-model
  photos (all 501 above).
- **Furniture pricing engine** — sofa-combo / fabric-tier / PWP / variant pricing
  stripped from the SO/PO/DO/SI/consignment/MRP slices; kept only in the Products slice.
  Variant columns persisted nullable for fidelity.

### 8.3 SCM clone program — open tasks (`docs/scm-clone/PLAN.md`)

- **#70 Staging end-to-end acceptance** — SCM pg migrations `0024,0026-0033` are batched
  and **NOT applied to any DB**; never live-tested.
- **#69 Rewire Logistics/ASSR/Projects → new `mfg_sales_orders` model** — pending.
- **#71 (GATED) Prod cutover** — delete AutoCount core + migrate ~2,695 live
  `sales_orders` rows; needs a written data plan + explicit owner sign-off. Includes
  renaming `mfg_purchase_orders`→`purchase_orders`, `mfg_warehouses`→`warehouses`.
- SalesOrderDetail per-line MRP coverage left as faithful-empty (`computeMrp` exported
  for follow-up). Products-slice advanced editors deferred (sofa-combo builder UI,
  effective-dated maintenance editor, per-SKU variant drawer, CSV import/export UI, R2
  uploader, SalesOrderMaintenance + Addons pages — backend routes already exist).

### 8.4 Roadmap from `docs/UPGRADE-NEXT.md` (Houzs-vs-Hookka gap analysis, ranked)

Several of these are reportedly already shipped (rate-limit, email-outbox, audit, TOTP,
observability — see MEMORY's security-upgrades note); confirm against current state:

1. Login/portal-token rate limiting (HIGH) · 2. Durable email outbox + retry (HIGH) ·
3. Global immutable audit trail (HIGH) · 4. TOTP 2FA enforced for admin (HIGH) ·
5. Observability / Sentry hook (MED) · 6. Event-driven supplier/customer notifications
(MED) · 7. Google Workspace SSO (MED) · 8. Keyset pagination + virtualized grids (MED) ·
9. Richer PDF doc generation (LOW).

### 8.5 Other roadmap notes

- **`CLAUDE.md`**: centralise the hand-written
  `COALESCE(p.pic_id,p.created_by) IN (...) AND p.brand IN (...)` scope fragment
  (duplicated across project list / calendar / notifications) into `projectScopeWhere(user)`.
- **`mfg-purchase-orders.ts:454`** TODO is stale — handler below already queries the
  real `purchase_invoices`/`purchase_returns` tables.

### 8.6 Gated-off / feature-flagged

- AutoCount writes HARD OFF (`autocount.ts:27`) + inbound sync OFF (`AUTOCOUNT_SYNC_DISABLED`).
- Customer-facing email channels (`delivery_order`, `invoice`, `document_report`)
  **fail closed** — send only when the toggle row is `true`, and **no trigger is wired**
  (`services/email.ts:77`). Internal channels default ON; member-invite seeded ON
  (mig 0010).
- All SCM modules owner-only (`requirePermission('*')`) pending the auth-seam phase.
- Stock-transfer/take/PI hard-DELETE disabled — only CANCELLED transition allowed.

### 8.7 In-progress signals (git / untracked)

- HEAD `7f2a60e` merges `origin/main` into `scm-clone-2990s` — the SCM clone is the
  active multi-week track (code-complete, not deployed).
- Untracked scratch scripts under `backend/scripts/` from the pooler/Hyperdrive saga:
  `_staging-setup.mjs`, `cleanup-roles.mjs`, `list-roles.mjs`, `list-sales.mjs`,
  `switch-hyperdrive-pooler.mjs`, `test-pooler.mjs`, and `backend/scripts/pooltest/`
  — **the pooltest dir contains a `.dev.vars` worth scrubbing.**
- Untracked `docs/UPGRADE-NEXT.md` (the gap-analysis roadmap).
- Many parallel WIP branches: `scm-clone-2990s`, `upgrade/stack`,
  `migrate/d1-to-supabase`, `feat/scm-*`, `batch2/3/4-*`, `feat/checklist-amendments`,
  `feat/user-mgmt-positions`, `nextjs-rewrite`, plus several `fix/*`.

---

## 9. Top risks / things to watch

1. **SCM migrations 0024-0033 unapplied** — the SCM routes are in the codebase and
   reachable to the owner, but the live Supabase DB does not have their tables yet.
   Hitting an SCM write as owner against prod could error until the migrations are
   applied + staging-accepted (PLAN #70).
2. **`.dev.vars` in `backend/scripts/pooltest/`** (untracked) — secret material in a
   scratch dir; scrub before it ever gets committed.
3. **Stale docs** — root `CLAUDE.md` ("D1 SQLite") and the two migration handoff docs
   (old project id, D1-bound) no longer match the deployed Supabase config.
4. **Duplicate `/delivery-orders` route** in `App.tsx` shadows the SCM list page.
5. **AutoCount fully offline** — by design, but means no accounting round-trip; all
   financial truth lives in Supabase only right now.
