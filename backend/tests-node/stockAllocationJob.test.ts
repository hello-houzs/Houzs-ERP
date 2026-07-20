import { beforeEach, describe, expect, test, vi } from 'vitest';

const { recompute } = vi.hoisted(() => ({ recompute: vi.fn() }));
vi.mock('../src/scm/lib/so-stock-allocation', () => ({
  recomputeSoStockAllocation: recompute,
}));

import {
  drainStockAllocationRecomputeWithClient,
  enqueueStockAllocationRecompute,
} from '../src/scm/lib/stock-allocation-job';

type Row = {
  job_key: string;
  request_token: string;
  requested_at: string;
  attempts: number;
  last_error: string | null;
  locked_by: string | null;
  locked_until: string | null;
  reason?: string;
};

function queueClient(initial?: Row) {
  let row = initial ? { ...initial } : null;
  class Query implements PromiseLike<{ data: unknown; error: null }> {
    private op: 'select' | 'update' | 'delete' | 'upsert' = 'select';
    private patch: Record<string, unknown> = {};
    private filters: Array<[string, unknown]> = [];
    select() { return this; }
    upsert(value: Record<string, unknown>) { this.op = 'upsert'; this.patch = value; return this; }
    update(value: Record<string, unknown>) { this.op = 'update'; this.patch = value; return this; }
    delete() { this.op = 'delete'; return this; }
    eq(column: string, value: unknown) { this.filters.push([column, value]); return this; }
    or() { return this; }
    maybeSingle() { return this.execute(); }
    private matches() { return row != null && this.filters.every(([key, value]) => (row as unknown as Record<string, unknown>)[key] === value); }
    private async execute() {
      if (this.op === 'upsert') {
        row = { ...(row ?? {}), ...this.patch } as Row;
        return { data: row, error: null };
      }
      if (this.op === 'update') {
        if (!this.matches()) return { data: null, error: null };
        row = { ...row!, ...this.patch };
        return { data: row, error: null };
      }
      if (this.op === 'delete') {
        if (!this.matches()) return { data: null, error: null };
        const deleted = row;
        row = null;
        return { data: deleted, error: null };
      }
      return { data: this.matches() ? row : null, error: null };
    }
    then<TResult1 = { data: unknown; error: null }, TResult2 = never>(
      onfulfilled?: ((value: { data: unknown; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) { return this.execute().then(onfulfilled, onrejected); }
  }
  return {
    client: { from: () => new Query() },
    get row() { return row; },
    replace(next: Row) { row = next; },
  };
}

const pending = (): Row => ({
  job_key: 'GLOBAL', request_token: '00000000-0000-4000-8000-000000000001',
  requested_at: '2026-07-21T00:00:00.000Z', attempts: 0,
  last_error: null, locked_by: null, locked_until: null,
});

describe('durable stock-allocation recompute queue', () => {
  beforeEach(() => recompute.mockReset());

  test('keeps and unlocks the job when recompute reports ok=false', async () => {
    const state = queueClient(pending());
    recompute.mockResolvedValue({ ok: false, reason: 'injected allocation failure' });
    const result = await drainStockAllocationRecomputeWithClient(state.client);
    expect(result).toMatchObject({ processed: true, completed: false, reason: 'injected allocation failure' });
    expect(state.row).toMatchObject({ attempts: 1, last_error: 'injected allocation failure', locked_by: null, locked_until: null });
  });

  test('the timestamp fence preserves work enqueued while recompute is running', async () => {
    const state = queueClient(pending());
    recompute.mockImplementation(async () => {
      state.replace({
        ...state.row!,
        request_token: '00000000-0000-4000-8000-000000000002',
        requested_at: '2026-07-21T00:01:00.000Z',
        reason: 'new mutation',
      });
      return { ok: true };
    });
    const result = await drainStockAllocationRecomputeWithClient(state.client);
    expect(result).toMatchObject({ processed: true, completed: false, deferred: true, reason: 'new_work_arrived' });
    expect(state.row).toMatchObject({
      request_token: '00000000-0000-4000-8000-000000000002',
      requested_at: '2026-07-21T00:01:00.000Z',
      locked_by: null,
      locked_until: null,
    });
  });

  test('successful recompute deletes only the claimed generation', async () => {
    const state = queueClient();
    await enqueueStockAllocationRecompute(state.client, 'tbc-swap:SO-1');
    recompute.mockResolvedValue({ ok: true });
    expect(await drainStockAllocationRecomputeWithClient(state.client)).toMatchObject({ processed: true, completed: true });
    expect(state.row).toBeNull();
  });
});
