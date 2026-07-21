# Houzs ERP scale-performance harness

Version: 1.1.0
Baseline: `legacy/main@9b234844`

This harness supplies the repeatable scale fixture that the hardening plan was
missing. Per tenant, it creates 100,000 orders, 100,000 order lines, 10,000 SKUs
and 10,000 users for two isolated tenants, then measures bounded list,
deep-page, prefix-search, detail-line and people-typeahead query shapes.

It never writes Houzs business tables:

- SQLite mode is an in-memory, warm-cache query-shape benchmark. It does not
  measure Cloudflare D1 Worker, RPC, serialization or network latency.
- PostgreSQL mode creates session-local `TEMP` tables inside a transaction and
  always rolls it back. A non-local target is refused unless the operator
  supplies the exact staging acknowledgement. Non-local databases outside the
  allowlisted Houzs staging project are always refused.

## Run

From `backend/`:

```text
npm run perf:scale
npm run perf:scale -- --orders=1000 --lines=1000 --skus=500 --users=500 --runs=5
```

PostgreSQL requires a disposable local or staging database:

```text
PERF_DATABASE_URL=postgres://... npm run perf:scale -- --engine=pg --json=scale-pg.json
```

For the allowlisted non-local staging project, also set
`PERF_STAGING_ACK=I_UNDERSTAND_THIS_LOADS_STAGING`. Production and unknown
non-local targets are refused even though the tables are temporary.

## Reading the report

The JSON output distinguishes per-tenant and total fixture counts, records query
plans, result row counts, correctness assertions, and p50/p95/max latency for
each query. A zero/incorrect result fails the run instead of being reported as
fast. Keep reports as CI/staging artifacts rather than committing them.
Compare like-for-like hardware and database tiers; this is a regression harness,
not a universal latency promise.

The harness deliberately models only isolated infrastructure query shapes. It
checks tenant scope, adjacent-page duplicates and prefix narrowing on its own
fixtures, but does not exercise actual HTTP routes or validate accounting
totals. Full cross-page route correctness remains a separate open integration
gate. Measurements are sequential warm-cache microbenchmarks, not production
concurrency or cold-cache latency.

## Version history

| Version | Change |
| --- | --- |
| 1.1.0 | Made scale per tenant, fail-closed on wrong/empty results, added query correctness checks, restricted remote PostgreSQL to explicit staging, and clarified SQLite/warm-cache limits. |
| 1.0.0 | Added isolated D1-compatible and PostgreSQL 100k/10k scale fixtures with repeatable query measurements. |
