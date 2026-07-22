import { describe, expect, test } from "vitest";

/* WHY THIS TEST EXISTS.
   On 2026-07-18 two files were numbered 0128 (#765). Within the hour of fixing and
   documenting that, the SAME collision was created again at 0136 — because the way
   "the next free number" gets picked is `ls *.sql`, and the file already holding
   0136 was a `.TEMPLATE`. The written rule ("a .TEMPLATE occupies its number") did
   not prevent the second occurrence, because the person applying the rule was the
   person who had just written it.

   So the rule is enforced here instead of documented. A duplicate is caught by a red
   test at PR time rather than by a failed pg-migrate mid-deploy — and a failed
   migration blocks EVERY deploy, not only its own.

   EXTENSION-BLIND ON PURPOSE: the trap is a non-.sql file whose whole purpose is to
   BECOME a .sql file later. It occupies its number from the day it lands.

   WHY import.meta.glob AND NOT readdirSync: this suite runs in workerd, where
   `readdirSync()` throws "not yet implemented in Workers". The first version of this
   test used it inside a try/catch and passed on an empty listing — it stayed green
   with a real duplicate planted in the directory, which is worse than no test at
   all. import.meta.glob is expanded by Vite at TRANSFORM time, in Node, so the file
   listing is baked into the bundle and is readable inside the isolate. The
   emptiness assertions below exist so that a glob which stops resolving fails LOUD
   instead of silently passing again. */

const MIGRATION_GLOBS: Record<string, Record<string, unknown>> = {
  "src/db/migrations-pg": import.meta.glob("../src/db/migrations-pg/*", { eager: false }),
  "src/db/migrations": import.meta.glob("../src/db/migrations/*", { eager: false }),
};

/* THE HISTORICAL BASELINE — numbers already claimed twice (0104 three times) when
   this test was written, all applied in prod. They are harmless: pg-migrate.mjs
   keys `_pg_migrations.filename` as its PRIMARY KEY and sorts by full name, so a
   number is a LABEL to the runner, never an identity. Two files sharing one is a
   readability problem, not an execution one — which is exactly why it kept
   happening unnoticed. Frozen here so the ratchet catches the NEXT one. */
const KNOWN_DUPLICATES: Record<string, string[]> = {
  // 0175 landed twice under an unfortunate rename chain in the same afternoon:
  //   1. #1039 merged as `0171_scm_warehouse_type_and_unify.sql`, colliding with
  //      `0171_idempotency_phase2_constraints.sql` (parallel PR from same base).
  //   2. #1044 hotfixed the red main by renaming the warehouse migration to
  //      `0175_scm_warehouse_type_and_unify.sql`.
  //   3. #1040 then merged as `0175_scm_state_canonicalize.sql` — the same PR
  //      had already renamed to 0175 to duck the 0172 collision it saw at
  //      branch time.
  //   4. That made 0175 a duplicate in turn. Renamed again to 0176 — which
  //      0176_scm_region_and_snapshot_backfill.sql had taken in the meantime —
  //      and finally to `0177_scm_warehouse_type_and_unify.sql`, the number read
  //      off the tree AFTER merging the true tip of main rather than the base the
  //      branch happened to start from. Five collisions on one file in one day:
  //      the number has to be taken against the tip you are about to merge INTO,
  //      not the tip you branched from.
  // Two 0175 files now on main, both applied under their own filenames in
  // `_pg_migrations`. Frozen here so the ratchet catches the NEXT one.
  "src/db/migrations-pg": ["0029", "0091", "0092", "0093", "0094", "0104", "0108", "0112", "0123", "0175"],
  "src/db/migrations": ["010"],
};

/** number → the files claiming it, from the glob's KEYS (paths). */
function numbered(glob: Record<string, unknown>): Map<string, string[]> {
  const byNo = new Map<string, string[]>();
  for (const path of Object.keys(glob)) {
    const file = path.split("/").pop() ?? "";
    const m = file.match(/^(\d{3,4})[_-]/);
    if (!m) continue;
    const list = byNo.get(m[1]) ?? [];
    list.push(file);
    byNo.set(m[1], list);
  }
  return byNo;
}

describe("migration numbering", () => {
  for (const [dir, glob] of Object.entries(MIGRATION_GLOBS)) {
    test(`${dir}: the listing is non-empty (guards against a vacuous pass)`, () => {
      // If this fails, the two tests below prove NOTHING — fix the glob first.
      expect(Object.keys(glob).length, `no files globbed from ${dir}`).toBeGreaterThan(0);
    });

    test(`${dir}: every file carries a parseable number`, () => {
      const total = Object.keys(glob).length;
      const parsed = [...numbered(glob).values()].reduce((n, f) => n + f.length, 0);
      // A file the number-parser skips is a file the duplicate check cannot see.
      expect(parsed, `${total - parsed} file(s) in ${dir} have no NNNN_ prefix`).toBe(total);
    });

    test(`${dir}: no NEW duplicate numbers beyond the known historical ones`, () => {
      const dupes = [...numbered(glob)]
        .filter(([, files]) => files.length > 1)
        .map(([no]) => no)
        .sort();
      // A RATCHET, not a clean-room rule. Nine numbers were already doubled up
      // before this test existed and every one of them is applied in prod, so
      // demanding zero would fail every deploy and rewriting history to satisfy a
      // test would be worse than the mess. Adding a number that is already taken
      // fails here; the historical ones are frozen as accepted.
      expect(dupes, `NEW duplicate migration number in ${dir} — pick the next free number instead`)
        .toEqual(KNOWN_DUPLICATES[dir]);
    });
  }
});
