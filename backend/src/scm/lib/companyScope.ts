import type { Context } from "hono";
import type { CompanyRow } from "../../middleware/companyContext";

/**
 * Query-scoping helpers for the multi-company merge (Phase 0b).
 * Design: docs/2026-07-多公司合并设计.md. Depends on the company_id column
 * added to 118 tables by migration 0061 + the companyContext middleware.
 *
 * Two patterns, one company_id column:
 *
 *  • PER-COMPANY modules (SO / PO / GRN / PI / DO / SI / inventory / accounting
 *    / catalog / suppliers): the top-bar switcher ISOLATES the two companies'
 *    books. Their list + detail queries call `scopeToCompany(query, c)` to add
 *    `.eq('company_id', <active>)`, and stamp `company_id = <active>` on INSERT
 *    via `activeCompanyId(c)`.
 *
 *  • CROSS-COMPANY VIEW modules (TMS: trips / delivery-planning / fleet): ONE
 *    shared queue across both companies, each row tagged with its company. They
 *    call `scopeToAllowedCompanies(query, c)` to add `.in('company_id',
 *    <allowed>)` (WIDEN, don't isolate) and enrich rows with a company label via
 *    `companyCodeMap(c)` / `withCompanyCode(...)` so the UI can render a company
 *    column. On INSERT they still stamp the ACTIVE company (a trip is created
 *    from whichever company you're currently in; it can still reference the
 *    other company's DOs).
 *
 *  • HOUZS-ONLY module (Service Cases / ASSR): a Houzs-exclusive concept (2990
 *    has 0% service overlap). Its raw-SQL reads pin to HOUZS via
 *    `houzsCompanySql(c)` / `houzsCompanyIds(c)` — NOT the caller's allowed set —
 *    so a both-company user never sees 2990 orders/customers/cases under Service
 *    Cases. See routes/assr.ts.
 *
 * All helpers NO-OP when the active/allowed company is unresolved (companies
 * master absent pre-migration, or a DB cold-start) — so single-company Houzs
 * keeps working unchanged.
 *
 * supabase-js ONLY. Raw `env.DB` SQL paths (e.g. the native ASSR list) can't use
 * these — they must add the company predicate / column by hand. See the raw-SQL
 * checklist in the Phase 0b commit message.
 */

export function activeCompanyId(c: Context<any>): number | undefined {
  return c.get("companyId") as number | undefined;
}

/**
 * THE ALLOW-LIST SENTINEL — three states, never two. Read this before touching
 * any consumer; collapsing the first two together is a cross-company LEAK, and
 * collapsing the last two together is an app-wide EMPTY-LIST outage.
 *
 *  • `undefined` = UNRESOLVED. companyContext never set the var because the
 *    companies master isn't readable (pre-migration / D1 test mirror /
 *    Hyperdrive cold-start). Consumers MUST degrade: no company predicate at
 *    all, so single-company Houzs serves unchanged. Load-bearing — do NOT
 *    "simplify" this to [].
 *
 *  • `[]` = RESOLVED, and the caller is granted NO active company: they hold
 *    `user_companies` grants, but every one of them points at a company that is
 *    no longer `is_active = 1`. Consumers MUST filter to NOTHING (empty lists).
 *    Never fail open here — the DB client is service-role (RLS bypassed), so
 *    these predicates ARE the isolation boundary.
 *
 *  • non-empty = the caller's granted companies. Note this is ALSO the state for
 *    a user with NO grants at all: companyContext FAILS OPEN to every active
 *    company, so an unrestricted user is always non-empty and never touches the
 *    `[]` branch. "Has no grants" and "has grants, none usable" are different.
 *
 * Returns a validated copy (positive integers only), so consumers can inline the
 * ids into raw SQL without re-checking — they come from OUR companies master.
 */
export function allowedCompanyIds(c: Context<any>): number[] | undefined {
  const raw = c.get("allowedCompanyIds") as number[] | undefined;
  if (!Array.isArray(raw)) return undefined;
  return raw.map(Number).filter((n) => Number.isInteger(n) && n > 0);
}

/** True ONLY in the middle state above: the company context resolved, and the
 *  caller is granted no active company. Lets the PER-COMPANY helpers tell a
 *  missing active company that means "degrade" (unresolved) from one that means
 *  "this caller may see nothing". */
export function isRestrictedToNoCompany(c: Context<any>): boolean {
  const ids = allowedCompanyIds(c);
  return ids !== undefined && ids.length === 0;
}

/**
 * CROSS-COMPANY, raw env.DB SQL flavour of scopeToAllowedCompanies. Returns a
 * ready-to-interpolate ` AND <col> IN (1,2)` fragment limited to the caller's
 * allowed companies, or "" when the allow-list is unresolved (companies master
 * absent pre-migration / D1 test mirror / cold-start) so legacy single-company
 * SQL runs unchanged. The ids come from OUR companies master via the
 * middleware and are re-validated as positive integers here, so inlining them
 * (no binds) is safe — which keeps the many stat queries that already
 * interpolate computed fragments readable.
 */
export function allowedCompaniesSql(c: Context<any>, col = "company_id"): string {
  const ids = allowedCompanyIds(c);
  // UNRESOLVED → no predicate (legacy single-company SQL runs unchanged).
  if (ids === undefined) return "";
  // RESTRICTED TO NOTHING → a predicate that matches nothing. `1=0` (not
  // `false`) so the fragment stays valid on the D1/SQLite test mirror too.
  if (ids.length === 0) return ` AND 1=0`;
  return ` AND ${col} IN (${ids.join(",")})`;
}

/**
 * PER-COMPANY, raw env.DB SQL flavour of scopeToCompany. Returns a
 * ready-to-interpolate ` AND <col> = <active>` fragment, or "" when the active
 * company is unresolved (pre-migration / D1 test mirror / cold-start) so
 * legacy single-company SQL runs unchanged. Same inline-not-bind rationale as
 * allowedCompaniesSql above: the id comes from OUR companies master and is
 * re-validated as a positive integer here.
 */
export function activeCompanySql(c: Context<any>, col = "company_id"): string {
  const id = Number(activeCompanyId(c));
  if (Number.isInteger(id) && id > 0) return ` AND ${col} = ${id}`;
  // No active company. Two very different reasons — see the sentinel doc on
  // allowedCompanyIds. Restricted-to-nothing must match nothing; unresolved
  // must degrade to no predicate.
  if (isRestrictedToNoCompany(c)) return ` AND 1=0`;
  return "";
}

/**
 * HOUZS-ONLY PIN (Service Cases / ASSR). ASSR is a Houzs-exclusive module —
 * 2990 has zero service-case overlap (owner: "Service pricing CANNOT merge,
 * 0% overlap"). So ASSR queries pin to the base company HOUZS rather than the
 * caller's full allowed set: a both-company user (the owner) must NOT see 2990
 * orders/customers/cases under Service Cases. HOUZS is identified by
 * `companies.code === 'HOUZS'` from the companies master already on context —
 * no hardcoded id.
 *
 * houzsCompanyId returns the resolved id, or undefined when the companies
 * master is unresolved (pre-migration / cold-start).
 */
export function houzsCompanyId(c: Context<any>): number | undefined {
  const rows = (c.get("companies") as CompanyRow[] | undefined) ?? [];
  const houzs = rows.find((r) => r.code === "HOUZS");
  return houzs?.id != null ? Number(houzs.id) : undefined;
}

/** houzsCompanyIds — the array flavour for callers that take an id list
 *  (e.g. the ASSR list/export `allowed_company_ids` param). `[houzsId]` when
 *  resolved, else `undefined` — NOT `[]` — so the callee degrades to
 *  single-company (no predicate), matching the pre-migration / cold-start
 *  behaviour. This feeds the SAME sinks as allowedCompanyIds, where `[]` now
 *  means "restricted to nothing / match nothing"; returning `[]` for unresolved
 *  here would blank ASSR for every sales user on a cold start. */
export function houzsCompanyIds(c: Context<any>): number[] | undefined {
  const id = houzsCompanyId(c);
  return id != null ? [id] : undefined;
}

/** Raw env.DB SQL fragment pinning a query to HOUZS: ` AND <col> = <houzsId>`,
 *  or "" when HOUZS is unresolved (pre-migration / cold-start) so legacy
 *  single-company SQL runs unchanged. Same inline-not-bind safety as
 *  allowedCompaniesSql — the id comes from OUR companies master, re-validated
 *  as a positive integer here. */
export function houzsCompanySql(c: Context<any>, col = "company_id"): string {
  const id = Number(houzsCompanyId(c));
  if (!Number.isInteger(id) || id <= 0) return "";
  return ` AND ${col} = ${id}`;
}

/** id -> code map for tagging cross-company rows with a readable company. */
export function companyCodeMap(c: Context<any>): Map<number, string> {
  const rows = (c.get("companies") as CompanyRow[] | undefined) ?? [];
  return new Map(rows.map((r) => [r.id, r.code]));
}

/**
 * PER-COMPANY: filter a supabase-js query to the active company. No-op when the
 * active company is unresolved. Returns the builder so the caller can keep
 * chaining (.order / .eq / .maybeSingle / ...).
 */
export function scopeToCompany<Q>(query: Q, c: Context<any>): Q {
  const id = activeCompanyId(c);
  if (id != null) {
    return (query as unknown as { eq(col: string, val: unknown): Q }).eq("company_id", id);
  }
  // No active company. RESTRICTED TO NOTHING → match nothing (an empty `in`
  // list). UNRESOLVED → no filter, exactly as before.
  if (isRestrictedToNoCompany(c)) {
    return (query as unknown as { in(col: string, vals: number[]): Q }).in("company_id", []);
  }
  return query;
}

/**
 * CROSS-COMPANY: widen a supabase-js query to every company the caller may see.
 * No-op when the allow-list is empty (unresolved). Returns the builder for
 * further chaining.
 */
export function scopeToAllowedCompanies<Q>(query: Q, c: Context<any>): Q {
  const ids = allowedCompanyIds(c);
  // UNRESOLVED → no filter. Otherwise `.in` the resolved set — which for the
  // RESTRICTED-TO-NOTHING state is an empty list, and an empty `in` matches no
  // rows. Same three-state contract as allowedCompaniesSql; if these two ever
  // disagree, that is the same bug class again.
  if (ids === undefined) return query;
  return (query as unknown as { in(col: string, vals: number[]): Q }).in("company_id", ids);
}

/**
 * Stamp the active company on rows about to be INSERTed. Every row gets
 * `company_id = <active>` unless it already carries one (explicit wins). No-op
 * when the active company is unresolved (pre-migration / cold-start) so
 * single-company Houzs keeps inserting unchanged. Use for child/line/payment
 * array inserts (`.insert(stampCompany(rows, c))`); for a single object literal
 * add `company_id: activeCompanyId(c)` inline instead.
 */
export function stampCompany<T extends Record<string, unknown>>(
  rows: T[],
  c: Context<any>,
): Array<T & { company_id?: number }> {
  const id = activeCompanyId(c);
  if (id == null) return rows;
  return rows.map((r) => ({ company_id: id, ...r }));
}

/** Tag one row (which carries company_id) with a readable `company_code`. */
export function withCompanyCode<T extends Record<string, unknown>>(
  row: T,
  codes: Map<number, string>,
): T & { company_code: string | null } {
  const cid = row["company_id"];
  const code = cid != null ? codes.get(Number(cid)) ?? null : null;
  return { ...row, company_code: code };
}

/**
 * PER-COMPANY DOC-NUMBER PREFIX (Phase 0d). The base company HOUZS keeps BARE
 * numbers (e.g. `SO-2607-001`) so its existing live doc numbers are unchanged;
 * every OTHER company prefixes with its code (e.g. `2990-SO-2607-001`). The
 * prefix alone keeps the two companies' monthly sequences from colliding on the
 * GLOBAL unique doc_no index — no per-company unique constraint (no migration)
 * needed, because a minter's `.like('SO-2607-%')` fetch never matches
 * `2990-SO-2607-...`, so each company reads/advances only its own max+1.
 *
 * Returns "" when the company is unresolved (pre-activation / single-company)
 * OR is the HOUZS base — so Houzs numbering is a strict no-op until a non-base
 * company is active. Use at every PER-COMPANY minter: fold it into the month
 * prefix passed to BOTH the `.like(...)` fetch AND `nextMonthlyDocNo(...)` so
 * they agree, e.g. `const p = companyDocPrefix(c); ... .like(col, ${p}SO-${yymm}-%)`
 * and `nextMonthlyDocNo(${p}SO-${yymm}, existing)`. Do NOT apply to CROSS-COMPANY
 * shared docs (trips / delivery-planning) — those keep one shared sequence.
 */
export function companyDocPrefix(c: Context<any>): string {
  const code = c.get("companyCode");
  // Only prefix with a real, non-base company code. A non-string (e.g. a whole
  // company object leaking in from a reconstructed context — as the scan
  // background job did, minting "[object Object]-SO-2607-001") falls back to
  // BARE numbering instead of stringifying to "[object Object]-".
  if (typeof code !== "string" || !code || code === "HOUZS") return "";
  return `${code}-`;
}
