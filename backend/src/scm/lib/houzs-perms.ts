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
import { isDirectorUser, isSalesUser } from '../../services/pmsAccess';
import type { AuthUser } from '../../services/auth';
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

/**
 * True when the caller may see ALL sales-side documents — Sales Orders, Sales
 * Invoices, Delivery Orders, Consignment Orders, Sales Analysis. Two INDEPENDENT
 * grants, OR-ed together (additive — this never removes the existing permission
 * bypass, only widens):
 *   1. the flat permission key `scm.so.view_all` (legacy path — Owner / IT Admin
 *      pass via `*`, other positions via the Team > Positions matrix), OR
 *   2. a DIRECTOR by STABLE ORG FIELD — Super Admin / Sales Director / Finance
 *      Manager (pmsAccess.isDirectorUser). This aligns Sales Orders with Service
 *      Cases (assr.ts) and Finance, which ALREADY grant the director-position
 *      the full-visibility tier. Keyed off the org position, NOT the configurable
 *      permission matrix.
 *
 * isDirectorUser needs the caller's position_name + permissions_set. Inside
 * /api/scm/* the `user` context is the pinned scm.staff system row (no
 * position), so we read the REAL Houzs caller stashed on `houzsUser` —
 * scm/middleware/auth.ts mirrors position_name there for exactly this check.
 */
export function canViewAllSales(c: HouzsUserSource): boolean {
  if (hasHouzsPerm(c, 'scm.so.view_all')) return true;
  const hu = c.get('houzsUser');
  if (!hu) return false;
  // isDirectorUser only reads position_name + permissions_set; feed it a
  // minimal AuthUser-shaped object built from the stashed real caller.
  return isDirectorUser({
    position_name: hu.position_name ?? null,
    permissions_set: hu.permissions_set,
  } as AuthUser);
}

/**
 * True when the REAL caller is Sales staff by STABLE ORG FIELDS —
 * pmsAccess.isSalesUser (position "Sales …" OR a department name containing
 * "sales"). Keyed off org fields, NOT the configurable permission matrix.
 *
 * Same caller-source shim as canViewAllSales: inside /api/scm/* the `user`
 * context is the pinned scm.staff system row (no position/department), so we
 * read the REAL Houzs caller stashed on `houzsUser` (scm/middleware/auth.ts
 * mirrors position_name + department_name there for exactly these checks).
 *
 * Used by the SO Amendment submit gate so every salesperson can raise an
 * amendment on their OWN locked Sales Order (ownership is enforced separately
 * via salesDocOutOfScope) — additive to the flat `scm.amendment.create` grant.
 */
export function isSalesCaller(c: HouzsUserSource): boolean {
  const hu = c.get('houzsUser');
  if (!hu) return false;
  // isSalesUser reads position_name + department_name; feed it a minimal
  // AuthUser-shaped object built from the stashed real caller.
  return isSalesUser({
    position_name: hu.position_name ?? null,
    department_name: hu.department_name ?? null,
    permissions_set: hu.permissions_set,
  } as AuthUser);
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
