// Unit tests for the Houzs -> 2990 transport (direct write, owner 2026-07-17).
//
// The merge core is tested in maintenance-push.test.ts without a network. These
// tests cover what the TRANSPORT decides, because going direct means we now own
// two things 2990's API used to own for us, and both are silent when wrong:
//
//   1. THE RESOLVER. We must resolve the row 2990's own /resolved would
//      (apps/api/src/routes/maintenance-config.ts:82-104). If the filter or the
//      tie-break drifts, the merge preserves the prices of a row the POS is not
//      serving — and every safety mechanism in this feature is then asserting
//      against the wrong blob while reporting success.
//   2. THE INSERT PAYLOAD. There is no longer an endpoint to reject a bad one.
//
// Method: stub `fetch` and assert on what reaches the wire. `vi.mock` is NOT
// used — @cloudflare/vitest-pool-workers does not support module mocking, and a
// mocked supabase-js would only prove we called the methods we called. Stubbing
// fetch runs the REAL PostgREST query construction, so these assertions are
// against the actual request, not a restatement of the code.
import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { readBridgeConfig, fetch2990Resolved, push2990Change, Bridge2990Error } from './bridge-2990';

const CFG = { supabaseUrl: 'https://dolvxrchzbnqvahocwsu.supabase.co', serviceRoleKey: 'sb_secret_test' };

interface WireCall {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

let wire: WireCall[] = [];
let queued: Array<{ status: number; body: unknown }> = [];
const realFetch = globalThis.fetch;

/** Queue one PostgREST response, in call order. */
const reply = (body: unknown, status = 200) => queued.push({ status, body });

beforeEach(() => {
  wire = [];
  queued = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    wire.push({
      url: decodeURIComponent(url),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      headers,
    });
    const next = queued.shift();
    if (!next) throw new Error(`fake fetch: no queued response for ${init?.method ?? 'GET'} ${url}`);
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
});

describe('readBridgeConfig', () => {
  test('both secrets absent -> both reported missing, nothing half-works', () => {
    const r = readBridgeConfig({} as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missing).toEqual(['BRIDGE_2990_SUPABASE_URL', 'BRIDGE_2990_SERVICE_ROLE_KEY']);
  });

  test('a blank secret counts as missing, not as a value', () => {
    const r = readBridgeConfig({
      BRIDGE_2990_SUPABASE_URL: 'https://x.supabase.co',
      BRIDGE_2990_SERVICE_ROLE_KEY: '   ',
    } as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missing).toEqual(['BRIDGE_2990_SERVICE_ROLE_KEY']);
  });

  test('reads both and strips a trailing slash from the url', () => {
    const r = readBridgeConfig({
      BRIDGE_2990_SUPABASE_URL: 'https://dolvxrchzbnqvahocwsu.supabase.co/',
      BRIDGE_2990_SERVICE_ROLE_KEY: 'sb_secret_abc',
    } as never);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config).toEqual({
        supabaseUrl: 'https://dolvxrchzbnqvahocwsu.supabase.co',
        serviceRoleKey: 'sb_secret_abc',
      });
    }
  });
});

describe('fetch2990Resolved — reproduces 2990s own resolver on the wire', () => {
  test('same table, same filter, same effective_from DESC / created_at DESC tie-break', async () => {
    reply([{ config: { gaps: ['4"'] }, effective_from: '2026-06-28' }]);
    reply([]);

    const r = await fetch2990Resolved(CFG, 'master');

    expect(r.data).toEqual({ gaps: ['4"'] });
    expect(r.effectiveFrom).toBe('2026-06-28');

    // maintenance-config.ts:82-89. If this drifts, we merge into a row 2990 is
    // not serving.
    const q = wire[0].url;
    expect(q).toContain('/rest/v1/maintenance_config_history');
    expect(q).toContain('scope=eq.master');
    expect(q).toContain('order=effective_from.desc,created_at.desc');
    expect(q).toContain('limit=1');
    expect(wire[0].method).toBe('GET');
  });

  test('asOf is 2990s UTC today, NOT Malaysia today', async () => {
    // 20:00 UTC on the 17th is 04:00 MYT on the 18th. 2990 resolves with the UTC
    // date (todayIso, maintenance-config.ts:41), so we must too — resolving with
    // MYT would pick up a row 2990s own POS will not serve for 8 more hours.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-17T20:00:00Z'));
    reply([{ config: { gaps: [] }, effective_from: '2026-07-01' }]);
    reply([]);

    await fetch2990Resolved(CFG, 'master');

    expect(wire[0].url).toContain('effective_from=lte.2026-07-17');
    expect(wire[0].url).not.toContain('2026-07-18');
  });

  test('the pending lookahead asks for the NEXT future row, ascending', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-17T02:00:00Z'));
    reply([{ config: {}, effective_from: '2026-07-01' }]);
    reply([{ effective_from: '2026-08-01' }]);

    const r = await fetch2990Resolved(CFG, 'master');

    // maintenance-config.ts:98-104.
    expect(wire[1].url).toContain('effective_from=gt.2026-07-17');
    expect(wire[1].url).toContain('order=effective_from.asc');
    expect(wire[1].url).toContain('limit=1');
    expect(r.hasPendingPriceChange).toBe(true);
    expect(r.pendingEffectiveFrom).toBe('2026-08-01');
  });

  test('pins the request to the public schema and authenticates with the service key', async () => {
    reply([{ config: {}, effective_from: '2026-07-01' }]);
    reply([]);
    await fetch2990Resolved(CFG, 'master');
    expect(wire[0].headers['accept-profile']).toBe('public');
    expect(wire[0].headers['apikey']).toBe('sb_secret_test');
  });

  test('no row -> data null, reported rather than invented as an empty config', async () => {
    reply([]);
    const r = await fetch2990Resolved(CFG, 'master');
    expect(r).toEqual({ data: null, effectiveFrom: null, hasPendingPriceChange: false, pendingEffectiveFrom: null });
    // The pending lookahead is not even reached — there is nothing to merge into.
    expect(wire).toHaveLength(1);
  });

  test('a config that is not an object is REFUSED, never coerced', async () => {
    reply([{ config: ['not', 'a', 'blob'], effective_from: '2026-07-01' }]);
    await expect(fetch2990Resolved(CFG, 'master')).rejects.toMatchObject({ code: 'bridge_bad_config_shape' });
  });

  test('a read error surfaces as a transport failure', async () => {
    reply({ message: 'permission denied', code: '42501' }, 403);
    await expect(fetch2990Resolved(CFG, 'master')).rejects.toBeInstanceOf(Bridge2990Error);
  });

  test('a FAILED pending lookahead throws — it never reports "no pending change"', async () => {
    // 2990s own handler drops this error and reports false. Saying "no pending
    // change" because the query broke would state a fact we do not have.
    reply([{ config: {}, effective_from: '2026-07-01' }]);
    reply({ message: 'timeout', code: '57014' }, 500);
    await expect(fetch2990Resolved(CFG, 'master')).rejects.toMatchObject({ code: 'bridge_read_failed' });
  });
});

describe('push2990Change — the insert 2990s endpoint would have done', () => {
  test('writes exactly the columns POST /changes writes, with a 2990-shaped id', async () => {
    reply({ id: 'mch-abc123def456', effective_from: '2026-07-18' }, 201);

    const r = await push2990Change(CFG, {
      scope: 'master',
      config: { gaps: ['4"', '5"'] },
      effectiveFrom: '2026-07-18',
      notes: 'Option lists from Houzs (Wei Siang)',
    });

    expect(wire[0].method).toBe('POST');
    expect(wire[0].url).toContain('/rest/v1/maintenance_config_history');
    expect(wire[0].headers['content-profile']).toBe('public');

    const row = wire[0].body as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual(['config', 'created_by', 'effective_from', 'id', 'notes', 'scope']);
    // maintenance-config.ts:61-64 genId(): the column is TEXT PK with no
    // default, so a drifting format would look wrong in 2990s own history UI.
    expect(row.id).toMatch(/^mch-[0-9a-f]{12}$/);
    expect(row.scope).toBe('master');
    expect(row.config).toEqual({ gaps: ['4"', '5"'] });
    expect(row.effective_from).toBe('2026-07-18');
    expect(row.notes).toBe('Option lists from Houzs (Wei Siang)');
    // Houzs is not a 2990 staff member; the column does not pretend otherwise.
    expect(row.created_by).toBeNull();

    expect(r).toEqual({ id: 'mch-abc123def456', effectiveFrom: '2026-07-18' });
  });

  test('a fresh id per push — two rows can never collide on the PK', async () => {
    reply({ id: 'a', effective_from: '2026-07-18' }, 201);
    reply({ id: 'b', effective_from: '2026-07-18' }, 201);
    const input = { scope: 'master', config: {}, effectiveFrom: '2026-07-18' };
    await push2990Change(CFG, input);
    await push2990Change(CFG, input);
    const [a, b] = wire.map((w) => (w.body as Record<string, unknown>).id);
    expect(a).not.toBe(b);
  });

  test('absent notes become NULL, mirroring 2990s own body.notes ?? null', async () => {
    reply({ id: 'x', effective_from: '2026-07-18' }, 201);
    await push2990Change(CFG, { scope: 'master', config: {}, effectiveFrom: '2026-07-18' });
    expect((wire[0].body as Record<string, unknown>).notes).toBeNull();
  });

  test('refuses a null config — the check 2990 used to do for us', async () => {
    await expect(
      push2990Change(CFG, { scope: 'master', config: null, effectiveFrom: '2026-07-18' }),
    ).rejects.toMatchObject({ code: 'bridge_config_required' });
    // Nothing reached the wire.
    expect(wire).toEqual([]);
  });

  test('an insert error surfaces as a refusal, not a silent success', async () => {
    reply({ code: '23502', message: 'null value in column' }, 400);
    await expect(
      push2990Change(CFG, { scope: 'master', config: {}, effectiveFrom: '2026-07-18' }),
    ).rejects.toMatchObject({ code: 'bridge_write_failed' });
  });
});
