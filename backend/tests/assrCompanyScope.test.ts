import { describe, expect, test } from "vitest";
import { assrCompanySql } from "../src/routes/assr";

/* ASSR (Service Cases) company scope is ROLE-AWARE, not blanket. The owner's
   2026-07-19 "Assr 是兩個公司的" (belongs to both companies) is satisfied for the
   people it was meant for — directors / service management read BOTH companies —
   while rank-and-file Sales stay pinned to HOUZS (the #601 owner exception,
   2026-07-16, and the leak #851 guards). This test pins that split in BOTH
   directions so a future "widen ASSR" change cannot silently un-pin rank-and-file
   Sales and reopen the cross-company leak.

   assrCompanySql composes assrPinsToHouzs (isSalesUser && !isDirectorUser) with
   houzsCompanySql / allowedCompaniesSql, so asserting its SQL output per role IS
   the rule. */

const COMPANIES = [{ id: 1, code: "HOUZS" }, { id: 2, code: "2990" }];

/** Minimal Hono-context stand-in: assrCompanySql only reads `.get(user)`,
 *  `.get(companies)` and `.get(allowedCompanyIds)`. */
function ctx(user: unknown, allowed: number[] = [1, 2]) {
  const store: Record<string, unknown> = { user, companies: COMPANIES, allowedCompanyIds: allowed };
  return { get: (k: string) => store[k] } as never;
}

const SALES_EXEC = { position_name: "Sales Executive", permissions_set: new Set<string>() };
const SALES_PERSON = { position_name: "Sales Person", permissions_set: new Set<string>() };
const SALES_DIRECTOR = { position_name: "Sales Director", permissions_set: new Set<string>() };
const FINANCE = { position_name: "Finance Manager", permissions_set: new Set<string>() };
const OWNER = { position_name: null, permissions_set: new Set<string>(["*"]) };
const OPERATION = { position_name: "Operation Manager", permissions_set: new Set<string>() };

describe("ASSR company scope is role-aware — directors see both companies, rank-and-file Sales stay HOUZS", () => {
  test("rank-and-file Sales -> HOUZS only, never the 2990 company", () => {
    expect(assrCompanySql(ctx(SALES_EXEC))).toBe(" AND company_id = 1");
    expect(assrCompanySql(ctx(SALES_PERSON))).toBe(" AND company_id = 1");
    // The HOUZS pin is `= <houzs>`, never the both-company `IN (...)` list.
    expect(assrCompanySql(ctx(SALES_EXEC))).not.toContain("IN");
  });

  test("Sales Director -> BOTH companies (the ruling's cross-company reach)", () => {
    expect(assrCompanySql(ctx(SALES_DIRECTOR))).toBe(" AND company_id IN (1,2)");
  });

  test("Finance Manager and owner (*) -> BOTH companies", () => {
    expect(assrCompanySql(ctx(FINANCE))).toBe(" AND company_id IN (1,2)");
    expect(assrCompanySql(ctx(OWNER))).toBe(" AND company_id IN (1,2)");
  });

  test("non-sales office (Operation) runs the cross-company portal -> BOTH", () => {
    expect(assrCompanySql(ctx(OPERATION))).toBe(" AND company_id IN (1,2)");
  });

  test("the column argument is honoured for joined queries", () => {
    expect(assrCompanySql(ctx(SALES_EXEC), "c.company_id")).toBe(" AND c.company_id = 1");
    expect(assrCompanySql(ctx(SALES_DIRECTOR), "c.company_id")).toBe(" AND c.company_id IN (1,2)");
  });

  test("a director restricted to one company sees only that one (scope still bounded by grants)", () => {
    // Directors read their ALLOWED set — which is both here, but if a director
    // were granted only 2990, the widening does not become "all companies".
    expect(assrCompanySql(ctx(SALES_DIRECTOR, [2]))).toBe(" AND company_id IN (2)");
  });
});
