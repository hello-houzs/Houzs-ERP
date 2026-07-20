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
import { companyDocPrefix } from './companyScope';

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
