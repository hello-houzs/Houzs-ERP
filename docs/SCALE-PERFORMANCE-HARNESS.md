# Houzs ERP scale-performance harness

Version: 2.0.0

Schema contract: `2026-07-21.1`

Baseline: `#913@7afb3feb`

This harness closes the false-confidence gap in the original `perf_*` fixture.
PostgreSQL mode now creates the production relation names, hot indexes,
payment-totals view, wide Sales Order projection, product-model join and Team
correlated aggregates used by the current routes. Per tenant it creates 100,000
Sales Orders, 100,000 lines, 10,000 SKUs and 10,000 users for two tenants.

## Safety boundary

PostgreSQL mode is local-only and destructive only to data it creates inside
its own transaction:

- The hostname must be `localhost`, `127.0.0.1` or `::1`.
- The database name must be exactly `houzs_scale_test`.
- `PERF_LOCAL_ACK` must exactly match the acknowledgement below.
- Before `BEGIN`, a server-authoritative catalogue check refuses any database
  that already has a user relation/custom schema, an `scm` schema, Houzs core
  tables or migration history.
  This also blocks a live database hidden behind a localhost tunnel.
- Schema, fixture and measurements run in a `SERIALIZABLE` transaction under
  an advisory transaction lock. `ROLLBACK` runs in `finally`, then the clean
  catalogue is checked again. A failed benchmark therefore tears down too.
- Every remote target is rejected. There is no staging or production override.

The operator must provision an empty, disposable local PostgreSQL database
named `houzs_scale_test`; the harness never creates or drops a database.

## Run

From `backend/`, first use a small smoke fixture:

```powershell
$env:PERF_DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1/houzs_scale_test"
$env:PERF_LOCAL_ACK = "I_UNDERSTAND_THIS_IS_A_DISPOSABLE_LOCAL_DATABASE"
npm run perf:scale -- --engine=pg --orders=1000 --lines=1000 --skus=500 --users=500 --runs=5
```

Run the schema/query contract and route-drift checks before measuring:

```powershell
npm run test:scale-contract
```

Then run the required scale and retain its report as a CI/local artifact:

```powershell
npm run perf:scale -- --engine=pg --runs=20 --json=scale-pg.json
```

`backend/scale-*.json` is gitignored. The legacy fast smoke benchmark remains:

```text
npm run perf:scale
```

SQLite mode is intentionally synthetic and in-memory. It is useful for catching
gross query-shape regressions but is not acceptance evidence for HZ-P0-04.

## Evidence and pass criteria

The PostgreSQL report records:

- exact per-tenant and total fixture cardinalities;
- adjacent-page uniqueness, search narrowing, tenant isolation and payment-view
  correctness assertions that fail the process on mismatch;
- returned row counts and p50/p95/max for each measured query;
- JSON query plans for the principal Sales Order, product and Team searches;
- the schema-contract version and isolation mode.

The measured shapes mirror the current database work performed by:

- Sales Order summary, paginated wide list, deep offset, one-character search,
  money page, status count and detail lines;
- Products first page, product-model join and one-character search;
- Team typeahead and the actual unbounded no-query full-directory path.

Do not compare latency numbers across unlike hardware or PostgreSQL settings.
Acceptance is a repeatable correctness pass plus route-specific p95 budgets
agreed for the same runner/database profile; it is not a universal latency
promise.

## Explicit non-coverage

This is a database-contract benchmark, not a live-route load test. It does not
execute Hono middleware, auth/permission scope, PostgREST transport, Hyperdrive,
Cloudflare Worker CPU, JSON serialization, browser rendering, network latency,
cold caches or concurrent users. The product nested relation is represented by
its SQL join equivalent. PostgreSQL row-level security is not reproduced.

Those layers require a separate isolated application environment and must not
be inferred from these p95 values. No live Hono/PostgREST endpoint is invoked by
this harness.

## Version history

| Version | Change |
| --- | --- |
| 2.0.0 | Replaced PostgreSQL `perf_*` lookalikes with a guarded, transactional real-schema contract; added production query shapes, correctness assertions, plans, deterministic teardown and an absolute ban on remote targets. |
| 1.1.0 | Made scale per tenant, fail-closed on wrong/empty results, added query correctness checks, restricted remote PostgreSQL to explicit staging, and clarified SQLite/warm-cache limits. |
| 1.0.0 | Added isolated SQLite and PostgreSQL scale fixtures with repeatable query measurements. |
