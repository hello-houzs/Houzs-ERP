# HOUZS ERP Hardening — Execution Handoff

Last updated: 2026-07-21 (Asia/Kuala_Lumpur)  
Canonical repository: `hello-houzs/Houzs-ERP`  
Integration base: `legacy/main`  
Task source of truth: [`HARDENING-COMPLETION-LEDGER.md`](HARDENING-COMPLETION-LEDGER.md)

This file is the interruption-safe continuation record. The completion ledger contains the complete A–Z scope and acceptance criteria. This handoff contains only the exact execution state needed for another agent to continue without re-auditing the repository.

## Non-negotiable delivery policy

1. Completed work with P0=0 and P1=0 goes to a **Draft PR**.
2. A local branch with an unresolved P0/P1 is not pushed and is not represented as complete.
3. Claude Code review and green required checks are merge gates.
4. Do not merge stacked database changes out of order. Do not auto-merge `main`.
5. Preserve the user-owned `package-lock.json` change in `C:\Users\User\Desktop\houzs-erp`; never stage or overwrite it.
6. Production migration/deploy remains a separate explicit operation after merge approval.
7. Owner authorization on 2026-07-21 covers backend/API/database hardening work in this A–Z scope without repeated per-file confirmation. This does not authorize production data mutation, deployment, migration application or automatic merge. Position privilege assignment/control remains backend-owned; do not add a frontend position-privilege controller.

## Published Draft PRs

| PR | Branch / head | Scope | State / next action |
|---|---|---|---|
| #906 | `hardening/frontend-search-scope-performance-gates` / `6970b163` | Frontend search scope, first-codepoint search, responsiveness and performance gates | Rebased onto `afd56500`; GitHub CI green. Hard dependency on #910. The 214-file frontend diff must pass staging search, pagination and responsiveness tests before merge. Await Claude Code review; no backend diff. |
| #907 | `docs/hardening-p0-coverage` / this branch | A–Z completion ledger and interruption-safe handoff | Keep current as batches land. Documentation is not proof that runtime work is complete. |
| #910 | `fix/global-search-first-character` / `42fa86d6` | Backend global search accepts first Unicode codepoint | Rebased onto `afd56500`; 9/9 focused tests, typecheck and all GitHub checks pass. Await Claude Code review. |
| #911 | `fix/idempotency-tenant-scope` / `c920fa74` | Idempotency phase 1 tenant scoping | Rebased onto `afd56500`; 19/19 backend and 11/11 frontend focused tests plus typechecks pass; GitHub checks green. Merge/deploy before #912, then soak 24 hours. |
| #912 | `fix/idempotency-phase2-constraints` / `b7960444` | Idempotency phase 2 constraints | Restacked on #911 `c920fa74`; 25/25 focused tests and typecheck pass. Never merge/deploy before the measured phase-1 soak. |
| #913 | `hardening/scale-performance-harness` / `7afb3feb` | Deterministic scale/performance harness | Rebased onto `afd56500`; fail-closed runner correction landed and all GitHub checks are green. Await Claude Code review and a staging-scale run. |
| #914 | `fix/migration-checksum-gate` / `46ef32b8` | Migration checksum/drift gate | Rebased onto `afd56500`. The 17 historical rows are preserved through an exact retirement manifest with SHA-256/Git-blob provenance; unknown orphan, checksum mismatch or filename reuse hard-fails. Full backend 109 files/1,514 tests and 35 focused tests pass; GitHub checks are green. Await Claude Code review and staging runner verification. |
| #917 | `docs/p0-route-matrices` / `d6012808` | 929-row executable route-capability inventory and CI/prod/staging drift gates | Rebased onto `afd56500`; independent review P0=0/P1=0; all GitHub backend/frontend checks green. Duplicate impersonation route is pinned until D3 removes it. Await Claude Code review. |
| #918 | `fix/session-revocation-consistency` / `576b8a21` | Authoritative next-request session/authz validation and atomic collision-safe mail-alias transition | Rebased onto `afd56500`. PostgreSQL-reserved `current_user` CTE was renamed, regression-tested and recorded in BUG-HISTORY. Session tests 11/11, reserved-token regression 1/1, typecheck and all GitHub checks pass. Staging auth latency/outage evidence + Claude Code review pending. Fail-closed revocation must not silently fall back to stale cache. |
| #922 | `fix/request-correlation-hardening` / `5d337ef8` | Browser→Worker request correlation and raw-fetch inventory enforcement | Independent branch-scope review P0/P1/P2=0; focused 29/29 and inventory 8/8 pass. Both duplicate GitHub CI runs are fully green. Await Claude Code review; no merge automation. |
| #923 | `fix/dependency-security-upgrades` / `28ec9b24` | Production document/HTTP dependency security upgrades plus real legacy-XLS and CJK-PDF compatibility coverage | Independent review P0/P1=0; production audits are zero, frontend 32 files/417 tests, typecheck/build/bundle and all GitHub checks pass. Staging/browser logo, CJK PDF download, XLSX download and operator legacy-XLS upload remain merge gates. |
| #924 | `fix/project-detail-test-flake` / `62f966bb` | Test-only removal of the reproducible ProjectDetail full-suite import timeout | Stacked on #923. Independent review P0/P1/P2=0; focused test passed five consecutive runs, full frontend 413/413, typecheck and all GitHub checks pass. Merge #923 first, then retarget to main. |
| #925 | `chore/test-toolchain-security` / `e2110504` | Supported Vitest 4, Cloudflare Workers pool, Wrangler and Vite 8 toolchains with fail-closed fetch mocks and preserved bundle budgets | Stacked on #924. Independent review P0/P1/P2=0 after three P2 corrections; backend focused 129/129, frontend 417/417, audits/typechecks/build/bundle pass. GitHub CI and Claude Code review pending. |

## Local branches not yet publishable

| Worktree | Branch / current head | Verified work | Blocking item / exact continuation |
|---|---|---|---|
| `C:\Users\User\Desktop\hz-d3-control-plane` | `fix/control-plane-privilege-boundary` / `ef1e06b5` | Position last-admin protection, scoped/atomic department changes, service principals, invitation credential redaction, impersonator revocation and control-plane real-actor provenance; PG 0163/0164 + D1 127/128/129 parity | Remediation complete; backend 111 files/1,556 tests, frontend 31 files/415 tests, both typechecks/build and leak scan pass. Must receive a fresh independent review before publish; never publish the superseded `5c42bf0c`. |
| `C:\Users\User\Desktop\hz-so-cas-mandatory` | `fix/so-cas-mandatory` / `3c03f4fb` | Mandatory SO CAS, explicit JSONB/text[] codecs, durable allocation invalidation queue and retry worker | Remediation tests pass, including 16/16 transaction/outbox and 14/14 worker/migration tests. Requires independent re-review and real PostgreSQL CI before publish. Stack after #912; PG migrations 0160-0162 precede D3 0163. |
| `C:\Users\User\Desktop\hz-company-scope-rollout` | `fix/company-scope-rollout` / `c4aa28be` before second active correction | Company grant resolution, fail-closed mutation guards, readiness audit and bounded rollout telemetry | First P0 set is repaired, but re-review found native/non-SCM fail-open reads and writes in Sales, POS, Finance, Projects and Events when no active company exists. Corrections are active; never publish `c4aa28be`. |
| `C:\Users\User\Desktop\hz-request-correlation` | `fix/request-correlation-hardening` / `5d337ef8`; Draft PR #922 | Browser→Worker request ID correlation, Reset Password coverage and precise raw-fetch inventory gate | Independent review P0/P1/P2=0 in branch scope; focused 29/29, inventory 8/8, typechecks/build/bundle and all GitHub checks pass. Await Claude Code review. |
| `C:\Users\User\Desktop\hz-dependency-security` | `fix/dependency-security-upgrades` / `28ec9b24`; Draft PR #923 | Hono, React Router, PDF, DOMPurify and official SheetJS security upgrades; production audits zero; real legacy-XLS and CJK-PDF tests | Independent review is clean; frontend 417/417, typecheck/build/bundle and all GitHub checks pass. Await Claude Code review and staging/browser document smoke. |
| `C:\Users\User\Desktop\hz-test-toolchain-security` | `chore/test-toolchain-security` / `e2110504`; Draft PR #925 | Stacked on #924; backend/frontend Vitest 4.1, Cloudflare pool 0.18, Vite 8.1 and Wrangler 4.112 migration | Independent review P0/P1/P2=0; backend focused 129/129 and typecheck pass; frontend 417/417, audits/typecheck/build/bundle pass at 157.0/165 KB initial and 1704.2/1800 KB total. GitHub CI and Claude Code review pending. |
| `C:\Users\User\Desktop\hz-project-detail-test-flake` | `fix/project-detail-test-flake` / `62f966bb`; Draft PR #924 | Test-only fix moving the 9k-line Projects module import out of the five-second behavioral test timeout | Independent review P0/P1/P2=0; focused passed five consecutive runs and full frontend 413/413 passes with unchanged assertions/timeouts. Stacked on #923. |
| `C:\Users\User\Desktop\hz-staging-e2e-truth` | `fix/staging-e2e-proof-truth` / `34356fb6` | Makes automated staging E2E fail closed when authenticated proofs are skipped | Scheduled `afd56500` evidence was false green (`1 passed, 3 skipped`). Local policy tests 4/4, E2E typecheck and eight-test discovery pass. Await independent review before push; provisioning valid staging credentials/fixture remains an operational gate. |

## Hard rollout gates

These conditions override branch readiness and green CI:

1. **#912:** #911 must be merged and deployed first, then complete a measured 24-hour production soak. The soak clock starts only after the #911 deployment is confirmed. Do not merge or deploy #912 early.
2. **#914:** do not delete the 17 verified tracker rows and do not restore their SQL into the live migration directory. The exact retirement manifest is the audit-preserving release gate; stage checksum verify/apply/deploy and require any unknown orphan, checksum mismatch or filename reuse to abort.
3. **#906:** #910 must land first. Because #906 changes 214 files, staging verification of all search scopes, cross-page results, first-character refinement and responsiveness is mandatory.
4. **#918:** the reserved-keyword fix in `dd7f381d` (current branch head `576b8a21`) must be green in GitHub and staging must measure authoritative-auth database latency and outage behavior. Preserve fail-closed revocation unless an explicit security architecture decision changes it.
5. **Claude Code review:** `claude auth status` reported logged in on 2026-07-21, but both `claude ultrareview` and the direct print reviewer failed because the OAuth access token is expired. Re-authenticate Claude Code before satisfying the mandatory cross-model merge gate; this blocks merge, not continued implementation or local/GitHub CI.

## Active local branch corrections

- D3 head `ef1e06b5` closes the wildcard invitation takeover, token/link exposure, impersonator-session revocation, locked-invite race and service-invite atomicity gaps. Full backend/frontend suites pass, but the 6,962-line security diff remains unpublished until a different agent independently re-reviews it. Never publish superseded `5c42bf0c`.
- SO head `3c03f4fb` repairs JSONB/text-array codecs and makes allocation invalidation durable with lease/retry behavior. Its focused transaction/outbox and worker/migration tests pass; independent re-review plus real PostgreSQL CI remain mandatory. Never publish the earlier `8baa8226`, `e2b781bc` or `62caced2` heads.
- Company scope head `c4aa28be` is not publishable. Re-review found fail-open native/non-SCM handlers in Sales, POS, Finance, Projects and Events; the next remediation must prove every real handler fails closed, not only the helper layer.
- Request correlation head `5d337ef8` is published as Draft PR #922. Branch-scope independent review is clean; GitHub CI and Claude Code review remain gates.
- Dependency security head `28ec9b24` is published as Draft PR #923; ProjectDetail flake head `62f966bb` is stacked as Draft PR #924. Neither may merge before its documented review and staging gates.

## Database ordering and rollout

The current migration chain is:

`0158 idempotency phase 1 → deploy → 24-hour soak/telemetry → 0159 phase 2 constraints → 0160/0161/0162 SO CAS/outbox → 0163/0164 D3 privilege boundary → application code`

Session consistency required no migration. D1 D3 parity additionally requires migrations `127`, `128` and `129` together; never deploy D3 code with only part of that set. Before applying any migration, re-read the branch against current `legacy/main`, run checksum/drift validation, take the documented restore point, and record the exact deployed commit.

## Merge conflict order

1. Merge/rebase the session consistency change first.
2. Rebase the D3 control-plane change because both can touch `backend/src/routes/users.ts` and bug-history documentation.
3. Keep idempotency #911/#912 and SO migration work in the database order above.
4. Route inventory and scale harness may merge independently after review, but regenerate their artifacts against the final base.

## Recovery commands

Run these read-only commands first:

```powershell
git -C C:\Users\User\Desktop\houzs-erp fetch legacy
git -C C:\Users\User\Desktop\houzs-erp worktree list
git -C C:\Users\User\Desktop\hz-p0-route-matrices status --short
git -C C:\Users\User\Desktop\hz-session-revocation status --short
git -C C:\Users\User\Desktop\hz-d3-control-plane status --short
git -C C:\Users\User\Desktop\hz-so-cas-mandatory status --short
```

Then read this handoff, the completion ledger and the relevant branch diff before editing. Do not use `git reset --hard` or clean untracked files. The next safe work unit is whichever active branch has a completed independent review; publish that branch as a Draft PR and record the PR here.

## Definition of takeover-ready

Another agent can take over when it can identify, without chat history:

- the canonical remote and integration base;
- every published and unpublished batch;
- exact worktree, branch and head;
- validation already completed;
- unresolved P0/P1 blockers;
- database and merge order;
- the next safe command and the no-auto-merge rule.

This document is kept to that standard after every publishable batch.
