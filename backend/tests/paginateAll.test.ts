// paginateAll / chunkIn — the helper that exists because PostgREST silently
// caps a response at 1000 rows.
//
// Context (2026-07): three list endpoints were reading straight through that
// cap — product_models, fabric_trackings, and the SO-amendment list. None of
// them errored; they just returned a short array that the frontend then
// counted, filtered and EXPORTED as if it were the whole set. The fix routes
// them through paginateAll, so these tests pin the contract that fix depends
// on, including the one case the helper previously got wrong: it stopped at its
// own MAX_PAGES ceiling with no way for the caller to tell.

import { describe, it, expect } from 'vitest';
import { paginateAll, chunkIn } from '../src/scm/lib/paginate-all';

/* A fake PostgREST table: returns exactly the requested .range() window, and
   records the windows it was asked for. */
function fakeTable(total: number) {
  const calls: Array<[number, number]> = [];
  const rows = Array.from({ length: total }, (_, i) => ({ id: i }));
  return {
    calls,
    query: (from: number, to: number) => {
      calls.push([from, to]);
      return Promise.resolve({ data: rows.slice(from, to + 1), error: null });
    },
  };
}

describe('paginateAll', () => {
  it('returns a sub-page set in one request', async () => {
    const t = fakeTable(120);
    const { data, error, truncated } = await paginateAll(t.query);
    expect(error).toBeNull();
    expect(data).toHaveLength(120);
    expect(truncated).toBe(false);
    expect(t.calls).toEqual([[0, 999]]);
  });

  it('reads past the 1000-row cap — the whole point of the helper', async () => {
    /* 1141 is the live SKU-master row count that exposed the cap originally. */
    const t = fakeTable(1141);
    const { data, truncated } = await paginateAll(t.query);
    expect(data).toHaveLength(1141);
    expect(truncated).toBe(false);
    expect(t.calls).toEqual([[0, 999], [1000, 1999]]);
  });

  it('stops on an exact multiple of the page size without an extra short read', async () => {
    const t = fakeTable(2000);
    const { data, truncated } = await paginateAll(t.query);
    expect(data).toHaveLength(2000);
    // 2000 rows = two full pages, so a third request is needed to learn it ended.
    expect(t.calls).toHaveLength(3);
    expect(truncated).toBe(false);
  });

  it('reports truncation when the MAX_PAGES ceiling is hit', async () => {
    /* The ceiling is 50 pages. A table larger than 50,000 rows returns a
       partial set — previously indistinguishable from a complete one, which is
       the same silent-truncation defect one level up. */
    const t = fakeTable(50_001);
    const { data, truncated } = await paginateAll(t.query);
    expect(data).toHaveLength(50_000);
    expect(truncated).toBe(true);
  });

  it('surfaces an error instead of returning a partial set as if it were whole', async () => {
    let call = 0;
    const { data, error, truncated } = await paginateAll((from, to) => {
      call++;
      if (call === 2) {
        return Promise.resolve({ data: null, error: { message: 'connection reset' } });
      }
      return Promise.resolve({
        data: Array.from({ length: 1000 }, (_, i) => ({ id: from + i, to })),
        error: null,
      });
    });
    // A half-read list must NOT come back as data — that is exactly how a
    // failed load becomes a confidently wrong count downstream.
    expect(data).toBeNull();
    expect(error?.message).toBe('connection reset');
    expect(truncated).toBe(false);
  });
});

describe('chunkIn', () => {
  it('splits the IN list and merges every chunk', async () => {
    const codes = Array.from({ length: 450 }, (_, i) => `C${i}`);
    const batches: number[] = [];
    const { data, error } = await chunkIn(codes, (batch, from, to) => {
      if (from === 0) batches.push(batch.length);
      return Promise.resolve({
        data: from === 0 ? batch.map((c) => ({ code: c, to })) : [],
        error: null,
      });
    });
    expect(error).toBeNull();
    // 450 codes at the default chunk size of 200 → 200 / 200 / 50.
    expect(batches).toEqual([200, 200, 50]);
    expect(data).toHaveLength(450);
  });

  it('propagates an error and does not pretend the merge is complete', async () => {
    const codes = Array.from({ length: 300 }, (_, i) => `C${i}`);
    const { error } = await chunkIn(codes, (_batch, from) =>
      Promise.resolve(
        from === 0
          ? { data: null, error: { message: 'boom' } }
          : { data: [], error: null },
      ),
    );
    expect(error?.message).toBe('boom');
  });
});
