# Migration retirement manifest

`backend/scripts/lib/migration-retirements.mjs` is the immutable exception list
for migration files that were applied to at least one tracker and later removed
from Git's live migration tree.

This preserves `_pg_migrations` history. Do **not** delete those tracker rows and
do not restore the old SQL files into `src/db/migrations-pg/`.

## Reviewed 2026-07-20 retirement

The current manifest contains exactly 17 obsolete SCM filenames removed together
by commit `dfa1111a` on 2026-06-18. The deletion commit described them as
never-applied, but production inspection recorded all 17 filenames in
`_pg_migrations`, so the tracker is the stronger evidence.

Each manifest entry pins:

- the complete filename (no prefix/range matching);
- the canonical SHA-256 of the last Git version before deletion; and
- the Git blob id from `dfa1111a^` for content recovery and audit provenance.

The SQL remains recoverable with `git cat-file blob <gitBlob>` without placing it
where the migration runner can execute it. This matters because historical
`0023_drop_adapted_scm_island.sql` contains `DROP TABLE ... CASCADE` statements.

## Gate behaviour

The checksum planner handles a tracker row whose file is absent as follows:

1. Filename absent from the manifest: fail closed as deleted-file drift.
2. Exact manifest filename with legacy `NULL` checksum: accept as reviewed
   retirement; leave the tracker row unchanged.
3. Exact manifest filename with the archived checksum: accept as reviewed
   retirement.
4. Exact manifest filename with any other checksum: fail closed.
5. Retired filename reappears anywhere in the live migration directory: fail
   closed even when its bytes match the archived file.

A fresh database is not required to contain retirement rows. It simply must not
contain or introduce a live migration using a retired name.

## Adding a retirement

Do not add an entry just to make a deploy pass. A new retirement requires a
separate review proving all of the following:

- the exact file and deletion commit;
- evidence that at least one tracker applied it;
- the last canonical checksum and Git blob;
- why keeping the SQL in the live tree is unsafe or incorrect; and
- tests pinning the exact filename and preventing reuse.

Unknown missing files remain release-blocking drift.
