// ----------------------------------------------------------------------------
// rpc-missing — "is this PostgREST error 'the function is not there' rather than
// 'the function ran and failed'?"
//
// WHY THIS IS SHARED AND NOT COPIED. Every atomic-write helper in this tree ships
// its SQL function in scripts/scm-schema/ (manually applied, staging first) and
// its TypeScript in the deploy, so between a merge and the apply the RPC is
// ABSENT and the caller must fall back. That fallback is only safe if "absent" is
// distinguished from "failed" with total precision: a fallback taken on a real
// error re-runs a non-atomic path against a database that just rejected the
// atomic one. The predicate is therefore one function, not one per caller — two
// copies drifting apart means one of them starts treating a live failure as a
// missing function.
// ----------------------------------------------------------------------------

/**
 * True when a PostgREST error means the RPC does not exist yet. Anything else is
 * a real failure and must NOT silently fall back.
 */
export function isMissingRpc(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  // PGRST202 = "Could not find the function ... in the schema cache". 42883 =
  // Postgres undefined_function (surfaced when the schema cache is stale).
  if (err.code === 'PGRST202' || err.code === '42883') return true;
  return /could not find the function|schema cache|undefined function|does not exist/i.test(err.message ?? '');
}
