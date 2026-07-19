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

// ─────────────────────────────────────────────────────────────────────────
// phoneSearchOrParts — the PHONE half of a list's free-text `.or()`.
//
// Customer phones are stored canonical E.164 ("+60123456789"; see
// scm/shared/phone.ts). A term the user actually types — "012-345 6789",
// "012 345 6789", or the local "0123456789" — therefore never substring-
// matches the stored form via a raw ilike (leading 0 dropped, `60` prepended,
// separators removed). So we emit TWO predicates: the raw term (so typing an
// E.164 fragment like "60123" still works) AND the term run through the SAME
// normaliser the write path uses, reduced to bare digits so it matches inside
// the stored `+<digits>`. Reused by SO / DO / SI so the three lists can't drift.
// ─────────────────────────────────────────────────────────────────────────
/** `phone.ilike` conditions (raw + E.164-normalised) for a list `.or()`.
 *  `escaped` is escapeForOr(raw); `raw` is the untouched query term. */
export function phoneSearchOrParts(escaped: string, raw: string, normalize: (s: string) => string | null): string[] {
  const parts = [`phone.ilike.%${escaped}%`];
  const pn = normalize(raw);
  const digits = pn ? pn.replace(/^\+/, '') : null;
  // Skip the second predicate when the normaliser adds nothing new (already a
  // bare-digit substring of `escaped`), so an ordinary text search stays cheap.
  if (digits && !escaped.includes(digits)) parts.push(`phone.ilike.%${escapeForOr(digits)}%`);
  return parts;
}
