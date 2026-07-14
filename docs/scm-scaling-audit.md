# SCM Scaling & Performance Audit — 2026-07-14

Live measurement (real Chrome against prod `erp.houzscentury.com`, both companies) + two code audits + a big-ERP/HOOKKA research pass. This is the reference for **why the SCM pages feel slow and what breaks at 10x/100x**, and the ranked, correctness-first fix plan. Owner constraint on all of this: **input/output must stay exactly correct — a perf change may never change a number.**

## 1. What we measured (live, prod)

Frontend is fast; the cost is server-side on the `/api/scm/*` list endpoints.

| Surface | Warm load | Notes |
|---|---|---|
| Products (2990, 334 SKUs) | 557ms | domInteractive 112ms; 3 SCM calls ~340-365ms in parallel are the critical path |
| Products (Houzs, 1326 SKUs) | — | DataGrid windows it; renders fine |
| SO list (2990, 62 SOs) | — | `mfg-sales-orders` **319ms server-side** |
| SO list (Houzs, 21 SOs) | 459ms | `mfg-sales-orders` **258ms server-side** |
| Service Cases (2990, 761 cases) | 492ms | `/api/assr` **118ms** (paginated to 50 rows) + summary 219ms |
| Mobile SO (Houzs, ?mobile=1) | 552ms | mobile layer + `MobileVirtualList` active (21 vcards); same SCM backend |

Per-request breakdown (resource timing): for `mfg-sales-orders` **total 324ms = conn 0 + serverTTFB 319ms + download 3ms** — it is **pure server think-time**, not network or render. Non-SCM `/api` (auth/me 45ms, branding 78ms, presence 83ms, `/api/assr` 118ms) are all fast. Cold-start jitter can push `auth/me`/`branding` to 400-500ms on a fresh load, but they are cached (branding 10min, auth once).

## 2. The scaling model

Two data points (21 SOs → 258ms, 62 SOs → 319ms) fit **~230ms fixed base + ~1.5ms/row**:

- 10x (620 SOs): **~1.2s**
- 100x (6200 SOs): **~9.5s — breaks**

The **~230ms fixed base** is why every SCM page feels slow *now*, independent of data size (Houzs with 21 SOs is not meaningfully faster than 2990 with 62). It comes from: the base VIEW query's payment-ledger aggregate, the per-request `scm.staff` UUID resolution (the `/api/scm/staff` probe alone is 92-290ms), and the internally-serial `soDeliverableRemaining` 5-hop chain. Handler-level parallelization (#416) already collapsed the 6 enrichment reads into one concurrent wave — confirmed present and correct — but it cannot flatten the base query or the serial deliverable chain.

**Crucial:** this session's mobile/desktop virtualization fixed the **render** (DOM holds ~57 rows), but the **fetch** is still "read the whole table + enrich every row". Virtualization ≠ scaling. As rows grow, the backend and payload grow linearly while the screen still shows one page. The real 100x fix is **server-side pagination**.

## 3. Root causes (code audit, file:line)

- **No btree indexes on scm hot columns.** Every list runs `ORDER BY <date> DESC LIMIT 500` with no index on the date (full-table sort each load), and every enrichment does `.in(<join_col>, ids)` with no index (seq scan). `mfg-sales-orders.ts:677/731`, `delivery-orders-mfg.ts:1707/1136/1168`, `grns.ts:586/615`, `sales-invoices.ts:192`.
- **Fetch-all, not paginate.** SO/DO/GRN/SI lists hard-`.limit(500)` (no offset, no total). Past 500 rows the list **silently truncates to the newest 500** with no "500 of N" signal.
- **A latent correctness cliff (reachable near 500 SOs).** `itemRows` (`mfg-sales-orders.ts:731`) and `soDeliverableRemaining`'s `soItems`/`doLines` (`delivery-orders-mfg.ts:1136/1168`) and `grn_items` (`grns.ts:615`) are single queries **not wrapped in `paginateAll`** → past PostgREST's 1000-row cap they silently drop rows → stock-status / deliverable / branding become **wrong**. This is a data-correctness bug, not just a speed one.
- **AR aging is the worst time-bomb.** `GET /outstanding/summary` (`outstanding.ts:94`) loops 7 modules **sequentially**, each `paginateAll(view.select('*').eq('is_outstanding', true))` — fetches every outstanding row of every module in full and reduces `count`/`sum` **in JavaScript**. Correct today, but at 100x it pulls tens of thousands of rows over 7 serial loops. `is_outstanding` is a computed CASE column (not indexable).
- Enrichment shape is otherwise healthy: all reads are **O(1) set-based `.in(...)`**, no N+1 loop anywhere.

## 4. How mature ERPs do this (research)

- **Pagination:** offset/LIMIT + a hard page cap is fine for operator grids (users rarely go past page ~10); switch to **keyset/cursor** only for exports/infinite-scroll. The `ORDER BY` **must be unique** — always append an `id` tiebreaker or pages skip/repeat. Needs an index matching the exact sort.
- **Total count:** exact `count(*)` scans the whole set (the thing you're avoiding). Use PostgREST `count=estimated` (exact under a threshold, planner estimate beyond) and show "N of ~M" or "N of M+"; return it in `Content-Range`. **Never** compute a total by fetching rows and `.length`.
- **Enrich only the current page's ids**; a DB VIEW/RPC returning per-row rollups in one round-trip beats app-side assembly on Workers (every extra round-trip pays Hyperdrive latency).
- **Aggregations:** `SUM()/COUNT()` in SQL — one round-trip, no 1000-cap, no O(rows) JS memory. Net outstanding = `face − paid − credits` in SQL. Materialized/cached only after measured slow, and only with an invalidation rev bumped inside **every** write path.
- **Money/count correctness rules:** ratio-of-sums not mean-of-ratios; `NULLIF(denom,0)` for every ratio; exclude TEST/cancelled/void via **one shared status set** reused by list + count + summary; age off **one** defined date column (document date), date-portion only; parse dates DD/MM explicitly, guard future dates; aging total must tie the GL control account.

## 5. HOOKKA pitfalls we must NOT repeat (from their BUG-HISTORY)

- **BUG-2026-05-26-003** — KPI cards reduced over the **current page only** and `/stats` **ignored the filter params** the UI sent → "Outstanding RM"/"Collected MTD" undercounted past 200 rows. Fix template: a single `SUM(CASE …)` aggregate across the whole filtered table; `/stats` must honour the same filters as `/list`. **This is the AR-aging rewrite template.**
- **Status-bucket drift** — the same status literal defined differently in different files; `READY_TO_SHIP` double-counted into two buckets; "Completed" hardcoded to the wrong terminal status → perpetual 0. Fix: one shared status module, mutually-exclusive sets.
- **BUG-2026-07-11-001** — same metric different per page (efficiency 87% vs 92% vs 372%) from mean-of-ratios vs ratio-of-sums, div-by-1-minute blow-ups, RM0 rows inflating counts, **future-dated completions** from a dd/mm→mm/dd import.
- **BUG-2026-07-05-001** — AP aging showed the **full face amount for partially-paid** invoices because the loop never selected `paid_amount` (net it).
- **Stale-after-mutation (HOOKKA's #1 recurring class, ~10 times):** cached aggregates not invalidated on void/soft-delete; freshness probes assuming a universal `updated_at` that only 28/130 tables had → HTTP 500 on deploy. **`tsc` and unit tests do NOT catch these — verify on staging against real prod-shaped data (before/after diff).**

## 6. Ranked fixes + status (COMPLETE — all merged to prod, 2026-07-15)

Every ranked item below is **DONE and merged to `origin/main`** (auto-deploys to prod, which also runs `pg-migrate`). PR numbers are the actual merged PRs.

| # | Fix | Status |
|---|---|---|
| 1 | **btree indexes** on scm hot columns | **DONE + deploy-verified** — mig `0111` (#469) |
| 2 | **`paginateAll`** wrap of unpaginated enrichment reads (1000-cap truncation cliff) | **DONE** (#475), browser-verified SO list data intact |
| 4 | **True server-side pagination on the SCM lists** (`.range()` + `count:'exact'` total + server search + `statusCounts` tabs + deterministic `ORDER BY …, id`) — the 100x fix | **DONE, all 6 lists desktop + mobile.** SO (#481 be, #483 desktop, #499/#502 mobile) + DO/GRN/SI/PO/PI (#491 be, #497 desktop). Multi-status tab buckets → `.in()` (#500). Mobile generic SCM lists = MobileModuleList infinite-scroll (#507). Desktop all 6 prod-verified (Showing X–Y of N, cross-page search, no skip/dup). |
| — | **Dropdown scaling** (owner's colour-dropdown concern) | **DONE, both surfaces.** SoLineCard fabric/colour → server typeahead `/fabric-colours?q=` (#512 desktop SO+Consignment; #523 mobile New-SO). The picker family (FabricPicker/MobileSkuPicker/SalesOrderNewFromProducts, MultiSupplierPicker, ProductModels supplier select) → server-typeahead min-chars gate (#536). UserMultiSelect people picker → `/api/users?q=` typeahead (#541). |
| 3 | **`GET /outstanding/summary`** AR-aging → SQL `SUM(CASE)`/`count` (net face−paid−credits) | **DONE** (#528) with JS-reduce fallback safety net; **before/after byte-identical on prod** (PO17/GRN1/PI10/PR0/SO56/DO6/SI0 + PI RM43,262.60). |
| — | **Full-set money KPIs** (SO/list Revenue/Outstanding/Paid + mobile summary — was page-scoped "on this page") | **DONE.** SO list full-set aggregate (#527), Consignment full-set KPIs (#529). SO cross-page verified exact (Revenue 172,335 = p1 126,225 + p2 46,110). |
| — | **Non-SCM lists** (Projects status, Team grid + org tree, Announcements, Mail threads + mailbox matrix + outbox) | **DONE.** Projects server status pagination (#535), Team list + org-tree lazy-mount (#513/#537), Announcements windowed + backend limit (#511), Mail threads server-paginate + filters + virtualize + outbox load-more (#514/#539). |
| — | **Consignment (3 docs) + Products/SKU list** | **DONE.** Consignment server pagination + money KPIs (#522/#529), Suppliers pagination (#516), SKU Master Edit-Prices table virtualized (#509). |
| — | **Mobile lists** (PMS / Service Case per_page=200 truncation) | **DONE.** Server-side infinite-scroll, copies MobileSalesOrders pattern (#515). |
| 5 | Collapse `soDeliverableRemaining` 5-hop serial chain | **DONE** (#534) — collapsed 5→3 hops via PostgREST parent-status embeds, output-identical. |

**Verification method:** every change browser-verified on prod (real Chrome, desktop + `?mobile=1`): pagination footer, cross-page search returns rows on other pages, no dup/skip, full-set counts, flat server TTFB. Money changes (#527/#528/#529) verified by before/after diff on real prod data, never `tsc` alone. Caveat: the MCP-driven debug tab background-throttles rAF AND IntersectionObserver, so scroll-triggered infinite-load can't be exercised there — it works on a real foreground phone; backend paging is separately proven via the desktop cross-page test.

## 7. Correctness rules for this work (non-negotiable)

1. A perf change may never change a number. Below the 1000-row cap, `paginateAll` returns the identical page → identical output; that is why #2 is safe now.
2. Money/aggregation rewrites (#3) are verified by a **before/after diff on real data (staging)**, never by `tsc`/unit tests alone.
3. Pagination (#4) keeps a **deterministic total order** (unique tiebreaker) so no row is skipped/duplicated across pages; `/list` and `/count` apply the **same filters**.
4. Every list/summary excludes TEST/cancelled/void via the same shared status set.

## 8. System-wide foundation map (full audit 2026-07-14, evening)

The blind spot the audit exposed: **virtualization (DataTable/DataGrid/MobileVirtualList) bounds the DOM but never the FETCH.** `api.get`/`authedFetch` send exactly the query string you build — a list is bounded only if the code explicitly passes `page`/`per_page`/`limit`. The fix everywhere below was the same: bound the fetch (server page/limit/typeahead), not just the DOM. All items in this section are now shipped — the reference-data layer (`fabric_colours`, `mfg-products`, `suppliers`, `users`, consignment/announcement/mail collections) no longer ships whole tables.

### LISTS — all 10x-safe (DONE)
Every list surface now bounds **both** the DOM and the fetch (server page/limit or infinite-scroll). No list ships a whole table to the client.

| Surface | Fix shipped | Ref |
|---|---|---|
| 6 SCM V2 doc lists (SO/DO/PO/PI/SI/GRN) + StockTakes/StockTransfers | server `page/pageSize/statusCounts` + deterministic order | #481/#491/#497/#500 |
| Mobile SO + generic mobile SCM lists (SO/DO/SI/GRN/PO/PI + Consignment ×3 + Suppliers) | IntersectionObserver infinite-scroll, true server paging via `MobileModuleList.SERVER_PAGINATED` | #499/#502/#507 + mobile consignment/suppliers paging |
| Mobile PMS / Service Case (was `per_page=200`) | server infinite-scroll (same pattern) | #515 |
| SCM Products / SKU Master Edit-Prices | virtualized table body | #509 |
| Team members grid + org chart | `/api/users` server pagination + filters; org-tree department lazy-mount | #513/#537 |
| Announcements desktop | backend LIMIT/offset + windowed Posted list | #511 |
| Mail threads + mailbox matrix + outbox | server-paginate threads + push starred/Sent/q; virtualize matrix; wire outbox load-more | #514/#539 |
| Consignment Orders/Notes/Returns + Suppliers | server page/pageSize hook + full-set money KPIs | #516/#522/#529 |
| Projects list (status filter) | push status to server, drop the `per_page=1000` | #535 |
| Service board/calendar (was `per_page=500`) | server-bounded window | #532 |
| Service Cases list / Logistics / Settings; all summary tiles; Notifications | already `per_page=50` / SQL aggregate / server-capped | prior |

### DROPDOWNS — all server-typeahead (DONE)
The audit's key finding — DOM caps (#501) fixed zero fetches — is fully resolved: every heavy picker now queries the server on ≥2 chars and never downloads the whole option table. Selected values render verbatim from the stored value (never blanked).

| Picker | Fix shipped | Ref |
|---|---|---|
| **Fabric/colour** (owner's named pain) — SoLineCard, SO + Consignment | server typeahead `/fabric-colours?q=` + capped combobox | #512 |
| Fabric/colour — Mobile New-SO | converged onto the same server typeahead | #523 |
| Picker family: FabricPicker, MobileSkuPicker, SalesOrderNewFromProducts, MultiSupplierPicker, ProductModels supplier select | shared server-typeahead / min-search-chars gate | #536 |
| UserMultiSelect people picker | `/api/users?q=` typeahead, `known` map preserves selected users | #541 |
| SoLineCard product search, ConsignmentOrderNew debtor, GlobalSearch | already true server-typeahead | prior |

### Bottom line — COMPLETE
Whole system (desktop + mobile) is 10x/100x-safe and prod-verified: every list paginated/infinite-scrolled, every DOM-freeze surface virtualized, every heavy dropdown server-typeahead (incl. the fabric/colour picker on both surfaces), all money KPIs full-set and byte-identical-verified on real prod data (SO cross-page exact, AR aging before/after identical, Consignment). Indexes (#469), `paginateAll` truncation-cliff (#475), and the deliverable-chain collapse (#534) close the correctness cliffs.

### Accepted tradeoffs (owner's call — documented, not regressions)
Bounded-scale choices deliberately left as-is; revisit only if the underlying set grows into the thousands:
- **DataGrid per-column sort/funnel** operates on the loaded page only on paginated lists (search + status are server-side; column funnel is a page-local convenience).
- **Mobile SCM status/category chips** filter loaded rows only (search itself is server-side).
- **Supplier reference data** (`useSuppliers`) is a single bounded fetch shared by MultiSupplierPicker + ProductModels — reference data, not thousands-scale.
- **Mail left-rail badge counts** still derive from the ≤300 thread fetch (needs a server GROUP BY to be exact past 300).

---
_This doc is the versioned counterpart to the Obsidian wiki; run `/sync-wiki` in an interactive session to mirror it into `Houzs ERP/`._
