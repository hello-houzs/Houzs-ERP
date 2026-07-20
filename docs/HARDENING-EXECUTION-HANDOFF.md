# HOUZS ERP Hardening — Execution Handoff

Last updated: 2026-07-20 (Asia/Kuala_Lumpur)  
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
| #906 | `hardening/frontend-search-scope-performance-gates` / `06b411ee` | Frontend search scope, first-codepoint search, responsiveness and performance gates | GitHub CI green. Await Claude Code review; no backend diff. |
| #907 | `docs/hardening-p0-coverage` / this branch | A–Z completion ledger and interruption-safe handoff | Keep current as batches land. Documentation is not proof that runtime work is complete. |
| #910 | `fix/global-search-first-character` / `24920d38` | Backend global search accepts first Unicode codepoint | GitHub CI green. Await Claude Code review. |
| #911 | `fix/idempotency-tenant-scope` / `0edd8878` | Idempotency phase 1 tenant scoping | GitHub CI green. Merge/deploy before #912, then soak 24 hours. |
| #912 | `fix/idempotency-phase2-constraints` / `ba91fca7` | Idempotency phase 2 constraints | GitHub CI green. Stacked on #911; never merge/deploy before phase 1 soak. |
| #913 | `hardening/scale-performance-harness` / `25487ab2` | Deterministic scale/performance harness | GitHub CI green. Full backend run reached 1,328 passing assertions before a Vitest worker transport timeout; isolated scope suite passed 7/7. |
| #914 | `fix/migration-checksum-gate` / `ce9a09a5` | Migration checksum/drift gate | GitHub CI green. Await Claude Code review and deployment-runbook verification. |
| #917 | `docs/p0-route-matrices` / `ffe6df46` | 929-row executable route-capability inventory and CI/prod/staging drift gates | Rebased onto `c0e8d44d`; independent review P0=0/P1=0; all GitHub backend/frontend checks green. Duplicate impersonation route is pinned until D3 removes it. Await Claude Code review. |
| #918 | `fix/session-revocation-consistency` / `6efc20af` | Authoritative next-request session/authz validation and atomic collision-safe mail-alias transition | Rebased onto `c0e8d44d`; independent review P0=0/P1=0; 16/16 focused tests, typecheck and all GitHub backend/frontend checks pass. Staging auth latency evidence + Claude Code review pending. |

## Local branches not yet publishable

| Worktree | Branch / current head | Verified work | Blocking item / exact continuation |
|---|---|---|---|
| `C:\Users\User\Desktop\hz-d3-control-plane` | `fix/control-plane-privilege-boundary` / `d5285efe` before active fix | Atomic PG/D1 hard delete and one staging+Owner-only impersonation route; focused tests 33/33 and typecheck pass | Review found P0=0/P1=2: it must stack on #918 authoritative sessions, and privilege-sensitive target/role checks must be revalidated inside the same boundary transaction to close promotion/grant TOCTOU races. Fix is active; do not publish yet. |
| `C:\Users\User\Desktop\hz-so-cas-mandatory` | `fix/so-cas-mandatory` / `8baa8226` before active fix | First full-stack closure pass: special-route lease, versioned frontend coordinator, status/delete/system generations, 0161 header/follower RPC, payment row CAS and amendment serialization | Independent review found P0=1/P1≥4: amendment lease variables are in the wrong handler and backend typecheck has 9 errors; supplier-confirm leaks leases; mobile bulk status omits version; MobileNewSO photo omits lease; amendment/TBC/sofa still lack failure-atomic command transactions. Fix is active. Never publish `8baa8226`. |

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
