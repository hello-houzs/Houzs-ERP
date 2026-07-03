// ----------------------------------------------------------------------------
// Houzs permission gate helpers for SCM routes.
//
// Replaces the 2990-style `scm.staff.role` lookups (which are useless in Houzs
// because the bridge pins every SCM caller to one super_admin row — see
// scm/middleware/auth.ts). These read the REAL Houzs user's permissions stashed
// on `houzsUser` and gate on the flat permission keys defined in
// services/permissions.ts.
//
// Use `requireHouzsPerm(perm)` as Hono middleware, or `hasHouzsPerm(c, perm)`
// inline inside a handler body when the gate decision branches with the
// request payload (e.g. price-override flag, salesperson stamping).
// ----------------------------------------------------------------------------

import type { MiddlewareHandler } from 'hono';
import { hasPermission } from '../../services/permissions';
import type { Env, Variables } from '../env';

/* Structural source of the stashed houzsUser — satisfied by the real Hono
   context AND by mfg-sales-orders' SoCreateContext (the factored SO-create
   core runs headless for the background scan job with a synthetic context).
   Only `get('houzsUser')` is required; nothing else on the context is read. */
type HouzsUserSource = { get(key: 'houzsUser'): Variables['houzsUser'] };

/** Read the REAL Houzs caller's granted permissions (Set fast path, array
 *  fallback). Returns an empty array when the bridge has not stashed them
 *  (defence-in-depth — every authed request should populate houzsUser). */
function grantedFor(c: HouzsUserSource): ReadonlyArray<string> | ReadonlySet<string> {
  const hu = c.get('houzsUser');
  return hu?.permissions_set ?? hu?.permissions ?? [];
}

/** Inline check — true when the caller holds `perm` (or the `*` wildcard). */
export function hasHouzsPerm(c: HouzsUserSource, perm: string): boolean {
  return hasPermission(grantedFor(c), perm);
}

/** Hono middleware — 403s when the caller lacks `perm`. Mirrors
 *  middleware/auth.ts::requirePermission but reads from `houzsUser`. */
export function requireHouzsPerm(perm: string): MiddlewareHandler<{ Bindings: Env; Variables: Variables }> {
  return async (c, next) => {
    if (!hasHouzsPerm(c, perm)) {
      return c.json({ error: `Forbidden: missing ${perm}` }, 403);
    }
    await next();
  };
}
