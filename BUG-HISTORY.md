# Houzs ERP — BUG HISTORY

**STANDING RULE (owner, 2026-07-14): every bug that is found and fixed MUST be logged here — no exceptions, everyone.** One entry per bug: **Symptom** (what the user saw) → **Root cause** (the actual defect, traced not guessed) → **Fix** (what changed) → **Ref** (PR / commit / date). Keep entries short. This file exists so the same class of bug is never reintroduced — read it before touching a subsystem, and mine it before shipping. Newest first.

Severity tags: 🔴 critical/high · 🟠 medium · 🟢 low.

---

## 2026-07-14 — Multi-company + performance campaign

### 🟠 Mobile consignment + suppliers lists silently truncated past their fetch cap (10x gap missed by the pagination sweep)
- **Symptom:** On the phone, the three Consignment lists (Orders/Notes/Returns) and the Suppliers list would silently stop at the newest ~500 (suppliers ~200) rows — the desktop equivalents were already server-paginated (#516/#529) and showed everything, so phone and desktop disagreed once a list grew past the cap. The exact 100x-truncation class the campaign set out to kill, left open on mobile.
- **Root cause:** `MobileModuleList` only truly server-windows endpoints listed in its `SERVER_PAGINATED` set; everything else falls back to a one-shot `limit=500/200` fetch + client-side paging (fine for the loaded rows, blind past the cap). The sweep added the five doc lists (DO/SI/GRN/PO/PI) to that set but never added consignment/suppliers, even though their backends had already gained `page/pageSize/total` (page-param opt-in). So `buildUrl` never sent `page`, the handler stayed on the legacy limit branch, and rows past the cap never loaded.
- **Fix:** Added `/consignment-orders`, `/consignment-notes`, `/consignment-returns`, `/suppliers` to `SERVER_PAGINATED` (verified each backend returns `{ <listKey>, total, page, pageSize }` with the exact key the mobile config reads). `buildUrl` now drops `limit` and sends `page/pageSize`, so the IntersectionObserver infinite-scroll pages the whole table. `delivery-returns` / `purchase-returns` deliberately left out — their list handlers are NOT paginated (return no `total`), so opting them in would collapse each to a single 30-row page; they stay on the bounded single fetch (returns are inherently low-volume) until their backends paginate.
- **Ref:** `perf/mobile-consignment-suppliers-paging`, 2026-07-15.
### 🟢 Residual month-name dates on three mobile screens (missed by fix/mobile-format-shared)
- **Symptom:** After `fix/mobile-format-shared` was supposed to converge all mobile date rendering, three screens still showed month names ("14 Jun 2026") instead of numeric DD/MM/YYYY and could render the wrong day on an off-GMT+8 device: SO-detail locked fields, Service Case dates/timestamps, and the generic mobile module list.
- **Cause:** That PR missed three hand-rolled helpers that re-implemented `new Date(d) + toLocaleDateString({ month: "short" })` — `MobileSODetail.dl`, `MobileServiceCase.dm`/`dtm`, `MobileModuleList.dm`. Bare `new Date()` on a bare SQLite timestamp parses as UTC then renders in the device zone (TZ shift); `{ month: "short" }` violates the numeric-date house rule.
- **Fix:** Delegated all four to the shared `lib/utils` `formatDate`/`formatDateTime` (UTC-tags bare timestamps, formats date-only verbatim, emits numeric DD/MM/YYYY). Helpers kept as thin aliases so no call sites changed (42 in MobileModuleList). Surfaced by a systematic desktop↔mobile logic-drift audit.
- **Ref:** `refactor/mobile-shared-logic-converge`, 2026-07-14.
### 🟠 Mobile SO detail showed the amendment banner on a SHIPPED/terminal order (DRIFT-A)
- **Symptom:** On the phone, opening a SHIPPED / DELIVERED / INVOICED / CLOSED (or otherwise hard-locked) Sales Order that still carried a stale `amendment_eligible` flag rendered the amber "On order to the supplier — tap Edit to request an amendment" banner, inviting an amendment on an order that is past editing. Desktop never showed it.
- **Cause:** `MobileSODetail` computed `amendmentEligible = Boolean(h.amendment_eligible)` — a hand-rolled copy that dropped the `&& !isLocked` guard the desktop `SalesOrderDetail` has (`Boolean(header.amendment_eligible) && !isLocked`). The two implementations had drifted.
- **Fix:** Extracted the gate into the shared pure module `frontend/src/vendor/scm/lib/so-detail-gates.ts` (`amendmentEligible(header, isLocked)` = `Boolean(header.amendment_eligible) && !locked`) and wired BOTH pages to it, so a hard-locked SO is never amendment-eligible on either platform.
- **Ref:** `refactor/so-detail-shared-hooks`, 2026-07-14.
### 🟠 SO processing-lock computed against the device clock, not the Malaysia day (DRIFT-B)
- **Symptom:** The SO PROCESS lock (line items freeze once a proceeded order's processing day has passed) flipped at the wrong instant on a device whose OS timezone was not GMT+8 — a proceeded SO could still show its lines as editable (or lock a day early) around local midnight vs Malaysia midnight, and desktop and mobile could disagree.
- **Cause:** Both `SalesOrderDetail` (two copies) and `MobileSODetail` derived "today" with `new Date().toLocaleDateString('en-CA')` — the *device's* local calendar date — then string-compared it to `internal_expected_dd`.
- **Fix:** The shared `procLockActive(header)` in `so-detail-gates.ts` compares against `todayMyt()` (the shared Asia/Kuala_Lumpur calendar day, `vendor/scm/lib/dates.ts`). Both desktop procLock copies collapsed to the one shared fn; mobile wired to it too.
- **Ref:** `refactor/so-detail-shared-hooks`, 2026-07-14.
### 🟠 Mobile status change skipped audit-log + status-changes invalidation and had no optimistic update (DRIFT-D)
- **Symptom:** Confirming / cancelling an SO from the phone updated the row, but the History timeline + status-change dependents didn't refresh, and the status pill didn't update optimistically (a beat of stale UI). Desktop did all three.
- **Cause:** `MobileSODetail.setStatus` was a raw inline `PATCH /:docNo/status` that only invalidated the (mobile-private) detail + a dead `mobile-so-list` key — it never invalidated `mfg-sales-order-audit-log` / `mfg-sales-order-status-changes` and had no `onMutate` optimistic write, unlike the shared `useUpdateMfgSalesOrderStatus`.
- **Fix:** Mobile now calls `useUpdateMfgSalesOrderStatus` (and reads via the shared `useMfgSalesOrderDetail` so it lives in the same query-key namespace) — inheriting the optimistic update and the audit-log + status-changes invalidations for free.
- **Ref:** `refactor/so-detail-shared-hooks`, 2026-07-14.
### 🟠 Sales Director 403 / silently-empty on the PMS project detail page
- **Symptom:** A Sales Director (or Sales PIC) opening a project/Exhibition detail saw the **Sales** section render and then 403 (no sale rows), and the **Setup & Dismantle** logistics crew dropdowns render **empty** (no drivers/helpers, no lorry plates) — the values they were supposed to be able to view never loaded.
- **Cause:** Split authorization. The project page authorises the PAGE via the org-POSITION tier (`services/pmsAccess.getPmsAccess` → a Sales Director resolves to the `DIRECTOR` tier, so every section RENDERS), but the inner data calls authorise via the flat page-access / permission MATRIX — which a POSITION is never backfilled into (`services/pageAccess.ts`). So `GET /api/sales/entries` (`requirePageAccess("sales")`), `GET /api/fleet/staff` (`requirePermission("users.read")`) and `GET /api/scm/lorries` (behind `requireScmAccess`) all 403'd for a Sales Director whose matrix rows were empty. The sales list surfaced the 403; the crew dropdown reads were swallowed by `.catch(()=>{})` into blank required controls.
- **Fix:** CODE-based sales/director authz on the three reads (never matrix rows): new additive guards `requirePageAccessOrSalesView("sales")` (sales list) and `requirePermissionOrSalesView("users.read")` (fleet staff), plus a narrow GET-only `/api/scm/lorries` exception inside `requireScmAccess` — each passes if the OLD check would pass OR the caller is Sales/director by STABLE ORG FIELD (`pmsAccess.isSalesUser`/`isDirectorUser`), reads only. Logistics is READ-ONLY for Sales: the project PATCH strips `setup_crew`/`dismantle_crew` for any `isSalesUser`, and the FE crew editor (`LogisticsCrewSection`/`PhaseCrewEditor`) renders disabled with actions hidden. FE `enabled:`-gates the sales query on the same capability (matrix `sales` ≥ partial OR `isSalesStaff`/`isDirectorUser`) and returns null otherwise (off, not hide) so a genuinely-restricted user never render-then-403s. Also reworded the "Sales Attending" empty-state hint, which wrongly pointed at the Sales department in User Management instead of the active Sales Reps master the picker actually reads.
- **Ref:** `fix/pms-project-sales-access`, 2026-07-14.
### 🟠 Mobile shell hand-rolled its own nav gating → hidden-item leaks + ungated tab queries (403)
- **Symptom:** On the phone shell (`mobile/MobileApp.tsx`, no react-router → no PageGuard), a restricted user could see menu entries the desktop hides, and the three bottom tabs (Orders / Service / Calendar) mounted their screens for EVERYONE — firing reads the user has no access to: `MobileServiceCase` `GET /api/assr`, `MobileCalendar` `GET /api/projects/calendar/events` + `/brands` + `/sections-distinct` + `/organizers`. Each 403'd on mount (the "off, not hide" leak).
- **Cause:** `MobileApp.visible()` was a HAND-COPY of the shared `components/navFilter` filter that omitted three gates — `pageAccessFull`, `hidePerm`, `requireFinanceViewer` — and returned `true` on the sales-bypass BEFORE reaching them (drift trap). The bottom tabs had no capability gate at all, and the tab screens' queries had no `enabled:`.
- **Fix:** Extracted a shared per-node predicate `makeNavVisible` in `components/navFilter.ts` (the recursive `makeNavFilter` used by the desktop Sidebar + MobileTabBar now builds on it). `MobileApp` filters its menu + bottom tabs through that same predicate — the hand-rolled `visible()` is gone. Each content tab mounts its screen only when the user can reach the destination (else a locked placeholder), and the leaked queries got `enabled:` gated on the exact desktop capability (`/api/assr` → `service_cases.read` OR Sales; calendar reads → `projects.calendar`). The two "+" FABs (desktop `QuickActionsFAB` + mobile `MobileSalesOrders`) now share one `quickActionAccess` helper so the "New Service Case includes Sales staff" rule lives in one place.
- **Ref:** `fix/mobile-nav-gating-shared`, 2026-07-14.
### 🟢 Mobile dates could show the wrong day (off-by-one) on an off-zone device
- **Symptom:** On the mobile layer, a `YYYY-MM-DD` date (SO dates, delivery dates, PMS project dates, recorded-payment dates, search-result dates, etc.) could render one day off versus the desktop app when the phone's OS timezone was not GMT+8 — e.g. an SO dated `2026-07-14` showing `13/07/2026`.
- **Cause:** ~7 mobile files each re-implemented their own `dm()`/`dmy()` date helper with bare `new Date(d)` + `toLocaleDateString`. `new Date("2026-07-14")` is parsed as UTC midnight and then rendered in the *device's* local zone, so any device west of GMT+8 rolled the calendar date back a day. These local helpers bypassed the shared, TZ-aware `formatDate` (which pins display to `APP_TZ = Asia/Kuala_Lumpur` and formats date-only strings verbatim). Money was also re-rolled (`÷100 + toLocaleString`) in ~8 files instead of the shared `fmtCenti`/`formatCurrency`.
- **Fix:** Converged the mobile money + date formatting onto the shared helpers (`lib/utils` `formatDate`/`formatCurrency`, `lib/scm` `fmtCenti`). Every `dm()`/`dmy()` now delegates to `formatDate`; display money uses `fmtCenti` (centi) / `formatCurrency` (ringgit), unit-matched per call site. Form-value serializers (MobileNewSO `fromCenti`, MobileScan payment/price prefill) were intentionally left as bare number strings — they must stay prefix-free so `num()`/`toCenti` can parse them back.
- **Ref:** `fix/mobile-format-shared`, 2026-07-14.
### 🟠 Mobile SO couldn't amend a processing-locked order (forced back to desktop)
- **Symptom:** A salesperson on mobile opening a processing-locked (already-PO'd) Sales Order saw its line items rendered read-only with "line items can no longer be changed" and **no way to raise an amendment** — the exact thing desktop `SalesOrderDetail` supports. To change a qty/spec/price on an ordered SO they had to abandon mobile and reopen it on a desktop. There was also no way to VIEW a pending amendment's before/after or run its supplier-confirm / approve gates from the phone.
- **Cause:** `MobileNewSO` conflated the two lock reasons into one `lineEditingBlocked = lineLocked || procLocked` and always fell to read-only when `procLocked`, ignoring the server's **`amendment_eligible`** flag (which distinguishes "processing-locked but still amendable" from "hard-locked"). `MobileSODetail` never read `amendment_eligible` / `has_open_amendment` / `open_amendment` (all already on the `/mfg-sales-orders/:docNo` GET) and had no amendment UI at all — a mobile-only parity gap, not a backend defect.
- **Fix:** (1) `MobileNewSO` now derives `amendmentMode = amendment_eligible && !lineLocked && !hasOpenAmend`; in that mode the existing mobile line editor stays **enabled** and Save builds a `CreateAmendmentLine[]` (ported `buildAmendmentLines`: QTY/SPEC/ADD/REMOVE + `old_snapshot`) and POSTs via the vendored `useCreateAmendment` instead of a direct item PATCH. (2) `MobileSODetail` reads the amendment flags, keeps **Edit live** on an amendment-eligible SO, shows a **pending-amendment banner** with a status pill + permission-gated *supplier-confirm* / *approve-SO* actions (`useSupplierConfirm` / `useApproveSo`), and a **View changes** diff sheet (`useAmendmentDetail`, `old_snapshot` vs `new_*`). All logic reused from `vendor/scm/lib/so-amendment-queries.ts` — **no backend change, no migration, no third editor copy.** Needs a staging pass with a real Sales login.
- **Ref:** `feat/mobile-so-line-edit-amendment`, 2026-07-14.
### 🟠 Mobile document status labels differed from desktop (two-track humanizer)
- **Symptom:** The SAME document read a different status on the phone vs the computer. The mobile generic list showed the raw enum title-cased — SUBMITTED → "Submitted" (desktop "Confirmed"), GRN/PI/PR POSTED → "Posted" (desktop "Confirmed"), SI SENT → "Sent" (desktop "Issued"), DO DISPATCHED → "Dispatched" (desktop "Shipped"). Also a dead Purchase-Orders "Open" filter chip (no such PO status → always empty), drifted SI payment-method labels ("Bank Transfer" / "Card / Merchant"), and a hardcoded supplier-currency list.
- **Cause:** `MobileModuleList.tsx` had its OWN naive `statusLabel` humanizer (title-case the raw enum) instead of the canonical `vendor/scm/lib/status-pill.ts` map that all 27 desktop scm-v2 lists use. The PO chip filtered `status==="open"` but `PoStatus` is DRAFT/SUBMITTED/PARTIALLY_RECEIVED/RECEIVED/CANCELLED. `SI_METHODS` was hand-written; the supplier form's currency `<select>` was `[MYR,RMB,USD,SGD]` instead of the `/currencies` master.
- **Fix:** Route every document pill through the shared `statusLabel(docType, status)` + `resolveStatusPill` (badge colour now driven by the canonical tone, not a label guess), threading each module's own `docType` (do/si/grn/po/pi/pr/dr/stockTransfer/stockTake). The old humanizer is renamed `humanize` and kept only for non-document fields (product category, account type, user status) that have no canonical map. PO chips now mirror desktop (All / Outstanding = SUBMITTED∪PARTIALLY_RECEIVED / Draft). `SI_METHODS` is built from `PAYMENT_METHOD_CODES` + `PAYMENT_METHOD_DEFAULT_LABELS` (value stays the endpoint's code). Supplier currency uses the form's async `optionsSource` against `/currencies?active=true`.
- **Ref:** `fix/mobile-status-pill-shared`, 2026-07-14.
### 🟠 Desktop Scan Order silently dropped the backend duplicate-slip warning
- **Symptom:** An operator on the DESKTOP Sales Orders "Scan Order" modal could re-scan a slip that had already been entered and get no warning at all — the New SO form just opened again, letting them create a second order for the same slip. The mobile Scan screen already surfaced this; desktop did not.
- **Cause:** `/scan-so/extract` returns a `duplicate` ({ docNo, rule }) field (shared `findDuplicateSo`), but the desktop modal's `ExtractResp` type omitted it and the extract handler navigated to the New SO form immediately on success, so the flag was never read. Desktop also handled only ONE order per session and used a single undifferentiated dropzone (no labeled slip/receipt split).
- **Fix:** Frontend-only, `ScanOrderModal.tsx`: added `duplicate` to `ExtractResp`; on a flagged duplicate the built prefill is HELD and an amber "possible duplicate of <doc no>" banner shows with an "open anyway" action (non-blocking, owner reviews — same policy as mobile). Also split the dropzone into labeled "Order slip" + optional "Payment receipt" slots and added an "Add another order" batch mode that reuses the SAME `/scan-so/enqueue` + `/scan-so/jobs` endpoints mobile uses (per-order 409 `duplicate_slip` refusals surface inline). No backend change. Job helpers factored to shared `vendor/scm/lib/scan-jobs.ts` (no third copy).
- **Ref:** `feat/desktop-scan-parity`, 2026-07-14. Needs staging test.
### 🟠 Desktop slip-scan OCR reconciled to the catalog, mobile didn't → mobile scanned values didn't match the dropdowns
- **Symptom:** Scanning a handwritten sale-order slip on desktop pre-filled the New SO form correctly (venue, customer/building type, state, payment method matched the maintained dropdowns), but the SAME slip scanned on mobile produced a draft/form whose Customer Type / Building Type / State came up blank or wrong — "mobile OCR doesn't work".
- **Cause:** The server-side OCR extraction is shared, but the CLIENT-SIDE mapping of the extract result into the New SO prefill was DUPLICATED and had drifted. Desktop (`ScanOrderModal.buildPrefill`) reconciled the raw OCR values against the live catalog (venue text → venue id, dropdown VALUE snap, SOFA specialCodes, a structured bank/plan/One-Shot payment block). Mobile (`MobileScan.buildPrefill`/`extractPayment` + `MobileNewSO`) took the raw strings and then RE-GUARDED customer/building type + state against STALE hardcoded arrays (`CUSTOMER_TYPES`/`BUILDING_TYPES`/`STATES`) that no longer matched the maintained `so_dropdown_options` / `my_localities` — so a valid server-matched value the stale list didn't contain was silently dropped.
- **Fix:** Extracted the mapping into ONE shared pure reconciler `frontend/src/vendor/scm/lib/scan-prefill.ts` (`reconcileScanPrefill` + `reconcilePayment` + `resolveVenueId`) that snaps every value against the LIVE catalogs (passed in via `optionsOrFallback` / `FALLBACK_OPTIONS` / `distinctStates` / `useVenues`) NON-destructively. Both desktop `ScanOrderModal` and mobile `MobileScan`/`MobileNewSO` now build their prefill through it (desktop output is byte-identical — it was the reference); mobile's stale static-list guards were removed so it trusts the reconciled value. A future OCR-mapping fix now lives in one file for both platforms.
- **Ref:** `feat/shared-scan-prefill-reconciler`, 2026-07-14.

### 🔴 "Forbidden: missing …" toast storm reappeared for restricted (Sales) users
- **Symptom:** A restricted user (e.g. a Sales account) opening certain pages (a PMS/project Exhibition detail) saw a STACK of red toasts — "Forbidden: needs view access to scm.transportation.drivers", "needs partial access to sales", "missing users.read", "missing projects.write", plain "Forbidden", etc. — one per background query they lack access to. This is the "off, not hide" storm the owner explicitly wanted gone.
- **Cause:** `api/client.ts` `handleResponse` fired the global `forbiddenListeners` (which `useToast` turns into a toast) on EVERY 403 — including background GET reads. Individual pages that hadn't gated their queries' `enabled:` for a restricted role each 403'd on mount → a toast each. The per-query gating was incomplete for some pages, and there was no global safety net.
- **Fix:** Thread the request `method` into `handleResponse` and fire the forbidden toast **only for user-initiated writes** (POST/PATCH/PUT/DELETE). A 403 on a background GET read is now silent (dev-only `console.warn` pointing at the query to gate). This kills the storm system-wide + permanently, regardless of which page leaks a read. The deeper "off, not hide" fix (gate each leaked query's `enabled:` so it never fires) continues per-page on top of this net.
- **Ref:** `fix/forbidden-toast-storm`, 2026-07-14.

### 🟢 Landed-freight lost when the last goods line has qty=0
- **Symptom:** On a GRN whose LAST goods line (in input order) has qty=0 while a freight/charge pool exists, the whole rounding remainder was recorded as "allocated" to that line but folded into a per-unit charge of 0 — so the freight landed nowhere and the received lots carried less than the true landed cost. Edge-only (a real received goods line normally has qty>0).
- **Cause:** `landed-allocation.ts` gave the remainder to `base.length - 1` (the last line unconditionally); `perUnitCharge = qty>0 ? round(alloc/qty) : 0` then dropped it when that line's qty was 0.
- **Fix:** Assign the remainder to the last line with **qty > 0** (`lastPositiveIdx`); trailing qty=0 lines get 0 via the normal proportional branch, so the column still sums to the pool exactly.
- **Ref:** `fix/low-edge-batch-0714`, 2026-07-14.

### 🟢 Sales Invoice header discount/tax columns could silently overstate revenue (future-proofing)
- **Symptom:** None yet (not a live defect) — the SI header `discount_centi` / `tax_centi` columns exist and are read into the header select but are NEVER written (all discount/tax is per-line, already inside `line_total_centi`). `recomputeTotals` set `total_centi = Σ line_total` and ignored them. A future header-discount UI wired to those columns would have posted a `total_centi` (which backs the GL) that ignored the header discount → overstated revenue.
- **Cause:** `recomputeTotals` (`sales-invoices.ts`) never folded the header-level columns into the grand total.
- **Fix:** Fold them defensively — `grand = max(0, Σline − headerDiscount + headerTax)`; `total_centi` / `local_total_centi` / margin now use `grand`, `subtotal_centi` stays the line sum. No-op today (both columns 0), correct if ever populated.
- **Ref:** `fix/low-edge-batch-0714`, 2026-07-14.

### 🟢 Mobile Delivery Planning board didn't refresh the POD / SO screens after a mutation
- **Symptom:** A driver who converts SO→DO, or marks a stop IN_TRANSIT / DELIVERED, on the mobile Delivery Planning board, then opens the mobile POD screen or SO list within ~15-30s, saw the PRE-mutation status/list. Self-healed after the staleTime window.
- **Cause:** The board's shared `invalidate()` helper (`MobileDeliveryPlanning.tsx`) invalidated only its own `["mobile-delivery-planning"]` key. The sibling mobile queries that render the same DO/SO state — `["mobile-do-list-for-pod"]`, `["mobile-pod-detail", id]`, `["mobile-so-list"]` — were never invalidated in the writing tab (BroadcastChannel doesn't deliver to the tab that wrote), so they stayed stale until their own staleTime expired. Same class as HOOKKA's bulk-deliver/POD stale-list bug (desktop was already fully disciplined — it invalidates every sibling key).
- **Fix:** Broaden the shared `invalidate()` to also invalidate `mobile-do-list-for-pod`, `mobile-pod-detail` (prefix-matched, all open details), and `mobile-so-list`. All four board mutations (convert / start / complete / +1) get it uniformly.
- **Ref:** `perf/mobile-virt-systemwide`, 2026-07-14. (Found by a system-wide delivery-cache audit; the two other HOOKKA-flagged risks — CHECK-constraint 500s and silent RM0 3PL rate — were verified NOT present in Houzs.)
### 🟢 Mail Center empty-state copy claimed a mechanism that doesn't exist (misleading)
- **Symptom:** Owner opened Mail Center under the 2990 company, saw an empty inbox with "No mailbox assigned yet" + "Incoming mail will appear here once the domain MX is switched to Cloudflare and the inbound Worker is live", and thought receiving had broken ("之前有 email 进来了 为什么又没有了").
- **Cause:** TWO things. (1) The empty-state copy was hand-carried from Hookka and describes an MX-cutover inbound path Houzs never used — Houzs inbound is a Gmail IMAP pull (`mail-sync` GitHub Action, every 5 min; MX stays on Google Workspace). The claim was simply false and alarming. (2) No actual data loss: since migration 0107 the mail tables carry `company_id` and `getMailScope` / threads are scoped to the ACTIVE company; the owner's `hello@` mailbox + history belong to HOUZS (company 1), so viewing under 2990 (company 2) correctly shows nothing.
- **Fix:** Replaced the copy with the truth — mail syncs automatically every few minutes, and it is scoped to the active company so an empty mailbox usually means the company selector is on the wrong company. (No backend change; the scoping is working as designed.)
- **Ref:** `fix/mail-empty-copy`, 2026-07-14.
### 🔴 Concurrent same-company SO / PO / GRN creates 500 on duplicate doc-no
- **Symptom:** Two POS terminals (or two buyers / two warehouse staff) creating a document in the same company + same YYMM at the same moment: the second create fails with a generic 500 and the whole document (customer, payments, PWP claims / lines) is lost — the operator must redo it. Highest-risk on the SO create path (the most concurrent one).
- **Cause:** The single-create minters read `max(suffix)+1` then did a PLAIN insert with no `23505` (PK / UNIQUE violation) retry. Two callers read the same max, mint the same `doc_no` / `po_number` / `grn_number`, and the loser violates the unique constraint → 500. `max+1` self-heals a *deleted-gap* re-mint but NOT a *concurrent-create* race. The repo already shipped `insertWithDocNoRetry` (loops on 23505, re-derives the next free suffix; used by DO/CN/CS/CRN/DR/SI/PI/TRIP) but SO create, PO single-create, GRN single-create and GRN batch-convert never adopted it.
- **Fix:** Wrap all four header inserts in `insertWithDocNoRetry`. First attempt reuses the already-minted number; a 23505 re-mints from a fresh read and retries. **Child-row propagation:** PO/GRN children key off the returned `header.id` (not the doc-no), so a re-mint needs no re-stamp; SO reassigns `docNo = mintedDocNo` after the successful header insert so every downstream child (payments, items, status, price override, PWP) uses the committed number. SO is PWP-entangled (pwp_codes.redeemed_doc_no is reserved against the FIRST-minted docNo before the header insert, with rollbackPwpClaims on failure), so SO only auto-retries when NO PWP claim was made (`tries = claimedPwpCodes.length === 0 ? 8 : 1`) — a promo order keeps today's exact clean-fail+rollback, so a re-mint can never orphan a PWP redemption.
- **Ref:** `fix/docno-retry-so-po-grn`, 2026-07-14.

### 🟠 Mobile Menu listed nav items the user can't open (render-then-Forbidden)
- **Symptom:** At tablet / narrow widths (`<lg`) and on non-HOUZS mobile, the bottom-bar centre "Menu" sheet listed destinations the user has no access to (Projects, System Health for everyone; Delivery Returns for Sales staff); tapping bounced them to the Forbidden page. The desktop Sidebar and the HOUZS-phone menu hid the same items correctly.
- **Cause:** `MobileTabBar.MenuModal.filterTab` was a hand-copied SUBSET of `Sidebar.filterTab`: it checked only `perm` / `anyPerm` / `hidePerm` and ignored `pageAccess`, `pageAccessFull`, `requireFinanceViewer` and every sales gate (`hideForSales` / `showForSales` / rep gates). A comment claimed the two "stay in lockstep" — they had silently drifted. No data leaked (route guards still render `<Forbidden>` instead of the page), but a denied entry was shown then rejected — the "render-then-deny" that the "off, not hide" rule forbids at the nav layer.
- **Fix:** Extract the full gate logic into a shared `frontend/src/components/navFilter.ts` (`makeNavFilter`); both `Sidebar` and `MobileTabBar` build their menu from it, so a third divergent copy cannot drift again. Mobile also gains the sales-rep `salesRepTo` reachable-click-target override for free. Verified `tsc -b` + `vite build` green.
- **Ref:** `fix/mobile-nav-perm-parity`, 2026-07-14.
### 🟠 Inventory list showed negative / inflated "Available" for partially-shipped or multi-company SKUs
- **Symptom:** On the Inventory product list (`GET /inventory/products`), a SKU could show a wrongly negative `available_qty` (e.g. on-hand 6, gross open SO qty 10 → Available −4 when the true free-to-sell was 0), and in multi-company a shared SKU's Reserved/Available was distorted by the OTHER company's orders.
- **Cause:** The Reserved / reserve_7d / reserve_14d KPIs summed the **gross** open SO-line qty. (1) Delivered qty (net of returns) was never subtracted, so a partially-shipped SO double-counted its already-shipped units → `available_qty = stock − reserved` went negative. (2) The demand query had **no company scoping** while the stock figure (`v_inventory_product_totals`) and the open-lots query WERE company-scoped, so a shared SKU subtracted other companies' demand from this company's stock.
- **Fix:** Each SO line now contributes `max(0, qty − delivered + returned)`. Delivered = non-cancelled **AND non-draft** DOs (a DRAFT DO hasn't shipped / hasn't moved stock, so counting it would inflate Available → over-sell risk); returned = non-cancelled DRs traced through the active DO line (DRs have no DRAFT state). The demand query is also wrapped in `scopeToCompany(...)` like the lots/totals queries in the same file.
- **Ref:** `fix/inventory-reserved-available`, 2026-07-14.

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
- 🟠 **Desktop/mobile drift on service-case stage routing** — the rule "internal-resolution cases (own field service / return visit) skip the two supplier-only stages" lived only in desktop's `getActiveStages`; mobile ignored it, so those cases mis-routed INTO Supplier Pickup / Item Ready and showed the wrong progress denominator (N/7 not N/5). Fix: extracted the rule to shared `vendor/scm/lib/assr/stages.ts` (`resolutionRoute`/`isStageActive`/`activeAssrStages`); both surfaces now filter the pipeline identically. Class: per-screen business logic duplicated → converge to one shared source.
- 🟠 **TanStack invalidation key that never matched** — mobile service-case writes invalidated `["mobile-assr-list"]`, but the list query is keyed `["mobile-assr-list-paged", …]`; a non-prefix key silently matches nothing, so the list stayed stale until `staleTime`. Fix: invalidate the real prefix. Check prefix-equality when an invalidation "does nothing".
- 🟠 **Same non-prefix-key bug across the SO family (create/edit didn't refresh the list)** — mobile SO create/edit/POD/delivery invalidated dead keys `["mobile-so-list"]` / `["mobile-so-detail"]` (no query reads them; real keys are `["mobile-so-list-paged", …]` and `["mfg-sales-order-detail", docNo]`); desktop `useCreateMfgSalesOrder` invalidated `['mfg-sales-orders']` while the live V2 list reads `['mfg-sales-orders-paged', …]`. Result: a freshly created/edited SO didn't appear until staleTime/refocus on both surfaces. Fix: target the real prefixes. **Systemic:** ~19 other desktop SO mutations still invalidate `['mfg-sales-orders']` only — pending a shared `invalidateSoLists()` helper.
- 🔴 **Mobile silently dropped a slip-less SO payment (money bug)** — mobile New/Edit-SO `recordSlipBackedPayments` only POSTs payment rows that have a `slipSession`; a row with an amount but no slip uploaded was skipped with NO error, so the cashier's payment never posted and the SO showed unpaid. Desktop blocked this (Spec D4) but mobile lacked the guard. Fix: shared `soSliplessPaymentError` (`vendor/scm/lib/so-form-validate.ts`) blocks the save on both surfaces. Mobile was ALSO missing the past-date / processing>delivery date guards desktop had — same shared module (`soDateGuardError`) now enforces them both sides. Class: validation rule present on desktop, absent on mobile → converge to one shared guard.

### SCM correctness (mostly caught pre-Houzs on 2990, verified on Houzs)
- 🟠 **GRN defaulted warehouse to CHINA-transit** → false MRP alarms. Fix + GRN 防呆.
- 🟠 **Sofa drop-ship DO missing the 7 corner-holes line** → under-built. Fixed Houzs (PR #349).
