import type { MiddlewareHandler } from "hono";
import type { Env, Variables } from "../env";
import type { AuthUser } from "../../services/auth";
import { meetsLevel, type AccessLevel } from "../../services/pageAccess";

// ── L2 per-area WRITE authorization for /api/scm/* ──────────────────────────
//
// SAFE, ADDITIVE layer on top of the coarse `requireScmAccess` umbrella that
// already gates /api/scm/* in the main index.ts. Each SCM sub-router is mounted
// in scm/index.ts behind `scmAreaGuard('<L2 area key>')`, which enforces the L2
// page-access matrix per HTTP method:
//
//   GET / HEAD            → require 'view'   (read)
//   POST / PATCH / PUT /  → require 'edit'   (write/void/delete)
//   DELETE
//
// NO-LOCKOUT ROLLOUT — the gate is enforced ONLY for users who already have an
// explicit SCM L2 configuration. Resolution order:
//   1. Owner / wildcard (`*`)        → next()  (bypass; never gated)
//   2. user.scm_l2_configured === true → require meetsLevel(level, required),
//                                         else 403  (ENFORCED)
//   3. otherwise (no SCM L2 rows)    → next()  (fall back to the coarse
//                                         scm.access umbrella already enforced
//                                         upstream — so no current scm.access
//                                         holder is locked out before the
//                                         matrix is seeded)
//
// IMPORTANT — middleware ordering: this runs from `scm.use('/<prefix>/*', ...)`
// in scm/index.ts, which executes BEFORE the mounted sub-router's own
// `router.use('*', supabaseAuth)`. supabaseAuth REPLACES c.get('user') with a
// Supabase system-staff shape; this guard reads the Houzs AuthUser while it is
// still intact. Hence the cast from the scm Variables.user (typed Supabase User)
// to AuthUser here.

const isWrite = (method: string): boolean =>
  method === "POST" || method === "PATCH" || method === "PUT" || method === "DELETE";

/**
 * Options — least-privilege escape hatches for routes whose L2 "home" area is
 * an ADMIN area but whose consumers are ordinary staff (added 2026-07-04 to
 * unblock the mobile SO + scan flow for Members, e.g. Sales Executive with
 * scm.sales.* = view and everything else = none):
 *
 * - `openRead` — GET/HEAD skip the per-area check entirely (writes still
 *   enforce `edit` on the area). For SO-flow REFERENCE reads that happen to
 *   live under scm.procurement.products (so-dropdown-options, fabric-library,
 *   mfg-products, maintenance-config, product-models, special-addons): a
 *   salesperson filling an SO must read these picklists, but must NOT need
 *   view access to the whole Products admin area. Same spirit as the
 *   SHARED READ HELPERS left on the coarse umbrella in scm/index.ts, except
 *   these routers also have admin writes, so the guard stays for writes.
 *
 * - `writeLevel` — override the level required for POST/PATCH/PUT/DELETE
 *   (default 'edit'). Used as `'view'` for scan-so / scan-payment / slips:
 *   their POSTs (warm, enqueue, extract, slip-upload init/confirm) only stage
 *   uploads and background OCR that produce the CALLER's own draft (the
 *   pipeline stamps the caller's staff uuid — PR #245); they never mutate an
 *   existing SO. Actual SO create/edit (mfg-sales-orders) keeps 'edit'.
 */
export interface ScmAreaGuardOpts {
  openRead?: boolean;
  writeLevel?: AccessLevel;
}

export function scmAreaGuard(area: string, opts?: ScmAreaGuardOpts): MiddlewareHandler<{
  Bindings: Env;
  Variables: Variables;
}> {
  return async (c, next) => {
    // c.get('user') is still the Houzs AuthUser at this point (supabaseAuth has
    // not run yet — see ordering note above).
    const user = c.get("user") as unknown as AuthUser | undefined;
    if (!user) return c.json({ error: "Unauthorized" }, 401);

    // 1) Owner / wildcard bypasses the L2 gate entirely.
    if (user.permissions_set?.has("*") || user.permissions?.includes("*")) {
      await next();
      return;
    }

    // 3) No explicit SCM L2 config → fall back to the coarse scm.access umbrella
    //    (already enforced upstream). Never lock out a current scm.access holder.
    if (!user.scm_l2_configured) {
      await next();
      return;
    }

    const write = isWrite(c.req.method);

    // Reference reads open to every caller who passed the coarse umbrella —
    // see ScmAreaGuardOpts above. Reads only; writes fall through to the check.
    if (!write && opts?.openRead) {
      await next();
      return;
    }

    // 2) Explicit SCM L2 config → enforce per-area, per-method.
    const requiredLevel: AccessLevel = write ? (opts?.writeLevel ?? "edit") : "view";
    const level: AccessLevel = (user.page_access?.[area] ?? "none") as AccessLevel;
    if (!meetsLevel(level, requiredLevel)) {
      return c.json(
        { error: `Forbidden: needs ${requiredLevel} access to ${area}` },
        403,
      );
    }
    await next();
  };
}
