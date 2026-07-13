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
 *  • CROSS-COMPANY VIEW modules (TMS: trips / delivery-planning / fleet, and
 *    Service Cases / ASSR): ONE shared queue across both companies, each row
 *    tagged with its company. They call `scopeToAllowedCompanies(query, c)` to
 *    add `.in('company_id', <allowed>)` (WIDEN, don't isolate) and enrich rows
 *    with a company label via `companyCodeMap(c)` / `withCompanyCode(...)` so
 *    the UI can render a company column. On INSERT they still stamp the ACTIVE
 *    company (a trip is created from whichever company you're currently in; it
 *    can still reference the other company's DOs).
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

export function allowedCompanyIds(c: Context<any>): number[] {
  return (c.get("allowedCompanyIds") as number[] | undefined) ?? [];
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
  const ids = allowedCompanyIds(c)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) return "";
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
  if (id == null) return query;
  return (query as unknown as { eq(col: string, val: unknown): Q }).eq("company_id", id);
}

/**
 * CROSS-COMPANY: widen a supabase-js query to every company the caller may see.
 * No-op when the allow-list is empty (unresolved). Returns the builder for
 * further chaining.
 */
export function scopeToAllowedCompanies<Q>(query: Q, c: Context<any>): Q {
  const ids = allowedCompanyIds(c);
  if (ids.length === 0) return query;
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
