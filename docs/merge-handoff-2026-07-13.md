# 2990 → Houzs Merge — HANDOFF (2026-07-13)

> For whoever continues this work (another Claude session or IT). Self-contained.
> 中文摘要在文末。

## Mission
Merge the 2990 furniture ERP into Houzs ERP (**Houzs is the base**; one backend,
one frontend, one DB; company switcher on top). POS is **OUT of scope** (owner
decision — office backend / SCM module only). End state: `erp.2990shome.com`
points at the merged system (hostname auto-defaults company 2990), old 2990
backend frozen.

## Endpoints & channels
| Thing | Where |
|---|---|
| Merge base repo | `hello-houzs/Houzs-ERP` (main auto-deploys prod AND applies `backend/src/db/migrations-pg/` — never push unready migrations) |
| Prod app | erp.houzscentury.com (Houzs DB: Supabase `anogrigyjbduyzclzjgn` via Hyperdrive) |
| Staging app / DB | houzs-erp-staging.pages.dev / Supabase `minnapsemfzjmtvnnvdd`; GitHub `Staging` environment holds `STAGING_DATABASE_URL` |
| 2990 data source | 2990's Supabase `dolvxrchzbnqvahocwsu` via repo secrets `SOURCE_SUPABASE_URL` + `SOURCE_SERVICE_ROLE_KEY` (read-only use) |
| 2990 repo (still live until cutover) | `wenwei4046/2990s` (⚠️ local tree C:\Users\User\Desktop\2990s is SHARED LIVE with Loo — read-only; work from fresh clones) |
| Ops workflows (Actions tab) | `migrate-2990.yml` (import; `apply=1` writes), `diag-2990.yml` (read-only audit: FK / cross-company / completeness), `rollback-2990.yml` (remove all company-2990 rows). **All take `target` = `staging` (default) / `prod` (explicit)** — owner rule: staging first, prod only after staging verified. |
| Ops scripts (canonical versions) | branch **`diag/company-separation`**: `backend/scripts/migrate-2990-into-houzs.mjs` (v3d: auto-discovers all source tables; value-driven id-remap: numeric +100000 / uuid first-4→"2990" / text "2990-" prefix; doc numbers + all doc-ref columns get `2990-` prefix; FK-graph-driven reference remapping), `diag-2990-import.mjs`, `rollback-2990-from-houzs.mjs` |

## State: DONE (merged to main, live on prod+staging)
1. **Dropship hardening** 3 CRIT + 4 HIGH + 2 latent FIFO company_id bugs — PR #349, mig 0088.
2. **0089/0090** — company_id on 16 config tables + per-company uniques + purchase-consignment tables created (fixed live 500) — PR #351.
3. **0091** — `company_id DEFAULT <HOUZS>` on every company_id column (P0 incident fix: unstamped INSERTs were 500ing, e.g. scan). Scan works again.
4. **0092** — per-company unique conversions + `state_warehouse_mappings` scoped.
5. **Stamp sweep** — 318 insert sites audited, 30 gaps stamped, scan queue replays company — PR #354. (0091 default is now just a safety net.)
6. **Sync ports** — combo price tie-break, SKU rename 22-table cascade, #718 FE save fix — PR #353. **Feature gap 2990→Houzs is CLOSED** (only owner-optional: demographics / sales-analysis / quotes — all POS-driven).
7. **DO Source PO + Rack for ALL categories** (owner-reported) — 2990 PR #721 **live**, Houzs port PR #355 merged. Data note: rack shows "—" where warehouse never picked a rack on GRN (backfill via Warehouse module).

## State: STAGING DATA = CLEAN ✅
`diag-2990.yml target=staging`: **FK_AUDIT_CLEAN, XCOMPANY_CLEAN**, NULL company_id only 4 currencies rows (shared by design), completeness gaps = 3 intentional skips (accounts = shared chart of accounts; currencies = shared; app_config = key-PK, deferred). All 8,706 source rows accounted for.
**PROD currently holds NO 2990 data** (rolled back clean per owner's staging-first order). Re-import = run `migrate-2990.yml` target=**prod** apply=1 **from branch `diag/company-separation`** after owner eyeballs staging.

## State: TWO WIP BRANCHES (agents killed by Claude spend limit — UNVERIFIED, do NOT merge blind)
1. **`fix/native-module-company-scoping`** (P0 leaks): scope Houzs-native modules for company 2990 — projects / announcements / events(calendar) / search / assr reads / notifications+inbox + new mig `0093_native_tables_company_id.sql`. Agent died mid-`projects.ts`. **Finish → tsc → tests → PR → merge.** Without this, 2990 users see Houzs projects/announcements/calendar/search results.
2. **`feat/per-company-branding`** (P1 identity/抬头): per-company branding store (`branding:<companyCode>` in app_settings, fallback legacy), de-hardcoded `assr_print.ts`/`projects_print.ts`, email identity, mig `0093_branding_2990.sql`. Backend done; frontend partial (`frontend/src/lib/branding.ts` started; still to do: pdf-common COMPANY + vendored SCM PDF headers must render the DOC's company identity). **Finish frontend → tsc -b both → PR → merge.** Owner must later fill 2990's real reg-no/address in branding settings; a 2990 Resend sender domain is an ops TODO.

## Remaining (in order)
1. Finish + merge the two WIP branches above.
2. **Staging smoke test** (agent died early): login staging (test creds in `backend/scripts/seed-user-management.mjs`, pw pattern houzs1234), verify: company switcher appears & switches; 2990 company shows ONLY `2990-`-prefixed docs (62 SOs), 334 products, 7 warehouses; HOUZS side unchanged; shared modules (users/staff/audit/currencies) same on both; a `2990-SO-…` detail opens clean; console/network no 4xx/5xx.
3. Owner eyeballs staging (switch company, click around).
4. Prod re-import (workflow target=prod) + prod diag → same CLEAN result.
5. **Phase 3 cutover**: point `erp.2990shome.com` at merged system, freeze old 2990 backend+API (POS untouched, per owner). One-click step for owner.
6. Owner decisions pending: Fix C (special-order dual channel), customer demographics, sales-analysis+targets, quotes module.
7. P2 (post-cutover): Mail Center per-company mailbox/domain, AutoCount lookups gated to HOUZS only, fleet/audit company tag columns.

## Gotchas for the continuer
- Houzs main push = deploy + AUTO-APPLY migrations (staging + prod). Migrations must be idempotent single-line DO blocks (runner splits on `;\n`).
- `DEFAULT` can't be a subquery — resolve company id into a variable, `EXECUTE format(...)` (see 0091/0092).
- Two `0093_*.sql` files exist on the two WIP branches (different names — they can coexist; runner sorts by filename).
- Don't touch C:\Users\User\Desktop\Houzs-ERP-cutover or C:\Users\User\Desktop\2990s working trees (shared with Loo). Fresh clones only.
- Inside `/api/scm/*`: `c.get('user').id` = scm.staff UUID, `c.get('houzsUser').id` = public bigint (classic 500 trap).

---
## 中文摘要
数据线：staging 已全清（FK/跨公司/完整性三项全过，8706 行全部处置）；prod 目前是空的（按老板指示已撤线），等 staging 过目后用 workflow（target=prod）一次性回填。功能线：2990→Houzs 功能差已清零，dropship 加固、stamp 根治、Source PO 全品类等 8 个 PR 已合并上线。**剩两个半成品分支**（原生模块公司隔离 + 每公司抬头/PDF 身份），因 Claude 月度额度打满被掐断，代码已保底在 GitHub 分支上 —— 续做的人先完成这两个分支（验证后合并），再跑 staging 冒烟，老板过目后回填 prod、切域名。POS 不做。三个待老板拍板项：Fix C / 客户人口统计 / 销售分析。
