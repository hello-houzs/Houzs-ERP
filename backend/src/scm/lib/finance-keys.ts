// ----------------------------------------------------------------------------
// finance-keys.ts — the Sales Order finance column vocabulary: the header and
// line keys that may reach ONLY a finance-viewer (lib/houzs-perms.
// canViewScmFinance, mirroring pmsAccess.isFinanceViewer).
//
// WHY THIS FILE EXISTS: the list used to be re-declared per route, and every
// copy drifted from the others. #574 (list columns), #600 (DO + SI detail),
// #625 (SO detail), #632 (DR detail) are four instances of ONE bug — "the strip
// was authored for one payload and the sibling never got it". /reports was the
// fifth and widest: it had no copy at all, so it shipped Cost / Margin /
// Margin% for every salesperson's every order, company-wide, to any Sales
// Executive. Keep ONE list, imported everywhere, so a newly-exposed finance
// column cannot be gated on some surfaces and silently open on others.
//
// Adding a column here gates it EVERYWHERE at once. If you add a cost/margin
// column to a SELECT, add its key here in the same PR.
// ----------------------------------------------------------------------------

/* Header-level: cost / margin / per-category revenue+cost subtotals + deposit.
   Order totals shown to EVERYONE who passes the access gate (local_total_centi
   / balance_centi / paid_centi / paid_total_centi / total_revenue_centi) are
   deliberately NOT listed here — that is the line #625 drew and this keeps. */
export const SO_FINANCE_KEYS = [
  'mattress_sofa_centi', 'bedframe_centi', 'accessories_centi', 'others_centi', 'service_centi',
  'mattress_sofa_cost_centi', 'bedframe_cost_centi', 'accessories_cost_centi', 'others_cost_centi', 'service_cost_centi',
  'total_cost_centi', 'total_margin_centi', 'margin_pct_basis', 'deposit_centi',
] as const;

/* Per-LINE cost/margin (the ITEM row carries unit_cost_centi / line_cost_centi
   / line_margin_centi). All snake_case — these routes emit PostgREST column
   names verbatim. A camelCase surface (e.g. `unitCostCenti`) would escape this
   list, so a route that camelCases its payload must strip in ITS vocabulary. */
export const SO_ITEM_FINANCE_KEYS = ['unit_cost_centi', 'line_cost_centi', 'line_margin_centi'] as const;
