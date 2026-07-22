# Idempotency Phase 2 deployment gate

## MERGE GATE — run this before pressing merge, not after

Merging this PR **is** the deployment. `deploy.yml` runs `pg-migrate.mjs` on
every push to `main`, and a migration that raises aborts the whole run, so
every later migration on main stays unapplied until someone hand-fixes it.
The soak gate below is deliberately fail-closed: if the soak is not complete,
**merging is the failure mode**, not a no-op.

Run against **production** (read-only, safe to run at any time):

```sql
WITH marker AS (
  SELECT (updated_at::timestamp AT TIME ZONE 'UTC') AS live_at
  FROM public.app_settings
  WHERE key = 'rollout.idempotency_phase1_worker_live'
), phase1 AS (
  SELECT applied_at
  FROM public._pg_migrations
  WHERE filename = '0163_idempotency_principal_company_hash.sql'
)
SELECT
  (SELECT applied_at FROM phase1)              AS phase1_applied_at,
  (SELECT live_at    FROM marker)              AS worker_marker_utc,
  now() - (SELECT live_at FROM marker)         AS soak_age,
  (SELECT count(*) FROM public.idempotency_keys
    WHERE (user_id IS NULL OR tenant_scope IS NULL OR request_hash IS NULL)
      AND created_at >= now() - interval '24 hours') AS recent_null_claims,
  (
    (SELECT applied_at FROM phase1) IS NOT NULL
    AND (SELECT live_at FROM marker) IS NOT NULL
    AND (SELECT live_at FROM marker) >= (SELECT applied_at FROM phase1)
    AND (SELECT live_at FROM marker) <= now() - interval '24 hours'
    AND (SELECT count(*) FROM public.idempotency_keys
          WHERE (user_id IS NULL OR tenant_scope IS NULL OR request_hash IS NULL)
            AND created_at >= now() - interval '24 hours') = 0
  ) AS gate_will_pass;
```

The query always returns exactly one row. Merge **only** when
`gate_will_pass` is `t` — it evaluates the same three conditions the migration
itself evaluates. Every other outcome is a do-not-merge:

| Result | Meaning | Action |
| --- | --- | --- |
| `gate_will_pass = t` | Gate will pass. | Merge. |
| `worker_marker_utc` set, `soak_age < 24:00:00` | Marker exists but has not soaked. | Wait until `soak_age > 24:00:00`, re-run, then merge. |
| `worker_marker_utc` NULL | The marker was never written. | Do **not** merge — see below. |
| `phase1_applied_at` NULL | Phase 1 is not in this database's tracker (wrong DB, or Phase 1 was renumbered again). | Do **not** merge; re-check the filename the gate names. |
| `recent_null_claims > 0` | An old Worker (or another writer) is still writing legacy NULL claims. | Do **not** merge; find that writer and restart the soak. |

A missing marker is not a timing problem. The row is written by the Phase-1
Worker itself (`markPhaseOneWorkerLive` in `src/middleware/idempotency.ts`),
on the **first successful keyed claim**, with `ON CONFLICT(key) DO NOTHING` so
the timestamp is immutable once set. It therefore requires real production
traffic through an `Idempotency-Key`-carrying mutation *after* the Phase-1
Worker was deployed. If the row is absent, either that traffic has not
happened yet or the insert is failing (the middleware swallows the error and
only `console.warn`s, so check the Worker logs for
`[idempotency] phase-one rollout marker failed`). Do not hand-insert the row
to unblock the merge: its timestamp is the entire safety argument.

If the gate raises after merge, the deploy log shows
`idempotency phase 2 blocked: …` and **every** migration merged after this one
stops applying. Recovery is to revert this file from `main` (or, if the soak
genuinely completed in the meantime, re-run the deploy workflow) — not to edit
the marker.

The one-hour `rollout.idempotency_phase2_offline_bootstrap` escape hatch below
exists for a fresh/offline environment where no old Worker can be running. It
is not a way to skip a production soak.

---

Phase 2 converts the additive Phase 1 columns into enforced database
constraints. It is intentionally a separate release:

- Postgres: `0163_idempotency_principal_company_hash.sql` must deploy first;
  `0171_idempotency_phase2_constraints.sql` is the later hardening release.
- D1: `128_idempotency_principal_company_hash.sql` must deploy first;
  `130_idempotency_phase2_constraints.sql` is the later parity release.
- Never place both phases in one PR, merge, migration run, or Worker rollout.
  The Phase 2 SQL requires a durable Phase 1 Worker marker to soak for 24 hours.

## Why the split is mandatory

The deployment workflow applies Postgres migrations before swapping the Worker.
The old Worker does not populate `tenant_scope` or `request_hash`. Enforcing
`NOT NULL` in Phase 1 would make the old middleware's claim insert fail during
the rollout window. The old middleware historically failed open, so business
writes could then run without duplicate protection.

Phase 1 keeps the legacy `(key, scope)` primary key and nullable columns while
the new Worker drains old isolates. Its first successful keyed claim inserts
`rollout.idempotency_phase1_worker_live` into `app_settings` without replacing
an existing value. That durable timestamp starts the soak and is not affected
by the idempotency table's 24-hour TTL sweep.

## Hard prerequisites

All gates are required in staging and again in production:

1. The Phase 1 migration and Phase 1 Worker are deployed successfully.
2. The durable `rollout.idempotency_phase1_worker_live` marker exists, is not
   older than the Phase 1 migration, and has soaked for at least 24 hours.
3. No row written in the last 24 hours has NULL `user_id`, `tenant_scope`, or
   `request_hash`.
4. Backend typecheck, idempotency tests, migration-number tests, and the normal
   smoke check are green.
5. A database snapshot / point-in-time restore point is available.

Do not override a rejected gate by editing the tracker timestamp or deleting a
recent NULL row. A recent NULL is evidence that an old Worker or another writer
is still active; find that writer and restart the 24-hour soak.

## PostgreSQL preflight

Run read-only checks against the intended environment:

```sql
SELECT filename, applied_at, now() - applied_at AS soak_age
FROM public._pg_migrations
WHERE filename = '0163_idempotency_principal_company_hash.sql';

SELECT key, value, updated_at,
       now() - updated_at::timestamptz AS worker_soak_age
FROM public.app_settings
WHERE key = 'rollout.idempotency_phase1_worker_live';

SELECT
  count(*) FILTER (
    WHERE user_id IS NULL OR tenant_scope IS NULL OR request_hash IS NULL
  ) AS all_legacy_nulls,
  count(*) FILTER (
    WHERE (user_id IS NULL OR tenant_scope IS NULL OR request_hash IS NULL)
      AND created_at >= now() - interval '24 hours'
  ) AS recent_legacy_nulls
FROM public.idempotency_keys;

SELECT count(*) AS rows_to_expire
FROM public.idempotency_keys
WHERE (user_id IS NULL OR tenant_scope IS NULL OR request_hash IS NULL)
  AND created_at < now() - interval '24 hours';

```

Expected: one Phase 1 tracker row; exactly one Worker marker with
`worker_soak_age >= 24 hours` and `updated_at >= Phase 1 applied_at`; and
`recent_legacy_nulls = 0`. `rows_to_expire` may be non-zero; those incomplete
legacy claims are older than the replay window and Phase 2 deletes them.

## D1 preflight

```sql
SELECT name, applied_at,
       CAST((julianday('now') - julianday(applied_at)) * 24 AS INTEGER) AS soak_hours
FROM _migrations
WHERE name = '128_idempotency_principal_company_hash.sql';

SELECT key, value, updated_at,
       CAST((julianday('now') - julianday(updated_at)) * 24 AS INTEGER) AS worker_soak_hours
FROM app_settings
WHERE key = 'rollout.idempotency_phase1_worker_live';

SELECT
  sum(CASE WHEN user_id IS NULL OR tenant_scope IS NULL OR request_hash IS NULL
           THEN 1 ELSE 0 END) AS all_legacy_nulls,
  sum(CASE WHEN (user_id IS NULL OR tenant_scope IS NULL OR request_hash IS NULL)
                AND (datetime(created_at) IS NULL
                     OR datetime(created_at) >= datetime('now', '-24 hours'))
           THEN 1 ELSE 0 END) AS recent_legacy_nulls
FROM idempotency_keys;
```

If D1 was the active Worker database during the Phase 1 soak, expect Phase 1 to
be tracked, `worker_soak_hours >= 24`, the Worker marker not older than the
tracker row, and `recent_legacy_nulls = 0`. Houzs normally serves writes from
Postgres and keeps D1 only as a rollback database, so D1 will not receive the
automatic Worker marker. In that normal rollback-parity case, use the offline
bootstrap path below while D1 is still disconnected from application traffic.
A malformed timestamp is treated as a failed gate.

## Fresh database / offline DR path

This path exists so a new database or an isolated disaster-recovery restore is
not forced to wait 24 hours. It is forbidden for a normal staging or production
upgrade. Use it only while all application traffic is blocked and no old Worker
can reach the database.

1. Record explicit owner approval and take a restore point.
2. Verify the Phase 1 migration is tracked and the environment is offline.
3. Verify `recent_legacy_nulls = 0`. For a DR restore that contains only stale
   replay claims, clearing `idempotency_keys` removes the 24-hour replay cache;
   do that only while offline, after the restore point, and with explicit
   approval. A fresh database should already be empty.
4. Create the exact, short-lived marker immediately before Phase 2.

Postgres:

```sql
INSERT INTO public.app_settings (key, value, updated_at)
VALUES (
  'rollout.idempotency_phase2_offline_bootstrap',
  '{"mode":"offline-bootstrap","old_worker_traffic":"blocked"}',
  to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
)
ON CONFLICT (key) DO UPDATE
SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at;
```

D1:

```sql
INSERT INTO app_settings (key, value, updated_at)
VALUES (
  'rollout.idempotency_phase2_offline_bootstrap',
  '{"mode":"offline-bootstrap","old_worker_traffic":"blocked"}',
  datetime('now')
)
ON CONFLICT (key) DO UPDATE
SET value = excluded.value, updated_at = excluded.updated_at;
```

5. Read the row back and verify its value byte-for-byte and timestamp between
   one hour ago and five minutes in the future. Apply Phase 2 before it expires.
6. Phase 2 deletes the offline marker in the same successful transaction/batch.
   Verify it is absent afterward. If Phase 2 fails, remove it immediately:

```sql
DELETE FROM app_settings
WHERE key = 'rollout.idempotency_phase2_offline_bootstrap';
```

Do not edit the normal Worker marker or falsify either marker's timestamp.

## Release sequence

1. Deploy and verify Phase 1 in staging. Complete one safe keyed request, verify
   it created the durable Worker marker, then wait 24 hours from that marker.
2. Run the staging preflight. Take a restore point.
3. Apply Phase 2 in staging. A lock wait beyond 5 seconds fails the lock-taking
   statement; any individual statement running beyond 60 seconds is cancelled.
   Either failure rolls back the complete Postgres migration.
4. Run the postflight checks below and exercise one keyed mutation twice. The
   second response must carry `Idempotent-Replay: true` and create no second
   business row.
5. After staging Postgres is verified, apply D1 `128` for rollback parity
   before merging the production PR, as required by `deploy.yml`. Because D1
   is disconnected from application traffic and has no normal Worker marker,
   create the exact offline-bootstrap marker immediately before this step and
   verify the migration removes it. Run the migration as one Wrangler batch;
   do not paste its rebuild statements one at a time.
6. Observe staging, then merge and repeat the preflight, backup, migration, and
   postflight sequence in production. Production Postgres `0159` is still
   applied by the normal pre-Worker deployment gate.

The staging workflow currently permits its migration step to continue on
error. Therefore a green Worker deployment is not proof that Phase 2 applied:
the `_pg_migrations` postflight row is mandatory evidence.

The automated SQLite contract test applies parsed statements one at a time so
it can assert exactly which fail-first guard stopped the migration. It does not
model D1 batch rollback. The repository's real Wrangler `d1 execute --file`
path was separately verified to roll the complete file back on failure; keeping
the production invocation as one file is therefore part of the gate.

## PostgreSQL postflight

```sql
SELECT filename, applied_at
FROM public._pg_migrations
WHERE filename = '0171_idempotency_phase2_constraints.sql';

SELECT column_name, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'idempotency_keys'
  AND column_name IN ('user_id', 'tenant_scope', 'request_hash')
ORDER BY column_name;

SELECT pg_get_constraintdef(oid) AS primary_key
FROM pg_constraint
WHERE conrelid = 'public.idempotency_keys'::regclass
  AND contype = 'p';

SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'idempotency_keys'
  AND indexname = 'idx_idempotency_keys_created_at';
```

Expected: Phase 2 is tracked; all three columns are `NO`; the primary key is
`(user_id, tenant_scope, key, scope)`; the `created_at` index remains present.

## D1 postflight

```sql
PRAGMA table_info(idempotency_keys);
PRAGMA index_list(idempotency_keys);
SELECT name, applied_at
FROM _migrations
WHERE name = '130_idempotency_phase2_constraints.sql';
```

Expected primary-key order: `user_id=1`, `tenant_scope=2`, `key=3`, `scope=4`.
`user_id`, `tenant_scope`, and `request_hash` must all be `notnull=1`, and
`idx_idempotency_keys_created_at` must remain present.

## Failure and rollback

- Gate, lock, timeout, or constraint failure: the Postgres runner transaction
  rolls back the whole file. Keep the Phase 1 Worker deployed, investigate, and
  restart the soak. Do not mark Phase 2 applied manually.
- Phase 2 applied and application healthy: prefer a forward fix. Do not roll
  the Worker back to pre-Phase-1 code; it cannot populate the enforced columns.
- Before any schema rollback, stop keyed writes and check whether Phase 2 has
  legitimately allowed the same `(key, scope)` under multiple principals:

```sql
SELECT key, scope, count(*)
FROM public.idempotency_keys
GROUP BY key, scope
HAVING count(*) > 1;
```

If this returns rows, the legacy `(key, scope)` primary key cannot be restored
without deleting valid claims. Do not auto-deduplicate them; keep the new Worker
and restore/repair forward. If it returns zero and rollback is explicitly
approved, restore the old primary key first, then drop `NOT NULL` from
`user_id`, `tenant_scope`, and `request_hash` in one locked transaction. D1
requires the equivalent table rebuild or point-in-time restore.

Phase 2 intentionally deletes only incomplete legacy claims older than 24
hours. Schema rollback does not recreate them; use the pre-deploy restore point
if those expired bookkeeping rows are required for an investigation.
