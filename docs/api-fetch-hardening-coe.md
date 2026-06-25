# API + Fetch Hardening — Correction of Error (CoE)

**Date:** 2026-06-26
**Scope:** Owner-requested system-wide hardening of the API (authorization) and Fetch (null-safety) layers, plus the inventory-movement reporting class. One batched deploy.

## Trigger

1. A prod runtime crash on the New-Sales-Order page: `Cannot read properties of null (reading 'localeCompare')`. Root cause was **NOT** a code bug on that page — it was **stale Service-Worker cache from a burst of 6 rapid deploys in ~90 minutes** (mismatched cached JS chunks). A clean reload (sw `v69`) resolved it. But it prompted →
2. A 4-agent read-only audit (frontend null-safety / backend SCM correctness / auth-RBAC / data-integrity), then the owner directive: "全部解决 + 复刻所有 API 和 Fetch 全套系统 + CoE".

## What was wrong + fixed (this campaign)

### A. API authorization gaps — FIXED
- `backend/src/routes/udf.ts` `POST/:table`, `DELETE/:table/:key`, `PUT/:table/values/:rowKey` — UDF custom-field **schema + value writes had NO authz gate** (any authenticated staff could add/delete columns + values on SO/PO/DO/ASSR/sales_entries). → gated with `requirePermission("udf.manage")`.
- `backend/src/routes/stockItems.ts` `POST/refresh` — an expensive AutoCount external sync, ungated. → gated with `requireAnyPermission(["service_cases.manage","settings.manage"])`.
- `requirePermission` short-circuits for SUPER_ADMIN/ADMIN, so the owner/admins are never locked out.

### B. Inventory "silent movement swallow" — FIXED
Forward post/dispatch routes called best-effort inventory-move helpers whose `{ok:false}` result was **discarded** — a document flipped to POSTED/DISPATCHED and returned 200/201 **even when the stock move failed**, with nobody told ("doc posted, stock never moved"). Fixed by mirroring the existing consignment / stock-transfer `movementErrors: string[]` pattern across:
- `scm/routes/delivery-orders-mfg.ts` — DO dispatch + create + from-sos
- `scm/routes/delivery-returns.ts` — create + from-dos
- `scm/routes/grns.ts` — post + from-po-items (per-bucket flag) + create + from-pos
- `scm/routes/purchase-returns.ts` — create + from-grns

The per-route wrappers now return their errors; routes surface `movementErrors` in the JSON (additive, non-breaking). The shared low-level `writeMovements`/`reverseMovements` were not touched; no rollback/compensation added (separate concern); idempotency guards unchanged.

### C. Frontend null-crash class — FIXED system-wide
~85 null guards across ~50 files. The crash class = a field typed `string` that the API can return `null`, reaching `.localeCompare`/`.toLowerCase`/`.slice`. HIGH instance: `pages/Projects.tsx` calendar `.slice(0,10)` on a null `due_date` (crashes the Calendar view). Plus Mail Center search/sort, `Team.tsx`, and a system-wide sweep of every ad-hoc `sortFn` `localeCompare` in `scm-v2/*` + `vendor/scm/components/*` (wrapped both operands with `?? ''`). The shared `sort-options.ts` `byText`/`textOf` helper was already null-safe.

### D. Data integrity — FIXED
- `is_active` lost its `DEFAULT` in the D1→PG migration on 4 public tables (`assr_lead_time_profiles`, `creditors`, `lorries`, `stock_items` — all bigint, 0 existing NULL rows). → `ALTER … SET DEFAULT 1` (applied to prod + migration `104_restore_is_active_defaults.sql`).
- `sales_reps` SR-002 (departed IT dev Nijam's rep, wrongly still `active`) → set `inactive`.

## Verified NOT a problem (audit ruled these out)
- **pg-camelCase (the cross-stack "#1 recurring bug") does NOT apply to Houzs** — SCM uses supabase-js (snake_case keys); `projects.ts` uses `db/pg.ts` which *deliberately disables* the camelCase transform.
- SO create is well-compensated (rolls back header + PWP claims on item-insert failure); all `scm.*` status columns are real PG enums (drift-proof); SO header totals = line sums.
- Route-ordering: only the (already-fixed) `/sales-rep-options`-shadow existed; every other scm router registers static routes before `/:id`.

## DEFERRED — needs owner decision (intentionally NOT auto-done)
1. **`public.*` duplicate tables** — 90 tables exist in both `public` and `scm`. The SCM business tables (customers, delivery_*, products…) are empty `public` shells (safe to drop), BUT **`email_*` (Mail Center) LIVE data is in `public`** (375 messages, 264 threads) — a blind drop would destroy the Mail Center. Dropping requires per-table schema-of-record analysis. **DO NOT blind-drop.**
2. **343 orphan-PIC projects** — `projects.pic_id` 343 rows → deleted user id 3 (Nijam), 1 → id 6. No FK → PIC-scoped ACL + name joins silently degrade. Owner must decide who to reassign to (then add an FK / app guard).
3. **SCM L2 write-gate hole** — `scmAreaGuard` only enforces for users with `scm_l2_configured`; a plain `scm.access` holder bypasses every per-area write gate. Fix = default-deny for un-configured users, but that risks locking out legit SCM staff without an L2 matrix — audit who'd be affected first.
4. **SCM per-user identity** — every SCM doc's `created_by`/`approved_by` = one system account (audit trail blind for PI/SI/payments/price-override/GRN/PO/transfers). Fix = Houzs-user → `scm.staff` sync (also unlocks per-salesperson sales reporting + SO venue attribution). Owner previously deferred ("先不用").
5. **#78 back-door SOs** — SO-2606-002/003 carry RM7,999 phantom deposits with 0 payment rows. Need the owner's "paid or not + method" to record / void.
6. **SR-033** (nancyhouzs, active orphan user 47) — real person or test? Owner confirms before any deactivation. (The 5 `SR-035 (test)` reps are already inactive.)
7. Money columns are `int4` (ceiling RM21,474,836.47/column) — fine now; migrate header/landed-cost totals to `bigint` when convenient.

## Lessons
- **DO NOT burst-deploy the Houzs PWA.** 6 rapid deploys churned the Service-Worker cache → the `localeCompare` crash (mismatched cached chunks), not a code bug. Batch into ONE deploy + bump `sw.js` VERSION once. This campaign shipped as **one** deploy.
- "Type-lies" (`string`-typed fields the API can return `null`) are the dominant frontend crash source. The `?? ''` / null-safe `byText` convention should be the default at every sort/filter site.
