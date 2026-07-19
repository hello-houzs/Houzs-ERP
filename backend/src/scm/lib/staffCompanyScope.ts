// ─────────────────────────────────────────────────────────────────────────
// staffCompanyScope.ts — derive which company a salesperson (scm.staff row)
// belongs to, from the Team company grants, so the SO / SI / DR / consignment
// salesperson pickers show only the ACTIVE company's people.
//
// THE LEAK THIS CLOSES: GET /api/scm/staff has no company predicate, so the
// salesperson dropdown listed BOTH companies' salespeople — a Houzs order could
// pick a 2990 salesperson and vice-versa (BUG-HISTORY.md, the salesperson arm of
// the cross-company picker-leak class).
//
// THE RULE (owner 2026-07-19, verbatim: "你就看我们team那边sales under什么公司
// 除非公司是both") — a salesperson's company is whatever their Team assignment
// says, and someone granted BOTH companies belongs to both. scm.staff has NO
// company_id (it is a SHARED master — migration 0083, restated in staff-mirror.ts
// and migrate-2990-staff.mjs), so the attribution is DERIVED, never stored:
//
//   • LINKED row (staff.user_id set → a Houzs User-Management user via migration
//     0066): company set = that user's public.user_companies grants. A user
//     granted {HOUZS, 2990} appears in BOTH pickers; granted {2990} only appears
//     when 2990 is active. "both" falls straight out of set-membership — no
//     special case.
//
//   • LINKED row with ZERO grants: attribute to the HOUZS base company only.
//     The Team backfill's founding rule is "every existing user belongs to Houzs
//     (company 1)" (phase0e-backfill-user-companies.sql rule 1), so an ungranted
//     linked user is a Houzs user by default. We deliberately do NOT mirror
//     companyContext's caller-side FAIL-OPEN ("0 grants = ALL companies") for a
//     LISTED salesperson: applied here it would re-open the very leak we are
//     closing (any ungranted user would surface in BOTH pickers). Real 2990
//     people never depend on this branch — migrate-2990-staff.mjs gives them an
//     explicit 2990 grant, and un-migrated 2990 rows are UNLINKED (next branch).
//
//   • UNLINKED row (staff.user_id NULL): a frozen 2990 import row
//     (migrate-2990-into-houzs.mjs) / a live 2990 mirror row (staff-mirror.ts) —
//     no Houzs user writes it; `user_id IS NULL` is that receiver's own
//     handover flag. Attribute to the mirror-source company 2990. The single
//     exception is the seeded system row (SYSTEM_STAFF_ID), a Houzs artifact,
//     attributed to HOUZS.
//
// Company ids are RESOLVED FROM companies.code (HOUZS / 2990), never hardcoded —
// the ids differ across staging/prod. See scm/lib/companyScope.ts
// houzsCompanyId / mirrorCompanyId.
// ─────────────────────────────────────────────────────────────────────────

/** The company ids this request needs, all resolved from companies.code. */
export interface StaffScopeCompanyIds {
  /** The ACTIVE company for the request — a positive integer. The route
   *  resolves it before calling here; there is no "unresolved" branch to fall
   *  through, matching the REQUIRED-predicate rule for company scoping. */
  active: number;
  /** companies.code === 'HOUZS' — the base company an ungranted LINKED user and
   *  the system row default to. undefined only if the companies master lacks a
   *  HOUZS row (then those rows resolve to no company → hidden, i.e. fail
   *  closed). */
  houzs: number | undefined;
  /** companies.code === '2990' — the mirror-source company UNLINKED rows are
   *  attributed to. undefined only if the master lacks a 2990 row (then unlinked
   *  rows resolve to no company → hidden). */
  mirror: number | undefined;
}

/** The minimum a staff row must expose to be scoped: its id and its user link. */
export interface StaffScopeRow {
  id: string;
  user_id: number | null;
}

/**
 * The companies (ids) a staff row belongs to, derived purely from grants — see
 * the four-branch rule in the file header. `grantsByUserId` maps a linked user's
 * public.users id to the company ids granted to them in public.user_companies;
 * an absent entry means that user has ZERO grant rows.
 *
 * Returns a fresh array so a caller can neither mutate the grant map through it
 * nor share it across rows.
 */
export function staffCompanyIds(
  row: StaffScopeRow,
  grantsByUserId: Map<number, number[]>,
  ids: Pick<StaffScopeCompanyIds, "houzs" | "mirror">,
  systemStaffId: string,
): number[] {
  // The seeded system row is a Houzs artifact, not a 2990 mirror row — even
  // though it carries user_id NULL like the mirror rows do. Attribute to HOUZS.
  if (row.id === systemStaffId) return ids.houzs != null ? [ids.houzs] : [];

  if (row.user_id != null) {
    const grants = grantsByUserId.get(Number(row.user_id));
    if (grants && grants.length > 0) return grants.slice();
    // LINKED but ungranted → HOUZS base (Team backfill rule 1). NOT fail-open.
    return ids.houzs != null ? [ids.houzs] : [];
  }

  // UNLINKED (no Houzs user) → the 2990 mirror source.
  return ids.mirror != null ? [ids.mirror] : [];
}

/** True when a staff row belongs to the ACTIVE company. */
export function staffRowInActiveCompany(
  row: StaffScopeRow,
  grantsByUserId: Map<number, number[]>,
  ids: StaffScopeCompanyIds,
  systemStaffId: string,
): boolean {
  return staffCompanyIds(row, grantsByUserId, ids, systemStaffId).includes(ids.active);
}

/**
 * Filter a staff list to the rows that belong to the ACTIVE company. Preserves
 * input order (the roster arrives ordered by staff_code) and never mutates the
 * input. This is the pure core the GET /staff/pickable endpoint applies after
 * resolving the active company and loading grants.
 */
export function filterStaffToCompany<T extends StaffScopeRow>(
  rows: T[],
  grantsByUserId: Map<number, number[]>,
  ids: StaffScopeCompanyIds,
  systemStaffId: string,
): T[] {
  return rows.filter((r) => staffRowInActiveCompany(r, grantsByUserId, ids, systemStaffId));
}
