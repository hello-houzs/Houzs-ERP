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

## Local branches not yet publishable

| Worktree | Branch / current head | Verified work | Blocking item / exact continuation |
|---|---|---|---|
| `C:\Users\User\Desktop\hz-p0-route-matrices` | `docs/p0-route-matrices` / `36b932ac` | 929-row route matrix; 23 source-validated dynamic expansions; fail-closed imports/dynamic routes/order checks; audit and backend typecheck pass | Independent re-review required. If P0/P1=0, push and open Draft PR. |
| `C:\Users\User\Desktop\hz-session-revocation` | `fix/session-revocation-consistency` / `ab9c0039` before active fix | Authoritative user/authz fingerprint per request; atomic old-alias revocation; 50/50 focused tests and typecheck passed | Fix new-alias mailbox provisioning so the whole transition is atomic and collision-safe; add inbound ownership/self-grant, collision and failure-injection tests; use actual final mailbox ID in audit. Then independent review. |
| `C:\Users\User\Desktop\hz-d3-control-plane` | `fix/control-plane-privilege-boundary` / `28229982` | Neutral preview baseline, self-role constraints, last-wildcard concurrency protection, session bust; 42/42 plus 13/13 tests | Independent review must assess hard-delete partial-failure behavior: disabling the last wildcard account before later cleanup can leave it disabled when the API returns failure. Rebase after session branch if overlapping `users.ts`. |
| `C:\Users\User\Desktop\hz-so-cas-mandatory` | `fix/so-cas-mandatory` / `92167619` | Five-minute server lease, header CAS, core line mutation lease, D1/PG support; backend 13/13, frontend 4/4, typechecks and build pass | Inventory every SO mutation. Known candidates not yet proven lease/CAS-safe: override, TBC update/swap/sofa-swap, stock status, status/delete, photos, payments, amendments and recompute-allocation. Frontend callers must carry lease where required. Independent review is active. |

## Database ordering and rollout

The current migration chain is:

`0158 idempotency phase 1 → deploy → 24-hour soak/telemetry → 0159 phase 2 constraints → 0160 SO edit lease/followers → application code`

If session consistency unexpectedly needs a migration, reserve `0161`; prefer no migration. Before applying any migration, re-read the branch against current `legacy/main`, run checksum/drift validation, take the documented restore point, and record the exact deployed commit.

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
