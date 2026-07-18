// ----------------------------------------------------------------------------
// positionPolicy — THE single authoritative position-access policy, in code.
//
// WHY THIS EXISTS. Owner-directed architecture change (Lim Wei Siang, 2026-07-18):
// stop deriving a position's page access from the `position_page_access` matrix
// TABLE and define it by ONE code policy he directs line by line ("这个有那个没有").
// The end state is a SINGLE rule — not the old matrix AND a separate sales
// mechanism coexisting. This module is that one rule. The matrix stays in the DB
// (its editor + export are untouched) but is no longer READ to resolve access for
// the positions this policy covers; auth.ts asks THIS module.
//
// THE MODEL — default-FULL, restrict only the named cohorts. Owner's interim
// intent: "暂时都可以看到系统里的所有内容". EXCEPT Driver, Helper, Storekeeper,
// Storekeeper Supervisor (an explicit whitelist below) and the Sales tiers, a
// position resolves to fullAccessMap(). A position this module cannot classify
// falls to FULL, never to none — fail OPEN. That is the anti-lockout guarantee:
// "unknown" and "unrestricted" both land on full, so no covered position can
// resolve to an empty map by accident.
//
// SALES IS ONE COHORT IN THIS SAME POLICY — NOT A PARALLEL SYSTEM. This PR does
// NOT rip out the working Sales enforcement (salesJdAccess + salesScope +
// pmsAccess): sales' RESOLUTION is deferred to that existing path THIS PR only.
// But sales is a KNOWN, explicitly-marked cohort here (`cohort: "sales"`,
// `resolutionDeferred: true`), and the policy result already carries the
// enforcement FLAGS sales needs (orderScope / canSeeMargin / canSeeCommission /
// announcementScope). The follow-up folds sales' page-access levels + those
// flags INTO this same shape and drops `resolutionDeferred` — no second
// structure is invented later, because the shape that will hold sales exists now.
//
// scm_l2_configured IS DERIVED HERE, NOT FORCED. A restricted whitelist is fed
// through the SAME resolver the DB path uses (resolvePositionAccessFromRows), so
// its explicit `scm*` rows set `explicitScm` by the identical mechanism the live
// table would have — the restricted cohort is honestly SCM-configured because we
// deliberately configured its SCM areas, and the area-guard therefore ENFORCES
// its `none` denials (without that, step 3 of area-guard.ts falls open to the
// coarse scm.access umbrella and a Storekeeper could write a stock transfer). The
// FULL and fail-open branches leave `explicitScm` FALSE — the same value `*`
// gets — so nothing is force-narrowed: a full position has full on every key and
// the guard has nothing to enforce. This honours "do not force scm_l2_configured"
// where it matters (the full/gap positions, the z1 mass-lockout risk) while still
// enforcing a hand-authored, complete whitelist.
// ----------------------------------------------------------------------------

import {
  fullAccessMap,
  resolvePositionAccessFromRows,
  type AccessLevel,
  type PageAccessMeta,
} from "./pageAccess";

/** A code-defined explicit access row — same shape resolvePositionAccessFromRows
 *  reads from the DB, so the restricted whitelists resolve through the identical
 *  inherit/cascade + isValidPageKey filter as a real position_page_access row. */
interface PolicyRow {
  page_key: string;
  level: AccessLevel;
}

/** Lower-case + collapse internal whitespace + trim. Tolerant to casing/spacing
 *  drift only — NOT to substring matching (a `\b(...)`-style match would let an
 *  unrelated rename inject a restriction; see the operationJdAccess hazard note
 *  this repo carried). */
function normalisePosition(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

// ── Enforcement flags — the shape the CONVERGED policy carries for every
//    position, so the follow-up folds sales in without a second structure ─────
//
// These describe the non-page-access dimensions of a position's authority. TODAY
// they are DECLARATIVE for the full/restricted cohorts (auth.ts does not yet read
// them — those cohorts' behaviour is fully expressed by their page-access map)
// and, for SALES, they RECORD what the existing salesJdAccess/salesScope/pmsAccess
// path already enforces (own+downline order scope, hidden margin, hidden
// commission, dept-scoped announcements). The follow-up PR that migrates sales
// into this policy WIRES these fields in place of that path — the fields exist
// now precisely so that migration adds no new type.
export interface PositionAccessFlags {
  /** Row-scope for order-bearing documents (SO/DO/SI/PO...). Sales reps see
   *  their own + downline; everyone else sees all. Enforced today by
   *  lib/salesScope for the sales cohort. */
  orderScope: "own_downline" | "all";
  /** May see cost / margin columns. Hidden from the sales cohort today
   *  (canViewScmFinance / pmsAccess). */
  canSeeMargin: boolean;
  /** May see commission figures across the downline. */
  canSeeCommission: boolean;
  /** Announcement visibility. Sales is dept-scoped; management/ops see all.
   *  (Announcements are permission-gated today — announcements.read — so this is
   *  the flag the converged policy will drive, not a live gate this PR.) */
  announcementScope: "dept" | "all";
}

/** The unrestricted / management default — see everything, no row-scope. */
const FLAGS_FULL: PositionAccessFlags = {
  orderScope: "all",
  canSeeMargin: true,
  canSeeCommission: true,
  announcementScope: "all",
};

/** Restricted labour cohort — they do not operate order documents, and must not
 *  see money. Conservative by construction (their page-access map already denies
 *  the surfaces these would gate). */
const FLAGS_RESTRICTED: PositionAccessFlags = {
  orderScope: "all", // they reach no order-bearing page, so scope is moot
  canSeeMargin: false,
  canSeeCommission: false,
  announcementScope: "dept",
};

/** Sales cohort — RECORDS the existing enforcement (own+downline, margin hidden,
 *  commission hidden at rep level, dept announcements) so the follow-up wires
 *  these instead of re-deriving them. */
const FLAGS_SALES: PositionAccessFlags = {
  orderScope: "own_downline",
  canSeeMargin: false,
  canSeeCommission: false,
  announcementScope: "dept",
};

// ── The restricted whitelists — the owner's manual, per position ─────────────
//
// Anything NOT listed for a restricted position resolves to "none" (via the
// resolver's pass-1 default), which is what "EVERYTHING ELSE: none" means. Only
// real PAGES[] keys appear here; the resolver's isValidPageKey filter drops any
// key that later leaves the registry.
//
// WHY THE L1 AREA KEYS APPEAR HERE. The nav is filtered by navFilter.ts: a node
// shows only if it passes its OWN visibility gate AND (for a group) has a
// surviving child. The top-level "Supply Chain" umbrella's gate is its `anyAccess`
// = the L1 area keys ONLY (`scm.warehouse`, `scm.transportation`, …), and for an
// scm_l2_configured user the `scm.access` permission is STRIPPED from the nav perm
// check — so an L2-only grant (e.g. `scm.warehouse.inventory` alone) leaves the
// umbrella's gate failing and the WHOLE SCM tree is dropped before the leaf is
// reached. So a restricted whitelist must carry the L1 parent of each area it
// grants, at `view`, and then explicitly DENY the sibling children it must not
// open (an explicit `none` overrides the parent's inherited `view`). L1 area keys
// gate NO backend route (routes gate on the L2 keys — verified in scm/index.ts),
// so granting the L1 opens nav visibility WITHOUT opening any write.
//
// Delivery Planning is gated — nav, route, AND every /delivery-planning, /trips,
// /dp-orders, /fleet, /lorry-* backend mount — on `scm.transportation.drivers`
// (verified against scm/index.ts + Sidebar.tsx + App.tsx). Granting the L1
// `scm.transportation` = view inherits `scm.transportation.drivers` = view, which
// shows the board and satisfies the GET reads (it also shows Fleet / Lorry /
// Regions — they ride the SAME key, unchanged from today's Driver/Helper). The
// driver's own POD / delivery-step SUBMIT is a WRITE on that same key and stays a
// follow-up (owner: page-level view now; the "only MY assigned jobs" row-scope +
// step submit is a separate build). Announcements is NOT a page-access key — it
// is gated on the `announcements.read` PERMISSION (routes/announcements.ts) — so
// it is unaffected by this map and stays open exactly as today; absent here.

const DRIVER_HELPER_ROWS: readonly PolicyRow[] = [
  // Delivery Planning board — view only. L1 grant; drivers inherits view.
  { page_key: "scm.transportation", level: "view" },
];

const STOREKEEPER_ROWS: readonly PolicyRow[] = [
  // Everything Driver/Helper get.
  { page_key: "scm.transportation", level: "view" },
  // Warehouse RACKING + rack/bin inventory VIEW. Racking/bin live under the
  // Inventory + Warehouses pages, both gated on scm.warehouse.inventory (there
  // is no finer racking key). The L1 `scm.warehouse` = view opens the Warehouse
  // nav group; inventory = view shows the stock listing / racks. Stock Transfer /
  // Stock Take / Stock Adjustment are explicitly DENIED so they do not inherit
  // the parent's view: a Storekeeper VIEWS inventory but every stock-mutating
  // write 403s (adjustments is now its own separately-guarded write).
  { page_key: "scm.warehouse", level: "view" },
  { page_key: "scm.warehouse.inventory", level: "view" },
  { page_key: "scm.warehouse.transfers", level: "none" },
  { page_key: "scm.warehouse.stock_take", level: "none" },
  { page_key: "scm.warehouse.adjustments", level: "none" },
];

const STOREKEEPER_SUPERVISOR_ROWS: readonly PolicyRow[] = [
  // Everything Storekeeper gets.
  { page_key: "scm.transportation", level: "view" },
  { page_key: "scm.warehouse", level: "view" },
  { page_key: "scm.warehouse.inventory", level: "view" },
  { page_key: "scm.warehouse.transfers", level: "none" },
  { page_key: "scm.warehouse.stock_take", level: "none" },
  { page_key: "scm.warehouse.adjustments", level: "none" },
  // Goods Receipt — edit, so the supervisor can RECEIVE goods (raise/confirm a
  // GRN is a write). This grant alone keeps the Procurement nav GROUP alive (the
  // group survives on the grn child), so the L1 `scm.procurement` is deliberately
  // NOT granted — granting it would cascade `view` onto Purchase Order / Purchase
  // Invoice / Products / Suppliers / MRP / Purchase Returns, which the manual
  // denies. So `scm.procurement` stays none (po / pi / … inherit none), and only
  // Goods Receipt opens.
  { page_key: "scm.procurement.grn", level: "edit" },
];

/**
 * The restricted cohort, keyed by normalised position name. Each entry is the
 * WHOLE of that position's page access (default-none for everything unlisted).
 *
 * Aliases: the map is the single place a future documented rename is added, so a
 * partial revert never silently drops a restriction — none of the two renames the
 * repo has seen ("Purchasing"->"Procurement/Purchasing", "Logistic"->"Logistic
 * Admin") touch these four names, so no alias is needed today.
 */
const RESTRICTED_ROWS: ReadonlyMap<string, readonly PolicyRow[]> = new Map(
  [
    ["Driver", DRIVER_HELPER_ROWS],
    ["Helper", DRIVER_HELPER_ROWS],
    ["Storekeeper", STOREKEEPER_ROWS],
    ["Storekeeper Supervisor", STOREKEEPER_SUPERVISOR_ROWS],
  ].map(([name, rows]) => [normalisePosition(name as string), rows as readonly PolicyRow[]]),
);

/**
 * The Sales cohort — matched the same way the rest of the Sales enforcement is
 * (salesJdAccess.isSalesCohort, pmsAccess.isSalesUser): department name
 * containing "sales", or a position name starting with "Sales". Keeping ONE
 * detection rule is what stops a Sales position from accidentally becoming
 * full-access.
 */
const SALES_NAME = /^sales/i;

function isSalesPosition(input: PositionPolicyInput): boolean {
  const dept = (input.department_name ?? "").toLowerCase();
  if (dept.includes("sales")) return true;
  return SALES_NAME.test((input.position_name ?? "").trim());
}

export interface PositionPolicyInput {
  position_name: string | null;
  department_name: string | null;
}

/**
 * The resolution outcome for a positioned, non-`*` user — ONE shape for all three
 * cohorts, so sales converges into it without a new type.
 *
 * - cohort "full"       — `pageAccess` = fullAccessMap() (unrestricted, owner-
 *                         approved interim). `scmConfigured` FALSE (same as `*`).
 * - cohort "restricted" — `pageAccess` = the owner's whitelist; `scmConfigured`
 *                         is the honest explicit-scm signal so the area-guard
 *                         enforces the whitelist's `none` denials.
 * - cohort "sales"      — `resolutionDeferred` = true and `pageAccess` = null:
 *                         the caller KEEPS the existing sales resolution THIS PR
 *                         (legacy matrix + applySalesJdOverride). `flags` records
 *                         the enforcement the follow-up will wire here. This is
 *                         the convergence marker, not a permanent second rule.
 *
 * `flags` is present on EVERY result (the convergence shape); `pageAccess` is a
 * concrete map for full + restricted and NULL only for the deferred sales cohort;
 * `resolutionDeferred` is true ONLY for sales this PR.
 */
export interface PositionPolicy {
  cohort: "full" | "restricted" | "sales";
  pageAccess: Record<string, AccessLevel> | null;
  scmConfigured: boolean;
  flags: PositionAccessFlags;
  /** True when this cohort's page-access RESOLUTION is deferred to its existing
   *  path this PR (sales only). The follow-up sets this false once sales' levels
   *  live in this policy. */
  resolutionDeferred: boolean;
}

/**
 * Classify a position and, for the resolved cohorts, produce its page access.
 *
 * FAIL OPEN: a position that matches neither the restricted set nor the Sales
 * rule returns cohort "full". There is no path to an empty/near-empty map —
 * unknown and unrestricted both land on full. This is the anti-lockout
 * invariant, proven by positionPolicy.test.ts over every snapshot position plus
 * a hypothetical unclassified name.
 */
export function resolvePositionPolicy(input: PositionPolicyInput): PositionPolicy {
  const name = normalisePosition(input.position_name ?? "");

  // Restricted whitelist wins first — an exact-name cohort, so a Sales position
  // can never fall in here.
  const rows = name ? RESTRICTED_ROWS.get(name) : undefined;
  if (rows) {
    const meta: PageAccessMeta = { explicitScm: false };
    const pageAccess = resolvePositionAccessFromRows(rows, meta);
    return {
      cohort: "restricted",
      pageAccess,
      scmConfigured: meta.explicitScm,
      flags: FLAGS_RESTRICTED,
      resolutionDeferred: false,
    };
  }

  // Sales — a KNOWN cohort in this one policy, but its RESOLUTION is deferred to
  // the existing path this PR. Do NOT flip to full, do NOT migrate to a whitelist
  // yet; the follow-up folds its levels in here.
  if (isSalesPosition(input)) {
    return {
      cohort: "sales",
      pageAccess: null,
      scmConfigured: false,
      flags: FLAGS_SALES,
      resolutionDeferred: true,
    };
  }

  // Everyone else — and anything unclassified — is FULL (owner-approved interim,
  // fail-open). `scmConfigured` FALSE, same as `*`: a full map needs no per-area
  // enforcement.
  return {
    cohort: "full",
    pageAccess: fullAccessMap(),
    scmConfigured: false,
    flags: FLAGS_FULL,
    resolutionDeferred: false,
  };
}
