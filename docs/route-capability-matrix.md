# Route capability inventory

Inventory version: 0.2

Verified baseline: `hello-houzs/Houzs-ERP@cdf2136a`

Generated artifacts:

- [`generated/route-capability-matrix.csv`](generated/route-capability-matrix.csv)
- [`generated/route-capability-summary.md`](generated/route-capability-summary.md)

## Purpose

This is the executable P0.2 route-by-method inventory for backend authorization review. It lists each mounted Hono route with its authentication boundary, company-context boundary, mounted area/capability gates, router-local gates, direct gates, handler-local credential checks and source line. Literal declarations are discovered from the TypeScript AST. Known factory/loop routes are expanded through a checked manifest whose values are validated against the factory call sites and source map keys.

It is an inventory, not a proof that authorization is correct. A route can have a declared gate and still expose the wrong rows or columns. Handler-local guards also require manual review because a static generator cannot prove their control flow.

## Regeneration and drift check

From `backend/`:

```text
node scripts/generate-route-capability-matrix.mjs
npm run audit:routes
```

`npm run audit:routes` fails when the checked-in matrix does not match source. This makes new and removed route declarations visible in review without changing runtime behavior.

It also fails closed when a mounted router import cannot be resolved, a router mount prefix is dynamic, a mounted dynamic path has no explicit source-validated expansion, an expansion no longer matches its factory inputs, a manual entry is unused/unvalidated, middleware ordering regresses, a new duplicate method/path registration appears, a resolved duplicate remains allowlisted, or the generated summary is stale.

The gate runs in PR/branch CI and in both production and staging backend deploy jobs. `main` is intentionally excluded from the ordinary CI push trigger, so the deploy workflows enforce the same audit before migrations or Worker deployment.

## Current result

The authoritative counts are generated with the matrix and live in [`generated/route-capability-summary.md`](generated/route-capability-summary.md). They deliberately are not copied into this prose, so documentation cannot silently disagree with the executable inventory.

- Pre-global-auth routes include intentional login, invite, survey, inbound-mail and form-intake surfaces, but each handler's credential/token validation must be recorded manually. Portal and supplier-portal routes are separately recognized through their mounted token middleware.
- Pre-session sync mutation routes authenticate inside the handler with `mirrorAuthed`; they remain manual-review items.
- POS has five deliberately pre-global-auth routes. Two are login surfaces, while the other three re-apply authentication per route.
- The generator does not infer record-level or column-level scope, SQL predicates, lifecycle guards, idempotency, audit completeness or transactional atomicity. Those remain separate matrices.

## Manual review queue

| Surface | Current boundary | Review requirement |
|---|---|---|
| Auth, invite, survey, tracking and portal routes | Mounted before global staff-session middleware | Classify every route as public credential exchange, signed/token-scoped access, or missing gate; record the validating helper and negative test. |
| `POST /api/pos/pin-login` | Pre-session credential exchange; PIN verification and durable attempt counter | Confirm fail-open attempt-counter behavior is acceptable and test brute-force/error paths. |
| `GET /api/pos/sales-staff` | Pre-session login picker | Confirm unauthenticated staff name/code and `has_pin` enumeration is an accepted product boundary. |
| `POST /api/pos/set-pin` | Route-local session authentication; self-only staff lookup | Verify session origin, user status and audit expectations. |
| `POST /api/pos/verify-pin` | Route-local session authentication; self-only staff lookup | Verify rate limiting and response do not create a PIN oracle. |
| `GET /api/pos/sales-stats` | Route-local session authentication plus company context and self staff scope | Keep company and salesperson negative tests. |
| `/api/sync/*-mirror` mutations | Static `SYNC_SECRET` checked by `mirrorAuthed` inside each handler | Keep fail-closed missing/incorrect-secret tests, request-size limits, replay/idempotency and company-2 ownership tests. |
| Duplicate `POST /api/users/:id/impersonate` | Exact source pair is temporarily recorded in `route-capability-duplicate-allowlist.json` | Remove the production-unconditional duplicate in D3; the audit fails if another duplicate appears or this allowlist remains after resolution. |

## Known parser limits

- Standard `.get/.post/.put/.patch/.delete` declarations are discovered automatically. Non-literal mounted paths must be listed in `backend/scripts/route-capability-manual.json`; unlisted or stale expansions fail CI. The current agent-engine factory and Outstanding module loop are additionally checked against their literal factory inputs/map keys.
- New custom route factories require an explicit expansion plus a source validator in the generator; a manifest entry alone is rejected. Dynamic router mount prefixes are rejected until an explicit parser is implemented. Middleware hidden behind arbitrary helper control flow and authorization performed entirely inside handler code still require manual annotation.
- Prefix inheritance is derived from registration order in `backend/src/index.ts` and `backend/src/scm/index.ts`; changing the mounting pattern must include a generator regression test.

## Version history

| Version | Date | Change |
|---|---|---|
| 0.2 | 2026-07-20 | Added fail-closed import/dynamic-route/duplicate handling, source-validated factory expansions, router middleware ordering, SCM mount resolution, regression sentinels and generated counts. |
| 0.1 | 2026-07-20 | Added deterministic literal-route inventory and manual-review queue. |
