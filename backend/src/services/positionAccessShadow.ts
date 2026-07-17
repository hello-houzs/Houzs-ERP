// ----------------------------------------------------------------------------
// positionAccessShadow — resolve page-access from the SNAPSHOT alongside the
// live table, serve the TABLE, and report any cell where the two disagree.
//
// WHAT THIS IS NOT: it is not the cutover. Nothing here changes what any user
// can see or do. `auth.ts` still hydrates from `position_page_access` and still
// serves that map. This module reads the same rows a second way and says so when
// the answers differ.
//
// WHY A SHADOW AND NOT THE SWITCH. The owner's instruction is
// "你把目前的矩阵先用 backend 写进去，然后一层一层拆掉" — the snapshot (step 1,
// #704) is the写进去; this is the instrumentation that makes 拆掉 provable. Four
// facts, all measured in this tree on 2026-07-17, say the switch itself is not
// ready yet:
//
//   1. THE SNAPSHOT IS A PROD PHOTOGRAPH AND STAGING IS A DIFFERENT DATABASE.
//      POSITION_ACCESS_SNAPSHOT_SOURCE is "https://erp.houzscentury.com"; staging
//      runs PUBLIC_APP_URL="https://houzs-erp-staging.pages.dev" against Supabase
//      project minnapsemfzjmtvnnvdd, prod against anogrigyjbduyzclzjgn. The
//      export route says it outright ("Staging and prod are DIFFERENT Supabase
//      projects with different rows"). So a cutover CANNOT be verified on
//      staging: staging's table is not the thing the snapshot photographed, and
//      every divergence there would be data drift, not a resolver bug. The only
//      place the comparison carries information is prod — and a shadow is the
//      only form of it that is safe to run there.
//
//   2. THE EDITOR WOULD BECOME THE THING HE JUST RULED AGAINST. Team > Positions
//      writes `position_page_access` (positions.ts:566-575) and says "Saved".
//      After a cutover those writes resolve nothing for all 17 photographed
//      positions. That is precisely the defect he ruled on the same day —
//      "不能留着了…最重要是我要它的 UI" (pageAccess.ts:551-558, the DORMANT_KEYS
//      ruling) — applied to all 850 cells instead of 7 keys. Shipping the switch
//      would answer his complaint about dead cells by making every cell dead.
//
//   3. THE SNAPSHOT'S OWN HEADER SETS A PRECONDITION THAT IS NOT MET. It records
//      the sequence as "export -> the owner reviews the table -> he states his
//      adjustments -> we encode them -> THEN the switch", and warns that
//      "Shipping the switch before he has reviewed the table is what would force
//      him to reconfigure" — the one outcome his acceptance test forbids
//      ("每一個 position 的數據都保留"). Nothing in this tree records that review.
//
//   4. A CUTOVER SPLITS THE SOURCE OF TRUTH BY DATE. `POST /api/positions`
//      (positions.ts:339-383) inserts into `positions` ONLY — no matrix rows —
//      so a position created after the photograph has no snapshot entry and must
//      fall back to the table (see `resolveFromSnapshot` returning null). That
//      leaves an editor which works for positions created after 2026-07-17 and
//      silently does nothing for the 17 that existed, with no way to tell them
//      apart from the UI. The fallback is necessary and correct; the system it
//      produces is one nobody can reason about.
//
// WHAT THE SHADOW BUYS. It proves equivalence against real logins over real days
// at zero risk, in the only database where the question is meaningful, and it
// turns the cutover into a non-event: when the divergence count has been 0 for
// long enough, flipping the source is a one-line change with evidence behind it.
// If it is NOT 0, the shadow has found — for free, in prod, with nobody locked
// out — exactly the thing that would otherwise have been found by an employee
// who could not work on Monday.
// ----------------------------------------------------------------------------

import {
  PAGES,
  resolvePositionAccessFromRows,
  type AccessLevel,
  type PageAccessMeta,
} from "./pageAccess";
import {
  POSITION_ACCESS_SNAPSHOT,
  POSITION_ACCESS_SNAPSHOT_SOURCE,
  type PositionAccessSnapshotEntry,
} from "./positionAccessSnapshot";

/** id -> entry. Built once at module load; the snapshot is frozen data. */
const BY_ID: ReadonlyMap<number, PositionAccessSnapshotEntry> = new Map(
  POSITION_ACCESS_SNAPSHOT.map((e) => [e.id, e]),
);

export function snapshotEntryFor(
  positionId: number,
): PositionAccessSnapshotEntry | undefined {
  return BY_ID.get(positionId);
}

/**
 * Resolve a position's page-access map from the snapshot, or null when the
 * snapshot does not name it.
 *
 * NULL IS THE WHOLE POINT, and it is not an error. `POST /api/positions` writes
 * no matrix rows, so a position created after the photograph is absent here.
 * Returning null (rather than an all-"none" map) forces the caller to fall back
 * to the live table, which is the ONLY source that can answer for such a
 * position — and the only one an admin can still edit. An absent position
 * resolved as "no access" would mean a new hire cannot work on day one and
 * nobody can fix it, because the editor would no longer be the source.
 *
 * The rows go through `resolvePositionAccessFromRows` — the SAME cascade the
 * table loader uses, including the `isValidPageKey` filter that keeps the
 * snapshot's 6 orphan rows inert and out of `explicitScm`.
 */
export function resolveFromSnapshot(
  positionId: number,
  meta?: PageAccessMeta,
): Record<string, AccessLevel> | null {
  const entry = BY_ID.get(positionId);
  if (!entry) return null;
  const rows = Object.entries(entry.entries).map(([page_key, level]) => ({
    page_key,
    level: level as string,
  }));
  return resolvePositionAccessFromRows(rows, meta);
}

export interface PageAccessDivergence {
  page_key: string;
  table: AccessLevel | undefined;
  snapshot: AccessLevel | undefined;
}

/**
 * Every registry page where the two maps disagree. Iterates PAGES rather than
 * the maps' own keys so a page missing from one side is a divergence rather than
 * a silently skipped comparison.
 */
export function diffPageAccess(
  table: Record<string, AccessLevel>,
  snapshot: Record<string, AccessLevel>,
): PageAccessDivergence[] {
  const out: PageAccessDivergence[] = [];
  for (const p of PAGES) {
    if (table[p.key] !== snapshot[p.key]) {
      out.push({ page_key: p.key, table: table[p.key], snapshot: snapshot[p.key] });
    }
  }
  return out;
}

/**
 * Is this runtime the database the snapshot was photographed from?
 *
 * The snapshot's provenance string is `${PUBLIC_APP_URL} (${host})` as the
 * export built it, so the app URL is its prefix. Comparing on that is what stops
 * the shadow from reporting staging's legitimately-different rows as resolver
 * bugs — noise that would train the reader to ignore the one line that matters.
 */
export function isSnapshotProvenance(env: { PUBLIC_APP_URL?: string }): boolean {
  const url = env.PUBLIC_APP_URL;
  if (!url) return false;
  return POSITION_ACCESS_SNAPSHOT_SOURCE.startsWith(url);
}

export interface ShadowResult {
  compared: boolean;
  reason?: "provenance-mismatch" | "not-in-snapshot";
  divergences?: PageAccessDivergence[];
}

/**
 * Compare the served (table) map against the snapshot and report. Returns what
 * it did so a test can assert on it; logs so prod can be read.
 *
 * NEVER THROWS AND NEVER RETURNS A MAP. This runs on the login path. A shadow
 * that can break authentication is not a shadow — so the caller gets no value it
 * could accidentally serve, and any internal fault is swallowed by the caller's
 * try/catch (auth.ts). The served map is the table's, always.
 */
export function shadowComparePositionAccess(
  env: { PUBLIC_APP_URL?: string },
  positionId: number,
  servedFromTable: Record<string, AccessLevel>,
  servedScmMeta: PageAccessMeta,
): ShadowResult {
  if (!isSnapshotProvenance(env)) {
    return { compared: false, reason: "provenance-mismatch" };
  }

  const snapMeta: PageAccessMeta = { explicitScm: false };
  const fromSnapshot = resolveFromSnapshot(positionId, snapMeta);
  if (!fromSnapshot) {
    // Signal, not noise: a position the photograph does not name is one created
    // after 2026-07-17. It resolves from the table today and would have to keep
    // doing so after any cutover — this line is how that set stays visible.
    console.log(
      JSON.stringify({
        evt: "position_access_shadow",
        result: "not_in_snapshot",
        position_id: positionId,
      }),
    );
    return { compared: false, reason: "not-in-snapshot" };
  }

  const divergences = diffPageAccess(servedFromTable, fromSnapshot);
  const scmMetaDiverged = servedScmMeta.explicitScm !== snapMeta.explicitScm;

  if (divergences.length > 0 || scmMetaDiverged) {
    // `scm_l2_configured` is reported alongside the cells because it is derived
    // from the same rows and gates the SCM area-guard: the two maps could agree
    // on all 50 cells while disagreeing on whether the guard enforces them.
    console.warn(
      JSON.stringify({
        evt: "position_access_shadow",
        result: "diverged",
        position_id: positionId,
        divergent_cells: divergences.length,
        divergences,
        scm_l2_table: servedScmMeta.explicitScm,
        scm_l2_snapshot: snapMeta.explicitScm,
      }),
    );
  }

  return { compared: true, divergences };
}
