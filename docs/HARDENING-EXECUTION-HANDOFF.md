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

## Published Draft PRs

| PR | Branch / head | Scope | State / next action |
|---|---|---|---|
| #906 | `hardening/frontend-search-scope-performance-gates` / `06b411ee` | Frontend search scope, first-codepoint search, responsiveness and performance gates | GitHub CI green. Hard dependency on #910. The 214-file frontend diff must pass staging search, pagination and responsiveness tests before merge. Await Claude Code review; no backend diff. |
| #907 | `docs/hardening-p0-coverage` / this branch | A–Z completion ledger and interruption-safe handoff | Keep current as batches land. Documentation is not proof that runtime work is complete. |
| #910 | `fix/global-search-first-character` / `42fa86d6` | Backend global search accepts first Unicode codepoint | Rebased onto `afd56500`; 9/9 focused tests, typecheck and all GitHub checks pass. Await Claude Code review. |
| #911 | `fix/idempotency-tenant-scope` / `c920fa74` | Idempotency phase 1 tenant scoping | Rebased onto `afd56500`; 19/19 backend and 11/11 frontend focused tests plus typechecks pass; GitHub checks green. Merge/deploy before #912, then soak 24 hours. |
| #912 | `fix/idempotency-phase2-constraints` / `b7960444` | Idempotency phase 2 constraints | Restacked on #911 `c920fa74`; 25/25 focused tests and typecheck pass. Never merge/deploy before the measured phase-1 soak. |
| #913 | `hardening/scale-performance-harness` / `25487ab2` | Deterministic scale/performance harness | GitHub CI green. Full backend run reached 1,328 passing assertions before a Vitest worker transport timeout; isolated scope suite passed 7/7. |
| #914 | `fix/migration-checksum-gate` / `46ef32b8` | Migration checksum/drift gate | Rebased onto `afd56500`. The 17 historical rows are preserved through an exact retirement manifest with SHA-256/Git-blob provenance; unknown orphan, checksum mismatch or filename reuse hard-fails. Full backend 109 files/1,514 tests and 35 focused tests pass. GitHub checks are rerunning; await Claude Code review and staging runner verification. |
| #917 | `docs/p0-route-matrices` / `ffe6df46` | 929-row executable route-capability inventory and CI/prod/staging drift gates | Rebased onto `c0e8d44d`; independent review P0=0/P1=0; all GitHub backend/frontend checks green. Duplicate impersonation route is pinned until D3 removes it. Await Claude Code review. |
| #918 | `fix/session-revocation-consistency` / `576b8a21` | Authoritative next-request session/authz validation and atomic collision-safe mail-alias transition | Rebased onto `afd56500`. PostgreSQL-reserved `current_user` CTE was renamed, regression-tested and recorded in BUG-HISTORY. Session tests 11/11, reserved-token regression 1/1, typecheck and prior full GitHub checks pass; docs-only rerun is active. Staging auth latency/outage evidence + Claude Code review pending. Fail-closed revocation must not silently fall back to stale cache. |

## Local branches not yet publishable

| Worktree | Branch / current head | Verified work | Blocking item / exact continuation |
|---|---|---|---|
| `C:\Users\User\Desktop\hz-d3-control-plane` | `fix/control-plane-privilege-boundary` / `d5285efe` before active fix | Atomic PG/D1 hard delete and one staging+Owner-only impersonation route; focused tests 33/33 and typecheck pass | Review found P0=0/P1=2: it must stack on #918 authoritative sessions, and privilege-sensitive target/role checks must be revalidated inside the same boundary transaction to close promotion/grant TOCTOU races. Fix is active; do not publish yet. |
| `C:\Users\User\Desktop\hz-so-cas-mandatory` | `fix/so-cas-mandatory` / `8baa8226` before active fix | First full-stack closure pass: special-route lease, versioned frontend coordinator, status/delete/system generations, 0161 header/follower RPC, payment row CAS and amendment serialization | Independent review found P0=1/P1=7. Full exact findings and acceptance: [`reviews/SO-CAS-CLOSURE-REVIEW-2.md`](reviews/SO-CAS-CLOSURE-REVIEW-2.md). Fix is active. Never publish `8baa8226`. |

## Hard rollout gates

These conditions override branch readiness and green CI:

1. **#912:** #911 must be merged and deployed first, then complete a measured 24-hour production soak. The soak clock starts only after the #911 deployment is confirmed. Do not merge or deploy #912 early.
2. **#914:** do not delete the 17 verified tracker rows and do not restore their SQL into the live migration directory. The exact retirement manifest is the audit-preserving release gate; stage checksum verify/apply/deploy and require any unknown orphan, checksum mismatch or filename reuse to abort.
3. **#906:** #910 must land first. Because #906 changes 214 files, staging verification of all search scopes, cross-page results, first-character refinement and responsiveness is mandatory.
4. **#918:** the reserved-keyword fix in `dd7f381d` (current branch head `576b8a21`) must be green in GitHub and staging must measure authoritative-auth database latency and outage behavior. Preserve fail-closed revocation unless an explicit security architecture decision changes it.

## Active local branch corrections

- D3 head `a88883c8` closes the user/role/impersonation transaction recheck findings and passed 110 backend files / 1,533 tests, typecheck and diff check. Its rebase onto #918's latest code baseline is active; publish only after independent review.
- SO head `62caced2` repairs the compile/mobile/payment findings and wraps amendment and TBC/sofa multi-write paths in PostgreSQL command transactions with real-PG CI. Independent review of the transaction adapter and full call surface is active; never publish the earlier `8baa8226` or `e2b781bc` heads.

## Database ordering and rollout

The current migration chain is:

`0158 idempotency phase 1 → deploy → 24-hour soak/telemetry → 0159 phase 2 constraints → 0160 SO edit lease/followers → 0161 SO concurrency-domain closure → application code`

Session consistency required no migration. `0161` is now reserved exclusively for the SO concurrency-domain closure. Before applying any migration, re-read the branch against current `legacy/main`, run checksum/drift validation, take the documented restore point, and record the exact deployed commit.

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
