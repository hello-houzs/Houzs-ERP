# Session handoff — 2990 → Houzs go-live hardening (2026-07-24)

Working clone: `Desktop/hz-baseline` = `hello-houzs/Houzs-ERP`. Multi-company:
HOUZS = `company_id 1`, 2990 = `company_id 2` (migrated from `wenwei4046/2990s`).
The owner is **live-testing 2990 data inside Houzs** and deciding whether to
call it "fully live". This session was a rapid owner-feedback loop: fix UI/data
issues + verify the migration with read-only diagnostics. Most work was fanned
out to background agents that opened PRs.

`main` has **no branch protection** — you are the merge gate. Re-check CI green
+ `mergeStateStatus` immediately before merging. Local `vitest` is broken in
this clone (`@cloudflare/vitest-pool-workers`) — rely on CI; `typecheck` runs
locally. Migrations: live tree `backend/src/db/migrations-pg/` auto-applies on
merge; take the next number at MERGE time (latest merged so far: **0187**).

---

## ⚠️ CRITICAL LESSON from this session — verify background merges
The background "watch-and-merge" one-liners **failed silently**: they ran
`gh pr checks` / `git fetch` from the wrong cwd (`C:\Users\User`, not the repo)
→ "not a git repository" → the `&&` chain broke before `gh pr merge`, but the
outer `echo "done $?"` printed 0 and the task reported success. Result:
**#1174 / #1167 / #1164 never merged** even though the logs said "MERGED", so the
owner "didn't see" the deployed changes. **ALWAYS `gh pr view <n> --json state`
after any background merge.** Prefer `git -C <repo>` / `gh --repo <owner/repo>`,
or just merge in the foreground.

---

## Merged this session (LIVE on main)
See `git log origin/main` for the full list; the notable ones:
- **#1158** supplier detail 404 → calm "belongs to 2990, switch" instead of "gone" (+ `detailMissResponse` helper, `docs/cross-company-detail-404-coe.md`).
- **#1156 / #1159** Fabric Converter Supplier Code column restored + `fabricDualCode` now parens `BF-01 (PC151-01)`; backfill finding: 2990 already has the codes, HOUZS's 705 fabrics are a different catalog not in 2990.
- **#1160** Pricing "Option B" foundation — mig 0187 `scm.mfg_product_price_history` + resolver `product-pricing-history.ts` (inert; `docs/pricing-effective-dating-design.md`).
- **#1167** Pricing write endpoint `POST/GET /mfg-products/:id/price-changes` + Product Maintenance timeline UI + `backend/scripts/backfill-product-price-baseline.mjs` (DRY-RUN gated). Does NOT touch the recompute.
- **#1164** StatePicker: grouped-by-country + type-search + bordered UI (matched siblings) + dropped Others backdoor.
- **#1169** Columns panel sorted A-Z + removed "Clear POS PIN" (security; Set/Reset kept).
- **#1161** Mobile self-service change-password (desktop already had it; POS is PIN-based).
- Diagnostics (read-only, re-runnable via Actions): **#1157** supplier reachability, **#1168/#1173** migration completeness, **#1176** DO-payments forensic.
- **#1171** `docs/add-company-design.md`. **#754** (wenwei4046/2990s) reversible read-only freeze — MERGED, switch **OFF**.

## Open PRs — NEED ATTENTION
- **#1174** on-screen order lines: CODE-only + variant everywhere + fabric `(PC151-01)`. **CONFLICTING** with Fair Report branding (#1163/#1175). Agent `a62fd581d5614a326` is resolving (keep both sides) — merge when green. Owner's #1 UI complaint; NOT yet live.
- **`fix/so-processing-date-display`** — SO read views show the legacy `processing_date` column (null) instead of the real `internal_expected_dd` (PR #140 renamed the LABEL to "Processing date", not the column). Agent `aeb652f73e4b21d7c` sweeping all SO surfaces. Merge when green.
- **#1165** `mig 0188_percompany_natural_key_masters` — per-company UNIQUE on `accounts`/`product_models`/`product_dept_configs`/`pwp_codes` (prereq for company 3). Touches **accounting FKs** (re-added `NOT VALID`, cannot fail on existing rows). **Review the SQL before merge.** Not urgent.
- `chore/diag-do-payments` etc. — read-only diags, safe.

## Migration integrity (the go-live evidence)
Diags ran vs prod (2990 source vs Houzs company_2). **Counts: every doc type
with data is fully migrated except structure.** Two real items + one non-issue:
1. **12 SOs lost DELIVERED status.** 2990 had 19 SOs DELIVERED; Houzs shows 7.
   Houzs derives SO-delivered from a delivered DO/SI, but all DOs are DISPATCHED
   (faithfully — 2990 never marked DOs delivered) and there are 0 SIs. **This is
   why the Sales Report "Delivered" shows ~5-7 not 19.** OWNER DECISION: were the
   goods actually delivered? If yes → backfill the 12 SOs' DELIVERED status.
2. **13 DO payments NOT migrated = CORRECT.** Forensic (#1176) proved all 13 are
   EXACT DUPLICATES of SO-level payments already in Houzs (2990 wrote each deposit
   to both the SO and DO ledger; the SO copy migrated). Additional money = **RM0**.
   Backfilling would DOUBLE-COUNT **RM29,104**. **DO NOT backfill.** Owner also
   asked: DO shouldn't keep its own payments; DO balance should derive from SO —
   pending his answer to "do drivers collect payment at delivery (COD)?" (if no →
   simplify DO to derive balance from SO; if yes → DO payments are legit COD).
3. **Costing: clean.** No cost dropped by migration; the visible RM0 costs
   pre-existed in 2990 (15/68 SOs, 86/203 lines were uncosted in 2990).

## Open OWNER decisions (blocking / needed)
- **① 12 SO DELIVERED status** — restore to match 2990? (goods actually delivered?)
- **DO payments / balance** — do drivers collect at delivery (COD)? decides DO payment model.
- **#104 Sales Director POS perms** — 4 "Sales Director"-position users have `scm.staff.role='sales'` → the live POS (gates on `staff.role`) makes them READ-ONLY. No "Assistant Director" position exists. FIX (pending owner mapping): should Sales Director → full POS (matches 2990)? Sales Manager (5) / Finance Manager (2) too, or view-only? Cleanest fix = sync `scm.staff.role` from `public.positions`, OR make the POS gate on position. Evidence: `diag-pos-role-access` workflow.
- **#103 Outstanding = Revenue** — needs the owner's screenshot (which page). The SO-list KPI is already correct.
- **Add-company** (`docs/add-company-design.md`): needs the account-book/chart-of-accounts template source. Key landmine: `doc-no.ts:159 jePrefixForCompany` hardcodes `companyId===1?'':'2990-'` → company-3 journal entries would mint `2990-…` and collide. Owner wants it "like Hookka ERP" — but Hookka's multi-company is thin (a name registry, everything global); Houzs already isolates more. Reference: `Desktop/Hookka/hookka-main`.

## Known gaps / follow-ups (not yet started)
- **Supplier 404 backend root cause OWED.** Owner insists: in Houzs you should never reach a 2990 supplier; find WHERE a Houzs surface links to a 2990 supplier id (list leak? child row? scorecard?). Data is clean (0 orphan/cross-company per `diag-supplier-reachability`). My #1158 fix only softened the message. When the owner hits it again, get the exact entry page.
- **processing_date column cleanup** — owner: "why so many processing dates?" There is ONE user date = `internal_expected_dd`; `processing_date` is a dead legacy snapshot (confusing), `proceeded_at` is the POS Proceed timestamp (different concept). After the read-fix (`fix/so-processing-date-display`), retire the legacy `processing_date` column so the DB has one too (a migration + code sweep).
- **SELLING & COST surface** — owner still sees "code · description" with no variant on an "ORDER LINES · SELLING & COST" table (LOTTI/XAMMAR). #1174 targets Fair Report; verify that IS the component the owner sees (could be `SalesOrderDetailListing` / a P&L view) and cover it.
- **Price backfill** — after #1167 deploys, run `backfill-product-price-baseline` DRY-RUN → review → apply (reconstructs price dates from `master_price_history`).
- **Pricing phase 3** — order read-integration (`mfg-pricing-recompute.ts` taking the as-of price on the doc date). MONEY-CRITICAL, held for a dedicated CI-verified pass (multiple price paths: catalog sell / sofa module / PWP). NOT done deliberately.
- **#98** Members per-company filter; **#101** email reset — verify Resend config (RESEND_API_KEY + verified EMAIL_FROM) actually delivers (change-password code is done on desktop+mobile).

## Live-test deploy note for the owner
After merging FE PRs, the deploy takes ~5-8 min; the PWA caches — the owner must
HARD REFRESH (`Ctrl+Shift+R`) or use the PWA update banner. Several "you didn't
see it" reports were the unmerged PRs above + PWA cache.

## Housekeeping
Worktrees linger at `Desktop/hz-baseline-worktrees/*` (they block local branch
deletion on merge — remote merge still succeeds). Prune when the agents finish:
`git worktree prune` + `git worktree remove <path>`.
