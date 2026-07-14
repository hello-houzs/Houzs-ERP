# Houzs ERP — Performance & Rendering Optimization Plan

Status doc / work checklist. Compiled from (a) live Chrome measurements against
erp.houzscentury.com, (b) a full mining of HOOKKA's `docs/BUG-HISTORY.md` for
caching/perf pitfalls, and (c) a codebase audit of every long-list page.

Purpose: list every remaining work item, scoped with file paths + priority, so
sections can be handed to different people. Check items off as they land.

---

## 摘要 (owner TL;DR)

- 交易核心已经优化好了:SO 列表接口从 388ms 降到约 40ms;全局外壳的重复请求清掉了。
- 「更新了却卡在旧版本」这个你最担心的问题:系统本来就大部分防住了(HTML 网络优先、
  版本横幅、深链接不缓存)。唯一脆弱点是 SW 版本号靠手动改(现在 v170),建议改成自动。
- 最大一块没做的:**长列表虚拟滚动**。桌面单据列表(SO/DO/SI/GRN/PO 等)和手机列表
  目前一次性渲染全部行,数据一多就卡。改 `DataTable` 一个文件就能覆盖 8+ 个页面。
- 下面 P0/P1 就是可以分给别人做的 section。每条都写清了文件和验收标准。

---

## 0. Shipped this campaign (verified live)

- [x] **mig 0104** — pg_trgm GIN + partial indexes on `scm.mfg_products`
  (description/barcode/category) + `fabric_colours` + `fabric_trackings`.
  Scales substring search + category/fabric filters. (non-concurrent; small tables)
- [x] **SO-list read parallelization** (PR #416) — `GET /api/scm/mfg-sales-orders`
  ran ~6 independent enrichment reads serially; now one concurrent wave.
  Measured **388ms → ~40ms warm**. Backs desktop Orders grid + mobile Orders board.
- [x] **Presence dedupe** (PR #415) — `usePresence` was mounted twice → 2× poll +
  heartbeat per page; now one shared singleton poll.
- [x] **Branding cache, bounded** (PR #414 + #419) — was refetched every 30s/nav;
  now 10-min staleTime (NOT Infinity — keeps a self-healing net, see Guardrail G1).
- [x] **Mobile FabricPicker render cap** — renders first 60 of the *filtered* rows
  (search still narrows the full list first). Interim; superseded by V1 below.

---

## 1. Guardrails — HOOKKA pitfalls, with Houzs status

These are the traps HOOKKA documented and fixed. For each, Houzs' current status.
"SAFE" = verified we don't have it. "AUDIT" = needs a check. "TODO" = known gap.

| # | Pitfall (HOOKKA SHA) | Houzs status |
|---|----------------------|--------------|
| G1 | `staleTime` gating refetch → stale data after a server-side change (`d8f71d23`) | **SAFE-ish**: global 30s staleTime + invalidation-beats-staleTime + epoch read-after-write guard (`api/cache.ts`). Fixed the one `Infinity` we introduced (#419). Rule: never set `staleTime: Infinity`. |
| G2 | Client cache serving stale *shape*; `ids ?? []` collapses absent→empty and filters everything out (BUG-2026-06-23-002) | **AUDIT** — grep consumers that do `?? []` / `new Set(x ?? [])` on cached payloads; treat absent as "not loaded → refetch", not empty. |
| G3 | Mutation didn't broadcast invalidation → other tabs stale (`fbc68dcc`) | **MOSTLY SAFE**: `MutationCache.onSuccess → broadcastDataChanged`, `invalidateForMutation`. `postBinary` does NOT auto-invalidate (Settings compensates manually). TODO: recurring "which write paths skip invalidate" sweep. |
| G4 | URL-keyed cache: a control changes a param but not the key → frozen data (BUG-2026-06-21-004) | **AUDIT** — multi-tab date/filter controls that persist to localStorage but don't lift state. |
| G5 | SW shell cache name not build-id-keyed → white screen after redeploy (`d03f79f3`) | **TODO (P1)**: `VERSION` is a manual constant (`sw.js:298` = `houzs-erp-v170`). Derive from Vite build hash so a deploy can't forget to bump. Mitigated today by network-first HTML. |
| G6 | `respondWith(undefined)` → white screen (BUG-2026-06-30-004) | **SAFE** — both SW handlers always return a `Response` (`sw.js:412,441`). |
| G7 | Version-check hook only in one layout → other entries never auto-refresh (BUG-2026-06-18-008) | **AUDIT (P2)**: `NewVersionBanner` mounted at `App.tsx:236`. Verify the mobile (`.hz-m`) surface renders under it / reaches it. |
| G8 | `_headers` no-cache scoped to `/` not `/*` → SPA-route HTML cached, chunks 404 after deploy (BUG-2026-05-28-005) | **SAFE** — verified `curl -I` on `/scm/sales-orders` returns `max-age=0, must-revalidate`. `/assets/*` immutable. |
| G9 | Snapshot freshness: `Date >= string` compares as NaN → serves days-stale (`5f2b1b73`); mark-stale loses the race (`df0804ba`); serialize drops undeclared fields (BUG-2026-06-24) | **GUARDRAIL for future** — applies IF we add server snapshots (see C2). Rules: normalize both timestamp sides to `getTime()`; fail toward recompute; DELETE the snapshot on write (don't mark-stale); single-flight; declare every cached field. |
| G10 | pg_trgm applied in a txn migration fails (`CONCURRENTLY` can't run in tx); extension dropped on staging clone (BUG-2026-06-07-013) | **NOTE** — 0104 used non-concurrent on small tables (OK). For large tables apply `CONCURRENTLY` out-of-band. Staging-clone must `CREATE EXTENSION IF NOT EXISTS` before restore. |
| G11 | Client-side search/filter over a server-paginated list only sees the current page → wrong results + wrong tab counts (`d628c8ee`) | **AUDIT (P1)** — Houzs non-SCM lists paginate server-side (`per_page`). Verify filters/tab-counts aren't computed client-side over one page. |
| G12 | Background refetch re-seeds a form and wipes in-progress edits (`96ed60fb`) | **AUDIT (P1)** — now that caching + refetch-on-mount are on, every edit form that hydrates from a fetched response must seed once per record id + guard re-seed with `!dirty` + nav-guard. |
| G13 | Debounce search inputs; don't over-debounce saves (`087a7040`) | **AUDIT (P2)** — confirm search boxes debounce (esp. mobile). |

---

## 2. Virtualization — "render only what's scrolled into view"  (biggest gap)

Audit finding: the codebase has ONE windowing mechanism — a `react-virtual-shim`
used only by the SCM **`DataGrid`** (virtualizes flat lists >25 rows; master-data
pages are already safe). The main **`DataTable`** used by the routed document
lists does NOT window — it maps every row into `<tbody>` AND separately builds a
full mobile card list in the same tree (~2× nodes).

- [ ] **V1 (P0) — Window `components/DataTable.tsx` once.**
  Mirror `DataGrid`'s `VIRTUAL_THRESHOLD` approach, reuse `vendor/scm/lib/react-virtual-shim.ts`.
  Derive total height from `rows.length × ROW_HEIGHT` (do NOT trust the virtualizer's
  async `getTotalSize()` — HOOKKA bug 4a) and clip virtual items to `< rows.length`.
  **Covers in one change:** Sales Orders, Delivery Orders, Sales Invoices, GRNs,
  Purchase Orders, Purchase Invoices, Delivery/Purchase Returns, Stock Transfers/
  Takes/Adjustments (`pages/scm-v2/*ListV2.tsx`).
  Portal any row dropdown/popover — a scroll wrapper clips `absolute` menus (bug 4b).
- [ ] **V2 (P0) — Stop building the hidden mobile CardsGrid on desktop.**
  The ListV2 pages keep the `md:hidden` `CardsGrid` mounted (CSS-hidden) even on
  desktop → double the row nodes. Gate by viewport so only one branch mounts
  (aligns with the standing "off, not hide" rule).
- [ ] **V3 (P1) — `pages/scm-v2/StockTakeDetail.tsx:490`** — line rows are
  *controlled inputs*; ~1141-row catalog = ~1141 live inputs. Heaviest per-row;
  window it (keep the edited row realized).
- [ ] **V4 (P1) — Mobile card lists.** `mobile/MobileModuleList.tsx:416` and
  `mobile/MobileSalesOrders.tsx:411` render all cards. Two mobile endpoints are
  UNCAPPED — `/inventory?showAll=true` and `/mfg-products` (~1141). Add windowing
  (preferred) or a cap. This replaces the interim FabricPicker cap with the real fix.
- [x] Already virtualized/safe: all DataGrid master lists (Products/SKU, Inventory,
  Fabrics, Suppliers, StockCard ledger, Consignment*, DeliveryPlanning, etc.),
  server-paginated non-SCM pages (Projects/ServiceCases/Team), and detail line tables.

---

## 3. Caching — per-module (cache where static, NOT where live)

- [x] Reference dropdowns (staff/category/warehouse/fabric): already TanStack-cached
  in the vendored SCM layer (`staleTime` 5–10min). No work.
- [ ] **C1 (P2) — Dashboard / overview tiles**: good cache-aside candidates (change
  slowly within a session). Give the heavy overview aggregations a longer client
  `staleTime` (bounded, per G1 — never Infinity).
- [ ] **C2 (P2, grows with data) — AR aging `/api/scm/outstanding/summary` (~333ms)**:
  a server-side snapshot candidate as debtor data grows. If built, follow ALL of
  G9 (epoch-normalize timestamps, DELETE-on-write, single-flight, declared fields,
  fail-toward-recompute). Not urgent while data is small — do NOT pre-optimize.
- [ ] Do NOT cache: presence, auth, in-flight edit state, activity feeds
  (already on `api/cache.ts` NEVER_CACHE).

---

## 4. Search / index

- [x] Products + fabric trgm indexes (0104).
- [ ] **S1 (P2)** — audit other frequently-searched columns for trgm GIN: customer
  names, SO `debtor_name`/phone, supplier names. Apply per G10.
- [ ] **S2 (P1)** — where a list is server-paginated, push search + tab counts to the
  server (a `/stats` count endpoint) rather than filtering the current page client-
  side (correctness, per G11).

---

## 5. Deploy-staleness hardening

- [ ] **D1 (P1)** — Derive `sw.js` `VERSION` from the Vite build hash (inject at
  build) so it auto-bumps every deploy; removes the manual-bump failure mode (G5).
- [ ] **D2 (P2)** — Confirm the mobile surface sits under `NewVersionBanner` /
  version-check so phones auto-refresh on deploy (G7).
- [x] `_headers` deep-route no-cache (G8) — verified SAFE.
- [x] SW `respondWith` always returns a Response (G6) — SAFE.

---

## Delegation map (suggested sections)

| Section | Items | Owner type | Independent? |
|---------|-------|-----------|--------------|
| A — DataTable windowing | V1, V2 | 1 frontend dev | Yes, self-contained |
| B — Mobile lists | V4 | frontend (mobile) | Yes |
| C — Stock-take inputs | V3 | frontend | Yes |
| D — Deploy hardening | D1, D2 | frontend/build | Yes |
| E — Cache-safety audits | G2, G3, G4, G11, G12, G13 | frontend | Yes (read-heavy) |
| F — AR snapshot (defer) | C2, S1, S2 | backend | Later (data-growth gated) |

P0 = do first (biggest felt win). P1 = next. P2 = as data grows.
