// companyDocPrefix — the doc-number prefix guard.
//
// Production bug (twice): a RECONSTRUCTED context — the headless scan job's
// createDraftSalesOrder and, earlier, the PO-convert / agent paths — carries a
// company id but no company CODE. Its get() fell through to a default that
// returned an OBJECT for the unhandled 'companyCode' key, and companyDocPrefix
// interpolated it straight into the month prefix, minting
// "[object Object]-SO-2607-001" as a live doc number (which then surfaced in the
// "Sales order saved — ..." scan announcement). These pin that a non-string
// company code can NEVER reach the doc number: it degrades to BARE HOUZS
// numbering, exactly as a base-company / single-company install already does.
import { describe, expect, test } from 'vitest';
import { companyDocPrefix, detailMissResponse } from './companyScope';

/** Minimal CompanyScopeCtx — companyDocPrefix only ever calls get('companyCode'). */
const ctx = (companyCode: unknown) => ({ get: (k: string) => (k === 'companyCode' ? companyCode : undefined) });

describe('companyDocPrefix', () => {
  test('an OBJECT company code degrades to bare numbering, never "[object Object]-"', () => {
    // The exact reconstructed-context leak: get('companyCode') returns the
    // synthetic houzsUser object instead of a code string.
    const p = companyDocPrefix(ctx({ id: 42 }) as never);
    expect(p).toBe('');
    expect(p).not.toContain('[object Object]');
  });

  test('undefined (headless / single-company) is bare', () => {
    expect(companyDocPrefix(ctx(undefined) as never)).toBe('');
  });

  test('the HOUZS base company keeps bare numbers', () => {
    expect(companyDocPrefix(ctx('HOUZS') as never)).toBe('');
  });

  test('a real non-base code prefixes with "<code>-"', () => {
    expect(companyDocPrefix(ctx('2990') as never)).toBe('2990-');
  });
});

// detailMissResponse — turns a per-company by-id MISS into an honest answer:
// "in another company you may see" (offer the switch) vs a genuine not_found.
// The leak boundary is that a caller NOT allowed to see the other company must
// still get a plain not_found — never learn the row exists elsewhere.
describe('detailMissResponse', () => {
  const COMPANIES = [
    { id: 1, code: 'HOUZS', name: 'Houzs' },
    { id: 2, code: '2990', name: '2990' },
  ];
  /** Ctx exposing the three keys the helper + its dependencies read. */
  const ctxMc = (active: number | undefined, allowed: number[] | undefined) => ({
    get: (k: string) =>
      k === 'companyId' ? active
      : k === 'allowedCompanyIds' ? allowed
      : k === 'companies' ? COMPANIES
      : undefined,
  });
  /** A supabase-ish probe that HONOURS the widened `.in('company_id', vals)` the
   *  helper applies: the row is visible only when its company is in that list
   *  (or when no `.in` was applied — the unresolved allow-list case). `rowCompany
   *  = null` models a genuinely absent id. */
  const probe = (rowCompany: number | null) => {
    let applied: number[] | null = null;
    const b = {
      in(_col: string, vals: number[]) { applied = vals; return b; },
      async maybeSingle() {
        const visible = rowCompany != null && (applied === null || applied.includes(rowCompany));
        return { data: visible ? { company_id: rowCompany } : null };
      },
    };
    return b;
  };

  test('row in ANOTHER allowed company → in_other_company, names that company', async () => {
    const r = await detailMissResponse(ctxMc(1, [1, 2]) as never, probe(2), 'supplier');
    expect(r.error).toBe('in_other_company');
    if (r.error === 'in_other_company') {
      expect(r.companyId).toBe(2);
      expect(r.companyCode).toBe('2990');
      expect(r.message).toContain('2990');
      expect(r.message).toContain('supplier');
    }
  });

  test('LEAK BOUNDARY: a company-1-only caller gets plain not_found for a company-2 row', async () => {
    // allowed=[1] → the widened lookup filters to company 1, so the company-2 row
    // is invisible and the caller never learns it exists.
    const r = await detailMissResponse(ctxMc(1, [1]) as never, probe(2), 'supplier');
    expect(r.error).toBe('not_found');
  });

  test('genuinely absent id → not_found', async () => {
    const r = await detailMissResponse(ctxMc(1, [1, 2]) as never, probe(null), 'supplier');
    expect(r.error).toBe('not_found');
  });

  test('row resolves in the ACTIVE company → not_found (never falsely "other")', async () => {
    // Only reachable if a route calls this on a same-company miss; cid === active
    // must not be reported as another company.
    const r = await detailMissResponse(ctxMc(2, [1, 2]) as never, probe(2), 'supplier');
    expect(r.error).toBe('not_found');
  });
});
