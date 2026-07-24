# COE — Supplier / product detail 404s ("could no longer be found") after the 2990 cutover

**Correction of Error.** Follows the shape of `system-foundation-coe.md` and
`api-fetch-hardening-coe.md`: what staff saw, the root cause traced with evidence,
the fixes, what the audit **ruled out**, what is deferred, and the lessons.

## Date · Trigger

**2026-07-24.** The owner (Super Admin), working across both companies after the
2990 → Houzs cutover, opened a supplier detail page and got a red wall:

> **Supplier not found or failed to load.** That item could no longer be found —
> it may have been changed or removed. Please refresh.

Console showed `GET /api/scm/suppliers/<id> → 404` and `.../<id>/scorecard → 404`.
In the owner's words: *"系统审查一下还有没有这种类型的问题？为什么最近会一直出现这种问题呢？"*
— review the system, are there more of this type, and why does it keep happening
recently. The message implied a supplier record had been lost, which is the kind of
thing that makes staff stop trusting the system.

## Root cause — traced with evidence, never guessed

The tool that proved it: **`diag-supplier-reachability`** (read-only workflow, run
2026-07-23, `backend/scripts/diag-supplier-reachability.mjs`). It reported, against
the live production database:

- Suppliers by company: **36** in company 1 (HOUZS), **13** in company 2 (2990),
  **0** with a NULL company_id.
- `supplier_material_bindings`: **511** rows, **0 orphan** (0 cross-company, 0
  dangling / no supplier row).
- Every scm base table carrying `supplier_id` — purchase_orders (44), grns (25),
  purchase_invoices (23), sofa_combo_pricing (63), purchase_consignment_receives
  (4), supplier_material_bindings (511): **0 orphan each**.
- Top-20 orphan supplier_ids: *"No orphan supplier references — every stored
  supplier_id resolves within its own company."*

So the data is clean. The 404 is the **multi-company scope on a by-id READ**:

- `suppliers.get('/:id')` and `/:id/scorecard` wrap their lookups in
  `scopeToCompany(...)` → `.eq('company_id', <active>)`. That is the correct
  isolation boundary (the DB client is service-role; this app-layer predicate IS
  the tenant fence — see `scm/lib/companyScope.ts`).
- When the caller reaches a supplier that belongs to the **other company they are
  allowed to see**, the scoped lookup misses and the route returns a bare
  `{ error: 'not_found' }`. `humanApiError` (frontend `authed-fetch.ts`) turns a
  bodyless 404 into "could no longer be found."
- How the owner reaches the other company's supplier without switching: a
  **bookmark** to a 2990 supplier while the tab is on HOUZS; a **second window**
  (each window owns its company — `lib/activeCompany.ts`, owner ask 2026-07-23); or
  a **durable-default tab** that booted into HOUZS. The company switcher path itself
  is safe — an in-place switch does a full reload (`lib/query-persist.ts`), so no
  stale in-memory cross-company cache survives.

**Why "recently":** multi-company scoping is new. Before the cutover there was one
company, so a by-id lookup never missed on a company boundary. The moment a second
company's suppliers existed and the owner was granted both, every by-id detail GET
became able to 404 a record that is present and that the caller may see.

## Fixes shipped

| PR | Change | Effect |
|---|---|---|
| #1157 | `diag-supplier-reachability` read-only workflow + script | Produced the evidence above; refuted the data-corruption theory without a human touching the prod DSN. |
| #<this> | `detailMissResponse(c, probe, noun)` helper in `companyScope.ts` | On a per-company by-id miss, re-looks-up the id **widened to the caller's ALLOWED companies** (`scopeToAllowedCompanies` — never beyond). Resolves in another allowed company → `{ error: 'in_other_company', companyId, companyCode, message }`; else a plain `not_found`. Leaks nothing: a single-company user's allowed set can't reach the other company, so they still get not_found. |
| #<this> | Applied to `suppliers.get('/:id')` + `/:id/scorecard` and `mfg-products.get('/:id')` | The three most-likely cross-company detail surfaces (supplier + the Products/Fabric area the owner was in) now name the company instead of implying loss. |
| #<this> | `SupplierDetail.tsx` renders `in_other_company` as a calm banner + "Switch to `<company>`" button | One click sets this tab's company and reloads onto the record — the switcher's own pattern. Replaces the red "not found" wall. |

Isolation is unchanged. You still cannot **view** the other company's supplier
under the active company's books — the fix tells you where it lives and offers the
switch. It does not widen the read.

## What the audit RULED OUT

- **"The 2990 import created orphan / cross-company supplier_id references."** This
  was the working hypothesis carried into 2026-07-24 (and written that way in an
  earlier session summary). The diagnostic **refuted it**: 0 orphan, 0
  cross-company, 0 dangling across all 8 tables; 0 NULL-company suppliers. No data
  cleanup was needed and none was done. Chasing a data fix here would have been
  wasted work against a clean database.
- **"A supplier was actually deleted."** No — the same id resolves fine once the
  matching company is active; a genuine delete would miss in every company.
- **"The company switcher leaves a stale cross-company cache."** Ruled out by
  reading `lib/query-persist.ts` and `lib/activeCompany.ts`: an in-place switch
  reloads the page (dropping the in-memory query cache) and snapshots are bucketed
  per `(user, company)`. The staleness vector is cross-window / bookmark, not the
  switcher.
- **"The 'restricted to nothing' (match-nothing) scope state is hitting the
  owner."** Ruled out by reading `companyContext.ts`: for a Super Admin with both
  companies active, the middleware always resolves an active company (at worst
  `pool[0]`), so `scopeToCompany` never degrades to `.in('company_id', [])` for the
  owner. That state is reserved for a user whose every grant points at an inactive
  company.

## Deferred

- **The rest of the per-company detail-GET family.** SO / DO / payment-voucher /
  delivery-return / consignment detail GETs share the exact class (`scopeToCompany`
  → `.maybeSingle()` → `not_found`). They are lower-incidence (doc-number-keyed,
  navigated within a company's own list, and some are mirrored `2990-` docs with
  their own guards), so they were left for adoption of `detailMissResponse` as each
  module is next touched, rather than a single high-risk sweep of four
  multi-thousand-line routers. Owner decision: acceptable, tracked here + in
  BUG-HISTORY. **WRITE / amend paths are deliberately NOT changed** — answering
  `NOT_THIS_COMPANY` on an attempt to edit another company's document is correct.

## Lessons

1. **A clean-data diagnostic is worth more than a plausible data-fix.** The whole
   incident was blamed on import orphans; one read-only workflow proved the data was
   pristine and redirected the fix from the database to the API's error shape.
   Verify the data claim against the live DB before writing a migration — the same
   lesson `system-foundation-coe.md` records.
2. **A bare `not_found` is a lie when the record exists.** In a multi-tenant app,
   "I can't find it in your current tenant" and "it does not exist" are different
   facts, and conflating them reads as data loss. Any by-id read that is tenant-
   scoped should be able to say *which* tenant the record is in — for callers
   allowed to know.
3. **Isolation and honesty are not in tension.** The fix keeps the read scoped
   (no cross-company view) while telling the operator where the record lives and
   offering the switch. Widening the read would have been the wrong fix; a better
   404 was the right one.
