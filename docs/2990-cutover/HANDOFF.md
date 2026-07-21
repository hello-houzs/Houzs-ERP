# 2990 → Houzs Cutover — HAND-OFF

> **For whoever picks this up (has the owner's accounts).** Goal: fully replace the 2990
> backend so the 2990 POS runs entirely on Houzs (company 2), then retire 2990.
> Last updated: 2026-07-21. Read `CUTOVER-PLAN.md`, `DATA-FLOW.md`, `FLIP-RUNBOOK.md`
> in this folder for background; this file is the current state + what's left.

## TL;DR

- **Code / API / POS-side / accounts / photos: DONE and merged.**
- **Sales + catalog + configurator data: 100% complete + verified** (kept fresh by a live mirror).
- **The ONE real blocker:** the **ERP/stock data** (PO/DO/GRN/PI/inventory/GL) is frozen at the
  2026-07-20 import snapshot and has drifted (2990 kept trading). It has **no mirror**, so it needs
  a **re-run of the import script** — which needs the **2990 service-role key** (a secret; not saved
  in the repo, so it must be supplied again). This is *not* "can't be done" — it's "one key needed".
- After data is caught up: **deploy the POS in houzs mode** + do the **coordinated flip**.

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
  **PIN = `000000`** (default — should be reset). **pin-login verified working on prod.**
- Staff codes / SO ownership: 2990S-003 Bernard (13), 2990S-004 Ltrey (9), 2990S-005 Angel/kahwai (18),
  2990S-006 Scarlett (28) → **13+9+18+28 = 68 = all company_2 SOs**.

### Data in Houzs company_2 (prod) — sales/catalog COMPLETE
- Sales core **100%** (kept fresh by the live mirror): SO 68 / items 202 / payments 62 / customers 71.
- Catalog + configurator + pricing **100%**: mfg_products 334, product_models 57, sofa_combo_pricing 246,
  product_compartments 225, product_size_variants 132, product_bedframe_colours 90, maintenance_config_history 52,
  master_price_history 2463, fabrics 99, fabric_colours 56, bedframe_options 53, addons 11, special_addons 13,
  categories 7, so_dropdown_options 48, pwp_rules 3, sofa_quick_picks 77, libraries, singletons — all match 2990.
- localities: Houzs `scm.my_localities` = **5870** (superset of 2990's 2937). ✓

### Photos — DONE
- **48/48 model photos backfilled** into Houzs R2 (fetched from 2990's public proxy
  `api.2990shome.com/product-models/:id/photo/:key`, `wrangler r2 object put` to
  `houzs-erp/product-models/{id}/{uuid}.jpg`). All resolve HTTP 200 on Houzs.
- The `.schema('scm')` handler bug (main returned 404 on every photo) is fixed + deployed.

---

## 2. What needs to be done next

### A. Catch up the ERP/stock data — RE-RUN THE IMPORTER  ← the blocker

**Why it drifted:** the importer imported a snapshot on 2026-07-20. Sales data stays current because a
live **mirror** forwards SO/customer/staff/warehouse/amendment. But **PO/DO/GRN/PI/inventory/GL have NO
mirror** — they're frozen at the snapshot while 2990 kept trading.

**Current gaps (2990 → Houzs company_2):**

| table | 2990 | Houzs co_2 |
|---|---|---|
| purchase_orders / items | 42 / 86 | 34 / 70 |
| grns / items | 20 / 44 | 11 / 25 |
| purchase_invoices / items | 15 / 34 | 10 / 23 |
| delivery_orders / items | 16 / 40 | 6 / 15 |
| inventory movements / lots / consumptions | 80 / 52 / 27 | 43 / 33 / 10 |
| accounts (GL) | 31 | 0 |
| pwp_codes / personal_quick_picks / analysis_customer_targets | 59 / 1 / 1 | 53 / 0 / 0 |

**How to run** (`backend/scripts/migrate-2990-into-houzs.mjs`, idempotent — `ON CONFLICT DO NOTHING`):
```bash
cd backend
export SOURCE_SUPABASE_URL=https://dolvxrchzbnqvahocwsu.supabase.co
export SOURCE_SERVICE_ROLE_KEY=<2990 service_role key — Supabase → dolvxrchzbnqvahocwsu → Settings → API>
export DATABASE_URL=<Houzs prod Postgres conn string — Supabase → anogrigyjbduyzclzjgn → Settings → Database>
node scripts/migrate-2990-into-houzs.mjs            # DRY-RUN first (prints per-table counts, writes nothing)
APPLY=1 node scripts/migrate-2990-into-houzs.mjs    # then apply
```
**Before running, extend the script's `ORDER` list** — it currently covers staff/customers/sales-chain/
purchase-chain/inventory but NOT: `pwp_rules`, `pwp_codes`, `analysis_customer_targets`, `accounts`, and
`personal_quick_picks`. Notes:
- `personal_quick_picks`: the 2990 table is named **`sofa_personal_quick_picks`** but the Houzs table is
  **`personal_quick_picks`** — needs a source→dest name remap (the script assumes same names).
- `accounts` (GL): decide whether to migrate at all — Houzs GL is barely used (company_1 has 12 accounts,
  0 journal_entries). Only migrate if the owner runs accounting in Houzs.

**Verify after:** re-census company_2 counts and confirm they equal 2990's (exact). A quick check query
lives in the session notes; or just re-run the DRY-RUN and confirm "would insert 0".

### B. Deploy the POS in houzs mode (front half of the flip)
- #732 is merged but dark. To point the POS at Houzs: build `apps/pos` with **`--mode houzs`** (loads
  `.env.houzs`) or set `VITE_BACKEND_TARGET=houzs` + `VITE_HOUZS_API_URL=https://erp.houzscentury.com/api/scm`
  + `VITE_HOUZS_COMPANY_ID=2` as CF Pages env vars, then deploy to `2990s-pos.pages.dev`.
- **Pre-flight:** confirm the Houzs worker's CORS allows the POS origin (`2990s-pos.pages.dev`) for
  cross-origin browser requests (bearer + `X-Company-Id`). Test a real login + catalog load from the deployed POS.

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

---

## 3. What's still NOT done / open items / caveats

- **[BLOCKER] ERP/stock catch-up (§A)** — needs the 2990 service-role key. Nothing else in the data is missing.
- **3 small tables** (pwp_codes −6, personal_quick_picks −1, analysis_customer_targets −1) — closed by the
  same importer run once added to `ORDER`.
- **accounts / GL (31 rows)** — not migrated; decide if 2990's GL matters (Houzs GL lightly used).
- **SO line-item photos** (`mfg_sales_order_items.photo_urls` — per-order swatches/sketches) — these live in a
  **private** 2990 R2 bucket (`2990s-so-item-photos`), not the public catalogue path, so they were NOT
  backfilled. Only needed if the owner wants them; requires 2990 R2 S3 creds (`R2_ACCESS_KEY_ID`/`SECRET`).
- **Manager visibility** — Bernard (id 130) is `sales_executive` on Houzs, so `mine?scope=all` is capped to
  his own orders and `GET /sales-analysis` returns 403 (`scm.so.view_all`). If he needs team/analysis view,
  set his Houzs position to a manager-level one. (Owner: "do later.")
- **pos_carts** (8 in-progress carts) — ephemeral; not migrated (recreated on use).
- **Pricing recompute parity** — 2990's CLAUDE.md warns that retiring the 2990 API means owning the port of
  `apps/api/src/lib/mfg-pricing-recompute.ts` + its 55-case test (the drift gate is NOT the one in
  `packages/shared`). Houzs SO-create works + has a drift gate (seam audit), but do a deliberate parity pass
  before full retire.
- **Do NOT blindly merge the other open PRs** — ~16 on `wenwei4046/2990s` (June UI work: alert→toast,
  ColumnFilterBar) + ~13 on `Houzs-ERP` (ASSR/hardening/drafts) are unrelated to the cutover.

---

## The single thing to unblock everything

Supply the **2990 service-role key** (Supabase → `dolvxrchzbnqvahocwsu` → Settings → API → `service_role`)
and the **Houzs prod `DATABASE_URL`**, then run §A. That closes all remaining data gaps; after that it's
POS-houzs deploy (§B) + rehearsal (§C) + the coordinated flip (§D).
