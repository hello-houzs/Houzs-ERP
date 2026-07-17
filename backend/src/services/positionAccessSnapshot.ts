// ----------------------------------------------------------------------------
// positionAccessSnapshot — a PHOTOGRAPH of `position_page_access`, generated.
//
// THIS FILE IS EMPTY ON PURPOSE. IT HAS NOT BEEN GENERATED YET.
//
// The mechanism ships; the data does not, because the data was not available to
// the session that built this (no prod DB access from here). The snapshot is
// generated MECHANICALLY from the owner's live rows — never hand-written, never
// inferred from code, never reconstructed from git history. Filling this array
// by hand, or by asking a model to "work out" what each position probably has,
// is the single failure this entire file exists to prevent. An empty snapshot is
// a visible, harmless nothing. A plausible-looking invented one is an invisible
// lie that surfaces weeks later as a real employee locked out of their job.
//
// TO POPULATE IT — regenerate from PROD:
// *   node backend/scripts/export-position-access.mjs \
// *     --url https://autocount-sync-api.houzs-erp.workers.dev \
// *     --token "$DASHBOARD_API_KEY"
//
// The script overwrites this file wholesale, header and all, from
// GET /api/positions/page-access/export (routes/positions.ts). It refuses to
// write if the export looks non-prod, returns no positions, or returns zero
// explicit rows — staging is a DIFFERENT Supabase project with different rows,
// and a staging snapshot shipped as prod's would overwrite real access with
// test data.
//
// WHY A PHOTOGRAPH AND NOT A REDRAWING. The rules are moving out of this matrix
// and into backend code, one JD at a time (services/salesJdAccess.ts is the
// first). The owner's constraint on that move is the whole acceptance test, and
// he has stated it four times: "那我之前很多（例如銷售員看不到的東西等等）還要
// 重新設定過嗎?" and "如果你能在拆掉的同時，又保持我現在看到的東西和我會 edit 的
// 東西完全不受影響，每一個 position 的數據都保留". He must not re-configure a
// single cell. ~17 positions x ~26 keys is ~442 cells: a transcription gets one
// wrong, and one wrong cell is a lockout.
//
// THE CODE CANNOT TELL YOU WHAT A POSITION SEES — do not try. Nav visibility ORs
// anyPerm/anyAccess (frontend navFilter.ts:76-91), and with `scm_l2_configured`
// the `scm.access` term is stripped, so for a non-`*` user the matrix cell alone
// decides. This was proven the expensive way on 2026-07-17: Sales Director's
// access was reported as including Procurement/Transportation by reading
// `hideForSalesRep` in Sidebar.tsx; the owner said from memory that it does not,
// and HE WAS RIGHT. The data is the authority.
//
// `entries` IS THE EXPLICIT ROWS ONLY — the keys that HAVE a row. A key absent
// from `entries` had NO ROW, which is NOT the same fact as a row of "none":
// loadPageAccessForPosition resolves a child as `explicit[key] ?? out[parent]`
// (pageAccess.ts:748), so absent means INHERIT THE PARENT and "none" means
// DENIED even under a full parent. Anything that consumes this must preserve
// that distinction. Backfilling the gaps to "none" would sever inheritance on
// every child that currently rides its parent — a silent, wholesale narrowing
// of real people's access (reference_houzs_nullish_hides_ignorance: turning
// "unknown" into a confident empty value is this codebase's most repeated bug).
//
// NOT WIRED, AND NOT YET THE SWITCH. Nothing reads this. auth.ts still hydrates
// page_access from the live table (auth.ts:295-299) and the matrix is still
// editable at Team -> Positions. The sequence is deliberate: export -> the owner
// reviews the table -> he states his adjustments -> we encode them -> THEN the
// switch. Shipping the switch before he has reviewed the table is precisely what
// would force him to reconfigure.
//
// NOTE FOR WHOEVER WIRES THIS. A position ABSENT from the snapshot must NOT
// resolve to "no access". POST /api/positions writes no matrix rows, so a
// position created after the freeze would have no snapshot entry, and "absent ->
// none" would leave a new hire unable to work on day one with no UI to fix it.
// Fall back to the live table for any position the snapshot does not name.
// ----------------------------------------------------------------------------

import type { AccessLevel } from "./pageAccess";

export interface PositionAccessSnapshotEntry {
  id: number;
  name: string;
  slug: string;
  department_id: number | null;
  department_name: string | null;
  /** EXPLICIT rows only. An absent key means NO ROW (inherit), not "none". */
  entries: Readonly<Partial<Record<string, AccessLevel>>>;
}

/** Which database this was photographed from. Provenance is part of the data:
 *  staging and prod are different Supabase projects with different rows. Empty
 *  string = never generated. */
export const POSITION_ACCESS_SNAPSHOT_SOURCE = "";

// Empty = NOT GENERATED. It does not mean "no position has any access", and no
// consumer may read it that way. Anything wiring this in must treat an empty
// snapshot as "fall back to the live table", not as a matrix of denials.
export const POSITION_ACCESS_SNAPSHOT: readonly PositionAccessSnapshotEntry[] = [];
