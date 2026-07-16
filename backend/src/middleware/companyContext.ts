import { createMiddleware } from "hono/factory";
import type { Env } from "../types";

/**
 * Company-context middleware — Phase 0b of the multi-company merge.
 * Design: docs/2026-07-多公司合并设计.md (locked).
 *
 * Resolves the ACTIVE company for the request and the set of companies the
 * caller is allowed to act in, and stashes them on the Hono context:
 *   c.get('companyId')          — active company (companies.id)
 *   c.get('companyCode')        — active company code ('HOUZS' | '2990')
 *   c.get('allowedCompanyIds')  — companies the caller may see/act in
 *   c.get('companies')          — all active companies (id/code/name)
 *
 * Resolution order for the ACTIVE company:
 *   (a) explicit switcher pick — `X-Company-Id` header (the top-bar company
 *       switcher sends it on every API call), or `?companyId=` query as a
 *       link fallback. Validated against `allowedCompanyIds`; an invalid or
 *       not-allowed pick is IGNORED (falls through to the default), never 403'd.
 *   (b) login hostname default — erp.2990shome.com -> '2990';
 *       erp.houzscentury.com / staging / localhost / anything else -> 'HOUZS'.
 *       ALSO validated against `allowedCompanyIds`: the host's company is used
 *       only when the caller is granted it, else their FIRST allowed company —
 *       never a company they don't hold. A header-less request from a restricted
 *       user must not resolve the host's company just because it asked quietly.
 * The code is then resolved to companies.id.
 *
 * INVARIANT: the active company is ALWAYS one of `allowedCompanyIds` whenever
 * both are set — via (a) or (b), header or no header. Every route that reads
 * `companyId` / `scopeToCompany` / `activeCompanyId` leans on this; the DB
 * client is service-role, so nothing downstream re-checks it.
 *
 * The pick may be a company id (preferred) OR a company code — both are matched
 * so the frontend can send whichever it holds.
 *
 * DEGRADES SAFELY: when the companies master isn't resolvable (migration 0061
 * not applied yet, or a DB cold-start), companyId is left undefined. The
 * query-scoping helpers (scm/lib/companyScope.ts) then NO-OP, so single-company
 * Houzs keeps serving unchanged.
 *
 * MOUNTING: mounted once on the whole authenticated /api/* surface (after auth +
 * idempotency, before every route — see index.ts). This covers both the SCM
 * sub-app and the native raw-SQL modules (sales / finance). Routes without any
 * company table simply never read c.get('companyId'). Pre-auth public routes
 * (/api/auth, /api/track, /api/portal, /api/supplier-portal, /api/survey,
 * /api/mail-center/inbound) are registered before this middleware and are
 * untouched. ASSR raw-SQL scoping is a separate follow-up.
 */

export interface CompanyRow {
  id: number;
  code: string;
  name: string;
}

declare module "hono" {
  interface ContextVariableMap {
    /** Active company for this request (companies.id). Undefined when the
     *  companies master isn't resolvable yet (pre-migration / cold-start). */
    companyId?: number;
    /** Active company code ('HOUZS' | '2990'). */
    companyCode?: string;
    /** Companies this caller may see/act in. Phase 0e: the user's granted set
     *  from `user_companies` when they have >=1 grant, else ALL active
     *  companies (fail-open). Pre-activation this is left unset. */
    allowedCompanyIds?: number[];
    /** All active companies — lets cross-company views map company_id -> code
     *  without a second round-trip. */
    companies?: CompanyRow[];
  }
}

// Login-hostname -> default company code. erp.2990shome.com starts in 2990;
// everything else (erp.houzscentury.com, staging, localhost) defaults to HOUZS.
// Exported for the PRE-AUTH routes (mounted before this middleware — e.g. the
// forgot-password email in routes/auth.ts) that need the same hostname default
// to brand their outbound mail without a company context.
export function defaultCompanyCodeForHost(host: string): string {
  const h = host.toLowerCase();
  if (h.includes("2990")) return "2990";
  return "HOUZS";
}

// Module-level cache — companies is a static 2-row master, so a DB read per
// request would be pure waste. Cached for the isolate lifetime with a short TTL
// so a rare edit still propagates.
let cache: { at: number; rows: CompanyRow[] } | null = null;
const TTL_MS = 5 * 60 * 1000;
// Shorter re-check when the companies master is absent/unreadable (migration
// 0077 not applied yet, or a DB cold-start). WITHOUT a negative cache, every
// /api/* request pre-migration would re-run a guaranteed-failing SELECT — real
// latency + Postgres error-log noise + a Hyperdrive connection per request on a
// pool-sensitive app. Negative-caching an empty result bounds that to ~one
// failed query per isolate per 30s, and the short TTL means multi-company
// self-activates within 30s of 0077 being applied — no code redeploy needed.
const EMPTY_TTL_MS = 30 * 1000;

async function loadCompanies(env: Env): Promise<CompanyRow[]> {
  if (cache) {
    const ttl = cache.rows.length > 0 ? TTL_MS : EMPTY_TTL_MS;
    if (Date.now() - cache.at < ttl) return cache.rows;
  }
  // public.companies (default search_path) via the Postgres-backed env.DB shim.
  try {
    const res = await env.DB.prepare(
      "SELECT id, code, name FROM companies WHERE is_active = 1 ORDER BY id",
    ).all<{ id: number | string; code: string; name: string }>();
    const rows: CompanyRow[] = (res.results ?? []).map((r) => ({
      id: Number(r.id),
      code: String(r.code),
      name: String(r.name),
    }));
    cache = { at: Date.now(), rows };
    return rows;
  } catch {
    // Table absent (pre-migration) or a transient DB error — negative-cache an
    // empty result (short TTL) so we don't hammer a failing query per request.
    // Callers degrade to single-company (companyId undefined → helpers no-op).
    cache = { at: Date.now(), rows: [] };
    return [];
  }
}

export const companyContext = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  let companies: CompanyRow[] = [];
  try {
    companies = await loadCompanies(c.env);
  } catch {
    // companies master not present yet (migration 0061 not applied) or a DB
    // cold-start — degrade to single-company: leave companyId undefined so the
    // scoping helpers no-op and Houzs keeps serving.
  }

  if (companies.length > 0) {
    // Phase 0e — per-company user access. The default is ALL active companies
    // (the Phase-0b behaviour). Only when multi-company is ACTUALLY active
    // (>1 company) do we consult the per-user grant table `user_companies`.
    // Pre-activation the companies master has 0 or 1 rows, so this per-user
    // query NEVER runs — zero cost, zero risk on single-company Houzs.
    //
    // NEVER module-cache this result: it is user-specific. It runs at most once
    // per request, and only while multi-company is live.
    let allowed = companies.map((co) => co.id);

    if (companies.length > 1) {
      try {
        const uid = Number(
          (c.get("user") as { id?: number | string } | undefined)?.id,
        );
        if (Number.isFinite(uid) && uid > 0) {
          const res = await c.env.DB.prepare(
            "SELECT company_id FROM user_companies WHERE user_id = ?",
          )
            .bind(uid)
            .all<{ company_id: number | string }>();
          const granted = (res.results ?? [])
            .map((r) => Number(r.company_id))
            .filter((n) => Number.isFinite(n));
          // FAIL OPEN: restrict ONLY when the user actually HAS >=1 grant row.
          // No rows (or the table is absent — caught below) falls back to ALL
          // active companies, so a user is never locked out by the mere
          // presence of the feature.
          if (granted.length > 0) {
            const grantSet = new Set(granted);
            allowed = companies
              .filter((co) => grantSet.has(co.id))
              .map((co) => co.id);
          }
        }
      } catch {
        // user_companies absent (pre-0f) or a transient DB error — keep the
        // ALL-companies default. Never lock anyone out.
      }
    }

    // (a) explicit switcher pick — header wins, query is the link fallback.
    const rawPick = (c.req.header("X-Company-Id") ?? c.req.query("companyId") ?? "").trim();
    let active: CompanyRow | undefined;
    if (rawPick) {
      const pickId = Number(rawPick);
      active = companies.find(
        (co) =>
          allowed.includes(co.id) &&
          (co.id === pickId || co.code.toLowerCase() === rawPick.toLowerCase()),
      );
    }
    // (b) hostname default — CONSTRAINED TO `allowed`, exactly like the pick in
    // (a). Resolving the host's code against the FULL companies list would hand a
    // user who is granted ONLY company B the company-A context on any request
    // that omits X-Company-Id (allowedCompanyIds stayed correct, so the
    // scopeToAllowedCompanies routes hid this; the scopeToCompany /
    // activeCompanyId routes read the wrong company's books). The desktop
    // frontend always sends the header, but a client that doesn't — the POS —
    // would land straight on it. The DB client is service-role (RLS bypassed),
    // so this app-layer resolution IS the isolation boundary.
    if (!active) {
      const code = defaultCompanyCodeForHost(c.req.header("host") ?? "");
      // FAIL OPEN, unchanged: `allowed` is ALREADY the full company list for a
      // user with no user_companies grants (or when that table is absent), so
      // `pool` is `companies` and this resolves byte-identically to before for
      // every user today. It only narrows once a user is actually restricted.
      const pool = companies.filter((co) => allowed.includes(co.id));
      // `?? pool[0]` last resort: fires when the hostname's company is not in
      // the caller's allowed set — e.g. a 2990-only user hitting the Houzs host
      // via a bookmark or an emailed link. Their FIRST allowed company (lowest
      // id — `companies` is ORDER BY id, so this is deterministic) is the right
      // answer: it is their own data, and it beats both a lockout (this
      // middleware never 403s a company decision — an unroutable pick has always
      // fallen through, never rejected) and a wrong-company read. It also still
      // fires on a companies master with no HOUZS row, as before.
      //
      // `pool` is EMPTY only when the caller holds grants that all point at
      // companies that are no longer is_active=1. `active` then stays undefined
      // — deliberately. It must NOT fall back to the full list: the caller is
      // granted none of those, so serving the hostname default would be the very
      // cross-company read this block exists to prevent. Undefined here is safe
      // ONLY because the scoping helpers distinguish "unresolved" (degrade, no
      // predicate) from "restricted to nothing" (match nothing) via
      // allowedCompanyIds — which is `[]`, not undefined, in exactly this case.
      // See the sentinel doc in scm/lib/companyScope.ts; the two are a pair.
      active = pool.find((co) => co.code === code) ?? pool[0];
    }

    c.set("companies", companies);
    c.set("allowedCompanyIds", allowed);
    if (active) {
      c.set("companyId", active.id);
      c.set("companyCode", active.code);
    }
  }

  await next();
});
