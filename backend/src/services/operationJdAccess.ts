// ----------------------------------------------------------------------------
// operationJdAccess — the Operation cohort's warehouse WRITE access, keyed off
// the ORG CHART in code, not the RBAC config matrix. Sibling of salesJdAccess.
//
// WHY THIS EXISTS. Owner, 2026-07-18: the operation-side staff must be able to
// perform the three warehouse operations — STOCK TRANSFER, STOCK COUNT (stock
// take), and STOCK ADJUSTMENT — mainly done by purchasing. Today they cannot:
// the write side of these pages is gated on `scm.warehouse.* = edit` (per-method
// area-guard), and NO position carries that edit. Only `*` (Owner / Super Admin)
// can, so every ops attempt at a transfer / count / adjustment 403s. This closes
// that gap for the cohort he named, the same way salesJdAccess encodes the Sales
// JD: a RULE in backend code, not a cell someone can mis-click.
//
// WHAT THE GRANT OPENS, mechanically (verified against the code, not assumed):
//   - COARSE gate: index.ts mounts `requireScmAccess` on /api/scm/*, which is
//     ADDITIVE — it passes any caller whose page_access has ANY `scm*` area at
//     >= view (middleware/auth.ts). Writing `scm.warehouse.* = edit` here makes
//     the cohort pass it automatically; NO `scm.access` migration is needed.
//   - FINE gate: scm/index.ts mounts `/inventory/adjustments` →
//     scm.warehouse.adjustments, `/inventory/*` → scm.warehouse.inventory,
//     `/stock-transfers/*` → scm.warehouse.transfers, `/stock-takes/*` →
//     scm.warehouse.stock_take. `scmAreaGuard` (scm/middleware/area-guard.ts)
//     requires `edit` for writes (POST/PATCH/PUT/DELETE) and `view` for GET. The
//     `edit` grant satisfies both. Every cohort position already carries an
//     explicit `scm*` row (prod snapshot), so each is `scm_l2_configured` and the
//     write gate is genuinely ENFORCED for them — the grant is what unblocks it.
//
// STOCK ADJUSTMENT IS NOW ITS OWN KEY. The owner split adjusting stock off
// viewing it (2026-07-18): POST /inventory/adjustments moved to a dedicated
// sub-mount gated on `scm.warehouse.adjustments` (routes/inventory-adjustments.ts).
// So the cohort grant now covers `adjustments` AS WELL AS `inventory` — dropping
// it would take away the adjust capability the cohort has today via the fused
// inventory grant. Both keys stay in OPERATION_JD_KEYS below.
//
// DRIVER / HELPER ARE DELIBERATELY EXCLUDED. Owner 2026-07-18: they are delivery
// labour and must NOT receive stock-write — stock adjustment changes inventory
// valuation, an internal-control point. They share "Operation Department" with
// the cohort, so a department match cannot separate them; the cohort is matched
// by an EXPLICIT position-name set instead (see below). Sales + Finance cohorts
// are untouched — their positions are simply not in the set.
// ----------------------------------------------------------------------------

import { levelRank, type AccessLevel } from "./pageAccess";

/**
 * The Operation cohort — the SIX positions the owner named on 2026-07-18, as an
 * EXPLICIT, documented set. Matched against a normalised `position_name`
 * (lower-cased + whitespace-collapsed), so casing / spacing drift does not drop
 * the grant, but an unrelated rename can NEVER inject it.
 *
 * WHY AN EXPLICIT SET AND NOT A `\b(...)` REGEX. pmsAccess.ts's DIRECTOR_POSITIONS
 * uses `/\b(Super Admin|Sales Director|Finance Manager)\b/i`, and its own header
 * flags that a `\b` word-boundary pattern is a rename-INJECTION hazard: any
 * future position whose name merely CONTAINS one of these words would silently
 * inherit the grant. A stock-write grant that leaks onto an unintended position
 * is exactly the internal-control failure the Driver/Helper exclusion exists to
 * prevent, so this cohort is a closed set of full names — nothing partial
 * matches, and adding a member is a visible, deliberate edit to this list.
 *
 * THE FLIP SIDE, stated so the next reader knows the trade. Exact-set matching
 * means a rename that CHANGES meaning (e.g. "Storekeeper" -> "Store Keeper")
 * drops the grant until this set is updated — the owner would see the setting
 * "do nothing" again. That is the safer failure (under-grant, not over-grant) for
 * a valuation-affecting write, and the two prior real renames the repo has seen
 * ("Purchasing" -> "Procurement/Purchasing", "Logistic" -> "Logistic Admin") are
 * carried below as documented aliases so a partial revert to either does NOT
 * silently drop the grant. Anything beyond those known variants is a code change,
 * on purpose.
 */
const OPERATION_POSITIONS: ReadonlySet<string> = new Set(
  [
    // The six current prod names (positionAccessSnapshot.ts, ground truth).
    "Procurement/Purchasing",
    "Operation Manager",
    "Operation Executive",
    "Logistic Admin",
    "Storekeeper",
    "Storekeeper Supervisor",
    // Documented prior names (memory: the two renames that already moved
    // permissions silently). Kept so a revert does not re-open the gap.
    "Purchasing",
    "Logistic",
  ].map(normalisePosition),
);

/** Lower-case + collapse internal whitespace + trim. Tolerant to casing and
 *  spacing drift only — NOT to word-substring matching (that is the hazard). */
function normalisePosition(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

function isOperationCohort(u: {
  position_name?: string | null;
}): boolean {
  const pos = u.position_name;
  if (!pos) return false;
  return OPERATION_POSITIONS.has(normalisePosition(pos));
}

/**
 * The four warehouse WRITE pages the cohort is granted `edit` on. These are the
 * exact keys `scmAreaGuard` enforces for the operations (scm/index.ts):
 *   - scm.warehouse.inventory   — Inventory page (stock listing / stock card)
 *   - scm.warehouse.adjustments — stock ADJUSTMENT (POST /inventory/adjustments)
 *   - scm.warehouse.transfers   — stock TRANSFER
 *   - scm.warehouse.stock_take  — stock COUNT / take
 *
 * `adjustments` was added when the owner split stock ADJUSTMENT off Inventory:
 * the write moved from `scm.warehouse.inventory` to its own
 * `scm.warehouse.adjustments` guard, so the cohort — who adjust stock today via
 * the fused inventory grant — must carry `edit` on the new key too, or the split
 * would silently take their adjust capability away. Keeping `inventory` here as
 * well preserves their access to the Inventory page + the reads the adjustment
 * form needs (warehouses / buckets / movements still ride /inventory).
 */
const OPERATION_JD_KEYS: readonly string[] = [
  "scm.warehouse.inventory",
  "scm.warehouse.adjustments",
  "scm.warehouse.transfers",
  "scm.warehouse.stock_take",
];

const GRANT: AccessLevel = "edit";

/**
 * Apply the Operation JD over a hydrated page-access map. GRANT-ONLY.
 *
 * ADDITIVE, NEVER LOWERING. Each of the three keys is RAISED toward `edit` and
 * never below its current level — `levelRank(current) < levelRank(edit)` gates
 * the write, so an existing `full` (e.g. Operation Manager, whose matrix row is
 * `scm = full` and thus already resolves these keys to `full`) is left at `full`,
 * not downgraded to `edit`. A grant that could lower a level is a lockout, the
 * opposite of the ask.
 *
 * The `*` wildcard (Owner / IT) is exempt and returns UNTOUCHED — it arrives as
 * fullAccessMap() and already has everything; letting the override matter for it
 * could only narrow. Everyone outside the cohort is returned untouched too.
 */
export function applyOperationJdOverride(
  pageAccess: Record<string, AccessLevel>,
  user: {
    permissions: ReadonlySet<string> | string[];
    position_name: string | null;
    department_name: string | null;
  },
): Record<string, AccessLevel> {
  const perms = Array.isArray(user.permissions)
    ? new Set(user.permissions)
    : user.permissions;
  if (perms.has("*")) return pageAccess;
  if (!isOperationCohort(user)) return pageAccess;

  const out = { ...pageAccess };
  for (const key of OPERATION_JD_KEYS) {
    const current = (out[key] ?? "none") as AccessLevel;
    if (levelRank(current) < levelRank(GRANT)) out[key] = GRANT;
  }
  return out;
}
