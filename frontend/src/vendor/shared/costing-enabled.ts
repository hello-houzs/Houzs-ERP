// ----------------------------------------------------------------------------
// costing-enabled — the ONE switch for Houzs cost/margin display.
//
// OFF because Houzs has no cost data, not because the feature is unwanted.
// The catalog was seeded WITHOUT prices (owner 2026-06-22: "不需要價格先"), so
// mfg_products.cost_price_sen is empty across all ~1326 SKUs. Every consequence
// follows from that one fact:
//
//   cost_price_sen empty
//     -> snapshotUnitCostSen falls through to 0 on every SO line
//     -> total_cost_centi = 0
//     -> margin_pct_basis = round((margin/total) * 10000) = 10000
//     -> the Totals-Margin card reported "100.0% margin" in GREEN, on every
//        order, to a finance viewer — i.e. the one person who acts on it.
//
// Owner 2026-07-16, on being shown that: "那個costing 應該是整個remove 掉啊 不是
// show naan" — remove the costing entirely; don't dress it up. He is right, and
// this is his own "off, not hide" rule: a feature with no data is not a feature
// needing a better empty state, it is a feature that is not on yet. A card
// rendering "—" or "cost not recorded" would still be HIDING it.
//
// TO TURN IT BACK ON: seed cost_price_sen for the catalog, then flip this to
// true. Nothing else needs restoring — the TotalsMarginCard components are
// deliberately left in place, unmounted, so this stays a one-line change and
// never becomes an archaeology exercise.
//
// Deliberately a build-time constant, not a data-derived check ("does any
// product have a cost?"). A derived check would flip on the FIRST seeded SKU
// while 1325 were still empty — reporting 100% margin on everything else, which
// is the exact bug this closes, only now intermittent and harder to see.
// ----------------------------------------------------------------------------

/** Whether cost / margin may be DISPLAYED anywhere in the Houzs document UI.
 *  See the header: false until the catalog carries real costs. This gates
 *  display only — the server still computes and stores cost/margin, and the
 *  finance-viewer gate (canViewScmFinance / project_finance_viewer) still
 *  applies independently on top of this. Both must pass to show a number. */
// Typed `boolean`, NOT left to infer the literal `false`. With the literal type
// every `COSTING_DISPLAY_ENABLED && x` narrows to `false`, and the strict
// `tsc -b` the CI runs can then flag the gated branches as unreachable — the
// annotation keeps the OFF state a value, not a type.
export const COSTING_DISPLAY_ENABLED: boolean = false;
