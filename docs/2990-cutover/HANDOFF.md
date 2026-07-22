# 2990 → Houzs Cutover — HAND-OFF

> **For whoever picks this up (has the owner's accounts).** Goal: fully replace the 2990
> backend so the 2990 POS runs entirely on Houzs (company 2), then retire 2990.
> Last updated: 2026-07-21. Read `CUTOVER-PLAN.md`, `DATA-FLOW.md`, `FLIP-RUNBOOK.md`
> in this folder for background; this file is the current state + what's left.

## TL;DR

- **Code / API / POS-side / accounts / photos: DONE and merged.**
- **Sales + catalog + configurator data: 100% complete + verified** (kept fresh by a live mirror).
- **ERP/stock catch-up: DONE.** PO / GRN / PI / DO / inventory movements-lots-consumptions / pwp_codes
  / analysis_customer_targets / drivers / currencies / app_config all match 2990 exactly after the
  PR #955 importer extension + PR #956 stray-fix + APPLY run (see §A for the census).
- **Only real data hole left:** `scm.accounts` (GL, 31 rows in 2990) — held for the owner's Ecount
  export decision (§3). Everything else is caught up.
- **Left to do:** owner supplies Ecount GL export → run the seed SQL → **deploy the POS in houzs mode** +
  the **coordinated flip window** (see `FLIP-RUNBOOK.md`).

---

## Coordinates (systems + keys)

| Thing | Value |
|---|---|
| Houzs backend repo | `hello-houzs/Houzs-ERP` — cutover PR **#949 MERGED** to `main` (squash `fd3e43c5`), deployed to prod |
| POS repo | `wenwei4046/2990s` — seam PR **#732 MERGED** to `main` (dark) |
| Houzs prod DB (Supabase) | project `anogrigyjbduyzclzjgn`; worker `autocount-sync-api`; site **erp.houzscentury.com** |
| Houzs staging | project `minnapsemfzjmtvnnvdd` |
| **2990 source DB (Supabase)** | project **`dolvxrchzbnqvahocwsu`** — `https://dolvxrchzbnqvahocwsu.supabase.co` |
| 2990 live API (public, used for photo fetch) | `https://api.2990shome.com` |
| Houzs R2 bucket | `houzs-erp` |
| Company id | HOUZS = 1, **2990 = 2** (`companies.code='2990'`) |
| Flip switches | Houzs env **`HOUZS_OWNS_2990`** (default `false`) + POS build **`VITE_BACKEND_TARGET=houzs`** |
| Import script | `backend/scripts/migrate-2990-into-houzs.mjs` (+ `diag-2990-import.mjs`, `rollback-2990-from-houzs.mjs`, `migrate-2990-staff.mjs`) |

---

## 1. What's been done (current progress)

### Backend (Houzs) — DONE, on prod
- Cutover **PR #949 merged to `main` + deployed** (durable; CI no longer overwrites it).
- Built/ported: `/api/scm/pos-pools/*` (cost-stripped combos/pools), PIN `pin-login` as a first-class
  capability, POS-scoped `/api/pos/sales-staff` + `sales-stats` (14 fields), `/categories` contract fix,
  cost-stripped `/pos-pools/sofa-combos`, customer marketing demographics captured on the SO
  (migration **0162**), pre-auth public image mounts, the `.schema('scm')` photo-proxy fix, flip guards
  gated by `HOUZS_OWNS_2990`.
- **Independent post-merge seam audit: 0 breaks.** Live prod smoke test (real salesperson session):
  every POS read endpoint returned **200** (login, catalog, pools, categories, own orders, cart, quotes,
  quick-picks, customer-search).

### POS front-end (`wenwei4046/2990s`) — merged, DARK
- Seam **PR #732 merged**. `apiClient.ts` switches target by `VITE_BACKEND_TARGET` (unset === `2990`,
  byte-identical to today). A **normal `vite build` keeps the POS on 2990** — the Houzs path is dark
  until a build with `--mode houzs` (or Pages env vars).
- `apps/pos/.env.houzs` points at **`https://erp.houzscentury.com/api/scm`**, company 2.

### Accounts — done + verified
- 4 real salespeople (public.users ids **130–133**), position `sales_executive`, `user_companies.company_id=2`,
  active, adopted onto their `2990S-00x` staff stubs (so historical SOs stay attributed).
  **PIN = `000000`** (default — owner ruling 2026-07-21: **do NOT change**; leave as-is).
  **pin-login verified working on prod.**
- Staff codes / SO ownership: 2990S-003 Bernard (13), 2990S-004 Ltrey (9), 2990S-005 Angel/kahwai (18),
  2990S-006 Scarlett (28) → **13+9+18+28 = 68 = all company_2 SOs**.

### Data in Houzs company_2 (prod) — sales/catalog/ERP-tail COMPLETE
- Sales core **100%** (kept fresh by the live mirror): SO 68 / items 202 / payments 62 / customers 71.
- Catalog + configurator + pricing **100%**: mfg_products 334, product_models 57, sofa_combo_pricing 246,
  product_compartments 225, product_size_variants (post-cleanup — 132 dangling rows deleted, PR #956;
  psv variants-per-product back to 4x for the 30 hot-sell products), product_bedframe_colours 90,
  maintenance_config_history 52, master_price_history 2463, fabrics 99, fabric_colours 56,
  bedframe_options 53, addons 11, special_addons 13, categories 7 (2 stray categories deleted, PR #956),
  so_dropdown_options 48, pwp_rules 3, sofa_quick_picks 77, libraries, singletons — all match 2990.
- ERP/stock tail **100%** (post PR #955 + APPLY): PO 42/86, GRNs 20/44, PIs 15/34, DO 16/40,
  inventory movements 80 / lots 52 / consumptions 27, pwp_codes 59, analysis_customer_targets 1,
  drivers 3, currencies 4, app_config 2, delivery_order_payments imported — all match 2990.
- localities: Houzs `scm.my_localities` = **5870** (superset of 2990's 2937). ✓
- `lorries` deliberately excluded from import per owner rule.

### Photos — DONE
- **48/48 model photos backfilled** into Houzs R2 (fetched from 2990's public proxy
  `api.2990shome.com/product-models/:id/photo/:key`, `wrangler r2 object put` to
  `houzs-erp/product-models/{id}/{uuid}.jpg`). All resolve HTTP 200 on Houzs.
- The `.schema('scm')` handler bug (main returned 404 on every photo) is fixed + deployed.

---

## 2. What needs to be done next

### A. ERP/stock data catch-up — DONE

Importer + APPLY run to completion on 2026-07-21. The 2990 service-role key was **not** a fresh blocker —
the existing `.github/workflows/migrate-2990.yml` GitHub Action already holds it as `SOURCE_SERVICE_ROLE_KEY`
(verified: the workflow ran successfully).

**Importer extension (PR #955, merged):** `backend/scripts/migrate-2990-into-houzs.mjs` `ORDER` now includes
`pwp_rules`, `pwp_codes`, `analysis_customer_targets`, `drivers`, `currencies`, `app_config`,
`delivery_order_payments`. `lorries` deliberately excluded (owner rule). `personal_quick_picks` handled
via the source→dest name remap (`sofa_personal_quick_picks` → `personal_quick_picks`).

**Stray-row incident + fix (PR #956, merged, BUG-HISTORY logged):** the verbatim-id importer had inserted
132 dangling `product_size_variants` rows (size_id pointed at 2990 uuids not in company_2 `size_library`)
plus 2 stray unreferenced categories. Both cleaned. Importer gained a `DANGLING_GUARD`
(psv → products, delivery_order_payments → delivery_orders) so re-runs cannot re-create them.
Configurator variants-per-product for the 30 hot-sell products is back to 4x (was 8x — broken).

**Final census (2990 → Houzs company_2), post-APPLY:**

| table | 2990 | Houzs co_2 |
|---|---|---|
| purchase_orders / items | 42 / 86 | **42 / 86** ✓ |
| grns / items | 20 / 44 | **20 / 44** ✓ |
| purchase_invoices / items | 15 / 34 | **15 / 34** ✓ |
| delivery_orders / items | 16 / 40 | **16 / 40** ✓ |
| inventory movements / lots / consumptions | 80 / 52 / 27 | **80 / 52 / 27** ✓ |
| pwp_rules / pwp_codes | 3 / 59 | **3 / 59** ✓ |
| analysis_customer_targets | 1 | **1** ✓ |
| drivers | 3 | **3** ✓ |
| currencies | 4 | **4** ✓ |
| app_config | 2 | **2** ✓ |
| accounts (GL) | 31 | **0** ← Ecount decision, §3 |

**Re-run** (should now be a no-op — `ON CONFLICT DO NOTHING` + `DANGLING_GUARD`):
```bash
gh workflow run migrate-2990.yml -R hello-houzs/Houzs-ERP  # DRY-RUN
gh workflow run migrate-2990.yml -R hello-houzs/Houzs-ERP -f apply=1  # APPLY
```

### B. Deploy the POS in houzs mode (front half of the flip)
- #732 is merged but dark. To point the POS at Houzs: build `apps/pos` with **`--mode houzs`** (loads
  `.env.houzs`) or set `VITE_BACKEND_TARGET=houzs` + `VITE_HOUZS_API_URL=https://erp.houzscentury.com/api/scm`
  + `VITE_HOUZS_COMPANY_ID=2` as CF Pages env vars, then deploy to `2990s-pos.pages.dev`.
- **CORS: verified `*`** on the Houzs worker — the POS from `2990s-pos.pages.dev` has no cross-origin
  barrier for bearer + `X-Company-Id`. Real login + catalog load from the deployed POS still needs a
  smoke pass, but the header wall is clear.
- **SO doc-no convention (confirmed with owner 2026-07-21):** post-flip the POS keeps the same
  `2990-SO-YYMM-NNN` pattern and continues from the last 2990-issued number — the next SO after
  `2990-SO-2607-018` is `2990-SO-2607-019`. The POS keeps displaying the `2990-` prefix
  (owner accepted option (a) — no display stripping).

### C. Staging rehearsal (recommended before touching prod)
- Build POS (houzs mode) and run the full flow end-to-end against Houzs: login → catalog/config render →
  create a test SO → confirm it lands in company_2 with `salesperson_id` + `company_id=2` → payment → slip.
- Houzs **staging** (`minnapsemfzjmtvnnvdd`) likely has no company_2 data — either seed it too, or rehearse
  read-paths against **prod** company_2 (safe) and only test-write in a throwaway.

### D. The flip — coordinated maintenance window (see `FLIP-RUNBOOK.md`)
1. Announce maintenance. Freeze 2990 writes.
2. Drain the 2990 outbox (flush pending mirror events) + stop 2990 crons.
3. Flip **`HOUZS_OWNS_2990=true`** on the Houzs worker **AND** deploy the POS houzs build **together**.
4. Smoke test: login + create one real SO on the live POS → confirm in Houzs company_2.
5. Keep rollback ready (POS build back to 2990 target + `HOUZS_OWNS_2990=false`).

### E. Decommission 2990 (after a safe soak)
- Turn off 2990 backend + crons; keep a read-only DB backup. Only after several clean days on Houzs.

### F. Salesperson-edit workflow (the daily amendment) — CONFIRMED with owner

Under Houzs, salespeople keep the same in-place SO edit habit they use on 2990: they open their own
SO and edit dates / items / customer directly — that IS the amendment. No dedicated amendment UI is
needed for the daily flow, and post-flip they'll edit in Houzs directly (no round-trip to 2990). The
Houzs-native admin-side amendment surfaces (`frontend/src/pages/scm-v2/Amendments.tsx`,
`AmendmentDetailV2.tsx`, `MobileAmendments.tsx`) exist for coordinator-side workflows and are unchanged.
- **Caveat (verification pending — do not commit to a resolution):** the POS-side "Processing date has
  passed — contact a coordinator" refusal in `queries.ts:2418-2421` may need loosening if it fires on
  the salesperson's in-place edit path post-flip. Confirm the trigger conditions on the deployed POS
  against the Houzs backend before deciding whether to relax it or leave as-is.

---

## 3. What's still NOT done / open items / caveats

- **`scm.accounts` (GL, 31 rows) — Ecount decision.** Owner supplies the Ecount export (chart of
  accounts for company_2); run the seed SQL that lives at
  `C:\Users\User\AppData\Local\Temp\claude\...\ecount-gl-seed.sql` (BEGIN / clear stale co_2 /
  INSERT one row per Ecount account / COMMIT — read the file header for the collision-with-company_1
  guidance). Nothing else in the accounts table is blocked by code.
- **SO line-item photos** (`mfg_sales_order_items.photo_urls` — per-order swatches / sketches) — these
  live in a **private** 2990 R2 bucket (`2990s-so-item-photos`), not the public catalogue path, so they
  were NOT backfilled. Only needed if the owner wants them; requires 2990 R2 S3 creds
  (`R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`).
- **Manager visibility (Bernard).** Bernard (id 130) is `sales_executive` on Houzs, so
  `mine?scope=all` is capped to his own orders and `GET /sales-analysis` returns 403
  (`scm.so.view_all`). If he needs team/analysis view, promote his Houzs position to a manager-level
  one. (Owner ruling so far: "do later.")
- **Pricing recompute parity pass.** 2990's CLAUDE.md warns that retiring the 2990 API means owning the
  port of `apps/api/src/lib/mfg-pricing-recompute.ts` + its 55-case test (the drift gate is NOT the one
  in `packages/shared`). Houzs SO-create works + has a drift gate (seam audit), but do a deliberate
  parity pass — feed a representative sample of live 2990 SOs through both engines and diff totals —
  before full retire.
