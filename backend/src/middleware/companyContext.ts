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
 * The code is then resolved to companies.id.
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
    /** Companies this caller may see/act in. Phase 0b: ALL active companies. */
    allowedCompanyIds?: number[];
    /** All active companies — lets cross-company views map company_id -> code
     *  without a second round-trip. */
    companies?: CompanyRow[];
  }
}

// Login-hostname -> default company code. erp.2990shome.com starts in 2990;
// everything else (erp.houzscentury.com, staging, localhost) defaults to HOUZS.
function defaultCompanyCodeForHost(host: string): string {
  const h = host.toLowerCase();
  if (h.includes("2990")) return "2990";
  return "HOUZS";
}

// Module-level cache — companies is a static 2-row master, so a DB read per
// request would be pure waste. Cached for the isolate lifetime with a short TTL
// so a rare edit still propagates.
let cache: { at: number; rows: CompanyRow[] } | null = null;
const TTL_MS = 5 * 60 * 1000;

async function loadCompanies(env: Env): Promise<CompanyRow[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.rows;
  // public.companies (default search_path) via the Postgres-backed env.DB shim.
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
    // TODO(Phase 0e — per-company permission dimension): allowed-companies is
    // currently EVERY active company. Replace this single line with a real
    // per-user grant lookup (e.g. a user_companies table) once the Houzs
    // permission matrix gains its per-(company × area) dimension. This is the
    // ONE intentional gating shortcut in Phase 0b.
    const allowed = companies.map((co) => co.id);

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
    // (b) hostname default.
    if (!active) {
      const code = defaultCompanyCodeForHost(c.req.header("host") ?? "");
      active = companies.find((co) => co.code === code) ?? companies[0];
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
