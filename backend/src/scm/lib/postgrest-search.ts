// ─────────────────────────────────────────────────────────────────────────
// postgrest-search.ts — make operator free-text safe inside a PostgREST
// `.or(...)` filter string.
//
// THE PROBLEM
//   Several list routes interpolate raw search text into a comma-separated
//   PostgREST `.or()` filter, e.g.
//     q.or(`code.ilike.%${search}%,name.ilike.%${search}%`)
//   The `.or()` grammar uses `,` to separate conditions and `()` to group
//   them. A sofa SKU like `BOOQIT-1A(LHF)` (or any term containing `,`, `(`,
//   `)`, `{`, `}`) therefore corrupts the filter — PostgREST either 400s or
//   returns the wrong rows.
//
// THE FIX
//   Strip the PostgREST reserved grammar characters `,(){}` from the search
//   term (and trim surrounding whitespace) before it is interpolated. `ilike`
//   still matches via the surrounding `%...%` wildcards, and a normal term
//   with none of these characters is returned byte-for-byte unchanged — so
//   ordinary searches behave exactly as before.
// ─────────────────────────────────────────────────────────────────────────

/** Remove PostgREST `.or()` reserved chars (`,(){}`) so an operator's free-text
 *  (e.g. a parenthesized sofa code) can't break the filter grammar. Behaviour
 *  is identical for terms that contain none of these characters. */
export function escapeForOr(search: string): string {
  return String(search ?? '').replace(/[,(){}]/g, '').trim();
}
