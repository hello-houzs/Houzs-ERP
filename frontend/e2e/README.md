# Frontend staging E2E — smoke proofs

Playwright suite that runs three real browser proofs against the **staging**
stack after every staging deploy. It exists to close a specific gap: a deploy
can be green and every endpoint can answer `200`/`401` while the app is still
broken for a user. "Shipped" is not "working" — these tests prove *working*.

Targets (defaults, override via env):

- Frontend: `https://houzs-erp-staging.pages.dev`
- API: `https://autocount-sync-api-staging.houzs-erp.workers.dev`

## The three proofs

| Spec | Proves |
|---|---|
| `auth.spec.ts` | A wrong password shows the exact message `Email or password is incorrect.`; a valid login reaches the authed app shell. |
| `so-list.spec.ts` | `/scm/sales-orders` renders at least one row **or** the explicit empty state (never a crash / white screen), with no uncaught errors. |
| `company-isolation.spec.ts` | Switching the active company refetches the product catalog **fresh** carrying the new `X-Company-Id` (no cache-only hit); when staging is multi-company, SO document-number prefixes are disjoint across companies. |

### Two assertions are intentionally ahead of the deploy

- **`auth.spec.ts` (wrong password)** asserts `Email or password is incorrect.`
  verbatim — the target copy of **PR #854**. Until #854 reaches staging the
  screen still reads `Password incorrect.` and this test is **red by design**.
  It is the executable spec for #854.
- **`company-isolation.spec.ts`** pins **PR #856**'s Vary fix at the
  request-event level: after a switch, a fresh `/mfg-products` request must fire
  with the new company header rather than the previous company's cached payload
  being served.

Both are fine to be red pre-deploy: this workflow is **not** a required check
and is **not** attached to `pull_request` (see below), so it never blocks a
merge.

### Concrete vs mechanical (company isolation)

The cross-company doc-number assertion needs staging to expose **two or more**
companies. When it exposes fewer (the common single-company staging seed), the
spec asserts the switch **mechanics** — a fresh, newly-scoped `/mfg-products`
request fires — and records a `test.info()` annotation explaining why the
concrete data assertion was skipped. Re-run against multi-company staging for
the concrete proof.

## Credentials

Resolution precedence (`fixtures.ts`):

1. `STAGING_E2E_EMAIL` / `STAGING_E2E_PASSWORD` (CI secrets or local `.env`)
2. the in-repo staging-seed account `hello@houzscentury.com` — the public,
   disposable owner account the team seeds via
   `backend/scripts/staging-seed-account.mjs` (the "Staging Seed (one-off)"
   workflow). Staging is an isolated Supabase with no prod data, so this is a
   test fixture, not a production secret.

Set the two secrets to use a different account. If both resolve empty, the
auth-dependent specs **skip** with a clear annotation instead of failing.

Skip-vs-fail on login:

- **Both creds empty** -> skip (nothing to run).
- **`5xx` on login** (paused free-tier Supabase / cold Worker) -> skip. A
  sleeping environment reads as "not proven right now", not "the app is broken".
- **`401`/`403` with the in-repo FALLBACK account** -> skip with an annotation
  telling the owner to run the "Staging Seed (one-off)" workflow (which
  provisions `hello@houzscentury.com` as `houzs1234`) or to set the secrets. A
  fixture account that a given staging DB was never seeded with is a setup gap,
  not an app bug.
- **`401`/`403` with OWNER-SUPPLIED secrets** -> **fail red**. The owner
  asserted those are valid, so their rejection is a real signal.

> Note: as observed on 2026-07-19, the current staging DB does not have the
> in-repo fixture account provisioned (login 401), so an unattended run skips
> the three auth-dependent specs. Run the staging-seed workflow or set the
> secrets to get live green proofs.

## Run

```bash
cd frontend/e2e
npm install
npx playwright install chromium
# optional: cp .env.example .env  and fill in an account

npm test                 # all three specs against staging
npm run test:list        # list tests without running (parse check)
npm run typecheck        # tsc --noEmit on the specs
npm run test:report      # open the HTML report after a run
```

This suite is **standalone** — its own `package.json` + `package-lock.json`. It
is not part of the frontend app build: `tsconfig.app.json` includes only
`src/`, so `frontend`'s `tsc -b` / `npm run typecheck` never compile these
files, and vitest only globs `src/**/*.test.ts(x)`.

## CI

`.github/workflows/staging-e2e.yml` runs the suite:

- automatically after the **Deploy (Staging)** workflow completes successfully
  (`workflow_run`),
- on demand (`workflow_dispatch`),
- nightly (`schedule`).

It is deliberately **not** on `pull_request` and **not** a required check, so a
flaky external-environment run never gates the merge train. Inside the job,
`continue-on-error: false` — a real assertion failure surfaces red.
