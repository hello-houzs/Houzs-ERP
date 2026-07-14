# Houzs ERP — BUG HISTORY

**STANDING RULE (owner, 2026-07-14): every bug that is found and fixed MUST be logged here — no exceptions, everyone.** One entry per bug: **Symptom** (what the user saw) → **Root cause** (the actual defect, traced not guessed) → **Fix** (what changed) → **Ref** (PR / commit / date). Keep entries short. This file exists so the same class of bug is never reintroduced — read it before touching a subsystem, and mine it before shipping. Newest first.

Severity tags: 🔴 critical/high · 🟠 medium · 🟢 low.

---

## 2026-07-14 — Multi-company + performance campaign

### 🟢 Mobile Delivery Planning board didn't refresh the POD / SO screens after a mutation
- **Symptom:** A driver who converts SO→DO, or marks a stop IN_TRANSIT / DELIVERED, on the mobile Delivery Planning board, then opens the mobile POD screen or SO list within ~15-30s, saw the PRE-mutation status/list. Self-healed after the staleTime window.
- **Cause:** The board's shared `invalidate()` helper (`MobileDeliveryPlanning.tsx`) invalidated only its own `["mobile-delivery-planning"]` key. The sibling mobile queries that render the same DO/SO state — `["mobile-do-list-for-pod"]`, `["mobile-pod-detail", id]`, `["mobile-so-list"]` — were never invalidated in the writing tab (BroadcastChannel doesn't deliver to the tab that wrote), so they stayed stale until their own staleTime expired. Same class as HOOKKA's bulk-deliver/POD stale-list bug (desktop was already fully disciplined — it invalidates every sibling key).
- **Fix:** Broaden the shared `invalidate()` to also invalidate `mobile-do-list-for-pod`, `mobile-pod-detail` (prefix-matched, all open details), and `mobile-so-list`. All four board mutations (convert / start / complete / +1) get it uniformly.
- **Ref:** `perf/mobile-virt-systemwide`, 2026-07-14. (Found by a system-wide delivery-cache audit; the two other HOOKKA-flagged risks — CHECK-constraint 500s and silent RM0 3PL rate — were verified NOT present in Houzs.)

### 🟠 Mobile Menu listed nav items the user can't open (render-then-Forbidden)
- **Symptom:** At tablet / narrow widths (`<lg`) and on non-HOUZS mobile, the bottom-bar centre "Menu" sheet listed destinations the user has no access to (Projects, System Health for everyone; Delivery Returns for Sales staff); tapping bounced them to the Forbidden page. The desktop Sidebar and the HOUZS-phone menu hid the same items correctly.
- **Cause:** `MobileTabBar.MenuModal.filterTab` was a hand-copied SUBSET of `Sidebar.filterTab`: it checked only `perm` / `anyPerm` / `hidePerm` and ignored `pageAccess`, `pageAccessFull`, `requireFinanceViewer` and every sales gate (`hideForSales` / `showForSales` / rep gates). A comment claimed the two "stay in lockstep" — they had silently drifted. No data leaked (route guards still render `<Forbidden>` instead of the page), but a denied entry was shown then rejected — the "render-then-deny" that the "off, not hide" rule forbids at the nav layer.
- **Fix:** Extract the full gate logic into a shared `frontend/src/components/navFilter.ts` (`makeNavFilter`); both `Sidebar` and `MobileTabBar` build their menu from it, so a third divergent copy cannot drift again. Mobile also gains the sales-rep `salesRepTo` reachable-click-target override for free. Verified `tsc -b` + `vite build` green.
- **Ref:** `fix/mobile-nav-perm-parity`, 2026-07-14.

### 🟠 Company switch kept showing the previous company's list (cross-tenant stale)
- **Symptom:** Switching company in the top-bar switcher (Houzs↔2990) left the products / SO lists showing the PREVIOUS company's data (Houzs 1326 rows still under 2990); a hard refresh fixed it. Time-good-time-bad (a race).
- **Cause:** The active company is header-based (`X-Company-Id`, read fresh from localStorage per request — so the header AND the backend scoping were correct). But react-query keys don't include the company, so company A's and B's data share one cache entry. `invalidateQueries()` raced (keepPreviousData kept A's rows / an in-flight A response repopulated the shared entry); and a first fix attempt with `queryClient.clear()` was insufficient — clear() empties the cache but does NOT re-trigger a mounted observer to refetch. Proven on prod: a remount (nav away+back) switched correctly to 2990's "2990 AKKA-FIRM MATT", an in-place clear() did not.
- **Fix:** The switch handler now does `window.location.reload()` (a tenant switch is fundamental + rare) so the whole app re-reads the company header on every request. PLUS the new localStorage query-snapshot (`query-persist.ts`) is namespaced by active company so a cold open can't hydrate the other company's list.
- **Ref:** `fix/multicompany-cache-staleness` (#445, snapshot namespace) + `fix/company-switch-reload` (#450, reload), 2026-07-14.

### 🟠 Service-worker cache VERSION bumped by hand → stale shell / branch collisions
- **Symptom:** After some deploys the PWA served a stale shell ("卡旧版本" / 开不进去); parallel branches bumped `sw.js` `VERSION` to the SAME `vNNN` and collided (git: "bump v172 (branch collided with #421's v171 on main)").
- **Cause:** `public/sw.js` used a hand-edited `const VERSION = "houzs-erp-vNNN"`; the cache namespace + activate-purge key off it, so a forgotten or colliding bump left the old shell cache in place.
- **Fix:** Auto-stamp the build id: `sw.js` carries a `__SW_BUILD_ID__` token that a `vite.config` `writeBundle` plugin replaces with a unique per-build id → every deploy yields a new VERSION → the SW's activate step purges the previous caches automatically. No manual bump. Verified: `dist/sw.js` → `const VERSION = "houzs-erp-v176-mrk9db8r"`, 0 leftover tokens.
- **Ref:** `perf/sw-auto-version`, 2026-07-14.

---

## 2026-07-14 — Go-live review batch (4-agent adversarial + FE/BE sweep)

### 🔴 POD signature + photo silently discarded
- **Symptom:** Every proof-of-delivery lost — driver signs + photographs a delivery, DO flips to DELIVERED but `signature_data`/`pod_r2_key` stay NULL; the delivery-agent flags every delivered DO as "missing POD" forever.
- **Cause:** `PATCH /delivery-orders-mfg/:id/status` handler typed its body as `{status?}` and only read `body.status` — it never read/persisted the `signatureData`/`podKey` the mobile POD screen sends.
- **Fix:** Read + persist `signatureData→signature_data` and `podKey→pod_r2_key` in the status handler.
- **Ref:** `fix/review-backend-batch`, 2026-07-14.

### 🔴 Sales Order write routes had NO ownership scope (horizontal privilege)
- **Symptom:** A scoped salesperson could PATCH/delete/repay/reassign **any** SO by enumerable doc_no (reads were correctly scoped to self+downline, writes were not).
- **Cause:** `selfScopedSalesBlocked()` in `mfg-sales-orders.ts` was a no-op stub (`return false`) — its comment wrongly assumed "no self-scoped sellers in Houzs", but `salesScope` returns a real self+downline scope for every non-view-all caller.
- **Fix:** Implement it via `salesDocOutOfScope` (own+downline; director/view-all bypass) on all mutation routes.
- **Ref:** `fix/review-backend-batch`, 2026-07-14.

### 🔴 Service Case "Export CSV" always 500
- **Symptom:** Export CSV on Service Cases returned 500 for everyone.
- **Cause:** `exportAssrCases` selected `c.customer_phone`, but the `assr_cases` column is `phone`.
- **Fix:** `SELECT c.phone AS customer_phone` (CSV field list expects `customer_phone`).
- **Ref:** `fix/review-backend-batch`, 2026-07-14.

### 🔴 "New Delivery Return" (free-entry) was an unsaveable dead-end
- **Symptom:** The standalone New Delivery Return form (and any manual line added to a From-DO return) always 409'd on Save — could never be saved.
- **Cause:** FE offered a free-entry mode (lines with no `doItemId`) but the backend requires every DR line to reference a delivered DO line (`409 do_link_required`).
- **Fix:** FE now requires lines to come from a DO (block save + disable manual add; steer to the From-DO picker).
- **Ref:** `fix/review-frontend-forms`, 2026-07-14.

### 🟠 Sales Director could change a dept member's login email (account-takeover vector)
- **Symptom:** A dept-scoped Sales Director (not a full admin) could rewrite a member's `email`/`email_alias`, then use forgot-password to take over the account.
- **Cause:** The `#435` dept-scoped strip removed role/position/department/manager/password but forgot `email`/`email_alias`.
- **Fix:** Add `delete body.email; delete body.email_alias;` to the scoped-director branch.
- **Ref:** `fix/review-backend-batch`, 2026-07-14.

### 🟠 SCM backend umbrella had no org-field bypass for Sales (FE shows, BE 403s)
- **Symptom:** A code-keyed Sales rep (org position/dept set, no permission-matrix grant) was shown Sales Orders by the FE (`allowSales`) but 403'd by the backend `requireScmAccess` umbrella.
- **Cause:** `requireScmAccess`/`scmAreaGuard` admitted only on `*`/`scm.access`/scm page-access — no `isSalesStaff` bypass, unlike ASSR's `canAccessServiceCases`. FE toast-suppression papered over it instead of aligning.
- **Fix:** Add an `isSalesStaff`-limited bypass to the umbrella for the Sales-Orders area only.
- **Ref:** `fix/review-backend-batch`, 2026-07-14.

### 🟠 Variant completeness bypassable via line routes on a processing-dated SO
- **Symptom:** After a Processing Date is set (which requires complete variants), a later PATCH to a line could blank its fabric — leaving an incomplete processing-dated SO.
- **Cause:** `findIncompleteVariantLines` ran only on create + header-PATCH, not on the item POST/PATCH routes.
- **Fix:** Re-check variant completeness on the line routes when `internal_expected_dd` is set.
- **Ref:** `fix/review-backend-batch`, 2026-07-14.

### 🟠 Service-case co-assignee (`assigned_to_2`) sees a case in the list but 404s on open
- **Symptom:** A secondary assignee sees the case row in the list, clicks it, gets 404.
- **Cause:** List scope included `assigned_to_2` but the detail + sub-route scope checks considered only `created_by`/`assigned_to`.
- **Fix:** Add `assigned_to_2` to the detail + `caseInCallerScope` checks.
- **Ref:** `fix/review-backend-batch`, 2026-07-14.

### 🟠 Consignment Order missing the sofa-mix pre-guard (raw 400 after Save)
- **Symptom:** A sofa+bedframe consignment cart only failed after clicking Save (backend `so_sofa_no_other_main`); SO pages block it instantly.
- **Fix:** Add `hasSofaMixConflict`/`SOFA_MIX_MESSAGE` pre-save guard to ConsignmentOrderNew (parity with SO).
- **Ref:** `fix/review-frontend-forms`, 2026-07-14.

### 🟠 Misleading required `*` markers on doc forms
- **Symptom:** Phone / Email / Receive-Date / Supplier-Invoice-# showed a red `*` (some with inert HTML `required`) but neither FE nor BE enforced them — operators thought fields were mandatory.
- **Fix:** Remove the `*`/`required` from the non-enforced fields across DO/SI/CN/CR/DR/GRN/PC-Receive/PI New forms (kept legitimately-required stars).
- **Ref:** `fix/review-frontend-forms`, 2026-07-14.

### 🟢 Copy/consistency
- Processing-date-gate reason still said "50%" on the PATCH-header path while the gate is 30% → fixed copy + comment.
- `isSalesUser` (BE `/^Sales /i`, trailing space) vs `isSalesStaff` (FE `/^sales/i`) disagreed on "Salesperson"/"Sales-Executive" → aligned BE to FE.
- Sales-Director member edit checked primary dept only while the list included secondary (`user_departments`) → PATCH gate now accepts `user_departments`.
- Mail-Center Sales-Director dept match was a loose bidirectional substring ("Presales"/"Wholesales") + generic dept scope derived dept from an owned mailbox → tightened.
- `assr` `/cost-suggestion` + `/customer-history` were `service_cases.read`-gated → over-restricted a scoped Sales viewer of a case → switched to `requireServiceCaseAccess` + in-scope.
- **Ref:** `fix/review-backend-batch` / `fix/review-frontend-forms`, 2026-07-14.

---

## 2026-07-14 — Sales access model + SO-form FE/BE (earlier same night, all SHIPPED)

- 🔴 **Cross-salesperson finance leak** — Sales-Invoice / Consignment / Delivery-Order **detail + `/payments`** reads were unscoped (only the LIST query got the new own+downline scope). Any scoped rep could enumerate ids and read another rep's invoice header + full payment history. Fix: `salesDocOutOfScope` on every detail/sub-read. (PR #417)
- 🔴 **Company P&L + activity-feed leaked finance to non-director Sales** — `finance.ts /pnl` gated only on `projects.read`; `/:id/activity` replayed payment_status/finance markers the detail GET blanks. Fix: `financeHiddenForUser` gate + drop finance rows from activity. (PR #397)
- 🟠 **Home dashboard "Forbidden" toast storm** — `Overview.tsx` fired `/api/assr/summary` + `/api/projects/summary` for every user; a Sales rep without the perm got a Forbidden toast on every load. Fix: off-not-hide `enabled: can(perm)` gate. Also `/api/notifications` was matrix-gated (should be personal) → widened. (PR #421)
- 🟠 **`useQuery(fetcher, {enabled})` silently ignored** — the hook's options is the **3rd** arg (2nd is deps); the gate was passed as deps and never applied (+ broke `tsc -b`). Fix: `useQuery(fetcher, [], {enabled})`. (PR #417)
- 🟠 **My Cases unreachable for Sales** — nav showed it (dept bypass) but the `/my-cases` route's `PageGuard` denied on the matrix. Fix: `allowSales` bypass on the route. (PR #417)
- 🟠 **Sales Director didn't see all Sales Orders** — SO view-all keyed off the `scm.so.view_all` permission, not the director position (unlike cases/finance). Fix: `canViewAllSales` OR-ins `isDirectorUser`. (PR #410)
- 🟠 **Salespeople couldn't amend their own locked SO** — submit gate required `scm.amendment.create` (not granted to reps). Fix: admit `isSalesCaller` + scope to own SO via `salesDocOutOfScope`. (PR #423)
- 🟠 **`isSalesStaff` failed OPEN** on non-space titles ("Salesperson") → treated as unrestricted (would see Delivery Returns/Finance). Fix: key off `department_name` + broadened regex. (PR #417)
- 🟠 **Projects list open to all** — the list lacked the sales-attendee arm the calendar/detail use, so an attendee saw a project on the calendar but 404'd opening it. Fix: add the attendee arm to the list read gate. (PR #425)
- 🟠 **Fabric/Seat marked required with no Processing Date** — FE `SoLineCard` rendered the `*`/red-border unconditionally + mobile blocked Save on Draft-vs-Confirm, but the backend only requires variants when a Processing Date is set. Fix: FE visual + mobile block now gate on `!!processingDate` (matches BE). (PR #441)
- 🟠 **Special add-ons showed nothing for un-configured models** — FE offered `special_addons ∩ model.allowed_options.specials`, so an empty model pool ⇒ "No specials configured", while the backend accepts/prices any picked special when the pool is empty. Owner rule: specials are uniform (default all on). Fix: empty pool ⇒ offer ALL; non-empty ⇒ intersection. (PR #441)
- 🟠 **Processing-date payment gate used 50% (2990 rule) on Houzs** — Houzs requires 30%. Fix: new `PROCESSING_DATE_PAID_THRESHOLD=0.30` (kept `PROCEED_PAID_THRESHOLD=0.5` for the other gate). (PR #441)
- 🟢 **Raw 400s** for `so_sofa_no_other_main` + `processing_date_unpaid` → curated one-sentence messages via `humanApiError`. (PR #441)
- 🟢 **Agent Console** `/review` scorecard was a stub, Document agent had no AI-focus, `recentErrors`/run-history were computed but never rendered → completed (advisory-only, no red-line). (PR #406)

---

## Earlier (2026-06 → 07, backfilled 2026-07-14 from memory / COE docs / git)

*Historical entries reconstructed after the fact — dates approximate, refs to the COE docs where a full write-up exists.*

### Infrastructure / deploy / DB
- 🔴 **App-wide intermittent 500 "Something went wrong"** — `middleware/db.ts` attached the per-request DB client by **mutating the shared isolate-level `c.env`** (`c.env.DB = …`); under concurrent requests one request ran queries on another's socket → `Cannot perform I/O on behalf of a different request`, which matched no error classifier and fell through to a generic 500. Worse under load. Fix: stop mutating shared env; per-request client via `c.set`. Full write-up: `docs/system-foundation-coe.md`.
- 🔴 **"Failed to fetch" storms** — Hyperdrive **cold-start (~12s)** + a 15-connection cap; bursts exhausted the pool. Fix: `pool_size` 40 + GET retry/backoff. See `docs/api-fetch-hardening-coe.md`.
- 🔴 **App-wide 500s after D1→Postgres migration** — the D1→PG move **dropped column DEFAULTs** (e.g. `active DEFAULT 1`) on ~10 tables, so inserts that relied on them 500'd. Fix: `ALTER … SET DEFAULT` per table.
- 🔴 **Mass 500s / "Usage limit exceeded"** — Cloudflare **FREE Workers plan** daily caps hit under real load. Fix: upgrade to Workers Paid. (Also: GitHub Actions budget block on a private repo → made repo public = free/unlimited.)
- 🟠 **Post-deploy "database briefly unavailable" 503** — Hyperdrive cold-start after each deploy; self-heals, but **burst-deploying multiplies it**. Standing rule: don't burst-deploy. (`pg.ts` is frozen.)
- 🟠 **App-wide 503 + deploys fail `pg-migrate` "password auth failed" while project Healthy** — Supabase **Shared Pooler (Supavisor) outage**; fix = Restart project.
- 🟠 **"Version 跑回 old" after deploy** — manual `wrangler` deploy colliding with CI deploy. Fix: let CI own deploys; scoped-diff on isolated worktrees.
- 🟠 **PWA "开不进去" after rapid deploys** — service-worker cache churn. Recover by bumping `sw.js` VERSION; don't burst-deploy the PWA.
- 🟠 **Schema change deployed but broke prod** — Houzs keeps TWO migration trees (`migrations/` D1 + `migrations-pg/` prod); a change in only one slips through until deploy runs `pg-migrate`. Rule: update BOTH.

### Data / postgres.js quirks (the #1 recurring class)
- 🔴 **Rows read as `undefined` / features silently empty** — `postgres.js` **camelCases** returned columns while PostgREST/raw SQL uses snake_case; code reading one shape got null. Fix: dual-read `r.camelCase ?? r.snake_case`. This is the single most common Houzs bug — check it first when data "isn't there".
- 🔴 **SCM stock never moved after the 2990 SCM port** — the port **dropped all PL/pgSQL functions + triggers**, so ledger/FIFO movement logic was gone. Fix: restored 12 functions + 2 triggers (pin `search_path=scm`).
- 🟠 **PG `timestamp` columns rejected `datetime('now')`** — SQLite idiom carried over; must be a text/ISO timestamp on PG.
- 🟠 **Variant columns dropped on SO→DO / DO→SI conversion** — carry-over logic omitted variant cols; downstream docs lost fabric/seat. Fix + backfill.

### Frontend
- 🔴 **Whole-page "Something went wrong" (route crash)** — the #1 cause is a component reading `{success,data}` **without unwrapping `.data`** (`api.get` does NOT unwrap). Route `ErrorBoundary` (`RouteFallback.tsx`) now resets on nav (PR #371).
- 🟠 **CI "tsc false-clean" in worktrees** — a frontend worktree without `node_modules` reports a false-clean local `tsc`; only CI's `tsc -b && vite build` is authoritative. Verify via CI, not local.
- 🟠 **Vendored SCM fetch hit the wrong base URL** — `VITE_API_URL` inlined empty at build; `?? worker` kept the empty string. Fix: use `|| worker`.
- 🟠 **Cloudflare Pages `_headers` over-broad** — Pages MERGES rules; keep only `/index.html` + `/assets/*` or headers leak to all routes.

### SCM correctness (mostly caught pre-Houzs on 2990, verified on Houzs)
- 🟠 **GRN defaulted warehouse to CHINA-transit** → false MRP alarms. Fix + GRN 防呆.
- 🟠 **Sofa drop-ship DO missing the 7 corner-holes line** → under-built. Fixed Houzs (PR #349).
